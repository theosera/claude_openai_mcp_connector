/**
 * `get_context` — the deterministic five-stage context packer (D-3).
 *
 * The read plane before this could answer "which notes match?" and "give me
 * that note". What it could not do is answer "here is what I am working on" in
 * one call, which is why clients loop search→fetch→search until they run out of
 * budget in a way nobody can see. This assembles a token-bounded package
 * instead, and says what it left out.
 *
 * Five stages, fixed, in this order — seed, expand, fuse, chunk, pack. There is
 * deliberately **no plugin mechanism**: a pipeline whose stages are configurable
 * is a pipeline whose output cannot be reproduced from its inputs, and the whole
 * value of the `omitted[]` list is that a caller can trust it to be the
 * complement of what it received.
 *
 * ## Security posture
 *
 * Read-only, and registered on every transport for that reason. Three properties
 * carry over from the layers below rather than being re-established here:
 *
 * - **Containment is inherited.** This module never touches `fs`; it is handed
 *   documents the store enumerated through the INV-1 guard chain, exactly as
 *   `linkGraph` is.
 * - **Nothing a note says about itself decides ranking.** Type weighting is
 *   opt-in and capped for self-declared signals (`typeRules.ts`, D-7), and the
 *   graph expansion resolves on path facts only (P2-D0). A note cannot promote
 *   itself into a package.
 * - **Inclusion is not endorsement.** Everything packed here is still untrusted
 *   vault DATA. `SERVER_INSTRUCTIONS` says so explicitly, because a package is a
 *   more convincing-looking container than a search result and the temptation to
 *   read it as curated is exactly the failure INV-5 is about.
 *
 * ## Keyed on path, not on `id`
 *
 * D-3 writes the dedup step as "id 単位". It is done on the vault path instead,
 * for the reason P2 keyed the link graph there: `id` comes verbatim from
 * frontmatter, INV-2 already refuses to resolve on it when two notes claim it,
 * and a package deduplicated on a self-declared field would let one note evict
 * another from the answer. `id` is still reported on every chunk, because
 * citations elsewhere use it.
 */

import { createHash } from "node:crypto";
import { buildLinkGraph } from "./linkGraph.js";
import { splitIntoSections } from "./markdownSections.js";
import { compactWhitespace, effectiveTimestamp, tokenize } from "./search.js";
import { normalizeForMatch } from "./searchText.js";
import { CHUNK_JSON_OVERHEAD_TOKENS, estimateTokens, truncateToTokens } from "./tokenEstimate.js";
import { weighDocument } from "./typeRules.js";
import type { TypeRules } from "./typeRules.js";
import type {
  ContextChunk,
  ContextPackage,
  ContextRelationship,
  GetContextInput,
  MarkdownDocument,
  OmittedContext,
  VaultStore
} from "./types.js";

/** How many search hits seed the package. Internal, not a caller knob: it is
 *  the width of the funnel, and a caller widening it would be paying for
 *  candidates the budget cannot hold anyway. */
export const SEED_LIMIT = 40;
/** Score multiplier per link hop away from a seed. */
export const LINK_DISTANCE_DECAY = 0.6;
/** Score for a document pulled in only because it shares the requested project. */
export const SAME_PROJECT_BASE_SCORE = 0.15;
/**
 * Weight applied to the ORIGINATING SEED's score for a document it names in
 * `source_refs` — a multiplier, not a floor.
 *
 * ⚠️ It was a fixed 0.4, and that was wrong in a way this module's own security
 * note asserted was impossible. Seed scores are normalized against the best hit,
 * so a weak match can score 0.05; a constant 0.4 put a note's self-authored
 * reference ABOVE real query matches and let it spend budget before them.
 * `source_refs` is patch-writable frontmatter, so that is a note choosing its
 * own rank by proxy. Scaling by the seed reproduces the rule link expansion
 * already follows: a reference is worth a fraction of whatever cited it.
 */
export const SOURCE_REF_WEIGHT = 0.4;
/** How many same-project documents may join, most recent first. */
export const SAME_PROJECT_LIMIT = 10;

