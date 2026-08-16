import crypto from "node:crypto";
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

  it("accepts realistic machine-generated frontmatter (session-archive index, 90 source_refs)", () => {
    // Was 900 refs (66.2 KiB of frontmatter) until the block-size cap landed.
    // 900 is now refused — see "refuses a frontmatter block over the cap" below,
    // which pins that as the intended outcome rather than a regression.
    const parsed = parseMarkdownSafe(sessionArchiveNote(90));

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.frontmatter.source_refs).toHaveLength(90);
    expect(parsed.frontmatter.tags).toHaveLength(7);
    expect(parsed.frontmatter.id).toBe("cc-session-index-2026-08");
    expect(parsed.frontmatter.client).toBe("claude-code");
  });

  it("refuses a frontmatter block over the cap, and says how big it was", () => {
    // 900 refs is 66.2 KiB of frontmatter. It parses in ~14 ms because its line
    // starts fail the comment regex immediately — but the cap cannot tell a
    // benign 66 KiB block from a hostile one, and a hostile block that size costs
    // ~3 s. The cap is the price of not having to make that distinction.
    const parsed = parseMarkdownSafe(sessionArchiveNote(900));

    expect(parsed.parseError).toMatch(/Frontmatter block is \d+ bytes, over the 8192-byte limit/);
    expect(parsed.frontmatter.source_refs).toEqual([]);
    // Degrades like any other malformed frontmatter: the body still indexes.
    expect(parsed.body).toContain("ZZARCHIVEBODY");
  });

  it("refuses an unterminated frontmatter block — the worst case — without parsing it", () => {
    // gray-matter falls back to treating the WHOLE file as the block when the
    // closing delimiter is missing (`if (closeIndex === -1) closeIndex = len`),
    // which is how 391 KB of line starts became a 102-second block. The guard has
    // to catch this before matter() runs, so assert BOTH the refusal and that it
    // returned fast: without the cap this call alone takes minutes.
    const payload = `---\n${"\n".repeat(400_000)}`;

    const started = Date.now();
    const parsed = parseMarkdownSafe(payload);
    const elapsed = Date.now() - started;

    expect(parsed.parseError).toMatch(/no closing delimiter/);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("refuses the same block behind a UTF-8 BOM, which gray-matter strips before looking", () => {
    // gray-matter normalizes with strip-bom-string BEFORE parseMatter tests for
    // `---`, so a file opening U+FEFF `---` IS frontmatter to it. A guard on the RAW
    // prefix skipped exactly that file and handed the whole quadratic path back:
    // measured at 32 KiB, 0.3 ms refused without the BOM against 1,129.6 ms
    // parsed with it. Time is the assertion again — a version that refused for
    // some other reason, or refused only after parsing, would still "throw".
    const payload = `\uFEFF---\n${"\n".repeat(400_000)}`;

    const started = Date.now();
    const parsed = parseMarkdownSafe(payload);
    const elapsed = Date.now() - started;

    expect(parsed.parseError).toMatch(/no closing delimiter/);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("measures the block in UTF-8 bytes, not UTF-16 code units", () => {
    // The constant, the error and the docs all say bytes. Comparing
    // `String.length` counted code units instead, so a CJK block passed at three
    // times the stated limit. Bytes are not what drives the cost — 8,192 code
    // units of newlines cost 76.11 ms against 0.88 ms for 8,192 CJK characters
    // (24,568 bytes) — but a limit that does not mean what it says is a limit
    // nobody can reason about.
    const note = (chars: number): string => `---\ntitle: ${"あ".repeat(chars)}\n---\n\nbody\n`;

    // 3,000 CJK characters: 3,011 code units — comfortably under the cap by the
    // old comparison — but 9,011 bytes, over it. This pair is the whole test:
    // any payload where both units agree cannot tell them apart.
    const over = note(3_000);
    expect(over.length).toBeLessThan(8_192);
    expect(parseMarkdownSafe(over).parseError).toMatch(/over the 8192-byte limit/);

    // 2,000 of the same characters: 6,011 bytes, still legal. Without this the
    // test would also pass if the guard simply rejected all CJK.
    expect(parseMarkdownSafe(note(2_000)).parseError).toBeUndefined();
  });

  it("still parses a legitimate BOM-prefixed note", () => {
    // The fix must not turn every BOM-prefixed note into a parse error: editors
    // on Windows write them, and gray-matter reads them fine.
    const parsed = parseMarkdownSafe("\uFEFF---\ntitle: BOM note\n---\n\nbody\n");

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.frontmatter.title).toBe("BOM note");
    expect(parsed.body).toContain("body");
  });

  it("strips one BOM and no more, because gray-matter strips one", () => {
    // strip-bom-string removes a single leading U+FEFF. A second one means
    // gray-matter never sees a delimiter at all, so the file has no block —
    // measuring it anyway would reject notes that were never a risk. Verified
    // against gray-matter directly: a doubled BOM yields matter.length 0.
    const parsed = parseMarkdownSafe(`\uFEFF\uFEFF---\n${"\n".repeat(400_000)}`);

    expect(parsed.parseError).toBeUndefined();
  });

  it("does not measure a note that has no frontmatter at all", () => {
    // The cap applies to the BLOCK, not to the file. A note that never opens with
    // the delimiter has no block for gray-matter to scan, so it must stay legal at
    // any size — otherwise the guard would reject ordinary long documents.
    const parsed = parseMarkdownSafe(`# Long note\n\n${"lorem ipsum dolor sit amet\n".repeat(20_000)}`);

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.body).toContain("lorem ipsum");
  });

  it("accepts a large flow-style tag list (the worst-amplifying legitimate shape)", () => {
    // 2,000 rather than 5,000 entries: what this pins is the AMPLIFICATION RATIO
    // of the shape, which does not depend on how many entries there are, and
    // 5,000 would now exceed the block-size cap for an unrelated reason.
    const parsed = parseMarkdownSafe(
      `---\ntitle: Tagged\ntags: [${Array.from({ length: 2000 }, () => "a").join(",")}]\n---\n\nbody\n`
    );

    expect(parsed.parseError).toBeUndefined();
    expect(parsed.frontmatter.tags).toHaveLength(2000);
  });

  // The budget must come from `raw` itself. gray-matter caches parses by content
  // and returns `Object.assign({}, cached)`, which DROPS its non-enumerable
  // `matter` property — so a budget derived from `parsed.matter` silently
  // collapses to the floor on every repeat parse of identical content and
  // strips the metadata off large but legitimate notes.
  it("returns identical results when the same content is parsed twice (gray-matter content cache)", () => {
    const raw = sessionArchiveNote(90);

    const first = parseMarkdownSafe(raw);
    const second = parseMarkdownSafe(raw);

    expect(second).toEqual(first);
    expect(second.parseError).toBeUndefined();
    expect(second.frontmatter.source_refs).toHaveLength(90);
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
    // 2,000 rather than 20,000 repeats, to stay under the block-size cap while
    // still separating the two accountings: 32 references x 6 chars per escaped
    // control character is ~384 KB (over the 64 KiB floor, so the correct
    // accounting throws), while charging in-memory length gives 32 x 2,000 =
    // 64,000 — under the floor, so the wrong accounting would NOT throw.
    const scalar = '"' + "\\0".repeat(2_000) + '"';
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
    const note = sessionArchiveNote(90);
    const first = path.join(root, "archive-a.md");
    const second = path.join(root, "archive-b.md");
    await fs.writeFile(first, note, "utf8");
    await fs.writeFile(second, note, "utf8");

    const a = await store.fetch("archive-a.md");
    const b = await store.fetch("archive-b.md");
    for (const document of [a, b]) {
      expect(document.frontmatter.source_refs).toHaveLength(90);
      expect(document.frontmatter.client).toBe("claude-code");
      expect(document.title).toBe("Session archive index");
    }

    // Re-read the same bytes after only the mtime moved (busts the store's
    // mtime+size cache, so the content is parsed again).
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(first, future, future);
    const reread = await store.fetch("archive-a.md");
    expect(reread.frontmatter.source_refs).toHaveLength(90);
    expect(reread.frontmatter.id).toBe("cc-session-index-2026-08");
    expect(reread.title).toBe("Session archive index");
  });
});

