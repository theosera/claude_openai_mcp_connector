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

/**
 * Local links extracted from the body once, when the file is parsed, and
 * carried on the cached document — `trace_sources` runs the extractors over
 * EVERY note in the vault, so re-scanning bodies per call is the link plane's
 * equivalent of folding every body per query. Internal, like `DerivedSearchText`:
 * `toPublicDocument` is an allowlist, so it never reaches a client, and it is
 * optional so a hand-built document (tests, fixtures) still builds a correct
 * graph — just by extracting on the spot.
 */
export interface DerivedLinks {
  /** `[[wikilink]]` targets, anchors and aliases already stripped. */
  wiki: string[];
  /** `[text](target)` targets, external and fragment-only ones already dropped. */
  markdown: string[];
}

export interface MarkdownDocument {
  id: string;
  relativePath: string;
  absolutePath: string;
  frontmatter: DocumentMetadata;
  body: string;
  title: string;
  searchDerived?: DerivedSearchText;
  linksDerived?: DerivedLinks;
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

/**
 * A note a link COULD have meant, offered when it did not resolve.
 *
 * `via` says what matched, and the distinction is the whole point: `basename`
 * is a path fact the note cannot author about itself, while `title` and `alias`
 * are frontmatter the body's author writes. The latter two never resolve a link
 * on their own — not even a unique one — so they surface here instead.
 */
export interface LinkCandidate {
  id: string;
  /** Vault-relative path (`<root>:<path>` in multi-root mode). */
  path: string;
  title: string;
  via: "basename" | "title" | "alias";
}

/** A graph node as handed back to a caller: the two handles plus a label. */
export interface LinkGraphNodeRef {
  id: string;
  path: string;
  title: string;
}

/**
 * One local link the note writes, with what it resolved to.
 *
 * `target_path` is the handle to follow — it is server-owned. `target_id` is
 * the document's frontmatter id, carried because citations elsewhere use it,
 * but it is self-declared (INV-2) and is not what the graph is keyed on.
 */
export interface ResolvedOutgoingLink {
  /** The link text exactly as written in the note. */
  raw: string;
  resolved: boolean;
  target_id?: string;
  target_path?: string;
  /** Present only when unresolved AND something matched. Never a ranking. */
  candidates?: LinkCandidate[];
}

/** A node reached by the bounded neighbourhood walk behind `depth`. */
export interface RelatedNode {
  id: string;
  path: string;
  title: string;
  /** Hops from the traced document: 1 is a direct link either way. */
  distance: number;
  /** Path of the node this one was reached through — provenance for the hop. */
  via: string;
}

export interface TraceOptions {
  /** 1 (default) or 2. Bounded by MAX_LINK_GRAPH_DEPTH in src/linkGraph.ts. */
  depth?: number;
  /**
   * Which edges the depth expansion follows. Shapes `related` only: the three
   * pre-existing fields keep their meaning whatever this is set to, so adding
   * the parameter cannot change what an existing caller sees.
   */
  direction?: "out" | "in" | "both";
}

export interface TraceResult {
  document: Pick<MarkdownDocument, "id" | "relativePath" | "title">;
  source_refs: string[];
  outgoing_links: string[];
  backlinks: Array<Pick<MarkdownDocument, "id" | "relativePath" | "title">>;
  /**
   * Every entry of `outgoing_links`, labelled with what it resolved to. Same
   * raw strings, so a caller can line the two up; `outgoing_links` is kept
   * because it is the shape existing clients already parse.
   */
  resolved_outgoing: ResolvedOutgoingLink[];
  /**
   * Bounded neighbourhood, present only when `depth` >= 2 was asked for.
   * Unlike `backlinks`, this IS capped (node / fan-out / hub-damping limits in
   * src/linkGraph.ts) — it is an exploration, not an inventory.
   */
  related?: RelatedNode[];
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
export type PublicDocument = Omit<MarkdownDocument, "absolutePath" | "searchDerived" | "linksDerived">;

/**
 * Narrowing hints for a vault scan. Purely a cost control: a scan given a
 * `pathPrefix` may skip subtrees that provably cannot contain a matching file,
 * but it is always free to return MORE than was asked for. The authoritative
 * filter stays in `searchDocuments`, so an over-eager prune here would be a
 * correctness bug while an under-eager one is only slower — which is why the
 * walk's prune rule is deliberately conservative and symlinked entries opt out
 * of it entirely.
 */
export interface ListDocumentsOptions {
  /**
   * Vault-relative path prefix (NFC, POSIX separators, no `./`), matched the way
   * `SearchFilters.path_prefix` is matched: a plain string prefix of the
   * document's path, not necessarily a directory boundary.
   */
  pathPrefix?: string;
}

export interface VaultStore {
  init(): Promise<void>;
  search(filters: SearchFilters): Promise<SearchResponse>;
  fetch(idOrPath: string): Promise<MarkdownDocument>;
  listProjects(client?: string, tags?: string[]): Promise<ProjectSummary[]>;
  listDocuments(options?: ListDocumentsOptions): Promise<MarkdownDocument[]>;
  createDocument(input: CreateDocumentInput): Promise<MarkdownDocument>;
  planDocumentCreate(input: PlanDocumentCreateInput): Promise<PlannedDocumentCreate>;
  applyPlannedDocumentCreate(
    patchId: string,
    confirmedTargetPath: string
  ): Promise<{ document: MarkdownDocument; diff: string }>;
  planUpdate(input: PlanUpdateInput): Promise<PlannedPatch>;
  applyPlannedUpdate(patchId: string): Promise<{ document: MarkdownDocument; diff: string }>;
  traceSources(idOrPath: string, options?: TraceOptions): Promise<TraceResult>;
}
