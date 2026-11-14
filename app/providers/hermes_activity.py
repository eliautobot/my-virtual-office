"""What a Hermes connection's agents (its profiles) are doing, and their background tasks (design 2.12, 2.4 tasks).

- Presence: Hermes says it two ways, both read here. Its process's live sessions (session.active_list: idle, starting,
  working, streaming, waiting, resuming), every chat it runs itself (the office's, its Desktop's, its dashboard's); and
  the stored sessions of every channel (its messaging gateway and scheduled jobs write their progress into the same
  store: a session not ended with activity in the last 75 s is at work). Read on ready, every 20 s while connected and
  400 ms after `sessions.changed`; per profile, a change goes out as `agent.activity` (the office moves the character).
  GOTCHA: the live list is the whole process's (every profile's): a session counts for a profile only when it is in
  that profile's store.
- Tasks: the subagents an agent delegated work to from a chat (subagent.list, subagent.* events), with their goal,
  status, tools and output; transcript tail, steer, interrupt. The agent's scheduled jobs (Hermes cron) are tasks of
  the agent (scope "agent"), with no transcript. Changes go out as `session.task` (a running one at most every 400 ms).
The link's calls never run on its loop thread: presence reads on its own thread; events only update memory.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from datetime import datetime

from providers import hermes_link as hl

LOG = logging.getLogger("vo.hermes.activity")

POLL_S = 20.0
SETTLE_S = 0.4
ACTIVE_WINDOW_S = 75.0
BUSY = frozenset({"starting", "working", "streaming", "waiting", "resuming"})
KEEP = 100                     # finished subagents remembered per connection
OPEN = ("queued", "running")
STATUS = {"queued": "queued", "running": "running", "completed": "completed", "failed": "failed", "error": "failed",
          "timeout": "timed_out", "timed_out": "timed_out", "interrupted": "cancelled", "cancelled": "cancelled"}


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _ms(v):
    """Seconds, milliseconds or an ISO date as epoch milliseconds (None when it is none of them)."""
    if _num(v):
        return int(round(v * 1000 if v < 1e11 else v))
    if isinstance(v, str) and v:
        try:
            return int(datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    return None


# ── presence ──────────────────────────────────────────────────────────────
class Presence:
    """Per connection: reads who works on its own thread and emits `agent.activity` per profile on change only."""

    def __init__(self, cid: str, link, emit):
        self.cid, self.link, self.emit = cid, link, emit
        self.sent: dict[str, str] = {}
        self.helpers_sent: dict[str, int] = {}
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._due = None
        self._closed = False
        self._thread = None

    def on_ready(self) -> None:
        self.soon(0.0)

    def soon(self, delay: float = SETTLE_S) -> None:
        with self._lock:
            if self._closed:
                return
            at = time.monotonic() + delay
            if self._due is None or at < self._due:
                self._due = at
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="hermes-presence", daemon=True)
                self._thread.start()
        self._wake.set()

    def on_down(self) -> None:
        with self._lock:
            self._due = None
        self.report({})

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._due = None
        self._wake.set()
        self.report({})

    def _run(self) -> None:
        while True:
            with self._lock:
                if self._closed:
                    return
                due = self._due
            now = time.monotonic()
            if due is None or due > now:
                self._wake.wait(None if due is None else due - now)
                self._wake.clear()
                continue
            with self._lock:
                self._due = time.monotonic() + POLL_S
            if not self.link.connected:
                with self._lock:
                    self._due = None
                continue
            try:
                by = self.read()
            except hl.HermesError:
                continue
            except Exception:  # noqa: BLE001 - one bad read never stops the reader
                LOG.exception("hermes presence read failed")
                continue
            with self._lock:
                if self._closed:
                    return
            self.report(by)

    def read(self) -> dict:
        """{profile: {keys, waiting, title, sources, children}} of the profiles at work now (or with busy helper
        sessions: `children` counts its stored sessions that have a `parent_session_id`, are not ended and are busy
        in the process or active in the last 75 s; `sources` maps a busy key to its stored row's `source`)."""
        r = self.link.call("profiles.list", {}, timeout=10)
        profiles = [x["name"] for x in (r or {}).get("profiles") or [] if isinstance(x, dict)
                    and isinstance(x.get("name"), str) and x["name"] and x.get("role") != "setup"]
        now, by = time.time(), {}

        def slot(profile):
            return by.setdefault(profile, {"keys": set(), "waiting": set(), "title": "", "sources": {},
                                           "children": 0})

        def add(profile, key, title, waiting=False, source=""):
            x = slot(profile)
            x["keys"].add(key)
            if waiting:
                x["waiting"].add(key)
            if not x["title"] and title:
                x["title"] = title
            if isinstance(source, str) and source:
                x["sources"][key] = source[:40]

        for profile in profiles[:50]:
            try:
                live = self.link.call("session.active_list", {"profile": profile}, timeout=10)
            except hl.HermesError:
                live = None
            try:
                rows = self.link.rest("GET", "/api/sessions", profile=profile, query={"limit": 25}, timeout=10)
            except hl.HermesError:
                rows = None
            stored = [s for s in (rows or {}).get("sessions") or [] if isinstance(s, dict) and s.get("id")]
            mine = {str(s["id"]): s for s in stored}
            in_process, busy = set(), set()
            for s in (live or {}).get("sessions") or []:
                k = str((s or {}).get("session_key") or "") if isinstance(s, dict) else ""
                if not k or k not in mine:
                    continue
                in_process.add(k)
                if s.get("status") in BUSY:
                    busy.add(k)
                    add(profile, k, str(s.get("title") or ""), s.get("status") == "waiting", mine[k].get("source"))
            for s in stored:
                last = s.get("last_activity_at")
                if s.get("parent_session_id") and not s.get("ended_at") and (
                        str(s["id"]) in busy or (str(s["id"]) not in in_process and _num(last)
                                                 and now - last < ACTIVE_WINDOW_S)):
                    slot(profile)["children"] += 1
                if s.get("ended_at") or s.get("parent_session_id") or not _num(last) or str(s["id"]) in in_process:
                    continue
                if now - last < ACTIVE_WINDOW_S:
                    add(profile, str(s["id"]), str(s.get("title") or ""), source=s.get("source"))
        return by

    def report(self, by: dict) -> None:
        events = []
        with self._lock:
            for profile in sorted(set(by) | set(self.sent)):
                x = by.get(profile)
                x = x if x and x.get("keys") else None      # (helpers alone never move the character)
                keys = sorted(x["keys"]) if x else []
                waiting = sorted(x["waiting"]) if x else []
                sources = {k: x["sources"][k] for k in keys[:50] if k in x.get("sources", {})} if x else {}
                sig = f"{' '.join(keys)}|{' '.join(waiting)}|{x['title']}" if x else ""
                if sources:
                    sig += "|" + " ".join(f"{k}={v}" for k, v in sorted(sources.items()))
                if self.sent.get(profile, "") == sig:
                    continue
                if x:
                    self.sent[profile] = sig
                else:
                    self.sent.pop(profile, None)
                e = {"type": "agent.activity", "kind": "hermes", "connectionId": self.cid, "agentId": profile,
                     "active": bool(x), "sessions": len(keys), "keys": keys[:50]}
                if waiting:
                    e["waiting"] = waiting[:50]
                if sources:
                    e["sources"] = sources
                if x and x["title"]:
                    e["task"] = f'Working on "{x["title"][:80]}"'
                events.append(e)
            # Busy helper sessions (rows with a parent) per profile, on change only: Office life's interns.
            helpers = self.helpers_sent
            for profile in sorted(set(by) | set(helpers)):
                count = int((by.get(profile) or {}).get("children") or 0)
                if helpers.get(profile, 0) == count:
                    continue
                if count:
                    helpers[profile] = count
                else:
                    helpers.pop(profile, None)
                events.append({"type": "agent.helpers", "kind": "hermes", "connectionId": self.cid,
                               "agentId": profile, "children": count})
        if events:
            self.emit(events)


# ── tasks ─────────────────────────────────────────────────────────────────
def task_of(c: dict, prev: dict | None = None, type_: str = "") -> dict:
    """A Hermes subagent (an event's payload, or a subagent.list row) as a side-panel task."""
    prev = prev or {}
    status = STATUS.get(str(c.get("status") or "")) or prev.get("status") or "running"
    tail = c.get("output_tail")[-1] if isinstance(c.get("output_tail"), list) and c["output_tail"] else None
    tail = tail if isinstance(tail, dict) else {}
    t = dict(prev, id=str(c.get("subagent_id") or prev.get("id") or ""), status=status,
             title=str(c.get("goal") or prev.get("title") or "Subagent")[:300], runtime="subagent", kind="subagent")
    if isinstance(c.get("model"), str) and c["model"]:
        t["model"] = c["model"][:120]
    tool = c.get("tool_name") or c.get("last_tool") or tail.get("tool")
    if tool:
        t["lastToolName"] = str(tool)[:80]
    # (as Hermes Desktop reads them: a thinking event's words are its spinner, a progress event's what it does, a
    # finished child's summary (else its last words) its result)
    said = next((x for x in (c.get("tool_preview"), tail.get("preview"),
                             c.get("text") if type_ == "subagent.progress" else None)
                 if isinstance(x, str) and x.strip()), None)
    if said:
        t["lastActivity"] = said[:2000]
    if type_ == "subagent.thinking" and isinstance(c.get("text"), str) and c["text"].strip():
        t["progressSummary"] = c["text"].strip()[:300]
    summary = c.get("summary") or (c.get("text") if type_ == "subagent.complete" else None)
    if summary:
        t["terminalSummary"] = str(summary)[:2000]
    if isinstance(c.get("tool_count"), int) and not isinstance(c.get("tool_count"), bool):
        t["toolUseCount"] = c["tool_count"]
    now = int(time.time() * 1000)
    start = _ms(c.get("started_at"))
    if start:
        t["startedAt"] = start
    t.setdefault("createdAt", start or now)
    if status not in OPEN:
        t["endedAt"] = t.get("endedAt") or now
        if _num(c.get("duration_seconds")) and t.get("startedAt"):
            t["endedAt"] = t["startedAt"] + int(round(c["duration_seconds"] * 1000))
    t["updatedAt"] = now
    t["hasTranscript"] = True
    t["execution"] = {"state": "queued" if status == "queued" else "running" if status == "running" else "finished"}
    if status == "running" and t.get("lastToolName"):
        t["execution"]["tool"] = {"name": t["lastToolName"]}
    return t


def job_task_of(j: dict) -> dict:
    """A Hermes scheduled job as a task of the agent's (it belongs to no chat)."""
    st, last = str(j.get("state") or "").lower(), str(j.get("last_status") or "").lower()
    status = "running" if st == "running" else "queued" if not j.get("last_run_at") else \
        "completed" if last in ("ok", "success", "completed", "delivered") else "failed" if last else "completed"
    t = {"id": f"cron:{j.get('job_id') or j.get('id')}", "status": status,
         "title": str(j.get("name") or j.get("prompt_preview") or j.get("job_id") or "")[:300],
         "runtime": "cron", "kind": "cron", "hasTranscript": False, "here": False,
         "enabled": j.get("enabled") is not False}
    if j.get("prompt_preview"):
        t["progressSummary"] = str(j["prompt_preview"])[:2000]
    if j.get("last_error") or j.get("last_fire_error"):
        t["error"] = str(j.get("last_error") or j.get("last_fire_error"))[:2000]
    if _ms(j.get("last_run_at")):
        t["startedAt"] = t["endedAt"] = _ms(j["last_run_at"])
    if _ms(j.get("next_run_at")):
        t["updatedAt"] = t["nextRunAt"] = _ms(j["next_run_at"])
    if j.get("schedule"):
        t["schedule"] = str(j.get("schedule_display") or j["schedule"])[:120]
    return t


def split(rows: list) -> dict:
    """{active (queued/running, max 200), recent (finished, newest first, max 100)}."""
    def when(t):
        return t.get("endedAt") or t.get("updatedAt") or 0
    return {"active": [t for t in rows if t.get("status") in OPEN][:200],
            "recent": sorted((t for t in rows if t.get("status") not in OPEN), key=when, reverse=True)[:100]}


class Tasks:
    """Per connection: the subagents seen ({id: {task, key, profile, sid}}), throttled `session.task` events."""

    def __init__(self, cid: str, emit):
        self.cid, self.emit = cid, emit
        self.kids: OrderedDict = OrderedDict()
        self._pending: dict[str, dict] = {}
        self._lock = threading.Lock()

    def remember(self, x: dict) -> None:
        with self._lock:
            self.kids[x["task"]["id"]] = x
            self.kids.move_to_end(x["task"]["id"])
            if len(self.kids) > KEEP * 2:
                for k in [k for k, v in self.kids.items() if v["task"]["status"] not in OPEN]:
                    if len(self.kids) <= KEEP * 2:
                        break
                    self.kids.pop(k, None)

    def known(self, task_id: str):
        with self._lock:
            return self.kids.get(str(task_id or ""))

    def upsert_rows(self, key: str, profile: str, sid: str, rows) -> list:
        out = []
        for c in rows if isinstance(rows, list) else []:
            if not isinstance(c, dict) or not c.get("subagent_id"):
                continue
            was = self.known(str(c["subagent_id"]))
            x = {"task": task_of(c, was["task"] if was else None), "key": key, "profile": profile, "sid": sid}
            self.remember(x)
            out.append(x)
        return out

    def rows(self, profile: str, keys: list, here: str | None) -> list:
        with self._lock:
            return [dict(x["task"], here=x["key"] == here, sessionKey=x["key"]) for x in self.kids.values()
                    if x["profile"] == profile and x["key"] in keys]

    def on_event(self, key: str, profile: str, sid: str, evt: dict) -> None:
        t = str(evt.get("type") or "")
        if t not in ("subagent.start", "subagent.progress", "subagent.complete", "subagent.thinking", "subagent.tool"):
            return
        p = evt.get("payload") if isinstance(evt.get("payload"), dict) else {}
        if not p.get("subagent_id"):
            return
        was = self.known(str(p["subagent_id"]))
        extra = {} if t == "subagent.complete" else {"status": p.get("status") or "running"}
        if t == "subagent.complete" and not p.get("status"):
            extra = {"status": "completed"}
        x = {"task": task_of({**p, **extra}, was["task"] if was else None, t), "key": key, "profile": profile,
             "sid": sid}
        self.remember(x)
        self.tell(x)

    def tell(self, x: dict) -> None:
        """A change to the agent's pages: a running task at most every 400 ms, a finished one at once."""
        e = {"type": "session.task", "kind": "hermes", "connectionId": self.cid, "agentId": x["profile"],
             "change": "upserted", "taskId": x["task"]["id"], "task": dict(x["task"], sessionKey=x["key"])}
        tid = x["task"]["id"]
        with self._lock:
            was = self._pending.get(tid)
            if x["task"]["status"] in OPEN:
                if was is not None:
                    was["event"] = e
                    return
                slot = {"event": e}
                slot["timer"] = threading.Timer(SETTLE_S, self._flush, args=(tid,))
                slot["timer"].daemon = True
                self._pending[tid] = slot
                slot["timer"].start()
                return
            if was is not None:
                was["timer"].cancel()
                self._pending.pop(tid, None)
        self.emit([e])

    def _flush(self, tid: str) -> None:
        with self._lock:
            slot = self._pending.pop(tid, None)
        if slot is not None:
            self.emit([slot["event"]])

    def on_down(self) -> None:
        with self._lock:
            for slot in self._pending.values():
                slot["timer"].cancel()
            self._pending.clear()
