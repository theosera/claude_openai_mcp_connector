/**
 * The vault's link graph, built from documents the store already enumerated.
 *
 * This module never touches `fs`. It is handed the output of an **unprefixed**
 * `listDocuments()` and does pure string work on it, so INV-1 containment is
 * inherited from the store rather than re-implemented here — the same reason
 * `markdownLinks.ts` resolves relative links as string math and compares the
 * result against enumerated paths instead of asking the filesystem.
 *
 * ⚠️ **Never build this from a `pathPrefix`-narrowed listing.** `#108` added the
 * prefix argument, and only `search` passes it. A backlink set computed over a
 * subset of the vault is not "smaller", it is **wrong** — the same reason
 * `fetch` / `trace_sources` / `list_projects` were left scanning whole.
 *
 * ⚠️ **"Unprefixed" is the widest listing the store offers, which is not the
 * same as a complete one — and this module cannot currently tell the two
 * apart.** Since `#114` the walk skips entries it cannot reach (broken symlink,
 * unreadable directory, and the permanent read failures `readDocumentResilient`
 * drops) and carries on; each writes a line to stderr, and **nothing in the
 * return value says it happened**. So the sentence above states the rule
 * correctly while the input it is given only approximates the premise.
 *
 * That is recorded rather than papered over, and deliberately not "fixed" here:
 *
 * - **Failing closed on a partial listing is not this module's call to make.**
 *   It would restore exactly what `#114` removed — one unreachable entry taking
 *   down every trace in the vault. Degrading is the behaviour that decision
 *   bought, and a graph is a weaker reason to reverse it than a read plane was
 *   to establish it.
 * - **The missing piece is a completeness signal on `listDocuments()`**, which
 *   is a `VaultStore` change touching every caller — a different boundary from
 *   this one. Until it exists, an operator sees the skips and a client does not.
 *
 * One corner of it IS closed, in `traceThroughGraph` rather than here: when the
 * skipped entry is the note being traced, the answer was not merely incomplete
 * but wrong — "this note writes no links", about a document the same call had
 * just fetched. That falls back to the fetched copy. Everything else stands: a
 * backlink missing because some OTHER note was skipped is still invisible, and
 * this module still cannot tell a short listing from a complete one.
 *
 * What this does NOT license is treating an unreachable skip as equivalent to a
 * prefix exclusion. A prefix is chosen by the caller and knowable to it; a skip
 * is neither. It is also not a new capability for an attacker — anyone able to
 * chmod a note or swap it for a dangling symlink can already edit its links —
 * but it does mean a missing backlink can come from the filesystem rather than
 * from the vault's text, and nothing in the response distinguishes those.
 *
 * ## Nodes are keyed by path, not by frontmatter `id`
 *
 * The D-4 sketch names the accessors `outgoing(id)` / `incoming(id)`, but the
 * key here is the vault-relative path (`<root>:<path>` in multi-root mode).
 * `MarkdownDocument.id` comes verbatim from frontmatter, which is untrusted
 * vault content: INV-2 already refuses to resolve a reference when two notes
 * claim the same `id`, precisely because a note can declare another note's
 * identity. Keying a graph on that field would let one note collapse or
 * redirect another note's edges. Paths are server-owned — a note cannot rename
 * its own file — which is the identical argument P2-D0 uses to keep `title` and
 * `aliases` out of link resolution.
 *
 * ## Resolution rules (P2-D0 — path facts only)
 *
 * A link resolves on evidence the note cannot author about itself:
 *
 *   1. An explicit `<root>:<path>` reference, when the prefix names a configured
 *      knowledge root (root names come from config, never from note content).
 *   2. Markdown links — resolved against the linking note's own directory, with
 *      `±.md` completion. A link that climbs out of the root stays unresolved.
 *   3. Wikilinks — the exact root-relative path first, then the link text as a
 *      **name** (basename). Both halves are path facts.
 *
 * Frontmatter `title` / `aliases` only ever produce `candidates[]`, **even when
 * the match is unique**: uniqueness is decided by attacker-writable data, so one
 * planted note makes "unique" mean nothing. This is INV-2's ruling about `id`
 * applied to the other self-declared fields.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - Leg 3's name lookup uses the **whole link text**, so a folder-qualified
 *   `[[projects/a/note]]` whose path does not exist does not silently retarget
 *   some other folder's `note.md`. That is what makes the exact-path leg
 *   load-bearing when a basename collides, instead of decorative.
 * - Matching is exact, not case-folded. Paths elsewhere in this server compare
 *   exactly (NFC-normalized), and the measured −91% backlink figure behind
 *   P2-D0 was taken under exact matching; case-folding here would both diverge
 *   from that measurement and re-introduce ambiguity the path legs exist to
 *   avoid.
 *
 * ## Scoping in multi-root deployments
 *
 * Each knowledge root is a separate vault. Implicit forms (relative Markdown
 * links, bare wikilinks, name/title/alias lookups) resolve **within the linking
 * note's own root**; only the explicit `<root>:` form crosses a boundary. An
 * operator who declared two roots drew that line deliberately, and guessing an
 * edge across it would invent provenance rather than report it.
 */

