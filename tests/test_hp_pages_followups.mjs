// Agent Providers follow-ups (Hermes port, after B5/C5) against a mock of the office API:
//   NODE_PATH=<dir with linkedom> node tests/test_hp_pages_followups.mjs
// 1. Only real secrets get a password box: numbers and switches named like tokens are ordinary settings (the
//    server's rule in app/providers/hermes_menu.py: only a text value named like a key/token/password is a secret).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = ['agent-providers.js', 'provider-menu-hermes.js', 'provider-menu-openclaw.js'].map(f => fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'));

function loadLinkedom() {
  for (const dir of (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
    try { return require(path.join(dir, 'linkedom')); } catch (e) { /* next */ }
  }
  try { return require('linkedom'); } catch (e) { return null; }
}
const linkedom = loadLinkedom();
const SKIP = linkedom ? false : 'linkedom not found (set NODE_PATH)';
const LEAK = 'LEAKED-SECRET-7';

const fixture = (access = 'full') => ({ manifests: {}, providers: [
  { id: 'lab', kind: 'hermes', transport: 'serve', name: 'Hermes Lab', enabled: true, access,
    status: { state: 'connected', version: '0.22.2' }, fields: { url: 'http://127.0.0.1:9119', auth: 'token', access }, secrets: { token: true },
    agents: [{ id: 'lab', name: 'Default', nativeId: 'default' }] },
  { id: 'openclaw', kind: 'openclaw', transport: 'gateway', name: 'OpenClaw', enabled: true, access: 'full',
    status: { state: 'connected', version: '2026.10.1' }, fields: { url: 'ws://127.0.0.1:18789', access: 'full' }, secrets: { token: true },
    agents: [{ id: 'main', name: 'Main', nativeId: 'main' }] },
] });

const READS = {
  'profiles.list': { profiles: [{ name: 'default', is_default: true }] },
  'config.schema': { category_order: ['limits'], fields: {
    'compression.proactive_prune_tokens': { category: 'limits', type: 'number' },
    'model.max_tokens': { category: 'limits', type: 'number' },
    'display.show_tokens': { category: 'limits', type: 'boolean' },
    'agent.max_turns': { category: 'limits', type: 'number' },
    'providers.openrouter.api_key': { category: 'limits', type: 'string' },
    'auth.token': { category: 'limits', type: 'string' },
    'legacy.password': { category: 'limits', type: 'string' } } },
  // model.max_tokens unset (number field), legacy.password a plain string (an older server that did not redact it).
  'config.get': { config: { compression: { proactive_prune_tokens: 2000 }, display: { show_tokens: true }, agent: { max_turns: 40 },
    providers: { openrouter: { api_key: { secret: true, set: true } } }, legacy: { password: LEAK } } },
};

async function env({ data = fixture(), calls = {} } = {}) {
  const { window, document } = linkedom.parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const requests = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method || 'GET', body });
    let status = 200, json = { ok: true };
    if (url === '/api/agent-providers') json = JSON.parse(JSON.stringify(data));
    else if (url === '/api/agent-providers/call') {
      const fn = calls[body.method];
      if (fn) ({ status = 200, json } = await fn(body.params, requests));
      else json = { ok: true, result: READS[body.method] || { ok: true } };
    } else if (url === '/api/access/confirm') json = body.passcode === 'pc' ? { ok: true, until: 1 } : { ok: false, error: 'bad_passcode' };
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  const ctx = { window, document, fetch, setTimeout, clearTimeout, URL, URLSearchParams, console, navigator: {} };
  window.fetch = fetch;
  vm.createContext(ctx);
  for (const code of CODE) vm.runInContext(code, ctx);
  const host = document.getElementById('host');
  const calls_ = () => requests.filter(r => r.url === '/api/agent-providers/call').map(r => r.body);
  return { window, document, host, AP: window.VOAgentProviders, requests, calls: calls_ };
}
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));
const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const byText = (root, sel, t) => $$(root, sel).find(el => text(el) === t);
async function openTab(e, kind, tab) {
  await e.AP.mountPage(e.host, { kind });
  const b = $(e.host, `.ap-tab[data-tab="${tab}"]`);
  assert.ok(b, `tab ${tab}`);
  b.click(); await flush();
  return $(e.host, '.ap-menu-body');
}
const modal = document => $(document, '.ap-modal');
const rows = dlg => $$(dlg, '.ap-row').map(r => $$(r, 'span, s, b').map(text));
async function answer(document, label) { byText(modal(document), 'button', label).click(); await flush(); }

