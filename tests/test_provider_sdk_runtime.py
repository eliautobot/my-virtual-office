import json
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock


PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_ROOT = os.path.join(PROJECT_ROOT, "app")
if APP_ROOT not in sys.path:
    sys.path.insert(0, APP_ROOT)

import server  # noqa: E402
from providers.codex import CodexProvider  # noqa: E402
from providers.builtin import HermesOfficeProvider, OpenClawOfficeProvider  # noqa: E402
from providers.hermes import HermesProvider  # noqa: E402
from providers.registry import ProviderManifest  # noqa: E402


class ProviderSdkRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.status_patch = mock.patch.object(server, "STATUS_DIR", self.temp_dir.name)
        self.status_patch.start()

    def tearDown(self):
        self.status_patch.stop()
        self.temp_dir.cleanup()

    def test_all_builtin_manifests_declare_settings(self):
        expected = {"openclaw", "hermes", "codex", "claude-code", "opencode", "antigravity"}
        manifests = {row["id"]: row for row in server._get_provider_registry().manifests()}
        self.assertTrue(expected.issubset(manifests))
        for provider_id in expected:
            schema = manifests[provider_id].get("settingsSchema") or {}
            self.assertEqual(schema.get("version"), 1)
            self.assertTrue(schema.get("configKey"))
            self.assertTrue(schema.get("sections"))
        self.assertEqual(manifests["claude-code"]["settingsSchema"]["configKey"], "claudeCode")
        self.assertEqual(manifests["opencode"]["settingsSchema"]["configKey"], "openCode")

    def test_creation_schemas_match_provider_native_id_and_custom_directory_behavior(self):
        manifests = {row["id"]: row for row in server._get_provider_registry().manifests()}
        openclaw_fields = {
            row["id"]: row for row in manifests["openclaw"]["creationSchema"]["fields"]
        }
        self.assertNotIn("id", openclaw_fields)
        for provider_id in ("codex", "claude-code", "opencode", "antigravity"):
            fields = {
                row["id"]: row for row in manifests[provider_id]["creationSchema"]["fields"]
            }
            self.assertIn("id", fields)
            self.assertEqual(fields["customDirectory"]["showWhen"], {"creationMode": "custom"})
            self.assertTrue(fields["customDirectory"]["required"])

    def test_openclaw_gateway_paths_translate_across_container_mounts(self):
        local_home = os.path.join(self.temp_dir.name, "openclaw-mount")
        local_workspace = os.path.join(local_home, "workspace")
        os.makedirs(local_workspace)
        with open(os.path.join(local_home, "openclaw.json"), "w", encoding="utf-8") as handle:
            json.dump({
                "agents": {
                    "list": [{
                        "id": "main",
                        "workspace": "/host/user/.openclaw/workspace",
                    }]
                }
            }, handle)

        with mock.patch.object(server, "WORKSPACE_BASE", local_home), \
             mock.patch.dict(os.environ, {"VO_OPENCLAW_GATEWAY_PATH": ""}):
            gateway_home = server._openclaw_gateway_home_path()
        self.assertEqual(gateway_home, "/host/user/.openclaw")

        provider = OpenClawOfficeProvider({
            "workspaceBase": local_home,
            "gatewayWorkspaceBase": gateway_home,
        })
        agents = provider.discover_agents()
        self.assertEqual(agents[0]["workspace"], local_workspace)

    def test_secret_redaction_and_preservation(self):
        secret = {"token": "TOP_SECRET", "nested": {"apiKey": "KEY"}}
        redacted = server._redact_provider_secrets(secret)
        self.assertNotIn("TOP_SECRET", json.dumps(redacted))
        self.assertNotIn("KEY", json.dumps(redacted))
        self.assertTrue(redacted["tokenConfigured"])
        field = {"key": "apiKey", "type": "secret"}
        self.assertEqual(server._validate_provider_setting(field, "", "existing"), "existing")

    def test_main_hermes_save_retains_mounted_profile_metadata_and_api_key(self):
        existing = {
            "connections": [{
                "id": "primary",
                "name": "Old name",
                "apiUrl": "http://old.invalid:8642",
                "apiKey": "existing-secret",
                "resourcePath": "/data/hermes",
                "resourceAccess": "read-only",
                "emoji": "H",
                "role": "Existing role",
                "enabled": True,
            }],
        }
        incoming = [{
            "id": "primary",
            "name": "Updated name",
            "apiUrl": "http://new.invalid:8642",
            "apiKey": "",
            "apiKeyConfigured": True,
            "enabled": True,
        }]

        merged = server._merge_hermes_connection_updates(existing, incoming)

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["name"], "Updated name")
        self.assertEqual(merged[0]["apiUrl"], "http://new.invalid:8642")
        self.assertEqual(merged[0]["apiKey"], "existing-secret")
        self.assertEqual(merged[0]["resourcePath"], "/data/hermes")
        self.assertEqual(merged[0]["resourceAccess"], "read-only")
        self.assertEqual(merged[0]["emoji"], "H")
        self.assertEqual(merged[0]["role"], "Existing role")
        self.assertNotIn("apiKeyConfigured", merged[0])

    def test_mounted_default_profile_and_api_alias_are_one_canonical_hermes_agent(self):
        hermes_home = os.path.join(self.temp_dir.name, "hermes-home")
        os.makedirs(hermes_home)
        local = {
            "id": "hermes-default",
            "statusKey": "hermes-default",
            "providerAgentId": "default",
            "profile": "default",
            "name": "Local default",
            "workspace": hermes_home,
            "home": hermes_home,
            "connectionModes": ["cli"],
            "cliAvailable": True,
            "apiAvailable": False,
        }
        api = {
            "id": "hermes-primary",
            "statusKey": "hermes-primary",
            "providerAgentId": "primary",
            "profile": "primary",
            "connectionId": "primary",
            "name": "Primary API",
            "connectionModes": ["api"],
            "cliAvailable": False,
            "apiAvailable": True,
            "capabilityOverrides": {"sessions": True, "sessionSwitch": True},
        }
        native = mock.Mock()
        native.discover_agents.return_value = [local]
        native.is_available.return_value = True
        native.inspect_mounted_profile.side_effect = lambda profile, **kwargs: HermesProvider.inspect_mounted_profile(profile, **kwargs)
        manifest = ProviderManifest(
            id="hermes",
            name="Hermes",
            capabilities={"discover": True, "chat": True, "sessions": True, "resourcesRead": True, "resourcesWrite": True},
        )
        context = {"config": {"hermes": {
            "enabled": True,
            "localProfilesEnabled": True,
            "resourceRoot": hermes_home,
            "resourceAccess": "read-write",
            "connections": [{
                "id": "primary",
                "apiUrl": "http://hermes.invalid:8642",
                "apiKey": "configured",
                "resourcePath": hermes_home,
                "resourceAccess": "inherit",
                "enabled": True,
            }],
        }}}
        with mock.patch("providers.builtin.discover_api_connections", return_value=[api]):
            rows = HermesOfficeProvider(native, context, manifest).discover_agents()

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["id"], "hermes-primary")
        self.assertEqual(row["profile"], "primary")
        self.assertEqual(row["connectionId"], "primary")
        self.assertEqual(row["localProfile"], "default")
        self.assertEqual(row["connectionModes"], ["cli", "api"])
        self.assertEqual(row["workspace"], hermes_home)
        self.assertTrue(row["resourcesReadable"])
        self.assertTrue(row["resourcesWritable"])
        self.assertIn("hermes-default", row["selectionAliases"])
        self.assertIn("hermes-primary", row["selectionAliases"])

        office_rows = [
            {"key": "main", "providerKind": "openclaw"},
            {"key": row["id"], "providerKind": "hermes"},
            {"key": "codex-main", "providerKind": "codex"},
            {"key": "hermes-secondary", "providerKind": "hermes"},
        ]
        with mock.patch.object(server, "get_agent_limit", return_value=3):
            balanced = server._apply_agent_limit_balanced(office_rows)
        self.assertEqual([item["key"] for item in balanced], ["main", "hermes-primary", "codex-main"])

    def test_named_api_connection_merges_with_matching_default_profile_without_resource_path(self):
        hermes_home = os.path.join(self.temp_dir.name, "hermes-astra-home")
        os.makedirs(hermes_home)
        local = {
            "id": "hermes-default", "statusKey": "hermes-default",
            "providerAgentId": "default", "profile": "default", "name": "Astra",
            "workspace": hermes_home, "home": hermes_home,
            "connectionModes": ["cli"], "cliAvailable": True, "apiAvailable": False,
        }
        api = {
            "id": "hermes-astra", "statusKey": "hermes-astra",
            "providerAgentId": "astra", "profile": "astra", "connectionId": "astra",
            "name": "Astra", "connectionModes": ["api"],
            "cliAvailable": False, "apiAvailable": True,
            "capabilityOverrides": {"streaming": True, "tools": True, "interrupt": True},
        }
        native = mock.Mock()
        native.discover_agents.return_value = [local]
        native.is_available.return_value = True
        native.inspect_mounted_profile.side_effect = lambda profile, **kwargs: HermesProvider.inspect_mounted_profile(profile, **kwargs)
        manifest = ProviderManifest(
            id="hermes", name="Hermes",
            capabilities={"discover": True, "chat": True, "sessions": True, "resourcesRead": True, "resourcesWrite": True},
        )
        context = {"config": {"hermes": {
            "enabled": True, "localProfilesEnabled": True,
            "resourceRoot": hermes_home, "resourceAccess": "read-write",
            "connections": [{
                "id": "astra", "name": "Astra", "apiUrl": "http://hermes.invalid:8642",
                "apiKey": "configured", "resourcePath": "", "enabled": True,
            }],
        }}}
        with mock.patch("providers.builtin.discover_api_connections", return_value=[api]):
            rows = HermesOfficeProvider(native, context, manifest).discover_agents()

        self.assertEqual(1, len(rows))
        row = rows[0]
        self.assertEqual("hermes-astra", row["id"])
        self.assertEqual("default", row["localProfile"])
        self.assertEqual(["cli", "api"], row["connectionModes"])
        self.assertTrue(row["apiAvailable"])
        self.assertIn("hermes-default", row["selectionAliases"])
        self.assertIn("hermes-astra", row["selectionAliases"])

    def test_agent_limit_prefers_api_hermes_over_cli_only_alias(self):
        agents = [
            {"key": "main", "providerKind": "openclaw", "available": True},
            {
                "key": "hermes-default", "providerKind": "hermes", "available": True,
                "apiAvailable": False, "connectionModes": ["cli"],
                "capabilities": {"streaming": False, "tools": False},
            },
            {
                "key": "hermes-astra", "providerKind": "hermes", "available": True,
                "apiAvailable": True, "connectionModes": ["api"],
                "capabilities": {"streaming": True, "tools": True},
            },
            {"key": "codex-main", "providerKind": "codex", "available": True},
        ]
        with mock.patch.object(server, "get_agent_limit", return_value=3):
            selected = server._apply_agent_limit_balanced(agents)
        self.assertEqual(["main", "hermes-astra", "codex-main"], [row["key"] for row in selected])

    def test_settings_validation_rejects_bad_url_and_unknown_select(self):
        with self.assertRaises(ValueError):
            server._validate_provider_setting({"type": "url"}, "file:///etc/passwd", None, "url")
        with self.assertRaises(ValueError):
            server._validate_provider_setting(
                {"type": "select", "options": [{"value": "safe"}]},
                "unsafe",
                None,
                "mode",
            )

    def test_active_session_flags_and_iso_timestamp_normalization(self):
        server._save_provider_active_session("opencode", "main", "session-b", source="test")
        server._save_provider_history("opencode", "main", [
            {"role": "assistant", "text": "old", "ts": "2026-06-24T03:58:00.194Z", "sessionId": "session-a"},
            {"role": "assistant", "text": "active", "ts": 1770000000000, "sessionId": "session-b"},
        ])
        with mock.patch.object(server, "get_roster", return_value=[]):
            messages = server.get_provider_agent_messages("opencode", "main")
        self.assertIsInstance(messages[0]["epochMs"], int)
        self.assertFalse(messages[0]["activeSession"])
        self.assertTrue(messages[1]["activeSession"])

    def test_progress_snapshot_replaces_in_place_then_settles(self):
        condition = threading.Condition()
        meta = {
            "runId": "run-1",
            "agentId": "agent-1",
            "agentName": "Agent One",
            "providerKind": "opencode",
            "profile": "main",
            "sessionId": "session-1",
            "sessionTitle": "Session One",
            "condition": condition,
            "events": [],
            "nextEventId": 1,
        }
        first = server._provider_progress_snapshot({"reply": "hel", "tools": [{"id": "t1", "name": "bash", "status": "running"}]}, meta)
        second = server._provider_progress_snapshot({"reply": "hello", "tools": [{"id": "t1", "name": "bash", "status": "done", "result": "ok"}]}, meta)
        server._save_provider_run_progress(meta, first)
        server._save_provider_run_progress(meta, second)
        history = server._load_provider_history("opencode", "main")
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["text"], "hello")
        self.assertEqual(history[0]["ephemeral"], "provider-progress")
        server._save_provider_run_progress(meta, second, terminal=True)
        history = server._load_provider_history("opencode", "main")
        self.assertEqual(len(history), 1)
        self.assertIsNone(history[0]["ephemeral"])
        self.assertEqual(history[0]["tools"][0]["result"], "ok")

    def test_run_events_are_retained_and_ordered(self):
        meta = {
            "runId": "run-2", "agentId": "agent-2", "providerKind": "opencode", "profile": "main",
            "condition": threading.Condition(), "events": [], "nextEventId": 1,
        }
        server._provider_run_emit(meta, "run.started", {})
        server._provider_run_emit(meta, "turn.progress", {"reply": "hi"})
        server._provider_run_emit(meta, "run.completed", {"reply": "hi"})
        self.assertEqual([row["id"] for row in meta["events"]], [1, 2, 3])
        self.assertEqual([row["event"] for row in meta["events"]], ["run.started", "turn.progress", "run.completed"])

    def test_registered_session_list_preserves_native_updated_timestamp(self):
        agent_ref = {
            "providerKind": "opencode",
            "profile": "main",
            "record": {"capabilities": {"sessions": True, "sessionDelete": True}},
        }
        outcome = {
            "ok": True,
            "sessions": [{
                "id": "ses-active",
                "title": "Active session",
                "updated": 1786052772650,
                "directory": "/data/opencode-main",
            }],
        }
        registry = mock.Mock()
        registry.invoke.return_value = outcome
        with mock.patch.object(server, "_get_provider_registry", return_value=registry):
            result = server._chat_sessions_list_registered_provider(agent_ref)
        self.assertEqual(result["sessions"][0]["updatedAt"], 1786052772650)

    def test_codex_external_login_clears_cached_auth_error_without_restart(self):
        home_path = os.path.join(self.temp_dir.name, "codex-home")
        os.makedirs(home_path)
        with mock.patch.dict(os.environ, {"VO_STATUS_DIR": self.temp_dir.name}):
            provider = CodexProvider(home_path=home_path, binary=sys.executable)
            provider._last_auth_error = "expired"
            with open(os.path.join(home_path, "auth.json"), "w", encoding="utf-8") as handle:
                json.dump({"tokens": {}}, handle)
            provider._sync_auth_error_state()
        self.assertEqual(provider._last_auth_error, "")

    def test_new_codex_session_marks_next_turn_as_fresh(self):
        agent_ref = {
            "agentId": "codex-test",
            "providerKind": "codex",
            "profile": "test",
        }
        with mock.patch.object(server, "_chat_sessions_agent", return_value=agent_ref), \
             mock.patch.object(server, "_save_codex_state"), \
             mock.patch.object(server, "_clear_codex_token_usage"), \
             mock.patch.object(server, "_save_provider_history"), \
             mock.patch.object(server, "_save_provider_active_session") as save_active:
            result, status = server.handle_chat_session_create("codex-test")
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        save_active.assert_called_once_with(
            "codex", "test", "", source="new-session", newSessionPending=True
        )

    def test_agent_delete_removes_provider_chat_and_active_session_state(self):
        provider_kind = "codex"
        profile = "delete-test"
        agent_id = "codex-delete-test"
        server._save_provider_history(provider_kind, profile, [{"role": "assistant", "text": "test"}])
        server._save_provider_active_session(provider_kind, profile, "session-test")

        registry = mock.Mock()
        registry.manifest.return_value = mock.Mock(
            name="Codex CLI",
            capabilities={"agentDelete": True},
        )
        registry.invoke.return_value = {"ok": True}
        agent = {
            "id": agent_id,
            "providerKind": provider_kind,
            "providerAgentId": profile,
        }
        with mock.patch.object(server, "_office_agent_lookup", return_value=agent), \
             mock.patch.object(server, "_get_provider_registry", return_value=registry), \
             mock.patch.object(server, "refresh_agent_maps"):
            result = server._handle_agent_delete({"id": agent_id})

        self.assertTrue(result["ok"])
        self.assertFalse(os.path.exists(server._provider_chat_history_path(provider_kind, profile)))
        self.assertFalse(os.path.exists(server._provider_active_session_path(provider_kind, profile)))

    def test_codex_thread_list_includes_external_sources_and_sorts_by_activity(self):
        provider = CodexProvider(home_path=self.temp_dir.name, binary=sys.executable)
        with mock.patch.object(provider, "_runtime_workspace", return_value=self.temp_dir.name), \
             mock.patch.object(provider, "_app_server_simple_request", return_value={"ok": True, "result": {"data": []}}) as request:
            result = provider.list_threads("test", limit=7)
        self.assertTrue(result["ok"])
        params = request.call_args.args[2]
        self.assertEqual(params["sortKey"], "updated_at")
        self.assertEqual(params["sortDirection"], "desc")
        self.assertIn("exec", params["sourceKinds"])
        self.assertIn("appServer", params["sourceKinds"])


if __name__ == "__main__":
    unittest.main()
