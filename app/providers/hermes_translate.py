"""Hermes -> the universal chat (design 2.8, the same rules as MVW's providers/hermes/translate.js). Pure: nothing here
talks to Hermes.

- `Translator(run).feed(event)` takes one of Hermes' gateway events (`{type, session_id, payload}`) that belongs to a
  run and returns the universal events it makes (`run.status`, `run.delta {text, at}` / `{thinking, tat}`, `tool.start`,
  `tool.end`, `plan.update`, `usage.update`, `native {op:'title'}`, `run.end`); `request(rq)` does the same for Hermes'
  own requests to the client (approval, clarify, secret, sudo) and `feed` also turns their withdrawals
  (`approval.cancelled`, `request.cancel`) into `approval.resolved` / `question.resolved`. The adapter adds the envelope
  (connection, agent, session, run id) and the ChatHub its seq.
- `history_to_messages(rows, live_rows)`: a session's stored messages (REST `/api/sessions/{id}/messages`) with the turns
  Hermes keeps hidden and empty (stopped / redirected part-way) taken from its live transcript (`session.history`).
- `models_to_picker(result)`: `model.options` as the model picker (provider:model ids, effort levels per model).
- Small rules shared with the adapter: `tool_kind`, `tool_title`, `split_media`, `approval_of`, `questions_of`,
  `answer_for`, `session_of`, `commands_of`, `side_of`.
"""

from __future__ import annotations

import json
import math
import re
import time

OUT_MAX = 4000            # a step's output in the chat
TEXT_MAX = 100_000        # an answer's text
# Hermes' tools that are the chat's own cards (its questions, its task list): never also a step.
CARD_TOOLS = frozenset({"clarify", "todo_list", "todo"})
# Hermes' bridge to its deferred tools: live it reports the called tool itself; its stored history keeps the wrapper.
BRIDGE = frozenset({"tool_call"})
STATUS_KINDS = frozenset({"compacting", "compression", "retry", "fallback", "status", "lifecycle", "goal", "loop",
                          "process", "waiting"})
CHOICE_TO_DECISION = {"once": "allow-once", "session": "allow-session", "always": "allow-always", "deny": "deny"}
DECISION_TO_CHOICE = {v: k for k, v in CHOICE_TO_DECISION.items()}
REQUESTS = ("approval", "clarify", "secret", "sudo")
EFFORT_LEVELS = ("minimal", "low", "medium", "high", "xhigh")
EFFORT_LABEL = {"none": "Off", "minimal": "Minimal", "low": "Low", "medium": "Medium", "high": "High",
                "xhigh": "Extra high"}
SIDES = {"btw.complete": "btw", "background.complete": "bg", "review.summary": "review"}

_WAIT = re.compile(r"^(?:⏳|⚠|↻|⚙)️?\s*(?:(?:still\s+)?waiting on|loading|processing prompt|no (?:output|response)|"
                   r"model returned|rate limited|provider (?:overloaded|temporarily unavailable))", re.I)
_WAIT_MARK = re.compile(r"^(?:⏳|⚠|↻|⚙)️?\s*")
_MEDIA_LINE = re.compile(r"^\s*MEDIA:\s*(.+?)\s*$", re.I)
_IMAGE_LINE = re.compile(r"^\s*!\[([^\]\n]*)\]\((https?://[^\s)]+)(?:\s+\"[^\"]*\")?\)\s*$", re.I)
_FENCE = re.compile(r"^\s*(```+|~~~+)")
_KIND_BY_EXT = ((re.compile(r"\.(png|jpe?g|gif|webp|avif|bmp)$", re.I), "image"),
                (re.compile(r"\.(mp4|webm|mov|m4v|mkv|ogv)$", re.I), "video"),
                (re.compile(r"\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$", re.I), "audio"))


def _s(v) -> str:
    if isinstance(v, str):
        return v
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _round(x: float) -> int:
    return int(math.floor(x + 0.5))


def _json(v) -> str:
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def _clip(s: str, n: int) -> str:
    return s[:n] + "\n…" if len(s) > n else s


def _lstrip_marks(t: str) -> str:
    """The text without the glyphs it starts with (Hermes' emoji and arrows before its words)."""
    i = 0
    while i < len(t) and not (t[i].isalpha() or t[i].isnumeric()):
        i += 1
    return t[i:]


# ------------------------------------------------------------------ small rules
def unwrap(name: str, args) -> tuple[str, object]:
    """The tool a stored call really called: the wrapped one when tool_call carries exactly one."""
    if name not in BRIDGE or not isinstance(args, dict) or not isinstance(args.get("calls"), list) \
            or len(args["calls"]) != 1:
        return name, args
    c = args["calls"][0] if isinstance(args["calls"][0], dict) else {}
    called = c.get("name")
    if isinstance(called, str) and called:
        a = c.get("arguments")
        return called, {} if a is None else a
    return name, args


