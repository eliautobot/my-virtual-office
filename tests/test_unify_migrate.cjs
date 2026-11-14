// unify WP-D: the office windows a browser saved in 0.9, 0.10, 0.11 and 0.12 (vo.chat.windows + vo-chat-selection-v1;
// the formats never changed, what they held did) move ONCE into the copied window when the layer is mounted: the right
// agent and chat in a copied window each, shown or put away as saved (front on top; a phone: the front one), the one
// shown last seeds vo.chat.last (the Chat button's "last used"), the old keys stay. Real chat.js + index.html in
// linkedom, stub voPL (tests/helpers/chat_router_fixture.cjs):
//   NODE_PATH=<openclaw>/node_modules node tests/test_unify_migrate.cjs
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const { fixture, row, settle, until } = require('./helpers/chat_router_fixture.cjs');

const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);
const MAIN = row('main', 'Main', 'openclaw', 'default');
const OPS = row('ops', 'Ops', 'openclaw', 'default');
const CODA = row('coda', 'Coda', 'codex', 'codex-local');                      // base codex:coda
const CLAUDIA = row('claudia', 'Claudia', 'claude-code', 'claude-local');      // base claude-code:claudia
const ASTRA = row('hermes-astra', 'Astra', 'hermes', 'hermes-local', { sessionKey: 'hermes:astra' });   // Hermes API server
const OPIE = row('opie', 'Opie', 'opencode', 'opencode-local');                // base opencode:opie
const GRAV = row('grav', 'Grav', 'antigravity', 'agy-local', { capabilities: { sessions: false } });
const ALL = [MAIN, OPS, CODA, CLAUDIA, ASTRA, OPIE, GRAV];
const id = key => ALL.findIndex(a => a.key === key) + 1;   // (the stub's layer ids)
const sel = (selectedAgentKey, sessionKey) => ({ selectedAgentKey, sessionKey });
const store = (wins, front, picks) => ({ 'vo.chat.windows': { v: 1, wins, front }, 'vo-chat-selection-v1': picks });

// 0.9: no layer yet: OpenClaw chatted in the office window too
const V09 = store([{ slot: 'primary', min: false }, { slot: 'secondary-1', min: true }, { slot: 'secondary-2', min: false }], 'secondary-2', {
  primary: sel('main', 'agent:main:main'), 'secondary-1': sel('ops', 'agent:ops:subagent:abc'), 'secondary-2': sel('coda', 'codex:coda:thread-42') });
// 0.10: the main window on its default agent (no saved choice), a Hermes API-server chat in front, Claude Code put away
const V10 = store([{ slot: 'primary', min: false }, { slot: 'secondary-1', min: false }, { slot: 'secondary-3', min: true }], 'secondary-1', {
  'secondary-1': sel('hermes-astra', 'hermes:astra:sess-9'), 'secondary-3': sel('claudia', 'claude-code:claudia:abc-1') });
// 0.11: the layer had OpenClaw (one copied window came back, shown); the office window kept Codex, OpenCode, and a picker
// that chose an OpenClaw agent there
const V11 = store([{ slot: 'secondary-1', min: true }, { slot: 'secondary-2', min: false }, { slot: 'primary', min: false }], 'primary', {
  primary: sel('coda', 'codex:coda'), 'secondary-1': sel('opie', 'opencode:opie:ses_1'), 'secondary-2': sel('ops', 'agent:ops:main') });
// 0.12: chatroute had dropped the OpenClaw/Hermes ones; two copied windows came back put away; room for two more
const V12 = store([{ slot: 'secondary-1', min: true }, { slot: 'secondary-2', min: true }, { slot: 'primary', min: false }], 'primary', {
  primary: sel('grav', 'antigravity:grav'), 'secondary-1': sel('coda', 'codex:coda:t-1'), 'secondary-2': sel('claudia', 'claude-code:claudia:c-2') });

const toggles = f => f.calls.filter(c => c[0] === 'toggleChats').length;
async function migrated(f, count) {
  await until(() => f.saved('vo.chat.unified.v1') && f.opens().length >= count, `${count} windows moved`, 12000);
  await settle(80);
}
function keptOld(f, fixtureStore) {
  assert.deepEqual(f.saved('vo.chat.windows'), fixtureStore['vo.chat.windows'], 'vo.chat.windows untouched');
  assert.deepEqual(f.saved('vo-chat-selection-v1'), fixtureStore['vo-chat-selection-v1'], 'vo-chat-selection-v1 untouched');
  assert.deepEqual(f.shown(), [], 'no office window');
  assert.deepEqual(f.legacy(), [], 'no legacy gateway feed');
}

test('0.9: OpenClaw + Codex windows -> copied windows on the same chats; put away one put away; Codex in front is last used', async () => {
  const f = fixture({ agents: ALL, storage: V09 });
  await migrated(f, 3);
  assert.deepEqual(f.opens(), [['ops', 'agent:ops:subagent:abc', true], ['main', 'agent:main:main', true], ['coda', 'thread-42', true]]);
  assert.equal(toggles(f), 1, 'the put away one went away again (nothing copied was shown)');
  assert.deepEqual(f.wins, { count: 3, shown: 2 });
  const last = f.saved('vo.chat.last');
  assert.deepEqual({ ...last, at: 0 }, { officeId: 'coda', agent: id('coda'), session: 'thread-42', at: 0 });
  assert.deepEqual({ ...f.saved('vo.chat.unified.v1'), at: 0 }, { v: 1, at: 0, done: true, tries: 1, pending: [] });
  keptOld(f, V09);
});

