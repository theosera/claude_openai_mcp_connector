#!/usr/bin/env node
/**
 * `pnpm run init:env` — ask a few questions and write the server's env file.
 *
 * The server reads an env file only from the absolute path in `MCP_ENV_FILE`,
 * set in its real environment (0.8.0 removed the working-directory `.env`,
 * because a client-spawned stdio server's working directory is chosen by
 * whoever opened the project). This command writes that file and prints the one
 * line that wires it up. It is an offline operator command, like
 * `oauth:registrations`, and deliberately not an MCP tool or an HTTP route: a
 * tool that writes server configuration does not belong on a surface that an
 * LLM reading untrusted vault content can call.
 *
 * What it guarantees, each pinned by `tests/initEnv.test.ts`:
 *
 * - **Never overwrites.** The file is published with one `link()` from a
 *   temporary file in the same directory, so an existing entry at the target
 *   (file, symlink or dangling symlink) fails with EEXIST. Any other link
 *   failure stops too; there is no fallback to `rename()` or a plain write.
 * - **Never inside the vault.** The target is checked with the same
 *   `assertOutsideKnowledgeRoots` the server applies to `MCP_ENV_FILE` — but
 *   BEFORE the write. The server's check runs after it has read the file, so it
 *   can refuse to keep serving but cannot undo the exposure; this one can.
 * - **Owner-only from the first byte.** The temporary file is opened `wx` with
 *   mode 0600 and set to exactly 0600 through its descriptor before anything is
 *   written (the open mode is cut by the umask, never widened). A directory this
 *   command creates is set to exactly 0700 the same way.
 * - **The path that was checked is the path that is written.** The target is
 *   resolved once, before the first question, to a canonical path (symlinks in
 *   its existing part followed); every later step — the vault check, the
 *   directory checks, the write, the read-back and the printed `MCP_ENV_FILE` —
 *   uses that path. Repointing a link on the original path afterwards does not
 *   move the write. The vault check runs again right before the write.
 * - **A directory it trusts, and ancestors nobody else controls.** The directory
 *   that will hold the file — or, when it has to be created, its nearest existing
 *   ancestor — must be a real directory (not a link), owned by this account, and
 *   not writable by group or others: whoever can write there can swap the file
 *   before the server reads it. Every directory above it must be owned by root or
 *   this account and not writable by group or others unless it is sticky (the
 *   owner condition holds for sticky directories too: their owner can rename
 *   anything in them). An existing directory is never re-permissioned; init stops
 *   instead. After publishing, the file at the path must still be the one just
 *   written; if it is not, init stops and says not to use its token.
 * - **No secret on screen, in argv or from the environment.** The bearer token
 *   is generated here and never printed. No option takes a secret, and nothing
 *   but `XDG_CONFIG_HOME` and `HOME` is read from this process's environment.
 * - **Reads back the way the server reads.** After writing, the file goes
 *   through `loadEnvFile` → `loadConfig` → (`loadHttpConfig`) with a fresh
 *   environment holding only `MCP_ENV_FILE`. Those functions put paths, ports
 *   and variable NAMES into their errors, never a token or password value, so
 *   their messages are shown as they are.
 *
 * Atomic is not durable: nothing here calls fsync (the same as atomicWrite.ts).
 */
import crypto from "node:crypto";
import type { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { assertOutsideKnowledgeRoots, loadConfig, loadEnvFile, loadHttpConfig, selectedTransport } from "./config.js";

/** What `main` talks to. Injected so the tests can drive it without a terminal. */
export interface InitIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
  /** Whether input and output are a terminal (readline then edits the line). */
  isTTY: boolean;
  /** Only `XDG_CONFIG_HOME` and `HOME` are read from it, to place the default file. */
  env: Readonly<Record<string, string | undefined>>;
  /** Where SIGINT / SIGTERM / SIGHUP arrive: `process` in the real entrypoint. */
  signals?: EventEmitter;
}