describe("a write may not emit a note the read path will refuse (INV-2, write side)", () => {
  let root: string;
  let patchStateDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fm-emit-"));
    patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fm-emitpatch-"));
    store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(patchStateDir, { recursive: true, force: true });
  });

  /** Allowlisted key, correct value type — INV-2 has nothing to object to. */
  const hugeTagPatch = { tags: Array.from({ length: 4000 }, (_, index) => `tag-${index}`) };

  it("refuses at PLAN time, so the target is untouched and no approved diff is shown", async () => {
    await fs.writeFile(path.join(root, "note.md"), "---\ntitle: Keep Me\n---\n\nbody\n", "utf8");
    const before = await fs.readFile(path.join(root, "note.md"), "utf8");

    await expect(
      store.planUpdate({
        id_or_path: "note.md",
        new_body: "body\n",
        frontmatter_patch: hugeTagPatch,
        reason: "oversize"
      })
    ).rejects.toThrow(/Refusing to write.*over the 8192-byte limit/s);

    // Rejecting at plan rather than apply is the point: apply-time refusal would
    // stop only AFTER the user had been shown a diff to approve. Same placement
    // reason as INV-8's validateFileSet.
    expect(await fs.readFile(path.join(root, "note.md"), "utf8")).toBe(before);
    expect(await fs.readdir(patchStateDir)).toHaveLength(0);
  });

  it("blocks the create paths too, leaving no note behind", async () => {
    await expect(
      store.createDocument({
        client: "acme",
        project: "p",
        title: "T",
        body: "b\n",
        tags: hugeTagPatch.tags
      })
    ).rejects.toThrow(/Refusing to write/);

    await expect(
      store.planDocumentCreate({
        relative_path: "projects/new.md",
        client: "acme",
        project: "p",
        title: "T",
        body: "b\n",
        tags: hugeTagPatch.tags,
        reason: "oversize"
      })
    ).rejects.toThrow(/Refusing to write/);

    // The guard sits in serializeMarkdown, the one function all three writers
    // pass through, so this is coverage of the choke rather than of three
    // separate call sites — and a fourth writer inherits it.
    //
    // Asserted on NOTES, not on directory entries: `createDocument` creates the
    // routed parent before it serializes, so a refusal leaves an empty directory
    // behind. That is cosmetic — no content, no metadata, nothing a later read
    // can return — and claiming "no file behind" would have been false. Moving
    // the check ahead of the mkdir would tidy it at the cost of validating in a
    // second place, which is the trade this guard's placement exists to avoid.
    const notesUnderRoot = async (dir: string): Promise<string[]> => {
      const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
    };
    expect(await notesUnderRoot(root)).toHaveLength(0);
  });

  it("is what stops a note from becoming unreadable AND unrepairable", async () => {
    // The shape being prevented, written out by hand: bytes on disk whose
    // frontmatter block is over the cap. This is what the write path used to
    // produce, and it is reachable only by bypassing the writer now.
    const oversized = `---\ntitle: Doomed\nid: doomed-uuid\ntags:\n${hugeTagPatch.tags
      .map((tag) => `  - ${tag}`)
      .join("\n")}\n---\n\nSTILLINDEXED\n`;
    await fs.writeFile(path.join(root, "doomed.md"), oversized, "utf8");

    // Read degrades: the note is still returned (read has that obligation), but
    // body-only — its title falls back to the basename and its frontmatter id is
    // gone, moving its identity to its path, which is the handle INV-2 says
    // content can squat.
    const degraded = await store.fetch("doomed.md");
    expect(degraded.title).toBe("doomed");
    expect(degraded.frontmatter.id).toBeUndefined();
    expect((await store.search({ query: "STILLINDEXED" })).results).toHaveLength(1);

    // ...and it cannot be repaired through this server, because planUpdate parses
    // with parseMarkdown, which refuses exactly this input. Writing the note was
    // the only reversible moment, which is why the guard is on the write.
    await expect(store.planUpdate({ id_or_path: "doomed.md", new_body: "fixed\n", reason: "repair" })).rejects.toThrow(
      /over the 8192-byte limit/
    );
  });

  it("still writes frontmatter that is merely large (the false-positive direction)", async () => {
    await fs.writeFile(path.join(root, "ok.md"), "---\ntitle: Fine\n---\n\nbody\n", "utf8");
    const plan = await store.planUpdate({
      id_or_path: "ok.md",
      new_body: "body\n",
      // ~4 KiB of tags: comfortably under the cap, and above anything the real
      // vault holds (measured median 225 B, max 1,042 B).
      frontmatter_patch: { tags: Array.from({ length: 300 }, (_, index) => `t-${index}`) },
      reason: "large but legal"
    });
    const applied = await store.applyPlannedUpdate(plan.patch_id);
    expect(applied.document.frontmatter.tags).toHaveLength(300);
    expect((await store.fetch("ok.md")).frontmatter.tags).toHaveLength(300);
  });
});

