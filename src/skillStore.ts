import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import matter from "gray-matter";
import { z } from "zod";
import { assertNoServerOwnedFrontmatter, SAFE_MATTER_OPTIONS } from "./frontmatter.js";
import { ensurePatchStateDir, PATCH_ID_PATTERN, SKILL_PLAN_PREFIX, vaultIdentityTag } from "./patchState.js";
import { relativeToRoot, resolveExistingRoot, resolveInsideRoot, toPosixPath } from "./pathSafety.js";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REFERENCE_FILENAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\.md$/;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_REFERENCES = 20;

export interface SkillStoreConfig {
  knowledgeRoot: string;
  skillsSubdir: string;
  patchStateDir: string;
}

export interface SkillReferenceInput {
  filename: string;
  content: string;
}

export interface PlanSkillCreateInput {
  skill_name: string;
  skill_md: string;
  references?: SkillReferenceInput[];
  openai_yaml?: string;
  reason: string;
}

interface SkillBundleFile {
  path: string;
  content: string;
}

export interface PlannedSkillCreate {
  kind: "skill_create";
  patch_id: string;
  skill_name: string;
  target_path: string;
  reason: string;
  created_at: string;
  files: SkillBundleFile[];
  diff: string;
}

const plannedSkillCreateSchema = z.object({
  kind: z.literal("skill_create"),
  patch_id: z.string().uuid(),
  skill_name: z.string(),
  target_path: z.string(),
  reason: z.string(),
  created_at: z.string(),
  // Optional in the SCHEMA so that a plan written before this field existed
  // fails with the explicit refusal below rather than a parse error that says
  // nothing about vaults. It is not optional in behaviour: absent is rejected.
  vault_id: z.string().optional(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  diff: z.string()
});

/**
 * Creates instruction-only Skill bundles inside one configured vault subdir.
 * It intentionally cannot write scripts, assets, arbitrary paths, or existing
 * Skills. Planning writes only local patch state; apply creates the whole
 * bundle under a temporary directory and atomically renames it into place.
 */
export class SkillStore {
  private readonly config: SkillStoreConfig;
  private rootRealPath?: string;
  private skillsRootRealPath?: string;

  constructor(config: SkillStoreConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    this.rootRealPath = await resolveExistingRoot(this.config.knowledgeRoot);
    const skillsCandidate = await resolveInsideRoot(this.rootRealPath, this.config.skillsSubdir);
    const skillsStat = await fs.stat(skillsCandidate);
    if (!skillsStat.isDirectory()) {
      throw new Error("MCP_SKILLS_SUBDIR is not a directory.");
    }
    this.skillsRootRealPath = await fs.realpath(skillsCandidate);
    relativeToRoot(this.rootRealPath, this.skillsRootRealPath);
    await ensurePatchStateDir(this.config.patchStateDir);
  }

  async planCreate(input: PlanSkillCreateInput): Promise<PlannedSkillCreate> {
    // Captured before the bundle is validated and the target resolved, and
    // re-checked before the plan file is written: a root replaced in between
    // would tag this plan for a vault it was never derived against, and a Skill
    // create has no stale-content check at apply to fall back on.
    const vaultId = await vaultIdentityTag(await this.root());
    const files = validateBundle(input);
    const target = await this.targetPath(input.skill_name);
    await assertAbsent(target.absolute);

    const patchId = crypto.randomUUID();
    const diff = bundleDiff(target.relative, files);
    const plan: PlannedSkillCreate = {
      kind: "skill_create",
      patch_id: patchId,
      skill_name: input.skill_name,
      target_path: target.relative,
      reason: requireNonEmpty(input.reason, "reason"),
      created_at: new Date().toISOString(),
      files,
      diff
    };

    // Matches both document plan writers, which already call this immediately
    // before staging. It is idempotent, and it is where expired plans are swept
    // — so a Skill plan staged on a server that never restarts now ages out the
    // same way a document plan does. Without it this store would have been the
    // one writer the sweep did not reach.
    await ensurePatchStateDir(this.config.patchStateDir);
    if (vaultId !== (await vaultIdentityTag(await this.root()))) {
      throw new Error(
        "The vault changed while this Skill plan was being prepared, so nothing was staged. " +
          "Re-plan the Skill against this server."
      );
    }
    // vault_id goes in the FILE only, never in the record returned to the client
    // — see StagedPlan in types.ts for why.
    const staged = { ...plan, vault_id: vaultId };
    await fs.writeFile(this.patchPath(patchId), JSON.stringify(staged, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return plan;
  }

  async applyPlannedCreate(patchId: string): Promise<{
    skill_name: string;
    target_path: string;
    files: string[];
    diff: string;
  }> {
    let raw: string;
    try {
      raw = await fs.readFile(this.patchPath(patchId), "utf8");
    } catch (error) {
      // Same treatment as KnowledgeStore.readPatchFile: the raw ENOENT names the
      // patch-state directory. Containment is the boundary in clientSafeError.ts;
      // this is here so the caller gets a message it can act on.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("No staged Skill plan with that patch_id: it may have already been applied.", {
          cause: error
        });
      }
      throw error;
    }
    const plan = plannedSkillCreateSchema.parse(JSON.parse(raw)) as PlannedSkillCreate & { vault_id?: string };
    if (plan.patch_id !== patchId) {
      throw new Error("Skill plan id does not match the requested patch_id.");
    }
    // Before `targetPath()` resolves the bundle inside THIS root. A Skill is
    // loaded by later sessions as INSTRUCTIONS, so a cross-vault apply plants
    // them in a vault whose owner never approved the bundle (INV-3, INV-8).
    // Absent is refused, not warned about: the sweep that would eventually
    // remove an orphaned plan is staging-driven and may never run again.
    if (!plan.vault_id) {
      throw new Error(
        "Skill plan does not record which vault it was staged for, so it cannot be applied. " +
          "Re-plan the Skill against this server."
      );
    }
    if (plan.vault_id !== (await vaultIdentityTag(await this.root()))) {
      throw new Error(
        "Skill plan was staged for a different vault and will not be applied here. " +
          "Re-plan the Skill against this server."
      );
    }

    const files = validatePlannedFiles(plan.skill_name, plan.files);
    const target = await this.targetPath(plan.skill_name);
    if (plan.target_path !== target.relative || plan.diff !== bundleDiff(target.relative, files)) {
      throw new Error("Skill plan contents failed integrity validation.");
    }
    await assertAbsent(target.absolute);

    const skillsRoot = await this.skillsRoot();
    const temp = path.join(skillsRoot, `.mcp-skill-create-${patchId}`);
    await fs.mkdir(temp, { recursive: false, mode: 0o700 });

    try {
      for (const file of files) {
        const absolute = path.join(temp, ...file.path.split("/"));
        await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
        await fs.writeFile(absolute, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      }
      // Re-check immediately before the atomic same-filesystem rename. Existing
      // Skills are never replaced; a concurrent creator makes apply fail.
      await assertAbsent(target.absolute);
      // And the vault, for the same reason it is re-checked in the document
      // writers: the check above ran before `targetPath()` walked the pathname.
      // This narrows the swap window to the rename itself; it does not close it.
      if (plan.vault_id !== (await vaultIdentityTag(await this.root()))) {
        throw new Error(
          "Skill plan was staged for a different vault and will not be applied here. " +
            "Re-plan the Skill against this server."
        );
      }
      await fs.rename(temp, target.absolute);
      await fs.unlink(this.patchPath(patchId));
      return {
        skill_name: plan.skill_name,
        target_path: target.relative,
        files: files.map((file) => `${target.relative}/${file.path}`),
        diff: plan.diff
      };
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async targetPath(skillName: string): Promise<{ absolute: string; relative: string }> {
    validateSkillName(skillName);
    const root = await this.root();
    const skillsRoot = await this.skillsRoot();
    const absolute = path.join(skillsRoot, skillName);
    const relative = toPosixPath(relativeToRoot(root, absolute));
    return { absolute, relative };
  }

  private patchPath(patchId: string): string {
    if (!PATCH_ID_PATTERN.test(patchId)) {
      throw new Error("Invalid patch_id.");
    }
    return path.join(this.config.patchStateDir, `${SKILL_PLAN_PREFIX}${patchId}.json`);
  }

  private async root(): Promise<string> {
    if (!this.rootRealPath) {
      await this.init();
    }
    return this.rootRealPath!;
  }

  private async skillsRoot(): Promise<string> {
    if (!this.skillsRootRealPath) {
      await this.init();
    }
    const root = await this.root();
    const candidate = await resolveInsideRoot(root, this.config.skillsSubdir);
    const currentRealPath = await fs.realpath(candidate);
    relativeToRoot(root, currentRealPath);
    if (currentRealPath !== this.skillsRootRealPath) {
      throw new Error("MCP_SKILLS_SUBDIR changed after initialization.");
    }
    return this.skillsRootRealPath!;
  }
}

function validateBundle(input: PlanSkillCreateInput): SkillBundleFile[] {
  validateSkillName(input.skill_name);
  validateSkillMarkdown(input.skill_name, input.skill_md);
  const references = input.references ?? [];
  if (references.length > MAX_REFERENCES) {
    throw new Error(`A Skill may include at most ${MAX_REFERENCES} references.`);
  }

  const files: SkillBundleFile[] = [{ path: "SKILL.md", content: normalizeText(input.skill_md, "SKILL.md") }];
  for (const reference of references) {
    if (!REFERENCE_FILENAME_PATTERN.test(reference.filename) || reference.filename === "SKILL.md") {
      throw new Error(`Invalid reference filename: ${reference.filename}. Use a flat lowercase .md filename.`);
    }
    files.push({
      path: `references/${reference.filename}`,
      content: normalizeText(reference.content, `references/${reference.filename}`)
    });
  }
  if (input.openai_yaml !== undefined) {
    files.push({ path: "agents/openai.yaml", content: normalizeText(input.openai_yaml, "agents/openai.yaml") });
  }
  return validateFileSet(files);
}

function validatePlannedFiles(skillName: string, files: SkillBundleFile[]): SkillBundleFile[] {
  validateSkillName(skillName);
  const normalized = validateFileSet(
    files.map((file) => ({ ...file, content: normalizeText(file.content, file.path) }))
  );
  const skill = normalized.find((file) => file.path === "SKILL.md");
  if (!skill) {
    throw new Error("Skill plan is missing SKILL.md.");
  }
  validateSkillMarkdown(skillName, skill.content);
  return normalized;
}

function validateFileSet(files: SkillBundleFile[]): SkillBundleFile[] {
  const allowed = (filePath: string): boolean =>
    filePath === "SKILL.md" ||
    filePath === "agents/openai.yaml" ||
    (filePath.startsWith("references/") && REFERENCE_FILENAME_PATTERN.test(filePath.slice("references/".length)));
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!allowed(file.path)) {
      throw new Error(`Skill file path is not allowed: ${file.path}.`);
    }
    if (seen.has(file.path)) {
      throw new Error(`Duplicate Skill file path: ${file.path}.`);
    }
    seen.add(file.path);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`Skill file is too large: ${file.path}.`);
    }
    // SKILL.md's frontmatter is already pinned to name/description by
    // validateSkillMarkdown. Reference files had no such check: their bytes land
    // in the vault verbatim and are indexed as documents like any other .md, so
    // one could declare another note's `id` and answer every lookup aimed at it.
    // INV-8 constrained WHERE a bundle may write and said nothing about WHAT it
    // may claim once written.
    //
    // This lives in validateFileSet because it is the one function BOTH the plan
    // and apply paths end at. Checking only at apply would still refuse the
    // write, but it would refuse it after presenting the operator a diff to
    // approve — the squat has to be unrepresentable, not merely unapplied. The
    // size check above runs first, so the parse below only ever sees bounded
    // input, and that parse caps the frontmatter block before gray-matter runs.
    if (file.path.startsWith("references/")) {
      assertNoServerOwnedFrontmatter(file.content, `Skill reference ${file.path}`);
    }
    total += bytes;
  }
  if (!seen.has("SKILL.md")) {
    throw new Error("Skill bundle must include SKILL.md.");
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new Error("Skill bundle is too large.");
  }
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

