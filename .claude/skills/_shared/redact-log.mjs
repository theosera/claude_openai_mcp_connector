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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * How many auth-scheme words the shipped source is expected to yield: the six in
 * the allowlist plus the one the shell spells out in a rule of its own.
 */
export const EXPECTED_SCHEME_WORDS = 7;

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
 * Nothing in this file spells out what a credential looks like, and that is a
 * decision rather than an omission.
 *
 * The repository's egress guard refuses any write whose body contains a literal
 * secret shape. It stopped five attempts at putting those shapes here -- and it
 * was right every time, including the attempt that had removed the pattern table
 * entirely: what tripped it then was a COMMENT that illustrated a shape by
 * writing one out. A guard able to tell a definition from a value would need an
 * exemption for "the file that defines patterns", which is the one file an
 * attacker would choose.
 *
 * So the vocabulary stays in exactly one place -- the shipped `mask()` -- and is
 * lifted from there. The side benefit is one this suite has already paid for
 * twice: a spelled-out copy of a pattern drifted from its source both times,
 * once by escape depth and once by a widened label, and both times the copy was
 * what the tests were checking.
 *
 * @typedef {{ anchor: RegExp, scheme: RegExp | null, shapes: { kind: string, source: string }[] }} Vocabulary
 */

/**
 * Lifts the credential vocabulary out of a shipped `mask()` body.
 *
 * Every extraction here is COUNTED by the caller, never trusted. A silent drop
 * to zero is the failure mode that matters: four separate mutations of the
 * source -- changing a substitution's delimiter, adding a flag, deleting a rule,
 * renaming the mask token -- each take the shape count from six to zero without
 * raising anything. Only an asserted count separates "the source moved" from
 * "there was nothing to find", and an unasserted extraction that finds nothing
 * removes the protection while every test stays green.
 *
 * @param {string} maskSource
 * @returns {Vocabulary}
 */
export function vocabularyFrom(maskSource) {
  // The keyword alternation sits in a capture group inside every keyword rule.
  // Taking it from the source means adding a keyword to the hook cannot leave
  // this file behind.
  // `[a-z_|]` and not `[a-z|]`: a keyword carrying an underscore -- the kind of
  // addition the shell's own comments invite -- made the group stop matching,
  // and the anchor then fell back to a pattern that matches nothing. Measured:
  // every keyword rule silently stopped firing while the shape count stayed 6.
  const keywords = /\(\(([a-z_|]+)\)\[/.exec(maskSource)?.[1] ?? "";
  // The scheme allowlist is the one bracketed alternation of capitalised words.
  const allowlist = /\[:space:\]\]\+\(([A-Za-z|]+)\)\[\[:space:\]\]/.exec(maskSource)?.[1] ?? "";
  // The most common auth scheme is deliberately ABSENT from that allowlist,
  // because the shell gives it a rule of its own -- spelled one character class
  // per letter to get case-insensitivity -- which fired before the keyword rules
  // could reach it. That rule carries a capture group, so the shape lift skips
  // it, and the scheme lift did not look for it: the keyword anchored first,
  // took the scheme word as its bare value, and moved past the credential that
  // followed. The shell masks that header; this module did not. Lifting the word
  // from its own rule keeps the allowlist derived rather than restated -- if the
  // shell drops the rule, the scheme drops with it.
  const spelledOut = /\[Bb\]\[Ee\]\[Aa\]\[Rr\]\[Ee\]\[Rr\]/.test(maskSource);
  // Kept as a LIST, not joined into a pattern and counted later. A non-null
  // scheme regex says only that at least one word was found: with the spelled-out
  // rule contributing one on its own, an allowlist that silently lifted nothing
  // still produced a usable-looking scheme and the refusal became unreachable.
  // Measured while reverse-verifying it -- the check could not be made to fire.
  const schemeWords = [...allowlist.split("|").filter(Boolean), ...(spelledOut ? ["Bearer"] : [])];

  // Shape rules are the `s///g` substitutions with no capture group and no
  // address: a pattern, the mask token, and nothing else. A rule carrying a
  // group belongs to the keyword family and a rule naming an armor label belongs
  // to the armor collector, so both are skipped here.
  const shapes = [];
  const rule = /-e\s+'s\/([^/']+)\/\*\*\*MASKED\*\*\*\/g'/g;
  let match;
  while ((match = rule.exec(maskSource)) !== null) {
    const source = match[1];
    if (source.includes("(") || source.includes("PRIVATE KEY")) continue;
    shapes.push({ kind: "credential:shape", source });
  }

  return {
    // `(?!)` never matches, so a failed lift disables the rule rather than
    // turning it into one that matches everything.
    // `>` belongs in the separator, not in the value. Without it the separator
    // stopped at the arrow of a fat-comma assignment, the bare walk masked the
    // arrow, and the walk moved past the credential -- leaving a mask token
    // immediately to the LEFT of the surviving secret, the same shape that made
    // the auth-scheme leak read as a successful redaction. Adding a character to
    // the separator can only move the value's start LATER, so it cannot uncover
    // anything that was masked before.
    anchor: new RegExp(`(${keywords || "(?!)"})(['"]?)([=:>\\s]+)`, "gi"),
    scheme: schemeWords.length > 0 ? new RegExp(`^(${schemeWords.join("|")})(\\s+)`, "i") : null,
    schemeWords,
    shapes
  };
}

