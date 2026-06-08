import crypto from "node:crypto";

// In-memory OAuth 2.1 state for a single-user connector. Everything here is
// ephemeral process state (codes / tokens / dynamically-registered clients) —
// acceptable for a single-process private-vault connector and intentionally not
// persisted. Hardening:
//  - all secrets are 256-bit CSPRNG opaque strings (unguessable; no timing-safe
//    lookup needed because there is no low-entropy comparison),
//  - authorization codes are single-use and short-lived,
//  - every collection is capped and pruned to bound memory (DoS via unbounded
//    dynamic client registration / token minting).

const DEFAULT_MAX_CLIENTS = 100;
const DEFAULT_MAX_CODES = 1000;
const DEFAULT_MAX_TOKENS = 2000;

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scope: string;
}

interface AccessTokenRecord {
  clientId: string;
  scope: string;
  expiresAt: number;
}

interface RefreshTokenRecord {
  clientId: string;
  scope: string;
  expiresAt: number;
}

export interface OAuthStoreOptions {
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  codeTtlSec: number;
  /** Hard cap per token map (default DEFAULT_MAX_TOKENS). Bounds memory. */
  maxTokens?: number;
  now?: () => number;
}

function randomSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Evict the oldest entries (Map preserves insertion order) until size <= max. */
function enforceCap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

export class OAuthStore {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly now: () => number;
  private readonly maxTokens: number;

  constructor(private readonly options: OAuthStoreOptions) {
    this.now = options.now ?? Date.now;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  registerClient(redirectUris: string[], clientName?: string): RegisteredClient {
    this.prune();
    if (this.clients.size >= DEFAULT_MAX_CLIENTS) {
      // Evict the oldest registration rather than growing without bound.
      const oldest = [...this.clients.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        this.clients.delete(oldest.clientId);
      }
    }
    const client: RegisteredClient = {
      clientId: `client_${randomSecret()}`,
      redirectUris,
      clientName,
      createdAt: this.now()
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  createAuthorizationCode(params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
  }): string {
    this.prune();
    if (this.codes.size >= DEFAULT_MAX_CODES) {
      throw new Error("too_many_pending_authorizations");
    }
    const code = randomSecret();
    this.codes.set(code, {
      code,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scope: params.scope,
      expiresAt: this.now() + this.options.codeTtlSec * 1000
    });
    return code;
  }

  /** Single-use: the code is deleted on consumption regardless of outcome. */
  consumeAuthorizationCode(code: string): AuthorizationCode | undefined {
    const record = this.codes.get(code);
    if (!record) {
      return undefined;
    }
    this.codes.delete(code);
    if (record.expiresAt <= this.now()) {
      return undefined;
    }
    return record;
  }

  issueTokens(clientId: string, scope: string): IssuedTokens {
    this.prune();
    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    this.accessTokens.set(accessToken, {
      clientId,
      scope,
      expiresAt: this.now() + this.options.accessTokenTtlSec * 1000
    });
    this.refreshTokens.set(refreshToken, {
      clientId,
      scope,
      expiresAt: this.now() + this.options.refreshTokenTtlSec * 1000
    });
    // Enforce the hard cap even when every entry is still live (pruning only
    // removes expired ones): evict the oldest live tokens so a client minting
    // tokens faster than they expire cannot grow the maps without bound.
    enforceCap(this.accessTokens, this.maxTokens);
    enforceCap(this.refreshTokens, this.maxTokens);
    return {
      accessToken,
      refreshToken,
      expiresInSec: this.options.accessTokenTtlSec,
      scope
    };
  }

  /** Validate an access token. Returns the bound client/scope or null. */
  validateAccessToken(token: string | null | undefined): { clientId: string; scope: string } | null {
    if (!token) {
      return null;
    }
    const record = this.accessTokens.get(token);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= this.now()) {
      this.accessTokens.delete(token);
      return null;
    }
    return { clientId: record.clientId, scope: record.scope };
  }

  /** Refresh-token rotation: the presented refresh token is invalidated. */
  rotateRefreshToken(refreshToken: string, clientId: string): IssuedTokens | null {
    const record = this.refreshTokens.get(refreshToken);
    if (!record) {
      return null;
    }
    this.refreshTokens.delete(refreshToken);
    if (record.expiresAt <= this.now() || record.clientId !== clientId) {
      return null;
    }
    return this.issueTokens(clientId, record.scope);
  }

  private prune(): void {
    const t = this.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt <= t) this.codes.delete(code);
    }
    this.evictExpired();
  }

  private evictExpired(): void {
    const t = this.now();
    for (const [token, record] of this.accessTokens) {
      if (record.expiresAt <= t) this.accessTokens.delete(token);
    }
    for (const [token, record] of this.refreshTokens) {
      if (record.expiresAt <= t) this.refreshTokens.delete(token);
    }
  }
}
