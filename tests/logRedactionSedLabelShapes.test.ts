import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LABEL_SHAPES } from "./tools/logRedactionLabelShapes.js";

const hooks = [
  ["capture", ".claude/skills/ops-logging/capture-command.sh"],
  ["archive", ".claude/skills/session-archive/archive-session.sh"]
] as const;

function maskFunction(path: string): string {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.indexOf("mask() {");
  const end = lines.findIndex((line, index) => index > start && line === "}");
  if (start === -1 || end === -1) throw new Error(`mask() extraction failed: ${path}`);
  return lines.slice(start, end + 1).join("\n");
}

// Run the shipped functions without either hooks destination/push machinery.
// Both kinds reach the same mask(); capture flattens newlines only afterwards.
for (const [hook, path] of hooks) {
  describe(`${hook} mask on #295 Issue-table shapes`, () => {
    for (const kind of ["command", "text"] as const) {
      for (const shape of LABEL_SHAPES) {
        it(`${shape.name}, as ${kind}: masks values and preserves the word after the element`, () => {
          const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], {
            input: `${shape.input}\n`,
            encoding: "utf8"
          });
          for (const secret of shape.secrets) expect(output).not.toContain(secret);
          expect(output).toContain(shape.preserve);
          expect(output.split("\n")).toHaveLength(shape.input.split("\n").length + 1);
        });
      }
    }
  });
}

it("keeps the two complete mask() functions byte-identical", () => {
  expect(maskFunction(hooks[0][1])).toBe(maskFunction(hooks[1][1]));
});

const baselineShapes = [
  [
    "#291 closing element on the next line",
    '<password first="S291A1" second="S291A2">\n</password> KEEP291A',
    ["S291A1", "S291A2"],
    "KEEP291A"
  ],
  [
    "#291 child after the start tag",
    '<password first="S291B1" second="S291B2"><value>x</value></password> KEEP291B',
    ["S291B1", "S291B2"],
    "KEEP291B"
  ],
  ["#291 no closing element", '<password first="S291C1" second="S291C2"> KEEP291C', ["S291C1", "S291C2"], "KEEP291C"],
  ["#276 single attribute", '<password value="S276A1"></password> KEEP276A', ["S276A1"], "KEEP276A"],
  ["#276 single-quoted attribute", "<token value='S276B1'></token> KEEP276B", ["S276B1"], "KEEP276B"],
  ["#276 bare attribute", "<token value=S276C1></token> KEEP276C", ["S276C1"], "KEEP276C"],
  [
    "#291 unterminated second quote",
    '<password first="S291D1" second="S291D2> KEEP291D',
    ["S291D1", "S291D2"],
    "KEEP291D"
  ],
  [
    "#291 single-quoted attributes",
    "<password first='S291E1' second='S291E2'> KEEP291E",
    ["S291E1", "S291E2"],
    "KEEP291E"
  ]
] as const;

