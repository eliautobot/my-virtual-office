"""Office life clock (L4): stand-up and paper scheduling, moods, needs expiry, rollover, tournaments.

A fake clock is injected everywhere: tests call ``tick(now)`` and never sleep. The real journal,
bus, Meetings history writer and leaderboard games writer are used on temp folders.
"""

import atexit
import datetime
import json
import os
import sys
import tempfile
import unittest
import zoneinfo
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-life-sched-")
atexit.register(_SERVER_DATA.cleanup)
(Path(_SERVER_DATA.name) / "openclaw").mkdir()
os.environ.setdefault("VO_STATUS_DIR", _SERVER_DATA.name)
os.environ.setdefault("VO_CONFIG", str(Path(_SERVER_DATA.name) / "vo-config.json"))
os.environ.setdefault("VO_OPENCLAW_PATH", str(Path(_SERVER_DATA.name) / "openclaw"))
os.environ.setdefault("VO_CODEX_INCLUDE_NATIVE_AGENTS", "0")
os.environ.setdefault("VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS", "0")

TESTS = Path(__file__).resolve().parent
APP_ROOT = TESTS.parents[0] / "app"
for _path in (str(APP_ROOT), str(TESTS)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import server  # noqa: E402
import office_life  # noqa: E402
from office_life import bus as life_bus, journal, routes, scheduler, settings, tournament  # noqa: E402

TZ = "America/New_York"
ZONE = zoneinfo.ZoneInfo(TZ)
KEYS = ("a1", "a2", "a3", "a4")


def at(text, zone=ZONE):
    """Epoch seconds of an office-local ``YYYY-MM-DD HH:MM[:SS]``."""
    fmt = "%Y-%m-%d %H:%M:%S" if text.count(":") == 2 else "%Y-%m-%d %H:%M"
    return datetime.datetime.strptime(text, fmt).replace(tzinfo=zone).timestamp()


class Clock:
    def __init__(self, now):
        self.now = float(now)

    def __call__(self):
        return self.now


class Office:
    """One office process: context, bus, journal and scheduler over a data folder."""

    def __init__(self, data, start, life=None, keys=KEYS, layout=("pingPongTable",)):
        self.clock = Clock(start)
        self.roster = [{"key": key, "name": key.upper(), "providerKind": "openclaw"} for key in keys]
        self.presence = {key: {"state": "idle"} for key in keys}
        self.layout = set(layout)
        ctx = self.ctx = office_life.Context()
        ctx.bus = life_bus.LifeBus(clock=self.clock)
        ctx.settings = settings.normalize(dict({"timeZone": TZ}, **(life or {})))
        ctx.journal = journal.Journal(data, tz_name=ctx.tz_name, clock=self.clock)
        ctx.bus.configure(journal=ctx.journal, roster=ctx.visible_keys, enabled=ctx.enabled)
        ctx.fns = {"roster_rows": lambda: [dict(row) for row in self.roster],
                   "presence": lambda: {k: dict(v) for k, v in self.presence.items()},
                   "layout_types": lambda: set(self.layout),
                   "append_meeting_history": server.append_meeting_history,
                   "record_game": server._record_game_result}
        self.events = []
        ctx.bus.add_event_listener(self.events.append)
        self.sched = scheduler.Scheduler(ctx, clock=self.clock).install()

    def tick(self, when=None):
        if when is not None:
            self.clock.now = float(when)
        return self.sched.tick()

    def run(self, until, step, stop=None):
        while self.clock.now < until:
            self.tick(self.clock.now + step)
            if stop and stop():
                return True
        return False

    def kinds(self, kind):
        return [ev for ev in self.events if ev["type"] == kind]

    def publish(self, **event):
        event.setdefault("at", int(self.clock.now * 1000))
        return self.ctx.bus.publish(event)

    def journal_kinds(self, day, kind):
        return [row for row in self.ctx.journal.read(day)[0] if row["k"] == kind]


class ServerFiles(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)
        self.status = self.data / "status"
        self.status.mkdir()
        self.patches = [mock.patch.object(server, "STATUS_DIR", str(self.status)),
                        mock.patch.object(server, "STATUS_FILE", str(self.status / "agent-status.json")),
                        mock.patch.object(server, "SCORES_FILE", str(self.status / "project-scores.json"))]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def office(self, start, name="life", **kwargs):
        return Office(str(self.data / name), start, **kwargs)

    def history(self):
        return [m for m in server._load_meetings_file().get("_meetingHistory", []) if m.get("kind") == "standup"]


class DueTimeTest(unittest.TestCase):
    def test_due_ms_dst(self):
        self.assertEqual(scheduler.due_ms("2026-03-08", "02:30", ZONE), at("2026-03-08 03:00") * 1000)
        self.assertEqual(scheduler.due_ms("2026-03-08", "09:30", ZONE), at("2026-03-08 09:30") * 1000)
        first = datetime.datetime(2026, 11, 1, 5, 30, tzinfo=datetime.timezone.utc).timestamp() * 1000
        self.assertEqual(scheduler.due_ms("2026-11-01", "01:30", ZONE), first)       # 01:30 EDT, not EST
        self.assertEqual(scheduler.due_ms("2026-11-02", "bad", ZONE), at("2026-11-02 09:30") * 1000)
        self.assertEqual((scheduler.norm_state("BREAK"), scheduler.norm_state("waiting"),
                          scheduler.norm_state("weird")), ("idle", "working", None))


class StandupScheduleTest(ServerFiles):
    def test_weekday_time_once_then_end(self):
        office = self.office(at("2026-11-02 09:29:50"))                             # a Monday
        office.tick()
        office.tick(at("2026-11-02 09:29:55"))
        self.assertEqual(office.kinds("standup.start"), [])
        office.run(at("2026-11-02 09:33"), 5)
        starts, ends = office.kinds("standup.start"), office.kinds("standup.end")
        self.assertEqual(len(starts), 1)
        self.assertEqual((starts[0]["id"], starts[0]["status"], starts[0]["at"]),
                         ("standup-20261102", "open", int(at("2026-11-02 09:30") * 1000)))
        self.assertEqual(len(ends), 1)
        self.assertGreaterEqual(ends[0]["at"], int(at("2026-11-02 09:31:30") * 1000))
        record = self.history()[0]
        self.assertEqual((record["topic"], record["status"], record["endedBy"], record["participants"]),
                         ("Morning stand-up", "completed", "office", list(KEYS)))
        self.assertEqual(record["startedAt"], int(at("2026-11-02 09:30")))
        self.assertEqual(set(record["responses"]), set(KEYS))
        weekend = self.office(at("2026-11-07 09:00"), name="weekend")               # a Saturday
        weekend.run(at("2026-11-07 12:00"), 60)
        self.assertEqual(weekend.kinds("standup.start"), [])

    def test_standup_named_by_its_time_of_day(self):
        # v0.11 relux (playtest #9): a stand-up started at 18:26 is not a "Morning stand-up" (office time zone)
        from office_life import templates as T
        self.assertEqual([T.standup_topic(h) for h in (5, 11, 12, 16, 17, 21, 22, 0, 4, None)],
                         ["Morning stand-up"] * 2 + ["Afternoon stand-up"] * 2 + ["Evening stand-up"] * 2
                         + ["Night stand-up"] * 3 + ["Morning stand-up"])
        office = self.office(at("2026-11-02 18:26"), name="evening")
        result = office.sched.run_standup(int(at("2026-11-02 18:26") * 1000), manual=True)
        self.assertTrue(result.get("started"), result)
        record = self.history()[0]
        self.assertEqual((record["topic"], record["purpose"]), ("Evening stand-up", "Evening stand-up"))

    def test_grace_catch_up_and_too_late(self):
        late = self.office(at("2026-11-03 11:00"), name="late")                    # server was down at 09:30
        late.tick()
        self.assertEqual(len(late.kinds("standup.start")), 1)
        too_late = self.office(at("2026-11-03 11:30:05"), name="too-late")
        too_late.run(at("2026-11-03 13:00"), 60)
        self.assertEqual(too_late.kinds("standup.start"), [])

    def test_dst_spring_forward_fires_once_at_three(self):
        office = self.office(at("2026-03-08 00:00"), life={"standup": {"time": "02:30", "days": [1, 2, 3, 4, 5, 6, 7]}})
        office.run(at("2026-03-08 05:00"), 60)
        starts = office.kinds("standup.start")
        self.assertEqual(len(starts), 1)
        local = datetime.datetime.fromtimestamp(starts[0]["at"] / 1000, ZONE)
        self.assertEqual((local.hour, local.minute), (3, 0))

    def test_dst_fall_back_no_double(self):
        office = self.office(at("2026-11-01 00:00"), life={"standup": {"time": "01:30", "days": [1, 2, 3, 4, 5, 6, 7]}})
        end = datetime.datetime(2026, 11, 1, 8, 30, tzinfo=datetime.timezone.utc).timestamp()   # 03:30 EST
        office.run(end, 60)
        starts = office.kinds("standup.start")
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0]["at"], scheduler.due_ms("2026-11-01", "01:30", ZONE))

    def test_restart_mid_standup_writes_one_record(self):
        first = self.office(at("2026-11-02 09:30"))
        first.tick()
        self.assertEqual(len(first.kinds("standup.start")), 1)
        second = self.office(at("2026-11-02 09:30:40"))                              # same data folder
        second.run(at("2026-11-02 09:40"), 5)
        self.assertEqual(second.kinds("standup.start"), [])
        self.assertEqual([ev["id"] for ev in second.kinds("standup.end")], ["standup-20261102"])
        self.assertEqual(len(self.history()), 1)
        # a crash after the Meetings record but before the state was saved: the rerun replaces it
        crash = self.office(at("2026-11-03 09:30"), name="crash")
        with mock.patch.object(crash.ctx.journal, "save_state", lambda state: None):
            crash.tick()
        again = self.office(at("2026-11-03 09:31"), name="crash")
        again.tick()
        self.assertEqual(len(again.kinds("standup.start")), 1)
        self.assertEqual([m["id"] for m in self.history()], ["standup-20261102", "standup-20261103"])

    def test_manual_now_lines_since_last_and_refusals(self):
        office = self.office(at("2026-11-02 09:00"))
        office.tick()
        office.publish(type="task.done", agent="a1", title="Before", taskId="t0")
        office.run(at("2026-11-02 09:35"), 5)                                        # 09:30 stand-up
        self.assertEqual(self.history()[0]["responses"]["a1"], "Finished 1 task: Before")
        office.tick(at("2026-11-02 10:00"))
        office.publish(type="task.done", agent="a1", title="After", taskId="t1")
        office.tick(at("2026-11-02 14:00"))
        result = office.ctx.actions["standup_now"]()
        self.assertEqual((result["started"], result["id"]), (True, "standup-20261102-140000"))
        self.assertEqual(self.history()[-1]["responses"]["a1"], "Finished 1 task: After")
        with self.assertRaises(routes.LifeError) as busy:
            office.ctx.actions["standup_now"]()
        self.assertEqual((busy.exception.status, busy.exception.payload["error"]), (409, "busy"))
        office.ctx.settings["features"]["standup"] = False
        office.tick(at("2026-11-02 14:05"))
        with self.assertRaises(routes.LifeError) as off:
            office.ctx.actions["standup_now"]()
        self.assertEqual(off.exception.payload["error"], "off")
        early = self.office(at("2026-11-03 08:00"), name="early")                   # manual before the time
        early.tick()
        early.ctx.actions["standup_now"]()
        early.run(at("2026-11-03 09:35"), 5)
        self.assertEqual([ev["id"] for ev in early.kinds("standup.start")],
                         ["standup-20261103-080000", "standup-20261103"])

    def test_nobody_around_skips_once(self):
        unknown = self.office(at("2026-11-02 09:30"), name="unknown")
        unknown.ctx.fns["roster_rows"] = lambda: None                             # roster unreadable: wait
        unknown.run(at("2026-11-02 09:31"), 5)
        self.assertEqual(unknown.kinds("standup.start"), [])
        self.assertNotIn("lastStandupDay", unknown.sched.state)
        office = self.office(at("2026-11-02 09:29"))
        for key in KEYS:
            office.presence[key]["state"] = "offline"
        office.run(at("2026-11-02 10:00"), 5)
        rows = office.journal_kinds("2026-11-02", "standup.start")
        self.assertEqual([row["d"]["status"] for row in rows], ["skipped"])
        self.assertEqual(rows[0]["d"]["summary"], "Stand-up skipped: nobody was around")
        self.assertEqual(self.history(), [])
        self.assertEqual(office.sched.state["lastStandupDay"], "2026-11-02")


