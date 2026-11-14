// Agent Providers connection editor (Hermes port A5, design 3.2-3.6) against a mock of the 2.6 routes:
//   NODE_PATH=<dir with linkedom> node tests/test_hp_pages_editor.mjs
// Form validation, secret placeholders, no secret value ever rendered, Test never saves, Save payload,
// status cards, legacy switch dialog payload, Remove confirm, OpenClaw form, passcode retry, 404 fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = fs.readFileSync(path.join(ROOT, 'app/agent-providers.js'), 'utf8');

function loadLinkedom() {
  for (const base of [process.env.NODE_PATH].filter(Boolean)) {
    for (const dir of base.split(path.delimiter)) {
      try { return require(path.join(dir, 'linkedom')); } catch (e) { /* next */ }
    }
  }
  try { return require('linkedom'); } catch (e) { return null; }
}
const linkedom = loadLinkedom();
const SKIP = linkedom ? false : 'linkedom not found (set NODE_PATH)';
const LEAKS = ['LEAKED-TOKEN-1', 'LEAKED-KEY-2', 'LEAKED-OC-3', 'LEAKED-PW-4'];

function fixture({ withServe = true } = {}) {
  const providers = [];
  if (withServe) providers.push({
    id: 'hermes-lab', kind: 'hermes', transport: 'serve', name: 'Hermes Lab', enabled: true, access: 'full',
    status: { state: 'connected', version: '0.22.2', detail: 'Connected to Hermes 0.22.2.' },
    // A careless server leaking secrets into fields: the page must still never show them.
    fields: { url: 'http://127.0.0.1:9119', auth: 'token', access: 'full', token: 'LEAKED-TOKEN-1', password: 'LEAKED-PW-4' },
    secrets: { token: true, tokens: true },
    agents: [
      { id: 'hermes-lab', name: 'Default', emoji: '☤', nativeId: 'default' },
      { id: 'hermes-lab-research', name: 'Research', emoji: '🔬', nativeId: 'research' },
      { id: 'hermes-lab-astra', name: 'astra', nativeId: 'astra', hidden: true, reason: 'reached through the older connection "astra"' },
      { id: 'hermes-lab-coby', name: 'coby', nativeId: 'coby', hidden: true, reason: 'reached through the older connection "coby"' },
    ],
  });
  providers.push(
    { id: 'astra', kind: 'hermes', transport: 'api', name: 'Astra', enabled: true, access: 'full',
      status: { state: 'connected' }, fields: { apiUrl: 'http://127.0.0.1:8642', access: 'full', apiKey: 'LEAKED-KEY-2' },
      secrets: { apiKey: true }, agents: [{ id: 'astra', name: 'Astra', nativeId: 'hermes-agent' }], legacy: {} },
    { id: 'coby', kind: 'hermes', transport: 'api', name: 'Coby', enabled: true, access: 'chat',
      status: { state: 'error', code: 'auth_rejected', detail: 'Hermes refused the session token.', fix: 'Start it with HERMES_DASHBOARD_SESSION_TOKEN and enter the same here (Edit).' },
      fields: { apiUrl: 'http://127.0.0.1:8954', access: 'chat' }, secrets: {}, agents: [{ id: 'coby', name: 'Coby', nativeId: 'coby' }], legacy: { profile: 'coby' } },
    { id: 'openclaw', kind: 'openclaw', transport: 'gateway', name: 'OpenClaw', enabled: true, access: 'chat',
      status: { state: 'connected', version: '2026.10.1' }, fields: { url: 'ws://127.0.0.1:18789', access: 'chat', gatewayToken: 'LEAKED-OC-3' },
      secrets: { token: 'openclaw' }, agents: [{ id: 'main', name: 'Ada', emoji: '🦀', nativeId: 'main' }] });
  return { providers, manifests: {} };
}

