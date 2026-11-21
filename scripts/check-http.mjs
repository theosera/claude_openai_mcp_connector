// Authenticated health check for the HTTP MCP connector — two-endpoint aware.
//
// For each endpoint (identified by an `.env` file) it runs the MCP handshake
// (initialize -> notifications/initialized -> tools/list) against
// http://127.0.0.1:<MCP_HTTP_PORT>/mcp with that endpoint's bearer, then
// compares the LIVE tool surface with what the same file's MCP_HTTP_ALLOW_*
// flags DECLARE. The bearer is the file's MCP_AUTH_TOKEN, except that with a
// single endpoint (one --env, or none and the default ./.env) a bearer in the
// environment wins over the file's, as it does for the server; with two or
// more, each endpoint uses only its own file. The bearer is never printed; the
// line saying where it came from is printed before the handshake, so it is
// there even when the endpoint refuses the bearer. Nor is it printed where a
// reply or an error quotes it: every line printed for an endpoint has that
// endpoint's bearer replaced by "[bearer hidden]", and a reply is hidden the
// same way before it is cut short for an error message. The MCP
// session is always terminated (authenticated DELETE) so repeated/scheduled
// runs do not leak server-side transports, and every request is bounded by a
// timeout so a wedged endpoint fails instead of hanging.
//
// This is the operator-side check for the interactive + scan split documented
// in operations.md §9: the scan endpoint must expose the audit tools and NO
// general/skill write tools, so an injected scanner has nothing to write with.
//
// Exit status:
//   0  every endpoint reachable AND no surface WIDER than its declared flags
//   1  a live surface is WIDER than declared (a security regression — e.g. the
//      scan endpoint exposing general write, OR an unrecognized write-capable
//      tool not permitted by any enabled category), or an endpoint is
//      unreachable / times out / auth / protocol error.
//
// A surface NARROWER than declared (a write flag on but the tool missing) is a
// WARNING, not a failure: narrower never widens the security surface.
//
// Usage:
//   node scripts/check-http.mjs [--env <path>]...
//   pnpm run check:http --env ./.env --env /abs/path/to/scan-dir/.env
// With no --env, a single ./.env (the interactive endpoint) is checked.
// MCP_CHECK_TIMEOUT_MS (default 10000) bounds each HTTP request.

import path from "node:path";
import { parseEnvFile, parsePort, isTruthy, resolveBearer, hideBearer, repoRoot } from "./repo-env.mjs";
import {
  AUDIT_WRITE_TOOLS,
  GENERAL_WRITE_TOOLS,
  LEGACY_CREATE_TOOLS,
  SKILL_WRITE_TOOLS,
  checkTimeoutMs,
  classifySurface
} from "./surface.mjs";

const TIMEOUT_MS = checkTimeoutMs();

const USAGE = `Usage: node scripts/check-http.mjs [--env <path>]...

Checks each endpoint's local /mcp handshake and verifies the live tool surface
against that endpoint's MCP_HTTP_ALLOW_* flags. Defaults to ./.env when no
--env is given. Tokens are read from the .env files and, when one endpoint is
checked, from the environment, which wins over the file; they are never printed.
MCP_CHECK_TIMEOUT_MS (default 10000) bounds each request.`;

function parseArgs(argv) {
  const envPaths = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env") {
      const value = argv[++i];
      if (!value) throw new Error("--env requires a path argument.");
      envPaths.push(value);
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  if (envPaths.length === 0) envPaths.push(path.join(repoRoot, ".env"));
  return envPaths;
}

function rpcBody(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

// The Streamable HTTP transport replies with an SSE frame; a plain JSON body is
// also tolerated so the check does not break if that ever changes. `hide` runs
// over a reply before it is cut short for an error message, so the cut cannot
// leave part of the bearer behind. JSON.parse's own error is not passed on,
// because it quotes part of its input, the bearer included.
function parseRpcPayload(text, hide) {
  const trimmed = text.trim();
  const json = trimmed.startsWith("{")
    ? trimmed
    : text
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length)
        .trim();
  if (json === undefined) {
    throw new Error(`response contained neither JSON nor an SSE data event: ${hide(text).slice(0, 300)}`);
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`response was not valid JSON: ${hide(json).slice(0, 300)}`);
  }
}

