#!/usr/bin/env bash
# Private lab OpenClaw gateway for Virtual Office development: a REAL `openclaw gateway run` with its own home, state,
# config and log under $LAB, answered by a stub model (tests/tools/oc_stub_model.py), started without systemd and
# stopped by its own pid files. Used by tests/legacy/test_openclaw_lab_e2e.py (OC_LAB_E2E=1) and by hand.
#   gateway  -> ws://127.0.0.1:${LAB_OC_PORT:-19690}   (token auth, token in $LAB/token, mode 0600)
#               with LAB_OC_BIND=<IPv4> (for example the docker0 address 172.17.0.1) it also listens on that address,
#               so the office can reach it the way a Docker bridge container does (a non-loopback client)
#               with LAB_OC_AUTH=password it signs in with a password instead (gateway.auth.mode=password, in $LAB/password)
#               with LAB_OC_BROWSER_CDP=<port> its agents get a headless browser (Chrome, its own profile under $LAB,
#               CDP on that loopback port; the browser control service is the gateway port + 2); with
#               LAB_OC_BROWSER_CDP_URL=http://127.0.0.1:<port> it attaches to a Chrome already listening there instead
#               (a test's own headless Chrome: one Chrome for the page and the agent's tabs)
#   stub     -> http://127.0.0.1:${LAB_OC_STUB:-19691}/v1  (agents "main" and "ops" answer from it)
# Usage: tests/tools/lab-openclaw.sh start|stop|status|env|shape|config|cli <openclaw args...>
#   shape prints the installed build's version and the agents shape start would write; config writes the lab config only.
#   cli runs the openclaw CLI against the LAB gateway only (for example: cli devices list, cli devices approve <id>).
# Inputs (environment, all optional): LAB (default /tmp/vo-openclaw-lab), LAB_OC_PORT, LAB_OC_STUB, LAB_OC_BIND, LAB_OC_AUTH,
#   OPENCLAW_BIN (default: openclaw on PATH), LAB_OC_AGENTS=entries|list (the agents shape; default: asked of the
#   installed OpenClaw), LAB_OC_KEEP_CONFIG=1 (start keeps an existing lab openclaw.json, e.g. one `cli doctor --fix` made),
#   LAB_OC_HEARTBEAT_EVERY=1m (main's scheduled heartbeat turn at that cadence instead of OpenClaw's 30 min default) and
#   LAB_OC_HEARTBEAT_PROMPT (that turn's prompt, e.g. with slow:<ms> for the stub), LAB_OC_HEARTBEAT_TARGET (e.g. none: the
#   lab has no owner DM, so the default target "owner" skips every poll as no-route before the agent runs; none runs it).
# Agents shape: OpenClaw 2026.11.x refuses the old `agents.list` ("moved to keyed agents.entries") and wants
#   agents.entries + agents.ownership="explicit" + agents.defaults.systemAgent (what `doctor --fix` writes); 2026.9.x
#   takes both; older builds know only agents.list. So the script reads the installed build's own config schema
#   (`openclaw config schema`): agents.entries there -> the keyed shape, else (or no schema command) agents.list.
# Safety: every openclaw process gets HOME / OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH under $LAB and logging.file is
# written into the lab config before the first start, so nothing reaches a real ~/.openclaw or the shared log. Refuses
# the default gateway port 18789, refuses to start when its ports are taken, and stop kills only what it started.
set -euo pipefail

LAB="${LAB:-/tmp/vo-openclaw-lab}"
PORT="${LAB_OC_PORT:-19690}"
STUB_PORT="${LAB_OC_STUB:-19691}"
BIND="${LAB_OC_BIND:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "lab-openclaw: $*" >&2; exit 1; }

oc_bin() {
  local b="${OPENCLAW_BIN:-}"
  [ -n "$b" ] || b="$(command -v openclaw || true)"
  [ -n "$b" ] && [ -x "$b" ] || die "openclaw is not installed (set OPENCLAW_BIN)"
  echo "$b"
}

