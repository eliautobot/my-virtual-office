import json
import atexit
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock


_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-agent-pc-http-server-")
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
from agent_pc import AgentPCStore  # noqa: E402


class AgentPCHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-agent-pc-http-")
        root = Path(self.temp.name)
        self.home = root / "workspace"
        self.home.mkdir()
        (self.home / "hello.md").write_text("# Agent PC HTTP\n", encoding="utf-8")
        self.agent = {
            "id": "test-agent", "statusKey": "test-agent", "name": "Test Agent",
            "providerKind": "openclaw", "providerAgentId": "test-agent", "workspace": str(self.home),
        }
        self.store = AgentPCStore(root / "agent-pc")
        self.store.ensure_profile(self.agent)
        self.store_patch = mock.patch.object(server, "AGENT_PC_STORE", self.store)
        self.find_patch = mock.patch.object(server, "_find_agent_record", return_value=self.agent)
        self.store_patch.start()
        self.find_patch.start()
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.find_patch.stop()
        self.store_patch.stop()
        self.temp.cleanup()

    def request(self, path, *, method="GET", payload=None, headers=None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json", **(headers or {})},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, dict(response.headers), response.read()

    def test_full_agent_pc_http_lifecycle_and_range_streaming(self):
        status, _headers, body = self.request("/api/agent-pc/test-agent")
        summary = json.loads(body)
        self.assertEqual(200, status)
        self.assertEqual("Test Agent", summary["profile"]["name"])
        self.assertEqual("home", summary["roots"][0]["id"])

        status, _headers, body = self.request("/api/agent-pc/test-agent/tree?rootId=home&path=")
        self.assertEqual("hello.md", json.loads(body)["entries"][0]["name"])

        query = urllib.parse.urlencode({"rootId": "home", "path": "hello.md"})
        status, _headers, body = self.request(f"/api/agent-pc/test-agent/descriptor?{query}")
        self.assertEqual("markdown", json.loads(body)["preview"]["kind"])
        # Browsing from the read-only Agent PC is not agent activity and must
        # not inflate Recent/Sources every time the UI checks a file version.
        status, _headers, body = self.request("/api/agent-pc/test-agent")
        self.assertEqual([], json.loads(body)["recent"])
        status, headers, body = self.request(f"/api/agent-pc/test-agent/content?{query}", headers={"Range": "bytes=0-6"})
        self.assertEqual(206, status)
        self.assertEqual("bytes 0-6/16", headers["Content-Range"])
        self.assertEqual(b"# Agent", body)

        status, _headers, body = self.request("/api/agent-pc/test-agent/activity", method="POST", payload={
            "kind": "file", "rootId": "home", "relativePath": "hello.md", "toolName": "read",
        })
        self.assertEqual(201, status)
        self.assertEqual("source", json.loads(body)["operation"])

        status, _headers, body = self.request("/api/agent-pc/test-agent/saved", method="POST", payload={
            "kind": "file", "rootId": "home", "path": "hello.md",
        })
        self.assertEqual(201, status)
        saved_id = json.loads(body)["savedId"]
        saved_query = urllib.parse.urlencode({"savedId": saved_id})
        status, _headers, body = self.request(f"/api/agent-pc/test-agent/content?{saved_query}")
        self.assertEqual(200, status)
        self.assertEqual(b"# Agent PC HTTP\n", body)

        status, _headers, body = self.request("/api/agent-pc/test-agent/state", method="PUT", payload={"state": {"section": "files"}})
        self.assertEqual(200, status)
        self.assertTrue(json.loads(body)["ok"])

        status, _headers, body = self.request(f"/api/agent-pc/test-agent/saved/{saved_id}", method="DELETE")
        self.assertEqual(200, status)
        self.assertEqual(saved_id, json.loads(body)["deleted"])

    def test_http_rejects_traversal_and_unknown_agent(self):
        query = urllib.parse.urlencode({"rootId": "home", "path": "../secret"})
        with self.assertRaises(urllib.error.HTTPError) as traversal:
            self.request(f"/api/agent-pc/test-agent/content?{query}")
        self.assertEqual(400, traversal.exception.code)
        traversal.exception.close()

        with mock.patch.object(server, "_find_agent_record", return_value=None):
            with self.assertRaises(urllib.error.HTTPError) as missing:
                self.request("/api/agent-pc/missing")
            self.assertEqual(404, missing.exception.code)
            missing.exception.close()


if __name__ == "__main__":
    unittest.main()
