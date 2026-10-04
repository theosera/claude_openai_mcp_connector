import { describe, expect, it } from "vitest";

import { redactFragment } from "../packages/log-redaction/src/core.mjs";
import { LABEL_SHAPES } from "./tools/logRedactionLabelShapes.js";

describe("core #295 Issue-table label shapes", () => {
  it.each(
    LABEL_SHAPES.flatMap((shape) => (["command", "text"] as const).map((kind) => [shape.name, kind, shape] as const))
  )("%s, as %s", (_name, kind, { input, secrets, preserve, expected }) => {
    const result = redactFragment({ text: input, kind });
    expect(result.status).toBe("ok");
    for (const secret of secrets) expect(result.text).not.toContain(secret);
    expect(result.text).toContain(preserve);
    expect(result.text).toBe(expected);
  });
});

// These exact outputs were executed against 38f2306 before adding the fix.
// S291B/S291C deliberately remain visible: #291 is an existing, separately
// assigned gap, not a newly introduced regression or an assertion of safety.
describe("core #291 known gaps and #276 masking retain the fetched-base behavior", () => {
  const cases = [
    [
      "#291 no closing tag",
      '<password a="S291A" b="S291B"> KEEP291',
      '<password ***MASKED***" b="S291B"> KEEP291',
      '<password ***MASKED*** b="S291B"> KEEP291'
    ],
    [
      "#291 child after the start tag",
      '<password a="S291A" b="S291B"><value>S291C</value></password> KEEP291',
      '<password ***MASKED***" b="S291B"><value>S291C</value></password> KEEP291',
      '<password ***MASKED*** b="S291B"><value>S291C</value></password> KEEP291'
    ],
    [
      "#291 closing tag on the next line",
      '<password a="S291A" b="S291B">S291C\n</password> KEEP291',
      '<password ***MASKED***" b="S291B">S291C\n</password> KEEP291',
      '<password ***MASKED*** b="S291B">S291C\n</password> KEEP291'
    ],
    [
      "#276 one attribute and closed text",
      '<password a="S276A">S276B</password> KEEP276',
      '<password a="***MASKED***">***MASKED***</password> KEEP276',
      '<password a="***MASKED***">***MASKED***</password> KEEP276'
    ],
    [
      "#291 one attribute without a closing tag",
      '<password a="S291A"> KEEP291',
      "<password ***MASKED*** KEEP291",
      "<password ***MASKED*** KEEP291"
    ],
    [
      "#276 multiple attributes and empty closed text",
      '<password a="S276A" b="S276B"></password> KEEP276',
      '<password a="***MASKED***" b="***MASKED***"></password> KEEP276',
      '<password a="***MASKED***" b="***MASKED***"></password> KEEP276'
    ]
  ] as const;
  it.each(
    cases.flatMap(([name, input, command, text]) => [
      [name, "command", input, command],
      [name, "text", input, text]
    ])
  )("%s, as %s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ status: "ok", text: expected });
  });
});

describe("core #295 markup boundaries and deliberate overmasking", () => {
  const cases = [
    [
      "password input with reordered single-quoted uppercase type",
      "<INPUT value='S295V' TYPE = 'PASSWORD' class='login'/> KEEP295V",
      "<INPUT value='***MASKED***' TYPE = '***MASKED***' class='***MASKED***'/> KEEP295V"
    ],
    [
      "unquoted password input",
      "<input value=S295U type=password> KEEP295U",
      "<input value=***MASKED*** type=***MASKED***> KEEP295U"
    ],
    [
      "non-password input stays ordinary",
      '<input type="text" value="PUBLIC295"> KEEP295T',
      '<input type="text" value="PUBLIC295"> KEEP295T'
    ],
    [
      "a longer type attribute name does not select an input",
      '<input prototype="password" value="PUBLIC295"> KEEP295T',
      '<input prototype="password" value="PUBLIC295"> KEEP295T'
    ],
    [
      "empty values before a later angled attribute",
      '<password a="" b="y>z" c="S295E"> KEEP295E',
      '<password a="" b="***MASKED***" c="***MASKED***"> KEEP295E'
    ],
    [
      "later angle with closed element text",
      '<password a="x" b="y>z" c="S295A">S295T</password> KEEP295A',
      '<password a="***MASKED***" b="***MASKED***" c="***MASKED***">***MASKED***</password> KEEP295A'
    ],
    [
      "lang and class on a compound label are deliberately masked",
      '<access_token lang="en" class="example">PUBLIC295</access_token> KEEP295O',
      '<access_token lang="***MASKED***" class="***MASKED***">***MASKED***</access_token> KEEP295O'
    ],
    [
      "XML-like prose is deliberately masked",
      'Example: <ns:password lang="en" class="example">ordinary prose</ns:password> KEEP295P',
      'Example: <ns:password lang="***MASKED***" class="***MASKED***">***MASKED***</ns:password> KEEP295P'
    ]
  ] as const;
  it.each(
    cases.flatMap(([name, input, expected]) =>
      (["command", "text"] as const).map((kind) => [name, kind, input, expected] as const)
    )
  )("%s, as %s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ status: "ok", text: expected });
  });
});

