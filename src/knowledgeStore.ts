import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { assertFrontmatterPatch, parseMarkdownSafe, serializeMarkdown, titleFromMarkdown } from "./frontmatter.js";
import { extractAllLocalLinks } from "./markdownLinks.js";
import { searchDocuments, type SearchFilters } from "./search.js";
import type { StoreConfig } from "./config.js";
import type {
  DocumentMetadata,
  MarkdownDocument,
  PlanDocumentCreateInput,
  PlannedDocumentCreate,
  PlannedPatch,
  ProjectSummary,
  SearchResult,
  TraceResult,
  VaultStore
} from "./types.js";
import {
  assertRelativePath,
  relativeToRoot,
  resolveExistingRoot,
  resolveInsideRoot,
  toPosixPath
} from "./pathSafety.js";

// A vault scan opens one file handle per note. A naive Promise.all over a
// 2,000+ file vault opens them all at once, exhausting the process
// file-descriptor limit; on network / iCloud-backed filesystems that surfaces
// as transient EAGAIN / EMFILE. Bound the fan-out (default 24, override via
// MCP_SCAN_CONCURRENCY) and retry ONLY the transient resource-exhaustion codes
// — never ENOENT / EACCES, which are permanent and would otherwise spin.
const DEFAULT_SCAN_CONCURRENCY = 24;
const SCAN_MAX_RETRIES = 4;
const SCAN_RETRY_BASE_MS = 100;
const TRANSIENT_FS_CODES = new Set(["EAGAIN", "EMFILE", "ENFILE"]);

export function isTransientFsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_FS_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded async map: at most `limit` callbacks run at once; order is preserved. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    })
  );
  return results;
}

export class KnowledgeStore implements VaultStore {
  private readonly config: StoreConfig;
  private rootRealPath?: string;
  // Parse cache keyed by real path. Parsing every Markdown file on every query
  // is the search bottleneck for large vaults; we re-parse a file only when its
  // mtime/size changes. Path-containment checks still run on every access.
  private readonly documentCache = new Map<
    string,
    { mtimeMs: number; sizeBytes: number; document: MarkdownDocument }
  >();

  constructor(config: StoreConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    this.rootRealPath = await resolveExistingRoot(this.config.knowledgeRoot);
    await fs.mkdir(this.config.patchStateDir, { recursive: true });
  }

  /** Resolved real path of this store's root (used for multi-root overlap checks). */
  async rootPath(): Promise<string> {
    return this.root();
  }

  async search(filters: SearchFilters): Promise<SearchResult[]> {
    return searchDocuments(await this.listDocuments(), filters);
  }

  async fetch(idOrPath: string): Promise<MarkdownDocument> {
    const documents = await this.listDocuments();
    const byId = documents.find((document) => document.id === idOrPath);
    if (byId) {
      return byId;
    }

    const normalized = toPosixPath(assertRelativePath(ensureMarkdownExtension(idOrPath)));
    const byPath = documents.find((document) => document.relativePath === normalized);
    if (!byPath) {
      throw new Error(`Document not found: ${idOrPath}`);
    }
    return byPath;
  }

  async listProjects(client?: string, tags?: string[]): Promise<ProjectSummary[]> {
    const tagFilters = (tags ?? []).map((tag) => tag.toLowerCase());
    const grouped = new Map<string, ProjectSummary>();

    for (const document of await this.listDocuments()) {
      if (client && document.frontmatter.client !== client) {
        continue;
      }
      const documentTags = (document.frontmatter.tags ?? []).map((tag) => tag.toLowerCase());
      if (!tagFilters.every((tag) => documentTags.includes(tag))) {
        continue;
      }

      const groupClient = document.frontmatter.client ?? "unknown";
      const project = document.frontmatter.project ?? "uncategorized";
      const key = `${groupClient}\0${project}`;
      const current = grouped.get(key);
      if (!current) {
        grouped.set(key, {
          client: groupClient,
          project,
          count: 1,
          latestModifiedAt: document.stats.modifiedAt
        });
      } else {
        current.count += 1;
        if (document.stats.modifiedAt > current.latestModifiedAt) {
          current.latestModifiedAt = document.stats.modifiedAt;
        }
      }
    }

    return [...grouped.values()].sort((a, b) => a.client.localeCompare(b.client) || a.project.localeCompare(b.project));
  }

