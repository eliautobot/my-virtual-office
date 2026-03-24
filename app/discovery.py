"""Virtual Office — Agent Discovery Service.

Discovers agents from an OpenClaw installation by:
1. Reading openclaw.json agents.list
2. Scanning agent workspace IDENTITY.md files for display metadata
3. Checking session activity for last-active timestamps

Returns a normalized roster that the frontend can consume.
"""
import json
import os
import re
import glob
import time

def discover_agents(oc_home):
    """
    Discover all agents from an OpenClaw installation.
    
    Args:
        oc_home: Path to OpenClaw home directory (e.g. ~/.openclaw)
    
    Returns:
        list of agent dicts: [{id, name, emoji, role, model, workspace, lastActiveAt, sessionKey}, ...]
    """
    config_path = os.path.join(oc_home, "openclaw.json")
    agents_dir = os.path.join(oc_home, "agents")

    # Step 1: Read agents from openclaw.json
    config_agents = []
    try:
        with open(config_path, "r") as f:
            cfg = json.load(f)
        config_agents = cfg.get("agents", {}).get("list", [])
        if not isinstance(config_agents, list):
            config_agents = []
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass

    # Step 2: If no config, fall back to scanning agents/ directory
    if not config_agents and os.path.isdir(agents_dir):
        for d in sorted(os.listdir(agents_dir)):
            agent_path = os.path.join(agents_dir, d)
            if os.path.isdir(agent_path) and os.path.isdir(os.path.join(agent_path, "sessions")):
                config_agents.append({"id": d})

    # Step 3: Enrich each agent with workspace metadata
    roster = []
    for agent_cfg in config_agents:
        agent_id = agent_cfg.get("id", "")
        if not agent_id:
            continue

        # Determine workspace path
        workspace = agent_cfg.get("workspace", "")
        if not workspace:
            # Convention: ~/.openclaw/workspace-{id} or ~/.openclaw/workspace for main
            if agent_id == "main":
                workspace = os.path.join(oc_home, "workspace")
            else:
                workspace = os.path.join(oc_home, f"workspace-{agent_id}")

        # Read IDENTITY.md for display metadata
        name, emoji, role = _parse_identity(workspace)
        if not name:
            name = agent_id.replace("-", " ").replace("_", " ").title()
            # Special case: "main" → use a generic name
            if agent_id == "main":
                name = "Main Agent"

        # Get model
        model = agent_cfg.get("model", "")

        # Get last activity from session files
        last_active = _get_last_active(os.path.join(agents_dir, agent_id, "sessions"))

        # Build session key (statusKey used by the presence system)
        # Convention: agent id IS the status key
        status_key = agent_id

        roster.append({
            "id": agent_id,
            "statusKey": status_key,
            "name": name,
            "emoji": emoji or _generate_emoji(agent_id),
            "role": role or "",
            "model": model,
            "workspace": workspace,
            "lastActiveAt": last_active,
        })

    return roster


def _parse_identity(workspace_path):
    """Parse IDENTITY.md from an agent workspace. Returns (name, emoji, role) or (None, None, None)."""
    identity_path = os.path.join(workspace_path, "IDENTITY.md")
    name = None
    emoji = None
    role = None

    try:
        with open(identity_path, "r") as f:
            content = f.read()
    except (FileNotFoundError, PermissionError):
        return name, emoji, role

    # Parse markdown key-value pairs like: - **Name:** Moe
    for line in content.split("\n"):
        line = line.strip()
        m = re.match(r'-\s*\*\*Name:\*\*\s*(.+)', line)
        if m:
            name = m.group(1).strip()
        m = re.match(r'-\s*\*\*Emoji:\*\*\s*(.+)', line)
        if m:
            emoji = m.group(1).strip()
        m = re.match(r'-\s*\*\*Creature:\*\*\s*(.+)', line)
        if m:
            # Extract role from creature description (e.g. "AI branch manager — organized")
            creature = m.group(1).strip()
            # Take the part before em-dash if present
            role = creature.split("—")[0].strip().rstrip(" —-")

    return name, emoji, role


def _get_last_active(sessions_dir):
    """Get the most recent modification time from session JSONL files."""
    if not os.path.isdir(sessions_dir):
        return 0
    latest = 0
    try:
        for f in os.listdir(sessions_dir):
            if f.endswith(".jsonl"):
                mtime = os.path.getmtime(os.path.join(sessions_dir, f))
                if mtime > latest:
                    latest = mtime
    except (OSError, PermissionError):
        pass
    return int(latest) if latest > 0 else 0


def _generate_emoji(agent_id):
    """Generate a deterministic default emoji for an agent ID."""
    emojis = ["🤖", "🧑‍💻", "📊", "🔧", "📋", "💡", "🎯", "🔬", "📐", "🛡️", "✨", "🌟", "⚙️", "🎨", "📡"]
    idx = sum(ord(c) for c in agent_id) % len(emojis)
    return emojis[idx]


def get_agent_workspace_dir(oc_home, agent_id):
    """Get workspace directory name for an agent (relative to oc_home)."""
    if agent_id == "main":
        return "workspace"
    return f"workspace-{agent_id}"


def get_agent_session_id(agent_id):
    """Get the session folder name for an agent (in agents/ directory)."""
    return agent_id


# --- Standalone test ---
if __name__ == "__main__":
    import sys
    oc_home = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.openclaw")
    agents = discover_agents(oc_home)
    print(f"Discovered {len(agents)} agents from {oc_home}:\n")
    for a in agents:
        active_ago = ""
        if a["lastActiveAt"]:
            ago = int(time.time()) - a["lastActiveAt"]
            if ago < 60:
                active_ago = f"{ago}s ago"
            elif ago < 3600:
                active_ago = f"{ago // 60}m ago"
            else:
                active_ago = f"{ago // 3600}h ago"
        print(f"  {a['emoji']} {a['name']:12s}  id={a['id']:16s}  model={a['model'][:30]:30s}  active={active_ago}")
