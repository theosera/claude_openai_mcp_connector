import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SHIPPED_MASK, vocabularyFrom } from "../.claude/skills/_shared/redact-log.mjs";
import {
  collectCredentialSpans,
  MASK,
  POLICY_VOCABULARY,
  redactFragment
} from "../packages/log-redaction/src/core.mjs";

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

  // An empty line gets no answer, and neither does one of blanks only (a CRLF's
  // `\r` among them): otherwise the count of answers turned on invisible text.
  it("answers no line that holds only blanks", () => {
    const results = run(["", "\r", "  \t", JSON.stringify({ text: "KEEPBL01", kind: "text" }), ""].join("\n"));
    expect(results).toEqual([{ text: "KEEPBL01", status: "ok" }]);
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

// Shapes an independent review of step 2-3 found the sed mask() masking and the
// core leaving readable, or the core over-masking (#249, 2026-10-01). None was in
// the corpus or the fuzz grammar then; the corpus's section N now holds the first
// five. One case each, output pinned whole.
describe("the core on the step 2-3 review's shapes", () => {
  const B64 = "QUJD".repeat(16);
  const cases: readonly (readonly [string, "command" | "text", string, string])[] = [
    [
      "JSON inside a single-quoted argument",
      "command",
      `curl -d '{"password": "FKRV0001", "user": "KEEPRV01"}' https://h/x`,
      `curl -d '{"password": "${MASK}", "user": "KEEPRV01"}' https://h/x`
    ],
    [
      "JSON inside a quoted argument, in text",
      "text",
      `curl -d '{"password": "FKRV0002"}' https://h/x`,
      `curl -d '{"password": "${MASK}"}' https://h/x`
    ],
    [
      "a dict inside a double-quoted argument",
      "command",
      `python3 -c "print({'client_secret': 'FKRV0003'})"`,
      `python3 -c "print({'client_secret': '${MASK}'})"`
    ],
    [
      "escaped JSON inside a double-quoted argument",
      "command",
      `x --data "{\\"token\\": \\"FKRV0004\\"}"`,
      `x --data "{\\"token\\": \\"${MASK}\\"}"`
    ],
    [
      "a search term inside a quoted argument",
      "command",
      `bash -c 'grep "password" docs/KEEPRV05'`,
      `bash -c 'grep "password" docs/KEEPRV05'`
    ],
    ["a key body line behind a line number", "text", `     7\t${B64}`, `     7\t${MASK}`],
    ["a key body line behind a grep prefix", "command", `src/id:4:${B64}`, `src/id:4:${MASK}`],
    ["an ideographic space after the separator", "text", "password:\u3000FKRV0006", `password:\u3000${MASK}`],
    ["a no-break space after the separator", "text", "token:\u00a0FKRV0007", `token:\u00a0${MASK}`],
    ["a semicolon inside an unquoted text value", "text", "password: FKRV0008;FKRV0009", `password: ${MASK}`],
    [
      "a comma inside an unquoted command value",
      "command",
      "export PASSWORD=FKRV0010,FKRV0011",
      `export PASSWORD=${MASK}`
    ],
    [
      "a scheme word behind a bracket",
      "text",
      "{Authorization=[Bearer FKRV0012], Accept=[KEEPRV12]}",
      `{Authorization=[Bearer ${MASK} Accept=[KEEPRV12]}`
    ],
    [
      "an option that is itself a label",
      "command",
      "gpg --passphrase --key FKRV0013",
      `gpg --passphrase ${MASK} ${MASK}`
    ],
    ["a value that is itself a label", "text", "passwd=secret: FKRV0014", `passwd=${MASK} ${MASK}`],
    ["a backslash-escaped quote in a text scalar", "text", "password: 'FKRV0015\\'FKRV0016'", `password: '${MASK}'`],
    ["a value glued to a label's closing quote", "text", `"token: "FKRV0017`, `"token: "${MASK}`],
    ["a quoted key and value with a tab between", "text", `set "secret"\t"FKRV0018"`, `set "secret"\t"${MASK}"`],
    ["an inch mark earlier on the line", "text", `27" monitor, api_key: "FKRV0019"`, `27" monitor, api_key: "${MASK}"`],
    [
      "a label in a commit subject takes one word",
      "command",
      `git commit -m "Mask a quoted passphrase / passwd value to its closing quote (#248)"`,
      `git commit -m "Mask a quoted passphrase ${MASK} passwd ${MASK} to its closing quote (#248)"`
    ],
    ["a hash arrow as the separator", "text", `password => "FKRV0021"`, `password => "${MASK}"`],
    [
      "a scheme word behind a quote that opens nothing",
      "command",
      `Authorization => "Bearer FKRV0022`,
      `Authorization => "Bearer ${MASK}`
    ],
    ["a word glued to a one-word scalar", "text", "API_KEY:'FKRV0023'FKRV0024''", `API_KEY:'${MASK}`]
  ];

  it.each(cases)("%s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ text: expected, status: "ok" });
  });

  it("keeps the file name of a redirection", () => {
    expect(redactFragment({ text: "./gen_token > KEEPRV20.txt", kind: "command" }).text).toContain("KEEPRV20.txt");
  });

  it("refuses a call with no kind rather than skipping the labels", () => {
    // The declaration requires the options and their kind; the call is here to
    // see the refusal at run time too, for a caller that is not type-checked.
    // @ts-expect-error -- the options are left out on purpose.
    expect(() => collectCredentialSpans("password: FKRV0025")).toThrow(TypeError);
    // @ts-expect-error -- the kind is left out on purpose.
    expect(() => collectCredentialSpans("password: FKRV0026", {})).toThrow(TypeError);
  });
});

// A second independent review, of the fixes above (#249, 2026-10-01), found them
// adding faults of their own; and the first review's probe, run on the fixed core,
// found shapes where it had become worse than before. One case each.
describe("the core on the second review's shapes", () => {
  const B64 = "QUJD".repeat(10);
  const cases: readonly (readonly [string, "command" | "text", string, string])[] = [
    [
      "a text scalar ending in an escaped backslash",
      "text",
      "password: 'FKRV0030\\\\' and token: 'FKRV0031'",
      `password: '${MASK}' and token: '${MASK}'`
    ],
    ["a label glued to a text scalar's closing quote", "text", "passwd='x'secret: FKRV0032", `passwd='${MASK} ${MASK}`],
    ["a base64 line that starts with digits", "text", `1234${B64}`, MASK],
    [
      "a value that is a label word",
      "command",
      "POSTGRES_PASSWORD=secret KEEPRV33 -p",
      `POSTGRES_PASSWORD=${MASK} KEEPRV33 -p`
    ],
    ["a value that ends in a label word", "command", "TOKEN=my_token KEEPRV34", `TOKEN=${MASK} KEEPRV34`],
    ["a prompt's > right after the label", "text", "password> FKRV0035", `password> ${MASK}`],
    [
      "a plist key that holds a label names the next element's text",
      "text",
      "<key>token</key><string>FKRV0036</string> KEEPRV36",
      `<key>token</key><string>${MASK}</string> KEEPRV36`
    ],
    [
      "a prefixed string in text",
      "text",
      'print(f"password: FKRV0037 FKRV0038") KEEPRV37',
      `print(f"password: ${MASK}") KEEPRV37`
    ],
    [
      "a text value whose quote never closes",
      "text",
      'passphrase: "FKRV0039 FKRV0040\nKEEPRV38',
      `passphrase: "${MASK}\nKEEPRV38`
    ],
    ["an empty pair before the value", "text", "'x  token: ''FKRV0041 KEEPRV39", `'x  token: ''${MASK} KEEPRV39`],
    [
      "a comma glued after a quoted command value",
      "command",
      "export PASSWORD='FKRV0042',FKRV0043 KEEPRV40",
      `export PASSWORD='${MASK} KEEPRV40`
    ],
    [
      "a scheme word in a quoted list item",
      "text",
      '"Authorization": ["Bearer FKRV0044"], "x": "KEEPRV41"',
      `"Authorization": ["Bearer ${MASK}"], "x": "KEEPRV41"`
    ],
    [
      "a label glued to a command value's closing quote",
      "command",
      "passwd='x'secret: FKRV0045 KEEPRV42",
      `passwd='${MASK} ${MASK} KEEPRV42`
    ],
    ["an ideographic space after a base64 line", "text", `FKRV0046${B64}\u3000`, `${MASK}\u3000`],
    [
      "a quoted key, blanks and a quoted value",
      "text",
      'set "secret"  "FKRV0047" KEEPRV43',
      `set "secret"  "${MASK}" KEEPRV43`
    ],
    ["a long run of digits that is not base64", "text", `${"7".repeat(100)}!`, `${"7".repeat(100)}!`],
    [
      "a value that is a shell ANSI-C string with a scheme word",
      "text",
      "src/a.ts:3: TOKEN=  $'Bearer FKRV0049' KEEPRV45",
      `src/a.ts:3: TOKEN=  $'Bearer ${MASK}' KEEPRV45`
    ]
  ];

  it.each(cases)("%s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ text: expected, status: "ok" });
  });
});

