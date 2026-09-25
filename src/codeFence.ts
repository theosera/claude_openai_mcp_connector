/**
 * Fenced code blocks, decided the way CommonMark and the session-archive
 * renderer decide them — and nowhere else.
 *
 * Two readers of a vault note used to carry their own copy of this rule:
 * `findHeadings` (the outline, `sections:` and the context package) and
 * `countCharacters` (the token estimate). Both accepted `\s{0,3}` before the run
 * and closed a block on ANY same-character run of at least the opener's length,
 * whatever followed it. CommonMark, and the renderer that sizes each fence to its
 * content, accept 0–3 real spaces only, and close only when nothing but
 * whitespace follows the run. So `~~~~~~ x`, a tab or a no-break space before
 * six tildes were content to the renderer and to Obsidian's reading view, and a
 * closing fence to the two readers here — a forged `## 👤 User — …` behind one
 * of them was a heading on the MCP side and a code block on the one surface a
 * human checks. Both readers now call this module, so the rule cannot drift
 * between them again.
 */

export interface OpenFence {
  /** The fence character, backtick or tilde. */
  char: "`" | "~";
  /** The opening run's length; a closer must be at least this long. */
  length: number;
}

/**
 * A text cut into lines at the CommonMark line endings, keeping each ending so
 * any range of lines can be put back byte for byte.
 */
export interface SplitLines {
  lines: string[];
  /** The ending that followed `lines[i]`: "\n", "\r\n", "\r", or "" after the last line. */
  endings: string[];
}

/**
 * Cut `text` into lines the way CommonMark does: LF, CRLF and a BARE CR each end a
 * line, and nothing else does (U+2028 / U+2029, form feed and U+0085 do not).
 *
 * Every reader here used to split on "\n" alone, while the session-archive
 * renderer measures and escapes on LF and CR both (A-53). So `text\r## Fake`
 * was one line to the outline and two to CommonMark, and a fence closed by a
 * CR-delimited run was still open here: the renderer and the reader disagreed
 * about which lines were headings in a note that is served back over MCP.
 * One pass, linear in the text.
 */
export function splitLines(text: string): SplitLines {
  const lines: string[] = [];
  const endings: string[] = [];
  const ending = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = ending.exec(text); match !== null; match = ending.exec(text)) {
    lines.push(text.slice(start, match.index));
    endings.push(match[0]);
    start = match.index + match[0].length;
  }
  lines.push(text.slice(start));
  endings.push("");
  return { lines, endings };
}

/**
 * Lines `start` (inclusive) to `end` (exclusive), rejoined with the endings they
 * came with — never with "\n", which would rewrite a CR or CRLF note on the way
 * out. The ending after the last line of the range is not included.
 */
export function joinLines(split: SplitLines, start: number, end: number): string {
  let text = "";
  for (let index = start; index < end; index += 1) {
    text += split.lines[index];
    if (index < end - 1) {
      text += split.endings[index];
    }
  }
  return text;
}

/**
 * 0–3 spaces (never tabs or other whitespace), the run, then the info string.
 * `s`: the info string may hold U+2028 / U+2029, which are not line endings to
 * CommonMark but stop a plain `.`, so without it such a line opened no fence here
 * and every line after it was read as top-level Markdown.
 */
const OPENER = /^ {0,3}(`{3,}|~{3,})(.*)$/s;
/** 0–3 spaces, a run, and nothing but spaces or tabs after it. */
const CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * The fence a line opens, or `undefined` when it opens none.
 *
 * A backtick fence's info string may not contain a backtick (CommonMark 4.5); a
 * tilde fence's may contain anything, which is why the renderer fences untrusted
 * content with tildes and why a labelled tilde run is still a valid opener.
 */
export function fenceOpening(line: string): OpenFence | undefined {
  const opener = OPENER.exec(line);
  if (!opener) {
    return undefined;
  }
  const run = opener[1];
  const char = run[0] as "`" | "~";
  if (char === "`" && opener[2].includes("`")) {
    return undefined;
  }
  return { char, length: run.length };
}

/** Does this line close `fence`? Same character, at least as long, and nothing else on the line. */
export function fenceCloses(line: string, fence: OpenFence): boolean {
  const closer = CLOSER.exec(line);
  return closer !== null && closer[1][0] === fence.char && closer[1].length >= fence.length;
}
