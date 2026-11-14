"""The copied OpenClaw + Hermes layer's bus -> the office (v0.11, SHARED 5.2).

``attach(layer, status_key)`` once (server.py, right after the layer is made). Every event of the layer's bus
(vo-host's /api/pl/internal/bus, read by ``ProviderLayer``) reaches, in this order:
1. Office Life: ``office_life.sources.SOURCES.on_layer`` (needs-you signs, visitors, interns, alarm clocks, handoffs,
   the journal of runs started outside the office);
2. presence: ``gateway_presence.lifecycle_*`` (the working ring and task line on desks, the top status, the activity
   chips). Presence's lifecycle listeners give Office Life the journal of the office's own runs (outcome, tool kinds),
   as they did for 0.10's Python adapters.
Office ids come from the layer's id map (provider_layer_ids). Read only: nothing here calls a provider or a model.
"""

import collections
import threading

import gateway_presence
import layer_bubbles
import provider_layer_ids
from office_life.sources import is_helper_key, layer_native

RUNS_MAX = 500
OFFICE_KIND = "office"   # the layer kind of the office's own providers (provider-layer/server/office-bridge.mjs)
DOWN = frozenset({"offline", "error", "pairing"})
# (states, not happenings: told again when the bus (re)connects, Office Life takes them again; provider-layer/vo-bus-state.mjs)
STATE_KINDS = frozenset({"agent.activity", "provider.status", "provider.disconnected"})


