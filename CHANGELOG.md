# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-06-09

First tagged release. MCP server exposing a private Markdown vault
(`KNOWLEDGE_ROOT`) over two transports:

### Added

- Add oxlint as a fast correctness pre-pass before ESLint, typecheck, build, and tests.

- **stdio transport** for local CLI/desktop clients (Claude Code, Codex, Claude
  Desktop) with the full tool surface.
- **Streamable HTTP transport** for remote Chat connectors, hardened with bearer
  auth (constant-time, fail-closed), loopback bind, DNS-rebinding protection,
  request-body cap, and a read-only tool surface unless `MCP_HTTP_ALLOW_WRITE=1`.
- **OAuth 2.1 authorization server** (opt-in) for ChatGPT / Claude.ai web:
  metadata discovery, dynamic client registration, PKCE S256, authorization-code
  + refresh-token grants, scrypt login gate, scope enforcement
  (`vault.read` / `vault.write`), RFC 8707 audience binding, and consent-page
  clickjacking headers.
- Coarse per-client **rate limiting** on the public OAuth endpoints
  (`/authorize`, `/register`), and **ESLint + Prettier** with `lint` / `format` /
  `format:check` scripts wired into CI.
- Search **parse cache** (mtime/size-invalidated) in `KnowledgeStore` so queries
  no longer re-parse unchanged Markdown files on every call.
- Tools: `search_documents`, `fetch_document`, `list_projects`, `trace_sources`,
  `create_document`, `plan_document_update` → `apply_planned_update` (two-step,
  stale-safe writes), and ChatGPT-compatible `search` / `fetch` aliases.
- Security invariants pinned by tests: path containment, symlink-escape/cycle,
  frontmatter allowlist, two-step stale-safe writes, HTTP auth + read-only
  surface, and the full OAuth flow.

[Unreleased]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/theosera/claude_openai_mcp_connector/releases/tag/v0.1.0
