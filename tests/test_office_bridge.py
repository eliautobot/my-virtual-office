"""office_chat_bridge.py with in-process fake providers (no server.py, no real CLI or account).

Golden event sequences per provider shape (Codex app-server snapshots, Codex exec one answer, Claude Code snapshots,
Hermes API partial payloads, generic turn.progress, Antigravity), replay from `since`, busy, stop, approval round trip,
history in the layer's shape, and who may call (stranger refused, member chat-only, owner manage).
Run: python3 tests/test_office_bridge.py
"""
import http.client
import http.server
import json
import os
import queue
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
import office_chat_bridge as ob  # noqa: E402

SECRET = "t" * 64
PORT = int(os.environ.get("VO_TEST_BRIDGE_PORT") or 19631)


def kinds(events):
    return [e["type"] for e in events]


def snap(**kw):
    base = {"reply": "", "tools": [], "thinking": "", "approval": None, "status": "running", "error": "", "sessionId": "th-1"}
    base.update(kw)
    return base


class TranslatorTests(unittest.TestCase):
    def feed_all(self, tr, items):
        out = tr.start()
        for name, payload in items:
            out += tr.feed(name, payload)
        return out

    def test_codex_app_server_snapshots(self):
        running = {"id": "t1", "name": "shell", "status": "running", "arguments": {"command": "ls -la"}, "result": ""}
        tr = ob.Translator("ob-1", "codex-main", "", "gpt-x")
        ev = self.feed_all(tr, [
            ("run.started", snap()),
            ("reasoning.available", snap(thinking="Looking")),
            ("reasoning.available", snap(thinking="Looking at files")),
            ("tool.started", snap(thinking="Looking at files", tools=[running])),
            ("tool.updated", snap(tools=[{**running, "result": "a\n"}])),
            ("tool.completed", snap(tools=[{**running, "status": "done", "result": "a\nb\n", "exitCode": 0}])),
            ("approval.request", snap(approval={"id": "ap-1", "kind": "command", "title": "Codex command approval required",
                                                "description": "rm x", "command": "rm x", "status": "pending"})),
            ("message.delta", snap(reply="Hel", approval=None)),
            ("message.delta", snap(reply="Hello")),
            ("usage.updated", snap(reply="Hello", tokenUsage={"last": {"totalTokens": 900, "inputTokens": 800, "outputTokens": 100},
                                                               "modelContextWindow": 200000})),
            ("run.completed", snap(reply="Hello.", ok=True)),
        ])
        self.assertEqual(kinds(ev), ["run.start", "run.delta", "run.delta", "tool.start", "tool.update", "tool.end",
                                     "approval.requested", "approval.resolved", "run.delta", "run.delta",
                                     "usage.update", "run.delta", "run.end"])
        self.assertEqual(ev[1]["thinking"], "Looking")
        self.assertEqual(ev[2]["thinking"], " at files")
        self.assertEqual(ev[3]["input"], "ls -la")
        self.assertEqual(ev[3]["toolKind"], "execute")
        self.assertEqual(ev[4]["text"], "a\n")
        self.assertEqual(ev[5]["text"], "a\nb\n")   # (tool.end carries the whole output)
        self.assertTrue(ev[5]["ok"])
        self.assertEqual(ev[5]["exitCode"], 0)
        self.assertEqual(ev[6]["options"], ["allow-once", "deny"])
        self.assertEqual(ev[6]["command"], "rm x")
        self.assertEqual(ev[7]["decision"], "closed")   # (answered outside the bridge)
        self.assertEqual(ev[10]["used"], 900)
        self.assertEqual(ev[10]["size"], 200000)
        end = ev[-1]
        self.assertEqual((end["status"], end["text"], end["model"], end["tokensIn"], end["tokensOut"]),
                         ("ok", "Hello.", "gpt-x", 800, 100))
        self.assertTrue(all(e["sessionKey"] == "th-1" for e in ev[1:]))
        self.assertEqual(tr.feed("message.delta", snap(reply="more")), [])

    def test_answer_through_bridge_resolves_once(self):
        tr = ob.Translator("ob-2", "codex-main")
        tr.start()
        tr.feed("approval.request", snap(approval={"id": "ap-9", "status": "pending"}))
        first = tr.answered("ap-9", True, "allow-once")
        again = tr.feed("message.delta", snap(reply="ok", approval=None))
        self.assertEqual(kinds(first), ["approval.resolved"])
        self.assertTrue(first[0]["approved"])
        self.assertEqual(kinds(again), ["run.delta"])

    def test_hermes_api_partial_payloads(self):
        tr = ob.Translator("ob-3", "hermes-api", "s-1")
        ev = self.feed_all(tr, [
            ("run.started", {"ok": True, "sessionId": "s-1"}),
            ("message.delta", {"delta": "Hi", "reply": "Hi"}),
            ("reasoning.available", {"text": "hmm", "thinking": "hmm"}),
            ("tool.started", {"toolCard": {"id": "h1", "name": "web_search", "status": "running", "arguments": {"query": "x"}}}),
            ("tool.completed", {"toolCard": {"id": "h1", "name": "web_search", "status": "done", "result": "found"}}),
            ("approval.request", {"approval": {"id": "ha-1", "kind": "command", "description": "sudo", "status": "pending"}}),
            ("message.delta", {"delta": " there", "reply": "Hi there"}),
            ("run.completed", {"reply": "Hi there!", "tools": [], "approval": None, "error": None}),
        ])
        self.assertEqual(kinds(ev), ["run.start", "run.delta", "run.delta", "tool.start", "tool.end", "approval.requested",
                                     "run.delta", "approval.resolved", "run.delta", "run.end"])
        self.assertEqual(ev[3]["toolKind"], "search")
        self.assertEqual(ev[4]["text"], "found")
        self.assertEqual(ev[-1]["status"], "ok")

    def test_generic_progress_replaces_and_fails(self):
        tr = ob.Translator("ob-4", "opencode-main")
        ev = self.feed_all(tr, [
            ("run.started", {"thinking": "Starting OpenCode.", "sessionId": ""}),
            ("turn.progress", {"reply": "Draft one", "sessionId": "oc-7"}),
            ("turn.progress", {"reply": "Final answer", "tools": [{"name": "read", "status": "running", "arguments": {"path": "a.md"}}]}),
            ("run.failed", {"reply": "Final answer", "error": "quota", "status": "failed",
                            "tools": [{"name": "read", "status": "running", "arguments": {"path": "a.md"}}]}),
        ])
        self.assertEqual(kinds(ev), ["run.start", "run.progress", "run.delta", "run.delta", "tool.start", "tool.end", "run.end"])
        self.assertEqual(ev[1]["text"], "Starting OpenCode.")
        self.assertTrue(ev[3]["replace"])
        self.assertEqual(ev[4]["toolKind"], "read")
        self.assertEqual(ev[5]["status"], "error")
        self.assertEqual((ev[-1]["status"], ev[-1]["error"]), ("error", "quota"))
        self.assertEqual(ev[-1]["sessionKey"], "oc-7")

    def test_antigravity_one_progress_then_answer(self):
        tr = ob.Translator("ob-5", "agy-main")
        ev = self.feed_all(tr, [("run.started", {"thinking": "Starting Antigravity."}),
                                ("run.completed", {"reply": "Done.", "status": "completed"})])
        self.assertEqual(kinds(ev), ["run.start", "run.progress", "run.delta", "run.end"])

    def test_claude_status_word_is_not_thinking(self):
        tr = ob.Translator("ob-8", "claude-main")
        ev = tr.feed("message.delta", {"reply": "Hi", "thinking": "running", "status": "running"})
        ev += tr.feed("run.completed", {"reply": "Hi!", "thinking": "Because", "status": ""})
        self.assertEqual([(e["type"], e.get("text") or e.get("thinking")) for e in ev][:3],
                         [("run.delta", "Hi"), ("run.delta", "Because"), ("run.delta", "!")])

    def test_exec_answer_in_one_snapshot_and_cancelled(self):
        tr = ob.Translator("ob-6", "codex-main")
        ev = self.feed_all(tr, [("run.completed", {"ok": True, "reply": "R", "thinking": "T", "sessionId": "th-2",
                                                    "tools": [{"id": "x", "name": "apply_patch", "status": "done", "result": "ok"}]})])
        self.assertEqual(kinds(ev), ["run.start", "run.delta", "run.delta", "tool.start", "tool.end", "run.end"])
        self.assertEqual(ev[3]["toolKind"], "edit")
        tr2 = ob.Translator("ob-7", "codex-main")
        tr2.feed("tool.started", {"tools": [{"id": "y", "name": "shell", "status": "running"}]})
        end = tr2.feed("run.cancelled", {"ok": False})
        self.assertEqual(kinds(end), ["tool.end", "run.end"])
        self.assertEqual((end[0]["status"], end[1]["status"]), ("stopped", "stopped"))

    def test_history_message_shape(self):
        msg = ob.to_layer_message({"role": "assistant", "text": "A", "epochMs": 1700000000000, "thinking": "th",
                                   "tools": [{"id": "1", "name": "shell", "status": "done", "arguments": {"command": "pwd"},
                                              "result": "/x", "exitCode": 0}],
                                   "attachments": [{"name": "a.png", "mimeType": "image/png", "path": "/secret/a.png"}]})
        self.assertEqual(msg["ts"], 1700000000000)
        self.assertEqual(msg["meta"]["steps"][0]["input"], "pwd")
        self.assertEqual(msg["meta"]["steps"][0]["kind"], "execute")
        self.assertNotIn("path", json.dumps(msg["meta"]["files"]))
        self.assertIsNone(ob.to_layer_message({"role": "approval", "text": "x"}))

    def test_tool_input_streams_then_updates_whole(self):
        # Claude Code snapshots a step while its input JSON streams ({"partial": ...}); the later snapshot's whole input
        # replaces it (tool.update input + raw), and structured arguments always cross as JSON text in raw
        tr = ob.Translator("ob-9", "claude-main")
        ev = tr.feed("tool.started", {"tools": [{"id": "t1", "name": "Bash", "status": "running",
                                                  "arguments": {"partial": '{"command": "ech'}}]})
        ev += tr.feed("tool.updated", {"tools": [{"id": "t1", "name": "Bash", "status": "running",
                                                   "arguments": {"command": "echo hi", "description": "say hi"}}]})
        ev += tr.feed("tool.updated", {"tools": [{"id": "t1", "name": "Bash", "status": "done", "result": "hi",
                                                   "arguments": {"command": "echo hi", "description": "say hi"}}]})
        steps = [e for e in ev if e["type"].startswith("tool.")]
        self.assertEqual([e["type"] for e in steps], ["tool.start", "tool.update", "tool.end"])
        self.assertNotIn("partial", json.dumps(steps[0]))
        self.assertEqual(steps[1]["input"], "echo hi")
        self.assertEqual(json.loads(steps[1]["raw"]), {"command": "echo hi", "description": "say hi"})
        tr2 = ob.Translator("ob-10", "codex-main")
        start = [e for e in tr2.feed("tool.started", {"tools": [{"id": "c", "name": "shell", "status": "running",
                                                                  "arguments": {"command": ["ls", "-a"]}}]})
                 if e["type"] == "tool.start"][0]
        self.assertEqual((start["input"], json.loads(start["raw"])), ("ls -a", {"command": ["ls", "-a"]}))

    def test_history_shows_the_persons_words(self):
        wrapped = ('[A2A from=user name="User" to=dex isUser=true sourceApp="virtual-office" sourceSurface="chat-window"]\n'
                   "Message from User via Virtual Office Chat.\n\nhello\nthere\n\n"
                   "Reply directly to the user. Do not assume the user's name unless they identify themselves.")
        self.assertEqual(ob.to_layer_message({"role": "user", "text": wrapped})["text"], "hello\nthere")
        plain = ("Message from Sam via Virtual Office Chat.\n\nhi\n\nReply directly to the user. "
                 "Do not assume a personal name unless the user provides one.\n\n"
                 "Attached files uploaded through Virtual Office:\n- a.png: /secret/a.png")
        msg = ob.to_layer_message({"role": "user", "text": plain})
        self.assertEqual((msg["text"], msg["meta"]["files"][0]["name"]), ("hi", "a.png"))
        self.assertNotIn("/secret", json.dumps(msg))
        other = "[A2A from=ops to=dex]\nMessage from Ops via Team.\n\nhi\n\nReply directly to the user."
        self.assertEqual(ob.to_layer_message({"role": "user", "text": other})["text"], other)
        self.assertEqual(ob.to_layer_message({"role": "assistant", "text": wrapped})["text"], wrapped)

    def test_caps_per_provider(self):
        full = {"chat": True, "streaming": True, "sessions": True, "sessionCreate": True, "sessionDelete": True,
                "interrupt": True, "approvals": True, "attachments": True, "tools": True}
        self.assertTrue(ob.office_caps(full, "codex", "app-server")["approvals"])
        self.assertFalse(ob.office_caps(full, "codex", "exec")["approvals"])
        agy = ob.office_caps({"chat": True, "interrupt": True, "models": True}, "antigravity", "sdk")
        self.assertEqual((agy["sessions"], agy["stop"], agy["models"], agy["attachments"]), (False, True, False, False))


