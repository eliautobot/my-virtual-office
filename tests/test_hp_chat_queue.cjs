// Hermes/OpenClaw port (C2): send while working, the queue state machine (app/chat-queue.js, design 4.3).
// Pure module, no DOM: node --test tests/test_hp_chat_queue.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const ChatQueue = require('../app/chat-queue.js');

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

const busy = { busy: true, sending: false };

test('idle: Enter sends, an empty composer does nothing', () => {
  for (const mode of ['redirect', 'steer', 'local']) {
    assert.equal(ChatQueue.decide({ mode, text: 'hi' }).action, 'send');
    assert.equal(ChatQueue.decide({ mode, ctrl: true, text: 'hi' }).action, 'send');
    assert.equal(ChatQueue.decide({ mode, text: '   ' }).action, 'none');
    assert.equal(ChatQueue.decide({ mode, ...busy, text: '' }).action, 'none', 'empty Enter while busy does not stop or send');
  }
  assert.equal(ChatQueue.decide({ mode: 'local', files: [{ name: 'a.png' }] }).action, 'send');
});

test('redirect (Hermes): Enter into the turn; Ctrl+Enter, files and blocking cards queue; a question is skipped', () => {
  const base = { mode: 'redirect', ...busy };
  assert.equal(ChatQueue.decide({ ...base, text: 'also do X' }).action, 'redirect');
  assert.equal(ChatQueue.decide({ ...base, ctrl: true, text: 'later' }).action, 'queue');
  assert.equal(ChatQueue.decide({ ...base, text: 'see this', files: [{ name: 'a.png' }] }).action, 'queue');
  assert.equal(ChatQueue.decide({ ...base, text: 'x', waiting: { blocking: true } }).action, 'queue', 'approval / secret / sudo waits');
  const skip = ChatQueue.decide({ ...base, text: 'none of these', waiting: { clarify: ['q1'] } });
  assert.equal(skip.action, 'skip-redirect');
  assert.deepEqual(skip.questions, ['q1']);
  assert.equal(ChatQueue.decide({ ...base, text: 'x', waiting: { clarify: ['q1'], blocking: true } }).action, 'queue');
  assert.equal(ChatQueue.decide({ ...base, ctrl: true, text: 'x', waiting: { clarify: ['q1'] } }).action, 'queue');
});

test('steer (OpenClaw): Enter steers, Ctrl+Enter is a follow-up, an approval makes words wait', () => {
  const base = { mode: 'steer', ...busy };
  assert.equal(ChatQueue.decide({ ...base, text: 'steer' }).action, 'steer');
  assert.equal(ChatQueue.decide({ ...base, text: 'pic', files: [{ name: 'a.png' }] }).action, 'steer');
  assert.equal(ChatQueue.decide({ ...base, ctrl: true, text: 'after' }).action, 'followup');
  assert.equal(ChatQueue.decide({ ...base, text: 'x', waiting: { blocking: true } }).action, 'queue');
});

test('local (legacy Hermes, Codex, Claude Code ...): every message while busy queues; a send still uploading queues in any mode', () => {
  assert.equal(ChatQueue.decide({ mode: 'local', ...busy, text: 'x' }).action, 'queue');
  assert.equal(ChatQueue.decide({ mode: 'bogus', ...busy, text: 'x' }).action, 'queue', 'unknown mode = local');
  for (const mode of ['redirect', 'steer']) {
    assert.equal(ChatQueue.decide({ mode, busy: false, sending: true, text: 'x' }).action, 'queue');
  }
  assert.equal(ChatQueue.hint('redirect'), 'Enter adds to this turn · Ctrl+Enter sends after it');
  assert.equal(ChatQueue.hint('steer'), 'Enter adds to this turn · Ctrl+Enter sends after it');
  assert.equal(ChatQueue.hint('local'), 'Enter sends after this answer');
});

test('queue: add, order, drain one by one after each turn, label', () => {
  const q = ChatQueue.create({ key: 'a\u0000s1', storage: memoryStorage() });
  assert.equal(q.label(), '');
  const a = q.add({ text: 'first' });
  const b = q.add({ text: 'second', files: [{ name: 'f.txt', mimeType: 'text/plain', size: 3, dataUrl: 'data:text/plain;base64,YWJj' }] });
  assert.equal(q.add({ text: '  ' }), null, 'nothing to send is not queued');
  assert.equal(q.label(), '2 queued');
  assert.equal(q.next(busy), null, 'nothing leaves while the turn runs');
  assert.equal(q.next({ busy: false, sending: true }), null);
  assert.equal(q.next({ busy: false }).id, a.id);
  assert.equal(q.take().id, a.id);
  assert.equal(q.take().id, b.id);
  assert.equal(q.take(), null);
  assert.equal(q.size, 0);
});

