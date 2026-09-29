import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { commandEngine, type Engine, type EngineResult, MASK, readable } from "./tools/redactionJudge.js";

/**
 * Step ②-2 of #249: the migration gate's judge.
 *
 * The gate compares two redactors over the review corpus. One is the sed `mask()`
 * as it ships. The other is the engine, and the gate only watches one direction:
 * a secret word that the sed `mask()` hides but the engine leaves in the clear.
 *
 * The engine is reached through its command line only: NDJSON strings on stdin,
 * one `{text, status}` per line on stdout. The judge does not import it, so it
 * does not depend on the language the engine is written in.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
type CorpusCase = { id: string; kind: string; input: string; secrets: string[]; preserve: string[] };

const cases: CorpusCase[] = readFileSync(join(HERE, "fixtures", "redaction-corpus", "corpus.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as CorpusCase);

/** The mask() function as it ships, extracted from the capture hook (the archive copy is byte-identical). */
function shippedMask(): string {
  const lines = readFileSync(join(ROOT, ".claude", "skills", "ops-logging", "capture-command.sh"), "utf8").split("\n");
  const start = lines.indexOf("mask() {");
  const end = lines.findIndex((line, index) => index > start && line === "}");
  if (start === -1 || end === -1)
    throw new Error("mask() not found in capture-command.sh: the extraction anchor moved.");
  return lines.slice(start, end + 1).join("\n");
}

const maskFn = shippedMask();
const sedOutputs = cases.map((c) =>
  execFileSync("bash", ["-c", `${maskFn}\nmask`], { input: c.input, encoding: "utf8" })
);

type Gap = { id: string; words: string[] };

/** The gate's one direction: secret words the sed mask() hides and the engine leaves readable. */
function judge(engine: Engine): { gaps: Gap[]; results: EngineResult[] } {
  const results = engine(cases.map((c) => c.input));
  if (results.length !== cases.length) {
    throw new Error(`the engine returned ${results.length} results for ${cases.length} inputs`);
  }
  const gaps = cases
    .map((c, index) => {
      const bySed = readable(sedOutputs[index]!, c.secrets);
      const byEngine = readable(results[index]!.text, c.secrets);
      return { id: c.id, words: byEngine.filter((word) => !bySed.includes(word)) };
    })
    .filter((gap) => gap.words.length > 0);
  return { gaps, results };
}

/** Every secret word the sed mask() hides, per case: what a gate that works must report for an engine that hides nothing. */
const hiddenBySed: Gap[] = cases
  .map((c, index) => ({
    id: c.id,
    words: c.secrets.filter((w) => !readable(sedOutputs[index]!, c.secrets).includes(w))
  }))
  .filter((gap) => gap.words.length > 0);

describe("the migration gate's judge", () => {
  // Positive control. An engine that returns its input unchanged must be charged
  // with every word the sed mask() hides. A judge that reports less than that
  // is not reading the outputs it claims to compare.
  it("charges an engine that masks nothing with every secret the sed mask() hides", () => {
    const { gaps } = judge((inputs) => inputs.map((text) => ({ text, status: "ok" })));
    expect(hiddenBySed.length).toBeGreaterThan(0);
    expect(gaps).toEqual(hiddenBySed);
  });

  // Negative control. The sed mask() compared with itself has no gap.
  it("finds no gap when the engine is the sed mask() itself", () => {
    const { gaps } = judge(() => sedOutputs.map((text) => ({ text, status: "ok" })));
    expect(gaps).toEqual([]);
  });

  // An omission drops the body, so it hides every secret: the judge must not
  // count it as a leak. (Preserve words are lost too, which this gate does not measure.)
  it("does not charge an engine that omits every body", () => {
    const { gaps } = judge((inputs) =>
      inputs.map(() => ({ text: "***LOG_CONTENT_OMITTED: test***", status: "omitted" }))
    );
    expect(gaps).toEqual([]);
  });

  // No corpus case has a secret word inside the mask token, so the cases above
  // stay green without the token being removed. This one does not.
  it("does not count a secret word that occurs only inside a mask token", () => {
    expect(readable(`key: ${MASK} and ${MASK}`, ["ASK", "MASKED"])).toEqual([]);
    expect(readable(`key: ${MASK} ASK`, ["ASK"])).toEqual(["ASK"]);
  });

  // Removing the token would join its neighbours: `AB***MASKED***CD` would read
  // as `ABCD` and charge the engine with a `BC` that is not in its output.
  it("does not join the text on either side of a mask token into a word", () => {
    expect(readable(`AB${MASK}CD`, ["BC"])).toEqual([]);
  });

  it("refuses an engine that returns the wrong number of results", () => {
    expect(() => judge((inputs) => inputs.slice(1).map((text) => ({ text, status: "ok" })))).toThrow(
      `${cases.length - 1} results`
    );
  });
});

describe("the current engine, through its command line", () => {
  const engine = commandEngine(["node", ".claude/skills/_shared/redact-log.mjs"], ROOT);

  it("answers every corpus case with ok or omitted", () => {
    const { results } = judge(engine);
    expect(results.filter((r) => r.status !== "ok" && r.status !== "omitted")).toEqual([]);
  });
});
