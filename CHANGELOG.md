# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **An audit report written before the claim allowlist can still be re-submitted
  byte for byte** (Codex P2 on the allowlist change). `assertWritableText` runs
  before anything touches the filesystem, and stays there — but the set it
  refuses just widened from `id`/`updated_at` to *every* key outside
  `title`/`tags`, and reports that landed while `project:` was legal are on disk
  carrying it. `appendAuditReport` is create-only and idempotent: re-sending a
  report unchanged is a documented success, which is how an at-least-once
  delivery queue stops retrying. Checking first turned that into a throw for
  exactly those older reports, and the queue had nothing to converge on.

  **Only the claim refusal gets a second look**, through its own error type
  (`AuditFrontmatterClaimError`): if the slot already holds that very byte
  sequence, the answer is the `created: false` it always was. Nothing is
  written. Every other refusal — size, NUL, a parse failure, a server-owned key —
  still returns before a single `stat`. The size cap especially: a hatch wide
  enough to catch it would read the 512 KiB+ file the cap exists to avoid
  touching, and a test pins that by storing and re-submitting the *same*
  oversized bytes, the one shape that can tell the two orders apart.

  ⚠️ **`compare_and_swap_audit_state` deliberately has no such hatch.** A report
  is immutable, so re-sending it unchanged is the only way past an older file; a
  state file is *replaced*, and the gate reads `new_content` only — so a
  pre-allowlist `state.md` migrates by writing clean bytes over it, with
  `expected_sha256` still taken from the old ones. The forward path already
  exists, so nothing needs relaxing to reach it.

  What a refused write can now learn is bounded to what the caller already
  holds: the answer differs only when it has produced the stored bytes exactly,
  which is the same signal `created: false` gives on the accepted path today.
  The compare refuses a symlinked leaf first, for the reason the `EEXIST`
  compare does — it must not follow a link out of `reports/` to answer a
  question about what `reports/` holds.

### Added

- **`pnpm run check:stdio`** (`scripts/check-stdio.mjs`) — the declared-vs-live
  surface check for stdio, which only HTTP had (GAP-5). It spawns the **real
  entrypoint** with one endpoint's `.env` (plus a minimal `PATH`/`HOME` base, so a
  stray `MCP_*` in the caller's shell cannot make the declared and live halves
  describe different configurations), runs the handshake over stdin/stdout, and
  classifies `tools/list` against what that file declares. Wider than declared
  fails, narrower warns — the same verdicts `check:http` gives, now from a shared
  classifier (`scripts/surface.mjs`) so the write-tool inventory lives in one
  place instead of two copies that drift.

  **It reads `tools/list`, never the startup line.** The startup line is the
  server's own claim about its surface, and #113 measured the two disagreeing;
  a check built on the claim would reproduce the gap it exists to close. The
  child's stderr is captured for diagnostics only and never parsed into a verdict.

### Documentation

- **The CIMD question is settled, and its re-open trigger is a test.** The
  ROADMAP recorded that deprecating Dynamic Client Registration in favour of
  Client ID Metadata Documents invalidated a premise of the `client_id`
  appendix — "DCR mints a fresh id whenever a client re-adds the connector, so it
  is not a stable identity" — and blocked any `client_id`-keyed feature, the
  audit log included, until that was revisited. The revisit finds the premise
  depends on **this server's own metadata**, not on the deprecation: CIMD support
  is optional for an authorization server, a conformant client gates on
  `client_id_metadata_document_supported` and falls back to DCR when it is
  absent, and this server does not advertise the key. DCR also stays functional
  for at least twelve more months.

  ⛔ **But the premise does not hold even so**, and review caught that before this
  landed. Our metadata governs which registration *mechanism* a client uses, not
  how long an id lives: in the same SDK the CIMD-versus-`registerClient` choice
  sits inside `if (!clientInformation)`, so a host that persists its saved
  registration reuses one DCR-issued `client_id` indefinitely — a fact about the
  host's credential handling that no server-side assertion can see. The gate is
  discharged anyway, because **none of the appendix's conclusions turn on which
  way it goes**. That makes the residual constraint two-sided and a real design
  input for A3: its attribution must be correct whether `client_id` is stable or
  not, assuming neither a fresh id per re-add nor a durable one.

  **The rejections in that appendix do not move.** Neither the anti-router ruling
  nor "`client_id` must not drive trust decisions or widen scope" rests on
  instability — they rest on MCP solving I/O differences client-side and on
  INV-6/INV-7 keeping authorization on transport + flags + token scope — so a
  stable id is not an argument for reopening either. The appendix now says so
  rather than leaving it to be re-derived by whoever reads it next.

  **The trigger is a test, not a note.** `tests/oauth.test.ts` asserts the key is
  absent and names the section, so adding CIMD support turns it red at the moment
  the revisit is earned — and it pins the registration *mechanism* only, which
  its comment now says. Corrections ride along: CIMD is **SEP-991**, from the
  previous revision; the deprecation belongs to the **2026-07-28** revision and is
  cited that way rather than by SEP number, because **SEP-2577 is "Deprecate
  Roots, Sampling, and Logging" and does not cover DCR** even though the SDK's own
  `@deprecated` comment says it does; and per-`client_id` revocation is blunter
  under DCR than the entry said, because a revoked registration can re-register
  and return under a fresh id.

- **A policy-enforcement and provenance assessment**, in
  `docs/policy-provenance.md`. It was asked to evaluate applying OS-style ideas —
  a policy layer privileged components cannot argue past, artifact provenance,
  tamper detection, fail-closed degradation — and the useful answer turned out to
  be narrower than the question. The layer already exists, distributed across
  `pathSafety`, `surfaceFor` and a choke point per store; what does not exist is
  the last mile of two rules the repo already enforces everywhere else.
  **A policy source must not live in the data plane it governs** — held for
  `MCP_OAUTH_STATE_FILE`, `MCP_PATCH_STATE_DIR` and `MCP_CONTEXT_TYPE_RULES`, not
  for `MCP_ENV_FILE` *at the time of the assessment*; that last exception has
  since been closed, in the entry below. **Authority comes from the presented
  principal's scopes** —
  held for OAuth tokens, not for the static bearer, which `authenticate()` grants
  `vault.read vault.write` unconditionally. Both are now ROADMAP items. The
  document also records what was **refused**: watermarking or hidden markers in
  user content, tamper-resistance aimed at the operator, identity-based runtime
  routing, runtime self-hashing, and a centralized policy engine — that last one
  because registering a tool and then refusing the call is strictly weaker than
  never registering it, so the layer would lower the property it exists to raise.
  Measured while assessing: **zero** subprocess and **zero** outbound-network call
  sites in `src/`, so two of the proposed policy domains have nothing to govern.

- **The PRFAQ write answers name OAuth now, instead of leaning on "the web
  path".** `docs/policy-provenance.md` files both PRFAQ files as *left alone* on
  the strength of a quoted limiting phrase, but "over the web path" / 「web 経由」
  also reads as the HTTP transport, which static-bearer clients use too — and
  under that reading the two-condition sentence describes a boundary where one
  condition is vacuous. The passages now say "Writes by an **OAuth-issued
  token**", so the classification no longer depends on how a reader maps that
  phrase. Nothing was reclassified. Three of the four quotes in the left-alone
  table also turned out not to be verbatim: each added emphasis to exactly the
  words doing the limiting, so the record showed the limitation more prominently
  than its source did — in the one table meant to let that judgement be
  re-checked without re-reading the source. The quotes are exact now.

### Security

- **The session-archive fence is sized over CR line endings too** (third
  `/claude-security` scan, F4 and F11). The fence containing untrusted
  tool-result text was sized by splitting the content on LF only, but CommonMark
  ends a line on a bare CR as well: `~~~~~~<CR>## 👤 User …` reached the sizer as
  **one** line whose rest was non-whitespace, so it scored 0, the fence opened at
  the six-tilde floor, and the reader then saw a six-tilde line that **closed**
  it. Everything after it became top-level Markdown in a note that is committed,
  pushed to the vault, and later served back over MCP as the record of the
  session — a forged operator turn carrying an approval nobody gave. This is the
  escape #94 was written to close, reached through a line terminator that fix did
  not model.

  The sizer now splits on CR as well. It **splits** rather than folding CR with a
  regex on purpose: `gsub("\r\n?"; "\n")` walks the whole text and measured
  quadratic on CR-dense output (32 → 128 KB: 1.31s → 19.19s), and this renderer
  runs over the entire transcript every turn with no hook timeout, so one poisoned
  tool result would get the render killed before the single write — erasing the
  record of its own arrival. The emitted text is unchanged byte for byte; only
  the fence length can move, and only where a CR-delimited line is itself a valid
  closing fence.

  ⚠️ **The other two findings against this script are not closed here.** F2 (ANSI
  stripping still runs *after* the fence is sized) and F3 (the secret mask misses
  quoted/JSON credential values) were declined at the fix stage and **remain
  open**; there is no guard for them to remove, so the ANSI and quoted-value
  cases are **unverified, which is not the same as verified green**. Removing
  `| split("\r")[]` reds five named assertions — the CR half only.
  `archive-session.sh` ships byte-identical in `terminal-ops-logs`, and neither
  half of the change is effective alone.

- **The audit write surface is constrained in what it may claim, not only in
  where it writes** (INV-9). `append_audit_report` and
  `compare_and_swap_audit_state` wrote their payload byte-for-byte, and the only
  frontmatter they refused was the two server-owned keys (`id`, `updated_at`).
  Everything else passed — including the keys the read side uses to decide what a
  document *belongs to*. A report whose frontmatter declared
  `project: <victim>` plus the state tag was returned by **`get_project_state` in
  `state_docs`, as full text against its token budget, described by the tool as a
  note the owner designated**;
  it also took a seat in `recent_docs`, appeared in `ops_recent` via
  `target_repo`, and was counted against the victim project by `list_projects`.
  The principal that could author it holds *only* this surface — no
  `create_document`, no plan/apply, no approval step — which is the unattended
  scanner the surface exists for, and the confused deputy the endpoint split
  exists to bound.

  Both writers already met at one choke point (`assertWritableText`), so the rule
  goes there: an audit file may declare **`title` and `tags`, and nothing else**
  (`assertAuditWritableFrontmatter`). An allowlist rather than a list of the four
  keys that escalate today, for the reason `toPublicDocument` is an allowlist and
  not a `delete`: a key the read path starts honouring later is refused by
  default. `plan_document_update` — which needs a staged plan and the current
  user's approval of a complete diff — is itself limited to five allowlisted
  keys; a single-call unattended surface must not be wider than that.

  **Real reports keep working.** `title` and its own `tags` still write,
  the state tag included: a tag designates nothing on a document that cannot name
  a project, because `get_project_state` filters by `project` first. It is not
  inert. Beyond the filters the caller selects (`search_documents(tags)`,
  `list_projects(tags)`, `get_context(tags)`, the last returning matching
  sections as text), free-text search scores a document up for every query term
  matching one of its tags — so a tagged report can surface in a query that
  never named the tag — and an operator-configured tag rule can attach a
  weighted `type` in `get_context`. That much the report authors about itself.
  What it cannot author is designation, and designation is what this closes.
  ⚠️ Nor does the rule reach the **body**: markdown links there produce ordinary
  graph edges, so a report can still appear as a `trace_sources` backlink.
  Frontmatter-free reports still write. What changes beyond the
  refusal above is that a report stamping **its own custom keys** (a
  `scanner:` line, say) is now refused too and must move that detail into the
  body. The keys are read **before** normalization, because `normalizeMetadata`
  always materializes `tags` and `source_refs` and a check over its output could
  not tell a declaration from an empty file.

  The report **body** is unchanged in status: it is still untrusted vault content
  under INV-5, and this does not stop a hijacked scanner writing text into the
  audit subtree — that is what the surface is for. It stops that text arriving in
  front of a later session as something a project's owner designated.

  ⚠️ **Reports already on disk are not migrated.** A report written before this
  change, whose frontmatter declares keys of its own, is refused when it is
  re-submitted — even byte-for-byte identical. The frontmatter check runs in
  `assertWritableText`, ahead of the `wx` write, so the `EEXIST` comparison that
  would have returned `{ created: false }` is never reached. Nothing on disk
  changes and no bytes are written: what an upgrade loses is the idempotent
  retry, not the trail. There is no separate migration step, because a scanner
  still emitting those keys fails on every *new* `run_id` as well until it moves
  them into the body — the one fix settles both, and a scanner that has been
  fixed has nothing left to replay.

  The obvious reading — compare the existing bytes *before* applying the policy —
  is not the remedy. The `readFile` on that path sits after `assertNotSymlink`
  deliberately, so the comparison cannot follow a symlink out of `reports/`, and
  the NUL and size checks live inside `assertWritableText` itself; a read placed
  ahead of it would run on unvalidated, unbounded input on every request, not
  only on the ones about to be refused.

  ★ **Corrected, same day: the retry is restored, by the shape that paragraph
  itself named.** The text above stands as the account of what the allowlist
  alone does, and both of its objections are right about *reordering* — they are
  the reason the fix is **catch-then-check** rather than check-later. The policy
  still runs first and still runs on every request; only when it throws its own
  claim error does the append look at the slot, and it looks through
  `assertNotSymlink` before `readFile`, exactly where that guard already sat.
  Nothing reaches `writeFile` unvalidated, because nothing is written on that
  path at all, and NUL and the size cap have already passed inside
  `assertWritableText` before the claim check is reached — so neither runs on
  unbounded input, and neither is skipped. See the `Fixed` entry at the top of
  this release for the measurements, including the mutation that shows a hatch
  wide enough to catch the size cap would read the 512 KiB+ file that cap exists
  to avoid touching.

  ⚠️ **What the paragraph above got right is the part that is not about
  ordering**: the loss is self-limiting, because a scanner still emitting those
  keys fails on every new `run_id` too. That argument is untouched by the fix and
  is the honest reason its value is narrow — it helps a replay of *old bytes*
  (an at-least-once queue), not a scanner that simply has not been updated.

- **The static bearer's scopes are derived, not assumed** (GAP-4). `authenticate()`
  (`src/httpServer.ts`) returned `{scopes: [vault.read, vault.write]}`
  unconditionally once `MCP_AUTH_TOKEN` matched, which made it the one principal
  whose authority did not come from what it presented: `surfaceFor`'s two
  conditions collapsed to one (the server flag) on that path, a **read-only
  static token could not exist**, and "writes for the web client, read-only for
  the pasted bearer" was not expressible. It now returns `config.authTokenScopes`,
  parsed from an optional **`MCP_AUTH_TOKEN_SCOPES`**.

  **The default is unchanged** — unset means the same two scopes, so no existing
  deployment behaves differently. The variable can only **narrow**: the result is
  produced by filtering the default set, not by accepting the operator's list, so
  a subset is what the operation yields rather than what a validation happens to
  allow. An unknown scope, a set-but-empty value, and a set without `vault.read`
  each refuse to start rather than falling back to the full set.

  Because the default is unchanged, every test on the default path stays green
  with the change reverted — so the behaviour is pinned through a **narrowed**
  scope set, asserting all nine write tools leave `tools/list` while the listing
  itself is asserted to be real (non-empty, read tools present).

