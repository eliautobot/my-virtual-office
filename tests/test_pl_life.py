"""v0.11 C4: Office Life and presence from the copied layer's bus (office_life.sources on_layer + provider_layer_life).

Every layer bus event goes first to Office Life (needs, visitors, interns, alarm clocks, handoffs, the journal of runs
started outside the office) and then to presence (gateway_presence.lifecycle_*). Events are built as the layer's bus
sends them (app/provider-layer/server/providers/bus.js); no layer, provider or model is contacted.
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for extra in (os.path.join(ROOT, "app"), os.path.join(ROOT, "tests")):
    if extra not in sys.path:
        sys.path.insert(0, extra)

import office_life  # noqa: E402
import provider_layer_life  # noqa: E402
from office_life import bus as life_bus, sources as S  # noqa: E402

OFFICE = {("1", "main"): "main", ("1", "ops"): "ops", ("2", "research"): "hermes-a-research"}


class Clock:
    def __init__(self, start=1_800_000_000.0):
        self.t = start

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


def make_ctx(clock):
    ctx = office_life.Context()
    ctx.bus = life_bus.LifeBus(clock=clock)
    ctx.fns.update({"status_key": lambda office_id: office_id})
    seen = []
    ctx.bus.add_event_listener(lambda ev: seen.append(dict(ev)))
    return ctx, seen


def oc(kind, **kw):
    return dict(type=kind, kind="openclaw", connectionId="1", **kw)


def hm(kind, **kw):
    return dict(type=kind, kind="hermes", connectionId="2", **kw)


class FakePresence:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        if not name.startswith("lifecycle_"):
            raise AttributeError(name)
        return lambda *a, **k: self.calls.append((name[len("lifecycle_"):],) + a)


class LayerSources(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.ctx, self.seen = make_ctx(self.clock)
        self.src = S.Sources(self.ctx, clock=self.clock, layer_office=lambda cid, native: OFFICE.get((cid, native)))

    def feed(self, *events):
        for e in events:
            self.src.on_layer(e)
        self.src.drain()
        self.clock.advance(2)
        self.src.tick()

    def of(self, kind):
        return [e for e in self.seen if e["type"] == kind]

    def test_office_run_approval_opens_and_clears(self):
        # (run events carry the layer's key prov-<cid>-<native>)
        self.feed(oc("run.start", runId="r1", agentKey="prov-1-main", sessionKey="agent:main:dashboard:x"),
                  oc("approval.requested", runId="r1", approvalId="a1", agentKey="prov-1-main",
                     sessionKey="agent:main:dashboard:x"))
        opened = self.of("needs.open")
        self.assertEqual([(e["agent"], e["need"], e["ref"], e["session"], e["provider"]) for e in opened],
                         [("main", "approval", "a1", "agent:main:dashboard:x", "openclaw")])
        self.assertIn("a1", self.src._hub_approvals)   # presence's lifecycle copy of it is not a second sign
        self.feed(oc("approval.resolved", runId="r1", approvalId="a1", approved=False, decision="deny"))
        self.assertEqual([(e["agent"], e["outcome"]) for e in self.of("needs.close")], [("main", "answered")])

    def test_outside_need_and_question(self):
        self.feed(oc("agent.need", agentKey="ops", sessionKey="agent:ops:telegram:direct:9", needId="q9",
                     need="question", state="open"))
        self.assertEqual([(e["agent"], e["need"]) for e in self.of("needs.open")], [("ops", "question")])
        self.feed(oc("agent.need", needId="q9", need="question", state="closed", outcome="cancelled"))
        self.assertEqual([(e["agent"], e["outcome"]) for e in self.of("needs.close")], [("ops", "cancelled")])

    def test_run_end_clears_its_cards_and_provider_down_clears_all(self):
        self.feed(hm("run.start", runId="h1", agentKey="prov-2-research", sessionKey="s1"),
                  hm("question.requested", runId="h1", questionId="q1", agentKey="prov-2-research"))
        self.assertEqual(self.of("needs.open")[0]["agent"], "hermes-a-research")
        self.feed(hm("run.end", runId="h1", status="ok"))
        self.assertEqual(self.of("needs.close")[0]["outcome"], "gone")
        self.feed(oc("agent.need", agentKey="main", needId="n2", need="approval", state="open"),
                  oc("provider.status", state="offline"))
        self.assertEqual(self.of("needs.close")[-1]["ref"], "n2")

    def test_alarm_clock_has_the_cron_jobs_name(self):
        # v0.11 relux (playtest #9): the layer names a job by its id only; the clock gets the job's name from the provider
        asked = []
        self.ctx.fns["cron_job_name"] = lambda plcid, job: asked.append((plcid, job)) or {"job-7": "relux-alarm"}.get(job, "")
        self.feed(oc("provider.status", state="connected"), oc("agent.activity", agentKey="main", active=False, keys=[]))
        self.clock.advance(30)
        self.feed(oc("agent.activity", agentKey="main", active=True, keys=["agent:main:cron:job-7:run:abc"]))
        self.assertEqual([(e["ref"], e.get("name")) for e in self.of("cron.fire")], [("job-7", "relux-alarm")])
        self.assertEqual(asked, [("pl-1", "job-7")])
        # a job it does not know (or no lookup): the clock rings without a name, as before
        self.clock.advance(600)
        self.feed(oc("agent.activity", agentKey="main", active=False, keys=[]))
        self.clock.advance(600)
        self.feed(oc("agent.activity", agentKey="main", active=True, keys=["agent:main:cron:job-9:run:x"]))
        self.assertEqual([(e["ref"], e.get("name")) for e in self.of("cron.fire")][-1], ("job-9", None))

    def test_activity_visitor_cron_interns_outside_journal(self):
        base = oc("agent.activity", agentKey="main", active=True, keys=["agent:main:main"])
        self.feed(oc("provider.status", state="connected"), base)   # right after connecting: what was going, no arrivals
        self.assertEqual(self.of("visitor") + self.of("run"), [])
        self.feed(oc("run.start", runId="r2", agentKey="main", sessionKey="agent:main:dashboard:me"),
                  oc("agent.activity", agentKey="main", active=True,
                     keys=["agent:main:main", "agent:main:dashboard:me", "agent:main:telegram:direct:991",
                           "agent:main:cron:job-7:run:abc", "agent:main:subagent:u1"]))
        v = self.of("visitor")
        self.assertEqual([(e["channel"], e["session"]) for e in v], [("telegram", "agent:main:telegram:direct:991")])
        self.assertEqual([(e["agent"], e["ref"]) for e in self.of("cron.fire")], [("main", "job-7")])
        self.assertEqual([e["count"] for e in self.of("interns.set")], [1])
        starts = [e["ref"] for e in self.of("run") if e["phase"] == "start"]
        self.assertEqual(sorted(starts), ["outside:pl-1:agent:main:cron:job-7:run:abc",
                                          "outside:pl-1:agent:main:telegram:direct:991"])   # not the office's own
        self.clock.advance(30)
        self.feed(oc("agent.activity", agentKey="main", active=False, keys=[]))
        ends = [e for e in self.of("run") if e["phase"] == "end"]
        self.assertEqual(len(ends), 2)
        self.assertTrue(all(e["ms"] >= 30000 and e.get("ok") is None for e in ends))
        self.assertEqual([(e["ref"], e.get("ok")) for e in self.of("cron.done")], [("job-7", None)])
        self.assertEqual([e["count"] for e in self.of("interns.set")], [1, 0])

    def test_first_report_from_idle_is_a_real_start(self):
        self.feed(oc("provider.status", state="connected"))
        self.clock.advance(60)
        self.feed(oc("agent.activity", agentKey="ops", active=True, keys=["agent:ops:telegram:direct:5"]))
        self.assertEqual([e["channel"] for e in self.of("visitor")], ["telegram"])

    def test_hermes_sources_waiting_helpers_tasks(self):
        self.feed(hm("agent.activity", agentKey="research", active=False, keys=[]))
        self.feed(hm("agent.activity", agentKey="research", active=True, keys=["s-tg", "s-cr", "s-w"],
                     sources={"s-tg": "telegram", "s-cr": "cron", "s-w": "cli"}, waiting=["s-w"]))
        self.assertEqual([e["channel"] for e in self.of("visitor")], ["telegram"])
        self.assertEqual([e["ref"] for e in self.of("cron.fire")], ["session:s-cr"])
        self.assertEqual([(e["need"], e["ref"]) for e in self.of("needs.open")], [("input", "wait:s-w")])
        self.feed(hm("agent.helpers", agentKey="research", children=2))
        self.assertEqual(self.of("interns.set")[-1]["count"], 2)
        self.feed(hm("agent.helpers", agentKey="research", children=0),
                  hm("session.task", sessionKey="s1", change="upserted", agentKey="research",
                     task={"id": "t1", "runtime": "subagent", "status": "running"}))
        self.assertEqual(self.of("interns.set")[-1]["count"], 1)

    def test_handoff_from_office_run(self):
        self.feed(oc("run.start", runId="r3", agentKey="prov-1-main", sessionKey="agent:main:dashboard:y"),
                  oc("tool.start", runId="r3", toolId="c1", name="sessions_send", raw='{"agentId": "ops", "message": "x"}'),
                  oc("tool.start", runId="r3", toolId="c2", name="sessions_spawn", raw='{"task": "own helper"}'))
        self.assertEqual([(e["agent"], e["to"], e["via"]) for e in self.of("handoff")], [("main", "ops", "send")])
        # OpenClaw's deferred tools come through its tool_call wrapper
        self.clock.advance(60)
        self.feed(oc("tool.start", runId="r3", toolId="c3", name="tool_call",
                     raw='{"id": "sessions_send", "args": {"agentId": "ops", "message": "again"}}'))
        self.assertEqual(len(self.of("handoff")), 2)
        # ... where the wrapped tool's arguments come in its first update
        self.clock.advance(60)
        self.feed(oc("tool.start", runId="r3", toolId="c4", name="sessions_send", title="Session Send ops"))
        self.assertEqual(len(self.of("handoff")), 2)
        self.feed(oc("tool.update", runId="r3", toolId="c4", raw='{"agentId": "ops", "message": "x"}'))
        self.assertEqual(len(self.of("handoff")), 3)
        # OpenClaw 2026.11 renamed the wrapper dispatch_action (same {id, args}); the id may be a search result's
        self.clock.advance(60)
        self.feed(oc("tool.start", runId="r3", toolId="c5", name="dispatch_action",
                     raw='{"id": "openclaw:core:sessions_send", "args": {"agentId": "ops", "message": "x"}}'))
        self.assertEqual(len(self.of("handoff")), 4)
        self.clock.advance(60)
        self.feed(oc("tool.start", runId="r3", toolId="c6", name="tool_call",
                     raw='{"id": "openclaw:core:sessions_spawn", "args": {"task": "own helper"}}'))
        self.assertEqual(len(self.of("handoff")), 4)   # (a spawn without an agent: no hand-off)
        self.clock.advance(60)
        self.feed(oc("tool.start", runId="r3", toolId="c7", name="dispatch_action", raw='{"id": "sessions_send"}'),
                  oc("tool.update", runId="r3", toolId="c7", raw='{"sessionKey": "agent:ops:main", "message": "x"}'))
        self.assertEqual(len(self.of("handoff")), 5)

    def test_unknown_agent_is_never_guessed(self):
        self.feed(oc("agent.need", agentKey="stranger", needId="z", need="approval", state="open"),
                  oc("agent.activity", agentKey="stranger", active=True, keys=["agent:stranger:telegram:direct:1"]))
        self.assertEqual(self.seen, [])


class LayerPresence(unittest.TestCase):
    def setUp(self):
        self.p = FakePresence()
        self.fed = []

        class Src:
            def on_layer(inner, e):
                self.fed.append(e["type"])
                self.order.append("life")

        self.order = []
        orig = self.p.__getattr__

        def track(name):
            fn = orig(name)
            return lambda *a, **k: (self.order.append("presence"), fn(*a, **k))
        self.p.__class__ = type("P", (FakePresence,), {"__getattr__": lambda inner, name: track(name)})
        self.life = provider_layer_life.LayerLife(status_key=lambda o: o, presence=self.p,
                                                  office_for=lambda cid, native: OFFICE.get((cid, native)),
                                                  sources=lambda: Src())

    def test_run_lifecycle_and_activity(self):
        for e in (oc("run.start", runId="r1", agentKey="prov-1-main", sessionKey="agent:main:dashboard:x"),
                  oc("run.delta", runId="r1", text="he"), oc("run.delta", runId="r1", text="llo"),
                  oc("tool.start", runId="r1", toolId="t1", name="exec", title="echo"),
                  oc("tool.end", runId="r1", toolId="t1", ok=False),
                  oc("approval.requested", runId="r1", approvalId="a1"),
                  oc("approval.resolved", runId="r1", approvalId="a1", approved=True),
                  oc("run.end", runId="r1", status="error", error="boom"),
                  hm("agent.activity", agentKey="research", active=True, task="Working on x"),
                  hm("agent.activity", agentKey="research", active=False)):
            self.life.on_event(e)
        names = [c[0] for c in self.p.calls]
        self.assertEqual(names, ["run_started", "output_streaming", "tool_started", "tool_finished", "approval_requested",
                                 "approval_resolved", "run_finished", "run_started", "run_finished"])
        self.assertEqual(self.p.calls[3][-1], "failed")
        self.assertEqual(self.p.calls[6][1:5], ("main", "r1", "openclaw", "error"))
        self.assertEqual(self.p.calls[7][1:3], ("hermes-a-research", "presence:pl-2:hermes-a-research"))
        self.assertEqual(self.order[:2], ["life", "presence"])   # Office Life hears it first (one sign per card)

    def test_office_kind_is_never_counted(self):
        """Kind "office" (unify): a run of the office's own providers in the layer's window. The office's own paths report
        it already: neither Office Life nor presence hears it from the layer, even for an agent the id map would know."""
        OFFICE[("9", "dev-codex")] = "dev-codex"
        try:
            for e in (dict(type="run.start", kind="office", connectionId="9", runId="r9", agentKey="dev-codex"),
                      dict(type="run.delta", kind="office", connectionId="9", runId="r9", text="hi"),
                      dict(type="approval.requested", kind="office", connectionId="9", runId="r9", approvalId="a"),
                      dict(type="agent.activity", kind="office", connectionId="9", agentKey="dev-codex", active=True),
                      dict(type="provider.status", kind="office", connectionId="9", state="offline"),
                      dict(type="run.end", kind="office", connectionId="9", runId="r9", status="ok")):
                self.life.on_event(e)
            self.assertEqual(self.p.calls, [])
            self.assertEqual(self.fed, [])
            # (the same run as OpenClaw's is counted: the skip is the kind's alone)
            self.life.on_event(oc("run.start", runId="r10", agentKey="prov-1-main", sessionKey="agent:main:x:y"))
            self.assertEqual([c[0] for c in self.p.calls], ["run_started"])
            self.assertEqual(self.fed, ["run.start"])
        finally:
            OFFICE.pop(("9", "dev-codex"), None)


if __name__ == "__main__":
    unittest.main()
