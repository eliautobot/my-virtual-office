"""OfficeEvent schema for Office life (design 1.2).

One normalized event shape for every provider. ``clean(ev)`` rebuilds an event from the
per-type whitelist (unknown types and fields dropped, strings clipped, numbers bounded),
``dedupe_key(ev, day_of)`` names the event for the bus's TTL map. Nothing here holds or
accepts free text from a provider: labels are clipped office data (names, titles, job
labels) and every enum is a closed set.
"""

import re
import time

# ── closed sets ──────────────────────────────────────────────────────────
PROVIDERS = frozenset({"openclaw", "hermes", "hermes-legacy", "codex", "claude-code", "opencode",
                       "antigravity", "builtin", "office"})
NEEDS = frozenset({"approval", "question", "input"})
NEED_OUTCOMES = frozenset({"answered", "expired", "cancelled", "gone"})
HANDOFF_VIA = frozenset({"spawn", "send", "a2a", "task"})
STATES = frozenset({"working", "finishing", "idle", "meeting", "offline"})
MOODS = frozenset({"focused", "stuck", "relieved", "clear"})
RUN_PHASES = frozenset({"start", "end"})
XP_REASONS = frozenset({"task", "manual"})
STANDUP_STATUS = frozenset({"open", "done", "skipped"})
GAMES = frozenset({"pong", "darts"})
TOURNAMENT_STATUS = frozenset({"done", "called_off"})
TOOL_KINDS = ("terminal", "editor", "browser", "search", "message", "other")

# Outside channels that bring a visitor (design 1.3). Anything else is not a visitor.
EXTERNAL_CHANNELS = {
    "telegram": {"label": "Telegram", "icon": "plane"},
    "discord": {"label": "Discord", "icon": "chat"},
    "slack": {"label": "Slack", "icon": "chat"},
    "whatsapp": {"label": "WhatsApp", "icon": "phone"},
    "signal": {"label": "Signal", "icon": "chat"},
    "sms": {"label": "SMS", "icon": "phone"},
    "email": {"label": "Email", "icon": "envelope"},
    "imessage": {"label": "iMessage", "icon": "phone"},
    "matrix": {"label": "Matrix", "icon": "chat"},
    "mattermost": {"label": "Mattermost", "icon": "chat"},
    "msteams": {"label": "Teams", "icon": "chat"},
    "googlechat": {"label": "Google Chat", "icon": "chat"},
    "line": {"label": "LINE", "icon": "chat"},
    "feishu": {"label": "Feishu", "icon": "chat"},
    "wechat": {"label": "WeChat", "icon": "chat"},
    "irc": {"label": "IRC", "icon": "chat"},
    "twitch": {"label": "Twitch", "icon": "chat"},
    "nostr": {"label": "Nostr", "icon": "chat"},
    "x": {"label": "X", "icon": "chat"},
    "voice": {"label": "Voice", "icon": "phone"},
    "webhook": {"label": "Webhook", "icon": "bolt"},
    "homeassistant": {"label": "Home Assistant", "icon": "house"},
}
_CHANNEL_ALIASES = {"tg": "telegram", "teams": "msteams", "google-chat": "googlechat", "hook": "webhook",
                    "hooks": "webhook", "mail": "email", "gmail": "email", "twitter": "x",
                    "home-assistant": "homeassistant", "ha": "homeassistant"}


def channel_of(value):
    """The EXTERNAL_CHANNELS id for a provider's channel name, or None (not a visitor)."""
    name = str(value or "").strip().lower().replace("_", "-")
    if not name:
        return None
    name = _CHANNEL_ALIASES.get(name, name)
    name = name.replace("-", "") if name.replace("-", "") in EXTERNAL_CHANNELS else name
    return name if name in EXTERNAL_CHANNELS else None


def channel_label(channel):
    entry = EXTERNAL_CHANNELS.get(channel)
    return entry["label"] if entry else ""


_TOOL_RULES = (
    ("terminal", re.compile(r"^(exec|bash|shell|command|process|terminal|run)")),
    ("browser", re.compile(r"(browser|web_fetch|fetch|navigate|open_url|url)")),
    ("search", re.compile(r"(web_search|search|query|grep|find)")),
    ("editor", re.compile(r"^(read|write|edit|apply_patch|patch|multiedit|notebook|file|str_replace)")),
    ("message", re.compile(r"(sessions_send|sessions_spawn|message|send|email|sms)")),
)


