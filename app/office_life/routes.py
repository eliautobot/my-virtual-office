"""HTTP routes of Office life (design 1.5). server.py's ``_vo_gate`` runs first (host check,
same-origin for non-GET, passcode); changes additionally need a manager (a browser session or
this machine, never an agent token). No route calls a model or writes to a provider.

Actions the scheduler/builders register in ``CTX.actions``: ``standup_now()``, ``paper_now()``,
``paper_preview(day)`` -> paper dict, and test-only ``test:<name>(body)`` for the injector.
"""

import collections
import ipaddress
import os
import threading
import time

import provider_hub

from . import CTX, builders, events, settings, today_info
from .bus import LIFE_KEY

PREFIX = "/api/office-life/"
BODY_MAX = 64 * 1024
TEST_EVENTS_MAX = 50
CHEER_GAP_SEC = 1.0
CHEERS_PER_MATCH = 30
_FORWARD_HEADERS = ("X-Forwarded-For", "Forwarded", "X-Real-IP")
FORBIDDEN = "Only the office owner can change Office life (sign in on the office page)."


class LifeError(Exception):
    def __init__(self, status, error, message, **extra):
        super().__init__(message)
        self.status = status
        self.payload = {"ok": False, "error": error, "message": message, **extra}


def handles(path):
    return path == PREFIX.rstrip("/") or path.startswith(PREFIX)


def _q(query, name, default=""):
    values = (query or {}).get(name) or [default]
    return str(values[0] if values else default)


def _client(handler):
    try:
        return str((handler.client_address or ("",))[0])
    except Exception:
        return ""


def _require_manage(handler):
    access = handler._vo_access()
    if access is None or getattr(access, "via_token", False) or not getattr(access, "can_manage", False):
        raise LifeError(403, "forbidden", FORBIDDEN)


def _body(handler):
    body = handler._read_json_body(max_bytes=BODY_MAX)
    if not isinstance(body, dict):
        raise LifeError(400, "invalid", "The request body must be a JSON object.")
    return body


def _retention():
    return int(CTX.settings.get("journal", {}).get("retentionDays") or 14)


def _day(query):
    jr = CTX.journal
    day = _q(query, "day").strip() or (jr.today() if jr else "")
    if jr is None or not jr.valid_day(day, _retention()):
        raise LifeError(404, "no_day", "That day is not in the office history.")
    return day


# ── GET ──
_NEWS = {}   # paper path -> (mtime, has news): the state is asked for often, the paper file changes once a day


def _paper_news(jr, day):
    path = jr.paper_path(day)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return False
    hit = _NEWS.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    news = builders.paper_has_news(jr.load_paper(day))
    _NEWS.clear()
    _NEWS[path] = (mtime, news)
    return news


def state_payload():
    jr = CTX.journal
    day = jr.today() if jr else ""
    ready = bool(jr and os.path.isfile(jr.paper_path(day)))
    # (news: the paper has something to tell; the page announces only such a paper)
    return {"ok": True, "seq": CTX.bus.seq, "day": day, "tz": CTX.tz_name(),
            "settings": settings.public(CTX.settings), "open": CTX.bus.open_state(),
            "today": today_info(),
            "paper": {"day": day, "ready": ready, "news": bool(ready and _paper_news(jr, day))}}


def _journal(query):
    day = _day(query)
    try:
        after = max(0, int(_q(query, "after", "0") or 0))
        limit = max(1, min(2000, int(_q(query, "limit", "2000") or 2000)))
    except ValueError:
        raise LifeError(400, "invalid", "after and limit must be numbers.")
    kinds = [k for k in _q(query, "kinds").split(",") if k in events.TYPES] or None
    rows, nxt = CTX.journal.read(day, after=after, kinds=kinds, limit=limit)
    return {"ok": True, "day": day, "rows": [events.from_journal_row(row) for row in rows], "next": nxt}


def _days():
    jr = CTX.journal
    if jr is None:
        return {"ok": True, "days": [], "today": ""}
    days = [row for row in jr.days() if jr.valid_day(row["day"], _retention())]
    return {"ok": True, "days": days, "today": jr.today()}


def _paper(query):
    day = _day(query)
    jr = CTX.journal
    if _q(query, "preview") in ("1", "true") and day == jr.today():
        build = CTX.actions.get("paper_preview")
        if build is None:
            raise LifeError(503, "not_ready", "The newspaper is not available yet.")
        paper = build(day)
        if not isinstance(paper, dict):
            raise LifeError(404, "no_paper", "Nothing to print yet today.")
        return {"ok": True, "day": day, "paper": paper, "preview": True}
    paper = jr.load_paper(day)
    if paper is None:
        raise LifeError(404, "no_paper", "No newspaper was made that day.")
    return {"ok": True, "day": day, "paper": paper, "preview": False}


# ── POST ──
def _save_settings(handler):
    _require_manage(handler)
    body = _body(handler)
    path = CTX.call("config_path")
    lock, read_json, write_json = CTX.fn("config_lock"), CTX.fn("read_json"), CTX.fn("write_json")
    if not path or not (lock and read_json and write_json):
        raise LifeError(503, "not_ready", "Settings cannot be saved right now.")
    # Merge onto the current settings under the file lock (v0.10.1 saves): two partial
    # saves at once used to merge onto the same old copy, the second dropping the first.
    with lock(path):
        merged, errors = settings.validate(body, CTX.settings)
        if errors:
            raise LifeError(400, "invalid", errors[0]["message"], errors=errors)
        try:
            saved = settings.save(path, merged, lock, read_json, write_json)
        except Exception as exc:
            raise LifeError(409, "not_saved", f"Settings were not saved: {exc}")
        CTX.apply_settings(saved)
    return {"ok": True, "settings": settings.public(CTX.settings), "tz": CTX.tz_name()}


