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
  /**
   * Whether a **stdio** server registers the audit write tools
   * (`append_audit_report` / `compare_and_swap_audit_state`).
   *
   * Deliberately separate from `auditSubdir`, and off by default. Setting the
   * subdir means "reserve this subtree from general writes" (INV-9) — operators
   * are told to set it on every write-capable process precisely so the
   * reservation holds everywhere. Registering the write tools is a different
   * decision, and conflating the two handed an interactive session, whose input
   * is untrusted vault content (INV-5), the two single-call writes that can
   * forge (`append_audit_report`) or clobber (`compare_and_swap_audit_state`)
   * the audit trail — with no plan/apply step and no user confirmation in
   * between. HTTP always required a second, independent opt-in for this
   * (`MCP_HTTP_ALLOW_AUDIT_WRITE`); stdio did not.
   */
  stdioAllowAuditWrite: boolean;
  /**
   * Whether the constrained Skill write tools (`plan_skill_create` /
   * `apply_planned_skill_create`) are registered on stdio. Off by default.
   *
   * Separate from `skillsSubdir` for the reason `stdioAllowAuditWrite` is
   * separate from `auditSubdir`: reserving the subtree against general document
   * writes (INV-8) and handing this session the tools that write into it are two
   * decisions, and stdio previously collapsed them into one.
   */
  stdioAllowSkillWrite: boolean;
  /**
   * Whether the legacy one-step `create_document` tool is registered. Off by
   * default, on **every** transport.
   *
   * Every other document write in this server is two-step: the client must
   * present an exact target and complete content, and the current user has to
   * approve it before an apply call touches the vault (INV-3). `create_document`
   * predates that flow and is a single call — path containment, the frontmatter
   * allowlist and `flag: "wx"` all still apply, so it cannot escape the vault,
   * overwrite a note, or forge another document's identity (its frontmatter,
   * `id` included, is server-built). What it *can* do is land attacker-chosen
   * body text under `projects/` with no approval step, where it is read back as
   * untrusted vault content (INV-5) by every later session — injection that
   * persists. The mechanism therefore has to match the claim the server
   * instructions make: approval was enforced only by asking the model nicely.
   *
   * One variable for both transports, unlike the audit surface's per-transport
   * pair: the replacement (`plan_document_create` → `apply_planned_document_create`)
   * exists everywhere, so there is no deployment that needs the legacy route on
   * one transport but not the other.
   */
  allowLegacyCreateDocument: boolean;
  /** Max Markdown files opened concurrently during a scan (bounds FD pressure). */
  scanConcurrency?: number;
  /**
   * Ceiling on retained parsed text, in characters, across the parse cache.
   *
   * An override rather than a tuning knob: the default is sized for a vault of
   * roughly 116 MB of source text, and a vault past that re-parses on every
   * query instead of caching. Raising this is what a larger deployment does; the
   * first eviction prints the same advice to stderr.
   */
  documentCacheMaxChars?: number;
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
  /** Ceiling on retained parsed text, in characters; see AppConfig. */
  documentCacheMaxChars?: number;
  /**
   * Operator's label for this root, when there is more than one.
   *
   * Diagnostics only — nothing resolves paths through it. A composite builds one
   * store per root, so a warning that says "this vault does not fit" has to say
   * WHICH one or it is not actionable. Left unset for a single-root deployment,
   * where the operator never named anything and an unqualified line is exact.
   *
   * Safe to print: these names are already client-visible as `name:path`
   * prefixes on every multi-root id, and `loadConfig` already names them in
   * start-up errors. It is a label the operator chose, not a filesystem path.
   */
  rootName?: string;
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
 * passwd entry, it returns HOME verbatim when HOME is relative, and it throws
 * outright when neither HOME nor a passwd entry resolves at all. In the first
 * two cases `path.join` yields a relative string and `path.resolve` re-anchors
 * it to the cwd — reinstating the exact placement this default exists to
 * prevent, in the
 * environments most likely to strip HOME (service accounts, and the `--clearenv`
 * bwrap recipe in `docs/operations.md`). So refuse to guess and make the
 * operator name it, rather than silently writing plaintext somewhere else.
 */
