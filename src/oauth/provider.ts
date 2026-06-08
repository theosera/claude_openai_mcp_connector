import { isAuthorized } from "../httpAuth.js";
import { verifyPkceS256 } from "./pkce.js";
import { OAuthStore } from "./store.js";

// Minimal single-user OAuth 2.1 authorization server, just enough for the MCP
// authorization spec so ChatGPT / Claude.ai web can connect to the private
// vault (neither accepts a user-pasted static bearer; both require OAuth 2.1 +
// PKCE + dynamic client registration + metadata discovery). The vault access
// gate is a single shared login password; on success we mint opaque tokens that
// the resource server (`/mcp`) validates exactly like the static bearer.
//
// INV-7 (see SKILL.md): PKCE S256 mandatory; auth codes single-use + short TTL +
// bound to client/redirect_uri/challenge; redirect_uri exact-match against a
// registered https/loopback URI (no open redirect); login password constant-time
// + fail-closed; tokens are 256-bit opaque; no secrets logged.

export interface OAuthConfig {
  /** Public issuer base URL (e.g. https://xxxx.trycloudflare.com). No trailing slash. */
  issuer: string;
  /** Shared login password gating vault access. Required, env-only. */
  loginPassword: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  codeTtlSec: number;
}

export interface OAuthHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const MCP_RESOURCE_PATH = "/mcp";

export class OAuthProvider {
  readonly store: OAuthStore;

  constructor(private readonly config: OAuthConfig, store?: OAuthStore) {
    this.store =
      store ??
      new OAuthStore({
        accessTokenTtlSec: config.accessTokenTtlSec,
        refreshTokenTtlSec: config.refreshTokenTtlSec,
        codeTtlSec: config.codeTtlSec
      });
  }

  get issuer(): string {
    return this.config.issuer;
  }

  get protectedResourceMetadataUrl(): string {
    return `${this.config.issuer}/.well-known/oauth-protected-resource`;
  }

