/**
 * `get_project_state` — a deterministic dossier for one project (D-5).
 *
 * "Where did I get to on X?" currently costs a search, several fetches, and a
 * guess about which notes were the current ones. This answers it from facts the
 * server can derive: which documents carry the project, which of them the owner
 * designated as state, what changed most recently, which session archives exist
 * and what is inside them, and which ops-log entries point at the project.
 *
 * ## What this deliberately does NOT return
 *
 * There is no `summary`, no `blockers`, no `next_steps` — no free-text field of
 * any kind. That is the honesty boundary and it is load-bearing: a server that
 * emits prose has synthesized, and synthesis here would be either a second
 * model (which this server does not have and does not want — local-first,
 * deterministic, no vault content leaving the process) or a template pretending
 * to be one. A dossier that is obviously assembled is more useful than a
 * summary that cannot be checked.
 *
 * The place synthesis DOES belong is `state_docs`: a note the owner tagged, or
 * that an offline pipeline wrote, holding whatever conclusion a human or an
 * agent reached. The server's job is to surface that reliably, not to invent a
 * substitute for it.
 *
 * ## Size asymmetry is the reason for the shape
 *
 * A session archive in this vault runs to megabytes while an ordinary note runs
 * to kilobytes, so "return the project's documents" is not one behaviour — it
 * is two. `state_docs` carry full text against a budget; `recent_docs` carry a
 * snippet; `recent_sessions` carry **metadata and an outline and never a body**.
 * Inlining one session note would spend the entire budget and crowd out
 * everything the caller actually asked about.
 */

import { compactWhitespace, effectiveTimestamp } from "./search.js";
import { outlineOf } from "./markdownSections.js";
import type { OutlineEntry } from "./markdownSections.js";
import { estimateTokens, truncateToTokens } from "./tokenEstimate.js";
import type {
  GetProjectStateInput,
  MarkdownDocument,
  OpsPointer,
  ProjectState,
  ProjectStateSection,
  RecentDocument,
  SessionDocument,
  StateDocument,
  VaultStore
} from "./types.js";

/** Frontmatter tag marking a note as this project's designated state. */
export const DEFAULT_PROJECT_STATE_TAG = "project-state";
/** `client` value the session-archive hook writes. */
export const SESSION_CLIENT = "claude-code";

export const DEFAULT_PROJECT_STATE_BUDGET = 3000;
export const MIN_PROJECT_STATE_BUDGET = 500;
export const MAX_PROJECT_STATE_BUDGET = 32000;

export const RECENT_DOCS_LIMIT = 10;
export const RECENT_SESSIONS_LIMIT = 5;
export const OPS_RECENT_LIMIT = 10;
/** Characters of leading text carried on a `recent_docs` entry. */
export const RECENT_SNIPPET_CHARS = 240;

const ALL_SECTIONS: ProjectStateSection[] = ["state_docs", "recent_docs", "sessions", "ops"];

export interface BuildProjectStateOptions {
  /** Overrides `DEFAULT_PROJECT_STATE_TAG`; comes from `MCP_PROJECT_STATE_TAG`. */
  stateTag?: string;
}

function tagsOf(document: MarkdownDocument): string[] {
  const raw = document.frontmatter.tags;
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === "string") : [];
}

function isoOf(document: MarkdownDocument): string {
  return new Date(effectiveTimestamp(document)).toISOString();
}

function byRecencyDesc(a: MarkdownDocument, b: MarkdownDocument): number {
  // Path breaks the tie so two notes stamped in the same second do not swap
  // places between calls — a dossier a caller cannot diff is a dossier that
  // looks like it changed every time it is asked for.
  return effectiveTimestamp(b) - effectiveTimestamp(a) || a.relativePath.localeCompare(b.relativePath);
}

function clampBudget(requested: number | undefined): number {
  const budget = requested ?? DEFAULT_PROJECT_STATE_BUDGET;
  if (!Number.isInteger(budget) || budget < MIN_PROJECT_STATE_BUDGET || budget > MAX_PROJECT_STATE_BUDGET) {
    throw new Error(
      `token_budget must be an integer between ${MIN_PROJECT_STATE_BUDGET} and ${MAX_PROJECT_STATE_BUDGET}`
    );
  }
  return budget;
}

