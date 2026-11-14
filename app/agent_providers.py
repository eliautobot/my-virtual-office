"""Agent Providers: Hermes and OpenClaw connections, their access level and the routes
``/api/agent-providers/*`` (design .work/hermes-port/design.md 2.1, 2.2, 2.6, 2.7).

Records live in ``<data>/agent-providers.json`` (0600, written only here):

    {"version": 1,
     "connections": [{"id", "kind": "hermes", "transport": "serve", "name", "enabled", "access",
                      "url", "auth", "username", "profileAgents": {}, "createdAt", "updatedAt"}],
     "legacy":   {"<legacy hermes connection id>": {"access": "full", "profile": "", "replacedBy": ""}},
     "openclaw": {"access": "full"}}

Secrets of these connections live in ``provider_secrets`` and never reach a page. The
older Hermes API-server rows and OpenClaw's gateway address and token stay in
``vo-config.json`` (other code reads them there); this module reads and writes them
through hooks that ``server.py`` installs with ``configure()``.

Adapters (Hermes link, OpenClaw) register themselves with ``register_adapter(kind, a)``.
Until one does, a stub answers: status "offline", no agents.
"""

import copy
import json
import os
import re
import shutil
import threading
import time
import urllib.parse

import private_files
import provider_hub
import provider_secrets

FILE_NAME = "agent-providers.json"
SECRETS_FILE = provider_secrets.FILE_NAME
AUDIT_FILE = "provider-audit.log"
BACKUP_SUFFIX = ".pre-hp"
VERSION = 1
BODY_MAX_BYTES = 64 * 1024
RUN_BODY_MAX_BYTES = 512 * 1024
ACCESS_LEVELS = ("full", "chat")
PLATFORM_NAMES = {"hermes": "Hermes", "openclaw": "OpenClaw"}


def _owner(platform):
    return platform + ("'" if platform.endswith("s") else "'s")

# ── texts (design 3.6) ───────────────────────────────────────────────────
FIX_FULL_ACCESS = "Open Agent Providers, Edit the connection and choose Full access."
CHAT_ONLY_TEXTS = {
    "settings": "This connection has Chat only access: {owner} settings are not changed from here.",
    "files": "This connection has Chat only access: files on {owner} computer are not changed from here.",
    "screen": ("This connection is set up for chat only: the agent's screen needs Full access "
               "(Agent Providers, then its connection)."),
    "browser": ("This connection is set up for chat only: the agents' browser needs Full access "
                "(Agent Providers, then its connection)."),
    "admin": "This connection has Chat only access: edit the connection to see and change this.",
}
FORBIDDEN_TEXT = "Agents cannot do this through the office API."
REAUTH_TEXT = "Changing the agent platform needs your office passcode: confirm it to continue."


class ProviderError(Exception):
    """An error answered to the page as ``{ok: false, error, message, fix?, field?}``."""

    def __init__(self, code, message, status=400, fix=None, field=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.fix = fix
        self.field = field

    def payload(self):
        out = {"ok": False, "error": self.code, "message": self.message}
        if self.fix:
            out["fix"] = self.fix
        if self.field:
            out["field"] = self.field
        return out


class StoreError(ProviderError):
    def __init__(self, message):
        super().__init__("store_unreadable", message, status=409,
                         fix="Fix or remove the file named in the message, then try again.")


# ── manifests (design 3.3, 3.4, 2.7; MVW S§1.1-1.3) ──────────────────────
def _access_field(platform, what):
    return {
        "key": "access", "label": "Access", "type": "select", "default": "full",
        "options": ["full", "chat"],
        "labels": {"full": "Full access: chat and settings", "chat": "Chat only"},
        "hint": (f"Full access lets {what} be changed from the office (each change is shown to you first). "
                 "Chat only never " + ("changes them" if platform == "hermes" else "asks for that")
                 + "; chat, approvals and questions work the same."),
    }


HERMES_MENU_WRITE = [
    "profiles.create", "model.default", "toolsets.set", "skills.set", "mcp.set", "cron.pause",
    "cron.resume", "cron.run", "cron.remove", "sessions.delete", "config.patch", "env.set",
]
OPENCLAW_MENU_WRITE = [
    "agents.create", "agents.update", "agents.delete", "skills.update", "plugins.setEnabled",
    "cron.update", "cron.run", "cron.remove", "exec.approvals.set", "exec.approval.grants.revoke",
    "sessions.delete", "config.patch",
]

MANIFESTS = {
    "hermes": {
        "id": "hermes", "kind": "hermes", "transport": "serve", "label": "Hermes",
        "description": ("Hermes: connects to `hermes serve`. Every profile becomes an agent, with settings, "
                        "approvals, questions, files and the Bot Desktop."),
        "single": False, "menu": "provider-menu-hermes.js",
        "detect": ["http://127.0.0.1:9119", "http://host.docker.internal:9119"],
        "fields": [
            {"key": "name", "label": "Name", "type": "text", "default": "Hermes", "placeholder": "Hermes",
             "required": True, "maxLength": 60,
             "error": "Give the connection a name of up to 60 characters."},
            {"key": "url", "label": "Hermes address", "type": "url", "default": "http://127.0.0.1:9119",
             "required": True, "schemes": ["http", "https"], "button": "find",
             "hint": ("The address `hermes serve` (or `hermes dashboard`) listens on: http://127.0.0.1:9119 by "
                      "default. From another machine use its address (https:// through a secure proxy)."),
             "error": "The address starts with http:// or https://."},
            {"key": "auth", "label": "Sign in with", "type": "select", "default": "token",
             "options": ["token", "password"],
             "labels": {"token": "Session token", "password": "Username and password"},
             "hint": ("A Hermes bound to its own machine takes a session token; one listening beyond it asks "
                      "for its username and password.")},
            {"key": "token", "label": "Session token", "type": "secret", "showIf": {"auth": "token"},
             "requiredIf": {"auth": "token"},
             "hint": ("Hermes makes a new one every time it starts, unless it is started with a token of your "
                      "own: HERMES_DASHBOARD_SESSION_TOKEN=<token> hermes serve. Enter the same token here."),
             "error": "Enter the session token."},
            {"key": "username", "label": "Username", "type": "text", "showIf": {"auth": "password"},
             "requiredIf": {"auth": "password"}, "maxLength": 128,
             "error": "Enter the username of Hermes' sign-in."},
            {"key": "password", "label": "Password", "type": "secret", "showIf": {"auth": "password"},
             "requiredIf": {"auth": "password"}, "unlessSet": "tokens", "handoff": True,
             "hint": ("Hermes' own sign-in (HERMES_DASHBOARD_BASIC_AUTH_USERNAME and _PASSWORD). It is used "
                      "once, to sign in; the office then keeps the sign-in Hermes issues and forgets the "
                      "password."),
             "handoffPlaceholder": "Not needed: signed in. Type it only to sign in again.",
             "error": "Enter the password."},
            _access_field("hermes", "Hermes' settings, the agent's files and its Bot Desktop"),
            {"key": "tokens", "label": "Sign-in tokens", "type": "secret", "system": True, "perAddress": True},
        ],
        "caps": ["chat", "sessions", "models", "effort", "attachments", "approvals", "stop", "presence",
                 "agents", "tools", "context", "questions", "plan", "observe", "settings", "media", "queue",
                 "tasks", "files", "titles", "computer", "screen", "accessLevel"],
        "computer": {"where": "machine", "ops": ["list", "read", "write", "mkdir", "remove"],
                     "writes": ["write", "mkdir", "remove"]},
        "menuWrite": HERMES_MENU_WRITE,
    },
    "hermes-api": {
        "id": "hermes-api", "kind": "hermes", "transport": "api", "label": "Hermes (legacy API server)",
        "legacy": True,
        "description": "Older API server (legacy): one profile per API server (/v1/runs), chat and approvals only.",
        "single": False,
        "fields": [
            {"key": "name", "label": "Name", "type": "text", "required": True, "maxLength": 60,
             "error": "Give the connection a name of up to 60 characters."},
            {"key": "apiUrl", "label": "API URL", "type": "url", "required": True, "schemes": ["http", "https"],
             "error": "The address starts with http:// or https://."},
            {"key": "apiKey", "label": "API key", "type": "secret"},
            _access_field("hermes", "Hermes' settings, the agent's files and its Bot Desktop"),
            {"key": "profile", "label": "Hermes profile", "type": "text", "maxLength": 128,
             "hint": "Which Hermes profile this API server runs. Used to avoid showing the same agent twice."},
        ],
        "caps": ["chat", "sessions", "approvals", "stop", "attachments", "accessLevel"],
        "menuWrite": [],
    },
    "openclaw": {
        "id": "openclaw", "kind": "openclaw", "transport": "gateway", "label": "OpenClaw",
        "description": "OpenClaw's gateway: its agents, their chats, approvals, automations and browser.",
        "single": True, "menu": "provider-menu-openclaw.js",
        "fields": [
            {"key": "url", "label": "Gateway address", "type": "url", "default": "ws://127.0.0.1:18789",
             "required": True, "schemes": ["ws", "wss"],
             "hint": ("OpenClaw's gateway listens on ws://127.0.0.1:18789 by default. From another machine use "
                      "its address (wss:// through a secure proxy)."),
             "error": "The address starts with ws:// or wss://."},
            {"key": "token", "label": "Gateway token", "type": "secret",
             "hint": ("On the gateway's machine: openclaw config get gateway.auth.token. The office keeps it on "
                      "its server and never shows it to the browser."),
             "fromOpenClawPlaceholder": "Read from OpenClaw's own settings"},
            _access_field("openclaw", "OpenClaw's settings, agents, automations and the agents' browser"),
        ],
        "caps": ["chat", "sessions", "models", "effort", "attachments", "approvals", "stop", "taskProgress",
                 "presence", "agents", "tools", "context", "questions", "plan", "observe", "settings", "media",
                 "queue", "tasks", "browser", "files", "computer", "progressCard", "accessLevel"],
        "computer": {"where": "workspace", "docs": True, "ops": ["list", "read", "docs", "doc", "docSet"],
                     "writes": ["docSet"]},
        "menuWrite": OPENCLAW_MENU_WRITE,
    },
}


def manifest_id(kind, transport):
    if kind == "hermes":
        return "hermes-api" if transport == "api" else "hermes"
    return "openclaw" if kind == "openclaw" else ""


def public_manifests():
    return copy.deepcopy(MANIFESTS)


# ── small helpers ────────────────────────────────────────────────────────
def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def slug(value, fallback=""):
    text = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return text[:40].strip("-") or fallback


def _atomic_write_json(path, data):
    # private, keeps the owner (Docker runs as root; v0.10.1 upgrade fix)
    private_files.write_private(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def chmod_private(path):
    """Make a file private: 0600, or 0640 when it was group-readable; its owner and group stay
    (private_files.tighten). True when it is private now."""
    return private_files.tighten(path)


def normalize_url(value, schemes):
    text = str(value or "").strip()
    try:
        parts = urllib.parse.urlsplit(text)
    except ValueError:
        return ""
    if parts.scheme.lower() not in schemes or not parts.hostname or parts.username or parts.password:
        return ""
    if any(ch.isspace() for ch in text):
        return ""
    path = parts.path.rstrip("/")
    return urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc, path, parts.query, ""))


# ── the store ────────────────────────────────────────────────────────────
def _empty():
    return {"version": VERSION, "connections": [], "legacy": {}, "openclaw": {}}


