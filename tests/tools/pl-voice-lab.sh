#!/usr/bin/env bash
# My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
# The lab for tests/e2e/pl_voice.mjs: lab OpenClaw (19714, stub model 19715), the fake voice service (19716,
# tests/tools/fake-voice.mjs) and an office from this tree (19710/19711, tests/tools/pl-office.sh) whose vo-config names
# the fake as its Whisper server (so the layer adopts it once as the office's listening service). No real keys.
# Usage: PV_ROOT=/tmp/vo-pl-voice tests/tools/pl-voice-lab.sh start|stop
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="${PV_ROOT:-/tmp/vo-pl-voice}"
LABENV=(LAB="$S/oc" LAB_OC_PORT=19714 LAB_OC_STUB=19715)
case "${1:-}" in
  start)
    mkdir -p "$S/office/data"
    [ -f "$S/office/data/vo-config.json" ] || cat > "$S/office/data/vo-config.json" <<'JSON'
{"codex": {"enabled": false}, "claudeCode": {"enabled": false}, "openCode": {"enabled": false},
 "antigravity": {"enabled": false}, "hermes": {"enabled": true}, "officeLife": {"enabled": true},
 "features": {"whisper": true}, "whisper": {"url": "http://127.0.0.1:19716/whisper"}}
JSON
    env "${LABENV[@]}" "$HERE/lab-openclaw.sh" start
    setsid nohup node "$HERE/fake-voice.mjs" 19716 > "$S/fake-voice.log" 2>&1 < /dev/null &
    echo $! > "$S/fake-voice.pid"
    PL_ROOT="$S/office" PL_PORT=19710 PL_GATEWAY_URL=ws://127.0.0.1:19714 PL_GATEWAY_TOKEN="$(cat "$S/oc/token")" "$HERE/pl-office.sh" start ;;
  stop)
    PL_ROOT="$S/office" PL_PORT=19710 "$HERE/pl-office.sh" stop || true
    [ -f "$S/fake-voice.pid" ] && kill "$(cat "$S/fake-voice.pid")" 2>/dev/null || true
    rm -f "$S/fake-voice.pid"
    env "${LABENV[@]}" "$HERE/lab-openclaw.sh" stop || true ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
