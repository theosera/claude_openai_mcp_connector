# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-07-12

Adds a **constrained, create-only Skill authoring** surface so a (local or
remote) client can publish instruction-only Skill bundles into the vault without
being granted general document-write access. No breaking changes — a setup that
does not enable the new surface behaves exactly as in `0.3.0`.

### Added

- **Instruction-only Skill creation via a separate two-step flow.** New
  `plan_skill_create` → `apply_planned_skill_create` tools stage and then
  **atomically** publish a Skill bundle — `SKILL.md`, optional flat
  `references/*.md` (≤20), and an optional `agents/openai.yaml` — into a
  pre-existing, vault-relative directory (`MCP_SKILLS_SUBDIR`). The surface is
  deliberately narrow: it is **create-only (never overwrites an existing
  Skill)** and **rejects scripts, binary assets, and arbitrary/nested paths**,
  reusing the existing path-containment guard chain. Like document edits, apply
  runs only against a previously planned bundle the user approved
  (`src/skillStore.ts`, `src/server.ts`, `tests/skillStore.test.ts`).
- **Independent HTTP permission boundary for Skill creation.**
  `MCP_HTTP_ALLOW_SKILL_WRITE=1` exposes only the constrained Skill tools over
  HTTP, **separately from document writes** (`MCP_HTTP_ALLOW_WRITE`), and
  requires `MCP_SKILLS_SUBDIR` (the server refuses to start otherwise). Over
  HTTP the tools are registered only when explicitly enabled and are OAuth
  scope-gated — the session registers just the write surface(s) that are turned
  on — so a remote connector can be allowed to author Skills while general
  document writes stay off (`src/config.ts`, `src/httpServer.ts`,
  `tests/httpServer.test.ts`, `tests/oauth.test.ts`).

## [0.3.0] — 2026-07-07

End-to-end hardening for Claude.ai / ChatGPT web connectors and for real-world
vault data (notably non-ASCII / Japanese notes). No breaking changes to the MCP
tool surface — a `0.2.x` setup upgrades in place. Highlights: read tools now
advertise `readOnlyHint` (far fewer approval prompts on web clients), the OAuth
consent redirect is no longer blocked by its own CSP, the public-endpoint rate
limiter keys on the socket peer instead of a spoofable `X-Forwarded-For`, and
several read-path bugs that broke non-ASCII vaults — or aborted a whole-vault
query on a single bad note — are fixed.

### Changed

- **Read tools advertise `readOnlyHint: true` so Chat clients stop prompting for
  approval on every call.** `search_documents` / `fetch_document` / `list_projects`
  / `trace_sources` and the ChatGPT-compatible `search` / `fetch` aliases are pure
  reads, but without the MCP read-only annotation a client (e.g. Claude.ai) treats
  each call as potentially state-changing and shows an "allow once?" prompt every
  time. They now carry the hint. Write tools (`create_document` /
  `plan_document_update` / `apply_planned_update`) deliberately keep **no**
  read-only hint, so clients still prompt before any mutation
  (`src/server.ts`, `tests/httpServer.test.ts`).

### Fixed

- **HTTP rate limiter now keys on the socket peer, not a spoofable
  `X-Forwarded-For`.** The `/authorize` and `/register` limiter keyed on the
  left-most XFF hop, which every proxy only *appends* to — so it is fully
  client-controlled. Over a public tunnel that let a caller bypass the limit
  entirely (a fresh spoofed IP per request) and even lock the legitimate user out
  of their own connector by forging *their* IP. Keying on the (unspoofable) socket
  address makes it a coarse global cap behind a tunnel and naturally per-client on
  a direct bind (`src/httpServer.ts`, `tests/oauth.test.ts`).
- **A single note with a non-string YAML scalar no longer crashes `search` /
  `list_projects` for the whole vault.** YAML auto-types unquoted values, so
  `tags: [2024]` becomes numbers and `client: 2024` a number. Such frontmatter
  parses cleanly (so the fault-tolerant parser never sees an error), but the read
  path then called `tag.toLowerCase()` / `client.localeCompare()` on the value and
  threw — aborting search and list_projects for **every** note, not just the bad
  one. `normalizeMetadata` now coerces `tags` / `source_refs` elements and the
  `client` / `project` scalars to strings at the single read-path chokepoint; the
  write-time field allowlist is untouched (`src/frontmatter.ts`,
  `tests/knowledgeStore.test.ts`).
- **Multi-root: a frontmatter `id` that collides with a root name now fetches the
  note that carries it.** With `KNOWLEDGE_ROOTS`, a vault note whose id begins with
  another root's name + `:` (e.g. `id: "ops:secret"`) was mis-routed by `fetch`
  into that root, returning a **different** document than the one the search
  citation pointed at (or nothing). `MultiRootStore.fetch` now matches a bare id
  against all wrapped documents before treating a `<name>:` prefix as routing
  (`src/multiRootStore.ts`, `tests/multiRootStore.test.ts`).