lab_env() {
  # A clean environment: nothing from the caller's OpenClaw settings leaks in.
  env -i HOME="$LAB/home" PATH="$PATH" LANG=C.UTF-8 TMPDIR="$LAB/tmp" \
    OPENCLAW_STATE_DIR="$LAB/home/.openclaw" OPENCLAW_CONFIG_PATH="$LAB/home/.openclaw/openclaw.json" "$@"
}

port_busy() { (exec 3<>"/dev/tcp/${2:-127.0.0.1}/$1") 2>/dev/null; }
# (OpenClaw 2026.7.x with a custom bind listens on that address only; 2026.9+ on loopback too: either counts)
port_open() { port_busy "$1" || { [ -n "$BIND" ] && port_busy "$1" "$BIND"; }; }

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

oc_version() { "$1" --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -n 1 || true; }

schema_file() {
  # The installed build's own config schema, saved once per start in the lab ($LAB/tmp/oc-schema.json; empty when the
  # build has no `config schema`): which config keys it takes is read from there, not guessed from a version number.
  local bin="$1" f="$LAB/tmp/oc-schema.json"
  mkdir -p "$LAB/tmp" "$LAB/home/.openclaw"
  (cd "$LAB" && lab_env "$bin" config schema 2>/dev/null) > "$f.new" || true
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f.new" 2>/dev/null && mv "$f.new" "$f" || { rm -f "$f.new"; : > "$f"; }
  echo "$f"
}

agents_shape() {
  # entries | list (LAB_OC_AGENTS overrides): agents.entries in the schema -> entries, else (or no schema) list.
  local schema="$1" shape="${LAB_OC_AGENTS:-}"
  if [ -z "$shape" ]; then
    shape="$(python3 -c '
import json, sys
try:
    props = json.load(open(sys.argv[1]))["properties"]["agents"]["properties"]
except Exception:
    props = {}
print("entries" if "entries" in props else "list")' "$schema" 2>/dev/null || true)"
  fi
  case "$shape" in entries|list) echo "$shape" ;; *) echo list ;; esac
}

