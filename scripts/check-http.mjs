import { httpPort, loadRepoEnv, requiredEnv } from "./repo-env.mjs";

loadRepoEnv();

const token = requiredEnv("MCP_AUTH_TOKEN");
const port = httpPort();
const localBase = `http://127.0.0.1:${port}`;
const endpoint = `${localBase}/mcp`;
const commonHeaders = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream"
};

function rpcBody(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function checkedPost(body, sessionId) {
  const headers = sessionId ? { ...commonHeaders, "mcp-session-id": sessionId } : commonHeaders;
  const response = await fetch(endpoint, { method: "POST", headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${endpoint} failed: HTTP ${response.status}\n${text.slice(0, 500)}`);
  }
  return { response, text };
}

function parseSseJson(text) {
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`MCP response did not contain an SSE data event: ${text.slice(0, 500)}`);
  }
  return JSON.parse(dataLine.slice("data:".length).trim());
}

const initialized = await checkedPost(
  rpcBody(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "repo-http-check", version: "1" }
  })
);
const initializePayload = parseSseJson(initialized.text);
if (initializePayload.error) {
  throw new Error(`MCP initialize failed: ${JSON.stringify(initializePayload.error)}`);
}

const sessionId = initialized.response.headers.get("mcp-session-id");
if (!sessionId) {
  throw new Error("MCP initialize response did not include mcp-session-id.");
}

await checkedPost(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }), sessionId);
const listed = await checkedPost(rpcBody(2, "tools/list"), sessionId);
const listPayload = parseSseJson(listed.text);
if (listPayload.error) {
  throw new Error(`MCP tools/list failed: ${JSON.stringify(listPayload.error)}`);
}

const tools = listPayload.result?.tools;
if (!Array.isArray(tools)) {
  throw new Error("MCP tools/list returned no tools array.");
}

const readOnlyCount = tools.filter((tool) => tool.annotations?.readOnlyHint === true).length;
const writeCount = tools.length - readOnlyCount;
const serverInfo = initializePayload.result?.serverInfo ?? {};
const publicUrl = process.env.MCP_HTTP_PUBLIC_URL?.trim().replace(/\/+$/, "");

console.log("HTTP MCP check OK");
console.log(`  local:    ${endpoint}`);
if (publicUrl) {
  console.log(`  public:   ${publicUrl}/mcp`);
}
console.log(`  server:   ${serverInfo.name ?? "unknown"} ${serverInfo.version ?? ""}`.trimEnd());
console.log(`  protocol: ${initializePayload.result?.protocolVersion ?? "unknown"}`);
console.log(`  tools:    ${tools.length} (${readOnlyCount} read-only, ${writeCount} write-capable)`);