def tool_kind(name):
    """Same buckets as game.js ``_toolKindOf``: terminal/editor/browser/search/message/other."""
    text = str(name or "").lower()
    for kind, rule in _TOOL_RULES:
        if rule.search(text):
            return kind
    return "other"


# ── field specs ──────────────────────────────────────────────────────────
MAX_MS = 32503680000000          # year 3000
AGENT_MAX = 120
TITLE_MAX = 60
NAME_MAX = 40
CHANNEL_MAX = 20
REF_MAX = 200
SESSION_MAX = 400
KEYS_MAX = 64
LINES_MAX = 64
LINE_MAX = 120


def _str(limit):
    return ("str", limit)


def _int(lo=0, hi=MAX_MS):
    return ("int", lo, hi)


def _enum(values):
    return ("enum", values)


_BOOL = ("bool",)
_KEYS = ("keys", KEYS_MAX)
_DAY = ("day",)

COMMON = {"agent": _str(AGENT_MAX), "at": _int(), "provider": _enum(PROVIDERS), "ref": _str(REF_MAX),
          "session": _str(SESSION_MAX)}

TYPES = {
    "needs.open": {"need": _enum(NEEDS), "count": _int(0, 99), "cardId": _str(REF_MAX), "expiresAt": _int()},
    "needs.close": {"outcome": _enum(NEED_OUTCOMES), "need": _enum(NEEDS)},
    "interns.set": {"count": _int(0, 99), "shown": _int(0, 48)},
    "handoff": {"to": _str(AGENT_MAX), "via": _enum(HANDOFF_VIA)},
    "visitor": {"channel": ("channel",)},
    "cron.fire": {"name": _str(NAME_MAX), "runAt": _int(), "ok": _BOOL},
    "cron.done": {"name": _str(NAME_MAX), "runAt": _int(), "ok": _BOOL},
    "run": {"phase": _enum(RUN_PHASES), "ok": _BOOL, "outcome": _str(CHANNEL_MAX), "ms": _int(0, 30 * 86400000),
            "tools": ("counts",)},
    "state": {"from": _enum(STATES), "to": _enum(STATES)},
    "mood": {"mood": _enum(MOODS), "backOnTrack": _BOOL},
    "task.done": {"title": _str(TITLE_MAX), "projectId": _str(NAME_MAX * 2), "taskId": _str(NAME_MAX * 2),
                  "points": _int(0, 100000)},
    "xp": {"points": _int(-100000, 100000), "total": _int(-10 ** 9, 10 ** 9), "reason": _enum(XP_REASONS)},
    "project.done": {"title": _str(TITLE_MAX), "agents": _KEYS},
    "standup.start": {"id": _str(NAME_MAX), "status": _enum(STANDUP_STATUS), "lines": ("lines",),
                      "summary": _str(160), "participants": _KEYS},
    "standup.end": {"id": _str(NAME_MAX), "status": _enum(STANDUP_STATUS)},
    "tournament.start": {"id": _str(NAME_MAX), "game": _enum(GAMES), "players": ("keys", 4),
                         "bracket": ("plain",)},
    "tournament.match": {"id": _str(NAME_MAX), "match": _int(0, 16), "round": _int(0, 4), "p1": _str(AGENT_MAX),
                         "p2": _str(AGENT_MAX), "winner": _str(AGENT_MAX), "score": ("score",),
                         "startsAt": _int(), "ms": _int(0, 3600000), "walkover": _BOOL},
    "tournament.cheer": {"id": _str(NAME_MAX), "match": _int(0, 16), "count": _int(0, 10 ** 6)},
    "tournament.end": {"id": _str(NAME_MAX), "champion": _str(AGENT_MAX), "status": _enum(TOURNAMENT_STATUS)},
    "paper.ready": {"day": _DAY, "news": _BOOL},
    "settings": {"settings": ("plain",), "tz": _str(64)},
    "day": {"day": _DAY, "tz": _str(64)},
}

