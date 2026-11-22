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
 *   exit 0;
 * - send a bearer that holds a control character: only the two "line break in
 *   the ... bearer" tests, which no longer find the refusal message.
 * Mutations in `scripts/check-http.mjs`: printing the bearer line only after a
 * successful handshake (as the first version of this change did) turns only
 * "prints the bearer line before the handshake fails" red, with no bearer line;
 * putting the differ WARN back among the surface warnings, printed only after a
 * successful handshake, turns only that same test red, with no WARN line.
 *
 * Mutations against the tests that keep endpoints apart ("keeps endpoints apart
 * and does not fall back from a refused bearer"):
 * - read the environment with two or more endpoints: the first test, both rows
 *   of the line-break test, both rows of the HTTP-refusal test, and "stops on an
 *   endpoint whose file has no bearer";
 * - fall back to the file when the environment's bearer is refused: only the
 *   test that runs the check through a parent process;
 * - stop at the first endpoint that fails: the "first" row of the line-break
 *   test, both rows of the HTTP-refusal test, and "stops on an endpoint whose
 *   file has no bearer";
 * - retry a refused request with the environment's bearer: only the two rows of
 *   the HTTP-refusal test.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(repoRoot, "scripts", "check-http.mjs");
const BEARER = "MCP_AUTH_TOKEN";

// Name tags, not credentials. Each is distinct so any leak or mix-up says
// which source it came from.
const FROM_ENVIRONMENT = "x".repeat(32);
const FROM_FILE = "y".repeat(32);
const FROM_OTHER_FILE = "z".repeat(32);
const FROM_THIRD_FILE = "w".repeat(32);
const ALL_VALUES = [FROM_ENVIRONMENT, FROM_FILE, FROM_OTHER_FILE, FROM_THIRD_FILE];
// Each value is one letter repeated, so these are what any eight characters cut
// from one of them look like.
const PIECES = ALL_VALUES.map((value) => value.slice(0, 8));
/** What check:http prints where the bearer was. */
const HIDDEN = "[bearer hidden]";

interface Reply {
  status: number;
  body: string;
}

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

/**
 * `reply`, when it returns a reply for a POST, is sent instead of the
 * handshake's; it gets the bearer the stub received, so it can quote it back.
 */
async function startStub(
  options: { refuse?: boolean; reply?: (bearer: string, method: string) => Reply | undefined } = {}
): Promise<Stub> {
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
      const reply = options.reply?.((req.headers.authorization ?? "").replace(/^Bearer /, ""), message.method);
      if (reply) {
        res.writeHead(reply.status).end(reply.body);
        return;
      }
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

/** What check:http printed for the endpoint whose file is `file`, up to the next endpoint's heading. */
function blockOf(output: string, file: string): string {
  const start = output.indexOf(`== ${file} ==`);
  if (start < 0) return "";
  const next = output.indexOf("\n== ", start + 1);
  return output.slice(start, next < 0 ? undefined : next);
}

/**
 * Runs the check the way a launcher does: a parent process gets an explicit
 * environment from the test (so nothing from the shell reaches it) and starts
 * the check without passing an environment, so the check inherits the parent's.
 */
async function runThroughParent(
  files: string[],
  bearerInParent: string
): Promise<{ code: number | null; output: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-check-http-parent-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const parent = path.join(dir, "parent.mjs");
  await fs.writeFile(
    parent,
    [
      'import { spawn } from "node:child_process";',
      "const [script, ...args] = process.argv.slice(2);",
      'spawn(process.execPath, [script, ...args], { stdio: "inherit" }).on("close", (code) => process.exit(code ?? 1));',
      ""
    ].join("\n"),
    "utf8"
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MCP_CHECK_TIMEOUT_MS: "5000",
    [BEARER]: bearerInParent
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [parent, SCRIPT, ...files.flatMap((file) => ["--env", file])], {
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
    // The two values differ, which is the likeliest reason for the 401, so the
    // WARN that says so must be there too.
    const warnLines = output.split("\n").filter((line) => line.includes("WARN:"));
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toContain(`differs from ${file}; using the environment`);
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

describe("check:http refuses a bearer that holds a control character", () => {
  // fetch rejects a header value with a line break in it, and its error quotes
  // the whole value; the check prints that error on its FAIL line. So the
  // bearer is refused before it is used, naming only where it came from.
  it("stops on a line break in the environment's bearer, without sending or printing it", async () => {
    const stub = await startStub();
    const file = await writeEndpointFile(stub.port);

    const { code, output } = await runCheck([file], `${FROM_ENVIRONMENT}\n${FROM_ENVIRONMENT}`);

    expect(code).toBe(1);
    expect(output).toContain(`${BEARER} from the environment contains a control character`);
    expect(stub.seen).toEqual([]);
    expect(leaked(output, ALL_VALUES)).toEqual([]);
  });

  it("stops on a line break in the file's bearer, without sending or printing it", async () => {
    const stub = await startStub();
    // dotenv turns `\n` inside a double-quoted value into a real line break.
    const file = await writeEndpointFile(stub.port, `"${FROM_FILE}\\n${FROM_FILE}"`);

    const { code, output } = await runCheck([file]);

    expect(code).toBe(1);
    expect(output).toContain(`${BEARER} from ${file} contains a control character`);
    expect(stub.seen).toEqual([]);
    expect(leaked(output, ALL_VALUES)).toEqual([]);
  });
});

describe("check:http hides the bearer wherever an endpoint's reply quotes it", () => {
  // Each stub quotes back the bearer it received. The check still names the
  // stage that failed, with "[bearer hidden]" where the value was: finding that
  // marker shows the quoted value reached the output, and no eight characters of
  // any value may be left beside it.

  it("in the body of an HTTP error, where the 300-character cut falls inside the bearer", async () => {
    // One copy at the start, and one that the cut would split.
    const stub = await startStub({
      reply: (bearer) => ({ status: 401, body: `${bearer}${"-".repeat(280 - bearer.length)}${bearer}` })
    });
    const file = await writeEndpointFile(stub.port, FROM_FILE);

    const { code, output } = await runCheck([file]);

    expect(code).toBe(1);
    expect(new Set(stub.seen)).toEqual(new Set([`Bearer ${FROM_FILE}`]));
    expect(output).toContain("HTTP 401");
    expect(output).toContain(HIDDEN);
    expect(leaked(output, PIECES)).toEqual([]);
  });

  it.each([
    ["as sent", undefined],
    // A JSON string quotes `"` and `\` with a backslash, so the copy the check
    // prints differs from the bearer it sent.
    ["as a JSON string quotes it", `${"x".repeat(16)}"\\${"x".repeat(16)}`]
  ])("in a JSON-RPC error, %s", async (_, bearerInEnvironment) => {
    const stub = await startStub({
      reply: (bearer, method) =>
        method === "initialize"
          ? {
              status: 200,
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "refused", data: bearer } })
            }
          : undefined
    });
    const file = await writeEndpointFile(stub.port, FROM_FILE);

    const { code, output } = await runCheck([file], bearerInEnvironment);

    expect(code).toBe(1);
    expect(new Set(stub.seen)).toEqual(new Set([`Bearer ${bearerInEnvironment ?? FROM_FILE}`]));
    expect(output).toContain("initialize failed");
    expect(output).toContain(HIDDEN);
    expect(leaked(output, PIECES)).toEqual([]);
  });

  it("in a reply that is neither JSON nor an SSE event, where the cut falls inside the bearer", async () => {
    const stub = await startStub({
      reply: (bearer, method) =>
        method === "initialize" ? { status: 200, body: `${"-".repeat(280)}${bearer}` } : undefined
    });
    const file = await writeEndpointFile(stub.port, FROM_FILE);

    const { code, output } = await runCheck([file]);

    expect(code).toBe(1);
    expect(new Set(stub.seen)).toEqual(new Set([`Bearer ${FROM_FILE}`]));
    expect(output).toContain("neither JSON nor an SSE data event");
    expect(output).toContain(HIDDEN);
    expect(leaked(output, PIECES)).toEqual([]);
  });

  it("in a reply that is not valid JSON", async () => {
    const stub = await startStub({
      reply: (bearer, method) => (method === "initialize" ? { status: 200, body: `{"echo": ${bearer}}` } : undefined)
    });
    const file = await writeEndpointFile(stub.port, FROM_FILE);

    const { code, output } = await runCheck([file]);

    expect(code).toBe(1);
    expect(new Set(stub.seen)).toEqual(new Set([`Bearer ${FROM_FILE}`]));
    expect(output).toContain("response was not valid JSON");
    expect(output).toContain(HIDDEN);
    expect(leaked(output, PIECES)).toEqual([]);
  });
});

describe("check:http keeps endpoints apart and does not fall back from a refused bearer", () => {
  // Each test runs two or three endpoints, or one endpoint behind a parent process,
  // and checks, for every endpoint, which bearer its stub received (and that it
  // received one, where it should, so an empty result cannot pass by itself),
  // what the output says, and that no eight characters of any value are in it.

  it("checks each endpoint on its own file's bearer and ignores a broken one in the environment", async () => {
    const interactive = await startStub();
    const scan = await startStub();
    const interactiveFile = await writeEndpointFile(interactive.port, FROM_FILE);
    const scanFile = await writeEndpointFile(scan.port, FROM_OTHER_FILE);

    const { code, output } = await runCheck([interactiveFile, scanFile], `${FROM_ENVIRONMENT}\n${FROM_ENVIRONMENT}`);

    expect(code).toBe(0);
    expect(interactive.seen.length).toBeGreaterThan(0);
    expect(new Set(interactive.seen)).toEqual(new Set([`Bearer ${FROM_FILE}`]));
    expect(scan.seen.length).toBeGreaterThan(0);
    expect(new Set(scan.seen)).toEqual(new Set([`Bearer ${FROM_OTHER_FILE}`]));
    expect(output).toContain(`bearer:   from ${interactiveFile}`);
    expect(output).toContain(`bearer:   from ${scanFile}`);
    expect(output).not.toContain("bearer:   from environment");
    expect(output).not.toContain("contains a control character");
    expect(leaked(output, PIECES)).toEqual([]);
  });

  it.each([
    // dotenv turns `\n` and `\r` inside a double-quoted value into real line breaks.
    ["the first", 0, `"${FROM_FILE}\\n${FROM_FILE}"`],
    ["the last", 1, `"${FROM_OTHER_FILE}\\r\\n${FROM_OTHER_FILE}"`]
  ])(
    "stops on %s endpoint when its file's bearer holds a line break, and checks the other on its own bearer",
    async (_, broken, brokenValue) => {
      const good = [FROM_FILE, FROM_OTHER_FILE];
      const stubs = [await startStub(), await startStub()];
      const files = [
        await writeEndpointFile(stubs[0].port, broken === 0 ? brokenValue : good[0]),
        await writeEndpointFile(stubs[1].port, broken === 1 ? brokenValue : good[1])
      ];
      const other = 1 - broken;

      const { code, output } = await runCheck(files, FROM_ENVIRONMENT);

      expect(code).toBe(1);
      expect(stubs[broken].seen).toEqual([]);
      expect(blockOf(output, files[broken])).toContain(`${BEARER} from ${files[broken]} contains a control character`);
      expect(stubs[other].seen.length).toBeGreaterThan(0);
      expect(new Set(stubs[other].seen)).toEqual(new Set([`Bearer ${good[other]}`]));
      expect(blockOf(output, files[other])).toContain(`bearer:   from ${files[other]}`);
      expect(blockOf(output, files[other])).toContain("RESULT:   OK");
      expect(leaked(output, PIECES)).toEqual([]);
    }
  );

  it("refuses a broken bearer the check inherits from its parent, without falling back to the file", async () => {
    const stub = await startStub();
    const file = await writeEndpointFile(stub.port, FROM_FILE);

    const { code, output } = await runThroughParent([file], `${FROM_ENVIRONMENT}\r\n${FROM_ENVIRONMENT}`);

    expect(code).toBe(1);
    expect(stub.seen).toEqual([]);
    expect(output).toContain(`${BEARER} from the environment contains a control character`);
    expect(output).not.toContain(`bearer:   from ${file}`);
    expect(leaked(output, PIECES)).toEqual([]);
  });

  it.each([
    [401, '{"error":"unauthorized"}'],
    [403, '{"error":"insufficient_scope","scope":"vault.read"}']
  ])(
    "reports an HTTP %i from one endpoint that got only its own file's bearer, once, and checks the other on its own",
    async (status, body) => {
      // Every POST the refusing endpoint answered, with the bearer it carried.
      const answered: Array<[string, string]> = [];
      const refusing = await startStub({
        reply: (bearer, method) => {
          answered.push([bearer, method]);
          return { status, body };
        }
      });
      const other = await startStub();
      const refusingFile = await writeEndpointFile(refusing.port, FROM_FILE);
      const otherFile = await writeEndpointFile(other.port, FROM_OTHER_FILE);

      const { code, output } = await runCheck([refusingFile, otherFile], FROM_ENVIRONMENT);

      expect(code).toBe(1);
      // One request in all, not only one bearer: the refused initialize is not
      // sent again, even with the same bearer, and nothing follows it.
      expect(refusing.seen).toEqual([`Bearer ${FROM_FILE}`]);
      expect(answered).toEqual([[FROM_FILE, "initialize"]]);
      expect(other.seen.length).toBeGreaterThan(0);
      expect(new Set(other.seen)).toEqual(new Set([`Bearer ${FROM_OTHER_FILE}`]));
      const refused = blockOf(output, refusingFile);
      expect(refused).toContain(`HTTP ${status}`);
      const sourceLine = refused.indexOf(`bearer:   from ${refusingFile}`);
      expect(sourceLine).toBeGreaterThanOrEqual(0);
      expect(sourceLine).toBeLessThan(refused.indexOf("FAIL:"));
      expect(blockOf(output, otherFile)).toContain("RESULT:   OK");
      expect(leaked(output, PIECES)).toEqual([]);
    }
  );

  it("checks the endpoint after a refused middle one, with three endpoints and a valid bearer in the environment", async () => {
    const first = await startStub();
    const middle = await startStub({ reply: () => ({ status: 401, body: '{"error":"unauthorized"}' }) });
    const last = await startStub();
    const firstFile = await writeEndpointFile(first.port, FROM_FILE);
    const middleFile = await writeEndpointFile(middle.port, FROM_OTHER_FILE);
    const lastFile = await writeEndpointFile(last.port, FROM_THIRD_FILE);

    const { code, output } = await runCheck([firstFile, middleFile, lastFile], FROM_ENVIRONMENT);

    expect(code).toBe(1);
    expect(first.seen.length).toBeGreaterThan(0);
    expect(new Set(first.seen)).toEqual(new Set([`Bearer ${FROM_FILE}`]));
    expect(middle.seen).toEqual([`Bearer ${FROM_OTHER_FILE}`]);
    expect(last.seen.length).toBeGreaterThan(0);
    expect(new Set(last.seen)).toEqual(new Set([`Bearer ${FROM_THIRD_FILE}`]));
    expect(blockOf(output, firstFile)).toContain("RESULT:   OK");
    expect(blockOf(output, middleFile)).toContain("HTTP 401");
    expect(blockOf(output, lastFile)).toContain(`bearer:   from ${lastFile}`);
    expect(blockOf(output, lastFile)).toContain("RESULT:   OK");
    expect(output).not.toContain("bearer:   from environment");
    expect(leaked(output, PIECES)).toEqual([]);
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

  // And for `leaked(output, PIECES)`: ten characters cut from a value, as a
  // 300-character cut or a parser's error can leave them, are found.
  it("finds a piece cut from a value", () => {
    expect(leaked(`cut: ${FROM_FILE.slice(0, 10)}`, PIECES)).toEqual([FROM_FILE.slice(0, 8)]);
    expect(leaked(`cut: ${FROM_ENVIRONMENT.slice(0, 10)}`, PIECES)).toEqual([FROM_ENVIRONMENT.slice(0, 8)]);
  });
});
