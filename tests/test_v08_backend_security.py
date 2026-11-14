"""v0.8 backend security and provider runner (BE-02/CH-03, BE-10, BE-12, BE-13, BE-14,
BE-15, BE-16, BE-29, BE-30, CH-02, CH-06, CH-17, CH-21, C6). Temp fixtures only."""

import atexit
import base64
import http.client
import json
import os
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v08-sec-")
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
from providers import process_env  # noqa: E402
from providers.cli_runner import CliRun, argv_message, safe_session_id  # noqa: E402
from providers.opencode import OpenCodeProvider  # noqa: E402


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v08-sec-case-")
        self.status = Path(self.temp.name) / "status"
        self.workspace = Path(self.temp.name) / "openclaw"
        (self.status / "uploads").mkdir(parents=True)
        (self.workspace / "workspace" / "media").mkdir(parents=True)
        self.patches = [mock.patch.object(server, "STATUS_DIR", str(self.status)),
                        mock.patch.object(server, "WORKSPACE_BASE", str(self.workspace))]
        for p in self.patches:
            p.start()
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
        res = conn.getresponse()
        payload = res.read()
        headers = {k.lower(): v for k, v in res.getheaders()}
        conn.close()
        return res.status, headers, payload


class ChatMediaTests(ServerCase):
    def media(self, path):
        import urllib.parse
        return self.request("GET", "/chat-media?path=" + urllib.parse.quote(str(path)))

    def test_secrets_are_never_served(self):
        (self.workspace / "openclaw.json").write_text('{"token":"secret"}')
        (self.status / "vo-config.json").write_text('{"sms":{"twilioAuthToken":"x"}}')
        (self.workspace / "agents").mkdir()
        (self.workspace / "agents" / "auth.sqlite").write_text("db")
        (self.workspace / ".ssh").mkdir()
        (self.workspace / ".ssh" / "id.png").write_bytes(b"\x89PNG")
        for path in (self.workspace / "openclaw.json", self.status / "vo-config.json",
                     self.workspace / "agents" / "auth.sqlite", self.workspace / ".ssh" / "id.png", "/etc/passwd"):
            status, _h, body = self.media(path)
            self.assertEqual(404, status, path)
            self.assertNotIn(b"secret", body)

    def test_media_inline_sandboxed_and_other_uploads_download(self):
        image = self.workspace / "workspace" / "media" / "chart.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\nfake")
        status, headers, _ = self.media(image)
        self.assertEqual(200, status)
        self.assertEqual("image/png", headers["content-type"])
        self.assertIn("sandbox", headers["content-security-policy"])
        self.assertEqual("nosniff", headers["x-content-type-options"])
        self.assertTrue(headers["content-disposition"].startswith("inline"))
        page = self.status / "uploads" / "report.html"
        page.write_text("<script>alert(1)</script>")
        status, headers, _ = self.media(page)
        self.assertEqual(200, status)
        self.assertEqual("application/octet-stream", headers["content-type"])
        self.assertTrue(headers["content-disposition"].startswith("attachment"))
        self.assertNotIn("access-control-allow-origin", headers)
        stray = self.workspace / "workspace" / "notes.html"
        stray.write_text("<b>x</b>")
        self.assertEqual(404, self.media(stray)[0])  # non-media outside uploads


class UploadTests(ServerCase):
    def test_same_name_uploads_never_overwrite(self):
        paths = []
        for payload in (b"one", b"two", b"three"):
            status, _h, body = self.request("POST", "/upload", {
                "filename": "../../image.png", "mimeType": "image/png",
                "content": base64.b64encode(payload).decode()})
            self.assertEqual(200, status, body)
            data = json.loads(body)
            self.assertEqual("image.png", data["name"])
            paths.append(data["path"])
        self.assertEqual(3, len(set(paths)))
        for path, payload in zip(paths, (b"one", b"two", b"three")):
            self.assertEqual(str(self.status / "uploads"), os.path.dirname(path))
            self.assertEqual(payload, Path(path).read_bytes())


class HermesKeyTests(unittest.TestCase):
    def test_saved_key_only_goes_to_the_saved_url(self):
        saved = {"hermes": {"connections": [{"id": "h", "apiUrl": "http://hermes.local:8642", "apiKey": "SECRET"}]}}
        seen = []

        def fake_resolve(connection, force_probe=False):
            return {"ok": True, "endpoint": {"url": connection.get("apiUrl")}}

        def fake_test(api_url=None, api_key=None):
            seen.append((api_url, api_key))
            return {"ok": True}

        with mock.patch.dict(server.VO_CONFIG, saved), \
                mock.patch.object(server, "_resolve_hermes_api_endpoint", side_effect=fake_resolve), \
                mock.patch.object(server, "_test_hermes_api", side_effect=fake_test), \
                mock.patch.object(server, "discover_hermes_agents", return_value=[]):
            server._handle_hermes_test({"connections": [{"id": "h", "apiUrl": "http://attacker.example:9"}]})
            server._handle_hermes_test({"connections": [{"id": "h", "apiUrl": "http://hermes.local:8642/"}]})
        self.assertEqual(("http://attacker.example:9", ""), seen[0])
        self.assertEqual("SECRET", seen[1][1])


class AgentEnvTests(unittest.TestCase):
    def test_office_secrets_are_stripped(self):
        env = {"VO_GATEWAY_TOKEN": "g", "VO_TWILIO_AUTH_TOKEN": "t", "TWILIO_AUTH_TOKEN": "t2",
               "VO_AGENT_ENV_DENY": "EXTRA_SECRET", "EXTRA_SECRET": "x", "OPENAI_API_KEY": "keep", "PATH": "/bin"}
        with mock.patch.dict(os.environ, env, clear=True):
            result = process_env.agent_env({"CODEX_HOME": "/c"})
        self.assertEqual({"OPENAI_API_KEY": "keep", "PATH": "/bin", "CODEX_HOME": "/c"}, result)


