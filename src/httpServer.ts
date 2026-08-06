import http from "node:http";
import { createMcpHandler, validateHostHeader, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { HttpConfig } from "./config.js";
import { isAuthorizedHeader, parseBearer } from "./httpAuth.js";
import type { VaultStore } from "./types.js";
import type { AuditStore } from "./auditStore.js";
import type { SkillStore } from "./skillStore.js";
import type { OAuthHttpResponse } from "./oauth/provider.js";
import { OAuthProvider, SCOPE_READ, SCOPE_WRITE } from "./oauth/provider.js";
import { RateLimiter } from "./oauth/rateLimiter.js";
import { buildMcpServer, type BuildServerOptions } from "./server.js";
import { sendWebResponse, toWebRequest } from "./webBridge.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB — bound request memory.

interface OAuthLimiters {
  authorize: RateLimiter;
  register: RateLimiter;
}

interface Principal {
  scopes: string[];
}

/** Everything the two protocol eras share for one endpoint. */
interface Endpoint {
  store: VaultStore;
  config: HttpConfig;
  oauth: OAuthProvider | undefined;
  limiters: OAuthLimiters | undefined;
  skillStore: SkillStore | undefined;
  auditStore: AuditStore | undefined;
  /**
   * The single MCP handler, serving BOTH protocol eras with no sessions at all:
   * 2026-07-28 natively, and 2025 through the stateless legacy fallback. Every
   * request gets a fresh instance from the factory, so there is no session id to
   * invalidate on restart and nothing to reap when a client vanishes.
   */
  handler: McpHttpHandler;
  /**
   * The authenticated principal for one in-flight request, keyed by the exact
   * `Request` object handed to `handler.fetch`. `McpRequestContext` carries that
   * same object back as `requestInfo` — on both legs — which is how the
   * per-request factory recovers the scopes that decide its tool surface. Weak
   * so a disconnected request is collected with its entry.
   */
  principals: WeakMap<Request, Principal>;
}

/**
 * Start the remote Streamable HTTP MCP endpoint for Chat connectors
 * (ChatGPT / Claude.ai). Hardening applied here, on top of the in-process
 * path/frontmatter/two-step guards:
 *  - Bearer auth on every request (fail-closed; see httpAuth).
 *  - Bind to 127.0.0.1 by default (expose only via an explicit tunnel).
 *  - DNS-rebinding protection: Host (and, when configured, Origin) are
 *    validated at this boundary, before either protocol era is dispatched.
 *  - Read-only tool surface unless MCP_HTTP_ALLOW_WRITE is set.
 *
 * Both protocol eras are served from one endpoint, one tool factory, and NO
 * sessions: 2026-07-28 natively, 2025 through `createMcpHandler`'s stateless
 * legacy fallback. The tool surface is therefore resolved from the presented
 * token on every single request rather than fixed once per session — which is
 * both what removes the `404 unknown_session` restart failure and what keeps
 * INV-6/INV-7 true without a session to hang them on.
 */
export async function startHttpServer(
  store: VaultStore,
  config: HttpConfig,
  skillStore?: SkillStore,
  auditStore?: AuditStore
): Promise<http.Server> {
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

  const principals = new WeakMap<Request, Principal>();
  const endpoint: Endpoint = {
    store,
    config,
    oauth,
    limiters,
    skillStore,
    auditStore,
    principals,
    // `legacy: 'stateless'` — 2025-era requests are each answered by a fresh
    // instance from this same factory. That is the whole of the session removal:
    // there is no `Mcp-Session-Id` to issue, none to look up, and none to lose
    // on restart. GET / DELETE (the 2025 session operations) answer 405.
    handler: createMcpHandler(
      (ctx) => {
        const principal = ctx.requestInfo ? principals.get(ctx.requestInfo) : undefined;
        if (!principal) {
          // Fail closed. There is no safe default surface to fall back to: the
          // default would be the full one.
          throw new Error("unresolved_principal");
        }
        return buildMcpServer(store, surfaceFor(principal, config, skillStore, auditStore));
      },
      { legacy: "stateless" }
    )
  };

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, endpoint).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: "internal_error", message: (error as Error).message }));
      }
    });
  });
  httpServer.on("close", () => {
    void endpoint.handler.close().catch(() => {});
  });

  await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));
  return httpServer;
}

/**
 * Derive the tool surface from the presented scopes and the server policy.
 *
 * Single point of truth for INV-6 item 4 / INV-7 item 5, and now the ONLY point:
 * with no sessions, this runs on every request for both eras. Writes require
 * BOTH the server policy (allow* flags) AND a token carrying `vault.write`. A
 * read-scoped token never sees write tools because they are never registered for
 * the instance serving that request, so it cannot invoke them.
 */