class PaperScheduleTest(ServerFiles):
    def test_paper_at_time_once(self):
        office = self.office(at("2026-11-02 17:59:50"))
        office.tick()
        office.publish(type="task.done", agent="a2", title="Report", taskId="r1")
        office.tick(at("2026-11-02 17:59:55"))
        self.assertIsNone(office.ctx.journal.load_paper("2026-11-02"))
        office.run(at("2026-11-02 18:10"), 5)
        self.assertEqual([ev["day"] for ev in office.kinds("paper.ready")], ["2026-11-02"])
        paper = office.ctx.journal.load_paper("2026-11-02")
        self.assertEqual((paper["headline"], paper["mvp"]["agent"]), ("1 task done across the office", "a2"))
        self.assertEqual(office.sched.state["lastPaperDay"], "2026-11-02")

    def test_same_day_catch_up_after_downtime(self):
        office = self.office(at("2026-11-02 20:00"))
        office.tick()
        self.assertEqual(len(office.kinds("paper.ready")), 1)
        self.assertIsNotNone(office.ctx.journal.load_paper("2026-11-02"))

    def test_late_paper_for_yesterday_only_with_a_journal(self):
        day1 = self.office(at("2026-11-02 10:00"))
        day1.tick()
        day1.publish(type="visitor", agent="a1", channel="telegram")
        day1.ctx.journal.flush()                                                     # server stops at 10:00
        day2 = self.office(at("2026-11-03 08:00"))
        day2.tick()
        paper = day2.ctx.journal.load_paper("2026-11-02")
        self.assertEqual(paper["headline"], "1 message handled from Telegram")
        self.assertEqual(day2.kinds("paper.ready"), [])                              # quiet: no announcement
        self.assertIsNone(day2.ctx.journal.load_paper("2026-11-03"))
        fresh = self.office(at("2026-11-03 08:00"), name="fresh")
        fresh.tick()
        self.assertIsNone(fresh.ctx.journal.load_paper("2026-11-02"))                 # no journal, no paper
        self.assertNotIn("2026-11-02", [d["day"] for d in fresh.ctx.journal.days()])

    def test_now_and_preview(self):
        office = self.office(at("2026-11-02 12:00"))
        office.tick()
        office.publish(type="cron.fire", agent="a3", ref="job", runAt=1)
        preview = office.ctx.actions["paper_preview"]("2026-11-02")
        self.assertEqual(preview["stats"][-1], {"label": "Scheduled jobs", "value": "1"})
        self.assertIsNone(office.ctx.journal.load_paper("2026-11-02"))
        self.assertEqual(office.ctx.actions["paper_now"](), {"made": True, "day": "2026-11-02"})
        self.assertIsNotNone(office.ctx.journal.load_paper("2026-11-02"))
        self.assertEqual(len(office.kinds("paper.ready")), 1)
        office.ctx.settings["features"]["newspaper"] = False
        with self.assertRaises(routes.LifeError):
            office.ctx.actions["paper_now"]()


