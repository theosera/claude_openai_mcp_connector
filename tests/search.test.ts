import { describe, expect, it } from "vitest";
import { resolveRelativeLink } from "../src/markdownLinks.js";
import { searchDocuments } from "../src/search.js";
import { normalizeForMatch, normalizeWithMap, toSourceIndex } from "../src/searchText.js";
import type { MarkdownDocument } from "../src/types.js";

function makeDocument(overrides: Partial<MarkdownDocument> & { relativePath: string }): MarkdownDocument {
  return {
    id: overrides.id ?? overrides.relativePath,
    relativePath: overrides.relativePath,
    absolutePath: `/synthetic/root/${overrides.relativePath}`,
    frontmatter: overrides.frontmatter ?? {},
    body: overrides.body ?? "",
    title: overrides.title ?? overrides.relativePath.replace(/\.md$/i, ""),
    ...(overrides.root ? { root: overrides.root } : {}),
    stats: overrides.stats ?? { sizeBytes: 128, modifiedAt: "2026-01-01T00:00:00.000Z" }
  };
}

describe("search normalization (NFKC)", () => {
  it("matches full-width and half-width forms as the same term", () => {
    const documents = [makeDocument({ relativePath: "notes/widths.md", body: "ＭＣＰ コネクタの設計" })];

    // Half-width query against a full-width body — before NFKC folding these
    // were different strings and the note was unfindable.
    expect(searchDocuments(documents, { query: "MCP" }).total_count).toBe(1);
    // ...and the reverse direction folds too.
    expect(
      searchDocuments([makeDocument({ relativePath: "n.md", body: "MCP" })], { query: "ＭＣＰ" }).total_count
    ).toBe(1);
  });

  it("matches a decomposed (NFD) body from a composed (NFC) query", () => {
    // macOS filesystems hand back decomposed text; clients send composed.
    const decomposed = "ガイド".normalize("NFD");
    expect(decomposed).not.toBe("ガイド");
    const documents = [makeDocument({ relativePath: "notes/nfd.md", body: `${decomposed} 本文` })];

    expect(searchDocuments(documents, { query: "ガイド" }).total_count).toBe(1);
  });

  it("splits on a full-width space so a Japanese two-term query still ANDs correctly", () => {
    const documents = [
      makeDocument({ relativePath: "a.md", body: "検索 設計 の話" }),
      makeDocument({ relativePath: "b.md", body: "検索 だけ" })
    ];

    const response = searchDocuments(documents, { query: "検索　設計" });
    // Both notes match "検索"; the one that also has "設計" must rank first.
    expect(response.results[0].path).toBe("a.md");
    expect(response.results[0].score).toBeGreaterThan(response.results[1].score);
  });

  it("leaves plain ASCII scoring unchanged (title 10 / tags 5 / path 4 / body occurrence)", () => {
    const documents = [
      makeDocument({
        relativePath: "notes/retrieval.md",
        title: "Retrieval",
        frontmatter: { tags: ["retrieval"] },
        body: "retrieval retrieval"
      })
    ];

    // 10 (title) + 5 (tag) + 4 (path) + 2 (two body hits) = 21.
    expect(searchDocuments(documents, { query: "retrieval" }).results[0].score).toBe(21);
  });

  it("keeps snippets in the author's own characters and anchors them on the match", () => {
    const body = `${"filler ".repeat(40)}ＴＡＲＧＥＴ ${"tail ".repeat(40)}`;
    const documents = [makeDocument({ relativePath: "wide.md", body })];

    const [result] = searchDocuments(documents, { query: "target" }).results;
    // The snippet is sliced from the original text, so the full-width form is
    // preserved rather than the folded form used for matching.
    expect(result.snippet).toContain("ＴＡＲＧＥＴ");
    expect(result.snippet).not.toContain("TARGET");
    expect(result.snippet.startsWith("...")).toBe(true);
  });
});

