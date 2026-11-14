"""hp-hermes B2: the Hermes adapter against the fake `hermes serve` (tests/helpers/fake_hermes.py).

Covers design phase B2: agents (setup dropped), can, sessions (list, rename, delete = close then DELETE), history, runs
(new chat tagged virtual-office, resume, prefs only when changed, submit, redirect, queued, merged queue, steered), stop,
approvals (same-socket answer), questions (clarify, secret never in an event), models + prefs (confirm_required),
attachments, answer media, close ends runs with the reason. 127.0.0.1 ephemeral ports only.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
for extra in (os.path.join(HERE, "..", "app"), os.path.join(HERE, "helpers")):
    extra = os.path.abspath(extra)
    if extra not in sys.path:
        sys.path.insert(0, extra)

from fake_hermes import FILE_PNG, FakeHermes  # noqa: E402
from providers.hermes_adapter import HermesAdapter  # noqa: E402
from providers.hermes_link import HermesError  # noqa: E402
from agent_providers import AgentRef  # noqa: E402

CID = "hc1"
SECRET = "ghp_TOPSECRET_value_123"


def wait_for(predicate, timeout=6.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class AdapterCase(unittest.TestCase):
    fake_knobs: dict = {}

    def setUp(self):
        self.fake = FakeHermes(**self.fake_knobs).start()
        self.record = {"id": CID, "url": self.fake.url, "auth": "token", "enabled": True}
        self.adapter = HermesAdapter(connection=lambda cid: dict(self.record) if cid == CID else None,
                                     secrets=lambda cid: {"token": self.fake.token},
                                     persist=lambda *a: None,
                                     media_url=lambda agent, session, ref: f"/m/{agent}/{session}/{ref}")
        self.events = []
        self._ev_lock = threading.Lock()
        self.adapter.on_event(self._collect)
        self.ref = AgentRef("default", "hermes-hc1", CID, "hermes", "hermes-serve")
        self.assertTrue(wait_for(lambda: self.adapter.status(CID)["state"] == "connected"), self.adapter.status(CID))

    def tearDown(self):
        self.adapter.close(CID, "test over")
        self.fake.stop()

    def _collect(self, e):
        with self._ev_lock:
            self.events.append(json.loads(json.dumps(e)))

    def of(self, run_id, type_=None):
        with self._ev_lock:
            return [e for e in self.events if e.get("runId") == run_id and (type_ is None or e["type"] == type_)]

    def end_of(self, run_id, timeout=8.0):
        self.assertTrue(wait_for(lambda: self.of(run_id, "run.end"), timeout), [e["type"] for e in self.of(run_id)])
        return self.of(run_id, "run.end")[0]

    def turn(self, text, key="", **kw):
        r = self.adapter.run(self.ref, key, text, [], None, **kw)
        return r["runId"], r["session"]["key"], r


class TestAgentsAndManifest(AdapterCase):
    fake_knobs = {"profiles": [{"name": "default", "is_default": True},
                               {"name": "research", "display_name": "Researcher", "ui_meta": {"emoji": "R"}},
                               {"name": "wizard", "role": "setup"}]}

    def test_profiles_are_agents_without_setup(self):
        agents = self.adapter.agents(CID)
        self.assertEqual([a["profile"] for a in agents], ["default", "research"])
        self.assertEqual(agents[1]["displayName"], "Researcher")
        self.assertEqual(agents[1]["emoji"], "R")
        self.assertTrue(agents[0]["default"])

    def test_can_offers_the_hermes_serve_column(self):
        m = self.adapter.can(self.ref, None, manage=True)
        self.assertTrue(m["ok"])
        self.assertEqual(m["view"], "hermes")
        caps = m["caps"]
        self.assertEqual(caps["approvalOptions"], ["allow-once", "allow-session", "allow-always", "deny"])
        self.assertEqual(caps["queue"], "redirect")
        for name in ("sessions", "history", "stop", "models", "effort", "questions", "secrets", "plan", "media",
                     "attachments", "titles", "sessionDelete", "tasks", "taskSteer", "observe", "presence"):
            self.assertTrue(caps[name], name)
        # Chat only (no level saved): attachments + the Files tab reads; screen and file writes locked with 3.6 texts
        self.assertTrue(caps["files"] and caps["computer"])
        for name in ("browser", "screen", "computerWrite"):
            self.assertFalse(caps[name], name)
        self.assertEqual(sorted(m["locked"]), ["computerWrite", "screen"])
        self.assertIn("chat only", m["locked"]["screen"])
        self.assertIn("Full access", m["locked"]["screen"])
        self.assertIn("Chat only access: files on", m["locked"]["computerWrite"])
        self.assertFalse(self.adapter.can(self.ref, None, manage=False)["caps"]["sessionDelete"])
        # Full access: the Bot Desktop and file writes too, nothing locked (as files()/screen_*() serve them)
        self.record["access"] = "full"
        f = self.adapter.can(self.ref, None, manage=True)
        for name in ("files", "computer", "computerWrite", "screen"):
            self.assertTrue(f["caps"][name], name)
        self.assertFalse(f["caps"]["browser"])
        self.assertEqual(f["locked"], {})

    def test_can_when_hermes_is_gone(self):
        self.fake.stop()
        self.adapter.close(CID, "test")
        self.record["url"] = "http://127.0.0.1:9"
        self.assertTrue(wait_for(lambda: self.adapter.status(CID)["state"] not in ("connecting", "connected")))
        m = self.adapter.can(self.ref, None)
        self.assertFalse(m["ok"])
        self.assertEqual(m["reason"], "offline")

    def test_switched_off_connection_refuses(self):
        self.record["enabled"] = False
        with self.assertRaises(HermesError) as cm:
            self.adapter.sessions(self.ref)
        self.assertEqual(cm.exception.code, "offline")


class TestTurns(AdapterCase):
    def test_full_turn_with_tool_and_approval_allow_session(self):
        run_id, key, r = self.turn("please rm -rf /tmp/old-logs")
        self.assertEqual(r["status"], "started")
        self.assertTrue(key)
        self.assertEqual(self.fake.sessions[key]["source"], "virtual-office")
        self.assertTrue(wait_for(lambda: self.of(run_id, "approval.requested")))
        ap = self.of(run_id, "approval.requested")[0]
        types = [e["type"] for e in self.of(run_id)]
        self.assertEqual(types[0], "run.start")
        self.assertLess(types.index("tool.start"), types.index("approval.requested"))
        self.assertEqual(ap["options"], ["allow-once", "allow-session", "allow-always", "deny"])
        for e in self.of(run_id):
            self.assertEqual((e["connectionId"], e["agentId"], e["sessionKey"]), (CID, "default", key))
        st = self.adapter.state(self.ref, key)
        self.assertTrue(st["working"])
        self.assertEqual([a["approvalId"] for a in st["approvals"]], [ap["approvalId"]])
        self.assertEqual(self.adapter.approve(self.ref, key, run_id, ap["approvalId"], "allow-session")["ok"], True)
        end = self.end_of(run_id)
        self.assertEqual(end["status"], "ok")
        self.assertEqual(self.fake.last_answer, {"choice": "session"})
        res = self.of(run_id, "approval.resolved")
        self.assertEqual(res[0]["decision"], "allow-session")
        self.assertEqual(self.of(run_id, "tool.end")[0]["name"], "terminal")
        self.assertEqual(self.adapter.state(self.ref, key)["approvals"], [])
        with self.assertRaises(HermesError) as cm:
            self.adapter.approve(self.ref, key, run_id, ap["approvalId"], "deny")
        self.assertEqual((cm.exception.code, cm.exception.status), ("not_pending", 409))

    def test_clarify_answered(self):
        run_id, key, _ = self.turn("[[tool:clarify]] pick a colour")
        self.assertTrue(wait_for(lambda: self.of(run_id, "question.requested")))
        q = self.of(run_id, "question.requested")[0]
        self.assertEqual([x["questionId"] for x in q["questions"]], ["q0", "q1"])
        self.assertEqual(self.adapter.state(self.ref, key)["questions"][0]["questionId"], q["questionId"])
        self.adapter.answer(self.ref, key, run_id, q["questionId"], {"q0": ["Blue"], "q1": ["Soon", "please"]})
        self.assertEqual(self.end_of(run_id)["status"], "ok")
        self.assertEqual(self.fake.last_answer, {"answers": {"q0": "Blue", "q1": "Soon, please"}})
        self.assertEqual(self.of(run_id, "question.resolved")[0]["status"], "answered")

    def test_secret_answer_is_never_in_an_event(self):
        run_id, key, _ = self.turn("[[secret]] use my token")
        self.assertTrue(wait_for(lambda: self.of(run_id, "question.requested")))
        q = self.of(run_id, "question.requested")[0]
        self.assertTrue(q["questions"][0]["secret"])
        self.adapter.answer(self.ref, key, run_id, q["questionId"], {"value": SECRET})
        end = self.end_of(run_id)
        self.assertEqual(end["text"], "Got it (secret given).")
        self.assertEqual(self.fake.last_answer, {"value": SECRET})
        self.assertNotIn(SECRET, json.dumps(self.events))
        self.assertNotIn(SECRET, json.dumps(self.adapter.state(self.ref, key)))

    def test_stop_ends_stopped(self):
        run_id, key, _ = self.turn("[[slow]] write a long story")
        self.assertTrue(wait_for(lambda: len(self.of(run_id)) > 2))
        self.assertEqual(self.adapter.stop(self.ref, key, run_id), {"ok": True})
        self.assertEqual(self.end_of(run_id)["status"], "stopped")
        self.assertIn("rpc session.interrupt", self.fake.calls)

    def test_redirect_while_busy(self):
        first, key, _ = self.turn("[[slow]] first job")
        self.assertTrue(wait_for(lambda: len(self.of(first)) > 2))
        r = self.adapter.run(self.ref, key, "also check the second thing", [], "redirect")
        self.assertEqual(r["status"], "redirected")
        second = r["runId"]
        self.assertEqual([e["type"] for e in self.of(second)], ["run.start", "run.end"])
        self.assertTrue(self.of(second, "run.end")[0]["steered"])
        end = self.end_of(first)
        self.assertEqual(end["status"], "ok")
        self.assertIn("second thing", end["text"])
        self.assertIn("rpc session.redirect", self.fake.calls)

    def test_merged_queue_gives_one_turn_and_one_steered(self):
        first, key, _ = self.turn("[[slow]] first job")
        self.assertTrue(wait_for(lambda: len(self.of(first)) > 2))
        a = self.adapter.run(self.ref, key, "then b", [], "later")
        b = self.adapter.run(self.ref, key, "and c", [], "later")
        self.assertEqual((a["status"], b["status"]), ("queued", "steered"))
        self.assertEqual(self.of(a["runId"], "run.start")[0].get("status"), "queued")
        self.assertTrue(self.of(b["runId"], "run.end")[0]["steered"])
        self.assertEqual(self.end_of(first)["status"], "ok")
        end = self.end_of(a["runId"])
        self.assertEqual(end["status"], "ok")
        self.assertIn("then b", end["text"])
        self.assertIn("and c", end["text"])
        self.assertEqual(len(self.of(b["runId"])), 2)
        submits = [p for _n, m, p in self.fake.rpc if m == "prompt.submit"]
        self.assertEqual([p.get("queued") for p in submits], [None, True, True])

    def test_close_ends_open_runs_with_the_reason(self):
        run_id, _key, _ = self.turn("[[slow]] a long one")
        self.assertTrue(wait_for(lambda: len(self.of(run_id)) > 2))
        self.adapter.close(CID, "The connection was removed")
        end = self.of(run_id, "run.end")[0]
        self.assertEqual((end["status"], end["error"]), ("interrupted", "The connection was removed"))


class TestSessionsModelsFiles(AdapterCase):
    fake_knobs = {"confirm_models": ("stub-2",)}

    def test_sessions_history_rename_delete(self):
        run_id, key, _ = self.turn("hello there")
        self.assertEqual(self.end_of(run_id)["text"], "Stub answer to: hello there")
        rows = self.adapter.sessions(self.ref)["sessions"]
        self.assertEqual([r["key"] for r in rows], [key])
        h = self.adapter.history(self.ref, key)
        self.assertEqual([m["role"] for m in h["messages"]], ["user", "assistant"])
        self.assertEqual(h["messages"][1]["text"], "Stub answer to: hello there")
        self.assertFalse(h["running"])
        self.assertEqual(self.adapter.history(self.ref, "")["messages"], [])
        self.adapter.session_op(self.ref, "rename", key, {"title": "Greeting"})
        self.assertEqual(self.fake.sessions[key]["title"], "Greeting")
        with self._ev_lock:
            titles = [e for e in self.events if e["type"] == "native" and e.get("op") == "title"]
        self.assertEqual(titles[-1]["title"], "Greeting")
        n = len(self.fake.calls)
        self.adapter.session_op(self.ref, "delete", key, {})
        later = self.fake.calls[n:]
        self.assertLess(later.index("rpc session.close"), next(i for i, c in enumerate(later) if c.startswith("DELETE")))
        self.assertNotIn(key, self.fake.sessions)
        self.assertEqual(self.adapter.sessions(self.ref)["sessions"], [])

    def test_models_and_prefs_only_when_changed(self):
        m = self.adapter.models(self.ref)
        ids = [x["id"] for x in m["models"]]
        self.assertIn("custom:stub-1", ids)
        self.assertEqual(m["current"], "custom:stub-1")
        run_id, key, _ = self.turn("hi")
        self.end_of(run_id)
        self.adapter.set_prefs(self.ref, key, model="custom:stub-1", effort="high")
        self.adapter.set_prefs(self.ref, key, model="custom:stub-1", effort="high")
        sets = [(s["key"], s["value"]) for s in self.fake.config_sets]
        self.assertEqual(sets, [("model", "stub-1 --provider custom --session"), ("reasoning", "high")])
        self.assertEqual(self.adapter.models(self.ref, key)["effort"], "high")
        with self.assertRaises(HermesError) as cm:
            self.adapter.set_prefs(self.ref, key, model="custom:stub-2")
        self.assertEqual((cm.exception.code, cm.exception.status), ("confirm_required", 409))
        self.assertIn("expensive", cm.exception.detail)

    def test_new_chat_takes_the_prefs_kept_for_it(self):
        self.assertEqual(self.adapter.set_prefs(self.ref, "", model="custom:stub-1", effort="low")["effort"], "low")
        self.assertEqual(self.adapter.can(self.ref, None)["prefs"], {"model": "custom:stub-1", "effort": "low"})
        run_id, key, _ = self.turn("hi")
        self.end_of(run_id)
        self.assertEqual((self.fake.sessions[key]["model"], self.fake.sessions[key]["effort"]), ("stub-1", "low"))
        self.assertEqual(self.adapter.state(self.ref, key)["effort"], "low")

    def test_attachments(self):
        tmp = tempfile.mkdtemp(prefix="vo-hp-hermes-")
        png, txt = os.path.join(tmp, "shot.png"), os.path.join(tmp, "notes.txt")
        with open(png, "wb") as f:
            f.write(FILE_PNG)
        with open(txt, "w") as f:
            f.write("some notes")
        r = self.adapter.run(self.ref, "", "look at these", [
            {"path": png, "name": "shot.png", "mime": "image/png", "size": len(FILE_PNG)},
            {"path": txt, "name": "notes.txt", "mime": "text/plain", "size": 10}], None)
        self.end_of(r["runId"])
        self.assertEqual([(a["kind"], a.get("filename") or a.get("name")) for a in self.fake.attached],
                         [("image", "shot.png"), ("file", "notes.txt")])
        first = self.fake.sessions[r["session"]["key"]]["messages"][0]["content"]
        self.assertEqual(first, "look at these\n\n@file:/ws/notes.txt")

    def test_answer_media_is_split_and_fetched(self):
        run_id, key, _ = self.turn("draw it MEDIA:/tmp/chart.png")
        end = self.end_of(run_id)
        self.assertEqual(end["media"], [{"kind": "image", "name": "chart.png", "mime": "image/png",
                                         "ref": "/tmp/chart.png"}])
        # (the echo keeps its MEDIA: mid-line; only the line of its own became the medium)
        self.assertEqual(end["text"], "Stub answer to: draw it MEDIA:/tmp/chart.png")
        data, ctype = self.adapter.media(self.ref, key, "/tmp/chart.png")
        self.assertEqual((data, ctype), (FILE_PNG, "image/png"))
        with self.assertRaises(HermesError):
            self.adapter.media(self.ref, key, "https://example.com/x.png")
        msg = self.adapter.history(self.ref, key)["messages"][-1]
        self.assertEqual(msg["media"][0]["url"], f"/m/hermes-hc1/{key}//tmp/chart.png")  # (signed for the office agent id)


class TestHubContract(AdapterCase):
    """The adapter's events through hp-core's publish_event into the ChatHub: the /state snapshot reads them back."""

    def test_events_fill_the_hub_snapshot(self):
        import agent_providers
        import provider_hub
        # (hc1 is no stored connection: when `server` was imported first, STATE.store is set and office_id_for answers
        # '' for it, so media would get no signed link; the office id is pinned here, as a stored record would give it)
        pin = mock.patch.object(agent_providers, "office_id_for",
                                lambda cid, native: f"hermes-{cid}" if cid == CID else "")
        pin.start()
        self.addCleanup(pin.stop)
        self.adapter.on_event(lambda e: agent_providers.publish_event("hermes", e))
        run_id, key, _ = self.turn("please rm -rf /tmp/old-logs")
        self.assertTrue(wait_for(lambda: self.of(run_id, "approval.requested")))
        ap = self.of(run_id, "approval.requested")[0]
        chat = provider_hub.chat_key(CID, "default", key)
        snap = provider_hub.HUB.snapshot(chat)
        self.assertEqual(snap["runs"][0]["approvals"][0]["approvalId"], ap["approvalId"])
        self.assertTrue(snap["working"])
        self.adapter.approve(self.ref, key, run_id, ap["approvalId"], "allow-once")
        self.end_of(run_id)
        run = provider_hub.HUB.snapshot(chat)["runs"][0]
        self.assertEqual((run["runId"], run["status"]), (run_id, "ok"))
        self.assertTrue(run["text"])
        self.assertEqual(run["approvals"][0]["status"], "allow-once")
        self.assertEqual(run["tools"][0]["name"], "terminal")
        self.adapter.session_op(self.ref, "rename", key, {"title": "Cleanup"})
        self.assertEqual(provider_hub.HUB.snapshot(chat)["title"], "Cleanup")
        media_run, _k, _ = self.turn("draw MEDIA:/tmp/chart.png", key=key)
        self.end_of(media_run)
        last = [r for r in provider_hub.HUB.snapshot(chat)["runs"] if r["runId"] == media_run][0]
        self.assertTrue(last["media"][0]["url"].startswith("/api/agent-chat/media?t="))
        self.assertNotIn("/tmp/chart.png", last["media"][0]["url"])


if __name__ == "__main__":
    unittest.main()