function surfaceFor(
  principal: Principal,
  config: HttpConfig,
  skillStore: SkillStore | undefined,
  auditStore: AuditStore | undefined
): BuildServerOptions {
  // Defensive: `authorizeScope` refuses a principal without vault.read at the
  // gate, so reaching here without it means the gate was bypassed. Registering
  // the read tools regardless would silently restore the very hole this node
  // closes, so fail closed instead of trusting the caller.
  if (!principal.scopes.includes(SCOPE_READ)) {
    throw new Error("insufficient_scope");
  }
  const write = principal.scopes.includes(SCOPE_WRITE);
  return {
    allowWrite: config.allowWrite && write,
    allowSkillWrite: config.allowSkillWrite && write,
    skillStore,
    allowAuditWrite: config.allowAuditWrite && write,
    auditStore,
    includeChatgptCompat: true,
    chatgptUrlBase: config.chatgptUrlBase
  };
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, endpoint: Endpoint): Promise<void> {
  const { config, oauth, limiters } = endpoint;
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
  // valid OAuth access token (ChatGPT / Claude.ai web). The principal carries
  // the effective scopes that decide the tool surface for THIS request.
  const principal = authenticate(req.headers.authorization, config, oauth);
  if (!principal) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "www-authenticate": oauth ? oauth.wwwAuthenticate() : 'Bearer realm="mcp"'
    };
    res.writeHead(401, headers);
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // Scope gate. `vault.read` is now ENFORCED, closing the read half of
  // INV-7 item 5: a token whose grant is empty (a client that requested only
  // scopes this server will not grant, e.g. `vault.write` while writes are off)
  // used to authenticate successfully and read the entire vault, because
  // `{scopes: []}` is non-null and the read tools were registered
  // unconditionally.
  //
  // Refused rather than served an empty tool list: 403 with the RFC 6750 §3.1
  // `insufficient_scope` challenge naming the missing scope is what lets a
  // client re-authorize for it. An empty 200 is indistinguishable from an empty
  // vault, so it would send the operator looking in the wrong place.
  if (!principal.scopes.includes(SCOPE_READ)) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (oauth) {
      headers["www-authenticate"] = oauth.insufficientScope(SCOPE_READ);
    }
    res.writeHead(403, headers);
    res.end(JSON.stringify({ error: "insufficient_scope", scope: SCOPE_READ }));
    return;
  }

  // DNS-rebinding protection (INV-6 item 3). Enforced here rather than through
  // the transport's deprecated `enableDnsRebindingProtection` options, so ONE
  // check covers both protocol eras — the modern handler has no such option at
  // all. `allowedHosts` is read per request (not snapshotted at listen time)
  // because the ephemeral-port case fills it in after the server is bound.
  const rebinding = rejectRebinding(req, config);
  if (rebinding) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: rebinding }));
    return;
  }

  const raw = await readBody(req, res);
  if (raw === BODY_ERROR) {
    return;
  }
  let body: unknown;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }
  }

  const request = toWebRequest(req, raw);

  // One handler, both eras, no sessions. The principal is bound to this exact
  // Request; the factory reads it back through `ctx.requestInfo` and builds the
  // tool surface from it. Nothing is carried between requests, so there is no
  // session whose scopes could drift from the token now being presented.
  //
  // `parsedBody` is load-bearing on the 2025 leg, not an optimisation: measured,
  // the same request WITHOUT it reaches the factory as a different `Request`
  // instance — equal field for field — which this WeakMap lookup misses. The
  // modern leg preserves identity either way. Removing it fails a dozen tests
  // across both eras; the one that names the property rather than a symptom is
  // "...the same Request instance on the 2025 leg" in tests/httpServer.test.ts.
  endpoint.principals.set(request, principal);
  await sendWebResponse(res, await endpoint.handler.fetch(request, { parsedBody: body }));
}

/**
 * Authenticate an /mcp request. Returns the effective principal, or null.
 *  - Static bearer (MCP_AUTH_TOKEN): the trusted local operator → full scopes.
 *  - OAuth access token: must be valid AND audience-bound to this server's
 *    canonical resource (RFC 8707); scopes come from the token grant.
 */
function authenticate(
  authHeader: string | string[] | undefined,
  config: HttpConfig,
  oauth: OAuthProvider | undefined
): Principal | null {
  const header = headerValue(authHeader);
  if (isAuthorizedHeader(header, config.authToken)) {
    return { scopes: [SCOPE_READ, SCOPE_WRITE] };
  }
  if (oauth) {
    const record = oauth.store.validateAccessToken(parseBearer(header));
    if (record && record.resource === oauth.canonicalResource) {
      return { scopes: record.scope.split(/\s+/).filter(Boolean) };
    }
  }
  return null;
}

