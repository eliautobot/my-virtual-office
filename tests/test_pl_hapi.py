"""v0.11 plhapi: Hermes API-server connections beside the copied provider layer, on the real handler.

With the layer on, /api/agent-chat/* asks "is THIS agent a layer agent": the layer's agents (and OpenClaw / `hermes serve`
agents it has not listed yet) get its answer (410 moved, /can from its map); a Hermes API-server agent and VO's other
providers keep 0.10.1's Python routes. POST bodies are read once to see the agent and handed on byte for byte (also on a
keep-alive connection). /api/office/hermes-api keeps the API-server rows' settings reachable (only those rows). Layer off:
unchanged. No real provider or port is reached (API server address 127.0.0.1:9, every probe patched).
"""

import atexit
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-pl-hapi-")
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

import server  # noqa: E402
import agent_providers as ap  # noqa: E402
import provider_layer_ids  # noqa: E402
import vo_access  # noqa: E402

API_URL = "http://127.0.0.1:9"   # (discard port: never a real Hermes)
LAYER = {"main": 1, "hermes-lab-a": 2}


class FakeIds:
    loaded_at = 1

    def layer_id(self, office_id):
        return LAYER.get(str(office_id or ""))

    def all(self):
        return [{"officeId": "main", "layerId": 1, "kind": "openclaw", "connectionId": 3, "connection": "Lab gateway",
                 "access": "full"},
                {"officeId": "hermes-lab-a", "layerId": 2, "kind": "hermes", "connectionId": 4, "connection": "Lab A",
                 "access": "full"}]


