"""Small helpers for provider subprocess execution."""

from __future__ import annotations

import os
import re
import shutil


_BASE_ENV_KEYS = {
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
}


def resolve_executable(value: str | None, env_var: str, default_name: str) -> str:
    """Resolve absolute paths and bare command names consistently."""
    for candidate in (value, os.environ.get(env_var), default_name):
        if not candidate:
            continue
        expanded = os.path.expanduser(str(candidate).strip())
        if not expanded:
            continue
        resolved = shutil.which(expanded) if os.path.basename(expanded) == expanded else expanded
        if resolved and os.path.isfile(resolved):
            return resolved
    raw = value or os.environ.get(env_var) or ""
    return os.path.expanduser(str(raw).strip())


def sanitized_env(extra_allowlist_var: str = "") -> dict[str, str]:
    """Return a narrow subprocess environment.

    Provider CLIs should not inherit Virtual Office, OpenClaw gateway, HMAC,
    Twilio, or dev-only secrets by default. Deployments that need additional
    env vars can list exact key names in the provider-specific
    ``VO_*_ENV_ALLOWLIST`` setting.
    """
    allowed = set(_BASE_ENV_KEYS)
    allowed.update(k for k in os.environ if k.startswith("LC_"))
    if extra_allowlist_var:
        for raw in os.environ.get(extra_allowlist_var, "").split(","):
            key = raw.strip()
            if key and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                allowed.add(key)

    env: dict[str, str] = {}
    for key in allowed:
        value = os.environ.get(key)
        if value is not None:
            env[key] = value
    return env
