"""hp-core B3a: /api/agent-chat/* and /api/agent-providers/* on the real handler.

Hermes side uses a small stub adapter registered here (hp-hermes builds the real one in B2;
B3b adds the Hermes end-to-end tests against tests/helpers/fake_hermes.py). OpenClaw side
uses the real OpenClawGatewayClient + OpenClawAdapter on tests/helpers/fake_gateway.py.
"""

import atexit
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-hp-routes-")
atexit.register(_SERVER_DATA.cleanup)
(Path(_SERVER_DATA.name) / "openclaw").mkdir()
os.environ.setdefault("VO_STATUS_DIR", _SERVER_DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_SERVER_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_SERVER_DATA.name) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

TESTS = Path(__file__).resolve().parent
APP_ROOT = TESTS.parents[0] / "app"
for _path in (str(APP_ROOT), str(TESTS)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from websockets.asyncio.client import connect  # noqa: E402

import server  # noqa: E402
import agent_providers as ap  # noqa: E402
import gateway_presence  # noqa: E402
import provider_hub  # noqa: E402
import vo_access  # noqa: E402
from helpers.fake_gateway import FakeGateway  # noqa: E402
from openclaw_adapter import OpenClawAdapter  # noqa: E402
from openclaw_gateway_client import OpenClawGatewayClient  # noqa: E402

LAB_TOKEN = "hp-routes-secret-token-31f"


def wait_for(predicate, timeout=4.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class StubHermes:
    """Stands in for hp-hermes's adapter: profiles, a scripted run, approvals, sessions."""

    kind = "hermes"

    def __init__(self):
        self.connected = True
        self.profiles = [{"name": "default"}, {"name": "research", "display_name": "Research"},
                         {"name": "wizard", "role": "setup"}]
        self.listeners = []
        self.calls = []

    def status(self, cid):
        if self.connected:
            return {"state": "connected", "code": "", "detail": "Connected to Hermes 0.22.", "fix": "", "version": "0.22"}
        return {"state": "offline", "code": "unreachable", "detail": "Hermes is not answering.", "fix": "", "version": ""}

    def agents(self, cid):
        if not self.connected:
            raise RuntimeError("offline")
        return list(self.profiles)

    def on_event(self, callback):
        self.listeners.append(callback)
        return lambda: callback in self.listeners and self.listeners.remove(callback)

    def emit(self, cid, profile, session, **event):
        for callback in list(self.listeners):
            callback(dict(event, connectionId=cid, agentId=profile, sessionKey=session))

    def can(self, agent, key=None, *, manage=False):
        self.calls.append(("can", str(agent), agent.cid, agent.office_id))
        return {"ok": True, "caps": {"stream": True, "sessions": True, "screen": True, "computerWrite": True,
                                     "approvals": True, "approvalOptions": ["allow-once", "deny"]}}

    def run(self, agent, key, text, files, queue):
        self.calls.append(("run", str(agent), agent.cid, key, text))
        run_id = f"run-{len(self.calls)}"
        cid, profile = agent.cid, str(agent)

        def script():
            self.emit(cid, profile, key, type="run.start", runId=run_id, model="m1")
            self.emit(cid, profile, key, type="run.delta", runId=run_id, text="Hel", at=0)
            self.emit(cid, profile, key, type="run.delta", runId=run_id, text="lo", at=3)
            self.emit(cid, profile, key, type="approval.requested", runId=run_id, approvalId="ap1",
                      options=["allow-once", "deny"], command="ls")
        threading.Timer(0.05, script).start()
        return {"runId": run_id, "session": {"key": key}, "status": "started"}

    def approve(self, agent, key, run_id, approval_id, decision):
        self.calls.append(("approve", key, run_id, approval_id, decision))
        self.emit(agent.cid, str(agent), key, type="approval.resolved", runId=run_id, approvalId=approval_id,
                  decision=decision)
        self.emit(agent.cid, str(agent), key, type="run.end", runId=run_id, status="ok", text="Hello",
                  media=[{"ref": "/home/hermes/out.png", "name": "out.png", "mime": "image/png"}])
        return {"ok": True}

    def media(self, agent, key, ref):
        self.calls.append(("media", str(agent), key, ref))
        return b"\x89PNG-fake", "image/png"

    def state(self, agent, key):
        return {}

    def sessions(self, agent):
        return {"sessions": [{"key": "s1", "title": "One"}, {"key": "s2", "title": "Two"}]}

    def session_op(self, agent, op, key, args):
        self.calls.append(("session_op", op, key))
        return {"ok": True}

    def screen_state(self, agent):
        return {"available": True}

    def menu(self, cid, method, params):
        self.calls.append(("menu", cid, method))
        return {"done": method}

    def close(self, cid, reason=""):
        self.calls.append(("close", cid, reason))


class SSE:
    """A tiny EventSource: frames are the parsed `data:` objects, `_id` the `id:` line."""

    def __init__(self, port, path, headers=None):
        self.conn = http.client.HTTPConnection("127.0.0.1", port, timeout=6)
        self.conn.request("GET", path, headers=headers or {})
        self.res = self.conn.getresponse()
        self.status = self.res.status
        self.frames = []
        if self.status == 200:
            threading.Thread(target=self._read, daemon=True).start()
        else:
            self.body = json.loads(self.res.read().decode() or "{}")

    def _read(self):
        current, data = None, []
        try:
            for raw in iter(self.res.fp.readline, b""):
                line = raw.decode("utf-8").rstrip("\n")
                if line.startswith("id: "):
                    current = int(line[4:])
                elif line.startswith("data: "):
                    data.append(line[6:])
                elif line == "" and data:
                    frame = json.loads("\n".join(data))
                    frame["_id"] = current
                    self.frames.append(frame)
                    current, data = None, []
        except (OSError, ValueError):
            pass

    def types(self):
        out = []
        for frame in self.frames:
            event = frame.get("event")
            out.append(event.get("type") if isinstance(event, dict) else (event or frame.get("type")))
        return out

    def wait(self, predicate, timeout=4.0):
        return wait_for(lambda: predicate(self), timeout)

    def close(self):
        # http.client drops conn.sock for a streamed answer while res.fp keeps the socket open: shut the raw socket,
        # so the server's stream ends (and frees its slot) within about a second.
        sock = self.conn.sock or getattr(getattr(getattr(getattr(self, "res", None), "fp", None), "raw", None),
                                         "_sock", None)
        try:
            if sock is not None:
                sock.shutdown(2)
        except OSError:
            pass
        try:
            self.res.close()
        except Exception:  # noqa: BLE001 - the reader thread may hold it
            pass
        self.conn.close()


class RoutesBase(unittest.TestCase):
    def setUp(self):
        # SSE streams of the previous test end at their next heartbeat write: wait, so the 8-per-address cap
        # never refuses this test's streams.
        wait_for(lambda: not any(provider_hub._STREAMS.values()), 5)
        self.temp = tempfile.TemporaryDirectory(prefix="vo-hp-b3a-")
        self.status = Path(self.temp.name) / "status"
        self.status.mkdir()
        cfg = {"hermes": {"connections": [{"id": "astra", "name": "Astra", "apiUrl": "http://127.0.0.1:8642",
                                           "apiKey": "legacy-key", "enabled": True}]},
               "openclaw": {"gatewayUrl": "ws://127.0.0.1:9", "gatewayToken": "gw-token"}}
        self.cfg_path = self.status / "vo-config.json"
        self.cfg_path.write_text(json.dumps(cfg))
        self.store = vo_access.AccessStore(str(self.status))
        self.vo_cfg = dict(server.VO_CONFIG, hermes=cfg["hermes"],
                           openclaw=dict(server.VO_CONFIG["openclaw"], **cfg["openclaw"]))
        self.roster = {"main": {"id": "main", "statusKey": "main", "providerKind": "openclaw"},
                       "ops": {"id": "ops", "statusKey": "ops", "providerKind": "openclaw"},
                       "hermes-astra": {"id": "hermes-astra", "providerKind": "hermes", "providerAgentId": "astra",
                                        "providerConnectionId": "astra", "capabilities": ["chat", "sessions"]}}
        self.hermes = StubHermes()
        self.openclaw_adapter = None
        self.patches = [
            mock.patch.object(server, "STATUS_DIR", str(self.status)),
            mock.patch.object(server, "ACCESS_STORE", self.store),
            mock.patch.object(server, "VO_CONFIG", self.vo_cfg),
            mock.patch.dict(os.environ, {"VO_STATUS_DIR": str(self.status), "VO_CONFIG": str(self.cfg_path)}),
            mock.patch.object(server, "_reload_provider_settings_runtime", self._reload_cfg),
            mock.patch.object(server, "_hp_legacy_status", lambda row: {"state": "connected", "code": "",
                                                                        "detail": "ok", "fix": "", "version": ""}),
            mock.patch.object(server, "_hp_openclaw_info", lambda: {"url": "ws://127.0.0.1:9", "tokenSet": True,
                                                                    "tokenSource": "office", "agents": [],
                                                                    "status": {"state": "offline"}}),
            mock.patch.object(server, "_hp_legacy_agents", lambda: {}),
            mock.patch.object(server, "_hp_roster_agent", lambda agent_id: self.roster.get(agent_id)),
            mock.patch.object(server, "_hp_refresh_discovery", lambda: None),
            mock.patch.object(server, "_hp_openclaw_start", self._start_openclaw),
            mock.patch.object(provider_hub, "HEARTBEAT_SEC", 0.3),
        ]
        for p in self.patches:
            p.start()
        server._hp_configure(str(self.status))
        ap.register_adapter("hermes", self.hermes)
        ap.migrate(str(self.status), str(self.cfg_path))
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        self.httpd.block_on_close = False
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]
        self.streams = []

    def _reload_cfg(self):
        self.vo_cfg.update(json.loads(self.cfg_path.read_text()))

    def _start_openclaw(self):
        if self.openclaw_adapter is not None:
            self.openclaw_adapter.start()

    def tearDown(self):
        for stream in self.streams:
            stream.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        if self.openclaw_adapter is not None:
            self.openclaw_adapter.close()
        for p in reversed(self.patches):
            p.stop()
        with ap._ADAPTERS_LOCK:
            ap._ADAPTERS.pop("hermes", None)
        off = ap._LISTENER_OFF.pop("hermes", None)
        if callable(off):
            off()
        server._HP_OPENCLAW["adapter"] = None
        server._hp_configure()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        hdrs = {"Content-Type": "application/json"} if data else {}
        hdrs.update(headers or {})
        conn.request(method, path, body=data, headers=hdrs)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        try:
            return res.status, json.loads(raw.decode("utf-8"))
        except ValueError:
            return res.status, raw

    def sse(self, path, headers=None):
        stream = SSE(self.port, path, headers)
        self.streams.append(stream)
        return stream

    def save_lab(self, **values):
        payload = {"kind": "hermes", "transport": "serve",
                   "values": dict({"name": "Lab", "url": "http://127.0.0.1:19128", "auth": "token",
                                   "token": LAB_TOKEN, "access": "full"}, **values)}
        status, out = self.request("POST", "/api/agent-providers/save", payload)
        self.assertEqual(status, 200, out)
        return out["id"]

    def lab_row(self):
        status, listing = self.request("GET", "/api/agent-providers")
        self.assertEqual(status, 200, listing)
        return next(p for p in listing["providers"] if p["id"] == "lab")


class HermesServeRoutes(RoutesBase):
    def test_agents_get_stable_ids_cache_and_legacy_hiding(self):
        self.save_lab()
        agents = {a["nativeId"]: a for a in self.lab_row()["agents"]}
        self.assertEqual(set(agents), {"default", "research"})  # setup profile dropped
        self.assertEqual(agents["default"]["id"], "hermes-lab")
        self.assertEqual(agents["research"]["id"], "hermes-lab-research")
        self.hermes.profiles.append({"name": "scout"})
        again = {a["nativeId"]: a["id"] for a in self.lab_row()["agents"]}
        self.assertEqual(again, {"default": "hermes-lab", "research": "hermes-lab-research",
                                 "scout": "hermes-lab-scout"})
        self.hermes.connected = False  # Hermes restarting: the last good list stays
        self.assertEqual({a["nativeId"]: a["id"] for a in self.lab_row()["agents"]}, again)
        cache = json.loads((self.status / ap.AGENTS_CACHE_FILE).read_text())
        self.assertEqual([p["profile"] for p in cache["lab"]["profiles"]], ["default", "research", "scout"])
        self.hermes.connected = True
        rows = {r["id"]: r for r in ap.discovery_rows()}
        self.assertEqual(rows["hermes-lab-research"]["providerTransport"], "serve")
        self.assertEqual(rows["hermes-lab-research"]["providerConnectionId"], "lab")
        self.assertEqual(server._discovery_agent_key(rows["hermes-lab"]), ("hermes-serve", "hermes-lab"))
        # An enabled API-server row that reaches "research" hides that profile (one agent per profile).
        ap._store().update(lambda d: d["legacy"]["astra"].update(profile="research"))
        listed = {a["nativeId"]: a for a in self.lab_row()["agents"]}
        self.assertTrue(listed["research"]["hidden"])
        self.assertIn('older connection "Astra"', listed["research"]["reason"])
        self.assertNotIn("hermes-lab-research", {r["id"] for r in ap.discovery_rows()})
        status, raw = self.request("GET", "/api/agent-providers")
        self.assertNotIn(LAB_TOKEN, json.dumps(raw))

    def test_switch_keeps_the_legacy_id_and_hides_nothing_twice(self):
        self.save_lab()
        self.lab_row()
        ap._store().update(lambda d: d["legacy"]["astra"].update(profile="research"))
        status, out = self.request("POST", "/api/agent-providers/switch",
                                   {"to": "lab", "moves": [{"legacyId": "astra", "profile": "research"}]})
        self.assertEqual(status, 200, out)
        self.assertEqual(out["moved"], [{"legacyId": "astra", "agentId": "hermes-astra", "profile": "research"}])
        self.assertEqual(ap.find_connection("lab")["profileAgents"]["research"], "hermes-astra")
        self.assertFalse(json.loads(self.cfg_path.read_text())["hermes"]["connections"][0]["enabled"])
        ids = [r["id"] for r in ap.discovery_rows()]
        self.assertEqual(sorted(ids), ["hermes-astra", "hermes-lab"])
        self.assertEqual(len(ids), len(set(ids)))
        listing = self.request("GET", "/api/agent-providers")[1]["providers"]
        lab = next(p for p in listing if p["id"] == "lab")
        self.assertFalse(any(a["hidden"] for a in lab["agents"]))
        legacy = next(p for p in listing if p["id"] == "astra")
        self.assertTrue(all(a["hidden"] for a in legacy["agents"]))
        target = ap.resolve_agent("hermes-astra")
        self.assertEqual((target.transport, target.cid, target.native), ("hermes-serve", "lab", "research"))
        status, out = self.request("POST", "/api/agent-providers/switch",
                                   {"to": "lab", "moves": [{"legacyId": "astra", "profile": "research"}]})
        self.assertEqual((status, out["error"]), (409, "conflict"))
        status, out = self.request("POST", "/api/agent-providers/switch-back", {"legacyId": "astra"})
        self.assertEqual(status, 200, out)
        self.assertEqual(ap.find_connection("lab")["profileAgents"]["research"], "hermes-lab-research")
        self.assertTrue(json.loads(self.cfg_path.read_text())["hermes"]["connections"][0]["enabled"])
        self.assertEqual([r["id"] for r in ap.discovery_rows()], ["hermes-lab"])  # research hidden again

    def test_run_streams_with_seq_resume_without_doubles_and_chats_stay_apart(self):
        self.save_lab()
        self.lab_row()
        status, can = self.request("GET", "/api/agent-chat/can?agent=hermes-lab-research")
        self.assertEqual(status, 200, can)
        self.assertEqual((can["transport"], can["view"], can["access"]), ("hermes-serve", "hermes", "full"))
        self.assertEqual(self.hermes.calls[-1], ("can", "research", "lab", "hermes-lab-research"))
        one = self.sse("/api/agent-chat/events?agent=hermes-lab-research&session=s1")
        two = self.sse("/api/agent-chat/events?agent=hermes-lab-research&session=s2")
        other = self.sse("/api/agent-chat/events?agent=hermes-lab&session=s1")
        self.assertEqual((one.status, two.status, other.status), (200, 200, 200))
        time.sleep(0.15)
        status, out = self.request("POST", "/api/agent-chat/runs",
                                   {"agent": "hermes-lab-research", "session": "s1", "text": "hi", "clientId": "c1"})
        self.assertEqual(status, 200, out)
        self.assertEqual((out["status"], out["clientId"]), ("started", "c1"))
        self.assertTrue(one.wait(lambda s: "approval.requested" in s.types()), one.types())
        seqs = [f["_id"] for f in one.frames]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(seqs), len(set(seqs)))
        time.sleep(0.3)
        self.assertEqual([t for t in two.types() if t != "provider.status"], [])
        self.assertEqual([t for t in other.types() if t != "provider.status"], [])
        # Reload: resume after the second frame; nothing before it comes twice.
        resumed = self.sse("/api/agent-chat/events?agent=hermes-lab-research&session=s1",
                           headers={"Last-Event-ID": str(seqs[1])})
        self.assertTrue(resumed.wait(lambda s: len(s.frames) >= len(seqs) - 2))
        self.assertEqual([f["_id"] for f in resumed.frames], seqs[2:])
        state = self.request("GET", "/api/agent-chat/state?agent=hermes-lab-research&session=s1")[1]
        run = state["runs"][0]
        self.assertEqual((run["text"], run["approvals"][0]["status"], state["working"]), ("Hello", "pending", True))
        self.assertGreaterEqual(state["seq"], seqs[-1])
        status, out = self.request("POST", "/api/agent-chat/approvals",
                                   {"agent": "hermes-lab-research", "session": "s1", "run": run["runId"],
                                    "approval": "ap1", "decision": "allow-session"})
        self.assertEqual(status, 200, out)
        self.assertEqual(self.hermes.calls[-1], ("approve", "s1", run["runId"], "ap1", "allow-session"))
        self.assertTrue(one.wait(lambda s: "run.end" in s.types()))
        end = next(f for f in one.frames if f["event"]["type"] == "run.end")
        url = end["event"]["media"][0]["url"]
        self.assertTrue(url.startswith("/api/agent-chat/media?t="))
        self.assertNotIn("/home/hermes", url)
        status, data = self.request("GET", url)
        self.assertEqual((status, data), (200, b"\x89PNG-fake"))
        self.assertEqual(self.hermes.calls[-1], ("media", "research", "s1", "/home/hermes/out.png"))
        status, out = self.request("POST", "/api/agent-chat/approvals",
                                   {"agent": "hermes-lab-research", "session": "s1", "approval": "ap1",
                                    "decision": "maybe"})
        self.assertEqual((status, out["error"]), (400, "invalid"))

    def test_gates_chat_sessions_and_hermes_test(self):
        self.save_lab()
        self.lab_row()
        self.store.set_passcode("open-sesame")
        token = self.store.agent_token()
        auth = {"Authorization": f"Bearer {token}"}
        with mock.patch.object(vo_access, "is_loopback_ip", return_value=False):
            status, out = self.request("GET", "/api/agent-chat/can?agent=hermes-lab", headers=auth)
            self.assertEqual((status, out["manage"]), (200, False))
            status, out = self.request("POST", "/api/agent-chat/runs",
                                       {"agent": "hermes-lab", "session": "s1", "text": "hi"}, headers=auth)
            self.assertEqual((status, out["error"]), (403, "forbidden"))
            status, out = self.request("GET", "/api/hermes/test", headers=auth)
            self.assertEqual((status, out["error"]), (403, "forbidden"))
        self.store.set_passcode("")
        status, out = self.request("GET", "/api/office/chat-sessions?agentId=hermes-lab")
        self.assertEqual(status, 200, out)
        self.assertEqual([s["id"] for s in out["sessions"]], ["s1", "s2"])
        status, out = self.request("POST", "/api/office/chat-sessions/switch", {"agentId": "hermes-lab", "sessionId": "s2"})
        self.assertEqual(status, 200, out)
        out = self.request("GET", "/api/office/chat-sessions?agentId=hermes-lab")[1]
        self.assertEqual((out["activeSessionId"], [s["active"] for s in out["sessions"]]), ("s2", [False, True]))
        status, out = self.request("POST", "/api/office/chat-sessions/delete", {"agentId": "hermes-lab", "sessionId": "s2"})
        self.assertEqual(status, 200, out)
        self.assertEqual(self.hermes.calls[-1], ("session_op", "delete", "s2"))
        # Chat only: the screen is locked in the manifest and refused by the route.
        ap._store().update(lambda d: ap.find_connection("lab", d).update(access="chat"))
        can = self.request("GET", "/api/agent-chat/can?agent=hermes-lab")[1]
        self.assertFalse(can["caps"]["screen"])
        self.assertIn("chat only", can["locked"]["screen"])
        status, out = self.request("GET", "/api/agent-chat/screen?agent=hermes-lab")
        self.assertEqual((status, out["error"]), (403, "chat_only"))
        # Legacy agents keep their own path: manifest from registry flags, other routes refused.
        can = self.request("GET", "/api/agent-chat/can?agent=hermes-astra")[1]
        self.assertEqual((can["transport"], can["caps"]["models"], can["caps"]["queue"]), ("hermes-api", False, "local"))
        status, out = self.request("GET", "/api/agent-chat/history?agent=hermes-astra&session=x")
        self.assertEqual((status, out["error"]), (400, "unsupported"))

    def test_provider_call_sync_test_and_detect(self):
        self.save_lab()
        self.lab_row()
        status, out = self.request("POST", "/api/agent-providers/call", {"id": "lab", "method": "skills.list"})
        self.assertEqual((status, out["result"]), (200, {"done": "skills.list"}))
        audit = self.status / ap.AUDIT_FILE
        self.assertFalse(audit.exists())  # reads are not audited
        status, out = self.request("POST", "/api/agent-providers/call",
                                   {"id": "lab", "method": "config.patch", "params": {"x": "secret-value"}})
        self.assertEqual(status, 200, out)
        lines = audit.read_text().splitlines()
        self.assertEqual(json.loads(lines[-1])["method"], "config.patch")
        self.assertNotIn("secret-value", audit.read_text())
        ap._store().update(lambda d: ap.find_connection("lab", d).update(access="chat"))
        status, out = self.request("POST", "/api/agent-providers/call", {"id": "lab", "method": "config.patch"})
        self.assertEqual((status, out["error"]), (403, "chat_only"))
        status, out = self.request("POST", "/api/agent-providers/call", {"id": "lab", "method": "bad method!"})
        self.assertEqual((status, out["error"]), (400, "invalid"))
        status, out = self.request("POST", "/api/agent-providers/sync", {"id": "lab"})
        self.assertEqual(sorted(a["id"] for a in out["agents"]), ["hermes-lab", "hermes-lab-research"])
        with mock.patch.object(ap, "_probe_hermes", lambda url, timeout=2.5: (
                {"url": url, "version": "0.22", "authRequired": True} if url.endswith(":19128") else None)):
            status, out = self.request("POST", "/api/agent-providers/test", {"id": "lab", "kind": "hermes",
                                                                             "transport": "serve", "values": {}})
            self.assertEqual((status, out["code"], out["version"]), (200, "not_started", "0.22"))
            status, out = self.request("POST", "/api/agent-providers/detect", {"kind": "hermes"})
            self.assertEqual([f["url"] for f in out["found"]], ["http://127.0.0.1:19128"])
        status, out = self.request("POST", "/api/agent-providers/reconnect", {"id": "lab"})
        self.assertEqual(status, 200, out)
        self.assertIn(("close", "lab", "Reconnecting"), self.hermes.calls)


    def test_presence_moves_the_office_character(self):
        self.save_lab()
        office = {a["nativeId"]: a["id"] for a in self.lab_row()["agents"]}["research"]
        state = lambda key=office: gateway_presence.get_agent_state(key)  # noqa: E731
        # Hermes working from another channel (Telegram, Desktop): agent-wide activity.
        self.hermes.emit("lab", "research", "", type="agent.activity", active=True, task="Telegram chat")
        self.assertEqual((state()["state"], state()["task"]), ("working", "Telegram chat"))
        self.hermes.emit("lab", "research", "", type="agent.activity", active=False)
        self.assertNotEqual(state()["state"], "working")
        # Our own run: start, a tool, the end.
        self.hermes.emit("lab", "research", "hp-presence-chat", type="run.start", runId="r-p1")
        self.assertEqual(state()["state"], "working")
        self.hermes.emit("lab", "research", "hp-presence-chat", type="tool.start", runId="r-p1", toolId="t1", name="terminal",
                         title="ls -la")
        self.hermes.emit("lab", "research", "hp-presence-chat", type="tool.end", runId="r-p1", toolId="t1", ok=True)
        self.hermes.emit("lab", "research", "hp-presence-chat", type="run.end", runId="r-p1", status="ok", text="done")
        self.assertNotEqual(state()["state"], "working")
        # A roster row with its own status key (switched legacy agent) moves under that key.
        with mock.patch.object(server, "_discovered_roster", [{"id": office, "statusKey": "hp-legacy-key"}]):
            self.hermes.emit("lab", "research", "", type="agent.activity", active=True, task="Desktop")
        self.assertEqual(state("hp-legacy-key")["state"], "working")
        # A profile without an office agent and OpenClaw keys move nobody here.
        before = set(gateway_presence.get_state())
        self.hermes.emit("lab", "ghost-profile", "", type="agent.activity", active=True)
        provider_hub.HUB.publish(provider_hub.agent_key("openclaw", "hp-oc-agent"),
                                 {"type": "agent.activity", "active": True})
        self.assertEqual(set(gateway_presence.get_state()) - before, set())

    def test_chat_sessions_new_and_hermes_test_for_the_office(self):
        self.save_lab()
        self.lab_row()
        status, out = self.request("POST", "/api/office/chat-sessions/switch", {"agentId": "hermes-lab", "sessionId": "s1"})
        self.assertEqual(status, 200, out)
        status, out = self.request("POST", "/api/office/chat-sessions/create", {"agentId": "hermes-lab"})
        self.assertEqual((status, out["sessionId"], out["transport"]), (200, "", "hermes-serve"), out)
        out = self.request("GET", "/api/office/chat-sessions?agentId=hermes-lab")[1]
        self.assertEqual((out["activeSessionId"], [s["active"] for s in out["sessions"]]), ("", [False, False]))
        self.assertNotIn(("session_op", "create", ""), self.hermes.calls)  # created by its first message
        # Legacy agents keep the existing chat-sessions path (not the serve branch).
        self.assertFalse(ap.is_serve_agent("hermes-astra"))
        # GET /api/hermes/test is M: this machine (and a browser session) still gets the legacy probe.
        with mock.patch.object(server, "_handle_hermes_test", lambda body=None: {"ok": True, "connections": []}):
            status, out = self.request("GET", "/api/hermes/test")
        self.assertEqual((status, out.get("ok")), (200, True), out)


