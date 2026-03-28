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
    """Return path to skills-library/ under STATUS_DIR, create if needed."""
    d = os.path.join(STATUS_DIR, "skills-library")
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
                        import zoneinfo
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        et = dt.astimezone(zoneinfo.ZoneInfo("America/New_York"))
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
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
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


if __name__ == "__main__":
    # Start API usage collector background thread
    _api_usage_collector.start()
    print("📊 API usage collector started (polls every 60s)")

    # Start WS proxy in a background thread
    ws_thread = threading.Thread(target=start_ws_server, daemon=True)
    ws_thread.start()

    # Start HTTP server in main thread
    start_http_server()
