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

export interface MarkdownDocument {
  id: string;
  relativePath: string;
  absolutePath: string;
  frontmatter: DocumentMetadata;
  body: string;
  title: string;
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
export interface VaultStore {
  init(): Promise<void>;
  search(filters: SearchFilters): Promise<SearchResult[]>;
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
