"""hp-hermes C1 (rest): reconnect replay, watch + observed turns, presence, tasks, media through the hub, against the
fake `hermes serve` (tests/helpers/fake_hermes.py). 127.0.0.1 ephemeral ports only.

- reconnect mid-turn: the socket drops after a few deltas; the run ends ok with exactly the text of an undisturbed turn
  (nothing lost, nothing twice);
- Hermes restart mid-turn (new replay epoch): the answering run ends interrupted with the S§2.8 text, a message still
  waiting with the restart text; restart after the turn finished unseen: finished from the stored answer;
- approval open across a reconnect: re-asked, answered through approval.respond;
- watch lease: a turn started in Hermes itself in a watched chat is followed live (observed); not watched: nothing;
- presence: agent.activity per profile (own turn, another channel within 75 s, another profile's session ignored);
- tasks: subagent events -> session.task, list chat/agent (+ cron), one, transcript, steer, interrupt, cron refusals;
- media: MEDIA audio/video lines -> kinds + mime; signed link served through the hub, fetched once (cache).
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # tests/ (this file: tests/legacy/)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from test_hp_hermes_adapter import CID, AdapterCase, wait_for  # noqa: E402
from providers import hermes_activity as ha  # noqa: E402
from providers import hermes_adapter as had  # noqa: E402
from providers.hermes_link import HermesError  # noqa: E402


def deltas(events) -> str:
    return "".join(e.get("text") or "" for e in events if e["type"] == "run.delta" and e.get("text"))


class TestReconnect(AdapterCase):
    def test_drop_mid_turn_loses_nothing_and_doubles_nothing(self):
        rid0, key, _ = self.turn("hello")
        self.assertEqual(self.end_of(rid0)["status"], "ok")
        want = deltas(self.of(rid0))
        self.assertTrue(want)
        link = self.adapter._conns[CID].link
        gen = link.gen
        rid, _key, _ = self.turn("[[slow]] hello", key)
        self.assertTrue(wait_for(lambda: len(self.of(rid, "run.delta")) >= 4), self.of(rid))
        self.fake.drop_sockets()
        end = self.end_of(rid, 15)
        self.assertEqual(end["status"], "ok", end)
        self.assertGreater(link.gen, gen)                      # (it really came back on a new socket)
        self.assertEqual(deltas(self.of(rid)), want)
        self.assertEqual(len(self.of(rid, "run.start")), 1)
        self.assertEqual(len(self.of(rid, "run.end")), 1)

    def test_hermes_restart_mid_turn_ends_interrupted(self):
        rid, key, _ = self.turn("[[slow]] hello")
        self.assertTrue(wait_for(lambda: len(self.of(rid, "run.delta")) >= 3), self.of(rid))
        waiting = self.adapter.run(self.ref, key, "and then this", [], "later")
        self.assertEqual(waiting["status"], "queued")
        restarts = self.adapter._conns[CID].link.restarts
        self.fake.restart(epoch="e-restarted")
        end = self.end_of(rid, 15)
        self.assertEqual(end["status"], "interrupted")
        self.assertEqual(end["error"], had.STOPPED_TEXT)
        end2 = self.end_of(waiting["runId"], 5)
        self.assertEqual((end2["status"], end2["error"]), ("interrupted", had.RESTARTED_TEXT))
        self.assertEqual(self.adapter._conns[CID].link.restarts, restarts + 1)
        self.assertFalse(self.adapter.state(self.ref, key)["working"])

    def test_restart_that_stores_the_cut_answer_still_ends_interrupted(self):
        # (real Hermes' exit flush stores the answer cut by its restart, with no finish_reason: lab 0.22.2, D2 QA)
        rid, key, _ = self.turn("[[slow]] hello")
        self.assertTrue(wait_for(lambda: any(len(x.get("partial") or "") > 10 for x in list(self.fake.live.values()))))
        self.fake.restart(epoch="e-cut", flush_partial=True)
        end = self.end_of(rid, 15)
        self.assertTrue(any(m["role"] == "assistant" and m.get("finish_reason") is None
                            for m in self.fake.sessions[key]["messages"]))     # (the cut answer is stored)
        self.assertEqual((end["status"], end["error"]), ("interrupted", had.STOPPED_TEXT), end)
        # the chat saw the reconnect on the answer while it waited, before its end
        phases = [e.get("phase") for e in self.of(rid, "run.status")]
        self.assertIn(had.RECONNECTING_TEXT, phases)
        self.assertLess(self.events.index(next(e for e in self.of(rid, "run.status")
                                               if e.get("phase") == had.RECONNECTING_TEXT)),
                        self.events.index(end))
        self.assertFalse(self.adapter.state(self.ref, key)["working"])

    def test_a_cut_answer_row_is_never_taken_as_the_answer(self):
        c = self.adapter._conns[CID]
        rows = {"messages": [{"id": 4, "role": "user", "content": "q"},
                             {"id": 5, "role": "assistant", "content": "Paragraph 1: The quick", "finish_reason": None}]}
        with mock.patch.object(c.link, "rest", return_value=rows):
            self.assertEqual(self.adapter._stored_answer(c, "k", "default", 4), "")
            rows["messages"][1]["finish_reason"] = "interrupted"
            self.assertEqual(self.adapter._stored_answer(c, "k", "default", 4), "")
            rows["messages"][1]["finish_reason"] = "stop"
            self.assertEqual(self.adapter._stored_answer(c, "k", "default", 4, restarted=True),
                             "Paragraph 1: The quick")
            del rows["messages"][1]["finish_reason"]      # (a Hermes without the field: kept unless it restarted)
            self.assertEqual(self.adapter._stored_answer(c, "k", "default", 4), "Paragraph 1: The quick")
            self.assertEqual(self.adapter._stored_answer(c, "k", "default", 4, restarted=True), "")

    def test_turn_finished_unseen_then_restart_is_finished_from_the_stored_answer(self):
        rid0, key, _ = self.turn("first")
        self.end_of(rid0)
        c = self.adapter._conns[CID]
        sid = c.live[key]["sid"]
        c.link.hold_for(sid)                       # (its events never reach the office: as if the socket were gone)
        rid, _k, _ = self.turn("second please", key)
        self.assertTrue(wait_for(lambda: any(m["role"] == "assistant" and "second please" in m["content"]
                                             for m in self.fake.sessions[key]["messages"])))
        self.assertFalse(self.of(rid, "run.end"))
        self.fake.restart(epoch="e-later")
        end = self.end_of(rid, 15)
        self.assertEqual(end["status"], "ok", end)
        self.assertEqual(end["text"], "Stub answer to: second please")   # (never the earlier answer)

    def test_approval_open_across_a_reconnect_is_asked_again_and_answered(self):
        rid, key, _ = self.turn("please rm -rf /tmp/x")
        self.assertTrue(wait_for(lambda: self.of(rid, "approval.requested")), self.of(rid))
        appr = self.of(rid, "approval.requested")[0]
        gen = self.adapter._conns[CID].link.gen
        self.fake.drop_sockets()
        self.assertTrue(wait_for(lambda: self.adapter._conns[CID].link.gen > gen and
                                 self.adapter.status(CID)["state"] == "connected", 8))
        self.assertTrue(wait_for(lambda: self.adapter.state(self.ref, key)["approvals"], 5))
        # the waiting answer said "reconnecting" while the link was down, then its own line again once back
        self.assertTrue(wait_for(lambda: self.of(rid, "run.status")[-1].get("phase") != had.RECONNECTING_TEXT, 5))
        phases = [e.get("phase") for e in self.of(rid, "run.status")]
        self.assertIn(had.RECONNECTING_TEXT, phases)
        self.assertEqual(phases[-1], "Waiting for your approval", phases)
        self.adapter.approve(self.ref, key, rid, appr["approvalId"], "allow-once")
        self.assertEqual(self.end_of(rid, 10)["status"], "ok")
        self.assertEqual(self.fake.answers[-1]["via"], "approval.respond")
        self.assertEqual(self.fake.answers[-1]["choice"], "once")


class TestWatch(AdapterCase):
    def test_a_turn_started_in_hermes_shows_live_when_watched(self):
        rid0, key, _ = self.turn("mine")
        self.end_of(rid0)
        w = self.adapter.watch(self.ref, key, True)
        self.assertTrue(w["watching"])
        self.fake.foreign_turn(key, "from the desktop")
        self.assertTrue(wait_for(lambda: any(e["type"] == "run.end" and e.get("observed") for e in self.events), 8))
        obs = [e for e in self.events if e.get("observed")]
        run = obs[0]["runId"]
        self.assertTrue(run.startswith("ho-"))
        self.assertEqual(obs[0]["type"], "run.start")
        self.assertEqual(obs[0]["sessionKey"], key)
        end = self.of(run, "run.end")[0]
        self.assertEqual((end["status"], end["text"]), ("ok", "Stub answer to: from the desktop"))
        self.assertTrue(deltas(self.of(run)))
        self.assertTrue(all(e.get("observed") for e in self.of(run)))
        self.assertFalse(self.adapter.state(self.ref, key)["working"])

    def test_not_watched_means_not_followed(self):
        rid0, key, _ = self.turn("mine")
        self.end_of(rid0)
        self.adapter.watch(self.ref, key, True)
        self.adapter.watch(self.ref, key, False)
        n = len(self.events)
        self.fake.foreign_turn(key, "from the desktop")
        time.sleep(1.2)
        self.assertEqual([e for e in self.events[n:] if e.get("runId")], [])

    def test_watch_of_a_chat_hermes_lost_is_refused(self):
        with self.assertRaises(HermesError) as ctx:
            self.adapter.watch(self.ref, "20990101_000001", True)
        self.assertEqual(ctx.exception.code, "not_found")
        self.assertEqual(self.adapter.watch(self.ref, "", True), {"ok": True, "watching": False})

    def test_manifest_offers_tasks_observe_presence(self):
        caps = self.adapter.can(self.ref, None, manage=True)["caps"]
        self.assertTrue(caps["tasks"] and caps["taskSteer"] and caps["observe"] and caps["presence"])


class TestPresence(AdapterCase):
    fake_knobs = {"profiles": [{"name": "default", "is_default": True}, {"name": "research"}]}

    def setUp(self):
        self._poll = mock.patch.object(ha, "POLL_S", 0.3)
        self._poll.start()
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self._poll.stop()

    def activity(self, profile):
        return [e for e in self.events if e["type"] == "agent.activity" and e["agentId"] == profile]

    def test_own_turn_and_other_channels_move_the_agent(self):
        self.adapter.agents(CID)
        rid, key, _ = self.turn("[[slow]] hello")
        self.assertTrue(wait_for(lambda: any(e["active"] and key in e["keys"] for e in self.activity("default")), 6),
                        self.activity("default"))
        on = next(e for e in self.activity("default") if e["active"])
        self.assertEqual(on["connectionId"], CID)
        self.assertNotIn("sessionKey", on)
        self.end_of(rid, 10)
        self.assertTrue(wait_for(lambda: not self.activity("default")[-1]["active"], 6))
        # (a Telegram chat of research's, active 10 s ago; one of default's ended; nothing for research from default's)
        now = time.time()
        self.fake.sessions["tg_1"] = {"id": "tg_1", "profile": "research", "source": "telegram", "title": "Weather",
                                      "messages": [{"id": 1, "role": "user", "content": "rain?", "timestamp": now - 10}],
                                      "started": now - 60, "last": now - 10, "model": None}
        self.assertTrue(wait_for(lambda: self.activity("research") and self.activity("research")[-1]["active"], 6))
        last = self.activity("research")[-1]
        self.assertEqual((last["keys"], last["task"]), (["tg_1"], 'Working on "Weather"'))
        self.assertFalse(any(e["active"] for e in self.activity("default")[-1:]))
        self.fake.sessions["tg_1"]["last"] = now - 200
        self.assertTrue(wait_for(lambda: not self.activity("research")[-1]["active"], 6))

    def test_link_down_reports_everyone_idle(self):
        self.adapter.agents(CID)
        rid, key, _ = self.turn("[[slow]] hello")
        self.assertTrue(wait_for(lambda: any(e["active"] for e in self.activity("default")), 6))
        self.adapter.close(CID, "bye")
        self.assertFalse(self.activity("default")[-1]["active"])


class TestTasks(AdapterCase):
    def test_subagents_are_tasks_of_the_chat_and_the_agent(self):
        rid0, key, _ = self.turn("delegate it")
        self.end_of(rid0)
        no = self.fake.spawn_subagent(key, "Find the bug")
        self.assertTrue(wait_for(lambda: [e for e in self.events if e["type"] == "session.task"], 4))
        ev = [e for e in self.events if e["type"] == "session.task"][-1]
        self.assertEqual((ev["change"], ev["taskId"], ev["agentId"]), ("upserted", no, "default"))
        self.assertEqual(ev["task"]["status"], "running")
        self.assertEqual(ev["task"]["sessionKey"], key)
        self.assertEqual(ev["task"]["lastToolName"], "read")
        self.assertLessEqual(len([e for e in self.events if e["type"] == "session.task"]), 1)   # (two quick: one out)
        chat = self.adapter.tasks(self.ref, key, "chat")
        self.assertEqual([t["id"] for t in chat["active"]], [no])
        self.assertTrue(chat["active"][0]["here"])
        one = self.adapter.task(self.ref, no, key, "chat")["task"]
        self.assertEqual((one["prompt"], one["title"]), ("Find the bug", "Find the bug"))
        hist = self.adapter.task_history(self.ref, no, key, "chat")["messages"]
        self.assertEqual(hist[0]["text"], "Working on: Find the bug")
        st = self.adapter.steer_task(self.ref, no, "also check the tests")
        self.assertTrue(st["steered"])
        self.assertEqual(self.fake.steers[-1]["text"], "also check the tests")
        with self.assertRaises(HermesError):
            self.adapter.steer_task(self.ref, no, "  ")
        agent = self.adapter.tasks(self.ref, None, "agent")
        self.assertIn(no, [t["id"] for t in agent["active"]])
        self.assertIn("cron:j1", [t["id"] for t in agent["active"] + agent["recent"]])
        self.assertEqual(self.adapter.task(self.ref, "cron:j1", None, "agent")["task"]["runtime"], "cron")
        self.assertEqual(self.adapter.task_history(self.ref, "cron:j1", None, "agent"), {"messages": []})
        with self.assertRaises(HermesError) as ctx:
            self.adapter.cancel_task(self.ref, "cron:j1", None, "agent")
        self.assertEqual(ctx.exception.status, 400)
        stop = self.adapter.cancel_task(self.ref, no, key, "chat")
        self.assertTrue(stop["cancelled"])
        self.assertEqual(stop["task"]["status"], "cancelled")
        self.assertTrue(wait_for(lambda: [e for e in self.events if e["type"] == "session.task"
                                          and e["task"]["status"] == "cancelled"], 3))
        self.assertFalse(self.adapter.cancel_task(self.ref, no, key, "chat")["cancelled"])
        done = self.fake.spawn_subagent(key, "Write the notes")
        self.fake.finish_subagent(done, "Notes written")
        self.assertTrue(wait_for(lambda: [e for e in self.events if e["type"] == "session.task"
                                          and e["taskId"] == done and e["task"]["status"] == "completed"], 4))
        recent = self.adapter.tasks(self.ref, key, "chat")["recent"]
        self.assertEqual(recent[0]["id"], done)
        self.assertEqual(recent[0]["terminalSummary"], "Notes written")
        with self.assertRaises(HermesError) as ctx:
            self.adapter.task(self.ref, done, "another-chat", "chat")
        self.assertEqual(ctx.exception.status, 404)
        self.assertEqual(self.adapter.tasks(self.ref, "", "chat"), {"active": [], "recent": []})


class _Handler:
    def __init__(self):
        self.status, self.headers_out, self.wfile, self.headers, self.json = None, {}, io.BytesIO(), {}, None
        self.command = "GET"

    def send_response(self, code):
        self.status = code

    def send_header(self, k, v):
        self.headers_out[k] = v

    def end_headers(self):
        pass

    def _send_json(self, obj, code=200):
        self.status, self.json = code, obj


class TestMedia(AdapterCase):
    def test_audio_and_video_lines_are_served_through_the_hub_cache(self):
        import provider_hub
        self.fake.files["/tmp/song.mp3"] = {"mime": "audio/mpeg", "bytes": b"ID3-song-bytes"}
        self.fake.files["/tmp/clip.mp4"] = {"mime": "video/mp4", "bytes": b"mp4-clip-bytes"}
        for path, kind, mime in (("/tmp/song.mp3", "audio", "audio/mpeg"), ("/tmp/clip.mp4", "video", "video/mp4")):
            rid, key, _ = self.turn(f"make it MEDIA:{path}")
            m = self.end_of(rid)["media"][0]
            self.assertEqual((m["kind"], m["mime"], m["ref"]), (kind, mime, path))
        with tempfile.TemporaryDirectory() as tmp:
            provider_hub.configure_media(tmp)
            calls = []

            def fetch(agent, session, ref):
                calls.append(ref)
                return self.adapter.media(self.ref, session, ref)
            token = provider_hub.sign_media("hermes-hc1", key, "/tmp/clip.mp4")
            for _ in range(2):
                h = _Handler()
                provider_hub.serve_media(h, token, fetch)
                self.assertEqual(h.status, 200, h.json)
                self.assertEqual(h.wfile.getvalue(), b"mp4-clip-bytes")
            self.assertEqual(calls, ["/tmp/clip.mp4"])           # (the second one came from the cache)
            with self.assertRaises(HermesError) as ctx:
                self.adapter.media(self.ref, key, "/tmp/missing.png")
            self.assertEqual(ctx.exception.status, 404)


if __name__ == "__main__":
    unittest.main()
