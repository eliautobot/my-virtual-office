"""hp-core follow-ups (after C1-C5): Hermes' key setting gated like every other menu write, the OpenClaw sessions
drawer route, `deletable` on serve drawer rows, /can for one chat, and the retired Hermes keys on /setup/save.

Runs the real office handler on a free port with temp data (see test_hp_core_routes.RoutesBase).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(ROOT / "tests"))

import test_hp_core_routes as base  # noqa: E402,F401  (sets the env + paths, then imports server)
from test_hp_core_gates import GatesBase  # noqa: E402

import agent_providers as ap  # noqa: E402
import server  # noqa: E402
import vo_access  # noqa: E402
from providers import hermes_menu as hm  # noqa: E402


class FakeLink:
    """A Hermes link that records the REST calls the menu makes."""

    def __init__(self):
        self.calls = []

    def rest(self, method, path, body, profile, query=None, timeout=30):
        self.calls.append((method, path, body, profile))
        return {}


class HermesKeySetting(GatesBase):
    def audit_methods(self):
        path = self.status / ap.AUDIT_FILE
        return [json.loads(line)["method"] for line in path.read_text().splitlines()] if path.exists() else []

    def test_every_menu_write_hermes_menu_knows_is_gated_by_the_manifest(self):
        self.assertIn("env.set", ap.MANIFESTS["hermes"]["menuWrite"])
        self.assertEqual(sorted(set(hm.MENU_WRITE) - set(ap.MANIFESTS["hermes"]["menuWrite"])), [])
        # what the adapter passes as `gated`: env.set now reaches Hermes instead of "not offered from the office yet"
        link = FakeLink()
        gated = frozenset(ap.MANIFESTS["hermes"]["menuWrite"])
        out = hm.menu_call(link, "env.set", {"profile": "default", "key": "OPENAI_API_KEY", "value": "sk-zz"},
                           access="full", gated=gated)
        self.assertEqual(out, {"ok": True, "key": "OPENAI_API_KEY", "set": True})
        self.assertEqual([(m, p) for m, p, _b, _pr in link.calls], [("PUT", "/api/env")])
        with self.assertRaises(Exception) as caught:
            hm.menu_call(FakeLink(), "env.set", {"key": "OPENAI_API_KEY", "value": "x"}, access="chat", gated=gated)
        self.assertEqual(getattr(caught.exception, "code", ""), "chat_only")

    def test_env_set_needs_full_access_and_is_audited_without_the_value(self):
        self.save_lab()
        call = {"id": "lab", "method": "env.set", "params": {"key": "OPENAI_API_KEY", "value": "sk-zz-secret"}}
        status, out = self.request("POST", "/api/agent-providers/call", call)
        self.assertEqual(status, 200, out)
        self.assertIn(("menu", "lab", "env.set"), self.hermes.calls)
        self.assertEqual(self.audit_methods(), ["env.set"])
        self.assertNotIn("sk-zz-secret", (self.status / ap.AUDIT_FILE).read_text())
        ap._store().update(lambda d: ap.find_connection("lab", d).update(access="chat"))
        before = len(self.hermes.calls)
        status, out = self.request("POST", "/api/agent-providers/call", call)
        self.assert_chat_only(status, out, "hermes", "settings", "env.set")
        self.assertEqual(len(self.hermes.calls), before)  # nothing asked of Hermes
        self.assertEqual(self.audit_methods(), ["env.set"])


class HermesDrawerRows(GatesBase):
    def test_serve_drawer_rows_carry_deletable_for_a_browser_or_this_machine(self):
        self.save_lab()
        self.lab_row()
        status, out = self.request("GET", "/api/office/chat-sessions?agentId=hermes-lab")
        self.assertEqual(status, 200, out)
        self.assertEqual([(s["id"], s["deletable"]) for s in out["sessions"]], [("s1", True), ("s2", True)])
        status, out = self.request("GET", "/api/agent-chat/sessions?agent=hermes-lab")
        self.assertEqual(status, 200, out)
        self.assertEqual((out["kind"], out["transport"], out["working"]), ("hermes", "hermes-serve", []))
        self.assertEqual([(s["key"], s["title"], s["hasActiveRun"], s["deletable"]) for s in out["sessions"]],
                         [("s1", "One", False, True), ("s2", "Two", False, True)])
        # an agent token reads the list but is never offered Delete (the delete route refuses it too)
        self.store.set_passcode("open-sesame")
        auth = {"Authorization": f"Bearer {self.store.agent_token()}"}
        with mock.patch.object(vo_access, "is_loopback_ip", return_value=False):
            status, out = self.request("GET", "/api/agent-chat/sessions?agent=hermes-lab", headers=auth)
            self.assertEqual(status, 200, out)
            self.assertEqual([s["deletable"] for s in out["sessions"]], [False, False])
            self.assertFalse(any(s["deletable"] for s in server.handle_chat_sessions_list("hermes-lab")[0]["sessions"]))

    def test_serve_drawer_deletable_follows_the_adapter(self):
        self.save_lab()
        self.lab_row()
        with mock.patch.object(type(self.hermes), "session_op", None):
            out = self.request("GET", "/api/office/chat-sessions?agentId=hermes-lab")[1]
        self.assertEqual([s["deletable"] for s in out["sessions"]], [False, False])
        # legacy (API server) agents have no platform list: refused like every other adapter route
        status, out = self.request("GET", "/api/agent-chat/sessions?agent=hermes-astra")
        self.assertEqual((status, out["error"]), (400, "unsupported"))


class OpenClawDrawer(base.RoutesBase):
    """GET /api/agent-chat/sessions for an OpenClaw agent: sessions.list titles + hasActiveRun (design 2.9)."""

    def setUp(self):
        super().setUp()
        self.gateway = base.FakeGateway()
        self.gateway.handlers["sessions.list"] = self._sessions_list
        self.gateway.start()
        self.asked = []
        self.level = "full"
        self.client = base.OpenClawGatewayClient(
            lambda _key: {"url": self.gateway.url, "token": "test-token", "access": "full"},
            base.connect, reconnect_min_sec=0.02, reconnect_max_sec=0.1)
        self.openclaw_adapter = base.OpenClawAdapter(lambda: self.client, config_key_getter=lambda: ("fake", "full"),
                                                     access_getter=lambda: self.level)
        ap.register_adapter("openclaw", self.openclaw_adapter)
        self.more = [mock.patch.object(server, "_get_openclaw_gateway_client", lambda: self.client),
                     mock.patch.object(server, "_gateway_config_key", lambda: ("fake", "full"))]
        for p in self.more:
            p.start()
        self.client.start(("fake", "full"))
        self.assertTrue(base.wait_for(lambda: self.client.status()["connected"]))

    def tearDown(self):
        for p in reversed(self.more):
            p.stop()
        super().tearDown()
        self.client.close()
        self.gateway.stop()

    def _sessions_list(self, params, scopes):
        self.asked.append(dict(params))
        return {"sessions": [
            {"key": "agent:main:main", "label": "Main chat", "updatedAt": 9, "hasActiveRun": True},
            {"key": "agent:main:dash-1", "derivedTitle": "Plan the week", "updatedAt": 5},
            {"key": "agent:main:bg", "isBackground": True}]}

    def test_titles_and_active_runs_for_the_drawer_read_only(self):
        status, out = self.request("GET", "/api/agent-chat/sessions?agent=main")
        self.assertEqual(status, 200, out)
        self.assertEqual((out["ok"], out["kind"], out["transport"]), (True, "openclaw", "openclaw"))
        self.assertEqual([(s["key"], s["title"], s["hasActiveRun"], s["deletable"]) for s in out["sessions"]],
                         [("agent:main:main", "Main chat", True, False), ("agent:main:dash-1", "Plan the week", False,
                                                                          True)])
        self.assertEqual(out["working"], ["agent:main:main"])
        self.assertNotIn("active", out["sessions"][0])  # never mixed up with the drawer's own "selected" mark
        self.assertEqual(self.asked[-1]["agentId"], "main")
        self.assertTrue(self.asked[-1]["excludeCron"])
        # read-only: the only gateway call the route made is sessions.list
        self.assertEqual({r.get("method") for r in self.gateway.requests} - {"connect"}, {"sessions.list"})
        # Chat only: listed, never deletable (OpenClaw's sessions.delete is a settings write)
        ap._store().update(lambda d: d["openclaw"].update(access="chat"))
        self.level = "chat"
        out = self.request("GET", "/api/agent-chat/sessions?agent=main")[1]
        self.assertEqual([s["deletable"] for s in out["sessions"]], [False, False])

    def test_can_with_session_names_that_chats_model_and_effort(self):
        status, out = self.request("POST", "/api/agent-chat/prefs",
                                   {"agent": "main", "session": "dash-1", "model": "openai/gpt-x", "effort": "high"})
        self.assertEqual(status, 200, out)
        out = self.request("GET", "/api/agent-chat/can?agent=main&session=dash-1")[1]
        self.assertEqual(out["prefs"], {"model": "openai/gpt-x", "effort": "high"})
        out = self.request("GET", "/api/agent-chat/can?agent=main&session=agent:main:dash-1")[1]
        self.assertEqual(out["prefs"]["model"], "openai/gpt-x")  # the full key names the same chat
        for other in ("", "&session=agent:main:other"):
            out = self.request("GET", "/api/agent-chat/can?agent=main" + other)[1]
            self.assertEqual(out["prefs"], {"model": None, "effort": None}, other)

    def test_gateway_down_or_missing_the_call(self):
        self.gateway.methods = [m for m in self.gateway.offered() if m != "sessions.list"]
        self.client.close()
        self.client.start(("fake", "full"))
        self.assertTrue(base.wait_for(lambda: self.client.status()["connected"]))
        status, out = self.request("GET", "/api/agent-chat/sessions?agent=main")
        self.assertEqual((status, out["error"]), (400, "unsupported"), out)
        self.gateway.stop()
        self.assertTrue(base.wait_for(lambda: not self.client.status()["connected"]))
        status, out = self.request("GET", "/api/agent-chat/sessions?agent=main")
        self.assertEqual(status, 200, out)
        self.assertEqual((out["ok"], out["reason"], out["sessions"]), (False, "offline", []))


class CanForOneChat(GatesBase):
    def test_can_reads_the_prefs_of_the_chat_named_by_session(self):
        self.save_lab()
        self.lab_row()
        asked = []
        prefs = {"s2": {"model": "m-two", "effort": "high"}}

        def can(agent, key=None, *, manage=False):
            asked.append(key)
            return {"ok": True, "caps": {"models": True, "effort": True}, "prefs": dict(prefs.get(key) or {})}
        with mock.patch.object(self.hermes, "can", can):
            out = self.request("GET", "/api/agent-chat/can?agent=hermes-lab&session=s2")[1]
            self.assertEqual((out["ok"], out["prefs"]), (True, {"model": "m-two", "effort": "high"}))
            out = self.request("GET", "/api/agent-chat/can?agent=hermes-lab")[1]
            self.assertEqual(out["prefs"], {})
            self.request("GET", "/api/agent-chat/can?agent=hermes-lab&session=" + "x" * 900)
        self.assertEqual(asked[:2], ["s2", None])  # no session -> None (the agent's next new chat)
        self.assertEqual(len(asked[2]), 400)  # clipped like every other route
        # agents on their own chat path ignore it (registry manifest, empty prefs)
        out = self.request("GET", "/api/agent-chat/can?agent=hermes-astra&session=s2")[1]
        self.assertEqual((out["transport"], out["prefs"]), ("hermes-api", {}))


def _field_keys(node, out=None):
    out = set() if out is None else out
    if isinstance(node, dict):
        if isinstance(node.get("key"), str) and "type" in node:
            out.add(node["key"])  # a top-level setting; a list field's own row fields (connections) are not
            return out
        for value in node.values():
            _field_keys(value, out)
    elif isinstance(node, list):
        for value in node:
            _field_keys(value, out)
    return out


class SetupSaveHermesKeys(GatesBase):
    RETIRED = ("apiUrl", "apiKey", "apiProfiles", "desktopUrl", "desktopToken", "desktopHostHeader", "desktopTcpHost",
               "desktopTcpPort", "desktopLogPath", "preferDesktop", "autoStartProfileApis", "autoStartDefaultApi",
               "apiProfilePortBase")

    def test_setup_save_keeps_what_the_provider_page_offers_and_drops_only_retired_keys(self):
        status, payload = self.request("GET", "/api/provider-settings?providerId=hermes")
        self.assertEqual(status, 200, payload)
        offered = _field_keys(payload)
        self.assertTrue({"homePath", "binary", "localProfilesEnabled"} <= offered, sorted(offered))
        self.assertEqual(offered & set(self.RETIRED), set())  # nothing retired is still offered
        cfg = json.loads(self.cfg_path.read_text())
        cfg["hermes"].update({"homePath": "/srv/hermes-home", "binary": "/opt/hermes/bin/hermes",
                              "localProfilesEnabled": True},
                             **{key: "old" for key in self.RETIRED if key != "apiKey"})
        self.cfg_path.write_text(json.dumps(cfg))
        status, out = self.request("POST", "/setup/save", {"hermes": {"enabled": True}})
        self.assertEqual(status, 200, out)
        saved = json.loads(self.cfg_path.read_text())["hermes"]
        self.assertEqual((saved.get("homePath"), saved.get("binary"), saved.get("localProfilesEnabled")),
                         ("/srv/hermes-home", "/opt/hermes/bin/hermes", True))
        self.assertEqual([key for key in self.RETIRED if key in saved], [])
        self.assertEqual([c["id"] for c in saved["connections"]], ["astra"])  # connections untouched
        # posted, they are accepted like on the provider page
        status, out = self.request("POST", "/setup/save", {"hermes": {"homePath": "/srv/other"}})
        self.assertEqual(status, 200, out)
        saved = json.loads(self.cfg_path.read_text())["hermes"]
        self.assertEqual((saved["homePath"], saved["binary"]), ("/srv/other", "/opt/hermes/bin/hermes"))


if __name__ == "__main__":
    import unittest
    unittest.main()