async function env({ data = fixture(), kind = 'hermes', routes = {} } = {}) {
  const { window, document } = linkedom.parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const requests = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method || 'GET', body });
    const route = routes[url];
    let status = 200, json = { ok: true };
    if (route) ({ status = 200, json } = await route(body, requests));
    else if (url === '/api/agent-providers') json = JSON.parse(JSON.stringify(data));
    else if (url.endsWith('/test')) json = { ok: true, detail: 'Connected to Hermes 0.22.2: 4 profiles' };
    else if (url.endsWith('/save')) json = { ok: true, id: body.id || 'hermes-new', status: { state: 'connecting' } };
    else if (url.endsWith('/switch')) json = { ok: true, moved: body.moves.map(m => Object.assign({ agentId: m.legacyId }, m)) };
    else if (url.endsWith('/detect')) json = { found: [{ url: 'http://127.0.0.1:9119', version: '0.22.2', authRequired: true }] };
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  const ctx = { window, document, fetch, setTimeout, clearTimeout, URL, console, navigator: {} };
  window.fetch = fetch;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const AP = window.VOAgentProviders;
  const host = document.getElementById('host');
  await AP.mountPage(host, { kind });
  return { window, document, host, AP, requests, writes: () => requests.filter(r => r.method === 'POST') };
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));
const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const byText = (root, sel, t) => $$(root, sel).find(el => text(el) === t);
function setSelect(el, value) {
  for (const o of el.querySelectorAll('option')) { if (o.getAttribute('value') === value) o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true }));
}
const input = (form, key) => form.querySelector(`.apf[data-key="${key}"]`);
const wrapShown = (form, key) => !form.querySelector(`.ap-f[data-key="${key}"]`).hasAttribute('hidden');
const ferr = (form, key) => text(form.querySelector(`.ap-f[data-key="${key}"] .ap-ferr`));
const noLeak = (document, label) => {
  const html = document.documentElement.outerHTML;
  for (const leak of LEAKS) assert.ok(!html.includes(leak), `${label}: secret ${leak} rendered`);
  for (const el of document.querySelectorAll('input')) assert.ok(!LEAKS.includes(el.value), `${label}: secret in an input value`);
};

test('list and connection page: names, states, agents, no secret shown', { skip: SKIP }, async () => {
  const { document, host } = await env();
  const conns = $$(host, '.ap-conn');
  assert.equal(conns.length, 3, 'hermes kind shows the serve row and both legacy rows');
  assert.match(text(conns[0]), /Hermes Lab/); assert.match(text(conns[0]), /Connected/); assert.match(text(conns[0]), /2 agents/);
  assert.match(text(conns[2]), /Needs attention/);
  assert.equal(text($(host, '.ap-pill')), 'Connected · Hermes 0.22.2');
  assert.equal(text($(host, '.ap-tag')), 'Full access');
  for (const label of ['Reconnect', 'Edit', 'Switch off', 'Remove']) assert.ok(byText(host, '.ap-acts button', label), label + ' button');
  const hidden = $$(host, '.ap-agent.hidden-agent');
  assert.equal(hidden.length, 2);
  assert.match(text(hidden[0]), /Not shown in the office: reached through the older connection "astra"/);
  assert.equal(hidden[0].querySelector('.ap-chat'), null, 'hidden agent has no Chat');
  assert.equal($(host, 'a.ap-chat').getAttribute('href'), '/?chat=hermes-lab');
  assert.deepEqual($$(host, '.ap-kv').map(r => text(r.querySelector('span')) + '=' + text(r.querySelector('b'))), ['Address=http://127.0.0.1:9119', 'Access=Full access: chat and settings', 'Signs in=Session token']);
  assert.equal($$(host, '.ap-pick option').length, 3, 'phone select lists the same connections');
  noLeak(document, 'connection page');
});