export const DEFAULT_TOKEN_BUDGET = 4000;
export const MIN_TOKEN_BUDGET = 500;
export const MAX_TOKEN_BUDGET = 32000;
export const DEFAULT_GRAPH_DEPTH = 1;
export const MAX_GRAPH_DEPTH = 2;

/**
 * Ceiling on the share of the budget any ONE document may occupy.
 *
 * Without it a single megabyte-scale session archive answers every query by
 * filling the budget with its own top-scoring section, and the package stops
 * being a package. The cost is that a genuinely dominant document gets
 * truncated — which is why truncation is reported per chunk rather than
 * silently applied.
 */
export const MAX_DOCUMENT_BUDGET_SHARE = 0.4;

/**
 * Smallest chunk worth emitting. Below this a chunk is a fragment: it spends
 * its JSON overhead to deliver a sentence with no context around it, so it is
 * reported as omitted instead.
 */
export const MIN_CHUNK_TOKENS = 32;

/**
 * Ceiling on entries in `omitted[]`.
 *
 * ⚠️ The list was unbounded, which made `token_budget` a bound on the chunks
 * and not on the RESPONSE — the thing the parameter is described as limiting. A
 * note carrying ten thousand headings splits into ten thousand sections, and
 * every one rejected after the caps appended another object: a few hundred
 * tokens of context wrapped in hundreds of kilobytes of refusals, driven
 * entirely by vault content. Entries are now folded to one per document per
 * reason (that note contributes ONE), and the list is capped on top of that
 * with `omitted_count` reporting the true total — the same shape `total_count`
 * gives search, and for the same reason: a truncated list has to say so.
 */
export const MAX_OMITTED_ENTRIES = 50;

interface Candidate {
  document: MarkdownDocument;
  /** Fused score, before chunking. */
  score: number;
  relationship: ContextRelationship;
  type?: string;
}

/**
 * Relationship precedence when a document arrives by more than one route.
 *
 * Strongest first. A document that both matched the query and is linked from
 * another match is reported as a `seed`: the caller asked for it, and the fact
 * that it is also a neighbour does not make it less of a direct answer.
 */
const RELATIONSHIP_RANK: Record<ContextRelationship, number> = {
  seed: 0,
  "linked:out": 1,
  "linked:in": 2,
  source_ref: 3,
  same_project: 4,
  recent: 5
};

/** Fraction of the query's terms this text carries, in [0, 1]. 1 when there is
 *  no query — a recency-driven package must not score every section at zero. */
function termDensity(text: string, terms: readonly { text: string }[]): number {
  if (terms.length === 0) {
    return 1;
  }
  const folded = normalizeForMatch(text);
  const present = terms.filter((term) => folded.includes(term.text)).length;
  // Floor at a small positive value: a section of a matching document is still
  // part of that document, and zeroing it would drop the surrounding context
  // that makes the matching section legible.
  return Math.max(0.1, present / terms.length);
}

/**
 * Fingerprint for "these two notes are the same text".
 *
 * ⚠️ NFC and whitespace, NOT the search path's `normalizeForMatch`. That folds
 * NFKC and lowercases, which is right for MATCHING and wrong for IDENTITY: it
 * makes `Foo` and `foo` the same document, and half-width and full-width the
 * same document, so two genuinely different notes — code, identifiers, paths,
 * config values — would have one silently reported as a duplicate of the other.
 * The two normalizations exist for different jobs, and this is the job that has
 * to preserve identity: the same split `pathSafety`'s NFC keeps from
 * `searchText`'s NFKC.
 */
function contentFingerprint(body: string): string {
  return createHash("sha256")
    .update(compactWhitespace(body.normalize("NFC")))
    .digest("hex");
}

function requireSelector(input: GetContextInput): void {
  if (
    (input.query === undefined || input.query.trim() === "") &&
    input.project === undefined &&
    input.path_prefix === undefined &&
    (input.tags === undefined || input.tags.length === 0)
  ) {
    // Refusing the empty call is the point: `get_context()` with no selector is
    // "dump the vault into my context window", a primitive this server should
    // not offer at any budget.
    throw new Error("get_context needs at least one of query, project, tags or path_prefix");
  }
}

