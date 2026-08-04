import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { OAuthConfig } from "./oauth/provider.js";
import { assertRelativePath, posixContains, toPosixPath } from "./pathSafety.js";

/**
 * Load an optional operator-named env file into `env`.
 *
 * This module used to call `dotenv.config()` as an import-time side effect,
 * which reads `.env` from the **process working directory**. In the documented
 * stdio deployment the MCP client spawns `node dist/index.js` with only
 * `KNOWLEDGE_ROOT` in its `env`, so the cwd is whatever directory the client
 * happened to be started in — untrusted ground. A `.env` sitting there could
 * therefore choose `MCP_AUTH_TOKEN`, `MCP_OAUTH_PASSWORD`, `MCP_TRANSPORT`,
 * `MCP_HTTP_HOST`, the `MCP_HTTP_ALLOW_*` write opt-ins and `KNOWLEDGE_ROOTS`
 * (which outranks `KNOWLEDGE_ROOT`) — turning a local, read-only stdio server
 * into a write-enabled HTTP listener with an attacker-known bearer token.
 *
 * So there is **no cwd fallback and no search**: a file is read only when the
 * operator names one explicitly, by ABSOLUTE path, in the real process
 * environment (`MCP_ENV_FILE`). A relative or unreadable path is a startup
 * error rather than a silent skip. Parsing and precedence stay dotenv's own —
 * `dotenv.parse` on the file bytes, then populate WITHOUT override, so a value
 * already present in the environment always wins over the file.
 *
 * Called once from `src/index.ts` at startup, never on import, so importing
 * this module can no longer mutate `process.env`.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.MCP_ENV_FILE?.trim();
  if (!configured) {
    return undefined;
  }
  if (!path.isAbsolute(configured)) {
    throw new Error(
      `MCP_ENV_FILE must be an absolute path (got "${configured}"). A relative path would resolve against the process working directory, which is exactly what this variable exists to avoid.`
    );
  }
  let contents: string;
  try {
    contents = fs.readFileSync(configured, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read MCP_ENV_FILE="${configured}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  for (const [key, value] of Object.entries(dotenv.parse(contents))) {
    // dotenv's populate semantics without `override`: a key already present in
    // the environment is never replaced by a file value.
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = value;
    }
  }
  return configured;
}

/** One named knowledge root. The FIRST configured root is the primary
 *  (writable) root; every additional root is exposed strictly read-only. */
export interface KnowledgeRoot {
  name: string;
  path: string;
}

export interface AppConfig {
  /** Ordered roots; index 0 = primary (writable). Always at least one entry. */
  knowledgeRoots: KnowledgeRoot[];
  writeMode: "two_step";
  patchStateDir: string;
  /** Vault-relative directory that may receive instruction-only Skill bundles. */
  skillsSubdir?: string;
  /** Vault-relative subtree reserved for the audit write surface (append + CAS).
   *  When set, general document writes may NOT target it (INV-9). */
  auditSubdir?: string;
  /** Max Markdown files opened concurrently during a scan (bounds FD pressure). */
  scanConcurrency?: number;
  /**
   * How strongly recency boosts a search hit (0 = off, the default, so an
   * upgrade changes no ranking until an operator opts in). Applied
   * multiplicatively, so it re-orders matches without surfacing non-matches.
   */
  searchRecencyWeight?: number;
  /** Half-life in days for that boost. */
  searchRecencyHalfLifeDays?: number;
}

/** Config for a single-root KnowledgeStore instance. */
export interface StoreConfig {
  knowledgeRoot: string;
  writeMode: "two_step";
  patchStateDir: string;
  /** Vault-relative subtree reserved for the constrained Skill write surface.
   *  General document writes into it are rejected (INV-8) — only SkillStore may
   *  create Skills there. Set on the PRIMARY root only. */
  skillsSubdir?: string;
  /** Vault-relative subtree reserved for the audit write surface. General
   *  document writes into it are rejected (INV-9). Set on the PRIMARY root only. */
  auditSubdir?: string;
  /** Max Markdown files opened concurrently during a scan (bounds FD pressure). */
  scanConcurrency?: number;
  /** Operator-level recency ranking defaults; see AppConfig. */
  searchRecencyWeight?: number;
  searchRecencyHalfLifeDays?: number;
}

