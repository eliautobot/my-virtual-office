"""Break-time tournaments (design 3.9): server-decided brackets every tab agrees on.

Idle agents play ping pong or darts on the office's own tables. Players, bracket, winners and
scores come from a seeded RNG (sha256 of the day and window), so the same day gives the same
bracket. Real work wins: a player who starts working or gets a need forfeits and the other one
advances by walkover. Results go to the journal (events) and to the leaderboard's ``games``
through the injected ``record_game`` writer, which never touches work XP.
"""

import hashlib
import random

WINDOWS = {"daily": ((12 * 60, 17 * 60),), "twice": ((11 * 60, 13 * 60), (15 * 60, 17 * 60))}
GAME_FURNITURE = (("pong", "pingPongTable"), ("darts", "dartBoard"))
IDLE_MIN_MS = 10 * 60 * 1000       # idle this long before joining
CHECK_MS = 60 * 1000               # eligibility check interval
MATCH_MS = 40 * 1000
WALK_MS = 8 * 1000                 # players walk to the table before a match starts
GAP_MS = 5 * 1000                  # pause between matches
LAST_START_MS = 10 * 60 * 1000     # never start this close to the window's end
PLAYERS_MAX = 4
POINTS = {"pong": 3, "darts": 2}   # pong to 3, darts best of 3 rounds
PLAYABLE = ("idle",)
DAYS_KEPT = 3


# ── pure helpers (unit tested) ───────────────────────────────────────────
def rng(*parts):
    digest = hashlib.sha256(":".join(str(part) for part in parts).encode("utf-8")).hexdigest()
    return random.Random(int(digest[:16], 16))


def windows(frequency):
    return WINDOWS.get(frequency, ())


def games_available(types):
    types = set(types or ())
    return [game for game, furniture in GAME_FURNITURE if furniture in types]


def pick_game(available, day, index):
    """One of the available games; alternates by day (and window) when both exist."""
    if not available:
        return None
    if len(available) == 1:
        return available[0]
    ordinal = int(day.replace("-", "")) if day else 0
    return available[(ordinal + index) % len(available)]


def seeded_players(eligible, day, index, limit=PLAYERS_MAX):
    """Up to ``limit`` players from ``eligible``: a shuffle seeded by the day and window."""
    pool = sorted(set(eligible))
    rng(day, index, "players").shuffle(pool)
    return pool[:limit]


def make_bracket(players):
    """Matches for 2, 3 or 4 players. ``from`` names earlier matches whose winners fill a slot."""
    n = len(players)
    if n == 2:
        return {"size": 2, "byes": [], "matches": [{"match": 1, "round": 1, "p1": players[0], "p2": players[1]}]}
    if n == 3:
        return {"size": 3, "byes": [players[0]],
                "matches": [{"match": 1, "round": 1, "p1": players[1], "p2": players[2]},
                            {"match": 2, "round": 2, "p1": players[0], "from": [1]}]}
    if n == 4:
        return {"size": 4, "byes": [],
                "matches": [{"match": 1, "round": 1, "p1": players[0], "p2": players[1]},
                            {"match": 2, "round": 1, "p1": players[2], "p2": players[3]},
                            {"match": 3, "round": 2, "from": [1, 2]}]}
    return None


def decide(tour_id, match, p1, p2, game):
    """The pre-decided winner and score ``[p1, p2]`` of one match (fair 50/50)."""
    gen = rng(tour_id, match, p1, p2)
    p1_wins = gen.random() < 0.5
    top = POINTS.get(game, 3)
    loser = gen.randrange(0, top)
    return (p1, [top, loser]) if p1_wins else (p2, [loser, top])


def slot_players(spec, winners):
    """``(p1, p2)`` of a match, filling ``from`` slots with earlier winners (None when void)."""
    if "from" not in spec:
        return spec.get("p1"), spec.get("p2")
    filled = [winners.get(number) for number in spec["from"]]
    if "p1" in spec:
        return spec["p1"], filled[0]
    return filled[0], filled[1]