def _generic_kind(n: str) -> str:
    if re.match(r"(exec|process|bash|shell|run|terminal|command)", n):
        return "execute"
    if re.match(r"(read|ls|cat|view|open|list)", n):
        return "read"
    if re.match(r"(write|edit|apply_patch|patch|create)", n):
        return "edit"
    if re.match(r"(delete|rm|remove)", n):
        return "delete"
    if re.match(r"(move|mv|rename)", n):
        return "move"
    if re.search(r"(search|find|grep|glob|query)", n):
        return "search"
    if re.search(r"(fetch|http|web|browse|url)", n):
        return "fetch"
    if re.search(r"(think|plan|reason)", n):
        return "think"
    return "other"


def tool_kind(name) -> str:
    """A step's kind (the chat's icon) from Hermes' tool names (terminal, read_file, patch, web_search ...)."""
    n = _s(name).lower()
    if re.match(r"(terminal|process|shell|execute_code|code_execution)", n):
        return "execute"
    if re.match(r"(read_file|search_files|list|view|vision)", n):
        return "search" if "search" in n else "read"
    if re.match(r"(write_file|patch|edit)", n):
        return "edit"
    if re.match(r"(browser|web_extract|web_fetch|fetch)", n):
        return "fetch"
    if "search" in n:
        return "search"
    if re.match(r"(delegate|todo|memory|skill)", n):
        return "think"
    return _generic_kind(n)


def tool_title(name, labels=None) -> str:
    """A tool's name as a person reads it: Hermes' own label (labels[0].text), else the name tidied."""
    first = labels[0] if isinstance(labels, list) and labels else None
    if isinstance(first, dict) and isinstance(first.get("text"), str) and first["text"].strip():
        return first["text"].strip()[:120]
    t = re.sub(r"^mcp_", "", _s(name) or "tool").replace("_", " ")
    return re.sub(r"^\w", lambda m: m.group().upper(), t, flags=re.A)[:120]


def input_of(args) -> str:
    """A tool's input as one readable line: its command, its path, or its arguments."""
    if args is None:
        return ""
    if isinstance(args, str):
        return args
    if isinstance(args, dict):
        if isinstance(args.get("command"), str):
            return args["command"]
        if isinstance(args.get("path"), str) and len(args) <= 2:
            return args["path"]
    try:
        return _json(args)
    except (TypeError, ValueError):
        return ""


def step_input(p: dict) -> str:
    """What a step was given: Hermes' own short context (the command, the file), else its arguments."""
    c = _s(p.get("context")).strip()
    if c:
        return c
    return input_of(p.get("args") if isinstance(p.get("args"), dict) else p.get("args_text"))


def result_of(r, fallback="") -> dict:
    """A tool's result: {text, ok, exitCode?, blocked, error?, diff?} (a non-zero exit, an error or a blocked command
    is not ok)."""
    if r is None:
        return {"text": _s(fallback), "ok": True}
    if isinstance(r, str):
        try:
            j = json.loads(r)
        except ValueError:
            j = None
        if isinstance(j, (dict, list)):
            return result_of(j, fallback)
        return {"text": r, "ok": True}
    if not isinstance(r, dict):
        if isinstance(r, list):
            return {"text": _json(r), "ok": True, "blocked": False}
        return {"text": _s(r), "ok": True}
    err = _s(r.get("error")) if r.get("error") else ""
    exit_code = r.get("exit_code") if _finite(r.get("exit_code")) else None
    blocked = r.get("status") == "blocked"
    body = next((r[k] for k in ("output", "content", "result") if isinstance(r.get(k), str)), "")
    text = body or (_s(r.get("user_summary")) if blocked and r.get("user_summary") else "") or err or ""
    if not text:
        text = _json(r)
    if err and body:
        text = f"{body}\n{err}"
    out = {"text": text, "ok": not err and not blocked and exit_code in (None, 0)}
    if exit_code is not None:
        out["exitCode"] = exit_code
    out["blocked"] = blocked
    if err:
        out["error"] = err
    if isinstance(r.get("diff"), str) and r["diff"]:
        out["diff"] = r["diff"]
    return out


def steps_of(todos) -> list[dict]:
    """Hermes' todo list as the progress card's steps (a cancelled item stays, marked)."""
    out = []
    for t in todos if isinstance(todos, list) else []:
        if not isinstance(t, dict) or not (t.get("content") or t.get("text")):
            continue
        s = _s(t.get("status") or "pending").lower()
        text = _s(t.get("content") or t.get("text"))[:290]
        out.append({"step": f"{text} (cancelled)" if s == "cancelled" else text,
                    "status": "in_progress" if s == "in_progress" else
                    "completed" if s in ("completed", "cancelled") else "pending"})
        if len(out) >= 50:
            break
    return out


def wait_text(text) -> str:
    """A thinking.delta that explains a wait on the provider, in a few words; '' for its spinner's decoration."""
    v = _s(text).strip()
    return _WAIT_MARK.sub("", v, count=1)[:120] if _WAIT.match(v) else ""


def status_text(p) -> str:
    """A status.update line Hermes sends (compacting, retry, lifecycle ...), in a few words; '' for the others."""
    if not isinstance(p, dict) or _s(p.get("kind")) not in STATUS_KINDS:
        return ""
    if re.match(r"compact|compress", p["kind"]):
        return "Compacting the conversation"
    return _lstrip_marks(_s(p.get("text"))).strip()[:120]


