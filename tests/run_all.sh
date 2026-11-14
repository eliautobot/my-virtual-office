#!/bin/sh
# Run every offline test: pytest, the script-style checks and the node tests.
# Uses a scratch data folder; never touches a running office or ~/.openclaw.
# Live tests (test_workflow_e2e.py, test_crud_projects.sh, provider_contract_live.py)
# are not run here; they need VO_TEST_URL pointing at a disposable office.
set -u
cd "$(dirname "$0")/.."
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/vo-tests-XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/openclaw"
export VO_STATUS_DIR="$SCRATCH" VO_CONFIG="$SCRATCH/vo-config.json" VO_OPENCLAW_PATH="$SCRATCH/openclaw"
export VO_CODEX_INCLUDE_NATIVE_AGENTS=0 VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS=0
# The classic suites (and tests/legacy/) test the office on 0.10's Python OpenClaw/Hermes path; the provider layer
# (on by default since v0.11) has its own: tests/test_pl_*.{py,mjs}, tests/e2e/pl_*.mjs, LIFE_PL=1 test_life_e2e.py.
export VO_PROVIDER_LAYER="${VO_PROVIDER_LAYER:-0}"
FAILED=""

echo "== pytest"
python3 -m pytest -q tests/ -p no:cacheprovider || FAILED="$FAILED pytest"

for script in test_chat_sessions test_hermes_platform_bridge test_openclaw_managed_auth \
              test_hermes_desktop_discovery test_hermes_native_connections test_hermes_platform_plugin \
              test_review_parser; do
  echo "== $script"
  RUN_DIR=$(mktemp -d "$SCRATCH/run-XXXXXX"); mkdir -p "$RUN_DIR/openclaw"
  VO_STATUS_DIR="$RUN_DIR" VO_CONFIG="$RUN_DIR/vo-config.json" VO_OPENCLAW_PATH="$RUN_DIR/openclaw" \
    python3 "tests/$script.py" > "$RUN_DIR/out.txt" 2>&1 || { FAILED="$FAILED $script"; tail -20 "$RUN_DIR/out.txt"; }
  tail -1 "$RUN_DIR/out.txt"
done

if command -v node >/dev/null 2>&1; then
  # linkedom is needed by a few DOM tests; point NODE_PATH at any install that has it.
  for test in tests/test_*.js tests/test_*.mjs tests/test_*.cjs; do
    [ -f "$test" ] || continue
    case "$test" in *_lib.mjs|*_lib.js) continue ;; esac  # shared helpers, not tests
    echo "== $test"
    node "$test" > "$SCRATCH/node.txt" 2>&1 || { FAILED="$FAILED $test"; tail -20 "$SCRATCH/node.txt"; }
    tail -1 "$SCRATCH/node.txt"
  done
fi

if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED"
  exit 1
fi
echo "ALL TESTS PASSED"
