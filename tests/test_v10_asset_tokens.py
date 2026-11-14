"""v0.10 Q-02: cache-busting tokens never need a hand bump (contract C7).

The server rewrites every local ``?v=`` reference in every HTML page to a token of the
target file (mtime + size), so a changed asset always gets a fresh URL and only a URL
with the current token is cached as immutable. Literal tokens it does not rewrite
(ES module imports inside .mjs files) and untokenised references are served
``no-cache``, so they revalidate and can never go stale either.
"""

import atexit
import gzip
import http.client
import os
import re
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v10-tokens-")
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

# Any local asset URL with a token, in attributes or inline script alike.
TOKEN_REF = re.compile(r"""([A-Za-z0-9_./-]+\.(?:m?js|css|jpe?g|png|svg|woff2?|ttf|json|ico))\?v=([^"'&#\s)>]*)""")
PAGES = sorted(p.name for p in APP_ROOT.glob("*.html"))


class AssetTokenTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v10-tokens-case-")
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

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("GET", path, headers={"Accept-Encoding": "gzip"})
        res = conn.getresponse()
        body = res.read()
        hdrs = {k.lower(): v for k, v in res.getheaders()}
        conn.close()
        if hdrs.get("content-encoding") == "gzip":
            body = gzip.decompress(body)
        return res.status, hdrs, body

    def test_every_page_gets_the_current_token_for_every_asset(self):
        self.assertIn("index.html", PAGES)
        for page in PAGES:
            source = (APP_ROOT / page).read_text(encoding="utf-8")
            status, hdrs, body = self.get("/" + page)
            self.assertEqual(200, status, page)
            self.assertEqual("no-cache", hdrs.get("cache-control"), page)
            html = body.decode("utf-8")
            refs = list(TOKEN_REF.finditer(html))
            self.assertEqual(len(refs), len(list(TOKEN_REF.finditer(source))), f"{page}: a tokenised reference went missing")
            for m in refs:
                ref, token = m.group(1), m.group(2)
                target = APP_ROOT / ref.lstrip("/")
                self.assertTrue(target.is_file(), f"{page}: {ref} does not exist")
                self.assertEqual(server._asset_token(str(target.resolve())), token, f"{page}: {ref} keeps a stale token")
            if page == "index.html":
                self.assertGreater(len(refs), 40)
                ref, token = refs[0].group(1), refs[0].group(2)
                status, hdrs, _ = self.get(f"/{ref}?v={token}")
                self.assertEqual(200, status)
                self.assertIn("immutable", hdrs.get("cache-control", ""), "a current token is cached as immutable")

    def test_token_follows_the_file(self):
        with tempfile.TemporaryDirectory(prefix="vo-v10-tokens-app-") as root:
            Path(root, "a.js").write_text("one", encoding="utf-8")
            Path(root, "sub").mkdir()
            Path(root, "sub", "b.css").write_text("x{}", encoding="utf-8")
            page = '<script src="a.js?v=20260101-old"></script><link href=\'/sub/b.css?v=1\'>' \
                   '<script src="https://cdn.example/x.js?v=9"></script><script src="gone.js?v=keep"></script>'
            with mock.patch.object(server, "APP_DIR", root):
                first = server._rewrite_asset_tokens(page, root)
                tok_a = server._asset_token(os.path.realpath(os.path.join(root, "a.js")))
                self.assertIn(f'a.js?v={tok_a}"', first)
                self.assertNotIn("20260101-old", first)
                self.assertIn("/sub/b.css?v=" + server._asset_token(os.path.realpath(os.path.join(root, "sub", "b.css"))), first)
                self.assertIn("https://cdn.example/x.js?v=9", first, "remote URLs are left alone")
                self.assertIn("gone.js?v=keep", first, "a missing file keeps its literal")
                time.sleep(0.01)
                Path(root, "a.js").write_text("two!", encoding="utf-8")
                second = server._rewrite_asset_tokens(page, root)
                tok_a2 = server._asset_token(os.path.realpath(os.path.join(root, "a.js")))
                self.assertNotEqual(tok_a, tok_a2, "a changed file gets a new token")
                self.assertIn(f'a.js?v={tok_a2}"', second)

    def test_literal_and_untokenised_references_always_revalidate(self):
        imports = []
        for mjs in APP_ROOT.glob("*.mjs"):
            for m in re.finditer(r"""from\s+['"]\./([^'"?]+)\?v=([^'"]+)['"]""", mjs.read_text(encoding="utf-8")):
                imports.append((m.group(1), m.group(2)))
        self.assertTrue(imports, "fixture: module imports with literal tokens")
        for ref, literal in imports:
            if literal == server._asset_token(str((APP_ROOT / ref).resolve())):
                continue
            status, hdrs, _ = self.get(f"/{ref}?v={literal}")
            self.assertEqual(200, status, ref)
            self.assertEqual("no-cache", hdrs.get("cache-control"), f"{ref}: a literal import token must not be cached as immutable")
        status, hdrs, _ = self.get("/vo-auth.js")
        self.assertEqual("no-cache", hdrs.get("cache-control"))


if __name__ == "__main__":
    unittest.main()
