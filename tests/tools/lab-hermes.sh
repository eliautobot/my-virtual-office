#!/usr/bin/env bash
# Private lab Hermes for Virtual Office development: two real `hermes serve` backends from a COPY of a lab Hermes home,
# answered by a stub model, started without systemd and stopped by their own pid files.
#   a: session-token sign-in   -> http://127.0.0.1:${LAB_PORT_A:-19228}  (token in $LAB/a/session-token, mode 0600)
#   b: username + password     -> http://127.0.0.1:${LAB_PORT_B:-19229}  (user "lab", password in $LAB/b/password, 0600;
#                                 its sign-in engaged through a public URL, still bound to 127.0.0.1 only)
#   stub model (OpenAI-style)  -> http://127.0.0.1:${LAB_PORT_STUB:-19580}/v1
# Usage: tests/tools/lab-hermes.sh start|stop|status|restart a|b|copy   (restart: one backend, same home/token/port)
# Offline: every profile of the copies answers from the stub model; no provider key or credential is copied.
# Inputs (environment, all optional):
#   HERMES_LAB_SRC   lab folder holding home/ and fakehome/ (read only; never a real ~/.hermes)
#   HERMES_STUB      the stub model script (run with node, never edited)
#   HERMES_BIN       the hermes launcher (default: hermes on PATH)
#   LAB              where the private copy lives (default /tmp/vo8095-hermes-lab)
#   LAB_B_PUBLIC_URL b's HERMES_DASHBOARD_PUBLIC_URL (default http://vo-lab-b.localhost:<port b>; empty = none)
# Safety: refuses ports another Hermes or lab uses (9128 8642 8954 8977 19128 19480), refuses to start when its own
# ports are taken, never touches systemd or ~/.hermes, and stop kills only the process groups it started.
set -euo pipefail

LAB="${LAB:-/tmp/vo8095-hermes-lab}"
CWD_DIR="${LAB_CWD:-/tmp/vo8095-hermes-cwd}"   # outside any git checkout: Hermes reads AGENTS.md up to the repo root
PORT_A="${LAB_PORT_A:-19228}"
PORT_B="${LAB_PORT_B:-19229}"
PORT_STUB="${LAB_PORT_STUB:-19580}"
# (b engages Hermes' sign-in while it still listens only on 127.0.0.1, as a real Hermes started with a public URL plus
# basic auth does: Hermes turns its gate on for a non-loopback bind OR a public URL whose hostname is not localhost /
# 127.0.0.1 / ::1, so http://127.0.0.1:<port> would leave it off. A *.localhost name is not in that set and is never
# looked up: clients still dial 127.0.0.1. LAB_B_PUBLIC_URL= (empty) starts b without it.)
PUBLIC_B="${LAB_B_PUBLIC_URL-http://vo-lab-b.localhost:$PORT_B}"
FORBIDDEN="9128 8642 8954 8977 19128 19480"
# (the big caches and tool installs of the source are not needed for a chat lab and would fill a RAM-backed /tmp)
EXCLUDES=(--exclude=./tools --exclude=./cache --exclude=./installs --exclude=./attachments --exclude=./bot-desktop
          --exclude=./logs --exclude=./image_cache --exclude=./audio_cache --exclude=./backups --exclude='./*.bak*'
          --exclude='./*.lock')

die() { echo "lab-hermes: $*" >&2; exit 1; }

src_dir() {
  local s="${HERMES_LAB_SRC:-}"
  if [ -z "$s" ]; then
    local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    for c in "$here/../../../mvw-local-9094/hermes-test" "$here/../../../mvw-next-local/hermes-test"; do
      [ -d "$c/home" ] && { s="$c"; break; }
    done
  fi
  [ -n "$s" ] && [ -d "$s/home" ] && [ -d "$s/fakehome" ] || die "set HERMES_LAB_SRC to a lab folder with home/ and fakehome/"
  s="$(cd "$s" && pwd -P)"
  case "$s" in "$HOME/.hermes"|"$HOME/.hermes/"*) die "refusing a real Hermes home ($s)";; esac
  echo "$s"
}

stub_script() {
  local s="${HERMES_STUB:-}"
  if [ -z "$s" ]; then
    local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    s="$here/../../../mvw-next-local/tools-bin/oc-stub-model.mjs"
  fi
  [ -f "$s" ] || die "set HERMES_STUB to the stub model script (oc-stub-model.mjs)"
  echo "$s"
}

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

check_ports() {
  local p f
  for p in "$PORT_A" "$PORT_B" "$PORT_STUB"; do
    for f in $FORBIDDEN; do [ "$p" = "$f" ] && die "port $p belongs to another Hermes or lab; refusing"; done
  done
  [ "$PORT_A" != "$PORT_B" ] && [ "$PORT_A" != "$PORT_STUB" ] && [ "$PORT_B" != "$PORT_STUB" ] || die "ports must differ"
  for p in "$PORT_A" "$PORT_B" "$PORT_STUB"; do port_busy "$p" && die "port $p is already taken; refusing to start"; done
  return 0
}

