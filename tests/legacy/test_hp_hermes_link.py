"""HermesLink against the Python fake Hermes (tests/helpers/fake_hermes.py): sign-in modes, status codes, reconnects,
client.capabilities once per socket, server requests. Only 127.0.0.1 ephemeral ports; the whole file runs in seconds."""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
for extra in (os.path.join(HERE, "..", "app"), os.path.join(HERE, "helpers")):
    extra = os.path.abspath(extra)
    if extra not in sys.path:
        sys.path.insert(0, extra)

from fake_hermes import FakeHermes  # noqa: E402
from providers import hermes_link as hl  # noqa: E402
from providers.hermes_link import ANSWER_LATER, HermesError, HermesLink  # noqa: E402


def wait_for(pred, timeout=5.0, step=0.02):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(step)
    return bool(pred())


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class LinkCase(unittest.TestCase):
    def setUp(self):
        self.fakes, self.links = [], []
        self.stored: dict = {}
        self.statuses: list = []

    def tearDown(self):
        for link in self.links:
            link.close()
        for f in self.fakes:
            f.stop()

    def fake(self, **knobs) -> FakeHermes:
        f = FakeHermes(**knobs).start()
        self.fakes.append(f)
        return f

    def persist(self, cid, field, value):
        self.stored[field] = value

    def link(self, config, secrets, start=True, **attrs) -> HermesLink:
        link = HermesLink("c1", config, secrets, self.persist)
        for k, v in attrs.items():
            setattr(link, k, v)
        link.on_status(self.statuses.append)
        self.links.append(link)
        return link.start() if start else link

    def token_link(self, f, token=None, **attrs) -> HermesLink:
        return self.link({"url": f.url, "auth": "token"}, {"token": f.token if token is None else token}, **attrs)

    def password_link(self, f, password="pw-correct", tokens=None) -> HermesLink:
        secrets = {"password": password} if password else {}
        if tokens:
            secrets["tokens"] = json.dumps(tokens)
        return self.link({"url": f.url, "auth": "password", "username": "casey"}, secrets)


class TokenMode(LinkCase):
    def test_token_ok(self):
        f = self.fake()
        link = self.token_link(f)
        st = link.settle(5)
        self.assertEqual(st["state"], "connected", st)
        self.assertEqual(st["version"], "0.21.5")
        self.assertEqual(st["detail"], "Connected to Hermes 0.21.5.")
        self.assertEqual(link.server_requests, ["approval", "clarify", "secret", "sudo"])
        names = [p["name"] for p in link.call("profiles.list")["profiles"]]
        self.assertEqual(names, ["default", "research"])
        self.assertEqual(link.rest("GET", "/api/sessions", profile="default")["sessions"], [])
        self.assertEqual(link.rest("GET", "/api/files/download", query={"path": "/tmp/chart.png"}, raw=True).body,
                         __import__("fake_hermes").FILE_PNG)
        with self.assertRaises(HermesError) as cm:
            link.rest("GET", "/api/sessions/nope")
        self.assertEqual(cm.exception.code, "not_found")
        self.assertIn("connected", [s["state"] for s in self.statuses])
        self.assertTrue(all(s["type"] == "provider.status" and s["connectionId"] == "c1" for s in self.statuses))

    def test_wrong_token_is_auth_rejected_and_does_not_spin(self):
        f = self.fake()
        link = self.token_link(f, token="not-the-token")
        st = link.settle(5)
        self.assertEqual((st["state"], st["code"]), ("error", "auth_rejected"), st)
        self.assertIn("HERMES_DASHBOARD_SESSION_TOKEN", st["fix"])
        time.sleep(0.6)
        self.assertEqual(f.calls.count("WS /api/ws"), 1)
        with self.assertRaises(HermesError) as cm:
            link.call("profiles.list", wait=0.5)
        self.assertEqual(cm.exception.code, "not_connected")

    def test_restart_with_another_token_is_auth_rejected(self):
        f = self.fake()
        link = self.token_link(f)
        self.assertEqual(link.settle(5)["state"], "connected")
        f.restart(token="minted-at-start")
        self.assertTrue(wait_for(lambda: link.status().get("code") == "auth_rejected"), link.status())
        self.assertIn("HERMES_DASHBOARD_SESSION_TOKEN", link.status()["fix"])

    def test_signin_engaged_when_hermes_asks_for_a_password(self):
        f = self.fake(mode="password")
        st = self.token_link(f, token="x").settle(5)
        self.assertEqual((st["state"], st["code"]), ("error", "signin_engaged"), st)

    def test_not_configured(self):
        st = self.link({"url": "", "auth": "token"}, {"token": "t"}).status()
        self.assertEqual((st["code"], st["detail"]), ("not_configured", "The Hermes address is not set."))
        st = self.link({"url": "ftp://x", "auth": "token"}, {"token": "t"}).status()
        self.assertEqual((st["code"], st["detail"]), ("not_configured", "The address starts with http:// or https://"))
        st = self.link({"url": "http://127.0.0.1:1", "auth": "token"}, {}).status()
        self.assertEqual((st["code"], st["detail"]), ("not_configured", "The session token is not set."))
        st = self.link({"url": "http://127.0.0.1:1", "auth": "password", "username": "casey"}, {}).status()
        self.assertEqual((st["code"], st["detail"]), ("not_configured", "The username and password are not set."))

    def test_unreachable_keeps_trying(self):
        link = self.link({"url": f"http://127.0.0.1:{free_port()}", "auth": "token"}, {"token": "t"})
        self.assertTrue(wait_for(lambda: link.status().get("code") == "unreachable", 3), link.status())
        self.assertEqual(link.status()["state"], "offline")
        self.assertIn("hermes serve", link.status()["fix"])


