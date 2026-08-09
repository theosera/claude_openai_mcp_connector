import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { assertFrontmatterPatch, parseMarkdownSafe, serializeMarkdown, titleFromMarkdown } from "./frontmatter.js";
import { extractAllLocalLinks, extractMarkdownLinks, resolveRelativeLink } from "./markdownLinks.js";
import { ensurePatchStateDir, PATCH_STATE_FILE_MODE } from "./patchState.js";
import { compactWhitespace, searchDocuments, type SearchFilters } from "./search.js";
import { normalizeForMatch } from "./searchText.js";
import type { StoreConfig } from "./config.js";
import type {
  DocumentMetadata,
  MarkdownDocument,
  PlanDocumentCreateInput,
  PlannedDocumentCreate,
  PlannedPatch,
  ProjectSummary,
  SearchDefaults,
  SearchResponse,
  TraceResult,
  VaultStore
} from "./types.js";
import {
  assertRelativePath,
  posixContains,
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
    await ensurePatchStateDir(this.config.patchStateDir);
  }

  /** Resolved real path of this store's root (used for multi-root overlap checks). */
  async rootPath(): Promise<string> {
    return this.root();
  }

  async search(filters: SearchFilters): Promise<SearchResponse> {
    return searchDocuments(await this.listDocuments(), filters, this.searchDefaults());
  }

  private searchDefaults(): SearchDefaults {
    return {
      recencyWeight: this.config.searchRecencyWeight,
      recencyHalfLifeDays: this.config.searchRecencyHalfLifeDays
    };
  }

  async fetch(idOrPath: string): Promise<MarkdownDocument> {
    const documents = await this.listDocuments();
    const byId = documents.filter((document) => document.id === idOrPath);
    if (byId.length > 0) {
      // INV-2: that id came out of a file's own frontmatter, which is untrusted
      // vault content — so resolve it only when nothing else claims the same
      // reference (see resolveUniqueReference). The path candidate is resolved
      // leniently here: a reference that is not a usable vault-relative path has
      // no path interpretation to collide with, and the strict resolution below
      // still runs whenever nothing matched by id.
      return resolveUniqueReference(idOrPath, byId, this.pathMatch(documents, idOrPath));
    }

    const normalized = toPosixPath(assertRelativePath(ensureMarkdownExtension(idOrPath)));
    const byPath = documents.find((document) => document.relativePath === normalized);
    if (!byPath) {
      throw new Error(`Document not found: ${idOrPath}`);
    }
    return byPath;
  }

  /** The document a path-shaped reference names, or undefined when the reference
   *  is not a usable vault-relative path (traversal, absolute, over-long, …). */
  private pathMatch(
    documents: readonly MarkdownDocument[],
    reference: string
  ): MarkdownDocument | undefined {
    let normalized: string;
    try {
      normalized = toPosixPath(assertRelativePath(ensureMarkdownExtension(reference)));
    } catch {
      return undefined;
    }
    return documents.find((document) => document.relativePath === normalized);
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

    await ensurePatchStateDir(this.config.patchStateDir);
    await fs.writeFile(this.patchPath(patch.patch_id), JSON.stringify(patch, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: PATCH_STATE_FILE_MODE
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
    // INV-9: refuse to stage an update against the reserved audit subtree (early
    // reject; applyPlannedUpdate re-checks authoritatively at write time).
    await this.assertNotAuditReserved(document.relativePath, document.absolutePath);
    // INV-8: likewise for the reserved Skills subtree — a general update must not
    // rewrite an existing SKILL.md (early reject; apply re-checks at write time).
    await this.assertNotSkillReserved(document.relativePath, document.absolutePath);
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

    await ensurePatchStateDir(this.config.patchStateDir);
    await fs.writeFile(this.patchPath(patch.patch_id), JSON.stringify(patch, null, 2), {
      encoding: "utf8",
      mode: PATCH_STATE_FILE_MODE
    });
    return patch;
  }

  async applyPlannedUpdate(patchId: string): Promise<{ document: MarkdownDocument; diff: string }> {
    const patchRaw = await fs.readFile(this.patchPath(patchId), "utf8");
    const patch = JSON.parse(patchRaw) as PlannedPatch & { operation?: string };
    if (patch.operation === "document_create") {
      throw new Error("Patch is not a planned document update.");
    }
    const absolutePath = await this.resolveForExistingRead(patch.target_path);
    // INV-9: a general update must never touch the reserved audit subtree
    // (authoritative gate — this is where the actual overwrite happens).
    await this.assertNotAuditReserved(relativeToRoot(await this.root(), absolutePath), absolutePath);
    // INV-8: same authoritative gate for the reserved Skills subtree — Skills are
    // loaded as agent INSTRUCTIONS, so the only overwriting write in the codebase
    // must never be able to replace a SKILL.md / references file.
    await this.assertNotSkillReserved(relativeToRoot(await this.root(), absolutePath), absolutePath);
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
      .filter((candidate) => {
        // Root-relative / wikilink form, matched literally.
        if (
          extractAllLocalLinks(candidate.body).some(
            (link) => linkTargets.has(link) || linkTargets.has(ensureMarkdownExtension(link))
          )
        ) {
          return true;
        }
        // Markdown links are written relative to the linking note's own
        // directory, so they only match once resolved against it.
        return extractMarkdownLinks(candidate.body).some((link) => {
          const resolved = resolveRelativeLink(link, candidate.relativePath);
          return resolved !== null && ensureMarkdownExtension(resolved) === document.relativePath;
        });
      })
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
        // Derived once here, on the same cache-miss path as the parse, and
        // invalidated by the same mtime+size signature. Folding every body on
        // every query is the search path's dominant cost once megabyte-scale
        // notes (session archives) are in the vault.
        searchDerived: {
          foldedBody: normalizeForMatch(parsed.body),
          compactBody: compactWhitespace(parsed.body)
        },
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
    // INV-9 / INV-8: reject a write aimed at a reserved subtree BEFORE creating
    // any parent directories, so a rejected write never litters empty dirs.
    await this.assertNotAuditReserved(toPosixPath(safeRelative));
    await this.assertNotSkillReserved(toPosixPath(safeRelative));
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
    const target = path.join(current, path.basename(safeRelative));
    // INV-9 / INV-8 authoritative check on the resolved realpath: `current` is the
    // realpath of the target's parent, so this defeats a symlink / NFD / case
    // variant that a lexical check on the client string could miss.
    await this.assertNotAuditReserved(relativeToRoot(root, target), target);
    await this.assertNotSkillReserved(relativeToRoot(root, target), target);
    return target;
  }

  /**
   * INV-9 (audit-trail integrity): reject any GENERAL document write whose target
   * is at or inside the reserved audit subtree (MCP_AUDIT_SUBDIR). Only the
   * constrained AuditStore surface may write there, so a compromised general-write
   * session cannot forge or clobber audit files.
   */
  private async assertNotAuditReserved(targetRelativePosix: string, targetRealPath?: string): Promise<void> {
    await this.assertNotReserved(this.config.auditSubdir, auditReservedError, targetRelativePosix, targetRealPath);
  }

  /**
   * INV-8 (Skill immutability): reject any GENERAL document write whose target is
   * at or inside the reserved Skills subtree (MCP_SKILLS_SUBDIR). Skills are loaded
   * as INSTRUCTIONS by later agent sessions, so only the constrained, create-only
   * SkillStore surface (plan_skill_create → apply_planned_skill_create, which never
   * goes through KnowledgeStore) may write there. Without this, the general
   * document-write surface could overwrite an existing SKILL.md wholesale, or plant
   * a new one that bypasses SkillStore's name pattern, file allowlist and size caps.
   */
  private async assertNotSkillReserved(targetRelativePosix: string, targetRealPath?: string): Promise<void> {
    await this.assertNotReserved(this.config.skillsSubdir, skillReservedError, targetRelativePosix, targetRealPath);
  }

  /**
   * Shared reservation check for the two constrained write surfaces above. Inert
   * when the subtree is not configured. The lexical check works even before the
   * reserved directory exists; the realpath check (when it exists) neutralizes
   * symlink, NFD, and case-fold evasions.
   */
  private async assertNotReserved(
    reserved: string | undefined,
    reservedError: () => Error,
    targetRelativePosix: string,
    targetRealPath?: string
  ): Promise<void> {
    if (!reserved) {
      return;
    }
    if (posixContains(reserved, targetRelativePosix)) {
      throw reservedError();
    }
    if (!targetRealPath) {
      return;
    }
    const root = await this.root();
    let reservedReal: string;
    try {
      reservedReal = await fs.realpath(path.join(root, ...reserved.split("/")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return; // reserved subtree not created yet — the lexical check above suffices
      }
      throw error;
    }
    const relative = path.relative(reservedReal, targetRealPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw reservedError();
    }
  }

  private async validateCreateTarget(relativePath: string): Promise<string> {
    const root = await this.root();
    const safeRelative = assertRelativePath(relativePath);
    if (!safeRelative.endsWith(".md")) {
      throw new Error("Document create target must end with .md.");
    }
    // INV-9 / INV-8: an exact-path create must not target a reserved subtree
    // (early reject; resolveForWrite re-checks authoritatively at write time).
    await this.assertNotAuditReserved(toPosixPath(safeRelative));
    await this.assertNotSkillReserved(toPosixPath(safeRelative));

    const parentSegments = path
      .dirname(safeRelative)
      .split(path.sep)
      .filter((segment) => segment !== ".");
    let current = root;
    let resolvedDepth = 0;
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
        resolvedDepth += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }

    // INV-9 / INV-8 on the RESOLVED path, mirroring the authoritative check in
    // resolveForWrite. The loop above replaced every existing parent with its
    // realpath, so a reserved subtree reached through a symlink alias — invisible
    // to the lexical check on the client's string above — is caught here. Without
    // this, such a create planned successfully and was then rejected at apply
    // time, persisting a plan that could never be applied. Segments from
    // `resolvedDepth` on do not exist yet, so joining them lexically is exact.
    const resolvedTarget = path.join(current, ...parentSegments.slice(resolvedDepth), path.basename(safeRelative));
    await this.assertNotAuditReserved(relativeToRoot(root, resolvedTarget), resolvedTarget);
    await this.assertNotSkillReserved(relativeToRoot(root, resolvedTarget), resolvedTarget);

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

export function ensureMarkdownExtension(value: string): string {
  return value.endsWith(".md") ? value : `${value}.md`;
}

/** How many colliding documents an ambiguity error names before it summarizes. */
const AMBIGUOUS_REFERENCE_MAX_LISTED = 3;

/**
 * INV-2 — a reference must name exactly ONE document, or resolution fails closed.
 *
 * `readDocument` takes `document.id` verbatim from a file's own frontmatter, and
 * frontmatter is untrusted vault content (INV-5): a web clip, a note synced in
 * from elsewhere, or a file written through a constrained write surface can
 * declare another document's server-generated uuid, or another document's
 * vault-relative path. An id-first lookup then hands every caller the impostor —
 * `fetch_document`, the ChatGPT `fetch` alias, `trace_sources`, and, worst, the
 * target `plan_document_update` stages its edit against. Two-step approval
 * protects the approved CONTENT; it never protected the approved TARGET.
 *
 * Fail closed rather than prefer the path. Paths cannot be claimed by content,
 * but resolving them first would silently return a DIFFERENT document than the
 * citation carrying that id pointed at — the mis-routing that
 * `MultiRootStore.fetch`'s id-first match exists to prevent. Refusing costs no
 * reachability: the exact vault-relative path is always an unambiguous handle.
 */
export function resolveUniqueReference(
  reference: string,
  idMatches: readonly MarkdownDocument[],
  pathMatch: MarkdownDocument | undefined
): MarkdownDocument {
  const candidates = [...idMatches];
  if (pathMatch && !candidates.some((candidate) => candidate.relativePath === pathMatch.relativePath)) {
    candidates.push(pathMatch);
  }
  if (candidates.length > 1) {
    // Name the colliding documents so a genuine duplicate is fixable instead of
    // failing unexplained — relative paths only, never absolutePath, which
    // document responses deliberately omit.
    const listed = candidates.slice(0, AMBIGUOUS_REFERENCE_MAX_LISTED).map((candidate) => candidate.relativePath);
    const remaining = candidates.length - listed.length;
    throw new Error(
      `Ambiguous document reference: "${reference}" matches ${candidates.length} documents ` +
        `(${listed.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""}). ` +
        "A frontmatter id is untrusted vault content, so a colliding reference is not resolved. " +
        "Fetch by exact vault-relative path, or remove the duplicate id."
    );
  }
  return candidates[0];
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function auditReservedError(): Error {
  return new Error(
    "This path is reserved for the audit write surface (MCP_AUDIT_SUBDIR) and cannot be modified by general document writes."
  );
}

function skillReservedError(): Error {
  return new Error(
    "This path is reserved for the Skill write surface (MCP_SKILLS_SUBDIR) and cannot be created or modified by general document writes."
  );
}