class ConnectionStore:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()

    def load(self):
        with self.lock:
            try:
                with open(self.path, "r", encoding="utf-8") as handle:
                    raw = handle.read()
            except FileNotFoundError:
                return _empty()
            except OSError as exc:
                raise StoreError(f"{FILE_NAME} cannot be read: {exc}")
            try:
                data = json.loads(raw)
            except ValueError:
                data = None
            if not isinstance(data, dict):
                raise StoreError(f"{FILE_NAME} is damaged; it was left as it is.")
            data.setdefault("version", VERSION)
            if not isinstance(data.get("connections"), list):
                data["connections"] = []
            if not isinstance(data.get("legacy"), dict):
                data["legacy"] = {}
            if not isinstance(data.get("openclaw"), dict):
                data["openclaw"] = {}
            data["connections"] = [c for c in data["connections"] if isinstance(c, dict) and c.get("id")]
            return data

    def save(self, data):
        with self.lock:
            _atomic_write_json(self.path, data)

    def update(self, fn):
        """Read, let ``fn(data)`` change it and return a result, write it back (one lock)."""
        with self.lock:
            data = self.load()
            before = json.dumps(data, sort_keys=True)
            result = fn(data)
            if json.dumps(data, sort_keys=True) != before:
                self.save(data)
            return result


# ── module state ─────────────────────────────────────────────────────────
class _State:
    data_dir = None
    store = None
    secrets = None
    access_store = None
    hooks = {}


STATE = _State()


def configure(data_dir, access_store=None, **hooks):
    """Point the module at the office's data folder and install the server hooks:

    ``read_vo_config()`` -> dict (fresh read of vo-config.json),
    ``update_vo_config(fn)`` -> result (locked read-modify-write; ``fn(root)`` changes ``root``),
    ``after_vo_config_change()`` (reload the runtime), ``legacy_status(row)`` -> status,
    ``openclaw_info()`` -> ``{url, tokenSet, tokenSource, status, agents}``,
    ``legacy_agents()`` -> ``{legacyConnectionId: [agent rows]}``,
    ``legacy_model_ids(rows)`` -> ``{legacyConnectionId: first /v1/models id}`` (cached, never blocks).
    """
    STATE.data_dir = data_dir
    STATE.store = ConnectionStore(os.path.join(data_dir, FILE_NAME))
    STATE.secrets = provider_secrets.SecretStore(os.path.join(data_dir, SECRETS_FILE))
    STATE.access_store = access_store
    STATE.hooks = dict(hooks)
    return STATE


def _store():
    if STATE.store is None:
        raise ProviderError("not_configured", "Agent Providers is not set up on this server.", status=503)
    return STATE.store


def _hook(name, *args, default=None):
    fn = STATE.hooks.get(name)
    if not callable(fn):
        return copy.deepcopy(default)
    return fn(*args)


def load():
    return _store().load()


def _read_vo_config():
    root = _hook("read_vo_config", default={})
    return root if isinstance(root, dict) else {}


def _legacy_rows(vo_config=None):
    root = vo_config if isinstance(vo_config, dict) else _read_vo_config()
    hermes = root.get("hermes") if isinstance(root.get("hermes"), dict) else {}
    rows = hermes.get("connections") if isinstance(hermes.get("connections"), list) else []
    return [row for row in rows if isinstance(row, dict) and str(row.get("id") or "").strip()]


# ── migration (design 2.2) ───────────────────────────────────────────────
def migrate(data_dir, vo_config_path):
    """Boot migration. Idempotent and never deletes anything:
    back up vo-config.json once to ``vo-config.json.pre-hp`` (private, same owner), add
    ``legacy[<id>] = {access: "full"}`` for each API-server Hermes row, set ``openclaw.access``
    to "full" if missing, make vo-config.json (and its .bak) private: 0600, or 0640 when its group
    could read it; the owner stays (private_files). Returns a short report."""
    report = {"backup": "", "legacyAdded": [], "openclawAccess": "", "chmod": [], "errors": []}
    store = ConnectionStore(os.path.join(data_dir, FILE_NAME))
    vo_root = {}
    if vo_config_path and os.path.isfile(vo_config_path):
        backup = vo_config_path + BACKUP_SUFFIX
        if not os.path.exists(backup):
            try:
                tmp = backup + f".tmp-{os.getpid()}"
                os.close(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600))  # private before the copy
                shutil.copyfile(vo_config_path, tmp)
                private_files.keep_owner(vo_config_path, tmp)
                os.chmod(tmp, private_files.private_mode(vo_config_path))
                os.replace(tmp, backup)
                report["backup"] = backup
            except OSError as exc:
                report["errors"].append(f"backup: {exc}")
        try:
            with open(vo_config_path, "r", encoding="utf-8") as handle:
                vo_root = json.load(handle)
        except (OSError, ValueError) as exc:
            report["errors"].append(f"read vo-config.json: {exc}")
            vo_root = {}
    rows = _legacy_rows(vo_root if isinstance(vo_root, dict) else {})

    def _apply(data):
        for row in rows:
            cid = str(row.get("id")).strip()
            entry = data["legacy"].get(cid)
            if not isinstance(entry, dict):
                data["legacy"][cid] = {"access": "full"}
                report["legacyAdded"].append(cid)
            elif entry.get("access") not in ACCESS_LEVELS:
                entry["access"] = "full"
        if data["openclaw"].get("access") not in ACCESS_LEVELS:
            data["openclaw"]["access"] = "full"
            report["openclawAccess"] = "full"
        data["version"] = VERSION

    try:
        if os.path.isdir(data_dir):
            store.update(_apply)
    except ProviderError as exc:
        report["errors"].append(exc.message)
    except OSError as exc:
        report["errors"].append(f"{FILE_NAME}: {exc}")
    for path in (vo_config_path, (vo_config_path or "") + ".bak", (vo_config_path or "") + BACKUP_SUFFIX,
                 store.path, os.path.join(data_dir, SECRETS_FILE)):
        if path and os.path.isfile(path) and chmod_private(path):
            report["chmod"].append(os.path.basename(path))
    return report


# ── adapters ─────────────────────────────────────────────────────────────
class StubAdapter:
    """Stands in until the real adapter of a kind registers: offline, no agents."""

    def __init__(self, kind):
        self.kind = kind

    def status(self, cid):
        name = PLATFORM_NAMES.get(self.kind, self.kind)
        return {"state": "offline", "code": "not_started",
                "detail": f"The {name} connection is not running yet.",
                "fix": "It starts by itself once the office has the connection code for it.", "version": ""}

    def agents(self, cid):
        return []

    def close(self, cid, reason=""):
        return None


_ADAPTERS = {}
_ADAPTERS_LOCK = threading.Lock()


def register_adapter(kind, adapter):
    """Install the adapter of a kind; its ``on_event`` stream (if any) feeds the ChatHub."""
    with _ADAPTERS_LOCK:
        _ADAPTERS[str(kind)] = adapter
    _listen(str(kind), adapter)


def adapter(kind):
    with _ADAPTERS_LOCK:
        return _ADAPTERS.get(str(kind)) or StubAdapter(str(kind))


def _call(obj, name, *args, default=None):
    fn = getattr(obj, name, None)
    if not callable(fn):
        return copy.deepcopy(default)
    try:
        return fn(*args)
    except ProviderError:
        raise
    except Exception as exc:  # an adapter fault must not break the page
        return {"state": "error", "code": "adapter_error", "detail": str(exc)[:300], "fix": ""} \
            if name == "status" else copy.deepcopy(default)


def find_connection(cid, data=None):
    data = data if data is not None else load()
    for conn in data["connections"]:
        if conn.get("id") == cid:
            return conn
    return None


def adapter_for_agent(agent_id):
    """``(adapter, connection, profile)`` for an agent of a full Hermes connection, else None.
    (OpenClaw and legacy agents keep their existing paths until the chat routes land.)"""
    agent_id = str(agent_id or "")
    if not agent_id or STATE.store is None:
        return None
    for conn in load()["connections"]:
        for profile, mapped in (conn.get("profileAgents") or {}).items():
            if mapped == agent_id:
                return adapter(conn.get("kind") or "hermes"), conn, profile
    return None


# ── access level and gates (design 2.6 M/F/R, 2.7) ───────────────────────
def connection_access(kind, cid=None):
    """'full' or 'chat'. Unknown connections count as 'chat' (fail closed), except
    OpenClaw and legacy rows from before the migration, which were always full."""
    if STATE.store is None:
        return "full"
    data = load()
    if kind == "openclaw":
        value = data["openclaw"].get("access")
        return value if value in ACCESS_LEVELS else "full"
    conn = find_connection(cid, data) if cid else None
    if conn:
        return conn.get("access") if conn.get("access") in ACCESS_LEVELS else "chat"
    entry = data["legacy"].get(str(cid or ""))
    if isinstance(entry, dict):
        return entry.get("access") if entry.get("access") in ACCESS_LEVELS else "full"
    return "chat"


def require_manage(access):
    """M: a browser session or this machine; an agent token never."""
    if access is None:
        raise ProviderError("forbidden", FORBIDDEN_TEXT, status=403)
    if getattr(access, "via_token", False) or not getattr(access, "can_manage", False):
        raise ProviderError("forbidden", FORBIDDEN_TEXT, status=403)
    return True


def require_full(kind, cid=None, area="settings"):
    """F: the connection has Full access, else 403 ``chat_only`` with the 3.6 text."""
    if connection_access(kind, cid) == "full":
        return True
    text = chat_only_reason(kind, area)
    raise ProviderError("chat_only", text, status=403, fix=FIX_FULL_ACCESS)


def chat_only_reason(kind, area):
    platform = PLATFORM_NAMES.get(kind, str(kind))
    return CHAT_ONLY_TEXTS.get(area, CHAT_ONLY_TEXTS["settings"]).format(owner=_owner(platform))


def is_serve_row(row):
    """True for a Hermes row that belongs to Agent Providers (a `hermes serve` connection): the old
    settings writers (vo-config ``hermes.connections``) must never take one in (design 5.2 C3)."""
    if not isinstance(row, dict):
        return False
    marks = {str(row.get(k) or "").strip().lower() for k in ("transport", "mode", "connectionMode", "manifest")}
    if marks & {"serve", "hermes-serve", "hermes"}:
        return True
    if not row.get("apiUrl") and row.get("url") and (row.get("auth") or row.get("profileAgents")):
        return True
    if STATE.store is None:
        return False
    rid = str(row.get("id") or "").strip()
    try:
        return bool(rid) and any(str(conn.get("id")) == rid for conn in load()["connections"])
    except ProviderError:
        return False


def legacy_access(cid):
    """A legacy (API server) Hermes row's level: 'chat' only when its entry says so; a row the
    migration has not seen yet keeps working as before the port (full)."""
    if STATE.store is None or not cid:
        return "full"
    try:
        entry = load()["legacy"].get(str(cid))
    except ProviderError:
        return "full"
    return "chat" if isinstance(entry, dict) and entry.get("access") == "chat" else "full"


def agent_access(kind, cid):
    """The level of the connection an office agent lives on (serve, legacy or OpenClaw)."""
    if kind == "openclaw":
        return connection_access("openclaw")
    if STATE.store is None or not cid:
        return "full"
    try:
        if find_connection(cid):
            return connection_access(kind, cid)
    except ProviderError:
        return "full"
    return legacy_access(cid)



def require_recent(access, access_store=None):
    """R: when the office passcode is on and the caller is not this machine, the
    passcode must have been confirmed in this browser session in the last 10 minutes."""
    store = access_store or STATE.access_store
    if access is None or not getattr(access, "protected", False) or getattr(access, "via_loopback", False):
        return True
    token = getattr(access, "session_token", "") or ""
    if store is not None and getattr(access, "via_session", False) and store.recently_confirmed(token):
        return True
    raise ProviderError("reauth_required", REAUTH_TEXT, status=403)


