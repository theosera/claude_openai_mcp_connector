import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MASK, redactFragment } from "../packages/log-redaction/src/core.mjs";
import { judgeCase } from "./tools/redactionJudge.js";
import { ARGUMENT_POSITION_CASES, ARGUMENT_POSITION_FAMILIES } from "./tools/redactionScope.js";

/**
 * Steps ②-3 and ②-4 of #249: the complete corpus through the public entry point.
 *
 * The migration gate asks whether the core is worse than the sed `mask()`. This
 * asks whether it is right: in every case, including argument position,
 * no secret word is readable and no preserve word is lost. The sed `mask()`'s own
 * leaks are not an allowance -- sections E, K, M and O are here because it leaves
 * them readable.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

type Case = {
  id: string;
  family?: string;
  kind: "command" | "text";
  input: string;
  secrets: string[];
  preserve: string[];
};

function load(path: string): Case[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Case);
}

const corpus = load(join(HERE, "fixtures", "redaction-corpus", "corpus.jsonl"));
const fuzzSample = load(join(HERE, "fixtures", "redaction-fuzz", "seed-1.jsonl"));

function verdict(c: Case) {
  const result = redactFragment({ text: c.input, kind: c.kind });
  return { result, ...judgeCase(c.input, result, c.secrets, c.preserve) };
}

describe("the core on the corpus", () => {
  it("allows no argument-position exemptions", () => {
    expect([...ARGUMENT_POSITION_CASES]).toEqual([]);
    expect([...ARGUMENT_POSITION_FAMILIES]).toEqual([]);
  });

  it("masks every secret and keeps every preserve word", () => {
    expect(corpus).toHaveLength(217);
    const failures = corpus
      .map((c) => ({ id: c.id, ...verdict(c) }))
      .filter((v) => v.result.status !== "ok" || v.leaked.length > 0 || v.broken.length > 0)
      .map(({ id, leaked, broken, result }) => ({ id, status: result.status, leaked, broken }));
    expect(failures).toEqual([]);
  });
});

// The committed fuzz sample: ten cases from each of the 29 families. The full
// runs (several seeds, 16,000 cases each) are run by hand; see the fuzz README.
describe("the core on the fuzz sample", () => {
  it("contains no less-than character, so does not exercise the markup rules", () => {
    expect(fuzzSample).toHaveLength(290);
    expect(fuzzSample.filter((c) => c.input.includes("<")).map((c) => c.id)).toEqual([]);
    expect(fuzzSample.filter((c) => c.input.includes("&lt;")).map((c) => c.id)).toEqual([]);
  });

  it("masks every secret and keeps every preserve word in every family", () => {
    expect(new Set(fuzzSample.map((c) => c.family)).size).toBe(29);
    const failures = fuzzSample
      .map((c) => ({ id: c.id, family: c.family!, ...verdict(c) }))
      .filter((v) => v.result.status !== "ok" || v.broken.length > 0 || v.leaked.length > 0)
      .map(({ id, family, leaked, broken }) => ({ id, family, leaked, broken }));
    expect(failures).toEqual([]);
  });
});

/**
 * Exact outputs for all ten H cases, from the reference expectations
 * Codex wrote down for #249 (2026-09-29). Checking that a secret word is gone
 * does not see a mask that ate too much or a quote that moved; these do.
 */
const EXACT: readonly (readonly [string, string])[] = [
  ["H-H01", `gpg --passphrase "${MASK}" --decrypt f`],
  ["H-H02", `passwd: '${MASK}'`],
  ["H-H03", `mysql -p'${MASK}' db`],
  ["H-H04", `redis-cli \\\n  -a ${MASK}`],
  ["H-H05", `curl -u user:'${MASK}' https://example.test/`],
  ["H-H06", `{'password': '${MASK}'}`],
  ["H-H07", `export DB_PASSWORD='${MASK}'`],
  ["H-H08", `grep -q "token: " f || echo "token: ${MASK}" >> f`],
  ["H-H09", "mkdir -p build && ssh -p2222 host && sort -u a:b f"],
  ["H-H10", `password=${MASK}`]
];

describe("the core's exact output on the H cases", () => {
  it.each(EXACT)("%s", (id, expected) => {
    const c = corpus.find((x) => x.id === id)!;
    expect(redactFragment({ text: c.input, kind: c.kind })).toEqual({ text: expected, status: "ok" });
  });
});

// Codex P2 on #254 (discussion_r4128491954): the kind must decide something a
// judge can see. In `text`, the apostrophe in `don't` is not a quote, so the
// label is outside quotes and its value is the whole YAML scalar, doubled `''`
// and all. Read as a shell command, that apostrophe opens a quote that the
// scalar's opening quote closes: the label is then inside a quoted string, and
// the second word of the value is left outside every quote.
describe("the kind", () => {
  const line = "don't log it: password: 'FKKINDA1''s FKKINDB2'";

  it("reads a text line's YAML scalar as one value", () => {
    const result = redactFragment({ text: line, kind: "text" });
    expect(judgeCase(line, result, ["FKKINDA1", "FKKINDB2"], ["don't"])).toEqual({
      leaked: [],
      broken: [],
      omitted: false
    });
  });

  it("gives a different verdict on the same line read as a command", () => {
    const result = redactFragment({ text: line, kind: "command" });
    expect(judgeCase(line, result, ["FKKINDA1", "FKKINDB2"], ["don't"]).leaked).toEqual(["FKKINDB2"]);
  });
});

describe("a fault inside the core", () => {
  // A shape the caller did not validate throws inside the collector. The result
  // must be an omission, never the original text.
  it("omits the body instead of returning the original", () => {
    const vocabulary = {
      anchor: /x/g,
      scheme: null,
      schemeWords: [],
      shapes: [{ kind: "credential:shape", source: "(" }]
    };
    const result = redactFragment({ text: "token: FKFAULT01 KEEPFAULT", kind: "command" }, { vocabulary });
    expect(result.status).toBe("omitted");
    expect(result.text).not.toContain("FKFAULT01");
    expect(result.text).not.toContain("KEEPFAULT");
  });
});
