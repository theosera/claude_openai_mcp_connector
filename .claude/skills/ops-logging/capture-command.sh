#!/usr/bin/env bash
# ops-logging PostToolUse hook.
# Append "command + intent" of a git / shell / GitHub(MCP) action to the
# terminal-ops-logs repo. Records COMMAND + INTENT ONLY — stdout is never read,
# and token/credential patterns in the command string are fully masked.
# Never blocks the originating tool: always exits 0.
set -euo pipefail

LOG_REPO="${OPS_LOG_REPO:-$HOME/terminal-ops-logs}"
# Log repo not cloned (e.g. out-of-scope web session) → no-op, do not block.
[ -d "$LOG_REPO/.git" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

payload="$(cat)"
tool="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"

# --- command + intent per tool kind --------------------------------------
case "$tool" in
  Bash)
    cmd="$(printf '%s' "$payload"  | jq -r '.tool_input.command // empty')"
    intent="$(printf '%s' "$payload" | jq -r '.tool_input.description // ""')"
    ;;
  mcp__github__*)
    # MCP GitHub call has no shell command. Record the tool + a SMALL ALLOWLIST
    # of structural metadata only — never bodies / titles / comments / file
    # contents, which can carry private text or secrets the regex mask cannot
    # catch (keeps the "command + intent only" guarantee).
    safe="$(printf '%s' "$payload" | jq -c '
      (.tool_input // {})
      | {owner, repo, pullNumber, issue_number, branch, base, head, ref, sha,
         path, method, name, tag, state, mergeMethod}
      | with_entries(select(.value != null))' 2>/dev/null || printf '{}')"
    cmd="$tool $safe"
    intent="GitHub MCP operation (args redacted to safe metadata)"
    ;;
  *) exit 0 ;;
esac
[ -n "$cmd" ] || exit 0

