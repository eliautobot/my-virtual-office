// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// What is going on now on the provider bus, told first to an office server that (re)connects to it (vo-host.mjs
// /api/pl/internal/bus). The layer reaches its gateways before the office server listens (and a listener can reconnect):
// events with no listener are gone, and a provider tells a state only when it changes — OpenClaw's agent.activity for an
// agent already mid-run is sent once, at the layer's connect. So an agent busy when the office (re)started read idle until
// its state changed again (an agent at work showed idle in the office). A new listener gets, in order:
//   bus.hello {boot}   (boot: this layer process; a different one means the runs the listener knew are gone)
//   each connection's last provider.status / provider.disconnected
//   each agent.activity that is active
//   each open run's run.start (outside ones marked so) and the tool.start of each step still running in it
//   bus.synced {replayed}   (what the listener knew and was not told again here is over)
// every replayed event marked replay: true. Bounded; a run with no event for RUN_QUIET_MS is not told again.

import crypto from 'node:crypto';

const RUNS_MAX = 500;
const TOOLS_PER_RUN = 20;
const CONNS_MAX = 200;
const ACTIVITY_MAX = 2000;
export const RUN_QUIET_MS = 6 * 60 * 60 * 1000;

export class BusState {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.boot = crypto.randomBytes(8).toString('hex');
    this.conns = new Map();      // connection id -> its last provider.status / provider.disconnected
    this.activity = new Map();   // "<connection>|<agent>" -> its last agent.activity, while active
    this.runs = new Map();       // run id -> { start, tools: Map(toolId -> tool.start), at }
  }
  /** One bus event (every one, listener or not). */
  take(e) {
    if (!e || typeof e !== 'object') return;
    const cid = String(e.connectionId ?? '');
    switch (e.type) {
      case 'provider.status':
      case 'provider.disconnected': {
        if (!cid) return;
        this.conns.delete(cid); this.conns.set(cid, e);
        if (this.conns.size > CONNS_MAX) this.conns.delete(this.conns.keys().next().value);
        if (e.type === 'provider.disconnected' || e.state !== 'connected') {
          // (nothing is known to run there any more: the layer ends its runs, the provider's activity is gone)
          for (const [id, r] of this.runs) if (String(r.start.connectionId ?? '') === cid) this.runs.delete(id);
          for (const [k, a] of this.activity) if (String(a.connectionId ?? '') === cid) this.activity.delete(k);
        }
        return;
      }
      case 'agent.activity': {
        const k = `${cid}|${e.agentKey}`;
        this.activity.delete(k);
        if (e.active) {
          this.activity.set(k, e);
          if (this.activity.size > ACTIVITY_MAX) this.activity.delete(this.activity.keys().next().value);
        }
        return;
      }
      case 'run.start': {
        if (!e.runId) return;
        const was = this.runs.get(e.runId);
        this.runs.delete(e.runId);
        this.runs.set(e.runId, { start: was ? was.start : e, tools: was ? was.tools : new Map(), at: this.now() });
        if (this.runs.size > RUNS_MAX) this.runs.delete(this.runs.keys().next().value);
        return;
      }
      case 'run.end': { this.runs.delete(e.runId); return; }
      case 'tool.start': {
        const r = this.runs.get(e.runId);
        if (!r || !e.toolId) return;
        r.at = this.now();
        r.tools.delete(e.toolId); r.tools.set(e.toolId, e);
        if (r.tools.size > TOOLS_PER_RUN) r.tools.delete(r.tools.keys().next().value);
        return;
      }
      case 'tool.end': { const r = this.runs.get(e.runId); if (r) { r.at = this.now(); r.tools.delete(e.toolId); } return; }
      default: {
        // (a run that still says something is still going)
        const r = e.runId && this.runs.get(e.runId);
        if (r) r.at = this.now();
      }
    }
  }
  /** What a new listener is told first, in order (see the top of this file). */
  replay() {
    const now = this.now(), out = [{ type: 'bus.hello', boot: this.boot }];
    const mark = e => ({ ...e, replay: true });
    for (const e of this.conns.values()) out.push(mark(e));
    for (const e of this.activity.values()) out.push(mark(e));
    for (const [id, r] of this.runs) {
      if (now - r.at > RUN_QUIET_MS) { this.runs.delete(id); continue; }
      out.push(mark(r.start));
      for (const t of r.tools.values()) out.push(mark(t));
    }
    out.push({ type: 'bus.synced', boot: this.boot, replayed: out.length - 1 });
    return out;
  }
}
