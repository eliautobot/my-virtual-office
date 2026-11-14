// Provider menus in Agent Providers (Hermes port B5, design 3.7 / 3.8) against a mock of POST /api/agent-providers/call:
//   NODE_PATH=<dir with linkedom> node tests/test_hp_pages_menus.mjs
// Every write shows a confirm first (Cancel posts nothing), reauth_required -> passcode dialog -> one retry,
// Chat only shows notices and no write buttons, secret settings stay empty, config writes send base and a
// conflict is shown (never retried), Hermes' expensive-model confirm, OpenClaw approvals with the base hash.
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
const LEAK = 'LEAKED-SECRET-9';

function fixture({ access = 'full', ocAccess = 'full', code = '' } = {}) {
  return { manifests: {}, providers: [
    { id: 'lab', kind: 'hermes', transport: 'serve', name: 'Hermes Lab', enabled: true, access,
      status: code ? { state: 'error', code } : { state: 'connected', version: '0.22.2' },
      fields: { url: 'http://127.0.0.1:9119', auth: 'token', access }, secrets: { token: true },
      agents: [{ id: 'lab', name: 'Default', nativeId: 'default' }, { id: 'lab-research', name: 'Research', nativeId: 'research' }] },
    { id: 'astra', kind: 'hermes', transport: 'api', name: 'Astra', enabled: true, access: 'full', status: { state: 'connected' },
      fields: { apiUrl: 'http://127.0.0.1:8642', access: 'full' }, secrets: {}, agents: [{ id: 'astra', name: 'Astra', nativeId: 'astra' }], legacy: {} },
    { id: 'openclaw', kind: 'openclaw', transport: 'gateway', name: 'OpenClaw', enabled: true, access: ocAccess,
      status: { state: 'connected', version: '2026.10.1' }, fields: { url: 'ws://127.0.0.1:18789', access: ocAccess }, secrets: { token: true },
      agents: [{ id: 'main', name: 'Main', nativeId: 'main' }] },
  ] };
}

// Answers of the mock /call, by method. Writes answer {ok:true} unless a test overrides them.
const READS = {
  status: { version: '0.22.2', auth_required: false, gateway_running: true, profiles: [{}, {}] },
  analytics: { totals: { sessions: 3, input_tokens: 1200, output_tokens: 300, cost: 0.12 } },
  'profiles.list': { profiles: [{ name: 'default', is_default: true, model: 'm1' }, { name: 'research', model: 'm2' }] },
  'models.options': { model: 'm1', provider: 'openrouter', providers: [{ slug: 'openrouter', name: 'OpenRouter', is_current: true, models: ['m1', 'big-model'] }] },
  'toolsets.list': [{ name: 'web', label: 'Web', enabled: true }, { name: 'browser', label: 'Browser', enabled: false }],
  'skills.list': [{ name: 'notes', enabled: true }, { name: 'maps', enabled: false }],
  'cron.list': { jobs: [{ id: 'j1', name: 'Morning news', schedule: '0 8 * * *' }] },
  'mcp.list': { servers: [{ name: 'fs', enabled: true, transport: 'stdio', command: 'mcp-fs' }] },
  'sessions.list': { sessions: [{ id: 's1', key: 's1', title: 'Hello', source: 'virtual-office', agentId: 'main' }] },
  'config.schema': { category_order: ['agent', 'model'], fields: {
    'agent.reasoning_effort': { category: 'agent', type: 'select', options: ['low', 'medium', 'high'], description: 'How hard it thinks.' },
    'model.provider': { category: 'model', type: 'string' },
    'providers.openrouter.api_key': { category: 'model', type: 'string' },
    'providers.other.api_key': { category: 'model', type: 'string' } } },
  'config.get': { config: { agent: { reasoning_effort: 'medium' }, model: { provider: 'openrouter' },
    providers: { openrouter: { api_key: { secret: true, set: true } }, other: { api_key: { secret: true, set: false } } } } },
  'channels.status': { channelOrder: ['telegram'], channelLabels: { telegram: 'Telegram' }, channels: { telegram: { configured: true, running: true, connected: true } } },
  'system.info': { machineName: 'box', platform: 'linux' },
  'agents.list': { defaultId: 'main', agents: [{ id: 'main', name: 'Main', model: 'openai/gpt-5' }] },
  'models.list': { models: [{ id: 'gpt-5', provider: 'openai' }, { id: 'sonnet', provider: 'anthropic' }] },
  'exec.approvals.get': { hash: 'H1', file: { version: 1, defaults: { security: 'allowlist', ask: 'on-miss' }, agents: { main: { allowlist: [{ pattern: 'ls *' }] } } } },
  'exec.approval.grants.list': { grants: [{ id: 'g1', command: 'git status', agentId: 'main' }] },
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
      else if (body.method in READS) json = body.method === 'status' ? READS.status : { ok: true, result: READS[body.method] };   // a bare answer works too
      else json = { ok: true, result: { ok: true } };
    } else if (url === '/api/access/confirm') json = body.passcode === 'pc' ? { ok: true, until: 1 } : { ok: false, error: 'bad_passcode' };
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  const ctx = { window, document, fetch, setTimeout, clearTimeout, URL, console, navigator: {} };
  window.fetch = fetch;
  vm.createContext(ctx);
  for (const code of CODE) vm.runInContext(code, ctx);
  const host = document.getElementById('host');
  const calls_ = () => requests.filter(r => r.url === '/api/agent-providers/call').map(r => r.body);
  return { window, document, host, AP: window.VOAgentProviders, requests, calls: calls_, writes: () => calls_().filter(b => WRITES.has(b.method)) };
}
const WRITES = new Set(['profiles.create', 'model.default', 'toolsets.set', 'skills.set', 'mcp.set', 'cron.pause', 'cron.resume', 'cron.run', 'cron.remove', 'sessions.delete', 'config.patch',
  'agents.update', 'exec.approvals.set', 'exec.approval.grants.revoke']);
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

