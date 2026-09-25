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
#
# Only the HOST is case-folded. The path keeps its case: a case-sensitive git
# server serves `Owner/Vault` and `owner/vault` as two repositories, and folding
# the path made the pin accept the one the operator never named (#188). A port
# is part of the host, never of the path: in `ssh://host:22/owner/name` the
# `22` is a port, while in scp-style `host:22/owner/name` everything after the
# colon is the path -- the old rule read both as `host/22/owner/name` and so
# judged two different remotes equal. An explicit port stays in the identity
# exactly as written, even a scheme's default one: an unported SSH URL goes to
# whatever port `~/.ssh/config` assigns the host, while `ssh://host:22/` forces
# 22, so the two can reach different servers and must not compare equal. A pin
# is therefore written with the same port the remote carries, or none.
#
# The host is found the way git finds it BEFORE anything is stripped as
# userinfo. Without a scheme, git reads `[user@]host:path` as an SSH remote
# only when the first colon comes before any slash, and everything else as a
# local path; the identity splits at that same colon first. Stripping
# `^[^/@]*@` from the whole string before that split read
# `evil.example:x@github.com/owner/vault` as userinfo plus the pinned
# `github.com/owner/vault`, while git handed `evil.example` to ssh with
# `x@github.com/owner/vault` as the path -- the pin matched and the transcript
# went to the other host (#207 change scan, F4/F6).
#
# Two more spellings of the same defect, found by the scan of this change:
# git percent-decodes a URL before it looks for the host, so
# `ssh://evil.example%2Fx@github.com/owner/vault` is `evil.example` to git;
# and git reads a leading `[...]` group as the whole host whatever follows the
# `]`, so `[evil.example]@github.com:owner/vault` is `evil.example` to git
# while a userinfo rule sees `github.com`. So the identity is derived only
# from a host segment of one plain shape, and any other spelling gets none.
git_url_id() {
  local url scheme seg host rest
  url="$(printf '%s' "${1:-}" | sed -E -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//')"
  scheme=""
  case "$url" in
    *://*) scheme="$(printf '%s' "${url%%://*}" | tr 'A-Z' 'a-z')"; url="${url#*://}" ;;
  esac
  if [ -n "$scheme" ]; then
    # The authority ends at the first slash. Only the authority is
    # percent-decoded -- the way git decodes a URL before it looks for the
    # host -- and a decoded control character is no remote at all. The path
    # stays as spelled: the http transport sends it encoded, so
    # `/owner/vault%2F` and `/owner/vault/` are two resources to the server
    # and must stay two identities.
    seg="${url%%/*}"
    rest="${url#"$seg"}"
    case "$seg" in
      *%[01][0-9A-Fa-f]*|*%7[Ff]*) return 0 ;;
    esac
    seg="$(printf '%b' "$(printf '%s' "$seg" \
      | sed -E -e 's/\\/\\\\/g' -e 's/%([0-9A-Fa-f]{2})/\\x\1/g')")"
  else
    seg="${url%%:*}"
    if [ "$seg" = "$url" ] || [ "${seg#*/}" != "$seg" ]; then
      # No colon, or a slash before the first one: a local path, no host.
      seg=""
      rest="$url"
    else
      # scp-style: everything after the first colon is the path -- except
      # that a bracketed IPv6 host keeps its own colons, so for
      # `[user@][2001:db8::1]:path` the path starts after the `]:`. `:path`
      # names no host at all.
      case "$url" in
        \[*\]:*|*@\[*\]:*) seg="${url%%\]:*}]"; rest="/${url#*\]:}" ;;
        *) rest="/${url#*:}" ;;
      esac
      [ -n "$seg" ] || return 0
    fi
  fi
  host=""
  if [ -n "$seg" ]; then
    # `[user@]host[:port]`, with a plain host: a name or IPv4 address, or a
    # bracketed IPv6 literal. Userinfo may carry only the characters RFC 3986
    # allows there -- in particular not `?` or `#`, where libcurl ends the
    # host (`https://evil.example?@github.com/` connects to evil.example), and
    # not `@`, `[`, `]` or `/`. Anything else -- a bracket group that is not
    # that literal, a second at-sign, `user@:path` with no host -- gets no
    # identity and so can never equal a pin.
    printf '%s' "$seg" \
      | grep -Eq '^([A-Za-z0-9._~%!$&()*+,;=:-]*@)?([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?$' \
      || return 0
    host="${seg#*@}"
  fi
  rest="$(printf '%s' "$rest" | sed -E -e 's#/+$##' -e 's#\.git$##')"
  printf '%s%s' "$(printf '%s' "$host" | tr 'A-Z' 'a-z')" "$rest"
}

