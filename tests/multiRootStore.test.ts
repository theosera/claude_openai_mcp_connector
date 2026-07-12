import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadHttpConfig } from "../src/config.js";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { MultiRootStore, createStore } from "../src/multiRootStore.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SESSION_NOTE = `---
id: cc-session-test-001
title: Multi Root Session
client: claude-code
project: connector
tags: [claude-code-session]
---

# Multi Root Session

Session log mentioning retrieval work.
`;

// No frontmatter id: the document id falls back to the relative path, which
// must be root-prefixed in multi-root results so it stays unique.
const PLAIN_NOTE = `---
title: Plain Ops Note
client: chatgpt
project: research
tags: [ops]
---

# Plain Ops Note

Command log covering retrieval commands.
`;

describe("KNOWLEDGE_ROOTS config", () => {
  const base = { MCP_WRITE_MODE: "two_step" } as NodeJS.ProcessEnv;

  it("parses named roots in order (first = primary)", () => {
    const config = loadConfig({ ...base, KNOWLEDGE_ROOTS: "vault=/tmp/a, ops=/tmp/b" });
    expect(config.knowledgeRoots).toEqual([
      { name: "vault", path: path.resolve("/tmp/a") },
      { name: "ops", path: path.resolve("/tmp/b") }
    ]);
  });

  it("keeps single KNOWLEDGE_ROOT backward compatible as one root named vault", () => {
    const config = loadConfig({ ...base, KNOWLEDGE_ROOT: "/tmp/a" });
    expect(config.knowledgeRoots).toEqual([{ name: "vault", path: path.resolve("/tmp/a") }]);
  });

  it("parses a vault-relative Skills subdir and rejects escape paths", () => {
    const config = loadConfig({
      ...base,
      KNOWLEDGE_ROOT: "/tmp/a",
      MCP_SKILLS_SUBDIR: "06_Self_Discipline/_Development/skills"
    });
    expect(config.skillsSubdir).toBe("06_Self_Discipline/_Development/skills");
    expect(() => loadConfig({ ...base, KNOWLEDGE_ROOT: "/tmp/a", MCP_SKILLS_SUBDIR: "../outside" })).toThrow(/escapes/);
    expect(() => loadConfig({ ...base, KNOWLEDGE_ROOT: "/tmp/a", MCP_SKILLS_SUBDIR: "/tmp/outside" })).toThrow(
      /Absolute/
    );
  });

  it("rejects entries without name=path shape", () => {
    expect(() => loadConfig({ ...base, KNOWLEDGE_ROOTS: "/tmp/a" })).toThrow(/Invalid KNOWLEDGE_ROOTS entry/);
    expect(() => loadConfig({ ...base, KNOWLEDGE_ROOTS: "vault=" })).toThrow(/Invalid KNOWLEDGE_ROOTS entry/);
  });

  it("rejects invalid and duplicate root names", () => {
    expect(() => loadConfig({ ...base, KNOWLEDGE_ROOTS: "Bad Name=/tmp/a" })).toThrow(/Invalid knowledge root name/);
    expect(() => loadConfig({ ...base, KNOWLEDGE_ROOTS: "vault=/tmp/a,vault=/tmp/b" })).toThrow(
      /Duplicate knowledge root name/
    );
  });

  it("requires KNOWLEDGE_ROOT or KNOWLEDGE_ROOTS", () => {
    expect(() => loadConfig({ ...base })).toThrow(/KNOWLEDGE_ROOT/);
  });
});

describe("Skill HTTP write config", () => {
  it("enables Skill writes independently and fails closed without a subdir", () => {
    const config = loadHttpConfig({
      MCP_AUTH_TOKEN: "test-token",
      MCP_HTTP_ALLOW_WRITE: "",
      MCP_HTTP_ALLOW_SKILL_WRITE: "1",
      MCP_SKILLS_SUBDIR: "knowledge/skills"
    });
    expect(config.allowWrite).toBe(false);
    expect(config.allowSkillWrite).toBe(true);

    expect(() =>
      loadHttpConfig({
        MCP_AUTH_TOKEN: "test-token",
        MCP_HTTP_ALLOW_SKILL_WRITE: "1"
      })
    ).toThrow(/requires MCP_SKILLS_SUBDIR/);
  });
});

describe("MultiRootStore", () => {
  let vaultRoot: string;
  let opsRoot: string;
  let patchStateDir: string;
  let store: MultiRootStore;

  const makeConfig = (roots: Array<{ name: string; path: string }>) => ({
    knowledgeRoots: roots,
    writeMode: "two_step" as const,
    patchStateDir
  });

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-vault-"));
    opsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ops-"));
    patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-patches-"));
    await fs.cp(path.join(repoRoot, "fixtures", "synthetic-vault"), vaultRoot, { recursive: true });
    await fs.mkdir(path.join(opsRoot, "logs"), { recursive: true });
    await fs.writeFile(path.join(opsRoot, "logs", "session.md"), SESSION_NOTE, "utf8");
    await fs.writeFile(path.join(opsRoot, "logs", "plain.md"), PLAIN_NOTE, "utf8");

    store = new MultiRootStore(
      makeConfig([
        { name: "vault", path: vaultRoot },
        { name: "ops", path: opsRoot }
      ])
    );
    await store.init();
  });

  it("resolves a frontmatter id that collides with a root name to the note that carries it", async () => {
    // Root names are short words ("vault", "ops"), and Obsidian notes carry
    // custom frontmatter ids. A vault note with `id: "ops:secret"` must fetch to
    // THAT note — not be mis-routed into the "ops" root and return a different
    // document (a silently-wrong RAG citation / source-integrity bug).
    await fs.writeFile(
      path.join(vaultRoot, "collide.md"),
      '---\nid: "ops:secret"\ntitle: Vault Collide\n---\n\nVAULTCOLLIDEBODY\n',
      "utf8"
    );
    await fs.writeFile(path.join(opsRoot, "secret.md"), "---\ntitle: Ops Secret\n---\n\nOPSSECRETBODY\n", "utf8");

    // search emits the colliding id for the vault note...
    const hit = (await store.search({ query: "VAULTCOLLIDEBODY" })).find((r) => r.id === "ops:secret");
    expect(hit?.title).toBe("Vault Collide");

    // ...and fetch returns exactly that note, not the ops root's secret.md.
    const fetched = await store.fetch("ops:secret");
    expect(fetched.title).toBe("Vault Collide");
    expect(fetched.body).toContain("VAULTCOLLIDEBODY");

    // The genuine ops document is still reachable via its own prefixed path id.
    const ops = await store.fetch("ops:secret.md");
    expect(ops.title).toBe("Ops Secret");
  });

  it("createStore picks the plain single-root store for one root", () => {
    const single = createStore(makeConfig([{ name: "vault", path: vaultRoot }]));
    expect(single).toBeInstanceOf(KnowledgeStore);
    const multi = createStore(
      makeConfig([
        { name: "vault", path: vaultRoot },
        { name: "ops", path: opsRoot }
      ])
    );
    expect(multi).toBeInstanceOf(MultiRootStore);
  });

  it("searches across every root and labels hits with their root", async () => {
    const results = await store.search({ query: "retrieval" });
    const roots = new Set(results.map((result) => result.root));

    expect(roots).toEqual(new Set(["vault", "ops"]));
    const opsHit = results.find((result) => result.id === "cc-session-test-001");
    expect(opsHit).toMatchObject({ root: "ops", path: "ops:logs/session.md" });
  });

  it("fetches by prefixed path, prefixed id, and bare frontmatter id", async () => {
    const byPrefixedPath = await store.fetch("ops:logs/session.md");
    expect(byPrefixedPath).toMatchObject({ id: "cc-session-test-001", root: "ops" });

    const byBareId = await store.fetch("cc-session-test-001");
    expect(byBareId.relativePath).toBe("ops:logs/session.md");

    const byPrefixedId = await store.fetch("ops:cc-session-test-001");
    expect(byPrefixedId.relativePath).toBe("ops:logs/session.md");
  });

  it("prefixes path-derived ids so they stay unique across roots", async () => {
    const plain = await store.fetch("ops:logs/plain.md");
    expect(plain.id).toBe("ops:logs/plain.md");
    // Round-trip: the prefixed id resolves back to the same document.
    const again = await store.fetch(plain.id);
    expect(again.relativePath).toBe("ops:logs/plain.md");
  });

  it("still rejects path traversal through a root prefix", async () => {
    await expect(store.fetch("ops:../outside.md")).rejects.toThrow(/escapes/);
    await expect(store.fetch("../outside.md")).rejects.toThrow(/escapes/);
  });

  it("treats an unknown prefix as a plain reference (not a root escape)", async () => {
    await expect(store.fetch("nope:missing.md")).rejects.toThrow(/not found/i);
  });

  it("keeps the symlink-escape guard on secondary roots", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-outside-"));
    await fs.writeFile(path.join(outside, "secret.md"), "# secret\n", "utf8");
    await fs.symlink(outside, path.join(opsRoot, "linked-outside"));

    await expect(store.listDocuments()).rejects.toThrow(/escapes/);
  });

  it("merges listProjects across roots (same client/project sums up)", async () => {
    const projects = await store.listProjects();

    // fixtures: chatgpt/research (1) + ops plain note chatgpt/research (1) = 2.
    expect(projects).toEqual([
      expect.objectContaining({ client: "chatgpt", project: "research", count: 2 }),
      expect.objectContaining({ client: "claude", project: "planning", count: 1 }),
      expect.objectContaining({ client: "claude-code", project: "connector", count: 1 })
    ]);
  });

  it("routes createDocument to the primary root only", async () => {
    const created = await store.createDocument({
      client: "shared",
      project: "frameworks",
      title: "Multi Root Created",
      body: "# Multi Root Created\n\nSynthetic body."
    });

    expect(created.relativePath).toBe("vault:projects/shared/frameworks/multi-root-created.md");
    expect(created.root).toBe("vault");
    await expect(
      fs.stat(path.join(vaultRoot, "projects/shared/frameworks/multi-root-created.md"))
    ).resolves.toBeTruthy();
  });

  it("plans and applies updates on the primary root (prefixed or bare refs)", async () => {
    const plan = await store.planUpdate({
      id_or_path: "vault:projects/claude/planning/connector-plan.md",
      new_body: "# Claude Connector Plan\n\nUpdated through multi-root.",
      reason: "multi-root write test"
    });

    const applied = await store.applyPlannedUpdate(plan.patch_id);
    expect(applied.document.body).toContain("Updated through multi-root");
    expect(applied.document.relativePath).toBe("vault:projects/claude/planning/connector-plan.md");
  });

  it("fails closed on writes addressed to a read-only root", async () => {
    await expect(
      store.planUpdate({
        id_or_path: "ops:logs/session.md",
        new_body: "tampered",
        reason: "write to read-only root"
      })
    ).rejects.toThrow(/read-only/);

    // A bare reference resolving only inside a read-only root is unreachable
    // for writes: the primary store cannot see it.
    await expect(
      store.planUpdate({
        id_or_path: "cc-session-test-001",
        new_body: "tampered",
        reason: "write via bare id of a read-only document"
      })
    ).rejects.toThrow(/not found/i);
  });

  it("traces sources through the root prefix", async () => {
    const traced = await store.traceSources("ops:logs/session.md");
    expect(traced.document.relativePath).toBe("ops:logs/session.md");
  });

  it("computes same-root backlinks through the composite", async () => {
    // fixture: connector-plan.md links to shared-search.md inside the vault root.
    const traced = await store.traceSources("chatgpt-research-001");
    expect(traced.backlinks).toEqual([
      expect.objectContaining({
        id: "claude-plan-001",
        relativePath: "vault:projects/claude/planning/connector-plan.md"
      })
    ]);
  });

  it("computes cross-root backlinks (vault note referencing an ops document)", async () => {
    await fs.writeFile(
      path.join(vaultRoot, "reference.md"),
      "# Reference\n\nSee [the session](ops:logs/session.md) and [[Multi Root Session]].\n",
      "utf8"
    );

    const traced = await store.traceSources("ops:logs/session.md");
    expect(traced.backlinks).toEqual([expect.objectContaining({ relativePath: "vault:reference.md" })]);
  });

  it("rejects overlapping (nested or duplicate) roots at init", async () => {
    const nested = new MultiRootStore(
      makeConfig([
        { name: "vault", path: vaultRoot },
        { name: "inner", path: path.join(vaultRoot, "projects") }
      ])
    );
    await expect(nested.init()).rejects.toThrow(/overlap/);

    const duplicate = new MultiRootStore(
      makeConfig([
        { name: "a", path: opsRoot },
        { name: "b", path: opsRoot }
      ])
    );
    await expect(duplicate.init()).rejects.toThrow(/overlap/);
  });
});
