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
from providers.codex import CodexProvider
from providers.claude_code import ClaudeCodeProvider
from providers.opencode import OpenCodeProvider
from providers.antigravity import AntigravityProvider
from providers.hermes import HermesProvider, discover_api_agents, discover_desktop_agents

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


def _merge_hermes_agent_modes(cli_agents, api_agents, desktop_agents=None, prefer_api=True):
    merged = {}
    order = []
    desktop_agents = desktop_agents or []
    for agent in cli_agents:
        key = agent.get("id") or f"hermes-{agent.get('profile') or agent.get('providerAgentId') or 'default'}"
        merged[key] = dict(agent)
        order.append(key)

    for desktop_agent in desktop_agents:
        key = desktop_agent.get("id") or "hermes-default"
        if key not in merged:
            merged[key] = dict(desktop_agent)
            order.append(key)
            continue

        existing = merged[key]
        existing["desktopAvailable"] = True
        existing["desktopUrl"] = desktop_agent.get("desktopUrl") or existing.get("desktopUrl") or ""
        existing["connectionModes"] = list(dict.fromkeys((existing.get("connectionModes") or []) + (desktop_agent.get("connectionModes") or ["desktop"])))
        existing["capabilities"] = list(dict.fromkeys((existing.get("capabilities") or []) + (desktop_agent.get("capabilities") or [])))
        if not prefer_api:
            existing["gateway"] = "desktop+cli" if existing.get("cliAvailable") else "desktop"
            existing["provider"] = existing.get("provider") or desktop_agent.get("provider") or "Hermes Desktop Backend"
            existing["model"] = existing.get("model") or desktop_agent.get("model") or ""

    for api_agent in api_agents:
        key = api_agent.get("id") or "hermes-default"
        if key not in merged:
            merged[key] = dict(api_agent)
            order.append(key)
            continue

        existing = merged[key]
        existing["apiAvailable"] = True
        existing["apiUrl"] = api_agent.get("apiUrl") or existing.get("apiUrl") or ""
        existing["connectionModes"] = list(dict.fromkeys((existing.get("connectionModes") or []) + (api_agent.get("connectionModes") or ["api"])))
        existing["capabilities"] = list(dict.fromkeys((existing.get("capabilities") or []) + (api_agent.get("capabilities") or [])))
        if prefer_api:
            existing["gateway"] = "api+cli"
            existing["provider"] = existing.get("provider") or api_agent.get("provider") or "Hermes API"
            existing["model"] = api_agent.get("model") or existing.get("model") or ""
        else:
            existing["gateway"] = existing.get("gateway") or "cli+api"
            existing["model"] = existing.get("model") or api_agent.get("model") or ""

    return [merged[key] for key in order]


def discover_hermes_agents(hermes_home=None, hermes_bin=None, enabled=True, api_url=None, api_key=None, desktop_url=None, desktop_token=None, desktop_host_header=None, desktop_tcp_host=None, desktop_tcp_port=None, prefer_api=True, timeout_sec=600):
    """Discover Hermes API Server, Desktop Backend, and local CLI profiles as Virtual Office agents.

    This intentionally uses public Hermes surfaces instead of reading private
    config/auth/memory files. API discovery supports Docker-hosted Virtual
    Office with a reachable Hermes API Server. Desktop discovery uses the
    documented `hermes serve` TUI-gateway backend. CLI discovery remains
    available for mounted or container-installed Hermes profiles.
    """
    if not enabled:
        return []
    cli_agents = HermesProvider(home_path=hermes_home, binary=hermes_bin, enabled=enabled).discover_agents()
    desktop_agents = discover_desktop_agents(
        desktop_url=desktop_url,
        desktop_token=desktop_token,
        desktop_host_header=desktop_host_header,
        desktop_tcp_host=desktop_tcp_host,
        desktop_tcp_port=desktop_tcp_port,
        enabled=enabled,
        timeout_sec=min(int(timeout_sec or 600), 10),
    )
    api_agents = discover_api_agents(api_url=api_url, api_key=api_key, enabled=enabled, timeout_sec=min(int(timeout_sec or 600), 10))
    return _merge_hermes_agent_modes(cli_agents, api_agents, desktop_agents=desktop_agents, prefer_api=prefer_api)


def discover_codex_agents(codex_home=None, codex_bin=None, workspace_root=None, enabled=True, model="", sandbox="workspace-write", approval_policy="never", prefer_app_server=True, timeout_sec=900, main_workspace=None, include_main=True, include_native_agents=True, register_native_agents=True):
    """Discover local Codex CLI-backed Virtual Office agents."""
    return CodexProvider(
        home_path=codex_home,
        binary=codex_bin,
        workspace_root=workspace_root,
        enabled=enabled,
        model=model or "",
        sandbox=sandbox or "workspace-write",
        approval_policy=approval_policy or "never",
        prefer_app_server=prefer_app_server,
        timeout_sec=timeout_sec,
        main_workspace=main_workspace,
        include_main=include_main,
        include_native_agents=include_native_agents,
        register_native_agents=register_native_agents,
    ).discover_agents()


def discover_claude_code_agents(claude_home=None, claude_bin=None, workspace_root=None, enabled=True, model="", permission_mode="acceptEdits", timeout_sec=900, main_workspace=None, include_main=True, include_native_agents=True, register_native_agents=True):
    """Discover local Claude Code CLI-backed Virtual Office agents."""
    return ClaudeCodeProvider(
        home_path=claude_home,
        binary=claude_bin,
        workspace_root=workspace_root,
        enabled=enabled,
        model=model or "",
        permission_mode=permission_mode or "acceptEdits",
        timeout_sec=timeout_sec,
        main_workspace=main_workspace,
        include_main=include_main,
        include_native_agents=include_native_agents,
        register_native_agents=register_native_agents,
    ).discover_agents()


