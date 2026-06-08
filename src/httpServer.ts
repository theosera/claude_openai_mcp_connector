import crypto from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { HttpConfig } from "./config.js";
import { isAuthorizedHeader } from "./httpAuth.js";
import type { KnowledgeStore } from "./knowledgeStore.js";
import { buildMcpServer } from "./server.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB — bound request memory.

interface Session {
  transport: StreamableHTTPServerTransport;
}

/**
 * Start the remote Streamable HTTP MCP endpoint for Chat connectors
 * (ChatGPT / Claude.ai). Hardening applied here, on top of the in-process
 * path/frontmatter/two-step guards:
 *  - Bearer auth on every request (fail-closed; see httpAuth).
 *  - Bind to 127.0.0.1 by default (expose only via an explicit tunnel).
 *  - DNS-rebinding protection (allowedHosts / allowedOrigins).
 *  - Read-only tool surface unless MCP_HTTP_ALLOW_WRITE is set.
 */
export async function startHttpServer(store: KnowledgeStore, config: HttpConfig): Promise<http.Server> {
  const sessions = new Map<string, Session>();

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, store, config, sessions).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: "internal_error", message: (error as Error).message }));
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));
  return httpServer;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: KnowledgeStore,
  config: HttpConfig,
  sessions: Map<string, Session>
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Unauthenticated liveness probe — returns no vault information.
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  // Auth gate: every MCP request must carry a valid bearer token.
  if (!isAuthorizedHeader(req.headers.authorization, config.authToken)) {
    res.writeHead(401, {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="mcp"'
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const sessionId = headerValue(req.headers["mcp-session-id"]);

  // Reuse an established session (GET stream, DELETE, or subsequent POST).
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown_session" }));
      return;
    }
    const body = req.method === "POST" ? await readJsonBody(req, res) : undefined;
    if (req.method === "POST" && body === BODY_ERROR) {
      return;
    }
    await session.transport.handleRequest(req, res, body === BODY_ERROR ? undefined : body);
    return;
  }

  // No session id: only an initialize POST may open a new session.
  if (req.method !== "POST") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing_session" }));
    return;
  }

  const body = await readJsonBody(req, res);
  if (body === BODY_ERROR) {
    return;
  }
  if (!isInitializeRequest(body)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "expected_initialize" }));
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableDnsRebindingProtection: true,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins.length > 0 ? config.allowedOrigins : undefined,
    onsessioninitialized: (id) => {
      sessions.set(id, { transport });
    }
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  const server = buildMcpServer(store, {
    allowWrite: config.allowWrite,
    includeChatgptCompat: true,
    chatgptUrlBase: config.chatgptUrlBase
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

const BODY_ERROR = Symbol("body_error");

/**
 * Read and JSON-parse the request body with a hard size cap. On malformed JSON
 * or oversize payloads it writes the error response and returns BODY_ERROR so
 * the caller stops processing.
 */
async function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown | typeof BODY_ERROR> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return BODY_ERROR;
    }
    chunks.push(chunk as Buffer);
  }
  if (total === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return BODY_ERROR;
  }
}