/**
 * DNS-rebinding check. Returns an error code when the request must be refused,
 * or undefined when it may proceed.
 *
 * Host: validated with the SDK's `validateHostHeader`, which compares HOSTNAMES
 * and ignores the port (it also understands IPv6 brackets). `allowedHosts`
 * entries historically carry `host:port`, so the port is stripped here — the
 * env contract keeps working, and a bare hostname works too. Dropping the port
 * from the comparison costs nothing: the server listens on exactly one port, so
 * a browser can only ever reach it with that port in the Host header anyway.
 *
 * Origin: deliberately NOT delegated to the SDK's `validateOriginHeader`, which
 * also compares hostnames only and would therefore stop distinguishing
 * `https://x` from `http://x`. The existing exact full-origin comparison is
 * kept instead, unchanged: unset `MCP_HTTP_ALLOWED_ORIGINS` skips the check, and
 * a request with NO Origin header passes (D-M1-ORIGIN-ABSENT — non-browser MCP
 * clients send none; only a present-but-unlisted value is refused).
 */
function rejectRebinding(req: http.IncomingMessage, config: HttpConfig): string | undefined {
  const host = headerValue(req.headers.host);
  // `Host = uri-host [ ":" port ]` (RFC 9110 §7.2) — userinfo is not part of this
  // header, so an "@" can only be an attempt to make a parser read a different
  // authority than a reader does. It has to be refused HERE because
  // `validateHostHeader` compares the PARSED hostname: `evil.example@127.0.0.1`
  // reads as `127.0.0.1` and passes the allowlist. The v1 transport compared the
  // header verbatim and refused the shape; keep that.
  //
  // Nothing downstream should be relied on to catch it. Today it does not get
  // far — `toWebRequest` builds this request's URL from the same raw header and
  // `new Request()` throws on a URL carrying credentials — but that is the Fetch
  // spec declining to construct an object, two steps past the gate that should
  // have said no, surfacing as a 500 rather than a refusal. Same reasoning as
  // D-SCAN1-NOT-VULN: an incidental guard is not the guard.
  if (host !== undefined && host.includes("@")) {
    return "forbidden_host";
  }
  const allowedHostnames = config.allowedHosts.map(hostnameOf).filter((item) => item.length > 0);
  if (allowedHostnames.length > 0 && !validateHostHeader(host, allowedHostnames).ok) {
    return "forbidden_host";
  }
  const origin = headerValue(req.headers.origin);
  if (config.allowedOrigins.length > 0 && origin !== undefined && origin !== "") {
    if (!config.allowedOrigins.includes(origin)) {
      return "forbidden_origin";
    }
  }
  return undefined;
}

/** Strip an optional `:port` from an allowlist entry, keeping IPv6 bracketed. */
export function hostnameOf(entry: string): string {
  const value = entry.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  if (colon === -1) {
    return value;
  }
  // More than one colon and no brackets: a bare IPv6 literal, where a trailing
  // group is indistinguishable from a port. Bracket it rather than truncate it.
  if (value.indexOf(":", colon + 1) !== -1) {
    return `[${value}]`;
  }
  return value.slice(0, colon);
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
 * Apply a rate limit keyed by the socket peer; writes a 429 + Retry-After and
 * returns true when the request should be rejected. We deliberately do NOT trust
 * `X-Forwarded-For`: every proxy only *appends* to it, so the left-most token is
 * fully client-controlled. Keying on it let a public caller bypass the limit
 * outright (a fresh spoofed IP per request) and even lock out the legitimate user
 * by forging *their* IP. The socket address cannot be spoofed. Behind a tunnel
 * every request shares the tunnel's local address, so this becomes a coarse
 * *global* cap — correct for a single-user connector; a direct multi-client bind
 * is naturally per-client. This is defense-in-depth over the scrypt password gate.
 */
function rateLimited(req: http.IncomingMessage, res: http.ServerResponse, limiter: RateLimiter): boolean {
  const key = (req.socket.remoteAddress || "unknown").toLowerCase();
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
 * Read the request body with a hard size cap (INV-6 item 5). On an oversize
 * payload it writes the 413 and returns BODY_ERROR so the caller stops.
 */
async function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Buffer | typeof BODY_ERROR> {
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
  return Buffer.concat(chunks);
}

/**
 * Read and JSON-parse the request body with a hard size cap. On malformed JSON
 * or oversize payloads it writes the error response and returns BODY_ERROR so
 * the caller stops processing.
 */
async function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown | typeof BODY_ERROR> {
  const raw = await readBody(req, res);
  if (raw === BODY_ERROR) {
    return BODY_ERROR;
  }
  if (raw.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw.toString("utf8"));
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
  const raw = await readBody(req, res);
  if (raw === BODY_ERROR) {
    return BODY_ERROR;
  }
  return new URLSearchParams(raw.toString("utf8"));
}
