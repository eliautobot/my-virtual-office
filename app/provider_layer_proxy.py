"""The office's OpenClaw and Hermes provider layer (app/provider-layer, from My Virtual World): process and proxy.

server.py starts ``node provider-layer/vo-host.mjs`` on a free loopback port, watches it (restarts with backoff,
0.5 s .. 30 s) and stops it on shutdown. Requests for the layer's paths pass through here after the office's own
checks (passcode, agent token, host, same origin): the request is forwarded as it is, with the caller named in
``X-VO-Principal`` (signed with this boot's secret, which vo-host reads from a 0600 file), and the answer is streamed
back (Range, Content-Disposition and CSP headers included). WebSocket upgrades for the layer's sockets are relayed
byte for byte. The layer's event bus arrives here as server-sent events (counted only, for now).

On by default (v0.11); ``VO_PROVIDER_LAYER=0`` (or false / no / off) keeps 0.10's Python OpenClaw and Hermes path for
one release (legacy).
"""

import base64
import hashlib
import hmac
import http.client
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse

import private_files
from data_owner import give_back   # (files an earlier start made as root: back to the data folder's owner)
import vo_access

MIN_NODE = (22, 19, 0)
# (vo-migrate.mjs: the office's 0.10 files its first start reads, and the report it writes into the layer's folder)
MIGRATE_SOURCES = ("agent-providers.json", "provider-secrets.json", "vo-config.json", "openclaw-device.json",
                   "provider-agents-cache.json")
MIGRATE_REPORT = "vo-migrate.json"
NODE_MESSAGE = "Needs Node.js 22.19 or newer (24 recommended). Install it from nodejs.org, then restart the office."
APP_DIR = os.path.dirname(os.path.abspath(__file__))
LAYER_DIR = os.path.join(APP_DIR, "provider-layer")
PRINCIPAL_HEADER = "X-VO-Principal"
WS_PATHS = {"/api/pl/ws", "/api/providers/screen/ws"}
# The layer's own paths (My Virtual World's client asks for them as they are). /api/pl/internal/* is never relayed.
_EXACT = {"/api/providers", "/api/agent-providers", "/api/connections", "/api/chat-sessions", "/api/chat-references"}
_PREFIXES = ("/api/providers/", "/api/agent-providers/", "/api/connections/", "/api/chat-sessions/", "/api/chat/",
             "/api/chat-references/", "/api/pl/", "/api/voice/")   # (/api/voice/: Settings → Voice and the window's voice)
_STATIC = (("/pl/js/", ("client", "js")), ("/pl/css/", ("client", "css")),
           ("/vendor/novnc/", ("node_modules", "@novnc", "novnc")))
_STATIC_TYPES = {".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"}
_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers",
        "transfer-encoding", "upgrade", "host", "content-length", "cookie", "authorization", "x-agent-token",
        "x-vo-principal"}
_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def enabled(env=None) -> bool:
    """The layer runs OpenClaw and Hermes unless VO_PROVIDER_LAYER says 0 / false / no / off (the legacy path)."""
    env = os.environ if env is None else env
    return str(env.get("VO_PROVIDER_LAYER") or "").strip().lower() not in _FALSE


def is_layer_path(path: str) -> bool:
    if path.startswith("/api/pl/internal"):
        return False
    return path in _EXACT or path.startswith(_PREFIXES)


def static_file(path: str):
    """The file behind /pl/js/*, /pl/css/* or /vendor/novnc/*, or None (no dot parts, real path inside its root)."""
    for prefix, parts in _STATIC:
        if not path.startswith(prefix):
            continue
        rel = urllib.parse.unquote(path[len(prefix):])
        segs = [s for s in rel.split("/") if s not in {"", "."}]
        if not segs or any(s == ".." or s.startswith(".") or "\\" in s or "\x00" in s for s in segs):
            return None
        if os.path.splitext(segs[-1])[1].lower() not in _STATIC_TYPES:
            return None
        root = os.path.realpath(os.path.join(LAYER_DIR, *parts))
        full = os.path.realpath(os.path.join(root, *segs))
        return full if full.startswith(root + os.sep) and os.path.isfile(full) else None
    return None


def parse_node_version(text):
    m = re.match(r"^\s*v?(\d+)\.(\d+)\.(\d+)", str(text or ""))
    return tuple(int(x) for x in m.groups()) if m else None


