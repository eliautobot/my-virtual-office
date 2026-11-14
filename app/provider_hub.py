"""ChatHub: universal chat events from provider adapters to pages (design 2.5, 2.11).

Chat key = ``(connection id, native agent id, provider session key)``. Agent-level frames
(presence, tasks, ...) go to the agent key ``(cid, native, "*")``, connection-level frames
(``provider.status``) to ``(cid, "*", "*")``. A subscription receives only its own chat
key plus that agent's key and that connection's key: nothing crosses chats or agents.

Every event is rebuilt from a whitelist (strings clipped), stored with a global monotonic
``seq`` in its key's ring (2000 events or 30 min) and fanned out to subscribers. A page
resumes with ``Last-Event-ID`` / ``?since``; when the asked seq is older than the ring
(or from before a restart) it gets a ``resync`` frame and re-reads ``/state`` + history.

Frame on the wire: ``{"seq", "ts", "scope": "chat"|"agent"|"connection", "session",
"run", "observed", "event": {"type", ...}}``.

Media: ``sign_media(agent, session, ref)`` -> token for ``/api/agent-chat/media?t=``;
``serve_media(handler, token, fetch)`` checks the HMAC + expiry, serves from the disk
cache (LRU 500 MB) or fetches through the adapter, with ranges, ``CSP: sandbox`` and
``nosniff``. The page never sees a provider-side path.
"""

import base64
import collections
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import select
import socket
import threading
import time

import private_files

RING_MAX = 2000
RING_AGE_SEC = 30 * 60
QUEUE_MAX = 2000
STREAMS_PER_CLIENT = 8
STREAMS_MAX = 64
PEER_CHECK_SEC = 1.0
RETRY_AFTER_SEC = 2
HEARTBEAT_SEC = 15
RUNS_PER_CHAT = 6
CHATS_MAX = 600
TEXT_MAX = 100_000
TOOL_OUTPUT_MAX = 4_000
TITLE_MAX = 200
STRING_MAX = 2_000
MEDIA_TTL_SEC = 6 * 3600
MEDIA_MAX_BYTES = 40 * 1024 * 1024
MEDIA_CACHE_BYTES = 500 * 1024 * 1024
MEDIA_KEY_FILE = "provider-media.key"
MEDIA_DIR = "provider-media"
STAR = "*"


def chat_key(cid, native, session):
    return (str(cid or ""), str(native or ""), str(session or ""))


def agent_key(cid, native):
    return (str(cid or ""), str(native or ""), STAR)


def connection_key(cid):
    return (str(cid or ""), STAR, STAR)


# ── whitelist (MVW S§4.4) ────────────────────────────────────────────────
def _clip(value, limit=STRING_MAX):
    if isinstance(value, str):
        return value[:limit]
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return value if value == value and value not in (float("inf"), float("-inf")) else None
    return None


def _plain(value, depth=0, limit=STRING_MAX):
    """A bounded JSON copy of free-form data (tool input, task rows)."""
    if depth > 4:
        return None
    if isinstance(value, dict):
        out = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= 60:
                break
            item = _plain(v, depth + 1, limit)
            if item is not None:
                out[str(k)[:80]] = item
        return out
    if isinstance(value, (list, tuple)):
        return [x for x in (_plain(v, depth + 1, limit) for v in list(value)[:100]) if x is not None]
    return _clip(value, limit)


def _options(value):
    out = []
    for item in (value if isinstance(value, list) else [])[:8]:
        if isinstance(item, dict):
            row = {k: _clip(item.get(k), TITLE_MAX) for k in ("label", "description", "value", "id")
                   if isinstance(item.get(k), (str, int, float))}
            if row:
                out.append(row)
        elif isinstance(item, (str, int, float)):
            out.append(_clip(str(item), TITLE_MAX))
    return out


