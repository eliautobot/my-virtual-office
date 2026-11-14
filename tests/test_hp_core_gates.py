"""C3 acceptance (design 2.7, 3.6, 3.8, 5.2 "C3 hp-core"): the census of the office's own OpenClaw write paths, each
refused under Chat only with the 3.6 text; agent tokens refused; the menu write gate (F + R 10 minutes + audit line
without params); legacy Hermes under Chat only reads but never writes its files; secrets never reach the server log;
the two old settings writers keep agent-providers.json and never take a `hermes serve` row.

Nothing here reaches a real gateway or home: every refusal happens before any write, and the one allowed path
(proxy cron.add under Full access) runs against a patched gateway call.
"""
from __future__ import annotations

import io
import json
import os
import stat
import sys
import time
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))

import test_hp_core_routes as base  # noqa: E402  (sets the env + paths, then imports server)
from test_hp_core_routes import RoutesBase  # noqa: E402

import agent_providers as ap  # noqa: E402
import provider_secrets  # noqa: E402
import server  # noqa: E402
import vo_access  # noqa: E402
from providers import builtin  # noqa: E402

OPENCLAW_AGENT = {"id": "ops", "statusKey": "ops", "providerKind": "openclaw", "providerAgentId": "ops",
                  "available": True, "capabilities": {"skills": True, "resourcesWrite": True}}
LEGACY_AGENT = {"id": "hermes-astra", "statusKey": "hermes-astra", "providerKind": "hermes",
                "providerConnectionId": "astra", "providerAgentId": "astra",
                "capabilities": {"skills": True, "resourcesWrite": True}}
SKILL_ROOT = {"id": "workspace", "path": "/nonexistent/skills", "writable": True}

# The census (design 2.7): (method, path, body, area). Every one is refused before it writes anything.
CENSUS = [
    ("POST", "/api/agent/create", {"name": "Scout", "providerKind": "openclaw"}, "settings"),
    ("DELETE", "/api/agent/delete", {"id": "ops"}, "settings"),
    ("POST", "/agent-bio-save/ops", {"filename": "SOUL.md", "content": "x"}, "files"),
    ("POST", "/set-model", {"agent": "ops", "model": "openai/gpt-x"}, "settings"),
    ("POST", "/api/native-models/openclaw/agent-model", {"agent": "ops", "model": "openai/gpt-x"}, "settings"),
    ("POST", "/api/native-models/openclaw/auth/api-key", {"provider": "openai", "apiKey": "sk-test-123456"}, "settings"),
    ("POST", "/api/native-models/openclaw/auth/delete", {"provider": "openai"}, "settings"),
    ("POST", "/api/native-models/openclaw/auth/sync-static", {"provider": "openai"}, "settings"),
    ("POST", "/api/native-models/openclaw/auth/reset-overrides", {"agent": "ops", "provider": "openai"}, "settings"),
    ("POST", "/api/native-models/openclaw/provider", {"provider": "lab", "baseUrl": "http://x:1"}, "settings"),
    ("POST", "/api/native-models/openclaw/provider/delete", {"provider": "lab"}, "settings"),
    ("POST", "/config/providers/save-key", {"provider": "openai", "key": "sk-test-123456"}, "settings"),
    ("POST", "/config/providers/delete-key", {"provider": "openai"}, "settings"),
    ("POST", "/config/providers/save-custom", {"provider": "lab", "baseUrl": "http://x:1"}, "settings"),
    ("POST", "/api/gateway/configure", {"origin": "http://office.example:8095"}, "settings"),
    ("POST", "/api/agent/ops/skills/my-skill", {"content": "---\nname: my-skill\n---\n"}, "settings"),
    ("DELETE", "/api/agent/ops/skills/my-skill", None, "settings"),
    ("POST", "/api/skills-workshop/action", {"action": "apply", "proposalId": "p1", "agentId": "ops"}, "settings"),
]
PROXY_WRITES = ["cron.add", "cron.update", "cron.remove", "cron.run"]


