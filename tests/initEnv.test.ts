import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadEnvFile, loadHttpConfig } from "../src/config.js";
import {
  assertEnvSafeValue,
  assertRoundTrip,
  main,
  renderEnvFile,
  writeEnvFileExclusive,
  type InitIO
} from "../src/initEnv.js";

// `pnpm run init:env` (ROADMAP Onboarding: a guided init that writes the file
// MCP_ENV_FILE names). Each describe block is one guard from the design (G1-G14,
// PR-1: no OAuth). Cases that depend on the real process — the umask, the real
// stdout / stderr, real signals, the working directory — spawn the entrypoint;
// the rest drive `main` in-process with injected streams.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "src", "initEnv.ts");
const tsxLoader = pathToFileURL(path.join(repoRoot, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;
const APP = "claude-openai-mcp-connector";
const FILE = "server.env";
const CTRL_C = String.fromCharCode(3);

let root: string;
let home: string;
let vault: string;

beforeEach(() => {
  // realpath: macOS hands out /var/... for a directory that lives at /private/var/...
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-init-")));
  home = path.join(root, "home");
  vault = path.join(root, "vault");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(vault, { mode: 0o700 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function defaultTarget(): string {
  return path.join(home, ".config", APP, FILE);
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

/** Every entry under `dir`, so a test can say "nothing else was created". */
function listTree(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort();
}

function inProcess(
  lines: string[] | null,
  options: { env?: Record<string, string | undefined>; signals?: EventEmitter; isTTY?: boolean } = {}
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  output.on("data", (chunk) => out.push(String(chunk)));
  error.on("data", (chunk) => err.push(String(chunk)));
  if (lines) {
    input.end(lines.map((line) => `${line}\n`).join(""));
  }
  const io: InitIO = {
    input,
    output,
    error,
    isTTY: options.isTTY ?? false,
    env: options.env ?? { HOME: home },
    signals: options.signals
  };
  return { io, input, stdout: () => out.join(""), stderr: () => err.join("") };
}

async function runInProcess(
  args: string[],
  lines: string[] | null,
  options: { env?: Record<string, string | undefined> } = {}
) {
  const harness = inProcess(lines, options);
  const code = await main(args, harness.io);
  return { code, stdout: harness.stdout(), stderr: harness.stderr() };
}

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(
  args: string[],
  answers: string | null,
  options: {
    env?: Record<string, string | undefined>;
    umask?: string;
    cwd?: string;
    onStdout?: (stdout: string, kill: (signal: NodeJS.Signals) => void) => void;
  } = {}
): Promise<ChildResult> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, ...options.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  // spawn has no umask option. Rather than a shell, a data: URL preload sets it
  // inside the child before the entrypoint loads (no command string is built).
  // That it takes effect is shown by the mutations that drop the chmod calls:
  // only the 0277 case turns red, which it could not if the umask were not set.
  const umaskPreload = options.umask ? ["--import", `data:text/javascript,process.umask(0o${options.umask})`] : [];
  const nodeArgs = ["--import", tsxLoader, ...umaskPreload, entry, ...args];
  const child = spawn(process.execPath, nodeArgs, { cwd: options.cwd ?? root, env, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(stdout, (signal) => child.kill(signal));
    });
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr });
    });
    if (answers !== null) {
      child.stdin.end(answers);
    }
  });
}

function readBack(target: string) {
  const env: NodeJS.ProcessEnv = { MCP_ENV_FILE: target };
  loadEnvFile(env);
  return { env, config: loadConfig(env) };
}

