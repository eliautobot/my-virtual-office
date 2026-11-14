"""Office life sources: real provider signals -> OfficeEvents (design 1.3, features 3.1-3.5).

Read-only and zero inference: nothing here calls a model, starts a run, sends a message or writes
to a provider. A provider that cannot signal a feature never fires it (no guessing, no free text).

Every tap only copies a few fields into one bounded queue (QUEUE_MAX, oldest dropped); the thread
"office-life-sources" turns them into OfficeEvents on the bus, so a provider thread never waits.
Signal families:
1. Hub listener (Hermes serve + OpenClaw adapters; runs before presence): approval/question cards
   -> needs; Hermes ``agent.activity`` waiting keys -> needs input, newly busy keys by platform
   (``sources``) -> visitors and alarm clocks; ``agent.helpers`` + ``session.task`` subagent/acp ->
   interns; ``session.task`` cron -> alarm clocks; ``provider.status`` down -> needs gone.
2. gateway_presence lifecycle (every provider that reports runs): ``run`` journal rows (start/end,
   outcome, duration, tool kinds) for the moods and the paper; approvals of runs the hub does not
   carry (legacy Hermes, Codex, provider SDKs) -> needs; provider down -> needs gone.
3. gateway_presence activity observer (OpenClaw): tool kinds, ``sessions_send``/``sessions_spawn``
   to another office agent -> handoffs (never a name guess).
4. gateway_presence event tap (OpenClaw): ``session.message`` from an outside channel -> visitor,
   inter-session messages -> handoffs; ``sessions.changed`` subagent sessions -> interns.
5. OpenClaw cron subscription (alarm clocks); adapter start at boot + one approval seed.
6. SMS log tail (visitor ``sms`` for the SMS owner agent).
7. The copied OpenClaw + Hermes layer's bus (v0.11, ``on_layer``; provider_layer_life.py feeds it before presence):
   approval/question cards of office runs and ``agent.need`` (runs started elsewhere) -> needs; ``agent.activity``
   session keys -> visitors (an outside channel: OpenClaw's key segment, Hermes' ``sources``), alarm clocks (cron
   sessions), interns (OpenClaw subagent sessions), the journal of runs started outside the office (duration only),
   waiting keys -> needs input; ``agent.helpers`` / ``session.task`` -> interns; ``tool.start`` sessions_send /
   sessions_spawn in office runs -> handoffs; ``provider.status`` down -> needs gone. Office runs' journal rows come
   through presence's lifecycle (tap 2), as before.
Server write sites (tasks, XP, projects, A2A, assignments) go through hooks.py.
"""

import collections
import json
import os
import queue
import threading
import time

from . import events
from . import settings as life_settings

QUEUE_MAX = 500
INTERNS_DEBOUNCE_S = 1.0
SMS_EVERY_S = 15.0
SMS_READ_MAX = 256 * 1024
RECONCILE_EVERY_S = 30.0
GONE_GRACE_S = 60.0          # a run/approval presence no longer holds is closed after this long
HANDOFF_PAIR_S = 20.0        # one handoff per sender -> receiver pair in this window (two signals, one walk)
CRON_GAP_S = 90.0            # one alarm per agent in this window (subscription + task signal)
CHILD_STALE_S = 6 * 3600     # an OpenClaw subagent session never reported idle again
REMEMBER_MAX = 2000
CLIENT_CHECK_S = 60.0

OK_OUTCOMES = frozenset({"completed", "complete", "ok", "success", "succeeded", "done", "final", "end"})
FAIL_OUTCOMES = frozenset({"failed", "error", "errored", "aborted", "timed_out", "timeout", "lost"})
STOP_OUTCOMES = frozenset({"cancelled", "canceled", "interrupted", "stopped"})
OPEN_TASK = frozenset({"queued", "running", "pending", "started", "active", "waiting"})
HELPER_RUNTIMES = frozenset({"subagent", "acp"})
# OpenClaw's deferred-tool call (tools offered by search): 2026.9 tool_call, 2026.11 dispatch_action; both {id, args}
DEFERRED_WRAPPERS = frozenset({"tool_call", "dispatch_action"})
DOWN_STATES = frozenset({"offline", "down", "error", "disconnected", "unreachable", "closed", "failed"})
START_PHASES = frozenset({"start", "started", "call", "begin"})
HANDOFF_TOOLS = {"sessions_send": "send", "sessions_spawn": "spawn"}
PROVIDER_ALIASES = {"claude": "claude-code", "claude_code": "claude-code", "claudecode": "claude-code",
                    "gemini": "antigravity", "built-in": "builtin", "built_in": "builtin", "local": "builtin"}
LAYER_KINDS = frozenset({"provider.status", "provider.disconnected", "run.start", "run.end", "approval.requested",
                         "approval.resolved", "question.requested", "question.resolved", "tool.start", "tool.update",
                         "agent.activity",
                         "agent.need", "agent.helpers", "session.task"})
LAYER_FIELDS = ("type", "kind", "connectionId", "agentKey", "sessionKey", "runId", "approvalId", "questionId", "approved",
                "decision", "status", "state", "expiresAt", "active", "children", "change", "taskId", "needId", "need",
                "outcome", "name", "toolId", "outside")
LAYER_RUNS_MAX = 500
LAYER_BASELINE_S = 5.0       # activity reported this soon after a layer connection came up was already going
HUB_KINDS = frozenset({"approval.requested", "approval.resolved", "question.requested", "question.resolved",
                       "run.end", "agent.activity", "agent.helpers", "session.task", "provider.status"})


def _remember(store, key, limit=REMEMBER_MAX):
    store[key] = True
    store.move_to_end(key)
    while len(store) > limit:
        store.popitem(last=False)


def _dict(value):
    return value if isinstance(value, dict) else {}