class GatesBase(RoutesBase):
    def setUp(self):
        super().setUp()
        self.agents = {"ops": OPENCLAW_AGENT, "hermes-astra": LEGACY_AGENT}
        extra = [
            mock.patch.object(server, "_office_agent_lookup", lambda key: dict(self.agents[key])
                              if key in self.agents else None),
            mock.patch.object(server, "_agent_skill_roots", lambda key: ([dict(SKILL_ROOT)], dict(self.agents[key]))
                              if key in self.agents else ([], None)),
            mock.patch.object(server, "refresh_agent_maps", lambda *a, **k: None),
            mock.patch.dict(server.AGENT_WORKSPACES, {"ops": "workspace-ops"}),
            mock.patch.object(server, "_gateway_rpc_call", self._no_gateway),
        ]
        for p in extra:
            p.start()
        self.patches.extend(extra)
        self.gateway_calls = []

    def _no_gateway(self, method, params=None, **kwargs):
        self.gateway_calls.append(method)
        return {"ok": True, "result": {}}

    def openclaw_access(self, level):
        ap._store().update(lambda d: d["openclaw"].update(access=level))

    def legacy_access(self, cid, level):
        ap._store().update(lambda d: d["legacy"][cid].update(access=level))

    def assert_chat_only(self, status, out, kind="openclaw", area="settings", label=""):
        self.assertEqual(status, 403, (label, out))
        self.assertEqual(out["error"], "chat_only", label)
        self.assertEqual(out["message"], ap.chat_only_reason(kind, area), label)
        self.assertEqual(out["fix"], ap.FIX_FULL_ACCESS, label)


class OpenClawCensus(GatesBase):
    def test_every_listed_write_is_refused_under_chat_only_with_the_text(self):
        self.openclaw_access("chat")
        before = sorted(os.listdir(self.status))
        for method, path, body, area in CENSUS:
            status, out = self.request(method, path, body)
            self.assert_chat_only(status, out, "openclaw", area, f"{method} {path}")
        self.assertEqual(self.gateway_calls, [])
        self.assertEqual(sorted(os.listdir(self.status)), before)  # nothing written
        for name in PROXY_WRITES:
            out = server._handle_openclaw_proxy_rpc({"method": name, "params": {"id": "job-1"}})
            self.assertEqual(out["_status"], 403, name)
            self.assertEqual((out["error"]["code"], out["error"]["message"]),
                             ("chat_only", ap.chat_only_reason("openclaw", "settings")), name)
        self.assertEqual(self.gateway_calls, [])
        # Reads and chat stay open under Chat only.
        for name in ("cron.list", "cron.status", "chat.history"):
            self.assertTrue(server._handle_openclaw_proxy_rpc({"method": name, "params": {}})["ok"], name)
        self.assertEqual(self.gateway_calls, ["cron.list", "cron.status", "chat.history"])

    def test_full_access_lets_the_same_paths_through_the_gate(self):
        self.openclaw_access("full")
        out = server._handle_openclaw_proxy_rpc({"method": "cron.add", "params": {"name": "x"}})
        self.assertTrue(out["ok"], out)
        self.assertEqual(self.gateway_calls, ["cron.add"])
        server._hp_require_full("openclaw")  # no raise
        server._hp_require_full_for_agent(OPENCLAW_AGENT)
        # A skill write gets past the gate to the provider's own check (here: the fake root is not on disk).
        status, out = self.request("DELETE", "/api/agent/ops/skills/my-skill")
        self.assertNotEqual(out.get("error"), "chat_only", out)
        self.assertNotEqual(status, 403, out)

    def test_agent_token_is_refused_on_provider_writes(self):
        self.save_lab()
        self.store.set_passcode("open-sesame")
        auth = {"Authorization": f"Bearer {self.store.agent_token()}"}
        with mock.patch.object(vo_access, "is_loopback_ip", return_value=False):
            for path, body in (("/api/agent-providers/call", {"id": "lab", "method": "config.patch", "params": {}}),
                               ("/api/agent-providers/call", {"id": "openclaw", "method": "agents.update",
                                                              "params": {}}),
                               ("/api/agent-providers/save", {"kind": "hermes", "transport": "serve",
                                                              "values": {"name": "X"}}),
                               ("/api/agent-providers/remove", {"id": "lab"}),
                               ("/api/access/confirm", {"passcode": "open-sesame"})):
                status, out = self.request("POST", path, body, headers=auth)
                self.assertEqual((status, out["error"]), (403, "forbidden"), path)
                if path != "/api/access/confirm":
                    self.assertEqual(out["message"], ap.FORBIDDEN_TEXT)
        self.assertFalse((self.status / ap.AUDIT_FILE).exists())


