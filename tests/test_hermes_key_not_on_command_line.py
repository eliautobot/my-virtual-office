"""F5 (0.12.0): a Hermes API key is never put on a command line (the process list shows arguments)."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_DATA = tempfile.mkdtemp(prefix="vo-f5-")
(Path(_DATA) / "openclaw").mkdir(exist_ok=True)
os.environ.setdefault("VO_STATUS_DIR", _DATA)
os.environ.setdefault("VO_CONFIG", str(Path(_DATA) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_DATA) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import server  # noqa: E402


class HermesKeyTests(unittest.TestCase):
    def test_save_runs_nothing_and_points_to_hermes_auth(self):
        with mock.patch.object(server, "_run_text_command") as run, \
                mock.patch.object(server, "HERMES_BIN", "/usr/bin/hermes"):
            out = server._save_hermes_api_key("openrouter", "sk-test-not-a-key", "Lab")
        run.assert_not_called()
        self.assertEqual(out.get("_status"), 405)
        self.assertIn("hermes auth", out["error"])

    def test_no_key_argument_anywhere_in_the_server(self):
        for name in ("server.py", "agent_providers.py"):
            source = (APP_ROOT / name).read_text(encoding="utf-8")
            self.assertNotIn('"--api-key"', source, name)


if __name__ == "__main__":
    unittest.main()
