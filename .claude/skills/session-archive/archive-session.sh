#!/usr/bin/env bash
# session-archive Stop / SessionEnd / PreCompact hook.
# Render the FULL session transcript (user + assistant text, thinking, tool
# calls, tool results) into ONE Markdown note per session inside the private
# Obsidian vault clone, then commit & push. The note is regenerated from the
# transcript on every turn (idempotent overwrite of the same file), so an
# ephemeral container (Claude Code on the web) always leaves the latest state
# behind even if the session never ends cleanly.
# On PreCompact (before Claude Code auto-compacts and prunes the transcript) a
# point-in-time snapshot is written under <subdir>/_precompact/ so pre-compact
# detail is never lost; Stop/SessionEnd keep maintaining the single latest note.
#
# Privacy / safety:
#   - This script ships in a PUBLIC repo too, so the vault repo is NEVER named
#     here. It is located via $SESSION_VAULT_REPO, or by scanning $HOME/*/ for
#     a `.claude-session-vault` marker file committed at the vault clone root.
#     That marker only LOCATES a candidate; it travels inside a clone, so it
#     cannot authorize one. Authorization is $SESSION_VAULT_ORIGIN, or the
#     ~/.config/session-archive/vault-origin file — an out-of-band pin naming
#     the git remote this transcript may be pushed to.
#   - The destination folder inside the vault comes from $SESSION_LOG_SUBDIR,
#     else the first non-comment line of the marker file, else `claude-sessions`.
#   - Secret patterns are masked with the SAME rules as ops-logging
#     capture-command.sh (keep the two mask() functions in sync).
#   - No authorized vault clone -> no-op. Never blocks the turn: always exits 0.
set -euo pipefail