class CliRunnerTests(unittest.TestCase):
    def script(self, body):
        handle = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
        handle.write(textwrap.dedent(body))
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return [sys.executable, handle.name]

    def test_timeout_fires_without_output_and_kills_the_group(self):
        marker = tempfile.mktemp(prefix="vo-child-")
        cmd = self.script(f"""
            import subprocess, sys, time
            subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30); open({marker!r}, 'w').write('alive')"])
            time.sleep(30)
        """)
        started = time.time()
        run = CliRun(cmd, cwd=None, env=None, timeout_sec=1, grace_sec=0.5)
        list(run.lines())
        run.finish()
        self.assertTrue(run.timed_out)
        self.assertLess(time.time() - started, 8)
        time.sleep(0.5)
        self.assertFalse(os.path.exists(marker))

    def test_stderr_flood_does_not_deadlock(self):
        cmd = self.script("""
            import sys
            sys.stderr.write("x" * 400000)
            sys.stderr.flush()
            print("done")
        """)
        run = CliRun(cmd, cwd=None, env=None, timeout_sec=20)
        out = [line.strip() for line in run.lines()]
        code = run.finish()
        self.assertEqual(["done"], out)
        self.assertEqual(0, code)
        self.assertFalse(run.timed_out)
        self.assertLessEqual(len(run.stderr_text), 70 * 1024)

    def test_argv_and_session_guards(self):
        self.assertEqual(" - item", argv_message("- item"))
        self.assertEqual("hi", argv_message("hi"))
        with self.assertRaises(ValueError):
            argv_message("x" * (200 * 1024))
        self.assertEqual("abc-123", safe_session_id("abc-123"))
        self.assertEqual("", safe_session_id(""))
        for bad in ("--dangerously-skip-permissions", "-x", "a b", "a;b"):
            with self.assertRaises(ValueError):
                safe_session_id(bad)


class OpenCodeTests(unittest.TestCase):
    def test_attachments_limited_to_uploads(self):
        with tempfile.TemporaryDirectory() as temp:
            uploads = Path(temp, "uploads")
            uploads.mkdir()
            good = uploads / "a.txt"
            good.write_text("ok")
            secret = Path(temp, "openclaw.json")
            secret.write_text("{}")
            provider = OpenCodeProvider.__new__(OpenCodeProvider)
            with mock.patch.dict(os.environ, {"VO_STATUS_DIR": temp}):
                allowed = provider._allowed_attachments([str(good), str(secret), str(uploads / ".." / "openclaw.json")])
        self.assertEqual([os.path.realpath(good)], allowed)


class TextCleaningTests(unittest.TestCase):
    def test_session_titles_drop_envelopes(self):
        self.assertEqual("hi there", server._clean_session_text(
            'Message from User via Virtual Office Chat.\n\nhi there\n\nReply directly to the user. Do not assume.'))
        self.assertEqual("build it", server._clean_session_text(
            '[A2A from=user name="Eve" to=codex-main isUser=true sourceApp="virtual-office"]\nbuild it'))
        self.assertEqual("plain", server._clean_session_text("plain"))

    def test_project_fields_are_allow_listed(self):
        project = {
            "status": "x\" onmouseover=1", "priority": "<b>", "dueDate": "2026-13-01\" x",
            "columns": [{"id": "c1') alert(1", "color": "url(https://evil)"}],
            "tasks": [{"columnId": "c1') alert(1", "priority": "high", "dueDate": "2026-11-01", "tags": ["<x>", "ok"]}],
        }
        server._clean_project_fields(project)
        self.assertEqual("active", project["status"])
        self.assertEqual("medium", project["priority"])
        self.assertIsNone(project["dueDate"])
        column = project["columns"][0]
        self.assertEqual("#6c757d", column["color"])
        self.assertRegex(column["id"], r"^[A-Za-z0-9_-]+$")
        self.assertEqual(column["id"], project["tasks"][0]["columnId"])
        self.assertEqual("2026-11-01", project["tasks"][0]["dueDate"])
        self.assertEqual(["x", "ok"], project["tasks"][0]["tags"])

    def test_provider_settings_keep_secrets_on_rename_and_blank_numbers(self):
        field = {"type": "connection-list", "itemFields": [
            {"key": "id", "type": "slug"}, {"key": "apiKey", "type": "secret"}, {"key": "port", "type": "number", "default": 8642}]}
        existing = [{"id": "old", "apiKey": "KEEP", "port": 9000}]
        result = server._validate_provider_setting(field, [{"id": "new", "originalId": "old", "apiKey": "", "port": None}], existing)
        self.assertEqual([{"id": "new", "apiKey": "KEEP", "port": 9000}], result)
        merged = server._merge_hermes_connection_updates(
            {"connections": [{"id": "old", "apiUrl": "http://h:1", "apiKey": "KEEP"}]},
            [{"id": "new", "originalId": "old", "apiUrl": "http://h:1", "apiKey": ""}])
        self.assertEqual("KEEP", merged[0]["apiKey"])
        self.assertNotIn("originalId", merged[0])

    def test_cron_methods_go_through_the_proxy(self):
        for method in ("cron.list", "cron.add", "cron.update", "cron.remove", "cron.run", "cron.runs", "channels.status"):
            self.assertIn(method, server._OPENCLAW_PROXY_METHODS)
        self.assertNotIn("config.set", server._OPENCLAW_PROXY_METHODS)


if __name__ == "__main__":
    unittest.main()
