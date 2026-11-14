"""The Office life event bus (design 1.1).

``LifeBus`` is a ``provider_hub.ChatHub`` with its own whitelist (``events.clean``) and one stream
key, so the page stream reuses ``provider_hub.serve_sse`` unchanged (ring of 2000 events / 30 min,
``since`` resume, ``resync``, heartbeat, per-client stream cap).

``publish(ev)``: clean -> enabled -> visible-roster filter -> dedupe (TTL map, bounded) and open
state (needs until close, interns/moods per agent compare, open stand-up and tournament) ->
journal append -> fan-out. ``run`` and ``state`` events are journal only (never streamed).
"""

import collections
import copy
import threading
import time

import provider_hub

from . import events

LIFE_KEY = ("life", provider_hub.STAR, provider_hub.STAR)
TTL_MAX = 5000


class LifeBus(provider_hub.ChatHub):
    def __init__(self, journal=None, roster=None, enabled=None, clock=time.time, ttl_max=TTL_MAX, **kwargs):
        super().__init__(clock=clock, **kwargs)
        self.journal = journal
        self._roster = roster            # () -> set of visible office ids, or None when unknown
        self._enabled = enabled          # () -> bool
        self.ttl_max = ttl_max
        self._ttl = collections.OrderedDict()   # dedupe key -> expiry (s)
        self._event_listeners = []
        self._init_open()

    def _init_open(self):
        self._needs = collections.OrderedDict()  # (agent, ref) -> needs.open event
        self._interns = {}
        self._moods = {}
        self._standup = None
        self._tournament = None

    def configure(self, journal=None, roster=None, enabled=None):
        with self._lock:
            if journal is not None:
                self.journal = journal
            if roster is not None:
                self._roster = roster
            if enabled is not None:
                self._enabled = enabled

    # ── filters ──
    @staticmethod
    def clean(event, now_ms=None):
        return events.clean(event, now_ms)

    def enabled(self):
        try:
            return True if self._enabled is None else bool(self._enabled())
        except Exception:
            return True

    def visible(self):
        """The visible roster (set) or None when it cannot be read (then nothing is filtered)."""
        try:
            keys = self._roster() if self._roster is not None else None
        except Exception:
            keys = None
        return set(keys) if keys is not None else None

    def _roster_filter(self, ev, visible):
        if visible is None:
            return ev
        kind = ev["type"]
        if ev.get("agent") and ev["agent"] not in visible:
            return None
        if kind == "handoff" and ev.get("to") not in visible:
            return None
        if kind == "project.done" and "agents" in ev:
            ev["agents"] = [key for key in ev["agents"] if key in visible]
        if kind == "standup.start":
            if "lines" in ev:
                ev["lines"] = [row for row in ev["lines"] if row["agent"] in visible]
            if "participants" in ev:
                ev["participants"] = [key for key in ev["participants"] if key in visible]
        return ev

    # ── dedupe + open state (caller holds the lock) ──
    def _seen(self, key, ttl, now):
        expiry = self._ttl.get(key)
        if expiry is not None and expiry > now:
            return True
        self._ttl[key] = now + ttl
        self._ttl.move_to_end(key)
        if len(self._ttl) > self.ttl_max:
            for old in [k for k, exp in self._ttl.items() if exp <= now]:
                del self._ttl[old]
            while len(self._ttl) > self.ttl_max:
                self._ttl.popitem(last=False)
        return False

    def _admit(self, ev, now):
        """Apply dedupe and the open state; False when the event repeats what is already known."""
        kind = ev["type"]
        agent = ev.get("agent") or ""
        if kind == "needs.open":
            slot = (agent, events.need_slot(ev))
            if slot in self._needs:
                return False
            self._needs[slot] = dict(ev)
            while len(self._needs) > 500:
                self._needs.popitem(last=False)
            return True
        if kind == "needs.close":
            slot = (agent, events.need_slot(ev))
            if slot not in self._needs and not ev.get("ref"):
                # a close without a ref means this agent's ref-less need (of that kind, oldest first)
                slot = next((key for key, held in self._needs.items() if key[0] == agent and not held.get("ref")
                             and (not ev.get("need") or held.get("need") == ev["need"])), slot)
            if slot not in self._needs:
                return False
            held = self._needs.pop(slot)
            if slot[1]:
                ev["ref"] = slot[1]           # the page and the journal close the same slot
            if held.get("need"):
                ev["need"] = held["need"]
            key, ttl = events.dedupe_key(ev)
            self._ttl[key] = now + ttl
            return True
        if kind == "interns.set":
            count = int(ev.get("count") or 0)
            if self._interns.get(agent, 0) == count:
                return False
            if count:
                self._interns[agent] = count
            else:
                self._interns.pop(agent, None)
            return True
        if kind == "mood":
            mood = ev.get("mood") or "clear"
            if self._moods.get(agent, "clear") == mood:
                return False
            if mood == "clear":
                self._moods.pop(agent, None)
            else:
                self._moods[agent] = mood
            return True
        if kind == "tournament.cheer":
            tour = self._tournament
            return bool(tour and tour["start"].get("id") == ev.get("id"))
        key, ttl = events.dedupe_key(ev, self.journal.day_of if self.journal is not None else None)
        if key and self._seen(key, ttl, now):
            return False
        if kind == "standup.start":
            self._standup = dict(ev) if ev.get("status") != "skipped" else None
        elif kind == "standup.end":
            if self._standup and (not ev.get("id") or ev.get("id") == self._standup.get("id")):
                self._standup = None
        elif kind == "tournament.start":
            self._tournament = {"start": dict(ev), "matches": {}, "cheers": {}}
        elif kind == "tournament.match" and self._tournament and \
                self._tournament["start"].get("id") == ev.get("id"):
            self._tournament["matches"][ev.get("match")] = dict(ev)
        elif kind == "tournament.end":
            if self._tournament and self._tournament["start"].get("id") == ev.get("id"):
                self._tournament = None
        return True

    # ── publishing ──
    def publish(self, event, *_legacy, **_ignored):
        """Admit one OfficeEvent. Returns the stream frame, ``{"event": ev}`` for a journal-only
        event, or None when it was dropped (invalid, disabled, not visible, duplicate)."""
        if isinstance(event, (tuple, list)) and _legacy and isinstance(_legacy[0], dict):
            event = _legacy[0]           # ChatHub-style publish(key, event)
        now = self._clock()
        ev = self.clean(event, int(now * 1000))
        if ev is None:
            return None
        if ev["type"] != "settings" and not self.enabled():
            return None
        ev = self._roster_filter(ev, self.visible())
        if ev is None:
            return None
        frame = None
        with self._lock:
            if not self._admit(ev, now):
                return None
            if self.journal is not None and ev["type"] not in ("settings",):
                self.journal.append(ev)
            if ev["type"] not in events.JOURNAL_ONLY:
                self._seq += 1
                frame = {"seq": self._seq, "ts": int(now * 1000), "scope": "connection", "session": "",
                         "event": ev}
                ring = self._rings.get(LIFE_KEY)
                if ring is None:
                    ring = self._rings[LIFE_KEY] = collections.deque()
                ring.append(frame)
                self._trim(LIFE_KEY, ring)
                targets = [s for s in self._subs if LIFE_KEY in s.keys]
            else:
                targets = []
            listeners = list(self._listeners) if frame is not None else []
            event_listeners = list(self._event_listeners)
        for sub in targets:
            sub.put(frame)
        for listener in listeners:
            try:
                listener(LIFE_KEY, frame)
            except Exception:
                pass
        for listener in event_listeners:
            try:
                listener(ev)
            except Exception:
                pass
        return frame if frame is not None else {"event": ev}

    def add_event_listener(self, callback):
        """``callback(ev)`` for every admitted event, journal-only ones included (scheduler, tests)."""
        with self._lock:
            self._event_listeners.append(callback)

        def remove():
            with self._lock:
                if callback in self._event_listeners:
                    self._event_listeners.remove(callback)
        return remove

    def count_cheer(self, tournament_id, match, agent):
        """Add one cheer server-side; the new count, or None when that match is not open."""
        with self._lock:
            tour = self._tournament
            if not tour or tour["start"].get("id") != tournament_id:
                return None
            row = tour["matches"].get(match)
            if not row or agent not in (row.get("p1"), row.get("p2")):
                return None
            key = (match, agent)
            tour["cheers"][key] = tour["cheers"].get(key, 0) + 1
            return tour["cheers"][key]

    # ── reading ──
    def open_needs(self, agent=None, provider=None):
        with self._lock:
            return [dict(ev) for (owner, _ref), ev in self._needs.items()
                    if (agent is None or owner == agent) and (provider is None or ev.get("provider") == provider)]

    def open_state(self):
        """What is open right now, for ``/state`` (visible agents only)."""
        visible = self.visible()

        def shown(agent):
            return visible is None or agent in visible

        with self._lock:
            needs = sorted((dict(ev) for (agent, _r), ev in self._needs.items() if shown(agent)),
                           key=lambda ev: ev.get("at") or 0)
            interns = {agent: count for agent, count in self._interns.items() if shown(agent)}
            moods = {agent: mood for agent, mood in self._moods.items() if shown(agent)}
            standup = copy.deepcopy(self._standup)
            tournament = None
            if self._tournament:
                tour = self._tournament
                tournament = {"start": copy.deepcopy(tour["start"]),
                              "matches": [copy.deepcopy(tour["matches"][k]) for k in sorted(tour["matches"])],
                              "cheers": [{"match": m, "agent": a, "count": n}
                                         for (m, a), n in sorted(tour["cheers"].items())]}
        out = {"needs": needs, "interns": interns, "moods": moods}
        if standup:
            out["standup"] = standup
        if tournament:
            out["tournament"] = tournament
        return out

    def reset(self):
        """Forget everything (tests)."""
        super().reset()
        with self._lock:
            self._ttl.clear()
            self._event_listeners.clear()
            self._init_open()


BUS = LifeBus()
