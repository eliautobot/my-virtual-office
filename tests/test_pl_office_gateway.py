"""v0.11 relfix: with the layer owning OpenClaw, the office's own gateway calls go through the layer.

The New agent wizard (agents.create, its files, rollback), the chat list and delete, the skills workshop, the gateway
restart, progress cards and the workflow abort/delete used VO's own Python client; from Docker's bridge network that
client has no scopes (only the layer is paired). Now ``_get_openclaw_gateway_client()`` is the layer's stand-in
(provider_layer_gateway.LayerGatewayClient): every call is a POST to the layer's internal route. A fake layer stands in
here; no gateway is reached, no Python client or device is made. The setup wizard's gateway test and the adoption of
its saved gateway are checked too.
"""

import atexit
import http.server
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-pl-ogw-")
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
import provider_layer_gateway  # noqa: E402

TOKEN = "saved-gateway-token-13579abcdef"


class FakeLayer:
    """The layer's internal routes as the office server sees them; answers are set per test."""

    def __init__(self):
        self.calls, self.answers, self.message = [], {}, ""
        layer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                layer.calls.append((self.path, self.headers.get("X-VO-Principal"), body))
                status, out = layer.answers.get(self.path, (404, {"error": "no"}))
                if callable(out):
                    out = out(body)
                data = json.dumps(out).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def ready(self):
        return True

    def internal_principal(self):
        return "internal-signed"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def paths(self):
        return [c[0] for c in self.calls]

    def call_bodies(self):
        return [c[2] for c in self.calls if c[0] == "/api/pl/internal/openclaw/call"]


class FakeIds:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return list(self.rows)


CONNECTED = (200, {"ok": True, "connectionId": 3, "connected": True, "version": "2026.7.2", "generation": 4, "state": "connected"})


