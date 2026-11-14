// v0.13 presence: the chat window's Tasks panel on OpenClaw 2026.11 (no task ledger) lists the agent's helpers from their
// sessions (agent:<id>:subagent:<uuid>, agent:<id>:acp:<uuid>; sessions.list rows with spawnedBy, status, hasActiveRun,
// startedAt/endedAt, label), live from sessions.changed. Rows as `openclaw gateway call sessions.list` returned them on
// 2026.11.2. node --test; no gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkTasks, NO_LEDGER, sessionTask } from '../app/provider-layer/server/providers/openclaw/tasks.js';

const CHAT = 'agent:main:dashboard:312d';
const OTHER = 'agent:main:dashboard:9aee';
const T0 = 1794588474555;
const row = (key, o = {}) => ({ key, agentId: 'main', kind: 'direct', classification: 'subagent', createdVia: 'spawn',
  spawnedBy: CHAT, parentSessionKey: CHAT, childOwnerSessionKeys: [CHAT], status: 'running', hasActiveRun: true,
  startedAt: T0, createdAt: T0 - 50, updatedAt: T0 + 1000, endedAt: null, label: 'VO: helper', ...o });
const ROWS = [
  { key: CHAT, agentId: 'main', status: 'done', hasActiveRun: false, hasActiveSubagentRun: true, childSessions: ['x'], label: 'the chat' },
  row('agent:main:subagent:aaa', { label: 'VO: performance audit' }),
  row('agent:main:subagent:bbb', { label: 'VO: seat reach', hasActiveSubagentRun: true }),
  row('agent:main:subagent:ccc', { label: 'VO: dots', status: 'done', hasActiveRun: false, endedAt: T0 + 9000 }),
  row('agent:main:subagent:ddd', { label: 'VO: broken', status: 'failed', hasActiveRun: false, endedAt: T0 + 5000 }),
  row('agent:main:acp:eee', { label: 'ACP child' }),
  row('agent:main:subagent:fff', { label: 'other chat helper', spawnedBy: OTHER, parentSessionKey: OTHER, childOwnerSessionKeys: [OTHER] }),
  { key: 'agent:main:telegram:direct:5', agentId: 'main', status: 'running', hasActiveRun: true, label: 'telegram' },
];

function fakeLink({ methods = ['chat.send', 'chat.history', 'chat.abort', 'sessions.list'], spawnedByFilter = true } = {}) {
  const calls = [];
  return {
    calls, connectionId: 'c1',
    offers: m => methods.includes(m),
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'sessions.list') {
        if (params.spawnedBy && !spawnedByFilter) throw Object.assign(new Error('invalid sessions.list params'), { code: 'INVALID_REQUEST' });
        return { sessions: ROWS.filter(r => !params.spawnedBy || r.spawnedBy === params.spawnedBy) };
      }
      if (method === 'chat.history') return { messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }] };
      if (method === 'chat.abort') return { ok: true, aborted: true, runIds: ['r1'] };
      throw Object.assign(new Error(`unknown method: ${method}`), { code: 'INVALID_REQUEST' });
    },
  };
}
const make = (link, watched = new Map(), sent = []) => new LinkTasks(link, { emit: e => sent.push(e), kind: 'openclaw', watched: () => watched });

test('a chat lists its running and finished helpers (subagent and ACP sessions), not other chats\' or its channels', async () => {
  for (const spawnedByFilter of [true, false]) {
    const link = fakeLink({ spawnedByFilter });
    const r = await make(link).list({ agentKey: 'main', sessionKey: CHAT });
    assert.equal(r.unavailable, undefined);
    assert.deepEqual(r.active.map(t => t.title).sort(), ['ACP child', 'VO: performance audit', 'VO: seat reach']);
    assert.deepEqual(r.recent.map(t => [t.title, t.status]), [['VO: dots', 'completed'], ['VO: broken', 'failed']]);   // latest end first
    const a = r.active.find(t => t.title === 'VO: performance audit');
    assert.deepEqual([a.id, a.status, a.runtime, a.startedAt, a.here, a.sessionKey, a.childSessionKey],
      ['session:agent:main:subagent:aaa', 'running', 'subagent', T0, true, CHAT, 'agent:main:subagent:aaa']);
    assert.equal(a.endedAt, undefined);
    assert.equal(r.active.find(t => t.title === 'ACP child').runtime, 'acp');
    assert.equal(r.active.find(t => t.title === 'VO: seat reach').progressSummary, 'Working');   // (hasActiveSubagentRun: the helper itself)
    assert.equal(r.recent[0].endedAt, T0 + 9000);
    const lists = link.calls.filter(([m]) => m === 'sessions.list');
    assert.equal(lists[0][1].agentId, 'main');
    assert.equal(lists[0][1].spawnedBy, CHAT);
  }
});