// A third independent review, of the fixes above (#249, 2026-10-01), found values
// the core read before those fixes and stopped reading after them. One case each.
describe("the core on the third review's shapes", () => {
  const cases: readonly (readonly [string, "command" | "text", string, string])[] = [
    [
      "an option glued after a quoted value",
      "text",
      "password='x'--token FKRV0050 KEEPRV50",
      `password='${MASK} ${MASK} KEEPRV50`
    ],
    ["a label as an element name", "text", "<password>FKRV0051</password>", `<password>${MASK}</password>`],
    [
      "a label as an element name in a command",
      "command",
      "cat settings.xml: <password>FKRV0052</password> KEEPRV52",
      `cat settings.xml: <password>${MASK}</password> KEEPRV52`
    ],
    [
      "a label after a comma in a text value",
      "text",
      "password: a,token FKRV0053 KEEPRV53",
      `password: ${MASK},token ${MASK} KEEPRV53`
    ],
    [
      "a label after a semicolon in a text value",
      "text",
      "password=x;token FKRV0054 KEEPRV54",
      `password=${MASK};token ${MASK} KEEPRV54`
    ],
    [
      "a label after a comma in a command value",
      "command",
      "export PASSWORD=a,token=FKRV0055 KEEPRV55",
      `export PASSWORD=${MASK},token=${MASK} KEEPRV55`
    ],
    [
      "a text scalar ending in a backslash before a blank",
      "text",
      "password: 'v\\' KEEPRV56 token: 'FKRV0056'",
      `password: '${MASK}' KEEPRV56 token: '${MASK}'`
    ],
    // The second review's escaped backslash is followed by a blank, where the
    // case above closes the value on its own; a non-blank keeps `\\` needed.
    [
      "a text scalar ending in an escaped backslash before a comma",
      "text",
      "password: 'FKRV0057\\\\',token: 'FKRV0058'",
      `password: '${MASK}',token: '${MASK}'`
    ]
  ];

  it.each(cases)("%s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ text: expected, status: "ok" });
  });
});