test('Edit form: secret placeholders, showIf, requiredIf, unlessSet', { skip: SKIP }, async () => {
  const { document, host } = await env();
  byText(host, '.ap-acts button', 'Edit').click(); await flush();
  const form = $(host, '.ap-form');
  const token = input(form, 'token');
  assert.equal(token.getAttribute('type'), 'password');
  assert.equal(token.getAttribute('autocomplete'), 'new-password');
  assert.equal(token.getAttribute('placeholder'), 'Set: leave blank to keep it');
  assert.equal(token.hasAttribute('value'), false, 'no value attribute on a secret');
  assert.ok(wrapShown(form, 'token') && !wrapShown(form, 'username') && !wrapShown(form, 'password'));
  setSelect(input(form, 'auth'), 'password'); await flush();
  assert.ok(!wrapShown(form, 'token') && wrapShown(form, 'username') && wrapShown(form, 'password'), 'auth switch shows the right fields');
  assert.equal(input(form, 'password').getAttribute('placeholder'), 'Not needed: signed in. Type it only to sign in again.');
  byText(form, 'button', 'Save').click(); await flush();
  assert.equal(ferr(form, 'username'), 'Enter the username of Hermes\' sign-in.');
  assert.equal(ferr(form, 'password'), '', 'password not required while signed in');
  noLeak(document, 'edit form');
});

test('Add form: type choice, address and token errors, long name, nothing posted', { skip: SKIP }, async () => {
  const { host, writes } = await env();
  byText(host, '.ap-side button', 'Add a connection').click(); await flush();
  const form = $(host, '.ap-form');
  assert.equal($$(form, 'input[name="ap-type"]').length, 2, 'Hermes and the older API server');
  assert.match(text(form), /Older API server \(legacy\)/);
  assert.equal(input(form, 'url').getAttribute('value'), 'http://127.0.0.1:9119', 'default address');
  input(form, 'url').value = '127.0.0.1:9119';
  input(form, 'name').value = 'x'.repeat(61);
  byText(form, 'button', 'Connect Hermes').click(); await flush();
  assert.equal(ferr(form, 'url'), 'The address starts with http:// or https://.');
  assert.equal(ferr(form, 'token'), 'Enter the session token.');
  assert.equal(ferr(form, 'name'), 'Give the connection a name of up to 60 characters.');
  assert.equal(writes().length, 0, 'invalid form posts nothing');
});

test('Test never saves; Find fills the address; Connect posts the form', { skip: SKIP }, async () => {
  const { host, writes } = await env();
  byText(host, '.ap-side button', 'Add a connection').click(); await flush();
  let form = $(host, '.ap-form');
  byText(form, 'button', 'Find').click(); await flush();
  assert.match(text(form), /Hermes 0\.22\.2, asks for a username and password/);
  byText(form, '.ap-found button', 'Use').click(); await flush();
  assert.ok(wrapShown(form, 'username'), 'Use with authRequired switches to Username and password');
  setSelect(input(form, 'auth'), 'token'); await flush();
  input(form, 'token').value = 'tok-123';
  byText(form, 'button', 'Test').click(); await flush();
  assert.deepEqual(writes().map(r => r.url), ['/api/agent-providers/detect', '/api/agent-providers/test']);
  assert.deepEqual(writes()[1].body, { kind: 'hermes', transport: 'serve', values: { url: 'http://127.0.0.1:9119', auth: 'token', token: 'tok-123', access: 'full' } });
  assert.match(text($(form, '.ap-form-status')), /Connected to Hermes 0\.22\.2: 4 profiles/);
  byText(form, 'button', 'Connect Hermes').click(); await flush(20);
  const save = writes().find(r => r.url.endsWith('/save'));
  assert.deepEqual(save.body, { kind: 'hermes', transport: 'serve', name: 'Hermes', values: { url: 'http://127.0.0.1:9119', auth: 'token', token: 'tok-123', access: 'full' } });
});

