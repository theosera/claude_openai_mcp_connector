import type { KnowledgeStore } from "./knowledgeStore.js";

// ChatGPT's MCP "connector" contract expects two specifically named tools with
// fixed output shapes:
//   search(query)  -> { results: [{ id, title, url }] }
//   fetch(id)      -> { id, title, text, url, metadata }
// These are thin, READ-ONLY adapters over the existing search_documents /
// fetch_document store methods. They never write. `url` is a stable, synthetic
// reference (the vault is private and local — there is no public URL), derived
// from a configurable base so citations stay stable without leaking real paths.

const DEFAULT_URL_BASE = "vault://";

/**
 * Build a stable, non-dereferenceable reference for a vault document. ChatGPT
 * uses this only as a citation handle; it is round-tripped back into `fetch`.
 */
export function documentUrl(relativePath: string, baseUrl?: string): string {
  const base = baseUrl ?? DEFAULT_URL_BASE;
  const encoded = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const separator = base.endsWith("/") ? "" : "/";
  return `${base}${separator}${encoded}`;
}

export interface ChatgptSearchResult {
  results: Array<{ id: string; title: string; url: string }>;
}

export interface ChatgptFetchResult {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, string>;
}

export async function chatgptSearch(
  store: KnowledgeStore,
  query: string,
  options: { limit?: number; baseUrl?: string } = {}
): Promise<ChatgptSearchResult> {
  const hits = await store.search({ query, limit: options.limit });
  return {
    results: hits.map((hit) => ({
      id: hit.id,
      title: hit.title,
      url: documentUrl(hit.path, options.baseUrl)
    }))
  };
}

export async function chatgptFetch(
  store: KnowledgeStore,
  id: string,
  options: { baseUrl?: string } = {}
): Promise<ChatgptFetchResult> {
  const document = await store.fetch(id);
  // metadata values must be strings per the ChatGPT contract; coerce safely.
  const metadata: Record<string, string> = {
    relativePath: document.relativePath,
    modifiedAt: document.stats.modifiedAt
  };
  if (document.frontmatter.client) metadata.client = String(document.frontmatter.client);
  if (document.frontmatter.project) metadata.project = String(document.frontmatter.project);
  if (document.frontmatter.tags?.length) metadata.tags = document.frontmatter.tags.join(", ");

  return {
    id: document.id,
    title: document.title,
    text: document.body,
    url: documentUrl(document.relativePath, options.baseUrl),
    metadata
  };
}