def _questions(value):
    out = []
    for item in (value if isinstance(value, list) else [])[:5]:
        if not isinstance(item, dict):
            continue
        row = {k: _clip(item.get(k), TITLE_MAX if k == "header" else STRING_MAX)
               for k in ("questionId", "header", "question", "prompt", "placeholder")
               if isinstance(item.get(k), (str, int))}
        for flag in ("multiSelect", "other", "secret"):
            if isinstance(item.get(flag), bool):
                row[flag] = item[flag]
        row["options"] = _options(item.get("options"))
        out.append(row)
    return out


def _steps(value):
    out = []
    for item in (value if isinstance(value, list) else [])[:100]:
        if isinstance(item, dict):
            out.append({k: _clip(item.get(k), TITLE_MAX if k != "step" else STRING_MAX)
                        for k in ("step", "status", "id", "content") if isinstance(item.get(k), (str, int))})
        elif isinstance(item, str):
            out.append({"step": item[:STRING_MAX], "status": "pending"})
    return out


def _media(value):
    out = []
    for item in (value if isinstance(value, list) else [])[:20]:
        if isinstance(item, dict):
            row = {k: _clip(item.get(k), 4096 if k == "url" else TITLE_MAX)
                   for k in ("url", "name", "mime", "kind", "size", "width", "height", "alt")
                   if isinstance(item.get(k), (str, int, float))}
            if row.get("url"):
                out.append(row)
    return out


_FIELDS = {
    "run.start": ("status", "observed", "model", "effort", "clientId", "startedAt", "queued", "source", "title"),
    "run.status": ("phase", "detail", "status"),
    "run.delta": ("text", "thinking", "at", "tat", "replace"),
    "tool.start": ("toolId", "name", "title", "toolKind", "input", "startedAt"),
    "tool.update": ("toolId", "text", "replace"),
    "tool.end": ("toolId", "ok", "status", "text", "exitCode", "ms", "title"),
    "approval.requested": ("approvalId", "rpcId", "title", "command", "summary", "options", "cwd",
                           "approvalKind", "description", "expiresAt"),
    "approval.resolved": ("approvalId", "decision", "status"),
    "question.requested": ("questionId", "questions", "title", "expiresAt"),
    "question.resolved": ("questionId", "status"),
    "plan.update": ("title", "steps", "revision", "explanation"),
    "plan.changed": ("revision",),
    "usage.update": ("used", "size", "cost", "tokensIn", "tokensOut"),
    "run.end": ("status", "text", "media", "model", "effort", "tokensIn", "tokensOut", "cost", "ms", "error",
                "fix", "steered", "reason"),
    "native": ("op", "title", "text", "detail"),
    "session.task": ("change", "task", "taskId"),
    # sources {sessionKey: platform} feeds Office life (visitors, alarm clocks).
    "agent.activity": ("active", "keys", "waiting", "task", "sessions", "sources"),
    # Busy helper sessions of an agent (Hermes stored rows with a parent): Office life's interns.
    # Its own type so presence (agent.activity -> office character) never sees a helpers-only change.
    "agent.helpers": ("children",),
    "provider.status": ("state", "code", "detail", "fix", "version"),
    "session.card": ("card", "revision"),
}
_LIMITS = {"text": TEXT_MAX, "thinking": TEXT_MAX, "title": TITLE_MAX, "phase": TITLE_MAX, "name": TITLE_MAX,
           "command": STRING_MAX * 4, "summary": STRING_MAX, "error": STRING_MAX, "fix": STRING_MAX}


