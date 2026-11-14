"""Male / Female looks (0.12.0 gender): the office layout route keeps an agent's gender and its
new look fields (lashes + lashStyle, the new Female items) exactly as Agent Studio saved them.
The route stores appearance as sent (drawing falls back for an unknown id), so a round trip must
neither drop nor rewrite them. Temp fixtures only; nothing here touches ~/.openclaw or a live office."""

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

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-gender-data-")
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


class GenderLookRoundTrip(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-gender-oc-")
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

    def call(self, method, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, "/api/office-config", body=body, headers={"Content-Type": "application/json"})
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, json.loads(raw or b"{}")

    def test_gender_and_lash_styles_round_trip(self):
        agents = [
            {"id": "ada", "name": "Ada", "gender": "F", "color": "#8e24aa", "appearance": {
                "hairStyle": "bun", "lashes": True, "lashStyle": "winged", "lipColor": "#a1424a",
                "shirtStyle": "blouse", "neckwear": "necklace", "neckwearColor": "#f9a825", "headwear": "bow", "headwearColor": "#e53935"}},
            {"id": "bo", "name": "Bo", "gender": "M", "color": "#1e88e5", "appearance": {
                "hairStyle": "fade", "lashes": False, "lashStyle": None, "lipColor": None, "facialHair": "beard"}},
            # a look saved before 0.12.0: no lashStyle, unset lashes
            {"id": "cy", "name": "Cy", "gender": "F", "appearance": {"hairStyle": "long", "eyebrowStyle": "thin"}},
        ]
        for style in ("natural", "long", "curled", "winged", "full"):
            agents[0]["appearance"]["lashStyle"] = None if style == "natural" else style
            status, _ = self.call("POST", json.dumps({"canvasWidth": 800, "canvasHeight": 600, "agents": agents}).encode())
            self.assertEqual(200, status)
            status, got = self.call("GET")
            self.assertEqual(200, status)
            by_id = {a["id"]: a for a in got["agents"]}
            self.assertEqual(["F", "M", "F"], [by_id[k]["gender"] for k in ("ada", "bo", "cy")])
            self.assertEqual(agents[0]["appearance"], by_id["ada"]["appearance"])
            self.assertEqual(agents[1]["appearance"], by_id["bo"]["appearance"])
            self.assertNotIn("lashStyle", by_id["cy"]["appearance"])
            self.assertNotIn("lashes", by_id["cy"]["appearance"])


if __name__ == "__main__":
    unittest.main()