test('Hermes: Connection + 10 tabs on a serve row, none on a legacy row', { skip: SKIP }, async () => {
  const e = await env();
  await e.AP.mountPage(e.host, { kind: 'hermes' });
  assert.deepEqual($$(e.host, '.ap-tab').map(text), ['Connection', 'Overview', 'Agents', 'Models', 'Tools', 'Skills', 'Automations', 'MCP servers', 'Sessions', 'Settings', 'Keys']);
  byText(e.host, '.ap-conn .ap-conn-name', 'Astra').closest('.ap-conn').click(); await flush();
  assert.equal($$(e.host, '.ap-tab').length, 0);
  const body = await openTab(await env(), 'hermes', 'overview');
  assert.match(text(body), /Version\s*0\.22\.2/);
  assert.match(text(body), /Last 7 days/); assert.match(text(body), /Last 30 days/);
});

test('a write shows the confirm first: Cancel posts nothing, Confirm posts the call once', { skip: SKIP }, async () => {
  const e = await env();
  const body = await openTab(e, 'hermes', 'tools');
  byText(body, 'button', 'Switch on').click(); await flush();
  let dlg = modal(e.document);
  assert.equal(text($(dlg, 'h3')), 'Switch on a toolset');
  assert.deepEqual(rows(dlg), [['default: browser', 'off', 'on']]);
  assert.match(text(dlg), /Takes effect at once/);
  await answer(e.document, 'Cancel');
  assert.equal(e.writes().length, 0);
  byText($(e.host, '.ap-menu-body'), 'button', 'Switch on').click(); await flush();
  await answer(e.document, 'Switch on');
  assert.deepEqual(e.writes(), [{ id: 'lab', method: 'toolsets.set', params: { profile: 'default', name: 'browser', enabled: true } }]);
  // Automations: Remove is a danger confirm with the schedule as "from".
  const auto = await openTab(e, 'hermes', 'automations');
  byText(auto, 'button', 'Remove').click(); await flush();
  assert.ok(modal(e.document).classList.contains('danger'));
  assert.deepEqual(rows(modal(e.document)), [['Morning news', '0 8 * * *', 'removed']]);
  await answer(e.document, 'Remove');
  assert.deepEqual(e.writes().at(-1), { id: 'lab', method: 'cron.remove', params: { profile: 'default', id: 'j1' } });
});

test('reauth_required -> passcode dialog -> one retry; a second refusal is not retried again', { skip: SKIP }, async () => {
  let n = 0;
  const refuse = { status: 403, json: { ok: false, error: 'reauth_required', message: 'Changing the agent platform needs your office passcode: confirm it to continue.' } };
  const e = await env({ calls: { 'mcp.set': async () => (++n === 1 ? refuse : { json: { ok: true, result: { ok: true } } }) } });
  const body = await openTab(e, 'hermes', 'mcp');
  byText(body, 'button', 'Switch off').click(); await flush();
  await answer(e.document, 'Switch off');
  assert.equal(text($(modal(e.document), 'h3')), 'Confirm the office passcode');
  $(modal(e.document), 'input[type="password"]').value = 'pc';
  await answer(e.document, 'Confirm'); await flush(20);
  assert.equal(n, 2);
  assert.deepEqual(e.requests.filter(r => r.url === '/api/access/confirm' || (r.body && WRITES.has(r.body.method))).map(r => r.url), ['/api/agent-providers/call', '/api/access/confirm', '/api/agent-providers/call']);
  // Always refused: one dialog, one retry, then the message.
  const e2 = await env({ calls: { 'mcp.set': async () => refuse } });
  const b2 = await openTab(e2, 'hermes', 'mcp');
  byText(b2, 'button', 'Switch off').click(); await flush();
  await answer(e2.document, 'Switch off');
  $(modal(e2.document), 'input[type="password"]').value = 'pc';
  await answer(e2.document, 'Confirm'); await flush(20);
  assert.equal(e2.writes().length, 2);
  assert.equal(modal(e2.document), null);
  assert.match(text($(e2.document, '.ap-toast')), /needs your office passcode/);
});

