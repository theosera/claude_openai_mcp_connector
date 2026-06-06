import type { MarkdownDocument, SearchResult } from "./types.js";

export interface SearchFilters {
  query: string;
  client?: string;
  project?: string;
  tags?: string[];
  limit?: number;
}

export function searchDocuments(documents: MarkdownDocument[], filters: SearchFilters): SearchResult[] {
  const queryTerms = tokenize(filters.query);
  const tagFilters = (filters.tags ?? []).map((tag) => tag.toLowerCase());
  const limit = Math.min(Math.max(filters.limit ?? 10, 1), 50);

  return documents
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
    .map((document) => scoreDocument(document, queryTerms))
    .filter((result) => (queryTerms.length === 0 ? true : result.score > 0))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function scoreDocument(document: MarkdownDocument, queryTerms: string[]): SearchResult {
  const title = document.title.toLowerCase();
  const path = document.relativePath.toLowerCase();
  const body = document.body.toLowerCase();
  const tags = document.frontmatter.tags ?? [];
  let score = 0;

  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += 10;
    }
    if (path.includes(term)) {
      score += 4;
    }
    if (tags.some((tag) => tag.toLowerCase().includes(term))) {
      score += 5;
    }
    const bodyMatches = countOccurrences(body, term);
    score += Math.min(bodyMatches, 8);
  }

  return {
    id: document.id,
    path: document.relativePath,
    title: document.title,
    client: document.frontmatter.client,
    project: document.frontmatter.project,
    tags,
    snippet: makeSnippet(document.body, queryTerms),
    score
  };
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
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

  const lower = compact.toLowerCase();
  const firstHit = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(firstHit - 80, 0);
  const end = Math.min(start + 220, compact.length);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}