// Codex on #257: at step 2-3 a value that starts with a character that ended a
// word there (`,` `]` or a backtick) was read as empty and left in the clear.
describe("the core on a value that starts with a word-ending character", () => {
  const tick = "`";
  const cases: readonly (readonly [string, string, string])[] = [
    ["a comma", "export password=,FKRV0060 KEEPRV60", `export password=${MASK} KEEPRV60`],
    ["a closing bracket", "export password=]FKRV0061 KEEPRV61", `export password=${MASK} KEEPRV61`],
    ["a backtick", `export password=${tick}FKRV0062${tick} KEEPRV62`, `export password=${MASK} KEEPRV62`]
  ];

  it.each(
    (["command", "text"] as const).flatMap((kind) =>
      cases.map(([name, input, expected]) => [name, kind, input, expected] as const)
    )
  )("%s, as %s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ text: expected, status: "ok" });
  });
});

// A fourth independent review, of the third review's fixes (#249, 2026-10-01),
// found values those fixes cut short, words they took, and a guard no test held.
describe("the core on the fourth review's shapes", () => {
  const tick = "`";
  const fernet = (id: string) => `${id}${"Q7-_aZ".repeat(6)}a=`;
  const both = ["command", "text"] as const;
  const cases: readonly (readonly [string, readonly ("command" | "text")[], string, string])[] = [
    // A list of keys, as Airflow rotates its Fernet key: each key ends in `=`.
    [
      "a key list whose second key ends in =",
      both,
      `export AIRFLOW__CORE__FERNET_KEY=${fernet("FKRV0070")},${fernet("FKRV0071")} KEEPRV70`,
      `export AIRFLOW__CORE__FERNET_KEY=${MASK} KEEPRV70`
    ],
    [
      "a key list whose second key starts with a label word",
      both,
      "NOTION_TOKEN=secret_FKRV0072x,secret_FKRV0073y KEEPRV72",
      `NOTION_TOKEN=${MASK} KEEPRV72`
    ],
    [
      "a label inside a longer word after a comma",
      both,
      "export PASSWORD=FKRV0074,patFKRV0075 KEEPRV74",
      `export PASSWORD=${MASK} KEEPRV74`
    ],
    [
      "a key that starts with a label word after a comma",
      ["text"],
      "password: FKRV0076,keychain=FKRV0077 KEEPRV76",
      `password: ${MASK} KEEPRV76`
    ],
    [
      "a key that is no label after a comma",
      both,
      "export password=,x=FKRV0078 KEEPRV78",
      `export password=${MASK} KEEPRV78`
    ],
    [
      "an escaped quote before a blank and no label",
      ["text"],
      "passphrase: 'rock n\\' FKRV0079' KEEPRV79",
      `passphrase: '${MASK}' KEEPRV79`
    ],
    [
      "an option that is no label glued after a quoted value",
      both,
      "password='FKRV0080'-my_token KEEPRV80",
      `password='${MASK} KEEPRV80`
    ],
    [
      "a label in angle brackets with no closing tag",
      ["command"],
      "mysql -p<password> -h KEEPRV81",
      "mysql -p<password> -h KEEPRV81"
    ],
    [
      "a label as a type argument",
      ["text"],
      "Optional<Secret> s = vault.get(KEEPRV82)",
      "Optional<Secret> s = vault.get(KEEPRV82)"
    ],
    [
      "a label in a path before a >, read as a prompt as the sed mask() reads it",
      ["command"],
      "cat /etc/password> FKRV0083",
      `cat /etc/password> ${MASK}`
    ],
    [
      "a label glued after ] and a closing quote",
      ["command"],
      "export PASSWORD='a']token FKRV0084 KEEPRV84",
      `export PASSWORD='${MASK}']token ${MASK} KEEPRV84`
    ],
    [
      "a label glued after } and a closing quote",
      ["command"],
      "export PASSWORD='a'}token FKRV0085 KEEPRV85",
      `export PASSWORD='${MASK}'}token ${MASK} KEEPRV85`
    ],
    [
      "a scheme word behind <",
      both,
      "access_token:<Bearer FKRV0086> KEEPRV86",
      `access_token:<Bearer ${MASK} KEEPRV86`
    ],
    [
      "a scheme word behind a backtick",
      both,
      `api_key => ${tick}Token FKRV0087${tick} KEEPRV87`,
      `api_key => ${tick}Token ${MASK} KEEPRV87`
    ]
  ];

  it.each(
    cases.flatMap(([name, kinds, input, expected]) => kinds.map((kind) => [name, kind, input, expected] as const))
  )("%s, as %s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ text: expected, status: "ok" });
  });
});

