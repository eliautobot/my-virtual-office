"""hp-hermes C1: Hermes' settings menu (app/providers/hermes_menu.py) through the adapter's menu() against the fake
`hermes serve` (tests/helpers/fake_hermes.py).

Covers design C1 accept items for the menu: every read the Hermes menu tabs call answers at both access levels; every
write is refused under Chat only (the 3.6 text, nothing reaches Hermes); config.patch checks `base` (409 conflict, no
write) and sends only the changed settings; secret keys are redacted everywhere (config, MCP env/headers, keys list),
never echoed by a write. 127.0.0.1 ephemeral ports only.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
for extra in (os.path.join(HERE, "..", "app"), os.path.join(HERE, "helpers")):
    extra = os.path.abspath(extra)
    if extra not in sys.path:
        sys.path.insert(0, extra)

from fake_hermes import FakeHermes  # noqa: E402
from providers import hermes_menu as hm  # noqa: E402
from providers.hermes_adapter import HermesAdapter  # noqa: E402
from providers.hermes_link import HermesError  # noqa: E402
import agent_providers  # noqa: E402

CID = "hm1"
SECRETS = ("super-secret-key", "ink-secret-value-9", "ink-hdr-1", "sk-or-env-secret-1", "sk-o", "ink...")
READS = [("status", {}), ("analytics", {"days": 7}), ("analytics", {"days": 30}), ("profiles.list", {}),
         ("models.options", {"profile": "default"}), ("toolsets.list", {"profile": "default"}),
         ("skills.list", {"profile": "default"}), ("cron.list", {"profile": "default"}),
         ("mcp.list", {"profile": "default"}), ("sessions.list", {"profile": "default", "limit": 100}),
         ("config.schema", {"profile": "default"}), ("config.get", {"profile": "default"}),
         ("env.list", {"profile": "default"})]
WRITES = [("profiles.create", {"name": "scribe"}), ("model.default", {"profile": "default", "provider": "custom",
                                                                      "model": "stub-2"}),
          ("toolsets.set", {"profile": "default", "name": "web", "enabled": False}),
          ("skills.set", {"profile": "default", "name": "web-research", "enabled": False}),
          ("mcp.set", {"profile": "default", "name": "ink", "enabled": False}),
          ("cron.pause", {"profile": "default", "id": "j1"}), ("cron.resume", {"profile": "default", "id": "j1"}),
          ("cron.run", {"profile": "default", "id": "j1"}), ("cron.remove", {"profile": "default", "id": "j1"}),
          ("sessions.delete", {"profile": "default", "id": "s-x"}),
          ("config.patch", {"profile": "default", "changes": {"display.busy_input_mode": "queue"}}),
          ("env.set", {"profile": "default", "key": "OPENROUTER_API_KEY", "value": "sk-new"})]


def wait_for(predicate, timeout=6.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class MenuCase(unittest.TestCase):
    access = "full"

    def setUp(self):
        self.fake = FakeHermes(confirm_models={"stub-2"}).start()
        self.record = {"id": CID, "url": self.fake.url, "auth": "token", "enabled": True, "access": self.access}
        self.adapter = HermesAdapter(connection=lambda cid: dict(self.record) if cid == CID else None,
                                     secrets=lambda cid: {"token": self.fake.token}, persist=lambda *a: None)
        self.assertTrue(wait_for(lambda: self.adapter.status(CID)["state"] == "connected"), self.adapter.status(CID))

    def tearDown(self):
        self.adapter.close(CID, "test over")
        self.fake.stop()

    def call(self, method, params=None):
        return self.adapter.menu(CID, method, dict(params or {}))

    def refused(self, method, params=None):
        with self.assertRaises(HermesError) as cm:
            self.call(method, params)
        return cm.exception

    def writes_sent(self):
        return [(m, p) for m, p, _q, _b in self.fake.rest_log if m != "GET"]


class TestReads(MenuCase):
    access = "chat"

    def test_every_read_answers_under_chat_only_and_no_secret_leaves(self):
        answers = {}
        for method, params in READS:
            answers[f"{method}{params.get('days', '')}"] = self.call(method, params)
        blob = json.dumps(answers)
        for secret in SECRETS:
            self.assertNotIn(secret, blob)
        self.assertEqual(answers["status"]["version"], "0.21.5")
        self.assertEqual(answers["analytics7"]["totals"]["input_tokens"], 10)       # (numbers are not redacted)
        self.assertIn("default", [p["name"] for p in answers["profiles.list"]["profiles"]])
        self.assertEqual(answers["models.options"]["model"], "stub-1")
        self.assertEqual(answers["toolsets.list"][0]["name"], "web")
        self.assertEqual(answers["skills.list"][0]["name"], "web-research")
        self.assertEqual(answers["cron.list"][0]["job_id"], "j1")
        self.assertIn("sessions", answers["sessions.list"])
        self.assertIn("display.busy_input_mode", answers["config.schema"]["fields"])
        cfg = answers["config.get"]["config"]
        self.assertEqual(cfg["gateway"]["api_server"]["key"], {"secret": True, "set": True})
        self.assertEqual(cfg["display"]["busy_input_mode"], "steer")
        ink = answers["mcp.list"]["servers"][0]
        self.assertEqual(ink["env"], {"INK_API_KEY": {"secret": True, "set": True}})
        self.assertEqual(ink["headers"], {"Authorization": {"secret": True, "set": True}})
        self.assertEqual(ink["args"], ["ink-mcp"])
        keys = {k["key"]: k for k in answers["env.list"]["keys"]}
        self.assertEqual((keys["OPENROUTER_API_KEY"]["set"], keys["UNSET_KEY"]["set"]), (True, False))
        self.assertNotIn("redacted_value", blob)
        self.assertEqual(self.writes_sent(), [])
        # the profile and the clamps reach Hermes
        q = {p: q for m, p, q, _b in self.fake.rest_log if m == "GET"}
        self.assertEqual(q["/api/sessions"], {"profile": "default", "limit": "100", "offset": "0"})
        self.assertEqual(q["/api/analytics/usage"]["days"], "30")

    def test_every_write_is_refused_under_chat_only_and_reaches_nobody(self):
        text = agent_providers.chat_only_reason("hermes", "settings")
        for method, params in WRITES:
            err = self.refused(method, params)
            self.assertEqual((err.code, err.status, err.detail), ("chat_only", 403, text), method)
            self.assertTrue(err.fix)
        self.assertEqual(self.writes_sent(), [])
        self.assertNotIn("profiles.create", [m for _s, m, _p in self.fake.rpc])

    def test_unknown_call_and_bad_names(self):
        err = self.refused("system.shutdown")
        self.assertEqual((err.code, err.status), ("unsupported", 400))
        err = self.refused("skills.list", {"profile": "../etc"})
        self.assertEqual((err.code, err.status), ("bad_request", 400))
        err = self.refused("sessions.list", {"profile": "nobody"})
        self.assertEqual(err.code, "not_found")


class TestWrites(MenuCase):
    def setUp(self):
        super().setUp()
        gated = mock.patch.object(HermesAdapter, "_gated", staticmethod(lambda: frozenset(hm.MENU_WRITE)))
        gated.start()
        self.addCleanup(gated.stop)

    def test_profiles_toggles_cron_and_sessions(self):
        self.assertEqual(self.call("profiles.create", {"name": "scribe", "description": "Notes",
                                                       "clone_from": "default"})["name"], "scribe")
        self.assertIn("scribe", [p["name"] for p in self.call("profiles.list")["profiles"]])
        self.assertEqual(self.refused("profiles.create", {"name": "bad name!"}).code, "bad_request")
        self.assertEqual(self.refused("profiles.create", {"name": "scribe"}).code, "bad_request")   # Hermes refused
        self.call("toolsets.set", {"profile": "default", "name": "web", "enabled": False})
        self.call("skills.set", {"profile": "default", "name": "web-research", "enabled": False})
        self.call("mcp.set", {"profile": "default", "name": "ink", "enabled": False})
        self.assertEqual((self.fake.toolsets[0]["enabled"], self.fake.skills[0]["enabled"],
                          self.fake.mcp[0]["enabled"]), (False, False, False))
        self.call("cron.pause", {"profile": "default", "id": "j1"})
        self.assertFalse(self.fake.jobs[0]["enabled"])
        self.call("cron.resume", {"profile": "default", "id": "j1"})
        self.call("cron.run", {"profile": "default", "id": "j1"})
        self.assertTrue(self.fake.jobs[0]["enabled"])
        self.call("cron.remove", {"profile": "default", "id": "j1"})
        self.assertEqual(self.fake.jobs, [])
        self.assertEqual(self.refused("cron.run", {"id": "j1"}).code, "not_found")
        sent = [(m, p, q.get("profile")) for m, p, q, _b in self.fake.rest_log if m != "GET"]
        self.assertIn(("PUT", "/api/tools/toolsets/web", "default"), sent)
        self.assertIn(("POST", "/api/cron/jobs/j1/trigger", "default"), sent)
        self.assertEqual(self.refused("sessions.delete", {"profile": "default", "id": "nope"}).code, "not_found")

    def test_default_model_asks_hermes_confirm_then_sets(self):
        p = {"profile": "default", "provider": "custom", "model": "stub-2"}
        first = self.call("model.default", p)
        self.assertTrue(first["confirm_required"])
        self.assertIn("expensive", first["confirm_message"])
        self.assertEqual(self.fake.config["model"], "stub-1")
        self.assertTrue(self.call("model.default", dict(p, confirm=True))["ok"])
        self.assertEqual(self.fake.config["model"], "stub-2")
        body = [b for m, path, _q, b in self.fake.rest_log if path == "/api/model/set"][-1]
        self.assertEqual((body["scope"], body["confirm_expensive_model"]), ("main", True))
        self.assertEqual(self.refused("model.default", {"profile": "default"}).code, "bad_request")

    def test_config_patch_sends_only_changes_and_checks_base(self):
        hint = {"replace": "Office chat window: markdown renders."}
        r = self.call("config.patch", {"profile": "default",
                                       "changes": {"display.busy_input_mode": "queue",
                                                   "platform_hints.virtualoffice": hint},
                                       "base": {"display.busy_input_mode": "steer",
                                                "platform_hints.virtualoffice": None}})
        self.assertEqual(r, {"ok": True, "changed": ["display.busy_input_mode", "platform_hints.virtualoffice"]})
        put = [b for m, p, _q, b in self.fake.rest_log if (m, p) == ("PUT", "/api/config")]
        self.assertEqual(put, [{"config": {"display": {"busy_input_mode": "queue"},
                                           "platform_hints": {"virtualoffice": hint}}, "profile": "default"}])
        self.assertEqual(self.fake.config["gateway"]["api_server"]["key"], "super-secret-key")   # untouched
        # changed elsewhere meanwhile: the whole change is refused, nothing written
        self.fake.config["display"]["busy_input_mode"] = "interrupt"
        err = self.refused("config.patch", {"profile": "default", "changes": {"display.busy_input_mode": "steer",
                                                                              "model": "stub-2"},
                                            "base": {"display.busy_input_mode": "queue", "model": "stub-1"}})
        self.assertEqual((err.code, err.status), ("conflict", 409))
        self.assertIn("changed elsewhere", err.detail)
        self.assertEqual((self.fake.config["model"], len(put)), ("stub-1", 1))
        self.assertEqual(len([1 for m, p, _q, _b in self.fake.rest_log if (m, p) == ("PUT", "/api/config")]), 1)
        # a secret setting: its base is the redacted form the page was shown; the new value goes through, never back
        r = self.call("config.patch", {"profile": "default", "changes": {"gateway.api_server.key": "new-key-77"},
                                       "base": {"gateway.api_server.key": {"secret": True, "set": True}}})
        self.assertNotIn("new-key-77", json.dumps(r))
        self.assertEqual(self.fake.config["gateway"]["api_server"]["key"], "new-key-77")
        for bad in ({"changes": {}}, {"changes": {"a..b": 1}}, {"changes": {"x": 1, "../y": 2}},
                    {"changes": {"gateway.api_server.key": {"secret": True, "set": True}}}):
            self.assertEqual(self.refused("config.patch", dict(bad, profile="default")).code, "bad_request", bad)

    def test_env_set_never_echoes_and_needs_the_route_gate(self):
        r = self.call("env.set", {"profile": "default", "key": "OPENROUTER_API_KEY", "value": "sk-or-new-2"})
        self.assertEqual(r, {"ok": True, "key": "OPENROUTER_API_KEY", "set": True})
        self.assertEqual(self.fake.env["OPENROUTER_API_KEY"], "sk-or-new-2")
        self.assertNotIn("sk-or-new", json.dumps(self.call("env.list", {"profile": "default"})))
        self.assertEqual(self.refused("env.set", {"key": "bad key", "value": "x"}).code, "bad_request")
        self.assertEqual(self.refused("env.set", {"key": "A_KEY", "value": ""}).code, "bad_request")

    def test_a_write_the_office_route_does_not_gate_is_not_offered(self):
        with mock.patch.object(HermesAdapter, "_gated", staticmethod(lambda: frozenset({"skills.set"}))):
            err = self.refused("env.set", {"key": "OPENROUTER_API_KEY", "value": "sk-x"})
        self.assertEqual((err.code, err.status), ("unsupported", 400))
        self.assertEqual(self.fake.env["OPENROUTER_API_KEY"], "sk-or-env-secret-1")


class TestContract(unittest.TestCase):
    def test_manifest_menu_write_is_the_menus_writes(self):
        manifest = set(agent_providers.MANIFESTS["hermes"]["menuWrite"])
        self.assertEqual(manifest - set(hm.MENU_WRITE), set())
        self.assertEqual(set(hm.MENU_WRITE) - manifest, set())   # env.set listed by hp-core (gated like the rest)
        self.assertEqual(set(hm.MENU_READ) & set(hm.MENU_WRITE), set())

    def test_every_call_of_the_hermes_menu_page_exists(self):
        src = open(os.path.join(HERE, "..", "app", "provider-menu-hermes.js"), encoding="utf-8").read()
        called = set(re.findall(r"call\('([\w.]+)'", src))
        called |= {"cron.pause", "cron.resume", "cron.run", "cron.remove", "toolsets.set", "mcp.set"}
        self.assertTrue(called)
        self.assertEqual(called - set(hm.MENU_READ) - set(hm.MENU_WRITE), set())

    def test_redact(self):
        tree = {"api_key": "x", "tokens": 3, "input_tokens": 5, "auth": {"bearer": "b", "mode": "on"},
                "list": [{"password": ""}], "secret": None, "client_secret": False, "nested": {"key": "k"}}
        self.assertEqual(hm.redact(tree), {"api_key": {"secret": True, "set": True}, "tokens": 3,
                                           "input_tokens": 5,
                                           "auth": {"bearer": {"secret": True, "set": True}, "mode": "on"},
                                           "list": [{"password": {"secret": True, "set": False}}], "secret": None,
                                           "client_secret": False, "nested": {"key": {"secret": True, "set": True}}})


if __name__ == "__main__":
    unittest.main()
