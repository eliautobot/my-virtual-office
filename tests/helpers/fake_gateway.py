"""A small fake OpenClaw Gateway for tests (protocol v4 subset).

It speaks the real wire shape: ``connect.challenge`` event, ``connect`` request
answered with a hello-ok payload (features.methods / features.events,
auth.scopes, policy, server.version), then ``req``/``res`` frames and ``event``
frames. Nothing here ever reaches a real Gateway: it listens on 127.0.0.1 on an
ephemeral port.

Knobs:
- ``methods``: what hello-ok offers (default: every handler below).
- ``grant``: callable(requested_scopes) -> granted scopes (default: as asked).
- ``handlers[method] = fn(params, scopes) -> payload`` (raise ``FakeError``).
- ``ADMIN_METHODS``: refused without operator.admin, like the Gateway does.
- ``emit(event, payload)`` pushes an event to every connection, ``drop()``
  closes every socket.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, Callable

from websockets.asyncio.server import serve


class FakeError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


ADMIN_METHODS = frozenset({
    "config.get", "config.patch", "config.schema", "config.schema.lookup", "agents.create", "agents.update",
    "agents.delete", "skills.update", "plugins.setEnabled", "plugins.inspect", "cron.update", "cron.run",
    "cron.remove", "exec.approvals.get", "exec.approvals.set", "exec.approval.grants.revoke", "sessions.delete",
    "browser.request", "agents.files.set", "update.status",
})


class FakeGateway:
    def __init__(self, token: str = "test-token", version: str = "2026.10.30") -> None:
        self.token = token
        self.version = version
        self.requests: list[dict] = []
        self.connect_frames: list[dict] = []
        self.policy: dict[str, Any] = {"maxPayload": 26214400, "attachments": {"maxBytes": 5000000, "maxCount": 8}}
        self.grant: Callable[[list[str]], list[str] | None] = lambda requested: list(requested)
        # Device pairing (OpenClaw's connect.params.device): ``device_gate(params)`` returns an error dict to refuse
        # the connect (for example PAIRING_REQUIRED) or None; ``device_token`` goes into hello-ok.auth for a connect
        # that carried a device.
        self.device_gate: Callable[[dict], dict | None] | None = None
        self.device_token = ""
        self.events: list[str] = [
            "chat", "agent", "exec.approval.requested", "exec.approval.resolved", "plugin.approval.requested",
            "plugin.approval.resolved", "question.requested", "question.resolved", "progressCard.changed", "task",
            "sessions.changed",
        ]
        self.handlers: dict[str, Callable[[dict, list[str]], Any]] = {}
        self.methods: list[str] | None = None
        self._lock = threading.RLock()
        self._sockets: set = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self.port = 0
        self._install_defaults()

    # -- defaults -----------------------------------------------------------------------------------------------
    def _install_defaults(self) -> None:
        h = self.handlers
        self.cards: dict[str, dict] = {}
        self.tasks: dict[str, dict] = {}
        self.files: dict[str, dict] = {"AGENTS.md": {"content": "# Agent", "hash": "h1"}}
        self.tabs: list[dict] = [{"targetId": "tab1", "title": "Example", "url": "https://example.com/"}]
        h["agents.list"] = lambda p, s: {"defaultId": "main", "agents": [
            {"id": "main", "name": "Main"}, {"id": "ops", "identity": {"name": "Ops", "emoji": "x"}},
            {"id": "sys", "kind": "system"}]}
        h["agent.identity.get"] = lambda p, s: {"name": "Assistant", "nameSource": "default"} if p.get("agentId") == "main" else {}
        h["models.list"] = lambda p, s: {"models": [
            {"id": "gpt-x", "provider": "openai", "name": "GPT X", "contextWindow": 200000, "input": ["text", "image"],
             "reasoning": True, "thinkingLevels": [{"id": "low", "label": "Low"}, {"id": "high"}], "thinkingDefault": "low",
             "tags": ["default"]},
            {"id": "off", "available": False}]}
        h["sessions.patch"] = lambda p, s: {"ok": True, "key": p.get("key")}
        h["sessions.list"] = lambda p, s: {"sessions": [
            {"key": "agent:main:main", "label": "Main chat", "updatedAt": 5, "model": "gpt-x", "modelProvider": "openai",
             "thinkingLevel": "low", "hasActiveRun": True},
            {"key": "agent:main:bg", "isBackground": True}]}
        h["sessions.delete"] = lambda p, s: {"ok": True}
        h["approval.resolve"] = lambda p, s: {"ok": True}
        h["exec.approval.resolve"] = lambda p, s: {"ok": True}
        h["plugin.approval.resolve"] = lambda p, s: {"ok": True}
        h["question.resolve"] = lambda p, s: {"ok": True}
        h["question.list"] = lambda p, s: {"questions": []}
        h["tasks.list"] = self._tasks_list
        h["tasks.get"] = lambda p, s: {"task": self._task(p)}
        h["tasks.history"] = lambda p, s: {"messages": [
            {"role": "user", "content": [{"type": "text", "text": "do it"}]},
            {"role": "assistant", "content": "done"}], "nextCursor": "c2"}
        h["tasks.cancel"] = lambda p, s: {"cancelled": True, "task": {**self._task(p), "status": "cancelled"}}
        h["progressCard.get"] = lambda p, s: {"card": self.cards.get(p.get("sessionKey"))}
        h["progressCard.refresh"] = lambda p, s: {"status": "accepted", "revision": 3}
        h["progressCard.put"] = self._card_put
        h["browser.request"] = self._browser
        h["agents.files.list"] = lambda p, s: {"files": [{"name": n, "size": len(f["content"])} for n, f in self.files.items()]}
        h["agents.files.get"] = lambda p, s: {"file": {"name": p.get("name"), **self.files.get(p.get("name"), {"missing": True})}}
        h["agents.files.set"] = self._file_set
        h["agents.workspace.list"] = lambda p, s: {"path": p.get("path", ""), "entries": [
            {"name": "notes.txt", "path": "notes.txt", "kind": "file", "size": 4, "updatedAtMs": 1}]}
        h["agents.workspace.get"] = lambda p, s: {"file": {"name": "notes.txt", "path": "notes.txt", "content": "hi", "size": 2}}
        h["config.get"] = lambda p, s: {"config": {"gateway": {"auth": {"token": "SECRET-VALUE"}, "port": 1}}, "hash": "cfg1"}
        h["config.schema"] = lambda p, s: {"uiHints": {"models.providers.*.apiKey": {"sensitive": True}}, "schema": {"properties": {}}}
        h["agents.update"] = lambda p, s: {"ok": True}
        h["exec.approvals.get"] = lambda p, s: {"security": "allowlist"}

    def _tasks_list(self, p: dict, _s: list[str]) -> dict:
        wanted = p.get("status") or []
        rows = [t for t in self.tasks.values() if t.get("status") in wanted]
        return {"tasks": rows[: int(p.get("limit") or 100)]}

    def _task(self, p: dict) -> dict:
        task = self.tasks.get(p.get("taskId"))
        if not task:
            raise FakeError("NOT_FOUND", "task not found")
        return dict(task)

    def _card_put(self, p: dict, _s: list[str]) -> dict:
        card = self.cards.get(p.get("sessionKey"))
        if card and card.get("revision") == p.get("expectedRevision"):
            self.cards.pop(p.get("sessionKey"), None)
            return {"card": None}
        return {"card": card}

    def _file_set(self, p: dict, _s: list[str]) -> dict:
        name = p.get("name")
        old = self.files.get(name)
        if old and p.get("expectedHash") and p["expectedHash"] != old["hash"]:
            raise FakeError("INVALID_REQUEST", "file changed since it was read", {"type": "agent_file_conflict"})
        self.files[name] = {"content": p.get("content", ""), "hash": f"h{len(self.requests)}"}
        return {"hash": self.files[name]["hash"]}

    def _browser(self, p: dict, _s: list[str]) -> Any:
        method, path, body = p.get("method"), p.get("path"), p.get("body") or {}
        if (method, path) == ("GET", "/tabs"):
            return {"running": True, "tabs": self.tabs}
        if path == "/screenshot":
            return {"ok": True, "path": self.screenshot_path, "targetId": body.get("targetId")}
        if path == "/act" and body.get("targetId") == "gone":
            raise FakeError("INVALID_REQUEST", "tab not found")
        if path == "/tabs/open":
            return {"targetId": "tab2", "title": "", "url": body.get("url")}
        return {"ok": True, "url": body.get("url", "")}

    screenshot_path = ""

    # -- server -------------------------------------------------------------------------------------------------
    def offered(self) -> list[str]:
        return list(self.methods) if self.methods is not None else sorted(self.handlers)

    async def _handler(self, websocket) -> None:
        await websocket.send(json.dumps({"type": "event", "event": "connect.challenge",
                                         "payload": {"nonce": "n", "ts": int(time.time() * 1000)}}))
        frame = json.loads(await websocket.recv())
        with self._lock:
            self.connect_frames.append(frame)
        params = frame.get("params") or {}
        if ((params.get("auth") or {}).get("token")) != self.token:
            await websocket.send(json.dumps({"type": "res", "id": frame.get("id"), "ok": False,
                                             "error": {"code": "UNAUTHORIZED", "message": "unauthorized: gateway token mismatch"}}))
            return
        refusal = self.device_gate(params) if self.device_gate is not None else None
        if refusal:
            await websocket.send(json.dumps({"type": "res", "id": frame.get("id"), "ok": False, "error": refusal}))
            return
        granted = self.grant(list(params.get("scopes") or []))
        hello: dict[str, Any] = {"type": "hello-ok", "protocol": 4, "server": {"version": self.version},
                                 "features": {"methods": self.offered(), "events": list(self.events)},
                                 "policy": self.policy}
        if granted is not None:
            hello["auth"] = {"role": "operator", "scopes": granted}
            if params.get("device") and self.device_token:
                hello["auth"]["deviceToken"] = self.device_token
        scopes = list(granted if granted is not None else params.get("scopes") or [])
        await websocket.send(json.dumps({"type": "res", "id": frame.get("id"), "ok": True, "payload": hello}))
        with self._lock:
            self._sockets.add(websocket)
        try:
            async for raw in websocket:
                req = json.loads(raw)
                if req.get("type") != "req":
                    continue
                with self._lock:
                    self.requests.append(req)
                await websocket.send(json.dumps(self._answer(req, scopes)))
        except Exception:
            pass
        finally:
            with self._lock:
                self._sockets.discard(websocket)

    def _answer(self, req: dict, scopes: list[str]) -> dict:
        method, params = req.get("method"), req.get("params") or {}
        base = {"type": "res", "id": req.get("id")}
        if method not in self.offered() or method not in self.handlers:
            return {**base, "ok": False, "error": {"code": "INVALID_REQUEST", "message": f"unknown method: {method}"}}
        if method in ADMIN_METHODS and "operator.admin" not in scopes:
            return {**base, "ok": False, "error": {"code": "INVALID_REQUEST", "message": "missing scope: operator.admin"}}
        try:
            return {**base, "ok": True, "payload": self.handlers[method](params, scopes)}
        except FakeError as exc:
            error = {"code": exc.code, "message": exc.message}
            if exc.details:
                error["details"] = exc.details
            return {**base, "ok": False, "error": error}

    def start(self) -> "FakeGateway":
        def run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop

            async def start_server() -> None:
                self._server = await serve(self._handler, "127.0.0.1", 0)
                self.port = self._server.sockets[0].getsockname()[1]
                self._ready.set()

            loop.run_until_complete(start_server())
            loop.run_forever()
            loop.close()

        self._thread = threading.Thread(target=run, name="fake-openclaw-gateway", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=5):
            raise RuntimeError("Fake Gateway failed to start")
        return self

    def _run(self, coro, timeout: float = 5) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(timeout=timeout)

    def emit(self, event: str, payload: dict) -> None:
        async def send() -> None:
            frame = json.dumps({"type": "event", "event": event, "payload": payload})
            for ws in list(self._sockets):
                await ws.send(frame)
        self._run(send())

    def drop(self) -> None:
        async def close() -> None:
            for ws in list(self._sockets):
                await ws.close(code=1011, reason="test drop")
        self._run(close())

    def stop(self) -> None:
        if not self._loop or not self._server:
            return

        async def stop_server() -> None:
            self._server.close()
            await self._server.wait_closed()

        try:
            self._run(stop_server())
        finally:
            self._server = None
            self._loop.call_soon_threadsafe(self._loop.stop)
            if self._thread:
                self._thread.join(timeout=5)

    def calls(self, method: str) -> list[dict]:
        with self._lock:
            return [r.get("params") or {} for r in self.requests if r.get("method") == method]

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"