# Types that stay in the journal and never reach the page stream.
JOURNAL_ONLY = frozenset({"run", "state"})
# Types about the whole office (``agent`` optional); every other type needs an agent.
OFFICE_WIDE = frozenset({"project.done", "standup.start", "standup.end", "tournament.start", "tournament.match",
                         "tournament.end", "paper.ready", "settings", "day"})
# Kinds the journal keeps past its per-day cap (design 1.4).
PRIORITY = frozenset({"needs.open", "needs.close", "task.done", "project.done", "standup.start", "standup.end",
                      "tournament.end", "paper.ready", "state"})
# Fields never written to the journal: chat-opening handles (OpenClaw session keys can hold a
# sender id) and the full settings view.
JOURNAL_SKIP = frozenset({"session", "cardId", "settings"})

_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]+")


def clip(value, limit):
    """A single-line string clipped to ``limit`` characters (ellipsis when cut), or None."""
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return None
    text = _CTRL_RE.sub(" ", str(value)).strip()
    if not text:
        return None
    if len(text) > limit:
        text = text[:max(1, limit - 1)].rstrip() + "…"
    return text


def _to_int(value, lo, hi):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return None
    return max(lo, min(hi, number))


def _plain(value, depth=0, budget=None):
    """JSON-safe copy with bounded depth, list length, keys and strings."""
    budget = budget if budget is not None else [400]
    budget[0] -= 1
    if budget[0] < 0 or depth > 5:
        return None
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return max(-MAX_MS, min(MAX_MS, value))
    if isinstance(value, float):
        return value if value == value and abs(value) < 1e15 else None
    if isinstance(value, str):
        return clip(value, LINE_MAX) or ""
    if isinstance(value, (list, tuple)):
        return [_plain(item, depth + 1, budget) for item in list(value)[:32]]
    if isinstance(value, dict):
        out = {}
        for key in list(value)[:48]:
            name = clip(key, 40)
            if name:
                out[name] = _plain(value[key], depth + 1, budget)
        return out
    return None


def _field(spec, value):
    kind = spec[0]
    if kind == "str":
        return clip(value, spec[1])
    if kind == "int":
        return _to_int(value, spec[1], spec[2])
    if kind == "bool":
        return value if isinstance(value, bool) else None
    if kind == "enum":
        text = str(value or "").strip().lower()
        return text if text in spec[1] else None
    if kind == "channel":
        return channel_of(value)
    if kind == "day":
        text = str(value or "").strip()
        return text if _DAY_RE.match(text) else None
    if kind == "keys":
        if not isinstance(value, (list, tuple)):
            return None
        out = []
        for item in value:
            key = clip(item, AGENT_MAX)
            if key and key not in out:
                out.append(key)
            if len(out) >= spec[1]:
                break
        return out
    if kind == "counts":
        if not isinstance(value, dict):
            return None
        out = {}
        for name in TOOL_KINDS:
            number = _to_int(value.get(name), 0, 10 ** 6)
            if number:
                out[name] = number
        return out
    if kind == "score":
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            return None
        pair = [_to_int(item, 0, 99) for item in value]
        return pair if None not in pair else None
    if kind == "lines":
        if not isinstance(value, (list, tuple)):
            return None
        out = []
        for row in list(value)[:LINES_MAX]:
            if not isinstance(row, dict):
                continue
            agent = clip(row.get("agent"), AGENT_MAX)
            line = clip(row.get("line"), LINE_MAX)
            if agent and line:
                out.append({"agent": agent, "line": line, "remote": row.get("remote") is True})
        return out
    if kind == "plain":
        return _plain(value)
    return None


def clean(event, now_ms=None):
    """The event rebuilt from the whitelist, or None when it is not a valid OfficeEvent."""
    if not isinstance(event, dict):
        return None
    kind = str(event.get("type") or "")
    spec = TYPES.get(kind)
    if spec is None:
        return None
    out = {"type": kind}
    for name, field_spec in list(COMMON.items()) + list(spec.items()):
        if name not in event:
            continue
        value = _field(field_spec, event.get(name))
        if value is not None:
            out[name] = value
    if kind not in OFFICE_WIDE and not out.get("agent"):
        return None
    if "at" not in out:
        out["at"] = int(now_ms if now_ms is not None else time.time() * 1000)
    if kind == "visitor" and not out.get("channel"):
        return None
    if kind == "handoff" and (not out.get("to") or out.get("to") == out.get("agent")):
        return None
    return out


