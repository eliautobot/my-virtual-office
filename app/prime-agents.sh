#!/bin/bash
# Prime all discovered agents with a simple tool-call task so they have history.
# Run after any session wipe to prevent the "text instead of tool calls" issue.
# Requires 'openclaw' CLI to be available.

OPENCLAW_PATH="${VO_OPENCLAW_PATH:-/openclaw}"
AGENTS_DIR="$OPENCLAW_PATH/agents"

if [ ! -d "$AGENTS_DIR" ]; then
    echo "❌ Agents directory not found: $AGENTS_DIR"
    exit 1
fi

echo "🔧 Priming agents with tool-call history..."

for agent_dir in "$AGENTS_DIR"/*/; do
    agent=$(basename "$agent_dir")
    [ "$agent" = "*" ] && continue
    [ "$agent" = "main" ] && continue  # skip main agent
    echo "  → Priming $agent..."
    openclaw agent --agent "$agent" --message "System warmup: reply READY." --timeout 60 2>/dev/null
    echo "  ✅ $agent primed"
done

echo "🎉 All agents primed!"