describe("core #295 preserves other label readers in selected markup", () => {
  const cases = [
    [
      "password input retains a label plus quoted value without equals",
      '<input type="password" token "FKPROBE" value="S295"> KEEP',
      '<input type="***MASKED***" token "***MASKED***" value="***MASKED***"> KEEP'
    ],
    [
      "compound label retains a label plus quoted value without equals",
      '<access_token token "FKPROBE" a="x">body</access_token> KEEP',
      '<access_token token "***MASKED***" a="***MASKED***">***MASKED***</access_token> KEEP'
    ],
    [
      "multiline label retains a label plus quoted value without equals",
      '<password a="x"\n token "FKPROBE" b="x">body</password> KEEP',
      '<password a="***MASKED***"\n token "***MASKED***" b="***MASKED***">***MASKED***</password> KEEP'
    ],
    [
      "angled key retains its following plist string value",
      '<key a="x" b="y>z">password</key><string>FKPROBE</string> KEEP',
      '<key a="***MASKED***" b="***MASKED***">***MASKED***</key><string>***MASKED***</string> KEEP'
    ],
    [
      "multiline quoted attributes retain line separators",
      '<access_token a="FKONE\r\nFKTWO" b="x">body</access_token> KEEP',
      '<access_token a="***MASKED***\r\n***MASKED***" b="***MASKED***">***MASKED***</access_token> KEEP'
    ],
    [
      "multiline direct text retains line separators",
      '<access_token a="x" b="y">FKONE\nFKTWO</access_token> KEEP',
      '<access_token a="***MASKED***" b="***MASKED***">***MASKED***\n***MASKED***</access_token> KEEP'
    ],
    [
      "namespace prefix alone retains the old non-element label behavior",
      '<password:item a="PUBLIC1" b="PUBLIC2">PUBLIC3</password:item> KEEP295L',
      '<password:***MASKED*** a="PUBLIC1" b="PUBLIC2">PUBLIC3</password:item> KEEP295L'
    ],
    ...["ns:secret_key", "refresh_token", "client-secret", "api.key"].map((name) => [
      `local-name label component ${name}`,
      `<${name} a="S295L1" b="S295L2">S295L3</${name}> KEEP295L`,
      `<${name} a="***MASKED***" b="***MASKED***">***MASKED***</${name}> KEEP295L`
    ])
  ] as const;
  it.each(
    cases.flatMap(([name, input, expected]) =>
      (["command", "text"] as const).map((kind) => [name, kind, input, expected] as const)
    )
  )("%s, as %s", (_name, kind, input, expected) => {
    expect(redactFragment({ text: input, kind })).toEqual({ status: "ok", text: expected });
  });
});

