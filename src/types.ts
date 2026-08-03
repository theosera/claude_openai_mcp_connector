export type ClientName = "claude" | "chatgpt" | "shared" | string;

export interface DocumentMetadata {
  id?: string;
  client?: ClientName;
  project?: string;
  title?: string;
  tags?: string[];
  source_refs?: string[];
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * Search text derived from the body once, when the file is parsed, and carried
 * on the cached document — folding a whole corpus on every query is the search
 * path's real cost. Internal: `toPublicDocument` is an allowlist, so this is
 * never part of a tool response, and it is optional so a document built by hand
 * (tests, fixtures) still searches correctly, just without the cache.
 */
export interface DerivedSearchText {
  /** NFKC-folded, lowercased body — what scoring scans. */
  foldedBody: string;
  /** Whitespace-collapsed body — what snippets are sliced from. */
  compactBody: string;
}

export interface MarkdownDocument {
  id: string;
  relativePath: string;
  absolutePath: string;
  frontmatter: DocumentMetadata;
  body: string;
  title: string;
  searchDerived?: DerivedSearchText;
  /** Name of the knowledge root the document came from (multi-root mode only). */
  root?: string;
  stats: {
    sizeBytes: number;
    modifiedAt: string;
  };
}

export interface SearchResult {
  id: string;
  path: string;
  title: string;
  client?: string;
  project?: string;
  tags: string[];
  snippet: string;
  score: number;
  /** Name of the knowledge root the hit came from (multi-root mode only). */
  root?: string;
  /** Filesystem mtime (ISO 8601). Present on every hit. */
  modified_at: string;
  /** Frontmatter `updated_at`, when the note carries one. */
  updated_at?: string;
  /**
   * File size. Lets a caller see that a hit is a megabyte-scale note (a session
   * archive, say) and reach for a narrower read instead of fetching it whole.
   */
  size_bytes: number;
  /** Per-signal score contributions; present only when `explain` was set. */
  score_breakdown?: ScoreBreakdown;
}

/**
 * Search results plus the counters a caller needs to know whether it saw
 * everything. Without `total_count` a client cannot distinguish "10 hits" from
 * "10 of 400", which is what drives blind re-querying.
 */
export interface SearchResponse {
  results: SearchResult[];
  /** Matches after filtering, before `offset`/`limit` are applied. */
  total_count: number;
  offset: number;
  limit: number;
}

export interface ProjectSummary {
  client: string;
  project: string;
  count: number;
  latestModifiedAt: string;
}

export interface PlannedPatch {
  patch_id: string;
  target_path: string;
  reason: string;
  expected_sha256: string;
  created_at: string;
  new_content: string;
  diff: string;
}

export interface PlannedDocumentCreate {
  operation: "document_create";
  patch_id: string;
  target_path: string;
  reason: string;
  created_at: string;
  new_content: string;
  content_sha256: string;
  diff: string;
  confirmation: {
    question: string;
    options: [{ label: "はい"; value: "confirm" }];
    allow_free_text: true;
  };
}

export interface SearchFilters {
  query: string;
  client?: string;
  project?: string;
  tags?: string[];
  limit?: number;
  /** Skip this many ranked matches before taking `limit` (paging). */
  offset?: number;
  /**
   * Restrict to documents whose vault-relative path starts with this prefix. In
   * multi-root mode it is matched against the on-disk path, without the
   * `<root>:` prefix — pair it with `root` to scope to one knowledge root.
   */
  path_prefix?: string;
  /** Restrict to one named knowledge root (multi-root deployments only). */
  root?: string;
  /** ISO 8601 bounds on the document's effective timestamp. */
  updated_after?: string;
  updated_before?: string;
  /**
   * Ranking order. Defaults to `relevance` for a query, and `path` for an empty
   * one — which keeps the empty query a stable listing of the vault.
   */
  order?: "relevance" | "recent" | "path";
  /** Per-request override of the recency weight (0 disables it). */
  recency_weight?: number;
  /** Include `score_breakdown` on every result. */
  explain?: boolean;
}

/** Operator-level search defaults, sourced from env by `loadConfig`. */
export interface SearchDefaults {
  recencyWeight?: number;
  recencyHalfLifeDays?: number;
  /** Injectable clock; tests pin recency decay without touching the real one. */
  now?: number;
}

/**
 * Per-signal contributions behind `SearchResult.score`, returned when `explain`
 * is set. `recency` is the amount recency added, not the multiplier.
 */
export interface ScoreBreakdown {
  title: number;
  path: number;
  tags: number;
  body: number;
  phrase: number;
  recency: number;
}

export interface CreateDocumentInput {
  client: string;
  project: string;
  title: string;
  body: string;
  tags?: string[];
  source_refs?: string[];
}

export interface PlanUpdateInput {
  id_or_path: string;
  new_body: string;
  frontmatter_patch?: Record<string, unknown>;
  reason: string;
}

export interface PlanDocumentCreateInput {
  relative_path: string;
  title: string;
  body: string;
  client?: string;
  project?: string;
  tags?: string[];
  source_refs?: string[];
  reason: string;
}

export interface TraceResult {
  document: Pick<MarkdownDocument, "id" | "relativePath" | "title">;
  source_refs: string[];
  outgoing_links: string[];
  backlinks: Array<Pick<MarkdownDocument, "id" | "relativePath" | "title">>;
}

/**
 * Common surface implemented by both the single-root KnowledgeStore and the
 * MultiRootStore composite. server.ts / chatgpt.ts / httpServer.ts program
 * against this interface so the tool surface is identical either way.
 */
/**
 * A document as handed to a client. `absolutePath` is intentionally absent: the
 * host filesystem layout is server-side detail, and a remote client never needs
 * it (the ChatGPT adapter has always omitted it). Built by an explicit allowlist
 * in `server.ts` so a future field on `MarkdownDocument` cannot leak by default.
 */
export type PublicDocument = Omit<MarkdownDocument, "absolutePath" | "searchDerived">;

export interface VaultStore {
  init(): Promise<void>;
  search(filters: SearchFilters): Promise<SearchResponse>;
  fetch(idOrPath: string): Promise<MarkdownDocument>;
  listProjects(client?: string, tags?: string[]): Promise<ProjectSummary[]>;
  listDocuments(): Promise<MarkdownDocument[]>;
  createDocument(input: CreateDocumentInput): Promise<MarkdownDocument>;
  planDocumentCreate(input: PlanDocumentCreateInput): Promise<PlannedDocumentCreate>;
  applyPlannedDocumentCreate(
    patchId: string,
    confirmedTargetPath: string
  ): Promise<{ document: MarkdownDocument; diff: string }>;
  planUpdate(input: PlanUpdateInput): Promise<PlannedPatch>;
  applyPlannedUpdate(patchId: string): Promise<{ document: MarkdownDocument; diff: string }>;
  traceSources(idOrPath: string): Promise<TraceResult>;
}
