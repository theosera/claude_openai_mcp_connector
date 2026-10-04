import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { redactFragment } from "../packages/log-redaction/src/core.mjs";

type Engine = "core-command" | "core-text" | "capture" | "archive";
type MatrixCase = {
  id: string;
  group: "common" | "provider" | "legacy" | "reported";
  form: string;
  placement: string;
  input: string;
  secrets: string[];
  publicWord: string;
  keep: string;
  wholeInfoMask: boolean;
};
type Observation = {
  unmaskedSecrets: Record<string, string[]>;
  lostPublicIds: string[];
};
type Fixture = {
  baselineRevision: string;
  placements: string[];
  observations: Record<Engine, Observation>;
  cases: MatrixCase[];
};

// These observations were measured from git-show snapshots of this exact main,
// separately for both core kinds and each shipped hook. They are not inferred
// from the moving working tree or from another engine's allowances.
// Before exercising the fix, the same 746 tests passed on main and gave 436
// named canary-leak failures on cdef00b31fb5818af97a0b04817b844630141b8f:
// 125 per core kind and 93 per hook, including 72/81 common cases per engine.
const MAIN = "ae2291fd94a97ab992446901b5e707b575e9b5cd";
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/redaction-corpus/fence-matrix.json", import.meta.url), "utf8")
) as Fixture;

const hooks = {
  capture: ".claude/skills/ops-logging/capture-command.sh",
  archive: ".claude/skills/session-archive/archive-session.sh"
} as const;

function maskFunction(path: string): string {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.indexOf("mask() {");
  const end = lines.findIndex((line, index) => index > start && line === "}");
  if (start === -1 || end === -1) throw new Error(`mask() extraction failed: ${path}`);
  return lines.slice(start, end + 1).join("\n");
}

// Invoke only the actual mask() functions, never hook destinations, logging,
// git, or push machinery. Read both independently, even while they are equal.
const captureMask = maskFunction(hooks.capture);
const archiveMask = maskFunction(hooks.archive);
function runHook(source: string, input: string) {
  return {
    status: "ok",
    text: execFileSync("bash", ["-c", `${source}\nmask`], { input, encoding: "utf8" })
  };
}

const engines: Record<Engine, (input: string) => { text: string; status: string }> = {
  "core-command": (input) => redactFragment({ text: input, kind: "command" }),
  "core-text": (input) => redactFragment({ text: input, kind: "text" }),
  capture: (input) => runHook(captureMask, input),
  archive: (input) => runHook(archiveMask, input)
};