const APP_DIR = "claude-openai-mcp-connector";
const FILE_NAME = "server.env";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DEFAULT_PORT = "8787";
const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

const USAGE = `Usage: pnpm run init:env [--out <absolute path>]

Asks a few questions and writes a server env file (mode 0600) for the server to
read through MCP_ENV_FILE. It never overwrites an existing file, never writes
inside the vault, and never prints the bearer token it generates.

Default location: $XDG_CONFIG_HOME/${APP_DIR}/${FILE_NAME}
  (or ~/.config/${APP_DIR}/${FILE_NAME})

Options:
  --out <path>  write to this absolute path instead (one file per endpoint)
  -h, --help    show this help
`;

/** A refusal with a message for the operator. The message never carries a secret. */
class Stop extends Error {
  constructor(
    message: string,
    readonly exitCode = 1
  ) {
    super(message);
  }
}

/** A signal, or Ctrl-C at the prompt, ended the run before anything was written. */
class Interrupted extends Error {
  constructor(readonly signal: string) {
    super(signal);
  }
}

function parseArgs(args: string[]): { out?: string; help: boolean } {
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      // pnpm 10 passes the separator of `pnpm run init:env -- --out …` through
      // to the script, so both spellings reach the same options.
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return { help: true };
    }
    if (arg === "--out") {
      const value = args[++i];
      if (value === undefined) {
        throw new Stop("--out needs a path.", 2);
      }
      if (out !== undefined) {
        throw new Stop("--out was given twice.", 2);
      }
      out = value;
      continue;
    }
    // Unknown arguments stop instead of being ignored, and no option takes a
    // secret: argv is visible in `ps`, the shell history and a session
    // transcript. A positional argument is not echoed, in case it is one.
    throw new Stop(arg.startsWith("-") ? `unknown option "${arg}".` : "unexpected argument (not shown).", 2);
  }
  return { out, help: false };
}

/**
 * Values are written double-quoted, so a value may not carry what would end or
 * escape the quotes, or a line break. Leading or trailing whitespace is refused
 * because the server trims `KNOWLEDGE_ROOT` (and the OAuth password) before use,
 * so what it used would not be what was typed. The value itself is never put
 * into the message.
 */
export function assertEnvSafeValue(name: string, value: string): void {
  if (value.length === 0) {
    throw new Stop(`${name} is empty.`);
  }
  if (value.trim() !== value) {
    throw new Stop(`${name} must not start or end with whitespace (the server trims it).`);
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (isControlCode(code) || char === '"' || char === "\\") {
      throw new Stop(
        `${name} contains a character the env file cannot carry safely (a control character, a double quote or a backslash).`
      );
    }
  }
}