class MenuGate(GatesBase):
    def audit_lines(self):
        path = self.status / ap.AUDIT_FILE
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_menu_write_needs_full_access_is_audited_without_params(self):
        self.save_lab()
        status, out = self.request("POST", "/api/agent-providers/call",
                                   {"id": "lab", "method": "config.patch", "params": {"changes": {"k": "zz-secret"}}})
        self.assertEqual(status, 200, out)
        lines = self.audit_lines()
        self.assertEqual([(x["connection"], x["kind"], x["method"]) for x in lines], [("lab", "hermes", "config.patch")])
        self.assertEqual(set(lines[0]), {"at", "connection", "kind", "method"})
        self.assertNotIn("zz-secret", (self.status / ap.AUDIT_FILE).read_text())
        self.assertEqual(stat.S_IMODE(os.stat(self.status / ap.AUDIT_FILE).st_mode), 0o600)
        status, out = self.request("POST", "/api/agent-providers/call", {"id": "lab", "method": "skills.list"})
        self.assertEqual(status, 200, out)
        self.assertEqual(len(self.audit_lines()), 1)  # reads are not audited
        ap._store().update(lambda d: ap.find_connection("lab", d).update(access="chat"))
        for method in ap.MANIFESTS["hermes"]["menuWrite"]:
            status, out = self.request("POST", "/api/agent-providers/call", {"id": "lab", "method": method})
            self.assert_chat_only(status, out, "hermes", "settings", method)
        self.openclaw_access("chat")
        for method in ap.MANIFESTS["openclaw"]["menuWrite"]:
            status, out = self.request("POST", "/api/agent-providers/call", {"id": "openclaw", "method": method})
            self.assert_chat_only(status, out, "openclaw", "settings", method)
        self.assertEqual(len(self.audit_lines()), 1)  # refusals write no audit line

    def test_recent_passcode_window_is_ten_minutes(self):
        self.save_lab()
        self.store.set_passcode("open-sesame")
        session = self.store.create_session()
        cookie = {"Cookie": f"{vo_access.SESSION_COOKIE}={session}"}
        call = {"id": "lab", "method": "model.default", "params": {"profile": "default", "model": "m"}}
        clock = [int(time.time())]
        with mock.patch.object(vo_access, "is_loopback_ip", return_value=False), \
                mock.patch.object(vo_access, "_now", lambda: clock[0]):
            status, out = self.request("POST", "/api/agent-providers/call", call, headers=cookie)
            self.assertEqual((status, out["error"], out["message"]), (403, "reauth_required", ap.REAUTH_TEXT))
            status, out = self.request("POST", "/api/agent-providers/call", {"id": "lab", "method": "skills.list"},
                                       headers=cookie)
            self.assertEqual(status, 200, out)  # reads need no passcode
            status, out = self.request("POST", "/api/access/confirm", {"passcode": "wrong"}, headers=cookie)
            self.assertEqual((status, out["error"]), (401, "bad_passcode"))
            status, out = self.request("POST", "/api/access/confirm", {"passcode": "open-sesame"}, headers=cookie)
            self.assertEqual(status, 200, out)
            self.assertEqual(out["until"], clock[0] + 600)
            clock[0] += 599
            status, out = self.request("POST", "/api/agent-providers/call", call, headers=cookie)
            self.assertEqual(status, 200, out)
            clock[0] += 2
            status, out = self.request("POST", "/api/agent-providers/call", call, headers=cookie)
            self.assertEqual((status, out["error"]), (403, "reauth_required"))
        self.assertEqual([x["method"] for x in self.audit_lines()], ["model.default"])


