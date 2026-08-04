import matter from "gray-matter";
import type { DocumentMetadata } from "./types.js";

function refuseExecutableFrontmatter(): never {
  throw new Error("Executable front matter is not supported.");
}

// gray-matter honours a language tag after the opening delimiter (`---js`) and
// dispatches that block to the matching engine; its bundled `javascript` engine
// parses with a raw eval(). Vault files and client-supplied bodies are untrusted
// data, so every matter() / matter.stringify() call in this repo must pass these
// options, which replace the executable engines with throwers.
//
// gray-matter MERGES this map over its defaults (lib/defaults.js:
// `Object.assign({}, engines, opts.parsers, opts.engines)`), so an allowlist
// shaped like `{ engines: { yaml, json } }` would leave the javascript engine
// registered and the payload would still run — the engines have to be stubbed by
// name. Language tags are lower-cased before lookup, so `javascript` and `js`
// cover `js` / `javascript` / `JS` / `JavaScript`; the remaining non-default
// aliases (`coffee` / `cson` / …) are unregistered and already throw.
export const SAFE_MATTER_OPTIONS = {
  engines: {
    javascript: { parse: refuseExecutableFrontmatter, stringify: refuseExecutableFrontmatter },
    js: { parse: refuseExecutableFrontmatter, stringify: refuseExecutableFrontmatter }
  }
};

// Keys a client may patch on an existing document via plan_document_update.
// `id` (document identity) and `updated_at` (server-stamped) are intentionally
// excluded. Any other key is rejected to block frontmatter/YAML field injection
// from an untrusted MCP client (Reusable Security Baseline: frontmatter allowlist).
export const PATCHABLE_FRONTMATTER_KEYS = ["client", "project", "title", "tags", "source_refs"] as const;

const PATCHABLE_FRONTMATTER_KEY_SET = new Set<string>(PATCHABLE_FRONTMATTER_KEYS);

export function assertFrontmatterPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const validated: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE_FRONTMATTER_KEY_SET.has(key)) {
      throw new Error(
        `Frontmatter key not allowed in patch: ${key}. Allowed keys: ${PATCHABLE_FRONTMATTER_KEYS.join(", ")}.`
      );
    }

    validated[key] = validatePatchValue(key, value);
  }

  return validated;
}

function validatePatchValue(key: string, value: unknown): unknown {
  if (key === "client" || key === "project" || key === "title") {
    if (typeof value !== "string") {
      throw new Error(`Frontmatter key ${key} must be a string.`);
    }
    return value;
  }

  if (key === "tags" || key === "source_refs") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`Frontmatter key ${key} must be an array of strings.`);
    }
    return value;
  }

  throw new Error(`Unsupported frontmatter key: ${key}.`);
}

export function parseMarkdown(raw: string): { frontmatter: DocumentMetadata; body: string } {
  const parsed = matter(raw, SAFE_MATTER_OPTIONS);
  // Reject anchor/alias expansion bombs BEFORE anything materializes the parsed
  // frontmatter as text (normalizeMetadata's String(), JSON.stringify on the
  // fetch path). See assertBoundedFrontmatterExpansion.
  assertBoundedFrontmatterExpansion(parsed.data, raw);
  return {
    frontmatter: normalizeMetadata(parsed.data as DocumentMetadata),
    body: parsed.content
  };
}

// --- YAML anchor/alias expansion guard --------------------------------------
// js-yaml resolves an alias (`*a`) as a SHARED REFERENCE to the anchored node,
// so a ~1 KB block of nested anchors parses cheaply while describing a tree
// with exponentially many nodes. Nothing pays for that until something walks
// the value as a tree — `String()` in toStringArray below, `JSON.stringify` of
// the fetched document in src/server.ts — at which point the single-threaded
// event loop blocks while allocating toward the V8 max-string limit (a fatal
// heap OOM on a memory-capped host). Vault content is untrusted (web clips,
// and an `append_audit_report` body is arbitrary client text that later scans
// walk), so the always-on read path must bound this.
//
// The check below walks the parsed value the way a stringifier walks it —
// revisiting a shared node once per reference, which IS the expansion — with an
// explicit stack, accumulating the size the output would have, and gives up as
// soon as that exceeds a budget derived from the size of the YAML the client
// actually wrote. Work is therefore proportional to the budget, never to the
// expansion, and a cycle (`a: &x {b: *x}`) terminates because every visit adds
// at least one byte. Throwing lets parseMarkdownSafe degrade the note exactly
// like any other malformed frontmatter (empty frontmatter, raw body,
// parseError), so one hostile note never aborts a whole vault scan.
//
// Rejected alternatives: counting `&`/`*` lexically (false-positives on
// `title: "a & b"` and `**bold**` inside a folded scalar), capping the
// frontmatter block size (the bomb is a few hundred bytes), and capping the
// alias count (misses one large scalar aliased many times).

