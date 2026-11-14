"""v0.13 presence2: an agent busy when the office (re)connects reads working, and every running agent's steps reach it.

A live office after a restart: an agent ran a turn OpenClaw-side (sessions.list hasActiveRun), yet /status said idle,
source "snapshot". The layer told agent.activity "coder works" before the office server listened (gone), OpenClaw tells it
once per change, and the floor-followed run's events came marked outside, which presence ignored ("agent.activity has
it"). Here: the layer's replay (bus.hello .. bus.synced, provider-layer/vo-bus-state.mjs) and an outside run's own events
through the real coordinator and the /status normalizer.   python3 tests/test_v13_presence_resync.py
"""

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("VO_STATUS_DIR", tempfile.mkdtemp(prefix="vo-presence2-"))
if str(ROOT / "app") not in sys.path:
    sys.path.insert(0, str(ROOT / "app"))

import server  # noqa: E402
import provider_layer_life  # noqa: E402

presence = server.gateway_presence
OFFICE = {("1", "main"): "main", ("1", "coder"): "coder"}
OC = {"kind": "openclaw", "connectionId": "1"}


def act(agent, active=True, task=None, **extra):
    e = {"type": "agent.activity", **OC, "agentKey": agent, "active": active, "sessions": 1 if active else 0,
         "keys": [f"agent:{agent}:main"] if active else [], **extra}
    if task:
        e["task"] = task
    return e


def run_start(run, agent="coder", outside=True, **extra):
    return {"type": "run.start", **OC, "agentKey": agent, "sessionKey": f"agent:{agent}:main", "runId": run,
            **({"outside": True} if outside else {}), **extra}


def tool(kind, run, tool_id, title="", agent="coder", **extra):
    return {"type": kind, **OC, "agentKey": agent, "runId": run, "toolId": tool_id, "name": "exec", "title": title, **extra}


def run_end(run, agent="coder"):
    return {"type": "run.end", **OC, "agentKey": agent, "runId": run, "status": "ok"}


def replay(*events, boot="b1"):
    return [{"type": "bus.hello", "boot": boot}, *[{**e, "replay": True} for e in events],
            {"type": "bus.synced", "boot": boot, "replayed": len(events)}]


class Clock:
    def __init__(self):
        self.t = time.time()

    def __call__(self):
        return self.t


class Base(unittest.TestCase):
    def setUp(self):
        presence.reset_state_for_tests()
        self.clock = Clock()
        self.patch = mock.patch("time.time", self.clock)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.told = []   # what Office Life / the bubbles were handed
        src = type("Src", (), {"on_layer": lambda _s, e: self.told.append((e.get("type"), e.get("runId") or e.get("agentKey")))})()
        self.life = provider_layer_life.LayerLife(status_key=lambda o: o, presence=presence,
                                                  office_for=lambda cid, native: OFFICE.get((cid, native)),
                                                  sources=lambda: src)

    def feed(self, *events):
        for e in events:
            self.life.on_event(e)

    def status(self, agent):
        return server._normalize_presence_map(presence.get_state()).get(agent, {})

    def later(self, seconds):
        self.clock.t += seconds
        presence._maintenance_tick()

    def assertState(self, agent, state, task=None, source=None):
        s = self.status(agent)
        self.assertEqual(s.get("state"), state, s)
        if task is not None:
            self.assertEqual(s.get("task"), task, s)
        if source is not None:
            self.assertEqual(s.get("source"), source, s)
        return s