class ClockPartsTest(ServerFiles):
    def test_presence_diff_and_rollover(self):
        office = self.office(at("2026-11-02 23:58"), life={"journal": {"retentionDays": 1}})
        office.tick()
        office.presence["a1"]["state"] = "working"                                # server-normalized
        office.presence["a2"] = {"state": "break"}
        office.tick(at("2026-11-02 23:58:05"))
        rows = office.journal_kinds("2026-11-02", "state")
        self.assertEqual([(r["a"], r["d"].get("from"), r["d"]["to"]) for r in rows[-1:]], [("a1", "idle", "working")])
        self.assertEqual(len(rows), 5)                                               # snapshot of 4 + one change
        self.assertNotIn("state", [frame["event"]["type"] for frame in office.ctx.bus._rings.get(life_bus.LIFE_KEY, [])])
        office.tick(at("2026-11-03 00:00:01"))
        self.assertEqual([ev["day"] for ev in office.kinds("day")], ["2026-11-03"])
        self.assertEqual(len(office.journal_kinds("2026-11-03", "state")), 4)       # the new day opens with a snapshot
        self.assertEqual([d["day"] for d in office.ctx.journal.days()], ["2026-11-03"])   # retention 1 pruned

    def test_moods_from_runs(self):
        office = self.office(at("2026-11-02 10:00"))
        office.tick()
        office.publish(type="run", agent="a1", phase="start", ref="r1")
        office.tick(at("2026-11-02 10:14"))
        self.assertEqual(office.kinds("mood"), [])
        office.tick(at("2026-11-02 10:15"))
        self.assertEqual([ev["mood"] for ev in office.kinds("mood")], ["focused"])
        office.tick(at("2026-11-02 10:20"))
        office.publish(type="run", agent="a1", phase="end", ref="r1", ok=True, ms=20 * 60000)
        office.tick(at("2026-11-02 10:20:05"))
        office.tick(at("2026-11-02 10:20:10"))
        self.assertEqual([ev["mood"] for ev in office.kinds("mood")], ["focused", "relieved", "clear"])
        for n, outcome in enumerate(("error", "cancelled", "timed_out", "error")):
            office.publish(type="run", agent="a2", phase="end", ref=f"f{n}", ok=False, outcome=outcome, ms=1000)
        office.publish(type="run", agent="a2", phase="end", ref="ok", ok=True, ms=1000)
        moods = [(ev["agent"], ev["mood"], ev.get("backOnTrack")) for ev in office.kinds("mood")][3:]
        self.assertEqual(moods, [("a2", "stuck", None), ("a2", "clear", True)])
        for n in range(3):
            office.publish(type="run", agent="a3", phase="end", ref=f"x{n}", ok=False, outcome="error", ms=1000)
        office.tick(at("2026-11-02 14:21"))                                          # 4 h without a new failure
        self.assertEqual([ev["mood"] for ev in office.kinds("mood") if ev["agent"] == "a3"], ["stuck", "clear"])

    def test_presence_fallback_and_moods_off(self):
        office = self.office(at("2026-11-02 10:00"))
        office.tick()
        office.presence["a4"]["state"] = "working"
        office.tick(at("2026-11-02 10:00:05"))
        office.tick(at("2026-11-02 10:15:05"))
        office.presence["a4"]["state"] = "idle"
        office.tick(at("2026-11-02 10:30"))
        self.assertEqual([ev["mood"] for ev in office.kinds("mood")], ["focused", "clear"])
        quiet = self.office(at("2026-11-02 10:00"), name="quiet", life={"features": {"moods": False}})
        quiet.tick()
        quiet.publish(type="run", agent="a1", phase="start", ref="r1")
        quiet.tick(at("2026-11-02 11:00"))
        self.assertEqual(quiet.kinds("mood"), [])

    def test_need_expiry(self):
        office = self.office(at("2026-11-02 10:00"))
        office.tick()
        now = int(at("2026-11-02 10:00") * 1000)
        office.publish(type="needs.open", agent="a1", ref="ap1", need="approval", expiresAt=now + 60000)
        office.publish(type="needs.open", agent="a2", need="question")                # no ref, no expiry
        office.tick(at("2026-11-02 10:00:55"))
        self.assertEqual(office.kinds("needs.close"), [])
        office.tick(at("2026-11-02 10:01:05"))
        self.assertEqual([(ev["agent"], ev["outcome"]) for ev in office.kinds("needs.close")], [("a1", "expired")])
        office.tick(at("2026-11-02 22:01"))
        self.assertEqual([ev["agent"] for ev in office.kinds("needs.close")], ["a1", "a2"])
        self.assertEqual(office.ctx.bus.open_needs(), [])


