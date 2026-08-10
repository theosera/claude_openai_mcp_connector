/**
 * Keep the host filesystem layout out of client-visible error text.
 *
 * `toPublicDocument` (src/server.ts) already withholds `absolutePath` from every
 * document a tool returns, on the stated ground that the host's directory layout
 * is not a client's business. The ERROR channel had no such boundary. A raw fs
 * rejection carries the failing path in its `message`, and the MCP server sends
 * exactly `error.message` back as an `isError` tool result, so:
 *
 *   * `apply_planned_update` / `apply_planned_document_create` /
 *     `apply_planned_skill_create` with an unknown patch id echoed
 *     `<MCP_PATCH_STATE_DIR>/<uuid>.json` — OS username and home layout included;
 *   * `apply_planned_update` whose target was deleted after planning echoed
 *     `<KNOWLEDGE_ROOT>/…` from `fs.realpath` inside `resolveForExistingRead` —
 *     a different origin than the reads above, which is why catching the reads
 *     would not have closed it.
 *
 * The fix is a CLASS exclusion, not a list of call sites. Enumerating the known
 * throw sites is the shape that already failed here: the scan that reported this
 * counted two of the four, and the fifth fs call added later would leak again.
 * So no system error reaches a client at all. Only the errno code survives — it
 * is useful to a caller ("ENOENT" vs "EACCES") and names nothing about the host.
 *
 * Server-authored errors pass through unchanged: their text is written here, and
 * the values interpolated into them are vault-relative paths and client-supplied
 * ids, never absolute paths (pinned in tests/clientSafeError.test.ts).
 */

/** Message prefix for any system error that would otherwise reach a client. */
export const CLIENT_SAFE_SYSTEM_ERROR_PREFIX = "The server could not complete a filesystem operation";

/**
 * A system (libuv/POSIX) error, as opposed to one the server constructed.
 *
 * The discriminator is the shape Node attaches to errors it raises from a
 * syscall: a string `code` plus at least one of `syscall` / `errno` / `path`.
 * Errors built with `new Error(message, { cause })` carry none of those, and the
 * SDK's protocol errors use a NUMERIC `code`, so neither is captured here.
 */
export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as NodeJS.ErrnoException;
  if (typeof candidate.code !== "string") {
    return false;
  }
  return (
    typeof candidate.syscall === "string" || typeof candidate.errno === "number" || typeof candidate.path === "string"
  );
}

/**
 * Project an error onto what a client is allowed to see.
 *
 * The original is kept as `cause` so server-side diagnostics lose nothing; the
 * MCP server only ever transmits `error.message`, and `cause` set through the
 * Error options bag is non-enumerable, so it does not ride along.
 */
export function toClientSafeError(error: unknown): unknown {
  if (!isSystemError(error)) {
    return error;
  }
  return new Error(`${CLIENT_SAFE_SYSTEM_ERROR_PREFIX} (${error.code}).`, { cause: error });
}

/**
 * Wrap a store so every method's failure crosses this boundary.
 *
 * A Proxy rather than an explicit per-method wrapper on purpose: a method added
 * to a store later is guarded by DEFAULT, which is the same property that makes
 * `toPublicDocument` an allowlist instead of a `delete`. An explicit wrapper
 * would have to be extended in lockstep, and the failure mode of forgetting is
 * silent.
 *
 * `this` stays bound to the underlying instance, so private fields and internal
 * self-calls behave exactly as they do unwrapped — only the outermost rejection
 * is rewritten. Retry logic that inspects fs codes (`isTransientFsError`) lives
 * inside the store and never sees this boundary.
 */
export function withClientSafeErrors<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        try {
          const result = method.apply(object, args);
          if (result instanceof Promise) {
            return result.catch((error: unknown) => {
              throw toClientSafeError(error);
            });
          }
          return result;
        } catch (error) {
          throw toClientSafeError(error);
        }
      };
    }
  });
}
