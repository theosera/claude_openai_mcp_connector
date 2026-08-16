import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PLAN_MAX_AGE_MS } from "../src/patchState.js";
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