test('all of the agent\'s helpers (scope agent), each marked whether it is this chat\'s', async () => {
  const r = await make(fakeLink()).list({ agentKey: 'main', sessionKey: CHAT, scope: 'agent' });
  assert.equal(r.active.length, 4);
  assert.deepEqual(r.active.filter(t => !t.here).map(t => t.title), ['other chat helper']);
});

test('a gateway with neither the ledger nor sessions.list still says so', async () => {
  const r = await make(fakeLink({ methods: ['chat.send'] })).list({ agentKey: 'main', sessionKey: CHAT });
  assert.deepEqual(r, { active: [], recent: [], unavailable: NO_LEDGER });
});

test('live: a helper session changing goes to the open chat once per change; its parent from the listing when the row omits it', async () => {
  const sent = [];
  const link = fakeLink();
  const lt = make(link, new Map([[CHAT, { agentId: 'main' }], ['agent:ops:main', { agentId: 'ops' }]]), sent);
  const ev = session => ({ event: 'sessions.changed', payload: { sessionKey: session.key, agentId: 'main', session } });
  lt.onEvent(ev(row('agent:main:subagent:new1', { label: 'VO: new helper' })));
  lt.onEvent(ev(row('agent:main:subagent:new1', { label: 'VO: new helper', updatedAt: T0 + 5 })));   // (same status: not again)
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].type, sent[0].sessionKey, sent[0].change, sent[0].here, sent[0].task.status, sent[0].task.title],
    ['session.task', CHAT, 'upserted', true, 'running', 'VO: new helper']);
  lt.onEvent(ev(row('agent:main:subagent:new1', { label: 'VO: new helper', status: 'done', hasActiveRun: false, endedAt: T0 + 60000 })));
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1].task.status, sent[1].task.endedAt], ['completed', T0 + 60000]);
  lt.onEvent(ev({ key: 'agent:main:telegram:direct:5', hasActiveRun: true }));   // (no helper: nothing)
  assert.equal(sent.length, 2);
  await lt.list({ agentKey: 'main', sessionKey: CHAT });
  lt.onEvent({ event: 'sessions.changed', payload: { sessionKey: 'agent:main:subagent:aaa', session: { key: 'agent:main:subagent:aaa', hasActiveRun: false, status: 'done', endedAt: T0 + 7 } } });
  assert.deepEqual([sent[2].here, sent[2].task.sessionKey, sent[2].task.status], [true, CHAT, 'completed']);
});

test('a helper\'s transcript is its session\'s chat history; Stop aborts its running turn', async () => {
  const link = fakeLink();
  const lt = make(link);
  const p = { agentKey: 'main', sessionKey: CHAT, taskId: 'session:agent:main:subagent:aaa' };
  const one = await lt.get(p);
  assert.equal(one.task.title, 'VO: performance audit');
  const h = await lt.history(p);
  assert.ok(h.messages.length >= 1);
  assert.deepEqual(link.calls.find(([m]) => m === 'chat.history')[1], { sessionKey: 'agent:main:subagent:aaa', agentId: 'main', limit: 100 });
  const c = await lt.cancel(p);
  assert.equal(c.cancelled, true);
  assert.deepEqual(link.calls.find(([m]) => m === 'chat.abort')[1], { sessionKey: 'agent:main:subagent:aaa', agentId: 'main' });
  await assert.rejects(lt.get({ ...p, taskId: 'session:agent:main:subagent:fff' }), /no longer available/);   // (another chat's)
  const done = await lt.cancel({ ...p, taskId: 'session:agent:main:subagent:ccc' });
  assert.equal(done.cancelled, false);
});

test('sessionTask: statuses and non-helpers', () => {
  assert.equal(sessionTask({ key: 'agent:main:dashboard:x', hasActiveRun: true }), null);
  assert.equal(sessionTask(row('agent:main:subagent:q', { status: 'queued', hasActiveRun: undefined })).status, 'queued');
  assert.equal(sessionTask(row('agent:main:subagent:k', { status: 'killed', hasActiveRun: false })).status, 'cancelled');
  assert.equal(sessionTask(row('agent:main:subagent:t', { status: 'timeout', hasActiveRun: false })).status, 'timed_out');
  assert.equal(sessionTask(row('agent:main:subagent:r', { status: null, hasActiveRun: true })).status, 'running');
});
