# Claude/OpenAI Markdown MCP Connector

Local MCP server for exposing a private Markdown knowledge vault to MCP-capable clients such as Codex, Claude Desktop, Claude Code, and future ChatGPT/Claude remote connector deployments.

The code repository is intended to be public. The Obsidian Vault or other Markdown knowledge base stays private and is referenced only through `KNOWLEDGE_ROOT`.

## Features

- Search Markdown documents under a private local vault.
- Fetch document body, frontmatter, file stats, and source refs.
- List projects grouped by `client` and `project`.
- Create new Markdown documents.
- Edit existing Markdown through a two-step `plan_document_update` then `apply_planned_update` flow.
- Trace source refs, outgoing Markdown links, and backlink candidates.
- Reject path traversal, symlink escape, overwrite collisions, and stale patch application.

## Setup

```bash
pnpm install
pnpm run build
```

Create a local `.env` file:

```bash
cp .env.example .env
```

Then set:

```text
KNOWLEDGE_ROOT=/path/to/private/obsidian-vault
MCP_WRITE_MODE=two_step
MCP_PATCH_STATE_DIR=.mcp-state/patches
```

Do not commit `.env`, private vault URLs, private vault paths, or real note content.

## Run

```bash
pnpm run build
node dist/index.js
```

Example Codex project config:

```toml
[mcp_servers.claude-openai-vault]
command = "node"
args = ["/absolute/path/to/claude_openai_mcp_connector/dist/index.js"]
env = { KNOWLEDGE_ROOT = "/absolute/path/to/private/vault" }
```

## Tools

- `search_documents`
- `fetch_document`
- `list_projects`
- `create_document`
- `plan_document_update`
- `apply_planned_update`
- `trace_sources`

## Security

The vault is driven by an untrusted MCP client (an LLM), so security is enforced
in code and pinned by tests:

- **Path containment** — every file access is confined to `KNOWLEDGE_ROOT` by a
  multi-phase guard (length cap, control/NUL rejection, percent-decode
  validation, NFC normalization, absolute/`~`/`..` rejection, realpath prefix
  check, symlink-escape check). Violations fail closed (`src/pathSafety.ts`). The
  vault walk is also cycle-safe (tracks visited real paths) so a symlink loop
  can't cause unbounded recursion.
- **Frontmatter allowlist** — `plan_document_update` only accepts the
  `client` / `project` / `title` / `tags` / `source_refs` keys; `id` and
  `updated_at` are server-owned, and each value is type-checked (string vs
  string[]) — blocks YAML field injection and type confusion.
- **Stale-safe, non-destructive writes** — edits go through `plan` → `apply`
  with a SHA-256 staleness check; creates never overwrite (`flag: "wx"`).
- **Untrusted content boundary** — the server `instructions` declare returned
  content is data, never commands.

Supply-chain & governance: GitHub Actions are SHA-pinned, workflows run with
`permissions: contents: read`, CODEOWNERS gates `.github/`, Dependabot + CodeQL
are enabled, and a 3-layer Claude Code agent governance model
(`CLAUDE.global.md` → `CLAUDE.md` → `.claude/skills/`) keeps the AI workflow
inside the same guardrails. See [`SECURITY.md`](./SECURITY.md) for the full
threat model and the curated mapping to the Reusable Security Baseline.

## Public Repo Safety

This repo intentionally ignores `vault/`, `knowledge/`, and `data/` to reduce the chance of committing private Markdown data. Tests use synthetic fixtures only.
