#!/usr/bin/env bash
# A private office with EVERY chat provider on labs and fakes, for the one-window chat e2e (tests/e2e/pl_office_chat.mjs):
#   Codex       "Dex"            tests/tools/fake-codex    (app-server; LABS_CODEX_EXEC=1 -> exec --json)
#   Claude Code "Clara"          tests/tools/fake-claude   (stream-json, resume)
#   OpenCode    "OpenCode Main"  tests/tools/fake-opencode (run --format json)
#   Antigravity "Gravity"        tests/tools/fake-agy      (--print)
#   Hermes API  "Astra"          tests/tools/lab-hermes-api.sh (a real `hermes gateway` API server, stub model)
#   OpenClaw    "Main", "Ops"    tests/tools/lab-openclaw.sh   (a real OpenClaw gateway, stub model; the layer's connection)
# The office is tests/tools/pl-office.sh (layer ON unless PL_LAYER=0) with a vo-config.json written here first: each
# provider's `binary` is the fake, every provider home is under the office's scratch HOME (never ~/.codex, ~/.claude,
# ~/.config/opencode, ~/.gemini or ~/.hermes), and PATH has no real CLI. Every socket is on 127.0.0.1.
# Usage: tests/tools/office-labs.sh start|run|stop|status|env   (run = start and stay in the foreground until stopped)
# Inputs (environment, all optional):
#   LABS_ROOT       scratch root (default /tmp/vo-office-labs): office/, oc/, hapi/ below it
#   LABS_PORT       office port (default 19700; websocket +1)
#   LABS_OC_PORT    lab OpenClaw gateway (default 19690; its stub model +1; the gateway may use a few ports above)
#   LABS_HAPI_PORT  lab Hermes API server (default 19704; its stub model +1)
#   LABS_OC=0 / LABS_HAPI=0   leave that lab out (the office then has no OpenClaw / Hermes API agent)
#   LABS_CODEX_EXEC=1         Codex through `codex exec --json` instead of the app-server
#   LABS_FAKE_ENV="K=V ..."   extra variables for the fakes, e.g. FAKE_SLOW_STEP=0.3 (written to the fakes' wrapper)
#   PL_LAYER=0                the office with the layer OFF (the old window)
#   PL_TREE=<worktree>        run the office from another tree (default: this one; the fakes always come from this one)
# `env` prints VO_URL, VO_LOG, LAB_OC, LAB_HAPI, OC_PORT, HAPI_PORT, LABS_ROOT for the e2e.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="${PL_TREE:-$(cd "$HERE/../.." && pwd)}"
ROOT="${LABS_ROOT:-/tmp/vo-office-labs}"
PORT="${LABS_PORT:-19700}"
OC_PORT="${LABS_OC_PORT:-19690}"
HAPI_PORT="${LABS_HAPI_PORT:-19704}"
OFFICE="$ROOT/office"

