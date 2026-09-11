import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { outlineOf } from "../src/markdownSections.js";

/**
 * Tested through the PUBLIC surface rather than the private helper: `outlineOf`
 * is what the MCP server exposes, so this is the path a forged heading actually
 * travels. Exporting the helper to test it would have measured something the
 * server does not call.
 */

/**
 * The renderer that writes session notes escapes a forged turn heading, and this
 * module decides what counts as a heading when those notes are read back. Two
 * implementations of one notion, in two languages, and nothing compared them.
 *
 * So these tests compare them. The separator class is lifted out of the shell
 * source rather than restated, for the same reason the log redactor lifts its
 * vocabulary: a spelled-out copy is exactly what drifts.
 */
const RENDERER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "skills",
  "session-archive",
  "archive-session.sh"
);

/** Every separator JavaScript's `\s` accepts, one per name. */
const SEPARATORS: [string, string][] = [
  ["space", " "],
  ["tab", "\t"],
  ["nbsp", "\u00a0"],
  ["ideographic space", "\u3000"],
  ["en space", "\u2002"],
  ["thin space", "\u2009"],
  ["bom", "\ufeff"],
  ["form feed", "\f"],
  ["vertical tab", "\v"],
  ["line separator", "\u2028"]
];

describe("findHeadings agrees with the renderer that escapes forged headings", () => {
  it("lifts the renderer's separator class rather than restating it", () => {
    const source = readFileSync(RENDERER, "utf8");
    // The ATX escape, whatever spelling the renderer currently uses for it.
    const escape = /#\{1,6\}\[([^\]]*)\]/.exec(source);
    expect(escape, "the renderer no longer carries an ATX escape this test can read").not.toBeNull();
    // Two characters, spelled as a shell/jq class: a space and a tab.
    expect(escape?.[1]).toBe(" \\t");
  });

  it("reads a heading for no separator the renderer leaves unescaped", () => {
    const source = readFileSync(RENDERER, "utf8");
    const klass = /#\{1,6\}\[([^\]]*)\]/.exec(source)?.[1] ?? "";
    const escaped = new Set([" ", "\t"].filter((ch) => klass.includes(ch === "\t" ? "\\t" : ch)));
    // Sanity: the lift found both, so a false pass cannot come from an empty set.
    expect(escaped.size).toBe(2);

    for (const [name, separator] of SEPARATORS) {
      const isHeading = outlineOf(`##${separator}\u{1F464} User — 2026-09-12`).length > 0;
      if (escaped.has(separator)) {
        expect(isHeading, `${name} is escaped by the renderer and must still parse`).toBe(true);
      } else {
        expect(isHeading, `${name} is NOT escaped by the renderer, so it must not parse`).toBe(false);
      }
    }
  });

  it("still finds ordinary headings", () => {
    // The negative control. Narrowing the separator class must not stop the
    // parser working -- without this, a parser that found nothing would satisfy
    // every assertion above.
    const found = outlineOf(["# One", "##\tTwo", "### Three", "text", "####### Seven"].join("\n"));
    expect(found.map((entry) => entry.level)).toEqual([1, 2, 3]);
    expect(found.map((entry) => entry.heading)).toEqual(["One", "Two", "Three"]);
  });

  it("does not read an indented heading, and the renderer escapes one anyway", () => {
    // Found while writing the test above, and pinned because it is a second
    // mismatch between the same pair -- this time on INDENTATION rather than on
    // the separator.
    //
    // CommonMark allows up to three leading spaces before the hashes. The
    // renderer escapes that form (its address is ` {0,3}` before the hashes).
    // This parser allows none. So the renderer escapes a shape this parser would
    // never have read.
    //
    // That direction is the SAFE one -- nothing the parser reads goes unescaped,
    // which is the property the separator test above asserts -- so this is not a
    // forgery route. It is recorded because the functional consequence is real:
    // an indented heading in a vault note is invisible to `outlineOf`,
    // `selectSections` and the context package, and the note looks correct in a
    // reading view.
    expect(outlineOf("   ### Indented").length).toBe(0);
    expect(outlineOf("### Not indented").length).toBe(1);
  });
});
