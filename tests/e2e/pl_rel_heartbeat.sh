#!/usr/bin/env bash
# 0.12.0 presence3 e2e driver: a private office + lab OpenClaw gateway whose scheduler runs main's heartbeat every minute
# (tests/tools/office-labs.sh with LAB_OC_HEARTBEAT_*), then pl_rel_heartbeat.mjs, then everything stopped.
# One process tree, for runners that end a command's children when it returns.
#   LABS_ROOT=/tmp/x LABS_PORT=<p> LABS_OC_PORT=<g> tests/e2e/pl_rel_heartbeat.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TREE="$(cd "$HERE/../.." && pwd)"
export LABS_ROOT="${LABS_ROOT:-/tmp/vo-rel-heartbeat}" LABS_PORT="${LABS_PORT:-19960}" LABS_OC_PORT="${LABS_OC_PORT:-19964}" LABS_HAPI=0
# (the lab has no owner DM: the default target "owner" skips each poll as no-route before the agent runs; none runs it)
export LAB_OC_HEARTBEAT_EVERY=1m LAB_OC_HEARTBEAT_TARGET=none LAB_OC_HEARTBEAT_PROMPT="heartbeat poll slow:4000"
trap '"$TREE/tests/tools/office-labs.sh" stop > "$LABS_ROOT/stop.log" 2>&1' EXIT
"$TREE/tests/tools/office-labs.sh" start > "$LABS_ROOT.start.log" 2>&1 || { tail -5 "$LABS_ROOT.start.log"; exit 1; }
export VO_URL="http://127.0.0.1:$LABS_PORT" LAB="$LABS_ROOT/oc" LAB_OC="$LABS_ROOT/oc" LAB_OC_PORT LAB_OC_STUB="$((LABS_OC_PORT + 1))" \
  PL_ROOT="$LABS_ROOT/office" PL_PORT="$LABS_PORT" PL_OUT="${PL_OUT:-$LABS_ROOT/out}"
node "$HERE/pl_rel_heartbeat.mjs"
