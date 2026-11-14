"""The Hermes adapter (design 2.4, phases B2 + C1): the chat over one `hermes serve` connection per Agent Providers
record, on top of its live link (hermes_link.HermesLink) and the event translator (hermes_translate.Translator).

- A chat is a Hermes stored session (its id is the chat's session key). Hermes runs a turn in a *live* session of its
  process: made with session.create (a new chat, tagged source 'virtual-office', for the agent's profile) or attached
  with session.resume (an existing one; it also brings this connection that session's events), again on every new
  socket. Events name the live id; this keeps which stored session each one is.
- A run is one message: prompt.submit. Hermes answers it at once, after the turn in progress (queued: its turn comes
  with a later message.start), or takes it into that turn (steered, redirected: its own run ends empty, the running
  turn answers it). A text-only message queued behind another of ours still waiting is merged into it by Hermes: one
  answer for both, so it ends as steered too.
- Hermes' requests (approval, clarify, secret, sudo) in a session with a run of ours become that run's cards; the
  person's answer goes back on the socket that brought the request, else through approval.respond / request.answer.
- Events go to `on_event` listeners as dicts with `type`, `connectionId`, `agentId` (the profile), `sessionKey`,
  `runId`; agent_providers.publish_event routes them to the ChatHub. A run's events wait until its run.start is out.
- Never hold `_lock` across a link call: the link's callbacks take it on the link's loop thread.
"""

from __future__ import annotations

import base64
import logging
import mimetypes
import os
import re
import threading
import time
import urllib.parse
import uuid

from providers import hermes_activity as ha
from providers import hermes_link as hl
from providers import hermes_machine as hmc
from providers import hermes_menu as hm
from providers import hermes_translate as ht

LOG = logging.getLogger("vo.hermes.adapter")

KIND = "hermes"
SOURCE = "virtual-office"
DOWN_GRACE_S = 120.0                      # a run whose connection stays down this long ends as interrupted
FILE_MAX = 25 * 1024 * 1024               # one attachment (manifest limit)
FILES_MAX = 10
MEDIA_MAX = 40 * 1024 * 1024              # one answer medium fetched from Hermes
ASKS = frozenset(ht.REQUESTS)
TURN_EVENTS = frozenset({
    "message.start", "message.delta", "message.interim", "message.complete", "reasoning.delta",
    "reasoning.available", "thinking.delta", "tool.start", "tool.generating", "tool.complete", "status.update",
    "todo.updated", "moa.reference", "error", "session.title", "session.usage", "session.info"})
IMAGE = re.compile(r"^image/(png|jpe?g|gif|webp|bmp)$", re.I)
SIGNIN_CODES = frozenset({"signin_needed", "auth_rejected", "bad_credentials", "signin_not_engaged",
                          "signin_engaged", "no_password", "rate_limited"})
CONFIRM_TEXT = "Hermes asks to confirm this model (it is expensive); choose it in Hermes first"
LOST_TEXT = "The connection to Hermes was lost"
CLOSED_TEXT = "The connection to Hermes was closed here (reconnected, switched off or changed)"
STOPPED_TEXT = "Hermes stopped before it answered (it restarted, or the turn was cut off)"
RESTARTED_TEXT = "Hermes restarted before this message was answered"
GONE_TEXT = "Hermes does not have this chat any more"
RECONNECTING_TEXT = "The connection to Hermes was lost; reconnecting..."
# (a stored answer row whose finish_reason says the turn did not finish; Hermes' exit flush stores a cut answer with none)
CUT_REASONS = {"interrupted", "interrupt", "cancelled", "canceled", "aborted", "error", "timeout"}
WATCH_S = 150.0                           # a page's watch lease (renewed every minute while the chat is open)
WATCH_MAX_S = 600.0
QUIET_S = 600.0                           # an observed turn silent this long is let go
APPROVAL_OPTIONS = ["allow-once", "allow-session", "allow-always", "deny"]


def fail(code: str, message: str, fix: str | None = None, status: int | None = None) -> hl.HermesError:
    """A refusal the routes turn into `{ok:false, error, message, fix}` with `status`."""
    err = hl.HermesError(code, message, fix)
    if status:
        err.status = status
    return err


def _now() -> float:
    return time.monotonic()


def _who(ref) -> tuple[str, str, str]:
    """(connection id, profile, office agent id) of an agent_providers.AgentRef (or any object with those)."""
    profile = str(getattr(ref, "profile", None) or getattr(ref, "native", None) or ref or "")
    cid = str(getattr(ref, "cid", "") or "")
    if not cid:
        raise fail("bad_request", "Which connection?", status=400)
    if not profile:
        raise fail("bad_request", "Which agent?", status=400)
    return cid, profile, str(getattr(ref, "office_id", "") or profile)


class _Run:
    def __init__(self, run_id: str, key: str, profile: str, files: bool):
        self.id, self.key, self.profile, self.files = run_id, key, profile, files
        self.tr = ht.Translator(run_id)
        self.started = self.ended = self.announced = False
        self.buf: list[dict] = []          # its events made before its run.start went out
        self.approvals: dict[str, str] = {}   # approval id -> Hermes' request id
        self.user_row = None               # Hermes' stored row of the person's message (prompt.submit user_row_id)
        self.observed = False              # a turn started in Hermes itself (Desktop, dashboard), followed here
        self.at = 0.0                      # (observed) when Hermes last said something about it
        self.restarts = 0                  # the link's count of Hermes restarts when this run began
        self.before_down = ""              # its status line before "reconnecting" (shown again when Hermes is back)


class _Conn:
    """One connection's link and its chats' state."""

    def __init__(self, cid: str):
        self.cid = cid
        self.link = None
        self.live: dict[str, dict] = {}       # stored key -> {sid, profile, gen}
        self.by_live: dict[str, str] = {}     # live id -> stored key
        self.runs: dict[str, _Run] = {}
        self.turns: dict[str, list] = {}      # stored key -> run ids, in the order Hermes answers them
        self.asks: dict[str, dict] = {}       # Hermes' request id -> {id, runId, method, params, gen, sid, card}
        self.prefs: dict[str, dict] = {}      # stored key -> {model, effort} as applied on Hermes
        self.pending: dict[str, dict] = {}    # profile -> {model, effort} kept for its next new chat
        self.todos: dict[str, dict] = {}      # stored key -> {steps, revision}
        self.usage: dict[str, dict] = {}      # stored key -> {used, size}
        self.titles: dict[str, str] = {}
        self.renamed: dict[str, str] = {}     # stored key -> the id Hermes continued it under (a compaction)
        self.down_timer = None
        self.screen = None                    # hermes_machine.Screen of the current link (its viewer ids)
        self.watched: dict[str, dict] = {}    # stored key -> {profile, until}: chats a page has open
        self.foreign: dict[str, _Run] = {}    # stored key -> the observed turn followed there
        self.presence = None                  # hermes_activity.Presence (agents working, whatever started it)
        self.tasks = None                     # hermes_activity.Tasks (subagents and scheduled jobs)


