// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// What an OpenClaw gateway's agents are doing, whatever started it (docs/features/agent-providers.md §3, live presence):
// this installation's chats, OpenClaw's other channels, its scheduled jobs and heartbeats. The gateway's own session feed
// — sessions.subscribe, then sessions.changed: the rows its Control UI shows, each with hasActiveRun — says which of its
// sessions have a turn running, without following every session's events. Per agent, working or not (and in how many
// sessions, and which: the chat window marks those chats working) goes to the provider bus as agent.activity; the presence
// coordinator decides the rest (server/presence-coordinator.js).

const SNAPSHOT = { limit: 200, sortBy: 'activity' };   // (a session with a turn running is among the most recently active)
const SETTLE_MS = 250;                                  // (a burst of changes — a turn starting — is reported once; a turn shorter than this isn't shown)
// (My Virtual Office) a run's end the feed never tells: OpenClaw 2026.11's scheduled heartbeat turn (main session) sends
// sessions.changed hasActiveRun true while it runs and, at its end, a change with phase "end" that still says
// hasActiveRun true / status running, then `heartbeat` and `cron` (action finished) events — never a change with
// hasActiveRun false (an ordinary turn sends one, reason agent.input.settled). So: after such a sign, and every
// RECONCILE_MS while any session is held running, the held rows are checked against sessions.list (the truth the Control
// UI shows, there already not running); a missed end is let go within a minute whatever its cause.
const RECHECK_MS = 1500;      // after a heartbeat / a finished cron job / a removal without its key: sessions.list again
const RECONCILE_MS = 30000;   // while a session is held running: sessions.list again
const RUNNING = /^(running|active|started|queued|pending|in[_-]?progress|streaming)$/i;
const ENDED = /^(done|complete|completed|ended|finished|failed|error|errored|killed|aborted|cancell?ed|timeout|timed[_-]?out|idle|stopped|interrupted)$/i;
const GONE = /^(delete|deleted|remove|removed|archive|archived|reset)$/i;

/** Whether a session row says a turn runs there: its hasActiveRun when a boolean, else its status; undefined = not said. */
export function rowActive(row) {
  if (!row || typeof row !== 'object') return undefined;
  if (typeof row.hasActiveRun === 'boolean') return row.hasActiveRun;
  const st = typeof row.status === 'string' ? row.status.trim() : '';
  if (RUNNING.test(st)) return true;
  if (ENDED.test(st)) return false;
  return undefined;
}

