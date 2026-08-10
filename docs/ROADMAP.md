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
  exhausts file descriptors mid-search (`src/knowledgeStore.ts`).

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
  score breakdown, and a derived-text cache on the existing mtime+size
  invalidation (removes the per-query full-corpus fold). Pagination shipped
  earlier with P0. Entirely additive: unset env and unset parameters reproduce
  0.7.0 ranking exactly. Pinned by `tests/search.test.ts`.

### Context engineering layer — get_context / link graph / project state 🔭

Evolve the read plane from "search API" to "context gateway": one call should
return a token-budgeted, provenance-carrying context package instead of forcing
the client into search→fetch loops. Full design (A–G survey, tool schemas,
anti-forgery analysis, reject list) in the
[context-engineering proposal](./context-engineering.md). Net tool count
15 → 17; **no new write surface in any phase** (guiding priority #3), and
per-agent "context profiles" are request parameters only — never server-side
client detection, per the [appendix's anti-router ruling](#appendix--future-uses-of-the-authenticated-client_id).

- **P2 — link graph & provenance** 🔭: `src/linkGraph.ts` built from
  `listDocuments()` (fs access stays behind the existing guard chain), correct
  relative-link + Obsidian-style basename/alias wikilink resolution, and
  `trace_sources` gains `depth` / `direction` + resolved-link output. Bounds:
  depth ≤ 2, node/fanout caps, hub damping for MOC notes.
- **P3 — `get_context`** 🔭: deterministic 5-stage pipeline (seed search →
  link expansion → fuse/dedup → heading-level chunking → greedy
  score-per-token packing) returning a `ContextPackage` with per-chunk
  provenance and an `omitted[]` list; zero-dep CJK-aware token estimation;
  opt-in owner-controlled type weighting (`MCP_CONTEXT_TYPE_RULES`, refuses to
  load from inside a knowledge root; frontmatter self-claimed types never
  drive trust).
- **P4 — project memory** 🔭: `get_project_state` (deterministic dossier —
  designated `project-state`-tagged docs, recent docs, session-archive
  metadata + outline only, ops-log pointers via their `target_repo`
  frontmatter) and `fetch_document` gains `outline` / `sections` / `max_chars`
  so MB-scale session notes never have to be fetched whole.
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
  The stdio startup line now reports three states (`off` / `reserved-only` /
  `on`) because a single on/off could only ever describe one of the two.
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
       *whole* endpoint off sessions plus the re-pin of every boundary test
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
       port-agnostic Host comparison, and *not* adopting the SDK's
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
       starts the wire in the background and *drops* the rejection when no
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
   for both `server/discover` and `tools/list`). The work is not *fixing* a leak
   but *not opening* one — so it lands as a test, not a change.

   **Two corrections to what this item used to say:**

   - "Use a private cache scope, **or a key that includes the effective scope and
     the enabled surfaces**" — the second option does not exist. `CacheHint` is
     `ttlMs` + `cacheScope` and nothing else; cache keying belongs to the client
     and no server-side lever reaches it.
   - **`private` alone is not sufficient either.** 2b made the surface follow the
     *token*, while a private cache is keyed by the *client*. One client swapping
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
  *rejected* for that expansion bomb (a few hundred bytes tells you nothing about
  size) and is the right bound here. The two are complementary; neither replaces
  the other.
- **The `!!omap` path is fixed at the dependency; the comment stripper is not.**
  js-yaml **3.15.1** is patched and inside gray-matter's `^3.13.1` range, so
  `pnpm.overrides` pins it — no major upgrade, no API break. Measured on the
  resolved tree: 3.15.0 quadruples per doubling, 3.15.1 is linear. The bound
  still covers that path as defence in depth, but calling it *the* mitigation
  would make an out-of-date js-yaml look acceptable. The comment stripper is
  gray-matter's own code and the bound is the only thing standing there. The two
  remaining advisories are dev-only.
  **Read an advisory's structured fields, not its title**: this record is titled
  "CVE-2026-59870 fix not backported" while its own `patched_versions` says
  `>=3.15.1`. The title is why an earlier revision of this entry said 5.x-only.
- **Sized from real data**, not from the attack: 2,381 notes, frontmatter median
  225 B, max 1,042 B. 8 KiB keeps ~7.9x headroom while holding the attack to
  ~41 ms — the *unterminated* shape, which is the worst case and ~1.8x costlier
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
`updates:` bumps *direct* dependencies while js-yaml is transitive — so no PR
could be raised there either. A single detector, configured to be invisible, is
not a control. CI now fails on a **production** high (`pnpm audit --prod
--audit-level high`) and keeps the full-tree moderate scan advisory. Scoping the
blocking step to `--prod` is the point: dev noise is what turns a step into one
people stop reading. The threshold is a deliberate trade — a *moderate*
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
  the test asking for refusal at *plan* time is what caught it. Refusing only at
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
- Synthetic store tests and an in-memory MCP E2E pin the confirmation payload,
  no-plan-side-effects rule, traversal/symlink/collision failures, and read-back.

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

| Gap                                                          | Why it matters                                                                                              | Tier                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Third-party penetration test**                             | Self-review + AI review have limits; an independent test is needed before security claims are load-bearing. | near-term 🔭                                                                                                                                                                                                                        |
| **Audit log**                                                | No after-the-fact record of who searched / fetched / wrote what.                                            | near-term 🔭                                                                                                                                                                                                                        |
| **Multi-user RBAC**                                          | Currently single-user by design; teams need per-user roles & scoping.                                       | larger bet 💭                                                                                                                                                                                                                       |
| **Hardened secret scanning / release-artifact verification** | Needed if OSS distribution (npx / prebuilt binaries) is pushed harder — provenance, signed artifacts, SBOM. | mid-term 💭                                                                                                                                                                                                                         |
| **OpenTelemetry / structured audit events**                  | Required for enterprise observability and SIEM ingestion.                                                   | mid-term 💭                                                                                                                                                                                                                         |
| **DLP / exfiltration detection**                             | No control over leakage _of vault content_ once a client is authorized.                                     | larger bet 💭                                                                                                                                                                                                                       |
| **Sandbox isolation**                                        | If the MCP server process itself is compromised, isolation from the host is limited.                        | ✅ layers 1–3 documented → [`operations.md`](./operations.md#sandbox-hardening-systemd) (systemd) + [§6](./operations.md#6-sandboxing-the-local-stdio-server-bwrap-optional) (bwrap); residual: operator-applied, not code-enforced |
| **Formal threat model document**                             | `SECURITY.md` is good but was not a systematic STRIDE/LINDDUN-style model.                                  | 🚧 → [`threat-model.md`](./threat-model.md) (STRIDE) added; revisit as features land                                                                                                                                                |

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
- [x] **RFC 9207 `iss` in the authorization response** (`src/oauth/`) — ✅ the
      `authorizePost` success redirect (the only redirect the AS emits — error
      paths render a 400 page precisely so codes cannot leak via redirects, so
      "iss on error responses" is N/A by construction) now carries
      `iss=<issuer>`, and `authorizationServerMetadata()` advertises
      `authorization_response_iss_parameter_supported: true` — the pair changes
      together per SEP-2468. Pinned in `tests/oauth.test.ts` (code-issuance
      redirect, metadata flag, and the HTTP E2E). The sequencing note stands:
      the same revision deprecates DCR for CIMD, which makes `client_id` a
      *stable* identity — revisit the `client_id` appendix **before** building
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
      before its destination exists. `MCP_ENV_FILE` is deliberately **not**
      covered: it is read before the roots are known, so the same mechanism
      cannot reach it. Recorded as unhandled rather than half-handled. See the
      OAuth-persistence section above.
- [ ] **Bring `MCP_ENV_FILE` under the same containment rule** — needs a
      different mechanism than the other two, since the roots it would be checked
      against come from the file itself.

      **What is settled:** a boot-time check cannot reach it. `loadEnvFile()`
      runs before `KNOWLEDGE_ROOT` exists, so there is nothing to compare
      against at the moment the file is read. That is an ordering fact, not a
      design preference.

      **What was NOT considered when this entry was first written** (v0.8.0):
      a check *after* the roots are known. Once `loadConfig()` has resolved
      them, `MCP_ENV_FILE` can be tested with the same `(dev, ino)` walk and the
      server refused if it lands inside a root. This does not undo the exposure
      — the secrets are already in `process.env` by then, and a state file in an
      indexed root may already have been read by anything with vault access.
      What it does buy is refusing to keep serving on credentials that a vault
      reader may already know. `MCP_OAUTH_STATE_FILE` fails *before the write*;
      this would fail *after the read*, which is a materially weaker guarantee
      and belongs to a separate decision rather than the same mechanism.
      Recorded here so the next person does not re-derive it: this option is
      **unevaluated, not rejected**.

      **Priority input:** no deployment sets `MCP_ENV_FILE` today. The scan
      host's launchd plist carries an empty `EnvironmentVariables`, `launchctl
      getenv` reports every relevant name unset, and the cwd-relative `.env`
      path that used to supply them has been retired. Nobody is standing on this
      question yet — the migration that starts using `MCP_ENV_FILE` is the
      deadline for answering it.
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
      dependency bump.
      - [x] **2a** ✅ — v2 packages, `isLegacyRequest` routing, sessionful 2025
            leg unchanged, sessionless 2026-07-28 leg, DNS-rebinding moved to the
            endpoint boundary, negotiation tests. Every pre-existing boundary
            test passes unmodified, which is the claim that the boundary did not
            move.
      - [x] **2b** ✅ — sessions removed from the endpoint (`legacy: 'stateless'`),
            surface resolved per request for both eras through the one
            `surfaceFor`, `vault.read` enforced with a `403 insufficient_scope`
            challenge, consent page states the granted scope, and the
            session-id assertion re-pinned. Pinned by a token-swap test that
            fails under per-session resolution.
      - [x] **2c** ✅ — `serveStdio()` with an explicit `legacy: 'serve'` and an
            `onerror` that keeps swallowed start-up failures visible; both eras
            driven end-to-end against the spawned real entrypoint. `operations.md`
            §1.C records the third cause as resolved, and §9 Step 5's stale
            `mcp-session-id` step was replaced with a snippet the tests assert.
- [x] **Search P0 + P1 slices** — ✅ P0: NFKC search folding (query + text,
      snippets still sliced from the original), result timestamps/`size_bytes`,
      `total_count`/`offset` envelope, backlink relative-link resolution,
      `absolutePath` removed from document responses. ✅ P1: CJK query
      segmentation, opt-in recency, path/root/date filters, `order`,
      two-window snippets, `explain`, derived-text cache. Next in this track is
      **P2 (link graph)** under the context-engineering layer above.
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
