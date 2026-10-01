/** Types for `core.mjs`. A declaration file, like `policy.d.mts`, so the module runs with bare `node`. */

import type { Kind } from "./policy.mjs";

export type Span = { start: number; end: number; kind: string };
export type Fragment = Readonly<{ text: string; kind: Kind }>;
export type RedactionResult = { status: "ok"; text: string } | { status: "omitted"; text: string; reason: string };
export type Vocabulary = Readonly<{
  anchor: RegExp;
  scheme: RegExp | null;
  schemeWords: readonly string[];
  shapes: readonly Readonly<{ kind: string; source: string }>[];
  labels?: readonly string[];
}>;

export declare const MASK: "***MASKED***";
export declare const DEFAULT_MAX_BYTES: number;
export declare const POLICY_VOCABULARY: Vocabulary;
export declare function omitted(reason: string): string;
export declare class RedactionOmitted extends Error {
  constructor(reason: string);
  reason: string;
}
export declare function mergeOverlaps(spans: Span[], length: number): Span[];
export declare function applySpansOnce(original: string, merged: Span[]): string;
export declare function collectArmorSpans(original: string): Span[];
export declare function collectCredentialSpans(
  original: string,
  options?: { vocabulary?: Vocabulary; kind?: Kind }
): Span[];
export declare function collectProtectedSpans(original: string): Span[];
export declare function withoutProtected(spans: Span[], guards: Span[]): Span[];
export declare function redactFragment(
  fragment: unknown,
  options?: { maxBytes?: number; vocabulary?: Vocabulary }
): RedactionResult;
