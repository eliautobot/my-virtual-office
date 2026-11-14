// v0.11 rel1102: the copied OpenClaw adapter on OpenClaw 2026.11.x and older (2026.9.x). node --test
// What 2026.11 changed that the layer meets (the gateways' own hello, 2026.9.6 vs 2026.11.2): tasks.list/get/history/
// cancel/dismiss/retry and the `task` event are gone (the task ledger was removed); live chat text comes as append deltas
// (deltaText only after the first frame) with a `replace` frame (empty) before `final`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkTasks, NO_LEDGER } from '../app/provider-layer/server/providers/openclaw/tasks.js';
import { Chat } from '../app/provider-layer/server/chat/chat.js';

const METHODS_9 = ['chat.send', 'chat.history', 'tasks.list', 'tasks.get', 'tasks.history', 'tasks.cancel'];
const METHODS_11 = ['chat.send', 'chat.history', 'sessions.list'];

function fakeLink(methods, tasks = []) {
  const calls = [];
  return {
    calls,
    offers: m => methods.includes(m),
    async request(method, params) {
      calls.push([method, params]);
      if (!methods.includes(method)) throw Object.assign(new Error(`This OpenClaw gateway does not offer ${method}`), { code: 'unsupported' });
      return { tasks: tasks.filter(t => (params.status || []).includes(t.status)) };
    },
  };
}
const lt = link => new LinkTasks(link, { emit: () => {}, kind: 'openclaw', watched: () => new Map() });

test('2026.9.x: the task list comes from tasks.list (running + finished, this chat only)', async () => {
  const link = fakeLink(METHODS_9, [
    { id: 't1', status: 'running', agentId: 'main', sessionKey: 'agent:main:s1' },
    { id: 't2', status: 'completed', agentId: 'main', sessionKey: 'agent:main:s1' },
    { id: 't3', status: 'running', agentId: 'main', sessionKey: 'agent:main:other' }]);
  const r = await lt(link).list({ agentKey: 'main', sessionKey: 'agent:main:s1' });
  assert.deepEqual(r.active.map(t => t.id), ['t1']);
  assert.deepEqual(r.recent.map(t => t.id), ['t2']);
  assert.equal(r.unavailable, undefined);
  assert.equal(link.calls.filter(([m]) => m === 'tasks.list').length, 2);
});

test('no tasks.list and no sessions.list: an empty list that says why, no gateway call, no error', async () => {
  // (v0.13: 2026.11 has sessions.list, so its helpers' sessions are the list then: test_pl_v13_helper_tasks.mjs)
  const link = fakeLink(METHODS_11.filter(m => m !== 'sessions.list'));
  for (const scope of ['chat', 'agent']) {
    const r = await lt(link).list({ agentKey: 'main', sessionKey: 'agent:main:s1', scope });
    assert.deepEqual(r, { active: [], recent: [], unavailable: NO_LEDGER });
  }
  assert.equal(link.calls.length, 0);
  assert.match(NO_LEDGER, /no background task list/);
  assert.doesNotMatch(NO_LEDGER, /—/);   // (no em dash in user text)
  // (bad requests are still bad requests)
  await assert.rejects(lt(link).list({ agentKey: 'main', sessionKey: '' }), /no tasks yet/);
});

test('the chat route passes "unavailable" through (and only a short string)', async () => {
  const self = (answer) => ({
    managed: () => ({ a: { id: 1 }, at: { scope: 'chat', sessionKey: 'agent:main:s1', agentKey: 'main' } }),
    linkOf: a => a,
    call: async () => answer,
    tasksOf: list => (Array.isArray(list) ? list : []),
  });
  const r11 = await Chat.prototype.tasks.call(self({ active: [], recent: [], unavailable: NO_LEDGER }), {}, 1, 1);
  assert.deepEqual(r11, { active: [], recent: [], unavailable: NO_LEDGER });
  const r9 = await Chat.prototype.tasks.call(self({ active: [{ id: 'a' }], recent: [] }), {}, 1, 1);
  assert.deepEqual(r9, { active: [{ id: 'a' }], recent: [] });
  const odd = await Chat.prototype.tasks.call(self({ active: [], recent: [], unavailable: { x: 1 } }), {}, 1, 1);
  assert.equal(odd.unavailable, undefined);
  const long = await Chat.prototype.tasks.call(self({ active: [], recent: [], unavailable: 'x'.repeat(900) }), {}, 1, 1);
  assert.equal(long.unavailable.length, 300);
});

// ---- the context meter: OpenClaw 2026.11 leaves a new session's total unset after its first turn
import { usageOf, usageFromTranscript } from '../app/provider-layer/server/providers/openclaw/translate.js';
import { LinkChat } from '../app/provider-layer/server/providers/openclaw/chat.js';

