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
 * Chunked normalization: one base code point plus everything that folds onto it
 * is normalized as a unit, so decomposed sequences still compose (NFD `か` +
 * U+3099 → `が`, the macOS filesystem case) while every produced character keeps
 * a source offset.
 *
 * A chunk must cover every sequence NFKC would join, or this function disagrees
 * with `normalizeForMatch` and a snippet cannot find a match that scoring
 * already counted. Three cases:
 *
 * - trailing combining marks (`\p{M}`), grabbed by the pattern;
 * - Hangul jamo runs, which compose L+V+T across code points that carry no
 *   combining marks — kept together by the first alternative;
 * - characters that are not marks themselves but whose compatibility form
 *   *begins* with one — half-width voiced sound marks (U+FF9E/U+FF9F → U+3099/
 *   U+309A) are the practical case, so `ｶﾞ` folds to composed `ガ` rather than a
 *   decomposed pair. These are detected after folding rather than enumerated,
 *   so the rule holds for any such character.
 *
 * Building the offset map costs an array the length of the folded text, so this
 * runs only for the documents actually returned on a page — scoring uses the
 * map-free `normalizeForMatch`.
 */
export function normalizeWithMap(value: string): NormalizedWithMap {
  // Hangul jamo blocks (L/V/T), then "one code point + its combining marks".
  const chunkPattern = /[ᄀ-ᇿꥠ-꥿ힰ-퟿]+|.\p{M}*/gsu;
  const chunks: Array<{ source: string; index: number }> = [];

  for (const match of value.matchAll(chunkPattern)) {
    const previous = chunks[chunks.length - 1];
    if (previous && /^\p{M}/u.test(normalizeForMatch(match[0]))) {
      previous.source += match[0];
      continue;
    }
    chunks.push({ source: match[0], index: match.index });
  }

  let text = "";
  const map: number[] = [];
  for (const chunk of chunks) {
    const folded = normalizeForMatch(chunk.source);
    for (let i = 0; i < folded.length; i += 1) {
      map.push(chunk.index);
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