function defaultPatchStateDir(primaryRoot: string): string {
  // os.homedir() does not always return a string. Node runs the libuv call
  // through a checked wrapper that raises ERR_SYSTEM_ERROR when neither HOME nor
  // a passwd entry resolves — the shape a container running as a numeric UID
  // with no /etc/passwd row takes, which is the same class of environment as the
  // empty and relative cases below. Failing closed is right either way, but a
  // raw system error does not tell the operator which setting fixes it, so fold
  // the throw into the one message that names MCP_PATCH_STATE_DIR.
  let home: string;
  try {
    home = os.homedir();
  } catch {
    home = "";
  }
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
  //
  // NFC first, for the reason `src/pathSafety.ts` normalises: macOS hands back
  // NFD for non-ASCII components, so one vault reaches us spelled two ways
  // depending on whether the value was typed, pasted from Finder, or completed
  // by a shell. The tag only has to be stable for a given vault — a spelling
  // that moved it would leave already-staged plans unreachable (`patch_id` not
  // found) with their plaintext orphaned in the old directory. Case and symlinks
  // are deliberately NOT folded: case-folding is wrong on a case-sensitive
  // filesystem, and `realpath` needs the directory to exist, which `loadConfig`
  // cannot assume. This widens what counts as the same path; it can never merge
  // two different ones.
  const tag = crypto.createHash("sha256").update(primaryRoot.normalize("NFC")).digest("hex").slice(0, 16);
  return path.join(home, ".mcp-state", `patches-${tag}`);
}

/** Bound on symlink hops while canonicalizing, so a link cycle fails instead of spinning. */
const MAX_SYMLINK_HOPS = 32;

/**
 * Canonicalize a host path far enough to compare it against a vault root.
 *
 * Server state files are configured before they exist, so `realpath` on the
 * target fails and cannot be used directly. Walk the path component by
 * component instead, following symlinks by hand and letting the components that
 * do not exist yet stay literal.
 *
 * Following links by hand rather than leaning on `realpath` for the existing
 * prefix is the point: `realpath` reports ENOENT for a **dangling** symlink, so
 * a prefix-based version treats `/outside/link -> /vault/not-yet` as an ordinary
 * missing component and calls the target outside the vault. Creating the
 * destination later would then put every save inside the vault, with the boot
 * check having already passed. `lstat` sees the link itself, so the destination
 * stays part of the comparison whether or not it exists.
 *
 * NFC because macOS hands back decomposed names, and a decomposed path would
 * compare unequal to the same name typed into an env file.
 */
function canonicalizeForRootComparison(target: string): string {
  const resolved = path.resolve(target);
  const split = (value: string): string[] => value.split(path.sep).filter((segment) => segment.length > 0);

  let current = path.parse(resolved).root;
  let pending = split(resolved.slice(current.length));
  let hops = 0;

  while (pending.length > 0) {
    const next = path.join(current, pending[0]);
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // Nothing exists from here down, so the rest is literal by construction.
      return path.join(next, ...pending.slice(1)).normalize("NFC");
    }

    const rest = pending.slice(1);
    if (entry.isSymbolicLink()) {
      if (++hops > MAX_SYMLINK_HOPS) {
        throw new Error(`Too many symbolic links while resolving "${target}".`);
      }
      const destination = path.resolve(current, fs.readlinkSync(next));
      current = path.parse(destination).root;
      pending = [...split(destination.slice(current.length)), ...rest];
    } else {
      current = next;
      pending = rest;
    }
  }

  return current.normalize("NFC");
}

