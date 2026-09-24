/**
 * Reverse-verify every guard in the session-archive hook's `defang` in one command:
 * take each guard out of the REAL hook, run the text-turn suites against it, and
 * print which tests go red.
 *
 *   pnpm exec tsx tests/tools/defangMutants.ts
 *
 * The suite already carries a companion per guard that removes it from the
 * extracted program and expects a forge. That shows the ORACLE can see the
 * escape. It does not show that the suite's positive rows -- the ones that run
 * the shipped hook -- would notice the guard gone, and that is what a guard
 * regressing in the file actually looks like. This runs that case: the hook
 * itself is mutated, the positive rows run over it, and a guard whose removal
 * reddens no positive row is reported as unpinned.
 *
 * Nothing is edited in place. The working tree's hook is read, mutated, and
 * written into a scratch copy of the files the suite needs (tests/ and the hook
 * are copied; src/ and node_modules/ are symlinked), so the checkout -- shared or
 * not -- is never touched and nothing is left to restore.
 *
 * Exit status is 0 only if all three hold: the unmutated baseline is green (the
 * instrument does not red on a clean hook); every guard's removal reddens the row
 * named for it (the instrument can red, and reds for the right reason); and the
 * CONTROL edit -- a comment line no behaviour depends on -- comes back UNPINNED
 * (the verdict path can report a guard nothing pins; if it reddens, the run is
 * reading something other than behaviour). A mutation whose target string is
 * missing or appears twice fails loudly rather than being skipped: a skipped
 * mutation would print as held having tested nothing.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hookRelative = path.join(".claude", "skills", "session-archive", "archive-session.sh");
const SUITE = "tests/sessionArchive.test.ts";
const FILTER = "text-turn";

/**
 * Each guard, spelled exactly as the shipped hook spells it, and what taking it out
 * leaves. These are the same edits the suite's companions make, written against the
 * shell file (whose jq program is single-quoted, so a backslash here is one byte
 * there). `expectRow` names the parity row, or the one test, that must go red: the
 * red has to be THIS guard's absence, not any red at all.
 */
const MUTATIONS: Array<{ guard: string; from: string; to: string; expectRow: string }> = [
  {
    guard: "the ATX rule",
    from: '| sub("^(?<s> {0,3})(?<h>#{1,6}[ \\t])"; "\\(.s)\\\\\\(.h)")',
    to: "| .",
    expectRow: "leaves every reader at zero for an ATX heading"
  },
  {
    guard: "the unbalanced-fence guard",
    from: "if $unbalanced and",
    to: "if false and",
    expectRow: "leaves every reader at zero for an unclosed backtick run delimited by LF"
  },
  {
    guard: "the setext guard",
    from: "if ($i > 0) and ($L[$i-1]",
    to: "if false and ($L[$i-1]",
    expectRow: "leaves every reader at zero for a setext underline delimited by LF"
  },
  {
    guard: "the raw-HTML guard",
    from: '| if test("^ {0,3}<(?:[!?]|/?[A-Za-z])") then esc_bs else . end',
    to: "| .",
    expectRow: "leaves every reader at zero for a raw HTML block opener delimited by LF"
  },
  {
    guard: "the indented-opener rule",
    from: 'elif ($m.pad | length) > 0 then {o:"?", n:0}',
    to: 'elif false then {o:"?", n:0}',
    expectRow: "leaves every reader at zero for a backtick fence opened inside a list item"
  },
  {
    guard: "the CommonMark blank-line test",
    from: '($L[$i-1] | test("[^ \\t]"))',
    to: '($L[$i-1] | test("[^[:space:]]"))',
    expectRow: "leaves every reader at zero for a setext underline under a line of only an ideographic space"
  },
  {
    guard: "the CR-run rule",
    from: 'elif $crL[$i] or ($m.info | test("[\\u2028\\u2029]")) then {o:"?", n:0}',
    to: 'elif false then {o:"?", n:0}',
    expectRow: "leaves every reader at zero for a fence run with CRLF endings on a block that closes the turn"
  },
  {
    guard: "the CRLF tail drop",
    from: 'length > 1 and .[-1] == ""',
    to: "false",
    expectRow: "leaves every reader at zero for a CRLF setext underline"
  },
  {
    guard: "the ambiguous-close marker",
    from: 'else {o:"?", n:0} end)',
    to: "else {o:null, n:0} end)",
    expectRow: "leaves every reader at zero for a fence closed with a form feed"
  },
  {
    guard: "the may-end-fence rule",
    from: "| may_end_fence) then",
    to: "| ends_fence) then",
    expectRow: "leaves every reader at zero for three runs whose middle one is form-fed"
  },
  {
    guard: "the linear reconstruction",
    from:
      "    | [ foreach range(0; $sizes|length) as $k (0; . + $sizes[$k];\n" +
      '          . as $end | ($E[($end - $sizes[$k]) : $end] | join("\\r")) + $tails[$k]) ]\n' +
      '    | join("\\n");',
    to:
      "    | reduce range(0; $sizes|length) as $k ({out: [], p: 0};\n" +
      '        {out: (.out + [ ($E[.p : .p + $sizes[$k]] | join("\\r")) + $tails[$k] ]), p: (.p + $sizes[$k])})\n' +
      '    | .out | join("\\n");',
    expectRow: "keeps the cost of a long text turn linear in its line count"
  }
];