def _action(handler, name, label):
    _require_manage(handler)
    if not CTX.enabled():
        raise LifeError(409, "disabled", "Office life is switched off in Settings.")
    func = CTX.actions.get(name)
    if func is None:
        raise LifeError(503, "not_ready", f"{label} is not available yet.")
    result = func()
    out = {"ok": True}
    if isinstance(result, dict):
        out.update(result)
    return out


class _Cheers:
    """1 cheer per second per client, 30 per client per match (bounded maps)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._last = collections.OrderedDict()
        self._counts = collections.OrderedDict()

    def allow(self, client, tournament, match, now=None):
        now = time.time() if now is None else now
        key = (client, tournament, match)
        with self._lock:
            if now - self._last.get(client, 0.0) < CHEER_GAP_SEC:
                return False
            if self._counts.get(key, 0) >= CHEERS_PER_MATCH:
                return False
            self._last[client] = now
            self._last.move_to_end(client)
            self._counts[key] = self._counts.get(key, 0) + 1
            self._counts.move_to_end(key)
            while len(self._last) > 2000:
                self._last.popitem(last=False)
            while len(self._counts) > 4000:
                self._counts.popitem(last=False)
            return True


CHEERS = _Cheers()


def _cheer(handler):
    body = _body(handler)
    tournament = str(body.get("tournament") or "")[:40]
    agent = str(body.get("agent") or "")[:120]
    try:
        match = int(body.get("match"))
    except (TypeError, ValueError):
        raise LifeError(400, "invalid", "Say which match to cheer for.")
    if not tournament or not agent:
        raise LifeError(400, "invalid", "Say which player to cheer for.")
    if not CTX.feature("tournaments"):
        raise LifeError(409, "disabled", "Tournaments are switched off.")
    if not CHEERS.allow(_client(handler), tournament, match):
        raise LifeError(429, "slow_down", "Cheering is just for fun: one cheer a second.")
    count = CTX.bus.count_cheer(tournament, match, agent)
    if count is None:
        raise LifeError(409, "not_playing", "That player is not in a match right now.")
    CTX.bus.publish({"type": "tournament.cheer", "agent": agent, "id": tournament, "match": match,
                     "count": count, "provider": "office"})
    return {"ok": True, "count": count}


def test_inject_allowed(handler, env=None):
    """The test injector exists only with VO_LIFE_TEST_INJECT=1 for a direct loopback client."""
    env = os.environ if env is None else env
    if str(env.get("VO_LIFE_TEST_INJECT") or "") != "1":
        return False
    try:
        if not ipaddress.ip_address(_client(handler).split("%", 1)[0]).is_loopback:
            return False
    except ValueError:
        return False
    return not any(handler.headers.get(name) for name in _FORWARD_HEADERS)


def _test_event(handler):
    if not test_inject_allowed(handler):
        raise LifeError(404, "not_found", "This Office life call is not available.")
    body = _body(handler)
    action = str(body.get("action") or "")
    if action:
        func = CTX.actions.get("test:" + action)
        if func is None:
            raise LifeError(404, "not_found", "Unknown test action.")
        result = func(body)
        return {"ok": True, "result": result if isinstance(result, (dict, list, str, int, float, bool)) else None}
    batch = body.get("events") if isinstance(body.get("events"), list) else [body]
    published = []
    for ev in batch[:TEST_EVENTS_MAX]:
        frame = CTX.bus.publish(ev)
        published.append(None if frame is None else frame.get("seq"))
    return {"ok": True, "published": published}


_GETS = {
    "state": lambda handler, query: state_payload(),
    "journal": lambda handler, query: _journal(query),
    "days": lambda handler, query: _days(),
    "paper": lambda handler, query: _paper(query),
}
_POSTS = {
    "settings": _save_settings,
    "standup/now": lambda handler: _action(handler, "standup_now", "The stand-up"),
    "paper/now": lambda handler: _action(handler, "paper_now", "The newspaper"),
    "cheer": _cheer,
    "test-event": _test_event,
}


def dispatch(handler, method, path, query=None):
    """Answer ``/api/office-life/*``. True when answered."""
    if not handles(path):
        return False
    route = path[len(PREFIX):] if path.startswith(PREFIX) else ""
    try:
        if method in ("GET", "HEAD") and route == "stream":
            header = handler.headers.get("Last-Event-ID")
            since = provider_hub.parse_since(header if header else _q(query, "since"))
            provider_hub.serve_sse(handler, [LIFE_KEY], since, hub=CTX.bus,
                                   client=provider_hub.stream_client(handler, query), slot="life")
            return True
        if method in ("GET", "HEAD") and route in _GETS:
            handler._send_json(_GETS[route](handler, query or {}))
            return True
        if method == "POST" and route in _POSTS:
            handler._send_json(_POSTS[route](handler))
            return True
        if route != "test-event" and (route in _GETS or route in _POSTS or route == "stream"):
            raise LifeError(405, "method_not_allowed", "This Office life call does not take that method.")
        raise LifeError(404, "not_found", "This Office life call is not available.")
    except LifeError as exc:
        handler._send_json(exc.payload, exc.status)
        return True
