"""v0.12 moves: appearance.signatureMove survives the real server save and reload.

The server stores the office layout as sent (POST /api/office-config) and never validates an agent's look, so the
new field needs no server change and the server needs no copy of the move list (game.js SIGNATURE_MOVES is the one
list; an unknown id is kept here and drawn as 'auto' by the browser). This test holds that contract: a picked move,
'auto', an old look without the field and an id this build does not know all come back unchanged, a second save of
what was loaded changes nothing, the profile patch keeps the field, and agents without a saved look get no move
(the browser picks one from the id). Temp server data only; nothing here touches ~/.openclaw or a running office."""

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

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v12-moves-")
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

DEFAULT_OFFICE = APP_ROOT / "default-office-config.json"


def _office():
    office = json.loads(DEFAULT_OFFICE.read_text(encoding="utf-8"))
    base = {"skinTone": "#e8b88a", "hairStyle": "short", "hairColor": "#6d4c41"}
    office["agents"] = [
        {"id": "alpha", "name": "Alpha", "appearance": dict(base, signatureMove="airguitar")},
        {"id": "beta", "name": "Beta", "appearance": dict(base, signatureMove="auto")},
        {"id": "gamma", "name": "Gamma", "appearance": dict(base)},
        {"id": "delta", "name": "Delta", "appearance": dict(base, signatureMove="moonwalk")},
    ]
    return office


class SignatureMoveSaveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v12-moves-oc-")
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

    def looks(self, cfg):
        return {a["id"]: a.get("appearance") for a in cfg.get("agents", [])}

    def test_signature_move_survives_save_and_reload(self):
        sent = self.looks(_office())
        self.assertEqual(200, self.request("POST", json.dumps(_office()).encode())[0])
        status, cfg = self.request("GET")
        self.assertEqual(200, status)
        looks = self.looks(cfg)
        self.assertEqual("airguitar", looks["alpha"]["signatureMove"], "a picked move comes back")
        self.assertEqual("auto", looks["beta"]["signatureMove"])
        self.assertNotIn("signatureMove", looks["gamma"], "an old look stays without the field")
        self.assertEqual("moonwalk", looks["delta"]["signatureMove"], "an unknown id is kept, not rejected")
        self.assertEqual(sent, looks)
        self.assertEqual(200, self.request("POST", json.dumps(cfg).encode())[0])
        self.assertEqual(looks, self.looks(self.request("GET")[1]), "a second save of what was loaded changes nothing")

    def test_profile_patch_keeps_the_move(self):
        cfg = _office()
        server._apply_office_config_agent_patch(cfg, "alpha", {"name": "Alpha 2", "emoji": "x", "role": None})
        self.assertEqual("airguitar", self.looks(cfg)["alpha"]["signatureMove"])

    def test_default_look_has_no_move(self):
        roster = [{"id": "main", "name": "Main"}, {"id": "helper-two", "statusKey": "helper-two"}]
        with mock.patch.object(server, "get_roster", return_value=roster):
            cfg = json.loads(server._patch_default_config_agents(DEFAULT_OFFICE.read_text(encoding="utf-8")))
        for look in self.looks(cfg).values():
            self.assertNotIn("signatureMove", look or {}, "the browser picks the move from the id")


if __name__ == "__main__":
    unittest.main()
