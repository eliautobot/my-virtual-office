"""hp-core fix after D2 (hp-qa: "before the switch the same profile shows twice").

Design 2.10: an API-server Hermes row L on the same machine as a serve connection C reaches C's profile P,
guessed (after legacy[L].profile and L's own id) from L's /v1/models first id ("hermes-agent" = default).
While L is enabled and not switched, P is hidden so the office never shows two agents for one profile; the
legacy agent keeps its id and P appears under that id after the switch. The guess comes from server.py's
``legacy_model_ids`` hook (the legacy status probe's cache) and the last id seen is kept in the legacy entry.
Uses the fake legacy API server pattern of tests/test_hermes_native_connections.py.
"""

import atexit
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-hp-legacy-guess-")
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
import agent_providers as ap  # noqa: E402
import vo_access  # noqa: E402

LEGACY_KEY = "legacy-guess-key"


class FakeLegacyHandler(BaseHTTPRequestHandler):
    server_version = "FakeHermes/1"

    def log_message(self, *_args):
        pass

    def _send(self, body, status=200):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.server.hits.append(self.path)
        if self.headers.get("Authorization") != f"Bearer {LEGACY_KEY}":
            self._send({"error": "unauthorized"}, 401)
        elif self.path == "/health":
            self._send({"status": "ok"})
        elif self.path == "/v1/capabilities":
            self._send({"model": "some-llm", "features": {"run_submission": True, "run_events_sse": True}})
        elif self.path == "/v1/models":
            self._send({"data": [{"id": "hermes-agent"}]})
        else:
            self._send({"error": "not found"}, 404)


class StubServe:
    kind = "hermes"

    def status(self, cid):
        return {"state": "connected", "code": "", "detail": "Connected to Hermes 0.22.", "fix": "", "version": "0.22"}

    def agents(self, cid):
        return [{"name": "default"}, {"name": "nova", "display_name": "Nova"}]


