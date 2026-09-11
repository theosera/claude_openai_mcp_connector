#!/usr/bin/env node
/**
 * Shared log redaction for the ops-logging and session-archive hooks.
 *
 * The contract that matters: **every span is decided against the ORIGINAL text,
 * and substitution happens once, at the end.**
 *
 * What this replaces ran about eighteen `sed` rules in sequence, so each rule's
 * output was the next rule's input. That single property produced three separate
 * leaks: a PEM marker was consumed before the range address that needed it, an
 * `authorization` anchor was consumed before the keyword rule that needed it, and
 * a closing quote was consumed before the quoted-value rule that needed it.
 * Reordering could not settle it -- moving the PEM rules ahead of the keyword
 * rules closed the marker case and opened the anchor case, measured both ways --
 * because the fault was the sequencing itself, not the sequence.
 *
 * An adversarial review then reconstructed a usable private key from a masked
 * note by rewrapping the body at eight characters per line, putting every line
 * under both floors the old design relied on. The outer fence was undamaged, so
 * the note read as successfully redacted. That case is why length-based floors
 * are not part of the armor path here at all.
 *
 * Stage 2 of the repair: this file carries the span machinery and the entry
 * point. The two collectors are stubs, on purpose -- stages 3 and 4 fill them in
 * against the acceptance tests, and keeping them empty here means the merge and
 * substitution logic is tested on its own before any pattern work lands.
 */

import { pathToFileURL } from "node:url";

/** What a redacted span is replaced with. Matches the previous hooks' token. */
export const MASK = "***MASKED***";

/**
 * Used when a fragment cannot be analysed to completion -- an unterminated
 * armor block, a parse failure, an over-size input. The body is dropped and the
 * reason recorded. Deliberately NOT the same token as MASK: a reader has to be
 * able to tell "this was redacted" from "this could not be stored".
 */
export function omitted(reason) {
  return `***LOG_CONTENT_OMITTED: ${reason}***`;
}

/** Per-fragment ceiling. Over this, the body is omitted rather than scanned. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * @typedef {{ start: number, end: number, kind: string }} Span
 * @typedef {{ text: string, status: "ok" | "omitted", reason?: string }} RedactionResult
 */

/**
 * Spans are half-open `[start, end)` over JavaScript string indices -- never
 * UTF-8 byte offsets. Mixing the two is the kind of error that shows up only on
 * non-ASCII input, so the unit is fixed here and asserted rather than assumed.
 */
function assertSpan(span, length) {
  const { start, end, kind } = span;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new TypeError(`span bounds must be integers: ${JSON.stringify(span)}`);
  }
  if (typeof kind !== "string" || kind.length === 0) {
    throw new TypeError(`span needs a kind: ${JSON.stringify(span)}`);
  }
  if (start < 0 || end > length) {
    throw new RangeError(`span out of range for a ${length}-char input: ${JSON.stringify(span)}`);
  }
  if (end <= start) {
    throw new RangeError(`span must be non-empty and forward: ${JSON.stringify(span)}`);
  }
}

/**
 * Sorts by start and folds overlapping or touching spans together. Touching
 * spans are merged as well: `[0,4)` and `[4,8)` describe one run, and leaving
 * them apart would emit two adjacent masks where one belongs.
 *
 * @param {Span[]} spans
 * @param {number} length
 * @returns {Span[]}
 */
