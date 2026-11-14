#!/usr/bin/env python3
"""v0.10.1 ocpair-1: a Gateway connection that is up but short of scopes is never shown as plain "Connected".

OpenClaw gives a token-only client from outside its own computer (a Docker bridge network, another machine) no
scopes at all; the office used to say "Connected" while chat and the agent list failed. Offline: fake gateway.
"""
from __future__ import annotations

import os
import sys
import time
import unittest

from websockets.asyncio.client import connect

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
for path in (os.path.join(HERE, "..", "app"), HERE):
    if path not in sys.path:
        sys.path.insert(0, path)

from helpers.fake_gateway import FakeGateway  # noqa: E402
from openclaw_adapter import OpenClawAdapter  # noqa: E402
from openclaw_gateway_client import (  # noqa: E402
    OpenClawGatewayClient, missing_scopes, needed_scopes, scope_problem,
)

READ_WRITE = ["operator.read", "operator.write"]


def wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class ScopeHelperTests(unittest.TestCase):
    def test_needed_scopes_per_level(self) -> None:
        self.assertEqual(needed_scopes("chat"), READ_WRITE)
        self.assertEqual(needed_scopes("full"), READ_WRITE + ["operator.admin"])

    def test_missing_scopes(self) -> None:
        self.assertEqual(missing_scopes(None, "full"), [])  # the gateway did not say: trust what was asked
        self.assertEqual(missing_scopes([], "full"), READ_WRITE + ["operator.admin"])
        self.assertEqual(missing_scopes([], "chat"), READ_WRITE)
        self.assertEqual(missing_scopes(["operator.admin"], "full"), [])  # admin covers every operator scope
        self.assertEqual(missing_scopes(READ_WRITE, "chat"), [])
        self.assertEqual(missing_scopes(READ_WRITE + ["operator.approvals"], "full"), ["operator.admin"])

    def test_problem_words(self) -> None:
        self.assertIsNone(scope_problem([]))
        bad = scope_problem(["operator.read", "operator.write"])
        self.assertEqual((bad["state"], bad["code"]), ("error", "scope_missing"))
        self.assertTrue(bad["detail"].startswith("Connected, but OpenClaw did not give this office permission"))
        self.assertIn("operator.read, operator.write", bad["detail"])
        self.assertIn("Docker", bad["fix"])
        limited = scope_problem(["operator.admin"])
        self.assertEqual((limited["state"], limited["code"]), ("connected", "scope_limited"))
        self.assertIn("chat works", limited["detail"])
        self.assertIn("Chat only", limited["fix"])
        for words in (bad, limited):
            self.assertNotIn("—", words["detail"] + words["fix"])


class ScopeStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.gateway = FakeGateway().start()
        self.access = "full"
        self.client = OpenClawGatewayClient(
            lambda _key: {"url": self.gateway.url, "token": "test-token", "access": self.access},
            connect, reconnect_min_sec=0.02, reconnect_max_sec=0.1,
        )
        self.adapter = OpenClawAdapter(lambda: self.client, config_key_getter=lambda: ("fake", self.access))

    def tearDown(self) -> None:
        self.adapter.close()
        self.client.close()
        self.gateway.stop()

    def connect(self) -> None:
        self.client.request("health", {}, timeout=3, config_key=("fake", self.access))
        self.assertTrue(wait_for(lambda: self.client.status()["connected"]))

    def test_zero_scopes_is_an_error_not_connected(self) -> None:
        self.gateway.grant = lambda requested: []  # what OpenClaw gives a token-only non-loopback client
        self.connect()
        self.assertEqual(self.client.status()["missingScopes"], READ_WRITE + ["operator.admin"])
        status = self.adapter.status()
        self.assertEqual((status["state"], status["code"]), ("error", "scope_missing"))
        self.assertNotEqual(status["detail"], "Connected")
        test = self.adapter.test(timeout=2)
        self.assertFalse(test["ok"])
        self.assertEqual(test["code"], "scope_missing")
        self.assertTrue(test["fix"])

    def test_full_access_without_admin_is_limited(self) -> None:
        self.gateway.grant = lambda requested: [s for s in requested if s != "operator.admin"]
        self.connect()
        status = self.adapter.status()
        self.assertEqual((status["state"], status["code"]), ("connected", "scope_limited"))
        test = self.adapter.test(timeout=2)
        self.assertTrue(test["ok"])
        self.assertEqual(test["code"], "scope_limited")

    def test_chat_only_with_read_write_is_plainly_connected(self) -> None:
        self.access = "chat"
        self.gateway.grant = lambda requested: READ_WRITE
        self.connect()
        self.assertEqual(self.client.status()["missingScopes"], [])
        self.assertEqual(self.adapter.status()["detail"], "Connected")

    def test_full_grant_is_plainly_connected(self) -> None:
        self.connect()
        status = self.adapter.status()
        self.assertEqual((status["state"], status["code"], status["detail"]), ("connected", None, "Connected"))

    def test_gateway_that_does_not_name_scopes_is_trusted(self) -> None:
        self.gateway.grant = lambda requested: None  # hello-ok without auth.scopes (older gateways)
        self.connect()
        self.assertEqual(self.client.status()["missingScopes"], [])

    def test_missing_scopes_end_with_the_connection(self) -> None:
        self.gateway.grant = lambda requested: []
        self.connect()
        self.gateway.stop()
        self.assertTrue(wait_for(lambda: not self.client.status()["connected"]))
        self.assertNotIn("missingScopes", self.client.status())


if __name__ == "__main__":
    unittest.main()
