// Authenticated health check for the HTTP MCP connector — two-endpoint aware.
//
// For each endpoint (identified by an `.env` file) it runs the MCP handshake
// (initialize -> notifications/initialized -> tools/list) against
// http://127.0.0.1:<MCP_HTTP_PORT>/mcp using that file's MCP_AUTH_TOKEN, then
// compares the LIVE tool surface with what the same file's MCP_HTTP_ALLOW_*
// flags DECLARE. The bearer token is read from disk and never printed.
//
// This is the operator-side check for the interactive + scan split documented
// in operations.md §9: the scan endpoint must expose the audit tools and NO
// general/skill write tools, so an injected scanner has nothing to write with.
//
// Exit status:
//   0  every endpoint reachable AND no surface WIDER than its declared flags
//   1  a live surface is WIDER than declared (a security regression — e.g. the
//      scan endpoint exposing general write), or an endpoint is unreachable /
//      auth / protocol error.
//
// A surface NARROWER than declared (a write flag on but the tool missing) is a
// WARNING, not a failure: narrower never widens the security surface.
//
// Usage:
//   node scripts/check-http.mjs [--env <path>]...
//   pnpm run check:http -- --env ./.env --env /abs/path/to/scan-dir/.env
// With no --env, a single ./.env (the interactive endpoint) is checked.

import path from "node:path";
import { parseEnvFile, parsePort, isTruthy, requiredEnv, repoRoot } from "./repo-env.mjs";

const GENERAL_WRITE_TOOLS = [
  "create_document",
  "plan_document_create",
  "apply_planned_document_create",
  "plan_document_update",
  "apply_planned_update"
];
const SKILL_WRITE_TOOLS = ["plan_skill_create", "apply_planned_skill_create"];
const AUDIT_WRITE_TOOLS = ["append_audit_report", "compare_and_swap_audit_state"];

const USAGE = `Usage: node scripts/check-http.mjs [--env <path>]...

Checks each endpoint's local /mcp handshake and verifies the live tool surface
against that endpoint's MCP_HTTP_ALLOW_* flags. Defaults to ./.env when no
--env is given. Tokens are read from the .env files and never printed.`;

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
// also tolerated so the check does not break if that ever changes.
function parseRpcPayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`response contained neither JSON nor an SSE data event: ${text.slice(0, 300)}`);
  }
  return JSON.parse(dataLine.slice("data:".length).trim());
}

async function checkEndpoint(envPath) {
  const { resolved, env } = parseEnvFile(envPath);
  const port = parsePort(env.MCP_HTTP_PORT, resolved);
  const token = requiredEnv(env, "MCP_AUTH_TOKEN", resolved);
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };

  async function post(body, sessionId) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
      body
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`POST ${endpoint} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return { response, text };
  }

  const init = await post(
    rpcBody(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "repo-http-check", version: "1" }
    })
  );
  const initPayload = parseRpcPayload(init.text);
  if (initPayload.error) throw new Error(`initialize failed: ${JSON.stringify(initPayload.error)}`);

  const sessionId = init.response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("initialize response had no mcp-session-id header.");

  await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }), sessionId);

  const listed = await post(rpcBody(2, "tools/list"), sessionId);
  const listPayload = parseRpcPayload(listed.text);
  if (listPayload.error) throw new Error(`tools/list failed: ${JSON.stringify(listPayload.error)}`);

  const tools = listPayload.result?.tools;
  if (!Array.isArray(tools)) throw new Error("tools/list returned no tools array.");

  const names = new Set(tools.map((tool) => tool.name));
  const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).length;

  const declared = {
    generalWrite: isTruthy(env.MCP_HTTP_ALLOW_WRITE),
    skillWrite: isTruthy(env.MCP_HTTP_ALLOW_SKILL_WRITE),
    auditWrite: isTruthy(env.MCP_HTTP_ALLOW_AUDIT_WRITE)
  };

  const categories = [
    { key: "general document write", tools: GENERAL_WRITE_TOOLS, declared: declared.generalWrite },
    { key: "skill write", tools: SKILL_WRITE_TOOLS, declared: declared.skillWrite },
    { key: "audit write", tools: AUDIT_WRITE_TOOLS, declared: declared.auditWrite }
  ];

  const failures = [];
  const warnings = [];
  for (const category of categories) {
    const present = category.tools.filter((name) => names.has(name));
    if (present.length > 0 && !category.declared) {
      failures.push(`${category.key}: WIDER than declared — live tools not permitted by flags: ${present.join(", ")}`);
    } else if (present.length === 0 && category.declared) {
      warnings.push(`${category.key}: declared ON but no tool present (narrower than declared).`);
    }
  }

  const serverInfo = initPayload.result?.serverInfo ?? {};
  return {
    envPath: resolved,
    port,
    endpoint,
    publicUrl: env.MCP_HTTP_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined,
    server: `${serverInfo.name ?? "unknown"} ${serverInfo.version ?? ""}`.trimEnd(),
    protocol: initPayload.result?.protocolVersion ?? "unknown",
    toolCount: tools.length,
    readOnly,
    writeCapable: tools.length - readOnly,
    declared,
    failures,
    warnings
  };
}

const envPaths = parseArgs(process.argv.slice(2));
let hadFailure = false;

for (const envPath of envPaths) {
  console.log(`\n== ${envPath} ==`);
  try {
    const r = await checkEndpoint(envPath);
    const flagsSummary = `write=${r.declared.generalWrite ? "on" : "off"} skill=${
      r.declared.skillWrite ? "on" : "off"
    } audit=${r.declared.auditWrite ? "on" : "off"}`;
    console.log(`  local:    ${r.endpoint}`);
    if (r.publicUrl) console.log(`  public:   ${r.publicUrl}/mcp`);
    console.log(`  server:   ${r.server}`);
    console.log(`  protocol: ${r.protocol}`);
    console.log(`  declared: ${flagsSummary}`);
    console.log(`  tools:    ${r.toolCount} (${r.readOnly} read-only, ${r.writeCapable} write-capable)`);
    for (const warning of r.warnings) console.log(`  WARN:     ${warning}`);
    if (r.failures.length === 0) {
      console.log("  RESULT:   OK — live surface matches declared flags (not wider).");
    } else {
      hadFailure = true;
      for (const failure of r.failures) console.log(`  FAIL:     ${failure}`);
    }
  } catch (error) {
    hadFailure = true;
    console.log(`  FAIL:     ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("");
if (hadFailure) {
  console.log("check:http FAILED — see FAIL lines above.");
  process.exitCode = 1;
} else {
  console.log(`check:http OK — ${envPaths.length} endpoint(s) verified.`);
}
