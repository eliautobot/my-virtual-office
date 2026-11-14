"""F4 (0.12.0): with an office passcode, the agent API token cannot change the office's settings.

Provider settings (CLI executables and homes), the setup wizard, the gateway, model providers and keys, the
licence, the SMS takeover switches and creating or deleting agents are for a person signed in to the office
(session cookie) or this machine without the token; agents keep their own routes (status, messages, meetings,
tasks, files). Without a passcode the office is open, as documented, and nothing changes.
"""

import atexit
import http.client
import json
import os
import re
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-f4-guard-")
atexit.register(_SERVER_DATA.cleanup)
(Path(_SERVER_DATA.name) / "openclaw").mkdir()
os.environ.setdefault("VO_STATUS_DIR", _SERVER_DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_SERVER_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_SERVER_DATA.name) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

import sys  # noqa: E402

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import server  # noqa: E402
import vo_access  # noqa: E402

PEOPLE_ONLY_POSTS = [
    "/api/provider-settings/save", "/setup/save", "/api/provider-test", "/api/browser/test", "/api/pc-metrics/test",
    "/api/hermes/test", "/api/agent/create", "/set-model", "/api/gateway/configure", "/api/openclaw/leftovers/cleanup",
    "/config/providers/save-key", "/config/providers/delete-key", "/config/providers/save-custom",
    "/api/license/activate", "/api/license/deactivate", "/sms-mode", "/sms-thread-mode", "/sms-send",
    "/api/native-models/openclaw/agent-model", "/api/native-models/openclaw/auth/api-key",
    "/api/native-models/openclaw/auth/delete", "/api/native-models/openclaw/auth/sync-static",
    "/api/native-models/openclaw/auth/reset-overrides", "/api/native-models/openclaw/provider",
    "/api/native-models/openclaw/provider/delete", "/api/native-models/hermes/profile-model",
    "/api/native-models/hermes/auth/api-key", "/api/native-models/hermes/auth/delete",
    "/api/native-models/hermes/provider", "/api/native-models/hermes/provider/delete",
]
PEOPLE_ONLY_DELETES = ["/api/agent/delete"]
# Agents' own work: chat, status, meetings, tasks, files, skills, previews, the office floor.
AGENT_POSTS = [
    "/api/meetings/create", "/api/meetings/end", "/api/presence/elm", "/api/projects", "/api/projects/p1/tasks",
    "/api/agent-workspace/elm/notes.md", "/upload", "/api/previews", "/api/codex/chat", "/api/hermes/chat",
    "/api/claude-code/runs", "/api/agent-platform-communications/send", "/api/skills-library",
    "/api/office-config", "/api/layouts", "/transcribe", "/agent-bio-save/elm", "/clear-notify",
    "/api/office/chat-sessions/create", "/api/codex/approval/respond",
]
AGENT_DELETES = ["/api/projects/p1", "/api/meetings/history/m1", "/api/agent/elm/skills/s1"]


class _Office(unittest.TestCase):
    """The office on a scratch data folder; the routes behind the gate are stubbed so only the gate decides."""

    stub_routes = True

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-f4-")
        self.status = Path(self.temp.name)
        self.store = vo_access.AccessStore(str(self.status))
        self.patches = [mock.patch.object(server, "ACCESS_STORE", self.store),
                        mock.patch.object(server, "PROVIDER_LAYER", None)]
        if self.stub_routes:
            def routed(handler):
                handler._send_json({"ok": True, "routed": handler.command})
            self.patches += [mock.patch.object(server.OfficeHandler, "_route_POST", routed),
                             mock.patch.object(server.OfficeHandler, "_route_DELETE", routed),
                             mock.patch.object(server.OfficeHandler, "_route_PUT", routed),
                             mock.patch.object(server.OfficeHandler, "_route_GET", routed)]
        for p in self.patches:
            p.start()
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body if body is not None else {}).encode() if method != "GET" else None
        hdrs = {"Content-Type": "application/json"} if data else {}
        hdrs.update(headers or {})
        conn.request(method, path, body=data, headers=hdrs)
        res = conn.getresponse()
        raw = res.read().decode("utf-8", "replace")
        conn.close()
        try:
            return res.status, json.loads(raw)
        except ValueError:
            return res.status, raw

    def bearer(self):
        return {"Authorization": f"Bearer {self.store.agent_token()}"}

    def remote(self):
        return mock.patch.object(vo_access, "is_loopback_ip", return_value=False)

    def assertRefused(self, method, path, headers):
        status, out = self.request(method, path, headers=headers)
        self.assertEqual(status, 403, f"{method} {path}: {status} {out}")
        self.assertEqual(out.get("error"), "forbidden", path)
        self.assertEqual(out.get("message"), server.PEOPLE_ONLY_TEXT, path)

    def assertRouted(self, method, path, headers):
        status, out = self.request(method, path, headers=headers)
        self.assertEqual((status, out.get("routed") if isinstance(out, dict) else out), (200, method),
                         f"{method} {path}")