// A fifth independent review and a change scan, of the fourth review's fixes
// (#249, 2026-10-02), found values step 2-3 masked and the fixes left readable.
describe("the core on the fifth review's shapes", () => {
  const both = ["command", "text"] as const;
  const header = ["Author", "ization"].join("");
  const cases: readonly (readonly [string, readonly ("command" | "text")[], string, string])[] = [
    [
      "a plist key without a label keeps the next element",
      both,
      "<key>CFBundleName</key><string>KEEPRV91</string>",
      "<key>CFBundleName</key><string>KEEPRV91</string>"
    ],
    ["a tag with no closing tag", both, "<password>FKRV0092 KEEPRV92", `<password>${MASK} KEEPRV92`],
    [
      "an element with attributes",
      both,
      '<password type="plain">FKRV0120</password> KEEPRW20',
      `<password type="plain">${MASK}</password> KEEPRW20`
    ],
    [
      "a closing tag on the next line",
      both,
      "<password>FKRV0093\n</password> KEEPRV93",
      `<password>${MASK}\n</password> KEEPRV93`
    ],
    ["a prompt after a tag", both, "Enter <password>: FKRV0094 KEEPRV94", `Enter <password>: ${MASK} KEEPRV94`],
    [
      "a closing tag with a blank before >",
      both,
      "<password>FKRV0095</password > KEEPRV95",
      `<password>${MASK}</password > KEEPRV95`
    ],
    ["= after a tag", both, "<token>=FKRV0096 KEEPRV96", `<token>=${MASK} KEEPRV96`],
    [
      "a CDATA section",
      both,
      "<password><![CDATA[FKRV0097]]></password> KEEPRV97",
      `<password><![CDATA[${MASK}]]></password> KEEPRV97`
    ],
    [
      "a closing tag that does not match",
      both,
      "<password>FKRV0098</passwordx> KEEPRV98",
      `<password>${MASK} KEEPRV98`
    ],
    [
      "text glued after a closing tag",
      both,
      "<password>FKRV0099</password>FKRV0100</password> KEEPRV99",
      `<password>${MASK}</password>${MASK} KEEPRV99`
    ],
    ["a < inside the element text", both, "<password>FKRV0101<<FKRV0102</password>", `<password>${MASK}`],
    [
      "a scheme word inside a closed quote",
      both,
      `${header}: "Bearer FKRV0104 FKRV0105" KEEPRW04`,
      `${header}: "Bearer ${MASK}" KEEPRW04`
    ],
    [
      "a list item that ends in a label",
      both,
      "passphrase: FKRV0106,secret_key FKRV0107 KEEPRW06",
      `passphrase: ${MASK} ${MASK} KEEPRW06`
    ],
    [
      "a list item that ends in a label, after ;",
      ["text"],
      "password: FKRV0108;keytoken FKRV0109 KEEPRW08",
      `password: ${MASK} ${MASK} KEEPRW08`
    ],
    [
      "a list item that is a label with no word boundary before it",
      both,
      "passphrase: FKRV0110,api_key FKRV0111 KEEPRW10",
      `passphrase: ${MASK} ${MASK} KEEPRW10`
    ],
    [
      "a long option ending in a label glued after a quoted value",
      both,
      "password='FKRV0112'--api-token FKRV0113 KEEPRW12",
      `password='${MASK} ${MASK} KEEPRW12`
    ],
    [
      "three dashes before a label after a quoted value",
      both,
      "password='FKRV0118'---token FKRV0119 KEEPRW18",
      `password='${MASK} ${MASK} KEEPRW18`
    ],
    [
      "a label before a quote in a list",
      ["text"],
      "password=FKRV0114,token'FKRV0115' KEEPRW14",
      `password=${MASK} KEEPRW14`
    ],
    [
      "a label and : in a list",
      both,
      "password=a,token: FKRV0116 KEEPRW16",
      `password=${MASK},token: ${MASK} KEEPRW16`
    ],
    ["a prompt after a slash", both, "mysql/password> FKRV0117 KEEPRW17", `mysql/password> ${MASK} KEEPRW17`]
  ];

  it.each(
    cases.flatMap(([name, kinds, input, expected]) => kinds.map((kind) => [name, kind, input, expected] as const))
  )("%s, as %s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ text: expected, status: "ok" });
  });
});