class OfficeGatewayCallsThroughLayer(unittest.TestCase):
    def setUp(self):
        self.layer = FakeLayer()
        self.addCleanup(self.layer.close)
        self.layer.answers["/api/pl/internal/openclaw/status"] = CONNECTED
        self.layer.answers["/api/pl/internal/openclaw/call"] = (200, lambda b: {"ok": True, "connectionId": 3, "payload": {"echo": b["method"], "agentId": "made-1"}})
        ids = FakeIds([{"officeId": "boss", "kind": "openclaw", "connectionId": 3, "nativeId": "main"},
                       {"officeId": "hermes-x", "kind": "hermes", "connectionId": 5, "nativeId": "default"}])
        for target, name, value in ((server, "_pl_owns", lambda: True), (server, "PROVIDER_LAYER", self.layer),
                                    (server, "_layer_gateway_client", None), (server, "_openclaw_gateway_client", None),
                                    (provider_layer_gateway.provider_layer_ids, "ids", lambda: ids)):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_rpc_goes_to_the_layer_never_a_python_client(self):
        out = server._gateway_rpc_call("agents.create", {"name": "Ada", "workspace": "/w/ws-ada"}, timeout=30)
        self.assertTrue(out["ok"])
        self.assertEqual((out["echo"], out["agentId"], out["transport"]), ("agents.create", "made-1", "layer"))
        path, principal, body = self.layer.calls[0]
        self.assertEqual((path, principal), ("/api/pl/internal/openclaw/call", "internal-signed"))
        self.assertEqual((body["method"], body["params"], body["connection"], body["timeoutMs"]),
                         ("agents.create", {"name": "Ada", "workspace": "/w/ws-ada"}, None, 30000))
        self.assertIsNone(server._openclaw_gateway_client, "VO's own Python client is never made")
        self.assertIsInstance(server._get_openclaw_gateway_client(), provider_layer_gateway.LayerGatewayClient)

    def test_office_ids_become_openclaw_ids_on_their_connection(self):
        server._gateway_rpc_call("sessions.delete", {"key": "agent:boss:vo-task-7", "deleteTranscript": True})
        server._skill_workshop_rpc("skills.proposals.list", "boss", {})
        server._gateway_rpc_call("agents.files.set", {"agentId": "made-1", "name": "SOUL.md", "content": "x"})
        server._gateway_rpc_call("chat.abort", {"sessionKey": "agent:hermes-x:main"})
        a, b, c, d = self.layer.call_bodies()
        self.assertEqual((a["params"]["key"], a["connection"]), ("agent:main:vo-task-7", 3))
        self.assertEqual((b["method"], b["params"]["agentId"], b["connection"]), ("skills.proposals.list", "main", 3))
        self.assertEqual((c["params"]["agentId"], c["connection"]), ("made-1", None))   # (not an office id: as it is)
        self.assertEqual((d["params"]["sessionKey"], d["connection"]), ("agent:hermes-x:main", None))   # (not OpenClaw's)

    def test_refusal_and_unreachable_keep_the_old_answers(self):
        self.layer.answers["/api/pl/internal/openclaw/call"] = (200, {"ok": False, "error": {"code": "INVALID_REQUEST", "message": "agent \"x\" already exists"}})
        out = server._gateway_rpc_call("agents.create", {"name": "x"})
        self.assertEqual((out["ok"], out["error"]), (False, 'agent "x" already exists'))
        created = server._legacy_openclaw_agent_create({"name": "x"})
        self.assertEqual(created["_status"], 409)
        self.layer.answers["/api/pl/internal/openclaw/call"] = (503, {"ok": False, "error": {"code": "pairing", "message": "Waiting for approval"}})
        out = server._gateway_rpc_call("agents.list", {})
        self.assertEqual((out["ok"], out["code"], out["error"]), (False, "gateway_unavailable", "Waiting for approval"))
        restart = server._send_openclaw_gateway_restart_request()
        self.assertEqual((restart["ok"], restart["method"]), (False, "gateway-rpc-restart-request"))
        self.assertEqual(self.layer.call_bodies()[-1]["method"], "gateway.restart.request")

    def test_new_agent_wizard_flow(self):
        listed = {"n": 0}

        def answer(body):
            if body["method"] == "agents.list":
                listed["n"] += 1
                return {"ok": True, "payload": {"agents": [{"id": "main", "model": {"primary": "m/x"}}, {"id": "ada"}]}}
            return {"ok": True, "payload": {"ok": True, "agentId": "ada"} if body["method"] == "agents.create" else {"ok": True}}
        self.layer.answers["/api/pl/internal/openclaw/call"] = (200, answer)
        with mock.patch.object(server, "_pl_sync_openclaw_agents"), mock.patch.object(server, "_remove_openclaw_agent_paths"):
            out = server._legacy_openclaw_agent_create({"name": "Ada", "role": "Writer"})
        self.assertNotIn("error", out, out)
        methods = [b["method"] for b in self.layer.call_bodies()]
        # (0.12: first the gateway is asked where its folder is, config.get, when nothing else says it)
        self.assertEqual(methods[:4], ["config.get", "agents.list", "agents.create", "agents.list"])
        self.assertEqual(methods[4:], ["agents.files.set"] * (len(methods) - 4))
        self.assertEqual(self.layer.call_bodies()[2]["params"]["model"], "m/x")

    def test_progress_card_guard_uses_the_layer_generation(self):
        client = server._get_openclaw_gateway_client()
        gen = client.status()["generation"]
        self.assertEqual(gen, "pl3.4")
        self.assertEqual(client.request("progressCard.get", {"sessionKey": "agent:boss:main"}, expected_generation=gen)["ok"], True)
        self.layer.answers["/api/pl/internal/openclaw/status"] = (200, dict(CONNECTED[1], generation=5))
        with self.assertRaises(provider_layer_gateway.GatewayDisconnectedError):
            client.request("progressCard.get", {"sessionKey": "agent:boss:main"}, expected_generation=gen)
        with self.assertRaises(provider_layer_gateway.GatewayUnavailableError):
            client.subscribe()

    def test_workflow_abort_and_delete_through_the_layer(self):
        self.assertTrue(server._wf_abort_task_session("agent:boss:vo-task-9"))
        self.assertTrue(server._wf_delete_session_via_gateway("agent:boss:vo-task-9"))
        a, d = self.layer.call_bodies()
        self.assertEqual((a["method"], a["params"]), ("chat.abort", {"sessionKey": "agent:main:vo-task-9"}))
        self.assertEqual((d["method"], d["params"]["key"]), ("sessions.delete", "agent:main:vo-task-9"))