write_config() {
  local bin="$1"
  mkdir -p "$LAB/home/.openclaw" "$LAB/tmp" "$LAB/logs" "$LAB/ws-main" "$LAB/ws-ops"
  chmod 700 "$LAB" "$LAB/home"
  if [ "${LAB_OC_KEEP_CONFIG:-0}" = 1 ] && [ -s "$LAB/home/.openclaw/openclaw.json" ]; then
    echo "lab-openclaw: keeping $LAB/home/.openclaw/openclaw.json (LAB_OC_KEEP_CONFIG=1)"
    return 0
  fi
  local schema shape; schema="$(schema_file "$bin")"; shape="$(agents_shape "$schema")"
  echo "lab-openclaw: OpenClaw $(oc_version "$bin"), agents config shape: $shape"
  if [ ! -s "$LAB/token" ]; then
    (umask 077; python3 -c 'import secrets; print("lab-" + secrets.token_hex(16))' > "$LAB/token")
  fi
  if [ "${LAB_OC_AUTH:-token}" = password ] && [ ! -s "$LAB/password" ]; then
    (umask 077; python3 -c 'import secrets; print("pw-" + secrets.token_hex(12))' > "$LAB/password")
  fi
  LAB="$LAB" PORT="$PORT" STUB_PORT="$STUB_PORT" BIND="$BIND" AUTH="${LAB_OC_AUTH:-token}" CDP="${LAB_OC_BROWSER_CDP:-}" CDP_URL="${LAB_OC_BROWSER_CDP_URL:-}" SHAPE="$shape" SCHEMA="$schema" \
    HB_EVERY="${LAB_OC_HEARTBEAT_EVERY:-}" HB_PROMPT="${LAB_OC_HEARTBEAT_PROMPT:-}" HB_TARGET="${LAB_OC_HEARTBEAT_TARGET:-}" \
    CHROME="${CHROME_PATH:-/usr/bin/google-chrome}" python3 - <<'PY'
import json, os
lab, bind = os.environ["LAB"], os.environ["BIND"]
auth = ({"mode": "password", "password": open(f"{lab}/password").read().strip()} if os.environ["AUTH"] == "password"
        else {"mode": "token", "token": open(f"{lab}/token").read().strip()})
gateway = {"mode": "local", "port": int(os.environ["PORT"]), "bind": "loopback", "auth": auth}
if bind:
    gateway.update(bind="custom", customBindHost=bind)
config = {
    "gateway": gateway,
    "logging": {"file": f"{lab}/logs/gateway.log"},
    "models": {"providers": {"stub": {
        "baseUrl": f"http://127.0.0.1:{os.environ['STUB_PORT']}/v1", "apiKey": "stub-key-not-secret",
        "api": "openai-completions",
        "models": [{"id": "stub-1", "name": "Stub One", "reasoning": False, "input": ["text"],
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    "contextWindow": 128000, "maxTokens": 8192},
                   # (a second model: the chat's model picker has a choice; it reasons, so its effort levels show,
                   #  and it has a price, so a turn has a cost)
                   {"id": "stub-2", "name": "Stub Two", "reasoning": True, "input": ["text", "image"],
                    "cost": {"input": 3, "output": 15, "cacheRead": 0, "cacheWrite": 0},
                    "contextWindow": 64000, "maxTokens": 8192}]}}},
    "agents": {"defaults": {"model": {"primary": "stub/stub-1"}, "workspace": f"{lab}/ws-main"},
               "list": [{"id": "main", "name": "Main", "workspace": f"{lab}/ws-main"},
                        {"id": "ops", "name": "Ops", "workspace": f"{lab}/ws-ops"}]},
}
if os.environ["SHAPE"] == "entries":
    # (OpenClaw 2026.9+: keyed entries, the roster owned explicitly, main does the system work: what doctor --fix writes)
    agents = config["agents"]
    agents["entries"] = {a["id"]: {k: v for k, v in a.items() if k != "id"} for a in agents.pop("list")}
    agents["ownership"] = "explicit"
    agents["defaults"].update(systemAgent={"agentId": "main"}, heartbeat={"agentId": "main"})
    config["talk"] = {"agentId": "main"}
if os.environ.get("HB_EVERY"):
    # (a short heartbeat cadence for presence tests: the gateway's own scheduler runs main's heartbeat turn, as on a real
    #  install every 30 min; HB_PROMPT may carry stub words such as slow:<ms>)
    hb = config["agents"]["defaults"].setdefault("heartbeat", {})
    hb["every"] = os.environ["HB_EVERY"]
    if os.environ.get("HB_PROMPT"):
        hb["prompt"] = os.environ["HB_PROMPT"]
    if os.environ.get("HB_TARGET"):
        hb["target"] = os.environ["HB_TARGET"]
def profile_keys():
    # (a browser profile's keys this build takes: 2026.7 lists "color", 2026.9 only tolerates it, 2026.11 refuses it)
    try:
        item = json.load(open(os.environ["SCHEMA"]))["properties"]["browser"]["properties"]["profiles"]["additionalProperties"]
        return set(item["properties"])
    except Exception:
        return {"cdpUrl", "cdpPort", "attachOnly", "color"}
def profile(**keys):
    known = profile_keys()
    return {k: v for k, v in keys.items() if k in known}
if os.environ.get("CDP_URL"):
    # (the lab's pages are on loopback: this lab browser may open them)
    config["browser"] = {"enabled": True, "defaultProfile": "openclaw", "ssrfPolicy": {"dangerouslyAllowPrivateNetwork": True},
                         "profiles": {"openclaw": profile(cdpUrl=os.environ["CDP_URL"], attachOnly=True, color="#FF4500")}}
elif os.environ.get("CDP"):
    config["browser"] = {"enabled": True, "headless": True, "noSandbox": True, "executablePath": os.environ["CHROME"],
                         "defaultProfile": "openclaw", "profiles": {"openclaw": profile(cdpPort=int(os.environ["CDP"]), color="#FF4500")}}
path = f"{lab}/home/.openclaw/openclaw.json"
with open(path, "w") as handle:
    json.dump(config, handle, indent=2)
os.chmod(path, 0o600)
PY
}