// A sixth independent review, of the fifth review's fixes (#249, 2026-10-02),
// found values those fixes left readable, and two guards no test held.
describe("the core on the sixth review's shapes", () => {
  const both = ["command", "text"] as const;
  const header = ["Author", "ization"].join("");
  const bearer = ["Bea", "rer"].join("");
  const basic = ["Ba", "sic"].join("");
  const cases: readonly (readonly [string, readonly ("command" | "text")[], string, string])[] = [
    [
      "a word glued after a quoted scheme value",
      both,
      `${header}: "${bearer} FKRV0130"FKRV0131 KEEPRW30`,
      `${header}: "${bearer} ${MASK} KEEPRW30`
    ],
    [
      "a quote that holds only the scheme word",
      both,
      `${header}= "${basic} "FKRV0132 KEEPRW32`,
      `${header}= "${basic} "${MASK} KEEPRW32`
    ],
    [
      "a key element with an attribute",
      both,
      '<key id="x">FKRV0133</key> KEEPRW33',
      `<key id="x">${MASK}</key> KEEPRW33`
    ],
    [
      "a key element with an attribute before another element",
      both,
      '<key id="x">FKRV0140</key><string>KEEPRW40</string>',
      `<key id="x">${MASK}</key><string>KEEPRW40</string>`
    ],
    ["a key element with a blank before >", both, "<key >FKRV0134</key> KEEPRW34", `<key >${MASK}</key> KEEPRW34`],
    [
      "a Key element that is no plist key",
      both,
      '<Key name="license">FKRV0135</Key> KEEPRW35',
      `<Key name="license">${MASK}</Key> KEEPRW35`
    ],
    ["a key element with no element after it", both, "<key>FKRV0139</key> KEEPRW39", `<key>${MASK}</key> KEEPRW39`],
    [
      "a plist key and value with a blank between",
      both,
      "<key>token</key> <string>FKRV0136</string> KEEPRW36",
      `<key>token</key> <string>${MASK}</string> KEEPRW36`
    ],
    [
      "a list item that ends in a label, after &",
      ["text"],
      "passphrase = FKRV0137&secret_key FKRV0138 KEEPRW37",
      `passphrase = ${MASK} ${MASK} KEEPRW37`
    ]
  ];

  it.each(
    cases.flatMap(([name, kinds, input, expected]) => kinds.map((kind) => [name, kind, input, expected] as const))
  )("%s, as %s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ text: expected, status: "ok" });
  });
});

