#!/usr/bin/env node
// Operator command for OAuth client registrations (#184): list them, and
// remove named ones together with everything bound to them.
//
// It reads and writes the state file the HTTP server uses, through the same
// OAuthStore, so the file keeps its HMAC and nobody edits it by hand. It is
// meant to run with the server STOPPED. A running server holds the
// registrations in memory and writes them back on its next save, so a
// registration removed underneath it silently comes back. Before writing, this
// checks that nothing answers on the configured port and that the file is still
// the one it read (same bytes, same file, still this account's) — but a server
// on another port, or one started a moment later, is invisible to that check,
// and a save that lands after the last check is still lost: the check is not a
// compare-and-swap. Stopping the server first is the actual precaution; the
// check is a backstop.
//
// It is deliberately not an MCP tool (a model reading untrusted vault content
// could be talked into calling it, and the HTTP tool surface follows the
// presented token, so a connector would hold it too) and not an HTTP route (the
// tunnel forwards public traffic to the loopback listener, so a loopback-only
// route is still a public one).
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { loadEnvFile, loadHttpConfig } from "./config.js";
import {
  OAuthStore,
  readStateFile,
  REGISTRATION_CONSENT_DEADLINE_MS,
  type RegistrationListing
} from "./oauth/store.js";

const USAGE = `Usage:
  oauth:registrations list
      Show every registration in the OAuth state file.
  oauth:registrations remove <client_id>... [--apply]
      Show what removing these registrations would take with them (their
      tokens and rotation records). Nothing is written unless --apply is given,
      and --apply refuses while the server answers on its port.

Stop the server before --apply: a running server writes the registrations it
holds in memory back on its next save, and a removed one comes back.
Configuration is read the way the server reads it (MCP_ENV_FILE, then the
environment).
`;

/**
 * Every character a terminal acts on or hides instead of showing: controls
 * (Cc: C0, DEL, C1), format characters (Cf: the bidirectional controls, U+061C,
 * zero-width characters, U+FEFF, TAG characters) and the line and paragraph
 * separators (Zl, Zp). Named by Unicode category rather than listed by hand —
 * a hand-made list missed U+061C and the C1 range was left untested.
 */
const UNPRINTABLE = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u;

/**
 * Make a string safe to print on a terminal. `client_name` and `redirect_uris`
 * are whatever an anonymous caller of `/register` chose, so every unprintable
 * character is shown as an escape instead of acting, and `\` itself is escaped
 * so that a literal `\x1b` in the input cannot pass for an escaped ESC.
 */
export function printable(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") {
      out += "\\\\";
    } else if (!UNPRINTABLE.test(char)) {
      out += char;
    } else if (code <= 0xff) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (code <= 0xffff) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += `\\u{${code.toString(16)}}`;
    }
  }
  return out;
}

/** One field an anonymous caller chose, quoted so it cannot pose as other fields. */
function quoted(value: string): string {
  return `"${printable(value).replaceAll('"', '\\"')}"`;
}

function describe(listing: RegistrationListing): string {
  return [
    listing.clientId,
    // given: the owner consented; pending: waiting for a first consent, and
    // reclaimed at `expires`; unknown: carried over from an older state file.
    `state=${listing.consent}`,
    ...(listing.consent === "pending"
      ? [`expires=${new Date(listing.createdAt + REGISTRATION_CONSENT_DEADLINE_MS).toISOString()}`]
      : []),
    `created=${new Date(listing.createdAt).toISOString()}`,
    `tokens=access:${listing.liveAccessTokens},refresh:${listing.liveRefreshTokens}`,
    // The name and each redirect URI are quoted one by one: unquoted, a redirect
    // could carry "  state=given  tokens=…" and pass for this line's own
    // fields. Not JSON.stringify: it would double the backslashes `printable`
    // adds, and it leaves C1 and the format characters alone.
    `name=${listing.clientName === undefined ? "-" : quoted(listing.clientName)}`,
    `redirect=${listing.redirectUris.map(quoted).join(",")}`
  ].join("  ");
}

/**
 * Whether something accepts a connection on the server's port. A refusal means
 * no; a connection means yes; anything else (a timeout, an unexpected error)
 * is treated as yes, because the safe answer to "is it running?" when unsure is
 * the one that stops a write.
 */
