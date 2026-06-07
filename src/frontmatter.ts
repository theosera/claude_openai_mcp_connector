import matter from "gray-matter";
import type { DocumentMetadata } from "./types.js";

// Keys a client may patch on an existing document via plan_document_update.
// `id` (document identity) and `updated_at` (server-stamped) are intentionally
// excluded. Any other key is rejected to block frontmatter/YAML field injection
// from an untrusted MCP client (Reusable Security Baseline: frontmatter allowlist).
export const PATCHABLE_FRONTMATTER_KEYS = ["client", "project", "title", "tags", "source_refs"] as const;

const PATCHABLE_FRONTMATTER_KEY_SET = new Set<string>(PATCHABLE_FRONTMATTER_KEYS);

export function assertFrontmatterPatch(patch: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE_FRONTMATTER_KEY_SET.has(key)) {
      throw new Error(
        `Frontmatter key not allowed in patch: ${key}. Allowed keys: ${PATCHABLE_FRONTMATTER_KEYS.join(", ")}.`
      );
    }
  }
  return patch;
}

export function parseMarkdown(raw: string): { frontmatter: DocumentMetadata; body: string } {
  const parsed = matter(raw);
  return {
    frontmatter: normalizeMetadata(parsed.data as DocumentMetadata),
    body: parsed.content
  };
}

export function serializeMarkdown(frontmatter: DocumentMetadata, body: string): string {
  return matter.stringify(body.trimEnd() + "\n", normalizeMetadata(frontmatter));
}

export function normalizeMetadata(input: DocumentMetadata): DocumentMetadata {
  const metadata: DocumentMetadata = { ...input };

  if (typeof metadata.tags === "string") {
    metadata.tags = [metadata.tags];
  }
  if (!Array.isArray(metadata.tags)) {
    metadata.tags = [];
  }

  if (typeof metadata.source_refs === "string") {
    metadata.source_refs = [metadata.source_refs];
  }
  if (!Array.isArray(metadata.source_refs)) {
    metadata.source_refs = [];
  }

  return metadata;
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
