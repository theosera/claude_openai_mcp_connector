# Threat Model (STRIDE)

A systematic STRIDE threat model for `claude_openai_mcp_connector`. It
complements [`SECURITY.md`](../SECURITY.md) (narrative threat model + Reusable
Security Baseline mapping) by organizing threats along the STRIDE categories and
mapping each to the in-code invariant (`INV-n`) and test that pins it. Known gaps
are tracked in [`ROADMAP.md`](./ROADMAP.md#security--enterprise-maturity-gaps-not-yet-addressed).

Invariant labels (`INV-1`…`INV-9`) match the `mcp-vault-security` skill and
`CLAUDE.md`.

---

## 1. Scope & system overview

The server exposes a **private Markdown vault** (`KNOWLEDGE_ROOT`) to MCP clients
over two transports:

- **stdio** — local CLI/desktop clients (Claude Code, Codex, Claude Desktop).
  Full read+write tool surface. Auth is the OS process boundary (the client
  spawns the server).
- **Streamable HTTP** — remote Chat connectors (ChatGPT, Claude.ai web; Claude
  Desktop/Code remote; Claude API). Authenticated, read-only by default;
  document writes, constrained Skill creation, and a constrained audit write
  surface are separately enabled, optionally with a built-in **OAuth 2.1**
  authorization server.

The defining constraint: **the code repo is public; the vault is private** and
referenced only via `KNOWLEDGE_ROOT`.

### Primary adversaries

1. **The MCP client / LLM itself** — semi-trusted. Tool arguments are
   attacker-influenced input (path traversal, frontmatter injection, stale
   overwrite). The LLM may also be steered by injected vault content.
2. **A remote network attacker** — on the HTTP path: unauthenticated callers,
   DNS-rebinding, token theft/replay, OAuth flow abuse.
3. **Authored vault content** — web clips / third-party notes carrying prompt
   injection (returned as data).
4. **The repo contributor / CI supply chain** — accidental secret/vault commit,
   workflow poisoning, tag-substitution.

---

## 2. Assets

| Asset                                                  | Why it matters                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| Vault note **content**                                 | The private knowledge being protected; confidentiality + integrity. |
| Vault **boundary** (`KNOWLEDGE_ROOT`)                  | Containment line; nothing outside must be readable/writable.        |
| Note **integrity**                                     | Edits must be intentional, non-destructive, non-stale.              |
| `MCP_AUTH_TOKEN` / OAuth tokens / `MCP_OAUTH_PASSWORD` | Gate remote access; leakage = full read (and maybe write).          |
| Frontmatter **metadata** (`id`, `updated_at`)          | Server-owned identity/stamps; must not be client-forgeable.         |
| The **public repo**                                    | Must never contain vault content, secrets, or real paths.           |

---

## 3. Trust boundaries & data flow

```
                        ┌────────────────────────── public internet ──────────────────────────┐
 ChatGPT / Claude.ai ──▶ HTTPS tunnel ──▶ 127.0.0.1:PORT  ┌─ /authorize,/token,/register (OAuth 2.1)
 (web, OAuth only)       (cloudflared)        │            │   PKCE S256 · login gate · DCR
                                              │  httpServer├─ /mcp  (bearer OR audience-bound token)
 Claude Desktop/API ───▶ static bearer ──────▶│            │   read-only unless allowWrite + vault.write
                                              └────────────┴──────────────┐
                                                                          ▼
 Claude Code / Codex ──▶ stdio (local process) ─────────────────▶  buildMcpServer (tool factory)
                                                                          │
                                                                          ▼
                                                         pathSafety ▶ knowledgeStore ▶ KNOWLEDGE_ROOT
                                                         (INV-1)       (INV-1,2,3)        (the vault)
```

**Trust boundaries crossed:** (a) network → loopback (HTTP auth gate), (b)
client tool args → server (input validation), (c) server → filesystem (path
containment), (d) vault content → LLM/agent (untrusted-data boundary), (e)
repo/CI → public (secret hygiene).

---

## 4. STRIDE analysis

### S — Spoofing (identity)

| Threat                                     | Mitigation (invariant / code)                                                                                           | Residual                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Unauthenticated caller hits `/mcp`         | Bearer required; fail-closed if `MCP_AUTH_TOKEN` unset (`INV-6`, `httpAuth.ts`, `config.ts`). 401 + `WWW-Authenticate`. | Token strength is the operator's responsibility.                     |
| Web client can't send a static bearer      | OAuth 2.1 + PKCE S256 + DCR; login gated by `MCP_OAUTH_PASSWORD` (scrypt) (`INV-7`, `oauth/`).                          | Shared single-user password (no per-user identity — see gaps: RBAC). |
| Token/timing side-channel on compare       | Constant-time compare, length-normalized (`INV-6`, `httpAuth.ts`; `INV-7` PKCE/login).                                  | —                                                                    |
| DNS-rebinding to reach the loopback server | `enableDnsRebindingProtection` + `allowedHosts`/`allowedOrigins` (`INV-6`, `httpServer.ts`).                            | Operator must add only the intended tunnel host.                     |

### T — Tampering (integrity)

| Threat                                                                                       | Mitigation                                                                                                                                                                                                                 | Residual                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path traversal / encoded traversal / symlink escape to write outside the vault               | Multi-phase guard, fail-closed (`INV-1`, `pathSafety.ts`); realpath prefix + symlink-escape checks on every write path (`knowledgeStore.ts`).                                                                              | New write paths must route through the guard (enforced by review + tests).                                                                                        |
| Destructive or **stale** overwrite of an existing note                                       | Two-step `plan`→`apply` with SHA-256 staleness check; reject if changed (`INV-3`).                                                                                                                                         | A within-window concurrent edit is detected, not merged.                                                                                                          |
| Creating a note at an unintended exact path                                                  | `plan_document_create` returns the complete diff and structured target-path question; apply requires an exact `confirmed_target_path` echo, verifies staged-content integrity, and re-runs containment (`INV-1`, `INV-3`). | The server cannot prove which client UI rendered the question; current-user confirmation remains a client/agent responsibility reinforced by server instructions. |
| Overwriting a file via "create"                                                              | Every create uses `flag: "wx"`; exact-path planning has no target-side effect and apply rejects collisions (`INV-3`).                                                                                                      | The legacy routed `create_document` remains a one-step helper; clients must show its exact target and content before calling it.                                  |
| Forging server-owned frontmatter (`id`, `updated_at`) or injecting arbitrary YAML keys/types | Field **allowlist** + value-type checks (`INV-2`, `frontmatter.ts`).                                                                                                                                                       | Allowlist widening requires threat review + tests.                                                                                                                |
| Forging or clobbering audit-scan files via the general document-write tools                  | General writes are **forbidden from the audit subtree** (`INV-9`, `assertNotAuditReserved`, realpath-based); only `append_audit_report` (create-only, never overwrites) and `compare_and_swap_audit_state` (sha256 CAS) write there, serialized in-process (`auditStore.ts`). | Cross-process CAS is best-effort under the single-writer assumption; a torn crash-time write leaves a short file, not a merged one.                                |
| Request body abuse                                                                           | Body-size cap → 413 (`INV-6`).                                                                                                                                                                                             | —                                                                                                                                                                 |

### R — Repudiation (auditability)

| Threat                                                         | Mitigation                                                                                 | Residual                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| "Who searched / fetched / wrote what?" cannot be reconstructed | Startup line logs only host:port + write flag; **secrets/content never logged** (`INV-6`). | ⚠️ **No server-side audit log today** (known gap — ROADMAP: audit log, OpenTelemetry). Distinct from the `INV-9` audit **write surface**, which persists a *scanner's own* output into the vault, not a server-side event log. |

### I — Information disclosure (confidentiality)

| Threat                                                              | Mitigation                                                                                                                   | Residual                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Reading files outside the vault                                     | Path containment, fail-closed (`INV-1`).                                                                                     | —                                                                                    |
| Serving the vault over HTTP with no auth                            | `MCP_AUTH_TOKEN` required or startup refused; loopback bind by default (`INV-6`).                                            | Public exposure only via explicit HTTPS tunnel.                                      |
| Token/code/password leaking via logs                                | No secrets in logs; secrets via env only (`INV-6`, `INV-7`, `INV-4`).                                                        | —                                                                                    |
| Over-broad remote capability                                        | Read-only by default; write tools are **not even registered** without `allowWrite` + `vault.write` scope (`INV-6`, `INV-7`). | —                                                                                    |
| OAuth open-redirect leaking a code                                  | `redirect_uri` exact-match + https/loopback only; bad client/redirect → 400, not redirected (`INV-7`).                       | —                                                                                    |
| Secret/vault committed to the public repo                           | `.gitignore` + synthetic-only fixtures + per-file `git add` (`INV-4`).                                                       | ⚠️ Relies on discipline; **harder secret-scanning is a gap** (ROADMAP).              |
| Exfiltration of vault content by an authorized-but-malicious client | —                                                                                                                            | ⚠️ **No DLP / exfiltration detection** (known gap, ROADMAP). Out of scope for 0.1.0. |

### D — Denial of service

| Threat                                                   | Mitigation                                                                          | Residual                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Symlink cycle causing unbounded recursion                | `walkMarkdownFiles` tracks visited realpaths; cycle terminates (`INV-1`, guard #8). | —                                                                                 |
| Unbounded OAuth client/token minting (memory exhaustion) | Capped + pruned collections; DCR input limits (`INV-7`).                            | In-memory store; a restart clears state (and forces re-auth — see operations.md). |
| Oversized request body                                   | Body cap → 413 (`INV-6`).                                                           | No global rate limiting beyond the coarse OAuth-endpoint limiter.                 |

### E — Elevation of privilege

| Threat                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                           | Residual                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read-scoped web token performing writes                                                           | Session registers write tools only when `allowWrite && token has vault.write`; otherwise undiscoverable (`INV-7`, `INV-6`).                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                    |
| Unattended write-enabled connector steered into general writes by a malicious note (confused deputy) | Run the unattended scan on a dedicated endpoint with general write **off** and only `MCP_HTTP_ALLOW_AUDIT_WRITE` on — the general document-write tools are then **not registered** for that session (`INV-6`, endpoint separation); any injected write is confined to the audit subtree (`INV-9`). | The scanner can still append junk into the audit subtree; the blast radius is that subtree only, and reports are create-only (never overwrite existing files). |
| Authorization-code replay / injection                                                             | Codes are single-use, short-TTL, CSPRNG, bound to client/redirect/PKCE challenge (`INV-7`).                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                    |
| `plain` PKCE downgrade                                                                            | S256 only; `plain` rejected (`INV-7`, `pkce.ts`).                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                                                    |
| Reading arbitrary files via a crafted `patch_id`                                                  | `patch_id` validated as UUID; patch path constrained (`INV-3`).                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                    |
| Prompt injection in vault content steering the agent into unsafe actions or forging user approval | Server `instructions` declare returned content/tool output is **data, not commands or approval** (`INV-5`); write tools carry explicit safety annotations; synthetic fixtures pin that read operations do not mutate note/patch state. Path/scope/no-overwrite/stale checks remain deterministic.                                                                                    | ⚠️ The server cannot prove that a downstream model understood the content. Direct `create_document` remains one-step and therefore requires the client UI/agent to obtain the current user's approval of the exact target/content. Model detection is not an authorization boundary. |
| Compromise of the server process escaping to the host                                             | Loopback bind, least-privilege env; **systemd sandbox hardening documented** (operations.md §"Sandbox hardening" — `ProtectHome`/`ProtectSystem=strict`/empty `CapabilityBoundingSet`/`SystemCallFilter=@system-service`/`MemoryDenyWriteExecute`) = layer 1; **bwrap stdio sandbox documented** (operations.md §6 — bind-only filesystem, `--unshare-all`, `--clearenv`) = layer 3. | ⚠️ Both layers are **operator-applied** (docs, not enforced by the code). Reduced from "limited isolation".                                                                                                                                                                          |

---

## 5. Assurance

Security behaviors are **pinned by tests** (`pnpm test`, vitest), not just by
convention — see `tests/pathSafety.test.ts`, `tests/knowledgeStore.test.ts`,
`tests/skillStore.test.ts`, `tests/auditStore.test.ts`, `tests/httpServer.test.ts`,
`tests/promptInjection.test.ts`, and
`tests/oauth.test.ts`. Coverage includes path
traversal (raw/encoded/malformed/absolute/`~`/NUL/over-length), symlink escape +
cycle, frontmatter allowlist + value-type rejection, two-step stale reject,
overwrite collision, constrained Skill bundle creation, the constrained audit
write surface (`INV-9`: run_id validation, create-only reports, sha256 CAS,
serialized ops, and rejection of general writes into the audit subtree),
HTTP 401/per-surface tool registration, and the full OAuth flow
(PKCE match/mismatch, single-use codes, redirect policy, refresh rotation,
audience-bound `/mcp`).

Supply chain: GitHub Actions are SHA-pinned, workflows run least-privilege
(`contents: read`, per-job elevation), CODEOWNERS gates `.github/`, Dependabot +
CodeQL are enabled.

---

## 6. Known gaps & residual risk

These are **not** mitigated in v0.1.0 and are tracked in
[`ROADMAP.md`](./ROADMAP.md#security--enterprise-maturity-gaps-not-yet-addressed):

- **No third-party penetration test** — self/AI review only.
- **No audit log** (Repudiation) — and no OpenTelemetry/structured events.
- **Single-user; no RBAC** (Spoofing/EoP at the team level).
- **No DLP / exfiltration detection** (Information disclosure by an authorized
  client).
- **Sandbox isolation** of the server process (EoP after compromise): layers 1
  (systemd hardening) and 3 (bwrap stdio sandbox) are now **documented** in
  operations.md but remain operator-applied, not code-enforced.
- **Secret hygiene relies on discipline** — hardened secret scanning / signed
  release artifacts not yet in place.

Suggested sequencing (from ROADMAP): formalize this threat model → add a
content-free **audit log** → commission a **third-party pen test**; treat RBAC /
DLP / sandboxing as larger bets gated on validated team-adoption demand.