test('Save from Edit: blank secret kept (left out), hidden fields left out', { skip: SKIP }, async () => {
  const { host, writes } = await env();
  byText(host, '.ap-acts button', 'Edit').click(); await flush();
  const form = $(host, '.ap-form');
  input(form, 'name').value = 'Hermes Home';
  setSelect(input(form, 'access'), 'chat');
  byText(form, 'button', 'Save').click(); await flush(20);
  const save = writes().find(r => r.url.endsWith('/save'));
  assert.deepEqual(save.body, { id: 'hermes-lab', kind: 'hermes', transport: 'serve', name: 'Hermes Home', values: { url: 'http://127.0.0.1:9119', auth: 'token', access: 'chat' } });
});

test('status card with Enter the credentials; legacy banner', { skip: SKIP }, async () => {
  const { host } = await env();
  $$(host, '.ap-conn')[2].click(); await flush();
  assert.equal(text($(host, '.ap-card.bad h4')), 'Hermes refused the session token.');
  assert.match(text($(host, '.ap-card.bad')), /HERMES_DASHBOARD_SESSION_TOKEN/);
  assert.equal(text($(host, '.ap-tag')), 'Chat only');
  assert.match(text($(host, '.ap-banner')), /older API server\. Switch to the full Hermes connection/);
  byText(host, '.ap-card button', 'Enter the credentials').click(); await flush();
  assert.equal(text($(host, '.ap-form .ap-kicker')), 'Edit');
  assert.ok(input($(host, '.ap-form'), 'apiUrl'), 'legacy form has the API URL');
  assert.equal(input($(host, '.ap-form'), 'profile').tagName, 'SELECT', 'profile is a select once a serve connection lists profiles');
});

test('switch dialog: guessed profiles, payload, duplicate refused, toast', { skip: SKIP }, async () => {
  const { document, host, writes } = await env();
  $$(host, '.ap-conn')[1].click(); await flush();
  byText(host, '.ap-banner button', 'Switch to the full Hermes connection').click(); await flush();
  const dlg = $(document, '.ap-modal');
  assert.equal(text($(dlg, 'h3')), 'Move these agents');
  const rows = $$(dlg, '.ap-switch-row');
  assert.deepEqual(rows.map(r => r.dataset.legacy), ['astra', 'coby']);
  assert.match(text(rows[0]), /\(guessed\)/, 'astra profile is guessed from its id');
  assert.doesNotMatch(text(rows[1]), /\(guessed\)/, 'coby has a stored profile');
  setSelect(rows[1].querySelector('select'), 'astra');
  byText(dlg, 'button', 'Switch').click(); await flush();
  assert.match(text($(dlg, '.ap-modal-err')), /Two agents cannot use the same profile/);
  assert.equal(writes().length, 0);
  setSelect(rows[1].querySelector('select'), 'coby');
  byText(dlg, 'button', 'Switch').click(); await flush(20);
  const sw = writes().find(r => r.url.endsWith('/switch'));
  assert.deepEqual(sw.body, { to: 'hermes-lab', moves: [{ legacyId: 'astra', profile: 'astra' }, { legacyId: 'coby', profile: 'coby' }] });
  assert.equal(text($(document, '.ap-toast')), 'Astra and Coby now use the full Hermes connection.');
  assert.equal($(document, '.ap-modal'), null, 'dialog closed');
});

test('switch without a serve connection opens the prefilled Add form', { skip: SKIP }, async () => {
  const { host, writes } = await env({ data: fixture({ withServe: false }) });
  byText(host, '.ap-banner button', 'Switch to the full Hermes connection').click(); await flush();
  const form = $(host, '.ap-form');
  assert.equal(form.dataset.manifest, 'hermes:serve');
  assert.equal(input(form, 'name').getAttribute('value'), 'Hermes');
  assert.equal(input(form, 'url').getAttribute('value'), 'http://127.0.0.1:9119');
  assert.equal(writes().length, 0);
});

