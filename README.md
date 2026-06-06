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

## Public Repo Safety

This repo intentionally ignores `vault/`, `knowledge/`, and `data/` to reduce the chance of committing private Markdown data. Tests use synthetic fixtures only.
