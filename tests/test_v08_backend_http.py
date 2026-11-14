"""v0.8 backend HTTP layer: access passcode (C1), cross-site and host checks, JSON
errors (BE-22/23), static allowlist (BE-28/DL-06), gzip/ETag/asset tokens (C5/C7).
Runs a real server on an ephemeral port with temp data; never touches ~/.openclaw."""

import atexit
import gzip
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v08-http-")
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


class HttpLayerBase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v08-http-case-")
        self.store = vo_access.AccessStore(self.temp.name, env={})
        self.store_patch = mock.patch.object(server, "ACCESS_STORE", self.store)
        self.store_patch.start()
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]
        self.host = f"127.0.0.1:{self.port}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.store_patch.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None, raw_body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        hdrs = dict(headers or {})
        data = raw_body
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=hdrs)
        res = conn.getresponse()
        payload = res.read()
        headers_out = {k.lower(): v for k, v in res.getheaders()}
        conn.close()
        if headers_out.get("content-encoding") == "gzip":
            payload = gzip.decompress(payload)
        return res.status, headers_out, payload

    def json_request(self, method, path, body=None, headers=None):
        status, hdrs, payload = self.request(method, path, body, headers)
        return status, hdrs, (json.loads(payload) if payload else None)


class ResponseLayerTests(HttpLayerBase):
    def test_health_reports_version(self):
        status, _h, data = self.json_request("GET", "/health")
        self.assertEqual(200, status)
        self.assertEqual({"ok": True, "version": "0.12.0"}, {k: data[k] for k in ("ok", "version")})

    def test_route_exception_becomes_json_500(self):
        with mock.patch.object(server, "_get_normalized_presence_state", side_effect=RuntimeError("boom")):
            status, hdrs, data = self.json_request("GET", "/status")
        self.assertEqual(500, status)
        self.assertEqual("internal_error", data["error"])
        self.assertIn("application/json", hdrs["content-type"])

    def test_no_wildcard_cors_anywhere(self):
        for method, path in (("GET", "/status"), ("OPTIONS", "/setup/save"), ("GET", "/vo-config")):
            _status, hdrs, _body = self.request(method, path)
            self.assertNotIn("access-control-allow-origin", hdrs, path)

    def test_bad_json_and_oversize_bodies(self):
        status, _h, data = self.json_request("POST", "/api/access/login", headers={"Content-Type": "application/json"},
                                             body=None) if False else (None, None, None)
        status, _h, payload = self.request("POST", "/api/access/login", raw_body=b"{nope",
                                           headers={"Content-Type": "application/json"})
        self.assertEqual(400, status)
        self.assertEqual("invalid_json", json.loads(payload)["error"])
        status, _h, payload = self.request("POST", "/api/access/login", raw_body=b"{" + b" " * 5000 + b"}",
                                           headers={"Content-Type": "application/json"})
        self.assertEqual(413, status)

    def test_static_allowlist_and_json_404(self):
        for path in ("/server.py", "/license.py", "/vo-config.json", "/__pycache__/", "/tests/test_openclaw_progress_events.js",
                     "/providers/hermes.py", "/Dockerfile", "/entrypoint.sh", "/e2e-health", "/../server.py"):
            status, hdrs, _body = self.request("GET", path)
            self.assertEqual(404, status, path)
            self.assertIn("application/json", hdrs.get("content-type", ""), path)
        status, hdrs, data = self.json_request("GET", "/api/definitely-not-a-route")
        self.assertEqual(404, status)
        self.assertEqual("not_found", data["error"])
        status, _h, _b = self.request("GET", "/manifest.json")
        self.assertEqual(200, status)

    def test_query_string_does_not_break_polled_routes(self):
        for path in ("/status?x=1", "/agents-list?x=1", "/agent-chat?x=1"):
            status, _h, _b = self.request("GET", path)
            self.assertEqual(200, status, path)

    def test_html_tokens_gzip_etag_and_immutable_assets(self):
        status, hdrs, body = self.request("GET", "/", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(200, status)
        self.assertEqual("gzip", hdrs.get("content-encoding"))
        self.assertEqual("no-cache", hdrs.get("cache-control"))
        html = body.decode("utf-8")
        token = server._asset_token(str(APP_ROOT / "game.js"))
        self.assertIn(f"game.js?v={token}", html)
        status, hdrs, _ = self.request("GET", f"/game.js?v={token}", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(200, status)
        self.assertIn("immutable", hdrs["cache-control"])
        etag = hdrs["etag"]
        status, hdrs2, body2 = self.request("GET", f"/game.js?v={token}",
                                            headers={"Accept-Encoding": "gzip", "If-None-Match": etag})
        self.assertEqual(304, status)
        self.assertEqual(b"", body2)
        status, hdrs, _ = self.request("GET", "/game.js?v=stale-token")
        self.assertEqual("no-cache", hdrs["cache-control"])

    def test_agent_chat_lite_and_filters(self):
        fake = {"a": [{"role": "assistant", "text": "x" * 5000, "thinking": "secret plan",
                       "tools": [{"id": "1", "name": "terminal", "status": "done", "arguments": "{'command': 'ls'}", "result": "y" * 9000}]}],
                "b": [{"role": "user", "text": "hi"}]}
        with mock.patch.object(server, "AGENT_SESSION_IDS", {"a": "a", "b": "b"}), \
                mock.patch.object(server, "_find_agent_record", return_value={"providerKind": "openclaw"}), \
                mock.patch.object(server, "get_agent_messages", side_effect=lambda key, max_messages=500: fake[key][-max_messages:]), \
                mock.patch.object(server, "_merge_comm_events_into_agent_chat", side_effect=lambda result, per_agent_limit=500: result), \
                mock.patch.object(server, "_load_projects", return_value={"projects": []}):
            status, hdrs, data = self.json_request("GET", "/agent-chat?agents=a&limit=5&lite=1")
            self.assertEqual(200, status)
            self.assertEqual({"a", "_projectWork"}, set(data))
            msg = data["a"][0]
            self.assertIs(True, msg["thinking"])
            self.assertEqual({"id", "name", "status", "summary", "error"}, set(msg["tools"][0]))
            self.assertLessEqual(len(msg["text"]), 4000)
            status, _h, full = self.json_request("GET", "/agent-chat")
            self.assertEqual("secret plan", full["a"][0]["thinking"])
            self.assertIn("b", full)
            etag = hdrs["etag"]
            status, _h, _b = self.request("GET", "/agent-chat?agents=a&limit=5&lite=1", headers={"If-None-Match": etag})
            self.assertEqual(304, status)


class StreamingTests(HttpLayerBase):
    def test_event_stream_headers_arrive_before_first_event(self):
        import socket
        gate = threading.Event()

        def fake_route(handler, run_id):
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.end_headers()
            gate.wait(5)
            handler.wfile.write(b"data: hi\n\n")
            handler.wfile.flush()

        with mock.patch.object(server, "_handle_provider_run_events", side_effect=fake_route):
            sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            sock.sendall(b"GET /api/provider-runs/x/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            head = sock.recv(4096)
            self.assertIn(b"200", head.split(b"\r\n", 1)[0])
            self.assertIn(b"text/event-stream", head)
            gate.set()
            rest = b""
            while b"data: hi" not in rest:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                rest += chunk
            sock.close()
        self.assertIn(b"data: hi", rest)


class CrossSiteTests(HttpLayerBase):
    def test_cross_site_writes_are_blocked_and_same_origin_passes(self):
        status, _h, data = self.json_request("POST", "/api/access/logout", body={},
                                             headers={"Origin": "http://evil.example"})
        self.assertEqual(403, status)
        self.assertEqual("cross_site_blocked", data["error"])
        status, _h, _d = self.json_request("POST", "/api/access/logout", body={},
                                           headers={"Origin": f"http://{self.host}"})
        self.assertEqual(200, status)
        status, _h, _d = self.json_request("POST", "/api/access/logout", body={},
                                           headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(403, status)
        status, _h, _d = self.json_request("POST", "/api/access/logout", body={})  # scripts/agents: no Origin
        self.assertEqual(200, status)

    def test_tailnet_ip_host_with_same_origin_passes(self):
        headers = {"Host": "100.64.0.5:8095", "Origin": "http://100.64.0.5:8095", **REMOTE}
        status, _h, data = self.json_request("POST", "/api/access/logout", body={}, headers=headers)
        self.assertEqual(200, status, data)
        status, _h, _d = self.json_request("GET", "/status", headers=headers)
        self.assertEqual(200, status)

    def test_foreign_host_name_is_refused_unless_protected(self):
        status, _h, data = self.json_request("GET", "/status", headers={"Host": "attacker.example:8095"})
        self.assertEqual(403, status)
        self.assertEqual("host_not_allowed", data["error"])
        for ok_host in ("localhost:8095", "office.local:8095", "box.tail1234.ts.net", "myserver:8095", "[::1]:8095"):
            status, _h, _d = self.json_request("GET", "/status", headers={"Host": ok_host})
            self.assertEqual(200, status, ok_host)


class PasscodeTests(HttpLayerBase):
    def test_open_office_status(self):
        status, _h, data = self.json_request("GET", "/api/access/status", headers=REMOTE)
        self.assertEqual({"protected": False, "authenticated": True, "viaLoopback": False, "canManage": True}, data)

    def test_full_passcode_flow(self):
        status, _h, data = self.json_request("POST", "/api/access/passcode", body={"next": "abc"}, headers=REMOTE)
        self.assertEqual(400, status)
        status, hdrs, data = self.json_request("POST", "/api/access/passcode", body={"next": "open sesame"}, headers=REMOTE)
        self.assertEqual(200, status, data)
        self.assertTrue(self.store.protected)
        self.assertIn("vo_session=", hdrs.get("set-cookie", ""))
        self.assertIn("HttpOnly", hdrs["set-cookie"])
        self.assertIn("SameSite=Lax", hdrs["set-cookie"])

        # Unauthenticated remote browser: API 401, pages redirect, static assets load.
        status, _h, data = self.json_request("GET", "/status", headers=REMOTE)
        self.assertEqual(401, status)
        self.assertEqual("auth_required", data["error"])
        status, hdrs, _b = self.request("GET", "/?x=1", headers=REMOTE)
        self.assertEqual(302, status)
        self.assertEqual("/login.html?next=%2F%3Fx%3D1", hdrs["location"])
        for path in ("/game.js", "/vo-auth.js", "/login.html", "/health", "/api/access/status"):
            status, _h, _b = self.request("GET", path, headers=REMOTE)
            self.assertEqual(200, status, path)

        # Loopback (this machine) and the agent token skip the passcode.
        status, _h, data = self.json_request("GET", "/api/access/status")
        self.assertTrue(data["viaLoopback"])
        self.assertTrue(data["authenticated"])
        status, _h, _d = self.json_request("GET", "/status")
        self.assertEqual(200, status)
        token = self.store.agent_token()
        status, _h, _d = self.json_request("GET", "/status", headers={**REMOTE, "Authorization": f"Bearer {token}"})
        self.assertEqual(200, status)
        status, _h, data = self.json_request("GET", "/api/access/agent-token",
                                             headers={**REMOTE, "Authorization": f"Bearer {token}"})
        self.assertEqual(403, status)  # agents may use the API, not manage access
        status, _h, _d = self.json_request("GET", "/status", headers={**REMOTE, "Authorization": "Bearer wrong"})
        self.assertEqual(401, status)

        # Login.
        status, _h, data = self.json_request("POST", "/api/access/login", body={"passcode": "nope"}, headers=REMOTE)
        self.assertEqual(401, status)
        self.assertEqual("bad_passcode", data["error"])
        status, hdrs, data = self.json_request("POST", "/api/access/login", body={"passcode": "open sesame"}, headers=REMOTE)
        self.assertEqual(200, status)
        cookie = hdrs["set-cookie"].split(";", 1)[0]
        authed = {**REMOTE, "Cookie": cookie}
        status, _h, _d = self.json_request("GET", "/status", headers=authed)
        self.assertEqual(200, status)
        status, _h, data = self.json_request("GET", "/api/access/status", headers=authed)
        self.assertEqual({"protected": True, "authenticated": True, "viaLoopback": False, "canManage": True}, data)

        # Changing it from a remote browser needs the current passcode and drops other sessions.
        status, _h, data = self.json_request("POST", "/api/access/passcode", body={"current": "bad", "next": "new code"}, headers=authed)
        self.assertEqual(401, status)
        status, hdrs, data = self.json_request("POST", "/api/access/passcode",
                                               body={"current": "open sesame", "next": "new code"}, headers=authed)
        self.assertEqual(200, status)
        status, _h, _d = self.json_request("GET", "/status", headers=authed)
        self.assertEqual(401, status)  # old session gone
        new_cookie = hdrs["set-cookie"].split(";", 1)[0]
        status, _h, _d = self.json_request("GET", "/status", headers={**REMOTE, "Cookie": new_cookie})
        self.assertEqual(200, status)

        # Logout ends the session; removing the passcode from loopback works without the current one.
        self.json_request("POST", "/api/access/logout", body={}, headers={**REMOTE, "Cookie": new_cookie})
        status, _h, _d = self.json_request("GET", "/status", headers={**REMOTE, "Cookie": new_cookie})
        self.assertEqual(401, status)
        status, _h, data = self.json_request("POST", "/api/access/passcode", body={"next": ""})
        self.assertEqual(200, status, data)
        self.assertFalse(self.store.protected)

    def test_login_rate_limit(self):
        self.store.set_passcode("right one")
        for _ in range(vo_access.LOGIN_MAX_FAILURES):
            status, _h, _d = self.json_request("POST", "/api/access/login", body={"passcode": "x"}, headers=REMOTE)
            self.assertEqual(401, status)
        status, _h, data = self.json_request("POST", "/api/access/login", body={"passcode": "right one"}, headers=REMOTE)
        self.assertEqual(429, status)
        self.assertEqual("too_many_attempts", data["error"])

    def test_reverse_proxy_on_loopback_is_not_trusted(self):
        self.store.set_passcode("right one")
        status, _h, _d = self.json_request("GET", "/status", headers={"X-Forwarded-For": "203.0.113.9"})
        self.assertEqual(401, status)
        status, _h, _d = self.json_request("GET", "/status", headers={"Host": "office.example.com"})
        self.assertEqual(401, status)  # loopback client, but not a local Host: no exemption


class AccessStoreTests(unittest.TestCase):
    def test_store_persists_hash_not_passcode_and_survives_reload(self):
        with tempfile.TemporaryDirectory() as temp:
            store = vo_access.AccessStore(temp, env={})
            store.set_passcode("hunter22")
            raw = Path(temp, "access.json").read_text(encoding="utf-8")
            self.assertNotIn("hunter22", raw)
            self.assertEqual(0o600, os.stat(Path(temp, "access.json")).st_mode & 0o777)
            token = store.create_session()
            again = vo_access.AccessStore(temp, env={})
            self.assertTrue(again.protected)
            self.assertTrue(again.check_passcode("hunter22"))
            self.assertTrue(again.session_valid(token))
            self.assertNotIn(token, Path(temp, "access.json").read_text(encoding="utf-8"))

    def test_corrupt_store_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, "access.json").write_text("{broken", encoding="utf-8")
            store = vo_access.AccessStore(temp, env={})
            self.assertTrue(store.protected)
            self.assertFalse(store.check_passcode(""))

    def test_trusted_bridge_gateway_counts_as_local_only_with_local_host(self):
        with tempfile.TemporaryDirectory() as temp:
            store = vo_access.AccessStore(temp, env={})
            store.set_passcode("secret code")
            local = vo_access.evaluate(store, "172.17.0.1", {"Host": "127.0.0.1:8090"}, trusted_ips={"172.17.0.1"})
            self.assertTrue(local.authenticated)
            lan_name = vo_access.evaluate(store, "172.17.0.1", {"Host": "192.168.1.5:8090"}, trusted_ips={"172.17.0.1"})
            self.assertFalse(lan_name.authenticated)
            untrusted = vo_access.evaluate(store, "172.17.0.1", {"Host": "127.0.0.1:8090"}, trusted_ips=set())
            self.assertFalse(untrusted.authenticated)

    def test_env_agent_token_wins(self):
        with tempfile.TemporaryDirectory() as temp:
            store = vo_access.AccessStore(temp, env={"VO_AGENT_API_TOKEN": "from-env"})
            self.assertEqual("from-env", store.agent_token())
            self.assertTrue(store.token_valid("from-env"))

    def test_helpers(self):
        self.assertEqual("/", vo_access.safe_next_path("//evil.example/x"))
        self.assertEqual("/", vo_access.safe_next_path("https://evil.example"))
        self.assertEqual("/cron.html?x=1", vo_access.safe_next_path("/cron.html?x=1"))
        self.assertTrue(vo_access.host_allowed("10.0.0.5:8095"))
        self.assertFalse(vo_access.host_allowed("rebind.attacker.example"))
        self.assertTrue(vo_access.host_allowed("office.example.com", ["office.example.com"]))
        self.assertTrue(vo_access.host_allowed("a.office.example.com", [".office.example.com"]))
        self.assertTrue(vo_access.host_allowed("office.example.com", protected=True))
        self.assertTrue(vo_access.same_origin_request({"Host": "h:1"}, "GET"))
        self.assertFalse(vo_access.same_origin_request({"Host": "h:1", "Origin": "null"}, "POST"))
        self.assertFalse(vo_access.same_origin_request({"Host": "h:1", "Referer": "http://x:1/"}, "DELETE"))
        self.assertTrue(vo_access.same_origin_request({"Host": "h:1", "Referer": "http://h:1/page"}, "PUT"))
        self.assertTrue(vo_access.same_origin_request(
            {"Host": "office.example.com", "X-Forwarded-Host": "office.example.com:8443", "Origin": "https://office.example.com:8443"}, "POST"))
        self.assertFalse(vo_access.same_origin_request({"Host": "h:1", "Origin": "http://evil:1"}, "POST"))


if __name__ == "__main__":
    unittest.main()
