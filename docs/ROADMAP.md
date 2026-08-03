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
- Optional: a guided `init` that writes `.env` interactively.
- _Why:_ the target audience skews technical but the build step is the main
  drop-off point; the web/OAuth path stays "advanced".

### OAuth token persistence — _survive restarts_ 🚧

Persist OAuth tokens / registered clients (previously in-memory only,
`src/oauth/store.ts`) so a restart does **not** force a re-auth. **Implemented
(PR pending)** as an opt-in `MCP_OAUTH_STATE_FILE`:

- **Hash-at-rest** — tokens are keyed by `sha256(token)` in memory _and_ on
  disk, so the state file holds no recoverable credential (no encryption key to
  manage; stronger than encryption here because raw tokens never need recovery).
- **Integrity + fail-closed** — the file carries an HMAC-SHA256 tag keyed from
  `MCP_OAUTH_PASSWORD` (scrypt-derived, per-file salt); tamper / corruption /
  version-mismatch / password-rotation loads to empty state (so rotating the
  password also revokes all persisted sessions). Atomic write, `0600`.
- Kept the existing security properties (opaque 256-bit tokens, single-use
  short-lived codes that are **never persisted**, refresh rotation invalidated
  on disk immediately, capped/pruned collections) and single-user simplicity.
- Pinned by `tests/oauth.test.ts`. See
  [`operations.md §1.B`](./operations.md#b-oauth-state--in-memory-by-default-persistable-via-a-state-file).

### Search & retrieval UX 🔭

Improve relevance and ergonomics of `search_documents` / `search`:

- ranking / snippet quality, optional tag & project filters in the query,
- guardrails so large vaults stay responsive (the parse cache from 0.1.0 is the
  foundation). 🚧 First responsiveness slice landed: vault scans now open files
  with **bounded concurrency** (`MCP_SCAN_CONCURRENCY`, default 24) + transient
  `EAGAIN` retry + skip-and-log, so a thousands-of-notes vault no longer
  exhausts file descriptors mid-search (`src/knowledgeStore.ts`).

Concretized by the [context-engineering proposal](./context-engineering.md)
(survey-based, 2026-07) into two slices — flip to 🚧 when the first PR opens:

- **P0 correctness slice** 🔭 — NFKC normalization in the search path (queries
  and bodies; today only `pathSafety` normalizes), timestamps + `size_bytes` on
  `SearchResult`, a `{results, total_count, offset, limit}` envelope so agents
  can see truncation instead of re-querying blindly, backlink resolution of
  relative Markdown links (fixture-reproducible gap), and dropping
  `absolutePath` from `fetch_document` responses.
- **P1 quality slice** 🔭 — CJK segmentation via `Intl.Segmenter` (zero-dep),
  opt-out recency decay (`MCP_SEARCH_RECENCY_*`, `=0` restores today's
  ranking), `path_prefix` / `root` / date-range filters, `order` +
  pagination, two-window snippets, per-result `explain` score breakdown, and a
  derived-text cache on the existing mtime+size invalidation (kills the
  per-query full-corpus `toLowerCase()` re-normalization).

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

### Constrained audit write surface — _persist unattended vault-scan output_ 🚧

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
- **Distinct from the "Audit log" gap below.** That is a _content-free,
  server-side_ event log of who searched / fetched / wrote (keyed on
  `client_id`); this is the _scanner's own_ audit output written into the vault.
- Out of scope here (scanner-side, lives in a local Skill): the byte-level scan
  engine, full enumeration, and the out-of-vault git-SHA / signed-manifest trust
  anchor. Graduates to ✅ on merge.

### MCP 2026-07-28 (stateless core) adoption — _reliability, not speed_ 🔭

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
2. **v2 packages + dual-era serving 🔭 — this is the one that pays.** It closes
   the **third** cause of "the connection dropped", the one §1 of
   [`operations.md`](./operations.md) does not yet list. Causes (A) ephemeral
   tunnel URL and (B) in-memory OAuth state are addressed (named tunnel /
   `MCP_OAUTH_STATE_FILE`); the MCP **session** itself is not. `sessions` in
   `src/httpServer.ts` is a process-memory `Map`, so every supervisor restart,
   redeploy, or OOM invalidates all session ids and the server answers
   `404 unknown_session`, forcing a client re-initialize. Removing the session id
   removes exactly that failure mode — and no more. A restart still drops
   in-flight requests, and any continuation across a multi-round-trip request
   still needs an explicit, integrity-checked `requestState` (plus whatever
   application state that round depends on); statelessness does not carry either
   across a restart for free. Scoped that way it still directly serves guiding
   priority #2. Secondary win: sessions are only reaped via `transport.onclose`
   and each entry pins a transport **plus** a per-session `McpServer` instance —
   whether a client that vanishes without a DELETE is reliably reaped is
   unverified and worth checking on long uptimes; statelessness removes the class.
3. **Cache hints (`ttlMs` / `cacheScope`) 🔭 — must be scope-private.** The tool
   surface is static only _per scope_, not globally: `src/httpServer.ts` derives
   `allowWrite` / `allowSkillWrite` / `allowAuditWrite` from the principal's
   scopes and registers a different tool set for each (that is INV-6/INV-7). A
   `cacheScope: 'shared'` listing would therefore be servable across principals,
   handing write-tool metadata to a read-scoped client — the exact leak
   "not registered, so not discoverable" exists to prevent. Use a private cache
   scope, or a key that includes the effective scope and the enabled surfaces.
   Treat this as a security-boundary change and pin it with a test.
4. **Stateless scale-out / header routing — deliberately not pursued.** Gated on
   multi-user graduating from 💭. Adopting it now buys nothing and widens surface.

**No deadline pressure, so sequence this behind the security follow-ups.** v2's
`createMcpHandler` serves the 2025 era and 2026-07-28 simultaneously by default
(`legacy: 'stateless'`), and deprecations carry a floor of twelve months before
the earliest possible removal. There is no cliff.

**Migration cost is concentrated in re-pinning the security boundary, not in
rewriting it.** Today `src/httpServer.ts` authenticates, resolves scope, then
builds a server registering *only* the tools that scope permits, and binds it to
the session — INV-6/INV-7 ("a read-scoped token never sees write tools because
they were never registered") currently rests on the session model. Without
sessions that resolution moves to per-request, which `createMcpHandler`'s
per-request factory models cleanly, but every boundary test in
`tests/httpServer.test.ts` / `tests/oauth.test.ts` has to be re-pinned.

**DNS-rebinding protection is a prerequisite, not a sub-task of this migration**
— it has its own section below, and that work stands on its own whether or not
the v2 move ever happens. Do not assume the boundary survives because the option
names still exist in v2; the check has to be re-established against whatever
enforces it there. `src/index.ts` (stdio) changes to `serveStdio()` and can lag
the HTTP side.

### DNS-rebinding protection is on a deprecated API — _pin it, then move it_ 🔭

INV-6 item 3 is currently enforced by three `StreamableHTTPServerTransport`
options that `src/httpServer.ts` passes today —
`enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins`. **All three
are marked `@deprecated` in the SDK**, which points at the
`server/middleware/hostHeaderValidation.js` middleware instead. The same options
carry the same deprecation on the SSE transport.

**This is not a live hole — say that plainly.** At the pinned
`@modelcontextprotocol/sdk` 1.29.0 the options still fully enforce:
`validateRequestHeaders` reads all three and returns a 403 on a bad `Host`.
`loadHttpConfig` never leaves `allowedHosts` empty (it defaults to
`<host>:<port>` + `localhost:<port>` and appends the public URL's host when
`MCP_HTTP_PUBLIC_URL` is set), so the Host check really does run in every
deployment. Deprecated is not removed. What follows is about keeping it that way.

Two real problems, in the order they should be fixed:

1. **Nothing pins the behaviour, so its removal would be silent 🔭 — do this
   first, it is the cheap half.** There is no test anywhere that drives a hostile
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
2. **Then migrate off the deprecated options — but it is not a drop-in swap 🔭.**
   Two mismatches make a naive port wrong rather than merely tedious:
   - **Port semantics differ.** The transport option compares the `Host` header
     _exactly, including the port_ (`allowedHosts.includes(hostHeader)`, entries
     like `127.0.0.1:8787`), while `hostHeaderValidation(allowedHostnames)`
     validates the **hostname only, port-agnostic** and documents its input as
     hostnames _without_ ports. `MCP_HTTP_ALLOWED_HOSTS` currently carries
     `host:port` values, so handing the existing list straight to the middleware
     matches nothing. The env contract has to be migrated deliberately, or the
     values stripped at the boundary — and the operator-facing docs in
     [`operations.md`](./operations.md) updated to match.
   - **The middleware is Express-shaped.** It returns an Express
     `RequestHandler`, and this server is plain `node:http` with no Express in
     the dependency tree. So it cannot simply be `app.use()`-d; it needs a small
     adapter, or an equivalent check written against `http.IncomingMessage` and
     pinned by the test from (1).

   Note the current Origin posture while you are in there, and decide it
   deliberately rather than inheriting it: `allowedOrigins` defaults to empty
   (so the Origin check is skipped unless `MCP_HTTP_ALLOWED_ORIGINS` is set), and
   even when populated the transport only rejects a **present but unlisted**
   Origin — a request with no `Origin` header passes. That is defensible for a
   bearer-authed, non-browser client, but it should be a recorded decision.

**Doc coupling:** INV-6 item 3 in
[`mcp-vault-security`](../.claude/skills/mcp-vault-security/SKILL.md) and the
skill-firing row in [`CLAUDE.md`](../CLAUDE.md) both name the transport options
by name. Whichever PR moves the mechanism must update both in the same change,
or the canon will describe an API the code no longer uses.

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
- [ ] **Migrate off the deprecated DNS-rebinding transport options** — see the
      section above; not a drop-in (middleware is port-agnostic and Express-shaped,
      our config carries `host:port` and we run plain `node:http`). Update INV-6
      item 3 in the `mcp-vault-security` skill, the `CLAUDE.md` firing row, and
      the `MCP_HTTP_ALLOWED_HOSTS` docs in `operations.md` in the same PR.
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
- [ ] **Migrate to `@modelcontextprotocol/server`/`core` v2 with dual-era
      serving** — adopt for restart transparency (guiding priority #2), not for
      speed; see the 2026-07-28 section above. Chiefly a re-pin of the
      scope→tool-surface boundary tests once that resolution moves from
      per-session to per-request. Also add a third "why connections drop" cause
      (process-memory MCP sessions → `404 unknown_session`) to
      [`operations.md §1`](./operations.md) when this lands.
- [ ] **Search P0 correctness slice** — NFKC search normalization, result
      timestamps/`size_bytes`, `total_count` envelope, backlink relative-link
      resolution (reproducible against the synthetic fixture), `absolutePath`
      removal from `fetch_document` — the first slice of the
      [context-engineering proposal](./context-engineering.md).
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