test('queue: Stop pauses, Resume restarts; pause with nothing queued is a no-op', () => {
  const q = ChatQueue.create({ key: 'k', storage: memoryStorage() });
  assert.equal(q.pause(), false);
  q.add({ text: 'one' });
  q.add({ text: 'two' });
  assert.equal(q.pause(), true);
  assert.equal(q.label(), '2 queued, paused');
  assert.equal(q.next({ busy: false }), null, 'paused: nothing drains');
  assert.equal(q.resume(), true);
  assert.equal(q.next({ busy: false }).text, 'one');
  q.pause();
  q.take();
  q.take();
  assert.equal(q.paused, false, 'an empty queue is never paused');
});

test('queue: edit takes the item back out, delete removes it, Send now picks one out of order', () => {
  const q = ChatQueue.create({ key: 'k', storage: memoryStorage() });
  const a = q.add({ text: 'alpha' });
  const b = q.add({ text: 'beta' });
  const c = q.add({ text: 'gamma' });
  const edited = q.edit(b.id);
  assert.equal(edited.text, 'beta');
  assert.deepEqual(q.items.map(i => i.text), ['alpha', 'gamma']);
  assert.equal(q.remove(a.id), true);
  assert.equal(q.remove('nope'), false);
  assert.deepEqual(q.items.map(i => i.text), ['gamma']);
  q.add({ text: 'delta' });
  assert.equal(q.pick(c.id).text, 'gamma');
  assert.deepEqual(q.items.map(i => i.text), ['delta']);
  q.unshift({ text: 'back first' });
  assert.equal(q.items[0].text, 'back first', 'a send that could not leave goes back first');
  assert.equal(q.edit('missing'), null);
});

test('queue: per chat and survives a reload (sessionStorage); oversized files keep their names only', () => {
  const storage = memoryStorage();
  const q1 = ChatQueue.create({ key: 'agent\u0000chat-1', storage });
  q1.add({ text: 'kept', files: [{ name: 'small.txt', mimeType: 'text/plain', size: 3, dataUrl: 'data:text/plain;base64,YWJj' }] });
  q1.pause();
  const reloaded = ChatQueue.create({ key: 'agent\u0000chat-1', storage });
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.paused, true);
  assert.equal(reloaded.items[0].files[0].dataUrl, 'data:text/plain;base64,YWJj');
  const other = ChatQueue.create({ key: 'agent\u0000chat-2', storage });
  assert.equal(other.size, 0, 'another chat has its own queue');
  other.rekey('agent\u0000chat-1');
  assert.equal(other.size, 1, 'rekey loads that chat');

  const big = 'data:image/png;base64,' + 'A'.repeat(1600000);
  const q2 = ChatQueue.create({ key: 'agent\u0000chat-3', storage });
  q2.add({ text: 'with a big picture', files: [{ name: 'big.png', mimeType: 'image/png', size: 1200000, dataUrl: big }] });
  const back = ChatQueue.create({ key: 'agent\u0000chat-3', storage });
  assert.equal(back.items[0].text, 'with a big picture');
  assert.deepEqual(back.items[0].files, []);
  assert.deepEqual(back.items[0].lostFiles, ['big.png']);
  assert.equal(q2.items[0].files.length, 1, 'the open page still has the file');

  q2.clear();
  assert.equal(storage.getItem(ChatQueue.STORAGE_PREFIX + 'agent\u0000chat-3'), null, 'an empty queue leaves nothing behind');
});

test('queue: a new chat that gets its id carries its items over; storage failures never throw', () => {
  const storage = memoryStorage();
  const q = ChatQueue.create({ key: 'agent\u0000', storage });
  q.add({ text: 'waiting' });
  q.moveTo('agent\u0000new-id');
  assert.equal(q.key, 'agent\u0000new-id');
  assert.equal(q.size, 1);
  assert.equal(ChatQueue.create({ key: 'agent\u0000', storage }).size, 0);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('x'); } };
  const q2 = ChatQueue.create({ key: 'k', storage: broken });
  assert.ok(q2.add({ text: 'still works in memory' }));
  assert.equal(q2.size, 1);
  assert.equal(ChatQueue.preview({ text: 'a'.repeat(80), files: [{}], lostFiles: ['x'] }).endsWith('… 📎2'), true);
  assert.equal(ChatQueue.preview({ text: 'short' }), 'short');
});
