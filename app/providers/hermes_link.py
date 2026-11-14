"""One live link to a Hermes backend (`hermes serve` / `hermes dashboard`), the way Hermes' own apps connect to it.

- Gateway JSON-RPC over WebSocket (`/api/ws`): newline-delimited JSON-RPC 2.0 both ways, `gateway.ready` first. Events
  are `{method: 'event', params: {type, session_id, payload, seq}}`; Hermes' own requests to the client (approvals,
  questions, masked prompts) carry an id and are answered with a response of that id. Once per socket the client says
  it answers them (`client.capabilities`), as Hermes requires; a heartbeat (`gateway.ping` every 15 s, any frame
  counting) when `gateway.ready` offers one; reconnects with a jittered growing delay.
- REST beside it (`/api/...`) with the same credential.
- Signing in: the backend's session token (a backend bound to its own machine), or a username and password through
  Hermes' native-app flow (RFC 8252: `/auth/native/authorize` with a PKCE challenge, the password form,
  `/auth/native/token`); the tokens are handed to `persist`, the password is then forgotten, the access token renewed
  with `/auth/native/refresh` 60 s before it expires.

Threading: every link lives on one shared asyncio loop thread. HTTP handler threads use the sync methods (`call`,
`rest`, `respond`, `settle`, `close`), which hand work to the loop with a timeout. Code running ON the loop thread (event
and request callbacks) must never call the sync `call()` (it raises); it awaits `acall()` instead, and runs `rest()` in
a worker (`await asyncio.to_thread(link.rest, ...)`).
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import hashlib
import http.client
import inspect
import json
import logging
import os
import random
import ssl
import threading
import time
import urllib.parse
from collections import OrderedDict

from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed, InvalidHandshake, InvalidStatus

LOG = logging.getLogger("vo.hermes.link")

KIND = "hermes"
WAIT_S = 10.0                                   # a call made while the link (re)connects waits this long for it
CALL_S = 30.0                                   # a call's own answer
HEARTBEAT_S, HEARTBEAT_DEADLINE_S = 15.0, 45.0  # Hermes' own clients' values
BACKOFF_BASE_S, BACKOFF_CAP_S, BACKOFF_MIN_S, STABLE_OPEN_S = 0.3, 15.0, 0.25, 5.0
REFRESH_EARLY_S = 60                            # an access token is renewed this long before it expires
NATIVE_REDIRECT = "http://127.0.0.1:9/virtual-office/signed-in"   # never dialled: the code is read from the answer
MAX_FRAME = 64 * 1024 * 1024
SERVER_REQUESTS = ("approval", "clarify", "secret", "sudo")
ANSWER_LATER = object()   # an on_request result meaning "a person answers later, through respond()"

FIX_ADDRESS = "Enter the address of your Hermes backend (Edit)."
FIX_TOKEN = ("Start Hermes with a session token of your own (HERMES_DASHBOARD_SESSION_TOKEN) and enter it here "
             "(Edit).")
FIX_PASSWORD = "Enter the username and password of Hermes' sign-in (Edit)."
FIX_UNREACHABLE = ("Check that `hermes serve` (or `hermes dashboard`) is running at this address; it keeps trying by "
                   "itself.")
FIX_HOST = ("Hermes only answers to the host it listens on (its DNS-rebinding guard): use that address, or declare "
            "this one as its dashboard.public_url.")
FIX_NOT_HERMES = "The address is the one `hermes serve` or `hermes dashboard` prints when it starts."
FIX_SIGNIN_NOT_ENGAGED = ('Choose "Session token" (Edit): a Hermes that listens only on its own machine accepts only its '
                          "session token (start it with HERMES_DASHBOARD_SESSION_TOKEN and enter the same).")
FIX_SIGNIN_ENGAGED = ('Choose "Username and password" (Edit): Hermes engages its sign-in when it listens beyond its own '
                      "machine.")
FIX_AUTH_REJECTED = ("Hermes makes a new session token every time it starts unless it is started with "
                     "HERMES_DASHBOARD_SESSION_TOKEN; start it with yours and enter the same here (Edit).")
FIX_REQUEST_REFUSED = ("A Hermes backend bound to its own machine answers only callers on that machine. From elsewhere "
                       "(another computer, a container) start it on an address they can reach, which engages its "
                       "sign-in (username and password).")
FIX_NO_PASSWORD = ("Set HERMES_DASHBOARD_BASIC_AUTH_USERNAME and _PASSWORD for Hermes (its username/password provider), "
                   "or use a session token.")
FIX_BAD_CREDENTIALS = "Check the username and password of Hermes' sign-in (Edit)."
FIX_RATE_LIMITED = "Wait a minute; Hermes limits sign-ins."
FIX_SIGNIN_NEEDED = "Enter the password of Hermes' sign-in again (Edit)."


class HermesError(Exception):
    """A refusal or failure with a code the pages understand, a detail and (when a person can act) a fix."""

    def __init__(self, code: str, message: str, fix: str | None = None, *, rpc_code=None, http_status=None,
                 data=None):
        super().__init__(message)
        self.code, self.detail, self.fix = code, message, fix
        self.rpc_code, self.http_status, self.data = rpc_code, http_status, data

    def to_dict(self) -> dict:
        return {k: v for k, v in {"code": self.code, "detail": self.detail, "fix": self.fix}.items() if v is not None}


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def bases(url: str) -> dict:
    """The backend's web address (its path kept: a backend behind a proxy prefix) and its socket's."""
    u = urllib.parse.urlsplit(str(url or "").strip())
    if u.scheme not in ("http", "https") or not u.netloc:
        raise HermesError("bad_url", "The address starts with http:// or https://", FIX_ADDRESS)
    path = u.path.rstrip("/")
    return {"http": f"{u.scheme}://{u.netloc}{path}",
            "ws": f"{'wss' if u.scheme == 'https' else 'ws'}://{u.netloc}{path}/api/ws"}


def _tokens_of(config: dict, secrets: dict) -> dict | None:
    raw = (secrets or {}).get("tokens")
    if not raw:
        return None
    try:
        t = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except (TypeError, ValueError):
        return None   # unreadable: sign in again
    # (tokens issued to another username, after the username changed: not these)
    if not isinstance(t, dict) or not t.get("access") or str(t.get("user") or "") != str(config.get("username") or ""):
        return None
    return t


def link_key(config: dict, secrets: dict | None) -> str:
    """What a link is built from: the address, how it signs in and the credential. Same key = keep the live socket."""
    config, secrets = config or {}, secrets or {}
    auth = "password" if config.get("auth") == "password" else "token"
    if auth == "token":
        cred = f"t:{secrets.get('token') or ''}"
    else:
        pw = secrets.get("password")
        cred = (f"p:{config.get('username') or ''}:{_sha(pw) if pw else ''}:"
                f"{'tokens' if _tokens_of(config, secrets) else ''}")
    return _sha(json.dumps([config.get("url"), auth, cred]))


class _Resp:
    __slots__ = ("status", "headers", "body")

    def __init__(self, status: int, headers: list, body: bytes):
        self.status, self.headers, self.body = status, headers, body

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def header(self, name: str) -> str:
        name = name.lower()
        return next((v for k, v in self.headers if k.lower() == name), "")

    @property
    def content_type(self) -> str:
        return self.header("content-type") or "application/octet-stream"

    def cookies(self) -> str:
        """The cookies this answer sets, as one Cookie header (only their names and values)."""
        pairs = [v.split(";", 1)[0].strip() for k, v in self.headers if k.lower() == "set-cookie"]
        return "; ".join(c for c in pairs if "=" in c and not c.startswith("="))

    def json(self):
        try:
            return json.loads(self.body or b"null")
        except ValueError:
            return None

    def detail(self) -> str:
        j = self.json()
        d = isinstance(j, dict) and (j.get("detail") or j.get("error") or j.get("message"))
        return str(d)[:300] if isinstance(d, str) else ""


def _http(method: str, url: str, headers: dict | None = None, body: bytes | None = None, timeout: float = 15.0,
          max_bytes: int | None = None) -> _Resp:
    """One HTTP request, redirects NOT followed (the sign-in reads its own 302). Raises OSError/TimeoutError."""
    u = urllib.parse.urlsplit(url)
    if u.scheme == "https":
        conn = http.client.HTTPSConnection(u.hostname, u.port, timeout=timeout, context=ssl.create_default_context())
    else:
        conn = http.client.HTTPConnection(u.hostname, u.port, timeout=timeout)
    try:
        conn.request(method, (u.path or "/") + (f"?{u.query}" if u.query else ""), body=body, headers=headers or {})
        r = conn.getresponse()
        data = r.read(max_bytes + 1) if max_bytes else r.read()
        if max_bytes and len(data) > max_bytes:
            raise HermesError("too_large", "The file is larger than the office takes from Hermes")
        return _Resp(r.status, r.getheaders(), data)
    except http.client.HTTPException as exc:
        raise ConnectionError(str(exc)) from exc
    finally:
        conn.close()


class _SharedLoop:
    _lock = threading.Lock()
    _loop: asyncio.AbstractEventLoop | None = None

    @classmethod
    def get(cls) -> asyncio.AbstractEventLoop:
        with cls._lock:
            if cls._loop is None or cls._loop.is_closed():
                loop = asyncio.new_event_loop()
                threading.Thread(target=loop.run_forever, name="hermes-links", daemon=True).start()
                cls._loop = loop
            return cls._loop


def probe(url: str, timeout: float = 2.5) -> bool:
    """Whether a Hermes backend answers at an http(s):// address (its public status page; nothing is signed in)."""
    try:
        r = _http("GET", f"{bases(url)['http']}/api/status", timeout=timeout)
        j = r.json() if r.ok else None
        return isinstance(j, dict) and isinstance(j.get("version"), str) and "auth_required" in j
    except (HermesError, OSError):
        return False


