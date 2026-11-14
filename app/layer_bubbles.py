"""The floor's chat bubbles for the layer's agents (OpenClaw and Hermes through the copied provider layer, v0.12).

Before the layer (0.9) the office read each OpenClaw agent's newest session transcript from the gateway's own files, so a
bubble showed whatever session the agent worked in, from any channel: the person's message, each step with its tools,
the thinking dots, the answer. OpenClaw 2026.11 keeps its sessions in a database and the layer runs the chats, so those
files are gone. The layer's bus carries every run the floor needs instead: the office's own chats, and (the layer's
chat module follows every session agent.activity says is working, ``followFloor``) every other channel's, marked
``outside``. ``LayerBubbles`` keeps the last runs of each agent from those events and hands /agent-chat the same message
shape the transcript reader made (role, text, tools, thinking, ts/epochMs, session meta), for the agent's current
session. Bounded: a few runs per agent, text capped; one dict update per event, nothing per frame (the page still polls
/agent-chat every 2.5 s with its ETag). Read only: nothing here calls a provider or a model.
"""

import collections
import json
import threading
import time

TEXT_KEEP = 4000          # the answer kept while it is written (the bubble shows its first 500 characters)
SHOW_TEXT = 500
THINK_KEEP = 400
RUNS_PER_AGENT = 10
RUNS_MAX = 400
TOOLS_PER_RUN = 40
RUN_QUIET_MS = 15 * 60 * 1000   # a run with no end heard for this long is shown as no longer going on


def _now_ms():
    return int(time.time() * 1000)


def _time_label(ms):
    try:
        return time.strftime("%H:%M", time.localtime(ms / 1000))
    except (OverflowError, OSError, ValueError):
        return ""


def session_meta(session_key):
    """What 0.9's transcript reader said of the session a bubble shows (its key, title and kind)."""
    key = str(session_key or "")
    kind = key.split(":")[-1] if key else ""
    live_mode = kind == "vw-live-mode-planner"
    title = "Live Agent Mode" if live_mode else ("Main chat" if kind == "main" or not kind else kind)
    return {
        "sessionKey": key,
        "sessionTitle": title,
        "sessionKind": "live-mode" if live_mode else ("main" if kind == "main" else "other"),
        "liveMode": live_mode,
        "activeSession": True,
    }


def _args_of(event):
    raw = event.get("raw")
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return {k: (v if not isinstance(v, str) else v[:300]) for k, v in list(parsed.items())[:12]}
        except (TypeError, ValueError):
            pass
    text = str(event.get("input") or "")
    return {"command": text[:300]} if text else {}


