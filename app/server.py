#!/usr/bin/env python3
"""Virtual Office server.
Serves static files, status JSON, and proxies WebSocket to the OpenClaw gateway.
"""
import asyncio
import http.server
import json
import os
import threading
import websockets
from websockets.asyncio.client import connect as ws_connect
import glob
import re as re_module
import gateway_presence


# ─── CONFIGURATION ───────────────────────────────────────────────
def _env_or(key, fallback):
    """Return env var value if set and non-empty, else fallback."""
    val = os.environ.get(key)
    return val if val else fallback

def _resolve_config_path():
    """Return path to vo-config.json — prefers /data/ (persistent volume) over /app/ (container layer)."""
    if os.environ.get("VO_CONFIG"):
        return os.environ["VO_CONFIG"]
    data_cfg = os.path.join(os.environ.get("VO_STATUS_DIR", "/data"), "vo-config.json")
    app_cfg = os.path.join(os.path.dirname(__file__), "vo-config.json")
    # Prefer data volume config (survives container recreation)
    if os.path.isfile(data_cfg):
        return data_cfg
    # Migrate: if app config exists and has been customized, copy to data volume
    if os.path.isfile(app_cfg):
        try:
            with open(app_cfg, "r") as f:
                app_data = json.load(f)
            if app_data.get("_setupComplete"):
                os.makedirs(os.path.dirname(data_cfg), exist_ok=True)
                with open(data_cfg, "w") as f:
                    json.dump(app_data, f, indent=2)
                return data_cfg
        except (json.JSONDecodeError, OSError):
            pass
    # Fall back to app-bundled default
    return app_cfg

def _load_vo_config():
    """Load vo-config.json with env-var overrides. Returns merged dict."""
    cfg_path = _resolve_config_path()
    cfg = {}
    try:
        with open(cfg_path, "r") as f:
            cfg = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # Auto-detect OpenClaw home — check env, config, then common paths
    oc_home = (
        os.environ.get("VO_OPENCLAW_PATH")
        or (cfg.get("openclaw") or {}).get("homePath")
    )
    if not oc_home:
        # Search common locations
        candidates = [
            os.path.expanduser("~/.openclaw"),
            "/openclaw",  # Docker mount convention
            "/root/.openclaw",  # common root install
        ]
        for c in candidates:
            if os.path.isdir(c) and (os.path.isfile(os.path.join(c, "openclaw.json")) or os.path.isdir(os.path.join(c, "agents"))):
                oc_home = c
                break
        if not oc_home:
            oc_home = os.path.expanduser("~/.openclaw")

    office = cfg.get("office") or {}
    openclaw = cfg.get("openclaw") or {}
    presence = cfg.get("presence") or {}
    features = cfg.get("features") or {}
    pc_metrics = cfg.get("pcMetrics") or {}
    whisper_cfg = cfg.get("whisper") or {}
    browser_cfg = cfg.get("browser") or {}
    weather_cfg = cfg.get("weather") or {}
    sms_cfg = cfg.get("sms") or {}

    return {
        "office": {
            "name": _env_or("VO_OFFICE_NAME", office.get("name", "Virtual Office")),
            "port": int(_env_or("VO_PORT", office.get("port", 8090))),
            "wsPort": int(_env_or("VO_WS_PORT", office.get("wsPort", 8091))),
        },
        "openclaw": {
            "homePath": oc_home,
            "gatewayUrl": _env_or("VO_GATEWAY_URL", openclaw.get("gatewayUrl", "ws://127.0.0.1:18789")),
            "gatewayHttp": _env_or("VO_GATEWAY_HTTP", openclaw.get("gatewayHttp", "http://127.0.0.1:18789")),
        },
        "presence": {
            "statusDir": _env_or("VO_STATUS_DIR", presence.get("statusDir", "/tmp/vo-data")),
            "inferenceEnabled": presence.get("inferenceEnabled", True),
            "inferenceIdleTimeoutSec": presence.get("inferenceIdleTimeoutSec", 300),
        },
        "features": {
            "pcMetrics": features.get("pcMetrics", False),
            "smsPanel": features.get("smsPanel", False),
            "browserPanel": features.get("browserPanel", False),
            "whisper": features.get("whisper", False),
            "apiUsage": features.get("apiUsage", True),
        },
        "pcMetrics": {
            "url": _env_or("VO_PC_METRICS_URL", pc_metrics.get("url")),
        },
        "whisper": {
            "url": _env_or("VO_WHISPER_URL", whisper_cfg.get("url", "http://127.0.0.1:8087")),
        },
        "browser": {
            "cdpUrl": _env_or("VO_CDP_URL", browser_cfg.get("cdpUrl")),
            "viewerUrl": _env_or("VO_VIEWER_URL", browser_cfg.get("viewerUrl")),
        },
        "weather": {
            "location": _env_or("VO_WEATHER_LOCATION", weather_cfg.get("location")),
        },
        "sms": {
            "agentId": _env_or("VO_SMS_AGENT_ID", sms_cfg.get("agentId")),
            "twilioAccountSid": _env_or("VO_TWILIO_ACCOUNT_SID", sms_cfg.get("twilioAccountSid")),
            "twilioAuthToken": _env_or("VO_TWILIO_AUTH_TOKEN", sms_cfg.get("twilioAuthToken")),
            "fromNumber": _env_or("VO_TWILIO_FROM_NUMBER", sms_cfg.get("fromNumber")),
        },
    }

VO_CONFIG = _load_vo_config()

PORT = VO_CONFIG["office"]["port"]
WS_PORT = VO_CONFIG["office"]["wsPort"]
WORKSPACE_BASE = VO_CONFIG["openclaw"]["homePath"]
STATUS_DIR = VO_CONFIG["presence"]["statusDir"]
os.makedirs(STATUS_DIR, exist_ok=True)
STATUS_FILE = os.path.join(STATUS_DIR, "virtual-office-status.json")
PROJECTS_FILE = os.path.join(STATUS_DIR, "projects.json")
AUTH_PROFILES_PATH = os.path.join(WORKSPACE_BASE, "agents/main/agent/auth-profiles.json")

# ─── DYNAMIC AGENT DISCOVERY ─────────────────────────────────
from discovery import discover_agents, get_agent_workspace_dir, get_agent_session_id
from license import get_license_status, activate_license, deactivate_license, check_feature, get_agent_limit

_discovered_roster = discover_agents(WORKSPACE_BASE)
_discovered_at = time.time() if 'time' in dir() else 0
import time as _time_mod
_discovered_at = _time_mod.time()
DISCOVERY_REFRESH_SEC = 300  # re-discover every 5 min

def _refresh_discovery():
    """Refresh agent roster if stale."""
    global _discovered_roster, _discovered_at
    if _time_mod.time() - _discovered_at > DISCOVERY_REFRESH_SEC:
        _discovered_roster = discover_agents(WORKSPACE_BASE)
        _discovered_at = _time_mod.time()

def get_roster():
    """Get current discovered agent roster."""
    _refresh_discovery()
    return _discovered_roster

# Build compatibility maps from discovery (these update on refresh)
def _build_agent_info():
    return {a["statusKey"]: {"id": a["id"], "emoji": a["emoji"], "name": a["name"], "branch": ""} for a in get_roster()}
def _build_agent_workspaces():
    return {a["statusKey"]: get_agent_workspace_dir(WORKSPACE_BASE, a["id"]).replace(WORKSPACE_BASE + "/", "") if a["workspace"].startswith(WORKSPACE_BASE) else os.path.basename(a["workspace"]) for a in get_roster()}
def _build_agent_session_ids():
    return {a["statusKey"]: get_agent_session_id(a["id"]) for a in get_roster()}

# Compatibility properties (lazily rebuilt)
@property
def _agent_info_prop(self):
    return _build_agent_info()

# For now, build once and provide as module-level (callers use these directly)
AGENT_INFO = _build_agent_info()
AGENT_WORKSPACES = _build_agent_workspaces()
AGENT_SESSION_IDS = _build_agent_session_ids()

def _patch_default_config_agents(config_str):
    """Replace hardcoded agents in default config with actual roster agents.
    Returns JSON string with agents patched from the live discovery roster."""
    try:
        cfg = json.loads(config_str)
    except Exception:
        return config_str
    roster = get_roster()
    if not roster:
        return config_str
    # Build agent entries from roster with random/seeded appearances
    import hashlib
    patched_agents = []
    for a in roster:
        agent_id = a.get("statusKey") or a.get("id", "main")
        name = a.get("name") or agent_id
        # Seed a deterministic hash for random appearance
        h = int(hashlib.md5(agent_id.encode()).hexdigest(), 16)
        skin_tones = ['#ffcc80','#d4a574','#c68642','#e8b88a','#fddcb5','#f5d0b0','#8d5524']
        hair_styles = ['short','medium','long','curly','spiky','buzz','wavy']
        hair_colors = ['#1a1a1a','#333333','#5d4037','#616161','#bf360c','#dcc282','#ffd700','#263238']
        desk_items = ['trophy','envelope','calendar','chart','plans','checklist','files','ruler','money','marker']
        gender = 'F' if (h >> 2) % 2 == 0 else 'M'
        patched_agents.append({
            "id": agent_id,
            "name": name,
            "role": a.get("role", "AI assistant"),
            "emoji": a.get("emoji", "🤖"),
            "color": _AGENT_COLORS_LIST[len(patched_agents) % len(_AGENT_COLORS_LIST)] if len(patched_agents) < len(_AGENT_COLORS_LIST) else '#607d8b',
            "gender": gender,
            "branch": "UNASSIGNED",
            "statusKey": agent_id,
            "appearance": {
                "skinTone": skin_tones[h % len(skin_tones)],
                "hairStyle": hair_styles[(h >> 3) % len(hair_styles)] if gender == 'M' else hair_styles[(h >> 3) % 3 + 2],
                "hairColor": hair_colors[(h >> 5) % len(hair_colors)],
                "hairHighlight": None,
                "eyebrowStyle": "thin" if gender == 'F' else "thick",
                "eyeColor": "#212121",
                "facialHair": None, "facialHairColor": None,
                "headwear": None, "headwearColor": None,
                "glasses": None, "glassesColor": None,
                "costume": None,
                "heldItem": None,
                "deskItem": desk_items[(h >> 8) % len(desk_items)]
            }
        })
    cfg["agents"] = patched_agents
    return json.dumps(cfg)

# Color palette used for default config agent patching
_AGENT_COLORS_LIST = ['#ffd700','#d32f2f','#1976d2','#388e3c','#f9a825','#e65100','#00897b','#7b1fa2','#6d4c41','#5c6bc0','#78909c','#4caf50','#00bcd4','#e91e90','#ff6d00','#795548','#607d8b','#9c27b0','#009688','#ff5722']

def refresh_agent_maps():
    """Call after discovery refresh to update compatibility maps."""
    global AGENT_INFO, AGENT_WORKSPACES, AGENT_SESSION_IDS
    AGENT_INFO = _build_agent_info()
    AGENT_WORKSPACES = _build_agent_workspaces()
    AGENT_SESSION_IDS = _build_agent_session_ids()

##############################################################################
# AGENT CREATION + SKILLS MANAGEMENT
##############################################################################

def _sanitize_agent_id(name):
    """Convert a display name into a safe agent ID."""
    import re
    s = name.lower().strip()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s]+', '-', s)
    s = re.sub(r'-+', '-', s).strip('-')
    return s or f"agent-{int(time.time())}"