/** Changes only a comment inside the jq program: must red nothing. */
const CONTROL = {
  guard: "CONTROL (a comment line, no guard)",
  from: "    # ANSI colour and line-clear sequences are removed here, per line and BEFORE",
  to: "    # ANSI colour and line-clear sequences are stripped here, per line and BEFORE"
};

/** A companion that throws because its guard is already gone is red by design, not a finding. */
const COMPANION_THROW = "is already gone from the shipped defang";

interface Outcome {
  failed: Array<{ name: string; companion: boolean }>;
  passed: number;
}

function scratchCopy(hook: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "defang-mutants-"));
  // Copied, not linked: vitest resolves a symlinked test file to its real path,
  // and the suite finds the hook relative to the test file -- a linked tests/
  // would read the unmutated hook and every mutation would come back green.
  fs.cpSync(path.join(repoRoot, "tests"), path.join(dir, "tests"), { recursive: true });
  for (const file of ["package.json", "tsconfig.json", "tsconfig.test.json", "vitest.config.ts"]) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(dir, file));
  }
  for (const linked of ["src", "node_modules", "fixtures"]) {
    fs.symlinkSync(path.join(repoRoot, linked), path.join(dir, linked));
  }
  fs.mkdirSync(path.dirname(path.join(dir, hookRelative)), { recursive: true });
  fs.writeFileSync(path.join(dir, hookRelative), hook);
  return dir;
}

function runSuite(hook: string): Outcome {
  const dir = scratchCopy(hook);
  const report = path.join(dir, "report.json");
  try {
    try {
      execFileSync(
        path.join(repoRoot, "node_modules", ".bin", "vitest"),
        ["run", SUITE, "-t", FILTER, "--reporter=json", `--outputFile=${report}`],
        { cwd: dir, stdio: "pipe" }
      );
    } catch {
      // A red run exits non-zero; the report below is what says which tests.
    }
    if (!fs.existsSync(report)) {
      throw new Error("vitest wrote no report -- the run did not reach the suite, so it measured nothing.");
    }
    const parsed = JSON.parse(fs.readFileSync(report, "utf8")) as {
      testResults: Array<{
        assertionResults: Array<{ status: string; fullName: string; failureMessages: string[] }>;
      }>;
    };
    const results = parsed.testResults.flatMap((file) => file.assertionResults);
    const ran = results.filter((result) => result.status === "passed" || result.status === "failed");
    if (ran.length === 0) {
      throw new Error(`the filter "${FILTER}" selected no test -- a zero here is not a green.`);
    }
    return {
      passed: ran.filter((result) => result.status === "passed").length,
      failed: ran
        .filter((result) => result.status === "failed")
        .map((result) => ({
          name: result.fullName,
          companion: result.failureMessages.some((message) => message.includes(COMPANION_THROW))
        }))
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mutate(hook: string, from: string, to: string, guard: string): string {
  const hits = hook.split(from).length - 1;
  if (hits !== 1) {
    throw new Error(`${guard}: its spelling occurs ${hits} times in the hook, not once -- update MUTATIONS.`);
  }
  return hook.replace(from, () => to);
}

const shipped = fs.readFileSync(path.join(repoRoot, hookRelative), "utf8");
let exit = 0;

const baseline = runSuite(shipped);
console.log(`baseline (no mutation): ${baseline.passed} passed, ${baseline.failed.length} failed`);
for (const failure of baseline.failed) console.log(`  RED ${failure.name}`);
if (baseline.failed.length > 0) {
  console.log("the unmutated hook is not green -- every row below would be uninterpretable. Stopping.");
  process.exit(2);
}

for (const { guard, from, to, expectRow } of MUTATIONS) {
  const outcome = runSuite(mutate(shipped, from, to, guard));
  const asserted = outcome.failed.filter((failure) => !failure.companion);
  const companions = outcome.failed.length - asserted.length;
  const named = asserted.some((failure) => failure.name.endsWith(expectRow));
  const verdict = asserted.length === 0 ? "UNPINNED" : named ? "pinned" : "RED ELSEWHERE";
  if (verdict !== "pinned") exit = 1;
  console.log(
    `\n${verdict.padEnd(13)} ${guard}: ${asserted.length} red on an assertion, ` +
      `${companions} companion(s) red because the guard is gone, ${outcome.passed} passed`
  );
  for (const failure of asserted) console.log(`  RED ${failure.name}`);
  if (!named) console.log(`  expected red, not seen: ${expectRow}`);
}

const control = runSuite(mutate(shipped, CONTROL.from, CONTROL.to, CONTROL.guard));
const controlHeld = control.failed.length === 0;
if (!controlHeld) exit = 1;
console.log(
  `\n${(controlHeld ? "UNPINNED" : "CONTROL RED").padEnd(13)} ${CONTROL.guard}: ${control.failed.length} red, ` +
    `${control.passed} passed -- expected UNPINNED`
);
for (const failure of control.failed) console.log(`  RED ${failure.name}`);

process.exit(exit);
