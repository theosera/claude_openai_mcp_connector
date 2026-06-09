# PR/FAQ — claude_openai_mcp_connector

> An Amazon "Working Backwards"-style internal PR/FAQ: describe the product from
> the customer's point of view, then pin down the hard parts in the FAQ. This is
> a living planning/decision document, not public marketing copy.
>
> 日本語版: [`PRFAQ.md`](./PRFAQ.md)

---

## Press Release

### Title
**Use your private Obsidian / Markdown knowledge from multiple AI clients —
safely — with claude_openai_mcp_connector v0.1.0**

### Subtitle
Stop re-pasting the same context into each AI. An MCP gateway that connects your
personal knowledge to AI agents without exposing your private vault — read-only
by default, with OAuth scopes, audience binding, and path-traversal defenses.

### Body

Today we are releasing **claude_openai_mcp_connector v0.1.0**. It lets you search
and reference the personal knowledge you've built up in Obsidian or a Markdown
vault from multiple AI clients — **Claude Code, Claude Desktop, ChatGPT, and
Codex** — safely.

Until now, users had to re-paste the same context into every AI. This product is
an **MCP gateway** that keeps your private vault unpublished while providing
**read-only-by-default access, OAuth scopes, audience binding, and
path-traversal protection**, securely connecting personal knowledge to AI
agents.

- **Who it's for** — individuals, researchers, and small teams who grow their
  knowledge in Obsidian / Markdown and don't want to hand their whole dataset to
  the cloud.
- **What problem it solves** — the repeated, quickly-stale copy-pasting of
  context across AIs, and the fear of "uploading everything." It passes your
  vault **only when needed, only as much as needed**.
- **How to use it** — clone the repo, point `KNOWLEDGE_ROOT` at your vault, and
  start it. Local clients connect over stdio; web clients connect over OAuth +
  HTTPS.
- **Why it's safe** — read-only by default; edits go through two-step approval
  with stale protection; every access is contained under `KNOWLEDGE_ROOT`; the
  web path uses OAuth 2.1 (PKCE, audience/scope binding).
- **What's different** — with "code is public, notes are private" as the core
  design, it specializes in Markdown knowledge and keeps strict security
  defaults. It is neither a full upload into a SaaS nor a generic file share, but
  the middle path.

### Customer comment
"I can search my thousands of Obsidian notes from both ChatGPT and Claude, yet
the vault never leaves my machine. Writes need two-step approval, so I don't
worry about the AI clobbering a note. Best of all, switching AIs no longer means
re-pasting everything." — an independent researcher

---

## FAQ

### Customer FAQ

**Q. What is this?**
An MCP server that lets AI clients search and reference (and optionally edit)
your personal Obsidian / Markdown knowledge base. It bridges the vault to AIs
while keeping it unpublished and on your machine.

**Q. Who is it for?**
Individuals, researchers, and small teams who accumulate knowledge in Markdown
and have held back from AI integration over privacy concerns.

**Q. What's convenient about it?**
You no longer re-paste the same background into each AI. From Claude Code, Claude
Desktop, ChatGPT, or Codex, you reference the same vault the same way.

**Q. How is it different from existing tools?**
(1) Unlike approaches that ingest your notes wholesale into a SaaS, **your data
stays local**. (2) Unlike generic file sharing, it is **specialized for Markdown
knowledge** (frontmatter, projects, source refs, backlinks) and has **strict
security defaults** (read-only by default, two-step writes, path containment,
OAuth audience/scope binding).

**Q. Will my notes be used to train the AI vendors' models?**
The connector never uploads or continuously syncs your vault. It passes **only
what a search matches**, and it is read-only by default. Whether the receiving
AI (ChatGPT / Claude) uses that for training depends on each vendor's policy, so
pair sensitive notes with each AI's data settings (e.g. training opt-out). What
this product guarantees is that the vault is **never placed in the cloud
wholesale**.

