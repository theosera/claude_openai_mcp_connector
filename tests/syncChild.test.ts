import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { execFileSyncBounded, RUNAWAY_MS, runawayCapFor, spawnSyncBounded } from "./tools/syncChild.js";

const TEST_HOME = mkdtempSync(join(tmpdir(), "sync-child-unit-"));
// Give the child only the owned home, the tools it needs and synthetic test data.
const ENV = {
  PATH: "/usr/bin:/bin",
  HOME: TEST_HOME,
  DUMMY_CHILD_ENV: "DUMMY_ENV_NOT_IN_ERROR"
};
const INPUT = "DUMMY_INPUT_NOT_IN_ERROR";
const CAP = 500;
const SLEEP = ["-c", "exec sleep 600"];
// OPTIONS hands every child INPUT. A child that exits without reading it can make
// Node's write fail with EPIPE (once on Linux CI), so these read their stdin first.
const SUCCEED = ["-c", "cat >/dev/null; printf ok"];
const FAIL = ["-c", "cat >/dev/null; printf DUMMY_OUT; printf DUMMY_ERR >&2; exit 3"];
const OPTIONS = {
  timeout: CAP,
  cwd: TEST_HOME,
  env: ENV,
  input: INPUT,
  encoding: "utf8" as const,
  stdio: "pipe" as const
};

afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("the bounded child unexpectedly returned");
}

function checkRunaway(error: Error, startedAt: number): void {
  expect(performance.now() - startedAt).toBeLessThan(10_000);
  expect(error.message).toMatch(/^"bash" "-c" "exec sleep 600" was stopped by the runaway cap of 500 ms after \d+ ms$/);
  expect(error.message).not.toContain(INPUT);
  expect(error.message).not.toContain(ENV.DUMMY_CHILD_ENV);
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("stdout");
  expect(error).not.toHaveProperty("stderr");
}