def clean_event(event):
    """The event rebuilt from the whitelist, or None when its type is not one we pass on."""
    if not isinstance(event, dict):
        return None
    kind = str(event.get("type") or "")
    fields = _FIELDS.get(kind)
    if fields is None:
        return None
    out = {"type": kind}
    for name in fields:
        if name not in event:
            continue
        value = event.get(name)
        if name == "options":
            out[name] = _options(value)
        elif name == "questions":
            out[name] = _questions(value)
        elif name == "steps":
            out[name] = _steps(value)
        elif name == "media":
            out[name] = _media(value)
        elif name in ("input", "task", "card", "sessions", "keys", "waiting"):
            out[name] = _plain(value)
        elif name == "sources":
            out[name] = ({str(k)[:200]: _clip(v, 40) for k, v in list(value.items())[:64]}
                         if isinstance(value, dict) else {})
        elif name == "children":
            out[name] = max(0, min(99, int(value))) if isinstance(value, int) and not isinstance(value, bool) else 0
        elif name == "text" and kind in ("tool.update", "tool.end"):
            out[name] = _clip(value, TOOL_OUTPUT_MAX)
        else:
            clipped = _clip(value, _LIMITS.get(name, STRING_MAX))
            if clipped is not None or value is None:
                out[name] = clipped
    return out


# ── subscriptions ────────────────────────────────────────────────────────
class Subscription:
    """A bounded queue of frames for one page stream. ``get()`` raises ``queue.Empty`` on
    timeout; after an overflow it returns one ``resync`` frame and the stream ends."""

    def __init__(self, hub, keys, maxsize=QUEUE_MAX):
        self.hub = hub
        self.keys = frozenset(keys)
        self._queue = queue.Queue(maxsize=maxsize)
        self.overflowed = False
        self.closed = False

    def put(self, frame):
        if self.closed or self.overflowed:
            return
        try:
            self._queue.put_nowait(frame)
        except queue.Full:
            self.overflowed = True

    def get(self, timeout=None):
        if self.overflowed:
            self.close()
            return {"type": "resync", "reason": "overflow"}
        frame = self._queue.get(timeout=timeout)
        if self.overflowed:
            self.close()
            return {"type": "resync", "reason": "overflow"}
        return frame

    def close(self):
        if not self.closed:
            self.closed = True
            self.hub._drop(self)


