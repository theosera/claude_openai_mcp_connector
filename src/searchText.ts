/**
 * Search-side Unicode normalization.
 *
 * This is deliberately SEPARATE from the path normalization in `pathSafety.ts`
 * (INV-1), and the two must not be merged: path normalization is NFC because it
 * has to preserve identity (the normalized value is used for real filesystem
 * operations), while search normalization is intentionally lossy — it folds
 * compatibility variants so a query matches the text a human would consider
 * identical. Nothing here ever reaches `fs`.
 *
 * NFKC (not NFC) because a Japanese vault routinely mixes full-width and
 * half-width forms: `ＭＣＰ` / `MCP`, `ｶﾀｶﾅ` / `カタカナ`, U+3000 ideographic
 * space / U+0020. NFKC folds all of those together; NFC does not.
 */

/** Fold a string for matching. Use for both the query and the searched text. */
export function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export interface NormalizedWithMap {
  /** The folded text, safe to search with `indexOf`. */
  text: string;
  /**
   * `map[i]` is the index in the ORIGINAL string that folded character `i` came
   * from, so a match position can be translated back and the snippet sliced out
   * of the untouched source. The server never returns folded text to a client —
   * bodies are returned faithfully (INV-5).
   */
  map: number[];
}

/**
 * Chunked normalization: one base code point plus any following combining marks
 * (`\p{M}`) is folded as a unit, so decomposed sequences still compose (NFD
 * `か` + U+3099 → `が`, the macOS filesystem case) while every produced
 * character keeps a source offset. Hangul jamo runs are kept together because
 * L+V+T compose across code points that carry no combining marks.
 *
 * Building the offset map costs an array the length of the folded text, so this
 * runs only for the documents actually returned on a page — scoring uses the
 * map-free `normalizeForMatch`.
 */
export function normalizeWithMap(value: string): NormalizedWithMap {
  // Hangul jamo blocks (L/V/T), then "one code point + its combining marks".
  const chunkPattern = /[ᄀ-ᇿꥠ-꥿ힰ-퟿]+|.\p{M}*/gsu;
  let text = "";
  const map: number[] = [];

  for (const match of value.matchAll(chunkPattern)) {
    const folded = normalizeForMatch(match[0]);
    const sourceIndex = match.index;
    for (let i = 0; i < folded.length; i += 1) {
      map.push(sourceIndex);
    }
    text += folded;
  }

  return { text, map };
}

/** Translate a folded-text index back to an index in the original string. */
export function toSourceIndex(normalized: NormalizedWithMap, index: number, sourceLength: number): number {
  if (index <= 0) {
    return 0;
  }
  return index < normalized.map.length ? normalized.map[index] : sourceLength;
}
