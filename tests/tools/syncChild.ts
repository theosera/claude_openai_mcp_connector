import { execFileSync, spawnSync, type ExecFileSyncOptions, type SpawnSyncOptions } from "node:child_process";

/**
 * Synchronous child processes for the tests, each under a runaway cap.
 *
 * vitest's timeout cannot stop a synchronous call: while execFileSync or
 * spawnSync waits, the worker runs no timers, so a child that never exits keeps
 * the whole run from finishing. On 2026-10-19 a full run stood for three hours on
 * one such call. Every synchronous child in tests/ goes through here, or names
 * its own `timeout`; tests/syncChildTimeout.test.ts holds the suite to that.
 *
 * The cap stops a runaway and judges nothing. A test that wants a judgement
 * (logRedactionPerf's ceilings) keeps its own numbers. A caller's positive
 * `timeout` is used as given; a missing or zero one becomes the cap, since zero
 * means "no limit" to Node.
 *
 * The cap stops the direct child only. A grandchild, such as one stage of a shell
 * pipeline, can outlive it until its own work ends or its input reaches EOF
 * (measured 2026-10-20). The full run's procedure counts what is left afterwards.
 */
export const RUNAWAY_MS = 300_000;

/** How much of each argument the error shows. A mask's whole script travels as one argument. */
const HEAD_CHARS = 120;

/**
 * The command as the error names it: the file and the head of each argument.
 * Never the input or the environment, which can carry a test's token-shaped values.
 * Arguments can also contain synthetic credentials (for example git_url_id probes),
 * so URL userinfo is masked before the argument is shortened.
 */
function commandHead(file: string, args: readonly string[]): string {
  return [file, ...args]
    .map((part) => part.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/g, "$1***@"))
    .map((part) => (part.length > HEAD_CHARS ? `${part.slice(0, HEAD_CHARS)}… (${part.length} chars)` : part))
    .map((part) => JSON.stringify(part))
    .join(" ");
}

/**
 * The error for a stopped child. The original error is not attached: it carries
 * the child's stdout and stderr, which a test's runner would print.
 */
function runaway(file: string, args: readonly string[], timeout: number, startedAt: number): Error {
  const ms = (performance.now() - startedAt).toFixed(0);
  return new Error(`${commandHead(file, args)} was stopped by the runaway cap of ${timeout} ms after ${ms} ms`);
}

/** The timeout a call runs under: the caller's if positive, else the cap. Exported for its test. */
export function runawayCapFor(timeout: number | undefined): number {
  return timeout !== undefined && timeout > 0 ? timeout : RUNAWAY_MS;
}

function splitArgs<O>(
  argsOrOptions: readonly string[] | O | undefined,
  options: O | undefined
): [readonly string[], O | undefined] {
  return Array.isArray(argsOrOptions) ? [argsOrOptions, options] : [[], argsOrOptions as O | undefined];
}

/** execFileSync with the runaway cap. Any other failure is thrown as execFileSync threw it. */
export const execFileSyncBounded = ((
  file: string,
  argsOrOptions?: readonly string[] | ExecFileSyncOptions,
  maybeOptions?: ExecFileSyncOptions
) => {
  const [args, options] = splitArgs(argsOrOptions, maybeOptions);
  const timeout = runawayCapFor(options?.timeout);
  const startedAt = performance.now();
  try {
    return execFileSync(file, args, { ...options, timeout });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ETIMEDOUT") throw runaway(file, args, timeout, startedAt);
    throw error;
  }
}) as typeof execFileSync;

/**
 * spawnSync with the runaway cap. spawnSync does not throw when its timeout fires,
 * so a stopped child is turned into the same error; every other result is
 * returned as spawnSync returned it.
 */
export const spawnSyncBounded = ((
  file: string,
  argsOrOptions?: readonly string[] | SpawnSyncOptions,
  maybeOptions?: SpawnSyncOptions
) => {
  const [args, options] = splitArgs(argsOrOptions, maybeOptions);
  const timeout = runawayCapFor(options?.timeout);
  const startedAt = performance.now();
  const result = spawnSync(file, args, { ...options, timeout });
  if ((result.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT")
    throw runaway(file, args, timeout, startedAt);
  return result;
}) as typeof spawnSync;
