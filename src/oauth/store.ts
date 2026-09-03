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
//  - refresh-token rotation invalidates the presented token, with a short
//    replay-grace window (ROTATION_GRACE_MS) so a rotation whose RESPONSE was
//    lost in transit does not strand the client with an already-dead token: a
//    rotated token re-presented inside the window rotates again, and every
//    generation minted downstream of the lost response is revoked at that
//    moment (the legitimate client provably never received it, and an
//    interceptor who rotated what they captured is reached however many hops
//    they took — see revokeFamilyAbove, which finds them by what the records
//    carry rather than by links between them, so no intermediate record has to
//    survive for its descendants to be reachable). The window never
//    extends on replay, its state is written to disk on every transition, and
//    beyond it single-use semantics hold across restarts exactly as before,
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

// How long a refresh token stays replayable after it was rotated. Sized for
// "the rotation response was lost on an unreliable link and the client retries
// promptly" — NOT for offline recovery (a client that comes back hours later
// re-authorizes, as before).
//
// What the window bounds is the OPPORTUNITY to replay. It does not bound what a
// replay yields: whoever presents the token is served an independently
// rotatable pair on the ordinary refresh TTL, which goes on rotating after the
// window shuts. Nor is the exposure contained once it surfaces — the replay
// does revoke the legitimate client's pair, so the theft shows up as a forced
// re-auth rather than hiding, but a later legitimate re-authorization mints a
// new family and leaves the replayer's alive.
//
// That is a trade taken knowingly, not an oversight. This is a public client
// using PKCE: at refresh time there is nothing only the legitimate client
// holds, so recovery cannot be bound to it, and the choice is between stranding
// a client whose response was lost and letting a copied token escalate. A
// shorter window moves along that line rather than leaving it;
// proof-of-possession (DPoP, RFC 9449) is what would remove it, and it is not
// implemented here. #159 carries the measurements and the reasoning; it was
// closed by accepting the trade, so what is written above is the decision and
// not a placeholder for one.
export const ROTATION_GRACE_MS = 60 * 1000;

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
  /**
   * Refresh tokens only — set the first time the token is rotated. Presence
   * marks the record as "already rotated, alive only for the replay-grace
   * window"; `expiresAt` is capped to `rotatedAt + ROTATION_GRACE_MS` at the
   * same moment, so the ordinary expiry sweep retires it. Never updated on
   * replay (the window must not extend).
   */
  rotatedAt?: number;
  /**
   * The rotation lineage this token belongs to. A fresh grant opens a new
   * family; every pair minted by rotating within it inherits the id. Opaque and
   * random — it names a lineage, it is not derived from any token, so it never
   * weakens hash-at-rest.
   */
  familyId: string;
  /**
   * Position in the lineage, counting from 0 at the fresh grant. A replay
   * inside the grace window revokes every member of the same family ABOVE its
   * own generation: the client re-presenting the OLD token proves the response
   * carrying those never arrived, so if anyone else holds them it is an
   * interceptor.
   *
   * Membership is a property of each record, so revocation is a scan of the
   * two maps rather than a walk of links between them. That is the whole point:
   * a walk terminates at the first missing hop, and any deletion — a failed
   * presentation, the expiry sweep, the hard cap — can remove one. A scan
   * reaches the same descendants whether or not their ancestors still exist.
   */
  generation: number;
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

/**
 * Evict the oldest entries (Map preserves insertion order) until size <= max.
 *
 * `spare` names one key the sweep reaches for last: the refresh record a
 * rotation is currently minting a successor for. That record is the oldest
 * live entry by construction — it was issued before everything minted from it,
 * and capping its `expiresAt` for the replay window mutates a value, which
 * does not move a Map entry. So a full map evicts exactly the record the
 * rotation is standing on, and the linkage assigned to it a line later is
 * written to an object no longer in the map: the lost-response retry finds
 * nothing, AND the revocation that retry would have performed never runs.
 *
 * It is a preference, not a veto — when `spare` is the only entry left the
 * sweep takes it anyway, so one key can never hold the map above its cap.
 *
 * ⚠️ Deliberately narrow. Sparing in-window records from EVERY mint was built
 * and measured (2026-09-02) and is worse: with the map saturated by records
 * inside their windows, the sweep starts evicting freshly issued grants
 * instead — survival vector 111100 for six roots at cap 4, where the last two
 * grants were evicted in the same call that issued them. A 60-second recovery
 * convenience must not cost new authorizations. What that leaves open is an
 * interceptor who drives the sweep on purpose; it is measured and bounded on
 * `rotateRefreshToken` rather than hidden here.
 */
