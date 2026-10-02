import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { MASK, redactFragment } from "../packages/log-redaction/src/core.mjs";

/**
 * Step ②-3 of #249: the core's time against input length.
 *
 * The owner's criterion (2026-09-29): at 64, 128, 256 and 512 KiB and at 1 MiB,
 * the median time must grow by less than 3.0 times per doubling. A quadratic walk
 * grows by about 4. The shapes are the three in `perf-I.json`, where the sed
 * `mask()` went quadratic under GNU sed, plus a line of many short labelled
 * values, which stresses the span handling instead of the quote walk, and a word
 * of nested labels. `I-unclosed-escaped` as `text` also caught a quadratic
 * rescan here: every escaped quote was walked to the line end again.
 *
 * Each shape starts with a secret word, and every size is checked for it before
 * anything is timed: a core that stopped masking would otherwise pass by doing
 * nothing quickly. The connection stage (process start, the hook's timeout) is
 * measured separately, when the hooks are switched over.
 *
 * Each doubling is timed as interleaved pairs -- the smaller input, then the
 * larger, then the other way round -- and judged on the median of the pairs'
 * ratios. Timing the two sizes minutes apart let the other test files, running in
 * parallel, load one side and not the other: measured, the same linear shape
 * failed two full runs in three with ratios of 3.5 and 4.9, and passed every
 * run on its own. A pair shares its moment, so load that comes and goes cancels
 * out of its ratio, while a quadratic walk is over the limit in every pair.
 *
 * The core is judged on how its time grows, not on how fast this machine is,
 * with one exception: the first call at each size must take under a second per
 * 64 KiB. A linear core takes milliseconds; a quadratic one takes seconds at
 * 64 KiB, and vitest's timeout cannot stop a synchronous loop -- a quadratic
 * mutation once kept this file running for 22 minutes. The ceiling fails it in
 * one call instead.
 */

const KiB = 1024;
const SIZES = [64, 128, 256, 512, 1024].map((k) => k * KiB);
const LIMIT = 3.0;
const REPEAT = 4;
const PAIRS = 7;
const ATTEMPTS = 3;
const CEILING_MS_PER_64_KIB = 1000;

const DASH5 = "-".repeat(5);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function fill(head: string, unit: string, length: number): string {
  const body = unit.repeat(Math.ceil((length - head.length) / unit.length));
  return head + body.slice(0, length - head.length);
}

