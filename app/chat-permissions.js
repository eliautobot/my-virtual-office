/*
 * Virtual Office chat: the Permissions picker (v0.13.1).
 *
 * Codex and Claude Code agents are started by the office itself, so the office decides how much they may do.
 * This button in the model bar lets the owner pick it per agent, like the native apps' approval modes:
 * Codex: Read only (when its sandbox works here) / Ask first / Full access; Claude Code: Read only /
 * Plan only / Edit files / Full access. The list, the current mode and whether this browser may change it come
 * from `GET /api/agent-permissions?kind&agent`; a choice is posted to `/api/agent-permissions` and applies from
 * the agent's next message. Full access asks for a confirmation first. OpenClaw and Hermes agents get no button:
 * their permissions live in their own gateway. No fetch here (the window passes load / save), so the file runs
 * under linkedom in Node tests.
 */
(function initChatPermissions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatPermissions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatPermissionsFactory() {
  'use strict';

  const KINDS = ['codex', 'claude-code'];
  const ICONS = { 'read-only': '\u{1F441}', plan: '\u{1F4DD}', ask: '✋', edits: '✏️', full: '⚠️' };
  const PROVIDER = { codex: 'Codex', 'claude-code': 'Claude Code' };

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function str(value, max = 300) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

  /** The server's answer, read defensively. */
  function normalize(data) {
    const d = data && typeof data === 'object' ? data : {};
    if (d.ok === false) return { ok: false, message: str(d.error || d.message) || 'Could not read the permissions.' };
    const options = (Array.isArray(d.options) ? d.options : []).map((o) => ({
      id: str(o && o.id, 40), label: str(o && o.label, 60), hint: str(o && o.hint), warn: !!(o && o.warn)
    })).filter((o) => o.id && o.label);
    const mode = options.some((o) => o.id === d.mode) ? d.mode : (options[0] ? options[0].id : '');
    return { ok: true, mode, options, canChange: !!d.canChange, warning: str(d.warning, 400), note: str(d.note, 400) };
  }

  function buttonText(state) {
    const opt = state.data && state.data.options.find((o) => o.id === state.data.mode);
    return opt ? opt.label : 'Permissions';
  }

  /**
   * options: { doc, bar, load(kind, agent), save(kind, agent, mode), confirm(text): Promise<bool>,
   *            isPhone(): bool, toast(text, kind) }
   */
  function controller(options = {}) {
    const doc = options.doc || (typeof document !== 'undefined' ? document : null);
    const bar = options.bar;
    if (!doc || !bar) return null;
    const btn = el(doc, 'button', 'hp-picker-btn hp-perm-btn', 'Permissions');
    btn.type = 'button';
    btn.hidden = true;
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const anchor = bar.querySelector('.chat-context-info, .hp-context-meter');
    if (anchor) bar.insertBefore(btn, anchor);
    else bar.appendChild(btn);

    const state = { kind: '', agent: '', data: null, loading: null, pop: null, saving: false };

    function paint() {
      btn.hidden = !state.kind;
      if (!state.kind) return;
      const mode = state.data ? state.data.mode : '';
      btn.textContent = '';
      const icon = el(doc, 'span', 'hp-perm-icon', ICONS[mode] || '\u{1F512}');
      icon.setAttribute('aria-hidden', 'true');
      btn.append(icon, el(doc, 'span', 'hp-perm-label', buttonText(state)));
      btn.dataset.mode = mode;
      const provider = PROVIDER[state.kind] || 'This agent';
      btn.title = `What this ${provider} agent may do without asking: ${buttonText(state)}`;
      btn.setAttribute('aria-label', `Permissions: ${buttonText(state)}`);
      btn.disabled = state.saving;
    }

    function close() {
      if (state.pop) state.pop.remove();
      state.pop = null;
      btn.setAttribute('aria-expanded', 'false');
      if (doc.removeEventListener) doc.removeEventListener('pointerdown', outside, true);
    }
    function outside(event) {
      if (state.pop && !state.pop.contains(event.target) && !btn.contains(event.target)) close();
    }

    async function load(force = false) {
      const key = state.kind + '\u0000' + state.agent;
      if (!state.kind) return null;
      if (!force && state.data && state.data.key === key) return state.data;
      if (state.loading && state.loading.key === key) return state.loading.promise;
      const promise = Promise.resolve().then(() => options.load(state.kind, state.agent)).then(normalize)
        .catch((error) => normalize({ ok: false, error: (error && error.message) || '' }));
      state.loading = { key, promise };
      const n = await promise;
      if (state.loading && state.loading.promise === promise) state.loading = null;
      if (key !== state.kind + '\u0000' + state.agent) return null;
      if (n.ok) { n.key = key; state.data = n; paint(); }
      return n;
    }

    function note(pop, text, tone) {
      let line = pop.querySelector('.hp-picker-note');
      if (!line) { line = el(doc, 'div', 'hp-picker-note'); pop.appendChild(line); }
      line.setAttribute('role', tone === 'error' ? 'alert' : 'status');
      line.dataset.tone = tone || '';
      line.textContent = text;
    }

    async function choose(opt) {
      const data = state.data;
      if (!data || state.saving || opt.id === data.mode) { close(); return; }
      if (opt.warn && options.confirm) {
        const ok = await options.confirm(data.warning || 'This agent will act without asking you first.');
        if (!ok) return;
      }
      const pop = state.pop;
      state.saving = true;
      paint();
      if (pop) note(pop, 'Saving…', 'info');
      let result;
      try { result = normalize(await options.save(state.kind, state.agent, opt.id)); }
      catch (error) { result = { ok: false, message: (error && error.message) || 'Could not change it.' }; }
      state.saving = false;
      if (result.ok) {
        result.key = state.kind + '\u0000' + state.agent;
        state.data = result;
        paint();
        close();
        if (options.toast) options.toast(`${opt.label} from this agent's next message.`, 'success');
        return;
      }
      paint();
      if (pop && pop.isConnected) note(pop, result.message, 'error');
      else if (options.toast) options.toast(result.message, 'error');
    }

    async function open() {
      if (state.pop) { close(); return; }
      const pop = el(doc, 'div', 'hp-picker-pop hp-perm-pop');
      if (options.isPhone && options.isPhone()) pop.classList.add('hp-sheet');
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', 'What this agent may do without asking');
      const head = el(doc, 'div', 'hp-picker-head', 'Permissions for this agent');
      const closeBtn = el(doc, 'button', 'hp-picker-close', '×');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.addEventListener('click', close);
      head.appendChild(closeBtn);
      const list = el(doc, 'div', 'hp-picker-list');
      list.setAttribute('role', 'listbox');
      list.appendChild(el(doc, 'div', 'hp-picker-empty', 'Loading…'));
      pop.append(head, list);
      pop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.stopPropagation(); close(); if (btn.focus) btn.focus(); }
      });
      bar.appendChild(pop);
      state.pop = pop;
      btn.setAttribute('aria-expanded', 'true');
      if (doc.addEventListener) doc.addEventListener('pointerdown', outside, true);
      const n = await load(true);
      if (state.pop !== pop) return;
      list.replaceChildren();
      if (!n || !n.ok) { note(pop, (n && n.message) || 'Could not read the permissions.', 'error'); return; }
      n.options.forEach((opt) => {
        const row = el(doc, 'button', 'hp-picker-row hp-perm-row');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', opt.id === n.mode ? 'true' : 'false');
        row.dataset.value = opt.id;
        if (opt.warn) row.dataset.warn = '1';
        row.disabled = !n.canChange;
        const text = el(doc, 'span', 'hp-perm-text');
        text.append(el(doc, 'span', 'hp-picker-label', `${ICONS[opt.id] || ''} ${opt.label}`.trim()), el(doc, 'span', 'hp-perm-hint', opt.hint));
        row.append(el(doc, 'span', 'hp-picker-mark', opt.id === n.mode ? '✓' : ''), text);
        row.addEventListener('click', () => choose(opt));
        list.appendChild(row);
      });
      if (n.note) note(pop, n.note, 'info');
      if (!n.canChange) note(pop, 'Only the office’s owner can change this (sign in with the office passcode).', 'info');
    }

    btn.addEventListener('click', () => open());

    return {
      el: btn,
      /** The chat's agent: 'codex' / 'claude-code' show the button (other kinds hide it). */
      setAgent(kind, agent) {
        const k = KINDS.includes(kind) ? kind : '';
        const a = String(agent || '');
        if (k === state.kind && a === state.agent) return;
        close();
        state.kind = k;
        state.agent = a;
        state.data = null;
        paint();
        if (k && a) load().catch(() => {});
      },
      mode() { return state.data ? state.data.mode : ''; },
      open,
      close,
      refresh: () => load(true),
      destroy() { close(); btn.remove(); }
    };
  }

  return { KINDS, controller, normalize };
});