test('1. numbers and switches named like tokens are settings; only text secrets get a password box', { skip: SKIP }, async () => {
  const e = await env();
  const body = await openTab(e, 'hermes', 'settings');
  byText(body, '.pm-sec', 'Limits').click(); await flush();
  const field = p => $(body, `.pm-field[data-field="${p}"]`);
  const input = p => $(field(p), 'input, select, textarea');
  for (const p of ['compression.proactive_prune_tokens', 'model.max_tokens', 'agent.max_turns']) {
    assert.equal(input(p).getAttribute('type'), 'number', p);
    assert.equal(field(p).getAttribute('data-secret'), null, p);
  }
  assert.equal(input('compression.proactive_prune_tokens').getAttribute('value'), '2000');
  assert.equal(input('display.show_tokens').getAttribute('type'), 'checkbox');
  assert.ok(input('display.show_tokens').hasAttribute('checked'));
  // Real secrets: empty password boxes that only say whether one is set; the value never reaches the page.
  for (const [p, ph] of [['providers.openrouter.api_key', 'Set: type a new value to change it'], ['auth.token', 'Not set'], ['legacy.password', 'Set: type a new value to change it']]) {
    assert.equal(input(p).getAttribute('type'), 'password', p);
    assert.equal(input(p).getAttribute('value'), null, p);
    assert.equal(input(p).getAttribute('placeholder'), ph, p);
  }
  assert.ok(!e.document.documentElement.outerHTML.includes(LEAK));
  // A token count change is confirmed with its numbers; a secret change only says "a new value (hidden)".
  const n = input('compression.proactive_prune_tokens');
  n.value = '3000'; n.dispatchEvent(new e.window.Event('input', { bubbles: true }));
  const s = input('legacy.password');
  s.value = 'new-pass'; s.dispatchEvent(new e.window.Event('input', { bubbles: true }));
  byText(body, 'button', 'Review and save').click(); await flush();
  assert.deepEqual(rows(modal(e.document)), [['compression.proactive_prune_tokens', '2000', '3000'], ['legacy.password', 'Set', 'a new value (hidden)']]);
  assert.ok(!text(modal(e.document)).includes('new-pass'));
  await answer(e.document, 'Save');
  const patch = e.calls().find(c => c.method === 'config.patch');
  assert.deepEqual(patch.params.changes, { 'compression.proactive_prune_tokens': 3000, 'legacy.password': 'new-pass' });
});

test('2. mountPage({tab}) opens that menu tab; a tab the connection has no menu for falls back to Connection', { skip: SKIP }, async () => {
  const e = await env();
  await e.AP.mountPage(e.host, { kind: 'hermes', select: 'lab', tab: 'models' });
  await flush();
  assert.equal(text($(e.host, '.ap-tab.on')), 'Models');
  assert.ok($(e.host, '.ap-menu-body[data-tab="models"]'));
  assert.ok(e.calls().some(c => c.method === 'models.options'));
  const f = await env();
  await f.AP.mountPage(f.host, { kind: 'hermes', select: 'lab', tab: 'nonsense' });
  assert.equal(text($(f.host, '.ap-tab.on')), 'Connection');
  assert.equal($(f.host, '.ap-menu-body'), null);
  // Switching to another provider starts on its Connection tab again.
  const g = await env();
  await g.AP.mountPage(g.host, { kind: 'hermes', tab: 'settings' }); await flush();
  assert.equal(text($(g.host, '.ap-tab.on')), 'Settings');
  await g.AP.mountPage(g.host, { kind: 'openclaw' }); await flush();
  assert.equal(text($(g.host, '.ap-tab.on')), 'Connection');
});

