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
def _load_vo_config():
    """Load vo-config.json with env-var overrides. Returns merged dict."""
    cfg_path = os.environ.get("VO_CONFIG", os.path.join(os.path.dirname(__file__), "vo-config.json"))
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
            "name": os.environ.get("VO_OFFICE_NAME", office.get("name", "Virtual Office")),
            "port": int(os.environ.get("VO_PORT", office.get("port", 8090))),
            "wsPort": int(os.environ.get("VO_WS_PORT", office.get("wsPort", 8091))),
        },
        "openclaw": {
            "homePath": oc_home,
            "gatewayUrl": os.environ.get("VO_GATEWAY_URL", openclaw.get("gatewayUrl", "ws://127.0.0.1:18789")),
            "gatewayHttp": os.environ.get("VO_GATEWAY_HTTP", openclaw.get("gatewayHttp", "http://127.0.0.1:18789")),
        },
        "presence": {
            "statusDir": os.environ.get("VO_STATUS_DIR", presence.get("statusDir", "/tmp/vo-data")),
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
            "url": os.environ.get("VO_PC_METRICS_URL", pc_metrics.get("url")),
        },
        "whisper": {
            "url": os.environ.get("VO_WHISPER_URL", whisper_cfg.get("url", "http://127.0.0.1:8087")),
        },
        "browser": {
            "cdpUrl": os.environ.get("VO_CDP_URL", browser_cfg.get("cdpUrl", "http://127.0.0.1:9222")),
        },
        "weather": {
            "location": os.environ.get("VO_WEATHER_LOCATION", weather_cfg.get("location")),
        },
        "sms": {
            "agentId": os.environ.get("VO_SMS_AGENT_ID", sms_cfg.get("agentId")),
            "twilioAccountSid": os.environ.get("VO_TWILIO_ACCOUNT_SID", sms_cfg.get("twilioAccountSid")),
            "twilioAuthToken": os.environ.get("VO_TWILIO_AUTH_TOKEN", sms_cfg.get("twilioAuthToken")),
            "fromNumber": os.environ.get("VO_TWILIO_FROM_NUMBER", sms_cfg.get("fromNumber")),
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

def refresh_agent_maps():
    """Call after discovery refresh to update compatibility maps."""
    global AGENT_INFO, AGENT_WORKSPACES, AGENT_SESSION_IDS
    AGENT_INFO = _build_agent_info()
    AGENT_WORKSPACES = _build_agent_workspaces()
    AGENT_SESSION_IDS = _build_agent_session_ids()

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
        with open(jsonl_file, "r") as f:
            for line in f:
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
GATEWAY_HTTP = VO_CONFIG["openclaw"]["gatewayHttp"]
CONFIG_PATH = os.path.join(WORKSPACE_BASE, "openclaw.json")
APP_DIR = os.path.dirname(os.path.abspath(__file__))


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
        elif self.path == "/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            state = gateway_presence.get_state()
            self.wfile.write(json.dumps(state).encode())
        elif self.path == "/agents-list":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            # Return dynamically discovered agent roster
            refresh_agent_maps()
            agents = []
            for a in get_roster():
                session_key = f"agent:{a['id']}:main"
                agents.append({
                    "key": a["statusKey"],
                    "agentId": a["id"],
                    "sessionKey": session_key,
                    "emoji": a["emoji"],
                    "name": a["name"],
                    "role": a.get("role", ""),
                    "model": a.get("model", ""),
                    "lastActiveAt": a.get("lastActiveAt", 0),
                    "branch": "",
                })
            # Enforce agent limit in demo mode
            agent_limit = get_agent_limit()
            if agent_limit > 0 and len(agents) > agent_limit:
                agents = agents[:agent_limit]
            self.wfile.write(json.dumps({"agents": agents}).encode())
        elif self.path == "/gateway-info":
            # Tell the browser what WS port to use for the proxy
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"wsPort": WS_PORT}).encode())
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
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    # Try bundled default
                    _default_oc2 = os.path.join(os.path.dirname(__file__) or '.', 'default-office-config.json')
                    try:
                        with open(_default_oc2, 'r') as df:
                            ddata = df.read()
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
                # Try bundled default config
                _default_oc = os.path.join(os.path.dirname(__file__) or '.', 'default-office-config.json')
                try:
                    with open(_default_oc, 'r') as f:
                        data = f.read()
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
        elif self.path == "/weather-proxy":
            _wloc = VO_CONFIG["weather"].get("location")
            if not _wloc:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b'{"error":"Weather location not configured. Set weather.location in vo-config.json"}')
                return
            try:
                import urllib.request
                req = urllib.request.Request(f"https://wttr.in/{_wloc}?format=j1", headers={"User-Agent": "curl/7.68"})
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
        else:
            super().do_GET()

    def _get_api_usage(self):
        """Get API usage data from shared file written by host-side collector."""
        import time as _time
        usage_file = os.path.join(STATUS_DIR, "api-usage.json")
        try:
            if os.path.exists(usage_file):
                with open(usage_file) as f:
                    data = json.load(f)
                # Add staleness check — if data is older than 2 min, flag it
                age = _time.time() - data.get("timestamp", 0)
                data["ageSeconds"] = round(age, 1)
                data["stale"] = age > 120
                return data
            else:
                return {"providers": [], "timestamp": _time.time(), "error": "No usage data yet"}
        except Exception as e:
            return {"providers": [], "timestamp": _time.time(), "error": str(e)}

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

    def _delete_provider_key(self, provider):
        """Delete a cloud provider API key via watcher."""
        request = {
            "type": "delete-key",
            "provider": provider
        }
        return self._send_watcher_request(request)

    def _save_custom_provider(self, provider, base_url, models):
        """Save a custom provider config via watcher."""
        request = {
            "type": "save-custom-provider",
            "provider": provider,
            "baseUrl": base_url,
            "models": models
        }
        return self._send_watcher_request(request)

    def _send_watcher_request(self, request):
        """Send a request to the host-side watcher and wait for result."""
        import time
        try:
            with open(os.path.join(STATUS_DIR, "model-change-request.json"), "w") as f:
                json.dump(request, f)
            os.chmod(os.path.join(STATUS_DIR, "model-change-request.json"), 0o666)
            os.chmod(os.path.join(STATUS_DIR, "model-change-request.json"), 0o666)
            for _ in range(20):  # wait up to 10 seconds
                time.sleep(0.5)
                result_path = os.path.join(STATUS_DIR, "model-change-result.json")
                if os.path.exists(result_path):
                    with open(result_path, "r") as f:
                        result = json.load(f)
                    os.remove(result_path)
                    return result
            return {"ok": False, "error": "Timeout waiting for change to apply"}
        except Exception as e:
            return {"ok": False, "error": f"Failed: {e}"}

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
            
            # DEBUG
            import sys
            print(f"DEBUG oauth_providers: {oauth_providers}", file=sys.stderr)
            
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
            print(f"DEBUG error: {e}", file=sys.stderr)
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

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        # --- SETUP WIZARD ---
        if self.path == "/setup/save":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            cfg_path = os.path.join(os.path.dirname(__file__), "vo-config.json")
            try:
                # Merge with existing config
                existing = {}
                try:
                    with open(cfg_path, "r") as f:
                        existing = json.load(f)
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
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
                # Reload config and re-discover if path changed
                global VO_CONFIG, WORKSPACE_BASE, _discovered_roster, _discovered_at
                old_path = WORKSPACE_BASE
                VO_CONFIG = _load_vo_config()
                WORKSPACE_BASE = VO_CONFIG["openclaw"]["homePath"]
                if WORKSPACE_BASE != old_path:
                    _discovered_roster = discover_agents(WORKSPACE_BASE)
                    _discovered_at = _time_mod.time()
                    refresh_agent_maps()
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
            result = self._delete_provider_key(body.get("provider", ""))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/config/providers/save-custom":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._save_custom_provider(body.get("provider", ""), body.get("baseUrl", ""), body.get("models", []))
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
        elif self.path == "/clear-notify":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            agent_key = body.get("agent", "")
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
        else:
            self.send_response(404)
            self.end_headers()

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