alive() { [ -f "$LAB/$1.pid" ] && kill -0 "$(cat "$LAB/$1.pid")" 2>/dev/null; }

copy_home() {   # $1 = source lab folder, $2 = a|b
  local src="$1" dst="$LAB/$2"
  rm -rf "$dst/home" "$dst/fakehome"
  mkdir -p "$dst/home" "$dst/fakehome"
  chmod 700 "$dst"
  tar -C "$src/home" "${EXCLUDES[@]}" -cf - . | tar -C "$dst/home" -xf -
  tar -C "$src/fakehome" -cf - . | tar -C "$dst/fakehome" -xf -
  offline_home "$dst"
}

# Make a copy fully offline (only the copy is edited): the default profile and EVERY profiles/<name> answer from this
# lab's stub model, every key / token / secret / password line leaves the copied .env files, and the copied auth.json
# credential pools are emptied. A chat with any lab agent can then never reach a paid model.
offline_home() {   # $1 = $LAB/a or $LAB/b
  python3 - "$1" "$PORT_STUB" <<'PY'
import json, os, re, sys
dst, port = sys.argv[1], sys.argv[2]
home = os.path.join(dst, "home")
stub = ("model:\n  default: stub-1\n  provider: custom\n"
        f"  base_url: http://127.0.0.1:{port}/v1\n  api_key: stub-key-not-secret\n")
block = re.compile(r"^model:[^\n]*\n(?:(?:[ \t]+[^\n]*)?\n)*", re.M)
profiles = os.path.join(home, "profiles")
homes = [home] + sorted(os.path.join(profiles, p) for p in (os.listdir(profiles) if os.path.isdir(profiles) else [])
                        if os.path.isdir(os.path.join(profiles, p)))
for h in homes:
    p = os.path.join(h, "config.yaml")
    t = open(p, encoding="utf-8").read() if os.path.exists(p) else ""
    t = block.sub(lambda _m: stub, t, count=1) if block.search(t) else stub + t
    with open(p, "w", encoding="utf-8") as f:
        f.write(t)
secret = re.compile(r"^\s*(export\s+)?[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*\s*=", re.I)
for top in (home, os.path.join(dst, "fakehome")):
    for d, _dirs, files in os.walk(top):
        for name in files:
            p = os.path.join(d, name)
            if name == ".env" or name.endswith(".env"):
                with open(p, encoding="utf-8", errors="replace") as f:
                    keep = [l for l in f if not secret.match(l)]
                with open(p, "w", encoding="utf-8") as f:
                    f.writelines(keep)
            elif name == "auth.json":
                try:
                    j = json.load(open(p, encoding="utf-8"))
                except Exception:
                    j = None
                if isinstance(j, dict):
                    j["providers"] = [] if isinstance(j.get("providers"), list) else {}
                    j["credential_pool"] = {}
                    for k in [k for k in j if k not in ("version", "providers", "credential_pool", "updated_at")]:
                        j.pop(k)
                    json.dump(j, open(p, "w", encoding="utf-8"), indent=2)
                else:
                    os.remove(p)
PY
}

hermes_bin() { local b="${HERMES_BIN:-$(command -v hermes || true)}"; [ -x "$b" ] || b="$HOME/.local/bin/hermes"; [ -x "$b" ] || die "hermes not found (set HERMES_BIN)"; echo "$b"; }

wait_up() {   # $1 = port, $2 = seconds
  local i
  for ((i = 0; i < $2 * 2; i++)); do
    curl -s -m 2 -o /dev/null "http://127.0.0.1:$1/api/status" && return 0
    sleep 0.5
  done
  return 1
}

start() {
  for n in stub a b; do alive "$n" && die "the lab is already running ($n); stop it first"; done
  check_ports
  local src stub bin
  src="$(src_dir)"; stub="$(stub_script)"; bin="$(hermes_bin)"
  mkdir -p "$LAB" "$CWD_DIR"; chmod 700 "$LAB"
  echo "lab-hermes: copying the lab home (caches left out) ..."
  copy_home "$src" a
  copy_home "$src" b
  ( umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$LAB/a/session-token"
    head -c 18 /dev/urandom | base64 | tr -d '/+=\n' > "$LAB/b/password"; echo lab > "$LAB/b/username" )
  : > "$LAB/a.log"; : > "$LAB/b.log"
  cd "$CWD_DIR"
  setsid nohup env -i "PATH=/usr/bin:/bin:$HOME/.local/bin" LANG=C.UTF-8 HOME="$LAB/a/fakehome" node "$stub" \
    --port "$PORT_STUB" > "$LAB/stub.log" 2>&1 < /dev/null & echo $! > "$LAB/stub.pid"
  launch a "$bin" >/dev/null
  launch b "$bin" >/dev/null
  local ok=0
  wait_up "$PORT_A" 90 && wait_up "$PORT_B" 30 || ok=1
  status
  [ "$ok" = 0 ] || die "a backend did not answer; see $LAB/a.log and $LAB/b.log"
}

