"""Office life builders (L4): templates, stand-up lines, the Daily Office, tournament helpers.

Pure functions over fixed journal rows: golden lines, headline order, MVP ties, stats, and the
privacy rule that only whitelisted fields ever reach a sentence (zero model inference).
"""

import json
import sys
import unittest
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1] / "app"
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from office_life import builders as B, templates as T, tournament as TT  # noqa: E402

ROSTER = [{"key": "a1", "name": "Ada \U0001F680"}, {"key": "a2", "name": "Bob"}, {"key": "a3", "name": "Cy"},
          {"key": "a4", "name": "Dee"}]
NAMES = {row["key"]: row["name"] for row in ROSTER}
SECRET = "SECRET-MESSAGE please wire 500 to acct 991"


def row(t, kind, agent=None, ref=None, **data):
    out = {"t": t, "k": kind}
    if agent:
        out["a"] = agent
    if ref:
        out["r"] = ref
    if data:
        out["d"] = data
    return out


def run_end(t, agent, ok=True, ms=60000, outcome=None, **tools):
    data = {"phase": "end", "ok": ok, "ms": ms, "tools": tools}
    if outcome:
        data["outcome"] = outcome
    return row(t, "run", agent, **data)


def lines(rows, presence=None, roster=ROSTER):
    presence = presence or {r["key"]: {"state": "idle"} for r in roster}
    return {item["agent"]: item["line"] for item in B.standup(rows, roster, presence)["lines"]}


class TemplatesTest(unittest.TestCase):
    def test_words_clip_names_durations_channels(self):
        self.assertEqual((T.word("tasks", 1), T.word("tasks", 0), T.word("tasks", 2)), ("task", "tasks", "tasks"))
        self.assertEqual(T.title("x" * 40), "x" * 31 + "…")
        self.assertEqual(T.name("Ada \U0001F680  Lovelace\n"), "Ada Lovelace")
        self.assertEqual([T.duration(ms) for ms in (45000, 720000, 7200000, 4380000)],
                         ["45 s", "12 min", "2 h", "1 h 13 min"])
        self.assertEqual((T.channel("tg"), T.channel("webchat"), T.channel(SECRET)), ("Telegram", "", ""))
        self.assertEqual(T.kind_phrase("other"), "")
        self.assertEqual(T.join_facts(["A" * 40, "B" * 40, "Cc"]), "A" * 40 + "; cc")

    def test_every_template_fills(self):
        slots = {"n": 2, "k": 1, "t1": "a", "t2": "b", "title": "t", "name": "n", "c1": "x", "c2": "y",
                 "kind": "mostly", "tasks": "tasks", "jobs": "jobs", "messages": "messages", "runs": "runs",
                 "errors": "errors", "agents": "agents", "parts": "p", "a": "a", "b": "b", "game": "darts",
                 "channels": "c", "agents_word": "agents", "tasks_word": "tasks", "runs_word": "runs",
                 "visitors": 1, "duration": "1 min", "failed": 1, "label": "l", "s": 1, "m": 1, "h": 1}
        for key in T.TEXT:
            self.assertTrue(T.say(key, **slots), key)


