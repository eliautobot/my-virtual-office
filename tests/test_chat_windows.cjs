'use strict';
// Chat window manager rules (app/chat-windows.js): up to four windows, put away / restore,
// one chat per window, side-button presses, the launcher, phones, and reload persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createManager, STORAGE_KEY } = require(path.join(__dirname, '../app/chat-windows.js'));

const SLOTS = ['primary', 'secondary-1', 'secondary-2', 'secondary-3'];

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

function setup({ phone = false, storage = memoryStorage(), keys = {}, busy = new Set() } = {}) {
  const log = [];
  const shown = new Set();
  let painted = null;
  const env = { phone };
  const wm = createManager({
    slots: SLOTS,
    storage,
    isPhone: () => env.phone,
    adapter: {
      show(slot, o) { shown.add(slot); log.push(['show', slot, !!o.focus]); },
      hide(slot, why) { shown.delete(slot); log.push(['hide', slot, why]); },
      chatKey: slot => keys[slot] || '',
      idle: slot => !busy.has(slot),
      paint(view) { painted = view; }
    }
  });
  return { wm, log, shown, storage, env, keys, busy, painted: () => painted };
}

test('opening windows: first free slot each time, up to four, then none', () => {
  const t = setup();
  assert.equal(t.wm.openNew(), 'primary');
  assert.equal(t.wm.openNew(), 'secondary-1');
  assert.equal(t.wm.openNew(), 'secondary-2');
  assert.equal(t.wm.openNew(), 'secondary-3');
  assert.equal(t.wm.count(), 4);
  assert.equal(t.wm.canOpen(), false);
  assert.equal(t.wm.openNew(), null, 'a fifth window does not open');
  assert.equal(t.wm.show('secondary-9'), false, 'unknown slots are refused');
  assert.equal(t.shown.size, 4);
  assert.equal(t.wm.front(), 'secondary-3', 'the newest window is in front');
});

test('put away keeps the side button; a press brings it back; closing frees the slot', () => {
  const t = setup();
  t.wm.openNew(); t.wm.openNew();
  assert.ok(t.wm.putAway('primary'));
  assert.equal(t.shown.has('primary'), false);
  assert.ok(t.wm.has('primary'), 'still a window (its button stays)');
  assert.deepEqual(t.painted().map(v => [v.slot, v.min]), [['primary', true], ['secondary-1', false]]);
  t.wm.press('primary');
  assert.ok(t.shown.has('primary'), 'button press brings it back');
  assert.equal(t.wm.front(), 'primary');
  t.wm.press('primary');
  assert.equal(t.wm.isAway('primary'), true, 'pressing the front window\'s button puts it away');
  t.wm.press('secondary-1');
  assert.equal(t.wm.isAway('secondary-1'), true, 'secondary-1 was the front shown window: put away');
  t.wm.show('primary'); t.wm.show('secondary-1');
  t.wm.press('primary');
  assert.equal(t.wm.front(), 'primary', 'a window behind another comes to the front');
  assert.ok(t.wm.close('secondary-1'));
  assert.equal(t.wm.has('secondary-1'), false);
  assert.deepEqual(t.log.slice(-1)[0], ['hide', 'secondary-1', 'close']);
  assert.equal(t.wm.openNew(), 'secondary-1', 'the closed slot is free again');
});

test('touch moves the front window without showing or hiding anything', () => {
  const t = setup();
  t.wm.openNew(); t.wm.openNew();
  const before = t.log.length;
  assert.ok(t.wm.touch('primary'));
  assert.equal(t.wm.front(), 'primary');
  assert.equal(t.log.length, before);
  const z = Object.fromEntries(t.painted().map(v => [v.slot, v.z]));
  assert.ok(z.primary > z['secondary-1'], 'the front window stacks on top');
});

test('launcher: no windows -> empty; shown -> all away; all away -> all back', () => {
  const t = setup();
  assert.equal(t.wm.toggleAll(), 'empty');
  t.wm.openNew(); t.wm.openNew(); t.wm.openNew();
  assert.equal(t.wm.toggleAll(), 'away');
  assert.equal(t.shown.size, 0);
  assert.equal(t.wm.count(), 3, 'put away, not closed');
  assert.equal(t.wm.toggleAll(), 'shown');
  assert.equal(t.shown.size, 3);
  assert.equal(t.wm.front(), 'secondary-2', 'the one used last stays on top');
});

