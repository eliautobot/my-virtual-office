#!/usr/bin/env bash
# A private office from this tree with the copied OpenClaw + Hermes layer ON (VO_PROVIDER_LAYER=1), for the v0.11 UI
# checks (tests/e2e/pl_chat.mjs, pl_menu.mjs). Its own HOME, data and ports; every socket on 127.0.0.1. The office's
# own OpenClaw roster reads a fake openclaw.json with agents "main" and "ops" (the same ids as the lab gateway), so they
# sit at desks; the office's Python gateway client points at a closed port (the LAYER talks to the lab gateway).
# Usage: PL_ROOT=/tmp/x PL_PORT=<p> tests/tools/pl-office.sh start|stop|status
#   optional: PL_GATEWAY_URL / PL_GATEWAY_HTTP / PL_GATEWAY_TOKEN (the office's own gateway, e.g. a lab gateway: the
#   layer migrates it once as its OpenClaw connection), PL_LIFE_INJECT=1 (Office life test injector), PL_LAYER=0,
#   PL_PATH (the server's PATH, e.g. a folder without node: the "no Node.js" case)
#   PL_HOST=<IPv4>   listen there instead of 127.0.0.1 (e.g. the docker0 address 172.17.0.1: a non-loopback client, so a
#                    passcode office asks for its passcode and for it again before setting changes)
#   PL_PASSCODE=<p>  give the office that passcode (first start only)
#   PL_FIND=<urls>   where Agent Providers' Find looks (VO_PL_FIND; default a closed port: never a real gateway's)
#   start  -> http://127.0.0.1:$PL_PORT (websocket port $PL_PORT+1), logs in $PL_ROOT/logs
#   stop   kills only what start started (pid file; the layer's node child goes with its server)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$HERE/../.." && pwd)"
ROOT="${PL_ROOT:-/tmp/vo-pl-office}"
HOST="${PL_HOST:-127.0.0.1}"
PORT="${PL_PORT:-18720}"
WS_PORT="$((PORT + 1))"
PY="$(command -v python3)"
PYSITE="$("$PY" -c 'import os, websockets; print(os.path.dirname(os.path.dirname(websockets.__file__)))')"
NODE_DIR="$(dirname "$(command -v node)")"
FORBIDDEN="8085 8088 8090 8095 8096 8097 8099 9128 8642 8954 8977 18789"

die() { echo "pl-office: $*" >&2; exit 1; }
port_busy() { (exec 3<>"/dev/tcp/$HOST/$1") 2>/dev/null; }
alive() { [ -f "$ROOT/run/server.pid" ] && kill -0 "$(cat "$ROOT/run/server.pid")" 2>/dev/null; }
case "$HOST" in 127.*|172.17.0.1) ;; *) die "PL_HOST must be loopback or the docker0 address" ;; esac
for p in $FORBIDDEN; do [ "$PORT" = "$p" ] || [ "$WS_PORT" = "$p" ] && die "port $p is a real service"; done