describe("init:env — the file it writes (G10)", () => {
  it("writes a stdio file at the default location that the server reads back", async () => {
    const result = await runInProcess([], [vault, "", "y"]);
    expect(result.code, result.stderr).toBe(0);
    const target = defaultTarget();
    expect(dotenv.parse(fs.readFileSync(target, "utf8"))).toEqual({ KNOWLEDGE_ROOT: vault });
    expect(readBack(target).config.knowledgeRoots).toEqual([{ name: "vault", path: vault }]);
    expect(modeOf(target)).toBe(0o600);
    expect(modeOf(path.dirname(target))).toBe(0o700);
    expect(modeOf(path.join(home, ".config"))).toBe(0o700);
    expect(listTree(path.dirname(target))).toEqual([FILE]);
  });

  it("http: writes a generated bearer token that loadHttpConfig accepts, and never prints it", async () => {
    const result = await runInProcess([], [vault, "http", "", "y"]);
    expect(result.code, result.stderr).toBe(0);
    const target = defaultTarget();
    const parsed = dotenv.parse(fs.readFileSync(target, "utf8"));
    expect(Object.keys(parsed).sort()).toEqual(["KNOWLEDGE_ROOT", "MCP_AUTH_TOKEN", "MCP_HTTP_PORT", "MCP_TRANSPORT"]);
    expect(parsed.MCP_AUTH_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { env } = readBack(target);
    const http = loadHttpConfig(env);
    expect(http.authToken).toBe(parsed.MCP_AUTH_TOKEN);
    expect(http.port).toBe(8787);
    expect(http.allowWrite).toBe(false);
    expect(result.stdout).toContain("MCP_AUTH_TOKEN=(generated; not shown)");
    expect(result.stdout + result.stderr).not.toContain(parsed.MCP_AUTH_TOKEN);
  });

  it("a stdio file passes check:stdio (the live tool surface matches what the file declares)", async () => {
    const result = await runInProcess([], [vault, "stdio", "y"]);
    expect(result.code, result.stderr).toBe(0);
    const check = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(repoRoot, "scripts", "check-stdio.mjs"),
          "--env",
          defaultTarget(),
          "--entry",
          path.join(repoRoot, "src", "index.ts")
        ],
        {
          cwd: repoRoot,
          env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      let output = "";
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (output += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(watchdog);
        resolve({ code, output });
      });
    });
    expect(check.code, check.output).toBe(0);
    // The verdict itself, so an exit status from an earlier failure cannot pass for it.
    expect(check.output).toContain("live surface matches declared flags");
    expect(check.output).toContain("declared: documents=on legacy_create=off skills=off audit=off");
  }, 40_000);
});