launch() {   # $1 = a|b, $2 = hermes launcher; same home, same token / password, same port (logs append)
  local base_env=(env -i "PATH=/usr/bin:/bin:$HOME/.local/bin" LANG=C.UTF-8 HOME="$LAB/$1/fakehome" HERMES_HOME="$LAB/$1/home")
  mkdir -p "$CWD_DIR"; cd "$CWD_DIR"
  if [ "$1" = a ]; then
    setsid nohup "${base_env[@]}" HERMES_DASHBOARD_SESSION_TOKEN="$(cat "$LAB/a/session-token")" \
      "$2" serve --host 127.0.0.1 --port "$PORT_A" --skip-build >> "$LAB/a.log" 2>&1 < /dev/null & echo $! > "$LAB/a.pid"
  else
    local public_b=()
    [ -n "$PUBLIC_B" ] && public_b=("HERMES_DASHBOARD_PUBLIC_URL=$PUBLIC_B")
    setsid nohup "${base_env[@]}" "${public_b[@]}" \
      HERMES_DASHBOARD_BASIC_AUTH_USERNAME=lab HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="$(cat "$LAB/b/password")" \
      "$2" serve --host 127.0.0.1 --port "$PORT_B" --skip-build >> "$LAB/b.log" 2>&1 < /dev/null & echo $! > "$LAB/b.pid"
  fi
  echo "$1"
}

kill_one() {   # $1 = a|b|stub: only the process group this script started
  local pid
  [ -f "$LAB/$1.pid" ] || return 0
  pid="$(cat "$LAB/$1.pid")"
  case "$pid" in ''|*[!0-9]*) rm -f "$LAB/$1.pid"; return 0;; esac
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
    kill -0 "$pid" 2>/dev/null && { kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
  fi
  rm -f "$LAB/$1.pid"
}

stop() {
  local n
  for n in a b stub; do
    [ -f "$LAB/$n.pid" ] || continue
    kill_one "$n"
    echo "lab-hermes: stopped $n"
  done
}

# Only make the two offline copies (nothing started): used by tests/test_hp_lab_offline.py to prove the copies.
copy_only() {
  for n in stub a b; do alive "$n" && die "the lab is running ($n); stop it first"; done
  local src; src="$(src_dir)"
  mkdir -p "$LAB"; chmod 700 "$LAB"
  copy_home "$src" a
  copy_home "$src" b
  echo "lab-hermes: copies ready in $LAB (a, b)"
}

# Restart ONE backend mid-use (e.g. to test a Hermes restart during an answer): same copied home (not copied again),
# same token / password, same port. The stub and the other backend keep running.
restart() {   # $1 = a|b
  case "${1:-}" in a|b) ;; *) die "usage: $0 restart a|b";; esac
  [ -d "$LAB/$1/home" ] || die "no lab copy for $1; run start first"
  alive stub || die "the lab is not running; run start first"
  local bin port; bin="$(hermes_bin)"
  [ "$1" = a ] && port="$PORT_A" || port="$PORT_B"
  kill_one "$1"
  for _ in $(seq 1 20); do port_busy "$port" || break; sleep 0.25; done
  port_busy "$port" && die "port $port still taken after stopping $1"
  launch "$1" "$bin" >/dev/null
  echo "lab-hermes: restarting $1 (pid $(cat "$LAB/$1.pid"))"
  wait_up "$port" 90 || die "$1 did not answer after the restart; see $LAB/$1.log"
  status
}

status() {
  local n port v
  for n in stub a b; do
    case "$n" in stub) port="$PORT_STUB";; a) port="$PORT_A";; b) port="$PORT_B";; esac
    if alive "$n"; then
      if [ "$n" = stub ]; then v="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/models" || true)"
      else v="$(curl -s -m 2 "http://127.0.0.1:$port/api/status" | python3 -c 'import json,sys
try: j=json.load(sys.stdin); print("hermes", j.get("version"), "sign-in" if j.get("auth_required") else "token")
except Exception: print("not answering yet")' 2>/dev/null || true)"; fi
      echo "lab-hermes: $n running (pid $(cat "$LAB/$n.pid"), http://127.0.0.1:$port) ${v}"
    else
      echo "lab-hermes: $n stopped"
    fi
  done
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart) restart "${2:-}" ;;
  copy) copy_only ;;
  *) echo "usage: $0 start|stop|status|restart a|b|copy" >&2; exit 2 ;;
esac
