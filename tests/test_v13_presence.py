"""v0.13 presence: an agent with a running turn or running helpers reads as working until that ends.

A live office: the main agent (OpenClaw "main", claude-cli) with 2 helpers running and a second agent mid-turn sat idle at their desks, screens
off, and walked away. Causes: /status aged every OpenClaw state ("openclaw-lifecycle", "openclaw-tool") to idle after
45 s without a new event, although the coordinator still held the run open; and the provider layer's agent.activity used
one presence run id per connection, so one agent's end dropped another's running activity as stale. No network.
"""

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

_DATA = tempfile.TemporaryDirectory(prefix="vo-v13-presence-")
os.environ.setdefault("VO_STATUS_DIR", _DATA.name)
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "app") not in sys.path:
    sys.path.insert(0, str(ROOT / "app"))

import server  # noqa: E402
import provider_layer_life  # noqa: E402

presence = server.gateway_presence
OFFICE = {("1", "main"): "main", ("1", "coder"): "coder"}
SUB = "agent:main:subagent:{}"


def act(agent, keys, task=None, cid="1"):
    e = {"type": "agent.activity", "kind": "openclaw", "connectionId": cid, "agentKey": agent, "active": bool(keys),
         "sessions": len(keys), "keys": list(keys)}
    if task:
        e["task"] = task
    return e


class Clock:
    def __init__(self):
        self.t = time.time()

    def __call__(self):
        return self.t


class NormalizerKeepsActiveRuns(unittest.TestCase):
    def entry(self, source, age, **extra):
        return {"state": "working", "task": "Working on “fix”", "updated": int(time.time() - age),
                "source": source, **extra}

    def test_open_run_stays_working_whatever_wrote_last(self):
        for source in ("openclaw-lifecycle", "chat", "snapshot", "session-message"):
            for counts in ({"activeRunCount": 1}, {"activeToolCount": 2}, {"waitingApprovalCount": 1}):
                got = server._normalize_presence_entry(self.entry(source, 600, **counts))
                self.assertEqual((got["state"], got["source"]), ("working", source), (source, counts))

    def test_every_provider_lifecycle_source_is_protected(self):
        for source in ("openclaw-lifecycle", "openclaw-tool", "openclaw-approval", "hermes-lifecycle", "codex-tool",
                       "claude-code-lifecycle", "claude-code-tool", "opencode-approval", "provider-lifecycle",
                       "agent-lifecycle", "agent-tool", "session-tool", "gateway-event"):
            got = server._normalize_presence_entry(self.entry(source, 900))
            self.assertEqual(got["state"], "working", source)

    def test_generic_display_states_still_age_out(self):
        for source in ("chat", "session-message", "sessions-changed", "snapshot", "legacy"):
            got = server._normalize_presence_entry(self.entry(source, 900, activeRunCount=0))
            self.assertEqual((got["state"], got["source"]), ("idle", f"{source}-stale-idle"), source)
        fresh = server._normalize_presence_entry(self.entry("chat", 5))
        self.assertEqual(fresh["state"], "working")


class LayerActivityPresence(unittest.TestCase):
    """The provider layer's agent.activity (OpenClaw's sessions feed: hasActiveRun per session) through the real
    coordinator and the /status normalizer."""

    def setUp(self):
        presence.reset_state_for_tests()
        self.clock = Clock()
        self.patch = mock.patch("time.time", self.clock)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.life = provider_layer_life.LayerLife(status_key=lambda o: o, presence=presence,
                                                  office_for=lambda cid, native: OFFICE.get((cid, native)),
                                                  sources=lambda: None)

    def status(self, agent):
        return server._normalize_presence_map(presence.get_state())[agent]

    def later(self, seconds):
        self.clock.t += seconds
        presence._maintenance_tick()

    def test_parent_with_running_helpers_stays_working_after_another_agent_ends(self):
        self.life.on_event(act("main", [SUB.format("a"), SUB.format("b")], task="Working on “VO: perf”"))
        self.life.on_event(act("coder", ["agent:coder:dashboard:x"], task="Working on “build”"))
        self.later(30)
        self.life.on_event(act("coder", []))   # coder's turn ends; main's helpers keep running
        self.later(20)
        self.assertEqual(self.status("coder")["state"], "idle")
        self.later(600)                          # ten quiet minutes: no new event from main
        main = self.status("main")
        self.assertEqual((main["state"], main["task"]), ("working", "Waiting on 2 helpers"))
        self.assertGreaterEqual(main["activeRunCount"], 1)

    def test_running_turn_stays_working_and_idles_when_it_ends(self):
        self.life.on_event(act("coder", ["agent:coder:dashboard:x"], task="Working on “build”"))
        self.later(900)
        self.assertEqual(self.status("coder")["state"], "working")
        self.life.on_event(act("coder", []))
        self.assertEqual(self.status("coder")["state"], "finishing")
        self.later(presence.FINISHING_GRACE_SEC + 1)
        self.assertEqual(self.status("coder")["state"], "idle")
        self.later(900)
        self.assertEqual(self.status("coder")["state"], "idle")   # nothing sticks after the run ends

    def test_connection_down_ends_its_activity(self):
        self.life.on_event(act("main", [SUB.format("a")]))
        self.later(60)
        self.life.on_event({"type": "provider.disconnected", "kind": "openclaw", "connectionId": "1"})
        self.later(presence.FINISHING_GRACE_SEC + 1)
        self.assertEqual(self.status("main")["state"], "idle")
        self.assertEqual(self.status("main")["activeRunCount"], 0)