class LayerBubbles:
    """The last runs of each office agent, from the layer's bus, as bubble messages."""

    def __init__(self, resolve, now_ms=_now_ms):
        self.resolve = resolve          # bus event -> (office status key, provider kind) or None
        self.now_ms = now_ms
        self.lock = threading.Lock()
        self.runs = collections.OrderedDict()   # runId -> run
        self.by_agent = {}                      # status key -> deque of runIds, newest last

    # ------------------------------------------------------------------ events
    def on_event(self, event):
        if not isinstance(event, dict):
            return
        kind = event.get("type")
        run_id = str(event.get("runId") or "")
        if not run_id or kind not in ("run.start", "run.input", "run.delta", "run.status", "tool.start", "tool.update",
                                      "tool.end", "approval.requested", "approval.resolved", "run.end"):
            return
        with self.lock:
            if kind == "run.start":
                self._start(event, run_id)
                return
            run = self.runs.get(run_id)
            if run is None:
                return
            run["at"] = self.now_ms()
            if kind == "run.input":
                if not run["input"]:
                    run["input"] = str(event.get("text") or "")[:SHOW_TEXT]
            elif kind == "run.delta":
                piece = event.get("text")
                if isinstance(piece, str) and piece:
                    if event.get("replace"):
                        run["text"] = piece[:TEXT_KEEP]
                    elif len(run["text"]) < TEXT_KEEP:
                        run["text"] = (run["text"] + piece)[:TEXT_KEEP]
                thought = event.get("thinking")
                if isinstance(thought, str) and thought:
                    run["thinking"] = (run["thinking"] + thought)[-THINK_KEEP:]
            elif kind == "run.status":
                run["phase"] = str(event.get("phase") or "")[:80]
            elif kind == "tool.start":
                tools = run["tools"]
                tid = str(event.get("toolId") or len(tools))
                if tid not in tools and len(tools) >= TOOLS_PER_RUN:
                    tools.popitem(last=False)
                tools[tid] = {"name": str(event.get("name") or "tool"), "arguments": _args_of(event),
                              "summary": str(event.get("title") or "")[:120], "status": "running"}
            elif kind == "tool.update":
                tool = run["tools"].get(str(event.get("toolId") or ""))
                if tool is not None and event.get("raw") and not tool["arguments"]:
                    tool["arguments"] = _args_of(event)
            elif kind == "tool.end":
                tool = run["tools"].get(str(event.get("toolId") or ""))
                if tool is not None:
                    tool["status"] = "error" if event.get("ok") is False else "completed"
            elif kind == "approval.requested":
                run["approval"] = {"id": str(event.get("approvalId") or ""), "status": "pending",
                                   "command": str(event.get("command") or event.get("summary") or "")[:160],
                                   "title": str(event.get("title") or "")[:120]}
            elif kind == "approval.resolved":
                if run.get("approval"):
                    run["approval"]["status"] = "approved" if event.get("approved") else "denied"
            elif kind == "run.end":
                self._end(event, run)

    def _start(self, event, run_id):
        who = self.resolve(event)
        if not who:
            return
        agent, provider = who
        now = self.now_ms()
        run = self.runs.get(run_id)
        if run is None:
            run = {"id": run_id, "agent": agent, "provider": provider, "session": str(event.get("sessionKey") or ""),
                   "start": now, "at": now, "input": "", "text": "", "thinking": "", "phase": "",
                   "tools": collections.OrderedDict(), "approval": None, "ended": False, "status": "",
                   "error": "", "outside": bool(event.get("outside"))}
            self.runs[run_id] = run
            runs = self.by_agent.setdefault(agent, collections.deque())
            runs.append(run_id)
            while len(runs) > RUNS_PER_AGENT:
                self.runs.pop(runs.popleft(), None)
            while len(self.runs) > RUNS_MAX:
                old_id, old = self.runs.popitem(last=False)
                kept = self.by_agent.get(old["agent"])
                if kept is not None and old_id in kept:
                    kept.remove(old_id)
        if event.get("input") and not run["input"]:
            run["input"] = str(event.get("input"))[:SHOW_TEXT]

    def _end(self, event, run):
        run["ended"] = True
        run["status"] = str(event.get("status") or "ok")
        final = event.get("text")
        if isinstance(final, str) and final.strip():
            run["text"] = final[:TEXT_KEEP]
        if run["status"] == "error":
            run["error"] = str(event.get("error") or "The run failed")[:200]
        for tool in run["tools"].values():
            if tool["status"] == "running":
                tool["status"] = "completed" if run["status"] == "ok" else "stopped"
        if event.get("steered") and not run["text"]:
            run["steered"] = True

    # ------------------------------------------------------------------ what /agent-chat shows
    def agents(self):
        with self.lock:
            return [agent for agent, runs in self.by_agent.items() if runs]

    def messages(self, agent):
        """The bubble messages of ``agent``'s current session (the one of its newest run), oldest first."""
        with self.lock:
            ids = list(self.by_agent.get(agent) or ())
            runs = [self.runs[i] for i in ids if i in self.runs]
            if not runs:
                return []
            current = runs[-1]["session"]   # (the deque is in the order the runs started: the newest last)
            now = self.now_ms()
            out = []
            for run in runs:
                if run["session"] != current:
                    continue
                out.extend(self._shape(run, now))
            return out

    def _shape(self, run, now):
        meta = session_meta(run["session"])
        base = {"runId": run["id"], "source": "provider-layer", "provider": run["provider"], **meta}
        out = []
        start = run["start"]
        if run["input"]:
            out.append({"id": f"pl-{run['id']}-in", "role": "user", "text": run["input"], "ts": start,
                        "epochMs": start, "time": _time_label(start), "from": "", **base})
        live = not run["ended"] and now - run["at"] < RUN_QUIET_MS
        tools = [dict(t) for t in run["tools"].values()]
        if not live:
            for tool in tools:
                if tool["status"] == "running":
                    tool["status"] = "stopped"
        text = run["text"]
        if run.get("steered") and not text:
            return out    # (taken into the turn already going on: its answer is that turn's)
        if not (text or tools or run["thinking"] or run["approval"] or run["error"] or live):
            return out
        msg = {"id": f"pl-{run['id']}-out", "role": "assistant", "text": text[:SHOW_TEXT], "ts": start + 1,
               "epochMs": start + 1, "time": _time_label(start), "tools": tools[-12:], **base}
        if live and not text:
            # (no words yet: the thinking dots, as 0.9 showed a step with no text)
            msg["thinking"] = run["thinking"][-120:] or (run["phase"] or "Working")
        if live:
            msg["live"] = True
        if run["approval"]:
            msg["approval"] = dict(run["approval"])
        if run["error"] and not text:
            msg["error"] = run["error"]
        out.append(msg)
        return out


def merge(existing, layer_msgs, limit):
    """/agent-chat's messages of one agent with the layer's: the layer's win where both have the same words (the
    office's own history or a synced copy of the same turn), newest last, ``limit`` at most."""
    if not layer_msgs:
        return existing
    seen = {}
    for m in layer_msgs:
        words = " ".join(str(m.get("text") or "").split())[:160]
        if words:
            seen.setdefault((m.get("role"), words), []).append(int(m.get("epochMs") or 0))
    kept = []
    for m in existing or []:
        words = " ".join(str(m.get("text") or "").split())[:160] if isinstance(m, dict) else ""
        times = seen.get((m.get("role"), words)) if words else None
        if times and any(abs(int(m.get("epochMs") or 0) - t) < 15 * 60 * 1000 for t in times):
            continue
        kept.append(m)
    out = kept + list(layer_msgs)
    out.sort(key=lambda m: int((m or {}).get("epochMs") or 0))
    return out[-limit:]