// Owner-approved follow-up to #295: accept the terminal unquoted password/ as
// an XML-like self-closing log form. Quoted or nonterminal slashes stay literal.
describe("core #295 terminal unquoted password input self-close", () => {
  const cases = [
    [
      "unquoted value with terminal type=password/",
      "<input value=SENSITIVE295 type=password/> KEEP295SC",
      "SENSITIVE295",
      "<input value=***MASKED*** type=***MASKED***/> KEEP295SC"
    ],
    [
      "quoted value with terminal type=password/",
      '<input value="SENSITIVE295Q" type=password/> KEEP295SC',
      "SENSITIVE295Q",
      '<input value="***MASKED***" type=***MASKED***/> KEEP295SC'
    ],
    [
      "uppercase terminal password type",
      "<INPUT value=SENSITIVE295U TYPE=PASSWORD/> KEEP295SC",
      "SENSITIVE295U",
      "<INPUT value=***MASKED*** TYPE=***MASKED***/> KEEP295SC"
    ],
    [
      "slash-bearing URL secret before terminal password type",
      "<input value=https://example.invalid/SENSITIVE295/a/b/ type=password/> KEEP295SC",
      "https://example.invalid/SENSITIVE295/a/b/",
      "<input value=***MASKED*** type=***MASKED***/> KEEP295SC"
    ]
  ] as const;
  it.each(
    cases.flatMap(([name, input, secret, expected]) =>
      (["command", "text"] as const).map((kind) => [name, kind, input, secret, expected] as const)
    )
  )("%s, as %s", (_name, kind, input, secret, expected) => {
    const result = redactFragment({ text: input, kind });
    expect(result.status).toBe("ok");
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain("KEEP295SC");
    expect(result.text).toBe(expected);
  });
});

describe("core #295 self-close extension keeps other slash values literal", () => {
  const types = [
    ["quoted password slash", 'type="password/">'],
    ["password slash followed by a suffix", "type=password/foo>"],
    ["password slash followed by whitespace", "type=password/ >"],
    ["password slash followed by another attribute", "type=password/ class=example>"],
    ["password followed by two slashes", "type=password//>"]
  ] as const;
  it.each(
    types.flatMap(([name, ending]) => (["command", "text"] as const).map((kind) => [name, kind, ending] as const))
  )("%s, as %s", (_name, kind, ending) => {
    const input = `<input value=PUBLIC295SC ${ending} KEEP295SC`;
    expect(redactFragment({ text: input, kind })).toEqual({ status: "ok", text: input });
  });

  it.each(["command", "text"] as const)("keeps generic slash-bearing value spans intact, as %s", (kind) => {
    expect(redactFragment({ text: "<input type=password value=SENSITIVE295//> KEEP295SC", kind })).toEqual({
      status: "ok",
      text: "<input type=***MASKED*** value=***MASKED***> KEEP295SC"
    });
  });
});

// The fence contract covers the whole physical line, including info strings,
// indentation/container prefixes and CR/LF bytes, even when the run is inline.
const fenceLines295 = (text: string) =>
  (text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []).filter((line) => /`{3}|~{3}/.test(line));

function expectFenceIdentity295(input: string, output: string) {
  const before = fenceLines295(input);
  const after = fenceLines295(output);
  expect(before.length).toBeGreaterThan(0);
  expect(after).toEqual(before);
  expect(after.length).toBe(before.length);
  expect(after.length % 2).toBe(before.length % 2);
}

describe("core #295 fence barrier protects every credential reader", () => {
  const cases = [
    [
      "odd tilde fences inside a multiline quoted attribute",
      '<password a="start\n~~~~~~\nPUBLIC295F1\n~~~~~~\nPUBLIC295F2\n~~~~~~\nfinish" b="S295"> KEEP295F'
    ],
    [
      "quoted backtick info lines with CRLF",
      '<password a="start\r\n > ```token \'PUBLIC295INFO\'\r\nPUBLIC295F1\r\n```\r\nfinish" b="S295"> KEEP295F'
    ],
    [
      "inline tilde run and bare CR",
      '<password a="start\rprefix ~~~ password=PUBLIC295INFO\rPUBLIC295F1\rfinish" b="S295"> KEEP295F'
    ],
    [
      "legacy label on a fence line without an eventual tag close",
      '<password a="start\n~~~ token=PUBLIC295INFO\nPUBLIC295F1'
    ],
    ["token-shape rule on a fence info line", "~~~ ghp_ABCDEFGHIJKLMNOPQRSTUVWX\nPUBLIC295F1\n~~~"],
    ["URL rule on a fence info line", "~~~ https://user:PUBLIC295INFO@example.invalid/\nPUBLIC295F1\n~~~"]
  ] as const;
  it.each(cases.flatMap(([name, input]) => (["command", "text"] as const).map((kind) => [name, kind, input] as const)))(
    "%s, as %s",
    (_name, kind, input) => {
      const result = redactFragment({ text: input, kind });
      expect(result.status).toBe("ok");
      expectFenceIdentity295(input, result.text);
      expect(result.text).toContain("PUBLIC295F1");
    }
  );

  it.each(["command", "text"] as const)("keeps the absent > plain-fence control, as %s", (kind) => {
    const input = '<password a="start\n~~~~~~\nPUBLIC295F1\n~~~~~~\nno-close';
    const result = redactFragment({ text: input, kind });
    expectFenceIdentity295(input, result.text);
    expect(result.text).toContain("PUBLIC295F1");
  });
});

