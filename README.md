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

## Transports

The same server speaks two transports, selected with `MCP_TRANSPORT`:

| `MCP_TRANSPORT` | Use for | Tools |
| --- | --- | --- |
| `stdio` (default) | Local CLI / desktop clients: **Claude Code**, **Codex CLI**, **Claude Desktop** | full (read + write) |
| `http` | Remote **Chat connectors**: **ChatGPT**, **Claude.ai** | read-only by default; writes require `MCP_HTTP_ALLOW_WRITE=1` |

Chat connectors cannot launch a local process, so they require the HTTP
transport reachable over HTTPS. Because the vault is private, the HTTP endpoint
binds to `127.0.0.1` and **requires a bearer token** (`MCP_AUTH_TOKEN`); expose
it to the internet only through an explicit HTTPS tunnel.

### Run (stdio — local CLI clients)

```bash
pnpm run build
KNOWLEDGE_ROOT=/abs/path/to/vault node dist/index.js
```

### Run (HTTP — Chat connectors)

```bash
pnpm run build
MCP_TRANSPORT=http \
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
MCP_HTTP_PORT=8787 \
KNOWLEDGE_ROOT=/abs/path/to/vault \
node dist/index.js
# Listening on http://127.0.0.1:8787/mcp  (GET /healthz for liveness)
```

Then expose it over HTTPS with a tunnel and add the public hostname to
`MCP_HTTP_ALLOWED_HOSTS`:

```bash
cloudflared tunnel --url http://127.0.0.1:8787   # or: ngrok http 8787
# -> https://<random>.trycloudflare.com  (use .../mcp as the connector URL)
```

## Client registration

### Claude Code (CLI, stdio)

```bash
claude mcp add vault -- node /abs/path/to/claude_openai_mcp_connector/dist/index.js
# set KNOWLEDGE_ROOT in the spawned env, e.g. via a wrapper or:
claude mcp add vault --env KNOWLEDGE_ROOT=/abs/path/to/vault -- node /abs/.../dist/index.js
```

### Codex CLI (stdio)

```toml
# ~/.codex/config.toml
[mcp_servers.claude-openai-vault]
command = "node"
args = ["/abs/path/to/claude_openai_mcp_connector/dist/index.js"]
env = { KNOWLEDGE_ROOT = "/abs/path/to/private/vault" }
```

### Claude Desktop (stdio)

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "claude-openai-vault": {
      "command": "node",
      "args": ["/abs/path/to/claude_openai_mcp_connector/dist/index.js"],
      "env": { "KNOWLEDGE_ROOT": "/abs/path/to/private/vault" }
    }
  }
}
```

### ChatGPT (Chat connector, HTTP)

Run the HTTP transport + tunnel (above), then add a connector pointing at
`https://<tunnel-host>/mcp` with an `Authorization: Bearer <MCP_AUTH_TOKEN>`
header. The server exposes ChatGPT-compatible `search` and `fetch` tools
(alongside the native tools), so it works in the standard connector flow as well
as Developer Mode.

### Claude.ai (custom connector, HTTP)

Settings → Connectors → *Add custom connector* → URL `https://<tunnel-host>/mcp`,
with the same bearer token. Read-only unless `MCP_HTTP_ALLOW_WRITE=1`.

## Tools

- `search_documents`
- `fetch_document`
- `list_projects`
- `trace_sources`
- `create_document` *(write — stdio, or HTTP only with `MCP_HTTP_ALLOW_WRITE=1`)*
- `plan_document_update` *(write)*
- `apply_planned_update` *(write)*
- `search` / `fetch` — ChatGPT-connector-compatible read-only aliases

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
- **Authenticated, locked-down HTTP transport** — the remote endpoint requires a
  bearer token (`MCP_AUTH_TOKEN`, constant-time compare, fail-closed if unset),
  binds to `127.0.0.1` by default, enables DNS-rebinding protection
  (`allowedHosts`/`allowedOrigins`), caps request body size, and is **read-only
  unless explicitly opted into writes** — so exposing the vault to a Chat client
  never widens the local tool surface by accident.

Supply-chain & governance: GitHub Actions are SHA-pinned, workflows run with
`permissions: contents: read`, CODEOWNERS gates `.github/`, Dependabot + CodeQL
are enabled, and a 3-layer Claude Code agent governance model
(`CLAUDE.global.md` → `CLAUDE.md` → `.claude/skills/`) keeps the AI workflow
inside the same guardrails. See [`SECURITY.md`](./SECURITY.md) for the full
threat model and the curated mapping to the Reusable Security Baseline.

## Public Repo Safety

This repo intentionally ignores `vault/`, `knowledge/`, and `data/` to reduce the chance of committing private Markdown data. Tests use synthetic fixtures only.
