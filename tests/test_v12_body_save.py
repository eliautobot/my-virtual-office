"""v0.12 body: the new look fields survive the real server save and reload.

The server stores the office layout as sent (POST /api/office-config, _office_save_write) and never validates
an agent's look, so shirtStyle, neckwear, neckwearColor and the new costumes need no server change. This test
holds that: a save with the new fields and an old office without them both come back unchanged, the profile
patch keeps the look, and agents without a saved look still get a default look with no top or neckwear (the
browser then draws today's tee). Fixture: tests/fixtures/office-v12-body-looks.json. Temp server data only; nothing here touches ~/.openclaw or a running office."""

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

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v12-body-")
atexit.register(_SERVER_DATA.cleanup)
(Path(_SERVER_DATA.name) / "openclaw").mkdir()
os.environ.setdefault("VO_STATUS_DIR", _SERVER_DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_SERVER_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_SERVER_DATA.name) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import server  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "office-v12-body-looks.json"
DEFAULT_OFFICE = APP_ROOT / "default-office-config.json"
NEW_FIELDS = ("shirtStyle", "neckwear", "neckwearColor")


class BodyLookSaveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v12-body-oc-")
        self.patch = mock.patch.object(server, "STATUS_DIR", self.temp.name)
        self.patch.start()
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.patch.stop()
        self.temp.cleanup()

    def request(self, method, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, "/api/office-config", body=body, headers={"Content-Type": "application/json"})
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, json.loads(data or b"{}")

    def layout(self):
        return json.loads(FIXTURE.read_text(encoding="utf-8"))

    def looks(self, cfg):
        return {a["id"]: a.get("appearance") for a in cfg.get("agents", [])}

    def test_new_fields_and_old_offices_survive_save_and_reload(self):
        sent = self.looks(self.layout())
        self.assertEqual("labcoat", sent["alpha"]["shirtStyle"])
        self.assertEqual("dino", sent["beta"]["costume"])
        self.assertFalse(set(NEW_FIELDS) & set(sent["gamma"]), "gamma is an old look")
        status, _ = self.request("POST", json.dumps(self.layout()).encode())
        self.assertEqual(200, status)
        status, cfg = self.request("GET")
        self.assertEqual(200, status)
        looks = self.looks(cfg)
        self.assertEqual(sent["alpha"], looks["alpha"], "top, neckwear and its colour come back")
        self.assertEqual(sent["beta"], looks["beta"], "a new costume comes back")
        self.assertEqual(sent["gamma"], looks["gamma"], "an old look without the new fields is kept as it was")
        self.assertEqual(sent["delta"], looks["delta"], "values this build does not know are kept, not rejected")
        # A second save of what was loaded (the browser saves what it loaded) changes nothing.
        self.assertEqual(200, self.request("POST", json.dumps(cfg).encode())[0])
        self.assertEqual(looks, self.looks(self.request("GET")[1]))

    def test_shipped_default_office_round_trips_without_new_fields(self):
        office = json.loads(DEFAULT_OFFICE.read_text(encoding="utf-8"))
        self.assertEqual(200, self.request("POST", json.dumps(office).encode())[0])
        cfg = self.request("GET")[1]
        self.assertEqual(self.looks(office), self.looks(cfg))
        for look in self.looks(cfg).values():
            self.assertFalse(set(NEW_FIELDS) & set(look or {}), "nothing adds a top or neckwear to an old office")

    def test_profile_patch_keeps_the_look(self):
        cfg = self.layout()
        before = self.looks(cfg)["alpha"]
        server._apply_office_config_agent_patch(cfg, "alpha", {"name": "Alpha", "emoji": "x", "role": None})
        self.assertEqual(before, self.looks(cfg)["alpha"])

    def test_default_look_has_no_top_or_neckwear(self):
        # Agents without a saved look: the server's default builder must not start choosing tops, so their
        # look (drawn as today's tee) does not change.
        roster = [{"id": "main", "name": "Main"}, {"id": "helper-two", "statusKey": "helper-two"}]
        with mock.patch.object(server, "get_roster", return_value=roster):
            cfg = json.loads(server._patch_default_config_agents(DEFAULT_OFFICE.read_text(encoding="utf-8")))
        self.assertEqual(["main", "helper-two"], [a["id"] for a in cfg["agents"]])
        for look in self.looks(cfg).values():
            self.assertFalse(set(NEW_FIELDS) & set(look), look)
            self.assertIsNone(look.get("costume"))


if __name__ == "__main__":
    unittest.main()
