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
 *   segment is an escaped quote, and so is `\'`; a double-quoted segment takes
 *   a backslash escape. A single quote right after a letter or digit opens
 *   nothing (an apostrophe: `won't`, `it's`), nor does a double quote right after
 *   a digit (an inch mark: `27"`). Prose is the common case in `text`, and
 *   reading those as quotes turns the rest of the line inside out.
 *
 * A segment never crosses a line end. Every line starts outside quotes, so one
 * stray quote cannot invert the rest of a long fragment.
 *
 * @typedef {{ open: number, close: number, closed: boolean }} Segment
 */

/** In `text`, a single quote right after one of these is an apostrophe (`won't`), not an opening quote. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Characters that end a shell word outside quotes: blanks and the shell's
 * control characters. Not `<`, `>` or a backquote: a logged value is often a
 * placeholder or an expression (`TOKEN=<value>`, ``TOKEN=`cat f` ``), and
 * stopping there masked nothing of it.
 */
const COMMAND_STOP = /[\s;&|)]/;

/**
 * Characters that end a shell word only right after a closing quote and before
 * another key: a label (`']token v`) or a `NEXT_KEY`. A value in a flow mapping (`{password: 'v',token: …}`)
 * stops at the next key there; an unquoted value may hold them (`PASSWORD=a,b`),
 * and so may a quoted one followed by more of itself (`'a',b`).
 */
const AFTER_QUOTE_STOP = /[,}\]]/;

/**
 * What must follow `,` `}` `]` after a closing quote for the word to end there:
 * another key (`token:`, `user=`). Before anything else they are part of the
 * value (`'a',b`), and ending there left the rest of the value in the clear.
 */
const NEXT_KEY = /[^\S\r\n]*[A-Za-z_][\w.-]*[^\S\r\n]*[:=]/y;

/**
 * Blanks other than line ends. The sed `mask()`'s `[[:space:]]` covers the
 * ideographic space and the no-break space under a UTF-8 locale, and a label
 * typed with a Japanese input method is followed by the first.
 */
const BLANK = /[^\S\r\n]/;

