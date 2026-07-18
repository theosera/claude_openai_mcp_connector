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

/** Read a required secret from a parsed env object; never logged by callers. */
export function requiredEnv(env, name, envPath) {
  const value = env[name]?.trim();
  if (!value || value.startsWith("replace-with-")) {
    throw new Error(`${name} must be configured in ${envPath}.`);
  }
  return value;
}