class Refusals(LinkCase):
    def test_host_refused_on_http_400(self):
        f = self.fake(status_code=400)
        st = self.token_link(f).settle(5)
        self.assertEqual((st["state"], st["code"]), ("error", "host_refused"), st)
        self.assertIn("public_url", st["fix"])

    def test_not_hermes(self):
        f = self.fake(status_body={"hello": "world"})
        st = self.token_link(f).settle(5)
        self.assertEqual((st["code"], st["detail"]), ("not_hermes", "No Hermes backend answered here"))
        f2 = self.fake(status_code=404)
        st = self.token_link(f2).settle(5)
        self.assertEqual((st["code"], st["detail"]), ("not_hermes", "No Hermes backend answered here (404)"))

    def test_close_4403_is_request_refused(self):
        f = self.fake(ws_close_code=4403)
        st = self.token_link(f).settle(5)
        self.assertEqual((st["state"], st["code"]), ("error", "request_refused"), st)
        self.assertIn("(another computer, a container)", st["fix"])

    def test_close_4401_in_token_mode_is_auth_rejected(self):
        f = self.fake(ws_close_code=4401)
        st = self.token_link(f).settle(5)
        self.assertEqual(st["code"], "auth_rejected", st)


class PasswordMode(LinkCase):
    def test_password_signin_persists_tokens_and_forgets_the_password(self):
        f = self.fake(mode="password")
        link = self.password_link(f)
        st = link.settle(5)
        self.assertEqual(st["state"], "connected", st)
        self.assertIn("password", self.stored)
        self.assertIsNone(self.stored["password"])
        self.assertEqual(link.password, "")
        tokens = json.loads(self.stored["tokens"])
        self.assertEqual(tokens["user"], "casey")
        self.assertTrue(tokens["access"] and tokens["refresh"])
        # (the manager, handed the stored tokens and no password, keeps this live link)
        cfg = {"url": f.url, "auth": "password", "username": "casey"}
        self.assertEqual(link.key, HermesLink.key_for(cfg, {"tokens": self.stored["tokens"]}))
        self.assertFalse(link.configure(cfg, {"tokens": self.stored["tokens"]}))
        self.assertEqual(link.rest("GET", "/api/config")["model"], "stub-1")
        self.assertEqual(f.logins, 1)

    def test_password_against_a_loopback_hermes_is_signin_not_engaged(self):
        f = self.fake(mode="password", status_body={"version": "0.22.2", "auth_required": False,
                                                    "auth_providers": ["basic"]})
        st = self.password_link(f).settle(5)
        self.assertEqual((st["state"], st["code"]), ("error", "signin_not_engaged"), st)
        self.assertIn("Session token", st["fix"])
        self.assertEqual(f.logins, 0)

    def test_bad_password(self):
        f = self.fake(mode="password")
        st = self.password_link(f, password="wrong").settle(5)
        self.assertEqual((st["state"], st["code"]), ("error", "bad_credentials"), st)
        self.assertNotIn("tokens", self.stored)

    def test_rate_limited(self):
        f = self.fake(mode="password", login_status=429)
        st = self.password_link(f).settle(5)
        self.assertEqual((st["code"], st["fix"]), ("rate_limited", "Wait a minute; Hermes limits sign-ins."))

    def test_refresh_before_expiry(self):
        f = self.fake(mode="password", access_ttl=30)   # (inside the 60 s early window: the next use renews it)
        link = self.password_link(f)
        self.assertEqual(link.settle(5)["state"], "connected")
        first = json.loads(self.stored["tokens"])
        self.assertEqual(f.refreshed, 0)
        link.rest("GET", "/api/skills")
        self.assertEqual(f.refreshed, 1)
        renewed = json.loads(self.stored["tokens"])
        self.assertNotEqual(renewed["refresh"], first["refresh"])
        self.assertEqual(f.logins, 1)

    def test_refused_refresh_without_password_is_signin_needed(self):
        f = self.fake(mode="password")
        stale = {"access": "old", "refresh": "unknown-refresh", "expiresAt": time.time() - 10, "provider": "basic",
                 "user": "casey"}
        st = self.password_link(f, password=None, tokens=stale).settle(5)
        self.assertEqual((st["state"], st["code"]), ("error", "signin_needed"), st)
        self.assertIsNone(self.stored.get("tokens", "absent"))

    def test_tokens_of_another_username_are_ignored(self):
        f = self.fake(mode="password")
        other = {"access": "a", "refresh": "r", "expiresAt": time.time() + 999, "user": "someone-else"}
        link = self.password_link(f, tokens=other)
        self.assertEqual(link.settle(5)["state"], "connected")
        self.assertEqual(f.logins, 1)