class ProxyEnvTests(unittest.TestCase):
    def test_vo_host_gets_the_bridge_url(self):
        import provider_layer_proxy as plp
        with tempfile.TemporaryDirectory(prefix="vo-uA-bridge-proxy-") as tmp:
            layer = plp.ProviderLayer(tmp, env={"PATH": "/usr/bin", "VO_PL_OFFICE_URL": "http://127.0.0.1:8096",
                                                "SOME_OTHER_SECRET": "x"}, log=lambda *_: None)
            layer.node, layer.port, layer.secret_file = {"path": "node"}, 1, os.path.join(tmp, ".principal-secret")
            with mock.patch.object(plp.subprocess, "Popen") as popen:
                layer._spawn()
            env = popen.call_args.kwargs["env"]
            self.assertEqual(env["VO_PL_OFFICE_URL"], "http://127.0.0.1:8096")
            self.assertNotIn("SOME_OTHER_SECRET", env)


# ── fake office providers behind the bridge ──────────────────────────────────
class FakeOps:
    def __init__(self, root):
        self.root = root
        self.calls = []
        self.scripts = {}
        self.gates = {}
        self.interrupted = set()
        self.approvals = []
        self.uploads = os.path.join(root, "uploads")
        os.makedirs(self.uploads, exist_ok=True)
        self.layer_files = os.path.join(root, "provider-layer", "attachments")
        os.makedirs(os.path.join(self.layer_files, "1"), exist_ok=True)
        full = {"chat": True, "streaming": True, "sessions": True, "sessionCreate": True, "sessionDelete": True,
                "interrupt": True, "approvals": True, "attachments": True, "tools": True}
        self.rows = [
            {"id": "codex-main", "statusKey": "codex-main", "name": "Codex", "providerKind": "codex", "profile": "main",
             "model": "gpt-x", "capabilities": full},
            {"id": "claude-main", "statusKey": "claude-main", "name": "Claude", "providerKind": "claude-code", "profile": "main",
             "capabilities": {**full, "approvals": False}},
            {"id": "hermes-api", "statusKey": "hermes-api", "name": "Hermes", "providerKind": "hermes", "profile": "default",
             "apiAvailable": True, "providerConnectionId": "local", "capabilities": {**full, "attachments": False}},
            {"id": "hermes-pl", "statusKey": "hermes-pl", "providerKind": "hermes", "providerConnectionId": "pl-3",
             "capabilities": full},
            {"id": "adler", "statusKey": "adler", "providerKind": "openclaw", "capabilities": full},
            {"id": "agy-main", "statusKey": "agy-main", "name": "Agy", "providerKind": "antigravity", "profile": "main",
             "capabilities": {"chat": True, "interrupt": True}},
            {"id": "mute", "statusKey": "mute", "providerKind": "opencode", "capabilities": {"chat": False}},
        ]

    def roster(self):
        return self.rows

    def roster_cached(self):
        return self.rows

    def provider_label(self, kind):
        return ob.PROVIDER_LABELS.get(kind) or kind.title()

    def poke_layer(self):
        self.pokes = getattr(self, "pokes", 0) + 1

    def is_serve_agent(self, office_id):
        return False

    def codex_app_server(self):
        return True

    def models(self, ref):
        return {"models": [{"id": ref["model"], "label": ref["model"]}], "effort": [], "current": ref["model"], "readOnly": True}

    def start(self, ref, body):
        self.calls.append(("start", ref["id"], body))
        script = self.scripts.get(ref["id"], [])
        gate = self.gates.get(ref["id"])
        events = queue.Queue()
        meta = {"events": events, "done": False}
        rid = f"native-{len(self.calls)}"

        def work():
            for name, payload in script:
                if name == "wait":
                    while not gate.is_set() and rid not in self.interrupted:
                        time.sleep(0.01)
                    if rid in self.interrupted:
                        events.put({"event": "run.cancelled", "data": {"ok": False}})
                        break
                    continue
                events.put({"event": name, "data": payload})
            meta["done"] = True

        threading.Thread(target=work, daemon=True).start()
        return {"ok": True, "runId": rid, "sessionId": body.get("sessionId") or "", "_streamObject": ob.QueueStream(meta),
                "_stream": ref["transport"]}

    def interrupt(self, ref, native_run_id, native_kind):
        self.interrupted.add(native_run_id)
        return {"ok": True}

    def respond_approval(self, ref, approval, approved):
        self.approvals.append((approval["id"], approved))
        self.gates[ref["id"]].set()
        return {"ok": True}

    def sessions(self, ref, limit, manage):
        self.calls.append(("sessions", ref["id"], manage))
        return {"ok": True, "sessions": [{"id": "th-1", "title": "First", "updatedAt": 1700000000, "active": True}],
                "activeSessionId": "th-1"}, 200

    def create_session(self, ref):
        return {"ok": True, "sessionId": "", "newSessionPending": True}, 200

    def delete_session(self, ref, session):
        self.calls.append(("delete", ref["id"], session))
        return {"ok": True}, 200

    def history(self, ref, session):
        return {"messages": [{"role": "user", "text": "hi", "ts": 1}, {"role": "assistant", "text": "yo", "ts": 2}],
                "tokenUsage": {"last": {"totalTokens": 5}, "modelContextWindow": 10}}

    def attachment_roots(self):
        return [self.layer_files]

    def store_attachment(self, src, name, mime):
        dest = os.path.join(self.uploads, "copy-" + name)
        with open(src, "rb") as a, open(dest, "wb") as b:
            b.write(a.read())
        return {"path": dest, "name": name, "mimeType": mime, "size": os.path.getsize(dest)}