/** The control characters no value or path here may carry: C0 (below 0x20) and DEL. */
function isControlCode(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    if (isControlCode(char.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

/** One POSIX shell word: single quotes, with each `'` closed, escaped and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * One systemd unit-file word: double quotes, with `\` and `"` escaped and `%`
 * doubled (unit files expand `%` specifiers). Without the quotes systemd splits
 * an `Environment=` line at whitespace.
 */
export function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

/** The file's bytes. Comments only, then one `KEY="value"` line per value. */
export function renderEnvFile(values: ReadonlyArray<readonly [string, string]>): string {
  const lines = [
    "# Written by `pnpm run init:env`. The server reads this file only when MCP_ENV_FILE names it",
    "# (an absolute path, set in the real environment of the client or supervisor that starts the server).",
    "# Keep it outside the vault. A variable already in the server's real environment wins over this file.",
    ...values.map(([key, value]) => `${key}="${value}"`)
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Refuse to write bytes that would not read back as exactly the intended
 * values through the parser the server uses. `assertEnvSafeValue` should make
 * this unreachable; it is kept as its own check so that a later change to the
 * quoting, or a parser upgrade, fails here instead of in the server.
 */
export function assertRoundTrip(content: string, values: ReadonlyArray<readonly [string, string]>): void {
  const parsed = dotenv.parse(content);
  const keys = Object.keys(parsed);
  const same =
    keys.length === values.length &&
    values.every(([key, value]) => Object.prototype.hasOwnProperty.call(parsed, key) && parsed[key] === value);
  if (!same) {
    throw new Stop("the env file would not read back as written. Nothing was written.");
  }
}

/** `$XDG_CONFIG_HOME/claude-openai-mcp-connector/server.env`, else under `~/.config`. */
export function defaultOutputPath(env: InitIO["env"]): string {
  const xdg = env.XDG_CONFIG_HOME;
  const home = env.HOME;
  // The XDG base directory spec says a relative XDG_CONFIG_HOME is invalid and is ignored.
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : home && path.isAbsolute(home) ? path.join(home, ".config") : undefined;
  if (!base) {
    throw new Stop("there is no absolute XDG_CONFIG_HOME or HOME to place the file under. Pass --out <absolute path>.");
  }
  return path.join(base, APP_DIR, FILE_NAME);
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "error";
}

/**
 * Resolve the target once: the nearest existing ancestor of its directory goes
 * through `realpath`, and the names that do not exist yet are appended. Every
 * later step uses this path, so a link on the original path that is repointed
 * after the checks cannot move the write (PR#308 review). Called before the
 * first question, so the user's answers do not widen the window either.
 */
export function canonicalTarget(target: string): string {
  const missing: string[] = [];
  let existing = path.dirname(target);
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new Stop(`${existing} could not be checked (${errorCode(error)}). Nothing was written.`);
      }
      missing.unshift(path.basename(existing));
      const up = path.dirname(existing);
      if (up === existing) {
        throw new Stop(`no part of ${target} exists. Nothing was written.`);
      }
      existing = up;
    }
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(existing);
  } catch (error) {
    throw new Stop(`${existing} could not be resolved (${errorCode(error)}). Nothing was written.`);
  }
  return path.join(resolved, ...missing, path.basename(target));
}

/**
 * Every directory above `dir` (canonical, existing) must be owned by root or
 * this account, and not writable by group or others unless it is sticky.
 * Anyone else who could write to one of them could rename a directory below it
 * between the checks and the write. The sticky bit only stops others from
 * renaming entries they do not own; the directory's owner can still rename any
 * of them, so the owner condition applies to sticky directories as well.
 * `dir` itself is held to the stricter rule of `assertTrustedDirectory`.
 */
function assertSecureAncestors(dir: string): void {
  const uid = process.geteuid?.();
  for (let current = path.dirname(dir); ; current = path.dirname(current)) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      throw new Stop(`${current} could not be checked (${errorCode(error)}). Nothing was written.`);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Stop(`${current} is no longer a directory (it changed while init:env ran). Nothing was written.`);
    }
    if (uid !== undefined && stats.uid !== 0 && stats.uid !== uid) {
      throw new Stop(
        `${current} belongs to uid ${stats.uid}, neither root nor this account, so it could replace the directories below it. ` +
          "Choose another --out. Nothing was written."
      );
    }
    if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) {
      throw new Stop(
        `${current} is writable by group or others without the sticky bit (mode ${(stats.mode & 0o7777).toString(8)}), ` +
          "so they could replace the directories below it. Choose another --out. Nothing was written."
      );
    }
    if (path.dirname(current) === current) {
      return;
    }
  }
}

/**
 * A directory that will hold the file must be a real directory (not a link),
 * owned by this account, and not writable by group or others. Read through one
 * descriptor opened with O_NOFOLLOW, so the answer is about this directory and
 * not about whatever a swapped path points at. Exported for the tests: with the
 * path resolved first, a link here only appears through a race.
 */