class ChatHub:
    def __init__(self, ring_max=RING_MAX, ring_age=RING_AGE_SEC, queue_max=QUEUE_MAX, clock=time.time):
        self._lock = threading.RLock()
        self._clock = clock
        self.ring_max = ring_max
        self.ring_age = ring_age
        self.queue_max = queue_max
        # Seq starts from the clock so a page resuming with an id from before a restart resyncs.
        self.base = int(clock() * 1000)
        self._seq = self.base
        self._rings = collections.OrderedDict()   # key -> deque[frame]
        self._evicted = {}                        # key -> highest seq dropped from its ring
        self._chats = collections.OrderedDict()   # chat key -> {"runs": OrderedDict, title, usage, ...}
        self._subs = set()
        self._listeners = []

    # -- publishing --
    @property
    def seq(self):
        with self._lock:
            return self._seq

    def publish(self, key, event, run=None, observed=False):
        """Store and fan out one universal event. Returns the frame, or None when dropped."""
        clean = clean_event(event)
        if clean is None:
            return None
        key = tuple(key)
        scope = "connection" if key[1] == STAR else ("agent" if key[2] == STAR else "chat")
        run_id = str(run or event.get("runId") or event.get("run") or "")[:200]
        with self._lock:
            self._seq += 1
            frame = {"seq": self._seq, "ts": int(self._clock() * 1000), "scope": scope,
                     "session": key[2] if scope == "chat" else "", "event": clean}
            if run_id:
                frame["run"] = run_id
            if observed or event.get("observed") is True:
                frame["observed"] = True
            ring = self._rings.get(key)
            if ring is None:
                ring = self._rings[key] = collections.deque()
            self._rings.move_to_end(key)
            ring.append(frame)
            self._trim(key, ring)
            if scope == "chat":
                self._track(key, frame)
            targets = [s for s in self._subs if key in s.keys]
            listeners = list(self._listeners)
        for sub in targets:
            sub.put(frame)
        for listener in listeners:
            try:
                listener(key, frame)
            except Exception:
                pass
        return frame

    def publish_connection(self, cid, event):
        return self.publish(connection_key(cid), event)

    def _trim(self, key, ring):
        cutoff = int((self._clock() - self.ring_age) * 1000)
        while ring and (len(ring) > self.ring_max or ring[0]["ts"] < cutoff):
            dropped = ring.popleft()
            self._evicted[key] = max(self._evicted.get(key, 0), dropped["seq"])
        while len(self._rings) > CHATS_MAX * 2:
            old_key, _ = self._rings.popitem(last=False)
            self._evicted.pop(old_key, None)

    def add_listener(self, callback, first=False):
        """Server-side listener ``callback(key, frame)`` (presence -> office status). ``first``
        runs it before the others (a read-only tap that must see an event before presence acts)."""
        with self._lock:
            if first:
                self._listeners.insert(0, callback)
            else:
                self._listeners.append(callback)

        def remove():
            with self._lock:
                if callback in self._listeners:
                    self._listeners.remove(callback)
        return remove

    # -- run state for /state --
    def _chat(self, key):
        chat = self._chats.get(key)
        if chat is None:
            chat = self._chats[key] = {"runs": collections.OrderedDict(), "title": "", "usage": {}}
            while len(self._chats) > CHATS_MAX:
                self._chats.popitem(last=False)
        self._chats.move_to_end(key)
        return chat

    def _track(self, key, frame):
        event = frame["event"]
        kind = event["type"]
        chat = self._chat(key)
        if kind == "usage.update":
            chat["usage"] = {k: v for k, v in event.items() if k != "type"}
            return
        if kind == "native":
            if event.get("op") == "title" and isinstance(event.get("title"), str):
                chat["title"] = event["title"][:TITLE_MAX]
            return
        run_id = frame.get("run")
        if not run_id or kind in ("session.card", "plan.changed"):
            return
        runs = chat["runs"]
        run = runs.get(run_id)
        if run is None:
            run = runs[run_id] = {"runId": run_id, "status": "running", "observed": bool(frame.get("observed")),
                                  "text": "", "thinking": "", "tools": [], "approvals": [], "questions": [],
                                  "plan": None, "model": "", "effort": "", "startedAt": frame["ts"], "phase": ""}
            while len(runs) > RUNS_PER_CHAT:
                runs.popitem(last=False)
        if kind == "run.start":
            for name in ("model", "effort"):
                if isinstance(event.get(name), str):
                    run[name] = event[name]
            if event.get("status") in ("queued",):
                run["status"] = "queued"
        elif kind == "run.status":
            run["phase"] = event.get("phase") or ""
            if run["status"] == "queued":
                run["status"] = "running"
        elif kind == "run.delta":
            for field, offset in (("text", "at"), ("thinking", "tat")):
                piece = event.get(field)
                if not isinstance(piece, str) or not piece:
                    continue
                at = event.get(offset)
                current = run[field]
                if isinstance(at, int) and 0 <= at <= len(current):
                    current = current[:at] + piece if at + len(piece) > len(current) else current
                else:
                    current += piece
                run[field] = current[:TEXT_MAX]
            if run["status"] == "queued":
                run["status"] = "running"
        elif kind == "tool.start":
            tool = {k: event.get(k) for k in ("toolId", "name", "title", "toolKind", "input") if k in event}
            tool["status"] = "running"
            run["tools"] = [t for t in run["tools"] if t.get("toolId") != tool.get("toolId")][-79:] + [tool]
        elif kind in ("tool.update", "tool.end"):
            for tool in run["tools"]:
                if tool.get("toolId") == event.get("toolId"):
                    text = event.get("text") if isinstance(event.get("text"), str) else ""
                    if kind == "tool.update" and not event.get("replace"):
                        text = (tool.get("output") or "") + text
                    if text or kind == "tool.update":
                        tool["output"] = text[-TOOL_OUTPUT_MAX:]
                    if kind == "tool.end":
                        tool["status"] = event.get("status") or ("ok" if event.get("ok", True) else "error")
                        for name in ("ok", "exitCode", "ms"):
                            if name in event:
                                tool[name] = event[name]
        elif kind == "approval.requested":
            entry = {k: v for k, v in event.items() if k != "type"}
            entry["status"] = "pending"
            run["approvals"] = [a for a in run["approvals"] if a.get("approvalId") != entry.get("approvalId")] + [entry]
        elif kind == "approval.resolved":
            for entry in run["approvals"]:
                if entry.get("approvalId") == event.get("approvalId"):
                    entry["status"] = event.get("decision") or event.get("status") or "resolved"
        elif kind == "question.requested":
            entry = {k: v for k, v in event.items() if k != "type"}
            entry["status"] = "pending"
            run["questions"] = [q for q in run["questions"] if q.get("questionId") != entry.get("questionId")] + [entry]
        elif kind == "question.resolved":
            for entry in run["questions"]:
                if entry.get("questionId") == event.get("questionId"):
                    entry["status"] = event.get("status") or "answered"
        elif kind == "plan.update":
            run["plan"] = {k: v for k, v in event.items() if k != "type"}
        elif kind == "run.end":
            run["status"] = event.get("status") or "ok"
            for name in ("error", "fix", "media", "model", "effort", "steered"):
                if event.get(name) not in (None, ""):
                    run[name] = event[name]
            if isinstance(event.get("text"), str) and len(event["text"]) >= len(run["text"]):
                run["text"] = event["text"]

    def snapshot(self, key):
        """``{seq, title, working, usage, runs[]}`` for a chat key (design 2.5 /state)."""
        key = tuple(key)
        with self._lock:
            chat = self._chats.get(key) or {"runs": {}, "title": "", "usage": {}}
            runs = [json.loads(json.dumps(run)) for run in chat["runs"].values()]
            working = any(run["status"] in ("running", "queued") for run in runs)
            return {"seq": self._seq, "title": chat.get("title") or "", "working": working,
                    "usage": dict(chat.get("usage") or {}), "runs": runs}

    def open_runs(self, cid=None):
        """``[(chat key, run id)]`` still running (for ``end_runs``)."""
        with self._lock:
            return [(key, rid) for key, chat in self._chats.items() if cid is None or key[0] == cid
                    for rid, run in chat["runs"].items() if run["status"] in ("running", "queued")]

    def end_runs(self, cid, error, status="interrupted"):
        """End every open run of a connection (edited, removed, switched off, link lost)."""
        for key, rid in self.open_runs(cid):
            self.publish(key, {"type": "run.end", "status": status, "error": error}, run=rid)

    # -- subscribing --
    def subscribe(self, keys, since=None):
        """A Subscription for ``keys`` (a chat key + its agent and connection keys).
        Frames after ``since`` are queued first; a ``resync`` frame comes first instead
        when that history is gone."""
        keys = [tuple(k) for k in keys]
        sub = Subscription(self, keys, self.queue_max)
        with self._lock:
            replay = []
            if since is not None:
                gone = since < self.base or since > self._seq or any(
                    since < self._evicted.get(k, 0) for k in keys)
                if gone:
                    sub.put({"type": "resync", "reason": "history"})
                else:
                    for k in keys:
                        replay.extend(f for f in self._rings.get(k, ()) if f["seq"] > since)
            for frame in sorted(replay, key=lambda f: f["seq"]):
                sub.put(frame)
            self._subs.add(sub)
        return sub

    def _drop(self, sub):
        with self._lock:
            self._subs.discard(sub)

    def subscriber_count(self):
        with self._lock:
            return len(self._subs)

    def reset(self):
        """Forget everything (tests)."""
        with self._lock:
            for sub in list(self._subs):
                sub.closed = True
            self._subs.clear()
            self._rings.clear()
            self._evicted.clear()
            self._chats.clear()
            self._listeners.clear()


