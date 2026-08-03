/**
 * Query segmentation for scripts that do not put spaces between words.
 *
 * The search matches substrings of the folded body, so only the QUERY needs
 * splitting: `検索エンジン設計` typed as one whitespace-delimited token is one
 * substring, and a note that says `検索エンジンの設計` never matches it. Cutting
 * the token into words gives each piece its own chance to hit.
 *
 * `Intl.Segmenter` is used where available — Node ships full ICU from 22.12 up
 * (this package's floor), so this costs no dependency. A character-bigram split
 * covers runtimes built with small-icu: cruder, but it still turns one dead
 * substring into pieces that can match.
 */

// The scripts that do not delimit words with whitespace. Script properties
// rather than code-point ranges: they cover half-width katakana, the CJK
// extension blocks, and Hangul jamo without spelling each range out.
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function containsCjk(value: string): boolean {
  return CJK_PATTERN.test(value);
}

type WordSegmenter = { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> };

// Built once: constructing a Segmenter per query is measurably expensive, and
// the instance is stateless. `undefined` marks a runtime without full ICU, which
// selects the bigram fallback below.
const wordSegmenter: WordSegmenter | undefined = (() => {
  try {
    const segmenterCtor = (Intl as { Segmenter?: new (locale: string, options: object) => WordSegmenter }).Segmenter;
    return segmenterCtor ? new segmenterCtor("ja", { granularity: "word" }) : undefined;
  } catch {
    return undefined;
  }
})();

/** True when the platform can segment words (false selects the bigram fallback). */
export function hasIntlSegmenter(): boolean {
  return wordSegmenter !== undefined;
}

/** Overlapping character bigrams: `検索設計` → ["検索", "索設", "設計"]. */
export function bigrams(value: string): string[] {
  const codePoints = [...value];
  if (codePoints.length < 2) {
    return codePoints.length === 1 ? [value] : [];
  }
  const output: string[] = [];
  for (let i = 0; i < codePoints.length - 1; i += 1) {
    output.push(codePoints[i] + codePoints[i + 1]);
  }
  return output;
}

/**
 * Segmenting `日本語のテスト` yields the particle `の`, which occurs in nearly
 * every Japanese note — scoring it would add noise to every document without
 * distinguishing any of them. A lone hiragana character is a particle or an
 * inflection ending, never a topic; a lone kanji or katakana character can be a
 * word on its own, so only hiragana is dropped.
 */
function isNoiseSegment(segment: string): boolean {
  return [...segment].length === 1 && /^[ぁ-ゟ]$/u.test(segment);
}

/**
 * Split one already-folded query token into sub-terms. Returns `[]` for a token
 * that needs no splitting (pure ASCII, or a single word), so the caller can keep
 * scoring the token whole and treat sub-terms as an addition rather than a
 * replacement — that is what keeps ASCII queries scoring exactly as before.
 */
export function segmentQueryToken(token: string): string[] {
  if (!containsCjk(token)) {
    return [];
  }

  if (wordSegmenter) {
    const words = [...wordSegmenter.segment(token)]
      .filter((piece) => piece.isWordLike !== false)
      .map((piece) => piece.segment.trim())
      .filter((piece) => piece.length > 0);
    // One word back means the token was already minimal; nothing was gained.
    if (words.length <= 1) {
      return [];
    }
    return [...new Set(words.filter((word) => !isNoiseSegment(word)))];
  }

  const pieces = bigrams(token);
  return pieces.length > 1 ? [...new Set(pieces)] : [];
}
