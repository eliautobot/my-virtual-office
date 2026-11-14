// Office ids of the provider layer's agents (stage C3, SHARED.md 5.6; app/provider-layer/vo-agents-bridge.mjs).
// The layer's own AgentProviders.syncAgents runs against a fake provider helper; the bridge is its useBodies hooks:
// - a migrated OpenClaw connection's agents get the gateway's ids (`main`), as 0.10 named them (their desks stay);
// - a migrated Hermes connection's new profile gets 0.10's `hermes-<old id>-<profile>`; migrated ones keep theirs;
// - a connection added in the layer gets the layer key (`prov-<id>-main`): no clash with the first gateway's `main`;
// - an agent its provider stops listing retires and comes back with the same office id; renames are told once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../app/provider-layer/server/db.js';
import { Agents, peopleResolver } from '../app/provider-layer/server/agents.js';
import { Connections } from '../app/provider-layer/server/connections.js';
import { AgentProviders } from '../app/provider-layer/server/agent-providers.js';
import { Registry } from '../app/provider-layer/server/providers/registry.js';
import { BUILTIN_MANIFESTS } from '../app/provider-layer/server/providers/manifest.js';
import { EventBus } from '../app/provider-layer/server/providers/bus.js';
import { ensureOfficeTables } from '../app/provider-layer/vo-migrate.mjs';
import { OfficeAgents } from '../app/provider-layer/vo-agents-bridge.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-pl-ids-'));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
try {
  const dbs = openDb(tmp);
  ensureOfficeTables(dbs.db);
  const w = dbs.worldId, now = Date.now();
  const registry = new Registry({ manifests: BUILTIN_MANIFESTS.filter(m => ['openclaw', 'hermes'].includes(m.id)) });
  const box = { seal: v => v, open: v => v };
  const connections = new Connections(dbs, { box, registry, can: () => true });
  const agents = new Agents(dbs, { resolver: peopleResolver(() => []) });
  const listed = new Map();   // connection id -> [{ id, name, emoji }]
  const host = { readyListeners: new Set(), ready: false, call: async (kind, method, p) => (method === 'agents' ? { agents: listed.get(Number(p.connectionId)) || [] } : {}) };
  const ap = new AgentProviders({ connections, registry, host, bus: new EventBus(), agents, push: () => {} }).start();
  const bridge = new OfficeAgents({ dbs, agents, connections });
  const told = [];
  bridge.listeners.add(e => told.push(`${e.action}:${e.officeId}`));
  const conn = (kind, label, url) => Number(dbs.db.prepare('INSERT INTO connections (world_id, kind, label, scope, owner_id, config_json, enabled, created, updated) VALUES (?, ?, ?, \'installation\', NULL, ?, 1, ?, ?)')
    .run(w, kind, label, JSON.stringify({ url }), now, now).lastInsertRowid);
  const oc = conn('openclaw', 'OpenClaw', 'ws://127.0.0.1:18748/');
  const her = conn('hermes', 'Hermes A', 'http://127.0.0.1:18747/');
  const oc2 = conn('openclaw', 'Second gateway', 'ws://127.0.0.1:18749/');
  const mark = dbs.db.prepare('INSERT INTO vo_migrated (world_id, source, connection_id, rule, created) VALUES (?, ?, ?, ?, ?)');
  mark.run(w, 'openclaw', oc, 'native', now);
  mark.run(w, 'hermes:a', her, 'hermes:a', now);
  // a profile migrated by vo-migrate.mjs (its record and office id made there)
  const quill = agents.create({ key: `prov-${her}-quill`, name: 'Quill', role: 'Hermes agent', connectionId: her, nativeId: 'quill', bodyRef: 'hermes-a-quill' }, null, { quiet: true });
  dbs.db.prepare('INSERT INTO vo_office_agents (world_id, agent_id, office_id, state, created, updated) VALUES (?, ?, ?, \'live\', ?, ?)').run(w, quill.id, 'hermes-a-quill', now, now);
  ap.useBodies(bridge);
  const office = () => Object.fromEntries(bridge.list().map(r => [r.key, `${r.officeId}/${r.state}`]));

  await test('migrated OpenClaw agents keep the gateway ids; a second gateway gets layer keys', async () => {
    listed.set(oc, [{ id: 'main', name: 'Main' }, { id: 'ops', name: 'Ops' }]);
    listed.set(oc2, [{ id: 'main', name: 'Main' }]);
    await ap.syncAgents(oc);
    await ap.syncAgents(oc2);
    const o = office();
    assert.equal(o[`prov-${oc}-main`], 'main/live');
    assert.equal(o[`prov-${oc}-ops`], 'ops/live');
    assert.equal(o[`prov-${oc2}-main`], `prov-${oc2}-main/live`);
    assert.equal(agents.byKey(`prov-${oc}-main`).bodyRef, 'main');
    assert.deepEqual(told.filter(t => t.startsWith('add:')), ['add:main', 'add:ops', `add:prov-${oc2}-main`]);
  });

  await test('Hermes: migrated profile keeps its id, a new profile is named as 0.10 named it', async () => {
    listed.set(her, [{ id: 'quill', name: 'Quill' }, { id: 'Scout Two', name: 'Scout' }]);
    await ap.syncAgents(her);
    const o = office();
    assert.equal(o[`prov-${her}-quill`], 'hermes-a-quill/live');
    assert.equal(Object.entries(o).find(([k]) => k.startsWith(`prov-${her}-`) && !k.endsWith('quill'))[1], 'hermes-a-scout-two/live');
    assert.ok(!told.includes('add:hermes-a-quill'));
  });

  await test('retire, revive and rename keep the office id; maps both ways', async () => {
    told.length = 0;
    listed.set(oc, [{ id: 'main', name: 'Main' }]);
    await ap.syncAgents(oc);
    assert.equal(office()[`prov-${oc}-ops`], 'ops/retired');
    listed.set(oc, [{ id: 'main', name: 'Main Renamed' }, { id: 'ops', name: 'Ops' }]);
    await ap.syncAgents(oc);
    await ap.syncAgents(oc);   // (nothing new: nothing told)
    assert.equal(office()[`prov-${oc}-ops`], 'ops/live');
    assert.deepEqual(told, ['retire:ops', 'rename:main', 'revive:ops']);
    const main = agents.byKey(`prov-${oc}-main`);
    assert.equal(bridge.officeIdOf(main.id), 'main');
    assert.equal(bridge.agentIdOf('main'), main.id);
    assert.equal(bridge.agentIdOf('nobody'), null);
  });

  await test('an office id already taken gets a suffix', async () => {
    const third = conn('openclaw', 'Third', 'ws://127.0.0.1:18743/');
    mark.run(w, 'openclaw:third', third, 'native', now);
    listed.set(third, [{ id: 'main', name: 'Main' }]);
    await ap.syncAgents(third);
    assert.equal(office()[`prov-${third}-main`], 'main-2/live');
  });
  dbs.db.close();
  console.log(`${passed} passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
