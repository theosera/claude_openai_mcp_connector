# Security

This is a **public code repository** for a local **stdio MCP server** that
exposes a **private** Markdown vault (`KNOWLEDGE_ROOT`) to MCP clients (Codex /
Claude Desktop / Claude Code / future ChatGPT・Claude remote connectors). Real
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
| T2 | Frontmatter / YAML field injection via an edit | `frontmatter_patch` allowlist — only `client` / `project` / `title` / `tags` / `source_refs`; `id` and `updated_at` are server-owned. Unknown key → reject. | `src/frontmatter.ts`, `src/knowledgeStore.ts` |
| T3 | Destructive / lost-update overwrite of a note | Two-step `plan_document_update` → `apply_planned_update` with an `expected_sha256` staleness check (refuses to apply if the file changed); create uses `flag: "wx"` (never overwrites); `patch_id` validated as a UUID. | `src/knowledgeStore.ts` |
| T4 | Prompt injection via vault content returned to the LLM | Server `instructions` declare that returned bodies / frontmatter are vault **data**, not commands to execute or fetch. | `src/index.ts` |
| T5 | Secret / private-vault leak into the public repo | `.gitignore` (vault / keys / tokens / env), `.claude/settings.json` read-deny (Read **and** Bash), explicit-file-add discipline (no `git add -A`, no `--no-verify`). | `.gitignore`, `.claude/settings.json`, `CLAUDE.md` |
| T6 | Supply-chain: poisoned Action / stale pin / tag swap | Third-party Actions full-SHA pinned (+ `# vX.Y.Z`); top-level `permissions: contents: read`; `concurrency`; advisory `pnpm audit`; Dependabot (npm + actions); CODEOWNERS on `.github/`; CodeQL SAST (push + PR + weekly). | `.github/` |

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
- **§6.3 Path-traversal defense** → `src/pathSafety.ts` (multi-phase, fail-closed).
- **§6.6 Frontmatter allowlist** → `src/frontmatter.ts::assertFrontmatterPatch`.
- **§10 Security test coverage** → `tests/pathSafety.test.ts` + `tests/knowledgeStore.test.ts`.

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
pnpm test   # path traversal, symlink escape, frontmatter allowlist, stale-patch, overwrite collision
```

## Reporting a vulnerability

Please report privately to the repository owner (`@theosera`) rather than
opening a public issue.
