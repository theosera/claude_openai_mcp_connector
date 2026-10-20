import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanSource, type FileScan } from "./tools/syncChildScan.js";

const TESTS = dirname(fileURLToPath(import.meta.url));
const HELPER = "tools/syncChild.ts";
const SCRIPT = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

function scriptsUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = join(directory, entry.name);
      return entry.isDirectory() ? scriptsUnder(file) : entry.isFile() && SCRIPT.test(entry.name) ? [file] : [];
    });
}

const scans = scriptsUnder(TESTS).map((file) => ({
  path: relative(TESTS, file).split(sep).join("/"),
  scan: scanSource(file, readFileSync(file, "utf8"))
}));

/** Only this file path owns the unwrapped calls; a helper-shaped name grants no exemption. */
function violations(path: string, scan: FileScan): string[] {
  if (path === HELPER) return [];
  return [
    ...scan.calls.filter((call) => !call.capped).map((call) => `tests/${path}:${call.line} ${call.api}: ${call.why}`),
    ...scan.loads.map((line) => `tests/${path}:${line} child_process load: its bindings are not followed`)
  ];
}

describe("the synchronous child-process cap throughout tests", () => {
  it("names every unbounded call and unsupported child_process load outside the helper file", () => {
    expect(scans.flatMap(({ path, scan }) => violations(path, scan))).toEqual([]);
  });

  it("reaches the suite, migrated calls, native helper calls and the performance controls", () => {
    expect(scans.length).toBeGreaterThanOrEqual(40);
    expect(scans.reduce((total, { scan }) => total + scan.bounded, 0)).toBeGreaterThanOrEqual(74);
    const helper = scans.find(({ path }) => path === HELPER);
    const performance = scans.find(({ path }) => path === "logRedactionPerf.test.ts");
    expect(helper?.scan.calls.map((call) => call.api)).toEqual(["execFileSync", "spawnSync"]);
    expect(performance?.scan.calls.map((call) => call.capped)).toEqual([true, true]);
  });
});

describe("the synchronous-child AST scanner's supported forms", () => {
  it("finds aliases, namespace calls and default-import property calls", () => {
    const scan = scanSource(
      "probe.ts",
      [
        'import { execFileSync as run } from "node:child_process";',
        'import * as cp from "child_process";',
        'import child from "node:child_process";',
        'run("node", []);',
        'cp.spawnSync("node", []);',
        'child.execSync("node");'
      ].join("\n")
    );
    expect(scan.calls.map(({ line, api, capped }) => ({ line, api, capped }))).toEqual([
      { line: 4, api: "execFileSync", capped: false },
      { line: 5, api: "spawnSync", capped: false },
      { line: 6, api: "execSync", capped: false }
    ]);
  });

  it("accepts a direct timeout key, shorthand, two-argument overload and execSync options", () => {
    const scan = scanSource(
      "probe.ts",
      [
        'execFileSync("node", [], { timeout: 500 });',
        'spawnSync("node", [], { timeout });',
        'execFileSync("node", { "timeout": 500 });',
        'execSync("node", { timeout: 500 });'
      ].join("\n")
    );
    expect(
      scan.calls.map(({ line, api, capped, why }) => ({
        line,
        api,
        capped,
        why
      }))
    ).toEqual([
      {
        line: 1,
        api: "execFileSync",
        capped: true,
        why: "its options name a timeout"
      },
      {
        line: 2,
        api: "spawnSync",
        capped: true,
        why: "its options name a timeout"
      },
      {
        line: 3,
        api: "execFileSync",
        capped: true,
        why: "its options name a timeout"
      },
      {
        line: 4,
        api: "execSync",
        capped: true,
        why: "its options name a timeout"
      }
    ]);
  });

  it.each([
    ['execFileSync("node", [], options);', "its options are not an object literal"],
    ['execFileSync("node", [], { ...options });', "its options spread another object, which may hide the timeout"],
    ['spawnSync("node", []);', "it passes no options"],
    ['execFileSync("node", [], { timeout: 0 });', "its options set timeout to 0, which Node treats as no limit"],
    ['execSync("node", { nested: { timeout: 500 } });', "its options name a timeout only inside a nested value"]
  ])("keeps an unresolved cap closed: %s", (source, why) => {
    const scan = scanSource("probe.ts", source);
    expect(scan.calls).toHaveLength(1);
    expect(scan.calls[0]).toMatchObject({ line: 1, capped: false, why });
    expect(violations("probe.ts", scan)).toEqual([`tests/probe.ts:1 ${scan.calls[0].api}: ${why}`]);
  });

  it("reports require and dynamic import without claiming to follow their bindings", () => {
    const scan = scanSource(
      "probe.ts",
      'const cp = require("child_process");\nconst other = await import("node:child_process");'
    );
    expect(scan.loads).toEqual([1, 2]);
    expect(violations("probe.ts", scan)).toEqual([
      "tests/probe.ts:1 child_process load: its bindings are not followed",
      "tests/probe.ts:2 child_process load: its bindings are not followed"
    ]);
  });

  it("does not read names in strings, templates, comments or regular expressions as calls", () => {
    const source = [
      'const text = "execFileSync( spawnSync( execSync(";',
      "const template = `execFileSync( spawnSync( execSync(`;",
      '// execFileSync("node");',
      '/* spawnSync("node"); execSync("node"); */',
      "const pattern = /execFileSync\\(|spawnSync\\(|execSync\\(/;"
    ].join("\n");
    expect(scanSource("probe.ts", source)).toEqual({
      calls: [],
      loads: [],
      bounded: 0
    });
  });

  it("counts bounded calls but still names a native call inside a self-named wrapper", () => {
    const scan = scanSource(
      "probe.ts",
      [
        "function execFileSyncBounded(file) {",
        "  return execFileSync(file);",
        "}",
        'execFileSyncBounded("node");',
        'spawnSyncBounded("node");'
      ].join("\n")
    );
    expect(scan.bounded).toBe(2);
    expect(scan.calls).toEqual([
      {
        line: 2,
        api: "execFileSync",
        capped: false,
        why: "it passes no options"
      }
    ]);
    expect(violations("probe.ts", scan)).toEqual(["tests/probe.ts:2 execFileSync: it passes no options"]);
    expect(violations(HELPER, scan)).toEqual([]);
  });
});