test('Remove asks first; Cancel posts nothing', { skip: SKIP }, async () => {
  const { document, host, writes } = await env();
  byText(host, '.ap-acts button', 'Remove').click(); await flush();
  let dlg = $(document, '.ap-modal');
  assert.equal(text($(dlg, 'h3')), 'Remove "Hermes Lab"?');
  assert.match(text(dlg), /Its agents leave the office; their chats are kept\./);
  byText(dlg, 'button', 'Cancel').click(); await flush();
  assert.equal(writes().length, 0);
  byText(host, '.ap-acts button', 'Remove').click(); await flush();
  dlg = $(document, '.ap-modal');
  byText(dlg, 'button', 'Remove').click(); await flush(20);
  assert.deepEqual(writes().map(r => [r.url, r.body]), [['/api/agent-providers/remove', { id: 'hermes-lab' }]]);
});

test('OpenClaw: one connection, no Remove, ws address, token from its own settings', { skip: SKIP }, async () => {
  const { document, host } = await env({ kind: 'openclaw' });
  assert.equal($$(host, '.ap-conn').length, 1);
  assert.equal(byText(host, '.ap-acts button', 'Remove'), undefined);
  assert.equal(byText(host, '.ap-side button', 'Add a connection'), undefined);
  assert.equal(text($(host, '.ap-pill')), 'Connected · OpenClaw 2026.10.1');
  byText(host, '.ap-acts button', 'Edit').click(); await flush();
  const form = $(host, '.ap-form');
  assert.equal(input(form, 'name'), null, 'no name field');
  assert.equal(input(form, 'token').getAttribute('placeholder'), 'Read from OpenClaw\'s own settings');
  input(form, 'url').value = 'http://127.0.0.1:18789';
  byText(form, 'button', 'Save').click(); await flush();
  assert.equal(ferr(form, 'url'), 'The address starts with ws:// or wss://.');
  noLeak(document, 'openclaw');
});

test('passcode asked once on reauth_required, then one retry', { skip: SKIP }, async () => {
  let enableCalls = 0;
  const routes = {
    '/api/agent-providers/enable': async () => (++enableCalls === 1 ? { status: 403, json: { ok: false, error: 'reauth_required', message: 'Changing the agent platform needs your office passcode: confirm it to continue.' } } : { json: { ok: true } }),
    '/api/access/confirm': async body => (body.passcode === 'pc' ? { json: { ok: true, until: 1 } } : { status: 401, json: { ok: false, error: 'bad_passcode' } }),
  };
  const { document, host, writes } = await env({ routes });
  byText(host, '.ap-acts button', 'Switch off').click(); await flush();
  const dlg = $(document, '.ap-modal');
  assert.equal(text($(dlg, 'h3')), 'Confirm the office passcode');
  const pass = $(dlg, 'input[type="password"]');
  pass.value = 'wrong';
  byText(dlg, 'button', 'Confirm').click(); await flush();
  assert.equal(text($(dlg, '.ap-modal-err')), 'That passcode is not right.');
  pass.value = 'pc';
  byText(dlg, 'button', 'Confirm').click(); await flush(20);
  assert.deepEqual(writes().map(r => r.url), ['/api/agent-providers/enable', '/api/access/confirm', '/api/access/confirm', '/api/agent-providers/enable']);
  assert.deepEqual(writes()[3].body, { id: 'hermes-lab', on: false });
});

