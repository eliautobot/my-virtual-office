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
from providers.hermes import discover_api_connections

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
        config_agents = openclaw_config_agents(cfg)
    except (OSError, json.JSONDecodeError, KeyError, AttributeError, TypeError):
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

        # Get model (OpenClaw accepts "provider/model" or {"primary": ...})
        model = model_ref_primary(agent_cfg.get("model"))

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


def discover_hermes_agents(hermes_home=None, hermes_bin=None, enabled=True, api_url=None, api_key=None, desktop_url=None, desktop_token=None, desktop_host_header=None, desktop_tcp_host=None, desktop_tcp_port=None, prefer_api=True, timeout_sec=600, connections=None):
    """Discover native Hermes gateways through configured API connections.

    ``api_url``/``api_key`` remain accepted as a read-only compatibility input
    for older configuration files. Local CLI and Desktop discovery are
    intentionally not used: the Hermes runtime must stay in its own native
    environment.
    """
    configured = connections if isinstance(connections, list) else []
    if not configured and api_url:
        configured = [{"id": "default", "apiUrl": api_url, "apiKey": api_key or ""}]
    return discover_api_connections(
        configured,
        enabled=enabled,
        timeout_sec=min(int(timeout_sec or 600), 10),
    )


def discover_codex_agents(codex_home=None, codex_bin=None, workspace_root=None, enabled=True, model="", sandbox="workspace-write", approval_policy="never", prefer_app_server=None, timeout_sec=900, main_workspace=None, include_main=None, include_native_agents=None, register_native_agents=None):
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


def discover_claude_code_agents(claude_home=None, claude_bin=None, workspace_root=None, enabled=True, model="", permission_mode="acceptEdits", timeout_sec=900, main_workspace=None, include_main=None, include_native_agents=None, register_native_agents=None):
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


def discover_all_agents(oc_home, hermes_home=None, hermes_bin=None, hermes_enabled=True, hermes_api_url=None, hermes_api_key=None, hermes_desktop_url=None, hermes_desktop_token=None, hermes_desktop_host_header=None, hermes_desktop_tcp_host=None, hermes_desktop_tcp_port=None, hermes_prefer_api=True, hermes_timeout_sec=600, hermes_connections=None, codex_home=None, codex_bin=None, codex_workspace_root=None, codex_enabled=True, codex_model="", codex_sandbox="workspace-write", codex_approval_policy="never", codex_prefer_app_server=None, codex_timeout_sec=900, codex_main_workspace=None, codex_include_main=None, codex_include_native_agents=None, codex_register_native_agents=None, claude_home=None, claude_bin=None, claude_workspace_root=None, claude_enabled=True, claude_model="", claude_permission_mode="acceptEdits", claude_timeout_sec=900, claude_main_workspace=None, claude_include_main=None, claude_include_native_agents=None, claude_register_native_agents=None):
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
        connections=hermes_connections,
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
    return agents


