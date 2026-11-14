"""Office life server core (design .work/life/design.md, phase L1): events, bus, journal,
settings, routes and the server.py wiring. No model, no provider, no shared home is touched."""

import atexit
import datetime
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_SERVER_DATA = tempfile.TemporaryDirectory(prefix="vo-life-core-")
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
import provider_hub  # noqa: E402
import vo_access  # noqa: E402
import office_life  # noqa: E402
from office_life import bus as life_bus, events, journal, routes, settings  # noqa: E402


def ms(text):
    return int(datetime.datetime.fromisoformat(text).timestamp() * 1000)


class Clock:
    def __init__(self, start):
        self.now = start

    def __call__(self):
        return self.now


# ── events + bus ─────────────────────────────────────────────────────────
class EventsTest(unittest.TestCase):
    def test_whitelist_clips_and_drops(self):
        ev = events.make("visitor", "main", channel="Telegram", provider="openclaw", text="secret body",
                         sender="+15550001111", session="agent:main:telegram:dm:42")
        self.assertEqual(ev["channel"], "telegram")
        self.assertNotIn("text", ev)
        self.assertNotIn("sender", ev)
        self.assertIsNone(events.make("visitor", "main", channel="webchat"))      # not an outside channel
        self.assertIsNone(events.make("visitor", "main", channel="virtual-office"))
        self.assertIsNone(events.make("needs.open", None, need="approval"))       # agent required
        self.assertIsNone(events.make("bogus.kind", "main"))
        self.assertIsNone(events.make("handoff", "a", to="a"))                    # no handoff to itself
        task = events.make("task.done", "a", title="x" * 90, taskId="t1")
        self.assertEqual(len(task["title"]), 60)
        self.assertTrue(task["title"].endswith("…"))
        self.assertNotIn("mood", events.make("mood", "a", mood="angry"))             # closed enum

    def test_journal_row_never_holds_session_keys(self):
        ev = events.make("visitor", "main", channel="sms", session="agent:main:sms:+15550001111",
                         ref="agent:main:sms:+15550001111")
        row = events.journal_row(ev)
        self.assertNotIn("+1555", json.dumps(row))
        self.assertEqual(events.from_journal_row(row)["channel"], "sms")

    def test_tool_kinds_match_the_client_buckets(self):
        self.assertEqual([events.tool_kind(n) for n in ("exec", "browser_navigate", "web_search", "edit_file",
                                                        "sessions_send", "weird")],
                         ["terminal", "browser", "search", "editor", "message", "other"])


class BusTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock(time.time())
        self.journal = journal.Journal(self.temp.name, clock=self.clock)
        self.visible = {"a", "b", "c"}
        self.enabled = True
        self.bus = life_bus.LifeBus(journal=self.journal, roster=lambda: self.visible,
                                    enabled=lambda: self.enabled, clock=self.clock)

    def tearDown(self):
        self.temp.cleanup()

    def pub(self, **ev):
        return self.bus.publish(ev)

    def test_dedupe_ttl(self):
        self.assertIsNotNone(self.pub(type="visitor", agent="a", channel="telegram"))
        self.assertIsNone(self.pub(type="visitor", agent="a", channel="telegram"))
        self.assertIsNotNone(self.pub(type="visitor", agent="a", channel="discord"))
        self.clock.now += 61
        self.assertIsNotNone(self.pub(type="visitor", agent="a", channel="telegram"))
        self.assertIsNotNone(self.pub(type="cron.fire", agent="a", ref="job1", runAt=1000))
        self.assertIsNone(self.pub(type="cron.fire", agent="a", ref="job1", runAt=1000))
        self.assertIsNotNone(self.pub(type="cron.done", agent="a", ref="job1", runAt=1000, ok=True))

    def test_needs_until_close_and_open_state(self):
        self.assertIsNotNone(self.pub(type="needs.open", agent="a", ref="ap1", need="approval"))
        self.assertIsNone(self.pub(type="needs.open", agent="a", ref="ap1", need="approval"))
        self.assertEqual([n["ref"] for n in self.bus.open_state()["needs"]], ["ap1"])
        self.assertIsNotNone(self.pub(type="needs.close", agent="a", ref="ap1", outcome="answered"))
        self.assertIsNone(self.pub(type="needs.close", agent="a", ref="ap1", outcome="answered"))
        self.assertEqual(self.bus.open_state()["needs"], [])
        self.assertIsNotNone(self.pub(type="needs.open", agent="a", ref="ap1", need="approval"))  # re-asked

    def test_tournament_forfeit_mid_match_takes_the_counted_win_back(self):
        """The pre-decided winner leaves mid-match: the walkover for the same match undoes the played
        game and the win counted at its start (the leaderboard records nothing for that match)."""
        day = self.journal.today()
        self.pub(type="tournament.start", id="tour-1", game="pong", players=["a", "b", "c"])
        self.pub(type="tournament.match", id="tour-1", match=1, round=1, p1="a", p2="b", winner="a", score=[11, 7],
                 walkover=False, ms=40000)
        self.assertIsNotNone(self.pub(type="tournament.match", id="tour-1", match=1, round=1, p1="a", p2="b",
                                      winner="b", walkover=True))
        self.pub(type="tournament.match", id="tour-1", match=2, round=2, p1="b", winner="b", walkover=True)  # bye
        self.pub(type="tournament.match", id="tour-1", match=3, round=2, p1="b", p2="c", winner="c", score=[9, 11],
                 walkover=False, ms=40000)
        self.pub(type="tournament.end", id="tour-1", champion="c", status="done")
        self.journal.flush()
        agents = self.journal.summary(day)["agents"]
        games = {key: (row["games"]["played"], row["games"]["wins"], row["games"]["titles"])
                 for key, row in agents.items() if key in ("a", "b", "c")}
        self.assertEqual(games, {"a": (0, 0, 0), "b": (1, 0, 0), "c": (1, 1, 1)})
        reloaded = journal.Journal(self.temp.name, clock=self.clock).summary(day)["agents"]
        self.assertEqual((reloaded["a"]["games"]["wins"], reloaded["b"]["games"]["played"]), (0, 1))

    def test_ref_less_need_opens_and_closes_the_same_slot(self):
        """A provider without request ids opens a need with no ``ref``: every close shape finds it."""
        day = self.journal.today()
        for close in ({}, {"need": "question"}, {"ref": "question"}):
            self.assertIsNotNone(self.pub(type="needs.open", agent="b", need="question"))
            self.assertIsNone(self.pub(type="needs.open", agent="b", need="question"))       # still open
            self.assertEqual([n["need"] for n in self.bus.open_needs("b")], ["question"])
            self.clock.now += 30
            frame = self.pub(type="needs.close", agent="b", outcome="answered", **close)
            self.assertIsNotNone(frame, close)
            self.assertEqual((frame["event"]["ref"], frame["event"]["need"]), ("question", "question"))
            self.assertEqual(self.bus.open_needs("b"), [])
            self.assertIsNone(self.pub(type="needs.close", agent="b", outcome="answered", **close))
        # a ref-less close picks only a ref-less need of the agent (and of the asked kind)
        self.pub(type="needs.open", agent="c", ref="ap9", need="approval")
        self.pub(type="needs.open", agent="c", need="input")
        self.assertIsNone(self.pub(type="needs.close", agent="c", need="approval", outcome="answered"))
        self.assertEqual(self.pub(type="needs.close", agent="c", outcome="expired")["event"]["ref"], "input")
        self.assertEqual([n["ref"] for n in self.bus.open_needs("c")], ["ap9"])
        self.journal.flush()
        needs = self.journal.summary(day)["agents"]["b"]["needs"]
        self.assertEqual((needs["count"], needs["answered"], needs["waitMs"]), (3, 3, 90_000))

    def test_interns_and_moods_compare_per_agent(self):
        self.assertIsNone(self.pub(type="interns.set", agent="a", count=0))
        self.assertIsNotNone(self.pub(type="interns.set", agent="a", count=3, shown=2))
        self.assertIsNone(self.pub(type="interns.set", agent="a", count=3, shown=2))
        self.assertIsNotNone(self.pub(type="mood", agent="b", mood="focused"))
        self.assertIsNone(self.pub(type="mood", agent="b", mood="focused"))
        self.assertEqual(self.bus.open_state()["interns"], {"a": 3})
        self.assertEqual(self.bus.open_state()["moods"], {"b": "focused"})
        self.assertIsNotNone(self.pub(type="mood", agent="b", mood="clear"))
        self.assertEqual(self.bus.open_state()["moods"], {})

    def test_roster_filter_drops_hidden_agents(self):
        self.assertIsNone(self.pub(type="visitor", agent="zed", channel="sms"))
        self.assertIsNone(self.pub(type="handoff", agent="a", to="zed", via="send"))
        frame = self.pub(type="project.done", title="P", agents=["a", "zed"], ref="p1")
        self.assertEqual(frame["event"]["agents"], ["a"])
        frame = self.pub(type="standup.start", id="standup-1", lines=[{"agent": "a", "line": "hi"},
                                                                     {"agent": "zed", "line": "x"}])
        self.assertEqual([r["agent"] for r in frame["event"]["lines"]], ["a"])
        self.assertEqual(self.journal.summary()["agents"].get("zed"), None)

    def test_disabled_drops_everything_but_settings(self):
        self.enabled = False
        self.assertIsNone(self.pub(type="visitor", agent="a", channel="sms"))
        self.assertIsNotNone(self.pub(type="settings", settings={"enabled": False}))

    def test_journal_only_kinds_are_not_streamed(self):
        sub = self.bus.subscribe([life_bus.LIFE_KEY], since=self.bus.seq)
        out = self.pub(type="run", agent="a", ref="r1", phase="end", ok=True, ms=500, tools={"terminal": 2})
        self.assertEqual(out["event"]["type"], "run")
        self.assertIsNone(self.pub(type="run", agent="a", ref="r1", phase="end", ok=True))
        self.pub(type="visitor", agent="a", channel="sms")
        frame = sub.get(timeout=1)
        self.assertEqual(frame["event"]["type"], "visitor")
        self.assertEqual(self.journal.summary()["agents"]["a"]["runsOk"], 1)
        self.assertEqual(self.journal.summary()["agents"]["a"]["tools"], {"terminal": 2})

    def test_cheers_count_only_for_open_matches(self):
        self.assertIsNone(self.bus.count_cheer("t1", 0, "a"))
        self.pub(type="tournament.start", id="t1", game="pong", players=["a", "b"])
        self.pub(type="tournament.match", id="t1", match=0, round=1, p1="a", p2="b")
        self.assertEqual(self.bus.count_cheer("t1", 0, "a"), 1)
        self.assertEqual(self.bus.count_cheer("t1", 0, "a"), 2)
        self.assertIsNone(self.bus.count_cheer("t1", 0, "c"))
        self.assertEqual(self.bus.open_state()["tournament"]["cheers"], [{"match": 0, "agent": "a", "count": 2}])
        self.pub(type="tournament.end", id="t1", champion="a", status="done")
        self.assertNotIn("tournament", self.bus.open_state())

    def test_ttl_map_is_bounded(self):
        self.bus.ttl_max = 50
        for index in range(200):
            self.pub(type="handoff", agent="a", to="b", via="send", ref=f"r{index}")
        self.assertLessEqual(len(self.bus._ttl), 50)


