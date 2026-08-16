/**
 * Dependency-free token estimation (D-3).
 *
 * `get_context` packs to a budget, so it needs to know what a chunk costs before
 * it decides to include it. A real tokenizer would be a dependency with a model
 * baked into it — the wrong shape for a server that is meant to run offline
 * against a private vault and to keep working when the client on the other end
 * changes model. This estimates instead, and is deliberately biased:
 *
 * - **Over-count rather than under-count.** A `SAFETY_FACTOR` above 1 means the
 *   packer under-fills the budget rather than overflowing it. Under-filling
 *   costs recall the caller can see (`omitted[]` says what was left out);
 *   overflowing costs the caller a truncated response it cannot see coming.
 * - **Never classify a character as free.** Every code point falls into exactly
 *   one of three buckets, and the fallback bucket is the *expensive* one. A
 *   classifier with a hole in it silently prices emoji, Cyrillic and accented
 *   Latin at zero, which is the same failure as not counting them at all.
 *
 * The divisors are characters-per-token, so a bigger divisor is a cheaper
 * character. They are exported because tuning them should be a one-line diff
 * against a test that states what it expects, not an edit hidden in a formula.
 */

/** Characters per token for plain ASCII prose. */
export const ASCII_CHARS_PER_TOKEN = 4.0;
/**
 * Characters per token for ASCII inside a fenced code block. Code is denser
 * per character than prose — identifiers, punctuation and indentation split
 * into more tokens than English words of the same length.
 */
export const CODE_ASCII_CHARS_PER_TOKEN = 3.0;
/** Characters per token for CJK. Han, kana and Hangul are close to one token each. */
export const CJK_CHARS_PER_TOKEN = 1.7;
/**
 * Characters per token for everything else — the fallback bucket. Emoji,
 * Cyrillic, Greek, accented Latin, Devanagari: all more expensive than ASCII
 * and cheaper than Han, and none of them zero.
 */
export const OTHER_CHARS_PER_TOKEN = 2.0;
/** Bias toward under-filling the budget. See the header. */
export const SAFETY_FACTOR = 1.15;

/**
 * Tokens each chunk costs in JSON framing — the field names, quoting, path,
 * title, score and relationship that ride alongside its text.
 *
 * ⚠️ This is added per chunk and NOT derived from the formula, because the
 * formula prices the *text* a chunk carries and the caller pays for the whole
 * response. A budget that only counted text would be a budget on something the
 * caller never receives on its own. The number is pinned by a test that
 * serializes a real package rather than by arithmetic here.
 */
export const CHUNK_JSON_OVERHEAD_TOKENS = 40;

/**
 * Is this code point CJK for costing purposes?
 *
 * Ranges, in order: CJK punctuation and kana (U+3000–U+30FF), CJK strokes and
 * enclosed forms (U+31C0–U+4DBF), unified ideographs (U+4E00–U+9FFF),
 * extension A already covered above, compatibility ideographs (U+F900–U+FAFF),
 * fullwidth and halfwidth forms (U+FF00–U+FFEF), Hangul jamo (U+1100–U+11FF)
 * and syllables (U+AC00–U+D7AF), and the supplementary ideograph planes
 * (U+20000–U+3FFFF).
 */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31c0 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x3ffff)
  );
}

/** Per-bucket character counts. Exposed so a test can show WHERE an estimate
 *  came from rather than only that the total moved. */
export interface CharacterCounts {
  ascii: number;
  codeAscii: number;
  cjk: number;
  other: number;
}

/**
 * Count characters by cost bucket, tracking fenced code blocks as it goes.
 *
 * A fence is a line whose first non-space characters are three or more
 * backticks or tildes; the same marker closes it. Anything still open at the
 * end of the text stays open — an unterminated fence in a note should not make
 * the rest of that note look like prose, and mis-pricing it as code only ever
 * over-counts, which is the direction this module errs in on purpose.
 */
export function countCharacters(text: string): CharacterCounts {
  const counts: CharacterCounts = { ascii: 0, codeAscii: 0, cjk: 0, other: 0 };
  let fence: string | undefined;

  for (const line of text.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      // Closing needs a marker of the same character, at least as long as the
      // one that opened — the CommonMark rule, and the reason a ```js line
      // inside a ~~~ block does not close it.
      if (fence === undefined) {
        fence = marker;
        continue;
      }
      if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
        continue;
      }
    }

    // The newline itself is a character the caller pays for.
    for (const character of `${line}\n`) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint < 128) {
        if (fence === undefined) {
          counts.ascii += 1;
        } else {
          counts.codeAscii += 1;
        }
      } else if (isCjk(codePoint)) {
        counts.cjk += 1;
      } else {
        counts.other += 1;
      }
    }
  }

  return counts;
}

/** Estimated tokens for a piece of text, excluding any JSON framing. */
export function estimateTokens(text: string): number {
  const counts = countCharacters(text);
  const raw =
    counts.ascii / ASCII_CHARS_PER_TOKEN +
    counts.codeAscii / CODE_ASCII_CHARS_PER_TOKEN +
    counts.cjk / CJK_CHARS_PER_TOKEN +
    counts.other / OTHER_CHARS_PER_TOKEN;
  return Math.ceil(raw * SAFETY_FACTOR);
}

/** What one packed chunk costs against the budget: its text plus its framing. */
export function estimateChunkTokens(text: string): number {
  return estimateTokens(text) + CHUNK_JSON_OVERHEAD_TOKENS;
}

/**
 * The longest prefix of `text` that fits in `budget` tokens, or the whole text
 * when it already does.
 *
 * Binary search over the estimator rather than a closed-form inverse: the
 * estimator is piecewise (fences, buckets) and not invertible, and searching it
 * keeps this function correct for free whenever the estimator is tuned. Returns
 * an empty string when even one character does not fit, so a caller never
 * receives a chunk it did not pay for.
 */
export function truncateToTokens(text: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }
  if (estimateTokens(text) <= budget) {
    return text;
  }
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, middle).join("")) <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return characters.slice(0, low).join("");
}
