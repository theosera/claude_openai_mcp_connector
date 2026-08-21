import crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { replaceFileAtomically } from "./atomicWrite.js";
import {
  assertEmittedFrontmatterWithinLimit,
  assertFrontmatterPatch,
  parseMarkdown,
  parseMarkdownSafe,
  serializeMarkdown,
  titleFromMarkdown
} from "./frontmatter.js";
import { extractMarkdownLinks, extractWikiLinks } from "./markdownLinks.js";
import { traceThroughGraph } from "./linkGraph.js";
import { ensurePatchStateDir, PATCH_ID_PATTERN, PATCH_STATE_FILE_MODE, vaultIdentityTag } from "./patchState.js";
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
  StagedPlan,
  ProjectSummary,
  SearchDefaults,
  SearchResponse,
  TraceOptions,
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
 * Default ceiling on retained parsed text, counted in UTF-16 characters across
 * every cached body and its two derived copies.
 *
 * ⚠️ The unit is the whole point of this number, and the first value chosen for
 * it was reasoned in a different one. 24,000,000 was set against "48.3 MB on
 * disk" as the working set to stay above; what the cache actually counts is
 * `body + foldedBody + compactBody` in CHARACTERS, which on that same vault is
 * 80.9 million — 3.37x the cap. So one full scan did not fit, and because every
 * read path in this class enumerates the whole vault (`fetch` and `search` both
 * go through `listDocuments`), the entries evicted during a sweep were exactly
 * the ones the next sweep reached first. The cache did not shrink; it stopped
 * working.
 *
 * Measured on the reference vault, 2,894 notes / 48.6 MB on disk:
 *
 *     body characters                27,217,461
 *     + foldedBody + compactBody     53,675,452   (~1.97x the body)
 *     = what cacheSet counts         80,892,913
 *
 * and the cost of missing it, same vault, same probe:
 *
 *     warm full scan     91 ms  ->  689 ms
 *     search             150 ms ->  724 ms
 *     heapUsed after GC  168.6 MB -> 168.3 MB   (no reduction to show for it)
 *
 * Two lessons are baked into the value below. Characters are not bytes: CJK
 * costs three UTF-8 bytes and one character, so a disk figure understates a
 * Japanese vault's character count in one direction and the derived copies
 * overstate it in the other. And the counted total is ~3x the body, never ~1x.
 *
 * 192,000,000 keeps the reference vault whole with 2.4x of headroom, which is
 * about 116 MB of source text — past that a deployment should raise
 * MCP_DOCUMENT_CACHE_MAX_CHARS rather than discover the degradation, and the
 * first eviction now says so on stderr.
 *
 * ⚠️ What this number does NOT convert to is heap, and the tempting arithmetic
 * is wrong. Dividing one heapUsed reading (168.6 MB) by the vault's retained
 * characters suggests ~2 bytes each and so ~400 MB at this default. Measured
 * instead as a slope — same vault, same work, one process per budget, heapUsed
 * after repeated forced GC:
 *
 *     cap  1M -> 168.2 MB      cap 48M -> 168.7 MB
 *     cap 12M -> 168.1 MB      cap 96M -> 170.1 MB
 *     cap 24M -> 168.5 MB      cap 192M -> 170.1 MB
 *
 * 191 million characters of budget move retained heap by 1.9 MB, about a
 * hundredth of that estimate, and a scan retains ~160 MB whether the cache
 * keeps one note or all of them (heapUsed before any scan: 8.3 MB). So on a
 * vault this size the bound is not what governs memory — it governs whether the
 * cache works. Treat it as a safety valve for a vault far larger than the
 * reference one, which is the regime #116's synthetic measurement (16.9 MB of
 * notes, heap 7.7 -> 42.7 MB) actually describes.
 */
export const DEFAULT_DOCUMENT_CACHE_MAX_CHARS = 192_000_000;

/**
 * The reference vault's measured working set, in the unit the cache counts.
 *
 * Exported so the default above can be asserted against it rather than trusted:
 * the defect this replaces was a number that looked reasonable next to a disk
 * figure and was three times too small next to this one. A deployment larger
 * than the reference raises MCP_DOCUMENT_CACHE_MAX_CHARS; what must not happen
 * again is the default silently dropping below a vault this size.
 */
