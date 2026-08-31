#!/usr/bin/env bash
# funnel-watchdog.sh — re-assert the Tailscale Funnel ingress for the connector.
#
# WHY THIS EXISTS (incident 2026-08-30): after a sleep/offline window the
# Funnel *ingress* (the public edge -> tailscaled path) can stay dead while
# `tailscale funnel status` keeps printing "Funnel on" — status reads the
# stored serve config, not the live ingress. The public URL then returns
# 502/connection errors to every remote client while the origin process is
# perfectly healthy. Re-running `tailscale funnel --bg <port>` re-establishes
# the ingress; it was measured to be idempotent while healthy and to restore a
# dead ingress (externally verified from outside the tailnet, twice).
#
# SCOPE (learned on the third occurrence, 2026-08-31): the re-assert heals the
# SLEEP/IDLE variant only. When the machine's network path changes under
# tailscaled — a VPN toggled on/off, a Wi-Fi/gateway switch (observed as
# "portmap: gateway and self IP changed" plus a changed public IP in
# `tailscale netcheck`) — the edge keeps holding the stale path, and this
# re-assert does NOT bring the ingress back: `tailscale status`/netcheck look
# healthy, funnel says "on", and the public URL stays dead. Recovery for that
# variant is re-joining the tailnet, then re-asserting:
#   tailscale down && sleep 2 && tailscale up && bash funnel-watchdog.sh
# Automating the down/up here was considered and deliberately left out: it
# drops every live tailnet connection on the machine, which is too large a
# side effect for an unattended 5-minute timer to take on a guess.
#
# WHY NOT AN EXTERNAL HEALTH CHECK FROM THIS MACHINE: curl-ing the public
# https://<machine>.<tailnet>.ts.net URL from the machine itself does NOT
# traverse the public ingress — MagicDNS resolves the name to this machine's
# own tailnet address, so it can look green while the edge is dead. A true
# external probe needs a vantage point outside the tailnet; this script
# deliberately does not pretend to be one and just re-asserts, which is cheap.
#
# Intended use: a launchd job running this every few minutes and at wake.
# See docs/operations.md ("macOS: Tailscale Funnel + launchd") for the plist.
#
# Environment:
#   MCP_FUNNEL_PORT  local port to expose (default 8787)
#   TAILSCALE_BIN    path to the tailscale CLI (default: $PATH, then the
#                    macOS app-bundle binary — launchd jobs run with a minimal
#                    PATH that usually lacks Homebrew/App Store shims)
#
# No secrets are read, written, or logged here.

set -euo pipefail

PORT="${MCP_FUNNEL_PORT:-8787}"

# The port is spliced into a command line; accept digits only, fail closed.
case "$PORT" in
  '' | *[!0-9]*)
    echo "funnel-watchdog: MCP_FUNNEL_PORT must be numeric, got: $PORT" >&2
    exit 1
    ;;
esac

resolve_tailscale() {
  if [ -n "${TAILSCALE_BIN:-}" ]; then
    # An explicit override that does not exist is a configuration error, not a
    # transient condition — surfacing it beats silently "skipping" forever
    # (the skip path below is for a daemon that is down, not a wrong path).
    if [ ! -x "$TAILSCALE_BIN" ]; then
      echo "funnel-watchdog: TAILSCALE_BIN is not executable: $TAILSCALE_BIN" >&2
      return 1
    fi
    printf '%s\n' "$TAILSCALE_BIN"
    return
  fi
  if command -v tailscale > /dev/null 2>&1; then
    command -v tailscale
    return
  fi
  # macOS app-bundle CLI (the common case under launchd, whose PATH is minimal).
  local app="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  if [ -x "$app" ]; then
    printf '%s\n' "$app"
    return
  fi
  echo "funnel-watchdog: tailscale CLI not found (set TAILSCALE_BIN)" >&2
  return 1
}

TS="$(resolve_tailscale)"

# Daemon down or logged out: there is no ingress to assert. Exit 0 so launchd's
# StartInterval keeps the job on schedule instead of marking it failing —
# the next tick after the user logs back in will re-assert.
if ! "$TS" status > /dev/null 2>&1; then
  echo "funnel-watchdog: tailscaled unreachable or logged out; skipping" >&2
  exit 0
fi

# Idempotent re-assert. --bg persists the config and returns immediately;
# when the ingress is already live this is a no-op, and when it died the
# sleep/idle way this brings it back. (NOT after a network-path change —
# see SCOPE in the header; that variant needs `tailscale down && up` first.)
"$TS" funnel --bg "$PORT" > /dev/null
echo "funnel-watchdog: re-asserted funnel --bg $PORT at $(date '+%Y-%m-%dT%H:%M:%S%z')"
