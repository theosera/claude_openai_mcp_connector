import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/check-http.mjs` takes the bearer from the environment as well as
 * from the endpoint's file: with a single `--env` the environment wins, as it
 * does for the server; with two or more, each endpoint uses only its own file.
 *
 * Each test runs the real script as a child process against a stub endpoint on
 * 127.0.0.1 that records the Authorization header it receives and answers the
 * handshake with an empty tool list. The child gets an explicit environment,
 * so a bearer in the shell that runs the tests cannot reach it.
 *
 * Mutations run against `resolveBearer` in `scripts/repo-env.mjs`, with the
 * tests that went red and why:
 * - never read the environment: "file has no bearer line" exits 1, "over the
 *   file" sends the file's value, "no WARN when both match" says the bearer
 *   came from the file;
 * - let the file win when both hold a value: "over the file" sends the file's
 *   value, "no WARN when both match" says the bearer came from the file;
 * - read the environment with two or more endpoints: only "stops on an endpoint
 *   whose file has no bearer", which exits 0;
 * - warn even when the two values match: only "no WARN when both match", which
 *   prints a WARN line;
 * - return an empty bearer instead of stopping: "stops when neither holds a
 *   bearer" and "stops on an endpoint whose file has no bearer", which both
 *   exit 0.
 * A mutation in `scripts/check-http.mjs`, printing the bearer line only after a
 * successful handshake (as the first version of this change did), turns only
 * "prints the bearer line before the handshake fails" red, with no bearer line.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(repoRoot, "scripts", "check-http.mjs");
const BEARER = "MCP_AUTH_TOKEN";

// Name tags, not credentials. Each is distinct so any leak or mix-up says
// which source it came from.
const FROM_ENVIRONMENT = "x".repeat(32);
const FROM_FILE = "y".repeat(32);
const FROM_OTHER_FILE = "z".repeat(32);
const ALL_VALUES = [FROM_ENVIRONMENT, FROM_FILE, FROM_OTHER_FILE];

interface Stub {
  port: number;
  seen: string[];
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startStub(options: { refuse?: boolean } = {}): Promise<Stub> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      if (options.refuse) {
        res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"unauthorized"}');
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(200).end();
        return;
      }
      const message = JSON.parse(raw) as { id?: number; method: string };
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "0" } }
          : { tools: [] };
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stub: Stub = {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
  cleanups.push(stub.close);
  return stub;
}

async function writeEndpointFile(port: number, bearer?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-check-http-bearer-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "endpoint.env");
  const lines = [`MCP_HTTP_PORT=${port}`];
  if (bearer !== undefined) lines.push(`${BEARER}=${bearer}`);
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

function runCheck(files: string[], bearerInEnvironment?: string): Promise<{ code: number | null; output: string }> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, MCP_CHECK_TIMEOUT_MS: "5000" };
  if (bearerInEnvironment !== undefined) env[BEARER] = bearerInEnvironment;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...files.flatMap((file) => ["--env", file])], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** The values from `values` that appear anywhere in `text`. */
function leaked(text: string, values: string[]): string[] {
  return values.filter((value) => text.includes(value));
}

describe("check:http reads the bearer from the environment with a single --env", () => {
  it("uses the environment when the file has no bearer line", async () => {
    const stub = await startStub();
    const file = await writeEndpointFile(stub.port);

    const { code, output } = await runCheck([file], FROM_ENVIRONMENT);

    expect(code).toBe(0);
    expect(stub.seen.length).toBeGreaterThan(0);
    expect(new Set(stub.seen)).toEqual(new Set([`Bearer ${FROM_ENVIRONMENT}`]));
    expect(output).toContain("bearer:   from environment");
    expect(output).not.toContain("WARN:");
    expect(leaked(output, ALL_VALUES)).toEqual([]);
  });

  it("uses the environment over the file when both hold a different value, with one WARN line", async () => {
    const stub = await startStub();
    const file = await writeEndpointFile(stub.port, FROM_FILE);

    const { code, output } = await runCheck([file], FROM_ENVIRONMENT);

    expect(code).toBe(0);
    expect(stub.seen.length).toBeGreaterThan(0);
    expect(new Set(stub.seen)).toEqual(new Set([`Bearer ${FROM_ENVIRONMENT}`]));
    expect(output).toContain("bearer:   from environment");
    const warnLines = output.split("\n").filter((line) => line.includes("WARN:"));
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toContain(`differs from ${file}; using the environment`);
    expect(leaked(output, ALL_VALUES)).toEqual([]);
  });

  it("uses the environment with no WARN when both match", async () => {
    const stub = await startStub();
    const file = await writeEndpointFile(stub.port, FROM_ENVIRONMENT);

    const { code, output } = await runCheck([file], FROM_ENVIRONMENT);

    expect(code).toBe(0);
    expect(stub.seen.length).toBeGreaterThan(0);
    expect(new Set(stub.seen)).toEqual(new Set([`Bearer ${FROM_ENVIRONMENT}`]));
    expect(output).toContain("bearer:   from environment");
    expect(output).not.toContain("WARN:");
    expect(leaked(output, ALL_VALUES)).toEqual([]);
  });

  it("stops when neither holds a bearer", async () => {
    const stub = await startStub();
    const file = await writeEndpointFile(stub.port);

    const { code, output } = await runCheck([file]);

    expect(code).toBe(1);
    expect(output).toContain(`${BEARER} must be configured in ${file} or (with a single endpoint) the environment.`);
    expect(stub.seen).toEqual([]);
  });
});

describe("check:http says where the bearer came from even when it is refused", () => {
  it("prints the bearer line before the handshake fails", async () => {
    const stub = await startStub({ refuse: true });
    const file = await writeEndpointFile(stub.port, FROM_FILE);

    const { code, output } = await runCheck([file], FROM_ENVIRONMENT);

    expect(code).toBe(1);
    expect(stub.seen.length).toBeGreaterThan(0);
    expect(new Set(stub.seen)).toEqual(new Set([`Bearer ${FROM_ENVIRONMENT}`]));
    expect(output).toContain("HTTP 401");
    expect(output).toContain("bearer:   from environment");
    expect(leaked(output, ALL_VALUES)).toEqual([]);
  });
});

describe("check:http keeps each endpoint to its own file with two or more --env", () => {
  it("stops on an endpoint whose file has no bearer, without using the environment", async () => {
    const interactive = await startStub();
    const scan = await startStub();
    const interactiveFile = await writeEndpointFile(interactive.port);
    const scanFile = await writeEndpointFile(scan.port, FROM_OTHER_FILE);

    const { code, output } = await runCheck([interactiveFile, scanFile], FROM_ENVIRONMENT);

    expect(code).toBe(1);
    expect(output).toContain(`${BEARER} must be configured in ${interactiveFile}`);
    // The endpoint without a bearer was never contacted, so the environment
    // value went nowhere.
    expect(interactive.seen).toEqual([]);
    // The other endpoint ran on its own file's bearer.
    expect(scan.seen.length).toBeGreaterThan(0);
    expect(new Set(scan.seen)).toEqual(new Set([`Bearer ${FROM_OTHER_FILE}`]));
    expect(output).toContain(`bearer:   from ${scanFile}`);
    expect(leaked(output, ALL_VALUES)).toEqual([]);
  });
});

describe("the leak check can see a value", () => {
  // Positive control for the `leaked(output, ALL_VALUES)` assertions above: the
  // same function finds a value in text that carries it, so their empty result
  // means the output had none, not that the check cannot match.
  it("finds a value embedded in text", () => {
    expect(leaked(`before ${FROM_ENVIRONMENT} after`, ALL_VALUES)).toEqual([FROM_ENVIRONMENT]);
    expect(leaked(`a ${FROM_FILE}\nb ${FROM_OTHER_FILE}`, ALL_VALUES)).toEqual([FROM_FILE, FROM_OTHER_FILE]);
  });
});