test('Chat only: notices on every tab with writes, no write buttons, inputs disabled, reads still work', { skip: SKIP }, async () => {
  const e = await env({ data: fixture({ access: 'chat' }) });
  for (const tab of ['agents', 'models', 'tools', 'skills', 'automations', 'mcp', 'sessions', 'settings']) {
    const body = await openTab(e, 'hermes', tab);
    assert.match(text($(body, '.pm-chatonly')), /This connection has Chat only access: Hermes' settings are not changed from here\./, tab);
    assert.ok(byText(body, 'button', 'Edit the connection'), `${tab}: edit button`);
    assert.equal($$(body, '[data-do="toggle"], [data-do="default"], [data-do="pause"], [data-do="resume"], [data-do="run"], [data-do="remove"], [data-do="del"], [data-do="hint"], .pm-form').length, 0, tab);
    for (const c of $$(body, 'input[type="checkbox"]')) assert.ok(c.disabled, `${tab}: checkbox disabled`);
  }
  const body = $(e.host, '.ap-menu-body');
  byText(body, 'button', 'Model').click(); await flush();
  for (const i of $$(body, '.pm-field input, .pm-field select')) assert.ok(i.disabled, 'settings input disabled');
  assert.ok($(body, '.pm-savebar').hasAttribute('hidden'));
  assert.equal(e.writes().length, 0);
  byText(body, 'button', 'Edit the connection').click(); await flush();
  assert.ok($(e.host, '.ap-form'), 'Edit the connection opens the form');
});

test('Settings: secret inputs stay empty, a change is confirmed with base, a conflict is shown and not retried', { skip: SKIP }, async () => {
  let patches = 0;
  const e = await env({ calls: { 'config.patch': async () => { patches++; return { status: 409, json: { ok: false, error: 'conflict', message: 'Hermes\' settings were changed elsewhere meanwhile. Reload the tab and try again.' } }; } } });
  const body = await openTab(e, 'hermes', 'settings');
  byText(body, 'button', 'Model').click(); await flush();
  const [setKey, unsetKey] = ['providers.openrouter.api_key', 'providers.other.api_key'].map(k => $(body, `.pm-field[data-field="${k}"] input`));
  assert.equal(setKey.type || setKey.getAttribute('type'), 'password');
  assert.equal(setKey.value, '');
  assert.equal(setKey.getAttribute('placeholder'), 'Set: type a new value to change it');
  assert.equal(unsetKey.getAttribute('placeholder'), 'Not set');
  setKey.value = LEAK; setKey.dispatchEvent(new e.window.Event('input', { bubbles: true }));
  const prov = $(body, '.pm-field[data-field="model.provider"] input');
  prov.value = 'anthropic'; prov.dispatchEvent(new e.window.Event('input', { bubbles: true }));
  assert.ok(!$(body, '.pm-savebar').hasAttribute('hidden'));
  assert.equal(text($(body, '.pm-n')), '2 changes not saved');
  byText(body, 'button', 'Review and save').click(); await flush();
  const dlg = modal(e.document);
  assert.deepEqual(rows(dlg), [['providers.openrouter.api_key', 'Set', 'a new value (hidden)'], ['model.provider', 'openrouter', 'anthropic']]);
  assert.ok(!text(dlg).includes(LEAK));
  await answer(e.document, 'Save'); await flush();
  assert.equal(patches, 1);
  assert.deepEqual(e.writes()[0].params, { profile: 'default', changes: { 'providers.openrouter.api_key': LEAK, 'model.provider': 'anthropic' },
    base: { 'providers.openrouter.api_key': { secret: true, set: true }, 'model.provider': 'openrouter' } });
  assert.match(text($(body, '.pm-conflict')), /changed elsewhere meanwhile\. Reload the tab and try again\./);
  assert.ok(byText(body, 'button', 'Reload the tab'));
  // Effort lives in Settings (agent.reasoning_effort), and the office platform hint can be added.
  byText(body, 'button', 'Agent').click(); await flush();
  assert.ok($(body, '.pm-field[data-field="agent.reasoning_effort"] select'));
  byText(body, 'button', 'Add the hint').click(); await flush();
  assert.match(text($(modal(e.document), 'h3')), /office chat window/);
  await answer(e.document, 'Cancel');
  assert.equal(patches, 1);
});

test('Models: Hermes asks before an expensive model, then the same call goes once more with confirm', { skip: SKIP }, async () => {
  const e = await env({ calls: { 'model.default': async p => ({ json: { ok: true, result: p.confirm ? { ok: true } : { confirm_required: true, confirm_message: 'This model costs a lot.' } } }) } });
  const body = await openTab(e, 'hermes', 'models');
  byText(body, 'button', 'Make default').click(); await flush();
  assert.deepEqual(rows(modal(e.document)), [['Model', 'm1 (openrouter)', 'big-model (openrouter)']]);
  await answer(e.document, 'Change'); await flush();
  assert.equal(text($(modal(e.document), 'h3')), 'Hermes asks to confirm');
  assert.match(text(modal(e.document)), /This model costs a lot\./);
  await answer(e.document, 'Use it'); await flush();
  assert.deepEqual(e.writes().map(w => w.params), [{ profile: 'default', provider: 'openrouter', model: 'big-model' }, { profile: 'default', provider: 'openrouter', model: 'big-model', confirm: true }]);
});

test('OpenClaw: tabs, Agents model change, Approvals with the base hash; Chat only asks no admin read', { skip: SKIP }, async () => {
  const e = await env();
  await e.AP.mountPage(e.host, { kind: 'openclaw' });
  assert.deepEqual($$(e.host, '.ap-tab').map(text), ['Connection', 'Overview', 'Agents', 'Approvals', 'Sessions', 'Automations', 'Skills']);
  const ov = await openTab(e, 'openclaw', 'overview');
  assert.match(text(ov), /Version\s*2026\.10\.1/); assert.match(text(ov), /Telegram\s*Connected/);
  const ag = await openTab(e, 'openclaw', 'agents');
  const sel = $(ag, '.pm-model');
  for (const o of sel.querySelectorAll('option')) { if (o.getAttribute('value') === 'anthropic/sonnet') o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
  byText(ag, 'button', 'Save').click(); await flush();
  assert.deepEqual(rows(modal(e.document)), [['main: model', 'openai/gpt-5', 'anthropic/sonnet']]);
  await answer(e.document, 'Change');
  assert.deepEqual(e.writes().at(-1), { id: 'openclaw', method: 'agents.update', params: { agentId: 'main', model: 'anthropic/sonnet' } });
  const ap = await openTab(e, 'openclaw', 'approvals');
  byText(ap, 'button', 'Remove').click(); await flush();
  await answer(e.document, 'Remove');
  const set = e.writes().at(-1);
  assert.equal(set.method, 'exec.approvals.set');
  assert.equal(set.params.baseHash, 'H1');
  assert.deepEqual(set.params.file.agents.main.allowlist, []);
  assert.ok(byText($(e.host, '.ap-menu-body'), 'button', 'Revoke'));
  const auto = await openTab(e, 'openclaw', 'automations');
  assert.equal($(auto, 'a.ps-button').getAttribute('href'), '/cron.html');

  const c = await env({ data: fixture({ ocAccess: 'chat' }) });
  const cap = await openTab(c, 'openclaw', 'approvals');
  assert.match(text(cap), /This connection has Chat only access: edit the connection to see and change this\./);
  const cag = await openTab(c, 'openclaw', 'agents');
  assert.match(text($(cag, '.pm-chatonly')), /OpenClaw's settings are not changed from here/);
  assert.equal($$(cag, '.pm-model, [data-do="model"]').length, 0);
  await openTab(c, 'openclaw', 'overview');
  assert.deepEqual(c.calls().map(b => b.method).filter(m => /^(exec\.approvals\.get|exec\.approval\.grants\.list|system\.info)$/.test(m)), []);
  assert.equal(c.writes().length, 0);
});

test('a server chat_only refusal of a read shows the notice; signin_not_engaged offers Enter the credentials', { skip: SKIP }, async () => {
  const e = await env({ calls: { 'sessions.list': async () => ({ status: 403, json: { ok: false, error: 'chat_only', message: 'This connection has Chat only access: edit the connection to see and change this.', fix: 'Open Agent Providers, Edit the connection and choose Full access.' } }) } });
  const body = await openTab(e, 'openclaw', 'sessions');
  assert.match(text($(body, '.pm-chatonly')), /edit the connection to see and change this/);
  const s = await env({ data: fixture({ code: 'signin_not_engaged' }) });
  await s.AP.mountPage(s.host, { kind: 'hermes' });
  const card = $(s.host, '.ap-card.bad');
  assert.match(text(card), /only accepts its session token on this address/);
  assert.match(text(card), /Use Session token mode, or start Hermes with a public address and a password\./);
  assert.ok(byText(card, 'button', 'Enter the credentials'));
});
