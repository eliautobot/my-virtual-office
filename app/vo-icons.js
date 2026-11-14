/* Pixel SVG icons for every script (v0.10, UI-07): the sprite lives in index.html (<symbol id="i-*">).
   VOIcon.svg(name, cls) returns an element, VOIcon.html(name, cls) the same markup as a string.
   Use these instead of emoji for anything that acts as an icon. */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const clean = v => String(v || '').replace(/[^a-z0-9 _-]/gi, '');
  function svg(name, cls) {
    const el = root.document.createElementNS(NS, 'svg');
    el.setAttribute('class', 'vo-icon' + (cls ? ' ' + clean(cls) : ''));
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('focusable', 'false');
    const use = root.document.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-' + clean(name));
    el.appendChild(use);
    return el;
  }
  function html(name, cls) {
    return '<svg class="vo-icon' + (cls ? ' ' + clean(cls) : '') + '" aria-hidden="true" focusable="false"><use href="#i-' + clean(name) + '"/></svg>';
  }
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** One empty-state block for every window (UI-17): pixel icon, one line, optional hint and
   *  one action. `action` is { label, attrs } (attrs: raw attribute string the caller controls). */
  function emptyHtml({ icon = 'info', title = '', text = '', action = null, tone = '' } = {}) {
    return '<div class="vo-empty' + (tone ? ' vo-empty--' + clean(tone) : '') + '" role="status">' +
      '<span class="vo-empty-icon">' + html(icon) + '</span>' +
      (title ? '<strong class="vo-empty-title">' + esc(title) + '</strong>' : '') +
      (text ? '<span class="vo-empty-text">' + esc(text) + '</span>' : '') +
      (action ? '<button type="button" class="vo-btn vo-btn--secondary vo-empty-action" ' + (action.attrs || '') + '>' +
        (action.icon ? html(action.icon) : '') + '<span>' + esc(action.label) + '</span></button>' : '') +
      '</div>';
  }
  const api = { svg, html, emptyHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VOIcon = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
