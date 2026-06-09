# Operations — running the connector reliably

This guide is for keeping the **HTTP (web) connector** up so that ChatGPT /
Claude.ai stay connected. Local stdio clients (Claude Code / Codex / Claude
Desktop) launch the process themselves and have nothing to keep alive — if you
only use those, you can skip this document.

> TL;DR — two things cause "the connection dropped":
> 1. **The tunnel URL changes.** A Cloudflare *quick* tunnel
>    (`trycloudflare.com`) gets a new random hostname every restart, and that
>    hostname is the OAuth issuer + token audience, so a change breaks the
>    registered connector. → Use a **named tunnel with a fixed domain**.
> 2. **OAuth state is in memory.** Tokens and dynamically-registered clients
>    live in process memory and are dropped on restart, forcing a re-auth. →
>    **Keep the process alive** under a supervisor (systemd/launchd) with
>    auto-restart.

---

## 1. Why connections drop (and the fix)

### A. Ephemeral tunnel URL — the biggest pitfall

`cloudflared tunnel --url http://127.0.0.1:8787` opens a **quick tunnel** whose
`https://<random>.trycloudflare.com` hostname is **regenerated on every
restart**. That URL is used as:

- the OAuth **issuer** (`MCP_HTTP_PUBLIC_URL`), and
- the token **audience** (RFC 8707 binding), and
- the DNS-rebinding allowlist host.

So when it changes, every issued token and the client's saved server URL become
invalid at once — the connector simply stops working.

**Fix: use a named tunnel bound to a domain you control.** The hostname then
never changes:

```bash
cloudflared tunnel login
cloudflared tunnel create vault
cloudflared tunnel route dns vault vault.example.com   # your domain
cloudflared tunnel run vault                            # always https://vault.example.com
```

### B. In-memory OAuth state — restart means re-auth

By design (`src/oauth/store.ts`) the OAuth **codes, access tokens, refresh
tokens, and dynamically-registered clients are ephemeral process state** and are
**not persisted**. This is an intentional single-user simplification, but it
means:

- Restarting the server **invalidates all tokens**; web clients must run the
  OAuth flow again (re-enter `MCP_OAUTH_PASSWORD`).
- Access-token TTL defaults to 1h and refresh to 30d (`MCP_OAUTH_ACCESS_TTL` /
  `MCP_OAUTH_REFRESH_TTL`), but the refresh token is also in memory, so a
  restart drops it too.

**Fix: don't let the process die.** Run it supervised with auto-restart (below).
A restart costs only a re-auth (the connector URL stays the same, so **no
re-registration** is needed). Persisting tokens across restarts is a roadmap
item — see [`ROADMAP.md`](./ROADMAP.md).

---

## 2. Stable web deployment

Run **both** the connector and the tunnel as supervised, always-on services on a
host that does not sleep (a small VPS, a home server, or a Raspberry Pi — not a
laptop that suspends).

### systemd (Linux)

```ini
# /etc/systemd/system/vault-mcp.service
[Unit]
Description=Private Vault MCP Connector (HTTP + OAuth)
After=network-online.target
Wants=network-online.target

[Service]
# --- transport / endpoint ---
Environment=MCP_TRANSPORT=http
Environment=MCP_HTTP_PORT=8787
Environment=MCP_HTTP_PUBLIC_URL=https://vault.example.com
# --- OAuth (for ChatGPT / Claude.ai web) ---
Environment=MCP_OAUTH_ENABLED=1
Environment=MCP_OAUTH_PASSWORD=replace-with-a-strong-passphrase
# --- static bearer (for Claude Desktop / Code remote / API) ---
Environment=MCP_AUTH_TOKEN=replace-with-openssl-rand-hex-32
# --- vault ---
Environment=KNOWLEDGE_ROOT=/abs/path/to/vault
# Two-step write patch state. Only used when writes are enabled, but set it
# explicitly to an ABSOLUTE path: the default (.mcp-state/patches) resolves
# relative to the process cwd (src/config.ts), which under ProtectSystem=strict
# may not be covered by ReadWritePaths — causing plan_document_update to fail.
Environment=MCP_PATCH_STATE_DIR=/abs/path/to/state/patches
# Writes stay OFF unless you explicitly need them:
# Environment=MCP_HTTP_ALLOW_WRITE=1
# Pin the cwd so any relative default also resolves predictably:
WorkingDirectory=/abs/path/to/claude_openai_mcp_connector
ExecStart=/usr/bin/node /abs/path/to/claude_openai_mcp_connector/dist/index.js
Restart=always
RestartSec=2
# Hardening (optional but recommended):
NoNewPrivileges=true
ProtectSystem=strict
# Grant write access to the vault and the patch-state parent (must cover
# MCP_PATCH_STATE_DIR above):
ReadWritePaths=/abs/path/to/vault /abs/path/to/state

[Install]
WantedBy=multi-user.target
```

Prefer storing secrets in `EnvironmentFile=/etc/vault-mcp.env` (mode `600`)
instead of inline `Environment=` lines, so they don't appear in
`systemctl show`.

Install the tunnel as a service too:

```bash
sudo cloudflared service install   # runs `cloudflared tunnel run` on boot
sudo systemctl enable --now vault-mcp cloudflared
```

### launchd (macOS)

Use a `LaunchAgent` plist with `KeepAlive=true` and the same environment
variables in `EnvironmentVariables`. Note macOS sleep will still pause it — a
dedicated always-on host is better for a connector you depend on.

---

## 3. Pre-flight checks (before registering a web client)

```bash
# 1. Protected-resource metadata is served (JSON)
curl https://vault.example.com/.well-known/oauth-protected-resource

# 2. Unauthenticated POST is rejected with the OAuth challenge
curl -i -X POST https://vault.example.com/mcp
#    expect: HTTP/1.1 401 ... WWW-Authenticate: Bearer resource_metadata="…"
```

The `401` + `WWW-Authenticate` header is what makes ChatGPT / Claude.ai start
the OAuth flow. The URL to register in the client is
`https://vault.example.com/mcp`.

---

## 4. Recovery checklist (if it ever drops)

1. **Process up?** `systemctl status vault-mcp cloudflared`
2. **Reachable?** run the two `curl` checks above.
3. **Re-connect** in the web client → OAuth screen → re-enter
   `MCP_OAUTH_PASSWORD`. The connector URL is unchanged, so you re-authenticate
   only — no need to re-add the connector.
4. **Logs:** `journalctl -u vault-mcp -n 100` (connector),
   `journalctl -u cloudflared -n 100` (tunnel).

---

## 5. Operational security checklist

- [ ] `MCP_HTTP_ALLOW_WRITE` is **unset** (read-only) unless you have a specific,
      audited need. Writes also require a `vault.write`-scoped token.
- [ ] `MCP_OAUTH_PASSWORD` is a strong, unique passphrase; secrets are in an
      `EnvironmentFile` (mode `600`), not committed anywhere.
- [ ] `MCP_AUTH_TOKEN` is a 32-byte random value (`openssl rand -hex 32`).
- [ ] The server binds to `127.0.0.1` (default) and is reached **only** through
      the HTTPS tunnel — never bind it directly to a public interface.
- [ ] `KNOWLEDGE_ROOT` points at the vault and nothing wider; the vault is not
      committed to the public repo.
- [ ] You can recover via the checklist above (re-auth is enough; URL is stable).