test('0.10: default-agent main window, Hermes API in front, Claude Code put away', async () => {
  const f = fixture({ agents: ALL, storage: V10 });
  await migrated(f, 3);
  assert.deepEqual(f.opens(), [['claudia', 'abc-1', true], ['main', null, true], ['hermes-astra', 'sess-9', true]]);
  assert.equal(toggles(f), 1);
  assert.equal(f.saved('vo.chat.last').officeId, 'hermes-astra');
  assert.equal(f.saved('vo.chat.last').session, 'sess-9');
  keptOld(f, V10);
});

test('0.11: copied window already shown: the moved ones join it, none is put away over it; OpenClaw picked in the office window moves too', async () => {
  const f = fixture({ agents: ALL, storage: V11, copied: { count: 1, shown: 1 } });
  await migrated(f, 3);
  assert.deepEqual(f.opens(), [['opie', 'ses_1', true], ['ops', 'agent:ops:main', true], ['coda', null, true]]);
  assert.equal(toggles(f), 0, 'a shown copied window is never put away by the move');
  assert.equal(f.saved('vo.chat.last').officeId, 'coda');
  assert.equal(f.saved('vo.chat.last').session, null, 'codex:coda = the agent, no chat named: its latest');
  keptOld(f, V11);
});

test('0.12: two copied windows came back put away: room for two: the front one, then the latest put away one', async () => {
  const f = fixture({ agents: ALL, storage: V12, copied: { count: 2, shown: 0 } });
  await migrated(f, 2);
  assert.deepEqual(f.opens(), [['claudia', 'c-2', true], ['grav', null, true]]);
  assert.equal(toggles(f), 1);
  assert.equal(f.wins.count, 4);
  assert.equal(f.saved('vo.chat.last').officeId, 'grav');
  keptOld(f, V12);
});

test('phone 412: the same moves, the front one opened last (the copied manager shows one at a time)', async () => {
  const f = fixture({ agents: ALL, storage: V10, phone: true });
  await migrated(f, 3);
  assert.deepEqual(f.opens().map(o => o[0]), ['claudia', 'main', 'hermes-astra']);
  assert.equal(f.wins.shown, 1);
  keptOld(f, V10);
});

test('once: the next load moves nothing again; the Chat button then goes to the copied windows', async () => {
  const first = fixture({ agents: ALL, storage: V09 });
  await migrated(first, 3);
  const again = fixture({ agents: ALL, storage: Object.fromEntries([...first.store].map(([k, v]) => [k, JSON.parse(v)])) });
  await settle(400);
  assert.deepEqual(again.opens(), []);
  again.win.VirtualOfficeChat.toggle();
  await until(() => again.calls.some(c => c[0] === 'toggleChats'), 'Chat button');
  assert.deepEqual(again.shown(), []);
});

test('an agent the layer lists late: the others move now, it moves on the next load', async () => {
  const f = fixture({ agents: ALL, storage: V09, lateAgents: { coda: 60000 } });
  await until(() => f.saved('vo.chat.unified.v1'), 'first pass', 15000);
  await settle(80);
  assert.deepEqual(f.opens().map(o => o[0]), ['ops', 'main']);
  assert.deepEqual({ ...f.saved('vo.chat.unified.v1'), at: 0 }, { v: 1, at: 0, done: false, tries: 1, pending: ['secondary-2'] });
  assert.equal(f.saved('vo.chat.last'), null, 'the seed (Coda in front) waits: it is not listed yet');
  const next = fixture({ agents: ALL, storage: Object.fromEntries([...f.store].map(([k, v]) => [k, JSON.parse(v)])) });
  await until(() => next.saved('vo.chat.unified.v1')?.done, 'second pass', 12000);
  await settle(80);
  assert.deepEqual(next.opens(), [['coda', 'thread-42', true]]);
  assert.equal(next.saved('vo.chat.unified.v1').tries, 2);
  assert.equal(next.saved('vo.chat.last').officeId, 'coda', 'the seed, once it is listed');
});

test('an agent the office no longer has is dropped; an existing vo.chat.last is kept; a closed main window still seeds it', async () => {
  const gone = store([{ slot: 'primary', min: false }], 'primary', { primary: sel('retired', 'codex:retired:t-1') });
  const f = fixture({ agents: ALL, storage: { ...gone, 'vo.chat.last': { officeId: 'ops', agent: id('ops'), session: 5, at: 1 } } });
  await until(() => f.saved('vo.chat.unified.v1'), 'mark', 12000);
  assert.deepEqual(f.opens(), []);
  assert.equal(f.saved('vo.chat.unified.v1').done, true);
  assert.deepEqual(f.saved('vo.chat.last'), { officeId: 'ops', agent: id('ops'), session: 5, at: 1 });
  // (no window saved, the main window's choice: 0.9-0.12's Chat button opened it)
  const closed = fixture({ agents: ALL, storage: { 'vo-chat-selection-v1': { primary: sel('claudia', 'claude-code:claudia:c-77') } } });
  await until(() => closed.saved('vo.chat.unified.v1'), 'mark', 12000);
  assert.deepEqual(closed.opens(), []);
  assert.deepEqual({ ...closed.saved('vo.chat.last'), at: 0 }, { officeId: 'claudia', agent: id('claudia'), session: 'c-77', at: 0 });
});

test('signed out / nothing shared: nothing moves and nothing is marked (the next load tries)', async () => {
  const f = fixture({ agents: ALL.map(a => ({ ...a, noChat: true })), storage: V09 });
  await settle(500);
  assert.deepEqual(f.opens(), []);
  assert.equal(f.saved('vo.chat.unified.v1'), null);
  assert.equal(f.saved('vo.chat.last'), null);
});
