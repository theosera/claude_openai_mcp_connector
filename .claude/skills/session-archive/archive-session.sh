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
#   - The destination folder inside the vault comes from $SESSION_LOG_SUBDIR,
#     else the first non-comment line of the marker file, else `claude-sessions`.
#   - Secret patterns are masked with the SAME rules as ops-logging
#     capture-command.sh (keep the two mask() functions in sync).
#   - No vault clone found -> no-op. Never blocks the turn: always exits 0.
set -euo pipefail

# Escape hatch for sessions that must not be archived.
[ "${SESSION_ARCHIVE_DISABLE:-0}" = "1" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

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
  for candidate in "$HOME"/*/; do
    if [ -f "${candidate}.claude-session-vault" ] && [ -d "${candidate}.git" ]; then
      scan_hit="${candidate%/}"
      scan_count=$((scan_count + 1))
    fi
  done
  if [ "$scan_count" -eq 1 ]; then
    VAULT_REPO="$scan_hit"
  elif [ "$scan_count" -gt 1 ]; then
    # Say that archiving stopped, but never name the candidates: this script
    # ships in a public repo and those paths are the vault location. The count
    # is what the operator acts on, and silence here would look like a working
    # archive that quietly stopped writing.
    printf 'session-archive: %s marked vault clones under $HOME; set SESSION_VAULT_REPO to choose one. Not archiving.\n' \
      "$scan_count" >&2
  fi
fi
{ [ -n "$VAULT_REPO" ] && [ -d "$VAULT_REPO/.git" ]; } || exit 0

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
safe_title="$(printf '%s' "$title" | tr '/\\:|<>' '      ' | tr -d '*?"#^[]' | tr -d '\000-\037' \
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
  sed -E \
    -e 's/gh[pousr]_[A-Za-z0-9]{20,}/***MASKED***/g' \
    -e 's/github_pat_[A-Za-z0-9_]{20,}/***MASKED***/g' \
    -e 's#(://[^/:@[:space:]]+):[^/@[:space:]]+@#\1:***MASKED***@#g' \
    -e 's/([Bb][Ee][Aa][Rr][Ee][Rr][[:space:]]+)[^[:space:]]+/\1***MASKED***/g' \
    -e "s/((token|key|secret|password|pat|authorization|bearer)['\"]?[=:[:space:]]+\")([^\"\\\\]|\\\\.)*\"/\1***MASKED***\"/Ig" \
    -e "s/((token|key|secret|password|pat|authorization|bearer)['\"]?[=:[:space:]]+')([^'\\\\]|\\\\.)*'/\1***MASKED***'/Ig" \
    -e 's/((token|key|secret|password|pat|authorization|bearer)[=:[:space:]]+)[^[:space:]]+/\1***MASKED***/Ig' \
    -e 's/AKIA[0-9A-Z]{16}/***MASKED***/g' \
    -e 's/sk-[A-Za-z0-9_-]{20,}/***MASKED***/g' \
    -e 's/AIza[0-9A-Za-z_-]{35}/***MASKED***/g' \
    -e 's/xox[baprs]-[A-Za-z0-9-]{10,}/***MASKED***/g' \
    -e '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/s/.*/***MASKED***/'
}

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
  # Splitting is measurement-only: $t is still emitted byte-for-byte, so content
  # that legitimately carries CR (Windows-authored files, curl progress redraws,
  # terminal control sequences) is archived exactly as it arrived and the ONLY
  # thing this can change is the fence length. It stops at U+000D: U+2028 /
  # U+2029 / U+0085 / form feed are not CommonMark line endings, so folding them
  # would widen fences that no reader could have closed.
  def fence($lang; $text):
    ($text // "") as $t
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
           (($content | clean_user) as $cleaned
            | if ($cleaned | length) > 0
              then [ "## 👤 User — " + ($line | ts) + "\n\n" + $cleaned ] else [] end)
         else
           [ $content[]
             | if .type == "text" then
                 (((.text // "") | clean_user) as $cleaned
                  | if ($cleaned | length) > 0
                    then "## 👤 User — " + ($line | ts) + "\n\n" + $cleaned else empty end)
               elif .type == "tool_result" then "#### 📥 Tool result\n\n" + fence(""; (.content | tool_result_text))
               else empty end ]
         end)
      else
        [ $content[]
          | if .type == "text" then "## 🤖 Assistant — " + ($line | ts) + "\n\n" + (.text // "")
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
  printf -- '---\n'
  printf 'id: cc-session-%s\n' "$session_id"
  printf 'title: "%s"\n' "$(yaml_escape "$title_masked")"
  printf 'client: claude-code\n'
  printf 'project: %s\n' "$project_masked"
  printf 'date: %s\n' "$date_start"
  printf 'branch: "%s"\n' "$(yaml_escape "$branch_masked")"
  printf 'session_id: %s\n' "$session_id"
  printf 'repos: [%s]\n' "$(printf '%s' "$repos_masked" | sed 's/ /, /g')"
  printf 'tags: [claude-code-session, %s]\n' "$(printf '%s' "$repos_masked" | sed 's/ /, /g')"
  printf 'updated_at: %s\n' "$now_iso"
  printf -- '---\n\n'
  printf '# %s\n\n' "$title_masked"
  { cat "$body_tmp"; printf '\n'; } | mask
} | strip_ansi > "$tmp"

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
      git commit -q -m "claude session: precompact snapshot $date_start $repo ($sid8)" || exit 0
    else
      git commit -q -m "claude session: $date_start $repo ($sid8)" || exit 0
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
