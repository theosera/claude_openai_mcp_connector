import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeMetadata, parseMarkdown, parseMarkdownSafe, serializeMarkdown } from "../src/frontmatter.js";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { toPublicDocument } from "../src/server.js";

const MARKER = "__grayMatterFrontmatterExecuted__";

/**
 * gray-matter honours a language tag after the opening delimiter and hands the
 * block to the matching engine; its bundled `javascript` engine parses with a
 * raw eval(). The payload writes a marker onto globalThis, so the assertions can
 * pin NON-EXECUTION rather than "something threw" — the unpatched write path
 * evaluates the block first and only then throws "stringifying JavaScript is not
 * supported", which would satisfy a mere `toThrow()`.
 *
 * `body` keeps each payload textually distinct: gray-matter memoizes parses by
 * content in a module-global cache, so a payload reused across tests could be
 * served from that cache and look harmless.
 */
function executablePayload(languageTag: string, body = "vault body"): string {
  return `---${languageTag}\nglobalThis[${JSON.stringify(MARKER)}] = "executed";\n---\n\n${body}\n`;
}

function markerValue(): unknown {
  return (globalThis as unknown as Record<string, unknown>)[MARKER];
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)[MARKER];
});

describe("executable front matter is never evaluated", () => {
  // Lower-casing happens inside gray-matter's engine lookup, so these two keys
  // cover every spelling of the JavaScript engine.
  const LANGUAGE_TAGS = ["js", "javascript", "JavaScript"];

  it("refuses a `---js` block on the read path instead of eval'ing it", () => {
    for (const tag of LANGUAGE_TAGS) {
      expect(() => parseMarkdown(executablePayload(tag, `read path ${tag}`))).toThrow(/Executable front matter/);
      expect(markerValue()).toBeUndefined();
    }
  });

  it("degrades a poisoned document the way malformed YAML already does", () => {
    for (const tag of LANGUAGE_TAGS) {
      const raw = executablePayload(tag, `degraded read path ${tag}`);
      const parsed = parseMarkdownSafe(raw);

      expect(markerValue()).toBeUndefined();
      expect(parsed.parseError).toBeDefined();
      expect(parsed.body).toBe(raw); // raw body kept, so the note stays searchable
      expect(parsed.frontmatter).toEqual({ tags: [], source_refs: [] });
    }
  });

  it("keeps one poisoned note from aborting search / list for the whole vault", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-frontmatter-vault-"));
    const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-frontmatter-patches-"));
    await fs.writeFile(path.join(root, "poisoned.md"), executablePayload("js", "ZZPOISONEDBODY"), "utf8");
    await fs.writeFile(path.join(root, "good.md"), "---\ntitle: Good\n---\n\nZZGOODBODY retrieval notes\n", "utf8");

    const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();

    await expect(store.listDocuments()).resolves.toHaveLength(2);
    expect((await store.search({ query: "ZZGOODBODY" })).results.map((result) => result.path)).toEqual(["good.md"]);
    expect(markerValue()).toBeUndefined();
  });

  it("refuses a `---js` prefix in a client-supplied body on the write path", () => {
    const body = executablePayload("js", "write path body");
    const output = serializeMarkdown({ id: "note-001", updated_at: "2026-01-01T00:00:00.000Z" }, body);
    const reparsed = parseMarkdown(output);

    expect(markerValue()).toBeUndefined();
    // The body is written through verbatim, never promoted into front matter.
    expect(reparsed.body).toBe(body);
    expect(Object.keys(reparsed.frontmatter)).toEqual(["id", "updated_at", "tags", "source_refs"]);
  });
});

