"""0.12.0 (presence3): a Claude Code agent no longer stays "working" for ever after a chat-window turn.

The chat window's Claude Code turn (_handle_claude_code_run_start -> _handle_claude_code_chat) opens ONE presence run
(run.started under the stream's run id) and ends it (run.completed, same id). Its progress callback also told presence
{"event": "turn.stream", "run_id": <the CLI's own run/session id>}; gateway_presence.set_provider_event treated any event
name it did not know as a run start, so a second run under the CLI's id was opened and nothing ever ended it: /status
read working, activeRunCount 1, runId = the CLI session id, until the office restarted.

Here: the real coordinator (gateway_presence) and the real server path with the fake Claude Code CLI
(tests/tools/fake-claude), plus the adapter's contract for every provider that reports through set_provider_event
(Codex, Claude Code, OpenCode, Antigravity, Hermes): only run.started/queued/running open a run, the terminal events end
it, everything else (progress, stream ticks, deltas, unknown names, a tool or approval under another id) keeps the open
run going and never opens one.
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

_DATA = tempfile.TemporaryDirectory(prefix="vo-presence3-")
os.environ.setdefault("VO_PROVIDER_LAYER", "0")
os.environ.setdefault("VO_STATUS_DIR", _DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_DATA.name) / "openclaw"))
os.environ.setdefault("FAKE_STEP_DELAY", "0.01")

ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = ROOT / "app"
TOOLS = ROOT / "tests" / "tools"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

import gateway_presence as gp  # noqa: E402
import server  # noqa: E402

KEY = "claude-code-main"


def _runs(agent):
    return set(gp._active_runs_by_agent.get(agent) or ())


def _until(fn, timeout=30.0, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(step)
    return fn()


class ClaudeCodeChatWindowTurn(unittest.TestCase):
    """The reported case, end to end through the server's chat-window path and the fake CLI."""

    def setUp(self):
        gp.reset_state_for_tests()
        self.tmp = tempfile.mkdtemp(prefix="cc-", dir=_DATA.name)
        cfg = {
            "enabled": True,
            "binary": str(TOOLS / "fake-claude"),
            "homePath": os.path.join(self.tmp, ".claude"),
            "workspaceRoot": os.path.join(self.tmp, "claude-agents"),
            "includeNativeAgents": False,
            "registerNativeAgents": False,
            "timeoutSec": 60,
        }
        agent = {
            "id": KEY, "statusKey": KEY, "name": "Main", "providerKind": "claude-code", "profile": "main",
            "providerAgentId": "main", "capabilities": {"chat": True},
        }
        self.patches = [
            mock.patch.dict(server.VO_CONFIG, {"claudeCode": cfg}),
            mock.patch.object(server, "get_roster", lambda *a, **k: [dict(agent)]),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        gp.reset_state_for_tests()

    def _turn(self, message):
        started = server._handle_claude_code_run_start({"message": message, "agentId": KEY})
        self.assertTrue(started.get("ok"), started)
        run_id = started.get("runId")
        self.assertTrue(run_id)
        meta = _until(lambda: (server._get_claude_code_stream_run(run_id) or {}).get("done") and server._get_claude_code_stream_run(run_id), 60)
        self.assertTrue(meta, "the turn finished")
        return run_id, meta

    def test_a_chat_window_turn_ends_and_the_agent_goes_idle(self):
        seen = []
        real = gp.set_provider_event

        def spy(agent_id, provider, event):
            seen.append((dict(event), set(_runs(agent_id))))
            return real(agent_id, provider, event)

        with mock.patch.object(gp, "set_provider_event", spy):
            run_id, meta = self._turn("hello [[tool]]")
        result = meta.get("result") or {}
        self.assertTrue(result.get("ok"), str(result)[:300])
        names = [e.get("event") for e, _ in seen]
        self.assertIn("turn.stream", names, "the stream's progress reached presence")
        self.assertEqual(names[0], "run.started")
        self.assertIn(names[-1], ("run.completed", "run.failed"))
        # one presence run all along: the stream's own id; never the CLI's session id
        opened = set().union(*[r for _, r in seen]) | _runs(KEY)
        self.assertEqual(opened, {run_id}, f"runs opened: {opened}")
        cli_ids = {e.get("native_run_id") or e.get("session_id") for e, _ in seen if e.get("event") == "turn.stream"} - {""}
        self.assertTrue(cli_ids and run_id not in cli_ids, "the CLI's ids were in the stream ticks")
        state = gp.get_agent_state(KEY) or {}
        self.assertEqual(_runs(KEY), set(), f"no run left open: {state}")
        self.assertNotEqual(state.get("state"), "working", state)
        # the finish grace runs out -> idle, and stays so
        with gp._lifecycle_lock:
            gp._finish_idle_at[KEY] = 0
        gp._maintenance_tick()
        self.assertEqual((gp.get_agent_state(KEY) or {}).get("state"), "idle")

    def test_a_second_turn_also_ends_whatever_its_outcome(self):
        # (here the fake CLI may not find the first chat to resume -> the turn fails; ok or failed, it must end)
        self._turn("first")
        self.assertEqual(_runs(KEY), set())
        self._turn("second")
        self.assertEqual(_runs(KEY), set())
        self.assertNotEqual((gp.get_agent_state(KEY) or {}).get("state"), "working")


class ProviderEventContract(unittest.TestCase):
    """set_provider_event for every provider that reports through it: what opens a run and what never does."""

    PROVIDERS = ("claude-code", "codex", "opencode", "antigravity", "hermes")

    def setUp(self):
        gp.reset_state_for_tests()

    def tearDown(self):
        gp.reset_state_for_tests()

    def test_progress_ticks_under_another_id_count_for_the_open_run(self):
        for provider in self.PROVIDERS:
            agent = f"{provider}-a"
            with self.subTest(provider=provider):
                gp.set_provider_event(agent, provider, {"event": "run.started", "run_id": "R"})
                for ev in ({"event": "turn.progress", "run_id": "R"},
                           {"event": "turn.stream", "run_id": "cli-session-1"},       # Claude Code before the fix
                           {"event": "turn.progress", "run_id": "thread-turn-9"},
                           {"event": "message.delta"},                                # Hermes deltas without an id
                           {"event": "assistant.delta", "run_id": "other"},
                           {"event": "reasoning.available"},
                           {"event": "tool.delta", "run_id": "R", "tool": "Bash"},
                           {"event": "status", "run_id": "x"},                        # any name it does not know
                           {"event": "", "run_id": "y"}):
                    gp.set_provider_event(agent, provider, ev)
                    self.assertEqual(_runs(agent), {"R"}, ev)
                    self.assertEqual(gp.get_agent_state(agent)["state"], "working")
                gp.set_provider_event(agent, provider, {"event": "run.completed", "run_id": "R"})
                self.assertEqual(_runs(agent), set())
                self.assertEqual(gp.get_agent_state(agent)["state"], "finishing")

    def test_nothing_but_a_run_start_opens_a_run(self):
        for provider in self.PROVIDERS:
            agent = f"{provider}-b"
            with self.subTest(provider=provider):
                for ev in ({"event": "turn.stream", "run_id": "late"}, {"event": "turn.progress", "run_id": "late"},
                           {"event": "message.delta"}, {"event": "message.delta", "run_id": "late"},
                           {"event": "reasoning.available"}, {"event": "run.stop_requested", "run_id": "late"},
                           {"event": "something.new", "run_id": "late"}):
                    gp.set_provider_event(agent, provider, ev)
                self.assertEqual(_runs(agent), set(), "a progress tick after the end (or before any start) opened a run")
                self.assertNotEqual((gp.get_agent_state(agent) or {}).get("state"), "working")

    def test_a_late_tick_after_the_end_does_not_reopen(self):
        agent = "claude-code-c"
        gp.set_provider_event(agent, "claude-code", {"event": "run.started", "run_id": "R"})
        gp.set_provider_event(agent, "claude-code", {"event": "run.completed", "run_id": "R"})
        gp.set_provider_event(agent, "claude-code", {"event": "turn.stream", "run_id": "R"})
        gp.set_provider_event(agent, "claude-code", {"event": "turn.progress", "run_id": "R"})
        self.assertEqual(_runs(agent), set())
        self.assertEqual(gp.get_agent_state(agent)["state"], "finishing")

    def test_a_tool_or_approval_under_another_id_belongs_to_the_open_run(self):
        agent = "hermes-d"
        gp.set_provider_event(agent, "hermes", {"event": "run.started", "run_id": "R"})
        gp.set_provider_event(agent, "hermes", {"event": "tool.started", "run_id": "native-9", "tool": "terminal", "toolCallId": "t1"})
        self.assertEqual(_runs(agent), {"R"})
        gp.set_provider_event(agent, "hermes", {"event": "approval.request", "run_id": "native-9", "approval_id": "a1"})
        self.assertEqual(_runs(agent), {"R"})
        gp.set_provider_event(agent, "hermes", {"event": "approval.responded", "run_id": "native-9", "approval_id": "a1"})
        gp.set_provider_event(agent, "hermes", {"event": "tool.completed", "run_id": "native-9", "tool": "terminal", "toolCallId": "t1"})
        gp.set_provider_event(agent, "hermes", {"event": "run.completed", "run_id": "R"})
        self.assertEqual(_runs(agent), set())
        self.assertEqual(gp.get_agent_state(agent)["state"], "finishing")
        # a tool with no run open: the tool alone (its end ends it), no run that nothing ends
        gp.set_provider_event(agent, "hermes", {"event": "tool.started", "run_id": "orphan", "tool": "x", "toolCallId": "t2"})
        self.assertEqual(_runs(agent), set())
        self.assertEqual(gp.get_agent_state(agent)["state"], "working")
        gp.set_provider_event(agent, "hermes", {"event": "tool.completed", "run_id": "orphan", "tool": "x", "toolCallId": "t2"})
        self.assertEqual(gp.get_agent_state(agent)["state"], "finishing")

    def test_two_runs_of_one_agent_stay_apart(self):
        agent = "codex-e"
        gp.set_provider_event(agent, "codex", {"event": "run.started", "run_id": "R1"})
        gp.set_provider_event(agent, "codex", {"event": "run.started", "run_id": "R2"})
        gp.set_provider_event(agent, "codex", {"event": "turn.progress", "run_id": "R1"})
        self.assertEqual(_runs(agent), {"R1", "R2"})
        gp.set_provider_event(agent, "codex", {"event": "run.completed", "run_id": "R1"})
        self.assertEqual(_runs(agent), {"R2"})
        self.assertEqual(gp.get_agent_state(agent)["state"], "working")
        gp.set_provider_event(agent, "codex", {"event": "run.completed", "run_id": "R2"})
        self.assertEqual(gp.get_agent_state(agent)["state"], "finishing")


class LayerLateEvents(unittest.TestCase):
    """The provider layer's runs (Hermes, OpenClaw chats of this office): an event of a run the office never saw start,
    or saw end, opens no run (app/provider_layer_life.py); before, a late run.delta / tool.start opened one for good."""

    def setUp(self):
        import provider_layer_life
        gp.reset_state_for_tests()
        office = {("2", "astra"): "astra"}
        self.life = provider_layer_life.LayerLife(status_key=lambda o: o, presence=gp,
                                                  office_for=lambda cid, native: office.get((cid, native)),
                                                  sources=lambda: None)
        self.base = {"kind": "hermes", "connectionId": "2", "agentKey": "astra", "sessionKey": "hermes:astra:s1"}

    def tearDown(self):
        gp.reset_state_for_tests()

    def feed(self, kind, run, **extra):
        self.life.on_event({"type": kind, **self.base, "runId": run, **extra})

    def test_a_late_delta_or_step_after_the_end_opens_no_run(self):
        self.feed("run.start", "R")
        self.feed("run.delta", "R", text="hi")
        self.assertEqual(_runs("astra"), {"R"})
        self.feed("run.end", "R", status="ok")
        self.assertEqual(_runs("astra"), set())
        self.feed("run.delta", "R", text=" late")
        self.assertEqual(_runs("astra"), set(), "a late delta opened the ended run again")
        self.assertNotEqual(gp.get_agent_state("astra")["state"], "working")
        self.feed("tool.start", "R", toolId="t1", name="terminal", title="late step")
        self.assertEqual(_runs("astra"), set())
        self.feed("tool.end", "R", toolId="t1", ok=True)
        self.assertNotEqual(gp.get_agent_state("astra")["state"], "working")

    def test_a_run_never_seen_starting_opens_no_run(self):
        self.feed("run.delta", "X", text="orphan")
        self.feed("approval.requested", "X", approvalId="a1")
        self.assertEqual(_runs("astra"), set())
        self.assertEqual(gp.get_agent_state("astra")["state"], "working")   # (waiting for the approval)
        self.feed("approval.resolved", "X", approvalId="a1")
        self.assertNotEqual(gp.get_agent_state("astra")["state"], "working")


if __name__ == "__main__":
    unittest.main()
