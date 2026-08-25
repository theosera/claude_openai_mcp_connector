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
 Claude Desktop/API ───▶ static bearer ──────▶│            │   read-only unless that surface's own flag + vault.write
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

> ⚠️ **`read-only unless <that surface's flag> + vault.write` is two independent
> conditions for every principal — but for the static bearer the second is only as
> narrow as the operator made it.**
>
> ★ **The flag half is per-surface, not one global `allowWrite`.** `surfaceFor`
> AND-s `vault.write` separately with `allowWrite` (the document plan/apply
> tools), `allowLegacyCreateDocument`, `allowSkillWrite` and `allowAuditWrite`,
> so **turning one off does not close the others** — an endpoint with
> `MCP_HTTP_ALLOW_WRITE` unset but `MCP_HTTP_ALLOW_SKILL_WRITE` on is not
> read-only. Raised by CodeRabbit on #144; the earlier wording named `allowWrite`
> as though it were the whole gate.
>
> `authenticate()` used to return
> `{scopes: [vault.read, vault.write]}` unconditionally once the token matched,
> so on that path the second half was always true and the flag was the only gate.
> It now returns `config.authTokenScopes` (`MCP_AUTH_TOKEN_SCOPES`,
> `src/httpServer.ts`), **whose default is those same two scopes**: unset, the
> behaviour is exactly what it was, and a deployment that never sets it should
> read every statement of the pair the way the old caveat said. What changed is
> that a **read-only static bearer is now expressible** (`vault.read`), and that
> the variable can only narrow — an unknown scope refuses to start. For an
> **OAuth** token the scopes come from its grant, as before.

---

## 4. STRIDE analysis

### S — Spoofing (identity)

| Threat                                     | Mitigation (invariant / code)                                                                                           | Residual                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Unauthenticated caller hits `/mcp`         | Bearer required; fail-closed if `MCP_AUTH_TOKEN` unset (`INV-6`, `httpAuth.ts`, `config.ts`). 401 + `WWW-Authenticate`. | Token strength is the operator's responsibility.                     |
| Web client can't send a static bearer      | OAuth 2.1 + PKCE S256 + DCR; login gated by `MCP_OAUTH_PASSWORD` (scrypt) (`INV-7`, `oauth/`).                          | Shared single-user password (no per-user identity — see gaps: RBAC). |
| Token/timing side-channel on compare       | Constant-time compare, length-normalized (`INV-6`, `httpAuth.ts`; `INV-7` PKCE/login).                                  | —                                                                    |
| DNS-rebinding to reach the loopback server | `rejectRebinding` at the endpoint boundary, ahead of era routing, so both protocol eras are covered identically (`INV-6`, `httpServer.ts`): `Host` compared by hostname against `allowedHosts`, `Origin` compared as an exact full origin against `allowedOrigins`. | Operator must add only the intended tunnel host. Checked on `/mcp` only; an `Origin`-less request passes (D-M1-ORIGIN-ABSENT). |

### T — Tampering (integrity)