def wait_for(predicate, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    return predicate()


class LegacyGuess(unittest.TestCase):
    def setUp(self):
        self.legacy = ThreadingHTTPServer(("127.0.0.1", 0), FakeLegacyHandler)
        self.legacy.hits = []
        threading.Thread(target=self.legacy.serve_forever, daemon=True).start()
        self.legacy_url = f"http://127.0.0.1:{self.legacy.server_address[1]}"
        self.temp = tempfile.TemporaryDirectory(prefix="vo-hp-guess-")
        self.status = Path(self.temp.name)
        self.cfg_path = self.status / "vo-config.json"
        self.vo_cfg = dict(server.VO_CONFIG)
        self.write_cfg(enabled=True)
        self.refreshes = []
        self.patches = [
            mock.patch.object(server, "STATUS_DIR", str(self.status)),
            mock.patch.object(server, "ACCESS_STORE", vo_access.AccessStore(str(self.status))),
            mock.patch.object(server, "VO_CONFIG", self.vo_cfg),
            mock.patch.dict(os.environ, {"VO_STATUS_DIR": str(self.status), "VO_CONFIG": str(self.cfg_path)}),
            mock.patch.object(server, "_reload_provider_settings_runtime", self.reload_cfg),
            mock.patch.object(server, "_hp_legacy_agents", lambda: {}),
            mock.patch.object(server, "_hp_refresh_discovery", lambda: self.refreshes.append(time.time())),
        ]
        for p in self.patches:
            p.start()
        with server._HP_LEGACY_STATUS_LOCK:
            server._HP_LEGACY_STATUS.clear()
        server._hp_configure(str(self.status))
        ap.register_adapter("hermes", StubServe())
        ap.migrate(str(self.status), str(self.cfg_path))
        self.lab = ap.save({"kind": "hermes", "transport": "serve",
                            "values": {"name": "Lab", "url": "http://127.0.0.1:19128", "auth": "token",
                                       "token": "lab-token-guess-1", "access": "full"}})["id"]

    def tearDown(self):
        self.legacy.shutdown()
        self.legacy.server_close()
        for p in reversed(self.patches):
            p.stop()
        with ap._ADAPTERS_LOCK:
            ap._ADAPTERS.pop("hermes", None)
        off = ap._LISTENER_OFF.pop("hermes", None)
        if callable(off):
            off()
        with server._HP_LEGACY_STATUS_LOCK:
            server._HP_LEGACY_STATUS.clear()
        server._hp_configure()
        self.temp.cleanup()

    def write_cfg(self, enabled, url=None):
        row = {"id": "astra", "name": "Astra", "apiUrl": url or self.legacy_url, "apiKey": LEGACY_KEY,
               "enabled": enabled}
        self.cfg_path.write_text(json.dumps({"hermes": {"connections": [row]}}))
        self.reload_cfg()

    def reload_cfg(self):
        self.vo_cfg.update(json.loads(self.cfg_path.read_text()))

    def profiles_shown(self):
        return sorted(r["providerAgentId"] for r in ap.discovery_rows())

    def test_profile_hidden_behind_legacy_row_until_switch(self):
        self.assertEqual(wait_for(lambda: self.profiles_shown() == ["nova"]) and self.profiles_shown(), ["nova"])
        self.assertIn("/v1/models", self.legacy.hits)
        entry = ap.load()["legacy"]["astra"]
        self.assertEqual((entry.get("modelId"), entry.get("modelUrl")), ("hermes-agent", self.legacy_url))
        self.assertTrue(wait_for(lambda: self.refreshes), "the roster is refreshed once the guess is known")
        listing = ap.list_providers()["providers"]
        lab = next(p for p in listing if p["id"] == self.lab)
        default = next(a for a in lab["agents"] if a["nativeId"] == "default")
        self.assertTrue(default["hidden"])
        self.assertIn('older connection "Astra"', default["reason"])
        astra = next(p for p in listing if p["id"] == "astra")
        self.assertEqual(astra["legacy"]["guess"], "default")
        self.assertNotIn("modelId", astra["status"])
        # The switch: the profile shows under the legacy agent's id, the older row is switched off.
        moved = ap.switch({"to": self.lab, "moves": [{"legacyId": "astra", "profile": "default"}]})
        self.assertEqual(moved["moved"][0]["agentId"], "hermes-astra")
        rows = {r["providerAgentId"]: r["id"] for r in ap.discovery_rows()}
        self.assertEqual(rows.get("default"), "hermes-astra")
        self.assertIn("nova", rows)
        self.assertFalse(json.loads(self.cfg_path.read_text())["hermes"]["connections"][0]["enabled"])

    def test_last_seen_id_kept_while_the_server_is_down(self):
        self.assertTrue(wait_for(lambda: ap.load()["legacy"]["astra"].get("modelId") == "hermes-agent"))
        self.legacy.shutdown()
        self.legacy.server_close()
        with server._HP_LEGACY_STATUS_LOCK:
            server._HP_LEGACY_STATUS.clear()          # as after an office restart
        self.assertEqual(self.profiles_shown(), ["nova"], "hidden at once from the kept id")
        # A new address has no kept id: nothing guessed there until that server answers.
        self.write_cfg(enabled=True, url="http://127.0.0.1:9")
        self.assertEqual(self.profiles_shown(), ["default", "nova"])

    def test_switched_off_row_hides_nothing_and_is_not_probed(self):
        # setUp's save already listed the row while it was on: its id is known.
        self.assertTrue(wait_for(lambda: ap.load()["legacy"]["astra"].get("modelId") == "hermes-agent"))
        time.sleep(0.3)
        self.write_cfg(enabled=False)
        with server._HP_LEGACY_STATUS_LOCK:
            server._HP_LEGACY_STATUS.clear()
        del self.legacy.hits[:]
        self.assertEqual(self.profiles_shown(), ["default", "nova"])
        time.sleep(0.3)
        self.assertEqual(self.legacy.hits, [])

if __name__ == "__main__":
    unittest.main()