describe("#295 fence matrix measurement scope", () => {
  it("reaches all 185 named inputs, four engines, and the declared immutable main", () => {
    expect(fixture.baselineRevision).toBe(MAIN);
    expect(Object.keys(engines)).toEqual(["core-command", "core-text", "capture", "archive"]);
    expect(Object.keys(fixture.observations)).toEqual(Object.keys(engines));
    expect(fixture.cases).toHaveLength(185);
    expect(new Set(fixture.cases.map((c) => c.id)).size).toBe(185);
    expect(fixture.placements).toEqual([
      "none",
      "trailing-tildes",
      "leading-tildes",
      "trailing-backticks",
      "leading-backticks",
      "middle-backticks",
      "four-backticks",
      "six-tildes",
      "backticks-bash"
    ]);
    for (const [group, forms] of [
      ["common", 9],
      ["provider", 2],
      ["legacy", 9]
    ] as const) {
      const cases = fixture.cases.filter((c) => c.group === group);
      const names = [...new Set(cases.map((c) => c.form))];
      expect(names).toHaveLength(forms);
      expect(cases).toHaveLength(forms * 9);
      for (const form of names) {
        expect(cases.filter((c) => c.form === form).map((c) => c.placement)).toEqual(fixture.placements);
      }
    }
    expect(fixture.cases.filter((c) => c.group === "reported").map((c) => c.id)).toEqual([
      "reported/password-before-tildes",
      "reported/backtick-sh-api-key",
      "reported/bearer-before-tildes",
      "reported/github-before-tildes",
      "reported/aws-touching-tildes"
    ]);
  });

  it("uses real canaries and independent following-word and ordinary-line controls", () => {
    const ordinaryCanaries: string[] = [];
    for (const c of fixture.cases) {
      expect(c.secrets.length, c.id).toBeGreaterThan(0);
      for (const secret of c.secrets) {
        expect(c.input, c.id).toContain(secret);
        expect("***MASKED***", c.id).not.toContain(secret);
        // The two sentinel-prefix sed rules accept only literal prefixes of
        // ***MASKEDP***; each such input also carries a unique normal canary.
        if (!secret.startsWith("***MASKEDP")) ordinaryCanaries.push(secret);
      }
      expect(c.input, c.id).toContain(` ${c.publicWord}\n`);
      expect(c.input, c.id).toContain(`\n${c.keep}\n`);
      expect(c.wholeInfoMask, c.id).toBe(/^(?:`{3,}|~{3,})/.test(c.input));
      if (c.form === "aws-key") expect(c.secrets[0]).toMatch(/^AKIA[0-9A-Z]{16}$/);
    }
    expect(ordinaryCanaries).toHaveLength(185);
    expect(new Set(ordinaryCanaries).size).toBe(185);
  });

  it.each(Object.keys(engines) as Engine[])("pins only the actually measured main gaps for %s", (engine) => {
    const { unmaskedSecrets, lostPublicIds } = fixture.observations[engine];
    expect(lostPublicIds).toEqual([]);
    const actualGapIds = Object.keys(unmaskedSecrets).sort();
    const expectedGapIds = fixture.cases
      .filter((c) => {
        if (c.group !== "legacy") return false;
        if (engine === "capture" || engine === "archive") return c.placement !== "none";
        return ["user-flag", "mysql-value", "mysql-sentinel-prefix", "redis-value", "redis-sentinel-prefix"].includes(
          c.form
        );
      })
      .map((c) => c.id)
      .sort();
    expect(actualGapIds).toEqual(expectedGapIds);
    expect(actualGapIds).toHaveLength(engine.startsWith("core-") ? 45 : 72);
    for (const [id, secrets] of Object.entries(unmaskedSecrets)) {
      const c = fixture.cases.find((entry) => entry.id === id)!;
      expect(secrets, id).toEqual(c.secrets);
    }
  });
});

for (const engine of Object.keys(engines) as Engine[]) {
  describe(`#295 SAMEPR300 fence matrix: ${engine}`, () => {
    for (const c of fixture.cases) {
      it(`${c.id}: retains main masking and preservation`, () => {
        const result = engines[engine](c.input);
        expect(result.status).toBe("ok");
        const observation = fixture.observations[engine];
        const mainGaps = observation.unmaskedSecrets[c.id] ?? [];
        for (const secret of c.secrets) {
          // A measured main gap permits additional masking; it never demands
          // that the current engine continue leaking or exempts another secret.
          if (!mainGaps.includes(secret)) expect(result.text, `main masked ${secret}`).not.toContain(secret);
        }
        expect(result.text, "ordinary line after the credential").toContain(c.keep);
        if (!observation.lostPublicIds.includes(c.id) && !c.wholeInfoMask) {
          expect(result.text, "main kept the following public word").toContain(c.publicWord);
        }
        if (c.wholeInfoMask) {
          // Accepted #295 cost: a valid opening fence's entire info string can
          // be masked, including PUBLIC. Its run and the independent KEEP line
          // still have to survive. Inline fence markers grant no such allowance.
          const run = /^(?:`{3,}|~{3,})/.exec(c.input)![0];
          expect(result.text.startsWith(run)).toBe(true);
        }
        expect(result.text.match(/\r\n|\r|\n/g)).toEqual(c.input.match(/\r\n|\r|\n/g));
      });
    }
  });
}