/** In `text`, what may follow a label's closing quote and still be its value (`"token: "v`). */
const TEXT_GLUE = /[A-Za-z0-9_$'"+/=.~-]/;

function isLineEnd(ch) {
  return ch === "\n" || ch === "\r";
}

/**
 * Whether `\'` in a `text` single quote is an escaped quote, `from` being the
 * index after it. Before a non-blank it is (`'it\'s'`). Before a blank it is
 * too (`'rock n\' roll'`), unless a label comes before the next quote on the
 * line: in `'C:\' and token: 'v'` the quote after the backslash closes, and
 * reading it as escaped ran the value over the next label and left that one's
 * value out. Closing before every blank instead left the rest of a value like
 * `'rock n\' roll'` in the clear.
 */
function escapedBeforeBlank(original, from, labelAt) {
  if (!/\s/.test(original[from])) return true;
  for (
    let index = from;
    index < original.length && original[index] !== "'" && !isLineEnd(original[index]);
    index += 1
  ) {
    labelAt.lastIndex = index;
    if (labelAt.test(original)) return false;
  }
  return true;
}

/**
 * Finds the quote that closes the segment opened at `open`. Returns its index,
 * or the index of the line end (or of the end of input) when there is none.
 */
function closingQuote(original, open, kind, labelAt) {
  const quote = original[open];
  for (let index = open + 1; index < original.length; index += 1) {
    const ch = original[index];
    if (isLineEnd(ch)) return { at: index, closed: false };
    // A backslash escapes a quote in a double-quoted segment, and in `text` in a
    // single-quoted one too: YAML does not, but a repr or a JSON-ish log line
    // does (`'it\'s'`), and closing there left the rest of the value in the clear.
    // In `text` it escapes a backslash as well, so `'v\\'` closes: reading only
    // `\'` as a pair made the second backslash escape the closing quote, and the
    // next label's value was read as outside every quote and left in the clear.
    if (ch === "\\") {
      const next = original[index + 1];
      const escapes =
        quote === '"' ||
        (kind === "text" &&
          (next === "\\" ||
            (next === "'" && index + 2 < original.length && escapedBeforeBlank(original, index + 2, labelAt))));
      if (escapes) {
        if (index + 1 >= original.length) return { at: original.length, closed: false };
        if (isLineEnd(original[index + 1])) return { at: index + 1, closed: false };
        index += 1;
        continue;
      }
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
 * - An unclosed quote is a plain character, in both kinds. The shell would keep
 *   reading onto the next line; a log line has no next line to wait for, and
 *   reading the rest of the line as quoted made a trailing `'\''` swallow the
 *   words after it (fuzz family shell-quote-join). In `text`, reading it to the
 *   line end took every word after an unclosed value, where the sed `mask()`
 *   stops at the next blank.
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
 * @param {RegExp} labelAt a sticky regex of the labels (see `escapedBeforeBlank`)
 * @returns {Segment[]}
 */
function lexQuotes(original, kind, labelAt) {
  const segments = [];
  let lastClose = -2;
  // Where the last unclosed scan of each quote ended (its line end). A later quote
  // of the same kind before that point is read as a plain character without being
  // scanned again: a line of `a\"a\"…` rescanned to the line end from every quote
  // (measured, 1.8 s at 64 KiB, four times as long per doubling). Every quote that
  // scan passed was escaped or paired, except the first of a doubled `''`, which a
  // fresh scan reads as an empty segment; here the pair is two plain characters,
  // and that can move where a value starts. Measured on 90,000 random lines rich
  // in quotes and backslashes, each in both kinds (#249, third review): 50 of
  // 180,000 outputs differ from a fresh scan, 29 only by where a mask starts, and
  // in one a secret the fresh scan left readable is masked.
  const unclosedUntil = { '"': -1, "'": -1 };
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
    // In `text`, a single quote after a letter or digit is an apostrophe, and a
    // double quote after a digit is an inch mark. A double quote after a letter
    // still opens a string: `f"…"`, `r"…"`, `-p"…"`.
    const before = index > 0 ? original[index - 1] : "";
    if (kind === "text" && (ch === "'" ? WORD_CHAR.test(before) : /[0-9]/.test(before))) {
      index += 1;
      continue;
    }
    if (index < unclosedUntil[ch]) {
      index += 1;
      continue;
    }
    const { at, closed } = closingQuote(original, index, kind, labelAt);
    if (!closed) {
      unclosedUntil[ch] = at;
      index += 1;
      continue;
    }
    if (kind === "command") {
      const reopened = lastClose === index - 1 && original[lastClose] === ch;
      const boundary =
        reopened &&
        closed &&
        (original[index + 1] === " " || original[index + 1] === "\t") &&
        (original[at - 1] === " " || original[at - 1] === "\t") &&
        WORD_CHAR.test(original[at + 1] ?? "");
      if (boundary) {
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
 * - Outside quotes: a separator (`=`, `:`, blanks), then the value. In a
 *   `command` the value is the shell word that starts there, however its quoted
 *   and unquoted pieces are joined (`'a'\''b'`, `"a"'!'"b"`). In `text` it is one
 *   quoted scalar, or an unquoted run up to a blank.
 * - As a quoted key (`{"token": …}`, `{'password': …}`): the label ends where
 *   its segment closes. A `:` or `=` must follow, or blanks and a quoted value;
 *   then the value is read as outside quotes. A quoted word followed by an
 *   unquoted one is a search term, not a key (`grep -rn "password" docs/`).
 * - Inside a quoted segment:
 *   - As a key quoted inside it (JSON in `curl -d '{"password": …}'`, a dict in
 *     `python3 -c "…{'secret': …}"`): the inner quote after the label belongs to
 *     the key, a `:` or `=` (or a quoted value) must follow, and a value in inner
 *     quotes ends at its own closing inner quote. The shell sees one single-quoted argument there,
 *     so without this the value was never read.
 *   - With `:` or `=` after it (`echo "token: v"`): the value is the rest of the
 *     segment, and whatever the word joins on after the segment closes.
 *   - With blanks only after it: one word, as outside quotes. Prose in a quoted
 *     argument (a commit subject) otherwise lost everything after the label.
 *   - A label whose segment closes right after the separator has no value in it
 *     (`echo "Enter passphrase: "`). Reading that closing quote as the value's
 *     opening quote is the #232 fault.
 *
 * A label inside a quoted value already collected is part of that value and is
 * skipped. A label inside an unquoted value is read again (`--passphrase --key
 * v`, `passwd=secret: v`): the word it heads is a label, not the value.
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
  const labelSource = [...labels]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const labelAt = new RegExp(`(?:${labelSource})`, "iy");
  const segments = lexQuotes(original, kind, labelAt);
  const opened = new Map(segments.map((segment) => [segment.open, segment]));
  const closes = new Set(segments.filter((segment) => segment.closed).map((segment) => segment.close));
  const schemeWords = vocabulary.schemeWords ?? [];
  const scheme =
    schemeWords.length > 0 ? new RegExp(`(?:${schemeWords.map(escapeRegExp).join("|")})[^\\S\\r\\n]+`, "iy") : null;
  // A label word with what separates it from a value right after it: `=`, `:` or
  // a blank. Not a label inside a longer word (`path`, `keychain`), and not one
  // before a quote: stopping a value before `token'v'` left `v` in the clear.
  const labelKey = new RegExp(`(?:${labelSource})(?=[=:]|[^\\S\\r\\n])`, "iy");
  const labelWord = new RegExp(`(?:${labelSource})`, "i");
  const labelAtEnd = new RegExp(`(?:${labelSource})$`, "i");
  const label = new RegExp(
    [...labels]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "gi"
  );

  // The end of the last word measured. Labels nested in one word are read again,
  // and every one of them ends where that word ends: remembering it keeps a line
  // of `k:k:k:…` linear instead of re-walking the word per label. A start equal to
  // the last one hits too: labels inside one quoted string all ask for the word
  // after its closing quote, and missing that made `echo "k=k=k=…"` quadratic.
  let wordFrom = -1;
  let wordTo = -1;
  // The same for one blank-delimited word inside a quoted segment.
  let innerFrom = -1;
  let innerTo = -1;

  /**
   * Whether a label whose value this loop will read starts at `at`, after blanks
   * (`token v`, `token=v`). Inside an unquoted value only this ends the value: a
   * value cut before any other `word=` left the rest in the clear, and a list of
   * keys is one (`FERNET_KEY=new,old=`, a key ending in `=`).
   */
  const labelKeyAt = (at) => {
    let index = at;
    while (index < original.length && BLANK.test(original[index])) index += 1;
    labelKey.lastIndex = index;
    return labelKey.test(original);
  };

  /** Whether a key starts at `at`, after blanks: a label as above, or a word followed by `:` or `=`. */
  const keyAt = (at) => {
    if (labelKeyAt(at)) return true;
    NEXT_KEY.lastIndex = at;
    return NEXT_KEY.test(original);
  };

  /** End of the shell word that starts at `from`; `from` itself when nothing starts there. */
  const wordEnd = (from) => {
    if (from >= wordFrom && from < wordTo) return wordTo;
    let index = from;
    while (index < original.length) {
      const segment = opened.get(index);
      if (segment) {
        index = segment.close + 1;
        if (index < original.length && AFTER_QUOTE_STOP.test(original[index]) && keyAt(index + 1)) break;
        continue;
      }
      const ch = original[index];
      if (ch === "\\") {
        if (index + 1 >= original.length || isLineEnd(original[index + 1])) break;
        index += 2;
        continue;
      }
      if (COMMAND_STOP.test(ch)) break;
      // A comma before another label ends the word (`PASSWORD=a,token v`).
      if (ch === "," && labelKeyAt(index + 1)) break;
      index += 1;
    }
    const end = Math.min(index, original.length);
    wordFrom = from;
    wordTo = end;
    return end;
  };

  /**
   * End of an unquoted `text` value: the next blank or line end, or a `,` `;` `&`
   * before another label (`password: a,token v`). Before anything else they are
   * part of the value (`password: a;b`).
   */
  const runEnd = (from) => {
    if (from >= wordFrom && from < wordTo) return wordTo;
    let end = from;
    while (end < original.length && !/\s/.test(original[end])) {
      const ch = original[end];
      if ((ch === "," || ch === ";" || ch === "&") && labelKeyAt(end + 1)) break;
      end += 1;
    }
    wordFrom = from;
    wordTo = end;
    return end;
  };

  /** End of one blank-delimited word inside a segment, before `limit`. */
  const innerWordEnd = (from, limit) => {
    if (from >= innerFrom && from < innerTo) return innerTo;
    let stop = from;
    while (stop < limit && !/\s/.test(original[stop])) stop += 1;
    innerFrom = from;
    innerTo = stop;
    return stop;
  };

  /**
   * The separator after a label: `=`, `:` and blanks, `=>` (Perl, Ruby and PHP
   * hashes), and in a `command` a backslash-newline. A `>` on its own is not one:
   * `./gen_token > out.txt` is a redirection, and the file name is not a secret.
   */
  const separatorEnd = (from, limit, arrowAfterLabel = true) => {
    let index = from;
    while (index < limit) {
      const ch = original[index];
      // `>` separates only right after the label (`password> v`, a prompt) or
      // after `=` (`=>`). After a blank it is a redirection (`gen_token > out`).
      const arrow = ch === ">" && ((index === from && arrowAfterLabel) || original[index - 1] === "=");
      if (ch === "=" || ch === ":" || BLANK.test(ch) || arrow) {
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

  const assigns = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (original[index] === ":" || original[index] === "=") return true;
    }
    return false;
  };

  /**
   * Skips an auth-scheme word, also one behind a bracket (`[Bearer v]`, as Java
   * and Go print a header map), a quote (`"Bearer v` left open, or a quoted list
   * item), or both (`["Bearer v"]`), and one behind `<` or a backquote
   * (`<Bearer v>`, a placeholder; `` `Token v` ``, Markdown code).
   */
  const skipScheme = (from, limit) => {
    if (!scheme) return from;
    // Up to two characters may stand before the scheme word: a bracket, a quote,
    // or a bracket or `$` and then a quote (`["Bearer v"]`, a header map printed
    // as JSON; `$'Bearer v'`, a shell ANSI-C string).
    let at = from;
    for (let step = 0; step <= 2 && at < limit; step += 1) {
      scheme.lastIndex = at;
      const match = scheme.exec(original);
      if (match && at + match[0].length < limit) return at + match[0].length;
      const ch = original[at];
      const lead = "[({$<`".includes(ch) && step === 0;
      if (!lead && ch !== '"' && ch !== "'") break;
      at += 1;
    }
    return from;
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
    // A scalar ends at its closing quote. A word glued to that quote is still the
    // value when the scalar is one word too (`'a'b''`), as the sed `mask()` reads
    // up to the next blank. After a scalar of several words, a glued word starts
    // something else (corpus J-A2: `'v'' ; … ; echo 'KEEP'`).
    const segment = opened.get(from);
    if (segment) {
      const glued =
        segment.close + 1 < original.length &&
        TEXT_GLUE.test(original[segment.close + 1]) &&
        !/\s/.test(original.slice(from + 1, segment.close));
      const end = glued ? runEnd(segment.close + 1) : segment.close;
      return end > from + 1 ? { start: from + 1, end, next: glued ? end : segment.close + 1 } : null;
    }
    // An empty pair of quotes at the start (`''v`) is not a quote left open: the
    // value is the word after it.
    const q = original[from];
    if ((q === "'" || q === '"') && original[from + 1] === q && !opened.has(from)) {
      const end = runEnd(from + 2);
      return end > from + 2 ? { start: from + 2, end, next: end } : null;
    }
    // A value that opens a quote and never closes it runs to the line end: its
    // words after the first are as likely to be the secret as the first is.
    if ((original[from] === "'" || original[from] === '"') && !opened.has(from)) {
      let lineEnd = from + 1;
      while (lineEnd < original.length && !isLineEnd(original[lineEnd])) lineEnd += 1;
      return lineEnd > from + 1 ? { start: from + 1, end: lineEnd, next: lineEnd } : null;
    }
    const end = runEnd(from);
    return end > from ? { start: from, end, next: end } : null;
  };

  /** What joins on after a segment closes at `close`: the rest of the shell word, or a glued `text` run. */
  const joinedEnd = (segment) => {
    const after = segment.close + 1;
    if (!segment.closed) return after;
    if (kind === "command") return wordEnd(after);
    return after < original.length && TEXT_GLUE.test(original[after]) ? runEnd(after) : after;
  };

  /** The value of a label inside `segment`, the label ending at `end`. */
  const valueInside = (segment, end) => {
    const keyQuote = innerQuote(end, segment);
    const keyEnd = end + keyQuote;
    const after = separatorEnd(keyEnd, segment.close);
    if (after === keyEnd) return null;
    const assigned = assigns(keyEnd, after);
    const from = skipScheme(after, segment.close);
    const valueQuote = innerQuote(from, segment);
    // An inner-quoted word with blanks only after it is a search term
    // (`bash -c 'grep "password" docs/'`), unless a quoted value comes next.
    if (keyQuote > 0 && !assigned && valueQuote === 0) return null;

    if (valueQuote > 0) {
      const close = innerClose(from, valueQuote, segment.close);
      const stop = close < 0 ? segment.close : close;
      return stop > from + valueQuote
        ? { start: from + valueQuote, end: stop, next: close < 0 ? segment.close : close + valueQuote }
        : null;
    }
    if (!assigned && from < segment.close) {
      const stop = innerWordEnd(from, segment.close);
      return { start: from, end: stop, next: stop };
    }
    const joined = joinedEnd(segment);
    const continues = joined > segment.close + 1;
    if (from < segment.close) {
      const stop = continues ? joined : segment.close;
      return { start: from, end: stop, next: stop };
    }
    return continues ? { start: segment.close + 1, end: joined, next: joined } : null;
  };

  /** Where a run with no blank, `<` or line end that starts at `from` ends. */
  const tagTextEnd = (from) => {
    let stop = from;
    while (stop < original.length && original[stop] !== "<" && !isLineEnd(original[stop])) stop += 1;
    return stop;
  };

  // Where the last search for a CDATA section's end started, and what it found
  // (-1 for none before the line end): CDATA openings with no end on one line
  // each searched to the line end, and the line took quadratic time.
  let cdataFrom = -1;
  let cdataStop = -1;
  let cdataFound = false;
  /** Where the `]]>` that ends a CDATA section whose content starts at `from` is, or -1. */
  const cdataEnd = (from) => {
    if (cdataFrom >= 0 && from >= cdataFrom && from <= cdataStop) return cdataFound ? cdataStop : -1;
    let at = from;
    while (at < original.length && !isLineEnd(original[at]) && !original.startsWith("]]>", at)) at += 1;
    cdataFrom = from;
    cdataStop = at;
    cdataFound = original.startsWith("]]>", at);
    return cdataFound ? at : -1;
  };

  /**
   * The element the label at `start`..`end` names, when `<label>` opens one that
   * closes on the same line (`</label>`, blanks allowed before its `>`): its text,
   * a CDATA section's content if it holds one, and where its closing tag ends.
   * Attributes may stand before the opening tag's `>` (`<password type="plain">`).
   * Null otherwise. The text runs to the next `<`, so each is walked once.
   */
  const elementAt = (start, end) => {
    if (original[start - 1] !== "<") return null;
    let open = end;
    if (original[open] !== ">") {
      if (!BLANK.test(original[open] ?? "")) return null;
      while (open < original.length && original[open] !== ">" && original[open] !== "<" && !isLineEnd(original[open]))
        open += 1;
      if (original[open] !== ">") return null;
    }
    let textStart = open + 1;
    let textEnd;
    let after;
    if (original.startsWith("<![CDATA[", textStart)) {
      textStart += 9;
      textEnd = cdataEnd(textStart);
      if (textEnd < 0) return null;
      after = textEnd + 3;
    } else {
      textEnd = tagTextEnd(textStart);
      after = textEnd;
    }
    const name = original.slice(start, end).toLowerCase();
    if (original.slice(after, after + 2 + name.length).toLowerCase() !== `</${name}`) return null;
    let close = after + 2 + name.length;
    while (close < original.length && BLANK.test(original[close])) close += 1;
    if (original[close] !== ">") return null;
    return { name, start: textStart, end: textEnd, closeEnd: close + 1 };
  };

  /**
   * The value an element holds. A plist writes a key and its value as two
   * elements (`<key>token</key><string>v</string>`): an element named `key`
   * holds no value itself, and the next element's text is the value when the key
   * holds a label. Any other element's text is the value.
   */
  const elementValue = (element) => {
    if (element.name !== "key") {
      return element.end > element.start ? { start: element.start, end: element.end, next: element.end } : null;
    }
    if (!labelWord.test(original.slice(element.start, element.end))) return null;
    let at = element.closeEnd;
    while (at < original.length && BLANK.test(original[at])) at += 1;
    if (original[at] !== "<") return null;
    let name = at + 1;
    while (name < original.length && /[A-Za-z0-9_.:-]/.test(original[name])) name += 1;
    if (name === at + 1 || original[name] !== ">") return null;
    const stop = tagTextEnd(name + 1);
    return stop > name + 1 ? { start: name + 1, end: stop, next: stop } : null;
  };

  /**
   * The value after a separator, past a scheme word. When the scheme word sits
   * inside a closed quote (`"Bearer a b"`), the value is the rest of that quote:
   * reading one word there left the rest of the credential in the clear.
   */
  const valueAfter = (after) => {
    const from = skipScheme(after, original.length);
    for (let at = after; at < from; at += 1) {
      const segment = opened.get(at);
      if (segment && segment.closed && segment.close >= from) {
        return segment.close > from ? { start: from, end: segment.close, next: segment.close + 1 } : null;
      }
    }
    return valueAt(from);
  };

  /**
   * Whether an option named by a label starts at `at`: the label right after one
   * or two dashes (`-token`, `--token`), or a long option whose name ends in a
   * label (`--api-token`, `--client-secret`). Not a short option that merely
   * holds one (`-my_token`).
   */
  const labelOptionAt = (at) => {
    let index = at;
    while (original[index] === "-") index += 1;
    const dashes = index - at;
    if (dashes === 0) return false;
    labelAt.lastIndex = index;
    if (dashes <= 2 && labelAt.test(original)) return true;
    if (dashes < 2) return false;
    let stop = index;
    while (stop < original.length && /[A-Za-z0-9_-]/.test(original[stop])) stop += 1;
    return labelAtEnd.test(original.slice(index, stop));
  };

  /**
   * The last list separator in `from`..`to`, or -1. Asked only of a value not
   * shaped like a label, and the next such value starts after its last separator
   * or after its end, so the searches together walk each character at most twice
   * (labels nested in one word, `k:k:k:…`, are shaped like labels and never ask).
   */
  const lastListSeparator = (from, to) => {
    let at = to - 1;
    while (at >= from && original[at] !== "," && original[at] !== ";" && original[at] !== "&") at -= 1;
    return at >= from ? at : -1;
  };

  let match;
  while ((match = label.exec(original)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const segment = segmentAt(segments, start);
    let value = null;

    if (segment && end === segment.close && segment.closed) {
      // A quoted key with blanks only after it is a key when a quoted value comes
      // next (`set "secret"\t"v"`); before an unquoted word it is a search term.
      const after = separatorEnd(segment.close + 1, original.length);
      if (assigns(segment.close + 1, after) || (after > segment.close + 1 && opened.has(after))) {
        value = valueAfter(after);
      }
    } else if (segment) {
      value = valueInside(segment, end);
    } else {
      // A label as an element name (`<password>v</password>`, as Maven's
      // settings.xml writes one) takes the element's text.
      const element = elementAt(start, end);
      const closingTag = original[start - 1] === "/" && original[start - 2] === "<";
      const tag = (original[start - 1] === "<" && original[end] === ">") || closingTag;
      if (element) {
        value = elementValue(element);
      } else if (tag) {
        // A tag that opens no element on this line, or a closing tag: what is glued
        // after its `>` is a value (`<password>v`, `<token>=v`, `Enter <password>:
        // v`), as step 2-3 read it. A blank after the `>` is not (`-p<password> -h
        // host`, `Optional<Secret> s`), and a closing tag's name takes nothing else.
        const glued = original[end] === ">" && end + 1 < original.length && !/[\s<]/.test(original[end + 1]);
        if (glued) value = valueAfter(separatorEnd(end + 1, original.length, false));
      } else {
        // A quote right after the label that opens nothing -- an apostrophe-like
        // quote in `text` -- belongs to the label, as the anchor's `['"]?` allowed.
        const quoted = (original[end] === "'" || original[end] === '"') && !opened.has(end) ? end + 1 : end;
        // A `>` right after the label is a prompt (`mysql/password> v`), also where
        // it could be a redirection (`cat /etc/password> f`): the two cannot be told
        // apart, and step 2-3 masked both.
        const after = separatorEnd(quoted, original.length);
        if (after > quoted) value = valueAfter(after);
      }
    }

    if (value && value.end > value.start) {
      spans.push({ start: value.start, end: value.end, kind: "credential:label" });
      // A label inside a value is read again only when the value is shaped like a
      // label itself: an option (`--key`), a word ending in `:` or `=`, quoted parts
      // or not (`'x'secret:`), or a quoted part with an option named by a label
      // glued after it (`'x'--token`). A plain word that happens to contain a label
      // (`=secret`, `=my_token`, `'x'-my_token`) is the value, and reading it again
      // masked the word after it.
      const last = original[value.end - 1];
      const leadingQuote = opened.get(value.start - 1);
      const optionAfterQuote = leadingQuote !== undefined && labelOptionAt(leadingQuote.close + 1);
      const labelLike = original[value.start] === "-" || last === ":" || last === "=" || optionAfterQuote;
      // A list value is read again from its last item: an item that ends in a
      // label (`S1,secret_key S2`, `S1;keytoken S2`) names the value after it.
      const separator = labelLike ? -1 : lastListSeparator(value.start, value.end);
      if (!labelLike) label.lastIndex = Math.max(label.lastIndex, separator >= 0 ? separator + 1 : value.next);
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
 *
 * The line may carry one of the prefixes a tool puts in front of a file's lines,
 * the same ones the sed `mask()`'s prefixed catch-all admits: a line number
 * (`cat -n`, `nl`, an editor gutter), `> ` or `| `, `file:12:` from `grep -n`,
 * or a diff's `-`. The prefix stays; only the base64 run is masked. Without it,
 * a key body printed by `cat -n` came through whole.
 *
 * A line number needs a blank or `|`, `:`, `>` after it. Digits are base64
 * characters too, and a prefix that could end anywhere inside a run of digits
 * made a long line of digits that fails the match take quadratic time to fail
 * (measured, 3.6 s at 32,000 characters), and left the leading digits of a
 * base64 line unmasked as if they were a line number. The blanks after the
 * number are read by one quantifier: two adjacent ones (`[ ]+[|:>]?[ ]*`) could
 * split a run of blanks either way, and a line of a number, blanks and no base64
 * took quadratic time to fail (measured, 7.5 s at 32,768 blanks).
 */
const BARE_BASE64_LINE =
  /^([^\S\r\n]*(?:[0-9]+(?:[^\S\r\n]+(?:[|:>][^\S\r\n]*)?|[|:>][^\S\r\n]*)|[>|]+[^\S\r\n]*|[^\s:]+:[0-9]+:[^\S\r\n]*|-)?)([A-Za-z0-9+/=]{32,})[^\S\r\n]*$/gm;

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
  // The kind is checked first and the vocabulary defaults to the policy's: a
  // caller that left either out got an empty label pass back, not an error.
  if (!KINDS.includes(options.kind)) {
    throw new TypeError(`collectCredentialSpans needs a kind from KINDS: ${options.kind}`);
  }
  const spans = [];
  const vocabulary = options.vocabulary ?? POLICY_VOCABULARY;

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
    const start = bareMatch.index + bareMatch[1].length;
    spans.push({ start, end: start + bareMatch[2].length, kind: "credential:base64-line" });
  }

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
