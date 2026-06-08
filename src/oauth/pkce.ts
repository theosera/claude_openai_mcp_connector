import crypto from "node:crypto";

// PKCE (RFC 7636) — S256 only. The MCP authorization spec requires PKCE, and we
// deliberately reject the `plain` method: a public client (ChatGPT / Claude.ai)
// must prove possession of the verifier via SHA-256 so an intercepted auth code
// is useless without it.

const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/; // RFC 7636 unreserved set

/** base64url(SHA-256(verifier)) — the expected `code_challenge` for S256. */
export function computeS256Challenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Verify a PKCE code_verifier against the stored S256 code_challenge.
 * Constant-time; fails closed on any malformed/empty/oversized input.
 */
export function verifyPkceS256(verifier: string | undefined | null, challenge: string | undefined | null): boolean {
  if (!verifier || !challenge) {
    return false;
  }
  if (verifier.length < MIN_VERIFIER_LENGTH || verifier.length > MAX_VERIFIER_LENGTH) {
    return false;
  }
  if (!VERIFIER_PATTERN.test(verifier)) {
    return false;
  }
  const computed = Buffer.from(computeS256Challenge(verifier));
  const expected = Buffer.from(challenge);
  if (computed.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(computed, expected);
}