export const REFERENCE_VAULT_RETAINED_CHARS = 80_892_913;

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
 * `dev` pairs with `ino` so the identity is unique across filesystems, not only
 * within one: `ino` alone would let a path re-pointed at a different device
 * collide by inode number. It is a freshness field only. It does NOT stand in
 * for the containment check — #108 tried resting containment on `(dev, ino)` and
 * reverted, because a parent directory moved out of the root leaves every one of
 * these fields untouched (see readDocument).
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

/**
 * Filesystem entries the walk cannot reach right now: a symlink whose target is
 * gone, a directory it may not open, a path that changed type underneath it.
 *
 * The distinction this draws is the whole point of the guard it serves. The walk
 * has two failure classes that used to look identical, because both threw out of
 * the same call and aborted every read tool:
 *
 *   - the entry ESCAPES the root — `relativeToRoot` throws a plain Error with no
 *     errno, so it never matches here and keeps aborting the walk. That is INV-1
 *     failing closed, and it is the only loud signal an operator gets that the
 *     vault is misconfigured;
 *   - the entry is UNREACHABLE — an errno from the OS. Nothing about containment
 *     is in question; a synced folder moved and left a dangling link behind.
 *
 * Matching on errno rather than wrapping a `try` around the whole loop is what
 * keeps the first class loud. A catch broad enough to swallow the escape would
 * turn a containment refusal into a skipped file.
 */
const UNREACHABLE_ENTRY_CODES = new Set([
  "ENOENT", // the target is gone (a dangling symlink, or a file removed mid-walk)
  "EACCES", // not permitted to open it
  "EPERM", // the same, on platforms that report it this way
  "ELOOP", // a symlink chain that does not terminate
  // `readdir` on a path that was a directory when the parent listed it and is a
  // regular file by the time the recursion reaches it. This is the "changed type
  // underneath it" case the doc comment above always claimed to cover, and it
  // was the one errno missing from this set — the rule was written down in full
  // and implemented in part.
  "ENOTDIR"
]);

function isUnreachableEntryError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && UNREACHABLE_ENTRY_CODES.has(code);
}

/** Basename only, matching readDocumentResilient: enough to find the bad entry,
 *  not enough to disclose where the vault lives. */
function warnSkippedEntry(absolutePath: string, reason: string): void {
  process.stderr.write(`[knowledge] skipped unreachable vault entry (${reason}): ${path.basename(absolutePath)}\n`);
}

/**
 * Name the entry whose containment check failed, on stderr, and change nothing
 * else. The caller rethrows: an escape stays fatal (INV-1).
 *
 * The abort IS the signal that the vault is misconfigured — and it named
 * nothing, so in a vault of a few thousand notes the operator was told a
 * symlink escapes somewhere and left to find which one by hand. The skip path
 * beside it has printed the basename all along; only the fatal path was
 * anonymous, which is backwards, since it is the one demanding action.
 *
 * ★ stderr, and NOT the thrown message. The two have different audiences.
 * relativeToRoot's Error is server-authored, so withClientSafeErrors passes it
 * through verbatim to the MCP client, and an escaping symlink's name is an
 * entry the client cannot otherwise enumerate — the walk aborts before any
 * listing exists. Basename-only on the operator's channel gives whoever can fix
 * it everything they need and gives the client nothing new, the same split
 * readDocumentResilient already draws.
 */
