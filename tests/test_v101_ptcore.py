"""v0.10.1 playtest fixes (ptcore) on the server side.

B1: Agent Studio saves the office copy itself; its native profile call (updateSettings with
officeSaved) must not write office-config.json as well (that changed the layout under the
Studio's own save: 409 and a false "changed somewhere else"). Other callers keep the old
behaviour.

I7: the HTML is gzipped and revalidated (ETag, 304); every ?v= asset the page loads, including the
ones named inside modules and style sheets, is immutable under its content token; a stale or missing
version is revalidated; JSON answers are never reused without asking.
"""
import atexit
import gzip
import http.client
import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v101-ptcore-")
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


class StudioSaveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v101-ptcore-case-")
        self.office = Path(self.temp.name) / "office-config.json"
        self.office.write_text(json.dumps({"agents": [{"id": "alpha", "name": "Alpha"}], "furniture": []}),
                               encoding="utf-8")
        self.patches = [
            mock.patch.object(server, "STATUS_DIR", self.temp.name),
            mock.patch.object(server, "AGENT_WORKSPACES_FILE", os.path.join(self.temp.name, "agent-workspaces.json")),
            mock.patch.object(server, "_get_agent_workspace_payload",
                              lambda key: {"ok": True, "agent": {"statusKey": key, "capabilities": {}}}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_studio_profile_call_leaves_the_office_copy_to_the_studio_save(self):
        before = self.office.read_bytes()
        result = server._handle_agent_workspace_update(
            "alpha", {"action": "updateSettings", "actor": "user", "officeSaved": True,
                      "name": "Alpha Two", "displayName": "Alpha Two", "role": "Lead"})
        self.assertNotIn("error", result)
        self.assertEqual(before, self.office.read_bytes(), "office-config.json must not change (no own 409)")

    def test_other_callers_still_patch_the_office_copy(self):
        server._handle_agent_workspace_update("alpha", {"action": "updateSettings", "actor": "user", "name": "Alpha Two"})
        agents = {a["id"]: a for a in json.loads(self.office.read_text(encoding="utf-8"))["agents"]}
        self.assertEqual("Alpha Two", agents["alpha"]["name"])


class CacheHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def get(self, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("GET", path, headers=headers or {})
        res = conn.getresponse()
        body = res.read()
        out = {k.lower(): v for k, v in res.getheaders()}
        conn.close()
        if out.get("content-encoding") == "gzip":
            body = gzip.decompress(body)
        return res.status, out, body

    def test_pages_are_gzipped_and_revalidated(self):
        for page in ("/", "/providers.html"):
            status, headers, body = self.get(page, {"Accept-Encoding": "gzip, deflate, br"})
            self.assertEqual(200, status, page)
            self.assertEqual("gzip", headers.get("content-encoding"), page)
            self.assertEqual("no-cache", headers.get("cache-control"), page)
            self.assertTrue(headers.get("etag", "").endswith('-gz"'), headers.get("etag"))
            again, _, _ = self.get(page, {"Accept-Encoding": "gzip", "If-None-Match": headers["etag"]})
            self.assertEqual(304, again, page)
        self.assertIn(b"<html", body.lower())

    def test_every_versioned_asset_is_immutable_nested_ones_too(self):
        _, _, html = self.get("/", {"Accept-Encoding": "gzip"})
        refs = set(re.findall(r'(?:src|href)="([^"?#:]+\?v=[^"#]+)"', html.decode("utf-8")))
        self.assertGreater(len(refs), 30)
        seen, todo, nested = set(), sorted(refs), 0
        while todo:
            ref = todo.pop()
            if ref in seen:
                continue
            seen.add(ref)
            status, headers, body = self.get("/" + ref.lstrip("/"), {"Accept-Encoding": "gzip"})
            self.assertEqual(200, status, ref)
            self.assertEqual("public, max-age=31536000, immutable", headers.get("cache-control"), ref)
            self.assertTrue(headers.get("etag"), ref)
            if ref.split("?")[0].endswith((".mjs", ".css")):
                base = os.path.dirname(ref.split("?")[0])
                for inner in server._NESTED_REF_RE.finditer(body.decode("utf-8")):
                    full = inner.group(0)
                    target = full[full.index(inner.group(2)):]
                    self.assertRegex(target, r"\?v=[0-9a-f]{12}$", ref)
                    todo.append(os.path.normpath(os.path.join(base, target)) if not target.startswith("/") else target)
                    nested += 1
        self.assertGreaterEqual(nested, 8, "module imports and font urls are versioned too")
        fonts = [r for r in seen if r.startswith("fonts/")]
        self.assertTrue(fonts, "fonts are versioned")
        for font in fonts:  # preload and @font-face name the same URL (one download)
            if font.split("?")[0] in ("fonts/Inter-latin.woff2", "fonts/PressStart2P-latin.woff2"):
                self.assertIn(font, html.decode("utf-8"))

    def test_stale_or_missing_versions_are_revalidated(self):
        for path in ("/game.js?v=0123456789ab", "/game.js", "/agent-preview-hub.mjs?v=old"):
            status, headers, _ = self.get(path)
            self.assertEqual(200, status, path)
            self.assertEqual("no-cache", headers.get("cache-control"), path)

    def test_api_answers_are_never_reused_without_asking(self):
        status, headers, _ = self.get("/api/office-config")
        self.assertEqual(200, status)
        self.assertEqual("no-cache", headers.get("cache-control"))
        self.assertTrue(headers.get("etag"))
        again, _, _ = self.get("/api/office-config", {"If-None-Match": headers["etag"]})
        self.assertEqual(304, again)

    def test_a_module_token_follows_the_modules_it_imports(self):
        with tempfile.TemporaryDirectory(prefix="vo-v101-tokens-") as root:
            a, b = os.path.join(root, "a.mjs"), os.path.join(root, "b.mjs")
            Path(a).write_text("import { x } from './b.mjs?v=1';\nexport const y = x;\n", encoding="utf-8")
            Path(b).write_text("export const x = 1;\n", encoding="utf-8")
            with mock.patch.object(server, "APP_DIR", root):
                root_real = os.path.realpath(root)
                a, b = os.path.join(root_real, "a.mjs"), os.path.join(root_real, "b.mjs")
                first, child = server._asset_token(a), server._asset_token(b)
                text = server._rewrite_asset_tokens(Path(a).read_text(encoding="utf-8"), root_real, server._NESTED_REF_RE)
                self.assertIn(f"./b.mjs?v={child}", text)
                later = time.time() + 5
                os.utime(b, (later, later))  # b changes, a's own file does not
                self.assertNotEqual(child, server._asset_token(b))
                self.assertNotEqual(first, server._asset_token(a), "a gets a new URL when b changes")


if __name__ == "__main__":
    unittest.main()