def model_ref_primary(value):
    """Primary model id from an OpenClaw model reference (string or {primary})."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict) and isinstance(value.get("primary"), str):
        return value["primary"].strip()
    return ""


def openclaw_config_agents(cfg):
    """Agent rows from openclaw.json: 2026.9 keyed ``agents.entries`` or legacy ``agents.list``.

    For keyed entries the key is the agent id (a stale embedded ``id`` never wins).
    """
    agents_cfg = cfg.get("agents") if isinstance(cfg, dict) else None
    if not isinstance(agents_cfg, dict):
        return []
    entries = agents_cfg.get("entries")
    if isinstance(entries, dict):
        return [dict(entry, id=str(key)) for key, entry in entries.items()
                if isinstance(entry, dict) and str(key or "").strip()]
    rows = agents_cfg.get("list")
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


_DISPLAY_UNSAFE = re.compile(r"[<>\"'`\x00-\x1f\x7f]")


def clean_display_text(value, max_len=80):
    """Plain display text for names/roles/emoji read from agent-editable files."""
    text = _DISPLAY_UNSAFE.sub("", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_len].strip()


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

    # Parse markdown key-value pairs like: - **Name:** Ada
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

    return (clean_display_text(name, 60) or None,
            clean_display_text(emoji, 16) or None,
            clean_display_text(role, 80) or None)


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


# --- Hermes `hermes serve` connections: profiles = agents (design 2.10) ---
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0", "host.docker.internal", "host-gateway"}


def normalize_hermes_profiles(items):
    """Profile rows from an adapter (any of nativeId/profile/id/name) -> one shape:
    ``{profile, name, emoji, role, model, default}``. Setup profiles are dropped."""
    out = []
    seen = set()
    for item in items if isinstance(items, list) else []:
        if isinstance(item, str):
            item = {"profile": item}
        if not isinstance(item, dict):
            continue
        profile = str(item.get("nativeId") or item.get("profile") or item.get("id") or item.get("name") or "").strip()
        if not profile or profile in seen or str(item.get("role") or "").lower() == "setup" or item.get("setup") is True:
            continue
        seen.add(profile)
        name = item.get("displayName") or item.get("display_name") or item.get("label") or item.get("name") or profile
        role = item.get("role") if isinstance(item.get("role"), str) and item.get("role") else item.get("description")
        out.append({
            "profile": profile[:128],
            "name": clean_display_text(name, 60) or profile[:60],
            "emoji": clean_display_text(item.get("emoji") or "", 16),
            "role": clean_display_text(role, 80) if isinstance(role, str) else "",
            "model": str(item.get("model") or "")[:120],
            "default": bool(item.get("default") or item.get("isDefault") or profile == "default"),
        })
    return out


def _url_host(url):
    from urllib.parse import urlsplit
    try:
        return (urlsplit(str(url or "")).hostname or "").lower()
    except ValueError:
        return ""


def same_machine(url_a, url_b):
    """Both addresses are this machine (loopback / host.docker.internal), or the same host."""
    a, b = _url_host(url_a), _url_host(url_b)
    if not a or not b:
        return False
    return a == b or (a in _LOCAL_HOSTS and b in _LOCAL_HOSTS)


def legacy_profile_for(legacy_row, legacy_entry, profiles, model_id=None):
    """Which serve profile an API-server Hermes row reaches: ``legacy[L].profile``, else a
    profile named like L, else L's /v1/models first id (``hermes-agent`` = ``default``)."""
    names = {p["profile"] for p in profiles}
    entry = legacy_entry if isinstance(legacy_entry, dict) else {}
    wanted = str(entry.get("profile") or "").strip()
    if wanted:
        return wanted if wanted in names else ""
    lid = str((legacy_row or {}).get("id") or "").strip()
    if lid in names:
        return lid
    model = str(model_id or "").strip()
    if model == "hermes-agent":
        model = "default"
    return model if model in names else ""


def hermes_serve_rows(conn, profiles, profile_agents, legacy_rows, legacy_map, caps=None, status=None,
                      legacy_model_ids=None):
    """Office roster rows for one serve connection plus its listing view.

    Returns ``(rows, listing)``: ``rows`` go into discovery (hidden profiles left out),
    ``listing`` has every profile with ``hidden``/``reason`` for the Agent Providers page.
    A profile reached through an enabled, not switched API-server row stays hidden so
    the office never shows two agents for one profile."""
    cid = str(conn.get("id") or "")
    url = conn.get("url") or ""
    hidden = {}
    for row in legacy_rows or []:
        lid = str(row.get("id") or "").strip()
        entry = (legacy_map or {}).get(lid) if isinstance((legacy_map or {}).get(lid), dict) else {}
        if not lid or row.get("enabled") is False or entry.get("replacedBy"):
            continue
        if not same_machine(url, row.get("apiUrl") or row.get("url")):
            continue
        profile = legacy_profile_for(row, entry, profiles, (legacy_model_ids or {}).get(lid))
        if profile and profile not in hidden:
            hidden[profile] = f'reached through the older connection "{row.get("name") or lid}"'
    state = (status or {}).get("state") or "offline"
    available = state == "connected"
    cap_map = {name: True for name in (caps or [])}
    rows, listing = [], []
    for p in profiles:
        agent_id = (profile_agents or {}).get(p["profile"])
        if not agent_id:
            continue
        reason = hidden.get(p["profile"], "")
        listing.append({"id": agent_id, "name": p["name"], "emoji": p["emoji"], "nativeId": p["profile"],
                        "hidden": bool(reason), "reason": reason})
        if reason:
            continue
        rows.append({
            "id": agent_id, "statusKey": agent_id, "name": p["name"],
            "emoji": p["emoji"] or "⚕️", "role": p["role"] or "Hermes Agent", "model": p["model"],
            "providerKind": "hermes", "providerType": "runtime", "providerTransport": "serve",
            "transport": "hermes-serve", "providerConnectionId": cid, "providerAgentId": p["profile"],
            "profile": p["profile"], "provider": "Hermes", "gateway": "serve",
            "connectionModes": ["serve"], "capabilities": dict(cap_map),
            "available": available, "connectionState": "connected" if available else state,
            "apiAvailable": False, "cliAvailable": False, "workspace": "", "home": "",
        })
    return rows, listing


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
