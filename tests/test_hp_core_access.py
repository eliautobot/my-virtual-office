"""hp-core A1: gates M/F/R, /api/access/confirm, /api/agent-providers routes, no secret in any GET."""

import atexit
import http.client
import json
import os
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-hp-core-")
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

SECRET_TOKEN = "hp-secret-token-7f3a91"
SECRET_PASSWORD = "hp-secret-password-55b2"
LEGACY_KEY = "hp-legacy-apikey-c0ffee"
GATEWAY_TOKEN = "hp-gateway-token-d00d"
ALL_SECRETS = (SECRET_TOKEN, SECRET_PASSWORD, LEGACY_KEY, GATEWAY_TOKEN)


class Access:
    """A stand-in for vo_access.RequestAccess in unit checks."""

    def __init__(self, protected=True, loopback=False, token=False, session=False, session_token=""):
        self.protected, self.via_loopback, self.via_token = protected, loopback, token
        self.via_session, self.session_token = session, session_token

    @property
    def can_manage(self):
        return (not self.protected) or self.via_loopback or self.via_session


class GateUnitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-hp-gate-")
        self.store = vo_access.AccessStore(self.temp.name)
        ap.configure(self.temp.name, access_store=self.store)

    def tearDown(self):
        server._hp_configure()
        self.temp.cleanup()

    def test_manage_refuses_agent_token(self):
        ap.require_manage(Access(loopback=True))
        ap.require_manage(Access(session=True))
        ap.require_manage(Access(protected=False))
        for access in (Access(token=True), Access(loopback=True, token=True), Access(protected=False, token=True),
                       Access(), None):
            with self.assertRaises(ap.ProviderError) as ctx:
                ap.require_manage(access)
            self.assertEqual((ctx.exception.status, ctx.exception.code), (403, "forbidden"))

    def test_recent_window(self):
        self.store.set_passcode("open-sesame")
        session = self.store.create_session()
        ap.require_recent(Access(loopback=True))           # this machine: no passcode asked
        ap.require_recent(Access(protected=False))          # no office passcode
        browser = Access(session=True, session_token=session)
        with self.assertRaises(ap.ProviderError) as ctx:
            ap.require_recent(browser)
        self.assertEqual(ctx.exception.code, "reauth_required")
        self.assertEqual(self.store.confirm(session, "wrong"), 0)
        until = self.store.confirm(session, "open-sesame")
        self.assertGreater(until, time.time() + 590)
        ap.require_recent(browser)
        with mock.patch.object(vo_access, "_now", return_value=time.time() + 601):
            with self.assertRaises(ap.ProviderError):
                ap.require_recent(browser)
        with self.assertRaises(ap.ProviderError):  # another session never inherits it
            ap.require_recent(Access(session=True, session_token=self.store.create_session()))
        self.assertEqual(self.store.confirm("not-a-session", "open-sesame"), 0)

    def test_full_access_gate_texts(self):
        def _add(data):
            data["connections"].append({"id": "lab", "kind": "hermes", "transport": "serve", "access": "chat"})
            data["legacy"]["astra"] = {"access": "chat"}
            data["openclaw"]["access"] = "full"
        ap.STATE.store.update(_add)
        ap.require_full("openclaw")
        self.assertIn("OpenClaw's settings", ap.chat_only_reason("openclaw", "settings"))
        for kind, cid, area, words in (("hermes", "lab", "settings", "Chat only access: Hermes' settings are not"),
                                       ("hermes", "lab", "files", "files on Hermes' computer"),
                                       ("hermes", "astra", "settings", "Chat only"),
                                       ("hermes", "unknown", "screen", "agent's screen")):
            with self.assertRaises(ap.ProviderError) as ctx:
                ap.require_full(kind, cid, area)
            self.assertEqual((ctx.exception.status, ctx.exception.code), (403, "chat_only"))
            self.assertIn(words, ctx.exception.message)
            self.assertEqual(ctx.exception.fix, ap.FIX_FULL_ACCESS)

    def test_audit_line_has_no_params(self):
        ap.audit("lab", "hermes", "config.patch")
        path = Path(self.temp.name) / ap.AUDIT_FILE
        row = json.loads(path.read_text().strip())
        self.assertEqual(set(row), {"at", "connection", "kind", "method"})
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