def _handle_agent_create(body):
    """Create a new OpenClaw agent from the VO app."""
    name = (body.get("name") or "").strip()
    if not name:
        return {"error": "Agent name is required", "_status": 400}

    agent_id = body.get("id") or _sanitize_agent_id(name)
    emoji = body.get("emoji", "🤖")
    role = body.get("role", "AI assistant")
    model = body.get("model", "")

    # Check if agent already exists
    agent_dir = os.path.join(WORKSPACE_BASE, f"agents/{agent_id}")
    if os.path.exists(agent_dir):
        return {"error": f"Agent '{agent_id}' already exists", "_status": 409}

    workspace_dir = os.path.join(WORKSPACE_BASE, f"workspace-{agent_id}")

    try:
        # 1. Create agent directory structure
        os.makedirs(os.path.join(agent_dir, "sessions"), exist_ok=True)
        # Write empty agent marker
        with open(os.path.join(agent_dir, "agent"), "w") as f:
            pass
        # Write empty sessions.json
        with open(os.path.join(agent_dir, "sessions", "sessions.json"), "w") as f:
            json.dump({}, f)
        # Write MEMORY.md in agent dir
        with open(os.path.join(agent_dir, "MEMORY.md"), "w") as f:
            f.write(f"# MEMORY.md - {name}\n\n_No memories yet._\n")

        # 2. Create workspace with template files
        os.makedirs(os.path.join(workspace_dir, "memory"), exist_ok=True)
        os.makedirs(os.path.join(workspace_dir, "skills"), exist_ok=True)

        _write_template(workspace_dir, "IDENTITY.md", f"""# IDENTITY.md

- **Name:** {name}
- **Creature:** AI assistant
- **Vibe:** Helpful, efficient, ready to work
- **Emoji:** {emoji}
""")
        _write_template(workspace_dir, "SOUL.md", f"""# SOUL.md — {name}

You are **{name}** {emoji} — {role}.

## Style
- Be helpful and direct
- Follow your AGENTS.md workflow strictly
- Always set working status before starting and idle when done

## Tool-First Rule
You ALWAYS start with tool calls before responding with text. Every task requires ALL workflow steps in AGENTS.md — no exceptions.
""")
        _write_template(workspace_dir, "USER.md", """# USER.md

- **Name:** (set by your owner)
- **Timezone:** (set by your owner)
- **Notes:** Prefers direct, clear communication.
""")
        _write_template(workspace_dir, "AGENTS.md", f"""# {name} {emoji} — {role}

## Role
{role}

## Core Rules
- Follow instructions carefully
- Log your work in memory/YYYY-MM-DD.md
- Always complete the full loop: working → work → report → idle

## Communication
- Use `sessions_send` to reach other agents
- Your text reply IS your response — write it directly

## Memory
- Daily logs: `memory/YYYY-MM-DD.md`
- Long-term: `MEMORY.md`
""")
        _write_template(workspace_dir, "HEARTBEAT.md", """# HEARTBEAT.md

# Add periodic tasks below. If nothing needs attention, reply HEARTBEAT_OK.
""")
        _write_template(workspace_dir, "MEMORY.md", f"# MEMORY.md - {name}\n\n_No memories yet._\n")
        _write_template(workspace_dir, "TOOLS.md", f"# TOOLS.md — {name}\n\n_Add tool-specific notes here._\n")

        # 3. Add agent to openclaw.json
        config_path = os.path.join(WORKSPACE_BASE, "openclaw.json")
        with open(config_path, "r") as f:
            config = json.load(f)

        # Get defaults for model and memorySearch
        defaults = config.get("agents", {}).get("defaults", {})
        default_model = model or defaults.get("model", {}).get("primary", "anthropic/claude-sonnet-4-6")
        default_memory = defaults.get("memorySearch", {})

        new_agent_entry = {
            "id": agent_id,
            "workspace": workspace_dir,
            "model": default_model,
            "tools": {
                "allow": [
                    "group:sessions",
                    "group:fs",
                    "group:runtime",
                    "group:web",
                    "group:memory",
                    "message",
                    "tts"
                ]
            },
        }
        # Add memorySearch if configured in defaults
        if default_memory:
            new_agent_entry["memorySearch"] = default_memory

        agent_list = config.get("agents", {}).get("list", [])
        agent_list.append(new_agent_entry)
        config["agents"]["list"] = agent_list

        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)

        # 4. Signal gateway to reload
        _signal_gateway_reload()

        # 5. Refresh discovery
        global _discovered_at
        _discovered_at = 0
        refresh_agent_maps()

        return {
            "ok": True,
            "agentId": agent_id,
            "name": name,
            "workspace": workspace_dir,
            "message": f"Agent '{name}' ({agent_id}) created successfully"
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": str(e), "_status": 500}


def _write_template(workspace_dir, filename, content):
    """Write a template file to a workspace."""
    with open(os.path.join(workspace_dir, filename), "w") as f:
        f.write(content)


def _signal_gateway_reload():
    """Send SIGUSR1 to the OpenClaw gateway process to reload config."""
    import signal
    try:
        # Find gateway PID from proc
        for pid_dir in os.listdir("/proc"):
            if not pid_dir.isdigit():
                continue
            try:
                with open(f"/proc/{pid_dir}/cmdline", "r") as f:
                    cmdline = f.read()
                if "openclaw" in cmdline and "gateway" in cmdline:
                    os.kill(int(pid_dir), signal.SIGUSR1)
                    return True
            except (PermissionError, FileNotFoundError, ProcessLookupError):
                continue
        # Fallback: try common PID file locations
        for pidfile in ["/tmp/openclaw-gateway.pid", os.path.join(WORKSPACE_BASE, "gateway.pid")]:
            if os.path.exists(pidfile):
                with open(pidfile) as f:
                    pid = int(f.read().strip())
                os.kill(pid, signal.SIGUSR1)
                return True
    except Exception as e:
        print(f"⚠️  Could not signal gateway reload: {e}")
    return False


def _handle_skill_list(agent_key):
    """List skills for an agent."""
    refresh_agent_maps()
    ws_dir = AGENT_WORKSPACES.get(agent_key)
    if not ws_dir:
        return {"error": "Agent not found", "_status": 404}
    ws_path = os.path.join(WORKSPACE_BASE, ws_dir)
    skills_dir = os.path.join(ws_path, "skills")
    if not os.path.isdir(skills_dir):
        return {"skills": []}
    skills = []
    for entry in sorted(os.listdir(skills_dir)):
        skill_path = os.path.join(skills_dir, entry)
        # Skill can be a folder with SKILL.md or a single .md file
        if os.path.isdir(skill_path):
            skill_md = os.path.join(skill_path, "SKILL.md")
            if os.path.exists(skill_md):
                desc = _extract_skill_description(skill_md)
                try:
                    with open(skill_md, "r") as f:
                        content = f.read()
                except Exception:
                    content = ""
                skills.append({"name": entry, "type": "folder", "description": desc, "content": content})
        elif entry.endswith(".md"):
            desc = _extract_skill_description(skill_path)
            try:
                with open(skill_path, "r") as f:
                    content = f.read()
            except Exception:
                content = ""
            skills.append({"name": entry.replace(".md", ""), "type": "file", "description": desc, "content": content})
    return {"skills": skills}


def _extract_skill_description(filepath):
    """Extract first meaningful line from a skill file as description."""
    try:
        with open(filepath, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and not line.startswith("---") and not line.startswith("name:"):
                    return line[:200]
    except Exception:
        pass
    return ""


def _handle_skill_write(agent_key, skill_name, body):
    """Create or update a skill for an agent."""
    refresh_agent_maps()
    ws_dir = AGENT_WORKSPACES.get(agent_key)
    if not ws_dir:
        return {"error": "Agent not found", "_status": 404}
    ws_path = os.path.join(WORKSPACE_BASE, ws_dir)
    skills_dir = os.path.join(ws_path, "skills")
    os.makedirs(skills_dir, exist_ok=True)

    name = body.get("name", skill_name or "").strip()
    content = body.get("content", "")
    if not name:
        return {"error": "Skill name is required", "_status": 400}

    # Sanitize name
    import re
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '-', name).strip('-')
    if not safe_name:
        return {"error": "Invalid skill name", "_status": 400}

    # Create skill as a folder with SKILL.md
    skill_dir = os.path.join(skills_dir, safe_name)
    os.makedirs(skill_dir, exist_ok=True)
    skill_file = os.path.join(skill_dir, "SKILL.md")

    if not content:
        content = f"# {name}\n\n_Describe this skill's instructions here._\n"

    with open(skill_file, "w") as f:
        f.write(content)

    return {"ok": True, "skill": safe_name, "path": skill_file}


# ─── SKILLS LIBRARY HANDLERS ─────────────────────────────────────

def _get_skills_library_dir():
    """Return path to the central skills library (master copies, not agent-specific)."""
    home = VO_CONFIG.get("openclaw", {}).get("homePath", os.path.expanduser("~/.openclaw"))
    d = os.path.join(home, "skills-library")
    os.makedirs(d, exist_ok=True)
    return d


def _parse_skill_frontmatter(content):
    """Parse YAML-like frontmatter from SKILL.md content."""
    name = ""
    description = ""
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            for line in parts[1].strip().splitlines():
                line = line.strip()
                if line.startswith("name:"):
                    name = line[5:].strip().strip("'\"")
                elif line.startswith("description:"):
                    description = line[12:].strip().strip("'\"")
    return name, description


def _handle_skills_library_list():
    """GET /api/skills-library — list all library skills."""
    lib_dir = _get_skills_library_dir()
    skills = []
    for entry in sorted(os.listdir(lib_dir)):
        skill_dir = os.path.join(lib_dir, entry)
        if not os.path.isdir(skill_dir):
            continue
        skill_md = os.path.join(skill_dir, "SKILL.md")
        if not os.path.isfile(skill_md):
            continue
        try:
            with open(skill_md, "r") as f:
                content = f.read()
        except Exception:
            content = ""
        name, description = _parse_skill_frontmatter(content)
        if not name:
            name = entry
        if not description:
            description = _extract_skill_description(skill_md)
        skills.append({"name": entry, "description": description, "path": skill_md})
    return {"skills": skills}


def _handle_skills_library_get(skill_name):
    """GET /api/skills-library/<name> — read a specific library skill."""
    lib_dir = _get_skills_library_dir()
    skill_md = os.path.join(lib_dir, skill_name, "SKILL.md")
    if not os.path.isfile(skill_md):
        return {"error": f"Skill '{skill_name}' not found in library", "_status": 404}
    try:
        with open(skill_md, "r") as f:
            content = f.read()
    except Exception as e:
        return {"error": str(e), "_status": 500}
    name, description = _parse_skill_frontmatter(content)
    if not name:
        name = skill_name
    return {"name": name, "description": description, "content": content}


def _handle_skills_library_create(body):
    """POST /api/skills-library — create or update a library skill."""
    import re
    name = body.get("name", "").strip()
    content = body.get("content", "")
    if not name:
        return {"error": "name is required", "_status": 400}
    slug = re.sub(r'[^a-zA-Z0-9_-]', '-', name).strip('-').lower()
    if not slug:
        return {"error": "Invalid skill name", "_status": 400}
    lib_dir = _get_skills_library_dir()
    skill_dir = os.path.join(lib_dir, slug)
    os.makedirs(skill_dir, exist_ok=True)
    skill_file = os.path.join(skill_dir, "SKILL.md")
    if not content:
        content = f"---\nname: {slug}\ndescription: \n---\n\n# {name}\n\n_Describe this skill here._\n"
    with open(skill_file, "w") as f:
        f.write(content)
    parsed_name, description = _parse_skill_frontmatter(content)
    return {"ok": True, "skill": slug, "name": parsed_name or slug, "description": description, "path": skill_file}


def _handle_skills_library_delete(skill_name):
    """DELETE /api/skills-library/<name> — delete a library skill."""
    import shutil
    lib_dir = _get_skills_library_dir()
    skill_dir = os.path.join(lib_dir, skill_name)
    if not os.path.isdir(skill_dir):
        return {"error": f"Skill '{skill_name}' not found in library", "_status": 404}
    shutil.rmtree(skill_dir)
    return {"ok": True, "deleted": skill_name}


def _handle_skills_library_apply(body):
    """POST /api/skills-library/apply — copy library skill to agent workspace."""
    skill_name = body.get("skill", "").strip()
    agent_id = body.get("agentId", "").strip()
    overwrite = body.get("overwrite", False)
    if not skill_name:
        return {"error": "skill name is required", "_status": 400}
    if not agent_id:
        return {"error": "agentId is required", "_status": 400}
    # Check library skill exists
    lib_dir = _get_skills_library_dir()
    src_file = os.path.join(lib_dir, skill_name, "SKILL.md")
    if not os.path.isfile(src_file):
        return {"error": f"Skill '{skill_name}' not found in library", "_status": 404}
    # Find agent workspace
    refresh_agent_maps()
    ws_dir = AGENT_WORKSPACES.get(agent_id)
    if not ws_dir:
        return {"error": f"Agent '{agent_id}' not found", "_status": 404}
    ws_path = os.path.join(WORKSPACE_BASE, ws_dir)
    dest_dir = os.path.join(ws_path, "skills", skill_name)
    dest_file = os.path.join(dest_dir, "SKILL.md")
    if os.path.isfile(dest_file) and not overwrite:
        return {"ok": False, "warning": f"Agent '{agent_id}' already has skill '{skill_name}'. Set overwrite=true to replace.", "exists": True}
    os.makedirs(dest_dir, exist_ok=True)
    import shutil
    shutil.copy2(src_file, dest_file)
    return {"ok": True, "skill": skill_name, "agentId": agent_id, "path": dest_file, "overwritten": os.path.isfile(dest_file) and overwrite}


def _handle_skills_library_upload(body):
    """POST /api/skills-library/upload — upload a SKILL.md to library."""
    import base64
    import re
    filename = body.get("filename", "").strip()
    content_b64 = body.get("content", "")
    if not content_b64:
        return {"error": "content is required (base64)", "_status": 400}
    try:
        content = base64.b64decode(content_b64).decode("utf-8")
    except Exception:
        content = content_b64  # allow plain text too
    # Extract name from frontmatter or filename
    name, description = _parse_skill_frontmatter(content)
    if not name and filename:
        name = filename.replace(".md", "").replace("SKILL", "").strip("-_ ")
    if not name:
        name = "uploaded-skill"
    slug = re.sub(r'[^a-zA-Z0-9_-]', '-', name).strip('-').lower()
    if not slug:
        slug = "uploaded-skill"
    lib_dir = _get_skills_library_dir()
    skill_dir = os.path.join(lib_dir, slug)
    os.makedirs(skill_dir, exist_ok=True)
    with open(os.path.join(skill_dir, "SKILL.md"), "w") as f:
        f.write(content)
    return {"ok": True, "skill": slug, "name": name, "description": description}


def _handle_skill_delete(agent_key, skill_name):
    """Delete a skill from an agent."""
    refresh_agent_maps()
    ws_dir = AGENT_WORKSPACES.get(agent_key)
    if not ws_dir:
        return {"error": "Agent not found", "_status": 404}
    ws_path = os.path.join(WORKSPACE_BASE, ws_dir)
    skills_dir = os.path.join(ws_path, "skills")

    if not skill_name:
        return {"error": "Skill name is required", "_status": 400}

    # Try folder first, then file
    skill_folder = os.path.join(skills_dir, skill_name)
    skill_file = os.path.join(skills_dir, f"{skill_name}.md")

    import shutil
    if os.path.isdir(skill_folder):
        shutil.rmtree(skill_folder)
        return {"ok": True, "deleted": skill_name}
    elif os.path.isfile(skill_file):
        os.remove(skill_file)
        return {"ok": True, "deleted": skill_name}
    else:
        return {"error": f"Skill '{skill_name}' not found", "_status": 404}


def _load_meetings_file():
    """Load the persistent meetings/status file."""
    try:
        with open(STATUS_FILE, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        return {}


def _save_meetings_file(data):
    """Persist the meetings/status file with permissive mode for shared runtimes."""
    os.makedirs(os.path.dirname(STATUS_FILE), exist_ok=True)
    with open(STATUS_FILE, "w") as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(STATUS_FILE, 0o666)
    except Exception:
        pass


def _handle_meeting_create(body):
    """Create/update a meeting in the canonical server-side status file."""
    topic = (body.get("topic") or "").strip()
    meet_id = (body.get("id") or "").strip()
    if not meet_id:
        import uuid
        meet_id = str(uuid.uuid4())[:8]
    meet_type = (body.get("type") or "").strip()
    agents = body.get("agents") or body.get("participants") or []
    organizer = (body.get("organizer") or "").strip()
    purpose = (body.get("purpose") or body.get("topic") or "").strip()
    kind = (body.get("kind") or "discussion").strip() or "discussion"

    if not topic:
        return {"error": "Meeting topic is required", "_status": 400}
    if not isinstance(agents, list) or len(agents) < 2:
        return {"error": "Meeting requires at least 2 agents", "_status": 400}

    clean_agents = [str(a).strip() for a in agents if str(a).strip()]
    if len(clean_agents) < 2:
        return {"error": "Meeting requires at least 2 valid agent keys", "_status": 400}

    if not organizer:
        organizer = clean_agents[0]

    if meet_type not in ("1on1", "group"):
        meet_type = "1on1" if len(clean_agents) == 2 else "group"

    data = _load_meetings_file()
    meetings = data.get("_meetings", [])
    if not isinstance(meetings, list):
        meetings = []
    meetings = [m for m in meetings if m.get("id") != meet_id]
    meeting = {
        "id": meet_id,
        "topic": topic,
        "purpose": purpose,
        "kind": kind,
        "type": meet_type,
        "organizer": organizer,
        "status": "active",
        "participants": clean_agents,
        "agents": clean_agents,
        "rules": {
            "mode": "discussion-not-work",
            "endWhen": "purpose-complete",
            "resumeStateAfterEnd": "working-or-idle"
        }
    }
    meetings.append(meeting)
    data["_meetings"] = meetings
    _save_meetings_file(data)
    gateway_presence.set_meetings(meetings)
    return {"ok": True, "meeting": meeting}


def _handle_meeting_end(body):
    """End one meeting by id. Requires a summary from the organizer."""
    meet_id = (body.get("id") or body.get("meetingId") or "").strip()
    if not meet_id:
        return {"error": "Meeting id is required", "_status": 400}

    summary = (body.get("summary") or "").strip()
    resolution = (body.get("resolution") or "").strip()
    ended_by = (body.get("endedBy") or body.get("organizer") or "").strip()
    action_items = body.get("actionItems") or []
    responses = body.get("responses") or {}  # {agentKey: "what they said"}

    if not summary:
        return {"error": "A meeting summary is required to end the meeting", "_status": 400}

    data = _load_meetings_file()
    meetings = data.get("_meetings", [])
    if not isinstance(meetings, list):
        meetings = []

    # Find the meeting being ended
    ended_meeting = None
    for m in meetings:
        if m.get("id") == meet_id:
            ended_meeting = dict(m)
            break

    if not ended_meeting:
        return {"error": f"Meeting '{meet_id}' not found", "_status": 404}

    # Build completed meeting record
    import time as _time_end
    completed = dict(ended_meeting)
    completed["status"] = "completed"
    completed["endedBy"] = ended_by or completed.get("organizer", "unknown")
    completed["summary"] = summary
    completed["resolution"] = resolution
    completed["actionItems"] = action_items if isinstance(action_items, list) else []
    completed["responses"] = responses if isinstance(responses, dict) else {}
    completed["endedAt"] = int(_time_end.time())

    # Remove from active meetings
    meetings = [m for m in meetings if m.get("id") != meet_id]
    data["_meetings"] = meetings

    # Store in meeting history
    history = data.get("_meetingHistory", [])
    if not isinstance(history, list):
        history = []
    history.append(completed)
    # Keep last 50 meetings in history
    if len(history) > 50:
        history = history[-50:]
    data["_meetingHistory"] = history

    _save_meetings_file(data)
    gateway_presence.set_meetings(meetings)
    return {"ok": True, "id": meet_id, "completed": completed}


def _handle_meeting_end_all():
    """End all meetings. Requires summaries per meeting or a bulk summary."""
    data = _load_meetings_file()
    data["_meetings"] = []
    _save_meetings_file(data)
    gateway_presence.set_meetings([])
    return {"ok": True}


def _handle_meeting_history_delete(meet_id):
    """Delete a completed meeting from history."""
    if not meet_id:
        return {"error": "Meeting id is required", "_status": 400}
    data = _load_meetings_file()
    history = data.get("_meetingHistory", [])
    if not isinstance(history, list):
        history = []
    before = len(history)
    history = [m for m in history if m.get("id") != meet_id]
    data["_meetingHistory"] = history
    _save_meetings_file(data)
    return {"ok": True, "removed": len(history) < before, "id": meet_id}


##############################################################################
# ─── PROJECTS SCORING / GAMIFICATION ─────────────────────────────────────────
SCORES_FILE = os.path.join(STATUS_DIR, "project-scores.json")

def _load_scores():
    """Load project-scores.json. Format: { "agents": { "agent-key": { "score": N, "completed": N, "streak": N, "lastCompleted": "ISO" } } }"""
    try:
        with open(SCORES_FILE, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
        if "agents" not in data:
            data["agents"] = {}
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return {"agents": {}}

def _save_scores(data):
    """Persist project-scores.json."""
    os.makedirs(os.path.dirname(SCORES_FILE), exist_ok=True)
    with open(SCORES_FILE, "w") as f:
        json.dump(data, f, indent=2)

def _award_points(agent_key, points, reason="task_completed"):
    """Award points to an agent and update streak."""
    if not agent_key or agent_key in ("null", "None", "unassigned", ""):
        return None
    data = _load_scores()
    agent = data["agents"].get(agent_key, {"score": 0, "completed": 0, "streak": 0, "lastCompleted": None, "history": []})

    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    now_str = now.isoformat()

    # Streak logic: if last completion was within 24h, increment streak, else reset
    last = agent.get("lastCompleted")
    if last:
        try:
            last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
            if (now - last_dt) < timedelta(hours=24):
                agent["streak"] = agent.get("streak", 0) + 1
                # Streak bonus: +5 per streak level (max +25)
                streak_bonus = min(agent["streak"] * 5, 25)
                points += streak_bonus
            else:
                agent["streak"] = 1
        except Exception:
            agent["streak"] = 1
    else:
        agent["streak"] = 1

    agent["score"] = agent.get("score", 0) + points
    agent["completed"] = agent.get("completed", 0) + 1
    agent["lastCompleted"] = now_str

    # History (last 50 entries)
    history = agent.get("history", [])
    history.append({"points": points, "reason": reason, "at": now_str})
    if len(history) > 50:
        history = history[-50:]
    agent["history"] = history

    data["agents"][agent_key] = agent
    _save_scores(data)
    return {"agent": agent_key, "pointsAwarded": points, "totalScore": agent["score"], "streak": agent["streak"], "completed": agent["completed"]}

def _handle_scores_leaderboard():
    """GET /api/projects/scores — returns top agents sorted by score."""
    data = _load_scores()
    agents = []
    for key, info in data.get("agents", {}).items():
        agents.append({
            "agent": key,
            "score": info.get("score", 0),
            "completed": info.get("completed", 0),
            "streak": info.get("streak", 0),
        })
    agents.sort(key=lambda x: x["score"], reverse=True)
    return {"ok": True, "leaderboard": agents}

def _handle_score_award(body):
    """POST /api/projects/scores/award — manually award points."""
    agent_key = (body.get("agent") or "").strip()
    points = int(body.get("points", 0))
    reason = body.get("reason", "manual")
    if not agent_key or points <= 0:
        return {"error": "agent and positive points required", "_status": 400}
    result = _award_points(agent_key, points, reason)
    if result:
        return {"ok": True, **result}
    return {"error": "Invalid agent", "_status": 400}


# ── SCORING POINT VALUES ──────────────────────────────────────────────────────
SCORE_TASK_COMPLETED = 10        # Base points for completing a task
SCORE_CRITICAL_BONUS = 15       # Extra for critical priority
SCORE_HIGH_BONUS = 10           # Extra for high priority
SCORE_MEDIUM_BONUS = 5          # Extra for medium priority
SCORE_ON_TIME_BONUS = 10        # Extra for completing before due date
SCORE_CHECKLIST_BONUS = 2       # Per checklist item completed


# ─── PROJECTS API ────────────────────────────────────────────────────────────
##############################################################################

_PROJECTS_FILE_LOCK = threading.Lock()

def _load_projects():
    """Load projects.json from STATUS_DIR. Thread-safe via lock."""
    with _PROJECTS_FILE_LOCK:
        try:
            with open(PROJECTS_FILE, "r") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
            if not isinstance(data.get("projects"), list):
                data["projects"] = []
            if not isinstance(data.get("templates"), list):
                data["templates"] = []
            return data
        except FileNotFoundError:
            return {"projects": [], "templates": []}
        except json.JSONDecodeError:
            return {"projects": [], "templates": []}


def _save_projects(data):
    """Persist projects.json with permissive mode. Thread-safe via lock."""
    with _PROJECTS_FILE_LOCK:
        os.makedirs(os.path.dirname(PROJECTS_FILE), exist_ok=True)
        # Write to temp file first, then atomic rename to prevent corruption
        tmp_path = PROJECTS_FILE + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, PROJECTS_FILE)
        try:
            os.chmod(PROJECTS_FILE, 0o666)
        except Exception:
            pass


def _proj_uuid():
    """Generate a UUID4 string."""
    import uuid
    return str(uuid.uuid4())


def _proj_now():
    """ISO-8601 timestamp."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _log_activity(project, type_, by, detail, task_id=None):
    """Append an activity record to a project."""
    if not isinstance(project.get("activity"), list):
        project["activity"] = []
    entry = {"type": type_, "by": by, "at": _proj_now(), "detail": detail}
    if task_id:
        entry["taskId"] = task_id
    project["activity"].append(entry)
    # Cap at 200
    if len(project["activity"]) > 200:
        project["activity"] = project["activity"][-200:]


# ── Built-in templates ────────────────────────────────────────────────────────
_BUILTIN_TEMPLATES = [
    {
        "id": "tpl-software",
        "title": "Software Development",
        "description": "Standard software development workflow with sprint planning",
        "builtin": True,
        "columns": [
            {"title": "Backlog", "color": "#6c757d"},
            {"title": "Sprint", "color": "#0d6efd"},
            {"title": "In Progress", "color": "#ffc107"},
            {"title": "Code Review", "color": "#fd7e14"},
            {"title": "QA", "color": "#17a2b8"},
            {"title": "Done", "color": "#198754"},
        ],
        "taskTemplates": [
            {"title": "Set up development environment", "columnIndex": 0, "priority": "high"},
            {"title": "Define acceptance criteria", "columnIndex": 0, "priority": "medium"},
            {"title": "Write unit tests", "columnIndex": 0, "priority": "medium"},
        ],
    },
    {
        "id": "tpl-marketing",
        "title": "Marketing Campaign",
        "description": "Plan and execute marketing campaigns",
        "builtin": True,
        "columns": [
            {"title": "Ideas", "color": "#6c757d"},
            {"title": "Planning", "color": "#0d6efd"},
            {"title": "Creating", "color": "#ffc107"},
            {"title": "Review", "color": "#fd7e14"},
            {"title": "Published", "color": "#198754"},
        ],
        "taskTemplates": [
            {"title": "Define target audience", "columnIndex": 0, "priority": "high"},
            {"title": "Create content calendar", "columnIndex": 0, "priority": "medium"},
        ],
    },
    {
        "id": "tpl-bugs",
        "title": "Bug Tracking",
        "description": "Track and resolve bugs systematically",
        "builtin": True,
        "columns": [
            {"title": "Reported", "color": "#dc3545"},
            {"title": "Confirmed", "color": "#fd7e14"},
            {"title": "In Progress", "color": "#ffc107"},
            {"title": "Fixed", "color": "#0d6efd"},
            {"title": "Verified", "color": "#198754"},
        ],
        "taskTemplates": [],
    },
    {
        "id": "tpl-content",
        "title": "Content Pipeline",
        "description": "Manage content creation workflow",
        "builtin": True,
        "columns": [
            {"title": "Backlog", "color": "#6c757d"},
            {"title": "Research", "color": "#17a2b8"},
            {"title": "Writing", "color": "#ffc107"},
            {"title": "Editing", "color": "#fd7e14"},
            {"title": "Published", "color": "#198754"},
        ],
        "taskTemplates": [],
    },
]

# ── GET handlers ──────────────────────────────────────────────────────────────

def _handle_projects_list(query_string=""):
    """GET /api/projects — return all projects (summaries)."""
    data = _load_projects()
    projects = data.get("projects", [])
    # Optional ?status= filter
    status_filter = None
    if query_string:
        for part in query_string.split("&"):
            if part.startswith("status="):
                status_filter = part.split("=", 1)[1]
    if status_filter:
        projects = [p for p in projects if p.get("status") == status_filter]
    # Return summary (no activity log, trim tasks to counts)
    summaries = []
    for p in projects:
        tasks = p.get("tasks", [])
        total = len(tasks)
        done = sum(1 for t in tasks if t.get("completedAt"))
        summaries.append({
            "id": p["id"],
            "title": p.get("title", ""),
            "description": p.get("description", ""),
            "status": p.get("status", "active"),
            "priority": p.get("priority", "medium"),
            "createdAt": p.get("createdAt", ""),
            "updatedAt": p.get("updatedAt", ""),
            "dueDate": p.get("dueDate"),
            "createdBy": p.get("createdBy", ""),
            "tags": p.get("tags", []),
            "branch": p.get("branch", ""),
            "columns": p.get("columns", []),
            "taskCount": total,
            "taskDone": done,
            "template": p.get("template", False),
        })
    return {"ok": True, "projects": summaries}


def _handle_project_get(project_id):
    """GET /api/projects/{id} — return full project."""
    data = _load_projects()
    for p in data["projects"]:
        if p["id"] == project_id:
            return {"ok": True, "project": p}
    return {"error": "Project not found", "_status": 404}


def _handle_projects_templates():
    """GET /api/projects/templates — list built-in + user templates."""
    data = _load_projects()
    all_templates = list(_BUILTIN_TEMPLATES) + data.get("templates", [])
    return {"ok": True, "templates": all_templates}


def _handle_project_report(project_id):
    """GET /api/projects/{id}/report."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    tasks = p.get("tasks", [])
    now_str = _proj_now()
    from datetime import datetime, timezone
    def _is_overdue(t):
        dd = t.get("dueDate")
        if not dd or t.get("completedAt"):
            return False
        try:
            due = datetime.fromisoformat(dd.replace("Z", "+00:00"))
            return due < datetime.now(timezone.utc)
        except Exception:
            return False
    total = len(tasks)
    done = sum(1 for t in tasks if t.get("completedAt"))
    in_progress_cols = [c["id"] for c in p.get("columns", []) if "progress" in c.get("title", "").lower() or "doing" in c.get("title", "").lower()]
    in_progress = sum(1 for t in tasks if t.get("columnId") in in_progress_cols)
    overdue = sum(1 for t in tasks if _is_overdue(t))
    # Per-column breakdown
    col_stats = []
    for col in p.get("columns", []):
        col_tasks = [t for t in tasks if t.get("columnId") == col["id"]]
        col_stats.append({"id": col["id"], "title": col["title"], "color": col.get("color", "#666"), "count": len(col_tasks)})
    # Agent workload
    agent_load = {}
    for t in tasks:
        a = t.get("assignee") or "Unassigned"
        agent_load[a] = agent_load.get(a, 0) + 1
    # Timeline (tasks with due dates)
    timeline = []
    for t in tasks:
        if t.get("dueDate"):
            timeline.append({"id": t["id"], "title": t["title"], "dueDate": t["dueDate"], "completedAt": t.get("completedAt"), "assignee": t.get("assignee"), "priority": t.get("priority", "medium")})
    timeline.sort(key=lambda x: x["dueDate"])
    return {"ok": True, "report": {
        "projectId": project_id,
        "title": p.get("title", ""),
        "generatedAt": now_str,
        "stats": {"total": total, "done": done, "inProgress": in_progress, "overdue": overdue},
        "columns": col_stats,
        "agentWorkload": agent_load,
        "timeline": timeline,
    }}


# ── POST handlers ─────────────────────────────────────────────────────────────

def _handle_project_create(body):
    """POST /api/projects — create a new project."""
    title = (body.get("title") or "").strip()
    if not title:
        return {"error": "Project title is required", "_status": 400}
    created_by = (body.get("createdBy") or body.get("author") or "user").strip()
    now = _proj_now()
    # Default columns
    default_cols = [
        {"id": _proj_uuid(), "title": "Backlog", "color": "#6c757d", "order": 0},
        {"id": _proj_uuid(), "title": "In Progress", "color": "#ffc107", "order": 1},
        {"id": _proj_uuid(), "title": "Review", "color": "#fd7e14", "order": 2},
        {"id": _proj_uuid(), "title": "Done", "color": "#198754", "order": 3},
    ]
    cols = body.get("columns") or default_cols
    project = {
        "id": _proj_uuid(),
        "title": title,
        "description": body.get("description", ""),
        "status": body.get("status", "active"),
        "priority": body.get("priority", "medium"),
        "createdAt": now,
        "updatedAt": now,
        "dueDate": body.get("dueDate"),
        "createdBy": created_by,
        "tags": body.get("tags", []),
        "branch": body.get("branch", ""),
        "columns": cols,
        "tasks": [],
        "activity": [],
        "template": False,
    }
    _log_activity(project, "project_created", created_by, f"Created project '{title}'")
    data = _load_projects()
    data["projects"].append(project)
    _save_projects(data)
    return {"ok": True, "project": project}


def _handle_task_create(project_id, body):
    """POST /api/projects/{id}/tasks — create a task."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    title = (body.get("title") or "").strip()
    if not title:
        return {"error": "Task title is required", "_status": 400}
    # Determine column
    col_id = body.get("columnId")
    if not col_id and p.get("columns"):
        col_id = p["columns"][0]["id"]
    # Max order in column
    max_order = max((t.get("order", 0) for t in p["tasks"] if t.get("columnId") == col_id), default=-1) + 1
    now = _proj_now()
    task = {
        "id": _proj_uuid(),
        "title": title,
        "description": body.get("description", ""),
        "columnId": col_id,
        "order": max_order,
        "priority": body.get("priority", "medium"),
        "assignee": body.get("assignee"),
        "assigneeBranch": body.get("assigneeBranch"),
        "dueDate": body.get("dueDate"),
        "tags": body.get("tags", []),
        "checklist": body.get("checklist", []),
        "comments": [],
        "attachments": [],
        "createdAt": now,
        "updatedAt": now,
        "completedAt": None,
    }
    p["tasks"].append(task)
    p["updatedAt"] = now
    by = body.get("by", "user")
    _log_activity(p, "task_created", by, f"Created task '{title}'", task["id"])
    _save_projects(data)
    # Create task markdown file at creation time
    col_title = next((c["title"] for c in p.get("columns", []) if c["id"] == col_id), "backlog")
    _wf_write_task_file(project_id, task, col_title.lower().replace(" ", "_"), work_log_entry=f"Task created by {by} in '{col_title}'")
    return {"ok": True, "task": task}


def _handle_task_comment(project_id, task_id, body):
    """POST /api/projects/{id}/tasks/{taskId}/comments."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    task = next((t for t in p["tasks"] if t["id"] == task_id), None)
    if not task:
        return {"error": "Task not found", "_status": 404}
    text = (body.get("text") or "").strip()
    if not text:
        return {"error": "Comment text is required", "_status": 400}
    author = (body.get("author") or "user").strip()
    comment = {"id": _proj_uuid(), "author": author, "text": text, "createdAt": _proj_now()}
    if not isinstance(task.get("comments"), list):
        task["comments"] = []
    task["comments"].append(comment)
    task["updatedAt"] = _proj_now()
    p["updatedAt"] = _proj_now()
    _log_activity(p, "task_commented", author, f"Commented on '{task['title']}'", task_id)
    _save_projects(data)
    # Update task markdown file with comment
    current_col = next((c["title"] for c in p.get("columns", []) if c["id"] == task.get("columnId")), "unknown")
    _wf_write_task_file(project_id, task, current_col.lower().replace(" ", "_"), work_log_entry=f"Comment by {author}: {text[:200]}")
    return {"ok": True, "comment": comment}


def _handle_project_from_template(body):
    """POST /api/projects/from-template."""
    template_id = (body.get("templateId") or "").strip()
    title = (body.get("title") or "").strip()
    if not title:
        return {"error": "Project title is required", "_status": 400}
    data = _load_projects()
    tpl = next((t for t in data.get("templates", []) if t["id"] == template_id), None)
    # Also check built-in templates
    if not tpl:
        tpl = next((t for t in _BUILTIN_TEMPLATES if t["id"] == template_id), None)
    if not tpl:
        return {"error": "Template not found", "_status": 404}
    now = _proj_now()
    # Clone columns with new IDs
    col_map = {}
    new_cols = []
    for i, col in enumerate(tpl.get("columns", [])):
        new_id = _proj_uuid()
        col_map[i] = new_id
        new_cols.append({"id": new_id, "title": col.get("title", f"Column {i+1}"), "color": col.get("color", "#6c757d"), "order": i})
    # Create tasks from taskTemplates
    new_tasks = []
    for tt in tpl.get("taskTemplates", []):
        col_idx = tt.get("columnIndex", 0)
        col_id = col_map.get(col_idx, new_cols[0]["id"] if new_cols else None)
        if col_id:
            new_tasks.append({
                "id": _proj_uuid(),
                "title": tt.get("title", "Task"),
                "description": tt.get("description", ""),
                "columnId": col_id,
                "order": tt.get("order", 0),
                "priority": tt.get("priority", "medium"),
                "assignee": None,
                "assigneeBranch": None,
                "dueDate": None,
                "tags": tt.get("tags", []),
                "checklist": [],
                "comments": [],
                "attachments": [],
                "createdAt": now,
                "updatedAt": now,
                "completedAt": None,
            })
    created_by = (body.get("createdBy") or "user").strip()
    project = {
        "id": _proj_uuid(),
        "title": title,
        "description": body.get("description", tpl.get("description", "")),
        "status": "active",
        "priority": body.get("priority", "medium"),
        "createdAt": now,
        "updatedAt": now,
        "dueDate": body.get("dueDate"),
        "createdBy": created_by,
        "tags": body.get("tags", []),
        "branch": body.get("branch", ""),
        "columns": new_cols,
        "tasks": new_tasks,
        "activity": [],
        "template": False,
    }
    _log_activity(project, "project_created", created_by, f"Created from template '{tpl.get('title', '')}'")
    data["projects"].append(project)
    _save_projects(data)
    return {"ok": True, "project": project}


def _handle_save_as_template(body):
    """POST /api/projects/templates — save a project as template."""
    project_id = (body.get("projectId") or "").strip()
    title = (body.get("title") or "").strip()
    data = _load_projects()
    p = None
    if project_id:
        p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not title:
        title = (p.get("title", "Template") if p else "Template") + " Template"
    task_templates = []
    if p:
        col_idx_map = {col["id"]: i for i, col in enumerate(p.get("columns", []))}
        for t in p.get("tasks", []):
            task_templates.append({
                "title": t.get("title", ""),
                "columnIndex": col_idx_map.get(t.get("columnId", ""), 0),
                "priority": t.get("priority", "medium"),
                "tags": t.get("tags", []),
                "description": t.get("description", ""),
            })
    template = {
        "id": _proj_uuid(),
        "title": title,
        "description": body.get("description", p.get("description", "") if p else ""),
        "columns": [{"title": c.get("title"), "color": c.get("color", "#6c757d")} for c in (p.get("columns", []) if p else [])],
        "taskTemplates": task_templates,
    }
    if not isinstance(data.get("templates"), list):
        data["templates"] = []
    data["templates"].append(template)
    _save_projects(data)
    return {"ok": True, "template": template}


# ── PUT handlers ──────────────────────────────────────────────────────────────

def _handle_project_update(project_id, body):
    """PUT /api/projects/{id} — update project metadata."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    by = body.get("by", "user")
    updatable = ["title", "description", "status", "priority", "dueDate", "tags", "branch"]
    for field in updatable:
        if field in body:
            old = p.get(field)
            p[field] = body[field]
            if old != body[field]:
                _log_activity(p, "project_updated", by, f"Changed {field}: {old} → {body[field]}")
    p["updatedAt"] = _proj_now()
    _save_projects(data)
    return {"ok": True, "project": p}


def _handle_task_update(project_id, task_id, body):
    """PUT /api/projects/{id}/tasks/{taskId} — update a task."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    task = next((t for t in p["tasks"] if t["id"] == task_id), None)
    if not task:
        return {"error": "Task not found", "_status": 404}
    by = body.get("by", "user")
    now = _proj_now()
    # Track column move
    if "columnId" in body and body["columnId"] != task.get("columnId"):
        old_col = next((c["title"] for c in p.get("columns", []) if c["id"] == task.get("columnId")), task.get("columnId"))
        new_col = next((c["title"] for c in p.get("columns", []) if c["id"] == body["columnId"]), body["columnId"])
        # Check if moving to "Done" column
        done_cols = [c["id"] for c in p.get("columns", []) if c.get("title", "").lower() in ("done", "completed", "verified", "published", "fixed", "closed")]
        if body["columnId"] in done_cols and not task.get("completedAt"):
            task["completedAt"] = now
            # GAMIFICATION: Award points to assignee
            assignee = task.get("assignee") or body.get("assignee")
            if assignee:
                pts = SCORE_TASK_COMPLETED
                pri = task.get("priority", "medium")
                if pri == "critical": pts += SCORE_CRITICAL_BONUS
                elif pri == "high": pts += SCORE_HIGH_BONUS
                elif pri == "medium": pts += SCORE_MEDIUM_BONUS
                # On-time bonus
                dd = task.get("dueDate")
                if dd:
                    try:
                        from datetime import datetime, timezone
                        due = datetime.fromisoformat(dd.replace("Z", "+00:00"))
                        if datetime.now(timezone.utc) <= due:
                            pts += SCORE_ON_TIME_BONUS
                    except Exception:
                        pass
                # Checklist bonus
                chk = task.get("checklist", [])
                done_items = sum(1 for c in chk if c.get("done"))
                pts += done_items * SCORE_CHECKLIST_BONUS
                score_result = _award_points(assignee, pts, f"Completed: {task.get('title','')}")
                task["_scoreAwarded"] = score_result  # Transient field for response
        elif body["columnId"] not in done_cols and task.get("completedAt"):
            task["completedAt"] = None
        _log_activity(p, "task_moved", by, f"Moved '{task['title']}' from {old_col} to {new_col}", task_id)
    # Track priority change
    if "priority" in body and body["priority"] != task.get("priority"):
        _log_activity(p, "task_priority_changed", by, f"Priority changed: {task.get('priority')} → {body['priority']}", task_id)
    # Track assignee change
    if "assignee" in body and body["assignee"] != task.get("assignee"):
        _log_activity(p, "task_assigned", by, f"Assigned to {body['assignee']}", task_id)
    updatable = ["title", "description", "columnId", "order", "priority", "assignee", "assigneeBranch", "dueDate", "tags", "checklist", "completedAt"]
    # Track which fields changed for md file update
    changed_fields = []
    for field in updatable:
        if field in body:
            if task.get(field) != body[field]:
                changed_fields.append(field)
            task[field] = body[field]
    task["updatedAt"] = now
    p["updatedAt"] = now
    _save_projects(data)
    # Update task markdown file on meaningful changes
    if changed_fields:
        current_col = next((c["title"] for c in p.get("columns", []) if c["id"] == task.get("columnId")), "unknown")
        status_text = current_col.lower().replace(" ", "_")
        log_parts = []
        if "columnId" in changed_fields:
            log_parts.append(f"Moved to '{current_col}' by {by}")
        if "assignee" in changed_fields:
            log_parts.append(f"Assigned to {task.get('assignee', 'unassigned')}")
        if "priority" in changed_fields:
            log_parts.append(f"Priority set to {task.get('priority')}")
        if any(f in changed_fields for f in ("title", "description", "checklist", "tags", "dueDate")):
            log_parts.append(f"Updated by {by}")
        work_log_entry = "; ".join(log_parts) if log_parts else f"Updated by {by}"
        review_results = task.get("reviewCheck") if task.get("reviewCheck") else None
        _wf_write_task_file(project_id, task, status_text, review_results=review_results, work_log_entry=work_log_entry)
    return {"ok": True, "task": task}


def _handle_columns_update(project_id, body):
    """PUT /api/projects/{id}/columns — reorder/add/edit columns."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    columns = body.get("columns")
    if not isinstance(columns, list):
        return {"error": "columns must be a list", "_status": 400}
    by = body.get("by", "user")
    # Assign IDs to new columns
    for i, col in enumerate(columns):
        if not col.get("id"):
            col["id"] = _proj_uuid()
        col["order"] = i
    p["columns"] = columns
    p["updatedAt"] = _proj_now()
    _log_activity(p, "columns_updated", by, "Columns updated")
    _save_projects(data)
    return {"ok": True, "columns": columns}


def _handle_tasks_reorder(project_id, body):
    """PUT /api/projects/{id}/tasks/reorder — batch reorder."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    # body.updates = [{id, columnId, order}, ...]
    # Also accept body.tasks as alias for updates (frontend compat)
    updates = body.get("updates", body.get("tasks", []))
    task_map = {t["id"]: t for t in p["tasks"]}
    done_cols = {c["id"] for c in p.get("columns", []) if c.get("title", "").lower() in ("done", "completed", "verified", "published", "fixed", "closed")}
    now = _proj_now()
    for u in updates:
        tid = u.get("id")
        if tid in task_map:
            task = task_map[tid]
            new_col = u.get("columnId")
            if new_col and new_col != task.get("columnId"):
                # Auto-set/clear completedAt on done column moves
                if new_col in done_cols and not task.get("completedAt"):
                    task["completedAt"] = now
                elif new_col not in done_cols and task.get("completedAt"):
                    task["completedAt"] = None
                task["columnId"] = new_col
            if "order" in u:
                task["order"] = u["order"]
            task["updatedAt"] = now
    p["updatedAt"] = now
    _save_projects(data)
    return {"ok": True}


# ── DELETE handlers ───────────────────────────────────────────────────────────

def _handle_project_delete(project_id):
    """DELETE /api/projects/{id}."""
    data = _load_projects()
    before = len(data["projects"])
    data["projects"] = [p for p in data["projects"] if p["id"] != project_id]
    if len(data["projects"]) == before:
        return {"error": "Project not found", "_status": 404}
    _save_projects(data)
    return {"ok": True, "id": project_id}


def _handle_task_delete(project_id, task_id):
    """DELETE /api/projects/{id}/tasks/{taskId}."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    before = len(p["tasks"])
    p["tasks"] = [t for t in p["tasks"] if t["id"] != task_id]
    if len(p["tasks"]) == before:
        return {"error": "Task not found", "_status": 404}
    p["updatedAt"] = _proj_now()
    _save_projects(data)
    # Clean up task markdown file
    try:
        md_path = os.path.join(TASK_FILES_DIR, project_id, f"{task_id}.md")
        if os.path.isfile(md_path):
            os.remove(md_path)
    except Exception:
        pass
    return {"ok": True, "id": task_id}


# ─── PROJECT WORKFLOW ENGINE ──────────────────────────────────────────────────
# Background thread-based workflow: Backlog → In Progress → Review → Done
# Uses `openclaw agent` CLI or Gateway HTTP API to dispatch tasks and reviews to agents.
##############################################################################

import time as _time

# Global workflow state: { projectId: { "active": bool, "autoMode": bool, "currentTaskId": str, "phase": str, "thread": Thread, "stopFlag": Event } }
_WORKFLOW_STATE = {}
_WORKFLOW_LOCK = threading.Lock()

# Task markdown files directory
TASK_FILES_DIR = os.path.join(STATUS_DIR, "project-tasks")

def _wf_find_column(project, title_lower):
    """Find a column by title (case-insensitive). Tries exact match first, then contains."""
    cols = project.get("columns", [])
    # Exact match first
    for col in cols:
        if col.get("title", "").lower() == title_lower:
            return col
    # Fallback: column title contains the keyword (e.g. "Code Review" matches "review")
    for col in cols:
        if title_lower in col.get("title", "").lower():
            return col
    return None

def _wf_get_backlog_col(project):
    """Find the backlog/source column. Tries 'backlog' first, then common alternatives."""
    col = _wf_find_column(project, "backlog")
    if col:
        return col
    # Try common alternative names for the first/source column
    for alt in ("to do", "todo", "ideas", "reported"):
        col = _wf_find_column(project, alt)
        if col:
            return col
    # Last resort: use the first column by order
    cols = project.get("columns", [])
    if cols:
        sorted_cols = sorted(cols, key=lambda c: c.get("order", 0))
        return sorted_cols[0]
    return None

def _wf_get_inprogress_col(project):
    """Find the in-progress/work column. Tries common names, falls back to second column."""
    for name in ("in progress", "in_progress", "sprint", "creating", "writing", "working"):
        col = _wf_find_column(project, name)
        if col:
            return col
    # Fallback: second column by order (between backlog and review)
    cols = sorted(project.get("columns", []), key=lambda c: c.get("order", 0))
    if len(cols) >= 3:
        return cols[1]
    return None

def _wf_get_review_col(project):
    """Find the review column. Tries common names, falls back to second-to-last column."""
    for name in ("review", "code review", "qa", "editing", "testing"):
        col = _wf_find_column(project, name)
        if col:
            return col
    # Fallback: second-to-last column by order
    cols = sorted(project.get("columns", []), key=lambda c: c.get("order", 0))
    if len(cols) >= 3:
        return cols[-2]
    return None

def _wf_get_done_col(project):
    """Find the done/final column. Tries 'done' first, then common alternatives."""
    col = _wf_find_column(project, "done")
    if col:
        return col
    for alt in ("completed", "verified", "published", "fixed", "closed"):
        col = _wf_find_column(project, alt)
        if col:
            return col
    # Last resort: use the last column by order
    cols = project.get("columns", [])
    if cols:
        sorted_cols = sorted(cols, key=lambda c: c.get("order", 0))
        return sorted_cols[-1]
    return None

def _wf_next_backlog_task(project):
    """Get highest priority task from backlog column."""
    backlog = _wf_get_backlog_col(project)
    if not backlog:
        return None
    tasks = [t for t in project.get("tasks", []) if t.get("columnId") == backlog["id"]]
    if not tasks:
        return None
    priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    tasks.sort(key=lambda t: (priority_order.get(t.get("priority", "medium"), 2), t.get("order", 0)))
    return tasks[0]


def _wf_get_active_task(project):
    """Find a task currently in-progress or in review that still needs work.

    This prevents backlog tasks from jumping ahead of tasks that were sent
    back for rework after a failed review cycle.  Only assigned tasks are
    considered (unassigned ones can't be worked by the pipeline).
    """
    inprogress_col = _wf_get_inprogress_col(project)
    review_col = _wf_get_review_col(project)
    active_col_ids = set()
    if inprogress_col:
        active_col_ids.add(inprogress_col["id"])
    if review_col:
        active_col_ids.add(review_col["id"])
    if not active_col_ids:
        return None

    for t in project.get("tasks", []):
        if t.get("columnId") in active_col_ids and t.get("assignee"):
            return t
    return None

def _wf_move_task(project_id, task_id, target_col_id, by="workflow"):
    """Move a task to a target column and persist."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return None
    task = next((t for t in p["tasks"] if t["id"] == task_id), None)
    if not task:
        return None
    old_col = next((c["title"] for c in p.get("columns", []) if c["id"] == task.get("columnId")), "?")
    new_col = next((c["title"] for c in p.get("columns", []) if c["id"] == target_col_id), "?")
    task["columnId"] = target_col_id
    # Max order in target column
    col_tasks = [t for t in p["tasks"] if t.get("columnId") == target_col_id and t["id"] != task_id]
    task["order"] = max((t.get("order", 0) for t in col_tasks), default=-1) + 1
    task["updatedAt"] = _proj_now()
    p["updatedAt"] = _proj_now()
    # Handle done column — match common "final" column names
    done_cols = [c["id"] for c in p.get("columns", []) if c.get("title", "").lower() in ("done", "completed", "verified", "published", "fixed", "closed")]
    if target_col_id in done_cols and not task.get("completedAt"):
        task["completedAt"] = _proj_now()
        # Award points
        assignee = task.get("assignee")
        if assignee:
            pts = SCORE_TASK_COMPLETED
            pri = task.get("priority", "medium")
            if pri == "critical": pts += SCORE_CRITICAL_BONUS
            elif pri == "high": pts += SCORE_HIGH_BONUS
            elif pri == "medium": pts += SCORE_MEDIUM_BONUS
            chk = task.get("checklist", [])
            done_items = sum(1 for c in chk if c.get("done"))
            pts += done_items * SCORE_CHECKLIST_BONUS
            _award_points(assignee, pts, f"Completed: {task.get('title','')}")
    elif target_col_id not in done_cols:
        task["completedAt"] = None
    _log_activity(p, "task_moved", by, f"Moved '{task['title']}' from {old_col} to {new_col}", task_id)
    _save_projects(data)
    return task

def _wf_update_task_field(project_id, task_id, field, value):
    """Update a single field on a task and persist."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return None
    task = next((t for t in p["tasks"] if t["id"] == task_id), None)
    if not task:
        return None
    task[field] = value
    task["updatedAt"] = _proj_now()
    p["updatedAt"] = _proj_now()
    _save_projects(data)
    return task

def _wf_write_task_file(project_id, task, status_text, review_results=None, work_log_entry=None):
    """Write/update a task's markdown file."""
    task_dir = os.path.join(TASK_FILES_DIR, project_id)
    os.makedirs(task_dir, exist_ok=True)
    filepath = os.path.join(task_dir, f"{task['id']}.md")

    # Read existing file if present (to preserve work log)
    existing_log = []
    if os.path.isfile(filepath):
        with open(filepath, "r") as f:
            in_log = False
            for line in f:
                if line.strip() == "## Work Log":
                    in_log = True
                    continue
                if in_log:
                    existing_log.append(line.rstrip())

    checklist = task.get("checklist", [])
    lines = [
        f"# Task: {task.get('title', 'Untitled')}",
        f"**Status:** {status_text} | **Assignee:** {task.get('assignee', 'unassigned')} | **Priority:** {task.get('priority', 'medium')}",
        "",
        "## Description",
        task.get("description", "_No description_"),
        "",
    ]

    if checklist:
        lines.append("## Checklist")
        for item in checklist:
            check = "x" if item.get("done") else " "
            review_status = ""
            if review_results:
                for rr in review_results:
                    if rr.get("id") == item.get("id"):
                        review_status = f" — {rr.get('status', '')}"
                        break
            lines.append(f"- [{check}] {item.get('text', '')}{review_status}")
        lines.append("")

    if review_results:
        lines.append("## Review Check")
        for rr in review_results:
            icon = {"pass": "✅", "needs_more_work": "⚠️", "did_not_pass": "❌", "requires_user_review": "👤"}.get(rr.get("status"), "❓")
            lines.append(f"- {icon} **{rr.get('text', '')}**: {rr.get('status', 'pending')}")
        lines.append("")

    lines.append("## Work Log")
    lines.extend(existing_log)
    if work_log_entry:
        from datetime import datetime, timezone
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        lines.append(f"### {ts} — {work_log_entry}")

    with open(filepath, "w") as f:
        f.write("\n".join(lines) + "\n")
    try:
        os.chmod(filepath, 0o666)
    except Exception:
        pass

def _wf_read_task_file(project_id, task_id):
    """Read task markdown file if it exists."""
    filepath = os.path.join(TASK_FILES_DIR, project_id, f"{task_id}.md")
    if os.path.isfile(filepath):
        with open(filepath, "r") as f:
            return f.read()
    return None


# Track workflow sessions for cleanup: { project_id: { task_id: set(session_keys) } }
def _wf_task_session_key(agent_id, project_id, task_id):
    """Return a stable session key for a workflow task.

    All calls for the same task (work, review, rework) reuse one session.
    This means the agent keeps context across the full task lifecycle,
    prompt caching kicks in, and only ONE session is created per task.
    """
    return f"agent:{agent_id}:openai:wf-{project_id[:8]}-{task_id[:8]}"


def _wf_extract_session_activity(agent_id, project_id, task_id):
    """Extract file activity and tool usage from a workflow task's session JSONL.

    Returns a dict with:
      files_read: list of file paths read
      files_edited: list of file paths edited/written
      files_written: list of file paths created/written
      exec_commands: list of commands run
      browser_actions: list of browser actions taken
      tool_call_count: total number of tool calls
    """
    home_path = VO_CONFIG.get("openclaw", {}).get("homePath", os.path.expanduser("~/.openclaw"))
    sessions_dir = os.path.join(home_path, "agents", agent_id, "sessions")
    sessions_json_path = os.path.join(sessions_dir, "sessions.json")
    session_key = _wf_task_session_key(agent_id, project_id, task_id)

    activity = {
        "files_read": [],
        "files_edited": [],
        "files_written": [],
        "exec_commands": [],
        "browser_actions": [],
        "tool_call_count": 0,
    }

    try:
        if not os.path.exists(sessions_json_path):
            return activity
        with open(sessions_json_path, "r") as f:
            sessions_data = json.load(f)
        session_info = sessions_data.get(session_key)
        if not session_info:
            return activity
        session_id = session_info.get("sessionId", "")
        if not session_id:
            return activity

        jsonl_path = os.path.join(sessions_dir, f"{session_id}.jsonl")
        if not os.path.exists(jsonl_path):
            return activity

        seen_files_read = set()
        seen_files_edit = set()
        seen_files_write = set()

        with open(jsonl_path, "r") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = entry.get("message", entry)
                content = msg.get("content", [])
                if not isinstance(content, list):
                    continue
                for c in content:
                    if not isinstance(c, dict):
                        continue
                    if c.get("type") != "toolCall":
                        continue
                    activity["tool_call_count"] += 1
                    name = c.get("name", "")
                    args = c.get("arguments", {})
                    # Extract file path from various param names
                    fpath = args.get("path") or args.get("file") or args.get("filePath") or args.get("file_path") or ""

                    if name.lower() in ("read",):
                        if fpath and fpath not in seen_files_read:
                            seen_files_read.add(fpath)
                            activity["files_read"].append(fpath)
                    elif name.lower() in ("edit",):
                        if fpath and fpath not in seen_files_edit:
                            seen_files_edit.add(fpath)
                            activity["files_edited"].append(fpath)
                    elif name.lower() in ("write",):
                        if fpath and fpath not in seen_files_write:
                            seen_files_write.add(fpath)
                            activity["files_written"].append(fpath)
                    elif name.lower() == "exec":
                        cmd = args.get("command", "")
                        if cmd:
                            activity["exec_commands"].append(cmd[:200])
                    elif name.lower() == "browser":
                        action = args.get("action", "")
                        url = args.get("url", "")
                        if action:
                            desc = action
                            if url:
                                desc += f" → {url}"
                            activity["browser_actions"].append(desc[:200])
    except Exception as e:
        print(f"[WORKFLOW] Activity extraction error: {e}")

    return activity


def _wf_format_activity_summary(activity):
    """Format extracted session activity as markdown for the task file."""
    lines = []

    if activity["tool_call_count"] == 0:
        lines.append("⚠️ NO TOOL CALLS DETECTED — agent produced text only, no real changes made.")
        return "\n".join(lines)

    lines.append(f"**Tool calls:** {activity['tool_call_count']}")

    if activity["files_read"]:
        lines.append(f"\n**Files read ({len(activity['files_read'])}):**")
        for f in activity["files_read"]:
            lines.append(f"  - `{f}`")

    if activity["files_edited"]:
        lines.append(f"\n**Files edited ({len(activity['files_edited'])}):**")
        for f in activity["files_edited"]:
            lines.append(f"  - `{f}`")

    if activity["files_written"]:
        lines.append(f"\n**Files created/written ({len(activity['files_written'])}):**")
        for f in activity["files_written"]:
            lines.append(f"  - `{f}`")

    if activity["browser_actions"]:
        lines.append(f"\n**Browser verification ({len(activity['browser_actions'])}):**")
        for b in activity["browser_actions"]:
            lines.append(f"  - {b}")

    if activity["exec_commands"]:
        lines.append(f"\n**Commands run ({len(activity['exec_commands'])}):**")
        for cmd in activity["exec_commands"][:20]:  # cap at 20 to avoid huge logs
            lines.append(f"  - `{cmd}`")
        if len(activity["exec_commands"]) > 20:
            lines.append(f"  - ... and {len(activity['exec_commands']) - 20} more")

    return "\n".join(lines)


def _wf_cleanup_task_sessions(agent_id, project_id, task_id):
    """Delete the single session created for this workflow task."""
    session_key = _wf_task_session_key(agent_id, project_id, task_id)

    # Clean up session files directly (works inside Docker without openclaw CLI)
    home_path = VO_CONFIG.get("openclaw", {}).get("homePath", os.path.expanduser("~/.openclaw"))
    sessions_dir = os.path.join(home_path, "agents", agent_id, "sessions")
    sessions_json_path = os.path.join(sessions_dir, "sessions.json")

    try:
        if not os.path.exists(sessions_json_path):
            return

        with open(sessions_json_path, "r") as f:
            sessions_data = json.load(f)

        if session_key not in sessions_data:
            return

        # Get session ID to delete the JSONL file
        session_id = sessions_data[session_key].get("sessionId", "")
        del sessions_data[session_key]

        with open(sessions_json_path, "w") as f:
            json.dump(sessions_data, f)

        # Delete session JSONL and lock files
        if session_id:
            for ext in [".jsonl", ".jsonl.lock"]:
                fpath = os.path.join(sessions_dir, f"{session_id}{ext}")
                if os.path.exists(fpath):
                    os.remove(fpath)

        print(f"[WORKFLOW] Cleaned up session for agent={agent_id} task={task_id[:8]}: {session_key}")
    except Exception as e:
        print(f"[WORKFLOW] Session cleanup error: {e}")


def _wf_call_agent(agent_id, message, timeout=600, project_id=None, task_id=None):
    """Call an agent and return its response text.

    All calls for the same task reuse ONE session key, so the agent keeps
    context across work → review → rework cycles, prompt caching works,
    and only one session exists per task (cleaned up when task is done).

    Strategy:
    1. Try the OpenClaw Gateway HTTP API (/v1/chat/completions) — synchronous,
       works when the gateway has openaiHttp enabled.
    2. Fall back to `openclaw agent` CLI — always available when OpenClaw is installed.

    Both are portable — no hardcoded paths or tokens. Config comes from vo-config.json.
    """
    # Use a stable session key per task — reused across all calls for this task
    session_key = None
    if project_id and task_id:
        session_key = _wf_task_session_key(agent_id, project_id, task_id)

    # Try gateway HTTP API first
    result = _wf_call_agent_http(agent_id, message, timeout, session_key=session_key)
    if result is not None:
        return result

    # Fall back to CLI (also pass session key if available)
    return _wf_call_agent_cli(agent_id, message, timeout, session_key=session_key)


def _wf_call_agent_http(agent_id, message, timeout, session_key=None):
    """Try calling agent via gateway /v1/chat/completions. Returns None if not available.
    If session_key is provided, uses it for session routing (enables cleanup later)."""
    import urllib.request
    import urllib.error

    gateway_http = VO_CONFIG.get("openclaw", {}).get("gatewayHttp", "http://127.0.0.1:18789")
    token = _get_gateway_token()
    if not token:
        return None

    url = f"{gateway_http}/v1/chat/completions"
    payload = json.dumps({
        "model": f"openclaw/{agent_id}",
        "messages": [{"role": "user", "content": message}],
    })
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    if session_key:
        headers["x-openclaw-session-key"] = session_key

    try:
        req = urllib.request.Request(url, data=payload.encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout + 30) as resp:
            content_type = resp.headers.get("Content-Type", "")
            if "application/json" not in content_type:
                # Gateway returned HTML (endpoint not enabled) — fall back to CLI
                return None
            data = json.loads(resp.read().decode("utf-8"))
            choices = data.get("choices", [])
            if choices:
                msg = choices[0].get("message", {})
                return msg.get("content", "")
            return data.get("reply", data.get("text", str(data)))
    except urllib.error.HTTPError as e:
        if e.code in (404, 405):
            # Endpoint not available — fall back to CLI
            return None
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        return f"[ERROR] Gateway returned HTTP {e.code}: {body}"
    except Exception:
        return None  # Fall back to CLI


def _wf_call_agent_cli(agent_id, message, timeout, session_key=None):
    """Call agent via `openclaw agent` CLI — always available when OpenClaw is installed."""
    import subprocess
    import shutil

    openclaw_bin = shutil.which("openclaw")
    if not openclaw_bin:
        return "[ERROR] openclaw CLI not found in PATH"

    cmd = [openclaw_bin, "agent", "--agent", agent_id, "--message", message, "--timeout", str(timeout), "--json"]
    if session_key:
        cmd.extend(["--session-id", session_key])
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 60)
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                return data.get("reply", data.get("text", result.stdout))
            except json.JSONDecodeError:
                return result.stdout.strip()
        else:
            return f"[ERROR] Agent returned code {result.returncode}: {result.stderr.strip()[:500]}"
    except subprocess.TimeoutExpired:
        return "[ERROR] Agent call timed out"
    except Exception as e:
        return f"[ERROR] Agent call failed: {str(e)}"

def _wf_build_project_context(project, task):
    """Build project and task metadata context string."""
    lines = []
    proj_title = project.get("title") or project.get("name") or "Untitled Project"
    proj_desc = project.get("description", "")
    proj_tags = project.get("tags", [])
    task_tags = task.get("tags", [])
    task_priority = task.get("priority", "medium")
    task_assignee = task.get("assignee", "unassigned")

    lines.append(f"PROJECT: {proj_title}")
    if proj_desc:
        lines.append(f"PROJECT DESCRIPTION: {proj_desc}")
    if proj_tags:
        lines.append(f"PROJECT TAGS: {', '.join(proj_tags)}")
    if task_tags:
        lines.append(f"TASK TAGS: {', '.join(task_tags)}")
    lines.append(f"PRIORITY: {task_priority}")
    lines.append(f"ASSIGNED TO: {task_assignee}")
    return "\n".join(lines)


def _wf_build_task_prompt(task, task_file_content=None, project=None):
    """Build the autonomous work prompt for an agent."""
    project_context = ""
    if project:
        project_context = _wf_build_project_context(project, task) + "\n\n"

    checklist_text = ""
    if task.get("checklist"):
        checklist_text = "\n\nChecklist (you must complete ALL items):\n"
        for i, item in enumerate(task["checklist"], 1):
            status = "✅ DONE" if item.get("done") else "⬜ TODO"
            checklist_text += f"  {i}. [{status}] {item.get('text', '')}\n"

    previous_work = ""
    if task_file_content:
        previous_work = f"\n\n--- PREVIOUS WORK LOG ---\n{task_file_content}\n--- END PREVIOUS WORK LOG ---\n\nContinue from where you left off. Do NOT redo work that was already completed."

    return f"""You have been assigned a task. Complete it fully on your own. Do NOT ask for clarification, followups, or user input.

{project_context}TASK: {task.get('title', 'Untitled')}

DESCRIPTION:
{task.get('description', 'No description provided.')}
{checklist_text}
{previous_work}

MANDATORY RULES — VIOLATIONS WILL FAIL REVIEW:
1. You MUST use tools (read, edit, exec, browser) to make REAL changes to actual files. Text-only responses WILL BE REJECTED.
2. Read the relevant source files FIRST to understand the codebase before making changes.
3. Use the edit tool to modify files. Use exec to run commands, test, or verify.
4. After making changes, verify them yourself — run the app, check the output, confirm it works.
5. Use the browser tool to visually verify UI changes on the running app/site if applicable.
6. In your final report, list EVERY file you modified and what you changed.

A reviewer will independently verify your work by reading the actual files and browsing the app. If no real file changes are found, ALL items will be marked DID_NOT_PASS.

WARNING: Do NOT run 'docker restart' on this app's container — it will kill the workflow pipeline managing this task. If you need to reload server changes, the app live-mounts /app so file edits take effect on the next HTTP request for static files. For server.py changes that need a process reload, note what needs restarting in your report and the reviewer will handle it."""

def _wf_build_review_prompt(task, task_file_content=None, project=None):
    """Build the self-review prompt for an agent."""
    project_context = ""
    if project:
        project_context = _wf_build_project_context(project, task) + "\n\n"

    items_text = ""
    if task.get("checklist"):
        for i, item in enumerate(task["checklist"], 1):
            items_text += f"  {i}. {item.get('text', '')}\n"

    return f"""{project_context}Review your completed work on: {task.get('title', 'Untitled')}

You must INDEPENDENTLY VERIFY each checklist item. Do NOT trust your previous claims — verify by actually checking.

MANDATORY REVIEW STEPS:
1. Use the read tool to open the actual source files that were supposed to be modified. Confirm the changes exist in the code.
2. Use exec to run any tests, linters, or verification commands.
3. Use the browser tool to load the running app/site and visually confirm UI changes are working. Take snapshots.
4. If you cannot find real file changes for an item, mark it DID_NOT_PASS regardless of what was claimed earlier.

For EACH checklist item, respond with one of these statuses:
- PASS — verified in the actual files AND confirmed working in the browser/app
- NEEDS_MORE_WORK — partially implemented but has issues you can identify in the code
- DID_NOT_PASS — no real changes found in files, or changes don't work
- REQUIRES_USER_REVIEW — involves destructive operations, out of scope, or needs human judgment

Respond in this EXACT format (one line per item, after your verification):
REVIEW_ITEM_1: <status>
REVIEW_ITEM_2: <status>
...

Checklist items to review:
{items_text}

CRITICAL: You MUST use tools (read, exec, browser) during this review. A text-only review with no tool calls will be considered invalid."""

def _wf_build_rework_prompt(task, failed_items, task_file_content=None, project=None):
    """Build a rework prompt for failed review items."""
    # project context not repeated in rework — agent already has it from the same session
    items_text = ""
    for i, item in enumerate(failed_items, 1):
        items_text += f"  {i}. {item.get('text', '')} — Status: {item.get('reviewStatus', 'needs_more_work')}\n"

    previous_work = ""
    if task_file_content:
        previous_work = f"\n\n--- PREVIOUS WORK LOG ---\n{task_file_content}\n--- END PREVIOUS WORK LOG ---"

    return f"""These items need more work on: {task.get('title', 'Untitled')}

The following checklist items did NOT pass review. Fix them yourself. Do not ask for help.

Items that need work:
{items_text}
{previous_work}

MANDATORY RULES:
1. You MUST use tools (read, edit, exec, browser) to make REAL changes to actual files.
2. Read the relevant files first, then use edit to fix the issues.
3. After fixing, verify your changes work — use exec to test and browser to visually confirm UI changes.
4. Only fix the items listed above. Do NOT redo work that already passed.
5. In your report, list EVERY file you modified and what you changed.

A reviewer will independently verify your fixes by reading the actual files and browsing the app."""

def _wf_parse_review_response(response_text, checklist):
    """Parse the agent's review response into structured results.

    Handles formats like:
      REVIEW_ITEM_1: PASS
      REVIEW_ITEM_2: NEEDS_MORE_WORK
    Or:
      1. PASS
      Item 3: DID_NOT_PASS
    Or freeform lines containing status keywords.

    Important: checks longer status strings first to avoid "PASS" matching "DID_NOT_PASS".
    """
    results = []
    lines = response_text.strip().split("\n")

    # Ordered longest-first to prevent "pass" from matching "did_not_pass"
    status_patterns = [
        ("requires_user_review", "requires_user_review"),
        ("requires user review", "requires_user_review"),
        ("needs_more_work", "needs_more_work"),
        ("needs more work", "needs_more_work"),
        ("did_not_pass", "did_not_pass"),
        ("did not pass", "did_not_pass"),
        ("pass", "pass"),
    ]

    item_idx = 0
    for line in lines:
        line_stripped = line.strip()
        if not line_stripped or item_idx >= len(checklist):
            continue

        line_lower = line_stripped.lower()

        # Skip lines that don't look like review items (pure prose, headers, etc.)
        # Accept lines with REVIEW_ITEM_, numbered items, or containing a status keyword
        is_review_line = (
            "review_item" in line_lower
            or re_module.match(r'^\d+[\.\):\s]', line_stripped)
            or "item " in line_lower
        )

        matched_status = None
        for pattern, status_val in status_patterns:
            if pattern in line_lower:
                matched_status = status_val
                break

        if matched_status and (is_review_line or item_idx == 0 or len(checklist) == 1):
            results.append({
                "id": checklist[item_idx].get("id"),
                "text": checklist[item_idx].get("text", ""),
                "status": matched_status,
            })
            item_idx += 1
        elif matched_status and not is_review_line:
            # Heuristic: if we're already matching items and this line has a status,
            # it's probably a continuation
            if len(results) > 0:
                results.append({
                    "id": checklist[item_idx].get("id"),
                    "text": checklist[item_idx].get("text", ""),
                    "status": matched_status,
                })
                item_idx += 1

    # If parsing failed or incomplete, default remaining to needs_more_work
    for i in range(len(results), len(checklist)):
        results.append({
            "id": checklist[i].get("id"),
            "text": checklist[i].get("text", ""),
            "status": "needs_more_work",
        })

    return results

def _wf_run_pipeline(project_id, single_task=False):
    """Main workflow pipeline — runs in a background thread."""
    with _WORKFLOW_LOCK:
        wf = _WORKFLOW_STATE.get(project_id)
        if not wf:
            return

    stop_flag = wf["stopFlag"]

    try:
      _wf_run_pipeline_inner(project_id, single_task, wf, stop_flag)
    except Exception as e:
        print(f"[WORKFLOW ERROR] Pipeline crashed for {project_id}: {e}")
        import traceback
        traceback.print_exc()
    finally:
        # Always clean up state
        with _WORKFLOW_LOCK:
            if project_id in _WORKFLOW_STATE:
                _WORKFLOW_STATE[project_id]["active"] = False
                _WORKFLOW_STATE[project_id]["thread"] = None
        _wf_persist_state(project_id)
        _wf_clear_persisted_state(project_id)


def _wf_run_pipeline_inner(project_id, single_task, wf, stop_flag):
    """Inner pipeline logic — wrapped by _wf_run_pipeline for error safety."""
    while not stop_flag.is_set():
        # Load fresh project data
        data = _load_projects()
        project = next((x for x in data["projects"] if x["id"] == project_id), None)
        if not project:
            break

        # Check for an active task (in-progress or review) before pulling from backlog.
        # This prevents backlog tasks from jumping ahead of tasks sent back for rework.
        active_task = _wf_get_active_task(project)
        if active_task:
            # There's already a task being worked on — do NOT pull from backlog.
            # The pipeline should not start a new task while one is still active.
            with _WORKFLOW_LOCK:
                wf["phase"] = "blocked_by_active_task"
                wf["error"] = f"Task '{active_task.get('title', '')}' is still in progress. Backlog tasks will not start until it is fully done or moved to backlog/done."
                wf["currentTaskId"] = active_task["id"]
                wf["active"] = False
            _wf_persist_state(project_id)
            break

        # Find next backlog task
        task = _wf_next_backlog_task(project)
        if not task:
            # No more backlog tasks
            with _WORKFLOW_LOCK:
                wf["phase"] = "idle"
                wf["currentTaskId"] = None
                wf["active"] = False
            break

        task_id = task["id"]
        assignee = task.get("assignee")
        if not assignee:
            # Skip unassigned tasks
            with _WORKFLOW_LOCK:
                wf["phase"] = "error"
                wf["error"] = f"Task '{task.get('title')}' has no assignee"
                wf["active"] = False
            break

        with _WORKFLOW_LOCK:
            wf["currentTaskId"] = task_id
            wf["phase"] = "dispatching"
            wf["error"] = None
        _wf_persist_state(project_id)

        if stop_flag.is_set():
            break

        # Step 1: Move straight to In Progress
        inprogress_col = _wf_get_inprogress_col(project)
        if not inprogress_col:
            with _WORKFLOW_LOCK:
                wf["phase"] = "error"
                wf["error"] = "No 'In Progress' column found"
                wf["active"] = False
            break

        _wf_move_task(project_id, task_id, inprogress_col["id"], by="workflow")
        _wf_write_task_file(project_id, task, "in_progress", work_log_entry="Sent to agent for work")

        with _WORKFLOW_LOCK:
            wf["phase"] = "in_progress"
        _wf_persist_state(project_id)

        if stop_flag.is_set():
            break

        task_file = _wf_read_task_file(project_id, task_id)
        prompt = _wf_build_task_prompt(task, task_file, project=project)
        agent_response = _wf_call_agent(assignee, prompt, project_id=project_id, task_id=task_id)

        if stop_flag.is_set():
            break

        # Update task file with agent response + file activity
        work_activity = _wf_extract_session_activity(assignee, project_id, task_id)
        work_activity_text = _wf_format_activity_summary(work_activity)
        _wf_write_task_file(project_id, task, "in_progress", work_log_entry=f"Agent response:\n{agent_response[:2000]}\n\n**Activity:**\n{work_activity_text}")

        # Step 3: Move to Review
        review_col = _wf_get_review_col(project)
        if not review_col:
            with _WORKFLOW_LOCK:
                wf["phase"] = "error"
                wf["error"] = "No 'Review' column found"
                wf["active"] = False
            break

        _wf_move_task(project_id, task_id, review_col["id"], by="workflow")

        # Review loop
        max_review_cycles = 5
        review_cycle = 0
        task_done = False

        while review_cycle < max_review_cycles and not stop_flag.is_set():
            review_cycle += 1
            with _WORKFLOW_LOCK:
                wf["phase"] = "reviewing"
                wf["reviewCycle"] = review_cycle
            _wf_persist_state(project_id)

            # Reload task for fresh checklist
            data = _load_projects()
            project = next((x for x in data["projects"] if x["id"] == project_id), None)
            if not project:
                break
            task = next((t for t in project["tasks"] if t["id"] == task_id), None)
            if not task:
                break

            checklist = task.get("checklist", [])
            if not checklist:
                # No checklist = auto-pass
                task_done = True
                break

            task_file = _wf_read_task_file(project_id, task_id)
            review_prompt = _wf_build_review_prompt(task, task_file, project=project)
            review_response = _wf_call_agent(assignee, review_prompt, project_id=project_id, task_id=task_id)

            if stop_flag.is_set():
                break

            # Parse review results
            review_results = _wf_parse_review_response(review_response, checklist)

            # Save review results to task
            _wf_update_task_field(project_id, task_id, "reviewCheck", review_results)
            review_activity = _wf_extract_session_activity(assignee, project_id, task_id)
            review_activity_text = _wf_format_activity_summary(review_activity)
            _wf_write_task_file(project_id, task, "review", review_results=review_results, work_log_entry=f"Review cycle {review_cycle}:\n{review_response[:2000]}\n\n**Review verification activity:**\n{review_activity_text}")

            # Check results
            all_pass = all(r.get("status") == "pass" for r in review_results)
            needs_user = any(r.get("status") == "requires_user_review" for r in review_results)
            failed_items = [r for r in review_results if r.get("status") in ("needs_more_work", "did_not_pass")]

            if all_pass:
                task_done = True
                break

            if needs_user:
                # Pause workflow — user must intervene
                with _WORKFLOW_LOCK:
                    wf["phase"] = "awaiting_user_review"
                    wf["error"] = "Task requires user review for some items"
                _wf_persist_state(project_id)
                _wf_write_task_file(project_id, task, "review", review_results=review_results, work_log_entry="Workflow paused — requires user review")
                # Wait until user resolves or stop
                while not stop_flag.is_set():
                    _time.sleep(5)
                    # Check if user resolved review items
                    data = _load_projects()
                    project = next((x for x in data["projects"] if x["id"] == project_id), None)
                    if not project:
                        break
                    task = next((t for t in project["tasks"] if t["id"] == task_id), None)
                    if not task:
                        break
                    current_review = task.get("reviewCheck", [])
                    still_needs_user = any(r.get("status") == "requires_user_review" for r in current_review)
                    if not still_needs_user:
                        # User resolved — check if all pass now
                        all_resolved_pass = all(r.get("status") == "pass" for r in current_review)
                        if all_resolved_pass:
                            task_done = True
                            break
                        else:
                            # Some items still need work — continue review loop
                            failed_items = [r for r in current_review if r.get("status") in ("needs_more_work", "did_not_pass")]
                            break
                if task_done or stop_flag.is_set():
                    break

            if failed_items and not stop_flag.is_set():
                # Move back to In Progress for rework
                with _WORKFLOW_LOCK:
                    wf["phase"] = "reworking"
                _wf_persist_state(project_id)

                # Clear stale reviewCheck so next cycle starts clean
                _wf_update_task_field(project_id, task_id, "reviewCheck", [])

                _wf_move_task(project_id, task_id, inprogress_col["id"], by="workflow")
                _wf_write_task_file(project_id, task, "in_progress", work_log_entry=f"Back to In Progress — {len(failed_items)} items need rework")

                task_file = _wf_read_task_file(project_id, task_id)
                rework_prompt = _wf_build_rework_prompt(task, failed_items, task_file)
                rework_response = _wf_call_agent(assignee, rework_prompt, project_id=project_id, task_id=task_id)

                if stop_flag.is_set():
                    break

                rework_activity = _wf_extract_session_activity(assignee, project_id, task_id)
                rework_activity_text = _wf_format_activity_summary(rework_activity)
                _wf_write_task_file(project_id, task, "in_progress", work_log_entry=f"Rework response:\n{rework_response[:2000]}\n\n**Rework activity:**\n{rework_activity_text}")

                # Move back to Review
                _wf_move_task(project_id, task_id, review_col["id"], by="workflow")

        # End of review loop
        if stop_flag.is_set():
            break

        if task_done:
            # Extract session activity BEFORE cleanup (needs the session files)
            activity = _wf_extract_session_activity(assignee, project_id, task_id)
            activity_summary = _wf_format_activity_summary(activity)

            # Move to Done
            done_col = _wf_get_done_col(project)
            if done_col:
                _wf_move_task(project_id, task_id, done_col["id"], by="workflow")

                # Write completion with activity summary
                completion_entry = f"Task completed — all review checks passed\n\n### Task Completion Summary\n{activity_summary}"
                _wf_write_task_file(project_id, task, "done", work_log_entry=completion_entry)

                # Mark all checklist items as done
                data = _load_projects()
                project = next((x for x in data["projects"] if x["id"] == project_id), None)
                if project:
                    task = next((t for t in project["tasks"] if t["id"] == task_id), None)
                    if task and task.get("checklist"):
                        for item in task["checklist"]:
                            item["done"] = True
                        task["updatedAt"] = _proj_now()
                        _save_projects(data)

            # Clean up workflow sessions for this task (AFTER activity extraction)
            _wf_cleanup_task_sessions(assignee, project_id, task_id)

            with _WORKFLOW_LOCK:
                wf["phase"] = "task_done"
                wf["currentTaskId"] = None
            _wf_persist_state(project_id)

            if single_task:
                # Auto Mode OFF — stop after one task
                with _WORKFLOW_LOCK:
                    wf["active"] = False
                break
            else:
                # Auto Mode ON — continue to next task
                _time.sleep(2)  # Brief pause between tasks
                continue
        else:
            # Task did NOT pass review after max cycles — do NOT pull next backlog task.
            # Keep this task in progress and pause for human intervention.
            _wf_move_task(project_id, task_id, inprogress_col["id"], by="workflow")
            _wf_write_task_file(project_id, task, "in_progress",
                work_log_entry=f"Review failed after {max_review_cycles} cycles — paused for human intervention. Backlog tasks will NOT proceed until this task passes or is manually resolved.")

            with _WORKFLOW_LOCK:
                wf["phase"] = "awaiting_human_intervention"
                wf["error"] = f"Task '{task.get('title', '')}' failed review after {max_review_cycles} cycles. Resolve manually or retry."
            _wf_persist_state(project_id)

            # Wait until human resolves (moves task to done/backlog, or restarts workflow)
            while not stop_flag.is_set():
                _time.sleep(5)
                # Check if task was manually moved to done or back to backlog
                data = _load_projects()
                project = next((x for x in data["projects"] if x["id"] == project_id), None)
                if not project:
                    break
                task = next((t for t in project["tasks"] if t["id"] == task_id), None)
                if not task:
                    break
                done_col = _wf_get_done_col(project)
                backlog_col = _wf_get_backlog_col(project)
                current_col = task.get("columnId")
                if done_col and current_col == done_col["id"]:
                    # Human moved to done — clean up and continue
                    _wf_cleanup_task_sessions(assignee, project_id, task_id)
                    break
                if backlog_col and current_col == backlog_col["id"]:
                    # Human moved back to backlog — skip this task
                    _wf_cleanup_task_sessions(assignee, project_id, task_id)
                    break

            if stop_flag.is_set():
                break

            # If single_task mode, stop; otherwise loop will re-check backlog
            if single_task:
                with _WORKFLOW_LOCK:
                    wf["active"] = False
                break
            else:
                _time.sleep(2)
                continue

    # Pipeline ended (cleanup handled by wrapper in _wf_run_pipeline)


WORKFLOW_STATE_FILE = os.path.join(STATUS_DIR, "workflow-state.json")

def _wf_persist_state(project_id):
    """Persist workflow state to disk so it survives page refreshes and container restarts."""
    with _WORKFLOW_LOCK:
        wf = _WORKFLOW_STATE.get(project_id, {})
    state_data = {}
    try:
        if os.path.isfile(WORKFLOW_STATE_FILE):
            with open(WORKFLOW_STATE_FILE, "r") as f:
                state_data = json.load(f)
    except Exception:
        state_data = {}
    state_data[project_id] = {
        "active": wf.get("active", False),
        "autoMode": wf.get("autoMode", False),
        "currentTaskId": wf.get("currentTaskId"),
        "currentAssignee": wf.get("currentAssignee"),
        "currentTaskTitle": wf.get("currentTaskTitle"),
        "phase": wf.get("phase", "idle"),
        "error": wf.get("error"),
        "reviewCycle": wf.get("reviewCycle", 0),
    }
    try:
        os.makedirs(os.path.dirname(WORKFLOW_STATE_FILE), exist_ok=True)
        with open(WORKFLOW_STATE_FILE, "w") as f:
            json.dump(state_data, f, indent=2)
    except Exception:
        pass
    # Also write shared project-work signal file so OTHER VO instances
    # (e.g. the personal office on 8085) can show project work indicators.
    # This file lives in ~/.openclaw/shared/ which is mounted by all VOs.
    _wf_update_shared_project_work()


def _wf_update_shared_project_work():
    """Write active project-work data to a shared file readable by all VO instances.
    Maps agent IDs to their active project task info."""
    import time as _t
    active_phases = ("in_progress", "dispatching", "reviewing", "rework")
    shared = {}
    with _WORKFLOW_LOCK:
        for pid, wf in _WORKFLOW_STATE.items():
            if not wf.get("active") or wf.get("phase") not in active_phases:
                continue
            agent_id = wf.get("currentAssignee")
            if not agent_id:
                continue
            shared[agent_id] = {
                "projectId": pid,
                "taskId": wf.get("currentTaskId", ""),
                "taskTitle": wf.get("currentTaskTitle", ""),
                "phase": wf.get("phase", ""),
                "updatedAt": int(_t.time() * 1000),
            }
    try:
        shared_path = os.path.join(WORKSPACE_BASE, "shared", "project-work.json")
        os.makedirs(os.path.dirname(shared_path), exist_ok=True)
        with open(shared_path, "w") as f:
            json.dump(shared, f)
    except Exception:
        pass


def _wf_load_persisted_state(project_id):
    """Load persisted workflow state from disk."""
    try:
        if os.path.isfile(WORKFLOW_STATE_FILE):
            with open(WORKFLOW_STATE_FILE, "r") as f:
                state_data = json.load(f)
            return state_data.get(project_id, {})
    except Exception:
        pass
    return {}

def _wf_clear_persisted_state(project_id):
    """Clear persisted state when workflow ends."""
    try:
        if os.path.isfile(WORKFLOW_STATE_FILE):
            with open(WORKFLOW_STATE_FILE, "r") as f:
                state_data = json.load(f)
            state_data.pop(project_id, None)
            with open(WORKFLOW_STATE_FILE, "w") as f:
                json.dump(state_data, f, indent=2)
    except Exception:
        pass


def _handle_workflow_chat(project_id):
    """GET /api/projects/{id}/workflow/chat — get the active workflow agent's session messages.

    ONLY reads from the task-specific workflow session (wf-<project>-<task>),
    never from the agent's main session or other sessions.
    """
    with _WORKFLOW_LOCK:
        wf = _WORKFLOW_STATE.get(project_id, {})

    # Also check persisted state if in-memory is empty
    persisted = _wf_load_persisted_state(project_id)
    current_task_id = wf.get("currentTaskId") or persisted.get("currentTaskId")
    phase = wf.get("phase") or persisted.get("phase", "idle")

    # Find the assigned agent — check current task or find any in-progress/review task
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"ok": True, "messages": [], "agent": None}

    agent_key = None
    task_id = current_task_id

    # First try the tracked current task
    if task_id:
        task = next((t for t in p["tasks"] if t["id"] == task_id), None)
        if task:
            agent_key = task.get("assignee")

    # If no tracked task, find the most recently active task (in progress or review)
    if not agent_key:
        ip_cols = [c["id"] for c in p.get("columns", []) if c.get("title", "").lower() in ("in progress", "review", "to do")]
        active_tasks = [t for t in p.get("tasks", []) if t.get("columnId") in ip_cols]
        if active_tasks:
            active_tasks.sort(key=lambda t: t.get("updatedAt", ""), reverse=True)
            task_id = active_tasks[0]["id"]
            agent_key = active_tasks[0].get("assignee")

    if not agent_key or not task_id:
        return {"ok": True, "messages": [], "agent": None, "phase": phase}

    # Read ONLY from the task-specific workflow session — not the agent's main session
    msgs = _wf_get_task_session_messages(agent_key, project_id, task_id)

    # Check if the workflow session is still actively running
    session_active = _wf_is_task_session_active(agent_key, project_id, task_id)

    return {
        "ok": True,
        "messages": msgs,
        "agent": agent_key,
        "taskId": task_id,
        "phase": phase,
        "sessionActive": session_active,
    }


def _wf_get_task_session_messages(agent_id, project_id, task_id, max_messages=50):
    """Read messages from the task-specific workflow session JSONL only."""
    session_key = _wf_task_session_key(agent_id, project_id, task_id)
    home_path = VO_CONFIG.get("openclaw", {}).get("homePath", os.path.expanduser("~/.openclaw"))
    sessions_dir = os.path.join(home_path, "agents", agent_id, "sessions")
    sessions_json_path = os.path.join(sessions_dir, "sessions.json")

    try:
        with open(sessions_json_path, "r") as f:
            sessions_data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []

    session_info = sessions_data.get(session_key)
    if not session_info:
        return []

    session_id = session_info.get("sessionId", "")
    if not session_id:
        return []

    jsonl_path = os.path.join(sessions_dir, f"{session_id}.jsonl")
    if not os.path.exists(jsonl_path):
        return []

    messages = []
    try:
        # Read tail of file — use a larger buffer to handle long lines (tool results
        # can be 100KB+). Read last 256KB to ensure we capture multiple complete lines.
        TAIL_BYTES = 256 * 1024
        with open(jsonl_path, "rb") as fb:
            fb.seek(0, 2)
            fsize = fb.tell()
            start = max(0, fsize - TAIL_BYTES)
            fb.seek(start)
            tail_data = fb.read().decode("utf-8", errors="replace")
        if start > 0:
            nl = tail_data.find("\n")
            if nl >= 0:
                tail_data = tail_data[nl + 1:]
        for line in tail_data.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = entry.get("message", entry)
            role = msg.get("role")
            if role not in ("user", "assistant"):
                continue
            content = msg.get("content", [])
            text = ""
            tool_info = []
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                for c in content:
                    if isinstance(c, dict):
                        if c.get("type") == "text":
                            text += c.get("text", "")
                        elif c.get("type") == "toolCall":
                            name = c.get("name", "?")
                            args = c.get("arguments", {})
                            tool_info.append({"name": name, "args_preview": str(args)[:100]})
                        elif c.get("type") == "toolResult":
                            pass  # skip tool results for chat display
            if text or tool_info:
                m = {"role": role, "timestamp": msg.get("timestamp", entry.get("timestamp", 0))}
                if text:
                    m["text"] = text[:2000]
                if tool_info:
                    m["tools"] = tool_info[:5]  # cap tool display
                messages.append(m)
        messages = messages[-max_messages:]
    except Exception:
        pass
    return messages


def _wf_is_task_session_active(agent_id, project_id, task_id):
    """Check if the task-specific workflow session is still actively running."""
    session_key = _wf_task_session_key(agent_id, project_id, task_id)
    home_path = VO_CONFIG.get("openclaw", {}).get("homePath", os.path.expanduser("~/.openclaw"))
    sessions_dir = os.path.join(home_path, "agents", agent_id, "sessions")
    sessions_json_path = os.path.join(sessions_dir, "sessions.json")

    try:
        with open(sessions_json_path, "r") as f:
            sessions_data = json.load(f)
        session_info = sessions_data.get(session_key, {})
        status = session_info.get("status", "")
        return status == "running"
    except Exception:
        return False


def _handle_workflow_start(project_id, body=None):
    """POST /api/projects/{id}/workflow/start — start the workflow pipeline."""
    body = body or {}
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}

    with _WORKFLOW_LOCK:
        wf = _WORKFLOW_STATE.get(project_id)
        if wf and wf.get("active"):
            return {"error": "Workflow already running for this project", "_status": 409}

        auto_mode = body.get("autoMode", False)
        stop_flag = threading.Event()
        wf = {
            "active": True,
            "autoMode": auto_mode,
            "currentTaskId": None,
            "phase": "starting",
            "error": None,
            "reviewCycle": 0,
            "stopFlag": stop_flag,
            "thread": None,
        }
        _WORKFLOW_STATE[project_id] = wf

    # Update project workflow settings
    p["workflowActive"] = True
    p["autoMode"] = auto_mode
    p["updatedAt"] = _proj_now()
    _save_projects(data)
    _log_activity(p, "workflow_started", "user", f"Workflow started (autoMode: {auto_mode})")

    _wf_persist_state(project_id)

    # Launch background thread
    single_task = not auto_mode
    t = threading.Thread(target=_wf_run_pipeline, args=(project_id, single_task), daemon=True)
    with _WORKFLOW_LOCK:
        wf["thread"] = t
    t.start()

    return {"ok": True, "status": "started", "autoMode": auto_mode}