class Handler(http.server.BaseHTTPRequestHandler):
    bridge = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.bridge.handle(self)

    def do_POST(self):
        self.bridge.handle(self)


class BridgeHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="vo-uA-bridge-")
        cls.ops = FakeOps(cls.tmp.name)
        cls.bridge = ob.Bridge(cls.ops, secret=lambda: SECRET, watch_s=0.05)
        Handler.bridge = cls.bridge
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None, role="owner", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
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
            return resp.status, raw.decode("utf-8", "replace")

    def sse(self, run_id, since=0):
        conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
        conn.request("GET", f"/api/office-bridge/runs/events?run={run_id}&since={since}",
                     headers={ob.PRINCIPAL_HEADER: ob.sign_principal(SECRET, {"role": "member", "via": "layer"})})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "text/event-stream")
        text = resp.read().decode()
        conn.close()
        out = []
        for block in text.split("\n\n"):
            lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line and not line.startswith(":"))
            if "data" in lines:
                out.append((int(lines.get("id", 0)), json.loads(lines["data"])))
        return out

    def wait_type(self, run_id, kind, timeout=5):
        deadline, since = time.time() + timeout, 0
        while time.time() < deadline:
            status, page = self.call("GET", f"/api/office-bridge/runs/events?run={run_id}&since={since}&json=1&wait=1")
            self.assertEqual(status, 200)
            for e in page["events"]:
                since = e["id"]
                if e["type"] == kind:
                    return e
            if page["done"]:
                break
        self.fail(f"no {kind} in {run_id}")

    def test_strangers_are_refused(self):
        status, body = self.call("GET", "/api/office-bridge/agents", role=None)
        self.assertEqual((status, body["code"]), (401, "signin_required"))
        forged = ob.sign_principal("wrong-secret", {"role": "owner"})
        status, body = self.call("GET", "/api/office-bridge/agents", role=None, headers={ob.PRINCIPAL_HEADER: forged})
        self.assertEqual(status, 401)
        bad_role = ob.sign_principal(SECRET, {"role": "admin"})
        status, _ = self.call("GET", "/api/office-bridge/agents", role=None, headers={ob.PRINCIPAL_HEADER: bad_role})
        self.assertEqual(status, 401)
        status, body = self.call("GET", "/api/office-bridge/agents", headers={"X-Forwarded-For": "203.0.113.9"})
        self.assertEqual((status, body["code"]), (403, "forbidden"))
        off = ob.Bridge(self.ops, secret=lambda: None)   # (the layer is off: no secret, nobody gets in)
        with self.assertRaises(ob.BridgeError):
            off.principal("127.0.0.1", {ob.PRINCIPAL_HEADER: ob.sign_principal(SECRET, {"role": "owner"})})
        with self.assertRaises(ob.BridgeError):
            self.bridge.principal("192.168.1.5", {ob.PRINCIPAL_HEADER: ob.sign_principal(SECRET, {"role": "owner"})})

    def test_agents_and_caps(self):
        status, body = self.call("GET", "/api/office-bridge/agents", role="member")
        self.assertEqual(status, 200)
        ids = [a["officeId"] for a in body["agents"]]
        self.assertEqual(ids, ["codex-main", "claude-main", "hermes-api", "agy-main"])
        by = {a["officeId"]: a for a in body["agents"]}
        self.assertEqual((by["codex-main"]["provider"], by["codex-main"]["transport"]), ("codex", "app-server"))
        self.assertEqual((by["codex-main"]["providerLabel"], by["claude-main"]["providerLabel"]), ("Codex", "Claude Code"))
        self.assertEqual(by["hermes-api"]["transport"], "api")
        self.assertFalse(by["agy-main"]["caps"]["sessions"])
        self.assertFalse(by["hermes-api"]["caps"]["attachments"])
        status, models = self.call("GET", "/api/office-bridge/models?agent=codex-main")
        self.assertEqual((models["current"], models["readOnly"]), ("gpt-x", True))
        status, body = self.call("GET", "/api/office-bridge/models?agent=adler")
        self.assertEqual((status, body["code"]), (404, "not_office_agent"))

    def test_agents_change_pokes_the_layer(self):
        self.call("GET", "/api/office-bridge/agents")
        time.sleep(0.2)
        before = getattr(self.ops, "pokes", 0)
        self.ops.rows.append({"id": "new-oc", "statusKey": "new-oc", "providerKind": "opencode", "profile": "n",
                              "capabilities": {"chat": True}})
        try:
            deadline = time.time() + 3
            while getattr(self.ops, "pokes", 0) == before and time.time() < deadline:
                time.sleep(0.02)
            self.assertEqual(getattr(self.ops, "pokes", 0), before + 1)
            time.sleep(0.2)
            self.assertEqual(getattr(self.ops, "pokes", 0), before + 1)   # (once per change, not on every look)
        finally:
            self.ops.rows.pop()
            time.sleep(0.2)

    def test_sessions_history_and_manage_flag(self):
        status, body = self.call("GET", "/api/office-bridge/sessions?agent=codex-main", role="member")
        self.assertEqual(body["sessions"][0], {"key": "th-1", "title": "First", "preview": None,
                                               "updatedAt": 1700000000000, "active": True})
        self.assertIn(("sessions", "codex-main", False), self.ops.calls)
        self.call("GET", "/api/office-bridge/sessions?agent=codex-main", role="owner")
        self.assertIn(("sessions", "codex-main", True), self.ops.calls)
        status, body = self.call("GET", "/api/office-bridge/sessions?agent=agy-main")
        self.assertEqual((status, body["supported"]), (200, False))
        status, body = self.call("GET", "/api/office-bridge/history?agent=codex-main&session=th-1")
        self.assertEqual([m["role"] for m in body["messages"]], ["user", "assistant"])
        self.assertEqual(body["usage"], {"used": 5, "size": 10})
        status, body = self.call("POST", "/api/office-bridge/sessions/create", {"agent": "codex-main"})
        self.assertEqual(body["session"]["pending"], True)
        status, body = self.call("POST", "/api/office-bridge/sessions/delete", {"agent": "codex-main", "session": "th-1"})
        self.assertEqual(status, 200)
        status, body = self.call("POST", "/api/office-bridge/sessions/create", {"agent": "agy-main"})
        self.assertEqual(status, 501)
        status, body = self.call("POST", "/api/office-bridge/sessions/rename", {"agent": "codex-main", "session": "x"})
        self.assertEqual(status, 501)

    def test_codex_run_approval_busy_replay(self):
        gate = threading.Event()
        self.ops.gates["codex-main"] = gate
        self.ops.scripts["codex-main"] = [
            ("run.started", snap(sessionId="th-1")),
            ("tool.started", snap(tools=[{"id": "t1", "name": "shell", "status": "running", "arguments": {"command": "make"}}])),
            ("approval.request", snap(approval={"id": "ap-1", "kind": "command", "description": "make", "status": "pending"})),
            ("wait", None),
            ("tool.completed", snap(tools=[{"id": "t1", "name": "shell", "status": "done", "result": "built"}])),
            ("message.delta", snap(reply="Built.")),
            ("run.completed", snap(reply="Built.", ok=True)),
        ]
        status, started = self.call("POST", "/api/office-bridge/runs", {"agent": "codex-main", "session": "th-1", "input": "build"},
                                    role="member")
        self.assertEqual(status, 200, started)
        run = started["runId"]
        self.assertEqual(started["sessionKey"], "th-1")
        asked = self.wait_type(run, "approval.requested")
        status, busy = self.call("POST", "/api/office-bridge/runs", {"agent": "codex-main", "session": "th-2", "input": "again"})
        self.assertEqual((status, busy["code"], busy["runId"]), (409, "busy", run))
        status, hist = self.call("GET", "/api/office-bridge/history?agent=codex-main&session=th-1")
        self.assertEqual(hist["running"]["runId"], run)
        status, body = self.call("POST", "/api/office-bridge/approve", {"run": run, "approvalId": "nope", "approved": True})
        self.assertEqual((status, body["code"]), (409, "not_pending"))
        status, body = self.call("POST", "/api/office-bridge/approve",
                                 {"run": run, "approvalId": asked["approvalId"], "approved": True, "decision": "allow-once"})
        self.assertEqual(status, 200, body)
        self.assertEqual(self.ops.approvals, [("ap-1", True)])
        events = self.sse(run)
        self.assertEqual([e["type"] for _, e in events],
                         ["run.start", "tool.start", "approval.requested", "approval.resolved", "tool.end",
                          "run.delta", "run.end"])
        self.assertEqual([i for i, _ in events], list(range(1, 8)))
        self.assertEqual(events[4][1]["text"], "built")
        resolved = events[3][1]
        self.assertEqual((resolved["approved"], resolved["decision"]), (True, "allow-once"))
        self.assertEqual(events[-1][1]["status"], "ok")
        replay = self.sse(run, since=5)
        self.assertEqual([i for i, _ in replay], [6, 7])
        self.assertEqual(replay, events[5:])
        start_body = [c for c in self.ops.calls if c[0] == "start"][-1][2]
        self.assertEqual((start_body["sessionId"], start_body["message"], start_body["fromType"]), ("th-1", "build", "human"))
        status, again = self.call("POST", "/api/office-bridge/runs", {"agent": "codex-main", "session": "", "input": "next"})
        self.assertEqual(status, 200)   # (the lock is free once the run ended)
        new_body = [c for c in self.ops.calls if c[0] == "start"][-1][2]
        self.assertTrue(new_body["newSessionPending"])
        self.assertNotIn("sessionId", new_body)
        self.sse(again["runId"])

    def test_provider_error_is_a_500_answer(self):
        with mock.patch.object(self.ops, "history", side_effect=RuntimeError("disk gone")):
            status, body = self.call("GET", "/api/office-bridge/history?agent=codex-main&session=th-1")
        self.assertEqual((status, body["code"]), (500, "internal_error"))
        self.assertIn("disk gone", body["error"])

    def test_stop_ends_stopped(self):
        self.ops.gates["claude-main"] = threading.Event()
        self.ops.scripts["claude-main"] = [("run.started", {}), ("message.delta", {"reply": "Work"}), ("wait", None),
                                           ("run.completed", {"reply": "never"})]
        status, started = self.call("POST", "/api/office-bridge/runs", {"agent": "claude-main", "input": "go"})
        run = started["runId"]
        self.wait_type(run, "run.delta")
        status, body = self.call("POST", "/api/office-bridge/stop", {"run": run})
        self.assertEqual((status, body["stopped"]), (200, True))
        events = self.sse(run)
        self.assertEqual([e["type"] for _, e in events], ["run.start", "run.delta", "run.end"])
        self.assertEqual((events[-1][1]["status"], events[-1][1]["text"]), ("stopped", "Work"))
        status, body = self.call("POST", "/api/office-bridge/stop", {"run": run})
        self.assertEqual(body["stopped"], False)
        status, body = self.call("GET", "/api/office-bridge/runs/events?run=ob-missing&json=1")
        self.assertEqual(status, 404)

    def test_attachments(self):
        good = os.path.join(self.ops.layer_files, "1", "abc123")
        with open(good, "wb") as f:
            f.write(b"hello")
        outside = os.path.join(self.tmp.name, "secret.txt")
        with open(outside, "wb") as f:
            f.write(b"no")
        self.ops.scripts["claude-main"] = [("run.completed", {"reply": "seen"})]
        status, body = self.call("POST", "/api/office-bridge/runs", {"agent": "claude-main", "input": "look", "attachments": [
            {"name": "a.txt", "mime": "text/plain", "size": 5, "path": good}]})
        self.assertEqual(status, 200, body)
        sent = [c for c in self.ops.calls if c[0] == "start"][-1][2]["attachments"]
        self.assertEqual(sent[0]["name"], "a.txt")
        self.assertTrue(sent[0]["path"].startswith(self.ops.uploads))
        self.sse(body["runId"])
        for path in (outside, os.path.join(self.ops.layer_files, "1", "..", "..", "..", "secret.txt")):
            status, body = self.call("POST", "/api/office-bridge/runs", {"agent": "claude-main", "input": "x",
                                                                          "attachments": [{"name": "s", "path": path}]})
            self.assertEqual((status, body["code"]), (400, "bad_attachment_path"))
        status, body = self.call("POST", "/api/office-bridge/runs", {"agent": "hermes-api", "input": "x",
                                                                      "attachments": [{"name": "a", "path": good}]})
        self.assertEqual((status, body["code"]), (400, "no_attachments"))
        status, body = self.call("POST", "/api/office-bridge/runs", {"agent": "claude-main", "input": "  "})
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main(verbosity=1)