class OpenClawStatusTests(unittest.TestCase):
    def info(self, client_status, token="t"):
        client = mock.Mock()
        client.status.return_value = client_status
        roster = [{"id": "main", "providerKind": "openclaw", "name": "Main"}, {"id": "x", "providerKind": "codex"}]
        with mock.patch.object(server, "_get_openclaw_gateway_client", return_value=client), \
                mock.patch.object(server, "_get_gateway_token", return_value=token), \
                mock.patch.object(server, "get_roster", return_value=roster):
            return server._hp_openclaw_info()

    def test_states(self):
        out = self.info({"connected": True, "generation": 1, "version": "2026.10.1"})
        self.assertEqual((out["status"]["state"], out["status"]["detail"]), ("connected", "Connected to OpenClaw 2026.10.1."))
        self.assertEqual([a["id"] for a in out["agents"]], ["main"])
        self.assertTrue(out["tokenSet"])
        self.assertEqual(self.info({"connected": False, "generation": 0, "lastError": ""})["status"]["code"], "idle")
        self.assertEqual(self.info({"connected": False, "generation": 2, "lastError": "connect refused"})["status"]["code"],
                         "unreachable")
        self.assertEqual(self.info({"connected": False, "generation": 1, "lastError": "unauthorized: token mismatch"})
                         ["status"]["code"], "auth_rejected")
        self.assertEqual(self.info({"connected": False}, token="")["status"]["code"], "not_configured")


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-hp-route-")
        self.status = Path(self.temp.name) / "status"
        self.status.mkdir()
        cfg = {"hermes": {"connections": [{"id": "astra", "name": "Astra", "apiUrl": "http://127.0.0.1:9",
                                           "apiKey": LEGACY_KEY, "enabled": True}]},
               "openclaw": {"gatewayUrl": "ws://127.0.0.1:9", "gatewayToken": GATEWAY_TOKEN}}
        self.cfg_path = self.status / "vo-config.json"
        self.cfg_path.write_text(json.dumps(cfg))
        self.store = vo_access.AccessStore(str(self.status))
        vo_cfg = dict(server.VO_CONFIG, hermes=cfg["hermes"], openclaw=dict(server.VO_CONFIG["openclaw"], **cfg["openclaw"]))
        self.patches = [
            mock.patch.object(server, "STATUS_DIR", str(self.status)),
            mock.patch.object(server, "ACCESS_STORE", self.store),
            mock.patch.object(server, "VO_CONFIG", vo_cfg),
            mock.patch.dict(os.environ, {"VO_STATUS_DIR": str(self.status), "VO_CONFIG": str(self.cfg_path)}),
            mock.patch.object(server, "_reload_provider_settings_runtime", lambda: None),
            mock.patch.object(server, "_hp_legacy_status", lambda row: {"state": "connected", "code": "",
                                                                        "detail": "ok", "fix": "", "version": ""}),
            mock.patch.object(server, "_hp_openclaw_info", lambda: {"url": "ws://127.0.0.1:9", "tokenSet": True,
                                                                    "tokenSource": "office", "agents": [],
                                                                    "status": {"state": "offline"}}),
            mock.patch.object(server, "_hp_legacy_agents", lambda: {}),
        ]
        for p in self.patches:
            p.start()
        server._hp_configure(str(self.status))
        ap.register_adapter("hermes", ap.StubAdapter("hermes"))  # store/list/save only: no Hermes link
        ap.migrate(str(self.status), str(self.cfg_path))
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]
        self.bodies = []

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        for p in reversed(self.patches):
            p.stop()
        server._hp_configure()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        hdrs = {"Content-Type": "application/json"} if data else {}
        hdrs.update(headers or {})
        conn.request(method, path, body=data, headers=hdrs)
        res = conn.getresponse()
        raw = res.read().decode("utf-8", "replace")
        conn.close()
        self.bodies.append(raw)
        try:
            return res.status, json.loads(raw)
        except ValueError:
            return res.status, raw

    def save_lab(self, **values):
        payload = {"kind": "hermes", "transport": "serve",
                   "values": dict({"name": "Hermes Lab", "url": "http://127.0.0.1:19128", "auth": "token",
                                   "token": SECRET_TOKEN, "access": "full"}, **values)}
        return self.request("POST", "/api/agent-providers/save", payload)

    def test_list_save_enable_remove_and_no_secret_leaks(self):
        status, listing = self.request("GET", "/api/agent-providers")
        self.assertEqual(status, 200)
        kinds = [(p["id"], p["transport"]) for p in listing["providers"]]
        self.assertEqual(kinds, [("astra", "api"), ("openclaw", "gateway")])
        self.assertEqual(listing["providers"][0]["secrets"], {"apiKey": True})
        self.assertEqual(listing["providers"][1]["secrets"], {"token": True})
        self.assertEqual(set(listing["manifests"]), {"hermes", "hermes-api", "openclaw"})
        self.assertIn("config.patch", listing["manifests"]["hermes"]["menuWrite"])

        status, saved = self.save_lab()
        self.assertEqual(status, 200, saved)
        cid = saved["id"]
        self.assertEqual(cid, "lab")
        self.assertEqual(saved["status"]["state"], "offline")
        status, listing = self.request("GET", "/api/agent-providers")
        row = next(p for p in listing["providers"] if p["id"] == cid)
        self.assertEqual(row["secrets"], {"token": True})
        self.assertEqual(row["fields"]["url"], "http://127.0.0.1:19128")
        self.assertEqual(row["access"], "full")

        # blank secret keeps it; password sign-in stores the password as a handoff secret
        status, _ = self.request("POST", "/api/agent-providers/save",
                                 {"id": cid, "kind": "hermes", "transport": "serve", "values": {"token": ""}})
        self.assertEqual(status, 200)
        self.assertEqual(ap.STATE.secrets.get("hermes", cid, "token"), SECRET_TOKEN)
        status, _ = self.request("POST", "/api/agent-providers/save",
                                 {"id": cid, "kind": "hermes", "transport": "serve",
                                  "values": {"auth": "password", "username": "me", "password": SECRET_PASSWORD}})
        self.assertEqual(status, 200)
        self.assertEqual(ap.STATE.secrets.flags("hermes", cid), {"password": True})

        status, out = self.request("POST", "/api/agent-providers/enable", {"id": cid, "on": False})
        self.assertEqual((status, out["status"]["state"]), (200, "offline"))
        self.assertFalse(ap.find_connection(cid)["enabled"])

        # legacy access + profile, OpenClaw access
        status, _ = self.request("POST", "/api/agent-providers/save",
                                 {"id": "astra", "kind": "hermes", "transport": "api",
                                  "values": {"access": "chat", "profile": "default"}})
        self.assertEqual(status, 200)
        self.assertEqual(ap.connection_access("hermes", "astra"), "chat")
        status, _ = self.request("POST", "/api/agent-providers/save",
                                 {"kind": "openclaw", "values": {"access": "chat"}})
        self.assertEqual(status, 200)
        self.assertEqual(ap.connection_access("openclaw"), "chat")
        self.assertEqual(json.loads(self.cfg_path.read_text())["openclaw"]["gatewayToken"], GATEWAY_TOKEN)

        status, out = self.request("POST", "/api/agent-providers/remove", {"id": cid})
        self.assertEqual(status, 200)
        self.assertIsNone(ap.find_connection(cid))
        self.assertEqual(ap.STATE.secrets.flags("hermes", cid), {})

        for raw in self.bodies:
            for secret in ALL_SECRETS:
                self.assertNotIn(secret, raw)
        for name in (ap.FILE_NAME, ap.SECRETS_FILE):
            self.assertEqual(stat.S_IMODE((self.status / name).stat().st_mode), 0o600)

    def test_validation_errors(self):
        cases = [({"url": "ftp://x"}, "url"), ({"name": ""}, "name"), ({"name": "x" * 61}, "name"),
                 ({"token": ""}, "token"), ({"access": "root"}, "access"),
                 ({"auth": "password", "token": "", "username": ""}, "username"),
                 ({"auth": "password", "token": "", "username": "me"}, "password")]
        for values, field in cases:
            status, out = self.save_lab(**values)
            self.assertEqual((status, out.get("error"), out.get("field")), (400, "invalid", field), values)
        self.assertEqual(ap.load()["connections"], [])
        status, out = self.request("POST", "/api/agent-providers/save",
                                   {"kind": "openclaw", "values": {"url": "http://x"}})
        self.assertEqual((status, out.get("field")), (400, "url"))

    def test_ids_never_collide_with_legacy(self):
        _, a = self.save_lab(name="Astra")
        _, b = self.save_lab(name="Hermes")
        _, c = self.save_lab(name="Hermes")
        self.assertEqual((a["id"], b["id"], c["id"]), ("astra-2", "main", "main-2"))

    def test_agent_token_and_signed_out_browser_refused(self):
        self.store.set_passcode("open-sesame")
        token = self.store.agent_token()
        with mock.patch.object(vo_access, "is_loopback_ip", return_value=False):
            status, out = self.request("GET", "/api/agent-providers")
            self.assertEqual(status, 401)
            status, out = self.request("GET", "/api/agent-providers", headers={"Authorization": f"Bearer {token}"})
            self.assertEqual((status, out.get("error")), (403, "forbidden"))
            status, out = self.request("POST", "/api/agent-providers/save", {"kind": "openclaw", "values": {}},
                                       headers={"Authorization": f"Bearer {token}"})
            self.assertEqual((status, out.get("error")), (403, "forbidden"))
            session = self.store.create_session()
            cookie = {"Cookie": f"{vo_access.SESSION_COOKIE}={session}"}
            status, out = self.request("GET", "/api/agent-providers", headers=cookie)
            self.assertEqual(status, 200)
            status, out = self.request("POST", "/api/access/confirm", {"passcode": "nope"}, headers=cookie)
            self.assertEqual((status, out.get("error")), (401, "bad_passcode"))
            status, out = self.request("POST", "/api/access/confirm", {"passcode": "open-sesame"}, headers=cookie)
            self.assertEqual(status, 200)
            self.assertGreater(out["until"], time.time())
            self.assertTrue(self.store.recently_confirmed(session))
            status, out = self.request("POST", "/api/access/confirm", {"passcode": "open-sesame"},
                                       headers={"Authorization": f"Bearer {token}"})
            self.assertEqual(status, 403)

    def test_unknown_calls_are_json_404(self):
        status, out = self.request("GET", "/api/agent-chat/nope?agent=x")
        self.assertEqual((status, out.get("error")), (404, "not_found"))
        status, out = self.request("GET", "/api/agent-chat/can?agent=x")  # B3: real route, unknown agent
        self.assertEqual((status, out.get("error")), (404, "gone"))
        status, out = self.request("POST", "/api/agent-providers/nope", {})
        self.assertEqual((status, out.get("error")), (404, "not_found"))


if __name__ == "__main__":
    unittest.main()
