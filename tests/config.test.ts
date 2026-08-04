import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, loadEnvFile, loadHttpConfig, selectedTransport } from "../src/config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The file name a hostile directory would use. Built as a constant so the intent
// ("a dotfile the server must NOT pick up on its own") stays readable.
const CWD_ENV_FILE = ".env";

// Everything an attacker-controlled working directory would like to choose for
// us: the transport, the bind address, the bearer, the write opt-in, the OAuth
// login password, and the knowledge roots (KNOWLEDGE_ROOTS outranks
// KNOWLEDGE_ROOT).
const HOSTILE_ENV_FILE = [
  "MCP_TRANSPORT=http",
  "MCP_HTTP_HOST=0.0.0.0",
  "MCP_HTTP_PORT=8799",
  "MCP_AUTH_TOKEN=attacker-known-token",
  "MCP_OAUTH_PASSWORD=attacker-chosen-password",
  "MCP_HTTP_ALLOW_WRITE=1",
  "KNOWLEDGE_ROOTS=evil=/tmp/attacker-chosen-root",
  ""
].join("\n");

describe("loadEnvFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-envfile-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads no file at all when MCP_ENV_FILE is unset (no implicit .env, no search)", async () => {
    await fs.writeFile(path.join(dir, CWD_ENV_FILE), HOSTILE_ENV_FILE, "utf8");

    const env: NodeJS.ProcessEnv = { KNOWLEDGE_ROOT: "/tmp/vault" };
    expect(loadEnvFile(env)).toBeUndefined();
    expect(env).toEqual({ KNOWLEDGE_ROOT: "/tmp/vault" });

    // None of the security-relevant readers can see the file's choices.
    expect(selectedTransport(env)).toBe("stdio");
    expect(() => loadHttpConfig(env)).toThrow(/MCP_AUTH_TOKEN is required/);
    expect(loadConfig(env).knowledgeRoots).toEqual([{ name: "vault", path: path.resolve("/tmp/vault") }]);
  });

  it("loads the operator's file and restores every documented setting", async () => {
    const envFile = path.join(dir, "vault.env");
    await fs.writeFile(
      envFile,
      [
        "# the operator's own file, named by absolute path",
        "KNOWLEDGE_ROOT=/tmp/file-vault",
        "MCP_TRANSPORT=http",
        "MCP_AUTH_TOKEN=file-token",
        "export MCP_HTTP_PORT=8788",
        "MCP_HTTP_ALLOW_WRITE=1",
        "MCP_SKILLS_SUBDIR=_skills",
        "MCP_AUDIT_SUBDIR=90_Audit/vault-scan",
        'MCP_OAUTH_PASSWORD="quoted pass phrase"',
        ""
      ].join("\n"),
      "utf8"
    );

    const env: NodeJS.ProcessEnv = { MCP_ENV_FILE: envFile, MCP_AUTH_TOKEN: "real-environment-token" };
    expect(loadEnvFile(env)).toBe(envFile);

    // dotenv precedence is preserved: the real environment wins, the file only
    // fills in what is unset (including quoted values and `export ` prefixes).
    expect(env.MCP_AUTH_TOKEN).toBe("real-environment-token");
    expect(env.MCP_OAUTH_PASSWORD).toBe("quoted pass phrase");
    expect(env.MCP_HTTP_PORT).toBe("8788");

    expect(selectedTransport(env)).toBe("http");
    const appConfig = loadConfig(env);
    expect(appConfig.knowledgeRoots).toEqual([{ name: "vault", path: path.resolve("/tmp/file-vault") }]);
    expect(appConfig.skillsSubdir).toBe("_skills");
    expect(appConfig.auditSubdir).toBe("90_Audit/vault-scan");
    const httpConfig = loadHttpConfig(env);
    expect(httpConfig.authToken).toBe("real-environment-token");
    expect(httpConfig.allowWrite).toBe(true);
    expect(httpConfig.port).toBe(8788);
  });

  it("fails closed on a relative or unreadable path", async () => {
    expect(() => loadEnvFile({ MCP_ENV_FILE: CWD_ENV_FILE })).toThrow(/must be an absolute path/);
    expect(() => loadEnvFile({ MCP_ENV_FILE: "config/vault.env" })).toThrow(/must be an absolute path/);
    expect(() => loadEnvFile({ MCP_ENV_FILE: path.join(dir, "absent.env") })).toThrow(/Cannot read MCP_ENV_FILE/);
  });
});

