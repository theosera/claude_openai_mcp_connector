/**
 * Heading-level splitting for the context packer (D-3, stage 4).
 *
 * A megabyte-scale session archive and a two-paragraph note are both "one
 * document" to the store, and packing at document granularity means the archive
 * either consumes the whole budget or is dropped whole. Splitting on headings
 * gives the packer something to choose between, and gives the caller a
 * `heading_path` saying which part of the note it received — the provenance
 * half of the same change.
 *
 * ⚠️ **A `## ` inside a fenced code block is not a heading.** Notes in this
 * vault routinely quote Markdown, shell prompts and diff hunks, so a splitter
 * that scans for `^##` cuts documents at lines that are content. The fence
 * tracking here is the same rule `tokenEstimate` uses, for the same reason: the
 * two would otherwise disagree about where a block starts, and a chunk would be
 * priced under one reading and cut under another.
 *
 * Splitting is by heading only. There is no fixed-size fallback: a section with
 * no headings inside it comes back whole and the packer truncates it, which
 * keeps every cut this module makes explicable as "a heading was here".
 */

import { estimateTokens } from "./tokenEstimate.js";

/**
 * Only documents longer than this are split. Below it, a document is one chunk
 * and carries an empty `headingPath`.
 *
 * Characters, not bytes — the packer's budget is in tokens, which this module's
 * sibling estimates from characters, and a byte threshold would make the same
 * note splittable or not depending on how much of it is CJK.
 */
export const SECTION_SPLIT_THRESHOLD_CHARS = 6000;

export interface MarkdownSection {
  /** Ancestor headings, outermost first. Empty for a document's preamble. */
  headingPath: string[];
  /** Position in document order, starting at 0. */
  index: number;
  /** The section's text, including its own heading line. */
  text: string;
}

export interface HeadingLine {
  level: number;
  title: string;
  lineIndex: number;
}

/** One entry of a document's table of contents. */
export interface OutlineEntry {
  heading: string;
  level: number;
  /** Ancestor headings including this one, outermost first. */
  heading_path: string[];
  /** 1-based line the heading sits on. */
  start_line: number;
  /** Characters from this heading up to the next one at the same level or above. */
  chars: number;
  est_tokens: number;
}

/**
 * ATX headings outside fenced code blocks, in document order.
 *
 * Setext headings (`Title` over `====`) are deliberately not recognized: they
 * are rare in this vault, and a lookahead rule that fires on a line of `-`
 * characters would cut on horizontal rules and on table separators.
 */
/**
 * Drop a closed ATX heading's trailing hash run: `## Setup ##` is a heading
 * called `Setup`.
 *
 * ⚠️ Keeping them was two compounding failures, not one. The outline displayed
 * `Setup ##` — the wrong name — and `sections: ["Setup"]`, which is the name a
 * caller would naturally type after reading that outline, then matched nothing.
 * The outline is where the selector comes from, so a wrong name there produces
 * a miss that looks like the caller's own mistake.
 *
 * The run must be preceded by whitespace or be the entire content, which is
 * what keeps `## C#` a heading called `C#`.
 */
function closeHashes(title: string): string {
  return title.replace(/(?:^|\s+)#+$/, "").trim();
}

function findHeadings(lines: readonly string[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  let fence: string | undefined;

  lines.forEach((line, lineIndex) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === undefined) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      return;
    }
    if (fence !== undefined) {
      return;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      headings.push({ level: heading[1].length, title: closeHashes(heading[2].trim()), lineIndex });
    }
  });

  return headings;
}

/** Ancestry of the heading at `position`, outermost first, including itself. */
function ancestryOf(headings: readonly HeadingLine[], position: number): string[] {
  const path: string[] = [headings[position].title];
  let level = headings[position].level;
  for (let index = position - 1; index >= 0 && level > 1; index -= 1) {
    if (headings[index].level < level) {
      path.unshift(headings[index].title);
      level = headings[index].level;
    }
  }
  return path;
}

/**
 * A document's table of contents — headings only, never the body.
 *
 * This is what makes a megabyte-scale session archive answerable without
 * fetching it: `search` already reports `size_bytes`, and this says what is
 * inside so a caller can ask for one section instead of the whole file. Each
 * entry carries the cost of its own section, so the decision can be made
 * against a budget rather than against a guess.
 */
export function outlineOf(body: string): OutlineEntry[] {
  const lines = body.split("\n");
  const headings = findHeadings(lines);

  return headings.map((heading, position) => {
    // A section runs until the next heading at the same level or shallower —
    // its subsections belong to it, which is why a nested `###` does not end a
    // `##`. Counting to the next heading of ANY level would report every parent
    // as the length of its own first paragraph.
    let end = lines.length;
    for (let next = position + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) {
        end = headings[next].lineIndex;
        break;
      }
    }
    const text = lines.slice(heading.lineIndex, end).join("\n");
    return {
      heading: heading.title,
      level: heading.level,
      heading_path: ancestryOf(headings, position),
      start_line: heading.lineIndex + 1,
      chars: text.length,
      est_tokens: estimateTokens(text)
    };
  });
}

