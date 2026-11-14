#!/usr/bin/env bash
# Office life end-to-end stack (L10): a PRIVATE office server from this tree with the test injector, a fake OpenClaw
# gateway and the private lab Hermes, all on loopback. Never points at a real office, gateway or Hermes.
#   tests/tools/life-e2e.sh start|stop|status|restart-server
# Layout (ROOT, default /tmp/vo8096-l10):
#   home/            HOME of the server (fake ~/.openclaw/openclaw.json: agents main + ops, gateway token test-token)
#   data/            VO_STATUS_DIR (vo-config.json with Office life on; Codex/Claude Code/OpenCode/Antigravity off)
#   lab/             lab Hermes copy (tests/tools/lab-hermes.sh; a = token sign-in, its stub model logs every LLM call)
#   env              shell lines for the test scripts (VO_URL, GW_CTL, LAB, ports)
# Ports (loopback only): office LIFE_PORT 18396 (+1 ws), fake gateway control LIFE_GW_CTL 18398 (gateway ws ephemeral,
# written to run/gw.port), lab a/b/stub 19338/19339/19690.
# The server runs with VO_LIFE_TEST_INJECT=1 (POST /api/office-life/test-event works for loopback only) and no TZ, so
# the office time zone starts on the UTC fallback (Settings adopts the browser zone once).
# LIFE_PL=1 (v0.11 layer mode): the REAL lab OpenClaw gateway (tests/tools/lab-openclaw.sh, LAB=$ROOT/oclab, ports
# LIFE_OC_PORT / LIFE_OC_STUB, default 19340 / 19341) instead of the fake one, and the office upgraded the way a 0.10.1
# office is: it starts on the legacy Python path (VO_PROVIDER_LAYER=0) to save the lab Hermes connection, then restarts
# with the copied OpenClaw + Hermes layer on, which migrates both connections.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$HERE/../.." && pwd)"
ROOT="${LIFE_E2E_ROOT:-/tmp/vo8096-l10}"
# A later call (restart-server, stop, status) without the ports in its environment acts on the
# stack that `start` wrote to $ROOT/env, not on the default ports.
if [ -z "${LIFE_PORT:-}" ] && [ -f "$ROOT/env" ]; then
  LIFE_PORT="$(sed -n 's/.*LIFE_PORT=\([0-9]*\).*/\1/p' "$ROOT/env" | head -1)"
  [ -z "${LIFE_GW_CTL:-}" ] && LIFE_GW_CTL="$(sed -n 's/.*LIFE_GW_CTL_PORT=\([0-9]*\).*/\1/p' "$ROOT/env" | head -1)"
  for k in LAB_PORT_A LAB_PORT_B LAB_PORT_STUB; do
    v="$(sed -n "s/.*$k=\\([0-9]*\\).*/\\1/p" "$ROOT/env" | head -1)"
    [ -n "$v" ] && [ -z "$(eval echo "\${$k:-}")" ] && export "$k=$v"
  done
fi
PORT="${LIFE_PORT:-18396}"
WS_PORT="$((PORT + 1))"
GW_CTL="${LIFE_GW_CTL:-18398}"
GW_CTL="${GW_CTL##*:}"   # also accepts the URL form (http://127.0.0.1:PORT)
if [ -z "${LIFE_PL:-}" ] && [ -f "$ROOT/env" ]; then LIFE_PL="$(sed -n 's/.*LIFE_PL=\([01]\).*/\1/p' "$ROOT/env" | head -1)"; fi
LIFE_PL="${LIFE_PL:-0}"
if [ -z "${LIFE_OC_PORT:-}" ] && [ -f "$ROOT/env" ]; then LIFE_OC_PORT="$(sed -n 's/.*LIFE_OC_PORT=\([0-9]*\).*/\1/p' "$ROOT/env" | head -1)"; fi
OC_PORT="${LIFE_OC_PORT:-19340}"
OC_STUB="${LIFE_OC_STUB:-$((OC_PORT + 1))}"
OCLAB="$ROOT/oclab"
NODE_DIR="$(dirname "$(command -v node || echo /usr/bin/node)")"
export LAB="$ROOT/lab" LAB_CWD="$ROOT/hcwd" LAB_PORT_A="${LAB_PORT_A:-19338}" LAB_PORT_B="${LAB_PORT_B:-19339}"
export LAB_PORT_STUB="${LAB_PORT_STUB:-19690}"
PY="$(command -v python3)"
# (the host python finds websockets in the user site; the server runs with a temp HOME, so pass that path on)
PYSITE="$("$PY" -c 'import os, websockets; print(os.path.dirname(os.path.dirname(websockets.__file__)))')"
FORBIDDEN="8085 8088 8090 8095 8096 8097 8099 9128 8642 8954 8977 18789"