def detect_node(node_bin=None):
    """{ok, path, version, message}: whether a Node.js new enough for the layer is installed."""
    path = node_bin or shutil.which("node")
    if not path:
        return {"ok": False, "path": None, "version": None, "message": NODE_MESSAGE}
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    version = parse_node_version(out)
    if not version or version < MIN_NODE:
        found = ".".join(map(str, version)) if version else "unknown"
        return {"ok": False, "path": path, "version": found, "message": f"{NODE_MESSAGE} (found {found})"}
    return {"ok": True, "path": path, "version": ".".join(map(str, version)), "message": ""}


def _free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _readable_by(path, uid, gid):
    try:
        st = os.stat(path)
    except OSError:
        return False
    mode = st.st_mode
    return bool((st.st_uid == uid and mode & 0o400) or (st.st_gid == gid and mode & 0o040) or mode & 0o004)


class ProviderLayer:
    """The vo-host process, its proxy and its event feed."""

    def __init__(self, data_dir, env=None, node_bin=None, log=print, layer_dir=LAYER_DIR):
        self.env = dict(os.environ if env is None else env)
        self.data_dir = data_dir
        self.layer_dir = layer_dir
        self.node_bin = node_bin
        self.log = log
        self.secret = secrets.token_hex(32)
        self.proc = None
        self.port = None
        self.node = None
        self.message = ""
        self.restarts = 0
        self.started_at = 0.0
        self.last_exit = None
        self.stopping = False
        self.owner = None      # (uid, gid) the layer runs as when the office is root in someone else's data folder
        self.lock = threading.Lock()
        self.bus_counts = {}
        self.bus_total = 0
        self.bus_connected = False
        self.subscribers = []  # fn(event) for every bus event (Office Life, presence, Agent PC: stage 4)
        self._threads = []

    # ── process ──────────────────────────────────────────────────────────
    def start(self):
        """Starts the layer in the background; False (and a message) when Node.js or its packages are missing."""
        self.node = detect_node(self.node_bin)
        if not self.node["ok"]:
            self.message = self.node["message"]
            self.log(f"[pl] OpenClaw and Hermes layer off: {self.message}")
            return False
        if not os.path.isdir(os.path.join(self.layer_dir, "node_modules", "@openclaw", "gateway-client")):
            npm = shutil.which("npm")
            if not npm:
                self.message = ("The OpenClaw and Hermes layer needs its packages: run `npm ci --omit=dev` in "
                                "app/provider-layer, then restart the office.")
                self.log(f"[pl] {self.message}")
                return False
            self.log("[pl] installing the layer's packages: npm ci --omit=dev (once)")
            done = subprocess.run([npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=self.layer_dir,
                                  capture_output=True, text=True, timeout=600)
            if done.returncode != 0:
                self.message = "npm ci --omit=dev failed in app/provider-layer: " + (done.stderr or done.stdout)[-300:]
                self.log(f"[pl] {self.message}")
                return False
        private_files.private_dir(self.data_dir)
        self.owner = self._owner()
        self._give_back()   # (files an earlier start made as root: back to the data folder's owner)
        self.secret_file = os.path.join(self.data_dir, ".principal-secret")
        private_files.write_private(self.secret_file, self.secret)
        self.port = int(self.env.get("VO_PL_PORT") or 0) or _free_port()
        self.message = "starting"
        for name, target in (("pl-supervise", self._supervise), ("pl-bus", self._bus_loop)):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)
        return True

    def key_file(self):
        # (the key for stored secrets lives next to the layer's data, never inside it: a copy of the data alone opens
        # nothing)
        return self.env.get("VO_PL_KEY_FILE") or os.path.join(os.path.dirname(os.path.abspath(self.data_dir)), "provider-layer.key")

    def _office_dir(self):
        return os.path.dirname(os.path.abspath(self.data_dir))

    def _key_beside(self):
        return os.path.dirname(os.path.abspath(self.key_file())) == self._office_dir()

    def _folder_owner(self):
        """(uid, gid) of the data folder when the office runs as root in a folder someone else owns (Docker with a
        bind-mounted data folder); None otherwise (not root, or root's own folder such as a named volume)."""
        if not private_files._running_as_root():
            return None
        try:
            st = os.stat(self._office_dir())
        except OSError:
            return None
        return None if st.st_uid == 0 else (st.st_uid, st.st_gid)

    def _owner(self):
        """(uid, gid) the layer runs as and its files keep: the data folder's owner (_folder_owner), so the host user can
        back up provider-layer/ and provider-layer.key like the office's own files (private_files). None otherwise: the
        layer runs as the office does. Also None (root, this start only) when that owner could not read what the layer
        needs: a key file set elsewhere (VO_PL_KEY_FILE), or, before the first migration, an old office file it reads
        (a 0.7.x office left them root's, 0600); its files are given back when it stops and at the next start."""
        owner = self._folder_owner()
        if not owner:
            return None
        key = self.key_file()
        if not self._key_beside() and not _readable_by(key, *owner):
            self.log(f"[pl] the layer runs as root: its key file {key} is not readable by the data folder's owner")
            return None
        if not os.path.exists(os.path.join(self.data_dir, MIGRATE_REPORT)):
            closed = [n for n in MIGRATE_SOURCES
                      if os.path.exists(os.path.join(self._office_dir(), n)) and not _readable_by(os.path.join(self._office_dir(), n), *owner)]
            if closed:
                self.log(f"[pl] the layer runs as root for its first start: {', '.join(closed)} not readable by the data "
                         "folder's owner; its files are given back to that owner when it stops")
                return None
        return owner

    def _give_back(self):
        """provider-layer/ and a key beside it (never one set elsewhere) back to the data folder's owner."""
        owner = self._folder_owner()
        if owner:
            give_back([self.data_dir] + ([self.key_file()] if self._key_beside() else []), *owner)

    def _spawn(self):
        env = {k: v for k, v in self.env.items() if k in {"PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS",
                                                         "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
                                                         "VO_GATEWAY_URL", "VO_PL_FIND",   # (Agent Providers' Find)
                                                         "VO_PL_OFFICE_URL",   # (the office bridge: kind office)
                                                         "VO_WHISPER_URL"}}   # (vo-voice.mjs)
        env.update({
            "VO_PL_DATA": self.data_dir, "VO_PL_KEY_FILE": self.key_file(),
            "VO_PL_PORT": str(self.port), "VO_PL_SECRET_FILE": self.secret_file, "VO_PL_PARENT_PID": str(os.getpid()),
        })
        if self.env.get("VO_PL_TEST") == "1":
            env["VO_PL_TEST"] = "1"
        owner = getattr(self, "owner", None)
        run_as = {}
        if owner:   # (as the data folder's owner: what it writes keeps that owner; its home is its own folder)
            run_as = {"user": owner[0], "group": owner[1], "extra_groups": []}
            env["HOME"] = self.data_dir
        return subprocess.Popen([self.node["path"], "vo-host.mjs"], cwd=self.layer_dir, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, **run_as)

    def _pump(self, proc):
        try:
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    self.log(f"[pl] {line[:400]}")
        except (OSError, ValueError):
            pass
        finally:
            proc.stdout.close()

    def _supervise(self):
        attempt = 0
        while not self.stopping:
            try:
                proc = self._spawn()
            except OSError as exc:
                self.message = f"The OpenClaw and Hermes layer could not start: {exc}"
                self.log(f"[pl] {self.message}")
                return
            with self.lock:
                self.proc = proc
                self.started_at = time.time()
            threading.Thread(target=self._pump, args=(proc,), name="pl-log", daemon=True).start()
            code = proc.wait()
            with self.lock:
                self.proc = None
                self.last_exit = code
            if self.stopping:
                break
            self.restarts += 1
            attempt = 0 if time.time() - self.started_at > 60 else attempt + 1
            delay = min(30.0, 0.5 * (2 ** max(0, attempt - 1))) if attempt else 0.5
            self.message = f"restarting (exit {code})"
            self.log(f"[pl] vo-host stopped (exit {code}); restarting in {delay:.1f} s")
            end = time.time() + delay
            while time.time() < end and not self.stopping:
                time.sleep(0.1)

    def stop(self, wait=3.0):
        """SIGTERM, then SIGKILL after ``wait`` seconds."""
        self.stopping = True
        with self.lock:
            proc = self.proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=wait)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
            except OSError:
                pass
        if proc and not getattr(self, "owner", None):   # (it ran as root: what it made goes back to the folder's owner)
            self._give_back()

    @property
    def pid(self):
        with self.lock:
            return self.proc.pid if self.proc else None

    def ready(self):
        with self.lock:
            return bool(self.proc and self.proc.poll() is None and self.port)

    def health(self, timeout=2.0):
        """vo-host's own health ({host, helperPid, ...}) or None."""
        if not self.ready():
            return None
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
            conn.request("GET", "/api/pl/internal/health", headers={PRINCIPAL_HEADER: self.internal_principal()})
            resp = conn.getresponse()
            body = resp.read()
            conn.close()
            return json.loads(body) if resp.status == 200 else None
        except (OSError, ValueError, http.client.HTTPException):
            return None

    def wait_ready(self, timeout=20.0):
        end = time.time() + timeout
        while time.time() < end:
            h = self.health(timeout=1.0)
            if h:
                if self.message in {"starting"} or self.message.startswith("restarting"):
                    self.message = ""
                return h
            time.sleep(0.2)
        return None

    def status(self):
        return {"enabled": True, "running": self.ready(), "pid": self.pid, "restarts": self.restarts,
                "node": (self.node or {}).get("version"), "message": self.message,
                # (no Node.js, or too old: OpenClaw and Hermes stay off until it is installed; the office says so)
                "nodeOk": None if self.node is None else bool(self.node.get("ok")),
                "bus": {"connected": self.bus_connected, "events": self.bus_total}}

    # ── who is calling ──────────────────────────────────────────────────
    def _sign(self, obj):
        data = base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode().rstrip("=")
        return data + "." + hmac.new(self.secret.encode(), data.encode(), hashlib.sha256).hexdigest()

    def internal_principal(self):
        return self._sign({"role": "owner", "via": "internal", "authAt": 0, "csrf": None})

    def office_principal(self):
        """The office server itself on a normal route (a task's turn, a page call it already checked): the owner on this
        machine (the layer keeps the internal principal for its internal routes only)."""
        return self._sign({"role": "owner", "via": "loopback", "authAt": int(time.time() * 1000), "csrf": None})

    def call(self, principal, method, path, body=None, timeout=45.0):
        """One server-side call to the layer (a route the office already checked): (status, JSON answer)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        data = json.dumps(body).encode() if body is not None else None
        headers = {PRINCIPAL_HEADER: principal}
        if data is not None:
            headers["Content-Type"] = "application/json"
        try:
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
        finally:
            conn.close()
        try:
            return resp.status, json.loads(raw or b"null")
        except ValueError:
            return resp.status, {"error": raw[:200].decode("utf-8", "replace")}

    def principal(self, access, store, headers):
        """The signed X-VO-Principal for a request the office already let in (vo_access.evaluate)."""
        manager = access.can_manage
        if not manager:
            return self._sign({"role": "member", "via": "token", "authAt": 0, "csrf": None})
        via = "session" if access.via_session else "loopback" if access.via_loopback else "open"
        now_ms = int(time.time() * 1000)
        auth_at = now_ms
        if access.protected and not access.via_loopback:
            auth_at = int(store.confirmed_at(access.session_token or "")) * 1000 if store is not None else 0
        # (a browser page gets a CSRF token, read from /api/pl/me; scripts and agents send no cookies and need none)
        browser = bool(access.via_session or headers.get("Cookie") or headers.get("Origin")
                       or headers.get("Sec-Fetch-Site") or headers.get("Referer"))
        csrf = None
        if browser:
            seed = "session:" + (access.session_token or "") if access.via_session else "page"
            csrf = hmac.new(self.secret.encode(), ("csrf:" + seed).encode(), hashlib.sha256).hexdigest()[:40]
        return self._sign({"role": "owner", "via": via, "authAt": auth_at, "csrf": csrf})

    # ── HTTP ─────────────────────────────────────────────────────────────
    def _unavailable(self, handler):
        handler._send_json({"ok": False, "error": self.message or "The OpenClaw and Hermes layer is not running",
                            "code": "provider_layer_unavailable"}, 503)

    def serve_static(self, handler, full):
        with open(full, "rb") as f:
            body = f.read()
        ctype = _STATIC_TYPES.get(os.path.splitext(full)[1].lower()) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        handler.send_response(200)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Cache-Control", "no-cache")
        handler.end_headers()
        if handler.command != "HEAD":
            handler.wfile.write(body)

    def proxy(self, handler, access, store, timeout=180.0):
        """Forwards this request to vo-host and streams the answer back, unbuffered."""
        if not self.ready():
            return self._unavailable(handler)
        length = handler._content_length() if handler.command in {"POST", "PUT", "PATCH", "DELETE"} else 0
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
            conn.putrequest(handler.command, handler.path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", f"127.0.0.1:{self.port}")
            for key, value in handler.headers.items():
                if key.lower() not in _HOP:
                    conn.putheader(key, value)
            conn.putheader(PRINCIPAL_HEADER, self.principal(access, store, handler.headers))
            if length or handler.command == "POST":
                conn.putheader("Content-Length", str(length))
            conn.endheaders()
            left = length
            while left > 0:
                chunk = handler.rfile.read(min(65536, left))
                if not chunk:
                    break
                conn.send(chunk)
                left -= len(chunk)
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException):
            return self._unavailable(handler)
        raw = getattr(handler, "_vo_raw_wfile", None) or handler.wfile
        handler._vo_committed = True  # (streamed as it comes: the office's buffer stays out of it)
        head = [f"{handler.protocol_version} {resp.status} {resp.reason}\r\n",
                f"Server: {handler.version_string()}\r\n", f"Date: {handler.date_time_string()}\r\n"]
        has_length = False
        for key, value in resp.getheaders():
            low = key.lower()
            if low in _HOP and low != "content-length":
                continue
            has_length = has_length or low == "content-length"
            head.append(f"{key}: {value}\r\n")
        if not has_length:
            handler.close_connection = True
            head.append("Connection: close\r\n")
        head.append("\r\n")
        try:
            raw.write("".join(head).encode("latin-1"))
            raw.flush()
            handler.log_request(resp.status)
            if handler.command != "HEAD":
                while True:
                    chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
                    if not chunk:
                        break
                    raw.write(chunk)
                    raw.flush()
        finally:
            conn.close()

    # ── WebSockets ───────────────────────────────────────────────────────
    def relay_ws(self, handler, access, store):
        """Relays a WebSocket upgrade for the layer's sockets: the request (with the principal) to vo-host, then bytes
        both ways until either side closes."""
        if not vo_access.same_origin_request(handler.headers, "POST"):
            handler._send_json({"ok": False, "error": "cross_site_blocked"}, 403)
            return
        if not self.ready():
            return self._unavailable(handler)
        try:
            up = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        except OSError:
            return self._unavailable(handler)
        lines = [f"GET {handler.path} HTTP/1.1", f"Host: 127.0.0.1:{self.port}"]
        for key, value in handler.headers.items():
            if key.lower() not in {"host", "cookie", "authorization", "x-agent-token", "x-vo-principal"}:
                lines.append(f"{key}: {value}")
        lines.append(f"{PRINCIPAL_HEADER}: {self.principal(access, store, handler.headers)}")
        handler._vo_committed = True
        handler.close_connection = True
        client = handler.connection
        try:
            up.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
            up.settimeout(None)
            client.settimeout(None)
        except OSError:
            up.close()
            return

        def pipe(read, dst, ends):
            try:
                while True:
                    data = read(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except (OSError, ValueError):
                pass
            finally:
                for s in ends:
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        back = threading.Thread(target=pipe, args=(up.recv, client, (up, client)), name="pl-ws-down", daemon=True)
        back.start()
        # (the client's side through the request's reader: bytes it already buffered are not lost)
        pipe(handler.rfile.read1, up, (client, up))
        back.join(timeout=5)
        up.close()

    # ── the layer's event bus ─────────────────────────────────────────────
    def _bus_loop(self):
        delay, logged_at, logged_total = 1.0, 0.0, 0
        while not self.stopping:
            if not self.ready():
                time.sleep(0.5)
                continue
            try:
                conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
                conn.request("GET", "/api/pl/internal/bus", headers={PRINCIPAL_HEADER: self.internal_principal()})
                resp = conn.getresponse()
                if resp.status != 200:
                    raise OSError(f"bus HTTP {resp.status}")
                self.bus_connected, delay = True, 1.0
                if self.message == "starting" or self.message.startswith("restarting"):
                    self.message = ""
                while not self.stopping:
                    line = resp.fp.readline()
                    if not line:
                        break
                    if not line.startswith(b"data: "):
                        continue
                    try:
                        event = json.loads(line[6:])
                    except ValueError:
                        continue
                    kind = str(event.get("type") or "?")
                    self.bus_counts[kind] = self.bus_counts.get(kind, 0) + 1
                    self.bus_total += 1
                    for fn in list(self.subscribers):
                        try:
                            fn(event)
                        except Exception as exc:  # a consumer's fault stays there
                            self.log(f"[pl] bus consumer: {exc}")
                    now = time.time()
                    if self.bus_total != logged_total and now - logged_at >= 60:
                        top = ", ".join(f"{k} {v}" for k, v in sorted(self.bus_counts.items(), key=lambda kv: -kv[1])[:6])
                        self.log(f"[pl] bus: {self.bus_total} events ({top})")
                        logged_at, logged_total = now, self.bus_total
                conn.close()
            except (OSError, http.client.HTTPException, ValueError):
                pass
            self.bus_connected = False
            time.sleep(delay)
            delay = min(10.0, delay * 2)
