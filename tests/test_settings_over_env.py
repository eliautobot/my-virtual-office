"""Settings saved in the office win over the environment's starting values.

docker-compose.yml gives every container a value for many settings (VO_CODEX_ENABLED=true,
VO_CODEX_SANDBOX, VO_OFFICE_NAME, VO_GATEWAY_URL, ...). Those are starting values: a change the
user saves in Settings must take effect, not be answered "saved" and then replaced by the
environment again. Settings the user did not change keep following the environment, and the
container's wiring (port, data folder) stays with the environment.
"""

import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("VO_PROVIDER_LAYER", "0")
_DATA = tempfile.TemporaryDirectory(prefix="vo-settings-env-")
os.environ.setdefault("VO_STATUS_DIR", _DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_DATA.name) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import server  # noqa: E402

COMPOSE_ENV = {
    "VO_CODEX_ENABLED": "true",
    "VO_CODEX_SANDBOX": "danger-full-access",
    "VO_CODEX_BIN": "codex-from-env",
    "VO_CODEX_INCLUDE_MAIN": "1",
    "VO_CLAUDE_CODE_PERMISSION_MODE": "acceptEdits",
    "VO_OFFICE_NAME": "Virtual Office",
    "VO_PORT": "8090",
    "VO_GATEWAY_URL": "ws://host.docker.internal:18789",
    "VO_GATEWAY_HTTP": "http://host.docker.internal:18789",
}


class SettingsOverEnvironment(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-settings-env-case-")
        cfg = Path(self.temp.name) / "vo-config.json"
        cfg.write_text(json.dumps({"_setupComplete": True}), encoding="utf-8")
        env = dict(COMPOSE_ENV, VO_STATUS_DIR=self.temp.name, VO_CONFIG=str(cfg))
        self.env = mock.patch.dict(os.environ, env)
        self.env.start()
        self.cfg_path = cfg
        self.saved_config = server.VO_CONFIG
        server.VO_CONFIG = server._load_vo_config()

    def tearDown(self):
        self.env.stop()
        server.VO_CONFIG = self.saved_config
        server._reload_gateway_globals()
        server._reset_provider_registry()
        self.temp.cleanup()

    def provider_values(self, provider_id):
        payload = server._provider_settings_payload(provider_id)
        return payload["providers"][0]["values"]

    def test_provider_setting_saved_in_office_beats_environment(self):
        result = server._save_provider_settings({"providerId": "codex", "values": {"enabled": False, "sandbox": "read-only"}})
        self.assertTrue(result.get("ok"), result)
        values = self.provider_values("codex")
        self.assertIs(values["enabled"], False)
        self.assertEqual(values["sandbox"], "read-only")
        # A restart reads the same thing.
        self.assertEqual(server._load_vo_config()["codex"]["sandbox"], "read-only")
        # Untouched settings keep following the environment.
        self.assertEqual(values["binary"], "codex-from-env")

    def test_claude_permission_mode_saved_in_office_is_used(self):
        result = server._save_provider_settings({"providerId": "claude-code", "values": {"permissionMode": "plan"}})
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(self.provider_values("claude-code")["permissionMode"], "plan")
        self.assertEqual(server._claude_code_provider().permission_mode, "plan")

    def test_provider_flag_saved_in_office_reaches_the_provider(self):
        result = server._save_provider_settings({"providerId": "codex", "values": {"includeMain": False}})
        self.assertTrue(result.get("ok"), result)
        self.assertIs(server._codex_provider().include_main, False)

    def test_gateway_address_saved_in_office_is_used(self):
        result = server._save_provider_settings({"providerId": "openclaw", "values": {"gatewayUrl": "ws://192.0.2.7:18789"}})
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(server.VO_CONFIG["openclaw"]["gatewayUrl"], "ws://192.0.2.7:18789")
        self.assertEqual(server.GATEWAY_URL, "ws://192.0.2.7:18789")

    def test_unchanged_save_keeps_following_environment(self):
        values = self.provider_values("codex")
        result = server._save_provider_settings({"providerId": "codex", "values": values})
        self.assertTrue(result.get("ok"), result)
        with mock.patch.dict(os.environ, {"VO_CODEX_SANDBOX": "workspace-write"}):
            self.assertEqual(server._load_vo_config()["codex"]["sandbox"], "workspace-write")

    def test_missing_cli_names_the_setting_users_can_change(self):
        with mock.patch.dict(os.environ, {"HOME": self.temp.name, "PATH": "/nonexistent"}):
            codex = server.CodexProvider(binary="/nonexistent/codex", home_path=self.temp.name).test()
            claude = server.ClaudeCodeProvider(binary="/nonexistent/claude", home_path=self.temp.name).test()
        self.assertIn("More tools > Providers > Codex", codex["error"])
        self.assertIn("More tools > Providers > Claude Code", claude["error"])

    def test_office_name_saved_in_setup_beats_environment_but_port_stays(self):
        httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=60)
            body = json.dumps({"office": {"name": "Acme HQ", "port": 9999}}).encode()
            conn.request("POST", "/setup/save", body=body, headers={"Content-Type": "application/json"})
            res = conn.getresponse()
            res.read()
            conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
        self.assertEqual(res.status, 200)
        self.assertEqual(server.VO_CONFIG["office"]["name"], "Acme HQ")
        loaded = server._load_vo_config()
        self.assertEqual(loaded["office"]["name"], "Acme HQ")
        self.assertEqual(loaded["office"]["port"], 8090)  # the container's wiring stays with the environment


if __name__ == "__main__":
    unittest.main()