class WizardGatewayThroughLayer(unittest.TestCase):
    def setUp(self):
        self.layer = FakeLayer()
        self.addCleanup(self.layer.close)
        self.layer.answers["/api/pl/internal/openclaw/adopt"] = (200, {"adopted": True, "connectionId": 1})
        for target, name, value in ((server, "_pl_owns", lambda: True), (server, "PROVIDER_LAYER", self.layer),
                                    (server, "_layer_gateway_client", None),
                                    (server, "_read_gateway_config", lambda *a: ("ws://host.docker.internal:18789", TOKEN))):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_saved_gateway_handed_to_the_layer_and_never_echoed(self):
        out = server._pl_adopt_saved_gateway()
        self.assertEqual(out, {"adopted": True, "connectionId": 1})
        path, principal, body = self.layer.calls[0]
        self.assertEqual((path, principal, body), ("/api/pl/internal/openclaw/adopt", "internal-signed",
                                                   {"url": "ws://host.docker.internal:18789", "token": TOKEN}))
        self.assertNotIn(TOKEN, json.dumps(out))

    def test_wizard_test_shows_the_layer_waiting_for_approval(self):
        self.layer.answers["/api/pl/internal/openclaw/status"] = (200, {"ok": True, "connectionId": 1, "connected": False, "state": "pairing",
                                                                        "detail": "Waiting for approval in OpenClaw.", "fix": "openclaw devices approve abc"})
        out = server._pl_gateway_test(wait_s=0)
        self.assertEqual((out["ok"], out["gateway"], out["token"], out["permission"], out["fix"], out["via"], out["adopted"]),
                         (True, "reachable", True, False, "openclaw devices approve abc", "layer", True))
        self.assertNotIn(TOKEN, json.dumps(out))

    def test_wizard_test_connected_counts_agents(self):
        self.layer.answers["/api/pl/internal/openclaw/status"] = CONNECTED
        self.layer.answers["/api/pl/internal/openclaw/call"] = (200, {"ok": True, "payload": {"agents": [{"id": "main"}, {"id": "ops"}]}})
        out = server._pl_gateway_test(wait_s=0)
        self.assertEqual((out["ok"], out["permission"], out["agents"]), (True, True, 2))

    def test_no_token_nothing_handed_over(self):
        with mock.patch.object(server, "_read_gateway_config", lambda *a: ("ws://127.0.0.1:18789", "")):
            self.assertIsNone(server._pl_adopt_saved_gateway())
            self.assertEqual(server._pl_gateway_test(wait_s=0)["token"], False)
        self.assertEqual(self.layer.calls, [])


class WizardFolderCheck(unittest.TestCase):
    """The wizard's Detect with the layer on checks the OpenClaw folder on its own (/api/setup/openclaw-folder): ids,
    names and emoji from openclaw.json, never a setting or the gateway token."""

    def folder(self, cfg):
        tmp = tempfile.TemporaryDirectory(prefix="vo-oc-folder-")
        self.addCleanup(tmp.cleanup)
        if cfg is not None:
            Path(tmp.name, "openclaw.json").write_text(cfg if isinstance(cfg, str) else json.dumps(cfg))
        patcher = mock.patch.object(server, "WORKSPACE_BASE", tmp.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        return tmp.name

    def test_keyed_entries_and_legacy_list(self):
        home = self.folder({"gateway": {"auth": {"token": TOKEN}}, "agents": {"entries": {
            "main": {"name": "Main", "identity": {"emoji": "\U0001F99E"}, "model": "x/y"}, "ops": {"workspace": "/w"}}}})
        out = server._setup_openclaw_folder()
        self.assertEqual((out["path"], out["found"], out["readable"]), (home, True, True))
        self.assertEqual(out["agents"], [{"id": "main", "name": "Main", "emoji": "\U0001F99E"}, {"id": "ops", "name": "ops", "emoji": ""}])
        self.assertNotIn(TOKEN, json.dumps(out))
        self.assertNotIn("/w", json.dumps(out))
        self.folder({"agents": {"list": [{"id": "a<b>", "name": "A\"q"}]}})
        self.assertEqual(server._setup_openclaw_folder()["agents"], [{"id": "ab", "name": "Aq", "emoji": ""}])

    def test_missing_or_unreadable_folder(self):
        self.folder(None)
        out = server._setup_openclaw_folder()
        self.assertEqual((out["found"], out["readable"], out["agents"]), (False, False, []))
        self.folder("{ not json")
        out = server._setup_openclaw_folder()
        self.assertEqual((out["found"], out["readable"]), (True, False))

    def test_route_answers(self):
        self.assertIn('request_path == "/api/setup/openclaw-folder"', Path(server.__file__).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
