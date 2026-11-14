/* Agent Providers: the Hermes and OpenClaw connection editor of providers.html (Hermes port, design 3.1-3.6).
 * Talks only to the /api/agent-providers routes (design 2.6). Secrets never reach this page: the server sends
 * `secrets: {field: true}` flags and this file never puts a secret value into the page, not even one a server
 * sent by mistake (secret keys are blanked by name, see isSecretKey). A blank secret on Save means "keep it".
 * Public API: window.VOAgentProviders = { load, available, mountPage, mountForm, mountStatus, confirm, call, kinds }.
 * Provider menus (provider-menu-hermes.js, provider-menu-openclaw.js) add tabs after Connection by setting
 * window.VOProviderMenus[kind] = { TABS: [{id, label}], render(el, ctx) }. */
(() => {
  'use strict';
  const API_DEFAULT = '/api/agent-providers';
  let API = API_DEFAULT;   // (v0.11 legacyOnly: /api/office/hermes-api, the API-server rows beside the copied layer)
  const STATE_WORDS = { connected: 'Connected', connecting: 'Connecting...', pairing: 'Waiting for approval', error: 'Needs attention', offline: 'Offline', off: 'Switched off' };
  const STATE_CLS = { connected: 'ok', connecting: 'wait', pairing: 'wait', error: 'bad', offline: 'off', off: 'off' };
  const CREDENTIAL_CODES = /^(repair_needed|not_configured|AUTH_|auth_rejected|signin_needed|bad_credentials|signin_engaged|signin_not_engaged)/;
  // Words for a code when the server sent none (the server's detail and fix always win).
  const CODE_TEXTS = {
    signin_not_engaged: { detail: 'This Hermes only accepts its session token on this address.',
      fix: 'Use Session token mode, or start Hermes with a public address and a password.' },
  };
  // Same rule as the server's redaction (mvw-spec 1.9): any key that looks like a credential is never shown.
  const SECRET_KEY = /(^|[._-])(api[_-]?key|key|token|secret|password|passwd|credential|auth[_-]?token|private[_-]?key|client[_-]?secret|cookie|bearer)s?$/i;
  const isSecretKey = key => SECRET_KEY.test(String(key || '')) || /^(apiKey|gatewayToken|tokens)$/.test(String(key || ''));

  const accessField = hint => ({ key: 'access', label: 'Access', type: 'select', options: ['full', 'chat'], default: 'full',
    labels: { full: 'Full access: chat and settings', chat: 'Chat only' }, hint });

  // The form as design 3.3 / 3.4 words it. Server manifests (GET /api/agent-providers `manifests`) win field by field.
  const FALLBACK = {
    'hermes:serve': {
      kind: 'hermes', transport: 'serve', label: 'Hermes', named: true, addable: true, removable: true,
      typeLabel: 'Hermes', typeHint: 'Hermes: connects to `hermes serve`. Every profile becomes an agent, with settings, approvals, questions, files and the Bot Desktop.',
      fields: [
        { key: 'url', label: 'Hermes address', type: 'url', default: 'http://127.0.0.1:9119', required: true, schemes: ['http', 'https'], find: true,
          hint: 'The address `hermes serve` (or `hermes dashboard`) listens on: http://127.0.0.1:9119 by default. From another machine use its address (https:// through a secure proxy).' },
        { key: 'auth', label: 'Sign in with', type: 'select', options: ['token', 'password'], default: 'token', labels: { token: 'Session token', password: 'Username and password' },
          hint: 'A Hermes bound to its own machine takes a session token; one listening beyond it asks for its username and password.' },
        { key: 'token', label: 'Session token', type: 'secret', showIf: { auth: 'token' }, requiredIf: { auth: 'token' }, error: 'Enter the session token.',
          hint: 'Hermes makes a new one every time it starts, unless it is started with a token of your own: HERMES_DASHBOARD_SESSION_TOKEN=<token> hermes serve. Enter the same token here.' },
        { key: 'username', label: 'Username', type: 'text', showIf: { auth: 'password' }, requiredIf: { auth: 'password' }, error: 'Enter the username of Hermes\' sign-in.' },
        { key: 'password', label: 'Password', type: 'secret', showIf: { auth: 'password' }, requiredIf: { auth: 'password' }, unlessSet: 'tokens', handoff: true, error: 'Enter the password.',
          hint: 'Hermes\' own sign-in (HERMES_DASHBOARD_BASIC_AUTH_USERNAME and _PASSWORD). It is used once, to sign in; the office then keeps the sign-in Hermes issues and forgets the password.' },
        accessField('Full access lets Hermes\' settings, the agent\'s files and its Bot Desktop be changed from the office (each change is shown to you first). Chat only never changes them; chat, approvals and questions work the same.'),
      ],
    },
    'hermes:api': {
      kind: 'hermes', transport: 'api', label: 'Hermes API server', legacy: true, named: true, addable: true, removable: true,
      typeLabel: 'Older API server (legacy)', typeHint: 'Older API server (legacy): one profile per API server (/v1/runs), chat and approvals only.',
      fields: [
        { key: 'apiUrl', label: 'API URL', type: 'url', default: '', placeholder: 'http://127.0.0.1:8642', required: true, schemes: ['http', 'https'],
          hint: 'The address of the Hermes API server this agent runs on, for example http://127.0.0.1:8642.' },
        { key: 'apiKey', label: 'API key', type: 'secret', hint: 'The API server\'s key (API_SERVER_KEY), if it has one.' },
        accessField('Full access lets this agent\'s settings be changed from the office (each change is shown to you first). Chat only never changes them; chat and approvals work the same.'),
        { key: 'profile', label: 'Hermes profile', type: 'profile', hint: 'Which Hermes profile this API server runs. Used to avoid showing the same agent twice.' },
      ],
    },
    'openclaw:gateway': {
      kind: 'openclaw', transport: 'gateway', label: 'OpenClaw', named: false, addable: false, removable: false,
      fields: [
        { key: 'url', label: 'Gateway address', type: 'url', default: 'ws://127.0.0.1:18789', required: true, schemes: ['ws', 'wss'],
          hint: 'OpenClaw\'s gateway listens on ws://127.0.0.1:18789 by default. From another machine use its address (wss:// through a secure proxy).' },
        { key: 'token', label: 'Gateway token', type: 'secret',
          hint: 'On the gateway\'s machine: openclaw config get gateway.auth.token. The office keeps it on its server and never shows it to the browser.' },
        accessField('Full access lets OpenClaw\'s settings, agents, automations and the agents\' browser be changed from the office (each change is shown to you first). Chat only never asks for that; chat, approvals and questions work the same.'),
      ],
    },
  };

  const S = { providers: [], manifests: normalizeManifests(null), loaded: false, ok: false, loading: null, root: null,
    kind: 'hermes', sel: '', view: 'provider', tab: 'connection', addKey: '', prefill: null, afterConnect: '', formState: null };

  // ------------------------------------------------------------------ small helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'className') el.className = value;
      else if (key === 'dataset') Object.entries(value).forEach(([k, v]) => { el.dataset[k] = String(v); });
      else if (key === 'text') el.textContent = String(value);
      else if (/^on/i.test(key)) continue; // never inline handlers
      else el.setAttribute(key, value === true ? '' : String(value));
      if (key === 'checked') el.checked = true; // the live state, not only the default
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(typeof kid === 'object' ? kid : String(kid));
    return el;
  }
  const btn = (text, act, extra = {}) => h('button', Object.assign({ type: 'button', className: 'ps-button' + (extra.cls ? ' ' + extra.cls : ''), dataset: Object.assign({ act }, extra.data || {}), disabled: extra.disabled, title: extra.title }), text);
  const show = (el, on) => { if (!el) return; if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // A <select>'s value in browsers and in DOM shims without HTMLSelectElement.value.
  function valueOf(el) {
    if (!el) return undefined;
    if (el.tagName === 'SELECT') {
      if (typeof el.value === 'string') return el.value;
      const opts = Array.from(el.querySelectorAll('option'));
      const on = opts.find(o => o.selected === true || o.hasAttribute('selected')) || opts[0];
      return on ? on.getAttribute('value') : '';
    }
    if (el.type === 'checkbox') return !!el.checked;
    return typeof el.value === 'string' ? el.value : (el.getAttribute('value') || '');
  }
  function setSelect(el, value) {
    for (const o of el.querySelectorAll('option')) { const on = o.getAttribute('value') === value; o.selected = on; if (on) o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
    try { el.value = value; } catch (_) { /* shim */ }
  }

  function normalizeField(f, fb) {
    const out = Object.assign({}, fb || {}, f || {});
    if (Array.isArray(out.options) && out.options.some(o => o && typeof o === 'object')) {
      out.labels = Object.assign({}, out.labels || {});
      out.options = out.options.map(o => { if (o && typeof o === 'object') { if (o.label) out.labels[o.value] = o.label; return String(o.value); } return String(o); });
    }
    return out;
  }
  function mergeManifest(server, fb) {
    const out = Object.assign({}, fb || {}, server || {});
    const fbFields = (fb && fb.fields) || [];
    if (server && Array.isArray(server.fields) && server.fields.length) {
      out.fields = server.fields.map(f => normalizeField(f, fbFields.find(x => x.key === f.key)));
    } else out.fields = fbFields.map(f => normalizeField(f));
    return out;
  }
  // Accepts {"hermes:serve": {...}}, {hermes: {serve: {...}}}, {hermes: {transport, ...}} or [{kind, transport, ...}].
  function normalizeManifests(raw) {
    const found = {};
    const put = (m, kind, transport) => { if (m && typeof m === 'object' && kind) found[`${kind}:${transport || m.transport || ''}`] = Object.assign({ kind, transport: transport || m.transport }, m); };
    if (Array.isArray(raw)) raw.forEach(m => put(m, m && m.kind, m && m.transport));
    else if (raw && typeof raw === 'object') {
      for (const [key, m] of Object.entries(raw)) {
        if (!m || typeof m !== 'object') continue;
        if (key.includes(':')) { const [k, t] = key.split(':'); put(m, k, t); }
        else if (m.transport || Array.isArray(m.fields)) put(m, m.kind || key, m.transport);
        else Object.entries(m).forEach(([t, mm]) => put(mm, key, t));
      }
    }
    const out = {};
    for (const key of new Set([...Object.keys(FALLBACK), ...Object.keys(found)])) out[key] = mergeManifest(found[key], FALLBACK[key]);
    return out;
  }

  const manifestOf = p => S.manifests[`${p.kind}:${p.transport}`] || S.manifests[`${p.kind}:`] || FALLBACK[`${p.kind}:${p.transport}`] || { kind: p.kind, transport: p.transport, label: p.kind, fields: [] };
  const fieldsOf = p => (p && p.fields && typeof p.fields === 'object' ? p.fields : (p && (p.values || p.config)) || {});
  // A connection's saved, non-secret value. Secret keys always read as '' here.
  const savedValue = (p, key) => { if (!p || isSecretKey(key)) return undefined; const v = fieldsOf(p)[key]; return v === undefined && key === 'access' ? p.access : v; };
  const secretSet = (p, key) => !!(p && p.secrets && p.secrets[key]);
  const isLegacy = p => p && p.kind === 'hermes' && p.transport === 'api';
  const stateOf = p => { if (!p.enabled) return 'off'; const s = p.status && p.status.state; return s === 'checking' ? 'connecting' : STATE_WORDS[s] && s !== 'off' ? s : 'offline'; };
  const visibleAgents = p => (Array.isArray(p.agents) ? p.agents : []).filter(a => a && !a.hidden);
  // (v0.11 legacyOnly: only the older API-server rows still on the office's own path; one switched to `hermes serve`
  //  lives on that connection now)
  const ofKind = () => S.providers.filter(p => p && (p.kind === S.kind) && (!S.legacyOnly || (isLegacy(p) && !(p.legacy && p.legacy.replacedBy))));
  const current = () => S.providers.find(p => p.id === S.sel);
  const labelOf = (m, key, v) => { const f = (m.fields || []).find(x => x.key === key); return f ? ((f.labels && f.labels[v ?? f.default]) || (v ?? f.default) || '') : (v || ''); };

  // ------------------------------------------------------------------ talking to the office server
  function apiError(data, status, layer = false) {
    // `error` is a code (design 2.6); only `message` is meant for people.
    // (the provider layer answers { error: its sentence, code } instead; its router's bare "Not found" says nothing more
    //  than the status does)
    if (data && typeof data.error === 'string' && typeof data.message !== 'string' && (layer || typeof data.code === 'string')) {
      data = { error: data.code || '', message: data.code === 'not_found' && data.error === 'Not found' ? '' : data.error, fix: data.fix, field: data.field };
    }
    // A refusal without a message of its own (a proxy page, a crash) still reads as a plain sentence. (404: the request
    // was not recognised; that alone does not show the office is out of date, so it never says to update it)
    const fallback = status === 404 ? 'The office server did not recognise that request (not found). Reload the page and try again; if it keeps happening, this page and the office server may be from different versions.'
      : status === 403 ? 'The office did not allow that.'
      : status === 409 ? 'That was changed elsewhere meanwhile. Reload and try again.'
      : status >= 500 ? 'The office server ran into a problem. Try again in a moment.'
      : 'The office could not do that. Try again.';
    const err = new Error((data && typeof data.message === 'string' && data.message) || fallback);
    err.code = (data && data.error) || ''; err.fix = (data && data.fix) || ''; err.field = (data && data.field) || ''; err.status = status || 0;
    return err;
  }
  async function call(path, body, opts = {}) {
    const init = { cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) Object.assign(init, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}), body: JSON.stringify(body) });
    let res;
    try { res = await fetch(path, init); } catch (_) { throw apiError({ message: 'The office server is not answering. Check that it is running, then try again.' }); }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (res.status === 401 && !(data && data.error === 'bad_passcode')) throw apiError({ error: 'signed_out', message: 'Your sign-in to the office has ended. Reload the page to sign in again.' }, 401);
    if (!res.ok || (data && data.ok === false)) {
      const err = apiError(data, res.status, !!opts.layer);
      // Design 3.8: a write that needs the office passcode asks for it once, then retries once. Never otherwise.
      if (err.code === 'reauth_required' && body !== undefined && !opts.retried) {
        if (await askPasscode()) return call(path, body, Object.assign({}, opts, { retried: true }));
      }
      throw err;
    }
    return data || {};
  }

  // ------------------------------------------------------------------ the provider layer (on unless VO_PROVIDER_LAYER=0)
  // With it on, GET /api/agent-providers is the layer's ({ providers, kinds, host }; no `manifests`) and it has no
  // /test or /save: Hermes is connected the way Settings > Connections > Add provider does it, POST /api/connections,
  // then the layer's own test of that saved connection (POST /api/connections/test). The layer cannot test values that
  // are not saved. Its POSTs carry the browser session's CSRF token (GET /api/pl/me).
  const isLayerAnswer = data => !!data && Array.isArray(data.kinds) && !('manifests' in data);
  function layerManifests(kinds) {
    const out = {}, base = FALLBACK['hermes:serve'];
    const own = new Map(base.fields.map(f => [f.key, f]));
    for (const k of kinds) {
      if (!k || k.id !== 'hermes') continue;   // (this form is Hermes'; OpenClaw has its own step and card)
      // the layer's fields as it serves them; this page's extras (Find, the accepted schemes, the sentence for an empty
      // field) kept where the layer has the same field
      const fields = (k.fields || []).filter(f => f && f.key && !f.system).map(f => Object.assign({}, own.get(f.key) || {}, f));
      out['hermes:serve'] = Object.assign({}, base, { label: k.label || base.label, addable: k.addable !== false, fields, layer: true });
    }
    return out;
  }
  let layerSession = null;
  function layerMe(fresh = false) {
    if (!layerSession || fresh) layerSession = call('/api/pl/me').catch(err => { layerSession = null; throw err; });
    return layerSession;
  }
  async function layerCall(path, body, opts = {}) {
    const me = await layerMe(!!opts.freshToken);
    try { return await call(path, body, Object.assign({}, opts, { layer: true, headers: me && me.csrf ? { 'X-CSRF-Token': me.csrf } : {} })); }
    catch (err) {
      // (a token gone stale — the session renewed meanwhile — is read again once)
      if (err.code === 'csrf' && !opts.freshToken) return layerCall(path, body, Object.assign({}, opts, { freshToken: true }));
      throw err;
    }
  }
  /** Connects Hermes through the layer: makes the connection, tests it, and keeps it only when it connected (a wizard
   *  has no edit view, so a failed attempt leaves nothing behind and the same form can be sent again). */
  async function connectLayer(form, m, { onSaved } = {}) {
    const errors = validate(form, m, null);
    showErrors(form, errors);
    if (errors.length) { formStatus(form, 'Fix the marked fields first.', 'error'); return null; }
    const values = formValues(form, m), config = {}, secrets = {};
    for (const f of formFields(m)) if (Object.prototype.hasOwnProperty.call(values, f.key)) (f.type === 'secret' ? secrets : config)[f.key] = values[f.key];
    const submit = form.querySelector('[data-act="submit"]');
    if (submit) submit.disabled = true;
    formStatus(form, `Connecting to ${m.label}...`);
    let made = null;
    try {
      const me = await layerMe();
      const scope = Array.isArray(me.caps) && me.caps.includes('connections.manage') ? 'installation' : 'account';
      made = await layerCall('/api/connections', { kind: m.kind, label: formName(form, m), scope, config, secrets });
      const t = await layerCall('/api/connections/test', { id: made.id });
      const r = { id: made.id, kind: m.kind, label: made.label, version: t.version || '', detail: t.detail || '' };
      made = null;   // (it connected: kept)
      clearSecrets(form);
      if (onSaved) await onSaved(r);
      return r;
    } catch (err) {
      let kept = '';
      if (made && made.id) {
        try { await layerCall('/api/connections/remove', { id: made.id }); kept = ' Nothing was kept; correct it and connect again.'; }
        catch (_) { kept = ' The connection was saved but is not working: fix or remove it in Agent Providers (Settings > Connections).'; }
      }
      if (err.field) showErrors(form, [{ key: err.field, message: err.message }]);
      formStatus(form, err.message + kept, 'error', err.fix);
      return null;
    } finally { if (submit) submit.disabled = false; }
  }

  async function load() {
    if (S.loading) return S.loading;
    S.loading = (async () => {
      try {
        const data = await call(API);
        S.layer = !S.legacyOnly && isLayerAnswer(data);
        S.providers = Array.isArray(data.providers) ? data.providers.filter(p => p && p.id) : [];
        S.manifests = S.layer ? layerManifests(data.kinds) : normalizeManifests(data.manifests);
        S.ok = true;
      } catch (err) { S.ok = false; throw err; }
      finally { S.loaded = true; S.loading = null; }
      return S.providers;
    })();
    return S.loading;
  }

  // ------------------------------------------------------------------ dialogs and toasts (providers.html has no VOUI)
  function modal({ title, body = [], buttons = [], danger = false, onKey }) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const titleId = 'ap-modal-title-' + Math.random().toString(36).slice(2, 8);
      const box = h('div', { className: 'ap-modal' + (danger ? ' danger' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
        h('h3', { id: titleId, text: title }), h('div', { className: 'ap-modal-body' }, body),
        h('div', { className: 'ap-modal-err', role: 'alert', hidden: true }),
        h('div', { className: 'ap-modal-actions' }, buttons.map(b => h('button', { type: 'button', className: 'ps-button' + (b.cls ? ' ' + b.cls : ''), dataset: { r: b.value } }, b.label))));
      const back = h('div', { className: 'ap-modal-back' }, box);
      const done = value => { document.removeEventListener('keydown', key, true); back.remove(); try { prev && prev.focus && prev.focus(); } catch (_) {} resolve(value); };
      const api = { box, done, error: text => { const e = box.querySelector('.ap-modal-err'); e.textContent = text || ''; show(e, !!text); } };
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); done(undefined); } else if (onKey) onKey(e, api); };
      back.addEventListener('click', async e => {
        if (e.target === back) return done(undefined);
        const b = e.target.closest && e.target.closest('[data-r]');
        if (!b || !box.contains(b)) return;
        const spec = buttons.find(x => x.value === b.dataset.r);
        if (spec && spec.run) { b.disabled = true; try { const r = await spec.run(api); if (r !== false) done(r === undefined ? spec.value : r); } finally { b.disabled = false; } }
        else done(b.dataset.r);
      });
      document.addEventListener('keydown', key, true);
      document.body.append(back);
      const first = box.querySelector('input, select') || box.querySelector('.ps-button.primary, .ps-button.danger') || box.querySelector('button');
      try { first && first.focus && first.focus(); } catch (_) {}
    });
  }
  async function confirm({ title, rows = [], body = '', note = '', yes = 'Confirm', danger = false }) {
    const parts = [];
    if (body) parts.push(h('p', { text: body }));
    if (rows.length) parts.push(h('div', { className: 'ap-rows' }, rows.map(r => h('div', { className: 'ap-row' }, h('span', { text: r.label || '' }), h('s', { text: r.from ?? '' }), h('b', { text: r.to ?? '' })))));
    if (note) parts.push(h('p', { className: 'ap-hint', text: note }));
    const r = await modal({ title, body: parts, danger, buttons: [{ label: 'Cancel', value: 'no' }, { label: yes, value: 'yes', cls: danger ? 'danger' : 'primary' }] });
    return r === 'yes';
  }
  async function askPasscode() {
    const input = h('input', { type: 'password', className: 'ap-input', autocomplete: 'current-password', 'aria-label': 'Office passcode', maxlength: '200' });
    const r = await modal({ title: 'Confirm the office passcode', body: [h('p', { text: 'Changing the agent platform needs your office passcode.' }), input],
      buttons: [{ label: 'Cancel', value: 'no' }, { label: 'Confirm', value: 'yes', cls: 'primary', run: async ui => {
        try { await call('/api/access/confirm', { passcode: valueOf(input) }, { retried: true }); return 'yes'; }
        catch (err) { ui.error(err.code === 'bad_passcode' ? 'That passcode is not right.' : err.message); return false; }
      } }],
      onKey: (e, ui) => { if (e.key === 'Enter') { e.preventDefault(); ui.box.querySelector('[data-r="yes"]').click(); } } });
    input.value = '';
    return r === 'yes';
  }
  function toast(text, kind = 'ok') {
    let el = document.querySelector('.ap-toast');
    if (!el) { el = h('div', { className: 'ap-toast', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
    el.textContent = text; el.className = 'ap-toast ' + kind; show(el, true);
    clearTimeout(toast.t); toast.t = setTimeout(() => show(el, false), 4500);
  }

  // ------------------------------------------------------------------ the page
  function kindWord(p) { return isLegacy(p) ? 'Hermes, older API server' : manifestOf(p).label || p.kind; }
  const limitedOf = p => stateOf(p) === 'connected' && (p.status || {}).code === 'scope_limited';
  function pillText(p) {
    const s = stateOf(p), st = p.status || {};
    if (limitedOf(p)) return 'Connected · limited access';
    if (s === 'connected' && st.version && !isLegacy(p)) return `Connected · ${manifestOf(p).label} ${st.version}`;
    return STATE_WORDS[s];
  }
  function signsIn(p) {
    if (typeof p.signsIn === 'string' && p.signsIn) return p.signsIn;
    if (p.kind === 'openclaw') return 'Gateway token';
    if (isLegacy(p)) return secretSet(p, 'apiKey') ? 'API key' : 'No key';
    const how = labelOf(manifestOf(p), 'auth', savedValue(p, 'auth'));
    const user = savedValue(p, 'username');
    return savedValue(p, 'auth') === 'password' && user ? `${how}: ${user}` : how;
  }

  function render() {
    if (!S.root) return;
    const list = ofKind();
    if (S.view === 'provider' && !list.some(p => p.id === S.sel)) S.sel = (list[0] && list[0].id) || '';
    if (S.view === 'provider' && !S.sel && S.kind === 'hermes' && !list.length && !S.legacyOnly) { S.view = 'add'; S.addKey = 'hermes:serve'; }
    const page = h('div', { className: 'ap-page', dataset: { kind: S.kind } }, renderSide(list), h('div', { className: 'ap-pane' }, renderPane()));
    S.root.replaceChildren(page);
    if (S.view === 'add' || S.view === 'edit') showFields(page.querySelector('.ap-form'));
    P.sig = sigOf();
    plan();
  }

  function renderSide(list) {
    const addable = !S.legacyOnly && Object.values(S.manifests).some(m => m.kind === S.kind && m.addable);
    const items = list.map(p => {
      const s = stateOf(p), n = visibleAgents(p).length;
      const on = S.view !== 'add' && p.id === S.sel;
      return h('button', { type: 'button', className: 'ap-conn' + (on ? ' active' : ''), dataset: { act: 'select', id: p.id }, 'aria-current': on ? 'true' : 'false' },
        h('span', { className: 'ap-conn-name', text: p.name || p.id }),
        h('span', { className: 'ap-conn-kind', text: kindWord(p) }),
        h('span', { className: 'ap-conn-meta' }, h('i', { className: 'ap-dot ' + (limitedOf(p) ? 'wait' : STATE_CLS[s]) }), h('span', { text: limitedOf(p) ? 'Connected, limited access' : STATE_WORDS[s] }), h('span', { text: ' · ' + plural(n, 'agent', 'agents') })));
    });
    const pick = h('select', { className: 'ap-input ap-pick', 'aria-label': 'Connection', dataset: { act: 'pick' } },
      list.map(p => h('option', { value: p.id, selected: S.view !== 'add' && p.id === S.sel }, `${p.name || p.id} (${STATE_WORDS[stateOf(p)]})`)));
    return h('div', { className: 'ap-side' },
      h('div', { className: 'ap-side-title', text: S.legacyOnly ? 'Hermes API server (older connection)' : S.kind === 'openclaw' ? 'OpenClaw connection' : 'Hermes connections' }),
      list.length ? h('label', { className: 'ap-pick-wrap' }, h('span', { text: 'Connection' }), pick) : null,
      h('div', { className: 'ap-list', role: 'list' }, items.length ? items : h('p', { className: 'ap-hint', text: S.legacyOnly ? 'No older API-server connection.' : S.kind === 'openclaw' ? 'OpenClaw is not set up in this office.' : 'No Hermes connection yet.' })),
      addable ? btn('Add a connection', 'add', { cls: S.view === 'add' ? 'primary' : '' }) : null);
  }

  function renderPane() {
    if (S.view === 'add' || S.view === 'edit') return renderForm();
    const p = current();
    if (!p) return h('p', { className: 'ap-hint', text: 'Choose a connection.' });
    const menu = !isLegacy(p) && window.VOProviderMenus && window.VOProviderMenus[p.kind];
    const tabs = [{ id: 'connection', label: 'Connection' }].concat(menu && Array.isArray(menu.TABS) ? menu.TABS : []);
    if (!tabs.some(t => t.id === S.tab)) S.tab = 'connection';
    const bar = tabs.length > 1 ? h('div', { className: 'ap-tabs', role: 'tablist' }, tabs.map(t => h('button', { type: 'button', role: 'tab', className: 'ap-tab' + (t.id === S.tab ? ' on' : ''), 'aria-selected': t.id === S.tab ? 'true' : 'false', dataset: { act: 'tab', tab: t.id } }, t.label))) : null;
    if (S.tab !== 'connection' && menu && typeof menu.render === 'function') {
      const body = h('div', { className: 'ap-menu-body', dataset: { tab: S.tab } });
      Promise.resolve().then(() => menu.render(body, menuContext(p)))
        .catch(err => body.replaceChildren(h('div', { className: 'ap-card bad' }, h('h4', { text: 'Could not read it' }), h('p', { text: err.message }))));
      return [bar, body];
    }
    return [bar, leftovers(), renderConnection(p)];
  }
  /** v0.10.1: settings an older office (0.7.4) left in openclaw.json, with its two choices (vo-openclaw-leftovers.js).
   *  The notice redraws in its own box, so an answer never redraws the rest of the page. */
  function leftovers() {
    if (S.kind !== 'openclaw' || !window.VOOpenClawLeftovers) return null;
    const box = h('div', { className: 'ap-leftovers' });
    fillLeftovers(box);
    return box;
  }
  function fillLeftovers(box) {
    const target = box || (S.root && S.root.querySelector('.ap-leftovers'));
    if (!target) return;
    const card = window.VOOpenClawLeftovers.card({ call, onChange: fillLeftovers });
    target.replaceChildren(...(card ? [card] : []));
  }

  /** What a provider menu gets (design 3.7 / 3.8). call(method, params) goes through POST /call, so a write that
   *  needs the office passcode asks for it once and retries once; nothing else is ever retried. `full` is the
   *  connection's access level: under Chat only a menu draws no write buttons (the server refuses writes anyway). */
  function menuContext(p) {
    return {
      tab: S.tab, provider: p, kind: p.kind, full: (savedValue(p, 'access') || 'full') !== 'chat',
      call: (method, params) => call(API + '/call', { id: p.id, method, params: params || {} })
        .then(r => (r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : r)),
      confirm, toast, reload: refresh,
      edit: () => { S.view = 'edit'; render(); },
      openChat: nativeId => {
        const a = (p.agents || []).find(x => !x.hidden && (x.nativeId === nativeId || x.id === nativeId));
        if (!a) { toast('That agent is not shown in the office.', 'bad'); return false; }
        if (!openChat(a.id)) window.open('/?chat=' + encodeURIComponent(a.id), 'vo-office');
        return true;
      },
    };
  }

  function statusCard(p) {
    const s = stateOf(p), st = p.status || {};
    const legacy = p.legacy || {};
    if (isLegacy(p) && legacy.replacedBy) {
      const to = S.providers.find(x => x.id === legacy.replacedBy);
      return h('div', { className: 'ap-card' }, h('h4', { text: 'Switched to the full Hermes connection' }),
        h('p', { text: `Its agent now chats through "${(to && to.name) || legacy.replacedBy}"${legacy.profile ? ` (profile ${legacy.profile})` : ''}. This older connection stays switched off.` }),
        h('div', { className: 'ap-row-btns' }, btn('Switch back', 'switch-back', { data: { id: p.id } })));
    }
    if (s === 'off') return h('div', { className: 'ap-card' }, h('b', { text: 'Switched off.' }), ' Its agents cannot chat until it is switched on again.');
    if (s === 'pairing') return h('div', { className: 'ap-card wait' }, h('h4', { text: 'Waiting for approval' }), st.lead || st.detail ? h('p', { text: st.lead || st.detail }) : null,
      st.requestId ? h('div', { className: 'ap-cmd' }, h('code', { text: `openclaw devices approve ${st.requestId}` }), btn('Copy', 'copy', { data: { copy: `openclaw devices approve ${st.requestId}` } })) : (st.fix ? h('p', { className: 'ap-hint', text: st.fix }) : null),
      h('p', { className: 'ap-hint', text: 'It connects by itself as soon as it is approved.' }));
    const known = CODE_TEXTS[st.code] || {};
    if (s === 'error') return h('div', { className: 'ap-card bad' }, h('h4', { text: st.detail || known.detail || 'Something needs your attention.' }),
      st.fix || known.fix ? h('p', { className: 'ap-hint', text: st.fix || known.fix }) : null,
      CREDENTIAL_CODES.test(st.code || '') ? h('div', { className: 'ap-row-btns' }, btn('Enter the credentials', 'edit', { cls: 'primary' })) : null);
    if (s === 'offline') return h('div', { className: 'ap-card' }, h('h4', { text: 'Offline' }), h('p', { text: st.detail || 'Not connected.' }), st.fix ? h('p', { className: 'ap-hint', text: st.fix }) : null);
    if (s === 'connecting') return h('div', { className: 'ap-card wait' }, h('h4', { text: 'Connecting...' }));
    if (s === 'connected' && st.code === 'scope_limited') return h('div', { className: 'ap-card wait' }, h('h4', { text: st.detail || 'Connected with limited access.' }),
      st.fix ? h('p', { className: 'ap-hint', text: st.fix }) : null);
    return null;
  }

  function renderConnection(p) {
    const m = manifestOf(p), s = stateOf(p), access = savedValue(p, 'access') || 'full';
    const legacy = p.legacy || {};
    const head = h('div', { className: 'ap-head' },
      h('div', {}, h('span', { className: 'ap-kicker', text: kindWord(p) }), h('h3', { className: 'ap-title', text: p.name || p.id }),
        h('div', { className: 'ap-tags' }, h('span', { className: 'ap-pill ' + (limitedOf(p) ? 'wait' : STATE_CLS[s]) }, h('i'), pillText(p)),
          h('span', { className: 'ap-tag', text: access === 'chat' ? 'Chat only' : 'Full access' }))),
      h('div', { className: 'ap-acts' },
        btn('Reconnect', 'reconnect', { disabled: !p.enabled }), btn('Edit', 'edit'),
        isLegacy(p) && legacy.replacedBy ? null : btn(p.enabled ? 'Switch off' : 'Switch on', 'toggle'),
        m.removable !== false && p.kind !== 'openclaw' ? btn('Remove', 'remove', { cls: 'danger' }) : null));
    const banner = isLegacy(p) && S.legacyOnly ? h('div', { className: 'ap-banner' },
      h('p', { text: 'This older connection keeps working as before in the office\'s own chat window: chat, chats list, approvals and stop. Connect `hermes serve` in Agent Providers for the full native window and commands (settings, all approval choices, questions, files and the Bot Desktop).' }))
      : isLegacy(p) && !legacy.replacedBy ? h('div', { className: 'ap-banner' },
      h('p', { text: 'This connection uses Hermes\' older API server. Switch to the full Hermes connection for settings, all approval choices, questions, files and the Bot Desktop. The agent keeps its desk, look and chats.' }),
      btn('Switch to the full Hermes connection', 'switch', { cls: 'primary', data: { id: p.id } })) : null;
    const agents = Array.isArray(p.agents) ? p.agents : [];
    const agentList = agents.length ? h('div', { className: 'ap-agents', role: 'list' }, agents.map(a => {
      const native = a.nativeId && a.nativeId !== a.name ? a.nativeId : '';
      const row = h('div', { className: 'ap-agent' + (a.hidden ? ' hidden-agent' : ''), role: 'listitem' },
        h('span', { className: 'ap-av', 'aria-hidden': 'true', text: a.emoji || '🤖' }),
        h('span', { className: 'ap-an' }, h('b', { text: a.name || a.id }), native ? h('small', { text: (p.kind === 'hermes' ? 'profile ' : '') + native }) : null,
          a.hidden ? h('small', { className: 'ap-reason', text: 'Not shown in the office: ' + (a.reason || 'hidden') }) : null));
      if (!a.hidden) {
        row.append(s === 'connected'
          ? h('a', { className: 'ps-button ap-chat', href: '/?chat=' + encodeURIComponent(a.id), target: 'vo-office', dataset: { act: 'chat', agent: a.id } }, 'Chat')
          : h('button', { type: 'button', className: 'ps-button ap-chat', disabled: true, title: 'Not connected' }, 'Chat'));
      }
      return row;
    })) : h('p', { className: 'ap-hint', text: s === 'connected' ? 'Its agents are being listed...' : 'Its agents appear here once it is connected.' });
    const kv = (k, v, mono) => h('div', { className: 'ap-kv' }, h('span', { text: k }), h('b', { className: mono ? 'mono' : '', text: v }));
    const url = savedValue(p, 'url') || savedValue(p, 'apiUrl') || savedValue(p, 'gatewayUrl') || '';
    return h('div', { className: 'ap-connection' }, head, banner, statusCard(p),
      h('h4', { className: 'ap-h', text: 'Agents' }), agentList,
      s === 'connected' && !isLegacy(p) ? h('div', { className: 'ap-row-btns' }, btn('List its agents again', 'sync')) : null,
      h('h4', { className: 'ap-h', text: 'Connection' }),
      kv('Address', url, true), kv('Access', labelOf(m, 'access', access)), kv('Signs in', signsIn(p)),
      isLegacy(p) && savedValue(p, 'profile') ? kv('Hermes profile', savedValue(p, 'profile')) : null,
      deviceRows(p),
      h('div', { className: 'ap-err', role: 'alert', hidden: true }));
  }

  // OpenClaw device pairing (only when the office connects to OpenClaw as a device: Docker bridge, another computer).
  function deviceRows(p) {
    const d = p.kind === 'openclaw' && p.device ? p.device : null;
    if (!d || !d.state || d.state === 'off') return null;
    const short = d.deviceId ? ` (device ${String(d.deviceId).slice(0, 12)})` : '';
    const words = d.state === 'paired' ? 'Paired with OpenClaw' + short : d.state === 'pending' ? 'Waiting for approval' + short : 'Not paired yet';
    return h('div', { className: 'ap-device' },
      h('div', { className: 'ap-kv' }, h('span', { text: 'Device' }), h('b', { text: words })),
      d.deviceId ? h('div', { className: 'ap-row-btns' }, btn('Pair again', 'device-repair'), btn('Forget this device', 'device-forget', { cls: 'danger' })) : null);
  }

  // ------------------------------------------------------------------ Add / Edit form
  function renderForm(opts = {}) {
    const edit = S.view === 'edit' ? current() : null;
    const keys = edit ? [`${edit.kind}:${edit.transport}`] : Object.keys(S.manifests).filter(k => S.manifests[k].kind === S.kind && S.manifests[k].addable);
    if (!keys.length) return h('p', { className: 'ap-hint', text: 'There is nothing to add here.' });
    const key = keys.includes(S.addKey) ? S.addKey : keys[0];
    S.addKey = key;
    return buildForm(S.manifests[key] || FALLBACK[key], edit, { types: edit || opts.noTypes ? [] : keys, prefill: S.prefill, embedded: false });
  }

  function buildForm(m, edit, { types = [], prefill = null, embedded = false, skipLabel = '', noTest = false } = {}) {
    const pre = prefill || {};
    const form = h('form', { className: 'ap-form', novalidate: true, autocomplete: 'off', dataset: { manifest: `${m.kind}:${m.transport}` } });
    if (!embedded) form.append(h('div', { className: 'ap-head' }, h('div', {}, h('span', { className: 'ap-kicker', text: edit ? 'Edit' : 'Add a connection' }),
      h('h3', { className: 'ap-title', text: edit ? (edit.name || edit.id) : (m.kind === 'openclaw' ? 'Connect OpenClaw' : 'Connect an agent platform') }))));
    if (types.length > 1) {
      form.append(h('div', { className: 'ap-f' }, h('span', { className: 'ap-label', text: 'Connection type' }),
        h('div', { className: 'ap-types', role: 'radiogroup', 'aria-label': 'Connection type' }, types.map(k => {
          const tm = S.manifests[k] || FALLBACK[k], on = k === `${m.kind}:${m.transport}`;
          return h('label', { className: 'ap-type' + (on ? ' on' : '') }, h('input', { type: 'radio', name: 'ap-type', value: k, checked: on, dataset: { act: 'type' } }),
            h('span', {}, h('b', { text: tm.typeLabel || tm.label }), (tm.typeHint || tm.description) ? h('small', { text: tm.typeHint || tm.description }) : null));
        }))));
    }
    const nameField = nameFieldOf(m);
    if (nameField) {
      const name = edit ? (edit.name || '') : (pre.name || '');
      form.append(h('label', { className: 'ap-f', dataset: { key: 'name' } }, h('span', { className: 'ap-label', text: nameField.label || 'Name' }),
        h('input', { className: 'ap-input apf', type: 'text', maxlength: String(nameField.maxLength || 60), placeholder: nameField.placeholder || m.label || 'Hermes', value: name, dataset: { key: 'name', kind: 'name' } }),
        h('small', { className: 'ap-ferr', role: 'alert', hidden: true })));
    }
    for (const f of formFields(m)) form.append(fieldRow(f, m, edit, pre));
    form.append(h('div', { className: 'ap-form-status', role: 'status', 'aria-live': 'polite' }));
    const isAdd = !edit;
    form.append(h('div', { className: 'ap-form-actions' },
      noTest ? null : btn('Test', 'test'),
      h('button', { type: 'submit', className: 'ps-button primary', dataset: { act: 'submit' } }, isAdd ? `Connect ${m.kind === 'openclaw' ? 'OpenClaw' : (m.legacy ? 'API server' : 'Hermes')}` : 'Save'),
      embedded ? (skipLabel ? h('button', { type: 'button', className: 'ap-link', dataset: { act: 'skip' } }, skipLabel) : null)
        : (edit || ofKind().length ? btn('Cancel', 'cancel') : null)));
    return form;
  }

  // The Name field (a manifest field or, without one, the built-in rule) is sent as the top-level `name`.
  function nameFieldOf(m) {
    const f = (m.fields || []).find(x => x.key === 'name');
    return f || (m.named !== false ? { key: 'name', label: 'Name', maxLength: 60 } : null);
  }
  // Fields the person fills in: never `system` ones (the server keeps those itself), never the name.
  const formFields = m => (m.fields || []).filter(f => f && f.key && f.key !== 'name' && !f.system);

  function fieldRow(f, m, edit, pre) {
    const wrap = h('label', { className: 'ap-f', dataset: { key: f.key, showIf: f.showIf ? JSON.stringify(f.showIf) : undefined } });
    wrap.append(h('span', { className: 'ap-label', text: f.label || f.key }));
    const saved = edit ? savedValue(edit, f.key) : undefined;
    const initial = saved ?? (pre[f.key] !== undefined && !isSecretKey(f.key) ? pre[f.key] : f.default);
    let input;
    if (f.type === 'secret' || isSecretKey(f.key)) {
      let ph = '';
      const openclawOwn = edit && ((edit.secrets && edit.secrets[f.key] === 'openclaw') || (edit.kind === 'openclaw' && f.key === 'token' && edit.tokenSource === 'openclaw'));
      if (openclawOwn) ph = f.fromOpenClawPlaceholder || 'Read from OpenClaw\'s own settings';
      else if (f.handoff && edit && f.unlessSet && secretSet(edit, f.unlessSet)) ph = f.handoffPlaceholder || 'Not needed: signed in. Type it only to sign in again.';
      else if (secretSet(edit, f.key)) ph = 'Set: leave blank to keep it';
      // Never a value attribute: the page does not know any secret and never shows one.
      input = h('input', { className: 'ap-input apf', type: 'password', autocomplete: 'new-password', spellcheck: 'false', maxlength: '4000', placeholder: ph, dataset: { key: f.key, kind: 'secret' } });
    } else if (f.type === 'select') {
      const value = String(initial ?? '');
      const options = (f.options || []).slice();
      if (value && !options.includes(value)) options.push(value);
      input = h('select', { className: 'ap-input apf', dataset: { key: f.key, kind: 'select' } }, options.map(o => h('option', { value: o, selected: o === value }, (f.labels && f.labels[o]) || o)));
    } else if (f.type === 'profile' || (m.legacy && f.key === 'profile')) {
      const serve = S.providers.find(p => p.kind === 'hermes' && p.transport === 'serve' && profilesOf(p).length);
      const value = String(initial ?? '');
      if (serve) {
        const options = [''].concat(profilesOf(serve));
        if (value && !options.includes(value)) options.push(value);
        input = h('select', { className: 'ap-input apf', dataset: { key: f.key, kind: 'select' } }, options.map(o => h('option', { value: o, selected: o === value }, o || 'Not set')));
      } else input = h('input', { className: 'ap-input apf', type: 'text', maxlength: '80', spellcheck: 'false', placeholder: 'default', value, dataset: { key: f.key, kind: 'text' } });
    } else if (f.type === 'boolean') {
      input = h('input', { className: 'apf', type: 'checkbox', checked: !!initial, dataset: { key: f.key, kind: 'bool' } });
    } else {
      input = h('input', { className: 'ap-input apf', type: f.type === 'number' ? 'number' : 'text', inputmode: f.type === 'url' ? 'url' : undefined, maxlength: String(f.maxLength || 500), spellcheck: 'false',
        placeholder: f.placeholder || '', value: initial ?? '', dataset: { key: f.key, kind: f.type === 'number' ? 'number' : (f.type === 'url' ? 'url' : 'text') } });
    }
    if ((f.find || f.button === 'find') && f.type === 'url') wrap.append(h('span', { className: 'ap-inrow' }, input, btn('Find', 'find', { title: 'Look for Hermes on the usual addresses' })), h('div', { className: 'ap-found' }));
    else wrap.append(input);
    if (f.hint) wrap.append(h('small', { className: 'ap-hint', text: f.hint }));
    wrap.append(h('small', { className: 'ap-ferr', role: 'alert', hidden: true }));
    return wrap;
  }

  const profilesOf = p => Array.from(new Set([].concat(Array.isArray(p.profiles) ? p.profiles.map(x => (x && x.name) || x) : [],
    (Array.isArray(p.agents) ? p.agents : []).map(a => a && a.nativeId)).filter(x => typeof x === 'string' && x)));

  function formInput(form, key) { return form && form.querySelector(`.apf[data-key="${key}"]`); }
  function showFields(form) {
    if (!form) return;
    for (const el of form.querySelectorAll('[data-show-if]')) {
      let cond = {};
      try { cond = JSON.parse(el.dataset.showIf); } catch (_) { cond = {}; }
      show(el, Object.entries(cond).every(([k, v]) => valueOf(formInput(form, k)) === v));
    }
  }
  const fieldShown = (form, f) => { const wrap = form.querySelector(`.ap-f[data-key="${f.key}"]`); return !!wrap && !wrap.hasAttribute('hidden'); };
  const condMet = (form, cond) => !!cond && Object.entries(cond).every(([k, v]) => valueOf(formInput(form, k)) === v);

  function urlError(f) {
    const schemes = Array.isArray(f.schemes) && f.schemes.length ? f.schemes : (/^wss?:/.test(f.default || '') ? ['ws', 'wss'] : ['http', 'https']);
    return { schemes, message: f.formatError || f.error || `The address starts with ${schemes[0]}:// or ${schemes[1] || schemes[0]}://.` };
  }
  /** The form's errors as [{key, message}] (design 3.3 / 3.4 texts). */
  function validate(form, m, edit) {
    const errors = [];
    const name = formInput(form, 'name'), nameField = nameFieldOf(m) || {};
    if (name && valueOf(name).trim().length > (nameField.maxLength || 60)) errors.push({ key: 'name', message: nameField.error || 'Give the connection a name of up to 60 characters.' });
    for (const f of formFields(m)) {
      if (!fieldShown(form, f)) continue;
      const v = String(valueOf(formInput(form, f.key)) ?? '').trim();
      const required = f.required || condMet(form, f.requiredIf);
      if (f.type === 'url') {
        const { schemes, message } = urlError(f);
        if ((required || v) && !new RegExp(`^(${schemes.join('|')})://[^\\s/?#]+`, 'i').test(v)) errors.push({ key: f.key, message });
        continue;
      }
      if (!required || v) continue;
      if (f.type === 'secret' || isSecretKey(f.key)) {
        if (secretSet(edit, f.key) || (f.unlessSet && secretSet(edit, f.unlessSet))) continue;
      }
      errors.push({ key: f.key, message: f.error || `Enter the ${String(f.label || f.key).toLowerCase()}.` });
    }
    return errors;
  }
  function showErrors(form, errors) {
    for (const el of form.querySelectorAll('.ap-ferr')) { el.textContent = ''; show(el, false); }
    for (const el of form.querySelectorAll('.apf[aria-invalid]')) el.removeAttribute('aria-invalid');
    for (const e of errors) {
      const wrap = form.querySelector(`.ap-f[data-key="${e.key}"]`);
      const box = wrap && wrap.querySelector('.ap-ferr');
      if (box) { box.textContent = e.message; show(box, true); }
      const input = formInput(form, e.key);
      if (input) input.setAttribute('aria-invalid', 'true');
    }
    const first = errors[0] && formInput(form, errors[0].key);
    try { first && first.focus && first.focus(); } catch (_) {}
  }
  function formStatus(form, text, kind = '', fix = '') {
    const el = form.querySelector('.ap-form-status');
    if (!el) return;
    el.className = 'ap-form-status' + (kind ? ' ' + kind : '');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.replaceChildren(text ? h('span', { text }) : '', fix ? h('small', { className: 'ap-hint', text: fix }) : '');
  }
  /** Values to send: shown fields only, secrets only when typed (blank = keep). */
  function formValues(form, m) {
    const values = {};
    for (const f of formFields(m)) {
      if (!fieldShown(form, f)) continue;
      const input = formInput(form, f.key);
      if (!input) continue;
      const kind = input.dataset.kind, v = valueOf(input);
      if (kind === 'secret') { if (v) values[f.key] = v; }
      else if (kind === 'bool') values[f.key] = !!v;
      else if (kind === 'number') { if (String(v).trim() !== '') values[f.key] = Number(v); }
      else values[f.key] = String(v ?? '').trim();
    }
    return values;
  }
  function formName(form, m) { const f = nameFieldOf(m) || {}, el = formInput(form, 'name'), fallback = f.default || f.placeholder || m.label || ''; return el ? (valueOf(el).trim() || fallback) : fallback; }
  function clearSecrets(form) { for (const el of form.querySelectorAll('.apf[data-kind="secret"]')) el.value = ''; }

  async function testForm(form, m, edit) {
    const errors = validate(form, m, edit);
    showErrors(form, errors);
    if (errors.length) { formStatus(form, 'Fix the marked fields first.', 'error'); return; }
    formStatus(form, 'Testing the values in this form (not saved)...');
    try {
      const body = { kind: m.kind, transport: m.transport, values: formValues(form, m) };
      if (edit) body.id = edit.id;
      const r = await call(API + '/test', body);
      const n = Array.isArray(r.profiles) ? r.profiles.length : (Array.isArray(r.agents) ? r.agents.length : null);
      formStatus(form, r.detail || `Connected to ${m.label}${r.version ? ' ' + r.version : ''}${n !== null ? ': ' + plural(n, m.kind === 'hermes' ? 'profile' : 'agent', m.kind === 'hermes' ? 'profiles' : 'agents') : ''}. Nothing was saved.`, 'ok');
    } catch (err) { formStatus(form, err.message, 'error', err.fix); }
  }

  async function saveForm(form, m, edit, { onSaved } = {}) {
    const errors = validate(form, m, edit);
    showErrors(form, errors);
    if (errors.length) { formStatus(form, 'Fix the marked fields first.', 'error'); return null; }
    const body = { kind: m.kind, transport: m.transport, name: formName(form, m), values: formValues(form, m) };
    if (edit) body.id = edit.id;
    const submit = form.querySelector('[data-act="submit"]');
    if (submit) submit.disabled = true;
    formStatus(form, edit ? 'Saving...' : 'Connecting...');
    try {
      const r = await call(API + '/save', body);
      clearSecrets(form);
      if (onSaved) await onSaved(r, body);
      return r;
    } catch (err) {
      if (err.field) showErrors(form, [{ key: err.field, message: err.message }]);
      formStatus(form, err.message, 'error', err.fix);
      return null;
    } finally { if (submit) submit.disabled = false; }
  }

  async function find(form) {
    const wrap = form.querySelector('.ap-f[data-key="url"]');
    const out = wrap && wrap.querySelector('.ap-found');
    if (!out) return;
    out.replaceChildren(h('small', { className: 'ap-hint', text: 'Looking for Hermes...' }));
    try {
      const r = S.layer ? await layerCall(API + '/detect', { kind: 'hermes' }) : await call(API + '/detect', { kind: 'hermes' });
      // (the layer finds addresses alone; the office's own path adds the version and whether it asks for a sign-in)
      const found = (Array.isArray(r.found) ? r.found : []).map(x => (typeof x === 'string' ? { url: x } : x)).filter(x => x && typeof x.url === 'string');
      if (!found.length) { out.replaceChildren(h('small', { className: 'ap-hint', text: 'No Hermes answered on the usual addresses. Type its address.' })); return; }
      out.replaceChildren(...found.map(x => h('div', { className: 'ap-found-row' },
        h('span', { className: 'mono', text: x.url }), h('small', { text: [x.version ? 'Hermes ' + x.version : '', x.authRequired ? 'asks for a username and password' : ''].filter(Boolean).join(', ') }),
        btn('Use', 'use-found', { data: { url: x.url, auth: typeof x.authRequired === 'boolean' ? (x.authRequired ? 'password' : 'token') : '' } }))));
    } catch (err) { out.replaceChildren(h('small', { className: 'ap-ferr', text: err.message })); }
  }

  // ------------------------------------------------------------------ the switch from the older API server
  function guessProfile(legacyRow, profiles) {
    const l = legacyRow.legacy || {};
    if (l.profile && profiles.includes(l.profile)) return { profile: l.profile, guessed: false };
    const saved = savedValue(legacyRow, 'profile');
    if (saved && profiles.includes(saved)) return { profile: saved, guessed: false };
    if (l.guess && profiles.includes(l.guess)) return { profile: l.guess, guessed: true };
    if (profiles.includes(legacyRow.id)) return { profile: legacyRow.id, guessed: true };
    if (profiles.includes('default')) return { profile: 'default', guessed: true };
    return { profile: profiles[0] || '', guessed: true };
  }
  const serveRows = () => S.providers.filter(p => p.kind === 'hermes' && p.transport === 'serve');
  const openLegacy = () => S.providers.filter(p => isLegacy(p) && !(p.legacy && p.legacy.replacedBy));

  async function startSwitch(legacyId) {
    const serve = serveRows().find(p => stateOf(p) === 'connected') || serveRows()[0];
    if (!serve) {
      const legacyRow = S.providers.find(p => p.id === legacyId);
      let url = 'http://127.0.0.1:9119';
      try { const u = new URL(savedValue(legacyRow, 'apiUrl') || savedValue(legacyRow, 'url') || ''); url = `${u.protocol}//${u.hostname.includes(':') ? '[' + u.hostname + ']' : u.hostname}:9119`; } catch (_) {}
      S.view = 'add'; S.addKey = 'hermes:serve'; S.prefill = { name: 'Hermes', url, auth: 'token' }; S.afterConnect = 'switch';
      render();
      return;
    }
    return switchDialog(serve, legacyId);
  }

  async function switchDialog(serve, focusId) {
    const rows = openLegacy();
    if (!rows.length) return;
    const profiles = profilesOf(serve);
    if (!profiles.length) {
      await modal({ title: 'Move these agents', body: [h('p', { text: `"${serve.name || serve.id}" has not listed its profiles yet. Try again once it shows Connected.` })], buttons: [{ label: 'Close', value: 'no', cls: 'primary' }] });
      return;
    }
    const list = h('div', { className: 'ap-switch-list' }, rows.map(r => {
      const g = guessProfile(r, profiles);
      return h('div', { className: 'ap-switch-row', dataset: { legacy: r.id } },
        h('label', { className: 'ap-check' }, h('input', { type: 'checkbox', checked: !focusId || r.id === focusId || !g.guessed, dataset: { role: 'move' } }), h('b', { text: r.name || r.id })),
        h('label', { className: 'ap-switch-profile' }, h('span', { text: 'Profile' }),
          h('select', { className: 'ap-input', dataset: { role: 'profile' }, 'aria-label': `Hermes profile for ${r.name || r.id}` }, profiles.map(p => h('option', { value: p, selected: p === g.profile }, p))),
          g.guessed ? h('span', { className: 'ap-guess', text: '(guessed)' }) : null));
    }));
    const r = await modal({
      title: 'Move these agents',
      body: [h('p', { text: `Each checked agent moves to "${serve.name || serve.id}" and keeps its desk, look and chats. Its older connection is switched off and can be switched back.` }), list],
      buttons: [{ label: 'Not now', value: 'no' }, { label: 'Switch', value: 'yes', cls: 'primary', run: async ui => {
        const moves = [];
        for (const row of list.querySelectorAll('.ap-switch-row')) {
          if (!row.querySelector('[data-role="move"]').checked) continue;
          moves.push({ legacyId: row.dataset.legacy, profile: valueOf(row.querySelector('[data-role="profile"]')) });
        }
        if (!moves.length) { ui.error('Check at least one agent, or choose Not now.'); return false; }
        const seen = new Set();
        for (const mv of moves) { if (seen.has(mv.profile)) { ui.error('Two agents cannot use the same profile: choose a different profile for one of them.'); return false; } seen.add(mv.profile); }
        try {
          const res = await call(API + '/switch', { to: serve.id, moves });
          return { moved: Array.isArray(res.moved) ? res.moved : moves };
        } catch (err) { ui.error(err.message + (err.fix ? ' ' + err.fix : '')); return false; }
      } }],
    });
    if (r && r.moved) {
      const names = r.moved.map(mv => { const row = S.providers.find(p => p.id === mv.legacyId); return (row && row.name) || mv.legacyId; });
      const who = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
      toast(`${who} now ${names.length > 1 ? 'use' : 'uses'} the full Hermes connection.`);
      await refresh();
      kick(serve.id);
    }
  }

  // After a new full Hermes connection connects, offer the move by itself when older rows match its profiles.
  async function offerSwitchAfterConnect(id, forced) {
    if (!openLegacy().length) return;
    for (let i = 0; i < 6; i++) {
      const serve = S.providers.find(p => p.id === id);
      if (!serve || stateOf(serve) === 'error' || stateOf(serve) === 'off') return;
      const profiles = profilesOf(serve);
      if (profiles.length) {
        const matches = forced || openLegacy().some(r => !guessProfile(r, profiles).guessed || profiles.includes(r.id) || (serve.agents || []).some(a => a.hidden));
        if (matches) await switchDialog(serve, null);
        return;
      }
      await new Promise(res => setTimeout(res, 1500));
      try { await load(); } catch (_) { return; }
    }
  }

  // ------------------------------------------------------------------ clicks
  function paneError(text, fix) {
    const el = S.root && S.root.querySelector('.ap-pane .ap-err');
    if (el) { el.textContent = text ? text + (fix ? ' ' + fix : '') : ''; show(el, !!text); } else if (text) toast(text, 'error');
  }
  async function refresh() {
    try { await load(); } catch (err) { paneError(err.message, err.fix); }
    render();
  }
  async function act(path, body, okText, { watch = '' } = {}) {
    try {
      const r = await call(API + path, body);
      if (okText) toast(okText);
      await refresh();
      if (watch) kick(watch);
      return r;
    } catch (err) { paneError(err.message, err.fix); return null; }
  }

  // ------------------------------------------------------------------ live status
  // After Connect, Save or Reconnect, and while any row is connecting or waiting for approval, the page reads the
  // list again every 2 s (backing off to 10 s) until nothing is pending, for at most 2 minutes, never while the tab
  // is hidden. Each answer is drawn in place: an open form, menu tab or dialog and the focused control stay as they are.
  const POLL = { first: 2000, max: 10000, span: 120000, settle: 6000 };
  const P = { timer: 0, delay: POLL.first, until: 0, watch: new Map(), sig: '' };
  const hiddenTab = () => document.hidden === true || document.visibilityState === 'hidden';
  const sigOf = () => JSON.stringify([S.sel, ofKind()]);
  function pending(p, now) {
    const s = stateOf(p);
    if (s === 'connecting' || s === 'pairing') return true;
    const since = P.watch.get(p.id);
    if (since === undefined) return false;
    if (s === 'connected' && !(Array.isArray(p.agents) && p.agents.length)) return true; // its agents are being listed
    return now - since < POLL.settle; // a Reconnect may not show in the very first answer
  }
  function anyPending(now) {
    for (const [id, since] of P.watch) {
      const p = S.providers.find(x => x.id === id);
      if (p ? !pending(p, now) : now - since >= POLL.settle) P.watch.delete(id);
    }
    return S.providers.some(p => pending(p, now));
  }
  /** Something was just saved or reconnected: watch it (and everything pending) from now on, for a fresh 2 minutes. */
  function kick(id) {
    const now = Date.now();
    if (id) P.watch.set(id, now);
    P.until = now + POLL.span; P.delay = POLL.first;
    clearTimeout(P.timer); P.timer = 0;
    plan();
  }
  function plan() {
    if (P.timer || !S.root || hiddenTab()) return;
    const now = Date.now();
    if (now >= P.until || !anyPending(now)) return;
    P.timer = setTimeout(tick, P.delay);
  }
  async function tick() {
    P.timer = 0;
    if (!S.root || S.root.isConnected === false || hiddenTab()) return; // hidden: visibilitychange starts it again
    try { await load(); } catch (_) { /* keep the last answer; the 2 minutes still end it */ }
    P.delay = Math.min(POLL.max, Math.round(P.delay * 1.5));
    live();
    plan();
  }
  document.addEventListener('visibilitychange', () => {
    if (hiddenTab()) { clearTimeout(P.timer); P.timer = 0; return; }
    if (!S.root || S.root.isConnected === false || P.timer || !anyPending(Date.now())) return;
    P.until = Math.max(P.until, Date.now() + POLL.span); P.delay = POLL.first;
    P.timer = setTimeout(tick, 0);
  });
  // Swap `old` for `fresh`, keeping keyboard focus on the same control.
  function swap(old, fresh) {
    const f = document.activeElement, had = f && f !== old && old.contains(f) && f.dataset ? f.dataset : null;
    old.replaceWith(fresh);
    const again = had && had.act && Array.from(fresh.querySelectorAll('[data-act]'))
      .find(x => x.dataset.act === had.act && x.dataset.id === had.id && x.dataset.agent === had.agent);
    if (again) try { again.focus(); } catch (_) {}
  }
  function patchSide(page, list) {
    const old = page.querySelector('.ap-side');
    if (!old) return;
    const fresh = renderSide(list), f = document.activeElement;
    if (!(f && f.tagName === 'SELECT' && old.contains(f))) { swap(old, fresh); return; }
    // The phone's connection select is open: change its words, swap only the rest.
    const ol = old.querySelector('.ap-list'), nl = fresh.querySelector('.ap-list');
    if (ol && nl) ol.replaceWith(nl);
    const oo = Array.from(old.querySelectorAll('.ap-pick option')), no = Array.from(fresh.querySelectorAll('.ap-pick option'));
    if (oo.length === no.length) oo.forEach((o, i) => { o.textContent = no[i].textContent; });
  }
  function live() {
    if (!S.root || S.root.isConnected === false) return;
    const sig = sigOf();
    if (sig === P.sig) return;
    const page = S.root.querySelector('.ap-page'), list = ofKind();
    const quiet = S.view === 'provider' && S.tab === 'connection'; // no form or menu tab a redraw would lose
    if (!page || (quiet && list.length && !list.some(p => p.id === S.sel))) { render(); return; }
    P.sig = sig;
    patchSide(page, list);
    const old = quiet && page.querySelector('.ap-pane .ap-connection'), p = current();
    if (!old || !p) return;
    const fresh = renderConnection(p), err = old.querySelector('.ap-err'), nerr = fresh.querySelector('.ap-err');
    if (err && nerr && !err.hasAttribute('hidden') && err.textContent) { nerr.textContent = err.textContent; show(nerr, true); }
    swap(old, fresh);
  }
  function openChat(agentId) {
    let chat = null;
    try { chat = window.opener && !window.opener.closed && window.opener.VirtualOfficeChat; } catch (_) { chat = null; }
    if (chat && typeof chat.openForAgent === 'function') {
      try { chat.openForAgent(agentId); window.opener.focus(); return true; } catch (_) { return false; }
    }
    return false;
  }

  async function onClick(e) {
    const t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t || !S.root || !S.root.contains(t)) return;
    const a = t.dataset.act, p = current();
    const form = t.closest('.ap-form');
    if (a === 'type' || a === 'pick') return;
    if (a === 'chat') { if (openChat(t.dataset.agent)) e.preventDefault(); return; }
    e.preventDefault();
    if (a === 'select') { S.sel = t.dataset.id; S.view = 'provider'; S.tab = 'connection'; S.prefill = null; S.afterConnect = ''; render(); return; }
    if (a === 'add') { S.view = 'add'; S.addKey = ''; S.prefill = null; S.afterConnect = ''; render(); return; }
    if (a === 'tab') { S.tab = t.dataset.tab; render(); return; }
    if (a === 'cancel') { S.view = 'provider'; S.prefill = null; S.afterConnect = ''; render(); return; }
    if (a === 'edit') { if (p) { S.view = 'edit'; render(); } return; }
    if (a === 'copy') { try { await navigator.clipboard.writeText(t.dataset.copy); toast('Copied.'); } catch (_) { toast('Select the command and copy it.', 'error'); } return; }
    if (a === 'find' && form) return find(form);
    if (a === 'use-found' && form) {
      const url = formInput(form, 'url'); if (url) url.value = t.dataset.url;
      const auth = formInput(form, 'auth'); if (auth && t.dataset.auth) setSelect(auth, t.dataset.auth);
      showFields(form); return;
    }
    if ((a === 'test' || a === 'submit') && form) return submitOrTest(form, a);
    if (!p) return;
    if (a === 'reconnect') return act('/reconnect', { id: p.id }, 'Reconnecting.', { watch: p.id });
    if (a === 'device-repair') return act('/device', { id: p.id, action: 'repair' }, 'Pairing again.', { watch: p.id });
    if (a === 'device-forget') {
      const ok = await confirm({ title: 'Forget this device?', note: 'The office makes a new device key and OpenClaw asks for approval again. You can remove the old device in OpenClaw (openclaw devices list).', yes: 'Forget', danger: true });
      if (ok) await act('/device', { id: p.id, action: 'forget' }, 'Forgot the device. Approve the new one in OpenClaw.', { watch: p.id });
      return;
    }
    if (a === 'toggle') return act('/enable', { id: p.id, on: !p.enabled }, p.enabled ? 'Switched off.' : 'Switched on.', { watch: p.enabled ? '' : p.id });
    if (a === 'sync') return act('/sync', { id: p.id }, 'Its agents were listed again.');
    if (a === 'remove') {
      const ok = await confirm({ title: `Remove "${p.name || p.id}"?`, note: 'Its agents leave the office; their chats are kept.', yes: 'Remove', danger: true });
      if (ok) { S.sel = ''; await act('/remove', { id: p.id }, `Removed "${p.name || p.id}".`); }
      return;
    }
    if (a === 'switch') return startSwitch(t.dataset.id || p.id);
    if (a === 'switch-back') {
      const ok = await confirm({ title: 'Switch back to the older API server?', body: `"${p.name || p.id}" chats through its older API server connection again.`, yes: 'Switch back' });
      if (ok) await act('/switch-back', { legacyId: t.dataset.id || p.id }, `"${p.name || p.id}" uses the older API server again.`);
    }
  }

  async function submitOrTest(form, a) {
    const key = form.dataset.manifest;
    const m = S.manifests[key] || FALLBACK[key];
    const edit = S.view === 'edit' ? current() : null;
    if (a === 'test') return testForm(form, m, edit);
    const wasAdd = !edit, after = S.afterConnect;
    await saveForm(form, m, edit, { onSaved: async r => {
      S.view = 'provider'; S.prefill = null; S.afterConnect = '';
      if (r && r.id) S.sel = r.id;
      toast(wasAdd ? 'Connected. It may take a moment to show its agents.' : 'Saved.');
      await refresh();
      kick((r && r.id) || (edit && edit.id) || '');
      if (wasAdd && m.kind === 'hermes' && m.transport === 'serve' && r && r.id) await offerSwitchAfterConnect(r.id, after === 'switch');
    } });
  }

  function onChange(e) {
    const t = e.target;
    if (!t || !S.root || !S.root.contains(t)) return;
    if (t.dataset && t.dataset.act === 'pick') { S.sel = valueOf(t); S.view = 'provider'; S.tab = 'connection'; render(); return; }
    if (t.dataset && t.dataset.act === 'type') {
      if (!t.checked) return;
      const form = t.closest('.ap-form'), name = form && formInput(form, 'name');
      S.prefill = Object.assign({}, S.prefill || {}, name && valueOf(name) ? { name: valueOf(name) } : {});
      S.addKey = t.value; render(); return;
    }
    const form = t.closest && t.closest('.ap-form');
    if (form) showFields(form);
  }

  function bind(root) {
    if (root.__apBound) return;
    root.__apBound = true;
    root.addEventListener('click', e => { onClick(e); });
    root.addEventListener('change', onChange);
    root.addEventListener('input', onChange);
    root.addEventListener('submit', e => { e.preventDefault(); const form = e.target.closest ? e.target.closest('.ap-form') : null; if (form && root === S.root) submitOrTest(form, 'submit'); });
  }

  /** The connections of one kind ('hermes' | 'openclaw') in `root`. Rejects when /api/agent-providers fails. */
  /** mountPage(el, {kind, select: a connection id, tab: a menu tab id such as 'models'}): a tab the chosen
   * connection has no menu for falls back to its Connection tab (renderPane). */
  async function mountPage(root, { kind = 'hermes', select = '', tab = '', legacyOnly = false, api = '' } = {}) {
    // (v0.11) legacyOnly: the Hermes API-server rows alone, from `api` (the copied layer has /api/agent-providers)
    const base = legacyOnly ? (api || '/api/office/hermes-api') : API_DEFAULT;
    if (base !== API || !!legacyOnly !== !!S.legacyOnly) { API = base; S.legacyOnly = !!legacyOnly; S.loaded = false; S.providers = []; S.view = 'provider'; S.sel = ''; }
    if (S.kind !== kind) { S.view = 'provider'; S.tab = 'connection'; S.prefill = null; S.afterConnect = ''; S.sel = ''; }
    S.root = root; S.kind = kind;
    if (select) { S.sel = select; S.view = 'provider'; }
    if (tab) { S.tab = String(tab); S.view = 'provider'; }
    P.until = Date.now() + POLL.span; P.delay = POLL.first; // a row already connecting catches up by itself
    bind(root);
    if (!S.loaded || !S.ok) await load();
    render();
  }

  /** The Add form alone (setup wizard): mountForm(el, {kind:'hermes', transport:'serve', onDone, onSkip, skipLabel}). */
  function mountForm(el, { kind = 'hermes', transport = 'serve', onDone, onSkip, skipLabel = 'Skip' } = {}) {
    const key = `${kind}:${transport}`;
    const m = S.manifests[key] || FALLBACK[key];
    // (the layer on — known from load(): Connect makes and tests the connection there; it has no Test of unsaved values)
    const layer = !!(S.layer && S.manifests[key] && S.manifests[key].layer);
    const form = buildForm(m, null, { embedded: true, skipLabel: onSkip ? skipLabel : '', noTest: layer });
    el.replaceChildren(form);
    showFields(form);
    form.addEventListener('change', () => showFields(form));
    form.addEventListener('input', () => showFields(form));
    form.addEventListener('submit', e => e.preventDefault());
    form.addEventListener('click', async e => {
      const t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!t) return;
      e.preventDefault();
      if (t.dataset.act === 'skip') { if (onSkip) onSkip(); return; }
      if (t.dataset.act === 'find') return find(form);
      if (t.dataset.act === 'use-found') { const url = formInput(form, 'url'); if (url) url.value = t.dataset.url; const auth = formInput(form, 'auth'); if (auth && t.dataset.auth) setSelect(auth, t.dataset.auth); showFields(form); return; }
      if (t.dataset.act === 'test') return testForm(form, m, null);
      if (t.dataset.act === 'submit') {
        const onSaved = async r => { formStatus(form, 'Connected. It may take a moment to show its agents.', 'ok'); if (onDone) onDone(r); };
        if (layer) await connectLayer(form, m, { onSaved });
        else await saveForm(form, m, null, { onSaved });
      }
    });
    return form;
  }

  /** One provider's connection alone (setup wizard, layer on): its state pill, the same card as the page (the
   *  `openclaw devices approve` command with Copy while it waits for approval), its agents and a link to Agent
   *  Providers. Asks again while it is connecting or waiting for approval (every 3 s, at most 15 minutes).
   *  mountStatus(el, {kind:'openclaw', onChange(row|null, error)}) -> {refresh, stop}. */
  const KIND_LABELS = { openclaw: 'OpenClaw', hermes: 'Hermes' };
  function mountStatus(el, { kind = 'openclaw', onChange } = {}) {
    let timer = null, stopped = false;
    const until = Date.now() + 15 * 60 * 1000;
    const link = () => h('a', { className: 'ap-status-link', href: `/providers.html?provider=${encodeURIComponent(kind)}`, target: '_blank', rel: 'noopener', text: 'Open Agent Providers' });
    const draw = (p, err) => {
      if (err) return el.replaceChildren(h('div', { className: 'ap-card bad' }, h('h4', { text: err.message || 'Agent Providers is not answering.' }), err.fix ? h('p', { className: 'ap-hint', text: err.fix }) : null, h('p', {}, link())));
      if (!p) return el.replaceChildren(h('div', { className: 'ap-card' }, h('h4', { text: 'No OpenClaw connection yet' }),
        h('p', { className: 'ap-hint', text: 'Enter the gateway token and press Connect, or add the connection in Agent Providers.' }), h('p', {}, link())));
      const s = stateOf(p), n = visibleAgents(p).length, st = p.status || {};
      // (the layer's rows name no transport: the kind's own label, never its id)
      const pill = s === 'connected' && st.version && !limitedOf(p) ? `Connected · ${KIND_LABELS[p.kind] || p.kind} ${st.version}` : pillText(p);
      el.replaceChildren(h('div', { className: 'ap-status' },
        h('div', { className: 'ap-tags' }, h('b', { text: p.name || p.label || p.id }), ' ', h('span', { className: 'ap-pill ' + (limitedOf(p) ? 'wait' : STATE_CLS[s]) }, h('i'), pill)),
        statusCard(p),
        s === 'connected' ? h('p', { className: 'ap-hint', text: n ? `${plural(n, 'agent', 'agents')} connected.` : 'Its agents are being listed...' }) : null,
        h('p', {}, link())));
    };
    async function tick() {
      timer = null;
      if (stopped) return;
      let rows = null, err = null;
      try { rows = await load(); } catch (e) { err = e; }
      if (stopped) return;
      const p = rows ? rows.find(r => r && r.kind === kind && !isLegacy(r)) || null : null;
      draw(p, err);
      if (onChange) onChange(p, err);
      const s = p ? stateOf(p) : '';
      if ((s === 'connecting' || s === 'pairing' || (s === 'connected' && !visibleAgents(p).length)) && Date.now() < until) timer = setTimeout(tick, 3000);
    }
    el.addEventListener('click', async e => {
      const t = e.target && e.target.closest ? e.target.closest('[data-act="copy"]') : null;
      if (!t) return;
      e.preventDefault();
      try { await navigator.clipboard.writeText(t.dataset.copy); toast('Copied.'); } catch (_) { toast('Select the command and copy it.', 'error'); }
    });
    tick();
    return {
      refresh() { if (timer) clearTimeout(timer); timer = null; stopped = false; return tick(); },
      stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
    };
  }

  window.VOAgentProviders = {
    load, available: () => S.loaded && S.ok, mountPage, mountForm, mountStatus, confirm, call, toast, refresh,
    kinds: ['hermes', 'openclaw'],
    _test: { S, P, POLL, normalizeManifests, validate, formValues, guessProfile, isSecretKey, render, switchDialog },
  };
})();