# True when $1 is a clone whose `origin` is the pinned vault. EVERY URL the
# remote carries must match: `git push` sends to all of a remote's push URLs,
# and `get-url --push` without `--all` prints only the first, so a second push
# URL on the same remote was never compared against the pin (#187). The fetch
# URLs are checked too, because the rebase below takes commits from there
# before pushing them on. A remote that lists no URL at all is not the vault.
origin_is_pinned_vault() {
  local pin_id url seen
  [ -n "$VAULT_ORIGIN_PIN" ] || return 1
  pin_id="$(git_url_id "$VAULT_ORIGIN_PIN")"
  [ -n "$pin_id" ] || return 1
  seen=0
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    seen=$((seen + 1))
    [ "$(git_url_id "$url")" = "$pin_id" ] || return 1
  done <<EOF
$(git -C "$1" remote get-url --all origin 2>/dev/null || true)
$(git -C "$1" remote get-url --push --all origin 2>/dev/null || true)
EOF
  [ "$seen" -gt 0 ]
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
  # That keyword rule is the fallback that keeps this change from ever masking
  # less than before. (It has changed once since this paragraph was first
  # written: its value class is dash-bounded now, for the marker reason below.
  # The test pins its SHIPPED spelling, not identity with an older one.)
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
  # What keeps the marker intact for the range is the VALUE CLASS, not an
  # address: the scheme rule below carries none. sed applies each `-e` in order
  # to the pattern space AS IT STANDS, so a substitution here can destroy the
  # text a LATER rule's ADDRESS is matched against -- and the PEM range below
  # is addressed on the BEGIN marker. A value class that can cross a five-dash
  # run takes `token: Basic <PEM BEGIN marker>` whole, the range never opens,
  # and the body lines that follow behind a `cat -n` / `> ` / `grep -n` prefix
  # are written out VERBATIM (the prefixed catch-all further down now takes
  # those lines too, which is why the tests silence it when they measure this
  # rule alone). Measured at 54 of 54 (6 scheme spellings x 3 prefixes x 3
  # marker placements) with the plain class, and 0 of 54 with the dash-bounded
  # one. Two things that do NOT fix it: excluding a leading `-` from the value
  # class closes only that one spelling, since a value of `X<PEM BEGIN marker>`
  # starts at `X` and swallows the marker anyway; and moving this rule below
  # the PEM rules disables it outright, because the keyword rule below has
  # already replaced the scheme word with `***MASKED***` by the time it would
  # run. A class that cannot cross `-----` is what holds, and it costs nothing:
  # on such a line the rule still masks the credential up to the dashes.
  #
  # The negated marker address survives on exactly TWO rules: the UNBOUNDED
  # double- and single-quoted halves above, whose value must run to the closing
  # quote and so cannot be dash-bounded -- they skip marker lines instead, and
  # their bounded twins cover those lines. (An earlier version of this
  # paragraph said the address sat on this rule; the tests that count the
  # addressed rules say two, and they are right.)
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
  # The range ends at the END marker, or 100 lines after the BEGIN marker,
  # whichever comes first (2026-09-17; before that it also ended at the next
  # column-0 `~~~` run). The cap is the whole of the bound, and it is worth
  # saying what each half of the old bound did and why it went:
  #
  #   - The cap is a line count, not a fence. The renderer fences tool
  #     results, thinking and tool inputs, and writes assistant and user TEXT
  #     turns at top level; a marker planted in EITHER kind of turn now runs
  #     on through whatever follows -- the next fenced block included -- for
  #     up to 100 lines, substituting every 12+ character run on the way. That
  #     run class is NOT base64: it is every alphanumeric plus `+ / = \`, and
  #     `/` is a member, so a run does not stop at a path separator. It
  #     consumes ordinary twelve-letter words, whole hashes, and a whole
  #     absolute path as a SINGLE run (`/home/runner/work/repo/checkout`).
  #     What replaces them is `***MASKED***`, the same token a genuine
  #     redaction produces, so content destroyed this way reads as routine
  #     hygiene rather than as damage and prompts no one to look at it.
  #     Measured on a note of 30 synthetic `git log` lines and 3 repeated
  #     absolute paths: clean, 0 tokens masked and 30/30 SHAs and 3/3 paths
  #     kept; with ONE 31-byte marker planted, 91 masked and 0/30 and 0/3
  #     kept. That is the cost, taken deliberately -- this range is what masks
  #     a prefixed key body at all -- and the cap is what bounds it: a planted
  #     marker can spoil at most the 100 lines after it, not the rest of the
  #     note. It cannot cost structure, because a substitution never deletes a
  #     line. Tests pin both the reach and the cap.
  #   - The `~~~` terminator is gone because it was content-controlled. Content
  #     is fenced but emitted VERBATIM, so a column-0 tilde run in a tool
  #     result's OWN body closed the range early, and the address was `^~{3,}`,
  #     unanchored at its right end, so even a `~~~ label` the renderer scores
  #     as closing nothing closed it. Plant one between a key's own BEGIN line
  #     and its body and the range closed before the body started: 6 of 6 body
  #     lines leaked behind a `cat -n` prefix -- the construction an attacker
  #     picks, and a Critical review finding on the branch that shipped it.
  #     Removing it fails closed: a key's body is masked whatever the content
  #     around it says, and the prefixed catch-all below takes prefixed body
  #     lines outside any range besides. What was traded for that is the
  #     availability failure the terminator had bounded, and the cap bounds it
  #     instead -- at 100 lines rather than at a line the attacker chooses.
  #   - Why 100: an RSA-4096 key body is about 50 lines and an ed25519 key
  #     under 10, prefix or not, so a real key sits inside the cap with room.
  #     Armor that runs longer (a PGP MESSAGE carrying a file) is base64-only
  #     line by line, and the two whole-line catch-alls below take those lines
  #     with no range at all, so the cap costs it nothing THERE. It does cost
  #     one shape, and a test measures it rather than rounding it away: a
  #     single body longer than the cap behind a prefix the catch-alls do not
  #     admit (a diff `-`, an RSA-8192 body of about 107 lines) keeps its tail.
  #   - How the cap counts, and why it is not a sed range. The first spelling
  #     was nested, `/BEGIN/,+100{ /BEGIN/,/END/ {...} }`, and sed does not
  #     re-check a range's first address while the range is open: a BEGIN
  #     that fell inside a window already open -- the second of two keys in
  #     one `git diff`, or a real key after a bare marker the model quoted --
  #     did not restart the count, the window closed in the middle of that
  #     body, and its remaining `-`-prefixed lines were written out in the
  #     clear (change-scan F1 / F5 on this change, 2026-09-17). So the window
  #     is a COUNTER in the hold space instead: a BEGIN line sets it to `o`,
  #     unconditionally; while it reads `o` plus at most 100 `x`, the line is
  #     masked and one `x` is appended; an END line empties it. Every BEGIN
  #     restarts the 100 lines, and END still closes early, so the cap stays
  #     a ceiling on the reach and not a floor. The `x` command swaps pattern
  #     and hold space, which is why the rule below reads as a dance of
  #     swaps: the counter has to be in the pattern space to be tested, and
  #     the line has to be back there to be masked. Only POSIX sed is used --
  #     hold space, `{}` blocks and interval expressions -- and the CI runner
  #     (GNU) and the operator's shell (BSD) both run the tests, including a
  #     mutation that makes the reset conditional on a closed counter and
  #     watches the planted shape leak exactly the ten lines the scan named.
  #
  # Read the two copies separately here, because this rule replaces something
  # different in each. `archive-session.sh` gains it outright: no input it
  # masked before is masked less. `capture-command.sh` had a whole-line
  # BLANKING range over the same markers, and this trades in both directions
  # at once. It masks LESS inside a block: base64 runs shorter than 12
  # characters -- a final body line of 4 or 8, where roughly one key size in
  # eight lands, at most 6 bytes of the trailing DER field -- plus non-base64
  # header text such as `Proc-Type:` (the whole-line short-run rule below
  # takes the final line since 2026-09-17, so that residue is now runs UNDER
  # 12 that share a line with other text). It also masks MORE,
  # in two ways that are not small: it gains the whole-line base64 catch-all
  # it never had, and it removes an UNBOUNDED failure. The old range had no
  # terminator but the END marker, so under POSIX sed an unterminated marker
  # anywhere in a multi-line command blanked every REMAINING line of the
  # logged command -- a `grep` for the marker text destroyed all 501 lines of
  # a command carrying no key material at all. A run substitution cannot do
  # that, and the line cap gives the range a second way to close. That failure
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
  #
  # Two rules were added on 2026-09-17 for the two residues measured behind a
  # PREFIX (a `cat -n` number and TAB, a `> ` quote, a `grep -n` file:12:):
  #   * in range, a line that is NOTHING but an optional prefix and a run of 1-11
  #     characters is masked whole. That is a key body's short final line
  #     (`Zg==`), which the 12+ rule leaves as residue. The rule is deliberately
  #     WHOLE-LINE: a run of 1-11 characters embedded in prose stays, because the
  #     range also reaches prose when a marker is planted in an unfenced turn,
  #     and masking the last word of every reached line is the availability
  #     failure this file spent its history avoiding.
  #   * outside any range, a line that is only a prefix and a 32+ run has the
  #     run masked -- the prefixed twin of the bare catch-all below it. This is
  #     what closes the tilde construction above: a `~~~` planted between BEGIN
  #     and the body closes the range, and the body lines then fall to this rule
  #     instead of surviving behind their prefix. Its cost is the prefixed
  #     64-hex line (a `cat -n` over a shasum listing), masked like the bare one.
  #     The action is ANCHORED to the captured prefix, not `s/<run>/.../`:
  #     `/` is in the run class, so a `grep -n` path that is itself a 32+
  #     run of the class (`/home/runner/work/vaultkeys/vaultkeys/id:12:...`)
  #     would be the leftmost match, and the body after `:12:` would be
  #     written out in the clear while the line reads as masked (change-scan
  #     finding on this change, 2026-09-17; pinned with the anchoring taken out).
  #
  # Shapes added on 2026-09-24, each a residue a scan named against this
  # function (A-47 = the 2026-09-18 change-scan F3, and the 2026-09-19
  # whole-repo scan's F6), and two that were tried and taken out again:
  #   * NOT here: the CHECK-THEN-APPEND value (`grep -q "token: " f || echo
  #     "token: V" >> f`, the 2026-09-18 change scan's F2) and YAML's doubled
  #     apostrophe (`'pre''fix'`, #186). Every rule tried for either one ran
  #     BEFORE the keyword fallback, and every one of them reached a credential
  #     the old rules masked, because a rule that runs before the fallback can
  #     move where the fallback's value ends or erase a keyword label the
  #     fallback would have read: a quote-bounded keyword pass (unanchored it
  #     took the `key` inside `--key` and ate the next `token:`; anchored on a
  #     quote it still ate `key:` after `"secret `), `''` in the single-quoted
  #     class (a stray `'` carried a value into the next one), and a
  #     continuation after a masked value (its escape alternative deleted an
  #     escaped space). Owner decision on this change took all of them out;
  #     they are tracked for a change of their own (#232, #186).
  #   * `PGP PRIVATE KEY BLOCK` and the RFC 4716 armor
  #     (`---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----`, four dashes and spaces)
  #     never opened the range. The first is broken by the keyword rules before
  #     the range's address sees it -- `KEY BLOCK` reads as keyword, separator,
  #     value -- and the second is not five-dash armor at all. Widening the
  #     shared marker regex is NOT the fix: that regex is also the line-skip
  #     address on the unbounded quoted halves, and widening it makes them skip
  #     a one-line JSON value that carries the PGP armor, which they mask whole
  #     today. So these two armors get their own pair of rules instead: the
  #     FIRST rule of all opens the window on the untouched line, before any
  #     keyword rule can reach the marker, and a rule right after the in-range
  #     body rule closes it on the END line, in the spelling the keyword rules
  #     leave behind as well as the original. The shared regex, and so the
  #     address, are unchanged.
  #   * A diff `-` joins the prefixes the prefixed catch-all admits, so a
  #     `-`-prefixed 32+ body line is masked outside any range too. That is the
  #     prefix the scan named, and it is also what the line cap used to cost: a
  #     single body longer than 100 lines behind a `-` kept its tail.
  #   * Credentials in an ARGUMENT position, which no keyword precedes: a
  #     `-u` / `--user` value that joins a name and a secret with a colon, a
  #     MySQL-family client's `-p` with the password attached, and
  #     `redis-cli`'s `-a` / `--pass`. Each is anchored on its flag (the `-p`
  #     and `-a` rules on the client's name too, because `-p` alone is
  #     `mkdir -p`, `cp -pR` and `ssh -p2222`), and each value class is the
  #     dash-bounded one, so none of them can take a marker. The words allowed
  #     between the client's name and its flag are capped at twelve: an
  #     unbounded word run let every start on a line of repeated client names
  #     scan to the end before failing, quadratic under glibc's regex (the
  #     change scan's F1; BSD sed stays linear either way). `passwd` and
  #     `passphrase` (`--passphrase V`, `--passphrase=V`; a QUOTED phrase is not
  #     handled here -- its rules were taken out of this change with #186's)
  #     get a rule of their OWN, right after the keyword fallback, and are NOT in
  #     the shared alternation: there, a leftmost match starting on them took
  #     the real keyword after them as their value -- `--passphrase --key S`,
  #     or a prompt's closing quote before `PASSWORD="a b c"` -- and the secret
  #     after it went to the log (the second change scan on this change, F2 /
  #     F3). Running after every older keyword rule, they only ever meet a
  #     value that is already masked. `auth` and `credential` do NOT join at
  #     all: they are subcommands
  #     (`gh auth status`, `git credential fill`) and the keyword rule would
  #     mask the word after them in every such command. Logs written before
  #     this change can still hold argument-position credentials in the clear.
  #     Other argument spellings (`openssl -passin pass:V`, `sshpass -p V`) are
  #     still unnamed.
  # What the series costs, measured 2026-09-24 by passing every tracked text file
  # here (101 files / 40,479 lines) and the live ops-log clone (70 files /
  # 27,487 lines), one whole-file stream each, through the old and new mask():
  # no line anywhere is masked LESS. What is masked MORE, beyond the shapes
  # above: the word after `passwd` / `passphrase` in prose (`a passwd entry`,
  # `a strong passphrase you choose`) -- the same cost `password` has always
  # had -- and, where a comment QUOTES one of the two new armors, the window's
  # usual reach: 12+ runs and short whole lines for up to 100 lines after it,
  # the planted-marker cost the range already carries for the shared marker.
  # Every rule these additions brought carries the address /```|~~~/! -- it
  # does not run on a line that holds a fence run at all. mask() runs over the
  # assembled note AFTER the fence balance of each turn has been decided, and a
  # backtick fence's info string cannot hold a backtick, so "```mysql -p`x`" is
  # not a fence until a rule deletes the backticks and leaves
  # "```mysql -p***MASKED***", which is (the second change scan's F1). Keeping
  # the two characters out of the value classes was tried first and was not
  # enough -- an escape alternative still took "\`" (the third scan's F1) --
  # and it cost the other direction: a value holding either character was
  # masked only up to it (its F2). On any OTHER line a substitution cannot make
  # a fence run, because it always inserts `***MASKED***`, never nothing, so
  # it cannot join two backtick runs into one. The cost is the line guard's
  # usual one: a credential on a line that also holds a fence run is left to
  # the older rules, as it was before this change. The older keyword rules
  # share the deletion root and are left as they were here; it is tracked on
  # its own.
  # An over-reach the measurement caught was fixed rather than accepted: the
  # `-u` rule read `date -u '+%Y-%m-%dT%H:%M'` as a name and a secret, so its
  # name class excludes `%` and `+`.
  # REPEATED -p / -a flags (#234, 2026-09-25): of `mysql -p<A> -p<B>` only the
  # last value was masked -- the greedy word run before the flag swallowed the
  # earlier ones. The two rules now run in a loop (`:m` ... `tm`, `:r` ...
  # `tr`) until they match nothing, and each pass is global, so a pass masks
  # the last reachable flag in every client's window at once and the passes
  # are bounded by the flags in one twelve-word window, not by the line. (A
  # pass WITHOUT `g` restarts at the start of the line once per occurrence:
  # measured on a first spelling, 4,000 `redis-cli -a x` on one line took
  # 195 s under BSD sed; a test pins the ratio.) A value that begins with the
  # twelve characters `***MASKED***` is not a value to these two rules -- the
  # exclusion is spelled as the complement of that one prefix (a leading part
  # of it, then any other character), so `***abc` and `*abc` still are -- and
  # that is what stops a pass from matching its own output: a masked
  # occurrence is backtracked past and the next pass reaches the one before
  # it. The cost: a secret that begins with `***MASKED***`, or is a leading
  # part of it such as `*` alone, is not masked by these two rules (pinned).
  # The word run and the value class are otherwise unchanged -- quoted values
  # with spaces and flag-shaped words inside quoted arguments are left for
  # #232, where a shell-aware reading of both was measured to need escapes, a
  # fallback for unclosed quotes and bounded quoted pieces.
  sed -E \
    -e '/-----BEGIN PGP PRIVATE KEY BLOCK-----|---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----/{x;s/.*/o/;x;}' \
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
    -e "/\`\`\`|~~~/!s/((passwd|passphrase)[=:[:space:]]+)([^[:space:]\"'-]|-{1,4}[^[:space:]\"'-])+/\1***MASKED***/Ig" \
    -e '/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----/{x;s/.*/o/;x;}' \
    -e 'x;/^ox{0,100}$/{s/$/x/;x;s/[A-Za-z0-9+\/=]{12,}/***MASKED***/g;s/^([[:space:]]*([0-9]+[[:space:]]*[|:>]?[[:space:]]*|[>|]+[[:space:]]*|[^[:space:]:]+:[0-9]+:[[:space:]]*)?)[A-Za-z0-9+\/=]{1,11}[[:space:]]*$/\1***MASKED***/;/-----END ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----/{x;s/.*//;x;};x;};x' \
    -e '/-----END PGP PRIVATE KEY (BLOCK|\*\*\*MASKED\*\*\*)-----|---- END SSH2 ENCRYPTED PRIVATE KEY ----/{x;s/.*//;x;}' \
    -e 's/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----/***MASKED***/g' \
    -e 's/-----END ([A-Z0-9 ]*PRIVATE KEY|PGP MESSAGE)-----/***MASKED***/g' \
    -e 's/AKIA[0-9A-Z]{16}/***MASKED***/g' \
    -e 's/sk-[A-Za-z0-9_-]{20,}/***MASKED***/g' \
    -e 's/AIza[0-9A-Za-z_-]{35}/***MASKED***/g' \
    -e 's/xox[baprs]-[A-Za-z0-9-]{10,}/***MASKED***/g' \
    -e "/\`\`\`|~~~/!s/((^|[[:space:]])(-u|--user)(=|[[:space:]]+)[\"']?[^[:space:]:\"'/%+]+:)([^[:space:]\"'-]|-{1,4}[^[:space:]\"'-])+/\1***MASKED***/g" \
    -e ':m' \
    -e "/\`\`\`|~~~/!s/((mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)([[:space:]]+[^[:space:]|;&]+){0,12}[[:space:]]+-p[\"']?)([^[:space:]\"'*-]|\\*[^[:space:]\"'*-]|\\*-{1,4}[^[:space:]\"'-]|\\*\\*[^[:space:]\"'*-]|\\*\\*-{1,4}[^[:space:]\"'-]|\\*\\*\\*[^[:space:]\"'M-]|\\*\\*\\*-{1,4}[^[:space:]\"'-]|\\*\\*\\*M[^[:space:]\"'A-]|\\*\\*\\*M-{1,4}[^[:space:]\"'-]|\\*\\*\\*MA[^[:space:]\"'S-]|\\*\\*\\*MA-{1,4}[^[:space:]\"'-]|\\*\\*\\*MAS[^[:space:]\"'K-]|\\*\\*\\*MAS-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASK[^[:space:]\"'E-]|\\*\\*\\*MASK-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASKE[^[:space:]\"'D-]|\\*\\*\\*MASKE-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASKED[^[:space:]\"'*-]|\\*\\*\\*MASKED-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASKED\\*[^[:space:]\"'*-]|\\*\\*\\*MASKED\\*-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASKED\\*\\*[^[:space:]\"'*-]|\\*\\*\\*MASKED\\*\\*-{1,4}[^[:space:]\"'-]|-{1,4}[^[:space:]\"'-])([^[:space:]\"'-]|-{1,4}[^[:space:]\"'-])*/\1***MASKED***/g" \
    -e 'tm' \
    -e ':r' \
    -e "/\`\`\`|~~~/!s/(redis-cli([[:space:]]+[^[:space:]|;&]+){0,12}[[:space:]]+(-a|--pass)[[:space:]]+[\"']?)([^[:space:]\"'*-]|\\*[^[:space:]\"'*-]|\\*-{1,4}[^[:space:]\"'-]|\\*\\*[^[:space:]\"'*-]|\\*\\*-{1,4}[^[:space:]\"'-]|\\*\\*\\*[^[:space:]\"'M-]|\\*\\*\\*-{1,4}[^[:space:]\"'-]|\\*\\*\\*M[^[:space:]\"'A-]|\\*\\*\\*M-{1,4}[^[:space:]\"'-]|\\*\\*\\*MA[^[:space:]\"'S-]|\\*\\*\\*MA-{1,4}[^[:space:]\"'-]|\\*\\*\\*MAS[^[:space:]\"'K-]|\\*\\*\\*MAS-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASK[^[:space:]\"'E-]|\\*\\*\\*MASK-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASKE[^[:space:]\"'D-]|\\*\\*\\*MASKE-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASKED[^[:space:]\"'*-]|\\*\\*\\*MASKED-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASKED\\*[^[:space:]\"'*-]|\\*\\*\\*MASKED\\*-{1,4}[^[:space:]\"'-]|\\*\\*\\*MASKED\\*\\*[^[:space:]\"'*-]|\\*\\*\\*MASKED\\*\\*-{1,4}[^[:space:]\"'-]|-{1,4}[^[:space:]\"'-])([^[:space:]\"'-]|-{1,4}[^[:space:]\"'-])*/\1***MASKED***/g" \
    -e 'tr' \
    -e '/^[[:space:]]*[A-Za-z0-9+\/=]{32,}[[:space:]]*$/s/.*/***MASKED***/' \
    -e '/^[[:space:]]*([0-9]+[[:space:]]*[|:>]?[[:space:]]*|[>|]+[[:space:]]*|[^[:space:]:]+:[0-9]+:[[:space:]]*|-)[A-Za-z0-9+\/=]{32,}[[:space:]]*$/s/^([[:space:]]*([0-9]+[[:space:]]*[|:>]?[[:space:]]*|[>|]+[[:space:]]*|[^[:space:]:]+:[0-9]+:[[:space:]]*|-))[A-Za-z0-9+\/=]{32,}([[:space:]]*)$/\1***MASKED***\3/'
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
  # Remove `ESC[...m` / `ESC[...K` -- the same sequences strip_ansi removes, and
  # the same non-rescanning result as gsub("\u001b\\[[0-9;]*[mK]"; ""): a
  # sequence cannot contain ESC, so every match starts a fragment of
  # split("\u001b") and each fragment is decided alone. Do NOT use gsub here.
  # It rebuilds the string once per match, O(matches x length), and splitting
  # on LF first bounds that only by the LONGEST line: one SGR-dense line in one
  # tool result measured 16 / 64 / 128 KB -> 0.19 / 2.87 / 11.0 s, on the fenced
  # path and the text-turn path alike (2026-09-24, jq 1.8.2). No hook sets a
  # timeout, so that is a renderer killed before its single write -- the record
  # of its own arrival erased. \A is the start of the fragment; a fragment can
  # hold LF, and jq ^ measured the same (it does not match after an LF), so the
  # anchor states the intent rather than guarding a difference.
  def strip_sgr:
    split("\u001b")
    | .[0] + ([ .[1:][]
                | if test("\\A\\[[0-9;]*[mK]")
                  then .[(match("\\A\\[[0-9;]*[mK]").length):]
                  else "\u001b" + . end ] | join(""));
  # Whether a closing-fence trailer ends the fence for SOME reader: [[:space:]]
  # plus U+FEFF (trim drops it, jq does not) and U+180E (White_Space until
  # Unicode 6.3, so an older reader drops it) -- a superset of every reader rule
  # measured in defang below. Both the fence sizer and the parity machine in
  # defang read THIS definition, so they cannot disagree about which runs close.
  def may_end_fence: test("^[[:space:]\u180e\ufeff]*$");
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
  # three, and followed by nothing that some reader does not trim (may_end_fence,
  # above -- the sizer once tested [[:space:]] alone while defang had widened its
  # own rule, so a U+FEFF trailer closed the fence for a trim() reader and scored
  # 0 here). A run mid-line, or one trailed
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
  # removal the fenced body gets (text turns get the same removal in defang,
  # below): the assembled note no longer passes through
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
    # strip_sgr, not gsub: see its definition at the top of this program.
    (($text // "") | strip_sgr) as $t
    | ([ $t
         | split("\n")[] | split("\r")[]
         | select(startswith("~") or startswith(" "))
         | capture("^ {0,3}(?<run>~*)(?<rest>.*)$")
         | (.rest | may_end_fence) as $closes
         | if $closes then (.run | length) else 0 end ] | max // 0) as $longest
    | (if $longest >= 6 then $longest + 1 else 6 end) as $n
    | ("~" * $n) as $f
    | $f + $lang + "\n" + $t + "\n" + $f;
  # Strip harness-injected wrapper tags from USER text only (command echoes,
  # system reminders, hook output). Actual user words stay verbatim.
  # Text turns are written at TOP LEVEL, unfenced, so a line the model echoed can
  # become real note structure -- a forged User heading with a plausible timestamp,
  # read back over MCP as what the operator said. The first rule escaped only the
  # ATX heading run: over this conversation it is 3,982 lines of 58,507 (6.8%),
  # while also escaping tilde and backtick runs would add 7,336 more, nearly all
  # backticks in code the operator wrote. Tilde-fence lines occurred 0 times in
  # two independent samples. Three more shapes forge a turn and are escaped now,
  # each only in the narrow form that forges (a setext underline under a non-blank
  # line, a line-start HTML opener, a fence run the turn leaves open) -- the
  # counts and the reasons are inside defang. Blockquotes stay untouched: they
  # cannot forge the heading-plus-timestamp shape a turn is written as.
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
    # ATX is not the only shape that forges a turn; three more reach top-level
    # prose, and an ATX-only rule let all three through (F5 / F3 of the
    # 2026-09-09 scan):
    #   - a setext underline (=== / ---) makes a HEADING of the line above it;
    #   - a raw HTML block opener, which a reading view renders, so <h2> forges
    #     exactly the shape ATX does -- and so does any other tag, see below;
    #   - a fence run at column 0 that the turn never closes. That flips fence
    #     parity for the REST of the note: the opening fence of the next tool
    #     result closes the one the turn opened, and the result body lands at
    #     top level as prose. Nothing downstream measures a text turn, so nothing catches it.
    # Each is escaped only in the shape that actually forges, because the broad
    # form costs too much. Measured over two transcripts, 729 text turns /
    # 8,024 lines: ATX 694 lines (already escaped before this change); a setext
    # underline preceded by a NON-BLANK line, 1 -- every setext-shaped line
    # would be 16 and would also escape thematic breaks, which forge nothing;
    # "non-blank" is the word CommonMark uses: a line of spaces and tabs only. It is NOT
    # the jq [[:space:]] class, which is Unicode White_Space here (see the fence rules
    # below), so a predecessor holding only U+3000, U+00A0 or a form feed read as
    # blank to this rule and as a paragraph to every reader, and `---` under it
    # made that paragraph a heading unescaped (change-scan finding on this change,
    # 2026-09-18, 3/3 verifiers). The test is spelled [^ \t] for that reason; the
    # shape occurs 0 times in the 5,387-turn corpus above.
    # the narrowed HTML opener, 0 -- that 0 was the count of the NINE-NAME rule
    # this file shipped first, and it is why that rule looked free; the rule is
    # no longer name-based and its count is no longer 0 (see RAW HTML below);
    # a leading fence run, 861 -- but a run in a
    # turn that LEAVES A FENCE OPEN, 0 (also 0 over 2,885 turns of a third
    # transcript). Escaping all 861 is the "7,336 more lines" this renderer rejected
    # above; escaping only the unbalanced ones costs nothing and fires on
    # exactly the attack. Old-vs-new over those 729 turns differs by 1 line.
    # The fence state is computed over the whole turn BEFORE any line is
    # escaped, so the escaping cannot change the decision that drives it.
    # The state has NO CONTAINER MODEL, and one container matters: a fence opened
    # INSIDE a list item (`- x` / `  ```` / ```` ``` ````) is closed by CommonMark
    # when the item ends -- and the item ends at the first non-blank line indented
    # below its content column, a fence never being a lazy continuation -- so the
    # column-0 run is not a closer for the item but a NEW opener at document level.
    # Line for line this turn is balanced to a state machine that cannot see the
    # item, and open for every reader; the ``` line of the next tool result closes it
    # and that body lands at top level (change-scan finding on this change,
    # 2026-09-18, 3/3 verifiers). Rather than model list items -- content columns,
    # nesting, lazy continuation, the very parsing this renderer refuses to do --
    # an opener carrying ANY leading indent (1-3 spaces; 4 is an indented code
    # block and matches nothing here) is scored as the same absorbing marker an
    # ambiguous close gets, so every run in the turn is escaped. Fail toward
    # escaping where the container is unknown: the same direction as the marker.
    # Cost, measured over the three largest local transcripts (5,387 text turns,
    # 81,422 lines): a 1-3 space indented fence run occurs in 3 turns, 6 lines;
    # a column-0 run in 1,608 turns, none of which this widens.
    # The same state machine has to agree with the reader this repository ITSELF
    # serves the note through, and that reader (src/markdownSections.ts with
    # src/codeFence.ts) splits on "\n" alone and matches fence runs with
    # patterns whose `.` and `$` stop at a JavaScript line terminator. A run
    # this machine sees because the LF segment was split on a bare CR, a run
    # whose LF segment ends in CR (the CRLF spelling pasted Windows text
    # carries), or an opener whose info string holds U+2028 / U+2029, is a fence
    # to CommonMark and to this machine and PLAIN TEXT to that reader: the turn
    # is balanced here and left unescaped, the reader is left inside an open
    # fence, and the own run of the next tool result -- or a ``` line planted in it
    # -- closes it there, so a forged `## 👤 User` line in that result becomes
    # a heading in the outline, the section list and get_context while the
    # reading view shows fenced code (change-scan findings on this change,
    # 2026-09-19, four of one family, each 3/3 verifiers). So a run on such a
    # line takes the absorbing marker, whatever the state was: every run in the
    # turn is escaped, which is balanced for every reader. The line model of that reader
    # is a separate change; this rule holds whether or not it lands.
    # Cost: in the 5,417 text turns of the three largest local transcripts, 0
    # contain a CR at all, and 0 fence runs carry U+2028 / U+2029.
    # The reconstruction at the bottom is a foreach with a NUMBER for state,
    # collected into one array, and that is deliberate: the first form was a
    # reduce whose state object held the output array and appended to it, and
    # jq copies an array on append while the state still references it, so the
    # pass was quadratic in the line count of the turn -- on this box (jq 1.8.2) a
    # turn of 5,000 / 10,000 / 20,000 / 40,000 newline-only lines rendered in
    # 0.16 / 0.43 / 1.24 / 4.08 s, tripling per doubling, against 0.11 / 0.23 /
    # 0.45 / 0.95 s for this form (2.08 s at 80,000 and 4.42 s at 160,000). A
    # 100,000-line text turn is one steered reply away, and the hook re-renders
    # every turn of the session on every Stop, so the quadratic form was the
    # availability failure the sizer above was rewritten to avoid, re-opened on
    # the text-turn path (change-scan finding, 2026-09-19, 3/3 verifiers; an
    # earlier panel had rejected the same candidate 0/3). The test pins the
    # growth at two sizes, as costGrowth does for the sizer.
    # split("\r") on an empty string returns [] in jq, not [""], so a blank line
    # would contribute zero entries; normalise it back to [""] or the "line
    # above" test silently skips blanks and reads the paragraph before them.
    # That defect was caught by the thematic-break control, not by review.
    # The SAME flattening has a second artifact, in the other direction: an LF
    # segment that ENDS in CR (a CRLF ending) splits to a trailing "", so the
    # "line above" test read that empty string instead of the real predecessor
    # and the setext escape was skipped for every CRLF payload -- the spelling
    # pasted web content and Windows-authored notes carry. Drop that one tail
    # entry per segment and carry it in $tails, restoring it during
    # reconstruction, so $L holds the lines a reader sees and the round trip is
    # still byte-for-byte. Only the LAST entry is an artifact: an inner ""
    # between two CRs is a real blank line, and a segment of exactly [""] is the
    # blank line normalised above. What is dropped is always "", which matches
    # no guard pattern and is null to fence_m, so the raw-HTML and
    # unbalanced-fence guards decide on exactly what they decided on before --
    # only the setext predecessor moves.
    # Measured over 28,150 LF/CRLF/CR permutations against a reader oracle (a
    # run underlines the line above iff that line is non-blank): the old
    # flattening under-escaped 4,224 and over-escaped 0; this one matches on all
    # 28,150. With the setext guard disabled the two are byte-identical, so that
    # guard is the whole delta. $L is also half as long on CRLF-dense text.
    # RAW HTML -- what the opener rule covers, what it does NOT, and what it cost.
    #
    # COVERS. The rule tests the START of a line for the CommonMark start
    # condition rather than for a list of tag names: after at most 3 spaces, a
    # "<" followed by "!" or "?", or by an optional "/" and a letter. That is
    # every HTML block type, 1 through 7, when the block opens at the line start.
    # Type 7 is the one that matters and the one NO tag-name list can ever
    # reach, because a type-7 opener is a complete tag and nothing else, with
    # any name at all. Corpus, as of 2026-09-14 11:34 JST -- live transcripts,
    # so these counts move by the hour: 29 session transcripts on this machine,
    # 152,451 non-blank text-turn lines, the unfenced channel. The nine-name
    # rule that shipped here first fired on 0 lines. This rule fires on 1,970,
    # in 27 of the 29. Classified by the test file oracle opensRawHtmlBlock,
    # which tests each start condition, type 7 included, and cross-checked line
    # by line against markdown-it-py 4.2.0 (1,970 of 1,970 agree): 1,428 (72.5%)
    # open a raw HTML block on their own -- 1,343 type 7 (<teammate-message ...>
    # 1,166; <task-notification> and its close, 164), 83 type 6 (summary 82,
    # ul 1 -- neither was in the nine), 2 type 2 (<!--). The other 542 (27.5%)
    # are a tag with content after it on the same line (<task-id>...</task-id>,
    # <output-file>..., <status>completed</status>): they open no block but
    # render as inline raw HTML, and the rule escapes them too. Those are
    # counts of each line ON ITS OWN. In a note the line has neighbours, and a
    # type-7 opener cannot interrupt a paragraph, so the same corpus parsed
    # turn by turn (markdown-it-py 4.2.0, 2026-09-14 12:01 JST, 1,985 hits)
    # opens a block on 380 of the hits, has 719 sitting inside a block an
    # earlier line opened, and leaves 871 as inline raw HTML in a paragraph.
    # A lone-line count is not a note count; the rule escapes all of them
    # either way. Ordinary harness traffic was already putting raw HTML into
    # archived notes and nothing here caught any of it. A type-7 count is only a type-7 count if
    # the classifier tests the type-7 condition; one that labels type 7 by
    # elimination after types 1 to 6 counts "not types 1 to 6" instead.
    # It is a strict superset, not a trade: over 20,287 generated line shapes
    # (name x case x leading slash x indent x container prefix x suffix) the
    # nine-name rule escaped 1,344 and this one 7,824, with "the old rule
    # escaped AND this one did not" = 0. A control narrowed to drop uppercase
    # loses 5,184 of them, so that census can in fact detect a narrowing.
    #
    # DOES NOT COVER -- residual, stated, not fixed. Any raw tag the line-start
    # test does not see. The plain form is a block-forging tag LATER on the same
    # line, e.g.  text <span style=...>...</span>  : not escaped, here or
    # before, it renders as inline raw HTML, and a browser still turns that into
    # the block the tag names (a raw <h2> inside <p> renders as a heading). The
    # same residual in forms that example does not show: a tag preceded by a
    # non-indentation space (NBSP, U+3000, ZWSP, a BOM) at the line start; a
    # tag after 4 or more spaces, or a tab, on a line that continues a paragraph
    # -- inline raw HTML, not indented code, because indented code cannot
    # interrupt a paragraph (10 such lines in the corpus above: 5 inside a
    # fenced block, where they are code, and 5 continuing a paragraph after a
    # non-blank line); and, under a list item, a tag on the FOLLOWING line
    # indented to the item content column plus at most 3 (4 to 5 spaces under
    # "- ", 4 to 7 under "10. "), which opens a real block at that column. All
    # of these were live before this change too.
    # Escaping anywhere on a line needs a pass over the whole line, and the
    # obvious one is unaffordable: jq gsub costs O(matches x length) on one
    # string, so one line of N openers costs, for N of 4,000 / 8,000 / 16,000 /
    # 32,000, about 0.5 / 1.8 / 7.2 / 28.3 s against 0.007 to 0.012 s for the
    # rule above. That is not cosmetic: this script runs under set -e, so a
    # jq killed by a signal aborts the hook with the jq status and a
    # Terminated line on stderr; nothing is written, the previous note stands,
    # and nothing reaches the NOTE. If a harness timeout kills the shell
    # instead, set -e never runs and jq is orphaned -- same outcome, different
    # mechanism; which one the harness does was not determined. (The exit-0
    # path just below the jq call is for a jq that SUCCEEDS with an empty
    # body.)
    # Do NOT read that as "no anywhere-on-the-line pass is affordable". A
    # split/join reformulation was built here and measured LIKE FOR LIKE, as an
    # extra step inside this same defang: 0.268 s at 32,000 openers on one line
    # and 1.375 s at 128,000, and 1.00x to 1.25x of this rule on ordinary shapes
    # (N lines with one opener, and prose with no tag at all). On cost it is
    # affordable. It is not shipped because this change was scoped to the line
    # start, and because only its COST was measured: backslash parity before a
    # "<", the mid-line backslash it would insert into text that mask() has to
    # match afterwards, and escape-set monotonicity were NOT checked, and those
    # are where the two earlier attempts at this actually died.
    #
    # ALSO RESIDUAL: a block opens at a container content column too --
    # "- <span>", "> <span>", "1. <span>" -- so the line start is not the only
    # place a block can open. Do not restate this rule as covering every opener.
    # And a block such an opener opens runs to the next blank line as raw HTML,
    # so the backslashes this rule puts on the lines inside it are literal text
    # there: one uncovered opener exposes a run, not a line (the nine-name rule
    # had the same property).
    # Frequency is no argument here, only structure: 0 such lines in the corpus
    # above, and 43 lines carrying an h1-h6 tag away from the line start. Read
    # one by one, all 43 are text that mentions or counts a tag -- notes about
    # this rule, tallies over a generated file, a line of Python -- not a forged
    # turn; the shape is live in every one of them all the same.
    #
    # mask() INTERACTION: ARGUED, NOT MEASURED. mask() is untouched, and this
    # rule inserts one backslash at column 0 to 3 immediately before a "<" --
    # the position the nine-name rule already used, so no new insertion
    # position exists. None of the mask rules anchors on "<"; the PEM rules
    # match their -----BEGIN / -----END markers wherever they sit on a line;
    # and the two line-anchored patterns, the ~~~ terminator of the PEM range
    # and the whole-line base64 catch-all, cannot match a line whose first
    # non-space byte is "<" or a backslash. A differential with
    # credential-shaped fixtures was attempted by three reviewers in this
    # series (at least five attempts) and the secret guards blocked every one,
    # so this is an argument from the insertion position and the rule text,
    # still open. Do not upgrade it to a measurement without running one.
    #
    # COST, along these axes and only these. Matches per line: one line of N
    # openers, N from 4,000 to 32,000 -- 0.007 s to 0.012 s, flat, and equal to
    # the nine-name rule. Backslash-run length before a non-matching "<": N from
    # 16,000 to 128,000 -- 0.008 s to 0.019 s, flat, equal. Line count: N lines
    # of one opener each, N from 4,000 to 32,000, in two shapes (2026-09-14, min
    # of 5 to 9 interleaved runs). On a line BOTH rules escape (<p>x) this one
    # is cheaper, 0.83x to 0.95x, because its test is cheaper than the nine-way
    # alternation; on prose with no tag likewise, 0.79x to 0.91x. On a line only
    # THIS rule escapes (<aside>x) it pays the sub the nine-name rule skipped:
    # roughly 1.0x to 1.25x -- tenths of a second at 32,000 lines. The ratio
    # reproduced across three measurers; the absolute delta did not, run to
    # run on a shared machine, so none is stated. Both arms grew about 2.1x to
    # 3.4x per doubling in that measurement; the upper end of that was the
    # quadratic reconstruction described below, since replaced, not per-line
    # cost -- the per-line rules themselves grow about 2.1x per doubling.
    # Output: one byte per escaped LINE, never per match,
    # so at most one byte per line of input; on four real transcripts of 3 MB
    # to 78 MB it added 20 to 392 bytes. Peak RSS on those four, both arms:
    # about 22 / 199 / 428 MB, and 1.2 to 1.3 GB on the largest, where one arm
    # scatters by about 100 MB run to run and the two arms overlap -- no
    # increase measured, and no decrease claimed.
    # Fidelity, not cost: these per-line rules run on EVERY line of a text
    # turn, inside a fence or not -- only the fence-run rule below reads
    # $unbalanced. So a tag line inside a balanced code block the model wrote in
    # prose (an HTML sample: <html>, <ul>, <li>) gets the backslash as well, and
    # a reader sees it literally there. The nine-name rule did this for its nine
    # names; this rule does it for every tag line -- 15 of the 1,970 hits above
    # sit inside a fence. A line-start autolink (<https://...>, <user@host>) is
    # escaped too and renders as literal text instead of a link: 0 such lines in
    # the corpus.
    # Those are the axes that WERE varied. Two earlier attempts at this line
    # each shipped a sentence claiming the search for a costly shape was
    # finished, and both sentences were false, the second one measured over a
    # corpus in which every line had exactly one match. So: no such sentence
    # here. If you add a pass, vary an axis this list does not name.
    def fence_m: if test("^ {0,3}(~{3,}|`{3,})") then capture("^(?<pad> {0,3})(?<run>~{3,}|`{3,})(?<info>.*)$") else null end;
    def esc_bs: sub("^(?<s> {0,3})"; "\(.s)\\");
    # WHICH runs close is reader-dependent, and closing TOGGLES parity, so the
    # question cannot be settled on the rule of any one reader. CommonMark ends a
    # fence on spaces and tabs after the closing run and nothing else, while the
    # readers Markdown tooling is written with simply trim the rest of the line --
    # and those are not even ordered against each other (measured 2026-09-13):
    # jq [[:space:]] HERE, like Python str.isspace, is Unicode White_Space and ends
    # a fence on NEL, which ECMA-262 trim() does not; trim(), which the test oracle
    # for this renderer uses, ends one on U+FEFF, which jq does not. They disagree
    # in BOTH directions.
    # Scoring such a run CLOSED leaves a turn the strict reader still has OPEN: the
    # opening run of the next tool result closes it and that untrusted body lands at
    # top level. But scoring it OPEN is not the fix either, because closing toggles
    # parity -- three runs whose middle one carries a form feed then end BALANCED
    # for the strict reader, nothing is escaped, and the LENIENT reader is the one
    # left open. Narrowing this rule is not monotone. The sizer above is -- counting
    # more runs only makes a fence LONGER -- which is why the same leniency is safe
    # there and settles nothing here.
    # So close only on what EVERY reader closes on, and when a run is one that only
    # SOME reader closes on, stop tracking parity instead of guessing: leave the
    # fence open under a marker no run can match (fence_m yields only ~ or `), so it
    # stays open to the end of the turn and every run in the turn is escaped. With
    # no such run all readers agree run for run, so this parity is theirs; with one,
    # the escaped turn carries no fence at all, which is balanced for all of them.
    # Either way this escapes a SUPERSET of what the single [[:space:]] rule escaped,
    # so no turn it contained can leak now.
    # Measured over 27 transcripts -- 14,219 text turns, 142,777 lines, 18,587 of
    # them a fence run: 0 carry such a trailer. This widens the escaping on the
    # attack shape and on nothing else.
    def ends_fence: test("^[ \t]*$");
    # may_end_fence is defined at the top of this program, shared with the fence
    # sizer: [[:space:]] plus U+FEFF and U+180E, a superset of every set above,
    # which is what makes no-ambiguous-run mean every reader agrees.
    # ANSI colour and line-clear sequences are removed here, per line and BEFORE
    # every escape below, for the same reason fence removes them: the assembled
    # note no longer passes through strip_ansi, and a text turn is the one body
    # path that did not go through fence. Left in, `ESC[0m## User` is not an ATX
    # heading to the rule below (the line does not START with `#`) but IS one to
    # a renderer that discards the sequence first -- an unescaped, forged turn.
    # Same sequences as fence and strip_ansi (strip_sgr); keep them in step.
    (split("\n")
     | map(strip_sgr | split("\r")
           | if length == 0 then [""] else . end
           | if length > 1 and .[-1] == "" then {l: (.[0:-1]), cr: "\r"} else {l: ., cr: ""} end)) as $g
    | ([$g[] | .l | length]) as $sizes
    | ([$g[] | .cr]) as $tails
    | ([$g[] | .l[]]) as $L
    | ([$g[] | ((.cr != "") or ((.l | length) > 1)) as $c | .l[] | $c]) as $crL
    | ((reduce range(0; $L|length) as $i ({o:null, n:0};
          ($L[$i] | fence_m) as $m
          | if $m == null then .
            elif $crL[$i] or ($m.info | test("[\u2028\u2029]")) then {o:"?", n:0}
            elif .o == null then
              (if ($m.run[0:1]) == "`" and ($m.info | test("`")) then .
               elif ($m.pad | length) > 0 then {o:"?", n:0}
               else {o:($m.run[0:1]), n:($m.run|length)} end)
            elif ($m.run[0:1]) == .o and (($m.run|length) >= .n) and ($m.info | may_end_fence) then
              (if ($m.info | ends_fence) then {o:null, n:0} else {o:"?", n:0} end)
            else . end)) | .o != null) as $unbalanced
    | [ range(0; $L|length) as $i
        | $L[$i]
        | sub("^(?<s> {0,3})(?<h>#{1,6}[ \t])"; "\(.s)\\\(.h)")
        | if ($i > 0) and ($L[$i-1] | test("[^ \t]")) and test("^ {0,3}(=+|-+)[[:space:]]*$") then esc_bs else . end
        | if test("^ {0,3}<(?:[!?]|/?[A-Za-z])") then esc_bs else . end
        | if $unbalanced and ((fence_m) != null) then esc_bs else . end ] as $E
    | [ foreach range(0; $sizes|length) as $k (0; . + $sizes[$k];
          . as $end | ($E[($end - $sizes[$k]) : $end] | join("\r")) + $tails[$k]) ]
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
                 "#### 🔧 Bash — " + ((.input.description // "") | strip_sgr | gsub("[[:space:]]+"; " ")) + "\n\n" + fence("bash"; (.input.command // ""))
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