die() { echo "life-e2e: $*" >&2; exit 1; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
alive() { [ -f "$ROOT/run/$1.pid" ] && kill -0 "$(cat "$ROOT/run/$1.pid")" 2>/dev/null; }
wait_http() {  # url seconds
  local i
  for i in $(seq 1 "$2"); do curl -fsS -o /dev/null --max-time 2 "$1" 2>/dev/null && return 0; sleep 1; done
  return 1
}

write_files() {
  mkdir -p "$ROOT/home/.openclaw" "$ROOT/data" "$ROOT/run" "$ROOT/logs"
  cat > "$ROOT/home/.openclaw/openclaw.json" <<'JSON'
{"agents": {"defaults": {"model": "fake/gpt-x"},
            "list": [{"id": "main", "name": "Main", "default": true}, {"id": "ops", "name": "Ops"}]},
 "gateway": {"port": 1, "auth": {"mode": "token", "token": "test-token"}}}
JSON
  # Default: no Hermes CLI visible to the server (a serve-only Docker install). `hermes serve` rows keep their own
  # connection status since 944995f (qa.md: they used to take the legacy CLI health and show offline).
  # LIFE_E2E_CLI_STUB=1 gives the server an inert CLI stub + empty home (the "CLI present" case).
  if [ "${LIFE_E2E_CLI_STUB:-0}" = 1 ]; then
    mkdir -p "$ROOT/home/.local/bin" "$ROOT/home/.hermes"
    printf '#!/bin/sh\necho "Hermes Agent v0.0.0 (life-e2e stub)"\nexit 0\n' > "$ROOT/home/.local/bin/hermes"
    chmod +x "$ROOT/home/.local/bin/hermes"
  else
    rm -f "$ROOT/home/.local/bin/hermes"
  fi
  [ -f "$ROOT/data/vo-config.json" ] || cat > "$ROOT/data/vo-config.json" <<'JSON'
{"codex": {"enabled": false}, "claudeCode": {"enabled": false}, "openCode": {"enabled": false},
 "antigravity": {"enabled": false}, "hermes": {"enabled": true},
 "officeLife": {"enabled": true}}
JSON
  # every listening socket on 127.0.0.1 (the server binds 0.0.0.0 by design)
  cat > "$ROOT/run/serve.py" <<'PYEOF'
import os, runpy, socketserver, sys
import websockets
_orig_bind = socketserver.TCPServer.server_bind
def _bind(self):
    host, port = self.server_address[:2]
    if host in ("0.0.0.0", "", "::"):
        self.server_address = ("127.0.0.1", port)
    return _orig_bind(self)
socketserver.TCPServer.server_bind = _bind
_orig_serve = websockets.serve
def _serve(handler, host=None, port=None, *a, **kw):
    return _orig_serve(handler, "127.0.0.1" if host in ("0.0.0.0", "", None) else host, port, *a, **kw)
websockets.serve = _serve
app = sys.argv[1]
sys.path.insert(0, app)
os.chdir(app)
sys.argv = [os.path.join(app, "server.py")]
runpy.run_path(os.path.join(app, "server.py"), run_name="__main__")
PYEOF
}

start_gateway() {
  alive gw && return 0
  port_busy "$GW_CTL" && die "port $GW_CTL is taken"
  rm -f "$ROOT/run/gw.port"
  setsid nohup "$PY" -u "$TREE/tests/test_life_e2e.py" --fake-gateway "$ROOT/run/gw.port" "$GW_CTL" \
    > "$ROOT/logs/gw.log" 2>&1 < /dev/null & echo $! > "$ROOT/run/gw.pid"
  local i; for i in $(seq 1 20); do [ -s "$ROOT/run/gw.port" ] && return 0; sleep 0.5; done
  die "fake gateway did not start; see $ROOT/logs/gw.log"
}

start_server() {
  alive server && return 0
  port_busy "$PORT" && die "port $PORT is taken"
  port_busy "$WS_PORT" && die "port $WS_PORT is taken"
  local gw token layer="${1:-0}"
  if [ "$LIFE_PL" = 1 ]; then gw="$OC_PORT"; token="$(cat "$OCLAB/token")"; else gw="$(cat "$ROOT/run/gw.port")"; token=test-token; layer=0; fi
  setsid nohup env -i HOME="$ROOT/home" PATH="$NODE_DIR:/usr/bin:/bin" LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PYSITE" \
    VO_PORT="$PORT" VO_WS_PORT="$WS_PORT" VO_STATUS_DIR="$ROOT/data" OPENCLAW_HOME="$ROOT/home/.openclaw" \
    VO_GATEWAY_URL="ws://127.0.0.1:$gw" VO_GATEWAY_HTTP="http://127.0.0.1:$gw" VO_GATEWAY_TOKEN="$token" \
    VO_PROVIDER_LAYER="$layer" VO_LIFE_TEST_INJECT=1 "$PY" -u "$ROOT/run/serve.py" "$TREE/app" >> "$ROOT/logs/server.log" 2>&1 < /dev/null &
  echo $! > "$ROOT/run/server.pid"
  wait_http "http://127.0.0.1:$PORT/api/office-life/state" 40 || die "office did not answer; see $ROOT/logs/server.log"
  if [ "$layer" = 1 ]; then
    local i
    for i in $(seq 1 60); do
      curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/connections" 2>/dev/null | "$PY" -c '
import json, sys
rows = json.load(sys.stdin).get("connections") or []
sys.exit(0 if len([r for r in rows if (r.get("status") or {}).get("state") == "connected"]) >= 2 else 1)' && return 0
      sleep 1
    done
    die "the layer did not connect the lab gateway and lab Hermes; see $ROOT/logs/server.log"
  fi
}

start_lab_openclaw() {
  LAB="$OCLAB" LAB_OC_PORT="$OC_PORT" LAB_OC_STUB="$OC_STUB" "$HERE/lab-openclaw.sh" start > "$ROOT/logs/oclab.log" 2>&1 \
    || die "lab OpenClaw did not start; see $ROOT/logs/oclab.log"
}

connect_lab() {
  local token body
  # (only a saved connection counts: the hermes manifest in the same answer also says "transport": "serve")
  if curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/agent-providers" | "$PY" -c '
import json, sys
rows = json.load(sys.stdin).get("providers") or []
sys.exit(0 if any(r.get("kind") == "hermes" and r.get("transport") == "serve" for r in rows) else 1)'; then return 0; fi
  token="$(cat "$LAB/a/session-token")"
  body="$("$PY" -c 'import json,sys; print(json.dumps({"kind":"hermes","transport":"serve","name":"Lab A","values":{"url":sys.argv[1],"auth":"token","token":sys.argv[2],"access":"full"}}))' "http://127.0.0.1:$LAB_PORT_A" "$token")"
  curl -fsS --max-time 40 -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
    -X POST "http://127.0.0.1:$PORT/api/agent-providers/save" -d "$body" -o "$ROOT/logs/connect.json" \
    || die "connecting lab a failed; see $ROOT/logs/connect.json"
}

stop_one() {
  local n="$1" pid
  [ -f "$ROOT/run/$n.pid" ] || return 0
  pid="$(cat "$ROOT/run/$n.pid")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    local i; for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$ROOT/run/$n.pid"
}

write_env() {
  cat > "$ROOT/env" <<EOF
export VO_URL=http://127.0.0.1:$PORT LIFE_PORT=$PORT
export LIFE_GW_CTL=http://127.0.0.1:$GW_CTL LIFE_GW_CTL_PORT=$GW_CTL
export LAB=$LAB LAB_PORT_A=$LAB_PORT_A LAB_PORT_B=$LAB_PORT_B LAB_PORT_STUB=$LAB_PORT_STUB
export LIFE_E2E_ROOT=$ROOT LIFE_PL=$LIFE_PL
export LIFE_OC_PORT=$OC_PORT LAB_OC=$OCLAB
EOF
}

for p in "$PORT" "$WS_PORT" "$GW_CTL" "$LAB_PORT_A" "$LAB_PORT_B" "$LAB_PORT_STUB" "$OC_PORT" "$OC_STUB"; do
  for f in $FORBIDDEN; do [ "$p" = "$f" ] && die "port $p belongs to a real office, gateway or Hermes; refusing"; done
done

case "${1:-}" in
  start)
    write_files
    if ! [ -f "$LAB/a.pid" ] || ! kill -0 "$(cat "$LAB/a.pid")" 2>/dev/null; then
      "$HERE/lab-hermes.sh" start > "$ROOT/logs/lab.log" 2>&1 || die "lab Hermes did not start; see $ROOT/logs/lab.log"
    fi
    if [ "$LIFE_PL" = 1 ]; then
      start_lab_openclaw
      start_server 0          # a 0.10.1 office (legacy Python path) saves the lab Hermes connection
      connect_lab
      stop_one server
      local_i=0; while port_busy "$PORT" && [ $local_i -lt 40 ]; do sleep 0.25; local_i=$((local_i + 1)); done
      start_server 1          # ... and is upgraded: the layer migrates the gateway and Hermes connections
    else
      start_gateway
      start_server
      connect_lab
    fi
    write_env
    echo "life-e2e: up (office http://127.0.0.1:$PORT, $([ "$LIFE_PL" = 1 ] && echo "layer on, lab gateway $OC_PORT" || echo "gateway ctl $GW_CTL"), lab a $LAB_PORT_A)"
    ;;
  restart-server)
    write_files
    stop_one server
    local_i=0; while port_busy "$PORT" && [ $local_i -lt 40 ]; do sleep 0.25; local_i=$((local_i + 1)); done
    start_server "$LIFE_PL"
    echo "life-e2e: server restarted"
    ;;
  stop)
    stop_one server
    stop_one gw
    [ -d "$LAB" ] && "$HERE/lab-hermes.sh" stop > /dev/null 2>&1 || true
    [ -d "$OCLAB" ] && LAB="$OCLAB" LAB_OC_PORT="$OC_PORT" LAB_OC_STUB="$OC_STUB" "$HERE/lab-openclaw.sh" stop > /dev/null 2>&1 || true
    busy=""
    for p in "$PORT" "$WS_PORT" "$GW_CTL" "$LAB_PORT_A" "$LAB_PORT_B" "$LAB_PORT_STUB" $([ "$LIFE_PL" = 1 ] && echo "$OC_PORT $OC_STUB"); do port_busy "$p" && busy="$busy $p"; done
    [ -z "$busy" ] && echo "life-e2e: stopped, ports free" || die "still listening:$busy"
    ;;
  status)
    for n in server gw; do alive "$n" && echo "$n up" || echo "$n down"; done
    [ -f "$LAB/a.pid" ] && kill -0 "$(cat "$LAB/a.pid")" 2>/dev/null && echo "lab up" || echo "lab down"
    ;;
  *) die "usage: $0 start|stop|status|restart-server" ;;
esac
