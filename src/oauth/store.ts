import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// OAuth 2.1 state for a single-user connector. By default everything here is
// ephemeral process state (codes / tokens / dynamically-registered clients);
// with `persistPath` set, clients and tokens additionally survive restarts via
// a small state file so a supervisor restart no longer forces a re-authorize.
// Hardening (INV-7):
//  - all secrets are 256-bit CSPRNG opaque strings (unguessable; no timing-safe
//    lookup needed because there is no low-entropy comparison),
//  - access/refresh tokens are keyed by sha256(token) in memory AND at rest, so
//    the state file never contains a recoverable credential (hash-at-rest —
//    stronger than encryption here because raw tokens never need recovery),
//  - the state file is integrity-protected by an HMAC keyed from the login
//    password (scrypt-derived): tampering, corruption, or a rotated password
//    fails CLOSED — the store starts empty and every session must re-auth,
//  - authorization codes are single-use and short-lived, and are deliberately
//    NEVER persisted (a restart mid-flow just restarts the flow),
//  - refresh-token rotation deletes the presented token from disk immediately,
//    so single-use semantics hold across restarts,
//  - every collection is capped and pruned to bound memory (DoS via unbounded
//    dynamic client registration / token minting).

const DEFAULT_MAX_CLIENTS = 100;
const DEFAULT_MAX_CODES = 1000;
const DEFAULT_MAX_TOKENS = 2000;
// A registered client that holds no live token is pruned once it is older than
// this grace window. Tokens are the real credential and self-expire; a lingering
// registration is dead weight. The window must comfortably exceed a plausible
// authorize->token round-trip so an in-flight registration (registered, not yet
// exchanged for a token) is never swept mid-flow.
const DEFAULT_CLIENT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

const STATE_VERSION = 1;
const STATE_SALT_BYTES = 16;
const HMAC_KEY_BYTES = 32;

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
  /** RFC 8707 audience this code (and the resulting token) is bound to. */
  resource: string;
  expiresAt: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scope: string;
}

interface TokenRecord {
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

export interface OAuthStoreOptions {
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  codeTtlSec: number;
  /** Hard cap per token map (default DEFAULT_MAX_TOKENS). Bounds memory. */
  maxTokens?: number;
  /**
   * Grace window (ms) before a client holding no live access/refresh token is
   * pruned. Must exceed a plausible authorize->token round-trip. Default 1h.
   */
  clientOrphanGraceMs?: number;
  /**
   * Absolute path of the optional state file. When set, registered clients and
   * (hashed) tokens are persisted across restarts. Requires `persistSecret`.
   */
  persistPath?: string;
  /**
   * Secret the state-file HMAC key is derived from (the OAuth login password).
   * Rotating it invalidates the persisted state — every session re-auths.
   */
  persistSecret?: string;
  now?: () => number;
}

function randomSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Tokens are looked up (never enumerated), so a one-way digest is enough. */
function tokenKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
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

interface PersistedTokenRecord extends TokenRecord {
  tokenHash: string;
}

interface PersistedPayload {
  clients: RegisteredClient[];
  accessTokens: PersistedTokenRecord[];
  refreshTokens: PersistedTokenRecord[];
}

export class OAuthStore {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  /** Keyed by sha256(token) — raw token values are never stored anywhere. */
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();
  private readonly now: () => number;
  private readonly maxTokens: number;
  private readonly clientOrphanGraceMs: number;
  private readonly persistPath?: string;
  /** scrypt(persistSecret, salt) — derived once per store, cached for saves. */
  private hmacKey?: Buffer;
  private hmacSalt?: Buffer;

  constructor(private readonly options: OAuthStoreOptions) {
    this.now = options.now ?? Date.now;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.clientOrphanGraceMs = options.clientOrphanGraceMs ?? DEFAULT_CLIENT_ORPHAN_GRACE_MS;
    if (options.persistPath) {
      if (!options.persistSecret) {
        throw new Error("OAuthStore persistence requires persistSecret (state-file HMAC key source).");
      }
      this.persistPath = path.resolve(options.persistPath);
      this.load(options.persistSecret);
    }
  }

