#!/usr/bin/env python3
"""Virtual Office server.
Serves static files, status JSON, and proxies WebSocket to the OpenClaw gateway.
"""
import asyncio
import base64
import http.server
import json
import os
import mimetypes
import queue
import secrets
import sys
import threading
import traceback
import uuid
import urllib.error
import urllib.parse
import urllib.request
import websockets
from datetime import datetime, timezone, timedelta
from websockets.asyncio.client import connect as ws_connect
import glob
import hashlib
import email.utils
import re
import shutil
import signal
import sqlite3
import subprocess
import time
import gateway_presence
from zoneinfo import ZoneInfo
try:
    import yaml
except Exception:
    yaml = None

GATEWAY_PROTOCOL_VERSION = 4


def _normalize_presence_entry(entry):
    """Normalize transient gateway/presence state aliases for UI rendering."""
    if not isinstance(entry, dict):
        return {"state": "offline", "task": "", "updated": 0, "source": "invalid"}
    state = str(entry.get("state") or entry.get("status") or entry.get("presence") or entry.get("activity") or "offline").strip().lower()
    state = {
        "busy": "working",
        "thinking": "working",
        "processing": "working",
        "responding": "working",
        "running": "working",
        "reading": "working",
        "reading_file": "working",
        "reading-file": "working",
        "analyzing": "working",
        "planning": "working",
        "reasoning": "working",
        "inference": "working",
        "inferencing": "working",
        "generating": "working",
        "streaming": "working",
        "executing": "working",
        "command": "working",
        "command_output": "working",
        "tool": "working",
        "tool_start": "working",
        "running_command": "working",
        "available": "idle",
    }.get(state, state)
    if state not in {"working", "finishing", "idle", "meeting", "break", "offline"}:
        state = "offline" if not state else state
    normalized = dict(entry)
    normalized["state"] = state
    normalized["task"] = str(entry.get("task") or "")
    updated = entry.get("updated", 0)
    normalized["updated"] = int(updated) if str(updated or "").isdigit() else updated
    normalized["source"] = str(entry.get("source") or "legacy")
    try:
        updated_epoch = float(normalized.get("updated") or 0)
    except (TypeError, ValueError):
        updated_epoch = 0
    source_lower = str(normalized.get("source") or "").lower()
    task_lower = str(normalized.get("task") or "").strip().lower()
    # Active lifecycle/tool sources can be silent during long commands. Generic
    # chat/snapshot display states must still age out if maintenance missed the
    # terminal event, otherwise disconnected apps can show stale working status.
    has_active_work_source = source_lower.startswith(("agent-lifecycle", "agent-tool", "session-tool", "gateway", "hermes-", "provider-"))
    stale_limit_sec = 180 if (
        "tool" in source_lower or "command" in source_lower or
        any(token in task_lower for token in ("reading", "processing", "thinking", "running command", "editing", "writing", "searching", "fetching"))
    ) else 45
    if (
        not has_active_work_source
        and state in {"working", "finishing"}
        and updated_epoch > 0
        and (time.time() - updated_epoch) > stale_limit_sec
    ):
        normalized["state"] = "idle"
        normalized["task"] = ""
        normalized["source"] = f"{normalized.get('source') or 'presence'}-stale-idle"
    return normalized


def _normalize_presence_map(data):
    if not isinstance(data, dict):
        return {}
    result = {}
    for key, value in data.items():
        if key == "_meetings":
            result[key] = value if isinstance(value, list) else []
        elif isinstance(value, dict):
            result[key] = _normalize_presence_entry(value)
    return result


def _get_normalized_presence_state():
    gateway_presence._sync_meetings_from_file()
    state = _normalize_presence_map(gateway_presence.get_state())
    # Provider adapters such as Hermes do not emit OpenClaw gateway events.
    # Keep them visible as idle/offline-capable office citizens unless a
    # manual/process override (working, idle, error) has more current data.
    now = int(time.time())
    for agent in get_roster():
        key = agent.get("statusKey") or agent.get("id")
        if not key or key in state:
            continue
        provider_kind = agent.get("providerKind", "openclaw")
        state[key] = {
            "state": "idle",
            "task": "",
            "updated": int(agent.get("lastActiveAt") or now),
            "source": f"{provider_kind}-discovery",
            "providerKind": provider_kind,
        }
    return state


# ─── CONFIGURATION ───────────────────────────────────────────────
def _env_or(key, fallback):
    """Return env var value if set and non-empty, else fallback."""
    val = os.environ.get(key)
    return val if val else fallback

def _running_in_docker():
    return os.path.exists("/.dockerenv") or bool(os.environ.get("VO_STATUS_DIR") == "/data")

def _default_hermes_api_url():
    return "http://host.docker.internal:8642" if _running_in_docker() else "http://127.0.0.1:8642"

def _default_hermes_desktop_url():
    return ""

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

    env_gateway_token = (
        os.environ.get("VO_GATEWAY_TOKEN")
        or os.environ.get("OPENCLAW_GATEWAY_TOKEN")
    )

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
    hermes_cfg = cfg.get("hermes") or {}
    hermes_platform_token = _env_or("VO_HERMES_PLATFORM_TOKEN", hermes_cfg.get("platformToken", ""))
    codex_cfg = cfg.get("codex") or {}
    claude_code_cfg = cfg.get("claudeCode") or cfg.get("claude_code") or {}
    opencode_cfg = cfg.get("openCode") or cfg.get("opencode") or {}
    antigravity_cfg = cfg.get("antigravity") or {}

    codex_workspace_root = _env_or(
        "VO_CODEX_WORKSPACE_ROOT",
        codex_cfg.get("workspaceRoot", os.path.join(_env_or("VO_STATUS_DIR", presence.get("statusDir", "/data")), "codex-agents")),
    )
    claude_code_workspace_root = _env_or(
        "VO_CLAUDE_CODE_WORKSPACE_ROOT",
        claude_code_cfg.get("workspaceRoot", os.path.join(_env_or("VO_STATUS_DIR", presence.get("statusDir", "/data")), "claude-code-agents")),
    )
    opencode_workspace_root = _env_or(
        "VO_OPENCODE_WORKSPACE_ROOT",
        opencode_cfg.get("workspaceRoot", os.path.join(_env_or("VO_STATUS_DIR", presence.get("statusDir", "/data")), "opencode-agents")),
    )
    antigravity_workspace_root = _env_or(
        "VO_ANTIGRAVITY_WORKSPACE_ROOT",
        antigravity_cfg.get("workspaceRoot", os.path.join(_env_or("VO_STATUS_DIR", presence.get("statusDir", "/data")), "antigravity-workspace")),
    )

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
            "gatewayToken": env_gateway_token or openclaw.get("gatewayToken", ""),
        },
        "presence": {
            "statusDir": _env_or("VO_STATUS_DIR", presence.get("statusDir", "/data")),
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
            "ownerAgentId": _env_or("VO_SMS_OWNER_AGENT_ID", _env_or("VO_SMS_AGENT_ID", sms_cfg.get("ownerAgentId") or sms_cfg.get("agentId"))),
            "agentId": _env_or("VO_SMS_OWNER_AGENT_ID", _env_or("VO_SMS_AGENT_ID", sms_cfg.get("ownerAgentId") or sms_cfg.get("agentId"))),
            "twilioAccountSid": _env_or("VO_TWILIO_ACCOUNT_SID", sms_cfg.get("twilioAccountSid")),
            "twilioAuthToken": _env_or("VO_TWILIO_AUTH_TOKEN", sms_cfg.get("twilioAuthToken")),
            "fromNumber": _env_or("VO_TWILIO_FROM_NUMBER", sms_cfg.get("fromNumber")),
        },
        "hermes": {
            "enabled": str(_env_or("VO_HERMES_ENABLED", hermes_cfg.get("enabled", True))).lower() not in ("0", "false", "no", "off"),
            "homePath": _env_or("VO_HERMES_HOME", hermes_cfg.get("homePath", os.path.expanduser("~/.hermes"))),
            "binary": _env_or("VO_HERMES_BIN", hermes_cfg.get("binary", os.path.expanduser("~/.local/bin/hermes"))),
            "timeoutSec": int(_env_or("VO_HERMES_TIMEOUT_SEC", hermes_cfg.get("timeoutSec", 600))),
            "apiUrl": _env_or("VO_HERMES_API_URL", hermes_cfg.get("apiUrl") or _default_hermes_api_url()),
            "apiKey": _env_or("VO_HERMES_API_KEY", hermes_cfg.get("apiKey", "")),
            "desktopUrl": _env_or("VO_HERMES_DESKTOP_URL", hermes_cfg.get("desktopUrl") or _default_hermes_desktop_url()),
            "desktopToken": _env_or("VO_HERMES_DESKTOP_TOKEN", hermes_cfg.get("desktopToken", "")),
            "desktopHostHeader": _env_or("VO_HERMES_DESKTOP_HOST_HEADER", hermes_cfg.get("desktopHostHeader", "")),
            "desktopTcpHost": _env_or("VO_HERMES_DESKTOP_TCP_HOST", hermes_cfg.get("desktopTcpHost", "")),
            "desktopTcpPort": _env_or("VO_HERMES_DESKTOP_TCP_PORT", hermes_cfg.get("desktopTcpPort", "")),
            "desktopLogPath": _env_or("VO_HERMES_DESKTOP_LOG_PATH", hermes_cfg.get("desktopLogPath", "")),
            "preferApi": str(_env_or("VO_HERMES_PREFER_API", hermes_cfg.get("preferApi", True))).lower() not in ("0", "false", "no", "off"),
            "preferDesktop": str(_env_or("VO_HERMES_PREFER_DESKTOP", hermes_cfg.get("preferDesktop", True))).lower() not in ("0", "false", "no", "off"),
            "platformEnabled": str(_env_or("VO_HERMES_PLATFORM_ENABLED", hermes_cfg.get("platformEnabled", bool(hermes_platform_token)))).lower() not in ("0", "false", "no", "off"),
            "platformToken": hermes_platform_token,
            "platformAgentId": _env_or("VO_HERMES_PLATFORM_AGENT_ID", hermes_cfg.get("platformAgentId", "hermes-gateway")),
            "platformPollLeaseSec": int(_env_or("VO_HERMES_PLATFORM_LEASE_SEC", hermes_cfg.get("platformPollLeaseSec", 120))),
            "autoStartProfileApis": str(_env_or("VO_HERMES_AUTO_START_PROFILE_APIS", hermes_cfg.get("autoStartProfileApis", True))).lower() not in ("0", "false", "no", "off"),
            "autoStartDefaultApi": str(_env_or("VO_HERMES_AUTO_START_DEFAULT_API", hermes_cfg.get("autoStartDefaultApi", hermes_cfg.get("autoStartProfileApis", True)))).lower() not in ("0", "false", "no", "off"),
            "apiProfilePortBase": _env_or("VO_HERMES_API_PROFILE_PORT_BASE", hermes_cfg.get("apiProfilePortBase")),
            "apiProfiles": hermes_cfg.get("apiProfiles") if isinstance(hermes_cfg.get("apiProfiles"), dict) else {},
        },
        "codex": {
            "enabled": str(_env_or("VO_CODEX_ENABLED", codex_cfg.get("enabled", True))).lower() not in ("0", "false", "no", "off"),
            "homePath": _env_or("VO_CODEX_HOME", codex_cfg.get("homePath", os.path.expanduser("~/.codex"))),
            "binary": _env_or("VO_CODEX_BIN", codex_cfg.get("binary", "")),
            "workspaceRoot": codex_workspace_root,
            "mainWorkspace": _env_or("VO_CODEX_MAIN_WORKSPACE", codex_cfg.get("mainWorkspace", codex_workspace_root)),
            "timeoutSec": int(_env_or("VO_CODEX_TIMEOUT_SEC", codex_cfg.get("timeoutSec", 900))),
            "model": _env_or("VO_CODEX_MODEL", codex_cfg.get("model", "")),
            "sandbox": _env_or("VO_CODEX_SANDBOX", codex_cfg.get("sandbox", "workspace-write")),
            "approvalPolicy": _env_or("VO_CODEX_APPROVAL_POLICY", codex_cfg.get("approvalPolicy", "never")),
            "preferAppServer": str(_env_or("VO_CODEX_PREFER_APP_SERVER", codex_cfg.get("preferAppServer", True))).lower() not in ("0", "false", "no", "off"),
            "includeMain": str(_env_or("VO_CODEX_INCLUDE_MAIN", codex_cfg.get("includeMain", True))).lower() not in ("0", "false", "no", "off"),
            "includeNativeAgents": str(_env_or("VO_CODEX_INCLUDE_NATIVE_AGENTS", codex_cfg.get("includeNativeAgents", True))).lower() not in ("0", "false", "no", "off"),
            "registerNativeAgents": str(_env_or("VO_CODEX_REGISTER_NATIVE_AGENTS", codex_cfg.get("registerNativeAgents", True))).lower() not in ("0", "false", "no", "off"),
        },
        "claudeCode": {
            "enabled": str(_env_or("VO_CLAUDE_CODE_ENABLED", claude_code_cfg.get("enabled", True))).lower() not in ("0", "false", "no", "off"),
            "homePath": _env_or("VO_CLAUDE_CODE_HOME", claude_code_cfg.get("homePath", os.path.expanduser("~/.claude"))),
            "binary": _env_or("VO_CLAUDE_CODE_BIN", claude_code_cfg.get("binary", "")),
            "workspaceRoot": claude_code_workspace_root,
            "mainWorkspace": _env_or("VO_CLAUDE_CODE_MAIN_WORKSPACE", claude_code_cfg.get("mainWorkspace", os.path.join(_env_or("VO_STATUS_DIR", presence.get("statusDir", "/data")), "claude-code-main"))),
            "timeoutSec": int(_env_or("VO_CLAUDE_CODE_TIMEOUT_SEC", claude_code_cfg.get("timeoutSec", 900))),
            "model": _env_or("VO_CLAUDE_CODE_MODEL", claude_code_cfg.get("model", "")),
            "permissionMode": _env_or("VO_CLAUDE_CODE_PERMISSION_MODE", claude_code_cfg.get("permissionMode", "acceptEdits")),
            "includeMain": str(_env_or("VO_CLAUDE_CODE_INCLUDE_MAIN", claude_code_cfg.get("includeMain", True))).lower() not in ("0", "false", "no", "off"),
            "includeNativeAgents": str(_env_or("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", claude_code_cfg.get("includeNativeAgents", True))).lower() not in ("0", "false", "no", "off"),
            "registerNativeAgents": str(_env_or("VO_CLAUDE_CODE_REGISTER_NATIVE_AGENTS", claude_code_cfg.get("registerNativeAgents", True))).lower() not in ("0", "false", "no", "off"),
        },
        "openCode": {
            "enabled": str(_env_or("VO_OPENCODE_ENABLED", opencode_cfg.get("enabled", False))).lower() not in ("0", "false", "no", "off"),
            "homePath": _env_or("VO_OPENCODE_CONFIG_DIR", _env_or("VO_OPENCODE_HOME", opencode_cfg.get("homePath", os.path.expanduser("~/.config/opencode")))),
            "binary": _env_or("VO_OPENCODE_BIN", opencode_cfg.get("binary", "")),
            "workspaceRoot": opencode_workspace_root,
            "mainWorkspace": _env_or("VO_OPENCODE_MAIN_WORKSPACE", opencode_cfg.get("mainWorkspace", os.path.join(_env_or("VO_STATUS_DIR", presence.get("statusDir", "/data")), "opencode-main"))),
            "timeoutSec": int(_env_or("VO_OPENCODE_TIMEOUT_SEC", opencode_cfg.get("timeoutSec", 900))),
            "model": _env_or("VO_OPENCODE_MODEL", opencode_cfg.get("model", "")),
            "includeMain": str(_env_or("VO_OPENCODE_INCLUDE_MAIN", opencode_cfg.get("includeMain", True))).lower() not in ("0", "false", "no", "off"),
            "includeAgents": str(_env_or("VO_OPENCODE_INCLUDE_AGENTS", opencode_cfg.get("includeAgents", True))).lower() not in ("0", "false", "no", "off"),
            "registerAgents": str(_env_or("VO_OPENCODE_REGISTER_AGENTS", opencode_cfg.get("registerAgents", True))).lower() not in ("0", "false", "no", "off"),
        },
        "antigravity": {
            "enabled": str(_env_or("VO_ANTIGRAVITY_ENABLED", antigravity_cfg.get("enabled", False))).lower() not in ("0", "false", "no", "off"),
            "homePath": _env_or("VO_ANTIGRAVITY_HOME", antigravity_cfg.get("homePath", os.path.expanduser("~/.gemini/antigravity-cli"))),
            "binary": _env_or("VO_ANTIGRAVITY_BIN", antigravity_cfg.get("binary", "")),
            "workspaceRoot": antigravity_workspace_root,
            "timeoutSec": int(_env_or("VO_ANTIGRAVITY_TIMEOUT_SEC", antigravity_cfg.get("timeoutSec", 600))),
            "printTimeout": _env_or("VO_ANTIGRAVITY_PRINT_TIMEOUT", antigravity_cfg.get("printTimeout", "5m")),
            "model": _env_or("VO_ANTIGRAVITY_MODEL", antigravity_cfg.get("model", "")),
            "sandbox": _env_or("VO_ANTIGRAVITY_SANDBOX", antigravity_cfg.get("sandbox", "")),
        },
    }

VO_CONFIG = _load_vo_config()

try:
    SMS_DEFAULT_TZ = ZoneInfo(os.environ.get("VO_SMS_TIMEZONE") or os.environ.get("TZ") or "UTC")
except Exception:
    SMS_DEFAULT_TZ = timezone.utc

PORT = VO_CONFIG["office"]["port"]
WS_PORT = VO_CONFIG["office"]["wsPort"]
WORKSPACE_BASE = VO_CONFIG["openclaw"]["homePath"]
STATUS_DIR = VO_CONFIG["presence"]["statusDir"]
os.makedirs(STATUS_DIR, exist_ok=True)
STATUS_FILE = os.path.join(STATUS_DIR, "virtual-office-status.json")

_OPENCLAW_VERSION_CACHE = None


def _get_openclaw_version():
    """Return the installed OpenClaw version for Gateway client identification."""
    global _OPENCLAW_VERSION_CACHE
    if _OPENCLAW_VERSION_CACHE:
        return _OPENCLAW_VERSION_CACHE
    try:
        cfg_file = os.path.join(WORKSPACE_BASE, "openclaw.json")
        with open(cfg_file, "r") as f:
            cfg = json.load(f)
        for value in (
            ((cfg.get("meta") or {}).get("lastTouchedVersion")),
            ((cfg.get("wizard") or {}).get("lastRunVersion")),
        ):
            if value:
                _OPENCLAW_VERSION_CACHE = str(value)
                return _OPENCLAW_VERSION_CACHE
    except Exception:
        pass
    try:
        result = subprocess.run(
            ["openclaw", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        text_out = (result.stdout or result.stderr or "").strip()
        match = re.search(r"OpenClaw\s+([^\s]+)", text_out)
        if match:
            _OPENCLAW_VERSION_CACHE = match.group(1)
            return _OPENCLAW_VERSION_CACHE
    except Exception:
        pass
    _OPENCLAW_VERSION_CACHE = os.environ.get("OPENCLAW_VERSION", "unknown")
    return _OPENCLAW_VERSION_CACHE
PROJECTS_FILE = os.path.join(STATUS_DIR, "projects.json")
AGENT_WORKSPACES_FILE = os.path.join(STATUS_DIR, "agent-workspaces.json")
AUTH_PROFILES_PATH = os.path.join(WORKSPACE_BASE, "agents/main/agent/auth-profiles.json")
OPENCLAW_HOME = os.path.expanduser(os.environ.get("OPENCLAW_HOME") or WORKSPACE_BASE or "~/.openclaw")
OPENCLAW_AGENT_DIR = os.path.join(OPENCLAW_HOME, "agents/main/agent")


def _first_existing_executable(candidates):
    for candidate in candidates:
        if not candidate:
            continue
        candidate = os.path.expanduser(candidate)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


OPENCLAW_BIN = (
    os.environ.get("OPENCLAW_BIN")
    or VO_CONFIG.get("openclaw", {}).get("binary")
    or shutil.which("openclaw")
)
HERMES_HOME = os.path.expanduser(os.environ.get("HERMES_HOME") or VO_CONFIG.get("hermes", {}).get("homePath") or "~/.hermes")
HERMES_BIN = (
    os.environ.get("HERMES_BIN")
    or VO_CONFIG.get("hermes", {}).get("binary")
    or shutil.which("hermes")
)


def _run_json_command(args, timeout=30, env=None, input_text=None):
    """Run a native CLI command that returns JSON."""
    try:
        result = subprocess.run(
            args,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
        if result.returncode != 0:
            return {
                "ok": False,
                "error": (result.stderr or result.stdout or f"exit {result.returncode}").strip(),
                "returnCode": result.returncode,
            }
        text_out = (result.stdout or "").strip()
        # Some CLIs print warnings before JSON. Keep the parser tolerant.
        start = min([i for i in [text_out.find("{"), text_out.find("[")] if i >= 0] or [-1])
        if start > 0:
            text_out = text_out[start:]
        return {"ok": True, "data": json.loads(text_out or "{}")}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _run_text_command(args, timeout=30, env=None, input_text=None):
    try:
        result = subprocess.run(args, input=input_text, capture_output=True, text=True, timeout=timeout, env=env)
        return {
            "ok": result.returncode == 0,
            "text": (result.stdout or result.stderr or "").strip(),
            "returnCode": result.returncode,
        }
    except Exception as e:
        return {"ok": False, "text": str(e), "returnCode": -1}


def _provider_from_model_id(model_id):
    return str(model_id or "").split("/", 1)[0] if "/" in str(model_id or "") else ""


def _safe_provider_id(value):
    provider = str(value or "").strip().lower()
    provider = re.sub(r"[^a-z0-9_.:-]+", "-", provider).strip("-")
    return provider[:80]


def _parse_model_entries(value):
    entries = []
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = str(value or "").replace(",", "\n").splitlines()
    seen = set()
    for item in raw_items:
        if isinstance(item, dict):
            model_id = str(item.get("id") or item.get("model") or item.get("name") or "").strip()
            name = str(item.get("name") or model_id).strip()
            context = item.get("contextWindow") or item.get("context") or 100000
            max_tokens = item.get("maxTokens") or 8192
        else:
            model_id = str(item or "").strip()
            name = model_id
            context = 100000
            max_tokens = 8192
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        try:
            context = int(context)
        except Exception:
            context = 100000
        try:
            max_tokens = int(max_tokens)
        except Exception:
            max_tokens = 8192
        entries.append({
            "id": model_id,
            "name": name,
            "contextWindow": context,
            "maxTokens": max_tokens,
        })
    return entries


def _mask_secret(value):
    value = str(value or "")
    if not value:
        return ""
    if len(value) <= 8:
        return "****"
    return value[:4] + "••••••••" + value[-4:]


def _atomic_write_text(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    existing_stat = None
    try:
        existing_stat = os.stat(path)
    except OSError:
        existing_stat = None
    tmp_path = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        if existing_stat is not None:
            try:
                os.fchmod(f.fileno(), existing_stat.st_mode & 0o777)
            except OSError:
                pass
            try:
                os.fchown(f.fileno(), existing_stat.st_uid, existing_stat.st_gid)
            except OSError:
                pass
        os.fsync(f.fileno())
    os.replace(tmp_path, path)


def _openclaw_config_path():
    return os.path.join(WORKSPACE_BASE, "openclaw.json")


def _load_openclaw_model_config():
    try:
        with open(_openclaw_config_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _safe_openclaw_agent_id(agent_id=None):
    safe_id = re.sub(r"[^A-Za-z0-9_.-]", "", str(agent_id or "").strip())
    return safe_id or "main"


def _openclaw_agent_dir(agent_id=None):
    return os.path.join(WORKSPACE_BASE, "agents", _safe_openclaw_agent_id(agent_id), "agent")


def _openclaw_auth_profiles_path(agent_id=None):
    return os.path.join(_openclaw_agent_dir(agent_id), "auth-profiles.json")


def _openclaw_binary():
    configured = os.environ.get("OPENCLAW_BIN") or VO_CONFIG.get("openclaw", {}).get("binary") or ""
    candidates = [
        configured,
        shutil.which("openclaw"),
        os.path.expanduser("~/.npm-global/bin/openclaw"),
        os.path.expanduser("~/.local/bin/openclaw"),
        "/usr/local/bin/openclaw",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        expanded = os.path.expanduser(candidate)
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return expanded
    return ""


def _primary_openclaw_model(cfg=None):
    cfg = cfg if isinstance(cfg, dict) else _load_openclaw_model_config()
    return str(cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", "") or "")


def _default_openclaw_model(cfg=None):
    cfg = cfg if isinstance(cfg, dict) else _load_openclaw_model_config()
    for agent in cfg.get("agents", {}).get("list", []) or []:
        if isinstance(agent, dict) and agent.get("default") and agent.get("model"):
            return str(agent.get("model") or "")
    return _primary_openclaw_model(cfg) or "unknown"


def _context_window_for_model(model, provider="", cfg=None):
    model = str(model or "")
    provider = str(provider or _provider_from_model_id(model) or "")
    cfg = cfg if isinstance(cfg, dict) else _load_openclaw_model_config()
    configured = cfg.get("agents", {}).get("defaults", {}).get("models", {})
    if isinstance(configured, dict):
        meta = configured.get(model)
        if isinstance(meta, dict):
            params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
            value = meta.get("contextWindow") or params.get("contextWindow")
            if value:
                try:
                    return int(value)
                except Exception:
                    pass
    for pdata_provider, pdata in (cfg.get("models", {}).get("providers", {}) or {}).items():
        if provider and pdata_provider != provider:
            continue
        if not isinstance(pdata, dict):
            continue
        for item in pdata.get("models", []) or []:
            if not isinstance(item, dict):
                continue
            raw_id = str(item.get("id") or item.get("model") or item.get("name") or "").strip()
            full_id = raw_id if "/" in raw_id else f"{pdata_provider}/{raw_id}" if raw_id else ""
            if model in {raw_id, full_id} and item.get("contextWindow"):
                try:
                    return int(item.get("contextWindow") or 0)
                except Exception:
                    return 0
    return 0


def _read_openclaw_auth_sqlite(agent_id=None):
    db_path = os.path.join(_openclaw_agent_dir(agent_id), "openclaw-agent.sqlite")
    profiles = []
    if not os.path.exists(db_path):
        return profiles
    con = None
    try:
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
        for table in tables:
            qtable = _quote_sqlite_identifier(table)
            cols = [r[1] for r in con.execute(f"pragma table_info({qtable})")]
            if "store_json" in cols:
                for row in con.execute(f"select store_json from {qtable}").fetchall():
                    try:
                        data = json.loads(row["store_json"] or "{}")
                    except Exception:
                        continue
                    for profile_id, profile in (data.get("profiles") or {}).items():
                        if not isinstance(profile, dict):
                            continue
                        provider = profile.get("provider") or profile_id.split(":", 1)[0]
                        ptype = profile.get("type") or profile.get("mode") or "profile"
                        email = profile.get("email") or ""
                        profiles.append({
                            "id": profile_id,
                            "provider": provider,
                            "type": ptype,
                            "label": profile_id + (f" ({email})" if email else ""),
                            "source": "sqlite",
                        })
                continue
            if not {"id", "provider"}.issubset(set(cols)):
                continue
            type_col = "type" if "type" in cols else ("mode" if "mode" in cols else None)
            rows = con.execute(f"select * from {qtable}").fetchall()
            for row in rows:
                provider = row["provider"]
                profile_id = row["id"]
                if not provider or not profile_id:
                    continue
                ptype = row[type_col] if type_col else ""
                email = row["email"] if "email" in cols else ""
                label = profile_id + (f" ({email})" if email else "")
                profiles.append({
                    "id": profile_id,
                    "provider": provider,
                    "type": ptype or "profile",
                    "label": label,
                    "source": "sqlite",
                })
    except Exception:
        return profiles
    finally:
        try:
            if con:
                con.close()
        except Exception:
            pass
    # Deduplicate by id/provider/type.
    seen = set()
    unique = []
    for profile in profiles:
        key = (profile["id"], profile["provider"], profile["type"])
        if key not in seen:
            seen.add(key)
            unique.append(profile)
    return unique


def _read_openclaw_auth_json(agent_id=None):
    profiles = []
    try:
        with open(_openclaw_auth_profiles_path(agent_id), "r") as f:
            data = json.load(f)
    except Exception:
        return profiles
    for profile_id, profile in (data.get("profiles") or {}).items():
        if not isinstance(profile, dict):
            continue
        provider = profile.get("provider") or profile_id.split(":", 1)[0]
        ptype = profile.get("type") or profile.get("mode") or "profile"
        email = profile.get("email") or ""
        profiles.append({
            "id": profile_id,
            "provider": provider,
            "type": ptype,
            "label": profile_id + (f" ({email})" if email else ""),
            "source": "auth-profiles.json",
        })
    return profiles


def _read_openclaw_auth_profiles(agent_id=None):
    sqlite_profiles = _read_openclaw_auth_sqlite(agent_id)
    if sqlite_profiles:
        return sqlite_profiles
    return _read_openclaw_auth_json(agent_id)


def _quote_sqlite_identifier(name):
    return '"' + str(name).replace('"', '""') + '"'


def _openclaw_agent_ids():
    ids = ["main"]
    cfg = _load_openclaw_model_config()
    for item in cfg.get("agents", {}).get("list", []) or []:
        if isinstance(item, dict) and item.get("id"):
            safe_id = _safe_openclaw_agent_id(item.get("id"))
            if safe_id and safe_id not in ids:
                ids.append(safe_id)
    agents_dir = os.path.join(WORKSPACE_BASE, "agents")
    try:
        for name in sorted(os.listdir(agents_dir)):
            if not os.path.isdir(os.path.join(agents_dir, name, "agent")):
                continue
            safe_id = _safe_openclaw_agent_id(name)
            if safe_id and safe_id not in ids:
                ids.append(safe_id)
    except OSError:
        pass
    return ids


def _openclaw_profile_provider(profile_id, profile):
    profile = profile if isinstance(profile, dict) else {}
    return profile.get("provider") or str(profile_id or "").split(":", 1)[0]


def _openclaw_profile_type(profile):
    profile = profile if isinstance(profile, dict) else {}
    return str(profile.get("type") or profile.get("mode") or "").lower()


def _is_openclaw_portable_static_profile(profile):
    if not isinstance(profile, dict) or profile.get("copyToAgents") is False:
        return False
    ptype = _openclaw_profile_type(profile)
    if ptype in {"api_key", "key"} or "key" in profile:
        return True
    if ptype == "token" and (profile.get("token") or profile.get("tokenRef")):
        return True
    return False


def _read_openclaw_auth_profile_map(agent_id=None):
    db_path = os.path.join(_openclaw_agent_dir(agent_id), "openclaw-agent.sqlite")
    if os.path.exists(db_path):
        con = None
        try:
            con = sqlite3.connect(db_path)
            con.row_factory = sqlite3.Row
            tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
            for table in tables:
                qtable = _quote_sqlite_identifier(table)
                cols = [r[1] for r in con.execute(f"pragma table_info({qtable})")]
                if not {"store_key", "store_json"}.issubset(set(cols)):
                    continue
                row = con.execute(f"select store_json from {qtable} where store_key = ?", ("primary",)).fetchone()
                if not row:
                    continue
                data = json.loads(row["store_json"] or "{}")
                profiles = data.get("profiles") if isinstance(data, dict) else {}
                if isinstance(profiles, dict):
                    return {pid: dict(profile) for pid, profile in profiles.items() if isinstance(profile, dict)}
        except Exception:
            pass
        finally:
            try:
                if con:
                    con.close()
            except Exception:
                pass
    try:
        with open(_openclaw_auth_profiles_path(agent_id), "r") as f:
            data = json.load(f)
    except Exception:
        return {}
    profiles = data.get("profiles") if isinstance(data, dict) else {}
    return {pid: dict(profile) for pid, profile in profiles.items() if isinstance(profile, dict)}


def _openclaw_profile_public(profile_id, profile, *, agent_id=None, main_profiles=None):
    profile = profile if isinstance(profile, dict) else {}
    ptype = _openclaw_profile_type(profile) or "profile"
    email = profile.get("email") or ""
    provider = _openclaw_profile_provider(profile_id, profile)
    main_profile = (main_profiles or {}).get(profile_id) if isinstance(main_profiles, dict) else None
    return {
        "id": profile_id,
        "provider": provider,
        "type": ptype,
        "label": profile_id + (f" ({email})" if email else ""),
        "agent": agent_id,
        "portableStatic": _is_openclaw_portable_static_profile(profile),
        "localOverride": agent_id not in {None, "main"},
        "matchesMain": main_profile == profile if main_profile is not None else False,
        "inMain": main_profile is not None,
    }


def _openclaw_managed_auth_report():
    agent_ids = _openclaw_agent_ids()
    main_profiles = _read_openclaw_auth_profile_map("main")
    managed_profiles = {
        pid: profile
        for pid, profile in main_profiles.items()
        if _is_openclaw_portable_static_profile(profile)
    }
    agent_rows = []
    for agent_id in agent_ids:
        profiles = _read_openclaw_auth_profile_map(agent_id)
        if agent_id == "main":
            missing = []
            divergent = []
            extra_static = []
        else:
            missing = [pid for pid in managed_profiles if pid not in profiles]
            divergent = [
                pid for pid, profile in managed_profiles.items()
                if pid in profiles and profiles.get(pid) != profile
            ]
            extra_static = [
                pid for pid, profile in profiles.items()
                if _is_openclaw_portable_static_profile(profile)
                and pid not in managed_profiles
            ]
        local_oauth = [
            pid for pid, profile in profiles.items()
            if _openclaw_profile_type(profile) == "oauth"
        ]
        agent_rows.append({
            "agent": agent_id,
            "profileCount": len(profiles),
            "profiles": [
                _openclaw_profile_public(pid, profile, agent_id=agent_id, main_profiles=main_profiles)
                for pid, profile in sorted(profiles.items())
            ],
            "missingManagedStatic": missing,
            "divergentManagedStatic": divergent,
            "extraStaticProfiles": extra_static,
            "localOAuthProfiles": local_oauth,
            "staticInSync": not missing and not divergent and not extra_static,
        })
    return {
        "sourceAgent": "main",
        "managedStaticProfiles": [
            _openclaw_profile_public(pid, profile, agent_id="main", main_profiles=main_profiles)
            for pid, profile in sorted(managed_profiles.items())
        ],
        "agentRows": agent_rows,
    }


def _update_openclaw_sqlite_auth_stores(updater, agent_id=None):
    db_path = os.path.join(_openclaw_agent_dir(agent_id), "openclaw-agent.sqlite")
    if not os.path.exists(db_path):
        return 0, None
    updated = 0
    con = None
    try:
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
        now_ms = int(time.time() * 1000)
        for table in tables:
            qtable = _quote_sqlite_identifier(table)
            cols = [r[1] for r in con.execute(f"pragma table_info({qtable})")]
            if not {"store_key", "store_json", "updated_at"}.issubset(set(cols)):
                continue
            rows = con.execute(f"select store_key, store_json from {qtable}").fetchall()
            for row in rows:
                try:
                    data = json.loads(row["store_json"] or "{}")
                except Exception:
                    continue
                if not isinstance(data.get("profiles"), dict):
                    continue
                changed = updater(data)
                if not changed:
                    continue
                con.execute(
                    f"update {qtable} set store_json = ?, updated_at = ? where store_key = ?",
                    (json.dumps(data, separators=(",", ":")), now_ms, row["store_key"]),
                )
                updated += 1
        con.commit()
        return updated, None
    except Exception as e:
        return updated, str(e)
    finally:
        try:
            if con:
                con.close()
        except Exception:
            pass


def _update_openclaw_auth_profiles_json(updater, create_if_missing=False, agent_id=None):
    path = _openclaw_auth_profiles_path(agent_id)
    if not os.path.exists(path) and not create_if_missing:
        return False, None
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            with open(path, "r") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {"version": 1, "profiles": {}, "lastGood": {}}
        data.setdefault("version", 1)
        data.setdefault("profiles", {})
        data.setdefault("lastGood", {})
        changed = updater(data)
        if not changed:
            return False, None
        _atomic_write_text(path, json.dumps(data, indent=2) + "\n")
        return True, None
    except Exception as e:
        return False, str(e)


def _mirror_openclaw_config_auth_profile(provider, profile_id):
    cfg_path = _openclaw_config_path()
    cfg = _load_openclaw_model_config()
    cfg.setdefault("auth", {}).setdefault("profiles", {})[profile_id] = {
        "provider": provider,
        "mode": "api_key",
    }
    try:
        _atomic_write_text(cfg_path, json.dumps(cfg, indent=2) + "\n")
        return True, None
    except OSError as exc:
        return False, str(exc)


def _remove_openclaw_config_auth_profiles(profile_ids):
    if not profile_ids:
        return True, None
    cfg_path = _openclaw_config_path()
    cfg = _load_openclaw_model_config()
    profiles = cfg.setdefault("auth", {}).setdefault("profiles", {})
    changed = False
    for profile_id in profile_ids:
        if profile_id in profiles:
            profiles.pop(profile_id, None)
            changed = True
    if not changed:
        return True, None
    try:
        _atomic_write_text(cfg_path, json.dumps(cfg, indent=2) + "\n")
        return True, None
    except OSError as exc:
        return False, str(exc)


def _cleanup_openclaw_sqlite_auth_state(agent_id, provider, profile_ids):
    profile_ids = {str(pid) for pid in (profile_ids or []) if pid}
    if not profile_ids:
        return 0, None
    db_path = os.path.join(_openclaw_agent_dir(agent_id), "openclaw-agent.sqlite")
    if not os.path.exists(db_path):
        return 0, None
    updated = 0
    con = None
    try:
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
        now_ms = int(time.time() * 1000)
        for table in tables:
            qtable = _quote_sqlite_identifier(table)
            cols = [r[1] for r in con.execute(f"pragma table_info({qtable})")]
            if not {"state_key", "state_json", "updated_at"}.issubset(set(cols)):
                continue
            rows = con.execute(f"select state_key, state_json from {qtable}").fetchall()
            for row in rows:
                try:
                    data = json.loads(row["state_json"] or "{}")
                except Exception:
                    continue
                changed = False
                last_good = data.get("lastGood")
                if isinstance(last_good, dict):
                    for key, value in list(last_good.items()):
                        if value in profile_ids:
                            last_good.pop(key, None)
                            changed = True
                order = data.get("order")
                if isinstance(order, dict):
                    for key, values in list(order.items()):
                        if isinstance(values, list):
                            kept = [value for value in values if value not in profile_ids]
                            if kept != values:
                                order[key] = kept
                                changed = True
                usage_stats = data.get("usageStats")
                if isinstance(usage_stats, dict):
                    for profile_id in profile_ids:
                        if profile_id in usage_stats:
                            usage_stats.pop(profile_id, None)
                            changed = True
                if not changed:
                    continue
                con.execute(
                    f"update {qtable} set state_json = ?, updated_at = ? where state_key = ?",
                    (json.dumps(data, separators=(",", ":")), now_ms, row["state_key"]),
                )
                updated += 1
        con.commit()
        return updated, None
    except Exception as exc:
        return updated, str(exc)
    finally:
        try:
            if con:
                con.close()
        except Exception:
            pass


def _sync_openclaw_static_auth_from_main(provider=None, profile_id=None, target_agent=None, prune=False):
    provider = _safe_provider_id(provider) if provider else ""
    profile_id = str(profile_id or "").strip()
    target_agent = _safe_openclaw_agent_id(target_agent) if target_agent else ""
    main_profiles = _read_openclaw_auth_profile_map("main")
    managed_profiles = {
        pid: dict(profile)
        for pid, profile in main_profiles.items()
        if _is_openclaw_portable_static_profile(profile)
        and (not provider or _openclaw_profile_provider(pid, profile) == provider)
        and (not profile_id or pid == profile_id)
    }
    if profile_id and not managed_profiles:
        return {"ok": False, "error": f"Portable static profile not found in main: {profile_id}"}

    agent_ids = [target_agent] if target_agent else _openclaw_agent_ids()
    summary = []
    touched = 0
    removed_by_agent = {}
    for agent_id in agent_ids:
        if agent_id == "main":
            continue
        removed = []

        def updater(data):
            profiles = data.setdefault("profiles", {})
            changed = False
            for pid, profile in managed_profiles.items():
                if profiles.get(pid) != profile:
                    profiles[pid] = dict(profile)
                    changed = True
            if prune:
                remove = [
                    pid for pid, profile in list(profiles.items())
                    if isinstance(profile, dict)
                    and _is_openclaw_portable_static_profile(profile)
                    and (not provider or _openclaw_profile_provider(pid, profile) == provider)
                    and (not profile_id or pid == profile_id or pid not in managed_profiles)
                    and (pid not in managed_profiles or profiles.get(pid) != managed_profiles.get(pid))
                ]
                for pid in remove:
                    profiles.pop(pid, None)
                    removed.append(pid)
                    changed = True
                last_good = data.get("lastGood")
                if isinstance(last_good, dict):
                    for key, value in list(last_good.items()):
                        if value in remove:
                            last_good.pop(key, None)
            return changed

        sqlite_updates, sqlite_err = _update_openclaw_sqlite_auth_stores(updater, agent_id=agent_id)
        json_updated, json_err = _update_openclaw_auth_profiles_json(updater, create_if_missing=(sqlite_updates == 0 and not sqlite_err), agent_id=agent_id)
        if removed:
            removed_by_agent[agent_id] = removed
            _cleanup_openclaw_sqlite_auth_state(agent_id, provider, removed)
        ok = not ((sqlite_err and not json_updated) or (json_err and sqlite_updates == 0))
        if ok and (sqlite_updates or json_updated or removed):
            touched += 1
        summary.append({
            "agent": agent_id,
            "ok": ok,
            "sqliteUpdates": sqlite_updates,
            "jsonUpdated": bool(json_updated),
            "removedProfiles": removed,
            "error": sqlite_err or json_err or "",
        })
    _signal_openclaw_gateway(restart=False)
    return {
        "ok": all(item["ok"] for item in summary),
        "sourceAgent": "main",
        "provider": provider,
        "profileId": profile_id,
        "syncedProfiles": sorted(managed_profiles.keys()),
        "touchedAgents": touched,
        "agents": summary,
        "removedProfilesByAgent": removed_by_agent,
    }


def _reset_openclaw_static_auth_overrides(agent_id=None, provider=None):
    agent_id = _safe_openclaw_agent_id(agent_id) if agent_id else ""
    if agent_id == "main":
        return {"ok": False, "error": "main is the Virtual Office global auth source and cannot be reset to itself"}
    return _sync_openclaw_static_auth_from_main(provider=provider, target_agent=agent_id or None, prune=True)


def _save_openclaw_api_key_direct(provider, profile_id, api_key, agent_id=None):
    profile = {"type": "api_key", "provider": provider, "key": api_key}
    agent_id = _safe_openclaw_agent_id(agent_id)

    def updater(data):
        profiles = data.setdefault("profiles", {})
        if profiles.get(profile_id) == profile:
            return False
        profiles[profile_id] = dict(profile)
        last_good = data.get("lastGood")
        if isinstance(last_good, dict):
            last_good[provider] = profile_id
        return True

    sqlite_updates, sqlite_err = _update_openclaw_sqlite_auth_stores(updater, agent_id=agent_id)
    json_updated, json_err = _update_openclaw_auth_profiles_json(
        updater,
        create_if_missing=(sqlite_updates == 0 and not sqlite_err),
        agent_id=agent_id,
    )
    if sqlite_err and not json_updated:
        return {"ok": False, "error": f"Cannot write OpenClaw auth store: {sqlite_err}"}
    if json_err and sqlite_updates == 0:
        return {"ok": False, "error": f"Cannot write auth-profiles.json: {json_err}"}

    _mirror_openclaw_config_auth_profile(provider, profile_id)
    _signal_openclaw_gateway(restart=False)
    return {
        "ok": True,
        "provider": provider,
        "profileId": profile_id,
        "agent": agent_id,
        "maskedKey": _mask_secret(api_key),
        "source": "direct-auth-store",
    }


def _delete_openclaw_auth_direct(provider, profile_id="", agent_id=None):
    deleted = set()
    agent_id = _safe_openclaw_agent_id(agent_id)

    def should_delete(pid, profile):
        if profile_id:
            return pid == profile_id
        if (profile.get("provider") or pid.split(":", 1)[0]) != provider:
            return False
        ptype = str(profile.get("type") or profile.get("mode") or "").lower()
        return ptype in {"api_key", "key"} or "key" in profile

    def updater(data):
        profiles = data.setdefault("profiles", {})
        remove = [pid for pid, profile in profiles.items() if isinstance(profile, dict) and should_delete(pid, profile)]
        for pid in remove:
            profiles.pop(pid, None)
            deleted.add(pid)
        last_good = data.get("lastGood")
        if isinstance(last_good, dict):
            for key, value in list(last_good.items()):
                if value in remove:
                    last_good.pop(key, None)
        return bool(remove)

    sqlite_updates, sqlite_err = _update_openclaw_sqlite_auth_stores(updater, agent_id=agent_id)
    json_updated, json_err = _update_openclaw_auth_profiles_json(updater, create_if_missing=False, agent_id=agent_id)
    if sqlite_err and not json_updated:
        return {"ok": False, "error": f"Cannot write OpenClaw auth store: {sqlite_err}"}
    if json_err and sqlite_updates == 0:
        return {"ok": False, "error": f"Cannot write auth-profiles.json: {json_err}"}
    state_updates, state_err = _cleanup_openclaw_sqlite_auth_state(agent_id, provider, deleted)
    if state_err and not deleted:
        return {"ok": False, "error": f"Cannot update OpenClaw auth state: {state_err}"}

    _remove_openclaw_config_auth_profiles(deleted)
    _signal_openclaw_gateway(restart=False)
    return {"ok": True, "provider": provider, "agent": agent_id, "deletedProfiles": sorted(deleted), "stateUpdates": state_updates, "source": "direct-auth-store"}


def _read_openclaw_config_models(cfg):
    models = []
    default_model = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", "")
    if default_model:
        models.append({
            "id": default_model,
            "key": default_model,
            "name": default_model.split("/", 1)[-1],
            "provider": _provider_from_model_id(default_model),
            "available": True,
            "missing": False,
            "tags": ["default"],
            "source": "openclaw-config",
        })
    for model_id, data in cfg.get("agents", {}).get("defaults", {}).get("models", {}).items():
        models.append({
            "id": model_id,
            "key": model_id,
            "name": model_id.split("/", 1)[-1],
            "provider": _provider_from_model_id(model_id),
            "input": ",".join(data.get("input", [])) if isinstance(data, dict) else "",
            "contextWindow": ((data or {}).get("params") or {}).get("contextWindow", 0) if isinstance(data, dict) else 0,
            "available": True,
            "missing": False,
            "tags": ["configured"],
            "source": "openclaw-config",
        })
    for provider, pdata in cfg.get("models", {}).get("providers", {}).items():
        for m in pdata.get("models", []):
            mid = f"{provider}/{m.get('id')}"
            models.append({
                "id": mid,
                "key": mid,
                "name": m.get("name") or m.get("id"),
                "provider": provider,
                "input": ",".join(m.get("input", [])) if isinstance(m.get("input"), list) else m.get("input"),
                "contextWindow": m.get("contextWindow", 0),
                "available": True,
                "missing": False,
                "tags": [],
                "source": "openclaw-config",
            })
    deduped = {}
    for model in models:
        deduped[model["id"]] = {**deduped.get(model["id"], {}), **model}
    return list(deduped.values())


_OPENCLAW_CLOUD_PROVIDER_IDS = {
    "anthropic",
    "openai",
    "openai-codex",
    "google",
    "gemini",
    "groq",
    "openrouter",
    "mistral",
    "cohere",
    "xai",
    "github-copilot",
    "copilot",
}


def _openclaw_provider_kind(provider, pdata):
    provider = _safe_provider_id(provider)
    pdata = pdata if isinstance(pdata, dict) else {}
    api = str(pdata.get("api") or "").lower()
    base_url = str(pdata.get("baseUrl") or "").strip()
    if provider in {"ollama", "lmstudio"} or api == "ollama":
        return "local"
    if base_url:
        return "local" if provider not in _OPENCLAW_CLOUD_PROVIDER_IDS else "cloud"
    if provider in _OPENCLAW_CLOUD_PROVIDER_IDS:
        return "cloud"
    return "local"


def _openclaw_local_providers_from_config(cfg):
    providers = []
    for provider, pdata in (cfg.get("models", {}).get("providers", {}) or {}).items():
        if _openclaw_provider_kind(provider, pdata) != "local":
            continue
        model_rows = []
        for model in pdata.get("models", []) or []:
            model_id = str(model.get("id") or "").strip()
            if not model_id:
                continue
            model_rows.append({
                "id": model_id,
                "name": model.get("name") or model_id,
                "contextWindow": model.get("contextWindow", 0),
                "maxTokens": model.get("maxTokens", 0),
            })
        providers.append({
            "id": provider,
            "provider": provider,
            "baseUrl": pdata.get("baseUrl", ""),
            "api": pdata.get("api", ""),
            "apiKeyConfigured": bool(pdata.get("apiKey")),
            "timeoutSeconds": pdata.get("timeoutSeconds"),
            "models": model_rows,
            "modelCount": len(model_rows),
            "source": "openclaw-config",
        })
    return sorted(providers, key=lambda item: item.get("provider", ""))


def _openclaw_cloud_providers_from_config(cfg, auth_profiles=None):
    auth_profiles = auth_profiles or []
    configured = {}
    for model_id, data in (cfg.get("agents", {}).get("defaults", {}).get("models", {}) or {}).items():
        provider = _provider_from_model_id(model_id)
        if provider in _OPENCLAW_CLOUD_PROVIDER_IDS:
            configured.setdefault(provider, []).append({
                "id": model_id,
                "name": model_id.split("/", 1)[-1],
                "contextWindow": ((data or {}).get("params") or {}).get("contextWindow", 0) if isinstance(data, dict) else 0,
                "source": "agents.defaults.models",
            })
    for provider, pdata in (cfg.get("models", {}).get("providers", {}) or {}).items():
        if _openclaw_provider_kind(provider, pdata) != "cloud":
            continue
        for model in pdata.get("models", []) or []:
            model_id = str(model.get("id") or "").strip()
            if not model_id:
                continue
            configured.setdefault(provider, []).append({
                "id": f"{provider}/{model_id}",
                "name": model.get("name") or model_id,
                "contextWindow": model.get("contextWindow", 0),
                "source": "models.providers",
            })
    for profile in auth_profiles:
        provider = profile.get("provider") or _provider_from_model_id(profile.get("id", ""))
        if provider in _OPENCLAW_CLOUD_PROVIDER_IDS:
            configured.setdefault(provider, [])

    cloud_providers = []
    for provider, models in configured.items():
        seen = set()
        model_rows = []
        for model in models:
            mid = model.get("id")
            if not mid or mid in seen:
                continue
            seen.add(mid)
            model_rows.append(model)
        profiles = [p for p in auth_profiles if (p.get("provider") or _provider_from_model_id(p.get("id", ""))) == provider]
        cloud_providers.append({
            "id": provider,
            "provider": provider,
            "authProfiles": profiles,
            "authTypes": sorted({str(p.get("type") or p.get("mode") or "profile") for p in profiles if p}),
            "models": sorted(model_rows, key=lambda item: item.get("id", "")),
            "modelCount": len(model_rows),
            "source": "openclaw-cloud",
        })
    return sorted(cloud_providers, key=lambda item: item.get("provider", ""))


def _get_openclaw_native_fallback(reason="", agent_id=None):
    auth_agent_id = _safe_openclaw_agent_id(agent_id)
    try:
        cfg = _load_openclaw_model_config()
    except Exception as e:
        return {"ok": False, "error": str(e), "models": [], "authProfiles": [], "agents": {}}
    agents = {}
    for agent in cfg.get("agents", {}).get("list", []):
        agents[agent.get("id")] = {
            "id": agent.get("id"),
            "workspace": agent.get("workspace"),
            "model": agent.get("model", ""),
        }
    models = _read_openclaw_config_models(cfg)
    auth_profiles = _read_openclaw_auth_profiles(auth_agent_id)
    return {
        "ok": True,
        "warning": reason or "OpenClaw CLI unavailable; read mounted native config/auth store",
        "models": models,
        "authProfiles": auth_profiles,
        "authAgent": auth_agent_id,
        "authStatus": {"agent": auth_agent_id, "storePath": os.path.join(_openclaw_agent_dir(auth_agent_id), "openclaw-agent.sqlite"), "source": "sqlite-fallback"},
        "managedAuth": _openclaw_managed_auth_report(),
        "defaultModel": cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", ""),
        "runtimeDefaultModel": _default_openclaw_model(cfg),
        "agents": agents,
        "providers": sorted({m["provider"] for m in models if m.get("provider")}),
        "localProviders": _openclaw_local_providers_from_config(cfg),
        "cloudProviders": _openclaw_cloud_providers_from_config(cfg, auth_profiles),
        "nativeCommands": {
            "list": "openclaw models list --all --json",
            "auth": "openclaw models auth list --json",
            "status": "openclaw models status --json",
            "assign": "openclaw config patch / agents.list[].model",
        },
    }


def _get_openclaw_native_models(agent_id=None):
    """Return OpenClaw's native model/auth/catalog state."""
    auth_agent_id = _safe_openclaw_agent_id(agent_id)
    openclaw_bin = _openclaw_binary() or OPENCLAW_BIN
    if not openclaw_bin:
        return _get_openclaw_native_fallback("OpenClaw CLI binary unavailable in this container", auth_agent_id)
    list_result = _run_json_command([openclaw_bin, "models", "list", "--all", "--json"], timeout=45)
    auth_result = _run_json_command([openclaw_bin, "models", "auth", "list", "--agent", auth_agent_id, "--json"], timeout=30)
    status_result = _run_json_command([openclaw_bin, "models", "status", "--json"], timeout=30)

    if not list_result.get("ok"):
        return _get_openclaw_native_fallback(list_result.get("error") or "OpenClaw CLI model list failed", auth_agent_id)

    models = []
    if list_result.get("ok"):
        for m in (list_result.get("data") or {}).get("models", []):
            key = m.get("key") or m.get("id") or ""
            if not key:
                continue
            models.append({
                "id": key,
                "key": key,
                "name": m.get("name") or key.split("/", 1)[-1],
                "provider": m.get("provider") or _provider_from_model_id(key),
                "input": m.get("input"),
                "contextWindow": m.get("contextWindow") or 0,
                "available": bool(m.get("available", not m.get("missing", False))),
                "missing": bool(m.get("missing", False)),
                "local": bool(m.get("local", False)),
                "tags": m.get("tags") or [],
                "source": "openclaw",
            })

    auth_profiles = []
    if auth_result.get("ok"):
        auth_profiles = (auth_result.get("data") or {}).get("profiles", [])
    if not auth_profiles:
        auth_profiles = _read_openclaw_auth_profiles(auth_agent_id)

    status = status_result.get("data") if status_result.get("ok") else {}
    agents = {}
    default_model = ""
    local_providers = []
    cloud_providers = []
    try:
        cfg = _load_openclaw_model_config()
        default_model = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", "")
        local_providers = _openclaw_local_providers_from_config(cfg)
        cloud_providers = _openclaw_cloud_providers_from_config(cfg, auth_profiles)
        for agent in cfg.get("agents", {}).get("list", []):
            agents[agent.get("id")] = {
                "id": agent.get("id"),
                "workspace": agent.get("workspace"),
                "model": agent.get("model", ""),
            }
    except Exception:
        pass

    return {
        "ok": list_result.get("ok", False),
        "error": list_result.get("error"),
        "models": models,
        "authProfiles": auth_profiles,
        "authAgent": auth_agent_id,
        "authStatus": status.get("auth") if isinstance(status, dict) else {"agent": auth_agent_id, "storePath": os.path.join(_openclaw_agent_dir(auth_agent_id), "openclaw-agent.sqlite"), "source": "native-store"},
        "managedAuth": _openclaw_managed_auth_report(),
        "defaultModel": default_model,
        "runtimeDefaultModel": _default_openclaw_model(cfg if "cfg" in locals() else None),
        "agents": agents,
        "providers": sorted({m["provider"] for m in models if m.get("provider")}),
        "localProviders": local_providers,
        "cloudProviders": cloud_providers,
        "nativeCommands": {
            "list": "openclaw models list --all --json",
            "auth": "openclaw models auth list --json",
            "status": "openclaw models status --json",
            "assign": "openclaw config patch / agents.list[].model",
        },
    }


def _load_yaml_file(path):
    if not os.path.exists(path):
        return {}
    if yaml:
        try:
            with open(path, "r") as f:
                return yaml.safe_load(f) or {}
        except Exception:
            return {}
    # Minimal fallback parser for model and model_aliases when PyYAML is unavailable.
    data = {}
    current = None
    current_alias = None
    try:
        with open(path, "r") as f:
            for raw in f:
                line = raw.rstrip("\n")
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                if not line.startswith(" ") and line.endswith(":"):
                    current = line[:-1].strip()
                    current_alias = None
                    data.setdefault(current, {})
                    continue
                if current and line.startswith("  ") and ":" in line:
                    key, value = line.strip().split(":", 1)
                    value = value.strip().strip("\"'")
                    if current == "model_aliases" and not raw.startswith("    ") and not value:
                        current_alias = key.strip()
                        data.setdefault(current, {}).setdefault(current_alias, {})
                    elif current == "model_aliases" and current_alias and raw.startswith("    "):
                        data.setdefault(current, {}).setdefault(current_alias, {})[key.strip()] = value
                    else:
                        data.setdefault(current, {})[key.strip()] = value
    except Exception:
        return {}
    return data


def _hermes_profile_config_path(profile_id):
    profile_id = str(profile_id or "default")
    if profile_id in ("", "default"):
        return os.path.join(HERMES_HOME, "config.yaml")
    return os.path.join(HERMES_HOME, "profiles", profile_id, "config.yaml")


def _hermes_args(profile_id, *extra):
    args = [HERMES_BIN]
    if profile_id and profile_id != "default":
        args += ["--profile", profile_id]
    args += list(extra)
    return args


def _hermes_env():
    env = dict(os.environ)
    env["HERMES_HOME"] = HERMES_HOME
    return env


def _parse_hermes_auth_list(text_out):
    providers = []
    current = None
    for raw in (text_out or "").splitlines():
        line = raw.rstrip()
        if not line:
            continue
        if not line.startswith(" ") and line.endswith(":"):
            current = {"provider": line[:-1], "credentials": []}
            providers.append(current)
        elif current and line.strip().startswith("#"):
            parts = line.strip().split()
            current["credentials"].append({
                "label": " ".join(parts[1:-2]) if len(parts) > 3 else line.strip(),
                "type": parts[-2] if len(parts) >= 2 else "",
                "source": parts[-1].replace("←", "") if parts else "",
                "raw": line.strip(),
            })
    return providers


def _get_hermes_profile_auth(profile_id):
    paths = []
    if profile_id and profile_id != "default":
        paths.append(os.path.join(HERMES_HOME, "profiles", profile_id, "auth.json"))
    paths.append(os.path.join(HERMES_HOME, "auth.json"))
    merged = {}
    for path in paths:
        try:
            with open(path, "r") as f:
                data = json.load(f)
        except Exception:
            continue
        for provider, state in (data.get("providers") or {}).items():
            merged.setdefault(provider, {"provider": provider, "credentials": []})
            if state:
                mode = state.get("auth_mode") or state.get("type") or "oauth"
                merged[provider]["credentials"].append({
                    "label": provider,
                    "type": mode,
                    "source": "auth.json",
                })
        for provider, entries in (data.get("credential_pool") or {}).items():
            if not entries:
                continue
            merged.setdefault(provider, {"provider": provider, "credentials": []})
            for entry in entries:
                merged[provider]["credentials"].append({
                    "label": entry.get("label") or entry.get("id") or provider,
                    "type": entry.get("auth_type") or "",
                    "source": entry.get("source") or "credential_pool",
                })
    return list(merged.values())


def _get_hermes_native_models():
    """Return Hermes profile/model/auth state using Hermes' native config layout."""
    profiles = []
    default_cfg = _load_yaml_file(os.path.join(HERMES_HOME, "config.yaml"))
    if default_cfg:
        profiles.append(("default", os.path.join(HERMES_HOME, "config.yaml")))
    profiles_dir = os.path.join(HERMES_HOME, "profiles")
    if os.path.isdir(profiles_dir):
        for name in sorted(os.listdir(profiles_dir)):
            cfg_path = os.path.join(profiles_dir, name, "config.yaml")
            if os.path.exists(cfg_path):
                profiles.append((name, cfg_path))

    provider_cache = {}
    cache_path = os.path.join(HERMES_HOME, "provider_models_cache.json")
    try:
        with open(cache_path, "r") as f:
            cache_data = json.load(f)
        for provider, entry in cache_data.items():
            provider_cache[provider] = entry.get("models", []) if isinstance(entry, dict) else []
    except Exception:
        pass

    result_profiles = []
    for profile_id, cfg_path in profiles:
        cfg = _load_yaml_file(cfg_path)
        model_cfg = cfg.get("model", {}) if isinstance(cfg, dict) else {}
        result_profiles.append({
            "id": profile_id,
            "configPath": cfg_path,
            "provider": model_cfg.get("provider") or "",
            "model": model_cfg.get("default") or model_cfg.get("model") or "",
            "baseUrl": model_cfg.get("base_url") or "",
            "auth": _get_hermes_profile_auth(profile_id),
            "authOk": True,
        })

    models = []
    for provider, names in provider_cache.items():
        for name in names:
            models.append({
                "id": f"{provider}/{name}",
                "provider": provider,
                "name": name,
                "source": "hermes",
                "available": True,
            })

    model_aliases = {}
    local_provider_map = {}
    for profile_id, cfg_path in profiles:
        cfg = _load_yaml_file(cfg_path)
        aliases = cfg.get("model_aliases", {}) if isinstance(cfg, dict) else {}
        if not isinstance(aliases, dict):
            continue
        for alias, entry in aliases.items():
            if not isinstance(entry, dict):
                continue
            provider = entry.get("provider") or "custom"
            model = entry.get("model") or alias
            base_url = entry.get("base_url") or ""
            model_aliases[alias] = {
                "alias": alias,
                "profile": profile_id,
                "provider": provider,
                "model": model,
                "baseUrl": base_url,
            }
            local_key = (profile_id, provider, base_url)
            local_provider_map.setdefault(local_key, {
                "id": f"{profile_id}:{provider}:{base_url}",
                "profile": profile_id,
                "provider": provider,
                "baseUrl": base_url,
                "models": [],
                "source": "hermes-model-aliases",
            })
            local_provider_map[local_key]["models"].append({
                "id": model,
                "name": model,
                "alias": alias,
            })
            mid = f"{provider}/{model}"
            if not any(m.get("id") == mid for m in models):
                models.append({
                    "id": mid,
                    "provider": provider,
                    "name": model,
                    "source": "hermes-alias",
                    "available": True,
                    "baseUrl": base_url,
                })

    return {
        "ok": bool(profiles),
        "profiles": result_profiles,
        "models": models,
        "providers": sorted(set(provider_cache.keys()) | {m.get("provider") for m in models if m.get("provider")}),
        "modelAliases": list(model_aliases.values()),
        "localProviders": [
            {**provider, "modelCount": len(provider.get("models", []))}
            for provider in sorted(local_provider_map.values(), key=lambda item: (item.get("profile", ""), item.get("provider", ""), item.get("baseUrl", "")))
        ],
        "nativeCommands": {
            "setup": "hermes model",
            "auth": "hermes auth list",
            "assign": "hermes config set model.provider <provider>; hermes config set model.default <model>",
        },
    }


def _get_native_model_state(openclaw_agent_id=None):
    return {
        "openclaw": _get_openclaw_native_models(openclaw_agent_id),
        "hermes": _get_hermes_native_models(),
        "codex": _get_codex_native_setup_state(),
        "claudeCode": _get_claude_code_native_setup_state(),
    }


def _get_codex_native_setup_state():
    cfg = VO_CONFIG.get("codex", {}) or {}
    home_path = cfg.get("homePath") or os.path.expanduser("~/.codex")
    return {
        "ok": True,
        "enabled": bool(cfg.get("enabled", True)),
        "binary": cfg.get("binary") or "",
        "homePath": home_path,
        "workspaceRoot": cfg.get("workspaceRoot") or "",
        "mainWorkspace": cfg.get("mainWorkspace") or "",
        "model": cfg.get("model") or "",
        "sandbox": cfg.get("sandbox") or "workspace-write",
        "approvalPolicy": cfg.get("approvalPolicy") or "never",
        "preferAppServer": bool(cfg.get("preferAppServer", True)),
        "includeMain": bool(cfg.get("includeMain", True)),
        "includeNativeAgents": bool(cfg.get("includeNativeAgents", True)),
        "registerNativeAgents": bool(cfg.get("registerNativeAgents", True)),
        "nativeAgentsDir": os.path.join(home_path, "agents") if home_path else "",
        "nativeCommands": {
            "login": "codex login",
            "appServer": "codex app-server --stdio",
            "exec": "codex exec",
            "agents": "$CODEX_HOME/agents/*.toml",
        },
    }


def _get_claude_code_native_setup_state():
    cfg = VO_CONFIG.get("claudeCode", {}) or {}
    home_path = cfg.get("homePath") or os.path.expanduser("~/.claude")
    return {
        "ok": True,
        "enabled": bool(cfg.get("enabled", True)),
        "binary": cfg.get("binary") or "",
        "homePath": home_path,
        "workspaceRoot": cfg.get("workspaceRoot") or "",
        "mainWorkspace": cfg.get("mainWorkspace") or "",
        "model": cfg.get("model") or "",
        "permissionMode": cfg.get("permissionMode") or "acceptEdits",
        "includeMain": bool(cfg.get("includeMain", True)),
        "includeNativeAgents": bool(cfg.get("includeNativeAgents", True)),
        "registerNativeAgents": bool(cfg.get("registerNativeAgents", True)),
        "nativeAgentsDir": os.path.join(home_path, "agents") if home_path else "",
        "nativeCommands": {
            "login": "claude auth login",
            "status": "claude auth status --json",
            "stream": "claude -p --output-format stream-json --include-partial-messages",
            "agents": "$CLAUDE_CONFIG_DIR/agents/*.md",
        },
    }


def _set_hermes_profile_model(profile_id, provider, model, base_url=""):
    profile_id = str(profile_id or "default")
    provider = str(provider or "").strip()
    model = str(model or "").strip()
    if not provider or not model:
        return {"ok": False, "error": "provider and model are required"}
    if re.search(r"[^a-zA-Z0-9_.:-]", provider):
        return {"ok": False, "error": "invalid provider id"}
    cfg_path = _hermes_profile_config_path(profile_id)
    if not os.path.exists(cfg_path):
        return {"ok": False, "error": f"Hermes profile config not found: {cfg_path}"}
    try:
        with open(cfg_path, "r") as f:
            lines = f.read().splitlines()
        output = []
        in_model = False
        seen_model = False
        wrote = {"provider": False, "default": False, "base_url": False}
        for line in lines:
            stripped = line.strip()
            if not line.startswith(" ") and stripped.endswith(":"):
                if in_model:
                    if not wrote["default"]:
                        output.append(f"  default: {model}")
                    if not wrote["provider"]:
                        output.append(f"  provider: {provider}")
                    if base_url and not wrote["base_url"]:
                        output.append(f"  base_url: {str(base_url).strip()}")
                in_model = stripped == "model:"
                seen_model = seen_model or in_model
                output.append(line)
                continue
            if in_model and line.startswith("  ") and ":" in line:
                key = stripped.split(":", 1)[0]
                if key == "default":
                    output.append(f"  default: {model}")
                    wrote["default"] = True
                    continue
                if key == "provider":
                    output.append(f"  provider: {provider}")
                    wrote["provider"] = True
                    continue
                if key == "base_url" and base_url:
                    output.append(f"  base_url: {str(base_url).strip()}")
                    wrote["base_url"] = True
                    continue
            output.append(line)
        if in_model:
            if not wrote["default"]:
                output.append(f"  default: {model}")
            if not wrote["provider"]:
                output.append(f"  provider: {provider}")
            if base_url and not wrote["base_url"]:
                output.append(f"  base_url: {str(base_url).strip()}")
        if not seen_model:
            output.extend(["model:", f"  default: {model}", f"  provider: {provider}"])
            if base_url:
                output.append(f"  base_url: {str(base_url).strip()}")
        with open(cfg_path, "w") as f:
            f.write("\n".join(output) + "\n")
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "profile": profile_id, "provider": provider, "model": model}


def _write_yaml_file(path, data):
    if not yaml:
        return False, "PyYAML is not available; cannot update Hermes YAML config"
    try:
        with open(path, "w") as f:
            yaml.safe_dump(data, f, sort_keys=False)
        return True, None
    except Exception as e:
        return False, str(e)


def _yaml_scalar(value):
    return json.dumps(str(value or ""))


def _read_hermes_aliases_text(lines):
    aliases = {}
    start = None
    end = None
    for i, line in enumerate(lines):
        if line.strip() == "model_aliases:" and not line.startswith(" "):
            start = i
            end = len(lines)
            for j in range(i + 1, len(lines)):
                nxt = lines[j]
                if nxt.strip() and not nxt.startswith(" ") and not nxt.lstrip().startswith("#"):
                    end = j
                    break
            break
    if start is None:
        return aliases, None, None
    current = None
    for line in lines[start + 1:end]:
        if line.startswith("  ") and not line.startswith("    ") and line.strip().endswith(":"):
            current = line.strip()[:-1]
            aliases.setdefault(current, {})
            continue
        if current and line.startswith("    ") and ":" in line:
            key, value = line.strip().split(":", 1)
            aliases[current][key.strip()] = value.strip().strip("\"'")
    return aliases, start, end


def _write_hermes_aliases_text(path, aliases):
    try:
        with open(path, "r") as f:
            lines = f.read().splitlines()
    except Exception as e:
        return False, str(e)
    _, start, end = _read_hermes_aliases_text(lines)
    block = []
    if aliases:
        block.append("model_aliases:")
        for alias in sorted(aliases):
            entry = aliases[alias] or {}
            block.append(f"  {alias}:")
            block.append(f"    model: {_yaml_scalar(entry.get('model') or alias)}")
            block.append(f"    provider: {_yaml_scalar(entry.get('provider') or 'custom')}")
            if entry.get("base_url"):
                block.append(f"    base_url: {_yaml_scalar(entry.get('base_url'))}")
    if start is None:
        new_lines = lines + ([""] if lines and lines[-1].strip() else []) + block
    else:
        new_lines = lines[:start] + block + lines[end:]
    try:
        with open(path, "w") as f:
            f.write("\n".join(new_lines).rstrip() + "\n")
        return True, None
    except Exception as e:
        return False, str(e)


def _update_hermes_aliases_text(path, updater):
    try:
        with open(path, "r") as f:
            lines = f.read().splitlines()
    except Exception as e:
        return None, False, str(e)
    aliases, _, _ = _read_hermes_aliases_text(lines)
    aliases = updater(aliases)
    ok, err = _write_hermes_aliases_text(path, aliases)
    return aliases, ok, err


def _save_hermes_api_key(provider, api_key, label=""):
    provider = _safe_provider_id(provider)
    api_key = str(api_key or "").strip()
    label = str(label or "Virtual Office").strip()[:80]
    if not provider or not api_key:
        return {"ok": False, "error": "provider and API key are required"}
    if not HERMES_BIN:
        return {"ok": False, "error": "Hermes CLI is not configured"}
    args = [HERMES_BIN, "auth", "add", provider, "--type", "api-key", "--label", label, "--api-key", api_key]
    result = _run_text_command(args, timeout=30, env=_hermes_env())
    if not result.get("ok"):
        return {"ok": False, "error": result.get("text") or "Hermes auth add failed"}
    return {"ok": True, "provider": provider, "label": label, "maskedKey": _mask_secret(api_key)}


def _delete_hermes_auth(provider, target):
    provider = _safe_provider_id(provider)
    target = str(target or "").strip()
    if not provider or not target:
        return {"ok": False, "error": "provider and credential label/id/index are required"}
    if not HERMES_BIN:
        return {"ok": False, "error": "Hermes CLI is not configured"}
    result = _run_text_command([HERMES_BIN, "auth", "remove", provider, target], timeout=30, env=_hermes_env())
    if not result.get("ok"):
        return {"ok": False, "error": result.get("text") or "Hermes auth remove failed"}
    return {"ok": True, "provider": provider, "target": target}


def _save_hermes_custom_provider(profile_id, provider, base_url, models):
    profile_id = str(profile_id or "default").strip() or "default"
    provider = _safe_provider_id(provider) or "custom"
    base_url = str(base_url or "").strip()
    entries = _parse_model_entries(models)
    if not base_url:
        return {"ok": False, "error": "base URL is required"}
    if not entries:
        return {"ok": False, "error": "at least one model is required"}
    cfg_path = _hermes_profile_config_path(profile_id)
    if not os.path.exists(cfg_path):
        return {"ok": False, "error": f"Hermes profile config not found: {cfg_path}"}
    def update_aliases(aliases):
        for alias, entry in list(aliases.items()):
            if isinstance(entry, dict) and _safe_provider_id(entry.get("provider")) == provider:
                aliases.pop(alias, None)
        for entry in entries:
            alias = re.sub(r"[^a-zA-Z0-9_.:-]+", "-", entry["id"]).strip("-")[:100]
            aliases[alias] = {
                "model": entry["id"],
                "provider": provider,
                "base_url": base_url,
            }
        return aliases
    if yaml:
        cfg = _load_yaml_file(cfg_path)
        if not isinstance(cfg, dict):
            cfg = {}
        aliases = cfg.setdefault("model_aliases", {})
        if not isinstance(aliases, dict):
            aliases = {}
            cfg["model_aliases"] = aliases
        update_aliases(aliases)
        ok, err = _write_yaml_file(cfg_path, cfg)
        if not ok:
            return {"ok": False, "error": err}
    else:
        _, ok, err = _update_hermes_aliases_text(cfg_path, update_aliases)
        if not ok:
            return {"ok": False, "error": err}
    cache_path = os.path.join(HERMES_HOME, "provider_models_cache.json")
    try:
        with open(cache_path, "r") as f:
            cache_data = json.load(f)
    except Exception:
        cache_data = {}
    cache_data[provider] = {"models": [e["id"] for e in entries], "ts": int(time.time())}
    try:
        with open(cache_path, "w") as f:
            json.dump(cache_data, f, indent=2)
    except Exception:
        pass
    return {"ok": True, "profile": profile_id, "provider": provider, "modelCount": len(entries)}


def _delete_hermes_custom_provider(profile_id, provider):
    profile_id = str(profile_id or "default").strip() or "default"
    provider = _safe_provider_id(provider)
    if not provider:
        return {"ok": False, "error": "provider is required"}
    cfg_path = _hermes_profile_config_path(profile_id)
    if not os.path.exists(cfg_path):
        return {"ok": False, "error": f"Hermes profile config not found: {cfg_path}"}
    removed = []
    def remove_aliases(aliases):
        for alias, entry in list(aliases.items()):
            if isinstance(entry, dict) and _safe_provider_id(entry.get("provider")) == provider:
                removed.append(alias)
                aliases.pop(alias, None)
        return aliases
    if yaml:
        cfg = _load_yaml_file(cfg_path)
        if not isinstance(cfg, dict):
            cfg = {}
        aliases = cfg.get("model_aliases", {})
        if isinstance(aliases, dict):
            remove_aliases(aliases)
        ok, err = _write_yaml_file(cfg_path, cfg)
        if not ok:
            return {"ok": False, "error": err}
    else:
        _, ok, err = _update_hermes_aliases_text(cfg_path, remove_aliases)
        if not ok:
            return {"ok": False, "error": err}
    cache_path = os.path.join(HERMES_HOME, "provider_models_cache.json")
    try:
        with open(cache_path, "r") as f:
            cache_data = json.load(f)
        cache_data.pop(provider, None)
        with open(cache_path, "w") as f:
            json.dump(cache_data, f, indent=2)
    except Exception:
        pass
    return {"ok": True, "profile": profile_id, "provider": provider, "removedAliases": removed}


def _save_openclaw_api_key(provider, api_key, profile_id="", agent_id=None, sync_all=False):
    provider = _safe_provider_id(provider)
    agent_id = _safe_openclaw_agent_id(agent_id)
    api_key = str(api_key or "").strip()
    profile_id = str(profile_id or f"{provider}:manual").strip()
    if not provider or not api_key:
        return {"ok": False, "error": "provider and API key are required"}
    if sync_all:
        saved = _save_openclaw_api_key(provider, api_key, profile_id, agent_id="main", sync_all=False)
        if not saved.get("ok"):
            return saved
        sync_result = _sync_openclaw_static_auth_from_main(provider=provider, profile_id=profile_id)
        return {
            **saved,
            "agent": "main",
            "scope": "global",
            "sync": sync_result,
            "ok": bool(saved.get("ok") and sync_result.get("ok")),
        }
    openclaw_bin = _openclaw_binary() or OPENCLAW_BIN
    if openclaw_bin:
        result = _run_json_command(
            [openclaw_bin, "models", "auth", "paste-api-key", "--agent", agent_id, "--provider", provider, "--profile-id", profile_id],
            input_text=api_key + "\n",
            timeout=30,
        )
        if result.get("ok"):
            _mirror_openclaw_config_auth_profile(provider, profile_id)
            _signal_openclaw_gateway(restart=False)
            return {"ok": True, "provider": provider, "profileId": profile_id, "agent": agent_id, "maskedKey": _mask_secret(api_key)}
    return _save_openclaw_api_key_direct(provider, profile_id, api_key, agent_id=agent_id)


def _delete_openclaw_auth(provider, profile_id="", agent_id=None, sync_all=False):
    provider = _safe_provider_id(provider)
    agent_id = _safe_openclaw_agent_id(agent_id)
    profile_id = str(profile_id or "").strip()
    if not provider and not profile_id:
        return {"ok": False, "error": "provider or profileId is required"}
    if sync_all:
        results = []
        deleted = set()
        for target in _openclaw_agent_ids():
            result = _delete_openclaw_auth_direct(provider, profile_id, agent_id=target)
            results.append(result)
            deleted.update(result.get("deletedProfiles") or [])
        _signal_openclaw_gateway(restart=False)
        return {
            "ok": all(item.get("ok") for item in results),
            "provider": provider,
            "profileId": profile_id,
            "scope": "global",
            "deletedProfiles": sorted(deleted),
            "agents": results,
            "source": "global-auth-store",
        }
    return _delete_openclaw_auth_direct(provider, profile_id, agent_id=agent_id)

# ─── DYNAMIC AGENT DISCOVERY ─────────────────────────────────
from discovery import discover_all_agents, discover_hermes_agents, get_agent_workspace_dir, get_agent_session_id
from providers.codex import CodexProvider
from providers.claude_code import ClaudeCodeProvider
from providers.opencode import OpenCodeProvider
from providers.antigravity import AntigravityProvider
from providers.hermes import HermesApiClient, HermesDesktopBackendClient, HermesProvider, discover_desktop_backend
from license import get_license_status, activate_license, deactivate_license, check_feature, get_agent_limit
from project_store import MarkdownProjectStore

PROJECT_STORE = MarkdownProjectStore(STATUS_DIR)


AGENT_PLATFORM_COMM_SKILL_NAME = "AgentPlatform-to-AgentPlatform_Communications"


def _safe_agent_workspace_key(agent_key):
    return re.sub(r"[^a-zA-Z0-9_.:-]+", "-", str(agent_key or "").strip())[:120]


def _load_agent_workspaces():
    try:
        with open(AGENT_WORKSPACES_FILE, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_agent_workspaces(data):
    os.makedirs(os.path.dirname(AGENT_WORKSPACES_FILE), exist_ok=True)
    with open(AGENT_WORKSPACES_FILE, "w") as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(AGENT_WORKSPACES_FILE, 0o666)
    except OSError:
        pass


def _find_agent_record(agent_key):
    needle = str(agent_key or "")
    for agent in get_roster():
        values = (
            agent.get("id"),
            agent.get("statusKey"),
            agent.get("providerAgentId"),
            agent.get("profile"),
        )
        if needle in values:
            return agent
    return None


_WORKSPACE_TEXT_EXTS = {
    ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".ini", ".env",
    ".py", ".js", ".css", ".html", ".sh", ".csv", ".log",
}
_WORKSPACE_FILE_LIMIT = 256 * 1024


def _agent_workspace_abs_path(agent_key, agent):
    if agent.get("providerKind") == "hermes":
        return None
    if agent.get("providerKind") in {"codex", "claude-code"}:
        ws = agent.get("workspace") or agent.get("home") or AGENT_WORKSPACES.get(agent_key) or AGENT_WORKSPACES.get(agent.get("statusKey"))
        return os.path.abspath(ws) if ws else None
    ws_dir = AGENT_WORKSPACES.get(agent_key) or AGENT_WORKSPACES.get(agent.get("statusKey"))
    if not ws_dir:
        return None
    return os.path.abspath(os.path.join(WORKSPACE_BASE, ws_dir))


def _safe_workspace_relpath(raw_path):
    rel = str(raw_path or "").replace("\\", "/").strip()
    rel = rel.lstrip("/")
    if not rel or rel in (".", "..") or "\x00" in rel:
        return ""
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return ""
    return "/".join(parts)


def _resolve_workspace_file(agent_key, agent, raw_path, allow_new=False):
    root = _agent_workspace_abs_path(agent_key, agent)
    if not root:
        return None, "", "Workspace files are not available for this platform"
    rel = _safe_workspace_relpath(raw_path)
    if not rel:
        return None, "", "File path required"
    ext = os.path.splitext(rel)[1].lower()
    if ext not in _WORKSPACE_TEXT_EXTS:
        return None, "", "Only text workspace files can be edited"
    full = os.path.abspath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        return None, "", "File must stay inside the agent workspace"
    if not allow_new and not os.path.isfile(full):
        return None, "", "File not found"
    return full, rel, ""


def _read_workspace_text_file(agent_key, agent, relpath):
    full, rel, err = _resolve_workspace_file(agent_key, agent, relpath)
    if err:
        return {"error": err, "_status": 400}
    size = os.path.getsize(full)
    if size > _WORKSPACE_FILE_LIMIT:
        return {"error": "File is too large for dashboard editing", "_status": 413}
    with open(full, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    return {
        "ok": True,
        "file": {
            "name": os.path.basename(rel),
            "path": rel,
            "kind": "workspace",
            "size": size,
            "modified": datetime.fromtimestamp(os.path.getmtime(full), timezone.utc).isoformat(),
            "content": content,
        },
    }


def _save_workspace_text_file(agent_key, agent, relpath, content, create=False):
    full, rel, err = _resolve_workspace_file(agent_key, agent, relpath, allow_new=create)
    if err:
        return {"error": err, "_status": 400}
    text = str(content or "")
    if len(text.encode("utf-8")) > _WORKSPACE_FILE_LIMIT:
        return {"error": "File content is too large", "_status": 413}
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(text)
    return {"ok": True, "saved": rel}


def _delete_workspace_text_file(agent_key, agent, relpath):
    full, rel, err = _resolve_workspace_file(agent_key, agent, relpath)
    if err:
        return {"error": err, "_status": 400}
    os.remove(full)
    return {"ok": True, "deleted": rel}


def _workspace_file_summaries(agent_key, agent):
    provider_kind = agent.get("providerKind", "openclaw")
    if provider_kind == "hermes":
        profile = agent.get("profile") or agent.get("providerAgentId") or "default"
        hist_path = _hermes_history_path(profile)
        files = []
        if os.path.exists(hist_path):
            files.append({
                "name": f"Hermes chat history ({profile})",
                "kind": "history",
                "size": os.path.getsize(hist_path),
                "modified": datetime.fromtimestamp(os.path.getmtime(hist_path), timezone.utc).isoformat(),
            })
        return files

    ws_path = _agent_workspace_abs_path(agent_key, agent)
    if not ws_path:
        return []
    files = []
    skip_dirs = {".git", "__pycache__", "node_modules", ".venv", "venv"}
    preferred = {"AGENTS.md": -90, "IDENTITY.md": -89, "SOUL.md": -88, "USER.md": -87, "HEARTBEAT.md": -86, "MEMORY.md": -85, "TOOLS.md": -84}
    for root, dirs, names in os.walk(ws_path):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".cache")]
        depth = os.path.relpath(root, ws_path).count(os.sep)
        if depth > 3:
            dirs[:] = []
        for fname in names:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in _WORKSPACE_TEXT_EXTS:
                continue
            fpath = os.path.join(root, fname)
            try:
                size = os.path.getsize(fpath)
                rel = os.path.relpath(fpath, ws_path).replace(os.sep, "/")
                if size > _WORKSPACE_FILE_LIMIT:
                    kind = "large-text"
                elif rel.startswith("memory/"):
                    kind = "daily-note"
                elif rel.startswith("notes/"):
                    kind = "note-file"
                else:
                    kind = "workspace"
                files.append({
                    "name": fname,
                    "path": rel,
                    "kind": kind,
                    "size": size,
                    "modified": datetime.fromtimestamp(os.path.getmtime(fpath), timezone.utc).isoformat(),
                    "_rank": preferred.get(rel, 0),
                })
            except OSError:
                pass
    files.sort(key=lambda f: (f.pop("_rank", 0), f.get("path", "")))
    return files[:120]


def _agent_skill_summaries(agent_key, agent):
    if agent.get("providerKind") != "openclaw" and agent.get("providerKind"):
        return []
    result = _handle_skill_list(agent_key)
    return [
        {
            "name": s.get("name", ""),
            "type": s.get("type", ""),
            "description": s.get("description", ""),
            "content": s.get("content", ""),
        }
        for s in result.get("skills", [])[:40]
    ]


def _agent_project_tasks(agent):
    aliases = {
        str(agent.get("id") or ""),
        str(agent.get("statusKey") or ""),
        str(agent.get("providerAgentId") or ""),
    }
    aliases.discard("")
    data = _load_projects()
    items = []
    for project in data.get("projects", []):
        columns = {c.get("id"): c.get("title", "") for c in project.get("columns", [])}
        for task in project.get("tasks", []):
            if str(task.get("assignee") or "") not in aliases:
                continue
            items.append({
                "projectId": project.get("id", ""),
                "projectTitle": project.get("title", ""),
                "taskId": task.get("id", ""),
                "title": task.get("title", ""),
                "priority": task.get("priority", "medium"),
                "column": columns.get(task.get("columnId"), ""),
                "completed": bool(task.get("completedAt")),
                "updatedAt": task.get("updatedAt") or project.get("updatedAt", ""),
            })
    items.sort(key=lambda x: x.get("updatedAt") or "", reverse=True)
    return items[:25]


def _agent_recent_activity(agent_key, agent):
    if agent.get("providerKind") == "hermes":
        profile = agent.get("profile") or agent.get("providerAgentId") or "default"
        messages = _load_hermes_history(profile)[-80:]
    elif agent.get("providerKind") == "codex":
        profile = agent.get("profile") or agent.get("providerAgentId") or "default"
        messages = _load_codex_history(profile)[-80:]
    elif agent.get("providerKind") == "claude-code":
        profile = agent.get("profile") or agent.get("providerAgentId") or "main"
        messages = _load_claude_code_history(profile)[-80:]
    elif agent.get("providerKind") == "opencode":
        profile = agent.get("profile") or agent.get("providerAgentId") or "main"
        messages = _load_opencode_history(profile)[-80:]
    elif agent.get("providerKind") == "antigravity":
        profile = agent.get("profile") or agent.get("providerAgentId") or "main"
        messages = _load_antigravity_history(profile)[-80:]
    else:
        messages = get_agent_messages(agent_key, max_messages=80)
    return messages[-80:] if isinstance(messages, list) else []


def _agent_score_info(agent_key):
    try:
        data = _load_scores()
        return data.get("agents", {}).get(agent_key, {"score": 0, "completed": 0, "streak": 0, "history": []})
    except Exception:
        return {"score": 0, "completed": 0, "streak": 0, "history": []}


def _office_config_agent_override(agent_key):
    path = os.path.join(STATUS_DIR, "office-config.json")
    try:
        with open(path, "r") as f:
            cfg = json.load(f)
    except Exception:
        return {}
    for item in cfg.get("agents", []) or []:
        if agent_key in (item.get("id"), item.get("statusKey")):
            return item
    return {}


def _update_office_config_agent(agent_key, patch):
    path = os.path.join(STATUS_DIR, "office-config.json")
    try:
        with open(path, "r") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    agents = cfg.setdefault("agents", [])
    item = None
    for candidate in agents:
        if agent_key in (candidate.get("id"), candidate.get("statusKey")):
            item = candidate
            break
    if item is None:
        item = {"id": agent_key, "statusKey": agent_key}
        agents.append(item)
    for key, value in patch.items():
        if value is not None:
            item[key] = value
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass
    return item


def _get_agent_workspace_payload(agent_key):
    refresh_agent_maps()
    agent = _find_agent_record(agent_key)
    if not agent:
        return {"error": f"Unknown agent: {agent_key}", "_status": 404}

    key = agent.get("statusKey") or agent.get("id") or agent_key
    store_key = _safe_agent_workspace_key(key)
    store = _load_agent_workspaces()
    workspace = store.setdefault(store_key, {})
    workspace.setdefault("bulletin", [])
    workspace.setdefault("tasks", [])
    workspace.setdefault("notes", [])
    workspace.setdefault("settings", {})
    workspace.setdefault("updatedAt", "")

    presence = _get_normalized_presence_state().get(key, {"state": "idle", "task": "", "updated": 0})
    override = _office_config_agent_override(key)
    payload_agent = {
        "id": agent.get("id", key),
        "statusKey": key,
        "providerKind": agent.get("providerKind", "openclaw"),
        "providerType": agent.get("providerType", "runtime"),
        "providerAgentId": agent.get("providerAgentId", agent.get("id", key)),
        "profile": agent.get("profile", ""),
        "name": override.get("name") or agent.get("name", key),
        "displayName": override.get("displayName") or override.get("name") or agent.get("name", key),
        "emoji": override.get("emoji") or agent.get("emoji", "🤖"),
        "role": override.get("role") or agent.get("role", ""),
        "branch": override.get("branch") or agent.get("branch", ""),
        "color": override.get("color", ""),
        "model": agent.get("model", ""),
        "provider": agent.get("provider", ""),
        "lastActiveAt": agent.get("lastActiveAt", 0),
    }
    heartbeat = ""
    provider_kind = agent.get("providerKind", "openclaw")
    if provider_kind == "openclaw":
        hb = _resolve_workspace_file(key, agent, "HEARTBEAT.md", allow_new=True)[0]
        if hb and os.path.isfile(hb):
            try:
                with open(hb, "r", encoding="utf-8", errors="replace") as f:
                    heartbeat = f.read()
            except OSError:
                heartbeat = ""
    return {
        "ok": True,
        "agent": payload_agent,
        "presence": presence,
        "workspace": workspace,
        "files": _workspace_file_summaries(key, agent),
        "skills": _agent_skill_summaries(key, agent),
        "skillLibrary": _handle_skills_library_list().get("skills", []),
        "projectTasks": _agent_project_tasks(agent),
        "activity": _agent_recent_activity(key, agent),
        "score": _agent_score_info(key),
        "settings": {
            "heartbeatContent": heartbeat,
            "heartbeatApplicable": provider_kind == "openclaw",
            "cronApplicable": provider_kind == "openclaw",
            "filesApplicable": provider_kind != "hermes",
            "agentSkillsApplicable": provider_kind == "openclaw",
            "skillLibraryApplicable": True,
            "modelEditable": provider_kind == "openclaw",
        },
    }


def _handle_agent_workspace_update(agent_key, body):
    payload = _get_agent_workspace_payload(agent_key)
    if not payload.get("ok"):
        return payload
    key = payload["agent"]["statusKey"]
    store_key = _safe_agent_workspace_key(key)
    store = _load_agent_workspaces()
    workspace = store.setdefault(store_key, {"bulletin": [], "tasks": [], "notes": [], "settings": {}})
    workspace.setdefault("bulletin", [])
    workspace.setdefault("tasks", [])
    workspace.setdefault("notes", [])
    workspace.setdefault("settings", {})
    action = (body.get("action") or "").strip()
    now = datetime.now(timezone.utc).isoformat()
    actor = (body.get("actor") or "user").strip()[:80] or "user"
    agent = payload["agent"]

    if action == "addBulletin":
        text = (body.get("text") or "").strip()
        if not text:
            return {"error": "Bulletin text required", "_status": 400}
        workspace.setdefault("bulletin", []).insert(0, {
            "id": str(uuid.uuid4()),
            "text": text[:5000],
            "createdAt": now,
            "createdBy": actor,
            "pinned": bool(body.get("pinned", False)),
        })
        workspace["bulletin"] = workspace["bulletin"][:100]
    elif action == "deleteBulletin":
        item_id = str(body.get("id") or "")
        workspace["bulletin"] = [x for x in workspace.get("bulletin", []) if x.get("id") != item_id]
    elif action == "updateBulletin":
        item_id = str(body.get("id") or "")
        text = (body.get("text") or "").strip()
        for note in workspace.get("bulletin", []):
            if note.get("id") == item_id:
                note["text"] = text[:5000]
                note["updatedAt"] = now
                note["pinned"] = bool(body.get("pinned", note.get("pinned", False)))
                break
    elif action == "addTask":
        text = (body.get("text") or "").strip()
        if not text:
            return {"error": "Task text required", "_status": 400}
        workspace.setdefault("tasks", []).append({
            "id": str(uuid.uuid4()),
            "text": text[:1000],
            "detail": (body.get("detail") or "").strip()[:5000],
            "done": False,
            "status": "queued",
            "priority": (body.get("priority") or "normal").strip()[:40],
            "createdAt": now,
            "createdBy": actor,
            "due": (body.get("due") or "").strip()[:80],
        })
        workspace["tasks"] = workspace["tasks"][:100]
        if not workspace.get("activeTaskId") and workspace.get("settings", {}).get("taskMode") == "single":
            workspace["activeTaskId"] = workspace["tasks"][-1]["id"]
            workspace["tasks"][-1]["status"] = "active"
    elif action == "updateTask":
        item_id = str(body.get("id") or "")
        for task in workspace.get("tasks", []):
            if task.get("id") == item_id:
                task["text"] = (body.get("text") or task.get("text") or "").strip()[:1000]
                task["detail"] = (body.get("detail") or task.get("detail") or "").strip()[:5000]
                task["due"] = (body.get("due") or "").strip()[:80]
                task["priority"] = (body.get("priority") or task.get("priority") or "normal").strip()[:40]
                task["updatedAt"] = now
                break
    elif action == "toggleTask":
        item_id = str(body.get("id") or "")
        for task in workspace.get("tasks", []):
            if task.get("id") == item_id:
                task["done"] = not bool(task.get("done"))
                task["status"] = "done" if task["done"] else "queued"
                task["updatedAt"] = now
                break
    elif action == "startTask":
        item_id = str(body.get("id") or "")
        workspace["activeTaskId"] = item_id
        for task in workspace.get("tasks", []):
            if task.get("done"):
                task["status"] = "done"
            elif task.get("id") == item_id:
                task["status"] = "active"
                task["startedAt"] = now
            elif task.get("status") == "active":
                task["status"] = "queued"
    elif action == "completeTask":
        item_id = str(body.get("id") or workspace.get("activeTaskId") or "")
        for task in workspace.get("tasks", []):
            if task.get("id") == item_id:
                task["done"] = True
                task["status"] = "done"
                task["completedAt"] = now
                task["updatedAt"] = now
                break
        if workspace.get("activeTaskId") == item_id:
            workspace["activeTaskId"] = ""
        if workspace.get("settings", {}).get("taskMode") == "auto":
            for task in workspace.get("tasks", []):
                if not task.get("done"):
                    workspace["activeTaskId"] = task.get("id")
                    task["status"] = "active"
                    task["startedAt"] = now
                    break
    elif action == "deleteTask":
        item_id = str(body.get("id") or "")
        workspace["tasks"] = [x for x in workspace.get("tasks", []) if x.get("id") != item_id]
        if workspace.get("activeTaskId") == item_id:
            workspace["activeTaskId"] = ""
    elif action == "setTaskMode":
        mode = (body.get("mode") or "manual").strip()
        if mode not in ("manual", "single", "auto"):
            return {"error": "Invalid task mode", "_status": 400}
        workspace.setdefault("settings", {})["taskMode"] = mode
    elif action == "addNote":
        title = (body.get("title") or "Untitled note").strip()[:160]
        workspace.setdefault("notes", []).insert(0, {
            "id": str(uuid.uuid4()),
            "title": title or "Untitled note",
            "content": str(body.get("content") or "")[:50000],
            "folder": (body.get("folder") or "General").strip()[:120] or "General",
            "kind": (body.get("kind") or "note").strip()[:40],
            "tags": [str(x).strip()[:40] for x in body.get("tags", []) if str(x).strip()][:12],
            "createdAt": now,
            "updatedAt": now,
            "createdBy": actor,
        })
        workspace["notes"] = workspace["notes"][:300]
    elif action == "updateNote":
        item_id = str(body.get("id") or "")
        for note in workspace.get("notes", []):
            if note.get("id") == item_id:
                note["title"] = (body.get("title") or note.get("title") or "Untitled note").strip()[:160]
                note["content"] = str(body.get("content") or "")[:50000]
                note["folder"] = (body.get("folder") or "General").strip()[:120] or "General"
                note["kind"] = (body.get("kind") or note.get("kind") or "note").strip()[:40]
                note["tags"] = [str(x).strip()[:40] for x in body.get("tags", []) if str(x).strip()][:12]
                note["updatedAt"] = now
                break
    elif action == "deleteNote":
        item_id = str(body.get("id") or "")
        workspace["notes"] = [x for x in workspace.get("notes", []) if x.get("id") != item_id]
    elif action == "readFile":
        return _read_workspace_text_file(key, _find_agent_record(key), body.get("path") or "")
    elif action == "saveFile":
        result = _save_workspace_text_file(key, _find_agent_record(key), body.get("path") or "", body.get("content") or "", create=False)
        if not result.get("ok"):
            return result
    elif action == "createFile":
        result = _save_workspace_text_file(key, _find_agent_record(key), body.get("path") or "", body.get("content") or "", create=True)
        if not result.get("ok"):
            return result
    elif action == "deleteFile":
        result = _delete_workspace_text_file(key, _find_agent_record(key), body.get("path") or "")
        if not result.get("ok"):
            return result
    elif action == "saveAgentSkill":
        if payload["agent"].get("providerKind") == "hermes":
            return {"error": "Hermes skills are not edited through OpenClaw workspace skills", "_status": 400}
        name = (body.get("name") or "").strip()
        content = str(body.get("content") or "")
        if not content:
            content = f"---\nname: {name or 'new-skill'}\ndescription: \"Agent workflow skill.\"\n---\n\n# {name or 'New Skill'}\n\nUse this skill when...\n"
        result = _handle_skill_write(key, name, {"name": name, "content": content})
        if not result.get("ok"):
            return result
    elif action == "deleteAgentSkill":
        if payload["agent"].get("providerKind") == "hermes":
            return {"error": "Hermes skills are not edited through OpenClaw workspace skills", "_status": 400}
        result = _handle_skill_delete(key, (body.get("name") or "").strip())
        if not result.get("ok"):
            return result
    elif action == "saveLibrarySkill":
        content = str(body.get("content") or "")
        name = (body.get("name") or "").strip()
        if not content:
            content = f"---\nname: {name or 'new-library-skill'}\ndescription: \"Reusable Virtual Office skill.\"\n---\n\n# {name or 'New Library Skill'}\n\nUse this skill when...\n"
        result = _handle_skills_library_create({"name": name, "content": content})
        if not result.get("ok"):
            return result
    elif action == "applyLibrarySkill":
        if payload["agent"].get("providerKind") == "hermes":
            return {"error": "Hermes skills are not edited through OpenClaw workspace skills", "_status": 400}
        result = _handle_skills_library_apply({
            "skill": (body.get("name") or "").strip(),
            "agentId": key,
            "overwrite": bool(body.get("overwrite", True)),
        })
        if not result.get("ok") and not result.get("exists"):
            return result
    elif action == "saveAgentSkillToLibrary":
        if payload["agent"].get("providerKind") == "hermes":
            return {"error": "Hermes skills are not edited through OpenClaw workspace skills", "_status": 400}
        result = _handle_skills_library_save_from_agent({
            "skill": (body.get("name") or "").strip(),
            "agentId": key,
            "overwrite": bool(body.get("overwrite", False)),
        })
        if not result.get("ok"):
            return result
    elif action == "updateSettings":
        settings = workspace.setdefault("settings", {})
        for field in ("taskMode", "heartbeatMinutes", "cronEnabled", "displayName", "branch", "leaderboardPoints"):
            if field in body:
                settings[field] = body.get(field)
        if "leaderboardPoints" in body:
            try:
                scores = _load_scores()
                score_entry = scores.setdefault("agents", {}).setdefault(key, {"score": 0, "completed": 0, "streak": 0, "history": []})
                score_entry["score"] = int(body.get("leaderboardPoints") or 0)
                _save_scores(scores)
            except Exception:
                pass
        if "heartbeatContent" in body:
            if payload["agent"].get("providerKind") == "hermes":
                return {"error": "Heartbeats are OpenClaw-only for now; Hermes agents do not use HEARTBEAT.md", "_status": 400}
            result = _save_workspace_text_file(key, _find_agent_record(key), "HEARTBEAT.md", body.get("heartbeatContent") or "", create=True)
            if not result.get("ok"):
                return result
        patch = {}
        for field in ("name", "displayName", "role", "branch", "emoji", "color"):
            if field in body:
                patch[field] = str(body.get(field) or "").strip()
        if patch:
            _update_office_config_agent(key, patch)
    else:
        return {"error": f"Unknown action: {action}", "_status": 400}

    workspace["updatedAt"] = now
    store[store_key] = workspace
    _save_agent_workspaces(store)
    return _get_agent_workspace_payload(key)


def _agent_platform_comm_skill_content():
    office_url = f"http://127.0.0.1:{PORT}"
    return '''---
name: AgentPlatform-to-AgentPlatform_Communications
description: "Talk to agents on OpenClaw, Hermes, or other Virtual Office-connected platforms through the office communication layer."
---

# AgentPlatform-to-AgentPlatform Communications

Use this when you need to send a message, question, handoff, or task note to another agent in My Virtual Office, including agents from other platforms.

## Rule

Do **not** bypass the office with a direct CLI/private channel when the conversation should be visible to the office. Send through the Virtual Office communication endpoint so the interaction is logged for later chat bubbles, review, and cross-platform history.

## Endpoint

Default local endpoint:

```bash
POST {office_url}/api/agent-platform-communications/send
```

If Virtual Office runs elsewhere, use that office base URL.

## Message format

```json
{
  "fromAgentId": "<your office agent id>",
  "toAgentId": "<target office agent id>",
  "message": "<clear message to the target agent>",
  "conversationId": "<optional stable thread id>",
  "metadata": {"topic": "optional"}
}
```

Office agent IDs look like:

- `main`, `dev-cody`, `pq-m-moe` for OpenClaw agents
- `hermes-default` or `hermes-<profile>` for Hermes agents

## Curl example

```bash
curl -sS -X POST {office_url}/api/agent-platform-communications/send \
  -H 'Content-Type: application/json' \
  -d '{
    "fromAgentId":"main",
    "toAgentId":"hermes-default",
    "message":"Hi Hermes, can you review this idea and reply with your take?"
  }'
```

## Response

The response contains the target agent reply and office log IDs:

```json
{
  "ok": true,
  "conversationId": "...",
  "messageId": "...",
  "replyMessageId": "...",
  "reply": "..."
}
```

## Safety

- Keep private data minimal.
- Do not request config, credential, network, or infrastructure changes unless the office owner explicitly approved them.
- Use a clear `conversationId` when continuing the same topic.
- If the endpoint fails, report the error instead of silently using an offscreen private channel.
'''.replace("{office_url}", office_url)


def _vo_presence_skill_content():
    office_url = f"http://127.0.0.1:{PORT}"
    return '''---
name: VirtualOffice-Presence-and-Status
description: "Update and inspect Virtual Office presence states such as working, idle, break, and meeting."
---

# VirtualOffice Presence and Status

Use this to make the office show what you are doing.

## Set working

```bash
curl -sS -X POST {office_url}/api/presence/YOUR_AGENT_ID \
  -H 'Content-Type: application/json' \
  -d '{"state":"working","task":"short task description"}'
```

## Set idle

```bash
curl -sS -X POST {office_url}/api/presence/YOUR_AGENT_ID \
  -H 'Content-Type: application/json' \
  -d '{"state":"idle"}'
```

## Read presence

```bash
curl -sS {office_url}/api/presence
curl -sS {office_url}/status
```

## Rules

- Set `working` before visible work.
- Keep task text short.
- Set `idle` when done.
- Do not fake another agent's status unless you are the office broker handling that agent's task.
'''.replace("{office_url}", office_url)


def _vo_browser_skill_content():
    office_url = f"http://127.0.0.1:{PORT}"
    return '''---
name: VirtualOffice-Browser-Control
description: "Use the Virtual Office browser panel/status surface safely instead of direct Kasm/CDP credentials."
---

# VirtualOffice Browser Control

Use this when you need the shared Virtual Office browser/Kasm panel.

## Current safe read endpoints

```bash
curl -sS {office_url}/browser-status
curl -sS {office_url}/browser-tabs
curl -sS {office_url}/browser-controller
```

## Rules

- Treat the Virtual Office browser as a shared visible resource.
- Do not use raw Kasm/CDP credentials directly unless the office/browser adapter explicitly gives you a safe action endpoint.
- Announce/request browser use through presence or AgentPlatform communications so the office owner can see who is using it.
- If another agent/user controls the browser, wait or ask instead of fighting for control.

## Current limitation

This skill documents the shared browser surface. A provider-neutral browser action endpoint is planned next; until then, agents outside OpenClaw should not bypass the office to control Kasm directly.
'''.replace("{office_url}", office_url)


def _vo_meetings_skill_content():
    office_url = f"http://127.0.0.1:{PORT}"
    return '''---
name: VirtualOffice-Meetings
description: "Create, inspect, and end visible Virtual Office meetings with summaries and action items."
---

# VirtualOffice Meetings

Use meetings when multiple agents coordinate.

## Read meetings

```bash
curl -sS {office_url}/api/meetings/active
curl -sS {office_url}/api/meetings/history
```

## Create meeting

```bash
curl -sS -X POST {office_url}/api/meetings/create \
  -H 'Content-Type: application/json' \
  -d '{"topic":"Topic","purpose":"Why we are meeting","kind":"discussion","organizer":"YOUR_AGENT_ID","participants":["YOUR_AGENT_ID","OTHER_AGENT_ID"]}'
```

## End meeting

```bash
curl -sS -X POST {office_url}/api/meetings/end \
  -H 'Content-Type: application/json' \
  -d '{"id":"MEETING_ID","endedBy":"YOUR_AGENT_ID","summary":"What happened","resolution":"Decision/outcome","actionItems":["Next step"]}'
```

## Rules

- Always end meetings with a useful summary.
- Do not silently create meetings for casual one-off messages; use AgentPlatform communications for that.
'''.replace("{office_url}", office_url)


def _vo_projects_skill_content():
    office_url = f"http://127.0.0.1:{PORT}"
    return '''---
name: VirtualOffice-Projects-and-Tasks
description: "Inspect and work with Virtual Office projects, tasks, workflow status, and agent scores."
---

# VirtualOffice Projects and Tasks

Use this to inspect visible project/task state.

## Read projects

```bash
curl -sS {office_url}/api/projects
curl -sS {office_url}/api/projects/PROJECT_ID
curl -sS {office_url}/api/projects/PROJECT_ID/workflow/status
```

## Read scores

```bash
curl -sS {office_url}/api/projects/scores
```

## Create a task

```bash
curl -sS -X POST {office_url}/api/projects/PROJECT_ID/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Task title","description":"Task details","assignee":"AGENT_ID"}'
```

## Rules

- Prefer project/task endpoints for durable work instead of private chat when the work belongs on a board.
- Keep task titles short and descriptions concrete.
- Do not delete or reorder project data unless explicitly asked.
'''.replace("{office_url}", office_url)


def _builtin_office_skill_contents():
    return {
        AGENT_PLATFORM_COMM_SKILL_NAME: _agent_platform_comm_skill_content(),
        "VirtualOffice-Presence-and-Status": _vo_presence_skill_content(),
        "VirtualOffice-Browser-Control": _vo_browser_skill_content(),
        "VirtualOffice-Meetings": _vo_meetings_skill_content(),
        "VirtualOffice-Projects-and-Tasks": _vo_projects_skill_content(),
    }


def _ensure_builtin_communication_skill():
    """Seed built-in Virtual Office agent tool skills into the library."""
    try:
        lib_dir = _get_skills_library_dir()
        first_path = ""
        for skill_name, content in _builtin_office_skill_contents().items():
            skill_dir = os.path.join(lib_dir, skill_name)
            skill_file = os.path.join(skill_dir, "SKILL.md")
            os.makedirs(skill_dir, exist_ok=True)
            old = ""
            if os.path.isfile(skill_file):
                with open(skill_file, "r") as f:
                    old = f.read()
            if old != content:
                with open(skill_file, "w") as f:
                    f.write(content)
            if skill_name == AGENT_PLATFORM_COMM_SKILL_NAME:
                first_path = skill_file
        return first_path
    except Exception as e:
        print(f"[SKILLS] Failed to seed built-in office skills: {e}")
        return ""


def _hermes_platform_roster_agent():
    """Return the synthetic Hermes Messaging Gateway office agent, if enabled."""
    hermes = VO_CONFIG.get("hermes", {})
    if not hermes.get("platformEnabled") or not hermes.get("platformToken"):
        return None
    agent_id = str(hermes.get("platformAgentId") or "hermes-gateway").strip() or "hermes-gateway"
    now_ms = int(time.time() * 1000)
    return {
        "id": agent_id,
        "statusKey": agent_id,
        "providerKind": "hermes",
        "providerType": "gateway-platform",
        "providerAgentId": "gateway",
        "profile": "gateway",
        "name": "Hermes Gateway",
        "emoji": os.environ.get("VO_HERMES_GATEWAY_AGENT_EMOJI", "⚕️"),
        "role": "Hermes Messaging Gateway platform adapter",
        "model": "Hermes Gateway",
        "provider": "Hermes Messaging Gateway",
        "gateway": "my_virtual_office",
        "workspace": "",
        "home": "",
        "binary": "",
        "lastActiveAt": now_ms,
        "capabilities": ["chat", "presence", "messages"],
        "connectionModes": ["gateway-platform"],
        "cliAvailable": False,
        "apiAvailable": False,
        "desktopAvailable": False,
    }


def _discover_roster():
    hermes = VO_CONFIG.get("hermes", {})
    codex = VO_CONFIG.get("codex", {})
    claude_code = VO_CONFIG.get("claudeCode", {})
    opencode = VO_CONFIG.get("openCode", {})
    antigravity = VO_CONFIG.get("antigravity", {})
    roster = discover_all_agents(
        WORKSPACE_BASE,
        hermes_home=hermes.get("homePath"),
        hermes_bin=hermes.get("binary"),
        hermes_enabled=hermes.get("enabled", True),
        hermes_api_url=hermes.get("apiUrl"),
        hermes_api_key=hermes.get("apiKey"),
        hermes_desktop_url=hermes.get("desktopUrl"),
        hermes_desktop_token=hermes.get("desktopToken"),
        hermes_desktop_host_header=hermes.get("desktopHostHeader"),
        hermes_desktop_tcp_host=hermes.get("desktopTcpHost"),
        hermes_desktop_tcp_port=hermes.get("desktopTcpPort"),
        hermes_prefer_api=hermes.get("preferApi", True),
        hermes_timeout_sec=int(hermes.get("timeoutSec") or 600),
        codex_home=codex.get("homePath"),
        codex_bin=codex.get("binary"),
        codex_workspace_root=codex.get("workspaceRoot"),
        codex_enabled=codex.get("enabled", True),
        codex_model=codex.get("model") or "",
        codex_sandbox=codex.get("sandbox") or "workspace-write",
        codex_approval_policy=codex.get("approvalPolicy") or "never",
        codex_prefer_app_server=codex.get("preferAppServer", True),
        codex_timeout_sec=int(codex.get("timeoutSec") or 900),
        codex_main_workspace=codex.get("mainWorkspace"),
        codex_include_main=codex.get("includeMain", True),
        codex_include_native_agents=codex.get("includeNativeAgents", True),
        codex_register_native_agents=codex.get("registerNativeAgents", True),
        claude_home=claude_code.get("homePath"),
        claude_bin=claude_code.get("binary"),
        claude_workspace_root=claude_code.get("workspaceRoot"),
        claude_enabled=claude_code.get("enabled", True),
        claude_model=claude_code.get("model") or "",
        claude_permission_mode=claude_code.get("permissionMode") or "acceptEdits",
        claude_timeout_sec=int(claude_code.get("timeoutSec") or 900),
        claude_main_workspace=claude_code.get("mainWorkspace"),
        claude_include_main=claude_code.get("includeMain", True),
        claude_include_native_agents=claude_code.get("includeNativeAgents", True),
        claude_register_native_agents=claude_code.get("registerNativeAgents", True),
        opencode_home=opencode.get("homePath"),
        opencode_bin=opencode.get("binary"),
        opencode_workspace_root=opencode.get("workspaceRoot"),
        opencode_enabled=opencode.get("enabled", False),
        opencode_model=opencode.get("model") or "",
        opencode_timeout_sec=int(opencode.get("timeoutSec") or 900),
        opencode_main_workspace=opencode.get("mainWorkspace"),
        opencode_include_main=opencode.get("includeMain", True),
        opencode_include_agents=opencode.get("includeAgents", True),
        opencode_register_agents=opencode.get("registerAgents", True),
        antigravity_home=antigravity.get("homePath"),
        antigravity_bin=antigravity.get("binary"),
        antigravity_workspace_root=antigravity.get("workspaceRoot"),
        antigravity_enabled=antigravity.get("enabled", False),
        antigravity_timeout_sec=int(antigravity.get("timeoutSec") or 600),
        antigravity_print_timeout=antigravity.get("printTimeout") or "5m",
        antigravity_model=antigravity.get("model") or "",
        antigravity_sandbox=antigravity.get("sandbox") or "",
    )
    gateway_agent = _hermes_platform_roster_agent()
    if gateway_agent:
        key = gateway_agent.get("statusKey") or gateway_agent.get("id")
        if not any(key in (a.get("id"), a.get("statusKey"), a.get("providerAgentId")) for a in roster):
            roster.append(gateway_agent)
    return roster

_discovered_roster = _discover_roster()
_discovered_at = time.time()
DISCOVERY_REFRESH_SEC = 300  # re-discover every 5 min

def _refresh_discovery():
    """Refresh agent roster if stale."""
    global _discovered_roster, _discovered_at
    if time.time() - _discovered_at > DISCOVERY_REFRESH_SEC:
        _discovered_roster = _discover_roster()
        _discovered_at = time.time()

def get_roster():
    """Get current discovered agent roster."""
    _refresh_discovery()
    return _discovered_roster


def _apply_agent_limit_balanced(agents):
    """Apply product agent limits without hiding entire provider types.

    The old behavior sliced the discovered list, which meant newly added
    providers like Hermes could be detected but never visible in demo/limited
    modes because OpenClaw agents came first. This keeps licensing limits while
    trying to include at least one agent from each detected provider.
    """
    agent_limit = get_agent_limit()
    if agent_limit <= 0 or len(agents) <= agent_limit:
        return agents

    selected = []
    selected_keys = set()

    def key_for(a):
        return a.get("key") or a.get("statusKey") or a.get("agentId") or a.get("id")

    # First pass: one representative from each provider in discovery order.
    seen_providers = set()
    for agent in agents:
        provider = agent.get("providerKind", "openclaw")
        if provider in seen_providers:
            continue
        seen_providers.add(provider)
        k = key_for(agent)
        selected.append(agent)
        selected_keys.add(k)
        if len(selected) >= agent_limit:
            return selected

    # Fill remaining slots using original order.
    for agent in agents:
        k = key_for(agent)
        if k in selected_keys:
            continue
        selected.append(agent)
        selected_keys.add(k)
        if len(selected) >= agent_limit:
            break
    return selected

# Build compatibility maps from discovery (these update on refresh)
def _build_agent_info():
    return {a["statusKey"]: {"id": a["id"], "emoji": a["emoji"], "name": a["name"], "branch": "", "providerKind": a.get("providerKind", "openclaw")} for a in get_roster()}
def _build_agent_workspaces():
    result = {}
    for a in get_roster():
        if a.get("providerKind") in {"hermes", "codex", "claude-code", "opencode", "antigravity"}:
            result[a["statusKey"]] = a.get("home") or a.get("workspace") or ""
        else:
            result[a["statusKey"]] = get_agent_workspace_dir(WORKSPACE_BASE, a["id"]).replace(WORKSPACE_BASE + "/", "") if a["workspace"].startswith(WORKSPACE_BASE) else os.path.basename(a["workspace"])
    return result
def _build_agent_session_ids():
    return {a["statusKey"]: (a.get("providerAgentId") if a.get("providerKind") in {"hermes", "codex", "claude-code", "opencode", "antigravity"} else get_agent_session_id(a["id"])) for a in get_roster()}

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


def _agent_display_label(agent_id_or_key):
    """Return a friendly VO label for an agent id/status key without exposing internals."""
    if not agent_id_or_key:
        return ""
    needle = str(agent_id_or_key)
    for a in get_roster():
        if needle in (a.get("id"), a.get("statusKey")):
            name = a.get("name") or needle
            emoji = a.get("emoji") or ""
            return f"{name} {emoji}".strip()
    return needle


def _agent_id_from_session_key(session_key):
    """Parse OpenClaw session keys like agent:<agentId>:<bucket>."""
    if not session_key:
        return ""
    m = re.match(r"^agent:([^:]+):", str(session_key))
    return m.group(1) if m else ""


def _is_hermes_agent(agent_id_or_key):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId")):
            return a.get("providerKind") == "hermes"
    return needle.startswith("hermes:") or needle.startswith("hermes-")


def _parse_iso_epoch_ms(value):
    """Convert ISO timestamps or epoch-ish values to browser-friendly epoch ms."""
    if not value:
        return 0
    if isinstance(value, (int, float)):
        return int(value if value > 1e12 else value * 1000)
    try:
        raw = str(value)
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except Exception:
        return 0


def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


def _epoch_to_utc_iso(epoch):
    try:
        return datetime.fromtimestamp(float(epoch), tz=timezone.utc).isoformat()
    except Exception:
        return ""


def _format_time_local(ts):
    """Convert ISO timestamp or epoch ms to HH:MM AM/PM in the configured local zone."""
    try:
        if isinstance(ts, (int, float)):
            dt = datetime.fromtimestamp(ts / 1000 if ts > 1e12 else ts, tz=timezone.utc)
        elif isinstance(ts, str):
            if not ts.strip():
                return ""
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        else:
            return ""
        local_tz = ZoneInfo(os.environ.get("VO_TIMEZONE") or os.environ.get("TZ") or "UTC")
        return dt.astimezone(local_tz).strftime("%I:%M %p").lstrip("0")
    except Exception:
        return ""


def _read_tail_text(path, initial_bytes=64 * 1024, max_bytes=2 * 1024 * 1024, min_lines=20):
    """Read a complete-line tail from large JSONL files."""
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path, "rb") as fb:
            fb.seek(0, 2)
            fsize = fb.tell()
            tail_size = min(initial_bytes, fsize)
            while True:
                start = max(0, fsize - tail_size)
                fb.seek(start)
                tail_data = fb.read().decode("utf-8", errors="replace")
                if start > 0:
                    nl = tail_data.find("\n")
                    if nl >= 0:
                        tail_data = tail_data[nl + 1:]
                complete_lines = [x for x in tail_data.split("\n") if x.strip()]
                if start == 0 or len(complete_lines) >= min_lines or tail_size >= min(max_bytes, fsize):
                    return tail_data
                tail_size = min(tail_size * 4, max_bytes, fsize)
    except Exception:
        return ""


def _openclaw_session_paths(agent_id, session_key=None):
    """Resolve the active transcript and matching trajectory file for an agent session."""
    if not agent_id:
        return None, None, {}
    sessions_dir = os.path.join(WORKSPACE_BASE, f"agents/{agent_id}/sessions")
    sessions_json_path = os.path.join(sessions_dir, "sessions.json")
    session_info = {}
    selected_key = session_key or ""
    try:
        with open(sessions_json_path, "r") as f:
            sessions = json.load(f)
        if session_key and isinstance(sessions.get(session_key), dict):
            session_info = sessions.get(session_key) or {}
        if not session_info:
            best_ts = -1
            for skey, val in sessions.items():
                if not isinstance(val, dict):
                    continue
                ts = val.get("updatedAt", 0)
                if ts > best_ts:
                    best_ts = ts
                    session_info = val
                    selected_key = skey
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        session_info = {}

    if session_info and selected_key:
        session_info = dict(session_info)
        session_info.setdefault("key", selected_key)
        session_info.setdefault("sessionKey", selected_key)
    session_id = str(session_info.get("sessionId") or "")
    jsonl_file = os.path.join(sessions_dir, f"{session_id}.jsonl") if session_id else None
    trajectory_file = os.path.join(sessions_dir, f"{session_id}.trajectory.jsonl") if session_id else None
    if jsonl_file and not os.path.exists(jsonl_file):
        jsonl_file = None
    if trajectory_file and not os.path.exists(trajectory_file):
        trajectory_file = None
    return jsonl_file, trajectory_file, session_info


def _safe_tool_arguments(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {"value": value}
    return {}


def _limit_tool_payload(value, limit=2400):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        try:
            value = json.dumps(value, ensure_ascii=False)
        except Exception:
            value = str(value)
    value = str(value)
    if len(value) > limit:
        return value[:limit] + f"\n\n... [truncated - {len(value)} chars total] ..."
    return value


def _trajectory_activity_messages(trajectory_file, max_tools=60):
    """Recover recent tool calls/results from OpenClaw trajectory JSONL."""
    tail_data = _read_tail_text(trajectory_file, initial_bytes=256 * 1024, max_bytes=4 * 1024 * 1024, min_lines=80)
    if not tail_data:
        return []

    tools = {}
    order = []
    for line in tail_data.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        event_type = event.get("type") or ""
        if event_type not in ("tool.call", "tool.result"):
            continue
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        tool_id = str(data.get("toolCallId") or data.get("tool_call_id") or data.get("itemId") or event.get("id") or "")
        if not tool_id:
            tool_id = f"{event.get('seq', len(order))}:{event_type}"
        if tool_id not in tools:
            tools[tool_id] = {
                "id": tool_id,
                "runId": event.get("runId") or data.get("runId") or "",
                "status": "running",
                "name": data.get("name") or data.get("toolName") or "tool",
                "arguments": {},
                "result": "",
                "error": "",
                "ts": event.get("ts") or "",
                "epochMs": _parse_iso_epoch_ms(event.get("ts")),
                "source": "trajectory",
            }
            order.append(tool_id)
        tool = tools[tool_id]
        if event.get("ts"):
            tool["ts"] = event.get("ts")
            tool["epochMs"] = _parse_iso_epoch_ms(event.get("ts"))
        if event_type == "tool.call":
            tool["status"] = "running"
            tool["name"] = data.get("name") or data.get("toolName") or tool.get("name") or "tool"
            tool["arguments"] = _safe_tool_arguments(data.get("arguments") or data.get("args") or {})
        elif event_type == "tool.result":
            is_error = bool(data.get("isError") or data.get("error"))
            tool["status"] = "error" if is_error else "done"
            tool["name"] = data.get("name") or data.get("toolName") or tool.get("name") or "tool"
            result = data.get("output")
            if result is None:
                result = data.get("result")
            if result is None:
                result = data.get("error")
            if is_error:
                tool["error"] = _limit_tool_payload(result)
            else:
                tool["result"] = _limit_tool_payload(result)

    messages = []
    for tool_id in order[-max_tools:]:
        tool = tools.get(tool_id)
        if not tool:
            continue
        ts = tool.get("ts") or ""
        messages.append({
            "role": "assistant",
            "text": "",
            "ts": ts,
            "epochMs": tool.get("epochMs") or 0,
            "tools": [tool],
            "source": "trajectory",
        })
    return messages


def _session_trajectory_messages(session_key, max_tools=80):
    agent_id = _agent_id_from_session_key(session_key)
    if not agent_id:
        return []
    _, trajectory_file, _ = _openclaw_session_paths(agent_id, session_key=session_key)
    return _trajectory_activity_messages(trajectory_file, max_tools=max_tools)


def _get_hermes_agent(agent_id_or_key=None):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if a.get("providerKind") == "hermes" and (not needle or needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId"))):
            return a
    return None


def _is_hermes_gateway_platform_agent(agent_or_id):
    agent = agent_or_id if isinstance(agent_or_id, dict) else _get_hermes_agent(agent_or_id)
    return bool(agent and agent.get("providerKind") == "hermes" and agent.get("providerType") == "gateway-platform")


def _get_codex_agent(agent_id_or_key=None):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if a.get("providerKind") == "codex" and (not needle or needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId"), a.get("profile"))):
            return a
    return None


def _is_codex_agent(agent_id_or_key):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId"), a.get("profile")):
            return a.get("providerKind") == "codex"
    return needle.startswith("codex:") or needle.startswith("codex-")


def _codex_provider():
    codex_cfg = VO_CONFIG.get("codex", {})
    return CodexProvider(
        home_path=codex_cfg.get("homePath"),
        binary=codex_cfg.get("binary"),
        workspace_root=codex_cfg.get("workspaceRoot"),
        enabled=codex_cfg.get("enabled", True),
        timeout_sec=int(codex_cfg.get("timeoutSec") or 900),
        model=codex_cfg.get("model") or "",
        sandbox=codex_cfg.get("sandbox") or "workspace-write",
        approval_policy=codex_cfg.get("approvalPolicy") or "never",
        prefer_app_server=codex_cfg.get("preferAppServer", True),
        main_workspace=codex_cfg.get("mainWorkspace"),
        include_main=codex_cfg.get("includeMain", True),
        include_native_agents=codex_cfg.get("includeNativeAgents", True),
        register_native_agents=codex_cfg.get("registerNativeAgents", True),
    )


def _codex_history_path(profile="default"):
    safe_profile = re.sub(r"[^a-zA-Z0-9_.-]+", "-", profile or "default")[:80] or "default"
    return os.path.join(STATUS_DIR, f"codex-chat-{safe_profile}.json")


def _load_codex_history(profile="default"):
    path = _codex_history_path(profile)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        messages = data.get("messages", []) if isinstance(data, dict) else []
        return messages if isinstance(messages, list) else []
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []


def _load_codex_state(profile="default"):
    path = _codex_history_path(profile)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {"messages": []}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"messages": []}


def _save_codex_state(profile, state):
    path = _codex_history_path(profile)
    data = state if isinstance(state, dict) else {}
    data.setdefault("messages", [])
    data["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _codex_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _codex_context_used_from_token_usage(token_usage):
    token_usage = token_usage if isinstance(token_usage, dict) else {}
    last = token_usage.get("last") if isinstance(token_usage.get("last"), dict) else {}
    last_total = _codex_int(last.get("totalTokens"), 0)
    if last_total:
        return last_total
    last_input = _codex_int(last.get("inputTokens"), 0)
    if last_input:
        return last_input
    total = token_usage.get("total") if isinstance(token_usage.get("total"), dict) else {}
    return _codex_int(total.get("totalTokens"), 0)


def _codex_context_window_from_token_usage(token_usage):
    token_usage = token_usage if isinstance(token_usage, dict) else {}
    return _codex_int(token_usage.get("modelContextWindow"), 0)


def _get_codex_token_usage(profile="default"):
    state = _load_codex_state(profile)
    token_usage = state.get("tokenUsage") if isinstance(state.get("tokenUsage"), dict) else {}
    return token_usage


def _set_codex_token_usage(profile="default", token_usage=None):
    if not isinstance(token_usage, dict) or not token_usage:
        return
    path = _codex_history_path(profile)
    state = _load_codex_state(profile)
    state["tokenUsage"] = token_usage
    state["contextUsed"] = _codex_context_used_from_token_usage(token_usage)
    context_window = _codex_context_window_from_token_usage(token_usage)
    if context_window:
        state["contextWindow"] = context_window
    state.setdefault("messages", [])
    state["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _clear_codex_token_usage(profile="default"):
    path = _codex_history_path(profile)
    state = _load_codex_state(profile)
    for key in ("tokenUsage", "contextUsed", "contextWindow"):
        state.pop(key, None)
    state.setdefault("messages", [])
    state["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _save_codex_history(profile, messages):
    path = _codex_history_path(profile)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    state = _load_codex_state(profile)
    state["messages"] = messages
    state["updatedAt"] = int(time.time() * 1000)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _get_codex_session_id(profile="default"):
    state = _load_codex_state(profile)
    return str(state.get("sessionId") or "")


def _set_codex_session_id(profile="default", session_id=""):
    path = _codex_history_path(profile)
    state = _load_codex_state(profile)
    state["sessionId"] = session_id or ""
    state.setdefault("messages", [])
    state["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _set_codex_active_run(profile="default", session_id="", run_id=""):
    path = _codex_history_path(profile)
    state = _load_codex_state(profile)
    state["sessionId"] = session_id or state.get("sessionId") or ""
    state["runId"] = run_id or ""
    state.setdefault("messages", [])
    state["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _get_claude_code_agent(agent_id_or_key=None):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if a.get("providerKind") == "claude-code" and (not needle or needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId"), a.get("profile"))):
            return a
    return None


def _is_claude_code_agent(agent_id_or_key):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId"), a.get("profile")):
            return a.get("providerKind") == "claude-code"
    return needle.startswith("claude-code:") or needle.startswith("claude-code-")


def _claude_code_provider():
    claude_cfg = VO_CONFIG.get("claudeCode", {})
    return ClaudeCodeProvider(
        home_path=claude_cfg.get("homePath"),
        binary=claude_cfg.get("binary"),
        workspace_root=claude_cfg.get("workspaceRoot"),
        enabled=claude_cfg.get("enabled", True),
        timeout_sec=int(claude_cfg.get("timeoutSec") or 900),
        model=claude_cfg.get("model") or "",
        permission_mode=claude_cfg.get("permissionMode") or "acceptEdits",
        main_workspace=claude_cfg.get("mainWorkspace"),
        include_main=claude_cfg.get("includeMain", True),
        include_native_agents=claude_cfg.get("includeNativeAgents", True),
        register_native_agents=claude_cfg.get("registerNativeAgents", True),
    )


def _opencode_provider():
    opencode_cfg = VO_CONFIG.get("openCode", {})
    return OpenCodeProvider(
        home_path=opencode_cfg.get("homePath"),
        binary=opencode_cfg.get("binary"),
        workspace_root=opencode_cfg.get("workspaceRoot"),
        enabled=opencode_cfg.get("enabled", True),
        timeout_sec=int(opencode_cfg.get("timeoutSec") or 900),
        model=opencode_cfg.get("model") or "",
        main_workspace=opencode_cfg.get("mainWorkspace"),
        include_main=opencode_cfg.get("includeMain", True),
        include_agents=opencode_cfg.get("includeAgents", True),
        register_agents=opencode_cfg.get("registerAgents", True),
    )


def _antigravity_provider():
    ag_cfg = VO_CONFIG.get("antigravity", {})
    return AntigravityProvider(
        home_path=ag_cfg.get("homePath"),
        binary=ag_cfg.get("binary"),
        workspace_root=ag_cfg.get("workspaceRoot"),
        enabled=ag_cfg.get("enabled", True),
        timeout_sec=int(ag_cfg.get("timeoutSec") or 600),
        print_timeout=ag_cfg.get("printTimeout", "5m"),
        model=ag_cfg.get("model") or "",
        sandbox=ag_cfg.get("sandbox") or "",
    )


def _get_opencode_agent(agent_id_or_key=None):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if a.get("providerKind") == "opencode" and (not needle or needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId"), a.get("profile"))):
            return a
    return None


def _is_opencode_agent(agent_id_or_key):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId"), a.get("profile")):
            return a.get("providerKind") == "opencode"
    return needle.startswith("opencode:") or needle.startswith("opencode-")


def _get_antigravity_agent(agent_id_or_key=None):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if a.get("providerKind") == "antigravity" and (not needle or needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId"), a.get("profile"))):
            return a
    return None


def _is_antigravity_agent(agent_id_or_key):
    needle = str(agent_id_or_key or "")
    for a in get_roster():
        if needle in (a.get("id"), a.get("statusKey"), a.get("providerAgentId"), a.get("profile")):
            return a.get("providerKind") == "antigravity"
    return needle.startswith("antigravity:") or needle.startswith("antigravity-")


def _opencode_history_path(profile="main"):
    safe_profile = re.sub(r"[^a-zA-Z0-9_.-]+", "-", profile or "main")[:80] or "main"
    return os.path.join(STATUS_DIR, f"opencode-chat-{safe_profile}.json")


def _load_opencode_state(profile="main"):
    path = _opencode_history_path(profile)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {"messages": []}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"messages": []}


def _load_opencode_history(profile="main"):
    state = _load_opencode_state(profile)
    messages = state.get("messages", []) if isinstance(state, dict) else []
    return messages if isinstance(messages, list) else []


def _save_opencode_state(profile, state):
    path = _opencode_history_path(profile)
    data = state if isinstance(state, dict) else {}
    data.setdefault("messages", [])
    data["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _save_opencode_history(profile, messages):
    state = _load_opencode_state(profile)
    state["messages"] = messages
    _save_opencode_state(profile, state)


def _get_opencode_session_id(profile="main"):
    return str(_load_opencode_state(profile).get("sessionId") or "")


def _set_opencode_session_id(profile="main", session_id=""):
    state = _load_opencode_state(profile)
    state["sessionId"] = session_id or ""
    _save_opencode_state(profile, state)


def _antigravity_history_path(profile="main"):
    safe_profile = re.sub(r"[^a-zA-Z0-9_.-]+", "-", profile or "main")[:80] or "main"
    return os.path.join(STATUS_DIR, f"antigravity-chat-{safe_profile}.json")


def _load_antigravity_state(profile="main"):
    path = _antigravity_history_path(profile)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {"messages": []}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"messages": []}


def _load_antigravity_history(profile="main"):
    state = _load_antigravity_state(profile)
    messages = state.get("messages", []) if isinstance(state, dict) else []
    return messages if isinstance(messages, list) else []


def _save_antigravity_state(profile, state):
    path = _antigravity_history_path(profile)
    data = state if isinstance(state, dict) else {}
    data.setdefault("messages", [])
    data["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _save_antigravity_history(profile, messages):
    state = _load_antigravity_state(profile)
    state["messages"] = messages
    _save_antigravity_state(profile, state)


def _claude_code_history_path(profile="main"):
    safe_profile = re.sub(r"[^a-zA-Z0-9_.-]+", "-", profile or "main")[:80] or "main"
    return os.path.join(STATUS_DIR, f"claude-code-chat-{safe_profile}.json")


def _load_claude_code_history(profile="main"):
    path = _claude_code_history_path(profile)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        messages = data.get("messages", []) if isinstance(data, dict) else []
        return messages if isinstance(messages, list) else []
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []


def _load_claude_code_state(profile="main"):
    path = _claude_code_history_path(profile)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {"messages": []}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"messages": []}


def _save_claude_code_state(profile, state):
    path = _claude_code_history_path(profile)
    data = state if isinstance(state, dict) else {}
    data.setdefault("messages", [])
    data["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _get_claude_code_token_usage(profile="main"):
    state = _load_claude_code_state(profile)
    token_usage = state.get("tokenUsage") if isinstance(state.get("tokenUsage"), dict) else {}
    return token_usage


def _set_claude_code_token_usage(profile="main", token_usage=None):
    if not isinstance(token_usage, dict) or not token_usage:
        return
    path = _claude_code_history_path(profile)
    state = _load_claude_code_state(profile)
    state["tokenUsage"] = token_usage
    state["contextUsed"] = _codex_context_used_from_token_usage(token_usage)
    context_window = _codex_context_window_from_token_usage(token_usage)
    if context_window:
        state["contextWindow"] = context_window
    state.setdefault("messages", [])
    state["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _clear_claude_code_token_usage(profile="main"):
    path = _claude_code_history_path(profile)
    state = _load_claude_code_state(profile)
    for key in ("tokenUsage", "contextUsed", "contextWindow"):
        state.pop(key, None)
    state.setdefault("messages", [])
    state["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _save_claude_code_history(profile, messages):
    path = _claude_code_history_path(profile)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    state = _load_claude_code_state(profile)
    state["messages"] = messages
    state["updatedAt"] = int(time.time() * 1000)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _get_claude_code_session_id(profile="main"):
    state = _load_claude_code_state(profile)
    return str(state.get("sessionId") or "")


def _set_claude_code_session_id(profile="main", session_id=""):
    path = _claude_code_history_path(profile)
    state = _load_claude_code_state(profile)
    state["sessionId"] = session_id or ""
    state.setdefault("messages", [])
    state["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _set_claude_code_active_run(profile="main", session_id="", run_id=""):
    path = _claude_code_history_path(profile)
    state = _load_claude_code_state(profile)
    state["sessionId"] = session_id or state.get("sessionId") or ""
    state["runId"] = run_id or ""
    state.setdefault("messages", [])
    state["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _publish_claude_code_progress(profile, agent_id, progress_id, run_state):
    if not progress_id:
        return
    run_state = run_state if isinstance(run_state, dict) else {}
    history = _load_claude_code_history(profile)
    history = [
        msg for msg in history
        if not (isinstance(msg, dict) and msg.get("ephemeral") == "claude-code-progress" and msg.get("progressId") == progress_id)
    ]
    session_id = run_state.get("sessionId") or run_state.get("threadId") or _get_claude_code_session_id(profile) or ""
    run_id = run_state.get("runId") or session_id
    token_usage = run_state.get("tokenUsage") if isinstance(run_state.get("tokenUsage"), dict) else {}
    progress_message = {
        "role": "assistant",
        "text": run_state.get("reply") or "",
        "ts": int(time.time() * 1000),
        "agentId": agent_id,
        "ephemeral": "claude-code-progress",
        "progressId": progress_id,
        "sessionId": session_id,
        "runId": run_id,
        "tools": run_state.get("tools") or [],
        "thinking": run_state.get("status") or run_state.get("thinking") or "Waiting for Claude Code stream events.",
        "reasoningTokens": 0,
        "error": run_state.get("error") or None,
    }
    if token_usage:
        progress_message["tokenUsage"] = token_usage
        progress_message["contextUsed"] = _codex_context_used_from_token_usage(token_usage)
        context_window = _codex_context_window_from_token_usage(token_usage)
        if context_window:
            progress_message["contextWindow"] = context_window
        _set_claude_code_token_usage(profile, token_usage)
    history.append(progress_message)
    _save_claude_code_history(profile, history)
    if session_id or run_id:
        _set_claude_code_active_run(profile, session_id, run_id)


def _remove_claude_code_progress_messages(messages):
    return [m for m in messages if not (isinstance(m, dict) and m.get("ephemeral") == "claude-code-progress")]


def _publish_codex_progress(profile, agent_id, progress_id, run_state):
    """Publish in-flight Codex app-server state to the visible chat history."""
    if not progress_id:
        return
    run_state = run_state if isinstance(run_state, dict) else {}
    history = _load_codex_history(profile)
    history = [
        msg for msg in history
        if not (isinstance(msg, dict) and msg.get("ephemeral") == "codex-progress" and msg.get("progressId") == progress_id)
    ]
    session_id = run_state.get("threadId") or _get_codex_session_id(profile) or ""
    run_id = run_state.get("runId") or run_state.get("turnId") or ""
    token_usage = run_state.get("tokenUsage") if isinstance(run_state.get("tokenUsage"), dict) else {}
    progress_message = {
        "role": "assistant",
        "text": run_state.get("reply") or "",
        "ts": int(time.time() * 1000),
        "agentId": agent_id,
        "ephemeral": "codex-progress",
        "progressId": progress_id,
        "sessionId": session_id,
        "runId": run_id,
        "tools": run_state.get("tools") or [],
        "thinking": run_state.get("thinking") or "Waiting for Codex app-server events.",
        "reasoningTokens": 0,
        "approval": run_state.get("approval") if isinstance(run_state.get("approval"), dict) else None,
        "error": run_state.get("error") or None,
    }
    if token_usage:
        progress_message["tokenUsage"] = token_usage
        progress_message["contextUsed"] = _codex_context_used_from_token_usage(token_usage)
        context_window = _codex_context_window_from_token_usage(token_usage)
        if context_window:
            progress_message["contextWindow"] = context_window
        _set_codex_token_usage(profile, token_usage)
    history.append(progress_message)
    _save_codex_history(profile, history)
    if session_id or run_id:
        _set_codex_active_run(profile, session_id, run_id)


def _remove_codex_progress_messages(messages):
    return [m for m in messages if not (isinstance(m, dict) and m.get("ephemeral") == "codex-progress")]


CODEX_STREAM_RUNS_LOCK = threading.Lock()
CODEX_STREAM_RUNS = {}


def _remember_codex_stream_run(meta):
    if not isinstance(meta, dict) or not meta.get("runId"):
        return
    with CODEX_STREAM_RUNS_LOCK:
        CODEX_STREAM_RUNS[str(meta["runId"])] = meta


def _get_codex_stream_run(run_id):
    with CODEX_STREAM_RUNS_LOCK:
        meta = CODEX_STREAM_RUNS.get(str(run_id or ""))
        return meta if isinstance(meta, dict) else None


def _clear_codex_stream_run(run_id):
    with CODEX_STREAM_RUNS_LOCK:
        CODEX_STREAM_RUNS.pop(str(run_id or ""), None)


def _codex_stream_event_payload(run_id, agent, profile, run_state=None, **extra):
    run_state = run_state if isinstance(run_state, dict) else {}
    payload = {
        "runId": run_id,
        "agentId": (agent or {}).get("id") or "",
        "profile": profile or "",
        "sessionId": run_state.get("threadId") or _get_codex_session_id(profile) or "",
        "turnId": run_state.get("turnId") or run_state.get("runId") or "",
        "reply": run_state.get("reply") or "",
        "tools": run_state.get("tools") or [],
        "thinking": run_state.get("thinking") or "",
        "approval": run_state.get("approval") if isinstance(run_state.get("approval"), dict) else None,
        "error": run_state.get("error") or "",
        "status": run_state.get("status") or "",
        "providerPath": "app-server",
    }
    token_usage = run_state.get("tokenUsage") if isinstance(run_state.get("tokenUsage"), dict) else {}
    if token_usage:
        payload["tokenUsage"] = token_usage
        payload["contextUsed"] = _codex_context_used_from_token_usage(token_usage)
        context_window = _codex_context_window_from_token_usage(token_usage)
        if context_window:
            payload["contextWindow"] = context_window
    payload.update({k: v for k, v in extra.items() if v is not None})
    return payload


def _codex_tool_stream_key(tool, idx=0):
    if not isinstance(tool, dict):
        return str(idx)
    return str(tool.get("id") or f"{idx}:{tool.get('name') or 'tool'}:{json.dumps(tool.get('arguments') or {}, sort_keys=True, default=str)[:120]}")


def _handle_codex_run_start(body):
    """Start a Codex message in the background and expose progress over SSE."""
    message = (body.get("message") or "").strip()
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "codex-default"
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}

    agent = _get_codex_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Codex agent '{agent_key}' not found", "_status": 404}

    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
    run_id = f"codex-{int(time.time() * 1000)}-{str(uuid.uuid4())[:8]}"
    progress_id = f"codex-progress-{run_id}"
    events = queue.Queue()
    status_key = agent.get("statusKey") or agent.get("id")
    meta = {
        "runId": run_id,
        "agentId": agent.get("id"),
        "agentKey": agent_key,
        "profile": profile,
        "statusKey": status_key,
        "events": events,
        "startedAt": int(time.time() * 1000),
        "done": False,
        "result": None,
    }
    _remember_codex_stream_run(meta)

    def enqueue(event_name, payload=None):
        payload = payload if isinstance(payload, dict) else {}
        payload.setdefault("runId", run_id)
        payload.setdefault("agentId", agent.get("id") or "")
        payload.setdefault("profile", profile)
        try:
            events.put_nowait({"event": event_name, "data": payload, "ts": int(time.time() * 1000)})
        except Exception:
            pass

    def worker():
        last_reply = ""
        last_thinking = ""
        last_approval_id = ""
        last_token_usage_signature = ""
        seen_tools = {}
        enqueue("run.started", {"providerPath": "app-server"})

        def on_progress(run_state):
            nonlocal last_reply, last_thinking, last_approval_id, last_token_usage_signature
            run_state = run_state if isinstance(run_state, dict) else {}
            with CODEX_STREAM_RUNS_LOCK:
                meta["sessionId"] = run_state.get("threadId") or meta.get("sessionId") or ""
                meta["turnId"] = run_state.get("turnId") or run_state.get("runId") or meta.get("turnId") or ""
            gateway_presence.set_provider_event(status_key, "codex", {
                "event": "turn.stream",
                "thread_id": run_state.get("threadId") or "",
                "turn_id": run_state.get("turnId") or run_state.get("runId") or "",
                "status": run_state.get("status") or "",
            })

            token_usage = run_state.get("tokenUsage") if isinstance(run_state.get("tokenUsage"), dict) else {}
            if token_usage:
                token_usage_signature = json.dumps(token_usage, sort_keys=True, default=str)
                if token_usage_signature != last_token_usage_signature:
                    last_token_usage_signature = token_usage_signature
                    enqueue("session.metrics", _codex_stream_event_payload(run_id, agent, profile, run_state))

            reply = str(run_state.get("reply") or "")
            if reply and reply != last_reply:
                delta = reply[len(last_reply):] if reply.startswith(last_reply) else ""
                last_reply = reply
                enqueue("message.delta", _codex_stream_event_payload(run_id, agent, profile, run_state, delta=delta))

            thinking = str(run_state.get("thinking") or "")
            if thinking and thinking != last_thinking:
                last_thinking = thinking
                enqueue("reasoning.available", _codex_stream_event_payload(run_id, agent, profile, run_state))

            approval = run_state.get("approval") if isinstance(run_state.get("approval"), dict) else None
            approval_id = str((approval or {}).get("approval_id") or (approval or {}).get("id") or "")
            if approval and approval_id and approval_id != last_approval_id:
                last_approval_id = approval_id
                enqueue("approval.request", _codex_stream_event_payload(run_id, agent, profile, run_state, approval=approval))

            for idx, tool in enumerate(run_state.get("tools") or []):
                if not isinstance(tool, dict):
                    continue
                key = _codex_tool_stream_key(tool, idx)
                status = str(tool.get("status") or "").lower()
                is_terminal = status in {"done", "error", "failed"}
                prior = seen_tools.get(key)
                if not prior:
                    enqueue("tool.started", _codex_stream_event_payload(run_id, agent, profile, run_state, toolCard=tool, toolCallId=key))
                if is_terminal and (not prior or prior.get("status") != status or prior.get("result") != tool.get("result") or prior.get("error") != tool.get("error")):
                    event_name = "tool.failed" if status in {"error", "failed"} or tool.get("error") else "tool.completed"
                    enqueue(event_name, _codex_stream_event_payload(run_id, agent, profile, run_state, toolCard=tool, toolCallId=key))
                seen_tools[key] = dict(tool)

        run_body = dict(body)
        run_body["_streamRunId"] = run_id
        run_body["_streamProgressId"] = progress_id
        run_body["_onProgress"] = on_progress
        try:
            result = _handle_codex_chat(run_body)
        except Exception as exc:
            result = {"ok": False, "error": str(exc), "_status": 500}
        with CODEX_STREAM_RUNS_LOCK:
            meta["done"] = True
            meta["result"] = result
        if result.get("ok"):
            token_usage = result.get("tokenUsage") if isinstance(result.get("tokenUsage"), dict) else {}
            enqueue("run.completed", {
                "runId": run_id,
                "agentId": agent.get("id") or "",
                "profile": profile,
                "sessionId": result.get("sessionId") or _get_codex_session_id(profile) or "",
                "turnId": result.get("runId") or meta.get("turnId") or "",
                "reply": result.get("reply") or "",
                "tools": result.get("tools") or [],
                "thinking": result.get("thinking") or "",
                "approval": result.get("approval") if isinstance(result.get("approval"), dict) else None,
                "tokenUsage": token_usage,
                "contextUsed": _codex_context_used_from_token_usage(token_usage),
                "contextWindow": _codex_context_window_from_token_usage(token_usage),
                "providerPath": result.get("providerPath") or "app-server",
            })
        else:
            token_usage = result.get("tokenUsage") if isinstance(result.get("tokenUsage"), dict) else {}
            enqueue("run.failed", {
                "runId": run_id,
                "agentId": agent.get("id") or "",
                "profile": profile,
                "sessionId": result.get("sessionId") or _get_codex_session_id(profile) or "",
                "turnId": result.get("runId") or meta.get("turnId") or "",
                "reply": result.get("reply") or "",
                "tools": result.get("tools") or [],
                "thinking": result.get("thinking") or "",
                "approval": result.get("approval") if isinstance(result.get("approval"), dict) else None,
                "tokenUsage": token_usage,
                "contextUsed": _codex_context_used_from_token_usage(token_usage),
                "contextWindow": _codex_context_window_from_token_usage(token_usage),
                "providerPath": result.get("providerPath") or "app-server",
                "error": result.get("error") or result.get("reply") or "Codex run failed",
            })
        threading.Timer(600, _clear_codex_stream_run, args=(run_id,)).start()

    threading.Thread(target=worker, daemon=True, name=f"codex-run-{run_id}").start()
    return {
        "ok": True,
        "runId": run_id,
        "providerPath": "app-server",
        "agent": {"id": agent.get("id"), "name": agent.get("name"), "providerKind": "codex", "profile": profile},
    }


def _handle_codex_run_events(handler, run_id):
    meta = _get_codex_stream_run(run_id)
    if not meta:
        handler.send_response(404)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.end_headers()
        handler.wfile.write(b"event: run.failed\ndata: {\"error\":\"Codex run not found\"}\n\n")
        return

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()

    events = meta.get("events")
    if not isinstance(events, queue.Queue):
        return

    last_keepalive = time.time()
    try:
        while True:
            try:
                item = events.get(timeout=0.5)
            except queue.Empty:
                if time.time() - last_keepalive >= 10:
                    handler.wfile.write(b": keepalive\n\n")
                    handler.wfile.flush()
                    last_keepalive = time.time()
                if meta.get("done") and events.empty():
                    break
                continue

            event_name = str(item.get("event") or "message")
            payload = item.get("data") if isinstance(item.get("data"), dict) else {}
            encoded = json.dumps(payload, ensure_ascii=False, default=str)
            handler.wfile.write(f"event: {event_name}\ndata: {encoded}\n\n".encode("utf-8"))
            handler.wfile.flush()
            if event_name in {"run.completed", "run.failed", "run.cancelled", "run.canceled"}:
                break
    except (BrokenPipeError, ConnectionError, OSError):
        pass
    finally:
        if meta.get("done"):
            _clear_codex_stream_run(run_id)


CLAUDE_CODE_STREAM_RUNS_LOCK = threading.Lock()
CLAUDE_CODE_STREAM_RUNS = {}


def _remember_claude_code_stream_run(meta):
    if not isinstance(meta, dict) or not meta.get("runId"):
        return
    with CLAUDE_CODE_STREAM_RUNS_LOCK:
        CLAUDE_CODE_STREAM_RUNS[str(meta["runId"])] = meta


def _get_claude_code_stream_run(run_id):
    with CLAUDE_CODE_STREAM_RUNS_LOCK:
        meta = CLAUDE_CODE_STREAM_RUNS.get(str(run_id or ""))
        return meta if isinstance(meta, dict) else None


def _clear_claude_code_stream_run(run_id):
    with CLAUDE_CODE_STREAM_RUNS_LOCK:
        CLAUDE_CODE_STREAM_RUNS.pop(str(run_id or ""), None)


def _claude_code_stream_event_payload(run_id, agent, profile, run_state=None, **extra):
    run_state = run_state if isinstance(run_state, dict) else {}
    token_usage = run_state.get("tokenUsage") if isinstance(run_state.get("tokenUsage"), dict) else {}
    payload = {
        "runId": run_id,
        "agentId": (agent or {}).get("id") or "",
        "profile": profile or "",
        "sessionId": run_state.get("sessionId") or run_state.get("threadId") or _get_claude_code_session_id(profile) or "",
        "turnId": run_state.get("runId") or run_state.get("sessionId") or "",
        "reply": run_state.get("reply") or "",
        "tools": run_state.get("tools") or [],
        "thinking": run_state.get("status") or run_state.get("thinking") or "",
        "error": run_state.get("error") or "",
        "status": run_state.get("status") or "",
        "providerPath": "claude-code-cli",
    }
    if token_usage:
        payload["tokenUsage"] = token_usage
        payload["contextUsed"] = _codex_context_used_from_token_usage(token_usage)
        context_window = _codex_context_window_from_token_usage(token_usage)
        if context_window:
            payload["contextWindow"] = context_window
    payload.update({k: v for k, v in extra.items() if v is not None})
    return payload


def _claude_code_tool_stream_key(tool, idx=0):
    if not isinstance(tool, dict):
        return f"claude-code-tool-{idx}"
    return str(tool.get("id") or f"{idx}:{tool.get('name') or 'tool'}:{json.dumps(tool.get('arguments') or {}, sort_keys=True, default=str)[:120]}")


def _handle_claude_code_run_start(body):
    """Start a Claude Code message in the background and expose progress over SSE."""
    message = (body.get("message") or "").strip()
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "claude-code-main"
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}

    agent = _get_claude_code_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Claude Code agent '{agent_key}' not found", "_status": 404}

    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
    run_id = f"claude-code-{int(time.time() * 1000)}-{str(uuid.uuid4())[:8]}"
    progress_id = f"claude-code-progress-{run_id}"
    events = queue.Queue()
    status_key = agent.get("statusKey") or agent.get("id")
    meta = {
        "runId": run_id,
        "agentId": agent.get("id"),
        "agentKey": agent_key,
        "profile": profile,
        "statusKey": status_key,
        "events": events,
        "startedAt": int(time.time() * 1000),
        "done": False,
        "result": None,
    }
    _remember_claude_code_stream_run(meta)

    def enqueue(event_name, payload=None):
        payload = payload if isinstance(payload, dict) else {}
        payload.setdefault("runId", run_id)
        payload.setdefault("agentId", agent.get("id") or "")
        payload.setdefault("profile", profile)
        try:
            events.put_nowait({"event": event_name, "data": payload, "ts": int(time.time() * 1000)})
        except Exception:
            pass

    def worker():
        last_reply = ""
        last_thinking = ""
        last_token_usage_signature = ""
        seen_tools = {}
        enqueue("run.started", {"providerPath": "claude-code-cli"})

        def on_progress(run_state):
            nonlocal last_reply, last_thinking, last_token_usage_signature
            run_state = run_state if isinstance(run_state, dict) else {}
            with CLAUDE_CODE_STREAM_RUNS_LOCK:
                meta["sessionId"] = run_state.get("sessionId") or run_state.get("threadId") or meta.get("sessionId") or ""
                meta["turnId"] = run_state.get("runId") or meta.get("turnId") or ""
            gateway_presence.set_provider_event(status_key, "claude-code", {
                "event": "turn.stream",
                "session_id": run_state.get("sessionId") or run_state.get("threadId") or "",
                "run_id": run_state.get("runId") or "",
                "status": run_state.get("status") or "",
            })

            token_usage = run_state.get("tokenUsage") if isinstance(run_state.get("tokenUsage"), dict) else {}
            if token_usage:
                token_usage_signature = json.dumps(token_usage, sort_keys=True, default=str)
                if token_usage_signature != last_token_usage_signature:
                    last_token_usage_signature = token_usage_signature
                    enqueue("session.metrics", _claude_code_stream_event_payload(run_id, agent, profile, run_state))

            reply = str(run_state.get("reply") or "")
            if reply and reply != last_reply:
                delta = reply[len(last_reply):] if reply.startswith(last_reply) else ""
                last_reply = reply
                enqueue("message.delta", _claude_code_stream_event_payload(run_id, agent, profile, run_state, delta=delta))

            thinking = str(run_state.get("status") or run_state.get("thinking") or "")
            if thinking and thinking != last_thinking:
                last_thinking = thinking
                enqueue("reasoning.available", _claude_code_stream_event_payload(run_id, agent, profile, run_state))

            for idx, tool in enumerate(run_state.get("tools") or []):
                if not isinstance(tool, dict):
                    continue
                key = _claude_code_tool_stream_key(tool, idx)
                status = str(tool.get("status") or "").lower()
                is_terminal = status in {"done", "error", "failed"}
                prior = seen_tools.get(key)
                if not prior:
                    enqueue("tool.started", _claude_code_stream_event_payload(run_id, agent, profile, run_state, toolCard=tool, toolCallId=key))
                if is_terminal and (not prior or prior.get("status") != status or prior.get("result") != tool.get("result") or prior.get("error") != tool.get("error")):
                    event_name = "tool.failed" if status in {"error", "failed"} or tool.get("error") else "tool.completed"
                    enqueue(event_name, _claude_code_stream_event_payload(run_id, agent, profile, run_state, toolCard=tool, toolCallId=key))
                seen_tools[key] = dict(tool)

        run_body = dict(body)
        run_body["_streamRunId"] = run_id
        run_body["_streamProgressId"] = progress_id
        run_body["_onProgress"] = on_progress
        try:
            result = _handle_claude_code_chat(run_body)
        except Exception as exc:
            result = {"ok": False, "error": str(exc), "_status": 500}
        with CLAUDE_CODE_STREAM_RUNS_LOCK:
            meta["done"] = True
            meta["result"] = result
        token_usage = result.get("tokenUsage") if isinstance(result.get("tokenUsage"), dict) else {}
        payload = {
            "runId": run_id,
            "agentId": agent.get("id") or "",
            "profile": profile,
            "sessionId": result.get("sessionId") or _get_claude_code_session_id(profile) or "",
            "turnId": result.get("runId") or result.get("sessionId") or meta.get("turnId") or "",
            "reply": result.get("reply") or "",
            "tools": result.get("tools") or [],
            "thinking": result.get("thinking") or "",
            "tokenUsage": token_usage,
            "contextUsed": _codex_context_used_from_token_usage(token_usage),
            "contextWindow": _codex_context_window_from_token_usage(token_usage),
            "providerPath": result.get("providerPath") or "claude-code-cli",
        }
        if result.get("ok"):
            enqueue("run.completed", payload)
        else:
            payload["error"] = result.get("error") or result.get("reply") or "Claude Code run failed"
            enqueue("run.failed", payload)
        threading.Timer(600, _clear_claude_code_stream_run, args=(run_id,)).start()

    threading.Thread(target=worker, daemon=True, name=f"claude-code-run-{run_id}").start()
    return {
        "ok": True,
        "runId": run_id,
        "providerPath": "claude-code-cli",
        "agent": {"id": agent.get("id"), "name": agent.get("name"), "providerKind": "claude-code", "profile": profile},
    }


def _handle_claude_code_run_events(handler, run_id):
    meta = _get_claude_code_stream_run(run_id)
    if not meta:
        handler.send_response(404)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.end_headers()
        handler.wfile.write(b"event: run.failed\ndata: {\"error\":\"Claude Code run not found\"}\n\n")
        return

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()

    events = meta.get("events")
    if not isinstance(events, queue.Queue):
        return

    last_keepalive = time.time()
    try:
        while True:
            try:
                item = events.get(timeout=0.5)
            except queue.Empty:
                if time.time() - last_keepalive >= 10:
                    handler.wfile.write(b": keepalive\n\n")
                    handler.wfile.flush()
                    last_keepalive = time.time()
                if meta.get("done") and events.empty():
                    break
                continue

            event_name = str(item.get("event") or "message")
            payload = item.get("data") if isinstance(item.get("data"), dict) else {}
            encoded = json.dumps(payload, ensure_ascii=False, default=str)
            handler.wfile.write(f"event: {event_name}\ndata: {encoded}\n\n".encode("utf-8"))
            handler.wfile.flush()
            if event_name in {"run.completed", "run.failed", "run.cancelled", "run.canceled"}:
                break
    except (BrokenPipeError, ConnectionError, OSError):
        pass
    finally:
        if meta.get("done"):
            _clear_claude_code_stream_run(run_id)


def _normalize_codex_approval_choice(choice):
    choice = str(choice or "").strip().lower()
    if choice in {"approve", "approved", "accept", "allow", "allow_once", "approve_once", "yes"}:
        return "approve"
    return "cancel"


def _codex_approval_result_message(approval, choice):
    approval = approval if isinstance(approval, dict) else {}
    normalized = _normalize_codex_approval_choice(choice)
    status = "approved" if normalized == "approve" else "cancelled"
    return {
        "role": "assistant",
        "text": "",
        "ts": int(time.time() * 1000),
        "agentId": approval.get("agentId") or "codex-default",
        "approval": {**approval, "status": status, "resolvedAt": int(time.time() * 1000), "choice": normalized},
        "tools": [],
        "thinking": "",
        "reasoningTokens": 0,
    }


def _history_has_approval(messages, approval_id):
    approval_id = str(approval_id or "")
    if not approval_id:
        return False
    for msg in messages or []:
        approval = msg.get("approval") if isinstance(msg, dict) and isinstance(msg.get("approval"), dict) else {}
        if approval_id in {str(approval.get("id") or ""), str(approval.get("approval_id") or "")}:
            return True
    return False


def _hermes_history_path(profile="default"):
    safe_profile = re.sub(r"[^a-zA-Z0-9_.-]+", "-", profile or "default")[:80] or "default"
    return os.path.join(STATUS_DIR, f"hermes-chat-{safe_profile}.json")


def _load_hermes_history(profile="default"):
    path = _hermes_history_path(profile)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        messages = data.get("messages", []) if isinstance(data, dict) else []
        return messages if isinstance(messages, list) else []
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []


def _load_hermes_state(profile="default"):
    path = _hermes_history_path(profile)
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {"profile": profile, "messages": []}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"profile": profile, "messages": []}


def _save_hermes_state(profile, state):
    path = _hermes_history_path(profile)
    data = state if isinstance(state, dict) else {}
    data["profile"] = profile
    data.setdefault("messages", [])
    data["updatedAt"] = int(time.time() * 1000)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    try:
        os.chmod(path, 0o666)
    except OSError:
        pass


def _save_hermes_history(profile, messages):
    path = _hermes_history_path(profile)
    try:
        existing = _load_hermes_state(profile)
        existing["profile"] = profile
        existing["messages"] = messages[-500:]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(existing, f, indent=2)
        try:
            os.chmod(path, 0o666)
        except OSError:
            pass
    except OSError as e:
        print(f"[HERMES] Failed to save history: {e}")


def _get_hermes_session_id(profile="default"):
    state = _load_hermes_state(profile)
    session_id = state.get("sessionId") or state.get("session_id")
    return str(session_id).strip() if session_id else ""


def _set_hermes_session_id(profile="default", session_id=""):
    path = _hermes_history_path(profile)
    state = _load_hermes_state(profile)
    state["profile"] = profile
    if session_id:
        state["sessionId"] = session_id
    else:
        state.pop("sessionId", None)
        state.pop("session_id", None)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(state, f, indent=2)
        try:
            os.chmod(path, 0o666)
        except OSError:
            pass
    except OSError as e:
        print(f"[HERMES] Failed to save session id: {e}")


def _jsonish(value):
    if value in (None, ""):
        return {}
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {"value": value}
    return {"value": value}


def _extract_hermes_turn_activity(exported_session, user_content):
    """Convert public Hermes session export messages into chat activity cards."""
    if not isinstance(exported_session, dict):
        return {"tools": [], "thinking": "", "reasoningTokens": 0}
    messages = exported_session.get("messages") or []
    if not isinstance(messages, list):
        return {"tools": [], "thinking": "", "reasoningTokens": int(exported_session.get("reasoning_tokens") or 0)}

    start_idx = -1
    needle = str(user_content or "").strip()
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i] if isinstance(messages[i], dict) else {}
        if msg.get("role") == "user" and (not needle or str(msg.get("content") or "").strip() == needle):
            start_idx = i
            break
    turn = messages[start_idx + 1:] if start_idx >= 0 else messages[-8:]

    pending: dict[str, dict] = {}
    tools: list[dict] = []
    thinking_parts: list[str] = []

    for msg in turn:
        if not isinstance(msg, dict):
            continue
        reasoning = msg.get("reasoning") or msg.get("reasoning_content")
        if isinstance(reasoning, str) and reasoning.strip():
            thinking_parts.append(reasoning.strip())
        details = msg.get("reasoning_details")
        if isinstance(details, list):
            for item in details:
                if isinstance(item, dict):
                    txt = item.get("text") or item.get("summary")
                    if isinstance(txt, str) and txt.strip():
                        thinking_parts.append(txt.strip())

        for call in msg.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            fn = call.get("function") if isinstance(call.get("function"), dict) else {}
            call_id = str(call.get("id") or call.get("call_id") or "")
            tool = {
                "id": call_id,
                "status": "running",
                "name": fn.get("name") or call.get("name") or call.get("tool_name") or "tool",
                "arguments": _jsonish(fn.get("arguments") or call.get("arguments") or call.get("args") or {}),
                "result": "",
            }
            tools.append(tool)
            if call_id:
                pending[call_id] = tool

        if msg.get("role") == "tool":
            call_id = str(msg.get("tool_call_id") or "")
            tool = pending.get(call_id)
            if not tool:
                tool = {
                    "id": call_id,
                    "status": "done",
                    "name": msg.get("tool_name") or "tool result",
                    "arguments": {},
                    "result": "",
                }
                tools.append(tool)
            tool["status"] = "error" if msg.get("finish_reason") == "error" else "done"
            if msg.get("tool_name"):
                tool["name"] = msg.get("tool_name")
            tool["result"] = msg.get("content") or ""

    for tool in tools:
        if tool.get("status") == "running":
            tool["status"] = "done"
    return {
        "tools": tools[-40:],
        "thinking": "\n\n".join(dict.fromkeys(thinking_parts))[:12000],
        "reasoningTokens": int(exported_session.get("reasoning_tokens") or 0),
    }


HERMES_TASK_BREAKDOWN_STEPS = [
    "Receive message from Virtual Office",
    "Load Hermes profile and current session",
    "Run Hermes request through the selected profile",
    "Collect Hermes reply and public activity",
    "Render reply, tool calls, and task summary",
]

HERMES_APPROVAL_LOCK = threading.Lock()
HERMES_APPROVAL_PENDING = {}
HERMES_ACTIVE_RUNS_LOCK = threading.Lock()
HERMES_ACTIVE_RUNS = {}


def _remember_hermes_active_run(meta):
    if not isinstance(meta, dict) or not meta.get("runId"):
        return
    with HERMES_ACTIVE_RUNS_LOCK:
        HERMES_ACTIVE_RUNS[str(meta["runId"])] = dict(meta)


def _get_hermes_active_run(run_id):
    with HERMES_ACTIVE_RUNS_LOCK:
        meta = HERMES_ACTIVE_RUNS.get(str(run_id or ""))
        return dict(meta) if isinstance(meta, dict) else None


def _find_hermes_active_run(agent_key="", profile=""):
    with HERMES_ACTIVE_RUNS_LOCK:
        for meta in reversed(list(HERMES_ACTIVE_RUNS.values())):
            if agent_key and agent_key in {meta.get("agentId"), meta.get("agentKey")}:
                return dict(meta)
            if profile and profile == meta.get("profile"):
                return dict(meta)
    return None


def _clear_hermes_active_run(run_id):
    with HERMES_ACTIVE_RUNS_LOCK:
        HERMES_ACTIVE_RUNS.pop(str(run_id or ""), None)


def _hermes_task_breakdown_tool(status="running", result=""):
    return {
        "id": "hermes-task-breakdown",
        "status": status,
        "name": "Hermes task breakdown",
        "arguments": {"willDo": HERMES_TASK_BREAKDOWN_STEPS},
        "result": result or "Running Hermes native API stream and collecting public activity.",
    }


def _publish_hermes_api_progress(profile, agent_id, run_id, tools=None, reasoning_parts=None, reply=""):
    """Publish in-flight native Hermes API events to the visible chat history."""
    if not run_id:
        return
    progress_id = f"hermes-api-progress-{run_id}"
    history = _load_hermes_history(profile)
    history = [
        msg for msg in history
        if not (isinstance(msg, dict) and msg.get("ephemeral") == "hermes-progress" and msg.get("progressId") == progress_id)
    ]
    history.append({
        "role": "assistant",
        "text": reply or "",
        "ts": int(time.time() * 1000),
        "agentId": agent_id,
        "ephemeral": "hermes-progress",
        "progressId": progress_id,
        "runId": run_id,
        "sessionId": _get_hermes_session_id(profile) or "",
        "tools": tools or [],
        "thinking": "\n\n".join(reasoning_parts or [])[:12000],
        "reasoningTokens": 0,
    })
    _save_hermes_history(profile, history)


def _remove_hermes_progress_messages(messages):
    return [m for m in messages if not (isinstance(m, dict) and m.get("ephemeral") == "hermes-progress")]


def _format_hermes_attachment_context(attachments):
    if not isinstance(attachments, list) or not attachments:
        return ""
    lines = [
        "Attachments provided by Virtual Office:",
        "Use these attachments when answering. Prefer the URL if the local path is not readable from your runtime.",
    ]
    for idx, item in enumerate(attachments, 1):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("filename") or f"attachment-{idx}").strip()
        path = str(item.get("path") or item.get("filePath") or "").strip()
        url = str(item.get("url") or item.get("mediaUrl") or "").strip()
        mime_type = str(item.get("mimeType") or item.get("contentType") or item.get("media_type") or "").strip()
        size = item.get("size") or item.get("bytes") or ""
        if path and not url:
            url = "/chat-media?path=" + urllib.parse.quote(path)
        if url.startswith("/"):
            url = f"http://127.0.0.1:{PORT}{url}"
        details = [f"{idx}. {name}"]
        if mime_type:
            details.append(f"type: {mime_type}")
        if size:
            details.append(f"size: {size} bytes")
        if path:
            details.append(f"path: {path}")
        if url:
            details.append(f"url: {url}")
        lines.append(" | ".join(details))
    return "\n".join(lines) if len(lines) > 2 else ""


def _hermes_run_history_limits():
    hermes_cfg = VO_CONFIG.get("hermes", {}) if isinstance(VO_CONFIG.get("hermes", {}), dict) else {}

    def _bounded_int(key, default, minimum, maximum):
        try:
            value = int(hermes_cfg.get(key, default))
        except (TypeError, ValueError):
            value = default
        return max(minimum, min(maximum, value))

    return {
        "maxMessages": _bounded_int("runHistoryMaxMessages", 160, 0, 500),
        "maxChars": _bounded_int("runHistoryMaxChars", 240000, 10000, 1000000),
        "maxMessageChars": _bounded_int("runHistoryMaxMessageChars", 24000, 1000, 200000),
    }


def _flatten_hermes_history_content(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                part_type = str(part.get("type") or "").strip().lower()
                if part_type in {"text", "input_text", "output_text"}:
                    parts.append(str(part.get("text") or ""))
                elif isinstance(part.get("content"), str):
                    parts.append(part.get("content") or "")
        return "\n".join(p.strip() for p in parts if str(p or "").strip())
    try:
        return json.dumps(content, ensure_ascii=False, default=str)
    except Exception:
        return str(content)


def _normalize_hermes_run_history_message(message, max_message_chars):
    if not isinstance(message, dict):
        return None
    role = str(message.get("role") or "").strip().lower()
    if role not in {"user", "assistant"}:
        return None
    content = _flatten_hermes_history_content(message.get("content")).strip()
    if not content:
        return None
    if len(content) > max_message_chars:
        content = content[:max_message_chars].rstrip() + "\n[truncated]"
    return {"role": role, "content": content}


def _limit_hermes_run_history(messages, max_messages, max_chars):
    if max_messages <= 0 or max_chars <= 0:
        return []
    tail = messages[-max_messages:]
    selected = []
    total_chars = 0
    for item in reversed(tail):
        content = str(item.get("content") or "")
        item_chars = len(content)
        if selected and total_chars + item_chars > max_chars:
            break
        if not selected and item_chars > max_chars:
            item = {**item, "content": content[:max_chars].rstrip() + "\n[truncated]"}
            item_chars = len(item["content"])
        selected.append(item)
        total_chars += item_chars
    selected.reverse()
    return selected


def _load_hermes_run_conversation_history(client, session_id):
    """Load persisted Hermes context for /v1/runs without reading private state.db."""
    session_id = str(session_id or "").strip()
    if not session_id:
        return [], ""

    try:
        result = client.get_session_messages(session_id)
    except Exception as exc:
        print(f"[HERMES] Failed to load run history for {session_id}: {exc}")
        return [], session_id

    if not result.get("ok"):
        if not result.get("notFound"):
            print(f"[HERMES] Failed to load run history for {session_id}: {result.get('error') or 'unknown error'}")
        return [], session_id

    raw_messages = result.get("data") if isinstance(result.get("data"), list) else []
    limits = _hermes_run_history_limits()
    normalized = [
        item for item in (
            _normalize_hermes_run_history_message(msg, limits["maxMessageChars"])
            for msg in raw_messages
        )
        if item
    ]
    history = _limit_hermes_run_history(normalized, limits["maxMessages"], limits["maxChars"])
    resolved_session_id = str(result.get("session_id") or session_id).strip() or session_id
    if history:
        print(f"[HERMES] Loaded {len(history)} prior run-history messages for session {resolved_session_id}")
    return history, resolved_session_id


def _hermes_tool_activity_messages(tools, agent_id="", run_id="", base_ts=None, coerce_complete=False):
    """Store Hermes tools like OpenClaw recovered activity: one tool-only message per card."""
    if not isinstance(tools, list) or not tools:
        return []
    start_ts = int(base_ts if base_ts is not None else time.time() * 1000)
    messages = []
    for idx, tool in enumerate(tools):
        if not isinstance(tool, dict):
            continue
        item = dict(tool)
        item["runId"] = item.get("runId") or run_id or ""
        status = str(item.get("status") or "").lower()
        if coerce_complete and status == "running":
            item["status"] = "done"
            if not item.get("result") or str(item.get("result")).strip().lower() == "running":
                item["result"] = "Completed"
        messages.append({
            "role": "assistant",
            "text": "",
            "ts": start_ts + idx,
            "agentId": agent_id,
            "runId": item.get("runId") or run_id or "",
            "tools": [item],
            "source": "hermes-tool-activity",
        })
    return messages


def _hermes_approval_key(agent_id="", profile="", session_id=""):
    if session_id:
        return f"session:{session_id}"
    if profile:
        return f"profile:{profile}"
    return f"agent:{agent_id or 'hermes-default'}"


def _normalize_hermes_approval_choice(choice):
    choice = str(choice or "").strip().lower()
    return {
        "once": "approve_once",
        "allow_once": "approve_once",
        "approve": "approve_once",
        "approved_once": "approve_once",
        "no": "deny",
        "denied": "deny",
    }.get(choice, choice)


def _remember_hermes_approval_pending(approval, agent_id="", profile="", session_id=""):
    if not isinstance(approval, dict):
        return None
    approval = dict(approval)
    approval_id = approval.get("approval_id") or approval.get("id")
    if approval_id:
        approval["id"] = approval_id
        approval["approval_id"] = approval_id
    approval["session_id"] = approval.get("session_id") or session_id or ""
    approval["agentId"] = approval.get("agentId") or agent_id or "hermes-default"
    approval["profile"] = approval.get("profile") or profile or ""
    approval["queuedAt"] = approval.get("queuedAt") or int(time.time() * 1000)
    approval["status"] = approval.get("status") or "pending"
    key = _hermes_approval_key(approval.get("agentId"), approval.get("profile"), approval.get("session_id"))
    with HERMES_APPROVAL_LOCK:
        queue = HERMES_APPROVAL_PENDING.setdefault(key, [])
        existing_idx = next((i for i, item in enumerate(queue) if item.get("id") == approval.get("id")), None)
        if existing_idx is None:
            queue.append(approval)
        else:
            queue[existing_idx] = {**queue[existing_idx], **approval}
        return approval


def _get_hermes_approval_pending(agent_key="hermes-default", session_id=""):
    agent = _get_hermes_agent(agent_key) or {}
    agent_id = agent.get("id") or agent_key or "hermes-default"
    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
    keys = [
        _hermes_approval_key(agent_id, profile, session_id),
        _hermes_approval_key(agent_id, profile, ""),
        _hermes_approval_key(agent_id, "", ""),
    ]
    with HERMES_APPROVAL_LOCK:
        for key in dict.fromkeys(keys):
            queue = [item for item in HERMES_APPROVAL_PENDING.get(key, []) if item.get("status", "pending") == "pending"]
            HERMES_APPROVAL_PENDING[key] = queue
            if queue:
                return {"ok": True, "pending": queue[0], "pending_count": len(queue), "session_id": session_id or queue[0].get("session_id", "")}
        for key, items in list(HERMES_APPROVAL_PENDING.items()):
            queue = [
                item for item in items
                if item.get("status", "pending") == "pending"
                and (item.get("agentId") == agent_id or item.get("profile") == profile)
            ]
            HERMES_APPROVAL_PENDING[key] = queue
            if queue:
                return {"ok": True, "pending": queue[0], "pending_count": len(queue), "session_id": session_id or queue[0].get("session_id", "")}
    return {"ok": True, "pending": None, "pending_count": 0, "session_id": session_id or ""}


def _resolve_hermes_approval_pending(agent_key="hermes-default", approval_id="", session_id="", choice=""):
    agent = _get_hermes_agent(agent_key) or {}
    agent_id = agent.get("id") or agent_key or "hermes-default"
    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
    keys = [
        _hermes_approval_key(agent_id, profile, session_id),
        _hermes_approval_key(agent_id, profile, ""),
        _hermes_approval_key(agent_id, "", ""),
    ]
    with HERMES_APPROVAL_LOCK:
        for key in dict.fromkeys(keys):
            queue = HERMES_APPROVAL_PENDING.get(key, [])
            for idx, item in enumerate(queue):
                if not approval_id or item.get("id") == approval_id or item.get("approval_id") == approval_id:
                    resolved = {**item, "status": choice or "resolved", "resolvedAt": int(time.time() * 1000)}
                    del queue[idx]
                    HERMES_APPROVAL_PENDING[key] = queue
                    return resolved
        for key, queue in list(HERMES_APPROVAL_PENDING.items()):
            for idx, item in enumerate(queue):
                if (
                    (item.get("agentId") == agent_id or item.get("profile") == profile)
                    and (not approval_id or item.get("id") == approval_id or item.get("approval_id") == approval_id)
                ):
                    resolved = {**item, "status": choice or "resolved", "resolvedAt": int(time.time() * 1000)}
                    del queue[idx]
                    HERMES_APPROVAL_PENDING[key] = queue
                    return resolved
    return None


def _detect_hermes_approval_request(reply="", stderr="", original_message="", agent_key="hermes-default"):
    text = f"{reply or ''}\n{stderr or ''}"
    lower = text.lower()
    approval_markers = (
        "blocked: user denied",
        "approval required",
        "requires approval",
        "dangerous command",
        "command approval",
        "permission prompt",
        "approval prompt",
    )
    if not any(marker in lower for marker in approval_markers):
        return None
    command = ""
    command_patterns = [
        r"`([^`\n]{3,500})`",
        r"command(?: was)?[:\s]+([^\n]{3,500})",
    ]
    for pattern in command_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            candidate = match.group(1).strip()
            if candidate and "BLOCKED:" not in candidate:
                command = candidate[:500]
                break
    seed = f"{agent_key}:{original_message}:{command}:{int(time.time() // 60)}"
    approval_id = "hermes-approval-" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]
    return {
        "id": approval_id,
        "approval_id": approval_id,
        "provider": "hermes",
        "status": "pending",
        "kind": "command",
        "title": "Hermes approval required",
        "description": "Hermes needs permission to retry this turn with approval bypass for this invocation only.",
        "command": command or "Approval-gated Hermes command",
        "message": original_message,
        "agentId": agent_key,
        "choices": ["approve_once", "deny"],
    }


def _approval_result_message(approval, choice):
    label = "approved once and retried" if choice == "approve_once" else "denied"
    return {
        "role": "assistant",
        "text": "",
        "ts": int(time.time() * 1000),
        "agentId": approval.get("agentId") or "hermes-default",
        "approval": {**approval, "status": label, "resolvedAt": int(time.time() * 1000)},
        "tools": [],
        "thinking": "",
        "reasoningTokens": 0,
    }


def _hermes_api_client():
    hermes_cfg = VO_CONFIG.get("hermes", {})
    return HermesApiClient(
        base_url=hermes_cfg.get("apiUrl"),
        api_key=hermes_cfg.get("apiKey"),
        timeout_sec=min(int(hermes_cfg.get("timeoutSec") or 600), 60),
    )


def _hermes_desktop_client():
    hermes_cfg = VO_CONFIG.get("hermes", {})
    return HermesDesktopBackendClient(
        base_url=hermes_cfg.get("desktopUrl"),
        token=hermes_cfg.get("desktopToken"),
        host_header=hermes_cfg.get("desktopHostHeader"),
        tcp_host=hermes_cfg.get("desktopTcpHost"),
        tcp_port=hermes_cfg.get("desktopTcpPort"),
        timeout_sec=min(int(hermes_cfg.get("timeoutSec") or 600), 60),
    )


HERMES_PROFILE_API_LOCK = threading.Lock()
HERMES_PROFILE_API_PROCESSES = {}


def _parse_url_port(url, default=8642):
    try:
        parsed = urllib.parse.urlparse(str(url or ""))
        return int(parsed.port or default)
    except Exception:
        return default


def _is_local_http_url(url):
    try:
        parsed = urllib.parse.urlparse(str(url or ""))
        return parsed.scheme in {"http", "https"} and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    except Exception:
        return False


def _hermes_profile_api_port(profile):
    hermes_cfg = VO_CONFIG.get("hermes", {})
    base = hermes_cfg.get("apiProfilePortBase") or os.environ.get("VO_HERMES_API_PROFILE_PORT_BASE")
    try:
        base = int(base)
    except (TypeError, ValueError):
        base = _parse_url_port(hermes_cfg.get("apiUrl"), 8642) + 1
    digest = hashlib.sha1(str(profile or "default").encode("utf-8")).hexdigest()
    return base + (int(digest[:6], 16) % 1000)


def _hermes_profile_api_config(profile):
    hermes_cfg = VO_CONFIG.get("hermes", {})
    profile_cfgs = hermes_cfg.get("apiProfiles") if isinstance(hermes_cfg.get("apiProfiles"), dict) else {}
    profile_cfg = profile_cfgs.get(profile) if isinstance(profile_cfgs.get(profile), dict) else {}
    auto_start_all = hermes_cfg.get("autoStartProfileApis", True) is not False
    if profile == "default":
        url = profile_cfg.get("apiUrl") or hermes_cfg.get("apiUrl") or f"http://127.0.0.1:{_hermes_profile_api_port(profile)}"
        auto_start = profile_cfg.get("autoStart", hermes_cfg.get("autoStartDefaultApi", auto_start_all)) is not False
        return {
            "url": url,
            "key": profile_cfg.get("apiKey") or hermes_cfg.get("apiKey"),
            "autoStart": bool(auto_start and _is_local_http_url(url)),
            "port": _parse_url_port(url, 8642),
        }
    port = _hermes_profile_api_port(profile)
    url = profile_cfg.get("apiUrl") or f"http://127.0.0.1:{port}"
    auto_start = profile_cfg.get("autoStart", auto_start_all) is not False
    return {
        "url": url,
        "key": profile_cfg.get("apiKey") or hermes_cfg.get("apiKey"),
        "autoStart": bool(auto_start and _is_local_http_url(url)),
        "port": _parse_url_port(url, port),
    }


def _hermes_api_client_for_profile(profile):
    profile = profile or "default"
    cfg = _hermes_profile_api_config(profile)
    if cfg.get("autoStart"):
        _ensure_hermes_profile_api(profile, cfg)
    return HermesApiClient(
        base_url=cfg.get("url"),
        api_key=cfg.get("key"),
        timeout_sec=min(int(VO_CONFIG.get("hermes", {}).get("timeoutSec") or 600), 60),
    )


def _ensure_hermes_profile_api(profile, api_cfg):
    """Start a profile-scoped Hermes API server when one is not already up."""
    if not profile:
        return
    api_key = api_cfg.get("key") or ""
    if not api_key or not api_cfg.get("autoStart") or not _is_local_http_url(api_cfg.get("url")):
        return
    client = HermesApiClient(
        base_url=api_cfg.get("url"),
        api_key=api_key,
        timeout_sec=5,
    )
    if client.is_available():
        return

    with HERMES_PROFILE_API_LOCK:
        proc = HERMES_PROFILE_API_PROCESSES.get(profile)
        if proc and proc.poll() is None:
            return

        hermes_cfg = VO_CONFIG.get("hermes", {})
        hermes_bin = os.path.expanduser(hermes_cfg.get("binary") or "~/.local/bin/hermes")
        hermes_home = os.path.expanduser(hermes_cfg.get("homePath") or "~/.hermes")
        if not os.path.exists(hermes_bin):
            return

        env = os.environ.copy()
        env.update({
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": "127.0.0.1",
            "API_SERVER_PORT": str(api_cfg.get("port") or _parse_url_port(api_cfg.get("url"), 8642)),
            "API_SERVER_KEY": api_key,
            "API_SERVER_MODEL_NAME": f"hermes-{HermesProvider._safe_suffix(profile)}",
            "VO_HERMES_HOME": hermes_home,
        })
        if os.path.basename(hermes_home.rstrip(os.sep)) == ".hermes":
            env["HOME"] = os.path.dirname(hermes_home.rstrip(os.sep)) or env.get("HOME", "")

        log_path = os.path.join(STATUS_DIR, f"hermes-api-{HermesProvider._safe_suffix(profile)}.log")
        try:
            log_f = open(log_path, "ab", buffering=0)
            cmd = [hermes_bin]
            if profile != "default":
                cmd.extend(["--profile", profile])
            cmd.extend(["gateway", "run"])
            proc = subprocess.Popen(
                cmd,
                stdout=log_f,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                env=env,
                start_new_session=True,
            )
            HERMES_PROFILE_API_PROCESSES[profile] = proc
        except Exception as exc:
            print(f"⚠️ Hermes profile API start failed for {profile}: {exc}")
            return

    deadline = time.time() + 15
    while time.time() < deadline:
        try:
            if client.is_available():
                return
        except Exception:
            pass
        proc = HERMES_PROFILE_API_PROCESSES.get(profile)
        if proc and proc.poll() is not None:
            return
        time.sleep(0.5)


def _hermes_event_tool_card(event, status="running", fallback_id=""):
    tool = str(event.get("tool") or event.get("name") or event.get("tool_name") or "Hermes tool")
    preview = str(event.get("preview") or event.get("label") or "")
    duration = event.get("duration")
    result = "Running" if status == "running" else "Completed"
    if event.get("error"):
        result = "Failed"
    if duration is not None and status != "running":
        result = f"{result} in {duration}s"
    card = {
        "id": str(event.get("toolCallId") or event.get("tool_call_id") or event.get("id") or fallback_id or f"hermes-tool-{int(time.time() * 1000)}"),
        "name": tool,
        "status": status,
        "args_preview": preview,
        "result": result,
    }
    if preview:
        card["arguments"] = {"command": preview}
    return card


def _hermes_api_approval_from_event(event, agent_id="", profile="", session_id="", original_message=""):
    command = str(event.get("command") or event.get("preview") or event.get("tool") or "Hermes approval request")
    description = str(event.get("description") or "Hermes needs approval before it can continue this run.")
    run_id = str(event.get("run_id") or "")
    seed = f"{agent_id}|{profile}|{session_id}|{run_id}|{command}|{original_message}"
    approval_id = "hermes-api-approval-" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]
    return {
        "id": approval_id,
        "approval_id": approval_id,
        "provider": "hermes-api",
        "kind": "dangerous_command",
        "title": "Hermes approval required",
        "description": description,
        "command": command,
        "message": original_message,
        "agentId": agent_id or "hermes-default",
        "profile": profile or "default",
        "session_id": session_id or "",
        "runId": run_id,
        "choices": event.get("choices") or ["once", "deny"],
        "status": "pending",
        "createdAt": int(time.time() * 1000),
    }


def _build_hermes_delivery_message(agent, agent_key, message, body):
    from_type = str(body.get("fromType") or body.get("senderType") or "").strip().lower()
    is_human_source = from_type in {"human", "user", "chat", "ui"}
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    attachment_context = _format_hermes_attachment_context(attachments)
    source_app = str(body.get("sourceApp") or body.get("app") or "virtual-office").strip() or "virtual-office"
    source_surface = str(body.get("sourceSurface") or body.get("surface") or "chat-window").strip() or "chat-window"
    source_label = str(body.get("sourceLabel") or "").strip()
    sender_name = str(body.get("fromDisplayName") or body.get("displayName") or body.get("fromName") or "User").strip() or "User"
    delivery_message = message
    if is_human_source:
        pretty_surface = source_label or ("Virtual Office Chat" if source_app == "virtual-office" and source_surface in {"chat-window", "chat"} else f"{source_app.replace('-', ' ').title()} {source_surface.replace('-', ' ').title()}".strip())
        delivery_message = (
            f"[A2A from=user name={json.dumps(sender_name)} to={agent.get('id') or agent_key} isUser=true sourceApp={json.dumps(source_app)} sourceSurface={json.dumps(source_surface)}]\n"
            f"Message from {sender_name} via {pretty_surface}.\n\n"
            f"{message}\n\n"
            "Reply directly to the user. Do not assume the user's name unless they identify themselves."
        )
    if attachment_context:
        delivery_message = f"{delivery_message}\n\n{attachment_context}"
    return {
        "deliveryMessage": delivery_message,
        "fromType": from_type,
        "isHumanSource": is_human_source,
        "attachments": attachments,
        "sourceApp": source_app,
        "sourceSurface": source_surface,
        "sourceLabel": source_label,
        "senderName": sender_name,
    }


def _handle_hermes_api_chat(agent, profile, delivery_message, original_message, timeout):
    """Run a Hermes turn through the native Hermes API Server + SSE events."""
    agent_id = agent.get("id") or agent.get("statusKey") or "hermes-default"
    status_key = agent.get("statusKey") or agent_id
    client = _hermes_api_client_for_profile(profile)
    if not client.is_available():
        return {"ok": False, "fallback": True, "error": "Hermes API Server is not available"}

    session_id = _get_hermes_session_id(profile) or f"vo-hermes-{HermesProvider._safe_suffix(profile)}"
    session_key = f"virtual-office:hermes:{profile}"
    conversation_history, session_id = _load_hermes_run_conversation_history(client, session_id)
    started = client.start_run(
        delivery_message,
        session_id=session_id,
        session_key=session_key,
        conversation_history=conversation_history,
    )
    run_id = started.get("run_id")
    if not run_id:
        return {"ok": False, "fallback": True, "error": started.get("error") or "Hermes API did not return a run_id"}

    _set_hermes_session_id(profile, session_id)
    gateway_presence.set_provider_event(status_key, "hermes", {"event": "run.started", "run_id": run_id})

    reply = ""
    reasoning_parts = []
    tools = []
    started_tools = {}
    started_tool_keys = {}
    tool_seq = 0
    approval = None
    terminal_event = None
    error_text = ""
    last_progress_publish = 0.0

    def publish_progress(force=False):
        nonlocal last_progress_publish
        now = time.time()
        if force or now - last_progress_publish >= 0.25:
            _publish_hermes_api_progress(profile, agent_id, run_id, tools=tools, reasoning_parts=reasoning_parts, reply=reply)
            last_progress_publish = now

    publish_progress(force=True)

    try:
        for event in client.stream_run_events(run_id, timeout_sec=int(timeout) + 30):
            gateway_presence.set_provider_event(status_key, "hermes", event)
            event_name = str(event.get("event") or "").lower()
            if event_name == "message.delta":
                reply += str(event.get("delta") or "")
                publish_progress()
            elif event_name == "reasoning.available":
                text = str(event.get("text") or "")
                if text:
                    reasoning_parts.append(text)
                    publish_progress(force=True)
            elif event_name == "tool.started":
                tool_seq += 1
                fallback_id = f"{run_id}:tool:{tool_seq}"
                card = _hermes_event_tool_card(event, "running", fallback_id=fallback_id)
                event_tool_key = f"{event.get('tool') or event.get('name') or 'tool'}:{event.get('preview') or event.get('label') or ''}"
                started_tool_keys[event_tool_key] = card["id"]
                started_tools[card["id"]] = card
                tools.append(card)
                publish_progress(force=True)
            elif event_name in {"tool.completed", "tool.failed"}:
                event_tool_key = f"{event.get('tool') or event.get('name') or 'tool'}:{event.get('preview') or event.get('label') or ''}"
                fallback_id = started_tool_keys.get(event_tool_key)
                if not fallback_id:
                    matching_id = next((tid for tid, item in reversed(list(started_tools.items())) if item.get("name") == (event.get("tool") or event.get("name"))), "")
                    fallback_id = matching_id or f"{run_id}:tool:{len(started_tools) + 1}"
                card = _hermes_event_tool_card(event, "done" if event_name == "tool.completed" else "error", fallback_id=fallback_id)
                if card["id"] in started_tools:
                    started_tools[card["id"]].update(card)
                else:
                    tools.append(card)
                publish_progress(force=True)
            elif event_name == "approval.request":
                approval = _remember_hermes_approval_pending(
                    _hermes_api_approval_from_event(event, agent_id=agent_id, profile=profile, session_id=session_id, original_message=original_message),
                    agent_id=agent_id,
                    profile=profile,
                    session_id=session_id,
                )
                publish_progress(force=True)
                continue
            elif event_name in {"run.completed", "run.failed", "run.cancelled", "run.canceled"}:
                terminal_event = event
                if event.get("output"):
                    reply = str(event.get("output") or reply)
                if event.get("error"):
                    error_text = str(event.get("error") or "")
                if event_name == "run.completed":
                    approval = None
                publish_progress(force=True)
                break
    except Exception as exc:
        gateway_presence.set_provider_event(status_key, "hermes", {"event": "run.failed", "run_id": run_id, "error": str(exc)})
        return {"ok": False, "error": str(exc), "providerPath": "api", "runId": run_id}

    terminal_name = str((terminal_event or {}).get("event") or "").lower()
    ok = terminal_name == "run.completed"
    if approval:
        ok = False
        error_text = "Hermes is waiting for approval."
    elif terminal_name in {"run.failed", "run.cancelled", "run.canceled"}:
        ok = False
        error_text = error_text or terminal_name.replace("run.", "Hermes run ")

    thinking = "\n\n".join(reasoning_parts)
    if thinking.strip() == reply.strip():
        thinking = ""

    return {
        "ok": ok,
        "reply": reply,
        "stderr": "",
        "exitCode": 0 if ok else 1,
        "sessionId": session_id,
        "runId": run_id,
        "tools": tools,
        "thinking": thinking,
        "reasoningTokens": 0,
        "approval": approval,
        "error": error_text or None,
        "providerPath": "api",
    }


def _handle_hermes_desktop_chat(agent, profile, delivery_message, timeout):
    """Run a Hermes turn through Desktop's `hermes serve` TUI-gateway backend."""
    hermes_cfg = VO_CONFIG.get("hermes", {})
    desktop_url = agent.get("desktopUrl") or hermes_cfg.get("desktopUrl")
    if not desktop_url:
        return {"ok": False, "fallback": True, "error": "Hermes Desktop Backend URL is not configured"}

    client = HermesDesktopBackendClient(
        base_url=desktop_url,
        token=hermes_cfg.get("desktopToken"),
        host_header=hermes_cfg.get("desktopHostHeader"),
        tcp_host=hermes_cfg.get("desktopTcpHost"),
        tcp_port=hermes_cfg.get("desktopTcpPort"),
        timeout_sec=min(int(timeout or hermes_cfg.get("timeoutSec") or 600), 60),
    )
    status = client.test(verify_ws=False)
    if not status.get("ok"):
        return {"ok": False, "fallback": True, "error": status.get("error") or "Hermes Desktop Backend is not reachable"}
    if status.get("authRequired"):
        return {"ok": False, "fallback": True, "error": "Hermes Desktop Backend is reachable but requires dashboard authentication"}

    result = client.send_chat_message(
        delivery_message,
        session_id=_get_hermes_session_id(profile),
        timeout_sec=int(timeout or hermes_cfg.get("timeoutSec") or 600),
    )
    result["providerPath"] = "desktop"
    result["fallback"] = bool((not result.get("ok")) and (not result.get("reply")))
    return result


def _handle_hermes_desktop_run_start(agent, agent_key, profile, body, timeout):
    """Register a Desktop Backend run that will stream over /api/hermes/runs/<id>/events."""
    hermes_cfg = VO_CONFIG.get("hermes", {})
    desktop_url = agent.get("desktopUrl") or hermes_cfg.get("desktopUrl")
    if not desktop_url:
        return {"ok": False, "fallback": True, "error": "Hermes Desktop Backend URL is not configured", "_status": 409}

    client = HermesDesktopBackendClient(
        base_url=desktop_url,
        token=hermes_cfg.get("desktopToken"),
        host_header=agent.get("desktopHostHeader") or hermes_cfg.get("desktopHostHeader"),
        tcp_host=agent.get("desktopTcpHost") or hermes_cfg.get("desktopTcpHost"),
        tcp_port=agent.get("desktopTcpPort") or hermes_cfg.get("desktopTcpPort"),
        timeout_sec=min(int(timeout or hermes_cfg.get("timeoutSec") or 600), 60),
    )
    status = client.test(verify_ws=True)
    if not status.get("ok") or not status.get("chatReady"):
        return {"ok": False, "fallback": True, "error": status.get("error") or "Hermes Desktop Backend WebSocket is not ready", "_status": 409}
    if status.get("authRequired"):
        return {"ok": False, "fallback": True, "error": "Hermes Desktop Backend is reachable but requires dashboard authentication", "_status": 409}

    delivery = _build_hermes_delivery_message(agent, agent_key, body.get("message") or "", body)
    now_ms = int(time.time() * 1000)
    run_seed = f"{profile}|{agent_key}|{now_ms}|{delivery.get('deliveryMessage') or ''}"
    run_id = "hermes-desktop-" + hashlib.sha1(run_seed.encode("utf-8")).hexdigest()[:16]
    agent_id = agent.get("id") or agent_key
    session_id = _get_hermes_session_id(profile) or ""

    history = _load_hermes_history(profile)
    history.append({
        "role": "user",
        "text": body.get("message") or "",
        "ts": now_ms,
        "agentId": agent_id,
        "from": delivery["senderName"] if delivery["isHumanSource"] else "You",
        "fromType": delivery["fromType"] or "",
        "sourceApp": delivery["sourceApp"] if delivery["isHumanSource"] else "",
        "sourceSurface": delivery["sourceSurface"] if delivery["isHumanSource"] else "",
        "sourceLabel": delivery["sourceLabel"] if delivery["isHumanSource"] else "",
        "attachments": delivery["attachments"],
    })
    _save_hermes_history(profile, history)

    _remember_hermes_active_run({
        "runId": run_id,
        "providerPath": "desktop",
        "sessionId": session_id,
        "agentId": agent_id,
        "agentKey": agent_key,
        "statusKey": agent.get("statusKey") or agent_id,
        "profile": profile,
        "message": body.get("message") or "",
        "deliveryMessage": delivery["deliveryMessage"],
        "timeoutSec": timeout,
        "startedAt": now_ms,
        "desktopUrl": desktop_url,
    })
    gateway_presence.set_provider_event(agent.get("statusKey") or agent_id, "hermes", {"event": "run.started", "run_id": run_id, "providerPath": "desktop"})
    _publish_hermes_api_progress(profile, agent_id, run_id, tools=[], reasoning_parts=[], reply="")
    return {
        "ok": True,
        "providerPath": "desktop",
        "runId": run_id,
        "sessionId": session_id,
        "agent": {"id": agent_id, "name": agent.get("name"), "providerKind": "hermes", "profile": profile},
    }


def _handle_hermes_run_start(body):
    """Start a native Hermes API run and return the run id for browser SSE attach."""
    message = (body.get("message") or "").strip()
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "hermes-default"
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}

    agent = _get_hermes_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Hermes agent '{agent_key}' not found", "_status": 404}
    if _is_hermes_gateway_platform_agent(agent):
        return {
            "ok": False,
            "fallback": True,
            "providerPath": "gateway-platform",
            "error": "Hermes Gateway Platform uses the queued messaging bridge",
            "_status": 409,
        }

    hermes_cfg = VO_CONFIG.get("hermes", {})
    timeout = int(body.get("timeoutSec") or hermes_cfg.get("timeoutSec") or 600)
    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
    desktop_configured = bool(agent.get("desktopUrl") or hermes_cfg.get("desktopUrl"))
    desktop_first = bool(desktop_configured and hermes_cfg.get("preferDesktop", True) is not False)
    desktop_error = ""

    if desktop_first:
        desktop_start = _handle_hermes_desktop_run_start(agent, agent_key, profile, body, timeout)
        if desktop_start.get("ok"):
            return desktop_start
        desktop_error = desktop_start.get("error") or ""

    if not hermes_cfg.get("preferApi", True):
        return {
            "ok": False,
            "fallback": True,
            "error": desktop_error or "Hermes native API is disabled by configuration",
            "_status": 409,
        }

    client = _hermes_api_client_for_profile(profile)
    if not client.is_available():
        if desktop_configured and not desktop_first:
            desktop_start = _handle_hermes_desktop_run_start(agent, agent_key, profile, body, timeout)
            if desktop_start.get("ok"):
                return desktop_start
            desktop_error = desktop_start.get("error") or desktop_error
        return {"ok": False, "fallback": True, "error": desktop_error or "Hermes API Server is not available", "_status": 409}

    delivery = _build_hermes_delivery_message(agent, agent_key, message, body)
    now_ms = int(time.time() * 1000)
    history = _load_hermes_history(profile)
    history.append({
        "role": "user",
        "text": message,
        "ts": now_ms,
        "agentId": agent.get("id"),
        "from": delivery["senderName"] if delivery["isHumanSource"] else "You",
        "fromType": delivery["fromType"] or "",
        "sourceApp": delivery["sourceApp"] if delivery["isHumanSource"] else "",
        "sourceSurface": delivery["sourceSurface"] if delivery["isHumanSource"] else "",
        "sourceLabel": delivery["sourceLabel"] if delivery["isHumanSource"] else "",
        "attachments": delivery["attachments"],
    })
    _save_hermes_history(profile, history)

    session_id = _get_hermes_session_id(profile) or f"vo-hermes-{HermesProvider._safe_suffix(profile)}"
    session_key = f"virtual-office:hermes:{profile}"
    conversation_history, session_id = _load_hermes_run_conversation_history(client, session_id)
    started = client.start_run(
        delivery["deliveryMessage"],
        session_id=session_id,
        session_key=session_key,
        conversation_history=conversation_history,
    )
    run_id = started.get("run_id") or started.get("runId") or started.get("id")
    if not run_id:
        return {"ok": False, "fallback": True, "error": started.get("error") or "Hermes API did not return a run_id", "_status": 502}

    _set_hermes_session_id(profile, session_id)
    _remember_hermes_active_run({
        "runId": run_id,
        "sessionId": session_id,
        "agentId": agent.get("id") or agent_key,
        "agentKey": agent_key,
        "statusKey": agent.get("statusKey") or agent.get("id") or agent_key,
        "profile": profile,
        "message": message,
        "deliveryMessage": delivery["deliveryMessage"],
        "timeoutSec": timeout,
        "startedAt": now_ms,
    })
    gateway_presence.set_provider_event(agent.get("statusKey") or agent.get("id"), "hermes", {"event": "run.started", "run_id": run_id})
    _publish_hermes_api_progress(profile, agent.get("id") or agent_key, run_id, tools=[], reasoning_parts=[], reply="")
    return {
        "ok": True,
        "providerPath": "api",
        "runId": run_id,
        "sessionId": session_id,
        "agent": {"id": agent.get("id"), "name": agent.get("name"), "providerKind": "hermes", "profile": profile},
    }


def _handle_hermes_desktop_run_events(handler, run_id, meta):
    """Stream an already-registered Hermes Desktop Backend run to the browser."""
    profile = meta.get("profile") or "default"
    agent = _get_hermes_agent(meta.get("agentId") or meta.get("agentKey") or f"hermes-{profile}") or {}
    agent_id = agent.get("id") or meta.get("agentId") or "hermes-default"
    status_key = agent.get("statusKey") or meta.get("statusKey") or agent_id
    session_id = meta.get("sessionId") or _get_hermes_session_id(profile) or ""
    timeout = int(meta.get("timeoutSec") or VO_CONFIG.get("hermes", {}).get("timeoutSec") or 600)
    hermes_cfg = VO_CONFIG.get("hermes", {})
    client = HermesDesktopBackendClient(
        base_url=meta.get("desktopUrl") or agent.get("desktopUrl") or hermes_cfg.get("desktopUrl"),
        token=hermes_cfg.get("desktopToken"),
        host_header=agent.get("desktopHostHeader") or hermes_cfg.get("desktopHostHeader"),
        tcp_host=agent.get("desktopTcpHost") or hermes_cfg.get("desktopTcpHost"),
        tcp_port=agent.get("desktopTcpPort") or hermes_cfg.get("desktopTcpPort"),
        timeout_sec=min(timeout, 60),
    )

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("X-Accel-Buffering", "no")
    handler.end_headers()

    client_connected = True

    def send_sse(event_name, payload):
        nonlocal client_connected
        if not client_connected:
            return False
        data = dict(payload or {})
        data.setdefault("event", event_name)
        data.setdefault("runId", run_id)
        data.setdefault("sessionId", session_id)
        data.setdefault("agentId", agent_id)
        data.setdefault("profile", profile)
        data.setdefault("providerPath", "desktop")
        try:
            handler.wfile.write(f"event: {event_name}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
            handler.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            client_connected = False
            return False

    reply = ""
    reasoning_text = ""
    tools = []
    tools_by_id = {}
    approval = None
    error_text = ""
    last_progress_publish = 0.0

    def publish_progress(force=False):
        nonlocal last_progress_publish
        now = time.time()
        if force or now - last_progress_publish >= 0.25:
            _publish_hermes_api_progress(profile, agent_id, run_id, tools=tools, reasoning_parts=[reasoning_text] if reasoning_text else [], reply=reply)
            last_progress_publish = now

    def upsert_tool(card):
        if not isinstance(card, dict):
            return None
        tool_id = str(card.get("id") or f"{run_id}:tool:{len(tools) + 1}")
        card["id"] = tool_id
        existing = tools_by_id.get(tool_id)
        if existing:
            existing.update(card)
            return existing
        tools_by_id[tool_id] = card
        tools.append(card)
        return card

    def handle_desktop_event(event_name, payload):
        nonlocal reply, reasoning_text
        payload = dict(payload or {})
        payload["providerPath"] = "desktop"
        payload["agentId"] = agent_id
        payload["profile"] = profile
        payload["runId"] = run_id
        gateway_presence.set_provider_event(status_key, "hermes", {**payload, "event": event_name, "run_id": run_id})

        if event_name == "message.delta":
            reply = str(payload.get("reply") or (reply + str(payload.get("delta") or "")))
            payload["reply"] = reply
        elif event_name == "reasoning.available":
            reasoning_text = str(payload.get("thinking") or payload.get("text") or reasoning_text)
            payload["thinking"] = reasoning_text
        elif event_name in {"tool.started", "tool.completed", "tool.failed"}:
            card = upsert_tool(payload.get("toolCard") if isinstance(payload.get("toolCard"), dict) else {})
            if card:
                payload["toolCard"] = card
        publish_progress(force=event_name != "message.delta")
        send_sse(event_name, payload)

    def finalize_history(ok=False):
        history = _remove_hermes_progress_messages(_load_hermes_history(profile))
        final_ts = int(time.time() * 1000)
        history.extend(_hermes_tool_activity_messages(
            tools,
            agent_id=agent_id,
            run_id=run_id,
            base_ts=final_ts,
            coerce_complete=bool(ok) and not approval,
        ))
        history.append({
            "role": "assistant",
            "text": reply,
            "ts": final_ts + len(tools),
            "agentId": agent_id,
            "exitCode": 0 if ok else 1,
            "sessionId": session_id,
            "runId": run_id,
            "tools": [],
            "thinking": "" if reasoning_text.strip() == reply.strip() else reasoning_text,
            "reasoningTokens": 0,
            "approval": approval,
            "error": error_text or None,
        })
        _save_hermes_history(profile, history)
        _clear_hermes_active_run(run_id)

    send_sse("run.started", {"ok": True})
    publish_progress(force=True)

    result = None
    try:
        result = client.send_chat_message(
            meta.get("deliveryMessage") or meta.get("message") or "",
            session_id=session_id,
            timeout_sec=timeout,
            on_event=handle_desktop_event,
            run_id=run_id,
        )
    except Exception as exc:
        result = {"ok": False, "error": str(exc), "reply": reply, "tools": tools, "thinking": reasoning_text}

    if result.get("sessionId"):
        session_id = result.get("sessionId")
        _set_hermes_session_id(profile, session_id)
    reply = result.get("reply") or reply
    reasoning_text = result.get("thinking") or reasoning_text
    if result.get("tools"):
        for item in result.get("tools") or []:
            upsert_tool(item)
    error_text = result.get("error") or result.get("stderr") or error_text
    ok = bool(result.get("ok"))
    terminal_event = "run.completed" if ok else "run.failed"
    terminal_payload = {
        "ok": ok,
        "reply": reply,
        "tools": tools,
        "thinking": "" if reasoning_text.strip() == reply.strip() else reasoning_text,
        "error": None if ok else (error_text or "Hermes Desktop Backend run failed"),
    }
    gateway_presence.set_provider_event(status_key, "hermes", {"event": terminal_event, "run_id": run_id, "error": terminal_payload.get("error") or ""})
    publish_progress(force=True)
    send_sse(terminal_event, terminal_payload)
    finalize_history(ok=ok)


def _handle_hermes_run_events(handler, run_id):
    """Proxy Hermes' native run SSE stream to the browser and persist final history."""
    meta = _get_hermes_active_run(run_id)
    if not meta:
        handler.send_response(404)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Access-Control-Allow-Origin", "*")
        handler.end_headers()
        handler.wfile.write(json.dumps({"ok": False, "error": f"Hermes run '{run_id}' not found"}).encode())
        return
    if meta.get("providerPath") == "desktop":
        return _handle_hermes_desktop_run_events(handler, run_id, meta)

    profile = meta.get("profile") or "default"
    agent = _get_hermes_agent(meta.get("agentId") or meta.get("agentKey") or f"hermes-{profile}") or {}
    agent_id = agent.get("id") or meta.get("agentId") or "hermes-default"
    status_key = agent.get("statusKey") or meta.get("statusKey") or agent_id
    session_id = meta.get("sessionId") or _get_hermes_session_id(profile) or ""
    original_message = meta.get("message") or ""
    timeout = int(meta.get("timeoutSec") or VO_CONFIG.get("hermes", {}).get("timeoutSec") or 600)
    client = _hermes_api_client_for_profile(profile)

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("X-Accel-Buffering", "no")
    handler.end_headers()

    client_connected = True

    def send_sse(event_name, payload):
        nonlocal client_connected
        if not client_connected:
            return False
        data = dict(payload or {})
        data.setdefault("event", event_name)
        data.setdefault("runId", run_id)
        data.setdefault("sessionId", session_id)
        try:
            handler.wfile.write(f"event: {event_name}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
            handler.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            client_connected = False
            return False

    reply = ""
    reasoning_parts = []
    tools = []
    started_tools = {}
    started_tool_keys = {}
    tool_seq = 0
    approval = None
    terminal_event = None
    error_text = ""
    last_progress_publish = 0.0

    def publish_progress(force=False):
        nonlocal last_progress_publish
        now = time.time()
        if force or now - last_progress_publish >= 0.25:
            _publish_hermes_api_progress(profile, agent_id, run_id, tools=tools, reasoning_parts=reasoning_parts, reply=reply)
            last_progress_publish = now

    def finalize_history(ok=False):
        history = _remove_hermes_progress_messages(_load_hermes_history(profile))
        final_ts = int(time.time() * 1000)
        history.extend(_hermes_tool_activity_messages(
            tools,
            agent_id=agent_id,
            run_id=run_id,
            base_ts=final_ts,
            coerce_complete=bool(ok) and not approval,
        ))
        history.append({
            "role": "assistant",
            "text": reply,
            "ts": final_ts + len(tools),
            "agentId": agent_id,
            "exitCode": 0 if ok else 1,
            "sessionId": session_id,
            "runId": run_id,
            "tools": [],
            "thinking": "" if "\n\n".join(reasoning_parts).strip() == reply.strip() else "\n\n".join(reasoning_parts),
            "reasoningTokens": 0,
            "approval": approval,
            "error": error_text or None,
        })
        _save_hermes_history(profile, history)
        _clear_hermes_active_run(run_id)

    send_sse("run.started", {"ok": True, "agentId": agent_id, "profile": profile})
    publish_progress(force=True)

    try:
        for event in client.stream_run_events(run_id, timeout_sec=timeout + 30):
            gateway_presence.set_provider_event(status_key, "hermes", event)
            event_name = str(event.get("event") or "").lower() or "event"
            payload = {**event, "agentId": agent_id, "profile": profile}
            if event_name == "message.delta":
                delta = str(event.get("delta") or "")
                reply += delta
                payload["reply"] = reply
                publish_progress()
            elif event_name == "reasoning.available":
                text = str(event.get("text") or "")
                if text:
                    reasoning_parts.append(text)
                    payload["thinking"] = "\n\n".join(reasoning_parts)
                    publish_progress(force=True)
            elif event_name == "tool.started":
                tool_seq += 1
                fallback_id = f"{run_id}:tool:{tool_seq}"
                card = _hermes_event_tool_card(event, "running", fallback_id=fallback_id)
                event_tool_key = f"{event.get('tool') or event.get('name') or 'tool'}:{event.get('preview') or event.get('label') or ''}"
                started_tool_keys[event_tool_key] = card["id"]
                started_tools[card["id"]] = card
                tools.append(card)
                payload["toolCard"] = card
                publish_progress(force=True)
            elif event_name in {"tool.completed", "tool.failed"}:
                event_tool_key = f"{event.get('tool') or event.get('name') or 'tool'}:{event.get('preview') or event.get('label') or ''}"
                fallback_id = started_tool_keys.get(event_tool_key)
                if not fallback_id:
                    matching_id = next((tid for tid, item in reversed(list(started_tools.items())) if item.get("name") == (event.get("tool") or event.get("name"))), "")
                    fallback_id = matching_id or f"{run_id}:tool:{len(started_tools) + 1}"
                card = _hermes_event_tool_card(event, "done" if event_name == "tool.completed" else "error", fallback_id=fallback_id)
                if card["id"] in started_tools:
                    started_tools[card["id"]].update(card)
                    card = started_tools[card["id"]]
                else:
                    tools.append(card)
                payload["toolCard"] = card
                publish_progress(force=True)
            elif event_name == "approval.request":
                approval = _remember_hermes_approval_pending(
                    _hermes_api_approval_from_event(event, agent_id=agent_id, profile=profile, session_id=session_id, original_message=original_message),
                    agent_id=agent_id,
                    profile=profile,
                    session_id=session_id,
                )
                payload["approval"] = approval
                publish_progress(force=True)
            elif event_name in {"run.completed", "run.failed", "run.cancelled", "run.canceled"}:
                terminal_event = event
                if event.get("output"):
                    reply = str(event.get("output") or reply)
                if event.get("error"):
                    error_text = str(event.get("error") or "")
                if event_name == "run.completed":
                    approval = None
                payload.update({
                    "reply": reply,
                    "tools": tools,
                    "approval": approval,
                    "error": error_text or None,
                })
                publish_progress(force=True)
                send_sse(event_name, payload)
                break
            send_sse(event_name, payload)
    except Exception as exc:
        error_text = str(exc)
        terminal_event = {"event": "run.failed", "error": error_text}
        gateway_presence.set_provider_event(status_key, "hermes", {"event": "run.failed", "run_id": run_id, "error": error_text})
        send_sse("run.failed", {"ok": False, "error": error_text, "reply": reply, "tools": tools})

    terminal_name = str((terminal_event or {}).get("event") or "").lower()
    ok = terminal_name == "run.completed"
    if approval:
        ok = False
        error_text = error_text or "Hermes is waiting for approval."
    elif terminal_name in {"run.failed", "run.cancelled", "run.canceled"}:
        ok = False
        error_text = error_text or terminal_name.replace("run.", "Hermes run ")
    finalize_history(ok=ok)


def _handle_hermes_interrupt(body):
    agent_key = body.get("agentId") or body.get("key") or "hermes-default"
    run_id = str(body.get("runId") or body.get("run_id") or "").strip()
    agent = _get_hermes_agent(agent_key) or {}
    profile = agent.get("profile") or agent.get("providerAgentId") or ""
    meta = _get_hermes_active_run(run_id) if run_id else _find_hermes_active_run(agent_key, profile)
    if not meta:
        return {"ok": False, "error": "No active Hermes run is running for this agent.", "_status": 409}
    run_id = meta.get("runId") or run_id
    profile = meta.get("profile") or profile or "default"
    try:
        client = _hermes_api_client_for_profile(profile)
        result = client.stop_run(run_id)
        gateway_presence.set_provider_event(meta.get("statusKey") or agent.get("statusKey") or agent_key, "hermes", {"event": "run.stop_requested", "run_id": run_id})
        return {"ok": True, "providerPath": "api", "runId": run_id, "result": result, "message": "Hermes stop requested."}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "providerPath": "api", "runId": run_id, "_status": 500}


def _handle_hermes_chat(body):
    """Send one message to a local Hermes agent.

    Prefer Hermes' native API Server run/SSE surface when available, then fall
    back to the public Hermes CLI bridge for installs without the API server.
    """
    message = (body.get("message") or "").strip()
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "hermes-default"
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}

    agent = _get_hermes_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Hermes agent '{agent_key}' not found", "_status": 404}
    if _is_hermes_gateway_platform_agent(agent):
        return _handle_hermes_platform_chat(body, agent)

    hermes_cfg = VO_CONFIG.get("hermes", {})
    hermes_bin = os.path.expanduser(agent.get("binary") or hermes_cfg.get("binary") or "~/.local/bin/hermes")
    timeout = int(body.get("timeoutSec") or hermes_cfg.get("timeoutSec") or 600)
    profile = agent.get("profile") or agent.get("providerAgentId") or "default"

    from_type = str(body.get("fromType") or body.get("senderType") or "").strip().lower()
    is_human_source = from_type in {"human", "user", "chat", "ui"}
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    attachment_context = _format_hermes_attachment_context(attachments)
    source_app = str(body.get("sourceApp") or body.get("app") or "virtual-office").strip() or "virtual-office"
    source_surface = str(body.get("sourceSurface") or body.get("surface") or "chat-window").strip() or "chat-window"
    source_label = str(body.get("sourceLabel") or "").strip()
    sender_name = str(body.get("fromDisplayName") or body.get("displayName") or body.get("fromName") or "User").strip() or "User"
    delivery_message = message
    yolo_once = bool(body.get("yoloOnce") or body.get("approvalApprovedOnce"))
    if is_human_source:
        pretty_surface = source_label or ("Virtual Office Chat" if source_app == "virtual-office" and source_surface in {"chat-window", "chat"} else f"{source_app.replace('-', ' ').title()} {source_surface.replace('-', ' ').title()}".strip())
        delivery_message = (
            f"[A2A from=user name={json.dumps(sender_name)} to={agent.get('id') or agent_key} isUser=true sourceApp={json.dumps(source_app)} sourceSurface={json.dumps(source_surface)}]\n"
            f"Message from {sender_name} via {pretty_surface}.\n\n"
            f"{message}\n\n"
            "Reply directly to the user. Do not assume the user's name unless they identify themselves."
        )
    if attachment_context:
        delivery_message = f"{delivery_message}\n\n{attachment_context}"

    now_ms = int(time.time() * 1000)
    history = _load_hermes_history(profile)
    history.append({
        "role": "user",
        "text": message,
        "ts": now_ms,
        "agentId": agent.get("id"),
        "from": sender_name if is_human_source else "You",
        "fromType": from_type or "",
        "sourceApp": source_app if is_human_source else "",
        "sourceSurface": source_surface if is_human_source else "",
        "sourceLabel": source_label if is_human_source else "",
        "attachments": attachments,
    })
    _save_hermes_history(profile, history)

    progress_id = f"hermes-progress-{now_ms}"
    history.append({
        "role": "assistant",
        "text": "",
        "ts": int(time.time() * 1000),
        "agentId": agent.get("id"),
        "ephemeral": "hermes-progress",
        "progressId": progress_id,
        "tools": [],
        "thinking": "Waiting for native Hermes API events.",
        "reasoningTokens": 0,
    })
    _save_hermes_history(profile, history)

    try:
        provider = HermesProvider(
            home_path=hermes_cfg.get("homePath"),
            binary=hermes_bin,
            enabled=hermes_cfg.get("enabled", True),
            timeout_sec=timeout,
        )
        session_id = _get_hermes_session_id(profile)

        result = None
        used_api = False
        used_desktop = False
        desktop_error = ""
        desktop_configured = bool(agent.get("desktopUrl") or hermes_cfg.get("desktopUrl"))
        desktop_first = bool(desktop_configured and hermes_cfg.get("preferDesktop", True) is not False)

        if desktop_first and not yolo_once:
            desktop_result = _handle_hermes_desktop_chat(agent, profile, delivery_message, timeout)
            if not desktop_result.get("fallback"):
                result = desktop_result
                used_desktop = True
            else:
                desktop_error = desktop_result.get("error") or ""

        if result is None and hermes_cfg.get("preferApi", True) and not yolo_once:
            api_result = _handle_hermes_api_chat(agent, profile, delivery_message, message, timeout)
            if not api_result.get("fallback"):
                result = api_result
                used_api = True

        if result is None and not desktop_first and not yolo_once and (agent.get("desktopAvailable") or hermes_cfg.get("desktopUrl")):
            desktop_result = _handle_hermes_desktop_chat(agent, profile, delivery_message, timeout)
            if not desktop_result.get("fallback"):
                result = desktop_result
                used_desktop = True
            else:
                desktop_error = desktop_result.get("error") or ""

        if result is None:
            gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "working", "Hermes CLI task")
            result = provider.send_chat_message(profile, delivery_message, session_id=session_id, timeout_sec=timeout, yolo_once=yolo_once)
            if desktop_error and not result.get("ok"):
                result["error"] = f"{desktop_error}; {result.get('error') or result.get('stderr') or 'Hermes CLI fallback failed'}"

        if result.get("sessionId"):
            _set_hermes_session_id(profile, result.get("sessionId"))
        activity = {"tools": result.get("tools") or [], "thinking": result.get("thinking") or "", "reasoningTokens": result.get("reasoningTokens") or 0}
        active_session_id = result.get("sessionId") or session_id
        if not used_api and not used_desktop and active_session_id:
            exported = provider.export_session(profile, active_session_id)
            if exported.get("ok"):
                activity = _extract_hermes_turn_activity(exported.get("session"), delivery_message)
        reply = result.get("reply", "")
        stderr = result.get("stderr", "")
        exit_code = result.get("exitCode")
        task_status = "done" if result.get("ok") else "error"
        task_result = "Hermes reply and session activity collected." if result.get("ok") else (result.get("error") or stderr or "Hermes request failed.")
        task_tools = [] if (used_api or used_desktop) else [_hermes_task_breakdown_tool(task_status, task_result)]
        visible_tools = task_tools + (activity.get("tools") or [])
        approval = result.get("approval")
        if not approval:
            approval = _detect_hermes_approval_request(reply, stderr, message, agent.get("id") or agent_key)
        if approval:
            approval = _remember_hermes_approval_pending(
                approval,
                agent_id=agent.get("id") or agent_key,
                profile=profile,
                session_id=active_session_id or "",
            )
        history = _remove_hermes_progress_messages(_load_hermes_history(profile))
        final_ts = int(time.time() * 1000)
        history.extend(_hermes_tool_activity_messages(
            visible_tools,
            agent_id=agent.get("id"),
            run_id=result.get("runId") or "",
            base_ts=final_ts,
            coerce_complete=bool(result.get("ok")) and not approval,
        ))
        history.append({
            "role": "assistant",
            "text": reply,
            "ts": final_ts + len(visible_tools),
            "agentId": agent.get("id"),
            "exitCode": exit_code,
            "sessionId": active_session_id,
            "runId": result.get("runId"),
            "tools": [],
            "thinking": activity.get("thinking") or "",
            "reasoningTokens": activity.get("reasoningTokens") or 0,
            "approval": approval,
        })
        _save_hermes_history(profile, history)
        if not used_api:
            state = "idle" if result.get("ok") else "offline"
            gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), state, "")
        return {
            "ok": bool(result.get("ok")),
            "reply": reply,
            "stderr": stderr[:2000],
            "exitCode": exit_code,
            "sessionId": active_session_id,
            "runId": result.get("runId"),
            "providerPath": result.get("providerPath") or ("api" if used_api else "cli"),
            "tools": visible_tools,
            "thinking": activity.get("thinking") or "",
            "reasoningTokens": activity.get("reasoningTokens") or 0,
            "approval": approval,
            "error": result.get("error"),
            "agent": {"id": agent.get("id"), "name": agent.get("name"), "providerKind": "hermes", "profile": profile},
        }
    except Exception as e:
        history = _remove_hermes_progress_messages(_load_hermes_history(profile))
        history.append({
            "role": "assistant",
            "text": "",
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "tools": [_hermes_task_breakdown_tool("error", str(e))],
            "thinking": "",
            "reasoningTokens": 0,
        })
        _save_hermes_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "offline", "Hermes CLI error")
        return {"ok": False, "error": str(e), "_status": 500}


def _handle_codex_chat(body):
    """Send one message to a local Codex app-server-backed agent."""
    message = (body.get("message") or "").strip()
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "codex-default"
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}

    agent = _get_codex_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Codex agent '{agent_key}' not found", "_status": 404}

    codex_cfg = VO_CONFIG.get("codex", {})
    timeout = int(body.get("timeoutSec") or codex_cfg.get("timeoutSec") or 900)
    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
    stream_run_id = str(body.get("_streamRunId") or "").strip()
    stream_progress_id = str(body.get("_streamProgressId") or "").strip()
    stream_progress_cb = body.get("_onProgress") if callable(body.get("_onProgress")) else None
    from_type = str(body.get("fromType") or body.get("senderType") or "").strip().lower()
    is_human_source = from_type in {"human", "user", "chat", "ui"}
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    sender_name = str(body.get("fromDisplayName") or body.get("displayName") or body.get("fromName") or "User").strip() or "User"

    delivery_message = message
    if is_human_source:
        delivery_message = (
            f"Message from {sender_name} via Virtual Office Chat.\n\n"
            f"{message}\n\n"
            "Reply directly to the user. Do not assume the user's name unless they identify themselves."
        )
    if attachments:
        file_lines = []
        for item in attachments:
            if isinstance(item, dict):
                file_lines.append(f"- {item.get('name') or 'attachment'}: {item.get('path') or item.get('url') or ''}".strip())
        if file_lines:
            delivery_message += "\n\nAttached files uploaded through Virtual Office:\n" + "\n".join(file_lines)

    now_ms = int(time.time() * 1000)
    history = _load_codex_history(profile)
    history.append({
        "role": "user",
        "text": message,
        "ts": now_ms,
        "agentId": agent.get("id"),
        "from": sender_name if is_human_source else "You",
        "fromType": from_type or "",
        "attachments": attachments,
    })
    progress_id = stream_progress_id or f"codex-progress-{now_ms}"
    history.append({
        "role": "assistant",
        "text": "",
        "ts": int(time.time() * 1000),
        "agentId": agent.get("id"),
        "ephemeral": "codex-progress",
        "progressId": progress_id,
        "runId": stream_run_id,
        "tools": [],
        "thinking": "Starting Codex app-server.",
        "reasoningTokens": 0,
    })
    _save_codex_history(profile, history)

    try:
        provider = _codex_provider()
        provider.model = agent.get("model") or provider.model or ""
        requested_approval_policy = str(body.get("approvalPolicy") or body.get("codexApprovalPolicy") or "").strip()
        if requested_approval_policy in {"untrusted", "on-request", "on-failure", "never"}:
            provider.approval_policy = requested_approval_policy
        session_id = _get_codex_session_id(profile)
        status_key = agent.get("statusKey") or agent.get("id")
        gateway_presence.set_manual_override(status_key, "working", "Codex task")

        def on_progress(run_state):
            gateway_presence.set_provider_event(status_key, "codex", {
                "event": "turn.progress",
                "thread_id": run_state.get("threadId") or "",
                "turn_id": run_state.get("turnId") or run_state.get("runId") or "",
                "status": run_state.get("status") or "",
            })
            _publish_codex_progress(profile, agent.get("id"), progress_id, run_state)
            if stream_progress_cb:
                try:
                    stream_progress_cb(run_state)
                except Exception:
                    pass

        result = provider.send_chat_message(profile, delivery_message, session_id=session_id, timeout_sec=timeout, on_progress=on_progress)
        active_session_id = result.get("sessionId") or session_id
        if active_session_id:
            _set_codex_session_id(profile, active_session_id)
        if result.get("runId"):
            _set_codex_active_run(profile, active_session_id, result.get("runId"))

        reply = result.get("reply", "")
        stderr = result.get("stderr", "")
        exit_code = result.get("exitCode")
        history = _remove_codex_progress_messages(_load_codex_history(profile))
        final_ts = int(time.time() * 1000)
        tools = result.get("tools") or []
        approval = result.get("approval") if isinstance(result.get("approval"), dict) else None
        approval_id = (approval or {}).get("approval_id") or (approval or {}).get("id") or ""
        token_usage = result.get("tokenUsage") if isinstance(result.get("tokenUsage"), dict) else {}
        context_used = _codex_context_used_from_token_usage(token_usage)
        token_context_window = _codex_context_window_from_token_usage(token_usage)
        if token_usage:
            _set_codex_token_usage(profile, token_usage)
        if tools:
            history.append({
                "role": "assistant",
                "text": "",
                "ts": final_ts,
                "agentId": agent.get("id"),
                "source": "codex-tool-activity",
                "tools": tools,
            })
        history.append({
            "role": "assistant",
            "text": reply,
            "ts": final_ts + (1 if tools else 0),
            "agentId": agent.get("id"),
            "exitCode": exit_code,
            "sessionId": active_session_id,
            "runId": result.get("runId"),
            "tools": [],
            "thinking": result.get("thinking") or "",
            "reasoningTokens": 0,
            "error": result.get("error") or None,
            "interrupted": bool(result.get("interrupted")),
            "approval": approval if approval and not _history_has_approval(history, approval_id) else None,
            "tokenUsage": token_usage or None,
            "contextUsed": context_used,
            "contextWindow": token_context_window or None,
        })
        _save_codex_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "idle" if result.get("ok") else "offline", "")
        return {
            "ok": bool(result.get("ok")),
            "reply": reply,
            "stderr": stderr[:2000],
            "exitCode": exit_code,
            "sessionId": active_session_id,
            "runId": result.get("runId"),
            "providerPath": result.get("providerPath") or "app-server",
            "tools": tools,
            "thinking": result.get("thinking") or "",
            "reasoningTokens": 0,
            "approval": approval,
            "tokenUsage": token_usage,
            "contextUsed": context_used,
            "contextWindow": token_context_window,
            "interrupted": bool(result.get("interrupted")),
            "error": result.get("error"),
            "agent": {"id": agent.get("id"), "name": agent.get("name"), "providerKind": "codex", "profile": profile},
        }
    except Exception as e:
        history = _remove_codex_progress_messages(_load_codex_history(profile))
        history.append({
            "role": "assistant",
            "text": "",
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "tools": [{"id": "codex-error", "name": "codex", "status": "error", "arguments": {}, "error": str(e)}],
            "thinking": "",
            "reasoningTokens": 0,
        })
        _save_codex_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "offline", "Codex error")
        return {"ok": False, "error": str(e), "_status": 500}


def _handle_codex_interrupt(body):
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "codex-default"
    agent = _get_codex_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Codex agent '{agent_key}' not found", "_status": 404}
    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
    result = _codex_provider().interrupt(profile)
    if result.get("ok"):
        history = _load_codex_history(profile)
        history.append({
            "role": "assistant",
            "text": "",
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "ephemeral": "codex-progress",
            "progressId": f"codex-interrupt-{int(time.time() * 1000)}",
            "sessionId": result.get("threadId") or _get_codex_session_id(profile),
            "runId": result.get("turnId") or "",
            "tools": [],
            "thinking": "Stop requested. Waiting for Codex to interrupt the active turn.",
            "reasoningTokens": 0,
        })
        _save_codex_history(profile, history)
    else:
        result["_status"] = 409
    return result


def _handle_codex_approval_pending(agent_key="codex-default"):
    agent = _get_codex_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Codex agent '{agent_key}' not found", "_status": 404}
    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
    result = _codex_provider().pending_approval(profile)
    pending = result.get("pending") if isinstance(result.get("pending"), dict) else None
    if pending:
        pending["agentId"] = pending.get("agentId") or agent.get("id") or agent_key
        pending["profile"] = pending.get("profile") or profile
    return result


def _handle_codex_approval_respond(body):
    approval = body.get("approval") if isinstance(body.get("approval"), dict) else {}
    choice = _normalize_codex_approval_choice(body.get("choice") or body.get("action") or "")
    agent_key = body.get("agentId") or approval.get("agentId") or "codex-default"
    approval_id = str(body.get("approval_id") or body.get("approvalId") or approval.get("approval_id") or approval.get("id") or "").strip()
    if not approval_id:
        return {"ok": False, "error": "approval_id is required", "_status": 400}
    agent = _get_codex_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Codex agent '{agent_key}' not found", "_status": 404}
    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
    result = _codex_provider().respond_approval(profile, approval_id, choice)
    if not result.get("ok"):
        result["_status"] = 409
        return result

    resolved_approval = result.get("approval") if isinstance(result.get("approval"), dict) else {**approval, "approval_id": approval_id, "id": approval_id}
    resolved_approval["agentId"] = resolved_approval.get("agentId") or agent.get("id") or agent_key
    resolved_approval["profile"] = resolved_approval.get("profile") or profile
    history = _load_codex_history(profile)
    if not _history_has_approval(history, approval_id):
        history.append(_codex_approval_result_message(resolved_approval, choice))
        _save_codex_history(profile, history)
    gateway_presence.set_provider_event(agent.get("statusKey") or agent.get("id"), "codex", {
        "event": "approval.responded",
        "choice": choice,
        "approval_id": approval_id,
        "thread_id": resolved_approval.get("threadId") or resolved_approval.get("session_id") or "",
        "turn_id": resolved_approval.get("turnId") or resolved_approval.get("runId") or "",
    })
    return {
        "ok": True,
        "choice": choice,
        "approvalChoice": choice,
        "providerPath": "app-server",
        "approval": resolved_approval,
        "message": "Codex approval approved." if choice == "approve" else "Codex approval cancelled.",
    }


def msg_matches_ephemeral(msg, marker):
    return isinstance(msg, dict) and msg.get("ephemeral") == marker


def _handle_codex_test(body=None):
    cfg = dict(VO_CONFIG.get("codex", {}))
    if isinstance(body, dict):
        cfg.update({k: v for k, v in body.items() if v is not None})
    result = CodexProvider(
        home_path=cfg.get("homePath"),
        binary=cfg.get("binary"),
        workspace_root=cfg.get("workspaceRoot"),
        enabled=cfg.get("enabled", True),
        timeout_sec=int(cfg.get("timeoutSec") or 900),
        model=cfg.get("model") or "",
        sandbox=cfg.get("sandbox") or "workspace-write",
        approval_policy=cfg.get("approvalPolicy") or "never",
        prefer_app_server=cfg.get("preferAppServer", True),
        main_workspace=cfg.get("mainWorkspace"),
        include_main=cfg.get("includeMain", True),
        include_native_agents=cfg.get("includeNativeAgents", True),
        register_native_agents=cfg.get("registerNativeAgents", True),
    ).test()
    return result


def _handle_claude_code_chat(body):
    """Send one message to a local Claude Code CLI-backed agent."""
    message = (body.get("message") or "").strip()
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "claude-code-main"
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}

    agent = _get_claude_code_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Claude Code agent '{agent_key}' not found", "_status": 404}

    claude_cfg = VO_CONFIG.get("claudeCode", {})
    timeout = int(body.get("timeoutSec") or claude_cfg.get("timeoutSec") or 900)
    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
    stream_run_id = str(body.get("_streamRunId") or "").strip()
    stream_progress_id = str(body.get("_streamProgressId") or "").strip()
    stream_progress_cb = body.get("_onProgress") if callable(body.get("_onProgress")) else None
    from_type = str(body.get("fromType") or body.get("senderType") or "").strip().lower()
    is_human_source = from_type in {"human", "user", "chat", "ui"}
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    sender_name = str(body.get("fromDisplayName") or body.get("displayName") or body.get("fromName") or "User").strip() or "User"

    delivery_message = message
    if is_human_source:
        delivery_message = (
            f"Message from {sender_name} via Virtual Office Chat.\n\n"
            f"{message}\n\n"
            "Reply directly to the user. Do not assume the user's name unless they identify themselves."
        )
    if attachments:
        file_lines = []
        for item in attachments:
            if isinstance(item, dict):
                file_lines.append(f"- {item.get('name') or 'attachment'}: {item.get('path') or item.get('url') or ''}".strip())
        if file_lines:
            delivery_message += "\n\nAttached files uploaded through Virtual Office:\n" + "\n".join(file_lines)

    now_ms = int(time.time() * 1000)
    history = _load_claude_code_history(profile)
    history.append({
        "role": "user",
        "text": message,
        "ts": now_ms,
        "agentId": agent.get("id"),
        "from": sender_name if is_human_source else "You",
        "fromType": from_type or "",
        "attachments": attachments,
    })
    progress_id = stream_progress_id or f"claude-code-progress-{now_ms}"
    history.append({
        "role": "assistant",
        "text": "",
        "ts": int(time.time() * 1000),
        "agentId": agent.get("id"),
        "ephemeral": "claude-code-progress",
        "progressId": progress_id,
        "runId": stream_run_id,
        "tools": [],
        "thinking": "Starting Claude Code.",
        "reasoningTokens": 0,
    })
    _save_claude_code_history(profile, history)

    try:
        provider = _claude_code_provider()
        agent_model = agent.get("model") or ""
        if agent_model and agent_model != "inherit":
            provider.model = agent_model
        requested_permission_mode = str(body.get("permissionMode") or body.get("claudePermissionMode") or "").strip()
        if requested_permission_mode in {"default", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"}:
            provider.permission_mode = requested_permission_mode
        session_id = _get_claude_code_session_id(profile)
        status_key = agent.get("statusKey") or agent.get("id")
        gateway_presence.set_manual_override(status_key, "working", "Claude Code task")

        def on_progress(run_state):
            run_state = run_state if isinstance(run_state, dict) else {}
            usage = run_state.get("usage") if isinstance(run_state.get("usage"), dict) else {}
            token_usage = provider._usage_to_token_usage(usage)
            if token_usage:
                run_state = dict(run_state)
                run_state["tokenUsage"] = token_usage
            gateway_presence.set_provider_event(status_key, "claude-code", {
                "event": "turn.progress",
                "session_id": run_state.get("sessionId") or run_state.get("threadId") or "",
                "status": run_state.get("status") or "",
            })
            _publish_claude_code_progress(profile, agent.get("id"), progress_id, run_state)
            if stream_progress_cb:
                try:
                    stream_progress_cb(run_state)
                except Exception:
                    pass

        result = provider.send_chat_message(profile, delivery_message, session_id=session_id, timeout_sec=timeout, on_progress=on_progress)
        active_session_id = result.get("sessionId") or session_id
        if active_session_id:
            _set_claude_code_session_id(profile, active_session_id)
            _set_claude_code_active_run(profile, active_session_id, result.get("runId") or active_session_id)

        reply = result.get("reply", "")
        stderr = result.get("stderr", "")
        exit_code = result.get("exitCode")
        history = _remove_claude_code_progress_messages(_load_claude_code_history(profile))
        final_ts = int(time.time() * 1000)
        tools = result.get("tools") or []
        token_usage = result.get("tokenUsage") if isinstance(result.get("tokenUsage"), dict) else {}
        context_used = _codex_context_used_from_token_usage(token_usage)
        token_context_window = _codex_context_window_from_token_usage(token_usage)
        if token_usage:
            _set_claude_code_token_usage(profile, token_usage)
        if tools:
            history.append({
                "role": "assistant",
                "text": "",
                "ts": final_ts,
                "agentId": agent.get("id"),
                "source": "claude-code-tool-activity",
                "tools": tools,
            })
        history.append({
            "role": "assistant",
            "text": reply,
            "ts": final_ts + (1 if tools else 0),
            "agentId": agent.get("id"),
            "exitCode": exit_code,
            "sessionId": active_session_id,
            "runId": result.get("runId") or active_session_id,
            "tools": [],
            "thinking": result.get("thinking") or "",
            "reasoningTokens": 0,
            "error": result.get("error") or None,
            "tokenUsage": token_usage or None,
            "contextUsed": context_used,
            "contextWindow": token_context_window or None,
        })
        _save_claude_code_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "idle" if result.get("ok") else "offline", "")
        return {
            "ok": bool(result.get("ok")),
            "reply": reply,
            "stderr": stderr[:2000],
            "exitCode": exit_code,
            "sessionId": active_session_id,
            "runId": result.get("runId") or active_session_id,
            "providerPath": result.get("providerPath") or "claude-code-cli",
            "tools": tools,
            "thinking": result.get("thinking") or "",
            "reasoningTokens": 0,
            "tokenUsage": token_usage,
            "contextUsed": context_used,
            "contextWindow": token_context_window,
            "error": result.get("error"),
            "agent": {"id": agent.get("id"), "name": agent.get("name"), "providerKind": "claude-code", "profile": profile},
        }
    except Exception as e:
        history = _remove_claude_code_progress_messages(_load_claude_code_history(profile))
        history.append({
            "role": "assistant",
            "text": "",
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "tools": [{"id": "claude-code-error", "name": "claude-code", "status": "error", "arguments": {}, "error": str(e)}],
            "thinking": "",
            "reasoningTokens": 0,
        })
        _save_claude_code_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "offline", "Claude Code error")
        return {"ok": False, "error": str(e), "_status": 500}


def _handle_claude_code_interrupt(body):
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "claude-code-main"
    agent = _get_claude_code_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Claude Code agent '{agent_key}' not found", "_status": 404}
    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
    result = _claude_code_provider().interrupt(profile)
    if result.get("ok"):
        history = _load_claude_code_history(profile)
        history.append({
            "role": "assistant",
            "text": "Claude Code run interrupted.",
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "ephemeral": "claude-code-progress",
            "progressId": f"claude-code-interrupt-{int(time.time() * 1000)}",
            "sessionId": _get_claude_code_session_id(profile),
            "runId": body.get("runId") or "",
            "thinking": "Interrupted by user.",
        })
        _save_claude_code_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "idle", "")
    else:
        result["_status"] = 409
    return result


def _handle_claude_code_test(body=None):
    cfg = dict(VO_CONFIG.get("claudeCode", {}))
    if isinstance(body, dict):
        cfg.update({k: v for k, v in body.items() if v is not None})
    return ClaudeCodeProvider(
        home_path=cfg.get("homePath"),
        binary=cfg.get("binary"),
        workspace_root=cfg.get("workspaceRoot"),
        enabled=cfg.get("enabled", True),
        timeout_sec=int(cfg.get("timeoutSec") or 900),
        model=cfg.get("model") or "",
        permission_mode=cfg.get("permissionMode") or "acceptEdits",
        main_workspace=cfg.get("mainWorkspace"),
        include_main=cfg.get("includeMain", True),
        include_native_agents=cfg.get("includeNativeAgents", True),
        register_native_agents=cfg.get("registerNativeAgents", True),
    ).test()


def _handle_opencode_test(body=None):
    cfg = dict(VO_CONFIG.get("openCode", {}))
    if isinstance(body, dict):
        cfg.update({k: v for k, v in body.items() if v is not None})
    return OpenCodeProvider(
        home_path=cfg.get("homePath"),
        binary=cfg.get("binary"),
        workspace_root=cfg.get("workspaceRoot"),
        enabled=cfg.get("enabled", True),
        timeout_sec=int(cfg.get("timeoutSec") or 900),
        model=cfg.get("model") or "",
        main_workspace=cfg.get("mainWorkspace"),
        include_main=cfg.get("includeMain", True),
        include_agents=cfg.get("includeAgents", True),
        register_agents=cfg.get("registerAgents", True),
    ).test()


def _handle_opencode_chat(body):
    """Send one message to a local OpenCode CLI-backed agent."""
    message = (body.get("message") or "").strip()
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "opencode-main"
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}

    agent = _get_opencode_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"OpenCode agent '{agent_key}' not found", "_status": 404}

    opencode_cfg = VO_CONFIG.get("openCode", {})
    timeout = int(body.get("timeoutSec") or opencode_cfg.get("timeoutSec") or 900)
    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
    session_id = body.get("sessionId") or _get_opencode_session_id(profile) or ""
    from_type = str(body.get("fromType") or body.get("senderType") or "").strip().lower()
    is_human_source = from_type in {"human", "user", "chat", "ui"}
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    sender_name = str(body.get("fromDisplayName") or body.get("displayName") or body.get("fromName") or "User").strip() or "User"

    delivery_message = message
    if is_human_source:
        delivery_message = (
            f"Message from {sender_name} via Virtual Office Chat.\n\n"
            f"{message}\n\n"
            "Reply directly to the user. Do not assume the user's name unless they identify themselves."
        )
    if attachments:
        file_lines = []
        for item in attachments:
            if isinstance(item, dict):
                file_lines.append(f"- {item.get('name') or 'attachment'}: {item.get('path') or item.get('url') or ''}".strip())
        if file_lines:
            delivery_message += "\n\nAttached files uploaded through Virtual Office:\n" + "\n".join(file_lines)

    now_ms = int(time.time() * 1000)
    progress_id = f"opencode-progress-{now_ms}"
    history = _load_opencode_history(profile)
    history.append({
        "role": "user",
        "text": message,
        "ts": now_ms,
        "agentId": agent.get("id"),
        "from": sender_name if is_human_source else "You",
        "fromType": from_type or "",
        "attachments": attachments,
    })
    history.append({
        "role": "assistant",
        "text": "",
        "ts": now_ms + 1,
        "agentId": agent.get("id"),
        "ephemeral": "opencode-progress",
        "progressId": progress_id,
        "sessionId": session_id,
        "thinking": "Starting OpenCode.",
    })
    _save_opencode_history(profile, history)

    try:
        provider = _opencode_provider()
        agent_model = agent.get("model") or ""
        if agent_model and agent_model != "inherit":
            provider.model = agent_model
        status_key = agent.get("statusKey") or agent.get("id")
        gateway_presence.set_manual_override(status_key, "working", "OpenCode task")

        def on_progress(run_state):
            run_state = run_state if isinstance(run_state, dict) else {}
            current = [m for m in _load_opencode_history(profile) if not msg_matches_ephemeral(m, "opencode-progress")]
            current.append({
                "role": "assistant",
                "text": run_state.get("reply") or "",
                "ts": int(time.time() * 1000),
                "agentId": agent.get("id"),
                "ephemeral": "opencode-progress",
                "progressId": progress_id,
                "sessionId": session_id,
                "thinking": "OpenCode is running.",
            })
            _save_opencode_history(profile, current)

        result = provider.send_chat_message(profile, delivery_message, session_id=session_id or None, timeout_sec=timeout, on_progress=on_progress)
        active_session_id = result.get("sessionId") or session_id
        if active_session_id:
            _set_opencode_session_id(profile, active_session_id)
        reply = result.get("reply", "")
        history = [m for m in _load_opencode_history(profile) if not msg_matches_ephemeral(m, "opencode-progress")]
        final_ts = int(time.time() * 1000)
        history.append({
            "role": "assistant",
            "text": reply,
            "ts": final_ts,
            "agentId": agent.get("id"),
            "exitCode": result.get("exitCode"),
            "sessionId": active_session_id,
            "thinking": "",
            "reasoningTokens": 0,
            "error": result.get("error") or None,
            "model": result.get("model") or provider.model or "",
        })
        _save_opencode_history(profile, history)
        gateway_presence.set_manual_override(status_key, "idle" if result.get("ok") else "offline", "")
        return {
            "ok": bool(result.get("ok")),
            "reply": reply,
            "stderr": str(result.get("stderr") or "")[:2000],
            "exitCode": result.get("exitCode"),
            "sessionId": active_session_id,
            "providerPath": result.get("providerPath") or "opencode-cli",
            "error": result.get("error"),
            "agent": {"id": agent.get("id"), "name": agent.get("name"), "providerKind": "opencode", "profile": profile},
            "_status": 200 if result.get("ok") else 500,
        }
    except Exception as e:
        history = [m for m in _load_opencode_history(profile) if not msg_matches_ephemeral(m, "opencode-progress")]
        history.append({
            "role": "assistant",
            "text": "",
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "tools": [{"id": "opencode-error", "name": "opencode", "status": "error", "arguments": {}, "error": str(e)}],
        })
        _save_opencode_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "offline", "OpenCode error")
        return {"ok": False, "error": str(e), "_status": 500}


def _handle_opencode_interrupt(body):
    agent_key = body.get("agentId") or body.get("key") or "opencode-main"
    agent = _get_opencode_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"OpenCode agent '{agent_key}' not found", "_status": 404}
    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
    result = _opencode_provider().interrupt(profile)
    if result.get("ok"):
        history = _load_opencode_history(profile)
        history.append({
            "role": "assistant",
            "text": "OpenCode run interrupted.",
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "ephemeral": "opencode-progress",
            "progressId": f"opencode-interrupt-{int(time.time() * 1000)}",
            "sessionId": _get_opencode_session_id(profile),
            "thinking": "Interrupted by user.",
        })
        _save_opencode_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "idle", "")
    else:
        result["_status"] = 409
    return result


def _handle_antigravity_test(body=None):
    cfg = dict(VO_CONFIG.get("antigravity", {}))
    if isinstance(body, dict):
        cfg.update({k: v for k, v in body.items() if v is not None})
    return AntigravityProvider(
        home_path=cfg.get("homePath"),
        binary=cfg.get("binary"),
        workspace_root=cfg.get("workspaceRoot"),
        enabled=cfg.get("enabled", True),
        timeout_sec=int(cfg.get("timeoutSec") or 600),
        print_timeout=cfg.get("printTimeout", "5m"),
        model=cfg.get("model") or "",
        sandbox=cfg.get("sandbox") or "",
    ).test()


def _handle_antigravity_chat(body):
    """Send one message to a local Antigravity (agy) agent."""
    message = (body.get("message") or "").strip()
    agent_key = body.get("agentId") or body.get("key") or body.get("sessionKey") or "antigravity-main"
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}

    agent = _get_antigravity_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Antigravity agent '{agent_key}' not found", "_status": 404}

    ag_cfg = VO_CONFIG.get("antigravity", {})
    timeout = int(body.get("timeoutSec") or ag_cfg.get("timeoutSec") or 600)
    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
    from_type = str(body.get("fromType") or body.get("senderType") or "").strip().lower()
    is_human_source = from_type in {"human", "user", "chat", "ui"}
    attachments = body.get("attachments") if isinstance(body.get("attachments"), list) else []
    sender_name = str(body.get("fromDisplayName") or body.get("displayName") or body.get("fromName") or "User").strip() or "User"

    delivery_message = message
    if is_human_source:
        delivery_message = (
            f"Message from {sender_name} via Virtual Office Chat.\n\n"
            f"{message}\n\n"
            "Reply directly to the user. Do not assume the user's name unless they identify themselves."
        )
    if attachments:
        file_lines = []
        for item in attachments:
            if isinstance(item, dict):
                file_lines.append(f"- {item.get('name') or 'attachment'}: {item.get('path') or item.get('url') or ''}".strip())
        if file_lines:
            delivery_message += "\n\nAttached files uploaded through Virtual Office:\n" + "\n".join(file_lines)

    now_ms = int(time.time() * 1000)
    progress_id = f"antigravity-progress-{now_ms}"
    history = _load_antigravity_history(profile)
    history.append({
        "role": "user",
        "text": message,
        "ts": now_ms,
        "agentId": agent.get("id"),
        "from": sender_name if is_human_source else "You",
        "fromType": from_type or "",
        "attachments": attachments,
    })
    history.append({
        "role": "assistant",
        "text": "",
        "ts": now_ms + 1,
        "agentId": agent.get("id"),
        "ephemeral": "antigravity-progress",
        "progressId": progress_id,
        "thinking": "Starting Antigravity.",
    })
    _save_antigravity_history(profile, history)

    try:
        provider = _antigravity_provider()
        status_key = agent.get("statusKey") or agent.get("id")
        gateway_presence.set_manual_override(status_key, "working", "Antigravity task")

        def on_progress(run_state):
            run_state = run_state if isinstance(run_state, dict) else {}
            current = [m for m in _load_antigravity_history(profile) if not msg_matches_ephemeral(m, "antigravity-progress")]
            current.append({
                "role": "assistant",
                "text": run_state.get("reply") or "",
                "ts": int(time.time() * 1000),
                "agentId": agent.get("id"),
                "ephemeral": "antigravity-progress",
                "progressId": progress_id,
                "thinking": "Antigravity is running.",
            })
            _save_antigravity_history(profile, current)

        result = provider.send_chat_message(profile="main", message=delivery_message, timeout_sec=timeout, on_progress=on_progress)
        reply = result.get("reply", "")
        history = [m for m in _load_antigravity_history(profile) if not msg_matches_ephemeral(m, "antigravity-progress")]
        history.append({
            "role": "assistant",
            "text": reply,
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "exitCode": result.get("exitCode"),
            "thinking": "",
            "reasoningTokens": 0,
            "error": result.get("error") or None,
            "model": result.get("model") or provider.model or "",
        })
        _save_antigravity_history(profile, history)
        gateway_presence.set_manual_override(status_key, "idle" if result.get("ok") else "offline", "")
        return {
            "ok": bool(result.get("ok")),
            "reply": reply,
            "stderr": str(result.get("stderr") or "")[:2000],
            "exitCode": result.get("exitCode"),
            "sessionId": "",
            "providerPath": result.get("providerPath") or "antigravity-cli",
            "error": result.get("error"),
            "agent": {"id": agent.get("id"), "name": agent.get("name"), "providerKind": "antigravity", "profile": profile},
            "_status": 200 if result.get("ok") else 500,
        }
    except Exception as e:
        history = [m for m in _load_antigravity_history(profile) if not msg_matches_ephemeral(m, "antigravity-progress")]
        history.append({
            "role": "assistant",
            "text": "",
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "tools": [{"id": "antigravity-error", "name": "antigravity", "status": "error", "arguments": {}, "error": str(e)}],
        })
        _save_antigravity_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "offline", "Antigravity error")
        return {"ok": False, "error": str(e), "_status": 500}


def _handle_antigravity_interrupt(body):
    agent_key = body.get("agentId") or body.get("key") or "antigravity-main"
    agent = _get_antigravity_agent(agent_key) or {}
    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
    result = _antigravity_provider().interrupt("main")
    if result.get("ok"):
        history = _load_antigravity_history(profile)
        history.append({
            "role": "assistant",
            "text": "Antigravity run interrupted.",
            "ts": int(time.time() * 1000),
            "agentId": agent.get("id"),
            "ephemeral": "antigravity-progress",
            "progressId": f"antigravity-interrupt-{int(time.time() * 1000)}",
            "thinking": "Interrupted by user.",
        })
        _save_antigravity_history(profile, history)
        gateway_presence.set_manual_override(agent.get("statusKey") or agent.get("id"), "idle", "")
    else:
        result["_status"] = 409
    return result


def _handle_hermes_approval_respond(body):
    approval = body.get("approval") if isinstance(body.get("approval"), dict) else {}
    choice = _normalize_hermes_approval_choice(body.get("choice") or body.get("action") or "")
    if choice not in {"approve_once", "deny"}:
        return {"ok": False, "error": "choice must be approve_once or deny", "_status": 400}
    agent_key = body.get("agentId") or approval.get("agentId") or "hermes-default"
    approval_id = str(body.get("approval_id") or body.get("approvalId") or approval.get("approval_id") or approval.get("id") or "").strip()
    session_id = str(body.get("session_id") or body.get("sessionId") or approval.get("session_id") or approval.get("sessionId") or "").strip()
    queued_approval = _resolve_hermes_approval_pending(agent_key, approval_id, session_id, choice)
    if queued_approval:
        approval = {**queued_approval, **approval}
    message = str(body.get("message") or approval.get("message") or "").strip()
    agent = _get_hermes_agent(agent_key)
    if not agent:
        return {"ok": False, "error": f"Hermes agent '{agent_key}' not found", "_status": 404}
    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
    if approval.get("provider") == "hermes-api" and approval.get("runId"):
        run_id = str(approval.get("runId"))
        api_choice = "deny" if choice == "deny" else "once"
        try:
            client = _hermes_api_client_for_profile(profile)
            approved = client.respond_approval(run_id, api_choice)
            history = _load_hermes_history(profile)
            history.append(_approval_result_message({**approval, "agentId": agent.get("id") or agent_key, "message": message}, choice))
            _save_hermes_history(profile, history)
            if choice == "deny":
                gateway_presence.set_provider_event(agent.get("statusKey") or agent.get("id"), "hermes", {"event": "run.cancelled", "run_id": run_id})
                return {"ok": True, "choice": "deny", "providerPath": "api", "runId": run_id, "message": "Hermes approval denied."}

            gateway_presence.set_provider_event(agent.get("statusKey") or agent.get("id"), "hermes", {"event": "approval.responded", "run_id": run_id})
            return {
                "ok": True,
                "choice": "approve_once",
                "approvalChoice": "approve_once",
                "providerPath": "api",
                "runId": run_id,
                "sessionId": approval.get("session_id") or "",
                "message": "Hermes approval approved. The active run will continue streaming.",
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc), "providerPath": "api", "runId": run_id, "_status": 500}
    if choice == "deny":
        history = _load_hermes_history(profile)
        history.append(_approval_result_message({**approval, "agentId": agent.get("id") or agent_key, "message": message}, "deny"))
        _save_hermes_history(profile, history)
        return {"ok": True, "choice": "deny", "message": "Hermes approval denied."}
    if not message:
        return {"ok": False, "error": "original approval message is missing", "_status": 400}
    history = _load_hermes_history(profile)
    history.append(_approval_result_message({**approval, "agentId": agent.get("id") or agent_key, "message": message}, "approve_once"))
    _save_hermes_history(profile, history)
    retry_body = {
        "agentId": agent_key,
        "message": message,
        "fromType": "human",
        "fromDisplayName": body.get("fromDisplayName") or "User",
        "sourceApp": "virtual-office",
        "sourceSurface": "chat-window-approval",
        "sourceLabel": "Virtual Office Approval",
        "yoloOnce": True,
        "approvalRetry": True,
    }
    result = _handle_hermes_chat(retry_body)
    result["approvalChoice"] = "approve_once"
    return result


def _test_hermes_api(api_url=None, api_key=None):
    api = HermesApiClient(
        base_url=api_url,
        api_key=api_key,
        timeout_sec=min(int(VO_CONFIG.get("hermes", {}).get("timeoutSec") or 600), 10),
    )
    result = {"ok": False, "url": api.base_url, "features": {}}
    try:
        health = api.health()
        result["health"] = health.get("status") or ""
        caps = api.capabilities()
        features = caps.get("features") if isinstance(caps.get("features"), dict) else {}
        result.update({
            "ok": bool(features.get("run_submission") and features.get("run_events_sse")),
            "model": caps.get("model") or caps.get("model_name") or "",
            "features": {
                "runSubmission": bool(features.get("run_submission")),
                "runEventsSse": bool(features.get("run_events_sse")),
                "runApprovalResponse": bool(features.get("run_approval_response")),
            },
        })
        try:
            models = api.models()
            data = models.get("data") if isinstance(models.get("data"), list) else []
            result["models"] = [
                (item.get("id") or item.get("name"))
                for item in data[:8]
                if isinstance(item, dict) and (item.get("id") or item.get("name"))
            ]
            if not result.get("model") and result["models"]:
                result["model"] = result["models"][0]
        except Exception:
            pass
        if not result["ok"] and not result.get("error"):
            result["error"] = "Hermes API is reachable but missing run/SSE capabilities"
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        result["status"] = exc.code
        result["error"] = body[:500] or str(exc)
    except Exception as exc:
        result["error"] = str(exc)[:500]
    return result


def _test_hermes_desktop(desktop_url=None, desktop_token=None, desktop_host_header=None, desktop_tcp_host=None, desktop_tcp_port=None):
    client = HermesDesktopBackendClient(
        base_url=desktop_url,
        token=desktop_token,
        host_header=desktop_host_header,
        tcp_host=desktop_tcp_host,
        tcp_port=desktop_tcp_port,
        timeout_sec=min(int(VO_CONFIG.get("hermes", {}).get("timeoutSec") or 600), 10),
    )
    return client.test(verify_ws=True)


def _handle_hermes_desktop_discover(body=None):
    """Auto-discover the optional Hermes Desktop Backend connection point."""
    body = body or {}
    hermes_cfg = VO_CONFIG.get("hermes", {})
    result = discover_desktop_backend(
        hermes_home=body.get("homePath") or hermes_cfg.get("homePath"),
        desktop_url=body.get("desktopUrl") or hermes_cfg.get("desktopUrl"),
        desktop_token=body.get("desktopToken") or hermes_cfg.get("desktopToken") or "",
        desktop_host_header=body.get("desktopHostHeader") or hermes_cfg.get("desktopHostHeader") or "",
        desktop_tcp_host=body.get("desktopTcpHost") or hermes_cfg.get("desktopTcpHost") or "",
        desktop_tcp_port=body.get("desktopTcpPort") or hermes_cfg.get("desktopTcpPort") or "",
        desktop_log_path=body.get("desktopLogPath") or hermes_cfg.get("desktopLogPath") or "",
        timeout_sec=min(int(hermes_cfg.get("timeoutSec") or 600), 3),
    )
    if result.get("ok"):
        result["message"] = "Hermes Desktop Backend discovered and connected."
    elif result.get("found"):
        result["message"] = "Hermes Desktop Backend was found, but the route is not reachable from this server yet."
    else:
        result["message"] = result.get("error") or "Hermes Desktop Backend was not found."
    return result


def _handle_hermes_test(body=None):
    """Test configured Hermes API Server, Desktop Backend, and CLI connections."""
    body = body or {}
    hermes_cfg = VO_CONFIG.get("hermes", {})
    hermes_bin = os.path.expanduser(body.get("binary") or hermes_cfg.get("binary") or "~/.local/bin/hermes")
    hermes_home = os.path.expanduser(body.get("homePath") or hermes_cfg.get("homePath") or "~/.hermes")
    api_url = body.get("apiUrl") or hermes_cfg.get("apiUrl") or _default_hermes_api_url()
    api_key = body.get("apiKey") or hermes_cfg.get("apiKey") or ""
    desktop_url = body.get("desktopUrl") or hermes_cfg.get("desktopUrl") or _default_hermes_desktop_url()
    desktop_token = body.get("desktopToken") or hermes_cfg.get("desktopToken") or ""
    desktop_host_header = body.get("desktopHostHeader") or hermes_cfg.get("desktopHostHeader") or ""
    desktop_tcp_host = body.get("desktopTcpHost") or hermes_cfg.get("desktopTcpHost") or ""
    desktop_tcp_port = body.get("desktopTcpPort") or hermes_cfg.get("desktopTcpPort") or ""

    cli = HermesProvider(home_path=hermes_home, binary=hermes_bin, enabled=True).test()
    api_status = _test_hermes_api(api_url=api_url, api_key=api_key)
    desktop_status = _test_hermes_desktop(
        desktop_url=desktop_url,
        desktop_token=desktop_token,
        desktop_host_header=desktop_host_header,
        desktop_tcp_host=desktop_tcp_host,
        desktop_tcp_port=desktop_tcp_port,
    )
    agents = discover_hermes_agents(
        hermes_home=hermes_home,
        hermes_bin=hermes_bin,
        enabled=True,
        api_url=api_url,
        api_key=api_key,
        desktop_url=desktop_url,
        desktop_token=desktop_token,
        desktop_host_header=desktop_host_header,
        desktop_tcp_host=desktop_tcp_host,
        desktop_tcp_port=desktop_tcp_port,
        prefer_api=hermes_cfg.get("preferApi", True),
        timeout_sec=int(hermes_cfg.get("timeoutSec") or 600),
    )
    platform_status = _handle_hermes_platform_status()
    platform_agent = _hermes_platform_roster_agent()
    if platform_agent and not any(platform_agent["statusKey"] in (a.get("id"), a.get("statusKey")) for a in agents):
        agents.append(platform_agent)
    platform_ok = bool(platform_status.get("enabled") and platform_status.get("configured"))

    result = {
        "ok": bool(api_status.get("ok") or desktop_status.get("chatReady") or cli.get("ok") or platform_ok),
        "agents": agents,
        "api": api_status,
        "desktop": desktop_status,
        "platform": platform_status,
        "cli": {
            "ok": bool(cli.get("ok")),
            "binary": hermes_bin,
            "homePath": hermes_home,
            "agents": cli.get("agents") or [],
            "error": "" if cli.get("ok") else cli.get("error", "Hermes CLI is not available"),
        },
    }
    if not result["ok"]:
        if desktop_url and desktop_status.get("error"):
            result["error"] = desktop_status.get("error")
        elif api_url and api_status.get("error"):
            result["error"] = api_status.get("error")
        elif platform_status.get("enabled") and not platform_status.get("configured"):
            result["error"] = "Hermes Gateway Platform is enabled but missing VO_HERMES_PLATFORM_TOKEN"
        else:
            result["error"] = result["cli"].get("error") or "Hermes is not available"

    profile_apis = {}
    for agent in agents:
        if not agent.get("apiAvailable"):
            continue
        profile = agent.get("profile") or agent.get("providerAgentId") or "default"
        try:
            profile_api = _hermes_api_client_for_profile(profile)
            caps = profile_api.capabilities()
            features = caps.get("features") if isinstance(caps.get("features"), dict) else {}
            profile_apis[profile] = {
                "ok": bool(features.get("run_submission") and features.get("run_events_sse")),
                "url": profile_api.base_url,
                "model": (caps.get("model") or caps.get("model_name") or ""),
                "features": {
                    "runSubmission": bool(features.get("run_submission")),
                    "runEventsSse": bool(features.get("run_events_sse")),
                    "runApprovalResponse": bool(features.get("run_approval_response")),
                },
            }
        except Exception as exc:
            cfg = _hermes_profile_api_config(profile)
            profile_apis[profile] = {"ok": False, "url": cfg.get("url"), "error": str(exc)[:500]}
    result["profileApis"] = profile_apis
    return result

def _handle_agent_platforms():
    """Return agent platforms available to the New Agent workflow."""
    hermes_cfg = VO_CONFIG.get("hermes", {})
    hermes_status = _handle_hermes_test()
    hermes_cli_ok = bool((hermes_status.get("cli") or {}).get("ok"))
    codex_cfg = VO_CONFIG.get("codex", {})
    codex_status = _codex_provider().test()
    codex_home = codex_status.get("homePath") or codex_cfg.get("homePath") or ""
    claude_cfg = VO_CONFIG.get("claudeCode", {})
    claude_status = _claude_code_provider().test()
    claude_home = claude_status.get("homePath") or claude_cfg.get("homePath") or ""
    opencode_cfg = VO_CONFIG.get("openCode", {})
    opencode_status = _opencode_provider().test()
    opencode_home = opencode_status.get("homePath") or opencode_cfg.get("homePath") or ""
    antigravity_status = _antigravity_provider().test()
    return {
        "ok": True,
        "platforms": [
            {
                "id": "openclaw",
                "label": "OpenClaw",
                "description": "Native OpenClaw workspace agent",
                "providerType": "runtime",
                "available": True,
                "create": True,
                "delete": True,
            },
            {
                "id": "hermes",
                "label": "Hermes",
                "description": "Hermes API Server or Desktop Backend agent with optional CLI profile management",
                "providerType": "runtime",
                "available": bool(hermes_status.get("ok")),
                "create": hermes_cli_ok,
                "delete": hermes_cli_ok,
                "error": "" if hermes_status.get("ok") else hermes_status.get("error", "Hermes is not available"),
                "hermes": {
                    "api": hermes_status.get("api") or {},
                    "desktop": hermes_status.get("desktop") or {},
                    "cli": hermes_status.get("cli") or {},
                },
            },
            {
                "id": "codex",
                "label": "Codex",
                "description": "Native Codex app-server workspace agent",
                "providerType": "harness",
                "available": bool(codex_status.get("ok")),
                "create": bool(codex_status.get("ok")),
                "delete": bool(codex_status.get("ok")),
                "error": "" if codex_status.get("ok") else codex_status.get("error", "Codex is not available"),
                "codex": {
                    "homePath": codex_home,
                    "nativeAgentsDir": os.path.join(codex_home, "agents") if codex_home else "",
                    "workspaceRoot": codex_status.get("workspaceRoot") or codex_cfg.get("workspaceRoot") or "",
                    "mainWorkspace": codex_status.get("mainWorkspace") or codex_cfg.get("mainWorkspace") or "",
                    "defaultCreationMode": "standard",
                    "registerNativeAgents": bool(codex_cfg.get("registerNativeAgents", True)),
                },
            },
            {
                "id": "claude-code",
                "label": "Claude Code",
                "description": "Native Claude Code CLI workspace agent",
                "providerType": "harness",
                "available": bool(claude_status.get("ok")),
                "create": bool(claude_status.get("ok")),
                "delete": bool(claude_status.get("ok")),
                "error": "" if claude_status.get("ok") else claude_status.get("error", "Claude Code is not available"),
                "claudeCode": {
                    "homePath": claude_home,
                    "nativeAgentsDir": os.path.join(claude_home, "agents") if claude_home else "",
                    "workspaceRoot": claude_status.get("workspaceRoot") or claude_cfg.get("workspaceRoot") or "",
                    "mainWorkspace": claude_status.get("mainWorkspace") or claude_cfg.get("mainWorkspace") or "",
                    "defaultCreationMode": "standard",
                    "registerNativeAgents": bool(claude_cfg.get("registerNativeAgents", True)),
                },
            },
            {
                "id": "opencode",
                "label": "OpenCode",
                "description": "Native OpenCode CLI workspace agent",
                "providerType": "harness",
                "available": bool(opencode_status.get("ok")),
                "create": bool(opencode_status.get("ok")),
                "delete": bool(opencode_status.get("ok")),
                "error": "" if opencode_status.get("ok") else opencode_status.get("error", "OpenCode is not available"),
                "openCode": {
                    "homePath": opencode_home,
                    "nativeAgentsDir": os.path.join(opencode_home, "agents") if opencode_home else "",
                    "workspaceRoot": opencode_status.get("workspaceRoot") or opencode_cfg.get("workspaceRoot") or "",
                    "mainWorkspace": opencode_status.get("mainWorkspace") or opencode_cfg.get("mainWorkspace") or "",
                    "defaultCreationMode": "standard",
                    "registerAgents": bool(opencode_cfg.get("registerAgents", True)),
                },
            },
            {
                "id": "antigravity",
                "label": "Antigravity",
                "description": "Native agy CLI one-shot code analyst",
                "providerType": "harness",
                "available": bool(antigravity_status.get("ok")),
                "create": False,
                "delete": False,
                "error": "" if antigravity_status.get("ok") else antigravity_status.get("error", "Antigravity is not available"),
            },
        ],
    }


# ─── AGENT PLATFORM COMMUNICATION LAYER ─────────────────────────

def _comm_log_path():
    return os.path.join(STATUS_DIR, "agent-platform-communications.jsonl")


def _office_agent_lookup(agent_id_or_key):
    needle = str(agent_id_or_key or "").strip()
    for agent in get_roster():
        aliases = {
            str(agent.get("id") or ""),
            str(agent.get("statusKey") or ""),
            str(agent.get("providerAgentId") or ""),
        }
        if needle in aliases:
            return agent
    return None


def _office_agent_ref(agent_id_or_key):
    agent = _office_agent_lookup(agent_id_or_key)
    if agent:
        return {
            "id": agent.get("statusKey") or agent.get("id"),
            "nativeId": agent.get("providerAgentId") or agent.get("id"),
            "providerKind": agent.get("providerKind", "openclaw"),
            "name": agent.get("name") or agent.get("id"),
            "emoji": agent.get("emoji") or "",
        }
    return {
        "id": str(agent_id_or_key or ""),
        "nativeId": str(agent_id_or_key or ""),
        "providerKind": "unknown",
        "name": str(agent_id_or_key or ""),
        "emoji": "",
    }


def _append_comm_event(event):
    event = dict(event)
    if "text" in event:
        event["text"] = _extract_openclaw_text(event.get("text"))
    event.setdefault("ts", int(time.time() * 1000))
    event.setdefault("id", str(uuid.uuid4()))
    event.setdefault("schema", "vo.agent-platform-communication.v1")
    path = _comm_log_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
        try:
            os.chmod(path, 0o666)
        except OSError:
            pass
    except OSError as e:
        print(f"[COMM] Failed to append communication event: {e}")
    return event


def _load_comm_history(limit=200, conversation_id=None, agent_id=None):
    path = _comm_log_path()
    events = []
    try:
        with open(path, "r") as f:
            for line in f:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if conversation_id and event.get("conversationId") != conversation_id:
                    continue
                if agent_id:
                    src = (event.get("from") or {}).get("id")
                    dst = (event.get("to") or {}).get("id")
                    if agent_id not in (src, dst):
                        continue
                events.append(event)
    except FileNotFoundError:
        pass
    except OSError as e:
        print(f"[COMM] Failed to load communication history: {e}")
    return events[-max(1, min(int(limit or 200), 1000)):]


def _comm_event_to_chat_message(event, agent_key):
    """Convert a communication event into the existing bubble message shape."""
    from_ref = event.get("from") or {}
    to_ref = event.get("to") or {}
    from_id = from_ref.get("id", "")
    to_id = to_ref.get("id", "")
    text = _extract_openclaw_text(event.get("text", ""))
    if not text:
        return None
    from_label = (from_ref.get("name") or from_id or "Agent").strip()
    to_label = (to_ref.get("name") or to_id or "Agent").strip()
    # For an agent's own outgoing message, show it like assistant speech.
    # Incoming messages keep role=user so the bubble renderer prefixes sender.
    role = "assistant" if from_id == agent_key else "user"
    return {
        "role": role,
        "text": text,
        "ts": event.get("ts", 0),
        "epochMs": event.get("ts", 0),
        "from": from_label,
        "fromAgentId": from_id,
        "to": to_label,
        "toAgentId": to_id,
        "conversationId": event.get("conversationId", ""),
        "source": "agent-platform-communications",
        "commEventId": event.get("id", ""),
    }


def _merge_comm_events_into_agent_chat(result, per_agent_limit=500):
    """Merge visible cross-platform comm events into /agent-chat payload.

    Chat bubbles are supposed to show the latest real agent conversation,
    regardless of whether it came from an OpenClaw transcript, Hermes history,
    or the office-mediated cross-platform communication layer.
    """
    events = _load_comm_history(limit=1000)
    if not events:
        return result
    valid_keys = set(AGENT_SESSION_IDS.keys()) | {a.get("statusKey") or a.get("id") for a in get_roster()}
    for event in events:
        if not event.get("visibleInOffice", True):
            continue
        refs = [event.get("from") or {}, event.get("to") or {}]
        for ref in refs:
            agent_key = ref.get("id")
            if not agent_key or agent_key not in valid_keys:
                continue
            msg = _comm_event_to_chat_message(event, agent_key)
            if not msg:
                continue
            result.setdefault(agent_key, []).append(msg)

    # Sort/dedupe/trim so each bubble follows true recency.
    for agent_key, msgs in list(result.items()):
        seen = set()
        cleaned = []
        for msg in msgs:
            msg_text = _extract_openclaw_text(msg.get("text"))
            if not msg_text and not msg.get("media") and not msg.get("tools"):
                continue
            if msg.get("text") != msg_text:
                msg = dict(msg)
                msg["text"] = msg_text
            tool_sig = ""
            if msg.get("tools"):
                tool_sig = json.dumps([
                    {
                        "id": t.get("id"),
                        "name": t.get("name"),
                        "status": t.get("status"),
                    }
                    for t in (msg.get("tools") or [])
                    if isinstance(t, dict)
                ], sort_keys=True)
            unique = msg.get("commEventId") or (msg.get("role"), msg_text, tool_sig, msg.get("epochMs") or msg.get("ts") or msg.get("time"))
            if str(unique) in seen:
                continue
            seen.add(str(unique))
            cleaned.append(msg)
        cleaned.sort(key=lambda m: int(m.get("epochMs") or m.get("ts") or 0))
        # Provider calls may also write their own local history (Hermes does).
        # Prefer the communication-layer copy because it preserves from/to
        # context needed for visible cross-platform bubbles.
        comm_signatures = set()
        for msg in cleaned:
            if msg.get("source") == "agent-platform-communications":
                ts = int(msg.get("epochMs") or msg.get("ts") or 0)
                comm_signatures.add((msg.get("role"), _extract_openclaw_text(msg.get("text")), ts // 5000))
        if comm_signatures:
            filtered = []
            for msg in cleaned:
                if msg.get("source") == "agent-platform-communications":
                    filtered.append(msg)
                    continue
                raw_text = _extract_openclaw_text(msg.get("text"))
                if raw_text.lstrip().startswith("[A2A ") or "via My Virtual Office AgentPlatform-to-AgentPlatform Communications" in raw_text:
                    continue
                ts = int(msg.get("epochMs") or msg.get("ts") or 0)
                msg_text = _extract_openclaw_text(msg.get("text"))
                sigs = [(msg.get("role"), msg_text, ts // 5000), (msg.get("role"), msg_text, (ts // 5000) - 1), (msg.get("role"), msg_text, (ts // 5000) + 1)]
                if any(sig in comm_signatures for sig in sigs):
                    continue
                filtered.append(msg)
            cleaned = filtered
        result[agent_key] = cleaned[-per_agent_limit:]
    return result


def _handle_agent_platform_comm_send(body):
    """Send a visible office-mediated message between provider agents.

    The sender/target may be OpenClaw, Hermes, or future provider agents. The
    actual provider routing uses the existing agent-call abstraction, while the
    office owns the cross-platform log that future chat bubbles can render.
    """
    from_type = str(body.get("fromType") or body.get("senderType") or "agent").strip().lower()
    from_agent_id = (body.get("fromAgentId") or body.get("from") or "").strip()
    to_agent_id = (body.get("toAgentId") or body.get("to") or "").strip()
    message = (body.get("message") or body.get("text") or "").strip()
    is_human_source = from_type in {"human", "user", "chat", "ui"}
    if not from_agent_id and not is_human_source:
        return {"ok": False, "error": "fromAgentId is required", "_status": 400}
    if not to_agent_id:
        return {"ok": False, "error": "toAgentId is required", "_status": 400}
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}

    to_agent = _office_agent_lookup(to_agent_id)
    if not to_agent:
        return {"ok": False, "error": f"Target agent '{to_agent_id}' not found", "_status": 404}

    source_app = str(body.get("sourceApp") or body.get("app") or "virtual-office").strip() or "virtual-office"
    source_surface = str(body.get("sourceSurface") or body.get("surface") or "agent-platform").strip() or "agent-platform"
    source_label = str(body.get("sourceLabel") or "").strip()
    if is_human_source:
        display_name = str(body.get("fromDisplayName") or body.get("displayName") or body.get("fromName") or "User").strip() or "User"
        from_ref = {
            "id": str(body.get("fromId") or body.get("fromUserId") or "user").strip() or "user",
            "nativeId": str(body.get("fromId") or body.get("fromUserId") or "user").strip() or "user",
            "providerKind": "human",
            "providerType": "chat-window",
            "name": display_name,
            "emoji": "",
            "sourceApp": source_app,
            "sourceSurface": source_surface,
            "sourceLabel": source_label,
        }
    else:
        from_ref = _office_agent_ref(from_agent_id)
    to_ref = _office_agent_ref(to_agent_id)
    conversation_id = (body.get("conversationId") or body.get("threadId") or f"{from_ref['id']}__{to_ref['id']}").strip()
    metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    metadata = dict(metadata)
    metadata.setdefault("sourceApp", source_app)
    metadata.setdefault("sourceSurface", source_surface)
    if source_label:
        metadata.setdefault("sourceLabel", source_label)
    timeout = int(body.get("timeoutSec") or body.get("timeout") or 600)

    inbound = _append_comm_event({
        "type": "message",
        "direction": "request",
        "conversationId": conversation_id,
        "from": from_ref,
        "to": to_ref,
        "text": message,
        "metadata": metadata,
        "visibleInOffice": True,
    })

    provider_prefixes = {
        "openclaw": "OpenClaw",
        "hermes": "Hermes",
        "codex": "Codex",
        "claude-code": "Claude Code",
    }
    if is_human_source:
        sender_label = from_ref.get("name") or "User"
        pretty_surface = source_label or ("Virtual Office Chat" if source_app == "virtual-office" and source_surface in {"chat-window", "chat"} else f"{source_app.replace('-', ' ').title()} {source_surface.replace('-', ' ').title()}".strip())
        envelope_source = pretty_surface
    else:
        provider_label = provider_prefixes.get(str(from_ref.get("providerKind") or "").lower(), str(from_ref.get("providerKind") or "Agent").replace("-", " ").title())
        base_name = f"{from_ref.get('name') or from_ref['id']} {from_ref.get('emoji') or ''}".strip()
        sender_label = f"{provider_label}: {base_name}" if provider_label else base_name
        envelope_source = "My Virtual Office AgentPlatform-to-AgentPlatform Communications"
    target_prompt = (
        f"[A2A from={from_ref['id']} name={json.dumps(sender_label)} to={to_ref['id']} isUser={'true' if is_human_source else 'false'} sourceApp={json.dumps(source_app)} sourceSurface={json.dumps(source_surface)}]\n"
        f"Message from {sender_label} via {envelope_source}.\n\n"
        f"{message}\n\n"
        "Reply directly to the sender. Keep the reply concise unless detail is needed."
    )

    gateway_presence.set_manual_override(to_ref["id"], "working", f"Replying to {sender_label}")
    try:
        reply = _wf_call_agent(to_ref["id"], target_prompt, timeout=timeout, project_id="agent-platform-communications", task_id=conversation_id)
        ok = not str(reply or "").startswith("[ERROR]")
    except Exception as e:
        reply = f"[ERROR] {e}"
        ok = False
    finally:
        gateway_presence.set_manual_override(to_ref["id"], "idle", "")

    outbound = _append_comm_event({
        "type": "message",
        "direction": "reply",
        "conversationId": conversation_id,
        "from": to_ref,
        "to": from_ref,
        "text": reply,
        "inReplyTo": inbound["id"],
        "metadata": metadata,
        "visibleInOffice": True,
        "ok": ok,
    })

    return {
        "ok": ok,
        "conversationId": conversation_id,
        "messageId": inbound["id"],
        "replyMessageId": outbound["id"],
        "from": from_ref,
        "to": to_ref,
        "reply": reply,
    }


def _handle_agent_platform_comm_history(query):
    limit = int((query.get("limit") or [200])[0] or 200)
    conversation_id = (query.get("conversationId") or query.get("threadId") or [None])[0]
    agent_id = (query.get("agentId") or [None])[0]
    return {"ok": True, "events": _load_comm_history(limit=limit, conversation_id=conversation_id, agent_id=agent_id)}


# ─── HERMES MESSAGING GATEWAY PLATFORM BRIDGE ───────────────────

_HERMES_PLATFORM_LOCK = threading.RLock()
_HERMES_PLATFORM_MAX_MESSAGES = 2000


def _now_ms():
    return int(time.time() * 1000)


def _hermes_platform_queue_path():
    return os.path.join(STATUS_DIR, "hermes-platform-queue.json")


def _hermes_platform_ready():
    cfg = VO_CONFIG.get("hermes", {})
    return bool(cfg.get("platformEnabled") and cfg.get("platformToken"))


def _hermes_platform_state_default():
    return {
        "schema": "vo.hermes-platform-queue.v1",
        "messages": [],
        "adapters": {},
        "updatedAt": _now_ms(),
    }


def _load_hermes_platform_state():
    path = _hermes_platform_queue_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return _hermes_platform_state_default()
        messages = data.get("messages") if isinstance(data.get("messages"), list) else []
        adapters = data.get("adapters") if isinstance(data.get("adapters"), dict) else {}
        return {
            "schema": data.get("schema") or "vo.hermes-platform-queue.v1",
            "messages": messages,
            "adapters": adapters,
            "updatedAt": int(data.get("updatedAt") or 0),
        }
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return _hermes_platform_state_default()


def _save_hermes_platform_state(state):
    state = dict(state or {})
    messages = state.get("messages") if isinstance(state.get("messages"), list) else []
    if len(messages) > _HERMES_PLATFORM_MAX_MESSAGES:
        messages = messages[-_HERMES_PLATFORM_MAX_MESSAGES:]
    state["messages"] = messages
    state.setdefault("schema", "vo.hermes-platform-queue.v1")
    state.setdefault("adapters", {})
    state["updatedAt"] = _now_ms()
    _atomic_write_text(_hermes_platform_queue_path(), json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    try:
        os.chmod(_hermes_platform_queue_path(), 0o666)
    except OSError:
        pass


def _hermes_platform_counts(state):
    counts = {}
    for msg in state.get("messages") or []:
        status = str(msg.get("status") or "queued")
        counts[status] = counts.get(status, 0) + 1
    return counts


def _hermes_platform_public_message(msg):
    return {
        "id": msg.get("id"),
        "text": msg.get("text") or "",
        "chatId": msg.get("chatId") or "",
        "chatName": msg.get("chatName") or msg.get("chatId") or "",
        "chatType": msg.get("chatType") or "dm",
        "userId": msg.get("userId") or "",
        "userName": msg.get("userName") or "",
        "conversationId": msg.get("conversationId") or "",
        "threadId": msg.get("threadId") or "",
        "messageId": msg.get("id"),
        "leaseId": msg.get("leaseId") or "",
        "createdAt": msg.get("createdAt") or 0,
        "metadata": msg.get("metadata") if isinstance(msg.get("metadata"), dict) else {},
        "sourceRef": msg.get("from") if isinstance(msg.get("from"), dict) else {},
        "targetRef": msg.get("to") if isinstance(msg.get("to"), dict) else {},
    }


def _hermes_platform_adapter_id(value=None):
    raw = str(value or os.environ.get("VO_HERMES_PLATFORM_ADAPTER_ID") or "hermes-gateway").strip()
    return raw[:120] or "hermes-gateway"


def _hermes_platform_agent_ref(agent_id=None):
    cfg = VO_CONFIG.get("hermes", {})
    target_id = str(agent_id or cfg.get("platformAgentId") or "hermes-gateway").strip() or "hermes-gateway"
    ref = _office_agent_ref(target_id)
    if ref.get("providerKind") == "unknown":
        ref.update({
            "id": target_id,
            "nativeId": "gateway",
            "providerKind": "hermes",
            "providerType": "gateway-platform",
            "name": "Hermes Gateway",
            "emoji": os.environ.get("VO_HERMES_GATEWAY_AGENT_EMOJI", "⚕️"),
        })
    else:
        ref["providerType"] = ref.get("providerType") or "gateway-platform"
    return ref


def _hermes_platform_source_ref(body):
    from_type = str(body.get("fromType") or body.get("senderType") or "human").strip().lower()
    from_agent_id = str(body.get("fromAgentId") or body.get("from") or "").strip()
    if from_agent_id and from_type not in {"human", "user", "chat", "ui"}:
        return _office_agent_ref(from_agent_id)
    user_id = str(body.get("fromUserId") or body.get("fromId") or body.get("userId") or "user").strip() or "user"
    display_name = str(body.get("fromDisplayName") or body.get("displayName") or body.get("fromName") or body.get("userName") or "User").strip() or "User"
    return {
        "id": user_id,
        "nativeId": user_id,
        "providerKind": "human",
        "providerType": "chat-window",
        "name": display_name,
        "emoji": "",
        "sourceApp": str(body.get("sourceApp") or body.get("app") or "virtual-office").strip() or "virtual-office",
        "sourceSurface": str(body.get("sourceSurface") or body.get("surface") or "chat-window").strip() or "chat-window",
        "sourceLabel": str(body.get("sourceLabel") or "").strip(),
    }


def _hermes_platform_request_token(headers):
    auth = str(headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    for name in ("X-Virtual-Office-Token", "X-My-Virtual-Office-Token", "X-Hermes-Platform-Token"):
        val = str(headers.get(name) or "").strip()
        if val:
            return val
    return ""


def _hermes_platform_auth_error(headers):
    cfg = VO_CONFIG.get("hermes", {})
    if not cfg.get("platformEnabled"):
        return {"ok": False, "error": "Hermes platform bridge is disabled", "_status": 503}
    expected = str(cfg.get("platformToken") or "").strip()
    if not expected:
        return {"ok": False, "error": "Hermes platform bridge token is not configured", "_status": 503}
    provided = _hermes_platform_request_token(headers)
    if not provided:
        return {"ok": False, "error": "Hermes platform bridge token is required", "_status": 401}
    if not secrets.compare_digest(provided, expected):
        return {"ok": False, "error": "Hermes platform bridge token is invalid", "_status": 403}
    return None


def _handle_hermes_platform_status():
    with _HERMES_PLATFORM_LOCK:
        state = _load_hermes_platform_state()
    adapters = {}
    now = _now_ms()
    for key, item in (state.get("adapters") or {}).items():
        if not isinstance(item, dict):
            continue
        last_seen = int(item.get("lastSeenAt") or 0)
        adapters[key] = {
            "adapterId": key,
            "lastSeenAt": last_seen,
            "ageSec": max(0, int((now - last_seen) / 1000)) if last_seen else None,
            "status": item.get("status") or "unknown",
            "version": item.get("version") or "",
        }
    return {
        "ok": True,
        "enabled": bool(VO_CONFIG.get("hermes", {}).get("platformEnabled")),
        "configured": bool(VO_CONFIG.get("hermes", {}).get("platformToken")),
        "agentId": VO_CONFIG.get("hermes", {}).get("platformAgentId") or "hermes-gateway",
        "counts": _hermes_platform_counts(state),
        "adapters": adapters,
    }


def _handle_hermes_platform_enqueue(body):
    if not _hermes_platform_ready():
        return {"ok": False, "error": "Hermes platform bridge is not configured", "_status": 503}
    message = str(body.get("message") or body.get("text") or "").strip()
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}
    if len(message) > 60000:
        return {"ok": False, "error": "message is too large", "_status": 413}

    metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    metadata = dict(metadata)
    source_app = str(body.get("sourceApp") or body.get("app") or "virtual-office").strip() or "virtual-office"
    source_surface = str(body.get("sourceSurface") or body.get("surface") or "chat-window").strip() or "chat-window"
    source_label = str(body.get("sourceLabel") or "").strip()
    metadata.setdefault("sourceApp", source_app)
    metadata.setdefault("sourceSurface", source_surface)
    if source_label:
        metadata.setdefault("sourceLabel", source_label)
    metadata.setdefault("bridge", "hermes-gateway-platform")

    to_ref = _hermes_platform_agent_ref(body.get("toAgentId") or body.get("to"))
    from_ref = _hermes_platform_source_ref(body)
    conversation_id = str(body.get("conversationId") or body.get("threadId") or f"{from_ref['id']}__{to_ref['id']}").strip()
    chat_id = str(body.get("chatId") or conversation_id).strip() or conversation_id
    chat_name = str(body.get("chatName") or body.get("roomName") or conversation_id).strip() or conversation_id
    chat_type = str(body.get("chatType") or "dm").strip().lower() or "dm"
    if chat_type not in {"dm", "group", "channel"}:
        chat_type = "dm"
    thread_id = str(body.get("threadId") or conversation_id).strip() or conversation_id

    inbound = _append_comm_event({
        "type": "message",
        "direction": "request",
        "conversationId": conversation_id,
        "from": from_ref,
        "to": to_ref,
        "text": message,
        "metadata": metadata,
        "visibleInOffice": bool(body.get("visibleInOffice", True)),
    })

    msg = {
        "schema": "vo.hermes-platform-message.v1",
        "id": str(uuid.uuid4()),
        "createdAt": _now_ms(),
        "updatedAt": _now_ms(),
        "status": "queued",
        "attempts": 0,
        "conversationId": conversation_id,
        "chatId": chat_id,
        "chatName": chat_name,
        "chatType": chat_type,
        "threadId": thread_id,
        "userId": from_ref.get("nativeId") or from_ref.get("id") or "user",
        "userName": from_ref.get("name") or "User",
        "text": message,
        "from": from_ref,
        "to": to_ref,
        "commEventId": inbound.get("id"),
        "metadata": {**metadata, "commEventId": inbound.get("id")},
    }
    with _HERMES_PLATFORM_LOCK:
        state = _load_hermes_platform_state()
        state.setdefault("messages", []).append(msg)
        _save_hermes_platform_state(state)

    gateway_presence.set_manual_override(to_ref["id"], "working", "Queued message via Hermes Gateway")
    return {
        "ok": True,
        "messageId": msg["id"],
        "conversationId": conversation_id,
        "chatId": chat_id,
        "message": _hermes_platform_public_message(msg),
    }


def _handle_hermes_platform_poll(query):
    if not _hermes_platform_ready():
        return {"ok": False, "error": "Hermes platform bridge is not configured", "_status": 503}
    adapter_id = _hermes_platform_adapter_id((query.get("adapterId") or query.get("adapter") or [""])[0])
    try:
        limit = max(1, min(20, int((query.get("limit") or ["5"])[0] or 5)))
    except Exception:
        limit = 5
    try:
        lease_sec = max(10, min(900, int((query.get("leaseSec") or [VO_CONFIG.get("hermes", {}).get("platformPollLeaseSec") or 120])[0] or 120)))
    except Exception:
        lease_sec = 120

    now = _now_ms()
    selected = []
    with _HERMES_PLATFORM_LOCK:
        state = _load_hermes_platform_state()
        adapters = state.setdefault("adapters", {})
        adapters[adapter_id] = {
            **(adapters.get(adapter_id) if isinstance(adapters.get(adapter_id), dict) else {}),
            "adapterId": adapter_id,
            "lastSeenAt": now,
            "status": "polling",
            "version": (query.get("version") or [""])[0],
        }
        for msg in state.get("messages") or []:
            status = str(msg.get("status") or "queued")
            leased_at = int(msg.get("leasedAt") or 0)
            stale_lease = status == "leased" and leased_at and now - leased_at > lease_sec * 1000
            if status != "queued" and not stale_lease:
                continue
            lease_id = str(uuid.uuid4())
            msg.update({
                "status": "leased",
                "leaseId": lease_id,
                "leasedAt": now,
                "leasedBy": adapter_id,
                "attempts": int(msg.get("attempts") or 0) + 1,
                "updatedAt": now,
            })
            selected.append(_hermes_platform_public_message(msg))
            if len(selected) >= limit:
                break
        _save_hermes_platform_state(state)
    return {"ok": True, "adapterId": adapter_id, "messages": selected}


def _handle_hermes_platform_ack(body):
    message_id = str(body.get("messageId") or body.get("id") or "").strip()
    lease_id = str(body.get("leaseId") or "").strip()
    ok = bool(body.get("ok", True))
    if not message_id:
        return {"ok": False, "error": "messageId is required", "_status": 400}
    with _HERMES_PLATFORM_LOCK:
        state = _load_hermes_platform_state()
        for msg in state.get("messages") or []:
            if msg.get("id") != message_id:
                continue
            if lease_id and msg.get("leaseId") and msg.get("leaseId") != lease_id:
                return {"ok": False, "error": "leaseId does not match current message lease", "_status": 409}
            if ok:
                if msg.get("status") != "replied":
                    msg["status"] = "delivered"
                msg["deliveredAt"] = _now_ms()
                msg["lastError"] = ""
            else:
                msg["lastError"] = str(body.get("error") or "adapter did not accept message")[:500]
                msg["status"] = "queued" if int(msg.get("attempts") or 0) < 5 else "failed"
            msg["updatedAt"] = _now_ms()
            _save_hermes_platform_state(state)
            return {"ok": True, "messageId": message_id, "status": msg.get("status")}
    return {"ok": False, "error": f"Hermes platform message '{message_id}' not found", "_status": 404}


def _find_hermes_platform_message(state, message_id="", chat_id=""):
    messages = state.get("messages") or []
    if message_id:
        for msg in reversed(messages):
            if msg.get("id") == message_id:
                return msg
    if chat_id:
        for msg in reversed(messages):
            if msg.get("chatId") == chat_id and msg.get("status") in {"leased", "delivered", "replied"}:
                return msg
    return None


def _handle_hermes_platform_reply(body):
    if not _hermes_platform_ready():
        return {"ok": False, "error": "Hermes platform bridge is not configured", "_status": 503}
    text = str(body.get("message") or body.get("text") or body.get("content") or "").strip()
    if not text:
        return {"ok": False, "error": "message is required", "_status": 400}
    message_id = str(body.get("messageId") or body.get("inReplyTo") or body.get("replyToMessageId") or "").strip()
    chat_id = str(body.get("chatId") or "").strip()
    adapter_id = _hermes_platform_adapter_id(body.get("adapterId") or body.get("adapter"))
    body_metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}

    with _HERMES_PLATFORM_LOCK:
        state = _load_hermes_platform_state()
        msg = _find_hermes_platform_message(state, message_id=message_id, chat_id=chat_id)
        if msg:
            from_ref = msg.get("to") if isinstance(msg.get("to"), dict) else _hermes_platform_agent_ref()
            to_ref = msg.get("from") if isinstance(msg.get("from"), dict) else _hermes_platform_source_ref({"fromUserId": chat_id or "user"})
            conversation_id = msg.get("conversationId") or chat_id or f"{from_ref.get('id')}__{to_ref.get('id')}"
            metadata = dict(msg.get("metadata") if isinstance(msg.get("metadata"), dict) else {})
            metadata.update(body_metadata)
            metadata["adapterId"] = adapter_id
            outbound = _append_comm_event({
                "type": "message",
                "direction": "reply",
                "conversationId": conversation_id,
                "from": from_ref,
                "to": to_ref,
                "text": text,
                "inReplyTo": msg.get("commEventId") or msg.get("id"),
                "metadata": metadata,
                "visibleInOffice": True,
                "ok": True,
            })
            msg.update({
                "status": "replied",
                "replyText": text,
                "replyEventId": outbound.get("id"),
                "repliedAt": _now_ms(),
                "updatedAt": _now_ms(),
            })
            _save_hermes_platform_state(state)
            gateway_presence.set_manual_override(from_ref.get("id") or "hermes-gateway", "idle", "")
            return {
                "ok": True,
                "messageId": msg.get("id"),
                "conversationId": conversation_id,
                "replyMessageId": outbound.get("id"),
            }

    from_ref = _hermes_platform_agent_ref(body.get("fromAgentId"))
    to_ref = _hermes_platform_source_ref({
        "fromUserId": chat_id or "virtual-office",
        "fromDisplayName": body.get("chatName") or chat_id or "Virtual Office",
        "sourceApp": "virtual-office",
        "sourceSurface": "hermes-gateway-platform",
    })
    conversation_id = str(body.get("conversationId") or chat_id or f"{from_ref['id']}__{to_ref['id']}").strip()
    outbound = _append_comm_event({
        "type": "message",
        "direction": "reply",
        "conversationId": conversation_id,
        "from": from_ref,
        "to": to_ref,
        "text": text,
        "metadata": {**body_metadata, "adapterId": adapter_id, "unmatched": True},
        "visibleInOffice": True,
        "ok": True,
    })
    return {"ok": True, "conversationId": conversation_id, "replyMessageId": outbound.get("id"), "unmatched": True}


def _handle_hermes_platform_heartbeat(body):
    if not _hermes_platform_ready():
        return {"ok": False, "error": "Hermes platform bridge is not configured", "_status": 503}
    adapter_id = _hermes_platform_adapter_id(body.get("adapterId") or body.get("adapter"))
    status = str(body.get("status") or "connected").strip() or "connected"
    now = _now_ms()
    with _HERMES_PLATFORM_LOCK:
        state = _load_hermes_platform_state()
        adapters = state.setdefault("adapters", {})
        adapters[adapter_id] = {
            **(adapters.get(adapter_id) if isinstance(adapters.get(adapter_id), dict) else {}),
            "adapterId": adapter_id,
            "lastSeenAt": now,
            "status": status,
            "version": str(body.get("version") or ""),
        }
        _save_hermes_platform_state(state)
    agent_id = str(body.get("agentId") or VO_CONFIG.get("hermes", {}).get("platformAgentId") or "hermes-gateway")
    if status == "working":
        gateway_presence.set_manual_override(agent_id, "working", "Hermes Gateway processing")
    elif status == "disconnected":
        gateway_presence.set_manual_override(agent_id, "idle", "")
    else:
        gateway_presence.set_manual_override(agent_id, "idle", "Hermes Gateway connected")
    return {"ok": True, "adapterId": adapter_id, "seenAt": now}


def _get_hermes_platform_message(message_id):
    with _HERMES_PLATFORM_LOCK:
        state = _load_hermes_platform_state()
        return _find_hermes_platform_message(state, message_id=message_id)


def _wait_for_hermes_platform_reply(message_id, timeout_sec=600):
    deadline = time.time() + max(1, int(timeout_sec or 600))
    while time.time() < deadline:
        msg = _get_hermes_platform_message(message_id)
        if msg and msg.get("replyText"):
            return msg
        time.sleep(0.5)
    return None


def _handle_hermes_platform_chat(body, agent):
    message = str(body.get("message") or "").strip()
    if not message:
        return {"ok": False, "error": "message is required", "_status": 400}
    timeout = int(body.get("timeoutSec") or VO_CONFIG.get("hermes", {}).get("timeoutSec") or 600)
    profile = agent.get("profile") or "gateway"
    agent_id = agent.get("statusKey") or agent.get("id") or VO_CONFIG.get("hermes", {}).get("platformAgentId") or "hermes-gateway"
    now = _now_ms()
    history = _load_hermes_history(profile)
    history.append({
        "role": "user",
        "text": message,
        "ts": now,
        "agentId": agent_id,
        "from": body.get("fromDisplayName") or "User",
        "fromType": body.get("fromType") or "",
        "sourceApp": body.get("sourceApp") or "virtual-office",
        "sourceSurface": body.get("sourceSurface") or "chat-window",
        "sourceLabel": body.get("sourceLabel") or "",
        "attachments": body.get("attachments") if isinstance(body.get("attachments"), list) else [],
    })
    _save_hermes_history(profile, history)

    enqueue = _handle_hermes_platform_enqueue({
        **body,
        "toAgentId": agent_id,
        "chatId": body.get("conversationId") or f"{body.get('fromUserId') or 'user'}__{agent_id}",
        "chatName": body.get("sourceLabel") or "Virtual Office Chat",
        "chatType": "dm",
        "metadata": {
            **(body.get("metadata") if isinstance(body.get("metadata"), dict) else {}),
            "providerPath": "gateway-platform",
            "agentId": agent_id,
        },
    })
    if not enqueue.get("ok"):
        return enqueue

    msg = _wait_for_hermes_platform_reply(enqueue.get("messageId"), timeout_sec=timeout)
    if not msg:
        gateway_presence.set_manual_override(agent_id, "idle", "")
        return {
            "ok": False,
            "error": "Timed out waiting for Hermes Gateway platform reply",
            "providerPath": "gateway-platform",
            "_status": 504,
        }

    reply = msg.get("replyText") or ""
    final_ts = _now_ms()
    history = _load_hermes_history(profile)
    history.append({
        "role": "assistant",
        "text": reply,
        "ts": final_ts,
        "agentId": agent_id,
        "exitCode": 0,
        "sessionId": msg.get("conversationId") or "",
        "runId": msg.get("id") or "",
        "tools": [],
        "thinking": "",
        "reasoningTokens": 0,
    })
    _save_hermes_history(profile, history)
    return {
        "ok": True,
        "reply": reply,
        "stderr": "",
        "exitCode": 0,
        "sessionId": msg.get("conversationId") or "",
        "runId": msg.get("id") or "",
        "providerPath": "gateway-platform",
        "tools": [],
        "thinking": "",
        "reasoningTokens": 0,
        "agent": {"id": agent_id, "name": agent.get("name") or "Hermes Gateway", "providerKind": "hermes", "profile": profile},
    }


def _parse_a2a_envelope(text):
    """Parse the lightweight VO A2A display envelope, if present.

    This is display metadata only. Agent trust/authority still comes from
    OpenClaw provenance or the sender wrapper, never from arbitrary text alone.
    Supported form:
      [A2A from=main name="Office Agent" to=agent-id isUser=false]
    """
    if not text:
        return None, text
    m = re.match(r"^\s*\[A2A\s+([^\]]+)\]\s*\n?", text)
    if not m:
        return None, text
    attrs = {}
    raw = m.group(1)
    for km in re.finditer(r"([A-Za-z][\w-]*)=(\"[^\"]*\"|'[^']*'|\S+)", raw):
        val = km.group(2).strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        attrs[km.group(1)] = val
    return attrs, text[m.end():].lstrip()

##############################################################################
# AGENT CREATION + SKILLS MANAGEMENT
##############################################################################

def _sanitize_agent_id(name):
    """Convert a display name into a safe agent ID."""
    s = name.lower().strip()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s]+', '-', s)
    s = re.sub(r'-+', '-', s).strip('-')
    return s or f"agent-{int(time.time())}"

def _remove_openclaw_agent_paths(agent_id):
    """Remove local OpenClaw agent/workspace leftovers after Gateway deletion."""
    safe_id = _sanitize_agent_id(agent_id)
    if safe_id != agent_id:
        raise ValueError("Unsafe agent ID")

    base = os.path.realpath(WORKSPACE_BASE)
    targets = [
        os.path.join(base, "agents", safe_id),
        os.path.join(base, f"workspace-{safe_id}"),
    ]
    for target in targets:
        real_target = os.path.realpath(target)
        if not (real_target == base or real_target.startswith(base + os.sep)):
            raise ValueError(f"Refusing to remove path outside OpenClaw home: {target}")
        try:
            if os.path.islink(target) or os.path.isfile(target):
                os.remove(target)
            elif os.path.isdir(target):
                shutil.rmtree(target)
        except FileNotFoundError:
            pass

def _run_async_blocking(coro, timeout=30):
    """Run an async Gateway helper from either sync or async server code."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(asyncio.run, coro)
        return future.result(timeout=timeout)

async def _gateway_rpc_call_async(method, params=None, timeout=20):
    """Call an OpenClaw Gateway RPC as the Virtual Office server."""
    token = _get_gateway_token()
    if not token:
        return {"ok": False, "error": "Gateway token is not configured"}
    gw_url = VO_CONFIG.get("openclaw", {}).get("gatewayUrl", "ws://127.0.0.1:18789")
    origin = f"http://127.0.0.1:{PORT}"
    async with ws_connect(
        gw_url,
        max_size=1024 * 1024,
        additional_headers={"Origin": origin},
        close_timeout=3,
    ) as ws:
        await asyncio.wait_for(ws.recv(), timeout=5)
        connect_id = f"vo-agent-admin-connect-{uuid.uuid4()}"
        await ws.send(json.dumps({
            "type": "req",
            "id": connect_id,
            "method": "connect",
            "params": {
                "minProtocol": GATEWAY_PROTOCOL_VERSION,
                "maxProtocol": GATEWAY_PROTOCOL_VERSION,
                "client": {"id": "openclaw-control-ui", "version": _get_openclaw_version(), "platform": "server", "mode": "webchat"},
                "role": "operator",
                "scopes": ["operator.read", "operator.write", "operator.admin"],
                "caps": [],
                "commands": [],
                "permissions": {},
                "auth": {"token": token},
                "locale": "en-US",
                "userAgent": "virtual-office-server/agent-admin",
            },
        }))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if msg.get("id") == connect_id:
                if not msg.get("ok"):
                    return {"ok": False, "error": msg.get("error", {}).get("message", "Gateway connect failed")}
                break

        req_id = f"vo-agent-admin-{uuid.uuid4()}"
        await ws.send(json.dumps({
            "type": "req",
            "id": req_id,
            "method": method,
            "params": params or {},
        }))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=min(10, max(1, deadline - time.time()))))
            if msg.get("id") != req_id:
                continue
            if not msg.get("ok"):
                return {"ok": False, "error": msg.get("error", {}).get("message", f"{method} failed")}
            payload = msg.get("payload")
            if isinstance(payload, dict):
                payload.setdefault("ok", True)
                return payload
            return {"ok": True, "payload": payload}
    return {"ok": False, "error": f"{method} timed out"}

def _gateway_rpc_call(method, params=None, timeout=20):
    try:
        return _run_async_blocking(_gateway_rpc_call_async(method, params=params, timeout=timeout), timeout=timeout + 10)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _signal_openclaw_gateway(restart=False):
    try:
        rpc_result = _gateway_rpc_call(
            "gateway.restart.request",
            {"reason": "virtual-office.config-changed", "skipDeferral": False},
            timeout=12,
        )
        if rpc_result.get("ok"):
            return {
                "ok": True,
                "method": "gateway-rpc-restart-request",
                "status": rpc_result.get("status") or rpc_result.get("result"),
                "preflight": rpc_result.get("preflight"),
                "restart": rpc_result.get("restart"),
                "restartRequested": bool(restart),
            }
        return {"ok": False, "method": "gateway-rpc-restart-request", "error": rpc_result.get("error") or "Gateway RPC restart request failed."}
    except Exception as exc:
        return {"ok": False, "method": "gateway-rpc-restart-request", "error": str(exc)}

def _agent_template_files(name, role, emoji, agent_kind="OpenClaw"):
    """Return non-secret bootstrap files for a newly-created agent workspace."""
    return {
        "IDENTITY.md": f"""# IDENTITY.md

- **Name:** {name}
- **Creature:** {role} — {agent_kind} agent
- **Vibe:** Helpful, efficient, ready to work
- **Emoji:** {emoji}
""",
        "SOUL.md": f"""# SOUL.md — {name}

You are **{name}** {emoji} — {role}.

## Style
- Be helpful and direct
- Follow your AGENTS.md workflow strictly
- Keep work visible through Virtual Office when possible
""",
        "USER.md": """# USER.md

- **Name:** (set by your owner)
- **Timezone:** (set by your owner)
- **Notes:** Prefers direct, clear communication.
""",
        "AGENTS.md": f"""# {name} {emoji} — {role}

## Role
{role}

## Core Rules
- Follow instructions carefully
- Log your work in memory/YYYY-MM-DD.md when useful
- Complete the full loop: working → work → report → idle

## Communication
- Use Virtual Office communication tools when talking to other office agents
- Your text reply IS your response — write it directly

## Memory
- Daily logs: `memory/YYYY-MM-DD.md`
- Long-term: `MEMORY.md`
""",
        "HEARTBEAT.md": """# HEARTBEAT.md

# Add periodic tasks below. If nothing needs attention, reply HEARTBEAT_OK.
""",
        "MEMORY.md": f"# MEMORY.md - {name}\n\n_No memories yet._\n",
        "TOOLS.md": f"# TOOLS.md — {name}\n\n_Add tool-specific notes here._\n",
    }

def _default_openclaw_agent_model():
    """Prefer the running main agent's model over stale global defaults."""
    result = _gateway_rpc_call("agents.list", {}, timeout=10)
    if not result.get("ok"):
        return ""
    for agent in result.get("agents", []):
        if agent.get("id") == "main":
            model = agent.get("model")
            if isinstance(model, dict):
                return str(model.get("primary") or "")
            if isinstance(model, str):
                return model
    return ""

def _handle_agent_create(body):
    """Create a new agent from the VO app."""
    name = (body.get("name") or "").strip()
    if not name:
        return {"error": "Agent name is required", "_status": 400}

    platform = (body.get("agentPlatform") or body.get("platform") or body.get("providerKind") or "openclaw").strip().lower()
    if platform in {"hermes", "hermes-agent"}:
        return _handle_hermes_agent_create(body, name)
    if platform in {"codex", "codex-cli", "codex-agent"}:
        return _handle_codex_agent_create(body, name)
    if platform in {"claude-code", "claude", "claude-cli", "claude-code-agent"}:
        return _handle_claude_code_agent_create(body, name)
    if platform in {"opencode", "opencode-cli", "opencode-agent"}:
        return _handle_opencode_agent_create(body, name)
    if platform not in {"openclaw", "openclaw-agent"}:
        return {"error": f"Unsupported agent platform '{platform}'", "_status": 400}

    agent_id = _sanitize_agent_id(body.get("id") or name)
    emoji = body.get("emoji", "🤖")
    role = body.get("role", "AI assistant")
    model = body.get("model", "")
    workspace_dir = os.path.join(WORKSPACE_BASE, f"workspace-{agent_id}")

    try:
        create_params = {"name": name, "workspace": workspace_dir, "emoji": emoji}
        selected_model = model or _default_openclaw_agent_model()
        if selected_model:
            create_params["model"] = selected_model
        result = _gateway_rpc_call("agents.create", create_params, timeout=30)
        if not result.get("ok"):
            status = 409 if "already exists" in str(result.get("error", "")).lower() else 500
            return {"error": result.get("error", "OpenClaw agent creation failed"), "_status": status}

        agent_id = result.get("agentId") or agent_id
        for filename, content in _agent_template_files(name, role, emoji, "OpenClaw").items():
            file_result = _gateway_rpc_call("agents.files.set", {"agentId": agent_id, "name": filename, "content": content}, timeout=20)
            if not file_result.get("ok"):
                return {"error": f"Agent created but failed to write {filename}: {file_result.get('error', 'unknown error')}", "_status": 500}

        # Refresh discovery
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
        traceback.print_exc()
        return {"error": str(e), "_status": 500}

def _handle_hermes_agent_create(body, name):
    emoji = body.get("emoji", "⚕️")
    role = body.get("role", "Hermes Agent")
    model = body.get("model", "")
    profile = body.get("id") or body.get("profile") or _sanitize_agent_id(name)
    provider = HermesProvider(
        home_path=VO_CONFIG.get("hermes", {}).get("homePath"),
        binary=VO_CONFIG.get("hermes", {}).get("binary"),
        enabled=VO_CONFIG.get("hermes", {}).get("enabled", True),
        timeout_sec=VO_CONFIG.get("hermes", {}).get("timeoutSec", 600),
    )
    result = provider.create_agent(name=name, role=role, model=model, emoji=emoji, profile=profile)
    if not result.get("ok"):
        return {"error": result.get("error", "Hermes agent creation failed"), "_status": 500}
    global _discovered_at
    _discovered_at = 0
    refresh_agent_maps()
    return {
        "ok": True,
        "agentId": result.get("agentId"),
        "providerKind": "hermes",
        "providerAgentId": result.get("profile"),
        "profile": result.get("profile"),
        "name": name,
        "workspace": result.get("workspace"),
        "message": result.get("message", f"Hermes agent '{name}' created successfully"),
    }


def _handle_codex_agent_create(body, name):
    emoji = body.get("emoji", "🤖")
    role = body.get("role", "Codex Agent")
    prompt = body.get("prompt") or body.get("systemPrompt") or body.get("instructions") or role
    model = body.get("model") or VO_CONFIG.get("codex", {}).get("model", "")
    profile = body.get("id") or body.get("profile") or _sanitize_agent_id(name)
    creation_mode = body.get("codexCreationMode") or body.get("creationMode") or body.get("agentDirectoryMode") or "standard"
    custom_directory = body.get("codexCustomDirectory") or body.get("customDirectory") or body.get("agentDirectory") or ""
    provider = _codex_provider()
    result = provider.create_agent(
        name=name,
        role=role,
        model=model,
        emoji=emoji,
        profile=profile,
        prompt=prompt,
        creation_mode=creation_mode,
        custom_directory=custom_directory,
    )
    if not result.get("ok"):
        return {"error": result.get("error", "Codex agent creation failed"), "_status": 500}
    global _discovered_at
    _discovered_at = 0
    refresh_agent_maps()
    return {
        "ok": True,
        "agentId": result.get("agentId"),
        "providerKind": "codex",
        "providerType": "harness",
        "providerAgentId": result.get("profile"),
        "profile": result.get("profile"),
        "name": name,
        "workspace": result.get("workspace"),
        "creationMode": result.get("creationMode"),
        "nativeAgentPath": result.get("nativeAgentPath"),
        "message": result.get("message", f"Codex agent '{name}' created successfully"),
    }


def _handle_claude_code_agent_create(body, name):
    emoji = body.get("emoji", "🤖")
    role = body.get("role", "Claude Code Agent")
    prompt = body.get("prompt") or body.get("systemPrompt") or body.get("instructions") or role
    model = body.get("model") or VO_CONFIG.get("claudeCode", {}).get("model", "")
    profile = body.get("id") or body.get("profile") or _sanitize_agent_id(name)
    creation_mode = body.get("claudeCodeCreationMode") or body.get("creationMode") or body.get("agentDirectoryMode") or "standard"
    custom_directory = body.get("claudeCodeCustomDirectory") or body.get("customDirectory") or body.get("agentDirectory") or ""
    provider = _claude_code_provider()
    result = provider.create_agent(
        name=name,
        role=role,
        model=model,
        emoji=emoji,
        profile=profile,
        prompt=prompt,
        creation_mode=creation_mode,
        custom_directory=custom_directory,
    )
    if not result.get("ok"):
        return {"error": result.get("error", "Claude Code agent creation failed"), "_status": 500}
    global _discovered_at
    _discovered_at = 0
    refresh_agent_maps()
    return {
        "ok": True,
        "agentId": result.get("agentId"),
        "providerKind": "claude-code",
        "providerType": "harness",
        "providerAgentId": result.get("profile"),
        "profile": result.get("profile"),
        "name": name,
        "workspace": result.get("workspace"),
        "creationMode": result.get("creationMode"),
        "nativeAgentPath": result.get("nativeAgentPath"),
        "message": result.get("message", f"Claude Code agent '{name}' created successfully"),
    }


def _handle_opencode_agent_create(body, name):
    emoji = body.get("emoji", "⚡")
    role = body.get("role", "OpenCode Agent")
    prompt = body.get("prompt") or body.get("systemPrompt") or body.get("instructions") or role
    model = body.get("model") or VO_CONFIG.get("openCode", {}).get("model", "")
    profile = body.get("id") or body.get("profile") or _sanitize_agent_id(name)
    creation_mode = body.get("openCodeCreationMode") or body.get("opencodeCreationMode") or body.get("creationMode") or body.get("agentDirectoryMode") or "standard"
    custom_directory = body.get("openCodeCustomDirectory") or body.get("opencodeCustomDirectory") or body.get("customDirectory") or body.get("agentDirectory") or ""
    provider = _opencode_provider()
    result = provider.create_agent(
        name=name,
        role=role,
        model=model,
        emoji=emoji,
        profile=profile,
        prompt=prompt,
        creation_mode=creation_mode,
        custom_directory=custom_directory,
    )
    if not result.get("ok"):
        return {"error": result.get("error", "OpenCode agent creation failed"), "_status": 500}
    global _discovered_at
    _discovered_at = 0
    refresh_agent_maps()
    return {
        "ok": True,
        "agentId": result.get("agentId"),
        "providerKind": "opencode",
        "providerType": "harness",
        "providerAgentId": result.get("profile"),
        "profile": result.get("profile"),
        "name": name,
        "workspace": result.get("workspace"),
        "creationMode": result.get("creationMode"),
        "nativeAgentPath": result.get("nativeAgentPath"),
        "message": result.get("message", f"OpenCode agent '{name}' created successfully"),
    }


def _write_template(workspace_dir, filename, content):
    """Write a template file to a workspace."""
    with open(os.path.join(workspace_dir, filename), "w") as f:
        f.write(content)


def _signal_gateway_reload():
    """Send SIGUSR1 to the OpenClaw gateway process to reload config."""
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


def _skill_library_slug(name):
    """Return the normalized folder name used by the central skill library."""
    return re.sub(r'[^a-zA-Z0-9_-]', '-', (name or "").strip()).strip('-').lower()


def _handle_skills_library_list():
    """GET /api/skills-library — list all library skills."""
    _ensure_builtin_communication_skill()
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
    if skill_name == AGENT_PLATFORM_COMM_SKILL_NAME:
        _ensure_builtin_communication_skill()
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
    name = body.get("name", "").strip()
    content = body.get("content", "")
    if not name:
        return {"error": "name is required", "_status": 400}
    slug = _skill_library_slug(name)
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


def _handle_skills_library_save_from_agent(body):
    """Copy an agent workspace skill into the central skills library."""
    agent_id = (body.get("agentId") or "").strip()
    skill_name = (body.get("skill") or body.get("name") or "").strip()
    overwrite = bool(body.get("overwrite", False))
    if not agent_id:
        return {"error": "agentId is required", "_status": 400}
    if not skill_name:
        return {"error": "skill is required", "_status": 400}

    skill = None
    result = _handle_skill_list(agent_id)
    if not result.get("skills") and result.get("error"):
        return result
    for item in result.get("skills", []):
        if item.get("name") == skill_name:
            skill = item
            break
    if not skill:
        return {"error": f"Skill '{skill_name}' not found on agent '{agent_id}'", "_status": 404}

    content = skill.get("content") or ""
    slug = _skill_library_slug(skill_name)
    if not slug:
        return {"error": "Invalid skill name", "_status": 400}

    lib_dir = _get_skills_library_dir()
    skill_dir = os.path.join(lib_dir, slug)
    skill_file = os.path.join(skill_dir, "SKILL.md")
    existed = os.path.isfile(skill_file)
    if existed:
        try:
            with open(skill_file, "r") as f:
                existing = f.read()
        except Exception:
            existing = ""
        if existing == content:
            return {
                "ok": True,
                "status": "identical",
                "exists": True,
                "different": False,
                "skill": slug,
                "message": "Skill already exists in the Skill Library.",
            }
        if not overwrite:
            return {
                "ok": False,
                "status": "exists_different",
                "exists": True,
                "different": True,
                "skill": slug,
                "message": "Skill already exists in the Skill Library.",
            }

    os.makedirs(skill_dir, exist_ok=True)
    with open(skill_file, "w") as f:
        f.write(content)
    parsed_name, description = _parse_skill_frontmatter(content)
    return {
        "ok": True,
        "status": "updated" if existed else "created",
        "skill": slug,
        "name": parsed_name or slug,
        "description": description,
        "path": skill_file,
    }


def _parse_cli_json(stdout, stderr=""):
    """Parse JSON from OpenClaw CLI output that may include warning lines first."""
    text = (stdout or "").strip()
    if not text:
        text = (stderr or "").strip()
    for idx, ch in enumerate(text):
        if ch not in "[{":
            continue
        try:
            data, _ = json.JSONDecoder().raw_decode(text[idx:])
            return data
        except json.JSONDecodeError:
            continue
    return None


def _openclaw_skill_workshop_cli(agent_id, args, timeout=25):
    """Run an OpenClaw Skill Workshop CLI command for one agent workspace."""
    openclaw_bin = shutil.which("openclaw")
    if not openclaw_bin:
        return {"ok": False, "error": "openclaw CLI not found", "_status": 500}
    cmd = [openclaw_bin, "skills"]
    if agent_id:
        cmd.extend(["--agent", agent_id])
    cmd.append("workshop")
    cmd.extend(args)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Skill Workshop command timed out", "_status": 504, "agentId": agent_id}
    except Exception as e:
        return {"ok": False, "error": str(e), "_status": 500, "agentId": agent_id}
    data = _parse_cli_json(result.stdout, result.stderr)
    if result.returncode != 0:
        return {
            "ok": False,
            "error": (result.stderr or result.stdout or "Skill Workshop command failed").strip()[:1000],
            "code": result.returncode,
            "_status": 500,
            "agentId": agent_id,
            "data": data,
        }
    if isinstance(data, dict):
        data.setdefault("ok", True)
        data.setdefault("agentId", agent_id)
        return data
    return {"ok": True, "agentId": agent_id, "result": data}


def _skill_workshop_rpc(method, agent_id, params=None, timeout=25):
    payload = dict(params or {})
    if agent_id:
        payload["agentId"] = agent_id
    result = _gateway_rpc_call(method, payload, timeout=timeout)
    if isinstance(result, dict):
        result.setdefault("agentId", agent_id)
    return result


def _skill_workshop_agent_targets(agent_id=""):
    refresh_agent_maps()
    roster = get_roster()
    targets = []
    for agent in roster:
        key = agent.get("statusKey") or agent.get("key") or agent.get("id")
        if not key:
            continue
        if agent_id and key != agent_id and agent.get("id") != agent_id:
            continue
        if agent.get("providerKind") == "hermes":
            continue
        targets.append({
            "id": key,
            "name": agent.get("name") or key,
            "emoji": agent.get("emoji") or "",
        })
    if agent_id and not targets:
        targets.append({"id": agent_id, "name": agent_id, "emoji": ""})
    return targets


def _normalize_skill_workshop_proposal(proposal, agent):
    if not isinstance(proposal, dict):
        return {}
    item = dict(proposal)
    proposal_id = item.get("id") or item.get("proposalId") or item.get("proposal_id")
    item["id"] = proposal_id or ""
    item["agentId"] = agent.get("id")
    item["agentName"] = agent.get("name")
    item["agentEmoji"] = agent.get("emoji", "")
    return item


def _handle_skill_workshop_list(qs):
    agent_id = ""
    if isinstance(qs, dict):
        values = qs.get("agentId") or qs.get("agent") or []
        if values:
            agent_id = str(values[0]).strip()
    targets = _skill_workshop_agent_targets(agent_id)
    proposals = []
    errors = []

    def load_target(agent):
        result = _skill_workshop_rpc("skills.proposals.list", agent["id"], {}, timeout=25)
        return agent, result

    # Keep the UI responsive when aggregating across many agents.
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(load_target, agent) for agent in targets]
        for future in concurrent.futures.as_completed(futures):
            agent, result = future.result()
            if not result.get("ok"):
                errors.append({"agentId": agent["id"], "agentName": agent["name"], "error": result.get("error", "Failed")})
                continue
            for proposal in result.get("proposals", []) or []:
                normalized = _normalize_skill_workshop_proposal(proposal, agent)
                if normalized:
                    proposals.append(normalized)
    proposals.sort(key=lambda p: str(p.get("updatedAt") or p.get("createdAt") or ""), reverse=True)
    return {"ok": True, "proposals": proposals, "errors": errors, "agents": targets}


def _handle_skill_workshop_inspect(qs):
    proposal_id = ""
    agent_id = ""
    if isinstance(qs, dict):
        proposal_id = str((qs.get("proposalId") or qs.get("id") or [""])[0]).strip()
        agent_id = str((qs.get("agentId") or qs.get("agent") or [""])[0]).strip()
    if not proposal_id:
        return {"error": "proposalId is required", "_status": 400}
    if not agent_id:
        return {"error": "agentId is required", "_status": 400}
    result = _skill_workshop_rpc("skills.proposals.inspect", agent_id, {"proposalId": proposal_id}, timeout=25)
    result.setdefault("proposalId", proposal_id)
    result.setdefault("agentId", agent_id)
    return result


def _handle_skill_workshop_action(body):
    action = (body.get("action") or "").strip()
    proposal_id = (body.get("proposalId") or body.get("id") or "").strip()
    agent_id = (body.get("agentId") or "").strip()
    if action not in ("apply", "reject", "quarantine", "revise"):
        return {"error": "Invalid Skill Workshop action", "_status": 400}
    if not proposal_id:
        return {"error": "proposalId is required", "_status": 400}
    if not agent_id:
        return {"error": "agentId is required", "_status": 400}

    method = {
        "apply": "skills.proposals.apply",
        "reject": "skills.proposals.reject",
        "quarantine": "skills.proposals.quarantine",
        "revise": "skills.proposals.revise",
    }[action]
    params = {"proposalId": proposal_id}
    if action in ("reject", "quarantine", "apply"):
        reason = (body.get("reason") or "").strip()
        if reason:
            params["reason"] = reason
    if action == "revise":
        proposal_content = body.get("proposalContent") or body.get("content") or ""
        if not proposal_content:
            return {"error": "proposalContent is required for revise", "_status": 400}
        params["content"] = str(proposal_content)
        for key in ("description", "goal", "evidence"):
            value = (body.get(key) or "").strip()
            if value:
                params[key] = value
    return _skill_workshop_rpc(method, agent_id, params, timeout=35)


def _handle_skills_library_delete(skill_name):
    """DELETE /api/skills-library/<name> — delete a library skill."""
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
    shutil.copy2(src_file, dest_file)
    return {"ok": True, "skill": skill_name, "agentId": agent_id, "path": dest_file, "overwritten": os.path.isfile(dest_file) and overwrite}


def _handle_skills_library_upload(body):
    """POST /api/skills-library/upload — upload a SKILL.md to library."""
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
    completed = dict(ended_meeting)
    completed["status"] = "completed"
    completed["endedBy"] = ended_by or completed.get("organizer", "unknown")
    completed["summary"] = summary
    completed["resolution"] = resolution
    completed["actionItems"] = action_items if isinstance(action_items, list) else []
    completed["responses"] = responses if isinstance(responses, dict) else {}
    completed["endedAt"] = int(time.time())

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
    """Load projects from the markdown-backed store."""
    return PROJECT_STORE.load_all()


def _save_projects(data):
    """Persist projects to the markdown-backed store."""
    PROJECT_STORE.save_all(data)


def _proj_uuid():
    """Generate a UUID4 string."""
    return str(uuid.uuid4())


def _proj_now():
    """ISO-8601 timestamp."""
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
    # Delete through the store so both markdown-backed projects and legacy
    # JSON-only projects are removed correctly.
    deleted = PROJECT_STORE.delete_project(project_id)
    if not deleted:
        return {"error": "Project not found", "_status": 404}
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
    return {"ok": True, "id": task_id}


# ─── PROJECT WORKFLOW ENGINE ──────────────────────────────────────────────────
# Background thread-based workflow: Backlog → In Progress → Review → Done
# Uses `openclaw agent` CLI or Gateway HTTP API to dispatch tasks and reviews to agents.
##############################################################################


# Global workflow state: { projectId: { "active": bool, "autoMode": bool, "currentTaskId": str, "phase": str, "thread": Thread, "stopFlag": Event } }
_WORKFLOW_STATE = {}
_WORKFLOW_LOCK = threading.Lock()

# Legacy task markdown files directory (kept for backward compatibility if present)
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


def _wf_sync_project_workflow_meta(project_id, *, active=None, phase=None, current_task_id=None, active_agent=None):
    """Mirror live workflow metadata onto the project payload for UI consumers."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return None
    if active is not None:
        p["workflowActive"] = active
    if phase is not None:
        p["workflowPhase"] = phase
    if current_task_id is not None or current_task_id is None:
        p["activeTaskId"] = current_task_id
    if active_agent is not None or active_agent is None:
        p["activeAgent"] = active_agent
    p["updatedAt"] = _proj_now()
    _save_projects(data)
    return p

def _wf_write_task_file(project_id, task, status_text, review_results=None, work_log_entry=None):
    """Update canonical markdown-backed task state, preserving compatibility with workflow logging."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return
    live_task = next((t for t in p.get("tasks", []) if t.get("id") == task.get("id")), None)
    if not live_task:
        return
    if review_results is not None:
        live_task["reviewCheck"] = review_results
    if work_log_entry:
        comments = live_task.setdefault("comments", [])
        comments.append({
            "id": _proj_uuid(),
            "author": "workflow",
            "text": work_log_entry,
            "createdAt": _proj_now(),
        })
        if len(comments) > 200:
            live_task["comments"] = comments[-200:]
    live_task["updatedAt"] = _proj_now()
    p["updatedAt"] = _proj_now()
    _save_projects(data)


def _wf_read_task_file(project_id, task_id):
    """Read canonical task content from the markdown-backed store and render it into prompt-friendly markdown."""
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if not p:
        return None
    task = next((t for t in p.get("tasks", []) if t.get("id") == task_id), None)
    if not task:
        return None
    lines = [
        f"# Task: {task.get('title', 'Untitled')}",
        f"**Assignee:** {task.get('assignee', 'unassigned')} | **Priority:** {task.get('priority', 'medium')}",
        "",
        "## Description",
        task.get("description", "_No description_") or "_No description_",
        "",
        "## Checklist",
    ]
    checklist = task.get("checklist", [])
    if checklist:
        review_map = {item.get('text', ''): item.get('status', '') for item in (task.get('reviewCheck') or [])}
        for item in checklist:
            check = "x" if item.get("done") else " "
            suffix = f" — {review_map.get(item.get('text', ''), '')}" if review_map.get(item.get('text', '')) else ""
            lines.append(f"- [{check}] {item.get('text', '')}{suffix}")
    else:
        lines.append("- No checklist items")
    comments = task.get("comments", [])
    if comments:
        lines.extend(["", "## Work Log"])
        for comment in comments[-20:]:
            lines.append(f"### {comment.get('createdAt', '')} — {comment.get('author', 'user')}")
            lines.append(comment.get("text", ""))
            lines.append("")
    return "\n".join(lines).strip() + "\n"


# Track workflow sessions for cleanup: { project_id: { task_id: set(session_keys) } }
def _wf_task_session_key(agent_id, project_id, task_id):
    """Return a stable session key for a workflow task.

    All calls for the same task (work, review, rework) reuse one session.
    This means the agent keeps context across the full task lifecycle,
    prompt caching kicks in, and only ONE session is created per task.
    """
    return f"agent:{agent_id}:openai:wf-{project_id[:8]}-{task_id[:8]}"


def _wf_browser_exec_action_desc(command):
    """Infer browser verification activity from exec-driven browser automation.

    This keeps workflow review validation compatible with environments where
    visual verification happens through a browser CLI (for example
    `agent-browser ...`) instead of the first-class `browser` tool.
    """
    if not command:
        return None
    cmd = command.strip()
    cmd_lower = cmd.lower()

    browser_markers = (
        "agent-browser ",
        " agent-browser",
        "agent-browser\n",
        "playwright ",
        " npx playwright",
    )
    if not any(marker in cmd_lower for marker in browser_markers):
        return None

    action_map = [
        (" screenshot", "screenshot"),
        (" snapshot", "snapshot"),
        (" open ", "open"),
        (" navigate ", "navigate"),
        (" click ", "click"),
        (" fill ", "fill"),
        (" type ", "type"),
        (" eval ", "eval"),
        (" close", "close"),
        (" wait ", "wait"),
    ]
    action = "browser-cli"
    for needle, label in action_map:
        if needle in cmd_lower:
            action = label
            break

    return f"{action} (exec)"


def _wf_extract_session_activity(agent_id, project_id, task_id):
    if _is_hermes_agent(agent_id):
        agent = _get_hermes_agent(agent_id) or {}
        profile = agent.get("profile") or agent.get("providerAgentId") or "default"
        messages = _load_hermes_history(profile)[-12:]
        return [{"type": "message", "summary": (m.get("text") or "")[:300], "ts": m.get("ts", 0)} for m in messages if m.get("text")]

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
        seen_browser_actions = set()

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
                            browser_desc = _wf_browser_exec_action_desc(cmd)
                            if browser_desc and browser_desc not in seen_browser_actions:
                                seen_browser_actions.add(browser_desc)
                                activity["browser_actions"].append(browser_desc)
                    elif name.lower() == "browser":
                        action = args.get("action", "")
                        url = args.get("url", "")
                        if action:
                            desc = action
                            if url:
                                desc += f" → {url}"
                            desc = desc[:200]
                            if desc not in seen_browser_actions:
                                seen_browser_actions.add(desc)
                                activity["browser_actions"].append(desc)
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


def _wf_abort_task_session(session_key):
    """Abort a running agent session via gateway chat.abort RPC.

    This immediately kills any in-flight LLM inference for the specific session,
    similar to clicking Stop in the VO chat. Only targets the given session key —
    does not affect the agent's main session or other workflow sessions.
    """
    import asyncio as _asyncio

    async def _do_abort():
        try:
            gw_url = VO_CONFIG["openclaw"]["gatewayUrl"]
            origin = f"http://127.0.0.1:{PORT}"
            token = _get_gateway_token()
            if not token:
                print(f"[WORKFLOW] No gateway token — skipping session abort for {session_key}")
                return False

            import websockets as _ws
            from websockets.asyncio.client import connect as _ws_connect

            async with _asyncio.timeout(15):
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
                        return False

                    # Authenticate
                    connect_msg = {
                        "type": "req",
                        "id": "wf-abort-1",
                        "method": "connect",
                        "params": {
                            "minProtocol": GATEWAY_PROTOCOL_VERSION, "maxProtocol": GATEWAY_PROTOCOL_VERSION,
                            "client": {"id": "vo-workflow", "version": "1.0", "platform": "server", "mode": "webchat"},
                            "role": "operator",
                            "scopes": ["operator.read", "operator.write"],
                            "caps": [], "commands": [], "permissions": {},
                            "auth": {"token": token}
                        }
                    }
                    await ws.send(json.dumps(connect_msg))
                    raw2 = await _asyncio.wait_for(ws.recv(), timeout=5)
                    res = json.loads(raw2)
                    if not res.get("ok"):
                        print(f"[WORKFLOW] Gateway auth failed for session abort: {res.get('error', {}).get('message', 'unknown')}")
                        return False

                    # Send chat.abort targeting ONLY this session key
                    abort_msg = {
                        "type": "req",
                        "id": "wf-abort-2",
                        "method": "chat.abort",
                        "params": {
                            "sessionKey": session_key
                        }
                    }
                    await ws.send(json.dumps(abort_msg))
                    raw3 = await _asyncio.wait_for(ws.recv(), timeout=5)
                    res3 = json.loads(raw3)
                    if res3.get("ok"):
                        print(f"[WORKFLOW] Gateway session aborted: {session_key}")
                        return True
                    else:
                        err = res3.get("error", {}).get("message", "unknown")
                        print(f"[WORKFLOW] Gateway session abort response: {err} (key={session_key})")
                        return False

        except Exception as e:
            print(f"[WORKFLOW] Gateway session abort failed for {session_key}: {e}")
            return False

    try:
        loop = _asyncio.get_running_loop()
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(_asyncio.run, _do_abort())
            return future.result(timeout=20)
    except RuntimeError:
        return _asyncio.run(_do_abort())


def _wf_delete_session_via_gateway(session_key):
    """Delete a session from the gateway's in-memory state via WebSocket RPC.

    File-level cleanup alone is not enough — the gateway keeps sessions in memory
    and will keep retrying (with "Continue where you left off") on stale sessions.
    This sends a sessions.delete RPC to properly terminate the session.
    """
    import asyncio as _asyncio

    async def _do_delete():
        try:
            gw_url = VO_CONFIG["openclaw"]["gatewayUrl"]
            origin = f"http://127.0.0.1:{PORT}"
            token = _get_gateway_token()
            if not token:
                print(f"[WORKFLOW] No gateway token — skipping session delete via gateway for {session_key}")
                return False

            import websockets as _ws
            from websockets.asyncio.client import connect as _ws_connect

            async with _asyncio.timeout(15):
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
                        return False

                    # Authenticate
                    connect_msg = {
                        "type": "req",
                        "id": "wf-cleanup-1",
                        "method": "connect",
                        "params": {
                            "minProtocol": GATEWAY_PROTOCOL_VERSION, "maxProtocol": GATEWAY_PROTOCOL_VERSION,
                            "client": {"id": "vo-workflow", "version": "1.0", "platform": "server", "mode": "webchat"},
                            "role": "operator",
                            "scopes": ["operator.read", "operator.write"],
                            "caps": [], "commands": [], "permissions": {},
                            "auth": {"token": token}
                        }
                    }
                    await ws.send(json.dumps(connect_msg))
                    raw2 = await _asyncio.wait_for(ws.recv(), timeout=5)
                    res = json.loads(raw2)
                    if not res.get("ok"):
                        print(f"[WORKFLOW] Gateway auth failed for session delete: {res.get('error', {}).get('message', 'unknown')}")
                        return False

                    # Send sessions.delete
                    delete_msg = {
                        "type": "req",
                        "id": "wf-cleanup-2",
                        "method": "sessions.delete",
                        "params": {
                            "key": session_key,
                            "deleteTranscript": True,
                            "emitLifecycleHooks": False
                        }
                    }
                    await ws.send(json.dumps(delete_msg))
                    raw3 = await _asyncio.wait_for(ws.recv(), timeout=5)
                    res3 = json.loads(raw3)
                    if res3.get("ok"):
                        print(f"[WORKFLOW] Gateway session deleted: {session_key}")
                        return True
                    else:
                        # Session may not exist in gateway memory — that's fine
                        err = res3.get("error", {}).get("message", "unknown")
                        print(f"[WORKFLOW] Gateway session delete response: {err} (key={session_key})")
                        return False

        except Exception as e:
            print(f"[WORKFLOW] Gateway session delete failed for {session_key}: {e}")
            return False

    # Run the async delete — handle both threaded and event-loop contexts
    try:
        loop = _asyncio.get_running_loop()
        # We're inside an async context — schedule as a task
        # Since workflow runs in a sync thread, this shouldn't happen,
        # but handle it gracefully
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(_asyncio.run, _do_delete())
            return future.result(timeout=20)
    except RuntimeError:
        # No running loop — safe to use asyncio.run
        return _asyncio.run(_do_delete())


def _wf_cleanup_task_sessions(agent_id, project_id, task_id):
    if _is_hermes_agent(agent_id):
        return

    """Delete the single session created for this workflow task.

    Two-phase cleanup:
    1. Tell the gateway to drop the session from memory (prevents retry loops)
    2. Delete session files from disk (cleanup storage)

    Phase 1 is critical — without it, the gateway keeps the session alive and
    fires "Continue where you left off" retries that loop forever.
    """
    session_key = _wf_task_session_key(agent_id, project_id, task_id)

    # Phase 1: Delete from gateway's in-memory state
    _wf_delete_session_via_gateway(session_key)

    # Phase 2: Clean up session files on disk
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

        print(f"[WORKFLOW] Cleaned up session files for agent={agent_id} task={task_id[:8]}: {session_key}")
    except Exception as e:
        print(f"[WORKFLOW] Session file cleanup error: {e}")


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
    if _is_hermes_agent(agent_id):
        result = _handle_hermes_chat({"agentId": agent_id, "message": message, "timeoutSec": timeout})
        if result.get("ok"):
            return result.get("reply", "")
        return f"[ERROR] Hermes agent failed: {result.get('error') or result.get('reply') or result}"
    if _is_codex_agent(agent_id):
        result = _handle_codex_chat({"agentId": agent_id, "message": message, "timeoutSec": timeout})
        if result.get("ok"):
            return result.get("reply", "")
        return f"[ERROR] Codex agent failed: {result.get('error') or result.get('reply') or result}"
    if _is_claude_code_agent(agent_id):
        result = _handle_claude_code_chat({"agentId": agent_id, "message": message, "timeoutSec": timeout})
        if result.get("ok"):
            return result.get("reply", "")
        return f"[ERROR] Claude Code agent failed: {result.get('error') or result.get('reply') or result}"
    if _is_opencode_agent(agent_id):
        result = _handle_opencode_chat({"agentId": agent_id, "message": message, "timeoutSec": timeout})
        if result.get("ok"):
            return result.get("reply", "")
        return f"[ERROR] OpenCode agent failed: {result.get('error') or result.get('reply') or result}"
    if _is_antigravity_agent(agent_id):
        result = _handle_antigravity_chat({"agentId": agent_id, "message": message, "timeoutSec": timeout})
        if result.get("ok"):
            return result.get("reply", "")
        return f"[ERROR] Antigravity agent failed: {result.get('error') or result.get('reply') or result}"

    # Use a stable session key per task — reused across all calls for this task
    session_key = None
    if project_id and task_id:
        session_key = _wf_task_session_key(agent_id, project_id, task_id)

    # Try gateway HTTP API first
    result = _wf_call_agent_http(agent_id, message, timeout, session_key=session_key)
    if result is not None and not str(result).startswith("[ERROR] Gateway returned HTTP 5"):
        return result

    # Some OpenClaw installs do not expose a healthy /v1/chat/completions
    # endpoint but the Control UI WebSocket chat path works. Use it before CLI
    # so Dockerized Virtual Office can still deliver cross-platform messages
    # without needing the host openclaw binary inside the container.
    ws_result = _wf_call_agent_ws(agent_id, message, timeout, session_key=session_key)
    if ws_result is not None:
        return ws_result

    # Fall back to CLI (also pass session key if available)
    return _wf_call_agent_cli(agent_id, message, timeout, session_key=session_key)


def _extract_openclaw_text(value):
    """Normalize OpenClaw message/content shapes into plain text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or item.get("message") or ""))
        return "".join(parts).strip()
    if isinstance(value, dict):
        return _extract_openclaw_text(value.get("text") or value.get("content") or value.get("message") or value.get("delta") or "")
    return str(value)


def _wf_call_agent_ws(agent_id, message, timeout, session_key=None):
    """Call an OpenClaw agent through the gateway WebSocket chat path.

    This mirrors the live Virtual Office chat client. It is intentionally a
    fallback for product deployments where the HTTP OpenAI-compatible endpoint
    is unavailable/unhealthy and the openclaw CLI is not present in the Docker
    container.
    """
    token = _get_gateway_token()
    if not token:
        return None
    session_key = session_key or f"agent:{agent_id}:main"
    gw_url = VO_CONFIG.get("openclaw", {}).get("gatewayUrl", "ws://127.0.0.1:18789")
    origin = f"http://127.0.0.1:{PORT}"

    async def _call():
        async with ws_connect(
            gw_url,
            max_size=1024 * 1024,
            additional_headers={"Origin": origin},
            close_timeout=3,
        ) as ws:
            # Challenge
            await asyncio.wait_for(ws.recv(), timeout=5)
            connect_id = f"vo-ws-connect-{uuid.uuid4()}"
            await ws.send(json.dumps({
                "type": "req",
                "id": connect_id,
                "method": "connect",
                "params": {
                    "minProtocol": GATEWAY_PROTOCOL_VERSION,
                    "maxProtocol": GATEWAY_PROTOCOL_VERSION,
                    "client": {"id": "openclaw-control-ui", "version": _get_openclaw_version(), "platform": "web", "mode": "webchat"},
                    "role": "operator",
                    "scopes": ["operator.read", "operator.write", "operator.admin"],
                    "caps": ["tool-events"],
                    "commands": [],
                    "permissions": {},
                    "auth": {"token": token},
                    "locale": "en-US",
                    "userAgent": "virtual-office-server/1.0",
                },
            }))
            # Wait for connect response, ignoring snapshot/events.
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                msg = json.loads(raw)
                if msg.get("id") == connect_id:
                    if not msg.get("ok"):
                        return f"[ERROR] Gateway WS connect failed: {msg.get('error', {}).get('message', 'unknown')}"
                    break

            send_id = f"vo-ws-send-{uuid.uuid4()}"
            await ws.send(json.dumps({
                "type": "req",
                "id": send_id,
                "method": "chat.send",
                "params": {
                    "sessionKey": session_key,
                    "message": message,
                    "idempotencyKey": f"vo-a2a-{uuid.uuid4()}",
                },
            }))
            run_id = None
            final_seen = False
            deadline = time.time() + timeout
            while time.time() < deadline:
                raw = await asyncio.wait_for(ws.recv(), timeout=min(30, max(1, deadline - time.time())))
                msg = json.loads(raw)
                if msg.get("id") == send_id:
                    if not msg.get("ok"):
                        return f"[ERROR] Gateway WS chat.send failed: {msg.get('error', {}).get('message', 'unknown')}"
                    payload = msg.get("payload") or {}
                    run_id = payload.get("runId")
                elif msg.get("event") == "chat":
                    payload = msg.get("payload") or {}
                    if payload.get("sessionKey") == session_key and payload.get("state") in ("final", "done"):
                        text = _extract_openclaw_text(payload.get("text") or payload.get("content") or payload.get("message") or payload.get("delta"))
                        if text:
                            return text
                        final_seen = True
                        break
                    if run_id and payload.get("runId") == run_id and payload.get("state") in ("final", "done"):
                        text = _extract_openclaw_text(payload.get("text") or payload.get("content") or payload.get("message") or payload.get("delta"))
                        if text:
                            return text
                        final_seen = True
                        break
                elif msg.get("event") == "session.message":
                    payload = msg.get("payload") or {}
                    m = payload.get("message") if isinstance(payload.get("message"), dict) else payload
                    if m.get("role") == "assistant" and (payload.get("sessionKey") in (None, session_key) or (run_id and payload.get("runId") == run_id)):
                        text = _extract_openclaw_text(m.get("content") or m.get("text") or m)
                        if text:
                            return text

            # Some gateway versions send final without text; fetch recent history.
            hist_id = f"vo-ws-history-{uuid.uuid4()}"
            await ws.send(json.dumps({"type": "req", "id": hist_id, "method": "chat.history", "params": {"sessionKey": session_key, "limit": 12}}))
            while time.time() < deadline + 10:
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                msg = json.loads(raw)
                if msg.get("id") != hist_id:
                    continue
                if not msg.get("ok"):
                    return "[DELIVERED] Message delivered to OpenClaw agent; history fetch failed."
                payload = msg.get("payload") or {}
                messages = payload.get("messages") or payload.get("items") or payload.get("history") or []
                if isinstance(messages, dict):
                    messages = messages.get("messages") or messages.get("items") or []
                for item in reversed(messages):
                    role = item.get("role") or item.get("senderKind")
                    text = _extract_openclaw_text(item.get("text") or item.get("content") or item.get("message") or item)
                    if role == "assistant" and text:
                        return text
                return "[DELIVERED] Message delivered to OpenClaw agent."
            return "[DELIVERED] Message delivered to OpenClaw agent." if final_seen else None

    try:
        return asyncio.run(_call())
    except Exception as e:
        print(f"[WORKFLOW] Gateway WS agent call failed: {e}")
        return None


def _wf_call_agent_http(agent_id, message, timeout, session_key=None):
    """Try calling agent via gateway /v1/chat/completions. Returns None if not available.
    If session_key is provided, uses it for session routing (enables cleanup later)."""

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

def _wf_task_needs_visual_review(task):
    """Heuristic: determine whether a task should require browser-based review."""
    parts = [
        task.get("title", "") or "",
        task.get("description", "") or "",
    ]
    for item in task.get("checklist") or []:
        parts.append(item.get("text", "") or "")
    hay = "\n".join(parts).lower()

    visual_terms = [
        "ui", "ux", "browser", "page", "screen", "visual", "visually",
        "frontend", "front-end", "layout", "render", "display", "button",
        "form", "modal", "panel", "dashboard", "site", "web app", "webapp",
        "css", "html", "screenshot", "snapshot", "click", "navigation",
        "animation", "canvas", "view", "viewer", "interactive"
    ]
    non_visual_terms = [
        "docs", "documentation", "audit", "analysis", "implementation map",
        "review evidence", "write-up", "writeup", "readme", "markdown"
    ]

    has_visual = any(term in hay for term in visual_terms)
    has_non_visual = any(term in hay for term in non_visual_terms)
    return has_visual and not has_non_visual


def _wf_build_review_prompt(task, task_file_content=None, project=None):
    """Build the self-review prompt for an agent."""
    project_context = ""
    if project:
        project_context = _wf_build_project_context(project, task) + "\n\n"

    items_text = ""
    if task.get("checklist"):
        for i, item in enumerate(task["checklist"], 1):
            items_text += f"  {i}. {item.get('text', '')}\n"

    needs_visual_review = _wf_task_needs_visual_review(task)
    visual_steps = """
3. Use the browser tool to load the running app/site and visually confirm UI changes are working. Take snapshots.
4. If you open any browser/session for review, you MUST close it before finishing your review response. Do not leave browser instances running after review.
5. If you cannot find real file changes for an item, mark it DID_NOT_PASS regardless of what was claimed earlier.""" if needs_visual_review else """
3. Use the browser tool only if the task has a real visual/UI surface that can be meaningfully checked in a running app or site.
4. If you open any browser/session for review, you MUST close it before finishing your review response.
5. If you cannot find real file changes or real deliverables for an item, mark it DID_NOT_PASS regardless of what was claimed earlier."""

    pass_line = "- PASS — verified in the actual files AND confirmed working in the browser/app" if needs_visual_review else "- PASS — verified in the actual files and supported by real verification steps (for example read/exec, and browser if applicable)"
    critical_line = "CRITICAL: You MUST use tools (read, exec, browser) during this review. A text-only review with no tool calls will be considered invalid." if needs_visual_review else "CRITICAL: You MUST use tools during this review. Use read and/or exec for non-visual tasks, and use browser only when the task is visually reviewable. A text-only review with no tool calls will be considered invalid."

    return f"""{project_context}Review your completed work on: {task.get('title', 'Untitled')}

You must INDEPENDENTLY VERIFY each checklist item. Do NOT trust your previous claims — verify by actually checking.

MANDATORY REVIEW STEPS:
1. Use the read tool to open the actual source files that were supposed to be modified. Confirm the changes exist in the code.
2. Use exec to run any tests, linters, or verification commands.
{visual_steps}

For EACH checklist item, respond with one of these statuses:
{pass_line}
- NEEDS_MORE_WORK — partially implemented but has issues you can identify in the code
- DID_NOT_PASS — no real changes found in files, or changes don't work
- REQUIRES_USER_REVIEW — ONLY if the item truly cannot be judged by an agent after using tools, such as a subjective product/design decision, required human sign-off, unavailable external system access that only the user can provide, or a genuinely destructive/approval-gated action. Do NOT use REQUIRES_USER_REVIEW for ordinary coding uncertainty, incomplete implementation, missing evidence, failed verification, or because one item previously needed rework. In those cases you MUST use NEEDS_MORE_WORK or DID_NOT_PASS.

If you can read the code, run tests, inspect outputs, or otherwise verify the implementation yourself, you MUST make your own judgment and use PASS, NEEDS_MORE_WORK, or DID_NOT_PASS.

Respond in this EXACT format (one line per item, after your verification):
REVIEW_ITEM_1: <status>
REVIEW_ITEM_2: <status>
...

Checklist items to review:
{items_text}

{critical_line}"""

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
4. If you open any browser/session during rework or verification, you MUST close it before finishing your response. Do not leave browser instances running.
5. Only fix the items listed above. Do NOT redo work that already passed.
6. In your report, list EVERY file you modified and what you changed.

A reviewer will independently verify your fixes by reading the actual files and browsing the app."""

def _wf_review_had_structured_match(review_results):
    """Check if any review results came from structured line parsing (not defaults/fallbacks).

    Returns True if at least one result was explicitly parsed from a structured
    review line (marked with _parsed=True) or from a freeform-positive fallback.
    Returns False if all results came from the default needs_more_work fill-in
    (marked with _default=True) — indicating the parser couldn't understand the response.
    """
    for r in review_results:
        if r.get("_parsed") or r.get("_fallback"):
            return True
    return False


def _wf_parse_review_response(response_text, checklist, review_cycle=0):
    """Parse the agent's review response into structured results.

    Handles formats like:
      REVIEW_ITEM_1: PASS
      REVIEW_ITEM_2: NEEDS_MORE_WORK
    Or:
      1. PASS
      Item 3: DID_NOT_PASS
    Or freeform lines containing status keywords.

    Important: checks longer status strings first to avoid "PASS" matching "DID_NOT_PASS".

    Fallback behavior for freeform/unstructured responses:
    - If no structured review lines matched, performs sentiment analysis on the full text.
    - If sentiment is positive (pass keywords, no fail keywords), treats as all-pass.
    - If review_cycle >= 3 and all checklist items are marked done, auto-passes.
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
            or re.match(r'^\d+[\.\):\s]', line_stripped)
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
                "_parsed": True,
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
                    "_parsed": True,
                })
                item_idx += 1

    # --- Freeform fallback: if no structured lines matched at all ---
    if not results:
        response_lower = response_text.lower()

        # Positive sentiment keywords (agent says everything is good)
        positive_keywords = [
            "all items verified", "all items are done", "all items pass",
            "everything looks good", "everything is working", "all checks pass",
            "all tasks completed", "all completed", "all done", "looks great",
            "fully implemented", "all requirements met", "verified and working",
            "all items look good", "no issues found", "nothing to fix",
            "approved", "lgtm", "ship it",
        ]
        # Negative sentiment keywords (agent says something is wrong)
        negative_keywords = [
            "needs work", "needs more work", "did not pass", "not working",
            "failed", "missing", "incomplete", "broken", "issues found",
            "not implemented", "needs fix", "needs rework", "does not work",
            "errors", "bugs found", "not done", "partially done",
        ]

        # Count occurrences of positive vs negative keywords in the response.
        # This gives a quantitative signal: if positive_count > 0 and
        # negative_count == 0, the agent is clearly approving.
        positive_count = sum(1 for kw in positive_keywords if kw in response_lower)
        negative_count = sum(1 for kw in negative_keywords if kw in response_lower)

        if negative_count > 0:
            # Negative keywords found — don't auto-pass, fall through to defaults.
            # The agent explicitly flagged issues; treat as needs_more_work.
            pass
        else:
            # No structured lines AND zero negative keywords → treat as all-pass.
            # This covers: (a) positive sentiment ("all items verified"), and
            # (b) neutral/ambiguous text with no negatives ("code looks ready").
            # The spec says: empty results = all-pass, not all-fail.
            if positive_count > 0:
                fallback_reason = "freeform_positive_sentiment"
            else:
                fallback_reason = "freeform_no_negatives"
            for i, item in enumerate(checklist):
                results.append({
                    "id": item.get("id"),
                    "text": item.get("text", ""),
                    "status": "pass",
                    "_fallback": fallback_reason,
                    "_positive_count": positive_count,
                    "_negative_count": negative_count,
                })
            return results

        # Cycle-based fallback: if review_cycle >= 3 and all checklist items
        # are already marked done in the project data, auto-pass even with negatives
        if review_cycle >= 3:
            all_checklist_done = all(item.get("done", False) for item in checklist)
            if all_checklist_done:
                for i, item in enumerate(checklist):
                    results.append({
                        "id": item.get("id"),
                        "text": item.get("text", ""),
                        "status": "pass",
                        "_fallback": "cycle_3_checklist_done",
                    })
                return results

    # If parsing failed or incomplete, default remaining to needs_more_work
    for i in range(len(results), len(checklist)):
        results.append({
            "id": checklist[i].get("id"),
            "text": checklist[i].get("text", ""),
            "status": "needs_more_work",
            "_default": True,
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
            _wf_sync_project_workflow_meta(project_id, active=False, phase="blocked_by_active_task", current_task_id=active_task["id"], active_agent=active_task.get("assignee"))
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
            _wf_sync_project_workflow_meta(project_id, active=False, phase="idle", current_task_id=None, active_agent=None)
            break

        task_id = task["id"]
        assignee = task.get("assignee")
        if not assignee:
            # Skip unassigned tasks
            with _WORKFLOW_LOCK:
                wf["phase"] = "error"
                wf["error"] = "Please assign an agent to all tasks"
                wf["active"] = False
            break

        with _WORKFLOW_LOCK:
            wf["currentTaskId"] = task_id
            wf["phase"] = "dispatching"
            wf["error"] = None
        _wf_sync_project_workflow_meta(project_id, active=True, phase="dispatching", current_task_id=task_id, active_agent=assignee)
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

        # Clean up any stale session from a previous run of this task.
        # Without this, the gateway may still hold an old session in memory
        # and fire "Continue where you left off" instead of the actual task prompt.
        _wf_cleanup_task_sessions(assignee, project_id, task_id)

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
        wf["_parseFailCount"] = 0  # Track consecutive parse failures for safety cap
        wf["_reworkCount"] = 0     # Track total consecutive rework cycles for safety cap

        while review_cycle < max_review_cycles and not stop_flag.is_set():
            review_cycle += 1
            with _WORKFLOW_LOCK:
                wf["phase"] = "reviewing"
                wf["reviewCycle"] = review_cycle
            _wf_sync_project_workflow_meta(project_id, active=True, phase="reviewing", current_task_id=task_id, active_agent=assignee)
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

            # Parse review results (pass review_cycle for freeform fallback logic)
            review_results = _wf_parse_review_response(review_response, checklist, review_cycle=review_cycle)

            # Save review results to task
            _wf_update_task_field(project_id, task_id, "reviewCheck", review_results)
            review_activity = _wf_extract_session_activity(assignee, project_id, task_id)
            review_activity_text = _wf_format_activity_summary(review_activity)
            _wf_write_task_file(project_id, task, "review", review_results=review_results, work_log_entry=f"Review cycle {review_cycle}:\n{review_response[:2000]}\n\n**Review verification activity:**\n{review_activity_text}")

            # ── TOOL-CALL VERIFICATION ──────────────────────────────
            # A valid review MUST include actual tool usage to verify the work.
            # For visual/UI tasks, browser review is strongly expected.
            # For non-visual tasks, read/exec verification is enough.
            # Exception: cycle >= 4 with all checklist done bypasses this
            # to prevent infinite loops when the agent refuses to use tools.
            review_tool_count = review_activity.get("tool_call_count", 0)
            review_has_reads = len(review_activity.get("files_read", [])) > 0
            review_has_exec = len(review_activity.get("exec_commands", [])) > 0
            review_has_browser = len(review_activity.get("browser_actions", [])) > 0
            task_needs_visual_review = _wf_task_needs_visual_review(task)
            review_verified = review_has_reads or review_has_exec or review_has_browser
            review_visual_verified = review_has_browser if task_needs_visual_review else True

            # Track whether the original parse had structured matches (before
            # tool-verification may override the result). This is used by the
            # safety cap below to detect repeated parse failures even when
            # freeform-fallback temporarily marks everything as pass.
            original_had_structured = _wf_review_had_structured_match(review_results)

            # Check results
            all_pass = all(r.get("status") == "pass" for r in review_results)
            needs_user = any(r.get("status") == "requires_user_review" for r in review_results)
            failed_items = [r for r in review_results if r.get("status") in ("needs_more_work", "did_not_pass")]

            # Reject reviews that claim all-pass without required verification.
            if all_pass and (not review_verified or not review_visual_verified):
                all_checklist_done = all(item.get("done", False) for item in checklist)
                if review_cycle >= 4 and all_checklist_done:
                    _wf_write_task_file(project_id, task, "review",
                        work_log_entry=f"⚠️ Review cycle {review_cycle}: accepted without full verification (all checklist items done, cycle limit reached)")
                else:
                    all_pass = False
                    failed_items = review_results
                    reason = "used no tools (read/exec/browser) to verify"
                    if review_verified and not review_visual_verified:
                        reason = "did not use browser verification for a visually reviewable task"
                    _wf_write_task_file(project_id, task, "review",
                        work_log_entry=f"❌ Review cycle {review_cycle}: REJECTED — agent claimed PASS but {reason}. {review_tool_count} total tool calls.")

            if all_pass:
                wf["_reworkCount"] = 0
                wf["_parseFailCount"] = 0
                task_done = True
                break

            if needs_user:
                # Pause workflow — user must intervene
                with _WORKFLOW_LOCK:
                    wf["phase"] = "awaiting_user_review"
                    wf["error"] = "Task requires user review for some items"
                _wf_sync_project_workflow_meta(project_id, active=True, phase="awaiting_user_review", current_task_id=task_id, active_agent=assignee)
                _wf_persist_state(project_id)
                _wf_write_task_file(project_id, task, "review", review_results=review_results, work_log_entry="Workflow paused — requires user review")
                # Wait until user resolves or stop
                while not stop_flag.is_set():
                    time.sleep(5)
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
                # Safety cap: track consecutive rework cycles where the parser
                # couldn't extract structured review lines. Uses original_had_structured
                # (computed BEFORE tool-verification may override all_pass→failed)
                # so that freeform-positive responses that get rejected by tool-check
                # still count as parse failures.
                if not original_had_structured:
                    parse_fail_count = wf.get("_parseFailCount", 0) + 1
                    wf["_parseFailCount"] = parse_fail_count
                else:
                    wf["_parseFailCount"] = 0
                    parse_fail_count = 0

                # Also track total consecutive rework cycles (regardless of parse
                # success) to catch loops where the agent keeps failing for any reason.
                rework_count = wf.get("_reworkCount", 0) + 1
                wf["_reworkCount"] = rework_count

                # Escalate at 3 consecutive parse failures OR 3 total reworks with
                # the same pattern (prevents loops from any cause, not just parse).
                should_escalate = parse_fail_count >= 3 or rework_count >= 3
                if should_escalate:
                    reason_parts = []
                    if parse_fail_count >= 3:
                        reason_parts.append(f"parser failed to match structured output for {parse_fail_count} consecutive cycles")
                    if rework_count >= 3:
                        reason_parts.append(f"task has been reworked {rework_count} consecutive times")
                    reason = "; ".join(reason_parts)

                    with _WORKFLOW_LOCK:
                        wf["phase"] = "awaiting_human_intervention"
                        wf["error"] = (
                            f"Review loop safety cap triggered: {reason}. "
                            f"The reviewing agent may be responding with freeform text "
                            f"or the task may be stuck. Please review manually."
                        )
                    _wf_sync_project_workflow_meta(project_id, active=True, phase="awaiting_human_intervention", current_task_id=task_id, active_agent=assignee)
                    _wf_persist_state(project_id)
                    _wf_write_task_file(
                        project_id, task, "review",
                        review_results=review_results,
                        work_log_entry=f"⚠️ Escalated to user — {reason}. Last response:\n{review_response[:1000]}"
                    )
                    break

                # Move back to In Progress for rework
                with _WORKFLOW_LOCK:
                    wf["phase"] = "reworking"
                _wf_update_task_field(project_id, task_id, "lastReviewCheck", review_results)
                _wf_sync_project_workflow_meta(project_id, active=True, phase="reworking", current_task_id=task_id, active_agent=assignee)
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
            _wf_sync_project_workflow_meta(project_id, active=(not single_task), phase="task_done", current_task_id=None, active_agent=None)
            _wf_persist_state(project_id)

            if single_task:
                # Auto Mode OFF — stop after one task
                with _WORKFLOW_LOCK:
                    wf["active"] = False
                break
            else:
                # Auto Mode ON — continue to next task
                time.sleep(2)  # Brief pause between tasks
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
            _wf_sync_project_workflow_meta(project_id, active=True, phase="awaiting_human_intervention", current_task_id=task_id, active_agent=assignee)
            _wf_persist_state(project_id)

            # Wait until human resolves (moves task to done/backlog, or restarts workflow)
            while not stop_flag.is_set():
                time.sleep(5)
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
                time.sleep(2)
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
    # Also write shared project-work signal file so other VO instances
    # can show project work indicators.
    # This file lives in ~/.openclaw/shared/ which is mounted by all VOs.
    _wf_update_shared_project_work()


def _wf_update_shared_project_work():
    """Write active project-work data to a shared file readable by all VO instances.
    Maps agent IDs to their active project task info."""
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
                "updatedAt": int(time.time() * 1000),
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
    if _is_hermes_agent(agent_id):
        agent = _get_hermes_agent(agent_id) or {}
        profile = agent.get("profile") or agent.get("providerAgentId") or "default"
        return _load_hermes_history(profile)[-max_messages:]

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
                            # Build a human-readable summary instead of bare tool name
                            summary = name
                            if isinstance(args, dict):
                                if name in ("read", "Read") and (args.get("file") or args.get("path") or args.get("file_path")):
                                    fpath = args.get("file") or args.get("path") or args.get("file_path") or ""
                                    summary = f"Reading {fpath.split('/')[-1] if '/' in fpath else fpath}"
                                elif name in ("edit", "Edit"):
                                    fpath = args.get("file") or args.get("path") or args.get("file_path") or ""
                                    summary = f"Editing {fpath.split('/')[-1] if '/' in fpath else fpath}"
                                elif name in ("write", "Write"):
                                    fpath = args.get("file") or args.get("path") or args.get("file_path") or ""
                                    summary = f"Writing {fpath.split('/')[-1] if '/' in fpath else fpath}"
                                elif name == "exec":
                                    cmd = args.get("command", "")
                                    summary = f"Running: {cmd[:80]}" if cmd else "exec"
                                elif name == "web_search":
                                    query = args.get("query", "")
                                    summary = f"Searching: {query[:60]}" if query else "web_search"
                                elif name == "web_fetch":
                                    url = args.get("url", "")
                                    summary = f"Fetching: {url[:60]}" if url else "web_fetch"
                                elif name == "browser":
                                    action = args.get("action", "")
                                    summary = f"Browser: {action}" if action else "browser"
                                elif name == "sessions_send":
                                    target = args.get("sessionKey") or args.get("label") or ""
                                    summary = f"Messaging: {target[:40]}" if target else "sessions_send"
                            tool_info.append({"name": summary, "args_preview": ""})
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
    if _is_hermes_agent(agent_id):
        agent = _get_hermes_agent(agent_id) or {}
        key = agent.get("statusKey") or agent.get("id") or agent_id
        presence = _get_normalized_presence_state().get(key, {})
        return presence.get("state") in {"working", "finishing"} and str(presence.get("source") or "").startswith("hermes")

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
    p["workflowPhase"] = "starting"
    p["activeTaskId"] = None
    p["activeAgent"] = None
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
    current_task_id = None
    with _WORKFLOW_LOCK:
        wf = _WORKFLOW_STATE.get(project_id)
        if not wf or not wf.get("active"):
            return {"ok": True, "status": "already_stopped"}
        current_task_id = wf.get("currentTaskId")
        wf["stopFlag"].set()
        wf["active"] = False
        wf["phase"] = "stopped"
        wf["currentTaskId"] = None

    _wf_persist_state(project_id)
    _wf_clear_persisted_state(project_id)

    # Update project
    data = _load_projects()
    p = next((x for x in data["projects"] if x["id"] == project_id), None)
    if p:
        p["workflowActive"] = False
        p["workflowPhase"] = "stopped"
        p["activeTaskId"] = None
        p["activeAgent"] = None
        p["updatedAt"] = _proj_now()
        _save_projects(data)
        _log_activity(p, "workflow_stopped", "user", "Workflow stopped by user")

    # Abort the running agent session for the active task, then clean up.
    # This sends chat.abort to the gateway which immediately kills any in-flight
    # LLM inference — only targets this specific task session, not the agent's
    # main session or other workflow sessions.
    if current_task_id and p:
        task = next((t for t in p.get("tasks", []) if t["id"] == current_task_id), None)
        if task and task.get("assignee"):
            session_key = _wf_task_session_key(task["assignee"], project_id, current_task_id)
            _wf_abort_task_session(session_key)
            _wf_cleanup_task_sessions(task["assignee"], project_id, current_task_id)

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
    if current_task and not active and phase != "stopped":
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
        "activeAgent": next((t.get("assignee") for t in p.get("tasks", []) if t.get("id") == current_task), None) if current_task else None,
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
    """Delete an agent from its backing platform."""
    agent_id = (body.get("id") or "").strip()
    if not agent_id:
        return {"error": "Agent ID is required", "_status": 400}

    # Safety: never delete the main agent
    if agent_id == "main":
        return {"error": "Cannot delete the main agent", "_status": 403}

    try:
        agent = _office_agent_lookup(agent_id)
        provider_kind = (agent or {}).get("providerKind", "openclaw")
        if provider_kind == "hermes" or agent_id.startswith("hermes-"):
            profile = (agent or {}).get("providerAgentId") or agent_id.replace("hermes-", "", 1)
            provider = HermesProvider(
                home_path=VO_CONFIG.get("hermes", {}).get("homePath"),
                binary=VO_CONFIG.get("hermes", {}).get("binary"),
                enabled=VO_CONFIG.get("hermes", {}).get("enabled", True),
                timeout_sec=VO_CONFIG.get("hermes", {}).get("timeoutSec", 600),
            )
            result = provider.delete_agent(profile)
            if not result.get("ok"):
                return {"error": result.get("error", "Hermes agent delete failed"), "_status": 500}
            try:
                os.remove(_hermes_history_path(profile))
            except FileNotFoundError:
                pass
            except OSError as e:
                print(f"[HERMES] Failed to remove VO history for deleted profile {profile}: {e}")
        elif provider_kind == "codex" or agent_id.startswith("codex-"):
            profile = (agent or {}).get("providerAgentId") or agent_id.replace("codex-", "", 1)
            result = _codex_provider().delete_agent(profile)
            if not result.get("ok"):
                return {"error": result.get("error", "Codex agent delete failed"), "_status": 500}
            try:
                os.remove(_codex_history_path(profile))
            except FileNotFoundError:
                pass
            except OSError as e:
                print(f"[CODEX] Failed to remove VO history for deleted profile {profile}: {e}")
        elif provider_kind == "claude-code" or agent_id.startswith("claude-code-"):
            profile = (agent or {}).get("providerAgentId") or agent_id.replace("claude-code-", "", 1)
            result = _claude_code_provider().delete_agent(profile)
            if not result.get("ok"):
                return {"error": result.get("error", "Claude Code agent delete failed"), "_status": 500}
            try:
                os.remove(_claude_code_history_path(profile))
            except FileNotFoundError:
                pass
            except OSError as e:
                print(f"[CLAUDE_CODE] Failed to remove VO history for deleted profile {profile}: {e}")
        elif provider_kind == "opencode" or agent_id.startswith("opencode-"):
            profile = (agent or {}).get("providerAgentId") or agent_id.replace("opencode-", "", 1)
            result = _opencode_provider().delete_agent(profile)
            if not result.get("ok"):
                return {"error": result.get("error", "OpenCode agent delete failed"), "_status": 500}
            try:
                os.remove(_opencode_history_path(profile))
            except FileNotFoundError:
                pass
            except OSError as e:
                print(f"[OPENCODE] Failed to remove VO history for deleted profile {profile}: {e}")
        elif provider_kind == "antigravity" or agent_id.startswith("antigravity-"):
            return {"error": "The built-in Antigravity agent cannot be deleted from Virtual Office.", "_status": 403}
        else:
            result = _gateway_rpc_call("agents.delete", {"agentId": agent_id, "deleteFiles": True}, timeout=30)
            if not result.get("ok"):
                status = 404 if "not found" in str(result.get("error", "")).lower() else 500
                return {"error": result.get("error", "OpenClaw agent delete failed"), "_status": status}
            _remove_openclaw_agent_paths(agent_id)

        # Refresh discovery
        global _discovered_at
        _discovered_at = 0
        refresh_agent_maps()

        return {
            "ok": True,
            "agentId": agent_id,
            "message": f"Agent '{agent_id}' deleted successfully"
        }

    except Exception as e:
        traceback.print_exc()
        return {"error": str(e), "_status": 500}


##############################################################################

# ─── UNIFIED CHAT SESSIONS (per-framework session management) ───────────────
# Normalizes OpenClaw gateway/file sessions, Hermes CLI sessions, Codex
# app-server threads, and Claude Code JSONL sessions for the chat sessions drawer.

CHAT_SESSION_SCHEMA_VERSION = "vo-chat-sessions/v1"


def _chat_sessions_agent(agent_id):
    agent = _find_agent_record(agent_id)
    if not agent:
        return None
    return {
        "agentId": agent.get("statusKey") or agent.get("id"),
        "providerKind": str(agent.get("providerKind") or "openclaw").lower(),
        "profile": agent.get("profile") or agent.get("providerAgentId") or agent.get("id"),
        "name": agent.get("name") or agent.get("id"),
        "record": agent,
    }


def _openclaw_live_mode_session_key(agent_id):
    return f"agent:{agent_id}:vw-live-mode-planner"


def _openclaw_live_mode_enabled(agent_id):
    state_fn = globals().get("get_live_agent_loop_state")
    if callable(state_fn):
        try:
            state = state_fn(persist_migration=False)
            agent_state = (state.get("agents") or {}).get(agent_id) or {}
            return bool(agent_state.get("enabled"))
        except Exception:
            pass
    features = VO_CONFIG.get("features", {}) if isinstance(VO_CONFIG.get("features"), dict) else {}
    live_cfg = features.get("liveAgentMode") if isinstance(features.get("liveAgentMode"), dict) else {}
    return bool(live_cfg.get(agent_id) or live_cfg.get("enabled"))


def _openclaw_session_key_for_agent(agent_id, session_key="", default_bucket="main"):
    safe_agent = _safe_openclaw_agent_id(agent_id)
    prefix = f"agent:{safe_agent}:"
    raw = str(session_key or "").strip()
    if not raw:
        return f"{prefix}{default_bucket}" if default_bucket else ""
    if raw.startswith(prefix) and len(raw) > len(prefix):
        return raw
    if re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", raw):
        return f"{prefix}{raw}"
    return ""


def _chat_sessions_openclaw_entry(agent_id, session_key, row=None, live_action_running=False):
    key = _openclaw_session_key_for_agent(agent_id, session_key, default_bucket="")
    if not key:
        return None
    prefix = f"agent:{_safe_openclaw_agent_id(agent_id)}:"
    kind = key[len(prefix):]
    is_live_planner = kind == "vw-live-mode-planner"
    row = row if isinstance(row, dict) else {}
    title = str(row.get("label") or row.get("title") or row.get("name") or "").strip()
    if not title:
        title = "Live Agent Mode" if is_live_planner else ("Main chat" if kind == "main" else kind)
    return {
        "id": key,
        "sessionKey": key,
        "title": title[:200],
        "preview": str(row.get("preview") or row.get("lastMessage") or row.get("summary") or "")[:300],
        "updatedAt": row.get("updatedAt") or row.get("lastActiveAt") or row.get("createdAt"),
        "kind": "live-mode" if is_live_planner else ("main" if kind == "main" else "other"),
        "liveMode": is_live_planner,
        "active": bool(is_live_planner and live_action_running),
        "deletable": kind != "main",
    }


def _chat_sessions_list_openclaw_files(agent_id, live_action_running=False, limit=200):
    sessions_dir = os.path.join(WORKSPACE_BASE, "agents", _safe_openclaw_agent_id(agent_id), "sessions")
    sessions_json_path = os.path.join(sessions_dir, "sessions.json")
    try:
        with open(sessions_json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    if not isinstance(data, dict):
        return []
    entries = []
    for session_key, row in data.items():
        if not isinstance(row, dict):
            continue
        entry = _chat_sessions_openclaw_entry(agent_id, session_key, row, live_action_running=live_action_running)
        if not entry:
            continue
        if not entry.get("updatedAt"):
            session_id = str(row.get("sessionId") or "").strip()
            candidates = [
                os.path.join(sessions_dir, f"{session_id}.jsonl") if session_id else "",
                os.path.join(sessions_dir, f"{session_id}.trajectory.jsonl") if session_id else "",
            ]
            mtimes = []
            for path in candidates:
                try:
                    if path:
                        mtimes.append(os.stat(path).st_mtime)
                except OSError:
                    pass
            if mtimes:
                entry["updatedAt"] = _epoch_to_utc_iso(max(mtimes))
        entries.append(entry)
    entries.sort(key=lambda s: _parse_iso_epoch_ms(s.get("updatedAt")), reverse=True)
    return entries[: max(1, int(limit))]


def _merge_openclaw_session_entries(entries):
    merged = {}
    for entry in entries:
        if not isinstance(entry, dict) or not entry.get("id"):
            continue
        existing = merged.get(entry["id"], {})
        row = dict(existing)
        for key, value in entry.items():
            if value not in (None, "", []):
                row[key] = value
        if "deletable" in entry:
            row["deletable"] = bool(entry.get("deletable"))
        if entry.get("active"):
            row["active"] = True
        merged[entry["id"]] = row
    return list(merged.values())


def _chat_sessions_list_openclaw(agent_ref, limit=40):
    agent_id = agent_ref["agentId"]
    live_action_running = _openclaw_live_mode_enabled(agent_id)
    file_sessions = _chat_sessions_list_openclaw_files(agent_id, live_action_running=live_action_running, limit=max(200, int(limit) * 5))
    gateway_sessions = []
    gateway_error = ""
    res = _gateway_rpc_call("sessions.list", {"limit": max(200, int(limit) * 5)}, timeout=15)
    if res.get("ok"):
        rows = res.get("sessions")
        if not isinstance(rows, list):
            payload = res.get("payload") if isinstance(res.get("payload"), dict) else {}
            rows = payload.get("sessions") if isinstance(payload.get("sessions"), list) else []
        for row in rows:
            if not isinstance(row, dict):
                continue
            entry = _chat_sessions_openclaw_entry(agent_id, str(row.get("key") or row.get("sessionKey") or ""), row, live_action_running=live_action_running)
            if entry:
                gateway_sessions.append(entry)
    else:
        gateway_error = str(res.get("error") or "sessions.list failed")
    sessions = _merge_openclaw_session_entries([*file_sessions, *gateway_sessions])
    if live_action_running and not any(s.get("liveMode") for s in sessions):
        sessions.insert(0, {
            "id": _openclaw_live_mode_session_key(agent_id),
            "sessionKey": _openclaw_live_mode_session_key(agent_id),
            "title": "Live Agent Mode",
            "preview": "Active autonomous mode session",
            "updatedAt": None,
            "kind": "live-mode",
            "liveMode": True,
            "active": True,
            "deletable": False,
            "virtual": True,
        })
    sessions.sort(key=lambda s: _parse_iso_epoch_ms(s.get("updatedAt")), reverse=True)
    if sessions or not gateway_error:
        return {"ok": True, "sessions": sessions[: max(1, int(limit))]}
    return {"ok": False, "error": gateway_error, "sessions": []}


def _chat_sessions_list_hermes(agent_ref, limit=40):
    provider = _hermes_provider(agent_ref.get("record") or {})
    profile = agent_ref["profile"] or "default"
    outcome = provider.list_sessions(profile, limit=limit)
    if not outcome.get("ok"):
        return {"ok": False, "error": outcome.get("error"), "sessions": []}
    active_id = _get_hermes_session_id(profile)
    sessions = []
    for row in outcome.get("sessions") or []:
        sessions.append({
            "id": row.get("id"),
            "sessionKey": f"hermes:{profile}:{row.get('id')}",
            "title": row.get("title") or row.get("id"),
            "preview": row.get("preview") or "",
            "updatedAt": row.get("lastActive") or None,
            "kind": "chat",
            "liveMode": False,
            "active": bool(active_id and row.get("id") == active_id),
            "deletable": True,
        })
    return {"ok": True, "sessions": sessions}


def _chat_sessions_list_codex(agent_ref, limit=40):
    provider = _codex_provider()
    profile = agent_ref["profile"] or "main"
    outcome = provider.list_threads(profile, limit=limit)
    if not outcome.get("ok"):
        return {"ok": False, "error": outcome.get("error"), "sessions": []}
    active_id = _get_codex_session_id(profile)
    sessions = []
    for row in outcome.get("sessions") or []:
        if row.get("archived"):
            continue
        sessions.append({
            "id": row.get("id"),
            "sessionKey": f"codex:{profile}:{row.get('id')}",
            "title": row.get("title") or row.get("id"),
            "preview": row.get("preview") or "",
            "updatedAt": row.get("updatedAt"),
            "kind": "chat",
            "liveMode": False,
            "active": bool(active_id and row.get("id") == active_id),
            "deletable": True,
        })
    return {"ok": True, "sessions": sessions}


def _chat_sessions_list_opencode(agent_ref, limit=40):
    provider = _opencode_provider()
    profile = agent_ref["profile"] or "main"
    outcome = provider.list_sessions(profile, limit=limit)
    if not outcome.get("ok"):
        return {"ok": False, "error": outcome.get("error"), "sessions": []}
    active_id = _get_opencode_session_id(profile)
    sessions = []
    for row in outcome.get("sessions") or []:
        session_id = row.get("id")
        if not session_id:
            continue
        sessions.append({
            "id": session_id,
            "sessionKey": f"opencode:{profile}:{session_id}",
            "title": row.get("title") or session_id,
            "preview": row.get("preview") or "",
            "updatedAt": row.get("updatedAt") or row.get("lastActive") or None,
            "kind": "chat",
            "liveMode": False,
            "active": bool(active_id and session_id == active_id),
            "deletable": True,
        })
    return {"ok": True, "sessions": sessions, "resumeCommand": "opencode run --session <session-id>"}


def _chat_sessions_list_antigravity(agent_ref, limit=40):
    return {
        "ok": True,
        "sessions": [],
        "note": "Antigravity is a one-shot CLI provider; Virtual Office stores local history, but there are no native sessions to list.",
    }


def _claude_code_home_path():
    cfg = VO_CONFIG.get("claudeCode", {}) or {}
    return os.path.expanduser(str(os.environ.get("VO_CLAUDE_CODE_HOME") or os.environ.get("CLAUDE_CONFIG_DIR") or cfg.get("homePath") or "~/.claude"))


def _claude_code_projects_dir():
    return os.path.join(_claude_code_home_path(), "projects")


def _claude_code_valid_session_id(session_id):
    text = str(session_id or "").strip()
    return text if re.fullmatch(r"[A-Za-z0-9_.:-]{8,128}", text) else ""


def _claude_code_text_from_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
                parts.append(str(item.get("text") or ""))
        return "\n".join(parts)
    if isinstance(content, dict):
        return str(content.get("text") or "")
    return ""


def _claude_code_session_records(limit=80):
    projects_dir = _claude_code_projects_dir()
    if not os.path.isdir(projects_dir):
        return []
    records = []
    for path in glob.glob(os.path.join(projects_dir, "*", "*.jsonl")):
        if ".deleted." in os.path.basename(path):
            continue
        session_id = _claude_code_valid_session_id(os.path.splitext(os.path.basename(path))[0])
        if not session_id:
            continue
        title = ""
        preview = ""
        cwd = ""
        updated_at = None
        try:
            stat = os.stat(path)
            updated_at = _epoch_to_utc_iso(stat.st_mtime)
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(row, dict):
                        continue
                    if row.get("sessionId"):
                        session_id = str(row.get("sessionId") or session_id)
                    if row.get("cwd") and not cwd:
                        cwd = str(row.get("cwd") or "")
                    if row.get("timestamp"):
                        updated_at = row.get("timestamp")
                    if row.get("type") == "last-prompt" and row.get("lastPrompt"):
                        title = str(row.get("lastPrompt") or "").replace("\n", " ").strip()[:120]
                    message = row.get("message") if isinstance(row.get("message"), dict) else {}
                    role = message.get("role") or row.get("type")
                    text = _claude_code_text_from_content(message.get("content") if message else row.get("content")).strip()
                    if text and role in ("user", "assistant"):
                        if not title and role == "user":
                            title = text.replace("\n", " ").strip()[:120]
                        preview = text.replace("\n", " ").strip()[:300]
        except OSError:
            continue
        records.append({"id": session_id, "path": path, "title": title or session_id, "preview": preview, "updatedAt": updated_at, "cwd": cwd})
    records.sort(key=lambda row: str(row.get("updatedAt") or ""), reverse=True)
    return records[: max(1, int(limit))]


def _claude_code_find_session_file(session_id):
    wanted = _claude_code_valid_session_id(session_id)
    if not wanted:
        return ""
    for row in _claude_code_session_records(limit=500):
        if str(row.get("id") or "") == wanted:
            return str(row.get("path") or "")
    return ""


def _chat_sessions_list_claude_code(agent_ref, limit=40):
    cfg = VO_CONFIG.get("claudeCode", {}) or {}
    home_path = _claude_code_home_path()
    if not os.path.isdir(home_path):
        return {"ok": False, "error": f"Claude Code home not found at {home_path}", "sessions": []}
    active_id = _get_claude_code_session_id(agent_ref["profile"] or "main")
    sessions = []
    for row in _claude_code_session_records(limit=limit):
        session_id = row.get("id")
        sessions.append({
            "id": session_id,
            "sessionKey": f"claude-code:{agent_ref['profile']}:{session_id}",
            "title": row.get("title") or session_id,
            "preview": row.get("preview") or "",
            "updatedAt": row.get("updatedAt"),
            "kind": "chat",
            "liveMode": False,
            "active": bool(active_id and session_id == active_id),
            "deletable": True,
            "cwd": row.get("cwd") or "",
        })
    return {"ok": True, "sessions": sessions, "binary": str(cfg.get("binary") or "claude"), "homePath": home_path, "resumeCommand": "claude --resume <session-id>"}


def handle_chat_sessions_list(agent_id, limit=40):
    agent_ref = _chat_sessions_agent(agent_id)
    if not agent_ref:
        return {"ok": False, "error": f"Unknown agent: {agent_id}", "sessions": []}, 404
    kind = agent_ref["providerKind"]
    if kind == "hermes":
        outcome = _chat_sessions_list_hermes(agent_ref, limit=limit)
    elif kind == "codex":
        outcome = _chat_sessions_list_codex(agent_ref, limit=limit)
    elif kind == "opencode":
        outcome = _chat_sessions_list_opencode(agent_ref, limit=limit)
    elif kind == "antigravity":
        outcome = _chat_sessions_list_antigravity(agent_ref, limit=limit)
    elif kind == "openclaw":
        outcome = _chat_sessions_list_openclaw(agent_ref, limit=limit)
    elif kind in ("claude-code", "claudecode", "claude"):
        outcome = _chat_sessions_list_claude_code(agent_ref, limit=limit)
    else:
        outcome = {"ok": False, "error": f"{kind} session management is not supported yet", "sessions": []}
    status = 200 if outcome.get("ok") else 502
    return {"schemaVersion": CHAT_SESSION_SCHEMA_VERSION, "agentId": agent_ref["agentId"], "providerKind": kind, "profile": agent_ref["profile"], **outcome}, status


def handle_chat_session_create(agent_id, body=None):
    agent_ref = _chat_sessions_agent(agent_id)
    if not agent_ref:
        return {"ok": False, "error": f"Unknown agent: {agent_id}"}, 404
    kind = agent_ref["providerKind"]
    profile = agent_ref["profile"]
    if kind == "hermes":
        _save_hermes_state(profile, {"messages": [], "sessionId": ""})
        return {"ok": True, "providerKind": kind, "profile": profile, "sessionId": "", "note": "New Hermes session starts with the next message."}, 200
    if kind == "codex":
        _save_codex_state(profile, {"messages": [], "sessionId": ""})
        _clear_codex_token_usage(profile)
        return {"ok": True, "providerKind": kind, "profile": profile, "sessionId": "", "note": "New Codex thread starts with the next message."}, 200
    if kind == "opencode":
        _save_opencode_state(profile, {"messages": [], "sessionId": ""})
        return {"ok": True, "providerKind": kind, "profile": profile, "sessionId": "", "note": "New OpenCode session starts with the next message."}, 200
    if kind == "antigravity":
        _save_antigravity_state(profile, {"messages": []})
        return {"ok": True, "providerKind": kind, "profile": profile, "sessionId": "", "note": "Antigravity is one-shot; local history was cleared."}, 200
    if kind in ("claude-code", "claudecode", "claude"):
        _save_claude_code_state(profile, {"messages": [], "sessionId": ""})
        _clear_claude_code_token_usage(profile)
        return {"ok": True, "providerKind": kind, "profile": profile, "sessionId": "", "note": "New Claude Code session starts with the next message."}, 200
    if kind == "openclaw":
        session_key = _openclaw_session_key_for_agent(agent_ref["agentId"], (body or {}).get("sessionKey"), default_bucket="main")
        if not session_key:
            return {"ok": False, "error": "Invalid session key for this agent"}, 400
        res = _gateway_rpc_call("sessions.reset", {"key": session_key}, timeout=15)
        if not res.get("ok"):
            return {"ok": False, "error": str(res.get("error") or "sessions.reset failed")}, 502
        return {"ok": True, "providerKind": kind, "sessionKey": session_key}, 200
    return {"ok": False, "error": f"{kind} session management is not supported yet"}, 400


def handle_chat_session_delete(agent_id, session_id, body=None):
    agent_ref = _chat_sessions_agent(agent_id)
    if not agent_ref:
        return {"ok": False, "error": f"Unknown agent: {agent_id}"}, 404
    if not session_id:
        return {"ok": False, "error": "sessionId is required"}, 400
    kind = agent_ref["providerKind"]
    profile = agent_ref["profile"]
    if kind == "hermes":
        outcome = _hermes_provider(agent_ref.get("record") or {}).delete_session(profile, session_id)
        if outcome.get("ok") and _get_hermes_session_id(profile) == session_id:
            _save_hermes_state(profile, {"messages": [], "sessionId": ""})
        return outcome, 200 if outcome.get("ok") else 502
    if kind == "codex":
        outcome = _codex_provider().delete_thread(profile, session_id)
        if outcome.get("ok") and _get_codex_session_id(profile) == session_id:
            _save_codex_state(profile, {"messages": [], "sessionId": ""})
            _clear_codex_token_usage(profile)
        return outcome, 200 if outcome.get("ok") else 502
    if kind == "opencode":
        outcome = _opencode_provider().delete_session(profile, session_id)
        if outcome.get("ok") and _get_opencode_session_id(profile) == session_id:
            _save_opencode_state(profile, {"messages": [], "sessionId": ""})
        return outcome, 200 if outcome.get("ok") else 502
    if kind == "antigravity":
        return {"ok": False, "error": "Antigravity does not expose native sessions to delete"}, 400
    if kind in ("claude-code", "claudecode", "claude"):
        path = _claude_code_find_session_file(session_id)
        if not path:
            return {"ok": False, "error": "Claude Code session not found"}, 404
        deleted_path = f"{path}.deleted.{_utc_now_iso().replace(':', '-')}"
        try:
            os.replace(path, deleted_path)
        except OSError as exc:
            return {"ok": False, "error": str(exc)}, 500
        if _get_claude_code_session_id(profile) == session_id:
            _save_claude_code_state(profile, {"messages": [], "sessionId": ""})
            _clear_claude_code_token_usage(profile)
        return {"ok": True, "deleted": True, "sessionId": session_id, "deletedPath": deleted_path}, 200
    if kind == "openclaw":
        session_key = _openclaw_session_key_for_agent(agent_ref["agentId"], session_id, default_bucket="")
        if not session_key:
            return {"ok": False, "error": "Invalid session key for this agent"}, 400
        if session_key.endswith(":main"):
            return {"ok": False, "error": "The main session cannot be deleted; use new session to reset it."}, 400
        res = _gateway_rpc_call("sessions.delete", {"key": session_key, "deleteTranscript": True}, timeout=15)
        if not res.get("ok"):
            return {"ok": False, "error": str(res.get("error") or "sessions.delete failed")}, 502
        return {"ok": True, "deleted": True, "sessionKey": session_key}, 200
    return {"ok": False, "error": f"{kind} session management is not supported yet"}, 400


def handle_chat_session_switch(agent_id, session_id, body=None):
    agent_ref = _chat_sessions_agent(agent_id)
    if not agent_ref:
        return {"ok": False, "error": f"Unknown agent: {agent_id}"}, 404
    if not session_id:
        return {"ok": False, "error": "sessionId is required"}, 400
    kind = agent_ref["providerKind"]
    profile = agent_ref["profile"]
    if kind == "hermes":
        exported = _hermes_provider(agent_ref.get("record") or {}).export_session(profile, session_id)
        if not exported.get("ok"):
            return {"ok": False, "error": exported.get("error") or "Hermes session export failed"}, 502
        messages = _hermes_session_to_chat_messages(exported.get("session") or {}, agent_ref)
        _save_hermes_state(profile, {"messages": messages, "sessionId": session_id})
        return {"ok": True, "providerKind": kind, "sessionId": session_id, "messages": messages}, 200
    if kind == "codex":
        outcome = _codex_provider().read_thread(profile, session_id)
        if not outcome.get("ok"):
            return {"ok": False, "error": outcome.get("error") or "Codex thread read failed"}, 502
        messages = _codex_thread_to_chat_messages(outcome.get("thread") or {}, agent_ref)
        state = _load_codex_state(profile)
        state["messages"] = messages[-500:]
        state["sessionId"] = session_id
        _save_codex_state(profile, state)
        return {"ok": True, "providerKind": kind, "sessionId": session_id, "messages": messages}, 200
    if kind == "opencode":
        _set_opencode_session_id(profile, session_id)
        messages = _load_opencode_history(profile)
        return {"ok": True, "providerKind": kind, "sessionId": session_id, "messages": messages, "resumeCommand": f"opencode run --session {session_id}"}, 200
    if kind == "antigravity":
        return {"ok": False, "error": "Antigravity does not expose native sessions to switch"}, 400
    if kind in ("claude-code", "claudecode", "claude"):
        path = _claude_code_find_session_file(session_id)
        if not path:
            return {"ok": False, "error": "Claude Code session not found"}, 404
        messages = _claude_code_jsonl_to_chat_messages(path, agent_ref)
        _save_claude_code_state(profile, {"messages": messages[-500:], "sessionId": session_id})
        return {"ok": True, "providerKind": kind, "sessionId": session_id, "messages": messages, "resumeCommand": f"claude --resume {session_id}"}, 200
    if kind == "openclaw":
        session_key = _openclaw_session_key_for_agent(agent_ref["agentId"], session_id, default_bucket="")
        if not session_key:
            return {"ok": False, "error": "Invalid session key for this agent"}, 400
        return {"ok": True, "providerKind": kind, "sessionKey": session_key}, 200
    return {"ok": False, "error": f"{kind} session management is not supported yet"}, 400


def _hermes_session_to_chat_messages(session, agent_ref):
    messages = []
    session_id = str(session.get("id") or "")
    for msg in session.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "")
        if role == "tool":
            continue
        content = msg.get("content")
        text = content if isinstance(content, str) else json.dumps(content)[:2000] if content else ""
        if role not in ("user", "assistant") or not text:
            continue
        messages.append({"role": role, "text": text, "ts": int(time.time() * 1000), "from": agent_ref["name"] if role == "assistant" else "You", "fromType": "agent" if role == "assistant" else "human", "sessionId": session_id, "sessionTitle": f"Hermes session {session_id[-8:]}" if session_id else "Hermes session", "sessionKind": "chat", "activeSession": True, "source": "hermes"})
    return messages[-500:]


def _codex_thread_to_chat_messages(thread, agent_ref):
    messages = []
    thread_id = str(thread.get("id") or "")
    for turn in thread.get("turns") or []:
        if not isinstance(turn, dict):
            continue
        for item in turn.get("items") or []:
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "")
            if item_type in ("userMessage", "user_message"):
                content = item.get("content")
                text = " ".join(str(part.get("text") or "") for part in content if isinstance(part, dict)) if isinstance(content, list) else str(item.get("text") or content or "")
                if text.strip():
                    messages.append({"role": "user", "text": text.strip()[:4000], "ts": int(time.time() * 1000), "from": "You", "fromType": "human", "sessionId": thread_id, "sessionTitle": f"Codex thread {thread_id[-8:]}" if thread_id else "Codex thread", "sessionKind": "chat", "activeSession": True, "source": "codex"})
            elif item_type in ("agentMessage", "agent_message", "assistantMessage"):
                text = str(item.get("text") or "")
                if text.strip():
                    messages.append({"role": "assistant", "text": text.strip()[:8000], "ts": int(time.time() * 1000), "from": agent_ref["name"], "fromType": "agent", "sessionId": thread_id, "sessionTitle": f"Codex thread {thread_id[-8:]}" if thread_id else "Codex thread", "sessionKind": "chat", "activeSession": True, "source": "codex"})
    return messages[-500:]


def _claude_code_jsonl_to_chat_messages(path, agent_ref):
    messages = []
    session_id = os.path.splitext(os.path.basename(path))[0]
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(row, dict):
                    continue
                msg = row.get("message") if isinstance(row.get("message"), dict) else {}
                role = str(msg.get("role") or row.get("type") or "")
                if role not in ("user", "assistant"):
                    continue
                text = _claude_code_text_from_content(msg.get("content")).strip()
                if not text:
                    continue
                if row.get("sessionId"):
                    session_id = str(row.get("sessionId") or session_id)
                messages.append({"role": role, "text": text[:8000 if role == "assistant" else 4000], "ts": row.get("timestamp") or int(time.time() * 1000), "from": agent_ref["name"] if role == "assistant" else "You", "fromType": "agent" if role == "assistant" else "human", "sessionId": session_id, "sessionTitle": f"Claude Code {session_id[-8:]}" if session_id else "Claude Code session", "sessionKind": "chat", "activeSession": True, "source": "claude-code"})
    except OSError:
        pass
    return messages[-500:]


def _openclaw_session_meta_for_bubble(agent_id, session_info=None, jsonl_file=None):
    session_info = session_info if isinstance(session_info, dict) else {}
    session_key = str(session_info.get("key") or session_info.get("sessionKey") or "")
    if not session_key:
        return {}
    kind = session_key.split(":", 2)[2] if session_key.count(":") >= 2 else ""
    live_mode = kind == "vw-live-mode-planner"
    title = str(session_info.get("label") or session_info.get("title") or "").strip()
    if not title:
        title = "Live Agent Mode" if live_mode else ("Main chat" if kind == "main" else kind)
    return {"sessionKey": session_key, "sessionId": str(session_info.get("sessionId") or (os.path.splitext(os.path.basename(jsonl_file))[0] if jsonl_file else "")), "sessionTitle": title, "sessionKind": "live-mode" if live_mode else ("main" if kind == "main" else "other"), "liveMode": live_mode}


def _agent_chat_apply_session_meta(messages, meta):
    if not meta:
        return messages
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        msg["sessionKey"] = meta.get("sessionKey") or msg.get("sessionKey")
        msg["sessionId"] = meta.get("sessionId") or msg.get("sessionId")
        msg["sessionTitle"] = meta.get("sessionTitle") or msg.get("sessionTitle")
        msg["sessionKind"] = meta.get("sessionKind") or msg.get("sessionKind")
        if meta.get("liveMode") is not None:
            msg["liveMode"] = bool(meta.get("liveMode"))
    return messages


def get_agent_messages(agent_key, max_messages=500):
    """Read recent messages from an agent's active session JSONL."""
    agent_id = AGENT_SESSION_IDS.get(agent_key)
    if not agent_id:
        return []
    sessions_dir = os.path.join(WORKSPACE_BASE, f"agents/{agent_id}/sessions")
    jsonl_file = None
    trajectory_file = None
    # Find the most recently updated session entry first. If its transcript
    # file is missing (can happen after compaction/restart), do NOT fall back
    # to an older session-store entry; that makes bubbles show stale cron/DM
    # sessions. Instead, fall through to the newest real transcript by mtime.
    jsonl_file, trajectory_file, _session_info = _openclaw_session_paths(agent_id)
    session_meta = _openclaw_session_meta_for_bubble(agent_id, _session_info, jsonl_file)
    if not jsonl_file:
        # Only consider primary transcript files named <uuid>.jsonl. Ignore
        # trajectory/checkpoint/reset JSONL artifacts, which can be newer but
        # are not suitable for chat bubbles.
        uuid_jsonl = re.compile(r"^[0-9a-fA-F-]{36}\.jsonl$")
        jsonls = [
            p for p in glob.glob(os.path.join(sessions_dir, "*.jsonl"))
            if uuid_jsonl.match(os.path.basename(p))
        ]
        if jsonls:
            jsonl_file = max(jsonls, key=os.path.getmtime)
            base = jsonl_file[:-len(".jsonl")]
            candidate_trajectory = base + ".trajectory.jsonl"
            if os.path.exists(candidate_trajectory):
                trajectory_file = candidate_trajectory
    if not jsonl_file:
        return _agent_chat_apply_session_meta(_trajectory_activity_messages(trajectory_file, max_tools=min(80, max_messages)), session_meta)
    messages = []
    try:
        # Performance: read the tail instead of the whole JSONL. Some model/tool
        # messages (notably image reads) can be a single very large JSONL line;
        # grow the tail window until we have enough complete recent lines.
        tail_data = _read_tail_text(jsonl_file, initial_bytes=32 * 1024, max_bytes=2 * 1024 * 1024, min_lines=20)
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
                media = []

                def _add_media_url(_url, _mime="", _name=""):
                    if not _url:
                        return
                    _url = str(_url).strip()
                    if not _url:
                        return
                    _name = _name or os.path.basename(urllib.parse.urlparse(_url).path) or "attachment"
                    _mime = _mime or mimetypes.guess_type(_name)[0] or mimetypes.guess_type(_url)[0] or ""
                    media.append({"url": _url, "mimeType": _mime, "name": _name})

                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    parts = []
                    tool_calls = []
                    for item in content:
                        if isinstance(item, dict):
                            item_type = item.get("type")
                            if item_type == "text":
                                t = item.get("text", "").strip()
                                if t:
                                    parts.append(t)
                            elif item_type in ("image", "image_url", "input_image", "file", "media", "attachment", "video", "audio"):
                                src = item.get("url") or item.get("path") or item.get("filePath") or item.get("mediaUrl")
                                if not src and isinstance(item.get("image_url"), dict):
                                    src = item.get("image_url", {}).get("url")
                                if not src and isinstance(item.get("source"), dict):
                                    src = item.get("source", {}).get("url") or item.get("source", {}).get("path")
                                _add_media_url(src, item.get("mimeType") or item.get("media_type") or item.get("contentType") or "", item.get("name") or item.get("filename") or "")
                            elif item.get("type") == "toolCall":
                                name = item.get("name", "")
                                args = item.get("arguments", {})
                                if name == "exec":
                                    cmd = args.get("command", "")
                                    if "office.py" in cmd:
                                        tool_calls.append(f"\u2699\ufe0f {cmd.split('office.py')[1].strip()[:80]}")
                                    elif "openclaw agent" in cmd:
                                        m_agent = re.search(r'--agent\s+(\S+)', cmd)
                                        m_msg = re.search(r'--message\s+"([^"]*)"', cmd)
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
                for _line in (text or "").splitlines():
                    _m = re.match(r"^\(attached file:\s*(.+?)\)$", _line.strip(), re.I) or re.match(r"^attached file:\s*(.+)$", _line.strip(), re.I)
                    if _m:
                        _path = _m.group(1).strip()
                        _mime = mimetypes.guess_type(_path)[0] or ""
                        _add_media_url(_path, _mime, os.path.basename(_path))
                if not text and not media:
                    continue

                # Sender attribution for agent-to-agent / inter-session turns.
                # OpenClaw keeps role='user' for provider compatibility, so VO
                # needs provenance/display metadata to avoid showing agent input
                # as a generic human "IN:" message.
                from_agent = ""
                from_agent_id = ""
                to_agent = _agent_display_label(agent_id)
                to_agent_id = agent_id
                is_inter_session = False
                provenance_kind = ""
                prov = msg.get("provenance", {}) if isinstance(msg.get("provenance", {}), dict) else {}
                if role == "user" and prov.get("kind") == "inter_session":
                    provenance_kind = "inter_session"
                    is_inter_session = True
                    source = prov.get("sourceSessionKey", "")
                    from_agent_id = _agent_id_from_session_key(source)
                    from_agent = _agent_display_label(from_agent_id) if from_agent_id else "Agent"

                a2a_meta, clean_text = _parse_a2a_envelope(text)
                if a2a_meta:
                    text = clean_text
                    is_inter_session = True
                    from_agent_id = a2a_meta.get("from") or from_agent_id
                    if a2a_meta.get("name"):
                        from_agent = a2a_meta.get("name")
                    elif from_agent_id:
                        from_agent = _agent_display_label(from_agent_id)
                    if a2a_meta.get("to"):
                        to_agent_id = a2a_meta.get("to")
                        to_agent = _agent_display_label(to_agent_id)

                # Send raw epoch ms to client — browser converts to local timezone
                epoch_ms = 0
                if ts:
                    try:
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        epoch_ms = int(dt.timestamp() * 1000)
                    except Exception:
                        pass
                messages.append({
                    "role": role,
                    "text": text[:500],
                    "ts": ts,
                    "epochMs": epoch_ms,
                    "from": from_agent,
                    "fromAgentId": from_agent_id,
                    "to": to_agent,
                    "toAgentId": to_agent_id,
                    "isInterSession": is_inter_session,
                    "provenanceKind": provenance_kind,
                    "media": media[:4],
                })
    except Exception as e:
        return []
    if trajectory_file:
        messages.extend(_trajectory_activity_messages(trajectory_file, max_tools=80))
        messages.sort(key=lambda m: m.get("epochMs") or 0)
    return _agent_chat_apply_session_meta(messages[-max_messages:], session_meta)


def get_codex_agent_messages(profile, max_messages=500):
    """Read recent Codex provider history for floor chat bubbles."""
    messages = []
    for msg in _load_codex_history(profile)[-max_messages:]:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "assistant")
        text = str(msg.get("text") or "")
        tools = msg.get("tools") if isinstance(msg.get("tools"), list) else []
        thinking = str(msg.get("thinking") or "")
        approval = msg.get("approval") if isinstance(msg.get("approval"), dict) else None
        if not text and not tools and not thinking and not approval:
            continue
        epoch_ms = _codex_int(msg.get("epochMs") or msg.get("ts"), 0)
        messages.append({
            "role": role,
            "text": text[:500],
            "ts": epoch_ms,
            "epochMs": epoch_ms,
            "from": msg.get("from") or ("User" if role == "user" else ""),
            "fromType": msg.get("fromType") or "",
            "tools": tools,
            "thinking": thinking,
            "reasoningTokens": _codex_int(msg.get("reasoningTokens"), 0),
            "approval": approval,
            "source": msg.get("source") or "codex",
        })
    return messages[-max_messages:]


def get_opencode_agent_messages(profile, max_messages=500):
    """Read recent OpenCode provider history for floor chat bubbles."""
    messages = []
    for msg in _load_opencode_history(profile)[-max_messages:]:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "assistant")
        text = str(msg.get("text") or "")
        tools = msg.get("tools") if isinstance(msg.get("tools"), list) else []
        thinking = str(msg.get("thinking") or "")
        if not text and not tools and not thinking:
            continue
        epoch_ms = _codex_int(msg.get("epochMs") or msg.get("ts"), 0)
        messages.append({
            "role": role,
            "text": text[:500],
            "ts": epoch_ms,
            "epochMs": epoch_ms,
            "from": msg.get("from") or ("User" if role == "user" else ""),
            "fromType": msg.get("fromType") or "",
            "tools": tools,
            "thinking": thinking,
            "reasoningTokens": _codex_int(msg.get("reasoningTokens"), 0),
            "source": msg.get("source") or "opencode",
        })
    return messages[-max_messages:]


def get_antigravity_agent_messages(profile, max_messages=500):
    """Read recent Antigravity provider history for floor chat bubbles."""
    messages = []
    for msg in _load_antigravity_history(profile)[-max_messages:]:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "assistant")
        text = str(msg.get("text") or "")
        thinking = str(msg.get("thinking") or "")
        if not text and not thinking:
            continue
        epoch_ms = _codex_int(msg.get("epochMs") or msg.get("ts"), 0)
        messages.append({
            "role": role,
            "text": text[:500],
            "ts": epoch_ms,
            "epochMs": epoch_ms,
            "from": msg.get("from") or ("User" if role == "user" else ""),
            "fromType": msg.get("fromType") or "",
            "thinking": thinking,
            "reasoningTokens": _codex_int(msg.get("reasoningTokens"), 0),
            "source": msg.get("source") or "antigravity",
        })
    return messages[-max_messages:]


def get_claude_code_agent_messages(profile, max_messages=500):
    """Read recent Claude Code provider history for floor chat bubbles."""
    messages = []
    for msg in _load_claude_code_history(profile)[-max_messages:]:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "assistant")
        text = str(msg.get("text") or "")
        tools = msg.get("tools") if isinstance(msg.get("tools"), list) else []
        thinking = str(msg.get("thinking") or "")
        if not text and not tools and not thinking:
            continue
        epoch_ms = _codex_int(msg.get("epochMs") or msg.get("ts"), 0)
        messages.append({
            "role": role,
            "text": text[:500],
            "ts": epoch_ms,
            "epochMs": epoch_ms,
            "from": msg.get("from") or ("User" if role == "user" else ""),
            "fromType": msg.get("fromType") or "",
            "tools": tools,
            "thinking": thinking,
            "reasoningTokens": _codex_int(msg.get("reasoningTokens"), 0),
            "source": msg.get("source") or "claude-code",
        })
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
    """Get the gateway auth token.

    Resolution order:
    1. Explicit env var override
    2. Fresh read from vo-config.json (user override saved in setup/settings)
    3. Current in-memory VO_CONFIG copy
    4. openclaw.json gateway auth token
    """
    env_token = os.environ.get("VO_GATEWAY_TOKEN") or os.environ.get("OPENCLAW_GATEWAY_TOKEN")
    if env_token:
        return env_token

    cfg_path = _resolve_config_path()
    for try_path in [cfg_path, os.path.join(os.path.dirname(__file__), "vo-config.json")]:
        try:
            with open(try_path, "r") as f:
                cfg = json.load(f)
            vo_token = ((cfg.get("openclaw") or {}).get("gatewayToken") or "").strip()
            if vo_token:
                return vo_token
        except (FileNotFoundError, json.JSONDecodeError, OSError, TypeError):
            continue

    vo_token = ((VO_CONFIG.get("openclaw") or {}).get("gatewayToken") or "").strip()
    if vo_token:
        return vo_token

    # Fall back to openclaw.json
    try:
        with open(CONFIG_PATH, "r") as f:
            cfg = json.load(f)
        return ((cfg.get("gateway", {}).get("auth", {}).get("token", "") or "").strip())
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
        try:
            r = subprocess.run(["systemctl", "--user", "kill", "-s", "USR1", "openclaw-gateway.service"],
                               capture_output=True, timeout=5)
            if r.returncode == 0:
                print(f"✅ Gateway auto-config: added origin {origin}, gateway reloaded")
                return
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        # Fallback: scan /proc for gateway process and send SIGUSR1
        try:
            for entry in os.listdir("/proc"):
                if not entry.isdigit():
                    continue
                try:
                    with open(f"/proc/{entry}/cmdline", "r") as f:
                        cmdline = f.read()
                    if "openclaw" in cmdline and "gateway" in cmdline:
                        os.kill(int(entry), signal.SIGUSR1)
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
    global CONFIG_PATH, AUTH_PROFILES_PATH, OPENCLAW_HOME, OPENCLAW_AGENT_DIR, OPENCLAW_BIN, HERMES_HOME, HERMES_BIN
    GATEWAY_URL = VO_CONFIG["openclaw"]["gatewayUrl"]
    GATEWAY_URL_FALLBACK = GATEWAY_URL.replace("127.0.0.1", "localhost") if "127.0.0.1" in GATEWAY_URL else GATEWAY_URL
    _GW_LOCAL_HOST = _compute_local_host_header(GATEWAY_URL)
    GATEWAY_HTTP = VO_CONFIG["openclaw"]["gatewayHttp"]
    CONFIG_PATH = os.path.join(WORKSPACE_BASE, "openclaw.json")
    AUTH_PROFILES_PATH = os.path.join(WORKSPACE_BASE, "agents/main/agent/auth-profiles.json")
    OPENCLAW_HOME = os.path.expanduser(os.environ.get("OPENCLAW_HOME") or WORKSPACE_BASE or "~/.openclaw")
    OPENCLAW_AGENT_DIR = os.path.join(OPENCLAW_HOME, "agents/main/agent")
    OPENCLAW_BIN = (
        os.environ.get("OPENCLAW_BIN")
        or VO_CONFIG.get("openclaw", {}).get("binary")
        or shutil.which("openclaw")
    )
    HERMES_HOME = os.path.expanduser(os.environ.get("HERMES_HOME") or VO_CONFIG.get("hermes", {}).get("homePath") or "~/.hermes")
    HERMES_BIN = (
        os.environ.get("HERMES_BIN")
        or VO_CONFIG.get("hermes", {}).get("binary")
        or shutil.which("hermes")
    )


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
        time.sleep(3)  # let server start
        while True:
            try:
                data = self._collect()
                with self._lock:
                    self._data = data
            except Exception as e:
                with self._lock:
                    self._data = {"providers": [], "timestamp": time.time(), "error": str(e), "source": "error"}
            time.sleep(self.INTERVAL)

    def _read_profiles(self):
        """Read OpenClaw auth profiles from the configured native store."""
        sqlite_profiles = self._read_profiles_from_sqlite()
        if sqlite_profiles:
            return sqlite_profiles
        try:
            with open(self._auth_profiles_path, "r") as f:
                ap = json.load(f)
            return ap.get("profiles", {})
        except Exception:
            return {}

    def _read_profiles_from_sqlite(self):
        db_path = os.path.join(OPENCLAW_AGENT_DIR, "openclaw-agent.sqlite")
        if not os.path.exists(db_path):
            return {}
        try:
            con = sqlite3.connect(db_path)
            con.row_factory = sqlite3.Row
            table_names = [
                row[0]
                for row in con.execute("select name from sqlite_master where type='table'")
            ]
            for table in ("auth_profile_store", "auth_profile_stores"):
                if table not in table_names:
                    continue
                cols = [row[1] for row in con.execute(f"pragma table_info({table})")]
                if "store_json" not in cols:
                    continue
                for row in con.execute(f"select store_json from {table}").fetchall():
                    try:
                        data = json.loads(row["store_json"] or "{}")
                    except Exception:
                        continue
                    profiles = data.get("profiles")
                    if isinstance(profiles, dict) and profiles:
                        con.close()
                        return profiles
            con.close()
        except Exception:
            return {}
        return {}

    def _profile_rank(self, profile):
        """Prefer profiles that can expose real quota windows over plain API keys."""
        prov = profile.get("provider", "")
        has_token = bool(profile.get("access") or profile.get("token"))
        has_key = bool(profile.get("key"))
        ptype = str(profile.get("type") or profile.get("mode") or "").lower()
        if prov in ("openai", "openai-codex") and has_token:
            return 0
        if prov == "anthropic" and has_token:
            return 0
        if prov == "github-copilot" and has_token:
            return 1
        if has_token or ptype in ("oauth", "token", "subscription"):
            return 2
        if has_key:
            return 5
        return 9

    def _collect(self):
        """Run one collection cycle across all configured providers."""
        now = time.time()
        profiles = self._read_profiles()
        if not profiles:
            return {"providers": [], "timestamp": now, "source": "no-profiles"}

        providers = []
        grouped = {}
        for pid, profile in profiles.items():
            if not isinstance(profile, dict):
                continue
            prov = profile.get("provider") or pid.split(":", 1)[0]
            if not prov:
                continue
            profile = dict(profile)
            profile["_profileId"] = pid
            canonical = "openai" if prov == "openai-codex" else prov
            grouped.setdefault(canonical, []).append(profile)

        for canonical, provider_profiles in grouped.items():
            provider_profiles.sort(key=self._profile_rank)
            profile = provider_profiles[0]
            prov = profile.get("provider") or canonical

            token = profile.get("access") or profile.get("token")
            api_key = profile.get("key")
            account_id = profile.get("accountId")

            result = None
            if prov == "anthropic" and token:
                result = self._fetch_claude(token, now)
            elif prov in ("openai", "openai-codex") and token:
                result = self._fetch_codex(token, account_id, now)
            elif prov == "github-copilot" and token:
                result = self._fetch_copilot(token, now)
            elif api_key and canonical not in ("ollama", "lmstudio"):
                result = {
                    "provider": canonical,
                    "displayName": _PROVIDER_LABELS.get(canonical, canonical.replace("-", " ").title()),
                    "type": "api_key",
                    "usage": None,
                    "status": "configured",
                    "message": "API key configured. This provider does not expose account quota windows through the standard API key interface.",
                }

            if result:
                result.setdefault("provider", canonical)
                result.setdefault("profileId", profile.get("_profileId", ""))
                result.setdefault("authType", str(profile.get("type") or profile.get("mode") or ("oauth" if token else "api_key")))
                result.setdefault("profilesFound", len(provider_profiles))
                providers.append(result)

        return {"providers": providers, "timestamp": now, "source": "openclaw-native-auth"}

    def _http_get(self, url, headers):
        """Make an HTTP GET request. Returns (status, response_body_dict_or_None)."""
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
            "type": "oauth",
        }
        if status != 200 or not data:
            msg = ""
            if data and isinstance(data, dict):
                msg = data.get("error", {}).get("message", "") if isinstance(data.get("error"), dict) else str(data.get("error", ""))
            entry["error"] = f"HTTP {status}: {msg}" if msg else f"HTTP {status}"
            if status == 429:
                entry["message"] = "Claude usage endpoint is rate limited. Model access can still work; usage will refresh after the provider allows another check."
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
        """Fetch ChatGPT/Codex usage from OpenAI's OAuth-backed usage endpoint."""
        headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": "CodexBar",
            "Accept": "application/json",
        }
        if account_id:
            headers["ChatGPT-Account-Id"] = account_id

        status, data = self._http_get("https://chatgpt.com/backend-api/wham/usage", headers)
        entry = {
            "provider": "openai",
            "displayName": _PROVIDER_LABELS.get("openai", "OpenAI"),
            "type": "oauth",
        }
        if status != 200 or not data:
            entry["error"] = f"HTTP {status}"
            entry["message"] = "OpenAI usage requires a valid ChatGPT/Codex OAuth session. API-key billing usage is not exposed here."
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
        parsed_url = urllib.parse.urlparse(self.path)
        request_path = parsed_url.path
        query_params = urllib.parse.parse_qs(parsed_url.query)
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
            state = _get_normalized_presence_state()
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
                provider_kind = a.get("providerKind", "openclaw")
                if provider_kind == "hermes":
                    session_key = f"hermes:{a.get('profile', a['id'])}"
                elif provider_kind == "codex":
                    session_key = f"codex:{a.get('profile') or a.get('providerAgentId') or a['id']}"
                elif provider_kind == "claude-code":
                    session_key = f"claude-code:{a.get('profile') or a.get('providerAgentId') or a['id']}"
                elif provider_kind == "opencode":
                    session_key = f"opencode:{a.get('profile') or a.get('providerAgentId') or a['id']}"
                elif provider_kind == "antigravity":
                    session_key = f"antigravity:{a.get('profile') or a.get('providerAgentId') or a['id']}"
                else:
                    session_key = f"agent:{a['id']}:main"
                # Prefer office-config name/emoji over IDENTITY.md
                oc = _oc_overrides.get(a["statusKey"], {})
                # Resolve branch ID to display name
                branch_id = oc.get("branch", "")
                branch_name = _oc_branches.get(branch_id, "") if branch_id else ""
                if not branch_name:
                    branch_name = "Hermes" if provider_kind == "hermes" else ("Codex" if provider_kind == "codex" else ("Claude Code" if provider_kind == "claude-code" else ("OpenCode" if provider_kind == "opencode" else ("Antigravity" if provider_kind == "antigravity" else "Unassigned"))))
                agents.append({
                    "key": a["statusKey"],
                    "agentId": a["id"],
                    "sessionKey": session_key,
                    "providerKind": provider_kind,
                    "providerType": a.get("providerType", "runtime"),
                    "providerAgentId": a.get("providerAgentId", a["id"]),
                    "emoji": oc.get("emoji") or a["emoji"],
                    "name": oc.get("name") or a["name"],
                    "role": a.get("role", ""),
                    "model": a.get("model", ""),
                    "provider": a.get("provider", ""),
                    "lastActiveAt": a.get("lastActiveAt", 0),
                    "branch": branch_name,
                })
            # Enforce agent limit in demo mode without hiding whole providers.
            agents = _apply_agent_limit_balanced(agents)
            self.wfile.write(json.dumps({"agents": agents}).encode())
        elif self.path == "/gateway-info":
            # Tell the browser WS port + gateway token for chat connection
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "wsPort": WS_PORT,
                "token": _get_gateway_token(),
                "openclawVersion": _get_openclaw_version(),
                "gatewayProtocol": GATEWAY_PROTOCOL_VERSION,
            }).encode())
        elif request_path == "/api/session-activity":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            session_key = (query_params.get("sessionKey") or [""])[0]
            try:
                limit = int((query_params.get("limit") or ["80"])[0])
            except Exception:
                limit = 80
            limit = max(1, min(120, limit))
            messages = _session_trajectory_messages(session_key, max_tools=limit)
            self.wfile.write(json.dumps({"ok": True, "messages": messages}).encode())
        elif request_path == "/api/chat-sessions":
            agent_id = (query_params.get("agentId") or query_params.get("agent") or query_params.get("key") or ["main"])[0]
            try:
                limit = int((query_params.get("limit") or ["40"])[0])
            except Exception:
                limit = 40
            limit = max(1, min(100, limit))
            payload, status = handle_chat_sessions_list(agent_id, limit=limit)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
        elif self.path == "/agent-chat":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result = {}
            for agent_key in AGENT_SESSION_IDS:
                if _is_hermes_agent(agent_key):
                    agent = _get_hermes_agent(agent_key) or {}
                    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
                    msgs = _load_hermes_history(profile)[-500:]
                elif _is_codex_agent(agent_key):
                    agent = _get_codex_agent(agent_key) or {}
                    profile = agent.get("profile") or agent.get("providerAgentId") or "default"
                    msgs = get_codex_agent_messages(profile, max_messages=500)
                elif _is_claude_code_agent(agent_key):
                    agent = _get_claude_code_agent(agent_key) or {}
                    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
                    msgs = get_claude_code_agent_messages(profile, max_messages=500)
                elif _is_opencode_agent(agent_key):
                    agent = _get_opencode_agent(agent_key) or {}
                    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
                    msgs = get_opencode_agent_messages(profile, max_messages=500)
                elif _is_antigravity_agent(agent_key):
                    agent = _get_antigravity_agent(agent_key) or {}
                    profile = agent.get("profile") or agent.get("providerAgentId") or "main"
                    msgs = get_antigravity_agent_messages(profile, max_messages=500)
                else:
                    msgs = get_agent_messages(agent_key, max_messages=500)
                if msgs:
                    result[agent_key] = msgs
            result = _merge_comm_events_into_agent_chat(result)
            # Build project-work map: which agents are currently working on project tasks
            # Primary detection: check each agent's most recently active session key
            # for the "wf-" prefix (workflow sessions created by the project system).
            # This works across all VO instances since they read the same session files.
            project_work = {}
            for agent_key, agent_id in AGENT_SESSION_IDS.items():
                if _is_hermes_agent(agent_key) or _is_codex_agent(agent_key) or _is_claude_code_agent(agent_key) or _is_opencode_agent(agent_key) or _is_antigravity_agent(agent_key):
                    continue
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
                        if time.time() - best_ts / 1000 < 300:
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
                    shared = {}
                    now_ms = int(time.time() * 1000)
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
                    req = urllib.request.urlopen(cdp_url.rstrip("/") + "/json", timeout=2)
                    tabs = json.loads(req.read().decode())
                    self.wfile.write(json.dumps(tabs).encode())
                except Exception as e:
                    self.wfile.write(json.dumps({"available": False, "error": str(e)}).encode())
        elif self.path == "/session-info" or self.path.startswith("/session-info?"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            agent_id = (
                (query.get("agent") or query.get("agentId") or query.get("key") or query.get("sessionKey") or [""])[0]
                or None
            )
            info = self._get_session_info(agent_id=agent_id)
            self.wfile.write(json.dumps(info).encode())
        elif self.path == "/models":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            models = self._get_models()
            self.wfile.write(json.dumps(models).encode())
        elif self.path == "/api/native-models" or self.path.startswith("/api/native-models?"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            agent_id = (query.get("agent") or query.get("agentId") or ["main"])[0]
            self.wfile.write(json.dumps(_get_native_model_state(agent_id)).encode())
        elif self.path == "/config/providers":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            data = self._get_providers()
            self.wfile.write(json.dumps(data).encode())
        elif self.path == "/pc-metrics":
            # Proxy PC metrics from remote machine (configurable)
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
        elif request_path == "/sms-status":
            # SMS feature health/config check
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            sms_cfg = VO_CONFIG.get("sms", {})
            enabled = VO_CONFIG.get("features", {}).get("smsPanel", False) and check_feature("smsPanel")
            owner_agent = self._get_sms_owner_agent_info()
            self.wfile.write(json.dumps({
                "enabled": enabled,
                "agentId": owner_agent.get("id"),
                "ownerAgentId": owner_agent.get("id"),
                "ownerAgent": owner_agent,
                "hasCredentials": bool(sms_cfg.get("twilioAccountSid") and sms_cfg.get("twilioAuthToken") and sms_cfg.get("fromNumber")),
            }).encode())
        elif request_path == "/sms-log":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            sms_log = self._get_sms_log()
            self.wfile.write(json.dumps(sms_log).encode())
        elif request_path == "/sms-threads":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            limit = query_params.get("limit", ["200"])[0]
            try:
                limit = max(1, min(1000, int(limit)))
            except Exception:
                limit = 200
            self.wfile.write(json.dumps(self._get_sms_threads(limit=limit)).encode())
        elif request_path == "/sms-thread":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            phone = (query_params.get("phone", [""])[0] or "").strip()
            limit = query_params.get("limit", ["250"])[0]
            try:
                limit = max(1, min(1000, int(limit)))
            except Exception:
                limit = 250
            self.wfile.write(json.dumps(self._get_sms_thread(phone, limit=limit)).encode())
        elif request_path == "/sms-media":
            self._handle_sms_media_proxy(query_params)
        elif request_path == "/chat-media":
            self._serve_chat_media(query_params)
        elif request_path == "/sms-mode":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            mode = self._read_global_sms_mode()
            self.wfile.write(json.dumps(mode).encode())
        elif request_path == "/sms-contacts":
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
                    "providerKind": a.get("providerKind", "openclaw"),
                    "providerType": a.get("providerType", "runtime"),
                    "providerAgentId": a.get("providerAgentId", a["id"]),
                    "name": a["name"],
                    "emoji": a["emoji"],
                    "role": a.get("role", ""),
                    "model": a.get("model", ""),
                    "provider": a.get("provider", ""),
                    "lastActiveAt": a.get("lastActiveAt", 0),
                })
            # Enforce agent limit in demo mode without hiding whole providers.
            roster = _apply_agent_limit_balanced(roster)
            self.wfile.write(json.dumps({"agents": roster}).encode())
        elif request_path.startswith("/api/agent-workspace/"):
            agent_key = urllib.parse.unquote(request_path.split("/api/agent-workspace/", 1)[1].strip("/"))
            result = _get_agent_workspace_payload(agent_key)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/agent-platforms":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(_handle_agent_platforms()).encode())
        elif self.path == "/api/hermes/history" or self.path.startswith("/api/hermes/history?"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            agent_key = (qs.get("agentId") or qs.get("key") or ["hermes-default"])[0]
            agent = _get_hermes_agent(agent_key)
            profile = (agent or {}).get("profile") or (agent or {}).get("providerAgentId") or "default"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "messages": _load_hermes_history(profile)}).encode())
        elif self.path == "/api/codex/history" or self.path.startswith("/api/codex/history?"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            agent_key = (qs.get("agentId") or qs.get("key") or ["codex-default"])[0]
            agent = _get_codex_agent(agent_key)
            profile = (agent or {}).get("profile") or (agent or {}).get("providerAgentId") or "default"
            state = _load_codex_state(profile)
            token_usage = _get_codex_token_usage(profile)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "ok": True,
                "messages": _load_codex_history(profile),
                "sessionId": _get_codex_session_id(profile),
                "tokenUsage": token_usage,
                "contextUsed": _codex_context_used_from_token_usage(token_usage) or _codex_int(state.get("contextUsed"), 0),
                "contextWindow": _codex_context_window_from_token_usage(token_usage) or _codex_int(state.get("contextWindow"), 0),
            }).encode())
        elif self.path == "/api/claude-code/history" or self.path.startswith("/api/claude-code/history?"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            agent_key = (qs.get("agentId") or qs.get("key") or ["claude-code-main"])[0]
            agent = _get_claude_code_agent(agent_key)
            profile = (agent or {}).get("profile") or (agent or {}).get("providerAgentId") or "main"
            state = _load_claude_code_state(profile)
            token_usage = _get_claude_code_token_usage(profile)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "ok": True,
                "messages": _load_claude_code_history(profile),
                "sessionId": _get_claude_code_session_id(profile),
                "tokenUsage": token_usage,
                "contextUsed": _codex_context_used_from_token_usage(token_usage) or _codex_int(state.get("contextUsed"), 0),
                "contextWindow": _codex_context_window_from_token_usage(token_usage) or _codex_int(state.get("contextWindow"), 0),
            }).encode())
        elif self.path == "/api/opencode/history" or self.path.startswith("/api/opencode/history?"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            agent_key = (qs.get("agentId") or qs.get("key") or ["opencode-main"])[0]
            agent = _get_opencode_agent(agent_key)
            profile = (agent or {}).get("profile") or (agent or {}).get("providerAgentId") or "main"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "ok": True,
                "messages": _load_opencode_history(profile),
                "sessionId": _get_opencode_session_id(profile),
            }).encode())
        elif self.path == "/api/antigravity/history" or self.path.startswith("/api/antigravity/history?"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            agent_key = (qs.get("agentId") or qs.get("key") or ["antigravity-main"])[0]
            agent = _get_antigravity_agent(agent_key)
            profile = (agent or {}).get("profile") or (agent or {}).get("providerAgentId") or "main"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "ok": True,
                "messages": _load_antigravity_history(profile),
                "sessionId": "",
            }).encode())
        elif request_path == "/api/hermes/approval/pending":
            agent_key = (query_params.get("agentId") or query_params.get("key") or ["hermes-default"])[0]
            session_id = (query_params.get("session_id") or query_params.get("sessionId") or [""])[0]
            result = _get_hermes_approval_pending(agent_key, session_id)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif request_path == "/api/hermes/approval/stream":
            agent_key = (query_params.get("agentId") or query_params.get("key") or ["hermes-default"])[0]
            session_id = (query_params.get("session_id") or query_params.get("sessionId") or [""])[0]
            result = _get_hermes_approval_pending(agent_key, session_id)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            event_name = "approval" if result.get("pending") else "idle"
            payload = json.dumps(result)
            self.wfile.write(f"event: {event_name}\ndata: {payload}\n\n".encode("utf-8"))
        elif request_path.startswith("/api/hermes/runs/") and request_path.endswith("/events"):
            run_id = urllib.parse.unquote(request_path[len("/api/hermes/runs/"):-len("/events")].strip("/"))
            _handle_hermes_run_events(self, run_id)
        elif request_path.startswith("/api/codex/runs/") and request_path.endswith("/events"):
            run_id = urllib.parse.unquote(request_path[len("/api/codex/runs/"):-len("/events")].strip("/"))
            _handle_codex_run_events(self, run_id)
        elif request_path.startswith("/api/claude-code/runs/") and request_path.endswith("/events"):
            run_id = urllib.parse.unquote(request_path[len("/api/claude-code/runs/"):-len("/events")].strip("/"))
            _handle_claude_code_run_events(self, run_id)
        elif request_path == "/api/codex/approval/pending":
            agent_key = (query_params.get("agentId") or query_params.get("key") or ["codex-default"])[0]
            result = _handle_codex_approval_pending(agent_key)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/hermes/test":
            result = _handle_hermes_test()
            self.send_response(200 if result.get("ok") else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/codex/test":
            result = _handle_codex_test()
            self.send_response(200 if result.get("ok") else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/claude-code/test":
            result = _handle_claude_code_test()
            self.send_response(200 if result.get("ok") else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/agent-platform-communications/skill":
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(_agent_platform_comm_skill_content().encode("utf-8"))
        elif self.path == "/api/agent-platform-communications/history" or self.path.startswith("/api/agent-platform-communications/history?"):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            result = _handle_agent_platform_comm_history(qs)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif request_path == "/api/hermes-platform/status":
            result = _handle_hermes_platform_status()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif request_path == "/api/hermes-platform/poll":
            auth_error = _hermes_platform_auth_error(self.headers)
            result = auth_error or _handle_hermes_platform_poll(query_params)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
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
                result = _get_normalized_presence_state()
            elif self.path == "/api/presence/debug":
                result = gateway_presence.get_connection_status()
            else:
                agent_id = self.path.split("/api/presence/")[1].strip("/")
                result = _normalize_presence_entry(gateway_presence.get_agent_state(agent_id))
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
                "hermes": {
                    "enabled": VO_CONFIG.get("hermes", {}).get("enabled", True),
                    "homePath": VO_CONFIG.get("hermes", {}).get("homePath"),
                    "binary": VO_CONFIG.get("hermes", {}).get("binary"),
                    "timeoutSec": VO_CONFIG.get("hermes", {}).get("timeoutSec", 600),
                    "apiUrl": VO_CONFIG.get("hermes", {}).get("apiUrl"),
                    "apiKeyConfigured": bool(VO_CONFIG.get("hermes", {}).get("apiKey")),
                    "desktopUrl": VO_CONFIG.get("hermes", {}).get("desktopUrl"),
                    "desktopTokenConfigured": bool(VO_CONFIG.get("hermes", {}).get("desktopToken")),
                    "desktopHostHeader": VO_CONFIG.get("hermes", {}).get("desktopHostHeader"),
                    "desktopTcpHost": VO_CONFIG.get("hermes", {}).get("desktopTcpHost"),
                    "desktopTcpPort": VO_CONFIG.get("hermes", {}).get("desktopTcpPort"),
                    "desktopLogPath": VO_CONFIG.get("hermes", {}).get("desktopLogPath"),
                    "preferApi": VO_CONFIG.get("hermes", {}).get("preferApi", True),
                    "preferDesktop": VO_CONFIG.get("hermes", {}).get("preferDesktop", True),
                    "platformEnabled": VO_CONFIG.get("hermes", {}).get("platformEnabled", False),
                    "platformTokenConfigured": bool(VO_CONFIG.get("hermes", {}).get("platformToken")),
                    "platformAgentId": VO_CONFIG.get("hermes", {}).get("platformAgentId", "hermes-gateway"),
                    "platformPollLeaseSec": VO_CONFIG.get("hermes", {}).get("platformPollLeaseSec", 120),
                    "detected": bool(_handle_hermes_test().get("ok")),
                },
                "codex": {
                    "enabled": VO_CONFIG.get("codex", {}).get("enabled", True),
                    "homePath": VO_CONFIG.get("codex", {}).get("homePath"),
                    "binary": VO_CONFIG.get("codex", {}).get("binary"),
                    "workspaceRoot": VO_CONFIG.get("codex", {}).get("workspaceRoot"),
                    "mainWorkspace": VO_CONFIG.get("codex", {}).get("mainWorkspace"),
                    "timeoutSec": VO_CONFIG.get("codex", {}).get("timeoutSec", 900),
                    "model": VO_CONFIG.get("codex", {}).get("model"),
                    "sandbox": VO_CONFIG.get("codex", {}).get("sandbox", "workspace-write"),
                    "approvalPolicy": VO_CONFIG.get("codex", {}).get("approvalPolicy", "never"),
                    "preferAppServer": VO_CONFIG.get("codex", {}).get("preferAppServer", True),
                    "includeMain": VO_CONFIG.get("codex", {}).get("includeMain", True),
                    "includeNativeAgents": VO_CONFIG.get("codex", {}).get("includeNativeAgents", True),
                    "registerNativeAgents": VO_CONFIG.get("codex", {}).get("registerNativeAgents", True),
                },
                "claudeCode": {
                    "enabled": VO_CONFIG.get("claudeCode", {}).get("enabled", True),
                    "homePath": VO_CONFIG.get("claudeCode", {}).get("homePath"),
                    "binary": VO_CONFIG.get("claudeCode", {}).get("binary"),
                    "workspaceRoot": VO_CONFIG.get("claudeCode", {}).get("workspaceRoot"),
                    "mainWorkspace": VO_CONFIG.get("claudeCode", {}).get("mainWorkspace"),
                    "timeoutSec": VO_CONFIG.get("claudeCode", {}).get("timeoutSec", 900),
                    "model": VO_CONFIG.get("claudeCode", {}).get("model"),
                    "permissionMode": VO_CONFIG.get("claudeCode", {}).get("permissionMode", "acceptEdits"),
                    "includeMain": VO_CONFIG.get("claudeCode", {}).get("includeMain", True),
                    "includeNativeAgents": VO_CONFIG.get("claudeCode", {}).get("includeNativeAgents", True),
                    "registerNativeAgents": VO_CONFIG.get("claudeCode", {}).get("registerNativeAgents", True),
                },
                "openCode": {
                    "enabled": VO_CONFIG.get("openCode", {}).get("enabled", False),
                    "homePath": VO_CONFIG.get("openCode", {}).get("homePath"),
                    "binary": VO_CONFIG.get("openCode", {}).get("binary"),
                    "workspaceRoot": VO_CONFIG.get("openCode", {}).get("workspaceRoot"),
                    "mainWorkspace": VO_CONFIG.get("openCode", {}).get("mainWorkspace"),
                    "timeoutSec": VO_CONFIG.get("openCode", {}).get("timeoutSec", 900),
                    "model": VO_CONFIG.get("openCode", {}).get("model"),
                    "includeMain": VO_CONFIG.get("openCode", {}).get("includeMain", True),
                    "includeAgents": VO_CONFIG.get("openCode", {}).get("includeAgents", True),
                    "registerAgents": VO_CONFIG.get("openCode", {}).get("registerAgents", True),
                },
                "antigravity": {
                    "enabled": VO_CONFIG.get("antigravity", {}).get("enabled", False),
                    "homePath": VO_CONFIG.get("antigravity", {}).get("homePath"),
                    "binary": VO_CONFIG.get("antigravity", {}).get("binary"),
                    "workspaceRoot": VO_CONFIG.get("antigravity", {}).get("workspaceRoot"),
                    "timeoutSec": VO_CONFIG.get("antigravity", {}).get("timeoutSec", 600),
                    "printTimeout": VO_CONFIG.get("antigravity", {}).get("printTimeout", "5m"),
                    "model": VO_CONFIG.get("antigravity", {}).get("model"),
                    "sandbox": VO_CONFIG.get("antigravity", {}).get("sandbox"),
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
        elif request_path == "/api/skills-workshop":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            result = _handle_skill_workshop_list(qs)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
        elif request_path == "/api/skills-workshop/inspect":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            result = _handle_skill_workshop_inspect(qs)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
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

    def _chat_media_allowed_roots(self):
        roots = []
        for candidate in [STATUS_DIR, WORKSPACE_BASE, os.path.expanduser("~/.openclaw"), "/tmp/vo-data"]:
            try:
                if candidate and os.path.isdir(candidate):
                    roots.append(os.path.realpath(candidate))
            except Exception:
                pass
        return roots

    def _resolve_chat_media_path(self, raw_path):
        """Resolve chat media paths across VO instances without assuming one data dir.

        Chat transcripts may contain paths produced by another Virtual Office
        instance (for example /tmp/vo-data/uploads/...) while the current
        instance has a different STATUS_DIR (for example /data).  Try the
        literal path first, then remap upload-relative paths under allowed
        OpenClaw roots so both personal and product offices can display the
        same attachments.
        """
        if raw_path.startswith("file://"):
            raw_path = urllib.parse.urlparse(raw_path).path
        raw_path = urllib.parse.unquote(raw_path)
        candidates = []
        if raw_path.startswith("/tmp/vo-data/"):
            candidates.append(os.path.join(STATUS_DIR, raw_path[len("/tmp/vo-data/"):]))
        candidates.append(raw_path)
        if not os.path.isabs(raw_path):
            candidates.append(os.path.join(WORKSPACE_BASE, raw_path))

        norm_parts = raw_path.replace("\\", "/").split("/")
        if "uploads" in norm_parts:
            idx = norm_parts.index("uploads")
            upload_suffix = os.path.join(*norm_parts[idx:])
            for root in self._chat_media_allowed_roots():
                candidates.append(os.path.join(root, upload_suffix))
            # Also scan one level below OpenClaw roots (data/uploads,
            # workspace/uploads, etc.). This keeps the
            # product generic while still supporting multiple VO instances.
            for base in [WORKSPACE_BASE, os.path.expanduser("~/.openclaw")]:
                try:
                    candidates.extend(glob.glob(os.path.join(base, "*", upload_suffix)))
                except Exception:
                    pass

        allowed_roots = self._chat_media_allowed_roots()
        seen = set()
        for candidate in candidates:
            if not candidate:
                continue
            if not os.path.isabs(candidate):
                candidate = os.path.join(WORKSPACE_BASE, candidate)
            real_path = os.path.realpath(candidate)
            if real_path in seen:
                continue
            seen.add(real_path)
            allowed = any(real_path == root or real_path.startswith(root + os.sep) for root in allowed_roots)
            if allowed and os.path.isfile(real_path):
                return real_path
        return None

    def _serve_chat_media(self, query_params):
        raw_path = (query_params.get("path", [""])[0] or "").strip()
        if not raw_path:
            self.send_response(400)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"Missing media path")
            return
        real_path = self._resolve_chat_media_path(raw_path)
        if not real_path:
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"Media not found")
            return
        content_type = mimetypes.guess_type(real_path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        with open(real_path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def _get_api_usage(self):
        """Return the latest API usage data collected by the background thread."""
        now = time.time()
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
    _MAX_CACHE_SIZE = 50  # max entries per cache dict

    def _fetch_provider_models(self, provider, api_key):
        """Fetch live model list from a cloud provider's API."""

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
                url = "https://generativelanguage.googleapis.com/v1beta/models"
                req = urllib.request.Request(url, headers={"x-goog-api-key": api_key})
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
            cache = self.__class__._model_cache
            cache[provider] = {"models": models, "ts": time.time()}
            # Evict oldest entries if cache exceeds max size
            if len(cache) > self.__class__._MAX_CACHE_SIZE:
                oldest = min(cache, key=lambda k: cache[k]["ts"])
                del cache[oldest]
        except Exception as e:
            # Return cached if available, even if stale
            if cached:
                return cached["models"]
            return [f"(error: {str(e)[:60]})"]

        return models

    # OAuth provider model discovery via OpenClaw CLI
    _oauth_model_cache = {}  # {provider: {models: [...], ts: timestamp}}
    _OAUTH_CACHE_TTL = 600  # 10 minutes

    @classmethod
    def _discover_oauth_provider_models(cls):
        """Discover actually-served models for OAuth providers via `openclaw models list`.

        Read-only legacy helper for older picker surfaces. New model settings
        use /api/native-models and OpenClaw's native JSON output directly.
        """
        oauth_providers = set()
        try:
            for profile in _read_openclaw_auth_sqlite():
                if str(profile.get("type") or "").lower() in {"oauth", "token", "subscription"}:
                    provider = profile.get("provider")
                    if provider:
                        oauth_providers.add(provider)
        except Exception:
            pass

        for provider in oauth_providers:
            cached = cls._oauth_model_cache.get(provider)
            if cached and (time.time() - cached["ts"]) < cls._OAUTH_CACHE_TTL:
                continue  # Still fresh

            try:
                openclaw_bin = OPENCLAW_BIN
                if not openclaw_bin:
                    continue
                result = subprocess.run(
                    [openclaw_bin, "models", "list", "--provider", provider, "--all", "--json"],
                    capture_output=True, text=True, timeout=30
                )
                if result.returncode != 0:
                    continue
                data = json.loads(result.stdout)
                discovered = []
                for m in data.get("models", []):
                    tags = m.get("tags", [])
                    if "missing" not in tags:
                        key = m.get("key", "")
                        if key:
                            discovered.append(key)

                cls._oauth_model_cache[provider] = {"models": discovered, "ts": time.time()}
            except Exception:
                pass  # Silently skip — will retry next cache expiry

    @classmethod
    def _sync_config_models(cls, provider, discovered_models):
        """Sync agents.defaults.models with actually-discovered models for a provider.

        Removes config entries for models NOT served by the provider.
        Adds entries for discovered models not yet in config.
        Does NOT touch models from other providers.
        """
        try:
            with open(CONFIG_PATH, "r") as f:
                cfg = json.load(f)

            models_cfg = cfg.get("agents", {}).get("defaults", {}).get("models", {})
            prefix = f"{provider}/"
            discovered_set = set(discovered_models)
            changed = False

            # Remove config entries not in discovered set
            to_remove = [k for k in models_cfg if k.startswith(prefix) and k not in discovered_set]
            for k in to_remove:
                del models_cfg[k]
                changed = True

            # Add discovered models not yet in config
            for m in discovered_models:
                if m not in models_cfg:
                    models_cfg[m] = {}
                    changed = True

            if changed:
                _atomic_write_text(CONFIG_PATH, json.dumps(cfg, indent=2) + "\n")
        except Exception:
            pass  # Config sync is best-effort

    _registry_cache = {}  # {provider: {models: [...], ts: timestamp}}
    _REGISTRY_TTL = 600  # 10 minutes

    def _fetch_registry_models(self, provider):
        """Fetch models for a provider from configured models in openclaw.json.
        Provider may be "anthropic-token" but we search for "anthropic/" prefix.
        """

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
            cache = self.__class__._registry_cache
            cache[provider] = {"models": models, "ts": time.time()}
            # Evict oldest entries if cache exceeds max size
            if len(cache) > self.__class__._MAX_CACHE_SIZE:
                oldest = min(cache, key=lambda k: cache[k]["ts"])
                del cache[oldest]
        except Exception as e:
            if cached:
                return cached["models"]
            return [f"(error: {str(e)[:60]})"]

        return models

    def _load_model_config(self):
        try:
            with open(CONFIG_PATH, "r") as f:
                return json.load(f)
        except Exception:
            return {}

    def _default_config_model(self, cfg):
        cfg = cfg if isinstance(cfg, dict) else {}
        default_model = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", "")
        for a in cfg.get("agents", {}).get("list", []):
            if a.get("default") and a.get("model"):
                return a["model"]
        return default_model or "unknown"

    def _context_window_for_model(self, model, cfg):
        model = str(model or "")
        cfg = cfg if isinstance(cfg, dict) else {}
        # Known context windows - keyed by full provider/model AND by model name alone.
        # The model-name-only keys act as fallbacks for alternative providers
        # (e.g. openai-codex/gpt-5.4-pro matches via "gpt-5.4-pro" -> "gpt-5" family).
        known_context = {
            # Anthropic
            "anthropic/claude-opus-4-6": 1000000,
            "anthropic/claude-sonnet-4-6": 1000000,
            "anthropic/claude-sonnet-4-20250514": 200000,
            "anthropic/claude-haiku-3-5-20241022": 200000,
            "anthropic/claude-3-5-sonnet-20241022": 200000,
            # Google
            "google/gemini-2.5-flash": 1048576,
            "google/gemini-2.5-pro": 1048576,
            "google/gemini-2.0-flash": 1048576,
            "google/gemini-3-flash-preview": 1048576,
            "google/gemini-3.1-pro-preview": 1048576,
            "google/gemini-3.1-flash-lite-preview": 1048576,
            # OpenAI
            "openai/gpt-4o": 128000,
            "openai/gpt-4o-mini": 128000,
            "openai/gpt-5.4": 200000,
            "openai/o3": 200000,
            "openai/o4-mini": 200000,
        }
        known_context_prefixes = [
            ("claude-opus", 1000000),
            ("claude-sonnet-4", 1000000),
            ("claude-sonnet", 200000),
            ("claude-haiku", 200000),
            ("gemini-3", 1048576),
            ("gemini-2.5", 1048576),
            ("gemini-2.0", 1048576),
            ("gpt-5", 200000),
            ("gpt-4o", 128000),
            ("o3", 200000),
            ("o4-mini", 200000),
        ]

        for prov_name, prov_data in cfg.get("models", {}).get("providers", {}).items():
            for m in prov_data.get("models", []):
                full_id = f"{prov_name}/{m['id']}"
                if full_id == model and m.get("contextWindow"):
                    return m["contextWindow"]

        context_window = known_context.get(model, 0)
        if context_window == 0 and "/" in model:
            model_name = model.split("/", 1)[1]
            for prefix, ctx in known_context_prefixes:
                if model_name.startswith(prefix):
                    return ctx
        return context_window

    def _get_session_info(self, agent_id=None):
        """Return model name and context window for a specific agent (or default).

        When agent_id is provided, resolves that agent's configured model
        (per-agent override or default). Otherwise returns the main/default agent model.
        """
        cfg = self._load_model_config()
        default_model = self._default_config_model(cfg)
        if agent_id and _is_hermes_agent(agent_id):
            agent = _get_hermes_agent(agent_id) or {}
            model = agent.get("model") or "Hermes"
            provider = agent.get("provider") or "Hermes"
            return {"model": model, "provider": provider, "providerKind": "hermes", "contextWindow": 0}
        if agent_id and _is_codex_agent(agent_id):
            agent = _get_codex_agent(agent_id) or {}
            model = agent.get("model") or VO_CONFIG.get("codex", {}).get("model") or default_model
            provider = agent.get("provider") or "Codex CLI"
            profile = agent.get("profile") or agent.get("providerAgentId") or "default"
            token_usage = _get_codex_token_usage(profile)
            state = _load_codex_state(profile)
            context_used = _codex_context_used_from_token_usage(token_usage) or _codex_int(state.get("contextUsed"), 0)
            token_context_window = _codex_context_window_from_token_usage(token_usage) or _codex_int(state.get("contextWindow"), 0)
            return {
                "model": model,
                "provider": provider,
                "providerKind": "codex",
                "contextWindow": token_context_window or self._context_window_for_model(model, cfg),
                "contextUsed": context_used,
                "tokenUsage": token_usage,
            }
        if agent_id and _is_claude_code_agent(agent_id):
            agent = _get_claude_code_agent(agent_id) or {}
            model = agent.get("model") or VO_CONFIG.get("claudeCode", {}).get("model") or default_model
            if model == "inherit":
                model = VO_CONFIG.get("claudeCode", {}).get("model") or default_model
            provider = agent.get("provider") or "Claude Code"
            profile = agent.get("profile") or agent.get("providerAgentId") or "main"
            token_usage = _get_claude_code_token_usage(profile)
            state = _load_claude_code_state(profile)
            context_used = _codex_context_used_from_token_usage(token_usage) or _codex_int(state.get("contextUsed"), 0)
            token_context_window = _codex_context_window_from_token_usage(token_usage) or _codex_int(state.get("contextWindow"), 0)
            return {
                "model": model,
                "provider": provider,
                "providerKind": "claude-code",
                "contextWindow": token_context_window or self._context_window_for_model(model, cfg),
                "contextUsed": context_used,
                "tokenUsage": token_usage,
            }
        if agent_id and _is_opencode_agent(agent_id):
            agent = _get_opencode_agent(agent_id) or {}
            model = agent.get("model") or VO_CONFIG.get("openCode", {}).get("model") or "OpenCode"
            if model == "inherit":
                model = VO_CONFIG.get("openCode", {}).get("model") or "OpenCode"
            return {
                "model": model,
                "provider": agent.get("provider") or "OpenCode",
                "providerKind": "opencode",
                "contextWindow": self._context_window_for_model(model, cfg),
                "sessionId": _get_opencode_session_id(agent.get("profile") or agent.get("providerAgentId") or "main"),
            }
        if agent_id and _is_antigravity_agent(agent_id):
            agent = _get_antigravity_agent(agent_id) or {}
            model = agent.get("model") or VO_CONFIG.get("antigravity", {}).get("model") or "gemini"
            return {
                "model": model,
                "provider": agent.get("provider") or "Antigravity",
                "providerKind": "antigravity",
                "contextWindow": self._context_window_for_model(model, cfg),
                "sessionId": "",
            }

        model = default_model

        # If a specific agent was requested, look up its model override
        if agent_id:
            for a in cfg.get("agents", {}).get("list", []):
                if a.get("id") == agent_id:
                    if a.get("model"):
                        model = a["model"]
                    break

        return {"model": model, "contextWindow": self._context_window_for_model(model, cfg)}

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
                "apiKeyConfigured": bool(prov_data.get("apiKey")),
                "timeoutSeconds": prov_data.get("timeoutSeconds"),
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

    def _save_custom_provider(self, provider, base_url, models, params=None, api=None, api_key=None, timeout_seconds=None):
        """Save a custom provider config."""
        request = {
            "type": "save-custom-provider",
            "provider": provider,
            "baseUrl": base_url,
            "models": models,
        }
        if api:
            request["api"] = api
        if api_key:
            request["apiKey"] = api_key
        if timeout_seconds:
            request["timeoutSeconds"] = timeout_seconds
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
            elif req_type == "delete-custom-provider":
                return self._handle_delete_custom_provider(request)
            else:
                return {"ok": False, "error": f"Unknown request type: {req_type}"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _write_openclaw_config(cfg):
        """Write openclaw.json — handles read-only Docker mounts gracefully."""
        try:
            _atomic_write_text(CONFIG_PATH, json.dumps(cfg, indent=2) + "\n")
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

        gateway_signal = self._signal_gateway(restart=True)
        return {"ok": True, "agent": agent_id, "model": model_id or "(default)", "defaulted": not bool(model_id), "gatewaySignal": gateway_signal}

    def _handle_save_key(self, req):
        """Save an API key to auth-profiles and openclaw.json."""
        provider = req.get("provider", "")
        key = req.get("key", "")
        profile_id = req.get("profileId") or f"{provider}:default"
        return _save_openclaw_api_key(provider, key, profile_id, agent_id=req.get("agent") or "main", sync_all=True)

    def _handle_delete_key(self, req):
        """Delete an API key from auth-profiles and openclaw.json."""
        provider = _safe_provider_id(req.get("provider", ""))
        profile_id = str(req.get("profileId") or "").strip()
        if not provider and not profile_id:
            return {"ok": False, "error": "provider or profileId is required"}
        result = _delete_openclaw_auth_direct(provider, profile_id)
        if not result.get("ok"):
            return result
        self._signal_gateway(restart=False)
        return result

    def _handle_save_custom_provider(self, req):
        """Save a custom provider (ollama, lmstudio, etc.) to openclaw.json."""
        provider = _safe_provider_id(req.get("provider", ""))
        base_url = str(req.get("baseUrl", "") or "").strip()
        models = _parse_model_entries(req.get("models", []))
        if not provider:
            return {"ok": False, "error": "provider is required"}
        if not base_url:
            return {"ok": False, "error": "base URL is required"}
        if not models:
            return {"ok": False, "error": "at least one model is required"}

        with open(CONFIG_PATH) as f:
            cfg = json.load(f)

        cfg.setdefault("models", {}).setdefault("providers", {})
        existing = cfg["models"]["providers"].get(provider, {})

        requested_api = req.get("api")
        requested_api_key = req.get("apiKey")
        requested_timeout = req.get("timeoutSeconds")
        if provider == "ollama":
            # OpenClaw 2026.5.x expects the native Ollama API root, not /v1.
            base_url = re.sub(r"/v1/?$", "", (base_url or "").strip())
            requested_api = requested_api or "ollama"
            requested_api_key = requested_api_key or existing.get("apiKey")
            requested_timeout = requested_timeout or existing.get("timeoutSeconds") or 300

        existing["baseUrl"] = base_url
        if requested_api:
            existing["api"] = requested_api
        elif not existing.get("api"):
            existing["api"] = "openai-completions"
        if requested_api_key:
            existing["apiKey"] = requested_api_key
        if requested_timeout:
            existing["timeoutSeconds"] = int(requested_timeout)

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

    def _delete_custom_provider(self, provider):
        return self._send_watcher_request({"type": "delete-custom-provider", "provider": provider})

    def _handle_delete_custom_provider(self, req):
        provider = _safe_provider_id(req.get("provider", ""))
        if not provider:
            return {"ok": False, "error": "provider is required"}
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
        providers = cfg.setdefault("models", {}).setdefault("providers", {})
        if provider not in providers:
            return {"ok": False, "error": f"Provider {provider} is not configured"}
        providers.pop(provider, None)
        defaults_models = cfg.setdefault("agents", {}).setdefault("defaults", {}).setdefault("models", {})
        for model_id in list(defaults_models.keys()):
            if model_id.startswith(provider + "/"):
                defaults_models.pop(model_id, None)
        for agent in cfg.get("agents", {}).get("list", []):
            if str(agent.get("model") or "").startswith(provider + "/"):
                agent.pop("model", None)
        ok, err = self._write_openclaw_config(cfg)
        if not ok:
            return {"ok": False, "error": err}
        self._signal_gateway(restart=False)
        return {"ok": True, "provider": provider}

    @staticmethod
    def _signal_gateway(restart=False):
        """Ask the OpenClaw Gateway to reload/restart through its admin RPC."""
        return _signal_openclaw_gateway(restart=restart)

    def _get_models(self):
        """Read available models from openclaw.json."""
        # Ensure OAuth provider models are synced with live discovery before reading config
        try:
            self._discover_oauth_provider_models()
        except Exception:
            pass

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
        except Exception:
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
        except Exception:
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
            pass  # silently ignore subscription model errors

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
        except Exception:
            pass
        try:
            for mid, mdata in cfg.get("agents", {}).get("defaults", {}).get("models", {}).items():
                configured_models_map[mid] = True
        except Exception:
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Virtual-Office-Token, X-My-Virtual-Office-Token, X-Hermes-Platform-Token")
        self.end_headers()

    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path)
        request_path = parsed_url.path
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
                    if key == "hermes" and isinstance(body[key], dict) and isinstance(existing.get(key), dict):
                        hermes_body = dict(body[key])
                        # Password fields render blank/masked in the browser. A blank submit
                        # should keep the existing server-side secret instead of disabling
                        # native Hermes API auth.
                        if not hermes_body.get("apiKey") and existing[key].get("apiKey"):
                            hermes_body.pop("apiKey", None)
                        if not hermes_body.get("desktopToken") and existing[key].get("desktopToken"):
                            hermes_body.pop("desktopToken", None)
                        if not hermes_body.get("apiUrl") and existing[key].get("apiUrl"):
                            hermes_body.pop("apiUrl", None)
                        if not hermes_body.get("desktopUrl") and existing[key].get("desktopUrl"):
                            hermes_body.pop("desktopUrl", None)
                        if not hermes_body.get("desktopHostHeader") and existing[key].get("desktopHostHeader"):
                            hermes_body.pop("desktopHostHeader", None)
                        if not hermes_body.get("desktopTcpHost") and existing[key].get("desktopTcpHost"):
                            hermes_body.pop("desktopTcpHost", None)
                        if not hermes_body.get("desktopTcpPort") and existing[key].get("desktopTcpPort"):
                            hermes_body.pop("desktopTcpPort", None)
                        if not hermes_body.get("desktopLogPath") and existing[key].get("desktopLogPath"):
                            hermes_body.pop("desktopLogPath", None)
                        if not hermes_body.get("platformToken") and existing[key].get("platformToken"):
                            hermes_body.pop("platformToken", None)
                        existing[key].update(hermes_body)
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
                old_token = _get_gateway_token()
                VO_CONFIG = _load_vo_config()
                WORKSPACE_BASE = VO_CONFIG["openclaw"]["homePath"]
                # Always reload gateway globals (URL, host header, config path)
                _reload_gateway_globals()
                _discovered_roster = _discover_roster()
                _discovered_at = time.time()
                refresh_agent_maps()
                # Restart gateway presence listener only when gateway settings actually changed
                new_token = _get_gateway_token()
                gateway_changed = GATEWAY_URL != old_gw
                token_changed = new_token != old_token
                if gateway_changed or token_changed:
                    gateway_presence.stop()
                    if new_token:
                        gateway_presence.start(GATEWAY_URL, new_token, port=PORT, client_version=_get_openclaw_version())
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
        elif request_path.startswith("/api/agent-workspace/"):
            agent_key = urllib.parse.unquote(request_path.split("/api/agent-workspace/", 1)[1].strip("/"))
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_agent_workspace_update(agent_key, body)
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
        elif self.path == "/api/hermes/runs":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_hermes_run_start(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/hermes/interrupt":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_hermes_interrupt(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif request_path.startswith("/api/hermes/runs/") and request_path.endswith("/stop"):
            run_id = urllib.parse.unquote(request_path[len("/api/hermes/runs/"):-len("/stop")].strip("/"))
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            body["runId"] = run_id
            result = _handle_hermes_interrupt(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/hermes/chat":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_hermes_chat(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/codex/runs":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_codex_run_start(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/claude-code/runs":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_claude_code_run_start(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif request_path.startswith("/api/codex/runs/") and request_path.endswith("/stop"):
            run_id = urllib.parse.unquote(request_path[len("/api/codex/runs/"):-len("/stop")].strip("/"))
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            body["runId"] = run_id
            result = _handle_codex_interrupt(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif request_path.startswith("/api/claude-code/runs/") and request_path.endswith("/stop"):
            run_id = urllib.parse.unquote(request_path[len("/api/claude-code/runs/"):-len("/stop")].strip("/"))
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            body["runId"] = run_id
            result = _handle_claude_code_interrupt(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/codex/chat":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_codex_chat(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/claude-code/chat":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_claude_code_chat(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/opencode/chat":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_opencode_chat(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/antigravity/chat":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_antigravity_chat(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/codex/interrupt":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_codex_interrupt(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/claude-code/interrupt":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_claude_code_interrupt(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/opencode/interrupt":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_opencode_interrupt(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/antigravity/interrupt":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_antigravity_interrupt(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/codex/approval/respond":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_codex_approval_respond(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/hermes/approval/respond":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_hermes_approval_respond(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/agent-platform-communications/send":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_agent_platform_comm_send(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif request_path in {"/api/hermes-platform/enqueue", "/api/hermes-platform/ack", "/api/hermes-platform/reply", "/api/hermes-platform/heartbeat"}:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            auth_error = _hermes_platform_auth_error(self.headers)
            if auth_error:
                result = auth_error
            elif request_path == "/api/hermes-platform/enqueue":
                result = _handle_hermes_platform_enqueue(body)
            elif request_path == "/api/hermes-platform/ack":
                result = _handle_hermes_platform_ack(body)
            elif request_path == "/api/hermes-platform/reply":
                result = _handle_hermes_platform_reply(body)
            else:
                result = _handle_hermes_platform_heartbeat(body)
            self.send_response(result.get("_status", 200))
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result.pop("_status", None)
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/chat-sessions/create":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result, status = handle_chat_session_create(body.get("agentId") or body.get("agent") or body.get("key") or "main", body)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/chat-sessions/delete":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result, status = handle_chat_session_delete(body.get("agentId") or body.get("agent") or body.get("key") or "main", body.get("sessionId") or body.get("sessionKey") or "", body)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/chat-sessions/switch":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result, status = handle_chat_session_switch(body.get("agentId") or body.get("agent") or body.get("key") or "main", body.get("sessionId") or body.get("sessionKey") or "", body)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/hermes/history/clear":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            agent = _get_hermes_agent(body.get("agentId") or body.get("key") or "hermes-default") or {}
            profile = agent.get("profile") or agent.get("providerAgentId") or "default"
            session_id = _get_hermes_session_id(profile)
            delete_result = {"ok": True, "deleted": False}
            if session_id:
                hermes_cfg = VO_CONFIG.get("hermes", {})
                hermes_bin = os.path.expanduser(agent.get("binary") or hermes_cfg.get("binary") or "~/.local/bin/hermes")
                provider = HermesProvider(
                    home_path=hermes_cfg.get("homePath"),
                    binary=hermes_bin,
                    enabled=hermes_cfg.get("enabled", True),
                    timeout_sec=int(hermes_cfg.get("timeoutSec") or 600),
                )
                delete_result = provider.delete_session(profile, session_id)
            _save_hermes_history(profile, [])
            _set_hermes_session_id(profile, "")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "deletedHermesSession": bool(delete_result.get("deleted")), "sessionId": session_id}).encode())
            return
        elif self.path == "/api/codex/history/clear":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            agent = _get_codex_agent(body.get("agentId") or body.get("key") or "codex-default") or {}
            profile = agent.get("profile") or agent.get("providerAgentId") or "default"
            session_id = _get_codex_session_id(profile)
            _save_codex_history(profile, [])
            _set_codex_session_id(profile, "")
            _clear_codex_token_usage(profile)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "clearedCodexSession": bool(session_id), "sessionId": session_id}).encode())
            return
        elif self.path == "/api/claude-code/history/clear":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            agent = _get_claude_code_agent(body.get("agentId") or body.get("key") or "claude-code-main") or {}
            profile = agent.get("profile") or agent.get("providerAgentId") or "main"
            session_id = _get_claude_code_session_id(profile)
            _save_claude_code_history(profile, [])
            _set_claude_code_session_id(profile, "")
            _clear_claude_code_token_usage(profile)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "clearedClaudeCodeSession": bool(session_id), "sessionId": session_id}).encode())
            return
        elif self.path == "/api/opencode/history/clear":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            agent = _get_opencode_agent(body.get("agentId") or body.get("key") or "opencode-main") or {}
            profile = agent.get("profile") or agent.get("providerAgentId") or "main"
            session_id = _get_opencode_session_id(profile)
            _save_opencode_state(profile, {"messages": [], "sessionId": ""})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "clearedOpenCodeSession": bool(session_id), "sessionId": session_id}).encode())
            return
        elif self.path == "/api/antigravity/history/clear":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            agent = _get_antigravity_agent(body.get("agentId") or body.get("key") or "antigravity-main") or {}
            profile = agent.get("profile") or agent.get("providerAgentId") or "main"
            _save_antigravity_state(profile, {"messages": []})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "clearedAntigravityHistory": True, "sessionId": ""}).encode())
            return
        elif self.path == "/api/hermes/test":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_hermes_test(body)
            self.send_response(200 if result.get("ok") else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/hermes/desktop/discover":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_hermes_desktop_discover(body)
            self.send_response(200 if result.get("found") else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/codex/test":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_codex_test(body)
            self.send_response(200 if result.get("ok") else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/claude-code/test":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_claude_code_test(body)
            self.send_response(200 if result.get("ok") else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/opencode/test":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_opencode_test(body)
            self.send_response(200 if result.get("ok") else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/api/antigravity/test":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_antigravity_test(body)
            self.send_response(200 if result.get("ok") else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        elif self.path == "/transcribe":
            # Proxy to host whisper server
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
        elif self.path == "/api/native-models/openclaw/agent-model":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._set_agent_model(body.get("agent", ""), body.get("model", ""))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/openclaw/auth/api-key":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _save_openclaw_api_key(
                body.get("provider", ""),
                body.get("apiKey", ""),
                body.get("profileId") or body.get("profile") or "",
                body.get("agent") or body.get("agentId") or "main",
                sync_all=str(body.get("scope") or "global").lower() != "agent",
            )
            self.send_response(200 if result.get("ok") else 400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/openclaw/auth/delete":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _delete_openclaw_auth(
                body.get("provider", ""),
                body.get("profileId") or body.get("profile") or "",
                body.get("agent") or body.get("agentId") or "main",
                sync_all=str(body.get("scope") or "global").lower() != "agent",
            )
            self.send_response(200 if result.get("ok") else 400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/openclaw/auth/sync-static":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _sync_openclaw_static_auth_from_main(body.get("provider"), body.get("profileId") or body.get("profile"))
            self.send_response(200 if result.get("ok") else 400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/openclaw/auth/reset-overrides":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _reset_openclaw_static_auth_overrides(body.get("agent") or body.get("agentId"), body.get("provider"))
            self.send_response(200 if result.get("ok") else 400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/openclaw/provider":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._save_custom_provider(
                _safe_provider_id(body.get("provider", "")),
                body.get("baseUrl", ""),
                _parse_model_entries(body.get("models", "")),
                api=body.get("api", ""),
                api_key=body.get("apiKey", ""),
                timeout_seconds=body.get("timeoutSeconds", None),
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/openclaw/provider/delete":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._delete_custom_provider(body.get("provider", ""))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/hermes/profile-model":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _set_hermes_profile_model(
                body.get("profile", "default"),
                body.get("provider", ""),
                body.get("model", ""),
                body.get("baseUrl", ""),
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/hermes/auth/api-key":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _save_hermes_api_key(body.get("provider", ""), body.get("apiKey", ""), body.get("label", ""))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/hermes/auth/delete":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _delete_hermes_auth(body.get("provider", ""), body.get("target", ""))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/hermes/provider":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _save_hermes_custom_provider(
                body.get("profile", "default"),
                body.get("provider", ""),
                body.get("baseUrl", ""),
                body.get("models", ""),
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif self.path == "/api/native-models/hermes/provider/delete":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _delete_hermes_custom_provider(body.get("profile", "default"), body.get("provider", ""))
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
            result = self._save_custom_provider(
                body.get("provider", ""),
                body.get("baseUrl", ""),
                body.get("models", []),
                body.get("params"),
                body.get("api"),
                body.get("apiKey"),
                body.get("timeoutSeconds"),
            )
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
        elif request_path == "/sms-thread-mode":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            phone = self._normalize_sms_phone(body.get("phone", ""))
            mode = body.get("active", "agent")
            if mode not in ("user", "agent"):
                mode = "agent"
            if not phone:
                result = {"ok": False, "error": "Missing phone"}
            else:
                result = self._set_sms_thread_mode(phone, mode)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        elif request_path == "/sms-mode":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            mode = body.get("active", "agent")
            if mode not in ("user", "agent"):
                mode = "agent"
            self._write_global_sms_mode(mode)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "active": mode}).encode())
        elif request_path == "/sms-send":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = self._send_sms_intervention(body.get("to", ""), body.get("body", ""), body.get("name", ""), body.get("sender", "user"))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        elif self.path == "/upload":
            # Self-contained file upload — saves to STATUS_DIR/uploads/
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
                mime_type = str(body.get("mimeType") or body.get("contentType") or mimetypes.guess_type(filename)[0] or "")
                content = base64.b64decode(body.get("content", ""))
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
                dest = os.path.join(upload_dir, f"{stem}_{int(time.time())}{ext}")
            with open(dest, "wb") as f:
                f.write(content)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({
                "path": dest,
                "url": "/chat-media?path=" + urllib.parse.quote(dest),
                "mimeType": mime_type,
                "size": len(content)
            }).encode())
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
        elif self.path == "/api/skills-library/save-from-agent":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_skills_library_save_from_agent(body)
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
        elif self.path == "/api/skills-workshop/action":
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            result = _handle_skill_workshop_action(body)
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
                                "minProtocol": GATEWAY_PROTOCOL_VERSION, "maxProtocol": GATEWAY_PROTOCOL_VERSION,
                                "client": {"id": "openclaw-control-ui", "version": _get_openclaw_version(), "platform": "server", "mode": "webchat"},
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
                        agent_ids = {
                            s.get("key", "").split(":", 2)[1]
                            for s in sessions
                            if isinstance(s, dict)
                            and s.get("key", "").startswith("agent:")
                            and len(s.get("key", "").split(":", 2)) >= 2
                        }
                        agent_count = len(agent_ids)

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

    def _sms_owner_agent_id(self):
        sms_cfg = VO_CONFIG.get("sms", {}) or {}
        owner_id = (sms_cfg.get("ownerAgentId") or sms_cfg.get("agentId") or "").strip()
        return owner_id or None

    def _get_sms_owner_agent_info(self):
        owner_id = self._sms_owner_agent_id()
        info = {"id": owner_id, "name": owner_id or "Unassigned", "emoji": "🤖"}
        if not owner_id:
            return info
        try:
            refresh_agent_maps()
            for agent in get_roster():
                if agent.get("id") == owner_id or agent.get("statusKey") == owner_id:
                    return {
                        "id": agent.get("id") or owner_id,
                        "statusKey": agent.get("statusKey") or owner_id,
                        "name": agent.get("name") or owner_id,
                        "emoji": agent.get("emoji") or "🤖",
                        "role": agent.get("role") or "",
                    }
        except Exception:
            pass
        return info

    def _normalize_sms_phone(self, phone):
        if not phone:
            return ""
        phone = str(phone).strip()
        phone = re.sub(r"[\s\-()]+", "", phone)
        if phone.startswith("00"):
            phone = "+" + phone[2:]
        if phone.startswith("+"):
            return phone
        if phone.isdigit():
            if len(phone) == 10:
                return "+1" + phone
            if len(phone) == 11 and phone.startswith("1"):
                return "+" + phone
        return phone

    def _sms_primary_data_dir(self):
        owner_id = self._sms_owner_agent_id()
        if owner_id:
            candidate = os.path.join(WORKSPACE_BASE, get_agent_workspace_dir(WORKSPACE_BASE, owner_id))
            if os.path.isdir(candidate):
                return candidate
        return STATUS_DIR

    def _sms_data_dirs(self):
        dirs = []
        for candidate in [self._sms_primary_data_dir(), STATUS_DIR]:
            if candidate and candidate not in dirs and os.path.isdir(candidate):
                dirs.append(candidate)
        if not dirs:
            dirs.append(STATUS_DIR)
        return dirs

    def _sms_log_paths(self):
        paths = []
        for base_dir in self._sms_data_dirs():
            for rel_path in ["sms-log.jsonl", os.path.join("sms-archive", "sms-log-all.jsonl")]:
                full_path = os.path.join(base_dir, rel_path)
                if os.path.isfile(full_path) and full_path not in paths:
                    paths.append(full_path)
        return paths

    def _sms_contacts_paths(self):
        paths = []
        for base_dir in self._sms_data_dirs():
            for name in ["contacts.json", "sms-contacts.json"]:
                full_path = os.path.join(base_dir, name)
                if os.path.isfile(full_path) and full_path not in paths:
                    paths.append(full_path)
        return paths

    def _sms_primary_log_path(self):
        primary_dir = self._sms_primary_data_dir()
        os.makedirs(primary_dir, exist_ok=True)
        return os.path.join(primary_dir, "sms-log.jsonl")

    def _sms_primary_contacts_path(self):
        primary_dir = self._sms_primary_data_dir()
        os.makedirs(primary_dir, exist_ok=True)
        preferred = "contacts.json" if primary_dir != STATUS_DIR else "sms-contacts.json"
        return os.path.join(primary_dir, preferred)

    def _sms_thread_modes_path(self):
        return os.path.join(STATUS_DIR, "sms-thread-modes.json")

    def _read_global_sms_mode(self):
        try:
            with open(os.path.join(STATUS_DIR, "sms-mode.json")) as f:
                mode = json.load(f)
            active = mode.get("active", "agent")
            if active not in ("agent", "user"):
                active = "agent"
            return {"active": active}
        except Exception:
            return {"active": "agent"}

    def _write_global_sms_mode(self, mode):
        os.makedirs(STATUS_DIR, exist_ok=True)
        with open(os.path.join(STATUS_DIR, "sms-mode.json"), "w") as f:
            json.dump({"active": mode}, f)

    def _read_sms_thread_modes(self):
        try:
            with open(self._sms_thread_modes_path()) as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return {}
            cleaned = {}
            for phone, mode in data.items():
                normalized_phone = self._normalize_sms_phone(phone)
                if normalized_phone and mode in ("agent", "user"):
                    cleaned[normalized_phone] = mode
            return cleaned
        except Exception:
            return {}

    def _set_sms_thread_mode(self, phone, mode):
        phone = self._normalize_sms_phone(phone)
        if not phone:
            return {"ok": False, "error": "Missing phone"}
        modes = self._read_sms_thread_modes()
        modes[phone] = mode if mode in ("agent", "user") else "agent"
        os.makedirs(STATUS_DIR, exist_ok=True)
        with open(self._sms_thread_modes_path(), "w") as f:
            json.dump(modes, f, indent=2, sort_keys=True)
        return {"ok": True, "phone": phone, "active": modes[phone]}

    def _sms_mode_for_phone(self, phone):
        phone = self._normalize_sms_phone(phone)
        modes = self._read_sms_thread_modes()
        if phone and phone in modes:
            return modes[phone]
        return self._read_global_sms_mode().get("active", "agent")

    def _normalize_sms_timestamp(self, entry):
        timestamp = entry.get("timestamp")
        if not timestamp:
            return timestamp
        try:
            dt = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
        except Exception:
            return timestamp
        try:
            if dt.tzinfo is None:
                return dt.replace(tzinfo=SMS_DEFAULT_TZ).isoformat()
            return dt.astimezone(SMS_DEFAULT_TZ).isoformat()
        except Exception:
            return timestamp

    def _sms_sort_value(self, timestamp):
        if not timestamp:
            return 0.0
        try:
            dt = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
            if dt.tzinfo is not None:
                return dt.timestamp()
            return dt.timestamp()
        except Exception:
            return 0.0

    def _is_twilio_media_url(self, url):
        if not url:
            return False
        try:
            parsed = urllib.parse.urlparse(str(url))
            return (parsed.scheme == "https" and parsed.netloc.lower() == "api.twilio.com"
                    and parsed.path.startswith("/2010-04-01/Accounts/") and "/Media/" in parsed.path)
        except Exception:
            return False

    def _sms_media_proxy_url(self, url, content_type=""):
        if self._is_twilio_media_url(url):
            query = {"url": url}
            if content_type:
                query["contentType"] = content_type
            return "/sms-media?" + urllib.parse.urlencode(query)
        return url

    def _normalize_sms_media(self, entry):
        media = []
        def add_media(url, content_type="", filename=""):
            url = str(url or "").strip()
            if not url:
                return
            item = {"url": url, "contentType": str(content_type or "").strip(), "filename": str(filename or "").strip()}
            item["proxyUrl"] = self._sms_media_proxy_url(item["url"], item["contentType"])
            media.append(item)
        raw_media = entry.get("media") or entry.get("mediaUrls") or entry.get("attachments")
        if isinstance(raw_media, list):
            for item in raw_media:
                if isinstance(item, str):
                    add_media(item)
                elif isinstance(item, dict):
                    add_media(item.get("url") or item.get("mediaUrl") or item.get("MediaUrl") or item.get("href"),
                              item.get("contentType") or item.get("mediaContentType") or item.get("ContentType") or item.get("type"),
                              item.get("filename") or item.get("name"))
        elif isinstance(raw_media, dict):
            add_media(raw_media.get("url") or raw_media.get("mediaUrl") or raw_media.get("MediaUrl") or raw_media.get("href"),
                      raw_media.get("contentType") or raw_media.get("mediaContentType") or raw_media.get("ContentType") or raw_media.get("type"),
                      raw_media.get("filename") or raw_media.get("name"))
        try:
            num_media = int(entry.get("NumMedia") or entry.get("numMedia") or entry.get("num_media") or 0)
        except Exception:
            num_media = 0
        for idx in range(max(0, min(20, num_media))):
            add_media(entry.get(f"MediaUrl{idx}") or entry.get(f"mediaUrl{idx}"),
                      entry.get(f"MediaContentType{idx}") or entry.get(f"mediaContentType{idx}"))
        deduped = []
        seen = set()
        for item in media:
            key = (item.get("url"), item.get("contentType"), item.get("filename"))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)
        return deduped

    def _twilio_api_get_json(self, url):
        sms_cfg = VO_CONFIG.get("sms", {})
        account_sid = sms_cfg.get("twilioAccountSid")
        auth_token = sms_cfg.get("twilioAuthToken")
        if not account_sid or not auth_token:
            return None
        credentials = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()
        req = urllib.request.Request(url)
        req.add_header("Authorization", f"Basic {credentials}")
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())

    def _twilio_message_media(self, message_sid):
        if not message_sid:
            return []
        cache = getattr(self.__class__, "_sms_twilio_media_cache", {})
        now = time.time()
        cached = cache.get(message_sid)
        if cached and now - cached.get("ts", 0) < 300:
            return cached.get("media", [])
        sms_cfg = VO_CONFIG.get("sms", {})
        account_sid = sms_cfg.get("twilioAccountSid")
        if not account_sid:
            return []
        try:
            data = self._twilio_api_get_json(f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages/{message_sid}/Media.json")
            media = []
            for item in (data or {}).get("media_list", []):
                uri = item.get("uri") or ""
                if uri.endswith(".json"):
                    uri = uri[:-5]
                url = "https://api.twilio.com" + uri if uri.startswith("/") else uri
                if url:
                    media.append({"url": url, "contentType": item.get("content_type") or "",
                                  "filename": item.get("sid") or "MMS media",
                                  "proxyUrl": self._sms_media_proxy_url(url, item.get("content_type") or "")})
            cache[message_sid] = {"ts": now, "media": media}
            self.__class__._sms_twilio_media_cache = cache
            return media
        except Exception:
            return []

    def _recent_twilio_messages_with_media(self):
        cache = getattr(self.__class__, "_sms_twilio_recent_media_cache", None)
        now = time.time()
        if cache and now - cache.get("ts", 0) < 60:
            return cache.get("messages", [])
        sms_cfg = VO_CONFIG.get("sms", {})
        account_sid = sms_cfg.get("twilioAccountSid")
        if not account_sid:
            return []
        try:
            data = self._twilio_api_get_json(f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json?PageSize=50")
            messages = []
            for msg in (data or {}).get("messages", []):
                try:
                    num_media = int(msg.get("num_media") or 0)
                except Exception:
                    num_media = 0
                if num_media <= 0:
                    continue
                media = self._twilio_message_media(msg.get("sid"))
                if not media:
                    continue
                try:
                    sent_dt = email.utils.parsedate_to_datetime(msg.get("date_sent") or msg.get("date_created") or "")
                except Exception:
                    sent_dt = None
                messages.append({"sid": msg.get("sid"), "from": self._normalize_sms_phone(msg.get("from")),
                                 "to": self._normalize_sms_phone(msg.get("to")), "body": msg.get("body") or "",
                                 "timestamp": sent_dt.timestamp() if sent_dt else 0, "media": media})
            self.__class__._sms_twilio_recent_media_cache = {"ts": now, "messages": messages}
            return messages
        except Exception:
            return []

    def _enrich_sms_entries_with_twilio_media(self, entries):
        candidates = [e for e in entries if not e.get("media") and e.get("type") in ("inbound", "outbound") and e.get("phone")]
        if not candidates:
            return entries
        twilio_messages = self._recent_twilio_messages_with_media()
        if not twilio_messages:
            return entries
        for entry in candidates:
            entry_phone = self._normalize_sms_phone(entry.get("phone"))
            body = entry.get("body") or ""
            entry_ts = self._sms_sort_value(entry.get("timestamp"))
            best = None
            best_score = 999999
            for msg in twilio_messages:
                if entry_phone not in (msg.get("from"), msg.get("to")):
                    continue
                if body and msg.get("body") and body.strip() != msg.get("body", "").strip():
                    continue
                delta = abs((entry_ts or 0) - (msg.get("timestamp") or 0)) if entry_ts and msg.get("timestamp") else 0
                if delta and delta > 900:
                    continue
                if delta < best_score:
                    best = msg; best_score = delta
            if best:
                entry["sid"] = entry.get("sid") or best.get("sid")
                entry["media"] = best.get("media") or []
        return entries

    def _handle_sms_media_proxy(self, query_params):
        url = (query_params.get("url", [""])[0] or "").strip()
        requested_type = (query_params.get("contentType", [""])[0] or "").strip()
        if not self._is_twilio_media_url(url):
            self.send_response(400); self.send_header("Content-Type", "text/plain"); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(b"Invalid SMS media URL"); return
        sms_cfg = VO_CONFIG.get("sms", {})
        account_sid = sms_cfg.get("twilioAccountSid")
        auth_token = sms_cfg.get("twilioAuthToken")
        if not account_sid or not auth_token:
            self.send_response(503); self.send_header("Content-Type", "text/plain"); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(b"SMS media proxy is not configured"); return
        try:
            credentials = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()
            req = urllib.request.Request(url)
            req.add_header("Authorization", f"Basic {credentials}")
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = resp.read(); content_type = resp.headers.get("Content-Type") or requested_type or "application/octet-stream"
            self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Cache-Control", "private, max-age=3600"); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(payload)
        except Exception as e:
            self.send_response(502); self.send_header("Content-Type", "text/plain"); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(f"Could not fetch SMS media: {e}".encode())

    def _load_sms_contacts_map(self):
        contacts = {}
        for path in self._sms_contacts_paths():
            try:
                with open(path) as f:
                    data = json.load(f)
                if not isinstance(data, dict):
                    continue
                for phone, info in data.items():
                    normalized_phone = self._normalize_sms_phone(phone)
                    if not normalized_phone:
                        continue
                    info = info if isinstance(info, dict) else {}
                    existing = contacts.get(normalized_phone, {})
                    merged = dict(existing)
                    merged.update(info)
                    merged["name"] = merged.get("name") or existing.get("name") or "Unknown"
                    contacts[normalized_phone] = merged
            except Exception:
                pass
        return contacts

    def _read_sms_entries(self, limit=None, phone=None):
        contacts = self._load_sms_contacts_map()
        normalized_phone = self._normalize_sms_phone(phone) if phone else ""
        entries = []
        seen = set()
        for path in self._sms_log_paths():
            try:
                with open(path) as f:
                    for raw_line in f:
                        raw_line = raw_line.strip()
                        if not raw_line:
                            continue
                        try:
                            entry = json.loads(raw_line)
                        except Exception:
                            continue
                        entry_phone = self._normalize_sms_phone(entry.get("phone", ""))
                        if normalized_phone and entry_phone != normalized_phone:
                            continue
                        entry["phone"] = entry_phone or entry.get("phone", "")
                        if entry_phone:
                            contact_name = contacts.get(entry_phone, {}).get("name")
                            if contact_name and (not entry.get("name") or entry.get("name") == "Unknown"):
                                entry["name"] = contact_name
                        entry["timestamp"] = self._normalize_sms_timestamp(entry)
                        media = self._normalize_sms_media(entry)
                        if media:
                            entry["media"] = media
                        key = (
                            entry.get("sid") or "",
                            entry.get("type") or "",
                            entry.get("phone") or "",
                            entry.get("timestamp") or "",
                            entry.get("body") or "",
                            json.dumps(media, sort_keys=True),
                        )
                        if key in seen:
                            continue
                        seen.add(key)
                        entries.append(entry)
            except FileNotFoundError:
                continue
            except Exception:
                continue
        entries.sort(key=lambda item: self._sms_sort_value(item.get("timestamp")))
        entries = self._enrich_sms_entries_with_twilio_media(entries)
        if limit and len(entries) > limit:
            entries = entries[-limit:]
        return entries

    def _build_sms_threads(self, limit=200):
        contacts = self._load_sms_contacts_map()
        threads = {}
        for message in self._read_sms_entries(limit=None):
            if message.get("type") == "blocked":
                continue
            phone = self._normalize_sms_phone(message.get("phone", ""))
            if not phone or phone == "Unknown":
                continue
            thread = threads.setdefault(phone, {
                "phone": phone,
                "name": contacts.get(phone, {}).get("name") or message.get("name") or "Unknown",
                "lastMessage": "",
                "lastTimestamp": "",
                "lastType": "",
                "messageCount": 0,
            })
            thread["messageCount"] += 1
            body = message.get("body", "")
            media_count = len(message.get("media") or [])
            thread["lastMessage"] = body or (f"📎 {media_count} media attachment" + ("s" if media_count != 1 else "") if media_count else "")
            thread["lastTimestamp"] = message.get("timestamp", "")
            thread["lastType"] = message.get("type", "")
            if (not thread.get("name") or thread.get("name") == "Unknown") and message.get("name"):
                thread["name"] = message.get("name")

        for phone, info in contacts.items():
            threads.setdefault(phone, {
                "phone": phone,
                "name": (info or {}).get("name") or "Unknown",
                "lastMessage": "",
                "lastTimestamp": "",
                "lastType": "",
                "messageCount": 0,
            })

        results = []
        for phone, thread in threads.items():
            thread["activeMode"] = self._sms_mode_for_phone(phone)
            thread["displayName"] = thread.get("name") or phone
            results.append(thread)

        results.sort(key=lambda item: (
            0 if item.get("lastTimestamp") else 1,
            -self._sms_sort_value(item.get("lastTimestamp")),
            (item.get("displayName") or item.get("phone") or "").lower(),
        ))
        if limit and len(results) > limit:
            results = results[:limit]
        return results

    def _get_sms_log(self, limit=100):
        try:
            return {"ok": True, "messages": self._read_sms_entries(limit=limit)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _get_sms_contacts(self):
        try:
            return {"ok": True, "contacts": self._load_sms_contacts_map()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _get_sms_threads(self, limit=200):
        try:
            return {
                "ok": True,
                "threads": self._build_sms_threads(limit=limit),
                "ownerAgent": self._get_sms_owner_agent_info(),
            }
        except Exception as e:
            return {"ok": False, "error": str(e), "threads": []}

    def _get_sms_thread(self, phone, limit=250):
        phone = self._normalize_sms_phone(phone)
        if not phone:
            return {"ok": False, "error": "Missing phone", "messages": []}
        contacts = self._load_sms_contacts_map()
        messages = self._read_sms_entries(limit=limit, phone=phone)
        thread = {
            "phone": phone,
            "name": contacts.get(phone, {}).get("name") or (messages[-1].get("name") if messages else "Unknown") or "Unknown",
            "activeMode": self._sms_mode_for_phone(phone),
            "messageCount": len(messages),
            "ownerAgent": self._get_sms_owner_agent_info(),
        }
        if messages:
            last = messages[-1]
            media_count = len(last.get("media") or [])
            thread["lastMessage"] = last.get("body", "") or (f"📎 {media_count} media attachment" + ("s" if media_count != 1 else "") if media_count else "")
            thread["lastTimestamp"] = last.get("timestamp", "")
            thread["lastType"] = last.get("type", "")
        return {"ok": True, "thread": thread, "messages": messages}

    def _send_sms_intervention(self, to, body, name="", sender="user"):
        """Send SMS via Twilio (config-driven credentials)."""
        to = self._normalize_sms_phone(to)
        if not to or not body:
            return {"ok": False, "error": "Missing 'to' or 'body'"}
        sms_cfg = VO_CONFIG.get("sms", {})
        account_sid = sms_cfg.get("twilioAccountSid")
        auth_token = sms_cfg.get("twilioAuthToken")
        from_number = sms_cfg.get("fromNumber")
        if not account_sid or not auth_token or not from_number:
            return {"ok": False, "error": "SMS not configured. Set Twilio credentials in Settings or /setup."}

        sender = "agent" if sender == "agent" else "user"
        entry_type = "outbound" if sender == "agent" else "intervention"
        sms_log_path = self._sms_primary_log_path()
        contacts_path = self._sms_primary_contacts_path()

        try:
            url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"
            data = urllib.parse.urlencode({"To": to, "From": from_number, "Body": body}).encode()
            credentials = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()
            req = urllib.request.Request(url, data=data, method="POST")
            req.add_header("Authorization", f"Basic {credentials}")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
            with urllib.request.urlopen(req) as resp:
                result = json.loads(resp.read().decode())

            entry = {
                "type": entry_type,
                "phone": to,
                "name": name or self._load_sms_contacts_map().get(to, {}).get("name") or "Unknown",
                "body": body,
                "sid": result.get("sid"),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }

            with open(sms_log_path, "a") as f:
                f.write(json.dumps(entry) + "\n")

            try:
                with open(contacts_path) as f:
                    contacts = json.load(f)
                if not isinstance(contacts, dict):
                    contacts = {}
            except Exception:
                contacts = {}

            if to not in contacts:
                contacts[to] = {
                    "name": name or "Unknown",
                    "added": datetime.now().strftime("%Y-%m-%d"),
                    "note": "Added via Virtual Office",
                }
            elif name and contacts[to].get("name") in (None, "", "Unknown"):
                contacts[to]["name"] = name

            with open(contacts_path, "w") as f:
                json.dump(contacts, f, indent=2)

            return {
                "ok": True,
                "sid": result.get("sid"),
                "status": result.get("status"),
                "phone": to,
                "sender": sender,
                "type": entry_type,
            }
        except urllib.error.HTTPError as e:
            err = e.read().decode()
            try:
                return {"ok": False, "error": json.loads(err).get("message", err[:200])}
            except Exception:
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
        gateway_presence.start(gw_url, gw_token, port=PORT, client_version=_get_openclaw_version())
    else:
        print("⚠️  No gateway token found — gateway presence disabled")

    # Start periodic snapshot saver (every 30s)
    def snapshot_loop():
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
    time.sleep(3)  # Let the server fully start first

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