die() { echo "office-labs: $*" >&2; exit 1; }
case "$ROOT" in /tmp/*) ;; *) die "LABS_ROOT must be under /tmp (it is wiped and holds scratch homes)" ;; esac

fake_wrappers() {
  # The office runs each provider binary with its own narrow environment; a wrapper per fake adds LABS_FAKE_ENV.
  mkdir -p "$ROOT/bin"
  local f
  for f in fake-codex fake-claude fake-opencode fake-agy; do
    {
      echo '#!/bin/sh'
      for kv in ${LABS_FAKE_ENV:-}; do printf 'export %q\n' "$kv"; done
      printf 'exec %q "$@"\n' "$HERE/$f"
    } > "$ROOT/bin/$f"
    chmod 755 "$ROOT/bin/$f"
  done
}

seed_office() {
  local H="$OFFICE/home" D="$OFFICE/data"
  mkdir -p "$H" "$D"
  # Named office agents (the office's own creation format), so names differ from the lab OpenClaw's "Main".
  mkdir -p "$D/codex-agents/dex" "$D/claude-agents/clara" "$D/opencode-agents" "$D/antigravity-agents"
  cat > "$D/codex-agents/dex/office-agent.json" <<'JSON'
{"profile": "dex", "name": "Dex", "emoji": "⌨️", "role": "Codex lab agent", "prompt": "Answer briefly.", "creationMode": "virtual-office"}
JSON
  cat > "$D/claude-agents/clara/office-agent.json" <<'JSON'
{"profile": "clara", "name": "Clara", "emoji": "✳️", "role": "Claude Code lab agent", "prompt": "Answer briefly.", "creationMode": "virtual-office"}
JSON
  # A demo office shows at most 3 agents (app/license.py DEMO_LIMITS): the lab office gets a local activation receipt
  # (scratch data only, never a real key) so all seven agents sit at desks. LABS_DEMO=1 keeps the demo limit.
  if [ "${LABS_DEMO:-0}" != 1 ]; then
    cat > "$D/license.json" <<'JSON'
{"activated": true, "key": "OFFICE-LABS-SCRATCH", "instanceId": "office-labs", "tier": "FULL", "activatedAt": "2026-11-13T00:00:00Z"}
JSON
  fi
  local hermes='{"enabled": false}'
  if [ "${LABS_HAPI:-1}" != 0 ]; then
    local key; key="$(cat "$ROOT/hapi/api-key")"
    hermes=$(printf '{"enabled": true, "preferApi": false, "timeoutSec": 600, "platformEnabled": false, "platformAgentId": "hermes-gateway", "localProfilesEnabled": false, "followActiveSession": true, "sessionSyncIntervalSec": 3, "connections": [{"id": "astra", "name": "Astra", "apiUrl": "http://127.0.0.1:%s", "apiKey": "%s", "emoji": "⚕️", "role": "Hermes Agent", "resourcePath": "", "resourceAccess": "inherit", "enabled": true, "endpointMode": "auto"}]}' "$HAPI_PORT" "$key")
  fi
  local app=true; [ "${LABS_CODEX_EXEC:-0}" = 1 ] && app=false
  cat > "$D/vo-config.json" <<JSON
{"codex": {"enabled": true, "binary": "$ROOT/bin/fake-codex", "homePath": "$H/.codex", "workspaceRoot": "$D/codex-agents",
           "preferAppServer": $app, "approvalPolicy": "on-request", "includeMain": false, "includeNativeAgents": false, "registerNativeAgents": false},
 "claudeCode": {"enabled": true, "binary": "$ROOT/bin/fake-claude", "homePath": "$H/.claude", "workspaceRoot": "$D/claude-agents",
                "includeMain": false, "includeNativeAgents": false, "registerNativeAgents": false},
 "openCode": {"enabled": true, "binary": "$ROOT/bin/fake-opencode", "homePath": "$H/.config/opencode", "workspaceRoot": "$D/opencode-agents"},
 "antigravity": {"enabled": true, "binary": "$ROOT/bin/fake-agy", "homePath": "$H/.gemini/config", "workspaceRoot": "$D/antigravity-agents"},
 "hermes": $hermes,
 "officeLife": {"enabled": true}}
JSON
}

oc_env() { LAB="$ROOT/oc" LAB_OC_PORT="$OC_PORT" LAB_OC_STUB="$((OC_PORT + 1))" "$@"; }
hapi_env() { LAB="$ROOT/hapi" LAB_HAPI_PORT="$HAPI_PORT" LAB_HAPI_STUB="$((HAPI_PORT + 1))" "$@"; }
office_env() {
  local gw=()
  if [ "${LABS_OC:-1}" != 0 ]; then
    gw=(PL_GATEWAY_URL="ws://127.0.0.1:$OC_PORT" PL_GATEWAY_HTTP="http://127.0.0.1:$OC_PORT" PL_GATEWAY_TOKEN="$(cat "$ROOT/oc/token")")
  fi
  env PL_ROOT="$OFFICE" PL_PORT="$PORT" "${gw[@]}" "$@"
}

start() {
  mkdir -p "$ROOT"
  fake_wrappers
  if [ "${LABS_OC:-1}" != 0 ]; then oc_env "$HERE/lab-openclaw.sh" start > "$ROOT/oc-start.log" 2>&1 || { tail -5 "$ROOT/oc-start.log"; die "lab OpenClaw did not start"; }; fi
  if [ "${LABS_HAPI:-1}" != 0 ]; then hapi_env "$HERE/lab-hermes-api.sh" start > "$ROOT/hapi-start.log" 2>&1 || { tail -5 "$ROOT/hapi-start.log"; die "lab Hermes API did not start"; }; fi
  [ -f "$OFFICE/data/vo-config.json" ] || seed_office
  office_env "$TREE/tests/tools/pl-office.sh" start
  echo "office-labs: office http://127.0.0.1:$PORT  (fakes: $ROOT/bin; logs: $OFFICE/logs/server.log)"
}

stop() {
  [ -d "$OFFICE" ] && PL_ROOT="$OFFICE" PL_PORT="$PORT" "$TREE/tests/tools/pl-office.sh" stop || true
  [ -d "$ROOT/hapi" ] && hapi_env "$HERE/lab-hermes-api.sh" stop || true
  [ -d "$ROOT/oc" ] && oc_env "$HERE/lab-openclaw.sh" stop || true
  # fakes the office started and left behind (a killed run): only processes running a fake from $ROOT/bin or this tree
  pkill -f "^python3 $HERE/fake-(codex|claude|opencode|agy)" 2>/dev/null || true
  echo "office-labs: stopped"
}

status() {
  PL_ROOT="$OFFICE" PL_PORT="$PORT" "$TREE/tests/tools/pl-office.sh" status || true
  [ "${LABS_OC:-1}" != 0 ] && { oc_env "$HERE/lab-openclaw.sh" status || true; }
  [ "${LABS_HAPI:-1}" != 0 ] && { hapi_env "$HERE/lab-hermes-api.sh" status || true; }
}

run() {
  # start, then stay in the foreground until the office stops or this script gets INT/TERM (then stop everything):
  # for runners that end a command's whole process tree when the command returns.
  trap 'stop; exit 0' INT TERM
  start
  while [ -f "$OFFICE/run/server.pid" ] && kill -0 "$(cat "$OFFICE/run/server.pid")" 2>/dev/null; do sleep 3; done
  echo "office-labs: the office stopped"
}

case "${1:-}" in
  start) start ;;
  run) run ;;
  stop) stop ;;
  status) status ;;
  env) printf 'VO_URL=http://127.0.0.1:%s\nVO_LOG=%s\nLAB_OC=%s\nLAB_HAPI=%s\nOC_PORT=%s\nHAPI_PORT=%s\nLABS_ROOT=%s\n' \
         "$PORT" "$OFFICE/logs/server.log" "$ROOT/oc" "$ROOT/hapi" "$OC_PORT" "$HAPI_PORT" "$ROOT" ;;
  *) die "usage: $0 start|run|stop|status|env" ;;
esac
