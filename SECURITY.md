# Security

This is a **public code repository** for an MCP server that exposes a
**private** Markdown vault (`KNOWLEDGE_ROOT`) to MCP clients over two transports:
**stdio** for local CLI/desktop clients (Codex / Claude Desktop / Claude Code)
and an authenticated **Streamable HTTP** endpoint for remote Chat connectors
(ChatGPT / Claude.ai). Real
note content, the vault path, and any private repo URL are **never committed**;
tests use only the synthetic fixtures under `fixtures/synthetic-vault/`.

The controls below are a **curated subset** of the shared *Reusable Security
Baseline*, selected for what this connector actually does: read / search / trace
and *safely* create / update Markdown files confined to one root, driven by an
**untrusted MCP client** (an LLM).

## Threat model

| # | Threat | Control | Where |
|---|---|---|---|
| T1 | Path traversal / symlink escape out of the vault | Multi-phase path guard: length cap → control/NUL reject → percent-decode validation → NFC normalize → absolute/`~`/`..` reject → realpath prefix check → symlink-escape check. Fail-closed (throws, no silent fallback). | `src/pathSafety.ts`, `src/knowledgeStore.ts` |
| T2 | Frontmatter / YAML field injection (incl. type confusion) via an edit | `frontmatter_patch` allowlist — only `client` / `project` / `title` / `tags` / `source_refs`; `id` and `updated_at` are server-owned; unknown key → reject. Values are type-checked: `client`/`project`/`title` = string, `tags`/`source_refs` = string[] (blocks nested-object / wrong-type YAML injection). | `src/frontmatter.ts`, `src/knowledgeStore.ts` |
| T3 | Destructive / lost-update overwrite of a note | Two-step `plan_document_update` → `apply_planned_update` with an `expected_sha256` staleness check (refuses to apply if the file changed); create uses `flag: "wx"` (never overwrites); `patch_id` validated as a UUID. | `src/knowledgeStore.ts` |
| T4 | Prompt injection via vault content returned to the LLM | Server `instructions` declare that returned bodies / frontmatter are vault **data**, not commands to execute or fetch. | `src/index.ts` |
| T5 | Secret / private-vault leak into the public repo | `.gitignore` (vault / keys / tokens / env), `.claude/settings.json` read-deny (Read **and** Bash), explicit-file-add discipline (no `git add -A`, no `--no-verify`). | `.gitignore`, `.claude/settings.json`, `CLAUDE.md` |
| T6 | Supply-chain: poisoned Action / stale pin / tag swap / vulnerable dependency | Third-party Actions full-SHA pinned (+ `# vX.Y.Z`); top-level `permissions: contents: read`; `concurrency`; advisory `pnpm audit`; Dependabot (npm + actions); CODEOWNERS on `.github/`; CodeQL SAST (push + PR + weekly). Dependencies kept advisory-clean (`pnpm audit --audit-level low`). | `.github/`, `package.json` |
| T7 | Denial of service via symlink cycle / unbounded traversal | The vault directory walk tracks visited real paths and returns on revisit, so a `loop → root` symlink stops instead of recursing forever; the per-symlink realpath prefix check still rejects out-of-root targets (T1 is not weakened). | `src/knowledgeStore.ts` |
| T8 | Unauthenticated / over-exposed remote HTTP endpoint (vault read or write by anyone who reaches the port; DNS-rebinding; write amplification over the network) | Bearer auth on every request (`MCP_AUTH_TOKEN`, constant-time compare, **fail-closed**: refuses to start without a token, 401 otherwise); binds to `127.0.0.1` by default; DNS-rebinding protection via `allowedHosts`/`allowedOrigins`; request-body size cap; **read-only tool surface unless `MCP_HTTP_ALLOW_WRITE=1`** (write tools are not even registered). | `src/httpServer.ts`, `src/httpAuth.ts`, `src/config.ts`, `src/server.ts` |
| T9 | OAuth 2.1 flow abuse for the web-client path (auth-code interception/replay, PKCE downgrade, open redirect, weak/guessable tokens, unbounded client/token growth, **token reuse across resources, scope escalation to writes, consent-page clickjacking, DCR input flooding**) | PKCE **S256 mandatory** (`plain` rejected); authorization codes are CSPRNG, **single-use**, short-TTL, and bound to client_id/redirect_uri/code_challenge; redirect URIs **exact-match** a registered https/loopback value (no open redirect); login-password gate uses a **slow KDF (scrypt)** + constant-time compare and is **fail-closed** (refuses to enable OAuth without issuer URL + password); tokens are 256-bit opaque with refresh rotation; **audience-bound (RFC 8707)** to the canonical `/mcp` resource and rejected on `/mcp` if the audience mismatches; **scope-gated** (`vault.read`/`vault.write`) — a read-scoped session never registers write tools, and `vault.write` is granted only when `MCP_HTTP_ALLOW_WRITE=1`; consent page sets `CSP frame-ancestors 'none'` + `X-Frame-Options: DENY` + `Referrer-Policy: no-referrer`; DCR caps redirect-URI count/length + client_name length; all OAuth collections are capped + pruned; no codes/tokens/passwords logged. | `src/oauth/pkce.ts`, `src/oauth/store.ts`, `src/oauth/provider.ts`, `src/httpAuth.ts`, `src/config.ts`, `src/httpServer.ts` |