/**
 * The parts of `body` under the requested headings, in document order.
 *
 * A request matches a heading when it equals the heading text, or when it is a
 * `/`-joined prefix of that heading's path — so `Design` takes the section and
 * everything nested under it, and `Design/Rejected` takes just the subsection.
 * Comparison is NFC-normalized and case-insensitive, because the caller is
 * quoting a heading it read out of an `outline`, possibly through a client that
 * re-normalized it on the way.
 *
 * Returns which requests matched, so a caller that mistyped one gets told
 * rather than quietly receiving less than it asked for.
 */
export function selectSections(body: string, wanted: readonly string[]): { text: string; matched: string[] } {
  const normalize = (value: string): string => value.normalize("NFC").toLocaleLowerCase();
  const requests = wanted.map((request) => ({ raw: request, key: normalize(request) }));
  const lines = body.split("\n");
  const headings = findHeadings(lines);
  const matched = new Set<string>();
  const ranges: { start: number; end: number }[] = [];

  headings.forEach((heading, position) => {
    const pathKey = normalize(ancestryOf(headings, position).join("/"));
    // ⚠️ Every matching request, not the first one. Overlapping selectors —
    // `["Design", "Doc/Design"]` — both match this heading, and recording only
    // the first reported the other as a miss. `sections_matched` exists so a
    // caller can tell a hit from a typo, so a false miss sends it to re-request
    // a selector that already worked.
    const hits = requests.filter(
      (request) =>
        request.key === normalize(heading.title) || pathKey === request.key || pathKey.startsWith(`${request.key}/`)
    );
    if (hits.length === 0) {
      return;
    }
    for (const hit of hits) {
      matched.add(hit.raw);
    }

    // The whole section, subsections included — so a nested heading does not
    // end its parent.
    let end = lines.length;
    for (let next = position + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) {
        end = headings[next].lineIndex;
        break;
      }
    }
    ranges.push({ start: heading.lineIndex, end });
  });

  // ⚠️ Merge overlaps. A parent and one of its children can both match — the
  // parent by name, the child by path prefix — and emitting each range on its
  // own would return the child's text twice, which reads as duplicated content
  // in the note rather than as an artifact of the request.
  const merged: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return {
    text: merged.map((range) => lines.slice(range.start, range.end).join("\n")).join("\n\n"),
    matched: [...matched]
  };
}

/** Cut `lines` at the given heading positions, carrying each heading's ancestry. */
function cutAt(lines: readonly string[], cuts: readonly HeadingLine[], ancestry: readonly string[]): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const boundaries = [...cuts.map((cut) => cut.lineIndex), lines.length];

  // Everything before the first cut is the preamble — it belongs to the parent
  // heading, so it keeps the ancestry it was handed and adds nothing.
  if (boundaries[0] > 0) {
    sections.push({ headingPath: [...ancestry], index: 0, text: lines.slice(0, boundaries[0]).join("\n") });
  }
  cuts.forEach((cut, position) => {
    sections.push({
      headingPath: [...ancestry, cut.title],
      index: sections.length,
      text: lines.slice(boundaries[position], boundaries[position + 1]).join("\n")
    });
  });

  return sections;
}

/**
 * Split a document body into packable sections.
 *
 * Documents at or under `SECTION_SPLIT_THRESHOLD_CHARS` come back as a single
 * section. Longer ones are cut at their shallowest heading level; any resulting
 * section that is itself still over the threshold is cut again at the next
 * level down, and so on. A section with no deeper heading is left whole.
 */
export function splitIntoSections(body: string, thresholdChars = SECTION_SPLIT_THRESHOLD_CHARS): MarkdownSection[] {
  if (body.length <= thresholdChars) {
    return [{ headingPath: [], index: 0, text: body }];
  }

  const split = (text: string, ancestry: readonly string[], minLevel: number): MarkdownSection[] => {
    if (text.length <= thresholdChars) {
      return [{ headingPath: [...ancestry], index: 0, text }];
    }
    const lines = text.split("\n");
    const headings = findHeadings(lines).filter((heading) => heading.level >= minLevel);
    if (headings.length === 0) {
      // No heading to cut at. Returning it whole is the honest answer: the
      // packer truncates and says so, rather than this module inventing a
      // boundary the document does not have.
      return [{ headingPath: [...ancestry], index: 0, text }];
    }
    const level = Math.min(...headings.map((heading) => heading.level));
    const cuts = headings.filter((heading) => heading.level === level);
    // A single cut at position 0 would recurse on the same text forever: the
    // whole document IS that one section. Descend a level instead.
    if (cuts.length === 1 && cuts[0].lineIndex === 0) {
      const inner = split(lines.slice(1).join("\n"), [...ancestry, cuts[0].title], level + 1);
      return inner.map((section, index) => ({
        ...section,
        index,
        text: index === 0 ? `${lines[0]}\n${section.text}` : section.text
      }));
    }
    return cutAt(lines, cuts, ancestry).flatMap((section) =>
      split(section.text, section.headingPath, level + 1).map((deeper) => ({
        headingPath: deeper.headingPath,
        index: 0,
        text: deeper.text
      }))
    );
  };

  return split(body, [], 1).map((section, index) => ({ ...section, index }));
}
