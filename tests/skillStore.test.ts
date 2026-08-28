import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { MAX_FRONTMATTER_BLOCK_BYTES } from "../src/frontmatter.js";
import { PLAN_MAX_AGE_MS, vaultIdentityTag } from "../src/patchState.js";
import { SkillStore, type PlanSkillCreateInput } from "../src/skillStore.js";

const SKILL_MD = `---
name: improve-ai-harness
description: Improve an existing AI harness from failure evidence.
---

# Improve AI Harness

Reproduce the failure before changing the harness.
`;

describe("SkillStore", () => {
  let root: string;
  let skillsRoot: string;
  let patchStateDir: string;
  let store: SkillStore;

  const validInput = (): PlanSkillCreateInput => ({
    skill_name: "improve-ai-harness",
    skill_md: SKILL_MD,
    references: [{ filename: "evaluation-template.md", content: "# Evaluation\n\nRecord evidence.\n" }],
    openai_yaml: 'interface:\n  display_name: "AI Harness Improvement"\n  short_description: "Improve an AI harness"\n',
    reason: "Create the reviewed harness-improvement Skill"
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-vault-"));
    skillsRoot = path.join(root, "knowledge", "skills");
    patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-patches-"));
    await fs.mkdir(skillsRoot, { recursive: true });
    store = new SkillStore({
      knowledgeRoot: root,
      skillsSubdir: "knowledge/skills",
      patchStateDir
    });
    await store.init();
  });

  it("plans without touching the target, then atomically creates the bundle", async () => {
    const plan = await store.planCreate(validInput());
    const target = path.join(skillsRoot, "improve-ai-harness");

    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(plan.target_path).toBe("knowledge/skills/improve-ai-harness");
    expect(plan.diff).toContain("SKILL.md");
    expect(plan.diff).toContain("references/evaluation-template.md");

    const applied = await store.applyPlannedCreate(plan.patch_id);
    expect(applied.files).toEqual([
      "knowledge/skills/improve-ai-harness/agents/openai.yaml",
      "knowledge/skills/improve-ai-harness/references/evaluation-template.md",
      "knowledge/skills/improve-ai-harness/SKILL.md"
    ]);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(await fs.readFile(path.join(target, "references/evaluation-template.md"), "utf8")).toContain(
      "Record evidence"
    );
    await expect(store.applyPlannedCreate(plan.patch_id)).rejects.toThrow();
  });

  it("never overwrites an existing Skill", async () => {
    const target = path.join(skillsRoot, "improve-ai-harness");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "SKILL.md"), "existing", "utf8");

    await expect(store.planCreate(validInput())).rejects.toThrow(/already exists/);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("existing");
  });

  it("fails apply if the target appeared after planning", async () => {
    const plan = await store.planCreate(validInput());
    const target = path.join(skillsRoot, "improve-ai-harness");
    await fs.mkdir(target);

    await expect(store.applyPlannedCreate(plan.patch_id)).rejects.toThrow(/already exists/);
  });

  it("rejects traversal and non-flat reference paths", async () => {
    await expect(store.planCreate({ ...validInput(), skill_name: "../escape" })).rejects.toThrow(/hyphen-case/);
    await expect(
      store.planCreate({
        ...validInput(),
        references: [{ filename: "../escape.md", content: "unsafe" }]
      })
    ).rejects.toThrow(/Invalid reference filename/);
    await expect(
      store.planCreate({
        ...validInput(),
        references: [{ filename: "nested/reference.md", content: "unsafe" }]
      })
    ).rejects.toThrow(/Invalid reference filename/);
  });

  it("requires exact name/description frontmatter and matching identity", async () => {
    await expect(
      store.planCreate({ ...validInput(), skill_md: SKILL_MD.replace("improve-ai-harness", "different-name") })
    ).rejects.toThrow(/must match/);
    await expect(
      store.planCreate({
        ...validInput(),
        skill_md: SKILL_MD.replace("description:", "allowed-tools: Bash\ndescription:")
      })
    ).rejects.toThrow(/only name and description/);
  });

  it("never evaluates an executable front-matter block in SKILL.md", async () => {
    // gray-matter dispatches a language-tagged block (`---js`) to its bundled
    // javascript engine, whose parse() is a raw eval(). The `---\n` prefix check
    // refuses the bundle before matter() is reached, and the parse itself runs
    // with the executable engines stubbed out. Assert NON-EXECUTION via a
    // globalThis marker, not merely that an error was raised.
    const marker = "__skillFrontmatterExecuted__";
    const host = globalThis as unknown as Record<string, unknown>;
    try {
      await expect(
        store.planCreate({
          ...validInput(),
          skill_md: `---js\nglobalThis[${JSON.stringify(marker)}] = "executed";\n---\n\n# Improve AI Harness\n`
        })
      ).rejects.toThrow(/must begin with YAML frontmatter/);
      expect(host[marker]).toBeUndefined();
    } finally {
      delete host[marker];
    }
  });

  it("rejects duplicate files and NUL content", async () => {
    await expect(
      store.planCreate({
        ...validInput(),
        references: [
          { filename: "same.md", content: "a" },
          { filename: "same.md", content: "b" }
        ]
      })
    ).rejects.toThrow(/Duplicate/);
    await expect(
      store.planCreate({
        ...validInput(),
        references: [{ filename: "bad.md", content: `bad${String.fromCharCode(0)}content` }]
      })
    ).rejects.toThrow(/NUL/);
  });

  it("rejects a Skills subdir symlink that escapes the knowledge root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-outside-"));
    const linked = path.join(root, "linked-skills");
    await fs.symlink(outside, linked);
    const escaping = new SkillStore({
      knowledgeRoot: root,
      skillsSubdir: "linked-skills",
      patchStateDir
    });

    await expect(escaping.init()).rejects.toThrow(/escapes/);
  });

  it("fails closed if the Skills directory is replaced after initialization", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-replaced-outside-"));
    await fs.rename(skillsRoot, `${skillsRoot}-original`);
    await fs.symlink(outside, skillsRoot);

    await expect(store.planCreate(validInput())).rejects.toThrow(/escapes|changed after initialization/);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  // INV-2 (write side) / INV-8. SKILL.md's frontmatter was already pinned to
  // name/description. Reference files were not: their bytes land in the vault
  // verbatim and are indexed as documents, so one could declare another note's
  // `id` and answer lookups aimed at it. Constraining WHERE a bundle writes said
  // nothing about WHAT it may claim once written.
  describe("server-owned frontmatter in reference files (INV-2 write side)", () => {
    const withReference = (content: string): PlanSkillCreateInput => ({
      ...validInput(),
      references: [{ filename: "evaluation-template.md", content }]
    });

    it("refuses a reference claiming another note's identity, at PLAN time", async () => {
      await expect(
        store.planCreate(withReference("---\nid: projects/roadmap.md\n---\n\n# Evaluation\n"))
      ).rejects.toThrow(/server-owned frontmatter \(id\)/);

      // Plan already refuses, so the squat never reaches a diff a user could
      // approve. Checking apply alone would pass while leaving the operator one
      // "yes" away from writing it.
      await expect(fs.readdir(skillsRoot)).resolves.toEqual([]);
    });

    it("refuses a reference stamping updated_at", async () => {
      await expect(
        store.planCreate(withReference("---\nupdated_at: '2001-01-01T00:00:00.000Z'\n---\n\n# Evaluation\n"))
      ).rejects.toThrow(/server-owned frontmatter \(updated_at\)/);
    });

    it("still accepts a reference whose frontmatter claims nothing the server owns", async () => {
      const plan = await store.planCreate(withReference("---\ntitle: Evaluation\ntags:\n  - harness\n---\n\n# E\n"));
      const applied = await store.applyPlannedCreate(plan.patch_id);
      expect(applied.files).toContain("knowledge/skills/improve-ai-harness/references/evaluation-template.md");
    });

    it("still accepts a reference with no frontmatter at all", async () => {
      const plan = await store.planCreate(withReference("# Evaluation\n\nRecord evidence.\n"));
      await expect(store.applyPlannedCreate(plan.patch_id)).resolves.toBeTruthy();
    });
  });

  // CWE-1333. `skill_md` is an unbounded `z.string()` from an MCP client, and
  // planning used to hand it to gray-matter BEFORE normalizeText and
  // validateFileSet had capped it — so matter() ran on a payload bounded by
  // nothing nearer than the HTTP body cap (4 MiB). gray-matter's comment
  // stripper (`/^\s*#[^\n]+/gm`) backtracks `\s*` across every whitespace run
  // reachable from a line start, which is quadratic in the length of those runs,
  // and an unterminated block is the worst shape because gray-matter then treats
  // the whole file as the block (index.js: `if (closeIndex === -1) closeIndex = len`).
  //
  // Measured on the resolved tree, unterminated newline blocks: 10.2 s at
  // 128 KiB, 41.2 s at 256 KiB, quadrupling per doubling. One call, one blocked
  // event loop, every other MCP client on the process waiting.
  describe("frontmatter parse is bounded before gray-matter sees it (CWE-1333)", () => {
    // Unterminated: no `\n---` anywhere, so the block is the whole file. The
    // trailing "x" matters — normalizeText trimEnd()s, and without it the run of
    // newlines would be trimmed away and the payload would never be oversized.
    const unterminatedBlock = (bytes: number): string => `---\n${"\n".repeat(bytes)}x`;

    it("refuses an oversize SKILL.md by SIZE, before any parse of it", async () => {
      const started = process.hrtime.bigint();
      await expect(store.planCreate({ ...validInput(), skill_md: unterminatedBlock(256 * 1024) })).rejects.toThrow(
        /too large after normalization/
      );
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      // BOTH assertions carry weight, and neither is redundant.
      //
      // The MESSAGE identifies which guard refused. normalizeText and
      // validateFileSet raise the same condition, and until their messages were
      // made distinguishable this could not tell them apart — nor tell either of
      // them from the block bound inside validateSkillMarkdown. Restore the old
      // call order and this payload is still refused, but by the block bound,
      // with a different message: red, and red for exactly the finding, because
      // reaching that bound means the input got as far as validateSkillMarkdown
      // before anything sized it.
      //
      // The TIME distinguishes "refused before the parse" from "refused after
      // one". A throw alone cannot: the old code threw too, 41 s later. 2 s is
      // ~2000x the observed cost and ~5% of the vulnerable one, so it separates
      // the two without being flaky on a loaded CI box.
      expect(elapsedMs).toBeLessThan(2000);

      // Nothing staged, nothing created: the refusal is total, not partial.
      await expect(fs.readdir(skillsRoot)).resolves.toEqual([]);
      await expect(fs.readdir(patchStateDir)).resolves.toEqual([]);
    });

    it("refuses an unterminated frontmatter block without parsing it", async () => {
      // The shape the size cap does NOT catch: 127 KiB is under MAX_FILE_BYTES,
      // so normalizeText passes it through, and with no closing delimiter
      // gray-matter parses the whole file as the block. Measured through the real
      // store before this guard: 9,980 ms, and then refused anyway.
      //
      // "Refused anyway" is the entire licence for this guard. gray-matter sets
      // file.content = '' whenever the block never closes, and
      // validateSkillMarkdown refuses empty instruction content — so no
      // unterminated SKILL.md has ever been accepted, whatever its YAML said.
      // Moving that refusal in front of the parse is refuse-to-refuse; it cannot
      // narrow the accepted set, only the bill.
      const started = process.hrtime.bigint();
      await expect(store.planCreate({ ...validInput(), skill_md: unterminatedBlock(127 * 1024) })).rejects.toThrow(
        /no closing --- delimiter/
      );
      // Time is the whole assertion here. The old code threw for this input too;
      // it just charged ~10 s of blocked event loop first, so a throw-only test
      // would have passed against the vulnerable version.
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2000);
    });

    it.each([
      ["valid keys", `---\nname: improve-ai-harness\ndescription: d\n`],
      ["wrong keys", `---\nfoo: bar\n`],
      ["unparseable YAML", `---\n\tname: [\n`],
      ["bare scalar", `---\n\n\n\nz`]
    ])("refused an unterminated block before this change too, so nothing narrowed: %s", async (_label, skillMd) => {
      // The refuse-to-refuse claim, enumerated rather than asserted in prose.
      // Each of these produced a DIFFERENT refusal message before the guard
      // ("must include instruction content", "may contain only name and
      // description", "invalid YAML", "may contain only name and description");
      // all four were refusals, which is the property that matters.
      await expect(store.planCreate({ ...validInput(), skill_md: skillMd })).rejects.toThrow();
      await expect(fs.readdir(skillsRoot)).resolves.toEqual([]);
    });

    it("keeps the same ordering on the apply path, for a plan tampered on disk", async () => {
      // applyPlannedCreate re-validates plan.files, and its integrity check
      // (plan.diff vs bundleDiff) runs only AFTER validatePlannedFiles — so the
      // parse must be bounded before it, not by it. Pins the apply half of the
      // ordering against a future edit that "tidies" validatePlannedFiles the
      // way validateBundle used to be written.
      const plan = await store.planCreate(validInput());
      const planPath = path.join(patchStateDir, `skill-create-${plan.patch_id}.json`);
      const staged = JSON.parse(await fs.readFile(planPath, "utf8")) as {
        files: { path: string; content: string }[];
      };
      const skill = staged.files.find((file) => file.path === "SKILL.md");
      expect(skill).toBeDefined();
      skill!.content = unterminatedBlock(256 * 1024);
      await fs.writeFile(planPath, JSON.stringify(staged), "utf8");

      const started = process.hrtime.bigint();
      await expect(store.applyPlannedCreate(plan.patch_id)).rejects.toThrow(/too large after normalization/);
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2000);
      await expect(fs.readdir(skillsRoot)).resolves.toEqual([]);
    });

    // The negative half, and the one that answers the objection that sank the
    // previous attempt at this fix: it closed the hole by giving SKILL.md the
    // READ path's 8 KiB MAX_FRONTMATTER_BLOCK_BYTES, which refuses a legitimate
    // name + description block this server accepts today. Bounding a parse is
    // not licence to shrink the accepted set, so this pins the size that must
    // keep working. Adopt the read-path cap here and it goes red.
    it("still accepts a frontmatter block far larger than the read path's cap", async () => {
      const description = "d".repeat(32 * 1024);
      const skillMd = `---\nname: improve-ai-harness\ndescription: ${description}\n---\n\n# Improve AI Harness\n\nBody.\n`;
      const blockBytes = Buffer.byteLength(skillMd.slice("---".length, skillMd.indexOf("\n---", "---".length)), "utf8");
      // Machine-checked, so the test cannot quietly stop testing what it says:
      // this block IS over the read-path cap and IS under the per-file cap.
      expect(blockBytes).toBeGreaterThan(MAX_FRONTMATTER_BLOCK_BYTES);
      expect(blockBytes).toBeLessThan(128 * 1024);

      const plan = await store.planCreate({ ...validInput(), skill_md: skillMd, references: [] });
      const applied = await store.applyPlannedCreate(plan.patch_id);
      expect(applied.files).toContain("knowledge/skills/improve-ai-harness/SKILL.md");
      expect(await fs.readFile(path.join(skillsRoot, "improve-ai-harness", "SKILL.md"), "utf8")).toBe(skillMd);
    });

    // The plan path now validates the NORMALIZED bytes rather than the raw ones,
    // which is what lets the size cap run first without narrowing anything. CRLF
    // is the shape most likely to break under that move — normalizeText rewrites
    // every line ending before validateSkillMarkdown sees it, so the
    // `startsWith("---\r\n")` arm of the frontmatter check is now unreachable
    // through both callers. This pins the outcome that actually matters: a CRLF
    // SKILL.md is still accepted, and lands as LF.
    it("still accepts a CRLF SKILL.md, and writes it with normalized line endings", async () => {
      const crlf = SKILL_MD.replace(/\n/g, "\r\n");
      const plan = await store.planCreate({ ...validInput(), skill_md: crlf, references: [] });
      await store.applyPlannedCreate(plan.patch_id);

      const written = await fs.readFile(path.join(skillsRoot, "improve-ai-harness", "SKILL.md"), "utf8");
      expect(written).toBe(SKILL_MD);
      expect(written).not.toContain("\r");
    });
  });

  it("expires old plans when a Skill plan is staged, not only at init", async () => {
    // The claim this pins is one the PR that added the sweep made in prose and
    // left untested: "without it this store would have been the one writer the
    // sweep did not reach." It was true — SkillStore called ensurePatchStateDir
    // from init() alone — and deleting the line it added to planCreate left the
    // entire suite green, because every sweep test drove a DOCUMENT plan.
    //
    // A long-running server inits once. If only the document writers sweep, a
    // deployment whose two-step traffic is Skill creation never expires
    // anything, and a plan holds a whole proposed bundle on disk.
    const stale = path.join(patchStateDir, "77777777-7777-4777-8777-777777777777.json");
    await fs.writeFile(stale, "{}", "utf8");
    const longAgo = new Date(Date.now() - (PLAN_MAX_AGE_MS + 60_000));
    await fs.utimes(stale, longAgo, longAgo);

    const plan = await store.planCreate(validInput());

    await expect(fs.access(stale)).rejects.toThrow();
    // The plan just staged survived its own sweep and still applies.
    const applied = await store.applyPlannedCreate(plan.patch_id);
    expect(applied.files).toContain("knowledge/skills/improve-ai-harness/SKILL.md");
  });
});