  async createDocument(input: {
    client: string;
    project: string;
    title: string;
    body: string;
    tags?: string[];
    source_refs?: string[];
  }): Promise<MarkdownDocument> {
    const metadata: DocumentMetadata = {
      id: crypto.randomUUID(),
      client: input.client,
      project: input.project,
      title: input.title,
      tags: input.tags ?? [],
      source_refs: input.source_refs ?? [],
      updated_at: new Date().toISOString()
    };

    const relativePath = toPosixPath(
      path.join("projects", slugSegment(input.client), slugSegment(input.project), `${slugSegment(input.title)}.md`)
    );
    const absolutePath = await this.resolveForWrite(relativePath);

    try {
      await fs.writeFile(absolutePath, serializeMarkdown(metadata, input.body), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Document already exists: ${relativePath}`, { cause: error });
      }
      throw error;
    }

    return this.readDocument(absolutePath);
  }

  async planDocumentCreate(input: PlanDocumentCreateInput): Promise<PlannedDocumentCreate> {
    const targetPath = await this.validateCreateTarget(input.relative_path);
    const metadata: DocumentMetadata = {
      id: crypto.randomUUID(),
      title: input.title,
      tags: input.tags ?? [],
      source_refs: input.source_refs ?? [],
      updated_at: new Date().toISOString()
    };
    if (input.client !== undefined) metadata.client = input.client;
    if (input.project !== undefined) metadata.project = input.project;

    const newContent = serializeMarkdown(metadata, input.body);
    const patch: PlannedDocumentCreate = {
      operation: "document_create",
      patch_id: crypto.randomUUID(),
      target_path: targetPath,
      reason: input.reason,
      created_at: new Date().toISOString(),
      new_content: newContent,
      content_sha256: sha256(newContent),
      diff: createTwoFilesPatch("/dev/null", targetPath, "", newContent, "absent", "planned"),
      confirmation: {
        question: `保存先は「${targetPath}」でよろしいですか？`,
        options: [{ label: "はい", value: "confirm" }],
        allow_free_text: true
      }
    };

    await fs.mkdir(this.config.patchStateDir, { recursive: true });
    await fs.writeFile(this.patchPath(patch.patch_id), JSON.stringify(patch, null, 2), {
      encoding: "utf8",
      flag: "wx"
    });
    return patch;
  }

  async applyPlannedDocumentCreate(
    patchId: string,
    confirmedTargetPath: string
  ): Promise<{ document: MarkdownDocument; diff: string }> {
    const patchRaw = await fs.readFile(this.patchPath(patchId), "utf8");
    const patch = JSON.parse(patchRaw) as Partial<PlannedDocumentCreate>;
    if (
      patch.operation !== "document_create" ||
      typeof patch.target_path !== "string" ||
      typeof patch.new_content !== "string" ||
      typeof patch.content_sha256 !== "string" ||
      typeof patch.diff !== "string"
    ) {
      throw new Error("Patch is not a planned document create.");
    }
    if (sha256(patch.new_content) !== patch.content_sha256) {
      throw new Error("Planned document content failed integrity validation.");
    }

    const confirmedPath = toPosixPath(assertRelativePath(confirmedTargetPath));
    if (confirmedPath !== patch.target_path) {
      throw new Error("Confirmed target path does not match the planned document target.");
    }

    const absolutePath = await this.resolveForWrite(await this.validateCreateTarget(patch.target_path));
    try {
      await fs.writeFile(absolutePath, patch.new_content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Document already exists: ${patch.target_path}`, { cause: error });
      }
      throw error;
    }