HUB = ChatHub()


# ── SSE writer ───────────────────────────────────────────────────────────
_STREAMS = collections.Counter()
_STREAMS_LOCK = threading.Lock()
_LIVE = {}    # stream token (threading.Event, set = replaced) -> (client, slot key or None)
_SLOTS = {}   # (client, slot) -> token of the stream holding that named slot
_PAGE_ID = re.compile(r"^[A-Za-z0-9_.:-]{6,80}$")
TOO_MANY_STREAMS = ("This browser has too many live chats open with the office. "
                    "Close a chat window or a tab and try again.")


def parse_since(value):
    try:
        text = str(value or "").strip()
        return int(text) if text else None
    except (TypeError, ValueError):
        return None


def stream_client(handler, query=None):
    """Who a stream counts against: the page that opened it (``X-VO-Client`` header or ``?client=``,
    one id per page load), so reloads, tabs and a reverse proxy (every browser behind one address)
    never share one small cap. Without a page id: the socket address, as before."""
    page = ""
    try:
        page = str(handler.headers.get("X-VO-Client") or "").strip()
    except Exception:
        page = ""
    if not page and query:
        value = query.get("client") or ""
        if isinstance(value, list):
            value = value[0] if value else ""
        page = str(value).strip()
    if page and _PAGE_ID.match(page):
        return "page:" + page
    try:
        return str((handler.client_address or ("",))[0])
    except Exception:
        return ""


