"""The Office life clock (design 1.1): one daemon thread, one tick every 5 s.

Each tick: day rollover (``day`` event, journal prune), presence diff -> journal ``state`` rows,
mood timers (focused / stuck / relieved from ``run`` events), need expiry, the morning stand-up,
the Daily Office, tournaments, journal flush. Everything takes ``now`` from an injected clock,
so tests call ``tick(now)`` directly and never sleep. Zero model inference: stand-up lines and
the paper come from builders.py over the journal.
"""

import datetime
import sys
import threading
import time

from . import builders, templates as T
from .tournament import Tournaments

TICK_SEC = 5.0
GRACE_MS = 2 * 3600 * 1000            # a missed stand-up still runs this long after its time
STANDUP_MS = 90 * 1000
STANDUP_DEFAULT_BACK_MS = 24 * 3600 * 1000
STANDUP_MAX_BACK_MS = 4 * 24 * 3600 * 1000
FOCUS_MS = 15 * 60 * 1000
STUCK_FAILS = 3
STUCK_WINDOW_MS = 60 * 60 * 1000
STUCK_FADE_MS = 4 * 3600 * 1000      # a stuck look with no new failure for this long fades quietly
RELIEVED_RUN_MS = 5 * 60 * 1000
RELIEVED_SHOW_MS = 8 * 1000
RUN_STALE_MS = 6 * 3600 * 1000       # an open run without an end this old is forgotten
NEED_MAX_AGE_MS = 12 * 3600 * 1000   # same as the bus's needs dedupe TTL
FAILED_SKIP = ("cancelled", "canceled", "interrupted", "aborted", "stopped")
STATE_ALIASES = {"break": "idle", "waiting": "working", "error": "idle"}
STATES = ("working", "finishing", "idle", "meeting", "offline")


# ── office time (DST-safe) ───────────────────────────────────────────────
def parse_hhmm(text, default=(9, 30)):
    try:
        hour, minute = (int(part) for part in str(text).split(":", 1))
    except (TypeError, ValueError):
        return default
    return (hour, minute) if 0 <= hour <= 23 and 0 <= minute <= 59 else default


def due_ms(day, hhmm, tz):
    """The instant (ms) the office clock first shows ``hhmm`` on ``day``. A time skipped by a
    spring-forward change falls on the first minute after the gap (02:30 -> 03:00); a time that
    happens twice at fall-back is its first occurrence."""
    date = datetime.date.fromisoformat(day)
    hour, minute = parse_hhmm(hhmm)
    wall = datetime.datetime(date.year, date.month, date.day, hour, minute)
    first = wall.replace(tzinfo=tz, fold=0)
    stamp = first.timestamp()
    back = datetime.datetime.fromtimestamp(stamp, tz).replace(tzinfo=None)
    if back == wall:
        return int(stamp * 1000)
    other = wall.replace(tzinfo=tz, fold=1).timestamp()
    lo, hi = int(min(stamp, other)), int(max(stamp, other))
    while hi - lo > 1:                               # first second whose wall time is >= hhmm
        mid = (lo + hi) // 2
        if datetime.datetime.fromtimestamp(mid, tz).replace(tzinfo=None) >= wall:
            hi = mid
        else:
            lo = mid
    return hi * 1000


def norm_state(raw):
    state = str(raw or "").strip().lower()
    state = STATE_ALIASES.get(state, state)
    return state if state in STATES else None


