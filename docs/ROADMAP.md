# Roadmap

Direction for `claude_openai_mcp_connector` after **v0.1.0**. This is a living
document — items and ordering will change as the product is used. It is paired
with [`PRFAQ.md`](./PRFAQ.md) (the "次に追加する機能" / out-of-scope sections)
and [`operations.md`](./operations.md).

Status legend: 🔭 planned · 🚧 in progress · ✅ done · 💭 idea / needs validation

---

## Guiding priorities

1. **Lower the activation barrier** so the *Obsidian-power-user* segment can get
   to a working local connection without engineering skills.
2. **Make the web connector survive restarts** so "it dropped" stops happening.
3. **Never widen the security surface** — every new feature keeps the strict
   defaults (read-only by default, two-step writes, path containment, OAuth
   audience/scope binding).

---

## Near-term (next minor releases)

### Onboarding & packaging — *reduce friction for non-engineers* 🔭
The current README starts at `pnpm install` / `pnpm build`, which can deter
non-engineers. Goal: a copy-paste path that does **not** require a manual build.
- One-command run, e.g. `npx claude-openai-mcp-connector` or a prebuilt binary,
  removing the Node/pnpm build step.
- A **"first-time / prerequisites"** quickstart with install links (Node) and a
  3-tier path: 🟢 local + Claude Desktop → 🟡 CLI clients → 🔴 web + OAuth.
- Optional: a guided `init` that writes `.env` interactively.
- *Why:* the target audience skews technical but the build step is the main
  drop-off point; the web/OAuth path stays "advanced".

### OAuth token persistence — *survive restarts* 🔭
Persist OAuth tokens / registered clients (currently in-memory,
`src/oauth/store.ts`) to a local encrypted store so a restart does **not** force
a re-auth. See [`operations.md`](./operations.md#1-why-connections-drop-and-the-fix) for the
current behavior and workaround.
- Must keep single-user simplicity and the existing security properties (opaque
  256-bit tokens, single-use codes, capped/pruned collections).

### Search & retrieval UX 🔭
Improve relevance and ergonomics of `search_documents` / `search`:
- ranking / snippet quality, optional tag & project filters in the query,
- guardrails so large vaults stay responsive (the parse cache from 0.1.0 is the
  foundation).

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
*team / enterprise* adoption rather than the core individual use case.

| Gap | Why it matters | Tier |
| --- | --- | --- |
| **Third-party penetration test** | Self-review + AI review have limits; an independent test is needed before security claims are load-bearing. | near-term 🔭 |
| **Audit log** | No after-the-fact record of who searched / fetched / wrote what. | near-term 🔭 |
| **Multi-user RBAC** | Currently single-user by design; teams need per-user roles & scoping. | larger bet 💭 |
| **Hardened secret scanning / release-artifact verification** | Needed if OSS distribution (npx / prebuilt binaries) is pushed harder — provenance, signed artifacts, SBOM. | mid-term 💭 |
| **OpenTelemetry / structured audit events** | Required for enterprise observability and SIEM ingestion. | mid-term 💭 |
| **DLP / exfiltration detection** | No control over leakage *of vault content* once a client is authorized. | larger bet 💭 |
| **Sandbox isolation** | If the MCP server process itself is compromised, isolation from the host is limited. | 🚧 layer 1 (systemd hardening) shipped → [`operations.md`](./operations.md#sandbox-hardening-systemd); bwrap (layer 3) still a larger bet 💭 |
| **Formal threat model document** | `SECURITY.md` is good but was not a systematic STRIDE/LINDDUN-style model. | 🚧 → [`threat-model.md`](./threat-model.md) (STRIDE) added; revisit as features land |

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
conflate: (a) sandboxing the *AI coding agent* that runs shell commands — a dev-
workflow concern; (b) sandboxing *this MCP daemon* — the gap here.

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
- [ ] **bwrap recipe** + userns/AppArmor caveat in `operations.md` (layer 3).
- [ ] **Audit log** — append-only, content-free events (who searched / fetched /
      wrote what, no note bodies) — the agreed #1 security follow-up; also seeds
      OpenTelemetry later.
- [ ] **One-command install / npx packaging** — remove the `pnpm build` step so
      the 🟢 non-engineer path needs no toolchain (see Onboarding above).

Each security-affecting change pins behavior with tests before merging, per the
repo quality gate. Update this list as items land.

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
