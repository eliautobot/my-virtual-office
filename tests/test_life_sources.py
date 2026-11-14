"""Office life sources (L3): real provider signals -> OfficeEvents, each once, nothing guessed.

Covers the gateway_presence taps (Agent PC observer untouched), the Hermes presence `sources` and
`agent.helpers`, the OpenClaw adapter seed + books, sources.py for every signal family (hub tap,
lifecycle, activity observer, event tap, cron subscription, SMS tail, reconcile) and the hooks.
OpenClaw end to end on tests/helpers/fake_gateway.py; Hermes serve end to end on
tests/helpers/fake_hermes.py. Fake clocks where timing matters; no real provider is contacted.
"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for extra in (os.path.join(ROOT, "app"), os.path.join(ROOT, "tests"), os.path.join(ROOT, "tests", "helpers"),
              os.path.join(ROOT, "tests", "legacy")):   # (the Hermes adapter fixtures: legacy path tests)
    if extra not in sys.path:
        sys.path.insert(0, extra)

import agent_providers  # noqa: E402
import gateway_presence as presence  # noqa: E402
import office_life  # noqa: E402
import provider_hub as ph  # noqa: E402
from office_life import bus as life_bus, hooks, sources as S  # noqa: E402
from openclaw_adapter import OpenClawAdapter  # noqa: E402
from providers import hermes_activity as ha  # noqa: E402


def wait_for(check, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if check():
            return True
        time.sleep(0.02)
    return bool(check())


class Clock:
    def __init__(self, start=1_800_000_000.0):
        self.t = start

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


def make_ctx(clock=time.time, **fns):
    ctx = office_life.Context()
    ctx.bus = life_bus.LifeBus(clock=clock)
    ctx.fns.update({"status_key": lambda office_id: office_id})
    ctx.fns.update(fns)
    seen = []
    ctx.bus.add_event_listener(lambda ev: seen.append(dict(ev)))
    return ctx, seen


def kinds(seen, kind=None):
    return [e for e in seen if kind is None or e["type"] == kind]


def route(hub):
    """agent_providers.publish_event into a private hub (the server routes into provider_hub.HUB)."""
    def publish(kind, event):
        with mock.patch.object(ph, "HUB", hub):
            return agent_providers.publish_event(kind, event)
    return publish


class SourcesCase(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.ctx, self.seen = make_ctx(self.clock)
        self.hub = ph.ChatHub()
        self.src = S.Sources(self.ctx, clock=self.clock, hub=self.hub, office_id=lambda cid, native: native)
        self.src.attach()

    def tearDown(self):
        self.src.stop()

    def run_queue(self, advance=0.0):
        self.src.drain()
        if advance:
            self.clock.advance(advance)
        self.src._flush_interns()


# ── 1. gateway_presence taps ─────────────────────────────────────────────
class TestPresenceTaps(unittest.TestCase):
    def setUp(self):
        presence.reset_state_for_tests()
        self.removers = []

    def tearDown(self):
        for remove in self.removers:
            remove()
        presence.reset_state_for_tests()

    def test_agent_pc_slot_and_added_observers_both_see_tools(self):
        slot, added = [], []
        with mock.patch.object(presence, "_activity_observer", lambda a, e: slot.append((a, e["toolName"]))):
            self.removers.append(presence.add_activity_observer(lambda a, e: added.append((a, e["toolName"], e["phase"]))))
            presence.set_provider_event("ls-a", "codex", {"event": "tool.started", "run_id": "r1", "tool": "exec"})
        self.assertEqual(slot, [("ls-a", "exec")])
        self.assertEqual(added, [("ls-a", "exec", "started")])
        self.removers.pop()()
        presence.set_provider_event("ls-a", "codex", {"event": "tool.completed", "run_id": "r1", "tool": "exec"})
        self.assertEqual(len(added), 1)

    def test_lifecycle_listener_names_once_per_run_tool_and_approval(self):
        calls = []
        self.removers.append(presence.add_lifecycle_listener(lambda *a: calls.append(a)))
        presence.set_provider_event("ls-b", "codex", {"event": "run.started", "run_id": "r2"})
        for _ in range(3):   # streaming deltas re-mark the run active: one run_started only
            presence.set_provider_event("ls-b", "codex", {"event": "message.delta", "run_id": "r2"})
        presence.set_provider_event("ls-b", "codex", {"event": "tool.started", "run_id": "r2", "tool": "exec",
                                                       "toolCallId": "t1"})
        presence.set_provider_event("ls-b", "codex", {"event": "approval.request", "run_id": "r2", "approvalId": "ap1"})
        presence.set_provider_event("ls-b", "codex", {"event": "approval.request", "run_id": "r2", "approvalId": "ap1"})
        presence.set_provider_event("ls-b", "codex", {"event": "approval.responded", "run_id": "r2", "approvalId": "ap1"})
        presence.set_provider_event("ls-b", "codex", {"event": "run.failed", "run_id": "r2", "error": "boom"})
        names = [c[0] for c in calls]
        self.assertEqual(names, ["run_started", "tool_started", "approval_requested", "approval_resolved",
                                 "run_finished"])
        self.assertEqual(calls[0][1:4], ("ls-b", "r2", "codex"))
        self.assertEqual(calls[1][4], {"toolName": "exec"})
        self.assertEqual(calls[2][4], {"approvalId": "ap1"})
        self.assertEqual(calls[-1][4], {"outcome": "failed", "error": True})

    def test_provider_health_only_on_transitions(self):
        calls = []
        self.removers.append(presence.add_lifecycle_listener(lambda *a: calls.append(a[0])))
        presence.lifecycle_provider_connected("ls-c", "hermes")
        presence.lifecycle_provider_connected("ls-c", "hermes")
        presence.lifecycle_provider_disconnected("ls-c", "hermes")
        presence.lifecycle_provider_disconnected("ls-c", "hermes")
        presence.lifecycle_provider_connected("ls-c", "hermes")
        self.assertEqual(calls, ["provider_connected", "provider_disconnected", "provider_connected"])

    def test_event_tap_sees_session_frames_only_and_a_failing_tap_never_breaks_presence(self):
        tapped = []
        self.removers.append(presence.add_event_tap(lambda t, p: tapped.append(t)))
        self.removers.append(presence.add_event_tap(lambda t, p: 1 / 0))
        with mock.patch("traceback.print_exc"):
            presence._process_event("session.message", {"sessionKey": "agent:ls-d:main", "role": "user"})
            presence._process_event("sessions.changed", {"sessionKey": "agent:ls-d:main", "reason": "send"})
            presence._process_event("chat", {"sessionKey": "agent:ls-d:main", "state": "delta"})
        self.assertEqual(tapped, ["session.message", "sessions.changed"])
        self.assertEqual(presence.get_agent_state("ls-d")["state"], "working")

    def test_activity_snapshot_lists_open_runs_and_approvals(self):
        presence.lifecycle_approval_requested("ls-e", "r5", "ap5", "codex")
        snap = presence.activity_snapshot()
        self.assertEqual(snap["runs"]["r5"][0], "ls-e")
        self.assertEqual(snap["approvals"]["ap5"][0], "ls-e")


# ── 2-3. Hermes presence: sources + helpers ──────────────────────────────
class StubLink:
    connected = True

    def __init__(self, live, stored):
        self.live, self.stored = live, stored

    def call(self, method, params, timeout=10):
        if method == "profiles.list":
            return {"profiles": [{"name": name} for name in sorted(set(self.stored) | set(self.live))]}
        if method == "session.active_list":
            return {"sessions": self.live.get(params["profile"], [])}
        raise AssertionError(method)

    def rest(self, method, path, profile=None, query=None, timeout=10):
        return {"sessions": self.stored.get(profile, [])}


class TestHermesPresence(unittest.TestCase):
    def test_sources_children_and_helpers_event(self):
        now = time.time()
        stored = {"default": [
            {"id": "tg", "source": "telegram", "last_activity_at": now - 5, "title": "Weather"},
            {"id": "job", "source": "cron", "last_activity_at": now - 5},
            {"id": "kid1", "source": "tui", "parent_session_id": "tg", "last_activity_at": now - 3},
            {"id": "kid2", "parent_session_id": "tg", "last_activity_at": now - 400},     # idle helper
            {"id": "kid3", "parent_session_id": "tg", "last_activity_at": now - 1, "ended_at": now},
        ], "research": [
            {"id": "kid9", "parent_session_id": "x", "last_activity_at": now - 2},       # helper only
        ]}
        live = {"default": [{"session_key": "tg", "status": "waiting", "title": "Weather"}]}
        emitted = []
        p = ha.Presence("c1", StubLink(live, stored), emitted.extend)
        by = p.read()
        self.assertEqual(by["default"]["sources"], {"tg": "telegram", "job": "cron"})
        self.assertEqual(by["default"]["children"], 1)
        self.assertEqual((by["research"]["children"], by["research"]["keys"]), (1, set()))
        p.report(by)
        activity = [e for e in emitted if e["type"] == "agent.activity"]
        helpers = {e["agentId"]: e["children"] for e in emitted if e["type"] == "agent.helpers"}
        self.assertEqual([e["agentId"] for e in activity], ["default"])     # helpers alone never move research
        self.assertEqual(activity[0]["sources"], {"job": "cron", "tg": "telegram"})
        self.assertEqual(activity[0]["waiting"], ["tg"])
        self.assertEqual(helpers, {"default": 1, "research": 1})
        emitted.clear()
        p.report(by)
        self.assertEqual(emitted, [])                                        # on change only
        p.report({})
        self.assertEqual(sorted((e["type"], e["agentId"]) for e in emitted),
                         [("agent.activity", "default"), ("agent.helpers", "default"), ("agent.helpers", "research")])

    def test_hub_whitelist_passes_sources_and_helpers(self):
        clean = ph.clean_event({"type": "agent.activity", "active": True, "keys": ["a"], "sources": {"a": "telegram"},
                                "children": 3})
        self.assertEqual(clean["sources"], {"a": "telegram"})
        self.assertNotIn("children", clean)
        self.assertEqual(ph.clean_event({"type": "agent.helpers", "children": 2, "x": 1}),
                         {"type": "agent.helpers", "children": 2})
        self.assertEqual(ph.clean_event({"type": "agent.helpers", "children": "lots"})["children"], 0)


# ── 4. OpenClaw adapter seed + books ─────────────────────────────────────
class StubClient:
    def __init__(self, rows):
        self.rows, self.calls = rows, []

    def request(self, method, params, timeout=None, config_key=None, expected_generation=None):
        self.calls.append(method)
        return {"ok": True, "payload": self.rows}


class TestAdapterSeed(unittest.TestCase):
    def rows(self):
        future = int(time.time() * 1000) + 600_000
        return [{"id": "ap1", "request": {"command": "rm -rf build", "agentId": "main",
                                          "sessionKey": "agent:main:main"}, "createdAtMs": 1, "expiresAtMs": future,
                 "approvalKind": "exec"},
                {"id": "old", "request": {"agentId": "main", "sessionKey": "agent:main:main"}, "expiresAtMs": 5}]

    def test_seed_publishes_once_and_all_pending_has_no_card_text(self):
        client = StubClient(self.rows())
        adapter = OpenClawAdapter(lambda: client, config_key_getter=lambda: "k")
        published = []
        adapter.on_event(published.append)
        self.assertEqual(adapter.seed_approvals(), 1)
        self.assertEqual(adapter.seed_approvals(), 0)
        self.assertEqual(client.calls, ["exec.approval.list", "exec.approval.list"])
        self.assertEqual([(e["type"], e["approvalId"], e["sessionKey"]) for e in published],
                         [("approval.requested", "ap1", "agent:main:main")])
        pending = adapter.approvals.all_pending()
        self.assertEqual([(r["id"], r["kind"], r["agentId"]) for r in pending], [("ap1", "exec", "main")])
        self.assertNotIn("rm -rf", json.dumps(pending))


# ── 5. hub tap (both adapters' universal events) ─────────────────────────
class TestHubSignals(SourcesCase):
    def pub(self, cid, native, session, event, run=None):
        key = ph.chat_key(cid, native, session) if session else ph.agent_key(cid, native)
        return self.hub.publish(key, event, run=run)

    def test_openclaw_adapter_cards_open_and_close_needs_once(self):
        adapter = OpenClawAdapter(lambda: None, config_key_getter=lambda: "k")
        adapter.on_event(lambda e: route(self.hub)("openclaw", e))
        frame = {"type": "event", "event": "exec.approval.requested",
                 "payload": {"id": "ap1", "expiresAtMs": 4_000_000_000_000,
                             "request": {"agentId": "main", "sessionKey": "agent:main:main", "command": "ls"}}}
        adapter.feed(frame)
        adapter.feed(frame)
        adapter.feed({"type": "event", "event": "question.requested",
                      "payload": {"id": "q1", "agentId": "main", "sessionKey": "agent:main:main",
                                  "questions": [{"id": "x", "question": "Which?"}]}})
        self.run_queue()
        opened = kinds(self.seen, "needs.open")
        self.assertEqual([(e["agent"], e["need"], e["ref"], e["provider"]) for e in opened],
                         [("main", "approval", "ap1", "openclaw"), ("main", "question", "q1", "openclaw")])
        self.assertEqual(opened[0]["session"], "agent:main:main")
        self.assertEqual(opened[1]["count"], 2)
        self.assertNotIn("command", json.dumps(opened))
        adapter.feed({"type": "event", "event": "exec.approval.resolved", "payload": {"id": "ap1", "decision": "deny"}})
        adapter.feed({"type": "event", "event": "question.resolved", "payload": {"id": "q1", "status": "expired"}})
        self.run_queue()
        self.assertEqual([(e["ref"], e["outcome"]) for e in kinds(self.seen, "needs.close")],
                         [("ap1", "answered"), ("q1", "expired")])

    def test_openclaw_tasks_interns_and_cron(self):
        adapter = OpenClawAdapter(lambda: None, config_key_getter=lambda: "k")
        adapter.on_event(lambda e: route(self.hub)("openclaw", e))

        def task(task_id, runtime, status):
            adapter.feed({"type": "event", "event": "task", "payload": {
                "action": "upserted", "task": {"id": task_id, "runtime": runtime, "status": status, "agentId": "main",
                                               "sessionKey": "agent:main:main", "sourceId": "job7"}}})
        task("t1", "subagent", "running")
        task("t2", "acp", "queued")
        self.run_queue(advance=1.1)
        self.assertEqual([(e["count"], e["shown"]) for e in kinds(self.seen, "interns.set")], [(2, 2)])
        task("t1", "subagent", "succeeded")
        task("t2", "acp", "failed")
        self.run_queue(advance=1.1)
        self.assertEqual([e["count"] for e in kinds(self.seen, "interns.set")], [2, 0])
        task("c1", "cron", "running")
        task("c1", "cron", "succeeded")
        self.run_queue()
        self.assertEqual([(e["type"], e.get("ok")) for e in self.seen if e["type"].startswith("cron.")],
                         [("cron.fire", None), ("cron.done", True)])

    def test_hermes_cards_waiting_sources_helpers_and_run_end(self):
        self.pub("lab", "default", "s1", {"type": "approval.requested", "approvalId": "a1"}, run="r1")
        self.pub("lab", "default", "s1", {"type": "question.requested", "questionId": "q1"}, run="r1")
        self.run_queue()
        self.assertEqual([(e["ref"], e["provider"], e["session"]) for e in kinds(self.seen, "needs.open")],
                         [("a1", "hermes", "s1"), ("q1", "hermes", "s1")])
        self.pub("lab", "default", "s1", {"type": "run.end", "status": "cancelled"}, run="r1")
        self.run_queue()
        self.assertEqual(sorted(e["ref"] for e in kinds(self.seen, "needs.close")), ["a1", "q1"])
        del self.seen[:]
        # first report is a baseline (already-busy sessions are no arrivals), waiting still opens a sign
        self.pub("lab", "default", None, {"type": "agent.activity", "active": True, "keys": ["old"],
                                          "sources": {"old": "telegram"}, "waiting": ["old"]})
        self.run_queue()
        self.assertEqual(kinds(self.seen, "visitor"), [])
        self.assertEqual([(e["need"], e["ref"]) for e in kinds(self.seen, "needs.open")], [("input", "wait:old")])
        self.pub("lab", "default", None, {"type": "agent.activity", "active": True,
                                          "keys": ["old", "tg2", "job", "web", "odd"],
                                          "sources": {"old": "telegram", "tg2": "Telegram", "job": "cron",
                                                      "web": "virtual-office", "odd": "carrier-pigeon"}})
        self.run_queue()
        self.assertEqual([(e["channel"], e["session"]) for e in kinds(self.seen, "visitor")], [("telegram", "tg2")])
        self.assertEqual([(e["type"], e["ref"]) for e in self.seen if e["type"].startswith("cron.")],
                         [("cron.fire", "session:job")])
        self.assertEqual([(e["ref"], e["outcome"]) for e in kinds(self.seen, "needs.close")],
                         [("wait:old", "answered")])
        self.pub("lab", "default", None, {"type": "agent.activity", "active": False, "keys": []})
        self.pub("lab", "default", None, {"type": "agent.helpers", "children": 3})
        self.run_queue(advance=1.1)
        self.assertEqual([(e["type"], e["ref"]) for e in kinds(self.seen, "cron.done")], [("cron.done", "session:job")])
        # 0.12.0: one intern per running helper; shown is capped only by the office cap (interns.maxShown, 24)
        self.assertEqual([(e["count"], e["shown"]) for e in kinds(self.seen, "interns.set")], [(3, 3)])
        self.ctx.settings["interns"] = {"maxShown": 2}  # the setting lowers the cap
        self.pub("lab", "default", None, {"type": "agent.helpers", "children": 5})
        self.run_queue(advance=1.1)
        self.assertEqual([(e["count"], e["shown"]) for e in kinds(self.seen, "interns.set")][-1], (5, 2))

    def test_provider_down_closes_its_needs(self):
        self.pub("lab", "default", "s1", {"type": "approval.requested", "approvalId": "a1"}, run="r1")
        self.pub("other", "ops", "s2", {"type": "approval.requested", "approvalId": "a2"}, run="r2")
        self.run_queue()
        self.hub.publish(ph.connection_key("lab"), {"type": "provider.status", "state": "offline"})
        self.run_queue()
        self.assertEqual([(e["agent"], e["outcome"]) for e in kinds(self.seen, "needs.close")], [("default", "gone")])

    def test_feature_gates_open_but_never_close(self):
        self.pub("lab", "default", "s1", {"type": "approval.requested", "approvalId": "a1"}, run="r1")
        self.run_queue()
        self.ctx.settings["features"]["needsYou"] = False
        self.pub("lab", "default", "s1", {"type": "approval.requested", "approvalId": "a2"}, run="r1")
        self.pub("lab", "default", "s1", {"type": "approval.resolved", "approvalId": "a1"}, run="r1")
        self.run_queue()
        self.assertEqual([e["ref"] for e in kinds(self.seen, "needs.open")], ["a1"])
        self.assertEqual([e["ref"] for e in kinds(self.seen, "needs.close")], ["a1"])
        self.pub("lab", "default", None, {"type": "agent.helpers", "children": 2})
        self.run_queue(advance=1.1)
        self.ctx.settings["features"]["interns"] = False
        self.src.on_settings(self.ctx.settings)
        self.run_queue(advance=1.1)
        self.assertEqual([e["count"] for e in kinds(self.seen, "interns.set")], [2, 0])

    def test_roster_filter_drops_hidden_agents(self):
        self.ctx.bus.configure(roster=lambda: {"main"})
        self.pub("lab", "hidden", "s1", {"type": "approval.requested", "approvalId": "a9"}, run="r9")
        self.run_queue()
        self.assertEqual(kinds(self.seen, "needs.open"), [])


# ── 6. lifecycle + activity observer ─────────────────────────────────────
class TestLifecycleAndActivity(SourcesCase):
    def setUp(self):
        super().setUp()
        presence.reset_state_for_tests()
        self.src.gp = presence
        self.removers = [presence.add_lifecycle_listener(self.src.on_lifecycle),
                         presence.add_activity_observer(self.src.on_activity),
                         presence.add_event_tap(self.src.on_gateway_event)]

    def tearDown(self):
        for remove in self.removers:
            remove()
        presence.reset_state_for_tests()
        super().tearDown()

    def test_codex_run_tools_approval_and_failure(self):
        presence.set_provider_event("cx", "codex", {"event": "run.started", "run_id": "r1"})
        presence.set_provider_event("cx", "codex", {"event": "tool.started", "run_id": "r1", "tool": "exec",
                                                     "toolCallId": "t1"})
        presence.set_provider_event("cx", "codex", {"event": "tool.started", "run_id": "r1", "tool": "web_search",
                                                     "toolCallId": "t2"})
        presence.set_provider_event("cx", "codex", {"event": "approval.request", "run_id": "r1", "approvalId": "ap"})
        self.run_queue()
        self.clock.advance(90)
        presence.set_provider_event("cx", "codex", {"event": "approval.responded", "run_id": "r1", "approvalId": "ap"})
        presence.set_provider_event("cx", "codex", {"event": "run.failed", "run_id": "r1", "error": "x"})
        self.run_queue()
        runs = kinds(self.seen, "run")
        self.assertEqual([(e["phase"], e["provider"]) for e in runs], [("start", "codex"), ("end", "codex")])
        self.assertEqual((runs[1]["ok"], runs[1]["outcome"], runs[1]["ms"], runs[1]["tools"]),
                         (False, "failed", 90_000, {"terminal": 1, "search": 1}))
        self.assertEqual([(e["need"], e["provider"]) for e in kinds(self.seen, "needs.open")], [("approval", "codex")])
        self.assertEqual([e["outcome"] for e in kinds(self.seen, "needs.close")], ["answered"])

    def test_hermes_naming_presence_windows_and_hub_cards_are_one_sign(self):
        # a hub card (Hermes serve) arrives first; presence turns it into a lifecycle approval: one sign
        self.hub.add_listener(lambda key, frame: frame.get("run") and frame["event"]["type"] == "approval.requested"
                              and presence.lifecycle_approval_requested("default", frame["run"],
                                                                        frame["event"]["approvalId"], "hermes"))
        self.hub.publish(ph.chat_key("lab", "default", "s1"), {"type": "approval.requested", "approvalId": "a1"},
                         run="hr1")
        presence.lifecycle_run_started("default", "presence:lab", "hermes", "Working")
        self.hub.publish(ph.chat_key("lab", "default", "s2"), {"type": "run.start", "status": "running"}, run="hr2")
        presence.lifecycle_run_started("default", "hr2", "hermes", "Working")      # (as _hp_presence_listener does)
        presence.set_provider_event("legacy", "hermes", {"event": "run.started", "run_id": "lr1"})
        presence.set_provider_event("legacy", "hermes", {"event": "approval.request", "run_id": "lr1",
                                                         "approvalId": "la1"})
        self.run_queue()
        opened = kinds(self.seen, "needs.open")
        self.assertEqual([(e["ref"], e["provider"], e.get("session")) for e in opened],
                         [("a1", "hermes", "s1"), ("la1", "hermes-legacy", None)])
        runs = kinds(self.seen, "run")
        self.assertEqual([(e["ref"], e["provider"]) for e in runs],
                         [("hr1", "hermes"), ("hr2", "hermes"), ("lr1", "hermes-legacy")])
        presence.set_provider_event("legacy", "hermes", {"event": "run.completed", "run_id": "lr1"})
        self.run_queue()
        self.assertEqual([(e["ref"], e["outcome"]) for e in kinds(self.seen, "needs.close")], [("la1", "gone")])
        self.assertEqual(kinds(self.seen, "run")[-1]["ok"], True)

    def test_openclaw_tools_and_handoffs_from_the_observer(self):
        self.ctx.bus.configure(roster=lambda: {"main", "coder"})
        presence._process_event("agent", {"runId": "or1", "sessionKey": "agent:main:main", "stream": "lifecycle",
                                          "data": {"phase": "start"}})
        for index, (name, args) in enumerate((
                ("sessions_send", {"sessionKey": "agent:coder:main", "message": "secret words"}),
                ("sessions_spawn", {"task": "x"}),                       # own helper: no handoff
                ("sessions_send", {"label": "Coder"}),                   # no id: never a name guess
                ("sessions_send", {"sessionKey": "agent:coder:main"}))):  # same call again: counted once
            # (the live gateway's session.tool shape: runId, stream, data{phase,name,toolCallId,args}, sessionKey)
            presence._process_event("session.tool", {"runId": "or1", "sessionKey": "agent:main:main",
                                                     "stream": "tool", "agentId": "main",
                                                     "data": {"phase": "start", "name": name,
                                                              "toolCallId": f"c{min(index, 2)}" if index < 3 else "c0",
                                                              "args": args}})
        presence._process_event("agent", {"runId": "or1", "sessionKey": "agent:main:main", "stream": "lifecycle",
                                          "data": {"phase": "end"}})
        self.run_queue()
        self.assertEqual([(e["agent"], e["to"], e["via"]) for e in kinds(self.seen, "handoff")],
                         [("main", "coder", "send")])
        self.assertNotIn("secret", json.dumps(self.seen))
        end = kinds(self.seen, "run")[-1]
        self.assertEqual((end["provider"], end["ok"], end["tools"]), ("openclaw", True, {"message": 3}))

    def test_openclaw_deferred_handoffs_count_as_their_tool(self):
        # (layer off) OpenClaw offers sessions_* as deferred tools: 2026.9 calls them through tool_call, 2026.11
        # through dispatch_action, both {id, args}; the id bare or a tool-search result "openclaw:core:sessions_send"
        self.ctx.bus.configure(roster=lambda: {"main", "coder", "ops"})
        key = "agent:main:main"
        presence._process_event("agent", {"runId": "or2", "sessionKey": key, "stream": "lifecycle",
                                          "data": {"phase": "start"}})
        send = {"phase": "start", "name": "tool_call", "toolCallId": "w1",
                "args": {"id": "sessions_send", "args": {"sessionKey": "agent:coder:main", "message": "secret words"}}}
        presence._process_event("agent", {"runId": "or2", "sessionKey": key, "stream": "tool", "data": send})
        presence._process_event("session.tool", {"runId": "or2", "sessionKey": key, "stream": "tool", "agentId": "main",
                                                 "data": dict(send)})       # the same call as session.tool: once
        presence._process_event("session.tool", {"runId": "or2", "sessionKey": key, "stream": "tool", "agentId": "main",
                                                 "data": {"phase": "start", "name": "dispatch_action", "toolCallId": "w2",
                                                          "args": {"id": "openclaw:core:sessions_spawn",
                                                                   "args": json.dumps({"agentId": "ops", "task": "x"})}}})
        presence._process_event("agent", {"runId": "or2", "sessionKey": key, "stream": "lifecycle",
                                          "data": {"phase": "end"}})
        self.run_queue()
        self.assertEqual([(e["agent"], e["to"], e["via"]) for e in kinds(self.seen, "handoff")],
                         [("main", "coder", "send"), ("main", "ops", "spawn")])
        self.assertNotIn("secret", json.dumps(self.seen))
        self.assertEqual(kinds(self.seen, "run")[-1]["tools"], {"message": 2})

    def test_openclaw_deferred_handoff_on_the_event_tap_alone(self):
        # (a session.tool frame the presence observer does not report: the event tap unwraps it too)
        self.ctx.bus.configure(roster=lambda: {"main", "coder"})
        for index, wrapper in enumerate(("tool_call", "dispatch_action")):
            self.src.on_gateway_event("session.tool", {
                "runId": f"or{index}", "sessionKey": "agent:main:main", "agentId": "main", "stream": "tool",
                "data": {"phase": "start", "name": wrapper, "toolCallId": f"t{index}",
                         "args": {"id": ["sessions_send", "openclaw:core:sessions_send"][index],
                                  "args": {"sessionKey": "agent:coder:main"}}}})
            self.run_queue()
            self.clock.advance(120)    # (one handoff per pair within its dedupe window)
        self.assertEqual([(e["agent"], e["to"], e["via"]) for e in kinds(self.seen, "handoff")],
                         [("main", "coder", "send"), ("main", "coder", "send")])

    def test_one_openclaw_tool_call_on_both_frame_kinds_counts_once(self):
        key = "agent:main:main"
        presence._process_event("agent", {"runId": "or7", "sessionKey": key, "stream": "lifecycle",
                                          "data": {"phase": "start"}})
        for call in ("c1", "c2"):
            presence._process_event("agent", {"runId": "or7", "sessionKey": key, "stream": "tool",
                                              "data": {"phase": "start", "name": "exec", "toolCallId": call,
                                                       "args": {"command": "ls"}}})
        for call in ("c1", "c2", "c3"):          # c1/c2 again as session.tool frames, c3 only here
            presence._process_event("session.tool", {"runId": "or7", "stream": "tool", "sessionKey": key,
                                                     "agentId": "main", "data": {"phase": "start", "name": "exec",
                                                                                 "toolCallId": call, "args": {}}})
        presence._process_event("agent", {"runId": "or7", "sessionKey": key, "stream": "lifecycle",
                                          "data": {"phase": "end"}})
        self.run_queue()
        self.assertEqual(kinds(self.seen, "run")[-1]["tools"], {"terminal": 3})

    def test_reconcile_ends_runs_and_needs_presence_no_longer_holds(self):
        presence.set_provider_event("cx2", "codex", {"event": "run.started", "run_id": "r9"})
        presence.set_provider_event("cx2", "codex", {"event": "approval.request", "run_id": "r9", "approvalId": "a9"})
        self.run_queue()
        presence.reset_state_for_tests()            # presence forgot them (stale sweep, restart of a provider)
        self.src.reconcile()
        self.clock.advance(S.GONE_GRACE_S + 1)
        self.src.reconcile()
        self.assertEqual([(e["phase"], e.get("outcome"), e.get("ok")) for e in kinds(self.seen, "run")],
                         [("start", None, None), ("end", "gone", None)])
        self.assertEqual([e["outcome"] for e in kinds(self.seen, "needs.close")], ["gone"])


# ── 7. OpenClaw event tap ────────────────────────────────────────────────
class TestGatewayTap(SourcesCase):
    def msg(self, key, row=None, role="user", provenance=None):
        message = {"role": role, "content": "hello there"}
        if provenance:
            message["provenance"] = provenance
        self.src.on_gateway_event("session.message", {"sessionKey": key, "message": message,
                                                      **({"session": row} if row is not None else {})})

    def test_visitors_only_from_outside_channels(self):
        self.msg("agent:main:telegram:direct:42", {"origin": {"provider": "telegram"}, "lastChannel": "telegram"})
        self.msg("agent:ops:main", {"deliveryContext": {"channel": "discord"}})
        self.msg("agent:web:main", {"origin": {"provider": "webchat"}, "lastChannel": "telegram"})   # webchat decides
        self.msg("agent:odd:main", {"lastChannel": "carrier-pigeon"})
        self.msg("agent:seg:slack:channel:9", {})                                                    # key segment
        self.msg("agent:bot:main", {"origin": {"provider": "telegram"}}, role="assistant")
        self.run_queue()
        visits = kinds(self.seen, "visitor")
        self.assertEqual([(e["agent"], e["channel"]) for e in visits],
                         [("main", "telegram"), ("ops", "discord"), ("seg", "slack")])
        self.assertEqual(visits[0]["session"], "agent:main:telegram:direct:42")
        self.assertNotIn("hello", json.dumps(self.seen))
        self.msg("agent:main:telegram:direct:42", {"origin": {"provider": "telegram"}})
        self.run_queue()
        self.assertEqual(len(kinds(self.seen, "visitor")), 3)                  # 60 s dedupe per agent + channel

    def test_live_frame_shape_flattened_row_and_model_provider(self):
        # captured shape: row fields flattened at the top AND nested under `session`; message.provider is the model's
        base = {"sessionKey": "agent:main:main", "agentId": "main", "messageId": "m1", "messageSeq": 4,
                "hasActiveRun": True, "session": {"key": "agent:main:main", "agentId": "main", "hasActiveRun": True}}
        self.src.on_gateway_event("session.message", dict(base, message={"role": "user", "provider": "telegram",
                                                                         "content": "x", "timestamp": 1}))
        self.src.on_gateway_event("session.message", dict(base, lastChannel="signal",
                                                          message={"role": "user", "provider": "anthropic"}))
        self.run_queue()
        self.assertEqual([e["channel"] for e in kinds(self.seen, "visitor")], ["signal"])

    def test_inter_session_message_is_a_handoff_not_a_visitor(self):
        self.msg("agent:coder:main", {"origin": {"provider": "telegram"}},
                 provenance={"kind": "inter_session", "sourceSessionKey": "agent:main:main"})
        self.msg("agent:coder:main", {}, provenance={"kind": "inter_session", "sourceSessionKey": "agent:coder:x"})
        self.run_queue()
        self.assertEqual([(e["agent"], e["to"], e["via"]) for e in kinds(self.seen, "handoff")],
                         [("main", "coder", "send")])
        self.assertEqual(kinds(self.seen, "visitor"), [])

    def test_subagent_sessions_are_interns_of_their_parent(self):
        for key, active in (("agent:main:subagent:a", True), ("agent:main:subagent:b", True),
                            ("agent:main:main", True)):
            self.src.on_gateway_event("sessions.changed", {"sessionKey": key, "session": {"key": key,
                                                                                         "hasActiveRun": active}})
        self.run_queue(advance=1.1)
        self.src.on_gateway_event("sessions.changed", {"sessionKey": "agent:main:subagent:a",
                                                       "session": {"hasActiveRun": False}})
        self.run_queue(advance=1.1)
        self.assertEqual([(e["agent"], e["count"]) for e in kinds(self.seen, "interns.set")], [("main", 2), ("main", 1)])

    def test_tap_through_gateway_presence(self):
        presence.reset_state_for_tests()
        remove = presence.add_event_tap(self.src.on_gateway_event)
        try:
            presence._process_event("session.message", {"sessionKey": "agent:main:whatsapp:direct:1",
                                                        "message": {"role": "user"}, "session": {}})
        finally:
            remove()
            presence.reset_state_for_tests()
        self.run_queue()
        self.assertEqual([e["channel"] for e in kinds(self.seen, "visitor")], ["whatsapp"])


# ── 8. cron, SMS, hooks ──────────────────────────────────────────────────
class TestCronSmsHooks(SourcesCase):
    def cron(self, action, agent="main", owner=None, **extra):
        job = {"id": "j1", "name": "Morning report", "agentId": agent}
        if owner:
            job["owner"] = {"agentId": owner}
        self.src.on_cron_frame({"type": "event", "event": "cron",
                                "payload": {"action": action, "jobId": "j1", "runAtMs": 1234, "job": job, **extra}})

    def test_cron_fire_and_done_once_never_guessing_the_agent(self):
        self.cron("started", owner="ops")
        self.cron("started", owner="ops")
        self.cron("finished", owner="ops", status="error")
        self.cron("started", agent="")
        self.cron("added")
        self.run_queue()
        rows = [(e["type"], e["agent"], e.get("ok"), e.get("name")) for e in self.seen if e["type"].startswith("cron.")]
        self.assertEqual(rows, [("cron.fire", "ops", None, "Morning report"), ("cron.done", "ops", False, "Morning report")])

    def test_sms_tail_reads_only_new_inbound_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "sms-log.jsonl")
            with open(path, "w") as fh:
                fh.write(json.dumps({"type": "inbound", "text": "old"}) + "\n")
            self.ctx.fns.update({"sms_owner": lambda: "main", "sms_paths": lambda: [path]})
            self.assertEqual(self.src.poll_sms(), 0)                              # history is skipped
            with open(path, "a") as fh:
                fh.write(json.dumps({"type": "outbound", "text": "x"}) + "\n")
                fh.write(json.dumps({"type": "inbound", "text": "hi"}) + "\n")
                fh.write('{"type": "inbound", "te')                               # half-written line waits
            self.assertEqual(self.src.poll_sms(), 1)
            with open(path, "a") as fh:
                fh.write('xt": "rest"}\n')
            self.clock.advance(61)
            self.assertEqual(self.src.poll_sms(), 1)
            visits = kinds(self.seen, "visitor")
            self.assertEqual([(e["agent"], e["channel"]) for e in visits], [("main", "sms"), ("main", "sms")])
            self.assertNotIn("hi", [e.get("text") for e in visits])
            self.ctx.fns["sms_owner"] = lambda: None
            self.assertEqual(self.src.poll_sms(), 0)

    def test_hooks_publish_structured_events(self):
        with mock.patch.object(office_life, "CTX", self.ctx):
            hooks.task_done(agent="main", task_id="t1", title="Ship it", project_id="p1", points=5,
                            completed_at="2026-11-02T10:00:00Z", by="user")
            hooks.xp_awarded(agent="main", points=5, total=40, reason="task", at="2026-11-02T10:00:00+00:00")
            hooks.project_status(project_id="p1", title="Launch", old="active", new="completed", agents=["main", "ops"])
            hooks.project_status(project_id="p1", title="Launch", old="completed", new="completed", agents=[])
            hooks.a2a_sent(sender="main", target="ops", ref="m1")
            hooks.task_assigned(task_id="t2", title="x", new="ops", by="user")
            hooks.task_assigned(task_id="t3", title="x", new="ops", by="main")
            hooks.task_assigned(task_id="t4", title="x", new="main", by="main")
        rows = [(e["type"], e.get("agent"), e.get("to") or e.get("points") or e.get("agents")) for e in self.seen]
        self.assertEqual(rows, [("task.done", "main", 5), ("xp", "main", 5), ("project.done", None, ["main", "ops"]),
                                ("handoff", "main", "ops"), ("handoff", "main", "ops")])
        self.assertEqual(self.seen[0]["at"], 1793613600000)
        self.assertEqual([e["via"] for e in kinds(self.seen, "handoff")], ["a2a", "task"])


class TestCronOneDonePerRun(SourcesCase):
    """A live OpenClaw cron run is reported twice (session.task with sourceId = job id, and the
    cron subscription by job id): one ref, one cron.fire and one cron.done (QA life fix)."""

    def setUp(self):
        super().setUp()
        adapter = OpenClawAdapter(lambda: None, config_key_getter=lambda: "k")
        adapter.on_event(lambda e: route(self.hub)("openclaw", e))
        self.adapter = adapter

    def task(self, status):
        self.adapter.feed({"type": "event", "event": "task", "payload": {
            "action": "upserted", "task": {"id": "run-77", "runtime": "cron", "status": status, "agentId": "main",
                                           "sessionKey": "agent:main:main", "sourceId": "j1"}}})

    def cron(self, action, **extra):
        self.src.on_cron_frame({"type": "event", "event": "cron", "payload": {
            "action": action, "jobId": "j1", "runAtMs": 1234, "job": {"id": "j1", "name": "Digest", "agentId": "main"},
            **extra}})

    def crons(self):
        return [(e["type"], e.get("ref")) for e in self.seen if e["type"].startswith("cron.")]

    def test_task_signal_then_subscription(self):
        self.task("running")
        self.cron("started")
        self.task("succeeded")
        self.cron("finished", status="ok")
        self.run_queue()
        self.assertEqual(self.crons(), [("cron.fire", "j1"), ("cron.done", "j1")])

    def test_subscription_then_task_signal(self):
        self.cron("started")
        self.task("running")
        self.cron("finished", status="error")
        self.task("failed")
        self.run_queue()
        self.assertEqual(self.crons(), [("cron.fire", "j1"), ("cron.done", "j1")])
        self.assertIs(kinds(self.seen, "cron.done")[0]["ok"], False)

    def test_next_run_after_the_window_reports_again(self):
        self.cron("started")
        self.cron("finished", status="ok")
        self.run_queue(advance=S.CRON_GAP_S + 1)
        self.task("running")
        self.task("succeeded")
        self.run_queue()
        self.assertEqual(self.crons(), [("cron.fire", "j1"), ("cron.done", "j1")] * 2)

    def test_task_without_a_job_id_keeps_its_task_ref(self):
        self.adapter.feed({"type": "event", "event": "task", "payload": {
            "action": "upserted", "task": {"id": "run-9", "runtime": "cron", "status": "running", "agentId": "main",
                                           "sessionKey": "agent:main:main"}}})
        self.run_queue()
        self.assertEqual(self.crons(), [("cron.fire", "task:run-9")])


# ── end to end: OpenClaw on the fake gateway ─────────────────────────────
class TestOpenClawEndToEnd(unittest.TestCase):
    def setUp(self):
        from websockets.asyncio.client import connect
        from fake_gateway import FakeGateway
        from openclaw_gateway_client import OpenClawGatewayClient
        future = int(time.time() * 1000) + 600_000
        self.gateway = FakeGateway().start()
        self.gateway.handlers["exec.approval.list"] = lambda p, s: [
            {"id": "seed1", "request": {"agentId": "main", "sessionKey": "agent:main:main", "command": "make"},
             "expiresAtMs": future, "approvalKind": "exec"}]
        self.client = OpenClawGatewayClient(
            lambda _key: {"url": self.gateway.url, "token": "test-token", "access": "full"},
            connect, reconnect_min_sec=0.02, reconnect_max_sec=0.1)
        self.adapter = OpenClawAdapter(lambda: self.client, config_key_getter=lambda: ("fake", "full"))
        self.hub = ph.ChatHub()
        self.adapter.on_event(lambda e: route(self.hub)("openclaw", e))
        self.ctx, self.seen = make_ctx(openclaw_configured=lambda: True, openclaw_start=self.adapter.start,
                                       openclaw_adapter=lambda: self.adapter, openclaw_client=lambda: self.client)
        self.src = S.Sources(self.ctx, hub=self.hub, office_id=lambda cid, native: native)

    def tearDown(self):
        self.src.stop()
        self.adapter.close()
        self.client.close()
        self.gateway.stop()

    def test_boot_seed_cards_cron_and_tasks_flow_without_a_chat_page(self):
        self.src.start()
        self.assertTrue(wait_for(lambda: kinds(self.seen, "needs.open"), 8), self.seen)
        self.assertEqual(kinds(self.seen, "needs.open")[0]["ref"], "seed1")
        self.assertTrue(wait_for(lambda: self.src._cron_sub is not None, 5))
        self.gateway.emit("cron", {"action": "started", "jobId": "j1", "runAtMs": 7,
                                   "job": {"id": "j1", "name": "Digest", "agentId": "main"}})
        self.gateway.emit("cron", {"action": "finished", "jobId": "j1", "runAtMs": 7, "status": "ok",
                                   "job": {"id": "j1", "name": "Digest", "agentId": "main"}})
        self.gateway.emit("exec.approval.resolved", {"id": "seed1", "decision": "allow-once"})
        self.gateway.emit("task", {"action": "upserted", "task": {"id": "t1", "runtime": "subagent",
                                                                  "status": "running", "agentId": "main",
                                                                  "sessionKey": "agent:main:main"}})
        self.assertTrue(wait_for(lambda: kinds(self.seen, "cron.done") and kinds(self.seen, "needs.close")
                                 and kinds(self.seen, "interns.set"), 8), self.seen)
        self.assertEqual([(e["type"], e.get("ok")) for e in self.seen if e["type"].startswith("cron.")],
                         [("cron.fire", None), ("cron.done", True)])
        self.assertEqual(kinds(self.seen, "needs.close")[0]["outcome"], "answered")
        self.assertEqual(kinds(self.seen, "interns.set")[0]["count"], 1)
        self.assertEqual(len(self.gateway.calls("exec.approval.list")), 1)


# ── end to end: Hermes serve on the fake Hermes ──────────────────────────
from test_hp_hermes_adapter import CID, AdapterCase  # noqa: E402


class TestHermesEndToEnd(AdapterCase):
    def setUp(self):
        self._poll = mock.patch.object(ha, "POLL_S", 0.3)
        self._poll.start()
        super().setUp()
        self.hub = ph.ChatHub()
        self.adapter.on_event(lambda e: route(self.hub)("hermes", e))
        self.ctx, self.seen = make_ctx()
        self.src = S.Sources(self.ctx, hub=self.hub, office_id=lambda cid, native: native).start()

    def tearDown(self):
        self.src.stop()
        super().tearDown()
        self._poll.stop()

    def test_approval_question_and_subagent_from_real_adapter_events(self):
        rid, key, _ = self.turn("please rm -rf /tmp/x")
        self.assertTrue(wait_for(lambda: self.of(rid, "approval.requested"), 6))
        self.assertTrue(wait_for(lambda: kinds(self.seen, "needs.open"), 4), self.seen)
        need = kinds(self.seen, "needs.open")[0]
        self.assertEqual((need["agent"], need["need"], need["session"], need["provider"]),
                         ("default", "approval", key, "hermes"))
        appr = self.of(rid, "approval.requested")[0]
        self.adapter.approve(self.ref, key, rid, appr["approvalId"], "deny")     # (the fake Hermes only)
        self.assertTrue(wait_for(lambda: kinds(self.seen, "needs.close"), 6), self.seen)
        self.assertEqual(len(kinds(self.seen, "needs.open")), 1)
        no = self.fake.spawn_subagent(key, "Find the bug")
        self.assertTrue(wait_for(lambda: kinds(self.seen, "interns.set"), 6), self.seen)
        self.assertEqual(kinds(self.seen, "interns.set")[0]["count"], 1)
        self.assertTrue(no)

    def test_telegram_and_cron_sessions_bring_a_visitor_and_an_alarm(self):
        self.adapter.agents(CID)
        rid, key, _ = self.turn("[[slow]] hello")       # first report = baseline
        self.assertTrue(wait_for(lambda: [e for e in self.events if e["type"] == "agent.activity" and e["active"]], 6))
        now = time.time()
        for sid, source in (("tg_1", "telegram"), ("cron_1", "cron")):
            self.fake.sessions[sid] = {"id": sid, "profile": "default", "source": source, "title": "",
                                       "messages": [{"id": 1, "role": "user", "content": "x", "timestamp": now}],
                                       "started": now - 5, "last": now - 1, "model": None}
        self.assertTrue(wait_for(lambda: kinds(self.seen, "visitor") and kinds(self.seen, "cron.fire"), 8), self.seen)
        self.assertEqual([(e["channel"], e["session"]) for e in kinds(self.seen, "visitor")], [("telegram", "tg_1")])
        self.assertEqual(kinds(self.seen, "cron.fire")[0]["provider"], "hermes")
        self.end_of(rid, 10)



# ── 10. the L3 -> L4 contract end to end ─────────────────────────────────
class TestSourcesDriveTheClock(unittest.TestCase):
    """A fake Hermes serve run (hub frames through the server's own presence listener) and fake
    OpenClaw runs (gateway frames, live session.tool shape) go through the real presence taps ->
    Sources -> bus -> Scheduler (moods, need expiry) -> journal -> builders: the stand-up names both.
    Sources keep their own thread in the office; here ``drain()`` stands in for it (fake clock)."""

    @classmethod
    def setUpClass(cls):
        os.environ.setdefault("VO_STATUS_DIR", tempfile.mkdtemp(prefix="vo-life-e2e-"))
        import server
        cls.server = server

    def setUp(self):
        import datetime
        import zoneinfo
        from office_life import journal, scheduler, settings
        presence.reset_state_for_tests()
        self.temp = tempfile.TemporaryDirectory()
        zone = zoneinfo.ZoneInfo("America/New_York")
        self.clock = Clock(datetime.datetime(2026, 11, 2, 8, 0, tzinfo=zone).timestamp())     # a Monday
        ctx = self.ctx = office_life.Context()
        ctx.bus = life_bus.LifeBus(clock=self.clock)
        ctx.settings = settings.normalize({"timeZone": "America/New_York"})
        ctx.journal = journal.Journal(self.temp.name, tz_name=ctx.tz_name, clock=self.clock)
        ctx.bus.configure(journal=ctx.journal, roster=ctx.visible_keys, enabled=ctx.enabled)
        self.meetings = []
        ctx.fns = {"roster_rows": lambda: [{"key": "hermy", "name": "Hermy", "providerKind": "hermes"},
                                           {"key": "main", "name": "Claw", "providerKind": "openclaw"}],
                   "presence": lambda: {k: {"state": v.get("state")} for k, v in presence.get_state().items()
                                        if isinstance(v, dict)},
                   "status_key": lambda office_id: office_id, "layout_types": set,
                   "append_meeting_history": lambda record, replace=True: self.meetings.append(record)}
        self.seen = []
        ctx.bus.add_event_listener(lambda ev: self.seen.append(dict(ev)))
        self.hub = ph.ChatHub()
        self.src = S.Sources(ctx, clock=self.clock, presence=presence, hub=self.hub,
                             office_id=lambda cid, native: native)
        self.src.attach()                                       # hub tap first, presence taps, bus listener
        self.hub.add_listener(self.server._hp_presence_listener)  # the server's Hermes serve presence path
        self._ids = mock.patch.object(agent_providers, "office_id_for", lambda cid, native: native)
        self._ids.start()
        self.sched = scheduler.Scheduler(ctx, clock=self.clock).install()

    def tearDown(self):
        self.sched.stop()
        self.src.stop()
        self._ids.stop()
        presence.reset_state_for_tests()
        self.temp.cleanup()

    def step(self, minutes=0.0):
        self.src.drain()                    # the sources thread's turn
        self.clock.advance(minutes * 60)
        self.sched.tick()                   # the clock thread's turn

    def hermes(self, kind, **event):
        self.hub.publish(ph.chat_key("lab", "hermy", "s1"), dict(event, type=kind), run="hr1")

    def openclaw_run(self, run_id, phase_end, tool=None):
        key = "agent:main:main"
        presence._process_event("agent", {"runId": run_id, "sessionKey": key, "stream": "lifecycle",
                                          "data": {"phase": "start"}})
        if tool:
            presence._process_event("session.tool", {"runId": run_id, "stream": "tool", "sessionKey": key,
                                                     "agentId": "main", "session": {"key": key},
                                                     "data": {"phase": "start", "name": tool,
                                                              "toolCallId": f"{run_id}-c1", "args": {}}})
        presence._process_event("agent", {"runId": run_id, "sessionKey": key, "stream": "lifecycle",
                                          "data": {"phase": phase_end}})

    def moods(self, agent):
        return [(e["mood"], e.get("backOnTrack", False)) for e in self.seen
                if e["type"] == "mood" and e["agent"] == agent]

    def test_hermes_and_openclaw_runs_reach_moods_need_expiry_and_the_standup(self):
        self.step()                                                           # boot snapshot
        # Hermes serve: a long run with a tool and an approval card that expires
        expires = int((self.clock() + 120) * 1000)
        self.hermes("run.start", status="running")
        self.hermes("tool.start", toolId="t1", name="terminal", title="ls")
        self.hermes("approval.requested", approvalId="ap1", expiresAt=expires)
        self.step(1)
        self.assertEqual([(e["agent"], e["need"], e["provider"], e["expiresAt"]) for e in kinds(self.seen, "needs.open")],
                         [("hermy", "approval", "hermes", expires)])
        self.step(2)                                                          # expiry is the scheduler's job
        self.assertEqual([(e["ref"], e["outcome"]) for e in kinds(self.seen, "needs.close")], [("ap1", "expired")])
        self.step()
        self.assertNotIn(("hermy", "ap1"), self.src.needs)                    # sources forgot it too
        self.step(14)                                                         # 17 min into the run
        self.assertEqual(self.moods("hermy"), [("focused", False)])
        self.hermes("run.end", status="ok")
        self.step()
        end = [e for e in kinds(self.seen, "run") if e["agent"] == "hermy"][-1]
        self.assertEqual((end["phase"], end["provider"], end["ok"], end["tools"]), ("end", "hermes", True,
                                                                                     {"terminal": 1}))
        self.assertGreaterEqual(end["ms"], 17 * 60000)
        self.assertEqual(self.moods("hermy"), [("focused", False), ("relieved", False)])
        # OpenClaw: one clean run with a tool (live session.tool shape), three failures, then a clean one
        self.openclaw_run("or1", "end", tool="exec")
        for n in (2, 3, 4):
            self.openclaw_run(f"or{n}", "error")
        self.step(1)
        self.assertEqual(self.moods("main"), [("stuck", False)])
        self.openclaw_run("or5", "end")
        self.step(1)
        self.assertEqual(self.moods("main"), [("stuck", False), ("clear", True)])
        runs = [e for e in kinds(self.seen, "run") if e["agent"] == "main" and e["phase"] == "end"]
        self.assertEqual([(e["ref"], e["provider"], e["ok"]) for e in runs],
                         [("or1", "openclaw", True), ("or2", "openclaw", False), ("or3", "openclaw", False),
                          ("or4", "openclaw", False), ("or5", "openclaw", True)])
        self.assertEqual(runs[0]["tools"], {"terminal": 1})
        # an end the provider could not report ("gone", ok absent) never counts as a failure
        for n in range(3):
            self.ctx.bus.publish({"type": "run", "agent": "hermy", "provider": "hermes", "ref": f"g{n}",
                                  "phase": "end", "outcome": "gone", "at": int(self.clock() * 1000)})
        self.step(30)
        self.assertNotIn("stuck", [mood for mood, _back in self.moods("hermy")])
        # the stand-up at 09:30 builds its lines from that journal
        self.clock.t = self.clock.t - (self.clock.t % 60)
        while not kinds(self.seen, "standup.start") and len(self.seen) < 500:
            self.step(5)
        start = kinds(self.seen, "standup.start")[0]
        self.assertEqual((start["status"], start["participants"]), ("open", ["hermy", "main"]))
        lines = {row["agent"]: row["line"] for row in start["lines"]}
        self.assertEqual(lines["hermy"], "Worked through 4 runs, mostly in the terminal")   # 1 + 3 gone, no errors
        self.assertEqual(lines["main"], "Worked through 5 runs, mostly in the terminal")
        self.ctx.journal.flush()
        agents = self.ctx.journal.summary()["agents"]
        self.assertEqual([(agents[k]["runsOk"], agents[k]["runsFailed"], agents[k]["runsCancelled"])
                          for k in ("hermy", "main")], [(1, 0, 3), (2, 3, 0)])
        self.assertEqual(len(self.meetings), 1)
        self.assertEqual(self.meetings[0]["kind"], "standup")
        self.assertEqual(self.meetings[0]["responses"], lines)


if __name__ == "__main__":
    unittest.main()
