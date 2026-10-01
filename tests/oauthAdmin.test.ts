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

  it("lists every registration as a snapshot, with what a caller sent made printable", async () => {
    const { kept, doomed } = seed();
    const listed = await run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout.split("\n")[0]).toMatch(/^Snapshot of the state file at .* A running server may hold changes/);
    const doomedLine = listed.stdout.split("\n").find((line) => line.startsWith(doomed.clientId))!;
    expect(doomedLine).toContain("tokens=access:2,refresh:2");
    expect(doomedLine).toContain("\\x1b]0;owned\\x07\\u202ename");
    expect(doomedLine).toContain("https://doomed.example/cb\\x1b[2J");
    expect(listed.stdout).toContain(kept.clientId);
    for (const raw of [ESC, BEL, RLO]) {
      expect(listed.stdout).not.toContain(raw);
    }
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

  // In process, because the window this pins — after every check, before the
  // write — cannot be reached from outside a spawned command.
  it("refuses --apply when the state file changes after it was read", async () => {
    const { doomed } = seed();
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
    let changedTo = "";
    const code = await main(["remove", doomed.clientId, "--apply"], {
      beforeWrite: () => {
        // What a server saving underneath the command looks like: same file,
        // new bytes.
        const store = reload();
        store.registerClient(["https://late.example/cb"]);
        changedTo = fsSync.readFileSync(stateFile, "utf8");
      }
    });
    expect(code).toBe(1);
    expect(errors.join("")).toContain("the state file changed after it was read");
    expect(changedTo).not.toBe("");
    expect(fsSync.readFileSync(stateFile, "utf8")).toBe(changedTo); // nothing was written over it
  }, 30_000);

  it("never prints the password, the key derived from it, the bearer or a token", async () => {
    const { keptTokens, doomed, doomedTokens, rotated } = seed();
    const salt = Buffer.from(JSON.parse(await fs.readFile(stateFile, "utf8")).salt as string, "hex");
    const derivedKey = crypto.scryptSync(PASSWORD, salt, 32);
    const secrets = [
      PASSWORD,
      AUTH_TOKEN,
      derivedKey.toString("hex"),
      derivedKey.toString("base64"),
      keptTokens.accessToken,
      keptTokens.refreshToken,
      doomedTokens.accessToken,
      doomedTokens.refreshToken,
      rotated.accessToken,
      rotated.refreshToken
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
