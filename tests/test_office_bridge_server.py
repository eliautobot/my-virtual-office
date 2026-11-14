"""The office bridge inside the real server.py (OfficeHandler on 127.0.0.1), with fakes only at each provider's edge.

Codex app-server (a fake run object), Codex exec (a fake provider.send_chat_message), Claude Code (a fake CLI call fed
through the real run worker and its queue), Hermes API (a fake API client), OpenCode / Antigravity / an extension (a
fake provider registry): every kind's event sequence through server.py's own run paths, approvals for Codex and Hermes,
busy and stop, history, attachments, a stranger refused, and the layer off leaving everything as before.
No real CLI, account or model. Run: python3 tests/test_office_bridge_server.py
"""
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

_DATA = tempfile.TemporaryDirectory(prefix="vo-uA-bridge-srv-")
os.environ["VO_STATUS_DIR"] = _DATA.name
os.environ["VO_CONFIG"] = os.path.join(_DATA.name, "vo-config.json")
os.environ["VO_CODEX_INCLUDE_NATIVE_AGENTS"] = "0"
os.environ["VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS"] = "0"
APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))
import server  # noqa: E402
import office_chat_bridge as ob  # noqa: E402

PORT = int(os.environ.get("VO_TEST_BRIDGE_SERVER_PORT") or 19632)
SECRET = "s" * 64
FULL = {"chat": True, "streaming": True, "sessions": True, "sessionCreate": True, "sessionDelete": True,
        "sessionSwitch": True, "interrupt": True, "approvals": True, "attachments": True, "tools": True}
ROSTER = [
    {"id": "adler", "statusKey": "adler", "name": "Adler", "providerKind": "openclaw", "profile": "adler", "emoji": "A"},
    {"id": "codex-main", "statusKey": "codex-main", "name": "Codex", "providerKind": "codex", "profile": "main",
     "providerAgentId": "main", "model": "gpt-test", "capabilities": FULL, "emoji": "C"},
    {"id": "claude-main", "statusKey": "claude-main", "name": "Claude", "providerKind": "claude-code", "profile": "main",
     "providerAgentId": "main", "capabilities": {**FULL, "approvals": False}, "emoji": "L"},
    {"id": "hermes-api", "statusKey": "hermes-api", "name": "Hermes", "providerKind": "hermes", "profile": "default",
     "providerAgentId": "default", "apiAvailable": True, "providerConnectionId": "local",
     "capabilities": {**FULL, "attachments": False}, "emoji": "H"},
    {"id": "hermes-layer", "statusKey": "hermes-layer", "name": "Hermes L", "providerKind": "hermes", "profile": "x",
     "providerConnectionId": "pl-2", "capabilities": FULL},
    {"id": "opencode-main", "statusKey": "opencode-main", "name": "OpenCode", "providerKind": "opencode",
     "profile": "main", "providerAgentId": "main", "capabilities": {**FULL, "approvals": False}},
    {"id": "agy-main", "statusKey": "agy-main", "name": "Agy", "providerKind": "antigravity", "profile": "main",
     "providerAgentId": "main", "capabilities": {"chat": True, "interrupt": True, "models": True}},
    {"id": "acme-bot", "statusKey": "acme-bot", "name": "Acme", "providerKind": "acme", "profile": "bot",
     "providerAgentId": "bot", "capabilities": {"chat": True, "streaming": True, "tools": True}},
]


def snapshot(state):
    return {"threadId": "th-1", "sessionId": "th-1", "turnId": "turn-1", "runId": "turn-1", "status": "running",
            "reply": state.get("reply", ""), "tools": list(state.get("tools", [])), "thinking": state.get("thinking", ""),
            "error": "", "approval": state.get("approval"), "tokenUsage": state.get("tokenUsage", {})}