describe("the frontmatter allowlist survives a body that starts with a YAML block", () => {
  it("does not merge body-derived keys into the written front matter", () => {
    const body = "---\nrole: admin\ndate: 2026-01-01\ntype: system\nid: forged\n---\n\nreal body\n";
    const metadata = { id: "note-001", title: "Real title", updated_at: "2026-01-01T00:00:00.000Z" };

    const output = serializeMarkdown(metadata, body);
    const reparsed = parseMarkdown(output);

    // Key set is exactly the server-computed metadata: no `role` / `date` /
    // `type` smuggled in past assertFrontmatterPatch.
    expect(Object.keys(reparsed.frontmatter)).toEqual(["id", "title", "updated_at", "tags", "source_refs"]);
    expect(reparsed.frontmatter.id).toBe("note-001");
    expect(reparsed.frontmatter.title).toBe("Real title");
    // The block stays where the client put it — inside the body.
    expect(reparsed.body).toBe(body);
  });
});

describe("front matter regression baselines", () => {
  it("parses ordinary YAML front matter unchanged", () => {
    const parsed = parseMarkdown("---\ntitle: T\ntags: [a, b]\n---\n\nhello\n");

    expect(parsed.frontmatter.title).toBe("T");
    expect(parsed.frontmatter.tags).toEqual(["a", "b"]);
    expect(parsed.body).toBe("\nhello\n");
    expect(serializeMarkdown(parsed.frontmatter, parsed.body)).toContain("title: T");
  });

  it("round-trips a document whose front matter carries a `__proto__` key", async () => {
    // js-yaml blocks prototype pollution by defining `__proto__` with
    // Object.defineProperty, so it lands as an OWN ENUMERABLE key; gray-matter's
    // Object.assign copy then silently drops it ([[Set]] semantics). Nothing may
    // treat that asymmetry as an error — such a note must stay editable.
    const raw = "---\nid: proto-001\ntitle: Proto\n__proto__:\n  polluted: yes\n---\n\nproto body\n";
    const parsed = parseMarkdown(raw);

    expect(Object.keys(parsed.frontmatter)).toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => serializeMarkdown(parsed.frontmatter, parsed.body)).not.toThrow();

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-frontmatter-vault-"));
    const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-frontmatter-patches-"));
    await fs.writeFile(path.join(root, "proto.md"), raw, "utf8");
    const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();

    const plan = await store.planUpdate({ id_or_path: "proto.md", new_body: "updated body\n", reason: "edit" });
    const applied = await store.applyPlannedUpdate(plan.patch_id);

    expect(applied.document.body.trim()).toBe("updated body");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/**
 * A billion-laughs style YAML bomb: js-yaml resolves every `*aN` as a shared
 * reference, so this parses in microseconds while describing 7^8 (~5.8M) leaves.
 * Deliberately sized so that a REGRESSION (guard removed) still terminates —
 * it would materialize ~40 MB and fail the assertions instead of OOM-ing the
 * whole test run — while remaining far past any budget the guard grants it.
 */
function aliasBomb(key: string, levels = 8, fan = 7): string {
  const lines = [`a0: &a0 [${Array.from({ length: fan }, () => '"lol"').join(",")}]`];
  for (let level = 1; level < levels; level++) {
    lines.push(`a${level}: &a${level} [${Array.from({ length: fan }, () => `*a${level - 1}`).join(",")}]`);
  }
  lines.push(`${key}: *a${levels - 1}`);
  return `---\n${lines.join("\n")}\n---\n\nZZBOMBBODY marker\n`;
}

/**
 * The shape this repository's own session-archive hook writes
 * (.claude/skills/session-archive/archive-session.sh), plus the `source_refs`
 * index a roll-up note accumulates. No anchors, no aliases — this must always
 * survive intact, on the first parse and on every repeat parse.
 */
function sessionArchiveNote(sourceRefCount: number, tagCount = 6): string {
  const uuid = (n: number) => `528b32e9-6206-4102-a82b-a506f644${String(n).padStart(4, "0")}`;
  const tags = Array.from({ length: tagCount }, (_, i) => `repo-name-${i}`).join(", ");
  const refs = Array.from({ length: sourceRefCount }, (_, i) => `  - sessions/2026-08-04/cc-session-${uuid(i)}.md`);
  return [
    "---",
    "id: cc-session-index-2026-08",
    'title: "Session archive index"',
    "client: claude-code",
    "project: claude_openai_mcp_connector",
    "date: 2026-08-04",
    'branch: "claude/session-archive"',
    `session_id: ${uuid(1)}`,
    "repos: [claude_openai_mcp_connector, obsidian-ai-pipeline, terminal-ops-logs]",
    `tags: [claude-code-session, ${tags}]`,
    "updated_at: 2026-08-04T03:35:02Z",
    "source_refs:",
    ...refs,
    "---",
    "",
    "# Session archive index",
    "",
    "ZZARCHIVEBODY marker",
    ""
  ].join("\n");
}

describe("frontmatter YAML anchor/alias expansion guard", () => {
  it("degrades a note whose `tags` are an alias bomb instead of expanding them", () => {
    const raw = aliasBomb("tags");
    const started = Date.now();
    const parsed = parseMarkdownSafe(raw);
    const elapsedMs = Date.now() - started;

    // Refused by the budget check — not by an accidental RangeError from
    // String() after the expansion already ran.
    expect(parsed.parseError).toMatch(/expands to more than/);
    // Degraded exactly like any other malformed frontmatter: empty metadata,
    // raw body (so the note stays searchable by body/path).
    expect(parsed.frontmatter.tags).toEqual([]);
    expect(parsed.body).toBe(raw);
    // Work is bounded by the budget, not by the expansion.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("refuses the bomb at the parseMarkdown chokepoint", () => {
    expect(() => parseMarkdown(aliasBomb("tags"))).toThrow(/expands to more than/);
  });

  it("degrades a bomb hidden under a non-allowlisted key that fetch_document would JSON.stringify", () => {
    // `note` is not one of the coerced fields, so before the guard this bomb
    // survived normalizeMetadata into the returned document and every
    // fetch_document re-ran the expansion inside JSON.stringify (src/server.ts).
    const parsed = parseMarkdownSafe(aliasBomb("note"));

    expect(parsed.parseError).toMatch(/expands to more than/);
    expect(parsed.frontmatter.note).toBeUndefined();

    const started = Date.now();
    const serialized = JSON.stringify(parsed.frontmatter);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(serialized.length).toBeLessThan(1000);
  });

  it("terminates on a recursive anchor instead of looping or serializing a circular structure", () => {
    const raw = "---\ntags: &recursive\n  - *recursive\n---\n\nZZRECURSIVE marker\n";
    const parsed = parseMarkdownSafe(raw);

    expect(parsed.parseError).toMatch(/expands to more than/);
    expect(parsed.frontmatter.tags).toEqual([]);
    // Before the guard this threw `TypeError: Converting circular structure to
    // JSON` out of fetch_document; now the note simply degrades.
    expect(() => JSON.stringify(parsed.frontmatter)).not.toThrow();
  });

  it("refuses quadratic amplification of one large scalar aliased many times", () => {
    // The reason an alias COUNT cap is not enough: only 200 aliases, but each
    // one materializes 4 KB.
    const raw = `---\nbig: &b "${"x".repeat(4000)}"\nl: [${Array.from({ length: 200 }, () => "*b").join(",")}]\n---\n\nbody\n`;
    expect(parseMarkdownSafe(raw).parseError).toMatch(/expands to more than/);
  });

  it("keeps coercing YAML auto-typed scalars on notes that do not amplify", () => {
    const parsed = parseMarkdownSafe(
      "---\ntitle: Numbered\nclient: 2024\nproject: 2025\ntags: [2024, 3]\n---\n\nbody\n"
    );

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.frontmatter.tags).toEqual(["2024", "3"]);
    expect(parsed.frontmatter.client).toBe("2024");
    expect(parsed.frontmatter.project).toBe("2025");
    expect(normalizeMetadata({ tags: [2024] } as never).tags).toEqual(["2024"]);
    expect(normalizeMetadata({ client: 2024 } as never).client).toBe("2024");
  });

  it("preserves unknown frontmatter keys on notes that do not amplify", () => {
    const parsed = parseMarkdownSafe("---\ntitle: Open\nobsidian_field: kept\nnested:\n  a: 1\n---\n\nbody\n");

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.frontmatter.title).toBe("Open");
    expect((parsed.frontmatter as Record<string, unknown>).obsidian_field).toBe("kept");
    expect((parsed.frontmatter as Record<string, unknown>).nested).toEqual({ a: 1 });
  });

  it("accepts realistic machine-generated frontmatter (session-archive index, 900 source_refs)", () => {
    const parsed = parseMarkdownSafe(sessionArchiveNote(900));

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.frontmatter.source_refs).toHaveLength(900);
    expect(parsed.frontmatter.tags).toHaveLength(7);
    expect(parsed.frontmatter.id).toBe("cc-session-index-2026-08");
    expect(parsed.frontmatter.client).toBe("claude-code");
  });

  it("accepts a large flow-style tag list (the worst-amplifying legitimate shape)", () => {
    const parsed = parseMarkdownSafe(
      `---\ntitle: Tagged\ntags: [${Array.from({ length: 5000 }, () => "a").join(",")}]\n---\n\nbody\n`
    );

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.frontmatter.tags).toHaveLength(5000);
  });

  // The budget must come from `raw` itself. gray-matter caches parses by content
  // and returns `Object.assign({}, cached)`, which DROPS its non-enumerable
  // `matter` property — so a budget derived from `parsed.matter` silently
  // collapses to the floor on every repeat parse of identical content and
  // strips the metadata off large but legitimate notes.
  it("returns identical results when the same content is parsed twice (gray-matter content cache)", () => {
    const raw = sessionArchiveNote(900);

    const first = parseMarkdownSafe(raw);
    const second = parseMarkdownSafe(raw);

    expect(second).toEqual(first);
    expect(second.parseError).toBeUndefined();
    expect(second.frontmatter.source_refs).toHaveLength(900);
    expect(second.frontmatter.title).toBe("Session archive index");
    expect(second.frontmatter.id).toBe("cc-session-index-2026-08");
  });

  it("keeps the verdict stable across repeated parses of a bomb and of a small note", () => {
    const bomb = aliasBomb("tags");
    expect(parseMarkdownSafe(bomb)).toEqual(parseMarkdownSafe(bomb));

    const small = "---\nid: n1\ntitle: Small\ntags: [a, b]\n---\n\nbody\n";
    const first = parseMarkdownSafe(small);
    expect(parseMarkdownSafe(small)).toEqual(first);
    expect(first.frontmatter.tags).toEqual(["a", "b"]);
  });

  // The budget is spent in SERIALIZED characters, so a scalar has to be charged
  // what JSON.stringify emits for it, not what it costs in memory. A control
  // character is two source characters (`\0`) and six emitted ones (`\u0000`),
  // so charging `length` let ~32 references through a 16x budget and serialized
  // to ~96x the source — the same heap-OOM this guard exists to prevent, only
  // bought with a larger file. Charging `length` here makes this test pass a
  // ~96x expansion.
  it("charges a scalar its JSON-escaped size, not its in-memory length", () => {
    const scalar = '"' + "\\0".repeat(20_000) + '"';
    const raw =
      "---\n" + `a: &a ${scalar}\n` + `b: [${Array.from({ length: 31 }, () => "*a").join(",")}]\n` + "---\n\nbody\n";

    expect(() => parseMarkdown(raw)).toThrow(/refusing to materialize/);

    const degraded = parseMarkdownSafe(raw);
    expect(degraded.parseError).toMatch(/refusing to materialize/);
    expect(degraded.body).toBe(raw);
    expect(JSON.stringify(degraded.frontmatter).length).toBeLessThan(1000);
  });

  // The same accounting has to leave legitimate escapes alone: a title with
  // quotes and a multi-line block scalar are charged 2 per escaped character,
  // which is nowhere near the 16x budget.
  it("keeps front matter that legitimately contains quotes, backslashes and newlines", () => {
    const raw =
      "---\n" +
      "id: quoted-1\n" +
      'title: "He said \\"hello\\" and left C:\\\\Users\\\\me"\n' +
      "description: |\n" +
      Array.from({ length: 200 }, (_, i) => `  line ${i} of a block scalar\n`).join("") +
      "tags: [α, 日本語, 👋]\n" +
      "---\n\nbody\n";

    const parsed = parseMarkdownSafe(raw);
    expect(parsed.parseError).toBeUndefined();
    expect(parsed.frontmatter.title).toBe('He said "hello" and left C:\\Users\\me');
    expect(parsed.frontmatter.tags).toEqual(["α", "日本語", "👋"]);
  });
});

