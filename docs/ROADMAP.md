# Roadmap

Direction for `claude_openai_mcp_connector` after **v0.1.0**. This is a living
document — items and ordering will change as the product is used. It is paired
with [`PRFAQ.md`](./PRFAQ.md) (the "次に追加する機能" / out-of-scope sections)
and [`operations.md`](./operations.md).

Status legend: 🔭 planned · 🚧 in progress · ✅ done · 💭 idea / needs validation

---

## Guiding priorities

1. **Lower the activation barrier** so the _Obsidian-power-user_ segment can get
   to a working local connection without engineering skills.
2. **Make the web connector survive restarts** so "it dropped" stops happening.
3. **Never widen the security surface** — every new feature keeps the strict
   defaults (read-only by default, two-step writes, path containment, OAuth
   audience/scope binding).

---

## Near-term (next minor releases)

### Onboarding & packaging — _reduce friction for non-engineers_ 🔭

The current README starts at `pnpm install` / `pnpm build`, which can deter
non-engineers. Goal: a copy-paste path that does **not** require a manual build.

- One-command run, e.g. `npx claude-openai-mcp-connector` or a prebuilt binary,
  removing the Node/pnpm build step.
- A **"first-time / prerequisites"** quickstart with install links (Node) and a
  3-tier path: 🟢 local + Claude Desktop → 🟡 CLI clients → 🔴 web + OAuth.
- Optional: a guided `init` that writes an env file interactively — it must also
  wire up the **`MCP_ENV_FILE`** (absolute path) that names that file, because
  the server no longer reads `.env` from its working directory (for a
  client-spawned stdio server that directory is attacker-choosable; see the
  `[Unreleased]` Security/Migration entries in [`CHANGELOG.md`](../CHANGELOG.md)).
- _Why:_ the target audience skews technical but the build step is the main
  drop-off point; the web/OAuth path stays "advanced".

### OAuth token persistence — _survive restarts_ ✅

Persist OAuth tokens / registered clients (previously in-memory only,
`src/oauth/store.ts`) so a restart does **not** force a re-auth. **Shipped in
0.5.0** as an opt-in `MCP_OAUTH_STATE_FILE`. This entry sat at 🚧 / "PR pending"
for three releases after the PR merged — the graduation, not the work, is what
was outstanding:

- **Hash-at-rest** — tokens are keyed by `sha256(token)` in memory _and_ on
  disk, so the state file holds no recoverable credential (no encryption key to
  manage; stronger than encryption here because raw tokens never need recovery).
- **Integrity + fail-closed** — the file carries an HMAC-SHA256 tag keyed from
  `MCP_OAUTH_PASSWORD` (scrypt-derived, per-file salt); tamper / corruption /
  version-mismatch / password-rotation loads to empty state (so rotating the
  password also revokes all persisted sessions). Atomic write, `0600`.
- **Outside the vault, enforced at boot** — the state file holds the
  registered-client list, the per-file salt and the HMAC tag. A knowledge root is
  a read surface (walked, indexed, reachable through search / fetch), so a state
  file placed inside one publishes all three to every client that can read.
  `loadOAuthConfig` now refuses that. The same guard covers `MCP_PATCH_STATE_DIR`,
  whose staged plans hold the full proposed text of a document — including its
  **default**, which derives from the home directory and is therefore inside the
  vault whenever a root contains `$HOME`. Canonicalization follows symlinks
  component by component instead of resolving the existing prefix with
  `realpath`, so a **dangling** link into the vault is caught before its
  destination exists, and containment compares `(dev, ino)` rather than spelling
  so a case variant of the root on macOS / Windows cannot slip past.
  Opting into persistence therefore requires
  `KNOWLEDGE_ROOT(S)` to be configured — without the roots there is nothing to
  check against, and the fail-closed half of this is refusing to guess.
- Kept the existing security properties (opaque 256-bit tokens, single-use
  short-lived codes that are **never persisted**, refresh rotation invalidated
  on disk immediately, capped/pruned collections) and single-user simplicity.