class OpenClawRoutes(RoutesBase):
    def setUp(self):
        super().setUp()
        self.gateway = FakeGateway().start()
        self.client = OpenClawGatewayClient(
            lambda _key: {"url": self.gateway.url, "token": "test-token", "access": "full"},
            connect, reconnect_min_sec=0.02, reconnect_max_sec=0.1)
        self.openclaw_adapter = OpenClawAdapter(lambda: self.client, config_key_getter=lambda: ("fake", "full"),
                                                access_getter=lambda: "full")
        ap.register_adapter("openclaw", self.openclaw_adapter)
        self.more = [
            mock.patch.object(server, "_get_openclaw_gateway_client", lambda: self.client),
            mock.patch.object(server, "_gateway_config_key", lambda: ("fake", "full")),
            mock.patch.object(server, "_openclaw_proxy_authorized", lambda handler: True),
        ]
        for p in self.more:
            p.start()
        self.client.start(("fake", "full"))
        self.assertTrue(wait_for(lambda: self.client.status()["connected"]))

    def tearDown(self):
        for p in reversed(self.more):
            p.stop()
        super().tearDown()
        self.client.close()
        self.gateway.stop()

    def test_an_event_for_agent_x_never_reaches_a_stream_for_agent_y(self):
        main_chat = self.sse("/api/openclaw/events?agent=main&session=agent:main:main")
        ops_chat = self.sse("/api/openclaw/events?agent=ops&session=agent:ops:main")
        main_hub = self.sse("/api/agent-chat/events?agent=main&session=agent:main:main")
        ops_hub = self.sse("/api/agent-chat/events?agent=ops&session=agent:ops:main")
        cron = self.sse("/api/openclaw/events?scope=cron")
        self.assertTrue(wait_for(lambda: self.openclaw_adapter._pump is not None))
        time.sleep(0.2)
        self.gateway.emit("chat", {"sessionKey": "agent:main:main", "runId": "r1", "state": "delta",
                                   "message": {"role": "assistant", "content": "for main"}})
        self.gateway.emit("exec.approval.requested", {"id": "ap-main", "request": {
            "sessionKey": "agent:main:main", "agentId": "main", "command": "ls"},
            "expiresAtMs": int(time.time() * 1000) + 60000})
        self.gateway.emit("cron", {"jobId": "j1", "action": "started"})
        self.assertTrue(main_chat.wait(lambda s: "chat" in s.types()), main_chat.types())
        self.assertTrue(main_hub.wait(lambda s: "approval.requested" in s.types()), main_hub.types())
        self.assertTrue(cron.wait(lambda s: "cron" in s.types()), cron.types())
        time.sleep(0.3)
        self.assertNotIn("chat", ops_chat.types())
        self.assertNotIn("approval.requested", ops_hub.types())
        self.assertNotIn("chat", cron.types())
        approval = next(f for f in main_hub.frames if (f.get("event") or {}).get("type") == "approval.requested")
        self.assertEqual(approval["session"], "agent:main:main")
        state = self.request("GET", "/api/agent-chat/state?agent=main&session=agent:main:main")[1]
        self.assertEqual([a.get("approvalId") for a in state["approvals"]], ["ap-main"])
        state = self.request("GET", "/api/agent-chat/state?agent=ops&session=agent:ops:main")[1]
        self.assertEqual(state["approvals"], [])
        can = self.request("GET", "/api/agent-chat/can?agent=main")[1]
        self.assertEqual((can["ok"], can["transport"], can["agent"]), (True, "openclaw", "main"))

    def test_gateway_settings_carry_the_access_level(self):
        with mock.patch.object(server, "_resolve_openclaw_gateway_endpoint",
                               lambda: ({"ok": True, "endpoint": {"url": "ws://x"}}, "t")), \
                mock.patch.object(server, "_get_openclaw_version", lambda: "test"):
            self.assertEqual(server._openclaw_gateway_connection_settings()["access"], "full")
            ap._store().update(lambda d: d["openclaw"].update(access="chat"))
            self.assertEqual(server._openclaw_gateway_connection_settings()["access"], "chat")
        self.more[1].stop()
        try:
            self.assertEqual(server._gateway_config_key()[-1], "chat")
        finally:
            self.more[1].start()

    def test_chat_streams_count_per_page_and_free_on_close(self):
        """v0.10.1 B2: all browsers behind one address (a reverse proxy) each get their streams; a closed
        tab frees its slot within seconds, not at the 15 s heartbeat."""
        import provider_hub
        self.save_lab()
        self.lab_row()
        path = "/api/agent-chat/events?agent=hermes-lab-research&session=s1&client="
        tabs = [self.sse(path + f"proxy-tab-{n:02d}") for n in range(provider_hub.STREAMS_PER_CLIENT + 4)]
        self.assertEqual([t.status for t in tabs], [200] * len(tabs))
        self.assertEqual(provider_hub.open_streams("page:proxy-tab-03"), 1)
        before = provider_hub.open_streams()
        started = time.time()
        tabs[0].close()
        self.assertTrue(wait_for(lambda: provider_hub.open_streams() == before - 1, 3.0), provider_hub.open_streams())
        self.assertLess(time.time() - started, 3.0)
        for tab in tabs[1:]:
            tab.close()
        self.assertTrue(wait_for(lambda: provider_hub.open_streams() == 0, 4.0), provider_hub.open_streams())

    def test_the_stream_without_params_keeps_todays_events(self):
        """chat.js and cron.html open /api/openclaw/events with no query: every agent's chat frames and
        cron, as before the filter; the adapter-only events (approvals...) stay off it."""
        everything = self.sse("/api/openclaw/events")
        main_chat = self.sse("/api/openclaw/events?agent=main&session=agent:main:main")
        self.assertTrue(wait_for(lambda: self.openclaw_adapter._pump is not None))
        time.sleep(0.2)
        for agent in ("main", "ops"):
            self.gateway.emit("chat", {"sessionKey": f"agent:{agent}:main", "runId": f"r-{agent}", "state": "delta",
                                       "message": {"role": "assistant", "content": f"for {agent}"}})
        self.gateway.emit("exec.approval.requested", {"id": "ap-all", "request": {
            "sessionKey": "agent:ops:main", "agentId": "ops", "command": "ls"},
            "expiresAtMs": int(time.time() * 1000) + 60000})
        self.gateway.emit("cron", {"jobId": "j2", "action": "finished"})
        self.assertTrue(everything.wait(lambda s: s.types().count("chat") == 2 and "cron" in s.types()),
                        everything.types())
        chat_keys = lambda s: [(f.get("payload") or {}).get("sessionKey")  # noqa: E731
                               for f in s.frames if f.get("event") == "chat"]
        self.assertEqual(chat_keys(everything), ["agent:main:main", "agent:ops:main"])
        time.sleep(0.3)
        self.assertNotIn("exec.approval.requested", everything.types())
        self.assertEqual(chat_keys(main_chat), ["agent:main:main"])

    def test_access_scopes_reach_the_real_gateway_client(self):
        """The client server.py builds asks the gateway for the scopes of the access level; a change
        reconnects it; today's chat RPC (chat.history through /api/openclaw/rpc) works on both levels."""
        self.gateway.handlers["chat.history"] = lambda p, s: {"messages": [], "sessionKey": p.get("sessionKey")}
        for p in self.more[:2]:
            p.stop()
        saved = server._openclaw_gateway_client
        server._openclaw_gateway_client = None
        resolved = ({"ok": True, "mode": "manual", "endpoint": {"url": self.gateway.url, "location": "test"}},
                    self.gateway.token)
        extra = [mock.patch.object(server, "_resolve_openclaw_gateway_endpoint", lambda *a, **k: resolved),
                 mock.patch.object(server, "_get_openclaw_version", lambda: "test")]
        for p in extra:
            p.start()
        history = lambda: server._handle_openclaw_proxy_rpc(  # noqa: E731
            {"method": "chat.history", "params": {"sessionKey": "agent:main:main"}})
        scopes = lambda: self.gateway.connect_frames[-1]["params"]["scopes"]  # noqa: E731
        try:
            out = history()
            self.assertTrue(out.get("ok"), out)
            self.assertTrue({"operator.admin", "operator.approvals", "operator.write"} <= set(scopes()), scopes())
            self.assertEqual(server._get_openclaw_gateway_client().status()["access"], "full")
            opened = len(self.gateway.connect_frames)
            ap._store().update(lambda d: d["openclaw"].update(access="chat"))
            out = history()
            self.assertTrue(out.get("ok"), out)
            self.assertGreater(len(self.gateway.connect_frames), opened)
            self.assertNotIn("operator.admin", scopes())
            self.assertTrue({"operator.read", "operator.write", "operator.approvals"} <= set(scopes()), scopes())
            self.assertEqual(server._get_openclaw_gateway_client().status()["access"], "chat")
        finally:
            for p in reversed(extra):
                p.stop()
            client, server._openclaw_gateway_client = server._openclaw_gateway_client, saved
            if client is not None:
                client.close()
            for p in self.more[:2]:
                p.start()


if __name__ == "__main__":
    unittest.main()
