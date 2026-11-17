import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root (the parent of `scripts/`). */
export const repoRoot = path.resolve(scriptsDir, "..");

/**
 * Parse a `.env` file into a plain object **without** mutating `process.env`.
 * Using `dotenv.parse` (not `dotenv.config`) is deliberate: several endpoint
 * configs are read side by side in one process, and the audit-scan separation
 * relies on each endpoint's variables staying isolated from the others.
 */
export function parseEnvFile(envPath) {
  const resolved = path.resolve(envPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing env file: ${resolved} (copy .env.example and configure it, or pass --env <path>).`);
  }
  return { resolved, env: dotenv.parse(fs.readFileSync(resolved)) };
}

/** Validate and return `MCP_HTTP_PORT` (defaults to 8787), matching the server. */
export function parsePort(value, envPath) {
  const raw = (value ?? "").trim() || "8787";
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw) {
    throw new Error(`Invalid MCP_HTTP_PORT="${raw}" in ${envPath}.`);
  }
  return port;
}

/**
 * Truthiness for the `MCP_HTTP_ALLOW_*` flags. Kept **byte-identical** to the
 * server's `isTruthy` (`src/config.ts`) so the check's "declared surface"
 * matches exactly what the server would enable.
 */
export function isTruthy(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** A value counts as configured when it is non-empty after trimming and not a `replace-with-…` placeholder. */
function configured(value) {
  const trimmed = value?.trim();
  return trimmed && !trimmed.startsWith("replace-with-") ? trimmed : undefined;
}

/** Read a required secret from a parsed env object; never logged by callers. */
export function requiredEnv(env, name, envPath) {
  const value = configured(env[name]);
  if (!value) {
    throw new Error(`${name} must be configured in ${envPath}.`);
  }
  return value;
}

const BEARER = "MCP_AUTH_TOKEN";

/**
 * The bearer check:http sends to one endpoint, and where it came from.
 *
 * With a single endpoint, a bearer in the environment wins over the file's, in
 * the same order the server reads them, so the check keeps working once the
 * token is kept out of the file and handed to the server through the
 * environment. With two or more endpoints only each one's own file counts: one
 * environment value cannot belong to both the interactive and the scan
 * endpoint, and reading it would undo their separation.
 *
 * Returns `{ token, source, warning }`. `source` is "environment" or the file's
 * path. `warning` is set when both hold a value and they differ; it names the
 * file, never either value. Callers must not log `token`.
 */
export function resolveBearer(env, envPath, endpointCount, processEnv = process.env) {
  const fromFile = configured(env[BEARER]);
  const fromEnvironment = endpointCount === 1 ? configured(processEnv[BEARER]) : undefined;
  if (fromEnvironment) {
    const warning =
      fromFile && fromFile !== fromEnvironment
        ? `${BEARER} in the environment differs from ${envPath}; using the environment.`
        : undefined;
    return { token: fromEnvironment, source: "environment", warning };
  }
  if (fromFile) return { token: fromFile, source: envPath, warning: undefined };
  throw new Error(`${BEARER} must be configured in ${envPath} or (with a single --env) the environment.`);
}