describe("normalizeWithMap", () => {
  it("maps folded positions back onto the source string", () => {
    const source = "aＢc";
    const normalized = normalizeWithMap(source);

    expect(normalized.text).toBe("abc");
    expect(source.slice(toSourceIndex(normalized, 1, source.length))).toBe("Ｂc");
  });

  it("composes combining marks so folded length can differ from source length", () => {
    const source = "が"; // か + combining voiced mark => が
    const normalized = normalizeWithMap(source);

    expect(normalized.text).toBe("が");
    expect(normalized.text.length).toBe(1);
    expect(normalized.map).toEqual([0]);
    expect(normalizeForMatch(source)).toBe("が");
  });
  it("agrees with normalizeForMatch on half-width voiced kana", () => {
    // U+FF9E is a modifier letter, not a combining mark, so \p{M} does not catch
    // it — but its compatibility form IS one, and NFKC composes the pair. If the
    // two normalizers disagree here, scoring finds a document whose snippet then
    // cannot locate the match and falls back to the top of the note.
    const source = "\uFF76\uFF9E"; // half-width KA + half-width voiced mark

    expect(normalizeWithMap(source).text).toBe(normalizeForMatch(source));
    expect(normalizeWithMap(source).text).toBe("\u30AC"); // composed KA-voiced
    expect(normalizeWithMap(source).map).toEqual([0]);
  });

  it("keeps the folded text and the offset map in step for every input", () => {
    const sources = ["\uFF76\uFF9E", "\u304B\u3099", "a\uFF22c", "\uFF8A\uFF9F", "plain ascii"];
    for (const source of sources) {
      const normalized = normalizeWithMap(source);
      expect(normalized.text).toBe(normalizeForMatch(source));
      expect(normalized.map).toHaveLength(normalized.text.length);
      for (let i = 1; i < normalized.map.length; i += 1) {
        expect(normalized.map[i]).toBeGreaterThanOrEqual(normalized.map[i - 1]);
        expect(normalized.map[i]).toBeLessThan(source.length);
      }
    }
  });
});

describe("search result envelope", () => {
  const documents = Array.from({ length: 7 }, (_, index) =>
    makeDocument({
      relativePath: `notes/note-${index}.md`,
      body: "shared term",
      stats: { sizeBytes: 100 + index, modifiedAt: `2026-01-0${index + 1}T00:00:00.000Z` }
    })
  );

  it("reports the pre-limit match count so truncation is visible", () => {
    const response = searchDocuments(documents, { query: "shared", limit: 3 });

    expect(response.results).toHaveLength(3);
    expect(response.total_count).toBe(7);
    expect(response.offset).toBe(0);
    expect(response.limit).toBe(3);
  });

  it("pages with offset without changing the total", () => {
    const first = searchDocuments(documents, { query: "shared", limit: 3 });
    const second = searchDocuments(documents, { query: "shared", limit: 3, offset: 3 });

    expect(second.total_count).toBe(7);
    expect(second.offset).toBe(3);
    expect(second.results.map((r) => r.path)).not.toEqual(first.results.map((r) => r.path));
    // Paging is stable: the two pages are disjoint and in the same ranking.
    const seen = new Set([...first.results, ...second.results].map((r) => r.path));
    expect(seen.size).toBe(6);
  });

  it("returns an empty page past the end while still reporting the total", () => {
    const response = searchDocuments(documents, { query: "shared", offset: 99 });

    expect(response.results).toEqual([]);
    expect(response.total_count).toBe(7);
  });

  it("clamps limit to the documented bounds and treats a negative offset as 0", () => {
    expect(searchDocuments(documents, { query: "shared", limit: 999 }).limit).toBe(50);
    expect(searchDocuments(documents, { query: "shared", offset: -5 }).offset).toBe(0);
  });

  it("exposes timestamps and size so a caller can avoid fetching a huge note whole", () => {
    const documents = [
      makeDocument({
        relativePath: "logs/session.md",
        body: "transcript",
        frontmatter: { updated_at: "2026-02-02T00:00:00.000Z" },
        stats: { sizeBytes: 802_000, modifiedAt: "2026-02-01T00:00:00.000Z" }
      })
    ];

    const [result] = searchDocuments(documents, { query: "transcript" }).results;
    expect(result.modified_at).toBe("2026-02-01T00:00:00.000Z");
    expect(result.updated_at).toBe("2026-02-02T00:00:00.000Z");
    expect(result.size_bytes).toBe(802_000);
  });

  it("omits updated_at when the note has none (and when it is not a string)", () => {
    const documents = [
      makeDocument({ relativePath: "a.md", body: "term" }),
      makeDocument({ relativePath: "b.md", body: "term", frontmatter: { updated_at: 2026 as unknown as string } })
    ];

    for (const result of searchDocuments(documents, { query: "term" }).results) {
      expect(result.updated_at).toBeUndefined();
    }
  });

  it("keeps the empty-query listing on path order (P0 changes no ranking)", () => {
    const response = searchDocuments(documents, { query: "", limit: 2 });

    expect(response.results.map((r) => r.path)).toEqual(["notes/note-0.md", "notes/note-1.md"]);
    expect(response.total_count).toBe(7);
  });
});