describe("init:env — never overwrites (G1)", () => {
  const shapes = ["a file", "a symlink", "a dangling symlink"] as const;

  function plant(target: string, shape: (typeof shapes)[number]): Buffer | string {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (shape === "a file") {
      fs.writeFileSync(target, "KNOWLEDGE_ROOT=/somewhere/else\n", { mode: 0o600 });
      return fs.readFileSync(target);
    }
    const destination = path.join(root, shape === "a symlink" ? "elsewhere.txt" : "not-there-yet.txt");
    if (shape === "a symlink") fs.writeFileSync(destination, "untouched\n");
    fs.symlinkSync(destination, target);
    return fs.readlinkSync(target);
  }

  it.each(shapes)("the command stops before asking when %s is at the target", async (shape) => {
    const target = path.join(root, "out", FILE);
    const before = plant(target, shape);
    const result = await runInProcess(["--out", target], [vault, "", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(result.stdout).not.toContain("Vault location");
    expect(shape === "a file" ? fs.readFileSync(target) : fs.readlinkSync(target)).toEqual(before);
    expect(listTree(path.dirname(target))).toEqual([FILE]);
  });

  it.each(shapes)("the link step refuses %s that appears after the early check", (shape) => {
    const target = path.join(root, "out", FILE);
    const before = plant(target, shape);
    expect(() => writeEnvFileExclusive(target, renderEnvFile([["KNOWLEDGE_ROOT", vault]]))).toThrow(/already exists/);
    expect(shape === "a file" ? fs.readFileSync(target) : fs.readlinkSync(target)).toEqual(before);
    if (shape === "a symlink") {
      expect(fs.readFileSync(path.join(root, "elsewhere.txt"), "utf8")).toBe("untouched\n");
    }
    if (shape === "a dangling symlink") {
      expect(fs.existsSync(path.join(root, "not-there-yet.txt"))).toBe(false);
    }
    expect(listTree(path.dirname(target))).toEqual([FILE]);
  });
});

describe("init:env — permissions (G2)", () => {
  // The open and mkdir modes can only be narrowed by the umask, so only a umask
  // narrower than 0600 / 0700 (0277) shows whether the exact chmod through the
  // descriptor happens; 000 and 022 show that nothing wider gets through.
  it.each(["000", "022", "0277"])(
    "umask %s: the file is 0600 and the directories it creates are 0700",
    async (umask) => {
      const result = await runChild([], `${vault}\nstdio\ny\n`, { umask });
      expect(result.code, result.stderr).toBe(0);
      const target = defaultTarget();
      expect(modeOf(target)).toBe(0o600);
      expect(modeOf(path.dirname(target))).toBe(0o700);
      expect(modeOf(path.join(home, ".config"))).toBe(0o700);
    },
    30_000
  );
});

describe("init:env — paths (G3, G4)", () => {
  it("refuses a relative --out and creates nothing in the working directory", async () => {
    const cwd = path.join(root, "cwd");
    fs.mkdirSync(cwd, { mode: 0o700 });
    const result = await runChild(["--out", path.join("relative", FILE)], `${vault}\nstdio\ny\n`, { cwd });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--out must be an absolute path");
    expect(listTree(cwd)).toEqual([]);
  }, 30_000);

  it("refuses a target inside the vault, and writes nothing there", async () => {
    const before = listTree(vault);
    const result = await runInProcess(["--out", path.join(vault, "config", FILE)], [vault, "", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('resolves inside the knowledge root "vault"');
    expect(listTree(vault)).toEqual(before);
  });

  it("refuses a target under a symlink that points into the vault", async () => {
    fs.symlinkSync(vault, path.join(root, "looks-outside"));
    const result = await runInProcess(["--out", path.join(root, "looks-outside", "sub", FILE)], [vault, "", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('resolves inside the knowledge root "vault"');
    expect(listTree(vault)).toEqual([]);
  });

  it("refuses a case variant of the vault on a case-insensitive filesystem (macOS)", async (context) => {
    const upper = path.join(root, "CaseVault");
    fs.mkdirSync(upper, { mode: 0o700 });
    if (!fs.existsSync(path.join(root, "casevault"))) {
      // Linux CI: the variant is another directory, so the case is not reachable here. Skipped, not passed.
      context.skip();
    }
    const result = await runInProcess(["--out", path.join(root, "casevault", FILE)], [upper, "", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("resolves inside the knowledge root");
    expect(listTree(upper)).toEqual([]);
  });
});

describe("init:env — secrets (G5, F5)", () => {
  it("never prints the token, does not take one from its environment, and keeps the readback error free of it", async () => {
    const fromEnvironment = "token-from-the-environment-0123456789abcdef";
    const result = await runChild([], `${vault}\nhttp\n\ny\n`, { env: { MCP_AUTH_TOKEN: fromEnvironment } });
    expect(result.code, result.stderr).toBe(0);
    const token = dotenv.parse(fs.readFileSync(defaultTarget(), "utf8")).MCP_AUTH_TOKEN;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(fromEnvironment);
    expect(result.stdout + result.stderr).not.toContain(token);

    // The failure path: HOME inside the vault puts the default plan directory
    // inside it, so the server (and so the read-back) refuses the file.
    const insideHome = path.join(vault, "home");
    fs.mkdirSync(insideHome, { mode: 0o700 });
    const out = path.join(root, "second", FILE);
    const failed = await runChild(["--out", out], `${vault}\nhttp\n\ny\n`, { env: { HOME: insideHome } });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("the server would not start with this file");
    expect(failed.stderr).toContain("MCP_PATCH_STATE_DIR");
    const secondToken = dotenv.parse(fs.readFileSync(out, "utf8")).MCP_AUTH_TOKEN;
    expect(failed.stdout + failed.stderr).not.toContain(secondToken);
  }, 40_000);

  it("takes no secret as an argument: unknown options stop, and a positional argument is not echoed", async () => {
    const unknown = await runInProcess(["--token", "abc"], [vault, "", "y"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown option "--token"');
    const positional = await runInProcess(["s3cr3t-looking-value"], [vault, "", "y"]);
    expect(positional.code).toBe(2);
    expect(positional.stderr).not.toContain("s3cr3t-looking-value");
    expect(fs.existsSync(defaultTarget())).toBe(false);
  });
});

describe("init:env — values that read back as written (G8)", () => {
  it.each([
    ["a double quote", 'a"b'],
    ["a backslash", "a\\b"],
    ["a line break", "a\nb"],
    ["a NUL", `a${String.fromCharCode(0)}b`],
    ["a DEL", `a${String.fromCharCode(0x7f)}b`],
    ["leading whitespace", " /vault"],
    ["trailing whitespace", "/vault "],
    ["nothing", ""]
  ])("assertEnvSafeValue refuses %s", (_name, value) => {
    expect(() => assertEnvSafeValue("KNOWLEDGE_ROOT", value)).toThrow(/KNOWLEDGE_ROOT/);
  });

  it("assertRoundTrip refuses bytes that do not parse back to exactly the values", () => {
    const values = [["KNOWLEDGE_ROOT", "/a/b"]] as const;
    expect(() => assertRoundTrip(renderEnvFile(values), values)).not.toThrow();
    expect(() => assertRoundTrip('KNOWLEDGE_ROOT="/a/c"\n', values)).toThrow(/would not read back/);
    expect(() => assertRoundTrip('KNOWLEDGE_ROOT="/a/b"\nEXTRA="1"\n', values)).toThrow(/would not read back/);
  });

  it("a vault path with spaces is written quoted and reads back unchanged", async () => {
    const spaced = path.join(root, "My Vault #1");
    fs.mkdirSync(spaced, { mode: 0o700 });
    const result = await runInProcess([], [spaced, "", "y"]);
    expect(result.code, result.stderr).toBe(0);
    expect(dotenv.parse(fs.readFileSync(defaultTarget(), "utf8"))).toEqual({ KNOWLEDGE_ROOT: spaced });
  });

  it("a vault path with a double quote is refused by the character check, and nothing is written", async () => {
    const quoted = path.join(root, 'odd"name');
    fs.mkdirSync(quoted, { mode: 0o700 });
    const result = await runInProcess([], [quoted]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot carry safely");
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });
});

describe("init:env — failures leave nothing behind (G9, G11)", () => {
  it("a failed write removes the temporary file and publishes nothing", () => {
    const dir = path.join(root, "out");
    fs.mkdirSync(dir, { mode: 0o700 });
    const target = path.join(dir, FILE);
    const original = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === "number") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return (original as (...args: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync);
    expect(() => writeEnvFileExclusive(target, 'KNOWLEDGE_ROOT="/x"\n')).toThrow();
    expect(listTree(dir)).toEqual([]);
  });

  it("a link failure other than EEXIST stops, never falls back to rename or a plain write, and cleans up", async () => {
    const link = vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    const rename = vi.spyOn(fs, "renameSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const result = await runInProcess([], [vault, "", "y"]);
    expect(link).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not publish");
    expect(result.stderr).toContain("EPERM");
    expect(rename).not.toHaveBeenCalled();
    expect(write.mock.calls.every(([file]) => typeof file === "number")).toBe(true);
    // The directories it created for the file are removed again, and no temporary file is left.
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
    expect(listTree(home)).toEqual([]);
  });
});

describe("init:env — the directory that holds the file (G12)", () => {
  it("refuses an existing directory that is a symbolic link", async () => {
    const real = path.join(root, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, path.join(root, "linked"));
    const result = await runInProcess(["--out", path.join(root, "linked", FILE)], [vault, "", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is a symbolic link or not a directory");
    expect(listTree(real)).toEqual([]);
  });

  it("refuses to create under a nearest existing directory that is a symbolic link", async () => {
    const real = path.join(root, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, path.join(root, "linked"));
    const result = await runInProcess(["--out", path.join(root, "linked", "new", FILE)], [vault, "", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The nearest existing directory");
    expect(result.stderr).toContain("is a symbolic link or not a directory");
    expect(listTree(real)).toEqual([]);
  });

  it.each([
    ["group-writable", 0o775],
    ["other-writable", 0o757]
  ])("refuses an existing %s directory and leaves its mode alone", async (_name, mode) => {
    const dir = path.join(root, "shared");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, mode);
    const result = await runInProcess(["--out", path.join(dir, FILE)], [vault, "", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is writable by group or others");
    expect(modeOf(dir)).toBe(mode);
    expect(listTree(dir)).toEqual([]);
  });

  it.each([
    ["group-writable", 0o775],
    ["other-writable", 0o757]
  ])("refuses to create under a %s nearest existing directory", async (_name, mode) => {
    const dir = path.join(root, "shared");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, mode);
    const result = await runInProcess(["--out", path.join(dir, "new", FILE)], [vault, "", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The nearest existing directory");
    expect(result.stderr).toContain("is writable by group or others");
    expect(modeOf(dir)).toBe(mode);
    expect(listTree(dir)).toEqual([]);
  });

  it("refuses a directory owned by another account", async () => {
    // Another uid cannot be created in a test, so the descriptor's stat reports one.
    const original = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const stats = original(fd);
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: stats.uid + 1 });
    }) as typeof fs.fstatSync);
    const dir = path.join(root, "theirs");
    fs.mkdirSync(dir, { mode: 0o700 });
    const result = await runInProcess(["--out", path.join(dir, FILE)], [vault, "", "y"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not to this account");
    expect(listTree(dir)).toEqual([]);
  });
});

describe("init:env — interruption (G13b)", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129]
  ])("%s at a prompt ends the run with %i and writes nothing", async (signal, code) => {
    const signals = new EventEmitter();
    const harness = inProcess(null, { signals });
    const pending = main([], harness.io);
    await vi.waitFor(() => expect(harness.stdout()).toContain("Vault location"));
    signals.emit(signal);
    expect(await pending).toBe(code);
    expect(harness.stderr()).toContain(`interrupted (${signal})`);
    expect(listTree(home)).toEqual([]);
    expect(signals.listenerCount(signal)).toBe(0);
  });

  it("Ctrl-C typed at a terminal prompt (a byte, not a signal, in raw mode) ends the run", async () => {
    const harness = inProcess(null, { isTTY: true });
    const pending = main([], harness.io);
    await vi.waitFor(() => expect(harness.stdout()).toContain("Vault location"));
    harness.input.write(CTRL_C);
    expect(await pending).toBe(130);
    expect(listTree(home)).toEqual([]);
  });

  it("a real SIGTERM to the process is handled, not fatal", async () => {
    let sent = false;
    const result = await runChild([], null, {
      onStdout: (stdout, kill) => {
        if (!sent && stdout.includes("Vault location")) {
          sent = true;
          kill("SIGTERM");
        }
      }
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(143);
    expect(result.stderr).toContain("interrupted (SIGTERM)");
    expect(listTree(home)).toEqual([]);
  }, 30_000);
});

describe("init:env — what it tells the operator (G14)", () => {
  it("stdio: the subdir reservation and the check:stdio line", async () => {
    const result = await runInProcess([], [vault, "", "y"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`"MCP_ENV_FILE": ${JSON.stringify(defaultTarget())}`);
    expect(result.stdout).toContain('Values already in that "env" block win over the file');
    expect(result.stdout).toContain("MCP_AUDIT_SUBDIR or");
    expect(result.stdout).toContain("skills=off or audit=off");
    // Without `--`: pnpm 10 passes the separator through, and check-stdio.mjs
    // stops on it ("Unknown argument: --", measured with pnpm 10.33.0).
    expect(result.stdout).toContain(`pnpm run check:stdio --env ${JSON.stringify(defaultTarget())}`);
    expect(result.stdout).not.toContain("check:stdio -- --env");
  });

  it("http: the launchd reload, the check:http line, and the read-only default", async () => {
    const result = await runInProcess([], [vault, "http", "", "y"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("launchctl bootout gui/$(id -u)/<label>");
    expect(result.stdout).toContain("launchctl bootstrap gui/$(id -u) <plist>");
    expect(result.stdout).toContain("pnpm run check:http");
    expect(result.stdout).toContain("The endpoint is read-only");
  });
});

describe("init:env — the rest of the command", () => {
  it("--help prints the usage and writes nothing", async () => {
    const result = await runInProcess(["--help"], null);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: pnpm run init:env");
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });

  it("accepts the `--` that pnpm 10 passes through from `pnpm run init:env -- …`", async () => {
    const out = path.join(root, "via-separator", FILE);
    const result = await runInProcess(["--", "--out", out], [vault, "", "y"]);
    expect(result.code, result.stderr).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("--out twice is refused", async () => {
    const result = await runInProcess(["--out", path.join(root, "a"), "--out", path.join(root, "b")], null);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--out was given twice");
  });

  it("answering no writes nothing and creates no directory", async () => {
    const result = await runInProcess([], [vault, "", "n"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Nothing was written.");
    expect(listTree(home)).toEqual([]);
  });

  it("re-asks for a vault that is not an existing absolute directory", async () => {
    const result = await runInProcess([], ["relative/vault", path.join(root, "missing"), vault, "", "y"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("must be an absolute path");
    expect(result.stderr).toContain("must be an existing directory");
    expect(dotenv.parse(fs.readFileSync(defaultTarget(), "utf8")).KNOWLEDGE_ROOT).toBe(vault);
  });

  it("stops when input ends before the questions are answered", async () => {
    const result = await runInProcess([], [vault]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("input ended");
    expect(listTree(home)).toEqual([]);
  });

  it("refuses to run on Windows, where the file's permissions cannot be enforced", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true, enumerable: true });
    try {
      const result = await runInProcess([], [vault, "", "y"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Windows is not supported");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(listTree(home)).toEqual([]);
  });

  it("without --out, needs an absolute XDG_CONFIG_HOME or HOME", async () => {
    // No answers: if the relative value were accepted, the run would stop at the
    // first question instead of writing under the working directory.
    const result = await runInProcess([], [], { env: { XDG_CONFIG_HOME: "relative", HOME: undefined } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Pass --out <absolute path>");
  });

  it("reads the file back without this shell's environment, which would otherwise win over it", async () => {
    // A broken KNOWLEDGE_ROOTS here would outrank the file's KNOWLEDGE_ROOT if
    // the read-back used process.env; the server will not see this shell's value.
    vi.stubEnv("KNOWLEDGE_ROOTS", "not a valid entry");
    try {
      const result = await runInProcess([], [vault, "", "y"]);
      expect(result.code, result.stderr).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("an absolute XDG_CONFIG_HOME is used instead of ~/.config", async () => {
    const xdg = path.join(root, "xdg");
    fs.mkdirSync(xdg, { mode: 0o700 });
    const result = await runInProcess([], [vault, "", "y"], { env: { XDG_CONFIG_HOME: xdg, HOME: home } });
    expect(result.code, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(xdg, APP, FILE))).toBe(true);
    expect(fs.existsSync(path.join(home, ".config"))).toBe(false);
  });
});
