"""Office life journal on disk (design 1.4).

``<root>/journal/YYYY-MM-DD.jsonl``: one compact line per event, the day being the office-local
date of the event time (office time zone), so DST never splits or merges a day.
``<root>/journal/YYYY-MM-DD.summary.json``: per-agent and office counters for the builders.
``<root>/papers/YYYY-MM-DD.json`` and ``<root>/state.json``: written atomically.

Bounded: 4000 lines / 1.5 MB per day (past it only priority kinds are kept, the rest counted as
``dropped``), 40 MB for the whole folder (oldest days first), retention in days. Appends never
rewrite a file; a torn last line after a crash is skipped by the reader.
"""

import collections
import copy
import datetime
import json
import os
import re
import tempfile
import threading
import time

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - python < 3.9
    ZoneInfo = None
    ZoneInfoNotFoundError = Exception

import data_owner

from . import events

LINE_CAP = 4000
BYTE_CAP = 1_500_000
HARD_FACTOR = 2                 # priority kinds stop at twice the cap
FOLDER_CAP = 40 * 1024 * 1024
FLUSH_EVERY = 30.0
PAGE_MAX = 2000
SUMMARY_DAYS_IN_MEMORY = 3
LIST_MAX = 20
WAITS_MAX = 200
LATE_DAYS = 2                   # events older than this many days are refused
_DAY_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.(jsonl|summary\.json|json)$")
_CANCELLED = ("cancelled", "canceled", "interrupted", "aborted", "stopped")
_HOUR_SKIP = frozenset({"state", "mood", "interns.set", "settings", "day", "needs.close", "tournament.cheer"})
_TZ_CACHE = {}


def zone(name):
    """ZoneInfo for ``name``; UTC when empty or unknown."""
    key = str(name or "UTC")
    cached = _TZ_CACHE.get(key)
    if cached is not None:
        return cached
    tz = datetime.timezone.utc
    if ZoneInfo is not None and key != "UTC":
        try:
            tz = ZoneInfo(key)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            tz = datetime.timezone.utc
    _TZ_CACHE[key] = tz
    return tz