function validateSkillName(skillName: string): void {
  if (skillName.length > 64 || !SKILL_NAME_PATTERN.test(skillName)) {
    throw new Error("Skill name must be lowercase hyphen-case and at most 64 characters.");
  }
}

function validateSkillMarkdown(skillName: string, content: string): void {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    throw new Error("SKILL.md must begin with YAML frontmatter.");
  }
  let parsed: matter.GrayMatterFile<string>;
  try {
    // Defense in depth: the `---\n` prefix check above already refuses a
    // language-tagged block such as `---js`, but the parse still runs with the
    // executable engines stubbed out so this call site can never eval SKILL.md.
    parsed = matter(content, SAFE_MATTER_OPTIONS);
  } catch {
    throw new Error("SKILL.md frontmatter is invalid YAML.");
  }
  const keys = Object.keys(parsed.data).sort();
  if (keys.join(",") !== "description,name") {
    throw new Error("SKILL.md frontmatter may contain only name and description.");
  }
  if (parsed.data.name !== skillName) {
    throw new Error("SKILL.md frontmatter name must match skill_name.");
  }
  if (typeof parsed.data.description !== "string" || !parsed.data.description.trim()) {
    throw new Error("SKILL.md frontmatter description must be a non-empty string.");
  }
  if (!parsed.content.trim()) {
    throw new Error("SKILL.md must include instruction content.");
  }
}

function normalizeText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} must be text without NUL bytes.`);
  }
  const normalized = value.replace(/\r\n/g, "\n").trimEnd() + "\n";
  if (Buffer.byteLength(normalized, "utf8") > MAX_FILE_BYTES) {
    throw new Error(`Skill file is too large: ${label}.`);
  }
  return normalized;
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

async function assertAbsent(target: string): Promise<void> {
  try {
    await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("Skill already exists; existing Skills are never overwritten.");
}

function bundleDiff(targetPath: string, files: SkillBundleFile[]): string {
  return files
    .map((file) =>
      createTwoFilesPatch("/dev/null", `${targetPath}/${file.path}`, "", file.content, "absent", "planned")
    )
    .join("\n");
}