describe("apply re-checks the cap, so a stale plan cannot carry a write past it", () => {
  let root: string;
  let patchStateDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fm-stale-"));
    patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fm-stalepatch-"));
    store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
    await store.init();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(patchStateDir, { recursive: true, force: true });
  });

  const oversizedContent = (title: string): string => {
    const tags = Array.from({ length: 4000 }, (_, index) => `  - tag-${index}`).join("\n");
    return `---\ntitle: ${title}\ntags:\n${tags}\n---\n\nbody\n`;
  };

  /**
   * Stage a plan the way a server WITHOUT the emit cap would have: by writing
   * the patch file directly. Going through planUpdate is impossible now, which
   * is the whole point — the bytes predate the guard, and nothing expires them.
   */
  async function stagePlanFile(patch: Record<string, unknown>): Promise<string> {
    const patchId = crypto.randomUUID();
    await fs.writeFile(path.join(patchStateDir, `${patchId}.json`), JSON.stringify({ ...patch, patch_id: patchId }));
    return patchId;
  }

  it("refuses an update whose staged content predates the guard", async () => {
    const before = "---\ntitle: Keep Me\n---\n\nbody\n";
    await fs.writeFile(path.join(root, "note.md"), before, "utf8");
    const patchId = await stagePlanFile({
      target_path: "note.md",
      reason: "staged by an older server",
      expected_sha256: crypto.createHash("sha256").update(before).digest("hex"),
      created_at: new Date().toISOString(),
      new_content: oversizedContent("Doomed"),
      diff: "(elided)"
    });

    await expect(store.applyPlannedUpdate(patchId)).rejects.toThrow(/Refusing to write.*over the 8192-byte limit/s);
    // The note is untouched, and still readable — the failure mode being closed
    // is "the vault now holds a note this server cannot parse or repair".
    expect(await fs.readFile(path.join(root, "note.md"), "utf8")).toBe(before);
    expect((await store.fetch("note.md")).frontmatter.title).toBe("Keep Me");
  });

  it("refuses an exact-path create whose staged content predates the guard", async () => {
    const content = oversizedContent("New");
    const patchId = await stagePlanFile({
      operation: "document_create",
      target_path: "projects/new.md",
      reason: "staged by an older server",
      content_sha256: crypto.createHash("sha256").update(content).digest("hex"),
      created_at: new Date().toISOString(),
      new_content: content,
      diff: "(elided)"
    });

    await expect(store.applyPlannedDocumentCreate(patchId, "projects/new.md")).rejects.toThrow(/Refusing to write/);
    await expect(fs.readFile(path.join(root, "projects", "new.md"), "utf8")).rejects.toThrow();
  });

  it("still applies a staged plan whose frontmatter is within the cap", async () => {
    // The false-positive direction: re-checking at apply must not break the
    // ordinary path, where the same bytes already passed at plan time.
    await fs.writeFile(path.join(root, "ok.md"), "---\ntitle: Fine\n---\n\nbody\n", "utf8");
    const plan = await store.planUpdate({
      id_or_path: "ok.md",
      new_body: "rewritten\n",
      frontmatter_patch: { tags: ["a", "b"] },
      reason: "normal edit"
    });
    const applied = await store.applyPlannedUpdate(plan.patch_id);
    expect(applied.document.body.trim()).toBe("rewritten");
    expect(applied.document.frontmatter.tags).toEqual(["a", "b"]);
  });
});
