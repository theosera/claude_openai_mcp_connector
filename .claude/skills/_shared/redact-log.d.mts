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

export type RedactOptions = { maxBytes?: number };

export declare const MASK: string;
export declare const DEFAULT_MAX_BYTES: number;

export declare class RedactionOmitted extends Error {
  constructor(reason: string);
  reason: string;
}

export declare function omitted(reason: string): string;
export declare function mergeOverlaps(spans: Span[], length: number): Span[];
export declare function applySpansOnce(original: string, merged: Span[]): string;
export declare function collectArmorSpans(original: string): Span[];
export declare function collectCredentialSpans(original: string): Span[];
export declare function redactText(original: string, options?: RedactOptions): RedactionResult;
export declare function redactFragments(fragments: string[], options?: RedactOptions): RedactionResult[];
