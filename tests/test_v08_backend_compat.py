"""v0.8 backend: OpenClaw 2026.9 compatibility and crash fixes (BE-07, CH-08, CH-09,
DL-01, DL-02, DL-07, BE-31). Every test uses temp fixtures, never the real ~/.openclaw."""

import atexit
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-v08-compat-")
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

import discovery  # noqa: E402
import server  # noqa: E402
from providers import builtin  # noqa: E402
from providers.builtin import OpenClawOfficeProvider  # noqa: E402
from providers.hermes import HermesProvider  # noqa: E402

KEYED = {
    "agents": {
        "defaults": {"model": "openai/default-string", "models": {}},
        "entries": {
            "main": {"workspace": "/x/workspace", "model": {"primary": "anthropic/main", "fallbacks": ["openai/fb", "gone/fb"]}},
            "helper": {"id": "stale-id", "workspace": "/x/workspace-helper", "model": "gone/helper-model"},
            "plain": {"workspace": "/x/workspace-plain"},
        },
    }
}
LEGACY = {
    "agents": {
        "defaults": {"model": {"primary": "openai/legacy-default"}},
        "list": [{"id": "legacy", "model": "openai/legacy", "default": True}, {"id": "other"}],
    }
}


class ModelHelperTests(unittest.TestCase):
    def test_model_ref_accepts_string_and_object(self):
        self.assertEqual("a/b", server._model_ref_primary("a/b"))
        self.assertEqual("a/b", server._model_ref_primary({"primary": "a/b", "fallbacks": []}))
        self.assertEqual("", server._model_ref_primary(None))
        self.assertEqual("", server._model_ref_primary({"fallbacks": []}))

    def test_default_model_id_for_both_shapes(self):
        self.assertEqual("openai/default-string", server._default_model_id(KEYED))
        self.assertEqual("openai/legacy-default", server._default_model_id(LEGACY))
        self.assertEqual("", server._default_model_id({}))
        self.assertEqual("", server._default_model_id({"agents": "broken"}))

    def test_iter_entries_key_wins_over_stale_id(self):
        ids = [agent_id for agent_id, _ in server._iter_openclaw_agent_entries(KEYED)]
        self.assertEqual(["main", "helper", "plain"], ids)
        legacy_ids = [agent_id for agent_id, _ in server._iter_openclaw_agent_entries(LEGACY)]
        self.assertEqual(["legacy", "other"], legacy_ids)

    def test_rows_normalize_model_to_string(self):
        rows = {row["id"]: row for row in server._openclaw_agent_rows(KEYED)}
        self.assertEqual("anthropic/main", rows["main"]["model"])
        self.assertEqual("gone/helper-model", rows["helper"]["model"])
        self.assertEqual("", rows["plain"]["model"])

    def test_runtime_default_prefers_default_flag_then_main(self):
        self.assertEqual("openai/legacy", server._default_openclaw_model(LEGACY))
        self.assertEqual("anthropic/main", server._default_openclaw_model(KEYED))

    def test_config_models_and_native_fallback_do_not_crash_on_string_default(self):
        models = server._read_openclaw_config_models(json.loads(json.dumps(KEYED)))
        self.assertEqual("openai/default-string", models[0]["id"])
        with mock.patch.object(server, "_load_openclaw_model_config", return_value=json.loads(json.dumps(KEYED))), \
                mock.patch.object(server, "_read_openclaw_auth_profiles", return_value=[]):
            result = server._get_openclaw_native_fallback("test", "main")
        self.assertTrue(result["ok"])
        self.assertEqual("openai/default-string", result["defaultModel"])
        self.assertEqual("anthropic/main", result["agents"]["main"]["model"])
        self.assertEqual("", result["agents"]["plain"]["model"])

    def test_set_entry_model_keeps_fallback_object(self):
        cfg = json.loads(json.dumps(KEYED))
        entries = cfg["agents"]["entries"]
        server._set_openclaw_entry_model(entries["main"], "openai/new")
        self.assertEqual({"primary": "openai/new", "fallbacks": ["openai/fb", "gone/fb"]}, entries["main"]["model"])
        server._set_openclaw_entry_model(entries["plain"], "openai/plain")
        self.assertEqual("openai/plain", entries["plain"]["model"])
        server._set_openclaw_entry_model(entries["plain"], "")
        self.assertNotIn("model", entries["plain"])