for (const [hook, path] of hooks) {
  describe(`${hook} baseline and bounds around #295`, () => {
    for (const [name, input, secrets, preserve] of baselineShapes) {
      it(`retains the fresh-base masking of ${name}`, () => {
        const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
        for (const secret of secrets) expect(output).not.toContain(secret);
        expect(output).toContain(preserve);
      });
    }
    it("masks both words in the direct body before its matching close", () => {
      const input = '<access_token a="S295B1" b="S295B2">S295WORD1 S295WORD2</access_token> KEEP295BODY\n';
      const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
      for (const secret of ["S295B1", "S295B2", "S295WORD1", "S295WORD2"]) expect(output).not.toContain(secret);
      expect(output).toContain("KEEP295BODY");
    });
    for (const ending of ["", "<unrelated>VISIBLE295</unrelated>", "</different>", "\n</access_token>"]) {
      it(`preserves following prose without a matching same-line close: ${JSON.stringify(ending)}`, () => {
        const input = `<access_token a="S295B1" b="S295B2"> KEEP295BODY ${ending}\n`;
        const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
        expect(output).toContain("KEEP295BODY");
        expect(output.match(/[\r\n]/g) ?? []).toEqual(input.match(/[\r\n]/g) ?? []);
      });
    }
    for (const label of ["refresh_token", "ns:secret_key"]) {
      it(`recognizes a secret component of the local name ${label}`, () => {
        const input = `<${label} a="S295C1" b="S295C2">S295C3</${label}> KEEP295COMPONENT\n`;
        const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
        for (const secret of ["S295C1", "S295C2", "S295C3"]) expect(output).not.toContain(secret);
        expect(output).toContain("KEEP295COMPONENT");
      });
    }
    it("masks benign lang/class attributes and XML-like prose as the documented cost", () => {
      const input = '<access_token lang="en" class="hint">documentation</access_token> KEEP295PROSE';
      const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
      expect(output).not.toContain('lang="en"');
      expect(output).not.toContain('class="hint"');
      expect(output).not.toContain("documentation");
      expect(output).toContain("KEEP295PROSE");
    });
    for (const input of [
      "",
      "plain\n",
      "plain\n\n",
      '<access_token a="S295LF1"\r\n b="S295LF2">\n',
      '<input type="text" value="VISIBLE295"> KEEP295\n',
      '<password:item a="VISIBLE295" b="VISIBLE295">VISIBLE295</password:item> KEEP295\n'
    ]) {
      it(`keeps separators and ordinary input values: ${JSON.stringify(input)}`, () => {
        const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
        expect(output.match(/[\r\n]/g) ?? []).toEqual(input.match(/[\r\n]/g) ?? []);
        if (input.includes("VISIBLE295")) expect(output).toContain("VISIBLE295");
      });
    }
  });
}

// Owner-approved adjacent #295 form: a bare type immediately before />.
const selfClosingInputs = [
  ["bare value", "<input value=SENSITIVE295 type=password/> KEEP"],
  ["double-quoted value", '<input value="SENSITIVE295" type=password/> KEEP'],
  ["single-quoted value", "<input value='SENSITIVE295' type=password/> KEEP"],
  ["uppercase type", "<INPUT VALUE=SENSITIVE295 TYPE=PASSWORD/> KEEP"],
  ["slash-bearing value", "<input value=SENSITIVE295/path/part type=password/> KEEP"]
] as const;
const nonPasswordSlashTypes = [
  ["quoted slash", '<input value=VISIBLE295 type="password/"> KEEP'],
  ["slash inside the bare type", "<input value=VISIBLE295 type=password/foo> KEEP"],
  ["slash before whitespace", "<input value=VISIBLE295 type=password/ > KEEP"],
  ["slash before another attribute", "<input value=VISIBLE295 type=password/ class=hint> KEEP"],
  ["two terminal slashes", "<input value=VISIBLE295 type=password//> KEEP"]
] as const;

for (const [hook, path] of hooks) {
  describe(`${hook} self-closing unquoted password type`, () => {
    for (const kind of ["command", "text"] as const) {
      for (const [name, input] of selfClosingInputs) {
        it(`${name}, as ${kind}: masks the value and preserves the following word`, () => {
          const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], {
            input: `${input}\n`,
            encoding: "utf8"
          });
          expect(output).not.toContain("SENSITIVE295");
          if (name === "slash-bearing value") expect(output).not.toContain("path/part");
          expect(output).toContain("KEEP");
        });
      }
      for (const [name, input] of nonPasswordSlashTypes) {
        it(`retains ${name}, as ${kind}`, () => {
          const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], {
            input: `${input}\n`,
            encoding: "utf8"
          });
          expect(output).toBe(`${input}\n`);
        });
      }
    }
  });
}