def make(kind, agent=None, **data):
    """Build and clean one event: ``make("visitor", "main", channel="telegram", provider="openclaw")``."""
    event = dict(data)
    event["type"] = kind
    if agent is not None:
        event["agent"] = agent
    return clean(event)


def need_slot(ev):
    """The id naming one open need of an agent: its ``ref``, else its ``need`` kind (a provider
    without request ids). ``needs.open`` and ``needs.close`` both use it, so a ref-less need closes."""
    return str(ev.get("ref") or ev.get("need") or "")


def _minute(ev):
    return str(int(ev.get("at") or 0) // 60000)


HOUR = 3600
DAY_TTL = 26 * HOUR


def dedupe_key(ev, day_of=None):
    """``(key, ttl seconds)`` naming a cleaned event for the bus's TTL map, or ``(None, 0)``.

    ``needs.open`` and ``interns.set``/``mood`` are deduplicated by the bus's open state
    (until close / per-agent compare); their keys here are for the TTL map only."""
    kind = ev.get("type")
    agent = ev.get("agent") or ""
    ref = ev.get("ref") or ""
    day = day_of(ev.get("at")) if day_of else _minute(ev)
    if kind == "needs.open":
        return f"needs:{agent}:{need_slot(ev)}", 12 * HOUR
    if kind == "needs.close":
        return f"needs-x:{agent}:{need_slot(ev)}", 600
    if kind == "handoff":
        return f"ho:{agent}:{ev.get('to')}:{ref or _minute(ev)}", 60
    if kind == "visitor":
        return f"vis:{agent}:{ev.get('channel')}", 60
    if kind in ("cron.fire", "cron.done"):
        if ref:
            return f"{kind}:{agent}:{ref}:{ev.get('runAt') or _minute(ev)}", 90
        return f"{kind}:{agent}:{_minute(ev)}", 90
    if kind == "run":
        return (f"run:{ref}:{ev.get('phase')}", 1800) if ref else (None, 0)
    if kind == "task.done":
        return f"task:{ev.get('taskId') or ref}:{ev.get('at')}", DAY_TTL
    if kind == "xp":
        return f"xp:{agent}:{ref or ev.get('at')}", DAY_TTL
    if kind == "project.done":
        return f"proj:{ref or ev.get('title') or ''}:{day}", DAY_TTL
    if kind in ("standup.start", "standup.end"):
        return f"{kind}:{ev.get('id') or day}", DAY_TTL
    if kind in ("tournament.start", "tournament.end"):
        return f"{kind}:{ev.get('id') or ''}", DAY_TTL
    if kind == "tournament.match":
        return f"tour:{ev.get('id') or ''}:{ev.get('match')}:{ev.get('winner') or ''}", DAY_TTL
    if kind == "paper.ready":
        return f"paper:{ev.get('day') or day}", DAY_TTL
    if kind == "day":
        return f"day:{ev.get('day') or day}", DAY_TTL
    return None, 0


def journal_row(ev):
    """The compact journal line for a cleaned event: ``{t,k,a,p,r,d}`` (design 1.4)."""
    row = {"t": int(ev.get("at") or 0), "k": ev["type"]}
    if ev.get("agent"):
        row["a"] = ev["agent"]
    if ev.get("provider"):
        row["p"] = ev["provider"]
    if ev.get("ref") and ev.get("ref") != ev.get("session"):
        row["r"] = ev["ref"]
    data = {k: v for k, v in ev.items()
            if k not in ("type", "agent", "at", "provider", "ref") and k not in JOURNAL_SKIP}
    if data:
        row["d"] = data
    return row


def from_journal_row(row):
    """A journal row back to event shape (replay)."""
    if not isinstance(row, dict) or not row.get("k"):
        return None
    ev = {"type": row["k"], "at": row.get("t")}
    for short, name in (("a", "agent"), ("p", "provider"), ("r", "ref")):
        if row.get(short):
            ev[name] = row[short]
    if isinstance(row.get("d"), dict):
        ev.update(row["d"])
    return ev
