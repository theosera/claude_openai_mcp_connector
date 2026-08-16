import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(result.stderr).toContain(
      "MCP stdio transport ready (write=on, documents=on, legacy_create=off, skills=off, audit=off)"
    );
    // stdout is the JSON-RPC channel and must carry nothing but protocol data
    // (the removed dotenv.config() used to print a banner there).
    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);
  }, 30_000);

  it("applies the operator's MCP_ENV_FILE, so the skill surface and the audit reservation come back on", async () => {
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

    // `reserved-only` on BOTH, not `on`: the two subdir settings turn the INV-8
    // and INV-9 reservations on (which is what operators are told to set them
    // for) WITHOUT registering either write surface. Each needs its own opt-in —
    // see the next cases.
    //
    // `skills` read `on` here until the Skill half was split from its subdir the
    // way the audit half already had been. The startup line was accurate about
    // the code at the time and wrong about the intent, which is the reason it
    // prints three states rather than two: an on/off can only ever name one of
    // "the subtree is reserved" and "the tools are registered".
    expect(result.stderr).toContain(
      "MCP stdio transport ready (write=on, documents=on, legacy_create=off, " +
        "skills=reserved-only, audit=reserved-only)"
    );
    expect(result.code).toBe(0);
  }, 30_000);

  it("registers the stdio audit write tools only when their own flag is set", async () => {
    await fs.mkdir(path.join(vault, "90_Audit", "vault-scan", "reports"), { recursive: true });
    const result = await runServer({
      KNOWLEDGE_ROOT: vault,
      MCP_PATCH_STATE_DIR: path.join(stateDir, "patches"),
      MCP_AUDIT_SUBDIR: "90_Audit/vault-scan",
      MCP_STDIO_ALLOW_AUDIT_WRITE: "1"
    });

    expect(result.stderr).toContain(
      "MCP stdio transport ready (write=on, documents=on, legacy_create=off, skills=off, audit=on)"
    );
    expect(result.code).toBe(0);
  }, 30_000);

  it("names the legacy create surface in the stdio startup line", async () => {
    // Both states are printed, because "documents=on" alone stopped describing
    // the write surface once the one-step create became its own decision.
    const off = await runServer({ KNOWLEDGE_ROOT: vault, MCP_PATCH_STATE_DIR: path.join(stateDir, "patches") });
    expect(off.stderr).toContain("documents=on, legacy_create=off,");

    const on = await runServer({
      KNOWLEDGE_ROOT: vault,
      MCP_PATCH_STATE_DIR: path.join(stateDir, "patches"),
      MCP_ALLOW_LEGACY_CREATE_DOCUMENT: "1"
    });
    expect(on.stderr).toContain("documents=on, legacy_create=on,");
    expect(on.code).toBe(0);
  }, 30_000);

  it("refuses to start when the audit write flag names no subtree to write into", async () => {
    // The contradiction fails at boot rather than starting a server whose audit
    // surface silently does not exist — the same shape MCP_HTTP_ALLOW_AUDIT_WRITE
    // already had.
    const result = await runServer({
      KNOWLEDGE_ROOT: vault,
      MCP_PATCH_STATE_DIR: path.join(stateDir, "patches"),
      MCP_STDIO_ALLOW_AUDIT_WRITE: "1"
    });

    expect(result.stderr).toMatch(/MCP_STDIO_ALLOW_AUDIT_WRITE requires MCP_AUDIT_SUBDIR/);
    expect(result.code).not.toBe(0);
  }, 30_000);

  it("refuses to start when the Skill write flag names no subtree to write into", async () => {
    // Same contradiction, same fail-closed answer. Asserted separately rather
    // than folded into the audit case because the two flags are independent —
    // a shared assertion would stay green if one of them stopped being checked.
    const result = await runServer({
      KNOWLEDGE_ROOT: vault,
      MCP_PATCH_STATE_DIR: path.join(stateDir, "patches"),
      MCP_STDIO_ALLOW_SKILL_WRITE: "1"
    });

    expect(result.stderr).toMatch(/MCP_STDIO_ALLOW_SKILL_WRITE requires MCP_SKILLS_SUBDIR/);
    expect(result.code).not.toBe(0);
  }, 30_000);

  it("registers the stdio Skill write tools only when their own flag is set", async () => {
    await fs.mkdir(path.join(vault, "_skills"), { recursive: true });
    const base = {
      KNOWLEDGE_ROOT: vault,
      MCP_SKILLS_SUBDIR: "_skills",
      MCP_PATCH_STATE_DIR: path.join(stateDir, "patches")
    };

    const reservedOnly = await runServer(base);
    expect(reservedOnly.stderr).toContain("skills=reserved-only,");
    expect(reservedOnly.code).toBe(0);

    const on = await runServer({ ...base, MCP_STDIO_ALLOW_SKILL_WRITE: "1" });
    expect(on.stderr).toContain("skills=on,");
    expect(on.code).toBe(0);

    // The third state needs the subdir gone entirely: `off` means the INV-8
    // reservation is not in effect at all, which is a different claim from
    // "reserved but not writable" and the reason this line prints three values.
    const off = await runServer({ KNOWLEDGE_ROOT: vault, MCP_PATCH_STATE_DIR: path.join(stateDir, "patches") });
    expect(off.stderr).toContain("skills=off,");
    expect(off.code).toBe(0);
  }, 60_000);

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

