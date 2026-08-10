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
  // Bound the block BEFORE matter() runs: both quadratic paths below are paid
  // during the parse itself, so any guard that inspects the RESULT is too late.
  // See assertBoundedFrontmatterBlock.
  assertBoundedFrontmatterBlock(raw);
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

// --- Frontmatter block size bound (quadratic parse-time CPU) ----------------
// TWO independent quadratic paths run while gray-matter parses, both driven by
// the SIZE of the frontmatter block and both reachable from untrusted vault
// content on the always-on read path:
//
//   1. gray-matter's own comment stripper, `file.matter.replace(/^\s*#[^\n]+/gm, '')`.
//      The `m` flag makes every LINE START a match position, so cost is quadratic
//      in the number of line starts — not in whitespace, and not only in `\n`:
//      U+2028 and U+2029 start lines too, so counting newline characters is the
//      wrong shape of fix.
//   2. js-yaml's `!!omap` resolution (GHSA-5p4m-2wfm-xmqj, js-yaml <3.15.1).
//      `!!omap` is in the DEFAULT schema, so a plain load hits it.
//      ⚠️ Path 2 is FIXED BY THE DEPENDENCY, not by this cap. Read the advisory's
//      STRUCTURED fields, not its title: the title says "CVE-2026-59870 fix not
//      backported" while `patched_versions` on the same record says `>=3.15.1` —
//      and 3.15.1 is a real release (dist-tag `v3-legacy`) inside gray-matter's
//      `^3.13.1` range. The title is what made an earlier revision of this comment
//      claim the fix existed only in 5.x. package.json pins it through
//      `pnpm.overrides`; a plain `pnpm update` will NOT move a transitive that the
//      lockfile already considers satisfied. Measured on the
//      resolved tree: 3.15.0 quadruples per doubling (74 / 173 / 670 / 3,068 ms at
//      n = 5k / 10k / 20k / 40k) while 3.15.1 stays linear (83 / 82 / 112 / 171 ms).
//      The cap keeps path 2 bounded as defence in depth if the resolution ever
//      slides back — it is not the primary fix, and reading it as one would make
//      an out-of-date js-yaml look acceptable.
//
// Measured (Node 22, gray-matter 4.0.3 / js-yaml 3.15.0 — i.e. BEFORE the bump for
// path 2), quadrupling per doubling in both — the signature of O(n^2):
//
//   path 1, no closing delimiter   391 KB -> 101.8 s
//   path 1, closing delimiter      156 KB ->   9.1 s
//   path 2, !!omap               1,228 KB ->   3.5 s
//
// These are wall-clock on one machine. Only the EXPONENT transfers between hosts:
// the same payloads on a ~6x slower CI container scale by that factor throughout,
// so treat the absolute milliseconds as calibration, not as a threshold.
//
// A file whose frontmatter never closes is the worst case, because gray-matter
// falls back to treating the WHOLE file as the block (`if (closeIndex === -1)
// closeIndex = len`). All of this sits far inside append_audit_report's 512 KB
// ceiling.
//
// ⚠️ The block-size cap was REJECTED for the expansion bomb above, correctly:
// that bomb is a few hundred bytes, so size tells you nothing about it. It is
// the right bound HERE because size is exactly what drives these two. The guards
// are complementary, not redundant — do not delete one on the strength of the
// other.
//
// Rejected alternative: stripping or counting the characters that start a line.
// That enumerates today's line terminators, and the next person to touch it will
// count `\n` alone and silently reopen path 1. Bounding the block bounds both
// paths whatever it is filled with, and needs no knowledge of either regex.

/**
 * Largest frontmatter block accepted, in characters.
 *
 * Measured against the real vault this server was built for: 2,381 notes,
 * frontmatter median 225 B, p99 501 B, p99.9 and max 1,042 B. A 2 KiB cap would
 * already reject nothing; 8 KiB keeps ~7.9x headroom over the largest note that
 * exists while holding the attack to ~41 ms (path 1) and ~1 ms (path 2).
 *
 * That 41 ms is the UNTERMINATED shape, which is the worst case — the same as the
 * block comment above says, and the reason an earlier ~23 ms here was wrong: it
 * was the terminated shape, which is ~1.8x cheaper at the same size.
 *
 * If a legitimate note ever needs more than this, raise the DESIGN rather than
 * the number: frontmatter carrying kilobytes of `source_refs` is the smell, and
 * the failure here is loud (below) rather than silent, so it will be noticed.
 */
export const MAX_FRONTMATTER_BLOCK_BYTES = 8 * 1024;

