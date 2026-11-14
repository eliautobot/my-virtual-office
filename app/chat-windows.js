/* Chat windows (v0.8, owner: chat): the rules for several chat windows at once.
 *
 * Up to four chat windows, each one of chat.js's ChatWindow engines (a "slot":
 * 'primary', 'secondary-1', ...). A window is shown, put away (hidden; its
 * button on the side stays and it keeps working) or closed (gone). One chat is
 * never in two windows. On phones one window shows at a time and the side
 * buttons switch between them. The windows come back after a page reload.
 *
 * This file holds the rules only. chat.js passes an adapter that shows and
 * hides the real panels:
 *   show(slot, {focus, restore})  hide(slot, why: 'away'|'close')
 *   chatKey(slot) -> string        idle(slot) -> bool    paint(view)
 * options.others() -> how many chat windows the copied OpenClaw/Hermes window manager has open
 * (v0.11): the limit of four counts both.
 * Pure (no DOM): tests/test_chat_windows.cjs drives it with a fake adapter.
 */
(function (root) {
  'use strict';

  const MAX = 4;
  const STORAGE_KEY = 'vo.chat.windows';

  function createManager(options = {}) {
    const slots = Array.isArray(options.slots) ? options.slots.slice() : [];
    const adapter = options.adapter || {};
    const isPhone = typeof options.isPhone === 'function' ? options.isPhone : () => false;
    const storage = options.storage || null;
    const max = Math.min(Number(options.max) || MAX, slots.length || MAX);
    // Windows open elsewhere that count toward the same limit (v0.11: OpenClaw/Hermes's copied chat windows).
    const others = () => { try { return Math.max(0, Number(typeof options.others === 'function' ? options.others() : 0) || 0); } catch (_) { return 0; } };
    const full = () => wins.size + others() >= max;
    const wins = new Map();           // slot -> { slot, min, seq, used }
    let seq = 0;
    let tick = 0;
    let restoring = false;

    const call = (name, ...args) => (typeof adapter[name] === 'function' ? adapter[name](...args) : undefined);
    const ordered = () => [...wins.values()].sort((a, b) => a.seq - b.seq);
    const shown = () => ordered().filter(w => !w.min);
    const latest = list => list.reduce((best, w) => (!best || w.used > best.used ? w : best), null);

    function front() {
      const w = latest(shown());
      return w ? w.slot : null;
    }

    /** What the side buttons show: the windows in the order they were opened. */
    function view() {
      const top = front();
      const stack = shown().sort((a, b) => a.used - b.used).map(w => w.slot);
      return ordered().map(w => ({ slot: w.slot, min: !!w.min, front: w.slot === top, z: w.min ? -1 : stack.indexOf(w.slot) }));
    }

    function changed() {
      call('paint', view());
      save();
    }

    function freeSlot() {
      return slots.find(slot => !wins.has(slot)) || null;
    }

    /** Shows `slot` (opening it when it is not a window yet) and brings it to the front. */
    function show(slot, { focus = true } = {}) {
      if (!slots.includes(slot)) return false;
      let w = wins.get(slot);
      if (!w) {
        if (full()) return false;
        w = { slot, min: false, seq: ++seq, used: 0 };
        wins.set(slot, w);
      }
      w.min = false;
      w.used = ++tick;
      // Phones show one window at a time: the others are put away.
      if (isPhone()) {
        for (const other of wins.values()) {
          if (other === w || other.min) continue;
          other.min = true;
          call('hide', other.slot, 'away');
        }
      }
      call('show', slot, { focus });
      changed();
      return true;
    }

    /** A press inside a window: it becomes the front one (no show/hide). */
    function touch(slot) {
      const w = wins.get(slot);
      if (!w || w.min || front() === slot) return false;
      w.used = ++tick;
      changed();
      return true;
    }

    function putAway(slot) {
      const w = wins.get(slot);
      if (!w || w.min) return false;
      w.min = true;
      call('hide', slot, 'away');
      changed();
      return true;
    }

    function close(slot) {
      if (!wins.has(slot)) return false;
      wins.delete(slot);
      call('hide', slot, 'close');
      changed();
      return true;
    }

    /** A new window on a free slot (null when four are open). */
    function openNew({ focus = true } = {}) {
      if (full()) return null;
      const slot = freeSlot();
      if (!slot) return null;
      return show(slot, { focus }) ? slot : null;
    }

    /** A side button: put away -> back; front -> put away; behind another -> to the front. */
    function press(slot) {
      const w = wins.get(slot);
      if (!w) return false;
      if (w.min) return show(slot);
      if (front() === slot) return putAway(slot);
      return show(slot);
    }

    /** The chat launcher: no window -> 'empty' (the caller opens one); some shown -> all put
     *  away; all put away -> all back (on a phone the last used one). */
    function toggleAll() {
      if (!wins.size) return 'empty';
      if (shown().length) {
        for (const w of ordered()) {
          if (w.min) continue;
          w.min = true;
          call('hide', w.slot, 'away');
        }
        changed();
        return 'away';
      }
      return showAll() ? 'shown' : 'empty';
    }

    /** Every window back (a phone: the one used last), the last used on top. */
    function showAll() {
      if (!wins.size) return false;
      if (isPhone()) return show(latest(ordered()).slot);
      const list = ordered().sort((a, b) => a.used - b.used);
      list.forEach((w, i) => {
        w.min = false;
        w.used = ++tick;
        call('show', w.slot, { focus: i === list.length - 1 });
      });
      changed();
      return true;
    }

    /** The window (other than `except`) that shows chat `key`. */
    function holder(key, except = null) {
      if (!key) return null;
      for (const w of ordered()) {
        if (w.slot !== except && call('chatKey', w.slot) === key) return w.slot;
      }
      return null;
    }

    /** With four open: the window used longest ago that has nothing going on. */
    function reusable(except = null) {
      const idle = ordered().filter(w => w.slot !== except && call('idle', w.slot) !== false);
      if (!idle.length) return null;
      return idle.reduce((best, w) => (w.used < best.used ? w : best)).slot;
    }

    /** Phones: when the screen becomes small, only the front window stays shown. */
    function settle() {
      if (!isPhone()) return false;
      const top = front();
      let moved = false;
      for (const w of ordered()) {
        if (w.min || w.slot === top) continue;
        w.min = true;
        call('hide', w.slot, 'away');
        moved = true;
      }
      if (moved) changed();
      return moved;
    }

    function snapshot() {
      return { v: 1, wins: ordered().map(w => ({ slot: w.slot, min: !!w.min })), front: front() };
    }

    function save() {
      if (restoring || !storage) return;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); } catch (_) { /* private mode */ }
    }

    /** The windows as they were before the reload: shown ones shown again (a phone: the front
     *  one only), put away ones as side buttons. Returns how many came back. */
    function restore() {
      let data = null;
      try { data = JSON.parse((storage && storage.getItem(STORAGE_KEY)) || 'null'); } catch (_) { data = null; }
      const saved = (Array.isArray(data && data.wins) ? data.wins : [])
        .filter(s => s && slots.includes(s.slot))
        .filter((s, i, list) => list.findIndex(o => o.slot === s.slot) === i)
        .slice(0, max);
      if (!saved.length) return 0;
      restoring = true;
      try {
        for (const s of saved) {
          if (!wins.has(s.slot)) wins.set(s.slot, { slot: s.slot, min: true, seq: ++seq, used: ++tick });
        }
        const want = saved.filter(s => !s.min).map(s => s.slot);
        const top = want.includes(data.front) ? data.front : want[want.length - 1];
        const showList = isPhone() ? (top ? [top] : []) : want.filter(s => s !== top).concat(top ? [top] : []);
        for (const slot of showList) {
          const w = wins.get(slot);
          w.min = false;
          w.used = ++tick;
          call('show', slot, { focus: false, restore: true });
        }
      } finally {
        restoring = false;
      }
      changed();
      return wins.size;
    }

    return {
      max,
      view,
      front,
      freeSlot,
      show,
      touch,
      putAway,
      close,
      openNew,
      press,
      toggleAll,
      showAll,
      holder,
      reusable,
      settle,
      snapshot,
      restore,
      has: slot => wins.has(slot),
      isShown: slot => !!wins.get(slot) && !wins.get(slot).min,
      isAway: slot => !!wins.get(slot) && !!wins.get(slot).min,
      count: () => wins.size,
      shownCount: () => shown().length,
      canOpen: () => !full(),
      slots: () => ordered().map(w => w.slot)
    };
  }

  const api = { createManager, MAX, STORAGE_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ChatWindows = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
