// v0.12 chatroute, updated for unify (WP-D): with the copied provider layer mounted (window.voPL) the office's own chat
// window (app/chat.js) holds NO agent and opens no legacy gateway feed: the Chat button, "+", desk menus, the roster,
// notifications and ?chatAgents hand every agent (OpenClaw, Hermes, Codex, a Hermes API server...) to the copied window
// (a stub here). chatroute's own rule (OpenClaw and Hermes to the copied window, the others in the office window) stays
// for a server that runs the layer when it never mounts in the page. With the layer off nothing changes. The real page:
// tests/e2e/pl_chatroute.mjs. Saved-state migration: tests/test_unify_migrate.cjs. Runs the real chat.js on the real
// index.html in linkedom:
//   NODE_PATH=<openclaw>/node_modules node tests/test_v12_chatroute.cjs
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const { fixture, row, settle, until } = require('./helpers/chat_router_fixture.cjs');

const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);

const ADLER = row('adler', 'Adler', 'openclaw', 'default');                 // OpenClaw: the layer's
const PLH = row('hermes-pl', 'Pia', 'hermes', 'pl-2', { sessionKey: 'agent:hermes-pl:main' });   // Hermes of the layer
const ASTRA = row('hermes-astra', 'Astra', 'hermes', 'hermes-local', { sessionKey: 'hermes:astra' });   // Hermes API server
const CODA = row('coda', 'Coda', 'codex', 'codex-local');                 // Codex (the layer's kind `office` now)
const ALL = [ADLER, PLH, ASTRA, CODA];

const V09_TWO = {
  'vo.chat.windows': { v: 1, wins: [{ slot: 'secondary-1', min: false }, { slot: 'primary', min: false }], front: 'primary' },
  'vo-chat-selection-v1': { primary: { selectedAgentKey: 'hermes-pl', sessionKey: 'agent:hermes-pl:main' }, 'secondary-1': { selectedAgentKey: 'hermes-astra', sessionKey: 'hermes:astra' } },
};

test('layer on: every saved office window moves to the copied window (front last); old keys untouched; no legacy feed', async () => {
  const f = fixture({ agents: ALL, storage: V09_TWO });
  await until(() => f.opens().length === 2, 'both windows moved');
  await settle(60);
  // (the Hermes API-server window too: unify; chatroute kept it in the office window)
  assert.deepEqual(f.opens(), [['hermes-astra', null, true], ['hermes-pl', null, true]]);
  assert.deepEqual(f.shown(), [], 'no office window comes back');
  assert.equal(f.internals.windowManager.count(), 0);
  assert.deepEqual(f.saved('vo.chat.windows'), V09_TWO['vo.chat.windows'], 'old keys stay as they are');
  assert.deepEqual(f.saved('vo-chat-selection-v1'), V09_TWO['vo-chat-selection-v1']);
  assert.equal(f.saved('vo.chat.unified.v1').done, true);
  assert.deepEqual(f.legacy(), [], 'no EventSource / WebSocket to the gateway');
});

test('layer on: desk menu, roster, notifications and "+" go to the copied window for every provider; no picker filled', async () => {
  const f = fixture({ agents: ALL });
  await settle(60);
  await f.win.VirtualOfficeChat.openForAgent('coda');
  await f.win.VirtualOfficeChat.openForAgent('adler');
  f.win.dispatchEvent(new f.dom.CustomEvent('vo:open-agent-chat', { detail: { agentId: 'hermes-astra' } }));
  await until(() => f.opens().length === 3, 'three opens');
  assert.deepEqual(f.opens(), [['coda', null, false], ['adler', null, false], ['hermes-astra', null, false]]);
  // Office Life names a chat: the layer gets its provider key (Codex: the native id after codex:<profile>:)
  await f.win.VirtualOfficeChat.openForAgent('coda', { sessionKey: 'codex:coda:thread-7' });
  assert.deepEqual(f.opens()[3], ['coda', 'thread-7', false]);
  // (unify) Office Life's open options reach the copied window: a card to focus, the Tasks side panel
  await f.win.VirtualOfficeChat.openForAgent('coda', { sessionKey: 'codex:coda:thread-7', focus: { approvalId: 'ap-1' } });
  await f.win.VirtualOfficeChat.openForAgent('adler', { panel: 'tasks' });
  assert.deepEqual(f.calls.filter(c => c[0] === 'point'), [['point', 'coda', { approvalId: 'ap-1' }, null], ['point', 'adler', null, 'tasks']]);
  assert.deepEqual(f.opens().slice(4), [['coda', 'thread-7', false], ['adler', null, false]]);
  f.win.VirtualOfficeChat.openNewWindow();
  await until(() => f.calls.some(c => c[0] === 'newWindow'), '"+" -> voPL.newWindow');
  await settle(40);
  assert.deepEqual(f.shown(), []);
  // (only index.html's placeholder: the office picker is never filled from /agents-list)
  assert.deepEqual([...f.bySlot('primary').agentSelect.querySelectorAll('option')].map(o => o.value), ['main']);
  assert.equal(f.bySlot('primary').agentListLoaded, false);
  assert.deepEqual(f.legacy(), []);
});