describe("core #295 global armor clipping preserves fence bytes", () => {
  it.each(["command", "text"] as const)("masks armor across a fence without changing it, as %s", (kind) => {
    const input =
      "~~~ -----BEGIN PRIVATE KEY-----\nS295ARMOR1\n~~~~~~\nS295ARMOR2\n-----END PRIVATE KEY-----\nKEEP295ARMOR";
    const result = redactFragment({ text: input, kind });
    expect(result.status).toBe("ok");
    expectFenceIdentity295(input, result.text);
    expect(result.text).not.toContain("S295ARMOR1");
    expect(result.text).not.toContain("S295ARMOR2");
    expect(result.text).toContain("KEEP295ARMOR");
  });
});

describe("core #295 fence-bearing omission keeps physical positions", () => {
  const input = "PUBLIC295OMIT\r\n~~~ token=PUBLIC295INFO\r\n\r\nPRIVATE295OMIT\r~~~\nTAIL295OMIT";
  const expected = (reason: string) =>
    `***LOG_CONTENT_OMITTED: ${reason}***\r\n~~~ token=PUBLIC295INFO\r\n\r\n***LOG_CONTENT_OMITTED: ${reason}***\r~~~\n***LOG_CONTENT_OMITTED: ${reason}***`;
  it("preserves every original line separator for unknown kind", () => {
    const result = redactFragment({ text: input, kind: "unknown" });
    expect(result).toEqual({ status: "omitted", reason: "unknown_kind", text: expected("unknown_kind") });
    expectFenceIdentity295(input, result.text);
  });
  it.each(["command", "text"] as const)("preserves every original line separator for over-limit %s", (kind) => {
    const result = redactFragment({ text: input, kind }, { maxBytes: 1 });
    expect(result).toEqual({ status: "omitted", reason: "fragment_over_limit", text: expected("fragment_over_limit") });
    expectFenceIdentity295(input, result.text);
  });
  it.each(["command", "text"] as const)("preserves fences on the armor omission path, as %s", (kind) => {
    const original = "-----BEGIN PRIVATE KEY-----\nSECRET295OMIT\n~~~\nPUBLIC295AFTER\n~~~";
    const result = redactFragment({ text: original, kind });
    expect(result).toMatchObject({ status: "omitted", reason: "unterminated_private_armor" });
    expectFenceIdentity295(original, result.text);
    expect(result.text).not.toContain("SECRET295OMIT");
    expect(result.text).not.toContain("PUBLIC295AFTER");
    expect(result.text.split("\n")).toHaveLength(original.split("\n").length);
  });
});