# ------------------------------------------------------------------ media lines
def base_name(s) -> str:
    return re.split(r"[\\/]", re.sub(r"[?#].*$", "", _s(s), flags=re.S))[-1]


def kind_of_name(n) -> str:
    b = base_name(n)
    return next((k for rx, k in _KIND_BY_EXT if rx.search(b)), "file")


def split_media(text) -> tuple[str, list[dict]]:
    """A text without its media lines (`MEDIA:<path or URL>`, and a remote image `![alt](https://...)` on a line of its
    own), and those lines' references `{kind, name, ref:{source}}`. A line inside a code block is text."""
    t = text if isinstance(text, str) else ""
    if not re.search(r"MEDIA:|!\[", t, re.I):
        return t, []
    keep, media, fence = [], [], None
    for line in t.split("\n"):
        f = _FENCE.match(line)
        if f:
            if not fence:
                fence = f.group(1)[0]
            elif f.group(1)[0] == fence:
                fence = None
            keep.append(line)
            continue
        src = ""
        if not fence:
            m = _MEDIA_LINE.match(line)
            if m:
                src = re.sub(r"[`'\">]+$", "", re.sub(r"^[`'\"<]+", "", m.group(1))).strip()
            else:
                im = _IMAGE_LINE.match(line)
                if im:
                    src = im.group(2)
        if src and len(src) <= 2048:
            name = base_name(src)[:200] or "attachment"
            media.append({"kind": "image" if _IMAGE_LINE.match(line) else kind_of_name(name), "name": name,
                          "ref": {"source": src}})
        else:
            keep.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(keep)).strip(), media


def merge_media(*lists) -> list[dict]:
    """Media from several places as one list, the same file once."""
    out: list[dict] = []
    for lst in lists:
        for m in lst or []:
            if not isinstance(m, dict) or not isinstance(m.get("ref"), dict):
                continue
            src = m["ref"].get("source")
            if not any(src and x["ref"].get("source") == src for x in out):
                out.append(m)
    return out[:24]