import type {
  LinkCandidate,
  LinkGraphNodeRef,
  MarkdownDocument,
  RelatedNode,
  ResolvedOutgoingLink,
  TraceResult
} from "./types.js";
import { extractMarkdownLinks, extractWikiLinks, resolveRelativeLink } from "./markdownLinks.js";

/**
 * Traversal bounds (D-4). Exported so tests pin the numbers rather than
 * re-declaring them, and so a caller can tighten — never widen — them.
 */
export const MAX_LINK_GRAPH_DEPTH = 2;
/** Ceiling on how many nodes a single `neighbors()` walk may return. */
export const MAX_RELATED_NODES = 50;
/** Ceiling on how many neighbours one node contributes when expanded. */
export const MAX_EXPANSION_FANOUT = 20;
/**
 * Above this degree a node is a hub (a MOC / index note). Hubs are still
 * returned as neighbours — they are genuinely related — but the walk does not
 * expand THROUGH them, which is what stops one index note from pulling the
 * whole vault into a depth-2 answer.
 */
export const HUB_DEGREE_THRESHOLD = 30;

export type LinkDirection = "out" | "in" | "both";

export interface NeighborOptions {
  depth?: number;
  direction?: LinkDirection;
  nodeCap?: number;
  fanoutCap?: number;
  hubThreshold?: number;
}

interface GraphNode {
  /** Vault-relative path as listed — `<root>:<path>` in multi-root mode. */
  key: string;
  id: string;
  title: string;
  root?: string;
  /** Path within its own root, i.e. `key` without any `<root>:` prefix. */
  localPath: string;
  /** Filesystem mtime, used to order expansion recent-first. */
  modifiedAt: string;
}

/** Drop one trailing `.md` so index keys and lookups meet in the middle. */
function stripMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, "");
}

/**
 * The single form every path-shaped index key and lookup is built in.
 *
 * Enumerated paths arrive NFC-canonical (`relativeToRoot`), and an editor on a
 * decomposing filesystem writes the same name decomposed — so matching raw link
 * text against them misses a canonically identical file. `resolveRelativeLink`
 * already normalizes, which is precisely why doing it only there was worse than
 * not doing it at all: the same non-ASCII target resolved as a Markdown link and
 * missed as a wikilink, on macOS, which is this project's primary deployment.
 *
 * NFC, not the search path's NFKC: half-width and full-width names are
 * genuinely different files, and these keys stand in for real ones.
 */
function lookupForm(value: string): string {
  return stripMarkdownExtension(value).normalize("NFC");
}

function localPathOf(document: MarkdownDocument): string {
  if (!document.root) {
    return document.relativePath;
  }
  const separator = document.relativePath.indexOf(":");
  return separator >= 0 ? document.relativePath.slice(separator + 1) : document.relativePath;
}

function basenameOf(localPath: string): string {
  const slash = localPath.lastIndexOf("/");
  return slash >= 0 ? localPath.slice(slash + 1) : localPath;
}

