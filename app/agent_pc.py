"""Persistent, provider-neutral Agent PC filesystem index.

The provider filesystem remains authoritative. This module stores only safe
root metadata, deduplicated activity, UI state, and explicit Saved snapshots.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import ntpath
import os
import posixpath
import re
import shutil
import sqlite3
import threading
import time
import urllib.parse
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from providers.path_mapping import is_windows_absolute
import data_owner


SCHEMA_VERSION = "agent-pc/v1"
TREE_LIMIT = 500
RECENT_LIMIT = 100
RECENT_MAX_AGE_SEC = 90 * 24 * 60 * 60
UI_STATE_MAX_BYTES = 128 * 1024
TEXT_MAX_BYTES = 2 * 1024 * 1024
DOCUMENT_MAX_BYTES = 24 * 1024 * 1024
MEDIA_MAX_BYTES = 100 * 1024 * 1024
SAVE_MAX_BYTES = 100 * 1024 * 1024

NOISY_DIRECTORIES = {
    ".git", ".hg", ".svn", ".cache", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", "__pycache__", "node_modules", "vendor", "dist", "build",
    "target", ".next", ".nuxt", ".venv", "venv", "env", "coverage",
}
SENSITIVE_DIRECTORIES = {
    "auth", "credential", "credentials", "keychain", "keychains",
    "keyring", "keyrings", "private-keys", "secret", "secrets", "ssh",
    "token", "tokens",
}
SECRET_BASENAMES = {
    ".env", "auth.json", "openclaw.json", "credentials.json", "secrets.json",
    "id_rsa", "id_ed25519", "known_hosts", "authorized_keys", ".netrc",
    "cookies.sqlite", "login data", "web data",
}
SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore")

EXTENSION_KINDS = {
    ".html": ("html", "text/html; charset=utf-8", "html"),
    ".htm": ("html", "text/html; charset=utf-8", "html"),
    ".md": ("markdown", "text/markdown; charset=utf-8", "markdown"),
    ".markdown": ("markdown", "text/markdown; charset=utf-8", "markdown"),
    ".txt": ("text", "text/plain; charset=utf-8", "text"),
    ".log": ("text", "text/plain; charset=utf-8", "text"),
    ".csv": ("text", "text/csv; charset=utf-8", "csv"),
    ".json": ("code", "application/json; charset=utf-8", "json"),
    ".jsonl": ("code", "application/x-ndjson; charset=utf-8", "json"),
    ".yaml": ("code", "text/yaml; charset=utf-8", "yaml"),
    ".yml": ("code", "text/yaml; charset=utf-8", "yaml"),
    ".toml": ("code", "text/plain; charset=utf-8", "toml"),
    ".xml": ("code", "application/xml; charset=utf-8", "xml"),
    ".css": ("code", "text/css; charset=utf-8", "css"),
    ".scss": ("code", "text/plain; charset=utf-8", "scss"),
    ".js": ("code", "text/javascript; charset=utf-8", "javascript"),
    ".mjs": ("code", "text/javascript; charset=utf-8", "javascript"),
    ".cjs": ("code", "text/javascript; charset=utf-8", "javascript"),
    ".jsx": ("code", "text/plain; charset=utf-8", "jsx"),
    ".ts": ("code", "text/plain; charset=utf-8", "typescript"),
    ".tsx": ("code", "text/plain; charset=utf-8", "typescript"),
    ".py": ("code", "text/x-python; charset=utf-8", "python"),
    ".go": ("code", "text/plain; charset=utf-8", "go"),
    ".rs": ("code", "text/plain; charset=utf-8", "rust"),
    ".java": ("code", "text/plain; charset=utf-8", "java"),
    ".c": ("code", "text/plain; charset=utf-8", "c"),
    ".h": ("code", "text/plain; charset=utf-8", "c"),
    ".cpp": ("code", "text/plain; charset=utf-8", "cpp"),
    ".hpp": ("code", "text/plain; charset=utf-8", "cpp"),
    ".sh": ("code", "text/plain; charset=utf-8", "shell"),
    ".ps1": ("code", "text/plain; charset=utf-8", "powershell"),
    ".bat": ("code", "text/plain; charset=utf-8", "batch"),
    ".sql": ("code", "text/plain; charset=utf-8", "sql"),
    ".svg": ("image", "image/svg+xml", "svg"),
    ".png": ("image", "image/png", "image"),
    ".jpg": ("image", "image/jpeg", "image"),
    ".jpeg": ("image", "image/jpeg", "image"),
    ".gif": ("image", "image/gif", "image"),
    ".webp": ("image", "image/webp", "image"),
    ".avif": ("image", "image/avif", "image"),
    ".pdf": ("pdf", "application/pdf", "pdf"),
    ".mp4": ("video", "video/mp4", "video"),
    ".webm": ("video", "video/webm", "video"),
    ".mov": ("video", "video/quicktime", "video"),
    ".m4v": ("video", "video/x-m4v", "video"),
    ".mp3": ("audio", "audio/mpeg", "audio"),
    ".wav": ("audio", "audio/wav", "audio"),
    ".ogg": ("audio", "audio/ogg", "audio"),
    ".m4a": ("audio", "audio/mp4", "audio"),
    ".flac": ("audio", "audio/flac", "audio"),
}

OUTPUT_TOOL_PATTERN = re.compile(
    r"(^|[._-])(write|edit|patch|apply[_-]?patch|create|save|export|generate|imagegen|image[_-]?gen|render)([._-]|$)",
    re.I,
)
SOURCE_TOOL_PATTERN = re.compile(
    r"(^|[._-])(read|view|open|fetch|web[_-]?fetch|search|inspect|snapshot)([._-]|$)",
    re.I,
)


class AgentPCError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details

    def payload(self):
        error = {"code": self.code, "message": self.message}
        if self.details:
            error["details"] = self.details
        return {"ok": False, "error": error}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def bounded_text(value, limit):
    """Normalize untrusted provider metadata before it reaches SQLite."""
    text = str(value or "")
    return text if len(text) <= limit else text[:limit]


def safe_relative_path(value, *, allow_empty=True):
    raw = str(value or "").replace("\\", "/").strip()
    if raw in ("", "."):
        return "" if allow_empty else None
    if raw.startswith("/") or raw.startswith("//") or re.match(r"^[A-Za-z]:/", raw) or "\x00" in raw:
        return None
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        return None
    return "/".join(parts)


def sensitive_path(value):
    parts = [part for part in str(value or "").replace("\\", "/").split("/") if part]
    for part in parts:
        lowered = part.lower()
        if lowered.startswith(".") or lowered in SECRET_BASENAMES:
            return True
        if lowered in SENSITIVE_DIRECTORIES:
            return True
        if lowered.startswith(("credentials.", "secrets.", "tokens.", "private-key.")):
            return True
        if lowered.endswith(SECRET_SUFFIXES):
            return True
    return False


def classify_operation(tool_name="", explicit=""):
    requested = str(explicit or "").strip().lower()
    if requested in {"source", "output"}:
        return requested
    name = str(tool_name or "").replace("functions.", "")
    if OUTPUT_TOOL_PATTERN.search(name):
        return "output"
    if SOURCE_TOOL_PATTERN.search(name):
        return "source"
    return "recent"


def parse_path_mappings(raw=None):
    if raw is None:
        raw = os.environ.get("VO_AGENT_PC_PATH_MAPPINGS_JSON", "[]")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except json.JSONDecodeError:
            return []
    rows = []
    for index, item in enumerate(raw if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        mapping_id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(item.get("id") or f"mapping-{index + 1}")).strip("-.")
        connector_url = str(item.get("connectorUrl") or "").strip().rstrip("/")
        container_path = str(item.get("containerPath") or "").strip()
        host_path = str(item.get("hostPath") or item.get("path") or "").strip()
        if not mapping_id or (not container_path and not connector_url):
            continue
        rows.append({
            "id": mapping_id,
            "label": str(item.get("label") or mapping_id).strip(),
            "hostPath": host_path,
            "containerPath": os.path.abspath(os.path.expanduser(container_path)) if container_path else "",
            "readOnly": item.get("readOnly") is not False,
            "connectorUrl": connector_url,
            "connectorToken": str(item.get("connectorToken") or item.get("token") or ""),
            "connectorRootId": str(item.get("connectorRootId") or item.get("rootId") or ""),
        })
    return rows


class AgentPCStore:
    def __init__(self, data_dir, *, path_mappings=None, recent_limit=RECENT_LIMIT):
        self.data_dir = os.path.abspath(os.path.expanduser(str(data_dir)))
        self.db_path = os.path.join(self.data_dir, "agent-pc.sqlite")
        self.saved_dir = os.path.join(self.data_dir, "saved")
        self.path_mappings = parse_path_mappings(path_mappings)
        self.recent_limit = max(10, min(1000, int(recent_limit)))
        self._lock = threading.RLock()
        self._connector_health_cache = {}
        data_owner.makedirs(self.saved_dir, exist_ok=True)
        self._initialize()
        data_owner.adopt(self.db_path)   # (SQLite gives its -wal/-shm files the database's owner)

    def _connect(self):
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    @contextmanager
    def _db(self):
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self):
        with self._lock, self._db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS profiles (
                    agent_id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    provider_kind TEXT NOT NULL DEFAULT '',
                    provider_agent_id TEXT NOT NULL DEFAULT '',
                    workspace_path TEXT NOT NULL DEFAULT '',
                    archived_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS roots (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    label TEXT NOT NULL,
                    mapping_id TEXT NOT NULL DEFAULT '',
                    host_path TEXT NOT NULL DEFAULT '',
                    local_path TEXT NOT NULL DEFAULT '',
                    remote_path TEXT NOT NULL DEFAULT '',
                    connector_url TEXT NOT NULL DEFAULT '',
                    connector_root_id TEXT NOT NULL DEFAULT '',
                    read_only INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    UNIQUE(agent_id, kind, mapping_id, local_path, remote_path),
                    FOREIGN KEY(agent_id) REFERENCES profiles(agent_id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS activity (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    canonical_key TEXT NOT NULL,
                    resource_kind TEXT NOT NULL,
                    operation TEXT NOT NULL,
                    root_id TEXT NOT NULL DEFAULT '',
                    relative_path TEXT NOT NULL DEFAULT '',
                    raw_path TEXT NOT NULL DEFAULT '',
                    url TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    tool_name TEXT NOT NULL DEFAULT '',
                    source TEXT NOT NULL DEFAULT '',
                    session_id TEXT NOT NULL DEFAULT '',
                    run_id TEXT NOT NULL DEFAULT '',
                    first_seen REAL NOT NULL,
                    last_seen REAL NOT NULL,
                    touch_count INTEGER NOT NULL DEFAULT 1,
                    UNIQUE(agent_id, canonical_key),
                    FOREIGN KEY(agent_id) REFERENCES profiles(agent_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS activity_agent_seen ON activity(agent_id, last_seen DESC);
                CREATE TABLE IF NOT EXISTS saved (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    resource_kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    source_root_id TEXT NOT NULL DEFAULT '',
                    source_path TEXT NOT NULL DEFAULT '',
                    source_url TEXT NOT NULL DEFAULT '',
                    blob_name TEXT NOT NULL DEFAULT '',
                    checksum TEXT NOT NULL DEFAULT '',
                    mime_type TEXT NOT NULL DEFAULT '',
                    size INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(agent_id) REFERENCES profiles(agent_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS saved_agent_created ON saved(agent_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS ui_state (
                    agent_id TEXT PRIMARY KEY,
                    state_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(agent_id) REFERENCES profiles(agent_id) ON DELETE CASCADE
                );
                """
            )

    def ensure_profile(self, agent):
        agent = agent if isinstance(agent, dict) else {}
        agent_id = str(agent.get("statusKey") or agent.get("id") or "").strip()
        if not agent_id:
            raise AgentPCError("agent_required", "A valid agent id is required.")
        now = utc_now()
        values = (
            agent_id,
            str(agent.get("displayName") or agent.get("name") or agent_id),
            str(agent.get("providerKind") or "openclaw"),
            str(agent.get("providerAgentId") or agent.get("profile") or agent.get("id") or agent_id),
            str(agent.get("workspace") or agent.get("home") or ""),
            now,
            now,
        )
        with self._lock, self._db() as db:
            db.execute(
                """INSERT INTO profiles(agent_id, display_name, provider_kind, provider_agent_id, workspace_path, created_at, updated_at)
                   VALUES(?,?,?,?,?,?,?)
                   ON CONFLICT(agent_id) DO UPDATE SET display_name=excluded.display_name,
                     provider_kind=excluded.provider_kind, provider_agent_id=excluded.provider_agent_id,
                     workspace_path=excluded.workspace_path, archived_at=NULL, updated_at=excluded.updated_at""",
                values,
            )
        return agent_id

    def archive_profile(self, agent_id):
        with self._lock, self._db() as db:
            db.execute("UPDATE profiles SET archived_at=?, updated_at=? WHERE agent_id=?", (utc_now(), utc_now(), str(agent_id)))

    def available_mappings(self):
        result = []
        for mapping in self.path_mappings:
            remote = bool(mapping["connectorUrl"])
            online = self._connector_is_online(mapping) if remote else bool(mapping["containerPath"] and os.path.isdir(mapping["containerPath"]))
            result.append({
                "id": mapping["id"], "label": mapping["label"], "hostPath": mapping["hostPath"],
                "containerPath": mapping["containerPath"], "readOnly": mapping["readOnly"],
                "transport": "connector" if remote else "local", "online": online,
            })
        return result

    def _profile(self, agent_id):
        with self._db() as db:
            row = db.execute("SELECT * FROM profiles WHERE agent_id=?", (str(agent_id),)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def _mapping_relative_path(workspace_path, host_root):
        workspace = str(workspace_path or "").strip()
        root = str(host_root or "").strip()
        if not workspace or not root:
            return None
        try:
            if is_windows_absolute(workspace) and is_windows_absolute(root):
                normalized_workspace = ntpath.normpath(workspace)
                normalized_root = ntpath.normpath(root)
                common = ntpath.commonpath([normalized_root, normalized_workspace])
                if ntpath.normcase(common) != ntpath.normcase(normalized_root):
                    return None
                relative = ntpath.relpath(normalized_workspace, normalized_root).replace("\\", "/")
            elif not is_windows_absolute(workspace) and not is_windows_absolute(root) and os.path.isabs(workspace) and os.path.isabs(root):
                normalized_workspace = os.path.abspath(os.path.expanduser(workspace))
                normalized_root = os.path.abspath(os.path.expanduser(root))
                if os.path.commonpath([normalized_root, normalized_workspace]) != normalized_root:
                    return None
                relative = os.path.relpath(normalized_workspace, normalized_root).replace(os.sep, "/")
            else:
                return None
        except (OSError, ValueError):
            return None
        if relative == ".":
            return ""
        return safe_relative_path(relative)

    def _mapped_home_root(self, profile):
        workspace_path = str(profile.get("workspace_path") or "").strip()
        for mapping in self.path_mappings:
            relative = self._mapping_relative_path(workspace_path, mapping.get("hostPath"))
            if relative is None:
                continue
            if mapping.get("connectorUrl") and mapping.get("connectorRootId"):
                return {
                    "id": "home", "kind": "home", "label": "Agent Home", "readOnly": True,
                    "online": self._connector_is_online(mapping), "transport": "connector", "displayPath": workspace_path,
                    "mapping_id": mapping["id"], "_localPath": "",
                    "_connectorUrl": mapping["connectorUrl"], "_connectorRootId": mapping["connectorRootId"],
                    "_remotePath": relative,
                }
            base = str(mapping.get("containerPath") or "")
            if not base:
                continue
            base_real = os.path.realpath(os.path.abspath(os.path.expanduser(base)))
            candidate = os.path.realpath(os.path.join(base_real, *(relative.split("/") if relative else [])))
            try:
                inside = os.path.commonpath([base_real, candidate]) == base_real
            except ValueError:
                inside = False
            if inside:
                return {
                    "id": "home", "kind": "home", "label": "Agent Home", "readOnly": True,
                    "online": os.path.isdir(candidate), "transport": "local", "displayPath": workspace_path,
                    "mapping_id": mapping["id"], "_localPath": candidate,
                }
        return None

    def roots(self, agent_id, *, home_path=""):
        profile = self._profile(agent_id)
        if not profile:
            raise AgentPCError("agent_not_found", "Agent PC profile was not found.", 404)
        result = []
        # A drive-letter path is local when this server is running natively on
        # Windows; on Linux it must resolve through an approved mapping.
        home = os.path.abspath(os.path.expanduser(home_path)) if home_path and (os.name == "nt" or not is_windows_absolute(home_path)) else ""
        if home:
            result.append({
                "id": "home", "kind": "home", "label": "Agent Home", "readOnly": True,
                "online": os.path.isdir(home), "transport": "local", "displayPath": profile.get("workspace_path") or home,
                "_localPath": home,
            })
        else:
            mapped_home = self._mapped_home_root(profile)
            if mapped_home:
                result.append(mapped_home)
        if not result and profile.get("workspace_path"):
            result.append({
                "id": "home", "kind": "home", "label": "Agent Home", "readOnly": True,
                "online": False, "transport": "unavailable", "displayPath": profile["workspace_path"], "_localPath": "",
            })
        with self._db() as db:
            rows = db.execute("SELECT * FROM roots WHERE agent_id=? ORDER BY created_at", (str(agent_id),)).fetchall()
        for row in rows:
            item = dict(row)
            local_path = item.pop("local_path")
            connector_url = item.pop("connector_url")
            connector_root_id = item.pop("connector_root_id", "")
            remote_path = item.pop("remote_path", "")
            mapping = next((mapping for mapping in self.path_mappings if mapping["id"] == item.get("mapping_id")), None)
            item.update({
                "readOnly": bool(item.pop("read_only")),
                "displayPath": item.pop("host_path") or local_path,
                "transport": "connector" if connector_url else "local",
                "online": self._connector_is_online(mapping) if connector_url and mapping else (False if connector_url else os.path.isdir(local_path)),
                "_localPath": local_path,
                "_connectorUrl": connector_url,
                "_connectorRootId": connector_root_id,
                "_remotePath": remote_path,
            })
            result.append(item)
        return result

    def public_roots(self, agent_id, *, home_path=""):
        return [{key: value for key, value in row.items() if not key.startswith("_")} for row in self.roots(agent_id, home_path=home_path)]

    def connect_root(self, agent_id, payload):
        mapping_id = str((payload or {}).get("mappingId") or "").strip()
        mapping = next((item for item in self.path_mappings if item["id"] == mapping_id), None)
        if not mapping:
            raise AgentPCError("mapping_not_found", "Choose an administrator-approved folder mapping.", 404)
        relative = safe_relative_path((payload or {}).get("path") or "")
        if relative is None or sensitive_path(relative):
            raise AgentPCError("invalid_path", "The connected folder path is not allowed.", 403)
        if mapping["connectorUrl"]:
            local_path = ""
            remote_path = relative
            if not mapping["connectorRootId"]:
                raise AgentPCError("connector_root_required", "Remote mapping must declare connectorRootId.", 409)
            self._connector_json({
                "mapping_id": mapping_id,
                "_connectorRootId": mapping["connectorRootId"],
                "_remotePath": remote_path,
            }, "tree", "")
        else:
            base = mapping["containerPath"]
            if not base or not os.path.isdir(base):
                raise AgentPCError("mapping_offline", "The mapped folder is not visible to My Virtual Office.", 409, containerPath=base)
            local_path = self._inside_local_root(base, relative, require_directory=True)
            remote_path = ""
        if mapping["hostPath"] and relative:
            host_path = ntpath.normpath(ntpath.join(mapping["hostPath"], *relative.split("/"))) if is_windows_absolute(mapping["hostPath"]) else os.path.normpath(os.path.join(mapping["hostPath"], *relative.split("/")))
        else:
            host_path = mapping["hostPath"]
        root_id = f"root-{uuid.uuid4().hex[:12]}"
        label = str((payload or {}).get("label") or (posixpath.basename(relative) if relative else mapping["label"]) or mapping["label"])[:120]
        now = utc_now()
        with self._lock, self._db() as db:
            try:
                db.execute(
                    """INSERT INTO roots(id, agent_id, kind, label, mapping_id, host_path, local_path, remote_path,
                       connector_url, connector_root_id, read_only, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (root_id, agent_id, "connected", label, mapping_id, host_path, local_path, remote_path,
                     mapping["connectorUrl"], mapping["connectorRootId"], 1, now),
                )
            except sqlite3.IntegrityError:
                row = db.execute(
                    "SELECT id FROM roots WHERE agent_id=? AND kind='connected' AND mapping_id=? AND local_path=? AND remote_path=?",
                    (agent_id, mapping_id, local_path, remote_path),
                ).fetchone()
                root_id = row["id"] if row else root_id
        return {"ok": True, "rootId": root_id}

    def disconnect_root(self, agent_id, root_id):
        if root_id == "home":
            raise AgentPCError("home_required", "Agent Home cannot be disconnected.", 409)
        with self._lock, self._db() as db:
            cursor = db.execute("DELETE FROM roots WHERE id=? AND agent_id=?", (str(root_id), str(agent_id)))
        if not cursor.rowcount:
            raise AgentPCError("root_not_found", "Connected folder was not found.", 404)
        return {"ok": True, "disconnected": root_id}

    def _root(self, agent_id, root_id, *, home_path=""):
        root = next((item for item in self.roots(agent_id, home_path=home_path) if item["id"] == str(root_id)), None)
        if not root:
            raise AgentPCError("root_not_found", "Agent PC root was not found.", 404)
        if not root.get("online") or (root["transport"] != "connector" and not root.get("_localPath")):
            raise AgentPCError("root_offline", "This agent folder is currently offline.", 503)
        return root

    def _connector_is_online(self, mapping, *, max_age=10):
        if not isinstance(mapping, dict) or not mapping.get("connectorUrl") or not mapping.get("connectorToken"):
            return False
        cache_key = f"{mapping.get('connectorUrl')}|{mapping.get('connectorRootId')}"
        now = time.monotonic()
        with self._lock:
            cached = self._connector_health_cache.get(cache_key)
            if cached and now - cached[0] <= max_age:
                return cached[1]
        root = {"mapping_id": mapping.get("id"), "_connectorRootId": mapping.get("connectorRootId")}
        try:
            validated = self._connector_mapping(root)
            request = urllib.request.Request(
                f"{validated['connectorUrl']}/v1/health",
                headers={"Authorization": f"Bearer {validated['connectorToken']}", "Accept": "application/json"},
                method="GET",
            )
            with urllib.request.urlopen(request, timeout=2) as response:
                payload = json.loads(response.read(256 * 1024).decode("utf-8"))
            online = bool(isinstance(payload, dict) and payload.get("ok"))
        except Exception:
            online = False
        with self._lock:
            self._connector_health_cache[cache_key] = (now, online)
        return online

    def _connector_mapping(self, root):
        mapping = next((item for item in self.path_mappings if item["id"] == root.get("mapping_id")), None)
        if not mapping or not mapping.get("connectorUrl") or not mapping.get("connectorToken") or not root.get("_connectorRootId"):
            raise AgentPCError("connector_config_invalid", "Remote connector configuration is incomplete.", 503)
        parsed = urllib.parse.urlparse(mapping["connectorUrl"])
        allow_insecure = str(os.environ.get("VO_AGENT_PC_ALLOW_INSECURE_CONNECTORS") or "").strip().lower() in {"1", "true", "yes", "on"}
        is_loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if parsed.scheme != "https" and not (parsed.scheme == "http" and (allow_insecure or is_loopback)):
            raise AgentPCError("connector_tls_required", "Remote connectors require HTTPS unless insecure connectors are explicitly enabled.", 403)
        return mapping

    def _connector_path(self, root, relative=""):
        rel = safe_relative_path(relative)
        if rel is None:
            raise AgentPCError("invalid_path", "Use a safe path inside the connected folder.")
        base = safe_relative_path(root.get("_remotePath") or "") or ""
        return "/".join(part for part in (base, rel) if part)

    def _connector_open(self, root, endpoint, relative="", *, range_header="", timeout=20):
        mapping = self._connector_mapping(root)
        query = urllib.parse.urlencode({"rootId": root["_connectorRootId"], "path": self._connector_path(root, relative)})
        headers = {"Authorization": f"Bearer {mapping['connectorToken']}", "Accept": "application/json"}
        if range_header:
            headers["Range"] = range_header
        request = urllib.request.Request(f"{mapping['connectorUrl']}/v1/{endpoint}?{query}", headers=headers, method="GET")
        try:
            return urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode("utf-8"))
                message = payload.get("error", {}).get("message") or f"Connector request failed ({exc.code})"
                code = payload.get("error", {}).get("code") or "connector_error"
            except Exception:
                message, code = f"Connector request failed ({exc.code})", "connector_error"
            raise AgentPCError(code, message, exc.code)
        except (OSError, urllib.error.URLError) as exc:
            raise AgentPCError("connector_offline", "The provider computer is offline or unreachable.", 503, reason=str(exc))

    def _connector_json(self, root, endpoint, relative=""):
        with self._connector_open(root, endpoint, relative) as response:
            try:
                payload = json.loads(response.read(2 * 1024 * 1024).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise AgentPCError("connector_response_invalid", "Remote connector returned an invalid response.", 502)
        if not isinstance(payload, dict) or payload.get("ok") is False:
            raise AgentPCError("connector_response_invalid", "Remote connector returned an invalid response.", 502)
        return payload

    def _inside_local_root(self, root, relative, *, require_directory=False):
        rel = safe_relative_path(relative)
        if rel is None:
            raise AgentPCError("invalid_path", "Use a safe path inside the selected root.", 400)
        if sensitive_path(rel):
            raise AgentPCError("sensitive_path", "Hidden and credential-bearing paths are protected.", 403)
        root_real = os.path.realpath(os.path.abspath(root))
        candidate = os.path.realpath(os.path.abspath(os.path.join(root_real, *(rel.split("/") if rel else []))))
        try:
            if os.path.commonpath([root_real, candidate]) != root_real:
                raise AgentPCError("root_escape", "The requested path leaves the selected root.", 403)
        except ValueError:
            raise AgentPCError("root_escape", "The requested path leaves the selected root.", 403)
        if require_directory and not os.path.isdir(candidate):
            raise AgentPCError("folder_not_found", "The folder is not available.", 404)
        return candidate

    def list_tree(self, agent_id, root_id, relative="", *, home_path="", limit=TREE_LIMIT):
        root = self._root(agent_id, root_id, home_path=home_path)
        rel = safe_relative_path(relative)
        if rel is None:
            raise AgentPCError("invalid_path", "Use a safe relative folder path.")
        if root["transport"] == "connector":
            payload = self._connector_json(root, "tree", rel)
            base = safe_relative_path(root.get("_remotePath") or "") or ""
            entries = []
            for raw in (payload.get("entries") or [])[:max(1, min(TREE_LIMIT, int(limit or TREE_LIMIT)))]:
                if not isinstance(raw, dict):
                    continue
                remote_entry_path = str(raw.get("path") or "")
                if base and remote_entry_path.startswith(base + "/"):
                    remote_entry_path = remote_entry_path[len(base) + 1:]
                item = dict(raw)
                item["path"] = remote_entry_path
                entries.append(item)
            return {
                "ok": True, "schemaVersion": SCHEMA_VERSION, "rootId": root_id, "path": rel,
                "entries": entries, "truncated": bool(payload.get("truncated")),
            }
        folder = self._inside_local_root(root["_localPath"], rel, require_directory=True)
        entries = []
        try:
            children = list(os.scandir(folder))
        except OSError as exc:
            raise AgentPCError("folder_unreadable", "The folder could not be read.", 403, reason=str(exc))
        children.sort(key=lambda item: (not item.is_dir(follow_symlinks=False), item.name.casefold()))
        bounded = max(1, min(TREE_LIMIT, int(limit or TREE_LIMIT)))
        for entry in children:
            name = entry.name
            child_rel = "/".join(part for part in (rel, name) if part)
            if sensitive_path(child_rel) or (entry.is_dir(follow_symlinks=False) and name.lower() in NOISY_DIRECTORIES):
                continue
            try:
                real = os.path.realpath(entry.path)
                if os.path.commonpath([os.path.realpath(root["_localPath"]), real]) != os.path.realpath(root["_localPath"]):
                    continue
                is_dir = entry.is_dir(follow_symlinks=True)
                stat = entry.stat(follow_symlinks=True)
            except (OSError, ValueError):
                continue
            extension = os.path.splitext(name)[1].lower()
            previewable = (not is_dir) and extension in EXTENSION_KINDS
            entries.append({
                "name": name, "path": child_rel, "type": "directory" if is_dir else "file",
                "size": 0 if is_dir else int(stat.st_size),
                "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                "previewable": previewable,
                "kind": "directory" if is_dir else (EXTENSION_KINDS.get(extension) or ("file",))[0],
            })
            if len(entries) >= bounded:
                break
        return {"ok": True, "schemaVersion": SCHEMA_VERSION, "rootId": root_id, "path": rel, "entries": entries, "truncated": len(entries) >= bounded}

    def resolve_file(self, agent_id, root_id, relative, *, home_path=""):
        root = self._root(agent_id, root_id, home_path=home_path)
        rel = safe_relative_path(relative, allow_empty=False)
        if rel is None:
            raise AgentPCError("invalid_path", "A safe file path is required.")
        if root["transport"] == "connector":
            payload = self._connector_json(root, "descriptor", rel)
            descriptor = payload.get("preview") if isinstance(payload.get("preview"), dict) else {}
            if not descriptor:
                raise AgentPCError("connector_response_invalid", "Remote connector did not return a file descriptor.", 502)
            descriptor.update({"schemaVersion": SCHEMA_VERSION, "agentId": str(agent_id), "rootId": str(root_id), "path": rel})
            return None, descriptor
        full = self._inside_local_root(root["_localPath"], rel)
        if not os.path.isfile(full):
            raise AgentPCError("file_not_found", "The file is no longer available.", 404)
        extension = os.path.splitext(full)[1].lower()
        kind_info = EXTENSION_KINDS.get(extension)
        if not kind_info:
            raise AgentPCError("unsupported_file", "This file type cannot be previewed.", 415, extension=extension)
        kind, mime_type, language = kind_info
        stat = os.stat(full)
        maximum = MEDIA_MAX_BYTES if kind in {"video", "audio"} else (DOCUMENT_MAX_BYTES if kind in {"image", "pdf"} else TEXT_MAX_BYTES)
        if stat.st_size > maximum:
            raise AgentPCError("file_too_large", "File exceeds the preview size limit.", 413, size=stat.st_size, maxBytes=maximum)
        descriptor = {
            "schemaVersion": SCHEMA_VERSION, "agentId": str(agent_id), "rootId": str(root_id),
            "name": os.path.basename(full), "path": rel, "kind": kind, "mimeType": mime_type,
            "language": language, "size": stat.st_size, "maxBytes": maximum,
            "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "version": hashlib.sha256(f"{stat.st_mtime_ns}:{stat.st_size}".encode()).hexdigest()[:20],
        }
        return full, descriptor

    def open_remote_content(self, agent_id, root_id, relative, *, home_path="", range_header=""):
        root = self._root(agent_id, root_id, home_path=home_path)
        if root["transport"] != "connector":
            raise AgentPCError("not_remote", "The selected root is local.", 409)
        return self._connector_open(root, "content", relative, range_header=range_header, timeout=60)

    def _find_file_root(self, agent_id, path, workdir="", *, home_path=""):
        roots = [item for item in self.roots(agent_id, home_path=home_path) if (item.get("_localPath") or item.get("transport") == "connector") and item.get("online")]
        raw_path = str(path or "").strip()
        raw_workdir = str(workdir or "").strip()
        candidates = []
        # Provider events can report Windows/host paths while the server sees
        # the same files through a Linux container mapping. Resolve against the
        # root's display namespace before considering server-local paths.
        for root in roots:
            display_root = str(root.get("displayPath") or "").strip()
            if not display_root or not raw_path:
                continue
            host_candidate = raw_path
            if not is_windows_absolute(host_candidate) and not os.path.isabs(host_candidate) and raw_workdir:
                host_candidate = ntpath.join(raw_workdir, host_candidate) if is_windows_absolute(raw_workdir) else os.path.join(raw_workdir, host_candidate)
            try:
                if is_windows_absolute(host_candidate) and is_windows_absolute(display_root):
                    if ntpath.commonpath([ntpath.normcase(ntpath.normpath(display_root)), ntpath.normcase(ntpath.normpath(host_candidate))]) != ntpath.normcase(ntpath.normpath(display_root)):
                        continue
                    host_relative = ntpath.relpath(ntpath.normpath(host_candidate), ntpath.normpath(display_root)).replace("\\", "/")
                elif os.path.isabs(host_candidate) and os.path.isabs(display_root) and not is_windows_absolute(display_root):
                    if os.path.commonpath([os.path.abspath(display_root), os.path.abspath(host_candidate)]) != os.path.abspath(display_root):
                        continue
                    host_relative = os.path.relpath(os.path.abspath(host_candidate), os.path.abspath(display_root)).replace(os.sep, "/")
                else:
                    continue
                safe_host_relative = safe_relative_path(host_relative, allow_empty=False)
                if safe_host_relative and not sensitive_path(safe_host_relative):
                    if root.get("transport") == "connector":
                        return root["id"], safe_host_relative, True
                    mapped = os.path.realpath(os.path.join(root["_localPath"], *safe_host_relative.split("/")))
                    return root["id"], safe_host_relative, os.path.isfile(mapped)
            except (OSError, ValueError):
                continue
        if raw_path and not is_windows_absolute(raw_path) and os.path.isabs(raw_path):
            candidates.append(os.path.abspath(os.path.expanduser(raw_path)))
        elif raw_path:
            if raw_workdir and not is_windows_absolute(raw_workdir):
                candidates.append(os.path.abspath(os.path.join(os.path.expanduser(raw_workdir), raw_path)))
            for root in roots:
                if not root.get("_localPath"):
                    continue
                candidates.append(os.path.abspath(os.path.join(root["_localPath"], raw_path)))
        for candidate in candidates:
            candidate_real = os.path.realpath(candidate)
            for root in roots:
                if not root.get("_localPath"):
                    continue
                root_real = os.path.realpath(root["_localPath"])
                try:
                    if os.path.commonpath([root_real, candidate_real]) != root_real:
                        continue
                except ValueError:
                    continue
                relative = os.path.relpath(candidate_real, root_real).replace(os.sep, "/")
                if relative not in (".", "..") and not relative.startswith("../") and not sensitive_path(relative):
                    return root["id"], relative, os.path.isfile(candidate_real)
        return "", "", False

    def record_activity(self, agent_id, payload, *, home_path=""):
        payload = payload if isinstance(payload, dict) else {}
        kind = str(payload.get("kind") or ("url" if payload.get("url") else "file" if payload.get("path") else "")).lower()
        if kind not in {"file", "url", "browser"}:
            raise AgentPCError("invalid_kind", "Activity kind must be file, url, or browser.")
        tool_name = bounded_text(payload.get("toolName") or payload.get("tool") or "", 240)
        operation = classify_operation(tool_name, payload.get("operation"))
        raw_path = bounded_text(payload.get("path") or payload.get("file") or "", 8192).strip()
        url = bounded_text(payload.get("url") or "", 8192).strip()
        root_id = bounded_text(payload.get("rootId") or "", 240).strip()
        relative = safe_relative_path(payload.get("relativePath") or "", allow_empty=False) or ""
        exists = False
        if kind == "url":
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise AgentPCError("invalid_url", "Only HTTP and HTTPS sources are allowed.")
            canonical = f"url:{url}"
            title = str(payload.get("title") or parsed.netloc)[:240]
        elif kind == "browser":
            canonical = "browser"
            title = bounded_text(payload.get("title") or "Live Agent Browser", 240)
        else:
            # Never preserve even the name of a protected credential path in
            # Recent. This also covers unresolved provider/host paths that are
            # outside all currently connected roots.
            if sensitive_path(relative or raw_path):
                raise AgentPCError("sensitive_path", "Hidden and credential-bearing paths are protected.", 403)
            if root_id and relative:
                try:
                    full, _descriptor = self.resolve_file(agent_id, root_id, relative, home_path=home_path)
                    exists = True if full is None else os.path.isfile(full)
                except AgentPCError:
                    exists = False
            else:
                root_id, relative, exists = self._find_file_root(agent_id, raw_path, payload.get("workdir") or payload.get("cwd") or "", home_path=home_path)
            if not raw_path and not relative:
                raise AgentPCError("path_required", "File activity requires a path.")
            canonical = f"file:{root_id}:{relative}" if root_id and relative else f"file:unresolved:{raw_path}"
            title = bounded_text(payload.get("title") or os.path.basename((relative or raw_path).replace("\\", "/")) or "File", 240)
        now = time.time()
        activity_id = f"activity-{hashlib.sha256(f'{agent_id}:{canonical}'.encode()).hexdigest()[:20]}"
        with self._lock, self._db() as db:
            db.execute(
                """INSERT INTO activity(id, agent_id, canonical_key, resource_kind, operation, root_id, relative_path,
                   raw_path, url, title, tool_name, source, session_id, run_id, first_seen, last_seen, touch_count)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
                   ON CONFLICT(agent_id, canonical_key) DO UPDATE SET operation=CASE
                     WHEN activity.operation='output' OR excluded.operation='output' THEN 'output'
                     WHEN activity.operation='source' OR excluded.operation='source' THEN 'source' ELSE 'recent' END,
                     root_id=CASE WHEN excluded.root_id<>'' THEN excluded.root_id ELSE activity.root_id END,
                     relative_path=CASE WHEN excluded.relative_path<>'' THEN excluded.relative_path ELSE activity.relative_path END,
                     raw_path=CASE WHEN excluded.raw_path<>'' THEN excluded.raw_path ELSE activity.raw_path END,
                     title=excluded.title, tool_name=excluded.tool_name, source=excluded.source,
                     session_id=excluded.session_id, run_id=excluded.run_id, last_seen=excluded.last_seen,
                     touch_count=activity.touch_count+1""",
                (activity_id, agent_id, canonical, kind, operation, root_id, relative, raw_path, url, title, tool_name,
                 bounded_text(payload.get("source") or "provider", 240),
                 bounded_text(payload.get("sessionId") or payload.get("sessionKey") or "", 512),
                 bounded_text(payload.get("runId") or "", 512), now, now),
            )
            self._cleanup_activity(db, agent_id, now)
        return {"ok": True, "activityId": activity_id, "operation": operation, "rootId": root_id, "path": relative, "exists": exists}

    def _cleanup_activity(self, db, agent_id, now=None):
        now = now or time.time()
        db.execute("DELETE FROM activity WHERE agent_id=? AND last_seen<?", (agent_id, now - RECENT_MAX_AGE_SEC))
        db.execute(
            """DELETE FROM activity WHERE agent_id=? AND id NOT IN
               (SELECT id FROM activity WHERE agent_id=? ORDER BY last_seen DESC LIMIT ?)""",
            (agent_id, agent_id, self.recent_limit),
        )

    def list_activity(self, agent_id, operation=""):
        requested = str(operation or "").lower()
        query = "SELECT * FROM activity WHERE agent_id=?"
        params = [str(agent_id)]
        if requested in {"source", "output"}:
            query += " AND operation=?"
            params.append(requested)
        query += " ORDER BY last_seen DESC LIMIT ?"
        params.append(self.recent_limit)
        with self._db() as db:
            rows = db.execute(query, params).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["lastSeenAt"] = datetime.fromtimestamp(item.pop("last_seen"), timezone.utc).isoformat()
            item["firstSeenAt"] = datetime.fromtimestamp(item.pop("first_seen"), timezone.utc).isoformat()
            for key in ("agent_id", "canonical_key", "session_id", "run_id", "tool_name", "raw_path", "root_id", "relative_path", "resource_kind", "touch_count"):
                value = item.pop(key)
                camel = {
                    "root_id": "rootId", "relative_path": "path", "resource_kind": "kind", "touch_count": "touchCount",
                    "tool_name": "toolName", "raw_path": "rawPath", "session_id": "sessionId", "run_id": "runId",
                }.get(key)
                if camel:
                    item[camel] = value
            result.append(item)
        return result

    def save_item(self, agent_id, payload, *, home_path=""):
        payload = payload if isinstance(payload, dict) else {}
        kind = str(payload.get("kind") or ("url" if payload.get("url") else "file")).lower()
        saved_id = f"saved-{uuid.uuid4().hex[:16]}"
        now = utc_now()
        root_id = str(payload.get("rootId") or "")
        relative = str(payload.get("path") or "")
        url = str(payload.get("url") or "")
        blob_name = checksum = mime_type = ""
        size = 0
        if kind == "file":
            full, descriptor = self.resolve_file(agent_id, root_id, relative, home_path=home_path)
            size = int(descriptor.get("size") or (os.path.getsize(full) if full else 0))
            if size > SAVE_MAX_BYTES:
                raise AgentPCError("save_too_large", "File exceeds the Saved item size limit.", 413, size=size, maxBytes=SAVE_MAX_BYTES)
            digest = hashlib.sha256()
            temporary_source = os.path.join(self.saved_dir, f"remote-{uuid.uuid4().hex}.tmp") if full is None else ""
            if full is None:
                downloaded = 0
                try:
                    with self.open_remote_content(agent_id, root_id, relative, home_path=home_path) as response, data_owner.open_new(temporary_source, "wb") as output:
                        while True:
                            chunk = response.read(1024 * 1024)
                            if not chunk:
                                break
                            downloaded += len(chunk)
                            if downloaded > SAVE_MAX_BYTES:
                                raise AgentPCError("save_too_large", "Remote file exceeds the Saved item size limit.", 413, maxBytes=SAVE_MAX_BYTES)
                            digest.update(chunk)
                            output.write(chunk)
                    size = downloaded
                    source_for_copy = temporary_source
                except Exception:
                    try:
                        os.remove(temporary_source)
                    except FileNotFoundError:
                        pass
                    raise
            else:
                with open(full, "rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(chunk)
                source_for_copy = full
            checksum = digest.hexdigest()
            extension = os.path.splitext(relative or full or "")[1].lower()
            blob_name = f"{checksum}{extension}"
            destination = os.path.join(self.saved_dir, blob_name)
            if not os.path.exists(destination):
                temporary = f"{destination}.{uuid.uuid4().hex}.tmp"
                shutil.copyfile(source_for_copy, temporary)
                data_owner.adopt(temporary)
                os.replace(temporary, destination)
            if temporary_source:
                try:
                    os.remove(temporary_source)
                except FileNotFoundError:
                    pass
            mime_type = descriptor["mimeType"]
            title = str(payload.get("title") or descriptor["name"])[:240]
        elif kind == "url":
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise AgentPCError("invalid_url", "Only HTTP and HTTPS bookmarks can be saved.")
            title = str(payload.get("title") or parsed.netloc)[:240]
        else:
            raise AgentPCError("invalid_kind", "Saved items must be files or URLs.")
        with self._lock, self._db() as db:
            db.execute(
                """INSERT INTO saved(id, agent_id, resource_kind, title, source_root_id, source_path,
                   source_url, blob_name, checksum, mime_type, size, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (saved_id, agent_id, kind, title, root_id, relative, url, blob_name, checksum, mime_type, size, now),
            )
        return {"ok": True, "savedId": saved_id}

    def list_saved(self, agent_id):
        with self._db() as db:
            rows = db.execute("SELECT * FROM saved WHERE agent_id=? ORDER BY created_at DESC", (str(agent_id),)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            result.append({
                "id": item["id"], "kind": item["resource_kind"], "title": item["title"],
                "rootId": item["source_root_id"], "path": item["source_path"], "url": item["source_url"],
                "mimeType": item["mime_type"], "size": item["size"], "createdAt": item["created_at"],
                "contentAvailable": bool(item["blob_name"]),
            })
        return result

    def resolve_saved(self, agent_id, saved_id):
        with self._db() as db:
            row = db.execute("SELECT * FROM saved WHERE id=? AND agent_id=?", (str(saved_id), str(agent_id))).fetchone()
        if not row:
            raise AgentPCError("saved_not_found", "Saved item was not found.", 404)
        item = dict(row)
        if not item["blob_name"]:
            raise AgentPCError("saved_has_no_content", "This Saved item is a bookmark.", 409)
        full = os.path.join(self.saved_dir, os.path.basename(item["blob_name"]))
        if not os.path.isfile(full):
            raise AgentPCError("saved_content_missing", "Saved content is missing.", 404)
        extension = os.path.splitext(full)[1].lower()
        kind, fallback_mime, language = EXTENSION_KINDS.get(extension, ("file", "application/octet-stream", ""))
        descriptor = {
            "schemaVersion": SCHEMA_VERSION, "agentId": str(agent_id), "savedId": str(saved_id),
            "name": item["title"], "path": item["source_path"], "kind": kind,
            "mimeType": item["mime_type"] or fallback_mime, "language": language, "size": item["size"],
            "version": item["checksum"][:20], "createdAt": item["created_at"],
        }
        return full, descriptor

    def delete_saved(self, agent_id, saved_id):
        with self._lock, self._db() as db:
            row = db.execute("SELECT blob_name FROM saved WHERE id=? AND agent_id=?", (str(saved_id), str(agent_id))).fetchone()
            if not row:
                raise AgentPCError("saved_not_found", "Saved item was not found.", 404)
            blob_name = row["blob_name"]
            db.execute("DELETE FROM saved WHERE id=? AND agent_id=?", (str(saved_id), str(agent_id)))
            references = db.execute("SELECT COUNT(*) AS count FROM saved WHERE blob_name=?", (blob_name,)).fetchone()["count"] if blob_name else 1
        if blob_name and not references:
            try:
                os.remove(os.path.join(self.saved_dir, os.path.basename(blob_name)))
            except FileNotFoundError:
                pass
        return {"ok": True, "deleted": saved_id}

    def get_ui_state(self, agent_id):
        with self._db() as db:
            row = db.execute("SELECT state_json FROM ui_state WHERE agent_id=?", (str(agent_id),)).fetchone()
        if not row:
            return {}
        try:
            value = json.loads(row["state_json"])
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}

    def set_ui_state(self, agent_id, state):
        if not isinstance(state, dict):
            raise AgentPCError("invalid_state", "Agent PC state must be an object.")
        encoded = json.dumps(state, separators=(",", ":"), ensure_ascii=False)
        if len(encoded.encode("utf-8")) > UI_STATE_MAX_BYTES:
            raise AgentPCError("state_too_large", "Agent PC state exceeds the storage limit.", 413)
        with self._lock, self._db() as db:
            db.execute(
                """INSERT INTO ui_state(agent_id, state_json, updated_at) VALUES(?,?,?)
                   ON CONFLICT(agent_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at""",
                (str(agent_id), encoded, utc_now()),
            )
        return {"ok": True}

    def summary(self, agent_id, *, home_path=""):
        profile = self._profile(agent_id)
        if not profile:
            raise AgentPCError("agent_not_found", "Agent PC profile was not found.", 404)
        return {
            "ok": True,
            "schemaVersion": SCHEMA_VERSION,
            "profile": {
                "agentId": profile["agent_id"], "name": profile["display_name"],
                "providerKind": profile["provider_kind"], "providerAgentId": profile["provider_agent_id"],
                "archived": bool(profile["archived_at"]),
            },
            "roots": self.public_roots(agent_id, home_path=home_path),
            "mappings": self.available_mappings(),
            "recent": self.list_activity(agent_id),
            "sources": self.list_activity(agent_id, "source"),
            "outputs": self.list_activity(agent_id, "output"),
            "saved": self.list_saved(agent_id),
            "state": self.get_ui_state(agent_id),
            "capabilities": {
                "browse": True, "preview": True, "save": True, "connectFolder": bool(self.path_mappings),
                "edit": False, "deleteProviderFiles": False,
            },
            "limits": {"recentPerAgent": self.recent_limit, "treeEntries": TREE_LIMIT, "saveMaxBytes": SAVE_MAX_BYTES},
        }
