import crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { replaceFileAtomically } from "./atomicWrite.js";
import {
  assertFrontmatterPatch,
  parseMarkdown,
  parseMarkdownSafe,
  serializeMarkdown,
  titleFromMarkdown
} from "./frontmatter.js";
import { extractAllLocalLinks, extractMarkdownLinks, resolveRelativeLink } from "./markdownLinks.js";
import { ensurePatchStateDir, PATCH_STATE_FILE_MODE } from "./patchState.js";
import { compactWhitespace, normalizePathPrefix, searchDocuments, type SearchFilters } from "./search.js";
import { normalizeForMatch } from "./searchText.js";
import type { StoreConfig } from "./config.js";
import type {
  DocumentMetadata,
  ListDocumentsOptions,
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

/**
 * What the parse cache watches to decide a file is unchanged.
 *
 * `mtimeMs` + size alone was too weak in both directions that matter here:
 * millisecond mtime cannot separate two writes inside the same tick, and an
 * editor (or a sync client such as iCloud Drive) that rewrites a note to the
 * same byte length while restoring its mtime — which `utimes` lets anything do —
 * produced an identical signature over different bytes, so the stale parse was
 * served indefinitely.
 *
 * `ctimeNs` is the load-bearing addition: the inode change time moves on every
 * write and, unlike mtime, cannot be set to an arbitrary value by userspace.
 * `ino` catches the other shape — a replace-by-rename (which is how this server
 * now writes, see src/atomicWrite.ts) swaps in a different inode entirely.
 *
 * `dev` pairs with `ino` and carries a second job (INV-1). `(dev, ino)` is what
 * makes the signature an IDENTITY and not merely a freshness token: a match says
 * the path still resolves to the exact inode whose containment was verified when
 * the entry was cached, which is what lets `readDocument` skip re-resolving it.
 * `ino` alone is unique only within one filesystem, so dropping `dev` would let
 * a path re-pointed at a different device collide by inode number. The same
 * `(dev, ino)` identity argument is why `config.ts` compares roots that way
 * instead of by spelling.
 */
type StatSignature = { mtimeNs: bigint; ctimeNs: bigint; dev: bigint; ino: bigint; sizeBytes: bigint };

function statSignature(stats: BigIntStats): StatSignature {
  return { mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, dev: stats.dev, ino: stats.ino, sizeBytes: stats.size };
}

function sameSignature(a: StatSignature, b: StatSignature): boolean {
  return (
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.sizeBytes === b.sizeBytes
  );
}

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
  // Parse cache keyed by the path as handed to readDocument. Parsing every
  // Markdown file on every query is the search bottleneck for large vaults; we
  // re-parse a file only when its stat signature changes. That signature carries
  // (dev, ino), so a hit still names the same inode — but it does NOT re-prove
  // containment, which is the caller's job on every call. See readDocument.
  private readonly documentCache = new Map<string, { signature: StatSignature; document: MarkdownDocument }>();

  // Promise-chain serializer for the overwriting write path. Each apply awaits
  // the previous one settling; errors are swallowed on the chain itself so one
  // failed apply never wedges the next. Mirrors AuditStore's queue deliberately
  // — the read/modify/write window is the same shape in both.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(config: StoreConfig) {
    this.config = config;
  }

  private serializeWrite<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(op, op);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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
    // Hand the scan the same prefix the filter will apply, so a scoped search
    // stops walking subtrees whose files could only be filtered out anyway. The
    // results are unchanged by construction — the filter still runs over
    // whatever comes back.
    const documents = await this.listDocuments({ pathPrefix: normalizePathPrefix(filters.path_prefix) });
    return searchDocuments(documents, filters, this.searchDefaults());
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
  private pathMatch(documents: readonly MarkdownDocument[], reference: string): MarkdownDocument | undefined {
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
    const patchRaw = await this.readPatchFile(patchId);
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
    // Build the planned frontmatter from the bytes `expectedSha` covers, NOT
    // from `document.frontmatter` — that came through the parse cache, and a
    // stat-signature cache can only be as fresh as the signature it watches.
    // Merging the patch onto a stale parse would re-serialize the frontmatter an
    // external editor had already changed, i.e. revert it. The diff below is
    // computed against the fresh bytes, so such a revert did show up for the
    // approver; a two-step write must not depend on the reviewer catching it.
    //
    // `parseMarkdown`, NOT `parseMarkdownSafe` (INV-2: the write path throws
    // where the read path degrades). The safe variant falls back to EMPTY
    // frontmatter when a note's YAML is malformed, over the block-size cap, or
    // an expansion bomb — so planning an update against such a note would stage
    // a diff that silently deletes every field it could not parse. Read has an
    // obligation to keep returning the note; a writer has no such obligation,
    // and refusing is the only answer that cannot lose data.
    const currentMetadata = parseMarkdown(currentRaw).frontmatter;
    const newMetadata: DocumentMetadata = {
      ...currentMetadata,
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

  /**
   * Apply a staged update. Serialized against every other apply in this process:
   * the body below reads the target, hashes it, compares against the plan, and
   * only then writes. MCP pipelines concurrent tool calls within one session, so
   * two applies racing through that window can both observe a non-stale hash and
   * the second write silently discards the first — the exact lost update the
   * audit surface already serializes away (INV-9). Note the scope: this closes
   * the window WITHIN one process. Two connector processes writing the same
   * vault still race, and nothing here pretends otherwise; that needs an on-disk
   * lock and is called out in the operations docs rather than half-solved here.
   */
  async applyPlannedUpdate(patchId: string): Promise<{ document: MarkdownDocument; diff: string }> {
    return this.serializeWrite(() => this.applyPlannedUpdateSerialized(patchId));
  }

  private async applyPlannedUpdateSerialized(patchId: string): Promise<{ document: MarkdownDocument; diff: string }> {
    const patchRaw = await this.readPatchFile(patchId);
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
    // Read the bytes and the inode metadata through ONE handle, so what gets
    // re-applied to the replacement describes exactly the file that was hashed.
    const handle = await fs.open(absolutePath, "r");
    let currentRaw: string;
    let original: { mode: number; uid: number; gid: number };
    try {
      currentRaw = await handle.readFile("utf8");
      const stats = await handle.stat();
      original = { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
    } finally {
      await handle.close();
    }
    const currentSha = sha256(currentRaw);

    if (currentSha !== patch.expected_sha256) {
      throw new Error("Patch is stale: the target document changed after the plan was created.");
    }

    // Same-directory temp + rename: an interrupted apply must leave the note
    // whole (old or new), never truncated. See src/atomicWrite.ts.
    await replaceFileAtomically(absolutePath, patch.new_content, original);
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

  async listDocuments(options: ListDocumentsOptions = {}): Promise<MarkdownDocument[]> {
    const root = await this.root();
    const files = await walkMarkdownFiles(root, options);
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
    // Fast path: ONE stat, on the path exactly as given. `fs.stat` follows
    // symlinks, so a signature match says this path still resolves to the very
    // inode that was read before — see StatSignature on why (dev, ino) makes that
    // an identity claim and not merely a freshness one. The bytes handed back are
    // therefore the ones already validated, never a different file.
    //
    // ★ That is NOT the same as re-proving containment, and the difference is
    // where the guarantee lives. Move a directory out of the root and symlink it
    // back: the file's own dev, ino, ctime and mtime are all untouched — a
    // parent's rename does not move a child's ctime — so the signature matches
    // across a genuine escape. Containment is the CALLER's: `walkMarkdownFiles`
    // realpaths and containment-checks every directory it descends and every
    // symlink it meets, and `resolveForWrite` / `resolveForExistingRead` do the
    // same per call. The resolution skipped here was a second resolution of a
    // path already resolved on the same call.
    //
    // ★★ "On the same call" is not "at the same instant", and that gap is real:
    // the walk collects paths, then the reads happen. Swap a directory for an
    // escaping symlink in between and the old realpath here would have dropped
    // that document, where a cache hit now returns it. What bounds it is that a
    // hit requires the SAME (dev, ino) — so the bytes returned are always the
    // ones already validated and already cached, never a file the server had not
    // read. The window changes how long a document keeps appearing after its
    // directory leaves the vault; it cannot make a new file readable. And no
    // client-reachable write moves a directory: every write surface creates or
    // replaces files within an already-contained parent. Raised as P1 by an
    // external review on #108; the mechanism is exactly right and is why this
    // paragraph exists, but it does not carry content across the boundary.
    //
    // So the rule for anyone adding a call site: run the guard chain BEFORE
    // calling readDocument. It no longer does that for you, and a signature match
    // will not catch the difference.
    //
    // Keyed by the path as given rather than by its realpath, because that is the
    // string whose meaning has to be re-checked; two references to one file cost
    // two entries and stay independently validated.
    //
    // The cost this removes is not incidental: every read tool walks the vault
    // through listDocuments(), so the per-file realpath ran thousands of times
    // per call, and on an iCloud-backed vault the syscalls — not the bytes — are
    // what a search spends its time on.
    const cached = this.documentCache.get(absolutePath);
    if (cached) {
      // A vanished path is not an error here; let the resolution below produce
      // the failure so its message stays the one callers already handle.
      const meta = await fs.stat(absolutePath, { bigint: true }).catch(() => undefined);
      if (meta && sameSignature(cached.signature, statSignature(meta))) {
        return cached.document;
      }
    }

    const root = await this.root();
    const realPath = await fs.realpath(absolutePath);
    const relativePath = relativeToRoot(root, realPath);

    // Cache miss: read the content and stat it through a single file handle so
    // the stored mtime/size always describe exactly the bytes we parsed — a
    // separate stat() then readFile() could disagree if the file changed in
    // between (TOCTOU), caching content under a mismatched signature.
    const handle = await fs.open(realPath, "r");
    try {
      const raw = await handle.readFile("utf8");
      const stats = await handle.stat({ bigint: true });
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
        // invalidated by the same stat signature. Folding every body on every
        // query is the search path's dominant cost once megabyte-scale notes
        // (session archives) are in the vault.
        searchDerived: {
          foldedBody: normalizeForMatch(parsed.body),
          compactBody: compactWhitespace(parsed.body)
        },
        stats: {
          sizeBytes: Number(stats.size),
          modifiedAt: stats.mtime.toISOString()
        }
      };
      this.documentCache.set(absolutePath, { signature: statSignature(stats), document });
      return document;
    } finally {
      await handle.close();
    }
  }

  /**
   * Read a staged patch, turning "no such patch" into a message a caller can act
   * on. The raw ENOENT would name `<MCP_PATCH_STATE_DIR>/<uuid>.json`; the
   * boundary in src/clientSafeError.ts already stops that from reaching a client,
   * so this exists for the message, not for the containment. Both apply paths go
   * through here so the wording cannot drift between them.
   */
  private async readPatchFile(patchId: string): Promise<string> {
    try {
      return await fs.readFile(this.patchPath(patchId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("No staged patch with that patch_id: it may have already been applied.", { cause: error });
      }
      throw error;
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

/**
 * Can any file under a directory match `prefix`?
 *
 * `dirKey` is the directory's vault-relative path with a trailing separator
 * (empty at the root), so every file beneath it has a path starting with
 * `dirKey`. Two cases keep the subtree in play, and BOTH are needed:
 *
 *   * `dirKey.startsWith(prefix)` — the prefix is already satisfied by the
 *     directory itself, so everything under it matches;
 *   * `prefix.startsWith(dirKey)` — the prefix reaches deeper than this
 *     directory, so a match may still lie inside it.
 *
 * The second case is also why `path_prefix` keeps behaving as a plain string
 * prefix rather than a directory name: `05_log` reaches `05_logs/a.md`, because
 * the root's `dirKey` is `""` and the check falls through to the files.
 *
 * Erring toward `true` only costs time; erring toward `false` silently drops
 * results. The authoritative filter is still `searchDocuments`.
 */
function subtreeMayMatch(dirKey: string, prefix: string | undefined): boolean {
  return prefix === undefined || dirKey.startsWith(prefix) || prefix.startsWith(dirKey);
}

async function walkMarkdownFiles(
  root: string,
  options: ListDocumentsOptions = {},
  current: string = root,
  visited = new Set<string>()
): Promise<string[]> {
  const currentRealPath = await fs.realpath(current);
  const relativeDir = relativeToRoot(root, currentRealPath);
  // Trailing separator so a prefix comparison cannot straddle a name boundary
  // (`05_logs/` must not be reachable from a directory literally named `05_log`).
  const dirKey = relativeDir === "" ? "" : `${relativeDir}/`;

  if (!subtreeMayMatch(dirKey, options.pathPrefix)) {
    return [];
  }

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
      // Symlinks opt out of the prune. Their document path comes from the
      // realpath, which can land anywhere in the vault, so this directory's
      // position says nothing about whether the target matches — and including a
      // file the filter later drops is the harmless direction.
      //
      // Untested, and not testable from here: inside one root a symlink can only
      // point at something the walk already reaches directly (an escape is
      // rejected above, and `visited` collapses a linked directory), so the
      // opt-out never changes the result set. Kept as the correct rule rather
      // than as a verified one — noted so the next reader does not mistake the
      // green suite for coverage of this branch.
      const realPath = await fs.realpath(absolutePath);
      relativeToRoot(root, realPath);
      const stat = await fs.stat(realPath);
      if (stat.isDirectory()) {
        files.push(...(await walkMarkdownFiles(root, {}, realPath, visited)));
      } else if (stat.isFile() && realPath.endsWith(".md")) {
        files.push(realPath);
      }
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(root, options, absolutePath, visited)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      // Same NFC form relativeToRoot would produce, without paying path.relative
      // per file. Only ever used to decide whether to read the file.
      if (
        options.pathPrefix === undefined ||
        `${dirKey}${entry.name.normalize("NFC")}`.startsWith(options.pathPrefix)
      ) {
        files.push(absolutePath);
      }
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
  // Count DOCUMENTS, not list entries. `relativePath` is derived from the file's
  // real path, so entries sharing one are the same file reached twice — an
  // in-root symlink to an in-root note makes `walkMarkdownFiles` yield the target
  // under both names. Counting those as two would refuse a reference that is not
  // ambiguous at all, turning a legitimate vault layout into a self-inflicted
  // denial of service. Two genuinely different documents cannot share a relative
  // path, so this never merges a real collision.
  const byRelativePath = new Map<string, MarkdownDocument>();
  for (const match of idMatches) {
    byRelativePath.set(match.relativePath, match);
  }
  if (pathMatch) {
    byRelativePath.set(pathMatch.relativePath, pathMatch);
  }
  const candidates = [...byRelativePath.values()];
  if (candidates.length === 0) {
    // Keep the fail-closed contract inside this function rather than leaning on
    // every call site to have checked first. Both current callers only get here
    // with at least one id match, but this is exported and the skill's rule is
    // that new read paths route through the same guard — a third call site that
    // forgot the precondition would otherwise return `undefined` AS a document
    // (`noUncheckedIndexedAccess` is off, so the type would not catch it), which
    // is exactly the silent wrong answer this guard exists to prevent.
    throw new Error(`Document not found: ${reference}`);
  }
  if (candidates.length > 1) {
    // Name the colliding documents so a genuine duplicate is fixable instead of
    // failing unexplained — relative paths only, never absolutePath, which
    // document responses deliberately omit.
    //
    // Do NOT advise "retry with the exact vault-relative path". When the
    // duplicate id IS a path — the primary attack shape — that path lands on
    // this same branch and raises this same error, so the advice would name a
    // recovery that cannot work in exactly the case that most needs one.
    const listed = candidates.slice(0, AMBIGUOUS_REFERENCE_MAX_LISTED).map((candidate) => candidate.relativePath);
    const remaining = candidates.length - listed.length;
    throw new Error(
      `Ambiguous document reference: "${reference}" matches ${candidates.length} documents ` +
        `(${listed.join(", ")}${remaining > 0 ? `, +${remaining} more` : ""}). ` +
        "A frontmatter id is untrusted vault content, so a colliding reference is not resolved. " +
        "Retrying the same reference cannot disambiguate it — a duplicate id that is itself a " +
        "vault-relative path claims that path too. Use a reference no other document claims, or " +
        "remove the duplicate id."
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
