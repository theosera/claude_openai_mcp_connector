import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { KnowledgeStore } from "../src/knowledgeStore.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("KnowledgeStore", () => {
  let root: string;
  let patchStateDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-vault-"));
    patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-patches-"));
    await fs.cp(path.join(repoRoot, "fixtures", "synthetic-vault"), root, { recursive: true });
    store = new KnowledgeStore({
      knowledgeRoot: root,
      writeMode: "two_step",
      patchStateDir
    });
    await store.init();
  });

  it("searches synthetic Markdown documents with filters", async () => {
    const results = await store.search({ query: "retrieval", client: "chatgpt" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "chatgpt-research-001",
      title: "Shared Search Framework",
      client: "chatgpt",
      project: "research"
    });
  });

  it("fetches documents by id and relative path", async () => {
    const byId = await store.fetch("claude-plan-001");
    const byPath = await store.fetch("projects/claude/planning/connector-plan.md");

    expect(byId.relativePath).toBe("projects/claude/planning/connector-plan.md");
    expect(byPath.id).toBe("claude-plan-001");
  });

  it("lists projects by frontmatter", async () => {
    const projects = await store.listProjects();

    expect(projects).toEqual([
      expect.objectContaining({ client: "chatgpt", project: "research", count: 1 }),
      expect.objectContaining({ client: "claude", project: "planning", count: 1 })
    ]);
  });

  it("creates new documents without overwriting existing files", async () => {
    const created = await store.createDocument({
      client: "shared",
      project: "frameworks",
      title: "Review Checklist",
      body: "# Review Checklist\n\nUse synthetic test content only.",
      tags: ["review"],
      source_refs: ["synthetic://shared/checklist"]
    });

    expect(created.relativePath).toBe("projects/shared/frameworks/review-checklist.md");
    expect(created.frontmatter.client).toBe("shared");

    await expect(
      store.createDocument({
        client: "shared",
        project: "frameworks",
        title: "Review Checklist",
        body: "duplicate"
      })
    ).rejects.toThrow(/already exists/);
  });

  it("plans then applies an update through a stale-safe two step flow", async () => {
    const plan = await store.planUpdate({
      id_or_path: "claude-plan-001",
      new_body: "# Claude Connector Plan\n\nUpdated synthetic body.",
      frontmatter_patch: { tags: ["mcp", "updated"] },
      reason: "test update"
    });

    expect(plan.diff).toContain("Updated synthetic body");

    const beforeApply = await store.fetch("claude-plan-001");
    expect(beforeApply.body).not.toContain("Updated synthetic body");

    const result = await store.applyPlannedUpdate(plan.patch_id);
    expect(result.document.body).toContain("Updated synthetic body");
    expect(result.document.frontmatter.tags).toEqual(["mcp", "updated"]);
  });

  it("rejects stale patch application", async () => {
    const plan = await store.planUpdate({
      id_or_path: "chatgpt-research-001",
      new_body: "# Shared Search Framework\n\nPlanned body.",
      reason: "test stale update"
    });

    await fs.appendFile(path.join(root, "projects/chatgpt/research/shared-search.md"), "\nExternal edit.\n");

    await expect(store.applyPlannedUpdate(plan.patch_id)).rejects.toThrow(/stale/);
  });

  it("rejects a non-allowlisted frontmatter key in plan_document_update", async () => {
    await expect(
      store.planUpdate({
        id_or_path: "claude-plan-001",
        new_body: "# Claude Connector Plan\n\nBody.",
        frontmatter_patch: { malicious: "payload" },
        reason: "frontmatter injection attempt"
      })
    ).rejects.toThrow(/not allowed/);
  });

  it("rejects patching server-owned frontmatter keys (id / updated_at)", async () => {
    await expect(
      store.planUpdate({
        id_or_path: "claude-plan-001",
        new_body: "body",
        frontmatter_patch: { id: "spoofed-id" },
        reason: "identity spoof attempt"
      })
    ).rejects.toThrow(/not allowed/);
  });

  it("rejects non-string scalar frontmatter patch values", async () => {
    await expect(
      store.planUpdate({
        id_or_path: "claude-plan-001",
        new_body: "body",
        frontmatter_patch: { title: ["not", "a", "string"] },
        reason: "type confusion attempt"
      })
    ).rejects.toThrow(/must be a string/);
  });

  it("rejects non-string-array frontmatter patch values", async () => {
    await expect(
      store.planUpdate({
        id_or_path: "claude-plan-001",
        new_body: "body",
        frontmatter_patch: { tags: ["ok", { nested: "bad" }] },
        reason: "nested metadata attempt"
      })
    ).rejects.toThrow(/array of strings/);
  });

  it("traces source refs and backlinks", async () => {
    const traced = await store.traceSources("chatgpt-research-001");

    expect(traced.source_refs).toEqual(["synthetic://chatgpt/project/research"]);
    expect(traced.backlinks).toEqual([expect.objectContaining({ id: "claude-plan-001" })]);
  });

  it("rejects path traversal", async () => {
    await expect(store.fetch("../outside.md")).rejects.toThrow(/escapes/);
  });

  it("rejects symlink escape from the vault", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-outside-"));
    await fs.writeFile(path.join(outside, "secret.md"), "# secret\n", "utf8");
    await fs.symlink(outside, path.join(root, "linked-outside"));

    await expect(store.listDocuments()).rejects.toThrow(/escapes/);
  });

  it("does not recurse forever on symlink cycles inside the vault", async () => {
    await fs.symlink(root, path.join(root, "loop"));

    const documents = await store.listDocuments();
    expect(documents.map((document) => document.id).sort()).toEqual(["chatgpt-research-001", "claude-plan-001"]);
  });
});