async function checkEndpoint(envPath, endpointCount, selected) {
  const { resolved, env } = parseEnvFile(envPath);
  const port = parsePort(env.MCP_HTTP_PORT, resolved);
  const bearer = resolveBearer(env, resolved, endpointCount);
  const token = bearer.token;
  // The loop below prints every other line for this endpoint with this value
  // hidden. `hide` is for the two lines printed here, and for the places that
  // cut a reply short first.
  selected.token = token;
  const hide = (text) => hideBearer(text, token);
  // Before the handshake, so a refused bearer still says where it came from,
  // and that the environment's value differed from the file's.
  console.log(hide(`  bearer:   from ${bearer.source}`));
  if (bearer.warning) console.log(hide(`  WARN:     ${bearer.warning}`));
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const authHeader = { Authorization: `Bearer ${token}` };
  const postHeaders = {
    ...authHeader,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };

  async function post(body, sessionId) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: sessionId ? { ...postHeaders, "mcp-session-id": sessionId } : postHeaders,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`POST ${endpoint} -> HTTP ${response.status}: ${hide(text).slice(0, 300)}`);
    }
    return { response, text };
  }

  let sessionId;
  try {
    const init = await post(
      rpcBody(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "repo-http-check", version: "1" }
      })
    );
    const initPayload = parseRpcPayload(init.text, hide);
    if (initPayload.error) throw new Error(`initialize failed: ${JSON.stringify(initPayload.error)}`);

    // The /mcp endpoint is sessionless: `createMcpHandler` with
    // `legacy: 'stateless'` serves both protocol eras per request, so NEITHER
    // era issues an `mcp-session-id` and `tools/list` works as a standalone
    // POST. Requiring the header here turned a healthy server into a hard FAIL
    // — the same runbook-vs-server drift that operations.md §9 already fixed.
    // Read it so a peer that still sets one keeps working, but never demand it.
    sessionId = init.response.headers.get("mcp-session-id") ?? undefined;

    await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }), sessionId);

    const listed = await post(rpcBody(2, "tools/list"), sessionId);
    const listPayload = parseRpcPayload(listed.text, hide);
    if (listPayload.error) throw new Error(`tools/list failed: ${JSON.stringify(listPayload.error)}`);

    const tools = listPayload.result?.tools;
    if (!Array.isArray(tools)) throw new Error("tools/list returned no tools array.");

    const declared = {
      generalWrite: isTruthy(env.MCP_HTTP_ALLOW_WRITE),
      // Both flags, because the tool needs both to be registered.
      legacyCreate: isTruthy(env.MCP_HTTP_ALLOW_WRITE) && isTruthy(env.MCP_ALLOW_LEGACY_CREATE_DOCUMENT),
      skillWrite: isTruthy(env.MCP_HTTP_ALLOW_SKILL_WRITE),
      auditWrite: isTruthy(env.MCP_HTTP_ALLOW_AUDIT_WRITE)
    };
    const categories = [
      { key: "general document write", tools: GENERAL_WRITE_TOOLS, declared: declared.generalWrite },
      { key: "legacy create_document", tools: LEGACY_CREATE_TOOLS, declared: declared.legacyCreate },
      { key: "skill write", tools: SKILL_WRITE_TOOLS, declared: declared.skillWrite },
      { key: "audit write", tools: AUDIT_WRITE_TOOLS, declared: declared.auditWrite }
    ];

    // Shared with check-stdio.mjs: a surface WIDER than the flags declare —
    // including an unrecognized write-capable tool — fails closed; a narrower
    // one only warns.
    const { readOnly, writeCapable, failures, warnings } = classifySurface(tools, categories);

    const serverInfo = initPayload.result?.serverInfo ?? {};
    return {
      envPath: resolved,
      endpoint,
      publicUrl: env.MCP_HTTP_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined,
      server: `${serverInfo.name ?? "unknown"} ${serverInfo.version ?? ""}`.trimEnd(),
      protocol: initPayload.result?.protocolVersion ?? "unknown",
      toolCount: tools.length,
      readOnly,
      writeCapable: writeCapable.length,
      declared,
      failures,
      warnings
    };
  } finally {
    // Best-effort session teardown so scheduled/repeated checks don't leak a
    // server-side transport (the server frees it on transport close).
    if (sessionId) {
      try {
        await fetch(endpoint, {
          method: "DELETE",
          headers: { ...authHeader, "mcp-session-id": sessionId },
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });
      } catch {
        // ignore — teardown is best-effort and must not mask the check result
      }
    }
  }
}

const envPaths = parseArgs(process.argv.slice(2));
let hadFailure = false;

for (const envPath of envPaths) {
  console.log(`\n== ${envPath} ==`);
  // Holds the endpoint's bearer once it is chosen. Every line below is printed
  // with it hidden, whatever the endpoint sent back or an error quoted.
  const selected = { token: undefined };
  const say = (line) => console.log(hideBearer(line, selected.token));
  try {
    const r = await checkEndpoint(envPath, envPaths.length, selected);
    const flagsSummary = `write=${r.declared.generalWrite ? "on" : "off"} legacy_create=${
      r.declared.legacyCreate ? "on" : "off"
    } skill=${r.declared.skillWrite ? "on" : "off"} audit=${r.declared.auditWrite ? "on" : "off"}`;
    say(`  local:    ${r.endpoint}`);
    if (r.publicUrl) say(`  public:   ${r.publicUrl}/mcp`);
    say(`  server:   ${r.server}`);
    say(`  protocol: ${r.protocol}`);
    say(`  declared: ${flagsSummary}`);
    say(`  tools:    ${r.toolCount} (${r.readOnly} read-only, ${r.writeCapable} write-capable)`);
    for (const warning of r.warnings) say(`  WARN:     ${warning}`);
    if (r.failures.length === 0) {
      say("  RESULT:   OK — live surface matches declared flags (not wider).");
    } else {
      hadFailure = true;
      for (const failure of r.failures) say(`  FAIL:     ${failure}`);
    }
  } catch (error) {
    hadFailure = true;
    const message =
      error?.name === "TimeoutError"
        ? `no response within ${TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    say(`  FAIL:     ${message}`);
  }
}

console.log("");
if (hadFailure) {
  console.log("check:http FAILED — see FAIL lines above.");
  process.exitCode = 1;
} else {
  console.log(`check:http OK — ${envPaths.length} endpoint(s) verified.`);
}
