import { describe, expect, it } from "vitest";
import {
  ASCII_CHARS_PER_TOKEN,
  CHUNK_JSON_OVERHEAD_TOKENS,
  CJK_CHARS_PER_TOKEN,
  CODE_ASCII_CHARS_PER_TOKEN,
  countCharacters,
  estimateChunkTokens,
  estimateTokens,
  OTHER_CHARS_PER_TOKEN,
  SAFETY_FACTOR,
  truncateToTokens
} from "../src/tokenEstimate.js";

describe("token estimation buckets", () => {
  it("puts every code point in exactly one bucket, and none of them in none", () => {
    // ⚠️ The guard this pins is the FALLBACK, not the classifier: a bucket list
    // with a hole prices emoji and Cyrillic at zero, which is the same defect as
    // not counting them. Assert the totals reconcile rather than assert each
    // range, or the test only re-states the implementation.
    const text = "abc あいう 漢字 Привет é 🙂";
    const counts = countCharacters(text);
    const total = counts.ascii + counts.codeAscii + counts.cjk + counts.other;

    // The trailing newline `countCharacters` adds per line is part of the cost.
    expect(total).toBe([...text].length + 1);
    expect(counts.other).toBeGreaterThan(0); // Cyrillic + é + emoji landed somewhere
    expect(counts.cjk).toBe(5); // あいう + 漢字
  });

  it("counts an emoji as one character, not as its surrogate halves", () => {
    // Iterating UTF-16 units would double-count every astral code point, which
    // over-prices exactly the text most likely to be a whole note of it.
    expect(countCharacters("🙂").other).toBe(1);
  });

  it("prices ASCII, CJK and other in the documented order", () => {
    // Bigger divisor = cheaper character, so the assertion is on the divisors'
    // ordering; the estimates follow from it.
    expect(ASCII_CHARS_PER_TOKEN).toBeGreaterThan(OTHER_CHARS_PER_TOKEN);
    expect(OTHER_CHARS_PER_TOKEN).toBeGreaterThan(CJK_CHARS_PER_TOKEN);

    const ascii = estimateTokens("a".repeat(400));
    const cjk = estimateTokens("あ".repeat(400));
    const other = estimateTokens("ж".repeat(400));
    expect(cjk).toBeGreaterThan(other);
    expect(other).toBeGreaterThan(ascii);
  });

  it("charges more for ASCII inside a fenced code block than for the same prose", () => {
    expect(CODE_ASCII_CHARS_PER_TOKEN).toBeLessThan(ASCII_CHARS_PER_TOKEN);
    const payload = "const value = compute(input);\n".repeat(20);
    const prose = estimateTokens(payload);
    const fenced = estimateTokens(`\`\`\`ts\n${payload}\`\`\`\n`);
    expect(fenced).toBeGreaterThan(prose);
  });

  it("does not let a nested fence marker close the outer block", () => {
    // A ```js line inside a ~~~ block is content. Closing on it would price the
    // rest of the note as prose — and, in the splitter next door, cut on the
    // headings it contains.
    const inner = "x".repeat(200);
    const nested = `~~~\n\`\`\`js\n${inner}\n\`\`\`\n~~~\n`;
    expect(countCharacters(nested).ascii).toBe(1); // only the newline after the closing ~~~
    expect(countCharacters(nested).codeAscii).toBeGreaterThan(inner.length);
  });

  it("errs high: the safety factor biases toward under-filling a budget", () => {
    expect(SAFETY_FACTOR).toBeGreaterThan(1);
    const text = "a".repeat(1000);
    expect(estimateTokens(text)).toBeGreaterThan(1000 / ASCII_CHARS_PER_TOKEN);
  });

  it("charges each chunk for its JSON framing on top of its text", () => {
    expect(estimateChunkTokens("hello")).toBe(estimateTokens("hello") + CHUNK_JSON_OVERHEAD_TOKENS);
  });
});

describe("truncateToTokens", () => {
  it("returns the whole text when it already fits", () => {
    const text = "short enough";
    expect(truncateToTokens(text, 1000)).toBe(text);
  });

  it("returns a prefix that fits, and the longest one", () => {
    const text = "a".repeat(4000);
    const cut = truncateToTokens(text, 100);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(100);
    expect(cut.length).toBeLessThan(text.length);
    // Longest: one more character would exceed. Without this half the function
    // could return "" for every input and still pass the bound above.
    expect(estimateTokens(text.slice(0, cut.length + 1))).toBeGreaterThan(100);
  });

  it("never splits an astral code point in half", () => {
    // Slicing by UTF-16 index would hand back a lone surrogate — invalid text
    // the client then has to cope with.
    const text = "🙂".repeat(500);
    const cut = truncateToTokens(text, 60);
    expect([...cut].every((character) => character === "🙂")).toBe(true);
    // ⚠️ Not `/[\uD800-\uDFFF]$/`: a COMPLETE emoji ends in a low surrogate, so
    // that regex fires on correct output. The defect is an UNPAIRED half.
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(cut.length % 2).toBe(0);
  });

  it("returns nothing rather than something unpaid-for at a zero budget", () => {
    expect(truncateToTokens("anything", 0)).toBe("");
  });
});