// 3. Keys tab: env.list (names + set/not set only), env.set through confirm + passcode, never shown back.
const KEYS = { keys: [
  { key: 'OPENROUTER_API_KEY', set: true, secret: true, category: 'provider', providerLabel: 'OpenRouter', description: 'Models from many makers.', url: 'https://openrouter.ai/keys' },
  { key: 'TAVILY_API_KEY', set: false, secret: true, category: 'tool', description: 'Web search.', url: 'javascript:alert(1)' },
  { key: 'HERMES_DEBUG_FLAG', set: false, secret: false, category: 'tool', advanced: true, description: 'Extra logging.' },
] };
const NEW = 'sk-TYPED-VALUE-42';
async function keysTab(opts = {}) {
  const e = await env(Object.assign({ calls: Object.assign({ 'env.list': async () => ({ json: { ok: true, result: KEYS } }) }, opts.calls || {}) }, opts.data ? { data: opts.data } : {}));
  return { e, body: await openTab(e, 'hermes', 'keys') };
}
const keyRow = (body, k) => $(body, `.pm-key[data-key="${k}"]`);
async function typeAndSave(e, body, k, value = NEW) {
  byText(keyRow(body, k), 'button', $(keyRow(body, k), '.ap-tag').textContent === 'Set' ? 'Change' : 'Set').click(); await flush();
  const inp = $(keyRow(body, k), '.pm-val');
  inp.value = value;
  byText(keyRow(body, k), 'button', 'Save').click(); await flush();
  return inp;
}

test('3a. Keys tab lists names and set / not set only; advanced keys behind a switch; only http(s) links', { skip: SKIP }, async () => {
  const { e, body } = await keysTab();
  assert.deepEqual(e.calls().find(c => c.method === 'env.list').params, { profile: 'default' });
  assert.deepEqual($$(body, '.pm-key').map(r => r.dataset.key), ['OPENROUTER_API_KEY', 'TAVILY_API_KEY']);
  assert.equal(text($(keyRow(body, 'OPENROUTER_API_KEY'), '.ap-tag')), 'Set');
  assert.equal(text($(keyRow(body, 'TAVILY_API_KEY'), '.ap-tag')), 'Not set');
  assert.equal($(keyRow(body, 'OPENROUTER_API_KEY'), 'a').getAttribute('href'), 'https://openrouter.ai/keys');
  assert.equal($(keyRow(body, 'TAVILY_API_KEY'), 'a'), null);
  assert.equal(text($(body, '.pm-count')), '1 of 3 set');
  const all = $(body, '.pm-all'); all.checked = true; all.dispatchEvent(new e.window.Event('change', { bubbles: true }));
  assert.equal($$(body, '.pm-key').length, 3);
  const q = $(body, '.pm-q'); q.value = 'search'; q.dispatchEvent(new e.window.Event('input', { bubbles: true }));
  assert.deepEqual($$(body, '.pm-key').map(r => r.dataset.key), ['TAVILY_API_KEY']);
  assert.equal($$(body, '.pm-val').length, 0);   // no value box until Set / Change
});

