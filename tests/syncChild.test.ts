import { mkdtempSync, rmSync } from "node:fs";
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

describe("bounded synchronous child processes", () => {
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
    expect(execFileSyncBounded("bash", ["-c", "printf ok"], OPTIONS)).toBe("ok");
    expect(execFileSyncBounded("/usr/bin/true", { ...OPTIONS, input: undefined })).toBe("");
    const success = spawnSyncBounded("bash", ["-c", "printf ok"], OPTIONS);
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
    const error = thrownBy(() =>
      execFileSyncBounded("bash", ["-c", "printf DUMMY_OUT; printf DUMMY_ERR >&2; exit 3"], OPTIONS)
    );
    expect(error).toMatchObject({
      status: 3,
      signal: null,
      stdout: "DUMMY_OUT",
      stderr: "DUMMY_ERR"
    });
    expect(error.message).not.toContain("runaway cap");
  });

  it("returns a non-timeout spawnSync failure without manufacturing an error", () => {
    const result = spawnSyncBounded("bash", ["-c", "printf DUMMY_OUT; printf DUMMY_ERR >&2; exit 3"], OPTIONS);
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