# --- secret masking (command string is the only free-text we store) ------
mask() {
  # A credential in tool output is usually QUOTED ("access_token": "…",
  # {'api_key':'…'}), and the keyword rule at the bottom cannot see it: it ends
  # the value at whitespace, and a JSON line has none, so it never even starts —
  # the character after the keyword is a quote, not one of `=:` or a space.
  # The two rules below mask the quoted run instead, one per quote character so
  # the closing quote can be required without a back-reference (POSIX ERE has
  # none). The value is escape-aware, or `password: "p@ss\"word"` would end at
  # the ESCAPED quote and leave `word"` in the clear.
  #
  # A closing quote is REQUIRED, and that bound is the point. Without it the
  # value runs to end of line, which is F12's failure in a new place — a rule
  # that runs past its intended end. It bites here because these two hooks mask
  # whole Bash command strings and whole note bodies: `grep -n "token: " src/*.ts`
  # offers the string's CLOSING quote as an opening one, and everything after it
  # would be blanked. Requiring the close costs nothing, because an unterminated
  # value still falls through to the keyword rule below and is masked to
  # whitespace there, exactly as it was before these rules existed.
  #
  # That keyword rule is therefore left BYTE-IDENTICAL to its previous form: it
  # is the fallback that keeps this change from ever masking less than before.
  #
  # `Authorization: <scheme> <credential>` is TWO tokens, and that keyword rule
  # ends its value at the first whitespace: it eats the SCHEME word and leaves
  # the credential in the clear one space to the right of a `***MASKED***`
  # marker, which reads as a successful redaction. `Bearer` was the only shape
  # that escaped, because the dedicated rule above takes the token AFTER the
  # scheme -- which is also why `Bearer` is absent from the scheme list below:
  # that rule fires first, so nothing bearer-shaped ever reaches this one. The
  # rule takes the CREDENTIAL and leaves the scheme word standing, even though
  # the keyword rule below then masks that word too and the note ends up
  # carrying two markers side by side. Consuming the scheme here would read
  # better and measures WORSE: that rule ends its value at whitespace, so
  # `***MASKED***"` is a single token to it and the closing quote of a
  # `curl -H "<header>" <url>` goes with it. The value stops at a quote or a
  # comma as well as at whitespace, so that command keeps its closing quote and
  # its URL -- the same bound, and the same reason, as the quoted-run rules
  # above.
  #
  # The scheme is an ALLOWLIST, not `[A-Za-z][A-Za-z0-9-]*`. A general scheme
  # word turns this into "mask the second word after any keyword", which reaches
  # this note's own UNQUOTED frontmatter (`project:` / `repos: [...]` /
  # `tags: [...]`, masked value by value further down) and leaves the note
  # unparseable for a checkout named after a mask keyword. The list holds the
  # single-opaque-token schemes; an unlisted scheme is left exactly where the
  # keyword rule had it.
  #
  # The negated address is LOAD-BEARING, not decoration. sed applies each `-e`
  # in order to the pattern space AS IT STANDS, so a substitution here can
  # destroy the text a LATER rule's ADDRESS is matched against -- and the PEM
  # range below is addressed on the BEGIN marker. Without this address, a line
  # of the form `token: Basic <PEM BEGIN marker>` loses that marker to the value
  # class, the range never opens, and the body lines that follow behind a
  # `cat -n` / `> ` / `grep -n` prefix -- exactly the ones the whole-line
  # catch-all structurally cannot match -- are written out VERBATIM: key
  # material this hook masked BEFORE this rule existed. Measured at 54 of 54
  # (6 scheme spellings x 3 prefixes x 3 marker placements) with the address
  # removed, and 0 of 54 with it. Two things that do NOT fix it: excluding a
  # leading `-` from the value class closes only that one spelling, since a
  # value of `X<PEM BEGIN marker>` starts at `X` and swallows the marker anyway;
  # and moving this rule below the PEM rules disables it outright, because the
  # keyword rule below has already replaced the scheme word with `***MASKED***`
  # by the time it would run. Skipping marker lines is what holds, and it costs
  # nothing: on such a line the keyword rule still masks the scheme, exactly as
  # it did before.
  #
  # RESIDUE, recorded here rather than left for the next reader to discover: a
  # PARAMETER-LIST scheme closes only PARTLY. A Digest header carries
  # `username=`, `realm=` and `response=` parameters with QUOTED values, and the
  # value class ends at the first `"`, so the `response=` hash stays readable
  # beside the marker -- the very shape this rule closes for the opaque schemes.
  # Dropping `,` from the value class does not help; what stops it is the quote.
  # OAuth 1.0a headers have the same shape. It is unchanged ground rather than
  # new ground (the keyword rule alone masked the scheme word and stopped in the
  # same place), and a test pins it so the marker is never read as more than it
  # is.
  #
  # A PEM key body often arrives with a LINE PREFIX, and the whole-line rule
  # at the bottom sees none of them: `cat -n` writes a line number and a TAB,
  # a quoted transcript writes `> `, `grep -n` writes `file:12:`. (A diff `+` is
  # NOT one of those: `+` is in the base64 alphabet, so a `+`-prefixed body line
  # was already whole-line base64 and was already masked. The tests pin both
  # halves of that, because the wrong half is easy to assume.) So the body is
  # masked INSIDE the marker range, where a long base64 run is key material
  # whatever precedes it on the line.
  #
  # That range SUBSTITUTES runs -- it never blanks a line, and that is the whole
  # design. The session-archive copy of this function masks an ASSEMBLED note
  # that already carries that hook's `~~~~~~` fences (the ops-logging copy masks
  # a command string and folds it to one line afterwards, so no fence of its own
  # is at stake there), and a range that replaces whole lines deletes a CLOSING
  # fence along with the key: blank an odd number of fence lines and the parity
  # of everything after them inverts, and the next tool result is read as
  # top-level prose -- untrusted output promoted to something the operator said.
  # A run substitution cannot reach a fence line at all (no `~` is in the run
  # class), so the note's structure survives whatever the range covers. That is
  # also what makes the bound below safe: with a blanking action, ANY bound -- a
  # line ceiling, a blank line, the very tilde run this range ends at -- can blank
  # a fence line somewhere other than the END marker, and invert the parity of
  # everything after it.
  #
  # The range ends at the END marker or at the next `~~~` run. BOTH halves
  # of that bound are weaker than they look, so neither is claimed here as more
  # than it is:
  #
  #   - Confinement holds for FENCED blocks ONLY. The session-archive renderer
  #     fences tool results, thinking, and tool inputs, so a marker planted in
  #     one of those cannot reach past its own block. It does NOT fence
  #     assistant or user TEXT turns: a marker planted in one of those runs on
  #     through every following turn until the next block's opening fence, or to
  #     the END OF THE NOTE when no fenced block follows, substituting every 12+
  #     character run on the way. That run class is NOT base64: it is every
  #     alphanumeric plus `+ / = \`, and `/` is a member, so a run does not stop
  #     at a path separator. It therefore consumes ordinary twelve-letter words,
  #     whole hashes, and a whole absolute path as a SINGLE run
  #     (`/home/runner/work/repo/checkout`). What replaces them is
  #     `***MASKED***`, the same token a genuine redaction produces, so content
  #     destroyed this way reads as routine hygiene rather than as damage and
  #     prompts no one to look at it. Measured on a note of 30 synthetic
  #     `git log` lines and 3 repeated absolute paths: clean, 0 tokens masked
  #     and 30/30 SHAs and 3/3 paths kept; with ONE 31-byte marker planted, 91
  #     masked and 0/30 and 0/3 kept. That is the cost, and it is taken
  #     deliberately -- this range is what masks a prefixed key body at all. It
  #     cannot cost structure, because a substitution never deletes a line. A
  #     test pins that reach, so this paragraph cannot quietly stop being true.
  #   - A `~~~` line is not only the renderer's. Content is fenced but emitted
  #     VERBATIM, so a column-0 tilde run in a tool result's OWN body ends this
  #     range early, and the body lines after it are left to the whole-line rule
  #     -- which, behind a prefix, does not see them. That is a leak an attacker
  #     can reach for.
  #     Nor is that terminator a fence. The address is `^~{3,}`, unanchored at
  #     its right end, so a column-0 `~~~ label` closes this range (measured:
  #     all six prefixed body lines after it leak) even though the
  #     session-archive renderer scores that exact shape as closing nothing and
  #     deliberately does not widen a fence for it. The renderer's own comment
  #     says as much about that construction, so whichever of the two a
  #     reader meets first: "it cannot close a fence" is NOT a reason to think
  #     it cannot close this range.
  #     What it does not reach: a BEGIN marker that appears AFTER the tilde
  #     run reopens the range, so key material introduced past that point is
  #     masked again. It is POSITION that saves it, not possession -- a
  #     tilde planted between a key's own BEGIN line and its body closes the
  #     range before the body starts, and every body line is then left to
  #     the whole-line rule, which behind a prefix does not see them: 6 of 6
  #     leaking behind a `cat -n` prefix. That is the construction an
  #     attacker picks, so do not read this bullet as a bound on the leak.
  #
  # Read the two copies separately here, because this rule replaces something
  # different in each. `archive-session.sh` gains it outright: no input it
  # masked before is masked less. `capture-command.sh` had a whole-line
  # BLANKING range over the same markers, and this trades in both directions
  # at once. It masks LESS inside a block: base64 runs shorter than 12
  # characters -- a final body line of 4 or 8, where roughly one key size in
  # eight lands, at most 6 bytes of the trailing DER field -- plus non-base64
  # header text such as `Proc-Type:`, plus anything after a column-0 tilde
  # planted in the body. At the construction above, a tilde before any body
  # line, the archive copy is merely EQUAL to its base rather than better,
  # and this copy goes from fully masked to fully leaked. It also masks MORE,
  # in two ways that are not small: it gains the whole-line base64 catch-all
  # it never had, and it removes an UNBOUNDED failure. The old range had no
  # terminator but the END marker, so under POSIX sed an unterminated marker
  # anywhere in a multi-line command blanked every REMAINING line of the
  # logged command -- a `grep` for the marker text destroyed all 501 lines of
  # a command carrying no key material at all. A run substitution cannot do
  # that, and the tilde gives the range a second way to close. That failure
  # was this copy's alone; the archive copy never had the mode, which is why
  # it is recorded here and not as a general note.
  #
  # The range deliberately does NOT end at a blank line: an RFC 1421 encrypted
  # key writes `Proc-Type:` / `DEK-Info:` headers, then a BLANK LINE, and only
  # then its body -- a blank-line bound would stop exactly where the key material
  # starts.
  #
  # The whole-line rule below stays LAST: it is the catch-all for a body
  # pasted without its markers. `archive-session.sh` already carried it and
  # it is byte-identical there; `capture-command.sh` gains it here. Nothing
  # added above can make it MASK less than before. It does FIRE less often --
  # the in-range rule pre-empts it on lines it would have blanked -- and a
  # pre-empted line is masked just as completely, though not byte-for-byte:
  # this rule replaces the WHOLE line and so drops any surrounding
  # whitespace, where a run substitution keeps it, leaving `  ***MASKED***  `
  # rather than `***MASKED***`. Measured across every whitespace shape this
  # rule accepts, that retained whitespace is the ONLY residue, and no key
  # material survives on either path. The distinction is drawn here rather
  # than left for a reader to trip over.
  sed -E \
    -e 's/gh[pousr]_[A-Za-z0-9]{20,}/***MASKED***/g' \
    -e 's/github_pat_[A-Za-z0-9_]{20,}/***MASKED***/g' \
    -e 's#(://[^/:@[:space:]]+):[^/@[:space:]]+@#\1:***MASKED***@#g' \
    -e '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----|^~{3,}/s/[A-Za-z0-9+\/=]{12,}/***MASKED***/g' \
    -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----/***MASKED***/g' \
    -e 's/-----END [A-Z ]*PRIVATE KEY-----/***MASKED***/g' \
    -e 's/([Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]+)[^[:space:]]+/\1***MASKED***/g' \
    -e "s/((token|key|secret|password|pat|authorization|bearer)['\"]?[=:[:space:]]+\")([^\"\\\\]|\\\\.)*\"/\1***MASKED***\"/Ig" \
    -e "s/((token|key|secret|password|pat|authorization|bearer)['\"]?[=:[:space:]]+')([^'\\\\]|\\\\.)*'/\1***MASKED***'/Ig" \
    -e "/-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/!s/((token|key|secret|password|pat|authorization|bearer)[=:[:space:]]+(Basic|Digest|Token|ApiKey|OAuth|SSWS)[[:space:]]+)[^[:space:],\"']+/\1***MASKED***/Ig" \
    -e 's/((token|key|secret|password|pat|authorization|bearer)[=:[:space:]]+)[^[:space:]]+/\1***MASKED***/Ig' \
    -e 's/AKIA[0-9A-Z]{16}/***MASKED***/g' \
    -e 's/sk-[A-Za-z0-9_-]{20,}/***MASKED***/g' \
    -e 's/AIza[0-9A-Za-z_-]{35}/***MASKED***/g' \
    -e 's/xox[baprs]-[A-Za-z0-9-]{10,}/***MASKED***/g' \
    -e '/^[[:space:]]*[A-Za-z0-9+\/=]{32,}[[:space:]]*$/s/.*/***MASKED***/'
}
cmd_masked="$(printf '%s' "$cmd"    | mask | tr '\n' ' ')"
intent_masked="$(printf '%s' "$intent" | mask | tr '\n' ' ')"