describe("loadConfig skills subtree disjointness (INV-8)", () => {
  // The Skills subtree is reserved against the general write surface, and
  // create_document always writes under "projects/". Overlapping them leaves the
  // create root permanently rejecting, so this has to fail at boot rather than
  // once per create — the audit subdir already gets the same treatment.
  it("rejects a skills subdir nested under projects/", () => {
    expect(() => loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault", MCP_SKILLS_SUBDIR: "projects/skills" })).toThrow(
      /disjoint/
    );
  });

  it("rejects a skills subdir equal to projects/", () => {
    expect(() => loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault", MCP_SKILLS_SUBDIR: "projects" })).toThrow(/disjoint/);
  });

  it("rejects a skills subdir that contains projects/", () => {
    // The reverse containment branch, which the equality case above does not
    // reach. "./" is the one value that survives assertRelativePath while still
    // being a parent of "projects" — it would reserve the entire vault against
    // the general write surface, so the boot check has to catch it.
    expect(() => loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault", MCP_SKILLS_SUBDIR: "./" })).toThrow(/disjoint/);
  });

  it("accepts a skills subdir outside projects/", () => {
    expect(() => loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault", MCP_SKILLS_SUBDIR: "_skills" })).not.toThrow();
  });
});

/**
 * INV-3 for the third plan kind. A Skill is loaded by later sessions AS
 * INSTRUCTIONS (INV-8), so a plan crossing vaults plants agent instructions in a
 * vault whose owner never saw the bundle — the heaviest of the three crossings,
 * and the one most easily forgotten because the ROADMAP entry names only
 * `applyPlannedUpdate`.
 */
describe("SkillStore INV-3 cross-vault plan binding", () => {
  let vaultA: string;
  let vaultB: string;
  let sharedPatchStateDir: string;
  let storeA: SkillStore;
  let storeB: SkillStore;

  const input = (): PlanSkillCreateInput => ({
    skill_name: "improve-ai-harness",
    skill_md: SKILL_MD,
    references: [],
    reason: "cross-vault probe"
  });

  beforeEach(async () => {
    vaultA = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-inv3-a-"));
    vaultB = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-inv3-b-"));
    sharedPatchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-inv3-shared-"));
    for (const root of [vaultA, vaultB]) {
      await fs.mkdir(path.join(root, "knowledge", "skills"), { recursive: true });
    }
    const config = (root: string) => ({
      knowledgeRoot: root,
      skillsSubdir: "knowledge/skills",
      patchStateDir: sharedPatchStateDir
    });
    storeA = new SkillStore(config(vaultA));
    storeB = new SkillStore(config(vaultB));
  });

  it("refuses to publish a Skill planned against another vault, and creates nothing there", async () => {
    const plan = await storeA.planCreate(input());
    // The response boundary, pinned here as it is for document plans: returning
    // `staged` instead of `plan` would hand the caller a hash of the vault's
    // absolute root and leave every other assertion in this file green.
    expect(plan).not.toHaveProperty("vault_id");

    await expect(storeB.applyPlannedCreate(plan.patch_id)).rejects.toThrow(/staged for a different vault/);
    await expect(fs.stat(path.join(vaultB, "knowledge", "skills", "improve-ai-harness"))).rejects.toThrow();
    // Refused, not consumed.
    const applied = await storeA.applyPlannedCreate(plan.patch_id);
    expect(applied.skill_name).toBe("improve-ai-harness");
  });

  it("refuses a foreign Skill plan before it validates the bundle, not after", async () => {
    // A valid skill_name would let this pass even if the vault check moved below
    // `validatePlannedFiles`. An invalid one makes the order observable.
    const plan = await storeA.planCreate(input());
    const planPath = path.join(sharedPatchStateDir, `skill-create-${plan.patch_id}.json`);
    const staged = JSON.parse(await fs.readFile(planPath, "utf8")) as Record<string, unknown>;
    staged.vault_id = await vaultIdentityTag(await fs.realpath(vaultB));
    staged.skill_name = "Not A Valid Name";
    await fs.writeFile(planPath, JSON.stringify(staged), "utf8");

    await expect(storeA.applyPlannedCreate(plan.patch_id)).rejects.toThrow(/staged for a different vault/);
  });

  it("refuses a Skill plan that does not record a vault", async () => {
    const plan = await storeA.planCreate(input());
    const planPath = path.join(sharedPatchStateDir, `skill-create-${plan.patch_id}.json`);
    const stripped = JSON.parse(await fs.readFile(planPath, "utf8")) as Record<string, unknown>;
    delete stripped.vault_id;
    await fs.writeFile(planPath, JSON.stringify(stripped), "utf8");

    await expect(storeA.applyPlannedCreate(plan.patch_id)).rejects.toThrow(/does not record which vault/);
    await expect(fs.stat(path.join(vaultA, "knowledge", "skills", "improve-ai-harness"))).rejects.toThrow();
  });

  it("still publishes a Skill in the vault that staged it", async () => {
    const plan = await storeA.planCreate(input());
    const applied = await storeA.applyPlannedCreate(plan.patch_id);
    // `files` are target-relative paths, not bare names.
    expect(applied.files).toContain("knowledge/skills/improve-ai-harness/SKILL.md");
    expect(await fs.stat(path.join(vaultA, "knowledge", "skills", "improve-ai-harness"))).toBeTruthy();
  });
});

describe("SkillStore INV-3 plan binding follows the resolved vault, not its spelling", () => {
  let vaultA: string;
  let vaultB: string;
  let linkParent: string;
  let link: string;
  let patchStateDir: string;

  const storeFor = (root: string): SkillStore =>
    new SkillStore({ knowledgeRoot: root, skillsSubdir: "knowledge/skills", patchStateDir });

  beforeEach(async () => {
    vaultA = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-link-a-"));
    vaultB = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-link-b-"));
    patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-link-state-"));
    linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-link-"));
    for (const root of [vaultA, vaultB]) {
      await fs.mkdir(path.join(root, "knowledge", "skills"), { recursive: true });
    }
    link = path.join(linkParent, "vault");
    await fs.symlink(vaultA, link);
  });

  afterEach(async () => {
    for (const dir of [vaultA, vaultB, patchStateDir, linkParent]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a Skill plan staged before the root symlink was retargeted at another vault", async () => {
    // A Skill is the heaviest of the three plan kinds: later sessions load it as
    // instructions, so publishing one into a vault nobody approved it for is the
    // crossing worth the most to an attacker.
    const before = storeFor(link);
    const plan = await before.planCreate({
      skill_name: "improve-ai-harness",
      skill_md: SKILL_MD,
      references: [],
      reason: "retarget probe"
    });

    await fs.unlink(link);
    await fs.symlink(vaultB, link);

    const after = storeFor(link);
    await expect(after.applyPlannedCreate(plan.patch_id)).rejects.toThrow(/staged for a different vault/);
    await expect(fs.stat(path.join(vaultB, "knowledge", "skills", "improve-ai-harness"))).rejects.toThrow();
  });
});

describe("SkillStore INV-3 plan binding survives the directory being replaced", () => {
  let parent: string;
  let vaultPath: string;
  let patchStateDir: string;

  const storeFor = (root: string): SkillStore =>
    new SkillStore({ knowledgeRoot: root, skillsSubdir: "knowledge/skills", patchStateDir });

  beforeEach(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-swap-"));
    patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-skill-swap-state-"));
    vaultPath = path.join(parent, "vault");
    await fs.mkdir(path.join(vaultPath, "knowledge", "skills"), { recursive: true });
  });

  afterEach(async () => {
    for (const dir of [parent, patchStateDir]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to stage a Skill plan when the vault is replaced while it is derived", async () => {
    // The planning window at the third writer. `init` is forced first so the
    // spy's first stat is the identity capture and not `resolveExistingRoot`'s —
    // otherwise the swap lands before the capture, the capture reads the
    // replacement, and the test goes green against a guard that never ran.
    const store = storeFor(vaultPath);
    await store.init();
    const rootRealPath = await fs.realpath(vaultPath);
    const realStat = fs.stat.bind(fs);
    let swapped = false;
    const spy = vi.spyOn(fs, "stat").mockImplementation((async (target: unknown, options?: unknown) => {
      const result = await (realStat as (t: unknown, o?: unknown) => Promise<unknown>)(target, options);
      if (!swapped && target === rootRealPath) {
        swapped = true;
        await fs.rm(vaultPath, { recursive: true, force: true });
        await fs.mkdir(path.join(vaultPath, "knowledge", "skills"), { recursive: true });
      }
      return result;
    }) as unknown as typeof fs.stat);

    try {
      await expect(
        store.planCreate({
          skill_name: "improve-ai-harness",
          skill_md: SKILL_MD,
          references: [],
          reason: "planning window probe"
        })
      ).rejects.toThrow(/changed while this Skill plan was being prepared/);
    } finally {
      spy.mockRestore();
    }

    expect(swapped).toBe(true);
    expect(await fs.readdir(patchStateDir)).toEqual([]);
  });

  it("refuses a Skill plan when the vault is replaced inside the same window", async () => {
    // The check/use window at the third writer. The spy lets the first identity
    // stat return the original directory's numbers and then replaces the
    // directory, so the check passes against a vault that is already gone and
    // `targetPath()` walks the pathname into the replacement.
    const before = storeFor(vaultPath);
    const plan = await before.planCreate({
      skill_name: "improve-ai-harness",
      skill_md: SKILL_MD,
      references: [],
      reason: "check-to-use window probe"
    });

    const rootRealPath = await fs.realpath(vaultPath);
    const realStat = fs.stat.bind(fs);
    let swapped = false;
    const spy = vi.spyOn(fs, "stat").mockImplementation((async (target: unknown, options?: unknown) => {
      const result = await (realStat as (t: unknown, o?: unknown) => Promise<unknown>)(target, options);
      if (!swapped && target === rootRealPath) {
        swapped = true;
        await fs.rm(vaultPath, { recursive: true, force: true });
        await fs.mkdir(path.join(vaultPath, "knowledge", "skills"), { recursive: true });
      }
      return result;
    }) as unknown as typeof fs.stat);

    try {
      await expect(before.applyPlannedCreate(plan.patch_id)).rejects.toThrow(/staged for a different vault/);
    } finally {
      spy.mockRestore();
    }

    expect(swapped).toBe(true);
    await expect(fs.stat(path.join(vaultPath, "knowledge", "skills", "improve-ai-harness"))).rejects.toThrow();
  });

  it("refuses a Skill plan staged before the directory at that path was replaced", async () => {
    // Like the create path above, a Skill has no stale-content check — and it is
    // read by later sessions as instructions, so publishing one into a vault
    // whose owner never saw the bundle is the worst of the three plan kinds.
    const before = storeFor(vaultPath);
    const plan = await before.planCreate({
      skill_name: "improve-ai-harness",
      skill_md: SKILL_MD,
      references: [],
      reason: "replacement probe"
    });

    await fs.rename(vaultPath, path.join(parent, "vault.old"));
    await fs.mkdir(path.join(vaultPath, "knowledge", "skills"), { recursive: true });

    const after = storeFor(vaultPath);
    await expect(after.applyPlannedCreate(plan.patch_id)).rejects.toThrow(/staged for a different vault/);
    await expect(fs.stat(path.join(vaultPath, "knowledge", "skills", "improve-ai-harness"))).rejects.toThrow();
  });
});