- **`create_document` keeps non-ASCII (e.g. Japanese) titles instead of collapsing
  them to `untitled`.** The slugifier stripped everything outside `[a-z0-9]`, so an
  all-Japanese `client` / `project` / `title` became empty → `untitled`, letting a
  fully-Japanese vault hold only ONE document per client/project (the 2nd create
  hit the no-overwrite guard). It now keeps Unicode letters/digits (`\p{L}\p{N}`)
  on the NFC-normalized value, with a unique hash suffix for pure-symbol titles
  (`src/knowledgeStore.ts`, `tests/knowledgeStore.test.ts`).
- **`fetch_document` / `fetch` / `trace_sources` now resolve non-ASCII (e.g.
  Japanese) filenames that `search` returns.** Document ids/relative paths derive
  from `fs.realpath`, which on macOS reports filenames **decomposed (NFD)**, while
  `assertRelativePath` normalizes client-supplied paths/ids to **NFC**. The two
  never `===`-matched, so every note with a normalization-sensitive name (most of
  a Japanese vault) came back `Document not found` even though search surfaced it
  — breaking the search→fetch round-trip that Chat clients rely on. `relativeToRoot`
  now returns the identifier in NFC so ids round-trip; both NFC and NFD lookup
  inputs resolve. Path-containment guards are unchanged — containment is verified
  on the raw realpath before normalization, and file I/O still uses the real path
  (`src/pathSafety.ts`, `tests/knowledgeStore.test.ts`).
- **OAuth consent "Authorize" button no longer silently does nothing (Claude.ai /
  ChatGPT web could never finish connecting).** The login page's
  `Content-Security-Policy` used `form-action 'self'`, but a successful login
  redirects (302) back to the client's registered `redirect_uri` on a different
  origin (e.g. `https://claude.ai/api/mcp/auth_callback`). Browsers enforce
  `form-action` against the redirect target of a form submission, so the whole
  submission was refused with no visible error and the authorization code was
  never delivered. The consent form now lists exactly this client's redirect
  origin alongside `'self'` in `form-action` (derived from the already
  exact-match + scheme-validated `redirect_uri`, so the policy stays tight); error
  pages keep the `'self'`-only policy, and the clickjacking/leakage headers
  (`frame-ancestors 'none'`, `X-Frame-Options`, `Referrer-Policy`) are unchanged.
  As part of the same fix, `redirect_uri` registration now rejects wildcard hosts
  (e.g. `https://*/cb`), whose origin (`https://*`) would otherwise widen the
  consent page's `form-action` to every https origin
  (`src/oauth/provider.ts`, `tests/oauth.test.ts`).

## [0.2.1] — 2026-07-07

Public-launch hardening release: a security fix that clears all `pnpm audit`
advisories, read-path and session-archive robustness fixes, and the
community-health files needed to accept outside contributions. No API or
behavior changes to the MCP tool surface — a `0.2.0` setup upgrades in place.

### Added

- **Community-health files** for public contribution: `CONTRIBUTING.md`
  (dev setup, the `pnpm test` quality gate, commit/branch conventions, and the
  "security reports go through SECURITY.md, not issues" rule), a Contributor
  Covenant `CODE_OF_CONDUCT.md`, GitHub issue forms
  (`.github/ISSUE_TEMPLATE/bug_report.yml` / `feature_request.yml` /
  `config.yml`, with blank issues disabled and a security-report contact link),
  and a `.github/PULL_REQUEST_TEMPLATE.md` mirroring the CI quality gate.
- **Actionable private security-reporting channel**: `SECURITY.md` and the issue
  template's security link now point to GitHub private vulnerability reporting
  (draft advisory) instead of only naming the maintainer, so reporters have a
  usable private intake.

### Fixed

- **A single document with unparseable frontmatter no longer breaks every
  query.** `search_documents` / `list_projects` / `fetch_document` /
  `trace_sources` walk and parse every note, so one file with malformed YAML/JSON
  frontmatter (a bare-dash value, or raw control characters that leak in from a
  web clipping) made gray-matter throw and abort the whole operation
  non-deterministically. The read path now parses frontmatter fault-tolerantly
  (`parseMarkdownSafe`): a note that fails to parse is indexed by its body/path
  with empty metadata and a one-line, content-free stderr note, instead of
  poisoning the batch. Path-containment / symlink guards are unchanged
  (`src/frontmatter.ts`, `src/knowledgeStore.ts`, `tests/knowledgeStore.test.ts`).
- **session-archive hook no longer writes invalid YAML frontmatter for a
  detached HEAD.** `archive-session.sh` emitted `branch: -` (bare dash) when
  `git branch --show-current` was empty, which is malformed YAML — this was the
  source of the notes that broke search above. The `branch` value is now quoted
  and escaped like `title` (`branch: "-"`), so freshly archived sessions parse
  cleanly (kept byte-identical with the canonical copy).
