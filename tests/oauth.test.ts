import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpConfig } from "../src/config.js";
import { startHttpServer } from "../src/httpServer.js";
import { KnowledgeStore } from "../src/knowledgeStore.js";
import { SkillStore } from "../src/skillStore.js";
import { isAllowedRedirectUri, OAuthProvider, SCOPE_READ, SCOPE_WRITE } from "../src/oauth/provider.js";
import { computeS256Challenge, verifyPkceS256 } from "../src/oauth/pkce.js";
import { RateLimiter } from "../src/oauth/rateLimiter.js";
import {
  DEFAULT_MAX_CLIENTS,
  MAX_UNCONSENTED_CLIENTS,
  OAuthStore,
  readStateFile,
  REGISTRATION_CONSENT_DEADLINE_MS,
  ROTATION_GRACE_MS,
  type StateFileRead
} from "../src/oauth/store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: computeS256Challenge(verifier) };
}

/** Register a client and fail the test outright if the registry refused it. */
function mustRegister(store: OAuthStore, redirectUris: string[], clientName?: string) {
  const client = store.registerClient(redirectUris, clientName);
  if (!client) throw new Error("registerClient refused: the registry is full");
  return client;
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

/** The same flow, returning the refresh token and the client it is bound to. */
async function oauthObtainRefresh(issuer: string): Promise<{ clientId: string; refreshToken: string }> {
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
      scope: "vault.read",
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
  return { clientId: reg.client_id, refreshToken: (await tokenRes.json()).refresh_token };
}

async function listToolNamesOverHttp(issuer: string, token: string): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
    // `connection: close` keeps these requests out of the client's keep-alive
    // pool. The restart test below stops a server and starts a new one on the
    // SAME port (the port is baked into the issuer the token is audience-bound
    // to), so a pooled socket would point at an address the new server now
    // owns: the next request can be dispatched onto the dead connection before
    // the client notices it closed, failing with "other side closed"
    // (UND_ERR_SOCKET). Not pooling removes the race rather than narrowing it.
    requestInit: { headers: { authorization: `Bearer ${token}`, connection: "close" } }
  });
  const client = new Client({ name: "scope-test", version: "0.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

/** The same listing, negotiated on the sessionless 2026-07-28 protocol era. */
async function listToolNamesOverModernHttp(issuer: string, token: string): Promise<string[]> {
  const transport = new ModernStreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, connection: "close" } }
  });
  const client = new ModernClient(
    { name: "scope-test-modern", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
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

  // RFC 7636 §4.1 bounds the verifier at 43..128 on both sides; the test above
  // only reaches the lower bound. Every verifier here is checked against ITS
  // OWN challenge, so the length check is the only thing that can refuse it —
  // against a foreign challenge the digest compare would refuse it anyway and
  // the bound would never be reached.
  //
  // Reverse-verified (2026-09-24): dropping `|| verifier.length >
  // MAX_VERIFIER_LENGTH` reddens only this test (129 accepted); widening the
  // bound to 129 reddens it too (the 129 case), and so does narrowing it to
  // 127 (the 128 case).
  it("accepts verifiers of exactly 43 and 128 characters and refuses 42 and 129", () => {
    const own = (length: number) => {
      const verifier = "a".repeat(length);
      return verifyPkceS256(verifier, computeS256Challenge(verifier));
    };
    expect(own(42)).toBe(false);
    expect(own(43)).toBe(true);
    expect(own(128)).toBe(true);
    expect(own(129)).toBe(false);
    expect(own(4096)).toBe(false);
  });

  // The test at the top of this block checks each refusal against a FOREIGN
  // challenge, so the digest compare refuses them all and the guards in front
  // of it are never what decides. Each case here is built so exactly one guard
  // stands between the input and a wrong answer: the verifier is checked
  // against its own challenge, the challenge is non-empty but the wrong length,
  // and the null inputs reach the guard that exists for them.
  //
  // Reverse-verified (2026-09-25, one mutation per guard, each reddening only
  // this test unless noted; the two tests above stayed green under the first
  // four):
  //   - charset check disabled (`if (false)`) → own-challenge "!" verifier accepted
  //   - timingSafeEqual replaced by Buffer#equals → timingSafeEqual spy 0 calls
  //   - length compare disabled → timingSafeEqual throws RangeError on "abc"
  //   - empty/null guard disabled → null.length throws TypeError
  //   - compare replaced by `return true` → this test, the first test above and
  //     the flow's wrong-verifier test redden
  it("refuses each malformed input at its own guard and compares in constant time (INV-7 item 1)", () => {
    const withBadChar = "!" + "a".repeat(42);
    expect(verifyPkceS256(withBadChar, computeS256Challenge(withBadChar))).toBe(false);

    const { verifier, challenge } = pkcePair();
    expect(verifyPkceS256(verifier, "abc")).toBe(false);
    expect(verifyPkceS256(null, challenge)).toBe(false);
    expect(verifyPkceS256(undefined, challenge)).toBe(false);
    expect(verifyPkceS256(verifier, null)).toBe(false);
    expect(verifyPkceS256(verifier, undefined)).toBe(false);

    const compare = vi.spyOn(crypto, "timingSafeEqual");
    try {
      // A same-length wrong challenge passes every guard, so only the compare
      // can refuse it — and it must be the constant-time one.
      const other = pkcePair().challenge;
      expect(other.length).toBe(challenge.length);
      expect(verifyPkceS256(verifier, other)).toBe(false);
      expect(verifyPkceS256(verifier, challenge)).toBe(true);
      expect(compare).toHaveBeenCalledTimes(2);
    } finally {
      compare.mockRestore();
    }
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

  it("rejects control characters, which the URL parser strips rather than rejects", () => {
    for (const c of ["\t", "\n", "\r"]) {
      const uri = `https://claude.ai${c}.evil.example/cb`;
      // The divergence itself: the string reads as claude.ai, the parse resolves
      // elsewhere. The consent page names a host derived from the parse, so a
      // registered value that can move the host must not be storable at all.
      expect(new URL(uri).host).toBe("claude.ai.evil.example");
      expect(isAllowedRedirectUri(uri)).toBe(false);
    }
    expect(isAllowedRedirectUri("https://claude.ai/cb\u0000")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/cb\u007f")).toBe(false);
  });

  it("rejects userinfo, which normalization leaves intact", () => {
    // This one round-trips byte-for-byte, so a "reject anything not already
    // normalized" rule would pass it while the host is still attacker-chosen.
    // Refusing userinfo outright is what closes it.
    const uri = "https://claude.ai@evil.example/cb";
    expect(new URL(uri).href).toBe(uri);
    expect(new URL(uri).host).toBe("evil.example");
    expect(isAllowedRedirectUri(uri)).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai:pw@evil.example/cb")).toBe(false);
  });

  it("still accepts the callback shapes real connectors register", () => {
    // Non-regression guard for the live connectors. The rule above must stay a
    // ban on host-moving characters and must not drift into "must already be
    // normalized", which would reject ordinary registrations such as an
    // explicit :443 or a mixed-case host — neither of which moves the host.
    //
    // The first two are the shapes actually observed in a deployment's OAuth
    // store. ChatGPT registers a per-connector callback path, so the trailing
    // segment here is a stand-in — the real one identifies a specific connector
    // registration and does not belong in a public repository.
    for (const uri of [
      "https://chatgpt.com/connector/oauth/AbCdEfGh1234",
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/oauth/callback",
      "https://chatgpt.com:443/cb",
      "https://ChatGPT.com/cb",
      "http://127.0.0.1:8787/callback"
    ]) {
      expect(isAllowedRedirectUri(uri)).toBe(true);
    }
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

  // INV-7 item 6: pending codes are capped like clients and tokens are. The cap
  // is on codes still pending — an expired code frees its slot at the next
  // prune — so it bounds memory without becoming a lifetime quota.
  //
  // Reverse-verified (2026-09-24): removing the `codes.size >= DEFAULT_MAX_CODES`
  // check reddens only this test (the 1001st is issued); so does loosening it
  // to `>` (same assert). Removing the prune call at the top of
  // createAuthorizationCode reddens the "frees its slot" assert.
  it("caps pending authorization codes at 1000 and frees slots as codes expire", () => {
    let t = 1000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const params = { clientId: "c", redirectUri: "https://x/cb", codeChallenge: "ch", scope: "", resource: "r" };
    for (let i = 0; i < 1000; i++) {
      store.createAuthorizationCode(params);
    }
    expect(() => store.createAuthorizationCode(params)).toThrow(/too_many_pending_authorizations/);

    t += 61_000; // every pending code is now past its 60 s TTL
    expect(typeof store.createAuthorizationCode(params)).toBe("string");
  });

  // INV-7 items 2 and 5 say codes and tokens are opaque 256-bit CSPRNG values.
  // The source of randomness cannot be observed from outside, so this pins the
  // two things that can: the width (32 bytes → 43 base64url characters, no
  // padding) and that no value repeats across many issues. A counter or a
  // fixed value fails the second; a narrower draw fails the first.
  //
  // Reverse-verified (2026-09-24): `randomBytes(32)` → `randomBytes(16)` reddens
  // this test (22 characters). ⚠️ It does NOT catch a swap to a non-CSPRNG
  // source of the same width (e.g. Math.random-derived bytes) — that remains
  // unpinned, by construction.
  it("issues codes, access tokens and refresh tokens as distinct 256-bit base64url values", () => {
    const store = new OAuthStore(opts);
    const seen = new Set<string>();
    const issued: string[] = [];
    for (let i = 0; i < 64; i++) {
      const tokens = store.issueTokens("c", "vault.read", "r");
      issued.push(tokens.accessToken, tokens.refreshToken);
      issued.push(
        store.createAuthorizationCode({
          clientId: "c",
          redirectUri: "https://x/cb",
          codeChallenge: "ch",
          scope: "",
          resource: "r"
        })
      );
    }
    for (const value of issued) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(value);
    }
    expect(seen.size).toBe(issued.length);
  });

  // The tests around this one step a second or more past a TTL, so none of
  // them can tell `<=` from `<`: a token must already be dead at the instant it
  // expires. Each token is paired with a twin used one millisecond earlier as a
  // control, so a clock the store did not read would show up as a false pass.
  //
  // Reverse-verified (2026-09-25, each reddening only this test):
  //   - validateAccessToken `record.expiresAt <= this.now()` → `<` → the
  //     at-TTL access token is accepted
  //   - rotateRefreshToken `record.expiresAt <= t` → `<` → the at-TTL refresh
  //     token is rotated
  it("refuses access and refresh tokens at exactly their expiry instant (INV-7 item 5)", () => {
    let t = 1000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const early = store.issueTokens("c", "vault.read", "r");
    const atTtl = store.issueTokens("c", "vault.read", "r");

    t = 1000 + opts.accessTokenTtlSec * 1000 - 1;
    expect(store.validateAccessToken(early.accessToken)?.clientId).toBe("c");
    t = 1000 + opts.accessTokenTtlSec * 1000;
    expect(store.validateAccessToken(atTtl.accessToken)).toBeNull();

    t = 1000 + opts.refreshTokenTtlSec * 1000 - 1;
    expect(store.rotateRefreshToken(early.refreshToken, "c")).not.toBeNull();
    t = 1000 + opts.refreshTokenTtlSec * 1000;
    expect(store.rotateRefreshToken(atTtl.refreshToken, "c")).toBeNull();
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

  // The test above jumps a second past the TTL, so it cannot tell `<=` from
  // `<`: the code must already be dead at the instant it expires, not one tick
  // later. The first code is consumed one millisecond before that instant as a
  // control, so a clock the store did not read would show up as a false pass.
  //
  // Reverse-verified (2026-09-25): `record.expiresAt <= this.now()` →
  // `record.expiresAt < this.now()` reddens only this test (the at-TTL code is
  // accepted); the test above stays green under it.
  it("refuses an authorization code at exactly its expiry instant (INV-7 item 2)", () => {
    let t = 1000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const params = { clientId: "c", redirectUri: "https://x/cb", codeChallenge: "ch", scope: "", resource: "r" };
    const early = store.createAuthorizationCode(params);
    const atTtl = store.createAuthorizationCode(params);
    t = 1000 + opts.codeTtlSec * 1000 - 1;
    expect(store.consumeAuthorizationCode(early)?.clientId).toBe("c");
    t = 1000 + opts.codeTtlSec * 1000;
    expect(store.consumeAuthorizationCode(atTtl)).toBeUndefined();
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

  it("rotates refresh tokens and invalidates the old one once the replay grace closes", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const rotated = store.rotateRefreshToken(tokens.refreshToken, "c");
    expect(rotated).not.toBeNull();
    t += ROTATION_GRACE_MS + 1;
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull(); // reused after grace
    expect(store.rotateRefreshToken(rotated!.refreshToken, "wrong")).toBeNull(); // wrong client
    // The wrong-client presentation above killed the successor too — strict, as
    // before. The successor has never been rotated, so nothing depends on it
    // surviving; a record inside its replay window is kept instead (see "keeps
    // the record a replay must revoke on…").
    expect(store.rotateRefreshToken(rotated!.refreshToken, "c")).toBeNull();
  });

  // 逆検証・赤緑実測 (2026-08-30, 各 mutation が当該分岐に届いたことを赤の内訳で確認):
  //  A. grace を外し即 delete に戻す → replay/非延長/restart の 3 本だけ赤
  //  B. replay で rotatedAt を触り窓を延長 → 「never extends」1 本だけ赤
  //  C. revocation を消す → revocation を assert するテストだけ赤
  //  D. load で rotatedAt を落とす → restart の「re-open しない」1 本だけ赤
  //  E. (削除) chain walk は family 走査に置き換わった。下の H1/H3 が後継
  //  F. mint を issueTokens (2 save) に戻す → 「one atomic save」1 本だけ赤
  //
  // 2026-09-01、successor link を family id + generation に置き換えた際の再実測。
  // ⚠️ H1/H3/H4 は互いに素ではない — どれも同じ 8 本を赤にする。3 つは 1 つの
  // 不変条件 (replay は下流の世代を revoke する) の別々の壊し方なので、赤は
  // 「revocation が効いていない」までしか名指しできない。H2 だけが独立に切れる。
  //  H1. revokeFamilyAbove を no-op に → 8 本赤。★ 失敗アームの 2 本は緑のまま
  //      (= 「revoke しない」を assert する側なので、正しく反応しない)
  //  H2. 世代の境界 > を >= に         → 「retry more than once」1 本だけ赤
  //  H3. 系統を継承せず毎回新 family に → H1 と同じ 8 本
  //  H4. generation を +1 せず据え置き  → H1 と同じ 8 本
  // ⛔ load 側の fallback (familyId / generation が壊れた state を、互いに
  //    revoke できない孤立 family として読む) は**テストで踏めていない**。
  //    その分岐に入る state file は HMAC を通る必要があり、旧版の writer を
  //    テスト内に再実装しない限り作れない。⇒ 未カバーとして申告する。
  //    ⭐ 訂正 (2026-09-25・上の 3 行は消さずに残す): 「再実装しない限り作れない」は偽だった。
  //    MAC の鍵は scrypt(password, salt) で、テストは password を持っている ⇒ payload を
  //    手で組んで MAC を付け直せば、旧 writer なしで loader が検証を通す file になる
  //    (`OAuthStore persistence` の `signedEnvelope`)。両 fallback は同 describe の
  //    "reads unusable lineage conservatively…" で踏み、逆検証した (被覆は下の tombstone 側と 2/2)。
  //
  // 2026-09-02、cap の spare 免除 (rotation は自分が立っている record を自分の
  // mint で evict しない) を足した際の実測。★ 変異を回したのは別セッションで、
  // ⛔ ①は 1e が先に 1 通り回しており、⭕ ②③と探針は 02 が足した。
  //  I. rotate の mintTokens(...) から spare キー (key) を外す
  //     → 「does not evict the record it is rotating…」1 本だけ赤
  //  J. enforceCap の `key !== spare` を true に潰す → 同じ 1 本だけ赤
  // ⚠️ I/J は互いに素ではない (同じ不変条件の別々の壊し方)。赤が名指しできるのは
  //    「spare 免除が効いていない」までで、2 つの site のどちらが壊れたかは区別しない。
  // 2026-09-02、client 不一致アームが in-grace record を消さなくなった件 (F1) の実測。
  //  K. 不一致アームを元に戻す (rotatedAt を見ず常に delete + save)
  //     → 「keeps the record a replay must revoke on…」1 本だけ赤。赤の理由は
  //       「retry が null」= root が消され replay トリガが失われたこと自体。
  // ⚠️ 逆に「消えた intermediate に届く」probe は、この修正で**自分の削除手段を
  //    失った** (in-grace record を消せる到達可能な提示が無くなった)。map を直接
  //    叩く形に変え、delete の戻り値を assert して CONTROL の写しに退化しないよう
  //    固定した。
  // ⛔ `const doomed = victim ?? oldest` の fallback は 715 本のどれにも到達しない。
  //    ⭕ `victim === undefined` で throw する探針を入れて全 715 本を回し、一度も
  //    発火しないことを確認した。max >= 1 では非 spare キーを 1 つ削った時点で
  //    size <= max になりループが終わり、max = 0 では根が発行時点で evict されて
  //    rotate が mint に到達しない (⚠️ 後者は陽性対照を組んで空振りしてから分かった)。
  //    ⇒ 未到達として申告する。⛔ これは不到達の証明ではない。
  //    ⭐ 追記 (2026-09-25): max >= 1 については論証で不到達が言える (探針に依らない)。
  //      - max >= 1 のとき、ループ条件 size > max ⇒ size >= 2
  //      - spare に一致するキーは高々 1 つ (Map のキーは互いに異なる)
  //      - よって spare でないキーが存在し、victim は必ず定まる
  //    ⚠️ 上の「非 spare キーを 1 つ削った時点で size <= max」は、size が max+1 を超えて
  //    始まる場合 (load は token の cap を掛けない) に 1 回で終わるとは限らない — この論証は
  //    各反復で成り立つので、その場合も含む。⛔ 射程の外: max = 0 (上の実測のとおり) と
  //    max = NaN (`size > NaN` が常に偽で cap 自体が外れる)。どちらも options 経由でしか
  //    入らず、本番は DEFAULT_MAX_TOKENS = 2000。
  it("lets a rotated refresh token be replayed inside the grace window, revoking the lost pair", () => {
    // The incident this pins (2026-08-30): the response carrying the rotated
    // pair is lost in transit; the client retries with the only token it has —
    // the one it just presented. Strict single-use turned that retry into a
    // forced full re-authorization.
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c"); // response never arrives
    expect(lost).not.toBeNull();
    t += 30_000; // client retries inside the window
    const replayed = store.rotateRefreshToken(tokens.refreshToken, "c");
    expect(replayed).not.toBeNull();
    // The pair minted for the lost response is revoked — if anyone holds it,
    // it is an interceptor, and the legitimate client never saw it.
    expect(store.validateAccessToken(lost!.accessToken)).toBeNull();
    expect(store.rotateRefreshToken(lost!.refreshToken, "c")).toBeNull();
    // The replayed pair is fully usable.
    expect(store.validateAccessToken(replayed!.accessToken)?.clientId).toBe("c");
    expect(store.rotateRefreshToken(replayed!.refreshToken, "c")).not.toBeNull();
  });

  it("revokes EVERY generation minted downstream on replay, not just the direct pair", () => {
    // Independent review finding (P2, 2026-08-30): an interceptor who captured
    // the lost response can rotate its refresh token once, putting their live
    // pair one hop beyond a single-level delete. The replay must walk the
    // chain to reach them at any depth.
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c"); // response intercepted
    // The interceptor rotates what they captured — twice, to prove depth.
    const hop1 = store.rotateRefreshToken(lost!.refreshToken, "c");
    const hop2 = store.rotateRefreshToken(hop1!.refreshToken, "c");
    expect(hop2).not.toBeNull();

    t += 30_000; // legitimate client replays inside the window
    const replayed = store.rotateRefreshToken(tokens.refreshToken, "c");
    expect(replayed).not.toBeNull();
    // Every hop of the interceptor's chain is dead — access and refresh legs.
    for (const pair of [lost!, hop1!, hop2!]) {
      expect(store.validateAccessToken(pair.accessToken)).toBeNull();
      expect(store.rotateRefreshToken(pair.refreshToken, "c")).toBeNull();
    }
    expect(store.validateAccessToken(replayed!.accessToken)?.clientId).toBe("c");
  });

  // The pair below is a CONTROL and a PROBE differing by ONE line. Reading them
  // side by side is the argument: the probe removes the intermediate before the
  // replay, and the descendants must still die. Independent review (P1,
  // 2026-08-30) found that a chain kept as links between records could not
  // survive that, because a deletion anywhere along it ends the walk.
  it("CONTROL: a replay reaches a hop while every record between them exists", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c"); // response intercepted
    const hop1 = store.rotateRefreshToken(lost!.refreshToken, "c"); // interceptor rotates it
    t += 30_000;
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).not.toBeNull();
    expect(store.validateAccessToken(hop1!.accessToken)).toBeNull();
    expect(store.rotateRefreshToken(hop1!.refreshToken, "c")).toBeNull();
  });

  it("reaches a hop whose intermediate was already deleted", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c");
    const hop1 = store.rotateRefreshToken(lost!.refreshToken, "c");
    // The one added line: the INTERMEDIATE is removed before the replay.
    //
    // It is removed directly, from the map. This line used to re-present the
    // intermediate with a mismatched client_id, which deleted it — that
    // deletion is exactly what the F1 fix removed (see "keeps the record a
    // replay must revoke on…" below), and no reachable presentation deletes an
    // in-grace record any more: a rotated record's window always closes at or
    // after its parent's, so it cannot be expired out either while the replay
    // below is still possible. Reaching in keeps the property pinned instead
    // of letting the probe quietly become a copy of the CONTROL above. The map
    // is private only at compile time, and its key is sha256(token), as at rest.
    const removed = (store as unknown as { refreshTokens: Map<string, unknown> }).refreshTokens.delete(
      crypto.createHash("sha256").update(lost!.refreshToken).digest("hex")
    );
    expect(removed).toBe(true); // a reach-in that hit nothing would leave this a copy of the CONTROL
    t += 30_000;
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).not.toBeNull();
    expect(store.validateAccessToken(hop1!.accessToken)).toBeNull();
    expect(store.rotateRefreshToken(hop1!.refreshToken, "c")).toBeNull();
  });

  // The negative half of the same design. Revoking on the failure arms would
  // also close the gap above, and was measured doing so: it hands anyone
  // holding a COPY of a spent token the power to destroy the legitimate
  // client's live pair, on both arms, while gaining nothing themselves. These
  // two pin that the fix did not buy the gap with that.
  it.each([
    ["after the window closes, with the right client", ROTATION_GRACE_MS + 1, "c"],
    ["inside the window, with a mismatched client", 5_000, "wrong"]
  ])("leaves the live pair alone when a spent token is presented %s", (_label, advance, client) => {
    let t = 1_000_000;
    // accessTokenTtlSec is raised so advancing past the grace window does not
    // expire the access token on its own — without it the assertion below
    // passes for the wrong reason, which is how the first run of this probe
    // failed its own control.
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, now: () => t });
    const spent = store.issueTokens("c", "vault.read", "r");
    const live = store.rotateRefreshToken(spent.refreshToken, "c")!; // the client RECEIVED this
    t += advance as number;
    expect(store.validateAccessToken(live.accessToken)).not.toBeNull(); // control
    expect(store.rotateRefreshToken(spent.refreshToken, client as string)).toBeNull();
    expect(store.validateAccessToken(live.accessToken)?.clientId).toBe("c");
    expect(store.rotateRefreshToken(live.refreshToken, "c")).not.toBeNull();
  });

  it("keeps the record a replay must revoke on when a mismatched client_id presents it", () => {
    // F1 (2026-09-02): `client_id` reaches this method unauthenticated from the
    // /token form (public client, token_endpoint_auth_method "none"), so the
    // mismatch arm was a state-changing primitive anyone could fire. Firing it
    // on the ROOT — the record whose re-presentation is the ONLY trigger for
    // revokeFamilyAbove — disarmed the family revocation in one request: the
    // client's retry then found nothing, returned a plain `invalid_grant`
    // indistinguishable from expiry, and the interceptor's captured pair went
    // on rotating undetected. The suite reached the mismatch arm only on an
    // INTERMEDIATE, where nothing depends on the record surviving.
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c"); // response intercepted
    expect(lost).not.toBeNull();
    // The interceptor tries to destroy the root before the client retries.
    expect(store.rotateRefreshToken(tokens.refreshToken, "wrong")).toBeNull();
    t += 30_000;
    // The retry still works — and still revokes what the interceptor holds.
    const replayed = store.rotateRefreshToken(tokens.refreshToken, "c");
    expect(replayed).not.toBeNull();
    expect(store.validateAccessToken(lost!.accessToken)).toBeNull();
    expect(store.rotateRefreshToken(lost!.refreshToken, "c")).toBeNull();
    expect(store.validateAccessToken(replayed!.accessToken)?.clientId).toBe("c");
  });

  // The cap and the replay window meet on one record. Measured 2026-09-01 by
  // two sessions independently: with the map at its cap the presented record
  // is its oldest entry, so minting the successor evicts it, and the linkage
  // assigned a line later lands on an object no longer in the map. The retry
  // then fails AND the revocation that retry would have performed never runs —
  // availability and confidentiality, from one eviction.
  //
  // The main assertion is positive on purpose. The requirement is that a
  // record SURVIVES, so "the interceptor's pair is gone" cannot carry it:
  // eviction satisfies that assertion exactly as well as revocation does, and
  // eviction is the failure being pinned.
  it("does not evict the record it is rotating when the cap is already full", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, maxTokens: 4, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const others = [0, 1, 2].map(() => store.issueTokens("other", "vault.read", "r"));
    // The map is now exactly at its cap and the grant above is its oldest
    // entry. Capping expiresAt for the window mutates a value, which does not
    // move a Map entry, so it stays first in line for the sweep.
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c"); // response never arrives
    expect(lost).not.toBeNull();
    t += 30_000; // the client retries inside the window
    const replayed = store.rotateRefreshToken(tokens.refreshToken, "c");
    expect(replayed).not.toBeNull();
    expect(store.validateAccessToken(replayed!.accessToken)?.clientId).toBe("c");
    // The other half: sparing one key did not switch the sweep off. Something
    // still had to go, and it was the next entry in insertion order.
    expect(store.rotateRefreshToken(others[0].refreshToken, "other")).toBeNull();
  });

  // 2026-09-09、#170 の rotated-token tombstone を足した際の実測。
  // ★ mutation ごとに「入れたこと」と「届いたこと」を別々に確認した — patch の anchor が
  //   ちょうど 1 回一致したこと (入れた) と、狙った assert が実際に赤くなったこと (届いた)。
  //   届かない mutation は「ガードが効いていて緑」と区別が付かないので、赤くなった assert を
  //   テスト名と assert の文言で残す (行番号はキャッシュなので書かない)。
  //  L. record が見つからない枝から replayAgainstTombstone の呼び出しを外す
  //     → #170 の 4 本が赤。狙いは「swept the root out of the cap」の
  //       `validateAccessToken(held.accessToken)).toBeNull()`。
  //       ★「after the window closes」は緑のまま — revoke *しない* ことを assert する側なので、
  //       正しく反応しない (H1 の失敗アーム 2 本と同じ形)
  //  M. tombstone の expiresAt を record の窓 + ROTATION_GRACE_MS にする (= 窓の延長)
  //     → 「after the window closes」の `?.clientId).toBe("c") // and after` が赤。
  //       ⭐ 加えて既存の restart 2 本 (「single-use across restarts once the grace closes」/
  //       「window survives, and never re-opens」) も赤 — 窓が延びないことは、この新しい
  //       マップについても**既存の suite が独立に**押さえていた
  //  N. tombstone 側の client_id 照合を外す
  //     → 「mismatched client_id」の `// nothing revoked` 1 本だけ赤
  //  O. enforceTombstoneCap を enforceCap (oldest-first) に差し替える
  //     → 「floods past the tombstone cap」の `tombstones.has(rootKey)).toBe(true)` だけが赤。
  //       その直前の size の assert は緑のまま = 落ちたのは容量ではなく**順序**である
  //  P. save の payload から rotatedTombstones を落とす
  //     → 「carries the tombstone across a restart」の on-disk sha256 の assert が赤。
  //       root の record は cap に掃かれて refreshTokens 側に無いので、その hash が state file に
  //       現れる場所は tombstone だけ = この assert は永続化そのものを見ている
  //  Q. enforceTombstoneCap の呼び出しごと消す (= 無上限)
  //     → 同じ「floods past」の `tombstones.size).toBe(maxTokens)` が赤 (実測 9 対 4)
  //  R. enforceTombstoneCap の多 family 選択を「最新」から「最古」へ (ループに break を足す)
  //     ★ 先に名指しした狙いの assert = 「still fits the cap」の
  //       `expect(outcome.tombstonePresent).toBe(true)`。実際にそこが赤 (expected false to be true)。
  //       ⛔ 同テストの `aliveAfterRetry` は【到達していない】 — 上の assert が先に落ちるので、
  //       R が確立したのは機構の assert までである (結果の assert は R では踏めていない)。
  //     ⚠️ O と互いに素ではない — 「floods past the tombstone cap」の `has(rootKey)` も同時に赤。
  //       どちらも「追い出しが新参の側でなくなった」ことの別の見え方で、赤は 2 つの site を
  //       区別しない。
  //     ⭕ cap 5 側 (「no longer fits the cap」) は緑のまま — 制限を pin する側なので正しく
  //       反応しない (H1 の失敗アーム・L の「after the window closes」と同じ形)。
  // ⚠️ L は O/Q と互いに素ではない (呼び出しを外せば cap のテストも赤くなる)。L の赤が
  //    名指しできるのは「tombstone 経路が効いていない」までで、cap の順序と上限を切り分けるのは
  //    O と Q である。
  // ⛔ load 側の tombstone 検証 (壊れた entry を drop する分岐) は H1〜H4 のときの
  //    familyId / generation fallback と同じ理由で**テストで踏めていない** — その分岐に入る
  //    state file は HMAC を通す必要があり、writer をテスト内に再実装しない限り作れない。
  //    ⇒ 未カバーとして申告する。
  //    ⭐ 訂正 (2026-09-25・上の 3 行は消さずに残す): 上の H1〜H4 側の訂正と同じ理由で偽だった。
  //    `signedEnvelope` で作った file で "reads unusable lineage conservatively…" が踏み、
  //    `tombstone.generation >= 0 &&` を外すと当該テストだけが赤になることを実測した。
  // #170. The residual `rotateRefreshToken` states rather than fixes: sparing
  // the presented record lasts exactly one mint, after which it is an ordinary
  // entry again and an interceptor holding the lost response can push it out on
  // purpose. Rotating the chain they captured inserts one entry per hop, and at
  // `maxTokens - 1` hops inside the window the root — the oldest entry — is
  // swept. The replay that would have revoked their family then finds nothing.
  //
  // The main assertion is that the family IS revoked, and it is stated on the
  // interceptor's live pair rather than on the replay's return value: the record
  // carrying the client's scope/resource is gone, so no fix can hand a usable
  // pair back here, and "the replay succeeded" would pin the wrong thing.
  it("revokes the family on replay after the interceptor swept the root out of the cap (#170)", () => {
    let t = 1_000_000;
    const maxTokens = 4;
    const store = new OAuthStore({ ...opts, maxTokens, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c"); // response intercepted
    expect(lost).not.toBeNull();

    // The interceptor rotates what they captured, `maxTokens - 1` times. Every
    // rotation inserts one refresh entry; the root is the oldest, so the last
    // one evicts it.
    let held = lost!;
    for (let i = 0; i < maxTokens - 1; i += 1) {
      const next = store.rotateRefreshToken(held.refreshToken, "c");
      expect(next).not.toBeNull();
      held = next!;
    }

    // Positive control for the premise: the sweep really happened. Without it
    // this test could pass on a store where the root simply survived, which is a
    // different property and is already pinned above.
    const rootKey = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");
    expect((store as unknown as { refreshTokens: Map<string, unknown> }).refreshTokens.has(rootKey)).toBe(false);
    // Second control: the pair the assertions below are stated on is ALIVE at
    // this point, so "it is gone" cannot pass because the cap took it instead.
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c");

    t += 30_000; // the legitimate client retries inside the window
    store.rotateRefreshToken(tokens.refreshToken, "c");

    // Both legs of the interceptor's live pair are dead.
    expect(store.validateAccessToken(held.accessToken)).toBeNull();
    expect(store.rotateRefreshToken(held.refreshToken, "c")).toBeNull();
  });

  // The tombstone must not become a second, longer window. It is written with
  // the record's ALREADY-CAPPED expiry and never rewritten, so it closes at the
  // same instant, and past that instant a swept root is an ordinary dead token.
  it("does not revoke on a swept root presented after the window closes (#170)", () => {
    let t = 1_000_000;
    const maxTokens = 4;
    // The access TTL is raised so advancing past the grace window does not
    // expire the interceptor's pair on its own — without it the assertion below
    // would pass for the wrong reason.
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, maxTokens, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    let held = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    for (let i = 0; i < maxTokens - 1; i += 1) {
      held = store.rotateRefreshToken(held.refreshToken, "c")!;
    }
    const rootKey = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");
    expect((store as unknown as { refreshTokens: Map<string, unknown> }).refreshTokens.has(rootKey)).toBe(false);

    t += ROTATION_GRACE_MS + 1; // one tick past the window the rotation opened
    expect(store.validateAccessToken(held.accessToken)).not.toBeNull(); // control: alive before
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull();
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // and after
  });

  it("refuses a mismatched client_id on the tombstone path without revoking or disarming (#170)", () => {
    // The record path's F1 property, restored on the path that replaces it:
    // `client_id` arrives unauthenticated, so a mismatch is neither evidence of
    // reuse (do not revoke) nor a licence to destroy the trigger (do not delete).
    let t = 1_000_000;
    const maxTokens = 4;
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, maxTokens, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    let held = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    for (let i = 0; i < maxTokens - 1; i += 1) {
      held = store.rotateRefreshToken(held.refreshToken, "c")!;
    }
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // control

    expect(store.rotateRefreshToken(tokens.refreshToken, "wrong")).toBeNull();
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // nothing revoked

    // ...and the trigger survived that presentation: the right client still fires it.
    t += 1_000;
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull();
    expect(store.validateAccessToken(held.accessToken)).toBeNull();
  });

  // The tombstone map has a cap of its own, so it has an eviction order of its
  // own, and reusing enforceCap's oldest-first would hand the interceptor the
  // same lever one map over: their hops would push out the tombstone written
  // first, which is the root's. Every hop inherits the captured family, so the
  // sweep aims at exactly that — see enforceTombstoneCap.
  it("keeps the root's tombstone when the interceptor floods past the tombstone cap (#170)", () => {
    let t = 1_000_000;
    const maxTokens = 4;
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, maxTokens, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    let held = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    // Twice the cap in hops: the map is driven past its bound repeatedly, not
    // merely filled to it.
    for (let i = 0; i < 2 * maxTokens; i += 1) {
      held = store.rotateRefreshToken(held.refreshToken, "c")!;
    }
    const tombstones = (store as unknown as { rotatedTombstones: Map<string, unknown> }).rotatedTombstones;
    // Two controls, because "the root survived" is also what an unbounded map
    // and a flood that never reached the cap would produce. The map is held at
    // its bound...
    expect(tombstones.size).toBe(maxTokens);
    // ...and what survived it is the root's tombstone, not just some tombstone.
    const rootKey = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");
    expect(tombstones.has(rootKey)).toBe(true);
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // the pair is alive

    t += 30_000;
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull(); // no pair comes back
    expect(store.validateAccessToken(held.accessToken)).toBeNull(); // but the family died
    expect(store.rotateRefreshToken(held.refreshToken, "c")).toBeNull();
  });

  it("carries the tombstone across a restart, hashed at rest (#170)", async () => {
    // Rotation-grace state is persisted for the same reason `rotatedAt` is: a
    // replay after a supervisor bounce must still revoke what the lost response
    // minted. The record swept by the cap is not on disk either, so without the
    // tombstone the gap simply reopens at every restart.
    const os = await import("node:os");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-tombstone-"));
    const file = path.join(dir, "state.json");
    const maxTokens = 4;
    let t = 1_000_000;
    const persisted = { ...opts, accessTokenTtlSec: 3600, maxTokens, persistPath: file, persistSecret: "s3cret" };
    const store = new OAuthStore({ ...persisted, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    let held = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    for (let i = 0; i < maxTokens - 1; i += 1) {
      held = store.rotateRefreshToken(held.refreshToken, "c")!;
    }
    // Hash-at-rest (INV-7 item 7) covers the new map too: the state file holds
    // sha256(token) and never the token.
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).not.toContain(tokens.refreshToken);
    expect(onDisk).toContain(crypto.createHash("sha256").update(tokens.refreshToken).digest("hex"));

    t += 30_000;
    const reloaded = new OAuthStore({ ...persisted, now: () => t });
    expect(reloaded.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // control: survived the restart
    expect(reloaded.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull();
    expect(reloaded.validateAccessToken(held.accessToken)).toBeNull();
    expect(reloaded.rotateRefreshToken(held.refreshToken, "c")).toBeNull();
  });

  /**
   * #170 の入力② を組む。1 つの窓の中で generation `generations` まで回した client が、
   * 次の rotation の応答を失い、介在者がその先を `interceptorHops` 回 chain rotate した
   * あとで、client が手元の世代を retry する。
   *
   * ⚠️ setup が壊れたときは `harness:` で始まる Error を投げる。被験体の失敗
   * (revocation が起きない) と器具の失敗 (chain が途中で切れて replay に到達しなかった)
   * は、赤の文言で区別できなければならない — 後者は「安全」でも「危険」でもなく、
   * 何も測っていないという意味である。
   */
  function replayAfterInWindowChain(options: { maxTokens: number; generations: number; interceptorHops: number }) {
    let t = 1_000_000;
    const store = new OAuthStore({
      ...opts,
      // alive 判定が TTL 失効で汚れないように長めに取る。既定の 60s だと、下の
      // 陽性対照が「生きている」を偽る側に倒れる。
      accessTokenTtlSec: 3600,
      maxTokens: options.maxTokens,
      now: () => t
    });
    const rotate = (token: string, what: string) => {
      const next = store.rotateRefreshToken(token, "c");
      if (!next) {
        throw new Error(`harness: ${what} returned null; the scenario never reached the replay`);
      }
      return next;
    };
    let held = store.issueTokens("c", "vault.read", "r");
    for (let generation = 1; generation <= options.generations; generation += 1) {
      held = rotate(held.refreshToken, `the client's rotation to generation ${generation}`);
    }
    const clientHolds = held; // client の手元に残る世代 — これを retry する
    let intercepted = rotate(clientHolds.refreshToken, "the rotation whose response is lost");
    for (let hop = 1; hop <= options.interceptorHops; hop += 1) {
      intercepted = rotate(intercepted.refreshToken, `the interceptor's chain rotation ${hop}`);
    }
    t += 30_000; // ROTATION_GRACE_MS (60s) の窓の中で client が retry する
    const tombstones = (store as unknown as { rotatedTombstones: Map<string, unknown> }).rotatedTombstones;
    const tombstonePresent = tombstones.has(crypto.createHash("sha256").update(clientHolds.refreshToken).digest("hex"));
    const aliveBeforeRetry = store.validateAccessToken(intercepted.accessToken) !== null;
    store.rotateRefreshToken(clientHolds.refreshToken, "c");
    return {
      tombstonePresent,
      aliveBeforeRetry,
      aliveAfterRetry: store.validateAccessToken(intercepted.accessToken) !== null
    };
  }

  // 入力② — 1 つの窓の中で複数世代を回した client の gen-k replay。墓標は世代ごとに
  // FIRST rotation で書かれるので gen-k のそれは (k+1) 番目で、満杯のマップに来た新参は
  // 入場できない。⇒ 覆えるのは `k + 1 <= maxTokens` のときだけで、その境界を両側から踏む。
  //
  // ⭐ 落ちる側の欠落を作るのは介在者ではなく client 自身の窓内 rotation である。
  // 追い出されるのは常に**新参**の側なので、既に書かれた墓標を flood で押し出すことは
  // できない (enforceTombstoneCap)。⇒ 既定 cap 2000 では k <= 1999 まで覆え、それを
  // 破るには client が 60 秒に 2000 回転している必要がある。
  it("revokes a gen-k replay after an in-window chain while that generation still fits the cap (#170)", () => {
    // k = 5 ⇒ 墓標は 6 個目。cap 6 は「ちょうど入る」側の境界 (6 <= 6)。
    const outcome = replayAfterInWindowChain({ maxTokens: 6, generations: 5, interceptorHops: 10 });
    // ★ 陽性対照。これが無いと「圧力が token map から掃いただけ」を revocation と
    //   読んでしまう (実際に姉妹案の初回測定がその形で交絡した)。retry の直前に
    //   介在者の pair が生きていて初めて、直後の死は revocation の結果だと言える。
    expect(outcome.aliveBeforeRetry).toBe(true);
    expect(outcome.tombstonePresent).toBe(true);
    expect(outcome.aliveAfterRetry).toBe(false);
  });

  it("cannot revoke a gen-k replay once that generation no longer fits the cap (#170)", () => {
    // 同じ k = 5 に cap 5。墓標 6 個目は満杯のマップへの新参なので入場できない。
    // ⚠️ これは望ましい挙動ではなく**制限の申告**である。unmodified な挙動と同値まで
    //    戻るだけで悪化はしない (実測: cap 5 では両版とも revocation が起きない)。
    //    ⛔ この赤を「直す」前に、上の 2 段落を読むこと — 追い出し順序を oldest-first に
    //    変えるとこちら側は動くが、#170 本体 (root の墓標) が flood で落ちるようになる。
    const outcome = replayAfterInWindowChain({ maxTokens: 5, generations: 5, interceptorHops: 9 });
    expect(outcome.aliveBeforeRetry).toBe(true); // 同じ陽性対照 — 圧力が掃いたのではない
    expect(outcome.tombstonePresent).toBe(false);
    expect(outcome.aliveAfterRetry).toBe(true);
  });

  // 2026-09-09、F1 (rate-limit がガード自身を沈黙させる) を閉じた際の実測。
  // ★ 各 mutation について「入れたこと」と「届いたこと」を別々に確認した — anchor が
  //   ちょうど 1 回一致したこと (入れた) と、**先に名指しした** assert が実際に赤くなったこと
  //   (届いた)。届かない mutation は「ガードが効いていて緑」と区別が付かない (#122 / #125 で
  //   計 6 件)。狙いはテスト名と assert の文言で残す — 行番号はキャッシュなので書かない。
  //  S. httpServer の 429 経路から `oauth.observeRefreshReplay(form)` を外す (= 修正前の姿)
  //     → 「still revokes the stolen family when the rotation quota is exhausted」の
  //       `expect(await mcpStatus(held)).toBe(401)` が赤 (expected 200 to be 401)。1 本だけ。
  //     ⭐ これが finding そのものの再現でもある。修正前に**先に赤を見てから**実装した。
  //  T. observe の `!record` 枝から replayAgainstTombstone の呼び出しを外す
  //     → 狙いどおり「after the root was swept」の
  //       `validateAccessToken(held.accessToken)).toBeNull()` が赤。
  //     ⚠️ 同時に persistence の「skips the write ... once the root has been swept」も赤 —
  //       ただしそこで落ちたのは sentinel ではなく**その手前の control** (revoke が起きたこと)。
  //       つまり 2 本は互いに素ではなく、どちらも「tombstone 枝が動いていない」の別の見え方。
  //  U. observe の client_id 照合を外す
  //     → 「mismatched client_id while observing」の `?.clientId).toBe("c") // nothing revoked`
  //       が赤 (expected undefined to be 'c')。1 本だけ。
  //  V. observe の expiresAt 検査を外す
  //     → 「does not extend the replay window, and sees nothing past it」の
  //       `?.clientId).toBe("c") // nothing revoked` が赤。1 本だけ。
  //  W. 未 rotate の枝で return せず rotation の記帳 (rotatedAt 押印 + 窓への切り詰め) をする
  //     → 「changes no state for a presentation that is not a replay」の
  //       `expect(maps.refreshTokens.get(rootKey)).toEqual(before)` が赤 (6 field 対 5 field)。
  //  W2. 同じ枝の早期 return を**丸ごと消す** (記帳もしない)
  //     → **全 91 本が緑のまま** (実測、推測ではない)。未 rotate の record はその family の
  //       最新世代なので `revokeFamilyAbove` が 0 件で戻り、save も走らないため。
  //     ⇒ この枝で pin できているのは「**記帳しないこと**」(W) であって「**入らないこと**」では
  //       ない。W はそこを踏むように**わざと**書いた mutation で、W2 はその射程を測るために
  //       走らせた対照である。⛔ W だけを見て「この枝は pin 済み」と読まないこと。
  //  X. observe の最後を rotateRefreshToken への委譲に差し替える (= mint する)
  //     → 「mints nothing while observing」の `expect(maps.accessTokens.size).toBe(1)` が赤
  //       (expected 2 to be 1)。⭕ 件数を厳密値にしてあるので「2 revoke して 2 mint」でも赤になる。
  //     ⚠️ Y と互いに素ではない — mint は save を伴うので persistence 側の sentinel も同時に赤。
  //  Y. observe の record 枝の save を無条件に戻す
  //     → 「persists an observed revocation, and skips the write when it removes nothing」の
  //       `expect(await fs.readFile(file, "utf8")).toBe("SENTINEL")` が赤。1 本だけ。
  //  Z. replayAgainstTombstone の save を無条件に戻す
  //     → 「skips the write on a repeat observation once the root has been swept」の
  //       同じ sentinel assert が赤。1 本だけ。
  //     ⚠️ Y と Z は別々の call site なので**互いに素**。片方だけ戻すと片方だけ赤くなることを
  //       実測した (だから 2 本に分けてある — 1 本なら片側が pin されないまま残る)。
  //  AA. observe の revoke する腕で record.expiresAt を now + ROTATION_GRACE_MS に延ばす
  //     → 「does not extend the window on the arm that actually revokes」の
  //       `maps.refreshTokens.get(rootKey)!.expiresAt).toBe(closesAt)` が赤
  //       (expected 1090000 to be 1060000)。
  //  AB. 同じ腕で **tombstone 側の** expiresAt だけを延ばす
  //     → 同テストの `maps.rotatedTombstones.get(rootKey)!.expiresAt).toBe(closesAt)` が赤。
  //     ⭐ AA と AB は**互いに素** — 赤くなった行を実測で確認した (AA=934 行目 / AB=935 行目)。
  //       ⛔ 同じ数値 (1090000 対 1060000) が出るので、**メッセージだけでは区別が付かない**。
  //       record を延ばすと先に来る record 側で止まり、tombstone だけ延ばすと record 側を
  //       通過して tombstone 側で落ちる。⇒ **2 つの map は別々の write なので、片方だけ
  //       pin すると、もう片方は自由に drift する。** だから assert も 2 本ある。
  //  AC. 同じ腕を throw に潰す (到達性の probe = W2 の教訓をこの腕に当てたもの)
  //     → 新テストを含む 6 本が赤。⇒ ★ **新テストの assert は確かにこの腕まで届いている**
  //       (「延ばしていないから緑」と「腕に入っていないから緑」は区別が付かないので、
  //       AA/AB が赤いことに加えて、これを別に測った)。
  // ⚠️ **窓のテストが 2 本あるのは分割ではなく被覆である。**
  //    「sees nothing past it」は観測を窓の**閉じた後**に置くので、pin しているのは
  //    **期限切れの腕** (expiresAt 検査で return する側)。⛔ 初版はこの 1 本で INV-7 item 7 を
  //    押さえたつもりだったが、**revoke する腕には窓の assert が 1 つも無かった**。
  //    ⇒ 上の新テストがその腕で、⭕ **観測が腕に届いたことを control (held が revoke された)
  //    で先に示してから**窓を assert する (control が無いと、早期 return した版でも緑になる)。
  // ⛔ **未カバーとして申告する**: observe 経路の CPU コスト (revokeFamilyAbove の O(maxTokens)
  //    走査を over-quota で無制限に回せること) は**測っていない**。上の Y/Z が bound したのは
  //    disk write だけで、走査そのものは残る。body の parse より安いという見積もりに留まる。
  //    ⭐ 実測 (2026-09-25・上の 3 行は消さずに残す): 見積もりは外れていた。rotated record への
  //    repeat observe (removes 0) を node v24.13.0 / macOS で 3 回ずつ測った値 —
  //      maps 1+1 = 0.8 µs / 100+100 = 2.2 µs / 1000+1000 = 17 µs / 1999+1999 = 34〜36 µs
  //    に対し、典型的な /token form の `URLSearchParams` parse + get 2 回は 0.49 µs。⇒ cap
  //    いっぱいでは parse の約 70 倍で、maps の大きさに線形。⛔ HTTP 1 リクエスト全体との比較は
  //    していない。対策の要否 (familyId の索引など = src の変更) は、この表の外で判断する。
  // F1 (2026-09-09). `/token` checks the refresh-rotation quota BEFORE
  // `oauth.token(form)` runs, and `rotateRefreshToken` is the only way into
  // replay detection, so a full bucket silences the trigger outright — and the
  // interceptor's own valid rotations are what fill it. `observeRotationReplay`
  // is the refusal path's way to show the store the presentation without
  // granting on it.
  //
  // The contract is subtractive, so most of what follows is stated negatively:
  // what it must NOT mint, NOT write, NOT extend and NOT delete. A test that
  // only asserted "the family is revoked" would stay green if this quietly grew
  // the power to hand a pair back.

  it("revokes the family from the refusal path while the record is still there (F1)", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c")!; // response intercepted
    const held = store.rotateRefreshToken(lost.refreshToken, "c")!; // interceptor rotates it
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // control: alive

    // Inside the window the legitimate client retries — and the endpoint refuses
    // it, because the interceptor spent the quota getting here.
    t += 30_000;
    store.observeRotationReplay(tokens.refreshToken, "c");

    // Both legs of the interceptor's live pair are dead anyway.
    expect(store.validateAccessToken(held.accessToken)).toBeNull();
    expect(store.rotateRefreshToken(held.refreshToken, "c")).toBeNull();
  });

  it("does not extend the window on the arm that actually revokes (F1)", () => {
    // The sibling above observes PAST the close, so it returns at the expiry
    // check: what it pins is the expired arm. Nothing pinned the window on the
    // arm that reaches `revokeFamilyAbove` — an in-window presentation of a
    // rotated record — which is the arm the refusal path exists to run.
    //
    // INV-7 item 7: the grace window is a cap, never a renewal. Being refused
    // must not become a way to renew it, or a 429 would keep a dead token alive.
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    const held = store.rotateRefreshToken(lost.refreshToken, "c")!;
    const maps = store as unknown as {
      refreshTokens: Map<string, { expiresAt: number }>;
      rotatedTombstones: Map<string, { expiresAt: number }>;
    };
    const rootKey = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");
    const closesAt = maps.refreshTokens.get(rootKey)!.expiresAt;
    // Control: record and tombstone close at the same instant, so a single
    // `closesAt` is the right thing to compare both against afterwards.
    expect(maps.rotatedTombstones.get(rootKey)!.expiresAt).toBe(closesAt);

    t += 30_000; // well inside the window
    store.observeRotationReplay(tokens.refreshToken, "c");

    // This control comes FIRST because it is what makes the two assertions
    // below non-vacuous: it proves the revoking arm actually ran. Without it,
    // both would pass just as well on a version that returned early and never
    // reached the arm being tested — the shape W2 measured one map over.
    expect(store.validateAccessToken(held.accessToken)).toBeNull();

    // Neither window moved, on the arm that did the work. Both maps, because
    // they are separate writes: pinning one leaves the other free to drift.
    expect(maps.refreshTokens.get(rootKey)!.expiresAt).toBe(closesAt);
    expect(maps.rotatedTombstones.get(rootKey)!.expiresAt).toBe(closesAt);
  });

  it("revokes the family from the refusal path after the root was swept (F1)", () => {
    // The other arm: the cap took the record, so the tombstone is the only thing
    // left that names the family. Both arms have to work from the refusal path,
    // because the attack that fills the bucket is the same one that fills the cap.
    let t = 1_000_000;
    const maxTokens = 4;
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, maxTokens, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    let held = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    for (let i = 0; i < maxTokens - 1; i += 1) {
      held = store.rotateRefreshToken(held.refreshToken, "c")!;
    }
    const rootKey = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");
    // Controls: the sweep really happened, and the pair really is alive.
    expect((store as unknown as { refreshTokens: Map<string, unknown> }).refreshTokens.has(rootKey)).toBe(false);
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c");

    t += 30_000;
    store.observeRotationReplay(tokens.refreshToken, "c");
    expect(store.validateAccessToken(held.accessToken)).toBeNull();
  });

  it("mints nothing while observing, and hands nothing back (F1)", () => {
    // The whole reason the gate sits in front of the grant is that a full bucket
    // must not mint. Observing is added behind that gate, so it has to be
    // counted: an exact record count, because "fewer than before" would stay
    // green on a version that revoked two and minted two.
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    store.rotateRefreshToken(lost.refreshToken, "c");
    const maps = store as unknown as {
      accessTokens: Map<string, unknown>;
      refreshTokens: Map<string, unknown>;
    };
    // Three generations in each map before the replay: 0 (issued), 1 (lost), 2
    // (the interceptor's).
    expect(maps.accessTokens.size).toBe(3);
    expect(maps.refreshTokens.size).toBe(3);

    t += 30_000;
    const returned = store.observeRotationReplay(tokens.refreshToken, "c") as unknown;

    // Nothing is handed back — there is no pair to give, and the caller is being
    // refused. A signature that could return one is a signature that could be
    // wired into a response by mistake.
    expect(returned).toBeUndefined();
    // Generations 1 and 2 are gone from both maps and generation 0 remains, so
    // each map holds exactly one. A mint would make it two.
    expect(maps.accessTokens.size).toBe(1);
    expect(maps.refreshTokens.size).toBe(1);
  });

  it("changes no state for a presentation that is not a replay (F1)", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const maps = store as unknown as {
      refreshTokens: Map<string, { rotatedAt?: number; expiresAt: number }>;
      rotatedTombstones: Map<string, unknown>;
    };
    const rootKey = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");
    const before = { ...maps.refreshTokens.get(rootKey)! };

    // Unknown: neither a record nor a tombstone. Must not throw, must not write.
    // This is the shape a stranger's junk takes, and it is the common case on a
    // public endpoint.
    store.observeRotationReplay("nothing-hashes-to-this", "c");
    // Never rotated: exactly the grant the caller was refused. Doing the
    // rotation's bookkeeping here would be minting by halves — stamping
    // `rotatedAt` caps this record's expiry to the 60 s grace window, which
    // burns the client's own token on a request that hands them nothing.
    store.observeRotationReplay(tokens.refreshToken, "c");

    expect(maps.refreshTokens.get(rootKey)).toEqual(before);
    expect(maps.rotatedTombstones.size).toBe(0);
    // Stated behaviourally as well, because the field comparison above would
    // pass on a version that wrote and then restored: past the grace window the
    // untouched record is still live, since its expiry was never capped to it.
    t += ROTATION_GRACE_MS + 1;
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).not.toBeNull();
  });

  it("refuses a mismatched client_id while observing, without revoking or disarming (F1)", () => {
    // Same reasoning as both granting arms: `client_id` arrives unauthenticated
    // on the /token form, so a mismatch proves nothing about the presenter and
    // must not be treated as reuse evidence — otherwise anyone holding a copy
    // could kill the live pair on a presentation the real client never made.
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    const held = store.rotateRefreshToken(lost.refreshToken, "c")!;
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // control

    store.observeRotationReplay(tokens.refreshToken, "wrong");
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // nothing revoked

    // ...and the trigger survived that presentation: the right client still
    // fires it. Refusing must not be a way to disarm.
    t += 1_000;
    store.observeRotationReplay(tokens.refreshToken, "c");
    expect(store.validateAccessToken(held.accessToken)).toBeNull();
  });

  it("does not extend the replay window, and sees nothing past it (F1)", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, accessTokenTtlSec: 3600, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    const held = store.rotateRefreshToken(lost.refreshToken, "c")!;
    const maps = store as unknown as {
      refreshTokens: Map<string, { expiresAt: number }>;
      rotatedTombstones: Map<string, { expiresAt: number }>;
    };
    const rootKey = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");
    const closesAt = maps.refreshTokens.get(rootKey)!.expiresAt;
    // Control: record and tombstone close at the same instant, as #170 requires.
    expect(maps.rotatedTombstones.get(rootKey)!.expiresAt).toBe(closesAt);

    // One tick past the close. The refused presentation must not reopen it — a
    // refusal that quietly renewed the window would be a way to keep a dead
    // token alive by being rate-limited.
    t += ROTATION_GRACE_MS + 1;
    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // control: alive
    store.observeRotationReplay(tokens.refreshToken, "c");

    expect(store.validateAccessToken(held.accessToken)?.clientId).toBe("c"); // nothing revoked
    expect(maps.refreshTokens.get(rootKey)!.expiresAt).toBe(closesAt);
    expect(maps.rotatedTombstones.get(rootKey)!.expiresAt).toBe(closesAt);
  });

  it("revokes only the family that was replayed, never a bystander's", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const a = store.issueTokens("c", "vault.read", "r");
    const b = store.issueTokens("c", "vault.read", "r"); // a separate grant
    const aNext = store.rotateRefreshToken(a.refreshToken, "c")!;
    const bNext = store.rotateRefreshToken(b.refreshToken, "c")!;
    t += 30_000;
    expect(store.rotateRefreshToken(a.refreshToken, "c")).not.toBeNull(); // replay family A
    expect(store.validateAccessToken(aNext.accessToken)).toBeNull(); // A's pair dies
    expect(store.validateAccessToken(bNext.accessToken)?.clientId).toBe("c"); // B untouched
    expect(store.rotateRefreshToken(bNext.refreshToken, "c")).not.toBeNull();
  });

  it("lets the client retry more than once inside the window", () => {
    // A lost response can be lost again. Each replay supersedes the previous
    // attempt's pair and mints another; the presented token stays presentable
    // until the window closes.
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const first = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    t += 10_000;
    const second = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    t += 10_000;
    const third = store.rotateRefreshToken(tokens.refreshToken, "c");
    expect(third).not.toBeNull();
    expect(store.validateAccessToken(first.accessToken)).toBeNull();
    expect(store.validateAccessToken(second.accessToken)).toBeNull();
    expect(store.validateAccessToken(third!.accessToken)?.clientId).toBe("c");
  });

  it("persists a rotation's pair and its revocation linkage in one atomic save", async () => {
    // Independent review finding (P2, 2026-08-30): saving the minted pair
    // first and the successor linkage second opens a crash window where disk
    // holds a live pair a post-restart replay cannot revoke. One save per
    // successful rotation (each save is an atomic tmp+rename) closes it: there
    // is no intermediate on-disk state at all. The save count is asserted
    // BECAUSE it is the mechanism — with two saves the window exists no matter
    // what the final state looks like.
    const os = await import("node:os");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-atomic-"));
    const file = path.join(dir, "state.json");
    let t = 1_000_000;
    const store = new OAuthStore({
      ...opts,
      persistPath: file,
      persistSecret: "s3cret",
      now: () => t
    });
    const tokens = store.issueTokens("c", "vault.read", "r");
    // `save` is private only at compile time; the runtime spy sees it fine.
    const saveSpy = vi.spyOn(store as unknown as { save: () => void }, "save");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c");
    expect(lost).not.toBeNull();
    expect(saveSpy).toHaveBeenCalledTimes(1);
    saveSpy.mockRestore();

    // And the one save carried the linkage: a replay after a "crash" (fresh
    // store from the same file) still revokes the lost pair.
    t += 30_000;
    const reloaded = new OAuthStore({
      ...opts,
      persistPath: file,
      persistSecret: "s3cret",
      now: () => t
    });
    const replayed = reloaded.rotateRefreshToken(tokens.refreshToken, "c");
    expect(replayed).not.toBeNull();
    expect(reloaded.validateAccessToken(lost!.accessToken)).toBeNull();
    expect(reloaded.rotateRefreshToken(lost!.refreshToken, "c")).toBeNull();
  });

  it("never extends the replay window on replay", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).not.toBeNull(); // window opens at t0
    t += 50_000;
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).not.toBeNull(); // replay at t0+50s
    t += 20_000; // t0+70s: 20s after the replay, but past the ORIGINAL window
    expect(store.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull();
  });

  // #184. ChatGPT keeps the client_id it registered and never registers again
  // on its own (measured 2026-09-28), so deleting a registration it still holds
  // strands it. A registration the owner consented to is therefore kept once
  // every token it held has lapsed, however long ago.
  //
  // The pending registration beside it is the control: it IS reclaimed by the
  // same call, which shows the reclaim ran and chose.
  //
  // Reverse-verified: letting the reclaim take `given` registrations too
  // reddens the first assert of the loop.
  it("keeps a consented registration after every token has lapsed, however old (#184)", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const consented = mustRegister(store, ["https://chatgpt.com/cb"]);
    expect(store.recordConsent(consented.clientId)).toBe(true);
    const tokens = store.issueTokens(consented.clientId, "vault.read", "r"); // refresh TTL 600s
    const pending = mustRegister(store, ["https://pending/cb"]);

    t += 31 * 24 * 60 * 60 * 1000; // past every TTL and the consent deadline, by a month
    mustRegister(store, ["https://later/cb"]); // registration is where the reclaim runs

    expect(store.rotateRefreshToken(tokens.refreshToken, consented.clientId)).toBeNull(); // reached: nothing live
    expect(store.getClient(consented.clientId)?.redirectUris).toEqual(["https://chatgpt.com/cb"]);
    expect(store.getClient(pending.clientId)).toBeUndefined(); // control: the reclaim ran
  });

  // The deadline runs from creation and the boundary is exact: kept one
  // millisecond before it, reclaimed at it.
  //
  // Reverse-verified: `<=` -> `<` in reclaimUnconsented reddens the "at the
  // deadline" assert.
  it("reclaims an unconsented registration at its deadline and not a moment before (#184)", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const pending = mustRegister(store, ["https://pending/cb"]);

    t += REGISTRATION_CONSENT_DEADLINE_MS - 1;
    mustRegister(store, ["https://before/cb"]);
    expect(store.getClient(pending.clientId)).toBeDefined();

    t += 1; // exactly at the deadline
    mustRegister(store, ["https://at/cb"]);
    expect(store.getClient(pending.clientId)).toBeUndefined();
  });

  // Unconsented registrations are the ones anyone can create, so they get a
  // share of the registry of their own. Filling that share refuses the next
  // newcomer and evicts nobody; the slots come back at the deadline.
  //
  // Reverse-verified: dropping the MAX_UNCONSENTED_CLIENTS check reddens the
  // refusal assert.
  it("refuses a newcomer when the unconsented slots are full, and gives them back at the deadline (#184)", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const owners = mustRegister(store, ["https://chatgpt.com/cb"]);
    store.recordConsent(owners.clientId);
    const flood = [];
    for (let i = 0; i < MAX_UNCONSENTED_CLIENTS; i += 1) {
      flood.push(mustRegister(store, [`https://flood-${i}/cb`]));
    }

    expect(store.registerClient(["https://newcomer/cb"])).toBeUndefined();
    for (const client of [owners, ...flood]) {
      expect(store.getClient(client.clientId)).toBeDefined();
    }

    t += REGISTRATION_CONSENT_DEADLINE_MS;
    expect(store.registerClient(["https://newcomer/cb"])).toBeDefined();
    expect(store.getClient(owners.clientId)).toBeDefined();
  });

  // The cap used to be a deletion path: it evicted the oldest tokenless
  // registration, or the oldest of all when every one held a token. It now
  // refuses the newcomer and leaves the registry as it was — and a registry
  // full of consented registrations stays full past any deadline, because
  // none of them is ever reclaimed.
  //
  // Reverse-verified: restoring the eviction reddens the "still there" loop
  // (and the refusal, since the newcomer then gets a slot).
  it("refuses a new registration at the cap instead of evicting one (#184)", () => {
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const existing = [];
    for (let i = 0; i < DEFAULT_MAX_CLIENTS; i += 1) {
      const client = mustRegister(store, [`https://c-${i}/cb`]);
      store.recordConsent(client.clientId);
      if (i % 2 === 0) store.issueTokens(client.clientId, "vault.read", "r");
      existing.push(client);
    }

    expect(store.registerClient(["https://newcomer/cb"])).toBeUndefined();
    t += 31 * 24 * 60 * 60 * 1000;
    expect(store.registerClient(["https://newcomer/cb"])).toBeUndefined();
    for (const client of existing) {
      expect(store.getClient(client.clientId)).toBeDefined();
    }
  });

  // The unconsented share sits INSIDE the cap: it never lets the registry
  // grow past DEFAULT_MAX_CLIENTS.
  //
  // Reverse-verified: dropping the total-cap check (keeping the pending one)
  // reddens the refusal assert.
  it("counts unconsented registrations inside the cap, not on top of it (#184)", () => {
    const store = new OAuthStore({ ...opts, now: () => 1_000_000 });
    const room = MAX_UNCONSENTED_CLIENTS / 2;
    for (let i = 0; i < DEFAULT_MAX_CLIENTS - room; i += 1) {
      store.recordConsent(mustRegister(store, [`https://c-${i}/cb`]).clientId);
    }
    for (let i = 0; i < room; i += 1) {
      mustRegister(store, [`https://pending-${i}/cb`]);
    }

    expect(store.registerClient(["https://one-too-many/cb"])).toBeUndefined();
  });

  it("keeps an aged client's registration through a refresh rotation (no prune race)", () => {
    // Regression (Codex review on #44). The mechanism it was written against no
    // longer exists, and the sentence describing it is kept because a test
    // whose reason has been deleted looks like a test nobody has a reason for:
    //
    //   "rotateRefreshToken deletes the presented token, then issueTokens runs
    //    prune() before inserting the replacement. For an aged client whose
    //    access token also expired, that was a momentary tokenless gap in which
    //    the registration got swept — after which /authorize failed with
    //    'Unknown client_id' for a session that was rotating normally."
    //
    // Since the replay-grace window, a successful rotation keeps the presented
    // record, so no such gap opens and this passes for a different reason than
    // the one it was written for. It still earns its place: it pins that a
    // rotation does not cost an aged client its registration, which is the
    // property #44 cared about, by whichever mechanism holds it.
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, now: () => t });
    const client = mustRegister(store, ["https://x/cb"]);
    const tokens = store.issueTokens(client.clientId, "vault.read", "r"); // access 60s, refresh 600s
    t += 61_000; // access expired, refresh still valid
    expect(store.rotateRefreshToken(tokens.refreshToken, client.clientId)).not.toBeNull();
    expect(store.getClient(client.clientId)).toBeDefined(); // registration survives the rotation
  });
});

