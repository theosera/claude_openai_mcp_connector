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
  const match = /^Bearer[ \t]+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    return null;
  }
  const token = match[1].trim();
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