# ── journal ──────────────────────────────────────────────────────────────
class JournalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = Clock(ms("2026-11-02T15:00:00+00:00") / 1000)
        self.jr = journal.Journal(self.temp.name, tz_name=lambda: "America/New_York", clock=self.clock,
                                  line_cap=5, byte_cap=10_000)

    def tearDown(self):
        self.temp.cleanup()

    def test_dst_day_boundaries_new_york(self):
        jr = self.jr
        self.assertEqual(jr.day_of(ms("2026-03-08T04:59:59+00:00")), "2026-03-07")
        self.assertEqual(jr.day_of(ms("2026-03-08T05:00:00+00:00")), "2026-03-08")   # midnight EST
        self.assertEqual(jr.day_of(ms("2026-03-09T03:59:59+00:00")), "2026-03-08")   # 23:59 EDT
        self.assertEqual(jr.day_of(ms("2026-03-09T04:00:00+00:00")), "2026-03-09")
        start, end = jr.day_bounds("2026-03-08")
        self.assertEqual((end - start) / 3600000, 23)
        self.assertEqual(jr.day_of(ms("2026-11-01T03:59:59+00:00")), "2026-10-31")
        self.assertEqual(jr.day_of(ms("2026-11-01T04:00:00+00:00")), "2026-11-01")   # midnight EDT
        self.assertEqual(jr.day_of(ms("2026-11-02T04:59:59+00:00")), "2026-11-01")   # 23:59 EST
        self.assertEqual(jr.day_of(ms("2026-11-02T05:00:00+00:00")), "2026-11-02")
        start, end = jr.day_bounds("2026-11-01")
        self.assertEqual((end - start) / 3600000, 25)
        self.assertEqual(start, ms("2026-11-01T04:00:00+00:00"))

    def test_events_land_on_their_office_day(self):
        self.jr.append(events.make("visitor", "a", channel="sms", at=ms("2026-11-01T04:30:00+00:00")))
        self.jr.append(events.make("visitor", "a", channel="sms", at=ms("2026-11-02T04:30:00+00:00")))
        self.jr.append(events.make("visitor", "a", channel="sms", at=ms("2026-11-02T05:30:00+00:00")))
        self.assertEqual(len(self.jr.read("2026-11-01")[0]), 2)
        self.assertEqual(len(self.jr.read("2026-11-02")[0]), 1)

    def test_caps_keep_priority_kinds_and_count_drops(self):
        at = ms("2026-11-02T14:00:00+00:00")
        kept = [self.jr.append(events.make("visitor", "a", channel="sms", at=at + i)) for i in range(7)]
        self.assertEqual(kept, [True] * 5 + [False] * 2)
        self.assertTrue(self.jr.append(events.make("task.done", "a", title="T", taskId="t1", at=at)))
        self.assertTrue(self.jr.append(events.make("needs.open", "a", need="approval", ref="x", at=at)))
        for i in range(10):
            self.jr.append(events.make("task.done", "a", title="T", taskId=f"x{i}", at=at))
        rows, _ = self.jr.read("2026-11-02")
        self.assertEqual(len(rows), 10)                       # hard stop at twice the cap
        office = self.jr.summary("2026-11-02")["office"]
        self.assertEqual(office["dropped"], 2 + 7)

    def test_torn_line_and_paging(self):
        at = ms("2026-11-02T14:00:00+00:00")
        for i in range(3):
            self.jr.append(events.make("handoff", "a", to="b", via="send", ref=f"r{i}", at=at + i))
        with open(self.jr._path("2026-11-02"), "a", encoding="utf-8") as handle:
            handle.write('{"t":1,"k":"vis')                   # crash mid-write
        rows, nxt = self.jr.read("2026-11-02", limit=2)
        self.assertEqual((len(rows), nxt), (2, 2))
        rows, nxt = self.jr.read("2026-11-02", after=nxt, limit=2)
        self.assertEqual((len(rows), nxt), (1, None))
        self.assertEqual(self.jr.summary()["agents"]["a"]["handoffsOut"], {"b": 3})
        self.assertEqual(self.jr.summary()["agents"]["b"]["handoffsIn"], {"a": 3})

    def test_summary_flush_is_atomic_and_reloads(self):
        at = ms("2026-11-02T14:00:00+00:00")
        self.jr.append(events.make("needs.open", "a", need="approval", ref="q", at=at))
        self.jr.append(events.make("needs.close", "a", outcome="answered", ref="q", at=at + 4000))
        self.jr.flush()
        again = journal.Journal(self.temp.name, tz_name=lambda: "America/New_York", clock=self.clock)
        needs = again.summary("2026-11-02")["agents"]["a"]["needs"]
        self.assertEqual(needs, {"count": 1, "answered": 1, "waitMs": 4000})
        self.assertEqual([n for n in os.listdir(self.jr.dir) if n.startswith(".tmp")], [])

    def test_prune_by_retention_and_folder_cap(self):
        for day in ("2026-10-01", "2026-10-25", "2026-10-30", "2026-11-01", "2026-11-02"):
            Path(self.jr.dir).mkdir(parents=True, exist_ok=True)
            Path(self.jr._path(day)).write_text("x" * 1000)
        Path(self.jr.papers_dir).mkdir(parents=True, exist_ok=True)
        Path(self.jr.paper_path("2026-10-01")).write_text("{}")
        removed = self.jr.prune(14, today="2026-11-02")
        self.assertEqual(removed, ["2026-10-01"])
        self.assertFalse(os.path.exists(self.jr.paper_path("2026-10-01")))
        self.jr.folder_cap = 2500
        removed = self.jr.prune(14, today="2026-11-02")
        self.assertEqual(removed, ["2026-10-25", "2026-10-30"])
        self.assertTrue(os.path.exists(self.jr._path("2026-11-02")))

    def test_old_and_future_events_are_refused(self):
        self.assertFalse(self.jr.append(events.make("visitor", "a", channel="sms",
                                                    at=ms("2026-10-20T12:00:00+00:00"))))
        self.assertFalse(self.jr.append(events.make("visitor", "a", channel="sms",
                                                    at=ms("2026-11-05T12:00:00+00:00"))))


