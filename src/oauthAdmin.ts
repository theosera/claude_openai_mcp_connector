#!/usr/bin/env node
// Operator command for OAuth client registrations (#184): list them, and
// remove named ones together with everything bound to them.
//
// It reads and writes the state file the HTTP server uses, through the same
// OAuthStore, so the file keeps its HMAC and nobody edits it by hand. It is
// meant to run with the server STOPPED. A running server holds the
// registrations in memory and writes them back on its next save, so a
// registration removed underneath it silently comes back. Before writing, this
// checks that nothing answers on the configured port and that the file has not
// changed since it was read — but a server on another port, or one started a
// moment later, is invisible to that check. Stopping the server first is the
// actual precaution; the check is a backstop.
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
import { OAuthStore, type RegistrationListing } from "./oauth/store.js";

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
 * Make a string safe to print on a terminal. `client_name` and `redirect_uris`
 * are whatever an anonymous caller of `/register` chose, so control characters
 * (ESC and the rest of C0, DEL, C1) and the bidirectional overrides that can
 * reorder what an operator reads are shown as escapes instead of acting.
 */
export function printable(value: string): string {
  // Compared by code point rather than with a regex, for the reason
  // pathSafety.ts gives: it keeps control bytes out of the source.
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    const bidi =
      code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    if (control) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if (bidi) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += char;
    }
  }
  return out;
}

function describe(listing: RegistrationListing): string {
  return [
    listing.clientId,
    `created=${new Date(listing.createdAt).toISOString()}`,
    `tokens=access:${listing.liveAccessTokens},refresh:${listing.liveRefreshTokens}`,
    // Quoted so a name with spaces stays one field. Not JSON.stringify: it would
    // double the backslashes `printable` adds, and it leaves C1 and the bidi
    // overrides alone.
    `name=${listing.clientName === undefined ? "-" : `"${printable(listing.clientName).replaceAll('"', '\\"')}"`}`,
    `redirect=${listing.redirectUris.map(printable).join(",")}`
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

/**
 * Run the command. `hooks.beforeWrite` exists for one test only: it runs after
 * every check and before the state file is re-read and written, so the test
 * can change the file in that window and see the write refused.
 */
export async function main(args: string[], hooks: { beforeWrite?: () => void } = {}): Promise<number> {
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

  let raw: Buffer;
  try {
    raw = fs.readFileSync(oauth.stateFile);
  } catch {
    if (command === "list") {
      process.stdout.write("No state file yet at the configured path, so there are no registrations.\n");
      return 0;
    }
    return fail("there is no state file at the configured path, so there is nothing to remove.");
  }
  const readSha = sha256(raw);

  const store = new OAuthStore({
    accessTokenTtlSec: oauth.accessTokenTtlSec,
    refreshTokenTtlSec: oauth.refreshTokenTtlSec,
    codeTtlSec: oauth.codeTtlSec,
    persistPath: oauth.stateFile,
    persistSecret: oauth.loginPassword,
    // Loading may promote a pending registration that holds a live token, and
    // the server writes that at once. Here it must not: `list` and the dry run
    // write nothing, and the sha check below compares against the file as read.
    writeAtLoad: false
  });
  if (store.loadOutcome !== "loaded") {
    // Never go on to write: the store fell back to an empty state, and saving
    // it would replace every registration and token in the file.
    return fail(
      "the state file did not verify (it was changed, is damaged, or MCP_OAUTH_PASSWORD differs from the one that wrote it). Nothing was read and nothing was written."
    );
  }
  const listings = store.listRegistrations();
  // Loading applies what the server applies at start, so it can drop entries
  // the file still holds. Say so, because --apply writes that out as well.
  const inFile = (JSON.parse(JSON.parse(raw.toString("utf8")).payload as string).clients ?? []).length as number;
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

  if (await somethingListens(config.host, config.port)) {
    return fail(
      `something answers on ${config.host}:${config.port}, so the server looks to be running. Stop it first: it would write the removed registrations back. Nothing was written.`
    );
  }
  hooks.beforeWrite?.();
  let current: Buffer;
  try {
    current = fs.readFileSync(oauth.stateFile);
  } catch {
    return fail("the state file disappeared after it was read. Nothing was written.");
  }
  if (sha256(current) !== readSha) {
    return fail("the state file changed after it was read; something else is writing it. Nothing was written.");
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