# ------------------------------------------------------------------ one run
class Translator:
    """One run's translation. `feed(event)` -> the universal events it makes (a list, maybe empty). Once the run has
    ended (`ended`) it makes nothing more. The answer's text is every segment Hermes wrote (its commentary beside the
    tools, then its answer), joined as its history keeps them; `at` / `tat` are each piece's offset in what has streamed."""

    def __init__(self, run=None, *, clock=time.time):
        self.run = run
        self.clock = clock
        self.t0 = clock()
        self.segments: list[str] = []
        self.text = ""
        self.thinking = ""
        self.sent = 0            # characters of text streamed so far (the next piece's `at`)
        self.think_sent = 0      # characters of thinking streamed so far (`tat`)
        self.tools: dict[str, dict] = {}
        self.model = None
        self.effort = None
        self.title = None
        self.ended = False
        self.last_phase = None
        self.avail = ""          # reasoning.available, held
        self._out: list[dict] = []
        self._asks: dict[str, dict] = {}   # rpc id -> {method, approvalId?} of the requests shown in this run

    # (each public call returns what it emitted)
    def _take(self) -> list[dict]:
        out, self._out = self._out, []
        return out

    def _emit(self, e: dict) -> None:
        self._out.append(e)

    def status(self, phase: str) -> list[dict]:
        self._status(phase)
        return self._take()

    def _status(self, phase) -> None:
        if not phase or phase == self.last_phase or self.ended:
            return
        self.last_phase = phase
        self._emit({"type": "run.status", "phase": phase})

    def feed(self, evt) -> list[dict]:
        if self.ended or not isinstance(evt, dict) or not isinstance(evt.get("type"), str):
            return []
        p = evt.get("payload") if isinstance(evt.get("payload"), dict) else {}
        t = evt["type"]
        if t == "message.start":
            self._status("Thinking")
        elif t == "thinking.delta":
            # (Hermes' spinner words: never the answer, never its reasoning; said only when they explain a wait)
            w = wait_text(p.get("text"))
            if w:
                self._status(w)
        elif t == "status.update":
            self._status(status_text(p))
        elif t == "message.delta":
            self._delta(_s(p.get("text")))
        elif t == "message.interim":
            # (commentary beside its tools, sealed as its own segment; written now unless it already streamed)
            if not p.get("already_streamed") and _s(p.get("text")):
                self._delta(_s(p.get("text")))
            self.seal()
        elif t in ("reasoning.delta", "moa.reference"):
            self._think(_s(p.get("text")))
        elif t == "reasoning.available":
            # (a whole block; Hermes relays the model's own words here too: held, shown as reasoning only if the
            # answer turns out not to be it, never once the answer or reasoning has words)
            if not self.text and not self.thinking and not self.segments and _s(p.get("text")):
                self.avail = _s(p.get("text"))
        elif t == "tool.generating":
            self._flush_avail()
            name = _s(p.get("name"))
            if name not in CARD_TOOLS and name not in BRIDGE:
                self._status(f"Preparing {tool_title(name)}")
        elif t == "tool.start":
            self._flush_avail()
            self._tool_start(p)
        elif t == "tool.complete":
            self._tool_end(p)
        elif t == "todo.updated":
            e = {"type": "plan.update", "title": "Tasks", "steps": steps_of(p.get("todos"))}
            if isinstance(p.get("revision"), int) and not isinstance(p.get("revision"), bool):
                e["revision"] = p["revision"]
            e["updatedAt"] = _round(self.clock() * 1000)
            self._emit(e)
        elif t == "session.info":
            if p.get("model"):
                self.model = f"{p['provider']}:{p['model']}" if p.get("provider") else _s(p["model"])
            if isinstance(p.get("reasoning_effort"), str) and p["reasoning_effort"]:
                self.effort = p["reasoning_effort"]
        elif t == "session.usage":
            self._usage(p)
        elif t == "session.title":
            title = _s(p.get("title")).strip()
            if title:
                self.title = title[:200]
                self._emit({"type": "native", "ev": {"op": "title", "text": self.title}})
        elif t == "message.complete":
            self._complete(p)
        elif t == "error":
            self._end("error", error=_s(p.get("message")) or "Hermes could not answer")
        elif t == "approval.cancelled":
            for aid in p.get("request_ids") if isinstance(p.get("request_ids"), list) else []:
                self._withdraw(_s(aid), p.get("reason"), approval=True)
        elif t == "request.cancel":
            self._withdraw(_s(p.get("id")), p.get("reason"))
        return self._take()

    # ---------------------------------------------------------------- pieces
    def _delta(self, d: str) -> None:
        if not d:
            return
        self.last_phase = None
        lead = "\n\n" if not self.text and self.segments else ""   # a new segment after commentary: a paragraph apart
        self._emit({"type": "run.delta", "text": lead + d, "at": self.sent})
        self.text += d
        self.sent += len(lead) + len(d)

    def _think(self, d: str) -> None:
        if not d:
            return
        self._emit({"type": "run.delta", "thinking": d, "tat": self.think_sent})
        self.thinking += d
        self.think_sent += len(d)

    def _flush_avail(self) -> None:
        if self.avail:
            a, self.avail = self.avail, ""
            self._think(a)

    def seal(self) -> None:
        """Close the text segment written so far (commentary, or a turn a redirect lands in the middle of)."""
        if self.text:
            self.segments.append(self.text)
            self.text = ""

    def _tool_start(self, p: dict) -> None:
        tid = _s(p.get("tool_id")) or f"t{len(self.tools) + 1}"
        if tid in self.tools:
            return
        name = _s(p.get("name")) or "tool"
        t = {"id": tid, "name": name, "t0": self.clock()}
        self.tools[tid] = t
        if name in CARD_TOOLS:          # its card shows it (questions, task list)
            t["hidden"] = True
            return
        self.seal()
        self.last_phase = None
        e = {"type": "tool.start", "toolId": tid, "name": name, "title": tool_title(name, p.get("labels")),
             "toolKind": tool_kind(name)}
        inp = step_input(p)
        if inp:
            e["input"] = inp
        raw = ""
        try:
            raw = _json(p["args"]) if isinstance(p.get("args"), dict) else _s(p.get("args_text"))
        except (TypeError, ValueError):
            pass
        if raw:
            e["raw"] = raw
        self._emit(e)

    def _tool_end(self, p: dict) -> None:
        tid = _s(p.get("tool_id"))
        t = self.tools.get(tid) if tid else None
        if not t:
            self._tool_start(p)
            t = self.tools.get(tid or f"t{len(self.tools)}")
        if not t or t.get("done"):
            return
        t["done"] = True
        if t.get("hidden"):
            return
        r = result_of(p.get("result"), p.get("result_text") or p.get("summary"))
        ms = _round(p["duration_s"] * 1000) if _finite(p.get("duration_s")) else _round((self.clock() - t["t0"]) * 1000)
        diff = _s(p.get("inline_diff"))
        text = _clip(f"{r['text'] + chr(10) if r['text'] else ''}{diff}" if diff else r["text"], OUT_MAX)
        e = {"type": "tool.end", "toolId": t["id"], "name": t["name"], "title": tool_title(t["name"], p.get("labels")),
             "ok": r["ok"], "status": "blocked" if r.get("blocked") else "completed" if r["ok"] else "failed",
             "text": text}
        if "exitCode" in r:
            e["exitCode"] = r["exitCode"]
        e["ms"] = ms
        self._emit(e)

    def _usage(self, u) -> None:
        if not isinstance(u, dict):
            return
        used = u.get("context_used") if _finite(u.get("context_used")) else None
        size = u.get("context_max") if _finite(u.get("context_max")) else None
        if used is None and size is None:
            return
        e = {"type": "usage.update"}
        if used is not None:
            e["used"] = used
        if size is not None:
            e["size"] = size
        if _finite(u.get("cost_usd")):
            e["cost"] = _round(u["cost_usd"] * 1e6)
        self._emit(e)

    def _complete(self, p: dict) -> None:
        u = p.get("usage") if isinstance(p.get("usage"), dict) else None
        self._usage(u)
        final = _s(p.get("text"))
        # (Hermes' relayed words that were the answer: not reasoning)
        if self.avail and not final.strip().startswith(self.avail.strip()[:120]):
            self._flush_avail()
        self.avail = ""
        status = "stopped" if p.get("status") == "interrupted" else \
            "error" if p.get("status") == "error" or p.get("error") else "ok"
        # the answer: every segment written, the last one as Hermes finished it (its final text wins over the stream)
        last = final if final.strip() else self.text
        whole = "\n\n".join(s for s in (_s(x).strip() for x in [*self.segments, last]) if s)
        err = None
        if status == "error":
            err = _s(p.get("error")) or _s(p.get("failure_reason")) or "Hermes could not answer"
        self._end(status, text=whole, usage=u, error=err, thinking=_s(p.get("reasoning")) or None)

    def _end(self, status: str, *, text="", usage=None, error=None, thinking=None) -> None:
        if self.ended:
            return
        self.ended = True
        body, media = split_media(text or "\n\n".join(x for x in [*self.segments, self.text] if x))
        e = {"type": "run.end", "status": status, "text": body[:TEXT_MAX], "ms": _round((self.clock() - self.t0) * 1000)}
        if media:
            e["media"] = merge_media(media)
        um = _s(usage.get("model")) if usage and usage.get("model") else ""
        model = (self.model if um and self.model and self.model.endswith(f":{um}") else None) or self.model or um
        if model:
            e["model"] = model
        if self.effort:
            e["effort"] = self.effort
        th = self.thinking or thinking or ""
        if th:
            e["thinking"] = th[:TEXT_MAX]
        for key, field in (("input", "tokensIn"), ("output", "tokensOut")):
            if usage and _finite(usage.get(key)):
                e[field] = usage[key]
        if usage and _finite(usage.get("cost_usd")):
            e["cost"] = _round(usage["cost_usd"] * 1e6)
        if error:
            e["error"] = _s(error)[:400]
        if self.title:
            e["title"] = self.title[:60]
        self._emit(e)

    def interrupt(self, why: str) -> list[dict]:
        """The run cannot finish here (the link lost > 120 s, the connection edited, removed or switched off)."""
        self._end("interrupted", error=why)
        return self._take()

    # ---------------------------------------------------------------- Hermes' requests to the client
    def request(self, rq: dict) -> list[dict]:
        """One of Hermes' requests in this run's session as the chat's card (once per request id); [] for a method the
        chat does not answer (the adapter answers those at once with -32601)."""
        if self.ended or not isinstance(rq, dict) or rq.get("method") not in REQUESTS:
            return []
        rid = _s(rq.get("id"))
        if not rid or rid in self._asks:
            return []
        if rq["method"] == "approval":
            a = approval_of(rq)
            self._asks[rid] = {"method": "approval", "approvalId": a["approvalId"]}
            self._status("Waiting for your approval")
            self._emit(a)
        else:
            qs = questions_of(rq)
            if not qs:
                return []
            self._asks[rid] = {"method": rq["method"]}
            self._status("Waiting for your answer")
            self._emit({"type": "question.requested", "questionId": rid, "questions": qs})
        return self._take()

    def answered(self, rpc_id) -> None:
        """A request this run showed was answered: a later withdrawal of it says nothing."""
        self._asks.pop(_s(rpc_id), None)

    def _withdraw(self, ident: str, reason, approval: bool = False) -> None:
        rid = ident if ident in self._asks else None
        if rid is None and approval:
            # (approval.cancelled names Hermes' approval ids, not its request ids)
            rid = next((k for k, a in self._asks.items() if a.get("approvalId") == ident), None)
        if rid is None:
            return
        ask = self._asks.pop(rid)
        self.last_phase = None
        if ask["method"] == "approval":
            self._emit({"type": "approval.resolved", "approvalId": ask["approvalId"], "approved": False,
                        "decision": "cancelled"})
        else:
            self._emit({"type": "question.resolved", "questionId": rid,
                        "status": "expired" if re.search(r"time", _s(reason), re.I) else "cancelled"})