test('server manifest wins field by field (real shape); 404 leaves the page unavailable', { skip: SKIP }, async () => {
  const data = fixture();
  data.providers.find(p => p.id === 'openclaw').tokenSource = 'openclaw';
  data.providers.find(p => p.id === 'openclaw').secrets = { token: true };
  // Same shape as agent_providers.py manifests: keyed by id, a name field, a system field, button 'find'.
  data.manifests = {
    hermes: { id: 'hermes', kind: 'hermes', transport: 'serve', label: 'Hermes', fields: [
      { key: 'name', label: 'Name', type: 'text', default: 'Hermes', placeholder: 'Hermes', required: true, maxLength: 60, error: 'Give the connection a name of up to 60 characters.' },
      { key: 'url', label: 'Hermes backend address', type: 'url', default: 'http://127.0.0.1:9119', required: true, schemes: ['http', 'https'], button: 'find' },
      { key: 'auth', label: 'Sign in with', type: 'select', default: 'token', options: [{ value: 'token', label: 'Token' }, { value: 'password', label: 'Password sign-in' }] },
      { key: 'token', label: 'Session token', type: 'secret', showIf: { auth: 'token' }, requiredIf: { auth: 'token' }, error: 'Enter the session token.' },
      { key: 'username', label: 'Username', type: 'text', showIf: { auth: 'password' }, requiredIf: { auth: 'password' } },
      { key: 'password', label: 'Password', type: 'secret', showIf: { auth: 'password' }, requiredIf: { auth: 'password' }, unlessSet: 'tokens', handoff: true, handoffPlaceholder: 'Signed in already.' },
      { key: 'access', label: 'Access', type: 'select', default: 'full', options: ['full', 'chat'], labels: { full: 'Full access: chat and settings', chat: 'Chat only' } },
      { key: 'tokens', label: 'Sign-in tokens', type: 'secret', system: true, perAddress: true },
    ] },
    'hermes-api': { id: 'hermes-api', kind: 'hermes', transport: 'api', label: 'Hermes (legacy API server)', legacy: true, fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, maxLength: 60 },
      { key: 'apiUrl', label: 'API URL', type: 'url', required: true, schemes: ['http', 'https'] },
      { key: 'profile', label: 'Hermes profile', type: 'text', maxLength: 128 },
    ] },
    openclaw: { id: 'openclaw', kind: 'openclaw', transport: 'gateway', label: 'OpenClaw', single: true, fields: [
      { key: 'url', label: 'Gateway address', type: 'url', default: 'ws://127.0.0.1:18789', required: true, schemes: ['ws', 'wss'], error: 'The address starts with ws:// or wss://.' },
      { key: 'token', label: 'Gateway token', type: 'secret', fromOpenClawPlaceholder: 'From OpenClaw itself' },
    ] },
  };
  const { host, writes } = await env({ data });
  byText(host, '.ap-acts button', 'Edit').click(); await flush();
  let form = $(host, '.ap-form');
  assert.equal($$(form, '.apf[data-key="name"]').length, 1, 'one Name field');
  assert.equal(input(form, 'tokens'), null, 'system field never shown');
  assert.ok(byText(form, 'button', 'Find'), 'button: find gives the Find button');
  assert.equal(text(form.querySelector('.ap-f[data-key="url"] .ap-label')), 'Hermes backend address');
  assert.match(text(form.querySelector('.ap-f[data-key="url"] .ap-hint')), /listens on: http:\/\/127\.0\.0\.1:9119 by default/, 'hint from the built-in text');
  assert.deepEqual($$(input(form, 'auth'), 'option').map(o => text(o)), ['Token', 'Password sign-in']);
  setSelect(input(form, 'auth'), 'password'); await flush();
  assert.equal(input(form, 'password').getAttribute('placeholder'), 'Signed in already.');
  input(form, 'username').value = 'casey';
  byText(form, 'button', 'Save').click(); await flush(20);
  const save = writes().find(r => r.url.endsWith('/save'));
  assert.deepEqual(save.body, { id: 'hermes-lab', kind: 'hermes', transport: 'serve', name: 'Hermes Lab', values: { url: 'http://127.0.0.1:9119', auth: 'password', username: 'casey', access: 'full' } });
  $$(host, '.ap-conn')[1].click(); await flush();
  byText(host, '.ap-acts button', 'Edit').click(); await flush();
  form = $(host, '.ap-form');
  assert.equal(input(form, 'profile').tagName, 'SELECT', 'legacy profile is a picker even when the manifest says text');
  const oc = await env({ data, kind: 'openclaw' });
  byText(oc.host, '.ap-acts button', 'Edit').click(); await flush();
  assert.equal(input($(oc.host, '.ap-form'), 'token').getAttribute('placeholder'), 'From OpenClaw itself');
  const routes = { '/api/agent-providers': async () => ({ status: 404, json: { error: 'not found' } }) };
  await assert.rejects(env({ routes }));
});
