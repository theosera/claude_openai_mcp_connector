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