class LayerLife:
    """Maps one layer's bus events to presence (and hands them to Office Life first)."""

    def __init__(self, status_key=None, presence=gateway_presence, office_for=None, sources=None):
        self.status_key = status_key or (lambda office_id: office_id)
        self.presence = presence
        self._office_for = office_for
        self._sources = sources
        self.lock = threading.Lock()
        self.runs = collections.OrderedDict()     # layer runId -> (status key, kind)
        self.streaming = set()
        self.conn_state = {}                      # connectionId -> last state told to presence
        # runs of other channels the layer follows (the floor follows every session agent.activity says works, a page the
        # one it has open): run id -> (status key, kind, connectionId) or None. Presence counts them under the agent's
        # activity ref (below), never as runs of their own: one turn is one run, whichever way the office heard of it.
        self.outside = collections.OrderedDict()
        self.activity = {}                        # presence ref -> (status key, kind, connectionId) of an active agent.activity
        self.by_runs = set()                      # refs only an outside run's events hold (agent.activity not told yet)
        self.sync = None                          # while the bus replays what goes on: {"boot", "seen"}
        self.boot = ""
        self.bubbles = layer_bubbles.LayerBubbles(resolve=self._resolve)   # the floor's chat bubbles (v0.12)

    def office_for(self, cid, native):
        if self._office_for is not None:
            return self._office_for(cid, native)
        ids = provider_layer_ids.ids()
        return ids.office_for(cid, native) if ids is not None else None

    def sources(self):
        if self._sources is not None:
            return self._sources()
        try:
            from office_life import sources
            return sources.SOURCES
        except Exception:
            return None

    def on_event(self, event):
        if not isinstance(event, dict):
            return
        # (kind "office": a run of the office's own providers in the layer's window, through the office chat bridge. The
        # office's own paths report it already, to Office Life and presence: told here too it would count twice.)
        if event.get("kind") == OFFICE_KIND:
            return
        kind = event.get("type")
        if kind in ("bus.hello", "bus.synced"):
            try:
                with self.lock:
                    self._sync(event)
            except Exception:
                pass
            return
        # (a replayed run or step this office already heard of: Office Life and the bubbles have it, told twice they would
        # count it twice; a state, or one heard of first now — the office just started — goes to them as a live one)
        run = str(event.get("runId") or "")
        if not event.get("replay") or kind in STATE_KINDS or not (run and (run in self.runs or run in self.outside)):
            src = self.sources()
            if src is not None:
                try:
                    src.on_layer(event)
                except Exception:
                    pass
            try:
                self.bubbles.on_event(event)
            except Exception:
                pass
        try:
            with self.lock:
                self._presence(event)
        except Exception:
            pass

    def _agent(self, event):
        run = str(event.get("runId") or "")
        known = self.runs.get(run) if run else None
        if known and not event.get("agentKey"):
            return known
        return self._resolve(event)

    def _resolve(self, event):
        """(office status key, provider kind) of a bus event's agent, from its connection and agent key."""
        native = layer_native(str(event.get("connectionId") or ""), event.get("agentKey"))
        if not native and event.get("kind") == "openclaw":
            parts = str(event.get("sessionKey") or "").split(":")
            native = parts[1] if len(parts) > 2 and parts[0] == "agent" else ""
        office = self.office_for(str(event.get("connectionId") or ""), native) if native else None
        key = self.status_key(office) if office else ""
        return (key, str(event.get("kind") or "")) if key else None

    def _presence(self, event):
        kind = event.get("type")
        p = self.presence
        if kind in ("provider.status", "provider.disconnected"):
            self._connection(event)
            return
        if kind not in ("agent.activity", "run.start", "run.delta", "tool.start", "tool.end", "approval.requested",
                        "approval.resolved", "run.end"):
            return
        run = str(event.get("runId") or "")
        replay = self.sync is not None and bool(event.get("replay"))
        # (a run of another channel the layer follows for a page or the floor's bubbles: presence counts it under its
        # agent's activity ref, which agent.activity holds too; its steps' titles are the task line)
        if run and (run in self.outside or (kind == "run.start" and event.get("outside"))):
            if replay:
                self.sync["seen"].add(run)
            self._outside_event(kind, run, event)
            return
        who = self._agent(event)
        if not who:
            return
        agent, provider = who
        if kind == "agent.activity":
            # (one presence run per agent and connection: a connection's agents share a gateway, never a run id; a
            # shared one let one agent's end drop another's still-running activity as stale)
            ref = self._ref(event.get("connectionId"), agent)
            self.by_runs.discard(ref)
            if event.get("active"):
                if replay:
                    self.sync["seen"].add(ref)
                self.activity[ref] = (agent, provider, str(event.get("connectionId") or ""))
                p.lifecycle_run_started(agent, ref, provider, activity_task(event))
            else:
                self.activity.pop(ref, None)
                p.lifecycle_run_finished(agent, ref, provider, "completed")
            return
        if not run:
            return
        if kind in ("run.delta", "tool.start", "approval.requested") and run not in self.runs:
            # (a run this office never saw start, or saw end — a late event: it opens no run here, nothing would end it;
            #  a step or an approval of it counts alone, its own end ends it)
            if kind == "run.delta":
                return
            run = ""
        if kind == "run.start":
            if replay:
                self.sync["seen"].add(run)
                if run in self.runs:   # (known: its state here is right, its task line too)
                    return
            self.runs[run] = who
            while len(self.runs) > RUNS_MAX:
                self.runs.popitem(last=False)
            p.lifecycle_run_started(agent, run, provider, "Working")
        elif kind == "run.delta":
            if run not in self.streaming and (event.get("text") or event.get("replace")):
                self.streaming.add(run)
                p.lifecycle_output_streaming(agent, run, provider)
        elif kind == "tool.start":
            p.lifecycle_tool_started(agent, run, str(event.get("toolId") or ""), str(event.get("name") or ""),
                                     provider, str(event.get("title") or "")[:120])
        elif kind == "tool.end":
            p.lifecycle_tool_finished(agent, run, str(event.get("toolId") or ""), provider,
                                      "failed" if event.get("ok") is False else "completed")
        elif kind == "approval.requested":
            p.lifecycle_approval_requested(agent, run, str(event.get("approvalId") or ""), provider)
        elif kind == "approval.resolved":
            p.lifecycle_approval_resolved(agent, run, str(event.get("approvalId") or ""), provider)
        elif kind == "run.end":
            self.runs.pop(run, None)
            self.streaming.discard(run)
            status = str(event.get("status") or "ok")
            p.lifecycle_run_finished(agent, run, provider, "completed" if status == "ok" else status,
                                     str(event.get("error") or "")[:200])

    @staticmethod
    def _ref(cid, agent):
        return f"presence:pl-{cid or ''}:{agent}"

    def _outside_event(self, kind, run, event):
        """An event of another channel's run. Its agent works while it runs, whatever agent.activity said (that is told
        once per change, and an office that was not listening then — starting, reconnecting — missed it): the run holds
        the agent's activity ref until it ends, its steps show as the task line, under that ref (no second run)."""
        if kind == "run.start":
            who = self._resolve(event)
            self.outside[run] = (who[0], who[1], str(event.get("connectionId") or "")) if who else None
            self.outside.move_to_end(run)
            while len(self.outside) > RUNS_MAX:
                self.outside.popitem(last=False)
        who = self.outside.get(run)
        if kind == "run.end":
            self.outside.pop(run, None)
            if who:
                self._release(*who)
            return
        if not who:
            return
        agent, provider, cid = who
        ref = self._ref(cid, agent)
        p = self.presence
        if kind in ("run.start", "run.delta", "tool.start") and ref not in self.activity:
            self.activity[ref] = who
            self.by_runs.add(ref)
            p.lifecycle_run_started(agent, ref, provider, "Working")
        if kind == "tool.start":
            p.lifecycle_tool_started(agent, ref, str(event.get("toolId") or ""), str(event.get("name") or ""),
                                     provider, str(event.get("title") or "")[:120])
        elif kind == "tool.end":
            p.lifecycle_tool_finished(agent, ref, str(event.get("toolId") or ""), provider,
                                      "failed" if event.get("ok") is False else "completed")

    def _release(self, agent, provider, cid, outcome="completed"):
        """An outside run of this agent ended: the activity ref it held ends when no other one holds it and agent.activity
        never said it (when it did, its own end ends it)."""
        ref = self._ref(cid, agent)
        if ref not in self.by_runs or any(w and w[0] == agent and w[2] == cid for w in self.outside.values()):
            return
        self.by_runs.discard(ref)
        self.activity.pop(ref, None)
        self.presence.lifecycle_run_finished(agent, ref, provider, outcome)

    def _sync(self, event):
        """The bus (re)connected and tells what goes on now, between bus.hello and bus.synced (vo-bus-state.mjs): what
        this office held and was not told again is over (its end came while nobody listened, or the layer restarted)."""
        boot = str(event.get("boot") or "")
        if event.get("type") == "bus.hello":
            self.sync = {"boot": boot, "seen": set()}
            return
        if self.sync is None:
            return
        seen, self.sync = self.sync["seen"], None
        # (a new layer process: the runs this office knew are gone with the old one; the same one: they ended meanwhile)
        outcome = "interrupted" if self.boot and boot != self.boot else "completed"
        self.boot = boot
        p = self.presence
        for run, (agent, kind) in [(r, w) for r, w in self.runs.items() if r not in seen]:
            self.runs.pop(run, None)
            self.streaming.discard(run)
            p.lifecycle_run_finished(agent, run, kind, outcome)
        for run in [r for r in self.outside if r not in seen]:
            self.outside.pop(run, None)
        for ref, (agent, kind, cid) in list(self.activity.items()):
            if ref in seen or (ref in self.by_runs and any(w and w[0] == agent and w[2] == cid for w in self.outside.values())):
                continue
            self.activity.pop(ref, None)
            self.by_runs.discard(ref)
            p.lifecycle_run_finished(agent, ref, kind, "completed")

    def _connection(self, event):
        cid = str(event.get("connectionId") or "")
        state = "offline" if event.get("type") == "provider.disconnected" else str(event.get("state") or "")
        if not cid or state not in DOWN | {"connected"} or self.conn_state.get(cid) == state:
            return
        self.conn_state[cid] = state
        ids = provider_layer_ids.ids()
        offices = ids.of_connection(cid) if ids is not None else []
        provider = str(event.get("kind") or "")
        for office in offices:
            agent = self.status_key(office)
            if not agent:
                continue
            if state == "connected":
                self.presence.lifecycle_provider_connected(agent, provider)
            else:
                self.presence.lifecycle_provider_disconnected(agent, provider, state, str(event.get("detail") or "")[:200])
        if state != "connected":   # its runs are over (the layer ends them too; presence must not keep a ring)
            for run, (agent, kind) in [(r, w) for r, w in self.runs.items()]:
                if kind == provider and agent in {self.status_key(o) for o in offices}:
                    self.runs.pop(run, None)
                    self.presence.lifecycle_run_finished(agent, run, kind, "interrupted")
            # (and what its gateway said its agents were doing: nothing is known to run there any more)
            for run, w in list(self.outside.items()):
                if w and w[2] == cid:
                    self.outside.pop(run, None)
            for ref, (agent, kind, conn) in list(self.activity.items()):
                if conn == cid:
                    self.activity.pop(ref, None)
                    self.by_runs.discard(ref)
                    self.presence.lifecycle_run_finished(agent, ref, kind, "interrupted")


