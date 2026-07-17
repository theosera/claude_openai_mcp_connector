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
(2) an **audit log** (append-only, content-free events) which also seeds later
OpenTelemetry work, then (3) commission a **third-party pen test** now that the
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
- [ ] **Audit log** — append-only, content-free events (who searched / fetched /
      wrote what, no note bodies) — the agreed #1 security follow-up; also seeds
      OpenTelemetry later. Key each event on the authenticated **client_id**, not
      the spoofable `clientInfo.name` — see the
      [appendix on authenticated-client_id use cases](#appendix--future-uses-of-the-authenticated-client_id).
      (Distinct from the shipped **constrained audit write surface** above — that
      is the scanner's own vault-side output; this is a server-side event log.)
- [ ] **One-command install / npx packaging** — remove the `pnpm build` step so
      the 🟢 non-engineer path needs no toolchain (see Onboarding above).
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

1. **Audit-log attribution (near-term 🔭, strongest).** The agreed #1 security
   follow-up only becomes useful if each event records _which connector_ acted
   ("ChatGPT read X", "Claude.ai attempted write Y"). Key it on `client_id`.
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