def _handle_workflow_stop(project_id):
    """POST /api/projects/{id}/workflow/stop — stop the workflow."""
    with _WORKFLOW_LOCK:
        wf = _WORKFLOW_STATE.get(project_id)
        if not wf or not wf.get("active"):
            return {"ok": True, "status": "already_stopped"}
        wf["stopFlag"].set()
        wf["active"] = False
        wf["phase"] = "stopped"

    _wf_persist_state(project_id)
    _wf_clear_persisted_state(project_id)

    # Update project
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if p:
        p["workflowActive"] = False
        p["updatedAt"] = _proj_now()
        _save_projects(data)
        _log_activity(p, "workflow_stopped", "user", "Workflow stopped by user")

    return {"ok": True, "status": "stopped"}


def _handle_workflow_auto_mode(project_id, body):
    """PUT /api/projects/{id}/workflow/auto-mode — toggle auto mode."""
    auto_mode = body.get("autoMode", False)
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    p["autoMode"] = auto_mode
    p["updatedAt"] = _proj_now()
    _save_projects(data)

    with _WORKFLOW_LOCK:
        wf = _WORKFLOW_STATE.get(project_id)
        if wf:
            wf["autoMode"] = auto_mode

    return {"ok": True, "autoMode": auto_mode}


def _handle_workflow_status(project_id):
    """GET /api/projects/{id}/workflow/status — get workflow state."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}

    with _WORKFLOW_LOCK:
        wf = _WORKFLOW_STATE.get(project_id, {})
        # Detect stale state: persisted says active but thread is dead
        thread = wf.get("thread")
        thread_alive = thread is not None and thread.is_alive() if thread else False

    # Merge with persisted state (for page refresh resilience)
    persisted = _wf_load_persisted_state(project_id)
    in_memory_active = wf.get("active", False)
    persisted_active = persisted.get("active", False)

    # If persisted says active but no thread is running, it's stale — clean up
    if persisted_active and not in_memory_active and not thread_alive:
        _wf_clear_persisted_state(project_id)
        persisted_active = False
        persisted["phase"] = persisted.get("phase", "idle")
        # If the phase was a working phase, mark it as stalled
        if persisted.get("phase") in ("in_progress", "reviewing", "reworking", "dispatching"):
            persisted["phase"] = "stalled"

    active = in_memory_active or persisted_active
    phase = wf.get("phase") or persisted.get("phase", "idle")
    current_task = wf.get("currentTaskId") or persisted.get("currentTaskId")
    error = wf.get("error") or persisted.get("error")
    review_cycle = wf.get("reviewCycle", 0) or persisted.get("reviewCycle", 0)

    # Check if the task-specific session is still actively running in OpenClaw
    # This catches cases where the workflow thread is mid-API-call (active=True in session)
    # but the in-memory state hasn't been updated yet
    session_active = False
    if current_task and not active:
        # Find the assignee for the current task
        task = next((t for t in p.get("tasks", []) if t["id"] == current_task), None)
        if task and task.get("assignee"):
            session_active = _wf_is_task_session_active(task["assignee"], project_id, current_task)
            if session_active:
                # Session is running but workflow state says inactive — the thread
                # is mid-API-call. Report as active so UI shows progress.
                active = True
                if phase in ("idle", "stalled", "blocked_by_active_task"):
                    phase = "working"

    return {
        "ok": True,
        "active": active,
        "autoMode": p.get("autoMode", False),
        "currentTaskId": current_task,
        "phase": phase,
        "error": error,
        "reviewCycle": review_cycle,
        "sessionActive": session_active,
    }


def _handle_review_check_update(project_id, task_id, body):
    """PUT /api/projects/{id}/tasks/{taskId}/review-check — update review status."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return {"error": "Project not found", "_status": 404}
    task = next((t for t in p["tasks"] if t["id"] == task_id), None)
    if not task:
        return {"error": "Task not found", "_status": 404}

    review_check = body.get("reviewCheck", [])
    task["reviewCheck"] = review_check
    task["updatedAt"] = _proj_now()
    p["updatedAt"] = _proj_now()
    by = body.get("by", "user")
    _log_activity(p, "review_updated", by, "Review check updated", task_id)
    _save_projects(data)
    # Update task markdown file with review results
    current_col = next((c["title"] for c in p.get("columns", []) if c["id"] == task.get("columnId")), "review")
    _wf_write_task_file(project_id, task, current_col.lower().replace(" ", "_"), review_results=review_check, work_log_entry=f"Review check updated by {by}")
    return {"ok": True, "task": task}