/**
 * Refuse a frontmatter block larger than the cap, before gray-matter sees it.
 *
 * Mirrors gray-matter's own block detection (`lib/engine`/`index.js`): a block
 * exists only when the input opens with the delimiter, and it runs to the first
 * `\n---` — or to the END of the input when there is none. A file that does not
 * open with the delimiter has no block at all and is never measured here, so a
 * megabyte-long note with no frontmatter stays perfectly legal.
 *
 * ⚠️ The mirror has to include gray-matter's NORMALIZATION, not only its
 * delimiter scan. `lib/utils.js` runs the input through `strip-bom-string`
 * before `parseMatter` looks for `---`, so a file opening U+FEFF `---` HAS
 * frontmatter as far as gray-matter is concerned. Checking the raw prefix
 * skipped exactly that file, and one BOM in front of an unterminated block
 * bought back the whole quadratic path: measured on a 32 KiB payload, 0.3 ms
 * refused without the BOM against 1,129.6 ms parsed with it. `strip-bom-string`
 * removes a single leading U+FEFF and nothing else, so this does the same —
 * a second BOM is not frontmatter to gray-matter either, and must not be to us.
 *
 * The general shape of the bug is worth more than the fix: a guard that decides
 * whether a parser will do something has to model what the parser does to its
 * input FIRST, not what the caller passed in.
 *
 * Throwing (rather than degrading quietly) is what makes the cap observable:
 * `parseMarkdownSafe` turns it into a `parseError`, which the store logs with
 * the file path before indexing the note body-only, and the write paths fail
 * outright instead of dropping metadata on the floor.
 */
function assertBoundedFrontmatterBlock(input: string): void {
  const raw = input.charAt(0) === "\uFEFF" ? input.slice(1) : input;
  if (!raw.startsWith(FRONTMATTER_DELIMITER)) {
    return;
  }
  const close = raw.indexOf("\n" + FRONTMATTER_DELIMITER, FRONTMATTER_DELIMITER.length);
  const blockLength = close === -1 ? raw.length : close;
  if (blockLength > MAX_FRONTMATTER_BLOCK_BYTES) {
    throw new Error(
      `Frontmatter block is ${blockLength} bytes, over the ${MAX_FRONTMATTER_BLOCK_BYTES}-byte limit` +
        `${close === -1 ? " (no closing delimiter, so the whole file would be parsed as frontmatter)" : ""}; ` +
        "refusing to parse it."
    );
  }
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
 *
 * NOTE: the first two of those shapes can no longer reach this guard — both are
 * larger than MAX_FRONTMATTER_BLOCK_BYTES and are refused earlier. The ratios
 * are kept because a ratio does not depend on size, so they still bound what
 * legitimate frontmatter amplifies to; the tests now measure the same shapes at
 * sizes that fit under the cap.
 *
 * Those figures survived the switch to JSON-escaped string accounting
 * (jsonStringCost) unchanged: every string in every one of those shapes is
 * escape-free, so it is charged exactly `length + 2` either way. Only a string
 * carrying `"`, `\`, a control character or a lone surrogate is charged more
 * now — and that is the point, since those are what the serializer expands.
 */
const EXPANSION_BUDGET_MULTIPLIER = 16;
/** Serialized size charged to a non-container object (a `!!timestamp` Date, …). */
const OPAQUE_LEAF_BYTES = 64;
/** Serialized size charged per byte of a `!!binary` Buffer (`{"type":"Buffer","data":[…]}`). */
const BINARY_BYTE_BYTES = 4;

const FRONTMATTER_DELIMITER = "---";

/**
 * Number of characters `JSON.stringify` emits for `value`, including its two
 * quotes.
 *
 * Charging `value.length` instead is not conservative, it is wrong in the
 * attacker's favour: JSON escapes a control character as `\u0000` — SIX
 * characters — while the YAML source needs only two to write it (`\0`). Under
 * a budget of 16x the source that buys ~32 references to a scalar the walk
 * charges at 1 char each and the serializer emits at 6, so the output lands at
 * ~96x the source instead of the intended 16x. Measured on the unfixed
 * accounting: an 800 KB frontmatter block passed the guard and produced a
 * 62 MB `JSON.stringify`, which is the same heap-OOM this guard exists to
 * prevent, only bought with a larger file.
 *
 * `remaining` bounds the scan. The caller throws as soon as the running total
 * passes the budget, so returning early there keeps this walk proportional to
 * the budget rather than to the scalar it is measuring.
 */
function jsonStringCost(value: string, remaining: number): number {
  let cost = 2; // the quotes
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      cost += 2; // \" or \\
    } else if (code < 0x20) {
      // \b \t \n \f \r have two-character forms; every other control character
      // is emitted as \u00XX.
      const hasShortForm = code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
      cost += hasShortForm ? 2 : 6;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // A well-formed pair is emitted verbatim (two units, two characters); a
      // lone surrogate is escaped as \uXXXX (well-formed JSON.stringify).
      const low = code <= 0xdbff && index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        cost += 2;
        index += 1;
      } else {
        cost += 6;
      }
    } else {
      cost += 1;
    }

    if (cost > remaining) {
      return cost;
    }
  }
  return cost;
}

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
 * perfectly legitimate frontmatter (a session-archive index with dozens of
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
      expanded += jsonStringCost(node, budget - expanded);
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
          // A mapping key is a JSON string too, and a quoted YAML key can carry
          // the same escapes a value can.
          expanded += jsonStringCost(key, budget - expanded) + 2; // colon, separator
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