export function mergeOverlaps(spans, length) {
  for (const span of spans) assertSpan(span, length);
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end) {
      // Keep both kinds visible: which collector claimed a run is the first
      // thing anyone debugging a wrong mask will want.
      last.end = Math.max(last.end, span.end);
      if (!last.kind.split("+").includes(span.kind)) last.kind = `${last.kind}+${span.kind}`;
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

/**
 * Rebuilds the text with each merged span replaced once. The original is never
 * mutated and never re-scanned, which is the whole point of the design.
 *
 * @param {string} original
 * @param {Span[]} merged
 * @returns {string}
 */
export function applySpansOnce(original, merged) {
  let out = "";
  let at = 0;
  for (const span of merged) {
    out += original.slice(at, span.start) + MASK;
    at = span.end;
  }
  return out + original.slice(at);
}

/**
 * Thrown when a fragment cannot be analysed to completion. `collectArmorSpans`
 * returns spans, so it has no way to say "omit this body" in its return value --
 * and guessing a span would be worse than saying so. `redactText` catches this
 * and emits the omission token.
 */
export class RedactionOmitted extends Error {
  constructor(reason) {
    super(reason);
    this.name = "RedactionOmitted";
    this.reason = reason;
  }
}

/**
 * The armor forms, each with its OWN begin/end spelling.
 *
 * One widened regex was tried and rejected twice. `[A-Z0-9 ]*PRIVATE KEY` admits
 * `SSH2 ENCRYPTED PRIVATE KEY` but not the delimiters ssh-keygen actually writes
 * (`---- BEGIN ... ----`: four dashes and a space, per SSH_COM_PRIVATE_BEGIN),
 * and it rejects `PGP PRIVATE KEY BLOCK` outright because the label continues
 * past `PRIVATE KEY`. Widening it further to admit ` BLOCK` then made the
 * negated address on the quoted rules skip those lines, which lost coverage the
 * narrow version had. Separate forms have no such coupling.
 *
 * Public armor is deliberately absent. An opened span removes its whole body, so
 * treating a certificate as secret destroys readable data for no gain; the
 * marker-less base64 catch-all is where a stray key body is caught instead.
 */
const ARMOR_FORMS = [
  {
    kind: "armor:pem",
    // Any prefix modifier, digits included, as long as the label ENDS at
    // `PRIVATE KEY`. Covers PRIVATE KEY, RSA, EC, DSA, ENCRYPTED, OPENSSH and
    // SSH2 when written with PEM delimiters.
    begin: /-{5}BEGIN ([A-Z0-9][A-Z0-9 ]*PRIVATE KEY|PRIVATE KEY)-{5}/g,
    end: (label) => `-----END ${label}-----`
  },
  {
    kind: "armor:ssh2",
    // `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----`. The five-dash spelling of
    // the same label is covered by the PEM form above; this one exists because
    // the four-dash form leaked 3 of 3 body lines under every earlier version.
    begin: /-{4} BEGIN ([A-Z0-9][A-Z0-9 ]*PRIVATE KEY) -{4}/g,
    end: (label) => `---- END ${label} ----`
  },
  {
    kind: "armor:pgp",
    // `PGP PRIVATE KEY BLOCK` continues past `PRIVATE KEY`, and `PGP MESSAGE`
    // never says it at all. Neither is reachable by widening the PEM label.
    begin: /-{5}BEGIN (PGP PRIVATE KEY BLOCK|PGP MESSAGE)-{5}/g,
    end: (label) => `-----END ${label}-----`
  }
];

/**
 * Collects the span of every recognised private-key block, decided against the
 * original text.
 *
 * No length floor anywhere. The previous design masked runs of 12+ inside the
 * range and whole lines of 32+ outside it, so rewrapping a key body at eight
 * characters per line slipped under both and the key survived whole -- an
 * adversarial review reconstructed a working key that way, through the real
 * renderer, with the outer fence intact. A recognised block's body belongs to
 * the span whatever its lines look like.
 *
 * The span runs from the first character of the BEGIN delimiter to the last
 * character of the matching END, so anything after END on the same line -- a
 * commit sha, a path -- survives. Line breaks inside the span are preserved:
 * each line contributes its own span, which keeps the note's line count and
 * therefore the renderer's fence measurement unchanged. Replacing whole lines,
 * newlines included, is what once let a collapsed line close a fence early and
 * promote tool output into prose; that shape is not coming back.
 *
 * @param {string} original
 * @returns {Span[]}
 */
export function collectArmorSpans(original) {
  const spans = [];
  for (const form of ARMOR_FORMS) {
    const begin = new RegExp(form.begin.source, "g");
    let match;
    while ((match = begin.exec(original)) !== null) {
      const label = match[1];
      const closing = form.end(label);
      const from = match.index + match[0].length;
      const at = original.indexOf(closing, from);
      if (at < 0) {
        // BEGIN with no matching END of the same form. A span to end-of-input
        // would swallow later fragments' worth of text on a guess, and leaving
        // it open is how prefixed bodies leaked before. Omit the body instead
        // and say why.
        throw new RedactionOmitted("unterminated_private_armor");
      }
      // A nested BEGIN of the same form before the END means the input does not
      // describe one block, and picking an interpretation here would be a guess.
      const nested = original.slice(from, at).search(new RegExp(form.begin.source));
      if (nested >= 0) throw new RedactionOmitted("nested_private_armor");

      const start = match.index;
      const end = at + closing.length;
      // Split on line boundaries so the newlines themselves stay in the output.
      let lineStart = start;
      for (let index = start; index < end; index += 1) {
        const ch = original[index];
        if (ch !== "\n" && ch !== "\r") continue;
        if (index > lineStart) spans.push({ start: lineStart, end: index, kind: form.kind });
        lineStart = index + 1;
      }
      if (end > lineStart) spans.push({ start: lineStart, end, kind: form.kind });
      begin.lastIndex = end;
    }
  }
  return spans;
}

/**
 * Stage 4 fills this in: keyword values, auth schemes, token shapes and URL
 * credentials, each located in the original text. A five-dash run is an ordinary
 * value character here -- the boundary that made it a terminator is what broke
 * quoted values wholesale.
 *
 * @param {string} _original
 * @returns {Span[]}
 */
export function collectCredentialSpans(_original) {
  return [];
}

/**
 * Redacts one fragment. A fragment is one tool_result, one thinking block, one
 * tool_input, one user/assistant text turn, or one recorded shell command --
 * never a whole log, so a marker in one fragment cannot open a range across the
 * next.
 *
 * @param {string} original
 * @param {{ maxBytes?: number }} [options]
 * @returns {RedactionResult}
 */
export function redactText(original, options = {}) {
  if (typeof original !== "string") {
    return { text: omitted("non_string_input"), status: "omitted", reason: "non_string_input" };
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(original, "utf8") > maxBytes) {
    return { text: omitted("fragment_over_limit"), status: "omitted", reason: "fragment_over_limit" };
  }

  try {
    // Both collectors read the SAME original. Neither sees the other's output,
    // which is what makes their order irrelevant -- the invariant that replaces
    // the old rule-ordering pins.
    const spans = [...collectArmorSpans(original), ...collectCredentialSpans(original)];
    const merged = mergeOverlaps(spans, original.length);
    return { text: applySpansOnce(original, merged), status: "ok" };
  } catch (error) {
    // No fallback to the original text. Failing open is what the old
    // `redactor || cat` shape would have done, and it is the one outcome worse
    // than losing the body.
    const reason =
      error instanceof RedactionOmitted
        ? error.reason
        : error instanceof RangeError || error instanceof TypeError
          ? "span_contract_violated"
          : "redaction_failed";
    return { text: omitted(reason), status: "omitted", reason };
  }
}

/**
 * Batch entry for the archive hook, which has hundreds of fragments per note and
 * cannot afford a process per fragment. State resets between items.
 *
 * @param {string[]} fragments
 * @param {{ maxBytes?: number }} [options]
 * @returns {RedactionResult[]}
 */
export function redactFragments(fragments, options = {}) {
  if (!Array.isArray(fragments)) throw new TypeError("redactFragments expects an array");
  return fragments.map((fragment) => redactText(fragment, options));
}

/** Reads NDJSON fragments on stdin, writes NDJSON results on stdout. */
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");
  const lines = input.split("\n").filter((line) => line.length > 0);
  for (const line of lines) {
    let fragment;
    try {
      fragment = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ text: omitted("fragment_not_json"), status: "omitted", reason: "fragment_not_json" })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify(redactText(typeof fragment === "string" ? fragment : String(fragment)))}\n`);
  }
}

// Importing this file must not run the CLI -- the tests import it directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ text: omitted("redaction_failed"), status: "omitted", reason: "redaction_failed" })}\n`);
    process.exitCode = 0;
  });
}