export async function buildProjectState(
  store: VaultStore,
  input: GetProjectStateInput,
  options: BuildProjectStateOptions = {}
): Promise<ProjectState> {
  if (typeof input.project !== "string" || input.project.trim() === "") {
    throw new Error("get_project_state requires a project");
  }
  const budget = clampBudget(input.token_budget);
  const stateTag = options.stateTag ?? DEFAULT_PROJECT_STATE_TAG;
  const include = new Set<ProjectStateSection>(
    input.include !== undefined && input.include.length > 0 ? input.include : ALL_SECTIONS
  );

  // Unprefixed, for the reason in the header of `linkGraph.ts`: a project's
  // state computed over part of the vault is wrong rather than merely short.
  const documents = await store.listDocuments();
  const mine = documents.filter(
    (document) =>
      document.frontmatter.project === input.project &&
      (input.client === undefined || document.frontmatter.client === input.client)
  );

  const summary = {
    doc_count: mine.length,
    latest_ts: mine.length > 0 ? isoOf([...mine].sort(byRecencyDesc)[0]) : undefined,
    roots: [
      ...new Set(mine.map((document) => document.root).filter((root): root is string => root !== undefined))
    ].sort()
  };

  const state: ProjectState = {
    summary,
    state_docs: [],
    recent_docs: [],
    recent_sessions: [],
    ops_recent: []
  };

  const sessions = mine.filter(
    (document) => document.frontmatter.client === SESSION_CLIENT && tagsOf(document).includes("claude-code-session")
  );
  const sessionPaths = new Set(sessions.map((document) => document.relativePath));

  // ── state_docs: the designated seats, packed against the budget ────────────
  if (include.has("state_docs")) {
    let spent = 0;
    for (const document of mine.filter((candidate) => tagsOf(candidate).includes(stateTag)).sort(byRecencyDesc)) {
      const room = budget - spent;
      if (room <= 0) {
        break;
      }
      const whole = estimateTokens(document.body);
      const text = whole <= room ? document.body : truncateToTokens(document.body, room);
      spent += estimateTokens(text);
      state.state_docs.push({
        id: document.id,
        path: document.relativePath,
        ...(document.root ? { root: document.root } : {}),
        title: document.title,
        updated_at: isoOf(document),
        est_tokens: estimateTokens(text),
        truncated: text.length < document.body.length,
        text
      } satisfies StateDocument);
    }
  }

  // ── recent_docs: metadata and a snippet, never a body ─────────────────────
  if (include.has("recent_docs")) {
    state.recent_docs = mine
      // Session archives have their own section, with their own size rule.
      // Letting them into this list would mean the snippet is the first 240
      // characters of a megabyte, which is the least useful part of it.
      .filter((document) => !sessionPaths.has(document.relativePath))
      .sort(byRecencyDesc)
      .slice(0, RECENT_DOCS_LIMIT)
      .map((document): RecentDocument => ({
        id: document.id,
        path: document.relativePath,
        ...(document.root ? { root: document.root } : {}),
        title: document.title,
        updated_at: isoOf(document),
        size_bytes: document.stats.sizeBytes,
        snippet: compactWhitespace(document.body).slice(0, RECENT_SNIPPET_CHARS)
      }));
  }

  // ── recent_sessions: an outline of the newest one, and no body at all ──────
  if (include.has("sessions")) {
    const ordered = [...sessions].sort(byRecencyDesc).slice(0, RECENT_SESSIONS_LIMIT);
    state.recent_sessions = ordered.map((document, index): SessionDocument => ({
      id: document.id,
      path: document.relativePath,
      ...(document.root ? { root: document.root } : {}),
      title: document.title,
      updated_at: isoOf(document),
      size_bytes: document.stats.sizeBytes,
      // ⚠️ Only the newest one gets an outline, and an outline is headings —
      // no body reaches this response at any index. A caller that wants the
      // text asks `fetch_document` for one section of it, which is what the
      // outline exists to make possible.
      ...(index === 0 ? { outline: outlineOf(document.body) as OutlineEntry[] } : {})
    }));
  }

  // ── ops_recent: pointers, because `target_repo` is self-declared ───────────
  if (include.has("ops")) {
    state.ops_recent = documents
      .filter((document) => document.frontmatter.target_repo === input.project)
      .sort(byRecencyDesc)
      .slice(0, OPS_RECENT_LIMIT)
      .map((document): OpsPointer => ({
        path: document.relativePath,
        ...(document.root ? { root: document.root } : {}),
        date: isoOf(document)
      }));
  }

  return state;
}
