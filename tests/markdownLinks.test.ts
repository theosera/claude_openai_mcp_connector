import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractAllLocalLinks, extractMarkdownLinks, extractWikiLinks } from "../src/markdownLinks.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The patterns the extractors used to run, kept verbatim as the reference
 * implementation. `traceSources` scans every document in the vault with them on
 * every call, and they are quadratic on a body that repeats `[x](` or `[`, so
 * they were replaced by a forward-only scan — but only the running time was
 * meant to change. These two functions are what "unchanged behaviour" means for
 * the tests below; do not relax them to match a new implementation.
 */
function legacyWikiLinks(body: string): string[] {
  const links = new Set<string>();
  const wikiLinkPattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of body.matchAll(wikiLinkPattern)) {
    links.add(match[1].trim());
  }
  return [...links].sort();
}

function legacyMarkdownLinks(body: string): string[] {
  const links = new Set<string>();
  const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of body.matchAll(markdownLinkPattern)) {
    const target = match[1].trim();
    if (target && !target.includes("://") && !target.startsWith("#")) {
      links.add(target);
    }
  }
  return [...links].sort();
}

/** Ordinary and awkward-but-legitimate bodies, named so a failure points at the shape. */
const corpus: Record<string, string> = {
  "plain wiki link": "See [[connector-plan]] for the design.",
  "wiki link with anchor": "See [[connector-plan#design]] and [[a#b#c]].",
  "wiki link with alias": "See [[connector-plan|the plan]] and [[a|b|c]].",
  "wiki link with anchor and alias": "See [[connector-plan#design|the design]].",
  "wiki link with spaces around the name": "[[  spaced note  ]] and [[  a  #  b  ]]",
  "wiki links adjacent on one line": "[[first]][[second]] [[third]]",
  "wiki link with empty parts": "[[]] [[#anchor]] [[name#]] [[name|]] [[|alias]]",
  "wiki link never closed": "[[unterminated and [[also this",
  "wiki link closed with a single bracket": "[[half]",
  "brackets before a wiki link": "[[[[nested]] and [[[deep]]",
  "markdown relative link (the pinned backlink shape)": "[Claude plan](../../claude/planning/connector-plan.md)",
  "markdown link with an anchor in the target": "[plan](../plan.md#design) [self](#section)",
  "markdown absolute url is skipped": "[docs](https://example.com/x) [ftp](ftp://example.com) [rel](./ok.md)",
  "markdown link with an empty or blank target": "[empty]() [blank](   ) [ok](x.md)",
  "markdown link with empty text": "[](x.md) [ok](y.md)",
  "markdown links adjacent on one line": "[a](one.md)[b](two.md) [c](three.md)",
  "markdown link with nested brackets in the text": "[a[b]c](nested.md) [x[y](inner.md)",
  "markdown link with a paren-ish target": "[a](b](c) [d](e)",
  "markdown link split over lines": "[a\nmultiline\ntext](multi\nline.md)",
  "markdown link with escaped brackets": "\\[not a link\\](escaped.md)",
  "markdown link inside a code fence": "```\n[code](fence.md)\n```\n[real](outside.md)",
  "markdown link inside inline code": "`[inline](code.md)` and [real](outside.md)",
  "markdown image": "![alt](image.png)",
  "markdown reference-style link": "[label][ref]\n\n[ref]: target.md",
  "unicode target": "[ノート](プロジェクト/設計ノート.md) and [[設計ノート]]",
  "percent-encoded target": "[note](my%20note.md) [bad](bad%ZZ.md)",
  "target with a query string": "[q](note.md?v=2)",
  "duplicate links dedupe and sort": "[b](b.md) [a](a.md) [b again](b.md) [[z]] [[a]]",
  "wiki and markdown mixed": "[[plan]] and [text](../plan.md) and [[plan|alias]]",
  "no links at all": "Just prose with brackets ] ) | # and nothing else.",
  "unterminated markdown open": "[x]( [y]( [z](",
  "delimiter soup": "][)(|#[[]]](())[[|#]]"
};

async function fixtureBodies(): Promise<Record<string, string>> {
  const directory = path.join(repoRoot, "fixtures", "synthetic-vault");
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  const bodies: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const file = path.join(entry.parentPath, entry.name);
    bodies[`fixture ${path.relative(directory, file)}`] = await fs.readFile(file, "utf8");
  }
  return bodies;
}

describe("link extraction — equivalence with the patterns it replaced", () => {
  it("returns exactly the old result for every corpus body", () => {
    for (const [name, body] of Object.entries(corpus)) {
      expect(extractWikiLinks(body), `wiki: ${name}`).toEqual(legacyWikiLinks(body));
      expect(extractMarkdownLinks(body), `markdown: ${name}`).toEqual(legacyMarkdownLinks(body));
    }
  });

  it("returns exactly the old result for the repository's own fixtures", async () => {
    const bodies = await fixtureBodies();
    // Guard against the fixture directory quietly moving out from under us.
    expect(Object.keys(bodies).length).toBeGreaterThanOrEqual(2);
    for (const [name, body] of Object.entries(bodies)) {
      expect(extractWikiLinks(body), `wiki: ${name}`).toEqual(legacyWikiLinks(body));
      expect(extractMarkdownLinks(body), `markdown: ${name}`).toEqual(legacyMarkdownLinks(body));
    }
  });

  it("agrees with the old patterns on randomly generated delimiter soup", () => {
    // Deterministic (fixed seed): the alphabet is dense in the characters the
    // patterns treat specially, which is where an off-by-one in the hand-written
    // scan would show up.
    const alphabet = ["[[", "]]", "](", "[", "]", "(", ")", "|", "#", "://", "note", ".md", "../", " ", "\n", "%20"];
    let seed = 20260804;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let iteration = 0; iteration < 5000; iteration += 1) {
      let body = "";
      const tokens = 1 + Math.floor(random() * 20);
      for (let index = 0; index < tokens; index += 1) {
        body += alphabet[Math.floor(random() * alphabet.length)];
      }
      expect(extractWikiLinks(body), `wiki: ${JSON.stringify(body)}`).toEqual(legacyWikiLinks(body));
      expect(extractMarkdownLinks(body), `markdown: ${JSON.stringify(body)}`).toEqual(legacyMarkdownLinks(body));
    }
  });
});

