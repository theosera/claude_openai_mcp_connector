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
 * `logRedactionPerf` carries no speed floor: the core is judged on how its time
 * grows, not on how fast this machine is.
 */

const KiB = 1024;
const SIZES = [64, 128, 256, 512, 1024].map((k) => k * KiB);
const LIMIT = 3.0;
const REPEAT = 4;
const PAIRS = 7;
const ATTEMPTS = 3;

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
  ["digits-bang", "FKPERFDG1", (n) => "token=FKPERFDG1\n" + "7".repeat(n - 17) + "!"]
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
      const result = redactFragment({ text, kind });
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
