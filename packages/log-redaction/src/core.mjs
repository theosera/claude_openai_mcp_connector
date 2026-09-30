/**
 * The redaction core: every span is decided against the ORIGINAL text, and
 * substitution happens once, at the end.
 *
 * Step 2-3 of #249. The span machinery, the armor collector, the token shapes
 * and the URL rule are carried over from `.claude/skills/_shared/redact-log.mjs`;
 * that file's comments hold the history of each rule and are not repeated here.
 * What differs:
 *
 * - The vocabulary comes from `policy.mjs`, not from a shell script read at run
 *   time. The core reads no file, runs no shell and does not depend on the cwd.
 * - Every fragment carries a `kind` from `KINDS`, and an unknown kind is
 *   omitted rather than read as some other kind.
 * - Labelled values are read through one reading of the quotes per kind
 *   (`lexQuotes`): shell quoting for a `command`, YAML-style scalars for `text`.
 *   `passwd` and `passphrase` are labels like the others.
 *
 * Not yet here: secrets in argument position (`mysql -p`, `redis-cli -a`,
 * `curl -u`), which the next step adds; `tests/tools/redactionScope.ts` lists
 * the cases waiting for it.
 *
 * The shared file is left as it is: the hooks and their mirrors keep it until
 * the adapter step switches them over.
 */

import { Buffer } from "node:buffer";

import { KEYWORDS, KINDS, SCHEME_WORDS, SECRET_LABELS, SHAPES } from "./policy.mjs";

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
 * @typedef {{ anchor: RegExp, scheme: RegExp | null, schemeWords: readonly string[], shapes: readonly { kind: string, source: string }[], labels?: readonly string[] }} Vocabulary
 */

/**
 * The vocabulary, built from `policy.mjs`. `tests/logRedactionPolicy.test.ts`
 * pins those lists to what the shared file lifts from the shell, so this
 * builds the same anchor and scheme patterns that `vocabularyFrom` returns.
 *
 * `anchor` and `scheme` are kept for that comparison only: the core finds labels
 * with `labels` and reads what follows them with the quote lexer below, not with
 * the anchor pattern.
 *
 * @type {Vocabulary}
 */
export const POLICY_VOCABULARY = Object.freeze({
  anchor: new RegExp(`(${KEYWORDS.join("|")})(['"]?)([=:>\\s]+)`, "gi"),
  scheme: new RegExp(`^(${SCHEME_WORDS.join("|")})(\\s+)`, "i"),
  schemeWords: SCHEME_WORDS,
  shapes: SHAPES,
  labels: SECRET_LABELS
});

/**
 * Quotes, read once from the start of the original, per kind.
 *
 * Every label and every value below is decided against this one reading. The
 * sed `mask()` had no such reading: each quoted-value rule found its own pair of
 * quotes, and a rule added for one shape paired quotes differently from the
 * rules around it. The change scans caught that four times from the same root
 * (#249). Here a quote is either an opening quote, a closing quote or a plain
 * character, and every rule agrees on which.
 *
 * - `command` reads shell quoting. A single-quoted segment has no escapes; a
 *   double-quoted one takes a backslash escape; outside quotes, a backslash
 *   escapes the next character, which is how `'\''` puts a quote inside a
 *   single-quoted word.
 * - `text` reads YAML-style scalars. A doubled `''` inside a single-quoted
 *   segment is an escaped quote; a double-quoted segment takes a backslash
 *   escape. A single quote right after a letter or digit is an apostrophe
 *   (`won't`, `it's`), not a quote: prose is the common case in `text`, and
 *   reading its apostrophes as quotes turns the rest of the line inside out.
 *
 * A segment never crosses a line end. Every line starts outside quotes, so one
 * stray quote cannot invert the rest of a long fragment.
 *
 * @typedef {{ open: number, close: number, closed: boolean }} Segment
 */