class Socket(LinkCase):
    def test_drop_goes_offline_then_connected_with_capabilities_once_per_socket(self):
        f = self.fake()
        link = self.token_link(f)
        self.assertEqual(link.settle(5)["state"], "connected")
        f.drop_sockets()
        self.assertTrue(wait_for(lambda: f.sockets_opened == 2 and link.connected, 5), link.status())
        states = [(s["state"], s.get("code")) for s in self.statuses]
        k = states.index(("offline", "closed"))
        self.assertIn("connected", [s for s, _ in states[k:]])
        self.assertEqual(f.caps_by_socket, {1: 1, 2: 1})
        self.assertEqual(sum(1 for c in f.calls if c == "rpc client.capabilities"), 2)

    def test_heartbeat_silence_drops_and_reconnects(self):
        f = self.fake(stall=("gateway.ping",))
        link = self.token_link(f, heartbeat_s=0.1, heartbeat_deadline_s=0.35)
        self.assertEqual(link.settle(5)["state"], "connected")
        self.assertTrue(wait_for(lambda: f.sockets_opened >= 2, 5))
        self.assertIn("rpc gateway.ping", f.calls)

    def test_unknown_server_request_is_answered_32601(self):
        f = self.fake()
        link = self.token_link(f)
        self.assertEqual(link.settle(5)["state"], "connected")
        rid = f.send_request("weird.thing", {"x": 1})
        self.assertTrue(wait_for(lambda: any(a["id"] == rid for a in f.answers)))
        a = next(a for a in f.answers if a["id"] == rid)
        self.assertEqual(a["error"], {"code": -32601, "message": "weird.thing is not answered by the office"})
        rid = f.send_request("approval", {"session_id": "s1", "request_id": "r1"})   # (nobody takes approvals yet)
        self.assertTrue(wait_for(lambda: any(a["id"] == rid for a in f.answers)))
        self.assertEqual(next(a for a in f.answers if a["id"] == rid)["error"]["code"], -32601)

    def test_server_requests_answered_now_or_later_on_the_same_socket(self):
        f = self.fake()
        link = self.token_link(f)
        later = []

        def handler(req):
            if req["params"].get("later"):
                later.append(req)
                return ANSWER_LATER
            return {"choice": "once"}

        link.on_request(handler)
        self.assertEqual(link.settle(5)["state"], "connected")
        rid = f.send_request("approval", {"request_id": "r1"})
        self.assertTrue(wait_for(lambda: any(a["id"] == rid for a in f.answers)))
        self.assertEqual(next(a for a in f.answers if a["id"] == rid)["result"], {"choice": "once"})
        rid = f.send_request("clarify", {"later": True})
        self.assertTrue(wait_for(lambda: later))
        self.assertFalse(link.respond(rid, {"answers": {}}, later[0]["generation"] + 1))   # (another socket)
        self.assertTrue(link.respond(rid, {"answers": {"q0": "Red"}}, later[0]["generation"]))
        self.assertTrue(wait_for(lambda: any(a["id"] == rid for a in f.answers)))
        self.assertEqual(next(a for a in f.answers if a["id"] == rid)["result"], {"answers": {"q0": "Red"}})

    def test_a_turn_streams_events_once_each(self):
        f = self.fake()
        link = self.token_link(f)
        events, done = [], threading.Event()

        def on_event(e):
            events.append(e)
            if e["type"] == "message.complete":
                done.set()

        link.on_event(on_event)
        self.assertEqual(link.settle(5)["state"], "connected")
        sid = link.call("session.create", {"profile": "default", "source": "virtual-office"})["session_id"]
        self.assertEqual(link.call("prompt.submit", {"session_id": sid, "profile": "default", "text": "hi"})["status"],
                         "streaming")
        self.assertTrue(done.wait(5))
        self.assertEqual(events[-1]["payload"]["text"], "Stub answer to: hi")
        seqs = [e["seq"] for e in events]
        self.assertEqual(len(seqs), len(set(seqs)))
        self.assertTrue(link.can_replay(sid))
        self.assertEqual(link.replay(sid), {"count": 0, "truncated": False, "open": []})

    def test_sync_call_on_the_loop_thread_raises_instead_of_deadlocking(self):
        f = self.fake()
        link = self.token_link(f)
        seen = []
        link.on_ready(lambda: seen.append(self._try_call(link)))
        self.assertEqual(link.settle(5)["state"], "connected")
        self.assertTrue(wait_for(lambda: seen))
        self.assertEqual(seen[0], "RuntimeError")

    @staticmethod
    def _try_call(link):
        try:
            link.call("profiles.list")
            return "answered"
        except RuntimeError:
            return "RuntimeError"

    def test_configure_keeps_or_rebuilds(self):
        f = self.fake()
        link = self.token_link(f)
        self.assertEqual(link.settle(5)["state"], "connected")
        cfg = {"url": f.url, "auth": "token"}
        self.assertFalse(link.configure(cfg, {"token": f.token}))
        self.assertEqual(f.sockets_opened, 1)
        self.assertTrue(link.configure(cfg, {"token": "rotated"}))
        self.assertEqual(link.settle(5)["code"], "auth_rejected")

    def test_call_timeout_and_rpc_error(self):
        f = self.fake(stall=("model.options",))
        link = self.token_link(f)
        self.assertEqual(link.settle(5)["state"], "connected")
        with self.assertRaises(HermesError) as cm:
            link.call("model.options", {"profile": "default"}, timeout=0.3)
        self.assertEqual(cm.exception.code, "timeout")
        with self.assertRaises(HermesError) as cm:
            link.call("no.such.method")
        self.assertEqual((cm.exception.code, cm.exception.rpc_code), ("hermes_-32601", -32601))

    def test_probe(self):
        f = self.fake()
        self.assertTrue(hl.probe(f.url))
        self.assertFalse(hl.probe(f"http://127.0.0.1:{free_port()}", 0.5))


if __name__ == "__main__":
    unittest.main()
