import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { OAuthConfig } from "./oauth/provider.js";

dotenv.config();

export interface AppConfig {
  knowledgeRoot: string;
  writeMode: "two_step";
  patchStateDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const knowledgeRoot = env.KNOWLEDGE_ROOT?.trim();
  if (!knowledgeRoot) {
    throw new Error("KNOWLEDGE_ROOT is required. Point it at your private Markdown vault clone.");
  }

  const writeMode = env.MCP_WRITE_MODE?.trim() || "two_step";
  if (writeMode !== "two_step") {
    throw new Error("Only MCP_WRITE_MODE=two_step is supported for existing document edits.");
  }

  return {
    knowledgeRoot: path.resolve(knowledgeRoot),
    writeMode,
    patchStateDir: path.resolve(env.MCP_PATCH_STATE_DIR?.trim() || ".mcp-state/patches")
  };
}

export type TransportKind = "stdio" | "http";

export interface HttpConfig {
  host: string;
  port: number;
  /** Bearer secret every HTTP request must present. Never hardcoded — env only. */
  authToken: string;
  /** Whether write tools are exposed over HTTP. Defaults off (read-only). */
  allowWrite: boolean;
  /** Allowed Host headers (DNS-rebinding protection). */
  allowedHosts: string[];
  /** Allowed Origins (DNS-rebinding protection). Empty = allow any origin. */
  allowedOrigins: string[];
  /** Optional public base used to build ChatGPT citation URLs. */
  chatgptUrlBase?: string;
  /**
   * OAuth 2.1 authorization server config. Present only when MCP_OAUTH_ENABLED
   * is set — required for ChatGPT / Claude.ai web, which reject static bearers.
   * When absent, only the static MCP_AUTH_TOKEN bearer is accepted.
   */
  oauth?: OAuthConfig;
}

/** Pick the transport from MCP_TRANSPORT (default stdio). */
export function selectedTransport(env: NodeJS.ProcessEnv = process.env): TransportKind {
  const value = env.MCP_TRANSPORT?.trim().toLowerCase();
  if (!value || value === "stdio") {
    return "stdio";
  }
  if (value === "http") {
    return "http";
  }
  throw new Error(`Unsupported MCP_TRANSPORT="${value}". Use "stdio" or "http".`);
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Load the HTTP transport config. Fails CLOSED: a private vault must never be
 * served over HTTP without an auth token, so a missing/empty MCP_AUTH_TOKEN is
 * a hard error rather than an open endpoint.
 */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const authToken = env.MCP_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error(
      "MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http. Refusing to serve the private vault over HTTP without authentication."
    );
  }

  const host = env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(env.MCP_HTTP_PORT?.trim() || "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT="${env.MCP_HTTP_PORT}". Must be 1-65535.`);
  }

  const splitList = (value: string | undefined): string[] =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

  const allowedHosts = splitList(env.MCP_HTTP_ALLOWED_HOSTS);
  if (allowedHosts.length === 0) {
    allowedHosts.push(`${host}:${port}`, `localhost:${port}`);
  }

  const allowWrite = isTruthy(env.MCP_HTTP_ALLOW_WRITE);
  const publicUrl = env.MCP_HTTP_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  const oauth = loadOAuthConfig(env, publicUrl, allowWrite);

  // When OAuth is on, the public (tunnel) host receives the actual /mcp traffic,
  // so it must be in the DNS-rebinding allowlist.
  if (publicUrl) {
    try {
      allowedHosts.push(new URL(publicUrl).host);
    } catch {
      throw new Error(`Invalid MCP_HTTP_PUBLIC_URL="${publicUrl}".`);
    }
  }

  return {
    host,
    port,
    authToken,
    allowWrite,
    allowedHosts,
    allowedOrigins: splitList(env.MCP_HTTP_ALLOWED_ORIGINS),
    chatgptUrlBase: publicUrl,
    oauth
  };
}

function loadOAuthConfig(
  env: NodeJS.ProcessEnv,
  publicUrl: string | undefined,
  allowWrite: boolean
): OAuthConfig | undefined {
  if (!isTruthy(env.MCP_OAUTH_ENABLED)) {
    return undefined;
  }
  // Fail-closed: OAuth needs a public issuer URL and a login password. Without
  // them we must not advertise a half-built authorization server.
  if (!publicUrl) {
    throw new Error("MCP_OAUTH_ENABLED requires MCP_HTTP_PUBLIC_URL (the public https issuer URL).");
  }
  if (!/^https:\/\//.test(publicUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(publicUrl)) {
    throw new Error("MCP_HTTP_PUBLIC_URL must be https (or http loopback for local testing) when OAuth is enabled.");
  }
  const loginPassword = env.MCP_OAUTH_PASSWORD?.trim();
  if (!loginPassword) {
    throw new Error("MCP_OAUTH_ENABLED requires MCP_OAUTH_PASSWORD (the vault login password).");
  }
  const ttl = (value: string | undefined, fallback: number): number => {
    const n = Number.parseInt(value?.trim() || String(fallback), 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    issuer: publicUrl,
    loginPassword,
    accessTokenTtlSec: ttl(env.MCP_OAUTH_ACCESS_TTL, 3600),
    refreshTokenTtlSec: ttl(env.MCP_OAUTH_REFRESH_TTL, 2592000),
    codeTtlSec: ttl(env.MCP_OAUTH_CODE_TTL, 60),
    allowWrite
  };
}
