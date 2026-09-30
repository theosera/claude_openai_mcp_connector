/** Types for `policy.mjs`. A declaration file, like `redact-log.d.mts`, so the hooks can run the module with bare `node`. */

export type Shape = Readonly<{ kind: "credential:shape"; source: string }>;
export type Kind = "command" | "text";

export declare const KEYWORDS: readonly string[];
export declare const SECRET_LABELS: readonly string[];
export declare const SCHEME_WORDS: readonly string[];
export declare const SHAPES: readonly Shape[];
export declare const KINDS: readonly Kind[];