/** Minimum expansion allowed regardless of input size. Nothing this small hurts. */
const EXPANSION_BUDGET_FLOOR_BYTES = 64 * 1024;
/**
 * Expansion allowed per byte of frontmatter source. Measured amplification of
 * legitimate frontmatter under this accounting: 0.98x for a session-archive
 * index note with 900 `source_refs`, 0.84x for a 5000-entry block tag list,
 * 2.0x for the worst legitimate shape (flow-style one-character tags), and
 * 4.3x for an all-`!!timestamp` block (Dates are charged OPAQUE_LEAF_BYTES).
 * 16x keeps at least 3.7x headroom over every one of those.
 */
const EXPANSION_BUDGET_MULTIPLIER = 16;
/** Serialized size charged to a non-container object (a `!!timestamp` Date, …). */
const OPAQUE_LEAF_BYTES = 64;
/** Serialized size charged per byte of a `!!binary` Buffer (`{"type":"Buffer","data":[…]}`). */
const BINARY_BYTE_BYTES = 4;

const FRONTMATTER_DELIMITER = "---";

/**
 * Upper bound on the YAML block gray-matter parsed out of `raw`, derived ONLY
 * from `raw`.
 *
 * Deliberately NOT `parsed.matter`: gray-matter defines that property as
 * non-enumerable (lib/to-file.js) and its content-keyed cache returns
 * `Object.assign({}, cached)` (index.js), which drops non-enumerable
 * properties. It is therefore `undefined` for every repeat parse of content the
 * process has already seen — a budget read from it would silently collapse to
 * the floor on the second read of a note and strip the metadata off large but
 * perfectly legitimate frontmatter (a session-archive index with hundreds of
 * `source_refs`). Reading `raw` keeps the budget identical on the first parse
 * and every repeat parse of identical content.
 *
 * Over-estimating is safe (a looser budget, never a false positive), so any
 * input that does not look like default-delimited frontmatter falls back to the
 * whole input length.
 */
function frontmatterSourceLength(raw: string): number {
  if (!raw.startsWith(FRONTMATTER_DELIMITER)) {
    return raw.length;
  }
  const close = raw.indexOf("\n" + FRONTMATTER_DELIMITER, FRONTMATTER_DELIMITER.length);
  return close === -1 ? raw.length : close;
}

function assertBoundedFrontmatterExpansion(data: unknown, raw: string): void {
  const budget = Math.max(EXPANSION_BUDGET_FLOOR_BYTES, frontmatterSourceLength(raw) * EXPANSION_BUDGET_MULTIPLIER);
  const pending: unknown[] = [data];
  let expanded = 0;

  while (pending.length > 0) {
    const node = pending.pop();

    if (typeof node === "string") {
      expanded += node.length + 2; // quotes
    } else if (node === null || node === undefined) {
      expanded += 4;
    } else if (typeof node === "number" || typeof node === "boolean" || typeof node === "bigint") {
      expanded += String(node).length;
    } else if (Array.isArray(node)) {
      expanded += 2 + node.length; // brackets + one separator per element
      for (const item of node) {
        pending.push(item);
      }
    } else if (typeof node === "object") {
      if (ArrayBuffer.isView(node)) {
        // `!!binary` yields a Buffer, which serializes one decimal per byte.
        expanded += 2 + node.byteLength * BINARY_BYTE_BYTES;
      } else {
        const prototype = Object.getPrototypeOf(node) as object | null;
        const isPlainMap = prototype === Object.prototype || prototype === null;
        expanded += isPlainMap ? 2 : OPAQUE_LEAF_BYTES; // braces, or a Date's serialized form
        for (const [key, value] of Object.entries(node)) {
          expanded += key.length + 4; // quoted key, colon, separator
          pending.push(value);
        }
      }
    } else {
      expanded += OPAQUE_LEAF_BYTES;
    }

    if (expanded > budget) {
      throw new Error(
        `Frontmatter expands to more than ${budget} bytes when serialized ` +
          `(YAML anchor/alias expansion); refusing to materialize it.`
      );
    }
  }
}

