import crypto from "node:crypto";

/**
 * Remote-transport authentication for the HTTP MCP endpoint.
 *
 * The vault is private; exposing it over HTTP without auth would defeat the
 * whole point of path containment. Every HTTP request must carry a valid
 * `Authorization: Bearer <token>` matching MCP_AUTH_TOKEN. Comparison is
 * constant-time to avoid leaking the token via timing. Auth fails CLOSED:
 * a missing/empty configured token means the server refuses to start (handled
 * in config), and a missing/wrong request token is rejected with 401.
 */

/** Extract the raw bearer token from an Authorization header value, or null. */
export function parseBearer(authHeader: string | undefined | null): string | null {
  if (!authHeader) {
    return null;
  }
  // Parsed by hand rather than a regex: a pattern like /^Bearer[ \t]+(.+)$/i has
  // overlapping quantifiers (`[ \t]+` and `.` both match tabs) and is a
  // polynomial-backtracking (ReDoS) risk on attacker-controlled header values.
  // This scan is strictly linear.
  const trimmed = authHeader.trim();
  const scheme = "bearer";
  if (trimmed.length <= scheme.length || trimmed.slice(0, scheme.length).toLowerCase() !== scheme) {
    return null;
  }
  let i = scheme.length;
  if (trimmed[i] !== " " && trimmed[i] !== "\t") {
    return null; // require at least one space/tab separator
  }
  while (i < trimmed.length && (trimmed[i] === " " || trimmed[i] === "\t")) {
    i += 1;
  }
  const token = trimmed.slice(i).trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time comparison of a provided token against the expected secret.
 * Returns false for any missing/empty input. Length differences are handled
 * without early-return by hashing both sides to a fixed width first, so the
 * comparison itself never short-circuits on length.
 */
export function isAuthorized(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }
  // Hash to fixed-length buffers so timingSafeEqual never throws on length
  // mismatch and the comparison cost is independent of the inputs.
  const providedDigest = crypto.createHash("sha256").update(provided).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

/** Convenience: authorize directly from an Authorization header value. */
export function isAuthorizedHeader(authHeader: string | undefined | null, expected: string): boolean {
  return isAuthorized(parseBearer(authHeader), expected);
}

// Fixed salt: we are not storing password hashes (the expected secret lives in
// memory from env), so the salt's job is only to bind the KDF — not to defend a
// hash-at-rest database. scrypt's purpose here is computational effort, which
// adds per-attempt cost to online guessing of the OAuth login password.
const LOGIN_PASSWORD_SALT = "mcp-oauth-login-v1";
const LOGIN_KEY_LEN = 32;

/**
 * Verify a human-entered OAuth login password against the configured secret
 * using a slow KDF (scrypt) + constant-time compare. Unlike a bearer token
 * (high entropy → a single SHA-256 for fixed-length timing-safe compare is
 * fine), a password is low-entropy and must be hashed with deliberate
 * computational effort to blunt brute force.
 */
export function verifyLoginPassword(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }
  const providedKey = crypto.scryptSync(provided, LOGIN_PASSWORD_SALT, LOGIN_KEY_LEN);
  const expectedKey = crypto.scryptSync(expected, LOGIN_PASSWORD_SALT, LOGIN_KEY_LEN);
  return crypto.timingSafeEqual(providedKey, expectedKey);
}