describe("KnowledgeStore with expansion-bomb and repeated content", () => {
  let root: string;
  let patchStateDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fm-vault-"));
    patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fm-patches-"));
    store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(patchStateDir, { recursive: true, force: true });
  });

  it("completes a vault walk past a bomb note and still returns the other notes", async () => {
    await fs.writeFile(path.join(root, "bomb-tags.md"), aliasBomb("tags"), "utf8");
    await fs.writeFile(path.join(root, "bomb-other.md"), aliasBomb("note"), "utf8");
    await fs.writeFile(
      path.join(root, "good.md"),
      "---\nid: good-1\nclient: claude\nproject: planning\ntitle: Good\ntags: [mcp]\n---\n\nZZGOODBODY marker\n",
      "utf8"
    );

    // No wall-clock assertion: it would flake on a loaded runner, and the bomb
    // is sized so that a regression still TERMINATES (materializing ~40 MB
    // rather than hanging), which the serialized-size assertion below catches
    // deterministically.
    const { results } = await store.search({ query: "marker" });

    // The scan is not aborted: the healthy note is indexed, and the bomb notes
    // are indexed by body only.
    expect(results.map((r) => r.path)).toContain("good.md");
    expect((await store.search({ query: "ZZBOMBBODY" })).results.map((r) => r.path)).toContain("bomb-tags.md");
    expect((await store.listProjects()).some((p) => p.client === "claude" && p.project === "planning")).toBe(true);

    // fetch_document over a bomb note stays cheap and serializable.
    const fetched = toPublicDocument(await store.fetch("bomb-other.md"));
    expect(JSON.stringify(fetched.frontmatter).length).toBeLessThan(1000);
  });

  it("keeps the metadata of two byte-identical notes, and on a re-read of the same note", async () => {
    const note = sessionArchiveNote(900);
    const first = path.join(root, "archive-a.md");
    const second = path.join(root, "archive-b.md");
    await fs.writeFile(first, note, "utf8");
    await fs.writeFile(second, note, "utf8");

    const a = await store.fetch("archive-a.md");
    const b = await store.fetch("archive-b.md");
    for (const document of [a, b]) {
      expect(document.frontmatter.source_refs).toHaveLength(900);
      expect(document.frontmatter.client).toBe("claude-code");
      expect(document.title).toBe("Session archive index");
    }

    // Re-read the same bytes after only the mtime moved (busts the store's
    // mtime+size cache, so the content is parsed again).
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(first, future, future);
    const reread = await store.fetch("archive-a.md");
    expect(reread.frontmatter.source_refs).toHaveLength(900);
    expect(reread.frontmatter.id).toBe("cc-session-index-2026-08");
    expect(reread.title).toBe("Session archive index");
  });
});
