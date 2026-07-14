import path from "node:path";
import { KnowledgeStore } from "./knowledgeStore.js";
import { extractAllLocalLinks } from "./markdownLinks.js";
import { searchDocuments, type SearchFilters } from "./search.js";
import type { AppConfig } from "./config.js";
import type {
  CreateDocumentInput,
  MarkdownDocument,
  PlanUpdateInput,
  PlannedPatch,
  ProjectSummary,
  SearchResult,
  TraceResult,
  VaultStore
} from "./types.js";

/**
 * Composite store over several named knowledge roots (KNOWLEDGE_ROOTS).
 *
 * Security model: every root is served by its own unmodified KnowledgeStore, so
 * the full path-containment guard chain (INV-1) applies per root — this class
 * never touches the filesystem itself. Reads (search / fetch / list / trace)
 * span all roots; documents from every root are addressed as
 * `<rootName>:<relativePath>`. Writes (create / plan / apply) are routed to the
 * PRIMARY (first) root only — every other root is strictly read-only, and a
 * write addressed to a non-primary root fails closed.
 */
export class MultiRootStore implements VaultStore {
  private readonly entries: Array<{ name: string; store: KnowledgeStore }>;

  constructor(config: AppConfig) {
    this.entries = config.knowledgeRoots.map((root) => ({
      name: root.name,
      store: new KnowledgeStore({
        knowledgeRoot: root.path,
        writeMode: config.writeMode,
        patchStateDir: config.patchStateDir,
        scanConcurrency: config.scanConcurrency
      })
    }));
  }

  private get primary(): { name: string; store: KnowledgeStore } {
    return this.entries[0];
  }

  async init(): Promise<void> {
    for (const entry of this.entries) {
      await entry.store.init();
    }
    // Overlapping roots would list the same file twice under two identities
    // (and could route a "read-only" document through the writable root), so
    // nesting or duplication is a hard configuration error.
    const realPaths = await Promise.all(this.entries.map((entry) => entry.store.rootPath()));
    for (let a = 0; a < realPaths.length; a += 1) {
      for (let b = a + 1; b < realPaths.length; b += 1) {
        if (isSameOrInside(realPaths[a], realPaths[b]) || isSameOrInside(realPaths[b], realPaths[a])) {
          throw new Error(
            `Knowledge roots "${this.entries[a].name}" and "${this.entries[b].name}" overlap. Roots must be disjoint directories.`
          );
        }
      }
    }
  }

  async search(filters: SearchFilters): Promise<SearchResult[]> {
    // Rank across ALL roots in one pass so the limit applies globally.
    return searchDocuments(await this.listDocuments(), filters);
  }

  async listDocuments(): Promise<MarkdownDocument[]> {
    const perRoot = await Promise.all(
      this.entries.map(async (entry) =>
        (await entry.store.listDocuments()).map((document) => this.wrap(entry.name, document))
      )
    );
    return perRoot.flat();
  }

  async fetch(idOrPath: string): Promise<MarkdownDocument> {
    // An id that search emitted always equals a wrapped document's id exactly,
    // so match that first — before treating a `<name>:` prefix as routing. A
    // user-controlled frontmatter id like `id: "ops:secret"` (where "ops" also
    // names a root) is left un-prefixed by wrap(), so without this check
    // resolveRef would mis-route it into the "ops" root and return a DIFFERENT
    // document (or nothing) than the one the citation points at.
    const documents = await this.listDocuments();
    const byId = documents.find((document) => document.id === idOrPath);
    if (byId) {
      return byId;
    }

    const { entry, rest } = this.resolveRef(idOrPath);
    if (entry) {
      return this.wrap(entry.name, await entry.store.fetch(rest));
    }
    // Unprefixed reference: primary root wins, then the others in order.
    let firstError: unknown;
    for (const candidate of this.entries) {
      try {
        return this.wrap(candidate.name, await candidate.store.fetch(idOrPath));
      } catch (error) {
        firstError ??= error;
      }
    }
    throw firstError ?? new Error(`Document not found: ${idOrPath}`);
  }

  async listProjects(client?: string, tags?: string[]): Promise<ProjectSummary[]> {
    const grouped = new Map<string, ProjectSummary>();
    for (const entry of this.entries) {
      for (const summary of await entry.store.listProjects(client, tags)) {
        const key = `${summary.client}\0${summary.project}`;
        const current = grouped.get(key);
        if (!current) {
          grouped.set(key, { ...summary });
        } else {
          current.count += summary.count;
          if (summary.latestModifiedAt > current.latestModifiedAt) {
            current.latestModifiedAt = summary.latestModifiedAt;
          }
        }
      }
    }
    return [...grouped.values()].sort((a, b) => a.client.localeCompare(b.client) || a.project.localeCompare(b.project));
  }