describe("link extraction — the semantics the callers depend on", () => {
  it("keeps the relative Markdown link that `traceSources` resolves into a backlink", async () => {
    const body = await fs.readFile(
      path.join(repoRoot, "fixtures", "synthetic-vault", "projects", "chatgpt", "research", "shared-search.md"),
      "utf8"
    );

    // Recall here is load-bearing: this is the link `traceSources` resolves
    // against the linking note's directory to find the plan's backlink.
    expect(extractMarkdownLinks(body)).toEqual(["../../claude/planning/connector-plan.md"]);
    expect(extractAllLocalLinks(body)).toEqual(["../../claude/planning/connector-plan.md"]);
  });

  it("strips `#anchor` and `|alias` from a wiki link and keeps the name", () => {
    expect(extractWikiLinks("[[plan#design|the design]]")).toEqual(["plan"]);
    expect(extractWikiLinks("[[plan#design]] [[plan|alias]] [[plan]]")).toEqual(["plan"]);
  });

  it("drops absolute-URL and fragment-only Markdown targets, keeps local ones", () => {
    expect(extractMarkdownLinks("[a](https://example.com/x) [b](#section) [c](../notes/a.md)")).toEqual([
      "../notes/a.md"
    ]);
  });

  it("merges, dedupes and sorts both link kinds", () => {
    expect(extractAllLocalLinks("[[zeta]] [b](b.md) [[alpha]] [a](a.md) [again](b.md)")).toEqual([
      "a.md",
      "alpha",
      "b.md",
      "zeta"
    ]);
  });
});

describe("link extraction — linear in the body length", () => {
  // The patterns these replaced were quadratic: a body of repeated `[x](` (or of
  // unterminated `[`) made the engine walk the tail again at every `[`, and
  // `traceSources` runs the extractors over every document in the vault. Measured
  // against the old patterns on the machine this was written on: 200_000 chars
  // cost 4.6 s (markdown `[x](`), 19.3 s (markdown `[`), 31.7 s (wiki `[`) and
  // 4.5 s (wiki `[[x|`) — and 1 MiB extrapolates to minutes. The bound below is
  // ~100x what the scan actually needs, so it is not flaky, but every 200_000
  // case above blows straight through it with the old patterns.
  const budgetMs = 1000;
  const sizes = [10_000, 50_000, 200_000];
  const shapes: Record<string, { build: (chars: number) => string; extract: (body: string) => string[] }> = {
    "markdown, repeated `[x](` with no closing paren": {
      build: (chars) => "[x](".repeat(Math.ceil(chars / 4)).slice(0, chars),
      extract: extractMarkdownLinks
    },
    "markdown, unterminated `[`": {
      build: (chars) => "[".repeat(chars),
      extract: extractMarkdownLinks
    },
    "wiki, unterminated `[`": {
      build: (chars) => "[".repeat(chars),
      extract: extractWikiLinks
    },
    "wiki, repeated `[[x|` with no closing bracket": {
      build: (chars) => "[[x|".repeat(Math.ceil(chars / 4)).slice(0, chars),
      extract: extractWikiLinks
    },
    "both kinds at once, via the caller's entry point": {
      build: (chars) => "[[x|[y](".repeat(Math.ceil(chars / 8)).slice(0, chars),
      extract: extractAllLocalLinks
    }
  };

  for (const [name, shape] of Object.entries(shapes)) {
    it(`stays inside a fixed time budget on ${name}`, () => {
      for (const chars of sizes) {
        const body = shape.build(chars);
        expect(body.length).toBe(chars);

        const started = performance.now();
        const links = shape.extract(body);
        const elapsedMs = performance.now() - started;

        expect(links).toEqual([]); // none of these shapes contains a complete link
        expect(elapsedMs, `${name} at ${chars} chars took ${elapsedMs.toFixed(1)}ms`).toBeLessThan(budgetMs);
      }
    });
  }

  it("stays inside the budget on a body that is mostly real links", () => {
    // The linear scan must not have traded a pathological case for the normal
    // one: 200_000 chars of genuine links, extracted well inside the budget.
    const body = "[a](one.md) [[two]] ".repeat(10_000);
    expect(body.length).toBe(200_000);

    const started = performance.now();
    const links = extractAllLocalLinks(body);
    const elapsedMs = performance.now() - started;

    expect(links).toEqual(["one.md", "two"]);
    expect(elapsedMs, `dense links took ${elapsedMs.toFixed(1)}ms`).toBeLessThan(budgetMs);
  });
});