start() {
  alive && { echo "pl-office: running on http://127.0.0.1:$PORT"; return 0; }
  port_busy "$PORT" && die "port $PORT is taken"
  port_busy "$WS_PORT" && die "port $WS_PORT is taken"
  mkdir -p "$ROOT/home/.openclaw" "$ROOT/data" "$ROOT/run" "$ROOT/logs"
  cat > "$ROOT/home/.openclaw/openclaw.json" <<'JSON'
{"agents": {"defaults": {"model": "fake/gpt-x"},
            "list": [{"id": "main", "name": "Main", "default": true}, {"id": "ops", "name": "Ops"}]},
 "gateway": {"port": 1, "auth": {"mode": "token", "token": "test-token"}}}
JSON
  if [ -n "${PL_PASSCODE:-}" ] && [ ! -f "$ROOT/data/access.json" ]; then
    PYTHONPATH="$TREE/app" PL_DATA="$ROOT/data" "$PY" -c 'import os, vo_access; vo_access.AccessStore(os.environ["PL_DATA"]).set_passcode(os.environ["PL_PASSCODE"])'
  fi
  [ -f "$ROOT/data/vo-config.json" ] || cat > "$ROOT/data/vo-config.json" <<'JSON'
{"codex": {"enabled": false}, "claudeCode": {"enabled": false}, "openCode": {"enabled": false},
 "antigravity": {"enabled": false}, "hermes": {"enabled": true}, "officeLife": {"enabled": true}}
JSON
  cat > "$ROOT/run/serve.py" <<'PYEOF'
import os, runpy, socketserver, sys
import websockets
HOST = os.environ.get("PL_BIND_HOST") or "127.0.0.1"
_orig_bind = socketserver.TCPServer.server_bind
def _bind(self):
    host, port = self.server_address[:2]
    if host in ("0.0.0.0", "", "::"):
        self.server_address = (HOST, port)
    return _orig_bind(self)
socketserver.TCPServer.server_bind = _bind
_orig_serve = websockets.serve
def _serve(handler, host=None, port=None, *a, **kw):
    return _orig_serve(handler, HOST if host in ("0.0.0.0", "", None) else host, port, *a, **kw)
websockets.serve = _serve
app = sys.argv[1]
sys.path.insert(0, app)
os.chdir(app)
sys.argv = [os.path.join(app, "server.py")]
runpy.run_path(os.path.join(app, "server.py"), run_name="__main__")
PYEOF
  setsid nohup env -i HOME="$ROOT/home" PATH="${PL_PATH:-$NODE_DIR:/usr/bin:/bin}" LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PYSITE" \
    VO_PORT="$PORT" VO_WS_PORT="$WS_PORT" VO_STATUS_DIR="$ROOT/data" VO_CONFIG="$ROOT/data/vo-config.json" \
    OPENCLAW_HOME="$ROOT/home/.openclaw" VO_OPENCLAW_PATH="$ROOT/home/.openclaw" \
    VO_GATEWAY_URL="${PL_GATEWAY_URL:-ws://127.0.0.1:9}" VO_GATEWAY_HTTP="${PL_GATEWAY_HTTP:-http://127.0.0.1:9}" \
    VO_GATEWAY_TOKEN="${PL_GATEWAY_TOKEN:-test-token}" VO_LIFE_TEST_INJECT="${PL_LIFE_INJECT:-0}" \
    VO_CODEX_INCLUDE_NATIVE_AGENTS=0 VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS=0 VO_PROVIDER_LAYER="${PL_LAYER:-1}" \
    VO_PL_FIND="${PL_FIND:-ws://127.0.0.1:9}" PL_BIND_HOST="$HOST" \
    "$PY" -u "$ROOT/run/serve.py" "$TREE/app" >> "$ROOT/logs/server.log" 2>&1 < /dev/null &
  echo $! > "$ROOT/run/server.pid"
  local i UP_MARK='"running": *true'
  [ "${PL_LAYER:-1}" = 0 ] && UP_MARK='"enabled": *false'
  for i in $(seq 1 60); do
    # (a passcode office answers a non-loopback curl with 401: then the layer's own "helper ready" line says it is up)
    if curl -fsS --max-time 2 "http://$HOST:$PORT/api/office/provider-layer" 2>/dev/null | grep -Eq "$UP_MARK|\"nodeOk\": *false" ||
       { [ -n "${PL_PASSCODE:-}" ] && grep -q '\[providers\] helper ready' "$ROOT/logs/server.log" 2>/dev/null; }; then
      echo "pl-office: http://$HOST:$PORT (layer running)"; return 0
    fi
    sleep 1
  done
  die "office or layer did not come up; see $ROOT/logs/server.log"
}

stop() {
  if alive; then
    local pid; pid="$(cat "$ROOT/run/server.pid")"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    local i; for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$ROOT/run/server.pid"
  echo "pl-office: stopped"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) alive && echo "pl-office: running on http://127.0.0.1:$PORT" || echo "pl-office: stopped" ;;
  *) die "usage: $0 start|stop|status" ;;
esac