  registerClient(redirectUris: string[], clientName?: string): RegisteredClient {
    this.prune();
    // Reap aged tokenless registrations HERE — a new registration is the moment
    // reconnect churn accumulates — and NOT inside the shared prune()/issueTokens
    // path: a refresh rotation deletes the presented token, then calls
    // issueTokens() -> prune() BEFORE the replacement is inserted, so an aged
    // client is briefly tokenless and must not be swept mid-rotation. The client
    // added below is within its grace window, so it is never the one pruned.
    this.pruneOrphanClients();
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
    this.save();
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
    resource: string;
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
      resource: params.resource,
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

  issueTokens(clientId: string, scope: string, resource: string): IssuedTokens {
    this.prune();
    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    this.accessTokens.set(tokenKey(accessToken), {
      clientId,
      scope,
      resource,
      expiresAt: this.now() + this.options.accessTokenTtlSec * 1000
    });
    this.refreshTokens.set(tokenKey(refreshToken), {
      clientId,
      scope,
      resource,
      expiresAt: this.now() + this.options.refreshTokenTtlSec * 1000
    });
    // Enforce the hard cap even when every entry is still live (pruning only
    // removes expired ones): evict the oldest live tokens so a client minting
    // tokens faster than they expire cannot grow the maps without bound.
    enforceCap(this.accessTokens, this.maxTokens);
    enforceCap(this.refreshTokens, this.maxTokens);
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresInSec: this.options.accessTokenTtlSec,
      scope
    };
  }

  /** Validate an access token. Returns the bound client/scope/resource or null. */
  validateAccessToken(token: string | null | undefined): { clientId: string; scope: string; resource: string } | null {
    if (!token) {
      return null;
    }
    const key = tokenKey(token);
    const record = this.accessTokens.get(key);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= this.now()) {
      this.accessTokens.delete(key);
      return null;
    }
    return { clientId: record.clientId, scope: record.scope, resource: record.resource };
  }

  /** Refresh-token rotation: the presented refresh token is invalidated. */
  rotateRefreshToken(refreshToken: string, clientId: string): IssuedTokens | null {
    const key = tokenKey(refreshToken);
    const record = this.refreshTokens.get(key);
    if (!record) {
      return null;
    }
    this.refreshTokens.delete(key);
    if (record.expiresAt <= this.now() || record.clientId !== clientId) {
      // The deletion above must still reach disk: single-use semantics for a
      // presented refresh token hold across restarts even on a failed rotation.
      this.save();
      return null;
    }
    // issueTokens() saves, covering the deletion in the success path too.
    return this.issueTokens(clientId, record.scope, record.resource);
  }