class HermesLink:
    """One connection's live link. Construct, register callbacks, then start()."""

    def __init__(self, cid: str, config: dict, secrets: dict | None = None, persist=None, *, loop=None):
        self.cid = str(cid)
        self._persist = persist
        self._loop = loop or _SharedLoop.get()
        self._lock = threading.RLock()        # seen / hold / status
        self._auth_lock = threading.Lock()    # one sign-in or renewal at a time
        self._status: dict = {"state": "offline"}
        self._event_cbs: list = []
        self._status_cbs: list = []
        self._ready_cbs: list = []
        self._down_cbs: list = []
        self._request_cb = None
        self.heartbeat_s, self.heartbeat_deadline_s = HEARTBEAT_S, HEARTBEAT_DEADLINE_S
        self.key: str | None = None
        self.active = False
        self.gen = 0           # the socket's generation (a server request's answer goes back on the same one)
        self._run = 0          # the supervisor's identity (stale ones stop)
        self._task = None
        self._beat = None
        self.ws = None
        self.ready = False
        self.info: dict | None = None
        self.server_requests: list = []
        self.epoch = None
        self.restarts = 0                 # times Hermes came back with another replay epoch (it restarted)
        self.seen: OrderedDict = OrderedDict()
        self.hold: dict = {}
        self._pending: dict = {}
        self._waiters: list = []
        self._next_id = 1
        self._caps_gen = -1
        self.attempt = 0
        self._last_in = 0.0
        self.base: dict | None = None
        self._buf = ""
        self._apply(config or {}, secrets or {})

    # ------------------------------------------------------------------ callbacks
    def on_event(self, cb) -> None:
        """cb(params) on the loop thread for every Hermes event (each numbered event once)."""
        self._event_cbs.append(cb)

    def on_request(self, cb) -> None:
        """cb({id, method, params, generation}) on the loop thread for approval/clarify/secret/sudo; returns the result,
        None to refuse (-32601), or ANSWER_LATER (then respond()). May be a coroutine function."""
        self._request_cb = cb

    def on_status(self, cb) -> None:
        """cb({type:'provider.status', kind, connectionId, state, code, detail, fix, version}) on every change."""
        self._status_cbs.append(cb)

    def on_ready(self, cb) -> None:
        self._ready_cbs.append(cb)

    def on_down(self, cb) -> None:
        """cb() when a connected socket is lost (the adapter ends or replays its runs)."""
        self._down_cbs.append(cb)

    # ------------------------------------------------------------------ settings
    @staticmethod
    def key_for(config: dict, secrets: dict | None) -> str:
        return link_key(config, secrets)

    def _apply(self, config: dict, secrets: dict) -> None:
        auth = "password" if config.get("auth") == "password" else "token"
        tokens = _tokens_of(config, secrets) if auth == "password" else None
        old = getattr(self, "tokens", None)
        # (tokens Hermes renewed since the server last stored them: the newer ones stay)
        if tokens and old and old.get("refresh") != tokens.get("refresh") and \
                (old.get("expiresAt") or 0) >= (tokens.get("expiresAt") or 0):
            tokens = old
        self.key = link_key(config, secrets)
        self.url = str(config.get("url") or "")
        self.auth = auth
        self.username = str(config.get("username") or "")
        self.token = str(secrets.get("token") or "") if auth == "token" else ""
        self.password = str(secrets.get("password") or "") if auth == "password" else ""
        self.tokens = tokens
        self.attempt = 0

    def configure(self, config: dict, secrets: dict | None = None) -> bool:
        """Keeps the live socket when nothing it is built from changed (False); else rebuilds it (True)."""
        if link_key(config or {}, secrets or {}) == self.key and self.active:
            return False
        self._stop_sync()
        self._apply(config or {}, secrets or {})
        self.start()
        return True

    def _save(self, field: str, value) -> None:
        if self._persist:
            try:
                self._persist(self.cid, field, value)
            except Exception:  # noqa: BLE001 - the store refused; the link keeps working from memory
                LOG.warning("hermes link %s: could not store %s", self.cid, field)

    # ------------------------------------------------------------------ state
    @property
    def connected(self) -> bool:
        return self._status.get("state") == "connected" and self.ready

    def status(self) -> dict:
        with self._lock:
            return dict(self._status)

    def snapshot(self) -> dict:
        i = self.info
        hermes = None
        if i:
            hermes = {"version": i.get("version"), "release": i.get("release_date"),
                      "signIn": bool(i.get("auth_required")),
                      "profiles": len(i["profiles"]) if isinstance(i.get("profiles"), list) else None}
        return {**self.status(), "hermes": hermes, "serverRequests": list(self.server_requests)}

    def _set_status(self, **s) -> None:
        nxt = {k: v for k, v in s.items() if v is not None}
        with self._lock:
            same = all(nxt.get(k) == self._status.get(k) for k in ("state", "code", "detail", "version"))
            self._status = nxt
        if nxt.get("state") == "error":
            self._fail_waiters_threadsafe()
        if not same:
            evt = {"type": "provider.status", "kind": KIND, "connectionId": self.cid, **nxt}
            for cb in list(self._status_cbs):
                try:
                    cb(evt)
                except Exception:  # noqa: BLE001
                    LOG.exception("hermes link status listener failed")

    def _in_loop(self) -> bool:
        try:
            return asyncio.get_running_loop() is self._loop
        except RuntimeError:
            return False

    def _fail_waiters_threadsafe(self) -> None:
        if self._in_loop():
            self._fail_waiters()
        elif not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._fail_waiters)

    def _fail_waiters(self) -> None:
        s = self._status
        for w in self._waiters[:]:
            if not w.done():
                w.set_exception(HermesError("not_connected", s.get("detail") or "Hermes is not connected",
                                            s.get("fix")))
        self._waiters.clear()

    async def when_connected(self, wait: float = WAIT_S) -> None:
        """Returns when connected; raises at once if a person must act first, or after `wait` seconds."""
        if self.connected:
            return
        s = self._status
        if s.get("state") == "error" or not self.active:
            raise HermesError("not_connected", s.get("detail") or "Hermes is not connected", s.get("fix"))
        fut = self._loop.create_future()
        self._waiters.append(fut)
        try:
            await asyncio.wait_for(fut, wait)
        except asyncio.TimeoutError:
            raise HermesError("timeout", "Hermes did not answer in time", self._status.get("fix")) from None
        finally:
            if fut in self._waiters:
                self._waiters.remove(fut)

    def _sync(self, coro, timeout: float):
        if self._in_loop():
            coro.close()
            raise RuntimeError("a sync HermesLink method was called on its own loop thread (it would deadlock); "
                               "await the async form")
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return fut.result(timeout)
        except concurrent.futures.TimeoutError:
            fut.cancel()
            raise HermesError("timeout", "Hermes did not answer in time") from None

    def settle(self, wait: float = WAIT_S) -> dict:
        """Waits until the state settles (connected, or what is wrong) or `wait` passes: what a Test shows."""
        async def go():
            try:
                await self.when_connected(wait)
            except HermesError:
                pass
        self._sync(go(), wait + 5)
        return self.status()

    # ------------------------------------------------------------------ signing in (sync; any thread but the loop's)
    def credential(self) -> str:
        """The credential now: the session token, or a current access token (signed in, or renewed)."""
        if self.auth == "token":
            return self.token
        with self._auth_lock:
            t = self.tokens
            if t and t.get("access") and (not t.get("expiresAt") or t["expiresAt"] - REFRESH_EARLY_S > time.time()):
                return t["access"]
            if t and t.get("refresh"):
                access = self._renew()
                if access:
                    return access
            if self.username and self.password:
                return self._sign_in()
            raise HermesError("signin_needed", "Hermes asks to sign in again", FIX_SIGNIN_NEEDED)

    def _keep_tokens(self, j: dict) -> None:
        self.tokens = {"access": str(j["access_token"]), "refresh": str(j.get("refresh_token") or ""),
                       "expiresAt": float(j.get("expires_at") or 0), "provider": str(j.get("provider") or ""),
                       "user": self.username}
        self._save("tokens", json.dumps(self.tokens))

    def _post(self, path: str, body: dict, cookie: str = "", timeout: float = 15.0) -> _Resp:
        headers = {"content-type": "application/json"}
        if cookie:
            headers["cookie"] = cookie
        try:
            return _http("POST", self.base["http"] + path, headers, json.dumps(body).encode(), timeout)
        except OSError:
            raise HermesError("unreachable", "Hermes is not answering") from None

    def _renew(self) -> str | None:
        """Renews the access token with the refresh token; None when Hermes refuses it (then: sign in again)."""
        r = self._post("/auth/native/refresh", {"refresh_token": self.tokens.get("refresh"),
                                                 "provider": self.tokens.get("provider") or ""})
        if r.status == 503:
            raise HermesError("unreachable", "Hermes' sign-in service is not answering")
        j = r.json() if r.ok else None
        if not isinstance(j, dict) or not j.get("access_token"):
            self.tokens = None
            self._save("tokens", None)
            return None
        self._keep_tokens(j)
        return self.tokens["access"]

    def _password_providers(self) -> list:
        try:
            r = _http("GET", self.base["http"] + "/api/auth/providers", timeout=8)
            j = r.json() if r.ok else None
            rows = j if isinstance(j, list) else (j.get("providers") if isinstance(j, dict) else None) or []
            names = [str(p.get("name") or p.get("id")) for p in rows if isinstance(p, dict) and (
                p.get("supports_password") or p.get("password") or p.get("kind") == "password"
                or p.get("type") == "password")]
            if names:
                return names
        except OSError:
            pass   # the status page says it too
        st = self.info or {}
        return [n for n in (st.get("auth_providers") or []) if n == "basic"]

    def _sign_in(self) -> str:
        """Hermes' native-app sign-in: PKCE challenge, the password form, the code exchanged for tokens; the password
        is then forgotten (the stored copy too)."""
        providers = self._password_providers()
        if not providers:
            raise HermesError("no_password_signin", "This Hermes has no username-and-password sign-in", FIX_NO_PASSWORD)
        verifier = _b64url(os.urandom(32))
        challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
        state = _b64url(os.urandom(12))
        q = urllib.parse.urlencode({"provider": providers[0], "code_challenge": challenge,
                                    "code_challenge_method": "S256", "redirect_uri": NATIVE_REDIRECT, "state": state})
        try:
            r = _http("GET", f"{self.base['http']}/auth/native/authorize?{q}", timeout=15)
        except OSError:
            raise HermesError("unreachable", "Hermes is not answering") from None
        cookie = r.cookies()
        if r.status >= 400 or not cookie:
            raise HermesError("signin_refused", f"Hermes did not start a sign-in ({r.detail() or r.status})")
        r = self._post("/auth/password-login", {"provider": providers[0], "username": self.username,
                                                 "password": self.password}, cookie)
        if r.status == 401:
            raise HermesError("bad_credentials", "Hermes refused the username or password", FIX_BAD_CREDENTIALS)
        if r.status == 429:
            raise HermesError("rate_limited", "Too many sign-in attempts", FIX_RATE_LIMITED)
        if not r.ok:
            raise HermesError("signin_refused", f"Hermes refused the sign-in ({r.detail() or r.status})")
        login = r.json() if isinstance(r.json(), dict) else {}
        nxt = urllib.parse.urlsplit(str(login.get("next") or ""))
        qs = urllib.parse.parse_qs(nxt.query)
        code = (qs.get("code") or [""])[0]
        if not code or (qs.get("state") or [""])[0] != state:
            raise HermesError("signin_refused", "Hermes did not hand back a sign-in code")
        r = self._post("/auth/native/token", {"code": code, "code_verifier": verifier})
        j = r.json() if r.ok else None
        if not isinstance(j, dict) or not j.get("access_token"):
            raise HermesError("signin_refused", "Hermes did not issue a sign-in token")
        self._keep_tokens(j)
        # (signed in: the password is handed off; the link now counts as built from the tokens)
        self._save("password", None)
        self.password = ""
        self.key = _sha(json.dumps([self.url, self.auth, f"p:{self.username}::tokens"]))
        return self.tokens["access"]

    def auth_headers(self) -> dict:
        c = self.credential()
        return {"x-hermes-session-token": c} if self.auth == "token" else {"authorization": f"Bearer {c}"}

    def _status_page(self) -> dict:
        try:
            r = _http("GET", self.base["http"] + "/api/status", timeout=8)
        except TimeoutError:
            raise HermesError("timeout", "Hermes is not answering") from None
        except OSError:
            raise HermesError("unreachable", "Hermes is not answering") from None
        if r.status in (400, 421):
            raise HermesError("host_refused", "Hermes refused this address as its host", FIX_HOST)
        if not r.ok:
            raise HermesError("not_hermes", f"No Hermes backend answered here ({r.status})", FIX_NOT_HERMES)
        j = r.json()
        if not isinstance(j, dict) or not isinstance(j.get("version"), str):
            raise HermesError("not_hermes", "No Hermes backend answered here", FIX_NOT_HERMES)
        if self.auth == "token" and j.get("auth_required"):
            raise HermesError("signin_engaged", "This Hermes asks to sign in with a username and password",
                              FIX_SIGNIN_ENGAGED)
        # (a Hermes bound to its own machine runs its sign-in pass-through: it may issue tokens, but its REST and socket
        # take only the session token, so a password connection would retry forever)
        if self.auth == "password" and j.get("auth_required") is False:
            raise HermesError("signin_not_engaged", "This Hermes does not use its sign-in (it listens only on its own "
                              "machine)", FIX_SIGNIN_NOT_ENGAGED)
        return j

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> "HermesLink":
        self.active = True
        try:
            self.base = bases(self.url)
        except HermesError as e:
            self.base = None
            self._set_status(state="error", code="not_configured",
                             detail="The Hermes address is not set." if not self.url else e.detail, fix=FIX_ADDRESS)
            return self
        missing = not self.token if self.auth == "token" else not self.tokens and not (self.username and self.password)
        if missing:
            self._set_status(state="error", code="not_configured",
                             detail="The session token is not set." if self.auth == "token"
                             else "The username and password are not set.",
                             fix=FIX_TOKEN if self.auth == "token" else FIX_PASSWORD)
            return self
        self._set_status(state="connecting", detail="Connecting to Hermes...")
        self._run += 1
        run = self._run
        self._loop.call_soon_threadsafe(lambda: self._spawn(run))
        return self

    def _spawn(self, run: int) -> None:
        if run == self._run and self.active:
            self._task = self._loop.create_task(self._supervise(run))

    async def _astop(self) -> None:
        self.gen += 1
        for t in (self._task, self._beat):
            if t and not t.done() and t is not asyncio.current_task():
                t.cancel()
        self._task = self._beat = None
        ws, self.ws, self.ready = self.ws, None, False
        self._fail_pending("The connection to Hermes was closed")
        self._fail_waiters()
        if ws is not None:
            try:
                await asyncio.wait_for(ws.close(1000), 1.5)
            except Exception:  # noqa: BLE001
                try:
                    ws.transport.abort()
                except Exception:  # noqa: BLE001
                    pass

    def _stop_sync(self) -> None:
        self._run += 1   # (the running supervisor stops at its next check; start() makes a new one)
        if self._in_loop():
            self._loop.create_task(self._astop())
        elif not self._loop.is_closed():
            try:
                self._sync(self._astop(), 5)
            except HermesError:
                pass

    def close(self, reason: str | None = None) -> None:
        """Stops the link for good (removed, switched off, settings changed, server stop)."""
        self.active = False
        self.key = None
        self._stop_sync()
        with self._lock:
            self._status = {"state": "offline"}

    async def _supervise(self, run: int) -> None:
        while run == self._run and self.active:
            opened_at = None
            try:
                self.info = await asyncio.to_thread(self._status_page)
                if run != self._run:
                    return
                cred = await asyncio.to_thread(self.credential)
            except HermesError as e:
                if run != self._run:
                    return
                if e.code in ("unreachable", "timeout"):
                    self._set_status(state="offline", code="unreachable", detail="Hermes is not answering.",
                                     fix=FIX_UNREACHABLE)
                    await self._backoff(None)
                    continue
                self._set_status(state="error", code=e.code or "signin_refused", detail=e.detail, fix=e.fix)
                return
            except Exception:  # noqa: BLE001 - never a dead supervisor: say it and try again
                LOG.exception("hermes link %s: connecting failed", self.cid)
                if run != self._run:
                    return
                self._set_status(state="offline", code="unreachable", detail="Hermes is not answering.",
                                 fix=FIX_UNREACHABLE)
                await self._backoff(None)
                continue
            if run != self._run:
                return
            self.gen += 1
            gen = self.gen
            try:
                ws = await ws_connect(f"{self.base['ws']}?token={urllib.parse.quote(cred, safe='')}",
                                      open_timeout=10, max_size=MAX_FRAME, compression=None, ping_interval=None,
                                      close_timeout=2)
            except InvalidStatus as e:
                code = getattr(e.response, "status_code", 0)
                if run != self._run:
                    return
                if code in (401, 403):
                    # (a refused access token: renewed by the next attempt; a refused session token: a person fixes it)
                    if self.auth == "password" and self.tokens:
                        self.tokens = {**self.tokens, "expiresAt": 1}
                        await self._backoff(None)
                        continue
                    self._set_status(state="error", code="auth_rejected", detail="Hermes refused the session token.",
                                     fix=FIX_AUTH_REJECTED)
                    return
                await self._backoff(None)
                continue
            except (OSError, asyncio.TimeoutError, InvalidHandshake) as e:
                if run != self._run:
                    return
                LOG.debug("hermes link %s: socket did not open: %s", self.cid, e)
                await self._backoff(None)
                continue
            if run != self._run:
                await ws.close()
                return
            self.ws, self.ready, opened_at, self._buf = ws, False, time.monotonic(), ""
            self._last_in = time.monotonic()
            code = await self._read(ws, gen)
            if run != self._run:
                return
            was = self.connected
            self.ws, self.ready = None, False
            if self._beat:
                self._beat.cancel()
                self._beat = None
            self._fail_pending("The connection to Hermes was lost")
            if was:
                for cb in list(self._down_cbs):
                    try:
                        cb()
                    except Exception:  # noqa: BLE001
                        LOG.exception("hermes link down listener failed")
            # (Hermes' own close codes: 4401 the credential, 4403 its request guard: the host, the peer or the origin)
            if code == 4401:
                if self.auth == "password" and self.tokens:
                    self.tokens = {**self.tokens, "expiresAt": 1}
                    await self._backoff(opened_at)
                    continue
                self._set_status(state="error", code="auth_rejected", detail="Hermes refused the session token.",
                                 fix=FIX_AUTH_REJECTED)
                return
            if code == 4403:
                self._set_status(state="error", code="request_refused",
                                 detail="Hermes refused this connection (its request guard).", fix=FIX_REQUEST_REFUSED)
                return
            self._set_status(state="offline", code="closed",
                             detail="The connection to Hermes was lost; reconnecting..." if was
                             else "Hermes is not answering; trying again...")
            await self._backoff(opened_at)

    async def _backoff(self, opened_at) -> None:
        """Waits a jittered, growing delay (a socket that opened and died within seconds counts as failed)."""
        if opened_at and time.monotonic() - opened_at >= STABLE_OPEN_S:
            self.attempt = 0
        ceiling = min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** min(self.attempt, 16))
        self.attempt += 1
        if self._status.get("state") == "connecting":
            self._set_status(state="offline", code="unreachable", detail="Hermes is not answering; trying again...",
                             fix=FIX_UNREACHABLE)
        await asyncio.sleep(max(BACKOFF_MIN_S, random.random() * ceiling))

    async def _read(self, ws, gen: int) -> int:
        try:
            async for msg in ws:
                if gen != self.gen:
                    break
                self._on_data(msg if isinstance(msg, str) else msg.decode("utf-8", "replace"))
        except ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001
            LOG.exception("hermes link %s: reading the socket failed", self.cid)
        try:
            await asyncio.wait_for(ws.wait_closed(), 2)
        except Exception:  # noqa: BLE001
            pass
        return ws.close_code or 1006

    def _fail_pending(self, why: str) -> None:
        pending, self._pending = self._pending, {}
        for fut in pending.values():
            if not fut.done():
                fut.set_exception(HermesError("not_connected", why))

    # ------------------------------------------------------------------ frames
    def _on_data(self, text: str) -> None:
        self._last_in = time.monotonic()
        lines = (self._buf + text).split("\n")
        self._buf = lines.pop()
        if len(self._buf) > MAX_FRAME:
            self._buf = ""
        for line in lines:
            if line.strip():
                try:
                    self._on_frame(json.loads(line))
                except ValueError:
                    continue
        if self._buf.strip():
            try:
                f = json.loads(self._buf)
            except ValueError:
                return   # a frame split across messages
            self._buf = ""
            self._on_frame(f)

    def _on_frame(self, f) -> None:
        if not isinstance(f, dict):
            return
        p = f.get("params")
        if f.get("method") == "event" and isinstance(p, dict) and isinstance(p.get("type"), str):
            if p["type"] == "gateway.ready":
                self._loop.create_task(self._on_gateway_ready(p.get("payload") or {}, self.gen))
                return
            sid, seq = str(p.get("session_id") or ""), p.get("seq")
            if sid and isinstance(seq, int) and not isinstance(seq, bool):
                with self._lock:
                    if sid in self.hold:
                        self.hold[sid].append(p)
                        return
                    if seq <= self.seen.get(sid, 0):
                        return   # (one already had: never twice)
                    self._note(sid, seq)
            self._deliver(p)
            return
        if f.get("method") and f.get("id") is not None:
            self._loop.create_task(self._on_server_request(f, self.gen))
            return
        rid = f.get("id")
        fut = self._pending.pop(str(rid), None) if rid is not None else None
        if fut is None or fut.done():
            return
        err = f.get("error")
        if err:
            err = err if isinstance(err, dict) else {"message": str(err)}
            fut.set_exception(HermesError(f"hermes_{err.get('code', 'error')}",
                                          str(err.get("message") or "Hermes refused it")[:400],
                                          rpc_code=err.get("code"), data=err.get("data")))
        else:
            fut.set_result(f.get("result"))

    def _deliver(self, evt: dict) -> None:
        for cb in list(self._event_cbs):
            try:
                cb(evt)
            except Exception:  # noqa: BLE001 - one bad listener never stops the rest
                LOG.exception("hermes link event listener failed")

    def _note(self, sid: str, seq: int) -> None:
        self.seen.pop(sid, None)
        self.seen[sid] = seq
        while len(self.seen) > 500:
            self.seen.popitem(last=False)

    async def _on_gateway_ready(self, p: dict, gen: int) -> None:
        if gen != self.gen or self._caps_gen == gen:
            return
        self._caps_gen = gen
        # (Hermes restarted: its event numbers start again; none seen before can be fetched again)
        with self._lock:
            if self.epoch and p.get("replay_epoch") and p["replay_epoch"] != self.epoch:
                self.seen.clear()
                self.hold.clear()
                self.restarts += 1
            self.epoch = p.get("replay_epoch") or None
        try:
            # (Hermes fails every request it would send a client that never says it answers them)
            r = await self._rpc("client.capabilities", {"server_requests": True}, 10)
            self.server_requests = list(r.get("server_requests") or []) if isinstance(r, dict) else []
        except HermesError:
            self.server_requests = []
        if gen != self.gen:
            return
        self.ready = True
        if p.get("heartbeat") is True:
            self._beat = self._loop.create_task(self._heartbeat(gen, self.ws))
        v = (self.info or {}).get("version")
        self._set_status(state="connected", version=str(v) if v else None,
                         detail=f"Connected to Hermes {v}." if v else "Connected.")
        for w in self._waiters[:]:
            if not w.done():
                w.set_result(None)
        self._waiters.clear()
        for cb in list(self._ready_cbs):
            try:
                cb()
            except Exception:  # noqa: BLE001
                LOG.exception("hermes link ready listener failed")

    async def _heartbeat(self, gen: int, ws) -> None:
        self._last_in = time.monotonic()
        while gen == self.gen:
            await asyncio.sleep(self.heartbeat_s)
            if gen != self.gen:
                return
            if time.monotonic() - self._last_in >= self.heartbeat_deadline_s:
                try:
                    ws.transport.abort()
                except Exception:  # noqa: BLE001
                    pass
                return
            self._next_id += 1
            await self._asend({"jsonrpc": "2.0", "id": f"hb-{self._next_id}", "method": "gateway.ping", "params": {}})

    async def _on_server_request(self, f: dict, gen: int) -> None:
        """A request from Hermes: answered by the adapter (a result), later (respond()), or refused at once so the
        agent never waits for an answer nobody will give."""
        method, rid = str(f.get("method")), f.get("id")
        result = None
        if method in SERVER_REQUESTS and self._request_cb is not None:
            try:
                result = self._request_cb({"id": rid, "method": method, "params": f.get("params") or {},
                                           "generation": gen})
                if inspect.isawaitable(result):
                    result = await result
            except Exception:  # noqa: BLE001
                LOG.exception("hermes link request handler failed")
                result = None
        if result is ANSWER_LATER:
            return
        if gen != self.gen:
            return
        if result is None:
            await self._asend({"jsonrpc": "2.0", "id": rid,
                               "error": {"code": -32601, "message": f"{method} is not answered by the office"}})
        else:
            await self._asend({"jsonrpc": "2.0", "id": rid, "result": result})

    # ------------------------------------------------------------------ sending and calls
    async def _asend(self, obj: dict) -> bool:
        ws = self.ws
        if ws is None:
            return False
        try:
            await ws.send(json.dumps(obj))
            return True
        except Exception:  # noqa: BLE001 - the socket is gone
            return False

    async def arespond(self, rpc_id, result, generation: int | None = None) -> bool:
        if generation is not None and generation != self.gen:
            return False
        return await self._asend({"jsonrpc": "2.0", "id": rpc_id, "result": result})

    def respond(self, rpc_id, result, generation: int | None = None) -> bool:
        """Answers a request Hermes made on socket `generation`. False when that socket is gone (then the adapter uses
        approval.respond / request.answer)."""
        if generation is not None and generation != self.gen:
            return False
        if self._in_loop():
            if self.ws is None:
                return False
            self._loop.create_task(self.arespond(rpc_id, result, generation))
            return True
        try:
            return bool(self._sync(self.arespond(rpc_id, result, generation), 5))
        except HermesError:
            return False

    async def _rpc(self, method: str, params: dict, timeout: float = CALL_S):
        self._next_id += 1
        rid = f"m{self._next_id}"
        fut = self._loop.create_future()
        self._pending[rid] = fut
        if not await self._asend({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}):
            self._pending.pop(rid, None)
            raise HermesError("not_connected", "Hermes is not connected")
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise HermesError("timeout", f"Hermes did not answer {method} in time") from None
        finally:
            self._pending.pop(rid, None)

    async def acall(self, method: str, params: dict | None = None, timeout: float = CALL_S, wait: float = WAIT_S):
        """A JSON-RPC call once the link is connected (on the loop thread)."""
        await self.when_connected(wait)
        return await self._rpc(method, params or {}, timeout)

    def wait_connected(self, wait: float = WAIT_S) -> None:
        """Returns once connected (from any thread but the loop's); raises HermesError like a call would."""
        if not self.connected:
            self._sync(self.when_connected(wait), wait + 5)

    def call(self, method: str, params: dict | None = None, timeout: float = CALL_S, wait: float = WAIT_S):
        """A JSON-RPC call from any thread but the loop's; raises HermesError."""
        return self._sync(self.acall(method, params, timeout, wait), timeout + wait + 5)

    def rest(self, method: str, path: str, body=None, profile: str | None = None, *, query: dict | None = None,
             timeout: float = CALL_S, raw: bool = False, max_bytes: int | None = None):
        """A REST call beside the socket: the JSON answer, or with raw=True the _Resp (status, content_type, body).
        A refused access token is renewed once."""
        if not self.base:
            raise HermesError("not_connected", "Hermes is not configured")
        q = {k: str(v) for k, v in (query or {}).items() if v is not None}
        if profile:
            q["profile"] = profile
        url = self.base["http"] + path + (f"?{urllib.parse.urlencode(q)}" if q else "")
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(2):
            headers = self.auth_headers()
            if data is not None:
                headers["content-type"] = "application/json"
            try:
                r = _http(method, url, headers, data, timeout, max_bytes)
            except TimeoutError:
                raise HermesError("timeout", "Hermes took too long") from None
            except OSError:
                raise HermesError("unreachable", "Hermes is not answering") from None
            if r.status == 401 and self.auth == "password" and attempt == 0 and self.tokens:
                with self._auth_lock:
                    self.tokens = {**self.tokens, "expiresAt": 1}
                continue
            if raw:
                return r
            if not r.ok:
                code = {404: "not_found", 401: "auth_rejected", 503: "unavailable"}.get(r.status, "provider_error")
                raise HermesError(code, r.detail() or f"Hermes answered {r.status}", http_status=r.status)
            return r.json()
        raise HermesError("auth_rejected", "Hermes refused the sign-in")

    # ------------------------------------------------------------------ lossless reconnects (used by the adapter)
    def can_replay(self, sid) -> bool:
        with self._lock:
            return bool(sid) and str(sid) in self.seen

    def hold_for(self, sid) -> None:
        """Live events of the session wait from now until replay() or release(); set before re-attaching it."""
        with self._lock:
            self.hold.setdefault(str(sid), [])

    def release(self, sid) -> None:
        sid = str(sid)
        with self._lock:
            waiting = self.hold.pop(sid, [])
            out = []
            for e in waiting:
                seq = e.get("seq")
                if isinstance(seq, int):
                    if seq <= self.seen.get(sid, 0):
                        continue
                    self._note(sid, seq)
                out.append(e)
        for e in out:
            self._deliver(e)

    def forget(self, sid) -> None:
        with self._lock:
            self.seen.pop(str(sid), None)
            self.hold.pop(str(sid), None)

    async def areplay(self, sid) -> dict:
        """The events of a live session missed while the socket was down (session.events.since), delivered in order,
        then the live ones that waited, each once. Another replay epoch (Hermes restarted): {reset: True}."""
        sid = str(sid)
        with self._lock:
            last = self.seen.get(sid, 0)
        try:
            r = await self.acall("session.events.since", {"session_id": sid, "last_seen": last}, timeout=20)
        except HermesError as e:
            self.release(sid)
            return {"error": e.detail}
        r = r if isinstance(r, dict) else {}
        if r.get("epoch") and self.epoch and r["epoch"] != self.epoch:
            with self._lock:
                self.epoch = r["epoch"]
                self.seen.clear()
            self.release(sid)
            return {"reset": True}
        count = 0
        for e in r.get("events") or []:
            if not isinstance(e, dict) or not isinstance(e.get("seq"), int):
                continue
            with self._lock:
                if e["seq"] <= self.seen.get(sid, 0):
                    continue
                self._note(sid, e["seq"])
            self._deliver({**e, "session_id": e.get("session_id") or sid})
            count += 1
        self.release(sid)
        return {"count": count, "truncated": bool(r.get("truncated")),
                "open": r.get("open_requests") if isinstance(r.get("open_requests"), list) else []}

    def replay(self, sid) -> dict:
        return self._sync(self.areplay(sid), 35)
