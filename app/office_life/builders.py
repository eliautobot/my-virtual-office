"""Stand-up lines and the Daily Office, built from journal rows (pure functions, unit tested).

Only whitelisted fields of each journal row are read (counts, ids, channel ids, tool kinds,
durations, outcomes, agent keys, project/task titles); every sentence comes from
``templates.TEXT``. A string in any other field can never reach a stand-up line or the paper.
"""

import datetime

from . import events, templates as T

# Journal kinds the builders read (everything else is ignored when paging the journal).
FACT_KINDS = ("run", "task.done", "project.done", "handoff", "visitor", "cron.fire", "needs.open",
              "needs.close", "standup.start", "tournament.start", "tournament.end")
ROWS_MAX = 40000
COLUMNS_MAX = 24
# MVP score weights (design 3.10)
MVP_WEIGHTS = {"tasks": 5, "projects": 20, "handoffs": 2, "visitors": 1, "runsOk": 1}
_FAILED_SKIP = ("cancelled", "canceled", "interrupted", "aborted", "stopped")
_ACTIVITY = ("task.done", "handoff", "visitor", "cron.fire", "needs.open")


# ── reading ──────────────────────────────────────────────────────────────
def read_rows(journal, since_ms, until_ms, kinds=FACT_KINDS, limit=ROWS_MAX):
    """Journal rows with ``since_ms < t <= until_ms`` across office days, oldest day first."""
    if journal is None:
        return []
    first = datetime.date.fromisoformat(journal.day_of(since_ms))
    last = datetime.date.fromisoformat(journal.day_of(until_ms))
    out = []
    day = first
    while day <= last and len(out) < limit:
        cursor = 0
        while cursor is not None and len(out) < limit:
            rows, cursor = journal.read(day.isoformat(), after=cursor, kinds=kinds)
            for row in rows:
                at = _int(row.get("t"))
                if since_ms < at <= until_ms:
                    out.append(row)
        day += datetime.timedelta(days=1)
    out.sort(key=lambda row: _int(row.get("t")))
    return out[:limit]


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _data(row):
    data = row.get("d")
    return data if isinstance(data, dict) else {}


# ── facts ────────────────────────────────────────────────────────────────
def new_facts():
    return {"tasks": [], "taskIds": [], "projects": [], "handOut": {}, "handIn": {}, "visitors": {}, "cron": 0,
            "runsOk": 0, "runsFailed": 0, "runsCancelled": 0, "runMs": 0, "longestRunMs": 0, "tools": {},
            "lastRunOk": None}


def _bump(table, key, by=1):
    table[key] = table.get(key, 0) + by


