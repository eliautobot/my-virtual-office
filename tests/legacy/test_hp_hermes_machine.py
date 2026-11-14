"""hp-hermes C1: a Hermes agent's machine (app/providers/hermes_machine.py) through the adapter's files / screen_state /
screen_act / screen_thumb against the fake `hermes serve` (tests/helpers/fake_hermes.py).

Covers: files list/read at both levels, write/mkdir/remove only with Full access (Chat only: 403 chat_only with the 3.6
files text, nothing reaches Hermes), Hermes' refusals as codes; the Bot Desktop under Chat only = {available: False,
reason} with no picture and no call to Hermes; with Full access state, start, thumbnail, take over / hand back per viewer,
the browser-on-screen switch, stop; a Hermes without Bot Desktop. 127.0.0.1 ephemeral ports only.
"""

from __future__ import annotations

import base64
import os
import sys
import time
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
for extra in (os.path.join(HERE, "..", "app"), os.path.join(HERE, "helpers")):
    extra = os.path.abspath(extra)
    if extra not in sys.path:
        sys.path.insert(0, extra)

from fake_hermes import FILE_PNG, FakeHermes  # noqa: E402
from providers import hermes_machine as hmc  # noqa: E402
from providers.hermes_adapter import HermesAdapter  # noqa: E402
from providers.hermes_link import HermesError  # noqa: E402
from agent_providers import AgentRef, chat_only_reason  # noqa: E402

CID = "hx1"


