"""0.12.0 fix (install test bug 3): Codex / Claude Code CLI paths typed in the setup wizard are used in Docker.

docker-compose.yml always sets VO_CODEX_BIN=codex and VO_CLAUDE_CODE_BIN=claude. End to end: the wizard's save
(POST /setup/save) -> what the wizard shows again (/vo-config) -> a restart (_load_vo_config, a new provider registry)
-> the provider classes and discovery use the typed path. A typed path that does not exist is reported as missing, by
its path, and never swapped for another codex/claude found through the environment or PATH.
"""
import http.client
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

_DATA = tempfile.TemporaryDirectory(prefix="vo-cli-paths-")
os.environ.setdefault("VO_PROVIDER_LAYER", "0")
os.environ.setdefault("VO_STATUS_DIR", _DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_DATA.name) / "openclaw"))

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import server  # noqa: E402


def _executable(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\necho 1.0.0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


class WizardCliPathsInDocker(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-cli-paths-case-")
        root = Path(self.temp.name)
        cfg = root / "vo-config.json"
        cfg.write_text(json.dumps({"_setupComplete": False}), encoding="utf-8")
        # (what PATH finds: the image's own codex/claude, which a typed path must win over)
        self.path_dir = root / "path-bin"
        _executable(self.path_dir / "codex")
        _executable(self.path_dir / "claude")
        self.fake_codex = _executable(root / "fake" / "fake-codex")
        self.fake_claude = _executable(root / "fake" / "fake-claude")
        env = {"VO_STATUS_DIR": self.temp.name, "VO_CONFIG": str(cfg), "VO_CODEX_BIN": "codex", "VO_CLAUDE_CODE_BIN": "claude",
               "VO_CODEX_ENABLED": "true", "VO_CLAUDE_CODE_ENABLED": "true", "HOME": self.temp.name,
               "PATH": f"{self.path_dir}:/usr/bin:/bin", "VO_CODEX_INCLUDE_NATIVE_AGENTS": "0", "VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS": "0"}
        self.env = mock.patch.dict(os.environ, env)
        self.env.start()
        self.saved_config = server.VO_CONFIG
        server.VO_CONFIG = server._load_vo_config()
        server._reset_provider_registry()

    def tearDown(self):
        self.env.stop()
        server.VO_CONFIG = self.saved_config
        server._reload_gateway_globals()
        server._reset_provider_registry()
        self.temp.cleanup()

    def request(self, method, path, body=None):
        httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=60)
            data = json.dumps(body).encode() if body is not None else None
            conn.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
            res = conn.getresponse()
            out = res.read()
            conn.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
        return res.status, json.loads(out or b"{}")

    def restart(self):
        server.VO_CONFIG = server._load_vo_config()
        server._reset_provider_registry()

    def test_typed_paths_survive_a_restart_and_reach_the_providers(self):
        status, _ = self.request("POST", "/setup/save", {"codex": {"binary": self.fake_codex}, "claudeCode": {"binary": self.fake_claude}})
        self.assertEqual(status, 200)
        status, cfg = self.request("GET", "/vo-config")              # what the wizard shows after Launch
        self.assertEqual(status, 200)
        self.assertEqual(cfg["codex"]["binary"], self.fake_codex)
        self.assertEqual(cfg["claudeCode"]["binary"], self.fake_claude)
        self.restart()
        self.assertEqual(server.VO_CONFIG["codex"]["binary"], self.fake_codex)
        self.assertEqual(server._codex_provider().binary, self.fake_codex)
        self.assertEqual(server._claude_code_provider().binary, self.fake_claude)
        self.assertNotIn("not found", str(server._codex_provider().test().get("error", "")))

    def test_a_typed_path_that_is_missing_is_reported_never_swapped(self):
        missing_codex, missing_claude = "/nonexistent/fake-codex", "/nonexistent/fake-claude"
        self.request("POST", "/setup/save", {"codex": {"binary": missing_codex}, "claudeCode": {"binary": missing_claude}})
        self.restart()
        codex, claude = server._codex_provider(), server._claude_code_provider()
        self.assertEqual(codex.binary, missing_codex)                # (not PATH's codex)
        self.assertEqual(claude.binary, missing_claude)
        self.assertIn(missing_codex, codex.test()["error"])
        self.assertIn(missing_claude, claude.test()["error"])

    def test_a_test_before_saving_says_which_cli_it_ran(self):
        self.request("POST", "/setup/save", {"codex": {"binary": self.fake_codex}, "claudeCode": {"binary": self.fake_claude}})
        self.restart()
        out = server._handle_codex_test({"binary": "/elsewhere/typed-codex"})
        self.assertEqual(out.get("unsavedBinary"), "/elsewhere/typed-codex")     # (never run: CH-04)
        self.assertEqual(out.get("testedBinary"), self.fake_codex)
        out = server._handle_claude_code_test({"binary": "/elsewhere/typed-claude"})
        self.assertEqual(out.get("unsavedBinary"), "/elsewhere/typed-claude")
        self.assertNotIn("unsavedBinary", server._handle_codex_test({"binary": self.fake_codex}))
        self.assertNotIn("unsavedBinary", server._handle_codex_test({}))
        page = (APP_ROOT / "setup.html").read_text(encoding="utf-8")
        self.assertIn("d.unsavedBinary", page)
        self.assertIn("Press Launch to save it", page)

    def test_a_failed_test_answers_200_with_ok_false(self):
        # (0.12.0 deskpick: a test whose CLI is not reachable is a result, not a server failure; it used to answer
        # 503, which the browser logs as a console error while the page shows the reason)
        missing_codex, missing_claude = "/nonexistent/fake-codex", "/nonexistent/fake-claude"
        self.request("POST", "/setup/save", {"codex": {"binary": missing_codex}, "claudeCode": {"binary": missing_claude}})
        self.restart()
        for method, path, body, missing in (("POST", "/api/codex/test", {"binary": "/elsewhere/typed-codex"}, missing_codex),
                                            ("POST", "/api/claude-code/test", {"binary": "/elsewhere/typed-claude"}, missing_claude),
                                            ("GET", "/api/codex/test", None, missing_codex),
                                            ("GET", "/api/claude-code/test", None, missing_claude)):
            status, out = self.request(method, path, body)
            self.assertEqual(status, 200, method + " " + path)
            self.assertIs(out.get("ok"), False, method + " " + path)
            self.assertIn(missing, str(out.get("error", "")), method + " " + path)

    def test_the_default_name_still_finds_the_cli(self):
        self.restart()
        self.assertEqual(server._codex_provider().binary, str(self.path_dir / "codex"))
        self.assertEqual(server._claude_code_provider().binary, str(self.path_dir / "claude"))


if __name__ == "__main__":
    unittest.main()