/**
 * Index key that keeps each root's implicit namespace to itself.
 *
 * NUL as the separator, written as an escape rather than a literal: a root name
 * or a path containing the delimiter would otherwise let `("a b", "c")` and
 * `("a", "b c")` collide into one key, and NUL is the one byte neither can
 * hold — `pathSafety` rejects control characters outright, and root names come
 * from configuration. (The literal byte belongs nowhere near source: it makes
 * git classify the file as binary, which silently costs every diff and review
 * on it.)
 */
function scoped(root: string | undefined, value: string): string {
  return `${root ?? ""}\u0000${value}`;
}

/**
 * Frontmatter `aliases`, tolerating the two shapes editors write (a string or a
 * list of them) and ignoring anything else. Never a resolution key — only a
 * candidate source — so a malformed value costs nothing but a missing hint.
 */
function aliasesOf(document: MarkdownDocument): string[] {
  const raw = document.frontmatter.aliases;
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function pushInto<T>(index: Map<string, T[]>, key: string, value: T): void {
  const existing = index.get(key);
  if (existing) {
    existing.push(value);
  } else {
    index.set(key, [value]);
  }
}

export interface LinkGraph {
  /** Every local link the note writes, each labelled resolved or not. */
  outgoing(key: string): ResolvedOutgoingLink[];
  /** Notes whose links resolve TO this one. Complete — never capped. */
  incoming(key: string): LinkGraphNodeRef[];
  /** Bounded neighbourhood walk. See the bound constants above. */
  neighbors(key: string, options?: NeighborOptions): RelatedNode[];
  /** Whether the graph knows this path at all. */
  has(key: string): boolean;
}

class MarkdownLinkGraph implements LinkGraph {
  private readonly nodes = new Map<string, GraphNode>();
  /** `<root>:<path>` → node. Populated in multi-root mode only, which is what
   *  keeps the explicit cross-root leg inert on a single-root vault. */
  private readonly byPrefixedPath = new Map<string, GraphNode>();
  private readonly byLocalPath = new Map<string, GraphNode>();
  private readonly byName = new Map<string, GraphNode[]>();
  private readonly byTitle = new Map<string, GraphNode[]>();
  private readonly byAlias = new Map<string, GraphNode[]>();

  private readonly outgoingLinks = new Map<string, ResolvedOutgoingLink[]>();
  private readonly outNeighbours = new Map<string, GraphNode[]>();
  private readonly inNeighbours = new Map<string, GraphNode[]>();

  constructor(documents: readonly MarkdownDocument[]) {
    for (const document of documents) {
      const node: GraphNode = {
        key: document.relativePath,
        id: document.id,
        title: document.title,
        root: document.root,
        localPath: localPathOf(document),
        modifiedAt: document.stats.modifiedAt
      };
      // A duplicate path cannot happen (paths are unique per root and roots are
      // disjoint), but first-wins keeps the graph total rather than throwing on
      // a vault the read plane would otherwise still serve.
      if (this.nodes.has(node.key)) {
        continue;
      }
      this.nodes.set(node.key, node);
      // Both sides of every comparison go through the same normalizer; a key
      // built one way and looked up another is the defect `lookupForm` exists
      // to stop, so there is deliberately no second spelling of it here.
      if (node.root) {
        this.byPrefixedPath.set(lookupForm(node.key), node);
      }
      this.byLocalPath.set(scoped(node.root, lookupForm(node.localPath)), node);
      pushInto(this.byName, scoped(node.root, lookupForm(basenameOf(node.localPath))), node);
      // `title` and `aliases` are frontmatter, so unlike paths they have never
      // been canonicalized by anything upstream — normalize both sides here or
      // a decomposed title silently stops even being offered as a candidate.
      if (document.title) {
        pushInto(this.byTitle, scoped(node.root, document.title.normalize("NFC")), node);
      }
      for (const alias of aliasesOf(document)) {
        pushInto(this.byAlias, scoped(node.root, alias.normalize("NFC")), node);
      }
    }

    for (const document of documents) {
      const node = this.nodes.get(document.relativePath);
      if (!node) {
        continue;
      }
      const links = this.resolveDocumentLinks(document, node);
      this.outgoingLinks.set(node.key, links);
      for (const link of links) {
        const target = link.target_path === undefined ? undefined : this.nodes.get(link.target_path);
        // Self-links are reported as resolved (they are), but never become
        // edges: a self-loop would make every walk's first hop its own origin.
        if (!target || target.key === node.key) {
          continue;
        }
        pushInto(this.outNeighbours, node.key, target);
        pushInto(this.inNeighbours, target.key, node);
      }
    }
  }

  has(key: string): boolean {
    return this.nodes.has(key);
  }

  outgoing(key: string): ResolvedOutgoingLink[] {
    return this.outgoingLinks.get(key) ?? [];
  }

  incoming(key: string): LinkGraphNodeRef[] {
    return dedupeByPath(this.inNeighbours.get(key) ?? [])
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(toRef);
  }

  neighbors(key: string, options: NeighborOptions = {}): RelatedNode[] {
    const depth = options.depth ?? 1;
    // Bound the walk before doing any of it. The tool schema also caps depth,
    // but a bound that only exists at the transport edge is not a bound on the
    // module — `get_context` (P3) is already slated to call this directly.
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_LINK_GRAPH_DEPTH) {
      throw new Error(`depth must be an integer between 1 and ${MAX_LINK_GRAPH_DEPTH}`);
    }
    const direction = options.direction ?? "both";
    const nodeCap = options.nodeCap ?? MAX_RELATED_NODES;
    const fanoutCap = options.fanoutCap ?? MAX_EXPANSION_FANOUT;
    const hubThreshold = options.hubThreshold ?? HUB_DEGREE_THRESHOLD;

    const origin = this.nodes.get(key);
    if (!origin) {
      return [];
    }

    // Seeding `seen` with the origin is the cycle guard: a link cycle back to
    // the start would otherwise report the traced note as its own relative, and
    // a diamond would report the same note at two distances. The depth bound
    // makes the walk terminate either way, so termination alone does not
    // demonstrate this guard — no-revisit does.
    const seen = new Set<string>([origin.key]);
    const related: RelatedNode[] = [];
    let frontier: GraphNode[] = [origin];

    for (let distance = 1; distance <= depth && frontier.length > 0 && related.length < nodeCap; distance += 1) {
      const next: GraphNode[] = [];
      for (const node of [...frontier].sort((a, b) => a.key.localeCompare(b.key))) {
        // Hub damping. The origin is exempt: asking about an index note
        // directly must still answer, and its own fan-out is bounded below.
        if (node.key !== origin.key && this.degree(node.key) > hubThreshold) {
          continue;
        }
        for (const neighbour of this.expansionOrder(node.key, direction).slice(0, fanoutCap)) {
          if (seen.has(neighbour.key)) {
            continue;
          }
          seen.add(neighbour.key);
          related.push({
            id: neighbour.id,
            path: neighbour.key,
            title: neighbour.title,
            distance,
            via: node.key
          });
          next.push(neighbour);
          if (related.length >= nodeCap) {
            break;
          }
        }
        if (related.length >= nodeCap) {
          break;
        }
      }
      frontier = next;
    }

    return related.sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));
  }

  /** Distinct neighbours in either direction — what makes a note a hub. */
  private degree(key: string): number {
    const keys = new Set<string>();
    for (const node of this.outNeighbours.get(key) ?? []) {
      keys.add(node.key);
    }
    for (const node of this.inNeighbours.get(key) ?? []) {
      keys.add(node.key);
    }
    return keys.size;
  }

  /**
   * Neighbours in the order the walk should spend its fan-out budget: most
   * recently modified first, path as the tie-break so the result is stable
   * across runs on a vault where several notes share an mtime.
   */
  private expansionOrder(key: string, direction: LinkDirection): GraphNode[] {
    const collected: GraphNode[] = [];
    if (direction === "out" || direction === "both") {
      collected.push(...(this.outNeighbours.get(key) ?? []));
    }
    if (direction === "in" || direction === "both") {
      collected.push(...(this.inNeighbours.get(key) ?? []));
    }
    return dedupeByPath(collected).sort(
      (a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.key.localeCompare(b.key)
    );
  }

  private resolveDocumentLinks(document: MarkdownDocument, from: GraphNode): ResolvedOutgoingLink[] {
    // Extraction rides the parse cache when the store filled it in; a
    // hand-built document (tests, fixtures) simply extracts here instead.
    const wiki = document.linksDerived?.wiki ?? extractWikiLinks(document.body);
    const markdown = document.linksDerived?.markdown ?? extractMarkdownLinks(document.body);

    // ⚠️ Resolved PER SYNTAX, not once per distinct target string. The two
    // syntaxes genuinely disagree about what the same text means: written in
    // `dir/source.md`, `[[foo]]` asks for the root-relative `foo.md` while
    // `[x](foo)` asks for `dir/foo.md`. Deduplicating the raw strings first and
    // resolving the survivor took whichever leg ran first and silently dropped
    // the other note's backlink — a missing edge, which is the failure class
    // this module exists to remove rather than reintroduce.
    const links: ResolvedOutgoingLink[] = [];
    const seen = new Set<string>();
    const add = (link: ResolvedOutgoingLink): void => {
      // Identical outcomes from the two syntaxes collapse — overwhelmingly the
      // common case — so only a real disagreement produces two entries.
      const key = JSON.stringify([link.raw, link.target_path ?? null, link.candidates?.map((c) => c.path) ?? null]);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      links.push(link);
    };

    for (const raw of new Set(wiki)) {
      add(this.resolveWikiLink(raw, from));
    }
    for (const raw of new Set(markdown)) {
      add(this.resolveMarkdownLink(raw, from));
    }

    return links.sort((a, b) => a.raw.localeCompare(b.raw) || (a.target_path ?? "").localeCompare(b.target_path ?? ""));
  }

  /** The explicit `<root>:<path>` leg, shared by both syntaxes: root names come
   *  from configuration, so it is a path fact however the link was written. */
  private crossRootTarget(raw: string): GraphNode | undefined {
    return this.byPrefixedPath.get(lookupForm(raw));
  }

  private resolveMarkdownLink(raw: string, from: GraphNode): ResolvedOutgoingLink {
    const crossRoot = this.crossRootTarget(raw);
    if (crossRoot) {
      return resolvedTo(raw, crossRoot);
    }

    // Written relative to the linking note's own directory. `resolveRelativeLink`
    // percent-decodes and canonicalizes; `lookupForm` then only has to agree.
    const target = resolveRelativeLink(raw, from.localPath);
    if (target !== null) {
      const node = this.byLocalPath.get(scoped(from.root, lookupForm(target)));
      if (node) {
        return resolvedTo(raw, node);
      }
    }
    return { raw, resolved: false };
  }

  private resolveWikiLink(raw: string, from: GraphNode): ResolvedOutgoingLink {
    const crossRoot = this.crossRootTarget(raw);
    if (crossRoot) {
      return resolvedTo(raw, crossRoot);
    }
    const bare = lookupForm(raw);

    // Exact root-relative path first. This is the leg that keeps a
    // folder-qualified `[[projects/a/note]]` resolving when the basename `note`
    // is ambiguous — unambiguous without consulting any field the note declares
    // about itself, so there is no reason to drop it.
    const exact = this.byLocalPath.get(scoped(from.root, bare));
    if (exact) {
      return resolvedTo(raw, exact);
    }

    // Then the WHOLE link text as a name (Obsidian semantics), so a
    // path-qualified link that missed the leg above does not fall through to
    // some unrelated folder's file with the same basename.
    const named = this.byName.get(scoped(from.root, bare)) ?? [];
    if (named.length === 1) {
      return resolvedTo(raw, named[0]);
    }

    // Unresolved. Everything below is a HINT, never a resolution: an ambiguous
    // name, or a self-declared `title` / `aliases` match. The last two never
    // resolve even when unique — see the header, and INV-2 on frontmatter `id`.
    const declared = raw.normalize("NFC");
    const candidates = collectCandidates([
      ...named.map((node) => ({ node, via: "basename" as const })),
      ...(this.byTitle.get(scoped(from.root, declared)) ?? []).map((node) => ({ node, via: "title" as const })),
      ...(this.byAlias.get(scoped(from.root, declared)) ?? []).map((node) => ({ node, via: "alias" as const }))
    ]);

    return candidates.length > 0 ? { raw, resolved: false, candidates } : { raw, resolved: false };
  }
}

