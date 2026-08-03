import type {
  MarkdownDocument,
  ScoreBreakdown,
  SearchDefaults,
  SearchFilters,
  SearchResponse,
  SearchResult
} from "./types.js";
import { segmentQueryToken } from "./searchSegmenter.js";
import { normalizeForMatch, normalizeWithMap, toSourceIndex } from "./searchText.js";

export type { SearchFilters } from "./types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** Window used when no query term matched — a plain head-of-note preview. */
const HEAD_SNIPPET_LENGTH = 220;
const SNIPPET_WINDOW = 160;
const SNIPPET_LEAD = 60;
const MAX_SNIPPET_WINDOWS = 2;
const SNIPPET_JOIN = " … ";

/** Recency is off unless the operator opts in; see `MCP_SEARCH_RECENCY_WEIGHT`. */
export const DEFAULT_RECENCY_WEIGHT = 0;
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

interface QueryTerm {
  /** The term to match. */
  text: string;
  /** A whole user-typed token, as opposed to a piece of a segmented one. */
  whole: boolean;
}

interface ScoredDocument {
  total: number;
  breakdown: ScoreBreakdown;
}

interface RecencySettings {
  recencyWeight: number;
  halfLifeDays: number;
  now: number;
}

export function searchDocuments(
  documents: MarkdownDocument[],
  filters: SearchFilters,
  defaults: SearchDefaults = {}
): SearchResponse {
  const terms = tokenize(filters.query);
  const tagFilters = (filters.tags ?? []).map((tag) => tag.toLowerCase());
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(filters.offset ?? 0, 0);

  const recencyWeight = clampWeight(filters.recency_weight ?? defaults.recencyWeight ?? DEFAULT_RECENCY_WEIGHT);
  const recency: RecencySettings = {
    recencyWeight,
    halfLifeDays: positiveOr(defaults.recencyHalfLifeDays, DEFAULT_RECENCY_HALF_LIFE_DAYS),
    now: defaults.now ?? Date.now()
  };

  const pathPrefix = filters.path_prefix ? filters.path_prefix.normalize("NFC").replace(/^\.\//, "") : undefined;
  const updatedAfter = parseFilterDate(filters.updated_after, "updated_after");
  const updatedBefore = parseFilterDate(filters.updated_before, "updated_before");

  // Ranking order. Keeping the empty-query default on path order preserves the
  // de-facto "list the vault" behavior; recency only takes over when it is asked
  // for, or when the operator turned the recency signal on at all.
  const order = filters.order ?? (terms.length > 0 ? "relevance" : recencyWeight > 0 ? "recent" : "path");

  const ranked = documents
    .filter((document) => {
      if (filters.client && document.frontmatter.client !== filters.client) {
        return false;
      }
      if (filters.project && document.frontmatter.project !== filters.project) {
        return false;
      }
      if (filters.root && document.root !== filters.root) {
        return false;
      }
      if (pathPrefix && !unprefixedPath(document).startsWith(pathPrefix)) {
        return false;
      }
      if (updatedAfter !== undefined || updatedBefore !== undefined) {
        const timestamp = effectiveTimestamp(document);
        if (updatedAfter !== undefined && timestamp < updatedAfter) {
          return false;
        }
        if (updatedBefore !== undefined && timestamp > updatedBefore) {
          return false;
        }
      }
      const documentTags = (document.frontmatter.tags ?? []).map((tag) => tag.toLowerCase());
      return tagFilters.every((tag) => documentTags.includes(tag));
    })
    .map((document) => ({ document, score: scoreDocument(document, terms, recency) }))
    .filter((scored) => (terms.length === 0 ? true : scored.score.total > 0))
    .sort((a, b) => compareRanked(a, b, order));

  // Snippets are built only for the page that is actually returned: folding a
  // megabyte-scale body and mapping its offsets is far too expensive to do for
  // every document that merely matched.
  const results = ranked
    .slice(offset, offset + limit)
    .map((scored) => toSearchResult(scored.document, scored.score, terms, filters.explain === true));

  return { results, total_count: ranked.length, offset, limit };
}

function compareRanked(
  a: { document: MarkdownDocument; score: ScoredDocument },
  b: { document: MarkdownDocument; score: ScoredDocument },
  order: NonNullable<SearchFilters["order"]>
): number {
  if (order === "recent") {
    const delta = effectiveTimestamp(b.document) - effectiveTimestamp(a.document);
    if (delta !== 0) {
      return delta;
    }
  } else if (order === "relevance") {
    const delta = b.score.total - a.score.total;
    if (delta !== 0) {
      return delta;
    }
  }
  return a.document.relativePath.localeCompare(b.document.relativePath);
}

function scoreDocument(document: MarkdownDocument, terms: QueryTerm[], recency: RecencySettings): ScoredDocument {
  // Title, path and tags are short enough to fold per query; the body — the only
  // expensive one — is folded once at parse time and carried on the document.
  const title = normalizeForMatch(document.title);
  const path = normalizeForMatch(document.relativePath);
  const body = foldedBody(document);
  const tags = (document.frontmatter.tags ?? []).map((tag) => normalizeForMatch(tag));

  const breakdown: ScoreBreakdown = { title: 0, path: 0, tags: 0, body: 0, phrase: 0, recency: 0 };

  for (const term of terms) {
    if (title.includes(term.text)) {
      breakdown.title += 10;
    }
    if (path.includes(term.text)) {
      breakdown.path += 4;
    }
    if (tags.some((tag) => tag.includes(term.text))) {
      breakdown.tags += 5;
    }
    const bodyMatches = countOccurrences(body, term.text);
    breakdown.body += Math.min(bodyMatches, 8);

    // A note carrying the user's phrase verbatim outranks one that merely holds
    // its pieces scattered around. Only meaningful once a token was segmented.
    if (term.whole && terms.length > 1 && (bodyMatches > 0 || title.includes(term.text))) {
      breakdown.phrase += 4;
    }
  }

  const textScore = breakdown.title + breakdown.path + breakdown.tags + breakdown.body + breakdown.phrase;
  // Multiplicative, so a document with no textual match cannot be resurrected by
  // being recent — the `score > 0` gate above stays meaningful.
  if (recency.recencyWeight > 0 && textScore > 0) {
    const ageDays = Math.max(0, (recency.now - effectiveTimestamp(document)) / MS_PER_DAY);
    breakdown.recency = textScore * recency.recencyWeight * Math.pow(2, -ageDays / recency.halfLifeDays);
  }

  return { total: textScore + breakdown.recency, breakdown };
}

function toSearchResult(
  document: MarkdownDocument,
  scored: ScoredDocument,
  terms: QueryTerm[],
  explain: boolean
): SearchResult {
  const updatedAt = typeof document.frontmatter.updated_at === "string" ? document.frontmatter.updated_at : undefined;

  return {
    id: document.id,
    path: document.relativePath,
    title: document.title,
    client: document.frontmatter.client,
    project: document.frontmatter.project,
    tags: document.frontmatter.tags ?? [],
    snippet: makeSnippet(document, terms),
    score: scored.total,
    ...(document.root ? { root: document.root } : {}),
    modified_at: document.stats.modifiedAt,
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    size_bytes: document.stats.sizeBytes,
    ...(explain ? { score_breakdown: scored.breakdown } : {})
  };
}

/**
 * Whitespace-split, then split each CJK token into words as well. Sub-terms are
 * ADDED to the whole token rather than replacing it, so an ASCII-only query
 * tokenizes exactly as it always did.
 */
function tokenize(query: string): QueryTerm[] {
  const seen = new Set<string>();
  const terms: QueryTerm[] = [];

  for (const raw of normalizeForMatch(query).split(/\s+/)) {
    const token = raw.trim();
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    terms.push({ text: token, whole: true });

    for (const piece of segmentQueryToken(token)) {
      if (!seen.has(piece)) {
        seen.add(piece);
        terms.push({ text: piece, whole: false });
      }
    }
  }

  return terms;
}

/**
 * `updated_at` first: filesystem mtime is rewritten by `git clone` / checkout,
 * and both the vault and the log repo are git-synced, so mtime routinely reads
 * "today" for a note written months ago. Falls back to mtime when frontmatter
 * carries nothing usable.
 */
export function effectiveTimestamp(document: MarkdownDocument): number {
  for (const candidate of [document.frontmatter.updated_at, document.frontmatter.date]) {
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  const mtime = Date.parse(document.stats.modifiedAt);
  return Number.isNaN(mtime) ? 0 : mtime;
}

/** Collapse runs of whitespace so a snippet reads as one line. */
export function compactWhitespace(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function foldedBody(document: MarkdownDocument): string {
  return document.searchDerived?.foldedBody ?? normalizeForMatch(document.body);
}

function compactBody(document: MarkdownDocument): string {
  return document.searchDerived?.compactBody ?? compactWhitespace(document.body);
}

function unprefixedPath(document: MarkdownDocument): string {
  if (!document.root) {
    return document.relativePath;
  }
  const separator = document.relativePath.indexOf(":");
  return separator === -1 ? document.relativePath : document.relativePath.slice(separator + 1);
}

function parseFilterDate(value: string | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${field} must be an ISO 8601 date or date-time.`);
  }
  return parsed;
}

function clampWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) {
    return 0;
  }
  return Math.min(weight, 1);
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
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

/**
 * Up to two windows around the matches, covering as many distinct query terms as
 * possible — a single window often lands on a passing mention while the passage
 * that actually answers the query sits further down. Positions are found on the
 * folded text and mapped back, so what the caller sees is sliced from the note
 * itself, never from the normalization's output.
 */
function makeSnippet(document: MarkdownDocument, terms: QueryTerm[]): string {
  const compact = compactBody(document);
  if (!compact) {
    return "";
  }

  const normalized = terms.length > 0 ? normalizeWithMap(compact) : undefined;
  const hits = normalized
    ? terms
        .map((term) => normalized.text.indexOf(term.text))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)
    : [];

  if (!normalized || hits.length === 0) {
    return clip(compact, 0, Math.min(HEAD_SNIPPET_LENGTH, compact.length));
  }

  const windows: Array<{ start: number; end: number }> = [];
  for (const hit of hits) {
    const anchor = toSourceIndex(normalized, hit, compact.length);
    if (windows.some((window) => anchor >= window.start && anchor < window.end)) {
      continue; // already visible in a window we are emitting
    }
    const start = Math.max(anchor - SNIPPET_LEAD, 0);
    windows.push({ start, end: Math.min(start + SNIPPET_WINDOW, compact.length) });
    if (windows.length === MAX_SNIPPET_WINDOWS) {
      break;
    }
  }

  return windows.map((window) => clip(compact, window.start, window.end)).join(SNIPPET_JOIN);
}

function clip(compact: string, start: number, end: number): string {
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}