- **A staged two-step plan is now bound to the vault it was staged for.**
  `apply` looked a plan up by `patch_id` alone and resolved its vault-relative
  `target_path` against whichever root the running store had, so two servers
  sharing an explicit `MCP_PATCH_STATE_DIR` could apply each other's plans.
  Every plan now records the primary root's tag and each apply refuses a plan
  naming a different vault, or naming none.

  **All three plan kinds**, not just the one the ROADMAP entry named: planned
  updates, planned exact-path creates, and planned Skill bundles share that
  directory and cross the same way. A Skill is the heaviest of the three, since
  later sessions load it as instructions.

  An unrecorded plan is rejected rather than warned about. The seven-day sweep
  does not make it a bounded window — the sweep is staging-driven, so a server
  that stays up and stages nothing more never runs it again.

  The tag is **not** returned to the client: it is a hash of the vault's
  absolute root path, and handing it back would let a caller confirm a guessed
  path. The persisted and returned records are separate types so that split
  stays visible.

  The tag covers three things, because each of the first two turned out to be
  insufficient on its own: the **resolved path** (which vault was named), the
  root's **`(dev, ino)`** (which directory that named — the same filesystem
  identity `assertOutsideKnowledgeRoots` compares rather than trusting a
  string), and its **birth time** (which incarnation of that directory). A
  symlinked `KNOWLEDGE_ROOT` retargeted at another vault keeps its spelling;
  the directory
  at a fixed path can be replaced by a restore or redeploy while the path stays
  identical; and **inode numbers are recycled**, so `rm -rf vault && mkdir
  vault` hands the replacement the number the original just released — measured
  on this repository's own filesystem. A planned create is the sharp end of the
  last two, having no stale-content check to fall back on.

  **This is not a persistent vault identifier**, which would have to be stored
  inside the vault — an unapproved write into the data plane. It closes the
  measured flows without opening a write path. On a filesystem that records no
  birth time the tuple silently falls back to path and inode.

  **The identity is re-checked immediately before each write**, because
  everything between the first check and the write — target validation,
  resolution, the stale read — walks the pathname again, so a directory replaced
  in that window would be verified in its old incarnation and written in its
  new one. The second check narrows that window to the write itself. **It does
  not close it**, and no arrangement of `stat` calls can: closing it needs the
  write anchored to the directory that was verified, which is fd-based
  containment (`openat`, per-component `O_NOFOLLOW`) that Node does not expose
  portably. `readDocument` records the same wall for INV-1 and reaches the same
  conclusion — keep the cheap check, do not call it containment.

  **The same capture-then-verify runs at plan time**, and it is a different
  window: deriving a plan first and tagging it afterwards lets a root replaced
  in between produce a plan whose content came from the old vault and whose tag
  truthfully names the new one, so every apply-time check passes. Each writer
  now captures the identity before it reads anything and refuses to stage if it
  changed. A refused plan leaves no file behind.

  **The cost, stated rather than discovered later:** `(dev, ino)` is not stable
  across a restore from backup, a copy, or a remount, and including the path
  means renaming the vault refuses too. In all of those the staged plans of an
  arguably unchanged vault are refused and need re-planning. That is the
  direction to be wrong in — a plan is cheap to stage again, and the alternative
  is a write landing in a vault nobody approved it for.

  Existing deployments are unaffected unless they share a plan directory between
  vaults; plans staged before this change are refused and need re-planning. So
  are plans staged before the vault's root was moved or re-linked.

- **`MCP_ENV_FILE` is now checked for containment, closing the last exception to
  "a policy source must not live in the data plane it governs."** `loadConfig`
  tests it against every knowledge root with the same `(dev, ino)` walk its three
  siblings use — symlinks followed component by component, so a dangling link
  into the vault is caught before its destination exists — and refuses to start
  if it resolves inside one.

  The reason it was exempt was ordering, not disagreement: `loadEnvFile()` runs
  before `KNOWLEDGE_ROOT` exists, because the file is one of the things that can
  supply it, so a check placed at the read has nothing to compare against. The
  check runs one step later instead, after the roots resolve and before any store
  is built. The 0.8.0 entry that recorded this as unhandled was accurate when
  written and is left as it stands.

  **What it does not buy.** By the time it fires the file has been read and its
  secrets are in `process.env`, and a file that sat inside an indexed root may
  already have been read by anything with vault access. `MCP_OAUTH_STATE_FILE`
  fails *before a write*; this fails *after a read*. It refuses to keep serving on
  credentials a vault reader may already know — so the error tells the operator to
  move the file **and rotate what it carried**, rather than to relocate and reuse.

  No behaviour changes for a deployment that does not set `MCP_ENV_FILE`, or that
  already keeps it outside the vault.

### Documentation

- **A new ROADMAP entry: `assertOutsideKnowledgeRoots` does not see hard links.**
  `isInsideRoot` compares each *ancestor directory* of the target against the
  *root directory*'s `(dev, ino)`, so an external policy-source path hard-linked
  to a note inside a root reads as outside and is accepted — while staying
  editable through its vault alias. Measured: the alias reports the note's inode
  with `nlink=2`, and its ancestor chain never meets the root's inode. Bind
  mounts and case-insensitive aliases **are** caught, because those alias a
  directory. Scope is stated plainly in the entry: this is a boot-time
  **misconfiguration** guard that under-delivers, not a surface a remote caller
  can reach.

- **`docs/threat-model.md` gained a fail-closed posture table** (§5), organized by
  operation class rather than by threat, because "does it fail closed?" is asked
  per operation and the answer here is deliberately not uniform. Three of seven
  classes are empty — delete, execute and outbound network are operations this
  server does not have — which is the most useful thing the table says. It also
  carries two rules learned from shipped defects: a cell claiming *degradation*
  owes a measurement, since prose cannot distinguish a degrade from a stop; and a
  cell claiming *fail-closed* may still owe a cost, which must be paid outside the
  mechanism rather than by relaxing it.

- **The two-condition write gate is annotated where it is stated as a current
  protection.** `read-only unless allowWrite + vault.write` reads as two
  independent conditions and is one for the static bearer, whose scope half is a
  constant. The caveat is attached in `threat-model.md`, `README.md` and the
  `operations.md` checklist; passages that limit the claim themselves were left
  unchanged, because annotating correct text is its own kind of error. For each
  of those, `policy-provenance.md` quotes the phrase doing the limiting — reading
  a grep's output can only remove sites, so over-inclusion is caught by anyone
  who reads the passage while under-inclusion leaves nothing behind to check, and
  the quoted phrase is that check.

- **The shipped write-boundary passage in `docs/ROADMAP.md` now carries the
  static-bearer caveat.** Under the shipped "Exact-path document creation"
  heading the boundary was stated as `MCP_HTTP_ALLOW_WRITE` + `vault.write`, but
  `authenticate()` grants a static bearer both scopes as soon as the header
  matches, so on that deployment only the flag gates anything. The caveat is
  reused from the `operations.md` checklist rather than reworded, and
  `docs/policy-provenance.md` now reads four files and six places, naming the new
  site instead of only counting it. Three records go with it: the passage was in
  neither the caveat list nor the left-alone table, which is the nothing that
  under-inclusion leaves behind; a second passage is in neither list either — the
  exact-path runbook, a different kind of defect tracked separately; and counting
  the passages is a different search from finding the hits, bounded by window
  width, by whether the match may cross a newline, and by which spellings it
  knows. Four of the six places counted are unreachable by that pattern at any
  window, and widening the window far enough to reach a wrapped juxtaposition
  starts pairing terms that are merely adjacent — so the raw count is not a
  bound in either direction until the hits are read and classified.
- **The exact-path write runbook in `docs/operations.md` no longer tells a
  static-bearer operator to authorize a scope.** It said to set
  `MCP_HTTP_ALLOW_WRITE=1`, restart, "and authorize a `vault.write` scope". The
  flag exists on every deployment; the authorize step exists only for OAuth,
  because a static bearer's scopes come from configuration and there is no
  consent flow to visit. The instruction now branches on the credential, and the
  OAuth branch again on whether that client's token already carries the scope.
  Three conditions decide it — the client asked for `vault.write`, the scope was
  grantable when it authorized, and a credential outlived the restart — and
  rather than have an operator reconstruct all three, the runbook tells them to
  ask the endpoint: list that credential's tools, and re-authorize only if the
  document-write tools are absent. It points at the §5 checklist, which already
  carried the same asymmetry as a caveat — the right description and the wrong
  procedure were in one file. This
  is a different defect from the caveat sweep's: not a reader misled about being
  protected, but one sent looking for a step that is not there, and
  `policy-provenance.md` records why the two criteria stay apart.

## [0.9.0] — 2026-08-16

### Added

- **`get_project_state` — where a project stands, derived rather than summarized.**
  Returns the notes the owner designated as state (in full, against a budget),
  the most recently touched documents (metadata and a snippet), the session
  archives that exist, and pointers to ops-log entries naming the project.

  **The shape follows from one fact about this vault**: a session archive runs
  to megabytes while an ordinary note runs to kilobytes, so "return the
  project's documents" is not one behaviour. `recent_sessions` therefore carries
  **metadata, size and — for the newest — a heading outline, and never a body**;
  inlining one would spend the whole budget on the document the caller asked
  about least. Session archives are kept out of `recent_docs` for the same
  reason: a snippet of a megabyte is its least useful 240 characters.

  **There is deliberately no `summary` prose, no `blockers`, no `next_steps`.**
  A server emitting those has synthesized, and synthesis here would be either a
  second model — which this one does not have, by design — or a template
  pretending to be one. The seat for a conclusion is a state document a human or
  an offline pipeline wrote, which this returns verbatim. The tag naming that
  seat is `MCP_PROJECT_STATE_TAG` (default `project-state`).

  `ops_recent` reaches ops logs through their existing `target_repo` frontmatter
  with no change to the capture hook, and returns **pointers only** — that field
  is self-declared, so any note can join the list, and what it joins is a set of
  paths the same caller could already enumerate.

- **`fetch_document` can return part of a document.** `outline: true` returns
  the heading structure with each section's size and token estimate *instead of*
  a body; `sections` keeps only the named ones (matching a heading's text or a
  `/`-joined prefix of its path, case-insensitively, bringing subsections with
  it, and reporting `sections_matched` so a mistyped heading is visible);
  `max_chars` truncates. Extended rather than joined by a `fetch_section`
  sibling, because asking for part of a document is the same question as asking
  for it. **Every parameter is optional and omitting all of them reproduces the
  previous response exactly** — pinned by a test, not by intent. `total_chars`
  always reports the whole document, never the slice, for the same reason
  `get_context` returns `omitted[]`.

- **`get_context` — one call where clients were running a search → fetch loop.**
  It seeds from a search over the usual filters, expands one or two hops through
  the link graph, drops duplicates, splits long notes at their headings, and
  packs greedily by score-per-token into a `token_budget` (500–32000, default
  4000). Five fixed stages, no plugin mechanism: a pipeline whose stages are
  configurable is one whose output cannot be reproduced from its inputs, and the
  value of the rest of this entry depends on that.

  **The package says what it left out.** Every chunk carries `relationship`
  (`seed` / `linked:out` / `linked:in` / `source_ref` / `same_project` /
  `recent`), its `path`, its `heading_path` when the note was split, and its
  score. What did not fit is reported in `omitted[]` with a reason (`budget` /
  `duplicate`) — **one entry per document per reason, capped, with
  `omitted_count` carrying the true total** so a shortened list says it is
  shortened rather than reading as the whole story. That is what makes a short
  answer distinguishable from a complete one — the ambiguity that drives blind
  re-querying — and it turns the follow-up into a precise `fetch_document`
  rather than another search.

  Three bounds are enforced rather than suggested. **At least one of `query`,
  `project`, `tags` or `path_prefix` is required**, so there is no way to ask
  for the vault whole; a budget alone would not have prevented that, only
  truncated it. **No single document may occupy more than 40% of the budget**,
  so one megabyte-scale session archive cannot become the entire answer — and a
  chunk cut to fit says `truncated` instead of being quietly shortened. And
  **token cost is estimated high on purpose** (`src/tokenEstimate.ts`,
  dependency-free): every code point falls into one of three cost buckets with
  the *expensive* one as the fallback, ASCII inside a fenced code block costs
  more than the same characters as prose, and each chunk is charged for its JSON
  framing as well as its text — a budget that priced only text would be a budget
  on something the caller never receives on its own.

  **Nothing a note says about itself moves it up the ranking.** Optional
  owner-authored type weights (`MCP_CONTEXT_TYPE_RULES`, absolute path, JSON)
  are off by default and change no ranking until configured. Weights above 1.25
  can only come from signals the owner controls — a configured `root` name or a
  `path_prefix` — while a `tag` rule and the frontmatter `type` hint are clamped
  to 1.25, because both are things a note carries about itself and `tags` is
  additionally writable through `plan_document_update`. `type` stays out of that
  patch allowlist, so promoting a document remains a human edit in Obsidian. The
  rules file must live **outside every knowledge root or the server refuses to
  start**: a root is synced and writable, so a ranking file inside one could be
  rewritten by anything that can write a note.

  Read-only, so it is registered on every transport and at every scope that can
  read at all — it assembles documents such a caller could already fetch one at
  a time, and the budget makes the response smaller than the loop it replaces.
  The server instructions gain a sentence saying a package is untrusted vault
  data and that inclusion is a retrieval outcome, never an endorsement; a
  fixture pins that an injected note passes through it inert.

  Four properties came out of review rather than out of the design, and three
  of them contradicted a claim this entry originally made. `omitted[]` is folded
  to one entry per document per reason and capped, with `omitted_count`
  reporting the true total — it was unbounded, so a note carrying thousands of
  headings could answer a 500-token request with hundreds of kilobytes of
  refusals, which made `token_budget` a bound on the chunks and not on the
  response. A `source_ref` is scored as a **fraction of the seed that named it**
  rather than at a fixed 0.4 — seed scores are normalized, so a weak match
  scores below that floor, and a note could put its own chosen document above
  real query matches through patch-writable frontmatter. Content dedup
  fingerprints on **NFC**, not the search path's NFKC-and-lowercase, which was
  treating `Foo` and `foo` as the same document. And the greedy order divides by
  the **full** chunk cost, framing included, which it was already charging.

  ⚠️ **Recency is applied in exactly one place — search — and this deviates from
  the design note on purpose.** The proposal sketches a recency factor inside
  the packer's fuse stage. Implemented literally, that subtracted search's own
  recency contribution and re-applied a weight only a per-call parameter could
  set, which left `MCP_SEARCH_RECENCY_WEIGHT` dead for `get_context`: two notes
  with identical text ranked identically however the deployment was tuned. That
  is the shape the recency wiring bug already had once, in a different module.
  The packer therefore has no clock at all, and a package is a pure function of
  (vault, input, rules).

- **`trace_sources` now says what each link resolved to, and can walk two hops.**
  A new `resolved_outgoing[]` labels every entry of `outgoing_links` with
  `resolved`, the `target_path` / `target_id` it landed on, or the
  `candidates[]` it could have meant. Optional `depth` (1–2) and `direction`
  (`out` / `in` / `both`) add a bounded `related[]` neighbourhood — node cap 50,
  fan-out 20 per node taken most-recent-first, and **hub damping**: a note with
  degree above 30 comes back as a neighbour but is not expanded through, so one
  MOC cannot pull the vault into a depth-2 answer. The three long-standing
  fields keep their shape, `related` is absent unless `depth` > 1, and
  `direction` shapes only `related` — so a caller that starts passing it cannot
  quietly lose its backlinks. No new tool: this is `trace_sources`, extended.

  Behind it, `src/linkGraph.ts` builds the graph from an unprefixed
  `listDocuments()` — a backlink set over a subset is wrong rather than short —
  and never touches the filesystem itself, inheriting INV-1 containment from the
  store. Nodes are keyed on the **path**, not on frontmatter `id`: `id` is the
  field INV-2 already refuses to resolve on when two notes claim it, so a graph
  keyed there would let one note redirect another's edges. Link extraction now
  rides the parse cache alongside the derived search text, since `trace_sources`
  ran the extractors over every note in the vault on every call.

  Two shapes of the response are worth knowing before reading it. **`raw` is not
  a key**: a link is resolved once per _syntax_ it was written in, because
  `[[foo]]` names the root-relative `foo.md` while `[x](foo)` names one relative
  to the linking note's own directory — so a note writing both forms of one
  string gets both edges, and the entries collapse only when they agree. And
  **`outgoing_links` and `resolved_outgoing` always describe one snapshot**:
  both are derived from the graph, whose view of the traced note is the vault
  listing's, falling back to the fetched copy when the walk did not list it —
  since #114 a note `fetch` can read may be skipped by the walk, and answering
  "this note writes no links" would be indistinguishable from a note that
  writes none.

