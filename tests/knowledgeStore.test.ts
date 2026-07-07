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

  it("round-trips non-ASCII (NFD) filenames through search and fetch", async () => {
    // macOS reports filenames decomposed (NFD) while clients/transports send
    // paths composed (NFC). The identifier a search returns must be NFC so it
    // round-trips back through fetch(). Regression: an un-normalized NFD id never
    // === the NFC lookup key, so every Japanese-named note was "Document not
    // found" even though search surfaced it.
    const composed = "作業フォルダ.md".normalize("NFC");
    const decomposed = composed.normalize("NFD");
    expect(composed).not.toBe(decomposed); // this name is normalization-sensitive
    await fs.writeFile(path.join(root, decomposed), "# 見出し\n\nNFDMARKERBODY\n", "utf8");

    const results = await store.search({ query: "NFDMARKERBODY" });
    expect(results).toHaveLength(1);
    // The returned identifier is canonical NFC, not the raw NFD form on disk.
    expect(results[0].id).toBe(composed);
    expect(results[0].id).not.toBe(decomposed);

    // It round-trips: both the NFC id and the NFD form resolve to the same doc.
    expect((await store.fetch(composed)).relativePath).toBe(composed);
    expect((await store.fetch(decomposed)).relativePath).toBe(composed);
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

  it("indexes documents with unparseable frontmatter instead of aborting the whole search", async () => {
    // Notes with malformed frontmatter — a bare-dash value, an unterminated flow
    // sequence — make gray-matter throw. Before the fault-tolerant parse, one
    // such file rejected the whole listDocuments() batch, breaking search / list
    // / fetch / trace for every note in the vault.
    await fs.writeFile(
      path.join(root, "broken-branch.md"),
      '---\ntitle: "Broken"\nbranch: -\n---\n\nZZUNIQUEONE clip body\n',
      "utf8"
    );
    await fs.writeFile(path.join(root, "broken-seq.md"), "---\ntags: [a, b\n---\n\nZZUNIQUETWO clip body\n", "utf8");

    // Well-formed documents are unaffected.
    const good = await store.search({ query: "retrieval", client: "chatgpt" });
    expect(good).toHaveLength(1);

    // The malformed notes are not dropped — still searchable by body, with
    // fallback (empty) metadata and a path-derived title.
    expect((await store.search({ query: "ZZUNIQUEONE" })).map((result) => result.path)).toContain("broken-branch.md");
    expect((await store.search({ query: "ZZUNIQUETWO" })).map((result) => result.path)).toContain("broken-seq.md");

    // Other read paths survive a malformed note too.
    await expect(store.listProjects()).resolves.toBeDefined();
    await expect(store.listDocuments()).resolves.toHaveLength(4);
  });

  it("survives raw control characters in frontmatter and body (web-clipping corruption)", async () => {
    // Real-world corruption from web clippings: a raw control char (U+000B
    // vertical tab) inside a frontmatter string makes js-yaml throw "expected
    // valid JSON character", and control chars / NUL can also sit in the body.
    // Neither may abort the batch, and the returned results must stay valid JSON
    // (the server serializes them straight to the client with JSON.stringify).
    const VT = String.fromCharCode(0x0b);
    const NUL = String.fromCharCode(0x00);
    await fs.writeFile(
      path.join(root, "ctrl-front.md"),
      `---\ntitle: "WebRTC ${VT}8K"\n---\n\nZZCTRLFRONT body\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "ctrl-body.md"),
      `---\ntitle: Clip\n---\n\nZZCTRLBODY ${VT} and ${NUL} tail\n`,
      "utf8"
    );

    // Well-formed documents remain searchable.
    expect(await store.search({ query: "retrieval", client: "chatgpt" })).toHaveLength(1);

    // The corrupted notes are indexed by body, not dropped or crashing.
    expect((await store.search({ query: "ZZCTRLFRONT" })).map((r) => r.path)).toContain("ctrl-front.md");
    const body = await store.search({ query: "ZZCTRLBODY" });
    expect(body.map((r) => r.path)).toContain("ctrl-body.md");

    // Results and fetched documents must be JSON-serializable (control chars escaped).
    expect(() => JSON.parse(JSON.stringify(body))).not.toThrow();
    const fetched = await store.fetch("ctrl-front.md");
    expect(() => JSON.parse(JSON.stringify(fetched))).not.toThrow();
  });
});
