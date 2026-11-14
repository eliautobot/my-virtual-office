"""A stand-in Hermes backend (`hermes serve`) for the Virtual Office tests.

Python port of My Virtual World's tests/helpers/fake-hermes.mjs, stdlib only: one asyncio server on one 127.0.0.1 port
that answers REST (`/api/*`, the sign-in routes) and the gateway JSON-RPC socket (`/api/ws`) like Hermes does, with a
minimal HTTP/1.1 parser and a minimal RFC 6455 text-frame WebSocket (handshake, masked client frames, ping/pong, close
codes such as 4401/4403). It runs on its own thread so tests can drive a link synchronously.

- Sign-in: mode "token" (X-Hermes-Session-Token / Bearer on REST, ?token= on the socket) or mode "password" (Hermes'
  native-app PKCE flow: /auth/native/authorize, /auth/password-login, /auth/native/token, /auth/native/refresh).
- Socket: gateway.ready (replay_epoch, heartbeat), client.capabilities, profiles.list, session.create / resume /
  interrupt / close / history / events.since / redirect / active_list, prompt.submit replaying a recorded turn chosen by
  the text (tests/fixtures/hermes/run-*.json: `rm -rf` asks an approval, `[[tool:clarify` asks questions, `[[tool:` runs a
  command, `[[think]]` reasons, `[[slow]]` waits 60 ms between frames, `[[sudo]]` / `[[secret]]` masked prompts, else
  "Stub answer to: <text>"), busy turns per `busy` (steer; queued:true or busy "queue" waits and merges), model.options,
  commands.catalog, config.set, image.attach_bytes, file.attach, approval.respond, request.answer, subagent.list,
  display.status/start/stop/thumbnail.
- REST: sessions (list, one, messages, patch, delete), config + schema, skills (+ toggle), toolsets, cron jobs, files
  (list, read, upload, mkdir, delete, download; /tmp/chart.png preloaded), analytics usage.
- Knobs for failure tests: status_code, status_body, login_status, ws_close_code, heartbeat, epoch, stall (methods never
  answered), access_ttl; and actions drop_sockets(), restart(token=, epoch=), send_request(method, params).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import http
import json
import os
import re
import secrets as _secrets
import struct
import threading
import time
import urllib.parse

FIXTURES = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "fixtures", "hermes"))
FILE_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
FROOT = "/tmp"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def recording(name: str) -> dict:
    with open(os.path.join(FIXTURES, f"run-{name}.json"), encoding="utf-8") as fh:
        return json.load(fh)


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


class _Conn:
    """One open /api/ws socket."""

    def __init__(self, fake: "FakeHermes", no: int, writer: asyncio.StreamWriter):
        self.fake, self.no, self.writer = fake, no, writer
        self.caps = 0
        self.open: dict[str, asyncio.Future] = {}
        self.closed = False

    def send(self, obj: dict) -> None:
        if self.closed:
            return
        self.frame(0x1, (json.dumps(obj) + "\n").encode())

    def frame(self, opcode: int, data: bytes) -> None:
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack("!H", n)
        else:
            head += bytes([127]) + struct.pack("!Q", n)
        try:
            self.writer.write(head + data)
        except Exception:  # noqa: BLE001 - the socket is gone
            self.closed = True

    def close(self, code: int, reason: str = "") -> None:
        if self.closed:
            return
        self.frame(0x8, struct.pack("!H", code) + reason.encode()[:120])
        self.closed = True
        try:
            self.writer.close()
        except Exception:  # noqa: BLE001
            pass

    def abort(self) -> None:
        self.closed = True
        try:
            self.writer.transport.abort()
        except Exception:  # noqa: BLE001
            pass


DEFAULT_PROFILES = [
    {"name": "default", "is_default": True, "model": "stub-1", "provider": "custom"},
    {"name": "research", "display_name": "Researcher", "model": "stub-2", "provider": "custom"},
]


class FakeHermes:
    def __init__(self, *, token: str = "hermes-session-token", mode: str = "token", username: str = "casey",
                 password: str = "pw-correct", version: str = "0.21.5", busy: str = "steer", profiles=None,
                 access_ttl: float = 3600, status_code: int = 200, status_body=None, login_status: int | None = None,
                 ws_close_code: int | None = None, heartbeat: bool = True, epoch: str = "e1", stall=(),
                 confirm_models=()):
        self.token, self.mode, self.username, self.password, self.version = token, mode, username, password, version
        self.profiles = [dict(p) for p in (profiles or DEFAULT_PROFILES)]
        self.access_ttl, self.status_code, self.status_body = access_ttl, status_code, status_body
        self.login_status, self.ws_close_code, self.heartbeat, self.epoch = login_status, ws_close_code, heartbeat, epoch
        self.stall = set(stall)
        self.confirm_models = set(confirm_models)   # models whose config.set asks to confirm (expensive)
        self.url = ""
        self.port = 0
        # what happened (read by the tests)
        self.calls: list[str] = []          # "GET /api/status", "rpc client.capabilities", ...
        self.rpc: list[tuple[int, str, dict]] = []
        self.answers: list[dict] = []       # responses the client sent to our server requests (and *.respond / answer)
        self.caps_by_socket: dict[int, int] = {}
        self.sockets_opened = 0
        self.refreshed = 0
        self.logins = 0
        self.config_sets: list[dict] = []
        self.attached: list[dict] = []
        self.last_answer = None
        # state
        self.sessions: dict[str, dict] = {}
        self.live: dict[str, dict] = {}
        self.tokens: dict[str, dict] = {}
        self.codes: dict[str, dict] = {}
        self.pkce: dict[str, dict] = {}
        self.files: dict[str, dict] = {"/tmp/chart.png": {"mime": "image/png", "bytes": FILE_PNG}}
        self.dirs: set[str] = set()
        self.skills = [{"name": "web-research", "description": "Search well", "category": "research", "enabled": True,
                        "provenance": "bundled"}]
        self.toolsets = [{"name": "web", "label": "Web Search", "description": "web_search", "enabled": True,
                          "available": True, "configured": True, "tools": ["web_search"]}]
        self.config = {"model": "stub-1", "display": {"busy_input_mode": busy},
                       "gateway": {"api_server": {"key": "super-secret-key"}}}
        self.jobs = [{"job_id": "j1", "name": "Morning brief", "schedule": "0 8 * * *", "enabled": True,
                      "state": "scheduled", "prompt_preview": "Brief me"}]
        self.display = {"installed": True, "running": False, "lease": {"holder": "agent", "epoch": 0, "reason": ""}}
        self.viewers: set[str] = set()      # viewer ids minted by display.observe
        self.mcp = [{"name": "ink", "transport": "stdio", "url": None, "command": "npx", "args": ["ink-mcp"],
                     "env": {"INK_API_KEY": "ink-secret-value-9"}, "headers": {"Authorization": "Bearer ink-hdr-1"},
                     "auth": None, "enabled": True, "tools": None, "source": "config", "plugin": None}]
        self.env = {"OPENROUTER_API_KEY": "sk-or-env-secret-1", "UNSET_KEY": ""}
        self.rest_log: list[tuple[str, str, dict, dict]] = []   # (method, path, query, body) of every REST call
        self.seq = 0
        self.rq_seq = 0
        self.subagents = []          # {subagent_id, key, goal, status, ...}: children delegated from a session
        self.steers = []
        self.conns: set[_Conn] = set()
        self._conn_no = 0
        self._stopped = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server = None
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ lifecycle (called from the test thread)
    def start(self) -> "FakeHermes":
        ready = threading.Event()

        def run():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            self._server = self._loop.run_until_complete(
                asyncio.start_server(self._client, "127.0.0.1", 0, limit=1 << 20))
            self.port = self._server.sockets[0].getsockname()[1]
            self.url = f"http://127.0.0.1:{self.port}"
            ready.set()
            self._loop.run_forever()

        self._thread = threading.Thread(target=run, name="fake-hermes", daemon=True)
        self._thread.start()
        ready.wait(5)
        return self

    def _on_loop(self, fn):
        done = threading.Event()
        box = {}

        def wrap():
            try:
                box["v"] = fn()
            finally:
                done.set()

        self._loop.call_soon_threadsafe(wrap)
        done.wait(5)
        return box.get("v")

    def stop(self) -> None:
        if not self._loop:
            return
        self._stopped = True

        def shut():
            for c in list(self.conns):
                c.abort()
            self._server.close()

        self._on_loop(shut)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(5)

    def drop_sockets(self) -> None:
        """Every open socket dies without a close frame (a network drop)."""
        self._on_loop(lambda: [c.abort() for c in list(self.conns)])

    def close_sockets(self, code: int, reason: str = "") -> None:
        self._on_loop(lambda: [c.close(code, reason) for c in list(self.conns)])

    def restart(self, token: str | None = None, epoch: str | None = None, flush_partial: bool = False) -> None:
        """Hermes restarted: sockets drop, live sessions end, event numbers start again (new epoch), maybe a new token.
        flush_partial: as real Hermes' exit flush, an answer cut mid-way is stored as it was (an assistant row)."""
        def do():
            for c in list(self.conns):
                c.abort()
            for x in self.live.values():
                x["dead"] = True     # (its turn dies with the process: nothing more is written or stored)
                if flush_partial and x.get("running") and x.get("partial") and x["key"] in self.sessions:
                    msgs = self.sessions[x["key"]]["messages"]
                    msgs.append({"id": len(msgs) + 1, "role": "assistant", "content": x["partial"],
                                 "timestamp": time.time(), "active": 1, "finish_reason": None})
            self.live.clear()
            self.seq = 0
            self.epoch = epoch or f"e{_secrets.token_hex(3)}"
            if token is not None:
                self.token = token
        self._on_loop(do)

    def send_request(self, method: str, params: dict | None = None) -> str:
        """Hermes asks the client something (a server request) on every open socket; returns its id."""
        def do():
            self.rq_seq += 1
            rid = f"srq-{self.rq_seq}"
            for c in list(self.conns):
                c.open[rid] = self._loop.create_future()
                c.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
            return rid
        return self._on_loop(do)

    def _live_of(self, key: str):
        return next((x for x in self.live.values() if x["key"] == key), None)

    def spawn_subagent(self, key: str, goal: str, sid: str | None = None) -> str:
        """The agent delegated work from session `key` (delegate_task): a child starts and says so."""
        def do():
            no = sid or f"sa-{len(self.subagents) + 1}"
            self.subagents.append({"subagent_id": no, "key": key, "goal": goal, "status": "running",
                                   "model": "stub-1", "started_at": time.time(), "tool_count": 0})
            l = self._live_of(key)
            if l:
                self._ev(l, "subagent.start", {"subagent_id": no, "goal": goal, "status": "running"})
                self._ev(l, "subagent.progress", {"subagent_id": no, "text": "Reading the files", "tool_name": "read"})
            return no
        return self._on_loop(do)

    def finish_subagent(self, no: str, summary: str) -> None:
        def do():
            c = next(x for x in self.subagents if x["subagent_id"] == no)
            c.update(status="completed", summary=summary, duration_seconds=1.5)
            l = self._live_of(c["key"])
            if l:
                self._ev(l, "subagent.complete", {"subagent_id": no, "status": "completed", "summary": summary,
                                                  "duration_seconds": 1.5})
        self._on_loop(do)

    def foreign_turn(self, key: str, text: str) -> None:
        """A turn started in Hermes itself (its Desktop) in a session this client has attached."""
        def do():
            l = self._live_of(key)
            s = self.sessions[key]
            s["messages"].append({"id": len(s["messages"]) + 1, "role": "user", "content": text,
                                  "timestamp": time.time(), "active": 1})
            self._loop.create_task(self._play(l, text))
        self._on_loop(do)

    # ------------------------------------------------------------------ HTTP
    async def _client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except Exception:  # noqa: BLE001
            writer.close()
            return
        lines = head.decode("latin-1").split("\r\n")
        try:
            method, target, _ = lines[0].split(" ", 2)
        except ValueError:
            writer.close()
            return
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        u = urllib.parse.urlsplit(target)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query, keep_blank_values=True).items()}
        if headers.get("upgrade", "").lower() == "websocket":
            await self._upgrade(reader, writer, u.path, q, headers)
            return
        n = int(headers.get("content-length") or 0)
        raw = await reader.readexactly(n) if n else b""
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            body = {}
        try:
            code, payload, extra = await self._route(method, u.path, q, headers, body)
        except Exception as exc:  # noqa: BLE001
            code, payload, extra = 500, {"detail": str(exc)}, {}
        if isinstance(payload, (bytes, bytearray)):
            data, ctype = bytes(payload), extra.pop("content-type", "application/octet-stream")
        else:
            data, ctype = json.dumps(payload).encode(), "application/json"
        out = [f"HTTP/1.1 {code} {http.HTTPStatus(code).phrase}", f"Content-Type: {ctype}",
               f"Content-Length: {len(data)}", "Connection: close"]
        out += [f"{k}: {v}" for k, v in extra.items()]
        writer.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1") + data)
        try:
            await writer.drain()
        finally:
            writer.close()

    def _auth_ok(self, headers: dict) -> bool:
        authz = headers.get("authorization", "")
        bearer = authz[7:] if authz.startswith("Bearer ") else ""
        if self.mode == "token":
            return headers.get("x-hermes-session-token") == self.token or bearer == self.token
        return self._access_ok(bearer)

    def _access_ok(self, value: str) -> bool:
        t = self.tokens.get(value or "")
        return bool(t and t["kind"] == "access" and t["exp"] > time.time())

    def _mint(self, kind: str, ttl: float) -> str:
        t = b64url(os.urandom(18))
        self.tokens[t] = {"kind": kind, "exp": time.time() + ttl}
        return t

    def _pair(self) -> dict:
        return {"access_token": self._mint("access", self.access_ttl), "refresh_token": self._mint("refresh", 86400),
                "token_type": "Bearer", "expires_at": time.time() + self.access_ttl, "provider": "basic",
                "user_id": self.username}

    def _row(self, s: dict) -> dict:
        return {"id": s["id"], "title": s["title"], "source": s["source"], "model": s.get("model") or "stub-1",
                "started_at": s["started"], "last_activity_at": s["last"], "ended_at": None,
                "message_count": len(s["messages"]), "parent_session_id": None, "profile": s["profile"]}

    async def _route(self, method: str, p: str, q: dict, headers: dict, b: dict):
        self.calls.append(f"{method} {p}")
        pw = self.mode == "password"
        if p == "/api/status":
            if self.status_code != 200:
                return self.status_code, {"detail": "Invalid host header"}, {}
            if self.status_body is not None:
                return 200, self.status_body, {}
            return 200, {"version": self.version, "release_date": "2026.9.24", "auth_required": pw,
                         "auth_providers": ["basic"] if pw else [], "profiles": [x["name"] for x in self.profiles],
                         "gateway_running": False, "overall": "ok"}, {}
        if p == "/api/auth/providers":
            return 200, ([{"name": "basic", "supports_password": True}] if pw else []), {}
        if pw and p == "/auth/native/authorize":
            st = b64url(os.urandom(8))
            self.pkce[st] = {"challenge": q.get("code_challenge"), "redirect": q.get("redirect_uri"),
                             "state": q.get("state")}
            return 302, {}, {"Location": "/login", "Set-Cookie": f"hermes_pkce={st}; Path=/; HttpOnly"}
        if pw and p == "/auth/password-login" and method == "POST":
            self.logins += 1
            if self.login_status:
                return self.login_status, {"detail": "Too many attempts"}, {}
            m = re.search(r"hermes_pkce=([^;]+)", headers.get("cookie", ""))
            pend = self.pkce.get(m.group(1)) if m else None
            if b.get("username") != self.username or b.get("password") != self.password:
                return 401, {"detail": "Invalid credentials"}, {}
            if not pend:
                return 400, {"detail": "no flow"}, {}
            code = b64url(os.urandom(12))
            self.codes[code] = pend
            return 200, {"ok": True, "next": f"{pend['redirect']}?code={code}&state={pend['state']}"}, {}
        if pw and p == "/auth/native/token" and method == "POST":
            pend = self.codes.pop(b.get("code"), None)
            want = b64url(hashlib.sha256(str(b.get("code_verifier") or "").encode()).digest())
            if not pend or want != pend["challenge"]:
                return 400, {"detail": "Invalid or expired authorization code."}, {}
            return 200, self._pair(), {}
        if pw and p == "/auth/native/refresh" and method == "POST":
            t = self.tokens.get(b.get("refresh_token") or "")
            if not t or t["kind"] != "refresh":
                return 401, {"error": "session_expired"}, {}
            self.tokens.pop(b.get("refresh_token"))
            self.refreshed += 1
            return 200, self._pair(), {}
        if not p.startswith("/api/"):
            return 404, {"detail": "Not found"}, {}
        if not self._auth_ok(headers):
            return 401, {"detail": "Unauthorized"}, {}
        return self._rest(method, p, q, b)

    def _rest(self, method: str, p: str, q: dict, b: dict):
        self.rest_log.append((method, p, dict(q), b if isinstance(b, dict) else {}))
        if p == "/api/mcp/servers" and method == "GET":
            return 200, {"servers": [{**x, "env": {k: (v[:3] + "...") if v else "" for k, v in x["env"].items()}}
                                     for x in self.mcp]}, {}
        m = re.match(r"^/api/mcp/servers/([^/]+)/enabled$", p)
        if m and method == "PUT":
            x = next((x for x in self.mcp if x["name"] == urllib.parse.unquote(m.group(1))), None)
            if not x:
                return 404, {"detail": "MCP server not found"}, {}
            x["enabled"] = bool(b.get("enabled"))
            return 200, {"ok": True, "name": x["name"], "enabled": x["enabled"]}, {}
        if p == "/api/model/set" and method == "POST":
            if b.get("model") in self.confirm_models and not b.get("confirm_expensive_model"):
                return 200, {"ok": False, "confirm_required": True,
                             "confirm_message": f"{b.get('model')} is expensive: confirm it"}, {}
            self.config["model"] = b.get("model")
            return 200, {"ok": True, "model": b.get("model"), "provider": b.get("provider"), "scope": b.get("scope")}, {}
        m = re.match(r"^/api/tools/toolsets/([^/]+)$", p)
        if m and method == "PUT":
            t = next((t for t in self.toolsets if t["name"] == urllib.parse.unquote(m.group(1))), None)
            if not t:
                return 404, {"detail": "Toolset not found"}, {}
            t["enabled"] = bool(b.get("enabled"))
            return 200, {"ok": True, "name": t["name"], "enabled": t["enabled"]}, {}
        m = re.match(r"^/api/cron/jobs/([^/]+)$", p)
        if m and method == "DELETE":
            before = len(self.jobs)
            self.jobs = [j for j in self.jobs if j["job_id"] != urllib.parse.unquote(m.group(1))]
            return (200, {"ok": True}, {}) if len(self.jobs) < before else (404, {"detail": "no job"}, {})
        if p == "/api/env" and method == "GET":
            return 200, {k: {"is_set": bool(v), "redacted_value": (v[:4] + "...") if v else None,
                             "description": f"{k} key", "url": None, "category": "provider", "is_password": True,
                             "tools": [], "advanced": False, "channel_managed": False, "provider": "openrouter",
                             "provider_label": "OpenRouter"} for k, v in self.env.items()}, {}
        if p == "/api/env" and method == "PUT":
            self.env[b.get("key")] = b.get("value")
            return 200, {"ok": True, "key": b.get("key")}, {}
        if p == "/api/sessions" and method == "GET":
            prof = q.get("profile") or "default"
            if not any(x["name"] == prof for x in self.profiles):
                return 404, {"detail": f"Profile '{prof}' does not exist."}, {}
            rows = sorted((s for s in self.sessions.values() if s["profile"] == prof and s["messages"]),
                          key=lambda s: -s["last"])
            return 200, {"sessions": [self._row(s) for s in rows], "total": len(self.sessions)}, {}
        m = re.match(r"^/api/sessions/([^/]+)/messages$", p)
        if m:
            s = self.sessions.get(urllib.parse.unquote(m.group(1)))
            return (200, {"session_id": s["id"], "messages": s["messages"]}, {}) if s else \
                (404, {"detail": "Session not found"}, {})
        m = re.match(r"^/api/sessions/([^/]+)$", p)
        if m:
            s = self.sessions.get(urllib.parse.unquote(m.group(1)))
            if not s:
                return 404, {"detail": "Session not found"}, {}
            if method == "GET":
                return 200, self._row(s), {}
            if method == "PATCH":
                if isinstance(b.get("title"), str):
                    s["title"] = b["title"]
                return 200, self._row(s), {}
            if method == "DELETE":
                if any(x["key"] == s["id"] for x in self.live.values()):
                    return 409, {"detail": "Session is live"}, {}
                self.sessions.pop(s["id"])
                return 200, {"deleted": s["id"]}, {}
        if p == "/api/config" and method == "GET":
            return 200, self.config, {}
        if p == "/api/config" and method == "PUT":
            def merge(a, x):
                for k, v in x.items():
                    a[k] = merge(a[k], v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
                return a
            merge(self.config, b.get("config") or {})
            return 200, {"ok": True}, {}
        if p == "/api/config/schema":
            return 200, {"fields": {
                "model": {"type": "string", "description": "Default model", "category": "general"},
                "display.busy_input_mode": {"type": "select", "options": ["interrupt", "queue", "steer"],
                                            "description": "Busy input", "category": "display"},
                "gateway.api_server.key": {"type": "string", "description": "API key", "category": "general"}},
                "category_order": ["general", "display"]}, {}
        if p == "/api/skills" and method == "GET":
            return 200, self.skills, {}
        if p == "/api/skills/toggle" and method == "PUT":
            for s in self.skills:
                if s["name"] == b.get("name"):
                    s["enabled"] = bool(b.get("enabled"))
            return 200, {"ok": True, "name": b.get("name"), "enabled": bool(b.get("enabled"))}, {}
        if p == "/api/tools/toolsets":
            return 200, self.toolsets, {}
        if p == "/api/cron/jobs":
            return 200, self.jobs, {}
        m = re.match(r"^/api/cron/jobs/([^/]+)/(pause|resume|trigger)$", p)
        if m:
            job = next((j for j in self.jobs if j["job_id"] == m.group(1)), None)
            if not job:
                return 404, {"detail": "no job"}, {}
            if m.group(2) != "trigger":
                job["enabled"] = m.group(2) == "resume"
            return 200, {"ok": True}, {}
        if p.startswith("/api/files"):
            return self._files(method, p, q, b)
        if p == "/api/analytics/usage":
            return 200, {"totals": {"sessions": len(self.sessions), "input_tokens": 10, "output_tokens": 5}}, {}
        return 404, {"detail": "Not found"}, {}

    def _files(self, method: str, p: str, q: dict, b: dict):
        def fpath(v):
            t = str(v or "").strip()
            if not t or t in ("/", "."):
                return FROOT
            if ".." in t.split("/"):
                return None
            return t.rstrip("/") if t.startswith("/") else f"{FROOT}/{t}"

        def under(x):
            return x == FROOT or x.startswith(FROOT + "/")

        def entry(x, is_dir):
            f = self.files.get(x)
            return {"name": x.rsplit("/", 1)[-1], "path": x, "is_directory": is_dir,
                    "size": None if is_dir else len(f["bytes"]), "mtime": 1760000000,
                    "mime_type": None if is_dir else f["mime"]}

        roots = {"root": FROOT, "locked_root": FROOT, "can_change_path": False}
        if p == "/api/files/download":
            f = self.files.get(q.get("path") or "")
            if not f:
                return 404, {"detail": "File not found"}, {}
            return 200, f["bytes"], {"content-type": f["mime"]}
        x = fpath(q.get("path") if method == "GET" else b.get("path"))
        if x is None:
            return 400, {"detail": "Path cannot contain '..'"}, {}
        if p == "/api/files" and method == "GET":
            if not under(x):
                return 403, {"detail": "Path outside managed files root"}, {}
            if not (x in self.dirs or x == FROOT):
                return (400, {"detail": "Path is not a directory"}, {}) if x in self.files else \
                    (404, {"detail": "Path not found"}, {})
            kids = [entry(d, True) for d in sorted(self.dirs) if d != x and d.rsplit("/", 1)[0] == x]
            kids += [entry(k, False) for k in sorted(self.files) if k.rsplit("/", 1)[0] == x and
                     not k.endswith("/.env")]
            return 200, {"path": x, "parent": None if x == FROOT else x.rsplit("/", 1)[0], "entries": kids, **roots}, {}
        if p == "/api/files/read" and method == "GET":
            if x.endswith("/.env"):
                return 403, {"detail": "Access to sensitive files is not allowed"}, {}
            f = self.files.get(x)
            if not f:
                return 404, {"detail": "File not found"}, {}
            data_url = f"data:{f['mime']};base64,{base64.b64encode(f['bytes']).decode()}"
            return 200, {"name": x.rsplit("/", 1)[-1], "path": x, "size": len(f["bytes"]), "mime_type": f["mime"],
                         "data_url": data_url, **roots}, {}
        if not under(x):
            return 403, {"detail": "Path outside managed files root"}, {}
        if p == "/api/files/upload" and method == "POST":
            mm = re.match(r"^data:([^;,]*);base64,(.*)$", str(b.get("data_url") or ""), re.S)
            if not mm:
                return 400, {"detail": "Invalid data URL"}, {}
            if x in self.files and b.get("overwrite") is False:
                return 409, {"detail": "File already exists"}, {}
            self.files[x] = {"mime": mm.group(1) or "application/octet-stream", "bytes": base64.b64decode(mm.group(2))}
            return 200, {"ok": True, "path": x, "name": x.rsplit("/", 1)[-1], **roots}, {}
        if p == "/api/files/mkdir" and method == "POST":
            if x in self.files:
                return 409, {"detail": "A file already exists at that path"}, {}
            self.dirs.add(x)
            return 200, {"ok": True, "path": x, **roots}, {}
        if p == "/api/files" and method == "DELETE":
            if x == FROOT:
                return 400, {"detail": "Cannot delete the managed files root"}, {}
            if self.files.pop(x, None) is not None:
                return 200, {"ok": True, "path": x}, {}
            if x not in self.dirs:
                return 404, {"detail": "Path not found"}, {}
            inside = [k for k in list(self.files) + list(self.dirs) if k.startswith(x + "/")]
            if inside and not b.get("recursive"):
                return 409, {"detail": "Could not delete path: directory not empty"}, {}
            for k in inside + [x]:
                self.files.pop(k, None)
                self.dirs.discard(k)
            return 200, {"ok": True, "path": x}, {}
        return 404, {"detail": "Not found"}, {}

    # ------------------------------------------------------------------ WebSocket
    async def _upgrade(self, reader, writer, path: str, q: dict, headers: dict) -> None:
        self.calls.append(f"WS {path}")
        t = q.get("token", "")
        ok = path == "/api/ws" and (t == self.token if self.mode == "token" else self._access_ok(t))
        key = headers.get("sec-websocket-key", "")
        if not ok or not key:
            writer.write(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        self._conn_no += 1
        self.sockets_opened += 1
        conn = _Conn(self, self._conn_no, writer)
        self.caps_by_socket[conn.no] = 0
        if self.ws_close_code:
            conn.close(self.ws_close_code, "refused")
            return
        self.conns.add(conn)
        conn.send({"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready", "payload": {
            "skin": {"name": "default"}, "change_events": True, "replay_epoch": self.epoch,
            "heartbeat": self.heartbeat}}})
        buf = b""
        try:
            while not conn.closed:
                b0, b1 = await reader.readexactly(2)
                opcode, n = b0 & 0x0F, b1 & 0x7F
                if n == 126:
                    n = struct.unpack("!H", await reader.readexactly(2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", await reader.readexactly(8))[0]
                mask = await reader.readexactly(4) if b1 & 0x80 else b"\0\0\0\0"
                data = bytearray(await reader.readexactly(n))
                for i in range(n):
                    data[i] ^= mask[i & 3]
                if opcode == 0x8:
                    code = struct.unpack("!H", bytes(data[:2]))[0] if n >= 2 else 1000
                    conn.close(code if code < 4000 or code > 4999 else 1000)
                    break
                if opcode == 0x9:
                    conn.frame(0xA, bytes(data))
                    continue
                if opcode in (0x1, 0x0):
                    buf += bytes(data)
                    if b0 & 0x80:
                        text, buf = buf.decode("utf-8", "replace"), b""
                        for line in text.split("\n"):
                            if line.strip():
                                await self._frame(conn, line)
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            conn.closed = True
            self.conns.discard(conn)
            for sid, l in list(self.live.items()):
                if l["conn"] is conn and not l["running"]:
                    self.live.pop(sid, None)
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    async def _frame(self, conn: _Conn, line: str) -> None:
        try:
            fr = json.loads(line)
        except ValueError:
            return
        if not isinstance(fr, dict):
            return
        if not fr.get("method"):
            rid = str(fr.get("id"))
            if rid in conn.open:
                fut = conn.open.pop(rid)
                self.answers.append({"id": fr.get("id"), "result": fr.get("result"), "error": fr.get("error")})
                if not fut.done():
                    fut.set_result(fr.get("result") or {})
            return
        method, params = fr["method"], fr.get("params") or {}
        self.calls.append(f"rpc {method}")
        self.rpc.append((conn.no, method, params))
        if method in self.stall:
            return

        async def answer():
            try:
                conn.send({"jsonrpc": "2.0", "id": fr.get("id"), "result": await self._call(conn, method, params)})
            except RpcError as e:
                conn.send({"jsonrpc": "2.0", "id": fr.get("id"), "error": {"code": e.code, "message": str(e)}})

        asyncio.get_running_loop().create_task(answer())

    def _ev(self, l: dict, type_: str, payload: dict | None = None) -> None:
        if l.get("dead"):
            return
        self.seq += 1
        params = {"type": type_, "session_id": l["sid"], "payload": payload or {}, "seq": self.seq}
        ring = l.setdefault("ring", [])
        ring.append(params)
        del ring[:-2000]
        l["conn"].send({"jsonrpc": "2.0", "method": "event", "params": params})

    async def _ask(self, l: dict, method: str, params: dict):
        self.rq_seq += 1
        rid = f"srq-{self.rq_seq}"
        fut = asyncio.get_running_loop().create_future()
        l["conn"].open[rid] = fut
        l["ask"] = {"id": rid, "method": method, "params": params, "fut": fut}
        l["conn"].send({"jsonrpc": "2.0", "id": rid, "method": method, "params": {"session_id": l["sid"], **params}})
        r = await fut
        l["ask"] = None
        return r

    def _open_requests(self, l: dict | None) -> list:
        a = l and l.get("ask")
        return [{"id": a["id"], "method": a["method"], "params": {"session_id": l["sid"], **a["params"]}}] if a else []

    async def _call(self, conn: _Conn, method: str, p: dict):
        if method == "client.capabilities":
            conn.caps += 1
            self.caps_by_socket[conn.no] = conn.caps
            return {"server_requests": ["approval", "clarify", "secret", "sudo"], "declines_not_shown": True}
        if method == "gateway.ping":
            return {"pong": True}
        if method == "gateway.capabilities":
            return {"per_session_exclusive_submit": True}
        if method == "profiles.list":
            return {"profiles": [{"path": f"/h/{x['name']}", "skill_count": 1, **x} for x in self.profiles]}
        if method == "profiles.create":
            if any(x["name"] == p.get("name") for x in self.profiles):
                raise RpcError(4009, f"profile {p.get('name')} already exists")
            self.profiles.append({"name": p.get("name"), "display_name": p.get("name"), "is_default": False,
                                  "model": "stub-1", "description": p.get("description") or ""})
            return {"ok": True, "name": p.get("name"), "path": f"/h/{p.get('name')}"}
        if method == "profiles.describe":
            x = next((x for x in self.profiles if x["name"] == p.get("name")), None)
            if not x:
                raise RpcError(4004, "no such profile")
            return {**x, "path": f"/h/{x['name']}"}
        if method.startswith("display."):
            return self._display(method, p)
        if method == "session.create":
            sid_stored = f"20261017_{len(self.sessions) + 1:06d}"
            sid = b64url(os.urandom(4))
            now = time.time()
            self.sessions[sid_stored] = {"id": sid_stored, "profile": p.get("profile") or "default",
                                         "source": p.get("source") or "tui", "title": "", "messages": [],
                                         "started": now, "last": now, "model": p.get("model"),
                                         "effort": p.get("reasoning_effort")}
            self.live[sid] = {"sid": sid, "key": sid_stored, "conn": conn, "running": False, "queue": []}
            return {"session_id": sid, "stored_session_id": sid_stored, "message_count": 0, "messages": [],
                    "info": {"model": "stub-1", "lazy": True}}
        if method == "session.resume":
            s = self.sessions.get(p.get("session_id"))
            if not s:
                raise RpcError(4001, "session not found")
            l = next((x for x in self.live.values() if x["key"] == s["id"]), None)
            if l:
                l["conn"] = conn
            else:
                l = {"sid": b64url(os.urandom(4)), "key": s["id"], "conn": conn, "running": False, "queue": []}
                self.live[l["sid"]] = l
            return {"session_id": l["sid"], "resumed": s["id"], "message_count": len(s["messages"]), "messages": [],
                    "info": {}, "running": l["running"], "open_requests": self._open_requests(l),
                    "todo_state": {"todos": [], "revision": 0}}
        if method == "approval.respond" or method == "request.answer":
            self.answers.append({"via": method, **p})
            for x in self.live.values():
                a = x.get("ask")
                if a and (a["id"] == p.get("id") if method == "request.answer" else x["sid"] == p.get("session_id")):
                    x["ask"] = None
                    x["conn"].open.pop(a["id"], None)
                    if not a["fut"].done():
                        a["fut"].set_result(p.get("result") if method == "request.answer" else
                                            {"choice": p.get("choice")})
                    return {"status": "ok"} if method == "request.answer" else {"resolved": 1}
            return {"status": "expired"} if method == "request.answer" else {"resolved": 0}
        if method == "model.options":
            return {"model": "stub-1", "provider": "custom", "providers": [{
                "slug": "custom", "name": "Custom", "is_current": True, "authenticated": True,
                "models": ["stub-1", "stub-2"], "capabilities": {
                    "stub-1": {"reasoning": False}, "stub-2": {"reasoning": True, "can_disable_reasoning": True}}}]}
        if method == "commands.catalog":
            return {"categories": [{"name": "Session", "pairs": [["/new", "Start a new session"],
                                                                 ["/status", "Show current session status"]]}],
                    "pairs": [["/new", "Start a new session"], ["/web-research", "Search well"]]}
        if method == "config.set":
            self.config_sets.append(dict(p))
            if p.get("key") == "model" and str(p.get("value")).split(" ")[0] in self.confirm_models \
                    and not p.get("confirm"):
                return {"confirm_required": True, "confirm_message": "stub-2 is expensive: confirm it in Hermes"}
            if p.get("key") == "reasoning" and p.get("value") not in ("none", "minimal", "low", "medium", "high",
                                                                     "xhigh"):
                raise RpcError(4002, f"unknown reasoning level {p.get('value')}")
            return {"key": p.get("key"), "value": str(p.get("value")).split(" ")[0], "scope": p.get("scope") or "session"}
        if method == "image.attach_bytes":
            self.attached.append({"kind": "image", "filename": p.get("filename"),
                                  "bytes": len(base64.b64decode(p.get("content_base64") or ""))})
            return {"attached": True, "name": p.get("filename"), "count": 1}
        if method == "file.attach":
            data = str(p.get("data_url") or "").split(",", 1)
            self.attached.append({"kind": "file", "name": p.get("name"),
                                  "bytes": len(base64.b64decode(data[1] if len(data) > 1 else ""))})
            name = p.get("name")
            return {"attached": True, "name": name, "path": f"/ws/{name}", "ref_path": f"/ws/{name}",
                    "ref_text": f"@file:/ws/{name}", "uploaded": True}
        if method == "session.active_list":
            prof = p.get("profile") or "default"
            # (as Hermes: every live session of the process, idle ones too, whatever the profile asked for)
            return {"sessions": [{"id": x["sid"], "session_key": x["key"],
                                  "status": "waiting" if x.get("ask") else "working" if x["running"] else "idle",
                                  "title": self.sessions[x["key"]]["title"]}
                                 for x in self.live.values() if prof]}
        l = self.live.get(p.get("session_id")) if p.get("session_id") else None
        if method.startswith("subagent."):
            if l is None:
                raise RpcError(4001, "session not found")
            kids = [x for x in self.subagents if x["key"] == l["key"]]
            if method == "subagent.list":
                return {"subagents": [{k: v for k, v in x.items() if k != "key"} for x in kids]}
            x = next((x for x in kids if x["subagent_id"] == p.get("subagent_id")), None)
            if method == "subagent.tail":
                return {"available": bool(x), "text": f"Working on: {x['goal']}" if x else "", "truncated": False}
            if method == "subagent.steer":
                self.steers.append(dict(p))
                return {"ok": bool(x and x["status"] == "running"), "queued": bool(x and x["status"] == "running")}
            if method == "subagent.interrupt":
                found = bool(x and x["status"] == "running")
                if found:
                    x["status"] = "interrupted"
                return {"found": found}
        if method == "session.events.since":
            last = int(p.get("last_seen") or 0)
            events = [e for e in (l or {}).get("ring", []) if e["seq"] > last]
            return {"events": events, "latest_seq": self.seq, "truncated": False, "count": len(events),
                    "epoch": self.epoch, "open_requests": self._open_requests(l)}
        if l is None and method.startswith(("session.", "prompt.")) and method != "session.close":
            raise RpcError(4001, "session not found")
        if method == "session.history":
            s = self.sessions[l["key"]]
            return {"messages": [{"role": m["role"], "row_id": m["id"], "text": m["content"],
                                  "reasoning": m.get("reasoning_content"), "timestamp": m["timestamp"]}
                                 for m in s["messages"]]}
        if method == "prompt.submit":
            s = self.sessions[l["key"]]
            text = str(p.get("text") or "")
            s["messages"].append({"id": len(s["messages"]) + 1, "role": "user", "content": text,
                                  "timestamp": time.time(), "active": 1})
            if l["running"]:
                if p.get("queued") or self.config["display"]["busy_input_mode"] == "queue":
                    if l["queue"]:
                        l["queue"][-1] += "\n\n" + text
                    else:
                        l["queue"].append(text)
                    return {"status": "queued"}
                l.setdefault("steered", []).append(text)
                return {"status": "steered"}
            asyncio.get_running_loop().create_task(self._play(l, text))
            return {"status": "streaming", "user_row_id": len(s["messages"])}
        if method == "session.redirect":
            if not l["running"]:
                return {"status": "rejected", "text": p.get("text")}
            l.setdefault("steered", []).append(str(p.get("text") or ""))
            return {"status": "redirected", "text": p.get("text")}
        if method == "session.interrupt":
            if l["running"]:
                l["stop"] = True
                return {"status": "interrupted", "interrupted": True}
            return {"status": "not_interrupted"}
        if method == "session.close":
            self.live.pop(p.get("session_id"), None)
            return {"closed": True}
        raise RpcError(-32601, f"unknown method {method}")

    def _display(self, method: str, p: dict):
        d = self.display
        snap = lambda: {"profile": p.get("profile") or "default", "supported": True, "installed": d["installed"],  # noqa: E731
                        "running": d["running"], "geometry": "1440x900",
                        "lease": dict(d["lease"])}
        if method == "display.status":
            return snap()
        if method == "display.observe":
            vid = p.get("viewer_id") if p.get("viewer_id") in self.viewers else f"viewer-{len(self.viewers) + 1}"
            self.viewers.add(vid)
            return {**snap(), "ticket": f"t-{vid}", "viewer_id": vid, "path": "/api/display/ws"}
        if method == "display.lease.acquire":
            if p.get("viewer_id") not in self.viewers:
                raise RpcError(5301, "unknown viewer")
            d["lease"] = {"holder": "human", "epoch": d["lease"]["epoch"] + 1, "reason": p.get("reason") or "",
                          "viewer_hash": hashlib.sha256(p["viewer_id"].encode()).hexdigest()[:12]}
            return {"ok": True, "lease": dict(d["lease"])}
        if method == "display.lease.release":
            d["lease"] = {"holder": "agent", "epoch": d["lease"]["epoch"] + 1, "reason": ""}
            return {"ok": True, "lease": dict(d["lease"])}
        if method == "display.start":
            if not d["installed"]:
                raise RpcError(5300, "Bot Desktop needs Xvnc on the gateway host")
            d["running"] = True
            return snap()
        if method == "display.stop":
            d["running"] = False
            return {**snap(), "stopped": True}
        if method == "display.thumbnail":
            jpeg = base64.b64encode(bytes([0xFF, 0xD8, 0xFF, 0xD9])).decode()
            return {"data_url": f"data:image/jpeg;base64,{jpeg}" if d["running"] else None}
        raise RpcError(-32601, f"unknown method {method}")

    async def _play(self, l: dict, text: str) -> None:
        """Plays a recorded turn for a message into a live session; what it asks waits for the answer."""
        s = self.sessions[l["key"]]
        l["running"], l["stop"] = True, False
        masked = ("sudo", {"command": "apt-get update", "description": ""}) if "[[sudo]]" in text else \
            ("secret", {"env_var": "GITHUB_TOKEN", "prompt": "Hermes needs your GitHub token."}) \
            if "[[secret]]" in text else None
        if masked:
            self._ev(l, "message.start")
            r = await self._ask(l, *masked)
            self.last_answer = r
            reply = f"Got it ({masked[0]} given)." if r and r.get("value") else f"No {masked[0]} given."
            self._ev(l, "message.delta", {"text": reply})
            s["messages"].append({"id": len(s["messages"]) + 1, "role": "assistant", "content": reply,
                                  "timestamp": time.time(), "active": 1, "finish_reason": "stop"})
            self._ev(l, "message.complete", {"text": reply, "status": "complete"})
            l["running"] = False
            return
        name = "approval" if "rm -rf" in text else "clarify" if "[[tool:clarify" in text else \
            "tool" if "[[tool:" in text else "think"
        slow = "[[slow" in text
        answer = ""
        for fr in recording(name)["frames"]:
            if self._stopped or l.get("dead"):
                return
            if l.get("stop"):
                break
            if "request" in fr:
                rq = fr["request"]
                self.last_answer = await self._ask(l, rq["method"], {k: v for k, v in rq["params"].items()
                                                                       if k != "session_id"})
                continue
            t, payload = fr.get("type"), fr.get("payload") or {}
            if t in ("sessions.changed", "session.title"):
                continue
            if t == "message.complete":
                break
            if t == "message.delta":
                answer += payload.get("text") or ""
                l["partial"] = answer
            if t == "session.info" and payload.get("stored_session_id"):
                payload = {**payload, "stored_session_id": l["key"]}
            self._ev(l, t, payload)
            if slow:
                await asyncio.sleep(0.06)
        if l.get("dead"):
            return
        if name == "think" and "[[think" not in text:
            answer = "Stub answer to: " + re.sub(r"\[\[[^\]]*\]\]", "", text).strip()
        steered, l["steered"] = l.get("steered") or [], []
        if steered and not l.get("stop"):
            extra = '\n\n(and about "' + '", "'.join(steered) + '": noted)'
            self._ev(l, "message.delta", {"text": extra})
            answer += extra
        stopped = bool(l.get("stop"))
        m = re.search(r"MEDIA:(\S+)", text)
        if m:
            self._ev(l, "message.delta", {"text": f"\nMEDIA:{m.group(1)}"})
            answer += f"\nMEDIA:{m.group(1)}"
        # (as real Hermes: a finished answer row says finish_reason "stop"; a cut one has none)
        row = {"id": len(s["messages"]) + 1, "role": "assistant", "content": answer, "timestamp": time.time(),
               "active": 1, "finish_reason": None if stopped else "stop"}
        if name == "think" and "[[think" in text:
            row["reasoning_content"] = "Let me think about this step by step."
        s["messages"].append(row)
        s["last"] = time.time()
        s["title"] = s["title"] or text[:40]
        self._ev(l, "message.complete", {"text": "" if stopped else answer,
                                         "status": "interrupted" if stopped else "complete",
                                         "usage": {"model": "stub-1", "input": 100, "output": 20,
                                                   "context_used": 1200, "context_max": 256000}})
        l["running"] = False
        if l["queue"]:
            nxt = l["queue"].pop(0)
            await asyncio.sleep(0.02)
            await self._play(l, nxt)


def start_fake_hermes(**knobs) -> FakeHermes:
    return FakeHermes(**knobs).start()