def steered_events() -> list[dict]:
    """A message Hermes folded into the running turn (steered / redirected / merged queue): a run that starts and ends at
    once, with no bubble of its own."""
    return [{"type": "run.start"}, {"type": "run.end", "status": "ok", "text": "", "steered": True}]


# ------------------------------------------------------------------ approvals, questions
def approval_of(rq: dict) -> dict:
    """Hermes' approval request (a dangerous command) as the chat's approval."""
    p = rq.get("params") if isinstance(rq.get("params"), dict) else {}
    choices = p.get("choices") if isinstance(p.get("choices"), list) and p.get("choices") else ["once", "deny"]
    options = [CHOICE_TO_DECISION[c] for c in choices if isinstance(c, str) and c in CHOICE_TO_DECISION]
    tool = _s(p.get("tool_name"))
    e = {"type": "approval.requested", "approvalId": _s(p.get("request_id") or rq.get("id"))[:190],
         "rpcId": _s(rq.get("id"))[:190], "approvalKind": "exec", "tool": tool or "terminal",
         "title": f"Allow {tool_title(tool)}" if tool and tool != "terminal" else "Run a command",
         "summary": _s(p.get("description"))[:1000]}
    if p.get("command"):
        e["command"] = _s(p["command"])
    e["options"] = options or ["allow-once", "deny"]
    return e