**Q. Does it cost anything?**
The connector itself is open source (public repo) and free. The only costs are
each AI's own usage fees and, for the web path, an optional custom
domain/hosting. Local use adds essentially no cost.

**Q. Is it open source? Can I audit it?**
Yes. The code is a public repo anyone can read, while **your vault stays
private** (excluded via `.gitignore`; tests use synthetic data only). "Code is
public, notes are private" is the core design.

### Technical FAQ

**Q. How do I connect?**
It speaks two transports. Local CLI/desktop clients (Claude Code, Codex, Claude
Desktop) connect directly over **stdio**. ChatGPT and Claude.ai web connect to
the **HTTP endpoint (`/mcp`) over HTTPS**.

**Q. How does authentication work?**
HTTP requires authentication (fail-closed). Claude Desktop / Claude Code
(remote) / Claude API use a **static bearer** (`MCP_AUTH_TOKEN`). ChatGPT and
Claude.ai web do not accept static bearers, so they use the built-in **OAuth 2.1
authorization server** (PKCE S256, single-use short-lived codes, scrypt login
gate, RFC 8707 **audience binding**, and `vault.read` / `vault.write` **scope
gating**).

**Q. Can it write?**
Yes, but it is **read-only by default**. Edits go through `plan_document_update`
→ (your approval) → `apply_planned_update` in two steps; a hash mismatch rejects
the apply (stale protection); creates never overwrite. Writes over the web path
are enabled only when **both** `MCP_HTTP_ALLOW_WRITE=1` **and** a `vault.write`
scope are present.

**Q. Where is data stored?**
Notes exist **only under `KNOWLEDGE_ROOT` on your machine**, and the connector
just references them. The vault's contents, paths, and bodies are never committed
to the repo. OAuth tokens and registered clients are **ephemeral in-process
state** and are not persisted (a restart requires re-authentication).

**Q. What do I need to run it?**
Just Node.js 22.12+ and `pnpm` (for the build). Local use takes a few minutes. The
README offers a 3-tier path by skill level: 🟢 local + Claude Desktop → 🟡 CLI
(Claude Code / Codex) → 🔴 web (OAuth). A build-free one-command install is on the
[roadmap](./ROADMAP.md).

**Q. What happens if the connection drops?**
Local (stdio) has nothing to drop. On the web path the two drop causes are
(1) the quick-tunnel URL changing on restart and (2) in-memory OAuth state
expiring on restart. The fix is a **fixed-domain named tunnel + a supervised
process (e.g. systemd)**; details and a recovery checklist are in
[`operations.md`](./operations.md). With a stable URL, recovery is just
re-entering the password — no re-registration.

### Internal / development FAQ

**Q. What is out of scope for v0.1.0?**
Multi-user / team sharing (single-user by design), persistence of OAuth state
(re-auth on restart), data sources other than the vault, and continuous full
sync / index distribution.

**Q. What comes next?**
Operational-stability docs (fixed-domain tunnel + supervised process), token
persistence (keep connections across restarts), search-experience improvements,
and multi-user support if validated. See [`ROADMAP.md`](./ROADMAP.md), including
the honest **security & enterprise maturity gaps** (third-party pen test, audit
log, RBAC, OpenTelemetry, DLP, sandbox isolation, formal STRIDE threat model).

**Q. What are the success metrics?**
Establishing the state of "referencing my vault daily from multiple AIs without
ever uploading it to the cloud." Time-to-adoption (minutes locally / under ~10
min for web), the disappearance of cross-AI re-pasting, and **zero write
accidents** (two-step + stale protection working).

**Q. What are the failure conditions?**
Anything that breaks trust — access outside the vault, unintended
overwrite/destruction, auth bypass, or leakage of private data. These are lines
that must not be crossed; security behaviors are pinned by tests (path
traversal, symlink escape, frontmatter allowlist, stale patch, overwrite
collision) to prevent regressions. Setup friction that keeps adoption from
fitting in a few minutes is also a failure condition for reach.
