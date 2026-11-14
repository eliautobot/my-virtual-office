#!/usr/bin/env python3
"""Durable provider-window transcript and late-completion regression tests."""

import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


_BOOT_STATUS = tempfile.TemporaryDirectory(prefix="vo-provider-session-bootstrap-")
os.environ.setdefault("VO_STATUS_DIR", _BOOT_STATUS.name)
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

import server  # noqa: E402


class ProviderSessionDurabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vo-provider-session-")
        self.status_patch = mock.patch.object(server, "STATUS_DIR", self.temp.name)
        self.status_patch.start()
        server._PROVIDER_RUNS.clear()
        server._PROVIDER_SESSION_SYNC_AT.clear()

    def tearDown(self):
        server._PROVIDER_RUNS.clear()
        self.status_patch.stop()
        self.temp.cleanup()

    def test_native_history_loaders_read_requested_window_without_changing_active_session(self):
        fixtures = [
            ("hermes", "astra", server._save_hermes_state, server._load_hermes_state, server._load_hermes_session_history),
            ("codex", "main", server._save_codex_state, server._load_codex_state, server._load_codex_session_history),
            ("claude-code", "main", server._save_claude_code_state, server._load_claude_code_state, server._load_claude_code_session_history),
        ]
        for kind, profile, save_state, load_state, load_requested in fixtures:
            with self.subTest(provider=kind):
                server._save_chat_session_mirror(kind, profile, "session-one", [{
                    "role": "assistant", "text": f"{kind} one", "sessionId": "session-one",
                }])
                save_state(profile, {
                    "sessionId": "session-two",
                    "messages": [{"role": "assistant", "text": f"{kind} two", "sessionId": "session-two"}],
                })

                requested = load_requested(profile, "session-one")
                self.assertEqual([f"{kind} one"], [row.get("text") for row in requested])
                self.assertEqual("session-two", str(load_state(profile).get("sessionId") or ""))

    def test_new_chat_preserves_extension_transcript_without_native_create(self):
        kind, profile = "sample-extension", "main"
        server._activate_provider_session(
            kind,
            profile,
            "session-old",
            [{"role": "user", "text": "keep me", "sessionId": "session-old"}],
            source="manual-switch",
        )
        agent_ref = {
            "agentId": "sample-main",
            "providerKind": kind,
            "profile": profile,
            "record": {"capabilities": {"chat": True, "sessions": True, "sessionCreate": False}},
        }
        provider = object()
        with mock.patch.object(server, "_chat_sessions_agent", return_value=agent_ref), \
             mock.patch.object(server, "_get_provider_registry") as registry:
            registry.return_value.get.return_value = provider
            result, status = server.handle_chat_session_create("sample-main", {})

        self.assertEqual(200, status)
        self.assertTrue(result["ok"])
        active = server._load_provider_active_session(kind, profile)
        self.assertEqual("", active["sessionId"])
        self.assertTrue(active["newSessionPending"])
        old = server._load_chat_session_mirror(kind, profile, "session-old")
        self.assertEqual(["keep me"], [row.get("text") for row in old])

    def test_pending_new_session_survives_session_list_refresh(self):
        kind, profile = "sample-extension", "pending-profile"
        server._save_provider_active_session(
            kind, profile, "", source="new-session", newSessionPending=True,
        )
        agent_ref = {
            "agentId": "sample-main",
            "providerKind": kind,
            "profile": profile,
            "record": {"capabilities": {"chat": True, "sessions": True}},
        }
        stale_native = {
            "ok": True,
            "sessions": [{
                "id": "session-old",
                "sessionKey": f"{kind}:{profile}:session-old",
                "active": True,
            }],
        }
        with mock.patch.object(server, "_chat_sessions_agent", return_value=agent_ref), \
             mock.patch.object(server, "_chat_sessions_list_registered_provider", return_value=stale_native):
            payload, status = server.handle_chat_sessions_list("sample-main")

        self.assertEqual(200, status)
        self.assertEqual("", payload["activeSessionId"])
        self.assertFalse(any(row.get("active") for row in payload["sessions"]))
        active = server._load_provider_active_session(kind, profile)
        self.assertEqual("", active["sessionId"])
        self.assertTrue(active["newSessionPending"])

    def test_provider_run_reservation_is_atomic(self):
        kind, profile = "sample-extension", "atomic-profile"
        server._save_provider_active_session(kind, profile, "session-one", source="manual-switch")
        entered = threading.Event()
        release = threading.Event()
        agent = {
            "id": "sample-main", "statusKey": "sample-main", "name": "Sample",
            "providerKind": kind, "providerAgentId": profile, "profile": profile,
            "capabilities": {"chat": True, "sessions": True},
        }

        class Registry:
            @staticmethod
            def invoke(_kind, operation, *_args, **_kwargs):
                if operation != "send_chat_message":
                    return {"ok": False, "error": operation}
                entered.set()
                release.wait(timeout=3)
                return {"ok": True, "reply": "done", "sessionId": "session-one"}

        callers = 12
        barrier = threading.Barrier(callers)
        results = [None] * callers

        def start(index):
            barrier.wait(timeout=3)
            results[index] = server._handle_provider_run_start({
                "agentId": "sample-main", "message": f"request {index}", "sessionId": "session-one",
            })

        with mock.patch.object(server, "_find_agent_record", return_value=agent), \
             mock.patch.object(server, "_get_provider_registry", return_value=Registry()), \
             mock.patch.object(server, "_sync_provider_active_session", return_value=server._load_provider_active_session(kind, profile)):
            threads = [threading.Thread(target=start, args=(index,)) for index in range(callers)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=4)
            self.assertTrue(entered.wait(timeout=1))
            accepted = [result for result in results if result and result.get("ok")]
            rejected = [result for result in results if result and result.get("_status") == 409]
            self.assertEqual(1, len(accepted))
            self.assertEqual(callers - 1, len(rejected))
            release.set()
            meta = server._PROVIDER_RUNS[accepted[0]["runId"]]
            deadline = time.time() + 3
            while not meta.get("done") and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(meta.get("done"))

    def test_extension_late_completion_stays_in_originating_window(self):
        kind, profile = "sample-extension", "main"
        first = [{"role": "user", "text": "first transcript", "sessionId": "session-one"}]
        second = [{"role": "user", "text": "second transcript", "sessionId": "session-two"}]
        server._activate_provider_session(kind, profile, "session-one", first, source="manual-switch")
        entered = threading.Event()
        release = threading.Event()
        agent = {
            "id": "sample-main", "statusKey": "sample-main", "name": "Sample",
            "providerKind": kind, "providerAgentId": profile, "profile": profile,
            "capabilities": {"chat": True, "sessions": True, "sessionSwitch": True},
        }

        class Registry:
            @staticmethod
            def invoke(_kind, operation, *_args, **kwargs):
                if operation != "send_chat_message":
                    return {"ok": False, "error": operation}
                entered.set()
                release.wait(timeout=3)
                kwargs["on_progress"]({"reply": "almost", "sessionId": "session-one"})
                return {"ok": True, "reply": "late answer", "sessionId": "session-one"}

        with mock.patch.object(server, "_find_agent_record", return_value=agent), \
             mock.patch.object(server, "_get_provider_registry", return_value=Registry()), \
             mock.patch.object(server, "_sync_provider_active_session", return_value=server._load_provider_active_session(kind, profile)):
            started = server._handle_provider_run_start({
                "agentId": "sample-main", "message": "slow request", "sessionId": "session-one",
            })
            self.assertTrue(started["ok"])
            self.assertTrue(entered.wait(timeout=1))
            server._activate_provider_session(kind, profile, "session-two", second, source="manual-switch")
            release.set()
            meta = server._PROVIDER_RUNS[started["runId"]]
            deadline = time.time() + 3
            while not meta.get("done") and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(meta.get("done"))

        self.assertEqual("session-two", server._load_provider_active_session(kind, profile)["sessionId"])
        active_text = [row.get("text") for row in server._load_provider_history(kind, profile)]
        origin_text = [row.get("text") for row in server._load_chat_session_mirror(kind, profile, "session-one")]
        self.assertIn("second transcript", active_text)
        self.assertNotIn("late answer", active_text)
        self.assertIn("late answer", origin_text)

    def test_explicit_pending_window_does_not_resume_shared_active_session(self):
        kind, profile = "sample-extension", "pending-window-profile"
        pending_id = "@new:window-primary"
        server._save_provider_active_session(kind, profile, "session-old", source="native-follow")
        agent = {
            "id": "sample-main", "statusKey": "sample-main", "name": "Sample",
            "providerKind": kind, "providerAgentId": profile, "profile": profile,
            "capabilities": {"chat": True, "sessions": True},
        }
        invoked = threading.Event()
        test_case = self

        class Registry:
            @staticmethod
            def invoke(_kind, operation, *_args, **kwargs):
                test_case.assertEqual("send_chat_message", operation)
                test_case.assertEqual("", kwargs.get("session_id"))
                invoked.set()
                return {"ok": True, "reply": "fresh answer", "sessionId": "session-fresh"}

        with mock.patch.object(server, "_find_agent_record", return_value=agent), \
             mock.patch.object(server, "_get_provider_registry", return_value=Registry()), \
             mock.patch.object(server, "_sync_provider_active_session") as sync_active:
            started = server._handle_provider_run_start({
                "agentId": "sample-main",
                "message": "fresh request",
                "sessionId": "",
                "sessionKey": f"{kind}:{profile}:{pending_id}",
                "newSessionPending": True,
            })
            self.assertTrue(started["ok"])
            self.assertEqual("", started["sessionId"])
            self.assertTrue(invoked.wait(timeout=1))
            sync_active.assert_not_called()
            meta = server._PROVIDER_RUNS[started["runId"]]
            deadline = time.time() + 3
            while not meta.get("done") and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(meta.get("done"))

        self.assertEqual("session-old", server._load_provider_active_session(kind, profile)["sessionId"])
        fresh = server._load_chat_session_mirror(kind, profile, "session-fresh")
        self.assertEqual(["fresh request", "fresh answer"], [row.get("text") for row in fresh])
        self.assertEqual([], server._load_chat_session_mirror(kind, profile, pending_id))

    def test_conflicting_pending_window_keeps_its_own_durable_error_history(self):
        kind, profile = "sample-extension", "conflict-profile"
        pending_id = "@new:window-secondary"
        server._PROVIDER_RUNS["already-running"] = {
            "providerKind": kind, "profile": profile, "done": False,
        }
        agent = {
            "id": "sample-main", "statusKey": "sample-main", "name": "Sample",
            "providerKind": kind, "providerAgentId": profile, "profile": profile,
            "capabilities": {"chat": True, "sessions": True},
        }
        with mock.patch.object(server, "_find_agent_record", return_value=agent):
            rejected = server._handle_provider_run_start({
                "agentId": "sample-main",
                "message": "keep this request",
                "sessionKey": f"{kind}:{profile}:{pending_id}",
                "newSessionPending": True,
            })
        self.assertEqual(409, rejected["_status"])
        history = server._load_chat_session_mirror(kind, profile, pending_id)
        self.assertEqual("keep this request", history[0]["text"])
        self.assertIn("already has an active SDK run", history[1]["text"])

    def test_requested_window_history_does_not_change_global_active_session(self):
        kind, profile = "sample-extension", "history-profile"
        server._activate_provider_session(
            kind, profile, "session-one", [{"role": "user", "text": "window one"}], source="manual-switch",
        )
        server._activate_provider_session(
            kind, profile, "session-two", [{"role": "user", "text": "window two"}], source="manual-switch",
        )
        messages = server.get_provider_agent_messages(kind, profile, session_id="session-one")
        self.assertEqual(["window one"], [row.get("text") for row in messages])
        self.assertEqual("session-two", server._load_provider_active_session(kind, profile)["sessionId"])

    def test_native_history_merge_preserves_mirror_only_rows_and_deduplicates_overlap(self):
        kind, profile, session_id = "sample-extension", "merge-profile", "session-merge"
        mirrored = [
            {"role": "user", "text": "same question", "sessionId": session_id},
            {"role": "assistant", "text": "local commentary", "source": "commentary", "sessionId": session_id},
        ]
        native = [
            {"role": "user", "text": "same question", "sessionId": session_id},
            {"role": "assistant", "text": "native final", "sessionId": session_id},
        ]
        server._save_chat_session_mirror(kind, profile, session_id, mirrored)
        merged = server._activate_provider_session(kind, profile, session_id, native, source="native-sync")
        self.assertEqual(
            ["same question", "local commentary", "native final"],
            [row.get("text") for row in merged],
        )
        self.assertEqual(merged, server._load_chat_session_mirror(kind, profile, session_id))

    def test_builtin_rekeys_do_not_steal_a_later_selection(self):
        cases = [
            (
                "codex",
                server._activate_codex_session,
                server._rekey_codex_session_history,
                server._get_codex_session_id,
            ),
            (
                "claude-code",
                server._activate_claude_code_session,
                server._rekey_claude_code_session_history,
                server._get_claude_code_session_id,
            ),
        ]
        for kind, activate, rekey, current in cases:
            with self.subTest(provider=kind):
                profile = f"{kind}-profile"
                pending = f"@new:{kind}-pending"
                activate(profile, pending, [{"role": "user", "text": "origin"}])
                activate(profile, "selected-later", [{"role": "user", "text": "selected"}])
                moved = rekey(profile, pending, "native-origin")
                self.assertEqual("selected-later", current(profile))
                self.assertEqual(["origin"], [row.get("text") for row in moved])
                self.assertEqual(["origin"], [
                    row.get("text") for row in server._load_chat_session_mirror(kind, profile, "native-origin")
                ])

    def test_hermes_late_update_stays_in_originating_session(self):
        profile = "hermes-race"
        server._activate_hermes_session(profile, "session-one", [{"role": "user", "text": "one"}])
        server._activate_hermes_session(profile, "session-two", [{"role": "user", "text": "two"}])
        server._update_hermes_session_history(
            profile,
            "session-one",
            lambda history: history + [{"role": "assistant", "text": "late", "sessionId": "session-one"}],
        )
        self.assertEqual("session-two", server._get_hermes_session_id(profile))
        self.assertNotIn("late", [row.get("text") for row in server._load_hermes_history(profile)])
        self.assertIn("late", [
            row.get("text") for row in server._load_chat_session_mirror("hermes", profile, "session-one")
        ])


if __name__ == "__main__":
    unittest.main(verbosity=2)
