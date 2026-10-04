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
