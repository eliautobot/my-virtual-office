"""v0.12 bubbles: the floor's chat bubbles for the layer's agents come from its bus (app/layer_bubbles.py).

Runs of any channel (marked outside when the layer follows another channel's run for the floor) become the message shape
the 0.9 transcript reader made: the person's message, the answer with its steps, live while it is written, then final;
the agent's current session only; merged with /agent-chat's other messages without doubles. An outside run is not the
office's own: presence (agent.activity counts it) and Office Life's office sessions leave it alone.
Run: python3 tests/test_v12_bubbles.py
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for extra in (os.path.join(ROOT, "app"), os.path.join(ROOT, "tests")):
    if extra not in sys.path:
        sys.path.insert(0, extra)

import layer_bubbles  # noqa: E402
import provider_layer_life  # noqa: E402
from office_life import sources as S  # noqa: E402
from test_pl_life import Clock, FakePresence, make_ctx, oc, hm  # noqa: E402

OFFICE = {("1", "main"): "main", ("1", "ops"): "ops", ("2", "default"): "hermes-default"}


class Now:
    def __init__(self):
        self.t = 1_800_000_000_000

    def __call__(self):
        return self.t


def resolver(event):
    office = OFFICE.get((str(event.get("connectionId")), str(event.get("agentKey"))))
    return (office, event.get("kind")) if office else None


class Store(unittest.TestCase):
    def setUp(self):
        self.now = Now()
        self.b = layer_bubbles.LayerBubbles(resolve=resolver, now_ms=self.now)

    def feed(self, *events):
        for e in events:
            self.b.on_event(e)
            self.now.t += 100

    def test_outside_run_live_then_final(self):
        key = "agent:main:telegram:direct:5"
        self.feed(oc("run.start", runId="r1", agentKey="main", sessionKey=key, outside=True))
        live = self.b.messages("main")
        self.assertEqual([m["role"] for m in live], ["assistant"])
        self.assertTrue(live[0]["live"] and live[0]["thinking"])            # the thinking dots before any word
        self.feed(oc("run.input", runId="r1", text="what is on today?"),
                  oc("tool.start", runId="r1", toolId="t1", name="exec", raw='{"command": "ls"}', title="Exec"),
                  oc("run.delta", runId="r1", text="Here "), oc("run.delta", runId="r1", text="it is"))
        user, ans = self.b.messages("main")
        self.assertEqual((user["role"], user["text"], user["sessionKey"]), ("user", "what is on today?", key))
        self.assertEqual((ans["text"], ans["live"], ans["tools"][0]["status"], ans["tools"][0]["arguments"]),
                         ("Here it is", True, "running", {"command": "ls"}))
        self.assertNotIn("thinking", ans)                                   # words now: no dots
        self.feed(oc("tool.end", runId="r1", toolId="t1", ok=True),
                  oc("run.end", runId="r1", status="ok", text="Here it is: the whole answer"))
        ans = self.b.messages("main")[-1]
        self.assertEqual((ans["text"], ans.get("live"), ans["tools"][0]["status"]), ("Here it is: the whole answer", None, "completed"))
        self.assertEqual(ans["id"], "pl-r1-out")                            # one key per run: the page types it once
        self.assertEqual(self.b.messages("ops"), [])

    def test_own_run_input_on_start_and_errors(self):
        self.feed(hm("run.start", runId="h1", agentKey="default", sessionKey="s1", input="hello"),
                  hm("run.end", runId="h1", status="error", error="Hermes could not answer"))
        user, ans = self.b.messages("hermes-default")
        self.assertEqual((user["text"], ans["text"], ans["error"]), ("hello", "", "Hermes could not answer"))

    def test_follows_the_newest_session(self):
        self.feed(oc("run.start", runId="a", agentKey="main", sessionKey="agent:main:main", input="first"),
                  oc("run.end", runId="a", status="ok", text="one"),
                  oc("run.start", runId="b", agentKey="main", sessionKey="agent:main:cron:x", outside=True),
                  oc("run.input", runId="b", text="scheduled"))
        msgs = self.b.messages("main")
        self.assertEqual([m["text"] for m in msgs if m["role"] == "user"], ["scheduled"])
        self.assertTrue(all(m["sessionKey"] == "agent:main:cron:x" for m in msgs))

    def test_bounded_and_quiet_runs_stop(self):
        for i in range(30):
            self.feed(oc("run.start", runId=f"r{i}", agentKey="main", sessionKey="k", input=f"m{i}"))
        self.assertLessEqual(len(self.b.messages("main")), 2 * layer_bubbles.RUNS_PER_AGENT)
        self.feed(oc("run.delta", runId="r29", text="x" * 10000))
        self.assertLessEqual(len(self.b.messages("main")[-1]["text"]), layer_bubbles.SHOW_TEXT)
        self.now.t += layer_bubbles.RUN_QUIET_MS + 1
        self.assertFalse(any(m.get("live") for m in self.b.messages("main")))   # never shown going on for ever

    def test_unknown_agents_and_events_ignored(self):
        self.feed(oc("run.start", runId="z", agentKey="nobody", sessionKey="k"), oc("run.delta", runId="z", text="x"),
                  oc("agent.activity", agentKey="main", active=True, keys=["k"]))
        self.assertEqual(self.b.agents(), [])

    def test_merge_drops_the_same_words(self):
        mine = [{"role": "user", "text": "hi there", "epochMs": 1000}, {"role": "assistant", "text": "hello!", "epochMs": 1001}]
        older = [{"role": "assistant", "text": "old", "epochMs": 10}, {"role": "assistant", "text": "hello!", "epochMs": 5000}]
        out = layer_bubbles.merge(older, mine, 20)
        self.assertEqual([m["text"] for m in out], ["old", "hi there", "hello!"])
        self.assertEqual(layer_bubbles.merge(older, [], 20), older)


class OutsideRuns(unittest.TestCase):
    def test_presence_counts_outside_runs_under_the_activity_ref(self):
        # (v0.13 presence2: an outside run's steps reach its agent's state, under the agent's activity ref — one turn is
        # one presence run, never a second one of its own id; before, they were dropped and an agent whose agent.activity
        # the office missed (a restart) read idle while it ran)
        p = FakePresence()
        life = provider_layer_life.LayerLife(status_key=lambda o: o, presence=p,
                                             office_for=lambda cid, native: OFFICE.get((cid, native)), sources=lambda: None)
        for e in (oc("run.start", runId="o1", agentKey="main", sessionKey="agent:main:telegram:direct:1", outside=True),
                  oc("tool.start", runId="o1", toolId="t", name="exec"), oc("run.end", runId="o1", status="ok"),
                  oc("run.start", runId="m1", agentKey="main", sessionKey="agent:main:dashboard:x")):
            life.on_event(e)
        ref = "presence:pl-1:main"
        self.assertEqual([c[:3] for c in p.calls], [("run_started", "main", ref), ("tool_started", "main", ref),
                                                    ("run_finished", "main", ref), ("run_started", "main", "m1")])
        self.assertEqual(life.bubbles.messages("main")[-1]["runId"], "m1")   # both reach the bubbles

    def test_outside_session_keeps_its_visitors(self):
        clock = Clock()
        ctx, seen = make_ctx(clock)
        src = S.Sources(ctx, clock=clock, layer_office=lambda cid, native: OFFICE.get((cid, native)))

        def feed(*events):
            for e in events:
                src.on_layer(e)
            src.drain()
            clock.advance(2)
            src.tick()
        key = "agent:main:telegram:direct:7"
        feed(oc("provider.status", state="connected"))
        clock.advance(60)
        feed(oc("agent.activity", agentKey="main", active=True, keys=[key]),
             oc("run.start", runId="o1", agentKey="main", sessionKey=key, outside=True),
             oc("run.end", runId="o1", status="ok"), oc("agent.activity", agentKey="main", active=False, keys=[]))
        clock.advance(60)
        feed(oc("agent.activity", agentKey="main", active=True, keys=[key]))   # the next message on Telegram
        self.assertEqual([e["channel"] for e in seen if e.get("type") == "visitor"], ["telegram", "telegram"])
        self.assertNotIn(key, src.office_sessions)


if __name__ == "__main__":
    unittest.main()