test('layer on: an agent the layer does not list (after a few seconds) is a toast, never an office window', async () => {
  const f = fixture({ agents: ALL, layerAgents: ['adler', 'coda'] });
  await settle(40);
  const t0 = Date.now();
  const r = await f.win.VirtualOfficeChat.openForAgent('hermes-astra');
  assert.equal(r, null);
  assert.ok(Date.now() - t0 >= 7000, 'waited for the layer to list it');
  assert.deepEqual(f.toasts.filter(t => /Astra can't chat right now/.test(t)).length, 1, f.toasts.join(' | '));
  assert.deepEqual(f.shown(), []);
});

test('layer on, fresh browser: the Chat button opens the copied window (its last-used agent), never an office window', async () => {
  const f = fixture({ agents: [ADLER, CODA] });
  await settle(40);
  f.win.VirtualOfficeChat.toggle();
  await until(() => f.calls.some(c => c[0] === 'toggleChats'), 'toggleChats');
  assert.equal(f.win.VirtualOfficeChat.isOpen(), true, 'isOpen follows the copied windows');
  f.win.VirtualOfficeChat.toggle();   // (shown: put away)
  assert.equal(f.calls.filter(c => c[0] === 'toggleChats').length, 2);
  assert.equal(f.win.VirtualOfficeChat.isOpen(), false);
  f.win.VirtualOfficeChat.open();
  await until(() => f.calls.some(c => c[0] === 'showChats'), 'showChats');
  f.win.VirtualOfficeChat.close();
  assert.equal(f.win.VirtualOfficeChat.isOpen(), false);
  await settle(60);
  assert.deepEqual(f.shown(), []);
  assert.deepEqual(f.legacy(), []);
  assert.ok(!f.fetched.includes('/api/agent-chat/events') && !f.fetched.some(p => /\/api\/(codex|hermes|claude-code)\//.test(p)), f.fetched.join(' '));
});

test('layer on before it mounted: a click waits for it, then routes (no office window in between)', async () => {
  const f = fixture({ agents: ALL });
  f.win.VirtualOfficeChat.toggle();            // (the same tick chat.js loaded)
  f.win.VirtualOfficeChat.openNewWindow();
  await until(() => f.calls.some(c => c[0] === 'toggleChats') && f.calls.some(c => c[0] === 'newWindow'), 'both routed');
  assert.deepEqual(f.shown(), []);
});

test('layer for OpenClaw but never mounted in the page: chatroute\'s rule (layer agents a toast, the others here)', async () => {
  const f = fixture({ layer: 'dead', agents: ALL, storage: V09_TWO });
  await until(() => f.shown().length === 1, 'restore');
  await settle(60);
  assert.deepEqual(f.shown(), [['secondary-1', 'hermes-astra']], 'the Hermes API-server window is back, the layer agent\'s is not');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.legacy(), [], 'still no gateway feed: the server owns OpenClaw through the layer');
});

test('layer off: 0.9\'s office window comes back on the OpenClaw agent and dials the gateway proxy, as before', async () => {
  const f = fixture({ layer: false, agents: ALL, storage: { 'vo.chat.windows': { v: 1, wins: [{ slot: 'primary', min: false }], front: 'primary' }, 'vo-chat-selection-v1': { primary: { selectedAgentKey: 'adler', sessionKey: 'agent:adler:main' } } } });
  await until(() => f.shown().length === 1, 'restore');
  await until(() => f.legacy().includes('/api/openclaw/events'), 'gateway proxy');
  assert.deepEqual(f.shown(), [['primary', 'adler']]);
  f.choose(f.bySlot('primary'), 'hermes-pl');
  await settle(40);
  assert.equal(f.bySlot('primary').selectedAgentKey, 'hermes-pl', 'every agent chats here with the layer off');
  f.choose(f.bySlot('primary'), 'coda');
  await settle(40);
  assert.equal(f.bySlot('primary').selectedAgentKey, 'coda');
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.has('vo.chat.unified.v1'), false, 'nothing migrates with the layer off');
});
