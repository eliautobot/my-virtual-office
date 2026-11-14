"""v0.10.1 updates: version source, "is a newer version out?" check and release notes.
The GitHub call is always replaced by a fake: these tests never touch the network.
Runs a real server on an ephemeral port with temp data; never touches ~/.openclaw."""
import atexit
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v101-updates-")
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
import version_check as vc  # noqa: E402
import vo_access  # noqa: E402

REMOTE = {"X-Forwarded-For": "192.0.2.10"}
# Trimmed real answer of GET /repos/eliautobot/my-virtual-office/releases/latest (2026-11-08).
REAL_LATEST = {
    "tag_name": "v0.7.4", "name": "v0.7.4 - Preview Bubbles & Rich Provider Telemetry",
    "draft": False, "prerelease": False, "published_at": "2026-08-15T11:09:26Z",
    "html_url": "https://github.com/eliautobot/my-virtual-office/releases/tag/v0.7.4",
}


def release(tag, **extra):
    data = {"tag_name": tag, "name": f"{tag} - Test", "draft": False, "prerelease": False,
            "published_at": "2026-12-01T10:00:00Z",
            "html_url": f"https://github.com/eliautobot/my-virtual-office/releases/tag/{tag}"}
    data.update(extra)
    return data


class FakeGitHub:
    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    def __call__(self, repo, current):
        self.calls.append((repo, current))
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t


class VersionCompareTests(unittest.TestCase):
    def test_semver_order(self):
        cases = [
            ("0.10.1", "0.9.9", 1), ("v0.10.1", "0.10.1", 0), ("V1.2.3", "v1.2.3", 0),
            ("0.7.4", "0.10.1", -1), ("1.0", "1.0.0", 0), ("1.0.0", "0.99.99", 1),
            ("0.10.1-rc.1", "0.10.1", -1), ("0.10.1-rc.2", "0.10.1-rc.10", -1),
            ("0.10.1-alpha", "0.10.1-1", 1), ("0.10.2+build.5", "0.10.2", 0),
        ]
        for a, b, want in cases:
            self.assertEqual(want, vc.compare_versions(a, b), (a, b))
        for bad in ("", "latest", "v", "1", "0.10.x", None):
            self.assertIsNone(vc.compare_versions(bad, "0.10.1"), bad)

    def test_clean_tag(self):
        self.assertEqual("0.11.0", vc.clean_tag("v0.11.0"))
        self.assertEqual("0.11.0", vc.clean_tag("0.11.0"))
        self.assertEqual("nightly", vc.clean_tag("nightly"))