### Changed

- **A wikilink no longer resolves through a note's `title` or `aliases`, even
  when the match is unique.** Links resolve on path facts only — an exact
  vault-relative path first, then the link text as a filename — because those
  are server-owned and a note cannot rename its own file. `title` and `aliases`
  are frontmatter the body's author writes, which is the same class as the `id`
  that INV-2 already refuses; honouring a *unique* alias would reopen that hole
  under another name, since what decides uniqueness is attacker-writable. They
  now appear as `candidates[]` on an unresolved link instead.

  **This removes backlinks, and the number is not buried.** Measured against the
  reference vault (2,891 notes, single root): backlink edges drop **4,027 → 349
  (−91%)**. Every one of the 46 links that resolved through a *unique* title
  still lands on the same note, and filename matching adds 249 edges that did
  not resolve before. The 3,927 that disappear are all fan-out from titles
  several notes shared — 580 of the 606 links producing them name a file **no
  note in the vault has**, which Obsidian itself shows as unresolved and this
  server was attaching to every note that happened to share an H1. Two limits
  stay on the record: this is n=1, and a vault that genuinely operates `title`
  as an identifier would split differently; and `aliases` appears nowhere in
  that vault, so that half of the rule is pinned by tests rather than measured.

  In multi-root deployments, implicit forms resolve **within the linking note's
  own root** — only the explicit `<root>:<path>` form crosses, because root
  names come from configuration and a note cannot claim one for itself.

  Matching is NFC-canonical on both sides, so a link written decomposed still
  finds a composed filename (and the reverse) — relevant on macOS, where an
  editor may write either form. It is not case-folded: paths elsewhere in this
  server compare exactly, and the measurement above was taken that way.

- **A search that declares a `path_prefix` no longer scans the whole vault.**
  Every read tool walks the vault through `listDocuments()`, and the filter used
  to run after the walk had already read every note. The prefix is now handed to
  the walk, which skips subtrees that provably cannot contain a match. Results
  are unchanged by construction — `searchDocuments` is still the authority and
  the walk's prune rule is deliberately conservative — so this is a cost change
  only, and `fetch` / `trace_sources` / `list_projects` keep scanning everything
  (id uniqueness under INV-2 and backlink completeness both need the full
  corpus).

  Measured on a 2,880-note / 47.4 MB vault on iCloud Drive: the tree walk costs
  0.155 s, `stat`-ing every note 0.864 s, and reading all 47.4 MB only 0.23 s
  more than that. **The cost is per-file syscalls, not bytes** — which is why the
  narrowing is on file count, and why the parse cache alone never removed it.

- **The parse cache's stat signature gained `dev`** alongside `ino`, so the
  inode identity it watches is unique across filesystems rather than only within
  one. Freshness only: containment is still re-proven by `realpath` on every
  read. Removing that per-read resolution was attempted here and **reverted
  before merge** — a directory moved out of the root and symlinked back leaves a
  child's `dev`, `ino`, `ctime` and `mtime` all untouched, so the signature
  matches across a real escape. See `readDocument` for the recorded reason.

- **The HTTP startup line names the subtree reservation, not just the flag.**
  `skills=` and `audit=` now report the same three states the stdio line has
  reported since those gates were split — `off` (no `MCP_SKILLS_SUBDIR` /
  `MCP_AUDIT_SUBDIR`, so the INV-8 / INV-9 reservation is not in effect),
  `reserved-only` (subtree reserved, write tools not registered), `on` (both).
  They printed `MCP_HTTP_ALLOW_{SKILL,AUDIT}_WRITE` alone, so `audit=off` meant
  "tools not registered" on HTTP and "subtree NOT reserved" on stdio: one token,
  opposite readings, on the two processes INV-9's condition — every write-capable
  process against a vault reserves the same subtree — asks an operator to
  compare. The HTTP line was the silent one, on the remotely reachable transport.
  No gate changes; this is what the line says about them.

- **`/claude-security` scan output is now ignored.** A change scan writes a
  `CLAUDE-SECURITY-<timestamp>/` directory of threat models and findings, and a
  scan of this repo names the operator's real `KNOWLEDGE_ROOT` and note paths.
  Those directories were untracked but **not ignored**, so the only thing
  keeping them out of a public repo was this project's "never `git add -A`"
  rule — a habit, not a guard, and the canon for exclusions is `.gitignore`.

### Fixed

- **The new parse-cache bound was three times too small, so it turned the cache
  off.** The cap counts `body + foldedBody + compactBody` in UTF-16 characters,
  but 24,000,000 was chosen against a vault's size **on disk** — two different
  units. Measured on the reference vault (2,894 notes, 48.6 MB on disk): 27.2M
  body characters plus 53.7M of derived copies is **80.9M**, so a single scan
  never fit. Every read path here enumerates the whole vault, so the entries
  evicted during a sweep were the ones the next sweep reached first: a warm full
  scan went **91 ms → 689 ms** and `search` **150 ms → 724 ms**, with retained
  heap unchanged after a forced GC (168.6 MB → 168.3 MB). The default is now
  192,000,000 — the measured working set with 2.4x of headroom — overridable
  with **`MCP_DOCUMENT_CACHE_MAX_CHARS`** for a larger vault, and the first
  eviction now says on stderr that scans will re-parse instead of leaving that
  to a stopwatch. The eviction tests no longer inherit the shipped default:
  they state their own budget, so re-sizing it cannot quietly stop them from
  evicting.

- **The parse cache had no bound, no eviction, and no delete path.** Every note
  read was retained for the life of the process — body plus the two derived
  copies the search path needs — so a note deleted from the vault kept its parse
  alive forever, and a vault larger than memory had no behaviour other than to
  exhaust it. Measured on 1,000 synthetic notes totalling 16.9 MB on disk: heap
  7.7 MB → 42.7 MB, still resident after a forced GC. It is now capped at 24
  million characters of retained text with least-recently-used eviction, so an
  over-budget vault degrades into re-parsing instead of growing.

  Two things it is **not**. The cap counts characters, not heap: string
  representation, frontmatter objects and Map overhead sit outside it, making it
  a proxy off by a roughly constant factor rather than a memory limit — a cache
  bound that tried to track real heap would be wrong in a way nobody could
  reason about. And a note larger than the whole budget is still cached and
  served rather than re-parsed on every access.

- **stdio registered the Skill write tools for anyone who reserved the subtree.**
  `MCP_SKILLS_SUBDIR` exists so that general document writes cannot reach the
  Skill subtree (INV-8), and operators are told to set it on every write-capable
  process — but stdio also read its presence as permission to register
  `plan_skill_create` / `apply_planned_skill_create`. Following the documented
  guidance therefore armed every interactive local session with them. Registering
  them now needs **`MCP_STDIO_ALLOW_SKILL_WRITE`** (default off), matching
  `MCP_HTTP_ALLOW_SKILL_WRITE` on HTTP and the audit surface's existing split.
  The reservation is unaffected, and the startup line's `skills` field now
  reports three states (`off` / `reserved-only` / `on`) for the same reason
  `audit` does.

- **A write could produce a note the server could no longer read or repair.**
  The 8 KiB frontmatter cap was enforced when parsing a note and not when
  emitting one, so a patch that satisfied every allowlist and type rule could
  serialize past it. The note was written, then indexed body-only — its title
  falling back to the basename and any frontmatter `id` dropping out, moving its
  identity to its path — and `plan_document_update` could not touch it
  afterwards, because planning parses with the strict reader. The limit is now
  asserted on the serializer's output, which every writer passes through, and the
  refusal happens at plan time so no diff is approved that cannot be applied.

- **One unreachable entry no longer takes down every read tool.** A dangling
  symlink — the everyday residue of a synced folder (iCloud, Dropbox) or a moved
  directory — made `search`, `fetch`, `list_projects` and `trace_sources` all
  throw, because the walk resolved links before deciding whether it even cared
  about the entry. Entries the OS reports as unreachable (`ENOENT` / `EACCES` /
  `EPERM` / `ELOOP` / `ENOTDIR`) are now skipped with the basename on stderr.

  **A symlink that escapes the knowledge root still aborts the whole walk**, and
  that distinction is the point: the classifier matches on errno, so a
  containment refusal — which carries none — can never be mistaken for an
  availability accident. INV-1 keeps failing closed. What changed for escapes is
  only that stderr now names the offending entry (basename, as elsewhere), so an
  operator with a few thousand notes is not left to find it by hand. The thrown
  error is unchanged, because that one reaches the MCP client.

- **The walk now waits out transient FD exhaustion, as reading already did.**
  `EAGAIN` / `EMFILE` / `ENFILE` were retried with backoff when reading a note
  and not when walking to find it, so the two halves of one scan disagreed about
  the same condition — and walking a few thousand notes at `MCP_SCAN_CONCURRENCY`
  is exactly what produces those codes. Retries are per syscall; once they are
  spent a directory-level failure still aborts, since a skipped directory is an
  unbounded number of missing notes and a search that answers from a truncated
  vault reports "no such note" about notes that exist.

- **Staged two-step plans now expire after seven days instead of living
  forever.** A plan file is deleted only when it is *applied*, so one the user
  declined — or one whose conversation simply ended — sat on disk for the life of
  the machine holding the pre-edit text and the full proposed text of a note
  **outside the vault**, with no tool to discard it. The sweep runs from
  `ensurePatchStateDir`, which every plan-staging store already calls, so it
  covers document *and* Skill plans and a writer added later inherits it.

  Two properties worth knowing rather than assuming. It **deletes only this
  server's plan files** — `<uuid>.json` and `skill-create-<uuid>.json`, the same
  rule the stores build their paths from — so an `MCP_OAUTH_STATE_FILE` or
  anything else an operator keeps in that directory is left alone. And it is
  **not a timer**: it fires at start-up and at each staging, so a server that
  goes quiet right after a plan is declined does not sweep again until something
  else happens. What that bounds is accumulation, which is the defect; the idle
  residue is one file.

- **`MCP_SEARCH_RECENCY_WEIGHT` did nothing on a single-root vault.**
  `createStore` builds a plain `KnowledgeStore` when exactly one root is
  configured, and that branch omitted the two recency fields, so the store's
  search defaults read `undefined` and scoring fell back to a weight of `0` —
  recency was off for every query no matter what the variable said.
  `MultiRootStore` wired both fields from the start, so the disabled branch was
  the one every single-root deployment runs. The empty-query default `order`
  derives from the same weight, so it was pinned to `path` as a side effect.
  A per-call `recency_weight` was never affected: it is read ahead of the server
  default, so this was a dead default rather than an unreachable feature.

- **`plan_document_update` could stage a diff that deleted frontmatter it failed
  to parse.** It read the note's current bytes with the read path's forgiving
  parser, which falls back to _empty_ frontmatter when the YAML is malformed,
  over the block-size cap, or an expansion bomb. Planning an update against such
  a note therefore produced a diff dropping every field the parser could not
  read — and the approver was shown that deletion as the intended change. The
  write path now uses the throwing parser, as INV-2 always required: a reader has
  an obligation to keep returning the note, a writer does not.

- **An update could silently change a note's owner.** `rename` needs write
  permission on the containing directory, not ownership of the target, so a
  process with access to a shared vault folder can replace another user's note
  with a temp file it owns — and then be unable to `chown` the replacement back.
  Ignoring that failure published the note under the wrong owner. The `chown` is
  now skipped only when the temp already carries the target's ids, and a failure
  aborts before the rename, leaving the note's contents _and_ owner untouched.

- **`apply_planned_update` replaced a note in place, and was not strictly
  compare-and-swap.** It read the target, hashed it, compared against the plan,
  then wrote over the file — truncate-then-write, so an interrupted apply (crash,
  full disk, kill) left the note half-written with no second copy in the vault.
  It now writes a same-directory temp file, created no wider than the target and
  `chmod`'d to exactly its permission bits, and renames it over the target. The
  other three writers in the codebase already worked this way.

  The read/hash/write is also serialized in-process: MCP pipelines concurrent
  tool calls, so two applies staged from one base could both see a non-stale hash
  and the second would silently discard the first. The second now re-reads what
  the first wrote and is rejected as stale.

  Atomic is not durable (no `fsync`, matching the other writers), and in-process
  is not cross-process — two connector processes on one vault still race.

  **Replacing a file is not the same operation as writing one, so two things
  changed for operators.** An apply now needs write permission on the directory
  containing the note, not only on the note; a vault that grants file-level edit
  rights inside a non-writable folder gets a message naming that requirement
  instead of a bare `EACCES`. And because the replacement is a new inode, uid and
  gid are restored best-effort (relevant when the connector runs as root or a
  service account) — ACLs and extended attributes are **not** carried, so a vault
  relying on either should stay on a single-owner layout.

- **The parse cache could serve a stale note indefinitely.** Validity was
  `mtimeMs` + size, which cannot separate two writes inside one millisecond and
  is defeated by any editor or sync client (iCloud Drive, for one) that rewrites
  a note to the same length and restores its mtime. The signature is now
  `mtimeNs` + `ctimeNs` + `ino` + size. `plan_document_update` additionally
  derives the planned frontmatter from the bytes `expected_sha256` covers, so a
  stale parse cannot re-serialize frontmatter an external editor already changed.

### Security

- **The legacy one-step `create_document` is now off by default on every
  transport**, behind **`MCP_ALLOW_LEGACY_CREATE_DOCUMENT`**. It was the only
  document write with no plan/apply pair, so "the current user approved this
  exact target and content" was enforced by the server instructions asking the
  model — whose other input is untrusted vault content (INV-5). On stdio it was
  registered unconditionally.

  Path containment, the frontmatter allowlist and `flag: "wx"` always applied,
  and the frontmatter (including `id`) is server-built, so the tool could never
  escape the vault, overwrite a note, or capture another document's identity.
  What it could do without approval is **persist** attacker-chosen body text
  under `projects/`, which every later session reads back as an ordinary note.

  `scripts/check-http.mjs` scores it as its own category, so an endpoint that
  exposes it without the flag now **fails** the operator check instead of being
  permitted under general write. Both startup lines report `legacy_create=`.

  **Migration:** set `MCP_ALLOW_LEGACY_CREATE_DOCUMENT=1` to keep the routed
  `projects/<client>/<project>/<slug>.md` capture, or move to
  `plan_document_create` → `apply_planned_document_create`, which takes an exact
  path and requires confirmation.

## [0.8.0] — 2026-08-10

### Security

- **Setting `MCP_AUDIT_SUBDIR` on a stdio server also handed that session the
  audit write tools; it now only reserves the subtree.** Registering
  `append_audit_report` and `compare_and_swap_audit_state` takes its own opt-in,
  **`MCP_STDIO_ALLOW_AUDIT_WRITE`** (default off), mirroring the
  `MCP_HTTP_ALLOW_AUDIT_WRITE` that HTTP always required.

  The documentation is what made conflating the two expensive rather than
  theoretical: operators are told to set the **same** `MCP_AUDIT_SUBDIR` on every
  write-capable process, precisely so the INV-9 reservation holds everywhere.
  Following that advice armed every interactive local session with the two writes
  the reservation exists to protect against — both single-call, with no
  plan/apply step and no user confirmation, on a transport whose input is
  untrusted vault content (INV-5). A note steered into
  `compare_and_swap_audit_state` could rewrite an unattended scanner's `state.md`
  wholesale; `append_audit_report` could plant a clean-looking run.

  **Withholding the tools does not weaken the reservation.** It rides on
  `config.auditSubdir` through `createStore`, not on the audit store instance, so
  a process with the subdir and no flag gets exactly what the guidance promised —
  general writes still refused from that subtree. Two adjacent tests drive the
  same environment: one asserts the tools are absent, the next asserts a general
  write into the subtree is still rejected on the wire.

  Asking for the tools without a subtree for them to write into now fails at
  boot, the shape `MCP_HTTP_ALLOW_AUDIT_WRITE` already had. The stdio startup
  line reports three states — `audit=off` (no subdir, so no reservation),
  `audit=reserved-only` (the new default), `audit=on` — because one on/off could
  only ever describe one of two decisions, and reading `off` for a reserved
  subtree would wrongly suggest the reservation had lapsed.

  Reverse-verified per guard: dropping the flag from the registration makes the
  withholding test report `to not include 'append_audit_report'`; removing the
  boot check makes the server start instead of refusing.

