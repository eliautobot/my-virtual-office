"""hp-core A1: the provider secrets store (0600, atomic, flags only)."""

import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import provider_secrets  # noqa: E402


class SecretStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-hp-secrets-")
        self.path = os.path.join(self.temp.name, provider_secrets.FILE_NAME)
        self.store = provider_secrets.SecretStore(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def mode(self):
        return stat.S_IMODE(os.stat(self.path).st_mode)

    def test_set_get_and_mode(self):
        self.assertIsNone(self.store.get("hermes", "main", "token"))
        self.assertTrue(self.store.set("hermes", "main", "token", "tok-secret-1"))
        self.assertEqual(self.store.get("hermes", "main", "token"), "tok-secret-1")
        self.assertEqual(self.mode(), 0o600)
        data = json.loads(Path(self.path).read_text())
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["items"], {"hermes:main": {"token": "tok-secret-1"}})
        self.assertFalse([n for n in os.listdir(self.temp.name) if ".tmp-" in n])

    def test_flags_never_carry_values(self):
        self.store.set("hermes", "main", "token", "tok-secret-2")
        self.store.set("hermes", "main", "tokens", json.dumps({"access": "a", "refresh": "r"}))
        flags = self.store.flags("hermes", "main")
        self.assertEqual(flags, {"token": True, "tokens": True})
        self.assertNotIn("tok-secret-2", json.dumps(flags))
        self.assertEqual(self.store.flags("hermes", "other"), {})

    def test_blank_deletes_and_delete_all(self):
        self.store.set("hermes", "main", "token", "x1")
        self.store.set("hermes", "main", "password", "p1")
        self.store.set("hermes", "main", "password", "")
        self.assertIsNone(self.store.get("hermes", "main", "password"))
        self.assertEqual(self.store.get("hermes", "main", "token"), "x1")
        self.assertTrue(self.store.delete("hermes", "main"))
        self.assertEqual(self.store.flags("hermes", "main"), {})
        self.assertFalse(self.store.delete("hermes", "main"))

    def test_kinds_are_separate(self):
        self.store.set("hermes", "a", "token", "h")
        self.store.set("openclaw", "a", "token", "o")
        self.assertEqual(self.store.get("hermes", "a", "token"), "h")
        self.assertEqual(self.store.get("openclaw", "a", "token"), "o")

    def test_persist_callback(self):
        persist = self.store.persist("hermes")
        persist("main", "tokens", "{}x")
        self.assertEqual(self.store.get("hermes", "main", "tokens"), "{}x")
        persist("main", "tokens", None)
        self.assertIsNone(self.store.get("hermes", "main", "tokens"))

    def test_damaged_file_is_not_overwritten(self):
        Path(self.path).write_text("{not json")
        with self.assertRaises(provider_secrets.SecretStoreError):
            self.store.set("hermes", "main", "token", "x")
        self.assertEqual(Path(self.path).read_text(), "{not json")

    def test_bad_keys_refused(self):
        with self.assertRaises(ValueError):
            self.store.set("", "main", "token", "x")
        with self.assertRaises(ValueError):
            self.store.set("hermes", "main", "token", 5)

    def test_concurrent_writers_keep_every_field(self):
        def worker(n):
            for i in range(20):
                self.store.set("hermes", f"c{n}", f"f{i}", f"v{n}-{i}")
        threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        for n in range(4):
            self.assertEqual(len(self.store.flags("hermes", f"c{n}")), 20)

    def test_ensure_mode_tightens(self):
        Path(self.path).write_text(json.dumps({"version": 1, "items": {}}))
        os.chmod(self.path, 0o644)
        self.store.ensure_mode()
        self.assertEqual(self.mode(), 0o640)  # v0.10.1: the group keeps reading, the world does not
        os.chmod(self.path, 0o606)
        self.store.ensure_mode()
        self.assertEqual(self.mode(), 0o600)


if __name__ == "__main__":
    unittest.main()
