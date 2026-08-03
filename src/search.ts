import type { MarkdownDocument, SearchFilters, SearchResponse, SearchResult } from "./types.js";
import { normalizeForMatch, normalizeWithMap, toSourceIndex } from "./searchText.js";

export type { SearchFilters } from "./types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SNIPPET_LENGTH = 220;
const SNIPPET_LEAD = 80;

export function searchDocuments(documents: MarkdownDocument[], filters: SearchFilters): SearchResponse {
  const queryTerms = tokenize(filters.query);
  const tagFilters = (filters.tags ?? []).map((tag) => tag.toLowerCase());
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(filters.offset ?? 0, 0);

  const ranked = documents
    .filter((document) => {
      if (filters.client && document.frontmatter.client !== filters.client) {
        return false;
      }
      if (filters.project && document.frontmatter.project !== filters.project) {
        return false;
      }
      const documentTags = (document.frontmatter.tags ?? []).map((tag) => tag.toLowerCase());
      return tagFilters.every((tag) => documentTags.includes(tag));
    })
    .map((document) => ({ document, score: scoreDocument(document, queryTerms) }))
    .filter((scored) => (queryTerms.length === 0 ? true : scored.score > 0))
    .sort((a, b) => b.score - a.score || a.document.relativePath.localeCompare(b.document.relativePath));

  // Snippets are built only for the page that is actually returned: folding a
  // megabyte-scale body and mapping its offsets is far too expensive to do for
  // every document that merely matched.
  const results = ranked
    .slice(offset, offset + limit)
    .map((scored) => toSearchResult(scored.document, scored.score, queryTerms));

  return { results, total_count: ranked.length, offset, limit };
}

function scoreDocument(document: MarkdownDocument, queryTerms: string[]): number {
  const title = normalizeForMatch(document.title);
  const path = normalizeForMatch(document.relativePath);
  const body = normalizeForMatch(document.body);
  const tags = (document.frontmatter.tags ?? []).map((tag) => normalizeForMatch(tag));
  let score = 0;

  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += 10;
    }
    if (path.includes(term)) {
      score += 4;
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 5;
    }
    const bodyMatches = countOccurrences(body, term);
    score += Math.min(bodyMatches, 8);
  }

  return score;
}

function toSearchResult(document: MarkdownDocument, score: number, queryTerms: string[]): SearchResult {
  const updatedAt = typeof document.frontmatter.updated_at === "string" ? document.frontmatter.updated_at : undefined;

  return {
    id: document.id,
    path: document.relativePath,
    title: document.title,
    client: document.frontmatter.client,
    project: document.frontmatter.project,
    tags: document.frontmatter.tags ?? [],
    snippet: makeSnippet(document.body, queryTerms),
    score,
    ...(document.root ? { root: document.root } : {}),
    modified_at: document.stats.modifiedAt,
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    size_bytes: document.stats.sizeBytes
  };
}

function tokenize(query: string): string[] {
  return normalizeForMatch(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  let index = value.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function makeSnippet(body: string, terms: string[]): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  // Match on the folded text, then slice from `compact` so the snippet is the
  // author's own characters — never the normalization's output.
  const normalized = normalizeWithMap(compact);
  const firstHit =
    terms
      .map((term) => normalized.text.indexOf(term))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? -1;
  const anchor = firstHit >= 0 ? toSourceIndex(normalized, firstHit, compact.length) : 0;

  const start = Math.max(anchor - SNIPPET_LEAD, 0);
  const end = Math.min(start + SNIPPET_LENGTH, compact.length);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}