function nameEscapingEntry(absolutePath: string): void {
  process.stderr.write(
    `[knowledge] vault entry escapes the knowledge root (walk aborted): ${path.basename(absolutePath)}\n`
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry ONE filesystem call through transient resource exhaustion.
 *
 * The scan already did this when READING a note (readDocumentResilient), and did
 * not do it when WALKING to find that note — so the two halves of the same scan
 * held opposite opinions about EAGAIN/EMFILE/ENFILE. The read stage waited and
 * tried again; the walk let the errno out, where it is not an unreachable-entry
 * code, so it aborted every read tool. Running the walk at `scanConcurrency`
 * over a few thousand notes is exactly the workload that produces those codes,
 * which made the disagreement an everyday failure rather than a corner.
 *
 * ★ Per SYSCALL, never per subtree. Wrapping `walkSubtree` instead looks tidier
 * and is silently wrong: `walkMarkdownFiles` adds its own realpath to `visited`
 * BEFORE it reads the directory, so a retry of the whole subtree would find its
 * own entry there and return [] — an empty result reported as a successful
 * scan. A single fs call carries no such state, so retrying one is a genuine
 * retry rather than a second call that answers differently.
 *
 * What this deliberately does NOT change is what happens when the retries run
 * out: the errno still leaves here, and a directory-level failure still aborts.
 * That asymmetry with readDocumentResilient (which skips the note) is the point
 * rather than an oversight — a skipped note is one note, named on stderr, while
 * a skipped directory is an unbounded number of them, and a search tool that
 * quietly answers from a truncated vault reports "no such note" for notes that
 * exist. Bounded under-reporting is tolerable; unbounded is not.
 */
async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFsError(error) || attempt >= SCAN_MAX_RETRIES) {
        throw error;
      }
      await delay(SCAN_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * SCAN_RETRY_BASE_MS));
    }
  }
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
  // stat signature changes. Path-containment checks still run on every access —
  // see readDocument for why that stayed after #108 tried removing it.
  private readonly documentCache = new Map<
    string,
    { signature: StatSignature; document: MarkdownDocument; chars: number }
  >();

  /** Running total of `chars` across documentCache, so the bound costs no scan. */
  private cachedChars = 0;

  /** Resolved once: the operator override or DEFAULT_DOCUMENT_CACHE_MAX_CHARS. */
  private readonly documentCacheMaxChars: number;

  /** So the "this vault does not fit" line is printed once per STORE (a sweep
   *  that overflows evicts hundreds of times), not once per process — see
   *  warnOnceAboutEviction for why a composite deliberately says it per root. */
  private warnedAboutEviction = false;

  /**
   * Read through the cache, refreshing recency on a hit.
   *
   * Map iterates in insertion order, so re-inserting on every hit makes the
   * first entry the least recently used — which is what makes the eviction
   * below an LRU rather than a "whatever happened to be parsed first" purge.
   *
   * ⚠️ Correct, and currently UNOBSERVABLE — noted so the green suite is not
   * mistaken for coverage of it. Every read path in this class enumerates the
   * whole vault (`fetch` and `search` both go through `listDocuments`, and
   * `planUpdate` goes through `fetch`), so the only access pattern that exists
   * is a full sweep in sorted-path order. Under that pattern the recency order
   * a hit produces is the same order insertion would have produced, and LRU is
   * indistinguishable from FIFO.
   *
   * Kept as the correct rule rather than a demonstrated one, because the first
   * point-read caller — `get_context` is already named in the tool budget —
   * would make the difference real, and arriving at that with FIFO eviction
   * would be a silent regression rather than a visible one.
   */
  private cacheGet(key: string): { signature: StatSignature; document: MarkdownDocument; chars: number } | undefined {
    const entry = this.documentCache.get(key);
    if (entry) {
      this.documentCache.delete(key);
      this.documentCache.set(key, entry);
    }
    return entry;
  }

  /**
   * Cache a parse, evicting least-recently-used entries until the total fits.
   *
   * The cache had no bound of any kind: no size cap, no eviction, and no delete
   * — so a note removed from the vault kept its parse alive for the life of the
   * process, and a vault simply larger than memory had no behaviour other than
   * to exhaust it. Measured on 1,000 synthetic notes totalling 16.9 MB: heap
   * went from 7.7 MB to 42.7 MB and stayed there through a forced GC, because
   * each entry holds the body plus two derived copies of it (`foldedBody`,
   * `compactBody`).
   *
   * Bounded in CHARACTERS of retained text rather than entry count, because the
   * failure mode is one large note, not many small ones — a count cap would
   * admit fifty ten-megabyte session archives and call it fifty entries. It is a
   * proxy for bytes, not a measurement of heap: V8 string representation,
   * frontmatter objects and Map overhead are all outside it. That is deliberate.
   * A cache bound that tried to track real heap would be wrong in a way nobody
   * could reason about; this one is wrong by a constant factor an operator can.
   *
   * Evicting is not free here the way it is in a cache with point reads. Every
   * read path enumerates the whole vault, so a vault whose sweep does not fit
   * evicts the front of that sweep before the next one arrives at it — the miss
   * rate goes to ~100% rather than degrading gently. That is why the first
   * eviction says so on stderr instead of quietly costing 7x per query.
   */
  private cacheSet(key: string, entry: { signature: StatSignature; document: MarkdownDocument }): void {
    const document = entry.document;
    const chars =
      document.body.length +
      (document.searchDerived?.foldedBody.length ?? 0) +
      (document.searchDerived?.compactBody.length ?? 0) +
      // Links are a small share of an entry next to the three body copies, but
      // they are retained text all the same. #116 mis-set this budget by
      // counting in a unit the cache does not use; the fix for that is to keep
      // counting everything the cache actually holds, not to decide by eye
      // which retained strings are too small to matter.
      totalLength(document.linksDerived?.wiki) +
      totalLength(document.linksDerived?.markdown);

    const existing = this.documentCache.get(key);
    if (existing) {
      this.cachedChars -= existing.chars;
      this.documentCache.delete(key);
    }
    this.documentCache.set(key, { ...entry, chars });
    this.cachedChars += chars;

    // A single note bigger than the whole budget must still be servable, so the
    // loop stops at one entry rather than evicting the note just cached.
    const limit = this.documentCacheMaxChars;
    for (const [oldestKey, oldest] of this.documentCache) {
      if (this.cachedChars <= limit || this.documentCache.size <= 1) {
        break;
      }
      if (oldestKey === key) {
        continue;
      }
      this.documentCache.delete(oldestKey);
      this.cachedChars -= oldest.chars;
      this.warnOnceAboutEviction(limit);
    }
  }

  /**
   * Say once PER STORE that this vault does not fit, because the cost is not
   * gradual.
   *
   * A bound that silently turns every query into a full re-parse is the kind of
   * cap this repo has already decided not to ship quietly: if a limit changes
   * what the work costs, it has to be visible rather than inferred from a
   * stopwatch.
   *
   * ⚠️ Per store, not per process, and that is the scope rather than an
   * oversight — an earlier draft of this promised "once per process", which the
   * code never did. `MultiRootStore` builds one store per root, each with its
   * own cache and its own budget, so two roots overflowing are two separate
   * operator problems needing two separate decisions. Deduplicating across the
   * process would drop every root after the first, which is the same
   * discoverable-only-by-stopwatch failure this line exists to prevent. What
   * that leaves to fix is telling them apart, so the line names its root.
   *
   * The name is safe to print and the path is not: `name` is an operator-chosen
   * label that already appears in every multi-root id as a `name:path` prefix,
   * while the skip-and-log rule keeps filesystem locations out of stderr. A
   * single-root deployment named nothing, so its line stays unqualified.
   */
  private warnOnceAboutEviction(limit: number): void {
    if (this.warnedAboutEviction) {
      return;
    }
    this.warnedAboutEviction = true;
    const which = this.config.rootName ? ` for root "${this.config.rootName}"` : "";
    process.stderr.write(
      `[knowledge] parse cache is smaller than this vault's working set${which} ` +
        `(cap ${limit} characters), so scans will re-parse. ` +
        `Raise MCP_DOCUMENT_CACHE_MAX_CHARS if this process has the memory.\n`
    );
  }

  // Promise-chain serializer for the overwriting write path. Each apply awaits
  // the previous one settling; errors are swallowed on the chain itself so one
  // failed apply never wedges the next. Mirrors AuditStore's queue deliberately
  // — the read/modify/write window is the same shape in both.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(config: StoreConfig) {
    this.config = config;
    this.documentCacheMaxChars = config.documentCacheMaxChars ?? DEFAULT_DOCUMENT_CACHE_MAX_CHARS;
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
    // Before the target is validated, for the reason given in `planUpdate`. A
    // create has no stale-content check at apply, so a plan tagged for a vault it
    // was not derived against simply publishes there.
    const vaultId = await this.vaultId();
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
    await this.assertVaultUnchangedWhilePlanning(vaultId);
    // vault_id is added HERE, not on `patch`: it belongs in the file the apply
    // reads, and not in the record handed back to the client (see StagedPlan).
    const staged: StagedPlan<typeof patch> = { ...patch, vault_id: vaultId };
    await fs.writeFile(this.patchPath(patch.patch_id), JSON.stringify(staged, null, 2), {
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
    const patch = JSON.parse(patchRaw) as Partial<PlannedDocumentCreate> & { vault_id?: string };
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
    // Same crossing as applyPlannedUpdate, and checked here for the same reason:
    // `target_path` is vault-relative, so a plan staged elsewhere would create
    // the note inside THIS root (INV-3). The confirmed-path check below cannot
    // catch it — the user confirms a vault-relative path, which matches in both
    // vaults.
    await this.assertPlanStagedForThisVault(patch.vault_id);

    const confirmedPath = toPosixPath(assertRelativePath(confirmedTargetPath));
    if (confirmedPath !== patch.target_path) {
      throw new Error("Confirmed target path does not match the planned document target.");
    }

    // Re-asserted on the STAGED bytes, not just when they were built. A plan
    // carries content serialized in an earlier call — possibly by an earlier
    // build of this server, since nothing expires a plan — so the plan-time
    // check in serializeMarkdown cannot speak for what is written here.
    assertEmittedFrontmatterWithinLimit(patch.new_content);
    const absolutePath = await this.resolveForWrite(await this.validateCreateTarget(patch.target_path));
    // Again, immediately before the write: the check above ran before the target
    // was resolved, and resolution walks the pathname afresh. See the note on
    // `assertPlanStagedForThisVault` for what this narrows and what it cannot.
    await this.assertPlanStagedForThisVault(patch.vault_id);
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
    // Captured BEFORE anything is read, and re-checked before the plan is
    // persisted. Deriving first and tagging afterwards lets a root replaced in
    // between produce a plan whose CONTENT came from the old vault and whose tag
    // names the new one — every apply-time check then passes. See
    // `assertVaultUnchangedWhilePlanning`.
    const vaultId = await this.vaultId();
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
    await this.assertVaultUnchangedWhilePlanning(vaultId);
    // vault_id is added HERE, not on `patch`: it belongs in the file the apply
    // reads, and not in the record handed back to the client (see StagedPlan).
    const staged: StagedPlan<typeof patch> = { ...patch, vault_id: vaultId };
    await fs.writeFile(this.patchPath(patch.patch_id), JSON.stringify(staged, null, 2), {
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
    const patch = JSON.parse(patchRaw) as PlannedPatch & { operation?: string; vault_id?: string };
    if (patch.operation === "document_create") {
      throw new Error("Patch is not a planned document update.");
    }
    // Before the target is resolved, because resolution is the crossing: the
    // path is vault-relative and this store would happily resolve it inside
    // whichever root it was started against (INV-3).
    await this.assertPlanStagedForThisVault(patch.vault_id);
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

    // As in applyPlannedDocumentCreate: the staged bytes are re-checked here,
    // because this is the authoritative gate and the plan-time one is only an
    // early refusal. INV-9 draws that line the same way for the audit surface.
    assertEmittedFrontmatterWithinLimit(patch.new_content);
    // Again, immediately before the write. Between the check at the top and this
    // line the target was resolved, read and hashed, all by pathname — see the
    // note on `assertPlanStagedForThisVault`.
    await this.assertPlanStagedForThisVault(patch.vault_id);
    // Same-directory temp + rename: an interrupted apply must leave the note
    // whole (old or new), never truncated. See src/atomicWrite.ts.
    await replaceFileAtomically(absolutePath, patch.new_content, original);
    await fs.unlink(this.patchPath(patchId));
    return {
      document: await this.readDocument(absolutePath),
      diff: patch.diff
    };
  }

  async traceSources(idOrPath: string, options: TraceOptions = {}): Promise<TraceResult> {
    const document = await this.fetch(idOrPath);
    // Unprefixed on purpose: a backlink set computed over a narrowed listing is
    // wrong rather than merely short. See the header of src/linkGraph.ts.
    const documents = await this.listDocuments();
    return traceThroughGraph(document, documents, options);
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
    // ★ Containment is re-proven HERE, on every read, before the cache is even
    // consulted. It is tempting to skip it — the callers (walkMarkdownFiles,
    // resolveForWrite, resolveForExistingRead) all run the guard chain on the
    // same call, so this looks like a second resolution of a resolved path, and
    // dropping it removes thousands of realpath calls per tool call on a vault
    // where syscalls, not bytes, are the entire cost.
    //
    // It was tried on #108 and reverted, so the reason is recorded rather than
    // rediscovered: "validated on the same call" is not "validated at the same
    // instant". The walk collects paths and the reads happen afterwards. Move a
    // directory out of the root in that window and symlink it back, and the
    // child file's own dev, ino, ctime and mtime are ALL untouched — a parent's
    // rename does not move a child's ctime — so a stat-signature check matches
    // across a genuine escape and returns Markdown for a path that no longer
    // resolves inside KNOWLEDGE_ROOT. Two independent reviewers found it.
    //
    // The bytes served in that window are ones the server had already validated
    // and cached, so nothing new is disclosed — but INV-1 says every file access
    // stays under the root, and "true except during a window" is a weaker
    // invariant than the one this repo committed to. Closing the window properly
    // needs fd-based containment (openat / O_NOFOLLOW per component) that Node
    // does not portably expose; until that exists, the cheap check stays.
    const root = await this.root();
    const realPath = await fs.realpath(absolutePath);
    const relativePath = relativeToRoot(root, realPath);

    // Fast path: a pure metadata stat decides cache validity (see StatSignature).
    const cached = this.cacheGet(realPath);
    if (cached) {
      const meta = await fs.stat(realPath, { bigint: true });
      if (sameSignature(cached.signature, statSignature(meta))) {
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
        // Same deal for links, and for the same reason: trace_sources extracts
        // from every note in the vault on every call, so the extractors were
        // running over the whole corpus per request. Rides this cache's stat
        // signature rather than adding a second one to keep fresh.
        linksDerived: {
          wiki: extractWikiLinks(parsed.body),
          markdown: extractMarkdownLinks(parsed.body)
        },
        stats: {
          sizeBytes: Number(stats.size),
          modifiedAt: stats.mtime.toISOString()
        }
      };
      this.cacheSet(realPath, { signature: statSignature(stats), document });
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

  /** This store's vault identity, as recorded in a staged plan (INV-3). */
  private async vaultId(): Promise<string> {
    // The RESOLVED root, not the configured spelling. Hashing the spelling ties
    // the tag to a string the operator controls rather than to the directory the
    // writes land in, and those come apart in the direction that matters: a
    // symlinked KNOWLEDGE_ROOT retargeted at another vault keeps its spelling,
    // so a plan staged before the change carries a tag this check still accepts
    // — while `this.root()`, re-resolved at each init, now points somewhere else
    // and is what every target below is resolved against. Byte-identical content
    // at the same relative path also carries the stale check, so nothing else in
    // the apply path notices.
    //
    // It fixes the harmless direction too: one vault reached through a symlink
    // today and by its own path tomorrow resolves to the same realpath, so its
    // staged plans keep matching. An earlier version of this comment claimed
    // resolving would BREAK that case, which had it exactly backwards — not
    // resolving is what makes two spellings of one vault read as two vaults.
    //
    // `defaultPatchStateDir` still hashes the configured spelling, because it
    // runs in `loadConfig` before anything guarantees the directory exists and
    // `realpath` needs it to. The two tags are therefore allowed to differ; the
    // directory name only has to be stable and per-vault, while this one has to
    // say which vault the writes went to. Raised as a P1 by Codex on #142.
    //
    // The resolved path is still not the whole identity — the directory AT that
    // path can be replaced — so `vaultIdentityTag` adds `(dev, ino)`. Its header
    // carries that reasoning and the cost that comes with it.
    return vaultIdentityTag(await this.root());
  }

  /**
   * Refuse a plan staged for a different vault, or one that does not say (INV-3).
   *
   * An unrecorded plan is REJECTED, not warned about. The obvious argument for
   * warning — "the seven-day sweep drains them anyway" — is false: the sweep is
   * staging-driven, and `patchState.ts` says outright that a server which stays
   * up and stages nothing more never sweeps again. A window that does not close
   * on its own is a reason to reject, because a warning would need an end date
   * and there is none.
   *
   * Neither message names a path or a root. The tags are opaque by construction
   * and the client has no use for them beyond "these two differ".
   *
   * ⚠️ **Called TWICE per apply, and the second call is not redundant.** This
   * check stats the root; everything after it — target validation, resolution,
   * the stale read — walks the pathname again, so a directory swapped in that
   * window is verified in its old incarnation and written in its new one. Codex
   * raised that as a fourth P1 on #142. Calling it again immediately before the
   * mutation narrows the window from "check → validate → resolve → read → hash →
   * write" to "check → write".
   *
   * ⚠️ **It does not close it, and no arrangement of stats can.** Closing it
   * needs the write anchored to the directory that was verified — fd-based
   * containment, `openat` with `O_NOFOLLOW` per component — which Node does not
   * expose portably. `src/knowledgeStore.ts`'s `readDocument` records the same
   * wall for INV-1 and reaches the same conclusion: keep the cheap check, and do
   * not describe it as containment. The residual is a ROADMAP item.
   */
  /**
   * Refuse to STAGE a plan whose vault changed while it was being derived.
   *
   * The apply-side check answers "is this the vault the plan was staged for".
   * It cannot answer "is this the vault the plan was derived FROM", because a
   * root replaced between the read and the tag produces a plan that truthfully
   * names the replacement while carrying content from its predecessor — and
   * every apply-time check then passes. An update needs the replacement to hold
   * byte-identical content at the same path; a create needs nothing at all.
   * Raised as a fifth P1 by Codex on #142, and distinct from the apply-side
   * window: this one opens before the identity is captured.
   *
   * Same shape as the apply side, and the same limit: capture first, verify
   * before persisting, and do not call it closed. A replacement landing between
   * this check and the write of the plan file still slips through, for the
   * fd-containment reason `assertPlanStagedForThisVault` records.
   */
  private async assertVaultUnchangedWhilePlanning(capturedVaultId: string): Promise<void> {
    if (capturedVaultId !== (await this.vaultId())) {
      throw new Error(
        "The vault changed while this plan was being prepared, so nothing was staged. " +
          "Re-plan the change against this server."
      );
    }
  }

  private async assertPlanStagedForThisVault(planVaultId: string | undefined): Promise<void> {
    if (!planVaultId) {
      throw new Error(
        "Plan does not record which vault it was staged for, so it cannot be applied. " +
          "Re-plan the change against this server."
      );
    }
    if (planVaultId !== (await this.vaultId())) {
      throw new Error(
        "Plan was staged for a different vault and will not be applied here. " +
          "Re-plan the change against this server."
      );
    }
  }

  private patchPath(patchId: string): string {
    if (!PATCH_ID_PATTERN.test(patchId)) {
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

/**
 * Descend into a subtree, skipping it whole if it cannot be read.
 *
 * Only reachable from a PARENT directory's entry loop, never for the root — a
 * root that cannot be read is a configuration error and must keep throwing, not
 * quietly serve an empty vault.
 *
 * Containment failures are not caught here (see isUnreachableEntryError): a
 * symlink escape found several levels down still aborts the whole walk.
 */
async function walkSubtree(
  root: string,
  options: ListDocumentsOptions,
  dir: string,
  visited: Set<string>
): Promise<string[]> {
  try {
    return await walkMarkdownFiles(root, options, dir, visited);
  } catch (error) {
    if (!isUnreachableEntryError(error)) {
      throw error;
    }
    warnSkippedEntry(dir, "unreadable directory");
    return [];
  }
}

async function walkMarkdownFiles(
  root: string,
  options: ListDocumentsOptions = {},
  current: string = root,
  visited = new Set<string>()
): Promise<string[]> {
  const currentRealPath = await withTransientRetry(() => fs.realpath(current));
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

  const entries = await withTransientRetry(() => fs.readdir(current, { withFileTypes: true }));
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
      //
      // Resolved before the `.md` test, so a dangling link to an ATTACHMENT used
      // to abort every read tool just as surely as one to a note. That is the
      // everyday shape: a synced folder (iCloud, Dropbox) or a moved directory
      // leaves broken links behind, and none of it is a containment question.
      let realPath: string;
      try {
        realPath = await withTransientRetry(() => fs.realpath(absolutePath));
      } catch (error) {
        if (!isUnreachableEntryError(error)) {
          throw error;
        }
        warnSkippedEntry(absolutePath, "broken symlink");
        continue;
      }
      // OUTSIDE the try, and it must stay there: this is the containment check,
      // and it throws a plain Error, so widening either catch to cover it would
      // silently downgrade an INV-1 refusal into a skipped entry.
      //
      // The catch below is NOT such a widening and must never become one: it has
      // no condition and cannot acquire one. It exists only so the abort names
      // the entry that caused it — see nameEscapingEntry.
      try {
        relativeToRoot(root, realPath);
      } catch (error) {
        nameEscapingEntry(absolutePath);
        throw error;
      }
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await withTransientRetry(() => fs.stat(realPath));
      } catch (error) {
        if (!isUnreachableEntryError(error)) {
          throw error;
        }
        warnSkippedEntry(absolutePath, "unreadable symlink target");
        continue;
      }
      if (stat.isDirectory()) {
        files.push(...(await walkSubtree(root, {}, realPath, visited)));
      } else if (stat.isFile() && realPath.endsWith(".md")) {
        files.push(realPath);
      }
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await walkSubtree(root, options, absolutePath, visited)));
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

/** Characters held across a list of strings — what the cache budget counts. */
function totalLength(values: readonly string[] | undefined): number {
  let total = 0;
  for (const value of values ?? []) {
    total += value.length;
  }
  return total;
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