class HermesAdapter:
    """The adapter call set (design 2.4) for every `hermes serve` connection. `state` is agent_providers.STATE (its
    connection records and secret store); tests pass `connection(cid) -> record`, `secrets(cid) -> dict` and
    `persist(cid, field, value)` instead."""

    kind = KIND

    def __init__(self, state=None, *, connection=None, secrets=None, persist=None, link_factory=None,
                 media_url=None, down_grace: float = DOWN_GRACE_S):
        self._state = state
        self._connection = connection or self._record
        self._secrets = secrets or self._stored_secrets
        self._persist = persist or self._store_secret
        self._link_factory = link_factory or hl.HermesLink
        self._media_url = media_url
        self.down_grace = down_grace
        self._lock = threading.RLock()
        self._emit_lock = threading.RLock()
        self._conns: dict[str, _Conn] = {}
        self._listeners: list = []

    # ------------------------------------------------------------------ the office's records
    def _ap_state(self):
        if self._state is not None:
            return self._state
        import agent_providers
        return agent_providers.STATE

    def _record(self, cid):
        try:
            import agent_providers
            return agent_providers.find_connection(cid)
        except Exception:  # noqa: BLE001 - no store (yet): no connection
            return None

    def _stored_secrets(self, cid) -> dict:
        store = getattr(self._ap_state(), "secrets", None)
        if store is None:
            return {}
        return {f: v for f in ("token", "password", "tokens") if (v := store.get(KIND, cid, f))}

    def _store_secret(self, cid, field, value) -> None:
        store = getattr(self._ap_state(), "secrets", None)
        if store is not None:
            store.set(KIND, cid, field, value)

    def _sign(self, office_id: str, key: str, ref: str) -> str:
        if self._media_url:
            return self._media_url(office_id, key, ref)
        import provider_hub
        return provider_hub.media_url(office_id, key, ref)

    # ------------------------------------------------------------------ events out
    def on_event(self, callback):
        with self._lock:
            self._listeners.append(callback)

        def off():
            with self._lock:
                if callback in self._listeners:
                    self._listeners.remove(callback)
        return off

    def _send(self, events) -> None:
        if not events:
            return
        with self._emit_lock:
            for e in events:
                for cb in list(self._listeners):
                    try:
                        cb(e)
                    except Exception:  # noqa: BLE001 - one bad listener never stops the rest
                        LOG.exception("hermes adapter listener failed")

    def _wrap(self, c: _Conn, r: _Run, e: dict) -> dict:
        e = dict(e)
        if e.get("type") == "native":
            ev = e.pop("ev", None) or {}
            e["op"] = str(ev.get("op") or "")
            if e["op"] == "title":
                e["title"] = e["text"] = str(ev.get("text") or "")
            elif ev.get("text") is not None:
                e["text"] = str(ev.get("text"))
        if isinstance(e.get("media"), list):
            e["media"] = [m for m in (self._medium(x) for x in e["media"]) if m]
        e.update(kind=KIND, connectionId=c.cid, agentId=r.profile, sessionKey=r.key, runId=r.id)
        if r.observed:
            e["observed"] = True
        return e

    @staticmethod
    def _medium(m) -> dict | None:
        """A translator media item {kind, name, ref:{source}} as the hub's: a local file keeps `ref` (the hub signs an
        office link for it), a remote image is its own `url`."""
        if not isinstance(m, dict):
            return None
        src = str((m.get("ref") or {}).get("source") or "") if isinstance(m.get("ref"), dict) else str(m.get("ref") or "")
        if not src:
            return None
        out = {"kind": str(m.get("kind") or "file"), "name": str(m.get("name") or "attachment")}
        mime = mimetypes.guess_type(out["name"])[0]
        if mime:
            out["mime"] = mime
        if re.match(r"^https?://", src, re.I):
            out["url"] = src
        else:
            out["ref"] = src
        return out

    def _out(self, c: _Conn, r: _Run, events) -> list:
        """(under _lock) A run's universal events made ready to send; held while its run.start is not out yet."""
        ready = []
        for e in events or []:
            t = e.get("type")
            if t == "usage.update":
                c.usage[r.key] = {k: e[k] for k in ("used", "size") if k in e}
            elif t == "native" and (e.get("ev") or {}).get("op") == "title":
                c.titles[r.key] = str(e["ev"].get("text") or "")[:200]
            ready.append(self._wrap(c, r, e))
            if t == "run.end":
                self._finish(c, r)
        if not r.announced:
            r.buf.extend(ready)
            return []
        return ready

    def _announce(self, c: _Conn, r: _Run, events) -> None:
        """A run's first events (run.start), then what it made meanwhile, in order."""
        with self._emit_lock:
            with self._lock:
                first = [self._wrap(c, r, e) for e in events]
                r.announced = True
                held, r.buf = r.buf, []
                for e in first:
                    if e.get("type") == "run.end":
                        self._finish(c, r)
            self._send(first + held)

    def _finish(self, c: _Conn, r: _Run) -> None:
        r.ended = True
        for rid in [k for k, a in c.asks.items() if a["runId"] == r.id]:
            c.asks.pop(rid, None)
        c.runs.pop(r.id, None)
        if c.foreign.get(r.key) is r:
            c.foreign.pop(r.key, None)
        rest = [x for x in c.turns.get(r.key, []) if x != r.id]
        if rest:
            c.turns[r.key] = rest
        else:
            c.turns.pop(r.key, None)

    def _interrupt(self, c: _Conn, why: str, key: str | None = None) -> list:
        """(under _lock) Every open run (of one chat) ends as interrupted, with why."""
        out = []
        for r in [x for x in list(c.runs.values()) + list(c.foreign.values())
                  if not x.ended and (key is None or x.key == key)]:
            out += self._out(c, r, r.tr.interrupt(why))
        return out

    # ------------------------------------------------------------------ the link
    def _conn(self, cid) -> _Conn:
        """The connection's state with its link (made and started on first use)."""
        cid = str(cid or "")
        record = self._connection(cid)
        if not isinstance(record, dict):
            raise fail("not_found", "That Hermes connection does not exist any more.", status=404)
        if record.get("enabled") is False:
            raise fail("offline", "This Hermes connection is switched off.", "Open Agent Providers and switch it on.",
                       status=503)
        start = None
        with self._lock:
            c = self._conns.get(cid)
            if c is None:
                c = self._conns[cid] = _Conn(cid)
            if c.link is None:
                c.link = start = self._new_link(c, record)
        if start is not None:
            start.start()
        return c

    @staticmethod
    def _config(record: dict) -> dict:
        return {"url": record.get("url") or "", "auth": record.get("auth") or "token",
                "username": record.get("username") or ""}

    def _new_link(self, c: _Conn, record: dict):
        link = self._link_factory(c.cid, self._config(record), self._secrets(c.cid) or {}, self._persist)
        link.on_event(lambda evt, c=c: self._on_event(c, evt))
        link.on_request(lambda rq, c=c: self._on_request(c, rq))
        link.on_status(lambda evt: self._send([evt]))
        link.on_ready(lambda c=c: self._on_ready(c))
        link.on_down(lambda c=c: self._on_down(c))
        if c.presence is not None:
            c.presence.close()
        c.presence = ha.Presence(c.cid, link, self._send)
        c.tasks = c.tasks or ha.Tasks(c.cid, self._send)
        return link

    def _on_ready(self, c: _Conn) -> None:
        """Connected (again): open runs are reattached to their sessions (nothing lost, nothing twice); the chats pages
        have open are followed again; the agents' presence is read. (The link's loop thread: the work runs on its own.)"""
        with self._lock:
            if c.down_timer:
                c.down_timer.cancel()
                c.down_timer = None
            keys = {r.key for r in list(c.runs.values()) + list(c.foreign.values()) if not r.ended}
            now = _now()
            watched = [k for k, w in c.watched.items() if w["until"] > now and k not in keys]
            link = c.link
        if keys or watched:
            threading.Thread(target=self._after_ready, args=(c, link, sorted(keys), watched),
                             name="hermes-reattach", daemon=True).start()
        if c.presence is not None:
            c.presence.on_ready()

    def _after_ready(self, c: _Conn, link, keys: list, watched: list) -> None:
        for key in keys:
            if c.link is not link:
                return
            try:
                self._reattach(c, key)
            except hl.HermesError as e:
                if e.code in ("offline", "not_connected", "unreachable") or not link.connected:
                    continue     # (down again: its grace starts over)
                LOG.info("hermes reattach failed: %s", e.code)
                with self._lock:
                    out = self._interrupt(c, LOST_TEXT, key)
                self._send(out)
            except Exception:  # noqa: BLE001
                LOG.exception("hermes reattach failed")
        for key in watched:
            with self._lock:
                w = c.watched.get(key)
            if w is None or c.link is not link:
                continue
            try:
                self._live_for(c, key, w["profile"])
            except Exception:  # noqa: BLE001 - the page's next watch call tries again
                pass

    def _reattach(self, c: _Conn, key: str) -> None:
        """As Hermes' own client after a reconnect: the session attached again (its live events wait), every event
        missed while the socket was down fetched again and delivered in order, then the waiting ones. Still answering:
        its open questions are asked again. Ended meanwhile: finished from the stored answer after the person's row;
        none there (Hermes restarted, a new replay epoch): interrupted."""
        with self._lock:
            runs = [c.runs[x] for x in c.turns.get(key, []) if x in c.runs and not c.runs[x].ended]
            foreign = c.foreign.get(key)
            if foreign is not None and foreign.ended:
                foreign = None
            if not runs and foreign is None:
                return
            profile = (runs[0] if runs else foreign).profile
            old = (c.live.get(key) or {}).get("sid")
            stored = c.renamed.get(key) or key
        link = c.link
        held = bool(old) and link.can_replay(old)
        if held:
            link.hold_for(old)
        try:
            r = link.call("session.resume", {"session_id": stored, "profile": profile, "lazy": True,
                                             "omit_messages": True})
        except hl.HermesError as e:
            if held:
                link.release(old)
            if e.rpc_code == 4001:
                with self._lock:
                    out = self._interrupt(c, GONE_TEXT, key)
                self._send(out)
                return
            raise
        r = r if isinstance(r, dict) else {}
        sid = str(r.get("session_id") or "")
        if sid:
            with self._lock:
                self._bind(c, key, sid, profile)
        rp = None
        if held:
            if sid == old:
                rp = link.replay(old)
            else:
                link.release(old)
        if r.get("running"):
            with self._lock:
                back = []
                for x in runs + ([foreign] if foreign is not None else []):
                    if x.started and not x.ended:
                        back += self._out(c, x, x.tr.status(x.before_down or "Thinking"))
            self._send(back)
            asks = {}
            for q in (r.get("open_requests") if isinstance(r.get("open_requests"), list) else []) + \
                    ((rp or {}).get("open") or []):
                if isinstance(q, dict) and q.get("id") is not None:
                    asks[str(q["id"])] = q
            for q in asks.values():
                # (asked on a socket that is gone: the answer goes back through approval.respond / request.answer)
                self._on_request(c, {"id": q["id"], "method": q.get("method"),
                                     "params": q.get("params") if isinstance(q.get("params"), dict) else {},
                                     "generation": -1})
            return
        with self._lock:
            runs = [x for x in runs if not x.ended]
            foreign = foreign if foreign is not None and not foreign.ended else None
            head = next((x for x in runs if x.started), runs[0] if runs else None)
        out = []
        if foreign is not None:
            with self._lock:
                out += self._out(c, foreign, foreign.tr.interrupt(STOPPED_TEXT))
        if head is not None:
            ans = self._stored_answer(c, stored, profile, head.user_row,
                                      restarted=link.restarts > head.restarts)
            with self._lock:
                if not head.ended:
                    if ans:
                        out += self._out(c, head, head.tr.feed(
                            {"type": "message.complete", "payload": {"text": ans, "status": "complete"}}))
                    else:
                        out += self._out(c, head, head.tr.interrupt(STOPPED_TEXT))
                for x in runs:
                    if x is not head and not x.ended:
                        out += self._out(c, x, x.tr.interrupt(RESTARTED_TEXT))
        self._send(out)

    def _stored_answer(self, c: _Conn, stored: str, profile: str, user_row, restarted: bool = False) -> str:
        """The answer Hermes stored after the person's message (its own row): never an earlier one. An answer Hermes
        did not finish is no answer: Hermes' exit flush stores a turn cut by its restart as it was, with no
        finish_reason (a finished one says e.g. "stop"); after a restart a row that does not say it finished counts
        as cut too. Then the run ends interrupted (S§2.8), not as a complete answer."""
        if not isinstance(user_row, int) or isinstance(user_row, bool):
            return ""
        try:
            raw = c.link.rest("GET", f"/api/sessions/{_quote(stored)}/messages", profile=profile)
        except hl.HermesError:
            return ""
        rows = [m for m in (raw or {}).get("messages") or [] if isinstance(m, dict)
                and isinstance(m.get("id"), int) and m["id"] > user_row]
        last = next((m for m in reversed(rows) if m.get("role") == "assistant"), None)
        if last is not None:
            fr = last.get("finish_reason")
            if (isinstance(fr, str) and fr.strip().lower() in CUT_REASONS) or \
                    (not fr and ("finish_reason" in last or restarted)):
                return ""
        ans = [m for m in ht.history_to_messages(rows) if m.get("role") == "assistant"]
        if not ans:
            return ""
        media = (ans[-1].get("meta") or {}).get("media") or []
        lines = [f"MEDIA:{s}" for m in media if isinstance(m, dict) and (s := self._source_of(m))]
        return "\n".join([str(ans[-1].get("text") or "")] + lines).strip()

    @staticmethod
    def _source_of(m: dict) -> str:
        ref = m.get("ref")
        return str((ref.get("source") if isinstance(ref, dict) else ref) or m.get("url") or "")

    def _on_down(self, c: _Conn) -> None:
        """A run whose connection stays down past the grace ends as interrupted (a reconnect before reattaches it)."""
        if c.presence is not None:
            c.presence.on_down()
        if c.tasks is not None:
            c.tasks.on_down()
        with self._lock:
            # (the open chat shows it on the answer that waits: "reconnecting", until Hermes is back or the grace ends)
            out = []
            for r in list(c.runs.values()) + list(c.foreign.values()):
                if r.started and not r.ended:
                    if r.tr.last_phase != RECONNECTING_TEXT:
                        r.before_down = r.tr.last_phase or ""
                    out += self._out(c, r, r.tr.status(RECONNECTING_TEXT))
        self._send(out)
        with self._lock:
            if c.down_timer or not any(not r.ended for r in list(c.runs.values()) + list(c.foreign.values())):
                return

            def expire():
                with self._lock:
                    c.down_timer = None
                    if c.link is not None and c.link.connected:
                        return
                    out = self._interrupt(c, LOST_TEXT)
                self._send(out)
            c.down_timer = threading.Timer(self.down_grace, expire)
            c.down_timer.daemon = True
            c.down_timer.start()

    def status(self, cid) -> dict:
        try:
            c = self._conn(cid)
        except hl.HermesError as e:
            return {"state": "offline", "code": e.code, "detail": e.detail, "fix": e.fix or "", "version": ""}
        s = c.link.status()
        return {"state": s.get("state") or "offline", "code": s.get("code") or "", "detail": s.get("detail") or "",
                "fix": s.get("fix") or "", "version": s.get("version") or ""}

    def reload(self, cid) -> None:
        """The connection's record changed (saved, switched on/off): the link follows it; a new address or credential
        ends the chats' open runs (their socket is gone)."""
        cid = str(cid or "")
        record = self._connection(cid)
        if not isinstance(record, dict) or record.get("enabled") is False:
            self.close(cid, CLOSED_TEXT)
            return
        with self._lock:
            c = self._conns.get(cid)
        if c is None or c.link is None:
            self._conn(cid)
            return
        config, secrets = self._config(record), self._secrets(cid) or {}
        if hl.link_key(config, secrets) == c.link.key and c.link.active:
            return
        with self._lock:
            out = self._interrupt(c, "The Hermes connection was changed")
        self._send(out)
        c.link.configure(config, secrets)

    def reconnect(self, cid) -> None:
        self.close(cid, CLOSED_TEXT)
        try:
            self._conn(cid)
        except hl.HermesError:
            pass

    def close(self, cid, reason: str = "") -> None:
        """The connection is closed for good here: every answer still being written ends now, with why."""
        with self._lock:
            c = self._conns.pop(str(cid or ""), None)
            if c is None:
                return None
            if c.down_timer:
                c.down_timer.cancel()
            out = self._interrupt(c, reason or CLOSED_TEXT)
            c.watched.clear()
        self._send(out)
        if c.presence is not None:
            c.presence.close()
        if c.tasks is not None:
            c.tasks.on_down()
        if c.link is not None:
            try:
                c.link.close(reason or None)
            except Exception:  # noqa: BLE001
                LOG.exception("hermes link close failed")
        return None

    def test(self, values: dict) -> dict:
        """Tries settings without saving anything: a link of its own, closed after."""
        values = values or {}
        config = {"url": values.get("url") or "", "auth": values.get("auth") or "token",
                  "username": values.get("username") or ""}
        secrets = {k: values[k] for k in ("token", "password") if values.get(k)}
        link = self._link_factory("test-" + uuid.uuid4().hex[:8], config, secrets, None)
        try:
            link.start()
            s = link.settle()
            if s.get("state") != "connected":
                return {"ok": False, "state": s.get("state") or "offline", "code": s.get("code") or "unreachable",
                        "detail": s.get("detail") or "Not connected", "fix": s.get("fix") or ""}
            out = {"ok": True, "state": "connected", "detail": s.get("detail") or "", "version": s.get("version") or ""}
            try:
                r = link.call("profiles.list", {}, timeout=10)
                out["profiles"] = [x["name"] for x in (r or {}).get("profiles") or []
                                   if isinstance(x, dict) and isinstance(x.get("name"), str) and x.get("role") != "setup"]
            except hl.HermesError:
                pass
            return out
        finally:
            link.close("test done")

    # ------------------------------------------------------------------ agents and sessions
    def agents(self, cid) -> list:
        """Hermes' profiles (minus setup ones) as the office's agents."""
        c = self._conn(cid)
        r = c.link.call("profiles.list", {}, timeout=15)
        out = []
        for x in (r or {}).get("profiles") or []:
            if not isinstance(x, dict) or not isinstance(x.get("name"), str) or not x["name"] or x.get("role") == "setup":
                continue
            meta = x.get("ui_meta") if isinstance(x.get("ui_meta"), dict) else {}
            out.append({"profile": x["name"][:120], "displayName": str(x.get("display_name") or x["name"])[:60],
                        "emoji": str(meta.get("emoji") or meta.get("avatar_emoji") or "")[:32],
                        "role": x["role"] if isinstance(x.get("role"), str) else "",
                        "model": str(x.get("model") or ""), "default": bool(x.get("is_default"))})
        return out[:200]

    def can(self, ref, session=None, *, manage: bool = False) -> dict:
        """The chat window's manifest (design 4.1, hermes-serve column), per the connection's access level, as the
        routes serve it: files = any file attached to a message (file.attach; pictures through image.attach_bytes);
        computer = the side panel's Files tab reads (list/read at both levels); computerWrite (upload, new folder,
        delete) and screen (the Bot Desktop) with Full access only. Under Chat only those two are off and `locked`
        carries their 3.6 texts, so the side panel shows the Screen tab and the Files writes locked with the reason."""
        cid, profile, _office = _who(ref)
        s = self.status(cid)
        if s["state"] not in ("connected", "connecting"):
            return {"ok": False, "reason": "signin" if s["code"] in SIGNIN_CODES else "offline",
                    "message": s["detail"] or "Hermes is not connected.", "fix": s["fix"]}
        c = self._conn(cid)
        full = self._access(cid) == "full"
        caps = {"stream": True, "sessions": True, "sessionCreate": True, "sessionRename": True,
                "sessionDelete": bool(manage), "history": True, "stop": True, "models": True, "effort": True,
                "context": True, "attachments": True, "files": True, "approvals": True,
                "approvalOptions": list(APPROVAL_OPTIONS), "questions": True, "secrets": True, "plan": True,
                "progressCard": False, "tasks": True, "taskSteer": True, "queue": "redirect", "observe": True,
                "presence": True, "titles": True, "media": True, "browser": False, "screen": full,
                "computer": True, "computerWrite": full}
        locked = {} if full else {"screen": hmc.Screen.unavailable()["reason"],
                                  "computerWrite": hm.chat_only("files").detail}
        return {"ok": True, "view": "hermes", "caps": caps, "locked": locked,
                "limits": {"attachmentBytes": FILE_MAX, "maxFiles": FILES_MAX},
                "prefs": self._prefs_of(c, profile, session)}

    def _prefs_of(self, c: _Conn, profile: str, key) -> dict:
        with self._lock:
            p = c.prefs.get(key) if key else c.pending.get(profile)
            return {"model": (p or {}).get("model"), "effort": (p or {}).get("effort")}

    def sessions(self, ref) -> dict:
        """The agent's stored sessions on Hermes, newest first, from every channel but its scheduled jobs."""
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        r = c.link.rest("GET", "/api/sessions", profile=profile, query={"limit": 100})
        rows = [s for s in (r or {}).get("sessions") or [] if isinstance(s, dict) and s.get("id")
                and s.get("source") != "cron" and not s.get("parent_session_id") and not s.get("hidden")
                and not s.get("archived")]
        return {"sessions": [ht.session_of(s) for s in rows]}

    def session_op(self, ref, op: str, key: str, args: dict | None = None) -> dict:
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        args = args or {}
        if op == "create":
            key, _sid = self._create(c, profile)
            return {"ok": True, "session": {"key": key}}
        if not key:
            raise fail("invalid", "This chat is not on Hermes yet.", status=400)
        stored = c.renamed.get(key) or key
        path = "/api/sessions/" + _quote(stored)
        if op == "rename":
            title = str(args.get("title") or "")[:200]
            c.link.rest("PATCH", path, {"title": title}, profile=profile)
            with self._lock:
                c.titles[key] = title
            self._send([{"type": "native", "op": "title", "title": title, "text": title, "kind": KIND,
                         "connectionId": c.cid, "agentId": profile, "sessionKey": key}])
            return {"ok": True}
        if op == "delete":
            with self._lock:
                live = c.live.pop(key, None)
                if live:
                    c.by_live.pop(live["sid"], None)
                out = self._interrupt(c, "The chat was deleted", key)
            self._send(out)
            # (Hermes refuses to delete a session live in its process: closed first)
            if live and live["gen"] == c.link.gen:
                try:
                    c.link.call("session.close", {"session_id": live["sid"], "profile": profile}, timeout=15)
                except hl.HermesError:
                    pass
            if live:
                c.link.forget(live["sid"])
            c.link.rest("DELETE", path, profile=profile)
            with self._lock:
                for m in (c.prefs, c.todos, c.renamed, c.usage, c.titles):
                    m.pop(key, None)
            return {"ok": True}
        raise fail("unsupported", "Hermes does not take that chat change here.", status=400)

    def _bind(self, c: _Conn, key: str, sid: str, profile: str) -> None:
        old = c.live.get(key)
        if old:
            c.by_live.pop(old["sid"], None)
        c.live[key] = {"sid": sid, "profile": profile, "gen": c.link.gen}
        c.by_live[sid] = key

    def _create(self, c: _Conn, profile: str) -> tuple[str, str]:
        """A new Hermes session for the profile, with the prefs kept for its first message."""
        with self._lock:
            want = dict(c.pending.pop(profile, None) or {})
        params = {"profile": profile, "source": SOURCE}
        m = ht.parse_model_ref(want["model"]) if want.get("model") else None
        if m and m["model"]:
            params["model"] = m["model"]
            if m["provider"]:
                params["provider"] = m["provider"]
        if want.get("effort"):
            params["reasoning_effort"] = str(want["effort"])
        r = c.link.call("session.create", params)
        if not isinstance(r, dict) or not r.get("session_id") or not r.get("stored_session_id"):
            raise fail("provider_error", "Hermes did not make the session")
        key, sid = str(r["stored_session_id"]), str(r["session_id"])
        with self._lock:
            self._bind(c, key, sid, profile)
            c.prefs[key] = {"model": want.get("model"), "effort": want.get("effort")}
        return key, sid

    def _live_for(self, c: _Conn, key: str, profile: str) -> str:
        """The live session for a stored one (attached once per socket: session.resume)."""
        with self._lock:
            have = c.live.get(key)
            if have and have["gen"] == c.link.gen:
                return have["sid"]
            stored = c.renamed.get(key) or key
        try:
            r = c.link.call("session.resume", {"session_id": stored, "profile": profile, "lazy": True,
                                               "omit_messages": True})
        except hl.HermesError as e:
            if e.rpc_code == 4001:
                raise fail("not_found", "Hermes does not have this chat any more.", "Start a new chat.",
                           status=404) from None
            raise
        if not isinstance(r, dict) or not r.get("session_id"):
            raise fail("provider_error", "Hermes did not open the session")
        sid = str(r["session_id"])
        with self._lock:
            self._bind(c, key, sid, profile)
            todo = r.get("todo_state")
            if isinstance(todo, dict) and isinstance(todo.get("todos"), list):
                c.todos[key] = {"steps": ht.steps_of(todo["todos"]), "revision": todo.get("revision")}
        return sid

    # ------------------------------------------------------------------ history, models, prefs
    def history(self, ref, key, before=None) -> dict:
        cid, profile, office = _who(ref)
        if not key:
            return {"messages": [], "authoritative": True}
        c = self._conn(cid)
        stored = c.renamed.get(key) or key
        try:
            h = c.link.rest("GET", f"/api/sessions/{_quote(stored)}/messages", profile=profile)
        except hl.HermesError as e:
            if e.code != "not_found" or stored == key:
                raise
            with self._lock:
                c.renamed.pop(key, None)
            stored = key
            h = c.link.rest("GET", f"/api/sessions/{_quote(stored)}/messages", profile=profile)
        try:
            row = c.link.rest("GET", f"/api/sessions/{_quote(stored)}", profile=profile)
        except hl.HermesError:
            row = None
        rows = (h or {}).get("messages") if isinstance((h or {}).get("messages"), list) else []
        with self._lock:
            running = any(not c.runs[x].ended for x in c.turns.get(key, []) if x in c.runs)
        live_rows = None
        if ht.needs_live_rows(rows, running):
            # (a turn stopped or redirected part-way is stored hidden and empty: Hermes' live transcript has it)
            try:
                sid = self._live_for(c, key, profile)
                g = c.link.call("session.history", {"session_id": sid, "profile": profile}, timeout=20)
                live_rows = (g or {}).get("messages") if isinstance(g, dict) else None
            except hl.HermesError:
                live_rows = None
        messages = [self._flat(office, key, m) for m in ht.history_to_messages(rows, live_rows)]
        s = row.get("session") if isinstance(row, dict) and isinstance(row.get("session"), dict) else row
        prefs = self._prefs_of(c, profile, key)
        out = {"messages": messages, "authoritative": True, "running": running,
               "session": {"model": prefs["model"] or ((s or {}).get("model") or None), "effort": prefs["effort"]},
               "planCan": {"refresh": False, "dismiss": False}}
        with self._lock:
            if c.usage.get(key):
                out["usage"] = dict(c.usage[key])
            todo = c.todos.get(key)
        if todo and todo.get("steps"):
            out["plan"] = {"title": "Tasks", "steps": todo["steps"]}
            if isinstance(todo.get("revision"), int):
                out["plan"]["revision"] = todo["revision"]
        return out

    def _flat(self, office: str, key: str, m: dict) -> dict:
        """A translated history message as chat.js reads a Hermes one: text, thinking, tools, media (signed links)."""
        meta = m.get("meta") if isinstance(m.get("meta"), dict) else {}
        out = {"role": m.get("role"), "text": m.get("text") or "", "ts": m.get("ts")}
        if meta.get("thinking"):
            out["thinking"] = meta["thinking"]
        tools = []
        for s in meta.get("steps") or []:
            ok = s.get("ok", True) is not False
            tool = {"id": s.get("id") or "", "name": s.get("name") or "tool", "title": s.get("title") or "",
                    "status": "done" if ok else "error", "input": s.get("input") or "", "output": s.get("output") or ""}
            if "exitCode" in s:
                tool["exitCode"] = s["exitCode"]
            tools.append(tool)
        if tools:
            out["tools"] = tools
        media = []
        for item in meta.get("media") or []:
            x = self._medium(item)
            if x and not x.get("url"):
                x["url"] = self._sign(office, key, x.pop("ref"))
            if x:
                media.append(x)
        if media:
            out["media"] = media
        if meta:
            out["meta"] = {k: v for k, v in meta.items() if k in ("row", "skill", "upto", "system")}
        return out

    def models(self, ref, key=None) -> dict:
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        params = {"profile": profile}
        with self._lock:
            live = c.live.get(key) if key else None
            if live and live["gen"] == c.link.gen:
                params["session_id"] = live["sid"]
        picker = ht.models_to_picker(c.link.call("model.options", params, timeout=45))
        prefs = self._prefs_of(c, profile, key)
        return {"models": picker["models"], "default": picker["default"],
                "current": prefs["model"] or picker["default"], "effort": prefs["effort"]}

    def set_prefs(self, ref, key, model=None, effort=None) -> dict:
        """The chat's model and thinking level as its session's own on Hermes (`--session`), never the profile's
        default; a chat not on Hermes yet keeps them for its first message."""
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        model = str(model).strip() if model else None
        effort = str(effort).strip() if effort else None
        if not key:
            with self._lock:
                p = c.pending.setdefault(profile, {})
                if model:
                    p["model"] = model
                if effort:
                    p["effort"] = effort
                return {"ok": True, "model": p.get("model"), "effort": p.get("effort")}
        sid = self._live_for(c, key, profile)
        with self._lock:
            last = dict(c.prefs.get(key) or {})
        if model and model != last.get("model"):
            m = ht.parse_model_ref(model)
            value = f"{m['model']}{' --provider ' + m['provider'] if m['provider'] else ''} --session"
            r = c.link.call("config.set", {"session_id": sid, "profile": profile, "key": "model", "value": value})
            if isinstance(r, dict) and r.get("confirm_required"):
                raise fail("confirm_required", str(r.get("confirm_message") or CONFIRM_TEXT)[:300], status=409)
            last["model"] = model
        if effort and effort != last.get("effort"):
            c.link.call("config.set", {"session_id": sid, "profile": profile, "key": "reasoning", "value": effort})
            last["effort"] = effort
        with self._lock:
            c.prefs[key] = {"model": last.get("model"), "effort": last.get("effort")}
        return {"ok": True, "model": last.get("model"), "effort": last.get("effort")}

    # ------------------------------------------------------------------ runs
    def run(self, ref, key, text, files=None, queue=None) -> dict:
        """Sends the person's message as a turn of the chat's session (a new chat: a new Hermes session)."""
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        files = list(files or [])[:FILES_MAX]
        text = str(text or "")
        if key:
            sid = self._live_for(c, key, profile)
        else:
            key, sid = self._create(c, profile)
        run_id = "hr-" + uuid.uuid4().hex[:16]
        with self._lock:
            busy = any(not c.runs[x].ended for x in c.turns.get(key, []) if x in c.runs)
            r = _Run(run_id, key, profile, bool(files))
            r.restarts = c.link.restarts if c.link is not None else 0
            c.runs[run_id] = r
            c.turns.setdefault(key, []).append(run_id)
        try:
            body = self._attach(c, sid, profile, files, text)
            sent = None
            # (Enter while a turn runs, as Hermes Desktop: redirect it at a safe point; a message with files waits)
            if busy and queue == "redirect" and not files and body.strip():
                try:
                    sent = c.link.call("session.redirect", {"session_id": sid, "profile": profile, "text": body})
                except hl.HermesError as e:
                    if e.rpc_code != 4010:
                        raise
                if not isinstance(sent, dict) or sent.get("status") == "rejected":
                    sent = None
            if sent is None:
                params = {"session_id": sid, "profile": profile, "text": body}
                if busy and (queue in ("later", "followup") or files):
                    params["queued"] = True
                sent = c.link.call("prompt.submit", params)
        except Exception:
            with self._lock:
                self._finish(c, r)
            raise
        st = sent.get("status") if isinstance(sent, dict) else None
        row = sent.get("user_row_id") if isinstance(sent, dict) else None
        if isinstance(row, int) and not isinstance(row, bool):
            r.user_row = row
        prefs = self._prefs_of(c, profile, key)
        start = {"type": "run.start", "model": prefs["model"] or "", "effort": prefs["effort"] or ""}
        with self._lock:
            steered = None
            if st in ("steered", "redirected"):
                steered = st
                if st == "redirected":
                    # (what the turn wrote so far is a section of its own: the person's words come after it)
                    cur = next((c.runs[x] for x in c.turns.get(key, []) if x in c.runs and x != run_id
                                and c.runs[x].started and not c.runs[x].ended), None)
                    if cur:
                        cur.tr.seal()
            elif st == "queued" and not files and any(
                    x != run_id and x in c.runs and not c.runs[x].ended and not c.runs[x].started
                    and not c.runs[x].files for x in c.turns.get(key, [])):
                steered = "steered"   # (Hermes merged it into the message of ours already waiting: one answer)
            if steered:
                r.tr.ended = True
            elif st != "queued" and not busy:
                r.started = True
            queued = not steered and not r.started
        if steered:
            self._announce(c, r, ht.steered_events())
            return {"runId": run_id, "session": {"key": key}, "status": steered}
        if queued:
            start["status"] = "queued"
        self._announce(c, r, [start])
        return {"runId": run_id, "session": {"key": key}, "status": "queued" if queued else "started"}

    def _attach(self, c: _Conn, sid: str, profile: str, files: list, text: str) -> str:
        """The person's files as Hermes takes them from a remote client: pictures queued for the turn
        (image.attach_bytes), other files staged into the session's workspace (file.attach) with their reference."""
        refs = []
        for f in files:
            path, name = str(f.get("path") or ""), os.path.basename(str(f.get("name") or f.get("path") or "file"))
            mime = str(f.get("mime") or mimetypes.guess_type(name)[0] or "application/octet-stream")
            try:
                if os.path.getsize(path) > FILE_MAX:
                    raise fail("too_large", f"{name} is larger than 25 MB.", status=413)
                with open(path, "rb") as handle:
                    data = handle.read(FILE_MAX + 1)
            except OSError:
                raise fail("invalid", "An attached file is no longer on the office server: attach it again.",
                           status=400) from None
            b64 = base64.b64encode(data).decode("ascii")
            if IMAGE.match(mime):
                ext = os.path.splitext(name)[1].lstrip(".") or None
                params = {"session_id": sid, "profile": profile, "content_base64": b64, "filename": name}
                if ext:
                    params["ext"] = ext
                r = c.link.call("image.attach_bytes", params, timeout=60)
                if isinstance(r, dict) and r.get("attached") is False:
                    raise fail("attachment_refused", f"Hermes did not take {name}"
                               + (f": {r.get('message')}" if r.get("message") else ""), status=400)
            else:
                r = c.link.call("file.attach", {"session_id": sid, "profile": profile, "name": name,
                                                "data_url": f"data:{mime};base64,{b64}"}, timeout=120)
                if not isinstance(r, dict) or r.get("attached") is False:
                    raise fail("attachment_refused", f"Hermes did not take {name}", status=400)
                if r.get("ref_text"):
                    refs.append(str(r["ref_text"]))
        return f"{text}{chr(10) * 2 if text else ''}{chr(10).join(refs)}" if refs else text

    def stop(self, ref, key, run_id=None) -> dict:
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        with self._lock:
            r = c.runs.get(run_id) if run_id else None
            if r is None and key:
                r = next((c.runs[x] for x in c.turns.get(key, []) if x in c.runs and not c.runs[x].ended), None)
            key = r.key if r else key
        if not key:
            return {"ok": False}
        sid = self._live_for(c, key, profile)
        c.link.call("session.interrupt", {"session_id": sid, "profile": profile})
        out = []
        with self._lock:
            # (a message still waiting its turn ends here; the interrupt answers the running one)
            if r is not None and not r.started and not r.ended:
                r.tr._end("stopped")
                out = self._out(c, r, r.tr._take())
        self._send(out)
        return {"ok": True}

    def _ask_of(self, c: _Conn, run_id, match) -> tuple[_Run | None, str | None, dict | None]:
        """(under _lock) The run and Hermes' request a card answers (claimed: answered once)."""
        every = list(c.runs.values()) + [o for o in c.foreign.values() if not o.ended]
        runs = ([r for r in every if r.id == run_id] or every) if run_id else every
        for r in runs:
            rid = match(r)
            if rid and rid in c.asks and c.asks[rid]["runId"] == r.id:
                return r, rid, c.asks.pop(rid)
        return None, None, None

    def approve(self, ref, key, run_id, approval_id, decision) -> dict:
        """Allow once, for this chat, always, or deny."""
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        choice = ht.choice_for(decision)
        if not choice:
            raise fail("invalid", "Choose one of the offered answers.", status=400)
        approval_id = str(approval_id or "")
        with self._lock:
            r, rid, ask = self._ask_of(c, run_id, lambda x: x.approvals.get(approval_id))
            if ask is None:
                raise fail("not_pending", "That approval is no longer waiting.", status=409)
            r.approvals.pop(approval_id, None)
            live = c.live.get(r.key)
        if not c.link.respond(ask["id"], {"choice": choice}, ask["gen"]):
            c.link.call("approval.respond", {"session_id": live["sid"] if live else ask["sid"], "profile": profile,
                                             "choice": choice,
                                             "request_id": str(ask["params"].get("request_id") or "")})
        with self._lock:
            r.tr.answered(rid)
            r.tr.last_phase = None
            out = self._out(c, r, [{"type": "approval.resolved", "approvalId": approval_id,
                                    "approved": decision != "deny", "decision": decision}])
        self._send(out)
        return {"ok": True, "decision": decision}

    def answer(self, ref, key, run_id, question_id, answers=None, cancel=False) -> dict:
        """The agent's questions answered (clarify {qid: [labels]}, a masked prompt {value}) or cancelled. A secret is
        never kept, logged or sent anywhere but to Hermes."""
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        qid = str(question_id or "")
        with self._lock:
            r, rid, ask = self._ask_of(c, run_id, lambda x: qid)
            if ask is None or ask["method"] == "approval":
                if ask is not None:
                    c.asks[rid] = ask
                raise fail("not_pending", "That question is no longer waiting.", status=409)
        result = ht.answer_for({"method": ask["method"]}, answers if isinstance(answers, dict) else {}, bool(cancel))
        if not c.link.respond(ask["id"], result, ask["gen"]):
            c.link.call("request.answer", {"id": ask["id"], "result": result, "profile": profile})
        result = None
        with self._lock:
            r.tr.answered(rid)
            r.tr.last_phase = None
            out = self._out(c, r, [{"type": "question.resolved", "questionId": qid,
                                    "status": "cancelled" if cancel else "answered"}])
        self._send(out)
        return {"ok": True}

    # ------------------------------------------------------------------ tasks (the side panel): subagents + cron
    def _subagents(self, c: _Conn, key: str, profile: str) -> None:
        """A chat's live children (subagent.list for its session) into the connection's task memory."""
        try:
            sid = self._live_for(c, key, profile)
            r = c.link.call("subagent.list", {"session_id": sid, "profile": profile}, timeout=10)
        except hl.HermesError:
            return
        c.tasks.upsert_rows(key, profile, sid, (r or {}).get("subagents") if isinstance(r, dict) else None)

    def _jobs(self, c: _Conn, profile: str) -> list:
        try:
            r = c.link.rest("GET", "/api/cron/jobs", profile=profile, query={"profile": profile}, timeout=15)
        except hl.HermesError:
            return []
        rows = r if isinstance(r, list) else (r or {}).get("jobs") if isinstance(r, dict) else []
        return [x for x in rows or [] if isinstance(x, dict) and (x.get("job_id") or x.get("id"))]

    def tasks(self, ref, key=None, scope="chat") -> dict:
        """{active, recent}: a chat's subagents, or (scope agent) the agent's in every chat this connection follows
        plus its scheduled jobs (`cron:<id>`, no transcript)."""
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        key = str(key or "")
        if scope != "agent":
            if not key:
                return {"active": [], "recent": []}
            keys = [key]
        else:
            with self._lock:
                keys = sorted({k for k, v in c.live.items() if v.get("profile") == profile} | ({key} if key else set()))
        for k in keys[:50]:
            self._subagents(c, k, profile)
        rows = c.tasks.rows(profile, keys, key or None)
        if scope == "agent":
            rows += [ha.job_task_of(j) for j in self._jobs(c, profile)]
        return ha.split(rows)

    def _kid(self, c: _Conn, profile: str, task_id: str, key, scope) -> dict:
        x = c.tasks.known(task_id)
        if x is None or x["profile"] != profile or (scope != "agent" and x["key"] != str(key or "")):
            raise fail("not_found", "This task is no longer available.", status=404)
        return x

    def task(self, ref, task_id, key=None, scope="chat") -> dict:
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        task_id = str(task_id or "")
        if task_id.startswith("cron:"):
            job = next((j for j in self._jobs(c, profile) if str(j.get("job_id") or j.get("id")) == task_id[5:]), None)
            if job is None:
                raise fail("not_found", "This scheduled job is no longer there.", status=404)
            return {"task": dict(ha.job_task_of(job), prompt=str(job.get("prompt") or job.get("prompt_preview") or ""))}
        x = self._kid(c, profile, task_id, key, scope)
        t = dict(x["task"], prompt=x["task"].get("title") or "", here=x["key"] == str(key or ""), sessionKey=x["key"])
        if t.get("terminalSummary"):
            t["result"] = t["terminalSummary"]
        return {"task": t}

    def task_history(self, ref, task_id, key=None, scope="chat") -> dict:
        """A subagent's live transcript (the tail Hermes keeps) as one message; a scheduled job has none."""
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        task_id = str(task_id or "")
        if task_id.startswith("cron:"):
            return {"messages": []}
        x = self._kid(c, profile, task_id, key, scope)
        try:
            r = c.link.call("subagent.tail", {"session_id": x["sid"], "profile": profile, "subagent_id": task_id},
                            timeout=10)
        except hl.HermesError:
            r = None
        text = str(r.get("text") or "") if isinstance(r, dict) and r.get("available") is not False else ""
        if not text:
            return {"messages": []}
        return {"messages": [{"role": "assistant", "text": ("…\n" if r.get("truncated") else "") + text,
                              "ts": x["task"].get("updatedAt")}]}

    def steer_task(self, ref, task_id, text) -> dict:
        """Words for a running subagent, taken into its next step (subagent.steer: no interrupt)."""
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        text = str(text or "").strip()
        if not text:
            raise fail("invalid", "What should it do?", status=400)
        if str(task_id or "").startswith("cron:"):
            raise fail("unsupported", "A scheduled job cannot be steered.", status=400)
        x = self._kid(c, profile, str(task_id or ""), None, "agent")
        r = c.link.call("subagent.steer", {"session_id": x["sid"], "profile": profile, "subagent_id": x["task"]["id"],
                                           "text": text[:4000]})
        ok = isinstance(r, dict) and bool(r.get("ok") or r.get("queued") or r.get("found")
                                          or r.get("status") in ("queued", "steered"))
        out = {"ok": True, "steered": ok}
        if not ok:
            out["reason"] = str((r or {}).get("reason") or (r or {}).get("error") or (r or {}).get("status")
                                or "It did not take it")[:300] if isinstance(r, dict) else "It did not take it"
        return out

    def cancel_task(self, ref, task_id, key=None, scope="chat") -> dict:
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        task_id = str(task_id or "")
        if task_id.startswith("cron:"):
            raise fail("unsupported", "A scheduled job is paused from Hermes' settings menu (Automations).", status=400)
        x = self._kid(c, profile, task_id, key, scope)
        r = c.link.call("subagent.interrupt", {"session_id": x["sid"], "profile": profile, "subagent_id": task_id})
        found = isinstance(r, dict) and bool(r.get("found"))
        if found:
            x = dict(x, task=dict(x["task"], status="cancelled", endedAt=int(time.time() * 1000),
                                  execution={"state": "finished"}))
            c.tasks.remember(x)
            c.tasks.tell(x)
        out = {"ok": True, "cancelled": found, "task": x["task"]}
        if not found:
            out["reason"] = "It had already finished"
        return out

    def state(self, ref, key) -> dict:
        """What the hub cannot know: the cards still waiting, the todo list, the chat's prefs."""
        cid, profile, _office = _who(ref)
        c = self._conn(cid)
        with self._lock:
            open_runs = [c.runs[x] for x in c.turns.get(key, []) if x in c.runs and not c.runs[x].ended]
            if c.foreign.get(key) is not None and not c.foreign[key].ended:
                open_runs.append(c.foreign[key])
            ids = {r.id for r in open_runs}
            approvals = [dict(a["card"], runId=a["runId"]) for a in c.asks.values()
                         if a["runId"] in ids and a["method"] == "approval" and a.get("card")]
            questions = [dict(a["card"], runId=a["runId"]) for a in c.asks.values()
                         if a["runId"] in ids and a["method"] != "approval" and a.get("card")]
            todo = c.todos.get(key)
            out = {"working": bool(open_runs), "approvals": approvals, "questions": questions,
                   "title": c.titles.get(key) or "", "usage": dict(c.usage.get(key) or {})}
        if todo and todo.get("steps"):
            out["plan"] = {"title": "Tasks", "steps": todo["steps"], "revision": todo.get("revision")}
        prefs = self._prefs_of(c, profile, key)
        out["model"], out["effort"] = prefs["model"], prefs["effort"]
        return out

    def media(self, ref, key, source) -> tuple[bytes, str]:
        """A file an answer named (MEDIA:/path), fetched through Hermes' own file route (40 MB cap)."""
        cid, profile, _office = _who(ref)
        src = str(source or "")
        if not src or re.match(r"^[a-z][a-z0-9+.-]*://", src, re.I):
            raise fail("unsupported", "Only a file on Hermes' machine is fetched here.", status=400)
        c = self._conn(cid)
        resp = c.link.rest("GET", "/api/files/download", profile=profile, query={"path": src}, raw=True,
                           timeout=60, max_bytes=MEDIA_MAX)
        if not resp.ok:
            raise fail("not_found", "Hermes no longer has this file.", status=404)
        ctype = resp.content_type
        if ctype == "application/octet-stream":
            ctype = mimetypes.guess_type(src)[0] or ctype
        return bytes(resp.body), ctype

    # ------------------------------------------------------------------ settings menu and the agent's machine (C1)
    def _access(self, cid) -> str:
        """The connection's access level: 'full' or 'chat' (an unknown or missing level counts as Chat only)."""
        record = self._connection(str(cid or ""))
        return "full" if isinstance(record, dict) and record.get("access") == "full" else "chat"

    @staticmethod
    def _gated() -> frozenset | None:
        """The writes the office's /call route gates with the passcode and the audit log (the manifest's menuWrite)."""
        try:
            import agent_providers
            return frozenset(agent_providers.MANIFESTS["hermes"].get("menuWrite") or ())
        except Exception:  # noqa: BLE001 - outside the server: every write the menu has
            return None

    def menu(self, cid, method, params=None):
        """Hermes' settings menu (provider-menu-hermes.js): reads at both levels, writes with Full access only."""
        c = self._conn(cid)
        return hm.menu_call(c.link, str(method or ""), params, access=self._access(cid), gated=self._gated())

    def files(self, ref, op, params=None) -> dict:
        cid, _profile, _office = _who(ref)
        access = self._access(cid)
        if op in hmc.WRITES and access != "full":
            raise hm.chat_only("files")
        return hmc.files(self._conn(cid).link, str(op or ""), params, access=access)

    def _screen(self, cid) -> hmc.Screen:
        c = self._conn(cid)
        with self._lock:
            if c.screen is None or c.screen.link is not c.link:
                c.screen = hmc.Screen(c.link)
            return c.screen

    def screen_state(self, ref, viewer: str = "") -> dict:
        cid, profile, _office = _who(ref)
        access = self._access(cid)
        if access != "full":
            return hmc.Screen.unavailable()
        return self._screen(cid).state(profile, viewer, access=access)

    def screen_act(self, ref, op, params=None) -> dict:
        cid, profile, _office = _who(ref)
        access = self._access(cid)
        if access != "full":
            return hmc.Screen.unavailable()
        return self._screen(cid).act(profile, str(op or ""), params, access=access)

    def screen_thumb(self, ref) -> dict | None:
        cid, profile, _office = _who(ref)
        access = self._access(cid)
        if access != "full":
            return None
        return self._screen(cid).thumb(profile, access=access)

    # ------------------------------------------------------------------ from Hermes (the link's loop thread)
    def _current(self, c: _Conn, key: str, starting: bool):
        """(under _lock) The run Hermes' turn in a session belongs to: the one answering, or (a turn beginning) the
        next one waiting."""
        for rid in c.turns.get(key, []):
            r = c.runs.get(rid)
            if r is None or r.ended:
                continue
            if r.started:
                return r
            if starting:
                r.started = True
                return r
            return None
        return None

    def _on_event(self, c: _Conn, evt: dict) -> None:
        if not isinstance(evt, dict):
            return
        t = str(evt.get("type") or "")
        p = evt.get("payload") if isinstance(evt.get("payload"), dict) else {}
        out = []
        with self._lock:
            key = c.by_live.get(str(evt.get("session_id") or ""))
            if t == "session.info" and key and p.get("stored_session_id"):
                # (a compaction continues the conversation under a new stored id: the chat keeps its own)
                new = str(p["stored_session_id"])
                if new != key and new != c.renamed.get(key):
                    c.renamed[key] = new
            if t in ("request.cancel", "approval.cancelled"):
                ids = {str(x) for x in (p.get("request_ids") if isinstance(p.get("request_ids"), list) else [p.get("id")])}
                for rid in [k for k, a in c.asks.items() if k in ids
                            or (a["method"] == "approval" and str(a["params"].get("request_id") or "") in ids)]:
                    a = c.asks.pop(rid)
                    r = c.runs.get(a["runId"]) or next((o for o in c.foreign.values() if o.id == a["runId"]), None)
                    if r is not None and not r.ended:
                        r.approvals = {k: v for k, v in r.approvals.items() if v != rid}
                        out += self._out(c, r, r.tr.feed(evt))
            elif key:
                if t == "todo.updated":
                    c.todos[key] = {"steps": ht.steps_of(p.get("todos")), "revision": p.get("revision")}
                if t in TURN_EVENTS:
                    r = self._current(c, key, t == "message.start")
                    if r is not None:
                        out = self._out(c, r, r.tr.feed(evt))
                    elif t != "session.info":
                        out = self._observe(c, key, evt)
            live = c.live.get(key) if key else None
            tasks, presence = c.tasks, c.presence
        if t.startswith("subagent.") and key and tasks is not None:
            tasks.on_event(key, (live or {}).get("profile") or "", str(evt.get("session_id") or ""), evt)
        if t == "sessions.changed" and presence is not None:
            presence.soon()
        self._send(out)

    def _observe(self, c: _Conn, key: str, evt: dict) -> list:
        """(under _lock) A turn in a chat a page has open that is not ours (Hermes Desktop or its dashboard answering
        there): followed from its message.start under its own run id and shown to the chat's pages, marked observed."""
        now = _now()
        o = c.foreign.get(key)
        if o is not None and now - o.at > QUIET_S:
            out = self._out(c, o, o.tr.interrupt("Lost track of this turn"))
            c.foreign.pop(key, None)
            return out + self._observe(c, key, evt)
        if o is None:
            w = c.watched.get(key)
            if w is None or evt.get("type") != "message.start":
                return []      # (only a turn's beginning, in a chat being watched, starts following it)
            if w["until"] < now:
                c.watched.pop(key, None)
                return []
            o = _Run("ho-" + uuid.uuid4().hex[:16], key, w["profile"], False)
            o.observed = o.started = o.announced = True
            o.restarts = c.link.restarts if c.link is not None else 0
            c.foreign[key] = o
            out = [self._wrap(c, o, {"type": "run.start", "source": "hermes"})]
        else:
            out = []
        o.at = now
        return out + self._out(c, o, o.tr.feed(evt))

    def watch(self, ref, key, on=True) -> dict:
        """A page has the chat open (renewed every minute): Hermes sends this connection the session's events, and a
        turn started in Hermes itself is followed live (observed). The lease lapses after 150 s without a renewal."""
        cid, profile, _office = _who(ref)
        key = str(key or "")
        if not key:
            return {"ok": True, "watching": False}
        c = self._conn(cid)
        if not on:
            with self._lock:
                c.watched.pop(key, None)
            return {"ok": True, "watching": False}
        with self._lock:
            c.watched[key] = {"profile": profile, "until": _now() + min(WATCH_MAX_S, WATCH_S)}
        try:
            self._live_for(c, key, profile)
        except hl.HermesError:
            with self._lock:
                c.watched.pop(key, None)
            raise
        return {"ok": True, "watching": True, "leaseMs": int(WATCH_S * 1000)}

    def _on_request(self, c: _Conn, rq: dict):
        """Hermes asks this client (approval, clarify, secret, sudo): a card of the run in that session, answered later
        by the person. In a session without a run of ours it is left to Hermes' other clients."""
        p = rq.get("params") if isinstance(rq.get("params"), dict) else {}
        rid = str(rq.get("id"))
        out = []
        with self._lock:
            key = c.by_live.get(str(p.get("session_id") or ""))
            r = None
            if key:
                r = self._current(c, key, False) or next(
                    (c.runs[x] for x in c.turns.get(key, []) if x in c.runs and not c.runs[x].ended), None)
                if r is None and c.foreign.get(key) is not None and not c.foreign[key].ended:
                    r = c.foreign[key]     # (a turn followed here: its pages answer it too)
            if r is None or rq.get("method") not in ASKS:
                return hl.ANSWER_LATER
            if rid in c.asks:
                return hl.ANSWER_LATER
            evs = r.tr.request({"id": rq.get("id"), "method": rq.get("method"), "params": p})
            card = next((e for e in evs if e.get("type") in ("approval.requested", "question.requested")), None)
            if card is None:
                return None        # (nothing the chat can show: Hermes is told at once)
            c.asks[rid] = {"id": rq.get("id"), "runId": r.id, "method": rq.get("method"), "params": p,
                           "gen": rq.get("generation"), "sid": str(p.get("session_id") or ""),
                           "card": {k: v for k, v in card.items() if k != "type"}}
            if card["type"] == "approval.requested":
                r.approvals[str(card.get("approvalId"))] = rid
            out = self._out(c, r, evs)
        self._send(out)
        return hl.ANSWER_LATER


def _quote(s: str) -> str:
    return urllib.parse.quote(str(s), safe="")
