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

/** 0–3 spaces (never tabs or other whitespace), the run, then the info string. */
const OPENER = /^ {0,3}(`{3,}|~{3,})(.*)$/;
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