# Escape hatch for sessions that must not be archived.
[ "${SESSION_ARCHIVE_DISABLE:-0}" = "1" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

# --- the out-of-band vault pin ---------------------------------------------
# `.claude-session-vault` is committed at the vault clone root, which means it
# is also committable by anyone who can land a file in a repo this machine
# checks out. A value carried inside a clone therefore cannot decide where the
# full transcript goes: the marker locates a candidate, and this pin authorizes
# it. The pin names the REMOTE, not the directory, because `git push` is what
# takes the transcript off the machine -- authorizing a directory whose origin
# was never looked at leaves the transcript going wherever that origin points.
# Both sources are out of band: an env var, and a file under the user's config
# dir, which is outside every checkout and so cannot arrive in a clone.
# Trim the way git_url_id does, because the emptiness test below decides
# whether the pin file is read at all. Untrimmed, a stray space in the env
# var is non-empty, the file is skipped, and every candidate is then judged
# against a pin that resolves to nothing -- the operator is told their
# clones are wrong when the environment is.
VAULT_ORIGIN_PIN="$(printf '%s' "${SESSION_VAULT_ORIGIN:-}" \
  | sed -E -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//')"
# Remember WHY there is no pin, so the message below can tell the operator
# something they can act on. "No pin" and "a pin file you already wrote that
# yields nothing" need different fixes, and until now they printed the same
# line -- which told the operator to create the file they had just created.
pin_file_state=absent
if [ -z "$VAULT_ORIGIN_PIN" ]; then
  pin_file="${XDG_CONFIG_HOME:-$HOME/.config}/session-archive/vault-origin"
  if [ -f "$pin_file" ]; then
    if [ -r "$pin_file" ]; then
      VAULT_ORIGIN_PIN="$(grep -v '^[[:space:]]*#' "$pin_file" 2>/dev/null \
        | grep -m1 -v '^[[:space:]]*$' || true)"
      VAULT_ORIGIN_PIN="$(printf '%s' "$VAULT_ORIGIN_PIN" \
        | sed -E -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//')"
      if [ -n "$VAULT_ORIGIN_PIN" ]; then pin_file_state=ok
      else pin_file_state=empty; fi
    else
      pin_file_state=unreadable
    fi
  fi
fi

# Compare remotes by identity, not by spelling: one repository is written
# `git@host:owner/name.git`, `https://host/owner/name`, and -- inside a hosted
# container -- `https://x-access-token:<token>@host/owner/name.git`. Reduce all
# of them to `host/owner/name`, so a pin written once keeps matching and the
# comparison never handles the credential embedded in a URL.
git_url_id() {
  printf '%s' "${1:-}" | sed -E \
    -e 's/^[[:space:]]+//' \
    -e 's/[[:space:]]+$//' \
    -e 's#^[A-Za-z][A-Za-z0-9+.-]*://##' \
    -e 's#^[^/@]*@##' \
    -e 's#^([^/:]+):#\1/#' \
    -e 's#/+$##' \
    -e 's#\.git$##' | tr 'A-Z' 'a-z'
}

# True when $1 is a clone whose `origin` is the pinned vault. Both URLs must
# match: the push URL is where the transcript would land, and the fetch URL is
# where the rebase below takes commits from before pushing them on.
origin_is_pinned_vault() {
  local pin_id fetch_url push_url
  [ -n "$VAULT_ORIGIN_PIN" ] || return 1
  pin_id="$(git_url_id "$VAULT_ORIGIN_PIN")"
  [ -n "$pin_id" ] || return 1
  fetch_url="$(git -C "$1" remote get-url origin 2>/dev/null || true)"
  push_url="$(git -C "$1" remote get-url --push origin 2>/dev/null || true)"
  [ "$(git_url_id "$fetch_url")" = "$pin_id" ] && [ "$(git_url_id "$push_url")" = "$pin_id" ]
}

# --- locate the vault clone (env first, then marker-file scan) -------------
# The scan decides where the FULL transcript is pushed, so it must never resolve
# an ambiguous match: taking the first hit lets anyone who can drop a marked
# clone under $HOME win the glob order and receive every future session. Env
# still wins outright; the scan resolves only on exactly one candidate and
# otherwise archives nothing -- the same no-op the "no vault found" case takes.
VAULT_REPO="${SESSION_VAULT_REPO:-}"
if [ -z "$VAULT_REPO" ]; then
  scan_hit=""
  scan_count=0
  marked_count=0
  for candidate in "$HOME"/*/; do
    if [ -f "${candidate}.claude-session-vault" ] && [ -d "${candidate}.git" ]; then
      marked_count=$((marked_count + 1))
      # The marker says "I am a vault"; only the pin says the operator chose
      # this one. Without this line the sole credential needed to receive every
      # future transcript is a file committed inside a clone.
      origin_is_pinned_vault "${candidate%/}" || continue
      scan_hit="${candidate%/}"
      scan_count=$((scan_count + 1))
    fi
  done
  # Say that archiving stopped, but never name the candidates or the pin: this
  # script ships in a public repo, those strings are the vault location, and a
  # container's origin URL can carry a token. The count is what the operator
  # acts on, and silence here would look like a working archive that quietly
  # stopped writing.
  if [ "$scan_count" -eq 1 ]; then
    VAULT_REPO="$scan_hit"
  elif [ "$scan_count" -gt 1 ]; then
    printf 'session-archive: %s marked vault clones under $HOME; set SESSION_VAULT_REPO to choose one. Not archiving.\n' \
      "$scan_count" >&2
  elif [ -n "$VAULT_ORIGIN_PIN" ] && [ "$marked_count" -gt 0 ]; then
    printf 'session-archive: %s marked vault clone(s) under $HOME, none with the pinned origin. Not archiving.\n' \
      "$marked_count" >&2
  elif [ "$marked_count" -gt 0 ] && [ "$pin_file_state" = empty ]; then
    printf 'session-archive: %s marked vault clone(s) under $HOME, and the vault pin file exists but holds no non-comment line. Add the vault remote to it, or set SESSION_VAULT_ORIGIN. Not archiving.\n' \
      "$marked_count" >&2
  elif [ "$marked_count" -gt 0 ] && [ "$pin_file_state" = unreadable ]; then
    printf 'session-archive: %s marked vault clone(s) under $HOME, and the vault pin file exists but could not be read. Check its permissions. Not archiving.\n' \
      "$marked_count" >&2
  elif [ "$marked_count" -gt 0 ]; then
    printf 'session-archive: %s marked vault clone(s) under $HOME but no vault pin, and a marker committed inside a clone cannot authorize a push destination. Set SESSION_VAULT_REPO, or pin the vault remote in SESSION_VAULT_ORIGIN or ~/.config/session-archive/vault-origin. Not archiving.\n' \
      "$marked_count" >&2
  fi
fi
{ [ -n "$VAULT_REPO" ] && [ -d "$VAULT_REPO/.git" ]; } || exit 0
# A configured pin constrains the explicitly selected vault too, and it is
# checked here -- before anything is rendered, written, committed or pushed.
if [ -n "$VAULT_ORIGIN_PIN" ] && ! origin_is_pinned_vault "$VAULT_REPO"; then
  printf 'session-archive: the selected vault clone does not have the pinned origin. Not archiving.\n' >&2
  exit 0
fi

# --- destination subdir: env > marker first line > default -----------------
SUBDIR="${SESSION_LOG_SUBDIR:-}"
if [ -z "$SUBDIR" ] && [ -f "$VAULT_REPO/.claude-session-vault" ]; then
  SUBDIR="$(grep -v '^[[:space:]]*#' "$VAULT_REPO/.claude-session-vault" 2>/dev/null \
    | grep -m1 -v '^[[:space:]]*$' || true)"
fi
SUBDIR="${SUBDIR:-claude-sessions}"
# Containment: the subdir must stay inside the vault clone.
case "$SUBDIR" in
  /*|*..*) exit 0 ;;
esac

# --- hook payload -----------------------------------------------------------
payload="$(cat)"
transcript="$(jq -r '.transcript_path // empty' <<<"$payload")"
session_id="$(jq -r '.session_id // empty' <<<"$payload")"
cwd="$(jq -r '.cwd // empty' <<<"$payload")"
[ -n "$session_id" ] || session_id="unknown-session"
sid8="${session_id:0:8}"

# Hook event decides what we do: Stop / SessionEnd render+overwrite the single
# "latest" note; PreCompact writes a point-in-time snapshot BEFORE compaction
# prunes the transcript. Mode from an explicit arg, else the payload event.
event="$(jq -r '.hook_event_name // empty' <<<"$payload")"
mode="${1:-}"
if [ -z "$mode" ]; then
  case "$event" in
    PreCompact) mode="precompact" ;;
    *) mode="latest" ;;
  esac
fi

# Claude Code flushes the transcript JSONL after the Stop hook starts, so wait
# before reading (empirical value from the local session-log-to-obsidian hook).
# PreCompact fires with the transcript already complete and must be quick so it
# does not delay compaction — skip the wait there.
[ "$mode" = "precompact" ] || sleep 3

# Resume sessions can hand the hook a transcript_path that no longer exists —
# fall back to locating the JSONL by session id under ~/.claude/projects.
if [ -z "$transcript" ] || [ ! -f "$transcript" ]; then
  transcript="$(find "$HOME/.claude/projects" -type f -name "${session_id}.jsonl" 2>/dev/null | head -1 || true)"
fi
{ [ -n "$transcript" ] && [ -f "$transcript" ]; } || exit 0

# --- repos touched this session ---------------------------------------------
# Multi-repo web sessions run with cwd at the PARENT of the checkouts, so the
# payload cwd alone cannot say which repos were worked on. Detect them from
# the transcript itself: (a) every distinct per-line cwd that lies inside a
# git repo (covers CLI + cd), (b) sibling $HOME-level checkouts whose absolute
# path appears in tool_use INPUTS (Edit/Write/Bash paths — tool results are
# deliberately ignored to avoid false positives from mere mentions).
vault_real="$(realpath "$VAULT_REPO" 2>/dev/null || printf '%s' "$VAULT_REPO")"
repos=""
add_repo() { case " $repos " in *" $1 "*) ;; *) repos="${repos:+$repos }$1" ;; esac; }
while IFS= read -r wd; do
  [ -n "$wd" ] && [ -d "$wd" ] || continue
  top="$(git -C "$wd" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] || continue
  [ "$(realpath "$top" 2>/dev/null || printf '%s' "$top")" = "$vault_real" ] && continue
  add_repo "$(basename "$top")"
done < <(jq -rs '[ .[] | .cwd // empty | select(length > 0) ] | unique | .[]' "$transcript")
tool_inputs="$(jq -rs '[ .[] | (.message.content? // empty)
  | if type == "array" then .[] else empty end
  | select(.type == "tool_use") | .input | tostring ] | join("\n")' "$transcript")"
for candidate_dir in "$HOME"/*/; do
  candidate="${candidate_dir%/}"
  name="$(basename "$candidate")"
  [ -d "$candidate/.git" ] || continue
  [ "$(realpath "$candidate" 2>/dev/null || printf '%s' "$candidate")" = "$vault_real" ] && continue
  case "$tool_inputs" in *"$HOME/$name"*) add_repo "$name" ;; esac