describe("OAuthStore persistence", () => {
  const opts = { accessTokenTtlSec: 60, refreshTokenTtlSec: 600, codeTtlSec: 60 };
  const secret = "hunter2";

  async function stateFilePath(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-state-"));
    return path.join(dir, "oauth-state.json");
  }

  /**
   * An envelope carrying `payload`, MAC'd under `salt` with the test's own
   * password — exactly what the store's writer produces. This is how a test
   * builds a state file the loader will verify, without re-implementing an old
   * writer: the MAC key is scrypt(password, salt), and the test holds both.
   */
  function signedEnvelope(base: Record<string, unknown>, payload: string, salt: Buffer): Record<string, unknown> {
    return {
      ...base,
      payload,
      salt: salt.toString("hex"),
      mac: crypto
        .createHmac("sha256", crypto.scryptSync(secret, salt, 32))
        .update(payload)
        .digest("hex")
    };
  }

  it("requires persistSecret when persistPath is set", async () => {
    const file = await stateFilePath();
    expect(() => new OAuthStore({ ...opts, persistPath: file })).toThrow(/persistSecret/);
  });

  // The operator command must not write after a load that failed: the store
  // fell back to empty, and saving would replace every registration (#184).
  // So the outcome has to be visible from outside.
  //
  // Reverse-verified: never setting `failed` in the load's catch reddens the
  // last assert.
  it("reports whether the state file was absent, loaded or failed verification (#184)", async () => {
    const file = await stateFilePath();
    expect(new OAuthStore({ ...opts, persistPath: file, persistSecret: secret }).loadOutcome).toBe("absent");
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    store.registerClient(["https://chatgpt.com/cb"]);
    expect(new OAuthStore({ ...opts, persistPath: file, persistSecret: secret }).loadOutcome).toBe("loaded");
    expect(new OAuthStore({ ...opts, persistPath: file, persistSecret: "another" }).loadOutcome).toBe("failed");
  });

  // #258: only a missing state file is a first run. A state file that exists and
  // cannot be read stops the store from starting. Starting empty would be silent,
  // and the next save renames over the file, which needs only directory write
  // permission: every registration in it would be lost (ChatGPT does not register
  // again, #184). The before / after view of the file comes from one handle
  // each, so the bytes and the inode are of the same file.
  async function snapshot(file: string): Promise<{ bytes: string; ino: number }> {
    const handle = await fs.open(file, "r");
    try {
      const st = await handle.stat();
      return { bytes: (await handle.readFile()).toString("base64"), ino: st.ino };
    } finally {
      await handle.close();
    }
  }

  /**
   * Starts a store on `file` the way the server does: the refusal message from
   * `assertUsable`, or null when it would start. A store that would start is
   * given one registration, as a running server would be.
   */
  function refusal(file: string, password = secret): string | null {
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: password });
    try {
      store.assertUsable();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    try {
      store.registerClient(["https://claude.ai/cb"]);
    } catch {
      // A save that fails is not what these tests are about.
    }
    return null;
  }

  /**
   * Uses a store on `file` WITHOUT asking whether it may start, as a caller that
   * skips `assertUsable` would, through every kind of saving call: a
   * registration (which must land), a token (whose save only warns) and a
   * removal (which reports). On a store that did not load, none of them may
   * write the file (#258, #263). This is what tells the save guard apart from
   * the start check.
   */
  function writeAnyway(file: string, password = secret): { registration: string; removal: boolean } {
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: password });
    let registration = "saved";
    try {
      store.registerClient(["https://claude.ai/cb"]);
    } catch (error) {
      registration = error instanceof Error ? error.message : String(error);
    }
    store.issueTokens("c", "vault.read", "r");
    return { registration, removal: store.removeRegistrations([]) };
  }

  /** A refusal names the variable and the error code, and not the path or the password. */
  function expectRefusal(message: string | null, code: string, file: string): void {
    expect(message, "the store started instead of refusing").not.toBeNull();
    expect(message).toMatch(
      new RegExp(`^MCP_OAUTH_STATE_FILE is set but the state file could not be read \\(${code}\\)`)
    );
    expect(message).not.toContain(path.dirname(file));
    expect(message).not.toContain(path.basename(file));
    expect(message).not.toContain(secret);
  }

  it("refuses to start on an unreadable state file, and leaves it as it was (#258)", async (ctx) => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const kept = mustRegister(store, ["https://chatgpt.com/cb"], "ChatGPT");
    store.recordConsent(kept.clientId);
    const before = await snapshot(file);
    await fs.chmod(file, 0o000);
    let message: string | null;
    try {
      const denied = await fs.readFile(file).then(
        () => null,
        (error: NodeJS.ErrnoException) => error.code
      );
      if (denied !== "EACCES") ctx.skip(); // run as root: the file is still readable
      message = refusal(file);
      // The rename that would replace the file needs only the directory, so
      // this is where a store that saves anyway loses the registrations.
      expect(writeAnyway(file)).toEqual({ registration: "registration_not_persisted", removal: false });
    } finally {
      await fs.chmod(file, 0o600);
    }
    expect(await snapshot(file)).toEqual(before);
    expectRefusal(message, "EACCES", file);
    expect(
      new OAuthStore({ ...opts, persistPath: file, persistSecret: secret }).getClient(kept.clientId)
    ).toBeDefined();
  });

  // A directory cannot be renamed over, so a store that started anyway would
  // not lose anything here; what this pins is the refusal and its message.
  it("refuses to start when the state path is a directory (#258)", async () => {
    const file = await stateFilePath();
    await fs.mkdir(file);
    expectRefusal(refusal(file), "EISDIR", file);
  });

  // A symbolic link at the state path is refused whether or not its target is
  // there (#263). A save renames a regular file over the LINK: with the target
  // there, the server would read it once and from then on write beside it,
  // leaving the target with the old state (Codex on #265); with the target
  // missing (an unmounted volume), a first run's save would take the link's
  // place and the target would never be read again (#258). Either way it
  // refuses, the link stays a link, and the target keeps its bytes.
  it("refuses to start on a symbolic link at the state path, with or without its target, and keeps both (#263)", async () => {
    const file = await stateFilePath();
    const target = path.join(path.dirname(file), "volume", "oauth-state.json");
    await fs.symlink(target, file);
    const expectLinkRefusal = (message: string | null): void => {
      expect(message, "the store started instead of refusing").not.toBeNull();
      expect(message).toMatch(/^MCP_OAUTH_STATE_FILE is set but the path is a symbolic link\. /);
      for (const leak of [path.dirname(file), path.basename(file), target, secret]) {
        expect(message).not.toContain(leak);
      }
    };

    // The target missing.
    expectLinkRefusal(refusal(file));
    expect(writeAnyway(file)).toEqual({ registration: "registration_not_persisted", removal: false });
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(file)).toBe(target);

    // The target there, and a genuine state file under the right password.
    await fs.mkdir(path.dirname(target));
    const genuine = new OAuthStore({ ...opts, persistPath: target, persistSecret: secret });
    const kept = mustRegister(genuine, ["https://chatgpt.com/cb"], "ChatGPT");
    const before = await snapshot(target);
    expectLinkRefusal(refusal(file));
    expect(writeAnyway(file)).toEqual({ registration: "registration_not_persisted", removal: false });
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect(await snapshot(target)).toEqual(before);

    // The control: the file itself, named directly, starts with what it holds.
    expect(refusal(target)).toBeNull();
    expect(
      new OAuthStore({ ...opts, persistPath: target, persistSecret: secret }).getClient(kept.clientId)
    ).toBeDefined();
  });

  // A caller that already read the state file can have the store load those
  // bytes instead of reading the path again (#273). That must not be a way
  // around what a load refuses: the read has to be one `readStateFile` made,
  // of this store's path, and it is refused or verified as the store's own
  // read would be.
  //
  // Reverse-verified: not checking where the read came from reddens the
  // hand-made case, not checking its path the other-path case, and loading a
  // given read without verifying it the wrong-password case.
  it("loads a read it is given only if readStateFile made it of its own path, and verifies it the same way (#273)", async () => {
    const file = await stateFilePath();
    const kept = mustRegister(
      new OAuthStore({ ...opts, persistPath: file, persistSecret: secret }),
      ["https://chatgpt.com/cb"],
      "ChatGPT"
    );
    const read = readStateFile(file);
    expect(read.kind).toBe("read");

    // The genuine read loads, and holds what the file held.
    const given = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, stateFileRead: read });
    expect(given.loadOutcome).toBe("loaded");
    expect(given.getClient(kept.clientId)).toBeDefined();

    // A copy made by hand, with the same fields, is not one readStateFile made.
    const handMade = { ...read } as StateFileRead;
    expect(
      () => new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, stateFileRead: handMade })
    ).toThrow("stateFileRead must be what readStateFile returned for persistPath.");

    // A genuine read of another path is not a read of this one.
    const other = await stateFilePath();
    mustRegister(new OAuthStore({ ...opts, persistPath: other, persistSecret: secret }), ["https://claude.ai/cb"]);
    expect(
      () => new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, stateFileRead: readStateFile(other) })
    ).toThrow("stateFileRead must be what readStateFile returned for persistPath.");

    // Given under another password, the read does not verify, as the store's
    // own read would not, and nothing is written over the file.
    const before = await snapshot(file);
    const wrong = new OAuthStore({
      ...opts,
      persistPath: file,
      persistSecret: "another",
      stateFileRead: readStateFile(file)
    });
    expect(wrong.loadOutcome).toBe("failed");
    expect(wrong.loadFailureKind).toBe("unverified");
    expect(wrong.removeRegistrations([])).toBe(false);
    expect(await snapshot(file)).toEqual(before);
  });

  // A read that found a link is refused when it is given, as it is when the
  // store reads the path itself (#263): the link stays a link.
  it("refuses a given read that found a symbolic link, and writes nothing (#273)", async () => {
    const file = await stateFilePath();
    const target = path.join(path.dirname(file), "elsewhere.json");
    mustRegister(new OAuthStore({ ...opts, persistPath: target, persistSecret: secret }), ["https://chatgpt.com/cb"]);
    await fs.symlink(target, file);
    const read = readStateFile(file);
    expect(read.kind === "failed" && read.failure.kind).toBe("symlink");
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, stateFileRead: read });
    expect(store.loadOutcome).toBe("failed");
    expect(store.loadFailureKind).toBe("symlink");
    expect(() => store.registerClient(["https://claude.ai/cb"])).toThrow("registration_not_persisted");
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
  });

  // The code is printed only when it has the shape of an errno code. An error
  // with no code, or a code that is not one, reads "an unknown error", and
  // nothing the error carried reaches the message. The file is there, so the
  // error comes from the read itself.
  it("names a read error without a usable code as unknown, and echoes nothing from it (#258)", async () => {
    const file = await stateFilePath();
    await fs.writeFile(file, "{}", { mode: 0o600 });
    for (const thrown of [
      new Error("no code at all"),
      Object.assign(new Error("odd code"), { code: "not a code /tmp/elsewhere" })
    ]) {
      const read = vi.spyOn(fsSync, "readFileSync").mockImplementation(() => {
        throw thrown;
      });
      try {
        const message = refusal(file);
        expectRefusal(message, "an unknown error", file);
        expect(message).not.toContain(thrown.message);
        expect(message).not.toContain("/tmp/elsewhere");
        expect(read).toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    }
  });

  // The control for the two tests above: a missing file is still a first run.
  // It starts, logs nothing, and the next save creates the file.
  it("still starts on a missing state file, silently, as a first run (#258)", async () => {
    const file = await stateFilePath();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(new OAuthStore({ ...opts, persistPath: file, persistSecret: secret }).loadOutcome).toBe("absent");
      // Starts, and its one registration is saved: the file now exists.
      expect(refusal(file)).toBeNull();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    expect(new OAuthStore({ ...opts, persistPath: file, persistSecret: secret }).loadOutcome).toBe("loaded");
  });

  // #263: a state file that reads but does not verify used to start empty, and
  // the next save replaced it. A wrong password, a damaged file and a tampered
  // one look the same to the loader, so each of them now refuses to start, and
  // a store used anyway writes nothing over the file. The message is fixed:
  // no path, no password (right or wrong), nothing from the file.
  async function verifiedFile(): Promise<{ file: string; clientId: string; accessToken: string }> {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const client = mustRegister(store, ["https://chatgpt.com/cb"], "ChatGPT");
    store.recordConsent(client.clientId);
    const tokens = store.issueTokens(client.clientId, "vault.read", "r");
    return { file, clientId: client.clientId, accessToken: tokens.accessToken };
  }

  function expectUnverifiedRefusal(message: string | null, file: string, password: string): void {
    expect(message, "the store started instead of refusing").not.toBeNull();
    expect(message).toMatch(/^MCP_OAUTH_STATE_FILE is set but the state file did not verify: /);
    expect(message).not.toContain(path.dirname(file));
    expect(message).not.toContain(path.basename(file));
    expect(message).not.toContain(secret);
    expect(message).not.toContain(password);
  }

  it("refuses to start on a state file that does not verify, however it fails, and writes nothing over it (#263)", async () => {
    const { file } = await verifiedFile();
    const original = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const genuine = JSON.stringify(original);
    const cases: [string, string, string][] = [
      ["another password", genuine, "a password that did not write it"],
      [
        "a tampered payload",
        JSON.stringify({ ...original, payload: (original.payload as string).replaceAll("vault.read", "vault.write") }),
        secret
      ],
      ["bytes that are not JSON", "not json {{{", secret],
      ["an unknown version", JSON.stringify({ ...original, version: 2 }), secret],
      [
        "a malformed salt",
        JSON.stringify(signedEnvelope(original, original.payload as string, crypto.randomBytes(8))),
        secret
      ],
      ["an envelope with no payload", JSON.stringify({ ...original, payload: undefined }), secret]
    ];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [label, bytes, password] of cases) {
        await fs.writeFile(file, bytes);
        const before = await snapshot(file);
        const message = refusal(file, password);
        expectUnverifiedRefusal(message, file, password);
        expect(writeAnyway(file, password), label).toEqual({
          registration: "registration_not_persisted",
          removal: false
        });
        expect(await snapshot(file), label).toEqual(before);
        await expect(fs.lstat(`${file}.tmp`), label).rejects.toMatchObject({ code: "ENOENT" });
      }
      // Nothing logged carries the path, a password, or a byte of the file.
      const lines = logged.mock.calls.flat().map(String).join("\n");
      for (const leak of [path.dirname(file), secret, "a password that did not write it", original.mac as string]) {
        expect(lines).not.toContain(leak);
      }
    } finally {
      logged.mockRestore();
    }

    // The control: the genuine file, with its own password, starts.
    await fs.writeFile(file, genuine);
    expect(refusal(file)).toBeNull();
  });

  // A file can verify and still fail part way through the load: here the
  // registrations read, and then the token list is not a list. Nothing read
  // before the failure may stay in the store, even though the server will not
  // start on it: a caller that skips `assertUsable` must not see those
  // registrations either. (3a's review of this change, F3.)
  it("holds nothing from a state file whose load failed part way (#263)", async () => {
    const { file, clientId } = await verifiedFile();
    const original = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const payload = JSON.parse(original.payload as string) as { clients: unknown[] };
    const broken = JSON.stringify({ clients: payload.clients, accessTokens: 5 });
    await fs.writeFile(file, JSON.stringify(signedEnvelope(original, broken, crypto.randomBytes(16))));

    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    expect(store.loadOutcome).toBe("failed");
    expect(store.getClient(clientId)).toBeUndefined();
    expect(store.listRegistrations()).toEqual([]);
    // The control: the same registrations with a token list that is a list load.
    const whole = JSON.stringify({ clients: payload.clients, accessTokens: [] });
    await fs.writeFile(file, JSON.stringify(signedEnvelope(original, whole, crypto.randomBytes(16))));
    expect(new OAuthStore({ ...opts, persistPath: file, persistSecret: secret }).getClient(clientId)).toBeDefined();
  });

  // Refusing loses nothing: the file is as it was, so setting the password that
  // wrote it brings every registration and token back.
  it("brings every registration back once the password that wrote the file is set again (#263)", async () => {
    const { file, clientId, accessToken } = await verifiedFile();
    expect(refusal(file, "a mistyped password")).not.toBeNull();
    writeAnyway(file, "a mistyped password");

    const recovered = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    expect(() => recovered.assertUsable()).not.toThrow();
    expect(recovered.getClient(clientId)?.consent).toBe("given");
    expect(recovered.validateAccessToken(accessToken)?.clientId).toBe(clientId);
  });

  // Changing the password on purpose: stop, move the old state file aside, and
  // start with the new password. The new store starts as a first run, saves
  // and reloads under the new password, and holds nothing of the old file, so
  // every old token is refused. The file moved aside is never touched.
  it("changes the password by moving the old state file aside first (#263)", async () => {
    const { file, clientId, accessToken } = await verifiedFile();
    const aside = path.join(path.dirname(file), "oauth-state.before-rotation.json");
    await fs.rename(file, aside);
    const kept = await snapshot(aside);

    const rotated = "a new password";
    const fresh = new OAuthStore({ ...opts, persistPath: file, persistSecret: rotated });
    expect(fresh.loadOutcome).toBe("absent");
    expect(() => fresh.assertUsable()).not.toThrow();
    const newcomer = mustRegister(fresh, ["https://claude.ai/cb"]);

    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: rotated });
    expect(reloaded.loadOutcome).toBe("loaded");
    expect(reloaded.getClient(newcomer.clientId)).toBeDefined();
    expect(reloaded.getClient(clientId)).toBeUndefined();
    expect(reloaded.validateAccessToken(accessToken)).toBeNull();
    expect(await snapshot(aside)).toEqual(kept);
  });

  // The server checks a store it was given as well as one it built.
  it("stops a provider on a store that did not load, whether it built the store or was given it (#263)", async () => {
    const { file } = await verifiedFile();
    const config = {
      issuer: "https://vault.example.com",
      loginPassword: "a password that did not write it",
      accessTokenTtlSec: 60,
      refreshTokenTtlSec: 600,
      codeTtlSec: 60,
      allowWrite: false,
      stateFile: file
    };
    expect(() => new OAuthProvider(config)).toThrow(/did not verify/);
    const given = new OAuthStore({ ...opts, persistPath: file, persistSecret: "a password that did not write it" });
    expect(() => new OAuthProvider({ ...config, stateFile: undefined }, given)).toThrow(/did not verify/);
    // The control: the right password starts.
    expect(() => new OAuthProvider({ ...config, loginPassword: secret })).not.toThrow();
  });

  // What the operator command shows carries nothing that authenticates.
  it("lists registrations without any token value or hash (#184)", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const client = mustRegister(store, ["https://chatgpt.com/cb"], "ChatGPT");
    const tokens = store.issueTokens(client.clientId, "vault.read", "r");
    const listed = store.listRegistrations();
    expect(listed).toEqual([
      {
        clientId: client.clientId,
        consent: "pending",
        clientName: "ChatGPT",
        redirectUris: ["https://chatgpt.com/cb"],
        createdAt: client.createdAt,
        liveAccessTokens: 1,
        liveRefreshTokens: 1
      }
    ]);
    const shown = JSON.stringify(listed);
    const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
    for (const secretValue of [
      tokens.accessToken,
      tokens.refreshToken,
      hash(tokens.accessToken),
      hash(tokens.refreshToken)
    ]) {
      expect(shown).not.toContain(secretValue);
    }
  });

  // All or nothing, and everything bound to the removed registration goes with
  // it, pending codes included.
  //
  // Reverse-verified: dropping the unknown-id check reddens the first block
  // (the known id is removed); dropping the code sweep reddens the code assert.
  it("removes registrations all or nothing, with their tokens and pending codes (#184)", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const doomed = mustRegister(store, ["https://doomed.example/cb"]);
    const kept = mustRegister(store, ["https://kept.example/cb"]);
    const doomedTokens = store.issueTokens(doomed.clientId, "vault.read", "r");
    const keptTokens = store.issueTokens(kept.clientId, "vault.read", "r");
    const code = store.createAuthorizationCode({
      clientId: doomed.clientId,
      redirectUri: "https://doomed.example/cb",
      codeChallenge: "challenge",
      scope: "vault.read",
      resource: "r"
    });

    expect(() => store.removeRegistrations([doomed.clientId, "client_not-there"])).toThrow("unknown_client");
    expect(store.getClient(doomed.clientId)).toBeDefined(); // nothing was removed

    expect(store.removeRegistrations([doomed.clientId])).toBe(true);
    expect(store.getClient(doomed.clientId)).toBeUndefined();
    expect(store.validateAccessToken(doomedTokens.accessToken)).toBeNull();
    expect(store.consumeAuthorizationCode(code)).toBeUndefined();
    expect(store.validateAccessToken(keptTokens.accessToken)?.clientId).toBe(kept.clientId); // control
  });

  // An operator must not be told it worked when the file was not written.
  //
  // Reverse-verified: returning true regardless of the save reddens the first
  // assert.
  it("reports a removal that could not be saved (#184)", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const client = mustRegister(store, ["https://chatgpt.com/cb"]);
    await fs.mkdir(`${file}.tmp`);
    expect(store.removeRegistrations([client.clientId])).toBe(false);
    await fs.rmdir(`${file}.tmp`);
    // The file still holds it, so the operator can try again.
    expect(
      new OAuthStore({ ...opts, persistPath: file, persistSecret: secret }).getClient(client.clientId)
    ).toBeDefined();
  });

  it("persists clients and tokens across a restart without raw secrets on disk", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const client = mustRegister(store, ["https://chatgpt.com/cb"], "test");
    const tokens = store.issueTokens(client.clientId, "vault.read", "r");

    // Hash-at-rest: the state file must not contain any recoverable credential.
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain(tokens.accessToken);
    expect(raw).not.toContain(tokens.refreshToken);

    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    expect(reloaded.getClient(client.clientId)?.redirectUris).toEqual(["https://chatgpt.com/cb"]);
    expect(reloaded.validateAccessToken(tokens.accessToken)?.scope).toBe("vault.read");
    expect(reloaded.rotateRefreshToken(tokens.refreshToken, client.clientId)).not.toBeNull();
  });

  it("keeps refresh-token rotation single-use across restarts once the grace closes", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const rotated = store.rotateRefreshToken(tokens.refreshToken, "c");
    expect(rotated).not.toBeNull();

    t += ROTATION_GRACE_MS + 1;
    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    expect(reloaded.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull(); // old one stays dead
    expect(reloaded.rotateRefreshToken(rotated!.refreshToken, "c")).not.toBeNull();
  });

  it("carries the replay-grace state across a restart (window survives, and never re-opens)", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c"); // response lost; window opens at t0
    expect(lost).not.toBeNull();

    // Restart inside the window: the replay must still work — and must still
    // revoke the successors minted before the restart.
    t += 30_000;
    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    const replayed = reloaded.rotateRefreshToken(tokens.refreshToken, "c");
    expect(replayed).not.toBeNull();
    expect(reloaded.validateAccessToken(lost!.accessToken)).toBeNull();
    expect(reloaded.rotateRefreshToken(lost!.refreshToken, "c")).toBeNull();

    // Restart again, past the ORIGINAL window: if `rotatedAt` were dropped on
    // load, this replay would look like a first rotation and the window would
    // silently re-open. It must stay closed.
    t += ROTATION_GRACE_MS;
    const reloadedLate = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    expect(reloadedLate.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull();
    // The replayed pair's refresh leg (TTL 600s) is still the live credential —
    // its access leg (TTL 60s) has legitimately expired by now, so assert on
    // the refresh token, not the access token.
    expect(reloadedLate.rotateRefreshToken(replayed!.refreshToken, "c")).not.toBeNull();
  });

  it("persists the invalidation even when a rotation fails (client mismatch)", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const tokens = store.issueTokens("c", "vault.read", "r");
    expect(store.rotateRefreshToken(tokens.refreshToken, "wrong")).toBeNull();

    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    expect(reloaded.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull();
  });

  it("never persists authorization codes", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const code = store.createAuthorizationCode({
      clientId: "c",
      redirectUri: "https://x/cb",
      codeChallenge: "ch",
      scope: "",
      resource: "r"
    });
    // Trigger a save AFTER the code exists (createAuthorizationCode itself does
    // not persist), so the file is written while the code is live — this is what
    // makes the assertion non-vacuous: codes must still be absent on reload.
    mustRegister(store, ["https://chatgpt.com/cb"]);
    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    expect(reloaded.consumeAuthorizationCode(code)).toBeUndefined();
  });

  it("fails closed on a tampered state file", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const client = mustRegister(store, ["https://chatgpt.com/cb"]);
    const tokens = store.issueTokens(client.clientId, "vault.read", "r");

    // Privilege-escalation attempt: flip the persisted scope to vault.write.
    const envelope = JSON.parse(await fs.readFile(file, "utf8"));
    envelope.payload = (envelope.payload as string).replaceAll("vault.read", "vault.write");
    await fs.writeFile(file, JSON.stringify(envelope));

    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    expect(reloaded.validateAccessToken(tokens.accessToken)).toBeNull();
    expect(reloaded.getClient(client.clientId)).toBeUndefined();
  });

  it("fails closed when the login password was rotated", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const tokens = store.issueTokens("c", "vault.read", "r");

    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: "rotated-password" });
    expect(reloaded.validateAccessToken(tokens.accessToken)).toBeNull();
    expect(reloaded.rotateRefreshToken(tokens.refreshToken, "c")).toBeNull();
  });

  // The envelope's `version` and `salt` sit OUTSIDE the MAC, so the tamper
  // test above (which edits the MAC'd payload) never reaches the checks on
  // them. Each case keeps the MAC valid for what it presents, so only the field
  // check can refuse it. The unmodified file and a re-MAC'd envelope with a
  // well-formed salt are loaded first as controls — they prove the file and the
  // test's own MAC computation are good, so the refusals are the checks.
  //
  // Reverse-verified (2026-09-25, each reddening only this test):
  //   - `envelope.version !== STATE_VERSION ||` removed → version 2 loads
  //   - salt-length check disabled (`if (false)`) → an 8-byte salt loads
  //   - MAC compare replaced by `!presented.equals(expected)` →
  //     timingSafeEqual spy 0 calls
  //   - mismatches short-circuited by `!presented.equals(expected)` BEFORE
  //     timingSafeEqual (kept on the success path only) → spy 1 call, not 2
  //     (the wrong same-length MAC never reached the constant-time compare)
  it("fails closed on an unknown version or a malformed salt, and checks the MAC in constant time (INV-7 item 7)", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const original = JSON.parse(await fs.readFile(file, "utf8"));

    const loadWith = async (envelope: unknown) => {
      await fs.writeFile(file, JSON.stringify(envelope));
      return new OAuthStore({ ...opts, persistPath: file, persistSecret: secret }).validateAccessToken(
        tokens.accessToken
      );
    };
    const remac = (salt: Buffer) => signedEnvelope(original, original.payload as string, salt);

    // The spy covers a matching MAC AND a wrong one of the same length: the
    // mismatch is the attacker-controlled case, so it is the one that must
    // reach the constant-time compare.
    const mac = original.mac as string;
    const wrongMac = mac.slice(0, -1) + (mac.endsWith("0") ? "1" : "0");
    const compare = vi.spyOn(crypto, "timingSafeEqual");
    try {
      expect((await loadWith(original))?.clientId).toBe("c");
      expect(await loadWith({ ...original, mac: wrongMac })).toBeNull();
      expect(compare).toHaveBeenCalledTimes(2);
    } finally {
      compare.mockRestore();
    }
    expect((await loadWith(remac(crypto.randomBytes(16))))?.clientId).toBe("c");

    expect(await loadWith({ ...original, version: 2 })).toBeNull();
    expect(await loadWith(remac(crypto.randomBytes(8)))).toBeNull();
  });

  // The loader's conservative readings of damaged lineage, which no test had
  // reached because a file carrying them must pass the MAC (see the ledger in
  // the "OAuthStore" block). `signedEnvelope` builds one. Each reading is paired
  // with a replay that WOULD reach a victim if the reading were not there, and
  // with a control showing that replay did revoke what it legitimately owns:
  //   - a record with no usable familyId gets a family of its own, so a replay
  //     in one damaged lineage cannot revoke another damaged lineage;
  //   - a record with an unusable generation reads as generation 0, so a replay
  //     of generation 0 in the same family does not reach it;
  //   - a tombstone with an unusable generation is dropped, so presenting its
  //     token revokes nothing.
  //
  // Reverse-verified (2026-09-25, each reddening only this test, each on its
  // own victim's assert):
  //   - familyId fallback `randomSecret()` → a fixed `"shared"` → pair B revoked
  //   - generation fallback removed (raw value kept) → pair E (1.5) revoked
  //   - tombstone `tombstone.generation >= 0 &&` removed → pair F revoked
  it("reads unusable lineage conservatively and drops a malformed tombstone at load (INV-7 item 7)", async () => {
    const file = await stateFilePath();
    const t = 1_000_000;
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    const [a, b, d, e, f] = [1, 2, 3, 4, 5].map(() => store.issueTokens("c", "vault.read", "r"));
    const original = JSON.parse(await fs.readFile(file, "utf8"));
    const payload = JSON.parse(original.payload as string);

    const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
    type Persisted = { tokenHash: string; familyId?: unknown; generation?: unknown };
    const recordsOf = (pair: { accessToken: string; refreshToken: string }): Persisted[] => [
      (payload.accessTokens as Persisted[]).find((r) => r.tokenHash === hash(pair.accessToken))!,
      (payload.refreshTokens as Persisted[]).find((r) => r.tokenHash === hash(pair.refreshToken))!
    ];
    for (const record of [...recordsOf(a), ...recordsOf(b)]) {
      delete record.familyId;
    }
    for (const record of recordsOf(b)) {
      record.generation = 5;
    }
    const familyOfD = recordsOf(d)[0]!.familyId as string;
    for (const record of recordsOf(e)) {
      record.familyId = familyOfD;
      record.generation = 1.5;
    }
    payload.rotatedTombstones = [
      {
        tokenHash: hash("ghost-refresh-token"),
        clientId: "c",
        familyId: recordsOf(f)[0]!.familyId,
        generation: -1,
        expiresAt: t + 30_000
      }
    ];
    await fs.writeFile(file, JSON.stringify(signedEnvelope(original, JSON.stringify(payload), crypto.randomBytes(16))));

    const loaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });

    // Damaged lineage A: rotate, then replay inside the grace window.
    const a1 = loaded.rotateRefreshToken(a.refreshToken, "c");
    expect(a1).not.toBeNull();
    expect(loaded.rotateRefreshToken(a.refreshToken, "c")).not.toBeNull();
    expect(loaded.validateAccessToken(a1!.accessToken)).toBeNull(); // control: the replay revoked A's successor
    expect(loaded.validateAccessToken(b.accessToken)?.clientId).toBe("c"); // B is not in A's family

    // Intact lineage D, with E's damaged generation filed under it.
    const d1 = loaded.rotateRefreshToken(d.refreshToken, "c");
    expect(loaded.rotateRefreshToken(d.refreshToken, "c")).not.toBeNull();
    expect(loaded.validateAccessToken(d1!.accessToken)).toBeNull(); // control
    expect(loaded.validateAccessToken(e.accessToken)?.clientId).toBe("c"); // E reads as generation 0

    // The malformed tombstone was dropped, so its token is just a dead token.
    expect(loaded.rotateRefreshToken("ghost-refresh-token", "c")).toBeNull();
    expect(loaded.validateAccessToken(f.accessToken)?.clientId).toBe("c");
  });

  // The loader drops expired tokens, and it used to sweep the clients left
  // holding none. It now reclaims only the unconsented ones past their
  // deadline (#184): a consented client whose tokens all lapsed is exactly the
  // one that comes back later with the same client_id, and ChatGPT will not
  // register again to recover from a missing one.
  //
  // Reverse-verified: removing the reclaim from load reddens the control (the
  // pending client survives); letting it take `given` reddens the other assert.
  it("keeps a consented client at load after every token lapsed, and reclaims an unconsented one (#184)", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    const client = mustRegister(store, ["https://chatgpt.com/cb"]);
    expect(store.recordConsent(client.clientId)).toBe(true);
    const tokens = store.issueTokens(client.clientId, "vault.read", "r");
    const pending = mustRegister(store, ["https://pending/cb"]);

    t += REGISTRATION_CONSENT_DEADLINE_MS + 60 * 60 * 1000;
    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    expect(reloaded.rotateRefreshToken(tokens.refreshToken, client.clientId)).toBeNull(); // reached: tokens dropped
    expect(reloaded.getClient(client.clientId)?.redirectUris).toEqual(["https://chatgpt.com/cb"]);
    expect(reloaded.getClient(pending.clientId)).toBeUndefined(); // control: the reclaim ran at load
  });

  // A state file written before `consent` existed cannot tell a registration
  // whose tokens all lapsed from one that was never used (#184). Such a
  // registration must never be read as `pending`, or the first load past the
  // deadline would drop a ChatGPT connection that was working.
  //
  // Reverse-verified: reading a missing `consent` as "pending" reddens the
  // survival assert.
  it("loads a registration from an older state file as unknown and keeps it, tokenless (#184)", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    const client = mustRegister(store, ["https://chatgpt.com/cb"]);
    const original = JSON.parse(await fs.readFile(file, "utf8"));
    const payload = JSON.parse(original.payload as string);
    for (const record of payload.clients as Record<string, unknown>[]) {
      delete record.consent; // what an older writer produced
    }
    await fs.writeFile(file, JSON.stringify(signedEnvelope(original, JSON.stringify(payload), crypto.randomBytes(16))));

    t += 31 * 24 * 60 * 60 * 1000;
    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    expect(reloaded.getClient(client.clientId)?.consent).toBe("unknown");
    reloaded.registerClient(["https://later/cb"]); // the reclaim also runs here
    expect(reloaded.getClient(client.clientId)?.redirectUris).toEqual(["https://chatgpt.com/cb"]);
  });

  // Rolling back to a binary that does not record consent, consenting there,
  // and moving forward again leaves a registration saved as `pending` that
  // holds live tokens (#184). A token is proof of consent, so load reads it as
  // `given` instead of reclaiming a working connection 24 h after its creation.
  // The file is built the way that round trip leaves it: a pending
  // registration with tokens issued to it directly.
  //
  // The tokenless pending registration beside it is the control: reclaimed
  // at the same load, which also shows the reclaim ran after the tokens were
  // read.
  //
  // Reverse-verified: removing consentFromLiveTokens from load reddens the
  // first two asserts.
  it("reads a pending registration that holds a live token as consented at load (#184)", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const longRefresh = { ...opts, refreshTokenTtlSec: 30 * 24 * 60 * 60 };
    const store = new OAuthStore({ ...longRefresh, persistPath: file, persistSecret: secret, now: () => t });
    const roundTripped = mustRegister(store, ["https://chatgpt.com/cb"]);
    const tokens = store.issueTokens(roundTripped.clientId, "vault.read", "r");
    const tokenless = mustRegister(store, ["https://pending/cb"]);

    t += REGISTRATION_CONSENT_DEADLINE_MS + 60 * 60 * 1000;
    const reloaded = new OAuthStore({ ...longRefresh, persistPath: file, persistSecret: secret, now: () => t });
    expect(reloaded.getClient(roundTripped.clientId)?.consent).toBe("given");
    reloaded.registerClient(["https://later/cb"]);
    expect(reloaded.getClient(roundTripped.clientId)).toBeDefined();
    expect(reloaded.rotateRefreshToken(tokens.refreshToken, roundTripped.clientId)).not.toBeNull(); // reached: live
    expect(reloaded.getClient(tokenless.clientId)).toBeUndefined(); // control
  });

  // The promotion above has to reach the file while its proof exists. If load
  // kept it only in memory and nothing else saved before the tokens lapsed, the
  // next start would read `pending` with no tokens and reclaim it.
  //
  // Reverse-verified: removing the save at the end of load reddens the last
  // assert.
  it("writes a consent read from live tokens to the state file at load (#184)", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const longRefresh = { ...opts, refreshTokenTtlSec: 30 * 24 * 60 * 60 };
    const store = new OAuthStore({ ...longRefresh, persistPath: file, persistSecret: secret, now: () => t });
    const roundTripped = mustRegister(store, ["https://chatgpt.com/cb"]);
    const tokens = store.issueTokens(roundTripped.clientId, "vault.read", "r");

    t += REGISTRATION_CONSENT_DEADLINE_MS + 60 * 60 * 1000;
    new OAuthStore({ ...longRefresh, persistPath: file, persistSecret: secret, now: () => t }); // nothing else saves

    t += 31 * 24 * 60 * 60 * 1000;
    const later = new OAuthStore({ ...longRefresh, persistPath: file, persistSecret: secret, now: () => t });
    expect(later.rotateRefreshToken(tokens.refreshToken, roundTripped.clientId)).toBeNull(); // reached: proof gone
    expect(later.getClient(roundTripped.clientId)?.consent).toBe("given");
  });

  // Load writes only for a promotion. A load that promotes nothing leaves the
  // file as it was, and a load that failed verification — which starts empty —
  // must never write that empty state over the file it could not read.
  //
  // Reverse-verified: saving at the end of every verified load reddens the
  // first assert (the expired token is dropped from the file); saving in the
  // failure path reddens the second.
  it("does not rewrite the state file at load unless it promoted a registration (#184)", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    const client = mustRegister(store, ["https://chatgpt.com/cb"]);
    store.recordConsent(client.clientId);
    store.issueTokens(client.clientId, "vault.read", "r"); // refresh TTL 600 s
    const written = await fs.readFile(file, "utf8");

    t += 60 * 60 * 1000; // the token has expired, so a rewrite would differ
    new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    expect(await fs.readFile(file, "utf8")).toBe(written);

    const tampered = written.replace(/"mac":"(.)/, (_m, c: string) => `"mac":"${c === "0" ? "1" : "0"}`);
    expect(tampered).not.toBe(written); // reached: the MAC really changed
    await fs.writeFile(file, tampered);
    const empty = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    expect(empty.getClient(client.clientId)).toBeUndefined(); // it did fail closed
    expect(await fs.readFile(file, "utf8")).toBe(tampered);
  });

  // Consent is saved before any code is issued, and saved again on every
  // attempt (#184). After one failed save the memory says `given` and the disk
  // `pending`; a retry that trusted the memory would answer without saving,
  // and a restart past the deadline would drop a client that was told it was
  // authorized.
  //
  // The save is made to fail by putting a directory where the store writes its
  // temporary file.
  //
  // Reverse-verified: returning true without saving reddens the first assert;
  // skipping the save for a client already `given` reddens the last.
  it("saves consent before answering, and saves it again on a retry (#184)", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    const client = mustRegister(store, ["https://chatgpt.com/cb"]);

    await fs.mkdir(`${file}.tmp`);
    expect(store.recordConsent(client.clientId)).toBe(false);
    await fs.rmdir(`${file}.tmp`);
    expect(store.recordConsent(client.clientId)).toBe(true);

    t += REGISTRATION_CONSENT_DEADLINE_MS + 1;
    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    expect(reloaded.getClient(client.clientId)?.consent).toBe("given");
  });

  // A registration answered with 201 must survive a restart, or ChatGPT is
  // left presenting a client_id nobody knows. So a registration that could not
  // be saved is not kept in memory and not answered.
  //
  // Reverse-verified: returning the client despite the failed save reddens
  // the throw assert.
  it("does not keep or answer a registration it could not save (#184)", async () => {
    const file = await stateFilePath();
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => 1_000_000 });
    const before = mustRegister(store, ["https://before/cb"]);

    await fs.mkdir(`${file}.tmp`);
    expect(() => store.registerClient(["https://chatgpt.com/cb"])).toThrow("registration_not_persisted");
    await fs.rmdir(`${file}.tmp`);

    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => 1_000_000 });
    expect(reloaded.getClient(before.clientId)).toBeDefined(); // control: the file is readable
    const payload = JSON.parse(JSON.parse(await fs.readFile(file, "utf8")).payload as string);
    expect((payload.clients as unknown[]).length).toBe(1);
    // And the memory did not keep it either: the next save writes exactly two.
    mustRegister(store, ["https://after/cb"]);
    const after = JSON.parse(JSON.parse(await fs.readFile(file, "utf8")).payload as string);
    expect((after.clients as unknown[]).length).toBe(2);
  });

  // A corrupt state file used to be overwritten by the next save (#263). The
  // store still loads without throwing and holds nothing from it, but it does
  // not write over it: the bytes are there for whoever repairs or replaces them.
  it("fails closed on a corrupt state file without throwing, and leaves it in place (#263)", async () => {
    const file = await stateFilePath();
    await fs.writeFile(file, "not json {{{", "utf8");
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
    expect(store.loadOutcome).toBe("failed");
    expect(store.validateAccessToken("anything")).toBeNull();
    store.issueTokens("c", "vault.read", "r");
    expect(await fs.readFile(file, "utf8")).toBe("not json {{{");
  });

  it("drops expired tokens at load time but keeps live ones", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    const tokens = store.issueTokens("c", "vault.read", "r");

    t += 61_000; // past the 60s access TTL, within the 600s refresh TTL
    const reloaded = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret, now: () => t });
    expect(reloaded.validateAccessToken(tokens.accessToken)).toBeNull();
    expect(reloaded.rotateRefreshToken(tokens.refreshToken, "c")).not.toBeNull();
  });

  // Pins the umask to 022 for the same reason as the directory test below:
  // under a restrictive umask (077) a write WITHOUT the mode also comes out
  // 0600, and this test would be vacuous on that host.
  //
  // Reverse-verified (2026-09-25): dropping `{ mode: 0o600 }` from the
  // writeFileSync in save() reddens only this test (0644 under umask 022).
  it("writes the state file with owner-only permissions", async () => {
    if (process.platform === "win32") {
      return;
    }
    const file = await stateFilePath();
    const previous = process.umask(0o022);
    try {
      const store = new OAuthStore({ ...opts, persistPath: file, persistSecret: secret });
      store.issueTokens("c", "vault.read", "r");
    } finally {
      process.umask(previous);
    }
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  // INV-7 item 7: the directory the store creates for its state file is
  // owner-only too. mkdir's mode is filtered by the umask, so under a
  // restrictive umask (077) a mkdir WITHOUT the mode would also come out 0700
  // and this test would be vacuous. It therefore pins the umask to the common
  // 022 for its own duration, under which a mode-less mkdir yields 0755.
  //
  // Reverse-verified (2026-09-24): dropping `mode: 0o700` from the mkdirSync
  // in save() reddens only this test (0755 observed under umask 022).
  it("creates the state directory with owner-only permissions", async () => {
    if (process.platform === "win32") {
      return;
    }
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-statedir-"));
    const dir = path.join(parent, "not-yet-created");
    const previous = process.umask(0o022);
    try {
      const store = new OAuthStore({ ...opts, persistPath: path.join(dir, "oauth-state.json"), persistSecret: secret });
      store.issueTokens("c", "vault.read", "r");
    } finally {
      process.umask(previous);
    }
    // The state file landing proves save() ran and created the directory,
    // rather than the assert below reading a directory made some other way.
    await expect(fs.stat(path.join(dir, "oauth-state.json"))).resolves.toBeTruthy();
    const stat = await fs.stat(dir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("persists an observed revocation, and skips the write when it removes nothing (F1)", async () => {
    const file = await stateFilePath();
    let t = 1_000_000;
    const store = new OAuthStore({
      ...opts,
      accessTokenTtlSec: 3600,
      persistPath: file,
      persistSecret: secret,
      now: () => t
    });
    const tokens = store.issueTokens("c", "vault.read", "r");
    const lost = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    const held = store.rotateRefreshToken(lost.refreshToken, "c")!;

    t += 30_000;
    store.observeRotationReplay(tokens.refreshToken, "c");

    // Half one: it reached disk. The refusal path has no mint after it to carry
    // the revocation into a shared save, so a restart would otherwise resurrect
    // exactly what the replay was for.
    const reloaded = new OAuthStore({
      ...opts,
      accessTokenTtlSec: 3600,
      persistPath: file,
      persistSecret: secret,
      now: () => t
    });
    expect(reloaded.validateAccessToken(held.accessToken)).toBeNull();
    // Control for that: the file really loaded. A fail-closed empty state would
    // satisfy the line above for the wrong reason, and generation 0 was never
    // part of what the replay revokes.
    expect(reloaded.validateAccessToken(tokens.accessToken)?.clientId).toBe("c");

    // Half two: the refusal path is reachable without limit — that is what it is
    // for — so a repeat presentation must not be one whole-file rewrite per
    // request. The sentinel is how a SKIPPED write is observed: a save replaces
    // the file, so surviving bytes mean no save was attempted.
    await fs.writeFile(file, "SENTINEL", "utf8");
    store.observeRotationReplay(tokens.refreshToken, "c");
    expect(await fs.readFile(file, "utf8")).toBe("SENTINEL");

    // Control for the sentinel: a call that DOES change state still writes, so
    // the assertion above is about the skip and not about a store that had
    // quietly stopped persisting altogether.
    store.issueTokens("c", "vault.read", "r");
    expect(await fs.readFile(file, "utf8")).not.toBe("SENTINEL");
  });

  it("skips the write on a repeat observation once the root has been swept (F1)", async () => {
    // The same write-skip on the other arm. Stated separately rather than
    // assumed from the record arm: it is a second `save()` call site, and the
    // arm it sits on is the one the #170 scenario actually lands in.
    const file = await stateFilePath();
    let t = 1_000_000;
    const maxTokens = 4;
    const store = new OAuthStore({
      ...opts,
      accessTokenTtlSec: 3600,
      maxTokens,
      persistPath: file,
      persistSecret: secret,
      now: () => t
    });
    const tokens = store.issueTokens("c", "vault.read", "r");
    let held = store.rotateRefreshToken(tokens.refreshToken, "c")!;
    for (let i = 0; i < maxTokens - 1; i += 1) {
      held = store.rotateRefreshToken(held.refreshToken, "c")!;
    }
    const rootKey = crypto.createHash("sha256").update(tokens.refreshToken).digest("hex");
    // Control: the record really was swept, so the tombstone arm is what runs.
    expect((store as unknown as { refreshTokens: Map<string, unknown> }).refreshTokens.has(rootKey)).toBe(false);

    t += 30_000;
    store.observeRotationReplay(tokens.refreshToken, "c");
    expect(store.validateAccessToken(held.accessToken)).toBeNull(); // control: it did revoke

    // The second presentation finds nothing left above the root, so there is no
    // state change to persist and no file to rewrite.
    await fs.writeFile(file, "SENTINEL", "utf8");
    store.observeRotationReplay(tokens.refreshToken, "c");
    expect(await fs.readFile(file, "utf8")).toBe("SENTINEL");

    // Control for the sentinel, as above.
    store.issueTokens("c", "vault.read", "r");
    expect(await fs.readFile(file, "utf8")).not.toBe("SENTINEL");
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
    // RFC 9207: advertising iss support is mandatory while authorizePost emits
    // it — these two assertions (here and in the code-issuance test) pin the
    // pair so neither can be dropped alone.
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    const pr = JSON.parse(provider.protectedResourceMetadata().body);
    expect(pr.resource).toBe(`${config.issuer}/mcp`);
    expect(pr.authorization_servers).toEqual([config.issuer]);
    // Writes are off here, so neither document may advertise vault.write. The
    // resource side was already asserted elsewhere; the AS side was not.
    // Reverse-verified (2026-09-25): hard-coding the AS `scopes_supported` to
    // [SCOPE_READ, SCOPE_WRITE] reddens only this test.
    expect(as.scopes_supported).toEqual(["vault.read"]);
    expect(pr.scopes_supported).toEqual(["vault.read"]);
  });

  // Pins the registration MECHANISM, and only that: while this key is absent, a
  // conformant client gates on it and registers through /register instead of
  // presenting a URL-shaped client_id of its own choosing. It deliberately does
  // NOT pin how long an id lives — in the same SDK the CIMD-vs-registerClient
  // choice sits inside `if (!clientInformation)`, so a host that persists its
  // saved registration reuses one id indefinitely, and no server-side assertion
  // can see that. The `client_id` appendix in docs/ROADMAP.md says why that
  // distinction matters. Advertising CIMD support changes the mechanism, so this
  // assertion is the re-open trigger for that section: it is meant to go red on
  // the commit that adds support, and that commit's job is to revisit the
  // appendix, not to delete this test.
  it("does not advertise CIMD support, so a conformant client registers through DCR", () => {
    const provider = new OAuthProvider(config);
    const as = JSON.parse(provider.authorizationServerMetadata().body);
    expect(as.client_id_metadata_document_supported).toBeUndefined();
    // Positive controls: an absent key proves nothing unless the object it is
    // absent from is the real metadata, so assert two keys that must be present.
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.registration_endpoint).toBe(`${config.issuer}/register`);
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

  // #184: a full share of unconsented registrations refuses rather than
  // evicts, and /register says so with a status the caller cannot fix by
  // changing its request.
  it("answers 503 when the unconsented slots are full and keeps the earlier clients working", () => {
    const provider = new OAuthProvider(config);
    const first = JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body).client_id as string;
    for (let i = 1; i < MAX_UNCONSENTED_CLIENTS; i += 1) {
      expect(provider.register({ redirect_uris: [`https://c-${i}/cb`] }).status).toBe(201);
    }

    const refused = provider.register({ redirect_uris: ["https://newcomer/cb"] });
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body).error).toBe("temporarily_unavailable");

    const { challenge } = pkcePair();
    expect(provider.authorizeGet(authorizeParams(first, challenge)).status).toBe(200);
  });

  // #184, end to end through the provider: the consent page is opened, left
  // for two hours, another client registers in the meantime, and the approval
  // still completes. This is the shape Codex's proposal names R1 (GET -> wait
  // -> DCR -> POST), and the shape the original report describes.
  //
  // Two hours is past the old one-hour grace and inside the consent deadline.
  // A page left open past the deadline is the next test.
  //
  // Reverse-verified: putting back a sweep of tokenless registrations older
  // than one hour, run from registerClient, reddens this test at the POST
  // (400 Unknown client_id. instead of 302).
  it("completes a consent left open for two hours while another client registers (#184)", () => {
    let t = 1_000_000;
    const store = new OAuthStore({
      accessTokenTtlSec: config.accessTokenTtlSec,
      refreshTokenTtlSec: config.refreshTokenTtlSec,
      codeTtlSec: config.codeTtlSec,
      now: () => t
    });
    const provider = new OAuthProvider(config, store);
    const clientId = JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body)
      .client_id as string;
    const { verifier, challenge } = pkcePair();
    const form = authorizeParams(clientId, challenge);
    expect(provider.authorizeGet(form).status).toBe(200); // the consent page is shown

    t += 2 * 60 * 60 * 1000; // past the old one-hour grace, inside the consent deadline
    expect(provider.register({ redirect_uris: ["https://other/cb"] }).status).toBe(201); // where the sweep used to run

    form.set("password", "hunter2");
    const granted = provider.authorizePost(form);
    expect(granted.status).toBe(302);
    const code = new URL(granted.headers.location).searchParams.get("code")!;
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
  });

  function clockedProvider(codeTtlSec = config.codeTtlSec) {
    const clock = { t: 1_000_000 };
    const store = new OAuthStore({
      accessTokenTtlSec: config.accessTokenTtlSec,
      refreshTokenTtlSec: config.refreshTokenTtlSec,
      codeTtlSec,
      now: () => clock.t
    });
    return { clock, store, provider: new OAuthProvider(config, store) };
  }

  function exchangeCode(provider: OAuthProvider, clientId: string, code: string, verifier: string) {
    return provider.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: "https://chatgpt.com/cb",
        code_verifier: verifier
      })
    );
  }

  // #184: consent given one millisecond before the deadline is recorded before
  // the code exists, so a reclaim that runs between the code and its exchange
  // finds a consented registration and leaves it alone. The connection then
  // survives indefinitely.
  //
  // Reverse-verified: removing the recordConsent call from authorizePost
  // reddens the exchange (400 "client is no longer registered").
  it("keeps a client that consented just before its deadline, through the exchange and after (#184)", () => {
    const { clock, provider, store } = clockedProvider();
    const clientId = JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body)
      .client_id as string;
    const { verifier, challenge } = pkcePair();
    const form = authorizeParams(clientId, challenge);

    clock.t += REGISTRATION_CONSENT_DEADLINE_MS - 1;
    form.set("password", "hunter2");
    const granted = provider.authorizePost(form);
    expect(granted.status).toBe(302);
    const code = new URL(granted.headers.location).searchParams.get("code")!;

    clock.t += 2; // past the deadline, inside the code's 60 s
    expect(provider.register({ redirect_uris: ["https://other/cb"] }).status).toBe(201); // the reclaim runs
    expect(exchangeCode(provider, clientId, code, verifier).status).toBe(200);

    clock.t += 31 * 24 * 60 * 60 * 1000;
    provider.register({ redirect_uris: ["https://later/cb"] });
    expect(store.getClient(clientId)?.consent).toBe("given");
  });

  // #184: the deadline runs from creation. Opening the consent page, which
  // anyone can do without the password, neither extends it nor promotes the
  // registration, so a flood of registrations that are merely looked at is
  // still reclaimed and makes room again.
  //
  // Reverse-verified: resetting createdAt in validateAuthorizeParams, and
  // separately recording consent there, each redden the reclaim assert.
  it("does not let an unauthenticated authorize request extend or promote a registration (#184)", () => {
    const { clock, provider, store } = clockedProvider();
    const { challenge } = pkcePair();
    const flood: string[] = [];
    for (let i = 0; i < MAX_UNCONSENTED_CLIENTS; i += 1) {
      flood.push(JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body).client_id as string);
    }
    clock.t += REGISTRATION_CONSENT_DEADLINE_MS - 1;
    for (const clientId of flood) {
      expect(provider.authorizeGet(authorizeParams(clientId, challenge)).status).toBe(200); // reached
    }

    clock.t += 1;
    expect(provider.register({ redirect_uris: ["https://newcomer/cb"] }).status).toBe(201);
    for (const clientId of flood) {
      expect(store.getClient(clientId)).toBeUndefined();
    }
    // What is left after the deadline, stated: the page opened for it is now a 400.
    expect(provider.authorizeGet(authorizeParams(flood[0]!, challenge)).status).toBe(400);
  });

  // #184: a code whose registration is gone yields no token. Consent before
  // the code makes this unreachable through the provider today, so the test
  // builds that state directly: a code minted in the store for a registration
  // nobody consented to, exchanged after the registration was reclaimed. The
  // code TTL is stretched past the deadline so that it is the registration,
  // not the code, that is gone.
  //
  // Reverse-verified: removing the getClient check from tokenFromCode reddens
  // the status assert (200).
  it("issues no token for a code whose registration is gone (#184)", () => {
    const { clock, provider, store } = clockedProvider((2 * REGISTRATION_CONSENT_DEADLINE_MS) / 1000);
    const client = mustRegister(store, ["https://chatgpt.com/cb"]);
    const { verifier, challenge } = pkcePair();
    const code = store.createAuthorizationCode({
      clientId: client.clientId,
      redirectUri: "https://chatgpt.com/cb",
      codeChallenge: challenge,
      scope: "vault.read",
      resource: `${config.issuer}/mcp`
    });

    clock.t += REGISTRATION_CONSENT_DEADLINE_MS;
    mustRegister(store, ["https://other/cb"]);
    expect(store.getClient(client.clientId)).toBeUndefined(); // reached: the registration is gone

    const refused = exchangeCode(provider, client.clientId, code, verifier);
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body).error).toBe("invalid_grant");
  });

  // #184: when consent cannot be saved, no code is issued, and the retry that
  // follows works.
  //
  // Reverse-verified: ignoring recordConsent's result in authorizePost reddens
  // the 503 assert.
  it("issues no code when consent cannot be saved, and does on the retry (#184)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-state-"));
    const file = path.join(dir, "oauth-state.json");
    const store = new OAuthStore({
      accessTokenTtlSec: config.accessTokenTtlSec,
      refreshTokenTtlSec: config.refreshTokenTtlSec,
      codeTtlSec: config.codeTtlSec,
      persistPath: file,
      persistSecret: config.loginPassword
    });
    const provider = new OAuthProvider(config, store);
    const clientId = JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body)
      .client_id as string;
    const { challenge } = pkcePair();
    const form = authorizeParams(clientId, challenge);
    form.set("password", "hunter2");

    await fs.mkdir(`${file}.tmp`);
    const failed = provider.authorizePost(form);
    expect(failed.status).toBe(503);
    expect(failed.headers.location).toBeUndefined();
    await fs.rmdir(`${file}.tmp`);
    expect(provider.authorizePost(form).status).toBe(302);
  });

  // #184: only the password promotes. A POST with the wrong one is refused
  // and leaves the registration pending, so it is still reclaimed at its
  // deadline. If a wrong password promoted, an anonymous caller could create
  // `given` registrations, which are never reclaimed, and fill the registry
  // for good.
  //
  // Reverse-verified: recording consent inside the wrong-password branch
  // reddens the "pending" assert.
  it("leaves a registration pending after a POST with the wrong password (#184)", () => {
    const { clock, provider, store } = clockedProvider();
    const clientId = JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body)
      .client_id as string;
    const { challenge } = pkcePair();
    const form = authorizeParams(clientId, challenge);
    form.set("password", `${config.loginPassword}-not`);

    const denied = provider.authorizePost(form);
    expect(denied.status).toBe(200); // reached: the form is shown again, no redirect
    expect(denied.headers.location).toBeUndefined();
    expect(store.getClient(clientId)?.consent).toBe("pending");

    clock.t += REGISTRATION_CONSENT_DEADLINE_MS;
    provider.register({ redirect_uris: ["https://other/cb"] });
    expect(store.getClient(clientId)).toBeUndefined();
  });

  // #184: a registration that could not be written is refused with the same
  // 503 as a full registry, not a 500 and not a 201.
  //
  // Reverse-verified: removing the try/catch around registerClient in
  // provider.register reddens this test (the store's throw escapes).
  it("answers 503 when a registration cannot be saved, and 201 once it can (#184)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-state-"));
    const file = path.join(dir, "oauth-state.json");
    const store = new OAuthStore({
      accessTokenTtlSec: config.accessTokenTtlSec,
      refreshTokenTtlSec: config.refreshTokenTtlSec,
      codeTtlSec: config.codeTtlSec,
      persistPath: file,
      persistSecret: config.loginPassword
    });
    const provider = new OAuthProvider(config, store);

    await fs.mkdir(`${file}.tmp`);
    const refused = provider.register({ redirect_uris: ["https://chatgpt.com/cb"] });
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body).error).toBe("temporarily_unavailable");
    await fs.rmdir(`${file}.tmp`);
    expect(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).status).toBe(201);
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

  // Every other authorize test sends the one redirect_uri the client registered,
  // so the exact-match check was never what decided an outcome. Each variant
  // here would pass the scheme policy on its own (https, concrete host), so only
  // the membership test can refuse it — and a refusal must never be a redirect,
  // or it would hand the code to the unregistered target. The registered value
  // is sent through the same path as a control.
  //
  // Reverse-verified (2026-09-25): `!redirectUri ||
  // !client.redirectUris.includes(redirectUri)` → `!redirectUri` reddens only
  // this test (the first unregistered target is served the login page, 200 for
  // 400); every other test in this file and in httpServer.test.ts stays green.
  it("refuses a redirect_uri the client did not register, without redirecting (INV-7 item 3)", () => {
    const { provider, clientId } = setup(); // registered: https://chatgpt.com/cb
    const { challenge } = pkcePair();

    const control = authorizeParams(clientId, challenge);
    control.set("password", "hunter2");
    expect(provider.authorizePost(control).status).toBe(302);

    for (const unregistered of [
      "https://evil.example/cb",
      "https://chatgpt.com/cb/extra",
      "https://chatgpt.com/cb/",
      "https://chatgpt.com/cb?x=1",
      "https://chatgpt.com:8443/cb",
      "https://CHATGPT.com/cb"
    ]) {
      const params = authorizeParams(clientId, challenge);
      params.set("redirect_uri", unregistered);
      const page = provider.authorizeGet(params);
      expect(page.status, unregistered).toBe(400);
      expect(page.body).toContain("redirect_uri does not match a registered value.");

      params.set("password", "hunter2");
      const post = provider.authorizePost(params);
      expect(post.status, unregistered).toBe(400);
      expect(post.headers.location).toBeUndefined();
    }
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
    // RFC 9207: the redirect binds itself to this AS (mix-up defense).
    expect(location.searchParams.get("iss")).toBe(config.issuer);
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

  // INV-7 item 2: a code is bound to the client_id and redirect_uri it was
  // issued for, and /token re-checks both. Every other exchange in this file
  // presents the same pair it authorized with, so none reaches that branch.
  // (The many "mismatched client_id" tests elsewhere exercise the REFRESH
  // rotation path in the store — a different guard.)
  //
  // The verifier here is the correct one, so PKCE would pass: a 400 can only
  // come from the binding check. The two halves of the `||` are separate
  // defenses and get separate tests, so each mutation names its own arm.
  //
  // Reverse-verified (2026-09-24, each mutation reddening only its own test):
  //   - `record.clientId !== clientId ||` removed    → the client_id test (200 issued)
  //   - `|| record.redirectUri !== redirectUri` removed → the redirect_uri test (200 issued)
  function codeFor(provider: OAuthProvider, clientId: string, redirectUri: string, challenge: string): string {
    const form = authorizeParams(clientId, challenge);
    form.set("redirect_uri", redirectUri);
    form.set("password", config.loginPassword);
    return new URL(provider.authorizePost(form).headers.location).searchParams.get("code")!;
  }

  it("refuses to exchange a code for a different client_id, and burns the code", () => {
    const { provider, clientId } = setup();
    const other = JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body).client_id as string;
    const { verifier, challenge } = pkcePair();
    const code = codeFor(provider, clientId, "https://chatgpt.com/cb", challenge);

    const exchange = (asClient: string) =>
      provider.token(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: asClient,
          redirect_uri: "https://chatgpt.com/cb",
          code_verifier: verifier
        })
      );
    const stolen = exchange(other);
    expect(stolen.status).toBe(400);
    expect(JSON.parse(stolen.body)).toMatchObject({
      error: "invalid_grant",
      error_description: "client/redirect mismatch"
    });
    // Single-use holds on the refusal path too: the rightful client cannot
    // redeem a code that a mismatched presentation already consumed.
    expect(exchange(clientId).status).toBe(400);
  });

  it("refuses to exchange a code at a different registered redirect_uri", () => {
    const provider = new OAuthProvider(config);
    const clientId = JSON.parse(
      provider.register({ redirect_uris: ["https://chatgpt.com/cb", "https://chatgpt.com/other"] }).body
    ).client_id as string;
    const { verifier, challenge } = pkcePair();
    const code = codeFor(provider, clientId, "https://chatgpt.com/cb", challenge);

    const moved = provider.token(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        // Registered for this client, so only the code's binding can refuse it.
        redirect_uri: "https://chatgpt.com/other",
        code_verifier: verifier
      })
    );
    expect(moved.status).toBe(400);
    expect(JSON.parse(moved.body)).toMatchObject({
      error: "invalid_grant",
      error_description: "client/redirect mismatch"
    });
  });

  // `null` omits the `scope` parameter entirely; `""` sends it empty.
  function exchange(provider: OAuthProvider, clientId: string, requestedScope: string | null) {
    const { verifier, challenge } = pkcePair();
    const form = authorizeParams(clientId, challenge);
    if (requestedScope === null) {
      form.delete("scope");
    } else {
      form.set("scope", requestedScope);
    }
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

  // The omitted-scope default is asserted above only on a read-only server,
  // where "read" and "everything grantable" are the same set — so a default of
  // the full grantable set would pass there. On a write-enabled server they
  // differ, and a client that asked for nothing must still get read only.
  // Both shapes of "asked for nothing" are sent: the parameter left out, and
  // the parameter present but empty. They take the same path today; checking
  // each keeps a later change that tells them apart from slipping through on
  // the one this test did not send.
  //
  // Reverse-verified (2026-09-25, each reddening only this test; the read-only
  // test above stays green under both):
  //   - grantScope's empty-request default → `this.grantableScopes.join(" ")`
  //     → "vault.read vault.write" granted (both cases)
  //   - `params.get("scope") ?? ""` → `?? "vault.read vault.write"` (only an
  //     ABSENT parameter now gets write) → the omitted case is granted write
  it("defaults an omitted scope to read even when the server allows writes (INV-7 item 5)", () => {
    const provider = new OAuthProvider({ ...config, allowWrite: true });
    const clientId = JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body).client_id;
    expect(exchange(provider, clientId, null).scope).toBe("vault.read");
    expect(exchange(provider, clientId, "").scope).toBe("vault.read");
    // Control: the same server does grant write when it is asked for.
    expect(exchange(provider, clientId, "vault.read vault.write").scope).toBe("vault.read vault.write");
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

  // The test above overshoots each cap (6 URIs, ~3000 characters, 300
  // characters), so a cap loosened by a little still refuses its input. These
  // sit exactly on and one past each limit.
  //
  // Reverse-verified (2026-09-25, each reddening only this test):
  //   - MAX_REDIRECT_URI_LENGTH 2048 → 2049 → a 2049-character URI registers
  //   - MAX_CLIENT_NAME_LENGTH 256 → 257 → a 257-character name registers
  // (MAX_REDIRECT_URIS 5 → 6 is already caught by the test above.)
  it("caps dynamic client registration inputs exactly at their limits (INV-7 item 6)", () => {
    const provider = new OAuthProvider(config);
    const uriOfLength = (n: number) => "https://x/" + "a".repeat(n - "https://x/".length);
    expect(provider.register({ redirect_uris: Array(5).fill("https://x/cb") }).status).toBe(201);
    expect(provider.register({ redirect_uris: [uriOfLength(2048)] }).status).toBe(201);
    expect(provider.register({ redirect_uris: [uriOfLength(2049)] }).status).toBe(400);
    expect(provider.register({ redirect_uris: ["https://x/cb"], client_name: "n".repeat(256) }).status).toBe(201);
    expect(provider.register({ redirect_uris: ["https://x/cb"], client_name: "n".repeat(257) }).status).toBe(400);
  });

  // Reverse-verified (2026-09-25): the first three asserts were already pinned;
  // the rest were not, and each of these reddens only this test —
  //   - `default-src 'none'` → `default-src *`
  //   - `; base-uri 'none'` removed
  //   - the page's `cache-control: no-store` removed
  //   - the token response's `cache-control` / `pragma` removed
  it("sets clickjacking/leakage headers on the consent page", () => {
    const { provider, clientId } = setup();
    const { verifier, challenge } = pkcePair();
    const res = provider.authorizeGet(authorizeParams(clientId, challenge));
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    const csp = res.headers["content-security-policy"] as string;
    expect(csp.startsWith("default-src 'none';")).toBe(true);
    expect(csp).toContain("base-uri 'none'");
    // The login form carries the authorize parameters; a cached copy must not
    // be replayable from history.
    expect(res.headers["cache-control"]).toBe("no-store");

    // The token response carries bearer credentials (RFC 6749 §5.1).
    const form = authorizeParams(clientId, challenge);
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
    expect(token.status).toBe(200);
    expect(token.headers["cache-control"]).toBe("no-store");
    expect(token.headers.pragma).toBe("no-cache");
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

  it("names the destination the success redirect actually uses", () => {
    // The consent page has to let the operator see where approving sends the
    // code. That statement is only worth anything if it names the same origin
    // the 302 goes to, so assert the page against the real redirect rather than
    // against the registered string.
    const { provider, clientId } = setup();
    const { challenge } = pkcePair();
    const page = provider.authorizeGet(authorizeParams(clientId, challenge)).body;
    const form = authorizeParams(clientId, challenge);
    form.set("password", "hunter2");
    const redirect = provider.authorizePost(form);
    expect(redirect.status).toBe(302);
    const actualOrigin = new URL(redirect.headers.location).origin;
    expect(actualOrigin).toBe("https://chatgpt.com");
    // Assert the rendered statement, not just the origin appearing somewhere in
    // the markup: the form already carries redirect_uri in a hidden input, so a
    // bare substring check passes even when the page shows the operator nothing.
    expect(page).toContain(`<strong>${actualOrigin}</strong>`);
  });

  it("marks the client name as unverified and escapes it", () => {
    // client_name is whatever the client sent to /register, so the page must not
    // present it as an identity — and must not let it inject markup into the
    // page that carries the destination.
    const provider = new OAuthProvider(config);
    const reg = provider.register({
      redirect_uris: ["https://chatgpt.com/cb"],
      client_name: '<img src=x onerror=alert(1)>"Claude.ai"'
    });
    const clientId = JSON.parse(reg.body).client_id as string;
    const { challenge } = pkcePair();
    const page = provider.authorizeGet(authorizeParams(clientId, challenge)).body;
    expect(page).toContain("not verified");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;Claude.ai&quot;");
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
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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
    const grantedLocation = new URL(authRes.headers.get("location")!);
    expect(grantedLocation.searchParams.get("iss")).toBe(issuer);
    const code = grantedLocation.searchParams.get("code")!;
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
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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

  it("bounds the refresh-rotation rate at /token, and says so with a 429", async () => {
    // Replay detection reads the family's root refresh record out of a capped,
    // insertion-ordered map. A rotation nets one entry, so an unthrottled caller
    // can mint until `enforceCap` evicts that root, and the victim's replay —
    // the thing that revokes a stolen family — returns `invalid_grant` instead.
    // The eviction is only useful inside ROTATION_GRACE_MS, so the endpoint has
    // to bound the *rate*. `/token` was the one OAuth route with no limiter.
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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

    // Real rotations, because only a successful one grows the map this bounds.
    const { clientId, refreshToken } = await oauthObtainRefresh(issuer);
    let current = refreshToken;
    let rotations = 0;
    let limited: Response | undefined;
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current,
          client_id: clientId
        }).toString()
      });
      if (res.status === 429) {
        limited = res;
        break;
      }
      const body = (await res.json()) as { refresh_token: string };
      current = body.refresh_token;
      rotations += 1;
    }

    // The gate fires...
    expect(limited).toBeDefined();
    // ...and not before the endpoint has served the traffic a single user
    // actually produces. Without this half a limit of 1 would satisfy the line
    // above while breaking every legitimate refresh.
    expect(rotations).toBeGreaterThanOrEqual(30);

    // The rejection is the documented shape, not an incidental error page: a
    // client that cannot read `Retry-After` cannot back off correctly.
    expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited!.json()).toEqual({ error: "rate_limited" });
  });

  it("still revokes the stolen family when the rotation quota is exhausted (F1)", async () => {
    // The gate at `/token` answers 429 BEFORE `oauth.token(form)` runs, and
    // `rotateRefreshToken` — with it `replayAgainstTombstone` and
    // `revokeFamilyAbove` — is reachable ONLY through that call. So an
    // interceptor holding a captured chain can rotate it until the shared
    // bucket is full (behind a tunnel every caller shares one key), and the
    // victim's replay — the sole trigger for revocation — never reaches the
    // store at all. The window then closes, the tombstone expires, and the
    // stolen family is never revoked: the mitigation becomes unreachable
    // exactly when it is needed.
    //
    // Asserted on the interceptor's live access token rather than on the
    // replay's return value. Over quota the reply MUST stay a 429, so "the
    // replay succeeded" would pin the wrong thing — the same reason #170 states
    // its main assertion on the held pair.
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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

    const rotate = (refreshToken: string, clientId: string) =>
      fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId
        }).toString()
      });
    // Whether a pair is still live, read through the resource it is bound to.
    // 200 = the access token still authenticates; 401 = its family was revoked.
    const mcpStatus = async (accessToken: string): Promise<number> =>
      (
        await fetch(`${issuer}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${accessToken}`
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        })
      ).status;

    const { clientId, refreshToken: root } = await oauthObtainRefresh(issuer);

    // The victim rotates once and loses the response. This pair is what the
    // interceptor captured.
    const lost = (await (await rotate(root, clientId)).json()) as {
      refresh_token: string;
      access_token: string;
    };

    // The interceptor rotates the captured chain until the shared bucket is
    // full. Only a 200 is charged, so these are exactly the successful
    // rotations the quota was sized for — the attacker spends it with valid
    // traffic, which is why no input filter can tell this apart.
    let current = lost.refresh_token;
    let held = lost.access_token;
    let limited = false;
    for (let i = 0; i < 60; i++) {
      const res = await rotate(current, clientId);
      if (res.status === 429) {
        limited = true;
        break;
      }
      const body = (await res.json()) as { refresh_token: string; access_token: string };
      current = body.refresh_token;
      held = body.access_token;
    }

    // Positive controls for the setup, so the assertion at the end cannot pass
    // for the wrong reason: the bucket really is exhausted, and the pair the
    // revocation has to kill really is alive at this moment.
    expect(limited).toBe(true);
    expect(await mcpStatus(held)).toBe(200);

    // The victim retries with the root it still holds — the presentation that
    // must revoke everything minted above it.
    const replay = await rotate(root, clientId);

    // What the caller sees is unchanged. The gate still refuses, in the
    // documented shape, and still mints nothing.
    expect(replay.status).toBe(429);
    expect(Number(replay.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await replay.json()).toEqual({ error: "rate_limited" });

    // ...and the store observed the presentation anyway, so the stolen family
    // is dead. This is the assertion the finding is about.
    expect(await mcpStatus(held)).toBe(401);
  });

  it("does not let unauthenticated junk at /token spend the budget a real grant needs", async () => {
    // The bound has to sit where only a successful rotation pays for it. Behind
    // a tunnel every caller shares one bucket, so a gate placed in FRONT of grant
    // validation lets a stranger who holds no token at all spend the whole quota
    // on rejected requests — and the lockout then covers the authorization-code
    // exchange too, so reauthorization cannot recover from it. The assertion is
    // deliberately negative: it is about what the junk must NOT have consumed.
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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

    // Far past the quota, from a caller holding nothing.
    for (let i = 0; i < 200; i++) {
      const junk = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: `junk-${i}`,
          client_id: "junk-client"
        }).toString()
      });
      expect(junk.status).not.toBe(429);
    }

    // A real authorization-code exchange still completes: recovery is available.
    const real = await oauthObtainRefresh(issuer);
    expect(real.refreshToken).toBeTruthy();

    // ...and so does a real rotation.
    const rotated = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: real.refreshToken,
        client_id: real.clientId
      }).toString()
    });
    expect(rotated.status).toBe(200);
  });

  it("raises the rotation quota when a short access-token TTL makes refreshes legitimate", async () => {
    // `MCP_OAUTH_ACCESS_TTL` is configurable, and a client honouring a short
    // `expires_in` refreshes exactly as often as it is told to. A flat quota
    // would answer 429 to that client's *valid* traffic, so the quota is derived
    // from the TTL. The guard survives the derivation: even here the ceiling is
    // far below the ~1999 rotations the eviction needs.
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: [],
      oauth: {
        issuer,
        loginPassword: "hunter2",
        accessTokenTtlSec: 1,
        refreshTokenTtlSec: 86_400,
        codeTtlSec: 60,
        allowWrite: false
      }
    };
    server = await startHttpServer(store, config);

    const { clientId, refreshToken } = await oauthObtainRefresh(issuer);
    let current = refreshToken;
    let rotations = 0;
    for (let i = 0; i < 45; i++) {
      const res = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current,
          client_id: clientId
        }).toString()
      });
      if (res.status === 429) {
        break;
      }
      current = ((await res.json()) as { refresh_token: string }).refresh_token;
      rotations += 1;
    }
    // A one-second TTL means 60 refreshes a minute is honest traffic for a single
    // client; the flat 30 this replaces would have cut it off half way through.
    expect(rotations).toBeGreaterThan(30);
  });

  it("gives /token its own bucket, so refreshes do not consume the /register budget", async () => {
    // The three OAuth routes carry different limits on different windows. One
    // shared bucket would let ordinary refresh traffic lock a user out of
    // registration (and vice versa), so the separation is part of the contract.
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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

    // Spend the whole /token budget with the only thing that charges it: real
    // rotations.
    const { clientId, refreshToken } = await oauthObtainRefresh(issuer);
    let current = refreshToken;
    for (let i = 0; i < 45; i++) {
      const res = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current,
          client_id: clientId
        }).toString()
      });
      if (res.status === 429) {
        break;
      }
      current = ((await res.json()) as { refresh_token: string }).refresh_token;
    }

    // /register still answers on its own budget.
    const reg = await fetch(`${issuer}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/cb"] })
    });
    expect(reg.status).not.toBe(429);
  });

  it("gates write tools by token scope on an allowWrite server", async () => {
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: true,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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
    expect(readTools).not.toContain("plan_document_create");

    // ...but a vault.write-scoped token does.
    const writeTools = await listToolNamesOverHttp(issuer, await oauthObtainToken(issuer, "vault.read vault.write"));
    expect(writeTools).toContain("plan_document_create");
  });

  it("states the scope the consent page is about to grant", () => {
    // Withheld until 2b on purpose: while `vault.read` was unenforced, a scope
    // line would have described a restriction the server did not apply. It is
    // true now, so it is shown — and it shows the GRANT (requested ∩ grantable),
    // not the request, because the grant is what the token carries.
    const readOnly = new OAuthProvider({
      issuer: "https://vault.example",
      loginPassword: "hunter2",
      accessTokenTtlSec: 3600,
      refreshTokenTtlSec: 86_400,
      codeTtlSec: 60,
      allowWrite: false
    });
    const reg = JSON.parse(readOnly.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body);
    const page = (scope: string) =>
      readOnly.authorizeGet(
        new URLSearchParams({
          response_type: "code",
          client_id: reg.client_id,
          redirect_uri: "https://chatgpt.com/cb",
          code_challenge: computeS256Challenge(crypto.randomBytes(32).toString("base64url")),
          code_challenge_method: "S256",
          state: "s",
          scope
        })
      ).body;

    expect(page("vault.read")).toContain("<strong>vault.read</strong>");
    expect(page("vault.read")).toContain("read only");

    // A write request against a read-only server grants nothing. The page says
    // so rather than implying the request will be honoured — such a token is
    // refused at /mcp with insufficient_scope, so approving it accomplishes
    // nothing and the operator should know that before typing the password.
    expect(page("vault.write")).toContain("no scope this server can grant");
    expect(page("vault.write")).not.toContain("<strong>vault.write</strong>");
  });

  it("issues exactly the scope the consent page displayed", () => {
    // The displayed grant is `grantScope(params.scope)` computed in the GET
    // handler; the code carries `grantScope(check.params.scope)` computed in the
    // POST handler. Two independent evaluations that agree only because the
    // value round-trips through a hidden field — which is the shape #86
    // deliberately removed for the redirect destination, so that the sentence
    // and the navigation were one fact rather than two kept in step by hand.
    //
    // The tests around this one pin each side separately: what the page renders,
    // and what `grantScope` returns at issuance. Neither compares them. So a
    // change that keeps both individually defensible while making them disagree
    // — the display path normalising, deduping or reordering, say — passes
    // everything else and is caught only here.
    const provider = new OAuthProvider({
      issuer: "https://vault.example",
      loginPassword: "hunter2",
      accessTokenTtlSec: 3600,
      refreshTokenTtlSec: 86_400,
      codeTtlSec: 60,
      allowWrite: false
    });
    const clientId = JSON.parse(provider.register({ redirect_uris: ["https://chatgpt.com/cb"] }).body)
      .client_id as string;
    const verifier = crypto.randomBytes(32).toString("base64url");

    // Asks for more than this server will grant, so a page that showed the
    // REQUEST rather than the GRANT would diverge here rather than agree by
    // accident.
    const form = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://chatgpt.com/cb",
      code_challenge: computeS256Challenge(verifier),
      code_challenge_method: "S256",
      state: "s",
      scope: "vault.read vault.write"
    });

    const displayed = /This grants: <strong>([^<]*)<\/strong>/.exec(provider.authorizeGet(form).body)?.[1];
    expect(displayed).toBe("vault.read");

    form.set("password", "hunter2");
    const code = new URL(provider.authorizePost(form).headers.location).searchParams.get("code")!;
    const issued = JSON.parse(
      provider.token(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: "https://chatgpt.com/cb",
          code_verifier: verifier
        })
      ).body
    ).scope as string;

    expect(issued).toBe(displayed);
  });

  it("re-resolves the tool surface from the token presented on EACH request", async () => {
    // The 2b property, stated as the hole it closes. With sessions, the surface
    // was decided once at `initialize` and every later request was routed by
    // `mcp-session-id` ALONE — the presenting principal was never re-checked, so
    // a connection opened with a write-scoped token kept the write surface for
    // its lifetime no matter what token later requests carried. With no session
    // there is nothing to route by and nothing to remember: the surface is
    // rebuilt per request from the token on that request.
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: true,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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

    const writeToken = await oauthObtainToken(issuer, "vault.read vault.write");
    const readToken = await oauthObtainToken(issuer, "vault.read");

    // One client, one connection. The token it presents is swapped underneath it
    // after the handshake, which is exactly what a session would have masked.
    let presented = writeToken;
    const transport = new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
      requestInit: { headers: { connection: "close" } },
      fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${presented}`);
        return fetch(input, { ...init, headers });
      }
    });
    const client = new Client({ name: "swap-test", version: "0.0.0" });
    await client.connect(transport);

    expect((await client.listTools()).tools.map((t) => t.name)).toContain("plan_document_create");

    presented = readToken;
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("plan_document_create");

    // ...and back, so the result tracks the token rather than being latched by
    // the first downgrade.
    presented = writeToken;
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("plan_document_create");

    await client.close();
  });

  it("refuses a token carrying no vault.read with 403 insufficient_scope", async () => {
    // The read half of INV-7 item 5, previously missing: `{scopes: []}` is
    // non-null, so an empty grant authenticated and then read the whole vault
    // because the read tools were registered unconditionally. A client asking
    // only for `vault.write` while writes are OFF is how an empty grant actually
    // arises — `grantScope` returns the intersection, and refuses to substitute
    // read for a scope that was never requested.
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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

    const emptyScope = await oauthObtainToken(issuer, "vault.write");
    const res = await fetch(`${issuer}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${emptyScope}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });

    // Refused, not served an empty tool list: an empty 200 is indistinguishable
    // from an empty vault, and the RFC 6750 challenge is what tells a client to
    // re-authorize for the scope it is missing.
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope", scope: "vault.read" });
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="vault.read"');

    // A read-scoped token against the SAME endpoint is served, so the 403 is the
    // scope gate and not the endpoint being broken.
    expect(await listToolNamesOverHttp(issuer, await oauthObtainToken(issuer, "vault.read"))).toContain("search");
  });

  // Every token a single server can mint is bound to that server's own
  // resource, so within one process the audience compare at /mcp never sees a
  // mismatch. A mismatch arrives across a restart: the state file keeps tokens
  // issued under the old issuer (a tunnel URL that changed, say), and a server
  // that loads them must not accept them for its new resource. The same file is
  // first loaded under the SAME issuer, where the token is served — so the 401
  // afterwards is the audience check, not a token that failed to persist.
  //
  // Reverse-verified (2026-09-25): `record && record.resource ===
  // oauth.canonicalResource` → `record` reddens only this test (the moved
  // server serves the old token); every other test in this file and in
  // httpServer.test.ts stays green under it.
  it("refuses a persisted token whose audience is a different issuer (INV-7 item 5)", async () => {
    const store = await makeStore();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-audience-"));
    const stateFile = path.join(stateDir, "oauth-state.json");
    const start = async (issuer: string) => {
      const port = await freePort();
      const config: HttpConfig = {
        host: "127.0.0.1",
        port,
        authToken: "static-bearer-unused-here",
        authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
        allowWrite: false,
        allowSkillWrite: false,
        allowAuditWrite: false,
        allowLegacyCreateDocument: false,
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        allowedOrigins: [],
        oauth: {
          issuer: issuer || `http://127.0.0.1:${port}`,
          loginPassword: "hunter2",
          accessTokenTtlSec: 3600,
          refreshTokenTtlSec: 86_400,
          codeTtlSec: 60,
          allowWrite: false,
          stateFile
        }
      };
      server = await startHttpServer(store, config);
      return { base: `http://127.0.0.1:${port}`, issuer: config.oauth!.issuer };
    };
    const stop = async () => {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    };

    const first = await start("");
    const token = await oauthObtainToken(first.base, "vault.read");
    await stop();

    // Control: same issuer, reloaded from the file — served.
    const same = await start(first.issuer);
    expect(await listToolNamesOverHttp(same.base, token)).toContain("search");
    await stop();

    const moved = await start("https://moved.example");
    const res = await fetch(`${moved.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain("resource_metadata=");
  });

  it("gates write tools by token scope on the 2026-07-28 era too (no session to bind to)", async () => {
    // The legacy era binds the resolved surface to the session. The modern era
    // has no sessions, so the same guarantee has to hold per request — two
    // differently-scoped tokens against ONE endpoint, back to back, must see
    // two different tool sets. (ROADMAP 2a; 2b generalizes this to both eras.)
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: true,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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

    const readTools = await listToolNamesOverModernHttp(issuer, await oauthObtainToken(issuer, "vault.read"));
    expect(readTools).toContain("search");
    expect(readTools).not.toContain("plan_document_create");

    const writeTools = await listToolNamesOverModernHttp(
      issuer,
      await oauthObtainToken(issuer, "vault.read vault.write")
    );
    expect(writeTools).toContain("plan_document_create");

    // ...and the read-scoped token still sees no write tools afterwards, so the
    // surface follows the presented token rather than the first one seen.
    const readAgain = await listToolNamesOverModernHttp(issuer, await oauthObtainToken(issuer, "vault.read"));
    expect(readAgain).not.toContain("plan_document_create");
  });

  it("gates Skill writes separately from general document writes", async () => {
    const store = await makeStore();
    const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-skill-vault-"));
    const skillPatchState = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-skill-patches-"));
    await fs.mkdir(path.join(skillRoot, "skills"));
    const skillStore = new SkillStore({
      knowledgeRoot: skillRoot,
      skillsSubdir: "skills",
      patchStateDir: skillPatchState
    });
    await skillStore.init();

    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: true,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
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
    server = await startHttpServer(store, config, skillStore);

    const readTools = await listToolNamesOverHttp(issuer, await oauthObtainToken(issuer, "vault.read"));
    expect(readTools).not.toContain("plan_skill_create");

    const writeTools = await listToolNamesOverHttp(issuer, await oauthObtainToken(issuer, "vault.read vault.write"));
    expect(writeTools).toContain("plan_skill_create");
    expect(writeTools).toContain("apply_planned_skill_create");
    expect(writeTools).not.toContain("plan_document_create");
  });

  it("keeps OAuth sessions across a server restart when a state file is configured", async () => {
    const store = await makeStore();
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-restart-"));
    const config: HttpConfig = {
      host: "127.0.0.1",
      port,
      authToken: "static-bearer-unused-here",
      authTokenScopes: [SCOPE_READ, SCOPE_WRITE],
      allowWrite: false,
      allowSkillWrite: false,
      allowAuditWrite: false,
      allowLegacyCreateDocument: false,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: [],
      oauth: {
        issuer,
        loginPassword: "hunter2",
        accessTokenTtlSec: 3600,
        refreshTokenTtlSec: 86_400,
        codeTtlSec: 60,
        allowWrite: false,
        stateFile: path.join(stateDir, "oauth-state.json")
      }
    };
    server = await startHttpServer(store, config);
    const accessToken = await oauthObtainToken(issuer, "vault.read");
    expect(await listToolNamesOverHttp(issuer, accessToken)).toContain("search");

    // "Restart": stop the server and start a fresh one on the same state file.
    // Destroying the sockets rather than letting them idle out makes the
    // teardown deterministic, and it keeps this test honest: if the no-pooling
    // header above is ever dropped, the reused connection is provably dead and
    // this fails on every run instead of flaking occasionally on CI.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = await startHttpServer(store, config);

    // The pre-restart access token still authenticates — no re-authorize needed.
    expect(await listToolNamesOverHttp(issuer, accessToken)).toContain("search");
  });
});