# --- route to <origin_repo>/<date>.md ------------------------------------
# Every repo logs into its OWN folder, named after the origin repo — created
# on first command. Prefer the git repository root's name (correct even when
# cwd is a subdirectory); fall back to the cwd basename. No catch-all bucket.
repo_root="$(git -C "${cwd:-.}" rev-parse --show-toplevel 2>/dev/null || true)"
repo="$(basename "${repo_root:-${cwd:-}}" 2>/dev/null || true)"
# Sanitize to a single safe path segment: keep [A-Za-z0-9._-], everything else
# becomes '-'. Strip leading '-'/'.' so the name can't look like a git flag or
# resolve to '.'/'..'; empty result falls back to a fixed bucket.
repo="$(printf '%s' "$repo" | tr -c 'A-Za-z0-9._-' '-')"
while [ "${repo#[-.]}" != "$repo" ]; do repo="${repo#[-.]}"; done
[ -n "$repo" ] || repo='unknown'
branch="$(git -C "${cwd:-.}" branch --show-current 2>/dev/null || echo '-')"
[ -n "$branch" ] || branch='-'
date="$(date +%Y-%m-%d)"
dir="$LOG_REPO/$repo"
file="$dir/$date.md"
mkdir -p "$dir"

# Frontmatter + table header once per file.
if [ ! -f "$file" ]; then
  {
    printf -- '---\n'
    printf 'date: %s\n' "$date"
    printf 'target_repo: %s\n' "$repo"
    printf 'branch: %s\n' "$branch"
    printf 'tags: [git, gh, shell]\n'
    printf -- '---\n\n'
    printf '# %s — %s command log\n\n' "$date" "$repo"
    printf '| time | branch | command | intent |\n'
    printf '|---|---|---|---|\n'
  } >> "$file"
fi

esc() { printf '%s' "$1" | sed 's/|/\\|/g'; }   # escape pipes for the md table
printf '| %s | %s | `%s` | %s |\n' \
  "$(date +%H:%M:%S)" "$(esc "$branch")" "$(esc "$cmd_masked")" "$(esc "$intent_masked")" \
  >> "$file"

exit 0
