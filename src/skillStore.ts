import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import matter from "gray-matter";
import { z } from "zod";
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
    await fs.mkdir(this.config.patchStateDir, { recursive: true, mode: 0o700 });
  }

  async planCreate(input: PlanSkillCreateInput): Promise<PlannedSkillCreate> {
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

    await fs.writeFile(this.patchPath(patchId), JSON.stringify(plan, null, 2), {
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
    const raw = await fs.readFile(this.patchPath(patchId), "utf8");
    const plan = plannedSkillCreateSchema.parse(JSON.parse(raw)) as PlannedSkillCreate;
    if (plan.patch_id !== patchId) {
      throw new Error("Skill plan id does not match the requested patch_id.");
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
    if (!/^[0-9a-f-]{36}$/i.test(patchId)) {
      throw new Error("Invalid patch_id.");
    }
    return path.join(this.config.patchStateDir, `skill-create-${patchId}.json`);
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
    parsed = matter(content);
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
