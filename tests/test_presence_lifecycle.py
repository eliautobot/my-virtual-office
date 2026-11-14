import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


_SERVER_DATA_DIR = tempfile.TemporaryDirectory(prefix="vw-presence-tests-")
os.environ.setdefault("VO_STATUS_DIR", _SERVER_DATA_DIR.name)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SERVER_ROOT = PROJECT_ROOT / "app"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

import server  # noqa: E402


presence = server.gateway_presence


class PresenceCoordinatorTests(unittest.TestCase):
    def setUp(self):
        presence.reset_state_for_tests()
        server._PROVIDER_RUNS.clear()
        server.HERMES_ACTIVE_RUNS.clear()
        getattr(server, "CODEX_ACTIVE_RUNS", {}).clear()
        self.temp = tempfile.TemporaryDirectory(prefix="vw-presence-case-")

    def tearDown(self):
        presence.reset_state_for_tests()
        server._PROVIDER_RUNS.clear()
        server.HERMES_ACTIVE_RUNS.clear()
        getattr(server, "CODEX_ACTIVE_RUNS", {}).clear()
        self.temp.cleanup()

    def test_quiet_run_stays_working_past_ninety_seconds_then_finishes(self):
        with mock.patch.object(presence.time, "time", return_value=1_000.0):
            presence.lifecycle_run_started("astra", "run-quiet", "hermes", "Hermes native run")
        with mock.patch.object(presence.time, "time", return_value=1_090.0):
            presence._maintenance_tick()
            active = presence.get_agent_state("astra")
        self.assertEqual("working", active["state"])
        self.assertEqual(1, active["activeRunCount"])

        with mock.patch.object(presence.time, "time", return_value=1_091.0):
            presence.lifecycle_run_finished("astra", "run-quiet", "hermes", "completed")
            finishing = presence.get_agent_state("astra")
        self.assertEqual("finishing", finishing["state"])
        with mock.patch.object(presence.time, "time", return_value=1_091.0 + presence.FINISHING_GRACE_SEC + 1):
            presence._maintenance_tick()
            idle = presence.get_agent_state("astra")
        self.assertEqual("idle", idle["state"])

    def test_failure_records_error_without_marking_provider_offline(self):
        presence.lifecycle_run_started("agent", "run-fail", "codex", "Codex task")
        presence.lifecycle_run_finished("agent", "run-fail", "codex", "failed", "model error")
        state = presence.get_agent_state("agent")
        self.assertEqual("finishing", state["state"])
        self.assertEqual("failed", state["lastRunOutcome"])
        self.assertEqual("model error", state["lastRunError"])
        self.assertTrue(state["providerHealth"]["connected"])

    def test_http_server_suppresses_only_expected_client_disconnects(self):
        instance = object.__new__(server.VirtualOfficeThreadingHTTPServer)
        with mock.patch.object(sys, "exc_info", return_value=(BrokenPipeError, BrokenPipeError(32, "closed"), None)), \
             mock.patch.object(server.http.server.ThreadingHTTPServer, "handle_error") as parent:
            instance.handle_error(None, ("127.0.0.1", 1))
            parent.assert_not_called()
        with mock.patch.object(sys, "exc_info", return_value=(RuntimeError, RuntimeError("real error"), None)), \
             mock.patch.object(server.http.server.ThreadingHTTPServer, "handle_error") as parent:
            instance.handle_error(None, ("127.0.0.1", 1))
            parent.assert_called_once()

    def test_overlapping_runs_do_not_finish_early(self):
        presence.lifecycle_run_started("agent", "run-one", "test")
        presence.lifecycle_run_started("agent", "run-two", "test")
        presence.lifecycle_run_finished("agent", "run-one", "test", "completed")
        state = presence.get_agent_state("agent")
        self.assertEqual("working", state["state"])
        self.assertEqual(1, state["activeRunCount"])
        presence.lifecycle_run_finished("agent", "run-two", "test", "completed")
        self.assertEqual("finishing", presence.get_agent_state("agent")["state"])

    def test_run_terminal_clears_tools_and_approvals(self):
        presence.lifecycle_run_started("agent", "run-one", "codex")
        presence.lifecycle_tool_started("agent", "run-one", "tool-one", "shell", "codex")
        presence.lifecycle_approval_requested("agent", "run-one", "approval-one", "codex")
        active = presence.get_agent_state("agent")
        self.assertEqual((1, 1, 1), (
            active["activeRunCount"], active["activeToolCount"], active["waitingApprovalCount"],
        ))
        presence.lifecycle_run_finished("agent", "run-one", "codex", "cancelled")
        terminal = presence.get_agent_state("agent")
        self.assertEqual((0, 0, 0), (
            terminal["activeRunCount"], terminal["activeToolCount"], terminal["waitingApprovalCount"],
        ))
        self.assertEqual("finishing", terminal["state"])

    def test_only_provider_health_sets_offline(self):
        presence.lifecycle_provider_connected("agent", "opencode")
        self.assertEqual("idle", presence.get_agent_state("agent")["state"])
        presence.lifecycle_provider_disconnected("agent", "opencode", "offline", "not reachable")
        offline = presence.get_agent_state("agent")
        self.assertEqual("offline", offline["state"])
        self.assertFalse(offline["providerHealth"]["connected"])
        presence.lifecycle_provider_connected("agent", "opencode")
        self.assertEqual("idle", presence.get_agent_state("agent")["state"])

    def test_manual_idle_cannot_hide_an_active_provider_run(self):
        presence.set_manual_override("agent", "idle", "")
        presence.lifecycle_run_started("agent", "run-one", "hermes", "Hermes run")
        self.assertEqual("working", presence.get_agent_state("agent")["state"])

    def test_openclaw_gateway_events_use_the_same_coordinator(self):
        presence._process_event("agent", {
            "runId": "openclaw-run",
            "sessionKey": "agent:main:main",
            "stream": "lifecycle",
            "data": {"phase": "start"},
        })
        self.assertEqual("working", presence.get_agent_state("main")["state"])
        presence._process_event("agent", {
            "runId": "openclaw-run",
            "sessionKey": "agent:main:main",
            "stream": "lifecycle",
            "data": {"phase": "completed"},
        })
        self.assertEqual("finishing", presence.get_agent_state("main")["state"])

    def test_tool_activity_observer_receives_openclaw_and_native_provider_events(self):
        observed = []
        with mock.patch.object(presence, "_activity_observer", lambda agent_id, event: observed.append((agent_id, event))):
            presence.set_provider_event("codex-main", "codex", {
                "event": "tool.started", "runId": "run-native", "tool": "read",
                "arguments": {"path": "notes.md"},
            })
            presence._process_event("session.tool", {
                "runId": "run-openclaw", "sessionKey": "agent:main:main",
                "phase": "start", "name": "write", "args": {"path": "report.md"},
            })
        self.assertEqual(["codex-main", "main"], [row[0] for row in observed])
        self.assertEqual(["read", "write"], [row[1]["toolName"] for row in observed])
        self.assertEqual(["notes.md", "report.md"], [row[1]["arguments"]["path"] for row in observed])

    def test_deferred_tool_wrappers_are_their_inner_tool(self):
        """OpenClaw offers sessions_* as deferred tools: 2026.9 calls them through tool_call, 2026.11 through
        dispatch_action ({id, args}; the id bare or a tool-search result "openclaw:core:sessions_send"). The
        status text and the activity observers see the inner tool, not the wrapper."""
        unwrap = presence.unwrap_tool_call
        for wrapper in ("tool_call", "dispatch_action"):
            for tool_id in ("sessions_send", "openclaw:core:sessions_send"):
                self.assertEqual(unwrap(wrapper, {"id": tool_id, "args": {"label": "Coder", "message": "hi"}}),
                                 ("sessions_send", {"label": "Coder", "message": "hi"}))
            self.assertEqual(unwrap(wrapper, '{"id": "sessions_spawn", "args": "{\\"agentId\\": \\"ops\\"}"}'),
                             ("sessions_spawn", {"agentId": "ops"}))
            self.assertEqual(unwrap(wrapper, {"query": "x"}), (wrapper, {"query": "x"}))   # no inner id: as it is
        self.assertEqual(unwrap("openclaw:core:sessions_spawn", {"agentId": "ops"}), ("sessions_spawn", {"agentId": "ops"}))
        self.assertEqual(unwrap("web_search", {"query": "q"}), ("web_search", {"query": "q"}))
        added = []
        remove = presence.add_activity_observer(lambda agent_id, event: added.append((agent_id, event)))
        try:
            presence._process_event("session.tool", {
                "runId": "w-run", "stream": "tool", "sessionKey": "agent:main:main", "agentId": "main",
                "data": {"phase": "start", "name": "tool_call", "toolCallId": "w1",
                         "args": {"id": "sessions_send", "args": {"label": "Coder", "message": "hi"}}},
            })
            first = presence.get_agent_state("main")["task"]
            presence._process_event("session.tool", {
                "runId": "w-run", "stream": "tool", "sessionKey": "agent:main:main", "agentId": "main",
                "data": {"phase": "start", "name": "dispatch_action", "toolCallId": "w2",
                         "args": {"id": "openclaw:core:sessions_spawn", "args": {"agentId": "ops", "task": "x"}}},
            })
        finally:
            remove()
        self.assertEqual("Messaging Coder", first)
        self.assertEqual("Messaging ops", presence.get_agent_state("main")["task"])
        self.assertEqual([("sessions_send", "Coder"), ("sessions_spawn", "ops")],
                         [(e["toolName"], e["arguments"].get("label") or e["arguments"].get("agentId")) for _a, e in added])

    def test_agent_messages_show_a_deferred_sessions_send_as_the_message_it_sends(self):
        """(layer off) The bubble/chat feed of an OpenClaw transcript: a sessions_send called through tool_call
        (2026.9) or dispatch_action (2026.11, tool-search id) reads as the message, not as the wrapper."""
        import json as _json
        path = os.path.join(self.temp.name, "s.jsonl")
        calls = [("tool_call", "sessions_send", "first note"), ("dispatch_action", "openclaw:core:sessions_send", "second note")]
        with open(path, "w", encoding="utf-8") as handle:
            for index, (wrapper, tool_id, text) in enumerate(calls):
                handle.write(_json.dumps({"type": "message", "timestamp": f"2026-11-09T22:0{index}:00Z", "message": {
                    "role": "assistant", "content": [{"type": "toolCall", "name": wrapper, "arguments": {
                        "id": tool_id, "args": {"label": "Coder", "message": text}}}]}}) + "\n")
        with mock.patch.dict(server.AGENT_SESSION_IDS, {"main": "main"}), \
                mock.patch.object(server, "_openclaw_session_paths", lambda agent_id: (path, None, {})), \
                mock.patch.object(server, "_openclaw_session_meta_for_bubble", lambda *a, **k: {}):
            texts = [m["text"] for m in server.get_agent_messages("main")]
        self.assertEqual(["\ud83d\udce8 \u2192 Coder: first note", "\ud83d\udce8 \u2192 Coder: second note"], texts)  # (a surrogate pair, as server.py writes it)

    def test_session_tool_reads_the_live_nested_data_shape_and_the_flat_shape(self):
        """Live OpenClaw session.tool frames nest phase/name/toolCallId/args under ``data``: the Agent PC
        observer, added observers and the working task (activity chip) see the tool for both shapes."""
        observed, added = [], []
        remove = presence.add_activity_observer(lambda agent_id, event: added.append((agent_id, event)))
        try:
            with mock.patch.object(presence, "_activity_observer",
                                   lambda agent_id, event: observed.append((agent_id, event))):
                presence._process_event("session.tool", {
                    "runId": "live-run", "stream": "tool", "sessionKey": "agent:main:main", "agentId": "main",
                    "seq": 4, "ts": 1, "isHeartbeat": False, "session": {"key": "agent:main:main", "kind": "direct"},
                    "data": {"phase": "start", "name": "web_search", "toolCallId": "call-1",
                             "args": {"query": "pixel office"}},
                })
                live_working = presence.get_agent_state("main")
                self.assertEqual(1, live_working["activeToolCount"])
                presence._process_event("session.tool", {
                    "runId": "live-run", "stream": "tool", "sessionKey": "agent:main:main", "agentId": "main",
                    "data": {"phase": "result", "name": "web_search", "toolCallId": "call-1", "isError": False,
                             "result": {"ok": True}},
                })
                presence._process_event("session.tool", {
                    "runId": "flat-run", "sessionKey": "agent:coder:main",
                    "phase": "start", "name": "write", "args": {"path": "report.md"}, "toolCallId": "call-2",
                })
        finally:
            remove()
        self.assertEqual(("working", "Searching: pixel office"), (live_working["state"], live_working["task"]))
        self.assertEqual(0, presence.get_agent_state("main")["activeToolCount"])
        self.assertEqual("Writing file", presence.get_agent_state("coder")["task"])
        for seen in (observed, added):
            self.assertEqual([("main", "web_search", "start", "pixel office"), ("main", "web_search", "result", None),
                              ("coder", "write", "start", None)],
                             [(agent, ev["toolName"], ev["phase"], ev["arguments"].get("query"))
                              for agent, ev in seen])
            self.assertEqual({"openclaw-session-tool"}, {ev["source"] for _agent, ev in seen})
            self.assertEqual("live-run", seen[0][1]["runId"])

    def test_discovered_profile_is_offline_when_provider_health_fails(self):
        class Registry:
            @staticmethod
            def manifests(include_health=False):
                self.assertTrue(include_health)
                return [{
                    "id": "claude-code",
                    "capabilities": {"health": True},
                    "health": {"ok": False, "installed": True, "authOk": False},
                }]

            @staticmethod
            def discover_agents():
                return [{
                    "id": "claude-code-main", "statusKey": "claude-code-main",
                    "providerKind": "claude-code", "providerAgentId": "main",
                    "available": True, "connectionState": "connected",
                }]

        with mock.patch.object(server, "_get_provider_registry", return_value=Registry()), \
             mock.patch.object(server, "_load_discovery_cache", return_value=[]), \
             mock.patch.object(server, "_save_discovery_cache"):
            roster = server._discover_roster()
        self.assertEqual(1, len(roster))
        self.assertFalse(roster[0]["available"])
        self.assertEqual("offline", roster[0]["connectionState"])

    def test_hermes_api_server_row_stays_online_without_a_local_hermes_cli(self):
        # v0.11 relux (playtest #2): an office without a Hermes CLI (the Docker image) has a failing CLI probe as the
        # Hermes manifest health; an API-server row (listed only because its API server answered) stays connected,
        # while a CLI-only Hermes profile still follows that probe.
        class Registry:
            @staticmethod
            def manifests(include_health=False):
                return [{
                    "id": "hermes",
                    "capabilities": {"health": True},
                    "health": {"ok": False, "installed": False, "error": "Hermes CLI not found at hermes"},
                }]

            @staticmethod
            def discover_agents():
                return [
                    {"id": "hermes-astra", "statusKey": "hermes-astra", "providerKind": "hermes",
                     "providerAgentId": "astra", "gateway": "api", "connectionModes": ["api"],
                     "apiAvailable": True, "cliAvailable": False},
                    {"id": "hermes-cli", "statusKey": "hermes-cli", "providerKind": "hermes",
                     "providerAgentId": "cli", "connectionModes": ["cli"], "apiAvailable": False},
                ]

        with mock.patch.object(server, "_get_provider_registry", return_value=Registry()), \
             mock.patch.object(server, "_pl_owns", return_value=False), \
             mock.patch.object(server, "_hermes_platform_roster_agent", return_value=None), \
             mock.patch.object(server.agent_providers, "discovery_rows", return_value=[]), \
             mock.patch.object(server, "_load_discovery_cache", return_value=[]), \
             mock.patch.object(server, "_save_discovery_cache"):
            roster = {row["id"]: row for row in server._discover_roster()}
        self.assertTrue(roster["hermes-astra"]["available"])
        self.assertEqual("connected", roster["hermes-astra"]["connectionState"])
        self.assertFalse(roster["hermes-cli"]["available"])
        self.assertEqual("offline", roster["hermes-cli"]["connectionState"])

    def test_generic_lifecycle_covers_every_process_provider_and_extensions(self):
        provider_kinds = ["hermes", "codex", "claude-code", "opencode", "antigravity", "sample-extension"]
        for provider_kind in provider_kinds:
            with self.subTest(provider_kind=provider_kind):
                presence.reset_state_for_tests()
                server._PROVIDER_RUNS.clear()
                entered = threading.Event()
                release = threading.Event()
                status_key = f"{provider_kind}:agent"
                agent = {
                    "id": status_key,
                    "statusKey": status_key,
                    "providerKind": provider_kind,
                    "providerAgentId": "main",
                    "profile": "main",
                    "name": provider_kind,
                    "available": True,
                    "capabilities": {"chat": True, "interrupt": True},
                }

                class Registry:
                    @staticmethod
                    def invoke(_kind, operation, *_args, **kwargs):
                        if operation == "test":
                            return {"ok": True, "installed": True, "authOk": True}
                        if operation == "send_chat_message":
                            kwargs["on_progress"]({
                                "thinking": "working",
                                "tools": [{"id": "tool-one", "name": "read", "status": "running"}],
                            })
                            entered.set()
                            release.wait(timeout=2)
                            return {
                                "ok": True,
                                "reply": "done",
                                "sessionId": "session-one",
                                "tools": [{"id": "tool-one", "name": "read", "status": "done"}],
                            }
                        if operation == "interrupt":
                            return {"ok": True}
                        return {"ok": False, "error": operation}

                with mock.patch.object(server, "_find_agent_record", return_value=agent), \
                     mock.patch.object(server, "_get_provider_registry", return_value=Registry()), \
                     mock.patch.object(server, "STATUS_DIR", self.temp.name):
                    started = server._handle_provider_run_start({"agentId": status_key, "message": "test"})
                    self.assertTrue(started["ok"])
                    self.assertTrue(entered.wait(timeout=1))
                    active = presence.get_agent_state(status_key)
                    self.assertEqual("working", active["state"])
                    self.assertEqual(1, active["activeRunCount"])
                    release.set()
                    meta = server._PROVIDER_RUNS[started["runId"]]
                    deadline = time.time() + 2
                    while not meta.get("done") and time.time() < deadline:
                        time.sleep(0.005)
                    self.assertTrue(meta.get("done"))
                    terminal = presence.get_agent_state(status_key)
                    self.assertEqual("finishing", terminal["state"])
                    self.assertEqual(0, terminal["activeRunCount"])

    def test_generic_interrupted_result_emits_cancelled_terminal(self):
        agent = {
            "id": "codex-main", "statusKey": "codex-main", "name": "Codex",
            "providerKind": "codex", "providerAgentId": "main", "profile": "main",
            "available": True, "capabilities": {"chat": True, "interrupt": True},
        }

        class Registry:
            @staticmethod
            def invoke(_kind, operation, *_args, **_kwargs):
                if operation == "send_chat_message":
                    return {
                        "ok": True, "interrupted": True, "status": "interrupted",
                        "reply": "", "sessionId": "cancelled-thread",
                    }
                return {"ok": False, "error": operation}

        with mock.patch.object(server, "_find_agent_record", return_value=agent), \
             mock.patch.object(server, "_get_provider_registry", return_value=Registry()), \
             mock.patch.object(server, "STATUS_DIR", self.temp.name):
            started = server._handle_provider_run_start({"agentId": "codex-main", "message": "stop me"})
            meta = server._PROVIDER_RUNS[started["runId"]]
            deadline = time.time() + 2
            while not meta.get("done") and time.time() < deadline:
                time.sleep(0.005)

        self.assertTrue(meta.get("done"))
        self.assertEqual("run.cancelled", meta["events"][-1]["event"])
        self.assertTrue(meta["events"][-1]["data"]["interrupted"])
        state = presence.get_agent_state("codex-main")
        self.assertEqual("cancelled", state["lastRunOutcome"])
        self.assertTrue(state["providerHealth"]["connected"])

    def test_native_hermes_finishes_without_browser_event_attachment(self):
        entered = threading.Event()
        release = threading.Event()

        class Client:
            base_url = "http://127.0.0.1:8642"

            @staticmethod
            def is_available():
                return True

            @staticmethod
            def start_run(*_args, **_kwargs):
                return {"run_id": "hermes-native-one"}

            @staticmethod
            def stream_run_events(*_args, **_kwargs):
                entered.set()
                release.wait(timeout=2)
                yield {"event": "message.delta", "delta": "done"}
                yield {"event": "run.completed", "output": "done"}

        agent = {
            "id": "hermes-default", "statusKey": "hermes-default", "providerKind": "hermes",
            "profile": "default", "providerAgentId": "default", "apiAvailable": True,
            "capabilities": {"sessionSwitch": True},
        }
        with mock.patch.object(server, "_get_hermes_agent", return_value=agent), \
             mock.patch.object(server, "_hermes_api_client_for_profile", return_value=Client()), \
             mock.patch.object(server, "_get_hermes_session_id", return_value=""), \
             mock.patch.object(server, "_set_hermes_session_id"), \
             mock.patch.object(server, "_load_hermes_history", return_value=[]), \
             mock.patch.object(server, "_save_hermes_history"), \
             mock.patch.object(server, "_publish_hermes_api_progress"):
            started = server._handle_hermes_run_start({"agentId": "hermes-default", "message": "test"})
            self.assertTrue(started["ok"])
            self.assertTrue(entered.wait(timeout=1))
            self.assertEqual("working", presence.get_agent_state("hermes-default")["state"])
            release.set()
            runtime = server._get_hermes_active_run("hermes-native-one")["runtime"]
            deadline = time.time() + 2
            while not runtime.get("done") and time.time() < deadline:
                time.sleep(0.005)
            self.assertTrue(runtime.get("done"))
            self.assertEqual("finishing", presence.get_agent_state("hermes-default")["state"])

    def test_codex_exec_mode_run_start_is_a_200_fallback_not_a_409(self):
        # v0.11 relux (playtest #10): codex.preferAppServer off -> "use /api/codex/chat", answered 200 (no console 409)
        class Provider:
            prefer_app_server = False

        agent = {"id": "codex-main", "statusKey": "codex-main", "providerKind": "codex", "profile": "main"}
        with mock.patch.object(server, "_get_codex_agent", return_value=agent), \
             mock.patch.object(server, "_codex_provider", return_value=Provider()):
            out = server._handle_codex_run_start({"agentId": "codex-main", "message": "hi"})
        self.assertEqual((out["ok"], out["fallback"], out["mode"], out["_status"]), (False, True, "exec", 200))

    def test_native_codex_finishes_without_browser_event_attachment(self):
        entered = threading.Event()
        release = threading.Event()

        class State:
            completed = False

        class Run:
            thread_id = "thread-one"
            turn_id = "turn-one"
            state = State()

            def next_event(self, timeout=0.5):
                entered.set()
                release.wait(timeout=2)
                self.state.completed = True
                return {
                    "event": "run.completed", "ok": True, "reply": "done",
                    "sessionId": self.thread_id, "tools": [], "thinking": "",
                }

            def snapshot(self):
                return {
                    "sessionId": self.thread_id, "reply": "done", "tools": [],
                    "thinking": "", "error": "",
                }

            def close(self):
                return None

        class Provider:
            prefer_app_server = True

            @staticmethod
            def start_chat_stream(*_args, **_kwargs):
                return Run()

        agent = {
            "id": "codex-main", "statusKey": "codex-main", "providerKind": "codex",
            "profile": "main", "providerAgentId": "main",
        }
        with mock.patch.object(server, "_get_codex_agent", return_value=agent), \
             mock.patch.object(server, "_codex_provider", return_value=Provider()), \
             mock.patch.object(server, "_get_codex_session_id", return_value=""), \
             mock.patch.object(server, "_set_codex_session_id"), \
             mock.patch.object(server, "_load_codex_history", return_value=[]), \
             mock.patch.object(server, "_save_codex_history"):
            started = server._handle_codex_run_start({"agentId": "codex-main", "message": "test"})
            self.assertTrue(started["ok"])
            self.assertTrue(entered.wait(timeout=1))
            self.assertEqual("working", presence.get_agent_state("codex-main")["state"])
            release.set()
            runtime = server._get_codex_active_run("turn-one")["runtime"]
            deadline = time.time() + 2
            while not runtime.get("done") and time.time() < deadline:
                time.sleep(0.005)
            self.assertTrue(runtime.get("done"))
            self.assertEqual("finishing", presence.get_agent_state("codex-main")["state"])


if __name__ == "__main__":
    unittest.main()