class UpdateCheckerTests(unittest.TestCase):
    def make(self, answer, env=None, current="0.10.1"):
        fake, clock = FakeGitHub(answer), Clock()
        return vc.UpdateChecker(current, fetch=fake, clock=clock, env=env or {}), fake, clock

    def test_newer_release(self):
        checker, fake, _ = self.make(release("v0.11.0"))
        out = checker.status()
        self.assertEqual([("eliautobot/my-virtual-office", "0.10.1")], fake.calls)
        self.assertTrue(out["enabled"])
        self.assertTrue(out["newer"])
        self.assertEqual("0.10.1", out["current"])
        self.assertEqual("0.11.0", out["latest"])
        self.assertEqual("https://github.com/eliautobot/my-virtual-office/releases/tag/v0.11.0", out["url"])
        self.assertEqual("v0.11.0 - Test", out["name"])
        self.assertEqual("2026-12-01T10:00:00Z", out["publishedAt"])
        self.assertRegex(out["checkedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertIsNone(out["error"])
        self.assertEqual("https://github.com/eliautobot/my-virtual-office/blob/HEAD/docs/UPDATING.md", out["howToUrl"])
        self.assertTrue((PROJECT_ROOT / "docs" / "UPDATING.md").is_file())

    def test_real_latest_is_older(self):
        checker, _fake, _ = self.make(REAL_LATEST)
        out = checker.status()
        self.assertFalse(out["newer"])
        self.assertEqual("0.7.4", out["latest"])
        self.assertIsNone(out["error"])

    def test_drafts_and_prereleases_are_not_updates(self):
        for extra in ({"draft": True}, {"prerelease": True}):
            checker, _fake, _ = self.make(release("v9.0.0", **extra))
            out = checker.status()
            self.assertFalse(out["newer"], extra)
            self.assertEqual("0.10.1", out["latest"], extra)

    def test_tag_without_version(self):
        checker, _fake, _ = self.make(release("nightly"))
        out = checker.status()
        self.assertFalse(out["newer"])
        self.assertIn("no version", out["error"])

    def test_foreign_release_page_is_not_linked(self):
        checker, _fake, _ = self.make(release("v0.11.0", html_url="https://evil.example/x"))
        self.assertEqual("https://github.com/eliautobot/my-virtual-office/releases/tag/v0.11.0", checker.status()["url"])

    def test_answer_is_cached_12_hours(self):
        checker, fake, clock = self.make(release("v0.11.0"))
        checker.status()
        clock.t += 11 * 3600
        self.assertTrue(checker.status()["newer"])
        self.assertEqual(1, len(fake.calls))
        clock.t += 3601
        checker.status()
        self.assertEqual(2, len(fake.calls))

    def test_failure_is_cached_1_hour(self):
        checker, fake, clock = self.make(urllib.error.URLError("no route"))
        out = checker.status()
        self.assertFalse(out["newer"])
        self.assertEqual("0.10.1", out["latest"])
        self.assertEqual("offline or GitHub did not answer", out["error"])
        clock.t += 3500
        checker.status()
        self.assertEqual(1, len(fake.calls))
        clock.t += 200
        fake.answer = release("v0.11.0")
        self.assertTrue(checker.status()["newer"])
        self.assertEqual(2, len(fake.calls))

    def test_failure_reasons(self):
        cases = [
            (urllib.error.HTTPError("u", 403, "rate", {}, None), "GitHub rate limit, trying again later"),
            (urllib.error.HTTPError("u", 429, "slow", {}, None), "GitHub rate limit, trying again later"),
            (urllib.error.HTTPError("u", 404, "none", {}, None), "no published release found"),
            (urllib.error.HTTPError("u", 500, "err", {}, None), "GitHub answered 500"),
            (TimeoutError("slow"), "offline or GitHub did not answer"),
            (ValueError("bad json"), "unexpected answer from GitHub"),
        ]
        for exc, reason in cases:
            checker, _fake, _ = self.make(exc)
            self.assertEqual(reason, checker.status()["error"])

    def test_env_off_never_asks(self):
        for word in ("0", "false", "off", "no"):
            checker, fake, _ = self.make(release("v0.11.0"), env={"VO_UPDATE_CHECK": word})
            out = checker.status(refresh=True)
            self.assertFalse(out["enabled"])
            self.assertEqual("env", out["disabledBy"])
            self.assertFalse(out["newer"])
            self.assertEqual(out["current"], out["latest"])
            self.assertEqual([], fake.calls)

    def test_setting_off_never_asks(self):
        checker, fake, _ = self.make(release("v0.11.0"))
        out = checker.status(setting_enabled=False)
        self.assertFalse(out["enabled"])
        self.assertEqual("setting", out["disabledBy"])
        self.assertEqual("0.10.1", out["latest"])
        self.assertEqual([], fake.calls)

    def test_check_now_skips_cache_once_a_minute(self):
        checker, fake, clock = self.make(release("v0.10.1"))
        self.assertFalse(checker.status()["newer"])
        clock.t += 120
        fake.answer = release("v0.11.0")
        self.assertFalse(checker.status()["newer"])           # cached
        self.assertTrue(checker.status(refresh=True)["newer"])  # Check now asks again
        self.assertEqual(2, len(fake.calls))
        clock.t += 30
        out = checker.status(refresh=True)
        self.assertTrue(out["limited"])
        self.assertTrue(0 < out["retryAfter"] <= 31)
        self.assertTrue(out["newer"])
        self.assertEqual(2, len(fake.calls))
        clock.t += 31
        self.assertNotIn("limited", checker.status(refresh=True))
        self.assertEqual(3, len(fake.calls))

    def test_repo_from_env(self):
        checker, fake, _ = self.make(release("v0.11.0", html_url="https://github.com/me/fork/releases/tag/v0.11.0"),
                                     env={"VO_UPDATE_REPO": "me/fork"})
        out = checker.status()
        self.assertEqual([("me/fork", "0.10.1")], fake.calls)
        self.assertEqual("https://github.com/me/fork/releases/tag/v0.11.0", out["url"])
        checker, fake, _ = self.make(release("v0.11.0"), env={"VO_UPDATE_REPO": "../../etc"})
        out = checker.status()
        self.assertEqual([], fake.calls)
        self.assertIn("VO_UPDATE_REPO", out["error"])

    def test_fetch_latest_sends_only_a_plain_get(self):
        seen = {}

        class Res:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n):
                return json.dumps(REAL_LATEST).encode()

        def fake_urlopen(req, timeout):
            seen.update(url=req.full_url, method=req.get_method(), headers=dict(req.header_items()),
                        data=req.data, timeout=timeout)
            return Res()

        with mock.patch.object(vc.urllib.request, "urlopen", fake_urlopen):
            data = vc.fetch_latest("eliautobot/my-virtual-office", "0.10.1")
        self.assertEqual("v0.7.4", data["tag_name"])
        self.assertEqual("https://api.github.com/repos/eliautobot/my-virtual-office/releases/latest", seen["url"])
        self.assertEqual("GET", seen["method"])
        self.assertIsNone(seen["data"])
        self.assertEqual(3, seen["timeout"])
        self.assertEqual({"Accept": "application/vnd.github+json", "User-agent": "My-Virtual-Office/0.10.1"},
                         seen["headers"])


class UpdatesHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v101-updates-case-")
        self.store = vo_access.AccessStore(self.temp.name, env={})
        self.fake = FakeGitHub(release("v0.13.0"))
        self.patches = [
            mock.patch.object(server, "ACCESS_STORE", self.store),
            mock.patch.object(server, "UPDATE_CHECKER", vc.UpdateChecker(server.VO_VERSION, fetch=self.fake, env={})),
        ]
        for p in self.patches:
            p.start()
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def get(self, path, headers=None, method="GET", body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        hdrs = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=hdrs)
        res = conn.getresponse()
        payload = res.read()
        conn.close()
        return res.status, json.loads(payload.decode() or "null")

    def test_version_is_one_source(self):
        self.assertEqual("0.12.0", server.VO_VERSION)
        status, data = self.get("/api/version")
        self.assertEqual(200, status)
        self.assertEqual({"current": "0.12.0", "version": "0.12.0"}, {k: data[k] for k in ("current", "version")})
        self.assertTrue((PROJECT_ROOT / "docs" / f"RELEASE-NOTES-{server.VO_VERSION}.md").is_file())

    def test_updates_route_and_check_now(self):
        status, data = self.get("/api/version/updates")
        self.assertEqual(200, status)
        self.assertTrue(data["newer"])
        self.assertEqual("0.13.0", data["latest"])
        self.get("/api/version/updates")
        self.assertEqual(1, len(self.fake.calls))
        status, data = self.get("/api/version/updates?refresh=1")
        self.assertTrue(data["limited"])            # the first check was moments ago
        self.assertEqual(1, len(self.fake.calls))

    def test_updates_need_the_passcode_but_version_does_not(self):
        self.store.set_passcode("open sesame")
        status, data = self.get("/api/version/updates", headers=REMOTE)
        self.assertEqual(401, status)
        status, data = self.get("/api/version/notes", headers=REMOTE)
        self.assertEqual(401, status)
        status, data = self.get("/api/version", headers=REMOTE)
        self.assertEqual(200, status)
        self.assertEqual([], self.fake.calls)

    def test_setting_saved_with_settings_save(self):
        status, data = self.get("/setup/save", method="POST", body={"features": {"updateCheck": False}})
        self.assertEqual(200, status, data)
        try:
            status, cfg = self.get("/vo-config")
            self.assertIs(False, cfg["features"]["updateCheck"])
            status, data = self.get("/api/version/updates?refresh=1")
            self.assertFalse(data["enabled"])
            self.assertEqual("setting", data["disabledBy"])
            self.assertEqual([], self.fake.calls)
        finally:
            status, data = self.get("/setup/save", method="POST", body={"features": {"updateCheck": True}})
            self.assertEqual(200, status, data)
        status, cfg = self.get("/vo-config")
        self.assertIs(True, cfg["features"]["updateCheck"])
        status, data = self.get("/api/version/updates")
        self.assertTrue(data["enabled"])
        self.assertEqual(1, len(self.fake.calls))

    def test_release_notes_served_locally(self):
        status, data = self.get("/api/version/notes")
        self.assertEqual(200, status)
        self.assertEqual("0.12.0", data["version"])
        self.assertTrue(data["markdown"].startswith("# My Virtual Office v0.12.0"))
        self.assertEqual(({"ok": False, "error": "bad_version"}, 400), server._release_notes_answer("../x"))

    def test_image_copy_of_release_notes_matches_docs(self):
        # The Docker image is built from app/ only: app/release-notes/ carries the notes there.
        docs = PROJECT_ROOT / "docs" / f"RELEASE-NOTES-{server.VO_VERSION}.md"
        copy = APP_ROOT / "release-notes" / docs.name
        self.assertTrue(copy.is_file(), f"copy {docs} to app/release-notes/")
        self.assertEqual(docs.read_text(encoding="utf-8"), copy.read_text(encoding="utf-8"),
                         f"app/release-notes/{docs.name} differs: cp docs/{docs.name} app/release-notes/")


if __name__ == "__main__":
    unittest.main()
