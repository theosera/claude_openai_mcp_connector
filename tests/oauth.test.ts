import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpConfig } from "../src/config.js";
import { startHttpServer } from "../src/httpServer.js";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { isAllowedRedirectUri, OAuthProvider } from "../src/oauth/provider.js";
import { computeS256Challenge, verifyPkceS256 } from "../src/oauth/pkce.js";
import { RateLimiter } from "../src/oauth/rateLimiter.js";
import { OAuthStore } from "../src/oauth/store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: computeS256Challenge(verifier) };
}

async function makeStore(): Promise<KnowledgeStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-vault-"));
  const patchStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-patches-"));
  await fs.cp(path.join(repoRoot, "fixtures", "synthetic-vault"), root, { recursive: true });
  const store = new KnowledgeStore({ knowledgeRoot: root, writeMode: "two_step", patchStateDir });
  await store.init();
  return store;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Run the full OAuth flow over HTTP and return an access token for `scope`. */
async function oauthObtainToken(issuer: string, scope: string): Promise<string> {
  const redirectUri = "http://127.0.0.1:9999/cb";
  const reg = await (
    await fetch(`${issuer}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] })
    })
  ).json();
  const { verifier, challenge } = pkcePair();
  const authRes = await fetch(`${issuer}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
      scope,
      password: "hunter2"
    }).toString(),
    redirect: "manual"
  });
  const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
  const tokenRes = await fetch(`${issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier
    }).toString()
  });
  return (await tokenRes.json()).access_token;
}

async function listToolNamesOverHttp(issuer: string, token: string): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  const client = new Client({ name: "scope-test", version: "0.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

describe("RateLimiter", () => {
  it("allows up to the limit, then blocks until the window resets", () => {
    let t = 0;
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: () => t });
    expect(limiter.hit("ip").allowed).toBe(true);
    expect(limiter.hit("ip").allowed).toBe(true);
    expect(limiter.hit("ip").allowed).toBe(true);
    const blocked = limiter.hit("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    // Window reset.
    t += 1001;
    expect(limiter.hit("ip").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
    expect(limiter.hit("b").allowed).toBe(true);
  });
});

describe("PKCE S256", () => {
  it("verifies a matching verifier/challenge and rejects mismatches", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(verifier, computeS256Challenge("other"))).toBe(false);
    expect(verifyPkceS256("", challenge)).toBe(false);
    expect(verifyPkceS256(verifier, "")).toBe(false);
    expect(verifyPkceS256("short", challenge)).toBe(false); // < 43 chars
    expect(verifyPkceS256("bad chars!" + "a".repeat(40), challenge)).toBe(false);
  });
});

describe("redirect_uri policy", () => {
  it("allows https and loopback http only", () => {
    expect(isAllowedRedirectUri("https://chatgpt.com/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:1234/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("ftp://x/cb")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });

  it("rejects wildcard redirect hosts (would become a CSP-wide form-action)", () => {
    // https://*/cb parses, and new URL(...).origin === "https://*", which as a
    // CSP form-action source matches every https origin — so it must never be a
    // registrable redirect_uri.
    expect(isAllowedRedirectUri("https://*/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://*.example.com/cb")).toBe(false);
  });
});

describe("OAuthStore", () => {
  const opts = { accessTokenTtlSec: 60, refreshTokenTtlSec: 600, codeTtlSec: 60 };

  it("issues single-use authorization codes", () => {
    const store = new OAuthStore(opts);
    const code = store.createAuthorizationCode({
      clientId: "c",
      redirectUri: "https://x/cb",
      codeChallenge: "ch",
      scope: "",
      resource: "r"
    });
    expect(store.consumeAuthorizationCode(code)?.clientId).toBe("c");
    expect(store.consumeAuthorizationCode(code)).toBeUndefined(); // already used
  });

  it("expires codes and access tokens", () => {
    let t = 1000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const code = store.createAuthorizationCode({
      clientId: "c",
      redirectUri: "https://x/cb",
      codeChallenge: "ch",
      scope: "",
      resource: "r"
    });
    t += 61_000;
    expect(store.consumeAuthorizationCode(code)).toBeUndefined();

    t = 1000;
    const tokens = store.issueTokens("c", "vault.read", "r");
    expect(store.validateAccessToken(tokens.accessToken)?.clientId).toBe("c");
    t += 61_000;
    expect(store.validateAccessToken(tokens.accessToken)).toBeNull();
  });

  it("enforces the token cap even when all tokens are still live", () => {
    const store = new OAuthStore({ ...opts, maxTokens: 3 });
    const first = store.issueTokens("c", "vault.read", "r");
    let last = first;
    for (let i = 0; i < 10; i++) {
      last = store.issueTokens("c", "vault.read", "r");
    }
    // The oldest live token is evicted once the cap (3) is exceeded...
    expect(store.validateAccessToken(first.accessToken)).toBeNull();
    // ...while the most recently issued token stays valid.
    expect(store.validateAccessToken(last.accessToken)?.clientId).toBe("c");
  });

  it("rotates refresh tokens and invalidates the old one", () => {
    const store = new OAuthStore(opts);
    const tokens = store.issueTokens("c", "vault.read", "r");
    const rotated = store.rotateRefreshToken(tokens.refreshToken, "c");
    expect(rotated).not.toBeNull();
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull(); // reused
    expect(store.rotateRefreshToken(tokens.refreshToken, "wrong")).toBeNull();
  });
});

describe("OAuthProvider flow", () => {
  const config = {
    issuer: "https://vault.example.com",
    loginPassword: "hunter2",
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 86_400,
    codeTtlSec: 60,
    allowWrite: false
  };

  function setup() {
    const provider = new OAuthProvider(config);
    const reg = provider.register({ redirect_uris: ["https://chatgpt.com/cb"] });
    const clientId = JSON.parse(reg.body).client_id as string;
    return { provider, clientId };
  }

  function authorizeParams(clientId: string, challenge: string): URLSearchParams {
    return new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://chatgpt.com/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      scope: "vault.read"
    });
  }

  it("publishes discovery metadata", () => {
    const provider = new OAuthProvider(config);
    const as = JSON.parse(provider.authorizationServerMetadata().body);
    expect(as.issuer).toBe(config.issuer);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.authorization_endpoint).toBe(`${config.issuer}/authorize`);
    const pr = JSON.parse(provider.protectedResourceMetadata().body);
    expect(pr.resource).toBe(`${config.issuer}/mcp`);
    expect(pr.authorization_servers).toEqual([config.issuer]);
  });

  it("rejects registration without an allowed redirect_uri", () => {
    const provider = new OAuthProvider(config);
    expect(provider.register({ redirect_uris: ["http://evil/cb"] }).status).toBe(400);
    expect(provider.register({}).status).toBe(400);
  });

  it("rejects registration of a wildcard redirect host", () => {
    const provider = new OAuthProvider(config);
    expect(provider.register({ redirect_uris: ["https://*/cb"] }).status).toBe(400);
    expect(provider.register({ redirect_uris: ["https://*.example.com/cb"] }).status).toBe(400);
  });

  it("rejects authorize with unknown client or bad PKCE method", () => {
    const { provider, clientId } = setup();
    const { challenge } = pkcePair();
    expect(
      provider.authorizeGet(new URLSearchParams({ client_id: "nope", redirect_uri: "https://chatgpt.com/cb" })).status
    ).toBe(400);
    const plain = authorizeParams(clientId, challenge);
    plain.set("code_challenge_method", "plain");
    expect(provider.authorizeGet(plain).status).toBe(400);
  });

  it("requires the login password and then issues a code", () => {
    const { provider, clientId } = setup();
    const { verifier, challenge } = pkcePair();

    const form = authorizeParams(clientId, challenge);
    form.set("password", "wrong");
    const denied = provider.authorizePost(form);
    expect(denied.status).toBe(200); // re-render form, no redirect
    expect(denied.headers.location).toBeUndefined();

    form.set("password", "hunter2");
    const granted = provider.authorizePost(form);
    expect(granted.status).toBe(302);
    const location = new URL(granted.headers.location);
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code")!;

    // Exchange the code with the matching verifier.
    const token = provider.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: "https://chatgpt.com/cb",
        code_verifier: verifier
      })
    );
    expect(token.status).toBe(200);
    const payload = JSON.parse(token.body);
    expect(payload.token_type).toBe("Bearer");
    expect(provider.store.validateAccessToken(payload.access_token)).not.toBeNull();
  });

  it("rejects a token exchange with the wrong PKCE verifier and reused codes", () => {
    const { provider, clientId } = setup();
    const { challenge } = pkcePair();
    const form = authorizeParams(clientId, challenge);
    form.set("password", "hunter2");
    const code = new URL(provider.authorizePost(form).headers.location).searchParams.get("code")!;

    const wrong = provider.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: "https://chatgpt.com/cb",
        code_verifier: crypto.randomBytes(32).toString("base64url")
      })
    );
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.body).error).toBe("invalid_grant");
  });

  function exchange(provider: OAuthProvider, clientId: string, requestedScope: string) {
    const { verifier, challenge } = pkcePair();
    const form = authorizeParams(clientId, challenge);
    form.set("scope", requestedScope);
    form.set("password", "hunter2");
    const code = new URL(provider.authorizePost(form).headers.location).searchParams.get("code")!;
    const token = provider.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: "https://chatgpt.com/cb",
        code_verifier: verifier
      })
    );
    return JSON.parse(token.body);
  }

  it("never grants vault.write when the server write policy is off", () => {
    const { provider, clientId } = setup(); // allowWrite: false
    const payload = exchange(provider, clientId, "vault.read vault.write");
    expect(payload.scope).toBe("vault.read");
    expect(JSON.parse(provider.protectedResourceMetadata().body).scopes_supported).toEqual(["vault.read"]);
  });

  it("grants no scope for a non-empty but disjoint scope request", () => {
    const { provider, clientId } = setup(); // allowWrite: false
    // vault.write-only under a read-only policy -> empty (no silent read grant).
    expect(exchange(provider, clientId, "vault.write").scope).toBe("");
    // unrelated scope -> empty.
    expect(exchange(provider, clientId, "openid").scope).toBe("");
    // omitted scope still defaults to read.
    expect(exchange(provider, clientId, "").scope).toBe("vault.read");
  });

  it("grants vault.write only when the server write policy is on", () => {
    const provider = new OAuthProvider({ ...config, allowWrite: true });
    const clientId = JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body).client_id;
    const payload = exchange(provider, clientId, "vault.read vault.write");
    expect(payload.scope.split(" ")).toContain("vault.write");
  });

  it("binds issued tokens to the canonical resource (audience)", () => {
    const { provider, clientId } = setup();
    const payload = exchange(provider, clientId, "vault.read");
    expect(provider.store.validateAccessToken(payload.access_token)?.resource).toBe(`${config.issuer}/mcp`);
  });

  it("rejects an authorize request whose resource does not match", () => {
    const { provider, clientId } = setup();
    const { challenge } = pkcePair();
    const params = authorizeParams(clientId, challenge);
    params.set("resource", "https://evil.example.com/mcp");
    expect(provider.authorizeGet(params).status).toBe(400);
  });

  it("caps dynamic client registration inputs", () => {
    const provider = new OAuthProvider(config);
    expect(provider.register({ redirect_uris: Array(6).fill("https://x/cb") }).status).toBe(400);
    expect(provider.register({ redirect_uris: ["https://x/" + "a".repeat(3000)] }).status).toBe(400);
    expect(provider.register({ redirect_uris: ["https://x/cb"], client_name: "n".repeat(300) }).status).toBe(400);
  });

  it("sets clickjacking/leakage headers on the consent page", () => {
    const { provider, clientId } = setup();
    const { challenge } = pkcePair();
    const res = provider.authorizeGet(authorizeParams(clientId, challenge));
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("allows the client's redirect origin in form-action so the OAuth redirect is not blocked", () => {
    // Regression: a `form-action 'self'`-only CSP makes browsers silently block
    // the consent form submission, because success redirects (302) to the
    // client's redirect_uri on a different origin. The login page must list that
    // origin (and only it) alongside 'self'.
    const { provider, clientId } = setup();
    const { challenge } = pkcePair();
    const csp = provider.authorizeGet(authorizeParams(clientId, challenge)).headers[
      "content-security-policy"
    ] as string;
    const redirectOrigin = new URL("https://chatgpt.com/cb").origin;
    expect(csp).toContain(`form-action 'self' ${redirectOrigin}`);
  });

  it("keeps form-action 'self'-only on error pages (no client origin echoed)", () => {
    // The redirect-origin relaxation is scoped to the login form. An error page
    // (e.g. unknown client_id) has no form, so its CSP must stay 'self'-only and
    // must not carry any external origin.
    const { provider } = setup();
    const res = provider.authorizeGet(
      new URLSearchParams({ client_id: "nope", redirect_uri: "https://chatgpt.com/cb" })
    );
    expect(res.status).toBe(400);
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("form-action 'self';");
    expect(csp).not.toContain("chatgpt.com");
  });
});

describe("OAuth end-to-end over HTTP", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("drives discovery -> register -> authorize -> token -> authenticated /mcp", async () => {
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      allowWrite: false,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: [],
      oauth: {
        issuer,
        loginPassword: "hunter2",
        accessTokenTtlSec: 3600,
        refreshTokenTtlSec: 86_400,
        codeTtlSec: 60,
        allowWrite: false
      }
    };
    server = await startHttpServer(store, config);

    // Discovery
    const prMeta = await (await fetch(`${issuer}/.well-known/oauth-protected-resource`)).json();
    expect(prMeta.authorization_servers).toEqual([issuer]);

    // Dynamic client registration
    const redirectUri = "http://127.0.0.1:9999/cb";
    const reg = await (
      await fetch(`${issuer}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "test" })
      })
    ).json();
    const clientId = reg.client_id as string;
    expect(clientId).toBeTruthy();

    // Authorize (submit the login form) -> capture the auth code from the redirect
    const { verifier, challenge } = pkcePair();
    const form = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "abc",
      scope: "vault.read",
      password: "hunter2"
    });
    const authRes = await fetch(`${issuer}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual"
    });
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
    expect(code).toBeTruthy();

    // Token exchange
    const tokenRes = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier
      }).toString()
    });
    const tokens = await tokenRes.json();
    expect(tokens.token_type).toBe("Bearer");
    const accessToken = tokens.access_token as string;

    // Unauthenticated /mcp -> 401 with WWW-Authenticate pointing at discovery
    const unauth = await fetch(`${issuer}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("oauth-protected-resource");

    // Authenticated MCP session using the OAuth access token
    const transport = new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
    });
    const client = new Client({ name: "oauth-test", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("search");
    await client.close();
  });

  it("rate-limits by socket peer, not a spoofable X-Forwarded-For", async () => {
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      allowWrite: false,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: [],
      oauth: {
        issuer,
        loginPassword: "hunter2",
        accessTokenTtlSec: 3600,
        refreshTokenTtlSec: 86_400,
        codeTtlSec: 60,
        allowWrite: false
      }
    };
    server = await startHttpServer(store, config);

    // /register is rate-limited per window. Fire past the limit, each with a
    // DIFFERENT spoofed left-most X-Forwarded-For. If keying trusted XFF every
    // request would be a fresh bucket and none would 429; keyed on the (shared)
    // socket peer, the window fills and later requests are rejected — so a public
    // caller can neither bypass the limit nor lock out a victim by forging an IP.
    let sawRateLimit = false;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${issuer}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `203.0.113.${i}, 198.51.100.7`
        },
        body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/cb"] })
      });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });

  it("gates write tools by token scope on an allowWrite server", async () => {
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      allowWrite: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: [],
      oauth: {
        issuer,
        loginPassword: "hunter2",
        accessTokenTtlSec: 3600,
        refreshTokenTtlSec: 86_400,
        codeTtlSec: 60,
        allowWrite: true
      }
    };
    server = await startHttpServer(store, config);

    // A read-scoped token must not see write tools...
    const readTools = await listToolNamesOverHttp(issuer, await oauthObtainToken(issuer, "vault.read"));
    expect(readTools).toContain("search");
    expect(readTools).not.toContain("create_document");

    // ...but a vault.write-scoped token does.
    const writeTools = await listToolNamesOverHttp(issuer, await oauthObtainToken(issuer, "vault.read vault.write"));
    expect(writeTools).toContain("create_document");
  });
});
