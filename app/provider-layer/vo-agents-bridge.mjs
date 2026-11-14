// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The office's side of the layer's agents (SHARED.md 5.6): every OpenClaw or Hermes agent the layer lists gets an office
// id, its desk and look in the office stay keyed by it. AgentProviders.useBodies(bridge) calls these hooks the way My
// Virtual World gives a provider's agent a body in its city: spawn when an agent is first listed, retire when its
// provider no longer lists it, revive when it comes back, rename on every sync.
//
// Office ids (vo_office_agents in next.db, made by vo-migrate.mjs):
// - migrated agents keep the id the office gave them in 0.10 (a Hermes profile's `hermes-<connection>-<profile>`);
// - a new agent of a migrated connection is named as 0.10 would have named it (OpenClaw: the gateway's own agent id,
//   such as `main`; Hermes: `hermes-<old connection id>-<profile>`), so its desk is where the old office put it;
// - an agent of a connection added in the layer gets the layer's key (`prov-<connection>-<agent>`): two gateways'
//   `main` agents no longer share one office id.
// - an agent of the office's own providers (kind `office`, server/office-bridge.mjs: Codex, Claude Code ... ) keeps its
//   office id exactly (its native id is the office's id for it): its desk, look and chats stay where they are. The office
//   already lists these agents, so they are neither told to the office server nor in its id map (list()): a Codex agent
//   must never look like a layer agent to server.py (its turns, A2A and presence stay the office's own).
// Changes are told to listeners ({ type: 'office.agent', action, ... }: vo-host puts them on the office server's bus).
import { isProviderKey } from './server/agent-providers.js';
import { OFFICE_KIND } from './server/office-bridge.mjs';
import { clean } from './server/agents.js';
import { ensureOfficeTables, legacyHermesId } from './vo-migrate.mjs';

export class OfficeAgents {
  /** @param {{ dbs: { db: object, worldId: string }, agents: object, connections: object, log?: object, now?: () => number }} o */
  constructor({ dbs, agents, connections, log = null, now = () => Date.now() }) {
    Object.assign(this, { agents, connections, log, now });
    this.w = dbs.worldId;
    ensureOfficeTables(dbs.db);
    const db = dbs.db;
    this.q = {
      all: db.prepare('SELECT agent_id, office_id, state FROM vo_office_agents WHERE world_id = ?'),
      byAgent: db.prepare('SELECT office_id, state FROM vo_office_agents WHERE world_id = ? AND agent_id = ?'),
      byOffice: db.prepare('SELECT agent_id FROM vo_office_agents WHERE world_id = ? AND office_id = ?'),
      ins: db.prepare('INSERT INTO vo_office_agents (world_id, agent_id, office_id, state, created, updated) VALUES (?, ?, ?, \'live\', ?, ?)'),
      state: db.prepare('UPDATE vo_office_agents SET state = ?, updated = ? WHERE world_id = ? AND agent_id = ?'),
      rule: db.prepare('SELECT rule FROM vo_migrated WHERE world_id = ? AND connection_id = ?'),
    };
    this.listeners = new Set();
    this.seen = new Map();   // agent id -> 'name|emoji' last told (rename runs on every sync)
  }

  /** How a connection's agents are named in the office: 'native', 'hermes:<old id>[:first]' (migrated) or 'key'. */
  rule(connectionId) { return (connectionId && this.q.rule.get(this.w, Number(connectionId))?.rule) || 'key'; }
  officeIdOf(agentId) { return this.q.byAgent.get(this.w, Number(agentId))?.office_id || null; }
  agentIdOf(officeId) { return this.q.byOffice.get(this.w, String(officeId))?.agent_id ?? null; }
  isOffice(a) { const c = a && a.connectionId ? this.connections.get(a.connectionId) : null; return !!c && c.kind === OFFICE_KIND; }
  freshId(a) {
    if (this.isOffice(a)) {
      const own = clean(a.nativeId, 120);
      if (own && !this.q.byOffice.get(this.w, own)) return own;
      this.log?.warn?.(`[office-agents] the office id ${own} is taken by another layer agent; ${a.key} gets its key`);
    }
    const r = this.rule(a.connectionId);
    const [, legacy, first] = r.startsWith('hermes:') ? r.split(':') : [];
    let base = r === 'native' ? clean(a.nativeId, 120) : legacy ? legacyHermesId(legacy, a.nativeId, first === 'first') : a.key;
    base = base || a.key;
    let id = base, n = 2;
    while (this.q.byOffice.get(this.w, id)) id = `${base}-${n++}`;
    return id;
  }
  fire(action, a, officeId) {
    if (this.isOffice(a)) return;   // (the office lists it already: nothing to tell)
    const e = { type: 'office.agent', action, officeId, agentId: a.id, key: a.key, connectionId: a.connectionId, nativeId: a.nativeId, name: a.name, emoji: a.emoji };
    for (const fn of this.listeners) { try { fn(e); } catch (err) { this.log?.warn?.('[office-agents] a listener failed:', err.message); } }
  }

  // ---------------------------------------------------------------- the body hooks (AgentProviders.useBodies)
  state(a) { const r = this.q.byAgent.get(this.w, a.id); return !r ? 'none' : r.state === 'retired' ? 'retired' : 'live'; }
  spawn(a) {
    const id = this.freshId(a), t = this.now();
    this.q.ins.run(this.w, a.id, id, t, t);
    this.seen.set(a.id, `${a.name}|${a.emoji}`);
    this.fire('add', a, id);
    return id;   // (kept as the agent's body_ref too)
  }
  retire(a) { this.q.state.run('retired', this.now(), this.w, a.id); this.fire('retire', a, this.officeIdOf(a.id)); }
  revive(a) { this.q.state.run('live', this.now(), this.w, a.id); this.seen.set(a.id, `${a.name}|${a.emoji}`); this.fire('revive', a, this.officeIdOf(a.id)); }
  rename(a) {
    const sig = `${a.name}|${a.emoji}`;
    if (this.seen.get(a.id) === sig) return;
    const first = !this.seen.has(a.id);
    this.seen.set(a.id, sig);
    if (!first) this.fire('rename', a, this.officeIdOf(a.id));
  }

  // ---------------------------------------------------------------- for the office server (roster, desks, chats)
  /** Every layer agent with an office id: what server.py's id map and roster rows are made from. */
  list() {
    const ids = new Map(this.q.all.all(this.w).map(r => [r.agent_id, r]));
    const out = [];
    for (const a of this.agents.list()) {
      const r = ids.get(a.id);
      if (!r || !isProviderKey(a.key)) continue;
      const c = a.connectionId ? this.connections.get(a.connectionId) : null;
      if (c && c.kind === OFFICE_KIND) continue;
      out.push({ officeId: r.office_id, state: r.state, layerId: a.id, key: a.key, kind: c ? c.kind : null, connectionId: a.connectionId,
        connection: c ? c.label : null, connectionEnabled: !!(c && c.enabled), nativeId: a.nativeId, name: a.name, emoji: a.emoji, role: a.role,
        enabled: a.enabled, access: c && c.config && c.config.access === 'chat' ? 'chat' : 'full', rule: this.rule(a.connectionId) });
    }
    return out;
  }
}
