import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The ops log writes one Markdown table row per command. #246: the row was built
 * by folding LF alone, so a bare CR in a command or its intent reached the row
 * unchanged, and a renderer that ends a line at CR -- CommonMark does -- ended the
 * row there and rendered the rest of the command as prose outside the table.
 *
 * These run the SHIPPED hook end to end against a throwaway log repo, so what is
 * asserted is the file a reader would open, not a helper's return value.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = path.join(repoRoot, ".claude", "skills", "ops-logging", "capture-command.sh");
/** The fold as it ships: LF and CR both become a space. */
const FOLD = "tr '\\r\\n' '  '";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run `hook` on one Bash call and return the log file it wrote. */
function logRow(hook: string, command: string, description: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-log-row-"));
  scratch.push(dir);
  const logRepo = path.join(dir, "log");
  const work = path.join(dir, "work");
  // The hook only checks that the log repo has a .git directory before writing.
  fs.mkdirSync(path.join(logRepo, ".git"), { recursive: true });
  fs.mkdirSync(work);
  const payload = JSON.stringify({ tool_name: "Bash", cwd: work, tool_input: { command, description } });
  execFileSync("bash", [hook], { input: payload, env: { ...process.env, OPS_LOG_REPO: logRepo }, encoding: "utf8" });
  const folder = path.join(logRepo, "work");
  const [file] = fs.readdirSync(folder);
  return fs.readFileSync(path.join(folder, file), "utf8");
}

/** Data rows of the table: lines after the header separator, split the way CommonMark splits. */
function dataRows(log: string): string[] {
  const lines = log.split(/\r\n|\r|\n/);
  const separator = lines.indexOf("|---|---|---|---|");
  return lines.slice(separator + 1).filter((line) => line !== "");
}

describe("ops log row: one command is one table row (#246)", () => {
  const endings: Array<[string, string]> = [
    ["a bare CR", "\r"],
    ["CRLF", "\r\n"],
    ["LF", "\n"]
  ];

  for (const [label, eol] of endings) {
    it(`folds ${label} in the command and the intent, so the row does not end early`, () => {
      const log = logRow(hookPath, `echo a${eol}echo b | tee x`, `list${eol}files`);

      expect(log).not.toContain("\r");
      const rows = dataRows(log);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatch(/^\| \d\d:\d\d:\d\d \| - \| `echo a {1,2}echo b \\\| tee x` \| list {1,2}files \|$/);
    });
  }

  it("leaves U+2028, U+2029 and a form feed alone: CommonMark does not end a line at them", () => {
    const log = logRow(hookPath, "echo a\u2028b\u2029c\fd", "x");

    expect(dataRows(log)).toHaveLength(1);
    expect(dataRows(log)[0]).toContain("echo a\u2028b\u2029c\fd");
  });

  it("detects the broken row when only LF is folded, so the passes above mean something", () => {
    // Reverse verification in the file: the hook with the fold narrowed back to LF,
    // run on the same input. The CR survives and the row ends at it.
    const shipped = fs.readFileSync(hookPath, "utf8");
    expect(shipped.split(FOLD)).toHaveLength(3); // intent and command
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-log-row-hook-"));
    scratch.push(dir);
    const narrowed = path.join(dir, "capture-command.sh");
    fs.writeFileSync(narrowed, shipped.split(FOLD).join("tr '\\n' ' '"));

    const log = logRow(narrowed, "echo a\recho b", "list\rfiles");

    expect(log).toContain("\r");
    expect(dataRows(log).length).toBeGreaterThan(1);
  });
});
