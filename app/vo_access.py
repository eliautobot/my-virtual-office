"""Office access control: optional passcode, sessions and cross-site checks.

Kept free of server imports so it can be unit tested on its own.

Model:
- No passcode set (default): the office is open to whoever can reach it, as before.
- Passcode set: browsers must log in once (HttpOnly ``vo_session`` cookie). Requests
  from this machine (loopback, with a local Host header and no proxy headers) and
  requests carrying the agent API token skip the passcode so local agents keep working.
- Always on: requests that change state must come from the office's own origin
  (no cross-site writes), and the Host header must be one the office answers to
  (blocks DNS-rebinding pages that point a foreign name at this machine).
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import threading
import time
import urllib.parse
from http.cookies import SimpleCookie

import private_files
import data_owner

SESSION_COOKIE = "vo_session"
SESSION_TTL_SEC = 30 * 24 * 3600
PBKDF2_ITERATIONS = 240_000
LOGIN_WINDOW_SEC = 300
LOGIN_MAX_FAILURES = 8
RECENT_CONFIRM_SEC = 600  # passcode typed this recently allows agent-platform setting changes
MIN_PASSCODE_LENGTH = 4
MAX_PASSCODE_LENGTH = 200

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_LOCAL_SUFFIXES = (".localhost", ".local", ".lan", ".home", ".home.arpa", ".internal", ".ts.net", ".localdomain")


def _now() -> float:
    return time.time()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def split_host(host_header: str) -> str:
    """Hostname part of a Host header, lowercased, without port or IPv6 brackets."""
    host = str(host_header or "").strip().lower()
    if not host:
        return ""
    if host.startswith("["):
        end = host.find("]")
        return host[1:end] if end > 0 else host.strip("[]")
    if host.count(":") == 1:
        host = host.split(":", 1)[0]
    return host.rstrip(".")


def is_ip_literal(hostname: str) -> bool:
    try:
        ipaddress.ip_address(hostname)
        return True
    except ValueError:
        return False


def is_loopback_ip(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(str(address or "").split("%", 1)[0])
    except ValueError:
        return False
    if ip.is_loopback:
        return True
    mapped = getattr(ip, "ipv4_mapped", None)
    return bool(mapped and mapped.is_loopback)


def is_local_hostname(hostname: str) -> bool:
    hostname = str(hostname or "").lower()
    return hostname in {"localhost", "127.0.0.1", "::1"} or hostname.endswith(".localhost") or (
        is_ip_literal(hostname) and is_loopback_ip(hostname)
    )


def host_allowed(host_header: str, extra_hosts=None, protected: bool = False) -> bool:
    """Is this a Host the office should answer to?

    IP literals, localhost, single-label LAN names and common private suffixes are
    always fine. Other DNS names (a public domain behind a reverse proxy) must be
    listed in VO_ALLOWED_HOSTS, unless a passcode protects the office anyway.
    """
    hostname = split_host(host_header)
    if not hostname:
        return True  # HTTP/1.0 clients without Host (scripts); no browser omits it
    if protected:
        return True
    if is_ip_literal(hostname) or "." not in hostname:
        return True
    if hostname == "localhost" or hostname.endswith(_LOCAL_SUFFIXES):
        return True
    for item in extra_hosts or ():
        item = str(item or "").strip().lower().rstrip(".")
        if not item:
            continue
        if item == "*" or hostname == item or (item.startswith(".") and hostname.endswith(item)):
            return True
    return False


def same_origin_request(headers, method: str) -> bool:
    """Reject browser requests that change state from another site.

    Browsers send Origin on every cross-site non-GET request. Requests without
    Origin, Sec-Fetch-Site and Referer come from scripts/agents, not pages.
    """
    if str(method or "").upper() in SAFE_METHODS:
        return True
    host = str(headers.get("Host") or "").strip().lower()
    # A reverse proxy may rewrite Host; browsers cannot add X-Forwarded-Host to a
    # cross-site request without a CORS preflight, which the office never approves.
    forwarded_host = str(headers.get("X-Forwarded-Host") or "").split(",", 1)[0].strip().lower()
    accepted = {h for h in (host, forwarded_host) if h}
    origin = str(headers.get("Origin") or "").strip()
    if origin:
        if origin == "null":
            return False
        try:
            parsed = urllib.parse.urlparse(origin)
        except ValueError:
            return False
        return parsed.scheme in {"http", "https"} and parsed.netloc.lower() in accepted
    fetch_site = str(headers.get("Sec-Fetch-Site") or "").strip().lower()
    if fetch_site in {"cross-site", "same-site"}:
        return False
    referer = str(headers.get("Referer") or "").strip()
    if referer:
        try:
            parsed = urllib.parse.urlparse(referer)
        except ValueError:
            return False
        return parsed.netloc.lower() in accepted
    return True


def request_token(headers) -> str:
    auth = str(headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    for name in ("X-Virtual-Office-Token", "X-My-Virtual-Office-Token"):
        value = str(headers.get(name) or "").strip()
        if value:
            return value
    return ""


def cookie_value(headers, name: str) -> str:
    try:
        cookies = SimpleCookie()
        cookies.load(str(headers.get("Cookie") or ""))
        morsel = cookies.get(name)
        return morsel.value if morsel else ""
    except Exception:
        return ""


class AccessStore:
    """Passcode hash, agent token and login sessions, persisted in ``access.json``."""

    def __init__(self, status_dir: str, env=None):
        self.path = os.path.join(status_dir, "access.json")
        self._lock = threading.RLock()
        self._env = env if env is not None else os.environ
        self._failures: dict[str, list[float]] = {}
        self._data = self._load()

    # ── persistence ──────────────────────────────────────────────────────
    def _load(self) -> dict:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, dict):
                data.setdefault("sessions", {})
                return data
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            # Unreadable file: fail closed for the passcode (keep it), never wipe it.
            backup = self.path + ".bak"
            try:
                with open(backup, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
                if isinstance(data, dict):
                    data.setdefault("sessions", {})
                    return data
            except (OSError, ValueError):
                pass
            return {"sessions": {}, "unreadable": True}
        return {"sessions": {}}

    def _save(self) -> None:
        data = {k: v for k, v in self._data.items() if k != "unreadable"}
        data_owner.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = f"{self.path}.tmp-{os.getpid()}-{threading.get_ident()}"
        before = private_files.snapshot(self.path)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        private_files.adopt(fd, self.path, before)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        if os.path.exists(self.path):
            try:
                os.replace(self.path, self.path + ".bak")
                private_files.tighten(self.path + ".bak")
            except OSError:
                pass
        os.replace(tmp, self.path)

    # ── passcode ─────────────────────────────────────────────────────────
    @property
    def protected(self) -> bool:
        with self._lock:
            return bool(self._data.get("passcodeHash")) or bool(self._data.get("unreadable"))

    def _hash_passcode(self, passcode: str, salt: bytes, iterations: int) -> str:
        return hashlib.pbkdf2_hmac("sha256", passcode.encode("utf-8"), salt, iterations).hex()

    def check_passcode(self, passcode: str) -> bool:
        with self._lock:
            stored = str(self._data.get("passcodeHash") or "")
            salt_hex = str(self._data.get("passcodeSalt") or "")
            iterations = int(self._data.get("passcodeIterations") or PBKDF2_ITERATIONS)
        if not stored or not salt_hex or not isinstance(passcode, str):
            return False
        try:
            salt = bytes.fromhex(salt_hex)
        except ValueError:
            return False
        candidate = self._hash_passcode(passcode[:MAX_PASSCODE_LENGTH], salt, iterations)
        return hmac.compare_digest(candidate, stored)

    def set_passcode(self, passcode: str) -> None:
        """Set (or with "" remove) the passcode. Drops every existing session."""
        with self._lock:
            if passcode:
                salt = secrets.token_bytes(16)
                self._data["passcodeHash"] = self._hash_passcode(passcode, salt, PBKDF2_ITERATIONS)
                self._data["passcodeSalt"] = salt.hex()
                self._data["passcodeIterations"] = PBKDF2_ITERATIONS
                self._data["passcodeSetAt"] = int(_now())
            else:
                for key in ("passcodeHash", "passcodeSalt", "passcodeIterations", "passcodeSetAt"):
                    self._data.pop(key, None)
            self._data.pop("unreadable", None)
            self._data["sessions"] = {}
            self._save()

    @staticmethod
    def validate_new_passcode(passcode) -> str:
        if not isinstance(passcode, str):
            return "Passcode must be text."
        if passcode and len(passcode) < MIN_PASSCODE_LENGTH:
            return f"Use at least {MIN_PASSCODE_LENGTH} characters."
        if len(passcode) > MAX_PASSCODE_LENGTH:
            return "Passcode is too long."
        return ""

    # ── agent token ──────────────────────────────────────────────────────
    def agent_token(self) -> str:
        env_token = str(self._env.get("VO_AGENT_API_TOKEN") or "").strip()
        if env_token:
            return env_token
        with self._lock:
            token = str(self._data.get("agentToken") or "")
            if not token and not self._data.get("unreadable"):
                token = secrets.token_urlsafe(32)
                self._data["agentToken"] = token
                try:
                    self._save()
                except OSError:
                    pass
            return token

    def token_valid(self, token: str) -> bool:
        expected = self.agent_token()
        return bool(token and expected and hmac.compare_digest(token, expected))

    # ── sessions ─────────────────────────────────────────────────────────
    def create_session(self) -> str:
        token = secrets.token_urlsafe(32)
        now = int(_now())
        with self._lock:
            sessions = self._data.setdefault("sessions", {})
            for key in [k for k, v in sessions.items() if int((v or {}).get("expires") or 0) < now]:
                sessions.pop(key, None)
            if len(sessions) >= 200:
                oldest = sorted(sessions.items(), key=lambda item: int((item[1] or {}).get("lastSeen") or 0))
                for key, _value in oldest[: len(sessions) - 199]:
                    sessions.pop(key, None)
            sessions[_hash_token(token)] = {"created": now, "lastSeen": now, "expires": now + SESSION_TTL_SEC}
            self._save()
        return token

    def session_valid(self, token: str) -> bool:
        if not token:
            return False
        now = int(_now())
        with self._lock:
            record = (self._data.get("sessions") or {}).get(_hash_token(token))
            if not isinstance(record, dict) or int(record.get("expires") or 0) < now:
                return False
            if now - int(record.get("lastSeen") or 0) > 3600:
                record["lastSeen"] = now
                record["expires"] = now + SESSION_TTL_SEC
                try:
                    self._save()
                except OSError:
                    pass
            return True

    # ── recent passcode (changing an agent platform from a browser) ──────
    def confirm(self, token: str, passcode: str) -> int:
        """Mark this browser session as having just typed the passcode.

        Returns the time (epoch seconds) until which it counts as recent, or 0
        when the session or the passcode is wrong."""
        if not token or not self.check_passcode(passcode):
            return 0
        now = int(_now())
        with self._lock:
            record = (self._data.get("sessions") or {}).get(_hash_token(token))
            if not isinstance(record, dict) or int(record.get("expires") or 0) < now:
                return 0
            record["confirmedAt"] = now
            self._save()
        return now + RECENT_CONFIRM_SEC

    def confirmed_at(self, token: str) -> int:
        if not token:
            return 0
        with self._lock:
            record = (self._data.get("sessions") or {}).get(_hash_token(token))
            return int(record.get("confirmedAt") or 0) if isinstance(record, dict) else 0

    def recently_confirmed(self, token: str, window: int = RECENT_CONFIRM_SEC) -> bool:
        stamp = self.confirmed_at(token)
        return bool(stamp) and 0 <= int(_now()) - stamp <= int(window)

    def drop_session(self, token: str) -> None:
        if not token:
            return
        with self._lock:
            if (self._data.get("sessions") or {}).pop(_hash_token(token), None) is not None:
                self._save()

    def keep_only_session(self, token: str) -> None:
        with self._lock:
            sessions = self._data.get("sessions") or {}
            keep = _hash_token(token) if token else ""
            self._data["sessions"] = {k: v for k, v in sessions.items() if k == keep}
            self._save()

    # ── login rate limit ─────────────────────────────────────────────────
    def login_blocked(self, client: str) -> int:
        """Seconds the client must wait, or 0."""
        now = _now()
        with self._lock:
            recent = [t for t in self._failures.get(client, []) if now - t < LOGIN_WINDOW_SEC]
            self._failures[client] = recent
            if len(recent) >= LOGIN_MAX_FAILURES:
                return max(1, int(LOGIN_WINDOW_SEC - (now - recent[0])))
            return 0

    def note_login_failure(self, client: str) -> None:
        with self._lock:
            self._failures.setdefault(client, []).append(_now())
            if len(self._failures) > 1000:
                self._failures = dict(list(self._failures.items())[-500:])

    def note_login_success(self, client: str) -> None:
        with self._lock:
            self._failures.pop(client, None)


class RequestAccess:
    """Access facts for one request."""

    __slots__ = ("protected", "via_loopback", "via_token", "via_session", "session_token")

    def __init__(self, protected, via_loopback, via_token, via_session, session_token):
        self.protected = protected
        self.via_loopback = via_loopback
        self.via_token = via_token
        self.via_session = via_session
        self.session_token = session_token

    @property
    def authenticated(self) -> bool:
        return (not self.protected) or self.via_loopback or self.via_token or self.via_session

    @property
    def can_manage(self) -> bool:
        # Agents (token) may use the API but never change the office passcode.
        return (not self.protected) or self.via_loopback or self.via_session

    @property
    def as_agent(self) -> bool:
        """With a passcode set, the caller is an agent: it sent the agent API token and no person signed in.
        Agents use the API but cannot change the office's settings (the same rule as the Agent Providers routes).
        Without a passcode the office is open and this is never true."""
        return bool(self.protected and self.via_token and not self.via_session)

    def status(self) -> dict:
        return {
            "protected": bool(self.protected),
            "authenticated": bool(self.authenticated),
            "viaLoopback": bool(self.via_loopback),
            "canManage": bool(self.can_manage),
        }


def trusted_local_ips(env=None) -> set[str]:
    """Extra client addresses treated as "this machine" (opt-in, VO_TRUSTED_CLIENT_IPS).

    With Docker's bridge network on Linux, the host's own requests (local agents
    calling http://127.0.0.1:<port>) arrive from the bridge gateway, for example
    172.17.0.1. Do not set this on Docker Desktop, where every device shares it.
    """
    env = env if env is not None else os.environ
    return {item.strip() for item in str(env.get("VO_TRUSTED_CLIENT_IPS") or "").split(",") if item.strip()}


def evaluate(store: AccessStore, client_ip: str, headers, trusted_ips=None) -> RequestAccess:
    forwarded = any(headers.get(name) for name in ("X-Forwarded-For", "Forwarded", "X-Real-IP"))
    trusted = trusted_ips if trusted_ips is not None else trusted_local_ips()
    via_loopback = (
        (is_loopback_ip(client_ip) or str(client_ip or "") in trusted)
        and not forwarded
        and (not headers.get("Host") or is_local_hostname(split_host(headers.get("Host"))))
    )
    protected = store.protected
    token = request_token(headers)
    via_token = bool(token) and store.token_valid(token)
    session_token = cookie_value(headers, SESSION_COOKIE)
    via_session = bool(protected and session_token and store.session_valid(session_token))
    return RequestAccess(protected, via_loopback, via_token, via_session, session_token)


def session_cookie_header(token: str, secure: bool = False, clear: bool = False) -> str:
    parts = [f"{SESSION_COOKIE}={'' if clear else token}", "Path=/", "HttpOnly", "SameSite=Lax"]
    parts.append("Max-Age=0" if clear else f"Max-Age={SESSION_TTL_SEC}")
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def safe_next_path(value: str) -> str:
    """Only same-site relative paths are allowed as a post-login target."""
    value = str(value or "")
    # Browsers drop tabs/newlines and read "\\" as "/", so "/\t/evil" would become "//evil".
    if any(ord(ch) <= 0x20 or ord(ch) == 0x7F for ch in value) or "\\" in value:
        return "/"
    if not value.startswith("/") or value.startswith("//"):
        return "/"
    parts = urllib.parse.urlsplit(value)
    if parts.scheme or parts.netloc:
        return "/"
    return value[:1000]
