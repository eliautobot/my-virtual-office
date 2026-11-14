"""Narrow subprocess environments for local provider CLIs."""

from __future__ import annotations

import os
import re
import shutil


_BASE_ENV_KEYS = {
    "HOME",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
}


def resolve_executable(value: str | None, env_var: str, default_name: str) -> str:
    for candidate in (value, os.environ.get(env_var), default_name):
        if not candidate:
            continue
        expanded = os.path.expanduser(str(candidate).strip())
        resolved = shutil.which(expanded) if os.path.basename(expanded) == expanded else expanded
        if resolved and os.path.isfile(resolved) and os.access(resolved, os.X_OK):
            return os.path.abspath(resolved)
    return os.path.expanduser(str(value or os.environ.get(env_var) or "").strip())


def sanitized_env(extra_allowlist_var: str = "") -> dict[str, str]:
    allowed = set(_BASE_ENV_KEYS)
    allowed.update(key for key in os.environ if key.startswith("LC_"))
    for raw in os.environ.get(extra_allowlist_var, "").split(","):
        key = raw.strip()
        if key and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            allowed.add(key)
    return {key: os.environ[key] for key in allowed if key in os.environ}


def agent_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for agent CLIs that run tools (BE-13).

    Agents keep what their own CLI needs (PATH, HOME, provider API keys, proxies),
    but never the office's secrets: every ``VO_*`` variable (gateway token, Twilio
    and Hermes credentials, agent API token) and anything listed in
    ``VO_AGENT_ENV_DENY`` is removed, so a prompt-injected ``env`` cannot read them.
    """
    deny = {raw.strip() for raw in os.environ.get("VO_AGENT_ENV_DENY", "").split(",") if raw.strip()}
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith("VO_") and not key.startswith("TWILIO_") and key not in deny
    }
    for key, value in (extra or {}).items():
        if value is not None:
            env[key] = str(value)
    return env