function toRef(node: GraphNode): LinkGraphNodeRef {
  return { id: node.id, path: node.key, title: node.title };
}

function resolvedTo(raw: string, node: GraphNode): ResolvedOutgoingLink {
  // Both handles are emitted: `target_path` is the server-owned one a caller
  // should follow, `target_id` is what a citation elsewhere would carry.
  return { raw, resolved: true, target_id: node.id, target_path: node.key };
}

function dedupeByPath(nodes: readonly GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const unique: GraphNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.key)) {
      continue;
    }
    seen.add(node.key);
    unique.push(node);
  }
  return unique;
}

/**
 * One entry per candidate note, first `via` winning (basename before title
 * before alias — strongest evidence first), sorted by path.
 *
 * ⚠️ The order is deterministic but carries **no ranking**. A caller must not
 * take the first entry as "probably the right one"; that is exactly the
 * first-match-wins guess D-4 forbids, and in multi-root mode the underlying
 * listing is concatenated per root rather than globally sorted anyway.
 */
function collectCandidates(matches: ReadonlyArray<{ node: GraphNode; via: LinkCandidate["via"] }>): LinkCandidate[] {
  const byPath = new Map<string, LinkCandidate>();
  for (const { node, via } of matches) {
    if (!byPath.has(node.key)) {
      byPath.set(node.key, { id: node.id, path: node.key, title: node.title, via });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function buildLinkGraph(documents: readonly MarkdownDocument[]): LinkGraph {
  return new MarkdownLinkGraph(documents);
}

/**
 * The whole of `trace_sources`, once the caller has produced the document and
 * an UNPREFIXED listing of the vault.
 *
 * Both stores call this rather than each carrying its own copy of the rules.
 * The single-root and multi-root traces used to be two hand-written scans that
 * happened to agree; the differences that matter (root scoping, the explicit
 * `<root>:` form) live inside the graph, so there is nothing left for a second
 * implementation to drift on.
 */
export function traceThroughGraph(
  document: MarkdownDocument,
  documents: readonly MarkdownDocument[],
  options: { depth?: number; direction?: LinkDirection } = {}
): TraceResult {
  const key = document.relativePath;
  const depth = options.depth ?? 1;

  // ⚠️ Both link fields come from the GRAPH — never one from the graph and one
  // from `document`. The caller produced `document` with an earlier `fetch` and
  // `documents` with a later full listing, so a note edited between those two
  // scans has two different bodies available right here; extracting
  // `outgoing_links` from the fetched body while labelling the listed one made
  // the two arrays describe different text, which is the one correspondence the
  // response promises. Deriving the raw strings from the labelled links makes
  // them line up by construction instead of by timing.
  //
  // The listing is the graph's own view and wins whenever it holds the note.
  // But it does not always hold it: since #114 the walk skips entries it cannot
  // reach and carries on, and on the iCloud-backed vaults this server is aimed
  // at a note can be unreadable for the walk in the same call `fetch` read it.
  // Deriving from an absent node would then answer "this note writes no links"
  // — indistinguishable from a note that genuinely writes none, and wrong.
  // Falling back to the fetched copy keeps both fields on ONE snapshot while
  // refusing to report an emptiness that came from the filesystem.
  const graph = buildLinkGraph(
    documents.some((entry) => entry.relativePath === key) ? documents : [...documents, document]
  );
  const resolvedOutgoing = graph.outgoing(key);

  const result: TraceResult = {
    document: { id: document.id, relativePath: key, title: document.title },
    source_refs: document.frontmatter.source_refs ?? [],
    outgoing_links: [...new Set(resolvedOutgoing.map((link) => link.raw))].sort(),
    // Complete, never capped: this is the inventory the field has always been.
    backlinks: graph.incoming(key).map((node) => ({ id: node.id, relativePath: node.path, title: node.title })),
    resolved_outgoing: resolvedOutgoing
  };

  // Only a caller that asked to expand pays for an expansion, and a caller that
  // did not ask sees exactly the response shape it saw before, plus the labels.
  if (depth > 1) {
    result.related = graph.neighbors(key, { depth, direction: options.direction });
  }
  return result;
}