/** In `text`, a single quote right after one of these is an apostrophe. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/** Characters that end a shell word outside quotes. The comma is here so a value in a flow mapping stops at the next key. */
const COMMAND_STOP = /[\s;&|<>)}\],`]/;

/** Characters that end an unquoted value in `text`. */
const TEXT_STOP = /[\s,;)}\]&]/;

function isLineEnd(ch) {
  return ch === "\n" || ch === "\r";
}

/**
 * Finds the quote that closes the segment opened at `open`. Returns its index,
 * or the index of the line end (or of the end of input) when there is none.
 */
function closingQuote(original, open, kind) {
  const quote = original[open];
  for (let index = open + 1; index < original.length; index += 1) {
    const ch = original[index];
    if (isLineEnd(ch)) return { at: index, closed: false };
    if (quote === '"' && ch === "\\") {
      if (index + 1 >= original.length) return { at: original.length, closed: false };
      if (isLineEnd(original[index + 1])) return { at: index + 1, closed: false };
      index += 1;
      continue;
    }
    if (ch !== quote) continue;
    if (kind === "text" && quote === "'" && original[index + 1] === "'") {
      index += 1;
      continue;
    }
    return { at: index, closed: true };
  }
  return { at: original.length, closed: false };
}

/**
 * Reads every quoted segment of the original, in order. Segments do not overlap.
 *
 * Two readings are chosen here, one per kind:
 *
 * - An unclosed quote in a `command` is a plain character. The shell would keep
 *   reading onto the next line; a log line has no next line to wait for, and
 *   reading the rest of the line as quoted made a trailing `'\''` swallow the
 *   words after it (fuzz family shell-quote-join). In `text` an unclosed quote
 *   runs to the line end, as a YAML scalar would.
 * - In a `command`, a quote that reopens right after the same quote closed is
 *   read as the second half of a doubled quote at the END of the value when its
 *   segment starts with a blank and its closing quote looks like the opening
 *   quote of a later word: a blank before it, a word character after it. Read
 *   the shell's way, `--password='v'' -h host -e 'x'` makes ` -h host -e ` part
 *   of the password and runs on into `x` (corpus J-A3). Every other reopened
 *   segment keeps the shell's reading, so a doubled quote followed by more of
 *   the value is still one value.
 *
 * @param {string} original
 * @param {"command" | "text"} kind
 * @returns {Segment[]}
 */
function lexQuotes(original, kind) {
  const segments = [];
  let lastClose = -2;
  let index = 0;
  while (index < original.length) {
    const ch = original[index];
    if (kind === "command" && ch === "\\") {
      index += 2;
      continue;
    }
    if (ch !== "'" && ch !== '"') {
      index += 1;
      continue;
    }
    if (kind === "text" && ch === "'" && index > 0 && WORD_CHAR.test(original[index - 1])) {
      index += 1;
      continue;
    }
    const { at, closed } = closingQuote(original, index, kind);
    if (kind === "command") {
      const reopened = lastClose === index - 1 && original[lastClose] === ch;
      const boundary =
        reopened &&
        closed &&
        (original[index + 1] === " " || original[index + 1] === "\t") &&
        (original[at - 1] === " " || original[at - 1] === "\t") &&
        WORD_CHAR.test(original[at + 1] ?? "");
      if (!closed || boundary) {
        index += 1;
        continue;
      }
    }
    segments.push({ open: index, close: at, closed });
    if (closed) lastClose = at;
    index = closed ? at + 1 : at;
  }
  return segments;
}

/** The segment whose inside holds `position`, or null. `segments` is sorted by `open`. */
function segmentAt(segments, position) {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].open < position) lo = mid + 1;
    else hi = mid;
  }
  const segment = segments[lo - 1];
  return segment && position < segment.close ? segment : null;
}

