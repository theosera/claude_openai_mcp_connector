import * as childProcess from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { execFileSyncBounded, RUNAWAY_MS, spawnSyncBounded } from "./tools/syncChild.js";

// This file observes the helper-to-Node boundary without starting a child.
// Keep it separate from syncChild.test.ts, whose seven tests use real children.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn()
}));

const mockExecFileSync = vi.mocked(childProcess.execFileSync);
const mockSpawnSync = vi.mocked(childProcess.spawnSync);

const FILE = "DUMMY_CHILD_FILE";
const ARGS = ["DUMMY_ARGUMENT_ONE", "DUMMY_ARGUMENT_TWO"];
const ENV = { DUMMY_CHILD_OPTION: "DUMMY_ENV_VALUE" };
const OPTIONS = {
  input: "DUMMY_SYNC_CHILD_INPUT",
  encoding: "utf8" as const,
  cwd: "/DUMMY_CWD_NOT_USED_BY_A_PROCESS",
  env: ENV,
  stdio: "pipe" as const
};
const EXEC_RESULT = "DUMMY_EXEC_OUTPUT";
const SPAWN_RESULT = {
  pid: 0,
  output: [null, "DUMMY_SPAWN_OUTPUT", ""],
  stdout: "DUMMY_SPAWN_OUTPUT",
  stderr: "",
  status: 0,
  signal: null
} satisfies childProcess.SpawnSyncReturns<string>;

const TIMEOUT_CASES = [
  { name: "missing", timeoutOptions: {}, expectedTimeout: RUNAWAY_MS },
  { name: "zero", timeoutOptions: { timeout: 0 }, expectedTimeout: RUNAWAY_MS },
  { name: "positive", timeoutOptions: { timeout: 500 }, expectedTimeout: 500 }
];

beforeEach(() => {
  // restoreMocks is enabled by the suite; establish each mock's behavior anew.
  mockExecFileSync.mockReset();
  mockSpawnSync.mockReset();
});

describe("bounded child options passed to Node without running a child", () => {
  it.each(TIMEOUT_CASES)(
    "execFileSync forwards a $name timeout and all other options",
    ({ timeoutOptions, expectedTimeout }) => {
      mockExecFileSync.mockReturnValue(EXEC_RESULT);
      const args = [...ARGS];
      const env = { ...ENV };
      const options = { ...OPTIONS, ...timeoutOptions, env };
      const before = { ...options, env: { ...env } };
      const argsBefore = [...args];

      expect(execFileSyncBounded(FILE, args, options)).toBe(EXEC_RESULT);

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      expect(mockExecFileSync).toHaveBeenCalledWith(FILE, argsBefore, { ...before, timeout: expectedTimeout });
      expect(mockExecFileSync.mock.calls[0]?.[1]).toBe(args);
      expect(mockExecFileSync.mock.calls[0]?.[2]?.env).toBe(env);
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(args).toEqual(argsBefore);
      expect(env).toEqual(before.env);
      expect(options).toEqual(before);
    }
  );

  it.each(TIMEOUT_CASES)(
    "spawnSync forwards a $name timeout and all other options",
    ({ timeoutOptions, expectedTimeout }) => {
      const result = { ...SPAWN_RESULT, output: [...SPAWN_RESULT.output] };
      const beforeResult = { ...result, output: [...result.output] };
      mockSpawnSync.mockReturnValue(result);
      const args = [...ARGS];
      const env = { ...ENV };
      const options = { ...OPTIONS, ...timeoutOptions, env };
      const before = { ...options, env: { ...env } };
      const argsBefore = [...args];

      expect(spawnSyncBounded(FILE, args, options)).toBe(result);
      expect(result).toEqual(beforeResult);

      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      expect(mockSpawnSync).toHaveBeenCalledWith(FILE, argsBefore, { ...before, timeout: expectedTimeout });
      expect(mockSpawnSync.mock.calls[0]?.[1]).toBe(args);
      expect(mockSpawnSync.mock.calls[0]?.[2]?.env).toBe(env);
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(args).toEqual(argsBefore);
      expect(env).toEqual(before.env);
      expect(options).toEqual(before);
    }
  );

  it("forwards an execFileSync options-only overload with an empty argument list", () => {
    mockExecFileSync.mockReturnValue(EXEC_RESULT);
    const env = { ...ENV };
    const options = { ...OPTIONS, timeout: 500, env };
    const before = { ...options, env: { ...env } };

    expect(execFileSyncBounded(FILE, options)).toBe(EXEC_RESULT);

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(FILE, [], before);
    expect(mockExecFileSync.mock.calls[0]?.[2]?.env).toBe(env);
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(env).toEqual(before.env);
    expect(options).toEqual(before);
  });
});
