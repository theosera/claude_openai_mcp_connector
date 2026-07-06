# Contributing

Thanks for your interest in `claude-openai-mcp-connector` — an MCP server that
exposes a **private** Markdown knowledge vault to Claude, ChatGPT-compatible
clients, and Codex over stdio and an authenticated Streamable HTTP transport.

This guide covers the minimum you need to file a good issue, set up the project,
and open a pull request that can be merged quickly.

## Reporting security issues — do NOT open an issue

If you think you've found a vulnerability (path-traversal / symlink escape out of
the vault, auth bypass on the HTTP transport, an OAuth flaw, a frontmatter /
YAML-injection gap, secret leakage, etc.), **do not open a public issue or PR.**
Follow the private reporting process in [`SECURITY.md`](./SECURITY.md) instead.
Public disclosure of an unpatched issue puts every deployment at risk.

## Ground rules

- **The code repo is public; the vault is private.** Never commit real note
  content, a real vault path, or a private repo URL. Tests use **only** the
  synthetic fixtures under `fixtures/synthetic-vault/`. `.gitignore` already
  excludes `vault/`, `knowledge/`, `data/`, `.env*`, and secret files — keep it
  that way.
- **Don't weaken the security boundary.** Path containment
  (`src/pathSafety.ts`), the frontmatter field allowlist (`src/frontmatter.ts`),
  the two-step stale-safe write (`plan_document_update` → `apply_planned_update`),
  and the HTTP auth / read-only surface are pinned by tests. If you change that
  behavior, update the tests in the same PR and explain why in the description.
- **Be kind.** Interactions are governed by our
  [Code of Conduct](./CODE_OF_CONDUCT.md).

## Filing an issue

Use the issue templates (**Bug report** / **Feature request**) and fill in the
prompts. A good bug report includes:

- what you did (the MCP tool call or config), what you expected, what happened;
- your transport (stdio or HTTP), Node version (`node -v`), and OS;
- a minimal repro against `fixtures/synthetic-vault/` if you can — **never paste
  real vault content**.

Please search existing issues first to avoid duplicates.

## Development setup

Requirements: **Node.js >= 22.12.0** and [pnpm](https://pnpm.io) (pinned via the
`packageManager` field — enable it with Corepack).

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Quality gate — `pnpm test` (and the rest) must pass

CI (`.github/workflows/node.js.yml`) runs the checks below on every PR, in this
order. Run them locally before pushing — the fast ones first fail in
milliseconds:

```bash
pnpm run lint:ox        # fast Rust correctness pass (oxlint)
pnpm run format:check   # Prettier formatting (use `pnpm run format` to fix)
pnpm run lint           # ESLint
pnpm run typecheck      # tsc --noEmit (strict)
pnpm run build          # tsc -> dist/
pnpm test               # vitest — all tests must pass
```

**Security behavior is pinned by tests, not by convention.** New read/write
paths must go through the `src/pathSafety.ts` guard chain, and changes to the
boundary must keep the traversal / symlink-escape / frontmatter-allowlist /
stale-patch / overwrite-collision / HTTP-auth / OAuth tests green (add tests for
new behavior).

## Commit & branch conventions

- **Conventional Commits** for the subject line, e.g.
  `feat: add …`, `fix(oauth): …`, `docs(readme): …`, `chore: …`,
  `test: …`, `deps: bump …`. Keep the subject imperative and under ~72 chars.
- **Branch names**: `claude/<short-kebab-description>` for agent-authored work,
  or a conventional `feat/…` / `fix/…` for human contributors.
- Keep each PR focused on one logical change; split unrelated work.

## Opening a pull request

1. Fork (or branch, if you have access) and push your branch.
2. Open a PR against `main` and fill in the PR template.
3. Make sure **CI is green** — a red build won't be reviewed.
4. Changes under `.github/`, `SECURITY.md`, `CLAUDE.md`, `.claude/`, and the
   security-boundary source files require **code-owner review** (see
   [`.github/CODEOWNERS`](./.github/CODEOWNERS)); expect an extra review pass
   there.
5. Note any user-facing change in `CHANGELOG.md` under `[Unreleased]`.

Small, well-tested PRs with a clear description get merged fastest. Thanks for
contributing!