export function assertTrustedDirectory(dir: string, what: string): void {
  let fd: number;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new Stop(`${what} ${dir} is a symbolic link or not a directory. Nothing was written.`);
    }
    throw new Stop(`${what} ${dir} could not be opened (${code}). Nothing was written.`);
  }
  try {
    const stats = fs.fstatSync(fd);
    const uid = process.geteuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      throw new Stop(`${what} ${dir} belongs to uid ${stats.uid}, not to this account. Nothing was written.`);
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new Stop(
        `${what} ${dir} is writable by group or others (mode ${(stats.mode & 0o777).toString(8)}). ` +
          "Run chmod go-w on it, or choose another --out. Nothing was written."
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Make the file's directory ready: check the directory if it exists, otherwise
 * check its nearest existing ancestor and create what is missing at 0700.
 * Returns the directories it created, shallowest first, so a failure later on
 * can remove them again.
 */
function prepareDirectory(dir: string): string[] {
  const missing: string[] = [];
  let existing = dir;
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new Stop(`${existing} could not be checked (${errorCode(error)}). Nothing was written.`);
      }
      missing.unshift(existing);
      const up = path.dirname(existing);
      if (up === existing) {
        throw new Stop(`no part of ${dir} exists. Nothing was written.`);
      }
      existing = up;
    }
  }
  assertTrustedDirectory(existing, missing.length === 0 ? "The directory" : "The nearest existing directory");
  assertSecureAncestors(existing);

  const created: string[] = [];
  try {
    for (const next of missing) {
      try {
        fs.mkdirSync(next, { mode: DIR_MODE });
      } catch (error) {
        throw new Stop(`could not create ${next} (${errorCode(error)}). Nothing was written.`);
      }
      created.push(next);
      // `mkdir` cuts the mode with the umask; set it exactly, through a descriptor that refuses a link.
      const fd = fs.openSync(next, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        fs.fchmodSync(fd, DIR_MODE);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (error) {
    removeCreated(created);
    throw error;
  }
  return created;
}

function removeCreated(created: readonly string[]): void {
  for (const dir of [...created].reverse()) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty or already gone: leave it rather than remove anything else.
    }
  }
}

/**
 * Publish `content` at `target` without ever replacing what is there.
 *
 * Exported for the tests, which drive the link step directly: the command also
 * stops early when the target exists, so only a direct call reaches EEXIST here.
 */
export function writeEnvFileExclusive(target: string, content: string): void {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", FILE_MODE);
    // The open mode can only be narrowed by the umask (0277 would leave 0400);
    // set exactly 0600 through the descriptor before any byte goes in.
    fs.fchmodSync(fd, FILE_MODE);
    fs.writeFileSync(fd, content);
    const written = fs.fstatSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temp, target);
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") {
        throw new Stop(`${target} already exists, and init never overwrites a file. Nothing was written.`);
      }
      // Every other failure stops as well. Falling back to rename() or a plain
      // write here would be the overwrite path this function exists not to have.
      throw new Stop(
        `could not publish ${target} (${code}); this filesystem may not support hard links. Nothing was written.`
      );
    }
    // The path must still lead to the file just written. If a directory on it
    // changed between the checks and the link, the file is somewhere else; it is
    // not removed (removing by path could hit another file), but its token is
    // treated as exposed.
    let published: fs.Stats | undefined;
    try {
      published = fs.lstatSync(target);
    } catch {
      published = undefined;
    }
    if (!published || published.dev !== written.dev || published.ino !== written.ino) {
      throw new Stop(
        `${target} is not the file init:env just wrote: a directory on the path changed during the write, so the file ` +
          "may be somewhere else. Do not use the token in it; run init:env again to make a new one."
      );
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // Never created, or already gone.
    }
  }
}

