import { describe, expect, it } from "vitest";

import { redactFragment } from "../packages/log-redaction/src/core.mjs";

const SIZES = [1, 2, 4, 8, 16].map((kib) => kib * 1024);
const SECRET = "FKWORDEND01";
const PRESERVE = "KEEPWORDEND01";
const BLANK_SOURCE = String.raw`[^\S\r\n]`;

/**
 * Count the horizontal-blank predicate across the whole public call, not a
 * particular wordEnd branch. The repeated lookahead used this predicate once
 * per blank per quoted label. A plain wrapper keeps no per-call spy history;
 * even the quadratic regression needs only a counter. Nothing asynchronous or
 * any assertion runs while the wrapper is installed.
 */
function countBlankTests<T>(run: () => T): { value: T; tests: number } {
  const original = RegExp.prototype.test;
  let tests = 0;
  try {
    RegExp.prototype.test = function (this: RegExp, input: string): boolean {
      if (this.source === BLANK_SOURCE) tests += 1;
      return original.call(this, input);
    };
    return { value: run(), tests };
  } finally {
    RegExp.prototype.test = original;
  }
}

function quotedLabelsBeforeBlanks(length: number, delimiter: string) {
  const prefix = 'echo "';
  const suffix = `token=${SECRET} ${PRESERVE}`;
  const available = length - prefix.length - suffix.length - 2;
  const labels = Math.floor(available / 12);
  const blanks = available - labels * 6;
  return {
    text: prefix + "token=".repeat(labels) + '"' + delimiter + " ".repeat(blanks) + suffix,
    labels,
    blanks
  };
}

describe("the horizontal-blank operation counter", () => {
  it("counts the expected predicate only and preserves its result", () => {
    const original = RegExp.prototype.test;
    const measured = countBlankTests(() => [
      new RegExp(BLANK_SOURCE).test(" "),
      new RegExp(BLANK_SOURCE).test("\n"),
      / /.test(" "),
      /\S/.test("x")
    ]);
    expect(measured).toEqual({ value: [true, false, true, true], tests: 2 });
    expect(RegExp.prototype.test).toBe(original);
  });

  it("restores RegExp.prototype.test when the measured call throws", () => {
    const original = RegExp.prototype.test;
    const failure = new Error("counter restoration control");
    expect(() =>
      countBlankTests(() => {
        new RegExp(BLANK_SOURCE).test(" ");
        throw failure;
      })
    ).toThrow(failure);
    expect(RegExp.prototype.test).toBe(original);
  });
});

// PR #289: all the labels in one quote ask where the word after that quote
// ends. Before a delimiter and another label, that word has zero length.
// Failing to remember the empty result walked the long blank run for every
// label: about four times the operations when both halves doubled. Text is a
// measured control on exactly the same inputs. Keep this deterministic test
// small; the existing timing suite separately covers its larger-input shapes.
describe("the core's operations after quoted labels and a closing delimiter", () => {
  const delimiters = [
    ["comma", ","],
    ["closing brace", "}"],
    ["closing bracket", "]"]
  ] as const;
  const cases = (["command", "text"] as const).flatMap((kind) =>
    delimiters.map(([name, delimiter]) => [name, kind, delimiter] as const)
  );

  it.each(cases)("%s before long blanks grows linearly, as %s", (_name, kind, delimiter) => {
    // Collect all five sizes before judging growth so a failing run reports the
    // full curve, including 16 KiB, instead of only the first excessive count.
    const measurements = SIZES.map((size) => {
      const input = quotedLabelsBeforeBlanks(size, delimiter);
      expect(input.text).toHaveLength(size);
      const measured = countBlankTests(() => redactFragment({ text: input.text, kind }));
      expect(measured.value.status).toBe("ok");
      expect(measured.value.text).not.toContain(SECRET);
      expect(measured.value.text).toContain(PRESERVE);
      return { size, tests: measured.tests, labels: input.labels, blanks: input.blanks };
    });
    const evidence = JSON.stringify(measurements);

    let previous = 0;
    for (const measured of measurements) {
      // These inputs must actually hit the instrumented predicate. If it is
      // replaced or renamed, update the counter rather than accept a vacuous
      // zero. Do not require a particular walk: skipping the blanks is valid.
      expect(measured.tests, evidence).toBeGreaterThan(0);
      // Allow two visits per input character, independent of elapsed time.
      // The regression already needs about 40,000 visits at just 1 KiB.
      expect(measured.tests, `blank predicate visits: ${evidence}`).toBeLessThanOrEqual(2 * measured.size);
      if (previous > 0) {
        expect(measured.tests / previous, `growth: ${evidence}`).toBeLessThan(3);
      }
      previous = measured.tests;
    }
  });
});
