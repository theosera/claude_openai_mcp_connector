import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { broken, judgeCase, MASK, occurrences, readable } from "./tools/redactionJudge.js";

/**
 * The shared judge, on its own: what it reports for engines whose answer is known.
 * A judge that cannot tell these engines apart is not reading the outputs.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

type CorpusCase = { id: string; input: string; secrets: string[]; preserve: string[] };

const cases: CorpusCase[] = readFileSync(join(HERE, "fixtures", "redaction-corpus", "corpus.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as CorpusCase);

const withSecrets = cases.filter((c) => c.secrets.length > 0);
const withPreserve = cases.filter((c) => c.preserve.length > 0);

describe("the shared judge over the corpus, with engines whose answer is known", () => {
  it("has cases on both axes to judge", () => {
    expect(withSecrets.length).toBeGreaterThan(0);
    expect(withPreserve.length).toBeGreaterThan(0);
  });

  // Every corpus word is in its input, or judgeCase would throw here.
  it("charges an engine that returns its input with every secret and no broken word", () => {
    for (const c of cases) {
      const v = judgeCase(c.input, { text: c.input, status: "ok" }, c.secrets, c.preserve);
      expect(v, c.id).toEqual({ leaked: c.secrets, broken: [], omitted: false });
    }
  });

  it("charges an engine that returns nothing with every preserve word and no leak", () => {
    for (const c of cases) {
      const v = judgeCase(c.input, { text: "", status: "ok" }, c.secrets, c.preserve);
      expect(v, c.id).toEqual({ leaked: [], broken: c.preserve, omitted: false });
    }
  });

  it("charges an engine that masks the whole line with every preserve word and no leak", () => {
    for (const c of cases) {
      const v = judgeCase(c.input, { text: MASK, status: "ok" }, c.secrets, c.preserve);
      expect(v, c.id).toEqual({ leaked: [], broken: c.preserve, omitted: false });
    }
  });

  it("reports an engine that omits every body as omitted, not as broken or leaked", () => {
    for (const c of cases) {
      const v = judgeCase(
        c.input,
        { text: "***LOG_CONTENT_OMITTED: test***", status: "omitted" },
        c.secrets,
        c.preserve
      );
      expect(v, c.id).toEqual({ leaked: [], broken: [], omitted: true });
    }
  });
});

describe("the shared judge, one rule at a time", () => {
  it("still charges a leak when the engine says omitted but prints the input", () => {
    expect(judgeCase("pw FKSECRET1", { text: "pw FKSECRET1", status: "omitted" }, ["FKSECRET1"], [])).toEqual({
      leaked: ["FKSECRET1"],
      broken: [],
      omitted: true
    });
  });

  it("does not join the text on either side of a mask token into a secret", () => {
    // Removing the token would read `F***MASKED***Kx` as `FKx`.
    expect(readable(`F${MASK}Kx`, ["FKx"])).toEqual([]);
    expect(readable(`F${MASK}Kx FKx`, ["FKx"])).toEqual(["FKx"]);
  });

  it("does not count a secret word that occurs only inside a mask token", () => {
    expect(readable(`key: ${MASK}`, ["ASK", "MASKED"])).toEqual([]);
  });

  it("charges a preserve word the output keeps fewer copies of than the input had", () => {
    const input = "KEEPAA1 x=FKSECRET1 KEEPAA1";
    expect(broken(input, `KEEPAA1 x=${MASK}`, ["KEEPAA1"])).toEqual(["KEEPAA1"]);
    expect(broken(input, `KEEPAA1 x=${MASK} KEEPAA1`, ["KEEPAA1"])).toEqual([]);
  });

  it("refuses a word that is not in the input, which would be green for any redactor", () => {
    expect(() => judgeCase("abc", { text: "abc", status: "ok" }, ["FKMISSING"], [])).toThrow("never judged");
    expect(() => judgeCase("abc", { text: "", status: "ok" }, [], ["KEEPMISSING"])).toThrow("never judged");
  });

  it("refuses a preserve word that is part of a secret, or contains one", () => {
    expect(() => judgeCase("x FKAB12 y", { text: "", status: "ok" }, ["FKAB12"], ["AB1"])).toThrow("tangled");
    expect(() => judgeCase("x FKAB12 y", { text: "", status: "ok" }, ["AB1"], ["FKAB12"])).toThrow("tangled");
  });

  it("refuses to count an empty word", () => {
    expect(() => occurrences("abc", "")).toThrow("empty word");
  });
});