function enforceCap<K, V>(map: Map<K, V>, max: number, spare?: K): void {
  while (map.size > max) {
    let victim: K | undefined;
    let oldest: K | undefined;
    for (const key of map.keys()) {
      if (oldest === undefined) {
        oldest = key;
      }
      if (key !== spare) {
        victim = key;
        break;
      }
    }
    const doomed = victim ?? oldest;
    if (doomed === undefined) {
      break;
    }
    map.delete(doomed);
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
    // reconnect churn accumulates — and NOT inside the shared prune()/mintTokens
    // path. The hazard first written here has stopped existing: it said a
    // rotation deletes the presented token and so leaves an aged client briefly
    // tokenless between prune() and the replacement's insertion. Since the
    // replay-grace window landed, a successful rotation KEEPS that record, so a
    // live refresh token spans the whole mint and that window never opens.
    //
    // What the placement is actually for: a registration that has not yet
    // exchanged its code holds no token, so anything reaping tokenless clients
    // would take it mid-flow. Calling it only here does not make that safe —
    // clientOrphanGraceMs (default one hour) does, and it is a sizing
    // assumption rather than a structural one. See #184; a consent screen left
    // open past the hour breaks it.
    //
    // The client added below is not the one at risk, and not because of any
    // window: it does not exist yet. It is constructed and inserted after this
    // line.
    this.pruneOrphanClients();
    if (this.clients.size >= DEFAULT_MAX_CLIENTS) {
      this.evictOneClientForCap();
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
    const issued = this.mintTokens(clientId, scope, resource);
    this.save();
    return issued;
  }

  /**
   * Mint a pair WITHOUT saving. Exists so `rotateRefreshToken` can persist the
   * revocation of the superseded generations and the pair that replaces them in
   * ONE atomic save (tmp + rename): a save between them is a crash window where
   * disk holds one of the two states nothing else can repair. Every
   * non-rotation caller goes through `issueTokens`, which saves immediately.
   *
   * `lineage` omitted means a fresh grant: a new family at generation 0.
   */
  private mintTokens(
    clientId: string,
    scope: string,
    resource: string,
    lineage?: { familyId: string; generation: number },
    spareRefreshKey?: string
  ): IssuedTokens {
    this.prune();
    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    const familyId = lineage?.familyId ?? randomSecret();
    const generation = lineage?.generation ?? 0;
    this.accessTokens.set(tokenKey(accessToken), {
      clientId,
      scope,
      resource,
      familyId,
      generation,
      expiresAt: this.now() + this.options.accessTokenTtlSec * 1000
    });
    this.refreshTokens.set(tokenKey(refreshToken), {
      clientId,
      scope,
      resource,
      familyId,
      generation,
      expiresAt: this.now() + this.options.refreshTokenTtlSec * 1000
    });
    // Enforce the hard cap even when every entry is still live (pruning only
    // removes expired ones): evict the oldest live tokens so a client minting
    // tokens faster than they expire cannot grow the maps without bound.
    enforceCap(this.accessTokens, this.maxTokens);
    // Only the refresh map takes the preference: a rotated root's own access
    // token was superseded by its first rotation and is not part of what a
    // replay hands back.
    enforceCap(this.refreshTokens, this.maxTokens, spareRefreshKey);
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

  /**
   * Refresh-token rotation with a bounded replay-grace window.
   *
   * Why not strict single-use: the response carrying the new pair travels over
   * the same unreliable link that motivates refreshing at all. Deleting the
   * presented token BEFORE the client has the replacement means one lost
   * response strands the client with nothing but a dead token — the next
   * refresh is `invalid_grant` and the user is forced back through the full
   * authorize flow (observed in production, 2026-08-30 incident). So:
   *
   *  - First presentation: mark the record rotated (`rotatedAt`), cap its
   *    `expiresAt` to the grace window, and mint a fresh pair.
   *  - Re-presentation INSIDE the window: the client provably never received
   *    the previous response, so revoke every generation of this token's
   *    family above its own (if an interceptor holds any of it — even after
   *    rotating what they captured — it dies here) and mint another fresh
   *    pair. `rotatedAt` is never touched again — replays cannot extend the
   *    window.
   *  - Re-presentation AFTER the window: the record has expired (the cap above)
   *    or been swept; the token is dead, exactly as under strict single-use.
   *
   * Every transition is saved to disk immediately, so replay semantics hold
   * across restarts the same way single-use failure did before.
   */
  rotateRefreshToken(refreshToken: string, clientId: string): IssuedTokens | null {
    const key = tokenKey(refreshToken);
    const record = this.refreshTokens.get(key);
    if (!record) {
      return null;
    }
    const t = this.now();
    if (record.expiresAt <= t) {
      this.refreshTokens.delete(key);
      // Nothing else is revoked here, deliberately. This arm is reached by a
      // spent presentation, which is not evidence that the lineage is
      // compromised — and revoking on it would let anyone holding a COPY of a
      // spent token destroy the legitimate client's live pair at will.
      // Removing this record cannot hide a descendant either: membership lives
      // on the descendants themselves, so a later replay of an ancestor still
      // reaches them by generation.
      //
      // The deletion must still reach disk: a dead presented token stays dead
      // across restarts even on a failed rotation.
      this.save();
      return null;
    }
    if (record.clientId !== clientId) {
      // Misdirected presentation. Refused, and — for a record inside its
      // replay-grace window — refused WITHOUT touching it.
      //
      // `client_id` arrives unauthenticated on the /token form (public client,
      // token_endpoint_auth_method "none"), so a mismatch proves nothing about
      // the presenter: anyone who has seen the refresh token can send it under
      // any client_id they like. Deleting an already-rotated record on that
      // basis would hand them the one thing they want gone — a re-presentation
      // of THIS record is the sole trigger for revokeFamilyAbove, so destroying
      // it turns the legitimate client's retry into a plain `invalid_grant`
      // and lets an interceptor of the lost response keep rotating what they
      // captured, unrevoked and unnoticed.
      //
      // A never-rotated record is still deleted, exactly as before: it has no
      // family above it, so no revocation trigger is lost with it.
      //
      // Still no revocation on this arm — see the reasoning above; treating a
      // mismatch as reuse evidence is what would let a copied token kill the
      // live pair.
      if (record.rotatedAt === undefined) {
        this.refreshTokens.delete(key);
        this.save();
      }
      return null;
    }
    if (record.rotatedAt === undefined) {
      record.rotatedAt = t;
      // The ordinary expiry sweep (evictExpired / load) retires the record once
      // the window closes — no separate cleanup path to get wrong.
      record.expiresAt = Math.min(record.expiresAt, t + ROTATION_GRACE_MS);
    } else {
      // Replay inside the window (outside it, the expiry check above already
      // returned). Everything minted downstream of the lost response is
      // revoked — every generation of this family above this one, not just the
      // pair directly minted for it: an interceptor who captured the lost
      // response can rotate it and put their live pair further up the lineage.
      this.revokeFamilyAbove(record.familyId, record.generation);
    }
    // Mint WITHOUT saving, then save ONCE: the revocation above and the pair
    // that replaces it must hit disk in the same atomic write, or a crash
    // between two saves leaves disk holding one without the other.
    // `key` is spared from the cap for the length of this mint: inserting the
    // successor must not evict the record this rotation is standing on.
    //
    // ⚠️ Residual, stated rather than fixed — and it is not merely bad luck.
    // Once this call returns the record is an ordinary entry again, and an
    // interceptor holding the lost response can push it out DELIBERATELY:
    // rotating the chain they captured adds an entry per rotation, and at
    // `maxTokens - 1` rotations inside the window the root is swept, so the
    // replay that would have revoked their family returns `invalid_grant`
    // instead and their pair survives. Measured independently by two sessions
    // (2026-09-02): at cap 4 the flip is exactly at 3 rotations, and a large
    // cap is the control. Nothing outside this file sets `maxTokens`, so the
    // shipped cost is ~1999 rotations inside ROTATION_GRACE_MS (60 s);
    // whether that rate is reachable through the HTTP endpoint was NOT
    // measured, and is the number to check before re-weighing this.
    //
    // Not closed here because the obvious close is worse: sparing every
    // in-window record from every mint was built and measured evicting
    // freshly issued grants instead (see enforceCap). Pre-filling does not
    // help an attacker — eviction is insertion-ordered, so entries older than
    // the root are swept first, and the cap must be filled after it exists.
    const issued = this.mintTokens(
      clientId,
      record.scope,
      record.resource,
      { familyId: record.familyId, generation: record.generation + 1 },
      key
    );
    this.save();
    return issued;
  }

  /**
   * Delete every access and refresh token in `familyId` above `generation`.
   *
   * A scan, not a walk. The records that must die are identified by what they
   * carry, so no intermediate record has to survive for them to be found —
   * which is the failure this replaced: links stored in the records themselves
   * made the chain only as reachable as its least durable hop, and three
   * separate deletion paths could remove one. Cost is bounded by the token cap
   * (`maxTokens`), which the two maps are held under at every mint.
   */
  private revokeFamilyAbove(familyId: string, generation: number): void {
    for (const map of [this.accessTokens, this.refreshTokens]) {
      for (const [key, record] of map) {
        if (record.familyId === familyId && record.generation > generation) {
          map.delete(key);
        }
      }
    }
  }

  private prune(): void {
    const t = this.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt <= t) this.codes.delete(code);
    }
    this.evictExpired();
  }

  /**
   * Free one slot for a new registration, preferring one that holds no live
   * credential.
   *
   * Age alone is the wrong order to delete in. A client whose registration is
   * evicted while it still holds a valid access token — or a refresh token it
   * can rotate — keeps working at `/token` and fails only the next time it
   * reaches `/authorize`, where `getClient` no longer knows it. The registry
   * and the credentials it is supposed to describe then disagree, and the
   * client cannot refresh its way out: recovery costs a re-registration.
   * Measured 2026-09-03 on #184: with the shipped cap, a client holding a live
   * pair was evicted by 100 registrations while its access token still
   * validated and its refresh token still rotated.
   *
   * Tokenless registrations have no such state to contradict, so they go
   * first, oldest first. `prune()` has already run at the top of
   * `registerClient`, so an expired token is not counted as live.
   *
   * That preference has a cost, and it lands on the class #184 is about. The
   * orphan sweep immediately above has already removed every tokenless
   * registration past its grace window, so every tokenless candidate left here
   * is one still inside it: a registration that has not exchanged its code
   * yet. Preferring them means an in-flight authorization is now the first
   * thing offered to the cap. Measured 2026-09-03 either side of #185, with an
   * oldest token-holder and a second in-flight registration and the cap driven
   * past its limit: before, the holder was evicted and the in-flight one
   * survived; after, exactly the reverse.
   *
   * It is a trade and not an oversight. Both evictions end in the same 400
   * with no machine-readable OAuth error, but an evicted holder breaks
   * silently and later — at an `/authorize` it had no reason to expect to
   * fail, while it was still refreshing successfully — and an in-flight
   * registration breaks now, in a flow someone is watching. The cap has to
   * take one of them; this picks the failure that is visible when it happens.
   *
   * The bound is unchanged: exactly one registration is removed per call, and
   * when every one of them holds a live token the oldest still goes — the cap
   * has to be enforced with something. `DEFAULT_MAX_CLIENTS` has no options
   * field and no environment override, so this order is the shipped one and
   * an operator cannot tune around it.
   */
  private evictOneClientForCap(): void {
    const holdsLiveToken = new Set<string>();
    for (const record of this.accessTokens.values()) holdsLiveToken.add(record.clientId);
    for (const record of this.refreshTokens.values()) holdsLiveToken.add(record.clientId);
    const oldestFirst = [...this.clients.values()].sort((a, b) => a.createdAt - b.createdAt);
    const victim = oldestFirst.find((client) => !holdsLiveToken.has(client.clientId)) ?? oldestFirst[0];
    if (victim) {
      this.clients.delete(victim.clientId);
    }
  }

  /**
   * Drop client registrations that hold no live token and are older than the
   * orphan grace window. Tokens are the credential and self-expire; a
   * registration with no surviving token is dead weight that would otherwise
   * linger until the hard client cap evicts it. Invoked only from registerClient
   * (where reconnect churn accumulates) and after a state-file load —
   * deliberately NOT from the shared prune()/mintTokens path. The reason given
   * for that used to be a rotation leaving an aged client momentarily tokenless
   * between prune() and the replacement's insertion; the replay-grace window
   * ended it, because a successful rotation keeps the presented record. What
   * the grace window protects is an in-flight registration — no token until the
   * code is exchanged — and it protects it by being an hour long, not by any
   * structural guarantee. The other caller on that path is
   * createAuthorizationCode. See #184.
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
            const loaded: TokenRecord = {
              clientId: record.clientId,
              scope: record.scope,
              resource: record.resource,
              expiresAt: record.expiresAt,
              // A record whose lineage did not survive validation is loaded
              // into a family of its own at generation 0: it can neither
              // revoke another token nor be revoked by one. That is the
              // conservative reading of unusable state — the alternative,
              // defaulting to a shared id, would let one malformed record
              // revoke every live token in the store.
              familyId: typeof record.familyId === "string" ? record.familyId : randomSecret(),
              generation:
                typeof record.generation === "number" && Number.isInteger(record.generation) && record.generation >= 0
                  ? record.generation
                  : 0
            };
            // Rotation-grace state must survive a restart, or a replay after a
            // supervisor bounce would look like a first rotation and re-open
            // the window. Validated individually; an absent field (a pre-grace
            // state file) loads as never-rotated.
            if (typeof record.rotatedAt === "number") {
              loaded.rotatedAt = record.rotatedAt;
            }
            into.set(record.tokenHash, loaded);
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