def collect(rows, hour_of=None):
    """``{"agents": {key: facts}, "office": {...}}`` from journal rows (oldest first)."""
    agents = {}
    office = {"hours": [0] * 24, "projects": [], "projectRefs": [], "visitors": {}, "cron": 0, "runs": 0,
              "runsFailed": 0, "handoffs": 0, "needWaits": [], "longest": None, "standup": None,
              "tournament": None, "games": {}}
    opened = {}

    def facts(key):
        row = agents.get(key)
        if row is None:
            row = agents[key] = new_facts()
        return row

    for row in rows or []:
        if not isinstance(row, dict):
            continue
        kind = row.get("k")
        agent = row.get("a") if isinstance(row.get("a"), str) else ""
        at = _int(row.get("t"))
        data = _data(row)
        if hour_of is not None and agent and (kind in _ACTIVITY or (kind == "run" and data.get("phase") == "start")):
            try:
                office["hours"][int(hour_of(at)) % 24] += 1
            except (TypeError, ValueError):
                pass
        if kind == "run" and agent and data.get("phase") == "end":
            mine = facts(agent)
            outcome = str(data.get("outcome") or "").lower()
            ms = max(0, _int(data.get("ms")))
            if data.get("ok") is True:
                mine["runsOk"] += 1
                mine["lastRunOk"] = True
            elif outcome in _FAILED_SKIP or data.get("ok") is not False:   # stopped, or an unknown end ("gone")
                mine["runsCancelled"] += 1
            else:
                mine["runsFailed"] += 1
                mine["lastRunOk"] = False
                office["runsFailed"] += 1
            office["runs"] += 1
            mine["runMs"] += ms
            if ms > mine["longestRunMs"]:
                mine["longestRunMs"] = ms
            if ms and (office["longest"] is None or ms > office["longest"][1]):
                office["longest"] = (agent, ms)
            tools = data.get("tools") if isinstance(data.get("tools"), dict) else {}
            for tool in events.TOOL_KINDS:
                count = _int(tools.get(tool))
                if count > 0:
                    _bump(mine["tools"], tool, count)
        elif kind == "task.done" and agent:
            mine = facts(agent)
            task_id = str(data.get("taskId") or row.get("r") or "")
            if task_id and task_id in mine["taskIds"]:
                continue
            if task_id:
                mine["taskIds"].append(task_id)
            mine["tasks"].append(T.title(data.get("title")))
        elif kind == "project.done":
            ref = str(row.get("r") or data.get("title") or "")
            if ref and ref in office["projectRefs"]:
                continue
            office["projectRefs"].append(ref)
            title = T.title(data.get("title"))
            office["projects"].append(title)
            members = data.get("agents") if isinstance(data.get("agents"), list) else ([agent] if agent else [])
            for member in members:
                if isinstance(member, str) and member:
                    facts(member)["projects"].append(title)
        elif kind == "handoff" and agent:
            target = data.get("to")
            if isinstance(target, str) and target and target != agent:
                _bump(facts(agent)["handOut"], target)
                _bump(facts(target)["handIn"], agent)
                office["handoffs"] += 1
        elif kind == "visitor" and agent:
            channel = events.channel_of(data.get("channel"))
            if channel:
                _bump(facts(agent)["visitors"], channel)
                _bump(office["visitors"], channel)
        elif kind == "cron.fire" and agent:
            facts(agent)["cron"] += 1
            office["cron"] += 1
        elif kind == "needs.open" and agent:
            opened[(agent, str(row.get("r") or data.get("need") or ""))] = at
        elif kind == "needs.close" and agent:
            started = opened.pop((agent, str(row.get("r") or "")), None)
            if data.get("outcome") == "answered" and started is not None:
                office["needWaits"].append(max(0, at - started))
        elif kind == "standup.start" and data.get("status") != "skipped":
            participants = data.get("participants") if isinstance(data.get("participants"), list) else []
            office["standup"] = {"id": T.clip(data.get("id"), events.NAME_MAX), "at": at,
                                 "participants": len(participants)}
        elif kind == "tournament.start":
            game = data.get("game") if data.get("game") in events.GAMES else ""
            office["games"][str(data.get("id") or "")] = game
        elif kind == "tournament.end":
            tour_id = str(data.get("id") or "")
            champion = data.get("champion") if isinstance(data.get("champion"), str) else ""
            status = data.get("status") if data.get("status") in events.TOURNAMENT_STATUS else "done"
            office["tournament"] = {"id": T.clip(tour_id, events.NAME_MAX), "game": office["games"].get(tour_id, ""),
                                    "champion": champion, "status": status}
    return {"agents": agents, "office": office}


def task_count(facts):
    return len(facts["tasks"])


def run_count(facts):
    return facts["runsOk"] + facts["runsFailed"] + facts["runsCancelled"]


def visitor_count(facts):
    return sum(facts["visitors"].values())


def _ranked(table):
    return sorted(table.items(), key=lambda item: (-item[1], str(item[0])))


def _channel_labels(table):
    return [label for label in (T.channel(key) for key, _n in _ranked(table)) if label]


