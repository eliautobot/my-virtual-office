"""0.13.1: per-agent permissions for the agents the office launches itself (Codex, Claude Code).

The owner picks a mode per agent in the chat window (Permissions button); the office keeps it in
<data>/agent-permissions.json and applies it to the agent's next run: Codex's sandbox + approval policy, Claude
Code's --permission-mode. Codex's sandbox usually cannot start in Docker: there Read only is not offered and Ask first
runs without it (asking before anything not known to be safe). Only the owner changes a mode: never the agent API token.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_DATA = tempfile.TemporaryDirectory(prefix="vo-perms-")
os.environ.setdefault("VO_PROVIDER_LAYER", "0")
os.environ.setdefault("VO_STATUS_DIR", _DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_DATA.name) / "openclaw"))

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import agent_permissions as ap  # noqa: E402
import server  # noqa: E402


def _access(manage=True, token=False, session=False, protected=True):
    return SimpleNamespace(can_manage=manage, via_token=token, via_session=session,
                           as_agent=bool(protected and token and not session))


class ModesAndDefaults(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="vo-perms-unit-")
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_codex_read_only_needs_the_sandbox(self):
        with_sb = [o["id"] for o in ap.describe(self.dir, "codex", "a", {}, sandbox=True)["options"]]
        without = [o["id"] for o in ap.describe(self.dir, "codex", "a", {}, sandbox=False)["options"]]
        self.assertEqual(["read-only", "ask", "full"], with_sb)
        self.assertEqual(["ask", "full"], without)

    def test_defaults_follow_the_office_settings(self):
        self.assertEqual("full", ap.default_mode("codex", {"approvalPolicy": "never"}))
        self.assertEqual("ask", ap.default_mode("codex", {"approvalPolicy": "on-request"}))
        self.assertEqual("ask", ap.default_mode("codex", {"approvalPolicy": "untrusted"}))
        self.assertEqual("read-only", ap.default_mode("codex", {"sandbox": "read-only", "approvalPolicy": "on-request"}, True))
        self.assertEqual("ask", ap.default_mode("codex", {"sandbox": "read-only", "approvalPolicy": "on-request"}, False))
        self.assertEqual("edits", ap.default_mode("claude-code", {"permissionMode": "acceptEdits"}))
        self.assertEqual("full", ap.default_mode("claude-code", {"permissionMode": "bypassPermissions"}))
        self.assertEqual("plan", ap.default_mode("claude-code", {"permissionMode": "plan"}))
        self.assertEqual("read-only", ap.default_mode("claude-code", {"permissionMode": "default"}))

    def test_a_choice_is_kept_per_agent_and_private(self):
        ap.set_mode(self.dir, "codex", "codex-a", "full", sandbox=False)
        self.assertEqual(("full", True), ap.current(self.dir, "codex", "codex-a", {"approvalPolicy": "untrusted"}, False))
        self.assertEqual(("ask", False), ap.current(self.dir, "codex", "codex-b", {"approvalPolicy": "untrusted"}, False))
        path = Path(self.dir) / "agent-permissions.json"
        self.assertEqual({"codex": {"codex-a": "full"}, "version": 1}, json.loads(path.read_text()))
        self.assertEqual(0o600, path.stat().st_mode & 0o777)

    def test_new_agents_start_at_ask_first(self):
        self.assertEqual("ask", ap.default_mode("codex", {}))
        self.assertEqual("ask", ap.default_mode("codex", {"sandbox": "danger-full-access"}))
        self.assertEqual(("ask", False), ap.current(self.dir, "codex", "new", {}, False))
        self.assertEqual(("edits", False), ap.current(self.dir, "claude-code", "new", {}))

    def test_a_saved_choice_survives_an_update(self):
        # the owner's choices, then an update that changes the office's defaults both ways
        ap.set_mode(self.dir, "codex", "careful", "ask", sandbox=False)
        ap.set_mode(self.dir, "codex", "trusted", "full", sandbox=False)
        ap.set_mode(self.dir, "claude-code", "planner", "plan")
        for codex_cfg, claude_cfg in (({"approvalPolicy": "never"}, {"permissionMode": "bypassPermissions"}),
                                      ({"approvalPolicy": "untrusted"}, {"permissionMode": "default"}),
                                      ({}, {})):
            self.assertEqual(("ask", True), ap.current(self.dir, "codex", "careful", codex_cfg, False))
            self.assertEqual(("full", True), ap.current(self.dir, "codex", "trusted", codex_cfg, False))
            self.assertEqual(("plan", True), ap.current(self.dir, "claude-code", "planner", claude_cfg))
        # a restart (fresh module state) reads the same file
        import importlib
        fresh = importlib.reload(ap)
        self.assertEqual(("full", True), fresh.current(self.dir, "codex", "trusted", {}, False))

    def test_saved_mode_ids_never_change(self):
        # (saved in agent-permissions.json: renaming one would drop every owner's choice at the next update)
        self.assertEqual(["read-only", "ask", "full"], list(ap.CODEX_MODES))
        self.assertEqual(["read-only", "plan", "edits", "full"], list(ap.CLAUDE_MODES))

    def test_a_damaged_file_is_set_aside_not_lost(self):
        path = Path(self.dir) / "agent-permissions.json"
        path.write_text("{not json")
        self.assertEqual(("ask", False), ap.current(self.dir, "codex", "a", {}, False))
        ap.set_mode(self.dir, "codex", "a", "full", sandbox=False)
        bad = list(Path(self.dir).glob("agent-permissions.json.bad-*"))
        self.assertEqual(1, len(bad))
        self.assertEqual("{not json", bad[0].read_text())
        self.assertEqual(("full", True), ap.current(self.dir, "codex", "a", {}, False))

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads any file")
    def test_an_unreadable_file_is_never_overwritten(self):
        ap.set_mode(self.dir, "codex", "a", "full", sandbox=False)
        path = Path(self.dir) / "agent-permissions.json"
        os.chmod(path, 0)
        try:
            with self.assertRaises(OSError):
                ap.set_mode(self.dir, "codex", "b", "ask", sandbox=False)
        finally:
            os.chmod(path, 0o600)
        self.assertEqual({"codex": {"a": "full"}, "version": 1}, json.loads(path.read_text()))

    def test_a_deleted_agent_is_forgotten(self):
        ap.set_mode(self.dir, "codex", "gone", "full", sandbox=False)
        ap.set_mode(self.dir, "codex", "kept", "full", sandbox=False)
        self.assertTrue(ap.forget(self.dir, "codex", "gone"))
        self.assertFalse(ap.forget(self.dir, "codex", "gone"))
        self.assertEqual(("ask", False), ap.current(self.dir, "codex", "gone", {}, False))
        self.assertEqual(("full", True), ap.current(self.dir, "codex", "kept", {}, False))

    def test_a_mode_not_offered_is_refused(self):
        with self.assertRaises(ValueError):
            ap.set_mode(self.dir, "codex", "a", "read-only", sandbox=False)
        with self.assertRaises(ValueError):
            ap.set_mode(self.dir, "codex", "a", "bypass", sandbox=True)
        with self.assertRaises(ValueError):
            ap.set_mode(self.dir, "openclaw", "a", "full", sandbox=True)

    def test_a_saved_read_only_without_the_sandbox_falls_back(self):
        ap.set_mode(self.dir, "codex", "a", "read-only", sandbox=True)
        self.assertEqual(("ask", False), ap.current(self.dir, "codex", "a", {"approvalPolicy": "untrusted"}, False))

    def test_run_settings(self):
        self.assertEqual(("danger-full-access", "untrusted"), ap.codex_run_settings("ask", False))
        self.assertEqual(("workspace-write", "untrusted"), ap.codex_run_settings("ask", True))
        self.assertEqual(("danger-full-access", "never"), ap.codex_run_settings("full", False))
        self.assertEqual(("read-only", "on-request"), ap.codex_run_settings("read-only", True))
        self.assertEqual(("danger-full-access", "untrusted"), ap.codex_run_settings("read-only", False))
        self.assertEqual("default", ap.claude_permission_mode("read-only"))
        self.assertEqual("acceptEdits", ap.claude_permission_mode("edits"))
        self.assertEqual("bypassPermissions", ap.claude_permission_mode("full"))
        self.assertEqual("plan", ap.claude_permission_mode("plan"))


class ServerApplies(unittest.TestCase):
    def setUp(self):
        for name in ("agent-permissions.json",):
            try:
                os.unlink(os.path.join(server.STATUS_DIR, name))
            except FileNotFoundError:
                pass
        self.sb = mock.patch.object(ap, "codex_sandbox_works", return_value=False)
        self.sb.start()
        self.codex = mock.patch.object(server, "_get_codex_agent", side_effect=lambda k: {"id": "codex-x"} if k == "codex-x" else None)
        self.claude = mock.patch.object(server, "_get_claude_code_agent", side_effect=lambda k: {"id": "claude-x"} if k == "claude-x" else None)
        self.provider = mock.patch.object(server, "_codex_provider", return_value=SimpleNamespace(binary="codex"))
        self.codex.start(); self.claude.start(); self.provider.start()

    def tearDown(self):
        mock.patch.stopall()

    def test_only_the_owner_changes_a_mode(self):
        body = {"kind": "codex", "agent": "codex-x", "mode": "full"}
        self.assertEqual(403, server._agent_permissions_set(body, _access(manage=False))["_status"])
        # the agent API token (no signed-in person): refused, with a passcode or without one
        self.assertEqual(403, server._agent_permissions_set(body, _access(manage=False, token=True))["_status"])
        self.assertEqual(403, server._agent_permissions_set(body, _access(manage=True, token=True, protected=False))["_status"])
        out = server._agent_permissions_set(body, _access(manage=True, session=True))
        self.assertTrue(out["ok"]); self.assertEqual("full", out["mode"])

    def test_unknown_agents_and_modes(self):
        self.assertEqual(404, server._agent_permissions_set({"kind": "codex", "agent": "nope", "mode": "ask"}, _access())["_status"])
        self.assertEqual(400, server._agent_permissions_set({"kind": "codex", "agent": "codex-x", "mode": "read-only"}, _access())["_status"])
        self.assertEqual(404, server._agent_permissions_view("claude-code", "nope", _access())["_status"])

    def test_an_unsavable_choice_is_reported(self):
        with mock.patch.object(ap, "set_mode", side_effect=PermissionError("denied")):
            out = server._agent_permissions_set({"kind": "codex", "agent": "codex-x", "mode": "full"}, _access())
        self.assertEqual(500, out["_status"])
        self.assertIn("Nothing was changed", out["error"])

    @unittest.skipIf("VO_CODEX_APPROVAL_POLICY" in os.environ, "set by the environment")
    def test_the_office_default_is_ask_first(self):
        # (an office with no Codex setting at all; other tests may have changed the live VO_CONFIG)
        self.assertEqual("untrusted", server._build_vo_config({})["codex"]["approvalPolicy"])
        from providers.codex import CodexProvider
        self.assertEqual("untrusted", CodexProvider(binary="/bin/true").approval_policy)

    def test_runs_other_agents_start_get_the_same_mode(self):
        # another agent or a meeting reaches a Codex / Claude Code agent through the provider registry
        from providers.builtin import NativeOfficeProvider
        server._agent_permissions_set({"kind": "codex", "agent": "codex-x", "mode": "ask"}, _access())
        server._agent_permissions_set({"kind": "claude-code", "agent": "claude-x", "mode": "plan"}, _access())
        context = server._provider_registry_context()
        seen = []

        class Native:
            binary = "codex"
            sandbox, approval_policy, permission_mode = "danger-full-access", "never", "bypassPermissions"

            def send_chat_message(self, profile, message, session_id=None, timeout_sec=None, on_progress=None):
                seen.append((self.sandbox, self.approval_policy, self.permission_mode))
                return {"ok": True}

        for kind, agent_id in (("codex", "codex-x"), ("claude-code", "claude-x")):
            native = Native()
            manifest = SimpleNamespace(id=kind, provider_type="harness", name=kind)
            wrapped = NativeOfficeProvider(native, manifest, context)
            self.assertTrue(wrapped.send_chat_message("main", "hi", agent={"id": agent_id})["ok"])
            # the shared provider keeps its own settings; only this run got the agent's mode
            self.assertEqual(("danger-full-access", "never", "bypassPermissions"),
                             (native.sandbox, native.approval_policy, native.permission_mode))
        self.assertEqual(("danger-full-access", "untrusted", "bypassPermissions"), seen[0])
        self.assertEqual("plan", seen[1][2])

    def test_the_view_says_who_may_change_it(self):
        self.assertTrue(server._agent_permissions_view("codex", "codex-x", _access())["canChange"])
        self.assertFalse(server._agent_permissions_view("codex", "codex-x", _access(manage=False, token=True))["canChange"])

    def test_codex_run_gets_the_mode(self):
        prov = SimpleNamespace(binary="codex", sandbox="workspace-write", approval_policy="never")
        server._agent_permissions_set({"kind": "codex", "agent": "codex-x", "mode": "ask"}, _access())
        self.assertEqual("ask", server._apply_codex_permissions({"id": "codex-x"}, prov))
        self.assertEqual(("danger-full-access", "untrusted"), (prov.sandbox, prov.approval_policy))
        server._agent_permissions_set({"kind": "codex", "agent": "codex-x", "mode": "full"}, _access())
        server._apply_codex_permissions({"id": "codex-x"}, prov)
        self.assertEqual(("danger-full-access", "never"), (prov.sandbox, prov.approval_policy))

    def test_claude_run_gets_the_mode_on_its_command_line(self):
        server._agent_permissions_set({"kind": "claude-code", "agent": "claude-x", "mode": "read-only"}, _access())
        prov = SimpleNamespace(permission_mode="acceptEdits")
        server._apply_claude_code_permissions({"id": "claude-x"}, prov)
        self.assertEqual("default", prov.permission_mode)
        # the CLI really gets it: --permission-mode <mode> (bypass: --dangerously-skip-permissions)
        from providers import claude_code
        seen = []

        class FakeRun:
            def __init__(self, cmd, **kw):
                seen.append(list(cmd))
                raise RuntimeError("stop here")
        ws = tempfile.mkdtemp(prefix="vo-perms-ws-")
        real = claude_code.ClaudeCodeProvider(binary="/bin/true", workspace_root=ws, main_workspace=ws,
                                              permission_mode="default")
        with mock.patch.object(claude_code, "CliRun", FakeRun), \
                mock.patch.object(type(real), "is_available", return_value=True), \
                mock.patch.object(type(real), "_workspace_for_profile", return_value=ws):
            for mode in ("default", "bypassPermissions"):
                real.permission_mode = mode
                try:
                    real.send_chat_message("main", "hello")
                except Exception:
                    pass
        flat = [" ".join(c) for c in seen]
        self.assertTrue(any("--permission-mode default" in c for c in flat), flat)
        self.assertTrue(any("--dangerously-skip-permissions" in c for c in flat), flat)



class RunSettings(unittest.TestCase):
    """Model and thinking level picked in the chat window for a Codex / Claude Code agent."""

    MODELS = {"ok": True, "models": [
        {"id": "big", "label": "Big", "isDefault": True, "effort": [{"id": "low"}, {"id": "high"}, {"id": "ultra"}], "effortDefault": "low"},
        {"id": "small", "label": "Small", "isDefault": False, "effort": [{"id": "low"}, {"id": "high"}], "effortDefault": "low"},
    ]}

    def setUp(self):
        try:
            os.unlink(os.path.join(server.STATUS_DIR, "agent-permissions.json"))
        except FileNotFoundError:
            pass
        server._AGENT_MODELS_CACHE.clear()
        mock.patch.object(ap, "codex_sandbox_works", return_value=False).start()
        mock.patch.object(server, "_get_codex_agent", side_effect=lambda k: {"id": "codex-x", "model": ""} if k == "codex-x" else None).start()
        mock.patch.object(server, "_get_claude_code_agent", side_effect=lambda k: {"id": "claude-x", "model": "inherit"} if k == "claude-x" else None).start()
        prov = SimpleNamespace(binary="codex-test", model="", list_models=lambda: self.MODELS)
        mock.patch.object(server, "_codex_provider", return_value=prov).start()

    def tearDown(self):
        mock.patch.stopall()
        server._AGENT_MODELS_CACHE.clear()

    def test_saved_per_agent_next_to_the_permissions(self):
        tmp = tempfile.mkdtemp(prefix="vo-run-")
        ap.set_mode(tmp, "codex", "a", "full", sandbox=False)
        self.assertEqual({"model": "big", "effort": "high"}, ap.set_run_settings(tmp, "codex", "a", model="big", effort="high"))
        self.assertEqual({"model": "big", "effort": ""}, ap.set_run_settings(tmp, "codex", "a", effort=""))
        self.assertEqual(("full", True), ap.current(tmp, "codex", "a", {}, False))   # the mode is untouched
        self.assertEqual({"model": "", "effort": ""}, ap.run_settings(tmp, "codex", "b"))
        with self.assertRaises(ValueError):
            ap.set_run_settings(tmp, "codex", "a", model="bad model; rm -rf")
        self.assertTrue(ap.forget(tmp, "codex", "a"))
        self.assertEqual({"model": "", "effort": ""}, ap.run_settings(tmp, "codex", "a"))

    def test_only_the_owner_picks(self):
        body = {"kind": "codex", "agent": "codex-x", "model": "small"}
        self.assertEqual(403, server._agent_run_options_set(body, _access(manage=False, token=True))["_status"])
        self.assertEqual(403, server._agent_run_options_set(body, _access(manage=True, token=True, protected=False))["_status"])
        out = server._agent_run_options_set(body, _access(session=True))
        self.assertEqual(("small", ""), (out["model"], out["effort"]))
        self.assertTrue(out["canChange"])
        self.assertEqual(["big", "small"], [m["id"] for m in out["models"]])

    def test_only_what_the_program_offers(self):
        self.assertEqual(400, server._agent_run_options_set({"kind": "codex", "agent": "codex-x", "model": "other"}, _access())["_status"])
        # "ultra" is the default model's level, not Small's
        server._agent_run_options_set({"kind": "codex", "agent": "codex-x", "model": "small"}, _access())
        self.assertEqual(400, server._agent_run_options_set({"kind": "codex", "agent": "codex-x", "effort": "ultra"}, _access())["_status"])
        self.assertEqual("high", server._agent_run_options_set({"kind": "codex", "agent": "codex-x", "effort": "high"}, _access())["effort"])

    def test_a_new_model_without_the_level_goes_back_to_its_own(self):
        server._agent_run_options_set({"kind": "codex", "agent": "codex-x", "model": "big", "effort": "ultra"}, _access())
        out = server._agent_run_options_set({"kind": "codex", "agent": "codex-x", "model": "small"}, _access())
        self.assertEqual(("small", ""), (out["model"], out["effort"]))

    def test_every_run_gets_it(self):
        server._agent_run_options_set({"kind": "codex", "agent": "codex-x", "model": "small", "effort": "high"}, _access())
        prov = SimpleNamespace(binary="codex", sandbox="", approval_policy="", model="config-model", effort="")
        server._apply_codex_permissions({"id": "codex-x"}, prov)            # the chat window, projects, other agents
        self.assertEqual(("small", "high"), (prov.model, prov.effort))
        other = SimpleNamespace(binary="codex", sandbox="", approval_policy="", model="config-model", effort="stale")
        server._apply_codex_permissions({"id": "codex-y"}, other)          # nothing picked: its own model, own level
        self.assertEqual(("config-model", ""), (other.model, other.effort))

    def test_claude_gets_model_and_effort_on_its_command_line(self):
        server._agent_run_options_set({"kind": "claude-code", "agent": "claude-x", "model": "opus", "effort": "max"}, _access())
        from providers import claude_code
        ws = tempfile.mkdtemp(prefix="vo-run-ws-")
        real = claude_code.ClaudeCodeProvider(binary="/bin/true", workspace_root=ws, main_workspace=ws)
        server._apply_claude_code_permissions({"id": "claude-x"}, real)
        seen = []

        class FakeRun:
            def __init__(self, cmd, **kw):
                seen.append(list(cmd))
                raise RuntimeError("stop here")
        with mock.patch.object(claude_code, "CliRun", FakeRun), \
                mock.patch.object(type(real), "is_available", return_value=True), \
                mock.patch.object(type(real), "supports_effort", return_value=True), \
                mock.patch.object(type(real), "_workspace_for_profile", return_value=ws):
            try:
                real.send_chat_message("main", "hello")
            except Exception:
                pass
        cmd = " ".join(seen[0])
        self.assertIn("--model opus", cmd)
        self.assertIn("--effort max", cmd)

    def test_codex_turn_and_exec_get_the_level(self):
        from providers import codex
        src = Path(codex.__file__).read_text()
        self.assertEqual(2, src.count('"effort": self.effort or None,'))        # both app-server turn/start calls
        self.assertIn('model_reasoning_effort=', src)                            # codex exec fallback

    def test_codex_model_list_from_its_app_server(self):
        from providers import codex

        class FakeClient:
            def __init__(self, *a, **k): pass
            def initialize(self): return {}
            def close(self): pass
            def request(self, method, params=None, **k):
                assert method == "model/list"
                return {"result": {"data": [
                    {"model": "gpt-a", "displayName": "GPT A", "isDefault": True, "hidden": False, "description": "d",
                     "defaultReasoningEffort": "medium", "supportedReasoningEfforts": [{"reasoningEffort": "low", "description": "fast"}, {"reasoningEffort": "high", "description": "deep"}]},
                    {"model": "gpt-hidden", "displayName": "H", "isDefault": False, "hidden": True, "description": "",
                     "defaultReasoningEffort": "low", "supportedReasoningEfforts": []}]}}
        prov = codex.CodexProvider(binary="/bin/true")
        with mock.patch.object(codex, "CodexAppServerClient", FakeClient), mock.patch.object(type(prov), "is_available", return_value=True):
            out = prov.list_models()
        self.assertTrue(out["ok"])
        self.assertEqual(["gpt-a"], [m["id"] for m in out["models"]])
        self.assertEqual(["low", "high"], [e["id"] for e in out["models"][0]["effort"]])
        self.assertEqual("medium", out["models"][0]["effortDefault"])


if __name__ == "__main__":
    unittest.main()