def peer_closed(handler):
    """True once the browser closed the stream's socket (EOF or reset): the slot frees within
    about a second instead of at the next heartbeat write. Unknown sockets count as open."""
    sock = getattr(handler, "connection", None)
    if sock is None or not hasattr(sock, "fileno"):
        return False
    try:
        if hasattr(select, "poll"):
            poller = select.poll()
            poller.register(sock, select.POLLIN | select.POLLERR | select.POLLHUP)
            if not poller.poll(0):
                return False
        elif not select.select([sock], [], [], 0)[0]:
            return False
        return sock.recv(1, socket.MSG_PEEK) == b""
    except (BlockingIOError, InterruptedError, socket.timeout):
        return False
    except (ValueError, TypeError, AttributeError):
        return False  # TLS sockets refuse MSG_PEEK: the heartbeat write still notices
    except OSError:
        return True


def _release(token):
    """Caller holds _STREAMS_LOCK. Frees the token's slot once (replaced streams free early)."""
    entry = _LIVE.pop(token, None)
    if entry is None:
        return
    client, named = entry
    _STREAMS[client] -= 1
    if _STREAMS[client] <= 0:
        del _STREAMS[client]
    if named is not None and _SLOTS.get(named) is token:
        del _SLOTS[named]


def serve_sse(handler, keys, since=None, hub=None, client=None, heartbeat=None, max_seconds=None,
              stop=None, slot=None):
    """Answer an SSE request: ``id: <seq>`` + ``data: {frame}``; heartbeat comment every
    ``heartbeat`` s; ``resync`` frame then close on overflow. Max 8 streams per client (page id,
    see ``stream_client``) and 64 in all (429 JSON + Retry-After). ``slot`` names a stream a page
    holds once (the office life stream): a new one with the same client and slot replaces the old.
    Returns when the page goes away (closed socket, ``max_seconds`` / ``stop``)."""
    hub = hub or HUB
    heartbeat = heartbeat or HEARTBEAT_SEC
    client = str(client or "")
    named = (client, str(slot)) if slot else None
    token = threading.Event()
    with _STREAMS_LOCK:
        if named is not None and named in _SLOTS:
            old = _SLOTS[named]
            old.set()
            _release(old)
        if _STREAMS[client] >= STREAMS_PER_CLIENT or sum(_STREAMS.values()) >= STREAMS_MAX:
            handler._send_json({"ok": False, "error": "too_many_streams", "message": TOO_MANY_STREAMS}, 429,
                               headers={"Retry-After": str(RETRY_AFTER_SEC)})
            return False
        _STREAMS[client] += 1
        _LIVE[token] = (client, named)
        if named is not None:
            _SLOTS[named] = token
    sub = None
    try:
        sub = hub.subscribe(keys, since)
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache, no-store")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.end_headers()
        _write(handler, f"retry: 3000\n: seq {hub.seq}\n\n")
        started = wrote = time.time()
        while not sub.closed and not token.is_set():
            if stop is not None and stop.is_set():
                break
            if max_seconds is not None and time.time() - started > max_seconds:
                break
            try:
                frame = sub.get(timeout=min(heartbeat, PEER_CHECK_SEC))
            except queue.Empty:
                if peer_closed(handler):
                    break
                if time.time() - wrote >= heartbeat:
                    if not _write(handler, ": hb\n\n"):
                        break
                    wrote = time.time()
                continue
            if frame.get("type") == "resync":
                _write(handler, "data: " + json.dumps(frame, separators=(",", ":")) + "\n\n")
                if frame.get("reason") == "overflow":
                    break
                continue
            data = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
            if not _write(handler, f"id: {frame['seq']}\ndata: {data}\n\n"):
                break
            wrote = time.time()
        return True
    finally:
        if sub is not None:
            sub.close()
        with _STREAMS_LOCK:
            _release(token)