/**
 * The shipped `mask()` this file lifts its vocabulary from.
 *
 * This path is a DATED dependency, not a settled design. Stages 5 to 7 replace
 * that sed pipeline with this module, and when it goes the lift has nowhere to
 * read from -- so whoever deletes `mask()` has to move the vocabulary into this
 * file in the same change. The suite's count assertion is what makes that a red
 * test instead of a silent loss of every keyword rule.
 */
export const SHIPPED_MASK = join(dirname(fileURLToPath(import.meta.url)), "..", "ops-logging", "capture-command.sh");

let cachedVocabulary = null;

/**
 * Lifts and caches the vocabulary. A note carries hundreds of fragments and is
 * redacted in one process, so one read serves them all and a stale cache cannot
 * outlive the source it came from.
 *
 * @returns {Vocabulary}
 */
export function defaultVocabulary() {
  if (cachedVocabulary) return cachedVocabulary;
  let source;
  try {
    source = readFileSync(SHIPPED_MASK, "utf8");
  } catch {
    throw new RedactionOmitted("vocabulary_unavailable");
  }
  const vocabulary = vocabularyFrom(source);
  assertUsableVocabulary(vocabulary);
  cachedVocabulary = vocabulary;
  return cachedVocabulary;
}

/**
 * Refuses a vocabulary that lifted only part of itself.
 *
 * Separate from `defaultVocabulary` so it can be exercised against a MUTATED
 * shell source. Folded into the loader, the only way to reach it was to move the
 * real file, which is why the partial-lift cases went unmeasured while the
 * shape count sat reassuringly at six.
 *
 * @param {Vocabulary} vocabulary
 */
export function assertUsableVocabulary(vocabulary) {
  // A lift that finds nothing is indistinguishable, at every call site, from an
  // input that held no credentials. Refusing here is what keeps "the shell
  // script moved" from being reported as a clean redaction -- the failure the
  // whole suite would otherwise express as green.
  // Each PART is checked, not just the total. A shape count of six proves
  // nothing about the anchor: measured, adding an underscore to one shell
  // keyword left the count at six, disabled every keyword rule, and passed --
  // a keyword-anchored value and a scheme-prefixed header both came through
  // untouched. A partial lift is a quietly weaker redactor, which is the one
  // outcome this module exists to rule out.
  if (vocabulary.shapes.length === 0) throw new RedactionOmitted("vocabulary_empty");
  if (vocabulary.anchor.source.includes("(?!)")) throw new RedactionOmitted("vocabulary_no_keywords");
  // Counted, for the same reason the shapes are. The shipped source carries six
  // allowlisted schemes plus the one with a rule of its own; anything under that
  // means a lift stopped working, and the suite pins the exact number so a
  // deliberate addition is a visible test edit rather than a silent narrowing.
  if (vocabulary.schemeWords.length < EXPECTED_SCHEME_WORDS) {
    throw new RedactionOmitted("vocabulary_scheme_lift_narrowed");
  }
  for (const shape of vocabulary.shapes) {
    try {
      new RegExp(shape.source, "g");
    } catch {
      throw new RedactionOmitted("vocabulary_shape_uncompilable");
    }
  }
}