- **session-archive masking no longer eats the closing quote of a frontmatter
  value.** The block `mask` ran over the assembled note, so a quoted `title` or
  `branch` whose value contained a `key=…` / `token=…` substring (both are valid)
  had its closing `"` consumed by the mask value pattern, producing malformed
  YAML. The hook now masks every free-text / path-derived frontmatter value
  (`title` / `branch` / `project` / `repos` / `tags`) per-field before quoting
  and masks the body separately, so secrets stay masked (including a checkout
  basename shaped like `token=…`) and the quotes stay intact. Verified for `-`,
  normal names, and `token=…` values (kept byte-identical with the canonical
  copy).

### Security

- **Cleared all `pnpm audit` advisories.** A pnpm `overrides` entry pins the
  transitive `hono` (via `@modelcontextprotocol/sdk` → `@hono/node-server`) to
  `>=4.12.25`, resolving 6 advisories (1 high — CORS middleware reflecting any
  origin with credentials under a wildcard default — plus 5 moderate). The
  refreshed lockfile also moves `gray-matter`'s transitive `js-yaml` to `3.15.0`
  (within its existing range), clearing a moderate merge-key quadratic-DoS
  advisory without the gray-matter-breaking jump to `js-yaml` 4.x. `pnpm audit`
  is now clean and the 86 tests still pass.

## [0.2.0] — 2026-07-05

Second release. The headline change is **multi-root knowledge access**; the rest
is developer-facing hook tooling (session archiving, command-learning logs),
documentation, and dependency/CI maintenance. No breaking changes — a single
`KNOWLEDGE_ROOT` setup behaves exactly as in `0.1.0`.

### Added

- **Multiple knowledge roots** (`KNOWLEDGE_ROOTS="name=/path,…"`): search,
  fetch, list, and trace across several repos at once. The first root is the
  primary (writable); every additional root is strictly read-only and its
  documents are addressed as `name:relative/path` (results carry a `root`
  field). Single `KNOWLEDGE_ROOT` behavior is unchanged. Each root keeps the
  full path-containment guard chain; overlapping roots are rejected at startup
  (`src/multiRootStore.ts`, `tests/multiRootStore.test.ts`).
- **session-archive hook** (`.claude/skills/session-archive/`): Stop/SessionEnd
  hook that renders the full Claude Code session transcript (title +
  conversation + tool calls/results, secrets masked with the ops-logging rules)
  into one Markdown note per session inside the private vault clone and pushes
  it, making session history searchable through this MCP server. The vault is
  located indirectly (`SESSION_VAULT_REPO` env or a `.claude-session-vault`
  marker); no private repo name or path is committed here. No-op without a
  vault clone. Adds a **PreCompact snapshot mode**: before auto-compact prunes
  a transcript, a full-detail snapshot is written under
  `_logs/ClaudeCode-Web/_precompact/` so pre-compact content is never lost.
- **ops-logging skill + hooks** (`.claude/skills/ops-logging/`): PostToolUse/Stop
  hooks that append a "command + intent" learning log (all secrets masked;
  `Bearer <token>` masked as a unit; GitHub MCP calls recorded via a
  metadata-only allowlist) and push it once per session to a separate private
  `terminal-ops-logs` repo. No-op unless `OPS_LOG_REPO` points at a clone.
- **MIT `LICENSE`** file and a `license` field in `package.json`.
- **Manual release workflow** (`.github/workflows/release.yml`):
  `workflow_dispatch` → `gh release create`, refusing to overwrite a
  pre-existing tag.
- **Documentation**: operations guide (`docs/operations.md`, incl. Cloudflare
  account/domain requirements, systemd full-hardening drop-in, and a bwrap
  sandbox recipe for the stdio server), `docs/ROADMAP.md`, a STRIDE
  `docs/threat-model.md`, bilingual PR/FAQ (`docs/PRFAQ.md`, `docs/PRFAQ.en.md`),
  and README polish (architecture Mermaid diagram, status badges, use-cases).

### Changed

- `KnowledgeStore` is now composed behind a multi-root layer; `search`,
  `chatgpt` aliases, `config`, and result `types` were adapted to carry an
  optional `root` and to resolve `name:relative/path` addresses.
- Dependency maintenance (dev toolchain): `@types/node` → `^26`, `eslint`
  → `^10.6`, `oxlint` → `^1.71`, `prettier` → `^3.9`, `typescript-eslint`
  → `^8.62`, `vite` → `^8.1`, `vitest` → `^4.1.9`, plus a `github-actions`
  group bump. `CLAUDE.global.md` re-synced byte-identical with the canonical
  global layer.

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

[Unreleased]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/theosera/claude_openai_mcp_connector/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/theosera/claude_openai_mcp_connector/releases/tag/v0.1.0
