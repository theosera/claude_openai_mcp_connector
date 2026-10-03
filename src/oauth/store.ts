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
//    password (scrypt-derived): tampering, corruption, or another password
//    fails CLOSED — the store holds nothing from the file, never writes it,
//    and the server refuses to start (#263); rotating the password means
//    moving the old file aside first,
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
//  - every collection is capped to bound memory (DoS via unbounded dynamic
//    client registration / token minting). Codes and tokens are also pruned
//    as they expire. Client registrations are pruned only while nobody has
//    consented to them: one the owner has authorized is kept until an operator
//    removes it, and a full registry refuses new ones instead of evicting old
//    ones. See registerClient (#184).

export const DEFAULT_MAX_CLIENTS = 100;

/**
 * How long a registration may wait for its first consent before it can be
 * reclaimed (#184). A provisional value: nothing was measured to choose it. It
 * is the window a consent page can be left open before a client whose
 * registration was reclaimed has to register again — Claude.ai does that on
 * its own, ChatGPT only by deleting and recreating its app.
 */
export const REGISTRATION_CONSENT_DEADLINE_MS = 24 * 60 * 60 * 1000;

/**
 * How many registrations may be waiting for their first consent at once,
 * counted INSIDE DEFAULT_MAX_CLIENTS rather than on top of it. A provisional
 * value like the deadline above. Its job is to keep the slots an anonymous
 * caller can take away from the ones the owner has already authorized.
 */
export const MAX_UNCONSENTED_CLIENTS = 20;
const DEFAULT_MAX_CODES = 1000;
const DEFAULT_MAX_TOKENS = 2000;

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

/**
 * Where a registration stands with the owner (#184).
 *
 *  - `pending`: registered, and nobody has entered the password for it yet.
 *    Anyone who can reach `/register` can create one, so these are the only
 *    registrations that are ever reclaimed on their own, and only after
 *    REGISTRATION_CONSENT_DEADLINE_MS.
 *  - `given`: the owner consented at least once. Kept even after every token it
 *    held has lapsed, because a client comes back with the same `client_id`
 *    (ChatGPT never registers again on its own).
 *  - `unknown`: loaded from a state file written before this field existed.
 *    Such a file cannot tell a registration that was used and whose tokens all
 *    lapsed from one that was never used, so it is kept like `given` and never
 *    presumed abandoned.
 */
export type ClientConsent = "pending" | "given" | "unknown";

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
  consent: ClientConsent;
}

export type LoadOutcome = "absent" | "loaded" | "failed";

/**
 * Why a state file did not load. Fixed values only: an errno-shaped read code,
 * a symbolic link at the path, or that the file did not verify. Nothing read
 * from the file or the error.
 */
type LoadFailure = { kind: "unreadable"; code: string } | { kind: "symlink" } | { kind: "unverified" };

/**
 * What one read of a state file found: its bytes with the identity of the file
 * they came from, nothing at the path, or why it could not be read. Only
 * `readStateFile` makes these; a store given one checks that.
 */
export type StateFileRead =
  | {
      readonly kind: "read";
      readonly file: string;
      readonly bytes: Buffer;
      readonly uid: number;
      readonly dev: number;
      readonly ino: number;
    }
  | { readonly kind: "absent"; readonly file: string }
  | { readonly kind: "failed"; readonly file: string; readonly failure: Exclude<LoadFailure, { kind: "unverified" }> };

/** Every `StateFileRead` that `readStateFile` returned, so a store can refuse one made by hand. */
const issuedReads = new WeakSet<StateFileRead>();

/**
 * Read the state file once, the way the store loads it: O_NOFOLLOW, so a
 * symbolic link at the path fails to open instead of being followed, in the
 * same call that opens a regular file, and no link can be swapped in between
 * a check and the read. The bytes and the identity come from that one
 * descriptor. Only nothing at the path is `absent`; a link, with its target or
 * without, and any other read error are `failed`. Only the error code is kept:
 * the caught error's message carries the path.
 */