  private prune(): void {
    const t = this.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt <= t) this.codes.delete(code);
    }
    this.evictExpired();
  }

  /**
   * Drop client registrations that hold no live token and are older than the
   * orphan grace window. Tokens are the credential and self-expire; a
   * registration with no surviving token is dead weight that would otherwise
   * linger until the hard client cap evicts it. Invoked only from registerClient
   * (where reconnect churn accumulates) and after a state-file load —
   * deliberately NOT from the shared prune()/issueTokens path, where a refresh
   * rotation leaves an aged client momentarily tokenless (old token deleted,
   * replacement not yet inserted) and must not be swept. The grace window also
   * protects an in-flight registration that has not yet completed the token
   * exchange.
   */
  private pruneOrphanClients(): void {
    const t = this.now();
    const liveClientIds = new Set<string>();
    for (const record of this.accessTokens.values()) liveClientIds.add(record.clientId);
    for (const record of this.refreshTokens.values()) liveClientIds.add(record.clientId);
    for (const [clientId, client] of this.clients) {
      if (liveClientIds.has(clientId)) continue;
      if (t - client.createdAt >= this.clientOrphanGraceMs) {
        this.clients.delete(clientId);
      }
    }
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

  // --- persistence -----------------------------------------------------------
  // File layout: { version, salt, mac, payload } where `payload` is the JSON
  // *string* of PersistedPayload and `mac` = HMAC-SHA256(key, payload). Keeping
  // the payload as an opaque string makes the MAC byte-exact (no re-serialize
  // ambiguity). Any failure to verify/parse fails CLOSED: start empty.

  /** Fail-closed load: on any corruption/tamper/version/secret mismatch → empty. */
  private load(secret: string): void {
    if (!this.persistPath) {
      return;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.persistPath, "utf8");
    } catch {
      // Missing file is the normal first run; derive a fresh salt lazily on save.
      return;
    }
    try {
      const envelope = JSON.parse(raw) as { version?: unknown; salt?: unknown; mac?: unknown; payload?: unknown };
      if (
        envelope.version !== STATE_VERSION ||
        typeof envelope.salt !== "string" ||
        typeof envelope.mac !== "string" ||
        typeof envelope.payload !== "string"
      ) {
        throw new Error("bad envelope");
      }
      const salt = Buffer.from(envelope.salt, "hex");
      if (salt.length !== STATE_SALT_BYTES) {
        throw new Error("bad salt");
      }
      const key = crypto.scryptSync(secret, salt, HMAC_KEY_BYTES);
      const expected = crypto.createHmac("sha256", key).update(envelope.payload).digest();
      const presented = Buffer.from(envelope.mac, "hex");
      if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
        throw new Error("bad mac");
      }
      const payload = JSON.parse(envelope.payload) as PersistedPayload;
      const t = this.now();
      for (const client of payload.clients ?? []) {
        if (typeof client?.clientId === "string" && Array.isArray(client.redirectUris)) {
          this.clients.set(client.clientId, client);
        }
      }
      const loadTokens = (records: PersistedTokenRecord[] | undefined, into: Map<string, TokenRecord>) => {
        for (const record of records ?? []) {
          if (
            typeof record?.tokenHash === "string" &&
            typeof record.clientId === "string" &&
            typeof record.scope === "string" &&
            typeof record.resource === "string" &&
            typeof record.expiresAt === "number" &&
            record.expiresAt > t
          ) {
            into.set(record.tokenHash, {
              clientId: record.clientId,
              scope: record.scope,
              resource: record.resource,
              expiresAt: record.expiresAt
            });
          }
        }
      };
      loadTokens(payload.accessTokens, this.accessTokens);
      loadTokens(payload.refreshTokens, this.refreshTokens);
      // Loaded state may carry clients whose tokens all expired (and so were
      // dropped above); sweep those now instead of waiting for the next write.
      this.pruneOrphanClients();
      // Keep the verified salt/key for subsequent saves.
      this.hmacSalt = salt;
      this.hmacKey = key;
    } catch {
      // Never trust a state file that does not verify. No detail is logged (it
      // could echo attacker-controlled bytes); the operator symptom is simply
      // that clients must re-authorize.
      this.clients.clear();
      this.accessTokens.clear();
      this.refreshTokens.clear();
      console.error("[oauth] state file failed verification; starting with empty OAuth state");
    }
  }

  /** Atomic save (tmp + rename), 0600 file / 0700 dir. Failures only warn. */
  private save(): void {
    if (!this.persistPath) {
      return;
    }
    try {
      if (!this.hmacKey || !this.hmacSalt) {
        this.hmacSalt = crypto.randomBytes(STATE_SALT_BYTES);
        this.hmacKey = crypto.scryptSync(this.options.persistSecret ?? "", this.hmacSalt, HMAC_KEY_BYTES);
      }
      const payload: PersistedPayload = {
        clients: [...this.clients.values()],
        accessTokens: [...this.accessTokens.entries()].map(([tokenHash, r]) => ({ tokenHash, ...r })),
        refreshTokens: [...this.refreshTokens.entries()].map(([tokenHash, r]) => ({ tokenHash, ...r }))
      };
      const payloadJson = JSON.stringify(payload);
      const mac = crypto.createHmac("sha256", this.hmacKey).update(payloadJson).digest("hex");
      const envelope = JSON.stringify({
        version: STATE_VERSION,
        salt: this.hmacSalt.toString("hex"),
        mac,
        payload: payloadJson
      });
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true, mode: 0o700 });
      const tmp = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmp, envelope, { mode: 0o600 });
      fs.renameSync(tmp, this.persistPath);
    } catch {
      // Persistence is an availability feature; a failed save must not break
      // auth. No path/error detail beyond this line (no secrets to leak, but
      // keep the log surface minimal).
      console.error("[oauth] failed to persist OAuth state");
    }
  }
}