def questions_of(rq: dict) -> list[dict]:
    """Hermes' clarify request (1-5 questions, 8 choices each), or a masked prompt (secret, sudo), as the chat's."""
    p = rq.get("params") if isinstance(rq.get("params"), dict) else {}
    method = rq.get("method")
    if method == "clarify":
        out = []
        for q in (p.get("questions") if isinstance(p.get("questions"), list) else [])[:5]:
            if not isinstance(q, dict) or not q.get("qid") or not q.get("question"):
                continue
            choices = [c for c in (q.get("choices") if isinstance(q.get("choices"), list) else [])
                       if isinstance(c, str) and c][:8]
            out.append({"questionId": _s(q["qid"])[:80], "header": f"Question {len(out) + 1}",
                        "question": _s(q["question"]), "options": [{"label": c[:200]} for c in choices],
                        "multiSelect": q.get("multi_select") is True, "other": True})
        return out
    if method == "secret":
        env = _s(p.get("env_var"))
        return [{"questionId": "value", "header": env[:40] or "Secret",
                 "question": _s(p.get("prompt")) or f"Hermes asks for {env or 'a secret value'}", "options": [],
                 "secret": True, "other": True}]
    if method == "sudo":
        cmd = _s(p.get("command"))
        return [{"questionId": "value", "header": "Password",
                 "question": f"Hermes needs your sudo password to run: {cmd[:300]}" if cmd else
                 "Hermes needs your sudo password", "options": [], "secret": True, "other": True}]
    return []


def answer_for(rq: dict, answers, cancel: bool = False) -> dict:
    """The chat's answers as the result Hermes' request takes: clarify {answers: {qid: 'a, b'}} ({} = cancelled),
    secret/sudo {value} ('' = cancelled)."""
    method = rq.get("method") if isinstance(rq, dict) else None
    if method == "clarify":
        if cancel:
            return {}
        out = {}
        for qid, v in (answers or {}).items():
            vals = [_s(x) for x in (v if isinstance(v, list) else [v])]
            vals = [x for x in vals if x]
            if vals:
                out[qid] = ", ".join(vals)
        return {"answers": out}
    if method in ("secret", "sudo"):
        v = (answers or {}).get("value") if isinstance(answers, dict) else None
        if isinstance(v, list):
            v = v[0] if v else None
        return {"value": "" if cancel else _s(v or "")}
    return {}


def choice_for(decision: str) -> str | None:
    """A universal approval decision as Hermes' choice (once, session, always, deny)."""
    return DECISION_TO_CHOICE.get(decision)


# ------------------------------------------------------------------ the session's stored messages
SK_PREFIX = "[IMPORTANT: The user has invoked the "
SK_SINGLE = "The full skill content is loaded below.]"
SK_INSTR = "The user has provided the following instruction alongside the skill invocation: "
SK_RUNTIME = "\n\n[Runtime note:"
SK_BUNDLE = " skill bundle,"
SK_BUNDLE_INSTR = "\nUser instruction: "
SK_BUNDLE_BLOCK = "\n\n[Loaded as part of the "


def _between(t: str, marker: str, end: str, from_end: bool = False) -> str:
    i = t.rfind(marker) if from_end else t.find(marker)
    if i < 0:
        return ""
    tail = t[i + len(marker):]
    k = tail.find(end)
    return (tail[:k] if k >= 0 else tail).strip()


def skill_invocation_text(t) -> str | None:
    """The command a skill's expanded text came from (`/work fix the leak`), or None for ordinary words."""
    if not isinstance(t, str) or not t.startswith(SK_PREFIX):
        return None
    m = re.match(r'^\[IMPORTANT: The user has invoked the "([^"]*)"', t)
    name = (m.group(1) if m else "").strip()
    if not name:
        return None
    label = name if name.startswith("/") else f"/{name}"
    instr = _between(t, SK_BUNDLE_INSTR, SK_BUNDLE_BLOCK) if SK_BUNDLE in t else \
        _between(t, SK_INSTR, SK_RUNTIME, True) if SK_SINGLE in t else ""
    return (label + " " + re.sub(r"\s+", " ", instr) if instr else label)[:2000]


def _user_text(c) -> str:
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(_s(x.get("text")) for x in c if isinstance(x, dict) and x.get("type") in ("text", "input_text"))
    return _s(c)


def _parse_args(a):
    if isinstance(a, (dict, list)):
        return a
    try:
        return json.loads(a or "{}")
    except (TypeError, ValueError):
        return a or ""


def _ts(m: dict):
    return _round(m["timestamp"] * 1000) if _finite(m.get("timestamp")) else None


def needs_live_rows(rows, running: bool) -> bool:
    """Whether the stored messages need Hermes' live transcript (session.history): a turn stopped or redirected part-way
    is stored hidden and empty, and a store that ends on the person's message while nothing runs may lack the answer."""
    rows = rows if isinstance(rows, list) else []
    if any(isinstance(m, dict) and m.get("role") == "assistant" and m.get("display_kind") == "hidden"
           and not _s(m.get("content")).strip() for m in rows):
        return True
    shown = [m for m in rows if isinstance(m, dict) and m.get("active") != 0 and m.get("display_kind") != "hidden"
             and m.get("role") in ("user", "assistant")]
    return bool(shown) and shown[-1].get("role") == "user" and not running