/** A separate event loop can cut off a worker blocked inside a synchronous call. */
async function termResistantChild(api: "execFileSyncBounded" | "spawnSyncBounded"): Promise<void> {
  const ready = join(TEST_HOME, `${api}-ready`);
  const helper = new URL("./tools/syncChild.ts", import.meta.url).href;
  // Finite even if the worker or its cleanup fails. No shell or grandchild.
  const child = [
    'const { writeFileSync } = require("node:fs");',
    'process.on("SIGTERM", () => {});',
    `writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
    "setTimeout(() => process.exit(0), 15_000);"
  ].join("\n");
  const script = [
    `import { ${api} } from ${JSON.stringify(helper)};`,
    "const start = performance.now();",
    "try {",
    `  ${api}(process.execPath, ["-e", ${JSON.stringify(child)}], { timeout: 1000, killSignal: "SIGTERM", stdio: "pipe" });`,
    '  console.log(JSON.stringify({ outcome: "returned" }));',
    "} catch (error) {",
    '  console.log(JSON.stringify({ outcome: "threw", message: error.message, elapsed: performance.now() - start }));',
    "}"
  ].join("\n");
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    env: ENV,
    stdio: "pipe"
  });
  let stdout = "";
  let stderr = "";
  worker.stdout.setEncoding("utf8").on("data", (part: string) => (stdout += part));
  worker.stderr.setEncoding("utf8").on("data", (part: string) => (stderr += part));
  let cutoff = false;
  const timer = setTimeout(() => {
    cutoff = true;
    worker.kill("SIGKILL");
  }, 5_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("close", resolve);
    });
    expect(cutoff, "the synchronous call did not return before the independent outer cutoff").toBe(false);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    // This proves that the child's TERM handler was installed before the cap.
    expect(existsSync(ready)).toBe(true);
    const result = JSON.parse(stdout) as { outcome: string; message: string; elapsed: number };
    expect(result.outcome).toBe("threw");
    expect(result.message).toMatch(/runaway cap of 1000 ms/);
    expect(result.elapsed).toBeLessThan(5_000);
  } finally {
    clearTimeout(timer);
    worker.kill("SIGKILL");
    if (cutoff && existsSync(ready)) {
      const pid = Number(readFileSync(ready, "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        expect(error).toHaveProperty("code", "ESRCH");
      }
    }
  }
}

describe("bounded synchronous child processes", () => {
  it.each(["execFileSyncBounded", "spawnSyncBounded"] as const)(
    "%s sends SIGKILL even when a finite direct child ignores the caller's SIGTERM",
    { timeout: 10_000 },
    termResistantChild
  );

  it("stops execFileSync at a small cap without printing input, environment or the original error", () => {
    const startedAt = performance.now();
    checkRunaway(
      thrownBy(() => execFileSyncBounded("bash", SLEEP, OPTIONS)),
      startedAt
    );
  });

  it("turns spawnSync's timeout result into the same bounded error", () => {
    const startedAt = performance.now();
    checkRunaway(
      thrownBy(() => spawnSyncBounded("bash", SLEEP, OPTIONS)),
      startedAt
    );
  });

  it("masks URL userinfo before truncation and preserves ordinary URLs and a bounded argument head", () => {
    const tail = "DUMMY_LONG_ARGUMENT_TAIL";
    const longArgument = "a".repeat(200) + tail;
    const userinfo = "DUMMY_USER:DUMMY_PASSWORD";
    const longUserinfo = "DUMMY_CREDENTIAL_".repeat(20);
    const ordinaryUrl = "https://example.invalid/ordinary";
    const error = thrownBy(() =>
      execFileSyncBounded(
        "bash",
        [
          ...SLEEP,
          "_",
          longArgument,
          `https://${userinfo}@example.invalid/short`,
          `https://${longUserinfo}@example.invalid/long`,
          ordinaryUrl
        ],
        OPTIONS
      )
    );
    expect(error.message).toContain(JSON.stringify("a".repeat(120) + `… (${longArgument.length} chars)`));
    expect(error.message).not.toContain(tail);
    expect(error.message).toContain('"https://***@example.invalid/short"');
    expect(error.message).toContain('"https://***@example.invalid/long"');
    expect(error.message).not.toContain(userinfo);
    expect(error.message).not.toContain("DUMMY_CREDENTIAL_");
    expect(error.message).toContain(JSON.stringify(ordinaryUrl));
    expect(error).not.toHaveProperty("cause");
  });

  it("preserves successful output for argument and options-only overloads", () => {
    expect(execFileSyncBounded("bash", SUCCEED, OPTIONS)).toBe("ok");
    expect(execFileSyncBounded("/usr/bin/true", { ...OPTIONS, input: undefined })).toBe("");
    const success = spawnSyncBounded("bash", SUCCEED, OPTIONS);
    expect(success.status).toBe(0);
    expect(success.stdout).toBe("ok");
    expect(success.error).toBeUndefined();
    const noArguments = spawnSyncBounded("/usr/bin/true", {
      ...OPTIONS,
      input: undefined
    });
    expect(noArguments.status).toBe(0);
    expect(noArguments.error).toBeUndefined();
  });

  it("keeps a non-timeout execFileSync failure's status and output", () => {
    const error = thrownBy(() => execFileSyncBounded("bash", FAIL, OPTIONS));
    expect(error).toMatchObject({
      status: 3,
      signal: null,
      stdout: "DUMMY_OUT",
      stderr: "DUMMY_ERR"
    });
    // Node copies status and output onto a spawn error such as EPIPE too, so name the exit.
    expect(error.message).toMatch(/^Command failed: /);
    expect(error.message).not.toContain("runaway cap");
  });

  it("returns a non-timeout spawnSync failure without manufacturing an error", () => {
    const result = spawnSyncBounded("bash", FAIL, OPTIONS);
    expect(result).toMatchObject({
      status: 3,
      signal: null,
      stdout: "DUMMY_OUT",
      stderr: "DUMMY_ERR"
    });
    expect(result.error).toBeUndefined();
  });

  it("uses a caller's positive timeout and gives missing or zero timeouts the runaway cap", () => {
    expect(runawayCapFor(500)).toBe(500);
    expect(runawayCapFor(undefined)).toBe(RUNAWAY_MS);
    expect(runawayCapFor(0)).toBe(RUNAWAY_MS);
    expect(RUNAWAY_MS).toBe(300_000);
  });
});