class StandupLinesTest(unittest.TestCase):
    def test_golden_lines(self):
        rows = [
            row(1, "task.done", "a1", title="Fix the login page", taskId="t1"),
            row(2, "task.done", "a1", title="Ship docs", taskId="t2"),
            row(3, "task.done", "a1", title="Ship docs", taskId="t2"),            # same task again
            row(4, "handoff", "a1", to="a2", via="send"),
            row(5, "visitor", "a2", channel="telegram"),
            row(6, "cron.fire", "a3", ref="job1", name="nightly"),
            row(7, "cron.fire", "a3", ref="job2", name="digest"),
            run_end(8, "a4", ok=False, outcome="error", terminal=4),
            run_end(9, "a4", ok=False, outcome="timed_out", terminal=2, editor=1),
            run_end(10, "a4", ok=False, outcome="cancelled"),                     # user stop: no error
        ]
        self.assertEqual(lines(rows), {
            "a1": "Finished 2 tasks: Fix the login page, Ship docs; handed 1 job to Bob",
            "a2": "Picked up 1 job from Ada; handled 1 message from Telegram",
            "a3": "Ran 2 scheduled jobs",
            "a4": "Worked through 3 runs, mostly in the terminal",
        })

    def test_more_rules(self):
        rows = [row(1, "task.done", "a1", title=f"Task {i}", taskId=f"t{i}") for i in range(3)]
        rows += [row(5, "task.done", "a2", taskId="x")]                               # no title
        rows += [row(6, "visitor", "a3", channel=c) for c in ("telegram", "telegram", "sms", "discord")]
        rows += [run_end(7, "a4", ok=False, outcome="error"), run_end(8, "a4", ok=True)]
        got = lines(rows)
        self.assertEqual(got["a1"], "Finished 3 tasks: Task 0 and 2 more")
        self.assertEqual(got["a2"], "Finished 1 task")
        self.assertEqual(got["a3"], "Handled 4 messages from Telegram, Discord and more")
        self.assertEqual(got["a4"], "Worked through 2 runs; hit 1 error, all sorted")
        rows = [row(1, "project.done", None, ref="p1", title="Website", agents=["a1"]),
                row(2, "handoff", "a2", to="a1"), row(3, "handoff", "a2", to="a3"),
                run_end(4, "a3", ok=True), run_end(5, "a3", ok=False, outcome="error")]
        got = lines(rows)
        self.assertEqual(got["a1"], "Wrapped up project Website; picked up 1 job from Bob")
        self.assertEqual(got["a2"], "Handed 2 jobs to 2 teammates")
        self.assertEqual(got["a3"], "Picked up 1 job from Bob; worked through 2 runs")
        self.assertEqual(B.line_for(B.collect([run_end(1, "a3", ok=False)])["agents"]["a3"], NAMES),
                         "Worked through 1 run; hit 1 error, still on it")
        self.assertEqual(got["a4"], "Quiet since the last stand-up")

    def test_participants_remote_and_summary(self):
        presence = {"a1": {"state": "idle"}, "a2": {"state": "working"}, "a3": {"state": "offline"},
                    "a4": {"state": "meeting"}}
        result = B.standup([row(1, "task.done", "a1", title="One", taskId="1"),
                            row(2, "visitor", "a2", channel="sms")], ROSTER, presence)
        self.assertEqual(result["participants"], ["a1", "a2", "a4"])
        self.assertEqual([(item["agent"], item["remote"]) for item in result["lines"]],
                         [("a1", False), ("a2", True), ("a4", True)])
        self.assertEqual(result["summary"], "Stand-up: 3 agents, 1 task done, 1 message handled")
        self.assertEqual(result["responses"]["a4"], "Quiet since the last stand-up")
        nobody = B.standup([], ROSTER, {key: {"state": "offline"} for key in NAMES})
        self.assertEqual((nobody["participants"], nobody["summary"]), ([], "Stand-up skipped: nobody was around"))
        self.assertEqual(B.standup([], ROSTER[:1], {})["participants"], [])        # unknown presence = offline

    def test_no_free_text_leaks(self):
        """A message-like string in any field that is not a whitelisted slot never appears."""
        rows = [
            row(1, "task.done", "a1", ref=SECRET, title="Real title", taskId="t1", text=SECRET, note=SECRET),
            row(2, "visitor", "a2", ref=SECRET, channel="telegram", text=SECRET, session=SECRET),
            row(3, "visitor", "a2", channel=SECRET),
            row(4, "cron.fire", "a3", ref=SECRET, name=SECRET),
            run_end(5, "a3", ok=False, outcome=SECRET, **{SECRET: 9, "terminal": 1}),
            row(6, "handoff", "a1", to="ghost-agent", via="send", text=SECRET),
            row(7, "needs.open", "a2", ref="n1", need="approval", question=SECRET, command=SECRET),
            row(8, "needs.close", "a2", ref="n1", outcome="answered", answer=SECRET),
            row(9, "standup.start", None, id="standup-1", status="open", summary=SECRET,
                lines=[{"agent": "a1", "line": SECRET}], participants=["a1"]),
            row(10, "project.done", None, ref="p1", title="Launch", agents=["a1"], goal=SECRET),
            row(11, "tournament.start", None, id="tour-1", game="pong", players=["a1", "a2"], bracket={"x": SECRET}),
            row(12, "tournament.end", None, id="tour-1", champion="a2", status="done", note=SECRET),
            row(13, "xp", "a1", points=5, reason=SECRET),
            row(14, "mood", "a1", mood="stuck", why=SECRET),
            {"t": 15, "k": "task.done", "a": "a4", "d": SECRET},                       # malformed data
            {"t": 16, "k": SECRET, "a": "a4", "d": {"title": SECRET}},
        ]
        standup = B.standup(rows, ROSTER, {key: {"state": "idle"} for key in NAMES})
        paper = B.paper("2026-11-02", "UTC", rows, ROSTER, 99, hour_of=lambda ms: 10)
        dump = json.dumps([standup, paper], ensure_ascii=False)
        self.assertNotIn("SECRET", dump)
        self.assertNotIn("wire", dump)
        self.assertIn("Real title", dump)
        facts = B.fact_list(B.collect(rows)["agents"]["a1"], NAMES)
        self.assertIn("Handed 1 job to a teammate", facts)                        # unknown target: no key


