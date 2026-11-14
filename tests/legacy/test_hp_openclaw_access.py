#!/usr/bin/env python3
"""A3 hp-openclaw: Gateway client access levels, hello-ok discovery, event names."""

from __future__ import annotations

import os
import queue
import sys
import time
import unittest

from websockets.asyncio.client import connect

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
for path in (os.path.join(HERE, "..", "app"), HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from helpers.fake_gateway import FakeGateway  # noqa: E402
from openclaw_gateway_client import OpenClawGatewayClient, normalize_access, scopes_for_access  # noqa: E402

FULL = ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"]
CHAT = ["operator.read", "operator.write", "operator.approvals", "operator.questions"]


def wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class AccessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.gateway = FakeGateway().start()
        self.access = "full"
        self.client = OpenClawGatewayClient(
            lambda _key: {"url": self.gateway.url, "token": "test-token", "access": self.access},
            connect, reconnect_min_sec=0.02, reconnect_max_sec=0.1,
        )

    def tearDown(self) -> None:
        self.client.close()
        self.gateway.stop()

    def key(self) -> tuple:
        return ("custom", self.gateway.port, self.access)

    def test_scope_helpers(self) -> None:
        self.assertEqual(scopes_for_access("full"), FULL)
        self.assertEqual(scopes_for_access(None), FULL)
        self.assertEqual(scopes_for_access("chat"), CHAT)
        self.assertEqual(normalize_access(" Chat "), "chat")
        self.assertEqual(normalize_access("anything"), "full")

    def test_full_access_asks_for_admin_and_reports_access(self) -> None:
        self.client.request("agents.list", {}, timeout=3, config_key=self.key())
        self.assertEqual(self.gateway.connect_frames[-1]["params"]["scopes"], FULL)
        status = self.client.status()
        self.assertEqual(status["access"], "full")
        self.assertEqual(status["version"], "2026.10.30")
        self.assertTrue(self.client.grants("operator.admin"))

    def test_chat_access_drops_admin_and_gateway_refuses_admin_calls(self) -> None:
        self.access = "chat"
        response = self.client.request("config.get", {}, timeout=3, config_key=self.key())
        self.assertFalse(response["ok"])
        self.assertIn("operator.admin", response["error"]["message"])
        self.assertEqual(self.gateway.connect_frames[-1]["params"]["scopes"], CHAT)
        self.assertEqual(self.client.status()["access"], "chat")
        self.assertFalse(self.client.grants("operator.admin"))
        self.assertTrue(self.client.grants("operator.approvals"))

    def test_access_change_in_config_key_reconnects_with_new_scopes(self) -> None:
        self.client.request("agents.list", {}, timeout=3, config_key=self.key())
        self.access = "chat"
        self.client.request("agents.list", {}, timeout=3, config_key=self.key())
        self.assertEqual(len(self.gateway.connect_frames), 2)
        self.assertEqual(self.gateway.connect_frames[-1]["params"]["scopes"], CHAT)

    def test_granted_scopes_from_hello_win_over_requested(self) -> None:
        self.gateway.grant = lambda requested: [s for s in requested if s != "operator.admin"]
        self.client.request("agents.list", {}, timeout=3, config_key=self.key())
        self.assertFalse(self.client.grants("operator.admin"))
        self.assertTrue(self.client.grants("operator.read"))

    def test_offers_follow_hello_and_end_with_the_connection(self) -> None:
        self.gateway.methods = ["agents.list", "approval.resolve"]
        self.assertFalse(self.client.offers("agents.list"))
        self.client.request("agents.list", {}, timeout=3, config_key=self.key())
        self.assertTrue(self.client.offers("approval.resolve"))
        self.assertFalse(self.client.offers("browser.request"))
        self.assertTrue(self.client.sends("task"))
        hello = self.client.hello()
        self.assertEqual(hello["policy"]["attachments"]["maxBytes"], 5000000)
        self.assertEqual(hello["methodCount"], 2)
        self.gateway.stop()  # down for good: no reconnect can race the check
        self.assertTrue(wait_for(lambda: not self.client.status()["connected"]))
        self.assertFalse(self.client.offers("approval.resolve"))
        self.assertEqual(self.client.hello(), {})

    def test_new_event_names_reach_only_subscribers_that_asked(self) -> None:
        legacy = self.client.subscribe(config_key=self.key())
        named = self.client.subscribe(config_key=self.key(), events={"exec.approval.requested", "chat"})
        self.client.request("agents.list", {}, timeout=3, config_key=self.key())
        for sub in (legacy, named):  # drain proxy.ready
            while True:
                try:
                    sub.get(timeout=0.2)
                except queue.Empty:
                    break
        self.gateway.emit("exec.approval.requested", {"id": "a1", "request": {"command": "ls"}})
        self.gateway.emit("chat", {"runId": "r1", "sessionKey": "agent:main:main", "state": "delta"})
        got_named = [named.get(timeout=2)["event"], named.get(timeout=2)["event"]]
        self.assertEqual(got_named, ["exec.approval.requested", "chat"])
        self.assertEqual(legacy.get(timeout=2)["event"], "chat")
        with self.assertRaises(queue.Empty):
            legacy.get(timeout=0.2)
        named.close()
        legacy.close()
        self.assertEqual(self.client.status()["subscriberCount"], 0)


if __name__ == "__main__":
    unittest.main()