def _stamp_ms(value, fallback):
    """Presence ``updated`` (s or ms) as ms, else ``fallback``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    ms = number if number > 1e12 else number * 1000
    return int(ms) if 0 < ms <= fallback else fallback


class Scheduler:
    def __init__(self, ctx, clock=time.time):
        self.ctx = ctx
        self.clock = clock
        self._lock = threading.RLock()
        self._thread = None
        self._stop = threading.Event()
        self._remove_listener = None
        self.state = {}
        self.day = None
        self.states = {}          # key -> normalized presence state
        self.since = {}           # key -> ms the current state began
        self.providers = {}
        self.runs = {}            # key -> {run ref: started ms}
        self.run_seen = set()     # agents that report run events
        self.failures = {}        # key -> [failed run end ms]
        self.moods = {}           # key -> mood shown (no key = clear)
        self.relieved_until = {}
        self.tournaments = None
        self._booted = False

    # ── wiring ──
    def journal(self):
        return self.ctx.journal

    def save_state(self):
        journal = self.journal()
        if journal is not None:
            try:
                journal.save_state(self.state)
            except OSError:
                pass

    def install(self):
        """Load state, listen to the bus, register the Settings buttons (no thread)."""
        journal = self.journal()
        self.state = journal.load_state() if journal is not None else {}
        self.tournaments = Tournaments(self.ctx, self.state, self.save_state)
        self._remove_listener = self.ctx.bus.add_event_listener(self.on_event)
        actions = self.ctx.actions
        actions["standup_now"] = self.standup_now
        actions["paper_now"] = self.paper_now
        actions["paper_preview"] = self.paper_preview
        actions["test:tick"] = lambda body: self.tick(body.get("now") if isinstance(body.get("now"), (int, float))
                                                      else None)
        actions["test:tournament"] = self.test_tournament
        return self

    def start(self):
        if self._thread is not None:
            return self
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="office-life-clock", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2)
        if self._remove_listener is not None:
            self._remove_listener()
            self._remove_listener = None

    def _run(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as exc:  # the clock never dies on one bad tick
                print(f"[office-life] clock tick failed: {type(exc).__name__}: {exc}")
            self._stop.wait(TICK_SEC)

    # ── the tick ──
    def tick(self, now=None):
        now = self.clock() if now is None else float(now)
        now_ms = int(now * 1000)
        journal = self.journal()
        if journal is None:
            return {"ok": False}
        with self._lock:
            if not self.ctx.enabled():
                journal.maybe_flush(now)
                return {"ok": True, "enabled": False}
            self._drain_sources(now)
            presence = self.ctx.call("presence", default=None)
            rows = self.ctx.roster_rows()
            self._rollover(now_ms, rows, presence)
            self._presence(now_ms, rows, presence)
            self._moods_tick(now_ms)
            self._needs_tick(now_ms)
            if rows is not None:                # roster unreadable: stand-up and paper wait a tick
                self._standup_tick(now_ms)
                self._paper_tick(now_ms)
            self.tournaments.tick(now_ms, self._view(now_ms, rows))
            journal.maybe_flush(now)
        return {"ok": True, "day": self.day}

    def _drain_sources(self, now):
        """Give sources.py its turn on the clock thread (``drain()``), plus registered ticks."""
        sources = sys.modules.get(__package__ + ".sources")
        drain = getattr(sources, "drain", None) if sources is not None else None
        if callable(drain):
            try:
                drain()
            except Exception:
                pass
        for callback in list(TICKS):
            try:
                callback(now)
            except Exception:
                pass

    def _view(self, now_ms, rows):
        local = self.journal().local(now_ms)
        return {"day": self.day, "minute": local.hour * 60 + local.minute,
                "presence": dict(self.states), "since": dict(self.since),
                "visible": [str(row["key"]) for row in rows or []],
                "standupOpen": bool(self.state.get("openStandup"))}

    # ── rollover ──
    def _rollover(self, now_ms, rows, presence):
        journal = self.journal()
        day = journal.day_of(now_ms)
        if self.day == day:
            return
        first = self.day is None
        self.day = day
        if not first:
            self.ctx.bus.publish({"type": "day", "day": day, "tz": journal.tz_name(), "provider": "office",
                                  "at": now_ms})
            try:
                journal.prune(self.ctx.settings["journal"]["retentionDays"], today=day)
            except Exception:
                pass
            journal.flush()
            self.states = {}            # the new day's journal opens with a state snapshot
        if not self._booted:
            self._booted = True
            self._boot(now_ms)

    def _boot(self, now_ms):
        open_standup = self.state.get("openStandup")
        if isinstance(open_standup, dict) and int(open_standup.get("endsAt") or 0) <= now_ms:
            self._end_standup(now_ms)
        self.tournaments.boot(now_ms)
        self._late_paper(now_ms)

    # ── presence diff -> state rows ──
    def _presence(self, now_ms, rows, presence):
        if not isinstance(presence, dict) or rows is None:
            return
        seen = set()
        for row in rows:
            key = str(row["key"])
            seen.add(key)
            entry = presence.get(key) if isinstance(presence.get(key), dict) else {}
            state = norm_state(entry.get("state")) or ("offline" if not entry else self.states.get(key))
            if state is None:
                continue
            provider = row.get("providerKind") or entry.get("providerKind")
            self.providers[key] = provider
            before = self.states.get(key)
            if before == state:
                continue
            event = {"type": "state", "agent": key, "to": state, "provider": provider, "at": now_ms}
            if before:
                event["from"] = before
                self.since[key] = now_ms
            elif key not in self.since:
                self.since[key] = _stamp_ms(entry.get("updated"), now_ms)
            self.states[key] = state
            self.ctx.bus.publish(event)
            if before == "working" and state != "working" and key not in self.run_seen:
                self._set_mood(key, "clear", now_ms)
        for key in [key for key in self.states if key not in seen]:
            self.states.pop(key, None)
            self.since.pop(key, None)

    # ── moods (design 3.4) ──
    def on_event(self, ev):
        """Bus listener: ``run`` start/end drive focused / stuck / relieved / back on track."""
        if ev.get("type") != "run" or not ev.get("agent"):
            return
        agent = ev["agent"]
        at = int(ev.get("at") or self.clock() * 1000)
        pending = []
        with self._lock:
            self.run_seen.add(agent)
            runs = self.runs.setdefault(agent, {})
            ref = str(ev.get("ref") or "")
            if ev.get("phase") == "start":
                runs[ref or f"run@{at}"] = at
                return
            if ev.get("phase") != "end":
                return
            if ref in runs:
                runs.pop(ref)
            elif runs:
                runs.pop(min(runs, key=runs.get))
            outcome = str(ev.get("outcome") or "").lower()
            mood = self.moods.get(agent)
            if ev.get("ok") is True:
                self.failures.pop(agent, None)
                if mood == "stuck":
                    pending.append(("clear", True))
                elif int(ev.get("ms") or 0) >= RELIEVED_RUN_MS:
                    pending.append(("relieved", False))
                elif mood == "focused" and not self._long_run(agent, at):
                    pending.append(("clear", False))
            elif outcome in FAILED_SKIP or ev.get("ok") is not False:   # a stop, or an unknown end ("gone")
                if mood == "focused" and not self._long_run(agent, at):
                    pending.append(("clear", False))
            else:
                fails = [t for t in self.failures.get(agent, []) if at - t < STUCK_WINDOW_MS] + [at]
                self.failures[agent] = fails[-10:]
                if len(fails) >= STUCK_FAILS and mood != "stuck":
                    pending.append(("stuck", False))
                elif mood == "focused" and not self._long_run(agent, at):
                    pending.append(("clear", False))
        for mood, back in pending:
            self._set_mood(agent, mood, at, back_on_track=back)

    def _long_run(self, agent, now_ms):
        runs = self.runs.get(agent) or {}
        return any(now_ms - started >= FOCUS_MS for started in runs.values())

    def _set_mood(self, agent, mood, now_ms, back_on_track=False):
        with self._lock:
            current = self.moods.get(agent, "clear")
            if current == mood and not back_on_track:
                return
            if mood == "clear":
                self.moods.pop(agent, None)
            else:
                self.moods[agent] = mood
            if mood == "relieved":
                self.relieved_until[agent] = now_ms + RELIEVED_SHOW_MS
            else:
                self.relieved_until.pop(agent, None)
        if not self.ctx.feature("moods"):
            return
        event = {"type": "mood", "agent": agent, "mood": mood, "at": now_ms, "provider": self.providers.get(agent)}
        if back_on_track:
            event["backOnTrack"] = True
        self.ctx.bus.publish(event)

    def _moods_tick(self, now_ms):
        for agent, until in list(self.relieved_until.items()):
            if now_ms >= until and self.moods.get(agent) == "relieved":
                self._set_mood(agent, "clear", now_ms)
        for agent, runs in list(self.runs.items()):
            for ref, started in list(runs.items()):
                if now_ms - started > RUN_STALE_MS:
                    runs.pop(ref, None)
        for agent, fails in list(self.failures.items()):
            if self.moods.get(agent) == "stuck" and fails and now_ms - fails[-1] >= STUCK_FADE_MS:
                self.failures.pop(agent, None)
                self._set_mood(agent, "clear", now_ms)
        for agent in set(self.runs) | set(self.states):
            if self.moods.get(agent) in ("stuck", "focused", "relieved"):
                continue
            if self._long_run(agent, now_ms):
                self._set_mood(agent, "focused", now_ms)
            elif agent not in self.run_seen and self.states.get(agent) == "working" and \
                    now_ms - int(self.since.get(agent, now_ms)) >= FOCUS_MS:
                self._set_mood(agent, "focused", now_ms)       # providers without run events
        for agent in [a for a, mood in self.moods.items() if mood == "focused"]:
            if agent in self.run_seen:
                if not self._long_run(agent, now_ms):
                    self._set_mood(agent, "clear", now_ms)
            elif self.states.get(agent) != "working":
                self._set_mood(agent, "clear", now_ms)

    # ── needs expiry ──
    def _needs_tick(self, now_ms):
        for need in self.ctx.bus.open_needs():
            expires = int(need.get("expiresAt") or 0)
            if (expires and expires <= now_ms) or now_ms - int(need.get("at") or now_ms) > NEED_MAX_AGE_MS:
                self.ctx.bus.publish({"type": "needs.close", "agent": need.get("agent"), "outcome": "expired",
                                      "ref": need.get("ref") or need.get("need"), "provider": need.get("provider"),
                                      "at": now_ms})

    # ── stand-up (design 3.6) ──
    def _standup_cfg(self):
        cfg = self.ctx.settings.get("standup") or {}
        return cfg.get("time", "09:30"), list(cfg.get("days") or [])

    def _standup_tick(self, now_ms):
        open_standup = self.state.get("openStandup")
        if isinstance(open_standup, dict):
            if now_ms >= int(open_standup.get("endsAt") or 0):
                self._end_standup(now_ms)
            return
        if not self.ctx.feature("standup") or self.state.get("lastStandupDay") == self.day:
            return
        journal = self.journal()
        hhmm, days = self._standup_cfg()
        if datetime.date.fromisoformat(self.day).isoweekday() not in days:
            return
        due = due_ms(self.day, hhmm, journal.tz())
        if due <= now_ms < due + GRACE_MS:
            self.run_standup(now_ms, manual=False)

    def _end_standup(self, now_ms):
        open_standup = self.state.pop("openStandup", None) or {}
        self.save_state()
        if open_standup.get("id"):
            self.ctx.bus.publish({"type": "standup.end", "id": open_standup["id"], "status": "done",
                                  "provider": "office", "at": now_ms})

    def run_standup(self, now_ms, manual=False):
        """Build and start one stand-up. Restart-safe: the Meetings record is written first with
        a stable id (same id again replaces it), then the state, then the stream event."""
        journal = self.journal()
        day = journal.day_of(now_ms)
        local = journal.local(now_ms)
        standup_id = f"standup-{day.replace('-', '')}" + (local.strftime("-%H%M%S") if manual else "")
        since = int(self.state.get("lastStandupAt") or 0) or now_ms - STANDUP_DEFAULT_BACK_MS
        since = max(since, now_ms - STANDUP_MAX_BACK_MS)
        rows = builders.read_rows(journal, since, now_ms)
        roster = self.ctx.roster_rows() or []
        presence = {key: {"state": state} for key, state in self.states.items()}
        live = self.ctx.call("presence", default=None)
        if isinstance(live, dict):
            presence = {key: {"state": norm_state((row or {}).get("state")) or "offline"}
                        for key, row in live.items() if isinstance(row, dict)}
        result = builders.standup(rows, roster, presence, hour_of=lambda ms: journal.local(ms).hour)
        if not manual:
            self.state["lastStandupDay"] = day
        if not result["participants"]:
            self.save_state()
            self.ctx.bus.publish({"type": "standup.start", "id": standup_id, "status": "skipped",
                                  "summary": result["summary"], "provider": "office", "at": now_ms})
            return {"started": False, "skipped": True, "id": standup_id}
        started = int(now_ms // 1000)
        topic = T.standup_topic(journal.local(now_ms).hour)
        record = {"id": standup_id, "topic": topic, "purpose": topic,
                  "kind": "standup", "organizer": "office", "participants": result["participants"],
                  "agents": result["participants"], "responses": result["responses"], "summary": result["summary"],
                  "startedAt": started, "endedAt": started + STANDUP_MS // 1000, "endedBy": "office",
                  "status": "completed"}
        self.ctx.call("append_meeting_history", record, replace=True)
        self.state["lastStandupAt"] = now_ms
        self.state["openStandup"] = {"id": standup_id, "endsAt": now_ms + STANDUP_MS}
        self.save_state()
        self.ctx.bus.publish({"type": "standup.start", "id": standup_id, "status": "open", "lines": result["lines"],
                              "summary": result["summary"], "participants": result["participants"],
                              "provider": "office", "at": now_ms})
        return {"started": True, "id": standup_id, "participants": len(result["participants"])}

    def standup_now(self):
        now_ms = int(self.clock() * 1000)
        with self._lock:
            if self.day is None:
                self.tick(now_ms / 1000.0)
            if not self.ctx.feature("standup"):
                raise _refuse("off", "Stand-ups are switched off in Settings.")
            if isinstance(self.state.get("openStandup"), dict):
                raise _refuse("busy", "A stand-up is already going on.")
            return self.run_standup(now_ms, manual=True)

    # ── the Daily Office (design 3.10) ──
    def build_paper(self, day, now_ms):
        journal = self.journal()
        start, end = journal.day_bounds(day)
        rows = builders.read_rows(journal, start - 1, min(end - 1, now_ms))
        return builders.paper(day, journal.tz_name(), rows, self.ctx.roster_rows() or [], now_ms,
                              hour_of=lambda ms: journal.local(ms).hour)

    def make_paper(self, day, now_ms, publish=True):
        paper = self.build_paper(day, now_ms)
        try:
            self.journal().save_paper(day, paper)
        except OSError:
            return None
        if publish:
            # (news: whether it has anything to tell, so the page announces only a paper worth reading)
            self.ctx.bus.publish({"type": "paper.ready", "day": day, "news": builders.paper_has_news(paper),
                                  "provider": "office", "at": now_ms})
        return paper

    def _paper_tick(self, now_ms):
        if not self.ctx.feature("newspaper") or self.state.get("lastPaperDay") == self.day:
            return
        due = due_ms(self.day, (self.ctx.settings.get("newspaper") or {}).get("time", "18:00"), self.journal().tz())
        if now_ms >= due and self.make_paper(self.day, now_ms) is not None:
            self.state["lastPaperDay"] = self.day
            self.save_state()

    def _late_paper(self, now_ms):
        """At boot: yesterday's paper when the server was down at paper time and that day has a
        journal (never for a day without one). Saved quietly, no announcement."""
        if not self.ctx.feature("newspaper"):
            return
        journal = self.journal()
        yesterday = (datetime.date.fromisoformat(self.day) - datetime.timedelta(days=1)).isoformat()
        if self.state.get("lastPaperDay") in (yesterday, self.day) or journal.load_paper(yesterday) is not None:
            return
        if int((journal.summary(yesterday).get("office") or {}).get("lines") or 0) <= 0:
            return
        self.make_paper(yesterday, journal.day_bounds(yesterday)[1] - 1, publish=False)

    def paper_now(self):
        now_ms = int(self.clock() * 1000)
        with self._lock:
            if self.day is None:
                self.tick(now_ms / 1000.0)
            if not self.ctx.feature("newspaper"):
                raise _refuse("off", "The newspaper is switched off in Settings.")
            paper = self.make_paper(self.day, now_ms)
            if paper is None:
                raise _refuse("not_saved", "The newspaper could not be saved.")
            return {"made": True, "day": self.day}

    def paper_preview(self, day):
        now_ms = int(self.clock() * 1000)
        with self._lock:
            return self.build_paper(day, now_ms)

    # ── test injector (VO_LIFE_TEST_INJECT=1 + loopback only, routes.py) ──
    def test_tournament(self, body):
        """Start a tournament now with the given visible, free players (skips the window and the
        10 minute idle wait; everything else is the real path)."""
        now_ms = int(self.clock() * 1000)
        with self._lock:
            if self.day is None:
                self.tick(now_ms / 1000.0)
            if self.tournaments.current is not None or not self.tournaments.allowed():
                return {"started": False}
            view = self._view(now_ms, self.ctx.roster_rows())
            wanted = body.get("players") if isinstance(body.get("players"), list) else view["visible"]
            players = [key for key in wanted if isinstance(key, str) and self.tournaments.free(key, view)][:4]
            from .tournament import games_available
            games = games_available(self.ctx.call("layout_types", default=set()))
            game = body.get("game") if body.get("game") in games else (games[0] if games else None)
            if len(players) < 2 or game is None:
                return {"started": False}
            local = self.journal().local(now_ms)
            index = 100 + local.hour * 60 + local.minute          # never a real window index
            tour = self.tournaments.begin(now_ms, self.day, index, game, players)
            return {"started": True, "id": tour["id"]}


def _refuse(code, message):
    """The routes' error (409 + message) for a Settings button that cannot run now."""
    from .routes import LifeError
    return LifeError(409, code, message)


TICKS = []
SCHEDULER = None


def add_tick(callback):
    """``callback(now_seconds)`` on every clock tick (sources.py may use it instead of ``drain``)."""
    TICKS.append(callback)


def start(ctx):
    """Called by ``office_life.start``: install and run the clock thread once."""
    global SCHEDULER
    if SCHEDULER is None:
        SCHEDULER = Scheduler(ctx).install()
        SCHEDULER.start()
    return SCHEDULER


def stop():
    """Idempotent (atexit and the server's shutdown may both call it)."""
    if SCHEDULER is not None:
        SCHEDULER.stop()