    await fs.unlink(this.patchPath(patchId));
    return { document: await this.readDocument(absolutePath), diff: patch.diff };
  }

  async planUpdate(input: {
    id_or_path: string;
    new_body: string;
    frontmatter_patch?: Record<string, unknown>;
    reason: string;
  }): Promise<PlannedPatch> {
    const document = await this.fetch(input.id_or_path);
    // Reject any non-allowlisted frontmatter key before it can reach the file
    // (frontmatter field-injection defense). `id` / `updated_at` stay server-owned.
    const frontmatterPatch = assertFrontmatterPatch(input.frontmatter_patch ?? {});
    const currentRaw = await fs.readFile(document.absolutePath, "utf8");
    const expectedSha = sha256(currentRaw);
    const newMetadata: DocumentMetadata = {
      ...document.frontmatter,
      ...frontmatterPatch,
      updated_at: new Date().toISOString()
    };
    const newContent = serializeMarkdown(newMetadata, input.new_body);
    const diff = createTwoFilesPatch(
      document.relativePath,
      document.relativePath,
      currentRaw,
      newContent,
      "current",
      "planned"
    );
    const patch: PlannedPatch = {
      patch_id: crypto.randomUUID(),
      target_path: document.relativePath,
      reason: input.reason,
      expected_sha256: expectedSha,
      created_at: new Date().toISOString(),
      new_content: newContent,
      diff
    };

    await fs.mkdir(this.config.patchStateDir, { recursive: true });
    await fs.writeFile(this.patchPath(patch.patch_id), JSON.stringify(patch, null, 2), "utf8");
    return patch;
  }

  async applyPlannedUpdate(patchId: string): Promise<{ document: MarkdownDocument; diff: string }> {
    const patchRaw = await fs.readFile(this.patchPath(patchId), "utf8");
    const patch = JSON.parse(patchRaw) as PlannedPatch & { operation?: string };
    if (patch.operation === "document_create") {
      throw new Error("Patch is not a planned document update.");
    }
    const absolutePath = await this.resolveForExistingRead(patch.target_path);
    const currentRaw = await fs.readFile(absolutePath, "utf8");
    const currentSha = sha256(currentRaw);

    if (currentSha !== patch.expected_sha256) {
      throw new Error("Patch is stale: the target document changed after the plan was created.");
    }

    await fs.writeFile(absolutePath, patch.new_content, "utf8");
    await fs.unlink(this.patchPath(patchId));
    return {
      document: await this.readDocument(absolutePath),
      diff: patch.diff
    };
  }

  async traceSources(idOrPath: string): Promise<TraceResult> {
    const document = await this.fetch(idOrPath);
    const documents = await this.listDocuments();
    const linkTargets = new Set([document.relativePath, document.relativePath.replace(/\.md$/i, ""), document.title]);

    const backlinks = documents
      .filter((candidate) => candidate.relativePath !== document.relativePath)
      .filter((candidate) =>
        extractAllLocalLinks(candidate.body).some(
          (link) => linkTargets.has(link) || linkTargets.has(ensureMarkdownExtension(link))
        )
      )
      .map((candidate) => ({ id: candidate.id, relativePath: candidate.relativePath, title: candidate.title }));

    return {
      document: { id: document.id, relativePath: document.relativePath, title: document.title },
      source_refs: document.frontmatter.source_refs ?? [],
      outgoing_links: extractAllLocalLinks(document.body),
      backlinks
    };
  }

  async listDocuments(): Promise<MarkdownDocument[]> {
    const root = await this.root();
    const files = await walkMarkdownFiles(root);
    const scanned = await mapWithConcurrency(files, this.config.scanConcurrency ?? DEFAULT_SCAN_CONCURRENCY, (file) =>
      this.readDocumentResilient(file)
    );
    const documents = scanned.filter((document): document is MarkdownDocument => document !== null);
    return documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  /**
   * Read a document, retrying ONLY transient FS exhaustion (EAGAIN/EMFILE/ENFILE)
   * with exponential backoff + jitter as the concurrency pool drains. Any other
   * failure (missing file, permissions; a malformed frontmatter is already
   * tolerated inside readDocument) logs the note name and skips it (returns null)
   * so one bad file never aborts a whole-vault scan.
   */
  private async readDocumentResilient(absolutePath: string): Promise<MarkdownDocument | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.readDocument(absolutePath);
      } catch (error) {
        if (isTransientFsError(error) && attempt < SCAN_MAX_RETRIES) {
          const backoff = SCAN_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * SCAN_RETRY_BASE_MS);
          await delay(backoff);
          continue;
        }
        // No error message (it could echo a path segment); the basename alone
        // makes a bad note discoverable without leaking the vault's location.
        process.stderr.write(`[knowledge] skipped unreadable note: ${path.basename(absolutePath)}\n`);
        return null;
      }
    }
  }

  private async readDocument(absolutePath: string): Promise<MarkdownDocument> {
    const root = await this.root();
    const realPath = await fs.realpath(absolutePath);
    const relativePath = relativeToRoot(root, realPath);

    // Fast path: a pure metadata stat decides cache validity (mtime + size).
    // Containment (realpath + relativeToRoot above) is re-validated every call.
    const cached = this.documentCache.get(realPath);
    if (cached) {
      const meta = await fs.stat(realPath);
      if (cached.mtimeMs === meta.mtimeMs && cached.sizeBytes === meta.size) {
        return cached.document;
      }
    }

    // Cache miss: read the content and stat it through a single file handle so
    // the stored mtime/size always describe exactly the bytes we parsed — a
    // separate stat() then readFile() could disagree if the file changed in
    // between (TOCTOU), caching content under a mismatched signature.
    const handle = await fs.open(realPath, "r");
    try {
      const raw = await handle.readFile("utf8");
      const stats = await handle.stat();
      const parsed = parseMarkdownSafe(raw);
      if (parsed.parseError) {
        // Do not print the parser message — it echoes file content. Just name the
        // file so one malformed note is discoverable without aborting the search.
        process.stderr.write(`[knowledge] unparseable frontmatter, indexing body only: ${relativePath}\n`);
      }
      const id =
        typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.trim()
          ? parsed.frontmatter.id.trim()
          : relativePath;

      const document: MarkdownDocument = {
        id,
        relativePath,
        absolutePath: realPath,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        title: titleFromMarkdown(relativePath, parsed.frontmatter, parsed.body),
        stats: {
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString()
        }
      };
      this.documentCache.set(realPath, { mtimeMs: stats.mtimeMs, sizeBytes: stats.size, document });
      return document;
    } finally {
      await handle.close();
    }
  }

  private async resolveForExistingRead(relativePath: string): Promise<string> {
    const root = await this.root();
    const absolutePath = await resolveInsideRoot(root, relativePath);
    const realPath = await fs.realpath(absolutePath);
    relativeToRoot(root, realPath);
    return realPath;
  }

  private async resolveForWrite(relativePath: string): Promise<string> {
    const root = await this.root();
    const safeRelative = assertRelativePath(relativePath);
    const parentSegments = path
      .dirname(safeRelative)
      .split(path.sep)
      .filter((segment) => segment !== ".");
    let current = root;

    // Create one directory at a time and reject symlinks. Calling recursive
    // mkdir before containment validation could follow an in-vault symlink and
    // create directories outside the vault before the later realpath check.
    for (const segment of parentSegments) {
      const candidate = path.join(current, segment);
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink()) {
          throw new Error("Document create path must not contain symbolic links.");
        }
        if (!stat.isDirectory()) {
          throw new Error(`Document parent is not a directory: ${segment}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await fs.mkdir(candidate);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
      }
      current = await fs.realpath(candidate);
      relativeToRoot(root, current);
    }
    return path.join(current, path.basename(safeRelative));
  }

  private async validateCreateTarget(relativePath: string): Promise<string> {
    const root = await this.root();
    const safeRelative = assertRelativePath(relativePath);
    if (!safeRelative.endsWith(".md")) {
      throw new Error("Document create target must end with .md.");
    }

    const parentSegments = path
      .dirname(safeRelative)
      .split(path.sep)
      .filter((segment) => segment !== ".");
    let current = root;
    for (const segment of parentSegments) {
      const candidate = path.join(current, segment);
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink()) {
          throw new Error("Document create path must not contain symbolic links.");
        }
        if (!stat.isDirectory()) {
          throw new Error(`Document parent is not a directory: ${segment}`);
        }
        current = await fs.realpath(candidate);
        relativeToRoot(root, current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }

    const target = path.resolve(root, safeRelative);
    relativeToRoot(root, target);
    try {
      await fs.lstat(target);
      throw new Error(`Document already exists: ${toPosixPath(safeRelative)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return toPosixPath(safeRelative);
  }

  private async root(): Promise<string> {
    if (!this.rootRealPath) {
      await this.init();
    }
    return this.rootRealPath!;
  }

  private patchPath(patchId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(patchId)) {
      throw new Error("Invalid patch_id.");
    }
    return path.join(this.config.patchStateDir, `${patchId}.json`);
  }
}

async function walkMarkdownFiles(root: string, current: string = root, visited = new Set<string>()): Promise<string[]> {
  const currentRealPath = await fs.realpath(current);
  relativeToRoot(root, currentRealPath);

  if (visited.has(currentRealPath)) {
    return [];
  }
  visited.add(currentRealPath);

  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".mcp-state") {
      continue;
    }
    const absolutePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      const realPath = await fs.realpath(absolutePath);
      relativeToRoot(root, realPath);
      const stat = await fs.stat(realPath);
      if (stat.isDirectory()) {
        files.push(...(await walkMarkdownFiles(root, realPath, visited)));
      } else if (stat.isFile() && realPath.endsWith(".md")) {
        files.push(realPath);
      }
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(root, absolutePath, visited)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function slugSegment(value: string): string {
  // Keep Unicode letters/digits (\p{L}\p{N}) so a non-ASCII title/client/project
  // — e.g. an all-Japanese "設計メモ" — produces a distinct slug instead of
  // collapsing to "untitled". Collapsing every non-ASCII segment to "untitled"
  // made a fully-Japanese vault able to hold only ONE document per client/project
  // (the 2nd create_document hit the wx-overwrite guard). Path containment still
  // normalizes/validates the resulting non-ASCII path downstream.
  const slug = value
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  // Titles with no letters/digits at all (pure punctuation/emoji) still need a
  // unique, collision-free segment rather than a shared "untitled".
  return slug || `untitled-${sha256(value).slice(0, 8)}`;
}

function ensureMarkdownExtension(value: string): string {
  return value.endsWith(".md") ? value : `${value}.md`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