function escapeRegExp(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collects the value after every label, per kind.
 *
 * A label is found wherever it occurs, and what follows it depends on where the
 * quote reading puts it:
 *
 * - Outside quotes: a separator (`=`, `:`, `>`, blanks), then the value. In a
 *   `command` the value is the shell word that starts there, however its quoted
 *   and unquoted pieces are joined (`'a'\''b'`, `"a"'!'"b"`). In `text` it is one
 *   quoted scalar, or an unquoted run.
 * - As a quoted key (`{"token": …}`, `{'password': …}`): the label ends where
 *   its segment closes. A `:` or `=` must follow, then the value is read as
 *   outside quotes. A quoted word with no `:` or `=` after it is a search term,
 *   not a key (`grep -rn "password" docs/`).
 * - As a key quoted inside a quoted argument (JSON in `curl -d '{"password": …}'`,
 *   a dict in `python3 -c "…{'secret': …}"`): the inner quote after the label
 *   belongs to the key, a `:` or `=` must follow, and a value in inner quotes
 *   ends at its own closing inner quote.
 * - Inside a quoted segment with a separator after it (`echo "token: v"`): the
 *   value is the rest of that segment, and in a `command` also whatever the
 *   shell word joins on after the segment closes. A label whose segment closes
 *   right after the separator has no value in it (`echo "Enter passphrase: "`).
 *   Reading that closing quote as the value's opening quote is the #232 fault.
 *
 * A label inside a value already collected is part of that value and is skipped.
 *
 * @param {string} original
 * @param {"command" | "text"} kind
 * @param {Vocabulary} vocabulary
 * @returns {Span[]}
 */
function collectLabelSpans(original, kind, vocabulary) {
  const labels = vocabulary.labels ?? SECRET_LABELS;
  if (labels.length === 0) return [];
  const spans = [];
  const segments = lexQuotes(original, kind);
  const opened = new Map(segments.map((segment) => [segment.open, segment]));
  const closes = new Set(segments.filter((segment) => segment.closed).map((segment) => segment.close));
  const schemeWords = vocabulary.schemeWords ?? [];
  const scheme =
    schemeWords.length > 0 ? new RegExp(`(?:${schemeWords.map(escapeRegExp).join("|")})[ \\t]+`, "iy") : null;
  const label = new RegExp(
    [...labels]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "gi"
  );

  /** End of the shell word that starts at `from`; `from` itself when nothing starts there. */
  const wordEnd = (from) => {
    let index = from;
    while (index < original.length) {
      const segment = opened.get(index);
      if (segment) {
        index = segment.close + 1;
        continue;
      }
      const ch = original[index];
      if (ch === "\\") {
        if (index + 1 >= original.length || isLineEnd(original[index + 1])) return index;
        index += 2;
        continue;
      }
      if (COMMAND_STOP.test(ch)) return index;
      index += 1;
    }
    return original.length;
  };

  /** The separator after a label: `=`, `:`, `>` and blanks, and in a `command` a backslash-newline. */
  const separatorEnd = (from, limit) => {
    let index = from;
    while (index < limit) {
      const ch = original[index];
      if (ch === "=" || ch === ":" || ch === ">" || ch === " " || ch === "\t") {
        index += 1;
        continue;
      }
      if (kind === "command" && ch === "\\" && isLineEnd(original[index + 1])) {
        index += original[index + 1] === "\r" && original[index + 2] === "\n" ? 3 : 2;
        continue;
      }
      break;
    }
    return index;
  };

  const skipScheme = (from, limit) => {
    if (!scheme) return from;
    scheme.lastIndex = from;
    const match = scheme.exec(original);
    return match && from + match[0].length < limit ? from + match[0].length : from;
  };

  const assigns = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (original[index] === ":" || original[index] === "=") return true;
    }
    return false;
  };

  /** Length of an inner quote at `at` inside a segment (`"`, `'`, or escaped `\"` `\'`), or 0. */
  const innerQuote = (at, segment) => {
    if (at >= segment.close) return 0;
    const ch = original[at];
    if ((ch === '"' || ch === "'") && ch !== original[segment.open]) return 1;
    if (ch === "\\" && (original[at + 1] === '"' || original[at + 1] === "'")) return 2;
    return 0;
  };

  /** Where the inner quote opened at `from` closes, before `limit`; -1 if it does not. */
  const innerClose = (from, length, limit) => {
    const quote = original[from + length - 1];
    for (let index = from + length; index < limit; index += 1) {
      const ch = original[index];
      if (length === 2) {
        if (ch === "\\" && original[index + 1] === quote) return index;
        if (ch === "\\") index += 1;
        continue;
      }
      if (ch === "\\" && quote === '"') {
        index += 1;
        continue;
      }
      if (ch === quote) return index;
    }
    return -1;
  };

  /** The value that starts at `from`, outside quotes. */
  const valueAt = (from) => {
    if (from >= original.length || isLineEnd(original[from])) return null;
    if (kind === "command") {
      const end = wordEnd(from);
      const start = opened.has(from) ? from + 1 : from;
      const stop = end - 1 > start && closes.has(end - 1) ? end - 1 : end;
      return stop > start ? { start, end: stop, next: end } : null;
    }
    const segment = opened.get(from);
    if (segment) {
      return segment.close > from + 1 ? { start: from + 1, end: segment.close, next: segment.close + 1 } : null;
    }
    let end = from;
    while (end < original.length && !TEXT_STOP.test(original[end])) end += 1;
    return end > from ? { start: from, end, next: end } : null;
  };

  let match;
  while ((match = label.exec(original)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const segment = segmentAt(segments, start);
    let value = null;

    if (segment && end === segment.close && segment.closed) {
      const after = separatorEnd(segment.close + 1, original.length);
      const between = original.slice(segment.close + 1, after);
      if (between.includes(":") || between.includes("=")) value = valueAt(skipScheme(after, original.length));
    } else if (segment) {
      // A key quoted inside the quoted argument (JSON in `curl -d '{"password": …}'`,
      // a dict in `python3 -c "…{'secret': …}"`): the inner quote after the label
      // belongs to the key, and a `:` or `=` must follow. The shell sees one quoted
      // argument there, so without this the value was never read.
      const keyQuote = innerQuote(end, segment);
      const keyEnd = end + keyQuote;
      const after = separatorEnd(keyEnd, segment.close);
      if (after > keyEnd && (keyQuote === 0 || assigns(keyEnd, after))) {
        const from = skipScheme(after, segment.close);
        const valueQuote = innerQuote(from, segment);
        if (valueQuote > 0) {
          // A value in inner quotes ends at its own closing inner quote.
          const close = innerClose(from, valueQuote, segment.close);
          const stop = close < 0 ? segment.close : close;
          if (stop > from + valueQuote) {
            value = { start: from + valueQuote, end: stop, next: close < 0 ? segment.close : close + valueQuote };
          }
        } else {
          const joined = kind === "command" && segment.closed ? wordEnd(segment.close + 1) : segment.close + 1;
          const continues = joined > segment.close + 1;
          if (from < segment.close) {
            value = { start: from, end: continues ? joined : segment.close, next: continues ? joined : segment.close };
          } else if (continues) {
            value = { start: segment.close + 1, end: joined, next: joined };
          }
        }
      }
    } else {
      // A quote right after the label that opens nothing -- an apostrophe-like
      // quote in `text` -- belongs to the label, as the anchor's `['"]?` allowed.
      const quoted = (original[end] === "'" || original[end] === '"') && !opened.has(end) ? end + 1 : end;
      const after = separatorEnd(quoted, original.length);
      if (after > quoted) value = valueAt(skipScheme(after, original.length));
    }

    if (value && value.end > value.start) {
      spans.push({ start: value.start, end: value.end, kind: "credential:label" });
      label.lastIndex = Math.max(label.lastIndex, value.next);
    }
  }
  return spans;
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
 * @param {{ vocabulary?: Vocabulary, kind?: "command" | "text" }} [options]
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

  if (!vocabulary) return spans;
  if (!KINDS.includes(options.kind))
    throw new TypeError(`collectCredentialSpans needs a kind from KINDS: ${options.kind}`);
  // An unclosed quote is NOT a reason to omit the fragment. The shapes that reach
  // it are overwhelmingly benign -- a search for a keyword with a trailing space,
  // a comment describing a rule -- and omitting them blanked 7% of the tracked
  // text files in an earlier measurement, and handed anyone who can place text
  // in a tool result a way to drop the record. The quote lexer reads an unclosed
  // quote instead (see `lexQuotes`).
  // One at a time, not `push(...spans)`: spreading passes every span as an
  // argument, and at about 130,000 of them (1 MiB of short labelled values) the
  // call overflowed the stack, so the whole fragment came back omitted.
  for (const span of collectLabelSpans(original, options.kind, vocabulary)) spans.push(span);
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

    // One pass, with a monotone cursor. The previous shape rebuilt the whole
    // `pieces` array once per intersecting guard, so a single span covering G
    // guards cost O(G^2) -- measured at 6.9 s for one quoted value enclosing
    // 50,000 armor delimiters (900 KB), against 0.09 s for the same labels with
    // no enclosing quote. The binary search above fixed only the span-to-first-
    // guard lookup; this is the other half, and it was still quadratic with that
    // half in place.
    //
    // Guards arrive sorted by start and may overlap each other, which the cursor
    // handles: it only ever moves forward, so an overlapping pair contributes one
    // hole rather than two.
    let cursor = span.start;
    for (let index = from; index < sorted.length && sorted[index].start < span.end; index += 1) {
      const guard = sorted[index];
      if (guard.end <= cursor) continue;
      if (guard.start > cursor) {
        out.push({ start: cursor, end: Math.min(guard.start, span.end), kind: span.kind });
      }
      cursor = Math.max(cursor, guard.end);
      if (cursor >= span.end) break;
    }
    if (cursor < span.end) out.push({ start: cursor, end: span.end, kind: span.kind });
  }
  return out;
}