def _write(handler, text):
    try:
        handler.wfile.write(text.encode("utf-8"))
        handler.wfile.flush()
        return True
    except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
        return False


def open_streams(client=None):
    with _STREAMS_LOCK:
        return _STREAMS[str(client or "")] if client is not None else sum(_STREAMS.values())


# ── media signing + cache (design 2.11) ──────────────────────────────────
class _Media:
    key = None
    folder = None
    lock = threading.Lock()


MEDIA = _Media()


def configure_media(data_dir):
    """Load (or create, 0600) the signing key and the cache folder under the data dir."""
    MEDIA.folder = os.path.join(data_dir, MEDIA_DIR) if data_dir else None
    MEDIA.key = None
    if not data_dir:
        return
    path = os.path.join(data_dir, MEDIA_KEY_FILE)
    try:
        with open(path, "rb") as handle:
            key = handle.read().strip()
        if len(key) >= 32:
            MEDIA.key = key
            private_files.tighten(path)   # (one an older office opened to everyone becomes private again)
            return
    except OSError:
        pass
    key = secrets.token_hex(32).encode()
    try:
        private_files.write_private(path, key)
    except OSError:
        pass
    MEDIA.key = key


def _media_key():
    if MEDIA.key is None:
        MEDIA.key = secrets.token_hex(32).encode()
    return MEDIA.key


def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign_media(agent, session, ref, ttl=MEDIA_TTL_SEC, now=None):
    body = json.dumps({"a": str(agent), "s": str(session or ""), "r": str(ref),
                       "e": int((now or time.time()) + ttl)}, separators=(",", ":")).encode()
    mac = hmac.new(_media_key(), body, hashlib.sha256).digest()
    return _b64(body) + "." + _b64(mac)


def media_url(agent, session, ref, ttl=MEDIA_TTL_SEC):
    return "/api/agent-chat/media?t=" + sign_media(agent, session, ref, ttl)


def verify_media(token, now=None):
    """``{agent, session, ref}`` for a valid unexpired token, else None."""
    try:
        body_text, mac_text = str(token or "").split(".", 1)
        body = _unb64(body_text)
        if not hmac.compare_digest(hmac.new(_media_key(), body, hashlib.sha256).digest(), _unb64(mac_text)):
            return None
        data = json.loads(body)
        if int(data.get("e") or 0) < (now or time.time()):
            return None
        return {"agent": str(data.get("a") or ""), "session": str(data.get("s") or ""), "ref": str(data.get("r") or "")}
    except (ValueError, TypeError, AttributeError):
        return None


def _cache_paths(agent, session, ref):
    digest = hashlib.sha256(json.dumps([agent, session, ref]).encode()).hexdigest()
    return os.path.join(MEDIA.folder, digest), os.path.join(MEDIA.folder, digest + ".type")


def cache_get(agent, session, ref):
    if not MEDIA.folder:
        return None
    path, type_path = _cache_paths(agent, session, ref)
    try:
        with open(type_path, "r", encoding="utf-8") as handle:
            ctype = handle.read().strip()[:120] or "application/octet-stream"
        os.utime(path, None)
        return path, ctype
    except OSError:
        return None


