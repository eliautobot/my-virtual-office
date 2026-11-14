#!/usr/bin/env bash
# Private lab Hermes API server (the older "Hermes API server" connection of 0.7.x, one profile per API server) for
# Virtual Office development: a real `hermes gateway run` with ONLY its API server on, a fresh scratch HERMES_HOME and
# HOME under $LAB, answered by a stub model; started without systemd and stopped by its own pid files.
#   api server -> http://127.0.0.1:${LAB_HAPI_PORT:-19236}   (API_SERVER_KEY in $LAB/api-key, mode 0600)
#   stub model -> http://127.0.0.1:${LAB_HAPI_STUB:-19237}/v1 (OpenAI style; directives such as [[tool:<name> <json>]])
# Usage: tests/tools/lab-hermes-api.sh start|stop|status
# Inputs (environment, all optional):
#   LAB            where the lab lives (default /tmp/vo-hermes-api-lab)
#   LAB_CWD        the gateway's working folder, outside any git checkout (default $LAB/cwd)
#   HERMES_BIN     the hermes launcher (default: hermes on PATH, else ~/.local/bin/hermes)
#   HERMES_STUB    the stub model script (run with node, never edited; default ../mvw-next-local/tools-bin/oc-stub-model.mjs)
# Safety: refuses ports another Hermes or lab uses (9128 8642 8954 8977 19128 19480), refuses to start when its own ports
# are taken, never touches systemd or ~/.hermes, no messaging platform is configured, and stop kills only the process
# groups it started.
set -euo pipefail

LAB="${LAB:-/tmp/vo-hermes-api-lab}"
CWD_DIR="${LAB_CWD:-$LAB/cwd}"
PORT="${LAB_HAPI_PORT:-19236}"
STUB_PORT="${LAB_HAPI_STUB:-19237}"
FORBIDDEN="9128 8642 8954 8977 19128 19480"

die() { echo "lab-hermes-api: $*" >&2; exit 1; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
alive() { [ -f "$LAB/$1.pid" ] && kill -0 "$(cat "$LAB/$1.pid")" 2>/dev/null; }

hermes_bin() { local b="${HERMES_BIN:-$(command -v hermes || true)}"; [ -x "$b" ] || b="$HOME/.local/bin/hermes"; [ -x "$b" ] || die "hermes not found (set HERMES_BIN)"; echo "$b"; }
stub_script() {
  local s="${HERMES_STUB:-}"
  if [ -z "$s" ]; then
    local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    s="$here/../../../mvw-next-local/tools-bin/oc-stub-model.mjs"
    # (a worktree under Projects/<name>-polish/ sits one folder deeper)
    [ -f "$s" ] || s="$here/../../../../mvw-next-local/tools-bin/oc-stub-model.mjs"
  fi
  [ -f "$s" ] || die "set HERMES_STUB to the stub model script (oc-stub-model.mjs)"
  echo "$s"
}

start() {
  for n in stub api; do alive "$n" && die "the lab is already running ($n); stop it first"; done
  case "$LAB" in "$HOME/.hermes"|"$HOME/.hermes/"*) die "refusing a real Hermes home ($LAB)";; esac
  for p in "$PORT" "$STUB_PORT"; do
    for f in $FORBIDDEN; do [ "$p" = "$f" ] && die "port $p belongs to another Hermes or lab; refusing"; done
    port_busy "$p" && die "port $p is already taken; refusing to start"
  done
  [ "$PORT" != "$STUB_PORT" ] || die "ports must differ"
  local bin stub; bin="$(hermes_bin)"; stub="$(stub_script)"
  mkdir -p "$LAB/home" "$LAB/fakehome" "$CWD_DIR"
  chmod 700 "$LAB"
  [ -s "$LAB/api-key" ] || (umask 077; python3 -c 'import secrets; print("lab-" + secrets.token_hex(16))' > "$LAB/api-key")
  # A fresh home: the stub model, no telemetry, no Bot Desktop, no platform but the API server (from the environment).
  cat > "$LAB/home/config.yaml" <<YAML
model:
  default: stub-1
  provider: custom
  base_url: http://127.0.0.1:$STUB_PORT/v1
  api_key: stub-key-not-secret
telemetry:
  shared_metrics:
    enabled: false
    send: false
browser:
  backend: "off"
bot_desktop:
  auto_start: false
YAML
  : > "$LAB/home/.env"
  setsid nohup env -i "PATH=/usr/bin:/bin:$HOME/.local/bin" LANG=C.UTF-8 HOME="$LAB/fakehome" node "$stub" \
    --port "$STUB_PORT" > "$LAB/stub.log" 2>&1 < /dev/null & echo $! > "$LAB/stub.pid"
  setsid nohup env -i -C "$CWD_DIR" "PATH=/usr/bin:/bin:$HOME/.local/bin" LANG=C.UTF-8 HOME="$LAB/fakehome" \
    HERMES_HOME="$LAB/home" API_SERVER_KEY="$(cat "$LAB/api-key")" API_SERVER_PORT="$PORT" API_SERVER_HOST=127.0.0.1 \
    "$bin" gateway run >> "$LAB/api.log" 2>&1 < /dev/null & echo $! > "$LAB/api.pid"
  for _ in $(seq 1 90); do
    if curl -s -m 2 -o /dev/null -H "Authorization: Bearer $(cat "$LAB/api-key")" "http://127.0.0.1:$PORT/v1/models"; then
      echo "lab-hermes-api: API server http://127.0.0.1:$PORT (key in $LAB/api-key), stub http://127.0.0.1:$STUB_PORT/v1"
      return 0
    fi
    alive api || die "the gateway exited; see $LAB/api.log"
    sleep 1
  done
  die "the API server did not answer in 90 s; see $LAB/api.log"
}

kill_one() {
  alive "$1" || { rm -f "$LAB/$1.pid"; return 0; }
  local pid; pid="$(cat "$LAB/$1.pid")"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
  kill -KILL -- "-$pid" 2>/dev/null || true
  rm -f "$LAB/$1.pid"
}

case "${1:-}" in
  start) start ;;
  stop) for n in api stub; do kill_one "$n"; done; echo "lab-hermes-api: stopped" ;;
  status) for n in stub api; do if alive "$n"; then echo "$n: running (pid $(cat "$LAB/$n.pid"))"; else echo "$n: stopped"; fi; done ;;
  *) die "usage: $0 start|stop|status" ;;
esac