test('3b. setting a key: confirm (value hidden) -> passcode -> one retry; the value never comes back to the page', { skip: SKIP }, async () => {
  let n = 0;
  const refuse = { status: 403, json: { ok: false, error: 'reauth_required', message: 'Changing the agent platform needs your office passcode: confirm it to continue.' } };
  const { e, body } = await keysTab({ calls: { 'env.set': async () => (++n === 1 ? refuse : { json: { ok: true, result: { ok: true, key: 'TAVILY_API_KEY', set: true } } }) } });
  // Cancel posts nothing.
  await typeAndSave(e, body, 'TAVILY_API_KEY');
  let dlg = modal(e.document);
  assert.equal(text($(dlg, 'h3')), 'Set a key in Hermes');
  assert.deepEqual(rows(dlg), [['TAVILY_API_KEY', 'Not set', 'a new value (hidden)']]);
  assert.ok(!text(dlg).includes(NEW));
  await answer(e.document, 'Cancel');
  assert.equal(e.calls().filter(c => c.method === 'env.set').length, 0);
  byText(keyRow(body, 'TAVILY_API_KEY'), 'button', 'Save').click(); await flush();
  await answer(e.document, 'Save');
  assert.equal(text($(modal(e.document), 'h3')), 'Confirm the office passcode');
  $(modal(e.document), 'input[type="password"]').value = 'pc';
  await answer(e.document, 'Confirm'); await flush(20);
  const sets = e.calls().filter(c => c.method === 'env.set');
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[1].params, { profile: 'default', key: 'TAVILY_API_KEY', value: NEW });
  assert.equal(text($(keyRow(body, 'TAVILY_API_KEY'), '.ap-tag')), 'Set');
  assert.equal($(keyRow(body, 'TAVILY_API_KEY'), '.pm-val'), null);
  assert.match(text($(e.document, '.ap-toast')), /TAVILY_API_KEY is set/);
  assert.ok(!e.document.documentElement.outerHTML.includes(NEW));
  assert.ok(!text(e.document.body).includes(NEW));
});

test('3c. a refusal is shown as the server sent it (env.set not offered yet; Chat only draws no Set button)', { skip: SKIP }, async () => {
  const msg = 'This change is not offered from the office yet.';
  const { e, body } = await keysTab({ calls: { 'env.set': async () => ({ status: 400, json: { ok: false, error: 'unsupported', message: msg } }) } });
  await typeAndSave(e, body, 'OPENROUTER_API_KEY');
  await answer(e.document, 'Save');
  assert.equal(e.calls().filter(c => c.method === 'env.set').length, 1);   // not retried
  assert.equal(text($(keyRow(body, 'OPENROUTER_API_KEY'), '.pm-err')), msg);
  assert.equal(modal(e.document), null);
  assert.ok(!e.document.documentElement.outerHTML.includes(NEW));
  // An empty value is refused here, before any confirm.
  $(keyRow(body, 'OPENROUTER_API_KEY'), '.pm-val').value = '';
  byText(keyRow(body, 'OPENROUTER_API_KEY'), 'button', 'Save').click(); await flush();
  assert.equal(modal(e.document), null);
  assert.equal(text($(keyRow(body, 'OPENROUTER_API_KEY'), '.pm-err')), 'Type the key\'s new value.');
  // Chat only: the list reads, no Set/Change buttons, the notice with "Edit the connection".
  const c = await keysTab({ data: fixture('chat') });
  assert.equal($$(c.body, '.pm-key').length, 2);
  assert.equal($$(c.body, '.pm-key button').length, 0);
  assert.ok($(c.body, '.pm-chatonly'));
});

test('4. a refusal without a message of its own still reads as a plain sentence (no bare status code)', { skip: SKIP }, async () => {
  const cases = [[500, null, 'The office server ran into a problem. Try again in a moment.'], [502, null, 'The office server ran into a problem. Try again in a moment.'],
    [403, null, 'The office did not allow that.'], [400, { ok: false, error: 'bad_request' }, 'The office could not do that. Try again.'],
    [403, { ok: false, error: 'chat_only', message: 'This connection has Chat only access.', fix: 'Edit the connection and choose Full access.' }, 'This connection has Chat only access.']];
  for (const [status, json, want] of cases) {
    const e = await env({ calls: { status: async () => ({ status, json }) } });
    const body = await openTab(e, 'hermes', 'overview');
    assert.ok(text(body).includes(want), `${status}: ${text(body)}`);
    assert.doesNotMatch(text(body), /\b(answered|chat_only|bad_request|undefined|null)\b|\b5\d\d\b/);
  }
});