function clampBudget(requested: number | undefined): number {
  const budget = requested ?? DEFAULT_TOKEN_BUDGET;
  if (!Number.isInteger(budget) || budget < MIN_TOKEN_BUDGET || budget > MAX_TOKEN_BUDGET) {
    throw new Error(`token_budget must be an integer between ${MIN_TOKEN_BUDGET} and ${MAX_TOKEN_BUDGET}`);
  }
  return budget;
}

function clampDepth(requested: number | undefined): number {
  const depth = requested ?? DEFAULT_GRAPH_DEPTH;
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_GRAPH_DEPTH) {
    throw new Error(`graph_depth must be an integer between 0 and ${MAX_GRAPH_DEPTH}`);
  }
  return depth;
}

export interface BuildContextOptions {
  typeRules?: TypeRules;
}

/**
 * ⚠️ There is deliberately **no clock** in this module — no `now`, injected or
 * otherwise. Recency is applied once, by search, from the operator's
 * configuration; a second time reference here would be a second copy of that
 * rule and the one that is not on the search path is the one that rots. It also
 * means a package is a pure function of (vault, input, rules), which is what
 * makes the determinism test meaningful rather than merely repeatable.
 */

export async function buildContext(
  store: VaultStore,
  input: GetContextInput,
  options: BuildContextOptions = {}
): Promise<ContextPackage> {
  requireSelector(input);
  const budget = clampBudget(input.token_budget);
  const depth = clampDepth(input.graph_depth);
  const query = input.query ?? "";
  const terms = tokenize(query);
  const mode: ContextPackage["strategy"]["mode"] = query.trim() === "" ? "recent" : "query";

  // ── 1. Seed ────────────────────────────────────────────────────────────────
  // Through `store.search`, not through `searchDocuments` directly, so the
  // deployment's configured recency defaults reach the ranking. Calling the pure
  // function would reproduce #112's defect: a second path that scores slightly
  // differently from the one every other tool uses, and nothing failing.
  const seeded = await store.search({
    query,
    client: input.client,
    project: input.project,
    tags: input.tags,
    root: input.root,
    path_prefix: input.path_prefix,
    recency_weight: input.recency_weight,
    order: input.order ?? (mode === "recent" ? "recent" : "relevance"),
    limit: SEED_LIMIT
  });

  // The whole vault, unprefixed: the graph and the same-project sweep are both
  // wrong on a subset, for the reason `linkGraph`'s header gives.
  const documents = await store.listDocuments();
  const byPath = new Map(documents.map((document) => [document.relativePath, document]));

  const candidates = new Map<string, Candidate>();

  const consider = (document: MarkdownDocument, score: number, relationship: ContextRelationship): void => {
    const verdict = weighDocument(options.typeRules, document);
    if (
      input.types !== undefined &&
      input.types.length > 0 &&
      (verdict.type === undefined || !input.types.includes(verdict.type))
    ) {
      return;
    }
    const fused = score * verdict.weight;
    const existing = candidates.get(document.relativePath);
    if (existing === undefined) {
      candidates.set(document.relativePath, { document, score: fused, relationship, type: verdict.type });
      return;
    }
    // Best score wins, strongest relationship wins — independently. A document
    // that is both a seed and a neighbour keeps whichever score is higher AND is
    // still labelled a seed, because the label describes why it belongs in the
    // answer and the score describes how much.
    existing.score = Math.max(existing.score, fused);
    if (RELATIONSHIP_RANK[relationship] < RELATIONSHIP_RANK[existing.relationship]) {
      existing.relationship = relationship;
    }
  };

  const seedScores = new Map<string, number>();
  // ⚠️ The seed base is the search score WHOLE, recency included — not the
  // text-only half. D-3 sketches recency as a separate factor in this stage, and
  // that reads well until you notice search already applies it, from the
  // operator's `MCP_SEARCH_RECENCY_WEIGHT`, which this module cannot see.
  //
  // Taking the breakdown apart to re-apply the rule here was the first
  // implementation, and it silently dropped the operator's setting: the packer
  // subtracted the store's recency and multiplied by a weight only a per-call
  // parameter could set. Two notes with identical text ranked identically no
  // matter how the deployment was tuned — #112's shape exactly, in a new module.
  //
  // So recency is applied in ONE place, the place the operator configured, and
  // expansion inherits it through the seed it came from. A second copy of the
  // rule is what rots.
  const maxSeedScore = Math.max(...seeded.results.map((result) => result.score), Number.EPSILON);
  for (const result of seeded.results) {
    const document = byPath.get(result.path);
    if (!document) {
      // The listing and the search enumerated the vault separately, and #114's
      // walk skips what it cannot reach. A hit with no document here is that
      // gap, not a bug in the ranking — dropping it is the honest reaction,
      // since a chunk needs a body this package does not have.
      continue;
    }
    // A recency-mode package has no text score at all; rank by position instead
    // so the ordering the store already chose survives the fuse stage.
    const base =
      mode === "recent"
        ? 1 - seedScores.size / Math.max(seeded.results.length, 1)
        : Math.max(result.score / maxSeedScore, 0);
    seedScores.set(result.path, base);
    consider(document, base, mode === "recent" ? "recent" : "seed");
  }

  // ── 2. Expand ──────────────────────────────────────────────────────────────
  if (depth > 0 && seedScores.size > 0) {
    const graph = buildLinkGraph(documents);
    for (const [path, base] of seedScores) {
      // Two calls rather than one `both`, because the direction is the label:
      // `neighbors` reports which node a hop came through, not which way the
      // edge pointed, and collapsing that would report every relative as
      // `linked:out`.
      for (const direction of ["out", "in"] as const) {
        for (const node of graph.neighbors(path, { depth, direction })) {
          const document = byPath.get(node.path);
          if (document) {
            consider(document, base * Math.pow(LINK_DISTANCE_DECAY, node.distance), `linked:${direction}`);
          }
        }
      }
    }

    // Declared source refs, resolved on the path fact only. A `source_ref` is
    // frontmatter, so it can name anything; matching it against an enumerated
    // path means a note can point at a document but cannot invent one.
    //
    // ⚠️ State the property rather than discover it later: `source_refs` is one
    // of the five keys INV-2's patch allowlist lets a client write, so a note —
    // or whoever last updated it — chooses which OTHER documents ride along when
    // it is a seed. That is retrieval influence, and it is bounded on the two
    // axes that matter. It cannot raise a note's own rank (this only ever adds
    // other documents), and it cannot outrank the query: the score is a fixed
    // constant below a normalized seed, so a pulled-in reference is always
    // packed after what was actually asked for. It also grants no reach — every
    // target is a document the same caller can already `fetch_document`. What
    // remains is that a poisoned note can put text in front of a model that the
    // user did not ask for, which is the ordinary INV-5 position: it arrives as
    // labelled, inert data with `relationship: "source_ref"` saying exactly how
    // it got there.
    for (const [path, base] of seedScores) {
      for (const reference of byPath.get(path)?.frontmatter.source_refs ?? []) {
        const target = byPath.get(reference);
        if (target) {
          consider(target, base * SOURCE_REF_WEIGHT, "source_ref");
        }
      }
    }
  }

  if (input.project !== undefined) {
    const recent = documents
      .filter((document) => document.frontmatter.project === input.project)
      .sort((a, b) => effectiveTimestamp(b) - effectiveTimestamp(a))
      .slice(0, SAME_PROJECT_LIMIT);
    for (const document of recent) {
      consider(document, SAME_PROJECT_BASE_SCORE, "same_project");
    }
  }

  // ── 3. Fuse (content dedup) ────────────────────────────────────────────────
  // One entry per (document, reason). A document split into thousands of
  // sections is one omission, not thousands of identical ones.
  const omissions = new Map<string, OmittedContext>();
  const omit = (document: MarkdownDocument, reason: OmittedContext["reason"]): void => {
    const key = `${document.relativePath}\u0000${reason}`;
    if (!omissions.has(key)) {
      omissions.set(key, { id: document.id, title: document.title, reason });
    }
  };
  const seenContent = new Map<string, string>();
  const fused: Candidate[] = [];
  for (const candidate of [...candidates.values()].sort(
    (a, b) => b.score - a.score || a.document.relativePath.localeCompare(b.document.relativePath)
  )) {
    const fingerprint = contentFingerprint(candidate.document.body);
    const first = seenContent.get(fingerprint);
    if (first !== undefined) {
      omit(candidate.document, "duplicate");
      continue;
    }
    seenContent.set(fingerprint, candidate.document.relativePath);
    fused.push(candidate);
  }

  // ── 4. Chunk ───────────────────────────────────────────────────────────────
  interface PackableChunk {
    candidate: Candidate;
    headingPath: string[];
    sectionIndex: number;
    sectionCount: number;
    text: string;
    score: number;
  }

  const packable: PackableChunk[] = [];
  for (const candidate of fused) {
    const sections = splitIntoSections(candidate.document.body);
    for (const section of sections) {
      packable.push({
        candidate,
        headingPath: section.headingPath,
        sectionIndex: section.index,
        sectionCount: sections.length,
        text: section.text,
        score: candidate.score * termDensity(section.text, terms)
      });
    }
  }

  // ── 5. Pack ────────────────────────────────────────────────────────────────
  // Greedy by score per token. Ties break on path then section index so the same
  // vault and the same query produce the same package on every run.
  // ⚠️ Divide by the FULL cost a chunk charges, framing included — the same
  // number the packing loop spends below. Dividing by text alone made a
  // 5-token chunk look eight times more efficient than it is, so a note split
  // into many short sections could win the budget on metadata and crowd out the
  // sections that carry the answer.
  const chunkCost = (chunk: PackableChunk): number => estimateTokens(chunk.text) + CHUNK_JSON_OVERHEAD_TOKENS;
  packable.sort((a, b) => {
    const byDensity = b.score / chunkCost(b) - a.score / chunkCost(a);
    if (byDensity !== 0) {
      return byDensity;
    }
    return (
      a.candidate.document.relativePath.localeCompare(b.candidate.document.relativePath) ||
      a.sectionIndex - b.sectionIndex
    );
  });

  const documentCap = Math.floor(budget * MAX_DOCUMENT_BUDGET_SHARE);
  const spentPerDocument = new Map<string, number>();
  const chunks: ContextChunk[] = [];
  let spent = 0;

  for (const chunk of packable) {
    const path = chunk.candidate.document.relativePath;
    const documentSpent = spentPerDocument.get(path) ?? 0;
    const room = Math.min(documentCap - documentSpent, budget - spent) - CHUNK_JSON_OVERHEAD_TOKENS;
    if (room < MIN_CHUNK_TOKENS) {
      omit(chunk.candidate.document, "budget");
      continue;
    }
    const whole = estimateTokens(chunk.text);
    const text = whole <= room ? chunk.text : truncateToTokens(chunk.text, room);
    const cost = estimateTokens(text) + CHUNK_JSON_OVERHEAD_TOKENS;
    spent += cost;
    spentPerDocument.set(path, documentSpent + cost);
    chunks.push({
      id: chunk.candidate.document.id,
      path,
      ...(chunk.candidate.document.root ? { root: chunk.candidate.document.root } : {}),
      title: chunk.candidate.document.title,
      ...(chunk.candidate.type ? { type: chunk.candidate.type } : {}),
      ...(typeof chunk.candidate.document.frontmatter.updated_at === "string"
        ? { updated_at: chunk.candidate.document.frontmatter.updated_at }
        : {}),
      score: chunk.score,
      relationship: chunk.candidate.relationship,
      ...(chunk.sectionCount > 1 ? { section: { heading_path: chunk.headingPath, index: chunk.sectionIndex } } : {}),
      truncated: text.length < chunk.text.length,
      text
    });
  }

  // Stable output order: highest score first, then path, then section — the
  // packing order is an implementation detail of the budget, not something a
  // caller should have to reason about.
  chunks.sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.section?.index ?? 0) - (b.section?.index ?? 0)
  );

  return {
    strategy: {
      mode,
      seed_count: seedScores.size,
      expanded_count: Math.max(candidates.size - seedScores.size, 0),
      budget,
      est_tokens_used: spent
    },
    chunks,
    omitted: [...omissions.values()].slice(0, MAX_OMITTED_ENTRIES),
    omitted_count: omissions.size,
    total_candidates: candidates.size
  };
}