/** Read the file back the way the server will, and return its transport. */
function readBack(target: string): string {
  // A fresh object rather than process.env: a KNOWLEDGE_ROOT already set in
  // this shell would win over the file and hide a mistake in it.
  const env: NodeJS.ProcessEnv = { MCP_ENV_FILE: target };
  loadEnvFile(env);
  loadConfig(env);
  const transport = selectedTransport(env);
  if (transport === "http") {
    loadHttpConfig(env);
  }
  return transport;
}

function guidance(target: string, transport: string): string {
  // Each line is quoted for the syntax it will be pasted into: JSON for the
  // client's settings, a POSIX shell word for commands, a unit-file word for
  // systemd. A path with spaces, `%`, `$` or quotes has to survive all three.
  const json = JSON.stringify(target);
  const shell = shellQuote(target);
  const common = [
    "",
    `For another endpoint, run this again with --out <another absolute path>: each endpoint gets its own file.`
  ];
  if (transport === "http") {
    return [
      "",
      "Next steps (HTTP):",
      `1. Give the server MCP_ENV_FILE=${shell} in its real environment.`,
      "   launchd: add it to the plist's EnvironmentVariables, then reload the job:",
      "     launchctl bootout gui/$(id -u)/<label>",
      "     launchctl bootstrap gui/$(id -u) <plist>",
      "   (launchctl kickstart -k restarts without re-reading the plist, so the variable would not reach the job.)",
      "   Confirm that launchctl print gui/$(id -u)/<label> shows MCP_ENV_FILE, then run: pnpm run check:http",
      `   systemd: Environment=${systemdQuote(`MCP_ENV_FILE=${target}`)}`,
      "2. MCP_AUTH_TOKEN is in the file and was not shown. To read it, open the file in an editor;",
      "   do not print it inside an AI coding session, whose transcript keeps it.",
      "3. The endpoint is read-only. To allow writes, add MCP_HTTP_ALLOW_WRITE=1 by hand, together with the same",
      "   MCP_AUDIT_SUBDIR / MCP_SKILLS_SUBDIR as the other server processes that write to this vault.",
      ...common,
      ""
    ].join("\n");
  }
  return [
    "",
    "Next steps (stdio):",
    `1. In your MCP client's entry for this server, add to its "env" block:  "MCP_ENV_FILE": ${json}`,
    `   Values already in that "env" block win over the file. If it still sets KNOWLEDGE_ROOT (or any other`,
    "   variable written here), remove it there, or the file's value is not used.",
    "2. This server can write to the vault: two-step edits (plan, then apply only after you approve the diff)",
    "   are always on over stdio. If another server process writes to the same vault with MCP_AUDIT_SUBDIR or",
    "   MCP_SKILLS_SUBDIR set, add the same values to this file; otherwise this server does not keep those",
    "   subtrees reserved. The server's start-up line on stderr shows it: skills=off or audit=off there means",
    "   no reservation in that process.",
    "3. To check the tool surface the file declares (after pnpm build, in the repository checkout):",
    // No `--` before --env: pnpm 10 passes it through, and check-stdio.mjs
    // refuses an argument it does not know.
    `     pnpm run check:stdio --env ${shell}`,
    "   That check loads the file directly, not through MCP_ENV_FILE, so also start the server once from your client.",
    ...common,
    ""
  ].join("\n");
}

