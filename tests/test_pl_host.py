"""The copied OpenClaw/Hermes provider layer in the office (stage C1): vo-host behind server.py.

Fast and hermetic: vo-host runs with My Virtual World's mock provider (VO_PL_TEST=1) in a temporary folder; the office
server runs in-process on a free port. Skipped when Node.js 22.19+ or the layer's packages are missing.
The lab cases (a real OpenClaw gateway and Hermes) are in tests/pl_host_lab.py.
"""

import atexit
import http.client
import json
import os
import signal
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-pl-host-")
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

import provider_layer_proxy as plp  # noqa: E402

NODE = plp.detect_node()
HAVE_LAYER = NODE["ok"] and (APP_ROOT / "provider-layer" / "node_modules" / "@openclaw" / "gateway-client").is_dir()


def _access(**kw):
    base = dict(protected=True, via_loopback=False, via_token=False, via_session=False, session_token="")
    base.update(kw)
    a = SimpleNamespace(**base)
    a.can_manage = (not a.protected) or a.via_loopback or a.via_session
    return a


class _Store:
    def __init__(self, confirmed=0):
        self.confirmed = confirmed

    def confirmed_at(self, token):
        return self.confirmed


def _decode(header):
    import base64
    data = header.rsplit(".", 1)[0]
    return json.loads(base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)))


class ProxyUnitTests(unittest.TestCase):
    def test_layer_paths_and_internal_never_relayed(self):
        for p in ("/api/providers", "/api/providers/runs", "/api/agent-providers/call", "/api/connections",
                  "/api/chat-sessions/create", "/api/chat/attachments", "/api/chat-references", "/api/pl/me"):
            self.assertTrue(plp.is_layer_path(p), p)
        for p in ("/api/pl/internal/bus", "/api/pl/internal/health", "/api/office/providers", "/api/office/chat-sessions",
                  "/api/providersx", "/api/chatty", "/health"):
            self.assertFalse(plp.is_layer_path(p), p)

    def test_static_files_stay_inside_their_roots(self):
        if not (APP_ROOT / "provider-layer" / "client" / "js" / "ui" / "chat.js").is_file():
            self.skipTest("layer client missing")
        self.assertTrue(plp.static_file("/pl/js/ui/chat.js").endswith("chat.js"))
        self.assertTrue(plp.static_file("/pl/css/chat.css").endswith("chat.css"))
        for p in ("/pl/js/../../server/db.js", "/pl/js/%2e%2e/%2e%2e/vo-host.mjs", "/pl/js/ui/.hidden.js", "/pl/js/",
                  "/pl/css/../../package.json", "/vendor/novnc/../../../server.py"):
            self.assertIsNone(plp.static_file(p), p)

    def test_node_detection_names_the_fix(self):
        self.assertEqual(plp.parse_node_version("v24.20.0\n"), (24, 20, 0))
        self.assertIsNone(plp.parse_node_version("nope"))
        missing = plp.detect_node("/nonexistent/node")
        self.assertFalse(missing["ok"])
        self.assertIn("Needs Node.js 22.19 or newer", missing["message"])
        with tempfile.TemporaryDirectory() as d:
            old = Path(d) / "node"
            old.write_text("#!/bin/sh\necho v20.11.1\n")
            old.chmod(0o755)
            r = plp.detect_node(str(old))
            self.assertFalse(r["ok"])
            self.assertIn("found 20.11.1", r["message"])

    def test_principal_mapping(self):
        layer = plp.ProviderLayer("/nonexistent/vo-pl-unit", env={})  # (signing only: nothing is written)
        token = _decode(layer.principal(_access(via_token=True), _Store(), {}))
        self.assertEqual((token["role"], token["via"], token["csrf"]), ("member", "token", None))
        now = time.time()
        sess = _decode(layer.principal(_access(via_session=True, session_token="abc"), _Store(int(now) - 30), {"Cookie": "x"}))
        self.assertEqual((sess["role"], sess["via"]), ("owner", "session"))
        self.assertAlmostEqual(sess["authAt"] / 1000, now - 30, delta=2)
        self.assertTrue(sess["csrf"])
        script = _decode(layer.principal(_access(via_loopback=True), _Store(), {}))
        self.assertEqual((script["role"], script["via"], script["csrf"]), ("owner", "loopback", None))
        self.assertAlmostEqual(script["authAt"] / 1000, now, delta=2)
        page = _decode(layer.principal(_access(protected=False), _Store(), {"Sec-Fetch-Site": "same-origin"}))
        self.assertEqual((page["role"], page["via"]), ("owner", "open"))
        self.assertTrue(page["csrf"])
        # a token caller on this machine manages, as the office's own rule says (vo_access can_manage)
        self.assertEqual(_decode(layer.principal(_access(via_token=True, via_loopback=True), _Store(), {}))["role"], "owner")