class FakeCodexRun:
    """codex.py's app-server run: next_event() gives events carrying the whole state, like CodexAppServerRun."""

    def __init__(self, provider, script):
        self.provider, self.script = provider, list(script)
        self.thread_id, self.turn_id = "th-1", "turn-1"
        self.state = types.SimpleNamespace(completed=False)
        self.now = {}

    def next_event(self, timeout=0.5):
        if self.provider.interrupted.is_set():
            self.state.completed = True
            return {"event": "run.cancelled", **snapshot(self.now), "ok": False}
        if not self.script:
            time.sleep(min(timeout, 0.05))
            return None
        name, change = self.script[0]
        if name == "wait-approval":   # (a real turn goes on seconds after the answer, not within a millisecond)
            if not self.provider.answered.wait(timeout=min(timeout, 0.05)):
                return None
            self.script[0] = ("resume-at", time.time() + 0.3)
            self.now["approval"] = None
            return None
        if name == "resume-at":
            if time.time() < change:
                time.sleep(0.02)
                return None
            self.script.pop(0)
            return None
        if name == "hang":
            time.sleep(min(timeout, 0.05))
            return None
        self.script.pop(0)
        self.now.update(change)
        if name in ("run.completed",):
            self.state.completed = True
            return {"event": name, **snapshot(self.now), "ok": True}
        return {"event": name, **snapshot(self.now)}

    def snapshot(self):
        return snapshot(self.now)

    def close(self):
        pass


class FakeCodexProvider:
    def __init__(self):
        self.prefer_app_server = True
        self.model = "gpt-test"
        self.approval_policy = ""
        self.script = []
        self.answered = threading.Event()
        self.interrupted = threading.Event()
        self.responses = []
        self.exec_calls = []

    def start_chat_stream(self, profile, message, session_id="", timeout_sec=900):
        self.answered.clear()
        self.interrupted.clear()
        return FakeCodexRun(self, self.script)

    def interrupt(self, profile):
        self.interrupted.set()
        return {"ok": True}

    def respond_approval(self, profile, approval_id, choice="cancel"):
        self.responses.append((approval_id, choice))
        self.answered.set()
        return {"ok": True, "approval": {"id": approval_id, "status": "approved" if choice == "approve" else "cancelled"}}

    def list_threads(self, profile, limit=40):
        return {"ok": True, "sessions": [{"id": "th-1", "title": "Build", "preview": "build it", "updatedAt": 1700000000}]}

    def pending_approval(self, profile):
        return {"ok": True, "approval": None}

    def send_chat_message(self, profile, message, session_id="", timeout_sec=900, on_progress=None, **kw):
        self.exec_calls.append((profile, session_id, message))
        if on_progress:
            on_progress({"reply": "", "thinking": "Reading", "sessionId": "th-exec"})
        return {"ok": True, "reply": "Exec answer.", "sessionId": "th-exec", "thinking": "Reading the repo",
                "tools": [{"id": "e1", "name": "shell", "status": "done", "arguments": {"command": "ls"}, "result": "a b"}]}


class FakeRegistry:
    """app/providers/registry.py's invoke for OpenCode, Antigravity and an extension kind."""

    def __init__(self):
        self.sent = []

    def invoke(self, kind, method, profile, *args, **kw):
        if method == "list_sessions":
            return {"ok": True, "sessions": [{"id": f"{kind}-s1", "title": f"{kind} chat", "updatedAt": 1700000000}]}
        if method == "send_chat_message":
            self.sent.append((kind, profile, args[0] if args else "", kw.get("session_id"), kw.get("files")))
            progress = kw.get("on_progress")
            if kind == "antigravity":
                # ("conv:" messages: Antigravity's one conversation, its id named only with the answer, as agy --print)
                text = args[0] if args else ""
                return {"ok": True, "reply": "Agy done.", "sessionId": "agy-conv-1" if "conv:" in text else ""}
            if progress:
                progress({"reply": "Wor", "sessionId": f"{kind}-s1", "status": "running"})
                progress({"reply": "Working", "sessionId": f"{kind}-s1", "status": "running",
                          "tools": [{"id": "r1", "name": "read", "status": "running", "arguments": {"path": "a.md"}}]})
            return {"ok": True, "reply": "Working done.", "sessionId": f"{kind}-s1",
                    "tools": [{"id": "r1", "name": "read", "status": "done", "arguments": {"path": "a.md"}, "result": "text"}]}
        return {"ok": False, "error": f"fake registry: {method}"}

    def manifest(self, kind):
        return None

    def get(self, kind):
        return None   # (no create_session: a new chat starts lazily with the next message, as OpenCode's does)