/**
 * @typedef {{ text: string, kind: string }} Fragment
 */

/**
 * Redacts one fragment. The fragment's `kind` must be one of `KINDS`; anything
 * else is omitted, never read as a kind it did not name.
 *
 * @param {Fragment} fragment
 * @param {{ maxBytes?: number, vocabulary?: Vocabulary }} [options]
 * @returns {RedactionResult}
 */
export function redactFragment(fragment, options = {}) {
  if (fragment === null || typeof fragment !== "object" || typeof fragment.text !== "string") {
    return { text: omitted("non_string_input"), status: "omitted", reason: "non_string_input" };
  }
  if (!KINDS.includes(fragment.kind)) {
    return { text: omitted("unknown_kind"), status: "omitted", reason: "unknown_kind" };
  }
  const original = fragment.text;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(original, "utf8") > maxBytes) {
    return { text: omitted("fragment_over_limit"), status: "omitted", reason: "fragment_over_limit" };
  }

  try {
    const vocabulary = options.vocabulary ?? POLICY_VOCABULARY;
    const guards = collectProtectedSpans(original);
    const spans = [
      ...collectArmorSpans(original),
      ...withoutProtected(collectCredentialSpans(original, { vocabulary, kind: fragment.kind }), guards)
    ];
    const merged = mergeOverlaps(spans, original.length);
    return { text: applySpansOnce(original, merged), status: "ok" };
  } catch (error) {
    // No fallback to the original text.
    const reason =
      error instanceof RedactionOmitted
        ? error.reason
        : error instanceof RangeError || error instanceof TypeError
          ? "span_contract_violated"
          : "redaction_failed";
    return { text: omitted(reason), status: "omitted", reason };
  }
}
