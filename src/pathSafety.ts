import fs from "node:fs/promises";
import path from "node:path";

// Defense-in-depth caps for client-supplied vault-relative paths. A path is
// only ever a short vault-relative reference or a document id — never a blob —
// so cap the length to shrink the attack surface (Reusable Security Baseline:
// path-traversal defense / length cap).
const MAX_RELATIVE_PATH_LENGTH = 500;

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export async function resolveExistingRoot(root: string): Promise<string> {
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`KNOWLEDGE_ROOT is not a directory: ${root}`);
  }
  return fs.realpath(root);
}

export function assertRelativePath(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Path must be a string.");
  }

  const cleaned = value.trim();
  if (!cleaned) {
    throw new Error("Path is required.");
  }
  if (cleaned.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new Error("Path is too long.");
  }
  if (hasControlCharacter(cleaned)) {
    throw new Error("Path contains control characters.");
  }

  // Validate the raw form *and* a leniently percent-decoded form. A downstream
  // layer that URL-decodes (`%2e%2e` -> `..`, `%2f` -> `/`) must not be able to
  // turn an "inside" path into an escape. We decode *leniently* (decode valid
  // %XX, leave malformed escapes such as `%ZZ` literal) so an encoded traversal
  // that also carries a malformed escape can't dodge the check by making a
  // strict decoder throw. We only ever *operate* on the raw NFC path; the
  // decoded form is validated but never used for filesystem operations. NFC
  // normalization stops a decomposed (NFD, e.g. macOS HFS+) `..` from dodging it.
  for (const candidate of [cleaned, lenientPercentDecode(cleaned)]) {
    assertNoEscape(candidate.normalize("NFC"));
  }

  return path.normalize(cleaned.normalize("NFC"));
}

export async function resolveInsideRoot(rootRealPath: string, relativePath: string): Promise<string> {
  const safeRelative = assertRelativePath(relativePath);
  const candidate = path.resolve(rootRealPath, safeRelative);
  const candidateDir = path.dirname(candidate);
  const realDir = await fs.realpath(candidateDir);
  const relativeFromRoot = path.relative(rootRealPath, realDir);

  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    throw new Error("Path escapes the knowledge root.");
  }

  return path.join(realDir, path.basename(candidate));
}

export function relativeToRoot(rootRealPath: string, absolutePath: string): string {
  const relative = path.relative(rootRealPath, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the knowledge root.");
  }
  // Return the identifier in NFC so it round-trips with lookups. This value
  // becomes a document's relativePath/id, but it derives from fs.realpath, which
  // on macOS reports filenames decomposed (NFD). assertRelativePath normalizes
  // client-supplied paths/ids to NFC, so an un-normalized NFD identifier would
  // never === the NFC lookup key and fetch()/trace would report "not found" for
  // any non-ASCII (e.g. Japanese) filename. Containment was already verified on
  // the raw realpath above; NFC only canonicalizes the returned string. Actual
  // file I/O uses realPath, never this value, so reads are unaffected.
  return toPosixPath(relative).normalize("NFC");
}

// Reject NUL + C0/C1 control characters (code point <= 0x1f, or 0x7f). NUL can
// truncate a path in some syscalls; control characters never belong in a
// vault-relative path. Implemented with charCodeAt to avoid embedding raw
// control bytes in source.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function assertNoEscape(candidate: string): void {
  // `~` is a home-directory reference if any layer expands it — reject up front.
  if (candidate.startsWith("~")) {
    throw new Error("Home-relative paths are not accepted. Use a vault-relative path or document id.");
  }
  if (path.isAbsolute(candidate)) {
    throw new Error("Absolute paths are not accepted. Use a vault-relative path or document id.");
  }
  const normalized = path.normalize(candidate);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Path escapes the knowledge root.");
  }
}

// Lenient percent-decode used only for traversal validation: decode every valid
// %XX escape and leave malformed ones (e.g. `%ZZ`) as literal text — mirroring
// lenient decoders such as Node's querystring.unescape. Validating against this
// (rather than strict decodeURIComponent, which throws all-or-nothing on a
// single bad escape and would let an encoded traversal slip past) keeps the
// guard fail-closed for inputs like `%2e%2e%2fsecret%ZZ.md`.
function lenientPercentDecode(value: string): string {
  return value.replace(/%[0-9a-fA-F]{2}/g, (escape) => {
    try {
      return decodeURIComponent(escape);
    } catch {
      // e.g. a lone multibyte lead byte like `%E2` — leave it literal. It can
      // never form a `.`/`/`/`\` traversal token, so this is safe.
      return escape;
    }
  });
}