class FakeHermesClient:
    base_url = "http://127.0.0.1:1"

    def __init__(self):
        self.answer = threading.Event()
        self.responses = []

    def is_available(self):
        return True

    def start_run(self, *args, **kwargs):
        self.answer.clear()
        return {"run_id": "h-run-1"}

    def stream_run_events(self, *args, **kwargs):
        yield {"event": "message.delta", "delta": "Hel"}
        yield {"event": "tool.started", "tool": "terminal", "preview": "uptime", "id": "ht1"}
        yield {"event": "tool.completed", "tool": "terminal", "preview": "uptime", "id": "ht1", "result": "up 3 days"}
        yield {"event": "approval.request", "command": "sudo reboot", "description": "Dangerous command",
               "approval_id": "hap-1", "choices": ["once", "deny"]}
        self.answer.wait(timeout=5)
        yield {"event": "message.delta", "delta": "lo"}
        yield {"event": "run.completed", "output": "Hello"}

    def respond_approval(self, run_id, choice):
        self.responses.append((run_id, choice))
        self.answer.set()
        return {"ok": True}


class BridgeInServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.codex = FakeCodexProvider()
        cls.registry = FakeRegistry()
        cls.hermes = FakeHermesClient()
        cls.cc_bodies = []
        cls.layer_dir = os.path.join(_DATA.name, "provider-layer")
        os.makedirs(os.path.join(cls.layer_dir, "attachments", "1"), exist_ok=True)

        def fake_claude_chat(body):
            cls.cc_bodies.append(body)
            progress = body.get("_onProgress")
            progress({"sessionId": "cc-1", "reply": "", "thinking": "Plan", "status": "running"})
            progress({"sessionId": "cc-1", "reply": "Rea", "thinking": "Plan", "status": "running",
                      "tools": [{"id": "c1", "name": "Bash", "status": "running", "arguments": {"command": "pytest"}}]})
            progress({"sessionId": "cc-1", "reply": "Rea", "thinking": "Plan", "status": "running",
                      "tools": [{"id": "c1", "name": "Bash", "status": "done", "arguments": {"command": "pytest"},
                                 "result": "3 passed"}]})
            return {"ok": True, "reply": "Ready.", "sessionId": "cc-1", "thinking": "Plan",
                    "tools": [{"id": "c1", "name": "Bash", "status": "done", "arguments": {"command": "pytest"}, "result": "3 passed"}]}

        cls.patches = [
            mock.patch.object(server, "get_roster", lambda: [dict(r) for r in ROSTER]),
            mock.patch.object(server, "_codex_provider", lambda: cls.codex),
            mock.patch.object(server, "_get_provider_registry", lambda: cls.registry),
            mock.patch.object(server, "_handle_claude_code_chat", fake_claude_chat),
            mock.patch.object(server, "_hermes_api_client_for_profile", lambda *a, **k: cls.hermes),
            mock.patch.object(server, "_prepare_hermes_run_context", lambda *a, **k: ("hs-1", [])),
            mock.patch.object(server, "_publish_hermes_api_progress", lambda *a, **k: None),
        ]
        for p in cls.patches:
            p.start()
        cls.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", PORT), server.OfficeHandler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        server.PROVIDER_LAYER = types.SimpleNamespace(secret=SECRET, data_dir=cls.layer_dir)

    @classmethod
    def tearDownClass(cls):
        server.PROVIDER_LAYER = None
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for p in cls.patches:
            p.stop()

    def call(self, method, path, body=None, role="owner", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=15)
        hdrs = dict(headers or {})
        if role:
            hdrs[ob.PRINCIPAL_HEADER] = ob.sign_principal(SECRET, {"role": role, "via": "layer", "authAt": 0, "csrf": None})
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            hdrs["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=hdrs)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        try:
            return resp.status, json.loads(raw)
        except ValueError:
            return resp.status, {"raw": raw[:200].decode("utf-8", "replace")}

    def events(self, run_id, since=0):
        """The whole run over SSE (ends after run.end)."""
        conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=15)
        conn.request("GET", f"/api/office-bridge/runs/events?run={run_id}&since={since}",
                     headers={ob.PRINCIPAL_HEADER: ob.sign_principal(SECRET, {"role": "owner", "via": "layer"})})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        text = resp.read().decode()
        conn.close()
        out = []
        for block in text.split("\n\n"):
            fields = dict(l.split(": ", 1) for l in block.splitlines() if ": " in l and not l.startswith(":"))
            if "data" in fields:
                out.append(json.loads(fields["data"]))
        if os.environ.get("VO_BRIDGE_TRACE"):
            with open(os.environ["VO_BRIDGE_TRACE"], "a") as trace:
                trace.write(json.dumps([{k: e.get(k) for k in ("type", "text", "thinking", "toolId", "status")} for e in out]) + "\n")
        return out

    def wait_for(self, run_id, kind, timeout=8):
        since, deadline = 0, time.time() + timeout
        while time.time() < deadline:
            status, page = self.call("GET", f"/api/office-bridge/runs/events?run={run_id}&since={since}&json=1&wait=1")
            for e in page.get("events", []):
                since = e["id"]
                if e["type"] == kind:
                    return e
            if page.get("done"):
                break
        self.fail(f"{kind} never came for {run_id}")

    def run_ok(self, agent, text="hi", session="", **extra):
        status, body = self.call("POST", "/api/office-bridge/runs", {"agent": agent, "session": session, "input": text, **extra})
        self.assertEqual(status, 200, body)
        return body

    # ── tests ──
    def test_a_layer_off_untouched_and_stranger_refused(self):
        server.PROVIDER_LAYER = None
        try:
            status, body = self.call("GET", "/api/office-bridge/agents")
            self.assertEqual(status, 404)
            self.assertNotEqual(body.get("code"), "signin_required")
        finally:
            server.PROVIDER_LAYER = types.SimpleNamespace(secret=SECRET, data_dir=self.layer_dir)
        status, body = self.call("GET", "/api/office-bridge/agents", role=None)
        self.assertEqual((status, body.get("code")), (401, "signin_required"))
        forged = ob.sign_principal("not-the-secret", {"role": "owner", "via": "layer"})
        status, body = self.call("GET", "/api/office-bridge/agents", role=None, headers={ob.PRINCIPAL_HEADER: forged})
        self.assertEqual(status, 401)
        status, body = self.call("GET", "/api/office-bridge/agents", headers={"X-Forwarded-For": "198.51.100.4"})
        self.assertIn(status, (401, 403))   # (the office's own gate or the bridge: never answered)
        status, body = self.call("GET", "/api/office/chat-sessions?agent=codex-main")
        self.assertEqual(status, 200)   # (the office window's own routes are unchanged)

    def test_b_agents(self):
        self.assertEqual(os.environ.get("VO_PL_OFFICE_URL"), f"http://127.0.0.1:{server.PORT}")   # (for provider_layer_proxy)
        status, body = self.call("GET", "/api/office-bridge/agents", role="member")
        self.assertEqual(status, 200, body)
        got = {a["officeId"]: (a["provider"], a["transport"]) for a in body["agents"]}
        labels = {a["officeId"]: a["providerLabel"] for a in body["agents"]}
        self.assertEqual((labels["opencode-main"], labels["acme-bot"]), ("OpenCode", "Acme"))
        self.assertEqual(got, {"codex-main": ("codex", "app-server"), "claude-main": ("claude-code", "cli"),
                               "hermes-api": ("hermes", "api"), "opencode-main": ("opencode", "sdk"),
                               "agy-main": ("antigravity", "sdk"), "acme-bot": ("acme", "sdk")})

    def test_c_codex_app_server_approval_and_history(self):
        tool = {"id": "t1", "name": "shell", "status": "running", "arguments": {"command": "make"}, "result": ""}
        self.codex.script = [
            ("run.started", {}),
            ("reasoning.available", {"thinking": "Plan the build"}),
            ("tool.started", {"tools": [tool]}),
            ("approval.request", {"approval": {"id": "ap-1", "kind": "command", "title": "Codex command approval required",
                                               "description": "make", "command": "make", "status": "pending"}}),
            ("wait-approval", None),
            ("tool.completed", {"tools": [{**tool, "status": "done", "result": "built"}], "approval": None}),
            ("message.delta", {"reply": "Built"}),
            ("usage.updated", {"tokenUsage": {"last": {"totalTokens": 1200, "inputTokens": 1000, "outputTokens": 200},
                                              "modelContextWindow": 272000}}),
            ("run.completed", {"reply": "Built it."}),
        ]
        started = self.run_ok("codex-main", "build it")
        self.assertEqual(started["sessionKey"], "th-1")
        asked = self.wait_for(started["runId"], "approval.requested")
        self.assertEqual((asked["approvalId"], asked["command"]), ("ap-1", "make"))
        status, busy = self.call("POST", "/api/office-bridge/runs", {"agent": "codex-main", "session": "th-9", "input": "x"})
        self.assertEqual((status, busy["code"]), (409, "busy"))
        status, body = self.call("POST", "/api/office-bridge/approve",
                                 {"run": started["runId"], "approvalId": "ap-1", "approved": True, "decision": "allow-once"})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.codex.responses[-1], ("ap-1", "approve"))
        evs = self.events(started["runId"])
        self.assertEqual([e["type"] for e in evs],
                         ["run.start", "run.delta", "tool.start", "approval.requested", "approval.resolved", "tool.end",
                          "run.delta", "usage.update", "run.delta", "run.end"])
        end = evs[-1]
        self.assertEqual((end["status"], end["text"], end["model"], end["tokensIn"]), ("ok", "Built it.", "gpt-test", 1000))
        self.assertTrue(all(e["agentKey"] == "codex-main" for e in evs))
        status, hist = self.call("GET", "/api/office-bridge/history?agent=codex-main&session=th-1")
        self.assertEqual(status, 200, hist)
        roles = [m["role"] for m in hist["messages"]]
        self.assertEqual(roles[-2:], ["user", "assistant"])
        last = hist["messages"][-1]
        self.assertEqual(last["text"], "Built it.")
        self.assertEqual(last["meta"]["steps"][0]["input"], "make")
        self.assertIsNone(hist["running"])
        status, sess = self.call("GET", "/api/office-bridge/sessions?agent=codex-main")
        self.assertEqual(status, 200, sess)
        self.assertIn("th-1", [s["key"] for s in sess["sessions"]])

    def test_d_codex_stop(self):
        self.codex.script = [("run.started", {}), ("message.delta", {"reply": "Long"}), ("hang", None)]
        started = self.run_ok("codex-main", "long job", session="th-1")
        self.wait_for(started["runId"], "run.delta")
        status, body = self.call("POST", "/api/office-bridge/stop", {"run": started["runId"]})
        self.assertEqual((status, body["provider"]["ok"]), (200, True))
        evs = self.events(started["runId"])
        self.assertEqual([e["type"] for e in evs], ["run.start", "run.delta", "run.end"])
        self.assertEqual(evs[-1]["status"], "stopped")

    def test_e_codex_exec(self):
        self.codex.prefer_app_server = False
        try:
            status, body = self.call("GET", "/api/office-bridge/agents")
            codex = next(a for a in body["agents"] if a["officeId"] == "codex-main")
            self.assertEqual((codex["transport"], codex["caps"]["approvals"]), ("exec", False))
            started = self.run_ok("codex-main", "exec please")
            evs = self.events(started["runId"])
        finally:
            self.codex.prefer_app_server = True
        self.assertEqual([e["type"] for e in evs], ["run.start", "run.delta", "run.delta", "tool.start", "tool.end", "run.end"])
        self.assertEqual((evs[-1]["status"], evs[-1]["text"], evs[-1]["sessionKey"]), ("ok", "Exec answer.", "th-exec"))
        self.assertTrue(self.codex.exec_calls)

    def test_f_claude_code_with_attachment(self):
        src = os.path.join(self.layer_dir, "attachments", "1", "d41d8cd9")
        with open(src, "w") as f:
            f.write("notes")
        started = self.run_ok("claude-main", "read this", attachments=[{"name": "notes.md", "mime": "text/markdown",
                                                                         "size": 5, "path": src}])
        evs = self.events(started["runId"])
        self.assertEqual([e["type"] for e in evs],
                         ["run.start", "run.delta", "tool.start", "tool.end", "run.delta", "run.delta", "run.end"])
        self.assertEqual(evs[2]["input"], "pytest")
        self.assertEqual((evs[4]["thinking"], evs[5]["text"]), ("Plan", "dy."))
        self.assertEqual((evs[-1]["status"], evs[-1]["text"], evs[-1]["sessionKey"]), ("ok", "Ready.", "cc-1"))
        sent = self.cc_bodies[-1]["attachments"][0]
        # (the office's uploads folder: server.STATUS_DIR, which an earlier test module may have set when it imported server)
        self.assertTrue(sent["path"].startswith(os.path.join(server.STATUS_DIR, "uploads") + os.sep), sent)
        with open(sent["path"]) as f:
            self.assertEqual(f.read(), "notes")
        self.assertTrue(self.cc_bodies[-1]["newSessionPending"])
        status, body = self.call("POST", "/api/office-bridge/runs", {"agent": "claude-main", "input": "x", "attachments": [
            {"name": "p", "path": os.path.join(_DATA.name, "vo-config.json")}]})
        self.assertEqual((status, body["code"]), (400, "bad_attachment_path"))

    def test_g_hermes_api_approval(self):
        started = self.run_ok("hermes-api", "reboot?", session="hs-1")
        asked = self.wait_for(started["runId"], "approval.requested")
        status, body = self.call("POST", "/api/office-bridge/approve",
                                 {"run": started["runId"], "approvalId": asked["approvalId"], "approved": False, "decision": "deny"},
                                 role="member")
        self.assertEqual(status, 200, body)
        self.assertEqual(self.hermes.responses[-1], ("h-run-1", "deny"))
        evs = self.events(started["runId"])
        self.assertEqual([e["type"] for e in evs],
                         ["run.start", "run.delta", "tool.start", "tool.update", "tool.end", "approval.requested",
                          "approval.resolved", "run.delta", "run.end"])
        self.assertEqual((evs[6]["approved"], evs[6]["decision"]), (False, "deny"))
        self.assertEqual((evs[-1]["status"], evs[-1]["text"]), ("ok", "Hello"))

    def test_h_generic_providers(self):
        for agent, kinds in (
            ("opencode-main", ["run.start", "run.progress", "run.delta", "run.delta", "tool.start", "tool.end", "run.delta", "run.end"]),
            ("acme-bot", ["run.start", "run.progress", "run.delta", "run.delta", "tool.start", "tool.end", "run.delta", "run.end"]),
            ("agy-main", ["run.start", "run.progress", "run.delta", "run.end"]),
        ):
            started = self.run_ok(agent, f"hello {agent}")
            evs = self.events(started["runId"])
            self.assertEqual([e["type"] for e in evs], kinds, agent)
            self.assertEqual(evs[-1]["status"], "ok", agent)
        self.assertEqual({s[0] for s in self.registry.sent}, {"opencode", "acme", "antigravity"})
        status, sess = self.call("GET", "/api/office-bridge/sessions?agent=opencode-main")
        self.assertEqual(status, 200, sess)
        self.assertIn("opencode-s1", [s["key"] for s in sess["sessions"]])
        status, hist = self.call("GET", "/api/office-bridge/history?agent=opencode-main&session=opencode-s1")
        self.assertEqual(status, 200, hist)
        self.assertEqual(hist["messages"][-1]["role"], "assistant")
        self.assertEqual(hist["messages"][-1]["text"], "Working done.")
        self.assertEqual(hist["messages"][-1]["meta"]["steps"][0]["input"], "a.md")
        status, sess = self.call("GET", "/api/office-bridge/sessions?agent=agy-main")
        self.assertEqual((status, sess["supported"]), (200, False))

    def test_i_new_generic_chat_keeps_its_first_question(self):
        """(Was a pre-existing server.py bug, fixed at integration) a new OpenCode / Antigravity / extension chat's first
        user message is kept when its native id becomes the active session mid-run (_save_provider_run_progress now
        activates it with its mirror, instead of marking it active over the empty active file)."""
        started = self.run_ok("acme-bot", "first question")
        self.events(started["runId"])
        status, hist = self.call("GET", "/api/office-bridge/history?agent=acme-bot&session=acme-s1")
        self.assertIn("first question", [m["text"] for m in hist["messages"] if m["role"] == "user"])

    def test_j_new_chat_first_turn_kept_in_the_old_window_shape(self):
        """A new chat (the old window's call shape: @new: until the provider names its id) of a profile with no active
        session (a fresh Antigravity): its first question and answer stay, the native id becomes the active chat; a
        second new chat that resolves to the same native id (Antigravity's one conversation) adds to it, never over it."""
        kind, profile = "zeta", "fresh"
        def turn(new_id, question, answer):
            server._save_provider_session_history(kind, profile, new_id, [
                {"role": "user", "text": question, "ts": 1, "epochMs": 1, "sessionId": new_id}])
            meta = {"providerKind": kind, "profile": profile, "runId": f"r-{question}", "sessionId": "",
                    "historySessionId": new_id, "agentName": "Zeta"}
            server._save_provider_run_progress(meta, {"reply": "", "sessionId": "conv-1", "status": "running"})
            server._save_provider_run_progress(meta, {"reply": answer[:3], "sessionId": "conv-1", "status": "running"})
            server._save_provider_run_progress(meta, {"reply": answer, "sessionId": "conv-1"}, terminal=True)
        turn("@new:zeta-1", "first question", "first answer")
        self.assertEqual(server._load_provider_active_session(kind, profile).get("sessionId"), "conv-1")
        texts = [m["text"] for m in server._load_provider_session_history(kind, profile, "conv-1")]
        self.assertEqual(texts, ["first question", "first answer"])
        turn("@new:zeta-2", "second question", "second answer")
        texts = [m["text"] for m in server._load_provider_session_history(kind, profile, "conv-1")]
        self.assertEqual(texts, ["first question", "first answer", "second question", "second answer"])


    def test_k_new_antigravity_conversation_keeps_its_first_turn(self):
        """Antigravity names its conversation only with the answer: the run worker makes it the active chat with its
        transcript (the first question and answer), not over an empty active file; a second turn adds to it."""
        for text in ("conv: first question", "conv: second question"):
            started = self.run_ok("agy-main", text)
            self.events(started["runId"])
        self.assertEqual(server._load_provider_active_session("antigravity", "main").get("sessionId"), "agy-conv-1")
        rows = [(m["role"], m["text"]) for m in server._load_provider_session_history("antigravity", "main", "agy-conv-1")]
        self.assertEqual([t for r, t in rows if r == "user"], ["conv: first question", "conv: second question"])
        self.assertEqual([t for r, t in rows if r == "assistant"], ["Agy done.", "Agy done."])


if __name__ == "__main__":
    unittest.main(verbosity=1)
