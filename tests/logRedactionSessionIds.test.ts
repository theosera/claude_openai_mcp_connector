import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { execFileSyncBounded } from "./tools/syncChild.js";

// A Claude Code session id names the session's transcript, scratchpad and
// background-task output, and its first eight characters name the job directory;
// a session URL carries another form of it. Both hooks' mask() hide all three.
// Every id below is synthetic.
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

function runMask(path: string, input: string): string {
  return execFileSyncBounded("bash", ["-c", `${maskFunction(path)}\nmask`], {
    input: `${input}\n`,
    encoding: "utf8"
  });
}

const UUID = "12345678-90ab-4cde-8f01-23456789abcd";
const JOB = "0a1b2c3d";
const URL_ID = "01ABCDEFGHJKMNPQRSTVWXYZ";

const masked = [
  {
    name: "a transcript path",
    input: `wc -c /Users/u/.claude/projects/-Users-u-dev-x/${UUID}.jsonl`,
    hidden: UUID,
    shown: "/Users/u/.claude/projects/-Users-u-dev-x/***MASKED***.jsonl"
  },
  {
    name: "every id on a line, not only the first",
    input: `diff /a/${UUID}.jsonl /b/${UUID}.jsonl`,
    hidden: UUID,
    shown: "diff /a/***MASKED***.jsonl /b/***MASKED***.jsonl"
  },
  {
    name: "an upper-case id",
    input: `ID=${UUID.toUpperCase()} make run`,
    hidden: UUID.toUpperCase(),
    shown: "ID=***MASKED*** make run"
  },
  {
    name: "a scratchpad path",
    input: `cat /private/tmp/claude-501/-Users-u-dev-x/${UUID}/scratchpad/note.md`,
    hidden: UUID,
    shown: "/-Users-u-dev-x/***MASKED***/scratchpad/note.md"
  },
  {
    name: "a job directory",
    input: `cmp /Users/u/.claude/jobs/${JOB}/tmp/out.md body.md`,
    hidden: JOB,
    shown: "/Users/u/.claude/jobs/***MASKED***/tmp/out.md body.md"
  },
  {
    name: "a session URL",
    input: `git log --grep https://claude.ai/code/session_${URL_ID}`,
    hidden: URL_ID,
    shown: "https://claude.ai/code/session_***MASKED***"
  }
];

const kept = [
  ["names that only begin like an id", "grep -n session_id session_archive SESSION_VAULT_ORIGIN src"],
  ["a full commit sha", "git show 3c45e5579fc1d3c687b222b4b45cc5ccf8212d20"],
  ["a job directory file that is not an id", "ls /Users/u/.claude/jobs/README"],
  ["a session_ word one character short", "echo session_0123456789abcdefghi"]
] as const;

for (const [hook, path] of hooks) {
  describe(`${hook} mask on session ids`, () => {
    for (const shape of masked) {
      it(`hides ${shape.name}`, () => {
        const output = runMask(path, shape.input);
        expect(output).not.toContain(shape.hidden);
        expect(output).toContain(shape.shown);
      });
    }

    for (const [name, input] of kept) {
      it(`keeps ${name}`, () => {
        expect(runMask(path, input)).toBe(`${input}\n`);
      });
    }

    it("leaves a note's heading, its fence lines and their count alone", () => {
      const input = ["## Steps", "```bash", `ls /x/${UUID}.jsonl`, "```", "## Next"].join("\n");
      const lines = runMask(path, input).split("\n");
      expect(lines).toHaveLength(6);
      expect(lines[0]).toBe("## Steps");
      expect(lines[1].startsWith("```")).toBe(true);
      expect(lines[2]).toBe("ls /x/***MASKED***.jsonl");
      expect(lines[3]).toBe("```");
      expect(lines[4]).toBe("## Next");
    });
  });
}