async def try_connect_gateway():
    """Try connecting to gateway, with fallback URLs."""
    for url in [GATEWAY_URL, GATEWAY_URL_FALLBACK]:
        try:
            gw = await asyncio.wait_for(
                ws_connect(url, max_size=10 * 1024 * 1024, additional_headers={"Origin": f"http://127.0.0.1:{PORT}"}),
                timeout=3
            )
            print(f"✅ Connected to gateway: {url}")
            return gw
        except Exception as e:
            print(f"⚠️  Gateway {url} failed: {e}")
    return None


async def ws_proxy(client_ws):
    """Proxy a browser WebSocket connection to the OpenClaw gateway."""
    gw = await try_connect_gateway()
    if not gw:
        await client_ws.close(1011, "Cannot reach gateway")
        return

    async def client_to_gw():
        try:
            async for msg in client_ws:
                await gw.send(msg)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            await gw.close()

    async def gw_to_client():
        try:
            async for msg in gw:
                await client_ws.send(msg)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
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

    # Read gateway token from openclaw.json
    gw_token = ""
    try:
        with open(CONFIG_PATH, "r") as f:
            cfg = json.load(f)
        gw_token = cfg.get("gateway", {}).get("auth", {}).get("token", "")
    except Exception:
        pass

    # Start gateway presence listener
    gw_url = VO_CONFIG["openclaw"]["gatewayUrl"]
    if gw_token:
        gateway_presence.start(gw_url, gw_token, port=PORT)
    else:
        print("\u26a0\ufe0f  No gateway token found \u2014 gateway presence disabled")

    # Start periodic snapshot saver (every 30s)
    def snapshot_loop():
        import time
        while True:
            time.sleep(30)
            gateway_presence.save_snapshot(snapshot_path)
    snap_thread = threading.Thread(target=snapshot_loop, daemon=True, name="presence-snapshot")
    snap_thread.start()

    _oname = VO_CONFIG["office"]["name"]
    print(f"\U0001f3e2 {_oname} \u2192 http://localhost:{PORT}")
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), OfficeHandler)
    server.serve_forever()

if __name__ == "__main__":
    # Start WS proxy in a background thread
    ws_thread = threading.Thread(target=start_ws_server, daemon=True)
    ws_thread.start()

    # Start HTTP server in main thread
    start_http_server()
 # Start HTTP server in main thread
    start_http_server()
