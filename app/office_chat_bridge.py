"""The office's own providers for the copied chat window (unify WP-A, .work/unify/DESIGN.md 3.1).

Codex (app-server and exec), Claude Code, OpenCode, Antigravity, Hermes API-server agents and extension providers keep
running through their existing office code paths in app/server.py. This module is the one place that runs them for the
copied window and speaks the provider layer's event vocabulary (provider-layer/server/providers/bus.js EVENT_SPEC):
run.start, run.delta {text | thinking, replace}, tool.start/update/end, approval.requested/resolved, usage.update and
run.end. vo-host (app/provider-layer/server/office-bridge.mjs, kind ``office``) calls these routes over loopback:

    GET  /api/office-bridge/agents                       the chattable office agents, their provider, transport, caps
    GET  /api/office-bridge/models?agent=                the model it uses (read-only this round)
    GET  /api/office-bridge/sessions?agent=              its chats (native keys)
    POST /api/office-bridge/sessions/create {agent}      the next run starts a new chat
    POST /api/office-bridge/sessions/rename              501: no office provider renames chats
    POST /api/office-bridge/sessions/delete {agent, session}
    GET  /api/office-bridge/history?agent=&session=      messages in the layer's shape (+ the run still going)
    POST /api/office-bridge/runs {agent, session, input, attachments}   -> {runId, sessionKey} | 409 busy
    GET  /api/office-bridge/runs/events?run=&since=      SSE (id/event/data), replayed from `since`; &json=1: one page
    POST /api/office-bridge/stop {run}
    POST /api/office-bridge/approve {run, approvalId, approved, decision}

Every call must come from this machine (loopback, not forwarded) with an ``X-VO-Principal`` signed with the layer's boot
secret (provider_layer_proxy.ProviderLayer.secret, the same vo-router.mjs signPrincipal format); its role (owner or
member) is the office's access level for the person behind it: ``manage`` only for an owner, as the office's own chat
routes do (agent_providers._can_manage). The bridge reads each run's native stream itself (Claude Code's is a
single-consumer queue): runs it starts are never streamed by a browser. Run records stay ``RUN_KEEP_S`` after the end
so a reader that reconnects replays them from ``since``.
"""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import re
import shutil
import threading
import time
import urllib.parse
import uuid

PREFIX = "/api/office-bridge/"
PRINCIPAL_HEADER = "X-VO-Principal"
ROLES = ("owner", "member")
RUN_KEEP_S = 600.0
MAX_RUNS = 200
MAX_EVENTS = 5000
TEXT_MAX = 200_000
TOOL_TEXT_MAX = 16_000
INPUT_MAX = 2_000
MAX_ATTACHMENTS = 10
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
STOP_GRACE_S = 30.0
SETTLE_S = 5.0
WATCH_S = 10.0
IDLE_LIMIT_S = 3600.0
KEEPALIVE_S = 10.0
APPROVAL_OPTIONS = ["allow-once", "deny"]
_TERMINAL = {"run.completed": "ok", "run.failed": "error", "run.cancelled": "stopped", "run.canceled": "stopped",
             "run.interrupted": "stopped", "run.stopped": "stopped"}
_OPEN = {"", "running", "pending", "in_progress", "inprogress", "started", "queued", "active"}
_OK = {"done", "completed", "complete", "success", "succeeded", "ok", "finished"}
_TOOL_KINDS = (
    ("execute", ("shell", "bash", "command", "exec", "terminal", "run", "powershell", "cmd")),
    ("edit", ("edit", "write", "patch", "file_change", "filechange", "apply", "create", "multiedit", "notebook")),
    ("delete", ("delete", "remove", "rm")),
    ("move", ("move", "rename", "mv")),
    ("search", ("search", "grep", "glob", "find", "ls", "list")),
    ("fetch", ("fetch", "http", "browse", "web", "url", "download")),
    ("read", ("read", "view", "cat", "open", "file")),
    ("think", ("think", "plan", "todo", "reason")),
)