def helper_word(n):
    return f"{n} helper" if n == 1 else f"{n} helpers"


def activity_task(event):
    """The task line of an agent.activity: its subagent sessions are helpers it started (OpenClaw runs a spawned helper in a
    session of the same agent, agent:<id>:subagent:<uuid>), so an agent whose only running sessions are helpers is
    "Waiting on 2 helpers" at its desk; with a turn of its own too, that turn's title and how many helpers run."""
    keys = [str(k) for k in (event.get("keys") or []) if k]
    helpers = sum(1 for k in keys if is_helper_key(k))
    task = str(event.get("task") or "").strip()
    if helpers and helpers == len(keys):
        return f"Waiting on {helper_word(helpers)}"[:120]
    if helpers:
        return f"{task or 'Working'} · {helper_word(helpers)}"[:120]
    return (task or "Working")[:120]


_LIFE = None


def attach(layer, status_key=None):
    """Feeds the office from this layer's bus (once per layer)."""
    global _LIFE
    if layer is None:
        _LIFE = None
        return None
    _LIFE = LayerLife(status_key=status_key)
    layer.subscribers.append(_LIFE.on_event)
    return _LIFE


def life():
    return _LIFE


def bubbles():
    """The floor's chat bubbles' store for the layer's agents (None without the layer)."""
    return _LIFE.bubbles if _LIFE is not None else None