def cache_put(agent, session, ref, data, ctype, limit=MEDIA_CACHE_BYTES):
    if not MEDIA.folder:
        return None
    with MEDIA.lock:
        private_files.private_dir(MEDIA.folder)
        path, type_path = _cache_paths(agent, session, ref)
        for target, payload in ((path, data), (type_path, str(ctype or "").encode()[:120])):
            fd = os.open(target + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            private_files.adopt(fd, target)
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
            os.replace(target + ".tmp", target)
        _evict(limit)
    return path


def _evict(limit):
    entries = []
    total = 0
    for name in os.listdir(MEDIA.folder):
        if name.endswith(".type") or name.endswith(".tmp"):
            continue
        full = os.path.join(MEDIA.folder, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        entries.append((st.st_mtime, st.st_size, full))
        total += st.st_size
    for _mtime, size, full in sorted(entries):
        if total <= limit:
            break
        for target in (full, full + ".type"):
            try:
                os.unlink(target)
            except OSError:
                pass
        total -= size


_SAFE_INLINE = ("image/png", "image/jpeg", "image/gif", "image/webp", "audio/", "video/", "text/plain",
                "application/pdf")


def serve_media(handler, token, fetch):
    """Answer ``GET /api/agent-chat/media?t=``. ``fetch(agent, session, ref)`` -> (bytes, content type)."""
    grant = verify_media(token)
    if grant is None:
        handler._send_json({"ok": False, "error": "media_expired",
                            "message": "This file link has expired: reopen the chat to get a new one."}, 403)
        return True
    hit = cache_get(grant["agent"], grant["session"], grant["ref"])
    if hit is None:
        try:
            data, ctype = fetch(grant["agent"], grant["session"], grant["ref"])
        except Exception as exc:  # adapter errors carry code/status/message
            status = getattr(exc, "status", 502) or 502
            handler._send_json({"ok": False, "error": getattr(exc, "code", "media_unavailable"),
                                "message": getattr(exc, "message", "") or "The file could not be read."}, status)
            return True
        if not isinstance(data, (bytes, bytearray)) or len(data) > MEDIA_MAX_BYTES:
            handler._send_json({"ok": False, "error": "too_large",
                                "message": "This file is larger than 40 MB."}, 413)
            return True
        path = cache_put(grant["agent"], grant["session"], grant["ref"], bytes(data), ctype)
        hit = (path, ctype) if path else None
        if hit is None:
            return _send_bytes(handler, bytes(data), ctype)
    path, ctype = hit
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError:
        handler._send_json({"ok": False, "error": "media_unavailable", "message": "The file could not be read."}, 404)
        return True
    return _send_bytes(handler, data, ctype)


def _send_bytes(handler, data, ctype):
    ctype = str(ctype or "application/octet-stream")
    if not any(ctype.startswith(p) for p in _SAFE_INLINE):
        ctype_out, disposition = "application/octet-stream", "attachment"
    else:
        ctype_out, disposition = ctype, "inline"
    total = len(data)
    start, end, status = 0, total - 1, 200
    rng = str(handler.headers.get("Range") or "") if getattr(handler, "headers", None) is not None else ""
    if rng.startswith("bytes=") and total:
        try:
            first, _, last = rng[6:].split(",")[0].partition("-")
            if first:
                start = int(first)
                end = min(int(last), total - 1) if last else total - 1
            else:
                start = max(0, total - int(last))
            if start > end or start >= total:
                raise ValueError
            status = 206
        except ValueError:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{total}")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return True
    body = data[start:end + 1]
    handler.send_response(status)
    handler.send_header("Content-Type", ctype_out)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Accept-Ranges", "bytes")
    if status == 206:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{total}")
    handler.send_header("Content-Disposition", disposition)
    handler.send_header("Content-Security-Policy", "sandbox")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Cache-Control", "private, max-age=3600")
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)
    return True