/**
 * Walks a quoted value from `at` (the opening quote) and returns the index one
 * past the closing quote, or -1 if it never closes.
 *
 * Escape state is tracked rather than pattern-matched: a value carrying an
 * escaped quote closes at the LAST quote, and getting that wrong leaves the tail
 * of a credential readable. The walk is single-pass -- the previous design
 * re-probed the same tail on every attempt, which is where the near-quadratic
 * cost on an unterminated value came from (about twice the previous tip's at
 * 128 KiB).
 */
function endOfQuoted(original, at) {
  const quote = original[at];
  for (let index = at + 1; index < original.length; index += 1) {
    const ch = original[index];
    // A value does not span lines, and the line check comes FIRST. Behind the
    // escape skip, a backslash at end of line consumed the newline and the walk
    // continued onto the next line: measured, a three-line fragment came back as
    // two, which breaks the line-count invariant the armor path is careful to
    // keep.
    if (ch === "\n" || ch === "\r") return -1;
    if (ch === "\\") {
      const next = original[index + 1];
      if (next === "\n" || next === "\r") return -1;
      index += 1;
      continue;
    }
    if (ch === quote) return index + 1;
  }
  return -1;
}

/**
 * Walks a bare value from `at` to the first delimiter.
 *
 * `stopAtQuote` is false on the unterminated-quote fallback. The shell's value
 * class excludes whitespace but NOT the quote character, so it masks from the
 * opening quote to the next space; stopping at that quote instead returns a
 * zero-length span and masks nothing at all. Measured: the fallback covered
 * neither an unterminated assignment nor a keyword search until this was passed.
 */