  async createDocument(input: CreateDocumentInput): Promise<MarkdownDocument> {
    return this.wrap(this.primary.name, await this.primary.store.createDocument(input));
  }

  async planUpdate(input: PlanUpdateInput): Promise<PlannedPatch> {
    const reference = this.resolveWritableRef(input.id_or_path);
    return this.primary.store.planUpdate({ ...input, id_or_path: reference });
  }

  async applyPlannedUpdate(patchId: string): Promise<{ document: MarkdownDocument; diff: string }> {
    // Plans are only ever created against the primary root (see planUpdate),
    // so applying resolves target_path inside the primary root as well.
    const result = await this.primary.store.applyPlannedUpdate(patchId);
    return { document: this.wrap(this.primary.name, result.document), diff: result.diff };
  }

  async traceSources(idOrPath: string): Promise<TraceResult> {
    // Backlinks must be computed across ALL roots (a note in one root may
    // reference `<root>:<path>` documents in another), so this cannot delegate
    // to a single child store — scan the composite document list instead.
    const document = await this.fetch(idOrPath);
    const documents = await this.listDocuments();

    const prefixedPath = document.relativePath; // `<rootName>:<relativePath>`
    const unprefixedPath = prefixedPath.slice(prefixedPath.indexOf(":") + 1);
    // Cross-root references carry the root prefix; same-root references use the
    // plain relative path as stored on disk. Titles match from any root.
    const crossRootTargets = new Set([prefixedPath, prefixedPath.replace(/\.md$/i, ""), document.title]);
    const sameRootTargets = new Set([unprefixedPath, unprefixedPath.replace(/\.md$/i, "")]);
    const matchesTarget = (candidate: MarkdownDocument, link: string): boolean => {
      const withExtension = link.endsWith(".md") ? link : `${link}.md`;
      if (crossRootTargets.has(link) || crossRootTargets.has(withExtension)) {
        return true;
      }
      return candidate.root === document.root && (sameRootTargets.has(link) || sameRootTargets.has(withExtension));
    };

    const backlinks = documents
      .filter((candidate) => candidate.relativePath !== document.relativePath)
      .filter((candidate) => extractAllLocalLinks(candidate.body).some((link) => matchesTarget(candidate, link)))
      .map((candidate) => ({ id: candidate.id, relativePath: candidate.relativePath, title: candidate.title }));

    return {
      document: { id: document.id, relativePath: document.relativePath, title: document.title },
      source_refs: document.frontmatter.source_refs ?? [],
      outgoing_links: extractAllLocalLinks(document.body),
      backlinks
    };
  }

  /** Split a `<rootName>:` prefix off a reference when it names a known root. */
  private resolveRef(reference: string): { entry?: { name: string; store: KnowledgeStore }; rest: string } {
    const separator = reference.indexOf(":");
    if (separator > 0) {
      const name = reference.slice(0, separator);
      const entry = this.entries.find((candidate) => candidate.name === name);
      if (entry) {
        return { entry, rest: reference.slice(separator + 1) };
      }
    }
    return { rest: reference };
  }

  /** Writes may only ever address the primary root — fail closed otherwise. */
  private resolveWritableRef(reference: string): string {
    const { entry, rest } = this.resolveRef(reference);
    if (!entry) {
      // Unprefixed: delegate as-is. The primary store can only resolve
      // documents inside its own root, so read-only roots stay unreachable.
      return reference;
    }
    if (entry !== this.primary) {
      throw new Error(
        `Root "${entry.name}" is read-only. Writes are allowed only on the primary root "${this.primary.name}".`
      );
    }
    return rest;
  }

  /** Re-address a document under its root: `<rootName>:<relativePath>`. A
   *  frontmatter id stays untouched (already unique); a path-derived id is
   *  prefixed alongside the path so it round-trips through fetch. */
  private wrap(rootName: string, document: MarkdownDocument): MarkdownDocument {
    const prefixedPath = `${rootName}:${document.relativePath}`;
    return {
      ...document,
      root: rootName,
      relativePath: prefixedPath,
      id: document.id === document.relativePath ? prefixedPath : document.id
    };
  }
}

/** Build the store matching the configuration: plain single-root KnowledgeStore
 *  (fully backward compatible — no prefixes) or the multi-root composite. */
export function createStore(config: AppConfig): VaultStore {
  if (config.knowledgeRoots.length === 1) {
    return new KnowledgeStore({
      knowledgeRoot: config.knowledgeRoots[0].path,
      writeMode: config.writeMode,
      patchStateDir: config.patchStateDir,
      scanConcurrency: config.scanConcurrency
    });
  }
  return new MultiRootStore(config);
}

function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
