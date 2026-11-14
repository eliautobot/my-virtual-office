#!/usr/bin/env bash
# v0.13 presence2 e2e driver: a private office + lab OpenClaw gateway (tests/tools/office-labs.sh), then
# pl_v13_restart_midrun.mjs (which restarts only that office while the lab agent is mid-run), then everything stopped.
# One process tree, for runners that end a command's children when it returns.
#   LABS_ROOT=/tmp/x LABS_PORT=<p> LABS_OC_PORT=<g> tests/e2e/pl_v13_restart_midrun.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$HERE/../.." && pwd)"
export LABS_ROOT="${LABS_ROOT:-/tmp/vo-v13-restart}" LABS_PORT="${LABS_PORT:-19960}" LABS_OC_PORT="${LABS_OC_PORT:-19964}" LABS_HAPI=0
trap '"$TREE/tests/tools/office-labs.sh" stop > "$LABS_ROOT/stop.log" 2>&1' EXIT
"$TREE/tests/tools/office-labs.sh" start > "$LABS_ROOT.start.log" 2>&1 || { tail -5 "$LABS_ROOT.start.log"; exit 1; }
export VO_URL="http://127.0.0.1:$LABS_PORT" LAB="$LABS_ROOT/oc" LAB_OC="$LABS_ROOT/oc" LAB_OC_PORT LAB_OC_STUB="$((LABS_OC_PORT + 1))" \
  PL_ROOT="$LABS_ROOT/office" PL_PORT="$LABS_PORT" PL_GATEWAY_URL="ws://127.0.0.1:$LABS_OC_PORT" \
  PL_GATEWAY_HTTP="http://127.0.0.1:$LABS_OC_PORT" PL_GATEWAY_TOKEN="$(cat "$LABS_ROOT/oc/token")" PL_OUT="${PL_OUT:-$LABS_ROOT/out}"
node "$HERE/pl_v13_restart_midrun.mjs"
