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

interface HeadingLine {
  level: number;
  title: string;
  lineIndex: number;
}

/**
 * ATX headings outside fenced code blocks, in document order.
 *
 * Setext headings (`Title` over `====`) are deliberately not recognized: they
 * are rare in this vault, and a lookahead rule that fires on a line of `-`
 * characters would cut on horizontal rules and on table separators.
 */
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
      headings.push({ level: heading[1].length, title: heading[2].trim(), lineIndex });
    }
  });

  return headings;
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