wait_port() {
  local port="$1" what="$2" i
  for i in $(seq 1 120); do
    port_open "$port" && return 0
    sleep 0.5
  done
  die "$what did not open port $port (see $LAB/logs)"
}

start() {
  [ "$PORT" != 18789 ] || die "refusing the default gateway port 18789"
  alive "$LAB/gateway.pid" && { echo "lab-openclaw: already running on $PORT"; return 0; }
  port_open "$PORT" && die "port $PORT is taken"
  port_busy "$STUB_PORT" && die "port $STUB_PORT is taken"
  local bin; bin="$(oc_bin)"
  write_config "$bin"
  setsid nohup python3 "$HERE/oc_stub_model.py" "$STUB_PORT" > "$LAB/logs/stub.out" 2>&1 < /dev/null &
  echo $! > "$LAB/stub.pid"
  wait_port "$STUB_PORT" "stub model"
  setsid nohup bash -c 'cd "$1" && exec "${@:2}"' _ "$LAB" env -i HOME="$LAB/home" PATH="$PATH" LANG=C.UTF-8 \
    TMPDIR="$LAB/tmp" OPENCLAW_STATE_DIR="$LAB/home/.openclaw" OPENCLAW_CONFIG_PATH="$LAB/home/.openclaw/openclaw.json" \
    "$bin" gateway run --port "$PORT" > "$LAB/logs/gateway.out" 2>&1 < /dev/null &
  echo $! > "$LAB/gateway.pid"
  wait_port "$PORT" "gateway"
  if [ -n "$BIND" ] && ! port_busy "$PORT"; then
    echo "lab-openclaw: note: this OpenClaw listens on $BIND only (2026.7.x does with a custom bind), so 'cli' cannot reach it; start without LAB_OC_BIND for a loopback lab"
  fi
  echo "lab-openclaw: gateway ws://127.0.0.1:$PORT${BIND:+ and ws://$BIND:$PORT}, stub :$STUB_PORT, lab $LAB"
}

stop_one() {
  local pidfile="$1" pid i
  alive "$pidfile" || { rm -f "$pidfile"; return 0; }
  pid="$(cat "$pidfile")"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -KILL -- "-$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

case "${1:-}" in
  start) start ;;
  stop) stop_one "$LAB/gateway.pid"; stop_one "$LAB/stub.pid"; echo "lab-openclaw: stopped" ;;
  status)
    alive "$LAB/gateway.pid" && echo "gateway: running on $PORT${BIND:+ (+ $BIND)}" || echo "gateway: stopped"
    alive "$LAB/stub.pid" && echo "stub: running on $STUB_PORT" || echo "stub: stopped" ;;
  env) printf 'LAB=%s\nLAB_OC_PORT=%s\nLAB_OC_STUB=%s\nLAB_OC_BIND=%s\nLAB_OC_TOKEN_FILE=%s\n' \
         "$LAB" "$PORT" "$STUB_PORT" "$BIND" "$LAB/token" ;;
  config) bin="$(oc_bin)"; write_config "$bin"; echo "$LAB/home/.openclaw/openclaw.json" ;;
  shape) bin="$(oc_bin)"; echo "$(oc_version "$bin") $(agents_shape "$(schema_file "$bin")")" ;;
  cli) shift; [ -s "$LAB/home/.openclaw/openclaw.json" ] || die "start the lab first"
       bin="$(oc_bin)"; cd "$LAB" && lab_env "$bin" "$@" ;;
  *) die "usage: $0 start|stop|status|env|shape|config|cli <openclaw args...>" ;;
esac