## Curated mapping to the Reusable Security Baseline

Selected (implemented here) — relevant to this connector:

- **§0 3-layer agent governance** → `CLAUDE.global.md` (byte-identical global) +
  `CLAUDE.md` (repo hard rules + firing table) + `.claude/skills/mcp-vault-security/`.
- **§1.1 / §1.4 Secrets** → hardened `.gitignore` + `.claude/settings.json` deny rules.
- **§1.5 Env-only credentials** → `KNOWLEDGE_ROOT` etc. resolved from env in `src/config.ts`.
- **§3.1 / §3.2 / §3.3 / §3.5 / §3.6 / §3.9 / §3.4 CI/CD** → SHA-pinned Actions,
  least-privilege permissions, concurrency, advisory `pnpm audit`, Dependabot,
  CODEOWNERS, CodeQL.
- **§5.4 Untrusted-content boundary** → MCP server `instructions` (data, not commands).
- **§4 Remote-transport authn / network exposure** → bearer-token auth
  (constant-time, fail-closed), loopback bind, DNS-rebinding protection, body-size
  cap, and default read-only surface for the HTTP transport (`src/httpServer.ts`,
  `src/httpAuth.ts`).
- **§4 OAuth 2.1 for web clients** → built-in single-user authorization server
  (PKCE S256, single-use codes, exact-match redirects, constant-time login gate,
  opaque rotating tokens, capped state) in `src/oauth/` — required because
  ChatGPT/Claude.ai web reject static bearers.
- **§6.3 Path-traversal defense** → `src/pathSafety.ts` (multi-phase, fail-closed) +
  a bounded, cycle-safe vault walk in `src/knowledgeStore.ts` (visited-real-path set).
- **§6.6 Frontmatter allowlist** → `src/frontmatter.ts::assertFrontmatterPatch`
  (key allowlist + per-key value-type validation).
- **§10 Security test coverage** → `tests/pathSafety.test.ts` + `tests/knowledgeStore.test.ts`
  (incl. symlink-cycle traversal and frontmatter value-type cases).

Intentionally **not** ported (out of scope for this connector): Python-specific
controls (ruff/mypy/pip-audit/uv, `sanitize.py`, Docker capture sandbox,
`claude_cli.py` subprocess hardening), the Gmail/threat-report intake pipeline
(§9) and its chat-mode routing, and `.cursor/rules/` (no Cursor usage here).

## Agent governance (3-layer)

- **`CLAUDE.global.md`** — universal guardrails (byte-identical across the repo
  family; intended as `~/.claude/CLAUDE.md`): secrets are never read without
  instruction, untrusted data is never executed (prompt-injection defense),
  destructive ops require confirmation, skill firing is deterministic.
- **`CLAUDE.md`** — repo-specific hard rules + a skill firing table.
- **`.claude/skills/mcp-vault-security/`** — detailed security invariants + a
  "which file enforces what" map, loaded on demand before editing boundary code.

## Verification

Security behavior is pinned by tests, not just convention:

```bash
pnpm test   # path traversal, symlink escape + cycle, frontmatter allowlist + value types, stale-patch, overwrite collision, HTTP bearer auth + read-only tool surface, OAuth 2.1 (PKCE, single-use codes, redirect policy, full flow)
```

## Reporting a vulnerability

Please report privately to the repository owner (`@theosera`) rather than
opening a public issue.