def _label_list(labels):
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return T.say("list_two", a=labels[0], b=labels[1])
    return T.say("list_more", a=labels[0], b=labels[1])


# ── lines (design 3.6.1) ─────────────────────────────────────────────────
def fact_list(facts, names):
    """Every fact sentence for one agent, highest first."""
    out = []
    titles = [title for title in facts["tasks"] if title]
    n = task_count(facts)
    if n:
        tasks = T.word("tasks", n)
        if not titles:
            out.append(T.say("tasks_plain", n=n, tasks=tasks))
        elif n == 1:
            out.append(T.say("tasks_one", n=n, tasks=tasks, t1=titles[0]))
        else:
            two = T.say("tasks_two", n=n, tasks=tasks, t1=titles[0], t2=titles[1]) if n == 2 and len(titles) > 1 else ""
            out.append(two if two and len(two) <= T.LINE_SOFT
                       else T.say("tasks_more", n=n, tasks=tasks, t1=titles[0], k=n - 1))
    projects = facts["projects"]
    if projects:
        if len(projects) > 1:
            out.append(T.say("projects", n=len(projects)))
        elif projects[0]:
            out.append(T.say("project", title=projects[0]))
        else:
            out.append(T.say("project_plain"))
    for table, one, many in ((facts["handOut"], "handed_one", "handed_many"),
                             (facts["handIn"], "picked_one", "picked_many")):
        if table:
            total = sum(table.values())
            jobs = T.word("jobs", total)
            if len(table) == 1:
                key = next(iter(table))
                who = T.name(names.get(key)) or T.say("teammate")
                out.append(T.say(one, n=total, jobs=jobs, name=who))
            else:
                out.append(T.say(many, n=total, jobs=jobs, k=len(table)))
    labels = _channel_labels(facts["visitors"])
    if labels:
        n = visitor_count(facts)
        messages = T.word("messages", n)
        if len(labels) == 1:
            out.append(T.say("visitors_one", n=n, messages=messages, c1=labels[0]))
        elif len(labels) == 2:
            out.append(T.say("visitors_two", n=n, messages=messages, c1=labels[0], c2=labels[1]))
        else:
            out.append(T.say("visitors_more", n=n, messages=messages, c1=labels[0], c2=labels[1]))
    if facts["cron"]:
        out.append(T.say("cron", n=facts["cron"], jobs=T.word("jobs", facts["cron"])))
    runs = run_count(facts)
    if runs:
        kinds = [(kind, count) for kind, count in _ranked(facts["tools"]) if kind != "other"]
        phrase = T.kind_phrase(kinds[0][0]) if kinds else ""
        if phrase:
            out.append(T.say("runs_kind", n=runs, runs=T.word("runs", runs), kind=phrase))
        else:
            out.append(T.say("runs", n=runs, runs=T.word("runs", runs)))
    if facts["runsFailed"]:
        key = "errors_sorted" if facts["lastRunOk"] is True else "errors_open"
        out.append(T.say(key, n=facts["runsFailed"], errors=T.word("errors", facts["runsFailed"])))
    return out


def line_for(facts, names, quiet="quiet_standup"):
    """One stand-up/paper line: the top fact plus a second one while it stays short."""
    if facts is None:
        return T.say(quiet)
    return T.join_facts(fact_list(facts, names)) or T.say(quiet)


def mvp_score(facts):
    return (MVP_WEIGHTS["tasks"] * task_count(facts) + MVP_WEIGHTS["projects"] * len(facts["projects"])
            + MVP_WEIGHTS["handoffs"] * sum(facts["handOut"].values())
            + MVP_WEIGHTS["visitors"] * visitor_count(facts) + MVP_WEIGHTS["runsOk"] * facts["runsOk"])


# ── stand-up (design 3.6) ────────────────────────────────────────────────
OFFLINE_STATES = ("offline", "")
REMOTE_STATES = ("working", "finishing", "meeting", "waiting")