def discover_opencode_agents(opencode_home=None, opencode_bin=None, workspace_root=None, enabled=True, model="", timeout_sec=900, main_workspace=None, include_main=True, include_agents=True, register_agents=True):
    """Discover local OpenCode CLI-backed Virtual Office agents."""
    return OpenCodeProvider(
        home_path=opencode_home,
        binary=opencode_bin,
        workspace_root=workspace_root,
        enabled=enabled,
        model=model or "",
        timeout_sec=timeout_sec,
        main_workspace=main_workspace,
        include_main=include_main,
        include_agents=include_agents,
        register_agents=register_agents,
    ).discover_agents()


def discover_antigravity_agents(antigravity_home=None, antigravity_bin=None, workspace_root=None, enabled=True, timeout_sec=600, print_timeout="5m", model="", sandbox=""):

    """Discover local Antigravity (agy) CLI agent."""
    return AntigravityProvider(
        home_path=antigravity_home,
        binary=antigravity_bin,
        workspace_root=workspace_root,
        enabled=enabled,
        timeout_sec=timeout_sec,
        print_timeout=print_timeout,
        model=model or "",
        sandbox=sandbox or "",
    ).discover_agents()


def discover_all_agents(oc_home, hermes_home=None, hermes_bin=None, hermes_enabled=True, hermes_api_url=None, hermes_api_key=None, hermes_desktop_url=None, hermes_desktop_token=None, hermes_desktop_host_header=None, hermes_desktop_tcp_host=None, hermes_desktop_tcp_port=None, hermes_prefer_api=True, hermes_timeout_sec=600, codex_home=None, codex_bin=None, codex_workspace_root=None, codex_enabled=True, codex_model="", codex_sandbox="workspace-write", codex_approval_policy="never", codex_prefer_app_server=True, codex_timeout_sec=900, codex_main_workspace=None, codex_include_main=True, codex_include_native_agents=True, codex_register_native_agents=True, claude_home=None, claude_bin=None, claude_workspace_root=None, claude_enabled=True, claude_model="", claude_permission_mode="acceptEdits", claude_timeout_sec=900, claude_main_workspace=None, claude_include_main=True, claude_include_native_agents=True, claude_register_native_agents=True, opencode_home=None, opencode_bin=None, opencode_workspace_root=None, opencode_enabled=True, opencode_model="", opencode_timeout_sec=900, opencode_main_workspace=None, opencode_include_main=True, opencode_include_agents=True, opencode_register_agents=True, antigravity_home=None, antigravity_bin=None, antigravity_workspace_root=None, antigravity_enabled=True, antigravity_timeout_sec=600, antigravity_print_timeout="5m", antigravity_model="", antigravity_sandbox=""):
    """Discover OpenClaw agents plus optional local Hermes, Codex, and Claude Code agents."""
    agents = discover_agents(oc_home)
    agents.extend(discover_hermes_agents(
        hermes_home=hermes_home,
        hermes_bin=hermes_bin,
        enabled=hermes_enabled,
        api_url=hermes_api_url,
        api_key=hermes_api_key,
        desktop_url=hermes_desktop_url,
        desktop_token=hermes_desktop_token,
        desktop_host_header=hermes_desktop_host_header,
        desktop_tcp_host=hermes_desktop_tcp_host,
        desktop_tcp_port=hermes_desktop_tcp_port,
        prefer_api=hermes_prefer_api,
        timeout_sec=hermes_timeout_sec,
    ))
    agents.extend(discover_codex_agents(
        codex_home=codex_home,
        codex_bin=codex_bin,
        workspace_root=codex_workspace_root,
        enabled=codex_enabled,
        model=codex_model,
        sandbox=codex_sandbox,
        approval_policy=codex_approval_policy,
        prefer_app_server=codex_prefer_app_server,
        timeout_sec=codex_timeout_sec,
        main_workspace=codex_main_workspace,
        include_main=codex_include_main,
        include_native_agents=codex_include_native_agents,
        register_native_agents=codex_register_native_agents,
    ))
    agents.extend(discover_claude_code_agents(
        claude_home=claude_home,
        claude_bin=claude_bin,
        workspace_root=claude_workspace_root,
        enabled=claude_enabled,
        model=claude_model,
        permission_mode=claude_permission_mode,
        timeout_sec=claude_timeout_sec,
        main_workspace=claude_main_workspace,
        include_main=claude_include_main,
        include_native_agents=claude_include_native_agents,
        register_native_agents=claude_register_native_agents,
    ))
    agents.extend(discover_opencode_agents(
        opencode_home=opencode_home,
        opencode_bin=opencode_bin,
        workspace_root=opencode_workspace_root,
        enabled=opencode_enabled,
        model=opencode_model,
        timeout_sec=opencode_timeout_sec,
        main_workspace=opencode_main_workspace,
        include_main=opencode_include_main,
        include_agents=opencode_include_agents,
        register_agents=opencode_register_agents,
    ))
    agents.extend(discover_antigravity_agents(
        antigravity_home=antigravity_home,
        antigravity_bin=antigravity_bin,
        workspace_root=antigravity_workspace_root,
        enabled=antigravity_enabled,
        timeout_sec=antigravity_timeout_sec,
        print_timeout=antigravity_print_timeout,
        model=antigravity_model,
        sandbox=antigravity_sandbox,
    ))
    return agents


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
