#!/bin/bash
# office-sync.sh — Updates virtual office status based on session activity
# No AI, no API calls. Pure file reads. Config-driven paths.

STATUS_DIR="${VO_STATUS_DIR:-/tmp/vo-data}"
STATUS_FILE="$STATUS_DIR/virtual-office-status.json"
AGENTS_DIR="${VO_OPENCLAW_PATH:-/openclaw}/agents"
THRESHOLD_MS=90000  # 90 seconds — active if updated within this window

NOW_MS=$(($(date +%s%N) / 1000000))

if [ ! -f "$STATUS_FILE" ]; then
  exit 0
fi

if [ ! -d "$AGENTS_DIR" ]; then
  exit 0
fi

# Discover agents from the agents directory
for agent_dir in "$AGENTS_DIR"/*/; do
  agent_id=$(basename "$agent_dir")
  [ "$agent_id" = "*" ] && continue

  # Map agent ID to status key (main -> first key, others keep their id)
  if [ "$agent_id" = "main" ]; then
    # Find the main agent's statusKey from IDENTITY.md or use the first non-underscore key
    office_key=$(python3 -c "
import json
try:
    with open('$STATUS_FILE') as f:
        data = json.load(f)
    # Find key that maps to 'main' agent id
    for k in data:
        if not k.startswith('_'):
            print(k)
            break
except:
    print('main')
" 2>/dev/null)
  else
    office_key="$agent_id"
  fi

  sessions_file="$agent_dir/sessions/sessions.json"
  if [ ! -f "$sessions_file" ]; then
    continue
  fi

  max_updated=$(python3 -c "
import json
try:
    with open('$sessions_file') as f:
        data = json.load(f)
    ts = [v.get('updatedAt', 0) for v in data.values()]
    print(max(ts) if ts else 0)
except:
    print(0)
" 2>/dev/null)

  if [ -z "$max_updated" ] || [ "$max_updated" = "0" ]; then
    continue
  fi

  age_ms=$((NOW_MS - max_updated))

  if [ "$age_ms" -lt "$THRESHOLD_MS" ]; then
    new_state="working"
  else
    new_state="idle"
  fi

  python3 -c "
import json, sys
try:
    with open('$STATUS_FILE') as f:
        data = json.load(f)
except:
    sys.exit(0)

key = '$office_key'
if key not in data:
    sys.exit(0)

current = data[key].get('state', 'idle')
new = '$new_state'

if current in ('meeting', 'break', 'lounge', 'visiting'):
    sys.exit(0)

if current != new:
    data[key]['state'] = new
    if new == 'idle':
        data[key]['task'] = ''
    with open('$STATUS_FILE', 'w') as f:
        json.dump(data, f)
" 2>/dev/null
done