def atomic_write_json(path, data):
    """Temp file in the same folder, fsync, ``os.replace`` (never a half-written file)."""
    folder = os.path.dirname(path) or "."
    data_owner.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=folder)
    data_owner.adopt_fd(fd, folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return copy.deepcopy(default)


def new_agent_summary():
    return {"runsOk": 0, "runsFailed": 0, "runsCancelled": 0, "runMs": 0, "longestRunMs": 0, "tools": {},
            "tasks": 0, "tasksDone": [], "projectsDone": [], "handoffsOut": {}, "handoffsIn": {}, "visitors": {},
            "cron": 0, "needs": {"count": 0, "answered": 0, "waitMs": 0}, "xp": 0,
            "games": {"played": 0, "wins": 0, "titles": 0}, "events": 0}


def new_summary(day, tz_name):
    return {"day": day, "tz": tz_name, "agents": {},
            "office": {"hours": [0] * 24, "dropped": 0, "events": 0, "lines": 0, "projectsDone": [], "cakes": 0,
                       "visitors": {}, "cron": 0, "needWaits": [], "standup": False, "standupId": "",
                       "paper": False, "champion": "", "tournaments": 0}}


def _bump(table, key, by=1):
    table[key] = int(table.get(key) or 0) + by


class Journal:
    def __init__(self, root, tz_name=None, clock=time.time, line_cap=LINE_CAP, byte_cap=BYTE_CAP,
                 folder_cap=FOLDER_CAP, flush_every=FLUSH_EVERY):
        self.root = root
        self.dir = os.path.join(root, "journal")
        self.papers_dir = os.path.join(root, "papers")
        self.state_path = os.path.join(root, "state.json")
        self._tz_name = tz_name or (lambda: "UTC")
        self._clock = clock
        self.line_cap = line_cap
        self.byte_cap = byte_cap
        self.folder_cap = folder_cap
        self.flush_every = flush_every
        self._lock = threading.RLock()
        self._sizes = {}                                   # day -> [lines, bytes]
        self._summaries = collections.OrderedDict()        # day -> summary (in memory)
        self._dirty = set()
        self._last_flush = clock()
        self._need_open = collections.OrderedDict()        # (agent, ref) -> at ms
        self._played = collections.OrderedDict()           # (tournament id, match) -> (day, players, winner)
        self.disabled = False

    # ── time ──
    def tz_name(self):
        try:
            name = str(self._tz_name() or "UTC")
        except Exception:
            name = "UTC"
        return name if zone(name) is not datetime.timezone.utc or name == "UTC" else "UTC"

    def tz(self):
        return zone(self.tz_name())

    def local(self, ms=None):
        ms = self._clock() * 1000 if ms is None else ms
        return datetime.datetime.fromtimestamp(float(ms) / 1000.0, self.tz())

    def day_of(self, ms=None):
        return self.local(ms).date().isoformat()

    def today(self):
        return self.day_of()

    def day_bounds(self, day):
        """``(start_ms, end_ms)`` of an office day (23, 24 or 25 hours long)."""
        date = datetime.date.fromisoformat(day)
        tz = self.tz()
        start = datetime.datetime(date.year, date.month, date.day, tzinfo=tz)
        nxt = date + datetime.timedelta(days=1)
        end = datetime.datetime(nxt.year, nxt.month, nxt.day, tzinfo=tz)
        return int(start.timestamp() * 1000), int(end.timestamp() * 1000)

    def valid_day(self, day, retention_days=None):
        """True for an ISO day that is not in the future and (optionally) within retention."""
        try:
            date = datetime.date.fromisoformat(str(day or ""))
        except ValueError:
            return False
        today = datetime.date.fromisoformat(self.today())
        if date > today:
            return False
        if retention_days is not None and (today - date).days >= int(retention_days):
            return False
        return True

    # ── paths ──
    def _path(self, day):
        return os.path.join(self.dir, f"{day}.jsonl")

    def _summary_path(self, day):
        return os.path.join(self.dir, f"{day}.summary.json")

    def paper_path(self, day):
        return os.path.join(self.papers_dir, f"{day}.json")

    # ── writing ──
    def _size(self, day):
        size = self._sizes.get(day)
        if size is None:
            lines = nbytes = 0
            try:
                with open(self._path(day), "rb") as handle:
                    for raw in handle:
                        lines += 1
                        nbytes += len(raw)
            except OSError:
                pass
            size = self._sizes[day] = [lines, nbytes]
            while len(self._sizes) > 8:
                self._sizes.pop(next(iter(self._sizes)))
        return size

    def append(self, ev):
        """Write one cleaned event; True when it was kept. Never raises on disk errors."""
        if self.disabled or not isinstance(ev, dict) or not ev.get("type"):
            return False
        at = int(ev.get("at") or self._clock() * 1000)
        now_ms = self._clock() * 1000
        if at < now_ms - LATE_DAYS * 86400000 or at > now_ms + 86400000:
            return False
        row = events.journal_row(ev)
        line = json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
        data = line.encode("utf-8")
        with self._lock:
            day = self.day_of(at)
            summary = self._summary(day)
            size = self._size(day)
            over = size[0] >= self.line_cap or size[1] + len(data) > self.byte_cap
            hard = size[0] >= self.line_cap * HARD_FACTOR or size[1] + len(data) > self.byte_cap * HARD_FACTOR
            if over and (ev["type"] not in events.PRIORITY or hard):
                summary["office"]["dropped"] += 1
                self._dirty.add(day)
                return False
            try:
                data_owner.makedirs(self.dir, exist_ok=True)
                with data_owner.open_new(self._path(day), "ab") as handle:
                    handle.write(data)
                    handle.flush()
            except OSError:
                return False
            size[0] += 1
            size[1] += len(data)
            summary["office"]["lines"] = size[0]
            self._count(summary, ev)
            self._dirty.add(day)
            self.maybe_flush()
        return True

    def _summary(self, day):
        summary = self._summaries.get(day)
        if summary is None:
            summary = _read_json(self._summary_path(day))
            if not isinstance(summary, dict) or not isinstance(summary.get("agents"), dict):
                summary = new_summary(day, self.tz_name())
            base = new_summary(day, self.tz_name())["office"]
            office = summary.setdefault("office", {})
            for key, value in base.items():
                office.setdefault(key, value)
            self._summaries[day] = summary
            while len(self._summaries) > SUMMARY_DAYS_IN_MEMORY:
                old_day = next(iter(self._summaries))
                self._write_summary(old_day)
                self._summaries.pop(old_day, None)
        self._summaries.move_to_end(day)
        return summary

    def _agent(self, summary, agent):
        row = summary["agents"].get(agent)
        if row is None:
            row = summary["agents"][agent] = new_agent_summary()
        else:
            for key, value in new_agent_summary().items():
                row.setdefault(key, value)
        return row

    def _count_match(self, summary, ev):
        """Played/wins at a match's start; a walkover for a match already counted (its pre-decided
        winner dropped out mid-match) takes that count back, like the leaderboard, where a match a
        player left is not a played game and a walkover writes nothing."""
        match = (ev.get("id") or "", ev.get("match"))
        if ev.get("walkover"):
            counted = self._played.pop(match, None)
            if counted is not None:
                day, players, winner = counted
                earlier = self._summary(day)
                for player in players:
                    games = self._agent(earlier, player)["games"]
                    games["played"] = max(0, games["played"] - 1)
                    if player == winner:
                        games["wins"] = max(0, games["wins"] - 1)
                self._dirty.add(day)
            return
        players = [player for player in (ev.get("p1"), ev.get("p2")) if player]
        for player in players:
            self._agent(summary, player)["games"]["played"] += 1
        if ev.get("winner"):
            self._agent(summary, ev["winner"])["games"]["wins"] += 1
        self._played[match] = (summary["day"], players, ev.get("winner") or "")
        while len(self._played) > 64:
            self._played.popitem(last=False)

    def _count(self, summary, ev):
        kind = ev["type"]
        agent = ev.get("agent") or ""
        office = summary["office"]
        office["events"] += 1
        row = self._agent(summary, agent) if agent else None
        if row is not None:
            row["events"] += 1
        if agent and kind not in _HOUR_SKIP and not (kind == "run" and ev.get("phase") == "end"):
            hour = self.local(ev.get("at")).hour
            office["hours"][hour] += 1
        if kind == "run" and row is not None and ev.get("phase") == "end":
            outcome = str(ev.get("outcome") or "").lower()
            if ev.get("ok") is True:
                row["runsOk"] += 1
            elif outcome in _CANCELLED or ev.get("ok") is not False:   # stopped, or an unknown end ("gone")
                row["runsCancelled"] += 1
            else:
                row["runsFailed"] += 1
            ms = int(ev.get("ms") or 0)
            row["runMs"] += ms
            row["longestRunMs"] = max(row["longestRunMs"], ms)
            for tool, count in (ev.get("tools") or {}).items():
                _bump(row["tools"], tool, int(count))
        elif kind == "task.done" and row is not None:
            row["tasks"] += 1
            if len(row["tasksDone"]) < LIST_MAX:
                row["tasksDone"].append({"id": ev.get("taskId") or ev.get("ref") or "", "title": ev.get("title") or ""})
        elif kind == "project.done":
            office["cakes"] += 1
            if len(office["projectsDone"]) < LIST_MAX:
                office["projectsDone"].append({"id": ev.get("ref") or "", "title": ev.get("title") or ""})
            for member in ev.get("agents") or ([agent] if agent else []):
                member_row = self._agent(summary, member)
                if len(member_row["projectsDone"]) < LIST_MAX:
                    member_row["projectsDone"].append(ev.get("title") or "")
        elif kind == "handoff" and row is not None:
            _bump(row["handoffsOut"], ev.get("to"))
            _bump(self._agent(summary, ev.get("to"))["handoffsIn"], agent)
        elif kind == "visitor" and row is not None:
            _bump(row["visitors"], ev.get("channel"))
            _bump(office["visitors"], ev.get("channel"))
        elif kind == "cron.fire" and row is not None:
            row["cron"] += 1
            office["cron"] += 1
        elif kind == "xp" and row is not None:
            row["xp"] += int(ev.get("points") or 0)
        elif kind == "needs.open" and row is not None:
            row["needs"]["count"] += 1
            self._need_open[(agent, events.need_slot(ev))] = int(ev.get("at") or 0)
            while len(self._need_open) > 1000:
                self._need_open.popitem(last=False)
        elif kind == "needs.close" and row is not None:
            opened = self._need_open.pop((agent, events.need_slot(ev)), None)
            if ev.get("outcome") == "answered":
                row["needs"]["answered"] += 1
                if opened:
                    wait = max(0, int(ev.get("at") or 0) - opened)
                    row["needs"]["waitMs"] += wait
                    if len(office["needWaits"]) < WAITS_MAX:
                        office["needWaits"].append(wait)
        elif kind == "tournament.match":
            self._count_match(summary, ev)
        elif kind == "tournament.end":
            office["tournaments"] += 1
            if ev.get("champion"):
                self._agent(summary, ev["champion"])["games"]["titles"] += 1
                office["champion"] = ev["champion"]
        elif kind == "standup.start" and ev.get("status") != "skipped":
            office["standup"] = True
            office["standupId"] = ev.get("id") or ""
        elif kind == "paper.ready":
            office["paper"] = True

    def _write_summary(self, day):
        summary = self._summaries.get(day)
        if summary is None or day not in self._dirty:
            return
        try:
            atomic_write_json(self._summary_path(day), summary)
            self._dirty.discard(day)
        except OSError:
            pass

    def maybe_flush(self, now=None):
        now = self._clock() if now is None else now
        if now - self._last_flush >= self.flush_every:
            self.flush()

    def flush(self):
        with self._lock:
            for day in list(self._dirty):
                self._write_summary(day)
            self._last_flush = self._clock()

    # ── reading ──
    def summary(self, day=None):
        """A copy of the counters of ``day`` (today by default)."""
        day = day or self.today()
        with self._lock:
            if day in self._summaries:
                return copy.deepcopy(self._summaries[day])
        data = _read_json(self._summary_path(day))
        return data if isinstance(data, dict) and isinstance(data.get("agents"), dict) \
            else new_summary(day, self.tz_name())

    def read(self, day, after=0, kinds=None, limit=PAGE_MAX):
        """``(rows, next)``: journal rows of ``day`` after line ``after``; ``next`` is the cursor for
        the following page or None. Unreadable (torn) lines are skipped."""
        limit = max(1, min(PAGE_MAX, int(limit or PAGE_MAX)))
        after = max(0, int(after or 0))
        kinds = set(kinds) if kinds else None
        rows = []
        index = 0
        try:
            with open(self._path(day), "rb") as handle:
                for raw in handle:
                    index += 1
                    if index <= after:
                        continue
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(row, dict) or (kinds and row.get("k") not in kinds):
                        continue
                    rows.append(row)
                    if len(rows) >= limit:
                        return rows, index
        except OSError:
            pass
        return rows, None

    def days(self):
        """Days on disk, newest first: ``[{day, paper, standup, lines}]``."""
        found = {}
        for folder in (self.dir, self.papers_dir):
            try:
                names = os.listdir(folder)
            except OSError:
                continue
            for name in names:
                match = _DAY_FILE.match(name)
                if match:
                    found.setdefault(match.group(1), set()).add((folder, match.group(2)))
        out = []
        for day in sorted(found, reverse=True):
            summary = self.summary(day)
            out.append({"day": day, "paper": os.path.isfile(self.paper_path(day)),
                        "standup": bool(summary["office"].get("standup")),
                        "lines": int(summary["office"].get("lines") or 0)})
        return out

    # ── papers and state ──
    def load_paper(self, day):
        data = _read_json(self.paper_path(day))
        return data if isinstance(data, dict) else None

    def save_paper(self, day, paper):
        atomic_write_json(self.paper_path(day), paper)

    def load_state(self):
        data = _read_json(self.state_path, {})
        return data if isinstance(data, dict) else {}

    def save_state(self, state):
        with self._lock:
            atomic_write_json(self.state_path, state)

    # ── retention ──
    def _day_files(self):
        out = collections.defaultdict(list)
        for folder in (self.dir, self.papers_dir):
            try:
                names = os.listdir(folder)
            except OSError:
                continue
            for name in names:
                match = _DAY_FILE.match(name)
                if match:
                    path = os.path.join(folder, name)
                    try:
                        size = os.path.getsize(path)
                    except OSError:
                        size = 0
                    out[match.group(1)].append((path, size))
        return out

    def _forget(self, day, files):
        for path, _size in files:
            try:
                os.unlink(path)
            except OSError:
                pass
        self._summaries.pop(day, None)
        self._sizes.pop(day, None)
        self._dirty.discard(day)

    def prune(self, retention_days, today=None):
        """Delete days older than the retention, then the oldest days while the folder is over its
        cap (today is never deleted). Returns the deleted days."""
        today = today or self.today()
        keep_from = datetime.date.fromisoformat(today) - datetime.timedelta(days=max(1, int(retention_days)) - 1)
        removed = []
        with self._lock:
            files = self._day_files()
            for day in sorted(files):
                if datetime.date.fromisoformat(day) < keep_from:
                    self._forget(day, files.pop(day))
                    removed.append(day)
            total = sum(size for rows in files.values() for _path, size in rows)
            for day in sorted(files):
                if total <= self.folder_cap or day >= today:
                    break
                total -= sum(size for _path, size in files[day])
                self._forget(day, files[day])
                removed.append(day)
        return removed
