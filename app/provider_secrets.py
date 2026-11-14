"""Secrets of agent-provider connections, kept on the server only.

One JSON file, ``<data>/provider-secrets.json``, mode 0600, written atomically:

    {"version": 1, "items": {"hermes:<connId>": {"token": "...", "tokens": "{...}"}}}

Pages never get a value from here: they get ``flags()`` (``{field: True}``) at most.
Legacy secrets (the Hermes API-server ``apiKey`` and OpenClaw's ``gatewayToken``)
stay in ``vo-config.json`` because other code reads them there.
"""

import json
import os
import re
import threading

import private_files

FILE_NAME = "provider-secrets.json"
VERSION = 1


class SecretStoreError(Exception):
    """The secrets file exists but cannot be read; it is never overwritten then."""


def _item_key(kind, cid):
    kind = str(kind or "").strip()
    cid = str(cid or "").strip()
    if not kind or not cid or ":" in kind:
        raise ValueError("A secret needs a provider kind and a connection id.")
    return f"{kind}:{cid}"


class SecretStore:
    def __init__(self, path):
        self.path = path
        self._lock = threading.RLock()

    # ── file ─────────────────────────────────────────────────────────────
    def _read(self):
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        except FileNotFoundError:
            return {"version": VERSION, "items": {}}
        except OSError as exc:
            raise SecretStoreError(f"{os.path.basename(self.path)} cannot be read: {exc}")
        try:
            data = json.loads(raw) if raw.strip() else None
        except ValueError:
            data = None
        if not isinstance(data, dict) or not isinstance(data.get("items"), dict):
            raise SecretStoreError(f"{os.path.basename(self.path)} is damaged; it was left as it is.")
        return data

    def _write(self, data):
        # private, keeps the owner (Docker runs as root; v0.10.1 upgrade fix)
        private_files.write_private(self.path, json.dumps(data, indent=2, sort_keys=True) + "\n")

    # ── API ──────────────────────────────────────────────────────────────
    def get(self, kind, cid, field):
        with self._lock:
            item = self._read()["items"].get(_item_key(kind, cid)) or {}
        value = item.get(field) if isinstance(item, dict) else None
        return value if isinstance(value, str) and value else None

    def set(self, kind, cid, field, value):
        """Store ``value`` (a non-empty string); ``None`` or "" deletes the field."""
        if value is None or value == "":
            return self.delete(kind, cid, field)
        if not isinstance(value, str):
            raise ValueError("A secret value must be text.")
        key = _item_key(kind, cid)
        with self._lock:
            data = self._read()
            item = data["items"].get(key)
            item = dict(item) if isinstance(item, dict) else {}
            if item.get(field) == value:
                return False
            item[str(field)] = value
            data["items"][key] = item
            data["version"] = VERSION
            self._write(data)
        return True

    def delete(self, kind, cid, field=None):
        """Forget one field, or every secret of the connection when ``field`` is None."""
        key = _item_key(kind, cid)
        with self._lock:
            data = self._read()
            item = data["items"].get(key)
            if not isinstance(item, dict):
                return False
            if field is None:
                data["items"].pop(key, None)
            elif field in item:
                item = dict(item)
                item.pop(field, None)
                if item:
                    data["items"][key] = item
                else:
                    data["items"].pop(key, None)
            else:
                return False
            self._write(data)
        return True

    def flags(self, kind, cid):
        with self._lock:
            item = self._read()["items"].get(_item_key(kind, cid)) or {}
        return {str(k): True for k, v in item.items() if isinstance(v, str) and v} if isinstance(item, dict) else {}

    def values(self):
        """Every stored secret value (for log redaction only; never sent anywhere)."""
        with self._lock:
            items = self._read()["items"]
        out = []
        for item in items.values():
            if isinstance(item, dict):
                out.extend(v for v in item.values() if isinstance(v, str) and v)
        return out

    def persist(self, kind):
        """A ``persist(cid, field, value_or_None)`` callback for one provider kind (links use it)."""
        def _persist(cid, field, value):
            return self.set(kind, cid, field, value)
        return _persist

    def ensure_mode(self):
        private_files.tighten(self.path)


# ── log redaction (design 5.2 C3) ────────────────────────────────────────
REDACTED = "[redacted]"
_QUERY_SECRET_RE = re.compile(
    r"([?&](?:t|token|key|api_?key|access_?token|refresh_?token|password|passcode|secret|code|sig)=)[^&\s\"'#]+",
    re.IGNORECASE)
_AUTH_SECRET_RE = re.compile(r"(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=:-]{8,}")
_MIN_SECRET_LEN = 6


def redact_text(text, secrets=()):
    """A log line without credentials: known secret values, token-like query values (``?t=``,
    ``&token=`` ...) and Bearer/Basic credentials become ``[redacted]``."""
    if not isinstance(text, str) or not text:
        return text
    for value in secrets or ():
        if isinstance(value, str) and len(value) >= _MIN_SECRET_LEN and value in text:
            text = text.replace(value, REDACTED)
    text = _QUERY_SECRET_RE.sub(r"\1" + REDACTED, text)
    return _AUTH_SECRET_RE.sub(r"\1" + REDACTED, text)