async function run(args: string[], io: InitIO): Promise<number> {
  const options = parseArgs(args);
  if (options.help) {
    io.output.write(USAGE);
    return 0;
  }
  if (process.platform === "win32") {
    // The file's protection is its POSIX mode and its directory's; neither means
    // anything here, so a secret-bearing file is not written at all.
    throw new Stop("Windows is not supported: the file's owner-only permissions cannot be enforced there.");
  }
  if (options.out !== undefined && !path.isAbsolute(options.out)) {
    throw new Stop("--out must be an absolute path; a relative one would depend on the working directory.", 2);
  }
  const requested = options.out ?? defaultOutputPath(io.env);
  if (hasControlCharacter(requested)) {
    // No client setting, shell line or unit file can carry it on one line.
    throw new Stop("the env file's path contains a control character. Choose another --out.", 2);
  }
  // Early and for convenience only — the real guard is the link() in
  // writeEnvFileExclusive, which refuses whatever appears in the meantime.
  if (lstatOrUndefined(requested)) {
    throw new Stop(`${requested} already exists, and init never overwrites a file. Nothing was written.`);
  }
  // From here on, only the resolved path is used (see canonicalTarget).
  const target = canonicalTarget(requested);
  if (target !== requested && lstatOrUndefined(target)) {
    throw new Stop(`${target} already exists, and init never overwrites a file. Nothing was written.`);
  }

  const rl = readline.createInterface({ input: io.input, output: io.output, terminal: io.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  let interrupt: ((signal: string) => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = (signal) => reject(new Interrupted(signal));
  });
  interrupted.catch(() => undefined);
  const onSignal = (signal: string) => interrupt?.(signal);
  const signalNames = Object.keys(SIGNAL_EXIT);
  const listeners = signalNames.map((name) => [name, () => onSignal(name)] as const);
  for (const [name, listener] of listeners) {
    io.signals?.on(name, listener);
  }
  // In a terminal, readline reads in raw mode, where Ctrl-C arrives as input
  // and is reported here instead of as a signal.
  rl.on("SIGINT", () => onSignal("SIGINT"));

  // Piped input can be read to its end, closing the interface, while lines are
  // still waiting in the iterator; prompting a closed interface throws.
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const ask = async (prompt: string): Promise<string> => {
    if (closed) {
      io.output.write(prompt);
    } else {
      rl.setPrompt(prompt);
      rl.prompt();
    }
    const next = await Promise.race([lines.next(), interrupted]);
    if (next.done) {
      throw new Stop("input ended before every question was answered. Nothing was written.");
    }
    return next.value;
  };

  try {
    io.output.write(`This writes a server env file at ${target}\n(mode 0600; it never overwrites a file).\n`);
    if (target !== requested) {
      io.output.write(`(${requested} resolves to that path; it is the one checked, written and named below.)\n`);
    }
    io.output.write("\n");

    let root = "";
    for (;;) {
      const answer = await ask("Vault location (absolute path to your Markdown vault): ");
      try {
        assertEnvSafeValue("KNOWLEDGE_ROOT", answer);
        if (!path.isAbsolute(answer)) {
          throw new Stop("KNOWLEDGE_ROOT must be an absolute path (~ is not expanded).");
        }
        let isDirectory = false;
        try {
          isDirectory = fs.statSync(answer, { throwIfNoEntry: false })?.isDirectory() ?? false;
        } catch (error) {
          throw new Stop(`KNOWLEDGE_ROOT could not be checked (${errorCode(error)}).`);
        }
        if (!isDirectory) {
          throw new Stop("KNOWLEDGE_ROOT must be an existing directory.");
        }
      } catch (error) {
        if (!(error instanceof Stop)) {
          throw error;
        }
        io.error.write(`init:env: ${error.message}\n`);
        continue;
      }
      root = answer;
      break;
    }
    // Before anything else is asked or written: a file inside the vault would be
    // indexed and readable through search / fetch. The server makes the same
    // check on MCP_ENV_FILE, but only after reading the file.
    assertOutsideVault(target, root);

    io.output.write(
      "\nstdio = a local client starts the server (Claude Code, Codex, Claude Desktop).\n" +
        "        A stdio server can write to the vault (two-step: plan, then apply after your approval).\n" +
        "http  = a long-running endpoint for web connectors, read-only by default, behind a bearer token.\n"
    );
    let transport = "";
    while (transport === "") {
      const answer = (await ask("Transport [stdio/http] (stdio): ")).trim().toLowerCase();
      if (answer === "" || answer === "stdio") transport = "stdio";
      else if (answer === "http") transport = "http";
      else io.error.write('init:env: answer "stdio" or "http".\n');
    }

    const values: Array<readonly [string, string]> = [["KNOWLEDGE_ROOT", root]];
    if (transport === "http") {
      let port = "";
      while (port === "") {
        const answer = (await ask(`HTTP port (${DEFAULT_PORT}): `)).trim() || DEFAULT_PORT;
        const n = Number(answer);
        if (/^[0-9]+$/.test(answer) && Number.isInteger(n) && n >= 1 && n <= 65535) port = String(n);
        else io.error.write("init:env: the port must be a number from 1 to 65535.\n");
      }
      // Generated here, never asked for and never shown.
      const token = crypto.randomBytes(32).toString("base64url");
      values.push(["MCP_TRANSPORT", "http"], ["MCP_HTTP_PORT", port], ["MCP_AUTH_TOKEN", token]);
    }

    for (const [key, value] of values) {
      assertEnvSafeValue(key, value);
    }
    const content = renderEnvFile(values);
    assertRoundTrip(content, values);

    io.output.write(`\nThe file will hold:\n`);
    for (const [key, value] of values) {
      io.output.write(`  ${key}=${key === "MCP_AUTH_TOKEN" ? "(generated; not shown)" : value}\n`);
    }
    const confirm = (await ask(`Write ${target}? [y/N]: `)).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
      io.output.write("Nothing was written.\n");
      return 1;
    }

    // From here to the end of the write nothing awaits, so a signal is handled
    // only once the file is either published or not, and the temporary file is gone.
    // The vault check again, now: the answers took time, and the vault side (a
    // vault given as a link, say) may have changed since the first check.
    assertOutsideVault(target, root);
    const created = prepareDirectory(path.dirname(target));
    try {
      writeEnvFileExclusive(target, content);
    } catch (error) {
      removeCreated(created);
      throw error;
    }
    io.output.write(`\nWrote ${target} (mode 0600).\n`);

    try {
      readBack(target);
    } catch (error) {
      io.error.write(
        `init:env: the server would not start with this file: ${(error as Error).message}\n` +
          `The file was kept at ${target}; fix it or remove it and run init:env again.\n`
      );
      return 1;
    }
    io.output.write(guidance(target, transport));
    return 0;
  } finally {
    for (const [name, listener] of listeners) {
      io.signals?.off(name, listener);
    }
    rl.close();
  }
}