export function readStateFile(file: string): StateFileRead {
  const resolved = path.resolve(file);
  let result: StateFileRead;
  try {
    const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      result = {
        kind: "read",
        file: resolved,
        bytes: fs.readFileSync(fd),
        uid: stat.uid,
        dev: stat.dev,
        ino: stat.ino
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // What is at the path itself: a Stats, null for nothing at all, or
    // undefined when that cannot be told either.
    const there = (() => {
      try {
        return fs.lstatSync(resolved);
      } catch (inner) {
        return (inner as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
      }
    })();
    result =
      code === "ENOENT" && there === null
        ? { kind: "absent", file: resolved }
        : {
            kind: "failed",
            file: resolved,
            failure: there?.isSymbolicLink()
              ? { kind: "symlink" }
              : {
                  kind: "unreadable",
                  code: typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "an unknown error"
                }
          };
  }
  // Frozen, so what the WeakSet vouches for stays what was found: code in the
  // same process cannot turn a refused read into `absent` and have a store
  // start on it. A Buffer's bytes cannot be frozen; changed, they fail the
  // MAC like any other change to the file.
  if (result.kind === "failed") {
    Object.freeze(result.failure);
  }
  Object.freeze(result);
  issuedReads.add(result);
  return result;
}

/** One registration as the operator command shows it. Carries no credential. */
export interface RegistrationListing {
  clientId: string;
  consent: ClientConsent;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
  liveAccessTokens: number;
  liveRefreshTokens: number;
}

/** What removing one registration takes with it. */
export interface RegistrationRemoval {
  accessTokens: number;
  refreshTokens: number;
  tombstones: number;
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

/**
 * What a rotated refresh record leaves behind, so that the replay trigger no
 * longer depends on the record surviving.
 *
 * The record is kept after rotation for exactly one reason: re-presenting it is
 * the SOLE trigger for `revokeFamilyAbove`. Anything that removes it early
 * disarms that trigger silently, and the hard cap is such a path an interceptor
 * can drive on purpose (#170 — see the note in `rotateRefreshToken`). This
 * carries the three things the trigger needs (which family, from which
 * generation, until when) plus the client it was bound to, and nothing else.
 *
 * It is not a second copy of a credential. The key is the same sha256(token)
 * the token maps already use, `familyId` is opaque and random, and there is no
 * scope or resource here to mint on: a tombstone can revoke, it can never
 * issue.
 */
interface RotationTombstone {
  /** Bound at rotation time. A mismatched client_id is refused here, as on the record path. */
  clientId: string;
  familyId: string;
  generation: number;
  /** The record's CAPPED expiry, copied verbatim — the window must not extend. */
  expiresAt: number;
}

export interface OAuthStoreOptions {
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  codeTtlSec: number;
  /** Hard cap per token map (default DEFAULT_MAX_TOKENS). Bounds memory. */
  maxTokens?: number;
  /**
   * Absolute path of the optional state file. When set, registered clients and
   * (hashed) tokens are persisted across restarts. Requires `persistSecret`.
   */
  persistPath?: string;
  /**
   * Secret the state-file HMAC key is derived from (the OAuth login password).
   * A file written under another secret does not verify, and the store will
   * not start on it (#263): rotating the secret means moving the old file
   * aside first, which is what revokes every persisted session.
   */
  persistSecret?: string;
  /**
   * `false` keeps loading from writing the state file. The server leaves this
   * on, so a consent read from live tokens is written while its proof exists.
   * The operator command turns it off: it reads a file a running server may
   * own, its `list` and dry run must write nothing, and an `--apply` writes
   * the promotion together with the removal (#184).
   */
  writeAtLoad?: boolean;
  /**
   * A read of `persistPath` the caller already made with `readStateFile`. The
   * store loads from it instead of reading the path again, so the bytes the
   * caller checked are the bytes it loads (#273). It is verified and refused
   * exactly as a read the store makes itself; one that `readStateFile` did not
   * make, or that read another path, throws.
   */
  stateFileRead?: StateFileRead;
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

/**
 * Hold the tombstone map at its cap.
 *
 * ⚠️ Deliberately NOT `enforceCap`'s oldest-first order, and that difference is
 * the whole reason the map exists. Tombstones are written by rotating, which is
 * the primitive #170 is about: an interceptor rotating the chain they captured
 * writes one per hop. Oldest-first would hand them the same lever one map
 * over — flood it and the victim's tombstone, written first, is swept first,
 * and the fix would buy nothing but a factor of two.
 *
 * So the sweep is aimed at the flood instead:
 *   1. the NEWEST tombstone of a family that holds more than one, else
 *   2. the newest overall — which, called from an insert, is the entry that
 *      just arrived.
 * An interceptor can only rotate inside the family they captured (every hop
 * inherits its `familyId`), so their hops are exactly what (1) selects, and the
 * one tombstone that must survive — the root's — is the oldest of that family
 * and the last of it to go. The property that follows, and the one to preserve
 * if this is ever rewritten: a tombstone already written is never displaced by
 * a later rotation.
 *
 * Normal use does not reach this at all. A family writes one tombstone per
 * FIRST rotation of a record and each lives ROTATION_GRACE_MS (60 s), so a
 * second live tombstone in one family means two successful rotations inside a
 * minute.
 */
function enforceTombstoneCap(map: Map<string, RotationTombstone>, max: number): void {
  while (map.size > max) {
    const perFamily = new Map<string, number>();
    for (const tombstone of map.values()) {
      perFamily.set(tombstone.familyId, (perFamily.get(tombstone.familyId) ?? 0) + 1);
    }
    let doomed: string | undefined;
    // Map preserves insertion order, so the LAST match is the newest.
    for (const [key, tombstone] of map) {
      if ((perFamily.get(tombstone.familyId) ?? 0) > 1) {
        doomed = key;
      }
    }
    if (doomed === undefined) {
      for (const key of map.keys()) {
        doomed = key;
      }
    }
    if (doomed === undefined) {
      break;
    }
    map.delete(doomed);
  }
}

interface PersistedTokenRecord extends TokenRecord {
  tokenHash: string;
}

interface PersistedTombstone extends RotationTombstone {
  tokenHash: string;
}

interface PersistedPayload {
  clients: RegisteredClient[];
  accessTokens: PersistedTokenRecord[];
  refreshTokens: PersistedTokenRecord[];
  /**
   * Added after STATE_VERSION 1 shipped, and deliberately WITHOUT bumping it: a
   * bump fails closed — since #263 every deployment would refuse to start on
   * its old file until it was moved aside, and every live session would then
   * re-authorize — to gain a field that is additive in both directions. An older file loads it as absent (`??
   * []`, like `clients`); an older binary reading a newer file ignores the key,
   * and the MAC is taken over the payload string either way.
   *
   * The cost of not bumping, stated rather than discovered later: rolling
   * back to a binary without this field disables the mitigation SILENTLY.
   * The state file still loads, the key is ignored, and nothing is logged,
   * so an operator cannot tell "the mitigation is running" from "the
   * mitigation is gone" - #170 simply returns, and nothing gets worse. The
   * alternative stops every deployment until an operator moves its state file
   * aside, and costs every live session a re-authorization, which is the
   * higher price; this is the trade, not an oversight.
   */
  rotatedTombstones?: PersistedTombstone[];
}

export class OAuthStore {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  /** Keyed by sha256(token) — raw token values are never stored anywhere. */
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();
  /**
   * Rotated refresh records, keyed the same way, outliving the records
   * themselves (#170). Keyed by sha256(token) in memory and at rest, exactly as
   * the token maps are.
   */
  private readonly rotatedTombstones = new Map<string, RotationTombstone>();
  private readonly now: () => number;
  private readonly maxTokens: number;
  /**
   * Tombstone cap. The same number as `maxTokens` rather than a new knob:
   *  - a tombstone is written only where a refresh record is first rotated, so
   *    the two maps grow on the same events and one bound describes both;
   *  - a tombstone is smaller than the TokenRecord it outlives, so this raises
   *    a bound the operator has already accepted by less than the refresh map
   *    itself costs;
   *  - in steady state it is far below that, because a tombstone lives
   *    ROTATION_GRACE_MS (60 s) while a refresh record lives the refresh TTL
   *    (default 30 days). Filling it therefore takes `maxTokens` rotations
   *    inside one minute — the same rate the #170 note names, and whether that
   *    rate is reachable through the HTTP endpoint is still NOT measured.
   */
  private readonly maxTombstones: number;
  private readonly persistPath?: string;
  /** scrypt(persistSecret, salt) — derived once per store, cached for saves. */
  private hmacKey?: Buffer;
  private hmacSalt?: Buffer;
  private loadResult: LoadOutcome = "absent";
  private loadFailure?: LoadFailure;

  constructor(private readonly options: OAuthStoreOptions) {
    this.now = options.now ?? Date.now;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxTombstones = this.maxTokens;
    if (options.stateFileRead !== undefined && !options.persistPath) {
      // A read of a state file with nowhere to load it would be dropped
      // silently, and the caller would believe it had been checked.
      throw new Error("stateFileRead needs persistPath: it is a read of the state file.");
    }
    if (options.persistPath) {
      if (!options.persistSecret) {
        throw new Error("OAuthStore persistence requires persistSecret (state-file HMAC key source).");
      }
      this.persistPath = path.resolve(options.persistPath);
      this.load(options.persistSecret);
    }
  }

  /**
   * Register a client as `pending`, or return `undefined` when there is no room.
   * Throws `registration_not_persisted` when a state file is configured and the
   * registration could not be written to it.
   *
   * What may be removed without an operator is decided by consent, not by
   * tokens (#184, measured 2026-09-28):
   *
   *  - ChatGPT keeps the `client_id` it registered with the app and never
   *    registers again on its own. Deleting that registration leaves the app
   *    presenting a `client_id` this server no longer knows, and `/authorize`
   *    answers `400 Unknown client_id.` on every attempt. Uninstalling and
   *    reinstalling the app did not help; only deleting and recreating it
   *    did. OpenAI's own docs say a client reuses its registration for as
   *    long as the connection is used. So a registration the owner has
   *    consented to is kept even once every token it held has lapsed.
   *  - A registration still waiting on its first consent holds no token. The
   *    old orphan sweep took it after a one-hour grace window, so a consent
   *    page left open past the hour lost it. It is now kept for
   *    REGISTRATION_CONSENT_DEADLINE_MS, and the deadline runs from creation:
   *    no unauthenticated request moves it.
   *  - Keeping every registration, which the first attempt at this did, lets
   *    anyone who can reach `/register` fill the registry for good. So an
   *    unconsented registration past its deadline IS reclaimed, here and at
   *    load, and nothing else is.
   *
   * Nothing is evicted to make room. When the registry holds
   * DEFAULT_MAX_CLIENTS, or MAX_UNCONSENTED_CLIENTS of them are pending, a new
   * registration is refused and every existing one keeps working.
   *
   * What is left, stated rather than hidden: a caller who keeps registering
   * keeps the pending slots full, and new connectors cannot register for as
   * long as they do. The `/register` rate limit bounds how fast that happens
   * and does not stop it. It is keyed on the socket peer, so behind a tunnel
   * every caller shares one bucket and a flood also spends the requests a
   * genuine newcomer needs. What the deadline changes is afterwards: the slots
   * come back once the caller stops, and the connectors the owner has
   * authorized are never touched.
   */
  registerClient(redirectUris: string[], clientName?: string): RegisteredClient | undefined {
    this.prune();
    this.reclaimUnconsented();
    if (this.clients.size >= DEFAULT_MAX_CLIENTS || this.countPending() >= MAX_UNCONSENTED_CLIENTS) {
      return undefined;
    }
    const client: RegisteredClient = {
      clientId: `client_${randomSecret()}`,
      redirectUris,
      clientName,
      createdAt: this.now(),
      consent: "pending"
    };
    this.clients.set(client.clientId, client);
    // A registration answered with 201 that is gone after a restart strands
    // ChatGPT exactly as a reclaimed one does, so it is not answered at all.
    if (!this.persist()) {
      this.clients.delete(client.clientId);
      throw new Error("registration_not_persisted");
    }
    return client;
  }

  /**
   * Record that the owner consented to this client, and report whether that
   * reached the state file (always true without one). Call it after the
   * password has been checked and BEFORE issuing a code: a code then only
   * ever exists for a registration that can no longer be reclaimed.
   *
   * It saves on every call, even when the client is already `given`. Skipping
   * the save for a client that is `given` in memory would reopen the gap it
   * closes: after one failed save the memory says `given` while the disk still
   * says `pending`, and a retry that skipped the save would issue a code for a
   * registration a restart would reclaim.
   */
  recordConsent(clientId: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      return false;
    }
    client.consent = "given";
    return this.persist();
  }

  /**
   * Drop the registrations nobody consented to within the deadline. They never
   * held a code or a token (a code is only issued after `recordConsent`), so
   * nothing else refers to them.
   */
  private reclaimUnconsented(): void {
    const t = this.now();
    for (const [clientId, client] of this.clients) {
      if (client.consent === "pending" && client.createdAt + REGISTRATION_CONSENT_DEADLINE_MS <= t) {
        this.clients.delete(clientId);
      }
    }
  }

  /**
   * Read a `pending` registration that holds a live token as `given`: a token
   * is only ever issued after the password was entered, so it is proof of
   * consent. This version never produces that combination. A state file
   * carried back through an older binary, which consents without recording
   * it, and then forward again does — and without this, a working ChatGPT
   * connection would be reclaimed 24 h after its creation while its tokens
   * went on refreshing with no registration behind them. Once every token has
   * lapsed there is no proof left, and such a registration reads as the
   * `pending` it was saved as. Returns how many were promoted, so load can
   * write them down while the proof still exists.
   */
  private consentFromLiveTokens(): number {
    const holders = new Set<string>();
    for (const record of this.accessTokens.values()) holders.add(record.clientId);
    for (const record of this.refreshTokens.values()) holders.add(record.clientId);
    let promoted = 0;
    for (const client of this.clients.values()) {
      if (client.consent === "pending" && holders.has(client.clientId)) {
        client.consent = "given";
        promoted++;
      }
    }
    return promoted;
  }

  /**
   * How many registrations stand in each state — numbers only, never an id or
   * a URI. For the start-up line (#184): registrations carried over from an
   * older state file are kept as `unknown`, and an operator can only tell that
   * they fill the registry by counting them.
   */
  registrationCounts(): Record<ClientConsent, number> {
    const counts: Record<ClientConsent, number> = { given: 0, pending: 0, unknown: 0 };
    for (const client of this.clients.values()) {
      counts[client.consent]++;
    }
    return counts;
  }

  private countPending(): number {
    let pending = 0;
    for (const client of this.clients.values()) {
      if (client.consent === "pending") pending++;
    }
    return pending;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  /**
   * How the state file read went: `absent` (none configured, or nothing at the
   * path yet), `loaded` (verified), or `failed` (it could not be read, or it
   * did not verify, and this store holds nothing from it). A store that
   * `failed` never writes the file (`persist`), and the server does not start
   * on one (`assertUsable`): saving would replace the file it could not use
   * with the empty state, and every registration and token with it.
   */
  get loadOutcome(): LoadOutcome {
    return this.loadResult;
  }

  /**
   * Why the state file did not load — `unreadable`, `symlink` or `unverified`
   * — or undefined when it loaded or there was none. Nothing read from the
   * file or the error. The operator command picks its message by it.
   */
  get loadFailureKind(): LoadFailure["kind"] | undefined {
    return this.loadFailure?.kind;
  }

  /**
   * Throw unless the state file loaded, or there was none to load. The server
   * calls this before it serves anything (#258, #263), on a store it built or
   * one it was given. The message names the variable and a fixed reason only:
   * no path, nothing read from the file, and not the error that was caught,
   * whose message carries the path.
   */
  assertUsable(): void {
    const failure = this.loadFailure;
    if (!failure) {
      return;
    }
    const refusing =
      "Refusing to start: running on an empty OAuth state would replace the file at the next save " +
      "and lose every client registration.";
    if (failure.kind === "unreadable") {
      throw new Error(
        `MCP_OAUTH_STATE_FILE is set but the state file could not be read (${failure.code}). ${refusing} ` +
          "Make the path a file this account can read (check its owner, its mode, and that it is not a " +
          "directory), then start again."
      );
    }
    if (failure.kind === "symlink") {
      throw new Error(
        "MCP_OAUTH_STATE_FILE is set but the path is a symbolic link. Refusing to start: a save replaces " +
          "the link with a regular file, and the file it points to is left with the old state. Set " +
          "MCP_OAUTH_STATE_FILE to the path of the file itself (if it is on a volume that is not mounted, " +
          "mount it first), then start again."
      );
    }
    throw new Error(
      "MCP_OAUTH_STATE_FILE is set but the state file did not verify: it was changed or damaged, was " +
        "written by another version, or MCP_OAUTH_PASSWORD is not the password that wrote it. " +
        `${refusing} If the password is wrong, set the one that wrote the file and start again; the ` +
        "registrations come back. To change the password on purpose, stop the server, move the state " +
        "file aside (outside the vault), and start with the new password."
    );
  }

  /**
   * What an operator needs to see about each registration (the
   * `oauth:registrations` command), and nothing that authenticates: no token
   * value or hash leaves the store this way. `clientName` and `redirectUris`
   * are whatever the caller of `/register` sent.
   */
  listRegistrations(): RegistrationListing[] {
    const t = this.now();
    const liveFor = (map: Map<string, TokenRecord>, clientId: string): number => {
      let live = 0;
      for (const record of map.values()) {
        if (record.clientId === clientId && record.expiresAt > t) live++;
      }
      return live;
    };
    return [...this.clients.values()].map((client) => ({
      clientId: client.clientId,
      consent: client.consent,
      clientName: client.clientName,
      redirectUris: [...client.redirectUris],
      createdAt: client.createdAt,
      liveAccessTokens: liveFor(this.accessTokens, client.clientId),
      liveRefreshTokens: liveFor(this.refreshTokens, client.clientId)
    }));
  }

  /**
   * What removing this registration would take with it, without removing
   * anything; `undefined` if there is no such registration.
   */
  removalFor(clientId: string): RegistrationRemoval | undefined {
    if (!this.clients.has(clientId)) {
      return undefined;
    }
    const count = <V extends { clientId: string }>(map: Map<string, V>): number =>
      [...map.values()].filter((value) => value.clientId === clientId).length;
    return {
      accessTokens: count(this.accessTokens),
      refreshTokens: count(this.refreshTokens),
      tombstones: count(this.rotatedTombstones)
    };
  }

  /**
   * Remove these registrations together with every token, pending code and
   * rotation tombstone bound to them, and report whether that reached the
   * state file (always true without one). All or nothing: if any id is not
   * registered, nothing is removed and this throws.
   *
   * A removed client is not barred. Under dynamic registration it can register
   * again and come back under a new id, so this ends a registration and its
   * sessions, not a client.
   */
  removeRegistrations(clientIds: string[]): boolean {
    const unknown = clientIds.filter((clientId) => !this.clients.has(clientId));
    if (unknown.length > 0) {
      throw new Error("unknown_client");
    }
    const doomed = new Set(clientIds);
    const sweep = <V extends { clientId: string }>(map: Map<string, V>): void => {
      for (const [key, value] of map) {
        if (doomed.has(value.clientId)) map.delete(key);
      }
    };
    for (const clientId of doomed) {
      this.clients.delete(clientId);
    }
    sweep(this.accessTokens);
    sweep(this.refreshTokens);
    sweep(this.rotatedTombstones);
    sweep(this.codes);
    return this.persist();
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
      // The record is gone — expired and swept, revoked, or evicted by the cap.
      // A live tombstone says it was ROTATED before it went, which makes this
      // presentation a replay and not a stray dead token (#170).
      this.replayAgainstTombstone(key, clientId);
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
      // Remember the trigger independently of the record. `expiresAt` is copied
      // AFTER the cap above and never recomputed, so the tombstone closes at
      // the same instant the record's window does: this cannot extend the
      // replay window by a tick, and past the window a tombstone is as dead as
      // the record was. Pruning first keeps expired entries from spending cap
      // room a live newcomer needs.
      this.pruneTombstones();
      this.rotatedTombstones.set(key, {
        clientId: record.clientId,
        familyId: record.familyId,
        generation: record.generation,
        expiresAt: record.expiresAt
      });
      enforceTombstoneCap(this.rotatedTombstones, this.maxTombstones);
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
    // The eviction that used to disarm the replay trigger no longer does
    // (#170). Once this call returns the record is an ordinary entry again, and
    // an interceptor holding the lost response can still push it out
    // DELIBERATELY — rotating the chain they captured adds an entry per hop,
    // and at `maxTokens - 1` hops inside the window the root is swept.
    // Measured independently by two sessions (2026-09-02): at cap 4 the flip is
    // exactly at 3 rotations. What changed is that the trigger no longer lives
    // only on the record: `rotatedTombstones` carries the family, the
    // generation and the window, so the replay still revokes every generation
    // above the root when the record is gone.
    //
    // ⚠️ What the tombstone does NOT restore is the pair. A swept root means
    // the scope and resource that pair would be minted on are gone with it, and
    // the tombstone deliberately holds no copy of them, so the retry still
    // answers `invalid_grant` and the client re-authorizes. Availability in
    // that corner is not recovered — what is recovered is the revocation, which
    // is the half nobody can perform later.
    //
    // Still not closed by sparing every in-window record from every mint: that
    // was built and measured evicting freshly issued grants instead (see
    // enforceCap). Pre-filling the token map does not help an attacker —
    // eviction there is insertion-ordered, so entries older than the root are
    // swept first, and the cap must be filled after it exists.
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
  private revokeFamilyAbove(familyId: string, generation: number): number {
    let removed = 0;
    for (const map of [this.accessTokens, this.refreshTokens]) {
      for (const [key, record] of map) {
        if (record.familyId === familyId && record.generation > generation) {
          map.delete(key);
          removed += 1;
        }
      }
    }
    return removed;
  }

  /**
   * Observe a refresh-token presentation for replay evidence, granting nothing.
   *
   * Exists because `rotateRefreshToken` is the only way into replay detection,
   * and `/token` refuses over-quota refresh grants BEFORE it runs. An
   * interceptor holding a captured chain can fill the shared bucket with their
   * own valid rotations, and the victim's replay — the sole trigger for
   * `revokeFamilyAbove` — then never reaches the store: the window closes, the
   * tombstone expires, and the stolen family is never revoked. The mitigation
   * becomes unreachable exactly when it is being exercised.
   *
   * The detection arms are the ones `rotateRefreshToken` reads, and
   * deliberately nothing else:
   *  - no mint, and no call that could mint — the caller has no pair to return
   *    and must not gain one from a refused request;
   *  - no field is written, so a window cannot be extended by a tick and a
   *    rotated record cannot be re-opened;
   *  - nothing is deleted on the failure arms. `rotateRefreshToken` drops an
   *    expired record, and drops a never-rotated record on a client mismatch;
   *    neither is repeated here, because over quota the honest answer is to
   *    change no state at all.
   *
   * `client_id` is handled exactly as on the granting path: it arrives
   * unauthenticated on the /token form, so a mismatch is not evidence and must
   * not revoke — treating it as reuse evidence is what would let someone
   * holding a copy kill a live pair on a presentation the real client never
   * made.
   *
   * ⚠️ This does put store logic within reach of an over-quota, unauthenticated
   * caller, so what it can be driven for is worth stating rather than assuming.
   * The only capability past the two map lookups is `revokeFamilyAbove`, which
   * deletes and can never issue, and reaching it needs the exact token bytes —
   * whoever has those can already reach the same revocation below quota through
   * the ordinary path, where they also get a pair back. So this is not new
   * power; it is the same power in the corner where the gate had removed it.
   * What is new is cost, and it is bounded: a stranger's junk returns after two
   * map misses, and a token-holder's repeated presentations revoke nothing the
   * second time, so they persist nothing (see `revokeFamilyAbove`). Producing
   * something new to revoke takes a successful rotation, which is exactly what
   * the bucket limits.
   *
   * ⛔ The gate itself is untouched — same check, same charge, same 429. Moving
   * either is what the comment at the call site forbids, for a reason that
   * still holds.
   */
  observeRotationReplay(refreshToken: string, clientId: string): void {
    const key = tokenKey(refreshToken);
    const record = this.refreshTokens.get(key);
    if (!record) {
      // Same fallback as the granting path: the record may be gone while its
      // tombstone still names the family, the generation and the window.
      this.replayAgainstTombstone(key, clientId);
      return;
    }
    if (record.expiresAt <= this.now()) {
      return;
    }
    if (record.clientId !== clientId) {
      return;
    }
    if (record.rotatedAt === undefined) {
      // A first presentation is not a replay. Rotating it is precisely what the
      // caller was refused, and doing any part of it here would be minting by
      // halves: stamping `rotatedAt` would burn the client's own token on a
      // request that hands them nothing back.
      return;
    }
    if (this.revokeFamilyAbove(record.familyId, record.generation) > 0) {
      // No mint follows to carry this into a shared save, and a restart that
      // resurrects revoked generations undoes exactly what this call was for.
      this.save();
    }
  }

  /**
   * The replay trigger for a rotated record that is no longer in the map.
   *
   * `revokeFamilyAbove` is all that is reached from here: no pair is minted and
   * the caller still returns `invalid_grant`, because the record carrying the
   * scope and resource is gone and this holds no copy of them. The client that
   * lost its response re-authorizes; the generations minted downstream of that
   * lost response die, which is the half an eviction used to take away
   * silently.
   *
   * ⚠️ This is not new power in anyone's hands, and the check below is where
   * that is kept true. The same presentation revokes the same generations while
   * the record survives, and only the holder of that exact token can make it —
   * so a copy-holder's ability to force the legitimate client back through
   * `/authorize` is restored here in the corner where an eviction had removed
   * it, not created. That trade is the one ROTATION_GRACE_MS documents.
   *
   * A mismatched `client_id` is refused WITHOUT revoking, exactly as on the
   * record path: it arrives unauthenticated on the /token form, so it is not
   * evidence either way, and treating it as reuse evidence is what would let a
   * copied token kill a live pair on a presentation the legitimate client never
   * made.
   */
  private replayAgainstTombstone(key: string, clientId: string): void {
    const tombstone = this.rotatedTombstones.get(key);
    if (!tombstone) {
      return;
    }
    if (tombstone.expiresAt <= this.now()) {
      // Past the window this is an ordinary dead token, exactly as a swept
      // record is. Left for the expiry sweep rather than deleted here, so
      // presenting an expired tombstone changes no state at all.
      return;
    }
    if (tombstone.clientId !== clientId) {
      return;
    }
    if (this.revokeFamilyAbove(tombstone.familyId, tombstone.generation) > 0) {
      // The revocation must reach disk on its own: there is no mint after it to
      // carry it into a shared save, and a restart that resurrects revoked
      // generations undoes exactly what this call was for.
      //
      // Guarded on having removed something. Nothing removed is nothing to
      // persist, and the guard bounds a repeat presentation: this is reachable
      // from `observeRotationReplay`, which an over-quota caller can drive
      // without limit, and an unconditional save there would be one whole-file
      // rewrite per request.
      this.save();
    }
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
    this.pruneTombstones();
  }

  /**
   * Retire tombstones whose window has closed. Called from the ordinary expiry
   * sweep and once more just before a tombstone is written, so a burst of
   * expired entries cannot spend cap room a live newcomer needs.
   */
  private pruneTombstones(): void {
    const t = this.now();
    for (const [key, tombstone] of this.rotatedTombstones) {
      if (tombstone.expiresAt <= t) this.rotatedTombstones.delete(key);
    }
  }

  // --- persistence -----------------------------------------------------------
  // File layout: { version, salt, mac, payload } where `payload` is the JSON
  // *string* of PersistedPayload and `mac` = HMAC-SHA256(key, payload). Keeping
  // the payload as an opaque string makes the MAC byte-exact (no re-serialize
  // ambiguity). Only nothing at the path is a first run. A file that cannot be
  // read (#258), a symbolic link at the path, or a file that does not verify or
  // parse (#263) leaves the store empty and `failed`: it never writes the file,
  // and the server does not start.

  /**
   * Fail-closed load: a read error other than nothing at the path, or any
   * corruption / tamper / version / secret mismatch, holds nothing from the
   * file and records why, for `assertUsable`.
   */
  private load(secret: string): void {
    const file = this.persistPath;
    if (!file) {
      return;
    }
    // A read the caller already made is loaded as it is, so a caller that
    // hashed those bytes knows they are the bytes the store holds (#273). It
    // has to be one `readStateFile` made, of this path: then it went through
    // the same O_NOFOLLOW open and the same refusals as the read below, and
    // what follows verifies it the same way.
    const given = this.options.stateFileRead;
    if (given !== undefined && (!issuedReads.has(given) || given.file !== file)) {
      throw new Error("stateFileRead must be what readStateFile returned for persistPath.");
    }
    const read = given ?? readStateFile(file);
    if (read.kind === "absent") {
      // Missing file is the normal first run; derive a fresh salt lazily on save.
      return;
    }
    if (read.kind === "failed") {
      // Anything but nothing at the path (EACCES from another account, EISDIR,
      // EIO) is a state file that exists and was not read (#258). Starting
      // empty would be silent, and the next save renames over the file, which
      // needs write permission on the directory only: every registration in
      // it would be lost, and ChatGPT does not register again (#184).
      // A symbolic link is refused whether or not its target is there (#263):
      // a save renames a regular file over the LINK, so the server would read
      // the target once and from then on write beside it, leaving the target
      // with the old state; with the target missing, the first save would lose
      // it outright. So the store records why and never writes, and the server
      // does not start (`assertUsable`). Only the error code is kept: the
      // caught error's message carries the path.
      this.loadResult = "failed";
      this.loadFailure = read.failure;
      return;
    }
    const raw = read.bytes.toString("utf8");
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
          // A file written before `consent` existed cannot say whether a
          // tokenless registration was ever used, so its registrations load as
          // `unknown` and are kept (#184). Only a value this version wrote
          // itself is taken at its word; anything else reads as `unknown` too,
          // because the one reading that must never be invented is `pending`.
          const consent: ClientConsent =
            client.consent === "pending" || client.consent === "given" ? client.consent : "unknown";
          this.clients.set(client.clientId, { ...client, consent });
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
      // Tombstones are rotation-grace state and are persisted for the same
      // reason `rotatedAt` is: a replay after a supervisor bounce must still
      // revoke what the lost response minted. A record swept by the cap is not
      // on disk either, so without this the #170 gap simply reopens at every
      // restart.
      //
      // ⚠️ A malformed entry is DROPPED, not repaired. The token loader gives a
      // record with an unusable lineage a fresh family of its own so it can
      // neither revoke nor be revoked; the conservative reading of the same
      // damage here is no tombstone at all — one carrying an invented family
      // would revoke nothing and only occupy the cap.
      for (const tombstone of payload.rotatedTombstones ?? []) {
        if (
          typeof tombstone?.tokenHash === "string" &&
          typeof tombstone.clientId === "string" &&
          typeof tombstone.familyId === "string" &&
          typeof tombstone.generation === "number" &&
          Number.isInteger(tombstone.generation) &&
          tombstone.generation >= 0 &&
          typeof tombstone.expiresAt === "number" &&
          tombstone.expiresAt > t
        ) {
          this.rotatedTombstones.set(tombstone.tokenHash, {
            clientId: tombstone.clientId,
            familyId: tombstone.familyId,
            generation: tombstone.generation,
            expiresAt: tombstone.expiresAt
          });
        }
      }
      enforceTombstoneCap(this.rotatedTombstones, this.maxTombstones);
      // After the tokens, because what a registration may be reclaimed for
      // depends on whether it holds one.
      const promoted = this.consentFromLiveTokens();
      this.reclaimUnconsented();
      // Keep the verified salt/key for subsequent saves.
      this.hmacSalt = salt;
      this.hmacKey = key;
      this.loadResult = "loaded";
      // A promotion held only in memory is lost if nothing else saves before
      // its tokens lapse and the process restarts: the file would still say
      // `pending`, and the proof would be gone. So write it now. Only here, on
      // a file that verified, and only when something was promoted — a load
      // that failed never reaches this line and must not overwrite the file
      // with the empty state it fell back to.
      if (promoted > 0 && this.options.writeAtLoad !== false) {
        this.persist();
      }
    } catch {
      // Never trust a state file that does not verify, and never write over
      // it either (#263). A wrong password, a damaged file and a tampered one
      // look the same here, and starting empty used to replace the file at the
      // next save: every registration was lost, and ChatGPT recovers only by
      // deleting and recreating its app (#184). So nothing from the file is
      // kept, not even what was read before the check failed, the store never
      // writes, and the server does not start (`assertUsable`). No detail is
      // kept: it could echo attacker-controlled bytes.
      this.clients.clear();
      this.accessTokens.clear();
      this.refreshTokens.clear();
      this.rotatedTombstones.clear();
      this.loadResult = "failed";
      this.loadFailure = { kind: "unverified" };
    }
  }

  /**
   * Atomic save (tmp + rename), 0600 file / 0700 dir. Failures only warn: for
   * tokens, persistence is an availability feature and a failed save must not
   * break auth. The two registration transitions that must not be answered
   * unless they landed call `persist` instead (#184), and so does removing
   * registrations, because an operator must not be told it worked when it did
   * not.
   */
  private save(): void {
    this.persist();
  }

  /** Save, and report whether the state file was written (true without one). */
  private persist(): boolean {
    if (!this.persistPath) {
      return true;
    }
    // A store whose state file did not load holds an empty state that is not
    // the file's, and writing it would replace the file and every registration
    // in it (#258, #263). Checked here, before any directory or temporary file
    // is made, and not only at start: a store used without `assertUsable`
    // cannot write either. A first run (`absent`) saves as before.
    if (this.loadResult === "failed") {
      return false;
    }
    try {
      if (!this.hmacKey || !this.hmacSalt) {
        this.hmacSalt = crypto.randomBytes(STATE_SALT_BYTES);
        this.hmacKey = crypto.scryptSync(this.options.persistSecret ?? "", this.hmacSalt, HMAC_KEY_BYTES);
      }
      const payload: PersistedPayload = {
        clients: [...this.clients.values()],
        accessTokens: [...this.accessTokens.entries()].map(([tokenHash, r]) => ({ tokenHash, ...r })),
        refreshTokens: [...this.refreshTokens.entries()].map(([tokenHash, r]) => ({ tokenHash, ...r })),
        rotatedTombstones: [...this.rotatedTombstones.entries()].map(([tokenHash, r]) => ({ tokenHash, ...r }))
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
      return true;
    } catch {
      // No path/error detail beyond this line (no secrets to leak, but keep the
      // log surface minimal).
      console.error("[oauth] failed to persist OAuth state");
      return false;
    }
  }
}