class AgentTokenGuardTests(_Office):
    def test_token_refused_on_every_people_only_route(self):
        self.store.set_passcode("open-sesame")
        with self.remote():
            for path in PEOPLE_ONLY_POSTS:
                self.assertRefused("POST", path, self.bearer())
            for path in PEOPLE_ONLY_DELETES:
                self.assertRefused("DELETE", path, self.bearer())

    def test_token_refused_from_this_machine_too(self):
        # (same rule as the Agent Providers routes: a caller that sends the token is an agent, wherever it runs)
        self.store.set_passcode("open-sesame")
        for path in ("/api/provider-settings/save", "/setup/save", "/api/gateway/configure"):
            self.assertRefused("POST", path, self.bearer())
        self.assertRefused("DELETE", "/api/agent/delete", self.bearer())

    def test_signed_in_person_allowed(self):
        self.store.set_passcode("open-sesame")
        cookie = {"Cookie": f"{vo_access.SESSION_COOKIE}={self.store.create_session()}"}
        with self.remote():
            for path in PEOPLE_ONLY_POSTS:
                self.assertRouted("POST", path, cookie)
            for path in PEOPLE_ONLY_DELETES:
                self.assertRouted("DELETE", path, cookie)

    def test_this_machine_without_token_allowed(self):
        self.store.set_passcode("open-sesame")
        for path in PEOPLE_ONLY_POSTS:
            self.assertRouted("POST", path, {})
        self.assertRouted("DELETE", "/api/agent/delete", {})

    def test_agent_routes_still_work_with_token(self):
        self.store.set_passcode("open-sesame")
        with self.remote():
            for path in AGENT_POSTS:
                self.assertRouted("POST", path, self.bearer())
            for path in AGENT_DELETES:
                self.assertRouted("DELETE", path, self.bearer())
            self.assertRouted("PUT", "/api/projects/p1", self.bearer())
            # reading the settings pages' data stays open to the token (no secret in any GET: hp-core A1)
            for path in ("/api/native-models/openclaw", "/api/provider-settings", "/setup/config"):
                self.assertRouted("GET", path, self.bearer())

    def test_no_passcode_open_mode_unchanged(self):
        self.assertFalse(self.store.protected)
        with self.remote():
            for path in PEOPLE_ONLY_POSTS:
                self.assertRouted("POST", path, self.bearer())
                self.assertRouted("POST", path, {})
            self.assertRouted("DELETE", "/api/agent/delete", self.bearer())

    def test_signed_out_browser_still_needs_the_passcode(self):
        self.store.set_passcode("open-sesame")
        with self.remote():
            status, out = self.request("POST", "/setup/save")
            self.assertEqual((status, out.get("error")), (401, "auth_required"))

    def test_people_only_list_names_real_routes(self):
        source = (APP_ROOT / "server.py").read_text(encoding="utf-8")
        for path in server.PEOPLE_ONLY_ROUTES["POST"] | server.PEOPLE_ONLY_ROUTES["DELETE"]:
            # (named once in the list and at least once more where the route is answered)
            self.assertGreaterEqual(len(re.findall('"' + re.escape(path) + '"', source)), 2, path)
        self.assertTrue(server._people_only_route("POST", "/api/native-models/hermes/provider"))
        self.assertFalse(server._people_only_route("GET", "/api/native-models/hermes/provider"))
        self.assertFalse(server._people_only_route("POST", "/api/native-models-x"))


class RealHandlerTests(_Office):
    """The provider settings save itself: the token gets the message, a signed-in person saves."""

    stub_routes = False

    def test_provider_settings_save(self):
        self.store.set_passcode("open-sesame")
        cfg = self.status / "vo-config.json"
        cfg.write_text(json.dumps({"codex": {}}))
        body = {"providerId": "codex", "values": {"binary": "/tmp/evil"}}
        with self.remote(), mock.patch.object(server, "VO_CONFIG", dict(server.VO_CONFIG)), \
                mock.patch.dict(os.environ, {"VO_CONFIG": str(cfg), "VO_STATUS_DIR": str(self.status)}):
            status, out = self.request("POST", "/api/provider-settings/save", body, self.bearer())
            self.assertEqual((status, out.get("message")), (403, server.PEOPLE_ONLY_TEXT))
            self.assertNotIn("/tmp/evil", cfg.read_text())


if __name__ == "__main__":
    unittest.main()