describe("resolveRelativeLink", () => {
  const from = "projects/chatgpt/research/shared-search.md";

  it("resolves a link against the linking note's own directory", () => {
    expect(resolveRelativeLink("../../claude/planning/connector-plan.md", from)).toBe(
      "projects/claude/planning/connector-plan.md"
    );
    expect(resolveRelativeLink("./sibling.md", from)).toBe("projects/chatgpt/research/sibling.md");
    expect(resolveRelativeLink("sibling.md", from)).toBe("projects/chatgpt/research/sibling.md");
  });

  it("resolves each `..` against exactly one directory level", () => {
    // One level up from projects/chatgpt/research is projects/chatgpt — a link
    // that climbs too few levels must NOT be quietly snapped onto the intended
    // target (the synthetic fixture used to carry exactly this off-by-one).
    expect(resolveRelativeLink("../claude/planning/connector-plan.md", from)).toBe(
      "projects/chatgpt/claude/planning/connector-plan.md"
    );
  });

  it("drops the fragment and query before resolving", () => {
    expect(resolveRelativeLink("../../claude/planning/connector-plan.md#design", from)).toBe(
      "projects/claude/planning/connector-plan.md"
    );
  });

  it("decodes percent-encoded segments, and survives a malformed escape", () => {
    expect(resolveRelativeLink("my%20note.md", "top.md")).toBe("my note.md");
    expect(resolveRelativeLink("bad%ZZ.md", "top.md")).toBe("bad%ZZ.md");
  });

  it("refuses to resolve outside the vault root or from an absolute path", () => {
    expect(resolveRelativeLink("../../../../etc/passwd", from)).toBeNull();
    expect(resolveRelativeLink("/etc/passwd", from)).toBeNull();
    expect(resolveRelativeLink("../../outside.md", "a/b.md")).toBeNull();
    expect(resolveRelativeLink("with\0nul.md", from)).toBeNull();
    expect(resolveRelativeLink("", from)).toBeNull();
  });

  it("does not escape when climbing back down into the vault", () => {
    // ../ then back in stays contained and must still resolve.
    expect(resolveRelativeLink("../research/other.md", from)).toBe("projects/chatgpt/research/other.md");
  });

  it("canonicalizes the resolved path to NFC so it can match enumerated paths", () => {
    // Enumerated relativePath values are NFC (relativeToRoot); an editor on a
    // decomposing filesystem may write the link decomposed. Without this the
    // strings differ despite naming the same file.
    const composed = "ガイド.md".normalize("NFC");
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);

    expect(resolveRelativeLink(decomposed, "top.md")).toBe(composed);
    expect(resolveRelativeLink(`../${decomposed}`, "notes/a.md")).toBe(composed);
  });
});