export class LinkActivity {
  /** @param {import('./link.js').GatewayLink} link  @param {{ emit: (e: object) => void, kind: string }} o */
  constructor(link, { emit, kind, recheckMs = RECHECK_MS, reconcileMs = RECONCILE_MS }) {
    Object.assign(this, { link, emit, kind, recheckMs, reconcileMs });
    this.rows = new Map();   // session key → { agentId, title } of a session with a turn running
    this.sent = new Map();   // agent id → what was last reported for it
    this.timer = null;
    this.seq = 0;              // (My Virtual Office) counts the feed's row changes ...
    this.touched = new Map();  // ... and the last one of each session key: a check never undoes a change newer than itself
    this.checkTimer = null; this.checking = false; this.checkAgain = false;
  }
  /** (Re)connected: the subscription is the connection's, so it is taken again, with the sessions as they are now. */
  async onHello() {
    if (!this.link.offers('sessions.subscribe')) return;
    try {
      const r = await this.link.request('sessions.subscribe', SNAPSHOT, { timeoutMs: 20000 });
      this.rows.clear();
      this.touched.clear();
      for (const s of (r && r.list && Array.isArray(r.list.sessions) ? r.list.sessions : [])) this.take(s);
      this.flush();
    } catch { /* presence from this installation's own runs still works */ }
  }
  /** The connection went: nothing is known to be running any more. */
  onDown() { clearTimeout(this.timer); this.timer = null; clearTimeout(this.checkTimer); this.checkTimer = null; this.rows.clear(); this.touched.clear(); this.flush(); }
  /** A sessions.changed event: its row (the nested one wins; the top level clears what it omits). Says running or not by
   *  hasActiveRun, else by its status; a removed session (reason delete, reset ...) runs nothing. (My Virtual Office) a
   *  heartbeat or a finished cron job — a run whose end the feed may not tell — has the held rows checked. */
  onEvent(evt) {
    if (!evt) return;
    if (evt.event === 'heartbeat' || (evt.event === 'cron' && evt.payload && evt.payload.action === 'finished')) { this.checkSoon(this.recheckMs); return; }
    if (evt.event !== 'sessions.changed') return;
    const p = evt.payload || {}, s = p.session || null, key = (s && s.key) || p.sessionKey || p.key;
    const reason = String((s && s.reason) || p.reason || '');
    if (!key) { if (GONE.test(reason)) this.checkSoon(this.recheckMs); return; }
    let active = rowActive(s);
    if (active === undefined) active = rowActive(p);
    if (active === undefined && (GONE.test(reason) || p.deleted === true || p.removed === true)) active = false;
    if (typeof active !== 'boolean') return;
    this.touched.set(String(key), ++this.seq);
    this.take({ ...(s || {}), key, agentId: (s && s.agentId) || p.agentId, hasActiveRun: active });
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, SETTLE_MS);
    // (a run's end whose row still says running — the heartbeat's — is checked against the listing)
    if (active && String(p.phase || (s && s.phase) || '') === 'end') this.checkSoon(this.recheckMs);
  }
  take(s) {
    if (!s || !s.key) return;
    if (s.hasActiveRun && s.agentId) this.rows.set(String(s.key), { agentId: String(s.agentId), title: String(s.label || s.derivedTitle || s.displayName || '').slice(0, 80) });
    else this.rows.delete(String(s.key));
  }
  /** (My Virtual Office) check the held rows against sessions.list in `ms` (sooner wins over a later one already set). */
  checkSoon(ms) {
    if (!this.rows.size) return;
    if (this.checkTimer && this.checkDue <= Date.now() + ms) return;
    clearTimeout(this.checkTimer);
    this.checkDue = Date.now() + ms;
    this.checkTimer = setTimeout(() => { this.checkTimer = null; this.check(); }, ms);
    this.checkTimer.unref?.();
  }
  /** The gateway's sessions.list against what is held running: a held session it lists not running (or no longer lists,
   *  the listing being complete) ends; one it lists running and was missed starts. A row the feed changed after the
   *  request went out is the feed's (newer). */
  async check() {
    if (this.checking) { this.checkAgain = true; return; }
    if (!this.rows.size || !this.link.connected || !this.link.offers('sessions.list')) return;
    this.checking = true;
    const at = this.seq;
    try {
      const r = await this.link.request('sessions.list', SNAPSHOT, { timeoutMs: 15000 });
      const list = r && Array.isArray(r.sessions) ? r.sessions : null;
      if (list) {
        const complete = list.length < SNAPSHOT.limit, seen = new Map();
        for (const row of list) if (row && row.key) seen.set(String(row.key), row);
        const newer = key => (this.touched.get(key) || 0) > at;
        for (const key of [...this.rows.keys()]) {
          if (newer(key)) continue;
          const row = seen.get(key);
          if (row ? rowActive(row) === false : complete) this.rows.delete(key);
        }
        for (const [key, row] of seen) if (!this.rows.has(key) && !newer(key) && rowActive(row) === true && row.agentId) this.take({ ...row, hasActiveRun: true });
        this.flush();
      }
    } catch { /* the next check, or the feed, tells */ }
    finally {
      this.checking = false;
      if (this.checkAgain) { this.checkAgain = false; this.checkSoon(this.recheckMs); }
      else if (this.rows.size) this.checkSoon(this.reconcileMs);   // (a failed check is tried again)
    }
  }
  /** Each agent whose state changed, to the bus. */
  flush() {
    // (My Virtual Office) while a session is held running, it is checked again every RECONCILE_MS
    if (this.rows.size) this.checkSoon(this.reconcileMs); else { clearTimeout(this.checkTimer); this.checkTimer = null; }
    const by = new Map();
    for (const [key, r] of this.rows) {
      const x = by.get(r.agentId) || { sessions: 0, title: '', keys: [] };
      // (the title is the agent's own turn's: a helper it spawned runs in a session of the same agent, agent:<id>:subagent:<uuid> (an ACP child: :acp:),
      //  and its label is the helper's job, not the agent's — the office says "Waiting on 2 helpers" for those)
      x.sessions += 1; x.keys.push(key); if (!x.title && r.title && !/^agent:[^:]+:(subagent|acp):/i.test(key)) x.title = r.title;
      by.set(r.agentId, x);
    }
    for (const agentId of new Set([...by.keys(), ...this.sent.keys()])) {
      const x = by.get(agentId), sig = x ? `${x.sessions}|${x.title}|${x.keys.sort().join(' ')}` : '';
      if ((this.sent.get(agentId) || '') === sig) continue;
      if (x) this.sent.set(agentId, sig); else this.sent.delete(agentId);
      try {
        this.emit({ type: 'agent.activity', kind: this.kind, connectionId: this.link.connectionId, agentKey: agentId, active: !!x, sessions: x ? x.sessions : 0,
          keys: x ? x.keys : [], ...(x && x.title ? { task: `Working on “${x.title}”` } : {}) });
      } catch { /* the bus refused one event */ }
    }
  }
}
