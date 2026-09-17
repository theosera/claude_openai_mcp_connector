/**
 * Types for the shared log redactor. Written as a declaration file rather than
 * by converting the module to TypeScript: the hooks run it with bare `node`, so
 * it has to stay executable without a build step. `tsconfig.test.json` reaches
 * this through the import in the tests, so a signature drifting from the `.mjs`
 * fails `pnpm typecheck` the way a `src/` error would.
 */

/** Half-open `[start, end)` over UTF-16 code units -- never byte offsets. */
export type Span = { start: number; end: number; kind: string };

export type RedactionResult = {
  text: string;
  status: "ok" | "omitted";
  reason?: string;
};

/**
 * One credential shape lifted out of the shipped `mask()`. `source` is a
 * verbatim substring of that shell file, which the suite asserts: a pattern this
 * module merely carries would not be provenance-checkable.
 */
export type CredentialShape = { kind: string; source: string };

export type Vocabulary = {
  anchor: RegExp;
  scheme: RegExp | null;
  /**
   * The scheme words as a LIST. A non-null `scheme` proves only that one word
   * was found, which made the null check unreachable once one word came from a
   * rule of its own; the count is what detects a narrowed lift.
   */
  schemeWords: string[];
  shapes: CredentialShape[];
};

export type RedactOptions = { maxBytes?: number; vocabulary?: Vocabulary };

export type CollectCredentialOptions = { vocabulary?: Vocabulary };

export declare const MASK: string;
export declare const DEFAULT_MAX_BYTES: number;
/** Absolute path to the shipped `mask()` the vocabulary is lifted from. */
export declare const SHIPPED_MASK: string;
/** Auth-scheme words the shipped source is expected to yield. */
export declare const EXPECTED_SCHEME_WORDS: number;

export declare class RedactionOmitted extends Error {
  constructor(reason: string);
  reason: string;
}

export declare function omitted(reason: string): string;
export declare function mergeOverlaps(spans: Span[], length: number): Span[];
export declare function applySpansOnce(original: string, merged: Span[]): string;
export declare function collectArmorSpans(original: string): Span[];
export declare function collectCredentialSpans(
  original: string,
  options?: CollectCredentialOptions
): Span[];
export declare function collectProtectedSpans(original: string): Span[];
export declare function withoutProtected(spans: Span[], guards: Span[]): Span[];
export declare function vocabularyFrom(maskSource: string): Vocabulary;
export declare function defaultVocabulary(): Vocabulary;
export declare function assertUsableVocabulary(vocabulary: Vocabulary): void;
export declare function redactText(original: string, options?: RedactOptions): RedactionResult;
export declare function redactFragments(fragments: string[], options?: RedactOptions): RedactionResult[];