// A seventh independent review, of the sixth review's fixes (#249, 2026-10-02),
// found two values those fixes left readable that step 2-3 masked, and a guard
// no test held.
describe("the core on the seventh review's shapes", () => {
  const both = ["command", "text"] as const;
  const header = ["Author", "ization"].join("");
  const bearer = ["Bea", "rer"].join("");
  const basic = ["Ba", "sic"].join("");
  const password = ["pass", "word"].join("");
  const cases: readonly (readonly [string, readonly ("command" | "text")[], string, string])[] = [
    [
      "a key element with an attribute that holds a label, before another element",
      both,
      '<key id="x">token</key><string>FKRV0160</string> KEEPRW60',
      `<key id="x">${MASK}</key><string>${MASK}</string> KEEPRW60`
    ],
    [
      "a key element with a blank before > that holds a label, before another element",
      both,
      "<key >token</key><string>FKRV0161</string> KEEPRW61",
      `<key >${MASK}</key><string>${MASK}</string> KEEPRW61`
    ],
    [
      "a Key element with an attribute that holds a label, before another element",
      both,
      `<Key name="a">${password}</Key><string>FKRV0162</string> KEEPRW62`,
      `<Key name="a">${MASK}</Key><string>${MASK}</string> KEEPRW62`
    ],
    [
      "a plist key before an element with an attribute",
      both,
      '<key>FKRV0163</key><string type="x">KEEPRW63</string>',
      `<key>${MASK}</key><string type="x">KEEPRW63</string>`
    ],
    [
      "an option glued after a quoted scheme value",
      both,
      `${header}: "${bearer} FKRV0164"--${password} "FKRV0165" KEEPRW64`,
      `${header}: "${bearer} ${MASK} "${MASK}" KEEPRW64`
    ],
    [
      "a word ending in a label glued after a quoted scheme value",
      both,
      `${header}: "${bearer} FKRV0166"x${password} "FKRV0167" KEEPRW66`,
      `${header}: "${bearer} ${MASK} "${MASK}" KEEPRW66`
    ],
    [
      "an option glued after a quote that holds only the scheme word",
      both,
      `${header}: '${basic} 'x--${password} 'FKRV0168' KEEPRW68`,
      `${header}: '${basic} '${MASK} '${MASK}' KEEPRW68`
    ],
    [
      "an option and an unquoted value glued after a quoted scheme value",
      both,
      `${header}: "${bearer} FKRV0169"--token FKRV0170 KEEPRW69`,
      `${header}: "${bearer} ${MASK} ${MASK} KEEPRW69`
    ],
    [
      "a label inside a quoted scheme value, before a quoted word",
      both,
      `${header}: "${bearer} FKRV0180 token" "KEEPRW80"`,
      `${header}: "${bearer} ${MASK}" "KEEPRW80"`
    ]
  ];

  it.each(
    cases.flatMap(([name, kinds, input, expected]) => kinds.map((kind) => [name, kind, input, expected] as const))
  )("%s, as %s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ text: expected, status: "ok" });
  });
});

// In a command, a shell word ends after a closing quote at `,` `}` `]` before a
// word followed by `:` or `=`. No test held where that word starts and ends
// (#272, 2026-10-02): removing the check kept every test green.
describe("the core on the key that ends a shell word after a closing quote", () => {
  const password = ["pass", "word"].join("");
  const cases: readonly (readonly [string, string, string])[] = [
    ["a word and =", `${password}='FKRV0401',user=KEEPRW41`, `${password}='${MASK}',user=KEEPRW41`],
    ["blanks before the word", `${password}='FKRV0402', user=KEEPRW42`, `${password}='${MASK}', user=KEEPRW42`],
    ["a digit first, which starts no key", `${password}='FKRV0403',1x=KEEPRW43`, `${password}='${MASK}`],
    ["a dot and a dash in the word", `${password}='FKRV0404',a.b-c=KEEPRW44`, `${password}='${MASK}',a.b-c=KEEPRW44`],
    ["blanks between the word and :", `${password}='FKRV0405',user :KEEPRW45`, `${password}='${MASK}',user :KEEPRW45`]
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(redactFragment({ text: input, kind: "command" })).toEqual({ text: expected, status: "ok" });
  });
});