const fenceShapes = [
  ["early keyword", "~~~~~~ token=FENCE295EARLY\n~~~~~~\n"],
  ["armor replacement", `-----BEGIN PRIVATE KEY-----\n~~~~~~ ${"A".repeat(40)}\n-----END PRIVATE KEY-----\n~~~~~~\n`],
  ["late provider", `~~~~~~ sk-${"a".repeat(24)}\n~~~~~~\n`],
  ["final label cleanup", '<password first="x" second="FENCE295FINAL"> ~~~~~~\n~~~~~~\n'],
  ["unfinished unquoted tag", "<password x\n~~~~~~\nKEEP295FENCE\n~~~~~~\na -> b\n"],
  ["unfinished quoted tag", '<password first="x" a="\n```text\nKEEP295FENCE\n```\nz"> tail\n'],
  ["container-prefixed fence", "<password x\n> ```text\nKEEP295FENCE\n> ```\na -> b\n"],
  ["CRLF fence", '<password first="x" a="\r\n~~~~~~\r\nKEEP295FENCE\r\n~~~~~~\r\nz"> tail\r\n'],
  ["bare CR fence", '<password first="x" a="\r~~~~~~\rKEEP295FENCE\r~~~~~~\rz"> tail\r']
] as const;

function fenceLineBytes(text: string): string[] {
  return (text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []).filter((line) => /`{3}|~{3}/.test(line));
}

for (const [hook, path] of hooks) {
  describe(`${hook} fence barriers and markup line bound`, () => {
    for (const kind of ["command", "text"] as const) {
      for (const [name, input] of fenceShapes) {
        it(`${name}, as ${kind}: preserves every fence byte, count and parity`, () => {
          const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
          const before = fenceLineBytes(input);
          const after = fenceLineBytes(output);
          expect(before).toHaveLength(2);
          expect(after).toEqual(before);
          expect(after.length % 2).toBe(0);
          if (input.includes("KEEP295FENCE")) expect(output).toContain("KEEP295FENCE");
        });
      }
      for (const [ending, separator] of [
        ["LF", "\n"],
        ["CRLF", "\r\n"],
        ["CR", "\r"]
      ] as const) {
        for (const quoted of [false, true]) {
          it(`stops ${quoted ? "quoted" : "unquoted"} markup before line 33 with ${ending}, as ${kind}`, () => {
            const opener = quoted ? '<password first="x" a="' : "<password x";
            const input =
              [
                opener,
                ...Array.from({ length: 31 }, () => "continued attribute text"),
                quoted ? 'KEEP295BOUND"> tail' : "KEEP295BOUND> tail"
              ].join(separator) + separator;
            const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
            expect(output).toContain("KEEP295BOUND");
            expect(output.match(/\r\n|\r|\n/g)).toEqual(input.match(/\r\n|\r|\n/g));
          });
        }
        it(`still masks a valid 32-line start tag with ${ending}, as ${kind}`, () => {
          const input =
            [
              '<access_token first="S295LIMIT1"',
              ...Array.from({ length: 30 }, () => ' a="S295LIMIT2"'),
              ' last="S295LIMIT3"> KEEP295LIMIT'
            ].join(separator) + separator;
          const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
          for (const secret of ["S295LIMIT1", "S295LIMIT2", "S295LIMIT3"]) expect(output).not.toContain(secret);
          expect(output).toContain("KEEP295LIMIT");
        });
      }
    }
    it("retains the legacy malformed short-tag fallback on short CR records", () => {
      const input = '<password first="x" a="S295MALFORMED>\rplain\r';
      const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
      expect(output).not.toContain("S295MALFORMED");
    });
    it("documents the malformed short-tag fallback cost on long CR records", () => {
      const input = '<password first="x" a="S295MALFORMED>\r' + "plain\r".repeat(32);
      const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
      expect(output).toContain("S295MALFORMED");
    });
    it("still masks complete short tags elsewhere on long CR records", () => {
      const input = '<password first="x" a="S295COMPLETE">\r' + "plain\r".repeat(32);
      const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
      expect(output).not.toContain("S295COMPLETE");
    });
    it("ages the existing armor window on protected fence records", () => {
      const input =
        [
          "-----BEGIN PRIVATE KEY-----",
          ...Array.from({ length: 100 }, () => "~~~~~~"),
          "text KEEP295ARMORBOUND prose"
        ].join("\n") + "\n";
      const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
      expect(output).toContain("KEEP295ARMORBOUND");
      expect(fenceLineBytes(output)).toEqual(fenceLineBytes(input));
    });
    for (const input of ["```token: `S295INVALID`", "```token: `S295INVALID` ```"]) {
      it(`still masks invalid backtick info without a later-run rescue: ${input}`, () => {
        const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], {
          input: `${input}\n`,
          encoding: "utf8"
        });
        expect(output).not.toContain("S295INVALID");
      });
    }
  });
}