# ── who is calling ───────────────────────────────────────────────────────────
def read_principal(value, secret):
    """The caller a valid X-VO-Principal names ({role, via, ...}), or None (missing, forged, malformed, unknown role)."""
    text = str(value or "")
    dot = text.rfind(".")
    if not secret or dot < 1 or len(text) > 4096:
        return None
    data, mac = text[:dot], text[dot + 1:]
    want = hmac.new(str(secret).encode(), data.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want.encode(), mac.encode()):
        return None
    try:
        obj = json.loads(base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(obj, dict) or obj.get("role") not in ROLES:
        return None
    return obj


def sign_principal(secret, obj):
    """vo-router.mjs signPrincipal (tests and tools: what vo-host sends)."""
    data = base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode().rstrip("=")
    return data + "." + hmac.new(str(secret).encode(), data.encode(), hashlib.sha256).hexdigest()


def _is_loopback(address):
    text = str(address or "").strip().lower()
    if text.startswith("::ffff:"):
        text = text[7:]
    return text == "::1" or text == "localhost" or text.startswith("127.")


def is_bridge_path(path):
    return urllib.parse.urlsplit(str(path or "")).path.startswith(PREFIX)


# ── helpers ──────────────────────────────────────────────────────────────────
def _clip(value, limit):
    text = value if isinstance(value, str) else ("" if value is None else str(value))
    return text if len(text) <= limit else text[:limit]


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _now_ms():
    return int(time.time() * 1000)


def tool_kind(name):
    low = str(name or "").lower()
    for kind, words in _TOOL_KINDS:
        if any(w in low for w in words):
            return kind
    return "other"


def _tool_input(args):
    """A tool call's input as one line a person reads: its command or path when it has one, else its arguments."""
    if isinstance(args, str):
        return _clip(args, INPUT_MAX)
    if isinstance(args, dict):
        for key in ("command", "cmd", "path", "file_path", "filePath", "file", "url", "query", "pattern", "description"):
            value = args.get(key)
            if isinstance(value, list):
                value = " ".join(str(v) for v in value)
            if value:
                return _clip(str(value), INPUT_MAX)
    if not args:
        return ""
    try:
        return _clip(json.dumps(args, ensure_ascii=False, default=str), INPUT_MAX)
    except (TypeError, ValueError):
        return ""


def _tool_args(card):
    """(input line, raw JSON text) of a tool card. Arguments still streaming (Claude Code's {"partial": "<json so far>"})
    are not known yet: both empty until a later snapshot carries them whole."""
    args = card.get("arguments") if "arguments" in card else card.get("input", card.get("preview", card.get("args")))
    if isinstance(args, dict) and set(args) == {"partial"}:
        return "", ""
    line = _tool_input(args)
    raw = ""
    if isinstance(args, (dict, list)) and args:
        raw = _clip(json.dumps(args, ensure_ascii=False, default=str), 4000)
    return line, raw


def _tool_state(card):
    status = str(card.get("status") or card.get("state") or "").strip().lower()
    if card.get("error") and status not in _OK:
        return "failed"
    if status in _OK:
        return "ok"
    if status in _OPEN:
        return "open"
    return "failed"


def _tool_output(card):
    for key in ("result", "output", "text"):
        value = card.get(key)
        if value:
            return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    if card.get("error"):
        return str(card.get("error"))
    return ""


def _tool_key(card, index):
    key = card.get("id") or card.get("toolCallId") or card.get("callId") or card.get("tool_call_id")
    if key:
        return str(key)
    return f"{index}:{card.get('name') or card.get('tool') or 'tool'}"


def _usage_numbers(payload):
    """(used, size, tokensIn, tokensOut) from an office payload's tokenUsage / contextUsed / contextWindow."""
    usage = payload.get("tokenUsage") if isinstance(payload.get("tokenUsage"), dict) else {}
    last = usage.get("last") if isinstance(usage.get("last"), dict) else {}
    total = usage.get("total") if isinstance(usage.get("total"), dict) else {}
    tokens_in = _int(last.get("inputTokens") or usage.get("inputTokens") or usage.get("input_tokens"))
    tokens_out = _int(last.get("outputTokens") or usage.get("outputTokens") or usage.get("output_tokens"))
    used = _int(payload.get("contextUsed")) or _int(last.get("totalTokens")) or tokens_in or _int(total.get("totalTokens"))
    size = _int(payload.get("contextWindow")) or _int(usage.get("modelContextWindow")) or _int(usage.get("contextWindow"))
    return used, size, tokens_in, tokens_out


# ── translating the office's run snapshots into the layer's events ─────────
class Translator:
    """Office run events (whole-state snapshots or Hermes' partial payloads) -> layer events, in order.

    feed(name, payload) returns the new events; after a terminal event (run.completed / failed / cancelled) `ended` is
    set and nothing more is produced. end(status, error) closes a run whose stream stopped without one."""

    def __init__(self, run_id, agent_key, session_key="", model="", started_ms=None):
        self.run_id = run_id
        self.agent_key = agent_key
        self.session_key = session_key or ""
        self.model = model or ""
        self.started_ms = started_ms or _now_ms()
        self.text = ""
        self.thinking = ""
        self.tools = {}           # key -> {"state": open|ok|failed, "out": str, "name": str}
        self.approval = None      # the pending approval dict as the provider gave it
        self.decided = {}         # approvalId -> (approved, decision) answered through the bridge
        self.usage_seen = (0, 0)
        self.tokens = (0, 0)
        self.error = ""
        self.ended = False
        self.end_status = ""

    def _ev(self, kind, **fields):
        event = {"type": kind, "runId": self.run_id, "agentKey": self.agent_key}
        if self.session_key:
            event["sessionKey"] = self.session_key
        event.update({k: v for k, v in fields.items() if v is not None})
        return event

    def start(self):
        return [self._ev("run.start")]

    # text and thinking: plain deltas while they only grow, else the whole with replace
    def _grow(self, field, new):
        old = self.text if field == "text" else self.thinking
        new = _clip(new, TEXT_MAX)
        if not new or new == old:
            return []
        if field == "text":
            self.text = new
        else:
            self.thinking = new
        if new.startswith(old):
            return [self._ev("run.delta", **{field: new[len(old):]})]
        return [self._ev("run.delta", **{field: new, "replace": True})]

    def _tool(self, card, index, phase="any"):
        """One tool card: phase 'known' handles only steps already started, 'new' only new ones (one snapshot: steps
        that ended close before the text that grew, steps that began come after it)."""
        if not isinstance(card, dict):
            return []
        key = _tool_key(card, index)
        if (phase == "known" and key not in self.tools) or (phase == "new" and key in self.tools):
            return []
        name = str(card.get("name") or card.get("tool") or "tool")[:120]
        state = _tool_state(card)
        out = _clip(_tool_output(card), TOOL_TEXT_MAX)
        events = []
        seen = self.tools.get(key)
        line, raw = _tool_args(card)
        if seen is None:
            title = str(card.get("title") or card.get("label") or (f"{name}: {line}" if line else name))[:200]
            events.append(self._ev("tool.start", toolId=key, name=name, input=line or None, title=title,
                                   toolKind=str(card.get("toolKind") or tool_kind(name)), raw=raw or None))
            seen = {"state": "open", "out": "", "name": name, "line": line, "raw": raw}
            self.tools[key] = seen
        if seen["state"] != "open":
            return events
        if (line or raw) and (line, raw) != (seen.get("line"), seen.get("raw")):
            # (a step whose input was still streaming when it started, e.g. Claude Code's tool JSON: the later
            # snapshot's whole input replaces the first fragment)
            events.append(self._ev("tool.update", toolId=key, input=line or None, raw=raw or None))
            seen["line"], seen["raw"] = line, raw
        if out and out != seen["out"] and state == "open":
            if out.startswith(seen["out"]):
                events.append(self._ev("tool.update", toolId=key, text=out[len(seen["out"]):]))
            else:
                events.append(self._ev("tool.update", toolId=key, text=out, replace=True))
            seen["out"] = out
        if state != "open":
            exit_code = card.get("exitCode", card.get("exit_code"))
            seen["state"], seen["out"] = state, out
            events.append(self._ev("tool.end", toolId=key, ok=state == "ok", text=out or None, name=name,
                                   status="done" if state == "ok" else "error",
                                   exitCode=exit_code if isinstance(exit_code, int) else None,
                                   ms=_int(card.get("durationMs") or card.get("ms")) or None))
        return events

    def _approval(self, approval):
        events = []
        pending = isinstance(approval, dict) and str(approval.get("status") or "pending").lower() == "pending" and (
            approval.get("id") or approval.get("approval_id") or approval.get("approvalId"))
        current_id = self._approval_id(self.approval) if self.approval else ""
        new_id = self._approval_id(approval) if pending else ""
        if current_id and current_id != new_id:
            events += self._resolve(current_id)
        if new_id and new_id != current_id and new_id not in self.decided:
            self.approval = dict(approval)
            command = approval.get("command")
            if isinstance(command, list):
                command = " ".join(str(c) for c in command)
            events.append(self._ev(
                "approval.requested", approvalId=new_id, tool=str(approval.get("tool") or approval.get("kind") or "")[:80] or None,
                summary=_clip(str(approval.get("description") or approval.get("summary") or approval.get("reason") or
                                  approval.get("title") or "The agent asks before it continues."), 2000),
                approvalKind=str(approval.get("kind") or "")[:40] or None,
                title=_clip(str(approval.get("title") or ""), 200) or None,
                command=_clip(str(command or ""), 4000) or None,
                cwd=_clip(str(approval.get("cwd") or ""), 1000) or None,
                options=list(APPROVAL_OPTIONS),
                expiresAt=_int(approval.get("expiresAt")) or None))
        return events

    @staticmethod
    def _approval_id(approval):
        if not isinstance(approval, dict):
            return ""
        return str(approval.get("id") or approval.get("approval_id") or approval.get("approvalId") or "")

    def _resolve(self, approval_id, approved=None, decision=None):
        """approval.resolved once per approval: with the answer given through the bridge, else closed elsewhere."""
        if self.approval and self._approval_id(self.approval) == approval_id:
            self.approval = None
        if approval_id in self.decided and approved is None:
            return []
        if approved is None:
            approved, decision = False, "closed"
        if approval_id in self.decided:
            return []
        self.decided[approval_id] = (approved, decision)
        return [self._ev("approval.resolved", approvalId=approval_id, approved=bool(approved), decision=decision)]

    def answered(self, approval_id, approved, decision):
        """The person answered through the bridge (approve route): resolved now, whatever the next snapshot says."""
        return self._resolve(approval_id, bool(approved), decision or ("allow-once" if approved else "deny"))

    def feed(self, name, payload):
        if self.ended:
            return []
        name = str(name or "").strip().lower()
        payload = payload if isinstance(payload, dict) else {}
        events = []
        session = str(payload.get("sessionId") or payload.get("threadId") or "")
        if session and not session.startswith("@new") and session != self.session_key:
            self.session_key = session
        if "approval" in payload:   # (an answered approval closes before what the agent did next)
            events += self._approval(payload.get("approval"))
        tools = payload.get("tools") if isinstance(payload.get("tools"), list) else []
        card = payload.get("toolCard") if isinstance(payload.get("toolCard"), dict) else None
        cards = list(enumerate(tools)) + ([(len(tools), card)] if card else [])
        for index, item in cards:
            events += self._tool(item, index, "known")
        thinking = payload.get("thinking")
        if isinstance(thinking, str) and thinking and name in {"run.started", "run.start"}:
            events.append(self._ev("run.progress", text=_clip(thinking, 300)))   # (a start-up line, not reasoning)
        elif isinstance(thinking, str) and thinking and thinking != str(payload.get("status") or ""):
            events += self._grow("thinking", thinking)   # (Claude Code's stream puts its status word there: skipped)
        reply = payload.get("reply")
        if isinstance(reply, str) and reply:
            events += self._grow("text", reply)
        elif name == "message.delta" and isinstance(payload.get("delta"), str):
            events += self._grow("text", self.text + payload["delta"])
        for index, item in cards:
            events += self._tool(item, index, "new")
        used, size, tokens_in, tokens_out = _usage_numbers(payload)
        if tokens_in or tokens_out:
            self.tokens = (tokens_in, tokens_out)
        if (used or size) and (used, size) != self.usage_seen:
            self.usage_seen = (used, size)
            events.append(self._ev("usage.update", used=used or None, size=size or None))
        if payload.get("error"):
            self.error = str(payload.get("error"))
        if name in _TERMINAL:
            status = _TERMINAL[name]
            if status == "ok" and payload.get("ok") is False:
                status = "error"
            events += self.end(status, self.error if status == "error" else "")
        return events

    def end(self, status, error=""):
        if self.ended:
            return []
        events = []
        if self.approval:
            events += self._resolve(self._approval_id(self.approval))
        for key, seen in self.tools.items():
            if seen["state"] == "open":
                seen["state"] = "ok" if status == "ok" else "failed"
                events.append(self._ev("tool.end", toolId=key, ok=status == "ok", name=seen["name"],
                                       status="done" if status == "ok" else ("stopped" if status == "stopped" else "error")))
        if status == "error" and not error:
            error = self.error or "The run failed"
        self.ended, self.end_status = True, status
        events.append(self._ev("run.end", status=status, error=_clip(error, 2000) or None,
                               text=self.text or None, thinking=self.thinking or None, model=self.model or None,
                               tokensIn=self.tokens[0] or None, tokensOut=self.tokens[1] or None,
                               ms=max(0, _now_ms() - self.started_ms)))
        return events


# ── the office's native streams, read by the bridge only ────────────────────
class BufferStream:
    """Codex app-server and Hermes API runs: server.py's `meta.runtime` buffer (condition, events, done)."""

    def __init__(self, runtime):
        self.runtime = runtime
        self.cursor = 0

    def next(self, timeout):
        rt = self.runtime
        with rt["condition"]:
            if self.cursor >= len(rt["events"]) and not rt.get("done"):
                rt["condition"].wait(timeout=timeout)
            if self.cursor < len(rt["events"]):
                item = rt["events"][self.cursor]
                self.cursor += 1
                return str(item.get("event") or ""), item.get("data") or {}
        return None

    def finished(self):
        rt = self.runtime
        with rt["condition"]:
            return bool(rt.get("done")) and self.cursor >= len(rt["events"])

    def settled(self):
        return bool(self.runtime.get("done"))


class ProviderRunStream:
    """OpenCode, Antigravity, extensions (/api/provider-runs): `_PROVIDER_RUNS[run]` (condition, events with ids)."""

    def __init__(self, meta):
        self.meta = meta
        self.last_id = 0

    def next(self, timeout):
        meta = self.meta
        with meta["condition"]:
            fresh = [e for e in meta.get("events") or [] if _int(e.get("id")) > self.last_id]
            if not fresh and not meta.get("done"):
                meta["condition"].wait(timeout=timeout)
                fresh = [e for e in meta.get("events") or [] if _int(e.get("id")) > self.last_id]
            if fresh:
                item = fresh[0]
                self.last_id = _int(item.get("id"))
                return str(item.get("event") or ""), item.get("data") or {}
        return None

    def finished(self):
        meta = self.meta
        with meta["condition"]:
            return bool(meta.get("done")) and not any(_int(e.get("id")) > self.last_id for e in meta.get("events") or [])

    def settled(self):
        return bool(self.meta.get("done"))


class QueueStream:
    """Claude Code runs: a queue.Queue with one consumer (this bridge) and meta['done']."""

    def __init__(self, meta):
        self.meta = meta
        self.events = meta.get("events")

    def next(self, timeout):
        if not isinstance(self.events, queue.Queue):
            return None
        try:
            item = self.events.get(timeout=timeout)
        except queue.Empty:
            return None
        return str(item.get("event") or ""), item.get("data") or {}

    def finished(self):
        return bool(self.meta.get("done")) and (not isinstance(self.events, queue.Queue) or self.events.empty())

    def settled(self):
        return bool(self.meta.get("done"))


class CallStream:
    """A provider path that answers in one call (Codex exec, Hermes' messaging fallback): run in a thread, its answer
    is one terminal snapshot."""

    def __init__(self, fn, body):
        self.box = queue.Queue()
        self.done = False

        def work():
            try:
                result = fn(body)
            except Exception as exc:  # (the provider's failure is the run's error, never the bridge's)
                result = {"ok": False, "error": str(exc)}
            result = result if isinstance(result, dict) else {"ok": False, "error": "The provider gave no answer"}
            ok = bool(result.get("ok")) and not result.get("interrupted")
            name = "run.completed" if ok else ("run.cancelled" if result.get("interrupted") else "run.failed")
            if not ok and not result.get("error") and not result.get("interrupted"):
                result = {**result, "error": str(result.get("reply") or "The provider call failed")}
            self.box.put((name, result))
            self.done = True

        threading.Thread(target=work, daemon=True, name="office-bridge-call").start()

    def next(self, timeout):
        try:
            return self.box.get(timeout=timeout)
        except queue.Empty:
            return None

    def finished(self):
        return self.done and self.box.empty()

    def settled(self):
        return True


def _settle(stream, limit=SETTLE_S):
    """Waits (bounded) until the office's run code has finished its own bookkeeping after the terminal event."""
    settled = getattr(stream, "settled", None)
    deadline = time.time() + limit
    while callable(settled) and not settled() and time.time() < deadline:
        time.sleep(0.02)


# ── one run as the layer sees it ─────────────────────────────────────────────
class RunRecord:
    def __init__(self, run_id, agent, session_key, lock_key, native_kind):
        self.run_id = run_id
        self.agent = agent
        self.lock_key = lock_key
        self.native_kind = native_kind
        self.native_run_id = ""
        self.condition = threading.Condition()
        self.events = []
        self.next_id = 1
        self.first_id = 1
        self.done = False
        self.ended_at = 0.0
        self.started_at = time.time()
        self.stop_requested = 0.0
        self.feed_lock = threading.Lock()   # (the pump and the approve route take turns on the translator)
        self.translator = Translator(run_id, agent["officeId"], session_key, agent.get("model") or "")

    @property
    def session_key(self):
        return self.translator.session_key

    def emit(self, events):
        if not events:
            return
        with self.condition:
            for event in events:
                self.events.append({"id": self.next_id, "event": event})
                self.next_id += 1
                if event.get("type") == "run.end":
                    self.done = True
                    self.ended_at = time.time()
            if len(self.events) > MAX_EVENTS:
                drop = len(self.events) - MAX_EVENTS
                self.events = self.events[drop:]
                self.first_id = self.events[0]["id"]
            self.condition.notify_all()

    def read(self, since, timeout):
        """Events with id > since (waits up to `timeout` for one), and whether the run has ended."""
        deadline = time.time() + max(0.0, timeout)
        with self.condition:
            while True:
                fresh = [item for item in self.events if item["id"] > since]
                if fresh or self.done:
                    return fresh, self.done
                left = deadline - time.time()
                if left <= 0:
                    return [], False
                self.condition.wait(timeout=min(left, 1.0))

    def view(self):
        return {"runId": self.run_id, "agentKey": self.agent["officeId"], "sessionKey": self.session_key,
                "done": self.done, "lastEventId": self.next_id - 1}


class BridgeError(Exception):
    def __init__(self, status, code, message, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


# ── the bridge ───────────────────────────────────────────────────────────────
class Bridge:
    """Routes, runs and their records. `ops` reaches the office's provider code (ServerOps for server.py, a fake in
    tests); `secret` returns the layer's boot secret (None while the layer is off: every call is refused)."""

    def __init__(self, ops, secret, watch_s=WATCH_S):
        self.ops = ops
        self.secret = secret
        self.lock = threading.RLock()
        self.runs = {}
        self.active = {}    # lock key -> run id while that run has not ended
        self.watch_s = watch_s
        self.watcher = None
        self.signature = None

    # the layer re-reads /agents when the office's chattable agents change (else on its own 60 s timer)
    def _agents_signature(self, agents):
        keys = ("officeId", "name", "emoji", "provider", "providerLabel", "transport", "model", "available", "role", "caps")
        return json.dumps([{k: a.get(k) for k in keys} for a in agents], sort_keys=True, default=str)

    def _watch(self):
        while True:
            time.sleep(self.watch_s)
            if not (self.secret() if callable(self.secret) else self.secret):
                self.signature = None   # (the layer is off: nothing to tell; it reads /agents again when it starts)
                continue
            try:
                signature = self._agents_signature(self.agents(cached=True))   # (never starts a discovery itself)
            except Exception:
                continue
            if self.signature is not None and signature != self.signature:
                try:
                    self.ops.poke_layer()
                except Exception:
                    pass
            self.signature = signature

    def _start_watch(self, agents):
        with self.lock:
            if self.signature is None:
                self.signature = self._agents_signature(agents)
            if self.watcher is None and self.watch_s:
                self.watcher = threading.Thread(target=self._watch, daemon=True, name="office-bridge-agents")
                self.watcher.start()

    # who may call
    def principal(self, client_ip, headers):
        forwarded = any(headers.get(n) for n in ("X-Forwarded-For", "Forwarded", "X-Real-IP"))
        if forwarded or not _is_loopback(client_ip):
            raise BridgeError(403, "forbidden", "Only this office's provider layer may call the bridge")
        principal = read_principal(headers.get(PRINCIPAL_HEADER), self.secret() if callable(self.secret) else self.secret)
        if not principal:
            raise BridgeError(401, "signin_required", "Open the office first")
        return principal

    # agents
    def agents(self, cached=False):
        out = []
        for row in (self.ops.roster_cached() if cached else self.ops.roster()):
            ref = describe_agent(row, self.ops)
            if ref:
                out.append(ref)
        return out

    def agent(self, key):
        key = str(key or "").strip()
        if not key:
            raise BridgeError(400, "agent_required", "Which agent?")
        rows = self.ops.roster()
        for field in ("statusKey", "id"):
            for row in rows:
                if str(row.get(field) or "") == key:
                    ref = describe_agent(row, self.ops)
                    if not ref:
                        raise BridgeError(404, "not_office_agent", "That agent does not chat through the office")
                    return ref
        raise BridgeError(404, "unknown_agent", f"Unknown agent: {key}")

    # runs
    def _lock_key(self, ref, session):
        if ref["provider"] == "codex" or ref["transport"] == "sdk":
            return f"{ref['provider']}:{ref['profile']}"   # (one turn per Codex profile; provider-runs reserve the same)
        return f"{ref['provider']}:{ref['profile']}:{session or uuid.uuid4().hex}"

    def _prune(self):
        now = time.time()
        with self.lock:
            stale = [rid for rid, rec in self.runs.items() if rec.done and now - rec.ended_at > RUN_KEEP_S]
            for rid in stale:
                self.runs.pop(rid, None)
            if len(self.runs) > MAX_RUNS:
                ended = sorted((r for r in self.runs.values() if r.done), key=lambda r: r.ended_at)
                for rec in ended[:len(self.runs) - MAX_RUNS]:
                    self.runs.pop(rec.run_id, None)

    def start_run(self, principal, body):
        ref = self.agent(body.get("agent"))
        text = str(body.get("input") if body.get("input") is not None else body.get("text") or "").strip()
        if not text:
            raise BridgeError(400, "input_required", "Write a message first")
        session = str(body.get("session") or "").strip()
        files = self._attachments(ref, body.get("attachments"))
        self._prune()
        lock_key = self._lock_key(ref, session)
        with self.lock:
            holder = self.active.get(lock_key)
            if holder and holder in self.runs and not self.runs[holder].done:
                raise BridgeError(409, "busy", "This agent is already working on a message. Wait for it or press Stop.",
                                  runId=holder)
            run_id = "ob-" + uuid.uuid4().hex[:20]
            rec = RunRecord(run_id, ref, session, lock_key, ref["transport"])
            self.runs[run_id] = rec
            self.active[lock_key] = run_id
        office_body = {
            "agentId": ref["id"], "message": text, "fromType": "human", "fromDisplayName": "User",
            "sourceApp": "virtual-office", "sourceSurface": "chat-window", "attachments": files,
        }
        if session:
            office_body["sessionId"] = session
        else:
            office_body["newSessionPending"] = True
        try:
            started = self.ops.start(ref, office_body)
        except Exception as exc:
            started = {"ok": False, "error": str(exc), "_status": 502}
        if not started.get("ok"):
            with self.lock:
                self.runs.pop(run_id, None)
                if self.active.get(lock_key) == run_id:
                    self.active.pop(lock_key, None)
            status = _int(started.get("_status"), 502)
            if status == 409:
                raise BridgeError(409, "busy", str(started.get("error") or "This agent is already working on a message."))
            raise BridgeError(status if 400 <= status < 600 else 502, str(started.get("code") or "run_failed"),
                              str(started.get("error") or "The run did not start"))
        rec.native_run_id = str(started.get("runId") or "")
        rec.native_kind = str(started.get("_stream") or ref["transport"])
        native_session = str(started.get("sessionId") or "")
        if native_session and not native_session.startswith("@new"):
            rec.translator.session_key = native_session
        stream = started.get("_streamObject")
        rec.emit(rec.translator.start())
        threading.Thread(target=self._pump, args=(rec, stream), daemon=True, name=f"office-bridge-{run_id}").start()
        return {"ok": True, "runId": run_id, "sessionKey": rec.session_key or None,
                "provider": ref["provider"], "transport": rec.native_kind}

    def _pump(self, rec, stream):
        last_event = time.time()
        try:
            while not rec.translator.ended:
                item = stream.next(0.5) if stream is not None else None
                if item is None:
                    if stream is None or stream.finished():
                        break
                    now = time.time()
                    if rec.stop_requested and now - rec.stop_requested > STOP_GRACE_S:
                        with rec.feed_lock:
                            rec.emit(rec.translator.end("stopped"))
                        break
                    if now - last_event > IDLE_LIMIT_S:
                        with rec.feed_lock:
                            rec.emit(rec.translator.end("error", "The agent stopped answering"))
                        break
                    continue
                last_event = time.time()
                name, payload = item
                if rec.stop_requested and str(name).lower() == "run.failed" and not payload.get("ok", False):
                    name = "run.cancelled"   # (an interrupted turn some paths report as failed: the person stopped it)
                if str(name).lower() in _TERMINAL:
                    _settle(stream)   # (run.end once the office has written the run's answer to its history)
                with rec.feed_lock:
                    rec.emit(rec.translator.feed(name, payload))
        except Exception as exc:  # (a broken stream ends the run; the bridge stays up)
            with rec.feed_lock:
                rec.emit(rec.translator.end("error", f"The run's stream broke: {exc}"))
        with rec.feed_lock:
            if not rec.translator.ended:
                if rec.stop_requested:
                    rec.emit(rec.translator.end("stopped"))
                else:
                    rec.emit(rec.translator.end("error", "The run ended without an answer"))
        with self.lock:
            if self.active.get(rec.lock_key) == rec.run_id:
                self.active.pop(rec.lock_key, None)

    def run(self, run_id):
        with self.lock:
            rec = self.runs.get(str(run_id or ""))
        if not rec:
            raise BridgeError(404, "unknown_run", "That run is not known here (it ended long ago or never started)")
        return rec

    def stop(self, body):
        if body.get("run"):
            rec = self.run(body.get("run"))
        else:
            ref = self.agent(body.get("agent"))
            with self.lock:
                live = [r for r in self.runs.values() if not r.done and r.agent["officeId"] == ref["officeId"]
                        and (not body.get("session") or r.session_key == str(body.get("session")))]
            if not live:
                return {"ok": True, "stopped": False}
            rec = live[-1]
        if rec.done:
            return {"ok": True, "stopped": False}
        rec.stop_requested = time.time()
        try:
            result = self.ops.interrupt(rec.agent, rec.native_run_id, rec.native_kind) or {}
        except Exception as exc:
            result = {"ok": False, "error": str(exc)}
        return {"ok": True, "stopped": True, "provider": {"ok": bool(result.get("ok")), "error": result.get("error")}}

    def approve(self, body):
        rec = self.run(body.get("run"))
        approval_id = str(body.get("approvalId") or "")
        pending = rec.translator.approval
        if not pending or Translator._approval_id(pending) != approval_id:
            raise BridgeError(409, "not_pending", "That approval is no longer waiting")
        decision = str(body.get("decision") or "")
        approved = bool(body.get("approved")) if "approved" in body else decision.startswith("allow")
        if decision and decision not in APPROVAL_OPTIONS:
            raise BridgeError(400, "bad_decision", f"This agent takes {', '.join(APPROVAL_OPTIONS)}")
        with rec.feed_lock:   # (resolved before whatever the agent does next is translated)
            result = self.ops.respond_approval(rec.agent, pending, approved) or {}
            if not result.get("ok"):
                raise BridgeError(409, "not_pending", str(result.get("error") or "The agent did not take the answer"))
            rec.emit(rec.translator.answered(approval_id, approved, decision or ("allow-once" if approved else "deny")))
        return {"ok": True}

    def running_for(self, office_id, session):
        with self.lock:
            live = [r for r in self.runs.values() if not r.done and r.agent["officeId"] == office_id
                    and (r.session_key == session or (not r.session_key and not session))]
        return live[-1].view() if live else None

    # attachments: files from the layer's own store, copied into the office's uploads (what its providers read)
    def _attachments(self, ref, items):
        if not items:
            return []
        if not isinstance(items, list):
            raise BridgeError(400, "bad_attachments", "attachments must be a list")
        if not ref["caps"].get("attachments"):
            raise BridgeError(400, "no_attachments", "This agent takes no attachments")
        if len(items) > MAX_ATTACHMENTS:
            raise BridgeError(400, "too_many_attachments", f"At most {MAX_ATTACHMENTS} files per message")
        roots = [os.path.realpath(r) for r in self.ops.attachment_roots() if r]
        out = []
        for item in items:
            if not isinstance(item, dict):
                raise BridgeError(400, "bad_attachments", "Each attachment is {name, mime, size, path}")
            real = os.path.realpath(str(item.get("path") or ""))
            if not any(real.startswith(root + os.sep) for root in roots) or not os.path.isfile(real):
                raise BridgeError(400, "bad_attachment_path", "An attachment is not in the chat's file store")
            if os.path.getsize(real) > MAX_ATTACHMENT_BYTES:
                raise BridgeError(400, "attachment_too_large", "A file is larger than 50 MB")
            name = os.path.basename(str(item.get("name") or "file").replace("\\", "/")) or "file"
            mime = str(item.get("mime") or mimetypes.guess_type(name)[0] or "")
            out.append(self.ops.store_attachment(real, name, mime))
        return out

    # chats
    def sessions(self, ref, manage):
        if not ref["caps"].get("sessions"):
            return {"ok": True, "sessions": [], "supported": False}
        payload, status = self.ops.sessions(ref, 100, manage)
        if status >= 400 or not payload.get("ok", True):
            raise BridgeError(status if status >= 400 else 502, "sessions_failed",
                              str(payload.get("error") or "The agent's chats could not be read"))
        rows = []
        for row in payload.get("sessions") or []:
            if not isinstance(row, dict) or not row.get("id"):
                continue
            rows.append({
                "key": str(row["id"])[:300],
                "title": str(row.get("title") or row.get("preview") or "Chat")[:120],
                "preview": str(row.get("preview") or "")[:240] or None,
                "updatedAt": _epoch_ms(row.get("updatedAt") or row.get("updated_at") or row.get("lastActiveAt")
                                       or row.get("mtime") or row.get("createdAt")),
                "active": bool(row.get("active")),
            })
        return {"ok": True, "sessions": rows, "activeKey": payload.get("activeSessionId") or None}

    def history(self, ref, session):
        running = self.running_for(ref["officeId"], session)
        if not session:
            return {"ok": True, "messages": [], "authoritative": True, "running": running}
        raw = self.ops.history(ref, session) or {}
        messages = [m for m in (to_layer_message(x) for x in raw.get("messages") or []) if m]
        out = {"ok": True, "messages": messages, "authoritative": True, "running": running}
        used, size, _, _ = _usage_numbers(raw)
        if used or size:
            out["usage"] = {"used": used or None, "size": size or None}
        return out

    # HTTP
    def handle(self, handler):
        """Answers one /api/office-bridge/* request on a BaseHTTPRequestHandler (True: answered)."""
        parts = urllib.parse.urlsplit(handler.path)
        route = parts.path[len(PREFIX):].strip("/")
        query = {k: v[-1] for k, v in urllib.parse.parse_qs(parts.query).items()}
        method = handler.command
        try:
            principal = self.principal((handler.client_address or ("",))[0], handler.headers)
            manage = principal.get("role") == "owner"
            if method == "GET" and route == "runs/events":
                return self._events(handler, query)
            body = _read_body(handler) if method == "POST" else {}
            answer = self.route(method, route, query, body, principal, manage)
            _send(handler, 200, answer)
        except BridgeError as err:
            _send(handler, err.status, {"ok": False, "error": err.message, "code": err.code, **err.extra})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # (an office provider function failed: the caller gets why, the server keeps going)
            print(f"[office-bridge] {method} {route}: {type(exc).__name__}: {str(exc)[:300]}")
            try:
                _send(handler, 500, {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:300]}", "code": "internal_error"})
            except OSError:
                pass
        return True

    def route(self, method, route, query, body, principal, manage):
        if method == "GET" and route == "agents":
            agents = self.agents()
            self._start_watch(agents)
            return {"ok": True, "agents": agents}
        if method == "GET" and route == "models":
            ref = self.agent(query.get("agent"))
            return {"ok": True, **self.ops.models(ref)}
        if method == "GET" and route == "sessions":
            return self.sessions(self.agent(query.get("agent")), manage)
        if method == "GET" and route == "history":
            return self.history(self.agent(query.get("agent")), str(query.get("session") or ""))
        if method == "GET" and route == "runs":
            return {"ok": True, **self.run(query.get("run")).view()}
        if method != "POST":
            raise BridgeError(404, "not_found", "No such bridge route")
        if route == "runs":
            return self.start_run(principal, body)
        if route == "stop":
            return self.stop(body)
        if route == "approve":
            return self.approve(body)
        if route == "sessions/create":
            ref = self.agent(body.get("agent"))
            if not ref["caps"].get("sessionCreate"):
                raise BridgeError(501, "unsupported", "This agent keeps one conversation")
            payload, status = self.ops.create_session(ref)
            if status >= 400 or not payload.get("ok"):
                raise BridgeError(status if status >= 400 else 502, "create_failed", str(payload.get("error") or "No new chat"))
            key = str(payload.get("sessionId") or "")
            return {"ok": True, "session": {"key": key or None, "pending": not key, "title": "New chat"}}
        if route == "sessions/delete":
            ref = self.agent(body.get("agent"))
            if not ref["caps"].get("sessionDelete"):
                raise BridgeError(501, "unsupported", "This agent's chats cannot be deleted here")
            session = str(body.get("session") or "").strip()
            if not session:
                raise BridgeError(400, "session_required", "Which chat?")
            if self.running_for(ref["officeId"], session):
                raise BridgeError(409, "busy", "That chat is still working: stop it first")
            payload, status = self.ops.delete_session(ref, session)
            if status >= 400 or not payload.get("ok"):
                raise BridgeError(status if status >= 400 else 502, "delete_failed", str(payload.get("error") or "Not deleted"))
            return {"ok": True}
        if route == "sessions/rename":
            raise BridgeError(501, "unsupported", "Office agents do not rename their chats")
        raise BridgeError(404, "not_found", "No such bridge route")

    def _events(self, handler, query):
        rec = self.run(query.get("run"))
        since = _int(query.get("since") or handler.headers.get("Last-Event-ID"), 0)
        if str(query.get("json") or "") in {"1", "true"}:
            events, done = rec.read(since, min(25.0, float(_int(query.get("wait"), 0))))
            _send(handler, 200, {"ok": True, "events": [dict(e["event"], id=e["id"]) for e in events], "done": done,
                                 "firstId": rec.first_id})
            return True
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("Connection", "close")
        handler.end_headers()
        handler.close_connection = True
        cursor, last_write = since, time.time()
        try:
            handler.wfile.flush()   # (the office's response buffer streams from the first flush)
            if since and since < rec.first_id - 1:   # (the oldest events were dropped: the reader starts over)
                handler.wfile.write(f"event: replay.gap\ndata: {json.dumps({'firstId': rec.first_id})}\n\n".encode())
            while True:
                events, done = rec.read(cursor, KEEPALIVE_S)
                for item in events:
                    data = json.dumps(item["event"], ensure_ascii=False, default=str)
                    handler.wfile.write(f"id: {item['id']}\nevent: {item['event']['type']}\ndata: {data}\n\n".encode("utf-8"))
                    cursor = item["id"]
                if events:
                    handler.wfile.flush()
                    last_write = time.time()
                if done and not [e for e in rec.events if e["id"] > cursor]:
                    break
                if time.time() - last_write >= KEEPALIVE_S:
                    handler.wfile.write(b": keepalive\n\n")
                    handler.wfile.flush()
                    last_write = time.time()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        return True


def _epoch_ms(value):
    if isinstance(value, (int, float)) and value > 0:
        return int(value if value > 1e12 else value * 1000)
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if text.isdigit():
            return _epoch_ms(int(text))
        try:
            from datetime import datetime
            return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return None
    return None


def _read_body(handler):
    length = _int(handler.headers.get("Content-Length"), 0)
    if length > 2 * 1024 * 1024:
        raise BridgeError(413, "too_large", "Request too large")
    raw = handler.rfile.read(length) if length > 0 else b""
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise BridgeError(400, "invalid_json", "Request body is not valid JSON")
    if not isinstance(body, dict):
        raise BridgeError(400, "invalid_json", "Request body must be an object")
    return body


def _send(handler, status, payload):
    data = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)


PROVIDER_LABELS = {"codex": "Codex", "claude-code": "Claude Code", "opencode": "OpenCode", "antigravity": "Antigravity",
                   "hermes": "Hermes"}


# ── what an office agent is, for the layer (ext_json.office) ────────────────
def office_caps(flags, provider, transport):
    """The office provider flags (app/providers/builtin.py, per-agent capabilityOverrides already applied) in the
    layer's capability names. Model and effort pickers are not offered this round (the model shows read-only)."""
    flags = flags if isinstance(flags, dict) else {}
    on = lambda name: bool(flags.get(name))
    app_server = provider == "codex" and transport == "app-server"
    caps = {
        "chat": on("chat"),
        "sessions": on("sessions"),
        "sessionCreate": on("sessions") and (on("sessionCreate") or on("sessions.create")),
        "sessionDelete": on("sessions") and (on("sessionDelete") or on("sessions.delete")),
        "stop": on("interrupt") or on("stop"),
        "approvals": on("approvals") and (provider != "codex" or app_server),
        "attachments": on("attachments"),
        "tools": on("tools"),
        "streaming": on("streaming") and not (provider == "codex" and not app_server),
        "context": provider in {"codex", "claude-code"} and (provider != "codex" or app_server),
        "models": False, "effort": False, "queue": False, "questions": False, "plan": False, "tasks": False,
        "browser": False, "files": False, "commands": False, "rewrite": False, "rewind": False, "branch": False,
        "archive": False, "presence": False,
    }
    return caps


def describe_agent(row, ops):
    """{officeId, id, name, emoji, provider, transport, profile, model, caps} for a chattable office agent; None for
    OpenClaw, the layer's own Hermes agents (pl- connections), Hermes serve agents and agents that cannot chat."""
    if not isinstance(row, dict) or not row.get("id"):
        return None
    kind = str(row.get("providerKind") or "openclaw").strip().lower()
    if kind == "openclaw":
        return None
    office_id = str(row.get("statusKey") or row.get("id"))
    if kind in {"claudecode", "claude"}:
        kind = "claude-code"
    if kind == "hermes":
        if str(row.get("providerConnectionId") or "").startswith("pl-") or ops.is_serve_agent(row.get("id")):
            return None
        transport = "api" if row.get("apiAvailable") else "sdk"
    elif kind == "codex":
        transport = "app-server" if ops.codex_app_server() else "exec"
    elif kind == "claude-code":
        transport = "cli"
    else:
        transport = "sdk"
    flags = row.get("capabilities") if isinstance(row.get("capabilities"), dict) else {}
    caps = office_caps(flags, kind, transport)
    if not caps["chat"]:
        return None
    return {
        "officeId": office_id, "id": str(row.get("id")), "name": str(row.get("name") or office_id),
        "emoji": row.get("emoji") or None, "provider": kind, "providerLabel": ops.provider_label(kind),
        "role": str(row.get("role") or "")[:120] or None, "transport": transport,
        "profile": str(row.get("profile") or row.get("providerAgentId") or row.get("id")),
        "model": str(row.get("model") or ""), "available": bool(row.get("available", True)), "caps": caps,
    }


_A2A_HEAD_RE = re.compile(r"^\s*\[A2A\s+([^\]\n]*)\]\s*\n?")
_DELIVERY_RE = re.compile(r"^\s*Message from [^\n]{1,200}? via [^\n]{1,200}?\.[ \t]*\n+([\s\S]*?)\n+[ \t]*Reply directly to the user\.[^\n]*"
                          r"(?:\s*\n\n(Attached files uploaded through [\s\S]*))?\s*$")


def person_text(text):
    """What the person typed, not the office's delivery wrapper around it ("[A2A from=user ... isUser=true]",
    "Message from X via Virtual Office Chat. ... Reply directly to the user. ..."): Codex and Claude Code keep the text
    they were sent, so their histories carry the wrapper (the old window unwraps it too). A note from another agent
    (an A2A header without isUser=true) is left whole. Returns (text, file names from the office's attachment note)."""
    value = str(text or "")
    head = _A2A_HEAD_RE.match(value)
    if head:
        if "isUser=true" not in head.group(1):
            return value, []
        value = value[head.end():]
    match = _DELIVERY_RE.match(value)
    if not match:
        return (value.strip() if head else str(text or "")), []
    names = [line[2:].split(":", 1)[0].strip() for line in (match.group(2) or "").splitlines()[1:] if line.startswith("- ")]
    return match.group(1).strip(), [n for n in names if n]


def to_layer_message(message):
    """One office history message ({role, text, ts|epochMs, tools, thinking, attachments, error}) in the layer's shape
    ({role, text, ts, status?, meta: {steps, thinking, files}})."""
    if not isinstance(message, dict):
        return None
    role = str(message.get("role") or "").lower()
    if role not in {"user", "assistant", "system"}:
        return None
    text = str(message.get("text") or message.get("content") or "")
    noted = []
    if role == "user":
        text, noted = person_text(text)
    text = _clip(text, TEXT_MAX)
    out = {"role": role, "text": text}
    ts = _epoch_ms(message.get("epochMs") or message.get("ts") or message.get("timestamp"))
    if ts:
        out["ts"] = ts
    meta = {}
    steps = []
    for index, card in enumerate(message.get("tools") or []):
        if not isinstance(card, dict):
            continue
        name = str(card.get("name") or card.get("tool") or "tool")[:120]
        args = card.get("arguments", card.get("input", card.get("args")))
        state = _tool_state(card)
        step = {"id": _tool_key(card, index), "name": name, "title": str(card.get("title") or name)[:200],
                "kind": tool_kind(name), "input": _tool_input(args), "output": _clip(_tool_output(card), TOOL_TEXT_MAX),
                "ok": state == "ok", "status": "done" if state == "ok" else ("running" if state == "open" else "error")}
        if isinstance(card.get("exitCode"), int):
            step["exitCode"] = card["exitCode"]
        steps.append(step)
    if steps:
        meta["steps"] = steps
    if isinstance(message.get("thinking"), str) and message["thinking"].strip():
        meta["thinking"] = _clip(message["thinking"], TEXT_MAX)
    files = [{"name": str(a.get("name") or "file")[:200], "mime": str(a.get("mimeType") or a.get("mime") or "")[:100],
              "size": _int(a.get("size")) or None}
             for a in message.get("attachments") or [] if isinstance(a, dict)]
    if not files and noted:
        files = [{"name": n[:200], "mime": "", "size": None} for n in noted]
    if files:
        meta["files"] = files
    if meta:
        out["meta"] = meta
    if role == "assistant" and message.get("error") and _int(message.get("exitCode"), 0) != 0:
        out["status"] = "failed"
    if not text and not meta:
        return None
    return out


# ── server.py's provider code, reached by name (no provider code moves) ──────
class ServerOps:
    """The office's existing functions in server.py's namespace (globals()), looked up at call time so tests that
    replace one on the module are honoured."""

    def __init__(self, namespace, layer=None):
        self.ns = namespace
        self.layer = layer   # a callable returning PROVIDER_LAYER

    def _f(self, name):
        return self.ns[name]

    def roster(self):
        return list(self._f("get_roster")() or [])

    def roster_cached(self):
        """The roster the office last discovered (no refresh: pages and the layer's own reads keep it current)."""
        return list(self.ns.get("_discovered_roster") or [])

    def is_serve_agent(self, office_id):
        try:
            return bool(self._f("agent_providers").is_serve_agent(office_id))
        except Exception:
            return False

    def provider_label(self, kind):
        if kind in PROVIDER_LABELS:
            return PROVIDER_LABELS[kind]
        try:   # (an extension's own name from its manifest)
            manifest = self._f("_get_provider_registry")().manifest(kind)
            name = str(getattr(manifest, "name", "") or "").strip()
        except Exception:
            name = ""
        return name[:60] or kind.replace("-", " ").replace("_", " ").title()

    def poke_layer(self):
        """POST /api/pl/internal/office/sync with the layer's internal principal: it re-reads /agents now."""
        layer = self.layer() if callable(self.layer) else self.layer
        if layer is not None and getattr(layer, "port", None):
            layer.call(layer.internal_principal(), "POST", "/api/pl/internal/office/sync", {}, timeout=10.0)

    def codex_app_server(self):
        provider = self._f("_codex_provider")()
        return bool(provider and getattr(provider, "prefer_app_server", False))

    def models(self, ref):
        model = ref.get("model") or ""
        return {"models": [{"id": model, "label": model}] if model else [], "effort": [], "current": model or None,
                "readOnly": True}

    def start(self, ref, body):
        provider, transport = ref["provider"], ref["transport"]
        if provider == "codex":
            if transport == "app-server":
                started = self._f("_handle_codex_run_start")(dict(body))
                if started.get("ok"):
                    meta = self._f("_get_codex_active_run")(started.get("runId")) or {}
                    return {**started, "_streamObject": BufferStream(meta["runtime"]), "_stream": "app-server"}
                if not started.get("fallback"):
                    return started
            return {"ok": True, "runId": "", "_stream": "exec",
                    "_streamObject": CallStream(self._f("_handle_codex_chat"), dict(body))}
        if provider == "claude-code":
            started = self._f("_handle_claude_code_run_start")(dict(body))
            if started.get("ok"):
                meta = self._f("_get_claude_code_stream_run")(started.get("runId")) or {}
                return {**started, "_streamObject": QueueStream(meta), "_stream": "cli"}
            return started
        if provider == "hermes" and transport == "api":
            started = self._f("_handle_hermes_run_start")(dict(body))
            if started.get("ok"):
                meta = self._f("_get_hermes_active_run")(started.get("runId")) or {}
                return {**started, "_streamObject": BufferStream(meta["runtime"]), "_stream": "api"}
            if started.get("fallback"):
                return {"ok": True, "runId": "", "_stream": "messaging",
                        "_streamObject": CallStream(self._f("_handle_hermes_chat"), dict(body))}
            return started
        started = self._f("_handle_provider_run_start")(dict(body))
        if started.get("ok"):
            with self._f("_PROVIDER_RUNS_LOCK"):
                meta = self._f("_PROVIDER_RUNS").get(str(started.get("runId")))
            if not meta:
                return {"ok": False, "error": "The run vanished as it started", "_status": 502}
            return {**started, "_streamObject": ProviderRunStream(meta), "_stream": "sdk"}
        return started

    def interrupt(self, ref, native_run_id, native_kind):
        body = {"agentId": ref["id"], "runId": native_run_id}
        provider = ref["provider"]
        if provider == "codex":
            return self._f("_handle_codex_interrupt")(body)
        if provider == "claude-code":
            return self._f("_handle_claude_code_interrupt")(body)
        if provider == "hermes" and ref["transport"] == "api":
            return self._f("_handle_hermes_interrupt")(body)
        return self._f("_handle_provider_interrupt")(body)

    def respond_approval(self, ref, approval, approved):
        approval_id = str(approval.get("id") or approval.get("approval_id") or "")
        if ref["provider"] == "codex":
            return self._f("_handle_codex_approval_respond")({
                "agentId": ref["id"], "approval_id": approval_id, "approval": approval,
                "choice": "approve" if approved else "cancel"})
        if ref["provider"] == "hermes":
            return self._f("_handle_hermes_approval_respond")({
                "agentId": ref["id"], "approval_id": approval_id, "approval": approval,
                "sessionId": approval.get("session_id") or approval.get("sessionId") or "",
                "choice": "approve_once" if approved else "deny"})
        return {"ok": False, "error": "This agent takes no approvals"}

    def sessions(self, ref, limit, manage):
        return self._f("handle_chat_sessions_list")(ref["id"], limit=limit, manage=manage)

    def create_session(self, ref):
        return self._f("handle_chat_session_create")(ref["id"], {"agentId": ref["id"]})

    def delete_session(self, ref, session):
        result, status = self._f("handle_chat_session_delete")(ref["id"], session, {"agentId": ref["id"], "sessionId": session})
        if status == 200 and result.get("ok"):   # (as /api/office/chat-sessions/delete: the deleted chat was the active one)
            agent_ref = self._f("_chat_sessions_agent")(ref["id"])
            if agent_ref and agent_ref.get("providerKind") != "openclaw":
                active = self._f("_load_provider_active_session")(agent_ref["providerKind"], agent_ref["profile"])
                if str(active.get("sessionId") or "") == session:
                    self._f("_save_provider_active_session")(agent_ref["providerKind"], agent_ref["profile"], "", source="deleted")
                    self._f("_save_provider_history")(agent_ref["providerKind"], agent_ref["profile"], [])
        return result, status

    def history(self, ref, session):
        provider, profile = ref["provider"], ref["profile"]
        if provider == "codex":
            usage = self._f("_get_codex_token_usage")(profile)
            return {"messages": self._f("_load_codex_session_history")(profile, session), "tokenUsage": usage}
        if provider == "claude-code":
            return {"messages": self._f("_load_claude_code_session_history")(profile, session)}
        if provider == "hermes" and ref["transport"] == "api":
            return {"messages": self._f("_load_hermes_session_history")(profile, session)}
        return {"messages": self._f("get_provider_agent_messages")(provider, profile, session_id=session)}

    def attachment_roots(self):
        layer = self.layer() if callable(self.layer) else self.layer
        data_dir = getattr(layer, "data_dir", None)
        return [os.path.join(data_dir, "attachments")] if data_dir else []

    def store_attachment(self, src, name, mime):
        """A copy in the office's uploads folder, as POST /upload stores one (its providers read and map these paths)."""
        upload_dir = os.path.join(self._f("STATUS_DIR"), "uploads")
        owner = self.ns.get("data_owner")
        if owner is not None:
            owner.makedirs(upload_dir, exist_ok=True)
        else:
            os.makedirs(upload_dir, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" .") or "upload"
        stem, ext = os.path.splitext(safe)
        safe = (stem[:80] or "upload") + ext[:16]
        while True:
            dest = os.path.join(upload_dir, f"{uuid.uuid4().hex[:12]}-{safe}")
            try:
                fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
                break
            except FileExistsError:
                continue
        if owner is not None:
            owner.adopt_fd(fd, upload_dir)
        with os.fdopen(fd, "wb") as out, open(src, "rb") as source:
            shutil.copyfileobj(source, out)
        return {"path": dest, "url": "/chat-media?path=" + urllib.parse.quote(dest), "name": name,
                "mimeType": mime, "size": os.path.getsize(dest)}
