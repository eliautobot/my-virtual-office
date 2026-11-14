/* OpenClaw and Hermes in the copied chat window and Agent Providers window (v0.11; on unless VO_PROVIDER_LAYER=0).
 * The office asks the server whether it runs the copied provider layer; only then it loads /pl/js/vo-mount.mjs
 * (the copied modules, their styles and window.voPL). With the layer off nothing else is fetched and the office's
 * own chat window and Agent Providers stay exactly as they were.
 * window.voPLReady resolves window.voPL, or null when the layer is off or could not start.
 * On the office page "Manage in Agent Providers" (settings, Connections) opens the copied window in place. */
(function () {
  'use strict';
  if (window.voPLReady) return;
  const page = document.currentScript && document.currentScript.dataset.page === 'providers' ? 'providers' : 'office';
  window.voPLReady = fetch('/api/office/provider-layer', { cache: 'no-store', credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(s => {
      if (!s || !s.enabled) return null;
      if (s.nodeOk === false) {
        // no Node.js (or too old): OpenClaw and Hermes are off, every other provider works; say how to fix it, once
        const text = 'OpenClaw and Hermes are off: ' + (s.message || 'Node.js is missing.');
        console.warn('[provider layer]', text);
        if (page === 'office' && window.VOUI && typeof window.VOUI.toast === 'function') window.VOUI.toast(text, { kind: 'warning', duration: 12000 });
        return null;
      }
      if (!s.running && s.message) console.warn('[provider layer]', s.message);
      return import('/pl/js/vo-mount.mjs').then(m => m.mount({ page }));
    })
    .catch(e => { console.warn('[provider layer] not loaded:', e && e.message ? e.message : e); return null; });
  if (page !== 'office') return;
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[data-ap-manage]') : null;
    if (!a || !window.voPL || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    window.voPL.openProviders(a.dataset.apManage || null);
  }, true);
})();