function somethingListens(host: string, port: number): Promise<boolean> {
  const target = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const socket = net.connect({ host: target, port });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code !== "ECONNREFUSED"));
  });
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fail(message: string, code = 1): number {
  process.stderr.write(`oauth:registrations: ${message}\n`);
  return code;
}

const LINKED =
  "MCP_OAUTH_STATE_FILE is a symbolic link, and the server refuses to start on one: a save would replace " +
  "the link with a regular file. Set it to the path of the file itself. Nothing was read and nothing was written.";

/**
 * Run the command. The hooks exist for tests only. `afterRead` runs after the
 * first read and before the store is built from it, so a test can change the
 * file in that window and see that the store holds what was read.
 * `beforeWrite` runs after every check and before the state file is re-read
 * and written, so a test can change the file there and see the write refused.
 */
export async function main(
  args: string[],
  hooks: { afterRead?: () => void; beforeWrite?: () => void } = {}
): Promise<number> {
  const command = args[0];
  if (command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command !== "list" && command !== "remove") {
    process.stderr.write(USAGE);
    return 2;
  }

  let config: ReturnType<typeof loadHttpConfig>;
  try {
    loadEnvFile();
    config = loadHttpConfig();
  } catch (error) {
    // Configuration errors name variables and paths, never their secret values.
    return fail((error as Error).message);
  }
  const oauth = config.oauth;
  if (!oauth) {
    return fail("OAuth is not enabled (MCP_OAUTH_ENABLED), so there are no registrations to manage.");
  }
  if (!oauth.stateFile) {
    return fail(
      "MCP_OAUTH_STATE_FILE is not set: registrations live only in the running server's memory and end with it."
    );
  }

  // One read, the way the server's store reads (O_NOFOLLOW): its bytes are what
  // the sha below is taken over, what the store is built from, and what the
  // last read before a write is compared with. Read again for the store, the
  // file could change in place and back between the reads (#273).
  const first = readStateFile(oauth.stateFile);
  if (first.kind === "absent") {
    if (command === "list") {
      process.stdout.write("No state file yet at the configured path, so there are no registrations.\n");
      return 0;
    }
    return fail("there is no state file at the configured path, so there is nothing to remove.");
  }
  if (first.kind === "failed") {
    // Only a missing file means "no registrations yet". Anything else (most
    // often EACCES: run as another account than the server) is a file this
    // command cannot read, and calling it absent would send an operator to
    // re-run it as someone who can — and that run would write the file back
    // owned by them, where the server may no longer read it.
    // A link, with its target or without, is what the server refuses too
    // (#263). Without this, a link with no target read as "no state file
    // yet" and the command exited 0 while the server would not start.
    return fail(
      first.failure.kind === "symlink"
        ? LINKED
        : `the state file cannot be read (${first.failure.code}). Run this as the account the server runs as. Nothing was read and nothing was written.`
    );
  }
  hooks.afterRead?.();
  const raw = first.bytes;
  const readSha = sha256(raw);

  const store = new OAuthStore({
    accessTokenTtlSec: oauth.accessTokenTtlSec,
    refreshTokenTtlSec: oauth.refreshTokenTtlSec,
    codeTtlSec: oauth.codeTtlSec,
    persistPath: oauth.stateFile,
    persistSecret: oauth.loginPassword,
    stateFileRead: first,
    // Loading may promote a pending registration that holds a live token, and
    // the server writes that at once. Here it must not: `list` and the dry run
    // write nothing, and the sha check below compares against the file as read.
    writeAtLoad: false
  });
  if (store.loadOutcome !== "loaded") {
    // Never go on to write: the store holds nothing from the file, and saving
    // would replace every registration and token in it. A read that failed
    // was refused above, so this is a file that did not verify; the message
    // still follows the store's reason.
    const kind = store.loadFailureKind;
    return fail(
      kind === "symlink"
        ? LINKED
        : kind === "unreadable"
          ? "the state file cannot be read. Run this as the account the server runs as. Nothing was read and nothing was written."
          : "the state file did not verify (it was changed, is damaged, or MCP_OAUTH_PASSWORD differs from the one that wrote it). Nothing was read and nothing was written."
    );
  }
  const listings = store.listRegistrations();
  // Loading applies what the server applies at start, so it can drop entries
  // the file still holds. Say so, because --apply writes that out as well.
  // `raw` is the bytes the store verified, so this parse succeeds; it stays
  // inside a try because the count is a courtesy and must never stop the
  // command.
  let inFile = listings.length;
  try {
    inFile = (JSON.parse(JSON.parse(raw.toString("utf8")).payload as string).clients ?? []).length as number;
  } catch {
    // Keep the listing's own count.
  }
  const droppedAtLoad = Math.max(0, inFile - listings.length);
  const dropNote = `${droppedAtLoad} registration(s) in the file are dropped on loading, as the server drops them at its next start; --apply writes that too.\n`;

  if (command === "list") {
    process.stdout.write(
      `Snapshot of the state file at ${new Date().toISOString()}. A running server may hold changes it has not saved yet.\n`
    );
    for (const listing of listings) {
      process.stdout.write(`${describe(listing)}\n`);
    }
    process.stdout.write(`${listings.length} registration(s).\n`);
    if (droppedAtLoad > 0) process.stdout.write(dropNote);
    return 0;
  }

  const apply = args.includes("--apply");
  const clientIds = [...new Set(args.slice(1).filter((arg) => arg !== "--apply"))];
  if (clientIds.length === 0) {
    process.stderr.write(USAGE);
    return fail("name at least one client_id; there is no option to remove everything.", 2);
  }
  const unknown = clientIds.filter((clientId) => !store.removalFor(clientId));
  if (unknown.length > 0) {
    return fail(`not registered: ${unknown.map(printable).join(", ")}. Nothing was written.`);
  }
  // Checked before anything is announced, so a refused --apply never prints a
  // "remove" line first.
  if (apply) {
    if (await somethingListens(config.host, config.port)) {
      return fail(
        `something answers on ${config.host}:${config.port}, so the server looks to be running. Stop it first: it would write the removed registrations back. Nothing was written.`
      );
    }
    // The write replaces the file with one owned by whoever runs this, so
    // running it as another account would leave the server a file it may not
    // be able to read. The owner comes from the same read as the bytes, and is
    // checked again just before the write.
    const owner = first.uid;
    if (typeof process.geteuid === "function" && owner !== process.geteuid()) {
      return fail(
        `the state file belongs to uid ${owner}, not to this account (uid ${process.geteuid()}). Run this as the account the server runs as. Nothing was written.`
      );
    }
    process.stdout.write(
      `Nothing answers on ${config.host}:${config.port} (the server's configured address; a server on another address is not seen).\n`
    );
  }
  const byId = new Map(listings.map((listing) => [listing.clientId, listing]));
  for (const clientId of clientIds) {
    const removal = store.removalFor(clientId)!;
    process.stdout.write(
      `${apply ? "remove" : "would remove"}  ${describe(byId.get(clientId)!)}  ` +
        `with access:${removal.accessTokens},refresh:${removal.refreshTokens},tombstones:${removal.tombstones}\n`
    );
  }
  if (droppedAtLoad > 0) process.stdout.write(dropNote);
  if (!apply) {
    process.stdout.write("Dry run: nothing was written. Stop the server, then re-run with --apply.\n");
    return 0;
  }

  hooks.beforeWrite?.();
  // The last look before the write: the same bytes, in the same file, still
  // owned by this account. Equal bytes alone say nothing about the other two:
  // a chown leaves the bytes as they were, and so does replacing the file with
  // a copy. None of this makes the write a compare-and-swap — a save that
  // lands between here and the rename is still lost.
  const last = readStateFile(oauth.stateFile);
  if (last.kind !== "read") {
    const why =
      last.kind === "absent"
        ? "ENOENT"
        : last.failure.kind === "symlink"
          ? "a symbolic link is there now"
          : last.failure.code;
    return fail(`the state file could not be read again (${why}). Nothing was written.`);
  }
  if (sha256(last.bytes) !== readSha) {
    return fail("the state file changed after it was read; something else is writing it. Nothing was written.");
  }
  if (last.dev !== first.dev || last.ino !== first.ino) {
    return fail(
      "the state file was replaced after it was read (same bytes, another file); something else is writing it. Nothing was written."
    );
  }
  if (typeof process.geteuid === "function" && last.uid !== process.geteuid()) {
    return fail(
      `the state file now belongs to uid ${last.uid}, not to this account (uid ${process.geteuid()}). Nothing was written.`
    );
  }
  if (!store.removeRegistrations(clientIds)) {
    return fail("the state file could not be written. The registrations are still there.");
  }
  process.stdout.write(`Removed ${clientIds.length} registration(s) and what was bound to them.\n`);
  return 0;
}

// Run only as the entrypoint, so the tests can import `main` without starting it.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
