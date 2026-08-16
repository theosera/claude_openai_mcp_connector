import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    patchStateDir,
    // Transport-level flags; the store never reads them. Set explicitly rather
    // than made optional so a future surface flag cannot be forgotten here —
    // which is exactly what happened when MCP_STDIO_ALLOW_SKILL_WRITE was added:
    // the compiler named every construction site instead of defaulting them on.
    stdioAllowAuditWrite: false,
    stdioAllowSkillWrite: false,
    allowLegacyCreateDocument: false
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

  it("fails closed when a frontmatter id collides with another root's document", async () => {
    // Root names are short words ("vault", "ops"), and Obsidian notes carry
    // custom frontmatter ids, so a vault note with `id: "ops:secret"` and an
    // `ops` root holding `secret.md` are two live readings of one reference.
    //
    // This used to resolve id-first, deliberately: preferring the PATH would
    // return the ops document for a citation that carried the vault note's id —
    // a silently-wrong RAG citation. That reasoning still holds, which is why
    // the INV-2 fix is NOT path-first (the scan's recommendation (a), rejected).
    // But the id half is untrusted vault content, so preferring it silently is
    // equally a guess. Both readings are refused instead: the loud failure is
    // the point, and the unambiguous handle below still works.
    await fs.writeFile(
      path.join(vaultRoot, "collide.md"),
      '---\nid: "ops:secret"\ntitle: Vault Collide\n---\n\nVAULTCOLLIDEBODY\n',
      "utf8"
    );
    await fs.writeFile(path.join(opsRoot, "secret.md"), "---\ntitle: Ops Secret\n---\n\nOPSSECRETBODY\n", "utf8");

    // search still emits the colliding id for the vault note...
    const hit = (await store.search({ query: "VAULTCOLLIDEBODY" })).results.find((r) => r.id === "ops:secret");
    expect(hit?.title).toBe("Vault Collide");

    // ...but fetching it names both readings rather than picking one.
    await expect(store.fetch("ops:secret")).rejects.toThrow(/Ambiguous document reference/);
    await expect(store.fetch("ops:secret")).rejects.toThrow(/vault:collide\.md.*ops:secret\.md/);

    // Here both exact paths happen to be unclaimed, so both documents stay
    // reachable. That is a property of THIS collision, not a general guarantee —
    // a frontmatter id can be a path, and knowledgeStore.test.ts pins the case
    // where a squatted path leaves its victim with no handle at all.
    expect((await store.fetch("vault:collide.md")).body).toContain("VAULTCOLLIDEBODY");
    expect((await store.fetch("ops:secret.md")).title).toBe("Ops Secret");
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

  // Asserting the CLASS says nothing about what was handed to it. The recency
  // defaults reached MultiRootStore and not the single-root KnowledgeStore for
  // as long as that branch existed, and every deployment of this server runs
  // one root — so the live config flag was dead exactly where it was used, and
  // the suite stayed green because the only recency test builds a
  // KnowledgeStore directly and never goes through createStore.
  it("carries the operator recency defaults through createStore's single-root branch", async () => {
    const recencyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-recency-"));
    // Same body, neither filename nor title carrying the query term, so the TEXT
    // scores tie and recency is the only thing that can separate them.
    // `updated_at` rather than mtime: effectiveTimestamp prefers frontmatter,
    // and mtime is what a checkout rewrites. QUOTE the timestamps — bare ISO
    // scalars come back from js-yaml as Date objects, and the scorer only reads
    // `updated_at` when it is a string, so unquoted values fall through to mtime
    // and both notes end up equally "recent".
    await fs.writeFile(
      path.join(recencyRoot, "alpha.md"),
      '---\ntitle: Alpha\nupdated_at: "2020-01-01T00:00:00.000Z"\n---\n\nshared recencyprobe marker\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(recencyRoot, "beta.md"),
      '---\ntitle: Beta\nupdated_at: "2026-08-01T00:00:00.000Z"\n---\n\nshared recencyprobe marker\n',
      "utf8"
    );

    const store = createStore({
      ...makeConfig([{ name: "vault", path: recencyRoot }]),
      // Weights are clamped to <= 1, so asking for more than that would silently
      // test the same thing as 1.
      searchRecencyWeight: 1,
      searchRecencyHalfLifeDays: 30
    });
    await store.init();

    const { results } = await store.search({ query: "recencyprobe", explain: true });
    expect(results).toHaveLength(2);
    expect(results[0].path).toBe("beta.md");
    expect(results[1].path).toBe("alpha.md");

    // The ordering flip alone would be satisfied by anything that reorders ties,
    // so pin the SIGNAL instead: a recency term that separates the two notes can
    // only come from a weight that survived the trip through createStore. With
    // the weight dropped, `recencyWeight > 0` is false and BOTH breakdowns stay
    // at 0 — equal, not merely small. Comparing them rather than checking an
    // absolute value also keeps this stable as the fixture dates age.
    const recencyOf = (index: number) => results[index].score_breakdown?.recency ?? 0;
    expect(recencyOf(0)).toBeGreaterThan(recencyOf(1));
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  // Same failure mode as the recency defaults above, one field later. The cache
  // bound is only reachable through these two construction sites, and the
  // single-root branch is the one every real deployment takes — so a field wired
  // into the composite and forgotten here would be dead in production while the
  // suite stayed green, which is exactly what #112 was.
  it("carries the parse-cache bound through createStore's single-root branch", async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-cachewire-"));
    const body = "z".repeat(1_000_000);
    await fs.writeFile(path.join(cacheRoot, "one.md"), `---\ntitle: One\n---\n\n${body}\n`, "utf8");
    await fs.writeFile(path.join(cacheRoot, "two.md"), `---\ntitle: Two\n---\n\n${body}\n`, "utf8");

    const store = createStore({
      ...makeConfig([{ name: "vault", path: cacheRoot }]),
      knowledgeRoots: [{ name: "vault", path: cacheRoot }],
      scanConcurrency: 1,
      // Far below what these two notes retain, so a bound that arrived must
      // evict — and a bound that was dropped cannot.
      documentCacheMaxChars: 2_500_000
    });
    await store.init();

    let opens = 0;
    const realOpen = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => {
      opens += 1;
      return realOpen(...args);
    });
    try {
      await store.listDocuments();
      opens = 0;
      await store.listDocuments();
    } finally {
      spy.mockRestore();
      await fs.rm(cacheRoot, { recursive: true, force: true });
    }

    // Both notes re-read: the second insertion of each pass evicts the first.
    // Without the bound reaching this store the default applies, both fit, and
    // this is 0.
    expect(opens).toBe(2);
  });

  // The review on #118 read the per-instance warning flag as a bug against the
  // "once per process" wording. The wording was what was wrong: one store per
  // root means one budget per root, so two roots overflowing are two decisions
  // for the operator, and deduplicating across the process would drop every one
  // after the first. What the objection correctly identified is that the lines
  // were INDISTINGUISHABLE — so they now name their root, and this pins both
  // halves: one line per overflowing root, each identifiable.
  it("warns once per overflowing ROOT, naming which one", async () => {
    const alpha = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-warn-alpha-"));
    const beta = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-warn-beta-"));
    const body = "z".repeat(1_000_000);
    for (const dir of [alpha, beta]) {
      await fs.writeFile(path.join(dir, "one.md"), `---\ntitle: One\n---\n\n${body}\n`, "utf8");
      await fs.writeFile(path.join(dir, "two.md"), `---\ntitle: Two\n---\n\n${body}\n`, "utf8");
    }

    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write);
    try {
      const store = createStore({
        ...makeConfig([
          { name: "alpha", path: alpha },
          { name: "beta", path: beta }
        ]),
        knowledgeRoots: [
          { name: "alpha", path: alpha },
          { name: "beta", path: beta }
        ],
        scanConcurrency: 1,
        documentCacheMaxChars: 2_500_000
      });
      await store.init();
      await store.listDocuments();
      await store.listDocuments();
    } finally {
      spy.mockRestore();
      await fs.rm(alpha, { recursive: true, force: true });
      await fs.rm(beta, { recursive: true, force: true });
    }

    const lines = written.filter((line) => line.includes("parse cache is smaller"));
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes('for root "alpha"'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('for root "beta"'))).toHaveLength(1);
    // The name is an operator-chosen label, already visible to clients as an
    // id prefix. The path is not, and must not appear.
    for (const line of lines) {
      expect(line).not.toContain(alpha);
      expect(line).not.toContain(beta);
    }
  });

  it("searches across every root and labels hits with their root", async () => {
    const { results } = await store.search({ query: "retrieval" });
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

  it("plans and applies exact-path creates only on the primary root", async () => {
    const plan = await store.planDocumentCreate({
      relative_path: "vault:reports/exact.md",
      title: "Exact",
      body: "# Exact\n\nMulti-root create.",
      reason: "multi-root exact create"
    });

    expect(plan.target_path).toBe("vault:reports/exact.md");
    expect(plan.diff).toContain("+++ vault:reports/exact.md");
    expect(plan.confirmation.question).toContain("vault:reports/exact.md");
    await expect(store.applyPlannedDocumentCreate(plan.patch_id, "reports/exact.md")).rejects.toThrow(/does not match/);
    const applied = await store.applyPlannedDocumentCreate(plan.patch_id, "vault:reports/exact.md");
    expect(applied.document.relativePath).toBe("vault:reports/exact.md");
    expect(applied.diff).toContain("+++ vault:reports/exact.md");
    await expect(fs.stat(path.join(vaultRoot, "reports/exact.md"))).resolves.toBeTruthy();

    await expect(
      store.planDocumentCreate({
        relative_path: "ops:reports/blocked.md",
        title: "Blocked",
        body: "blocked",
        reason: "read-only root"
      })
    ).rejects.toThrow(/read-only/);
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

  it("does not let a primary-root squatter capture an update aimed at a read-only root", async () => {
    // fetch() refuses this collision at the composite level, but planUpdate
    // delegates straight to the primary store, which sees only its own root and
    // therefore cannot see a cross-root collision at all. Without routing
    // planUpdate through the composite resolver, an update aimed at the ops
    // document silently stages against the primary-root file that claimed its path.
    await fs.mkdir(path.join(opsRoot, "notes"), { recursive: true });
    await fs.writeFile(
      path.join(opsRoot, "notes", "policy.md"),
      "---\ntitle: Ops Policy\n---\n\nGENUINEPOLICYBODY\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(vaultRoot, "squat.md"),
      "---\nid: notes/policy.md\ntitle: Ops Policy\n---\n\nSQUATTERBODY\n",
      "utf8"
    );

    await expect(store.fetch("notes/policy.md")).rejects.toThrow(/Ambiguous document reference/);
    await expect(
      store.planUpdate({ id_or_path: "notes/policy.md", new_body: "captured", reason: "cross-root capture" })
    ).rejects.toThrow(/Ambiguous document reference/);
  });

  it("reserves the primary root's Skills subtree against general writes (INV-8)", async () => {
    // The Skills reservation is primary-root-relative and must survive the
    // composite: a Skill stays readable, but the general write surface cannot
    // rewrite the instructions a later agent session loads.
    const skillPath = path.join(vaultRoot, "knowledge", "skills", "demo-skill", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    const skillMd = "---\nname: demo-skill\ndescription: demo\n---\n\nbody\n";
    await fs.writeFile(skillPath, skillMd, "utf8");
    const reserved = new MultiRootStore({
      ...makeConfig([
        { name: "vault", path: vaultRoot },
        { name: "ops", path: opsRoot }
      ]),
      skillsSubdir: "knowledge/skills"
    });
    await reserved.init();

    await expect(
      reserved.planUpdate({
        id_or_path: "vault:knowledge/skills/demo-skill/SKILL.md",
        new_body: "hijacked",
        reason: "x"
      })
    ).rejects.toThrow(/reserved/);
    expect(await fs.readFile(skillPath, "utf8")).toBe(skillMd);
    // Still readable through the composite.
    expect((await reserved.fetch("vault:knowledge/skills/demo-skill/SKILL.md")).body).toContain("body");
  });

  it("traces sources through the root prefix", async () => {
    const traced = await store.traceSources("ops:logs/session.md");
    expect(traced.document.relativePath).toBe("ops:logs/session.md");
  });

  it("computes same-root backlinks through the composite", async () => {
    // fixture: shared-search.md links to the plan as a relative Markdown link
    // inside the vault root, which only matches once resolved against the
    // linking note's own directory — and must not leak into the other root.
    const traced = await store.traceSources("claude-plan-001");
    expect(traced.backlinks).toEqual([
      expect.objectContaining({
        id: "chatgpt-research-001",
        relativePath: "vault:projects/chatgpt/research/shared-search.md"
      })
    ]);
  });

  it("refuses a title match through the composite too, and names the candidate", async () => {
    // P2-D0 is a property of the resolver, so it has to hold on both stores —
    // "one of them is right" has never been evidence about the other here.
    // connector-plan.md points at shared-search.md by its frontmatter title.
    const traced = await store.traceSources("chatgpt-research-001");
    expect(traced.backlinks).toEqual([]);

    const plan = await store.traceSources("claude-plan-001");
    const link = plan.resolved_outgoing.find((candidate) => candidate.raw === "Shared Search Framework");
    expect(link?.resolved).toBe(false);
    expect(link?.candidates).toEqual([
      {
        id: "chatgpt-research-001",
        path: "vault:projects/chatgpt/research/shared-search.md",
        title: "Shared Search Framework",
        via: "title"
      }
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