- **Server state files may no longer be placed inside the vault.** A knowledge
  root is a read surface — everything under it is walked, indexed, and reachable
  through `search` / `fetch`. Two settings could put server state there and
  nothing said no: `MCP_OAUTH_STATE_FILE`, which holds the registered-client
  list, the per-file salt and the HMAC tag, and an explicit
  `MCP_PATCH_STATE_DIR`, whose staged plans hold the full proposed text of a
  document. Both are now checked at boot against every configured root.

  Containment compares **filesystem identity**, not spelling: it walks the
  target's existing ancestors and matches `(dev, ino)` against the root. macOS
  (APFS) and Windows resolve `/vault` and `/Vault` to the same directory while
  `path.relative` compares bytes, so a case variant of the root would otherwise
  be called "outside" and the file would land in the indexed vault anyway. When
  the root does not exist yet there is no identity to compare and the check falls
  back to spelling.

  Canonicalization walks the path component by component and follows symlinks by
  hand, rather than resolving the existing prefix with `realpath`. `realpath` reports ENOENT for a **dangling** symlink, so a
  prefix-based check reads `outside/link -> vault/not-yet` as an ordinary missing
  component and calls the target outside; creating that destination afterwards
  would put every save inside the vault with the boot check already passed.
  Containment then tests for exactly `..` or a `../` prefix — a sibling directory
  merely NAMED `..state` yields the relative path `..state/oauth.json`, which a
  `startsWith("..")` test reads as an escape.

  The **default** patch directory is checked too, not only an explicit value: it
  derives from the home directory, which is not automatically outside the vault.
  A root of `$HOME`, or a secondary root containing it, puts the default inside,
  and that configuration now fails at boot with a message naming
  `MCP_PATCH_STATE_DIR`.

  **Migration:** opting into `MCP_OAUTH_STATE_FILE` now requires
  `KNOWLEDGE_ROOT` (or `KNOWLEDGE_ROOTS`) to be set, because without the roots
  there is nothing to verify the location against. A deployment that already
  keeps its state outside the vault needs no change.

  `MCP_ENV_FILE` is deliberately **not** covered: it is read before the roots are
  known — it is one of the things that can supply them — so the same check
  cannot run there without a different mechanism. Left open rather than
  half-applied.

- **Tool errors no longer describe the host filesystem.** Documents were already
  projected through an allowlist that withholds `absolutePath`, on the ground
  that the host's directory layout is not a client's business. The error channel
  had no such boundary: the server sends a thrown error's `message` back as the
  tool result, and a raw `fs` rejection carries the path it failed on. Applying
  an unknown `patch_id` echoed the patch-state directory — OS username and home
  layout included — and applying an update whose target had been deleted since
  planning echoed the vault root, from a `realpath` call in a different function
  than the patch reads.

  The fix excludes the whole class rather than the known call sites. Enumerating
  sites is what already failed here: the audit that reported this counted two of
  the four, and the next `fs` call added would leak again. `withClientSafeErrors`
  wraps the stores every tool handler goes through, so a system error never
  reaches a client and a store method added later is covered by default; only
  the errno code survives, since `ENOENT` versus `EACCES` is useful to a caller
  and names nothing about the host. Errors the server writes itself pass through
  unchanged, and the apply paths now say "no staged patch with that patch_id"
  instead of leaving a caller to infer it.

- **A constrained write surface can no longer author a document's identity.**
  Refusing to honour a forged `id` on the read side left the other half open:
  the surfaces that let a client choose a vault file's **bytes** could still
  plant the key identity is read from. `append_audit_report` and
  `compare_and_swap_audit_state` write their payload verbatim, and those
  payloads land as `.md` files the store indexes like any other document; a
  Skill bundle's reference files do the same. `SKILL.md` was already pinned to
  `name`/`description`, its references were not.

  Both surfaces were built narrow about **where** they may write. The guarantee
  that injection stays confined to the audit subtree was true of where the bytes
  land and false of whose identity the read side then answers with — a principal
  holding audit-write alone could name any note in the vault.

  `assertNoServerOwnedFrontmatter` now refuses `id` and `updated_at` in
  client-chosen content, from one place per store: `assertWritableText`, which
  both audit writers already pass through, and `validateFileSet`, where the
  Skill plan and apply paths meet. Checking at apply only would refuse the write
  but only after presenting an operator a diff to approve; the squat has to be
  unrepresentable, not merely unapplied.

  Knowing what content claims means parsing it, and these callers accept up to
  512 KiB — so the check runs through `parseMarkdown`, whose block cap precedes
  gray-matter. Adding a frontmatter check to a write surface must not re-open
  the quadratic parse path on it; without that cap the test's own payload costs
  ~286 s (measured 469 / 1,847 / 7,336 ms at 16 / 32 / 64 KiB), so the test
  asserts elapsed time rather than only the throw.

  Unparseable frontmatter is refused rather than waved through: the read path
  degrades because it has an existing note it must still serve, and a writer has
  no such obligation.

  Reverse-verified per guard: dropping the audit call fails four tests, dropping
  the Skill call fails exactly the two reference squats.

- **An archived session note could carry forged conversation turns, because a
  tool result was able to close its own fence.** The session-archive hook wraps
  untrusted tool output — fetched pages, file reads, vault bodies — in a fence of
  exactly six tildes. Six was never a bound, only a longer guess than content
  usually makes: CommonMark closes a fence on the same character, at least as
  many, indented no more than three, so a tool result containing its own run of
  tildes ended the block early and everything after it became **top-level
  Markdown**. That let a page the agent merely read plant a
  `## 👤 User — <timestamp>` heading carrying words the operator never said, in a
  note that is committed, pushed, and later served back over MCP as a faithful
  record of the session.

  Fences are now sized to their own content: longer than the longest tilde run
  the content starts a line with, floor six. Runs that are indented past three,
  or that do not start a line, cannot close a fence and so do not widen it —
  ordinary notes still render at six and are unchanged byte for byte. One helper
  serves tool results, thinking blocks, Bash commands and tool inputs, so all
  four are covered by the one change.

  **The scan's remaining advice was not taken.** It also proposed fencing the
  user and assistant text branches. Those carry the speakers' own words, and
  fencing them would turn every conversation into a code block — the note exists
  to be read. The reachable untrusted source is the tool result, and that is what
  is now contained.

  The regression test drives the jq program **extracted from the hook** rather
  than a copy, so it cannot keep passing after the hook changes, and it asserts
  that the containment check still detects an escape when handed a fixed-length
  fence — a screen that never sees the failure it screens for proves nothing.
  Reverse-verified: downgrading the fence to six turns the three containment
  cases red, each because the forged turn reached top level.

- **Frontmatter is now bounded before it is parsed, closing two quadratic paths
  — one of them a CVE in a production dependency.** Both are driven by the size
  of the frontmatter block and both are reachable from untrusted vault content on
  the always-on read path:

  1. gray-matter's comment stripper, `file.matter.replace(/^\s*#[^\n]+/gm, '')`.
     The `m` flag makes every line start a match position, so the cost is
     quadratic in the number of line starts.
  2. js-yaml's `!!omap` resolution — **GHSA-5p4m-2wfm-xmqj**, js-yaml `<3.15.1`,
     reached as `gray-matter > js-yaml`. `!!omap` is in the default schema, so a
     plain load hits it.

  Measured on this repo's pinned versions (Node 22, gray-matter 4.0.3 / js-yaml
  3.15.0), quadrupling per doubling in both — the signature of O(n²):

  | path                                   | input    | blocked for |
  | -------------------------------------- | -------- | ----------- |
  | comment stripper, no closing delimiter | 391 KB   | **101.8 s** |
  | comment stripper, closing delimiter    | 156 KB   | 9.1 s       |
  | `!!omap`                               | 1,228 KB | 3.5 s       |

  The worst case is a file whose frontmatter never closes, because gray-matter
  then treats the **whole file** as the block. All of it sits far inside
  `append_audit_report`'s 512 KB ceiling.

  `parseMarkdown` now refuses a block over **8 KiB** before calling `matter()`.
  Nothing that inspects the parsed _result_ can help here — the CPU is spent
  during the parse — which is why the existing anchor/alias expansion guard,
  which runs after `matter()` returns, never covered this. The two guards are
  complementary: a block-size cap was correctly **rejected** for the expansion
  bomb (that bomb is a few hundred bytes) and is the right bound here, because
  size is exactly what drives these two.

  **The `!!omap` path is additionally fixed at the dependency.** js-yaml
  **3.15.1** is patched and sits inside gray-matter's `^3.13.1` range, so
  `pnpm.overrides` pins it — no major upgrade and no API break. Measured on the
  resolved tree: 3.15.0 quadruples per doubling (74 / 173 / 670 / 3,068 ms at
  n = 5k / 10k / 20k / 40k) while 3.15.1 is linear (83 / 82 / 112 / 171 ms). The
  cap still bounds that path as defence in depth, but it is no longer the only
  thing standing there.

  Read the advisory's structured fields, not its title: the record is titled
  "CVE-2026-59870 fix not backported" while its own `patched_versions` says
  `>=3.15.1`. The title is why an earlier revision of this entry claimed the fix
  existed only in 5.x. Note also that `pnpm update` will not move a transitive the
  lockfile already considers satisfied — the override is what moves it.

  The **comment-stripper** path is not an upgrade away: it is gray-matter's own
  code, and the bound is the only mitigation for it.

  Sized against the real vault this server was built for — 2,381 notes,
  frontmatter median 225 B, p99 501 B, max 1,042 B — so 8 KiB keeps ~7.9x
  headroom over the largest note that exists while holding the attack to ~41 ms —
  measured on the _unterminated_ shape, which is the worst case and ~1.8x costlier
  than the terminated one at the same size.
  Over-cap frontmatter fails **loudly**: the read path logs it and indexes the
  note body-only (exactly like any other malformed frontmatter), and the write
  paths refuse rather than dropping metadata.

  **Behaviour change:** a note carrying kilobytes of `source_refs` in its
  frontmatter is now refused. The test suite previously pinned a session-archive
  index with 900 `source_refs` — 66.2 KiB of frontmatter — as legitimate. No such
  note exists in the vault, and a hostile block that size costs ~3 s, so the cap
  is kept and that shape is now pinned as refused. Frontmatter carrying kilobytes
  of references is the design to revisit, not the limit.

  Reverse-verified: with the cap removed, the unterminated-block test takes
  **177 seconds** instead of failing under its 1-second assertion.

- **A production advisory now fails CI.** The dependency audit was a single
  non-blocking step, on the stated theory that "real triage happens in the
  Dependabot PR". That theory did not survive contact with the js-yaml advisory
  above: Dependabot alerts were enabled but reported **0 open alerts**, and
  `dependabot.yml`'s `updates:` bumps _direct_ dependencies while js-yaml is
  transitive — so no PR was raised there either. `pnpm audit` was the only
  detector, and it was configured to be invisible.

  CI now runs `pnpm audit --prod --audit-level high` as a **blocking** step, with
  the previous full-tree `--audit-level moderate` retained as the non-blocking
  one. Scoping the blocking step to `--prod` keeps dev-only noise out of it, which
  is how the single step stopped being read in the first place.

  Reverse-verified: with js-yaml reverted to 3.15.0, the blocking step exits 1 and
  names `.>gray-matter>js-yaml`; with 3.15.1 it reports no vulnerabilities.

- **A note's frontmatter `id` could impersonate any other document, and no
  longer can.** `readDocument` takes `document.id` verbatim from the file's own
  frontmatter — untrusted vault content — and `fetch()` matched that id _before_
  the vault-relative path, with no uniqueness check. A single note declaring
  another note's server-generated uuid, or another note's path, therefore
  answered every lookup aimed at that other note: `fetch_document`, the ChatGPT
  `fetch` alias, `trace_sources`, and the target `plan_document_update` resolves
  before staging its edit.

  That last one is the sharp end: **two-step approval protects the approved
  content, never the approved target**, so a diff the user reviewed and approved
  landed on the impostor file. Documents this server created are the most
  hijackable, because `create_document` / `plan_document_create` stamp a
  `crypto.randomUUID()` — their own path is never claimed by their own id, so a
  squatter is the _only_ id match and wins regardless of scan order.

  `fetch` now resolves a reference only when it names exactly one document
  across the id and path namespaces, at **both** `KnowledgeStore.fetch` and
  `MultiRootStore.fetch`; an ambiguous reference fails closed.

  **Not path-first.** Resolving the path first would silently return a different
  document than the citation carrying that id pointed at — the mis-routing the
  composite's id-first match exists to prevent (a vault note with
  `id: "ops:secret"`, where `ops` also names a root). The error names the
  colliding documents by relative path so a genuine duplicate is fixable.

  **Refusing does cost reachability, and the error says so.** An earlier draft of
  this entry claimed "the exact vault-relative path is the one handle no file's
  content can claim". That is false, and the test suite proves it: a frontmatter
  `id` CAN be a vault-relative path, and claiming one is the primary attack
  shape. A victim that carries its own uuid stays reachable by that uuid, but a
  note carrying **no** frontmatter `id` has exactly one handle — its path, since
  its id _is_ its path — and a squatter claiming that path leaves it with no
  reference at all. Both cases are pinned. The error therefore does not tell the
  caller to retry with the exact path (that retry lands on the same collision);
  it says the reference cannot be disambiguated and the duplicate `id` has to go.

  **Two guards, because one is not evidence for the other.** A squatter in the
  primary root shadows documents in the read-only roots, and that collision is
  visible only to the composite. One test drives both stores; removing either
  call site alone was measured to turn its own scenarios red while the other
  store stays green.

  **Behaviour change, stated plainly:** one planted file now makes its victim
  unfetchable as well, so this converts a silent content swap into a loud denial
  of service. `fetch("ops:secret")` in a multi-root vault where a note carries
  that id and an `ops` root holds `secret.md` used to return the note; it now
  refuses and names both. Both remain reachable by exact path.

- **`pnpm run check:http` had verified nothing since the endpoint became
  sessionless; it does again.** The script read the `mcp-session-id` response
  header and threw when it was absent. Sessions were removed from `/mcp` in this
  same unreleased line — `createMcpHandler` with `legacy: 'stateless'` serves
  both protocol eras per request and neither issues that header — so the
  operator health check failed against every healthy server.

  That failure was not fail-safe. The script is the operator-side guard for "the
  live tool surface is not WIDER than the `MCP_HTTP_ALLOW_*` flags declare", and
  the throw happened _before_ that comparison, so the surface check never ran at
  all. A genuine widening would have been reported with the same red FAIL line
  operators had already learned to ignore. The header is now read so a peer that
  still sets one keeps working, and never required.

  `operations.md` §9 was corrected for exactly this drift when sessions were
  removed; its scripted twin was missed. A test now spawns the real script
  against the real endpoint and asserts that the surface comparison itself ran,
  so the two cannot diverge again.

- **The conservative cache hints on 2026-07-28 cacheable results are now pinned
  by a test (ROADMAP item 3).** The revision requires `ttlMs`/`cacheScope` on
  cacheable results, and the SDK fills them from a `cacheHints` option this
  server does not set — so `server/discover` and `tools/list` already go out as
  `ttlMs: 0` / `cacheScope: 'private'`. Nothing changed; what changed is that
  relaxing either value now fails a test.

  Both are load-bearing. `cacheScope: 'public'` would let a shared cache serve
  one principal's listing to another, which is exactly the leak "not registered,
  so not discoverable" exists to prevent — the tool surface is per-scope
  (INV-6/INV-7). And a non-zero `ttlMs` is unsafe **even at `private`**: the
  previous release made the surface follow the _token_, while a private cache is
  keyed by the _client_, so one client swapping bearers would be served the
  previous token's tool list. `CacheHint` carries `ttlMs` and `cacheScope` and
  nothing else, so there is no way to put the token in the key — which leaves
  `ttlMs: 0` as the only safe value rather than one option among several.

  The roadmap item said to use "a private cache scope, or a key that includes the
  effective scope and the enabled surfaces". The second option does not exist,
  and the first is insufficient on its own; both corrections are recorded there.