class ConfigWriteTests(unittest.TestCase):
    """Handlers that write openclaw.json, run against a temp file."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-v08-cfg-")
        self.config = Path(self.temp.name) / "openclaw.json"
        self.config.write_text(json.dumps(KEYED), encoding="utf-8")
        self.patches = [
            mock.patch.object(server, "CONFIG_PATH", str(self.config)),
            mock.patch.object(server.OfficeHandler, "_signal_gateway", staticmethod(lambda restart=False: {"ok": True})),
        ]
        for patch in self.patches:
            patch.start()
        self.handler = server.OfficeHandler.__new__(server.OfficeHandler)

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def read(self):
        return json.loads(self.config.read_text(encoding="utf-8"))

    def test_set_model_writes_into_keyed_entries(self):
        result = self.handler._handle_set_model({"agent_id": "helper", "model": "openai/x"})
        self.assertTrue(result["ok"], result)
        self.assertEqual("openai/x", self.read()["agents"]["entries"]["helper"]["model"])
        result = self.handler._handle_set_model({"agent_id": "main", "model": "openai/y"})
        self.assertTrue(result["ok"], result)
        self.assertEqual("openai/y", self.read()["agents"]["entries"]["main"]["model"]["primary"])
        result = self.handler._handle_set_model({"agent_id": "missing", "model": "openai/y"})
        self.assertFalse(result["ok"])
        self.assertNotIn("list", self.read()["agents"])

    def test_delete_provider_cleans_entries_and_fallbacks(self):
        cfg = self.read()
        cfg.setdefault("models", {})["providers"] = {"gone": {"models": []}}
        cfg["agents"]["defaults"]["model"] = {"primary": "openai/d", "fallbacks": ["gone/z", "openai/q"]}
        self.config.write_text(json.dumps(cfg), encoding="utf-8")
        result = self.handler._handle_delete_custom_provider({"provider": "gone"})
        self.assertTrue(result["ok"], result)
        after = self.read()
        self.assertNotIn("model", after["agents"]["entries"]["helper"])
        self.assertEqual(["openai/fb"], after["agents"]["entries"]["main"]["model"]["fallbacks"])
        self.assertEqual(["openai/q"], after["agents"]["defaults"]["model"]["fallbacks"])

    def test_session_info_and_default_model_with_string_default(self):
        cfg = self.read()
        self.assertEqual("openai/default-string", self.handler._default_config_model(cfg))


class DiscoveryTests(unittest.TestCase):
    def test_discovery_reads_keyed_entries_and_cleans_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "agents" / "ghost" / "sessions").mkdir(parents=True)
            ws = root / "workspace-helper"
            ws.mkdir()
            (ws / "IDENTITY.md").write_text(
                '- **Name:** <img src=x onerror=alert(1)>Helper\n- **Emoji:** "><b>\n- **Creature:** Builder — x\n',
                encoding="utf-8",
            )
            (root / "openclaw.json").write_text(json.dumps({"agents": {"entries": {
                "helper": {"workspace": str(ws), "model": {"primary": "openai/h"}},
            }}}), encoding="utf-8")
            rows = discovery.discover_agents(str(root))
        self.assertEqual(["helper"], [row["id"] for row in rows])
        self.assertEqual("openai/h", rows[0]["model"])
        for field in ("name", "emoji", "role"):
            self.assertNotRegex(rows[0][field], r"[<>\"'`]")
        self.assertIn("Helper", rows[0]["name"])

    def test_provider_discovery_reads_keyed_entries_without_filesystem_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "agents" / "stale-agent" / "sessions").mkdir(parents=True)
            workspace = root / "workspace-main"
            workspace.mkdir()
            (root / "openclaw.json").write_text(json.dumps({
                "agents": {"entries": {"main": {"workspace": str(workspace), "model": {"primary": "openai/current"}}}}
            }), encoding="utf-8")
            rows = OpenClawOfficeProvider({"workspaceBase": str(root)}).discover_agents()
        self.assertEqual(["main"], [row["id"] for row in rows])
        self.assertEqual("openai/current", rows[0]["model"])

    def test_discovery_keeps_legacy_list(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "openclaw.json").write_text(json.dumps(LEGACY), encoding="utf-8")
            rows = discovery.discover_agents(str(root))
        self.assertEqual(["legacy", "other"], [row["id"] for row in rows])
        self.assertEqual("openai/legacy", rows[0]["model"])

    def test_deleted_openclaw_agents_are_not_resurrected_from_cache(self):
        live = [{"id": "main", "statusKey": "main", "providerKind": "openclaw", "name": "Main"}]
        cache = [
            {"id": "deleted", "statusKey": "deleted", "providerKind": "openclaw", "name": "Gone"},
            {"id": "hermes-x", "statusKey": "hermes-x", "providerKind": "hermes", "name": "<b>H</b>"},
        ]

        class FakeRegistry:
            def discover_agents(self):
                return [dict(row) for row in live]

            def manifests(self, include_health=False):
                return []

        saved = {}
        with mock.patch.object(server, "_get_provider_registry", return_value=FakeRegistry()), \
                mock.patch.object(server, "_hermes_platform_roster_agent", return_value=None), \
                mock.patch.object(server, "_load_discovery_cache", return_value=cache), \
                mock.patch.object(server, "_save_discovery_cache", side_effect=lambda rows: saved.setdefault("rows", rows)):
            rows = server._discover_roster()
        ids = {row["id"]: row for row in rows}
        self.assertIn("main", ids)
        self.assertNotIn("deleted", ids)
        self.assertIn("hermes-x", ids)
        self.assertFalse(ids["hermes-x"]["available"])
        self.assertEqual("bH/b", ids["hermes-x"]["name"])


class AgentCreateTests(unittest.TestCase):
    def test_template_only_has_bootstrap_files_openclaw_accepts(self):
        files = server._agent_template_files("Ann", "Helper", "A")
        self.assertEqual({"IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md", "MEMORY.md"}, set(files))
        self.assertIn("## Tools", files["AGENTS.md"])

    def test_failed_file_write_rolls_back_agent(self):
        calls = []

        def fake_rpc(method, params=None, timeout=20, preserve_envelope=False):
            calls.append(method)
            if method == "agents.create":
                return {"ok": True, "agentId": "ann"}
            if method == "agents.list":
                return {"ok": True, "agents": [{"id": "main"}, {"id": "ann"}]}
            if method == "agents.files.set" and params.get("name") == "USER.md":
                return {"ok": False, "error": 'unsupported file "USER.md"'}
            return {"ok": True}

        removed = []
        with mock.patch.object(server, "_gateway_rpc_call", side_effect=fake_rpc), \
                mock.patch.object(server, "_default_openclaw_agent_model", return_value=""), \
                mock.patch.object(server, "_remove_openclaw_agent_paths", side_effect=removed.append):
            result = server._legacy_openclaw_agent_create({"name": "Ann"})
        self.assertTrue(result.get("rolledBack"), result)
        self.assertEqual(500, result["_status"])
        self.assertIn("agents.delete", calls)
        self.assertEqual(["ann"], removed)

    def test_files_wait_until_openclaw_lists_the_new_agent(self):
        # OpenClaw applies agents.create a moment after it answers: files.set before that is 'agent "ann" not found'.
        calls, lists = [], {"n": 0}

        def fake_rpc(method, params=None, timeout=20, preserve_envelope=False):
            calls.append(method)
            if method == "agents.create":
                return {"ok": True, "agentId": "ann"}
            if method == "agents.list":
                lists["n"] += 1
                return {"ok": True, "agents": [{"id": "main"}] + ([{"id": "ann"}] if lists["n"] >= 3 else [])}
            if method == "agents.files.set" and lists["n"] < 3:
                return {"ok": False, "error": 'agent "ann" not found'}
            return {"ok": True}

        with mock.patch.object(server, "_gateway_rpc_call", side_effect=fake_rpc), \
                mock.patch.object(server, "_default_openclaw_agent_model", return_value=""), \
                mock.patch.object(server, "_pl_sync_openclaw_agents"), \
                mock.patch.object(server, "refresh_agent_maps"), \
                mock.patch.object(server.time, "sleep"):
            result = server._legacy_openclaw_agent_create({"name": "Ann"})
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(3, lists["n"])
        # (0.12: first the gateway is asked where its folder is, config.get, when nothing else says it)
        self.assertEqual(["config.get", "agents.create", "agents.list", "agents.list", "agents.list", "agents.files.set"], calls[:6])
        self.assertNotIn("agents.delete", calls)


class IdentityRegexTests(unittest.TestCase):
    def test_builtin_identity_update_keeps_backslashes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "IDENTITY.md"
            path.write_text("# IDENTITY.md\n\n- **Name:** Old\n- **Role:** Dev\n", encoding="utf-8")
            self.assertTrue(builtin._update_identity_file(str(path), {"name": r"C:\Users\bob"}))
            text = path.read_text(encoding="utf-8")
        self.assertIn(r"- **Name:** C:\Users\bob", text)
        self.assertIn("- **Role:** Dev", text)

    def test_hermes_partial_edit_keeps_existing_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            profile = home / "profiles" / "ops"
            profile.mkdir(parents=True)
            (profile / "IDENTITY.md").write_text(
                "# IDENTITY.md\n\n- **Name:** Opsy\n- **Creature:** Night shift — Hermes profile\n- **Emoji:** 🌙\n",
                encoding="utf-8",
            )
            provider = HermesProvider.__new__(HermesProvider)
            provider.home_path = str(home)
            provider.binary = ""
            provider._binary_problem = lambda: "no binary"
            provider._atomic_owned_text = lambda path, text, owner_root: Path(path).write_text(text, encoding="utf-8")
            result = provider.update_profile_at_home(str(profile), "ops", {"emoji": "⭐"})
            text = (profile / "IDENTITY.md").read_text(encoding="utf-8")
        self.assertTrue(result["ok"], result)
        self.assertIn("- **Name:** Opsy", text)
        self.assertIn("- **Creature:** Night shift — Hermes profile", text)
        self.assertIn("- **Emoji:** ⭐", text)


if __name__ == "__main__":
    unittest.main()