def wait_for(predicate, timeout=6.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class MachineCase(unittest.TestCase):
    access = "full"

    def setUp(self):
        self.fake = FakeHermes().start()
        self.record = {"id": CID, "url": self.fake.url, "auth": "token", "enabled": True, "access": self.access}
        self.adapter = HermesAdapter(connection=lambda cid: dict(self.record) if cid == CID else None,
                                     secrets=lambda cid: {"token": self.fake.token}, persist=lambda *a: None)
        self.ref = AgentRef("default", "hermes-hx1", CID, "hermes", "hermes-serve")
        self.assertTrue(wait_for(lambda: self.adapter.status(CID)["state"] == "connected"), self.adapter.status(CID))

    def tearDown(self):
        self.adapter.close(CID, "test over")
        self.fake.stop()

    def refused(self, fn, *args):
        with self.assertRaises(HermesError) as cm:
            fn(*args)
        return cm.exception

    def display_calls(self):
        return [m for _s, m, _p in self.fake.rpc if m.startswith("display.")]


class TestChatOnly(MachineCase):
    access = "chat"

    def test_files_read_but_never_change(self):
        listing = self.adapter.files(self.ref, "list", {"path": "/tmp"})
        self.assertIn("chart.png", [e["name"] for e in listing["entries"]])
        got = self.adapter.files(self.ref, "read", {"path": "/tmp/chart.png"})
        self.assertEqual(base64.b64decode(got["content"]), FILE_PNG)
        text = chat_only_reason("hermes", "files")
        for op, p in (("write", {"path": "/tmp/a.txt", "content": "hi"}), ("mkdir", {"path": "/tmp/d"}),
                      ("remove", {"path": "/tmp/chart.png"})):
            err = self.refused(self.adapter.files, self.ref, op, p)
            self.assertEqual((err.code, err.status, err.detail), ("chat_only", 403, text), op)
        self.assertEqual([m for m, _p, _q, _b in self.fake.rest_log if m != "GET"], [])
        self.assertIn("/tmp/chart.png", self.fake.files)

    def test_screen_is_not_there(self):
        reason = chat_only_reason("hermes", "screen")
        self.assertEqual(self.adapter.screen_state(self.ref), {"available": False, "reason": reason})
        for op in ("start", "stop", "lease", "take", "release", "browser"):
            self.assertEqual(self.adapter.screen_act(self.ref, op, {"viewer": "a", "on": True}),
                             {"available": False, "reason": reason}, op)
        self.assertIsNone(self.adapter.screen_thumb(self.ref))
        self.assertEqual(self.display_calls(), [])
        self.assertFalse(self.fake.display["running"])


class TestFiles(MachineCase):
    def test_write_read_mkdir_list_remove(self):
        self.assertEqual(self.adapter.files(self.ref, "write", {"path": "/tmp/notes/a.txt", "content": "héllo"}),
                         {"ok": True, "path": "/tmp/notes/a.txt"})
        got = self.adapter.files(self.ref, "read", {"path": "/tmp/notes/a.txt"})
        self.assertEqual((base64.b64decode(got["content"]).decode(), got["encoding"]), ("héllo", "base64"))
        self.adapter.files(self.ref, "mkdir", {"path": "/tmp/notes"})
        listing = self.adapter.files(self.ref, "list", {"path": "/tmp/notes"})
        self.assertEqual([(e["name"], e["dir"], e["size"]) for e in listing["entries"]], [("a.txt", False, 6)])
        self.assertEqual((listing["root"], listing["parent"], listing["entries"][0]["modified"]),
                         ("/tmp", "/tmp", 1760000000000))
        err = self.refused(self.adapter.files, self.ref, "write",
                           {"path": "/tmp/notes/a.txt", "content": "x", "overwrite": False})
        self.assertEqual((err.code, err.status), ("conflict", 409))
        self.assertEqual(self.adapter.files(self.ref, "remove", {"path": "/tmp/notes/a.txt"}), {"ok": True})
        self.assertNotIn("/tmp/notes/a.txt", self.fake.files)

    def test_hermes_refusals_become_codes(self):
        self.fake.files["/tmp/.env"] = {"mime": "text/plain", "bytes": b"KEY=1"}
        cases = [("read", {"path": "/tmp/.env"}, "forbidden"), ("read", {"path": "/tmp/../etc/passwd"}, "bad_request"),
                 ("list", {"path": "/etc"}, "forbidden"), ("read", {"path": "/tmp/none.txt"}, "not_found"),
                 ("read", {}, "bad_request"), ("write", {"path": "/tmp/x"}, "bad_request"),
                 ("chmod", {"path": "/tmp"}, "unsupported")]
        for op, p, code in cases:
            self.assertEqual(self.refused(self.adapter.files, self.ref, op, p).code, code, (op, p))


class TestScreen(MachineCase):
    def test_state_start_thumb_lease_browser_stop(self):
        st = self.adapter.screen_state(self.ref, "viewer-a")
        self.assertEqual((st["available"], st["running"], st["holder"], st["mine"], st["browserOnScreen"]),
                         (True, False, "agent", False, False))
        self.assertIsNone(self.adapter.screen_thumb(self.ref))              # not running: no picture
        st = self.adapter.screen_act(self.ref, "start", {"viewer": "a"})
        self.assertTrue(st["running"])
        self.assertEqual(st["geometry"], "1440x900")
        pic = self.adapter.screen_thumb(self.ref)
        self.assertEqual((pic["mime"], pic["data"][:2]), ("image/jpeg", b"\xff\xd8"))
        st = self.adapter.screen_act(self.ref, "lease", {"viewer": "a", "take": True})
        self.assertEqual((st["holder"], st["mine"], st["reason"]), ("human", True, "Virtual Office"))
        other = self.adapter.screen_act(self.ref, "start", {"viewer": "b"})
        self.assertEqual((other["holder"], other["mine"]), ("human", False))
        self.assertEqual(self.refused(self.adapter.screen_act, self.ref, "release", {"viewer": "b"}).code,
                         "bad_request")
        st = self.adapter.screen_act(self.ref, "lease", {"viewer": "a", "take": False})
        self.assertEqual((st["holder"], st["mine"]), ("agent", False))
        st = self.adapter.screen_act(self.ref, "browser", {"viewer": "a", "on": True})
        self.assertTrue(st["browserOnScreen"])
        self.assertEqual((self.fake.config["browser"], self.fake.config["bot_desktop"]),
                         ({"headed": True}, {"auto_start": True}))
        self.assertFalse(self.adapter.screen_act(self.ref, "stop", {"viewer": "a"})["running"])
        self.assertEqual(self.refused(self.adapter.screen_act, self.ref, "reboot", {}).code, "bad_request")
        self.assertIn("display.lease.acquire", self.display_calls())

    def test_not_installed_shows_the_install_line(self):
        self.fake.display["installed"] = False
        self.assertFalse(self.adapter.screen_state(self.ref)["installed"])
        self.assertEqual(self.refused(self.adapter.screen_act, self.ref, "start", {}).code, "provider_error")


class _NoDisplayLink:
    gen = 1
    connected = True

    def call(self, method, params=None, timeout=30):
        raise HermesError("hermes_-32601", f"unknown method {method}", rpc_code=-32601)

    def rest(self, *a, **k):
        return {}


class TestOlderHermes(unittest.TestCase):
    def test_no_bot_desktop_is_unavailable_with_a_reason(self):
        screen = hmc.Screen(_NoDisplayLink())
        st = screen.state("default", access="full")
        self.assertEqual(st["available"], False)
        self.assertIn("update Hermes", st["reason"])
        with self.assertRaises(HermesError) as cm:
            screen.thumb("default", access="full")
        self.assertEqual(cm.exception.code, "unsupported")
        with self.assertRaises(HermesError):
            screen.state("bad profile!", access="full")


if __name__ == "__main__":
    unittest.main()