// Root names become id/path prefixes (`name:relative/path`) in multi-root
// results, so keep them short, lowercase, and unambiguous.
const ROOT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Where two-step plans live when the operator names no location.
 *
 * A plan holds vault plaintext, so this must never resolve against the working
 * directory — for a client-spawned stdio server the client picks that. The home
 * directory is the anchor, but it is not guaranteed to supply one: `os.homedir()`
 * returns `""` when HOME is set to an empty value and cannot fall back to a
 * passwd entry, and it returns HOME verbatim when HOME is relative. Either way
 * `path.join` yields a relative string and `path.resolve` re-anchors it to the
 * cwd — reinstating the exact placement this default exists to prevent, in the
 * environments most likely to strip HOME (service accounts, and the `--clearenv`
 * bwrap recipe in `docs/operations.md`). So refuse to guess and make the
 * operator name it, rather than silently writing plaintext somewhere else.
 */
function defaultPatchStateDir(primaryRoot: string): string {
  const home = os.homedir();
  if (!path.isAbsolute(home)) {
    throw new Error(
      "MCP_PATCH_STATE_DIR must be set to an absolute path: no home directory is available to derive the " +
        "default from. Two-step plan state holds vault plaintext and must not fall back to the working directory."
    );
  }
  // Per vault, so two servers started against different roots never share a plan
  // directory by accident. `applyPlannedUpdate` looks a plan up by `patch_id`
  // alone and resolves its target path against whichever root the running store
  // has, so a shared directory lets a plan staged for one vault be applied to
  // another. The stale check still has to pass — that needs byte-identical
  // content at the same relative path in both — but nothing else stands in the
  // way, and a single shared default would have made that the normal setup.
  //
  // Suffixed, not nested: `patches/<tag>` would put the state directory one
  // level deeper, and `ensurePatchStateDir` only refuses a symlink at the leaf
  // (`mkdir` with `recursive` follows symlinked parents), so nesting would add a
  // parent that nothing checks. Same depth as before keeps that guard's reach
  // unchanged.
  const tag = crypto.createHash("sha256").update(primaryRoot).digest("hex").slice(0, 16);
  return path.join(home, ".mcp-state", `patches-${tag}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const knowledgeRoots = parseKnowledgeRoots(env);

  const writeMode = env.MCP_WRITE_MODE?.trim() || "two_step";
  if (writeMode !== "two_step") {
    throw new Error("Only MCP_WRITE_MODE=two_step is supported for existing document edits.");
  }

  const rawSkillsSubdir = env.MCP_SKILLS_SUBDIR?.trim();
  const skillsSubdir = rawSkillsSubdir ? toPosixPath(assertRelativePath(rawSkillsSubdir)) : undefined;
  if (skillsSubdir && (posixContains("projects", skillsSubdir) || posixContains(skillsSubdir, "projects"))) {
    // The Skills subtree is reserved against the general write surface (INV-8),
    // and create_document always writes under "projects/". Overlapping the two
    // means the reservation fires on ordinary creates, so the create root is
    // dead for as long as the misconfiguration stands. Fail at boot, where the
    // cause is legible, rather than once per create — the same reason the audit
    // subdir is checked against "projects/" just below.
    throw new Error('MCP_SKILLS_SUBDIR must be disjoint from the "projects/" document-create root.');
  }

  const rawAuditSubdir = env.MCP_AUDIT_SUBDIR?.trim();
  const auditSubdir = rawAuditSubdir ? toPosixPath(assertRelativePath(rawAuditSubdir)) : undefined;
  if (auditSubdir) {
    // create_document always writes under "projects/"; keep the reserved audit
    // subtree disjoint from it so a misconfiguration fails loudly at boot instead
    // of silently rejecting every create later (INV-9 exclusion would otherwise
    // fire on legitimate creates).
    if (posixContains("projects", auditSubdir) || posixContains(auditSubdir, "projects")) {
      throw new Error('MCP_AUDIT_SUBDIR must be disjoint from the "projects/" document-create root.');
    }
    // SkillStore writes into MCP_SKILLS_SUBDIR and does NOT apply the INV-9 audit
    // reservation, so an overlap would let a Skill write land in the reserved
    // audit area. Require the two subtrees to be disjoint.
    if (skillsSubdir && (posixContains(skillsSubdir, auditSubdir) || posixContains(auditSubdir, skillsSubdir))) {
      throw new Error("MCP_AUDIT_SUBDIR and MCP_SKILLS_SUBDIR must be disjoint reserved subtrees.");
    }
  }

  // Bounds how many files a vault scan opens at once. Left undefined (the store
  // applies a safe default) unless a positive integer override is provided.
  const parsedScanConcurrency = Number.parseInt(env.MCP_SCAN_CONCURRENCY?.trim() || "", 10);
  const scanConcurrency =
    Number.isInteger(parsedScanConcurrency) && parsedScanConcurrency > 0 ? parsedScanConcurrency : undefined;

  // Recency ranking is opt-in. Left undefined (the search layer applies its own
  // default of 0 = off) unless a usable number is supplied, so a malformed value
  // degrades to "unchanged ranking" rather than to a surprising one.
  const searchRecencyWeight = parsePositiveNumber(env.MCP_SEARCH_RECENCY_WEIGHT);
  const searchRecencyHalfLifeDays = parsePositiveNumber(env.MCP_SEARCH_RECENCY_HALFLIFE_DAYS);

  return {
    knowledgeRoots,
    writeMode,
    // An unset MCP_PATCH_STATE_DIR used to default to ".mcp-state/patches",
    // which path.resolve interprets against the process working directory. A
    // two-step plan holds the full proposed document text, so that put vault
    // plaintext wherever the process happened to start — and for a stdio server
    // the client picks that directory. The default is now anchored to the home
    // directory, or refuses to resolve at all if there is no usable one. An
    // explicit relative value is still honoured (and still resolved against the
    // cwd): overriding it is a deliberate act, unlike inheriting a default. The
    // `||` short-circuit matters — an explicit setting must keep working on a
    // host with no home directory, so the fallback is only evaluated when the
    // operator named nothing.
    patchStateDir: path.resolve(env.MCP_PATCH_STATE_DIR?.trim() || defaultPatchStateDir(knowledgeRoots[0].path)),
    skillsSubdir,
    auditSubdir,
    scanConcurrency,
    searchRecencyWeight,
    searchRecencyHalfLifeDays
  };
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  const parsed = Number.parseFloat(raw?.trim() || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Roots come from KNOWLEDGE_ROOTS ("name=/abs/path,other=/abs/path", first
 * entry = primary/writable) or, for backward compatibility, from the single
 * KNOWLEDGE_ROOT (equivalent to one primary root named "vault").
 */
function parseKnowledgeRoots(env: NodeJS.ProcessEnv): KnowledgeRoot[] {
  const multi = env.KNOWLEDGE_ROOTS?.trim();
  if (multi) {
    const roots = multi
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separator = entry.indexOf("=");
        const name = separator > 0 ? entry.slice(0, separator).trim() : "";
        const rootPath = separator > 0 ? entry.slice(separator + 1).trim() : "";
        if (!name || !rootPath) {
          throw new Error(`Invalid KNOWLEDGE_ROOTS entry "${entry}". Use "name=/path/to/root", comma-separated.`);
        }
        if (!ROOT_NAME_PATTERN.test(name)) {
          throw new Error(
            `Invalid knowledge root name "${name}". Use lowercase letters/digits/dash/underscore (max 32 chars).`
          );
        }
        return { name, path: path.resolve(rootPath) };
      });
    if (roots.length === 0) {
      throw new Error("KNOWLEDGE_ROOTS is set but contains no roots.");
    }
    const names = new Set<string>();
    for (const root of roots) {
      if (names.has(root.name)) {
        throw new Error(`Duplicate knowledge root name "${root.name}" in KNOWLEDGE_ROOTS.`);
      }
      names.add(root.name);
    }
    return roots;
  }

  const single = env.KNOWLEDGE_ROOT?.trim();
  if (!single) {
    throw new Error("KNOWLEDGE_ROOT (or KNOWLEDGE_ROOTS) is required. Point it at your private Markdown vault clone.");
  }
  return [{ name: "vault", path: path.resolve(single) }];
}

export type TransportKind = "stdio" | "http";

export interface HttpConfig {
  host: string;
  port: number;
  /** Bearer secret every HTTP request must present. Never hardcoded — env only. */
  authToken: string;
  /** Whether write tools are exposed over HTTP. Defaults off (read-only). */
  allowWrite: boolean;
  /** Whether only the constrained Skill-creation tools are exposed over HTTP. */
  allowSkillWrite: boolean;
  /** Whether the constrained audit write surface (append + CAS, scoped to
   *  MCP_AUDIT_SUBDIR) is exposed over HTTP. Independent opt-in; defaults off. */
  allowAuditWrite: boolean;
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
  const allowSkillWrite = isTruthy(env.MCP_HTTP_ALLOW_SKILL_WRITE);
  if (allowSkillWrite && !env.MCP_SKILLS_SUBDIR?.trim()) {
    throw new Error("MCP_HTTP_ALLOW_SKILL_WRITE requires MCP_SKILLS_SUBDIR.");
  }
  const allowAuditWrite = isTruthy(env.MCP_HTTP_ALLOW_AUDIT_WRITE);
  if (allowAuditWrite && !env.MCP_AUDIT_SUBDIR?.trim()) {
    throw new Error("MCP_HTTP_ALLOW_AUDIT_WRITE requires MCP_AUDIT_SUBDIR.");
  }
  const publicUrl = env.MCP_HTTP_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  const oauth = loadOAuthConfig(env, publicUrl, allowWrite || allowSkillWrite || allowAuditWrite);

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
    allowSkillWrite,
    allowAuditWrite,
    allowedHosts,
    allowedOrigins: splitList(env.MCP_HTTP_ALLOWED_ORIGINS),
    chatgptUrlBase: publicUrl,
    oauth
  };
}

function loadOAuthConfig(
  env: NodeJS.ProcessEnv,
  publicUrl: string | undefined,
  allowAnyWrite: boolean
): OAuthConfig | undefined {
  if (!isTruthy(env.MCP_OAUTH_ENABLED)) {
    return undefined;
  }
  // Fail-closed: OAuth needs a public issuer URL and a login password. Without
  // them we must not advertise a half-built authorization server.
  if (!publicUrl) {
    throw new Error("MCP_OAUTH_ENABLED requires MCP_HTTP_PUBLIC_URL (the public https issuer URL).");
  }
  if (!publicUrl.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(publicUrl)) {
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
  // Optional token persistence (opt-in, like every new capability). Resolved
  // to an absolute path so a supervisor's cwd cannot change where state lands.
  const stateFile = env.MCP_OAUTH_STATE_FILE?.trim();
  return {
    issuer: publicUrl,
    loginPassword,
    accessTokenTtlSec: ttl(env.MCP_OAUTH_ACCESS_TTL, 3600),
    refreshTokenTtlSec: ttl(env.MCP_OAUTH_REFRESH_TTL, 2592000),
    codeTtlSec: ttl(env.MCP_OAUTH_CODE_TTL, 60),
    allowWrite: allowAnyWrite,
    stateFile: stateFile ? path.resolve(stateFile) : undefined
  };
}