class OfficeRestartMidRun(Base):
    def test_coder_mid_run_reads_working_with_its_step_after_the_office_restarts(self):
        # (the office restarted: the snapshot says idle; the layer replays what goes on before anything else)
        snap = Path(tempfile.mkdtemp(prefix="vo-presence2-snap-")) / "presence-snapshot.json"
        snap.write_text('{"coder": {"state": "working", "updated": 1}}')
        presence.load_snapshot(str(snap))
        self.assertState("coder", "idle", source="snapshot")
        self.feed(*replay({"type": "provider.status", **OC, "state": "connected"},
                          act("coder", task="Working on “fish”"),
                          run_start("oc-1"), tool("tool.start", "oc-1", "call-1", "Exec Game: fish depth")))
        s = self.assertState("coder", "working", "Exec Game: fish depth", "openclaw-tool")
        self.assertEqual(s.get("activeRunCount"), 1, s)    # one turn, one run (the activity ref), whichever way told
        self.later(600)                                    # a long quiet step: still working
        self.assertState("coder", "working")
        self.feed(tool("tool.end", "oc-1", "call-1"), run_end("oc-1"), act("coder", active=False))
        self.later(15)
        self.assertState("coder", "idle")

    def test_floor_followed_run_without_its_activity_still_shows_working_and_ends(self):
        # (the 8085 case without the replay: agent.activity was told before the office listened, the run's events
        #  arrive marked outside)
        self.feed(run_start("oc-2"))
        self.assertState("coder", "working", source="openclaw-lifecycle")
        self.feed(tool("tool.start", "oc-2", "c1", "Exec npm test"))
        self.assertState("coder", "working", "Exec npm test", "openclaw-tool")
        self.later(300)
        self.assertState("coder", "working")
        self.feed(tool("tool.end", "oc-2", "c1"), run_end("oc-2"))
        self.later(15)
        self.assertState("coder", "idle")

    def test_activity_and_its_followed_run_count_once_and_the_activity_end_ends_it(self):
        self.feed(act("coder", task="Working on “fish”"), run_start("oc-3"), tool("tool.start", "oc-3", "c1", "Exec ls"))
        s = self.assertState("coder", "working", "Exec ls")
        self.assertEqual((s.get("activeRunCount"), s.get("activeToolCount")), (1, 1), s)
        self.feed(act("coder", active=False))       # (OpenClaw: the turn is over; the run's own end may come later)
        self.later(15)
        self.assertState("coder", "idle")
        self.feed(run_end("oc-3"))
        self.later(15)
        self.assertState("coder", "idle")
        self.assertEqual(self.status("coder").get("activeToolCount"), 0)

    def test_two_followed_runs_of_one_agent_hold_it_until_the_last_ends(self):
        self.feed(run_start("a"), run_start("b"), run_end("a"))
        self.later(30)
        self.assertState("coder", "working")
        self.feed(run_end("b"))
        self.later(15)
        self.assertState("coder", "idle")


class BusResync(Base):
    def test_what_ended_while_nobody_listened_ends_on_resync(self):
        self.feed(act("coder"), run_start("ours-1", agent="main", outside=False),
                  tool("tool.start", "ours-1", "t1", "Exec make", agent="main"))
        self.assertState("main", "working", "Exec make")
        self.feed(*replay(boot="b1"))                       # (first hello: the office's boot)
        self.assertState("main", "finishing")
        self.later(15)
        self.assertState("main", "idle")
        self.assertState("coder", "idle")

    def test_resync_keeps_what_is_told_again_and_its_task_line(self):
        self.feed(*replay({"type": "provider.status", **OC, "state": "connected"}, boot="b1"))
        self.feed(run_start("ours-2", agent="main", outside=False),
                  tool("tool.start", "ours-2", "t1", "Exec make", agent="main"), act("coder"), run_start("oc-9"))
        # (the bus reconnects to the same layer: all still going)
        self.feed(*replay(act("coder"), run_start("ours-2", agent="main", outside=False),
                          tool("tool.start", "ours-2", "t1", "Exec make", agent="main"), run_start("oc-9"), boot="b1"))
        self.later(60)
        self.assertState("main", "working", "Exec make")
        self.assertState("coder", "working")
        # (a new layer process: none of it goes on there)
        self.feed(*replay(boot="b2"))
        self.later(15)
        self.assertState("main", "idle")
        self.assertState("coder", "idle")
        self.assertEqual(presence.get_state()["main"].get("lastRunOutcome"), "interrupted")

    def test_office_life_hears_a_replayed_run_once_and_states_again(self):
        self.feed(run_start("oc-5"))
        self.told.clear()
        self.feed(*replay(act("coder"), run_start("oc-5"), run_start("oc-6"), boot="b1"))
        self.assertIn(("agent.activity", "coder"), self.told)
        self.assertNotIn(("run.start", "oc-5"), self.told)   # (known: told twice it would count twice)
        self.assertIn(("run.start", "oc-6"), self.told)      # (heard of first now)
        self.assertNotIn(("bus.hello", None), self.told)

    def test_connection_down_ends_followed_runs_too(self):
        self.feed(run_start("oc-7"), tool("tool.start", "oc-7", "c1", "Exec x"))
        self.feed({"type": "provider.status", **OC, "state": "connected"})
        self.feed({"type": "provider.disconnected", **OC})
        self.later(15)
        self.assertNotEqual(self.status("coder").get("state"), "working")
        self.assertEqual(self.life.outside, {})
        self.assertEqual(self.life.activity, {})


if __name__ == "__main__":
    unittest.main()
