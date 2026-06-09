import crypto from "node:crypto";
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { HttpConfig } from "./config.js";
import { isAuthorizedHeader, parseBearer } from "./httpAuth.js";
import type { KnowledgeStore } from "./knowledgeStore.js";
import type { OAuthHttpResponse } from "./oauth/provider.js";
import { OAuthProvider } from "./oauth/provider.js";
import { RateLimiter } from "./oauth/rateLimiter.js";
import { buildMcpServer } from "./server.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB — bound request memory.

interface Session {
  transport: StreamableHTTPServerTransport;
}

interface OAuthLimiters {
  authorize: RateLimiter;
  register: RateLimiter;
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
  // OAuth 2.1 authorization server (only when configured). ChatGPT / Claude.ai
  // web require it; Desktop / Code / API keep using the static bearer.
  const oauth = config.oauth ? new OAuthProvider(config.oauth) : undefined;
  // Coarse per-client rate limits on the public, unauthenticated OAuth endpoints
  // (defense-in-depth against brute force / DCR flooding over a public tunnel).
  const limiters: OAuthLimiters | undefined = oauth
    ? {
        authorize: new RateLimiter({ limit: 20, windowMs: 5 * 60_000 }),
        register: new RateLimiter({ limit: 20, windowMs: 10 * 60_000 })
      }
    : undefined;

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, store, config, sessions, oauth, limiters).catch((error) => {
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
  sessions: Map<string, Session>,
  oauth: OAuthProvider | undefined,
  limiters: OAuthLimiters | undefined
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Unauthenticated liveness probe — returns no vault information.
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // OAuth 2.1 endpoints are unauthenticated by design (discovery / login /
  // token). Handled before the bearer gate.
  if (oauth && (await handleOAuthRoute(req, res, url, oauth, limiters))) {
    return;
  }

  if (url.pathname !== MCP_PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  // Auth gate: accept either the static bearer (Desktop / Code / API) or a
  // valid OAuth access token (ChatGPT / Claude.ai web).
  if (!isMcpAuthorized(req.headers.authorization, config, oauth)) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "www-authenticate": oauth ? oauth.wwwAuthenticate() : 'Bearer realm="mcp"'
    };
    res.writeHead(401, headers);
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

/** Accept the static bearer OR a valid OAuth access token for /mcp. */
function isMcpAuthorized(
  authHeader: string | string[] | undefined,
  config: HttpConfig,
  oauth: OAuthProvider | undefined
): boolean {
  const header = headerValue(authHeader);
  if (isAuthorizedHeader(header, config.authToken)) {
    return true;
  }
  if (oauth) {
    const token = parseBearer(header);
    return oauth.store.validateAccessToken(token) !== null;
  }
  return false;
}

/**
 * Route OAuth 2.1 endpoints. Returns true if the request was handled.
 * Endpoints: AS/PR metadata discovery, dynamic client registration, the
 * authorize login page (GET/POST), and the token endpoint.
 */
async function handleOAuthRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  oauth: OAuthProvider,
  limiters: OAuthLimiters | undefined
): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
    return sendOAuth(res, oauth.authorizationServerMetadata());
  }
  if (method === "GET" && pathname === "/.well-known/oauth-protected-resource") {
    return sendOAuth(res, oauth.protectedResourceMetadata());
  }
  if (method === "POST" && pathname === "/register") {
    if (limiters && rateLimited(req, res, limiters.register)) {
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === BODY_ERROR) {
      return true;
    }
    return sendOAuth(res, oauth.register(body));
  }
  if (pathname === "/authorize") {
    if (method === "GET") {
      return sendOAuth(res, oauth.authorizeGet(url.searchParams));
    }
    if (method === "POST") {
      if (limiters && rateLimited(req, res, limiters.authorize)) {
        return true;
      }
      const form = await readFormBody(req, res);
      if (form === BODY_ERROR) {
        return true;
      }
      return sendOAuth(res, oauth.authorizePost(form));
    }
  }
  if (method === "POST" && pathname === "/token") {
    const form = await readFormBody(req, res);
    if (form === BODY_ERROR) {
      return true;
    }
    return sendOAuth(res, oauth.token(form));
  }
  return false;
}

/**
 * Apply a rate limit keyed by client IP; writes a 429 + Retry-After and returns
 * true when the request should be rejected. The key prefers the left-most
 * X-Forwarded-For hop (set by the tunnel) and falls back to the socket address;
 * XFF is client-spoofable, so this is a coarse defense-in-depth bound, not a
 * security boundary (the scrypt password gate is the real control).
 */
function rateLimited(req: http.IncomingMessage, res: http.ServerResponse, limiter: RateLimiter): boolean {
  const forwarded = headerValue(req.headers["x-forwarded-for"]);
  const key = (forwarded?.split(",")[0].trim() || req.socket.remoteAddress || "unknown").toLowerCase();
  const result = limiter.hit(key);
  if (result.allowed) {
    return false;
  }
  res.writeHead(429, {
    "content-type": "application/json",
    "retry-after": String(result.retryAfterSec)
  });
  res.end(JSON.stringify({ error: "rate_limited" }));
  return true;
}

function sendOAuth(res: http.ServerResponse, response: OAuthHttpResponse): true {
  res.writeHead(response.status, response.headers);
  res.end(response.body);
  return true;
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

/** Read an application/x-www-form-urlencoded body (size-capped) as params. */
async function readFormBody(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<URLSearchParams | typeof BODY_ERROR> {
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
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