/**
 * End-to-end on the real entrypoint: the process is spawned the way an MCP
 * client spawns it (a minimal `env`, an inherited working directory), so the
 * "a .env in the cwd cannot choose the transport/credentials/roots" property is
 * pinned against the actual startup path rather than a helper.
 */
describe("startup env boundary (spawned entrypoint)", () => {
  const entry = path.join(repoRoot, "src", "index.ts");
  const tsxLoader = pathToFileURL(path.join(repoRoot, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;

  let hostileCwd: string;
  let vault: string;
  let stateDir: string;

  beforeEach(async () => {
    hostileCwd = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-hostile-cwd-"));
    vault = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-cfg-vault-"));
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-cfg-state-"));
    await fs.writeFile(path.join(hostileCwd, CWD_ENV_FILE), HOSTILE_ENV_FILE, "utf8");
  });

  afterEach(async () => {
    for (const dir of [hostileCwd, vault, stateDir]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /** Run the entrypoint to completion (stdin is closed, so stdio shuts down). */
  function runServer(env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsxLoader, entry], {
        cwd: hostileCwd,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...env },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      // A regression that turned this into an HTTP listener would never exit;
      // stop waiting and let the assertions report what actually happened.
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ stdout, stderr, code });
      });
    });
  }

  it("ignores a .env in the working directory and stays a local stdio server", async () => {
    const result = await runServer({ KNOWLEDGE_ROOT: vault, MCP_PATCH_STATE_DIR: path.join(stateDir, "patches") });

    // Transport, bind address, bearer and roots all came from the real
    // environment; the hostile file chose nothing.
    expect(result.stderr).not.toMatch(/HTTP transport listening/);
    expect(result.stderr).not.toMatch(/attacker-known-token/);
    // Objection-2 signal: a write-capable stdio process with no audit subdir
    // says so, instead of starting silently with the INV-9 reservation off.
    expect(result.stderr).toContain("MCP stdio transport ready (write=on, documents=on, skills=off, audit=off)");
    // stdout is the JSON-RPC channel and must carry nothing but protocol data
    // (the removed dotenv.config() used to print a banner there).
    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);
  }, 30_000);

  it("applies the operator's MCP_ENV_FILE, so the audit/skill surface comes back on", async () => {
    await fs.mkdir(path.join(vault, "_skills"), { recursive: true });
    await fs.mkdir(path.join(vault, "90_Audit", "vault-scan", "reports"), { recursive: true });
    const envFile = path.join(stateDir, "vault.env");
    await fs.writeFile(
      envFile,
      [
        "MCP_SKILLS_SUBDIR=_skills",
        "MCP_AUDIT_SUBDIR=90_Audit/vault-scan",
        `MCP_PATCH_STATE_DIR=${path.join(stateDir, "patches")}`,
        ""
      ].join("\n"),
      "utf8"
    );

    // The client-registration shape: KNOWLEDGE_ROOT in the spawned env, every
    // other setting in the operator's own file.
    const result = await runServer({ KNOWLEDGE_ROOT: vault, MCP_ENV_FILE: envFile });

    expect(result.stderr).toContain("MCP stdio transport ready (write=on, documents=on, skills=on, audit=on)");
    expect(result.code).toBe(0);
  }, 30_000);

  it("refuses to start on a relative or unreadable MCP_ENV_FILE", async () => {
    const relative = await runServer({ KNOWLEDGE_ROOT: vault, MCP_ENV_FILE: CWD_ENV_FILE });
    expect(relative.code).toBe(1);
    expect(relative.stderr).toMatch(/MCP_ENV_FILE must be an absolute path/);
    expect(relative.stderr).not.toMatch(/transport (ready|listening)/);

    const absent = await runServer({ KNOWLEDGE_ROOT: vault, MCP_ENV_FILE: path.join(stateDir, "absent.env") });
    expect(absent.code).toBe(1);
    expect(absent.stderr).toMatch(/Cannot read MCP_ENV_FILE/);
  }, 30_000);
});
