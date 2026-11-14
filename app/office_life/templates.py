"""Every sentence Office life writes on the server (stand-up lines, the Daily Office).

Zero model inference: text is one of the templates below with slots filled from office data
(agent names from the roster, counts, channel labels, tool kinds, project/task titles, times).
Nothing else is ever pasted into a sentence. English lives in ``TEXT`` only (one table, ready
for translation later).
"""

import re

from . import events

TITLE_CLIP = 32        # task/project titles inside a sentence
NAME_CLIP = 24         # agent names inside a sentence
LINE_SOFT = 70         # a second fact is added only while the line stays this short
LINE_MAX = 120         # never longer (events.LINE_MAX)

TEXT = {
    # stand-up / paper column facts (design 3.6.1), highest first
    "tasks_plain": "Finished {n} {tasks}",
    "tasks_one": "Finished {n} {tasks}: {t1}",
    "tasks_two": "Finished {n} {tasks}: {t1}, {t2}",
    "tasks_more": "Finished {n} {tasks}: {t1} and {k} more",
    "project": "Wrapped up project {title}",
    "project_plain": "Wrapped up a project",
    "projects": "Wrapped up {n} projects",
    "teammate": "a teammate",
    "handed_one": "Handed {n} {jobs} to {name}",
    "handed_many": "Handed {n} {jobs} to {k} teammates",
    "picked_one": "Picked up {n} {jobs} from {name}",
    "picked_many": "Picked up {n} {jobs} from {k} teammates",
    "visitors_one": "Handled {n} {messages} from {c1}",
    "visitors_two": "Handled {n} {messages} from {c1} and {c2}",
    "visitors_more": "Handled {n} {messages} from {c1}, {c2} and more",
    "cron": "Ran {n} scheduled {jobs}",
    "runs": "Worked through {n} {runs}",
    "runs_kind": "Worked through {n} {runs}, {kind}",
    "errors_sorted": "Hit {n} {errors}, all sorted",
    "errors_open": "Hit {n} {errors}, still on it",
    "quiet_standup": "Quiet since the last stand-up",
    "quiet_day": "A quiet day",
    "join": "; ",
    "list_two": "{a} and {b}",
    "list_more": "{a}, {b} and more",
    # "mostly ..." per tool kind (events.TOOL_KINDS; "other" says nothing)
    "kind_terminal": "mostly in the terminal",
    "kind_editor": "mostly in the editor",
    "kind_browser": "mostly in the browser",
    "kind_search": "mostly searching",
    "kind_message": "mostly messaging",
    # stand-up
    "standup_topic": "Morning stand-up",
    "standup_topic_afternoon": "Afternoon stand-up",
    "standup_topic_evening": "Evening stand-up",
    "standup_topic_night": "Night stand-up",
    "standup_summary": "Stand-up: {parts}",
    "summary_agents": "{n} {agents}",
    "summary_tasks": "{n} {tasks} done",
    "summary_visitors": "{n} {messages} handled",
    "list_join": ", ",
    "standup_skipped": "Stand-up skipped: nobody was around",
    # newspaper
    "masthead": "The Daily Office",
    "head_project": "Project {title} is done!",
    "head_project_plain": "A project wrapped up today",
    "head_projects": "{n} projects wrapped up today",
    "head_tasks": "{n} {tasks} done across the office",
    "head_champion": "{name} wins the {game} tournament",
    "head_visitors": "{n} {messages} handled from {channels}",
    "head_runs": "{n} {runs} worked through today",
    "head_quiet": "A quiet day at the office",
    "sub_counts": "{agents} {agents_word} at work: {tasks} {tasks_word}, {runs} {runs_word}, {visitors} {messages}",
    "sub_quiet": "Nobody had much to do today",
    "stat_busiest": "Busiest hour",
    "stat_longest": "Longest run",
    "stat_longest_value": "{name}, {duration}",
    "stat_runs": "Runs",
    "stat_runs_value": "{n} ({failed} with errors)",
    "stat_needs": "Requests answered",
    "stat_needs_value": "{n}, median wait {duration}",
    "stat_messages": "Messages",
    "stat_pair": "{label} {n}",
    "stat_cron": "Scheduled jobs",
    "stat_handoffs": "Handoffs",
    "stat_cakes": "Cakes",
    "stat_champion": "Champion",
    "stat_champion_value": "{name} ({game})",
    "game_pong": "ping pong",
    "game_darts": "darts",
    # durations
    "dur_s": "{s} s",
    "dur_m": "{m} min",
    "dur_h": "{h} h",
    "dur_hm": "{h} h {m} min",
}

