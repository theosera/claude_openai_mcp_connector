import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(scriptsDir, "..");
export const repoEnvPath = path.join(repoRoot, ".env");

export function loadRepoEnv() {
  if (!fs.existsSync(repoEnvPath)) {
    throw new Error(`Missing ${repoEnvPath}. Copy .env.example to .env and configure it first.`);
  }

  const result = dotenv.config({ path: repoEnvPath, override: true, quiet: true });
  if (result.error) {
    throw result.error;
  }
}

export function httpPort() {
  const value = process.env.MCP_HTTP_PORT?.trim() || "8787";
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== value) {
    throw new Error(`Invalid MCP_HTTP_PORT="${value}" in ${repoEnvPath}.`);
  }
  return port;
}

export function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("replace-with-")) {
    throw new Error(`${name} must be configured in ${repoEnvPath}.`);
  }
  return value;
}