# ── settings ─────────────────────────────────────────────────────────────
class SettingsTest(unittest.TestCase):
    def test_interns_max_shown(self):
        # 0.12.0: the office-wide safety cap on intern characters (one per running helper below it)
        self.assertEqual(settings.defaults()["interns"], {"maxShown": 24})
        for value, want in ((30, 30), (100, 48), (0, 1), (12.7, 12)):
            merged, errors = settings.validate({"interns": {"maxShown": value}})
            self.assertEqual((errors, merged["interns"]["maxShown"]), ([], want), value)
        for bad in ("x", True, None, float("nan"), float("inf")):
            _merged, errors = settings.validate({"interns": {"maxShown": bad}})
            self.assertEqual([e["field"] for e in errors], ["interns.maxShown"], bad)
        self.assertEqual(settings.normalize({"interns": {"maxShown": "lots"}})["interns"]["maxShown"], 24)

    def test_validation(self):
        merged, errors = settings.validate({"calm": True, "standup": {"time": "7:05", "days": [5, 1, 1]},
                                            "journal": {"retentionDays": 99}, "unknown": 1,
                                            "seasons": {"custom": [{"name": "Launch day", "date": "02-29",
                                                                    "icon": "cake"}]}})
        self.assertEqual(errors, [])
        self.assertEqual(merged["standup"], {"time": "07:05", "days": [1, 5]})
        self.assertEqual(merged["journal"]["retentionDays"], 60)
        self.assertNotIn("unknown", merged)
        self.assertTrue(merged["features"]["needsYou"])       # untouched defaults stay
        _merged, errors = settings.validate({"standup": {"time": "25:00", "days": [0]}, "timeZone": "Mars/Base",
                                             "tournaments": {"frequency": "hourly"}, "enabled": "yes",
                                             "seasons": {"custom": [{"name": "", "date": "13-01"}] }})
        self.assertEqual(sorted(e["field"] for e in errors),
                         ["enabled", "seasons.custom.0.date", "seasons.custom.0.name", "standup.days",
                          "standup.time", "timeZone", "tournaments.frequency"])
        _merged, errors = settings.validate({"seasons": {"custom": [{"name": "n", "date": "01-01"}] * 13}})
        self.assertEqual(errors[0]["field"], "seasons.custom")

    def test_normalize_and_time_zone(self):
        stored = settings.normalize({"standup": {"time": "bad", "days": [2]}, "calm": True, "timeZone": "Nope/X"})
        self.assertEqual((stored["standup"], stored["calm"], stored["timeZone"]),
                         ({"time": "09:30", "days": [2]}, True, ""))
        self.assertEqual(settings.office_tz({"timeZone": "Europe/Paris"}, {}), "Europe/Paris")
        self.assertEqual(settings.office_tz({}, {"TZ": ":America/Chicago"}), "America/Chicago")
        self.assertEqual(settings.office_tz({}, {"VO_TIMEZONE": "bogus"}), "UTC")

    def test_calm_keeps_the_cake_and_signs_but_not_tournaments(self):
        """Design 7.4: Calm keeps signs, icons and decor (cake included); it removes walks, confetti, tournaments."""
        with tempfile.TemporaryDirectory() as temp:
            clock = Clock(time.time())
            jr = journal.Journal(temp, clock=clock)
            jr.append(events.make("project.done", title="Launch", ref="p1", agents=["a"]))
            for calm in (False, True):
                life = settings.normalize({"calm": calm})
                with mock.patch.object(office_life.CTX, "journal", jr), \
                        mock.patch.object(office_life.CTX, "settings", life):
                    self.assertTrue(office_life.today_info()["cake"], calm)
            off = settings.normalize({"calm": True, "features": {"celebrations": False}})
            with mock.patch.object(office_life.CTX, "journal", jr), mock.patch.object(office_life.CTX, "settings", off):
                self.assertFalse(office_life.today_info()["cake"])
            bus = life_bus.LifeBus(journal=jr, clock=clock)
            self.assertIsNotNone(bus.publish({"type": "needs.open", "agent": "a", "ref": "q1", "need": "question"}))
        from office_life import tournament
        calm_ctx = office_life.Context()
        calm_ctx.settings = settings.normalize({"calm": True})
        self.assertFalse(tournament.Tournaments(calm_ctx, {}, lambda: None).allowed())

    def test_birthdays_from_created_at(self):
        tz = journal.zone("America/New_York")
        rows = [{"key": "s", "createdAt": ms("2024-11-02T15:00:00+00:00") // 1000},   # seconds
                {"key": "m", "createdAt": ms("2023-11-02T15:00:00+00:00")},           # ms
                {"key": "iso", "createdAt": "2025-11-02T12:00:00Z"},
                {"key": "late", "createdAt": "2025-11-03T03:00:00Z"},   # Nov 2 22:00 in New York
                {"key": "new", "createdAt": "2026-11-02T12:00:00Z"},    # not a year old
                {"key": "none"}]
        self.assertEqual(office_life.birthdays(rows, datetime.date(2026, 11, 2), tz),
                         {"s": 2, "m": 3, "iso": 1, "late": 1})
        leap = [{"key": "leap", "createdAt": "2024-02-29T12:00:00Z"}]
        self.assertEqual(office_life.birthdays(leap, datetime.date(2026, 2, 28), datetime.timezone.utc), {"leap": 2})
        self.assertEqual(office_life.birthdays(leap, datetime.date(2028, 2, 28), datetime.timezone.utc), {})


# ── routes + server wiring ───────────────────────────────────────────────
class _Handler:
    def __init__(self, ip, headers=None):
        self.client_address = (ip, 1234)
        self.headers = headers or {}


class RoutesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.status = Path(self.temp.name)
        (self.status / "openclaw").mkdir()
        self.cfg_path = self.status / "vo-config.json"
        self.cfg_path.write_text(json.dumps({"_setupComplete": True, "office": {"name": "Test office"}}))
        self.store = vo_access.AccessStore(str(self.status))
        self.rows = [{"key": k, "name": k.title(), "providerKind": "openclaw"} for k in ("a", "b", "c")]
        self.patches = [
            mock.patch.object(server, "STATUS_DIR", str(self.status)),
            mock.patch.object(server, "ACCESS_STORE", self.store),
            mock.patch.dict(os.environ, {"VO_STATUS_DIR": str(self.status), "VO_CONFIG": str(self.cfg_path)}),
            mock.patch.object(provider_hub, "HEARTBEAT_SEC", 0.3),
        ]
        for p in self.patches:
            p.start()
        ctx = office_life.CTX
        self.saved_ctx = (dict(ctx.fns), ctx.journal, ctx.settings, dict(ctx.actions))
        ctx.fns.update(config_path=server._life_config_path, config_lock=server._json_file_lock,
                       read_json=server._life_read_config_for_save,
                       write_json=lambda path, data: server._write_json_atomic(path, data, mode=0o600),
                       roster_rows=lambda: [dict(r) for r in self.rows])
        ctx.journal = journal.Journal(str(self.status / "office-life"), tz_name=ctx.tz_name)
        ctx.settings = settings.defaults()
        ctx.actions = {}
        life_bus.BUS.reset()
        life_bus.BUS.configure(journal=ctx.journal, roster=ctx.visible_keys, enabled=ctx.enabled)
        self.httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", 0), server.OfficeHandler)
        self.httpd.block_on_close = False
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        ctx = office_life.CTX
        ctx.fns.clear()
        ctx.fns.update(self.saved_ctx[0])
        ctx.journal, ctx.settings, ctx.actions = self.saved_ctx[1], self.saved_ctx[2], self.saved_ctx[3]
        life_bus.BUS.reset()
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        hdrs = {"Content-Type": "application/json"} if data else {}
        hdrs.update(headers or {})
        conn.request(method, path, body=data, headers=hdrs)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        try:
            return res.status, json.loads(raw.decode("utf-8"))
        except ValueError:
            return res.status, raw

    def test_state_route(self):
        life_bus.BUS.publish({"type": "needs.open", "agent": "a", "ref": "ap1", "need": "approval",
                              "session": "agent:a:main"})
        life_bus.BUS.publish({"type": "needs.open", "agent": "zed", "ref": "ap2", "need": "approval"})
        status, out = self.request("GET", "/api/office-life/state")
        self.assertEqual(status, 200, out)
        self.assertEqual(out["tz"], "UTC")
        self.assertEqual([n["agent"] for n in out["open"]["needs"]], ["a"])
        self.assertEqual(out["open"]["needs"][0]["session"], "agent:a:main")
        self.assertEqual(out["settings"]["standup"]["time"], "09:30")
        self.assertEqual(out["paper"], {"day": out["day"], "ready": False, "news": False})
        self.assertEqual(out["today"]["birthdays"], [])
        self.assertEqual(out["seq"], life_bus.BUS.seq)

    def test_stream_sends_retry_heartbeat_and_frames(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", f"/api/office-life/stream?since={life_bus.BUS.seq}")
        res = conn.getresponse()
        self.assertEqual(res.status, 200)
        self.assertTrue(res.getheader("Content-Type").startswith("text/event-stream"))
        lines = []

        def read():
            try:
                for raw in iter(res.fp.readline, b""):
                    lines.append(raw.decode("utf-8").rstrip("\n"))
            except OSError:
                pass
        threading.Thread(target=read, daemon=True).start()
        time.sleep(0.2)
        life_bus.BUS.publish({"type": "visitor", "agent": "b", "channel": "discord"})
        deadline = time.time() + 3
        while time.time() < deadline and not (any(l == ": hb" for l in lines) and
                                               any(l.startswith("data: ") for l in lines)):
            time.sleep(0.05)
        conn.close()
        self.assertEqual(lines[0], "retry: 3000")
        self.assertIn(": hb", lines)
        data = [json.loads(l[6:]) for l in lines if l.startswith("data: ")]
        self.assertEqual(data[0]["event"]["channel"], "discord")

    def test_stream_reloads_and_tabs_never_hit_429(self):
        """v0.10.1 B2: 12 quick reloads (new page id each, old socket closed) and 10 open tabs from one
        address all stream; the same page asking again replaces its older stream."""
        import provider_hub

        def open_stream(page):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            conn.request("GET", "/api/office-life/stream", headers={"X-VO-Client": page})
            res = conn.getresponse()
            return conn, res

        def shut(conn, res):
            sock = getattr(getattr(res.fp, "raw", None), "_sock", None)
            try:
                if sock is not None:
                    sock.shutdown(2)
            except OSError:
                pass
            conn.close()

        def settle(count, seconds=3.0):
            deadline = time.time() + seconds
            while time.time() < deadline and provider_hub.open_streams() != count:
                time.sleep(0.05)
            return provider_hub.open_streams()

        base = provider_hub.open_streams()
        for n in range(12):
            conn, res = open_stream(f"reload-page-{n:02d}")
            self.assertEqual(res.status, 200, f"reload {n}")
            shut(conn, res)
        self.assertEqual(settle(base), base)
        tabs = [open_stream(f"open-tab-{n:02d}") for n in range(10)]
        self.assertEqual([res.status for _, res in tabs], [200] * 10)
        again = open_stream("open-tab-00")
        self.assertEqual(again[1].status, 200)
        self.assertEqual(settle(base + 10), base + 10)
        for conn, res in tabs + [again]:
            shut(conn, res)
        self.assertEqual(settle(base), base)

    def test_settings_save_validates_merges_and_publishes(self):
        sub = life_bus.BUS.subscribe([life_bus.LIFE_KEY], since=life_bus.BUS.seq)
        status, out = self.request("POST", "/api/office-life/settings",
                                   {"calm": True, "standup": {"time": "08:15"}, "timeZone": "America/New_York"})
        self.assertEqual(status, 200, out)
        self.assertEqual((out["settings"]["calm"], out["tz"]), (True, "America/New_York"))
        saved = json.loads(self.cfg_path.read_text())
        self.assertEqual(saved["officeLife"]["standup"], {"time": "08:15", "days": [1, 2, 3, 4, 5]})
        self.assertEqual(saved["office"], {"name": "Test office"})          # the rest of vo-config kept
        self.assertEqual(sub.get(timeout=1)["event"]["settings"]["calm"], True)
        status, out = self.request("POST", "/api/office-life/settings", {"standup": {"time": "7pm"}})
        self.assertEqual((status, out["error"], out["errors"][0]["field"]), (400, "invalid", "standup.time"))
        status, out = self.request("POST", "/api/office-life/settings", {"calm": False},
                                   headers={"Origin": "http://evil.example"})
        self.assertEqual((status, out["error"]), (403, "cross_site_blocked"))
        status, out = self.request("GET", "/vo-config")
        self.assertEqual(out["officeLife"]["calm"], True)

    def test_setup_save_ignores_office_life(self):
        with mock.patch.object(server, "_discover_roster", lambda: []), \
                mock.patch.object(server, "refresh_agent_maps", lambda *a, **k: None):
            status, out = self.request("POST", "/setup/save", {"officeLife": {"enabled": False, "calm": "x"},
                                                               "office": {"name": "Renamed"}})
        self.assertEqual(status, 200, out)
        saved = json.loads(self.cfg_path.read_text())
        self.assertNotIn("officeLife", saved)
        self.assertEqual(saved["office"]["name"], "Renamed")

    def test_test_event_is_gated(self):
        body = {"type": "visitor", "agent": "a", "channel": "sms"}
        with mock.patch.dict(os.environ, {"VO_LIFE_TEST_INJECT": ""}):
            self.assertEqual(self.request("POST", "/api/office-life/test-event", body)[0], 404)
            self.assertEqual(self.request("GET", "/api/office-life/test-event")[0], 404)
        with mock.patch.dict(os.environ, {"VO_LIFE_TEST_INJECT": "1"}):
            status, _ = self.request("POST", "/api/office-life/test-event", body,
                                     headers={"X-Forwarded-For": "203.0.113.9"})
            self.assertEqual(status, 404)
            status, out = self.request("POST", "/api/office-life/test-event", body)
            self.assertEqual(status, 200, out)
            self.assertIsNotNone(out["published"][0])
            env = {"VO_LIFE_TEST_INJECT": "1"}
            self.assertFalse(routes.test_inject_allowed(_Handler("192.168.1.20"), env))
            self.assertFalse(routes.test_inject_allowed(_Handler("100.64.0.7"), env))
            self.assertTrue(routes.test_inject_allowed(_Handler("::1"), env))
            self.assertFalse(routes.test_inject_allowed(_Handler("127.0.0.1"), {}))

    def test_journal_days_paper_and_actions(self):
        life_bus.BUS.publish({"type": "visitor", "agent": "a", "channel": "sms"})
        life_bus.BUS.publish({"type": "run", "agent": "a", "ref": "r1", "phase": "end", "ok": True})
        status, out = self.request("GET", "/api/office-life/journal?kinds=run")
        self.assertEqual(status, 200, out)
        self.assertEqual([r["type"] for r in out["rows"]], ["run"])
        self.assertEqual(self.request("GET", "/api/office-life/journal?day=2001-01-01")[0], 404)
        self.assertEqual(self.request("GET", "/api/office-life/journal?day=../../etc")[0], 404)
        status, out = self.request("GET", "/api/office-life/days")
        self.assertEqual([d["day"] for d in out["days"]], [out["today"]])
        self.assertEqual(self.request("GET", "/api/office-life/paper")[0], 404)
        self.assertEqual(self.request("POST", "/api/office-life/paper/now", {})[0], 503)
        office_life.CTX.actions["paper_now"] = lambda: {"day": "x"}
        office_life.CTX.actions["paper_preview"] = lambda day: {"day": day, "headline": "A quiet day"}
        self.assertEqual(self.request("POST", "/api/office-life/paper/now", {}), (200, {"ok": True, "day": "x"}))
        status, out = self.request("GET", "/api/office-life/paper?preview=1")
        self.assertEqual((status, out["preview"], out["paper"]["headline"]), (200, True, "A quiet day"))
        self.assertEqual(self.request("GET", "/api/office-life/nope")[0], 404)
        self.assertEqual(self.request("POST", "/api/office-life/state", {})[0], 405)

    def test_cheer_limits(self):
        self.assertEqual(self.request("POST", "/api/office-life/cheer",
                                      {"tournament": "t1", "match": 0, "agent": "a"})[0], 409)
        life_bus.BUS.publish({"type": "tournament.start", "id": "t1", "game": "darts", "players": ["a", "b"]})
        life_bus.BUS.publish({"type": "tournament.match", "id": "t1", "match": 0, "round": 1, "p1": "a", "p2": "b"})
        routes.CHEERS = routes._Cheers()
        status, out = self.request("POST", "/api/office-life/cheer", {"tournament": "t1", "match": 0, "agent": "a"})
        self.assertEqual((status, out["count"]), (200, 1))
        self.assertEqual(self.request("POST", "/api/office-life/cheer",
                                      {"tournament": "t1", "match": 0, "agent": "a"})[0], 429)

    def test_roster_rows_follow_the_demo_limit(self):
        roster = [{"id": f"ag{i}", "statusKey": f"ag{i}", "name": f"Agent {i}", "providerKind": "openclaw",
                   "createdAt": 1700000000} for i in range(5)]
        server._life_roster_cache.update(at=0.0, rows=None)
        with mock.patch.object(server, "get_roster", lambda: roster), \
                mock.patch.object(server, "get_agent_limit", lambda: 3):
            rows = server._life_roster_rows()
        server._life_roster_cache.update(at=0.0, rows=None)
        self.assertEqual([r["key"] for r in rows], ["ag0", "ag1", "ag2"])
        bus = life_bus.LifeBus(roster=lambda: {r["key"] for r in rows})
        self.assertIsNotNone(bus.publish({"type": "visitor", "agent": "ag2", "channel": "sms"}))
        self.assertIsNone(bus.publish({"type": "visitor", "agent": "ag4", "channel": "sms"}))

    def test_roster_rows_follow_a_new_discovered_roster_within_the_cache_time(self):
        # At a start get_roster() answers the saved roster and rediscovers in the background; an agent that joins
        # then (the lab Hermes agent on the layer) must be visible at once, or its first needs-you sign is dropped.
        row = lambda key: {"id": key, "statusKey": key, "name": key, "providerKind": "openclaw", "createdAt": 1}
        saved, found = [row("main"), row("ops")], [row("main"), row("hermes-lab-a"), row("ops")]
        server._life_roster_cache.update(at=0.0, rows=None)
        self.addCleanup(server._life_roster_cache.update, at=0.0, rows=None)
        with mock.patch.object(server, "_discovered_roster", saved), mock.patch.object(server, "_discovered_at", 5.0), \
                mock.patch.object(server, "get_roster", lambda: server._discovered_roster), \
                mock.patch.object(server, "get_agent_limit", lambda: 0):
            self.assertEqual([r["key"] for r in server._life_roster_rows()], ["main", "ops"])
            server._discovered_roster = found            # the background rediscovery replaced the roster
            self.assertEqual([r["key"] for r in server._life_roster_rows()], ["main", "hermes-lab-a", "ops"])
            bus = life_bus.LifeBus(roster=lambda: {r["key"] for r in server._life_roster_rows()})
            self.assertIsNotNone(bus.publish({"type": "needs.open", "agent": "hermes-lab-a", "need": "approval",
                                              "provider": "hermes", "ref": "ap-1", "count": 1}))
            server._discovered_at = 0                    # an agent was created or deleted: read again
            server._discovered_roster = saved
            self.assertEqual([r["key"] for r in server._life_roster_rows()], ["main", "ops"])
            server._discovered_at = 5.0                  # same roster, still within the cache time: no new read
            with mock.patch.object(server, "get_roster", mock.Mock(side_effect=AssertionError("read again"))):
                self.assertEqual([r["key"] for r in server._life_roster_rows()], ["main", "ops"])


class ServerHelpersTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.status = Path(self.temp.name)
        self.patches = [mock.patch.object(server, "STATUS_DIR", str(self.status)),
                        mock.patch.object(server, "STATUS_FILE", str(self.status / "agent-status.json")),
                        mock.patch.object(server, "SCORES_FILE", str(self.status / "project-scores.json"))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_meeting_history_append_and_replace(self):
        record = {"id": "standup-20261102", "topic": "Morning stand-up", "kind": "standup", "status": "completed"}
        self.assertEqual(server.append_meeting_history(record)["ok"], True)
        self.assertEqual(server.append_meeting_history(dict(record, summary="again"))["ok"], True)
        history = server._load_meetings_file()["_meetingHistory"]
        self.assertEqual([(m["id"], m.get("summary")) for m in history], [("standup-20261102", "again")])
        data = {"_meetingHistory": [{"id": f"m{i}"} for i in range(50)]}
        server._append_meeting_history_record(data, {"id": "m0"})                 # plain append (meeting end)
        self.assertEqual((len(data["_meetingHistory"]), data["_meetingHistory"][-1]["id"],
                          data["_meetingHistory"][0]["id"]), (50, "m0", "m1"))

    def test_games_writer_never_touches_work_score(self):
        server._award_points("a", 10, "Completed: one")
        before = json.loads(Path(server.SCORES_FILE).read_text())["agents"]["a"]
        server._record_game_result("a", played=True, won=True, title=True)
        server._record_game_result("b", played=True)
        after = json.loads(Path(server.SCORES_FILE).read_text())["agents"]
        for key in ("score", "completed", "streak", "history", "lastCompleted"):
            self.assertEqual(json.dumps(after["a"][key]), json.dumps(before[key]))
        self.assertEqual((after["a"]["games"]["titles"], after["a"]["games"]["wins"]), (1, 1))
        self.assertEqual(set(after["b"]), {"games"})
        board = {row["agent"]: row for row in server._handle_scores_leaderboard()["leaderboard"]}
        self.assertEqual((board["a"]["games"]["titles"], board["b"]["score"]), (1, 0))

    def test_write_sites_call_the_hooks(self):
        calls = []
        names = ("task_done", "xp_awarded", "project_status", "task_assigned")
        patches = [mock.patch.object(office_life.hooks, n, lambda _n=n, **kw: calls.append((_n, kw)))
                   for n in names]
        projects = {"projects": [{"id": "p1", "title": "Launch", "status": "active", "activity": [],
                                  "columns": [{"id": "todo", "title": "To do"}, {"id": "done", "title": "Done"}],
                                  "tasks": [{"id": "t1", "title": "Write", "columnId": "todo", "assignee": "a",
                                             "priority": "low"}]}]}
        store = {"data": projects}
        for p in patches:
            p.start()
        try:
            with mock.patch.object(server, "_load_projects", lambda: store["data"]), \
                    mock.patch.object(server, "_save_projects", lambda data: store.update(data=data)), \
                    mock.patch.object(server, "_wf_write_task_file", lambda *a, **k: None):
                server._handle_task_update("p1", "t1", {"assignee": "b", "by": "a"})
                server._handle_task_update("p1", "t1", {"columnId": "done", "by": "b"})
                server._handle_project_update("p1", {"status": "completed", "by": "user"})
        finally:
            for p in reversed(patches):
                p.stop()
        got = [name for name, _ in calls]
        self.assertEqual(got, ["task_assigned", "xp_awarded", "task_done", "project_status"])
        kw = dict(calls)
        self.assertEqual((kw["task_assigned"]["old"], kw["task_assigned"]["new"], kw["task_assigned"]["by"]),
                         ("a", "b", "a"))
        self.assertEqual((kw["task_done"]["agent"], kw["xp_awarded"]["reason"]), ("b", "task"))
        self.assertEqual(kw["task_done"]["points"], kw["xp_awarded"]["points"])
        self.assertEqual((kw["project_status"]["new"], kw["project_status"]["agents"]), ("completed", ["b"]))

    def test_a_failing_hook_never_breaks_the_request(self):
        with mock.patch.object(office_life.hooks, "xp_awarded", side_effect=RuntimeError("boom")):
            result = server._award_points("a", 5, "manual")
        self.assertEqual(result["pointsAwarded"], 5)


if __name__ == "__main__":
    unittest.main()