test('one chat is never in two windows: holder finds the window that shows a chat', () => {
  const t = setup({ keys: { primary: 'main\u0000agent:main:main', 'secondary-1': 'bea\u0000agent:bea:main' } });
  t.wm.openNew(); t.wm.openNew();
  assert.equal(t.wm.holder('main\u0000agent:main:main'), 'primary');
  assert.equal(t.wm.holder('main\u0000agent:main:main', 'primary'), null, 'not the asking window itself');
  assert.equal(t.wm.holder('bea\u0000agent:bea:main', 'primary'), 'secondary-1');
  assert.equal(t.wm.holder(''), null);
});

test('with four open, the idle window used longest ago can be reused', () => {
  const t = setup({ busy: new Set(['primary']) });
  t.wm.openNew(); t.wm.openNew(); t.wm.openNew(); t.wm.openNew();
  assert.equal(t.wm.reusable(), 'secondary-1', 'primary is busy, secondary-1 is the oldest idle one');
  t.busy.add('secondary-1'); t.busy.add('secondary-2'); t.busy.add('secondary-3');
  assert.equal(t.wm.reusable(), null);
});

test('phones show one window at a time; the side buttons switch between chats', () => {
  const t = setup({ phone: true });
  t.wm.openNew();
  t.wm.openNew();
  assert.deepEqual([...t.shown], ['secondary-1'], 'opening a second window puts the first away');
  assert.equal(t.wm.isAway('primary'), true);
  t.wm.press('primary');
  assert.deepEqual([...t.shown], ['primary'], 'its button switches back');
  assert.equal(t.wm.toggleAll(), 'away');
  assert.equal(t.wm.toggleAll(), 'shown');
  assert.deepEqual([...t.shown], ['primary'], 'the launcher brings back the last one only');
});

test('a desktop that becomes a phone keeps only the front window shown', () => {
  const t = setup();
  t.wm.openNew(); t.wm.openNew(); t.wm.openNew();
  t.env.phone = true;
  assert.ok(t.wm.settle());
  assert.deepEqual([...t.shown], ['secondary-2']);
  assert.equal(t.wm.count(), 3);
});

test('windows come back after a reload: shown, put away and the front one', () => {
  const storage = memoryStorage();
  const a = setup({ storage });
  a.wm.openNew(); a.wm.openNew(); a.wm.openNew();
  a.wm.putAway('secondary-1');
  a.wm.touch('primary');
  const saved = JSON.parse(storage.map.get(STORAGE_KEY));
  assert.deepEqual(saved.wins, [{ slot: 'primary', min: false }, { slot: 'secondary-1', min: true }, { slot: 'secondary-2', min: false }]);
  assert.equal(saved.front, 'primary');

  const b = setup({ storage });
  assert.equal(b.wm.restore(), 3);
  assert.deepEqual([...b.shown].sort(), ['primary', 'secondary-2']);
  assert.equal(b.wm.isAway('secondary-1'), true);
  assert.equal(b.wm.front(), 'primary', 'the front window is in front again');
  assert.ok(b.log.every(([kind, , focus]) => kind !== 'show' || focus === false), 'a restore does not steal focus');

  const c = setup({ storage, phone: true });
  c.wm.restore();
  assert.deepEqual([...c.shown], ['primary'], 'a phone restores only the front window');
  assert.equal(c.wm.count(), 3);
});

test('restore ignores junk, unknown slots and duplicates', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ v: 1, wins: [null, { slot: 'x' }, { slot: 'primary' }, { slot: 'primary', min: true }], front: 'x' }) });
  const t = setup({ storage });
  assert.equal(t.wm.restore(), 1);
  assert.deepEqual([...t.shown], ['primary']);
  const bad = setup({ storage: memoryStorage({ [STORAGE_KEY]: '{oops' }) });
  assert.equal(bad.wm.restore(), 0);
});

test('v0.11: the copied OpenClaw/Hermes windows (options.others) count toward the same four', () => {
  let others = 3;
  const wm = createManager({ slots: SLOTS, adapter: {}, others: () => others });
  assert.equal(wm.canOpen(), true);
  assert.equal(wm.openNew(), 'primary');            // 3 copied + 1 office window = 4
  assert.equal(wm.canOpen(), false);
  assert.equal(wm.openNew(), null);
  assert.equal(wm.show('secondary-1'), false);      // a new slot is refused too
  assert.equal(wm.show('primary'), true);           // an open one still shows
  others = 1;
  assert.equal(wm.openNew(), 'secondary-1');
  const broken = createManager({ slots: SLOTS, adapter: {}, others: () => { throw new Error('gone'); } });
  assert.equal(broken.openNew(), 'primary');        // a failing count never blocks the office's own windows
});