done

# Primary repo for `project`: the payload cwd when it is itself a checkout,
# else the first detected repo, else the cwd basename (old behavior).
primary_top="$(git -C "${cwd:-.}" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$primary_top" ] \
  && [ "$(realpath "$primary_top" 2>/dev/null || printf '%s' "$primary_top")" != "$vault_real" ]; then
  repo="$(basename "$primary_top")"
elif [ -n "$repos" ]; then
  repo="${repos%% *}"
else
  repo="$(basename "${cwd:-unknown}")"
fi
[ -n "$repos" ] || repos="$repo"

branch="$(git -C "${cwd:-.}" branch --show-current 2>/dev/null || echo '-')"
if { [ -z "$branch" ] || [ "$branch" = "-" ]; } && [ -d "$HOME/$repo/.git" ]; then
  branch="$(git -C "$HOME/$repo" branch --show-current 2>/dev/null || echo '-')"
fi
[ -n "$branch" ] || branch='-'

# --- session date + title (jq slices are codepoint-safe for Japanese) ------
date_start="$(jq -rs '[ .[] | .timestamp // empty | select(length > 0) ] | first // empty | .[0:10]' "$transcript")"
[ -n "$date_start" ] || date_start="$(date +%Y-%m-%d)"

# mask() is defined here, not further down, because safe_title (below) must
# be built from a MASKED title: the filename is committed and pushed, so a
# credential in the title would leave the machine in cleartext even though
# the body copy is redacted. It reads no variables, so moving it is inert.

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
    -e 's/([Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]+)([^[:space:]-]|-{1,4}[^[:space:]-])+/\1***MASKED***/g' \
    -e "/-----(BEGIN|END) ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----/!s/((token|key|secret|password|pat|authorization|bearer)['\"]?[=:[:space:]]+\")([^\"\\\\]|\\\\.)*\"/\1***MASKED***\"/Ig" \
    -e "s/((token|key|secret|password|pat|authorization|bearer)['\"]?[=:[:space:]]+\")([^\"\\\\-]|\\\\.|-{1,4}([^\"\\\\-]|\\\\.))*-{0,4}\"/\1***MASKED***\"/Ig" \
    -e "/-----(BEGIN|END) ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----/!s/((token|key|secret|password|pat|authorization|bearer)['\"]?[=:[:space:]]+')([^'\\\\]|\\\\.)*'/\1***MASKED***'/Ig" \
    -e "s/((token|key|secret|password|pat|authorization|bearer)['\"]?[=:[:space:]]+')([^'\\\\-]|\\\\.|-{1,4}([^'\\\\-]|\\\\.))*-{0,4}'/\1***MASKED***'/Ig" \
    -e "s/((token|key|secret|password|pat|authorization|bearer)[=:[:space:]]+(Basic|Digest|Token|ApiKey|OAuth|SSWS)[[:space:]]+)([^[:space:],\"'-]|-{1,4}[^[:space:],\"'-])+/\1***MASKED***/Ig" \
    -e 's/((token|key|secret|password|pat|authorization|bearer)[=:[:space:]]+)([^[:space:]-]|-{1,4}[^[:space:]-])+/\1***MASKED***/Ig' \
    -e '/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----/,/-----END ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----|^~{3,}/s/[A-Za-z0-9+\/=]{12,}/***MASKED***/g' \
    -e 's/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----/***MASKED***/g' \
    -e 's/-----END ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----/***MASKED***/g' \
    -e 's/AKIA[0-9A-Z]{16}/***MASKED***/g' \
    -e 's/sk-[A-Za-z0-9_-]{20,}/***MASKED***/g' \
    -e 's/AIza[0-9A-Za-z_-]{35}/***MASKED***/g' \
    -e 's/xox[baprs]-[A-Za-z0-9-]{10,}/***MASKED***/g' \
    -e '/^[[:space:]]*[A-Za-z0-9+\/=]{32,}[[:space:]]*$/s/.*/***MASKED***/'
}