def _handle_template_delete(template_id):
    """DELETE /api/projects/templates/{id}."""
    data = _load_projects()
    before = len(data.get("templates", []))
    data["templates"] = [t for t in data.get("templates", []) if t["id"] != template_id]
    if len(data["templates"]) == before:
        return {"error": "Template not found", "_status": 404}
    _save_projects(data)
    return {"ok": True, "id": template_id}


def _handle_agent_delete(body):
    """Delete an OpenClaw agent — removes from config, agent dir, and workspace."""
    agent_id = (body.get("id") or "").strip()
    if not agent_id:
        return {"error": "Agent ID is required", "_status": 400}

    # Safety: never delete the main agent
    if agent_id == "main":
        return {"error": "Cannot delete the main agent", "_status": 403}

    config_path = os.path.join(WORKSPACE_BASE, "openclaw.json")

    try:
        # 1. Remove from openclaw.json
        with open(config_path, "r") as f:
            config = json.load(f)

        agent_list = config.get("agents", {}).get("list", [])
        agent_entry = None
        for a in agent_list:
            if a.get("id") == agent_id:
                agent_entry = a
                break

        if not agent_entry:
            return {"error": f"Agent '{agent_id}' not found in config", "_status": 404}

        workspace_dir = agent_entry.get("workspace", "")
        agent_list = [a for a in agent_list if a.get("id") != agent_id]
        config["agents"]["list"] = agent_list

        with open(config_path, "w") as f:
            json.dump(config, f, indent=2)

        # 2. Remove agent directory (~/.openclaw/agents/<id>/)
        import shutil
        agent_dir = os.path.join(WORKSPACE_BASE, f"agents/{agent_id}")
        if os.path.isdir(agent_dir):
            shutil.rmtree(agent_dir, ignore_errors=True)

        # 3. Remove workspace directory
        if workspace_dir and os.path.isdir(workspace_dir):
            shutil.rmtree(workspace_dir, ignore_errors=True)

        # 4. Signal gateway to reload
        _signal_gateway_reload()

        # 5. Refresh discovery
        global _discovered_at
        _discovered_at = 0
        refresh_agent_maps()

        return {
            "ok": True,
            "agentId": agent_id,
            "message": f"Agent '{agent_id}' deleted successfully"
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": str(e), "_status": 500}


##############################################################################

def get_agent_messages(agent_key, max_messages=500):
    """Read recent messages from an agent's active session JSONL."""
    agent_id = AGENT_SESSION_IDS.get(agent_key)
    if not agent_id:
        return []
    sessions_dir = os.path.join(WORKSPACE_BASE, f"agents/{agent_id}/sessions")
    sessions_json_path = os.path.join(sessions_dir, "sessions.json")
    jsonl_file = None
    try:
        with open(sessions_json_path, "r") as f:
            sessions = json.load(f)
        # Find the most recently updated session (any type — main, telegram, etc.)
        best_ts = 0
        for key, val in sessions.items():
            if not isinstance(val, dict):
                continue
            ts = val.get("updatedAt", 0)
            sid = val.get("sessionId", "")
            candidate = os.path.join(sessions_dir, f"{sid}.jsonl")
            if ts > best_ts and os.path.exists(candidate):
                best_ts = ts
                jsonl_file = candidate
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    if not jsonl_file:
        jsonls = glob.glob(os.path.join(sessions_dir, "*.jsonl"))
        if jsonls:
            jsonl_file = max(jsonls, key=os.path.getmtime)
    if not jsonl_file:
        return []
    messages = []
    try:
        # Performance: only read the tail of the file (last 32KB) instead of the
        # entire JSONL.  Session files can grow to many megabytes; reading them
        # in full every 3 seconds blocks the server thread and causes UI stutter.
        TAIL_BYTES = 32 * 1024
        with open(jsonl_file, "rb") as fb:
            fb.seek(0, 2)  # end
            fsize = fb.tell()
            start = max(0, fsize - TAIL_BYTES)
            fb.seek(start)
            tail_data = fb.read().decode("utf-8", errors="replace")
        # If we seeked into the middle of a line, drop the first partial line
        if start > 0:
            nl = tail_data.find("\n")
            if nl >= 0:
                tail_data = tail_data[nl + 1:]
        for line in tail_data.split("\n"):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "message":
                    continue
                msg = entry.get("message", {})
                role = msg.get("role", "")
                ts = entry.get("timestamp", "")
                if role == "toolResult":
                    continue
                content = msg.get("content", "")
                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    parts = []
                    tool_calls = []
                    for item in content:
                        if isinstance(item, dict):
                            if item.get("type") == "text":
                                t = item.get("text", "").strip()
                                if t:
                                    parts.append(t)
                            elif item.get("type") == "toolCall":
                                name = item.get("name", "")
                                args = item.get("arguments", {})
                                if name == "exec":
                                    cmd = args.get("command", "")
                                    if "office.py" in cmd:
                                        tool_calls.append(f"\u2699\ufe0f {cmd.split('office.py')[1].strip()[:80]}")
                                    elif "openclaw agent" in cmd:
                                        m_agent = re_module.search(r'--agent\s+(\S+)', cmd)
                                        m_msg = re_module.search(r'--message\s+"([^"]*)"', cmd)
                                        aname = m_agent.group(1) if m_agent else "?"
                                        mtxt = m_msg.group(1)[:60] if m_msg else ""
                                        tool_calls.append(f"\ud83d\udce1 \u2192 {aname}: {mtxt}")
                                    else:
                                        tool_calls.append(f"\u2699\ufe0f {cmd[:60]}")
                                elif name == "process":
                                    tool_calls.append("\u23f3 polling...")
                                elif name == "read":
                                    tool_calls.append("\ud83d\udcc4 reading file")
                                elif name == "sessions_send":
                                    smsg = args.get("message", "")[:60]
                                    slabel = args.get("label", args.get("sessionKey", ""))
                                    tool_calls.append(f"\ud83d\udce8 \u2192 {slabel}: {smsg}")
                                else:
                                    tool_calls.append(f"\ud83d\udd27 {name}")
                    text = "\n".join(parts)
                    if tool_calls:
                        tc_text = "\n".join(tool_calls)
                        text = f"{text}\n{tc_text}" if text else tc_text
                if not text:
                    continue
                from_agent = ""
                prov = msg.get("provenance", {})
                if role == "user" and prov:
                    source = prov.get("sourceSessionKey", "")
                    # Match source session key to any discovered agent
                    for _da in get_roster():
                        if _da["id"] in source or _da["statusKey"] in source:
                            from_agent = _da["name"].lower()
                            break
                # Format timestamp for display
                short_ts = ""
                if ts:
                    try:
                        from datetime import datetime, timezone
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        # Use system local timezone (portable — no hardcoded tz)
                        et = dt.astimezone()
                        short_ts = et.strftime("%I:%M %p").lstrip("0")
                    except Exception:
                        short_ts = ""
                messages.append({"role": role, "text": text[:500], "ts": ts, "time": short_ts, "from": from_agent})
    except Exception as e:
        return []
    return messages[-max_messages:]

GATEWAY_URL = VO_CONFIG["openclaw"]["gatewayUrl"]
GATEWAY_URL_FALLBACK = GATEWAY_URL.replace("127.0.0.1", "localhost") if "127.0.0.1" in GATEWAY_URL else GATEWAY_URL

# Extract gateway port for local Host header override.
# When connecting via Docker bridge (host.docker.internal), websockets sets
# Host: host.docker.internal:PORT which the gateway treats as non-local,
# triggering origin allowlist checks. By overriding Host to 127.0.0.1:PORT,
# the gateway correctly recognizes the connection as local and skips the check.
def _compute_local_host_header(gw_url):
    from urllib.parse import urlparse
    parsed = urlparse(gw_url)
    port = parsed.port or 18789
    return f"127.0.0.1:{port}"

_GW_LOCAL_HOST = _compute_local_host_header(GATEWAY_URL)


def _get_gateway_token():
    """Get the gateway auth token. Checks vo-config override first, then openclaw.json."""
    # Check for user override in vo-config.json
    vo_token = (VO_CONFIG.get("openclaw") or {}).get("gatewayToken", "")
    if vo_token:
        return vo_token
    # Fall back to openclaw.json
    try:
        with open(CONFIG_PATH, "r") as f:
            cfg = json.load(f)
        return cfg.get("gateway", {}).get("auth", {}).get("token", "")
    except Exception:
        return ""


def _auto_configure_gateway_origin():
    """Auto-configure the OpenClaw gateway to accept connections from this VO instance.

    Adds the VO's origin to gateway.controlUi.allowedOrigins in openclaw.json
    and signals the gateway to reload. This makes Docker bridge networking
    work without any manual gateway configuration — truly plug and play.

    Safe for all setups:
    - --network host: gateway treats connection as local, skips origin check (no-op)
    - Docker bridge: origin gets added to allowlist on first boot
    - Already configured: detects existing entry, skips
    """
    origin = f"http://127.0.0.1:{PORT}"
    try:
        try:
            with open(CONFIG_PATH, "r") as f:
                cfg = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            print(f"⚠️  Gateway auto-config: cannot read {CONFIG_PATH}")
            return

        gateway_cfg = cfg.setdefault("gateway", {})
        control_ui = gateway_cfg.setdefault("controlUi", {})

        origins = control_ui.get("allowedOrigins", [])
        if not isinstance(origins, list):
            origins = []

        if origin in origins:
            return  # already configured

        origins.append(origin)
        control_ui["allowedOrigins"] = origins
        control_ui["allowInsecureAuth"] = True
        control_ui["dangerouslyDisableDeviceAuth"] = True

        with open(CONFIG_PATH, "w") as f:
            json.dump(cfg, f, indent=2)

        # Signal gateway to reload config
        import subprocess
        try:
            r = subprocess.run(["systemctl", "--user", "kill", "-s", "USR1", "openclaw-gateway.service"],
                               capture_output=True, timeout=5)
            if r.returncode == 0:
                print(f"✅ Gateway auto-config: added origin {origin}, gateway reloaded")
                return
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        # Fallback: scan /proc for gateway process and send SIGUSR1
        import signal as _signal
        try:
            for entry in os.listdir("/proc"):
                if not entry.isdigit():
                    continue
                try:
                    with open(f"/proc/{entry}/cmdline", "r") as f:
                        cmdline = f.read()
                    if "openclaw" in cmdline and "gateway" in cmdline:
                        os.kill(int(entry), _signal.SIGUSR1)
                        print(f"✅ Gateway auto-config: added origin {origin}, signaled PID {entry}")
                        return
                except (PermissionError, FileNotFoundError, ProcessLookupError):
                    continue
        except FileNotFoundError:
            pass  # not on Linux

        print(f"✅ Gateway auto-config: added origin {origin} (gateway will pick up on next restart)")
    except Exception as e:
        print(f"⚠️  Gateway auto-config failed: {e}")
GATEWAY_HTTP = VO_CONFIG["openclaw"]["gatewayHttp"]
CONFIG_PATH = os.path.join(WORKSPACE_BASE, "openclaw.json")
APP_DIR = os.path.dirname(os.path.abspath(__file__))


def _reload_gateway_globals():
    """Reload all gateway-related globals from current VO_CONFIG.
    Call after VO_CONFIG has been refreshed (e.g. after /setup/save)."""
    global GATEWAY_URL, GATEWAY_URL_FALLBACK, _GW_LOCAL_HOST, GATEWAY_HTTP
    global CONFIG_PATH, AUTH_PROFILES_PATH
    GATEWAY_URL = VO_CONFIG["openclaw"]["gatewayUrl"]
    GATEWAY_URL_FALLBACK = GATEWAY_URL.replace("127.0.0.1", "localhost") if "127.0.0.1" in GATEWAY_URL else GATEWAY_URL
    _GW_LOCAL_HOST = _compute_local_host_header(GATEWAY_URL)
    GATEWAY_HTTP = VO_CONFIG["openclaw"]["gatewayHttp"]
    CONFIG_PATH = os.path.join(WORKSPACE_BASE, "openclaw.json")
    AUTH_PROFILES_PATH = os.path.join(WORKSPACE_BASE, "agents/main/agent/auth-profiles.json")


# ---------------------------------------------------------------------------
# API Usage Collector — background thread that fetches quota data directly
# from provider APIs using credentials from OpenClaw auth profiles.
# No CLI dependency. Pure Python. Works in any environment.
# ---------------------------------------------------------------------------

# Provider display names
_PROVIDER_LABELS = {
    "anthropic": "Claude",
    "openai-codex": "Codex",
    "openai": "OpenAI",
    "github-copilot": "Copilot",
    "google-gemini-cli": "Gemini",
    "minimax": "MiniMax",
    "zai": "Z.AI",
}


class ApiUsageCollector:
    """Collects API usage/quota data directly from provider endpoints.

    Reads auth profiles from OpenClaw's auth-profiles.json, then calls each
    provider's usage API to get real quota windows (daily/weekly percentages,
    reset times, etc.).

    Runs in a background thread. The HTTP handler reads the cached result.
    """

    INTERVAL = 60  # seconds between collections
    REQUEST_TIMEOUT = 15  # seconds per provider API call

    def __init__(self, auth_profiles_path):
        self._auth_profiles_path = auth_profiles_path
        self._data = {"providers": [], "timestamp": 0, "source": "initializing"}
        self._lock = threading.Lock()
        self._thread = None

    def start(self):
        """Start the background collection thread."""
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="api-usage-collector")
        self._thread.start()

    def get_data(self):
        """Thread-safe read of the latest usage data."""
        with self._lock:
            return dict(self._data)

    def _run_loop(self):
        import time as _time
        _time.sleep(3)  # let server start
        while True:
            try:
                data = self._collect()
                with self._lock:
                    self._data = data
            except Exception as e:
                with self._lock:
                    self._data = {"providers": [], "timestamp": _time.time(), "error": str(e), "source": "error"}
            _time.sleep(self.INTERVAL)

    def _read_profiles(self):
        """Read auth profiles and return {profileId: profileData} for supported providers."""
        try:
            with open(self._auth_profiles_path, "r") as f:
                ap = json.load(f)
            return ap.get("profiles", {})
        except Exception:
            return {}

    def _collect(self):
        """Run one collection cycle across all configured providers."""
        import time as _time
        now = _time.time()
        profiles = self._read_profiles()
        if not profiles:
            return {"providers": [], "timestamp": now, "source": "no-profiles"}

        providers = []
        seen = set()

        for pid, profile in profiles.items():
            prov = profile.get("provider", pid.split(":")[0])
            if prov in seen:
                continue

            token = profile.get("access") or profile.get("token")
            api_key = profile.get("key")
            account_id = profile.get("accountId")

            result = None
            if prov == "anthropic" and token:
                result = self._fetch_claude(token, now)
            elif prov == "openai-codex" and token:
                result = self._fetch_codex(token, account_id, now)
            elif prov == "github-copilot" and token:
                result = self._fetch_copilot(token, now)
            elif api_key and prov not in ("ollama", "lmstudio"):
                # API key provider — no usage endpoint, just list it
                result = {
                    "provider": prov,
                    "displayName": _PROVIDER_LABELS.get(prov, prov.replace("-", " ").title()),
                    "type": "api_key",
                    "usage": None,
                }

            if result:
                providers.append(result)
                seen.add(prov)

        return {"providers": providers, "timestamp": now, "source": "direct-api"}

    def _http_get(self, url, headers):
        """Make an HTTP GET request. Returns (status, response_body_dict_or_None)."""
        import urllib.request
        import urllib.error
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=self.REQUEST_TIMEOUT) as resp:
                body = json.loads(resp.read().decode())
                return resp.status, body
        except urllib.error.HTTPError as e:
            # Try to parse error body
            try:
                body = json.loads(e.read().decode())
            except Exception:
                body = None
            return e.code, body
        except Exception:
            return 0, None

    # --- Anthropic (Claude) ---
    def _fetch_claude(self, token, now):
        """Fetch Claude usage from Anthropic OAuth endpoint."""
        status, data = self._http_get("https://api.anthropic.com/api/oauth/usage", {
            "Authorization": f"Bearer {token}",
            "User-Agent": "openclaw",
            "Accept": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
        })
        entry = {
            "provider": "anthropic",
            "displayName": _PROVIDER_LABELS.get("anthropic", "Claude"),
        }
        if status != 200 or not data:
            msg = ""
            if data and isinstance(data, dict):
                msg = data.get("error", {}).get("message", "") if isinstance(data.get("error"), dict) else str(data.get("error", ""))
            entry["error"] = f"HTTP {status}: {msg}" if msg else f"HTTP {status}"
            return entry

        # Parse usage windows
        windows = []
        if isinstance(data.get("five_hour"), dict) and data["five_hour"].get("utilization") is not None:
            windows.append({
                "label": "5h",
                "usedPercent": min(100, max(0, data["five_hour"]["utilization"])),
                "resetAt": int(self._parse_ts(data["five_hour"].get("resets_at"))) if data["five_hour"].get("resets_at") else 0,
            })
        if isinstance(data.get("seven_day"), dict) and data["seven_day"].get("utilization") is not None:
            windows.append({
                "label": "Week",
                "usedPercent": min(100, max(0, data["seven_day"]["utilization"])),
                "resetAt": int(self._parse_ts(data["seven_day"].get("resets_at"))) if data["seven_day"].get("resets_at") else 0,
            })
        # Model-specific windows (sonnet/opus)
        for key, label in [("seven_day_sonnet", "Sonnet"), ("seven_day_opus", "Opus")]:
            mw = data.get(key)
            if isinstance(mw, dict) and mw.get("utilization") is not None:
                windows.append({
                    "label": label,
                    "usedPercent": min(100, max(0, mw["utilization"])),
                })

        if windows:
            entry["usage"] = self._windows_to_usage(windows, now)
            entry["windows"] = windows
        return entry

    # --- OpenAI Codex ---
    def _fetch_codex(self, token, account_id, now):
        """Fetch Codex/ChatGPT usage from OpenAI endpoint."""
        headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": "CodexBar",
            "Accept": "application/json",
        }
        if account_id:
            headers["ChatGPT-Account-Id"] = account_id

        status, data = self._http_get("https://chatgpt.com/backend-api/wham/usage", headers)
        entry = {
            "provider": "openai-codex",
            "displayName": _PROVIDER_LABELS.get("openai-codex", "Codex"),
        }
        if status != 200 or not data:
            entry["error"] = f"HTTP {status}"
            return entry

        windows = []
        rl = data.get("rate_limit", {})

        # Primary window (usually 3h or 5h)
        pw = rl.get("primary_window")
        if pw:
            hours = round((pw.get("limit_window_seconds", 10800)) / 3600)
            windows.append({
                "label": f"{hours}h",
                "usedPercent": min(100, max(0, pw.get("used_percent", 0))),
                "resetAt": int(pw["reset_at"] * 1000) if pw.get("reset_at") else 0,
            })

        # Secondary window (usually week)
        sw = rl.get("secondary_window")
        if sw:
            hours = round((sw.get("limit_window_seconds", 86400)) / 3600)
            # Determine label
            label = "Week" if hours >= 168 else f"{hours}h" if hours < 24 else "Day"
            # Check if gap between resets suggests weekly
            if pw and sw.get("reset_at") and pw.get("reset_at"):
                if sw["reset_at"] - pw["reset_at"] >= 4320 * 60:
                    label = "Week"
            windows.append({
                "label": label,
                "usedPercent": min(100, max(0, sw.get("used_percent", 0))),
                "resetAt": int(sw["reset_at"] * 1000) if sw.get("reset_at") else 0,
            })

        # Plan info
        plan = data.get("plan_type")
        credits = data.get("credits", {})
        if credits.get("balance") is not None:
            balance = float(credits["balance"]) if credits["balance"] else 0
            plan = f"{plan} (${balance:.2f})" if plan else f"${balance:.2f}"
        entry["plan"] = plan

        if windows:
            entry["usage"] = self._windows_to_usage(windows, now)
            entry["windows"] = windows
        return entry

    # --- GitHub Copilot ---
    def _fetch_copilot(self, token, now):
        """Fetch GitHub Copilot usage."""
        status, data = self._http_get("https://api.github.com/copilot_internal/v2/token", {
            "Authorization": f"token {token}",
            "Accept": "application/json",
            "User-Agent": "openclaw",
        })
        entry = {
            "provider": "github-copilot",
            "displayName": _PROVIDER_LABELS.get("github-copilot", "Copilot"),
        }
        if status != 200:
            entry["error"] = f"HTTP {status}"
        # Copilot doesn't expose usage windows in the same way
        return entry

    # --- Helpers ---
    @staticmethod
    def _windows_to_usage(windows, now):
        """Convert raw windows list to structured usage object with pctLeft/timeLeft."""
        usage = {}
        for w in windows:
            label = (w.get("label") or "").lower()
            used = w.get("usedPercent", 0)
            left = 100 - used
            reset_at = w.get("resetAt", 0)
            time_left = ApiUsageCollector._format_time_left(reset_at, now) if reset_at else ""

            if label in ("5h", "day", "daily", "24h", "3h"):
                usage["dailyPctLeft"] = left
                usage["dailyWindow"] = w.get("label", "Day")
                usage["dailyTimeLeft"] = time_left
            elif label in ("week", "weekly"):
                usage["weeklyPctLeft"] = left
                usage["weeklyTimeLeft"] = time_left
            elif label in ("month", "monthly"):
                usage["monthlyPctLeft"] = left
                usage["monthlyTimeLeft"] = time_left
            elif label in ("sonnet", "opus"):
                usage[f"{label}PctLeft"] = left
            else:
                usage[f"{label}PctLeft"] = left
                usage[f"{label}TimeLeft"] = time_left
        return usage

    @staticmethod
    def _format_time_left(reset_at_ms, now_s):
        """Format time until reset as human-readable string."""
        diff = (reset_at_ms / 1000) - now_s
        if diff <= 0:
            return "resetting..."
        hours = int(diff // 3600)
        mins = int((diff % 3600) // 60)
        if hours > 24:
            days = hours // 24
            return f"{days}d {hours % 24}h"
        if hours > 0:
            return f"{hours}h {mins}m"
        return f"{mins}m"

    @staticmethod
    def _parse_ts(val):
        """Parse a timestamp string to milliseconds."""
        if not val:
            return 0
        if isinstance(val, (int, float)):
            return val * 1000 if val < 1e12 else val
        try:
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
            return dt.timestamp() * 1000
        except Exception:
            return 0


# Initialize the collector (started in __main__)
_api_usage_collector = ApiUsageCollector(AUTH_PROFILES_PATH)


class OfficeHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def do_GET(self):
        # Setup wizard page
        if self.path == "/setup":
            setup_path = os.path.join(os.path.dirname(__file__), "setup.html")
            try:
                with open(setup_path, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Setup page not found")
            return
        elif self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "status": "running"}).encode())
        elif self.path == "/e2e-health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "test": "e2e"}).encode())
        elif self.path == "/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            # Sync meetings from file on every status poll (office.py writes here)
            gateway_presence._sync_meetings_from_file()
            state = gateway_presence.get_state()
            self.wfile.write(json.dumps(state).encode())
        elif self.path == "/agents-list":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            # Return dynamically discovered agent roster
            refresh_agent_maps()
            # Load office-config overrides for agent names/emoji/branch
            _oc_overrides = {}
            _oc_branches = {}
            try:
                _oc_path = os.path.join(STATUS_DIR, "office-config.json")
                with open(_oc_path, "r") as f:
                    _oc_data = json.load(f)
                for _oc_agent in _oc_data.get("agents", []):
                    _oc_id = _oc_agent.get("id", "")
                    if _oc_id:
                        _oc_overrides[_oc_id] = _oc_agent
                # Build branch ID → display name map
                for _br in _oc_data.get("branches", []):
                    _br_id = _br.get("id", "")
                    if _br_id:
                        _oc_branches[_br_id] = _br.get("name", _br_id)
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            agents = []
            for a in get_roster():
                session_key = f"agent:{a['id']}:main"
                # Prefer office-config name/emoji over IDENTITY.md
                oc = _oc_overrides.get(a["statusKey"], {})
                # Resolve branch ID to display name
                branch_id = oc.get("branch", "")
                branch_name = _oc_branches.get(branch_id, "") if branch_id else ""
                if not branch_name:
                    branch_name = "Unassigned"
                agents.append({
                    "key": a["statusKey"],
                    "agentId": a["id"],
                    "sessionKey": session_key,
                    "emoji": oc.get("emoji") or a["emoji"],
                    "name": oc.get("name") or a["name"],
                    "role": a.get("role", ""),
                    "model": a.get("model", ""),
                    "lastActiveAt": a.get("lastActiveAt", 0),
                    "branch": branch_name,
                })
            # Enforce agent limit in demo mode
            agent_limit = get_agent_limit()
            if agent_limit > 0 and len(agents) > agent_limit:
                agents = agents[:agent_limit]
            self.wfile.write(json.dumps({"agents": agents}).encode())
        elif self.path == "/gateway-info":
            # Tell the browser WS port + gateway token for chat connection
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"wsPort": WS_PORT, "token": _get_gateway_token()}).encode())
        elif self.path == "/agent-chat":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result = {}
            for agent_key in AGENT_SESSION_IDS:
                msgs = get_agent_messages(agent_key, max_messages=500)
                if msgs:
                    result[agent_key] = msgs
            # Build project-work map: which agents are currently working on project tasks
            # Primary detection: check each agent's most recently active session key
            # for the "wf-" prefix (workflow sessions created by the project system).
            # This works across all VO instances since they read the same session files.
            project_work = {}
            for agent_key, agent_id in AGENT_SESSION_IDS.items():
                try:
                    sdir = os.path.join(WORKSPACE_BASE, f"agents/{agent_id}/sessions")
                    sjson = os.path.join(sdir, "sessions.json")
                    with open(sjson, "r") as _sf:
                        sdata = json.load(_sf)
                    best_ts = 0
                    best_key = ""
                    for skey, sval in sdata.items():
                        if not isinstance(sval, dict):
                            continue
                        sts = sval.get("updatedAt", 0)
                        if sts > best_ts:
                            best_ts = sts
                            best_key = skey
                    # Detect workflow session: key contains ":wf-"
                    if best_key and ":wf-" in best_key:
                        import time as _time_mod
                        if _time_mod.time() - best_ts / 1000 < 300:
                            project_work[agent_key] = {
                                "projectId": "",
                                "taskId": "",
                                "taskTitle": "Project task",
                                "phase": "in_progress",
                            }
                except Exception:
                    pass
            # Enrich with in-memory workflow state / persisted state (has task titles etc.)
            active_phases = ("in_progress", "dispatching", "reviewing", "rework")
            # 1) Collect from in-memory workflow state
            wf_entries = {}
            with _WORKFLOW_LOCK:
                for pid, wf in _WORKFLOW_STATE.items():
                    wf_entries[pid] = dict(wf)
            # 2) Merge persisted state for workflows not in memory
            try:
                if os.path.isfile(WORKFLOW_STATE_FILE):
                    with open(WORKFLOW_STATE_FILE, "r") as _pwf:
                        persisted_wfs = json.load(_pwf)
                    for pid, pwf in persisted_wfs.items():
                        if pid not in wf_entries:
                            wf_entries[pid] = pwf
                        else:
                            for k in ("currentAssignee", "currentTaskTitle", "currentTaskId"):
                                if not wf_entries[pid].get(k) and pwf.get(k):
                                    wf_entries[pid][k] = pwf[k]
            except Exception:
                pass
            # Build from workflow entries
            proj_data = None
            for pid, wf in wf_entries.items():
                if not wf.get("active") or wf.get("phase") not in active_phases:
                    continue
                agent_id = wf.get("currentAssignee")
                task_title = wf.get("currentTaskTitle", "")
                task_id = wf.get("currentTaskId", "")
                if not agent_id and task_id:
                    if not proj_data:
                        proj_data = _load_projects()
                    p = next((x for x in proj_data.get("projects", []) if x["id"] == pid), None)
                    if p:
                        task = next((t for t in p.get("tasks", []) if t["id"] == task_id), None)
                        if task:
                            agent_id = task.get("assignee")
                            if not task_title:
                                task_title = task.get("title", "")
                if not agent_id:
                    continue
                for sk, aid in AGENT_SESSION_IDS.items():
                    if aid == agent_id:
                        project_work[sk] = {
                            "projectId": pid,
                            "taskId": task_id,
                            "taskTitle": task_title,
                            "phase": wf.get("phase", ""),
                        }
                        break
            # 3) Fallback: scan projects.json for workflowActive projects with
            #    tasks sitting in "In Progress" or "Review" columns — covers the
            #    case where the workflow thread died or the container restarted
            #    but the task was never moved back.
            if not proj_data:
                proj_data = _load_projects()
            for p in proj_data.get("projects", []):
                pid = p["id"]
                if pid in project_work:
                    continue  # already found via workflow state
                if not p.get("workflowActive"):
                    continue
                active_col_ids = set()
                for c in p.get("columns", []):
                    ct = c.get("title", "").lower()
                    if ct in ("in progress", "review"):
                        active_col_ids.add(c["id"])
                if not active_col_ids:
                    continue
                for task in p.get("tasks", []):
                    if task.get("columnId") not in active_col_ids:
                        continue
                    assignee = task.get("assignee")
                    if not assignee:
                        continue
                    col_title = ""
                    for c in p.get("columns", []):
                        if c["id"] == task.get("columnId"):
                            col_title = c.get("title", "")
                            break
                    phase = "in_progress" if col_title.lower() == "in progress" else "reviewing"
                    for sk, aid in AGENT_SESSION_IDS.items():
                        if aid == assignee and sk not in project_work:
                            project_work[sk] = {
                                "projectId": pid,
                                "taskId": task["id"],
                                "taskTitle": task.get("title", ""),
                                "phase": phase,
                            }
                            break
            # Update shared file so other VO instances can see project work
            if project_work:
                try:
                    import time as _t
                    shared = {}
                    now_ms = int(_t.time() * 1000)
                    for sk, info in project_work.items():
                        agent_id = AGENT_SESSION_IDS.get(sk, sk)
                        shared[agent_id] = {
                            "projectId": info.get("projectId", ""),
                            "taskId": info.get("taskId", ""),
                            "taskTitle": info.get("taskTitle", ""),
                            "phase": info.get("phase", ""),
                            "updatedAt": now_ms,
                        }
                    shared_path = os.path.join(WORKSPACE_BASE, "shared", "project-work.json")
                    os.makedirs(os.path.dirname(shared_path), exist_ok=True)
                    with open(shared_path, "w") as _spf:
                        json.dump(shared, _spf)
                except Exception:
                    pass
            result["_projectWork"] = project_work
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/browser-controller":
            # Return which agent currently has browser control
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                with open(os.path.join(STATUS_DIR, "browser-controller.json"), "r") as f:
                    data = json.loads(f.read())
                # Stale if older than 120 seconds
                import time
                if time.time() - data.get("ts", 0) > 120:
                    data = {"agent": None}
                self.wfile.write(json.dumps(data).encode())
            except Exception:
                self.wfile.write(json.dumps({"agent": None}).encode())
        elif self.path == "/browser-status":
            # Health check for browser feature
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            enabled = VO_CONFIG.get("features", {}).get("browserPanel", False) and check_feature("browserPanel")
            cdp_url = VO_CONFIG.get("browser", {}).get("cdpUrl")
            viewer_url = VO_CONFIG.get("browser", {}).get("viewerUrl")
            cdp_available = False
            if enabled and cdp_url:
                try:
                    import urllib.request
                    urllib.request.urlopen(cdp_url.rstrip("/") + "/json", timeout=2)
                    cdp_available = True
                except Exception:
                    pass
            self.wfile.write(json.dumps({
                "enabled": enabled,
                "cdpAvailable": cdp_available,
                "viewerUrl": viewer_url,
                "cdpUrl": cdp_url
            }).encode())
        elif self.path == "/browser-tabs":
            # Proxy CDP tab list for browser URL bar
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            cdp_url = VO_CONFIG.get("browser", {}).get("cdpUrl")
            if not cdp_url:
                self.wfile.write(json.dumps({"available": False}).encode())
            else:
                try:
                    import urllib.request
                    req = urllib.request.urlopen(cdp_url.rstrip("/") + "/json", timeout=2)
                    tabs = json.loads(req.read().decode())
                    self.wfile.write(json.dumps(tabs).encode())
                except Exception as e:
                    self.wfile.write(json.dumps({"available": False, "error": str(e)}).encode())
        elif self.path == "/session-info":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            info = self._get_session_info()
            self.wfile.write(json.dumps(info).encode())
        elif self.path == "/models":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            models = self._get_models()
            self.wfile.write(json.dumps(models).encode())
        elif self.path == "/config/providers":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            data = self._get_providers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/pc-metrics":
            # Proxy PC metrics from remote machine (configurable)
            import urllib.request
            _pc_url = VO_CONFIG["pcMetrics"].get("url")
            if not _pc_url or not VO_CONFIG["features"]["pcMetrics"]:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b'{"error":"PC metrics not configured"}')
                return
            try:
                req = urllib.request.urlopen(_pc_url, timeout=4)
                data = req.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        elif self.path == "/api-usage":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            data = self._get_api_usage()
            self.wfile.write(json.dumps(data).encode())
        elif self.path.startswith("/agent-bio/"):
            agent_key = self.path.split("/agent-bio/")[1]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            bio = self._read_agent_bio(agent_key)
            self.wfile.write(json.dumps(bio).encode())
        elif self.path == "/sms-status":
            # SMS feature health/config check
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            sms_cfg = VO_CONFIG.get("sms", {})
            enabled = VO_CONFIG.get("features", {}).get("smsPanel", False) and check_feature("smsPanel")
            self.wfile.write(json.dumps({
                "enabled": enabled,
                "agentId": sms_cfg.get("agentId"),
                "hasCredentials": bool(sms_cfg.get("twilioAccountSid") and sms_cfg.get("twilioAuthToken") and sms_cfg.get("fromNumber")),
            }).encode())
        elif self.path == "/sms-log":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            sms_log = self._get_sms_log()
            self.wfile.write(json.dumps(sms_log).encode())
        elif self.path == "/sms-mode":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                mode_path = os.path.join(STATUS_DIR, "sms-mode.json")
                with open(mode_path) as f:
                    mode = json.load(f)
            except:
                mode = {"active": "agent"}
            self.wfile.write(json.dumps(mode).encode())
        elif self.path == "/sms-contacts":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            contacts = self._get_sms_contacts()
            self.wfile.write(json.dumps(contacts).encode())
        elif self.path == "/api/agents":
            # Full discovered agent roster
            refresh_agent_maps()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            roster = []
            for a in get_roster():
                roster.append({
                    "id": a["id"],
                    "statusKey": a["statusKey"],
                    "name": a["name"],
                    "emoji": a["emoji"],
                    "role": a.get("role", ""),
                    "model": a.get("model", ""),
                    "lastActiveAt": a.get("lastActiveAt", 0),
                })
            # Enforce agent limit in demo mode
            agent_limit = get_agent_limit()
            if agent_limit > 0 and len(roster) > agent_limit:
                roster = roster[:agent_limit]
            self.wfile.write(json.dumps({"agents": roster}).encode())
        elif self.path.startswith("/api/agent/") and "/skills" in self.path:
            # GET /api/agent/<id>/skills — list skills for an agent
            parts = self.path.split("/api/agent/")[1].split("/skills")
            agent_key = parts[0]
            result = _handle_skill_list(agent_key)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/meetings" or self.path == "/api/meetings/active":
            # Return active meetings
            data = _load_meetings_file()
            active = data.get("_meetings", [])
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "meetings": active}).encode())
        elif self.path == "/api/meetings/history":
            # Return meeting history
            data = _load_meetings_file()
            history = data.get("_meetingHistory", [])
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "history": history}).encode())
        elif self.path == "/api/presence" or self.path.startswith("/api/presence/"):
            # Presence API — read from gateway_presence in-memory state
            if self.path == "/api/presence":
                result = gateway_presence.get_state()
            else:
                agent_id = self.path.split("/api/presence/")[1].strip("/")
                result = gateway_presence.get_agent_state(agent_id)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/office-config":
            # Load saved office config (layout, furniture, agents, branches, etc.)
            _oc_path = os.path.join(STATUS_DIR, "office-config.json")
            try:
                with open(_oc_path, "r") as f:
                    data = f.read()
                try:
                    parsed = json.loads(data or "{}")
                except Exception:
                    parsed = {}
                meaningful = bool(
                    (isinstance(parsed, dict) and (
                        parsed.get("canvasWidth") or parsed.get("canvasHeight") or
                        (isinstance(parsed.get("furniture"), list) and len(parsed.get("furniture")) > 0) or
                        (isinstance(parsed.get("branches"), list) and len(parsed.get("branches")) > 0) or
                        parsed.get("floor") or parsed.get("agents") or
                        (isinstance(parsed.get("walls"), dict) and (
                            (isinstance(parsed.get("walls", {}).get("interior"), list) and len(parsed.get("walls", {}).get("interior")) > 0) or
                            (isinstance(parsed.get("walls", {}).get("sections"), list) and len(parsed.get("walls", {}).get("sections")) > 0)
                        ))
                    ))
                )
                if not meaningful:
                    # No saved config — serve bundled default with live agent roster
                    _default_oc2 = os.path.join(os.path.dirname(__file__) or '.', 'default-office-config.json')
                    try:
                        with open(_default_oc2, 'r') as df:
                            ddata = df.read()
                        ddata = _patch_default_config_agents(ddata)
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.end_headers()
                        self.wfile.write(ddata.encode())
                    except FileNotFoundError:
                        self.send_response(404)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.end_headers()
                        self.wfile.write(b'{"error":"No saved config"}')
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data.encode())
            except FileNotFoundError:
                # Try bundled default config with live agent roster
                _default_oc = os.path.join(os.path.dirname(__file__) or '.', 'default-office-config.json')
                try:
                    with open(_default_oc, 'r') as f:
                        data = f.read()
                    data = _patch_default_config_agents(data)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data.encode())
                except FileNotFoundError:
                    self.send_response(404)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(b'{"error":"No saved config"}')
        elif self.path == "/api/license":
            # License status endpoint
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            status = get_license_status()
            self.wfile.write(json.dumps(status).encode())
        elif self.path == "/vo-config":
            # Expose config to frontend
            lic = get_license_status()
            safe_config = {
                "office": VO_CONFIG["office"],
                "features": VO_CONFIG["features"],
                "weather": VO_CONFIG["weather"],
                "openclaw": {
                    "gatewayUrl": VO_CONFIG["openclaw"]["gatewayUrl"],
                    "gatewayHttp": VO_CONFIG["openclaw"]["gatewayHttp"],
                    "homePath": VO_CONFIG["openclaw"]["homePath"],
                    "detected": os.path.isdir(VO_CONFIG["openclaw"]["homePath"]),
                },
                "browser": {
                    "cdpUrl": VO_CONFIG.get("browser", {}).get("cdpUrl"),
                    "viewerUrl": VO_CONFIG.get("browser", {}).get("viewerUrl"),
                },
                "license": {
                    "licensed": lic["licensed"],
                    "tier": lic["tier"],
                    "tierName": lic["tierName"],
                    "demo": lic["demo"],
                    "limits": lic.get("limits"),
                },
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(safe_config).encode())
        elif self.path == "/api/gateway/test":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result = self._test_gateway_connection()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/weather-proxy":
            _wloc = VO_CONFIG["weather"].get("location")
            if not _wloc:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b'{"error":"Weather location not configured. Set weather.location in vo-config.json"}')
                return
            try:
                import urllib.request
                import urllib.parse
                _wloc_encoded = urllib.parse.quote(_wloc, safe='')
                req = urllib.request.Request(f"https://wttr.in/{_wloc_encoded}?format=j1", headers={"User-Agent": "curl/7.68"})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self.send_response(502)
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        elif self.path == "/api/skills-library":
            result = _handle_skills_library_list()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/skills-library/") and self.path != "/api/skills-library/apply" and self.path != "/api/skills-library/upload":
            skill_name = self.path.split("/api/skills-library/")[1].strip("/")
            result = _handle_skills_library_get(skill_name)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        # ── PROJECTS API ────────────────────────────────────────────
        elif self.path == "/api/projects" or self.path.startswith("/api/projects?"):
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            result = _handle_projects_list(qs)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/projects/scores":
            result = _handle_scores_leaderboard()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/projects/templates":
            result = _handle_projects_templates()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and self.path.endswith("/workflow/chat"):
            proj_id = self.path.split("/api/projects/")[1].rsplit("/workflow/chat", 1)[0]
            result = _handle_workflow_chat(proj_id)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and self.path.endswith("/workflow/status"):
            proj_id = self.path.split("/api/projects/")[1].rsplit("/workflow/status", 1)[0]
            result = _handle_workflow_status(proj_id)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and self.path.endswith("/report"):
            proj_id = self.path.split("/api/projects/")[1].rsplit("/report", 1)[0]
            result = _handle_project_report(proj_id)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and "/tasks" not in self.path and "/report" not in self.path and "/workflow" not in self.path:
            proj_id = self.path.split("/api/projects/")[1].strip("/")
            if proj_id and proj_id != "templates":
                result = _handle_project_get(proj_id)
                self.send_response(result.get("_status", 200))
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                result.pop("_status", None)
                self.wfile.write(json.dumps(result).encode())
            else:
                self.send_response(404)
                self.end_headers()
        else:
            super().do_GET()

    def _get_api_usage(self):
        """Return the latest API usage data collected by the background thread."""
        import time as _time
        now = _time.time()
        data = dict(_api_usage_collector.get_data())
        data["ageSeconds"] = round(now - data.get("timestamp", 0), 1)
        return data

    def _read_agent_bio(self, agent_key):
        """Read agent's .md files and return structured bio data."""
        ws_dir = AGENT_WORKSPACES.get(agent_key)
        if not ws_dir:
            return {"error": f"Unknown agent: {agent_key}"}

        ws_path = os.path.join(WORKSPACE_BASE, ws_dir)
        result = {}

        for fname in ["AGENTS.md", "SOUL.md", "MEMORY.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md"]:
            fpath = os.path.join(ws_path, fname)
            try:
                with open(fpath, "r") as f:
                    result[fname] = f.read()
            except FileNotFoundError:
                result[fname] = ""
            except Exception as e:
                result[fname] = f"(error reading: {e})"

        # Read latest daily memory file
        mem_dir = os.path.join(ws_path, "memory")
        result["daily"] = ""
        result["dailyFile"] = ""
        if os.path.isdir(mem_dir):
            md_files = sorted([f for f in os.listdir(mem_dir) if f.endswith(".md")], reverse=True)
            if md_files:
                latest = md_files[0]
                result["dailyFile"] = latest
                try:
                    with open(os.path.join(mem_dir, latest), "r") as f:
                        result["daily"] = f.read()
                except Exception:
                    pass

        return result

    _model_cache = {}  # {provider: {models: [...], ts: timestamp}}
    _CACHE_TTL = 300  # 5 minutes

    def _fetch_provider_models(self, provider, api_key):
        """Fetch live model list from a cloud provider's API."""
        import urllib.request
        import time

        # Check cache
        cached = self.__class__._model_cache.get(provider)
        if cached and (time.time() - cached["ts"]) < self.__class__._CACHE_TTL:
            return cached["models"]

        models = []
        try:
            if provider == "openai":
                req = urllib.request.Request("https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read())
                for m in data.get("data", []):
                    models.append(m.get("id", ""))

            elif provider == "anthropic":
                req = urllib.request.Request("https://api.anthropic.com/v1/models",
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read())
                for m in data.get("data", []):
                    mid = m.get("id", "")
                    if mid:
                        models.append(mid)

            elif provider == "google":
                url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read())
                for m in data.get("models", []):
                    models.append(m.get("name", "").replace("models/", ""))

            elif provider == "groq":
                req = urllib.request.Request("https://api.groq.com/openai/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read())
                for m in data.get("data", []):
                    mid = m.get("id", "")
                    if mid:
                        models.append(mid)

            models.sort()
            self.__class__._model_cache[provider] = {"models": models, "ts": time.time()}
        except Exception as e:
            # Return cached if available, even if stale
            if cached:
                return cached["models"]
            return [f"(error: {str(e)[:60]})"]

        return models

    _registry_cache = {}  # {provider: {models: [...], ts: timestamp}}
    _REGISTRY_TTL = 600  # 10 minutes

    def _fetch_registry_models(self, provider):
        """Fetch models for a provider from configured models in openclaw.json.
        Provider may be "anthropic-token" but we search for "anthropic/" prefix.
        """
        import time

        cached = self.__class__._registry_cache.get(provider)
        if cached and (time.time() - cached["ts"]) < self.__class__._REGISTRY_TTL:
            return cached["models"]

        # Extract base provider name (e.g., "anthropic" from "anthropic-token")
        base_provider = provider.replace("-token", "").replace("-oauth", "")

        models = []
        try:
            with open(CONFIG_PATH, "r") as f:
                cfg = json.load(f)
            configured_models = cfg.get("agents", {}).get("defaults", {}).get("models", {})
            prefix = f"{base_provider}/"
            for model_id in configured_models.keys():
                if model_id.startswith(prefix):
                    short_id = model_id[len(prefix):]
                    models.append(short_id)
            models.sort()
            self.__class__._registry_cache[provider] = {"models": models, "ts": time.time()}
        except Exception as e:
            if cached:
                return cached["models"]
            return [f"(error: {str(e)[:60]})"]

        return models

    def _get_session_info(self):
        """Return current model name and context window for the main session."""
        # Known context windows for built-in models
        KNOWN_CONTEXT = {
            "anthropic/claude-opus-4-6": 1000000,
            "anthropic/claude-sonnet-4-6": 1000000,
            "anthropic/claude-sonnet-4-20250514": 200000,
            "anthropic/claude-haiku-3-5-20241022": 200000,
            "anthropic/claude-3-5-sonnet-20241022": 200000,
            "google/gemini-2.5-flash": 1048576,
            "google/gemini-2.5-pro": 1048576,
            "google/gemini-2.0-flash": 1048576,
            "openai/gpt-4o": 128000,
            "openai/gpt-4o-mini": 128000,
            "openai/o3": 200000,
            "openai/o4-mini": 200000,
        }
        try:
            with open(CONFIG_PATH, "r") as f:
                cfg = json.load(f)
        except Exception as e:
            return {"model": "unknown", "contextWindow": 0, "error": str(e)}

        # Get default model
        model = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", "unknown")

        # Check main agent override
        for a in cfg.get("agents", {}).get("list", []):
            if a.get("default") and a.get("model"):
                model = a["model"]
                break

        # Context window: check custom providers first, then known map
        context_window = KNOWN_CONTEXT.get(model, 0)
        for prov_name, prov_data in cfg.get("models", {}).get("providers", {}).items():
            for m in prov_data.get("models", []):
                full_id = f"{prov_name}/{m['id']}"
                if full_id == model and m.get("contextWindow"):
                    context_window = m["contextWindow"]
                    break

        return {"model": model, "contextWindow": context_window}

    def _get_providers(self):
        """Read providers, auth profiles, and models for the model manager UI."""
        try:
            with open(CONFIG_PATH, "r") as f:
                cfg = json.load(f)
        except Exception as e:
            return {"error": str(e)}

        # Read auth-profiles.json for actual keys and OAuth tokens
        # Separate API keys from subscription/token auth
        auth_profiles = {}
        raw_keys = {}  # provider -> actual key (for API calls)
        try:
            with open(AUTH_PROFILES_PATH, "r") as f:
                ap = json.load(f)
            for pid, profile in ap.get("profiles", {}).items():
                base_provider = profile.get("provider", pid.split(":")[0])
                key = profile.get("key", "")
                access = profile.get("access", "")
                token = profile.get("token", "")
                is_oauth = profile.get("type") in ("oauth", "token") or bool(access) or bool(token)
                
                # For providers with both API key and subscription, create separate entries
                if key:
                    # API key entry
                    masked = (key[:4] + "••••••••") if len(key) > 4 else ""
                    auth_profiles[base_provider] = {
                        "hasKey": True, "maskedKey": masked, "profileId": pid, 
                        "isOAuth": False, "authType": "api_key"
                    }
                    raw_keys[base_provider] = key
                
                if is_oauth and (access or token):
                    # Subscription/OAuth entry - use separate provider name
                    sub_provider = f"{base_provider}-token" if token and not access else f"{base_provider}-oauth"
                    expires = profile.get("expires", 0)
                    import time
                    if expires:
                        remaining = (expires / 1000 - time.time()) if expires > 1e12 else (expires - time.time())
                        days = max(0, int(remaining / 86400))
                        masked = f"OAuth (expires {days}d)"
                    elif token:
                        masked = f"OAuth ({token[:8]}••••)"
                    else:
                        masked = "OAuth"
                    auth_profiles[sub_provider] = {
                        "hasKey": True, "maskedKey": masked, "profileId": pid,
                        "isOAuth": True, "authType": "subscription"
                    }
        except Exception:
            pass

        # Fetch live models for providers with keys
        for provider, key in raw_keys.items():
            if provider in auth_profiles:
                live_models = self._fetch_provider_models(provider, key)
                auth_profiles[provider]["models"] = live_models

        # For OAuth/token providers without API keys, use OpenClaw's model registry
        for provider, info in auth_profiles.items():
            if info.get("isOAuth") and provider not in raw_keys and "models" not in info:
                registry_models = self._fetch_registry_models(provider)
                info["models"] = registry_models

        # Custom providers (ollama etc) from models.providers
        custom_providers = {}
        for prov_name, prov_data in cfg.get("models", {}).get("providers", {}).items():
            custom_providers[prov_name] = {
                "baseUrl": prov_data.get("baseUrl", ""),
                "api": prov_data.get("api", ""),
                "models": [{"id": m["id"], "name": m.get("name", m["id"]),
                            "contextWindow": m.get("contextWindow", 0),
                            "maxTokens": m.get("maxTokens", 0)}
                           for m in prov_data.get("models", [])]
            }

        # Read model params from agents.defaults.models
        model_params = {}
        for mid, mdata in cfg.get("agents", {}).get("defaults", {}).get("models", {}).items():
            p = mdata.get("params", {})
            if p:
                model_params[mid] = p

        # Configured models from agents.defaults.models
        configured_models = {}
        for mid, mdata in cfg.get("agents", {}).get("defaults", {}).get("models", {}).items():
            configured_models[mid] = mdata

        return {"authProfiles": auth_profiles, "customProviders": custom_providers, "modelParams": model_params, "configuredModels": configured_models}

    def _save_provider_key(self, provider, key):
        """Save a cloud provider API key to auth-profiles.json via watcher."""
        request = {
            "type": "save-key",
            "provider": provider,
            "key": key
        }
        return self._send_watcher_request(request)

    def _delete_provider_key(self, provider, profile_id=""):
        """Delete a cloud provider API key."""
        request = {
            "type": "delete-key",
            "provider": provider,
            "profileId": profile_id
        }
        return self._send_watcher_request(request)

    def _save_custom_provider(self, provider, base_url, models, params=None):
        """Save a custom provider config."""
        request = {
            "type": "save-custom-provider",
            "provider": provider,
            "baseUrl": base_url,
            "models": models,
        }
        if params:
            request["params"] = params
        return self._send_watcher_request(request)

    def _send_watcher_request(self, request):
        """Handle config change requests directly — no external watcher needed."""
        try:
            req_type = request.get("type", "")

            if req_type == "set-model":
                return self._handle_set_model(request)
            elif req_type == "save-key":
                return self._handle_save_key(request)
            elif req_type == "delete-key":
                return self._handle_delete_key(request)
            elif req_type == "save-custom-provider":
                return self._handle_save_custom_provider(request)
            else:
                return {"ok": False, "error": f"Unknown request type: {req_type}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _write_openclaw_config(cfg):
        """Write openclaw.json — handles read-only Docker mounts gracefully."""
        try:
            with open(CONFIG_PATH, "w") as f:
                json.dump(cfg, f, indent=2)
            return True, None
        except OSError as e:
            if e.errno in (30, 13):  # EROFS, EACCES
                return False, (
                    "OpenClaw directory is mounted read-only. "
                    "In docker-compose.yml, ensure the volume does NOT end with ':ro'. "
                    "Example: '~/.openclaw:/openclaw' (not '~/.openclaw:/openclaw:ro')"
                )
            return False, str(e)

    def _handle_set_model(self, req):
        """Set an agent's model in openclaw.json and signal the gateway."""
        agent_id = req["agent_id"]
        model_id = req.get("model", "")

        with open(CONFIG_PATH) as f:
            cfg = json.load(f)

        found = False
        for a in cfg.get("agents", {}).get("list", []):
            if a["id"] == agent_id:
                if model_id:
                    a["model"] = model_id
                elif "model" in a:
                    del a["model"]
                found = True
                break

        if not found:
            return {"ok": False, "error": f"Agent {agent_id} not found in config"}

        ok, err = self._write_openclaw_config(cfg)
        if not ok:
            return {"ok": False, "error": err}

        self._signal_gateway(restart=True)
        return {"ok": True, "agent": agent_id, "model": model_id or "(default)"}

    def _handle_save_key(self, req):
        """Save an API key to auth-profiles and openclaw.json."""
        provider = req["provider"]
        key = req["key"]

        # Update auth-profiles.json
        try:
            with open(AUTH_PROFILES_PATH) as f:
                ap = json.load(f)
        except Exception:
            ap = {"version": 1, "profiles": {}, "lastGood": {}}

        profile_id = f"{provider}:default"
        ap["profiles"][profile_id] = {"type": "api_key", "provider": provider, "key": key}
        ap["lastGood"][provider] = profile_id

        try:
            with open(AUTH_PROFILES_PATH, "w") as f:
                json.dump(ap, f, indent=2)
        except OSError as e:
            return {"ok": False, "error": f"Cannot write auth-profiles.json: {e}"}

        # Mirror in openclaw.json
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
        cfg.setdefault("auth", {}).setdefault("profiles", {})[profile_id] = {"provider": provider, "mode": "api_key"}
        ok, err = self._write_openclaw_config(cfg)
        if not ok:
            return {"ok": False, "error": err}

        self._signal_gateway(restart=False)
        masked = key[:4] + "••••••••" if len(key) > 4 else "****"
        return {"ok": True, "provider": provider, "maskedKey": masked}

    def _handle_delete_key(self, req):
        """Delete an API key from auth-profiles and openclaw.json."""
        provider = req["provider"]
        profile_id = req.get("profileId")
        deleted = []

        try:
            with open(AUTH_PROFILES_PATH) as f:
                ap = json.load(f)
            if profile_id:
                to_delete = [profile_id] if profile_id in ap.get("profiles", {}) else []
            else:
                candidates = [f"{provider}:default", f"{provider}:api"]
                to_delete = [k for k in candidates if k in ap.get("profiles", {})]

            for k in to_delete:
                del ap["profiles"][k]
                deleted.append(k)
                if k in ap.get("usageStats", {}):
                    del ap["usageStats"][k]
            if ap.get("lastGood", {}).get(provider) in deleted:
                del ap["lastGood"][provider]

            with open(AUTH_PROFILES_PATH, "w") as f:
                json.dump(ap, f, indent=2)
        except Exception:
            pass

        # Mirror in openclaw.json
        try:
            with open(CONFIG_PATH) as f:
                cfg = json.load(f)
            for k in deleted:
                cfg.get("auth", {}).get("profiles", {}).pop(k, None)
            ok, err = self._write_openclaw_config(cfg)
            if not ok:
                return {"ok": False, "error": err}
        except Exception:
            pass

        self._signal_gateway(restart=False)
        return {"ok": True, "provider": provider, "deletedProfiles": deleted}

    def _handle_save_custom_provider(self, req):
        """Save a custom provider (ollama, lmstudio, etc.) to openclaw.json."""
        provider = req["provider"]
        base_url = req.get("baseUrl", "")
        models = req.get("models", [])

        with open(CONFIG_PATH) as f:
            cfg = json.load(f)

        cfg.setdefault("models", {}).setdefault("providers", {})
        existing = cfg["models"]["providers"].get(provider, {})
        existing["baseUrl"] = base_url
        if not existing.get("api"):
            existing["api"] = "openai-completions"

        old_models = {m["id"]: m for m in existing.get("models", [])}
        new_models = []
        for m in models:
            if m["id"] in old_models:
                updated = old_models[m["id"]]
                updated["name"] = m.get("name", updated.get("name", m["id"]))
                if "contextWindow" in m:
                    updated["contextWindow"] = m["contextWindow"]
                if "maxTokens" in m:
                    updated["maxTokens"] = m["maxTokens"]
                new_models.append(updated)
            else:
                new_models.append({
                    "id": m["id"],
                    "name": m.get("name", m["id"]),
                    "reasoning": False,
                    "input": ["text"],
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    "contextWindow": m.get("contextWindow", 100000),
                    "maxTokens": m.get("maxTokens", 8192),
                })
        existing["models"] = new_models
        cfg["models"]["providers"][provider] = existing

        # Save inference params
        params = req.get("params", {})
        if params:
            defaults_models = cfg.setdefault("agents", {}).setdefault("defaults", {}).setdefault("models", {})
            for model_id, model_params in params.items():
                defaults_models.setdefault(model_id, {})["params"] = model_params

        ok, err = self._write_openclaw_config(cfg)
        if not ok:
            return {"ok": False, "error": err}

        self._signal_gateway(restart=False)
        return {"ok": True, "provider": provider, "modelCount": len(new_models)}

    @staticmethod
    def _signal_gateway(restart=False):
        """Signal the OpenClaw gateway to reload config.

        Tries multiple approaches in order:
        1. systemctl --user (Linux service — works when running on host)
        2. Signal via /proc scan (works with --pid host in Docker)
        3. Signal file (gateway watches for restart trigger)

        Config changes are persisted to disk regardless — gateway picks them up
        on next restart/heartbeat even if signaling fails.
        """
        import subprocess
        import signal as _signal

        # Method 1: systemctl (works on host or with systemd access)
        try:
            if restart:
                r = subprocess.run(["systemctl", "--user", "restart", "openclaw-gateway.service"],
                                   capture_output=True, timeout=10)
            else:
                r = subprocess.run(["systemctl", "--user", "kill", "-s", "USR1", "openclaw-gateway.service"],
                                   capture_output=True, timeout=5)
            if r.returncode == 0:
                return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        # Method 2: scan /proc for gateway process (works with --pid host)
        try:
            for pid_dir in os.listdir("/proc"):
                if not pid_dir.isdigit():
                    continue
                try:
                    with open(f"/proc/{pid_dir}/cmdline", "rb") as f:
                        cmdline = f.read().decode("utf-8", errors="ignore")
                    if "openclaw" in cmdline and ("gateway" in cmdline or "serve" in cmdline):
                        os.kill(int(pid_dir), _signal.SIGUSR2 if restart else _signal.SIGUSR1)
                        return True
                except (PermissionError, ProcessLookupError, FileNotFoundError):
                    continue
        except Exception:
            pass

        # Method 3: pgrep fallback
        try:
            result = subprocess.run(["pgrep", "-f", "openclaw"],
                                    capture_output=True, text=True, timeout=5)
            for pid in result.stdout.strip().split("\n"):
                if pid.strip():
                    os.kill(int(pid.strip()), _signal.SIGUSR1)
                    return True
        except Exception:
            pass

        # Config saved to disk — gateway will pick up changes on next restart
        return False

    def _get_models(self):
        """Read available models from openclaw.json."""
        try:
            with open(CONFIG_PATH, "r") as f:
                cfg = json.load(f)
        except Exception as e:
            return {"error": str(e), "models": [], "agents": {}}

        models = []
        # Default model
        default_model = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", "")
        if default_model:
            models.append({"id": default_model, "label": default_model + " (default)", "provider": default_model.split("/")[0] if "/" in default_model else ""})

        # Cloud models from providers with API keys (live-fetched, cached 5min)
        try:
            with open(AUTH_PROFILES_PATH, "r") as f:
                ap = json.load(f)
            for pid, profile in ap.get("profiles", {}).items():
                provider = profile.get("provider", pid.split(":")[0])
                key = profile.get("key", "")
                if key:
                    live_models = self._fetch_provider_models(provider, key)
                    for m in live_models:
                        if m.startswith("(error"):
                            continue
                        full_id = f"{provider}/{m}"
                        if full_id != default_model and not any(x["id"] == full_id for x in models):
                            models.append({"id": full_id, "label": full_id, "provider": provider})
        except:
            pass

        # Add configured models from agents.defaults.models (includes OAuth providers like openai-codex)
        try:
            configured_models = cfg.get("agents", {}).get("defaults", {}).get("models", {})
            for mid, mdata in configured_models.items():
                if not any(x["id"] == mid for x in models):
                    provider = mid.split("/")[0] if "/" in mid else ""
                    label = mid
                    alias = mdata.get("alias", "")
                    if alias:
                        label = f"{mid} ({alias})"
                    models.append({"id": mid, "label": label, "provider": provider})
        except:
            pass

        # Add subscription/OAuth models from configured models
        try:
            with open(AUTH_PROFILES_PATH, "r") as f:
                ap = json.load(f)
            # Build oauth_providers mapping from auth-profiles
            oauth_providers = {}  # base_provider -> display_name
            for pid, profile in ap.get("profiles", {}).items():
                base_prov = profile.get("provider", pid.split(":")[0])
                if profile.get("type") == "token" or profile.get("token"):
                    oauth_providers[base_prov] = f"{base_prov}-token"
                elif profile.get("type") == "oauth" or profile.get("access"):
                    oauth_providers[base_prov] = f"{base_prov}-oauth"
            
            pass  # oauth_providers built
            
            # Add subscription versions of configured models for providers with both API+token
            subscription_models = []
            configured_models = cfg.get("agents", {}).get("defaults", {}).get("models", {})
            for model in models:
                if "/" not in model["id"]:
                    continue
                base_prov = model["id"].split("/")[0]
                if base_prov in oauth_providers:
                    # Only add subscription version if model is configured (not live API-only)
                    if model["id"] in configured_models:
                        sub_model = dict(model)
                        sub_model["provider"] = oauth_providers[base_prov]
                        if not any(x["id"] == sub_model["id"] and x["provider"] == sub_model["provider"] for x in models):
                            subscription_models.append(sub_model)
            models.extend(subscription_models)
        except Exception as e:
            import sys, traceback
            pass  # silently ignore subscription model errors
            traceback.print_exc(file=sys.stderr)

        # Ollama models from config
        for prov_name, prov_data in cfg.get("models", {}).get("providers", {}).items():
            for m in prov_data.get("models", []):
                mid = f'{prov_name}/{m["id"]}'
                label = m.get("name", m["id"])
                if not any(x["id"] == mid for x in models):
                    models.append({"id": mid, "label": f"{prov_name}/{label}", "provider": prov_name})

        # Per-agent current models
        agents = {}
        for a in cfg.get("agents", {}).get("list", []):
            agents[a["id"]] = a.get("model", "")
        # Map statusKey to agent id
        status_to_agent = {}
        for sk, ws in AGENT_WORKSPACES.items():
            # Find matching agent id
            for a in cfg.get("agents", {}).get("list", []):
                if a.get("workspace", "").endswith(ws) or a["id"] == sk or a["id"] == AGENT_SESSION_IDS.get(sk, ""):
                    status_to_agent[sk] = a["id"]
                    break

        agent_models = {}
        for sk, aid in status_to_agent.items():
            agent_models[sk] = agents.get(aid, "")

        # Identify subscription/OAuth providers for frontend tagging
        sub_providers = {}
        configured_models_map = {}
        try:
            with open(AUTH_PROFILES_PATH, "r") as f:
                ap2 = json.load(f)
            for pid, profile in ap2.get("profiles", {}).items():
                base_prov = profile.get("provider", pid.split(":")[0])
                if profile.get("type") in ("oauth", "token") or profile.get("access") or profile.get("token"):
                    # Map to display provider name
                    if profile.get("token"):
                        display_prov = f"{base_prov}-token"
                    else:
                        display_prov = f"{base_prov}-oauth"
                    sub_providers[display_prov] = True
        except:
            pass
        try:
            for mid, mdata in cfg.get("agents", {}).get("defaults", {}).get("models", {}).items():
                configured_models_map[mid] = True
        except:
            pass

        return {"models": models, "agentModels": agent_models, "defaultModel": default_model, "subProviders": sub_providers, "configuredModels": configured_models_map}

    def _set_agent_model(self, status_key, model_id):
        """Set an agent's model by writing a request file for the host-side watcher."""

        # Map statusKey to agent id
        try:
            with open(CONFIG_PATH, "r") as f:
                cfg = json.load(f)
        except Exception as e:
            return {"ok": False, "error": f"Failed to read config: {e}"}

        agent_id = None
        for sk, ws in AGENT_WORKSPACES.items():
            if sk == status_key:
                for a in cfg.get("agents", {}).get("list", []):
                    if a.get("workspace", "").endswith(ws) or a["id"] == sk or a["id"] == AGENT_SESSION_IDS.get(sk, ""):
                        agent_id = a["id"]
                        break
                break

        if not agent_id:
            return {"ok": False, "error": f"Unknown agent: {status_key}"}

        # Validate model_id format
        if model_id and "/" not in model_id:
            return {"ok": False, "error": f"Invalid model format: {model_id}. Must be provider/model"}

        request = {"type": "set-model", "agent_id": agent_id, "model": model_id, "status_key": status_key}
        return self._send_watcher_request(request)

    def do_PUT(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        # ── PROJECTS PUT ─────────────────────────────────────────────
        if self.path.startswith("/api/projects/") and self.path.endswith("/workflow/auto-mode"):
            proj_id = self.path.split("/api/projects/")[1].rsplit("/workflow/auto-mode", 1)[0]
            result = _handle_workflow_auto_mode(proj_id, body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and "/tasks/" in self.path and self.path.endswith("/review-check"):
            rest = self.path.split("/api/projects/")[1]
            parts = rest.split("/tasks/")
            proj_id = parts[0]
            task_id = parts[1].rsplit("/review-check", 1)[0] if len(parts) > 1 else ""
            result = _handle_review_check_update(proj_id, task_id, body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/"):
            parts = self.path.split("/api/projects/")[1].strip("/").split("/")
            proj_id = parts[0]
            if len(parts) == 1:
                # PUT /api/projects/{id}
                result = _handle_project_update(proj_id, body)
            elif len(parts) == 2 and parts[1] == "columns":
                # PUT /api/projects/{id}/columns
                result = _handle_columns_update(proj_id, body)
            elif len(parts) == 3 and parts[1] == "tasks" and parts[2] == "reorder":
                # PUT /api/projects/{id}/tasks/reorder
                result = _handle_tasks_reorder(proj_id, body)
            elif len(parts) == 3 and parts[1] == "tasks":
                # PUT /api/projects/{id}/tasks/{taskId}
                result = _handle_task_update(proj_id, parts[2], body)
            else:
                result = {"error": "Not found", "_status": 404}
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_DELETE(self):
        if self.path == "/api/agent/delete":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_agent_delete(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path.startswith("/api/meetings/history/"):
            # DELETE /api/meetings/history/<id>
            meet_id = self.path.split("/api/meetings/history/")[1].strip("/")
            result = _handle_meeting_history_delete(meet_id)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path.startswith("/api/agent/") and "/skills/" in self.path:
            # DELETE /api/agent/<id>/skills/<skill-name>
            parts = self.path.split("/api/agent/")[1].split("/skills/")
            agent_key = parts[0]
            skill_name = parts[1].strip("/") if len(parts) > 1 else ""
            result = _handle_skill_delete(agent_key, skill_name)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/skills-library/"):
            skill_name = self.path.split("/api/skills-library/")[1].strip("/")
            result = _handle_skills_library_delete(skill_name)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        # ── PROJECTS DELETE ──────────────────────────────────────────
        elif self.path.startswith("/api/projects/templates/"):
            tpl_id = self.path.split("/api/projects/templates/")[1].strip("/")
            result = _handle_template_delete(tpl_id)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and "/tasks/" in self.path:
            # DELETE /api/projects/{id}/tasks/{taskId}
            rest = self.path.split("/api/projects/")[1]
            parts = rest.split("/tasks/")
            proj_id = parts[0]
            task_id = parts[1].strip("/") if len(parts) > 1 else ""
            result = _handle_task_delete(proj_id, task_id)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/"):
            proj_id = self.path.split("/api/projects/")[1].strip("/")
            result = _handle_project_delete(proj_id)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        # --- SETUP WIZARD ---
        if self.path == "/setup/save":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            cfg_path = _resolve_config_path()
            # Always save to persistent volume if available (survives container recreation)
            data_dir = os.environ.get("VO_STATUS_DIR", "/data")
            persistent_path = os.path.join(data_dir, "vo-config.json")
            if os.path.isdir(data_dir) and cfg_path != persistent_path:
                cfg_path = persistent_path
            try:
                # Merge with existing config — read from resolved path first, fall back to app default
                existing = {}
                for try_path in [cfg_path, os.path.join(os.path.dirname(__file__), "vo-config.json")]:
                    try:
                        with open(try_path, "r") as f:
                            existing = json.load(f)
                        break
                    except (FileNotFoundError, json.JSONDecodeError):
                        continue
                # Deep merge
                for key in body:
                    if key.startswith("_"):
                        continue
                    if isinstance(body[key], dict) and isinstance(existing.get(key), dict):
                        existing[key].update(body[key])
                    else:
                        existing[key] = body[key]
                existing["_setupComplete"] = True
                with open(cfg_path, "w") as f:
                    json.dump(existing, f, indent=2)
                # Reload config and re-discover if path or gateway changed
                global VO_CONFIG, WORKSPACE_BASE, _discovered_roster, _discovered_at
                old_path = WORKSPACE_BASE
                old_gw = GATEWAY_URL
                VO_CONFIG = _load_vo_config()
                WORKSPACE_BASE = VO_CONFIG["openclaw"]["homePath"]
                # Always reload gateway globals (URL, host header, config path)
                _reload_gateway_globals()
                if WORKSPACE_BASE != old_path:
                    _discovered_roster = discover_agents(WORKSPACE_BASE)
                    _discovered_at = _time_mod.time()
                    refresh_agent_maps()
                # Restart gateway presence listener if URL or token changed
                new_token = _get_gateway_token()
                if GATEWAY_URL != old_gw or new_token:
                    if new_token:
                        gateway_presence.stop()
                        gateway_presence.start(GATEWAY_URL, new_token, port=PORT)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())
            return
        # --- OFFICE CONFIG PERSISTENCE ---
        elif self.path == "/api/office-config":
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length else b'{}'
            # Validate JSON
            try:
                json.loads(body)
            except json.JSONDecodeError:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":"Invalid JSON"}')
                return
            _oc_path = os.path.join(STATUS_DIR, "office-config.json")
            with open(_oc_path, "w") as f:
                f.write(body.decode())
            os.chmod(_oc_path, 0o666)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        # --- AGENT CREATION API ---
        elif self.path == "/api/agent/create":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_agent_create(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        # --- MEETINGS API ---
        elif self.path == "/api/meetings/create":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_meeting_create(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/meetings/end":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_meeting_end(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/meetings/end-all":
            result = _handle_meeting_end_all()
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        # --- AGENT SKILLS API ---
        elif self.path.startswith("/api/agent/") and "/skills" in self.path:
            # POST /api/agent/<id>/skills — add or update a skill
            parts = self.path.split("/api/agent/")[1].split("/skills")
            agent_key = parts[0]
            skill_path = parts[1].strip("/") if len(parts) > 1 else ""
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_skill_write(agent_key, skill_path, body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        # --- PRESENCE API ---
        elif self.path.startswith("/api/presence/"):
            agent_id = self.path.split("/api/presence/")[1].strip("/")
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            state = body.get("state", "idle")
            task = body.get("task", "")
            if state not in ("idle", "working", "meeting", "break"):
                self.send_response(400)
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Invalid state"}).encode())
                return
            gateway_presence.set_manual_override(agent_id, state, task)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "agent": agent_id, "state": state}).encode())
            return
        elif self.path == "/transcribe":
            # Proxy to host whisper server
            import urllib.request
            length = int(self.headers.get('Content-Length', 0))
            audio = self.rfile.read(length) if length else b''
            try:
                _whisper_url = VO_CONFIG["whisper"]["url"].rstrip("/") + "/transcribe"
                req = urllib.request.Request(_whisper_url, data=audio,
                    headers={'Content-Type': self.headers.get('Content-Type', 'audio/webm')})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    result = resp.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(result)
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            return
        elif self.path.startswith("/agent-bio-save/"):
            # Save agent workspace file
            agent_key = self.path.split("/agent-bio-save/")[1]
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            filename = body.get("filename", "")
            content = body.get("content", "")
            # Security: only allow known filenames
            allowed = ["AGENTS.md", "SOUL.md", "MEMORY.md", "TOOLS.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md"]
            ws_dir = AGENT_WORKSPACES.get(agent_key)
            if not ws_dir or filename not in allowed:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"Invalid agent or filename: {agent_key}/{filename}"}).encode())
                return
            ws_path = os.path.join(WORKSPACE_BASE, ws_dir)
            fpath = os.path.join(ws_path, filename)
            try:
                with open(fpath, "w") as f:
                    f.write(content)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "saved": filename}).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            return
        elif self.path == "/set-model":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            agent_key = body.get("agent", "")
            model_id = body.get("model", "")
            result = self._set_agent_model(agent_key, model_id)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/config/providers/save-key":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._save_provider_key(body.get("provider", ""), body.get("key", ""))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/config/providers/delete-key":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._delete_provider_key(body.get("provider", ""), body.get("profileId", ""))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/config/providers/save-custom":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._save_custom_provider(body.get("provider", ""), body.get("baseUrl", ""), body.get("models", []), body.get("params"))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/license/activate":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            key = body.get("key", "")
            result = activate_license(key)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/license/deactivate":
            result = deactivate_license()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/gateway/configure":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._configure_gateway_origin(body.get("origin", ""))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/clear-notify":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        elif self.path == "/sms-mode":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            mode = body.get("active", "agent")
            if mode not in ("user", "agent"):
                mode = "agent"
            mode_path = os.path.join(STATUS_DIR, "sms-mode.json")
            with open(mode_path, "w") as f:
                json.dump({"active": mode}, f)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "active": mode}).encode())
        elif self.path == "/sms-send":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._send_sms_intervention(body.get("to", ""), body.get("body", ""), body.get("name", ""))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        elif self.path == "/upload":
            # Self-contained file upload — saves to STATUS_DIR/uploads/
            import base64 as _b64, time as _time
            MAX_UPLOAD = 50 * 1024 * 1024  # 50MB
            length = int(self.headers.get('Content-Length', 0))
            if length > MAX_UPLOAD:
                self.send_response(413)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "File too large (max 50MB)"}).encode())
                return
            try:
                body = json.loads(self.rfile.read(length)) if length else {}
                filename = os.path.basename(body.get("filename", "upload"))
                content = _b64.b64decode(body.get("content", ""))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
                return
            upload_dir = os.path.join(STATUS_DIR, "uploads")
            os.makedirs(upload_dir, exist_ok=True)
            dest = os.path.join(upload_dir, filename)
            if os.path.exists(dest):
                stem, ext = os.path.splitext(filename)
                dest = os.path.join(upload_dir, f"{stem}_{int(_time.time())}{ext}")
            with open(dest, "wb") as f:
                f.write(content)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"path": dest, "size": len(content)}).encode())
            print(f"📎 Upload: {dest} ({len(content):,} bytes)")

        elif self.path == "/api/skills-library":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_skills_library_create(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/skills-library/apply":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_skills_library_apply(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/skills-library/upload":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_skills_library_upload(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        # ── PROJECTS POST ────────────────────────────────────────────
        elif self.path == "/api/projects":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_project_create(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/projects/scores/award":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_score_award(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/projects/from-template":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_project_from_template(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/projects/templates":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_save_as_template(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and self.path.endswith("/workflow/start"):
            proj_id = self.path.split("/api/projects/")[1].rsplit("/workflow/start", 1)[0]
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_workflow_start(proj_id, body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and self.path.endswith("/workflow/stop"):
            proj_id = self.path.split("/api/projects/")[1].rsplit("/workflow/stop", 1)[0]
            result = _handle_workflow_stop(proj_id)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and "/tasks" in self.path and "/comments" in self.path:
            # POST /api/projects/{id}/tasks/{taskId}/comments
            rest = self.path.split("/api/projects/")[1]
            parts = rest.split("/tasks/")
            proj_id = parts[0]
            task_rest = parts[1].split("/comments")[0].strip("/") if len(parts) > 1 else ""
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_task_comment(proj_id, task_rest, body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path.startswith("/api/projects/") and self.path.endswith("/tasks"):
            # POST /api/projects/{id}/tasks
            proj_id = self.path.split("/api/projects/")[1].rsplit("/tasks", 1)[0]
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_task_create(proj_id, body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def _configure_gateway_origin(self, origin):
        """Configure gateway to allow the given origin, and set insecure auth flags for Docker."""
        if not origin:
            return {"ok": False, "error": "No origin provided"}
        try:
            try:
                with open(CONFIG_PATH, "r") as f:
                    cfg = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                cfg = {}

            gateway_cfg = cfg.setdefault("gateway", {})
            control_ui = gateway_cfg.setdefault("controlUi", {})

            # Get current allowed origins
            origins = control_ui.get("allowedOrigins", [])
            if not isinstance(origins, list):
                origins = []

            added = origin not in origins
            if added:
                origins.append(origin)
            control_ui["allowedOrigins"] = origins

            # Ensure insecure auth flags for Docker
            control_ui["allowInsecureAuth"] = True
            control_ui["dangerouslyDisableDeviceAuth"] = True

            with open(CONFIG_PATH, "w") as f:
                json.dump(cfg, f, indent=2)

            # Signal gateway to reload
            self._signal_gateway(restart=False)

            return {"ok": True, "added": added, "origins": origins}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _test_gateway_connection(self):
        """Test server-side connectivity to the OpenClaw gateway."""
        import asyncio as _asyncio
        import concurrent.futures

        async def _do_test():
            try:
                gw_url = VO_CONFIG["openclaw"]["gatewayUrl"]
                origin = f"http://127.0.0.1:{PORT}"
                token = _get_gateway_token()

                import websockets as _ws
                from websockets.asyncio.client import connect as _ws_connect

                async with _asyncio.timeout(5):
                    ws = await _ws_connect(
                        gw_url,
                        max_size=1024 * 1024,
                        additional_headers={"Origin": origin},
                        close_timeout=3,
                    )
                    async with ws:
                        # Wait for challenge
                        raw = await _asyncio.wait_for(ws.recv(), timeout=5)
                        msg = json.loads(raw)
                        if msg.get("event") != "connect.challenge":
                            return {"ok": False, "gateway": "unexpected_response"}

                        # Send connect
                        connect_msg = {
                            "type": "req",
                            "id": "gw-test-1",
                            "method": "connect",
                            "params": {
                                "minProtocol": 3, "maxProtocol": 3,
                                "client": {"id": "openclaw-control-ui", "version": "2026.2.9", "platform": "server", "mode": "webchat"},
                                "role": "operator",
                                "scopes": ["operator.read"],
                                "caps": [], "commands": [], "permissions": {},
                                "auth": {"token": token}
                            }
                        }
                        await ws.send(json.dumps(connect_msg))

                        raw2 = await _asyncio.wait_for(ws.recv(), timeout=5)
                        res = json.loads(raw2)
                        if not res.get("ok"):
                            err = res.get("error", {}).get("message", "unknown")
                            return {"ok": True, "gateway": "reachable", "token": False, "error": err, "agents": 0}

                        # Connected — query sessions
                        req = {"type": "req", "id": "gw-test-2", "method": "sessions.list", "params": {}}
                        await ws.send(json.dumps(req))
                        raw3 = await _asyncio.wait_for(ws.recv(), timeout=5)
                        res3 = json.loads(raw3)
                        sessions = res3.get("payload", {}).get("sessions", []) if res3.get("ok") else []
                        agent_count = sum(1 for s in sessions if isinstance(s, dict) and s.get("key", "").startswith("agent:"))

                        return {"ok": True, "gateway": "reachable", "token": True, "agents": agent_count}

            except (ConnectionRefusedError, ConnectionResetError, OSError):
                return {"ok": False, "gateway": "unreachable", "token": False, "agents": 0}
            except Exception as e:
                return {"ok": False, "gateway": "error", "error": str(e)[:200], "token": False, "agents": 0}

        # Run async test in a thread pool to avoid blocking the HTTP server
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(lambda: _asyncio.run(_do_test()))
            try:
                return future.result(timeout=10)
            except Exception as e:
                return {"ok": False, "gateway": "error", "error": str(e)[:200]}

    def _sms_data_dir(self):
        return STATUS_DIR

    def _get_sms_log(self, limit=100):
        log_path = os.path.join(self._sms_data_dir(), "sms-log.jsonl")
        try:
            with open(log_path) as f:
                lines = f.readlines()
            entries = []
            for line in lines[-limit:]:
                try:
                    entries.append(json.loads(line.strip()))
                except:
                    pass
            return {"ok": True, "messages": entries}
        except FileNotFoundError:
            return {"ok": True, "messages": []}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _get_sms_contacts(self):
        contacts_path = os.path.join(self._sms_data_dir(), "sms-contacts.json")
        try:
            with open(contacts_path) as f:
                return {"ok": True, "contacts": json.load(f)}
        except FileNotFoundError:
            return {"ok": True, "contacts": {}}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _send_sms_intervention(self, to, body, name=""):
        """Send SMS via Twilio (config-driven credentials)."""
        if not to or not body:
            return {"ok": False, "error": "Missing 'to' or 'body'"}
        sms_cfg = VO_CONFIG.get("sms", {})
        ACCOUNT_SID = sms_cfg.get("twilioAccountSid")
        AUTH_TOKEN = sms_cfg.get("twilioAuthToken")
        FROM_NUMBER = sms_cfg.get("fromNumber")
        if not ACCOUNT_SID or not AUTH_TOKEN or not FROM_NUMBER:
            return {"ok": False, "error": "SMS not configured. Set Twilio credentials in Settings or /setup."}
        import urllib.request, urllib.parse, base64
        sms_log_path = os.path.join(self._sms_data_dir(), "sms-log.jsonl")
        contacts_path = os.path.join(self._sms_data_dir(), "sms-contacts.json")
        try:
            url = f"https://api.twilio.com/2010-04-01/Accounts/{ACCOUNT_SID}/Messages.json"
            data = urllib.parse.urlencode({"To": to, "From": FROM_NUMBER, "Body": body}).encode()
            credentials = base64.b64encode(f"{ACCOUNT_SID}:{AUTH_TOKEN}".encode()).decode()
            req = urllib.request.Request(url, data=data, method="POST")
            req.add_header("Authorization", f"Basic {credentials}")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
            with urllib.request.urlopen(req) as resp:
                result = json.loads(resp.read().decode())
            import time
            entry = {"type": "intervention", "phone": to, "name": name or "Unknown", "body": body, "sid": result.get("sid"), "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S")}
            with open(sms_log_path, 'a') as f:
                f.write(json.dumps(entry) + '\n')
            try:
                contacts = json.load(open(contacts_path))
            except:
                contacts = {}
            if to not in contacts:
                contacts[to] = {"name": name or "Unknown", "added": time.strftime("%Y-%m-%d"), "note": "Added via Virtual Office"}
                with open(contacts_path, 'w') as f:
                    json.dump(contacts, f, indent=2)
            return {"ok": True, "sid": result.get("sid"), "status": result.get("status")}
        except urllib.error.HTTPError as e:
            err = e.read().decode()
            try:
                return {"ok": False, "error": json.loads(err).get("message", err[:200])}
            except:
                return {"ok": False, "error": err[:200]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

# ─── WS PROXY QUIET MODE ─────────────────────────────────────────
_ws_proxy_connected_logged = False
_ws_proxy_failed_logged = False


async def try_connect_gateway():
    """Try connecting to gateway, with fallback URLs."""
    global _ws_proxy_connected_logged, _ws_proxy_failed_logged
    for url in [GATEWAY_URL, GATEWAY_URL_FALLBACK]:
        try:
            gw = await asyncio.wait_for(
                ws_connect(url, max_size=10 * 1024 * 1024, additional_headers={"Origin": f"http://127.0.0.1:{PORT}"}),
                timeout=3
            )
            if not _ws_proxy_connected_logged:
                print(f"✅ Connected to gateway (WS proxy): {url}")
                _ws_proxy_connected_logged = True
            _ws_proxy_failed_logged = False
            return gw
        except Exception:
            pass
    if not _ws_proxy_failed_logged:
        print(f"⚠️  WS proxy: gateway not reachable — will retry silently")
        _ws_proxy_failed_logged = True
    return None


async def ws_proxy(client_ws):
    """Proxy a browser WebSocket connection to the OpenClaw gateway."""
    global _ws_proxy_connected_logged, _ws_proxy_failed_logged
    gw = await try_connect_gateway()
    if not gw:
        await client_ws.close(1011, "Cannot reach gateway")
        return

    async def client_to_gw():
        global _ws_proxy_connected_logged
        try:
            async for msg in client_ws:
                await gw.send(msg)
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception:
            pass
        finally:
            _ws_proxy_connected_logged = False  # allow re-log on next connect
            await gw.close()

    async def gw_to_client():
        global _ws_proxy_connected_logged
        try:
            async for msg in gw:
                await client_ws.send(msg)
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception:
            pass
        finally:
            _ws_proxy_connected_logged = False  # allow re-log on next connect
            await client_ws.close()

    async def ping_loop():
        """Send periodic pings to keep the gateway connection alive."""
        try:
            while True:
                await asyncio.sleep(30)
                await gw.ping()
        except Exception:
            pass

    await asyncio.gather(client_to_gw(), gw_to_client(), ping_loop())


async def run_ws_server():
    """Run the WebSocket proxy server."""
    async with websockets.serve(ws_proxy, "0.0.0.0", WS_PORT, max_size=10 * 1024 * 1024):
        print(f"🔌 WebSocket proxy on :{WS_PORT} → gateway")
        await asyncio.Future()  # run forever


def start_ws_server():
    asyncio.run(run_ws_server())


def start_http_server():
    # Initialize gateway presence with discovered agents
    agent_ids = [a["statusKey"] for a in get_roster()]
    gateway_presence.init_agents(agent_ids)

    # Set the meetings file path (office.py still writes meetings here)
    gateway_presence.set_meetings_file(STATUS_FILE)

    # Load disk snapshot for crash recovery
    snapshot_path = os.path.join(STATUS_DIR, "presence-snapshot.json")
    gateway_presence.load_snapshot(snapshot_path)

    # Also load meetings from old status file if it exists (migration)
    try:
        with open(STATUS_FILE, "r") as f:
            old_status = json.load(f)
        meetings = old_status.get("_meetings", [])
        if meetings:
            gateway_presence.set_meetings(meetings)
            print(f"Migrated {len(meetings)} meetings from old status file")
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # Auto-configure gateway to accept our origin (plug and play for Docker bridge)
    _auto_configure_gateway_origin()

    # Read gateway token (vo-config override, then openclaw.json)
    gw_token = _get_gateway_token()

    # Start gateway presence listener
    gw_url = VO_CONFIG["openclaw"]["gatewayUrl"]
    if gw_token:
        gateway_presence.start(gw_url, gw_token, port=PORT)
    else:
        print("⚠️  No gateway token found — gateway presence disabled")

    # Start periodic snapshot saver (every 30s)
    def snapshot_loop():
        import time
        while True:
            time.sleep(30)
            gateway_presence.save_snapshot(snapshot_path)
    snap_thread = threading.Thread(target=snapshot_loop, daemon=True, name="presence-snapshot")
    snap_thread.start()

    _oname = VO_CONFIG["office"]["name"]
    print(f"🏢 {_oname} → http://localhost:{PORT}")
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), OfficeHandler)
    server.serve_forever()


def _wf_auto_resume_on_startup():
    """Check for workflows that were interrupted by a container restart and resume them.

    Looks for tasks stuck in 'In Progress' or 'Review' columns that have an active
    or done workflow session, indicating the pipeline was mid-execution when killed.
    """
    import time as _startup_time
    _startup_time.sleep(3)  # Let the server fully start first

    try:
        data = _load_projects()
        for p in data.get("projects", []):
            project_id = p["id"]
            # Find tasks in active columns
            ip_cols = [c["id"] for c in p.get("columns", []) if c.get("title", "").lower() in ("in progress", "review")]
            stuck_tasks = [t for t in p.get("tasks", []) if t.get("columnId") in ip_cols and t.get("assignee")]

            for task in stuck_tasks:
                task_id = task["id"]
                assignee = task["assignee"]
                session_key = _wf_task_session_key(assignee, project_id, task_id)

                # Check if there's a workflow session for this task
                home_path = VO_CONFIG.get("openclaw", {}).get("homePath", os.path.expanduser("~/.openclaw"))
                sessions_json_path = os.path.join(home_path, "agents", assignee, "sessions", "sessions.json")
                try:
                    with open(sessions_json_path, "r") as f:
                        sessions_data = json.load(f)
                    if session_key in sessions_data:
                        session_status = sessions_data[session_key].get("status", "")
                        if session_status in ("done", "running", "failed"):
                            print(f"[WORKFLOW AUTO-RESUME] Found interrupted task: '{task.get('title', '?')}' (project={project_id[:8]}, session={session_status})")
                            # Resume the workflow for this project
                            with _WORKFLOW_LOCK:
                                if project_id not in _WORKFLOW_STATE or not _WORKFLOW_STATE.get(project_id, {}).get("active"):
                                    auto_mode = p.get("autoMode", False)
                                    stop_flag = threading.Event()
                                    wf = {
                                        "active": True,
                                        "autoMode": auto_mode,
                                        "currentTaskId": task_id,
                                        "phase": "resuming",
                                        "error": None,
                                        "reviewCycle": 0,
                                        "stopFlag": stop_flag,
                                        "thread": None,
                                    }
                                    _WORKFLOW_STATE[project_id] = wf
                                    t = threading.Thread(target=_wf_run_pipeline, args=(project_id, not auto_mode), daemon=True)
                                    wf["thread"] = t
                                    t.start()
                                    print(f"[WORKFLOW AUTO-RESUME] Resumed pipeline for project {project_id[:8]} (autoMode={auto_mode})")
                            break  # One resume per project
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
    except Exception as e:
        print(f"[WORKFLOW AUTO-RESUME] Error: {e}")


if __name__ == "__main__":
    # Start API usage collector background thread
    _api_usage_collector.start()
    print("📊 API usage collector started (polls every 60s)")

    # Start WS proxy in a background thread
    ws_thread = threading.Thread(target=start_ws_server, daemon=True)
    ws_thread.start()

    # Auto-resume interrupted workflows (in background, after server starts)
    resume_thread = threading.Thread(target=_wf_auto_resume_on_startup, daemon=True, name="wf-auto-resume")
    resume_thread.start()

    # Start HTTP server in main thread
    start_http_server()
