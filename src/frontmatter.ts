import matter from "gray-matter";
import type { DocumentMetadata } from "./types.js";

// Keys a client may patch on an existing document via plan_document_update.
// `id` (document identity) and `updated_at` (server-stamped) are intentionally
// excluded. Any other key is rejected to block frontmatter/YAML field injection
// from an untrusted MCP client (Reusable Security Baseline: frontmatter allowlist).
export const PATCHABLE_FRONTMATTER_KEYS = ["client", "project", "title", "tags", "source_refs"] as const;

const PATCHABLE_FRONTMATTER_KEY_SET = new Set<string>(PATCHABLE_FRONTMATTER_KEYS);

export function assertFrontmatterPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const validated: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE_FRONTMATTER_KEY_SET.has(key)) {
      throw new Error(
        `Frontmatter key not allowed in patch: ${key}. Allowed keys: ${PATCHABLE_FRONTMATTER_KEYS.join(", ")}.`
      );
    }

    validated[key] = validatePatchValue(key, value);
  }

  return validated;
}

function validatePatchValue(key: string, value: unknown): unknown {
  if (key === "client" || key === "project" || key === "title") {
    if (typeof value !== "string") {
      throw new Error(`Frontmatter key ${key} must be a string.`);
    }
    return value;
  }

  if (key === "tags" || key === "source_refs") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`Frontmatter key ${key} must be an array of strings.`);
    }
    return value;
  }

  throw new Error(`Unsupported frontmatter key: ${key}.`);
}

export function parseMarkdown(raw: string): { frontmatter: DocumentMetadata; body: string } {
  const parsed = matter(raw);
  return {
    frontmatter: normalizeMetadata(parsed.data as DocumentMetadata),
    body: parsed.content
  };
}

// Fault-tolerant wrapper used on the read path. A single vault document with
// malformed frontmatter — broken YAML/JSON, or raw control characters that leak
// in from a web clipping — makes gray-matter throw. Because the store parses
// every file when listing/searching, one such file would otherwise abort the
// whole operation (search / list / fetch / trace all fail). Instead we swallow
// the parse error, fall back to empty frontmatter over the raw body so the note
// stays searchable by body/path, and hand the error message back to the caller
// (which logs only the file path, never the content). Containment checks run
// before this and are unaffected.
export function parseMarkdownSafe(raw: string): {
  frontmatter: DocumentMetadata;
  body: string;
  parseError?: string;
} {
  try {
    return parseMarkdown(raw);
  } catch (error) {
    return {
      frontmatter: normalizeMetadata({} as DocumentMetadata),
      body: raw,
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

export function serializeMarkdown(frontmatter: DocumentMetadata, body: string): string {
  return matter.stringify(body.trimEnd() + "\n", normalizeMetadata(frontmatter));
}

export function normalizeMetadata(input: DocumentMetadata): DocumentMetadata {
  const metadata: DocumentMetadata = { ...input };

  // YAML auto-types unquoted scalars: `tags: [2024]` yields numbers, `client:
  // 2024` a number, `enabled: true` a boolean. Such frontmatter parses fine (so
  // parseMarkdownSafe never sees an error), but the read path then does string
  // work on these fields — `tag.toLowerCase()` in search, `client.localeCompare()`
  // in list_projects — which throws on a non-string and aborts search /
  // list_projects for the ENTIRE vault, not just the one bad note. Coerce the
  // fields we treat as strings here, at the single read-path chokepoint. This
  // normalizes already-parsed vault data only; the write-time field allowlist
  // (assertFrontmatterPatch) is untouched, so INV-2 is unaffected.
  metadata.tags = toStringArray(metadata.tags);
  metadata.source_refs = toStringArray(metadata.source_refs);
  const client = toOptionalString(metadata.client);
  const project = toOptionalString(metadata.project);
  if (client === undefined) delete metadata.client;
  else metadata.client = client;
  if (project === undefined) delete metadata.project;
  else metadata.project = project;

  return metadata;
}

/** Coerce a frontmatter value into a `string[]`, stringifying non-string elements. */
function toStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item != null).map((item) => (typeof item === "string" ? item : String(item)));
}

/** Coerce a present-but-non-string scalar to a string; leave absent values absent. */
function toOptionalString(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : String(value);
}

export function titleFromMarkdown(relativePath: string, frontmatter: DocumentMetadata, body: string): string {
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }

  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return heading;
  }

  return relativePath.replace(/\.md$/i, "").split("/").pop() || relativePath;
}