# Title priority: aiTitle (the session title Claude Code generates and keeps
# updating — take the LAST value), then the latest summary entry, then the
# first real user message, then the session id.
title="$(jq -rs '[ .[] | .aiTitle // empty | select(type == "string" and length > 0) ] | last // empty | .[0:80]' "$transcript")"
if [ -z "$title" ]; then
  title="$(jq -rs '[ .[] | select(.type == "summary") | .summary // empty | select(length > 0) ] | last // empty | .[0:80]' "$transcript")"
fi
if [ -z "$title" ]; then
  title="$(jq -rs '[ .[]
      | select(.type == "user" and ((.isMeta // false) | not))
      | .message.content
      | if type == "string" then .
        elif type == "array" then ([ .[] | select(.type == "text") | .text // "" ] | join(" "))
        else "" end
      | gsub("<(?:local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)[^>]*>.*?</[^>]+>"; ""; "s")
      | gsub("[[:space:]]+"; " ") | select(length > 0)
    ] | first // empty | .[0:80]' "$transcript")"
fi
[ -n "$title" ] || title="Claude Code session $sid8"

# Filename-safe title: separators become spaces (keeps word boundaries, same
# convention as the local session-log hook), decoration/link chars are dropped.
# All affected chars are ASCII, so this is byte-safe for UTF-8 titles.
safe_title="$(printf '%s' "$title" | mask | tr '/\\:|<>' '      ' | tr -d '*?"#^[]' | tr -d '\000-\037' \
  | sed 's/[[:space:]]\{1,\}/ /g; s/^[ .-]*//; s/[ .-]*$//')"
[ -n "$safe_title" ] || safe_title="session"
# Destination path (relative to the vault) differs by mode:
#   latest     -> <subdir>/<date>_<title>_<sid8>.md              (one note/session, overwritten each turn)
#   precompact -> <subdir>/_precompact/..precompact-<stamp>.md   (additive point-in-time snapshots)
old_rel=""
if [ "$mode" = "precompact" ]; then
  rel_path="$SUBDIR/_precompact/${date_start}_${safe_title}_${sid8}.precompact-$(date -u +%Y%m%d-%H%M%S).md"
else
  rel_path="$SUBDIR/${date_start}_${safe_title}_${sid8}.md"
fi
dest="$VAULT_REPO/$rel_path"
dest_dir="$(dirname "$dest")"
mkdir -p "$dest_dir"

# One note per session (latest mode only): the session-id suffix is the stable
# key. If an earlier turn archived this session under a different title-derived
# name (the summary title can appear or change mid-session), move that note to
# the current name instead of leaving a stale duplicate with the same id.
if [ "$mode" != "precompact" ]; then
  for existing in "$dest_dir"/*"_${sid8}.md"; do
    [ -f "$existing" ] || continue
    [ "$existing" = "$dest" ] && continue
    mv -f "$existing" "$dest"
    old_rel="$SUBDIR/$(basename "$existing")"
    break
  done
fi

# --- secret masking (same rules as ops-logging capture-command.sh) ---------

# --- render the transcript to Markdown --------------------------------------
# Full raw log: user/assistant text verbatim, thinking blocks, tool calls with
# inputs, tool results with outputs. Fences are sized to their own content (see
# fence below) so embedded ``` / ~~~ cannot break out of a block.
body_jq='
  def ts: (.timestamp // "") | sub("T"; " ") | .[0:19];
  # A tilde run inside the content CLOSES a fixed-length fence (CommonMark: a
  # closing fence is the same character, at least as many, indented <= 3), so
  # the untrusted text escapes the block and becomes top-level Markdown -- a
  # forged "## User" turn in a note that is committed, pushed, and later served
  # back over MCP as a faithful record of the session. Six tildes were not a
  # bound, only a longer guess than the content usually makes.
  #
  # Size the fence to the content instead: longer than any tilde run the content
  # could close the block with, so no line in it can end the block whatever it
  # holds. Tool results are the reachable source (fetched pages, file reads,
  # vault bodies); thinking / Bash / tool-input blocks share this helper and are
  # covered by the same change.
  #
  # Only runs that could ACTUALLY close count: at a line start, indented at most
  # three, and followed by nothing but whitespace. A run mid-line, or one trailed
  # by text (`~~~~~~ label`), closes nothing, so widening for it would rewrite
  # notes that were never at risk -- ordinary prose still renders at six.
  #
  # "A line start" means the line model the READER uses, not the one jq uses.
  # CommonMark ends a line on LF, on CRLF, and on a BARE CR (U+000D) too, but
  # split("\n") only knows LF, so `~~~~~~<CR>## User` arrives as ONE jq line
  # whose rest is non-whitespace: it scores 0, the fence opens at six, and the
  # reader then sees a six-tilde line that closes it. (CRLF already scored,
  # because the leftover CR is [[:space:]] -- only the BARE CR was invisible.)
  # Split on CR as well, so both models cut the text into the same lines.
  #
  # Split on it, do NOT fold it with a regex. One-argument split is a plain
  # string split; gsub("\r\n?"; "\n") walks the WHOLE text and measured
  # QUADRATIC (CR-dense tool output, 32 -> 128 KB: 1.31s -> 19.19s, ~3.9x per
  # doubling, against a flat 0.01s before). This renders the ENTIRE transcript
  # on every turn and no hook in settings.json sets a timeout, so one poisoned
  # tool result would get the renderer killed before the single write below --
  # silently erasing the record of its own arrival and of every turn after it.
  #
  # The startswith filter is what keeps cutting more lines from costing more: a
  # line beginning with neither `~` nor a space cannot be a closing fence (with
  # no leading space `^ {0,3}` takes nothing, so `~*` captures an EMPTY run and
  # the line scores 0 whatever follows), so dropping it before the per-line
  # regex discards a contribution that was already 0. Measured at 128 KB, the
  # ordinary shapes get faster and CR-dense text gets slower: CRLF 0.028s ->
  # 0.009s, LF 0.028s -> 0.008s, CR-dense 0.009s -> 0.021s. Every shape stays
  # linear in size, and the WORST case over inputs falls (9.0 -> 4.9 s/MB), so
  # the CR-dense cost does not raise the bound an attacker can reach.
  #
  # Splitting is measurement-only: $t is still emitted byte-for-byte, so the
  # ONLY thing the splitting can change is the fence length, and CR that content
  # legitimately carries (Windows-authored files, curl progress redraws)
  # survives it intact. $t is not the text as it ARRIVED, though: it is bound
  # from $text with `ESC[...m` and `ESC[...K` already removed, and that is the
  # ONLY removal the body gets: the assembled note no longer passes through
  # strip_ansi, which now covers the frontmatter and title alone. A second pass
  # ran AFTER this measurement and could collapse a nested sequence into a bare
  # closing fence, so it was moved off the body. Terminal control sequences outside them are untouched
  # by either pass and do reach the note. It stops at U+000D: U+2028 /
  # U+2029 / U+0085 / form feed are not CommonMark line endings, so folding them
  # would widen fences that no reader could have closed.
  def fence($lang; $text):
    # 採寸の【前】に正規化する。採寸後に文字を削除しうるフィルタは、封じ込めの
    # 問いを開け直す（F2）。パターンは strip_ansi と同一に保つこと — あちらで
    # 剥がれてこちらで剥がれない列が 1 つでもあると、穴がそのまま戻る。
    # Strip PER LINE, not over the whole text. A whole-text gsub materialises the
    # match array and rebuilds the string once per match, so it costs O(matches x
    # length) -- the same quadratic the CR fold was rejected for two paragraphs
    # above. Splitting first bounds each pass by its own line.
    (($text // "") | split("\n") | map(gsub("\u001b\\[[0-9;]*[mK]"; "")) | join("\n")) as $t
    | ([ $t
         | split("\n")[] | split("\r")[]
         | select(startswith("~") or startswith(" "))
         | capture("^ {0,3}(?<run>~*)(?<rest>.*)$")
         | if (.rest | test("^[[:space:]]*$")) then (.run | length) else 0 end ] | max // 0) as $longest
    | (if $longest >= 6 then $longest + 1 else 6 end) as $n
    | ("~" * $n) as $f
    | $f + $lang + "\n" + $t + "\n" + $f;
  # Strip harness-injected wrapper tags from USER text only (command echoes,
  # system reminders, hook output). Actual user words stay verbatim.
  # Text turns are written at TOP LEVEL, unfenced, so a line the model echoed can
  # become real note structure -- a forged User heading with a plausible timestamp,
  # read back over MCP as what the operator said. Escape only the ATX heading run:
  # over this conversation it is 3,982 lines of 58,507 (6.8%), while also escaping
  # tilde and backtick runs would add 7,336 more, nearly all backticks in code the
  # operator wrote. Tilde-fence lines occurred 0 times in two independent samples.
  # Setext underlines and blockquotes stay untouched: they cannot forge the
  # heading-plus-timestamp shape a turn is written as.
  # This runs where the turn is assembled and nothing measures a text turn, so no
  # later pass can undo it -- the fence sizer never sees these lines.
  def defang:
    # A "line" here has to mean what def fence means by it. fence sizes over
    # split("\n")[] | split("\r")[], so a bare CR already ends a line for the
    # measurement -- and CommonMark agrees: LF, CR and CRLF are all line
    # endings. Splitting on "\n" alone let "text\r## Fake" through, measured as
    # one line and rendered as two, the second an unescaped ATX heading in
    # top-level prose. Do NOT fold CR into LF to close this: the whole-text
    # gsub("\r\n?"; "\n") is the quadratic pass rejected at the top of this
    # renderer. split/join is linear and restores every byte it did not escape.
    def esc: sub("^(?<s> {0,3})(?<h>#{1,6}[ \t])"; "\(.s)\\\(.h)");
    split("\n")
    | map(split("\r") | map(esc) | join("\r"))
    | join("\n");
  def clean_user:
    gsub("<(?:local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)[^>]*>.*?</[^>]+>"; ""; "s")
    | gsub("^[[:space:]]+|[[:space:]]+$"; "");
  def tool_result_text:
    if type == "string" then .
    elif type == "array" then
      ([ .[] | if .type == "text" then (.text // "") else "[" + (.type // "block") + "]" end ] | join("\n"))
    elif . == null then ""
    else tojson end;
  [ .[]
    | select((.type == "user" or .type == "assistant") and ((.isMeta // false) | not))
    | . as $line
    | (.message.content // []) as $content
    | if .type == "user" then
        (if ($content | type) == "string" then
           (($content | clean_user | defang) as $cleaned
            | if ($cleaned | length) > 0
              then [ "## 👤 User — " + ($line | ts) + "\n\n" + $cleaned ] else [] end)
         else
           [ $content[]
             | if .type == "text" then
                 (((.text // "") | clean_user | defang) as $cleaned
                  | if ($cleaned | length) > 0
                    then "## 👤 User — " + ($line | ts) + "\n\n" + $cleaned else empty end)
               elif .type == "tool_result" then "#### 📥 Tool result\n\n" + fence(""; (.content | tool_result_text))
               else empty end ]
         end)
      else
        [ $content[]
          | if .type == "text" then "## 🤖 Assistant — " + ($line | ts) + "\n\n" + ((.text // "") | defang)
            elif .type == "thinking" then "#### 💭 Thinking\n\n" + fence(""; (.thinking // ""))
            elif .type == "tool_use" then
              (if .name == "Bash" then
                 "#### 🔧 Bash — " + ((.input.description // "") | gsub("[[:space:]]+"; " ")) + "\n\n" + fence("bash"; (.input.command // ""))
               else
                 "#### 🔧 Tool use: " + (.name // "unknown") + "\n\n" + fence("json"; ((.input // {}) | tojson))
               end)
            else empty end ]
      end
    | .[]
  ] | join("\n\n")
'

yaml_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# `project` / `repos` / `tags` carry basenames of the checkouts worked in, and
# `mask` can replace one outright with `***MASKED***`. Emitted BARE, a scalar
# starting with `*` is a YAML alias, so the whole frontmatter throws and
# parseMarkdownSafe degrades the note to NO frontmatter — no id, no title, no
# project, `tags: []` — for every reader on the MCP side. Quote them the way
# `title` and `branch` already are.
#
# yaml_seq quotes each ELEMENT, never the whole flow sequence: `repos: "a, b"`
# parses, but the list silently becomes a string, and `tags` is on the server's
# frontmatter allowlist, so that type change would travel into the read path.
# Escaping runs BEFORE the space split, so a `"` or `\` inside a name cannot
# close its own element and open a frontmatter key of its own.
#
# Empty fragments (a name with a leading, trailing or doubled space) are
# DROPPED rather than quoted. Bare, `[a, , b]` parsed to a null that the read
# path's `item != null` filter (src/frontmatter.ts, toStringArray) took back out
# of `tags`, whereas a quoted `""` would PASS that filter and add a member. So
# dropping is what keeps `tags` exactly the array the bare emitter delivered,
# and it leaves `repos` — which `toPublicDocument` (src/server.ts) returns
# wholesale, so it DOES reach every client's `fetch_document` payload — those
# same names without the bare null between them.
#
# What quoting does change, for the names YAML used to auto-type: a checkout
# named `null` reached the read path with `project` DELETED and its tag
# filtered out, and one named `2026-01-01` as a Date that `String(value)`
# renders differently per timezone and locale — both are now the literal name.
# `project` also keeps edge whitespace that a bare scalar was trimmed of
# (`repos`/`tags` do not, per the paragraph above). All pinned in
# tests/sessionArchive.test.ts.
yaml_seq() {
  local escaped
  escaped="$(yaml_escape "$1" | sed 's/  */ /g; s/^ //; s/ $//')"
  [ -n "$escaped" ] || return 0
  printf '"%s"' "$(printf '%s' "$escaped" | sed 's/ /", "/g')"
}
# ANSI escape sequences (colors, line clears) leak into raw tool output and
# make the note unreadable in Obsidian — strip them everywhere.
ESC_CHAR="$(printf '\033')"
strip_ansi() { sed -E "s/${ESC_CHAR}\[[0-9;]*[mK]//g"; }
now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmp="$(mktemp)"
body_tmp="$(mktemp)"
trap 'rm -f "$tmp" "$body_tmp"' EXIT

jq -rs "$body_jq" "$transcript" > "$body_tmp"
# No real conversation turns -> write nothing (no orphan stubs, and never
# overwrite a good note with an empty regeneration).
grep -q '[^[:space:]]' "$body_tmp" || exit 0

# Mask every free-text / path-derived frontmatter value INDIVIDUALLY, before
# assembling the note. Previously the whole block was piped through `mask`, but
# that let the value pattern consume the closing quote of a quoted value
# containing a `key=…`/`token=…` substring (a branch or title), reintroducing
# malformed YAML. Masking each value up front — and the body separately below —
# preserves the full masking coverage (title / branch / project / repos / tags /
# body; project & repos are basenames derived from cwd / tool-input paths, so a
# checkout literally named `token=…` must still be masked) while leaving the YAML
# quotes intact. The remaining fields are a literal, a UUID, and timestamps,
# which cannot carry secrets.
title_masked="$(printf '%s' "$title" | mask)"
branch_masked="$(printf '%s' "$branch" | mask)"
project_masked="$(printf '%s' "$repo" | mask)"
repos_masked="$(printf '%s' "$repos" | mask)"
{
  {
    printf -- '---\n'
    printf 'id: cc-session-%s\n' "$session_id"
    printf 'title: "%s"\n' "$(yaml_escape "$title_masked")"
    printf 'client: claude-code\n'
    printf 'project: "%s"\n' "$(yaml_escape "$project_masked")"
    printf 'date: %s\n' "$date_start"
    printf 'branch: "%s"\n' "$(yaml_escape "$branch_masked")"
    printf 'session_id: %s\n' "$session_id"
    printf 'repos: [%s]\n' "$(yaml_seq "$repos_masked")"
    printf 'tags: [%s]\n' "$(yaml_seq "claude-code-session $repos_masked")"
    printf 'updated_at: %s\n' "$now_iso"
    printf -- '---\n\n'
    printf '# %s\n\n' "$title_masked"
  } | strip_ansi
  { cat "$body_tmp"; printf '\n'; } | mask
} > "$tmp"

# Idempotence: skip the rewrite if nothing changed apart from the updated_at
# stamp. Do NOT exit here — a commit from a previous turn may still be
# unpushed (transient push failure), and the git block below must retry it.
if [ -f "$dest" ] && diff -q \
  <(grep -v '^updated_at: ' "$dest") <(grep -v '^updated_at: ' "$tmp") >/dev/null 2>&1; then
  rm -f "$tmp"
else
  mv "$tmp" "$dest"
fi
rm -f "$body_tmp"
trap - EXIT

# --- commit & push (only the generated note; never `git add -A`) -----------
(
  cd "$VAULT_REPO" || exit 0
  git add -- "$rel_path" || exit 0
  if [ -n "$old_rel" ]; then
    git add -- "$old_rel" || true # records the deletion side of the rename
  fi
  if ! git diff --cached --quiet; then
    if [ "$mode" = "precompact" ]; then
      git commit -q -m "claude session: precompact snapshot $date_start $project_masked ($sid8)" || exit 0
    else
      git commit -q -m "claude session: $date_start $project_masked ($sid8)" || exit 0
    fi
  fi
  # Push whenever unpushed session commits remain — including one committed on
  # a previous turn whose push failed (an ephemeral container must not end with
  # the archive stranded in a local commit). Turns that carry only someone
  # else's local commits are never pushed.
  if upstream="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null)"; then
    git log "$upstream"..HEAD --format=%s 2>/dev/null | grep -q '^claude session:' || exit 0
  fi
  for delay in 0 2 4 8 16; do
    [ "$delay" -gt 0 ] && sleep "$delay"
    if git push -u origin HEAD >/dev/null 2>&1; then
      exit 0
    fi
    # Non-fast-forward (another session pushed first): rebase and retry.
    git pull --rebase --autostash origin "$(git branch --show-current)" >/dev/null 2>&1 \
      || git rebase --abort >/dev/null 2>&1 || true
  done
) || true
exit 0