const SHAPES: readonly (readonly [string, string, (length: number) => string])[] = [
  ["I-unclosed-escaped", "FKPERFUE1", (n) => fill('passphrase: "FKPERFUE1 ', 'a\\"', n)],
  ["I-masked-doubled", "FKPERFMD1", (n) => fill("token=FKPERFMD1 ", `${MASK}''x`, n)],
  ["I-label-quotes", "FKPERFLQ1", (n) => fill('passwd: "FKPERFLQ1', 'passwd: "ab', n)],
  ["many-labels", "FKPERFML1", (n) => fill("token=FKPERFML1 ", "token=v ", n)],
  // Labels nested in one unquoted word: each is read again, and each value runs
  // to the end of the same word. Measured quadratic until the word's end and
  // quotedness were remembered (3.5 to 3.9 per doubling as a command). Whole
  // labels only: a word is read again only when it ends like a label (`token:`),
  // so a word cut mid-label at one size and not the next times two different
  // paths and reads as a jump of 6 in one doubling.
  ["nested-labels", "FKPERFNL1", (n) => "token=FKPERFNL1 " + "token:".repeat(Math.floor((n - 16) / 6))],
  // A long run of digits that fails a base64 line at its last character. A line
  // number prefix that could end anywhere inside the digits made this quadratic
  // (3.6 s at 32,000 characters).
  ["digits-bang", "FKPERFDG1", (n) => "token=FKPERFDG1\n" + "7".repeat(n - 17) + "!"],
  // Many labels inside one quoted string, each asking for the word joined after
  // its closing quote (`echo "k=k=k=…"X=`), and many labels whose blank-free value
  // is read again inside the string (`echo "k>k>k>…x="`). Both were quadratic.
  [
    "quoted-labels-joined",
    "FKPERFQJ1",
    (n) => 'token=FKPERFQJ1 echo "' + "token=".repeat(Math.floor(n / 12)) + '"' + "X".repeat(Math.floor(n / 2)) + "="
  ],
  [
    "quoted-labels-arrow",
    "FKPERFQA1",
    (n) => 'token=FKPERFQA1 echo "' + "token>".repeat(Math.floor((n - 30) / 6)) + 'x="'
  ],
  // Escaped quotes before a blank inside one text quote, each looking ahead for a
  // label before the next quote, and elements that never close, each looking
  // ahead for its closing tag. Each looks only as far as the next quote or `<`.
  // A blank follows each tag so that no tag takes a value that would run over
  // the rest of the line and leave the other tags unread.
  ["escaped-quotes-blank", "FKPERFEB1", (n) => fill("passphrase: 'FKPERFEB1 ", "n\\' x ", n)],
  ["unclosed-elements", "FKPERFUN1", (n) => fill("token=FKPERFUN1 ", "<password> x", n)],
  // A line number, then blanks and no base64. Two adjacent blank quantifiers in
  // the line-number prefix split the blanks every way before failing (7.5 s at
  // 32,768 blanks).
  ["number-blanks", "FKPERFNB1", (n) => "token=FKPERFNB1\n1" + " ".repeat(n - 18) + "!"],
  // Elements whose CDATA section never ends, each looking ahead for its `]]>`.
  ["unclosed-cdata", "FKPERFCD1", (n) => fill("token=FKPERFCD1 ", "<password><![CDATA[x", n)],
  // #270, 1: labels nested in one label-like word (`token=-token=-…`), each giving a
  // span to the same word end, then quoted armor delimiters glued into that word:
  // every span was clipped against every guard inside it (N x G pieces). Half the
  // length each.
  [
    "nested-labels-guards",
    "FKPERFNG1",
    (n) =>
      "token=FKPERFNG1 " +
      fill("", "token=-", Math.floor((n - 16) / 2)) +
      fill("", `'${DASH5}BEGIN A${DASH5}'`, Math.floor((n - 16) / 2))
  ],
  // #270, 2: a long run of U+2028, and of U+2029. The multiline `^` matches after
  // each, and the base64-line rule counted them as blanks, so every start walked
  // the rest of the run.
  ["line-separators", "FKPERFLS1", (n) => "token=FKPERFLS1\n" + LS.repeat(n - 16)],
  ["paragraph-separators", "FKPERFPS1", (n) => "token=FKPERFPS1\n" + PS.repeat(n - 16)],
  // Label elements opened inside each other with no text after them, each
  // walking the opening tags after it, and opening tags whose `>` never comes.
  ["nested-label-elements", "FKPERFNE1", (n) => fill("token=FKPERFNE1 ", "<password>", n)],
  ["label-elements-unclosed-tags", "FKPERFNU1", (n) => fill("token=FKPERFNU1 ", "<password><a b", n)],
  // Label elements among closed tags, all glued, ending in a tag whose `>` never
  // comes: every label walks the tags after it up to that tag. The shape above
  // stops each walk at its own unclosed tag, so it stays linear with the memo of
  // walked tags taken out; this one does not (#275).
  [
    "label-elements-before-an-unclosed-tag",
    "FKPERFNW1",
    (n) => fill("token=FKPERFNW1 ", "<password><a>", n - 4) + "<a b"
  ]
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The median of the pairs' ratios, from pairs of batch times `[smaller, larger]`. */
function doublingRatio(pairs: readonly (readonly [number, number])[]): number {
  return median(pairs.map(([small, large]) => large / small));
}

function batchTime(text: string, kind: "command" | "text"): number {
  const start = performance.now();
  for (let r = 0; r < REPEAT; r += 1) redactFragment({ text, kind });
  return performance.now() - start;
}

function timedPairs(small: string, large: string, kind: "command" | "text"): [number, number][] {
  const pairs: [number, number][] = [];
  for (let p = 0; p < PAIRS; p += 1) {
    if (p % 2 === 0) {
      const s = batchTime(small, kind);
      pairs.push([s, batchTime(large, kind)]);
    } else {
      const l = batchTime(large, kind);
      pairs.push([batchTime(small, kind), l]);
    }
  }
  return pairs;
}

describe("the doubling-ratio check itself", () => {
  it("fails a quadratic curve and passes a linear one", () => {
    expect(
      doublingRatio([
        [1, 4],
        [2, 8],
        [1, 4]
      ]) < LIMIT
    ).toBe(false);
    expect(
      doublingRatio([
        [1, 2],
        [2, 4],
        [1, 2]
      ]) < LIMIT
    ).toBe(true);
  });

  it("is not moved by one stalled pair", () => {
    expect(
      doublingRatio([
        [1, 2],
        [1, 9],
        [1, 2]
      ]) < LIMIT
    ).toBe(true);
  });
});

describe("the core's time per doubling", { timeout: 180_000 }, () => {
  const cases = SHAPES.flatMap(([name, secret, make]) =>
    (["command", "text"] as const).map((kind) => [name, kind, secret, make] as const)
  );

  // Sizes are taken smallest first and each doubling is judged as soon as it is
  // measured, so a quadratic walk fails at 128 KiB instead of running on to 1 MiB.
  it.each(cases)("%s as %s", (_name, kind, secret, make) => {
    let previous: string | null = null;
    for (const size of SIZES) {
      const text = make(size);
      const first = performance.now();
      const result = redactFragment({ text, kind });
      const firstMs = performance.now() - first;
      expect({ size, firstMs: firstMs < (CEILING_MS_PER_64_KIB * size) / (64 * KiB) ? "under" : firstMs }).toEqual({
        size,
        firstMs: "under"
      });
      expect(result.status).toBe("ok");
      expect(result.text).not.toContain(secret);
      if (previous) {
        // Up to three sets of pairs. Pairing alone still failed one full run in
        // three (a ratio of 3.1 at 256 KiB, on a shape whose batches take a few
        // milliseconds); a quadratic walk is over the limit in every set.
        const ratios: number[] = [];
        while (ratios.length < ATTEMPTS && !(ratios.at(-1)! < LIMIT)) {
          ratios.push(doublingRatio(timedPairs(previous, text, kind)));
        }
        expect({ size, ratio: ratios.at(-1)! < LIMIT ? "under" : ratios }).toEqual({ size, ratio: "under" });
      }
      previous = text;
    }
  });
});
