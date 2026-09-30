/**
 * Part of the redaction vocabulary, held as data: the part `vocabularyFrom`
 * lifts from the shell (keywords, auth-scheme words, token shapes).
 *
 * The rest of the sed `mask()` is NOT lifted: the passwd / passphrase rules, the
 * argument-position rules (`mysql -p`, `redis-cli -a`, `curl -u`), the URL
 * userinfo rule and the YAML doubled-apostrophe rule. The test below does not
 * see those rules, so a rule added to the shell in one of those families stays
 * green here while the two drift apart. `SECRET_LABELS` below carries the two
 * passwd / passphrase words; the core reads quotes (and so the doubled
 * apostrophe) itself. The argument-position rules come in the next step of #249.
 *
 * Today `redact-log.mjs` lifts this vocabulary out of the shipped sed `mask()` at
 * run time (`vocabularyFrom`), so the engine does not run where
 * `capture-command.sh` is absent, and an edit to the shell silently changes the
 * engine too (#249). This file is the same vocabulary written down once, so the
 * engine can stop reading a shell script.
 *
 * Until the sed `mask()` is retired, `tests/logRedactionPolicy.test.ts` asserts
 * that every field here equals what `vocabularyFrom` lifts from the shipped
 * shell. Change the shell and that test goes red until this file follows.
 * When `mask()` goes, the test goes with it, and this file becomes the only source.
 *
 * Nothing calls this yet: the hooks still run the sed `mask()`.
 */

/** Keywords whose following value is masked. Order is the shell's alternation order. */
export const KEYWORDS = Object.freeze(["token", "key", "secret", "password", "pat", "authorization", "bearer"]);

/**
 * The labels the core masks a value after: the shell's keywords plus the two
 * words the sed `mask()` handles in rules of their own. They are appended here
 * rather than added to `KEYWORDS`, which stays equal to what `vocabularyFrom`
 * lifts from the shell. In the sed `mask()` they could not join the shared
 * keyword group: the longest match then read a label's closing quote as its
 * value's opening quote (#232). The core decides quotes from the original text
 * first, so one list serves all nine.
 */
export const SECRET_LABELS = Object.freeze([...KEYWORDS, "passwd", "passphrase"]);

/**
 * Auth schemes whose credential is masked together with the scheme word. The last
 * one has a rule of its own in the shell rather than a place in the allowlist;
 * `vocabularyFrom` appends it last, and so does this list.
 */
export const SCHEME_WORDS = Object.freeze(["Basic", "Digest", "Token", "ApiKey", "OAuth", "SSWS", "Bearer"]);

/**
 * Token shapes masked wherever they occur. Each `source` is a verbatim substring
 * of the shipped shell, in the shell's order.
 */
export const SHAPES = Object.freeze(
  [
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "AKIA[0-9A-Z]{16}",
    "sk-[A-Za-z0-9_-]{20,}",
    "AIza[0-9A-Za-z_-]{35}",
    "xox[baprs]-[A-Za-z0-9-]{10,}"
  ].map((source) => Object.freeze({ kind: "credential:shape", source }))
);

/**
 * Input kinds the engine will be told about. Only two to start with (owner
 * decision 2026-09-28): the 137-case corpus has examples of these two and no
 * others. YAML's doubled apostrophe is read as an escape only for `text`; a
 * `command` is read with shell quoting. Add a kind when an adapter needs it and
 * the corpus holds an example of it.
 */
export const KINDS = Object.freeze(["command", "text"]);