| Threat                                                                                       | Mitigation                                                                                                                                                                                                                 | Residual                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path traversal / encoded traversal / symlink escape to write outside the vault               | Multi-phase guard, fail-closed (`INV-1`, `pathSafety.ts`); realpath prefix + symlink-escape checks on every write path (`knowledgeStore.ts`).                                                                              | New write paths must route through the guard (enforced by review + tests).                                                                                        |
| Destructive or **stale** overwrite of an existing note                                       | Two-step `plan`→`apply` with SHA-256 staleness check; reject if changed (`INV-3`).                                                                                                                                         | A within-window concurrent edit is detected, not merged.                                                                                                          |
| Creating a note at an unintended exact path                                                  | `plan_document_create` returns the complete diff and structured target-path question; apply requires an exact `confirmed_target_path` echo, verifies staged-content integrity, and re-runs containment (`INV-1`, `INV-3`). | The server cannot prove which client UI rendered the question; current-user confirmation remains a client/agent responsibility reinforced by server instructions. |
| Overwriting a file via "create"                                                              | Every create uses `flag: "wx"`; exact-path planning has no target-side effect and apply rejects collisions (`INV-3`).                                                                                                      | The legacy routed `create_document` is now **off by default on every transport** (`MCP_ALLOW_LEGACY_CREATE_DOCUMENT`); an operator who re-enables it takes back the obligation to have the client show its exact target and content before calling it.                                  |
| Forging server-owned frontmatter (`id`, `updated_at`) or injecting arbitrary YAML keys/types | **Two layers, because the allowlist only covers the general write path.** (1) Field **allowlist** + value-type checks on `frontmatter_patch` (`INV-2`, `frontmatter.ts`). (2) A frontmatter `id` read back off disk is **not treated as identity**: `fetch` resolves a reference only when it names exactly one document across the id and path namespaces, and fails closed otherwise (`INV-2`, `resolveUniqueReference`, enforced in both `knowledgeStore.ts` and `multiRootStore.ts`).                                                                                                                                                       | Layer 2 is a **denial of service by design**: a planted duplicate `id` makes its victim unresolvable by the colliding reference, and a note carrying no frontmatter `id` of its own has no other handle. Accepted over silently serving the impostor. Allowlist widening requires threat review + tests. |
| Serving an attacker-authored note in place of the one a caller asked for                     | Same layer 2 as above. Untrusted vault content cannot claim another document's identity without the collision being detected — including the case where the forged `id` is the victim's own vault-relative path (`INV-2`, `INV-5`).                                                                                                                                                       | The constrained surfaces that write client bytes verbatim (`append_audit_report`, `compare_and_swap_audit_state`, Skill `references/*.md`) can no longer *author* an `id` either: the Skill-reference writer refuses `id` and `updated_at` through `assertNoServerOwnedFrontmatter`, and the two audit writers through `assertAuditWritableFrontmatter`, which allows `title`/`tags` and calls the same server-owned check inside itself — one choke point per store either way (`INV-8`, `INV-9`). Residual: the check must parse to know what content claims, so both read declared keys through `declaredFrontmatterKeys`, which applies the same block cap in the same order as `parseMarkdown` before gray-matter runs — a future writer that parses frontmatter without it would reopen the quadratic path on a write surface. A process writing into the vault outside this server (the launchd scanner writes its reports directly) is not covered by either layer. |
| Forging or clobbering audit-scan files via the general document-write tools                  | General writes are **forbidden from the audit subtree** (`INV-9`, `assertNotAuditReserved`, realpath-based); only `append_audit_report` (create-only, never overwrites) and `compare_and_swap_audit_state` (sha256 CAS) write there, serialized in-process (`auditStore.ts`). | Cross-process CAS is best-effort under the single-writer assumption; a torn crash-time write leaves a short file, not a merged one.                                |
| Promoting audit-surface content into a project's designated state                            | The audit surface is constrained in **what it may claim**, not only in where it writes: a report or state file may declare `title` and `tags` and nothing else (`INV-9`, `assertAuditWritableFrontmatter` at `assertWritableText`, the choke point both writers pass). Without it a principal holding audit-write alone could declare `project` plus the state tag and have `get_project_state` return that body as full text against its token budget, described as a note the owner designated. | A tag stays self-declared — it designates nothing on a file that cannot name a project, because `get_project_state` filters by `project` first. It is **not inert**, and it is not only a filter the caller selects (`search_documents(tags)`, `list_projects(tags)`, `get_context(tags)` — the last returns matching sections as text): free-text search scores a document up for each query term matching a tag, so a tagged report can surface in a query that never named it, and an operator-configured tag rule can attach a weighted `type` in `get_context`. That much the document does author. What it still cannot author is designation. Everything retrieved stays untrusted vault content under `INV-5`; the frontmatter rule also does not reach the **body**, whose markdown links produce ordinary graph edges (`trace_sources` backlinks, `linked:*` neighbours). This bounds what audit text can claim to *be*, not that it is written, found, or linked. |
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
| Over-broad remote capability                                        | Read-only by default; a write tool is **not even registered** without **its own surface flag** (`allowWrite` / `allowLegacyCreateDocument` / `allowSkillWrite` / `allowAuditWrite`) **and** `vault.write` scope (`INV-6`, `INV-7`). ⚠️ Unsetting one flag closes one surface, not all four. | ⚠️ For the **static bearer** the scope half defaults to full (see §3), so unless `MCP_AUTH_TOKEN_SCOPES` narrows it the flag is the only gate. Independent for OAuth tokens. |
| OAuth open-redirect leaking a code                                  | `redirect_uri` exact-match + https/loopback only; bad client/redirect → 400, not redirected (`INV-7`).                       | —                                                                                    |
| Secret/vault committed to the public repo                           | `.gitignore` + synthetic-only fixtures + per-file `git add` (`INV-4`).                                                       | ⚠️ Relies on discipline; **harder secret-scanning is a gap** (ROADMAP).              |
| Exfiltration of vault content by an authorized-but-malicious client | —                                                                                                                            | ⚠️ **No DLP / exfiltration detection** (known gap, ROADMAP). Out of scope for 0.1.0. |