const mixedInvalidFenceShapes = [
  ["OpenAI provider", `sk-${"A".repeat(32)}`],
  ["AWS provider", `AKIA${"A".repeat(16)}`],
  ["Google provider", `AIza${"A".repeat(35)}`],
  ["Slack provider", `xoxb-${"A".repeat(24)}`],
  ["compound markup", '<access_token first="S295MIX1" second="S295MIX2">S295MIX3</access_token>']
] as const;

for (const [hook, path] of hooks) {
  describe(`${hook} original fence classification`, () => {
    for (const kind of ["command", "text"] as const) {
      for (const [name, suffix] of mixedInvalidFenceShapes) {
        it(`keeps masking ${name} after invalid backtick info changes, as ${kind}`, () => {
          const input = `\x60\x60\x60token: \x60S295MIX0\x60 ${suffix} KEEP295MIX\n`;
          const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
          for (const secret of ["S295MIX0", "S295MIX1", "S295MIX2", "S295MIX3"]) expect(output).not.toContain(secret);
          if (name !== "compound markup") expect(output).not.toContain(suffix);
          expect(output).toContain("KEEP295MIX");
        });
      }
    }
    for (const input of [
      "Nplain\n",
      "Pplain\n",
      "Ntoken=S295PREFIX\n",
      "Ptoken=S295PREFIX\n",
      "N~~~~~~ token=S295PREFIX\n",
      "P~~~~~~ token=S295PREFIX\n"
    ]) {
      it(`does not treat an input prefix as trusted framing: ${JSON.stringify(input)}`, () => {
        const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
        if (input.includes("~~~~~~") || input.includes("plain")) expect(output).toBe(input);
        else {
          expect(output).toBe(`${input[0]}token=***MASKED***\n`);
          expect(output).not.toContain("S295PREFIX");
        }
      });
    }
  });
}

for (const [hook, path] of hooks) {
  describe(`${hook} armor state across original protected records`, () => {
    it("opens the armor window on a protected BEGIN record", () => {
      const input = "~~~~~~ -----BEGIN PRIVATE KEY-----\nbody S295ARMORBEGIN prose\n-----END PRIVATE KEY-----\n";
      const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
      expect(output).not.toContain("S295ARMORBEGIN");
      expect(fenceLineBytes(output)).toEqual(fenceLineBytes(input));
    });
    it("closes the armor window on a protected END record", () => {
      const input = "-----BEGIN PRIVATE KEY-----\n~~~~~~ -----END PRIVATE KEY-----\ntext KEEP295ARMOREND prose\n";
      const output = execFileSync("bash", ["-c", `${maskFunction(path)}\nmask`], { input, encoding: "utf8" });
      expect(output).toContain("KEEP295ARMOREND");
      expect(fenceLineBytes(output)).toEqual(fenceLineBytes(input));
    });
  });
}

for (const [hook, path] of hooks) {
  describe(`${hook} line completion across mask stages`, () => {
    for (const input of ["", "plain", "plain\n", "plain\n\n", "~~~~~~\n", "Nplain\r\nPplain\r\n"]) {
      it(`preserves record count when sed completes its final line: ${JSON.stringify(input)}`, () => {
        // Model BSD sed final-line completion on this runner. This is a stream
        // composition check; the real GNU/macOS runtime gates remain separate.
        const completeSedLine = "sed() { command sed \"$@\" | awk '{ print }'; }";
        const output = execFileSync("bash", ["-c", `${completeSedLine}\n${maskFunction(path)}\nmask`], {
          input,
          encoding: "utf8"
        });
        expect(output).toBe(input && !input.endsWith("\n") ? `${input}\n` : input);
      });
    }
  });
}