class HermesApiBesideLayer(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-pl-hapi-t-")
        self.status = Path(self.temp.name) / "status"
        self.status.mkdir()
        cfg = {"hermes": {"connections": [{"id": "astra", "name": "Astra", "apiUrl": API_URL, "apiKey": "legacy-key-0123456789",
                                           "enabled": True}]},
               "openclaw": {"gatewayUrl": "ws://127.0.0.1:9", "gatewayToken": "gw-token"}}
        self.cfg_path = self.status / "vo-config.json"
        self.cfg_path.write_text(json.dumps(cfg))
        self.store = vo_access.AccessStore(str(self.status))
        self.vo_cfg = dict(server.VO_CONFIG, hermes=cfg["hermes"],
                           openclaw=dict(server.VO_CONFIG["openclaw"], **cfg["openclaw"]))
        self.roster = {
            "main": {"id": "main", "statusKey": "main", "providerKind": "openclaw", "providerTransport": "layer"},
            "ops": {"id": "ops", "statusKey": "ops", "providerKind": "openclaw"},   # (OpenClaw, not listed by the layer yet)
            "hermes-lab-a": {"id": "hermes-lab-a", "providerKind": "hermes", "providerTransport": "layer",
                             "providerConnectionId": "pl-4"},
            "hermes-astra": {"id": "hermes-astra", "providerKind": "hermes", "providerAgentId": "astra",
                             "connectionId": "astra", "connectionModes": ["api"], "capabilities": ["chat", "sessions"]},
        }
        self.openclaw_info = mock.Mock(return_value={"url": "ws://127.0.0.1:9", "tokenSet": True, "tokenSource": "office",
                                                     "agents": [], "status": {"state": "offline"}})
        self.layer_agent = mock.Mock(side_effect=lambda office_id: LAYER.get(str(office_id or "")))
        self.patches = [
            mock.patch.object(server, "STATUS_DIR", str(self.status)),
            mock.patch.object(server, "ACCESS_STORE", self.store),
            mock.patch.object(server, "VO_CONFIG", self.vo_cfg),
            mock.patch.dict(os.environ, {"VO_STATUS_DIR": str(self.status), "VO_CONFIG": str(self.cfg_path),
                                         "VO_PROVIDER_LAYER": "1"}),
            mock.patch.object(server, "_reload_provider_settings_runtime", self._reload_cfg),
            mock.patch.object(server, "_hp_legacy_status", lambda row: {"state": "connected", "code": "",
                                                                        "detail": "ok", "fix": "", "version": ""}),
            mock.patch.object(server, "_hp_legacy_test", lambda values: {"ok": True, "probed": values.get("apiUrl"),
                                                                       "keyed": bool(values.get("apiKey"))}),
            mock.patch.object(server, "_hp_openclaw_info", self.openclaw_info),
            mock.patch.object(server, "_hp_legacy_agents", lambda: {}),
            mock.patch.object(server, "_hp_roster_agent", lambda agent_id: self.roster.get(agent_id)),
            mock.patch.object(server, "_hp_refresh_discovery", lambda: None),
            mock.patch.object(server, "_hp_openclaw_start", lambda: None),
            mock.patch.object(provider_layer_ids, "ids", return_value=FakeIds()),
            mock.patch.object(server.provider_layer_turns, "layer_agent", self.layer_agent),
        ]
        for p in self.patches:
            p.start()
        server._hp_configure(str(self.status))
        ap.migrate(str(self.status), str(self.cfg_path))
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        self.httpd.block_on_close = False
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def _reload_cfg(self):
        self.vo_cfg.update(json.loads(self.cfg_path.read_text()))

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        for p in reversed(self.patches):
            p.stop()
        server._HP_OPENCLAW["adapter"] = None
        server._hp_configure()
        self.temp.cleanup()

    def request(self, method, path, body=None, conn=None):
        own = conn is None
        conn = conn or http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
        res = conn.getresponse()
        raw = res.read()
        if own:
            conn.close()
        try:
            return res.status, json.loads(raw.decode("utf-8"))
        except ValueError:
            return res.status, raw

    def layer(self, on):
        os.environ["VO_PROVIDER_LAYER"] = "1" if on else "0"

    # ── /api/agent-chat/*: per agent ──
    def test_layer_on_get_gate_per_agent(self):
        status, out = self.request("GET", "/api/agent-chat/can?agent=main")
        self.assertEqual((status, out.get("layer"), out.get("layerAgentId")), (200, True, 1))
        status, out = self.request("GET", "/api/agent-chat/state?agent=hermes-lab-a")
        self.assertEqual((status, out.get("code")), (410, "moved"))
        # an OpenClaw agent the layer has not listed yet: still the layer's (VO's Python gateway client never starts)
        status, out = self.request("GET", "/api/agent-chat/state?agent=ops")
        self.assertEqual((status, out.get("code")), (410, "moved"))
        # (v0.11 relux, playtest #10) its /can is a clear "no" in a 200, never a console 404
        status, out = self.request("GET", "/api/agent-chat/can?agent=ops")
        self.assertEqual((status, out.get("ok"), out.get("reason"), out.get("agent")), (200, False, "offline", "ops"))
        # the Hermes API-server agent: 0.10.1's answers (manifest from the registry flags, history refused)
        status, can = self.request("GET", "/api/agent-chat/can?agent=hermes-astra")
        self.assertEqual((status, can.get("transport"), can.get("layer")), (200, "hermes-api", None))
        status, out = self.request("GET", "/api/agent-chat/history?agent=hermes-astra&session=x")
        self.assertEqual((status, out.get("error")), (400, "unsupported"))
        self.assertEqual(self.openclaw_info.call_count, 0)

    def test_layer_on_post_gate_reads_body_once_and_hands_it_on(self):
        status, out = self.request("POST", "/api/agent-chat/stop", {"agent": "main", "session": "s"})
        self.assertEqual((status, out.get("code")), (410, "moved"))
        status, out = self.request("POST", "/api/agent-chat/runs", {"agent": "hermes-lab-a", "session": "s", "text": "hi"})
        self.assertEqual((status, out.get("code")), (410, "moved"))
        on = self.request("POST", "/api/agent-chat/stop", {"agent": "hermes-astra", "session": "x"})
        self.assertNotEqual(on[1].get("code"), "moved")
        self.layer(False)
        off = self.request("POST", "/api/agent-chat/stop", {"agent": "hermes-astra", "session": "x"})
        self.assertEqual(on, off)   # the same 0.10.1 answer with the layer on or off
        self.layer(True)
        # keep-alive: the replayed body, then the connection's own stream for the next request
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            first = self.request("POST", "/api/agent-chat/stop", {"agent": "hermes-astra", "session": "x"}, conn=conn)
            second = self.request("GET", "/api/agent-chat/can?agent=hermes-astra", conn=conn)
            third = self.request("POST", "/api/agent-chat/stop", {"agent": "main", "session": "s"}, conn=conn)
        finally:
            conn.close()
        self.assertEqual(first, on)
        self.assertEqual((second[0], second[1].get("transport")), (200, "hermes-api"))
        self.assertEqual((third[0], third[1].get("code")), (410, "moved"))
        # a body the route refuses anyway is left to it (not JSON: 0.10's 400, never a 410)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("POST", "/api/agent-chat/stop", body=b"{nope", headers={"Content-Type": "application/json"})
            res = conn.getresponse()
            self.assertEqual(res.status, 400)
            res.read()
        finally:
            conn.close()

    def test_layer_off_unchanged(self):
        self.layer(False)
        status, can = self.request("GET", "/api/agent-chat/can?agent=main")
        self.assertEqual((status, can.get("layer")), (200, None))   # 0.10's own manifest
        status, out = self.request("GET", "/api/agent-chat/can?agent=hermes-astra")
        self.assertEqual((status, out.get("transport")), (200, "hermes-api"))
        self.request("POST", "/api/agent-chat/stop", {"agent": "main", "session": "s"})
        self.assertEqual(self.layer_agent.call_count, 0)   # the layer's map is never asked
        self.assertFalse(server._pl_layer_chat("main"))

    # ── /api/office/hermes-api: the API-server rows' settings ──
    def test_settings_route_lists_and_changes_only_api_server_rows(self):
        status, out = self.request("GET", "/api/office/hermes-api")
        self.assertEqual(status, 200, out)
        self.assertEqual([p["id"] for p in out["providers"]], ["astra"])
        self.assertEqual((out["providers"][0]["transport"], list(out["manifests"])), ("api", ["hermes-api"]))
        self.assertNotIn("legacy-key", json.dumps(out))   # (secrets: only "apiKey": true)
        status, out = self.request("POST", "/api/office/hermes-api/save", {"id": "astra", "values": {"name": "Astra Two"}})
        self.assertEqual((status, out.get("id")), (200, "astra"), out)
        status, out = self.request("POST", "/api/office/hermes-api/enable", {"id": "astra", "on": False})
        self.assertEqual(status, 200, out)
        row = json.loads(self.cfg_path.read_text())["hermes"]["connections"][0]
        self.assertEqual((row["name"], row["enabled"]), ("Astra Two", False))
        status, out = self.request("POST", "/api/office/hermes-api/test",
                                   {"id": "astra", "kind": "openclaw", "values": {"apiUrl": API_URL}})
        self.assertEqual((status, out.get("probed"), out.get("keyed")), (200, API_URL, True))   # (API-server test, stored key)
        status, out = self.request("POST", "/api/office/hermes-api/reconnect", {"id": "astra"})
        self.assertEqual((status, out["status"]["state"]), (200, "connecting"))
        # only API-server rows: a serve connection id or OpenClaw is not here
        for cid in ("openclaw", "lab", ""):
            status, out = self.request("POST", "/api/office/hermes-api/enable", {"id": cid, "on": True})
            self.assertEqual(status, 404, (cid, out))
        status, out = self.request("POST", "/api/office/hermes-api/switch", {"id": "astra"})
        self.assertEqual(status, 404)
        status, out = self.request("POST", "/api/office/hermes-api/remove", {"id": "astra"})
        self.assertEqual(status, 200, out)
        self.assertEqual(json.loads(self.cfg_path.read_text())["hermes"]["connections"], [])
        self.assertNotIn("astra", ap.load()["legacy"])
        self.assertEqual(self.request("GET", "/api/office/hermes-api")[1]["providers"], [])
        self.assertEqual(self.openclaw_info.call_count, 0)   # never VO's Python OpenClaw beside the layer


class FirstStartWithLayer(unittest.TestCase):
    def test_fresh_office_imports_with_the_layer_on(self):
        """A first start (no discovery cache) with the layer on builds the roster at import: every helper it reads
        must exist by then (c28fb63 died with NameError _pl_hidden_hermes)."""
        import subprocess
        with tempfile.TemporaryDirectory(prefix="vo-pl-hapi-first-") as tmp:
            (Path(tmp) / "openclaw").mkdir()
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tmp, "LANG": "C.UTF-8",
                   "VO_STATUS_DIR": tmp, "VO_CONFIG": str(Path(tmp) / "vo-config.json"),
                   "VO_OPENCLAW_PATH": str(Path(tmp) / "openclaw"), "OPENCLAW_HOME": str(Path(tmp) / "openclaw"),
                   "VO_PROVIDER_LAYER": "1", "VO_CODEX_INCLUDE_NATIVE_AGENTS": "0",
                   "VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS": "0", "PYTHONDONTWRITEBYTECODE": "1",
                   "PYTHONPATH": os.pathsep.join(p for p in sys.path if p)}   # (HOME moved: the user site too)
            done = subprocess.run([sys.executable, "-c", "import server; print('roster', len(server._discovered_roster))"],
                                  cwd=str(APP_ROOT), env=env, capture_output=True, text=True, timeout=120)
            self.assertEqual(done.returncode, 0, done.stderr[-1500:])
            self.assertIn("roster", done.stdout)

if __name__ == "__main__":
    unittest.main()
