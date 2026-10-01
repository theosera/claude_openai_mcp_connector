import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SHIPPED_MASK, vocabularyFrom } from "../.claude/skills/_shared/redact-log.mjs";
import { KEYWORDS, KINDS, SCHEME_WORDS, SHAPES } from "../packages/log-redaction/src/policy.mjs";

/**
 * Step ②-1 of #249: the vocabulary written down as data, and the redaction
 * corpus and timing spec kept as fixtures. The engine does not read either yet,
 * and the hooks still run the sed `mask()`.
 *
 * The first block is the migration gate: `policy.mjs` must say exactly what
 * `vocabularyFrom` lifts from the shipped shell. When the sed `mask()` is
 * retired, that block is removed and `policy.mjs` becomes the only source.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, "fixtures", "redaction-corpus");

describe("policy.mjs matches the vocabulary lifted from the shipped mask()", () => {
  const lifted = vocabularyFrom(readFileSync(SHIPPED_MASK, "utf8"));

  it("has the same keywords, in the same order", () => {
    expect(lifted.anchor.source).toBe(`(${KEYWORDS.join("|")})(['"]?)([=:>\\s]+)`);
  });

  it("has the same auth-scheme words, in the same order", () => {
    expect([...SCHEME_WORDS]).toEqual(lifted.schemeWords);
  });

  it("has the same token shapes, in the same order", () => {
    expect(SHAPES.map((shape) => ({ ...shape }))).toEqual(lifted.shapes);
  });

  it("starts with two input kinds", () => {
    expect([...KINDS]).toEqual(["command", "text"]);
  });
});

/** What the sed `mask()` at `rev` did: secrets left in the clear, preserve words removed. */
type Outcome = { rev: string; leaked: string[]; broken: string[] };

type CorpusCase = {
  id: string;
  section: string;
  kind: string;
  multiline: boolean;
  fence: boolean;
  input: string;
  secrets: string[];
  preserve: string[];
  baseline: Outcome;
  regressed_on: Outcome[];
};

describe("the redaction corpus fixture", () => {
  const cases: CorpusCase[] = readFileSync(join(CORPUS_DIR, "corpus.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CorpusCase);

  it("holds all 147 cases, each with a distinct id", () => {
    expect(cases).toHaveLength(147);
    expect(new Set(cases.map((c) => c.id)).size).toBe(147);
  });

  it("uses only the kinds policy.mjs declares", () => {
    const kinds = new Set<string>(KINDS);
    expect(cases.filter((c) => !kinds.has(c.kind)).map((c) => c.id)).toEqual([]);
  });

  // A secret or preserve word missing from the input would make its check vacuous:
  // "0 occurrences in the output" holds for a word that was never there.
  it("names only secret and preserve words that occur in the input", () => {
    const absent = cases.flatMap((c) =>
      [...c.secrets, ...c.preserve].filter((word) => !c.input.includes(word)).map((word) => `${c.id}: ${word}`)
    );
    expect(absent).toEqual([]);
  });
});

describe("the timing spec fixture", () => {
  const spec = JSON.parse(readFileSync(join(CORPUS_DIR, "perf-I.json"), "utf8")) as {
    sizes_bytes: number[];
    cases: { id: string }[];
  };

  it("doubles the input size at each step and names three shapes", () => {
    expect(spec.sizes_bytes).toEqual([64 * 1024, 128 * 1024, 256 * 1024]);
    expect(spec.cases.map((c) => c.id)).toEqual(["I-unclosed-escaped", "I-masked-doubled", "I-label-quotes"]);
  });
});