  /** RFC 8414 — Authorization Server Metadata. */
  authorizationServerMetadata(): OAuthHttpResponse {
    return json(200, {
      issuer: this.config.issuer,
      authorization_endpoint: `${this.config.issuer}/authorize`,
      token_endpoint: `${this.config.issuer}/token`,
      registration_endpoint: `${this.config.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["vault.read", "vault.write"]
    });
  }

  /** RFC 9728 — Protected Resource Metadata. */
  protectedResourceMetadata(): OAuthHttpResponse {
    return json(200, {
      resource: `${this.config.issuer}${MCP_RESOURCE_PATH}`,
      authorization_servers: [this.config.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["vault.read", "vault.write"]
    });
  }

  /** WWW-Authenticate value pointing unauthenticated clients at discovery. */
  wwwAuthenticate(): string {
    return `Bearer resource_metadata="${this.protectedResourceMetadataUrl}"`;
  }

  /** RFC 7591 — Dynamic Client Registration (public client, PKCE). */
  register(body: unknown): OAuthHttpResponse {
    const record = (body ?? {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(record.redirect_uris) ? record.redirect_uris.map(String) : [];
    if (redirectUris.length === 0) {
      return json(400, { error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
    }
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri)) {
        return json(400, {
          error: "invalid_redirect_uri",
          error_description: "redirect_uris must be https or loopback http"
        });
      }
    }
    const clientName = typeof record.client_name === "string" ? record.client_name : undefined;
    const client = this.store.registerClient(redirectUris, clientName);
    return json(201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(clientName ? { client_name: clientName } : {})
    });
  }

  /**
   * GET /authorize — validate the request, then render the login page. We never
   * redirect on an invalid client/redirect_uri (that would be an open redirect);
   * those fail with a 400 page instead.
   */
  authorizeGet(query: URLSearchParams): OAuthHttpResponse {
    const check = this.validateAuthorizeParams(query);
    if (!check.ok) {
      return htmlPage(check.status, "Authorization error", `<p>${escapeHtml(check.message)}</p>`);
    }
    return this.renderLoginForm(check.params, undefined);
  }

  /**
   * POST /authorize — re-validate, check the login password, then issue an auth
   * code and redirect back to the client's registered redirect_uri.
   */
  authorizePost(form: URLSearchParams): OAuthHttpResponse {
    const check = this.validateAuthorizeParams(form);
    if (!check.ok) {
      return htmlPage(check.status, "Authorization error", `<p>${escapeHtml(check.message)}</p>`);
    }
    const password = form.get("password") ?? "";
    if (!isAuthorized(password, this.config.loginPassword)) {
      return this.renderLoginForm(check.params, "Incorrect password.");
    }
    const code = this.store.createAuthorizationCode({
      clientId: check.params.clientId,
      redirectUri: check.params.redirectUri,
      codeChallenge: check.params.codeChallenge,
      scope: check.params.scope
    });
    const location = new URL(check.params.redirectUri);
    location.searchParams.set("code", code);
    if (check.params.state) {
      location.searchParams.set("state", check.params.state);
    }
    return { status: 302, headers: { location: location.toString() }, body: "" };
  }

  /** POST /token — authorization_code (with PKCE) and refresh_token grants. */
  token(form: URLSearchParams): OAuthHttpResponse {
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      return this.tokenFromCode(form);
    }
    if (grantType === "refresh_token") {
      return this.tokenFromRefresh(form);
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  private tokenFromCode(form: URLSearchParams): OAuthHttpResponse {
    const code = form.get("code") ?? "";
    const clientId = form.get("client_id") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const codeVerifier = form.get("code_verifier") ?? "";

    const record = this.store.consumeAuthorizationCode(code);
    if (!record) {
      return json(400, { error: "invalid_grant", error_description: "code is invalid or expired" });
    }
    if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
      return json(400, { error: "invalid_grant", error_description: "client/redirect mismatch" });
    }
    if (!verifyPkceS256(codeVerifier, record.codeChallenge)) {
      return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    }
    const tokens = this.store.issueTokens(record.clientId, record.scope);
    return tokenResponse(tokens);
  }

  private tokenFromRefresh(form: URLSearchParams): OAuthHttpResponse {
    const refreshToken = form.get("refresh_token") ?? "";
    const clientId = form.get("client_id") ?? "";
    const tokens = this.store.rotateRefreshToken(refreshToken, clientId);
    if (!tokens) {
      return json(400, { error: "invalid_grant", error_description: "refresh_token is invalid or expired" });
    }
    return tokenResponse(tokens);
  }

  private validateAuthorizeParams(
    params: URLSearchParams
  ):
    | { ok: true; params: AuthorizeParams }
    | { ok: false; status: number; message: string } {
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const client = this.store.getClient(clientId);
    if (!client) {
      return { ok: false, status: 400, message: "Unknown client_id." };
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return { ok: false, status: 400, message: "redirect_uri does not match a registered value." };
    }
    // Past this point a failure could be safely redirected, but for a single-user
    // connector we keep it simple and surface errors on-page.
    if ((params.get("response_type") ?? "") !== "code") {
      return { ok: false, status: 400, message: "Only response_type=code is supported." };
    }
    if ((params.get("code_challenge_method") ?? "") !== "S256") {
      return { ok: false, status: 400, message: "PKCE with code_challenge_method=S256 is required." };
    }
    const codeChallenge = params.get("code_challenge") ?? "";
    if (!codeChallenge) {
      return { ok: false, status: 400, message: "code_challenge is required." };
    }
    return {
      ok: true,
      params: {
        clientId,
        redirectUri,
        codeChallenge,
        scope: params.get("scope") ?? "",
        state: params.get("state") ?? ""
      }
    };
  }

  private renderLoginForm(params: AuthorizeParams, error: string | undefined): OAuthHttpResponse {
    const hidden = (name: string, value: string) =>
      `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
    const errorHtml = error ? `<p style="color:#b00">${escapeHtml(error)}</p>` : "";
    const body = `
      <h1>Connect to private vault</h1>
      <p>Authorize this client to access your Markdown vault (read-only unless writes are enabled).</p>
      ${errorHtml}
      <form method="POST" action="/authorize">
        ${hidden("client_id", params.clientId)}
        ${hidden("redirect_uri", params.redirectUri)}
        ${hidden("code_challenge", params.codeChallenge)}
        <input type="hidden" name="code_challenge_method" value="S256" />
        <input type="hidden" name="response_type" value="code" />
        ${hidden("scope", params.scope)}
        ${hidden("state", params.state)}
        <label>Password <input type="password" name="password" autofocus required /></label>
        <button type="submit">Authorize</button>
      </form>`;
    return htmlPage(200, "Authorize", body);
  }
}

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state: string;
}

/** Only https, or http on loopback (for local testing), may be a redirect target. */
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  if (parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) {
    return true;
  }
  return false;
}

function tokenResponse(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scope: string;
}): OAuthHttpResponse {
  return json(
    200,
    {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresInSec,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope
    },
    { "cache-control": "no-store", pragma: "no-cache" }
  );
}

function json(status: number, payload: unknown, extraHeaders: Record<string, string> = {}): OAuthHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(payload)
  };
}

function htmlPage(status: number, title: string, inner: string): OAuthHttpResponse {
  const body = `<!doctype html><html><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" />` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}` +
    `label{display:block;margin:1rem 0}input{font-size:1rem;padding:.4rem;width:100%}` +
    `button{font-size:1rem;padding:.5rem 1rem;cursor:pointer}</style></head>` +
    `<body>${inner}</body></html>`;
  return { status, headers: { "content-type": "text/html; charset=utf-8" }, body };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