describe("core #295 multiline extent is at most 32 physical lines", () => {
  it.each(
    (["\n", "\r\n", "\r"] as const).flatMap((eol) =>
      (["command", "text"] as const).map((kind) => [JSON.stringify(eol), kind, eol] as const)
    )
  )("keeps the valid 32-line start tag with %s, as %s", (_name, kind, eol) => {
    const input = [
      '<password a="start',
      ...Array<string>(30).fill("S295WITHIN"),
      'finish" b="S295LIMIT"> KEEP295LIMIT'
    ].join(eol);
    const result = redactFragment({ text: input, kind });
    expect(result.status).toBe("ok");
    expect(result.text).not.toContain("S295WITHIN");
    expect(result.text).not.toContain("S295LIMIT");
    expect(result.text).toContain("KEEP295LIMIT");
  });
  it.each(
    (["\n", "\r\n", "\r"] as const).flatMap((eol) =>
      (["command", "text"] as const).map((kind) => [JSON.stringify(eol), kind, eol] as const)
    )
  )("stops the start-tag claim before line 33 with %s, as %s", (_name, kind, eol) => {
    const input = [
      '<password a="start',
      ...Array<string>(31).fill("PUBLIC295BOUND"),
      'finish" b="PUBLIC295TAIL"> KEEP295BOUND'
    ].join(eol);
    const result = redactFragment({ text: input, kind });
    expect(result.status).toBe("ok");
    expect(result.text).toContain("PUBLIC295BOUND");
    expect(result.text).toContain("PUBLIC295TAIL");
    expect(result.text).toContain("KEEP295BOUND");
  });
  it.each(["command", "text"] as const)("bounds direct text using the remaining opening-tag budget, as %s", (kind) => {
    const input = [
      '<access_token a="S295A" b="S295B">',
      ...Array<string>(32).fill("PUBLIC295BODY"),
      "</access_token> KEEP295BODY"
    ].join("\n");
    const result = redactFragment({ text: input, kind });
    expect(result.status).toBe("ok");
    expect(result.text).not.toContain("S295A");
    expect(result.text).not.toContain("S295B");
    expect(result.text.match(/PUBLIC295BODY/g) ?? []).toHaveLength(32);
    // Beyond the budget the old closing-label reader still takes this word.
    // Retaining that fallback is deliberate; this is not a claim that the new
    // within-budget following-word guarantee extends to oversized elements.
    expect(result.text.endsWith("</access_token> ***MASKED***")).toBe(true);
  });
});

describe("core #295 invalid backtick info stays eligible for masking", () => {
  it.each(["command", "text"] as const)("retains the G-228 secret masking, as %s", (kind) => {
    const input = "````\n```token: `FKgv`\n````";
    const result = redactFragment({ text: input, kind });
    expect(result.status).toBe("ok");
    expect(result.text).not.toContain("FKgv");
    expect(result.text.startsWith("````\n")).toBe(true);
    expect(result.text.endsWith("\n````")).toBe(true);
  });
  it.each(["command", "text"] as const)("does not retry a later triple inside invalid info, as %s", (kind) => {
    const result = redactFragment({ text: "```prefix ```token=S295INVALID", kind });
    expect(result.status).toBe("ok");
    expect(result.text).not.toContain("S295INVALID");
  });
});

describe("core #295 closing delimiter shares the 32-line budget", () => {
  it.each(
    (["\n", "\r\n", "\r"] as const).flatMap((eol) =>
      (["command", "text"] as const).map((kind) => [JSON.stringify(eol), kind, eol] as const)
    )
  )("keeps a close at line 32 with %s, as %s", (_name, kind, eol) => {
    const input = `<access_token a="S295A" b="S295B">S295CLOSE</access_token${eol.repeat(31)}> KEEP295CLOSE`;
    const result = redactFragment({ text: input, kind });
    expect(result.status).toBe("ok");
    expect(result.text).not.toContain("S295CLOSE");
    expect(result.text).toContain("KEEP295CLOSE");
  });
  it.each(
    (["\n", "\r\n", "\r"] as const).flatMap((eol) =>
      (["command", "text"] as const).map((kind) => [JSON.stringify(eol), kind, eol] as const)
    )
  )("rejects a close at line 33 with %s, as %s", (_name, kind, eol) => {
    const input = `<access_token a="S295A" b="S295B">PUBLIC295CLOSE</access_token${eol.repeat(32)}> KEEP295CLOSE`;
    const result = redactFragment({ text: input, kind });
    expect(result.status).toBe("ok");
    expect(result.text).not.toContain("S295A");
    expect(result.text).not.toContain("S295B");
    expect(result.text).toContain("PUBLIC295CLOSE");
    expect(result.text).toContain("KEEP295CLOSE");
  });
});