def _row_id(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if math.isfinite(f) and f == int(f) else None


def history_to_messages(rows, live_rows=None) -> list[dict]:
    """A session's stored messages as the chat's: `{role, text, ts, meta}`; an answer (the assistant's rows between two of
    the person's) carries meta {thinking, steps [{id, name, title, kind, input, output, ok, exitCode}], media, upto}.
    `live_rows` (session.history messages) fill the hidden empty rows by row id and add the answers not stored yet."""
    rows = [m for m in rows if isinstance(m, dict)] if isinstance(rows, list) else []
    visible = None
    if live_rows is not None:
        live = [x for x in live_rows if isinstance(x, dict) and x.get("role") == "assistant"
                and _row_id(x.get("row_id")) is not None and x.get("text")] if isinstance(live_rows, list) else []
        visible = {_row_id(x["row_id"]): x for x in live}
        ids = {_row_id(m.get("id")) for m in rows}
        extra = [{"id": _row_id(x["row_id"]), "role": "assistant", "content": x["text"], "reasoning": x.get("reasoning"),
                  "timestamp": x.get("timestamp"), "active": 1} for x in live if _row_id(x["row_id"]) not in ids]
        if extra:
            rows = sorted([*rows, *extra], key=lambda m: _row_id(m.get("id")) if _row_id(m.get("id")) is not None
                          else math.inf)
    out: list[dict] = []
    turn = None
    n = 0   # the record's entries so far (Hermes counts them for a branch)

    def close():
        nonlocal turn
        if turn and (turn["text"] or turn["meta"]["steps"] or turn["meta"]["thinking"] or turn["meta"]["media"]):
            meta = dict(turn["meta"])
            for k in ("steps", "thinking", "media"):
                if not meta[k]:
                    del meta[k]
            out.append({"role": "assistant", "text": turn["text"], "ts": turn["ts"], "meta": meta})
        turn = None

    for m in rows:
        if m.get("active") == 0:
            continue
        n += 1
        ts = _ts(m)
        dk = _s(m.get("display_kind"))
        rid = _row_id(m.get("id"))
        if dk == "hidden" and m.get("role") == "assistant" and not _s(m.get("content")).strip() and visible \
                and rid in visible:
            v = visible[rid]
            m = {**m, "content": _s(v.get("text")), "reasoning": v.get("reasoning") or m.get("reasoning"),
                 "display_kind": None}
            dk = ""
        if dk == "hidden":
            continue
        role = m.get("role")
        if role == "user":
            close()
            if dk and dk != "user":
                dm = m.get("display_metadata") if isinstance(m.get("display_metadata"), dict) else {}
                said = _s(dm.get("display_text")) or _user_text(m.get("content"))
                out.append({"role": "system", "text": said[:2000] or "Hermes continued by itself.", "ts": ts,
                            "status": dk})
                continue
            said = _user_text(m.get("content"))
            skill = skill_invocation_text(said)
            msg = {"role": "user", "text": skill or said, "ts": ts}
            meta = {}
            if isinstance(m.get("id"), int) and not isinstance(m.get("id"), bool):
                meta["row"] = m["id"]
            if skill:
                meta["skill"] = True
            if meta:
                msg["meta"] = meta
            out.append(msg)
            continue
        if role == "system" and re.search(r"compact|compress", dk, re.I):
            close()
            out.append({"role": "system", "text": "The conversation was compacted here.", "ts": ts,
                        "status": "compaction"})
            continue
        if role == "assistant":
            if not turn:
                turn = {"text": "", "ts": ts, "meta": {"steps": [], "thinking": "", "media": [], "upto": n}}
            turn["meta"]["upto"] = n
            th = _s(m.get("reasoning_content") or m.get("reasoning"))
            if th:
                turn["meta"]["thinking"] += ("\n\n" if turn["meta"]["thinking"] else "") + th
            body, media = split_media(_s(m.get("content")) if not isinstance(m.get("content"), list)
                                      else _user_text(m.get("content")))
            turn["meta"]["media"] = merge_media(turn["meta"]["media"], media)
            if body.strip():
                turn["text"] += ("\n\n" if turn["text"] else "") + body.strip()
            for c in m.get("tool_calls") if isinstance(m.get("tool_calls"), list) else []:
                if not isinstance(c, dict):
                    continue
                fn = c.get("function") if isinstance(c.get("function"), dict) else {}
                cid = _s(c.get("id") or c.get("call_id"))
                if not cid:
                    continue
                name, args = unwrap(_s(fn.get("name")) or "tool", _parse_args(fn.get("arguments")))
                if name in CARD_TOOLS:
                    continue
                turn["meta"]["steps"].append({"id": cid, "name": name, "title": tool_title(name),
                                              "kind": tool_kind(name), "input": input_of(args)})
            continue
        if role == "tool" and turn:
            turn["meta"]["upto"] = n
            r = result_of(m.get("content"))
            s = next((x for x in turn["meta"]["steps"] if x["id"] == _s(m.get("tool_call_id"))), None)
            if s:
                s["output"] = _clip(r["text"], OUT_MAX)
                s["ok"] = r["ok"]
                if "exitCode" in r:
                    s["exitCode"] = r["exitCode"]
    close()
    return out


# ------------------------------------------------------------------ pickers and lists
def model_ref(provider: str, model: str) -> str:
    """A model's id here: Hermes' own provider:model (what its /model command takes)."""
    return f"{provider}:{model}"


def parse_model_ref(ref) -> dict:
    s = _s(ref)
    i = s.find(":")
    return {"provider": s[:i], "model": s[i + 1:]} if i > 0 else {"provider": "", "model": s}


def effort_choices(can_disable: bool = False) -> list[dict]:
    """The reasoning levels Hermes takes for a model that reasons, 'none' (Off) where it may be switched off."""
    return [{"id": i, "label": EFFORT_LABEL[i]} for i in ((("none",) if can_disable else ()) + EFFORT_LEVELS)]


def models_to_picker(r) -> dict:
    """Hermes' model inventory (model.options) as the model picker: {default, models [{id, label, reasoning, effort?}]}
    from the providers signed in (and the one in use)."""
    r = r if isinstance(r, dict) else {}
    models = []
    for p in r.get("providers") if isinstance(r.get("providers"), list) else []:
        if not isinstance(p, dict) or not p.get("slug") or (p.get("authenticated") is False and not p.get("is_current")):
            continue
        unavailable = p.get("unavailable_models") if isinstance(p.get("unavailable_models"), list) else []
        caps = p.get("capabilities") if isinstance(p.get("capabilities"), dict) else {}
        for m in (p.get("models") if isinstance(p.get("models"), list) else [])[:200]:
            if not isinstance(m, str) or not m or m in unavailable:
                continue
            cap = caps.get(m) if isinstance(caps.get(m), dict) else {}
            item = {"id": model_ref(p["slug"], m), "label": f"{m} · {p.get('name') or p['slug']}",
                    "reasoning": bool(cap.get("reasoning"))}
            if cap.get("reasoning"):
                item["effort"] = effort_choices(bool(cap.get("can_disable_reasoning")))
            models.append(item)
            if len(models) >= 400:
                break
        if len(models) >= 400:
            break
    return {"default": model_ref(r["provider"], r["model"]) if r.get("provider") and r.get("model") else None,
            "models": models}


def session_of(row: dict) -> dict:
    """A stored session row (REST /api/sessions, or session.list) as the chat's drawer row."""
    title = _s(row.get("title")) or _s(row.get("preview"))[:60] or "Chat"
    at = next((row[k] for k in ("last_activity_at", "ended_at", "started_at") if _finite(row.get(k))), None)
    out = {"key": _s(row.get("id")), "title": title[:120], "updatedAt": _round(at * 1000) if at is not None else None,
           "model": _s(row["model"]) if row.get("model") else None,
           "source": _s(row["source"])[:40] if row.get("source") else None}
    if _finite(row.get("message_count")):
        out["messages"] = row["message_count"]
    return out


def commands_of(r) -> list[dict]:
    """Hermes' slash-command catalogue (commands.catalog: [name, description] pairs by category) for the / menu."""
    r = r if isinstance(r, dict) else {}
    seen, out = set(), []

    def add(pair, category):
        if not isinstance(pair, list) or not pair or not isinstance(pair[0], str) or not pair[0].startswith("/"):
            return
        name = re.split(r"\s", pair[0][1:])[0]
        if not name or name in seen:
            return
        seen.add(name)
        desc = _s(pair[1]) if len(pair) > 1 else ""
        usage = re.search(r"\(usage: ([^)]*)\)", desc)
        args = []
        if usage and "<" in usage.group(1):
            arg = re.search(r"<([^>]+)>", usage.group(1))
            args = [{"name": arg.group(1) if arg else "value", "description": usage.group(1)[:120],
                     "required": "[" not in usage.group(1).split("<")[0]}]
        out.append({"name": name, "alias": f"/{name}", "description": re.sub(r"\s*\(usage: [^)]*\)", "", desc, count=1)[:200],
                    "category": category or None, "args": args})

    for c in r.get("categories") if isinstance(r.get("categories"), list) else []:
        for p in (c.get("pairs") or []) if isinstance(c, dict) else []:
            add(p, c.get("name"))
    for p in r.get("pairs") if isinstance(r.get("pairs"), list) else []:
        add(p, None)
    return out[:300]


def side_of(evt) -> dict | None:
    """A side question (/btw), background task or self-review answered outside any turn, as `native {op:'side'}`."""
    kind = SIDES.get(evt.get("type")) if isinstance(evt, dict) else None
    if not kind:
        return None
    p = evt.get("payload") if isinstance(evt.get("payload"), dict) else {}
    text = p.get("text") if isinstance(p.get("text"), str) else ""
    if kind == "review":
        text = _lstrip_marks(text.strip())
    op = {"op": "side", "kind": kind}
    if isinstance(p.get("task_id"), str):
        op["id"] = p["task_id"]
    if isinstance(p.get("question"), str):
        op["question"] = p["question"]
    op["text"] = text
    return op