function lstatOrUndefined(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Stop(`${target} could not be checked (${errorCode(error)}). Nothing was written.`);
  }
}

/** The server's own containment check on `MCP_ENV_FILE`, applied before the write. */
function assertOutsideVault(target: string, root: string): void {
  try {
    assertOutsideKnowledgeRoots(
      `The env file ${target}`,
      "Choose a location outside the vault with --out <absolute path>. Nothing was written.",
      target,
      [{ name: "vault", path: path.resolve(root) }]
    );
  } catch (error) {
    // Its message names the path and the root only.
    throw new Stop((error as Error).message);
  }
}

/** Run the command and return its exit status. */
export async function main(args: string[], io: InitIO): Promise<number> {
  try {
    return await run(args, io);
  } catch (error) {
    if (error instanceof Interrupted) {
      io.error.write(`\ninit:env: interrupted (${error.signal}). Nothing was written.\n`);
      return SIGNAL_EXIT[error.signal] ?? 1;
    }
    if (error instanceof Stop) {
      io.error.write(`init:env: ${error.message}\n`);
      if (error.exitCode === 2) io.error.write(USAGE);
      return error.exitCode;
    }
    // The configuration functions' own messages carry paths and names only, but
    // an unexpected failure might quote anything, so only its class is shown.
    io.error.write(`init:env: unexpected ${(error as Error)?.name ?? "error"}. Nothing was written.\n`);
    return 1;
  }
}

// Run only as the entrypoint, so the tests can import `main` without starting it.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    env: process.env,
    signals: process
  });
}