/** Filesystem identity of a path, or undefined when it does not exist. */
function identityOf(target: string): { dev: number; ino: number } | undefined {
  try {
    const stats = fs.statSync(target);
    return { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Whether `target` is the root itself or lives underneath it. Both are canonical.
 *
 * Identity, not spelling. `path.relative` compares bytes, but macOS (APFS) and
 * Windows resolve `/Users/me/vault` and `/Users/me/Vault` to the SAME directory,
 * so a case variant of the root would be called "outside" and the state file
 * would land in the indexed vault anyway. macOS is this project's primary
 * deployment, so that is not a hypothetical host. Symlink-walking does not help:
 * `lstat` succeeds on the case-variant name and the literal spelling survives.
 *
 * So walk the target's existing ancestors and compare `(dev, ino)` with the
 * root's. That is spelling-independent by construction, and it also catches a
 * bind mount or any other alias that shares an inode. Components that do not
 * exist yet cannot be stat'd, so the walk simply steps over them — the first
 * ancestor that DOES exist is what decides.
 */
function isInsideRoot(canonicalRoot: string, canonicalTarget: string): boolean {
  const rootIdentity = identityOf(canonicalRoot);
  if (!rootIdentity) {
    // The root does not exist yet, so there is no identity to compare against
    // and the spelling is all there is. NOT `startsWith("..")`: a sibling
    // directory legitimately named `..state` produces the relative path
    // `..state/oauth.json`, which that test reads as an escape — so a state file
    // at <root>/..state would be accepted as outside. `relativeToRoot` in
    // pathSafety.ts uses the same predicate safely because its polarity is the
    // opposite one: there a false "escape" refuses a legitimate read
    // (fail-closed); here it would admit a real leak.
    const relative = path.relative(canonicalRoot, canonicalTarget);
    return (
      relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  }

  for (let current = canonicalTarget; ;) {
    const identity = identityOf(current);
    if (identity && identity.dev === rootIdentity.dev && identity.ino === rootIdentity.ino) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/**
 * Refuse server state that would land inside a knowledge root.
 *
 * A knowledge root is a READ SURFACE: everything under it is walked, indexed,
 * and reachable through search / fetch. Server state is the opposite kind of
 * thing — the OAuth state file holds the registered-client list, the per-file
 * salt and the HMAC tag; a staged patch holds the full proposed text of a
 * document. Neither is a note, and putting either inside the vault publishes it
 * to every client that can read.
 *
 * Checked here, at boot, for the same reason as the subtree-disjointness asserts
 * above: a misconfiguration that only shows up as "these files are searchable"
 * is one nobody notices.
 */
function assertOutsideKnowledgeRoots(
  subject: string,
  remedy: string,
  target: string,
  roots: readonly KnowledgeRoot[]
): void {
  const canonicalTarget = canonicalizeForRootComparison(target);
  for (const root of roots) {
    if (isInsideRoot(canonicalizeForRootComparison(root.path), canonicalTarget)) {
      throw new Error(
        `${subject} resolves inside the knowledge root "${root.name}". Server state must live outside ` +
          `the vault: everything under a root is walked, indexed, and readable through search / fetch. ${remedy}`
      );
    }
  }
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

  // Registering the stdio audit write tools is its own opt-in, mirroring
  // MCP_HTTP_ALLOW_AUDIT_WRITE. Asking for the tools without a subtree for them
  // to write into is a contradiction, so it fails at boot rather than starting a
  // server whose audit surface silently does not exist — the same fail-closed
  // shape loadHttpConfig applies. Checked here rather than in the stdio branch
  // so the contradiction surfaces under either transport.
  const stdioAllowAuditWrite = isTruthy(env.MCP_STDIO_ALLOW_AUDIT_WRITE);
  if (stdioAllowAuditWrite && !auditSubdir) {
    throw new Error("MCP_STDIO_ALLOW_AUDIT_WRITE requires MCP_AUDIT_SUBDIR.");
  }

  // Same split for Skills, and for the same reason. stdio used to read the mere
  // presence of MCP_SKILLS_SUBDIR as permission to register the Skill write
  // tools, so an operator following the documented "set the same subdir on every
  // write-capable process" guidance also armed every interactive local session
  // with them. The reservation (INV-8, assertNotSkillReserved) rides on
  // config.skillsSubdir through createStore and is unaffected by this flag, so
  // withholding the tools does not weaken it.
  //
  // Skill creation is two-step, so this is not the single-call exposure the
  // audit pair had. It is arguably the heavier target regardless: a Skill is
  // loaded by later sessions AS INSTRUCTIONS, which is the premise INV-8 exists
  // for, while an audit report is read back as data.
  const stdioAllowSkillWrite = isTruthy(env.MCP_STDIO_ALLOW_SKILL_WRITE);
  if (stdioAllowSkillWrite && !skillsSubdir) {
    throw new Error("MCP_STDIO_ALLOW_SKILL_WRITE requires MCP_SKILLS_SUBDIR.");
  }

  const allowLegacyCreateDocument = loadAllowLegacyCreateDocument(env);

  // Bounds how many files a vault scan opens at once. Left undefined (the store
  // applies a safe default) unless a positive integer override is provided.
  const parsedScanConcurrency = Number.parseInt(env.MCP_SCAN_CONCURRENCY?.trim() || "", 10);
  const scanConcurrency =
    Number.isInteger(parsedScanConcurrency) && parsedScanConcurrency > 0 ? parsedScanConcurrency : undefined;

  // Same shape as the line above, and the same reason for leaving a bad value
  // undefined: the store's own default is a measured figure, so degrading to it
  // is strictly better than honouring a typo that would make every query
  // re-parse the vault.
  //
  // `Number` rather than `parseInt`, which is the one difference from the
  // sibling above and is the point of the whole change. `parseInt("1.5e9", 10)`
  // is 1 — a mistyped budget would not fail, it would silently become a cache
  // of one character, which is the same class of defect as the mis-sized
  // default this override exists to escape. `Number` reads "1.5e9" as
  // 1,500,000,000, and refuses "1.5" outright rather than guessing which
  // integer was meant. The sibling is left alone deliberately: bounding
  // concurrency at 1 is slow, not silently 7x slower per query.
  const rawDocumentCacheMaxChars = env.MCP_DOCUMENT_CACHE_MAX_CHARS?.trim();
  const parsedDocumentCacheMaxChars = rawDocumentCacheMaxChars ? Number(rawDocumentCacheMaxChars) : Number.NaN;
  const documentCacheMaxChars =
    Number.isInteger(parsedDocumentCacheMaxChars) && parsedDocumentCacheMaxChars > 0
      ? parsedDocumentCacheMaxChars
      : undefined;

  // Recency ranking is opt-in. Left undefined (the search layer applies its own
  // default of 0 = off) unless a usable number is supplied, so a malformed value
  // degrades to "unchanged ranking" rather than to a surprising one.
  const searchRecencyWeight = parsePositiveNumber(env.MCP_SEARCH_RECENCY_WEIGHT);
  const searchRecencyHalfLifeDays = parsePositiveNumber(env.MCP_SEARCH_RECENCY_HALFLIFE_DAYS);

  const rawPatchStateDir = env.MCP_PATCH_STATE_DIR?.trim();
  const patchStateDir = path.resolve(rawPatchStateDir || defaultPatchStateDir(knowledgeRoots[0].path));
  // A staged patch is the full proposed text of a document, so a patch directory
  // inside a root republishes every pending edit as vault content. The DEFAULT is
  // checked too, not only an explicit value: it is derived from the home
  // directory, which is not automatically outside the vault — a root of `$HOME`,
  // or a secondary root containing it, puts the default inside.
  assertOutsideKnowledgeRoots(
    rawPatchStateDir ? `MCP_PATCH_STATE_DIR="${rawPatchStateDir}"` : "The default patch-state directory",
    rawPatchStateDir
      ? "Point it somewhere else."
      : "It derives from the home directory, so set MCP_PATCH_STATE_DIR explicitly to a path outside the vault.",
    patchStateDir,
    knowledgeRoots
  );

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
    patchStateDir,
    skillsSubdir,
    auditSubdir,
    stdioAllowAuditWrite,
    stdioAllowSkillWrite,
    allowLegacyCreateDocument,
    scanConcurrency,
    documentCacheMaxChars,
    searchRecencyWeight,
    searchRecencyHalfLifeDays
  };
}

/**
 * Read the one variable that governs the legacy `create_document` route.
 *
 * Deliberately shared by `loadConfig` (stdio) and `loadHttpConfig` (HTTP) rather
 * than parsed twice: it is a single decision about a single tool, and two
 * independent readers is exactly how a flag drifts into meaning different things
 * per transport.
 */
function loadAllowLegacyCreateDocument(env: NodeJS.ProcessEnv): boolean {
  return isTruthy(env.MCP_ALLOW_LEGACY_CREATE_DOCUMENT);
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
  /** Whether the legacy one-step `create_document` is registered when writes are
   *  allowed. Same variable and same default (off) as stdio — see AppConfig. */
  allowLegacyCreateDocument: boolean;
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

  // DNS-rebinding allowlist. Entries are compared as HOSTNAMES (the port is
  // stripped at the boundary in httpServer.ts), so `host:port` and a bare
  // hostname are equally valid here; the port suffix is kept in the default for
  // continuity with existing operator env files. A bare IPv6 literal is
  // bracketed so the port suffix stays distinguishable from an address group.
  const allowedHosts = splitList(env.MCP_HTTP_ALLOWED_HOSTS);
  if (allowedHosts.length === 0) {
    const bindHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    allowedHosts.push(`${bindHost}:${port}`, `localhost:${port}`);
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
    allowLegacyCreateDocument: loadAllowLegacyCreateDocument(env),
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
  let resolvedStateFile: string | undefined;
  if (stateFile) {
    resolvedStateFile = path.resolve(stateFile);
    // The roots are parsed here rather than threaded in because this is the only
    // place that needs them, and needing them is conditional: an operator who
    // never opts into persistence should not have to satisfy this requirement.
    // Failing when the roots cannot be read is the fail-closed half — without
    // them there is no way to know whether the state file is inside the vault.
    assertOutsideKnowledgeRoots(
      `MCP_OAUTH_STATE_FILE="${stateFile}"`,
      "Point it somewhere else.",
      resolvedStateFile,
      parseKnowledgeRoots(env)
    );
  }
  return {
    issuer: publicUrl,
    loginPassword,
    accessTokenTtlSec: ttl(env.MCP_OAUTH_ACCESS_TTL, 3600),
    refreshTokenTtlSec: ttl(env.MCP_OAUTH_REFRESH_TTL, 2592000),
    codeTtlSec: ttl(env.MCP_OAUTH_CODE_TTL, 60),
    allowWrite: allowAnyWrite,
    stateFile: resolvedStateFile
  };
}