const ASSISTANT = (input, output, total) => ({ role: 'assistant', content: [{ type: 'text', text: 'stub reply' }],
  usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, total } } });
const ROW_9 = { contextTokens: 64000, totalTokens: 1, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.000018, totalTokensFresh: true };
const ROW_11_FIRST = { contextTokens: 64000, totalTokensFresh: false };   // (what 2026.11.2 answers after a session's first turn)

test('usage: the row total when the gateway has one (2026.9.x, 2026.11 from the second turn)', () => {
  assert.deepEqual(usageOf(ROW_9), { used: 1, size: 64000, cost: 18, fresh: true });
});

test('usage: the transcript when the row has no total yet (2026.11 after the first turn)', () => {
  const msgs = [{ role: 'user', content: 'hi' }, ASSISTANT(1, 1, 0.000018)];
  assert.equal(usageOf(ROW_11_FIRST).used, null);
  assert.deepEqual(usageFromTranscript(msgs, ROW_11_FIRST), { used: 1, size: 64000, cost: 18, fresh: false });
  // (the latest assistant message is the conversation's size; the cost adds up)
  assert.deepEqual(usageFromTranscript([...msgs, ASSISTANT(900, 40, 0.001)], ROW_11_FIRST), { used: 900, size: 64000, cost: 1018, fresh: false });
  assert.equal(usageFromTranscript(msgs, { totalTokensFresh: false }), null);   // (no window size: no meter)
  assert.equal(usageFromTranscript([{ role: 'user', content: 'hi' }], ROW_11_FIRST), null);
});

test('LinkChat.history: the meter after a 2026.11 first turn, the row\'s total otherwise', async () => {
  const hist = info => ({ offers: () => false, request: async m => (m === 'chat.history' ? { messages: [{ role: 'user', content: 'hi' }, ASSISTANT(1, 1, 0.000018)], sessionInfo: info } : null) });
  const h11 = await LinkChat.prototype.history.call({ link: hist(ROW_11_FIRST) }, { agentKey: 'main', sessionKey: 'agent:main:x' });
  assert.deepEqual(h11.usage, { used: 1, size: 64000, cost: 18, fresh: false });
  const h9 = await LinkChat.prototype.history.call({ link: hist(ROW_9) }, { agentKey: 'main', sessionKey: 'agent:main:x' });
  assert.deepEqual(h9.usage, { used: 1, size: 64000, cost: 18, fresh: true });
});

// OpenClaw's deferred-tool call (tools offered by tool_search): 2026.9 names it tool_call, 2026.11 dispatch_action
// (dist: TOOL_CALL_RAW_TOOL_NAME), the same { id, args }; the tool it calls runs as a child call (parentToolCallId).
import { RunTranslator } from '../app/provider-layer/server/providers/openclaw/translate.js';
const toolFrame = (data) => ({ event: 'agent', payload: { stream: 'tool', data } });
function runWrapped(wrapper, id, inner) {
  const seen = [];
  const r = new RunTranslator({ emit: e => seen.push(e) });
  r.feed(toolFrame({ phase: 'start', toolCallId: 'w1', name: wrapper, args: { id, args: { query: 'x' } } }));
  if (inner) {
    r.feed(toolFrame({ phase: 'start', toolCallId: 'c1', parentToolCallId: 'w1', name: inner, args: { query: 'x' } }));
    r.feed(toolFrame({ phase: 'result', toolCallId: 'c1', parentToolCallId: 'w1', name: inner, result: { content: [{ type: 'text', text: 'found' }] } }));
  }
  r.feed(toolFrame({ phase: 'result', toolCallId: 'w1', name: wrapper, result: { content: [{ type: 'text', text: 'done' }] } }));
  return seen.filter(e => e.type && e.type.startsWith('tool.'));
}
for (const wrapper of ['tool_call', 'dispatch_action']) {
  test(`deferred tool through ${wrapper}: the step is the inner tool, the wrapper never shows`, () => {
    const seen = runWrapped(wrapper, 'openclaw:core:sessions_search', 'sessions_search');
    assert.deepEqual(seen.map(e => [e.type, e.name || null]), [['tool.start', 'sessions_search'], ['tool.end', 'sessions_search']]);
  });
  test(`a card tool through ${wrapper} (progress_card) is its card, never a step`, () => {
    assert.deepEqual(runWrapped(wrapper, 'openclaw:core:progress_card', null), []);
  });
}
test('a tool merely named like neither wrapper is an ordinary step', () => {
  const seen = runWrapped('dispatch', 'x', null);
  assert.deepEqual(seen.map(e => [e.type, e.name]), [['tool.start', 'dispatch'], ['tool.end', 'dispatch']]);
});