def presence_state(presence, key):
    row = (presence or {}).get(key)
    return str((row or {}).get("state") or "").lower() if isinstance(row, dict) else ""


def standup(rows, roster_rows, presence, hour_of=None):
    """``{participants, lines, responses, summary}`` for a stand-up over ``rows`` (already cut
    to "since the last stand-up"). Participants are roster agents that are not offline;
    working agents and agents in a meeting take part remotely."""
    names = {str(row["key"]): str(row.get("name") or row["key"]) for row in roster_rows or []}
    data = collect(rows, hour_of)
    participants, lines, responses = [], [], {}
    tasks = visitors = 0
    for row in roster_rows or []:
        key = str(row["key"])
        state = presence_state(presence, key)
        if state in OFFLINE_STATES:
            continue
        facts = data["agents"].get(key)
        line = line_for(facts, names)
        participants.append(key)
        lines.append({"agent": key, "line": line, "remote": state in REMOTE_STATES})
        responses[key] = line
        if facts:
            tasks += task_count(facts)
            visitors += visitor_count(facts)
    if participants:
        parts = [T.say("summary_agents", n=len(participants), agents=T.word("agents", len(participants)))]
        if tasks:
            parts.append(T.say("summary_tasks", n=tasks, tasks=T.word("tasks", tasks)))
        if visitors:
            parts.append(T.say("summary_visitors", n=visitors, messages=T.word("messages", visitors)))
        summary = T.say("standup_summary", parts=T.say("list_join").join(parts))
    else:
        summary = T.say("standup_skipped")
    return {"participants": participants, "lines": lines, "responses": responses, "summary": summary}


# ── the Daily Office (design 3.10) ───────────────────────────────────────
def _median(values):
    ordered = sorted(values)
    if not ordered:
        return 0
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) // 2


def _headline(office, totals, names):
    projects = office["projects"]
    if projects:
        if len(projects) == 1:
            return T.say("head_project", title=projects[0]) if projects[0] else T.say("head_project_plain")
        return T.say("head_projects", n=len(projects))
    if totals["tasks"]:
        return T.say("head_tasks", n=totals["tasks"], tasks=T.word("tasks", totals["tasks"]))
    tour = office["tournament"]
    if tour and tour["champion"] and tour["status"] == "done":
        who = T.name(names.get(tour["champion"]))
        game = T.game(tour["game"])
        if who and game:
            return T.say("head_champion", name=who, game=game)
    labels = _channel_labels(office["visitors"])
    if labels:
        n = sum(office["visitors"].values())
        return T.say("head_visitors", n=n, messages=T.word("messages", n), channels=_label_list(labels))
    if office["runs"]:
        return T.say("head_runs", n=office["runs"], runs=T.word("runs", office["runs"]))
    return T.say("head_quiet")


def _stats(office, names):
    stats = []

    def add(label_key, value):
        stats.append({"label": T.say(label_key), "value": value})

    hours = office["hours"]
    if any(hours):
        add("stat_busiest", T.hour_label(hours.index(max(hours))))
    if office["longest"]:
        key, ms = office["longest"]
        who = T.name(names.get(key))
        if who:
            add("stat_longest", T.say("stat_longest_value", name=who, duration=T.duration(ms)))
    if office["runs"]:
        value = T.say("stat_runs_value", n=office["runs"], failed=office["runsFailed"]) if office["runsFailed"] \
            else str(office["runs"])
        add("stat_runs", value)
    waits = office["needWaits"]
    if waits:
        add("stat_needs", T.say("stat_needs_value", n=len(waits), duration=T.duration(_median(waits))))
    pairs = [T.say("stat_pair", label=T.channel(key), n=n) for key, n in _ranked(office["visitors"]) if T.channel(key)]
    if pairs:
        add("stat_messages", ", ".join(pairs[:4]))
    if office["cron"]:
        add("stat_cron", str(office["cron"]))
    if office["handoffs"]:
        add("stat_handoffs", str(office["handoffs"]))
    if office["projects"]:
        add("stat_cakes", str(len(office["projects"])))
    tour = office["tournament"]
    if tour and tour["champion"] and tour["status"] == "done":
        who, game = T.name(names.get(tour["champion"])), T.game(tour["game"])
        if who and game:
            add("stat_champion", T.say("stat_champion_value", name=who, game=game))
    return stats