- **A registered `redirect_uri` can no longer name one host and resolve to
  another, and the consent page now says where approving sends the code.** The
  page asked for a password while naming neither the client nor the destination,
  so the only thing an operator could act on was that a page had appeared. Two
  separate problems had to be fixed together for a destination line to be worth
  adding.

  First, the WHATWG URL parser _removes_ tab, CR and LF from anywhere in its
  input instead of failing, so `https://claude.ai<TAB>.evil.example/cb`
  registers as a string that reads as `claude.ai` and resolves to
  `claude.ai.evil.example`. `isAllowedRedirectUri` now refuses control
  characters before parsing. Second — and this is why the fix is not "reject
  anything that is not already normalized" — userinfo round-trips byte for byte:
  `new URL("https://claude.ai@evil.example/cb").href` equals its input while the
  host is `evil.example`, so a normalization check passes it. Userinfo is now
  refused outright; it has no legitimate use in a redirect target. Registrations
  that are merely un-normalized (an explicit `:443`, a mixed-case host) are still
  accepted, because neither moves the host, and a rule that rejected them would
  reject ordinary client registrations for no security gain.

  The consent page states the destination as an **origin derived from the same
  `new URL(...)` that `authorizePost` builds its 302 from**, so the sentence and
  the navigation are one fact rather than two kept in step by hand. The client
  name is shown when the client supplied one, labelled as self-asserted and
  unverified — it comes from the registration request, so it is a recognition
  aid, never an authorization input (see the `client_id` appendix in
  [`docs/ROADMAP.md`](./docs/ROADMAP.md)). Granted scope is deliberately still
  not shown: `vault.read` is not enforced on the read tools today, so a scope
  line would state a restriction the server does not apply. That line lands with
  the per-request scope resolution (ROADMAP item 2b), which is what makes it
  true. Pinned by `tests/oauth.test.ts`, including a non-regression case holding
  the callback shapes real connectors register.

- **`MCP_SKILLS_SUBDIR` overlapping `projects/` is refused at boot.** The Skills
  subtree is reserved against the general write surface, and `create_document`
  always writes under `projects/`, so an overlap left every create failing the
  reservation — the create root dead for as long as the setting stood, and
  failing per-call in a place that does not explain why. `loadConfig` now
  rejects it at startup, matching the check `MCP_AUDIT_SUBDIR` already gets
  (INV-8 / INV-9 have the same disjointness requirement). Pinned by
  `tests/skillStore.test.ts`.

