import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
});
