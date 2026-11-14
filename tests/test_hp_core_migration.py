"""hp-core A1: boot migration (design 2.2): backup once, access levels, 0600, idempotent, never deletes."""

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import agent_providers as ap  # noqa: E402

CONFIG = {
    "office": {"name": "Test office"},
    "hermes": {"enabled": True, "connections": [
        {"id": "astra", "name": "Astra", "apiUrl": "http://127.0.0.1:8642", "apiKey": "dummy-key-1", "enabled": True},
        {"id": "coby", "name": "Coby", "apiUrl": "http://127.0.0.1:8954", "apiKey": "dummy-key-2", "enabled": False},
        {"name": "no id row"},
    ]},
    "openclaw": {"gatewayUrl": "ws://127.0.0.1:18789", "gatewayToken": "dummy-gateway"},
}


def mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-hp-migrate-")
        self.data = Path(self.temp.name)
        self.cfg = self.data / "vo-config.json"
        self.cfg.write_text(json.dumps(CONFIG, indent=2))
        os.chmod(self.cfg, 0o644)
        (self.data / "vo-config.json.bak").write_text("{}")
        os.chmod(self.data / "vo-config.json.bak", 0o644)

    def tearDown(self):
        self.temp.cleanup()

    def store(self):
        return json.loads((self.data / ap.FILE_NAME).read_text())

    def test_first_run(self):
        original = self.cfg.read_bytes()
        report = ap.migrate(str(self.data), str(self.cfg))
        self.assertEqual(report["errors"], [])
        self.assertEqual(sorted(report["legacyAdded"]), ["astra", "coby"])
        data = self.store()
        self.assertEqual(data["legacy"], {"astra": {"access": "full"}, "coby": {"access": "full"}})
        self.assertEqual(data["openclaw"], {"access": "full"})
        self.assertEqual(data["connections"], [])
        self.assertEqual(self.cfg.read_bytes(), original)                       # content never rewritten
        self.assertEqual((self.data / "vo-config.json.pre-hp").read_bytes(), original)
        # v0.10.1: world access goes, a group that could read keeps reading (0640); new files are 0600
        for name in ("vo-config.json", "vo-config.json.bak", "vo-config.json.pre-hp"):
            self.assertEqual(mode(self.data / name), 0o640, name)
        self.assertEqual(mode(self.data / ap.FILE_NAME), 0o600)
        self.assertNotIn("dummy-key-1", (self.data / ap.FILE_NAME).read_text())

    def test_second_run_changes_nothing(self):
        ap.migrate(str(self.data), str(self.cfg))
        first = (self.data / ap.FILE_NAME).read_bytes()
        backup = (self.data / "vo-config.json.pre-hp").read_bytes()
        self.cfg.write_text(json.dumps(dict(CONFIG, office={"name": "changed later"})))
        report = ap.migrate(str(self.data), str(self.cfg))
        self.assertEqual((report["legacyAdded"], report["openclawAccess"], report["backup"]), ([], "", ""))
        self.assertEqual((self.data / ap.FILE_NAME).read_bytes(), first)
        self.assertEqual((self.data / "vo-config.json.pre-hp").read_bytes(), backup)  # backup taken once

    def test_keeps_choices_and_records(self):
        (self.data / ap.FILE_NAME).write_text(json.dumps({
            "version": 1,
            "connections": [{"id": "lab", "kind": "hermes", "transport": "serve", "access": "chat"}],
            "legacy": {"astra": {"access": "chat", "profile": "default", "replacedBy": "lab"},
                       "gone": {"access": "full"}},
            "openclaw": {"access": "chat"},
        }))
        ap.migrate(str(self.data), str(self.cfg))
        data = self.store()
        self.assertEqual(data["legacy"]["astra"], {"access": "chat", "profile": "default", "replacedBy": "lab"})
        self.assertIn("gone", data["legacy"])                                   # never deletes
        self.assertEqual(data["legacy"]["coby"], {"access": "full"})
        self.assertEqual(data["openclaw"], {"access": "chat"})
        self.assertEqual(data["connections"][0]["id"], "lab")

    def test_damaged_store_left_alone(self):
        (self.data / ap.FILE_NAME).write_text("{oops")
        report = ap.migrate(str(self.data), str(self.cfg))
        self.assertTrue(report["errors"])
        self.assertEqual((self.data / ap.FILE_NAME).read_text(), "{oops")
        self.assertEqual(mode(self.cfg), 0o640)  # was 0644: no world access, the group keeps reading

    def test_missing_config_is_fine(self):
        self.cfg.unlink()
        report = ap.migrate(str(self.data), str(self.cfg))
        self.assertEqual(report["errors"], [])
        self.assertEqual(self.store()["openclaw"], {"access": "full"})
        self.assertFalse((self.data / "vo-config.json.pre-hp").exists())


if __name__ == "__main__":
    unittest.main()