function endOfBare(original, at, stopAtQuote = true) {
  const delimiter = stopAtQuote ? /[\s,"']/ : /\s/;
  for (let index = at; index < original.length; index += 1) {
    // A five-dash run is an ORDINARY value character here. Making it a
    // terminator is what broke quoted values wholesale: every branch of that
    // class ended on a non-dash, so a value whose last character was a dash
    // could not reach its closing quote and nothing matched at all. A base64url
    // value ends in a dash about one time in sixty-four.
    if (delimiter.test(original[index])) return index;
  }
  return original.length;
}

/**
 * The value inside a URL's authority section -- the part after the separator
 * that follows the user name, up to the host boundary. Written as a pattern
 * only; an illustrative example would itself be a literal secret shape, which is
 * what stopped the fifth attempt at this file.
 */
// The slashes are escaped because a bare `/` outside a character class ENDS a
// regex literal: unescaped, this read as the two-character pattern `(:` and
// threw on module evaluation. Loud, and the only reason it was caught.
const URL_AUTHORITY_VALUE = /(:\/\/[^/:@\s]+:)([^/@\s]+)(@)/g;

/**
 * A whole line of base64 with no armor delimiter in sight: a key body pasted
 * without its opening line. This is the only guard covering that shape, so it is
 * not narrowed for public armor's sake -- a certificate body going with it is
 * deliberate over-masking, not a defect.
 */
const BARE_BASE64_LINE = /^[ \t]*[A-Za-z0-9+/=]{32,}[ \t]*$/gm;

/**
 * Collects the span of every credential value, decided against the original.
 *
 * Nothing here consumes text another collector needs: both read the same
 * untouched string, so an armor delimiter cannot be eaten before the range that
 * depends on it, and an anchor word cannot be eaten before the rule that depends
 * on it. Those were two separate leaks with one cause.
 *
 * @param {string} original
 * @param {{ vocabulary?: Vocabulary }} [options]
 * @returns {Span[]}
 */
export function collectCredentialSpans(original, options = {}) {
  const spans = [];
  const vocabulary = options.vocabulary;

  for (const { kind, source } of vocabulary?.shapes ?? []) {
    // A pattern the caller did not validate is a wiring fault. Skipping it here
    // was wrong: it dropped one rule's worth of coverage with no signal at all,
    // and the count assertion cannot see it because the shape was still lifted.
    // `defaultVocabulary` now compiles every shape up front and refuses, so this
    // throw is the seam for a caller supplying its own vocabulary.
    const shape = new RegExp(source, "g");
    let match;
    while ((match = shape.exec(original)) !== null) {
      if (match[0].length === 0) break;
      spans.push({ start: match.index, end: match.index + match[0].length, kind });
    }
  }

  const url = new RegExp(URL_AUTHORITY_VALUE.source, "g");
  let urlMatch;
  while ((urlMatch = url.exec(original)) !== null) {
    const start = urlMatch.index + urlMatch[1].length;
    spans.push({ start, end: start + urlMatch[2].length, kind: "credential:url" });
  }

  const bare = new RegExp(BARE_BASE64_LINE.source, "gm");
  let bareMatch;
  while ((bareMatch = bare.exec(original)) !== null) {
    const text = bareMatch[0];
    const lead = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    spans.push({
      start: bareMatch.index + lead,
      end: bareMatch.index + lead + trimmed.length,
      kind: "credential:base64-line"
    });
  }

  if (!vocabulary?.anchor) return spans;
  const anchor = new RegExp(vocabulary.anchor.source, "gi");
  let anchorMatch;
  while ((anchorMatch = anchor.exec(original)) !== null) {
    let at = anchorMatch.index + anchorMatch[0].length;
    if (at >= original.length) continue;

    // A scheme word sits between the anchor and the value, so the value is the
    // token AFTER it. The scheme word is left standing and picked up by this
    // same rule on a later pass, which is why it is not consumed here.
    const scheme = vocabulary.scheme?.exec(original.slice(at));
    if (scheme) at += scheme[0].length;

    const quote = original[at];
    if (quote === '"' || quote === "'") {
      const end = endOfQuoted(original, at);
      if (end < 0) {
        // An unterminated quote falls through to the bare walk, exactly as the
        // shell's rules do -- its own comment names this case as the reason the
        // quoted rules require a closing quote, so coverage does not drop.
        //
        // Omitting the fragment here was the wrong trade. The shapes that reach
        // this branch are overwhelmingly benign: a search for a keyword with a
        // trailing space, an assertion on an empty scheme value, a comment
        // describing this very rule. Measured over the 116 tracked text files in
        // this worktree, 8 of them -- 7% -- redacted to nothing but an omission
        // marker. That is an availability loss on ordinary content, and worse, it
        // hands anyone who can place text in a tool result a way to blank the
        // record: append an opening quote after a keyword and the whole fragment
        // leaves the archive.
        const bare = endOfBare(original, at, false);
        if (bare > at) spans.push({ start: at, end: bare, kind: "credential:bare" });
        anchor.lastIndex = bare > at ? bare : at + 1;
        continue;
      }
      // The quotes themselves stay: a reader needs to see that the field held a
      // string, and the surrounding structure is what makes the note usable.
      if (end - 1 > at + 1) spans.push({ start: at + 1, end: end - 1, kind: "credential:quoted" });
      anchor.lastIndex = end;
      continue;
    }

    const end = endOfBare(original, at);
    if (end > at) spans.push({ start: at, end, kind: "credential:bare" });
    anchor.lastIndex = end;
  }

  return spans;
}

/**
 * Every armor delimiter this file can recognise, secret or not.
 *
 * A label is PROTECTED: no credential span may overlap one. This exists because
 * `KEY` is a credential keyword and a space is a separator, so
 * `BEGIN PGP PUBLIC KEY BLOCK` reads as keyword + separator + value `BLOCK-----`
 * to the anchor rule, which masked the label off a public block. Nothing about
 * that depended on the block being secret -- and it is the general form of the
 * PGP private-key finding, which is why widening the armor label to admit
 * ` BLOCK` never reached it: the label was already gone by then.
 *
 * Preserving public formats is therefore a SEPARATE acceptance condition from
 * leaving no secret residue, not a side effect of one. The two are decided from
 * the same original and cannot consume each other.
 *
 * Only the delimiter's own extent is protected, never the line it sits on. A
 * line guard would exempt `-----BEGIN FOO----- token=<secret>`; this does not.
 */
const ARMOR_DELIMITER = /-{4,5} ?(?:BEGIN|END) [A-Z0-9][A-Z0-9 ]*? ?-{4,5}/g;

/**
 * Spans that credential rules must not touch.
 *
 * @param {string} original
 * @returns {Span[]}
 */
export function collectProtectedSpans(original) {
  const spans = [];
  const delimiter = new RegExp(ARMOR_DELIMITER.source, "g");
  let match;
  while ((match = delimiter.exec(original)) !== null) {
    if (match[0].length === 0) break;
    spans.push({ start: match.index, end: match.index + match[0].length, kind: "protected:armor-label" });
  }
  return spans;
}

/**
 * Clips every span back out of the protected regions, rather than discarding it.
 *
 * Dropping the whole span was a leak, and a larger one than the guard was worth.
 * Six classes were measured emitting credential bytes in the clear here while
 * the shipped `sed` masked all of them: a keyword-anchored value butted directly
 * against a begin delimiter (with and without a following body), a value glued
 * to the right of a delimiter whose label ends in a space, two provider shapes
 * whose character class admits a dash so the span runs into the delimiter's own
 * dashes, an all-uppercase provider shape sitting wholly inside a label, and a
 * quoted value holding a delimiter. Every class needs only that the credential
 * touch a delimiter -- and the drop then finished what the walk had started.
 *
 * The comment that used to sit here claimed a delimiter followed by a keyword
 * value was safe. That was true only because of the space between them.
 *
 * Clipping keeps both halves of the decision: the label survives intact, and the
 * credential bytes on either side of it still go.
 *
 * Armor spans are NOT passed through here. A private block's own delimiters sit
 * inside its armor span and are meant to go, so a secret block still loses its
 * label because it was RECOGNISED, not because a keyword ate it.
 *
 * @param {Span[]} spans
 * @param {Span[]} guards
 * @returns {Span[]}
 */
export function withoutProtected(spans, guards) {
  if (guards.length === 0 || spans.length === 0) return spans;
  // Sorted once, then entered by binary search per span. The previous shape
  // asked `guards.some(...)` for every span, which is fine until an input
  // carries many of both: measured at 4.6 s for 1 MiB, 12.2 s for 2 MiB and
  // 48.3 s for 4 MiB of alternating labels and anchors -- roughly 190 s
  // extrapolated to the 8 MiB fragment ceiling, per fragment, with no hook
  // timeout anywhere above it. Everything else in this module measured linear.
  const sorted = [...guards].sort((a, b) => a.start - b.start || a.end - b.end);
  const starts = sorted.map((guard) => guard.start);
  const out = [];

  for (const span of spans) {
    // First guard that could reach into this span. Guards are sorted by start,
    // so the search targets `start` -- but an earlier guard can still extend
    // into the span, so the walk steps back while that is true.
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < span.start) lo = mid + 1;
      else hi = mid;
    }
    let from = lo;
    while (from > 0 && sorted[from - 1].end > span.start) from -= 1;

    let pieces = [{ start: span.start, end: span.end }];
    for (let index = from; index < sorted.length && sorted[index].start < span.end; index += 1) {
      const guard = sorted[index];
      const next = [];
      for (const piece of pieces) {
        if (guard.end <= piece.start || guard.start >= piece.end) {
          next.push(piece);
          continue;
        }
        if (piece.start < guard.start) next.push({ start: piece.start, end: guard.start });
        if (guard.end < piece.end) next.push({ start: guard.end, end: piece.end });
      }
      pieces = next;
      if (pieces.length === 0) break;
    }
    for (const piece of pieces) {
      if (piece.end > piece.start) out.push({ start: piece.start, end: piece.end, kind: span.kind });
    }
  }
  return out;
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
    const vocabulary = options.vocabulary ?? defaultVocabulary();
    const guards = collectProtectedSpans(original);
    const spans = [
      ...collectArmorSpans(original),
      ...withoutProtected(collectCredentialSpans(original, { vocabulary }), guards)
    ];
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
      process.stdout.write(
        `${JSON.stringify({ text: omitted("fragment_not_json"), status: "omitted", reason: "fragment_not_json" })}\n`
      );
      continue;
    }
    process.stdout.write(`${JSON.stringify(redactText(typeof fragment === "string" ? fragment : String(fragment)))}\n`);
  }
}

// Importing this file must not run the CLI -- the tests import it directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write(
      `${JSON.stringify({ text: omitted("redaction_failed"), status: "omitted", reason: "redaction_failed" })}\n`
    );
    process.exitCode = 0;
  });
}