### D — Denial of service

| Threat                                                   | Mitigation                                                                          | Residual                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Symlink cycle causing unbounded recursion                | `walkMarkdownFiles` tracks visited realpaths; cycle terminates (`INV-1`, guard #8). | —                                                                                 |
| **One unreachable vault entry disabling every read tool** | **The vault's own contents are an availability input, which this section previously did not say. Every read tool walks the whole vault, so a single entry the OS cannot resolve used to abort all of them — and the usual cause is not an attack but a synced folder (iCloud, Dropbox) leaving a dangling link. `walkSubtree` classifies on errno (`ENOENT` / `EACCES` / `EPERM` / `ELOOP` / `ENOTDIR`) and skips that entry, naming it on stderr.** | **A containment failure carries no errno and still aborts the walk — deliberately, since INV-1 must fail closed and a `catch` broad enough to skip an escape would downgrade it. So a root-escaping symlink is still a whole-vault outage until the operator removes it; stderr now names which entry.** |
| **Transient descriptor exhaustion during a scan**         | **`EAGAIN` / `EMFILE` / `ENFILE` are retried with backoff and jitter in BOTH stages of a scan — reading a note (`readDocumentResilient`) and walking to find it (`withTransientRetry`). They disagreed until the walk half landed; the walk let the errno out, where it is not an unreachable-entry code.** | **Retries are finite (`SCAN_MAX_RETRIES`). Sustained exhaustion still aborts a scan rather than serving a truncated vault, which is the intended direction: a skipped directory is an unbounded number of missing notes, and a search answering from a partial corpus reports "no such note" about notes that exist.** |
| Unbounded OAuth client/token minting (memory exhaustion) | Capped + pruned collections; DCR input limits (`INV-7`).                            | Store is in memory by default; a restart clears it (and forces re-auth — see operations.md). Opt-in `MCP_OAUTH_STATE_FILE` persists it hashed-at-rest with an HMAC and fail-closed load (`INV-7` item 7), which survives restarts but does not change the caps. |
| Oversized request body                                   | Body cap → 413 (`INV-6`).                                                           | No global rate limiting beyond the coarse OAuth-endpoint limiter.                 |

### E — Elevation of privilege

| Threat                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                                                                                           | Residual                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read-scoped web token performing writes                                                           | Session registers write tools only when `allowWrite && token has vault.write`; otherwise undiscoverable (`INV-7`, `INV-6`).                                                                                                                                                                                                                                                          | ⚠️ Holds for **web (OAuth) tokens**, which is what this row is about. A **static bearer** carries `vault.write` by default; it is read-scopeable now (`MCP_AUTH_TOKEN_SCOPES=vault.read`), but only if the operator sets it — see §3. |
| Unattended write-enabled connector steered into general writes by a malicious note (confused deputy) | Run the unattended scan on a dedicated endpoint with general write **off** and only `MCP_HTTP_ALLOW_AUDIT_WRITE` on — the general document-write tools are then **not registered** for that session (`INV-6`, endpoint separation); any injected write is confined to the audit subtree (`INV-9`). | The scanner can still append junk into the audit subtree; the blast radius is that subtree only, and reports are create-only (never overwrite existing files). |
| Authorization-code replay / injection                                                             | Codes are single-use, short-TTL, CSPRNG, bound to client/redirect/PKCE challenge (`INV-7`).                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                    |
| `plain` PKCE downgrade                                                                            | S256 only; `plain` rejected (`INV-7`, `pkce.ts`).                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                                                    |
| Reading arbitrary files via a crafted `patch_id`                                                  | `patch_id` validated as UUID; patch path constrained (`INV-3`).                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                    |
| Prompt injection in vault content steering the agent into unsafe actions or forging user approval | Server `instructions` declare returned content/tool output is **data, not commands or approval** (`INV-5`); write tools carry explicit safety annotations; synthetic fixtures pin that read operations do not mutate note/patch state. Path/scope/no-overwrite/stale checks remain deterministic.                                                                                    | ⚠️ The server cannot prove that a downstream model understood the content. Direct `create_document` is one-step, so that residual rested entirely on the client UI/agent obtaining approval; it is therefore off unless `MCP_ALLOW_LEGACY_CREATE_DOCUMENT` is set, leaving every enabled-by-default document write gated by plan/apply. Model detection is not an authorization boundary. |
| Compromise of the server process escaping to the host                                             | Loopback bind, least-privilege env; **systemd sandbox hardening documented** (operations.md §"Sandbox hardening" — `ProtectHome`/`ProtectSystem=strict`/empty `CapabilityBoundingSet`/`SystemCallFilter=@system-service`/`MemoryDenyWriteExecute`) = layer 1; **bwrap stdio sandbox documented** (operations.md §6 — bind-only filesystem, `--unshare-all`, `--clearenv`) = layer 3. | ⚠️ Both layers are **operator-applied** (docs, not enforced by the code). Reduced from "limited isolation".                                                                                                                                                                          |

---

## 5. Fail-closed posture by operation class

STRIDE above is organized by threat. This table is organized by **operation
class**, because "does it fail closed?" is asked per operation and the answer is
deliberately not uniform. Three of the seven classes are empty, and that is the
most useful thing the table says.

| Operation class          | Posture | Where, and what happens                                                                                                                                                                                                                 |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **read**                 | mixed — deliberately | Containment failures throw (`INV-1`); an unreadable or unparseable **individual note** degrades instead, because the read path has an obligation to keep serving the rest of the vault. Both directions are argued in the D-section rows above; see them rather than a restatement here. |
| **write**                | **closed — by three mechanisms, not one** | **Planned document / Skill writes**: no plan → no apply; stale `expected_sha256` → refuse; `wx` on every create; unparseable frontmatter throws here where the read path degrades (`INV-2`, `INV-3`, `INV-8`). **Direct-write surfaces do not go through plan/apply** and are gated separately: `append_audit_report` is create-only (an existing report is never overwritten) and `compare_and_swap_audit_state` refuses unless the hash matches the version read, both confined to `MCP_AUDIT_SUBDIR` (`INV-9`); one-step `create_document` is off unless `MCP_ALLOW_LEGACY_CREATE_DOCUMENT` is set. **"No plan → no apply" describes the default document path, not the whole class.** |
| **delete**               | **n/a — the operation does not exist** | No tool deletes a vault document. The only unlinks in the process are the staged-plan sweep (`prunePatchState`) and temp-file cleanup, neither of which is client-reachable.                                                            |
| **execute**              | **n/a — the operation does not exist** | Measured at `6897747`: **zero** `child_process` / `spawn` / `execFile` call sites in `src/`. There is no subprocess surface to gate.                                                                                                    |
| **network (outbound)**   | **n/a — the operation does not exist** | Measured at `6897747`: **zero** outbound `fetch` / `http(s).request` call sites in `src/`. The server accepts connections; it does not make them.                                                                                       |
| **credential**           | **closed** | `MCP_AUTH_TOKEN` missing → refuse to start rather than serve unauthenticated (`INV-6`); `MCP_AUTH_TOKEN_SCOPES` set to an unknown, empty, or read-less value → refuse to start rather than fall back to the full set; OAuth issuer/password missing → refuse to start (`INV-7`); tampered or unreadable OAuth state → load as **empty** rather than trusting it.       |
| **external side effect** | **closed — and not empty** | **This does not follow from the three empty rows**, which is what an earlier draft of this row assumed. The process initiates nothing, but an enabled write surface still leaves an externally visible effect: **files created or replaced under the configured roots.** A root is normally synced, so a write can leave the machine without the server making a single outbound connection — the same property that makes a policy source inside a root unsafe (see the containment rule in [`policy-provenance.md`](./policy-provenance.md)). The gates are the write row's; there is no separate one. Note also that stdio has no HTTP response at all, so "the response is the only effect" would not hold even in the empty case. |

**Two rules this table follows, both learned the hard way:**

1. **A cell that says "degrades" owes a measurement.** A design note claiming
   graceful degradation is not evidence that the degradation is graceful. The
   parse-cache bound shipped in 0.9.0 described itself as degrading into
   re-parsing; measured, the mis-sized version ran a warm scan at 689 ms against
   91 ms with essentially unchanged heap — closer to a stop than a degrade, and
   only a measurement could tell the two apart. **In prose, degradation and
   breakage look identical; the burden of proof is on whoever claims the former.**
2. **A cell that says "closed" may still owe a cost, and the cost is paid
   outside the mechanism.** `MCP_CONTEXT_TYPE_RULES` refusing to boot on an
   unreadable path is correct — and it is the wrong thing to hand someone who
   copied a template, because the template's placeholder path is unreadable by
   construction. The fix ships the variable **commented out**: the refusal is not
   weakened, only the way it is handed over changes. **Mitigating the cost of a
   fail-closed rule must not mean relaxing the rule.**

## 6. Assurance

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

## 7. Known gaps & residual risk

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