- **The default two-step plan-state directory no longer follows the caller's
  working directory.** A plan holds vault plaintext — the pre-edit text and the
  full proposed text — until it is applied. Unset, `MCP_PATCH_STATE_DIR`
  defaulted to `.mcp-state/patches`, which `path.resolve` interprets against the
  process working directory; for a client-spawned stdio server the client
  chooses that directory, so the plaintext landed wherever the caller pointed.
  The previous release closed the matching hole for env files (the server stopped
  reading `.env` from its working directory) and named this as the remaining
  follow-up. The default is now `~/.mcp-state/patches-<hash>`, where the hash
  derives from the vault's own path.

  The home directory is an anchor, not a guarantee: `os.homedir()` returns `""`
  when HOME is empty with no passwd entry to fall back on, returns HOME verbatim
  when HOME is relative, and throws outright when neither resolves at all (a
  container running as a numeric UID with no `/etc/passwd` row). The first two
  would make `path.join` produce a relative string that `path.resolve` re-anchors
  to the working directory —
  reinstating the very placement this default exists to prevent, and doing so
  precisely in the environments that strip HOME (service accounts, and the
  `--clearenv` bwrap recipe in [`operations.md`](./docs/operations.md#6-sandboxing-the-local-stdio-server-bwrap-optional)).
  When no absolute home is available the server therefore **refuses to start**
  and names the setting to configure, instead of quietly writing plaintext
  somewhere else. An explicit `MCP_PATCH_STATE_DIR` is still honoured exactly as
  before, including a relative one and including on a host with no home
  directory — overriding the setting is deliberate in a way that inheriting a
  default is not. Pinned by `tests/config.test.ts`, which asserts the default is
  unchanged across a `chdir` and that an unusable home fails closed.

  **Migration.** Deployments that set `MCP_PATCH_STATE_DIR` are unaffected; the
  documented systemd and launchd units already set it. If you relied on the
  relative default, plans staged before the upgrade stay in the old location and
  are not migrated — `apply_planned_update` will report an unknown `patch_id`
  for them. Re-run the `plan_*` call, or set `MCP_PATCH_STATE_DIR` to the old
  path. Nothing is deleted.

- **The session-archive hook no longer resolves an ambiguous vault scan, so the
  push target for a full transcript cannot be claimed by planting a directory.**
  `archive-session.sh` locates the private vault clone from `$SESSION_VAULT_REPO`
  or, failing that, by scanning `$HOME/*/` for a `.claude-session-vault` marker
  next to a `.git`. It took the **first** hit, and that scan decides where the
  entire session transcript — every user message, assistant reply, tool call and
  tool result — is committed and pushed. Anyone able to drop a marked git clone
  under `$HOME` therefore only had to win the lexical glob order to receive every
  future session; a directory named ahead of the real vault, with `origin`
  pointing anywhere, was the whole exploit. Measured against the unpatched
  script: the planted remote received the transcript (canary included) and the
  legitimate vault received nothing.

  The scan now resolves **only when it finds exactly one candidate** and
  otherwise archives nothing, which is the same no-op the "no vault found" case
  already took. `$SESSION_VAULT_REPO` still wins outright, so a host that
  genuinely holds two vault clones names the one it means — verified to still
  archive correctly with two candidates present. Two or more candidates and no
  env print a one-line count to stderr: silence here would be indistinguishable
  from a working archive that quietly stopped writing, and the count is what the
  operator acts on. The candidate paths are deliberately **not** printed — this
  script ships byte-identical in this public repo, and those paths are the vault
  location.

  Rejected as too broad: refusing an `origin` that carries several push URLs
  (breaks legitimate mirrors) and pinning one vault+origin pair per machine
  (locks out a second legitimate vault until a pin file is removed). Neither is
  needed to close the exploit.

- **Front matter that expands exponentially when serialized is refused instead
  of materialized.** js-yaml resolves an alias (`*a`) as a _shared reference_,
  so a few hundred bytes of nested anchors parse in microseconds while
  describing a tree with millions of leaves. Nothing pays for that until
  something walks the value as a tree — `String()` in `toStringArray`, or
  `JSON.stringify` of a fetched document — at which point the single-threaded
  event loop blocks while allocating toward the V8 max-string limit, which on a
  memory-capped host is a fatal heap OOM rather than a caught error. A ~500-byte
  block measured a 79 MB `JSON.stringify` and killed a 256 MB child process.

  Both halves were reachable. Under `tags` / `source_refs` / `client` /
  `project` the expansion happened on the always-on scan path, so the first
  `search_documents` / `list_projects` / `trace_sources` after the file appeared
  paid it. Under any other key it survived `normalizeMetadata` untouched into
  the returned document, so **every** `fetch_document` re-ran it. Vault content
  is untrusted, and an `append_audit_report` body is arbitrary client text that
  later scans walk, so this was reachable even on a scan-only deployment with
  general writes off.

  `parseMarkdown` now walks the parsed value the way a stringifier does —
  revisiting a shared node once per reference, which _is_ the expansion — with
  an explicit stack, and throws once the accumulated size passes a budget of
  `max(64 KiB, frontmatter source length × 16)`. Work is bounded by the budget,
  never by the expansion, and a cycle terminates because every visit adds at
  least one byte. Throwing lets `parseMarkdownSafe` degrade that note exactly
  like any other malformed front matter (empty metadata, raw body, `parseError`),
  so one hostile note still cannot abort a vault scan.

  **The budget is derived from `raw`, deliberately not from `parsed.matter`.**
  gray-matter defines that property as non-enumerable and its content-keyed
  cache returns `Object.assign({}, cached)`, which drops non-enumerable
  properties — so it is `undefined` on every repeat parse of content the process
  has already seen. A budget read from it collapses to the floor on the second
  read of a note, or on a second byte-identical note, and silently strips the
  metadata off large but perfectly legitimate front matter: a session-archive
  index with 900 `source_refs` lost its `id`, `client` and tags and fell back to
  a path-derived id. Reading `raw` keeps the budget identical on the first parse
  and every repeat.

  Measured amplification of legitimate front matter under this accounting:
  0.98× for that 900-`source_refs` index, 0.84× for a 5000-entry block tag list,
  2.0× for the worst legitimate shape (flow-style one-character tags) and 4.3×
  for an all-`!!timestamp` block — at least 3.7× headroom under the 16×
  multiplier, and the 64 KiB floor covers everything small. A 28-shape battery
  covering deep nesting, block scalars, `!!binary`, `!!set`, `!!omap`, merge
  keys, CRLF, BOM and CJK found nothing legitimate that trips it.

  **A scalar is charged what `JSON.stringify` emits for it, not its length in
  memory.** Charging the length is not merely loose, it is wrong in the
  attacker's favour: a control character costs two characters to write in YAML
  (`\0`) and six to serialize (`\u0000`), so a 16× budget bought ~32 references
  charged at 1 and emitted at 6 — an output of ~96× the source. Measured on that
  accounting, an 800 KB front-matter block passed the guard and produced a 62 MB
  `JSON.stringify`, which is the same heap OOM the guard exists to prevent, only
  bought with a larger file. The escaped size is now counted, with the scan
  bailing out as soon as the running total passes the budget so the walk stays
  proportional to the budget. The amplification figures above are unchanged by
  this: every string in every one of those shapes is escape-free, so it is
  charged `length + 2` either way.

  Incidentally this also fixes a pre-existing crash: a recursive anchor
  (`a: &a [*a]`) produced a genuinely circular object that made `fetch_document`
  throw `TypeError: Converting circular structure to JSON`, leaving the note
  unfetchable. It now degrades instead.

- **The server no longer reads a `.env` from its working directory.**
  ⚠️ **Action required before restarting — see the migration below.**

  `dotenv.config()` ran at import time with no path, so it read `.env` from
  `process.cwd()` and injected every key not already in the real environment.
  For the documented stdio deployment the MCP client spawns the server with only
  `KNOWLEDGE_ROOT` in `env`, which means **the working directory is whatever
  project the user happened to open** — untrusted ground. A committed `.env` in
  a cloned repository could therefore set `MCP_TRANSPORT=http`,
  `MCP_HTTP_HOST=0.0.0.0`, `MCP_HTTP_ALLOW_WRITE=1` and an attacker-known
  `MCP_AUTH_TOKEN`, turning a local read-only vault server into a network
  listener whose bearer secret the attacker chose. It could equally set
  `KNOWLEDGE_ROOTS`, which outranks the operator's `KNOWLEDGE_ROOT`. The
  DNS-rebinding allowlist is no barrier to a non-browser client, which sends any
  `Host` it likes — and the same file could set `MCP_HTTP_ALLOWED_HOSTS` anyway.

  An env file is now read **only** from an absolute path named by `MCP_ENV_FILE`
  in the real process environment, loaded once at startup rather than as an
  import-time side effect. There is no working-directory fallback. A relative or
  unreadable `MCP_ENV_FILE` fails at startup. Parsing and precedence are
  unchanged — the same `dotenv.parse`, so quoting, multi-line values, `export `
  prefixes, comments and BOM behave identically, and a value already in the real
  environment still wins over the file. Removing the `dotenv.config()` call also
  removes a banner it wrote to **stdout**, which on the stdio transport is the
  JSON-RPC channel.

  **Migration — do step 1 before deploying.** A supervised endpoint that keeps
  its configuration in `.env` will not start after this change; under `KeepAlive`
  it crash-loops, and `StandardErrorPath` will show
  `KNOWLEDGE_ROOT (or KNOWLEDGE_ROOTS) is required`.

  1. Add `MCP_ENV_FILE` with the **absolute** path of that endpoint's `.env` to
     each launchd plist's `EnvironmentVariables` dict (systemd users already pass
     the real environment via `Environment=` / `EnvironmentFile=` and need no
     change). This step is a no-op under the current binary, so it is safe to do
     first.
  2. Deploy, then **reload** each plist — `launchctl bootout gui/$(id -u)/<label>`
     followed by `launchctl bootstrap gui/$(id -u) <plist>`.
     `launchctl kickstart -k` restarts the process **without** re-reading the
     plist, so the key stays in the file, never reaches the job, and the endpoint
     crash-loops with the error above.
  3. Confirm it reached the running job —
     `launchctl print gui/$(id -u)/<label> | grep MCP_ENV_FILE` — then verify
     with `pnpm run check:http`.

  Point each endpoint at **its own** file. Migrating fully restores previous
  behaviour, including the `MCP_AUDIT_SUBDIR` matching invariant between the two
  endpoints.

  **A second thing to check, which does _not_ fail loudly.** A write-capable
  process that receives `KNOWLEDGE_ROOT` from its MCP client registration but
  took `MCP_AUDIT_SUBDIR` / `MCP_SKILLS_SUBDIR` from the working-directory `.env`
  will now start **normally with writes on and those subtree reservations off** —
  `assertNotAuditReserved` returns immediately when the subdir is unset. Every
  write-capable process must now carry those values in its real environment or
  its own `MCP_ENV_FILE`. To make the state observable, the stdio branch now
  prints its effective surface on stderr, e.g.
  `MCP stdio transport ready (write=on, documents=on, skills=off, audit=off)`,
  mirroring what the HTTP branch already did. stdout stays pure JSON-RPC.

- **Two-step plan files are written owner-only.** A plan holds the pre-edit text
  (inside its diff) and the full proposed text of a private note, so
  `MCP_PATCH_STATE_DIR` is the one place vault plaintext is copied outside the
  vault — and it was the only state store in the repo written without a mode:
  files landed at `0644` inside a `0755` directory under the usual umask, so any
  other local account could read staged note plaintext without ever
  authenticating to the MCP endpoint. Plans are only unlinked on a successful
  apply, so abandoned ones accumulate.

  The repository also contradicted itself here: `SkillStore` created that same
  directory with `mode: 0o700` while `KnowledgeStore` created it with no mode,
  and `KnowledgeStore.init()` runs first — so the permissive mode won. Both now
  go through one helper (`src/patchState.ts`) that creates the directory `0700`
  and writes plan files `0600`.

  Because `fs.mkdir` does not chmod a directory that already exists, init also
  tightens a directory left permissive by an earlier version. That is done
  through a single descriptor opened `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`, so the
  check and the change cannot be split by a swap; it is never recursive and never
  touches a parent. The whole permission triad is compared rather than only the
  group/other bits, because a directory left at `0500` clears `& 0o077` yet
  denies the owner the write permission every plan write needs.

  If the chmod fails — another owner, a filesystem without POSIX modes — the
  server warns on stderr and continues rather than refusing to start: the `0600`
  file mode is the primary control and does not depend on it, so failing start
  would turn a safe server into an outage. The warning names the environment
  variable only, never the resolved path.

  **A symlinked directory is the one case that fails closed instead.**
  `O_NOFOLLOW` surfaces it as `ELOOP`/`ENOTDIR`, and `fs.mkdir(recursive)`
  follows such a link happily, so this is where it is caught. Warning past it
  would be unsound: plan files would be written through the link into a directory
  another account owns, and `0600` on the files is no defence there, because
  unlink and rename are governed by the **directory's** permissions — that
  account could swap a staged plan for one carrying different content and a
  matching `content_sha256`, which is precisely the approve-this-exact-diff
  guarantee (INV-3) the two-step write exists to provide.

  **Operational note:** a deployment where processes under different UIDs share
  one `MCP_PATCH_STATE_DIR` stops working. Every documented deployment is single
  -UID, and under the default umask a second UID could not have written there
  anyway.

- **The general document-write surface can no longer reach the Skills subtree**
  (INV-8). `SECURITY.md`, the README and `CLAUDE.md` all stated that existing
  Skills are immutable, but the only subtree reservation on the write path
  checked `MCP_AUDIT_SUBDIR`; `StoreConfig` never received `skillsSubdir` at
  all. A `SKILL.md` under `MCP_SKILLS_SUBDIR` was therefore an ordinary indexed
  document that `plan_document_update` → `apply_planned_update` could rewrite
  wholesale — and Skills are loaded as _instructions_ by later agent sessions,
  so "edit a note" was a route to persistent agent-instruction injection. The
  same gap let exact-path create plant a new Skill bundle bypassing
  `SkillStore`'s name pattern, file allowlist and size caps. Notably
  `MCP_HTTP_ALLOW_SKILL_WRITE` did not need to be on: the general
  `MCP_HTTP_ALLOW_WRITE` surface was enough.

  The Skills subtree now carries the same reservation the audit subtree has
  (INV-9), at the same choke points — `planUpdate`, `applyPlannedUpdate` (the
  authoritative one, immediately before the write), both points in
  `resolveForWrite`, and `validateCreateTarget` — using the same lexical plus
  `realpath` comparison, so symlink, NFD and case-variant spellings are covered
  rather than only the client's literal string. `validateCreateTarget` checks the
  _resolved_ target, since its parent walk has already replaced every existing
  parent with its realpath; that also closes the same gap on the **audit** side,
  where a create aimed at a symlink alias of the reserved subtree used to plan
  successfully and only fail at apply, persisting a patch that could never be
  applied. Reads are untouched: Skills stay
  searchable, fetchable and indexed. The constrained `plan_skill_create` /
  `apply_planned_skill_create` surface is unaffected, because `SkillStore` does
  not go through `KnowledgeStore`.

  **Operating condition, same as INV-9's:** the reservation only holds in a
  process that actually sets `MCP_SKILLS_SUBDIR`. Every process that can write
  the vault — the interactive HTTP endpoint _and_ any local stdio server — must
  set the same value, or a Skill remains editable through the one that does not.

  The gate is inert when `MCP_SKILLS_SUBDIR` is unset, so nothing changes for
  operators who do not configure Skills. Note that `MCP_AUDIT_SUBDIR` has a
  boot-time assert that it is disjoint from `projects/`, and the Skills subdir
  does not: pointing `MCP_SKILLS_SUBDIR` at `projects/` or an ancestor would
  make every `create_document` fail at runtime with a self-describing error
  rather than at startup. Every documented value is disjoint, and adding the
  assert now would turn a currently-bootable server into one that refuses to
  start, so it is left as a follow-up.

- **Link extraction is linear in body length, so one poisoned note can no
  longer stall every `trace_sources` call.** Both patterns in
  `src/markdownLinks.ts` used negated character classes that accepted the
  pattern's own opening delimiter, so on unterminated input the engine walked
  the tail and threw the work away at every `[` — quadratic, and run over every
  document in the vault on every call. A ~1 MiB body of `[x](` repeated
  extrapolates to roughly 9–15 minutes of blocked event loop; measured at 200k
  characters the base takes 4.6–31.7 s where the replacement takes 0.0–2.3 ms.
  Both extractors are now forward-only `indexOf` scans.

  Recall is unchanged, which matters because `trace_sources` output is derived
  from these functions and the relative-link resolution they feed was itself a
  bug fixed in the P0 slice. Rather than tightening the character classes —
  which would silently drop `[a[b](t)` and `[[[[a]]`, both of which match today
  — the accepted language is preserved exactly and pinned by keeping the
  original regexes in the test file as a reference implementation: the new
  scanners are asserted equal to them over a named corpus, every synthetic
  fixture, seeded random bodies, and an exhaustive sweep of the delimiter
  alphabet. `resolveRelativeLink` is untouched.

- **Front matter is no longer parsed with an engine the document itself
  selects.** `gray-matter` picks its parser from the language tag on the opening
  delimiter (`---js`), and its `javascript` engine's `parse` is a raw `eval()`.
  Vault content is untrusted by design, so a single planted note executed
  arbitrary code inside the server on the always-on read path — every
  `search_documents` / `fetch_document` / `list_projects` / `trace_sources` call
  walks and parses every file. The same engine was reachable from the write
  side: `matter.stringify` re-parses a string argument before serializing, so a
  client-supplied `body` / `new_body` was evaluated during the `plan_*` step,
  which is advertised as non-mutating and therefore precedes any user approval.
  Both call sites, and the one in `src/skillStore.ts`, now pass a hardened
  options object that replaces the `javascript` and `js` engines with a thrower.
  Note that `engines` is **merged** over gray-matter's defaults rather than
  replacing them, so an allowlist of `{ yaml, json }` would leave the dangerous
  engine in place; and `matter.stringify` runs the payload _before_ it throws
  "stringifying JavaScript is not supported", so asserting that an error was
  raised does not prove non-execution. The tests assert non-execution directly,
  via a `globalThis` marker that must stay undefined.

- **A document body can no longer inject keys into the front matter it is
  written with** (INV-2). Because `matter.stringify` re-parsed its string
  argument, a leading `---` YAML block in a client-supplied body was merged into
  the emitted front matter, bypassing `assertFrontmatterPatch` — the only
  server-side field allowlist. `serializeMarkdown` now passes an explicit file
  object so the body is opaque. What decided the merge was not whether a key is
  server-managed but whether the serializer writes it at all: every key present
  in the metadata argument won, so the server-managed `id` and `updated_at` held
  and document identity was never forgeable. (`title` won too, but it is not
  server-managed — it is one of the five keys an approved `frontmatter_patch`
  may set.) What did get through was keys the serializer does not write, such as
  `date:`, which silently changes search ranking through `effectiveTimestamp`.

  A body that begins with a `---` YAML block is now preserved verbatim in the
  body instead of being absorbed into the front matter. Bodies that do not begin
  with `---` serialize byte-identically to before.

- **`vault.read` is enforced, and the HTTP tool surface is now resolved from the
  token presented on every single request.** Two changes that had to land
  together ([ROADMAP item 2b](./docs/ROADMAP.md)).

  Sessions are gone from the endpoint: one handler serves 2026-07-28 natively and
  2025 through the stateless legacy fallback, so each request of either era gets
  a fresh instance from the same factory. Under the session model, requests were
  routed by `Mcp-Session-Id` **alone** and the presenting principal was never
  re-checked — a connection opened with a write-scoped token kept the write
  surface for its lifetime no matter what token later requests carried. The
  regression test is written as exactly that scenario (one client, one
  connection, the bearer swapped underneath it), because the obvious test — two
  clients with two tokens see two surfaces — passed under the session model too
  and would have proved nothing.

  `vault.read` was not enforced at all. Only the write surfaces consulted the
  token's scopes; the read tools were registered unconditionally and
  `{scopes: []}` is non-null, so a token carrying **no** scope authenticated and
  read the entire vault. That state is reachable without anything going wrong:
  `grantScope` returns requested ∩ grantable and deliberately refuses to
  substitute read for a scope never requested, so a client asking only for
  `vault.write` while writes are off is granted nothing. It was never an
  authentication hole — issuing that token still required the login password —
  but it was the read half of INV-7 item 5 missing.

  Such a request is now **refused** with `403` and the RFC 6750 §3.1
  `insufficient_scope` challenge naming the missing scope, rather than served an
  empty tool list: the challenge is what lets a client re-authorize for the scope
  it lacks, while an empty `200` is indistinguishable from an empty vault and
  sends the operator looking in the wrong place. `surfaceFor` independently
  refuses to build a surface for a principal without read, so a future path that
  bypasses the gate fails closed instead of quietly restoring the hole.

  **The consent page now states the granted scope**, which the previous release
  deliberately withheld — while `vault.read` was unenforced, a scope line would
  have described a restriction the server did not apply. It shows the grant
  (requested ∩ grantable) rather than the request, and says plainly when the
  grant is empty that approving would issue a token which cannot read anything.

  Operationally this also removes the last of the three "the connection dropped"
  causes: there is no session id left to invalidate on restart, so a supervisor
  restart no longer answers `404 unknown_session` until the client
  re-initializes. A restart still drops in-flight requests.

### Added

- **The HTTP endpoint now serves both MCP protocol eras at once** — the 2025
  family and 2026-07-28 — on the new `@modelcontextprotocol/server` v2 package
  line (which pins `@modelcontextprotocol/core` v2 exactly, so it is not
  declared separately)
  ([ROADMAP item 2a](./docs/ROADMAP.md)). Adopted for restart transparency, not
  speed: the 2026-07-28 revision has no `initialize` handshake and no
  `Mcp-Session-Id`, which removes the "connection dropped" cause that a named
  tunnel and `MCP_OAUTH_STATE_FILE` do not address — MCP sessions live in
  process memory, so every restart answers `404 unknown_session` until the
  client re-initializes. Nothing else about that failure changes: a restart
  still drops in-flight requests.

  2025-era traffic keeps the **established sessionful wiring** rather than
  moving to `createMcpHandler`'s stateless legacy default. That default would
  have taken the session model out from under the existing era in the same
  change as the dependency bump; instead `src/httpServer.ts` classifies with
  `isLegacyRequest` — the entry's own classification step, exported as a
  predicate, so the branch cannot disagree with what the handler would have
  decided — and routes 2025 traffic to a sessionful transport as before. Every
  pre-existing HTTP and OAuth boundary test passes **unmodified**, which is the
  claim that the security boundary did not move here. Moving the whole endpoint
  off sessions, and the accompanying re-pin, is ROADMAP item 2b.

  The 2026-07-28 leg has no sessions to resolve scope against, so it resolves
  per request. Both eras call one `surfaceFor(principal, …)`, so the
  scope→tool-surface derivation (INV-6 item 4 / INV-7 item 5) stays a single
  function rather than becoming two. The per-request factory recovers its
  principal from the exact `Request` the endpoint authenticated and **throws if
  it cannot**: there is no default surface to fall back to, because that default
  would be the full one. Pinned by tests that drive a real 2025 client and a
  real 2026-07-28 client against one endpoint and assert the same tool list, no
  session id on the modern leg, and that read-only default, `401`, and the
  DNS-rebinding `403` all still apply to modern requests. The scope gate has its
  own pin in `tests/oauth.test.ts`: a `vault.read` token and a
  `vault.read vault.write` token, back to back against one endpoint on the
  modern era, see two different tool sets — and the read-scoped one still sees
  no write tools afterwards, so the surface follows the presented token rather
  than the first one seen.

  `src/index.ts` (stdio) moves to the v2 `StdioServerTransport` as part of the
  package swap; it still serves one 2025-era instance per connection. Dual-era
  stdio via `serveStdio()` is ROADMAP item 2c.

### Changed

- **DNS-rebinding protection moved off the deprecated transport options to the
  endpoint boundary**, ahead of protocol-era routing, so one check covers both
  eras identically. It had to move: `createMcpHandler` exposes no equivalent
  option, so the modern leg would otherwise have been unprotected. The
  behaviour-pinning tests added earlier are unchanged across the move — same
  requests, same verdicts, different mechanism.

  Two decisions this forced, both recorded in
  [`docs/ROADMAP.md`](./docs/ROADMAP.md):

  - **`MCP_HTTP_ALLOWED_HOSTS` is now compared by hostname, ignoring any
    `:port` suffix** (D-M3A-HOST-PORT). The SDK's `validateHostHeader` is
    port-agnostic; rather than break the env contract, entries are normalized at
    the boundary, so existing `host:port` values keep working and a bare
    hostname now works too. The port was never a useful discriminator — the
    server listens on exactly one port, which is therefore the only port a
    browser could reach it on whatever the allowlist says. A bare IPv6 literal
    is bracketed rather than truncated at its first colon, which would have
    produced an empty, unmatchable entry (and `loadHttpConfig` now brackets an
    IPv6 bind host when building the default for the same reason).
  - **A `Host` header carrying userinfo is refused outright**
    (D-M3A-HOST-USERINFO). Comparing hostnames would accept
    `evil.example@127.0.0.1`, which parses to `127.0.0.1` while naming another
    authority; `Host` has no userinfo field (RFC 9110 §7.2), so no client sends
    one and refusing it costs nothing. Before the check such a request passed
    the allowlist and returned **500** — `new Request()` refusing a URL that
    carries credentials, which is the Fetch spec declining to build an object
    rather than this server declining to serve a request.
  - **`MCP_HTTP_ALLOWED_ORIGINS` keeps exact full-origin comparison, scheme
    included** (D-M3A-ORIGIN-EXACT). The SDK's `validateOriginHeader` is
    hostname-only like its Host counterpart, which for origins would stop
    distinguishing `https://x` from `http://x` — a real relaxation with no
    compensating benefit, so it was not adopted. The absent-`Origin`
    pass-through (D-M1-ORIGIN-ABSENT) and the `/mcp`-only scope of both checks
    are unchanged.

- `@modelcontextprotocol/sdk` v1 is no longer a runtime dependency. It stays as
  a **devDependency**, driving the 2025-era half of the negotiation test from a
  real v1 client rather than a simulation of one.
- **stdio now serves both protocol eras (ROADMAP 2c).** `src/index.ts` hands the
  connection to `serveStdio()` from `@modelcontextprotocol/server/stdio` instead
  of connecting one pre-built server to a `StdioServerTransport`. Before this, a
  local client could only open the 2025 handshake — the endpoint did not offer
  `server/discover` at all — so Claude Code / Codex / Claude Desktop are now free
  to negotiate 2026-07-28 against exactly the same tool factory. The surface is
  unchanged (stdio stays full read + write) and `MCP_ENV_FILE`, transport
  selection and the start-up stderr line are untouched.

  Two options are passed rather than defaulted, each for a measured reason:

  - `legacy: 'serve'` — dual-era serving is the point of the change, so a
    library default that later moved would silently turn 2025-era clients away.
    Flipping it to `'reject'` fails the 2025 leg with `-32022`, which is what
    makes the regression test meaningful rather than merely green.
  - `onerror` — `serveStdio` starts the wire in the background and **drops** the
    rejection when no handler is installed, where the previous
    `await server.connect(…)` would have crashed the process. Without a handler
    a transport that failed to start would leave the "ready" line as the only
    output. It reports the error **class only**: the same callback also receives
    runtime out-of-band errors whose messages can quote inbound bytes, and
    stderr is not a place to echo those. It is non-fatal by design, so malformed
    client input cannot kill the server.

  One instance is pinned per stdio connection, which is what the previous
  release removed from HTTP. The asymmetry is deliberate: on HTTP successive
  requests on one connection can present different bearer tokens, so the surface
  must be re-derived per request; stdio carries no principal at all
  (`serveStdio` never sets `ctx.authInfo`/`ctx.requestInfo`), the peer is the
  process that spawned the server, and the surface is a constant — pinned and
  per-request are observationally identical there. Both eras are driven
  end-to-end by real v1 and v2 clients against the **spawned real entrypoint**,
  so what is pinned is the shipped wiring; reverting the wiring fails both legs.

### Fixed

- **`pnpm typecheck` now covers `tests/`, which it never had.** `tsconfig.json`
  is the build config — its `rootDir` is `src` and it emits declarations — so
  its `include` names `src/**/*.ts` only, and no gate ever type-checked a test
  file. The suite had been constructing `HttpConfig` literals missing the
  required `allowAuditWrite` field at **seven** call sites, invisibly, because
  nothing looked. (They behaved correctly at runtime — a missing flag reads as
  `undefined`, which is falsy, which is the intended "audit surface off" — so
  only the type was wrong. That is exactly the class of error a type-checker is
  for, and exactly the class that goes unnoticed when it is not run.) A new
  `tsconfig.test.json` extends the build config with `noEmit` and adds
  `tests/`, and `typecheck` runs both. `pnpm build` output is unchanged: the
  build config is untouched.

- **The Web-to-Node response bridge honours backpressure.** `res.write`
  returning `false` means the socket buffer is full; the streaming loop read the
  next chunk regardless, so Node queued the pending chunks in memory. A
  held-open 2025-era SSE stream makes that reachable — an authenticated client
  that reads slowly without disconnecting grows the queue for the lifetime of
  the stream. The loop now awaits `drain` before the next read, and a
  disconnect during that wait releases it (once the socket is gone `drain`
  never fires, so waiting on it alone would hang the response instead).

- **The `ctx.requestInfo` identity assumption is now pinned by a test.** The
  modern leg recovers its principal by looking the request up in a `WeakMap`
  keyed by the exact `Request` handed to `fetch`; `McpRequestContext` documents
  that value as "the original HTTP request being served", but that is a
  property of the dependency, and `package.json` floats on a caret range with
  weekly Dependabot bumps. A minor release passing a copy would make every
  modern request fail closed with `unresolved_principal`. Pinning the dependency
  version instead would freeze security patches to buy a guarantee a test gives
  for free — the same trade the DNS-rebinding options already taught. The test
  drives real modern bytes captured off the wire, not a hand-shaped envelope.
- **The operations runbook no longer tells operators to reuse a session id that
  no longer exists.** `operations.md` §9 Step 5 documented a manual surface check
  that captured `mcp-session-id` from the handshake and sent it back on the
  `tools/list` call — a step the previous release's sessionless endpoint made
  impossible, left behind in the same change that removed sessions. The
  replacement sends `tools/list` as its own POST, and both it and the `405` on
  `GET`/`DELETE` (the 2025 session operations) are now asserted against the live
  endpoint, so the runbook cannot drift from the server it documents.
- **`operations.md` §1 now lists the third cause of "the connection dropped"**,
  written as resolved: process-memory MCP sessions returning `404
unknown_session` after a restart. A restart is transparent at the protocol
  layer now, and only the OAuth state in §1.B survives it. `context-engineering.md`
  likewise said the tool surface was built "per-session" and described the move
  to per-request in the future tense.

## [0.7.0] — 2026-08-03

### Security

- The OAuth authorization response now carries the RFC 9207 **`iss`**
  parameter, and the authorization-server metadata advertises
  `authorization_response_iss_parameter_supported: true` (MCP SEP-2468,
  authorization-server mix-up defense). Clients that validate `iss` — as the
  MCP spec requires — will now reject a code minted by a different issuer
  before redeeming it. Error paths are unchanged: they deliberately never
  redirect, so the success redirect remains the only response carrying `iss`.

- Force the transitive **`body-parser`** dependency to **`>= 2.3.0 < 3`** via a
  `pnpm.overrides` entry (patched floor, bounded to the express-compatible
  major), clearing GHSA/CVE-2026-12590 (a low-severity DoS where
  an invalid `limit` option silently disabled request-size enforcement). It
  reaches the tree only through `express` (pulled by `express-rate-limit`), and
  the server runs on a raw Node `http` listener — it never mounts express's
  `body-parser` middleware nor passes a caller-controlled `limit` — so the
  vulnerable path was not reachable; this is defense-in-depth that also makes
  `pnpm audit` clean. No source or runtime-behavior change.

### Added

- **Search P0 correctness slice** (first implementation slice of the
  [context-engineering proposal](./docs/context-engineering.md)):
  - **NFKC folding on the search path** (`src/searchText.ts`). Queries and note
    text are folded before matching, so `ＭＣＰ` matches `MCP`, half-width kana
    match full-width, a full-width space separates terms, and a decomposed (NFD)
    body — what macOS filesystems hand back — matches a composed query. This is
    deliberately separate from the NFC path normalization in `pathSafety.ts`,
    which is unchanged: path normalization must preserve identity, search
    normalization is intentionally lossy. Snippets are still sliced from the
    original text, so bodies are returned exactly as written.
  - **`offset` on `search_documents`**, plus `total_count` in the response (see
    _Changed_), giving real paging over ranked results.
  - **`modified_at`, `updated_at`, and `size_bytes` on each search result** —
    `size_bytes` in particular lets a caller notice that a hit is a
    megabyte-scale note before fetching it whole.
- **Search P1 quality slice** (second implementation slice of the
  [context-engineering proposal](./docs/context-engineering.md)). All of it is
  additive: with no new env set and no new parameter passed, ranking and output
  are byte-identical to the P0 slice above.
  - **CJK query segmentation** (`src/searchSegmenter.ts`). A query in a script
    that does not space its words is split into words via `Intl.Segmenter`
    (Node ships full ICU at this package's floor, so no dependency), with a
    character-bigram fallback for small-icu runtimes. `検索エンジン設計` now finds a
    note that says `検索エンジンの設計`, which one substring never could. Sub-terms
    are **added** to the whole token rather than replacing it, so an ASCII query
    tokenizes exactly as before, and a note carrying the phrase verbatim keeps a
    phrase bonus over one holding the pieces scattered. Lone hiragana (particles
    like `の`) are dropped — they occur in nearly every Japanese note and would
    add noise to all of them.
  - **Opt-in recency ranking** — `MCP_SEARCH_RECENCY_WEIGHT` (default **0**,
    i.e. off; 0.25 recommended) and `MCP_SEARCH_RECENCY_HALFLIFE_DAYS` (default
    30), overridable per request with `recency_weight`. The boost is
    **multiplicative**, so it re-orders notes that already matched and can never
    surface one that did not. Age comes from frontmatter `updated_at` / `date`
    before filesystem mtime, because `git clone` rewrites mtime and both the
    vault and the log repo are git-synced.
  - **New filters** on `search_documents`: `path_prefix` (matched against the
    on-disk path, without the `<root>:` prefix), `root`, and
    `updated_after` / `updated_before` ISO 8601 bounds. An unparseable date
    bound is rejected rather than silently ignored.
  - **`order`** — `relevance` / `recent` / `path`. Defaults preserve today's
    behavior: `relevance` with a query, `path` without one.
  - **Two-window snippets.** Up to two passages, chosen to cover distinct query
    terms and joined with `…`; a single window often lands on a passing
    mention while the passage that answers the query sits further down.
  - **`explain`** returns a per-signal `score_breakdown`
    (`title` / `path` / `tags` / `body` / `phrase` / `recency`) that sums to
    `score` — the instrument for tuning weights and measuring the round-trip
    KPI later.
  - **Derived-text cache.** The folded and whitespace-collapsed body is computed
    once when a file is parsed and carried on the cached document, invalidated
    by the same mtime+size signature as the parse. This removes the per-query
    fold of the whole corpus, which was the search path's dominant cost once
    megabyte-scale session archives are in the vault. It is internal: the public
    document projection is an allowlist, so it never reaches a client.
- **Context-engineering proposal (docs only, no runtime change)** —
  [`docs/context-engineering.md`](./docs/context-engineering.md), a
  survey-based design for evolving the read plane from "search API" to
  "context gateway": search correctness/quality slices (NFKC + CJK
  segmentation, recency, filters, pagination), a link-graph module with
  correct relative-link/wikilink resolution, a token-budgeted `get_context`,
  `get_project_state`, section-level `fetch_document`, and an explicit
  reject list (no vector DB / no in-server LLM / no new write surface).
  `docs/ROADMAP.md` gains the matching "Context engineering layer" section
  plus concretized "Search & retrieval UX" slices.
- **`pnpm run check:http` — authenticated two-endpoint surface check**
  (`scripts/check-http.mjs`). Runs the MCP handshake (`initialize` →
  `tools/list`) against each endpoint's local `/mcp` using the bearer read from
  that endpoint's `.env` (never printed), then verifies the live tool surface
  against the same file's `MCP_HTTP_ALLOW_*` flags. It **fails** (non-zero exit)
  when a surface is **wider** than declared — e.g. the unattended scan endpoint
  exposing a general document-write tool — so the interactive/scan separation
  (see `operations.md` §9) is checkable in one command; a surface narrower than
  declared is a warning, not a failure. Accepts repeated `--env <path>` and
  defaults to `./.env` (the interactive endpoint). Packaged under `files` so the
  helper ships with the module.

### Changed

- **BREAKING — `search_documents` returns a counted envelope.** The payload is
  now `{ results, total_count, offset, limit }` instead of a bare array
  (`structuredContent.data.results` rather than `structuredContent.data`).
  Callers that iterated the array directly must read `.results`. Rationale: a
  bare array cannot express "you are seeing 10 of 400", which is exactly what
  makes an agent re-query blindly. The ChatGPT-compatible `search` / `fetch`
  aliases are a frozen contract and are **unchanged**.
- **BREAKING — document responses no longer include `absolutePath`.**
  `fetch_document`, `create_document`, `apply_planned_document_create`, and
  `apply_planned_update` now return a projected document (`toPublicDocument` in
  `src/server.ts`) built from an explicit field allowlist, so the host
  filesystem layout — home directory, vault location — is no longer handed to
  every client. `id`, `relativePath`, `root`, `frontmatter`, `body`, `title`,
  and `stats` are unchanged, and those are what round-trip back into `fetch`.
  The ChatGPT `fetch` adapter never exposed the field.
- Pin the development Node version to **24.13.0** via a new `.node-version` file
  (fnm reads it and auto-switches on `cd`; nvm does not read `.node-version`
  natively — nvm users can run `nvm use "$(cat .node-version)"`), and extend the
  Node.js CI matrix to run the
  full gate on both **22.x** (the `engines` floor) and **24.x** (the pinned dev/
  runtime version). `engines` stays `>=22.12.0` — the server still supports Node
  22+, so this drops no runtime support; it only makes the recommended version
  explicit and keeps it under test alongside the floor.

### Fixed

- **`trace_sources` missed backlinks written as relative Markdown links.**
  Backlink matching compared link text literally against the target's
  vault-relative path, so `[plan](../../claude/planning/connector-plan.md)` —
  the ordinary way to link between folders — never matched. Links are now
  resolved against the linking note's own directory
  (`resolveRelativeLink` in `src/markdownLinks.ts`, applied in both the
  single-root and multi-root stores). Resolution is pure string math compared
  against already-enumerated documents: it never touches the filesystem, a link
  that climbs out of the vault resolves to nothing, and relative links are not
  matched across knowledge roots. Existing literal and wikilink matching is
  unchanged, so this only **adds** previously missing backlinks.
- The synthetic fixture's own cross-folder link was off by one directory level
  (`../` where the target needed `../../`), so it pointed at a path that does
  not exist. Corrected, and the off-by-one is now pinned as its own case — a
  link that climbs too few levels must not be snapped onto the intended target.

## [0.6.0] — 2026-07-18

### Added

- **Constrained audit write surface for an unattended vault scanner**
  (`MCP_AUDIT_SUBDIR` + `MCP_HTTP_ALLOW_AUDIT_WRITE`). A new, independently gated
  pair of tools — `append_audit_report` (create-only report at
  `reports/<run_id>.md`; identical content is an idempotent no-op, different
  content is rejected, existing reports are never overwritten) and
  `compare_and_swap_audit_state` (atomic, sha256 compare-and-swap of `state.md`)
  — lets a scan principal persist audit output into **one reserved vault
  subtree** without holding the general document-write tools. A dedicated
  read-only-plus-audit endpoint (general write off, `MCP_HTTP_ALLOW_AUDIT_WRITE=1`)
  therefore lets an unattended scanner write only audit files, removing the
  confused-deputy exposure of pointing a write-enabled connector at an
  unattended scan. General document writes (`create_document` /
  `plan_document_create` → `apply_planned_document_create` / `plan_document_update`
  → `apply_planned_update`) are separately **forbidden from the audit subtree**
  (INV-9 — audit-trail integrity), so an interactive session cannot forge or
  clobber audit files; audit operations are serialized in-process to keep the
  compare-and-swap race-free. Opt-in and off by default; unset it behaves
  exactly as before (`src/auditStore.ts`, `src/knowledgeStore.ts`,
  `src/config.ts`, `src/server.ts`, `src/httpServer.ts`, `src/index.ts`,
  `src/multiRootStore.ts`, `tests/auditStore.test.ts`,
  `tests/knowledgeStore.test.ts`, `tests/httpServer.test.ts`).
- **Exact-path Markdown creation through a two-step, path-confirmed flow.** New
  `plan_document_create` → `apply_planned_document_create` tools let a client
  create a note at an exact vault-relative `.md` path instead of routing it
  through `projects/<client>/<project>/`. Planning returns the complete-file
  diff and a structured Japanese confirmation question (`はい` plus free-text
  correction); apply requires the caller to echo the exact confirmed path.
  Planning never creates target directories, apply rechecks containment and
  staged-content integrity, and the final `wx` write remains create-only. The
  tools are primary-root-only under multi-root and share the existing document
  HTTP/OAuth write gate (`src/knowledgeStore.ts`, `src/multiRootStore.ts`,
  `src/server.ts`, `tests/knowledgeStore.test.ts`,
  `tests/multiRootStore.test.ts`, `tests/httpServer.test.ts`).

### Changed

- **Vault scans now open Markdown files with bounded concurrency.** A large
  vault (thousands of notes) previously opened every file at once during a
  search/`list_projects`, which could exhaust the process file-descriptor limit
  and surface — especially on iCloud/network-backed folders — as a transient
  `EAGAIN`/`EMFILE` (`Unknown system error -11`). The scan now fans out at most
  `MCP_SCAN_CONCURRENCY` files at a time (default 24), **retries only the
  transient resource-exhaustion codes** (`EAGAIN`/`EMFILE`/`ENFILE`) with
  exponential backoff + jitter, and **skips + logs** any note that fails for a
  non-transient reason (missing/permissions/containment) instead of aborting the
  whole scan (`src/knowledgeStore.ts`, `src/config.ts`, `tests/knowledgeStore.test.ts`).
- **OAuth registrations self-clean.** A client registration that holds no live
  access/refresh token is now pruned once it is older than a grace window
  (default 1h), so repeated connect/reconnect cycles no longer leave dead
  Dynamic-Client-Registration records lingering until the hard client cap. Tokens
  already self-expire; the grace window protects an in-flight registration that
  has not yet completed the token exchange (`src/oauth/store.ts`,
  `tests/oauth.test.ts`).
- **Create-parent handling rejects symlink components before making nested
  directories.** Both routed and exact-path document creates now walk parent
  components one at a time, rejecting symbolic links and non-directories before
  any deeper path can be created (`src/knowledgeStore.ts`,
  `tests/knowledgeStore.test.ts`).

## [0.5.0] — 2026-07-13

### Added

- **Optional OAuth session persistence across restarts**
  (`MCP_OAUTH_STATE_FILE`). By default OAuth state stays in process memory and
  a server restart forces every web client (ChatGPT / Claude.ai) to
  re-authorize; pointing `MCP_OAUTH_STATE_FILE` at a state file makes
  registered clients and tokens survive restarts. Access/refresh tokens are
  stored **as sha256 hashes** in memory and at rest (the file never contains a
  recoverable credential), the file is written atomically with mode `0600`, and
  it carries an **HMAC-SHA256 integrity tag keyed from `MCP_OAUTH_PASSWORD`**
  (scrypt-derived, per-file salt) — a tampered, corrupted, or password-rotated
  state file fails closed to empty state, so rotating the password revokes all
  persisted sessions. Authorization codes remain memory-only (60s, single-use)
  and refresh-token rotation invalidates the old token on disk immediately,
  keeping single-use semantics across restarts (`src/oauth/store.ts`,
  `src/oauth/provider.ts`, `src/config.ts`, `tests/oauth.test.ts`).

## [0.4.0] — 2026-07-12

Adds a **constrained, create-only Skill authoring** surface so a (local or
remote) client can publish instruction-only Skill bundles into the vault without
being granted general document-write access. No breaking changes — a setup that
does not enable the new surface behaves exactly as in `0.3.0`.

### Added

- **Instruction-only Skill creation via a separate two-step flow.** New
  `plan_skill_create` → `apply_planned_skill_create` tools stage and then
  **atomically** publish a Skill bundle — `SKILL.md`, optional flat
  `references/*.md` (≤20), and an optional `agents/openai.yaml` — into a
  pre-existing, vault-relative directory (`MCP_SKILLS_SUBDIR`). The surface is
  deliberately narrow: it is **create-only (never overwrites an existing
  Skill)** and **rejects scripts, binary assets, and arbitrary/nested paths**,
  reusing the existing path-containment guard chain. Like document edits, apply
  runs only against a previously planned bundle the user approved
  (`src/skillStore.ts`, `src/server.ts`, `tests/skillStore.test.ts`).
- **Independent HTTP permission boundary for Skill creation.**
  `MCP_HTTP_ALLOW_SKILL_WRITE=1` exposes only the constrained Skill tools over
  HTTP, **separately from document writes** (`MCP_HTTP_ALLOW_WRITE`), and
  requires `MCP_SKILLS_SUBDIR` (the server refuses to start otherwise). Over
  HTTP the tools are registered only when explicitly enabled and are OAuth
  scope-gated — the session registers just the write surface(s) that are turned
  on — so a remote connector can be allowed to author Skills while general
  document writes stay off (`src/config.ts`, `src/httpServer.ts`,
  `tests/httpServer.test.ts`, `tests/oauth.test.ts`).

### Documentation

- **Operations guide for the Skill surface and macOS deployment.**
  `docs/operations.md` gains a macOS **Tailscale Funnel + launchd** runbook
  (stable `*.ts.net` URL, `KeepAlive` LaunchAgent, stable `node` path, sleep /
  re-Authorize caveats) and an operator walkthrough of the `plan_skill_create` →
  `apply_planned_skill_create` flow (enable flags, create-only / atomic
  guarantees, verification).

## [0.3.0] — 2026-07-07

End-to-end hardening for Claude.ai / ChatGPT web connectors and for real-world
vault data (notably non-ASCII / Japanese notes). No breaking changes to the MCP
tool surface — a `0.2.x` setup upgrades in place. Highlights: read tools now
advertise `readOnlyHint` (far fewer approval prompts on web clients), the OAuth
consent redirect is no longer blocked by its own CSP, the public-endpoint rate
limiter keys on the socket peer instead of a spoofable `X-Forwarded-For`, and
several read-path bugs that broke non-ASCII vaults — or aborted a whole-vault
query on a single bad note — are fixed.

### Changed

- **Read tools advertise `readOnlyHint: true` so Chat clients stop prompting for
  approval on every call.** `search_documents` / `fetch_document` / `list_projects`
  / `trace_sources` and the ChatGPT-compatible `search` / `fetch` aliases are pure
  reads, but without the MCP read-only annotation a client (e.g. Claude.ai) treats
  each call as potentially state-changing and shows an "allow once?" prompt every
  time. They now carry the hint. Write tools (`create_document` /
  `plan_document_update` / `apply_planned_update`) deliberately keep **no**
  read-only hint, so clients still prompt before any mutation
  (`src/server.ts`, `tests/httpServer.test.ts`).

### Fixed

- **HTTP rate limiter now keys on the socket peer, not a spoofable
  `X-Forwarded-For`.** The `/authorize` and `/register` limiter keyed on the
  left-most XFF hop, which every proxy only _appends_ to — so it is fully
  client-controlled. Over a public tunnel that let a caller bypass the limit
  entirely (a fresh spoofed IP per request) and even lock the legitimate user out
  of their own connector by forging _their_ IP. Keying on the (unspoofable) socket
  address makes it a coarse global cap behind a tunnel and naturally per-client on
  a direct bind (`src/httpServer.ts`, `tests/oauth.test.ts`).
- **A single note with a non-string YAML scalar no longer crashes `search` /
  `list_projects` for the whole vault.** YAML auto-types unquoted values, so
  `tags: [2024]` becomes numbers and `client: 2024` a number. Such frontmatter
  parses cleanly (so the fault-tolerant parser never sees an error), but the read
  path then called `tag.toLowerCase()` / `client.localeCompare()` on the value and
  threw — aborting search and list_projects for **every** note, not just the bad
  one. `normalizeMetadata` now coerces `tags` / `source_refs` elements and the
  `client` / `project` scalars to strings at the single read-path chokepoint; the
  write-time field allowlist is untouched (`src/frontmatter.ts`,
  `tests/knowledgeStore.test.ts`).
- **Multi-root: a frontmatter `id` that collides with a root name now fetches the
  note that carries it.** With `KNOWLEDGE_ROOTS`, a vault note whose id begins with
  another root's name + `:` (e.g. `id: "ops:secret"`) was mis-routed by `fetch`
  into that root, returning a **different** document than the one the search
  citation pointed at (or nothing). `MultiRootStore.fetch` now matches a bare id
  against all wrapped documents before treating a `<name>:` prefix as routing
  (`src/multiRootStore.ts`, `tests/multiRootStore.test.ts`).
- **`create_document` keeps non-ASCII (e.g. Japanese) titles instead of collapsing
  them to `untitled`.** The slugifier stripped everything outside `[a-z0-9]`, so an
  all-Japanese `client` / `project` / `title` became empty → `untitled`, letting a
  fully-Japanese vault hold only ONE document per client/project (the 2nd create
  hit the no-overwrite guard). It now keeps Unicode letters/digits (`\p{L}\p{N}`)
  on the NFC-normalized value, with a unique hash suffix for pure-symbol titles
  (`src/knowledgeStore.ts`, `tests/knowledgeStore.test.ts`).
- **`fetch_document` / `fetch` / `trace_sources` now resolve non-ASCII (e.g.
  Japanese) filenames that `search` returns.** Document ids/relative paths derive
  from `fs.realpath`, which on macOS reports filenames **decomposed (NFD)**, while
  `assertRelativePath` normalizes client-supplied paths/ids to **NFC**. The two
  never `===`-matched, so every note with a normalization-sensitive name (most of
  a Japanese vault) came back `Document not found` even though search surfaced it
  — breaking the search→fetch round-trip that Chat clients rely on. `relativeToRoot`
  now returns the identifier in NFC so ids round-trip; both NFC and NFD lookup
  inputs resolve. Path-containment guards are unchanged — containment is verified
  on the raw realpath before normalization, and file I/O still uses the real path
  (`src/pathSafety.ts`, `tests/knowledgeStore.test.ts`).
- **OAuth consent "Authorize" button no longer silently does nothing (Claude.ai /
  ChatGPT web could never finish connecting).** The login page's
  `Content-Security-Policy` used `form-action 'self'`, but a successful login
  redirects (302) back to the client's registered `redirect_uri` on a different
  origin (e.g. `https://claude.ai/api/mcp/auth_callback`). Browsers enforce
  `form-action` against the redirect target of a form submission, so the whole
  submission was refused with no visible error and the authorization code was
  never delivered. The consent form now lists exactly this client's redirect
  origin alongside `'self'` in `form-action` (derived from the already
  exact-match + scheme-validated `redirect_uri`, so the policy stays tight); error
  pages keep the `'self'`-only policy, and the clickjacking/leakage headers
  (`frame-ancestors 'none'`, `X-Frame-Options`, `Referrer-Policy`) are unchanged.
  As part of the same fix, `redirect_uri` registration now rejects wildcard hosts
  (e.g. `https://*/cb`), whose origin (`https://*`) would otherwise widen the
  consent page's `form-action` to every https origin
  (`src/oauth/provider.ts`, `tests/oauth.test.ts`).

## [0.2.1] — 2026-07-07

Public-launch hardening release: a security fix that clears all `pnpm audit`
advisories, read-path and session-archive robustness fixes, and the
community-health files needed to accept outside contributions. No API or
behavior changes to the MCP tool surface — a `0.2.0` setup upgrades in place.

### Added

- **Community-health files** for public contribution: `CONTRIBUTING.md`
  (dev setup, the `pnpm test` quality gate, commit/branch conventions, and the
  "security reports go through SECURITY.md, not issues" rule), a Contributor
  Covenant `CODE_OF_CONDUCT.md`, GitHub issue forms
  (`.github/ISSUE_TEMPLATE/bug_report.yml` / `feature_request.yml` /
  `config.yml`, with blank issues disabled and a security-report contact link),
  and a `.github/PULL_REQUEST_TEMPLATE.md` mirroring the CI quality gate.
- **Actionable private security-reporting channel**: `SECURITY.md` and the issue
  template's security link now point to GitHub private vulnerability reporting
  (draft advisory) instead of only naming the maintainer, so reporters have a
  usable private intake.

### Fixed

- **A single document with unparseable frontmatter no longer breaks every
  query.** `search_documents` / `list_projects` / `fetch_document` /
  `trace_sources` walk and parse every note, so one file with malformed YAML/JSON
  frontmatter (a bare-dash value, or raw control characters that leak in from a
  web clipping) made gray-matter throw and abort the whole operation
  non-deterministically. The read path now parses frontmatter fault-tolerantly
  (`parseMarkdownSafe`): a note that fails to parse is indexed by its body/path
  with empty metadata and a one-line, content-free stderr note, instead of
  poisoning the batch. Path-containment / symlink guards are unchanged
  (`src/frontmatter.ts`, `src/knowledgeStore.ts`, `tests/knowledgeStore.test.ts`).
- **session-archive hook no longer writes invalid YAML frontmatter for a
  detached HEAD.** `archive-session.sh` emitted `branch: -` (bare dash) when
  `git branch --show-current` was empty, which is malformed YAML — this was the
  source of the notes that broke search above. The `branch` value is now quoted
  and escaped like `title` (`branch: "-"`), so freshly archived sessions parse
  cleanly (kept byte-identical with the canonical copy).
- **session-archive masking no longer eats the closing quote of a frontmatter
  value.** The block `mask` ran over the assembled note, so a quoted `title` or
  `branch` whose value contained a `key=…` / `token=…` substring (both are valid)
  had its closing `"` consumed by the mask value pattern, producing malformed
  YAML. The hook now masks every free-text / path-derived frontmatter value
  (`title` / `branch` / `project` / `repos` / `tags`) per-field before quoting
  and masks the body separately, so secrets stay masked (including a checkout
  basename shaped like `token=…`) and the quotes stay intact. Verified for `-`,
  normal names, and `token=…` values (kept byte-identical with the canonical
  copy).

### Security

- **Cleared all `pnpm audit` advisories.** A pnpm `overrides` entry pins the
  transitive `hono` (via `@modelcontextprotocol/sdk` → `@hono/node-server`) to
  `>=4.12.25`, resolving 6 advisories (1 high — CORS middleware reflecting any
  origin with credentials under a wildcard default — plus 5 moderate). The
  refreshed lockfile also moves `gray-matter`'s transitive `js-yaml` to `3.15.0`
  (within its existing range), clearing a moderate merge-key quadratic-DoS
  advisory without the gray-matter-breaking jump to `js-yaml` 4.x. `pnpm audit`
  is now clean and the 86 tests still pass.

## [0.2.0] — 2026-07-05

Second release. The headline change is **multi-root knowledge access**; the rest
is developer-facing hook tooling (session archiving, command-learning logs),
documentation, and dependency/CI maintenance. No breaking changes — a single
`KNOWLEDGE_ROOT` setup behaves exactly as in `0.1.0`.

### Added

- **Multiple knowledge roots** (`KNOWLEDGE_ROOTS="name=/path,…"`): search,
  fetch, list, and trace across several repos at once. The first root is the
  primary (writable); every additional root is strictly read-only and its
  documents are addressed as `name:relative/path` (results carry a `root`
  field). Single `KNOWLEDGE_ROOT` behavior is unchanged. Each root keeps the
  full path-containment guard chain; overlapping roots are rejected at startup
  (`src/multiRootStore.ts`, `tests/multiRootStore.test.ts`).
- **session-archive hook** (`.claude/skills/session-archive/`): Stop/SessionEnd
  hook that renders the full Claude Code session transcript (title +
  conversation + tool calls/results, secrets masked with the ops-logging rules)
  into one Markdown note per session inside the private vault clone and pushes
  it, making session history searchable through this MCP server. The vault is
  located indirectly (`SESSION_VAULT_REPO` env or a `.claude-session-vault`
  marker); no private repo name or path is committed here. No-op without a
  vault clone. Adds a **PreCompact snapshot mode**: before auto-compact prunes
  a transcript, a full-detail snapshot is written under
  `_logs/ClaudeCode-Web/_precompact/` so pre-compact content is never lost.
- **ops-logging skill + hooks** (`.claude/skills/ops-logging/`): PostToolUse/Stop
  hooks that append a "command + intent" learning log (all secrets masked;
  `Bearer <token>` masked as a unit; GitHub MCP calls recorded via a
  metadata-only allowlist) and push it once per session to a separate private
  `terminal-ops-logs` repo. No-op unless `OPS_LOG_REPO` points at a clone.
- **MIT `LICENSE`** file and a `license` field in `package.json`.
- **Manual release workflow** (`.github/workflows/release.yml`):
  `workflow_dispatch` → `gh release create`, refusing to overwrite a
  pre-existing tag.
- **Documentation**: operations guide (`docs/operations.md`, incl. Cloudflare
  account/domain requirements, systemd full-hardening drop-in, and a bwrap
  sandbox recipe for the stdio server), `docs/ROADMAP.md`, a STRIDE
  `docs/threat-model.md`, bilingual PR/FAQ (`docs/PRFAQ.md`, `docs/PRFAQ.en.md`),
  and README polish (architecture Mermaid diagram, status badges, use-cases).

### Changed

- `KnowledgeStore` is now composed behind a multi-root layer; `search`,
  `chatgpt` aliases, `config`, and result `types` were adapted to carry an
  optional `root` and to resolve `name:relative/path` addresses.
- Dependency maintenance (dev toolchain): `@types/node` → `^26`, `eslint`
  → `^10.6`, `oxlint` → `^1.71`, `prettier` → `^3.9`, `typescript-eslint`
  → `^8.62`, `vite` → `^8.1`, `vitest` → `^4.1.9`, plus a `github-actions`
  group bump. `CLAUDE.global.md` re-synced byte-identical with the canonical
  global layer.

## [0.1.0] — 2026-06-09

First tagged release. MCP server exposing a private Markdown vault
(`KNOWLEDGE_ROOT`) over two transports:

### Added

- Add oxlint as a fast correctness pre-pass before ESLint, typecheck, build, and tests.

- **stdio transport** for local CLI/desktop clients (Claude Code, Codex, Claude
  Desktop) with the full tool surface.
- **Streamable HTTP transport** for remote Chat connectors, hardened with bearer
  auth (constant-time, fail-closed), loopback bind, DNS-rebinding protection,
  request-body cap, and a read-only tool surface unless `MCP_HTTP_ALLOW_WRITE=1`.
- **OAuth 2.1 authorization server** (opt-in) for ChatGPT / Claude.ai web:
  metadata discovery, dynamic client registration, PKCE S256, authorization-code
  - refresh-token grants, scrypt login gate, scope enforcement
    (`vault.read` / `vault.write`), RFC 8707 audience binding, and consent-page
    clickjacking headers.
- Coarse per-client **rate limiting** on the public OAuth endpoints
  (`/authorize`, `/register`), and **ESLint + Prettier** with `lint` / `format` /
  `format:check` scripts wired into CI.
- Search **parse cache** (mtime/size-invalidated) in `KnowledgeStore` so queries
  no longer re-parse unchanged Markdown files on every call.
- Tools: `search_documents`, `fetch_document`, `list_projects`, `trace_sources`,
  `create_document`, `plan_document_update` → `apply_planned_update` (two-step,
  stale-safe writes), and ChatGPT-compatible `search` / `fetch` aliases.
- Security invariants pinned by tests: path containment, symlink-escape/cycle,
  frontmatter allowlist, two-step stale-safe writes, HTTP auth + read-only
  surface, and the full OAuth flow.

[Unreleased]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/theosera/claude_openai_mcp_connector/releases/tag/v0.1.0
