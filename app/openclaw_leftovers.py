"""Settings an older office (v0.7.4) wrote into openclaw.json (v0.10.1 upgrade fix).

v0.7.4's gateway setup added ``gateway.controlUi.allowInsecureAuth`` and
``gateway.controlUi.dangerouslyDisableDeviceAuth`` and allowed the office's own
address in ``gateway.controlUi.allowedOrigins``. Current OpenClaw rejects
``allowInsecureAuth`` ("config reload skipped (invalid config)") and ignores the
other flag; this office connects as a backend client and needs none of them.

Pure functions only: the server reads and writes the file through its safe
openclaw.json editor (plain JSON only, lock, backup, atomic replace) and only
when the user asks. Nothing here touches a file.
"""
import re
import urllib.parse

RETIRED_KEYS = ("allowInsecureAuth", "dangerouslyDisableDeviceAuth")
DOCTOR_COMMAND = "openclaw doctor --fix"
_KEY_IN_TEXT = re.compile(r"""["']?\b(allowInsecureAuth|dangerouslyDisableDeviceAuth)\b["']?\s*:""")


def _control_ui(cfg):
    gateway = cfg.get("gateway") if isinstance(cfg, dict) else None
    control_ui = gateway.get("controlUi") if isinstance(gateway, dict) else None
    return control_ui if isinstance(control_ui, dict) else None


def is_office_origin(origin, ports=(), hosts=()):
    """True when ``origin`` is an address of this office: http(s) on one of its
    ``ports``, or exactly one of ``hosts`` (host:port the browser used)."""
    if not isinstance(origin, str):
        return False
    try:
        parts = urllib.parse.urlsplit(origin.strip())
        port = parts.port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.path not in ("", "/") or parts.query:
        return False
    if port is None:
        port = 443 if parts.scheme == "https" else 80
    wanted = {int(p) for p in ports if str(p).isdigit()}
    return port in wanted or parts.netloc.lower() in {str(h).strip().lower() for h in hosts if h}


def detect(cfg, ports=(), hosts=()):
    """What v0.7.4 left in a parsed openclaw.json.

    ``keys``: the retired flags that are present. ``origins``: this office's
    entries in allowedOrigins; they only count as leftovers next to a retired
    flag (this office's own setup may allow its address on purpose)."""
    control_ui = _control_ui(cfg)
    if control_ui is None:
        return {"found": False, "keys": [], "origins": []}
    keys = [f"gateway.controlUi.{key}" for key in RETIRED_KEYS if key in control_ui]
    origins = []
    allowed = control_ui.get("allowedOrigins")
    if keys and isinstance(allowed, list):
        origins = [o for o in allowed if is_office_origin(o, ports, hosts)]
    return {"found": bool(keys), "keys": keys, "origins": origins}


def detect_text(text):
    """Retired flag names seen in a file that is not plain JSON (comments/JSON5).
    The server never edits such a file; this only decides whether to tell the user."""
    seen = []
    for match in _KEY_IN_TEXT.finditer(str(text or "")):
        path = f"gateway.controlUi.{match.group(1)}"
        if path not in seen:
            seen.append(path)
    return {"found": bool(seen), "keys": seen, "origins": []}


def cleanup(cfg, ports=(), hosts=(), keep_origins=False):
    """Remove the leftovers from ``cfg`` in place. Returns what was removed
    (empty when there was nothing to do). An allowedOrigins list or controlUi
    object that ends up empty is removed too, as before v0.7.4 added it."""
    found = detect(cfg, ports, hosts)
    if not found["found"]:
        return []
    control_ui = _control_ui(cfg)
    removed = []
    for key in RETIRED_KEYS:
        if key in control_ui:
            del control_ui[key]
            removed.append(f"gateway.controlUi.{key}")
    allowed = control_ui.get("allowedOrigins")
    if not keep_origins and found["origins"] and isinstance(allowed, list):
        drop = set(found["origins"])
        control_ui["allowedOrigins"] = [o for o in allowed if o not in drop]
        removed.extend(f"gateway.controlUi.allowedOrigins: {o}" for o in found["origins"])
        if not control_ui["allowedOrigins"]:
            del control_ui["allowedOrigins"]
    if not control_ui:
        del cfg["gateway"]["controlUi"]
    return removed
