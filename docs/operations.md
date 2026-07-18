# Operations — running the connector reliably

This guide is for keeping the **HTTP (web) connector** up so that ChatGPT /
Claude.ai stay connected. Local stdio clients (Claude Code / Codex / Claude
Desktop) launch the process themselves and have nothing to keep alive — if you
only use those, you can skip this document, with one exception:
[§6](#6-sandboxing-the-local-stdio-server-bwrap-optional) is an optional
sandbox recipe for that locally-spawned stdio server.

> TL;DR — two things cause "the connection dropped":
>
> 1. **The tunnel URL changes.** A Cloudflare _quick_ tunnel
>    (`trycloudflare.com`) gets a new random hostname every restart, and that
>    hostname is the OAuth issuer + token audience, so a change breaks the
>    registered connector. → Use a **named tunnel with a fixed domain**.
> 2. **OAuth state is in memory by default.** Tokens and dynamically-registered
>    clients live in process memory and are dropped on restart, forcing a
>    re-auth. → **Persist sessions** with `MCP_OAUTH_STATE_FILE` and/or **keep
>    the process alive** under a supervisor (systemd/launchd) with auto-restart
>    (§1.B).

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

> **Prerequisites for a named tunnel:** unlike the quick tunnel (which needs no
> account), `cloudflared tunnel login` / `route dns` require a **Cloudflare
> account** (the free plan is enough) **and a domain managed in Cloudflare**.
>
> **Cloudflare is not mandatory** — the only real requirement is a **stable
> HTTPS URL that reaches `127.0.0.1:<port>`**. Equivalent options:
>
> - **Tailscale Funnel** — account required, but no domain to buy (you get a
>   stable `*.ts.net` URL). See
>   [§2 · macOS: Tailscale Funnel + launchd](#macos-tailscale-funnel--launchd)
>   for the concrete `tailscale funnel` + launchd runbook.
> - **ngrok** — a stable domain on a paid plan.
> - **Your own server + reverse proxy** (nginx / Caddy + Let's Encrypt) with a
>   domain you already own — no Cloudflare needed.
> - Staying on the **quick tunnel** works without any account, but the URL
>   changes on restart (you must update `MCP_HTTP_PUBLIC_URL` and re-auth each
>   time), so it is not recommended for regular use.
>
> Whichever you pick, set `MCP_HTTP_PUBLIC_URL` to that stable URL and register
> `<stable-url>/mcp` in the client.

### B. OAuth state — in-memory by default, persistable via a state file

By default (`src/oauth/store.ts`) the OAuth **access tokens, refresh tokens,
and dynamically-registered clients are ephemeral process state**, which means:

- Restarting the server **invalidates all tokens**; web clients must run the
  OAuth flow again (re-enter `MCP_OAUTH_PASSWORD`).
- Access-token TTL defaults to 1h and refresh to 30d (`MCP_OAUTH_ACCESS_TTL` /
  `MCP_OAUTH_REFRESH_TTL`), but the refresh token is also in memory, so a
  restart drops it too.

**Fix 1: persist OAuth sessions.** Set
`MCP_OAUTH_STATE_FILE=/abs/path/to/oauth-state.json` and registered clients and
tokens survive restarts — ChatGPT and Claude.ai stay authorized (both share the
same store, so one file covers every web client). Security properties:

- Tokens are stored **as sha256 hashes** — the file never contains a
  recoverable credential (hash-at-rest, not just encryption).
- The file is written atomically with mode `0600` and carries an **HMAC keyed
  from `MCP_OAUTH_PASSWORD`** (scrypt-derived). A tampered, corrupted, or
  password-rotated state file fails **closed**: the server starts with empty
  OAuth state and clients simply re-authorize. Rotating the password is
  therefore also how you revoke all persisted sessions at once.
- Authorization codes are never persisted (they are 60s single-use), and
  refresh-token rotation invalidates the old token on disk immediately.

**Fix 2: don't let the process die.** Run it supervised with auto-restart
(below). Without the state file a restart costs a re-auth; with it, a restart
costs nothing (the connector URL stays the same either way, so **no
re-registration** is ever needed).

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
# Persist OAuth sessions across restarts (hashed tokens only; see §1.B):
# Environment=MCP_OAUTH_STATE_FILE=/abs/path/to/state/oauth-state.json
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
# To expose only constrained, create-only Skill writes instead:
# Environment=MCP_SKILLS_SUBDIR=path/to/skills
# Environment=MCP_HTTP_ALLOW_SKILL_WRITE=1
# Pin the cwd so any relative default also resolves predictably:
WorkingDirectory=/abs/path/to/claude_openai_mcp_connector
ExecStart=/usr/bin/node /abs/path/to/claude_openai_mcp_connector/dist/index.js
Restart=always
RestartSec=2
# Sandbox hardening lives in a separate drop-in so this base unit stays easy to
# read — see "Sandbox hardening (systemd)" below before you enable the service.

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

### Sandbox hardening (systemd)

This is **layer 1** of the "sandbox isolation" plan in
[`ROADMAP.md`](./ROADMAP.md#sandbox-isolation--intended-layering): limit the
blast radius **if the server process itself is compromised**. It is
defense-in-depth _on top of_ the app-level path containment (the server already
confines file access to `KNOWLEDGE_ROOT`) — systemd's namespacing now also stops
a compromised process from touching the rest of the host.

Keep it as a **drop-in** so the base unit above stays readable. Create
`/etc/systemd/system/vault-mcp.service.d/hardening.conf`:

```ini
# /etc/systemd/system/vault-mcp.service.d/hardening.conf
[Service]
# No process started by this unit can ever gain new privileges (setuid/setgid
# binaries, file capabilities). Also a precondition for SystemCallFilter below.
NoNewPrivileges=true

# Hide /home, /root, /run/user entirely — keeps a compromised process away from
# ~/.ssh, ~/.aws, shell history, and any stray .env. See the caveat below if the
# vault or EnvironmentFile lives under a home directory.
ProtectHome=true

# Private /tmp and /var/tmp, unshared from the host and wiped on stop — no
# leaking temp files to or from other processes.
PrivateTmp=true

# Mount the entire filesystem (incl. /usr, /etc, /boot) read-only; only the
# paths in ReadWritePaths stay writable. The vault stays *readable* under this
# even with no RW grant.
ProtectSystem=strict
# Grant write access to ONLY what the connector must write:
#   - the two-step patch-state dir (MCP_PATCH_STATE_DIR), needed when writes are on;
#   - the vault itself ONLY if you enabled document or Skill writes.
# In the read-only default (no writes), you can drop this line entirely — the
# vault is still readable under ProtectSystem=strict.
ReadWritePaths=/abs/path/to/state/patches

# Drop ALL Linux capabilities. The connector binds 8787 (>1024), so it needs no
# CAP_NET_BIND_SERVICE or anything else. An empty bounding set means none can be
# acquired even if something tried.
CapabilityBoundingSet=

# Allow only the socket families the HTTP listener + local logging use. Blocks
# AF_NETLINK, AF_PACKET, etc. (raw sockets / kernel-interface families).
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Allowlist the "system-service" syscall set; deny the dangerous groups
# (@reboot, @swap, @mount, @debug, @module, @raw-io, …) with EPERM.
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
# Pin to the native ABI so the syscall filter can't be bypassed by issuing
# syscalls through a secondary (e.g. x86 on x86-64) ABI.
SystemCallArchitectures=native

# Forbid memory mappings that are writable AND executable at the same time
# (blocks classic inject-then-execute shellcode). ⚠️ See the Node/V8 caveat below
# — test that the service actually starts with this on.
MemoryDenyWriteExecute=true
```

Apply and verify:

```bash
sudo systemctl daemon-reload
sudo systemctl restart vault-mcp
systemctl status vault-mcp                 # confirm it actually started
systemd-analyze security vault-mcp.service # exposure score; lower is better
```

`systemd-analyze security` scores each directive and flags what is still open —
use it to confirm the drop-in took effect and to find easy further wins
(`ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`,
`RestrictNamespaces`, `LockPersonality`, `RestrictSUIDSGID` are all cheap adds
for this daemon).

**Caveats — read before enabling:**

- **`ProtectHome=true` vs a vault under `/home`.** If `KNOWLEDGE_ROOT`, the
  patch-state dir, or your `EnvironmentFile` lives under a home directory,
  `ProtectHome` makes them invisible and the service fails to read the vault.
  Prefer moving the vault and state **out of `/home`** (e.g. `/srv/vault`,
  `/var/lib/vault-mcp/state`) for a daemon. If you must keep them under `/home`,
  re-expose just those paths with `BindReadOnlyPaths=`/`BindPaths=`, or relax to
  `ProtectHome=tmpfs`.
- **`MemoryDenyWriteExecute=true` vs Node/V8 JIT.** V8's JIT has historically
  needed W+X pages, and MDWE can make Node crash on start on some versions. Test
  it: if `systemctl status` shows the process dying immediately, either drop this
  one line, or run Node with `--jitless` (no JIT — a performance cost, but it
  keeps MDWE on). Everything else in this drop-in is safe for Node as-is.
- **stdio is a different shape.** The stdio transport has **no network listener**
  and is spawned by the local client (Claude Code / Codex / Claude Desktop), so
  this unit is HTTP-specific. If you ever wrap a stdio invocation in its own unit,
  add **`PrivateNetwork=true`** (it needs zero network) and you can narrow
  `RestrictAddressFamilies=` to just `AF_UNIX`. For the more common case — the
  client spawning the stdio server directly — use the **bwrap recipe in
  [§6](#6-sandboxing-the-local-stdio-server-bwrap-optional)** instead.

### macOS: Tailscale Funnel + launchd

A laptop is **not** the ideal host — macOS sleep pauses the process (see the
caveats) — but this is a working, no-domain-required setup: **Tailscale Funnel**
provides a stable `*.ts.net` HTTPS URL, and a **launchd** LaunchAgent keeps
`node` alive with auto-restart.

**1. Stable URL via Tailscale Funnel.** With Tailscale installed and signed in,
expose the local port. The `*.ts.net` hostname is stable across restarts, so it
works as the OAuth issuer/audience (unlike a Cloudflare quick tunnel):

```bash
tailscale funnel --bg 8787   # serves https://<machine>.<tailnet>.ts.net → 127.0.0.1:8787
tailscale funnel status      # confirm the mapping is up
```

`--bg` runs it in the background and persists across reboots. Set
`MCP_HTTP_PUBLIC_URL=https://<machine>.<tailnet>.ts.net` and register
`https://<machine>.<tailnet>.ts.net/mcp` in the client.

**2. Keep `node` alive via a LaunchAgent.** Create
`~/Library/LaunchAgents/<label>.plist` (e.g. `local.mcp-connector`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.mcp-connector</string>
  <key>ProgramArguments</key>
  <array>
    <string>/abs/path/to/node</string>
    <string>/abs/path/to/claude_openai_mcp_connector/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MCP_TRANSPORT</key><string>http</string>
    <key>MCP_HTTP_PORT</key><string>8787</string>
    <key>MCP_HTTP_PUBLIC_URL</key><string>https://<machine>.<tailnet>.ts.net</string>
    <key>MCP_OAUTH_ENABLED</key><string>1</string>
    <key>MCP_OAUTH_STATE_FILE</key><string>/abs/path/to/state/oauth-state.json</string>
    <key>KNOWLEDGE_ROOT</key><string>/abs/path/to/vault</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/abs/path/to/logs/mcp-connector.out.log</string>
  <key>StandardErrorPath</key><string>/abs/path/to/logs/mcp-connector.err.log</string>
</dict>
</plist>
```

Load and start it:

```bash
launchctl load -w ~/Library/LaunchAgents/local.mcp-connector.plist
```

> **Secrets:** don't inline `MCP_OAUTH_PASSWORD` / `MCP_AUTH_TOKEN` in the plist
> (it is readable and shows up in `launchctl print`). Keep them in a mode-`600`
> file and source it from a tiny wrapper script that the plist runs instead of
> `node` directly — the launchd analogue of the systemd `EnvironmentFile` advice
> above.

> **Use a STABLE `node` path.** Version-manager shims are often **per-shell** and
> disappear after a reboot, which breaks `KeepAlive` (launchd can no longer find
> `node`). Resolve the real binary once and hardcode _that_ absolute path:
>
> ```bash
> node -e 'console.log(require("fs").realpathSync(process.execPath))'
> ```
>
> For `fnm` this is the versioned install path
> (`…/node-versions/vX.Y.Z/installation/bin/node`), **not** a transient
> per-shell multishell path.

**Caveats.**

- **macOS sleep pauses the process.** When the Mac sleeps, `node` is suspended
  and in-memory OAuth tokens effectively drop, so the connector goes quiet until
  wake + re-auth. A dedicated always-on host is better; `caffeinate` (e.g.
  running the connector under `caffeinate -s`) mitigates it while on power.
- **Restart = re-Authorize, not re-register.** Because the `*.ts.net` URL is
  fixed, after a restart you only press **Authorize** in the client to mint fresh
  tokens — no need to delete and re-add the connector. To skip even that
  re-Authorize, set `MCP_OAUTH_STATE_FILE` so sessions persist across restarts
  (§1.B).

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
- [ ] `MCP_HTTP_ALLOW_SKILL_WRITE` is unset unless constrained Skill creation is
      needed; when enabled, `MCP_SKILLS_SUBDIR` is the narrow intended directory
      and general `MCP_HTTP_ALLOW_WRITE` remains unset unless separately needed.
- [ ] `MCP_OAUTH_PASSWORD` is a strong, unique passphrase; secrets are in an
      `EnvironmentFile` (mode `600`), not committed anywhere.
- [ ] `MCP_AUTH_TOKEN` is a 32-byte random value (`openssl rand -hex 32`).
- [ ] The server binds to `127.0.0.1` (default) and is reached **only** through
      the HTTPS tunnel — never bind it directly to a public interface.
- [ ] `KNOWLEDGE_ROOT` points at the vault and nothing wider; the vault is not
      committed to the public repo.
- [ ] You can recover via the checklist above (re-auth is enough; URL is stable).

---

## 6. Sandboxing the local stdio server (bwrap, optional)

This is **layer 3** of the "sandbox isolation" plan in
[`ROADMAP.md`](./ROADMAP.md#sandbox-isolation--intended-layering) — the stdio
counterpart of the [systemd hardening](#sandbox-hardening-systemd) above. Same
goal: limit blast radius **if the server process is compromised**, as
defense-in-depth on top of the app-level path containment.

The stdio transport is the shape `bwrap` (bubblewrap) is best at: the MCP
client (Claude Code / Codex / Claude Desktop) spawns `node dist/index.js` per
session, and bwrap wraps exactly that one process. The sandbox filesystem is
built **only from explicit binds**, so everything you don't list — `~/.ssh`,
`~/.aws`, the rest of `/home`, stray `.env` files — simply does not exist
inside, and `--unshare-all` removes the network entirely (stdio needs none).

Create a wrapper script, e.g. `/usr/local/bin/vault-mcp-sandboxed`:

```bash
#!/usr/bin/env bash
# Sandbox the stdio MCP server with bubblewrap. Point your MCP client's
# "command" at this script instead of node.
set -euo pipefail

APP=/abs/path/to/claude_openai_mcp_connector
VAULT=/abs/path/to/vault

exec bwrap \
  `# Minimal OS image: read-only /usr + merged-usr symlinks, fresh /proc,` \
  `# /dev, /tmp. NOTHING else from the host exists inside the sandbox.` \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin \
  --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  `# The app (read-only) and the vault. Read-only deployment = read-only` \
  `# vault bind; for writes switch the vault to --bind and add a writable` \
  `# state dir: --bind "$VAULT" /vault --bind /abs/path/to/state /state` \
  --ro-bind "$APP" /app \
  --ro-bind "$VAULT" /vault \
  `# Deterministic cwd: the client may spawn this from ~ or the checkout,` \
  `# neither of which exists inside. Without --chdir, bwrap falls back to /` \
  `# (read-only), where any relative default — e.g. MCP_PATCH_STATE_DIR's` \
  `# .mcp-state/patches — would fail to write. /tmp is the writable tmpfs.` \
  --chdir /tmp \
  `# Unshare every namespace, including network — stdio talks over pipes.` \
  --unshare-all \
  `# Kill the sandbox when the client (parent) exits; detach from the` \
  `# terminal so a compromised child cannot inject keystrokes (TIOCSTI).` \
  --die-with-parent \
  --new-session \
  `# Start from an EMPTY environment; pass only what the server reads —` \
  `# no inherited API keys, tokens, or proxy settings leak in.` \
  --clearenv \
  --setenv KNOWLEDGE_ROOT /vault \
  `# --setenv MCP_PATCH_STATE_DIR /state/patches  # only when writes are on` \
  /usr/bin/node /app/dist/index.js
```

Then point the client at the wrapper — for example in an MCP server config:

```jsonc
{ "mcpServers": { "vault": { "command": "/usr/local/bin/vault-mcp-sandboxed" } } }
```

Quick verification that the walls are real: temporarily replace the last line
of the script (`/usr/bin/node /app/dist/index.js`) with `/bin/sh` and look
around from inside:

```
ls /        # → only app, vault, usr, bin, lib(64), proc, dev, tmp
ls /home    # → No such file or directory — host home isn't hidden, it does not exist
ls ~/.ssh   # → same: nothing to steal
```

**Caveats — read before relying on it:**

- **Unprivileged user namespaces are restricted on Ubuntu 23.10+/24.04** via
  AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`). Install bwrap
  from the distro package (`apt install bubblewrap`) — it ships the AppArmor
  profile that permits this. If a self-built or copied `bwrap` binary fails
  with `Creating new namespace failed: Permission denied`, add an AppArmor
  profile for it; do **not** flip the sysctl off system-wide, as that weakens
  every other confinement on the host.
- **Node may want a few more read-only files.** If startup complains, the
  usual additions are `--ro-bind /etc/ld.so.cache /etc/ld.so.cache` (faster
  library loading) and, only if you see TLS/locale errors, selective
  `--ro-bind`s under `/etc`. Bind individual files, not all of `/etc` (it can
  contain host keys and credentials).
- **Daemons are better served by systemd.** For the long-running HTTP
  connector you would have to keep the network (drop `--unshare-net`) and add
  writable state — at which point the
  [systemd drop-in](#sandbox-hardening-systemd) gives equivalent isolation
  with better supervision and no userns caveats. Use bwrap for the
  client-spawned stdio case; use systemd for the daemon.

---

## 7. Creating a document at an exact vault path

Use this flow when the note must land in an existing vault folder. The legacy
`create_document` tool deliberately maps `client`, `project`, and `title` into
`projects/<client>/<project>/<slug>.md`; it does not preserve an arbitrary path.

The exact-path tools share the normal document-write boundary. For HTTP, enable
`MCP_HTTP_ALLOW_WRITE=1`, restart the service, and authorize a `vault.write`
scope. No additional flag is required.

### Plan without touching the target

Call `plan_document_create` with a vault-relative `.md` path:

```json
{
  "relative_path": "notes/reports/e2e-result.md",
  "title": "E2E result",
  "body": "# E2E result\n\nSynthetic body.",
  "tags": ["e2e"],
  "reason": "record the verified result"
}
```

The result contains a UUID `patch_id`, `target_path`, complete-file `diff`, and:

```json
{
  "confirmation": {
    "question": "保存先は「notes/reports/e2e-result.md」でよろしいですか？",
    "options": [{ "label": "はい", "value": "confirm" }],
    "allow_free_text": true
  }
}
```

Planning writes only the patch-state file. It does **not** create the target
note or missing target directories.

### Confirm the path, then apply

Before apply, the client must show the returned question. If it supports an
AskUserQuestion-style UI, show **はい** plus a free-text field. Interpret the
responses as follows:

- **はい** — call `apply_planned_document_create` with the returned
  `target_path` copied exactly into `confirmed_target_path`.
- **Free-text correction** — do not apply. Call `plan_document_create` again
  with the corrected path, show the new diff and question, and obtain a fresh
  confirmation.

```json
{
  "patch_id": "00000000-0000-4000-8000-000000000000",
  "confirmed_target_path": "notes/reports/e2e-result.md"
}
```

Apply fails closed if the confirmed path differs, the patch content was
changed, the path traverses or crosses a symlink, the target appeared after
planning, or the request addresses a non-primary root. On success it creates
parent directories safely, performs one exclusive `wx` write, removes the
consumed patch, and returns the created document for read-back verification.

## 8. Enabling and using constrained Skill creation

`plan_skill_create` → `apply_planned_skill_create` let a client author an
**instruction-only Skill bundle** into the vault **without** being granted
general document writes. The surface is deliberately narrow: create-only, a fixed
file allowlist, and an atomic publish that reuses the same path-containment guard
chain as every other file access.

### Prerequisite: a pre-existing Skills directory

Set `MCP_SKILLS_SUBDIR` to a **vault-relative path inside the primary knowledge
root that already exists** — the server does **not** create it, and it rejects
absolute paths, `..`, or anything resolving outside the root. If Skill writes are
enabled but `MCP_SKILLS_SUBDIR` is unset, the server **refuses to start**.

```bash
# relative to KNOWLEDGE_ROOT (the primary root); create the directory first
MCP_SKILLS_SUBDIR=path/to/skills
```

### Enabling the surface

- **stdio (local Claude Code / Codex / Claude Desktop):** the two Skill tools are
  available whenever `MCP_SKILLS_SUBDIR` is set — no HTTP flag involved.
- **HTTP (ChatGPT / Claude.ai web):** additionally set
  `MCP_HTTP_ALLOW_SKILL_WRITE=1`. This is **independent** of
  `MCP_HTTP_ALLOW_WRITE` (general document writes): a connector can be allowed to
  author Skills while document writes stay off. Over HTTP the tools are also
  **OAuth scope-gated** — the session registers only the write surface(s) that
  are actually enabled.

Keep it unset unless you need it (see the §5 checklist).

### The two-step flow

1. **Plan.** `plan_skill_create` stages the bundle and returns a `patch_id` plus
   the full file diff — **nothing is written yet**:

   ```jsonc
   {
     "skill_name": "my-skill",
     "skill_md": "---\nname: my-skill\n...\n---\n# instructions ...",
     "references": [{ "filename": "notes.md", "content": "..." }], // optional, ≤20, flat
     "openai_yaml": "...", // optional
     "reason": "why this skill is being created"
   }
   ```

   Only three kinds of file are accepted — `SKILL.md`, flat `references/*.md`, and
   a single `agents/openai.yaml`. Scripts, binary assets, nested/arbitrary paths,
   and unknown `SKILL.md` frontmatter keys are rejected, and per-file / count /
   size caps are enforced.

2. **Review, then apply.** After you approve the diff,
   `apply_planned_skill_create { "patch_id": "<from step 1>" }` builds the
   complete bundle in a **same-filesystem temporary directory** and **atomically**
   renames it into `<MCP_SKILLS_SUBDIR>/<skill_name>/`. It is **create-only**: if
   that Skill directory already exists (or a symlink tries to escape), apply
   **fails closed** and nothing is published — existing Skills are never
   overwritten.

### Verifying a publish

The bundle lands at `<MCP_SKILLS_SUBDIR>/<skill_name>/SKILL.md` inside the vault.
Over HTTP you can confirm it through the read tools without shell access — e.g.
`search_documents` for the skill name, then `fetch_document` on the returned
`SKILL.md`. Because apply is atomic, a partially-written bundle is never visible.

## 9. Two-endpoint deployment: interactive + unattended audit scan

The constrained **audit write surface** (`append_audit_report` /
`compare_and_swap_audit_state`, scoped to `MCP_AUDIT_SUBDIR`) lets an *unattended*
vault scan persist its reports and state **without** holding the general
document-write tools. The security win is not the tool itself — it is running the
scan on a **separate endpoint that never registers the general write tools**, so a
scan steered by a malicious note has nothing to write with (a confused deputy with
no hands). Run **two** connector processes:

|                          | Interactive endpoint                          | Scan endpoint                                                       |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------------------ |
| Who connects             | you (ChatGPT / Claude.ai / Claude Code)       | the unattended scanner (e.g. a Cowork task)                        |
| General document write   | `MCP_HTTP_ALLOW_WRITE=1` (optional)           | **off** (unset)                                                    |
| Skill write              | `MCP_HTTP_ALLOW_SKILL_WRITE=1` (optional)     | **off** (unset)                                                    |
| Audit write              | off                                           | `MCP_HTTP_ALLOW_AUDIT_WRITE=1`                                      |
| Registered write tools   | create / plan / apply document (+ Skill)      | **only** `append_audit_report` / `compare_and_swap_audit_state`    |

> **INV-9 operating condition.** The audit-subtree reservation (general writes
> can't touch `MCP_AUDIT_SUBDIR`) only takes effect in a process that *sets*
> `MCP_AUDIT_SUBDIR`. Set the **same** `MCP_AUDIT_SUBDIR` on **both** endpoints —
> and on any local **stdio** server that can write the vault. On the interactive
> endpoint it just reserves the subtree (its general writes are excluded); on the
> scan endpoint it also enables the audit tools. A write-capable process that omits
> it can still edit audit files through a general write.

### Step 1 — create the audit subtree

`MCP_AUDIT_SUBDIR` is vault-relative, must already exist, must be **disjoint from
`projects/` and from `MCP_SKILLS_SUBDIR`** (both enforced at startup), and its
`reports/` must be a real directory (symlinks are rejected):

```bash
mkdir -p "$KNOWLEDGE_ROOT/90_Audit/vault-scan/reports"
```

### Step 2 — two env files (one per working directory)

The connector loads `.env` from its **working directory** (`dotenv`,
`src/config.ts`), so give each process **its own directory** with its own `.env`.
Keep the shared settings identical; differ only on the marked lines. **The OAuth
state file must NOT be shared between the two processes** — give each its own.

> ⚠️ **Do not run the scan process with the connector repo as its working
> directory.** `dotenv` does not override variables already in the environment,
> but it *does* fill in any that are unset — so from the connector repo it would
> load the interactive `.env` (with `MCP_HTTP_ALLOW_WRITE=1`) for every variable
> the scan config leaves unset, silently re-enabling general writes on the scan
> endpoint and defeating the whole separation. Run the scan process from a
> **different** directory whose `.env` *is* the scan config.

Interactive `.env` — in the connector repo (e.g. `…/claude_openai_mcp_connector/.env`):

```text
KNOWLEDGE_ROOT="/abs/path/to/vault"
MCP_TRANSPORT=http
MCP_WRITE_MODE=two_step
MCP_AUDIT_SUBDIR=90_Audit/vault-scan            # reserve the subtree (INV-9)
MCP_OAUTH_ENABLED=1
MCP_OAUTH_PASSWORD=<vault login password>
# --- differs per endpoint ---
MCP_HTTP_PORT=8787
MCP_HTTP_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
MCP_AUTH_TOKEN=<interactive bearer>
MCP_OAUTH_STATE_FILE=/abs/path/.mcp-state/oauth/oauth-state.json
MCP_PATCH_STATE_DIR=/abs/path/.mcp-state/patches
MCP_HTTP_ALLOW_WRITE=1                            # general writes ON (your call)
MCP_HTTP_ALLOW_SKILL_WRITE=1                      # optional
# MCP_HTTP_ALLOW_AUDIT_WRITE stays UNSET here
```

Scan `.env` — in its own directory, e.g. next to your scan scripts
(`…/_cowork/.env`):

```text
KNOWLEDGE_ROOT="/abs/path/to/vault"
MCP_TRANSPORT=http
MCP_WRITE_MODE=two_step
MCP_AUDIT_SUBDIR=90_Audit/vault-scan            # same subtree — enables audit tools here
MCP_OAUTH_ENABLED=1
MCP_OAUTH_PASSWORD=<same vault login password>   # same human, so may match
# --- differs per endpoint ---
MCP_HTTP_PORT=8788
MCP_HTTP_PUBLIC_URL=https://<machine>.<tailnet>.ts.net:8443
MCP_AUTH_TOKEN=<a DIFFERENT scan-only bearer>
MCP_OAUTH_STATE_FILE=/abs/path/.mcp-state/oauth/oauth-state-scan.json   # NOT shared
MCP_PATCH_STATE_DIR=/abs/path/.mcp-state/patches # absolute, so no stray .mcp-state in the scan cwd
MCP_HTTP_ALLOW_AUDIT_WRITE=1                      # audit tools ONLY
# MCP_HTTP_ALLOW_WRITE and MCP_HTTP_ALLOW_SKILL_WRITE stay UNSET
```

Different `MCP_HTTP_PUBLIC_URL` values give the two endpoints **different OAuth
audiences** (a token minted for one is rejected on the other, RFC 8707), and the
different bearer means a scan token can't be replayed against the interactive
endpoint.

### Step 3 — two Tailscale Funnels

Funnel exposes the machine's `*.ts.net` hostname on one of three ports — `443`,
`8443`, `10000` — each mapped to a local port. Use two of them:

```bash
tailscale funnel --bg --https=443  8787   # interactive → https://<machine>.<tailnet>.ts.net
tailscale funnel --bg --https=8443 8788   # scan        → https://<machine>.<tailnet>.ts.net:8443
tailscale funnel status
```

### Step 4 — two launchd agents

Run two LaunchAgents (two labels, e.g. `com.you.mcp-connector` and
`com.you.mcp-connector-scan`). The key is **`WorkingDirectory`**: it selects which
`.env` each process loads, keeping secrets in the mode-`600` `.env` files instead
of the plist (where `launchctl print` would expose them). The scan agent runs the
**same** `dist/index.js` but from the scan directory:

```xml
<!-- scan agent: ~/Library/LaunchAgents/com.you.mcp-connector-scan.plist -->
<key>ProgramArguments</key>
<array>
  <string>/abs/path/to/node</string>
  <string>/abs/path/to/claude_openai_mcp_connector/dist/index.js</string>
</array>
<key>WorkingDirectory</key><string>/abs/path/to/scan-dir</string>   <!-- loads scan-dir/.env -->
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/abs/path/to/logs/mcp-scan.out.log</string>
<key>StandardErrorPath</key><string>/abs/path/to/logs/mcp-scan.err.log</string>
```

The interactive agent is identical except `WorkingDirectory` points at the
connector repo (loading its `.env`). Use a **stable** `node` path (version-manager
shims disappear per-shell and break `KeepAlive`). Load with `launchctl load -w …`;
restart after a rebuild with `launchctl kickstart -k gui/$(id -u)/<label>`. The
`audit=…` flag on the connector's stderr startup line tells you which surface came
up on each endpoint.

> After (re)starting either agent, verify its surface with `pnpm run check:http`
> (Step 5) — it confirms the scan endpoint never exposes the general write tools.

### Step 5 — verify each endpoint's surface

The whole point is that the **scan** endpoint exposes the audit tools and **no**
general/skill write tools, so an injected scanner has nothing to write with. The
repo ships an authenticated check that runs the full MCP handshake against each
endpoint's local `/mcp` and compares the live tool surface with that endpoint's
`MCP_HTTP_ALLOW_*` flags — the bearer is read from the `.env` file and never
printed:

```bash
pnpm run check:http -- --env ./.env --env /abs/path/to/scan-dir/.env
```

For each endpoint it prints the server info, protocol, and tool counts
(read-only vs write-capable), then asserts the surface. It **fails** (non-zero
exit) if any endpoint's live surface is **wider** than its declared flags — e.g.
the scan endpoint exposing `create_document` — which is exactly the
confused-deputy regression this split prevents. A surface **narrower** than
declared (a flag on but the tool missing) is a warning, not a failure. With no
`--env`, it checks `./.env` (the interactive endpoint) alone.

<details>
<summary>Manual equivalent (curl)</summary>

```bash
# scan endpoint (8788): expect append_audit_report + compare_and_swap_audit_state,
# and NO create_document / plan_document_update / apply_planned_update in tools/list.
curl -s -X POST http://127.0.0.1:8788/mcp \
  -H "Authorization: Bearer $SCAN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# then reuse the returned mcp-session-id header for a {"method":"tools/list"} call.
```

</details>

The scanner must use a `run_id` with **no colons or slashes** (e.g.
`20260718T010203Z--<uuid>`); a raw ISO timestamp with `:` is rejected. See
[`SECURITY.md`](../SECURITY.md) (T11 + operating-conditions note) for the threat
model behind this split, and `CHANGELOG.md` `[0.6.0]` for what shipped.