class LegacyAndLogs(GatesBase):
    def test_legacy_chat_only_reads_but_never_writes_its_files(self):
        self.assertEqual(builtin._chat_only_resources("astra", "read-write"), "read-write")
        self.legacy_access("astra", "chat")
        self.assertEqual(builtin._chat_only_resources("astra", "read-write"), "read-only")
        self.assertEqual(builtin._chat_only_resources("astra", "disabled"), "disabled")
        self.assertEqual(builtin._chat_only_resources("not-migrated-yet", "read-write"), "read-write")
        self.assertEqual(ap.agent_access("hermes", "astra"), "chat")
        for method, path in (("POST", "/api/agent/hermes-astra/skills/my-skill"),
                             ("DELETE", "/api/agent/hermes-astra/skills/my-skill")):
            status, out = self.request(method, path, {"content": "x"} if method == "POST" else None)
            self.assert_chat_only(status, out, "hermes", "settings", path)
        self.legacy_access("astra", "full")
        status, out = self.request("DELETE", "/api/agent/hermes-astra/skills/my-skill")
        self.assertNotEqual(out.get("error"), "chat_only", out)

    def test_secrets_never_reach_the_server_log(self):
        self.save_lab()  # stores LAB_TOKEN in the secret store; vo-config holds apiKey "legacy-key"
        server._HP_LOG_SECRETS["at"] = 0.0
        buf = io.StringIO()
        stream = server._RedactingStream(buf)
        with mock.patch.object(sys, "stderr", stream):
            self.request("GET", "/api/agent-chat/media?t=abcdef0123456789.sig")
            self.request("GET", f"/api/hermes/nope?token={base.LAB_TOKEN}&x=1")
            print(f"[hermes-link] failed with token {base.LAB_TOKEN} and key legacy-key", file=sys.stderr)
            print("Authorization: Bearer sk-live-abcdefgh12345", file=sys.stderr)
        text = buf.getvalue()
        for secret in (base.LAB_TOKEN, "legacy-key", "abcdef0123456789", "sk-live-abcdefgh12345"):
            self.assertNotIn(secret, text)
        self.assertIn("/api/agent-chat/media?t=[redacted]", text)
        self.assertIn(provider_secrets.REDACTED, text)
        self.assertIn("x=1", text)  # other query values stay readable
        self.assertEqual(stream.encoding, buf.encoding)  # everything else is the real stream's

    def test_old_settings_writers_keep_agent_providers_and_take_no_serve_rows(self):
        self.save_lab()
        store_file = self.status / "agent-providers.json"
        before = store_file.read_bytes()
        rows = [{"id": "astra", "name": "Astra", "apiUrl": "http://127.0.0.1:8642", "apiKey": ""},
                {"id": "beta", "name": "Beta", "apiUrl": "http://127.0.0.1:8643", "apiKey": "beta-key-1"},
                {"id": "lab", "name": "Lab", "apiUrl": "http://127.0.0.1:19128"},
                {"id": "sneaky", "name": "Sneaky", "url": "http://127.0.0.1:9119", "auth": "token"},
                {"id": "serve2", "name": "Serve", "transport": "serve", "apiUrl": "http://127.0.0.1:9119"}]
        status, out = self.request("POST", "/api/provider-settings/save",
                                   {"providerId": "hermes", "values": {"connections": rows}})
        self.assertEqual(status, 200, out)
        saved = json.loads(self.cfg_path.read_text())["hermes"]["connections"]
        self.assertEqual([c["id"] for c in saved], ["astra", "beta"])
        self.assertEqual(saved[0]["apiKey"], "legacy-key")  # blank keeps the key
        self.assertEqual(store_file.read_bytes(), before)
        status, out = self.request("POST", "/setup/save", {"hermes": {"connections": rows + [
            {"id": "gamma", "name": "Gamma", "apiUrl": "http://127.0.0.1:8644"}]}})
        self.assertEqual(status, 200, out)
        saved = json.loads(self.cfg_path.read_text())["hermes"]["connections"]
        self.assertEqual([c["id"] for c in saved], ["astra", "beta", "gamma"])
        self.assertEqual(store_file.read_bytes(), before)
        self.assertEqual(stat.S_IMODE(os.stat(store_file).st_mode), 0o600)
        self.assertEqual([c["id"] for c in ap.load()["connections"]], ["lab"])


if __name__ == "__main__":
    import unittest
    unittest.main()
