import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthStore, REGISTRATION_CONSENT_DEADLINE_MS } from "../src/oauth/store.js";
import { main } from "../src/oauthAdmin.js";

// The operator command for OAuth registrations (#184). Most cases spawn the
// real entrypoint, because what is under test is what reaches the operator's
// terminal and what reaches the state file.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "src", "oauthAdmin.ts");
const tsxLoader = pathToFileURL(path.join(repoRoot, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;

const PASSWORD = "admin-cli-test-password";
const AUTH_TOKEN = "admin-cli-test-bearer";
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const RLO = String.fromCharCode(0x202e);
const TTL = { accessTokenTtlSec: 3600, refreshTokenTtlSec: 86_400, codeTtlSec: 60 };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("oauth:registrations (#184)", () => {
  let vault: string;
  let stateDir: string;
  let stateFile: string;
  let port: number;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-admin-vault-"));
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-admin-state-"));
    stateFile = path.join(stateDir, "oauth-state.json");
    port = await freePort();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of [vault, stateDir]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  function configEnv(): Record<string, string> {
    return {
      KNOWLEDGE_ROOT: vault,
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      MCP_OAUTH_ENABLED: "1",
      MCP_HTTP_PUBLIC_URL: "https://vault.example",
      MCP_OAUTH_PASSWORD: PASSWORD,
      MCP_OAUTH_STATE_FILE: stateFile,
      MCP_HTTP_PORT: String(port)
    };
  }

  function run(
    args: string[],
    overrides: Record<string, string | undefined> = {}
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ...configEnv(),
      ...overrides
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
    }
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsxLoader, entry, ...args], {
        cwd: stateDir,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ code, stdout, stderr });
      });
    });
  }

  /**
   * Two registrations with a token pair each. `doomed` was rotated once, so it
   * also holds a rotation tombstone, and its name and redirect URI carry the
   * control characters an anonymous caller of /register could send.
   */
  function seed() {
    const store = new OAuthStore({ ...TTL, persistPath: stateFile, persistSecret: PASSWORD });
    const kept = store.registerClient(["https://kept.example/cb"], "kept")!;
    const keptTokens = store.issueTokens(kept.clientId, "vault.read", "r");
    const doomed = store.registerClient([`https://doomed.example/cb${ESC}[2J`], `evil${ESC}]0;owned${BEL}${RLO}name`)!;
    const doomedTokens = store.issueTokens(doomed.clientId, "vault.read", "r");
    const rotated = store.rotateRefreshToken(doomedTokens.refreshToken, doomed.clientId)!;
    return { kept, keptTokens, doomed, doomedTokens, rotated };
  }

  const reload = () => new OAuthStore({ ...TTL, persistPath: stateFile, persistSecret: PASSWORD });

  // One registration in each state. `kept` holds live tokens, so load reads it
  // as given; `waiting` never consented; `carried` lost its `consent` field the
  // way a state file written before the field existed holds it.
  it("shows each registration's state, and when a pending one expires", async () => {
    const { kept } = seed();
    const store = new OAuthStore({ ...TTL, persistPath: stateFile, persistSecret: PASSWORD });
    const waiting = store.registerClient(["https://waiting.example/cb"])!;
    const carried = store.registerClient(["https://carried.example/cb"])!;
    const envelope = JSON.parse(await fs.readFile(stateFile, "utf8"));
    const payload = JSON.parse(envelope.payload as string);
    for (const record of payload.clients as { clientId: string; consent?: string }[]) {
      if (record.clientId === carried.clientId) delete record.consent;
    }
    envelope.payload = JSON.stringify(payload);
    envelope.mac = crypto
      .createHmac("sha256", crypto.scryptSync(PASSWORD, Buffer.from(envelope.salt as string, "hex"), 32))
      .update(envelope.payload as string)
      .digest("hex");
    await fs.writeFile(stateFile, JSON.stringify(envelope));

    const listed = await run(["list"]);
    expect(listed.code).toBe(0);
    const lineOf = (clientId: string) => listed.stdout.split("\n").find((line) => line.startsWith(clientId))!;
    expect(lineOf(kept.clientId)).toContain("state=given");
    expect(lineOf(waiting.clientId)).toContain(
      `state=pending  expires=${new Date(waiting.createdAt + REGISTRATION_CONSENT_DEADLINE_MS).toISOString()}`
    );
    expect(lineOf(carried.clientId)).toContain("state=unknown");
    expect(lineOf(carried.clientId)).not.toContain("expires=");
  }, 30_000);

  // The listing is the operator's view of what an anonymous caller sent, so
  // nothing in a name or a redirect URI may act on the terminal, hide, or pose
  // as one of the line's own fields — and `list` writes nothing, even when
  // loading promotes a registration (`doomed` is pending with live tokens).
  //
  // Reverse-verified: escaping no C1, no format characters, or no backslash,
  // leaving redirect URIs unquoted, and letting `list` write at load each
  // redden this test.
  it("lists every registration as a snapshot, with what a caller sent made printable", async () => {
    const hidden = [0x9b, 0x85, 0x200e, 0x2066, 0x061c, 0x2028, 0x200b, 0xfeff, 0xe0041].map((code) =>
      String.fromCodePoint(code)
    );
    const disguised = reload().registerClient(
      ["https://evil.example/cb,https://claude.ai/api/mcp/auth_callback  state=given  tokens=access:1,refresh:1"],
      `x${hidden.join("")}\\x1b"y`
    )!;
    // Seeded last: a store that loads `doomed` with its live tokens promotes it
    // and writes that at once, and then `list` would have nothing to write.
    const { kept, doomed } = seed();
    const before = await fs.readFile(stateFile);
    const onDisk = JSON.parse(JSON.parse(before.toString("utf8")).payload as string) as {
      clients: { clientId: string; consent: string }[];
    };
    expect(onDisk.clients.find((client) => client.clientId === doomed.clientId)?.consent).toBe("pending");

    const listed = await run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout.split("\n")[0]).toMatch(/^Snapshot of the state file at .* A running server may hold changes/);
    const lineOf = (clientId: string) => listed.stdout.split("\n").find((line) => line.startsWith(clientId))!;
    const doomedLine = lineOf(doomed.clientId);
    expect(doomedLine).toContain("tokens=access:2,refresh:2");
    expect(doomedLine).toContain('name="evil\\x1b]0;owned\\x07\\u202ename"');
    expect(doomedLine).toContain('redirect="https://doomed.example/cb\\x1b[2J"');
    expect(listed.stdout).toContain(kept.clientId);

    const disguisedLine = lineOf(disguised.clientId);
    expect(disguisedLine).toContain(
      'name="x\\x9b\\x85\\u200e\\u2066\\u061c\\u2028\\u200b\\ufeff\\u{e0041}\\\\x1b\\"y"'
    );
    // Outside the quoted fields the line has exactly one state and one tokens.
    const unquoted = disguisedLine.replace(/"(?:\\.|[^"\\])*"/g, '""');
    expect(unquoted.match(/state=/g)).toHaveLength(1);
    expect(unquoted.match(/tokens=/g)).toHaveLength(1);

    for (const raw of [ESC, BEL, RLO, ...hidden]) {
      expect(listed.stdout).not.toContain(raw);
    }
    expect((await fs.readFile(stateFile)).equals(before)).toBe(true);
  }, 30_000);

  it("writes nothing on a remove without --apply", async () => {
    const { doomed } = seed();
    const before = await fs.readFile(stateFile);
    const planned = await run(["remove", doomed.clientId]);
    expect(planned.code).toBe(0);
    expect(planned.stdout).toContain(`would remove  ${doomed.clientId}`);
    expect(planned.stdout).toContain("with access:2,refresh:2,tombstones:1");
    expect(planned.stdout).toContain("Dry run: nothing was written.");
    expect((await fs.readFile(stateFile)).equals(before)).toBe(true);
  }, 30_000);

  it("removes a registration with its tokens and rotation record on --apply, and nothing else", async () => {
    const { kept, keptTokens, doomed, doomedTokens, rotated } = seed();
    const applied = await run(["remove", doomed.clientId, "--apply"]);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain("Removed 1 registration(s)");

    const after = reload();
    expect(after.getClient(doomed.clientId)).toBeUndefined();
    expect(after.validateAccessToken(doomedTokens.accessToken)).toBeNull();
    expect(after.validateAccessToken(rotated.accessToken)).toBeNull();
    expect(after.rotateRefreshToken(rotated.refreshToken, doomed.clientId)).toBeNull();
    const payload = JSON.parse(JSON.parse(await fs.readFile(stateFile, "utf8")).payload as string);
    expect((payload.rotatedTombstones as { clientId: string }[]).filter((t) => t.clientId === doomed.clientId)).toEqual(
      []
    );
    // Control: the other registration and its token are untouched.
    expect(after.getClient(kept.clientId)?.redirectUris).toEqual(["https://kept.example/cb"]);
    expect(after.validateAccessToken(keptTokens.accessToken)?.clientId).toBe(kept.clientId);
  }, 30_000);

  it("refuses a client_id that is not registered, and writes nothing", async () => {
    const { doomed } = seed();
    const before = await fs.readFile(stateFile);
    const refused = await run(["remove", doomed.clientId, "client_not-there", "--apply"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("not registered: client_not-there");
    expect((await fs.readFile(stateFile)).equals(before)).toBe(true);
  }, 30_000);

  it("requires at least one client_id; there is no way to remove everything", async () => {
    seed();
    const refused = await run(["remove", "--apply"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("there is no option to remove everything");
  }, 30_000);

  it("refuses a state file that does not verify, and leaves it as it was", async () => {
    const { doomed } = seed();
    const written = await fs.readFile(stateFile, "utf8");
    const tampered = written.replace(/"mac":"(.)/, (_m, c: string) => `"mac":"${c === "0" ? "1" : "0"}`);
    expect(tampered).not.toBe(written); // reached: the MAC really changed
    await fs.writeFile(stateFile, tampered);

    const listed = await run(["list"]);
    expect(listed.code).toBe(1);
    expect(listed.stderr).toContain("the state file did not verify");
    const removed = await run(["remove", doomed.clientId, "--apply"]);
    expect(removed.code).toBe(1);
    expect(removed.stderr).toContain("the state file did not verify");
    expect(await fs.readFile(stateFile, "utf8")).toBe(tampered);
  }, 30_000);

  it("refuses --apply while something answers on the server's port", async () => {
    const { doomed } = seed();
    const before = await fs.readFile(stateFile);
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const refused = await run(["remove", doomed.clientId, "--apply"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`something answers on 127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect((await fs.readFile(stateFile)).equals(before)).toBe(true);
  }, 30_000);

  // When the probe can neither connect nor be refused, the safe reading is
  // "maybe running". An unresolvable host is such a case.
  //
  // Reverse-verified: treating every probe error as "nothing listens" reddens
  // this test (the write goes through).
  it("refuses --apply when it cannot tell whether a server answers", async () => {
    const { doomed } = seed();
    const before = await fs.readFile(stateFile);
    const refused = await run(["remove", doomed.clientId, "--apply"], { MCP_HTTP_HOST: "nonexistent.invalid" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("something answers on nonexistent.invalid");
    expect((await fs.readFile(stateFile)).equals(before)).toBe(true);
  }, 30_000);

  // Reverse-verified: ignoring the store's save result in the command reddens
  // the status and message asserts (it says "Removed").
  it("reports a removal it could not write, and leaves the registration", async () => {
    const { doomed } = seed();
    await fs.mkdir(`${stateFile}.tmp`);
    try {
      const failed = await run(["remove", doomed.clientId, "--apply"]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("could not be written");
      expect(failed.stdout).not.toContain("Removed");
    } finally {
      await fs.rmdir(`${stateFile}.tmp`);
    }
    expect(reload().getClient(doomed.clientId)).toBeDefined();
  }, 30_000);

  // A file this account cannot read is not "no file yet": saying so sends the
  // operator to re-run as someone who can, and that run writes the file back
  // owned by them.
  //
  // Reverse-verified: treating every read error as a missing file reddens this
  // test (exit 0, "No state file yet").
  it.skipIf(process.getuid?.() === 0)(
    "refuses a state file it cannot read, instead of calling it absent",
    async () => {
      seed();
      await fs.chmod(stateFile, 0o000);
      try {
        const listed = await run(["list"]);
        expect(listed.code).toBe(1);
        expect(listed.stderr).toContain("the state file cannot be read (EACCES)");
        expect(listed.stdout).not.toContain("No state file yet");
      } finally {
        await fs.chmod(stateFile, 0o600);
      }
    },
    30_000
  );

  /**
   * A file's identity and bytes from one handle, so both describe the same
   * file; read through the path twice, they could describe two.
   */
  async function snapshotOf(file: string) {
    const handle = await fs.open(file, "r");
    try {
      return { stat: await handle.stat(), bytes: await handle.readFile() };
    } finally {
      await handle.close();
    }
  }

  /**
   * Run the command in this process, for what a spawned one cannot reach: an
   * account the test pretends to be, or a change made after every check and
   * before the write (`beforeWrite`).
   */
  async function runInProcess(args: string[], beforeWrite?: () => void) {
    for (const [key, value] of Object.entries(configEnv())) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("MCP_ENV_FILE", "");
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await main(args, { beforeWrite });
    return { code, stderr: errors.join("") };
  }

  // In process: a file owned by another account cannot be made without root,
  // so the account this runs as is what the test changes.
  //
  // Reverse-verified: removing the owner check reddens this test.
  it("refuses --apply on a state file another account owns", async () => {
    const { doomed } = seed();
    const before = await snapshotOf(stateFile);
    const owner = before.stat.uid;
    vi.spyOn(process, "geteuid").mockReturnValue(owner + 1);

    const refused = await runInProcess(["remove", doomed.clientId, "--apply"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`the state file belongs to uid ${owner}`);
    const after = await snapshotOf(stateFile);
    expect(after.stat.ino).toBe(before.stat.ino); // not replaced by a write
    expect(after.bytes.equals(before.bytes)).toBe(true);
  }, 30_000);

  // The last look before the write checks three things, and each test below is
  // the one only its own check can catch: new bytes in the same file, the same
  // bytes in another file, and the same file under another owner. A server's
  // save is the first test: new bytes, and a new file too (it renames), so the
  // byte check sees it first.
  //
  // Reverse-verified: removing the byte check reddens the first two, removing
  // the file check the third, removing the owner check the fourth, and letting
  // a failed re-read through the fifth.
  it("refuses --apply when the state file changes after it was read", async () => {
    const { doomed } = seed();
    let changedTo = "";
    const refused = await runInProcess(["remove", doomed.clientId, "--apply"], () => {
      // What a server saving underneath the command looks like.
      reload().registerClient(["https://late.example/cb"]);
      changedTo = fsSync.readFileSync(stateFile, "utf8");
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the state file changed after it was read");
    expect(changedTo).not.toBe("");
    expect(fsSync.readFileSync(stateFile, "utf8")).toBe(changedTo); // nothing was written over it
  }, 30_000);

  it("refuses --apply when the state file's bytes change in place after it was read", async () => {
    const { doomed } = seed();
    const before = await snapshotOf(stateFile);
    const changed = Buffer.concat([before.bytes, Buffer.from("\n")]);
    const refused = await runInProcess(["remove", doomed.clientId, "--apply"], () => {
      fsSync.writeFileSync(stateFile, changed); // truncates and rewrites the same file
    });
    const after = await snapshotOf(stateFile);
    expect(after.stat.ino).toBe(before.stat.ino); // the change reached the same file, as intended
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the state file changed after it was read");
    expect(after.bytes.equals(changed)).toBe(true); // nothing was written over it
  }, 30_000);

  it("refuses --apply when the state file is replaced by a copy of itself after it was read", async () => {
    const { doomed } = seed();
    const before = await snapshotOf(stateFile);
    const refused = await runInProcess(["remove", doomed.clientId, "--apply"], () => {
      fsSync.writeFileSync(`${stateFile}.copy`, before.bytes);
      fsSync.renameSync(`${stateFile}.copy`, stateFile);
    });
    const after = await snapshotOf(stateFile);
    expect(after.stat.ino).not.toBe(before.stat.ino); // the copy is in place, as intended
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the state file was replaced after it was read");
    const unchanged = await snapshotOf(stateFile);
    expect(unchanged.stat.ino).toBe(after.stat.ino); // nothing was written over the copy
  }, 30_000);

  // A chown needs root, so the owner the last read reports is what changes.
  it("refuses --apply when the state file's owner changes after it was read", async () => {
    const { doomed } = seed();
    const before = await snapshotOf(stateFile);
    const realFstat = fsSync.fstatSync;
    let ownerChanges = 0;
    const refused = await runInProcess(["remove", doomed.clientId, "--apply"], () => {
      vi.spyOn(fsSync, "fstatSync").mockImplementation(((fd: number) => {
        ownerChanges += 1;
        return { ...realFstat(fd), uid: before.stat.uid + 1 };
      }) as typeof fsSync.fstatSync);
    });
    expect(ownerChanges).toBe(1); // the last read saw the new owner, as intended
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`the state file now belongs to uid ${before.stat.uid + 1}`);
    const after = await snapshotOf(stateFile);
    expect(after.stat.ino).toBe(before.stat.ino); // not replaced by a write
    expect(after.bytes.equals(before.bytes)).toBe(true);
  }, 30_000);

  it("refuses --apply when the state file cannot be read again before the write", async () => {
    const { doomed } = seed();
    const before = await snapshotOf(stateFile);
    const refused = await runInProcess(["remove", doomed.clientId, "--apply"], () => {
      fsSync.renameSync(stateFile, `${stateFile}.moved`);
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the state file could not be read again (ENOENT)");
    expect(fsSync.existsSync(stateFile)).toBe(false); // nothing was written in its place
    expect((await fs.readFile(`${stateFile}.moved`)).equals(before.bytes)).toBe(true);
  }, 30_000);

  it("never prints the password, the key derived from it, the bearer or a token", async () => {
    const { keptTokens, doomed, doomedTokens, rotated } = seed();
    const salt = Buffer.from(JSON.parse(await fs.readFile(stateFile, "utf8")).salt as string, "hex");
    const derivedKey = crypto.scryptSync(PASSWORD, salt, 32);
    const tokenValues = [
      keptTokens.accessToken,
      keptTokens.refreshToken,
      doomedTokens.accessToken,
      doomedTokens.refreshToken,
      rotated.accessToken,
      rotated.refreshToken
    ];
    const secrets = [
      PASSWORD,
      AUTH_TOKEN,
      derivedKey.toString("hex"),
      derivedKey.toString("base64"),
      ...tokenValues,
      // The store keys tokens by these, so they are what a careless listing would print.
      ...tokenValues.map((token) => crypto.createHash("sha256").update(token).digest("hex"))
    ];
    const outputs = [
      await run(["--help"]),
      await run(["list"]),
      await run(["remove", doomed.clientId]),
      await run(["remove", "client_not-there", "--apply"]),
      await run(["list"], { MCP_AUTH_TOKEN: undefined }), // a configuration error
      await run(["list"], { MCP_OAUTH_PASSWORD: "a-different-password" }) // a file that does not verify
    ];
    for (const { stdout, stderr } of outputs) {
      for (const secret of secrets) {
        expect(stdout).not.toContain(secret);
        expect(stderr).not.toContain(secret);
      }
    }
    // Reached: each of those runs produced output to check.
    expect(outputs.every(({ stdout, stderr }) => stdout.length + stderr.length > 0)).toBe(true);
  }, 60_000);
});
