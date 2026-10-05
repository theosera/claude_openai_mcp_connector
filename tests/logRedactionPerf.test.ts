import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MASK, redactFragment } from "../packages/log-redaction/src/core.mjs";

/**
 * Step ②-3 of #249: the core's time against input length.
 *
 * The owner's criterion for #284 (2026-10-03): judge two doublings together,
 * 64 -> 256 KiB and 256 KiB -> 1 MiB, against 3.0 squared (strictly below 9).
 * `escaped-quotes-blank` as `text` is linear overall but alternates low and high
 * steps (about 1.4 and 2.7 per doubling); a high step alone crossed 3.0 in CI.
 * Combining two steps tolerates a shift in where the high step lands: linear
 * growth is about 3.8 to 4.0 over the pair, while quadratic growth is about 16.
 * The intermediate 128 and 512 KiB sizes still get the first-call checks below.
 * The shapes are the three in `perf-I.json`, where the sed
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
 * Each fourfold increase is timed as interleaved pairs -- the smaller input, then the
 * larger, then the other way round -- and judged on the median of the pairs'
 * ratios. Under the old per-doubling rule, timing the two sizes minutes apart
 * let the other test files, running in parallel, load one side and not the other:
 * the same linear shape failed two full runs in three with ratios of 3.5 and 4.9,
 * and passed every run on its own. A pair shares its moment, so transient load cancels
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
const DOUBLINGS = 2;
const LIMIT = 3.0 ** DOUBLINGS;
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

type PerfSecrets = string | readonly string[];
type PerfShape = readonly [
  name: string,
  secret: PerfSecrets,
  make: (length: number) => string,
  preserve?: string,
  hookSecret?: string
];
type Issue295PerfShape = readonly [
  name: string,
  secret: PerfSecrets,
  make: (length: number) => string,
  preserve: string,
  hookSecret?: string
];

function enclosed(head: string, unit: string, tail: string, length: number): string {
  return fill(head, unit, length - tail.length) + tail;
}

function completeUnits(head: string, unit: string, tail: string, length: number): string {
  const available = length - head.length - tail.length;
  return head + unit.repeat(Math.floor(available / unit.length)).padEnd(available, " ") + tail;
}

// #295: each canary belongs to a newly supported shape, rather than an unrelated
// token= prefix. A no-op new collector must fail before any timing is accepted.
// Inputs use ASCII, so these lengths are both bytes and UTF-16 code units.
const ISSUE295_SHAPES: readonly Issue295PerfShape[] = [
  [
    "issue295-compound-long-attribute",
    "FKPERF295C1",
    (n) => enclosed('<access_token a="x" b="FKPERF295C1 ', "x ", '"> KEEP295C1', n),
    "KEEP295C1"
  ],
  [
    "issue295-namespace-long-name",
    "FKPERF295N1",
    (n) => enclosed("<", "ns", ':password a="x" b="FKPERF295N1"> KEEP295N1', n),
    "KEEP295N1"
  ],
  [
    "issue295-input-many-label-like-attributes",
    "FKPERF295I1",
    (n) => completeUnits("<input ", 'data-tokenish="" ', 'type="password" value="FKPERF295I1"> KEEP295I1', n),
    "KEEP295I1"
  ],
  [
    "issue295-multiline-long-start",
    "FKPERF295M1",
    // Keep the long attribute walk on two physical lines. The former repeated
    // newline form intentionally exceeds the new 32-line recovery bound.
    (n) => completeUnits("<password\n", ' a="x" ', ' b="FKPERF295M1"> KEEP295M1', n),
    "KEEP295M1"
  ],
  [
    "issue295-later-value-many-quoted-angles",
    "FKPERF295A1",
    (n) => enclosed('<password a="x" b="y>z" c="FKPERF295A1 ', "< > ", '"> KEEP295A1', n),
    "KEEP295A1"
  ],
  [
    "issue295-many-unfinished-starts",
    "FKPERF295U1",
    (n) => fill('<input type="password" value="FKPERF295U1"> KEEP295U1 ', '<access_token a="x" ', n),
    "KEEP295U1"
  ],
  [
    "issue295-self-closing-input-long-slash-value",
    "FKPERF295S1",
    // Only the slash immediately before `>` terminates the unquoted type.
    // Earlier slashes remain part of the long value that must be masked.
    (n) => enclosed("<input value=FKPERF295S1/", "segment/", " type=password/> KEEP295S1", n),
    "KEEP295S1"
  ],
  [
    "issue295-many-starts-across-fence-barriers",
    // Fence syntax no longer abandons the complete, bounded attribute. Its
    // contents must mask too; only the word outside the element must survive.
    ["FKPERF295F1", "PUBLIC295F1"],
    (n) =>
      completeUnits(
        "",
        '<password a="x\n~~~~~~\nPUBLIC295F1\n~~~~~~\nz" b="s"> KEEP295F1\n' +
          '<password a="x\n```\nPUBLIC295F1\n```\nz" b="s"> KEEP295F1\n',
        '\n<input value="FKPERF295F1" type=password/> KEEP295F1\n',
        n
      ),
    "KEEP295F1"
  ],
  [
    "issue295-many-starts-beyond-line-bound",
    "FKPERF295B1",
    (n) =>
      completeUnits(
        "",
        '<password a="x\n' + " note\n".repeat(31) + 'PUBLIC295B1\nz" b="s"> KEEP295B1\n',
        '\n<input value="FKPERF295B1" type=password/> KEEP295B1\n',
        n
      ),
    "PUBLIC295B1"
  ],
  [
    "issue295-long-invalid-backtick-info",
    "FKPERF295T1",
    (n) => {
      const head = '<input value="FKPERF295T1" type=password/> KEEP295T1 ';
      const tail = '`\n<input value="FKPERF295T1" type=password/> KEEP295T1\n';
      const available = n - head.length - tail.length;
      const ticks = Math.floor(available / 2);
      // The later single backtick invalidates the first maximal fence run.
      // Both the candidate line and the following line must still mask.
      return head + "`".repeat(ticks) + "x".repeat(available - ticks) + tail;
    },
    "KEEP295T1"
  ],
  [
    "issue295-credential-bearing-fence-lines",
    "FKPERF295FL1",
    (n) => {
      // The earlier long-invalid-info family is inline. Also exercise a long
      // structural candidate under the narrower syntax-only guard contract.
      const part = Math.floor(n / 4);
      const head = "`".repeat(part) + "x".repeat(part) + "` token=FKPERF295FL1 INFO295FL1\n";
      return completeUnits(
        head,
        "~~~~~~ token=FKPERF295FL1 INFO295FL1\n" +
          "```text export API_KEY=FKPERF295FL1 INFO295FL1\n" +
          "> ```text token=FKPERF295FL1 INFO295FL1\n" +
          "1. ~~~ token=FKPERF295FL1 INFO295FL1\n" +
          'inline ~~~ <input value="FKPERF295FL1" type=password/> KEEP295FL1\n' +
          'inline ``` <ns:password a="x" b="FKPERF295FL1"> KEEP295FL1\n',
        "\nKEEP295FL1\n",
        n
      );
    },
    "KEEP295FL1"
  ],
  [
    "issue295-credentials-crossing-fence-markers",
    "FKPERF295FM1",
    (n) =>
      completeUnits(
        "",
        '~~~ token="FKPERF295FM1~~~FKPERF295FM1" INFO295FM1\n' +
          '```text token="FKPERF295FM1`FKPERF295FM1" INFO295FM1\n' +
          "Bearer FKPERF295FM1~~~~~~FKPERF295FM1 KEEP295FM1\n" +
          '<input value="FKPERF295FM1\n~~~~~~\nFKPERF295FM1" type=password/> KEEP295FM1\n' +
          '<access_token a="FKPERF295FM1\n```text\nFKPERF295FM1" b="x"> KEEP295FM1\n',
        "\nKEEP295FM1\n",
        n
      ),
    "KEEP295FM1"
  ],
  [
    "issue295-overbound-cr-legacy-tags",
    "FKPERF295CRT1",
    // The hooks' legacy simple-label rule masked this before #295. Their
    // bounded parser must retain that privacy floor for many CR-delimited
    // candidates in one LF record. Core keeps its existing 32-line bound;
    // all engines must still reach the separate selected input at the end.
    (n) =>
      completeUnits(
        "",
        '<password a="x"\r' + " note\r".repeat(31) + ' b="FKPERF295CR1"> KEEP295CR1 ',
        '\n<input value="FKPERF295CRT1" type=password/> KEEP295CRT1\n',
        n
      ),
    "KEEP295CRT1",
    "FKPERF295CR1"
  ]
];

// F1: keep NUL-heavy normalization in the same grouped-growth contract. This
// body remains public except for the two named values, so byte loss cannot
// make a fast mask appear to pass. The core is not wired to this hook boundary.
const NUL_NORMALIZATION_SHAPE: Issue295PerfShape = [
  "issue295-nul-dense-public-body",
  ["FKPERF295NULBEFORE", "FKPERF295NULTAIL"],
  (n) =>
    enclosed("token=FKPERF295NULBEFORE KEEP295NULHEAD\n", "\0x", "\npassword=FKPERF295NULTAIL KEEP295NULTAIL\n", n),
  "KEEP295NULTAIL"
];

function fenceSyntax(text: string, original = text) {
  function candidate(line: string) {
    const match = line.match(/^([ \t>+*().0-9-]*)(`{3,}|~{3,})/);
    if (!match) return null;
    const [, prefix, marker] = match;
    if (!/^ {0,3}$/.test(prefix)) {
      let cursor = 0;
      let container = false;
      while (cursor < prefix.length) {
        if (prefix[cursor] === " " || prefix[cursor] === "\t") cursor++;
        else if (prefix[cursor] === ">") {
          container = true;
          cursor++;
        } else {
          // At most nine digits, punctuation and a blank: this small slice
          // cannot repeatedly scan an unbounded prefix.
          const item = prefix.slice(cursor, cursor + 11).match(/^(?:[-+*]|[0-9]{1,9}[.)])[ \t]/);
          if (!item) return null;
          container = true;
          cursor += item[0].length;
        }
      }
      if (!container) return null;
    }
    return {
      prefix: prefix.replace(/[0-9]/g, "0"),
      marker,
      valid: marker[0] !== "`" || !line.slice(match[0].length).includes("`")
    };
  }
  // Invalid info retains its baseline masking and downstream refencing policy.
  // It is tested for secret removal, not marker identity at this mask stage.
  const invalid = new Set(
    original.split(/\r\n|\r|\n/).flatMap((line, index) => {
      const found = candidate(line);
      return found && !found.valid ? [index] : [];
    })
  );
  const separators = text.match(/\r\n|\r|\n/g) ?? [];
  return text.split(/\r\n|\r|\n/).flatMap((line, index) => {
    const found = candidate(line);
    return found?.valid && !invalid.has(index)
      ? [{ line: index, prefix: found.prefix, marker: found.marker, separator: separators[index] ?? "" }]
      : [];
  });
}

function expectPreserved(input: string, output: string, preserve: string) {
  expect(output).toContain(preserve);
  // Repeated recovery blocks must all survive, not merely the last one.
  const words = new Set([preserve, ...(input.match(/\bKEEP295[A-Z0-9]+\b/g) ?? [])]);
  for (const word of words) expect(output.split(word).length).toBe(input.split(word).length);
  // Structural marker bytes, physical lines and separators must survive;
  // credentials in info strings or elsewhere on those lines still mask.
  // Ordered-list digits normalize to zeroes; info text and arbitrary inline
  // runs need not survive. Invalid-info refencing is checked separately.
  expect(fenceSyntax(output, input)).toEqual(fenceSyntax(input));
}

const SHAPES: readonly PerfShape[] = [
  ...ISSUE295_SHAPES,
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
  ],
  // Label elements nested in each other, then a quote or a CDATA section that
  // never ends: every label reaches the same text, and its value runs to the line
  // end. Reading that value once per label was quadratic as text (47 and 64 ms at
  // 32 KiB, under 2 ms on main), until the value was remembered for its text.
  [
    "label-elements-before-an-unclosed-quote",
    "FKPERFNQ1",
    (n) =>
      "token=FKPERFNQ1 " + "<password>".repeat(Math.floor(n / 20)) + '"' + "x".repeat(n - 17 - 10 * Math.floor(n / 20))
  ],
  [
    "label-elements-before-an-unclosed-cdata",
    "FKPERFNC1",
    (n) =>
      "token=FKPERFNC1 " +
      "<password>".repeat(Math.floor(n / 20)) +
      '<![CDATA["' +
      "x".repeat(n - 26 - 10 * Math.floor(n / 20))
  ],
  // Many labelled values among many list separators (`,` `;` `&`): each value's
  // search for the last separator before its end halves over their positions. A
  // walk over the positions, from either end, is quadratic here, and no other
  // shape holds many separators.
  ["values-among-separators", "FKPERFVS1", (n) => fill("token=FKPERFVS1 ", "token=v a, ", n)]
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The median of the pairs' ratios, from pairs of batch times `[smaller, larger]`. */
function growthRatio(pairs: readonly (readonly [number, number])[]): number {
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

describe("the two-doubling ratio check itself", () => {
  it("fails a quadratic curve and passes a linear one", () => {
    expect(
      growthRatio([
        [1, 16],
        [2, 32],
        [1, 16]
      ]) < LIMIT
    ).toBe(false);
    expect(
      growthRatio([
        [1, 4],
        [2, 8],
        [1, 4]
      ]) < LIMIT
    ).toBe(true);
  });

  it("is not moved by one stalled pair", () => {
    expect(
      growthRatio([
        [1, 4],
        [1, 100],
        [1, 4]
      ]) < LIMIT
    ).toBe(true);
  });

  it.each([
    [1.4, 2.7],
    [2.7, 1.4],
    [1.25, 3.2],
    [3.2, 1.25]
  ])("passes stepped linear growth with doublings of %s and %s", (first, second) => {
    expect(growthRatio([[1, first * second]]) < LIMIT).toBe(true);
  });

  it("requires a ratio strictly below 9", () => {
    expect(growthRatio([[1, 8.999]]) < LIMIT).toBe(true);
    expect(growthRatio([[1, 9]]) < LIMIT).toBe(false);
  });
});

describe("the core's time over two doublings", { timeout: 180_000 }, () => {
  const cases = SHAPES.flatMap(([name, secret, make, preserve]) =>
    (["command", "text"] as const).map((kind) => [name, kind, secret, make, preserve] as const)
  );

  // Sizes are taken smallest first and each two-doubling window is judged as
  // soon as it is measured, so a quadratic walk can fail at 256 KiB before 1 MiB.
  it.each(cases)("%s as %s", (_name, kind, secret, make, preserve) => {
    let previous: string | null = null;
    for (const [index, size] of SIZES.entries()) {
      const text = make(size);
      const first = performance.now();
      const result = redactFragment({ text, kind });
      const firstMs = performance.now() - first;
      expect({ size, firstMs: firstMs < (CEILING_MS_PER_64_KIB * size) / (64 * KiB) ? "under" : firstMs }).toEqual({
        size,
        firstMs: "under"
      });
      expect(result.status).toBe("ok");
      for (const word of typeof secret === "string" ? [secret] : secret) expect(result.text).not.toContain(word);
      if (preserve) expectPreserved(text, result.text, preserve);
      if (index % DOUBLINGS !== 0) continue;
      if (previous) {
        // Up to three sets of pairs. Under the old per-doubling rule, pairing
        // alone still failed one full run in three (a ratio of 3.1 at 256 KiB,
        // on a shape whose batches take a few milliseconds). Keep the retries
        // for transient load; a quadratic walk is over 9 in every set.
        const ratios: number[] = [];
        while (ratios.length < ATTEMPTS && !(ratios.at(-1)! < LIMIT)) {
          ratios.push(growthRatio(timedPairs(previous, text, kind)));
        }
        expect({ size, ratio: ratios.at(-1)! < LIMIT ? "under" : ratios }).toEqual({ size, ratio: "under" });
      }
      previous = text;
    }
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MASK_COPIES = [
  ["capture", ".claude/skills/ops-logging/capture-command.sh"],
  ["archive", ".claude/skills/session-archive/archive-session.sh"]
] as const;

function shippedMask(path: string): string {
  const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
  const start = lines.indexOf("mask() {");
  const end = lines.findIndex((line, index) => index > start && line === "}");
  if (start === -1 || end === -1) throw new Error(`mask() extraction anchors missing in ${path}`);
  return lines.slice(start, end + 1).join("\n");
}

// The actual two hook functions, including their platform sed/awk programs.
// One process per measurement avoids timing an artificial helper in isolation.
// Unlike the synchronous core call, an accidentally quadratic child can be
// terminated at the first-call ceiling. CI runs these on GNU and macOS tools.
describe("the shipped masks' Issue 295 time over two doublings", { timeout: 180_000 }, () => {
  for (const [copy, path] of MASK_COPIES) {
    const source = shippedMask(path);
    const run = (text: string, phase: string) => {
      const start = performance.now();
      try {
        return execFileSync("bash", ["-c", `${source}\nmask`], {
          input: text,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * KiB,
          timeout: Math.max(1000, (CEILING_MS_PER_64_KIB * text.length) / (64 * KiB))
        });
      } catch (cause) {
        throw new Error(
          `${copy}: ${phase}, ${text.length} ASCII bytes, failed after ${(performance.now() - start).toFixed(1)} ms`,
          { cause }
        );
      }
    };
    const measure = (text: string, phase: string) => {
      const start = performance.now();
      run(text, phase);
      return performance.now() - start;
    };

    const cases = [...ISSUE295_SHAPES, NUL_NORMALIZATION_SHAPE].map(
      ([name, secret, make, preserve, hookSecret]) => [name, secret, make, preserve, hookSecret] as const
    );
    it.each(cases)(`${copy}: %s`, (name, secret, make, preserve, hookSecret) => {
      let previous: string | null = null;
      for (const [index, size] of SIZES.entries()) {
        const text = make(size);
        const first = performance.now();
        const output = run(text, `${name}: first call`);
        const firstMs = performance.now() - first;
        expect({ size, firstMs: firstMs < (CEILING_MS_PER_64_KIB * size) / (64 * KiB) ? "under" : firstMs }).toEqual({
          size,
          firstMs: "under"
        });
        for (const word of typeof secret === "string" ? [secret] : secret) expect(output).not.toContain(word);
        if (hookSecret) expect(output).not.toContain(hookSecret);
        expectPreserved(text, output, preserve);
        if (name === NUL_NORMALIZATION_SHAPE[0]) {
          let expected = text.replaceAll("\0", "?");
          for (const word of typeof secret === "string" ? [secret] : secret) expected = expected.replaceAll(word, MASK);
          expect(output).toBe(expected);
          expect(output).not.toContain("\0");
        }
        if (index % DOUBLINGS !== 0) continue;
        if (previous) {
          const ratios: number[] = [];
          while (ratios.length < ATTEMPTS && !(ratios.at(-1)! < LIMIT)) {
            const pairs: [number, number][] = [];
            for (let p = 0; p < PAIRS; p += 1) {
              const phase = `${name}: ratio attempt ${ratios.length + 1}, pair ${p + 1}`;
              if (p % 2 === 0) {
                const small = measure(previous, `${phase}, smaller`);
                pairs.push([small, measure(text, `${phase}, larger`)]);
              } else {
                const large = measure(text, `${phase}, larger`);
                pairs.push([measure(previous, `${phase}, smaller`), large]);
              }
            }
            ratios.push(growthRatio(pairs));
          }
          expect({ size, ratio: ratios.at(-1)! < LIMIT ? "under" : ratios }).toEqual({ size, ratio: "under" });
        }
        previous = text;
      }
    });
  }
});

/** Dense NULs plus a run whose nonempty info must survive normalization. */
function nulArchiveBody(length: number): string {
  const tail = "\n~~~~~~\0info\n## 👤 User — 2026-10-05 00:00:00\nKEEP295NULARCHIVE\n";
  return fill("", "\0x", length - Buffer.byteLength(tail)) + tail;
}

function archiveJq(source: string, opening: string): string {
  const lines = source.split("\n");
  const start = lines.indexOf(opening);
  const end = lines.findIndex((line, index) => index > start && line === "'");
  if (start === -1 || end === -1) throw new Error(`archive jq extraction anchor missing: ${opening}`);
  return lines.slice(start + 1, end).join("\n");
}

function nulPerfForgedTurns(text: string): number {
  let open: { glyph: string; length: number } | null = null;
  let exposed = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const run = /^ {0,3}(~{3,}|`{3,})(.*)$/.exec(line);
    if (open) {
      if (run && run[1][0] === open.glyph && run[1].length >= open.length && /^[ \t]*$/.test(run[2])) open = null;
    } else if (run && !(run[1][0] === "`" && run[2].includes("`"))) {
      open = { glyph: run[1][0], length: run[1].length };
    } else if (line === "## 👤 User — 2026-10-05 00:00:00") {
      exposed++;
    }
  }
  return exposed;
}

describe("the archive's NUL normalization time over two doublings", { timeout: 180_000 }, () => {
  const source = readFileSync(join(ROOT, MASK_COPIES[1][1]), "utf8");
  const common = archiveJq(source, "fence_jq='");
  const renderer = `${common}\n${archiveJq(source, `body_jq="$fence_jq"'`)}`;
  const refence = `${common}\n.a as $a | .b as $b | ${archiveJq(source, `refence_jq="$fence_jq"'`)}`;
  const transcript = (text: string) =>
    JSON.stringify([
      {
        type: "user",
        isMeta: false,
        timestamp: "2026-10-05T00:00:00.000Z",
        message: { content: [{ type: "tool_result", content: text }] }
      }
    ]);

  for (const stage of ["renderer", "refence"] as const) {
    const program = stage === "renderer" ? renderer : refence;
    const option = stage === "renderer" ? "-r" : "-j";
    const run = (input: string, size: number) =>
      execFileSync("jq", [option, program], {
        input,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * KiB,
        timeout: Math.max(1000, (CEILING_MS_PER_64_KIB * size) / (64 * KiB))
      });
    const measure = (input: string, size: number) => {
      const start = performance.now();
      run(input, size);
      return performance.now() - start;
    };

    it(`${stage}: normalizes NUL-dense public bytes without changing fence meaning`, () => {
      let previous: { input: string; size: number } | null = null;
      for (const [index, size] of SIZES.entries()) {
        const body = nulArchiveBody(size);
        expect(Buffer.byteLength(body)).toBe(size);
        const normalized = body.replaceAll("\0", "?");
        // Prepare JSON before timing; argv cannot carry NUL, and its size limit
        // is unrelated to the archive's actual file-input normalization cost.
        const before = `~~~~~~text\n${body}\n~~~~~~\n`;
        const input = stage === "renderer" ? transcript(body) : JSON.stringify({ a: before, b: before });
        const expected = stage === "renderer" ? run(transcript(normalized), size) : before.replaceAll("\0", "?");
        const first = performance.now();
        const output = run(input, size);
        const firstMs = performance.now() - first;
        expect({ size, firstMs: firstMs < (CEILING_MS_PER_64_KIB * size) / (64 * KiB) ? "under" : firstMs }).toEqual({
          size,
          firstMs: "under"
        });
        expect(output).toBe(expected);
        expect(output).not.toContain("\0");
        expect(output).toContain(normalized);
        expect(output).toContain("~~~~~~?info\n## 👤 User");
        expect(nulPerfForgedTurns(output)).toBe(0);
        if (index % DOUBLINGS !== 0) continue;
        if (previous) {
          const ratios: number[] = [];
          while (ratios.length < ATTEMPTS && !(ratios.at(-1)! < LIMIT)) {
            const pairs: [number, number][] = [];
            for (let p = 0; p < PAIRS; p += 1) {
              if (p % 2 === 0) {
                const small = measure(previous.input, previous.size);
                pairs.push([small, measure(input, size)]);
              } else {
                const large = measure(input, size);
                pairs.push([measure(previous.input, previous.size), large]);
              }
            }
            ratios.push(growthRatio(pairs));
          }
          expect({ size, ratio: ratios.at(-1)! < LIMIT ? "under" : ratios }).toEqual({ size, ratio: "under" });
        }
        previous = { input, size };
      }
    });
  }
});
