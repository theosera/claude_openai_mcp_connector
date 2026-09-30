import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SHIPPED_MASK, vocabularyFrom } from "../.claude/skills/_shared/redact-log.mjs";
import { MASK, POLICY_VOCABULARY, redactFragment } from "../packages/log-redaction/src/core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

describe("the core's entry point", () => {
  it("masks a keyword value in either kind", () => {
    for (const kind of ["command", "text"]) {
      expect(redactFragment({ text: "password=CANARY_ONE ok", kind })).toEqual({
        text: `password=${MASK} ok`,
        status: "ok"
      });
    }
  });

  // A fragment with a kind the core was not told about is not read as some other
  // kind: reading `text` as `command` changes how its quotes close.
  it("omits a fragment whose kind is missing or unknown", () => {
    for (const fragment of [{ text: "password=CANARY_ONE" }, { text: "password=CANARY_ONE", kind: "yaml" }]) {
      const result = redactFragment(fragment);
      expect(result.status).toBe("omitted");
      expect(result).toMatchObject({ reason: "unknown_kind" });
      expect(result.text).not.toContain("CANARY_ONE");
    }
  });

  it("omits a fragment that is not an object with a string text", () => {
    for (const fragment of ["password=CANARY_ONE", null, { text: 1, kind: "text" }]) {
      expect(redactFragment(fragment)).toMatchObject({ status: "omitted", reason: "non_string_input" });
    }
  });

  it("omits a fragment over the size limit", () => {
    expect(redactFragment({ text: "password=CANARY_ONE", kind: "text" }, { maxBytes: 4 })).toMatchObject({
      status: "omitted",
      reason: "fragment_over_limit"
    });
  });
});

describe("the core's vocabulary", () => {
  // The core builds its patterns from policy.mjs instead of lifting them from the
  // shell. Until the sed mask() is retired, they must be the patterns the lift
  // returns: the policy test pins the lists, this pins what is built from them.
  it("builds the same anchor and scheme patterns the shell lift returns", () => {
    const lifted = vocabularyFrom(readFileSync(SHIPPED_MASK, "utf8"));
    expect(POLICY_VOCABULARY.anchor.source).toBe(lifted.anchor.source);
    expect(POLICY_VOCABULARY.anchor.flags).toBe(lifted.anchor.flags);
    expect(POLICY_VOCABULARY.scheme?.source).toBe(lifted.scheme?.source);
    expect(POLICY_VOCABULARY.scheme?.flags).toBe(lifted.scheme?.flags);
    expect(POLICY_VOCABULARY.shapes).toEqual(lifted.shapes);
  });
});

describe("the core's command line", () => {
  const run = (stdin: string) =>
    execFileSync("node", ["packages/log-redaction/src/cli.mjs"], { cwd: ROOT, input: stdin, encoding: "utf8" })
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { text: string; status: string; reason?: string });

  it("answers each line in order, and never with its input", () => {
    const results = run(
      [
        JSON.stringify({ text: "password=CANARY_ONE", kind: "command" }),
        "password=CANARY_TWO not json",
        JSON.stringify({ text: "password=CANARY_THREE", kind: "yaml" }),
        JSON.stringify("password=CANARY_FOUR")
      ].join("\n") + "\n"
    );
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ["ok", undefined],
      ["omitted", "fragment_not_json"],
      ["omitted", "unknown_kind"],
      ["omitted", "non_string_input"]
    ]);
    expect(JSON.stringify(results)).not.toMatch(/CANARY/);
  });

  // Each line is its own fragment: a quote left open on one line must not change
  // how the next is read.
  it("reads each fragment on its own", () => {
    const results = run(
      [
        JSON.stringify({ text: 'echo "left open', kind: "command" }),
        JSON.stringify({ text: 'token: FKSEP001 KEEPSEP1 "', kind: "command" })
      ].join("\n") + "\n"
    );
    expect(results[1]).toEqual({ text: `token: ${MASK} KEEPSEP1 "`, status: "ok" });
  });

  // Codex P2 on #254, through the process boundary: the same line sent as `text`
  // and as `command` must come back with different secrets readable. A command
  // line that dropped or fixed the kind would answer both the same way.
  it("lets the kind on each line decide the verdict", () => {
    const line = "don't log it: password: 'FKCLIK01''s FKCLIK02'";
    const [asText, asCommand] = run(
      [JSON.stringify({ text: line, kind: "text" }), JSON.stringify({ text: line, kind: "command" })].join("\n") + "\n"
    );
    const readable = (text: string) => ["FKCLIK01", "FKCLIK02"].filter((word) => text.includes(word));
    expect(readable(asText!.text)).toEqual([]);
    expect(readable(asCommand!.text)).toEqual(["FKCLIK02"]);
  });
});

// One test per reading the quote lexer makes, so that breaking one reading turns
// one test red. The corpus and the fuzz cover the same ground in bulk.
describe("the core's reading of quotes", () => {
  const redact = (text: string, kind: "command" | "text") => redactFragment({ text, kind }).text;

  it("reads a quoted word with no `:` or `=` after it as a search term, not a key", () => {
    const line = 'grep -rn "password" docs/KEEPQ001 | head -n 3';
    expect(redact(line, "command")).toBe(line);
  });

  it("reads a quoted key followed by `:` as a key", () => {
    expect(redact(`{"token": "FKQ00002", "KEEPQ002": 1}`, "text")).toBe(`{"token": "${MASK}", "KEEPQ002": 1}`);
  });

  it("finds no value inside a label's quote that closes right after the separator", () => {
    expect(redact('echo "Enter passphrase: "; gpg --passphrase "FKQ00003"', "command")).toBe(
      `echo "Enter passphrase: "; gpg --passphrase "${MASK}"`
    );
  });

  it("masks the rest of a label's quote when the value is inside it", () => {
    expect(redact('echo "token: FKQ00004" >> f', "command")).toBe(`echo "token: ${MASK}" >> f`);
  });

  it("joins the quoted and unquoted pieces of a shell word", () => {
    expect(redact("export DB_PASSWORD='FKQ00005'\\''FKQ00006' KEEPQ005", "command")).toBe(
      `export DB_PASSWORD='${MASK}' KEEPQ005`
    );
  });

  it("follows a shell word past a label's closing quote", () => {
    expect(redact("echo 'token='\\''FKQ00007'\\'' KEEPQ007", "command")).toBe(`echo 'token='${MASK} KEEPQ007`);
  });

  it("reads a doubled quote inside a text scalar as part of the value", () => {
    expect(redact("password: 'FKQ00008''FKQ00009 with x'", "text")).toBe(`password: '${MASK}'`);
  });

  it("reads a doubled quote before a blank and a later word's quote as the end of a command value", () => {
    expect(redact("mysql --password='FKQ00010'' -h KEEPQ010 -e 'KEEPQ011'", "command")).toBe(
      `mysql --password='${MASK} -h KEEPQ010 -e 'KEEPQ011'`
    );
  });

  it("does not read a text apostrophe as a quote", () => {
    expect(redact("don't: password: 'FKQ00012 FKQ00013'", "text")).toBe(`don't: password: '${MASK}'`);
  });

  it("keeps a run of five dashes inside a value", () => {
    expect(redact('gpg --passphrase "FKQ00014-----FKQ00015" --batch', "command")).toBe(
      `gpg --passphrase "${MASK}" --batch`
    );
  });

  it("starts every line outside quotes", () => {
    expect(redact('echo "open\ntoken: FKQ00016 KEEPQ016 "', "command")).toBe(`echo "open\ntoken: ${MASK} KEEPQ016 "`);
  });
});