// Fault-tolerant wrapper used on the read path. A single vault document with
// malformed frontmatter — broken YAML/JSON, raw control characters that leak in
// from a web clipping, or a refused executable language tag (`---js`, see
// SAFE_MATTER_OPTIONS) — makes gray-matter throw. Because the store parses
// every file when listing/searching, one such file would otherwise abort the
// whole operation (search / list / fetch / trace all fail). Instead we swallow
// the parse error, fall back to empty frontmatter over the raw body so the note
// stays searchable by body/path, and hand the error message back to the caller
// (which logs only the file path, never the content). Containment checks run
// before this and are unaffected.
export function parseMarkdownSafe(raw: string): {
  frontmatter: DocumentMetadata;
  body: string;
  parseError?: string;
} {
  try {
    return parseMarkdown(raw);
  } catch (error) {
    return {
      frontmatter: normalizeMetadata({} as DocumentMetadata),
      body: raw,
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

export function serializeMarkdown(frontmatter: DocumentMetadata, body: string): string {
  // The body is untrusted client input (`body` / `new_body`), so it is handed
  // over as a file OBJECT, never as a string: matter.stringify() re-parses a
  // string argument (`if (typeof file === 'string') file = matter(file, options)`)
  // before writing it, which would (a) run a front-matter engine over that input
  // and (b) merge any leading `---` block of the body into the emitted
  // frontmatter (lib/stringify.js: `Object.assign({}, file.data, data)`),
  // smuggling keys past the write-time allowlist (INV-2). With `{ content }`
  // there is no `file.data`, so only the server-computed metadata is emitted and
  // a body that starts with `---` is written through verbatim.
  return matter.stringify({ content: body.trimEnd() + "\n" }, normalizeMetadata(frontmatter), SAFE_MATTER_OPTIONS);
}

export function normalizeMetadata(input: DocumentMetadata): DocumentMetadata {
  const metadata: DocumentMetadata = { ...input };

  // YAML auto-types unquoted scalars: `tags: [2024]` yields numbers, `client:
  // 2024` a number, `enabled: true` a boolean. Such frontmatter parses fine (so
  // parseMarkdownSafe never sees an error), but the read path then does string
  // work on these fields — `tag.toLowerCase()` in search, `client.localeCompare()`
  // in list_projects — which throws on a non-string and aborts search /
  // list_projects for the ENTIRE vault, not just the one bad note. Coerce the
  // fields we treat as strings here, at the single read-path chokepoint. This
  // normalizes already-parsed vault data only; the write-time field allowlist
  // (assertFrontmatterPatch) is untouched, so INV-2 is unaffected.
  metadata.tags = toStringArray(metadata.tags);
  metadata.source_refs = toStringArray(metadata.source_refs);
  const client = toOptionalString(metadata.client);
  const project = toOptionalString(metadata.project);
  if (client === undefined) delete metadata.client;
  else metadata.client = client;
  if (project === undefined) delete metadata.project;
  else metadata.project = project;

  return metadata;
}

/** Coerce a frontmatter value into a `string[]`, stringifying non-string elements. */
function toStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item != null).map((item) => (typeof item === "string" ? item : String(item)));
}

/** Coerce a present-but-non-string scalar to a string; leave absent values absent. */
function toOptionalString(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : String(value);
}

export function titleFromMarkdown(relativePath: string, frontmatter: DocumentMetadata, body: string): string {
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }

  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return heading;
  }

  return relativePath.replace(/\.md$/i, "").split("/").pop() || relativePath;
}