# singular, plural
WORDS = {
    "tasks": ("task", "tasks"),
    "jobs": ("job", "jobs"),
    "messages": ("message", "messages"),
    "runs": ("run", "runs"),
    "errors": ("error", "errors"),
    "agents": ("agent", "agents"),
    "points": ("point", "points"),
}

_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF‍️⃣]+")
_SPACES = re.compile(r"\s+")


def word(name, n):
    """Pluralize a counted noun from ``WORDS``: ``word("tasks", 1)`` -> ``"task"``."""
    one, many = WORDS[name]
    return one if int(n) == 1 else many


def clip(value, limit):
    """One clean line of at most ``limit`` characters (ellipsis when cut); "" for nothing."""
    return events.clip(value, limit) or ""


def name(value):
    """An agent name for a sentence: no emoji, single spaces, clipped."""
    text = _EMOJI_RE.sub("", str(value or ""))
    return clip(_SPACES.sub(" ", text), NAME_CLIP)


def title(value):
    return clip(value, TITLE_CLIP)


def say(key, **slots):
    """Fill one template. Counted nouns are passed as slots too (see ``word``)."""
    return TEXT[key].format(**slots)


def duration(ms):
    """``"45 s"``, ``"12 min"``, ``"2 h"``, ``"1 h 5 min"``."""
    seconds = max(0, int(round(int(ms or 0) / 1000.0)))
    if seconds < 60:
        return say("dur_s", s=seconds)
    minutes = seconds // 60
    if minutes < 60:
        return say("dur_m", m=minutes)
    hours, rest = divmod(minutes, 60)
    return say("dur_h", h=hours) if rest == 0 else say("dur_hm", h=hours, m=rest)


def standup_topic(hour):
    """The stand-up's name by the office's local hour it starts at: morning 5-11, afternoon 12-16, evening 17-21,
    night otherwise (a stand-up at 18:26 is not a "Morning stand-up")."""
    try:
        hour = int(hour) % 24
    except (TypeError, ValueError):
        return say("standup_topic")
    if 5 <= hour < 12:
        return say("standup_topic")
    if hour < 5 or hour >= 22:
        return say("standup_topic_night")
    return say("standup_topic_afternoon" if hour < 17 else "standup_topic_evening")


def hour_label(hour):
    return f"{int(hour) % 24:02d}:00"


def channel(value):
    """The display label of a known external channel, else "" (never the raw value)."""
    known = events.channel_of(value)
    return events.channel_label(known) if known else ""


def kind_phrase(kind):
    return TEXT.get(f"kind_{kind}", "") if kind in events.TOOL_KINDS else ""


def game(value):
    return TEXT.get(f"game_{value}", "") if value in events.GAMES else ""


def lower_first(text):
    return text[:1].lower() + text[1:] if text else text


def join_facts(facts, soft=LINE_SOFT, hard=LINE_MAX):
    """The first fact, plus the next one that keeps the line within ``soft`` characters."""
    facts = [fact for fact in facts if fact]
    if not facts:
        return ""
    line = facts[0]
    for extra in facts[1:]:
        candidate = line + TEXT["join"] + lower_first(extra)
        if len(candidate) <= soft:
            line = candidate
            break
    return clip(line, hard)
