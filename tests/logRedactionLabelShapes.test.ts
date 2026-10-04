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