class TournamentFlowTest(ServerFiles):
    def play(self, office, day="2026-11-02", until="17:00", meddle=None):
        """Idle from 11:00, then 60 s steps until a start, 5 s steps until the end."""
        office.tick(at(f"{day} 11:00"))
        office.run(at(f"{day} {until}"), 60, stop=lambda: office.kinds("tournament.start"))
        while not office.kinds("tournament.end") and office.clock.now < at(f"{day} 18:00"):
            office.tick(office.clock.now + 5)
            if meddle:
                meddle(office)
        return office

    def summary(self, office):
        start = office.kinds("tournament.start")[0]
        matches = [(m["match"], m.get("p1"), m.get("p2"), m["winner"], m.get("score"), m.get("walkover"))
                   for m in office.kinds("tournament.match")]
        return start["players"], start["bracket"], matches, office.kinds("tournament.end")[0]

    def test_full_tournament_deterministic_and_work_score_untouched(self):
        server._award_points("a1", 10, "Completed: one")
        before = json.loads(Path(server.SCORES_FILE).read_text())["agents"]["a1"]
        office = self.play(self.office(at("2026-11-02 11:00")))
        players, bracket, matches, end = self.summary(office)
        self.assertEqual(len(players), 4)
        self.assertEqual([m[0] for m in matches], [1, 2, 3])
        self.assertTrue(all(not m[5] for m in matches))
        final = matches[-1]
        self.assertEqual({final[1], final[2]}, {matches[0][3], matches[1][3]})
        self.assertEqual((end["status"], end["champion"]), ("done", final[3]))
        start = office.kinds("tournament.start")[0]
        self.assertEqual((start["id"], start["game"]), ("tour-20261102-1", "pong"))
        local = datetime.datetime.fromtimestamp(start["at"] / 1000, ZONE)
        self.assertTrue(12 <= local.hour < 15, local)
        scores = json.loads(Path(server.SCORES_FILE).read_text())["agents"]
        for key in ("score", "completed", "streak", "history", "lastCompleted"):
            self.assertEqual(json.dumps(scores["a1"][key]), json.dumps(before[key]))
        games = {key: scores[key]["games"] for key in KEYS}
        self.assertEqual(sum(g["played"] for g in games.values()), 6)
        self.assertEqual(sum(g["wins"] for g in games.values()), 3)
        self.assertEqual(games[end["champion"]]["titles"], 1)
        self.assertEqual(office.ctx.journal.summary("2026-11-02")["office"]["champion"], end["champion"])
        twin = self.play(self.office(at("2026-11-02 11:00"), name="twin"))
        self.assertEqual(self.summary(twin), (players, bracket, matches, dict(end, at=twin.kinds("tournament.end")[0]["at"])))

    def test_forfeits_before_and_during_matches(self):
        def before(office):                                    # semi 2's first player goes to work early
            start = office.kinds("tournament.start")
            if start and not [m for m in office.kinds("tournament.match") if m["match"] == 2]:
                second = start[0]["bracket"]["matches"][1]
                office.presence[second["p1"]]["state"] = "working"
        office = self.play(self.office(at("2026-11-02 11:00")), meddle=before)
        matches = office.kinds("tournament.match")
        second = office.kinds("tournament.start")[0]["bracket"]["matches"][1]
        walk = [m for m in matches if m["match"] == 2]
        self.assertEqual([(m["winner"], m["walkover"], "score" in m) for m in walk], [(second["p2"], True, False)])
        games = json.loads(Path(server.SCORES_FILE).read_text())["agents"]
        self.assertNotIn(second["p1"], games)

        def during(office):                                    # the decided winner of match 1 leaves mid-match
            live = [m for m in office.kinds("tournament.match") if m["match"] == 1]
            if len(live) == 1 and office.clock.now * 1000 > live[0]["startsAt"] + 5000:
                office.presence[live[0]["winner"]]["state"] = "working"
        other = self.play(self.office(at("2026-11-02 11:00"), name="during"), meddle=during)
        first = [m for m in other.kinds("tournament.match") if m["match"] == 1]
        self.assertEqual(len(first), 2)
        loser = first[0]["p2"] if first[0]["winner"] == first[0]["p1"] else first[0]["p1"]
        self.assertEqual((first[1]["winner"], first[1]["walkover"]), (loser, True))
        self.assertLess(first[1]["at"], first[0]["startsAt"] + tournament.MATCH_MS)

    def test_unplayable_final_is_called_off(self):
        def both_leave(office):
            if office.kinds("tournament.start") and office.kinds("tournament.match"):
                for key in ("a1", "a2"):
                    office.presence[key]["state"] = "working"
        office = self.play(self.office(at("2026-11-02 11:00"), keys=("a1", "a2")), meddle=both_leave)
        end = office.kinds("tournament.end")[0]
        self.assertEqual((end["status"], end.get("champion")), ("called_off", None))
        scores = json.loads(Path(server.SCORES_FILE).read_text())["agents"] if Path(server.SCORES_FILE).exists() else {}
        self.assertFalse(any((row.get("games") or {}).get("titles") for row in scores.values()))

    def test_no_tournament_unless_everything_fits(self):
        cases = {"calm": {"life": {"calm": True}}, "off": {"life": {"features": {"tournaments": False}}},
                 "frequency": {"life": {"tournaments": {"frequency": "off"}}}, "furniture": {"layout": ("desk",)},
                 "alone": {"keys": ("a1",)}}
        for name, kwargs in cases.items():
            office = self.play(self.office(at("2026-11-02 11:00"), name=name, **kwargs))
            self.assertEqual(office.kinds("tournament.start"), [], name)
        busy = self.office(at("2026-11-02 11:00"), name="busy")
        busy.tick()
        for key in ("a1", "a2", "a3"):
            busy.presence[key]["state"] = "working"
        busy.publish(type="needs.open", agent="a4", ref="n", need="approval")
        busy.run(at("2026-11-02 17:00"), 60)
        self.assertEqual(busy.kinds("tournament.start"), [])
        restless = self.office(at("2026-11-02 11:00"), name="restless")
        restless.tick()
        flip = {"n": 0}
        while restless.clock.now < at("2026-11-02 17:00"):                         # idle never lasts 10 min
            flip["n"] += 1
            for key in KEYS:
                restless.presence[key]["state"] = "working" if flip["n"] % 8 == 0 else "idle"
            restless.tick(restless.clock.now + 60)
        self.assertEqual(restless.kinds("tournament.start"), [])
        meeting = self.office(at("2026-11-02 12:00"), name="standup", life={"standup": {"time": "12:00"}})
        meeting.tick()
        meeting.sched.state["openStandup"] = {"id": "standup-x", "endsAt": int(at("2026-11-02 23:00") * 1000)}
        meeting.run(at("2026-11-02 17:00"), 60)
        self.assertEqual(meeting.kinds("tournament.start"), [])

    def test_restart_and_settings_call_off(self):
        office = self.office(at("2026-11-02 11:00"))
        office.tick()
        office.run(at("2026-11-02 17:00"), 60, stop=lambda: office.kinds("tournament.start"))
        restarted = self.office(office.clock.now + 20)
        restarted.run(at("2026-11-02 17:00"), 60)
        self.assertEqual([(ev["id"], ev["status"]) for ev in restarted.kinds("tournament.end")],
                         [("tour-20261102-1", "called_off")])
        self.assertEqual(restarted.kinds("tournament.start"), [])                    # the window is used
        calm = self.office(at("2026-11-02 11:00"), name="calm")
        calm.tick()
        calm.run(at("2026-11-02 17:00"), 60, stop=lambda: calm.kinds("tournament.start"))
        calm.ctx.settings["calm"] = True
        calm.tick(calm.clock.now + 5)
        self.assertEqual(calm.kinds("tournament.end")[0]["status"], "called_off")
        self.assertNotIn("openTournament", calm.ctx.journal.load_state())

    def test_twice_a_day_and_test_injector(self):
        office = self.office(at("2026-11-02 10:00"), life={"tournaments": {"frequency": "twice"}})
        office.tick()
        office.run(at("2026-11-02 17:00"), 30)
        self.assertEqual([ev["id"] for ev in office.kinds("tournament.start")], ["tour-20261102-1", "tour-20261102-2"])
        self.assertEqual(len(office.kinds("tournament.end")), 2)
        quick = self.office(at("2026-11-03 09:00"), name="quick", layout=("dartBoard",))
        quick.tick()
        result = quick.ctx.actions["test:tournament"]({"players": ["a3", "a1", "nobody"]})
        self.assertTrue(result["started"])
        start = quick.kinds("tournament.start")[0]
        self.assertEqual((start["players"], start["game"]), (["a3", "a1"], "darts"))


class ThreadTest(unittest.TestCase):
    def test_start_stop_idempotent_and_actions(self):
        with tempfile.TemporaryDirectory() as temp:
            office = Office(temp, at("2026-11-02 10:00"))
            office.ctx.journal = journal.Journal(temp, tz_name=office.ctx.tz_name, clock=office.clock)
            previous = scheduler.SCHEDULER
            scheduler.SCHEDULER = None
            try:
                started = scheduler.start(office.ctx)
                self.assertIs(scheduler.start(office.ctx), started)
                self.assertTrue(started._thread.is_alive())
                self.assertEqual({"standup_now", "paper_now", "paper_preview", "test:tick", "test:tournament"}
                                 - set(office.ctx.actions), set())
                ticks = []
                scheduler.add_tick(ticks.append)
                started.tick()
                scheduler.stop()
                scheduler.stop()
                self.assertIsNone(started._thread)
                self.assertTrue(ticks)                                                # real clock in the thread
            finally:
                scheduler.TICKS.clear()
                scheduler.SCHEDULER = previous


if __name__ == "__main__":
    unittest.main()