def _args(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return _dict(value)


def _unwrap(name, args):
    """(name, args) of the tool a call runs: OpenClaw's deferred tools come through a wrapper (DEFERRED_WRAPPERS
    {id, args}; the id bare or a tool-search result "openclaw:core:sessions_send"), and a name with that prefix is
    its tool. Anything else as it was (args as a dict)."""
    name, args = str(name or ""), _args(args)
    if name in DEFERRED_WRAPPERS:
        inner = args.get("id") or args.get("name")
        if isinstance(inner, str) and inner.strip():
            return inner.strip().rsplit(":", 1)[-1], _args(args.get("args"))
        return name, args
    if name.startswith("openclaw:") and name.count(":") >= 2:
        name = name.rsplit(":", 1)[-1]
    return name, args


def _agent_of_key(key):
    """``agent:<id>:...`` -> ``<id>`` (OpenClaw session keys), else ''."""
    parts = str(key or "").split(":")
    return parts[1] if len(parts) > 2 and parts[0] == "agent" and parts[1] else ""


def is_helper_key(key):
    """An OpenClaw session a helper of its agent runs in: ``agent:<id>:subagent:<uuid>`` (sessions_spawn, collectors
    too) or ``agent:<id>:acp:<uuid>`` (an ACP child); the parent's own chats and channels are not."""
    parts = str(key or "").split(":")
    return len(parts) > 3 and parts[0] == "agent" and parts[2].lower() in HELPER_RUNTIMES


def channel_of_session(row, key="", top=None):
    """The outside channel an OpenClaw session talks on, or None. The first non-empty of the row's
    origin provider/channel, delivery channel, last channel and channel decides (a webchat session
    is never a visitor); else the 3rd segment of ``agent:<id>:<channel>:...``. Live frames carry
    the row nested (``session``) and flattened at the top level (``top``): nested wins."""
    rows = [_dict(row), _dict(top)]

    def first(read):
        for item in rows:
            value = read(item)
            if isinstance(value, str) and value.strip():
                return value
        return None

    for read in (lambda r: _dict(r.get("origin")).get("provider"), lambda r: _dict(r.get("origin")).get("channel"),
                 lambda r: _dict(r.get("deliveryContext")).get("channel"), lambda r: r.get("lastChannel"),
                 lambda r: r.get("channel")):
        value = first(read)
        if value:
            return events.channel_of(value)
    parts = str(key or rows[0].get("key") or "").split(":")
    if len(parts) > 3 and parts[0] == "agent":
        return events.channel_of(parts[2])
    return None


def layer_native(cid, agent_key):
    """A layer event's agent as its provider's own name: run events carry the layer's key ``prov-<cid>-<native>``,
    activity and the rest the native id (an OpenClaw agent id, a Hermes profile)."""
    text = str(agent_key or "")
    prefix = f"prov-{cid}-"
    return text[len(prefix):] if cid and text.startswith(prefix) else text


def provider_name(kind, hub_run=False):
    """A lifecycle ``provider_kind`` as an OfficeEvent provider (unknown ones are left out by the
    whitelist). Lifecycle "hermes" runs the hub did not carry are the legacy API-server path."""
    text = str(kind or "").strip().lower()
    text = PROVIDER_ALIASES.get(text, text)
    if text == "hermes" and not hub_run:
        return "hermes-legacy"
    return text or None


def outcome_ok(outcome):
    """True for a clean finish, False for a failure or a stop, None when the provider did not say."""
    text = str(outcome or "").strip().lower()
    if text in OK_OUTCOMES:
        return True
    if text in FAIL_OUTCOMES or text in STOP_OUTCOMES:
        return False
    return None


def need_outcome(status):
    text = str(status or "").lower()
    if "expire" in text or "timeout" in text or "timed_out" in text:
        return "expired"
    if "cancel" in text or "abort" in text or "dismiss" in text:
        return "cancelled"
    return "answered"


class Sources:
    """All signal taps of one process. ``drain()`` / ``tick()`` run on the sources thread (or
    directly in tests with a fake clock); every other method is a tap that only enqueues."""

    def __init__(self, ctx, clock=time.time, presence=None, hub=None, office_id=None, layer_office=None):
        self.ctx = ctx
        self._layer_office = layer_office
        self.clock = clock
        self.gp = presence
        self.hub = hub
        self._office_id = office_id
        self._q = collections.deque(maxlen=QUEUE_MAX)
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = None
        self._cron_thread = None
        self._cron_sub = None
        self._cron_client = None
        self._boot_lock = threading.Lock()
        self._booted = False
        self._removers = []
        # filled synchronously by the hub tap (it runs before presence's own hub listener)
        self._hub_runs = collections.OrderedDict()
        self._hub_approvals = collections.OrderedDict()
        self._tool_calls = collections.OrderedDict()     # OpenClaw run:toolCallId already counted
        # sources-thread state
        self.runs = {}                               # runId -> {agent, provider, start, tools, gone}
        self.ended = collections.OrderedDict()       # runIds already ended
        self.needs = {}                              # (agent, ref) -> {src, run, cid, provider, session, at, gone}
        self.helpers = {}                            # agent -> {source: set() | int}
        self.intern_due = {}
        self.intern_sent = {}
        self.hermes = {}                             # (cid, agent) -> {"keys": {key: source}, "waiting": set()}
        self.agent_cid = {}
        self.children = {}                           # parent -> {child session key: last seen}
        self.pairs = {}                              # (from, to) -> last handoff time
        self.cron_last = {}                          # agent -> last cron.fire time
        self.cron_done_last = {}                     # (agent, ref) -> last cron.done time
        self.sms = {}                                # path -> [inode, offset]
        self.layer_runs = collections.OrderedDict()  # layer runId -> {native, session} (office runs)
        self._layer_tools = collections.OrderedDict()   # "run:tool" -> handoff tool name still without its arguments
        self.office_sessions = collections.OrderedDict()   # session keys the office's own runs use
        self.layer_act = {}                          # ("pl-<cid>", agent) -> {keys: {key: source}, waiting, subs}
        self.layer_up = {}                           # "pl-<cid>" -> when its connection last came up
        self._next_sms = 0.0
        self._next_reconcile = 0.0
        self._next_client_check = 0.0

    # ── helpers ──
    def now(self):
        return self.clock()

    def now_ms(self):
        return int(self.clock() * 1000)

    def status_key(self, office_id):
        office_id = str(office_id or "")
        if not office_id:
            return ""
        return str(self.ctx.call("status_key", office_id, default=office_id) or office_id)

    def office_id(self, cid, native):
        if self._office_id is not None:
            return self._office_id(cid, native)
        try:
            import agent_providers
            return agent_providers.office_id_for(cid, native)
        except Exception:
            return str(native or "") if cid == "openclaw" else ""

    def emit(self, kind, agent=None, feature=None, **data):
        """Publish one OfficeEvent; ``feature`` gates events that open something (closing ones are
        never gated, so turning a feature off never leaves a sign up)."""
        if feature and not self.ctx.feature(feature):
            return None
        event = {k: v for k, v in data.items() if v is not None}
        event["type"] = kind
        if agent:
            event["agent"] = agent
        event.setdefault("at", self.now_ms())
        return self.ctx.bus.publish(event)

    def _put(self, func, *args):
        self._q.append((func, args))
        self._wake.set()

    # ── 1. hub tap ──
    def on_hub(self, key, frame):
        try:
            cid, native, session = key
            event = frame.get("event") or {}
            kind = event.get("type")
        except Exception:
            return
        if kind == "run.start":
            if frame.get("run"):    # presence names this run's lifecycle "hermes" (serve), not legacy
                _remember(self._hub_runs, str(frame["run"]))
            return
        if kind not in HUB_KINDS:
            return
        run = str(frame.get("run") or "")
        if run:
            _remember(self._hub_runs, run)
        if kind == "approval.requested" and event.get("approvalId"):
            _remember(self._hub_approvals, str(event["approvalId"]))
        data = {name: event.get(name) for name in ("approvalId", "questionId", "expiresAt", "status", "decision",
                                                   "active", "children", "change", "taskId", "state")
                if name in event}
        for name in ("keys", "waiting"):
            if isinstance(event.get(name), list):
                data[name] = [str(x) for x in event[name][:64]]
        if isinstance(event.get("sources"), dict):
            data["sources"] = {str(k): str(v or "") for k, v in list(event["sources"].items())[:64]}
        task = event.get("task")
        if isinstance(task, dict):
            data["task"] = {name: task.get(name) for name in ("id", "taskId", "status", "runtime", "kind",
                                                              "sourceId", "runId") if name in task}
        self._put(self._hub_event, str(cid), str(native), str(session), kind, data, run, self.now_ms())

    def _hub_event(self, cid, native, session, kind, data, run, at):
        star = "*"
        if kind == "provider.status":
            if str(data.get("state") or "").lower() in DOWN_STATES:
                self._close_where(lambda n: n.get("cid") == cid, "gone", at)
                for state_key in [k for k in self.hermes if k[0] == cid]:
                    self.hermes.pop(state_key, None)   # the next report after reconnecting is a baseline
            return
        if native == star:
            return
        agent = self.status_key(self.office_id(cid, native))
        if not agent:
            return
        self.agent_cid[agent] = cid
        provider = "openclaw" if cid == "openclaw" else "hermes"
        session = session if session and session != star else None
        if kind in ("approval.requested", "question.requested"):
            ref = str(data.get("approvalId") or data.get("questionId") or "")
            if ref:
                self._open_need(agent, ref, "approval" if kind.startswith("approval") else "question", provider,
                                src="hub", cid=cid, run=run, session=session, card=ref,
                                expires=data.get("expiresAt"), at=at)
                if session:   # the card replaces a bare "waiting" sign for that chat
                    self._close_need(agent, f"wait:{session}", "gone", at)
        elif kind in ("approval.resolved", "question.resolved"):
            ref = str(data.get("approvalId") or data.get("questionId") or "")
            if ref:
                self._close_need(agent, ref, need_outcome(data.get("status") or data.get("decision")), at)
        elif kind == "run.end" and run:
            self._close_where(lambda n: n.get("run") == run and n.get("src") == "hub", "gone", at)
        elif kind == "agent.activity" and cid != "openclaw":
            self._hermes_activity(cid, agent, data, at)
        elif kind == "agent.helpers":
            self._set_helpers(agent, "hermes-children", int(data.get("children") or 0))
        elif kind == "session.task":
            self._task(agent, provider, data, at, session)

    def _hermes_activity(self, cid, agent, data, at):
        baseline = (cid, agent) not in self.hermes   # first report after boot or a reconnect: no arrivals
        state = self.hermes.setdefault((cid, agent), {"keys": {}, "waiting": set()})
        keys = set(data.get("keys") or []) if data.get("active") else set()
        sources = data.get("sources") or {}
        before = state["keys"]
        now_keys = {key: str(sources.get(key) or before.get(key) or "") for key in keys}
        for key in [] if baseline else sorted(set(now_keys) - set(before)):
            source = now_keys[key].strip().lower()
            channel = events.channel_of(source)
            if channel:
                self.emit("visitor", agent, "visitors", provider="hermes", channel=channel, session=key, at=at)
            elif source == "cron":
                self._cron_fire(agent, "hermes", ref=f"session:{key}", at=at)
        for key in sorted(set(before) - set(now_keys)):
            if before[key].strip().lower() == "cron":
                self._cron_done(agent, "hermes", ref=f"session:{key}", at=at)
        state["keys"] = now_keys
        waiting = set(data.get("waiting") or []) & keys
        for key in sorted(waiting - state["waiting"]):
            if not any(n.get("session") == key and n.get("src") == "hub" and owner == agent
                       for (owner, _r), n in self.needs.items()):
                self._open_need(agent, f"wait:{key}", "input", "hermes", src="wait", cid=cid, session=key, at=at)
        for key in sorted(state["waiting"] - waiting):
            self._close_need(agent, f"wait:{key}", "answered" if key in keys else "gone", at)
        state["waiting"] = waiting

    def _task(self, agent, provider, data, at, session):
        task = data.get("task") or {}
        task_id = str(data.get("taskId") or task.get("id") or task.get("taskId") or "")
        if not task_id:
            return
        runtime = str(task.get("runtime") or task.get("kind") or "").lower()
        status = str(task.get("status") or "").lower()
        removed = str(data.get("change") or "").lower() in ("removed", "deleted", "dropped")
        is_open = status in OPEN_TASK and not removed
        if runtime in HELPER_RUNTIMES or (removed and not runtime):
            bucket = self.helpers.setdefault(agent, {}).setdefault(f"{provider}-tasks", set())
            changed = (task_id in bucket) != is_open
            (bucket.add if is_open else bucket.discard)(task_id)
            if changed:
                self._intern_changed(agent)
        elif runtime == "cron":
            # The job id when known: the cron subscription names the same run by it, so both
            # signals share one ref (one alarm, one done).
            ref = str(task.get("sourceId") or "") or f"task:{task_id}"
            if status == "running":
                self._cron_fire(agent, provider, ref=ref, at=at, session=session)
            elif status and not is_open:
                ok = outcome_ok(status)
                self._cron_done(agent, provider, ref=ref, ok=ok, at=at)

    # ── needs ──
    def _open_need(self, agent, ref, need, provider, src, cid=None, run=None, session=None, card=None,
                   expires=None, at=None):
        if (agent, ref) in self.needs:
            return
        if not self.ctx.feature("needsYou"):
            return
        count = 1 + sum(1 for (owner, _r) in self.needs if owner == agent)
        frame = self.emit("needs.open", agent, None, need=need, provider=provider, ref=ref, session=session,
                          cardId=card, expiresAt=expires, count=count, at=at)
        if frame is not None:
            self.needs[(agent, ref)] = {"src": src, "run": run, "cid": cid, "provider": provider,
                                        "session": session, "at": at, "gone": None}

    def _close_need(self, agent, ref, outcome, at=None):
        info = self.needs.pop((agent, ref), None)
        if info is None:
            return
        self.emit("needs.close", agent, provider=info.get("provider"), ref=ref, outcome=outcome, at=at)

    def _close_where(self, test, outcome, at=None):
        for (agent, ref), info in list(self.needs.items()):
            if test(info):
                self._close_need(agent, ref, outcome, at)

    # ── interns ──
    def _set_helpers(self, agent, source, count):
        bucket = self.helpers.setdefault(agent, {})
        if bucket.get(source, 0) != count:
            bucket[source] = count
            self._intern_changed(agent)

    def _intern_changed(self, agent):
        self.intern_due.setdefault(agent, self.now() + INTERNS_DEBOUNCE_S)

    def intern_count(self, agent):
        """One helper counted once: the largest of the agent's signals (two signals for one helper
        never double)."""
        counts = [len(v) if isinstance(v, (set, dict)) else int(v or 0) for v in (self.helpers.get(agent) or {}).values()]
        return max(counts) if counts else 0

    def _interns_cap(self):
        cap = ((getattr(self.ctx, "settings", None) or {}).get("interns") or {}).get("maxShown")
        ok = isinstance(cap, int) and not isinstance(cap, bool) and cap > 0
        return cap if ok else life_settings.INTERNS_SHOWN_DEFAULT

    def _flush_interns(self, force=False):
        now = self.now()
        for agent, due in list(self.intern_due.items()):
            if not force and due > now:
                continue
            self.intern_due.pop(agent, None)
            count = self.intern_count(agent) if self.ctx.feature("interns") else 0
            if count == self.intern_sent.get(agent, 0):
                continue
            # shown: at most this many intern characters (the office-wide cap, setting interns.maxShown); the
            # page shares the cap fairly between agents and draws one intern per running helper below it.
            self.emit("interns.set", agent, count=count, shown=min(count, self._interns_cap()))
            if count:
                self.intern_sent[agent] = count
            else:
                self.intern_sent.pop(agent, None)

    # ── cron ──
    def _cron_fire(self, agent, provider, ref=None, name=None, run_at=None, at=None, session=None):
        now = self.now()
        last = self.cron_last.get(agent)
        if last is not None and now - last < CRON_GAP_S:
            return
        frame = self.emit("cron.fire", agent, "alarmClock", provider=provider, ref=ref, name=name, runAt=run_at,
                          session=session, at=at)
        if frame is not None:
            self.cron_last[agent] = now

    def _cron_done(self, agent, provider, ref=None, name=None, run_at=None, ok=None, at=None):
        """One cron.done per run: the task signal and the cron subscription both report the end
        of an OpenClaw run (one with runAt, one without), so repeats for the same agent and ref
        inside the alarm window are dropped here; the bus key alone cannot match them."""
        now = self.now()
        key = (agent, ref or "")
        last = self.cron_done_last.get(key)
        if last is not None and now - last < CRON_GAP_S:
            return
        frame = self.emit("cron.done", agent, provider=provider, ref=ref, name=name, runAt=run_at, ok=ok, at=at)
        if frame is not None:
            for old in [k for k, t in self.cron_done_last.items() if now - t >= CRON_GAP_S]:
                del self.cron_done_last[old]
            self.cron_done_last[key] = now

    def on_cron_frame(self, frame):
        """One gateway ``cron`` frame (subscription pump or a test)."""
        if not isinstance(frame, dict) or frame.get("event") != "cron":
            return
        payload = _dict(frame.get("payload"))
        job = _dict(payload.get("job"))
        data = {"action": str(payload.get("action") or ""), "jobId": str(payload.get("jobId") or job.get("id") or ""),
                "runAtMs": payload.get("runAtMs"), "status": payload.get("status"),
                "agent": str(_dict(job.get("owner")).get("agentId") or job.get("agentId") or ""),
                "name": job.get("displayName") or job.get("name")}
        self._put(self._cron_event, data, self.now_ms())

    def _cron_event(self, data, at):
        if not data["agent"]:
            return   # a job with no agent: never guessed
        agent = self.status_key(data["agent"])
        ref = data["jobId"] or None
        if data["action"] == "started":
            self._cron_fire(agent, "openclaw", ref=ref, name=data["name"], run_at=data["runAtMs"], at=at)
        elif data["action"] == "finished":
            status = str(data.get("status") or "").lower()
            ok = (status not in FAIL_OUTCOMES) if status else None
            self._cron_done(agent, "openclaw", ref=ref, name=data["name"], run_at=data["runAtMs"], ok=ok, at=at)

    # ── 2. lifecycle tap ──
    def on_lifecycle(self, name, agent_id, run_id, provider_kind, extra):
        run_id = str(run_id or "")
        if run_id.startswith("presence:"):
            return   # Hermes whole-profile activity windows are presence (state), not runs
        extra = extra if isinstance(extra, dict) else {}
        if name == "approval_requested" and str(extra.get("approvalId") or "") in self._hub_approvals:
            return   # the hub carries this card (with its chat); one sign
        self._put(self._life_event, name, str(agent_id or ""), run_id, str(provider_kind or ""), dict(extra),
                  run_id in self._hub_runs, self.now_ms())

    def _life_event(self, name, agent, run_id, provider_kind, extra, hub_run, at):
        if not agent:
            return
        provider = provider_name(provider_kind or self._roster_kind(agent), hub_run)
        if name == "run_started":
            if not run_id or run_id in self.runs or run_id in self.ended:
                return
            self.runs[run_id] = {"agent": agent, "provider": provider, "start": at,
                                 "tools": collections.Counter(), "gone": None}
            self.emit("run", agent, provider=provider, ref=run_id, phase="start", at=at)
        elif name == "run_finished":
            self._end_run(run_id, extra.get("outcome"), at)
        elif name == "tool_started":
            run = self.runs.get(run_id) or self._latest_run(agent)
            if run is not None:
                run["tools"][events.tool_kind(extra.get("toolName"))] += 1
        elif name == "approval_requested":
            ref = str(extra.get("approvalId") or "")
            if ref:
                self._open_need(agent, ref, "approval", provider, src="life", run=run_id or None, at=at)
        elif name == "approval_resolved":
            ref = str(extra.get("approvalId") or "")
            if ref:
                self._close_need(agent, ref, need_outcome(extra.get("outcome")), at)
        elif name == "provider_disconnected":
            for (owner, ref) in [k for k in self.needs if k[0] == agent]:
                self._close_need(owner, ref, "gone", at)

    def _roster_kind(self, agent):
        for row in self.ctx.roster_rows() or []:
            if str(row.get("key")) == agent:
                return row.get("providerKind") or ""
        return ""

    def _latest_run(self, agent):
        best = None
        for run in self.runs.values():
            if run["agent"] == agent and (best is None or run["start"] >= best["start"]):
                best = run
        return best

    def _end_run(self, run_id, outcome, at):
        run = self.runs.pop(run_id, None)
        if run is None:
            return
        _remember(self.ended, run_id)
        text = str(outcome or "").strip().lower() or None
        self.emit("run", run["agent"], provider=run["provider"], ref=run_id, phase="end", outcome=text,
                  ok=outcome_ok(text), ms=max(0, at - run["start"]), tools=dict(run["tools"]), at=at)
        self._close_where(lambda n: n.get("run") == run_id and n.get("src") == "life", "gone", at)

    # ── 3. activity observer (OpenClaw tools) ──
    def on_activity(self, agent_id, event):
        try:
            source = str(event.get("source") or "")
            if not source.startswith("openclaw") or source == "openclaw-session-tool":
                return   # other providers' tools come through the lifecycle tap, session.tool through the event tap
            phase = str(event.get("phase") or "").lower()
            if phase not in START_PHASES:
                return
            name, args = _unwrap(event.get("toolName"), event.get("arguments"))   # (a deferred tool's wrapper)
            if not self._first_call(event.get("runId"), event.get("toolCallId")):
                return   # the same call already came as a session.tool frame
            target = None
            if name in HANDOFF_TOOLS:
                for value in (args.get("agentId"), args.get("toAgentId"), _agent_of_key(args.get("sessionKey"))):
                    if isinstance(value, str) and value.strip():
                        target = value.strip()
                        break
            self._put(self._activity_event, str(agent_id or ""), name, str(event.get("runId") or ""), target,
                      self.now_ms())
        except Exception:
            return

    def _activity_event(self, agent, name, run_id, target, at):
        if not agent:
            return
        run = self.runs.get(run_id) or self._latest_run(agent)
        if run is not None:
            run["tools"][events.tool_kind(name)] += 1
        if target and name in HANDOFF_TOOLS:
            self._handoff(agent, self.status_key(target), HANDOFF_TOOLS[name], run_id or None, "openclaw", at)

    def _handoff(self, sender, receiver, via, ref, provider, at=None):
        if not sender or not receiver or sender == receiver:
            return None
        now = self.now()
        last = self.pairs.get((sender, receiver))
        if last is not None and now - last < HANDOFF_PAIR_S:
            return None
        frame = self.emit("handoff", sender, "handoffs", to=receiver, via=via, ref=ref, provider=provider, at=at)
        if frame is not None:
            self.pairs[(sender, receiver)] = now
            if len(self.pairs) > 500:
                for pair in [p for p, t in self.pairs.items() if now - t >= HANDOFF_PAIR_S]:
                    self.pairs.pop(pair, None)
        return frame

    def _first_call(self, run_id, call):
        """False when this OpenClaw tool call was already counted: agent ``tool`` stream frames and
        ``session.tool`` frames may both report one call; they share the run:toolCallId key."""
        if not call:
            return True
        seen_key = f"{run_id or ''}:{call}"
        if seen_key in self._tool_calls:
            return False
        _remember(self._tool_calls, seen_key)
        return True

    # ── 4. event tap (OpenClaw session frames) ──
    def on_gateway_event(self, event_type, payload):
        try:
            payload = _dict(payload)
            row = _dict(payload.get("session"))
            key = str(payload.get("sessionKey") or row.get("key") or payload.get("key") or "")
            if not key:
                return
            agent = str(payload.get("agentId") or row.get("agentId") or _agent_of_key(key))
            if event_type == "session.tool":
                # live frames: {runId, stream, data: {phase, name, toolCallId, args}, sessionKey, agentId, session}
                data = _dict(payload.get("data")) if isinstance(payload.get("data"), dict) else payload
                phase = str(data.get("phase") or payload.get("phase") or payload.get("status") or "").lower()
                # (a deferred tool's wrapper, tool_call / dispatch_action, is its inner tool)
                name, args = _unwrap(data.get("name") or data.get("toolName") or payload.get("name"),
                                     data.get("args") or data.get("arguments") or payload.get("args"))
                call = str(data.get("toolCallId") or payload.get("toolCallId") or "")
                if phase not in START_PHASES or not name:
                    return
                if not self._first_call(payload.get("runId"), call):
                    return
                target = None
                if name in HANDOFF_TOOLS:
                    for value in (args.get("agentId"), args.get("toAgentId"), _agent_of_key(args.get("sessionKey"))):
                        if isinstance(value, str) and value.strip():
                            target = value.strip()
                            break
                self._put(self._activity_event, _agent_of_key(key) or agent, name, str(payload.get("runId") or ""),
                          target, self.now_ms())
                return
            if event_type == "session.message":
                message = _dict(payload.get("message"))
                role = str(message.get("role") or payload.get("role") or "")
                if role != "user":
                    return
                provenance = _dict(message.get("provenance") or payload.get("provenance"))
                info = {"kind": "message", "key": key, "agent": agent,
                        "inter": provenance.get("kind") == "inter_session",
                        "from": _agent_of_key(provenance.get("sourceSessionKey")),
                        "channel": None if provenance.get("kind") == "inter_session"
                        else channel_of_session(row, key, payload)}
            elif event_type == "sessions.changed":
                if not is_helper_key(key):
                    return
                info = {"kind": "child", "key": key, "agent": _agent_of_key(key),
                        "active": bool(row.get("hasActiveRun") if row else payload.get("hasActiveRun"))
                        and not (row.get("endedAt") or payload.get("endedAt"))}
            else:
                return
            self._put(self._gateway_event, info, self.now_ms())
        except Exception:
            return

    def _gateway_event(self, info, at):
        agent = self.status_key(info.get("agent"))
        if not agent:
            return
        if info["kind"] == "message":
            if info["inter"]:
                sender = self.status_key(info.get("from"))
                if sender and sender != agent:
                    self._handoff(sender, agent, "send", None, "openclaw", at)
            elif info.get("channel"):
                self.emit("visitor", agent, "visitors", provider="openclaw", channel=info["channel"],
                          session=info["key"], at=at)
        elif info["kind"] == "child":
            bucket = self.children.setdefault(agent, {})
            had = info["key"] in bucket
            if info["active"]:
                bucket[info["key"]] = self.now()
            else:
                bucket.pop(info["key"], None)
            if had != info["active"]:
                self._set_helpers(agent, "openclaw-sessions", len(bucket))

    # ── 7. the provider layer's bus (v0.11) ──
    def layer_office_id(self, cid, native):
        if self._layer_office is not None:
            return self._layer_office(cid, native)
        try:
            import provider_layer_ids
            ids = provider_layer_ids.ids()
            return ids.office_for(cid, native) if ids is not None else None
        except Exception:
            return None

    def on_layer(self, event):
        """One layer bus event (tap: copies a few fields; runs before presence's lifecycle for the same event)."""
        try:
            kind = event.get("type")
            if kind not in LAYER_KINDS:
                return
            if kind == "run.start" and event.get("runId") and not event.get("outside"):
                _remember(self._hub_runs, str(event["runId"]))    # (its lifecycle is "hermes", not the legacy path)
            if kind == "approval.requested" and event.get("approvalId"):
                _remember(self._hub_approvals, str(event["approvalId"]))   # (one sign: this one, with its chat)
            data = {name: event.get(name) for name in LAYER_FIELDS if name in event}
            for name in ("keys", "waiting"):
                if isinstance(event.get(name), list):
                    data[name] = [str(x) for x in event[name][:200]]
            if isinstance(event.get("sources"), dict):
                data["sources"] = {str(k): str(v or "") for k, v in list(event["sources"].items())[:200]}
            task = event.get("task")
            if isinstance(task, dict):
                data["task"] = {name: task.get(name) for name in ("id", "taskId", "status", "runtime", "kind",
                                                                  "sourceId", "runId") if name in task}
            call = f"{event.get('runId')}:{event.get('toolId')}"
            if kind == "tool.update":
                # (a wrapped tool's arguments may come after its start: OpenClaw's deferred tools via tool_call)
                if call not in self._layer_tools or not event.get("raw"):
                    return
                kind, data["type"], data["name"] = "tool.start", "tool.start", self._layer_tools.pop(call)
            if kind == "tool.start" and (data.get("name") in HANDOFF_TOOLS or data.get("name") in DEFERRED_WRAPPERS
                                          or str(data.get("name") or "").startswith("openclaw:")):
                try:
                    data["args"] = _dict(json.loads(event.get("raw") or event.get("input") or "{}"))
                except (TypeError, ValueError):
                    data["args"] = {}
                # (OpenClaw's deferred tools: tool_call / dispatch_action {id, args}; the id is a search result's
                # "openclaw:core:sessions_send" or the bare tool name)
                data["name"], data["args"] = _unwrap(data.get("name"), data["args"])
                if not data["args"] and data.get("name") in HANDOFF_TOOLS:
                    _remember(self._layer_tools, call, limit=200)
                    self._layer_tools[call] = data["name"]
                    return
        except Exception:
            return
        self._put(self._layer_event, data, self.now_ms())

    def _layer_event(self, data, at):
        cid = str(data.get("connectionId") or "")
        provider = "openclaw" if data.get("kind") == "openclaw" else "hermes"
        plcid = f"pl-{cid}"
        kind = data.get("type")
        if kind in ("provider.status", "provider.disconnected"):
            state = str(data.get("state") or "offline").lower()
            if kind == "provider.status" and state == "connected":
                self.layer_up[plcid] = self.now()
            if kind == "provider.disconnected" or state in DOWN_STATES or state == "pairing":
                self._close_where(lambda n: n.get("cid") == plcid, "gone", at)
                for state_key in [k for k in self.layer_act if k[0] == plcid]:
                    self._layer_gone(state_key, at)
            return
        run = str(data.get("runId") or "")
        info = self.layer_runs.get(run) if run else None
        session = str(data.get("sessionKey") or (info or {}).get("session") or "") or None
        native = layer_native(cid, data.get("agentKey") or (info or {}).get("native")
                              or (_agent_of_key(session) if provider == "openclaw" else ""))
        if kind == "run.start":
            if run:
                self.layer_runs[run] = {"native": native, "session": session}
                while len(self.layer_runs) > LAYER_RUNS_MAX:
                    self.layer_runs.popitem(last=False)
            # (a run of another channel the layer follows for a page or the floor's bubbles is not the office's own:
            # its session keeps its visitors, alarm clocks and journal rows from agent.activity)
            if session and not data.get("outside"):
                _remember(self.office_sessions, session)
            return
        if kind == "run.end":
            self.layer_runs.pop(run, None)
            if run:
                self._close_where(lambda n: n.get("run") == run and n.get("src") == "hub", "gone", at)
            return
        if kind == "agent.need" and data.get("state") == "closed":
            ref = str(data.get("needId") or "")
            for (owner, need_ref) in [k for k in self.needs if k[1] == ref]:
                self._close_need(owner, need_ref, need_outcome(data.get("outcome")), at)
            return
        if kind in ("approval.resolved", "question.resolved"):
            ref = str(data.get("approvalId") or data.get("questionId") or "")
            outcome = data.get("status") or data.get("decision")
            if kind == "approval.resolved" and not outcome:
                outcome = "answered"
            for (owner, need_ref) in [k for k in self.needs if k[1] == ref]:
                self._close_need(owner, need_ref, need_outcome(outcome), at)
            return
        office = self.layer_office_id(cid, native) if native else None
        agent = self.status_key(office) if office else ""
        if not agent:
            return
        self.agent_cid[agent] = plcid
        if kind in ("approval.requested", "question.requested", "agent.need"):
            ref = str(data.get("approvalId") or data.get("questionId") or data.get("needId") or "")
            need = data.get("need") or ("approval" if kind.startswith("approval") else "question")
            if ref:
                self._open_need(agent, ref, need, provider, src="hub", cid=plcid, run=run or None, session=session,
                                card=ref, expires=data.get("expiresAt"), at=at)
                if session:   # the card replaces a bare "waiting" sign for that chat
                    self._close_need(agent, f"wait:{session}", "gone", at)
        elif kind == "tool.start":
            name = str(data.get("name") or "")
            args = data.get("args") or {}
            target = next((layer_native(cid, v.strip()) for v in (args.get("agentId"), args.get("toAgentId"),
                                               _agent_of_key(args.get("sessionKey")))
                           if isinstance(v, str) and v.strip()), "")
            if name in HANDOFF_TOOLS and target:
                other = self.layer_office_id(cid, target)
                if other:
                    self._handoff(agent, self.status_key(other), HANDOFF_TOOLS[name], run or None, provider, at)
        elif kind == "agent.helpers":
            self._set_helpers(agent, "layer-children", int(data.get("children") or 0))
        elif kind == "session.task":
            task = dict(data.get("task") or {})
            change = str(data.get("change") or "").lower()
            self._task(agent, provider, {"taskId": data.get("taskId") or task.get("id"), "task": task,
                                         "change": "removed" if change == "deleted" else change}, at, session)
        elif kind == "agent.activity":
            self._layer_activity(plcid, provider, agent, data, at)

    @staticmethod
    def _layer_key_kind(provider, key, source):
        """(channel, cron job ref) of a busy session key: an outside channel is a visitor, a scheduled job an alarm."""
        if provider == "openclaw":
            parts = str(key).split(":")
            third = parts[2].lower() if len(parts) > 3 and parts[0] == "agent" else ""
            if third == "cron":
                return None, parts[3]
            return (events.channel_of(third) if third else None), None
        source = str(source or "").strip().lower()
        if source == "cron":
            return None, f"session:{key}"
        return events.channel_of(source), None

    def _layer_activity(self, plcid, provider, agent, data, at):
        state_key = (plcid, agent)
        # (the layer reports an agent only when it changes: a first report right after its connection came up says what
        # was already going (no arrivals); any other first report is a real start from idle)
        baseline = state_key not in self.layer_act and self.now() - self.layer_up.get(plcid, -1e9) < LAYER_BASELINE_S
        state = self.layer_act.setdefault(state_key, {"keys": {}, "waiting": set(), "subs": set()})
        keys = list(data.get("keys") or []) if data.get("active") else []
        sources = data.get("sources") or {}
        before = state["keys"]
        now_keys = {key: str(sources.get(key) or before.get(key) or "") for key in keys}
        subs = {key for key in now_keys if is_helper_key(key)}
        for key in sorted(set(now_keys) - set(before)):
            if key in subs or key in self.office_sessions:
                continue
            channel, cron = self._layer_key_kind(provider, key, now_keys[key])
            if not baseline:
                if channel:
                    self.emit("visitor", agent, "visitors", provider=provider, channel=channel, session=key, at=at)
                elif cron:
                    # (the layer names the job by its id only: its name from the provider, as the cron frame has it)
                    name = "" if provider != "openclaw" or cron.startswith("session:") else str(
                        self.ctx.call("cron_job_name", plcid, cron, default="") or "")
                    self._cron_fire(agent, provider, ref=cron, name=name or None, at=at, session=key)
            ref = f"outside:{plcid}:{key}"   # a run started outside the office: its journal row (how long it ran)
            if not baseline and ref not in self.runs and ref not in self.ended:
                self.runs[ref] = {"agent": agent, "provider": provider, "start": at, "tools": collections.Counter(),
                                  "gone": None, "outside": True}
                self.emit("run", agent, provider=provider, ref=ref, phase="start", at=at)
        for key in sorted(set(before) - set(now_keys)):
            if key in state["subs"] or key in self.office_sessions:
                continue
            _channel, cron = self._layer_key_kind(provider, key, before[key])
            if cron:
                self._cron_done(agent, provider, ref=cron, at=at)
            self._end_run(f"outside:{plcid}:{key}", None, at)
        state["keys"] = now_keys
        if subs != state["subs"]:
            state["subs"] = subs
            self._set_helpers(agent, "layer-subagents", len(subs))
        waiting = set(data.get("waiting") or []) & set(now_keys)
        for key in sorted(waiting - state["waiting"]):
            if not any(n.get("session") == key and n.get("src") == "hub" and owner == agent
                       for (owner, _r), n in self.needs.items()):
                self._open_need(agent, f"wait:{key}", "input", provider, src="wait", cid=plcid, session=key, at=at)
        for key in sorted(state["waiting"] - waiting):
            self._close_need(agent, f"wait:{key}", "answered" if key in now_keys else "gone", at)
        state["waiting"] = waiting

    def _layer_gone(self, state_key, at):
        """The connection went: what it was doing is over (no arrivals until it reports again)."""
        state = self.layer_act.pop(state_key, None)
        if not state:
            return
        plcid, agent = state_key
        for key in state["keys"]:
            self._end_run(f"outside:{plcid}:{key}", "gone", at)
        if state["subs"]:
            self._set_helpers(agent, "layer-subagents", 0)
        self._set_helpers(agent, "layer-children", 0)

    # ── 6. SMS log tail ──
    def poll_sms(self):
        owner = self.ctx.call("sms_owner", default=None)
        paths = self.ctx.call("sms_paths", default=None) or []
        if not owner:
            self.sms.clear()
            return 0
        seen = 0
        for path in [p for p in paths if isinstance(p, str)][:4]:
            try:
                stat = os.stat(path)
            except OSError:
                self.sms.pop(path, None)
                continue
            state = self.sms.get(path)
            if state is None:
                self.sms[path] = [stat.st_ino, stat.st_size]   # start at the end: old texts are history
                continue
            if stat.st_ino != state[0] or stat.st_size < state[1]:
                state[0], state[1] = stat.st_ino, 0           # rotated or truncated: a new file
            if stat.st_size <= state[1]:
                continue
            try:
                with open(path, "rb") as handle:
                    handle.seek(state[1])
                    chunk = handle.read(min(SMS_READ_MAX, stat.st_size - state[1]))
            except OSError:
                continue
            end = chunk.rfind(b"\n")
            if end < 0:
                if len(chunk) >= SMS_READ_MAX:
                    state[1] += len(chunk)    # one giant line: skip it
                continue
            state[1] += end + 1
            for line in chunk[:end].splitlines():
                try:
                    row = json.loads(line.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if isinstance(row, dict) and row.get("type") == "inbound":
                    seen += 1
        if seen:
            self.emit("visitor", self.status_key(owner), "visitors", provider="office", channel="sms")
        return seen

    # ── reconciliation ──
    def reconcile(self):
        """Close what presence and the OpenClaw books no longer hold (after GONE_GRACE_S), drop
        OpenClaw subagent sessions never reported idle, and re-count interns."""
        now, at = self.now(), self.now_ms()
        snapshot = None
        if self.gp is not None and hasattr(self.gp, "activity_snapshot"):
            try:
                snapshot = self.gp.activity_snapshot()
            except Exception:
                snapshot = None
        if snapshot is not None:
            live_runs, live_approvals = snapshot.get("runs") or {}, snapshot.get("approvals") or {}
            for run_id, run in list(self.runs.items()):
                if run.get("outside"):
                    continue   # (a layer session's run: its activity report ends it)
                if run_id in live_runs:
                    run["gone"] = None
                elif run["gone"] is None:
                    run["gone"] = now
                elif now - run["gone"] >= GONE_GRACE_S:
                    self._end_run(run_id, "gone", at)
            for (agent, ref), info in list(self.needs.items()):
                if info["src"] != "life":
                    continue
                if ref in live_approvals:
                    info["gone"] = None
                elif info["gone"] is None:
                    info["gone"] = now
                elif now - info["gone"] >= GONE_GRACE_S:
                    self._close_need(agent, ref, "gone", at)
        pending = self._openclaw_pending()
        if pending is not None:
            for (agent, ref), info in list(self.needs.items()):
                if info["src"] != "hub" or info["provider"] != "openclaw":
                    continue
                if ref in pending:
                    info["gone"] = None
                elif info["gone"] is None:
                    info["gone"] = now
                elif now - info["gone"] >= GONE_GRACE_S:
                    self._close_need(agent, ref, "gone", at)
        for agent, bucket in list(self.children.items()):
            stale = [key for key, seen in bucket.items() if now - seen > CHILD_STALE_S]
            for key in stale:
                bucket.pop(key, None)
            if stale:
                self._set_helpers(agent, "openclaw-sessions", len(bucket))

    def _openclaw_pending(self):
        """Ids the OpenClaw adapter's books still hold (none once the gateway is no longer set up), or
        None when that cannot be known now (adapter not running)."""
        if not self.ctx.fn("openclaw_adapter"):
            return None
        if not self.ctx.call("openclaw_configured", default=False):
            return set()
        adapter = self.ctx.call("openclaw_adapter", default=None)
        if adapter is None or getattr(adapter, "_subscription", None) is None:
            return None
        ids = set()
        for book in (getattr(adapter, "approvals", None), getattr(adapter, "questions", None)):
            if book is not None and hasattr(book, "all_pending"):
                ids.update(str(row.get("id")) for row in book.all_pending())
        return ids

    # ── thread ──
    def drain(self):
        handled = 0
        while self._q:
            try:
                func, args = self._q.popleft()
            except IndexError:
                break
            try:
                func(*args)
            except Exception as exc:  # one bad signal never stops the others
                print(f"[office-life] source skipped: {type(exc).__name__}: {exc}")
            handled += 1
        return handled

    def tick(self):
        now = self.now()
        self._flush_interns()
        if now >= self._next_sms:
            self._next_sms = now + SMS_EVERY_S
            try:
                self.poll_sms()
            except Exception:
                pass
        if now >= self._next_reconcile:
            self._next_reconcile = now + RECONCILE_EVERY_S
            try:
                self.reconcile()
            except Exception:
                pass

    def _timeout(self):
        due = [self._next_sms, self._next_reconcile] + list(self.intern_due.values())
        return max(0.05, min(due) - self.now()) if due else 1.0

    def _run(self):
        while not self._stop.is_set():
            self._wake.wait(min(5.0, self._timeout()))
            self._wake.clear()
            if self._stop.is_set():
                break
            self.drain()
            self.tick()

    def on_settings(self, _settings):
        for agent in set(self.helpers) | set(self.intern_sent):
            self._intern_changed(agent)
        if self.ctx.enabled():
            self.boot_openclaw()
        self._wake.set()

    # ── 5. OpenClaw at boot + cron subscription ──
    def boot_openclaw(self):
        """Start the OpenClaw adapter (approvals/questions/tasks flow without an open chat page),
        seed pending approvals once and open the cron subscription. Off the boot thread."""
        with self._boot_lock:
            if self._booted or not self.ctx.enabled() or not self.ctx.call("openclaw_configured", default=False):
                return False
            self._booted = True
        thread = threading.Thread(target=self._boot_openclaw_main, name="office-life-openclaw", daemon=True)
        thread.start()
        return True

    def _boot_openclaw_main(self):
        try:
            self.ctx.call("openclaw_start")
            adapter = self.ctx.call("openclaw_adapter", default=None)
            if adapter is not None and hasattr(adapter, "seed_approvals"):
                adapter.seed_approvals()
        except Exception as exc:
            print(f"[office-life] OpenClaw start skipped: {type(exc).__name__}: {exc}")
        if self._cron_thread is None and not self._stop.is_set():
            self._cron_thread = threading.Thread(target=self._cron_main, name="office-life-cron", daemon=True)
            self._cron_thread.start()

    def _cron_subscribe(self):
        adapter = self.ctx.call("openclaw_adapter", default=None)
        if adapter is None or not hasattr(adapter, "subscribe_events"):
            return None
        self._cron_client = self.ctx.call("openclaw_client", default=None)
        return adapter.subscribe_events({"cron"}, 256)

    def _cron_close(self):
        sub, self._cron_sub = self._cron_sub, None
        if sub is not None:
            try:
                sub.close()
            except Exception:
                pass

    def _cron_main(self):
        while not self._stop.is_set():
            if self._cron_sub is None:
                try:
                    self._cron_sub = self._cron_subscribe()
                except Exception:
                    self._cron_sub = None
                if self._cron_sub is None:
                    self._stop.wait(CLIENT_CHECK_S)
                    continue
            try:
                frame = self._cron_sub.get(timeout=1.0)
            except queue.Empty:
                if time.monotonic() >= self._next_client_check:
                    self._next_client_check = time.monotonic() + CLIENT_CHECK_S
                    client = self.ctx.call("openclaw_client", default=None)
                    if client is not self._cron_client or getattr(self._cron_sub, "_closed", False):
                        self._cron_close()   # the shared client was replaced: subscribe again
                continue
            except Exception:
                self._cron_close()
                self._stop.wait(5.0)
                continue
            if isinstance(frame, dict) and frame.get("type") == "event":
                self.on_cron_frame(frame)
        self._cron_close()

    # ── wiring ──
    def attach(self):
        """Install the taps (hub first, presence taps, settings listener)."""
        if self.hub is not None:
            try:
                self._removers.append(self.hub.add_listener(self.on_hub, first=True))
            except TypeError:
                self._removers.append(self.hub.add_listener(self.on_hub))
        if self.gp is not None:
            for name, tap in (("add_lifecycle_listener", self.on_lifecycle),
                              ("add_activity_observer", self.on_activity),
                              ("add_event_tap", self.on_gateway_event)):
                adder = getattr(self.gp, name, None)
                if callable(adder):
                    self._removers.append(adder(tap))
        self._removers.append(self.ctx.bus.add_event_listener(self._on_bus_event))
        self.ctx.on_settings(self.on_settings)

    def _on_bus_event(self, ev):
        """A need closed elsewhere (the scheduler's expiry) is forgotten here too."""
        if ev.get("type") == "needs.close" and (ev.get("agent"), ev.get("ref")) in self.needs:
            self._put(self.needs.pop, (ev.get("agent"), ev.get("ref")), None)

    def start(self):
        self.attach()
        self._thread = threading.Thread(target=self._run, name="office-life-sources", daemon=True)
        self._thread.start()
        self.boot_openclaw()
        return self

    def stop(self):
        self._stop.set()
        self._wake.set()
        for remove in self._removers:
            try:
                remove()
            except Exception:
                pass
        self._removers = []
        self._cron_close()


SOURCES = None
# No module-level ``drain()`` on purpose: the sources thread drains its own queue (1 s intern debounce,
# SMS tail, reconcile), so the scheduler's clock never drains it a second time (one writer for the
# sources state). The scheduler hears ``run`` start/end through ``bus.add_event_listener``.


def start(ctx):
    """Called once by ``office_life.start``."""
    global SOURCES
    if SOURCES is not None:
        return SOURCES
    try:
        import gateway_presence as presence
    except ImportError:
        presence = None
    try:
        import provider_hub
        hub = provider_hub.HUB
    except ImportError:
        hub = None
    SOURCES = Sources(ctx, presence=presence, hub=hub).start()
    return SOURCES


def stop():
    """Idempotent (atexit and the server's shutdown may both call it)."""
    global SOURCES
    sources, SOURCES = SOURCES, None
    if sources is not None:
        sources.stop()