class MaintenanceRunsWithTheLayer(unittest.TestCase):
    """With the provider layer (8085, 8096) the legacy gateway listener never starts, and with it never started the
    coordinator's maintenance: a run's "finishing" never reached idle on its own (only /status's clock hid it)."""

    def test_layer_office_runs_maintenance_and_a_finished_run_goes_idle(self):
        presence.stop_maintenance()
        presence.reset_state_for_tests()
        self.addCleanup(presence.stop_maintenance)
        with mock.patch.object(server, "_pl_owns", return_value=True), mock.patch.object(presence, "start") as listener:
            server._start_presence_listeners("ws://127.0.0.1:1", "token")
        listener.assert_not_called()
        self.assertTrue(presence.get_connection_status()["coordinatorActive"])
        with mock.patch.object(presence, "FINISHING_GRACE_SEC", 0):
            presence.lifecycle_run_started("coder", "r1", "openclaw", "Working")
            presence.lifecycle_run_finished("coder", "r1", "openclaw")
        self.assertEqual(presence.get_agent_state("coder")["state"], "finishing")
        deadline = time.time() + 6
        while time.time() < deadline and presence.get_agent_state("coder")["state"] != "idle":
            time.sleep(0.2)
        self.assertEqual(presence.get_agent_state("coder")["state"], "idle")


class HelperTask(unittest.TestCase):
    def test_task_line(self):
        t = provider_layer_life.activity_task
        self.assertEqual(t({"keys": [SUB.format("a"), SUB.format("b")], "task": "Working on “helper job”"}),
                         "Waiting on 2 helpers")
        self.assertEqual(t({"keys": [SUB.format("a")]}), "Waiting on 1 helper")
        self.assertEqual(t({"keys": ["agent:main:dashboard:x", SUB.format("a")], "task": "Working on “x”"}),
                         "Working on “x” · 1 helper")
        self.assertEqual(t({"keys": ["agent:main:dashboard:x"]}), "Working")


class HelperCount(unittest.TestCase):
    """The helper count Office Life sends (interns.set: the chip beside the name tag) is the number of helper sessions
    running: OpenClaw's subagent sessions and ACP children (agent:<id>:acp:<uuid>), none finished."""

    def setUp(self):
        import office_life
        from office_life import bus as life_bus, sources as S
        self.t = [1_800_000_000.0]
        clock = lambda: self.t[0]
        ctx = office_life.Context()
        ctx.bus = life_bus.LifeBus(clock=clock)
        ctx.fns.update({"status_key": lambda office_id: office_id})
        self.seen = []
        ctx.bus.add_event_listener(lambda ev: self.seen.append(dict(ev)))
        self.src = S.Sources(ctx, clock=clock, layer_office=lambda cid, native: OFFICE.get((cid, native)))
        self.S = S

    def feed(self, *events):
        for e in events:
            self.src.on_layer(e)
        self.src.drain()
        self.t[0] += 2
        self.src.tick()

    def counts(self):
        return [e["count"] for e in self.seen if e["type"] == "interns.set"]

    def test_helper_keys(self):
        k = self.S.is_helper_key
        self.assertTrue(k(SUB.format("a")) and k("agent:main:acp:9f") and k("agent:main:subagent:incognito-1"))
        self.assertFalse(k("agent:main:main") or k("agent:main:dashboard:x") or k("agent:main:telegram:direct:5")
                         or k("agent:main:cron:job:run:1") or k("subagent:x"))

    def test_count_is_running_helpers(self):
        self.feed({"type": "provider.status", "kind": "openclaw", "connectionId": "1", "state": "connected"})
        self.t[0] += 120
        own = "agent:main:dashboard:x"
        self.feed(act("main", [own, SUB.format("a"), SUB.format("b"), "agent:main:acp:c"]))
        self.assertEqual(self.counts()[-1], 3)
        self.assertFalse([e for e in self.seen if e["type"] in ("visitor", "run")
                          and "acp" in str(e.get("session") or e.get("ref") or "")], "an ACP child is a helper")
        self.feed(act("main", [SUB.format("a"), "agent:main:acp:c"]))   # b finished, the agent's own turn ended
        self.assertEqual(self.counts()[-1], 2)
        self.feed(act("main", []))
        self.assertEqual(self.counts()[-1], 0)


if __name__ == "__main__":
    unittest.main()