- Pinned by `tests/oauth.test.ts`. See
  [`operations.md §1.B`](./operations.md#b-oauth-state--in-memory-by-default-persistable-via-a-state-file).

### Search & retrieval UX ✅

Improve relevance and ergonomics of `search_documents` / `search`:

- ranking / snippet quality, optional tag & project filters in the query,
- guardrails so large vaults stay responsive (the parse cache from 0.1.0 is the
  foundation). 🚧 First responsiveness slice landed: vault scans now open files
  with **bounded concurrency** (`MCP_SCAN_CONCURRENCY`, default 24) + transient
  `EAGAIN` retry + skip-and-log, so a thousands-of-notes vault no longer
  exhausts file descriptors mid-search (`src/knowledgeStore.ts`). ✅ The other
  half of "stays responsive" also landed: **the parse cache is now bounded**
  (`DEFAULT_DOCUMENT_CACHE_MAX_CHARS`, **192M** characters of retained text, LRU
  eviction, overridable with `MCP_DOCUMENT_CACHE_MAX_CHARS`).
  It previously had no cap, no eviction and no delete path at all, so a note
  removed from the vault kept its parse alive for the life of the process and a
  vault larger than memory had no behaviour other than to exhaust it — measured
  at 1,000 synthetic notes / 16.9 MB on disk: heap 7.7 MB → 42.7 MB, retained
  through a forced GC. Over-budget vaults now degrade into re-parsing.

  ⚠️ Two limits worth keeping in view rather than discovering later. The bound
  counts **characters of retained text, not heap** — V8 string representation,
  frontmatter objects and Map overhead sit outside it, so it is a proxy off by a
  constant factor rather than a memory limit. And the LRU ordering is currently
  **unobservable**: every read path enumerates the whole vault (`fetch` and
  `search` both go through `listDocuments`), so under the only access pattern
  that exists, LRU and FIFO are indistinguishable. The first point-read caller —
  `get_context` is already named in the tool budget — is what would make the
  difference real.

  ⚠️ **The first value shipped for that bound was 24M and it disabled the
  cache.** It was chosen against a vault's size **on disk**; the counter sums
  `body + foldedBody + compactBody` in UTF-16 characters, which for the same
  vault is 80.9M (2,894 notes / 48.6 MB on disk → 27.2M body + 53.7M derived).
  Because every read path enumerates the whole vault, a sweep that does not fit
  evicts its own front before the next sweep arrives — the miss rate goes to
  ~100% rather than degrading gently. Measured cost: warm full scan 91 ms →
  689 ms, `search` 150 ms → 724 ms, retained heap unchanged after a forced GC.
  Two things follow, and both are now pinned by tests rather than by comments:
  the unit is ~3x the body and not the byte count on disk, and an eviction test
  must state its own budget instead of inheriting the shipped default — the
  original tests sized their fixtures to straddle 24M, so any re-sizing would
  have left them passing without evicting.

  ⚠️ **And it is weaker than "a proxy off by a constant factor" above.** Measured
  as a slope rather than a single reading — same vault, one process per budget,
  heapUsed after repeated forced GC — moving the cap from 1M to 192M characters
  moves retained heap by **1.9 MB** (168.2 → 170.1), while a scan retains ~160 MB
  whether the cache keeps one note or all of them (8.3 MB before any scan). So
  on a vault this size the bound does not govern memory at all; it governs
  whether the cache works. It is a safety valve for a vault far larger than the
  reference one — the regime the original 1,000-synthetic-note measurement
  (16.9 MB of notes, heap 7.7 → 42.7 MB) actually describes. Anyone sizing this
  against a heap target should measure the slope on their own vault first.

Concretized by the [context-engineering proposal](./context-engineering.md)
(survey-based, 2026-07) into two slices, both now landed — which closes out this
item; further retrieval work continues under the context-engineering layer
below:

- **P0 correctness slice** ✅ — NFKC folding on the search path (`src/searchText.ts`;
  `pathSafety`'s NFC is untouched and stays identity-preserving), `modified_at` /
  `updated_at` / `size_bytes` on `SearchResult`, a
  `{results, total_count, offset, limit}` envelope so agents can see truncation
  instead of re-querying blindly, backlink resolution of relative Markdown links
  (`resolveRelativeLink`), and `absolutePath` dropped from every document
  response via an allowlist projection. Two breaking changes (the envelope and
  the `absolutePath` removal) land in the next minor; the ChatGPT aliases are
  unchanged. Pinned by `tests/search.test.ts` + fixture backlink regressions.
- **P1 quality slice** ✅ — CJK query segmentation via `Intl.Segmenter`
  (zero-dep, bigram fallback, phrase bonus so a verbatim match still wins),
  **opt-in** recency decay (`MCP_SEARCH_RECENCY_WEIGHT` default 0, multiplicative
  so it never surfaces a non-match; age from frontmatter before mtime, which git
  rewrites), `path_prefix` / `root` / date-range filters, `order`
  (`relevance` / `recent` / `path`), two-window snippets, per-result `explain`
  score breakdown, and a derived-text cache riding the parse cache's existing
  stat-signature invalidation (removes the per-query full-corpus fold). That
  signature was `mtimeMs` + size when P1 shipped and was strengthened afterwards
  — see the external-review triage item below; the derived text rides whatever
  the parse cache uses rather than adding a second cache. Pagination shipped
  earlier with P0. Entirely additive: unset env and unset parameters reproduce
  0.7.0 ranking exactly. Pinned by `tests/search.test.ts`.

### Context engineering layer — get_context / link graph / project state ✅ P0–P4 / 💭 P5

Evolve the read plane from "search API" to "context gateway": one call should
return a token-budgeted, provenance-carrying context package instead of forcing
the client into search→fetch loops. Full design (A–G survey, tool schemas,
anti-forgery analysis, reject list) in the
[context-engineering proposal](./context-engineering.md). Net tool count
15 → 17; **no new write surface in any phase** (guiding priority #3), and
per-agent "context profiles" are request parameters only — never server-side
client detection, per the [appendix's anti-router ruling](#appendix--future-uses-of-the-authenticated-client_id).

**P0–P4 shipped in 0.9.0**: P0/P1 (search), P2 (`8e4ec7e`), P3 (`9e2c914`), P4
(`de9021c`). ⚠️ **The layer is not finished.** `P5 評価 & tuning` is still
`💭 未着手` in the status table this section shares authority with, so the ✅
above covers P0–P4 and nothing more — an earlier draft of this paragraph said
"every slice landed", which contradicted that table.

⚠️ **The net tool count has reached the documented cap** — `registerTool` is
called **17** times and both reserved slots are spent, so the next tool is a
decision to *exceed* the cap rather than to spend a reservation. The staged-plan
item under continuity below costed `discard_plan` against those reservations and
is repriced accordingly.

**What P0–P4 landing did to the 💭 tail below.** The embeddings / vector-search
entry is gated on "documented recall failures **after P1–P3 land**". P1–P3 have
now landed, so **the gate is open** — precisely: the trigger did not fire, it
became *able* to fire, and nothing has looked since. What would produce the
documented failures it waits on is P5 itself, which makes P5 and the tail one
decision rather than two.

- **P2 — link graph & provenance** ✅: `src/linkGraph.ts` built from an
  **unprefixed** `listDocuments()` (fs access stays behind the existing guard
  chain; `path_prefix` shipped with #108 but only `search` passes it — a backlink
  set computed over a subset is wrong, not merely smaller), correct relative-link
  resolution, and Obsidian-style wikilink resolution **from path facts only**: an
  exact root-relative path match first, then basename. Keeping the exact-path leg
  is what lets a folder-qualified link like `[[projects/a/note]]` keep its edge
  when two folders hold a `note.md` — it is unambiguous without consulting a
  single self-declared field, so there is no reason to drop it. Frontmatter
  `title` / `aliases` generate candidates but **never resolve on their own, even
  when the match is unique**: a note's self-declared fields are the same class as
  the `id` that INV-2 already refuses, so honouring a unique alias would reopen
  that hole under another name (the same rule P3's type weighting states as
  "frontmatter self-claimed types never drive trust"). Uniqueness is not a
  safety argument here, because what decides it is attacker-writable. The
  reachability cost is accepted and recorded rather than hidden: a note findable
  only by alias stops being auto-followed from a wikilink, though `path` and
  `basename` still reach it.

  **The cost is measured, not argued.** Against the real vault (2,891 notes,
  single root, 2026-08-16): every wikilink that resolves through a *unique*
  `title` today — 46 of them — lands on the same note under the new rule, so
  **no unique resolution is lost**, and basename adds 249 edges that do not
  resolve today. The 3,927 title-only edges that do disappear are all fan-out
  from *multi*-match titles, and 580 of the 606 links producing them name a
  basename **no note in the vault has** — links Obsidian itself shows as
  unresolved, which the current code was attaching to every note that happened
  to share an H1. **Backlink edges therefore drop 4,027 → 349 (−91%)**: a
  user-visible change, and a removal of false edges rather than lost recall.
  Two limits worth carrying: this is n=1, and a vault that *does* operate
  `title` as a unique identifier would see a different split; and `aliases`
  appears nowhere in this vault, so that half of the rule is untested by
  measurement. A third-tier "resolve a unique title, fail closed on collision"
  fallback was costed and **adds zero edges here**, so it buys only complexity.

  `trace_sources` gains `depth` / `direction` +
  resolved-link output. Bounds: depth ≤ 2, node/fanout caps, hub damping for
  MOC notes. Decided as P2-D0; full rationale in the
  [context-engineering proposal](./context-engineering.md#d-4-linkgraph-の仕様-p2).

  **Shipped**, with three things settled against the implementation rather than
  ahead of it. The graph keys nodes on the **path**, not on frontmatter `id`:
  the D-4 sketch said `outgoing(id)`, but `id` is the field INV-2 already
  refuses to resolve on when two notes claim it, and a graph keyed there would
  let one note redirect another's edges. `resolved_outgoing` therefore carries
  both handles — `target_path` to follow, `target_id` for citation compatibility.
  In multi-root deployments implicit forms (relative links, bare names, title /
  alias lookups) resolve **inside the linking note's own root**; only the
  explicit `<root>:` form crosses, because root names come from config and a
  note cannot name one for itself. And a wikilink's name leg matches the **whole
  link text**, so a folder-qualified `[[projects/a/note]]` that misses its path
  is left unresolved instead of being retargeted at some other folder's
  `note.md` — which is what keeps the exact-path leg load-bearing rather than
  decorative.

  ⚠️ **One record is left open on purpose: `D-G3-SUBSET-VIA-SKIP`.** The
  argument above rests on "unprefixed `listDocuments()` = the whole vault", and
  since #114 that is no longer exactly true — the walk skips entries it cannot
  reach and continues, writing a line to stderr while **the return value says
  nothing**. This ships degrading rather than failing closed: failing closed
  would restore precisely the one-bad-entry-stops-everything behaviour #114
  removed, and a link graph is a weaker reason to reverse that than the read
  plane was to establish it. The missing piece is a completeness signal on
  `listDocuments()` itself — a `VaultStore` change reaching every caller, so a
  different boundary from this one. What must not happen meanwhile is filing an
  unreachable skip under the same heading as a prefix exclusion: a prefix is
  chosen by the caller and known to it, a skip is neither.

  One corner of that gap is closed rather than merely recorded, because the
  answer there was wrong and not just incomplete. When the **traced** note is
  the one the walk skipped, `trace_sources` used to report that it writes no
  links — a statement indistinguishable from a note that writes none, about a
  document the same call had just fetched successfully. That case now falls back
  to the fetched copy. The record stays open for everything else: a **backlink**
  missing because some other note was skipped is still invisible, and only a
  completeness signal on `listDocuments()` can fix that.
- **P3 — `get_context`** ✅: deterministic 5-stage pipeline (seed search →
  link expansion → fuse/dedup → heading-level chunking → greedy
  score-per-token packing) returning a `ContextPackage` with per-chunk
  provenance and an `omitted[]` list; zero-dep CJK-aware token estimation;
  opt-in owner-controlled type weighting (`MCP_CONTEXT_TYPE_RULES`, refuses to
  load from inside a knowledge root; frontmatter self-claimed types never
  drive trust).

  **Shipped**, with four things settled against the implementation rather than
  ahead of it.

  **Recency is applied in exactly one place, and it is not this one.** D-3
  sketches a recency factor inside the fuse stage. Written literally it
  subtracted search's own recency contribution and re-applied a weight only the
  per-call `recency_weight` could set — which left `MCP_SEARCH_RECENCY_WEIGHT`
  dead for `get_context`, exactly the shape #112 fixed elsewhere. The seed base
  is therefore the whole search score, expansion inherits it, and the packer has
  **no clock at all**: a package is a pure function of (vault, input, rules).
  A second copy of a rule is the copy that rots.

  **Dedup is keyed on the path, not on `id`** — the same reason P2 keyed the
  link graph there. `id` is frontmatter, INV-2 already refuses to resolve on it
  when two notes claim it, and a package deduplicated on a self-declared field
  would let one note evict another from the answer.

  **The selector requirement is a bound, not ergonomics.** `get_context()` with
  no `query` / `project` / `tags` / `path_prefix` is refused, because a budget
  alone would have turned "dump the vault" into "dump the first 4,000 tokens of
  the vault" rather than preventing it.

  **`truncated` exists because the 40%-per-document share is enforced.** One
  megabyte-scale session archive would otherwise answer every query with its own
  top section; capping it means a genuinely dominant document gets cut, and a
  cut that is not reported is indistinguishable from a document that was short.

  ⚠️ **Two guards passed their first inverse-verification run for the wrong
  reason**, and both are recorded because the shape recurs: zeroing the
  per-chunk JSON overhead constant left every test green (the assertion compared
  two expressions that both contained it), and stripping recency from the seed
  base changed nothing (the mutation read a `score_breakdown` the call no longer
  requested). A guard that cannot be observed failing has not been verified,
  whichever direction the run comes out.
- **P4 — project memory** ✅: `get_project_state` (deterministic dossier —
  designated `project-state`-tagged docs, recent docs, session-archive
  metadata + outline only, ops-log pointers via their `target_repo`
  frontmatter) and `fetch_document` gains `outline` / `sections` / `max_chars`
  so MB-scale session notes never have to be fetched whole.

  **Shipped**, and the shape follows from one fact about this vault: a session
  archive runs to megabytes while an ordinary note runs to kilobytes, so
  "return the project's documents" is not one behaviour. `state_docs` carry
  full text against a budget, `recent_docs` carry a snippet, and
  `recent_sessions` carry **metadata and an outline and never a body** —
  inlining one session note would spend the whole budget on the document the
  caller asked about least.

  **The `summary` field is derived counters only (doc_count / latest_ts / roots);
  there is deliberately no prose, no `blockers`, no `next_steps`.** A
  server that emits prose has synthesized, and synthesis here would be either a
  second model — which this one does not have, by design — or a template
  pretending to be one. The seat for a conclusion is a `state_docs` note that a
  human or an offline pipeline wrote, which this returns verbatim. A dossier
  that is visibly assembled beats a summary that cannot be checked.

  `ops_recent` reaches ops logs through their `target_repo` frontmatter with no
  change to the capture hook, and returns **pointers only** — `target_repo` is
  self-declared, so any note can join that list, and what it joins is a set of
  paths the same caller could already enumerate.

  `fetch_document` was extended rather than joined by a `fetch_section`
  sibling: asking for part of a document is the same question as asking for it.
  Every parameter is optional and omitting all of them reproduces the previous
  response exactly, which is pinned by a test rather than asserted here.
  `total_chars` always reports the whole document, never the returned slice —
  the same reason `get_context` returns `omitted[]`.
- 💭 tail (evaluation-gated): knowledge-lifecycle tooling; an inverted index
  (trigger: >10k notes or search p95 > 200 ms); embeddings/vector search
  (trigger: documented recall failures after P1–P3 land).

### Constrained audit write surface — _persist unattended vault-scan output_ ✅

An unattended, recurring vault security scan needs to persist its reports + scan
state **into the vault** without the scanner holding the general document-write
tools — a write-enabled unattended connector reading possibly-malicious notes is
a confused-deputy risk. Implemented as an opt-in, independently gated pair of
tools scoped to one reserved subtree (`MCP_AUDIT_SUBDIR` +
`MCP_HTTP_ALLOW_AUDIT_WRITE`):

- `append_audit_report` (create-only, idempotent per `run_id`, never overwrites)
  and `compare_and_swap_audit_state` (atomic sha256 compare-and-swap of
  `state.md`); audit ops are serialized in-process (`src/auditStore.ts`).
- General document writes are **forbidden from the audit subtree** (INV-9 —
  audit-trail integrity). The operational model is a dedicated
  read-only-plus-audit "scan endpoint" (general write off,
  `MCP_HTTP_ALLOW_AUDIT_WRITE=1`) so an injected scanner has **no** general write
  tools to be steered into — that endpoint separation, not INV-9, is what closes
  the confused-deputy.
- **Reserving the subtree and registering the tools are separate decisions, on
  every transport** — `MCP_HTTP_ALLOW_AUDIT_WRITE` on HTTP and
  **`MCP_STDIO_ALLOW_AUDIT_WRITE`** (new, default off) on stdio. stdio used to
  take the presence of `MCP_AUDIT_SUBDIR` as permission for both, which meant an
  operator following the documented "set the same subdir on every write-capable
  process" guidance also armed every interactive local session with the two
  single-call audit writes — no plan/apply step, no confirmation, on a transport
  whose input is untrusted vault content. The reservation rides on
  `config.auditSubdir` and is unaffected by the flag, so withholding the tools
  does not weaken INV-9; both halves are pinned by one pair of adjacent tests.
  The startup line reports three states (`off` / `reserved-only` / `on`) on
  **both** transports, because a single on/off could only ever describe one of
  the two. stdio gained them here; HTTP kept printing the flag alone for another
  release, so `audit=off` read as "tools not registered" there and "subtree NOT
  reserved" here — one token, opposite meanings, on exactly the two processes
  the guidance above tells an operator to compare.
- **The same split now applies to Skills** — `MCP_HTTP_ALLOW_SKILL_WRITE` on HTTP
  and **`MCP_STDIO_ALLOW_SKILL_WRITE`** (default off) on stdio. This was written
  as an audit-only lesson and fixed on the audit surface alone; stdio kept
  deriving the Skill tools from `Boolean(skillStore)` for another release, two
  lines above the comment explaining why that shape had been a hole. A test
  asserted the surviving half **positively** — "the Skill surface … is
  untouched" — which is how an unfixed instance of a known bug reads as a scope
  decision. Skill creation is two-step, so it was never the single-call exposure
  the audit pair had; it is arguably the heavier target anyway, because a Skill
  is loaded by later sessions **as instructions**, which is the premise INV-8
  exists for. The INV-8 reservation rides on `config.skillsSubdir`, so
  withholding the tools does not weaken it, and `skills` now reports the same
  three states.
- **Distinct from the "Audit log" gap below.** That is a _content-free,
  server-side_ event log of who searched / fetched / wrote (keyed on
  `client_id`); this is the _scanner's own_ audit output written into the vault.
- Out of scope here (scanner-side, lives in a local Skill): the byte-level scan
  engine, full enumeration, and the out-of-vault git-SHA / signed-manifest trust
  anchor.
- **Graduated in 0.8.0**, once the stdio half landed. The scanner-side counterpart
  is pinned too: the runner assembles each report and `state.md` in a temp file,
  checks it, and only then renames — so a frontmatter `id` / `updated_at` is
  unwritable rather than written-then-removed, and a failed check cannot destroy
  the previous `state.md` it would have overwritten. That runner writes to the
  filesystem directly, so neither INV-2 guard in this repo (the read side in
  `fetch`, the write side in `assertNoServerOwnedFrontmatter`) is on its path —
  **"does not write an `id`" and "cannot write an `id`" are different claims**,
  and only the second one survives an edit to the runner.

### MCP 2026-07-28 (stateless core) adoption — _reliability, not speed_ ✅

The 2026-07-28 revision makes the protocol stateless at its core: the
`initialize` handshake and the `Mcp-Session-Id` header are gone (version /
client info / capabilities ride in `_meta` on every request), all requests carry
`Mcp-Method` / `Mcp-Name` headers for gateway routing, list results carry
`ttlMs` / `cacheScope` cache hints, and server→client requests become Multi
Round-Trip Requests (MRTR) instead of held-open SSE streams. Support lands in a
**new package line** — `@modelcontextprotocol/server` + `@modelcontextprotocol/core`
v2 — not in `@modelcontextprotocol/sdk` v1 (1.30.0 still pins
`LATEST_PROTOCOL_VERSION = '2025-11-25'`, our current dependency).

**Assessed benefit for _this_ connector: essentially no performance gain.** The
headline wins are horizontal-scale wins (round-robin LB, serverless/edge, no
sticky sessions, header-based routing), and this is a single-user, single-process,
loopback-bound server behind a named tunnel — there is no second instance and no
MCP-aware gateway. MRTR is a non-event because the server issues no
elicitation / sampling / roots requests (the two-step approval flow returns a
question in the tool _result_ and lets the client ask). Cache hints save one
round trip per (re)connection on a ~15-tool surface that is static per scope:
real, but not perceptible — and see the scope-privacy constraint in item 3
below before caching any listing. **Do not adopt this for speed.**

The reasons to adopt it anyway, in cost/benefit order:

1. **Authorization hardening (cheapest, transport-independent) ✅** — SEP-2468
   applies RFC 9207 to close authorization-server mix-up. Note which half is
   ours: we are the **AS**, so our work is that an AS _SHOULD_ include `iss` in
   authorization responses (including error responses) and, if it does, _MUST_
   advertise `authorization_response_iss_parameter_supported: true` in its
   metadata — i.e. add `iss` to the `/authorize` redirect in
   `src/oauth/provider.ts` and the flag to `authorizationServerMetadata()`,
   together. The matching client duty (validate a supplied `iss` byte-for-byte
   against the expected issuer, and reject a missing one when the AS advertises
   support) falls on ChatGPT / Claude.ai, not on us. Applies to `src/oauth/` on
   its own, with no transport migration. **Caveat:** the same revision deprecates DCR
   in favour of Client Metadata Documents (CIMD). That invalidates a premise of
   the [`client_id` appendix](#appendix--future-uses-of-the-authenticated-client_id)
   — "DCR mints a fresh id whenever a client re-adds the connector, so it is not a
   stable identity". Under CIMD it becomes stable, so the appendix's reasoning
   about attribution / selective revocation must be revisited **before** any
   `client_id`-keyed feature (i.e. before the audit log) is built on it.
2. **v2 packages + dual-era serving ✅ — this is the one that paid.** It closed
   the **third** cause of "the connection dropped", now written up as resolved in
   [`operations.md` §1.C](./operations.md). Causes (A) ephemeral tunnel URL and
   (B) in-memory OAuth state were already addressed (named tunnel /
   `MCP_OAUTH_STATE_FILE`); the MCP **session** itself was not. `sessions` in
   `src/httpServer.ts` was a process-memory `Map`, so every supervisor restart,
   redeploy, or OOM invalidated all session ids and the server answered
   `404 unknown_session`, forcing a client re-initialize. Removing the session id
   removed exactly that failure mode — and no more. A restart still drops
   in-flight requests, and any continuation across a multi-round-trip request
   still needs an explicit, integrity-checked `requestState` (plus whatever
   application state that round depends on); statelessness does not carry either
   across a restart for free. Scoped that way it still directly serves guiding
   priority #2. Secondary win: sessions are only reaped via `transport.onclose`
   and each entry pins a transport **plus** a per-session `McpServer` instance —
   whether a client that vanishes without a DELETE is reliably reaped is
   unverified and worth checking on long uptimes; statelessness removes the class.

   **This is three changes, not one — land them separately.** They guarantee
   different properties, touch nearly disjoint files, and only the middle one is
   a security-boundary change; bundling them would put a boundary re-pin in the
   same review as a dependency bump and a docs rewrite.

   - **2a. Dual-era transport ✅ — dependency + handler substrate.** The HTTP
     path now runs on `@modelcontextprotocol/server` / `core` v2 and serves the
     2025 era and 2026-07-28 side by side from one endpoint. Property
     guaranteed and pinned by `tests/httpServer.test.ts`: _both protocol eras
     negotiate successfully against one endpoint_, with the same tool surface
     from the same factory. The DNS-rebinding regression test was the
     **precondition** and did its job — it is unchanged across the move, which
     is the evidence the protection survived it.

     Three things landed differently from the sketch above, each deliberate:

     - **The legacy leg is routed to explicitly, not served by
       `createMcpHandler`'s `legacy: 'stateless'` default.** That default would
       have moved 2025 traffic off the session model in the same PR as the
       dependency bump — exactly the bundling this split exists to avoid. So
       `src/httpServer.ts` classifies with `isLegacyRequest` (the entry's own
       classification step, exported as a predicate, so the branch cannot
       disagree with it) and hands 2025 traffic to the established sessionful
       wiring, now `WebStandardStreamableHTTPServerTransport`. **Per-session
       resolution is therefore intact for the 2025 era**, and every pre-existing
       boundary test passes unmodified.
     - **The modern leg resolves per request, because it has no sessions to
       resolve against.** That is not 2b arriving early: 2b is the move of the
       _whole_ endpoint off sessions plus the re-pin of every boundary test
       against per-request resolution, and it is where `vault.read` enforcement
       lands. Here both eras call one `surfaceFor(principal, …)`, so there is a
       single scope→surface function to re-pin rather than two. The modern
       factory recovers its principal from the `Request` object the endpoint
       authenticated (`McpRequestContext.requestInfo`, identity-stable) and
       **throws if it cannot** — there is no default surface to fall back to,
       because that default would be the full one.
     - **DNS-rebinding enforcement moved to the endpoint boundary in this PR**
       (it had to: `createMcpHandler` exposes no such option), which graduates
       part 2 of the section below. See it for the two decisions that forced —
       port-agnostic Host comparison, and _not_ adopting the SDK's
       hostname-only Origin validator.

     Also in scope because the package line moved as a whole: `src/server.ts`
     builds a v2 `McpServer` (single tool factory, unchanged registrations) and
     `src/index.ts` uses the v2 `StdioServerTransport`. That is a package swap,
     not the stdio migration — `serveStdio()` and dual-era **stdio** remain 2c.
     `@modelcontextprotocol/sdk` v1 stays as a **devDependency** only, driving
     the 2025-era half of the negotiation test from a real v1 client.

   - **2b. Per-request scope→tool-surface resolution ✅ — the security-boundary
     node.** Sessions are gone from the HTTP endpoint entirely: one
     `createMcpHandler` with `legacy: 'stateless'` serves 2026-07-28 natively and
     2025 through the stateless legacy fallback, so every request of either era
     gets a fresh instance from the same factory. Property guaranteed and pinned:
     _with no session at all, the visible tool set is exactly what the presented
     token's scopes permit, on every single request_.

     What that actually closed is sharper than "resolution moved": under
     sessions, requests were routed by `mcp-session-id` **alone** and the
     presenting principal was never re-checked, so a connection opened with a
     write-scoped token kept the write surface for its lifetime regardless of
     what token later requests carried. The regression test is written as that
     scenario — one client, one connection, the bearer swapped underneath it —
     because asserting "two clients with two tokens see two surfaces" would have
     passed under the session model too.

     **`vault.read` is now enforced**, closing the read half of INV-7 item 5. A
     token whose grant is empty (a client asking only for `vault.write` while
     writes are off — `grantScope` returns the intersection and refuses to
     substitute read for a scope never requested) previously authenticated and
     read the whole vault, because `{scopes: []}` is non-null and the read tools
     were registered unconditionally. Completion condition met with the
     **refuse** arm rather than the empty-tool-list arm: `403` carrying the
     RFC 6750 §3.1 `insufficient_scope` challenge that names the missing scope,
     because that is what lets a client re-authorize for it — an empty `200` is
     indistinguishable from an empty vault and sends the operator looking in the
     wrong place. `surfaceFor` additionally refuses to build a surface for a
     principal without read, so the hole cannot be reopened by a future path that
     bypasses the gate.

     **The consent page now states the granted scope**, which the previous node
     deliberately withheld: while `vault.read` was unenforced, a scope line would
     have described a restriction the server did not apply. It shows the grant
     (requested ∩ grantable), not the request, and says so explicitly when the
     grant is empty.

     Re-pinning cost, as predicted, was concentrated rather than large: exactly
     one pre-existing assertion had to invert (the 2025 handshake no longer
     issues a session id), and it is now asserted on the wire for both eras.

   - **2c. stdio + operations migration ✅.** `src/index.ts` serves stdio through
     `serveStdio()`, so a local client may open either era against the same tool
     factory; before this, stdio answered the 2025 handshake only and did not
     offer `server/discover` at all. Two measured details shaped the wiring:

     - **`legacy: 'serve'` is passed explicitly, not defaulted.** Dual-era stdio
       is the point of the change, so a library default that later moved would
       silently turn 2025-era clients away. Flipping it to `'reject'` fails the
       2025 leg with `-32022`, which is what makes the test meaningful.
     - **`onerror` is passed to keep start-up failures visible.** `serveStdio`
       starts the wire in the background and _drops_ the rejection when no
       handler is installed, where the previous `await server.connect(…)` would
       have crashed the process. Without a handler, a transport that failed to
       start would leave the "ready" line as the only output. It reports the
       error class only — the same callback receives runtime errors whose
       messages can quote inbound bytes — and is non-fatal, so malformed client
       input cannot kill the server.

     **One instance is pinned per stdio connection**, which is exactly what 2b
     removed from HTTP. That asymmetry is deliberate and load-bearing: on HTTP
     successive requests on one connection can present different bearer tokens,
     so the surface must be re-derived per request; stdio carries no principal at
     all (`serveStdio` never sets `ctx.authInfo`/`ctx.requestInfo`), the peer is
     the process that spawned the server, and the surface is a constant — pinned
     and per-request are observationally identical there. Neither side should be
     changed to match the other.

     [`operations.md §1`](./operations.md) gained the third "why connections
     drop" cause, written as **resolved**: process-memory MCP sessions and the
     `404 unknown_session` restart failure are gone with 2b, so a restart is now
     transparent at the protocol layer and only §1.B (OAuth state) survives it.
     The runbook's own 2b debt was paid at the same time — §9 Step 5 still told
     operators to "reuse the returned `mcp-session-id`", a step that cannot work
     against a sessionless endpoint. Both the replacement snippet and the
     `405` on `GET`/`DELETE` are asserted against the live endpoint, so the
     runbook cannot drift from the server it documents.

   The order is forced: 2a → 2b → 2c. Item 3 below depends on **2b**, not on 2c.

3. **Cache hints (`ttlMs` / `cacheScope`) ✅ — the safe values are the defaults,
   and they are now pinned.** The tool surface is static only _per scope_, not
   globally: `src/httpServer.ts` derives `allowWrite` / `allowSkillWrite` /
   `allowAuditWrite` from the principal's scopes and registers a different tool
   set for each (that is INV-6/INV-7). A `cacheScope: 'public'` listing would
   therefore be servable across principals, handing write-tool metadata to a
   read-scoped client — the exact leak "not registered, so not discoverable"
   exists to prevent.

   **Measuring the package first changed what this item is.** There was never a
   hole to close: the SDK fills the required 2026-07-28 fields from its
   `cacheHints` option, which this server does not set, so cacheable results
   already go out as `ttlMs: 0` / `cacheScope: 'private'` (measured on the wire
   for both `server/discover` and `tools/list`). The work is not _fixing_ a leak
   but _not opening_ one — so it lands as a test, not a change.

   **Two corrections to what this item used to say:**

   - "Use a private cache scope, **or a key that includes the effective scope and
     the enabled surfaces**" — the second option does not exist. `CacheHint` is
     `ttlMs` + `cacheScope` and nothing else; cache keying belongs to the client
     and no server-side lever reaches it.
   - **`private` alone is not sufficient either.** 2b made the surface follow the
     _token_, while a private cache is keyed by the _client_. One client swapping
     bearers — the case the token-swap test already pins — would be served the
     previous token's tool list. With no way to put the token in the key,
     **`ttlMs: 0` is the only safe value**, and "private" is the weaker half of
     the guarantee rather than the point of it.

   Pinned by `tests/httpServer.test.ts`: both cacheable operations are asserted
   on the wire, and the capture itself is asserted so the test cannot pass
   vacuously. Red/green measured — `cacheScope: 'public'` and `ttlMs: 60000` each
   fail it. Adding `cacheHints` for any reason now has to argue with a test.

4. **Stateless scale-out / header routing — deliberately not pursued.** Gated on
   multi-user graduating from 💭. Adopting it now buys nothing and widens surface.

**Graduated to ✅ in 0.8.0 with item 4 open by decision, not by omission.** Items
1–3 all landed; item 4 is the one piece this deployment should _not_ take, and a
section left at 🚧 because of a deliberate non-goal reads as unfinished work and
invites someone to "complete" it.

**No deadline pressure, so sequence this behind the security follow-ups.** v2's
`createMcpHandler` serves the 2025 era and 2026-07-28 simultaneously by default
(`legacy: 'stateless'`), and deprecations carry a floor of twelve months before
the earliest possible removal. There is no cliff.

**DNS-rebinding protection is a prerequisite, not a sub-task of this migration**
— it has its own section below, and that work stands on its own whether or not
the v2 move ever happens. Do not assume the boundary survives because the option
names still exist in v2; the check has to be re-established against whatever
enforces it there.

### DNS-rebinding protection is on a deprecated API — _pin it, then move it_ ✅

INV-6 item 3 used to be enforced by three `StreamableHTTPServerTransport`
options that `src/httpServer.ts` passed —
`enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins` — all three
marked `@deprecated` in the SDK. Both halves are now done: the behaviour was
pinned first (part 1), and the enforcement then moved to the endpoint boundary
(part 2) with those tests unchanged.

**It was never a live hole — say that plainly.** At `@modelcontextprotocol/sdk`
1.29.0 the options still fully enforced: `validateRequestHeaders` read all three
and returned a 403 on a bad `Host`. `loadHttpConfig` never leaves `allowedHosts`
empty (it defaults to `<host>:<port>` + `localhost:<port>` and appends the public
URL's host when `MCP_HTTP_PUBLIC_URL` is set), so the Host check really did run
in every deployment. Deprecated is not removed. What follows is the record of
how it was kept that way.

Two real problems, in the order they were fixed:

1. **Nothing pins the behaviour, so its removal would be silent ✅ — done
   first, it was the cheap half.** There was no test anywhere driving a hostile
   `Host` or `Origin` header; worse, the HTTP integration suite constructs its
   config with `allowedHosts: []` / `allowedOrigins: []`
   (`tests/httpServer.test.ts`), so those tests run with host validation inert.
   Meanwhile `package.json` floats on `^1.17.4` and Dependabot bumps weekly. A
   routine dependency bump that drops the deprecated path would therefore take
   INV-6 item 3 with it and **every test would still pass**. Add a regression
   test that starts the real server with a populated `allowedHosts`, sends a
   forged `Host` (and a listed vs. unlisted `Origin`), and asserts the 403 —
   independent of any migration. That single test converts an invisible
   dependency risk into a visible one.
2. **Then migrate off the deprecated options — it was not a drop-in swap ✅.**
   Landed with **2a**, which forced it: `createMcpHandler` has no
   DNS-rebinding option at all, so the modern leg would otherwise have been
   unprotected. Enforcement now sits in `rejectRebinding` in
   `src/httpServer.ts`, ahead of era routing, so one check covers both eras.
   The two mismatches, and how each was decided:
   - **Port semantics differ → strip the port, keep the env contract.** The old
     transport option compared the `Host` header _exactly, including the port_
     (entries like `127.0.0.1:8787`); the SDK's `validateHostHeader` compares
     the **hostname only, port-agnostic**. `MCP_HTTP_ALLOWED_HOSTS` carries
     `host:port`, so the values are normalized to hostnames at the boundary
     (`hostnameOf`) rather than the env contract being broken — existing
     operator env files keep working, and a bare hostname now works too.
     **D-M3A-HOST-PORT:** dropping the port from the comparison costs nothing,
     because the server listens on exactly one port and that is therefore the
     only port a browser could reach it on regardless of the allowlist. Pinned
     by a test, and documented in
     [`operations.md §2`](./operations.md#dns-rebinding-allowlist-mcp_http_allowed_hosts--mcp_http_allowed_origins).
     `hostnameOf` also brackets a bare IPv6 literal instead of truncating it at
     its first colon (which would have produced an empty, unmatchable entry);
     `loadHttpConfig` brackets an IPv6 bind host in the default for the same
     reason.
   - **D-M3A-HOST-USERINFO — a `Host` carrying userinfo is refused outright.**
     Hostname comparison relaxes one thing the exact match did not mean to
     allow: `Host: evil.example@127.0.0.1` parses to hostname `127.0.0.1` and
     passes the allowlist, while the header as written names another authority.
     RFC 9110 §7.2 is `Host = uri-host [ ":" port ]`, so an `@` is not legal
     here at all and no client sends one — refusing it costs nothing and
     restores what the v1 transport did by comparing verbatim. Measured before
     the check was added: such a request **passed the gate and returned 500**,
     because `toWebRequest` builds this request's URL from the same raw header
     and `new Request()` throws on a URL carrying credentials. That is the Fetch
     spec declining to construct an object two steps past the boundary, not this
     server declining to serve a request — the same reasoning as
     D-SCAN1-NOT-VULN, where an incidental guard was kept but not counted as the
     guard. Pinned by a test asserting the 403 **and** the `forbidden_host`
     code, so a downstream 500 cannot satisfy it.
   - **The middleware is Express-shaped → not used.** `hostHeaderValidation`
     returns an Express `RequestHandler` and there is no Express here. The
     Web-standard `validateHostHeader(hostHeader, hostnames)` is used directly
     instead, against the `Request` built by `src/webBridge.ts`.

   The Origin posture, now decided rather than inherited:
   - **D-M3A-ORIGIN-EXACT — Origin keeps EXACT full-origin comparison.** The
     SDK's `validateOriginHeader` is hostname-only like its Host counterpart,
     which for origins would stop distinguishing `https://x` from `http://x`.
     That is a real relaxation with no compensating benefit, so it was not
     adopted; the existing exact comparison is kept in-house and pinned.
   - **D-M1-ORIGIN-ABSENT stands unchanged** (already pinned as a named
     compatibility baseline): `allowedOrigins` defaults to empty so the check is
     skipped unless `MCP_HTTP_ALLOWED_ORIGINS` is set, and even when populated
     only a **present but unlisted** Origin is refused — a request with no
     `Origin` header passes. Defensible for a bearer-authed, non-browser client.
   - **Scope is still `/mcp` only**, as before: the OAuth endpoints are not
     behind the Host check. Unchanged by this move, and listed under continuity
     below rather than changed silently here.

**Doc coupling:** INV-6 item 3 in
[`mcp-vault-security`](../.claude/skills/mcp-vault-security/SKILL.md) and the
skill-firing row in [`CLAUDE.md`](../CLAUDE.md) both name the transport options
by name. Whichever PR moves the mechanism must update both in the same change,
or the canon will describe an API the code no longer uses.

### Frontmatter is bounded before it is parsed — _second security scan, root C_ ✅

Two independent quadratic paths run **while gray-matter parses**, both driven by
the size of the frontmatter block and both reachable from untrusted vault content
on the always-on read path: gray-matter's own comment stripper (`m`-flagged, so
every line start is a match position), and js-yaml's `!!omap` resolution —
**GHSA-5p4m-2wfm-xmqj**, a CVE in a **production** dependency reached as
`gray-matter > js-yaml`.

Measured, quadrupling per doubling in both: 391 KB of unterminated frontmatter
blocked for **101.8 s**; `!!omap` at 1,228 KB for 3.5 s. The unterminated case is
worst because gray-matter then treats the whole file as the block.

`parseMarkdown` refuses a block over **8 KiB** before `matter()` runs.

- **Nothing that inspects the parsed result can help** — the CPU is spent during
  the parse. The existing anchor/alias expansion guard runs after `matter()`
  returns and therefore never covered this. A block-size cap was correctly
  _rejected_ for that expansion bomb (a few hundred bytes tells you nothing about
  size) and is the right bound here. The two are complementary; neither replaces
  the other.
- **The `!!omap` path is fixed at the dependency; the comment stripper is not.**
  js-yaml **3.15.1** is patched and inside gray-matter's `^3.13.1` range, so
  `pnpm.overrides` pins it — no major upgrade, no API break. Measured on the
  resolved tree: 3.15.0 quadruples per doubling, 3.15.1 is linear. The bound
  still covers that path as defence in depth, but calling it _the_ mitigation
  would make an out-of-date js-yaml look acceptable. The comment stripper is
  gray-matter's own code and the bound is the only thing standing there. The two
  remaining advisories are dev-only.
  **Read an advisory's structured fields, not its title**: this record is titled
  "CVE-2026-59870 fix not backported" while its own `patched_versions` says
  `>=3.15.1`. The title is why an earlier revision of this entry said 5.x-only.
- **Sized from real data**, not from the attack: 2,381 notes, frontmatter median
  225 B, max 1,042 B. 8 KiB keeps ~7.9x headroom while holding the attack to
  ~41 ms — the _unterminated_ shape, which is the worst case and ~1.8x costlier
  than the terminated one at the same size. Absolute milliseconds are
  host-dependent (the same payloads run ~6x slower on a CI container); only the
  exponent transfers. Over-cap frontmatter fails loudly — logged and body-only on the
  read path, refused outright on the write paths.
- **Behaviour change:** kilobytes of `source_refs` in frontmatter are now
  refused, including the 900-ref session-archive index the tests used to pin as
  legitimate (66.2 KiB). No such note exists in the vault, and a hostile block
  that size costs ~3 s. Frontmatter carrying kilobytes of references is the
  design to revisit, not the limit.

**This is what the dependency audit was for.** Both full-tree scans dropped
`package.json` / `pnpm-lock.yaml` into `skipped_components`, and the scan that
did report the comment stripper wrote honestly that it could not confirm the
bound without executing the regex. The CVE was published the day before that scan
ran — and `pnpm audit` had been printing it in CI on every run.

**Printing is not reporting.** That audit step was `continue-on-error: true`, so
it was always green, and it mixed dev noise into the one signal that mattered.
The comment justifying that said triage happens in the Dependabot PR; Dependabot
alerts were enabled and showed **0 open alerts**, and `dependabot.yml`'s
`updates:` bumps _direct_ dependencies while js-yaml is transitive — so no PR
could be raised there either. A single detector, configured to be invisible, is
not a control. CI now fails on a **production** high (`pnpm audit --prod
--audit-level high`) and keeps the full-tree moderate scan advisory. Scoping the
blocking step to `--prod` is the point: dev noise is what turns a step into one
people stop reading. The threshold is a deliberate trade — a _moderate_
production advisory still passes.

### Document identity is not a frontmatter field — _second security scan, root A_ ✅

A second full-tree security scan (2026-08-07, against `85dc2c0`) reported nine
findings; two of them (its only `confidence: high` one among them) name the same
root cause, and this closes it. `readDocument` took `document.id` verbatim from a
file's own frontmatter — untrusted vault content per INV-5 — and `fetch()`
matched that id **before** the vault-relative path. One note declaring another
note's uuid, or another note's path, therefore answered every lookup aimed at
that other note: `fetch_document`, the ChatGPT `fetch` alias, `trace_sources`,
and the target `plan_document_update` stages its edit against. The last one is
the sharp end — two-step approval protects the approved **content**, never the
approved **target**, so an approved edit landed on the impostor.

Resolution now fails closed: a reference resolves only when it names exactly one
document across the id and path namespaces (`resolveUniqueReference`).

- **Not path-first**, which the scan recommended. Preferring the path would
  silently return a different document than the citation carrying that id
  pointed at — the mis-routing `MultiRootStore.fetch`'s id-first match was
  written to prevent, with the reasoning in a comment since multi-root landed.
- **Refusing costs reachability, which is accepted rather than denied.** A
  frontmatter `id` can be a vault-relative path — claiming one is the primary
  attack shape — so "just use the exact path" is not a recovery. A victim with
  its own uuid stays reachable by it; a note with **no** frontmatter `id` has
  only its path, and a squatter claiming that path leaves it unreachable. Both
  are pinned by tests, and the ambiguity error states the real remedy (remove the
  duplicate `id`) instead of naming a retry that lands on the same collision.
- **Two sites, not one.** `KnowledgeStore.fetch` and `MultiRootStore.fetch` both
  match id-first, and a squatter in the primary root shadows documents in the
  read-only roots — a collision only the composite can see. Pinned by one test
  driving both stores, and reverse-verified per guard: removing either call site
  alone turns its own scenarios red while the other store stays green.
- **The cost is stated, not hidden.** One planted file makes its victim
  unfetchable too, so this is a loud denial of service where it used to be a
  silent content swap. Loud and broken beats silent and wrong, and the error
  names the colliding documents by relative path (never `absolutePath`) so the
  duplicate is fixable.

The remaining scan findings are tracked outside this repo and land as their own
nodes.

### A constrained write surface cannot author an identity — _root A, write side_ ✅

The half above stops the read side honouring a forged `id`. This stops the
surfaces that choose a file's **bytes** from planting one, and it moves INV-8 /
INV-9 rather than INV-2 — which is why it is a separate change.

Three findings, two surfaces. `append_audit_report` and
`compare_and_swap_audit_state` write their payload verbatim; a Skill bundle's
reference files do the same. Both were designed narrow about **where** they may
write and said nothing about **what**. So INV-9's guarantee that injection stays
confined to the audit subtree held for where the bytes land and not for whose
identity the read side then answers with: a principal holding audit-write alone
could name any note in the vault. `SKILL.md` was already pinned to
`name`/`description`; its reference files were the gap.

`assertNoServerOwnedFrontmatter` refuses `id` and `updated_at` in client-chosen
content.

- **One helper at each store's choke point**, not the same test written three
  times: `assertWritableText`, which both audit writers already pass through,
  and `validateFileSet`, where the Skill plan and apply paths meet. A first
  attempt sat in `validatePlannedFiles` — reached by apply, not by plan — and
  the test asking for refusal at _plan_ time is what caught it. Refusing only at
  apply would still block the write, but only after showing an operator a diff
  to approve; the squat has to be unrepresentable, not merely unapplied.
- **Bounded parse on a write surface.** Knowing what content claims requires
  parsing it, and these callers accept up to 512 KiB — so the check goes through
  `parseMarkdown`, whose block cap runs before gray-matter. Without it the
  test's own payload costs ~286 s (measured 469 / 1,847 / 7,336 ms at 16 / 32 /
  64 KiB). The test therefore asserts elapsed time, not just the throw.
- **Unparseable frontmatter is refused, not waved through.** The read path
  degrades because it has an existing note it must still serve; a writer has no
  such obligation, and storing metadata the server cannot read is how a file
  comes to mean one thing on write and another on read.

### The error channel is a response surface — _second security scan, root E_ ✅

Document responses have always been built from an explicit allowlist
(`toPublicDocument`), so a field added to the internal shape is not published
until someone publishes it. **Errors had no such boundary.** A Node
`ErrnoException` carries `path`, `dest` and `syscall`, and throwing one out of a
tool handler serialized the host's absolute filesystem layout to the client —
the same layout `absolutePath` was removed from document responses to hide.

Fixed by extending the allowlist principle to the error channel rather than by
catching at each known leak site. `withClientSafeErrors` wraps each store once,
at the single place the server builds them, and replaces **any** system error
with one naming only its `code`; the original is kept as `cause` for the server's
own logs. The scan proposed per-site catches and had itself counted only two of
the four sites that leak — which is the argument against enumerating the bad
rather than constraining the subject: a denylist is only ever as complete as the
survey behind it, and the survey was already wrong.

The one place that still reads a raw errno is `KnowledgeStore.readPatchFile`,
which turns `ENOENT` into "no staged patch with that patch_id" — a distinction
the client needs and which reveals nothing about layout. It reads the code
before the wrapper sees the error, so the guarantee is unchanged.

### Exact-path document creation — _safe write-back_ ✅

The original `create_document` intentionally routes new notes to
`projects/<client>/<project>/<slug>.md`, which is useful for capture but cannot
write back into an existing vault taxonomy. The exact-path flow is now complete:

- `plan_document_create` stages the complete Markdown file and diff without
  creating the target or its parent directories.
- The plan returns `保存先は「…」でよろしいですか？` with a `はい` option and
  free-text correction. A correction means **plan again**; apply cannot silently
  substitute another path.
- `apply_planned_document_create` requires the caller to echo that exact
  confirmed path, verifies staged-content integrity, re-runs path/symlink
  containment, and publishes with `wx` so an existing note is never overwritten.
- Multi-root deployments allow the primary root only. HTTP remains off by
  default and uses the existing `MCP_HTTP_ALLOW_WRITE` + `vault.write` boundary.
  ⚠️ **That second condition is real for OAuth clients and vacuous for the
  static bearer**, which is granted `vault.read vault.write` unconditionally
  (`authenticate()` in `src/httpServer.ts`). On a bearer-only endpoint this
  flag is the **only** thing standing between a caller and a write — treat it
  as a single gate, not two. Tracked below under "Scope the static bearer,
  instead of granting it everything" and analysed in
  [`policy-provenance.md`](./policy-provenance.md).
- Synthetic store tests and an in-memory MCP E2E pin the confirmation payload,
  no-plan-side-effects rule, traversal/symlink/collision failures, and read-back.

---

### The overwriting write is atomic, serialized, and the last one-step write is gated — _external review triage_ ✅

An independent review of `main` at #105 (Codex, 2026-08-11 JST) landed three code
findings. All three were verified against the source before being accepted, and
one of them was accepted with its severity **lowered**, not raised.

**1. `applyPlannedUpdate` was neither atomic nor strictly compare-and-swap.** It
read the target, hashed it, compared against the plan, then `writeFile`d over the
target — truncate-then-write, with no second copy of the note to recover from.
The repo was already inconsistent with itself here: `auditStore`, `skillStore`
and the OAuth state file all wrote temp-then-rename; the only write that
overwrites a _user's_ note did not. `src/atomicWrite.ts` now performs a
same-directory temp write, copies the target's permission bits, and renames over
it. The read/hash/write window is closed by an in-process serializer of the same
shape `AuditStore` already used — INV-9 had described that window as
"`applyPlannedUpdate`'s", so the window was known and simply never closed for the
general path. **Scope stated rather than overclaimed:** atomic ≠ durable (no
`fsync`, matching the other three writers), and in-process ≠ cross-process (two
connector processes on one vault still race and need an on-disk lock).

**2. The parse cache could serve a stale note indefinitely.** Validity was
`mtimeMs` + size, which cannot distinguish two writes inside one millisecond and
is fully defeated by an editor or sync client that rewrites a note to the same
length and restores its mtime (`utimes` lets anything do that). The signature is
now `mtimeNs` + `ctimeNs` + `ino` + size; `ctimeNs` carries it, because userspace
cannot set it. `planUpdate` additionally derives the planned frontmatter from the
bytes `expected_sha256` covers instead of from the cached parse.

> The review framed this second half as a plan that "may reuse old frontmatter".
> Verified: the diff and `expected_sha256` were always computed from a fresh
> read, so such a revert appeared **in the diff the approver saw**. Real bug,
> visible rather than silent — and a two-step write must not rely on the reviewer
> catching it. Recorded because the correction is the reason the fix is small.

**3. `create_document` was the one document write with no plan/apply pair**, and
on stdio it was always registered. Now behind `MCP_ALLOW_LEGACY_CREATE_DOCUMENT`,
off by default on **both** transports (one variable, not the audit surface's
per-transport pair: the replacement exists everywhere, so no deployment needs it
on one transport only). `scripts/check-http.mjs` scores it as its own category,
so an endpoint exposing it without the flag now **fails** the operator check
instead of being silently permitted under general write.

> **Severity lowered vs. the review.** The review left open what an unapproved
> create could reach. Verified: `createDocument` builds the entire frontmatter
> server-side, `id` included (`crypto.randomUUID()`), so it cannot squat another
> document's identity (INV-2); `flag: "wx"` means no overwrite; the path is
> routed, not caller-chosen. The residual is **persistence** — attacker-chosen
> body text landing under `projects/` with no approval step, read back as
> ordinary vault content (INV-5) by every later session. That is worth gating;
> it is not identity capture.

Reverse-verified per guard, one at a time: reverting the rename fails only the
inode assertion; removing the serializer makes **both** concurrent applies
succeed (the lost update); weakening the signature to `mtimeNs` + size serves the
stale body; removing the gate puts `create_document` back on both stdio eras.
The cache test needed a **second** attempt to be worth anything — the first
restored a previously observed mtime, which `utimes` truncates, so it passed with
the guard removed. It now freezes the mtime to a whole second on both sides.

### The scan costs syscalls, not bytes — _measured, then narrowed_ ✅

Every read tool walks the whole vault through `listDocuments()` — still true
after this change for `fetch` / `trace_sources` / `list_projects` and for an
**unprefixed** `search_documents`; a prefixed search now prunes (see below).
What that costs was argued from operation counts for a long time and finally
measured, on the real 2,880-note vault (47.4 MB of Markdown, iCloud Drive, macOS):

| | measured |
| --- | --- |
| tree walk (`find`, 670 directories) | 0.155 s |
| `stat` on all 2,880 notes | 0.864 s |
| `cat` of all 2,880 notes (47.4 MB) | 1.098 s |

**Reading every byte costs 0.23 s more than merely stat-ing them.** The bytes are
almost free; the per-file syscalls are the bill. That inverted the plan twice
over, and both wrong turns are worth keeping:

- _"Narrow the default scan to the folder that changes most"_ — the folder that
  absorbs nearly all edits holds **6.3 %** of the notes, while one archive folder
  holds **58.5 %**. Cost concentrates where writes do not.
- _"Excluding the asset folder is free money"_ — it holds 0 Markdown files but
  only **19 of 670** directories. Large in bytes, negligible in walk cost. Both
  claims were made before measuring, which is the failure the numbers above exist
  to stop repeating.

Two changes followed, neither of which narrows anything by default:

- **`path_prefix` now prunes the walk.** It was already a search filter, applied
  after the walk had read every note. It is now also handed to the walk, which
  skips subtrees that provably cannot contain a match. `searchDocuments` stays
  the authority, so the prune only has to be conservative — and `fetch`,
  `trace_sources` and `list_projects` deliberately keep scanning everything,
  because id uniqueness (INV-2) and backlink completeness are wrong, not merely
  short, when computed over a subset.
- **A cache hit no longer re-resolves the path.** `readDocument` ran `realpath`
  before consulting its cache, thousands of times per call; every caller already
  runs the full INV-1 chain on the same call, so it looked like a second
  resolution of an already-resolved path. **Tried, then reverted before merge**
  — see below. The signature did keep `dev` beside `ino`, as a freshness field.

**No new tool, no new env flag, no changed default.** The rejected alternative —
making one folder the default scan target with a prompt to widen it — bought the
same speed by hiding **about 94 %** of the notes (the folder that absorbs nearly
every edit holds 6.3 % of them), and would have made unattended scans depend on
an interactive answer.

**Why the cache half was reverted.** "Validated on the same call" is not
"validated at the same instant": the walk collects paths and the reads happen
afterwards. Move a directory out of the root in that window and symlink it back,
and the child file's own `dev`, `ino`, `ctime` and `mtime` are **all untouched**
— a parent's rename does not move a child's ctime — so a stat-signature check
matches across a genuine escape and returns Markdown for a path that no longer
resolves inside `KNOWLEDGE_ROOT`. Two independent reviewers found it (Codex as a
P1, CodeRabbit as merge-blocking). The bytes served in that window were ones the
server had already validated and cached, so nothing new was disclosed — but
INV-1 says every file access stays under the root, and "true except during a
window" is a weaker invariant than the one this repo committed to. Closing it
properly needs fd-based containment (`openat` / `O_NOFOLLOW` per component) that
Node does not portably expose, so the per-read `realpath` stays until that
exists. **The prune, which is the larger measured win, was never in question.**

Reverse-verified per guard: removing the cache-hit signature check fails four
tests including both freshness tests; dropping `subtreeMayMatch`'s
prefix-reaches-deeper clause fails the partial-segment test. The third guard
**failed its first reverse verification** — with the directory prune disabled
entirely every test stayed green, because the assertions counted file opens and
the per-file check alone already suppressed those. The two halves of the prune
are measured by different syscalls (`open` for a skipped file, `readdir` for a
skipped subtree); the test now counts both. The `dev` field is **not**
reverse-verifiable here — separating two devices needs a mount — and is recorded
as unverified rather than assumed.

Still open: an unprefixed search pays the full scan, so the
[inverted index](#context-engineering-layer--get_context--link-graph--project-state-)
tail is nearer than its "> 10k notes" trigger suggests — its **other** trigger,
search p95 over 200 ms, is already met at 2,880 notes.

---

## Mid-term

### Hosting recipes 💭

Turn [`operations.md`](./operations.md) into runnable recipes: a named-tunnel +
systemd bundle, a container image, and a one-page "deploy to a $5 VPS" guide.

### Observability 💭

Minimal, privacy-preserving operational signals (health endpoint, structured
logs that never include note content or secrets) to make "is it up?" obvious.

---

## Larger bets (need validation)

### Multi-user / team sharing 💭

Out of scope for 0.1.0 (single-user by design). Would require per-user auth,
token persistence, and a per-user scoping model — a significant change to the
OAuth and store layers. Pursue only if demand is validated.

### Additional knowledge sources 💭

Beyond a single `KNOWLEDGE_ROOT` Markdown vault (e.g. multiple roots). Each new
source must pass the same path-containment and untrusted-content guarantees.

---

## Security & enterprise maturity gaps (not yet addressed)

v0.1.0 hardens the **single-user, local-first** case (path containment, two-step
writes, OAuth PKCE/audience/scope, SHA-pinned CI). It does **not** yet cover the
following — listed honestly so adopters can judge fit. Most are prerequisites for
_team / enterprise_ adoption rather than the core individual use case.

| Gap                                                          | Why it matters                                                                                                                                                                                                                                                                                                                                                     | Tier                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Third-party penetration test**                             | Self-review + AI review have limits; an independent test is needed before security claims are load-bearing.                                                                                                                                                                                                                                                        | near-term 🔭                                                                                                                                                                                                                        |
| **Audit log**                                                | No after-the-fact record of who searched / fetched / wrote what.                                                                                                                                                                                                                                                                                                   | near-term 🔭                                                                                                                                                                                                                        |
| **macOS CI**                                                 | The primary deployment target is macOS, and CI runs only on Linux. Case-insensitive-filesystem behaviour is therefore **asserted nowhere**: the `(dev, ino)` root-containment comparison exists precisely because `/vault` and `/Vault` are one directory on APFS, and a test for that shape is vacuous on ext4. NFD normalisation (HFS+) is in the same position. | near-term 🔭                                                                                                                                                                                                                        |
| **Coverage thresholds**                                      | 564 tests is a count, not a floor. Nothing fails when a new branch arrives untested, which is the condition the reverse-verification rule exists to catch by hand — a threshold makes the cheap half automatic.                                                                                                                                                    | near-term 🔭                                                                                                                                                                                                                        |
| **No connection limit or rate limit on the HTTP endpoint**   | `http.createServer` is left at its defaults, and this repo sets nothing: no `maxConnections`, and no rate limit on `/mcp` (the two limiters cover only the public OAuth endpoints). ⚠️ **Node's own timeout defaults DO apply** — `requestTimeout` 300 s, `headersTimeout` min(60 s, requestTimeout), `keepAliveTimeout` 5 s; the one genuinely unset is `server.timeout` (socket inactivity, default 0). The ceiling on concurrent agents is therefore the process file-descriptor limit, not anything this repo chooses — and an unprefixed read still walks the whole vault at `MCP_SCAN_CONCURRENCY` handles, so it is that limit divided by the scan width. | near-term 🔭                                                                                                                                                                                                                        |
| **Filesystem fault injection**                               | Write paths are now atomic, but no test exercises `ENOSPC`, `EIO`, or a kill between temp write and rename. The recovery behaviour is argued in comments and unverified in CI.                                                                                                                                                                                     | mid-term 💭                                                                                                                                                                                                                         |
| **Fuzz / property tests**                                    | `pathSafety` and the frontmatter parser take adversarial input and are pinned by enumerated cases only, so they are strong exactly where someone already thought to look. Property tests would search the space the enumeration misses.                                                                                                                            | mid-term 💭                                                                                                                                                                                                                         |
| **Multi-user RBAC**                                          | Currently single-user by design; teams need per-user roles & scoping.                                                                                                                                                                                                                                                                                              | larger bet 💭                                                                                                                                                                                                                       |
| **Hardened secret scanning / release-artifact verification** | Needed if OSS distribution (npx / prebuilt binaries) is pushed harder — provenance, signed artifacts, SBOM.                                                                                                                                                                                                                                                        | mid-term 💭                                                                                                                                                                                                                         |
| **OpenTelemetry / structured audit events**                  | Required for enterprise observability and SIEM ingestion.                                                                                                                                                                                                                                                                                                          | mid-term 💭                                                                                                                                                                                                                         |
| **DLP / exfiltration detection**                             | No control over leakage _of vault content_ once a client is authorized.                                                                                                                                                                                                                                                                                            | larger bet 💭                                                                                                                                                                                                                       |
| **Sandbox isolation**                                        | If the MCP server process itself is compromised, isolation from the host is limited.                                                                                                                                                                                                                                                                               | ✅ layers 1–3 documented → [`operations.md`](./operations.md#sandbox-hardening-systemd) (systemd) + [§6](./operations.md#6-sandboxing-the-local-stdio-server-bwrap-optional) (bwrap); residual: operator-applied, not code-enforced |
| **Formal threat model document**                             | `SECURITY.md` is good but was not a systematic STRIDE/LINDDUN-style model.                                                                                                                                                                                                                                                                                         | 🚧 → [`threat-model.md`](./threat-model.md) (STRIDE) added; revisit as features land                                                                                                                                                |

**Suggested sequencing:** start with the cheap, high-signal items —
(1) a **formal threat model** (STRIDE) to make the gaps explicit and prioritize
the rest — ✅ drafted in [`threat-model.md`](./threat-model.md); next
(2) **RFC 9207 `iss`** (see the 2026-07-28 section), which is cheap on its own
and settles what `client_id` means before anything keys on it; then
(3) an **audit log** (append-only, content-free events) which also seeds later
OpenTelemetry work, then (4) commission a **third-party pen test** now that the
threat model exists. RBAC / DLP / sandboxing are larger bets gated on validated
team-adoption demand.

### Sandbox isolation — intended layering

Discussed and deferred (consultation only so far). For **this** product the goal
is to limit blast radius **if the server process itself is compromised** — a
defense-in-depth layer on top of the app-level path containment (INV-1), which
already confines normal file access to `KNOWLEDGE_ROOT`. Two contexts are easy to
conflate: (a) sandboxing the _AI coding agent_ that runs shell commands — a dev-
workflow concern; (b) sandboxing _this MCP daemon_ — the gap here.

Recommended layering, cheapest first:

1. **systemd hardening (primary, for the long-running HTTP daemon)** — extend the
   unit in [`operations.md`](./operations.md): `ProtectHome=true` (hide
   `~/.ssh` / `~/.aws` / `.env`), `PrivateTmp=true`, `ProtectSystem=strict` with
   a tight `ReadWritePaths`, `NoNewPrivileges=true`, empty
   `CapabilityBoundingSet=`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
   `SystemCallFilter=@system-service`, `MemoryDenyWriteExecute=true`.
2. **Network minimization** — `PrivateNetwork=true` for the stdio case (no
   outbound at all); loopback-only suffices for HTTP.
3. **bwrap recipe (optional, for local/stdio)** — `--ro-bind` only
   `KNOWLEDGE_ROOT` (read-only when deployed read-only), `--unshare-net`, hide
   secret dirs. Caveat: needs unprivileged user namespaces, which **Ubuntu 24.04
   restricts via AppArmor** — more portable for one-shot commands than for a
   daemon, so prefer systemd for the daemon.

Rationale: bwrap shines at wrapping single commands; a persistent daemon is
better served by systemd's built-in sandboxing (more portable, fewer userns
caveats).

**Status:** all three layers are now documented in `operations.md` — layer 1+2
in the [systemd hardening drop-in](./operations.md#sandbox-hardening-systemd)
(incl. the `PrivateNetwork` note for stdio units), layer 3 in the
[bwrap recipe (§6)](./operations.md#6-sandboxing-the-local-stdio-server-bwrap-optional).
Isolation remains **operator-applied** (docs, not code-enforced).

---

## Ready to pick up next (continuity)

Concrete, low-risk items teed up for a future session (in rough priority order):

- [x] **systemd full-hardening block** in `operations.md` (the layer-1 list
      above) — ✅ added as a drop-in (`ProtectHome` / `PrivateTmp` /
      `ProtectSystem=strict` + tight `ReadWritePaths` / empty
      `CapabilityBoundingSet` / `RestrictAddressFamilies` /
      `SystemCallFilter=@system-service` / `MemoryDenyWriteExecute`), with the
      Node/V8-JIT and home-dir-vault caveats and a `systemd-analyze security`
      verify step. Ships the first, cheapest slice of "sandbox isolation".
- [x] **bwrap recipe** + userns/AppArmor caveat in `operations.md` (layer 3) —
      ✅ added as §6: client-spawned wrapper script (`--ro-bind` only the app +
      vault, `--unshare-all`, `--clearenv`, secrets invisible by construction),
      the Ubuntu 23.10+/24.04 AppArmor/userns caveat, and "prefer systemd for
      the daemon" guidance.
- [x] **Regression test for DNS-rebinding (INV-6 item 3)** — ✅ pinned in
      `tests/httpServer.test.ts`: forged `Host` (sent via `node:http` — `fetch`
      silently drops it) → 403 with a genuine-Host control, allow-listed vs.
      unlisted `Origin` on a server with `allowedOrigins` populated, and the
      absent-Origin pass-through pinned **as a named compatibility baseline**
      (a revisitable decision, not an invariant — flipping it to reject is a
      deliberate design change that updates the test alongside). Red-green
      verified: disabling `enableDnsRebindingProtection` fails exactly the two
      boundary tests. A dependency bump that drops the deprecated transport
      options now fails loudly instead of silently removing the protection.
- [x] **Migrate off the deprecated DNS-rebinding transport options** — ✅ landed
      with **2a**, which forced it (`createMcpHandler` has no such option, so the
      modern leg would otherwise be unprotected). Enforcement is now
      `rejectRebinding` in `src/httpServer.ts`, ahead of era routing, so one
      check covers both eras: Host via the SDK's `validateHostHeader` with the
      `:port` suffix stripped from allowlist entries (**D-M3A-HOST-PORT** — the
      env contract is preserved, not broken), Origin kept as an **exact**
      full-origin comparison in-house (**D-M3A-ORIGIN-EXACT** — the SDK's
      hostname-only validator would stop distinguishing `https` from `http`).
      The pinning tests from the item above are unchanged across the move, which
      is the evidence. INV-6 item 3 in the `mcp-vault-security` skill, the
      `CLAUDE.md` firing row, `threat-model.md` and the `MCP_HTTP_ALLOWED_HOSTS`
      docs in `operations.md` were updated in the same PR.
- [ ] **Decide whether the Host check should also cover the OAuth endpoints** —
      it covers `/mcp` only, unchanged from the transport-option era and
      deliberately left alone by the move above rather than widened silently.
      Widening it is a behaviour change for anyone whose tunnel host is not in
      the allowlist (`loadHttpConfig` adds `MCP_HTTP_PUBLIC_URL`'s host, so the
      supported setups are covered — but an unsupported one would start failing
      at `/authorize` instead of `/mcp`). Cheap; needs its own red-green test.
- [ ] **Give the HTTP server explicit connection and request limits** — measured
      at `e91c1c8`: `src/httpServer.ts` calls `http.createServer` and `listen`
      without setting `maxConnections` or `server.timeout`, and the only rate
      limiters in the process are the OAuth ones (`authorize` 20/5min,
      `register` 20/10min). `/mcp` itself has neither. ⚠️ **Node's `requestTimeout`
      (300 s), `headersTimeout` (min 60 s) and `keepAliveTimeout` (5 s) defaults
      DO apply** — an earlier draft of this item said otherwise; only
      `server.timeout` (socket inactivity) is genuinely 0.
      What _is_ bounded is request memory (`MAX_BODY_BYTES` = 4 MiB) and scan
      width (`MCP_SCAN_CONCURRENCY`, default 24).

      **Why it matters more here than for a typical service:** the endpoint is
      sessionless and shared, so N agents can be in flight at once, and every
      read tool (`fetch_document` / `search_documents` / `plan_document_update`)
      still walks the entire vault through `listDocuments()`. N concurrent scans
      therefore want N × 24 descriptors, which makes the effective ceiling
      `ulimit -n` divided by the scan width rather than a number this repo picked.
      Exhaustion degrades rather than crashes — `EAGAIN` / `EMFILE` / `ENFILE`
      are retried with backoff and unreadable notes are skipped — but that is
      resilience arrived at from below, not a limit chosen from above.
      ⚠️ **That sentence was only half true when written.** The retry lived in
      the read stage; the walk that finds the notes had none, so the same errno
      that was patiently retried while reading aborted every read tool while
      walking. Both stages retry now, and one unreachable entry no longer takes
      the scan down — but the ceiling this item describes is unchanged, because
      resilience below is still not a limit above. What is
      genuinely unbounded is socket inactivity (`server.timeout` = 0) and the
      number of concurrent connections, not request or header time.

      **Scope note:** this is availability, not confidentiality — bearer/OAuth
      still gates every request, and the per-request tool surface is unaffected.
      Pair it with the walk itself: a cap that merely rations a full-vault scan
      per call is treating the symptom, so this belongs near the retrieval work,
      not on its own. 🚧 The scan half moved first (see the section below): a
      prefixed search no longer scans the whole vault. (The cache-hit half was
      tried and reverted before merge — see that section.) The unprefixed scan is
      unchanged, so the ceiling this item describes still stands.

      **What is _not_ in scope here:** a plan is looked up by `patch_id` alone
      and is not bound to the principal that staged it, so on a shared endpoint
      one agent can apply a plan another agent staged. The id is a v4 UUID that
      appears only in the staging response, so this is not reachable by guessing
      — but "the approving agent and the applying agent are the same" is not a
      property the code states. Related to the vault-binding item below and worth
      settling with it; both are INV-3 changes and neither should ride along with
      a limits patch.
- [ ] **Bound the staged-plan set by count or bytes, and give a way to discard
      one** — 🔭 the two halves of the plan-retention problem that the seven-day
      TTL does **not** close, written down so "F4 is done" does not quietly cover
      them. Inside the window a client may stage without limit, and each plan
      holds vault plaintext outside the vault.

      **They have to be decided together, which is why neither is in the TTL
      patch.** Every eviction policy available without a discard tool is worse
      than the unbounded window: dropping the oldest plan silently deletes one
      the user may be seconds from approving, and refusing to stage past a cap
      locks the client out with no way to clear the set — the only way to remove
      a plan is still to perform the operation that was just declined. A
      `discard_plan` tool fixes both, and it is a **tool-budget decision**, not a
      free one. ⚠️ **As of 0.9.0 the budget is spent**: `registerTool` is called
      **17** times and `docs/context-engineering.md` caps the net surface at
      15 → 17, with both reserved slots taken by `get_context` (`9e2c914`) and
      `get_project_state` (`de9021c`). Adding `discard_plan` is therefore a
      decision to **exceed** the documented cap, not to spend a reservation — a
      strictly heavier call than when this item was written. Spending a budgeted
      slot inside a bug fix is the drift the ROADMAP firing rule exists to prevent.

      For comparison, the OAuth store has capped + pruned collections *and*
      orphan pruning, so the asymmetry between the two state stores is real and
      deliberate rather than an oversight.
- [x] **RFC 9207 `iss` in the authorization response** (`src/oauth/`) — ✅ the
      `authorizePost` success redirect (the only redirect the AS emits — error
      paths render a 400 page precisely so codes cannot leak via redirects, so
      "iss on error responses" is N/A by construction) now carries
      `iss=<issuer>`, and `authorizationServerMetadata()` advertises
      `authorization_response_iss_parameter_supported: true` — the pair changes
      together per SEP-2468. Pinned in `tests/oauth.test.ts` (code-issuance
      redirect, metadata flag, and the HTTP E2E). The sequencing note stands:
      the same revision deprecates DCR for CIMD, which makes `client_id` a
      _stable_ identity — revisit the `client_id` appendix **before** building
      the audit log's attribution on it.
- [ ] **Bind a two-step plan to the vault that staged it** — `applyPlannedUpdate`
      looks a plan up by `patch_id` alone and resolves its `target_path` against
      whichever root the running store has; the plan record does not say which
      vault it was staged for. Two servers sharing a plan directory can therefore
      cross over. The default directory is now derived per primary root, so they
      no longer share one by accident, but an explicitly shared
      `MCP_PATCH_STATE_DIR` still can. Record the originating primary root in the
      plan and verify it at apply. Treat as a **security-boundary change** (INV-3:
      it alters the on-disk record and the apply-time checks) and land it on its
      own, not bundled with unrelated fixes. Note what already limits it: apply is
      stale-safe, so a cross-vault write needs the same relative path to exist in
      the second vault with byte-identical pre-edit content. Raised by CodeRabbit
      on #86, which withdrew its CWE-639 classification — both instances run as
      the same user, so this is vault confusion, not an authorization bypass.

      **Two notes from the policy/provenance review** (see
      [`policy-provenance.md`](./policy-provenance.md)):

      - **This item is the vault half only.** The principal half — a plan is not
        bound to whoever staged it — is the separate item above, and the two
        should stay separate: same invariant, different boundary.
      - ⚠️ **Do not justify rejecting an unrecorded plan with "the seven-day TTL
        drains them anyway."** The sweep is **staging-driven**: `patchState.ts`
        says in as many words that a server which stays up and stages nothing
        more never sweeps again. The conclusion (reject) is right and the TTL
        argument would make it *look* time-bounded when it is not — **a window
        that does not close on its own is a reason to reject, not to warn.**
- [x] **Frontmatter `id` can no longer impersonate another document (INV-2)** —
      ✅ `fetch` fails closed when a reference names more than one document
      across the id and path namespaces, at **both** `KnowledgeStore.fetch` and
      `MultiRootStore.fetch`. Path-first resolution was rejected (it re-creates
      the mis-routing the composite's id-first match prevents); the exact
      vault-relative path stays the unambiguous handle. Reverse-verified per
      guard. See the root-A section above.
- [x] **Bound the frontmatter block before parsing it (root C)** — ✅ 8 KiB cap
      in `parseMarkdown`, ahead of `matter()`. Closes both the `m`-flagged comment
      stripper and **GHSA-5p4m-2wfm-xmqj** (`gray-matter > js-yaml`, a production
      dependency the 5.x fix cannot reach). Sized from the real vault, not the
      attack. See the root-C section above.
- [ ] **Revisit frontmatter that carries kilobytes of references** — the
      session-archive index shape (900 `source_refs`) no longer parses. Nothing in
      the vault produces one today, so this is a design question rather than a
      regression: an index note should point at a list, not inline it. Belongs
      with the `session-archive` work, not with the parser.
- [x] **Dependency audit as a standing habit, not a scan deliverable** — ✅ both
      full-tree scans dropped the manifests, and the one CVE that mattered was
      printed by `pnpm audit` on every CI run. The framing "read as noise" was
      wrong: the step was `continue-on-error`, so it was **always green**, and it
      deferred to a Dependabot PR that could not exist (alerts enabled with zero
      open; `dependabot.yml` bumps direct dependencies, the package was
      transitive). CI now fails on a production high and keeps the full-tree scan
      advisory; the two known dev highs were fixed so the next line printed there
      is news. See the root-C section above.
      ✅ `docs/dependency-policy.md` has since landed with the decision tree —
      including when `pnpm.auditConfig.ignoreGhsas` is legitimate (only when no
      patched version exists, established from `patched_versions` and not from an
      advisory's prose). **First applied in 0.8.0**, and the first application is
      what showed the tree had a hole: it sorted on production-vs-dev, but two of
      the four dev bumps were `oxlint` and `typescript-eslint` — the CI checks
      themselves. A bump to a checker has to be run, not reasoned about, or the
      update is a change nothing checked.
- [x] **Constrain what the audit / Skill-reference write surfaces may author** —
      ✅ `assertNoServerOwnedFrontmatter` refuses `id` and `updated_at` in
      client-chosen content, from one choke point per store
      (`assertWritableText`, `validateFileSet`) rather than three copies. Landed
      on its own as an **INV-8/INV-9** change. The Skill check sits where plan
      and apply both end, so a squat is unrepresentable rather than merely
      unapplied. See the write-side root-A section above.
- [x] **Keep host filesystem layout out of client-visible errors (root E)** — ✅
      `withClientSafeErrors` wraps each store at the single point the server
      builds them, so a system error reaches the client as its `code` alone.
      Chosen over the scan's per-site catches because the scan had found two of
      the four leak sites. See the root-E section above.
- [x] **Server state may not be written inside a knowledge root** — ✅
      `MCP_OAUTH_STATE_FILE` and `MCP_PATCH_STATE_DIR` (**including the derived
      default**) are checked at boot by `(dev, ino)` identity, with symlinks
      followed component by component so a dangling link into the vault is caught
      before its destination exists. `MCP_ENV_FILE` was deliberately **not**
      covered by this change: it is read before the roots are known, so the same
      mechanism could not reach it, and it was recorded as unhandled rather than
      half-handled. **That exception is now closed** — the item below carries the
      later check, which runs after the roots resolve rather than at the read.
      See the OAuth-persistence section above.
- [x] **Bring `MCP_ENV_FILE` under the same containment rule** — ✅ `loadConfig`
      checks it against every root with the same `(dev, ino)` walk the three
      siblings use, and refuses to start if it resolves inside one. The rule *a
      policy source must not live inside the data plane it governs* now holds
      everywhere it applies.

      **The option this entry recorded as "unevaluated, not rejected" is the one
      that shipped.** A check placed where the file is READ still cannot work —
      `loadEnvFile()` runs before `KNOWLEDGE_ROOT` exists, because the file is one
      of the things that can supply it — so the check runs one step later, after
      `loadConfig` resolves the roots and before any store is built.

      **What it does not buy, stated because the difference is material.** By the
      time it fires the file has been read and its secrets are in `process.env`,
      and a file sitting in an indexed root may already have been read by anything
      with vault access. `MCP_OAUTH_STATE_FILE` fails *before a write*; this fails
      *after a read*. It refuses to keep serving on credentials a vault reader may
      already know — it does not prevent the disclosure, which is why the error
      tells the operator to rotate rather than to relocate and reuse.

      **Reverse-verified**, and the first attempt was not clean: with the guard
      disabled, three of the four rejection tests failed on "did not throw" while
      the fourth failed on a *message mismatch* — its patch-state directory sat
      inside the root that test promotes to primary, so a different guard was
      throwing. Fixed by giving that test its own directory; all four now attribute
      to this guard. The two remaining tests (a file outside the vault, and the
      variable unset) stay green under the mutation, which is what makes them the
      false-positive half rather than more of the same.

      **Priority input, as recorded before the change and still worth keeping:**
          no deployment was *known* to set `MCP_ENV_FILE`, and
          the evidence behind that covers **one host, as of 2026-08-10** — the
          unattended scan endpoint, whose launchd plist carries an empty
          `EnvironmentVariables`, whose `launchctl getenv` reports every relevant
          name unset, and whose cwd-relative `.env` path has been retired.
          [§9](./operations.md#9-two-endpoint-deployment-interactive--unattended-audit-scan)
          describes a **two-endpoint** layout and tells operators to add
          `MCP_ENV_FILE` to *both* plists; **the interactive endpoint's plist was
          not inspected.** So this is one scope observed out of at least two, not an
          inventory. On that evidence nobody is known to be standing on the
          question yet, and the migration that starts using `MCP_ENV_FILE` is the
          deadline for answering it — but the observation should be re-taken, and
          widened to every endpoint, before it is leaned on again.

      **★ The rule this item was the last exception to** (from
      [`policy-provenance.md`](./policy-provenance.md)): *a policy source must not
      live inside the data plane it governs.* It was never a proposal — it was
      already enforced for `MCP_OAUTH_STATE_FILE`, for `MCP_PATCH_STATE_DIR`
      including its derived default, and for `MCP_CONTEXT_TYPE_RULES`, whose
      `.env.example` entry states the reasoning plainly: a root is synced and
      writable, so a file inside one is a file anything able to write a note gets
      to edit. `MCP_ENV_FILE` was the one place it had not reached, and the reason
      was ordering rather than disagreement. Framing it that way is what set the
      priority: this was finishing a rule, not opening a question. **With this
      item the rule has no remaining exceptions.**

- [ ] **Scope the static bearer, instead of granting it everything** —
      `authenticate()` (`src/httpServer.ts`) returns
      `{scopes: [vault.read, vault.write]}` **unconditionally** once
      `MCP_AUTH_TOKEN` matches, so `surfaceFor`'s scope half is a constant on that
      path and the server-side `MCP_HTTP_ALLOW_*` flag is the only thing gating a
      write. An OAuth token is scope-bound (`record.scope`); the static bearer is
      not scopeable at all. There is no way to hold a **read-only** static token,
      or to run write-enabled for the web client while the bearer stays read-only.

      **Shape of the fix**: an optional `MCP_AUTH_TOKEN_SCOPES` that can only
      **narrow** — default unchanged (`vault.read vault.write`), never widening
      beyond what the flags already permit, so no existing deployment changes.

      ⚠️ **Reverse-verifying this is not free.** Because the default is unchanged,
      **every test that runs the default path stays green with the guard removed** —
      the same shape as the scan prune that survived `subtreeMayMatch` being
      flattened to `return true`. The red has to be driven through a **narrowed**
      `MCP_AUTH_TOKEN_SCOPES` observing write tools disappear from `tools/list`,
      **and the capture itself asserted** so the test cannot pass vacuously.

      ⚠️ **This is a write-surface gate change**, so the pre-commit security
      review fires on it — which is easy to miss, since the change reads as one
      line in `authenticate()`. Do not let it ride along in a docs PR.

      **Not a design gap, a rule that has not reached one spot** — the same shape
      as the `MCP_ENV_FILE` item above, which has since been closed and is the
      worked precedent for this one. Details in
      [`policy-provenance.md`](./policy-provenance.md).

- [ ] **`assertOutsideKnowledgeRoots` does not see hard links** —
      `isInsideRoot` (`src/config.ts`) walks the target's **ancestor
      directories** and compares each against the **root directory**'s
      `(dev, ino)`. A hard link is a second name for a *file* inode, so an
      external policy-source path hard-linked to a note inside a root has
      ancestors that are all outside it, reads as outside, and is accepted —
      while remaining editable through its vault alias, which is exactly what the
      check exists to prevent. Bind mounts and case-insensitive aliases **are**
      caught, because those alias a directory and the walk compares directory
      identity; directory hard links are not creatable by ordinary means, so the
      walk is not bypassable that way.

      **Scope, honestly**: this is a **boot-time misconfiguration guard**, not an
      attacker-facing boundary — creating the link takes local filesystem write
      access, and anything holding that can edit the policy source directly. It
      is recorded because the guard silently under-delivers, not because a remote
      caller can reach it.

      **Shape of a fix**, if taken: compare the target file's own `(dev, ino)`
      against the inodes reachable under each root, or refuse a policy source
      whose `st_nlink > 1`. The second is cheap and fails closed, but it also
      refuses legitimate multi-linked files, so it is a decision rather than an
      obvious win.

      **Measured, not reasoned**: with a root at inode `1884217`, a note inside
      it at `1884219`, and an external hard link to that note, the alias reports
      the *same* inode (`1884219`, `nlink=2`) while its ancestor chain runs
      `outside → … → /` without ever meeting `1884217`. The walk returns
      **false**, so the path is accepted as outside the root.

      Found by review on the PR that added
      [`policy-provenance.md`](./policy-provenance.md), which had claimed hard
      links were caught.

- [ ] **Audit log** — append-only, content-free events (who searched / fetched /
      wrote what, no note bodies) — the largest security follow-up, and still the
      one that most improves the posture; it now sits **second** because the
      RFC 9207 item above is a precondition for its attribution design, not
      because it dropped in importance. Also seeds OpenTelemetry later. Key each
      event on the authenticated **client_id**, not
      the spoofable `clientInfo.name` — see the
      [appendix on authenticated-client_id use cases](#appendix--future-uses-of-the-authenticated-client_id).
      (Distinct from the shipped **constrained audit write surface** above — that
      is the scanner's own vault-side output; this is a server-side event log.)

      **Four constraints settled up front** (from
      [`policy-provenance.md`](./policy-provenance.md), so the design does not
      re-derive them):

      - **It adds no tool.** `registerTool` is at 17 against a documented cap of
        17, so a tool would be a decision to exceed the cap — see the
        `discard_plan` item for the same arithmetic. This is a server-side log,
        not a surface.
      - **Call it an event log and give it `MCP_EVENT_LOG_*`, never
        `MCP_AUDIT_*`.** Three `MCP_AUDIT_*` variables already exist for the
        INV-9 vault-side surface, which is a different thing writing to a
        different place. Documentation saying "these are different" does not
        survive a startup line and a runbook; a distinct prefix does. If the
        startup line reports it, report **three** states from the start —
        "a destination is configured" and "recording is on" are separate
        decisions, and one token naming two of them is exactly what #121 fixed.
      - **The startup line is not the check.** It states a claim; the tool
        surface is the fact. #113 measured the gap: restoring the Skill gate
        turned **one wire test** red while the startup-line test stayed green.
      - **The reverse verification is a negative assert.** The requirement is
        less "events appear" than "note bodies and PII never do" — and a test
        that asserts an append still passes when a body leaks into it. Assert
        that a known vault string is **absent**, the same way
        `assertNoServerOwnedFrontmatter` is pinned on what content *cannot claim*
        rather than on what it can write.

      **Whose repudiation this closes**: the semi-trusted agent's, not the
      operator's. The point is reconstructing what an injected session did — the
      threat model's adversaries (1) and (3) — which is why it does not conflict
      with this project declining to build tamper-resistance against its own
      single operator.
- [ ] **One-command install / npx packaging** — remove the `pnpm build` step so
      the 🟢 non-engineer path needs no toolchain (see Onboarding above).
- [x] **Migrate to `@modelcontextprotocol/server`/`core` v2 with dual-era
      serving ✅** — adopt for restart transparency (guiding priority #2), not for
      speed; see the 2026-07-28 section above, which splits this into **2a**
      (dual-era transport / dependency bump), **2b** (per-request
      scope→tool-surface resolution — the boundary re-pin, and the only
      security-relevant piece, and where `vault.read` finally gets enforced on
      the read tools) and **2c** (stdio `serveStdio()` + adding the
      third "why connections drop" cause, process-memory MCP sessions →
      `404 unknown_session`, to [`operations.md §1`](./operations.md)). Land them
      as three PRs in that order; do not bundle the boundary re-pin with the
      dependency bump. - [x] **2a** ✅ — v2 packages, `isLegacyRequest` routing, sessionful 2025
      leg unchanged, sessionless 2026-07-28 leg, DNS-rebinding moved to the
      endpoint boundary, negotiation tests. Every pre-existing boundary
      test passes unmodified, which is the claim that the boundary did not
      move. - [x] **2b** ✅ — sessions removed from the endpoint (`legacy: 'stateless'`),
      surface resolved per request for both eras through the one
      `surfaceFor`, `vault.read` enforced with a `403 insufficient_scope`
      challenge, consent page states the granted scope, and the
      session-id assertion re-pinned. Pinned by a token-swap test that
      fails under per-session resolution. - [x] **2c** ✅ — `serveStdio()` with an explicit `legacy: 'serve'` and an
      `onerror` that keeps swallowed start-up failures visible; both eras
      driven end-to-end against the spawned real entrypoint. `operations.md`
      §1.C records the third cause as resolved, and §9 Step 5's stale
      `mcp-session-id` step was replaced with a snippet the tests assert.
- [x] **Search P0 + P1 slices** — ✅ P0: NFKC search folding (query + text,
      snippets still sliced from the original), result timestamps/`size_bytes`,
      `total_count`/`offset` envelope, backlink relative-link resolution,
      `absolutePath` removed from document responses. ✅ P1: CJK query
      segmentation, opt-in recency, path/root/date filters, `order`,
      two-window snippets, `explain`, derived-text cache. ✅ P2: `src/linkGraph.ts`
      (path-facts-only resolution, `title` / `aliases` as candidates only) and
      `trace_sources` gaining `depth` / `direction` / `resolved_outgoing` /
      `related` under bounded traversal. ✅ **P3 (`get_context`, `9e2c914`) and
      P4 (`get_project_state`, `de9021c`) have since landed in 0.9.0.** The next
      slice is **P5 (evaluation & tuning)**, still `💭 未着手` — and it is what
      would produce the documented recall failures the layer's 💭 tail is gated
      on, so the two are decided together rather than queued separately.
- [x] **Exact-path document create** — ✅ two-step full-file plan, explicit
      target-path confirmation (`はい` + free text), confirmed-path echo at
      apply, content-integrity/no-overwrite checks, and MCP E2E coverage.

Each security-affecting change pins behavior with tests before merging, per the
repo quality gate. Update this list as items land.

---

## Appendix — future uses of the authenticated `client_id`

An aside, not a committed track: **when** client-specific behavior is worth
adding, key it on the OAuth **`client_id`** (issued per dynamic registration and
bound to the token), never on `clientInfo.name` from `initialize` (self-reported
and forgeable). Today this is deliberately unused — tool surfaces and scopes are
decided only by transport + env flags + token scope (INV-6/INV-7), which are
verifiable facts; a forgeable client name must not leak into those decisions.

**First, the ceiling on what `client_id` can mean here.** The login gate is a
single shared password (`MCP_OAUTH_PASSWORD`), so every `client_id` maps to the
_same_ human. `client_id` therefore distinguishes **a connector registration**,
not a person — and because Dynamic Client Registration mints a fresh id whenever
a client re-adds the connector, it is not even a stable per-vendor identity
(that would need `clientInfo.name`, which is forgeable). So the honest uses are
operational (attribution / limits / revocation), not authorization-of-a-person.

Use cases, roughly by how real/soon they are:

1. **Audit-log attribution (near-term 🔭, strongest).** The audit log only
   becomes useful if each event records _which connector_ acted ("ChatGPT read
   X", "Claude.ai attempted write Y"). Key it on `client_id`. **Settle the CIMD
   question first** (see the 2026-07-28 section): the ceiling described just
   above assumes DCR mints a throwaway id per re-registration, which stops
   holding once client metadata documents replace DCR.
2. **Selective revocation (grew in value with token persistence).** The only
   _explicit_ revocation lever today is rotating the password (nukes _all_
   sessions). 🚧 A first automatic slice landed: client registrations holding no
   live token are pruned after a grace window (`src/oauth/store.ts`), so
   abandoned reconnect churn self-cleans; explicit per-`client_id` revocation
   (an operator-triggered surface) remains future.
   Now that tokens persist across restarts, "revoke ChatGPT only, without making
   Claude.ai re-authorize" wants per-`client_id` token eviction.
3. **Per-connector rate limiting / budget isolation.** Limits are keyed on the
   socket peer today (the anti-`X-Forwarded-For`-spoofing fix); two web clients
   sharing one tunnel egress IP land in the same bucket. To stop one connector
   starving the other, key limits on the authenticated `client_id` instead of IP.
4. **Observability / usage attribution (additive, safe).** "How much is each
   connector used" — pure metrics, touches no authorization.
5. **(Caution) Per-connector scope ceiling.** e.g. "Claude.ai may hold
   `vault.write`, but ChatGPT stays read-only even on a write-enabled server."
   This is the **one** case that re-introduces identity-based authorization, so
   gate it hard: apply it as a **restriction only** (never to widen scope),
   resolved at authorize time from `client_id → policy`, and keep scope _grants_
   on flags + requested-scope as today. Overusing it muddies INV-6/INV-7.
6. **Multi-user / RBAC (larger bet 💭, the real structural driver).** Replacing
   the shared password with per-user auth is what finally makes the identity
   _behind_ a `client_id` the primary authorization key — a significant change to
   the OAuth + store layers. Pursue only if demand is validated.

**Rule of thumb:** `client_id` is fine for **attribution, limiting, and
revocation** (all satisfied by "this token provably came from this
registration"); it must **not** drive trust decisions or scope widening. A
runtime router that switches tool surfaces by _detecting_ ChatGPT-vs-Claude is
explicitly rejected: MCP already solves I/O differences client-side (each client
selects the tools it understands — the `search`/`fetch` aliases in
`src/chatgpt.ts`), and the only output difference is config-driven
(`chatgptUrlBase`), so no server-side, identity-based branching is warranted.

---

## Explicitly out of scope (for now)

- Uploading / syncing the whole vault to a cloud service (contradicts the core
  "data stays local" promise).
- Relaxing the security defaults for convenience (e.g. write-by-default,
  binding to a public interface).

---

## How items graduate

An idea (💭) becomes planned (🔭) when it has a clear user problem and fits the
guiding priorities; it becomes in-progress (🚧) when it has a tracking issue/PR.
Security-affecting changes pin their behavior with tests before merging, per the
repo's quality gate.