describe("patch state directory default", () => {
  // A two-step plan holds the full proposed document text, so where the default
  // lands decides where vault plaintext lands. Resolved against the working
  // directory it followed the caller, and for a client-spawned stdio server the
  // caller chooses that directory.
  it("derives a different default for each knowledge root", () => {
    // applyPlannedUpdate finds a plan by patch_id alone and applies its target
    // path against whichever root the running store has, so two servers sharing
    // a plan directory can cross over. A single shared default would have made
    // that the out-of-the-box arrangement; per-root keeps them apart.
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    try {
      const a = loadConfig({ KNOWLEDGE_ROOT: "/vaults/alpha" }).patchStateDir;
      const b = loadConfig({ KNOWLEDGE_ROOT: "/vaults/beta" }).patchStateDir;
      expect(a).not.toBe(b);
      // Stable for a given root, so plans survive a restart.
      expect(loadConfig({ KNOWLEDGE_ROOT: "/vaults/alpha" }).patchStateDir).toBe(a);
      // One level under ~/.mcp-state, not nested deeper: ensurePatchStateDir
      // only refuses a symlink at the leaf, so an extra level would add an
      // unchecked parent.
      expect(path.dirname(a)).toBe(path.join("/fake", "home", ".mcp-state"));
      // The leaf shape itself. Everything above still passes if the prefix or
      // the tag length changes, so pin them: the depth argument rests on this
      // staying one directory, and the documented shape is what the operator
      // matches against when they go looking for a staged plan.
      expect(path.basename(a)).toMatch(/^patches-[0-9a-f]{16}$/);
      // In multi-root setups the PRIMARY root selects it — that is the only
      // writable one, so it is the only one plans can target.
      expect(loadConfig({ KNOWLEDGE_ROOTS: "alpha=/vaults/alpha,other=/vaults/beta" }).patchStateDir).toBe(a);
    } finally {
      spy.mockRestore();
    }
  });

  it("names the setting even when os.homedir() throws instead of returning ''", () => {
    // Node routes the libuv call through a checked wrapper, so a host where
    // neither HOME nor a passwd entry resolves raises ERR_SYSTEM_ERROR rather
    // than handing back "". The start-up still has to fail — but with the
    // message that says which setting to add, not with a bare system error.
    const spy = vi.spyOn(os, "homedir").mockImplementation(() => {
      throw new Error("ERR_SYSTEM_ERROR: uv_os_homedir returned ENOENT");
    });
    try {
      expect(() => loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault" })).toThrow(/MCP_PATCH_STATE_DIR/);
      // And an explicit setting still starts on such a host: the fallback is
      // only consulted when the operator named nothing.
      expect(loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault", MCP_PATCH_STATE_DIR: "/srv/state" }).patchStateDir).toBe(
        path.resolve("/srv/state")
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("keys the tag on the NFC form, so one vault does not get two directories", () => {
    // macOS hands back NFD for non-ASCII path components, so the same vault
    // arrives spelled two ways depending on how the value was produced. path.resolve
    // normalises separators and . segments but not Unicode, so without folding
    // here the tag moves with the spelling and already-staged plans become
    // unreachable, their plaintext left behind in the previous directory.
    const nfc = "/vaults/ログ".normalize("NFC");
    const nfd = "/vaults/ログ".normalize("NFD");
    // Guard the fixture: a character that does not decompose would make the
    // assertion below vacuous.
    expect(nfd).not.toBe(nfc);

    const spy = vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    try {
      const fromNfc = loadConfig({ KNOWLEDGE_ROOT: nfc }).patchStateDir;
      expect(loadConfig({ KNOWLEDGE_ROOT: nfd }).patchStateDir).toBe(fromNfc);
      // Widening what counts as the same path must not merge different ones.
      expect(loadConfig({ KNOWLEDGE_ROOT: "/vaults/ロク" }).patchStateDir).not.toBe(fromNfc);
    } finally {
      spy.mockRestore();
    }
  });

  it("resolves the default independently of the working directory", async () => {
    // The home directory is pinned to a known value rather than read back from
    // os.homedir(): deriving the expectation from the same call the code makes
    // would assert only that two identical expressions agree, and would still
    // pass if the derivation were wrong in the same way on both sides.
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/fake/home");
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-cwd-"));
    const original = process.cwd();
    try {
      const before = loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault" }).patchStateDir;
      process.chdir(elsewhere);
      const after = loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault" }).patchStateDir;
      expect(path.dirname(before)).toBe(path.join("/fake", "home", ".mcp-state"));
      expect(after).toBe(before);
      expect(after.startsWith(elsewhere)).toBe(false);
    } finally {
      process.chdir(original);
      spy.mockRestore();
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses to guess when no home directory is available", () => {
    // os.homedir() returns "" when HOME is empty with no passwd fallback, and
    // returns HOME verbatim when HOME is relative. Both make path.join produce a
    // relative string that path.resolve re-anchors to the cwd — the placement
    // this default exists to prevent, in exactly the environments that strip
    // HOME (service accounts, the --clearenv bwrap recipe in operations.md).
    for (const home of ["", "relative-home"]) {
      const spy = vi.spyOn(os, "homedir").mockReturnValue(home);
      try {
        expect(() => loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault" })).toThrow(/MCP_PATCH_STATE_DIR/);
        // An explicit setting must still work on such a host: the fallback is
        // only consulted when the operator named nothing.
        expect(loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault", MCP_PATCH_STATE_DIR: "/srv/state" }).patchStateDir).toBe(
          path.resolve("/srv/state")
        );
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("still honours an explicit MCP_PATCH_STATE_DIR", () => {
    const dir = loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault", MCP_PATCH_STATE_DIR: "/srv/state" }).patchStateDir;
    expect(dir).toBe(path.resolve("/srv/state"));
  });

  it("still resolves an explicit relative MCP_PATCH_STATE_DIR against the cwd", () => {
    // Documented compatibility: only the *default* stopped following the caller.
    // Naming a relative directory stays a deliberate choice that keeps working,
    // so a future tightening of the default cannot silently take it with it.
    const dir = loadConfig({ KNOWLEDGE_ROOT: "/tmp/vault", MCP_PATCH_STATE_DIR: "relative/state" }).patchStateDir;
    expect(dir).toBe(path.resolve("relative/state"));
    expect(dir.startsWith(process.cwd())).toBe(true);
  });
});

describe("server state must live outside the knowledge root", () => {
  const oauthEnv = (root: string, stateFile: string): NodeJS.ProcessEnv => ({
    KNOWLEDGE_ROOT: root,
    MCP_AUTH_TOKEN: "token-for-tests",
    MCP_OAUTH_ENABLED: "1",
    MCP_HTTP_PUBLIC_URL: "https://vault.example",
    MCP_OAUTH_PASSWORD: "correct horse battery staple",
    MCP_OAUTH_STATE_FILE: stateFile
  });

  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-state-vault-")));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-state-outside-")));
  });

  it("rejects an OAuth state file inside the vault and names the root", () => {
    const inside = path.join(root, "notes", "oauth-state.json");
    expect(() => loadHttpConfig(oauthEnv(root, inside))).toThrow(/MCP_OAUTH_STATE_FILE/);
    expect(() => loadHttpConfig(oauthEnv(root, inside))).toThrow(/knowledge root "vault"/);
  });

  it("accepts an OAuth state file outside the vault", () => {
    const target = path.join(outside, "oauth-state.json");
    expect(loadHttpConfig(oauthEnv(root, target)).oauth?.stateFile).toBe(target);
  });

  // The case a string-prefix comparison misses: the configured path shares no
  // prefix with the root, and only resolving the symlinked parent shows that the
  // file would be written into the vault.
  it("rejects a state file reached through a symlink into the vault", async () => {
    await fs.mkdir(path.join(root, "inner"));
    const link = path.join(outside, "link-into-vault");
    await fs.symlink(path.join(root, "inner"), link);

    const through = path.join(link, "oauth-state.json");
    expect(through.startsWith(root)).toBe(false);
    expect(() => loadHttpConfig(oauthEnv(root, through))).toThrow(/knowledge root "vault"/);
  });

  it("rejects a state file inside a read-only secondary root, naming that root", () => {
    const inside = path.join(root, "oauth-state.json");
    const env = oauthEnv(root, inside);
    delete env.KNOWLEDGE_ROOT;
    env.KNOWLEDGE_ROOTS = `primary=${outside},archive=${root}`;
    expect(() => loadHttpConfig(env)).toThrow(/knowledge root "archive"/);
  });

  it("requires the roots to be configured before persistence can be verified", () => {
    const env = oauthEnv(root, path.join(outside, "oauth-state.json"));
    delete env.KNOWLEDGE_ROOT;
    expect(() => loadHttpConfig(env)).toThrow(/KNOWLEDGE_ROOT/);
  });

  // path.relative() returns "..state/oauth.json" for a sibling directory that is
  // merely NAMED with two leading dots, so a startsWith("..") test reads it as an
  // escape and lets a state file inside the vault through.
  it("rejects a directory whose name begins with two dots", () => {
    const inside = path.join(root, "..state", "oauth.json");
    expect(path.relative(root, inside).startsWith("..")).toBe(true);
    expect(() => loadHttpConfig(oauthEnv(root, inside))).toThrow(/knowledge root "vault"/);
  });

  // realpath() reports ENOENT for a DANGLING symlink, so resolving only the
  // existing prefix treats the link as a plain missing component and calls the
  // target outside. Creating the destination later would put every save inside
  // the vault with the boot check already passed.
  it("rejects a state file behind a symlink whose destination does not exist yet", async () => {
    const link = path.join(outside, "link-to-future");
    await fs.symlink(path.join(root, "not-created-yet"), link);
    await expect(fs.realpath(link)).rejects.toThrow();

    expect(() => loadHttpConfig(oauthEnv(root, path.join(link, "oauth.json")))).toThrow(/knowledge root "vault"/);
  });

  // MAX_SYMLINK_HOPS is a changed guard, so it needs an input that reaches it.
  // A cycle must end in a bounded error rather than a boot that never returns.
  it("fails instead of looping when the state path passes through a symlink cycle", async () => {
    const a = path.join(outside, "loop-a");
    const b = path.join(outside, "loop-b");
    await fs.symlink(b, a);
    await fs.symlink(a, b);

    expect(() => loadHttpConfig(oauthEnv(root, path.join(a, "oauth.json")))).toThrow(/Too many symbolic links/);
  });

  // Containment compares filesystem identity when the root exists, and falls back
  // to spelling when it does not. This case takes the fallback — the root is a
  // path that was never created — so the `..`-prefix predicate stays pinned even
  // though every other test in this block now goes through the identity walk.
  it("rejects a two-dot-prefixed directory under a root that does not exist yet", () => {
    const absentRoot = path.join(outside, "never-created");
    expect(() => loadHttpConfig(oauthEnv(absentRoot, path.join(absentRoot, "..state", "oauth.json")))).toThrow(
      /knowledge root "vault"/
    );
    expect(loadHttpConfig(oauthEnv(absentRoot, path.join(outside, "elsewhere.json"))).oauth?.stateFile).toBe(
      path.join(outside, "elsewhere.json")
    );
  });

  // The default is derived from the home directory, which is not automatically
  // outside the vault.
  it("rejects the DEFAULT patch-state directory when a root contains the home directory", () => {
    expect(() => loadConfig({ KNOWLEDGE_ROOT: os.homedir() })).toThrow(/default patch-state directory/);
    expect(() => loadConfig({ KNOWLEDGE_ROOT: os.homedir() })).toThrow(/set MCP_PATCH_STATE_DIR explicitly/);
  });

  it("rejects an explicit patch-state directory inside the vault", () => {
    expect(() => loadConfig({ KNOWLEDGE_ROOT: root, MCP_PATCH_STATE_DIR: path.join(root, ".patches") })).toThrow(
      /MCP_PATCH_STATE_DIR/
    );
    expect(loadConfig({ KNOWLEDGE_ROOT: root, MCP_PATCH_STATE_DIR: path.join(outside, "patches") }).patchStateDir).toBe(
      path.join(outside, "patches")
    );
  });
});
