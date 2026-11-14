/* One window stack for every floating window (v0.10, UI-01).
   Chat windows, the Agent PC, SMS, the browser and the agent workspace share one z band
   (--vo-z-window); settings, Projects, Meetings, Skills and the other modal windows share
   the modal band (--vo-z-modal). OpenClaw and Hermes's copied chat windows (.chat-back, v0.11)
   join the window band, their Agent Providers window (.ap-back) the modal band. A window comes to the front when it opens and when it is
   pressed. Confirm dialogs (.vo-dialog) keep their own higher layer and are not tracked. */
(function (root) {
  'use strict';

  const BANDS = {
    window: { base: 300, cap: 399, sel: '.chat-panel, .sms-panel, .browser-panel, .agent-workspace-panel, .agent-preview-panel, .chat-back' },
    modal: { base: 600, cap: 619, sel: '.modal, .main-menu-panel, .agent-panel, .vo-window:not(.vo-dialog), .ap-back' }
  };
  const ANY = Object.values(BANDS).map(b => b.sel).join(', ');

  function createStack(doc) {
    const stacks = { window: [], modal: [] };   // bottom -> top
    const seen = new WeakMap();                  // el -> { band, shown, display }
    let observer = null;

    const bandOf = el => {
      if (!el || el.nodeType !== 1) return null;
      for (const name of Object.keys(BANDS)) if (el.matches(BANDS[name].sel)) return name;
      return null;
    };
    const isShown = el => {
      if (!el.isConnected || el.hidden || el.classList.contains('hidden')) return false;
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      const cs = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
      return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
    };

    function paint(band) {
      const list = stacks[band];
      for (let i = list.length - 1; i >= 0; i--) if (!list[i].isConnected) list.splice(i, 1);
      const { base, cap } = BANDS[band];
      list.forEach((el, i) => { el.style.zIndex = String(Math.min(cap, base + 1 + i)); });
    }

    function track(el) {
      const band = bandOf(el);
      if (!band) return null;
      if (!seen.has(el)) {
        seen.set(el, { band, shown: isShown(el), display: el.style.display });
        if (observer) observer.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      }
      return band;
    }

    /** Brings `el` (or the window that contains it) to the front of its band. */
    function raise(el) {
      const win = el && el.nodeType === 1 ? (bandOf(el) ? el : el.closest(ANY)) : null;
      const band = track(win);
      if (!band) return false;
      const list = stacks[band];
      if (list[list.length - 1] === win && win.style.zIndex) return false;
      const at = list.indexOf(win);
      if (at >= 0) list.splice(at, 1);
      list.push(win);
      paint(band);
      return true;
    }

    /** Takes a closed window out of the stack and hands its z-index back to CSS. */
    function release(el) {
      const band = el && seen.get(el) ? seen.get(el).band : bandOf(el);
      if (!band) return false;
      const list = stacks[band];
      const at = list.indexOf(el);
      if (at < 0) return false;
      list.splice(at, 1);
      el.style.zIndex = '';
      paint(band);
      return true;
    }

    function onMutations(records) {
      for (const r of records) {
        const el = r.target;
        const st = seen.get(el);
        if (!st) continue;
        // Dragging rewrites left/top on every move: only a display change can show or hide.
        if (r.attributeName === 'style' && el.style.display === st.display) continue;
        st.display = el.style.display;
        const now = isShown(el);
        if (now === st.shown) continue;
        st.shown = now;
        if (now) raise(el); else release(el);
      }
    }

    function scan(node) {
      if (!node || node.nodeType !== 1) return;
      if (bandOf(node)) { track(node); if (isShown(node)) raise(node); }
      node.querySelectorAll && node.querySelectorAll(ANY).forEach(el => track(el));
    }

    function start() {
      const view = doc.defaultView || root;
      if (view.MutationObserver) {
        observer = new view.MutationObserver(onMutations);
        // New windows appended straight to <body> are picked up when they arrive.
        new view.MutationObserver(rs => rs.forEach(r => r.addedNodes.forEach(scan))).observe(doc.body, { childList: true });
      }
      doc.querySelectorAll(ANY).forEach(el => track(el));
      doc.addEventListener('pointerdown', e => {
        const win = e.target && e.target.closest ? e.target.closest(ANY) : null;
        if (win && !win.classList.contains('vo-dialog')) raise(win);
      }, true);
    }

    if (doc.body) start(); else doc.addEventListener('DOMContentLoaded', start, { once: true });
    return {
      raise, release, track,
      order: band => (stacks[band] || []).slice(),
      top: band => { const l = stacks[band] || []; return l[l.length - 1] || null; }
    };
  }

  const api = { createStack, BANDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root.document) {
    const stack = createStack(root.document);
    api.raise = stack.raise; api.release = stack.release; api.track = stack.track;
    api.order = stack.order; api.top = stack.top;
  }
  root.VOWindowStack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