@unittest.skipUnless(HAVE_LAYER, "Node.js 22.19+ and app/provider-layer/node_modules are needed")
class LayerThroughOfficeTests(unittest.TestCase):
    """vo-host (mock provider) behind the in-process office server."""

    @classmethod
    def setUpClass(cls):
        import server
        cls.server = server
        cls.data = tempfile.TemporaryDirectory(prefix="vo-pl-layer-")
        cls.layer = plp.ProviderLayer(os.path.join(cls.data.name, "provider-layer"), env={**os.environ, "VO_PL_TEST": "1"},
                                      log=lambda *_: None)
        server.PROVIDER_LAYER = cls.layer
        assert cls.layer.start(), cls.layer.message
        cls.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        health = cls.layer.wait_ready(30)
        assert health, "vo-host did not answer"
        cls.wait_helper()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.layer.stop()
        cls.server.PROVIDER_LAYER = None
        cls.data.cleanup()

    @classmethod
    def wait_helper(cls, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            h = cls.layer.health(timeout=1)
            if h and h["host"]["running"] and "mock" in h["kinds"]:
                return h
            time.sleep(0.2)
        raise AssertionError("the provider helper did not start")

    # ── helpers ──
    def request(self, method, path, body=None, headers=None, port=None):
        conn = http.client.HTTPConnection("127.0.0.1", port or self.port, timeout=30)
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"} if data is not None else {}
        h.update(headers or {})
        conn.request(method, path, body=data, headers=h)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        try:
            return resp.status, json.loads(raw), resp
        except ValueError:
            return resp.status, raw, resp

    def direct(self, method, path, principal, body=None, headers=None):
        h = {plp.PRINCIPAL_HEADER: principal} if principal else {}
        h.update(headers or {})
        return self.request(method, path, body, h, port=self.layer.port)

    def owner(self, **kw):
        return self.layer._sign({"role": "owner", "via": "loopback", "authAt": int(time.time() * 1000), "csrf": None, **kw})

    def member(self):
        return self.layer._sign({"role": "member", "via": "token", "authAt": 0, "csrf": None})

    def mock_agent(self):
        if getattr(type(self), "_agent", None):
            return type(self)._agent
        s, conn, _ = self.request("POST", "/api/connections", {"kind": "mock", "label": "Mock", "scope": "installation",
                                                              "config": {"url": "http://mock.invalid"}, "secrets": {"token": "tok-12345678"}})
        self.assertEqual(s, 200, conn)
        s, a, _ = self.request("POST", "/api/pl/test/agent", {"connectionId": conn["id"], "nativeId": "mock-a", "name": "Mock A"})
        self.assertEqual(s, 200, a)
        type(self)._agent = a["agent"]["id"]
        return type(self)._agent

    def new_session(self, agent):
        s, out, _ = self.request("POST", "/api/chat-sessions/create", {"agent": agent, "label": "t"})
        self.assertEqual(s, 200, out)
        return out["session"]["id"]

    def wait_run(self, run_id, timeout=15):
        end, since, seen = time.time() + timeout, 0, []
        while time.time() < end:
            s, out, _ = self.request("GET", f"/api/providers/runs/events?run={run_id}&since={since}")
            self.assertEqual(s, 200, out)
            for e in out.get("events") or []:
                seen.append(e["event"])
                since = max(since, e["seq"])
            if out.get("done"):
                return seen
            time.sleep(0.2)
        raise AssertionError(f"run {run_id} did not end: {[e['type'] for e in seen]}")

    # ── who may call ──
    def test_vo_host_refuses_missing_or_forged_principal(self):
        self.assertEqual(self.direct("GET", "/api/pl/health", None)[0], 401)
        forged = self.owner()[:-4] + "0000"
        self.assertEqual(self.direct("GET", "/api/pl/health", forged)[0], 401)
        other = plp.ProviderLayer("/nonexistent/vo-pl-other", env={})
        self.assertEqual(self.direct("GET", "/api/pl/health", other._sign({"role": "owner", "via": "loopback"}))[0], 401)
        self.assertEqual(self.direct("GET", "/api/pl/health", self.owner())[0], 200)
        # the bus is the office server's alone
        self.assertEqual(self.direct("GET", "/api/pl/internal/health", self.owner())[0], 403)
        self.assertEqual(self.request("GET", "/api/pl/internal/health")[0], 404)

    def test_agent_token_principal_cannot_manage(self):
        s, out, _ = self.direct("POST", "/api/agent-providers/detect", self.member(), {"kind": "openclaw"})
        self.assertEqual((s, out["code"]), (403, "forbidden"))
        s, out, _ = self.direct("POST", "/api/connections", self.member(), {"kind": "openclaw", "scope": "installation",
                                                                            "config": {"url": "ws://127.0.0.1:1"}})
        self.assertEqual(s, 403, out)
        s, me, _ = self.direct("GET", "/api/pl/me", self.member())
        self.assertEqual(s, 200)
        self.assertFalse(me["caps"]["connections.manage"])
        self.assertTrue(me["caps"]["chat.use"])

    def test_csrf_and_reauth(self):
        csrf = "c" * 40
        page = self.owner(via="session", csrf=csrf)
        s, out, _ = self.direct("POST", "/api/chat-sessions/create", page, {"agent": 1})
        self.assertEqual((s, out["code"]), (403, "csrf"))
        s, out, _ = self.direct("POST", "/api/chat-sessions/create", page, {"agent": self.mock_agent()}, {"X-CSRF-Token": csrf})
        self.assertEqual(s, 200, out)
        s, out, _ = self.direct("POST", "/api/chat-sessions/create", page, None, {"X-CSRF-Token": csrf, "Content-Type": "text/plain"})
        self.assertEqual(s, 415)
        stale = self.owner(via="session", csrf=csrf, authAt=int(time.time() * 1000) - 11 * 60 * 1000)
        s, out, _ = self.direct("POST", "/api/providers/screen", stale, {"agent": self.mock_agent(), "action": "browser"},
                                {"X-CSRF-Token": csrf})
        self.assertEqual((s, out["code"]), (403, "reauth_required"))

    def test_me_through_the_office(self):
        s, me, _ = self.request("GET", "/api/pl/me")
        self.assertEqual(s, 200, me)
        self.assertEqual((me["role"], me["account"]["id"]), ("owner", 1))
        self.assertTrue(me["caps"]["connections.manage"])
        s, st, _ = self.request("GET", "/api/office/provider-layer")
        self.assertEqual(s, 200)
        self.assertTrue(st["running"])
        s, h, _ = self.request("GET", "/health")
        self.assertEqual((s, h["providerLayer"]["running"]), (200, True))

    def test_static_and_source_paths(self):
        s, body, resp = self.request("GET", "/pl/js/ui/chat.js")
        self.assertEqual(s, 200)
        self.assertIn("javascript", resp.getheader("Content-Type"))
        self.assertEqual(self.request("GET", "/provider-layer/vo-host.mjs")[0], 404)
        self.assertEqual(self.request("GET", "/provider-layer/client/js/ui/chat.js")[0], 404)
        self.assertEqual(self.request("GET", "/vendor/novnc/core/rfb.js")[0], 200)

    # ── a turn ──
    def test_mock_turn_and_interrupt(self):
        agent = self.mock_agent()
        sess = self.new_session(agent)
        s, run, _ = self.request("POST", "/api/providers/runs", {"agent": agent, "session": sess, "input": "hello office"})
        self.assertEqual(s, 200, run)
        events = self.wait_run(run["runId"])
        end = [e for e in events if e["type"] == "run.end"]
        self.assertEqual(end[-1]["status"], "ok")
        s, run2, _ = self.request("POST", "/api/providers/runs", {"agent": agent, "session": sess, "input": "slow:20000"})
        self.assertEqual(s, 200, run2)
        time.sleep(0.5)
        s, out, _ = self.request("POST", "/api/providers/interrupt", {"run": run2["runId"]})
        self.assertEqual(s, 200, out)
        end = [e for e in self.wait_run(run2["runId"]) if e["type"] == "run.end"]
        self.assertEqual(end[-1]["status"], "stopped")

    def test_websocket_relay_carries_chat_frames(self):
        from websockets.sync.client import connect
        agent = self.mock_agent()
        sess = self.new_session(agent)
        with connect(f"ws://127.0.0.1:{self.port}/api/pl/ws", open_timeout=10) as ws:
            hello = json.loads(ws.recv(timeout=10))
            self.assertEqual((hello["t"], hello["account"]), ("hello", 1))
            s, run, _ = self.request("POST", "/api/providers/runs", {"agent": agent, "session": sess, "input": "over the socket"})
            self.assertEqual(s, 200, run)
            got = []
            end = time.time() + 15
            while time.time() < end:
                f = json.loads(ws.recv(timeout=10))
                if f.get("t") == "chat" and f.get("run") == run["runId"]:
                    got.append(f)
                    if (f.get("event") or {}).get("type") == "run.end" or f.get("type") == "run.end":
                        break
            self.assertTrue(got, "no chat frames over the relay")
        # (a page of another site may not open the socket)
        with self.assertRaises(Exception):
            with connect(f"ws://127.0.0.1:{self.port}/api/pl/ws", origin="http://evil.example", open_timeout=5):
                pass

    # ── crashes (last: they restart processes) ──
    def test_zz_helper_crash_interrupts_and_restarts(self):
        agent = self.mock_agent()
        sess = self.new_session(agent)
        before = self.wait_helper()
        s, run, _ = self.request("POST", "/api/providers/runs", {"agent": agent, "session": sess, "input": "slow:20000"})
        self.assertEqual(s, 200, run)
        time.sleep(0.5)
        os.kill(before["helperPid"], signal.SIGKILL)
        end = [e for e in self.wait_run(run["runId"]) if e["type"] == "run.end"]
        self.assertEqual(end[-1]["status"], "interrupted")
        after = self.wait_helper()
        self.assertNotEqual(after["helperPid"], before["helperPid"])
        self.assertGreaterEqual(after["host"]["restarts"], 1)

    def test_zz_vo_host_crash_is_restarted(self):
        pid = self.layer.pid
        os.kill(pid, signal.SIGKILL)
        self.assertEqual(self.request("GET", "/health")[0], 200)
        end = time.time() + 20
        while time.time() < end and (self.layer.pid in (None, pid) or not self.layer.health(timeout=1)):
            self.assertEqual(self.request("GET", "/health")[0], 200)
            time.sleep(0.2)
        self.assertNotIn(self.layer.pid, (None, pid))
        self.assertGreaterEqual(self.layer.restarts, 1)
        self.wait_helper()
        self.assertEqual(self.request("GET", "/api/pl/me")[0], 200)


@unittest.skipUnless(HAVE_LAYER, "Node.js 22.19+ and app/provider-layer/node_modules are needed")
class NoNodeTests(unittest.TestCase):
    def test_no_node_shows_the_message_and_the_office_keeps_working(self):
        import server
        layer = plp.ProviderLayer("/nonexistent/vo-pl-nonode", env={}, node_bin="/nonexistent/node", log=lambda *_: None)
        self.assertFalse(layer.start())
        old = server.PROVIDER_LAYER
        server.PROVIDER_LAYER = layer
        httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=20)
            conn.request("GET", "/api/office/provider-layer")
            st = json.loads(conn.getresponse().read())
            self.assertIn("Needs Node.js 22.19 or newer", st["message"])
            conn.request("GET", "/api/pl/me")
            r = conn.getresponse()
            self.assertEqual((r.status, json.loads(r.read())["code"]), (503, "provider_layer_unavailable"))
            conn.request("GET", "/health")
            r = conn.getresponse()
            self.assertEqual(r.status, 200)
            r.read()
            conn.request("GET", "/api/office/providers")
            r = conn.getresponse()
            self.assertEqual(r.status, 200)
            r.read()
            conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            server.PROVIDER_LAYER = old


if __name__ == "__main__":
    unittest.main()