class PaperTest(unittest.TestCase):
    def paper(self, rows, roster=ROSTER):
        return B.paper("2026-11-02", "America/New_York", rows, roster, 123, hour_of=lambda ms: ms // 1000)

    def test_headline_order(self):
        base = [run_end(1, "a1"), row(2, "visitor", "a2", channel="sms"), row(3, "visitor", "a2", channel="email"),
                row(4, "tournament.start", None, id="t", game="darts"),
                row(5, "tournament.end", None, id="t", champion="a3", status="done")]
        self.assertEqual(self.paper(base[:1])["headline"], "1 run worked through today")
        self.assertEqual(self.paper(base[:3])["headline"], "2 messages handled from Email and SMS")
        self.assertEqual(self.paper(base)["headline"], "Cy wins the darts tournament")
        tasks = base + [row(6, "task.done", "a1", title="A", taskId="a")]
        self.assertEqual(self.paper(tasks)["headline"], "1 task done across the office")
        one = tasks + [row(7, "project.done", None, ref="p", title="Website", agents=["a1"])]
        self.assertEqual(self.paper(one)["headline"], "Project Website is done!")
        two = one + [row(8, "project.done", None, ref="q", title="App")]
        self.assertEqual(self.paper(two)["headline"], "2 projects wrapped up today")
        quiet = self.paper([])
        self.assertEqual((quiet["headline"], quiet["subhead"], quiet["mvp"], quiet["stats"]),
                         ("A quiet day at the office", "Nobody had much to do today", None, []))
        self.assertEqual([c["line"] for c in quiet["columns"]], ["A quiet day"] * 4)
        called_off = [row(1, "tournament.end", None, id="t", status="called_off")]
        self.assertEqual(self.paper(called_off)["headline"], "A quiet day at the office")

    def test_mvp_score_and_ties(self):
        rows = [run_end(1, "a1"), run_end(2, "a2"), run_end(3, "a2", ok=False, outcome="error"),
                run_end(4, "a2", ok=True)]
        paper = self.paper(rows)
        self.assertEqual((paper["mvp"]["agent"], paper["mvp"]["score"]), ("a2", 2))
        tie = self.paper([run_end(1, "a1"), run_end(2, "a2"), run_end(3, "a2", ok=False, outcome="error"),
                          run_end(4, "a1")])
        self.assertEqual(tie["mvp"]["agent"], "a1")                                  # fewer failed runs
        by_name = self.paper([run_end(1, "a2"), run_end(2, "a1")])
        self.assertEqual(by_name["mvp"]["agent"], "a1")                              # then the name
        self.assertEqual([c["agent"] for c in by_name["columns"]], ["a1", "a2", "a3", "a4"])
        weighted = self.paper([row(1, "task.done", "a3", title="T", taskId="1"), run_end(2, "a1"),
                               run_end(3, "a1"), run_end(4, "a1"), run_end(5, "a1"),
                               row(6, "project.done", None, ref="p", title="P", agents=["a4"])])
        self.assertEqual([(c["agent"]) for c in weighted["columns"][:3]], ["a4", "a3", "a1"])
        self.assertEqual(weighted["mvp"], {"agent": "a4", "name": "Dee", "score": 20,
                                           "reason": "Wrapped up project P"})

    def test_stats_and_boxes(self):
        rows = [row(3600 * 1000 * 0 + 9000, "task.done", "a1", title="A", taskId="a"),
                row(14000, "visitor", "a2", channel="telegram"), row(14100, "visitor", "a2", channel="telegram"),
                row(14200, "visitor", "a3", channel="sms"), row(14300, "cron.fire", "a3"),
                row(15000, "needs.open", "a1", ref="n1", need="approval"),
                row(75000, "needs.close", "a1", ref="n1", outcome="answered"),
                row(16000, "needs.open", "a2", ref="n2", need="question"),
                row(196000, "needs.close", "a2", ref="n2", outcome="answered"),
                row(17000, "needs.open", "a3", ref="n3", need="approval"),
                row(18000, "needs.close", "a3", ref="n3", outcome="expired"),
                run_end(19000, "a2", ms=4380000, terminal=1), run_end(19500, "a1", ok=False, outcome="error"),
                row(20000, "handoff", "a1", to="a2"),
                row(21000, "standup.start", None, id="standup-20261102", status="open", participants=["a1", "a2"]),
                row(22000, "tournament.start", None, id="tour-20261102-1", game="pong"),
                row(23000, "tournament.end", None, id="tour-20261102-1", champion="a2", status="done")]
        paper = self.paper(rows)
        stats = {s["label"]: s["value"] for s in paper["stats"]}
        self.assertEqual(stats, {"Busiest hour": "14:00", "Longest run": "Bob, 1 h 13 min", "Runs": "2 (1 with errors)",
                                 "Requests answered": "2, median wait 2 min", "Messages": "Telegram 2, SMS 1",
                                 "Scheduled jobs": "1", "Handoffs": "1", "Champion": "Bob (ping pong)"})
        self.assertEqual(paper["standup"], {"id": "standup-20261102", "at": 21000, "participants": 2})
        self.assertEqual(paper["tournament"], {"id": "tour-20261102-1", "game": "pong", "champion": "a2",
                                               "championName": "Bob", "status": "done"})
        self.assertEqual(paper["headline"], "1 task done across the office")
        self.assertEqual(paper["subhead"], "3 agents at work: 1 task, 2 runs, 3 messages")
        self.assertEqual((paper["day"], paper["tz"], paper["masthead"], paper["generatedAt"]),
                         ("2026-11-02", "America/New_York", "The Daily Office", 123))
        column = {c["agent"]: c for c in paper["columns"]}["a2"]
        self.assertEqual(column["stats"], {"tasks": 0, "runs": 1, "visitors": 2, "handoffs": 0})
        self.assertEqual(column["name"], "Bob")

    def test_columns_only_for_the_roster(self):
        paper = self.paper([run_end(1, "gone-agent"), run_end(2, "a1")], roster=ROSTER[:2])
        self.assertEqual([c["agent"] for c in paper["columns"]], ["a1", "a2"])
        self.assertEqual(paper["stats"][-1], {"label": "Runs", "value": "2"})


class TournamentHelpersTest(unittest.TestCase):
    def test_seeded_players_and_bracket_are_deterministic(self):
        pool = ["e", "d", "c", "b", "a"]
        first = TT.seeded_players(pool, "2026-11-02", 0)
        self.assertEqual(first, TT.seeded_players(list(reversed(pool)), "2026-11-02", 0))
        self.assertEqual(len(first), 4)
        days = {tuple(TT.seeded_players(pool, f"2026-11-{d:02d}", 0)) for d in range(1, 15)}
        self.assertGreater(len(days), 3)
        self.assertEqual(TT.decide("tour-1", 1, "a", "b", "pong"), TT.decide("tour-1", 1, "a", "b", "pong"))

    def test_bracket_shapes(self):
        self.assertEqual(TT.make_bracket(["a", "b"])["matches"], [{"match": 1, "round": 1, "p1": "a", "p2": "b"}])
        three = TT.make_bracket(["a", "b", "c"])
        self.assertEqual((three["byes"], [m["match"] for m in three["matches"]]), (["a"], [1, 2]))
        self.assertEqual(TT.slot_players(three["matches"][1], {1: "c"}), ("a", "c"))
        four = TT.make_bracket(["a", "b", "c", "d"])
        self.assertEqual(TT.slot_players(four["matches"][2], {1: "b", 2: "c"}), ("b", "c"))
        self.assertEqual(TT.slot_players(four["matches"][2], {1: None, 2: "c"}), (None, "c"))
        self.assertIsNone(TT.make_bracket(["a"]))

    def test_outcomes_are_fair_and_scored(self):
        wins = 0
        for match in range(400):
            winner, score = TT.decide("tour-x", match, "p", "q", "pong")
            self.assertEqual(max(score), 3)
            self.assertLess(min(score), 3)
            self.assertEqual(score[0] == 3, winner == "p")
            wins += winner == "p"
            _w, darts = TT.decide("tour-x", match, "p", "q", "darts")
            self.assertEqual(sorted(darts)[1], 2)
        self.assertTrue(150 < wins < 250, wins)

    def test_games_from_furniture(self):
        self.assertEqual(TT.games_available({"desk", "dartBoard"}), ["darts"])
        self.assertEqual(TT.games_available(set()), [])
        both = ["pong", "darts"]
        self.assertNotEqual(TT.pick_game(both, "2026-11-02", 0), TT.pick_game(both, "2026-11-03", 0))
        self.assertNotEqual(TT.pick_game(both, "2026-11-02", 0), TT.pick_game(both, "2026-11-02", 1))
        self.assertIsNone(TT.pick_game([], "2026-11-02", 0))
        self.assertEqual(TT.windows("off"), ())


if __name__ == "__main__":
    unittest.main()