# ── the running part ─────────────────────────────────────────────────────
class Tournaments:
    """Starts and runs at most one tournament at a time. ``tick(now_ms, view)`` is called by the
    scheduler; ``view`` = ``{day, minute, presence: {key: state}, since: {key: ms},
    visible: [keys], standupOpen: bool}``."""

    def __init__(self, ctx, state, save_state):
        self.ctx = ctx
        self.state = state                # the scheduler's state.json dict (shared)
        self.save_state = save_state
        self.current = None
        self._next_check = 0

    # ── settings ──
    def allowed(self):
        ctx = self.ctx
        return ctx.feature("tournaments") and not ctx.settings.get("calm") and \
            (ctx.settings.get("tournaments") or {}).get("frequency", "daily") in WINDOWS

    def _done(self, day):
        return list((self.state.get("tournaments") or {}).get(day) or [])

    def _mark(self, day, index):
        table = dict(self.state.get("tournaments") or {})
        table[day] = sorted(set(self._done(day) + [index]))
        for old in sorted(table)[:-DAYS_KEPT]:
            table.pop(old, None)
        self.state["tournaments"] = table

    # ── eligibility ──
    def free(self, key, view):
        """Not working, not offline, no open need: free to play right now."""
        if key not in view.get("visible", ()):
            return False
        if view["presence"].get(key) not in PLAYABLE:
            return False
        return not self.ctx.bus.open_needs(agent=key)

    def eligible(self, now_ms, view):
        return [key for key in view.get("visible", ())
                if self.free(key, view) and now_ms - int(view["since"].get(key, now_ms)) >= IDLE_MIN_MS]

    def window_now(self, view):
        """``(index, start_minute, end_minute)`` of the open window not yet used today, or None."""
        frequency = (self.ctx.settings.get("tournaments") or {}).get("frequency", "daily")
        done = self._done(view["day"])
        for index, (start, end) in enumerate(windows(frequency)):
            earliest = start + int(rng(view["day"], index, "start").random() * (end - start) / 2)
            if index not in done and earliest <= view["minute"] < end - LAST_START_MS // 60000:
                return index, start, end
        return None

    # ── lifecycle ──
    def boot(self, now_ms):
        """A tournament left open by a restart is called off (its window stays used)."""
        left = self.state.get("openTournament")
        if isinstance(left, dict) and left.get("id"):
            self.ctx.bus.publish({"type": "tournament.end", "id": left["id"], "status": "called_off",
                                  "provider": "office", "at": now_ms})
            self.state.pop("openTournament", None)
            self.save_state()

    def tick(self, now_ms, view):
        if self.current is not None:
            if not self.allowed():
                self.call_off(now_ms)
            else:
                self._step(now_ms, view)
            return
        if now_ms < self._next_check:
            return
        self._next_check = now_ms + CHECK_MS
        if not self.allowed() or view.get("standupOpen"):
            return
        window = self.window_now(view)
        if window is None:
            return
        game = pick_game(games_available(self.ctx.call("layout_types", default=set())), view["day"], window[0])
        if game is None:
            return
        players = seeded_players(self.eligible(now_ms, view), view["day"], window[0])
        if len(players) >= 2:
            self.begin(now_ms, view["day"], window[0], game, players)

    def begin(self, now_ms, day, index, game, players):
        bracket = make_bracket(players)
        tour_id = f"tour-{day.replace('-', '')}-{index + 1}"
        self.current = {"id": tour_id, "day": day, "game": game, "players": list(players), "bracket": bracket,
                        "position": 0, "winners": {}, "live": None, "nextAt": now_ms}
        self._mark(day, index)
        self.state["openTournament"] = {"id": tour_id, "day": day, "window": index}
        self.save_state()
        self.ctx.bus.publish({"type": "tournament.start", "id": tour_id, "game": game, "players": list(players),
                              "bracket": bracket, "provider": "office", "at": now_ms})
        return self.current

    def _publish_match(self, now_ms, spec, p1, p2, winner, score=None, walkover=False, starts=None, ms=0):
        event = {"type": "tournament.match", "id": self.current["id"], "match": spec["match"],
                 "round": spec["round"], "winner": winner, "walkover": walkover, "provider": "office",
                 "at": now_ms, "startsAt": starts if starts is not None else now_ms, "ms": ms}
        if p1:
            event["p1"] = p1
        if p2:
            event["p2"] = p2
        if score is not None:
            event["score"] = score
        self.ctx.bus.publish(event)

    def _step(self, now_ms, view):
        tour = self.current
        live = tour["live"]
        if live is not None:
            p1, p2 = live["p1"], live["p2"]
            gone = [player for player in (p1, p2) if not self.free(player, view)]
            if gone and len(gone) < 2:
                stays = p2 if gone[0] == p1 else p1
                if stays != live["winner"]:
                    self._publish_match(now_ms, live["spec"], p1, p2, stays, walkover=True)
                self._finish_match(now_ms, stays, played=False)
            elif gone:
                self._finish_match(now_ms, None, played=False)
            elif now_ms >= live["endsAt"]:
                self._finish_match(now_ms, live["winner"], played=True)
            return
        if now_ms < tour["nextAt"]:
            return
        matches = tour["bracket"]["matches"]
        if tour["position"] >= len(matches):
            self._end(now_ms)
            return
        spec = matches[tour["position"]]
        p1, p2 = slot_players(spec, tour["winners"])
        here = [player for player in (p1, p2) if player and self.free(player, view)]
        if len(here) == 2:
            winner, score = decide(tour["id"], spec["match"], p1, p2, tour["game"])
            starts = now_ms + WALK_MS
            tour["live"] = {"spec": spec, "p1": p1, "p2": p2, "winner": winner, "endsAt": starts + MATCH_MS}
            self._publish_match(now_ms, spec, p1, p2, winner, score=score, starts=starts, ms=MATCH_MS)
            return
        winner = here[0] if here else None
        if winner:
            self._publish_match(now_ms, spec, p1, p2, winner, walkover=True)
        tour["winners"][spec["match"]] = winner
        tour["position"] += 1
        tour["nextAt"] = now_ms

    def _finish_match(self, now_ms, winner, played):
        tour = self.current
        live = tour["live"]
        if played:
            for player in (live["p1"], live["p2"]):
                self.ctx.call("record_game", player, played=True, won=player == winner, title=False)
        tour["winners"][live["spec"]["match"]] = winner
        tour["live"] = None
        tour["position"] += 1
        tour["nextAt"] = now_ms + (GAP_MS if played else 0)

    def _end(self, now_ms):
        tour = self.current
        final = tour["bracket"]["matches"][-1]["match"]
        champion = tour["winners"].get(final)
        event = {"type": "tournament.end", "id": tour["id"], "status": "done" if champion else "called_off",
                 "provider": "office", "at": now_ms}
        if champion:
            event["champion"] = champion
            self.ctx.call("record_game", champion, played=False, won=False, title=True)
        self._close(event)

    def call_off(self, now_ms):
        if self.current is None:
            return
        self._close({"type": "tournament.end", "id": self.current["id"], "status": "called_off",
                     "provider": "office", "at": now_ms})

    def _close(self, event):
        self.current = None
        self.state.pop("openTournament", None)
        self.save_state()
        self.ctx.bus.publish(event)