def audit(connection, kind, method):
    """One line per settings write, never the parameters."""
    if not STATE.data_dir:
        return
    path = os.path.join(STATE.data_dir, AUDIT_FILE)
    line = json.dumps({"at": _now_iso(), "connection": str(connection), "kind": str(kind),
                       "method": str(method)}) + "\n"
    before = private_files.snapshot(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    private_files.adopt(fd, path, before)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        handle.write(line)


# ── listing ──────────────────────────────────────────────────────────────
def _serve_row(conn, data, vo_root=None):
    kind = conn.get("kind") or "hermes"
    cid = conn["id"]
    status = _conn_status(conn)
    try:
        _rows, agents = _serve_view(conn, data, vo_root if vo_root is not None else _read_vo_config(), status)
    except Exception:
        agents = [{"id": agent_id, "name": profile, "emoji": "", "nativeId": profile, "hidden": False, "reason": ""}
                  for profile, agent_id in (conn.get("profileAgents") or {}).items()]
    auth = conn.get("auth") if conn.get("auth") in ("token", "password") else "token"
    return {
        "id": cid, "kind": kind, "transport": "serve", "manifest": manifest_id(kind, "serve"),
        "name": conn.get("name") or "Hermes", "enabled": conn.get("enabled") is not False,
        "access": conn.get("access") if conn.get("access") in ACCESS_LEVELS else "chat",
        "status": status, "signsIn": auth == "password",
        "fields": {"name": conn.get("name") or "", "url": conn.get("url") or "", "auth": auth,
                   "username": conn.get("username") or "",
                   "access": conn.get("access") if conn.get("access") in ACCESS_LEVELS else "chat"},
        "secrets": STATE.secrets.flags(kind, cid) if STATE.secrets else {},
        "agents": agents,
        "createdAt": conn.get("createdAt") or "", "updatedAt": conn.get("updatedAt") or "",
    }


def _legacy_row(row, data, legacy_agents):
    cid = str(row.get("id")).strip()
    entry = data["legacy"].get(cid) if isinstance(data["legacy"].get(cid), dict) else {}
    access = entry.get("access") if entry.get("access") in ACCESS_LEVELS else "full"
    enabled = row.get("enabled") is not False
    if not enabled:
        status = {"state": "offline", "code": "switched_off", "detail": "Switched off.",
                  "fix": "Switch it on to connect.", "version": ""}
    else:
        status = _hook("legacy_status", row, default=None) or {
            "state": "connecting", "code": "checking", "detail": "Checking the API server...", "fix": "",
            "version": ""}
    model = str(status.get("modelId") or "") or _seen_legacy_model(row, entry)
    status = {k: v for k, v in status.items() if k != "modelId"}
    agents = []
    for item in (legacy_agents or {}).get(cid) or [{"id": f"hermes-{cid}", "name": row.get("name") or cid,
                                                     "emoji": row.get("emoji") or ""}]:
        agents.append({"id": item.get("id"), "name": item.get("name") or "", "emoji": item.get("emoji") or "",
                       "nativeId": entry.get("profile") or "",
                       "hidden": bool(entry.get("replacedBy")),
                       "reason": "Switched to the full Hermes connection." if entry.get("replacedBy") else ""})
    return {
        "id": cid, "kind": "hermes", "transport": "api", "manifest": "hermes-api",
        "name": row.get("name") or cid, "enabled": enabled, "access": access, "status": status,
        "signsIn": False,
        "fields": {"name": row.get("name") or "", "apiUrl": row.get("apiUrl") or row.get("url") or "",
                   "access": access, "profile": entry.get("profile") or ""},
        "secrets": {"apiKey": True} if str(row.get("apiKey") or "").strip() else {},
        "agents": agents,
        "legacy": {"profile": entry.get("profile") or "", "replacedBy": entry.get("replacedBy") or "",
                   "guess": "default" if model == "hermes-agent" else model},
    }


def _openclaw_row(data):
    info = _hook("openclaw_info", default={}) or {}
    access = data["openclaw"].get("access") if data["openclaw"].get("access") in ACCESS_LEVELS else "full"
    status = info.get("status") if isinstance(info.get("status"), dict) else None
    if status is None:
        status = _call(adapter("openclaw"), "status", "openclaw", default=None) \
            or StubAdapter("openclaw").status("openclaw")
    agents = []
    for item in info.get("agents") or []:
        if isinstance(item, dict) and item.get("id"):
            agents.append({"id": item.get("id"), "name": item.get("name") or item.get("id"),
                           "emoji": item.get("emoji") or "", "nativeId": item.get("nativeId") or item.get("id"),
                           "hidden": bool(item.get("hidden")), "reason": item.get("reason") or ""})
    return {
        "id": "openclaw", "kind": "openclaw", "transport": "gateway", "manifest": "openclaw",
        "name": "OpenClaw", "enabled": True, "access": access, "status": status, "signsIn": False,
        "fields": {"url": info.get("url") or "", "access": access},
        "secrets": {"token": True} if info.get("tokenSet") else {},
        "tokenSource": info.get("tokenSource") or "",
        "agents": agents,
        "device": info.get("device") if isinstance(info.get("device"), dict) else {"state": "off"},
    }


def list_providers():
    data = load()
    vo_root = _read_vo_config()
    providers = [_serve_row(conn, data, vo_root) for conn in data["connections"]]
    legacy_agents = _hook("legacy_agents", default={}) or {}
    providers.extend(_legacy_row(row, data, legacy_agents) for row in _legacy_rows(vo_root))
    providers.append(_openclaw_row(data))
    return {"ok": True, "providers": providers, "manifests": public_manifests()}


# ── save / enable / remove ───────────────────────────────────────────────
def _invalid(field, message):
    return ProviderError("invalid", message, status=400, field=field)


def _field(manifest, key):
    for item in manifest["fields"]:
        if item["key"] == key:
            return item
    return {}


def _text(values, key, manifest, existing=""):
    if key not in values:
        return existing
    value = values.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise _invalid(key, _field(manifest, key).get("error") or f"{key} must be text.")
    value = value.strip()
    limit = _field(manifest, key).get("maxLength")
    if limit and len(value) > limit:
        raise _invalid(key, _field(manifest, key).get("error") or f"{key} is too long.")
    return value


def _secret_value(values, key):
    """A typed secret, or None to keep what is stored (blank = keep)."""
    value = values.get(key)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise _invalid(key, f"{key} must be text.")
    value = value.strip()
    if not value or len(value) > 8192 or any(ch in value for ch in "\r\n\x00"):
        raise _invalid(key, f"{key} is not a valid value.")
    return value


def _access_value(values, existing):
    value = values.get("access", existing)
    if value not in ACCESS_LEVELS:
        raise _invalid("access", "Choose Full access or Chat only.")
    return value


def _taken_ids(data, vo_root):
    ids = {c.get("id") for c in data["connections"]}
    ids.update(str(row.get("id")).strip() for row in _legacy_rows(vo_root))
    ids.add("openclaw")
    return ids


def _new_serve_id(name, data, vo_root):
    base = slug(name, "main")
    if base.startswith("hermes-"):
        base = base[len("hermes-"):] or "main"
    if base == "hermes":
        base = "main"
    taken = _taken_ids(data, vo_root)
    cid, n = base, 2
    while cid in taken:
        cid, n = f"{base}-{n}", n + 1
    return cid


def _save_serve(cid, values):
    manifest = MANIFESTS["hermes"]
    vo_root = _read_vo_config()
    secrets = STATE.secrets
    changes = {}

    def _apply(data):
        conn = find_connection(cid, data) if cid else None
        if cid and conn is None:
            raise ProviderError("not_found", "That connection does not exist any more.", status=404)
        before = dict(conn or {})
        name = _text(values, "name", manifest, before.get("name", "Hermes") if conn else "Hermes")
        if not name:
            raise _invalid("name", _field(manifest, "name")["error"])
        url_raw = values.get("url", before.get("url") or _field(manifest, "url")["default"])
        url = normalize_url(url_raw, ("http", "https"))
        if not url:
            raise _invalid("url", _field(manifest, "url")["error"])
        auth = values.get("auth", before.get("auth") or "token")
        if auth not in ("token", "password"):
            raise _invalid("auth", "Choose Session token or Username and password.")
        username = _text(values, "username", manifest, before.get("username", ""))
        access = _access_value(values, before.get("access") or "full")
        new_id = conn["id"] if conn else _new_serve_id(name, data, vo_root)
        token = _secret_value(values, "token")
        password = _secret_value(values, "password")
        flags = secrets.flags("hermes", new_id) if conn else {}
        same_address = conn is not None and before.get("url") == url and before.get("auth") == auth \
            and (auth != "password" or before.get("username") == username)
        if auth == "token" and not token and not flags.get("token"):
            raise _invalid("token", _field(manifest, "token")["error"])
        if auth == "password":
            if not username:
                raise _invalid("username", _field(manifest, "username")["error"])
            signed_in = bool(flags.get("tokens")) and same_address
            if not password and not flags.get("password") and not signed_in:
                raise _invalid("password", _field(manifest, "password")["error"])
        now = _now_iso()
        record = conn if conn is not None else {"id": new_id, "kind": "hermes", "transport": "serve",
                                                 "enabled": True, "profileAgents": {}, "createdAt": now}
        record.update({"name": name, "url": url, "auth": auth, "username": username if auth == "password" else "",
                       "access": access, "updatedAt": now})
        if conn is None:
            data["connections"].append(record)
        changes.update({"id": new_id, "token": token, "password": password, "auth": auth,
                        "drop_tokens": not same_address, "created": conn is None,
                        "settings_changed": conn is None or any(before.get(k) != record.get(k)
                                                                for k in ("url", "auth", "username", "access"))})
        return new_id

    new_id = _store().update(_apply)
    # Secrets after the record: a failed record write never leaves a stray secret.
    if changes["drop_tokens"]:
        secrets.delete("hermes", new_id, "tokens")
    if changes["auth"] == "token":
        secrets.delete("hermes", new_id, "password")
        secrets.delete("hermes", new_id, "tokens")
        if changes["token"]:
            secrets.set("hermes", new_id, "token", changes["token"])
    else:
        secrets.delete("hermes", new_id, "token")
        if changes["password"]:
            secrets.set("hermes", new_id, "password", changes["password"])
    if not changes["created"] and (changes["settings_changed"] or changes["token"] or changes["password"]):
        _close_connection("hermes", new_id, "The connection settings changed")
    _call(adapter("hermes"), "reload", new_id)
    return new_id


def _save_legacy(cid, values):
    manifest = MANIFESTS["hermes-api"]
    if not cid:
        raise ProviderError("unsupported", "New connections use the full Hermes connection.", status=400,
                            fix="Choose Hermes as the connection type.")
    updates = {}

    def _apply_vo(root):
        hermes = root.setdefault("hermes", {}) if isinstance(root.get("hermes"), dict) else None
        if hermes is None:
            root["hermes"] = hermes = {}
        rows = hermes.get("connections") if isinstance(hermes.get("connections"), list) else []
        row = next((r for r in rows if isinstance(r, dict) and str(r.get("id") or "").strip() == cid), None)
        if row is None:
            raise ProviderError("not_found", "That connection does not exist any more.", status=404)
        if "name" in values:
            name = _text(values, "name", manifest)
            if not name:
                raise _invalid("name", _field(manifest, "name")["error"])
            row["name"] = name
        if "apiUrl" in values:
            url = normalize_url(values.get("apiUrl"), ("http", "https"))
            if not url:
                raise _invalid("apiUrl", _field(manifest, "apiUrl")["error"])
            if url != normalize_url(row.get("apiUrl") or row.get("url"), ("http", "https")) \
                    and _secret_value(values, "apiKey") is None:
                # The key is bound to its address: a new address needs the key typed again.
                if str(row.get("apiKey") or "").strip():
                    raise _invalid("apiKey", "Enter the API key again for the new address.")
            row["apiUrl"] = url
        key = _secret_value(values, "apiKey")
        if key is not None:
            row["apiKey"] = key
        updates["changed"] = True
        return True

    access = values.get("access")
    if access is not None and access not in ACCESS_LEVELS:
        raise _invalid("access", "Choose Full access or Chat only.")
    profile = _text(values, "profile", manifest, None) if "profile" in values else None
    if any(k in values for k in ("name", "apiUrl", "apiKey")):
        if not callable(STATE.hooks.get("update_vo_config")):
            raise ProviderError("not_configured", "Saving is not available on this server.", status=503)
        STATE.hooks["update_vo_config"](_apply_vo)
    elif not any(str(r.get("id")).strip() == cid for r in _legacy_rows()):
        raise ProviderError("not_found", "That connection does not exist any more.", status=404)

    def _apply(data):
        entry = data["legacy"].setdefault(cid, {"access": "full"})
        if access is not None:
            entry["access"] = access
        if profile is not None:
            entry["profile"] = profile
    _store().update(_apply)
    if updates.get("changed"):
        _hook("after_vo_config_change")
    return cid


def _save_openclaw(values):
    manifest = MANIFESTS["openclaw"]
    access = values.get("access")
    if access is not None and access not in ACCESS_LEVELS:
        raise _invalid("access", "Choose Full access or Chat only.")
    url = None
    if "url" in values:
        url = normalize_url(values.get("url"), ("ws", "wss"))
        if not url:
            raise _invalid("url", _field(manifest, "url")["error"])
    token = _secret_value(values, "token")
    if url is not None or token is not None:
        if not callable(STATE.hooks.get("update_vo_config")):
            raise ProviderError("not_configured", "Saving is not available on this server.", status=503)

        def _apply_vo(root):
            oc = root.get("openclaw") if isinstance(root.get("openclaw"), dict) else {}
            root["openclaw"] = oc
            if url is not None and url != oc.get("gatewayUrl"):
                oc["gatewayUrl"] = url
                http = "http" + url[2:] if url.startswith("ws") else url
                oc["gatewayHttp"] = http
            if token is not None:
                oc["gatewayToken"] = token
        STATE.hooks["update_vo_config"](_apply_vo)
    changed_access = {}

    def _apply(data):
        if access is not None and data["openclaw"].get("access") != access:
            data["openclaw"]["access"] = access
            changed_access["yes"] = True
    _store().update(_apply)
    if url is not None or token is not None or changed_access:
        _hook("after_vo_config_change")
    return "openclaw"


def save(body):
    if not isinstance(body, dict):
        raise ProviderError("invalid", "The request body must be a JSON object.", status=400)
    kind = str(body.get("kind") or "").strip()
    transport = str(body.get("transport") or "").strip()
    cid = str(body.get("id") or "").strip()
    values = body.get("values") if isinstance(body.get("values"), dict) else {}
    if "name" in body and "name" not in values:
        values = dict(values, name=body.get("name"))
    if kind == "openclaw":
        new_id = _save_openclaw(values)
    elif kind == "hermes" and transport in ("", "serve"):
        if cid and find_connection(cid) is None and any(str(r.get("id")).strip() == cid for r in _legacy_rows()):
            new_id = _save_legacy(cid, values)
        else:
            new_id = _save_serve(cid, values)
    elif kind == "hermes" and transport == "api":
        new_id = _save_legacy(cid, values)
    else:
        raise ProviderError("invalid", "Unknown connection type.", status=400, field="kind")
    row = next((p for p in list_providers()["providers"] if p["id"] == new_id
                and (p["kind"] == kind or kind == "")), None)
    return {"ok": True, "id": new_id, "status": (row or {}).get("status") or {}}


def enable(body):
    cid = str((body or {}).get("id") or "").strip()
    on = bool((body or {}).get("on", True))
    if not cid:
        raise _invalid("id", "Which connection?")
    if cid == "openclaw":
        raise ProviderError("unsupported", "OpenClaw's connection cannot be switched off here.", status=400)

    def _apply(data):
        conn = find_connection(cid, data)
        if conn is None:
            return False
        conn["enabled"] = on
        conn["updatedAt"] = _now_iso()
        return True
    if _store().update(_apply):
        if not on:
            _close_connection("hermes", cid, "The connection was switched off")
        _call(adapter("hermes"), "reload", cid)
    else:
        if not callable(STATE.hooks.get("update_vo_config")):
            raise ProviderError("not_found", "That connection does not exist any more.", status=404)

        def _apply_vo(root):
            rows = ((root.get("hermes") or {}).get("connections") or []) if isinstance(root.get("hermes"), dict) else []
            row = next((r for r in rows if isinstance(r, dict) and str(r.get("id") or "").strip() == cid), None)
            if row is None:
                raise ProviderError("not_found", "That connection does not exist any more.", status=404)
            row["enabled"] = on
        STATE.hooks["update_vo_config"](_apply_vo)
        _hook("after_vo_config_change")
    row = next((p for p in list_providers()["providers"] if p["id"] == cid), None)
    return {"ok": True, "status": (row or {}).get("status") or {}}


def remove(body):
    """Forget a full Hermes connection and its secrets; its agents leave the office,
    their chats stay on disk. (API-server rows are removed in the office settings.)"""
    cid = str((body or {}).get("id") or "").strip()
    if not cid or cid == "openclaw":
        raise ProviderError("unsupported", "This connection cannot be removed here.", status=400)
    removed = {}

    def _apply(data):
        conn = find_connection(cid, data)
        if conn is None:
            return False
        data["connections"] = [c for c in data["connections"] if c.get("id") != cid]
        for entry in data["legacy"].values():
            if isinstance(entry, dict) and entry.get("replacedBy") == cid:
                entry.pop("replacedBy", None)
        removed["kind"] = conn.get("kind") or "hermes"
        return True
    if not _store().update(_apply):
        raise ProviderError("not_found", "That connection does not exist any more.", status=404)
    _close_connection(removed["kind"], cid, "The connection was removed")
    STATE.secrets.delete(removed["kind"], cid)
    _forget_agents_cache(cid)
    return {"ok": True, "agents": []}


# ── adapter events -> ChatHub (design 2.5) ───────────────────────────────
CHAT_EVENT_TYPES = frozenset({
    "run.start", "run.status", "run.delta", "tool.start", "tool.update", "tool.end", "approval.requested",
    "approval.resolved", "question.requested", "question.resolved", "plan.update", "plan.changed",
    "usage.update", "run.end", "native", "session.card",
})
AGENT_EVENT_TYPES = frozenset({"agent.activity", "session.task"})
_LISTENER_OFF = {}


def _norm_session(kind, native, session):
    session = str(session or "").strip()[:400]
    if kind == "openclaw" and session:
        try:
            import openclaw_adapter
            return openclaw_adapter.norm_session_key(session, native)
        except Exception:
            return session
    return session


def office_id_for(cid, native):
    """The office agent id of a provider agent (serve: profileAgents; OpenClaw: its own id)."""
    if cid == "openclaw" or STATE.store is None:
        return str(native or "")
    conn = find_connection(cid)
    return str(((conn or {}).get("profileAgents") or {}).get(str(native or "")) or "")


def publish_event(kind, event):
    """Route one adapter event to its hub key. Adapters emit dicts with ``type`` plus
    ``connectionId``, ``agentId`` (native id), ``sessionKey`` and ``runId`` where they apply;
    media items with a provider-side ``ref``/``path`` get a signed office link."""
    if not isinstance(event, dict):
        return None
    etype = str(event.get("type") or "")
    cid = str(event.get("connectionId") or ("openclaw" if kind == "openclaw" else ""))
    native = str(event.get("agentId") or event.get("profile") or "")
    if not cid:
        return None
    if etype == "provider.status" or not native:
        return provider_hub.HUB.publish(provider_hub.connection_key(cid), event) \
            if etype == "provider.status" else None
    session = _norm_session(kind, native, event.get("sessionKey"))
    if etype in AGENT_EVENT_TYPES or not session or etype not in CHAT_EVENT_TYPES:
        return provider_hub.HUB.publish(provider_hub.agent_key(cid, native), event)
    if isinstance(event.get("media"), list):
        office_id = office_id_for(cid, native)
        media = []
        for item in event["media"]:
            if isinstance(item, dict) and not item.get("url") and (item.get("ref") or item.get("path")) and office_id:
                item = dict(item, url=provider_hub.media_url(office_id, session, item.get("ref") or item.get("path")))
            media.append(item)
        event = dict(event, media=media)
    return provider_hub.HUB.publish(provider_hub.chat_key(cid, native, session), event,
                                    run=event.get("runId") or event.get("run"), observed=event.get("observed") is True)


def _listen(kind, adapter_obj):
    off = _LISTENER_OFF.pop(kind, None)
    if callable(off):
        try:
            off()
        except Exception:
            pass
    on_event = getattr(adapter_obj, "on_event", None)
    if callable(on_event):
        _LISTENER_OFF[kind] = on_event(lambda event, _kind=kind: publish_event(_kind, event))


def _close_connection(kind, cid, reason):
    """Close a connection's link and end its open runs (``run.end interrupted``)."""
    _call(adapter(kind), "close", cid, reason)
    provider_hub.HUB.end_runs(cid, reason)


# ── Hermes serve agents: ids, cache, listing (design 2.2, 2.10) ──────────
AGENTS_CACHE_FILE = "provider-agents-cache.json"
_CACHE_LOCK = threading.Lock()


def _cache_path():
    return os.path.join(STATE.data_dir, AGENTS_CACHE_FILE) if STATE.data_dir else None


def _read_agents_cache():
    path = _cache_path()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _write_agents_cache(cid, profiles):
    path = _cache_path()
    if not path:
        return
    with _CACHE_LOCK:
        cache = _read_agents_cache()
        if (cache.get(cid) or {}).get("profiles") == profiles:
            return
        cache[cid] = {"at": _now_iso(), "profiles": profiles}
        _atomic_write_json(path, cache)


def _forget_agents_cache(cid):
    path = _cache_path()
    if not path:
        return
    with _CACHE_LOCK:
        cache = _read_agents_cache()
        if cache.pop(cid, None) is not None:
            _atomic_write_json(path, cache)


def _conn_status(conn):
    kind = conn.get("kind") or "hermes"
    if conn.get("enabled") is False:
        return {"state": "offline", "code": "switched_off", "detail": "Switched off.",
                "fix": "Switch it on to connect.", "version": ""}
    return _call(adapter(kind), "status", conn["id"], default=None) or StubAdapter(kind).status(conn["id"])


def serve_profiles(conn, status=None):
    """The connection's profiles (``profiles.list`` through its adapter); the last good list
    while it is offline, so agents do not vanish while Hermes restarts."""
    import discovery
    cid = conn["id"]
    status = status or _conn_status(conn)
    if status.get("state") == "connected":
        fn = getattr(adapter(conn.get("kind") or "hermes"), "agents", None)
        items = None
        if callable(fn):
            try:
                items = fn(cid)
            except Exception:
                items = None
        if isinstance(items, dict):
            items = items.get("agents") or items.get("profiles")
        if isinstance(items, list):
            profiles = discovery.normalize_hermes_profiles(items)
            _write_agents_cache(cid, profiles)
            return profiles
    return list((_read_agents_cache().get(cid) or {}).get("profiles") or [])


def _safe_agent_part(value):
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", str(value or "")).strip("-.") or "default"


def _legacy_agent_ids(vo_root=None):
    known = _hook("legacy_agents", default={}) or {}
    out = {}
    for row in _legacy_rows(vo_root):
        lid = str(row.get("id")).strip()
        listed = [a.get("id") for a in known.get(lid) or [] if isinstance(a, dict) and a.get("id")]
        out[lid] = listed[0] if listed else f"hermes-{_safe_agent_part(lid)}"
    return out


def _agent_ids_taken(data, vo_root=None):
    taken = set(_legacy_agent_ids(vo_root).values())
    for conn in data["connections"]:
        taken.update(v for v in (conn.get("profileAgents") or {}).values() if v)
    return taken


def _computed_agent_id(cid, profile, conn, taken, is_default):
    base = f"hermes-{cid}" if is_default and not (conn.get("profileAgents") or {}) \
        else f"hermes-{cid}-{slug(profile, 'profile')}"
    new_id, n = base, 2
    while new_id in taken:
        new_id, n = f"{base}-{n}", n + 1
    return new_id


def ensure_profile_agents(cid, profiles):
    """Give every listed profile its office agent id once (written, never recomputed)."""
    conn = find_connection(cid)
    if conn is None:
        return {}
    have = conn.get("profileAgents") or {}
    if all(p["profile"] in have for p in profiles):
        return dict(have)
    vo_root = _read_vo_config()

    def _apply(data):
        record = find_connection(cid, data)
        if record is None:
            return {}
        mapping = record.setdefault("profileAgents", {})
        taken = _agent_ids_taken(data, vo_root)
        for p in sorted(profiles, key=lambda item: (not item.get("default"), item["profile"])):
            if p["profile"] not in mapping:
                mapping[p["profile"]] = _computed_agent_id(cid, p["profile"], record, taken, p.get("default"))
                taken.add(mapping[p["profile"]])
        record["updatedAt"] = record.get("updatedAt") or _now_iso()
        return dict(mapping)
    return _store().update(_apply)


def _seen_legacy_model(row, entry):
    """The last /v1/models id this API-server row answered at its current address (kept in its legacy entry)."""
    url = str(row.get("apiUrl") or row.get("url") or "")
    return str(entry.get("modelId") or "") if entry.get("modelUrl") == url else ""


def remember_legacy_model(lid, url, model_id):
    """Keep the first /v1/models id an API-server row answered (design 2.10's guess), so the profile it
    reaches stays hidden while that server is down or the office restarts. True when it changed."""
    lid, url, model_id = str(lid or "").strip(), str(url or ""), str(model_id or "").strip()[:128]
    if STATE.store is None or not lid or not model_id:
        return False
    entry = load()["legacy"].get(lid)
    if isinstance(entry, dict) and entry.get("modelId") == model_id and entry.get("modelUrl") == url:
        return False

    def _apply(data):
        data["legacy"].setdefault(lid, {"access": "full"}).update({"modelId": model_id, "modelUrl": url})
    _store().update(_apply)
    return True


def serve_connections_enabled():
    return STATE.store is not None and any(
        (c.get("kind") or "hermes") == "hermes" and c.get("enabled") is not False for c in load()["connections"])


def _legacy_model_ids(conn, legacy_rows, legacy_map):
    """{legacy id: first /v1/models id} of the enabled, not switched API-server rows on this connection's
    machine: live from the server's status probe (``legacy_model_ids(rows)`` hook, never blocks), else the
    last id seen at the row's address."""
    import discovery
    rows = [row for row in legacy_rows
            if row.get("enabled") is not False
            and not ((legacy_map.get(str(row.get("id")).strip()) or {}).get("replacedBy"))
            and discovery.same_machine(conn.get("url"), row.get("apiUrl") or row.get("url"))]
    if not rows:
        return {}
    live = _hook("legacy_model_ids", rows, default={}) or {}
    out = {}
    for row in rows:
        lid = str(row.get("id")).strip()
        entry = legacy_map.get(lid) if isinstance(legacy_map.get(lid), dict) else {}
        model = str(live.get(lid) or "") or _seen_legacy_model(row, entry)
        if model:
            out[lid] = model
    return out


def _serve_view(conn, data, vo_root, status=None):
    import discovery
    status = status or _conn_status(conn)
    profiles = serve_profiles(conn, status)
    mapping = ensure_profile_agents(conn["id"], profiles) if profiles else dict(conn.get("profileAgents") or {})
    legacy_rows = _legacy_rows(vo_root)
    return discovery.hermes_serve_rows(
        conn, profiles, mapping, legacy_rows, data["legacy"], caps=MANIFESTS["hermes"]["caps"],
        status=status, legacy_model_ids=_legacy_model_ids(conn, legacy_rows, data["legacy"]))


def discovery_rows():
    """Office roster rows of every enabled serve connection (design 2.10); hidden profiles
    (reached through an older API-server row) are left out."""
    if STATE.store is None:
        return []
    data = load()
    vo_root = _read_vo_config()
    rows = []
    for conn in data["connections"]:
        if (conn.get("kind") or "hermes") != "hermes" or conn.get("enabled") is False:
            continue
        try:
            found, _listing = _serve_view(conn, data, vo_root)
        except Exception:
            continue
        rows.extend(found)
    return rows


def serve_agent_ids():
    """Every office id a serve connection hands out (to drop stale discovery-cache rows)."""
    if STATE.store is None:
        return set()
    return {v for conn in load()["connections"] for v in (conn.get("profileAgents") or {}).values() if v}


# ── the switch (design 2.10) ─────────────────────────────────────────────
def _set_legacy_enabled(lids, on):
    if not lids or not callable(STATE.hooks.get("update_vo_config")):
        return

    def _apply_vo(root):
        rows = ((root.get("hermes") or {}).get("connections") or []) if isinstance(root.get("hermes"), dict) else []
        for row in rows:
            if isinstance(row, dict) and str(row.get("id") or "").strip() in lids:
                row["enabled"] = on
    STATE.hooks["update_vo_config"](_apply_vo)
    _hook("after_vo_config_change")


def switch(body):
    to = str((body or {}).get("to") or "").strip()
    moves = (body or {}).get("moves")
    conn = find_connection(to) if to else None
    if conn is None or (conn.get("kind") or "hermes") != "hermes":
        raise ProviderError("not_found", "That Hermes connection does not exist any more.", status=404, field="to")
    if not isinstance(moves, list) or not moves or len(moves) > 50:
        raise _invalid("moves", "Choose the agents to move.")
    vo_root = _read_vo_config()
    rows = {str(r.get("id")).strip(): r for r in _legacy_rows(vo_root)}
    agent_ids = _legacy_agent_ids(vo_root)
    profiles = {p["profile"] for p in serve_profiles(conn)}
    data = load()
    plan, seen_l, seen_p = [], set(), set()
    for move in moves:
        lid = str((move or {}).get("legacyId") or "").strip()
        profile = str((move or {}).get("profile") or "").strip()
        if lid not in rows:
            raise ProviderError("not_found", f'The older connection "{lid}" does not exist any more.', status=404,
                                field="legacyId")
        if (data["legacy"].get(lid) or {}).get("replacedBy"):
            raise ProviderError("conflict", f'"{rows[lid].get("name") or lid}" was already switched.', status=409)
        if profile not in profiles:
            raise _invalid("profile", f'Hermes has no profile named "{profile}" (or it is not reachable now).')
        if lid in seen_l or profile in seen_p:
            raise _invalid("moves", "Each agent and each profile can be moved once.")
        seen_l.add(lid)
        seen_p.add(profile)
        plan.append((lid, profile, agent_ids[lid]))

    def _apply(data):
        record = find_connection(to, data)
        mapping = record.setdefault("profileAgents", {})
        for lid, profile, agent_id in plan:
            entry = data["legacy"].setdefault(lid, {"access": "full"})
            previous = mapping.get(profile)
            if previous and previous != agent_id:
                entry["computedId"] = previous
            for other, mapped in list(mapping.items()):
                if mapped == agent_id and other != profile:
                    mapping.pop(other)
            mapping[profile] = agent_id
            entry.update({"replacedBy": to, "profile": profile})
        record["updatedAt"] = _now_iso()
    _store().update(_apply)
    _set_legacy_enabled({lid for lid, _p, _a in plan}, False)
    _hook("refresh_discovery")
    return {"ok": True, "moved": [{"legacyId": lid, "agentId": agent_id, "profile": profile}
                                  for lid, profile, agent_id in plan]}


def switch_back(body):
    lid = str((body or {}).get("legacyId") or "").strip()
    data = load()
    entry = data["legacy"].get(lid) if isinstance(data["legacy"].get(lid), dict) else None
    if not entry or not entry.get("replacedBy"):
        raise ProviderError("not_found", "That agent was not switched.", status=404, field="legacyId")
    vo_root = _read_vo_config()
    agent_id = _legacy_agent_ids(vo_root).get(lid) or f"hermes-{_safe_agent_part(lid)}"

    def _apply(data):
        item = data["legacy"][lid]
        record = find_connection(item.get("replacedBy"), data)
        profile = item.get("profile") or ""
        if record is not None and profile:
            mapping = record.setdefault("profileAgents", {})
            if mapping.get(profile) == agent_id:
                restored = item.get("computedId")
                taken = _agent_ids_taken(data, vo_root)
                if not restored or restored in taken:
                    rest = dict(record, profileAgents={k: v for k, v in mapping.items() if k != profile})
                    restored = _computed_agent_id(record["id"], profile, rest, taken, profile == "default")
                mapping[profile] = restored
        item.pop("replacedBy", None)
        item.pop("computedId", None)
    _store().update(_apply)
    _set_legacy_enabled({lid}, True)
    _hook("refresh_discovery")
    return {"ok": True}


# ── agents of the chat routes (design 2.6, 4.1) ──────────────────────────
NOT_HERE_TEXT = "This agent's chat does not use the Agent Providers routes."
GONE_TEXT = "This agent is not in the office any more."
_ERROR_STATUS = {"unsupported": 400, "bad_request": 400, "invalid": 400, "chat_only": 403, "forbidden": 403,
                 "reauth_required": 403, "not_found": 404, "gone": 404, "not_pending": 409, "conflict": 409,
                 "busy": 409, "too_large": 413, "offline": 503, "unreachable": 503, "signin_needed": 503,
                 "auth_rejected": 503, "not_started": 503, "timeout": 504}


class AgentRef(str):
    """An agent as adapters see it: the string is the provider's own id (Hermes profile,
    OpenClaw agent id); ``office_id``, ``cid``, ``kind`` and ``transport`` say where it lives."""

    def __new__(cls, native, office_id="", cid="", kind="", transport=""):
        obj = super().__new__(cls, str(native or ""))
        obj.native = str(native or "")
        obj.profile = obj.native
        obj.office_id = str(office_id or native or "")
        obj.cid = str(cid or "")
        obj.kind = str(kind or "")
        obj.transport = str(transport or "")
        return obj


class Target:
    def __init__(self, kind, transport, cid, native, office_id, adapter_obj=None, conn=None, row=None):
        self.kind, self.transport, self.cid, self.native = kind, transport, cid, native
        self.office_id, self.adapter, self.conn, self.row = office_id, adapter_obj, conn, row
        self.ref = AgentRef(native, office_id, cid, kind, transport)

    def key(self, session):
        return provider_hub.chat_key(self.cid, self.native, _norm_session(self.kind, self.native, session))


TRANSPORT_NAMES = {"claude-code": "claude-code", "claudecode": "claude-code", "claude": "claude-code",
                   "codex": "codex", "opencode": "opencode", "antigravity": "antigravity", "builtin": "builtin"}


def resolve_agent(office_id):
    office_id = str(office_id or "").strip()[:200]
    if not office_id:
        raise _invalid("agent", "Which agent?")
    if STATE.store is not None:
        for conn in load()["connections"]:
            for profile, mapped in (conn.get("profileAgents") or {}).items():
                if mapped == office_id:
                    kind = conn.get("kind") or "hermes"
                    return Target(kind, "hermes-serve", conn["id"], profile, office_id, adapter(kind), conn)
    row = _hook("roster_agent", office_id, default=None)
    if not isinstance(row, dict):
        raise ProviderError("gone", GONE_TEXT, status=404, fix="Reload the office page.")
    kind = str(row.get("providerKind") or row.get("providerId") or "openclaw")
    if kind == "openclaw":
        native = str(row.get("providerAgentId") or row.get("id") or office_id)
        return Target("openclaw", "openclaw", "openclaw", native, office_id, adapter("openclaw"), None, row)
    transport = "hermes-api" if kind == "hermes" else TRANSPORT_NAMES.get(kind, kind)
    return Target(kind, transport, str(row.get("providerConnectionId") or row.get("connectionId") or ""),
                  str(row.get("providerAgentId") or office_id), office_id, None, None, row)


def _adapter_error(exc):
    code = getattr(exc, "code", None)
    if not isinstance(code, str) or not code:
        return None
    message = getattr(exc, "message", None) or getattr(exc, "detail", None) or str(exc)
    status = getattr(exc, "status", None)
    if not isinstance(status, int) or status < 400:
        status = _ERROR_STATUS.get(code, 502)
    return ProviderError(code, str(message)[:500], status=status, fix=getattr(exc, "fix", None) or None)


def invoke(target, name, *args, **kwargs):
    """Call an adapter method for a chat route; adapter errors become ProviderErrors."""
    if target.adapter is None:
        raise ProviderError("unsupported", NOT_HERE_TEXT, status=400)
    if target.transport == "hermes-serve" and (target.conn or {}).get("enabled") is False:
        raise ProviderError("offline", "This Hermes connection is switched off.", status=503,
                            fix="Open Agent Providers and switch it on.")
    fn = getattr(target.adapter, name, None)
    if not callable(fn):
        raise ProviderError("unsupported", "This agent platform does not offer that.", status=400)
    if target.kind == "openclaw":
        _hook("openclaw_start")
    try:
        return fn(*args, **kwargs)
    except ProviderError:
        raise
    except Exception as exc:
        err = _adapter_error(exc)
        if err is None:
            raise ProviderError("adapter_error", "The agent platform answered with an error: " + str(exc)[:200],
                                status=502)
        raise err


def _can_manage(access):
    return access is not None and not getattr(access, "via_token", False) and bool(getattr(access, "can_manage", False))


_REGISTRY_CAPS = ("sessions", "history", "stop", "attachments", "approvals", "context", "tools")


def _registry_can(target, manage):
    """Agents that keep their own chat path (legacy Hermes API, Codex, Claude Code, ...):
    the manifest is built from their registry flags (design 4.1 'others')."""
    row = target.row or {}
    raw = row.get("capabilities")
    flags = set(raw) if isinstance(raw, list) else {k for k, v in (raw or {}).items() if v} if isinstance(raw, dict) else set()
    overrides = row.get("capabilityOverrides") if isinstance(row.get("capabilityOverrides"), dict) else {}
    on = lambda name, default=False: bool(overrides.get(name, name in flags or default))  # noqa: E731
    approvals = on("approvals")
    caps = {"stream": True, "sessions": on("sessions"), "sessionCreate": on("sessionCreate", on("sessions")),
            "sessionRename": False, "sessionDelete": on("sessionDelete"), "history": on("history", on("sessions")),
            "stop": True, "models": False, "effort": False, "context": target.transport == "hermes-api",
            "attachments": on("attachments"), "files": False, "approvals": approvals,
            "approvalOptions": ["allow-once", "deny"] if approvals else [], "questions": False, "secrets": False,
            "plan": False, "progressCard": False, "tasks": False, "taskSteer": False, "queue": "local",
            "observe": False, "presence": False, "titles": False, "media": False, "browser": False,
            "screen": False, "computer": False, "computerWrite": False}
    access = connection_access("hermes", target.cid) if target.kind == "hermes" else "full"
    return {"ok": True, "agent": target.office_id, "kind": target.kind, "transport": target.transport,
            "view": "default", "manage": manage, "access": access,
            "connection": {"id": target.cid, "name": row.get("provider") or target.kind,
                           "state": "connected" if row.get("available") is not False else "offline",
                           "detail": "", "fix": ""},
            "caps": caps, "locked": {}, "limits": {}, "prefs": {}}


_FULL_ONLY_CAPS = {"browser": "browser", "screen": "screen", "computerWrite": "files"}


def chat_can(target, session, access):
    manage = _can_manage(access)
    if target.adapter is None:
        return _registry_can(target, manage)
    try:
        result = invoke(target, "can", target.ref, session or None, manage=manage)
    except ProviderError as exc:
        reason = "offline" if exc.status >= 500 else ("signin" if exc.code in ("signin_needed", "auth_rejected")
                                                     else exc.code)
        return {"ok": False, "reason": reason, "message": exc.message, "fix": exc.fix or ""}
    if not isinstance(result, dict):
        return {"ok": False, "reason": "offline", "message": "The agent platform did not answer.", "fix": ""}
    if not result.get("ok", True):
        return result
    out = dict(result)
    level = connection_access(target.kind, target.cid)
    caps = dict(out.get("caps") or {})
    locked = dict(out.get("locked") or {})
    if level != "full":  # second line: Chat only never offers a Full-access feature
        for cap, area in _FULL_ONLY_CAPS.items():
            if caps.get(cap):
                caps[cap] = False
                locked.setdefault(cap, chat_only_reason(target.kind, area))
    if not manage:
        caps["sessionDelete"] = False
    out.update({"ok": True, "agent": target.office_id, "kind": target.kind, "transport": target.transport,
                "manage": manage, "access": level, "caps": caps, "locked": locked})
    out.setdefault("view", "hermes" if target.transport == "hermes-serve" else "default")
    if not isinstance(out.get("connection"), dict):
        status = _target_status(target)
        out["connection"] = {"id": target.cid, "name": (target.conn or {}).get("name") or target.kind,
                             "state": status.get("state"), "detail": status.get("detail"), "fix": status.get("fix")}
    out.setdefault("limits", {"attachmentBytes": 25 * 1024 * 1024, "maxFiles": 10})
    out.setdefault("prefs", {})
    return out


def _target_status(target):
    if target.transport == "hermes-serve":
        return _conn_status(target.conn or {"id": target.cid, "kind": target.kind})
    if target.adapter is not None:
        return _call(target.adapter, "status", target.cid, default=None) or StubAdapter(target.kind).status(target.cid)
    return {"state": "connected", "code": "", "detail": "", "fix": "", "version": ""}


def chat_state(target, session):
    key = target.key(session)
    snap = provider_hub.HUB.snapshot(key)
    extra = {}
    if session:
        try:
            extra = invoke(target, "state", target.ref, key[2]) or {}
        except ProviderError:
            extra = {}
    known = {run["runId"] for run in snap["runs"]}
    for run in extra.get("runs") or []:
        if isinstance(run, dict) and run.get("runId") and run["runId"] not in known:
            snap["runs"].append(run)
    for name in ("approvals", "questions"):
        snap[name] = [x for x in extra.get(name) or [] if isinstance(x, dict)]
    for name in ("plan", "queue", "model", "effort"):
        if extra.get(name) is not None:
            snap[name] = extra[name]
    if extra.get("title") and not snap.get("title"):
        snap["title"] = extra["title"]
    if extra.get("usage") and not snap.get("usage"):
        snap["usage"] = extra["usage"]
    snap["working"] = bool(snap.get("working") or extra.get("working"))
    snap["provider"] = {"status": _target_status(target)}
    snap["ok"] = True
    return snap


# ── /api/agent-providers extras: test, detect, reconnect, sync, call ─────
def _probe_hermes(url, timeout=2.5):
    """``{url, version, authRequired}`` when a Hermes backend answers its public status page."""
    import urllib.request
    try:
        req = urllib.request.Request(url.rstrip("/") + "/api/status", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (fixed candidate list)
            data = json.loads(res.read(65536).decode("utf-8", "replace"))
    except Exception:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("version"), str) or "auth_required" not in data:
        return None
    return {"url": url, "version": data["version"][:40], "authRequired": bool(data.get("auth_required"))}


def test_connection(body):
    kind = str((body or {}).get("kind") or "").strip()
    transport = str((body or {}).get("transport") or "").strip()
    cid = str((body or {}).get("id") or "").strip()
    values = dict((body or {}).get("values") or {}) if isinstance((body or {}).get("values"), dict) else {}
    if kind == "openclaw":
        result = invoke(Target("openclaw", "openclaw", "openclaw", "", "", adapter("openclaw")), "test", values)
        return dict(result or {}, ok=bool((result or {}).get("ok")))
    if kind == "hermes" and transport == "api":
        if not str(values.get("apiKey") or "").strip() and cid:
            row = next((r for r in _legacy_rows() if str(r.get("id")).strip() == cid), {})
            values["apiKey"] = row.get("apiKey") or ""
        return _hook("legacy_test", values, default={"ok": False, "code": "unsupported",
                                                      "detail": "The office cannot test this connection."})
    if kind != "hermes":
        raise ProviderError("invalid", "Unknown connection type.", status=400, field="kind")
    url = normalize_url(values.get("url") or (find_connection(cid) or {}).get("url") or "", ("http", "https"))
    if not url:
        raise _invalid("url", _field(MANIFESTS["hermes"], "url")["error"])
    values["url"] = url
    if cid and STATE.secrets is not None:
        for field in ("token", "password"):
            if not str(values.get(field) or "").strip():
                stored = STATE.secrets.get("hermes", cid, field)
                if stored:
                    values[field] = stored
        values.setdefault("connectionId", cid)
    fn = getattr(adapter("hermes"), "test", None)
    if callable(fn):
        try:
            result = fn(values)
        except Exception as exc:
            err = _adapter_error(exc) or ProviderError("adapter_error", str(exc)[:200], status=502)
            return {"ok": False, "code": err.code, "detail": err.message, "fix": err.fix or ""}
        return result if isinstance(result, dict) else {"ok": False, "code": "adapter_error", "detail": ""}
    found = _probe_hermes(url)
    if not found:
        return {"ok": False, "code": "unreachable", "detail": "Nothing answers as Hermes at this address.",
                "fix": "Check that `hermes serve` is running there."}
    return {"ok": False, "code": "not_started", "version": found["version"],
            "detail": f"Hermes {found['version']} answers here, but the office cannot check the sign-in yet.",
            "fix": "Save the connection; it signs in by itself."}


def detect(body):
    kind = str((body or {}).get("kind") or "hermes")
    if kind != "hermes":
        raise ProviderError("unsupported", "Finding works for Hermes only.", status=400)
    candidates = list(MANIFESTS["hermes"].get("detect") or [])
    for conn in load()["connections"]:
        if conn.get("url") and conn["url"] not in candidates:
            candidates.append(conn["url"])
    candidates = candidates[:8]
    fn = getattr(adapter("hermes"), "detect", None)
    if callable(fn):
        try:
            result = fn(candidates)
            found = result.get("found") if isinstance(result, dict) else result
            if isinstance(found, list):
                return {"ok": True, "found": [f for f in found if isinstance(f, dict)]}
        except Exception:
            pass
    results = [None] * len(candidates)

    def _one(i, url):
        results[i] = _probe_hermes(url)
    threads = [threading.Thread(target=_one, args=(i, u), daemon=True) for i, u in enumerate(candidates)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=4)
    return {"ok": True, "found": [r for r in results if r]}


def _provider_kind_of(cid):
    if cid == "openclaw":
        return "openclaw", None
    conn = find_connection(cid)
    if conn is not None:
        return conn.get("kind") or "hermes", conn
    if any(str(r.get("id")).strip() == cid for r in _legacy_rows()):
        return "hermes-api", None
    raise ProviderError("not_found", "That connection does not exist any more.", status=404)


def reconnect(body):
    cid = str((body or {}).get("id") or "").strip()
    kind, conn = _provider_kind_of(cid)
    if kind == "openclaw":
        _hook("openclaw_reconnect")
        return {"ok": True, "status": _call(adapter("openclaw"), "status", "openclaw", default={}) or {}}
    if kind == "hermes-api":
        _hook("legacy_reset_status", cid)
        return {"ok": True, "status": {"state": "connecting", "code": "checking",
                                       "detail": "Checking the API server...", "fix": "", "version": ""}}
    if conn.get("enabled") is False:
        raise ProviderError("offline", "This connection is switched off.", status=409, fix="Switch it on first.")
    adp = adapter(kind)
    if callable(getattr(adp, "reconnect", None)):
        _call(adp, "reconnect", cid)
    else:
        _close_connection(kind, cid, "Reconnecting")
        _call(adp, "reload", cid)
    return {"ok": True, "status": _conn_status(conn)}


def device(body):
    """OpenClaw device pairing: ``{"id": "openclaw", "action": "repair" | "forget"}``."""
    cid = str((body or {}).get("id") or "").strip()
    action = str((body or {}).get("action") or "").strip()
    kind, _conn = _provider_kind_of(cid)
    if kind != "openclaw":
        raise ProviderError("invalid", "Only the OpenClaw connection pairs as a device.", status=400, field="id")
    if action not in ("repair", "forget"):
        raise _invalid("action", "Choose repair or forget.")
    public = _hook("openclaw_device", action, default=None)
    if public is None:
        raise ProviderError("not_available", "Device pairing is not available on this server.", status=409)
    return {"ok": True, "device": public}


def sync(body):
    cid = str((body or {}).get("id") or "").strip()
    kind, conn = _provider_kind_of(cid)
    if kind != "hermes":
        _hook("refresh_discovery")
        rows = [p for p in list_providers()["providers"] if p["id"] == cid]
        return {"ok": True, "agents": rows[0]["agents"] if rows else []}
    _rows, listing = _serve_view(conn, load(), _read_vo_config())
    _hook("refresh_discovery")
    return {"ok": True, "agents": listing}


_METHOD_RE = re.compile(r"^[A-Za-z][\w.]{0,79}$")


def menu_call(body, access):
    cid = str((body or {}).get("id") or "").strip()
    method = str((body or {}).get("method") or "").strip()
    params = (body or {}).get("params")
    params = params if isinstance(params, dict) else {}
    if not _METHOD_RE.match(method):
        raise _invalid("method", "Unknown settings call.")
    kind, conn = _provider_kind_of(cid)
    if kind == "hermes-api":
        raise ProviderError("unsupported", "The older API-server connection has no settings menu.", status=400)
    manifest = MANIFESTS["openclaw" if kind == "openclaw" else "hermes"]
    if method in manifest.get("menuWrite") or []:
        require_full(kind, cid, "settings")
        require_recent(access)
        audit(cid, kind, method)
    elif kind == "openclaw":
        try:
            import openclaw_adapter
            if method in openclaw_adapter.MENU_ADMIN_READS:
                require_full(kind, cid, "admin")
        except ImportError:
            pass
    target = Target(kind, "openclaw" if kind == "openclaw" else "hermes-serve", cid, "", "", adapter(kind), conn)
    result = invoke(target, "menu", cid, method, params)
    return {"ok": True, "result": result}


# ── /api/office/chat-sessions branch for serve agents (design 2.6) ──────────────
def is_serve_agent(office_id):
    """True when the office agent lives on a `hermes serve` connection (cheap: the record only)."""
    if STATE.store is None or not office_id:
        return False
    try:
        return any(office_id in (conn.get("profileAgents") or {}).values() for conn in load()["connections"])
    except ProviderError:
        return False


def _session_deletable(target, key, manage):
    """Whether the drawer may offer Delete for one chat: a browser session (or this machine), an adapter that has
    session_op, and for OpenClaw Full access (its sessions.delete is a settings write) and never the main chat."""
    if not manage or not callable(getattr(target.adapter, "session_op", None)):
        return False
    if target.kind == "openclaw":
        return connection_access(target.kind, target.cid) == "full" and not str(key).endswith(":main")
    return True


def _drawer_rows(target, rows, limit, manage):
    out = []
    for row in (rows if isinstance(rows, list) else [])[:limit]:
        if not isinstance(row, dict):
            continue
        key = str(row.get("key") or row.get("id") or row.get("sessionKey") or "")[:400]
        if not key:
            continue
        out.append(dict(row, id=key, key=key, title=str(row.get("title") or "")[:200],
                        deletable=_session_deletable(target, key, manage)))
    return out


def chat_session_rows(target, access, limit=100):
    """GET /api/agent-chat/sessions?agent: the platform's own chat list for the drawer, read-only (design 2.9:
    OpenClaw sessions.list titles + hasActiveRun; Hermes serve the same rows as /api/office/chat-sessions). A platform
    that does not answer -> 200 {ok:false, reason, sessions:[]} so the drawer keeps its own list."""
    if target.adapter is None:
        raise ProviderError("unsupported", NOT_HERE_TEXT, status=400)
    manage = _can_manage(access)
    try:
        result = invoke(target, "sessions", target.ref)
    except ProviderError as exc:
        if exc.status < 500 and exc.code not in ("signin_needed", "auth_rejected", "not_connected"):
            raise
        reason = "signin" if exc.code in ("signin_needed", "auth_rejected") else "offline"
        return {"ok": False, "reason": reason, "message": exc.message, "fix": exc.fix or "", "sessions": []}
    rows = result.get("sessions") if isinstance(result, dict) else result
    sessions = _drawer_rows(target, rows, max(1, min(int(limit or 100), 200)), manage)
    for row in sessions:
        flags = (row.pop("hasActiveRun", None), row.pop("active", None))  # OpenClaw rows name it `active`
        row["hasActiveRun"] = any(bool(flag) for flag in flags)
    return {"ok": True, "agent": target.office_id, "kind": target.kind, "transport": target.transport,
            "sessions": sessions, "working": [row["key"] for row in sessions if row["hasActiveRun"]]}


def chat_sessions(agent_id, limit=40, manage=False):
    """``(payload, status)`` for a serve agent's drawer, or None for every other agent. Rows carry `deletable`
    (delete = the adapter closes the live chat, then deletes it on Hermes)."""
    if STATE.store is None:
        return None
    try:
        target = resolve_agent(agent_id)
    except ProviderError:
        return None
    if target.transport != "hermes-serve":
        return None
    try:
        result = invoke(target, "sessions", target.ref)
    except ProviderError as exc:
        return dict(exc.payload(), sessions=[]), (exc.status if exc.status < 500 else 200)
    rows = result.get("sessions") if isinstance(result, dict) else result
    sessions = _drawer_rows(target, rows, max(1, min(int(limit or 40), 100)), manage)
    return {"ok": True, "sessions": sessions, "provider": "hermes", "transport": "hermes-serve"}, 200


def chat_session_delete(agent_id, session):
    if STATE.store is None:
        return None
    try:
        target = resolve_agent(agent_id)
    except ProviderError:
        return None
    if target.transport != "hermes-serve":
        return None
    try:
        invoke(target, "session_op", target.ref, "delete", str(session or ""), {})
    except ProviderError as exc:
        return exc.payload(), exc.status
    return {"ok": True, "deleted": True}, 200


# ── HTTP dispatch ────────────────────────────────────────────────────────
PREFIXES = ("/api/agent-providers", "/api/agent-chat")
QUEUE_MODES = ("", "redirect", "later", "steer", "followup")
APPROVAL_CHOICES = ("allow-once", "allow-session", "allow-always", "deny")
TEXT_MAX = 100_000
FILES_MAX = 10


def handles(path):
    return any(path == p or path.startswith(p + "/") for p in PREFIXES)


def _send(handler, payload, status=200):
    handler._send_json(payload, status)
    return True


def _q(query, name, default=""):
    value = (query or {}).get(name)
    if isinstance(value, list):
        value = value[0] if value else default
    return str(value if value is not None else default)[:2000]


def _send_image(handler, frame):
    if not isinstance(frame, dict) or not isinstance(frame.get("data"), (bytes, bytearray)):
        handler.send_response(204)
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        return True
    data = bytes(frame["data"])
    mime = str(frame.get("mime") or "image/jpeg")
    if mime not in ("image/jpeg", "image/png", "image/webp"):
        mime = "application/octet-stream"
    handler.send_response(200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Content-Security-Policy", "sandbox")
    handler.end_headers()
    handler.wfile.write(data)
    return True


def _files_of(body):
    files = body.get("files")
    if files in (None, ""):
        return []
    if not isinstance(files, list) or len(files) > FILES_MAX:
        raise _invalid("files", f"Attach up to {FILES_MAX} files.")
    out = []
    for ref in files:
        resolved = _hook("resolve_upload", ref, default=None) if callable(STATE.hooks.get("resolve_upload")) else ref
        if not resolved:
            raise _invalid("files", "An attached file is no longer on the office server: attach it again.")
        out.append(resolved)
    return out


CHAT_GET_ROUTES = frozenset({"/can", "/state", "/events", "/history", "/models", "/sessions", "/progress", "/tasks",
                             "/tasks/one",
                             "/tasks/history", "/browser", "/browser/frame", "/screen", "/screen/thumb", "/files",
                             "/files/read"})
CHAT_POST_ROUTES = frozenset({"/prefs", "/runs", "/stop", "/approvals", "/questions", "/watch", "/session",
                              "/tasks/cancel", "/tasks/steer", "/progress", "/browser", "/screen", "/files"})


def _chat_get(handler, path, query, access):
    route = path[len("/api/agent-chat"):]
    if route == "/media":
        def fetch(agent, session, ref):
            target = resolve_agent(agent)
            return invoke(target, "media", target.ref, _norm_session(target.kind, target.native, session), ref)
        return provider_hub.serve_media(handler, _q(query, "t"), fetch)
    if route not in CHAT_GET_ROUTES:
        raise ProviderError("not_found", "This Agent Providers call is not available.", status=404)
    target = resolve_agent(_q(query, "agent"))
    session = _q(query, "session")[:400]
    key = target.key(session)[2]
    if route == "/can":
        return _send(handler, chat_can(target, key, access))
    if route == "/state":
        return _send(handler, chat_state(target, key))
    if route == "/sessions":
        try:
            limit = int(_q(query, "limit", "100") or 100)
        except ValueError:
            limit = 100
        return _send(handler, chat_session_rows(target, access, limit))
    if route == "/events":
        if target.adapter is None:
            raise ProviderError("unsupported", NOT_HERE_TEXT, status=400)
        if target.kind == "openclaw":
            _hook("openclaw_start")
        keys = [provider_hub.agent_key(target.cid, target.native), provider_hub.connection_key(target.cid)]
        if key:
            keys.insert(0, target.key(key))
        since = provider_hub.parse_since(handler.headers.get("Last-Event-ID")) \
            if handler.headers.get("Last-Event-ID") else provider_hub.parse_since(_q(query, "since"))
        provider_hub.serve_sse(handler, keys, since, client=provider_hub.stream_client(handler, query))
        return True
    if route == "/history":
        return _send(handler, dict(invoke(target, "history", target.ref, key, _q(query, "before") or None) or {},
                                   ok=True))
    if route == "/models":
        return _send(handler, dict(invoke(target, "models", target.ref, key or None) or {}, ok=True))
    if route == "/progress":
        return _send(handler, dict(invoke(target, "progress", target.ref, key, "get") or {}, ok=True))
    scope = _q(query, "scope", "chat")
    if route == "/tasks":
        return _send(handler, dict(invoke(target, "tasks", target.ref, key or None, scope) or {}, ok=True))
    if route == "/tasks/one":
        return _send(handler, dict(invoke(target, "task", target.ref, _q(query, "task"), key or None, scope) or {},
                                   ok=True))
    if route == "/tasks/history":
        return _send(handler, dict(invoke(target, "task_history", target.ref, _q(query, "task"), key or None,
                                          scope) or {}, ok=True))
    if route in ("/browser", "/browser/frame"):
        require_manage(access)
        require_full(target.kind, target.cid, "browser")
        if route == "/browser/frame":
            return _send_image(handler, invoke(target, "browser", target.ref, "frame", {"tab": _q(query, "tab")}))
        return _send(handler, _as_dict(invoke(target, "browser", target.ref, _q(query, "op", "state"), {})))
    if route in ("/screen", "/screen/thumb"):
        require_manage(access)
        require_full(target.kind, target.cid, "screen")
        if route == "/screen/thumb":
            return _send_image(handler, invoke(target, "screen_thumb", target.ref))
        return _send(handler, _as_dict(invoke(target, "screen_state", target.ref)))
    if route in ("/files", "/files/read"):
        require_manage(access)
        op = "read" if route == "/files/read" else (_q(query, "op", "list") or "list")
        if op not in ("list", "read", "docs", "doc"):
            raise _invalid("op", "Unknown file call.")
        params = {"path": _q(query, "path"), "name": _q(query, "name")}
        return _send(handler, _as_dict(invoke(target, "files", target.ref, op, params)))
    raise ProviderError("not_found", "This Agent Providers call is not available.", status=404)


def _as_dict(result):
    return dict(result, ok=result.get("ok", True)) if isinstance(result, dict) else {"ok": True, "result": result}


def _chat_post(handler, path, body, access):
    route = path[len("/api/agent-chat"):]
    if route not in CHAT_POST_ROUTES:
        raise ProviderError("not_found", "This Agent Providers call is not available.", status=404)
    require_manage(access)
    target = resolve_agent(body.get("agent"))
    session = str(body.get("session") or "")[:400]
    key = target.key(session)[2]
    run_id = str(body.get("run") or "")[:200] or None
    if route == "/prefs":
        kwargs = {name: body.get(name) for name in ("model", "effort") if name in body}
        return _send(handler, _as_dict(invoke(target, "set_prefs", target.ref, key, **kwargs)))
    if route == "/runs":
        text = body.get("text") if isinstance(body.get("text"), str) else ""
        if len(text) > TEXT_MAX:
            raise _invalid("text", "The message is too long.")
        files = _files_of(body)
        if not text.strip() and not files:
            raise _invalid("text", "Write a message or attach a file.")
        mode = str(body.get("queue") or "")
        if mode not in QUEUE_MODES:
            raise _invalid("queue", "Unknown queue mode.")
        result = _as_dict(invoke(target, "run", target.ref, key, text, files, mode or None))
        if body.get("clientId"):
            result["clientId"] = str(body["clientId"])[:200]
        return _send(handler, result)
    if route == "/stop":
        return _send(handler, _as_dict(invoke(target, "stop", target.ref, key, run_id)))
    if route == "/approvals":
        decision = str(body.get("decision") or "")
        if decision not in APPROVAL_CHOICES:
            raise _invalid("decision", "Choose one of the offered answers.")
        return _send(handler, _as_dict(invoke(target, "approve", target.ref, key, run_id,
                                              str(body.get("approval") or ""), decision)))
    if route == "/questions":
        answers = body.get("answers") if isinstance(body.get("answers"), (dict, list)) else None
        return _send(handler, _as_dict(invoke(target, "answer", target.ref, key, run_id,
                                              str(body.get("question") or ""), answers, bool(body.get("cancel")))))
    if route == "/watch":
        return _send(handler, _as_dict(invoke(target, "watch", target.ref, key, bool(body.get("on", True)))))
    if route == "/session":
        op = str(body.get("op") or "")
        if op not in ("rename", "create", "delete"):
            raise _invalid("op", "Unknown chat change.")
        args = {"title": str(body.get("title") or "")[:200]} if op == "rename" else {}
        return _send(handler, _as_dict(invoke(target, "session_op", target.ref, op, key, args)))
    if route == "/tasks/cancel":
        return _send(handler, _as_dict(invoke(target, "cancel_task", target.ref, str(body.get("task") or ""),
                                              key or None, str(body.get("scope") or "chat"))))
    if route == "/tasks/steer":
        text = str(body.get("text") or "")[:TEXT_MAX]
        return _send(handler, _as_dict(invoke(target, "steer_task", target.ref, str(body.get("task") or ""), text)))
    if route == "/progress":
        op = str(body.get("op") or "")
        if op not in ("refresh", "dismiss"):
            raise _invalid("op", "Unknown progress card change.")
        kwargs = {k: body.get(n) for k, n in (("revision", "revision"), ("idempotency_key", "idempotencyKey"))
                  if body.get(n) is not None}
        return _send(handler, _as_dict(invoke(target, "progress", target.ref, key, op, **kwargs)))
    if route == "/browser":
        require_full(target.kind, target.cid, "browser")
        op = str(body.get("op") or "")
        params = {k: v for k, v in body.items() if k not in ("agent", "session", "op")}
        return _send(handler, _as_dict(invoke(target, "browser", target.ref, op, params)))
    if route == "/screen":
        require_full(target.kind, target.cid, "screen")
        params = {k: v for k, v in body.items() if k not in ("agent", "session", "op")}
        return _send(handler, _as_dict(invoke(target, "screen_act", target.ref, str(body.get("op") or ""), params)))
    if route == "/files":
        op = str(body.get("op") or "")
        if op not in ("write", "mkdir", "remove", "docSet"):
            raise _invalid("op", "Unknown file change.")
        require_full(target.kind, target.cid, "files")
        params = {k: v for k, v in body.items() if k not in ("agent", "session", "op")}
        return _send(handler, _as_dict(invoke(target, "files", target.ref, op, params)))
    raise ProviderError("not_found", "This Agent Providers call is not available.", status=404)


_PROVIDER_POSTS = {"save": save, "enable": enable, "remove": remove, "test": test_connection, "detect": detect,
                   "reconnect": reconnect, "sync": sync, "switch": switch, "switch-back": switch_back,
                   "device": device}


def dispatch(handler, method, path, query=None, body=None):
    """Answer ``/api/agent-providers*`` and ``/api/agent-chat/*``. True when answered."""
    if not handles(path):
        return False
    access = handler._vo_access()
    try:
        if path == "/api/agent-providers" and method == "GET":
            require_manage(access)
            return _send(handler, list_providers())
        if path.startswith("/api/agent-chat/") and method in ("GET", "HEAD"):
            return _chat_get(handler, path, query, access)
        if method == "POST":
            if path.startswith("/api/agent-providers/"):
                require_manage(access)
            if body is None:
                body = handler._read_json_body(
                    max_bytes=RUN_BODY_MAX_BYTES if path == "/api/agent-chat/runs" else BODY_MAX_BYTES)
            if not isinstance(body, dict):
                raise ProviderError("invalid", "The request body must be a JSON object.", status=400)
            if path.startswith("/api/agent-chat/"):
                return _chat_post(handler, path, body, access)
            action = path[len("/api/agent-providers/"):]
            if action == "call":
                return _send(handler, menu_call(body, access))
            if action in _PROVIDER_POSTS:
                return _send(handler, _PROVIDER_POSTS[action](body))
        raise ProviderError("not_found", "This Agent Providers call is not available.", status=404)
    except ProviderError as exc:
        return _send(handler, exc.payload(), exc.status)
    except provider_secrets.SecretStoreError as exc:
        return _send(handler, {"ok": False, "error": "store_unreadable", "message": str(exc)}, 409)


# ── v0.11: Hermes API-server connections beside the copied provider layer ─
# With the layer on, /api/agent-providers* is the layer's and it speaks only `hermes serve`. The older API-server rows
# (vo-config.json hermes.connections, 0.7.x) stay on VO's Python path: their settings are here. Only those rows: never
# a serve connection or OpenClaw (that would start VO's Python Hermes serve link or gateway client beside the layer).
LEGACY_PREFIX = "/api/office/hermes-api"


def legacy_handles(path):
    return path == LEGACY_PREFIX or path.startswith(LEGACY_PREFIX + "/")


def _legacy_view(cid=None):
    data = load()
    legacy_agents = _hook("legacy_agents", default={}) or {}
    rows = [_legacy_row(row, data, legacy_agents) for row in _legacy_rows()
            if cid is None or str(row.get("id")).strip() == cid]
    return rows


def _legacy_status(cid):
    return next(iter(_legacy_view(cid)), {}).get("status") or {}


def legacy_list():
    return {"ok": True, "providers": _legacy_view(), "manifests": {"hermes-api": public_manifests()["hermes-api"]}}


def _legacy_id(body):
    cid = str((body or {}).get("id") or "").strip()
    if not cid or not any(str(r.get("id")).strip() == cid for r in _legacy_rows()):
        raise ProviderError("not_found", "That connection does not exist any more.", status=404)
    return cid


def _legacy_vo_rows(cid, change):
    """Apply ``change(rows, index)`` to vo-config.json hermes.connections for row ``cid``."""
    if not callable(STATE.hooks.get("update_vo_config")):
        raise ProviderError("not_configured", "Saving is not available on this server.", status=503)

    def _apply_vo(root):
        hermes = root.get("hermes") if isinstance(root.get("hermes"), dict) else {}
        rows = hermes.get("connections") if isinstance(hermes.get("connections"), list) else []
        index = next((i for i, r in enumerate(rows) if isinstance(r, dict) and str(r.get("id") or "").strip() == cid),
                     None)
        if index is None:
            raise ProviderError("not_found", "That connection does not exist any more.", status=404)
        change(rows, index)
    STATE.hooks["update_vo_config"](_apply_vo)
    _hook("after_vo_config_change")


def legacy_post(action, body):
    """save / test / enable / reconnect / remove for one API-server row (0.10's own rules for save and test)."""
    if action == "test":
        return test_connection(dict(body, kind="hermes", transport="api"))
    cid = _legacy_id(body)
    if action == "save":
        values = body.get("values") if isinstance(body.get("values"), dict) else {}
        if "name" in body and "name" not in values:
            values = dict(values, name=body.get("name"))
        _save_legacy(cid, values)
        return {"ok": True, "id": cid, "status": _legacy_status(cid)}
    if action == "enable":
        on = bool(body.get("on", True))
        _legacy_vo_rows(cid, lambda rows, i: rows[i].__setitem__("enabled", on))
        return {"ok": True, "status": _legacy_status(cid)}
    if action == "reconnect":
        _hook("legacy_reset_status", cid)
        return {"ok": True, "status": {"state": "connecting", "code": "checking",
                                       "detail": "Checking the API server...", "fix": "", "version": ""}}
    if action == "remove":
        _legacy_vo_rows(cid, lambda rows, i: rows.pop(i))
        _store().update(lambda data: data["legacy"].pop(cid, None) is not None)
        _hook("refresh_discovery")
        return {"ok": True, "agents": []}
    raise ProviderError("not_found", "This Agent Providers call is not available.", status=404)


def legacy_dispatch(handler, method, path, query=None):
    """Answer ``/api/office/hermes-api`` (GET: the API-server rows) and ``/api/office/hermes-api/<action>`` (POST)."""
    try:
        require_manage(handler._vo_access())
        if path == LEGACY_PREFIX and method in ("GET", "HEAD"):
            return _send(handler, legacy_list())
        if method == "POST" and path.startswith(LEGACY_PREFIX + "/"):
            body = handler._read_json_body(max_bytes=BODY_MAX_BYTES)
            if not isinstance(body, dict):
                raise ProviderError("invalid", "The request body must be a JSON object.", status=400)
            return _send(handler, legacy_post(path[len(LEGACY_PREFIX) + 1:], body))
        raise ProviderError("not_found", "This Agent Providers call is not available.", status=404)
    except ProviderError as exc:
        return _send(handler, exc.payload(), exc.status)
    except provider_secrets.SecretStoreError as exc:
        return _send(handler, {"ok": False, "error": "store_unreadable", "message": str(exc)}, 409)