def paper_has_news(paper):
    """Whether a Daily Office has something to tell: an agent who did anything that day, an MVP, a stand-up, a
    tournament or an office stat. The quiet paper (no agents, or nobody did anything) has none: nothing to announce."""
    if not isinstance(paper, dict):
        return False
    if paper.get("mvp") or paper.get("standup") or paper.get("tournament") or paper.get("stats"):
        return True
    for column in paper.get("columns") or []:
        stats = column.get("stats") if isinstance(column, dict) else None
        if isinstance(stats, dict) and any(isinstance(v, (int, float)) and v > 0 for v in stats.values()):
            return True
    return False


def paper(day, tz_name, rows, roster_rows, now_ms, hour_of=None):
    """The Daily Office for ``day`` from that day's journal rows."""
    names = {str(row["key"]): str(row.get("name") or row["key"]) for row in roster_rows or []}
    data = collect(rows, hour_of)
    office = data["office"]
    columns = []
    totals = {"tasks": 0, "runs": 0, "visitors": 0, "active": 0}
    for order, row in enumerate(roster_rows or []):
        key = str(row["key"])
        facts = data["agents"].get(key)
        if facts is None:
            columns.append((0, 0, order, {"agent": key, "name": T.name(names[key]), "line": T.say("quiet_day"),
                                          "stats": {"tasks": 0, "runs": 0, "visitors": 0, "handoffs": 0}}))
            continue
        stats = {"tasks": task_count(facts), "runs": run_count(facts), "visitors": visitor_count(facts),
                 "handoffs": sum(facts["handOut"].values())}
        totals["tasks"] += stats["tasks"]
        totals["runs"] += stats["runs"]
        totals["visitors"] += stats["visitors"]
        if any(stats.values()) or facts["projects"] or facts["cron"] or facts["handIn"]:
            totals["active"] += 1
        column = {"agent": key, "name": T.name(names[key]), "line": line_for(facts, names, quiet="quiet_day"),
                  "stats": stats}
        columns.append((mvp_score(facts), facts["runsFailed"], order, column))
    columns.sort(key=lambda item: (-item[0], item[1], item[3]["name"].lower(), item[2]))
    mvp = None
    if columns and columns[0][0] > 0:
        score, _failed, _order, best = columns[0]
        mvp = {"agent": best["agent"], "name": best["name"], "score": score, "reason": best["line"]}
    if totals["active"]:
        subhead = T.say("sub_counts", agents=totals["active"], agents_word=T.word("agents", totals["active"]),
                        tasks=totals["tasks"], tasks_word=T.word("tasks", totals["tasks"]), runs=totals["runs"],
                        runs_word=T.word("runs", totals["runs"]), visitors=totals["visitors"],
                        messages=T.word("messages", totals["visitors"]))
    else:
        subhead = T.say("sub_quiet")
    out = {"day": day, "tz": tz_name, "masthead": T.say("masthead"), "headline": _headline(office, totals, names),
           "subhead": subhead, "columns": [column for *_rest, column in columns[:COLUMNS_MAX]], "mvp": mvp,
           "stats": _stats(office, names), "generatedAt": int(now_ms)}
    if office["standup"]:
        out["standup"] = office["standup"]
    tour = office["tournament"]
    if tour:
        out["tournament"] = {"id": tour["id"], "game": tour["game"], "champion": tour["champion"],
                             "championName": T.name(names.get(tour["champion"])) if tour["champion"] else "",
                             "status": tour["status"]}
    return out
