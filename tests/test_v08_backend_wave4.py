"""v0.8 backend wave 4 (QA report fixes): safe post-login target (P1-1), Hermes platform
plugin routes reachable with their own token when a passcode is set (P2-6), anti-framing
headers on HTML (P2-7), login page title (P3-14).
Runs a real server on an ephemeral port with temp data; never touches ~/.openclaw."""

import atexit
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v08-wave4-")
atexit.register(_SERVER_DATA.cleanup)
(Path(_SERVER_DATA.name) / "openclaw").mkdir()
os.environ.setdefault("VO_STATUS_DIR", _SERVER_DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_SERVER_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_SERVER_DATA.name) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = PROJECT_ROOT / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import server  # noqa: E402
import vo_access  # noqa: E402

REMOTE = {"X-Forwarded-For": "192.0.2.10"}  # makes a loopback test client count as remote
PLATFORM_TOKEN = "platform-token-for-tests"


class SafeNextPathTests(unittest.TestCase):
    def test_refuses_targets_a_browser_would_send_off_site(self):
        for value in ("/\t/evil.example/", "/\n/evil.example/", "/\r/evil.example/", "\t//evil.example/",
                      "//evil.example/", "/\\/evil.example/", "/\\evil.example", "https://evil.example/",
                      "javascript:alert(1)", "/x\x00y", "/x\x7fy", "/ /evil.example", "", "evil.example"):
            self.assertEqual("/", vo_access.safe_next_path(value), repr(value))

    def test_keeps_same_office_paths(self):
        for value in ("/", "/cron.html?x=1", "/models#top", "/%2F/evil.example/", "/a/b?next=//x"):
            self.assertEqual(value, vo_access.safe_next_path(value), repr(value))


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v08-wave4-case-")
        self.store = vo_access.AccessStore(self.temp.name, env={})
        self.store_patch = mock.patch.object(server, "ACCESS_STORE", self.store)
        self.store_patch.start()
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.store_patch.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        hdrs = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=hdrs)
        res = conn.getresponse()
        payload = res.read()
        headers_out = {k.lower(): v for k, v in res.getheaders()}
        conn.close()
        return res.status, headers_out, payload


class LoginRedirectTests(ServerCase):
    def test_server_redirect_builds_a_safe_next(self):
        self.store.set_passcode("right one")
        for raw in ("/cron.html?x=1", "/?a=%09b", "/cron.html?next=//evil.example/"):
            status, hdrs, _ = self.request("GET", raw, headers=REMOTE)
            self.assertEqual(302, status, raw)
            location = hdrs.get("location", "")
            self.assertTrue(location.startswith("/login.html?next="), location)
            target = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)["next"][0]
            self.assertEqual(target, vo_access.safe_next_path(target))
            self.assertTrue(target.startswith("/") and not target.startswith("//"), target)


class HermesPlatformPasscodeTests(ServerCase):
    def setUp(self):
        super().setUp()
        self.cfg_patch = mock.patch.dict(server.VO_CONFIG, {"hermes": {
            "platformEnabled": True, "platformToken": PLATFORM_TOKEN, "platformAgentId": "hermes-gateway"}})
        self.cfg_patch.start()
        self.store.set_passcode("right one")

    def tearDown(self):
        self.cfg_patch.stop()
        super().tearDown()

    def platform(self, method, route, token=None, body=None):
        headers = dict(REMOTE)
        if token:
            headers["Authorization"] = "Bearer " + token
        return self.request(method, "/api/hermes-platform/" + route, body=body, headers=headers)

    def test_plugin_routes_work_with_the_platform_token(self):
        status, _h, payload = self.platform("GET", "poll?limit=1", token=PLATFORM_TOKEN)
        self.assertEqual(200, status, payload[:200])
        status, _h, payload = self.platform("POST", "heartbeat", token=PLATFORM_TOKEN,
                                            body={"adapterId": "test-adapter", "status": "running"})
        self.assertEqual(200, status, payload[:200])
        self.assertTrue(json.loads(payload).get("ok"))

    def test_plugin_routes_refuse_without_or_with_a_wrong_token(self):
        for route, method, body in (("poll", "GET", None), ("heartbeat", "POST", {}), ("ack", "POST", {}),
                                    ("reply", "POST", {}), ("enqueue", "POST", {"message": "hi"})):
            status, _h, payload = self.platform(method, route, body=body)
            self.assertEqual(401, status, (route, payload[:120]))
            self.assertNotIn(b"auth_required", payload)  # the route's own token check answered
            status, _h, _p = self.platform(method, route, token="wrong", body=body)
            self.assertEqual(403, status, route)

    def test_status_route_without_token_check_stays_behind_the_passcode(self):
        status, _h, payload = self.platform("GET", "status", token=PLATFORM_TOKEN)
        self.assertEqual(401, status)
        self.assertEqual("auth_required", json.loads(payload).get("error"))


class AntiFramingTests(ServerCase):
    def test_html_pages_refuse_foreign_frames(self):
        for path in ("/", "/login.html", "/cron.html"):
            status, hdrs, _ = self.request("GET", path)
            self.assertEqual(200, status, path)
            self.assertEqual("SAMEORIGIN", hdrs.get("x-frame-options"), path)
            self.assertEqual("frame-ancestors 'self'", hdrs.get("content-security-policy"), path)

    def test_login_page_is_framing_protected_for_remote_visitors(self):
        self.store.set_passcode("right one")
        status, hdrs, _ = self.request("GET", "/login.html", headers=REMOTE)
        self.assertEqual(200, status)
        self.assertEqual("SAMEORIGIN", hdrs.get("x-frame-options"))
        self.assertEqual("frame-ancestors 'self'", hdrs.get("content-security-policy"))

    def test_json_is_left_alone(self):
        status, hdrs, _ = self.request("GET", "/health")
        self.assertEqual(200, status)
        self.assertNotIn("x-frame-options", hdrs)


class LoginPageTextTests(unittest.TestCase):
    def test_login_page_names_my_virtual_office(self):
        html = (APP_ROOT / "login.html").read_text(encoding="utf-8")
        self.assertTrue("<title>Sign in - My Virtual Office</title>" in html, "login.html <title>")
        self.assertTrue("<h1>My Virtual Office</h1>" in html, "login.html card name")


if __name__ == "__main__":
    unittest.main()
