// v0.10.1 ocpair: the OpenClaw connection in Agent Providers shows the device pairing and never a plain
// "Connected" for a connection OpenClaw gave too few scopes (against a mock of the office API):
//   NODE_PATH=<dir with linkedom> node tests/test_openclaw_pairing_page.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const nodeSetTimeout = globalThis.setTimeout;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = ['agent-providers.js', 'chat-caps.js'].map(f => fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'));

function loadLinkedom() {
  for (const dir of (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
    try { return require(path.join(dir, 'linkedom')); } catch (e) { /* next */ }
  }
  try { return require('linkedom'); } catch (e) { return null; }
}
const linkedom = loadLinkedom();
const SKIP = linkedom ? false : 'linkedom not found (set NODE_PATH)';

const DEVICE_ID = 'abcdef1234567890'.repeat(4);
const openclaw = (status, device) => ({ manifests: {}, providers: [{
  id: 'openclaw', kind: 'openclaw', transport: 'gateway', name: 'OpenClaw', enabled: true, access: 'full',
  status, device, fields: { url: 'ws://host.docker.internal:18789', access: 'full' }, secrets: { token: true },
  agents: [{ id: 'main', name: 'Main', nativeId: 'main' }] }] });
const PAIRING = {
  state: 'pairing', code: 'pairing_required', requestId: 'req-1', command: 'openclaw devices approve req-1',
  lead: "Approve this office once on the OpenClaw computer (or in OpenClaw's Control UI):",
  detail: 'Waiting for approval: run `openclaw devices approve req-1` on the OpenClaw computer.', fix: 'It connects by itself.' };

async function env(data) {
  const { window, document } = linkedom.parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const requests = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method || 'GET', body });
    const json = url === '/api/agent-providers' ? JSON.parse(JSON.stringify(data())) : { ok: true };
    return { ok: true, status: 200, json: async () => json };
  };
  // (the page polls a pending connection every 2 s: unref'd timers let the test end)
  const later = (fn, ms, ...args) => { const t = nodeSetTimeout(fn, ms, ...args); if (t && t.unref) t.unref(); return t; };
  const ctx = { window, document, fetch, setTimeout: later, clearTimeout, URL, URLSearchParams, console, navigator: {} };
  window.fetch = fetch;
  vm.createContext(ctx);
  for (const code of CODE) vm.runInContext(code, ctx);
  const host = document.getElementById('host');
  await window.VOAgentProviders.mountPage(host, { kind: 'openclaw', select: 'openclaw' });
  await flush();
  return { window, document, host, requests };
}
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));
const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const byText = (root, sel, t) => $$(root, sel).find(el => text(el) === t);
const deviceRow = host => text($(host, '.ap-device .ap-kv span')) + ': ' + text($(host, '.ap-device .ap-kv b'));

test('waiting for approval: the command with a Copy button, the device row and its buttons', { skip: SKIP }, async () => {
  const e = await env(() => openclaw(PAIRING, { state: 'pending', deviceId: DEVICE_ID, requestId: 'req-1' }));
  const card = $(e.host, '.ap-card.wait');
  assert.equal(text($(card, 'h4')), 'Waiting for approval');
  assert.ok(text(card).includes("Approve this office once on the OpenClaw computer (or in OpenClaw's Control UI):"));
  assert.equal(text($(card, '.ap-cmd code')), 'openclaw devices approve req-1');
  assert.equal($(card, '[data-act="copy"]').getAttribute('data-copy'), 'openclaw devices approve req-1');
  assert.equal(text($(e.host, '.ap-pill')), 'Waiting for approval');
  assert.equal(deviceRow(e.host), 'Device: Waiting for approval (device abcdef123456)');
  assert.ok(byText(e.host, 'button', 'Pair again') && byText(e.host, 'button', 'Forget this device'));
  assert.ok(!e.document.documentElement.outerHTML.includes(DEVICE_ID.slice(12, 40)));
});

test('paired: Pair again and Forget this device post the device action', { skip: SKIP }, async () => {
  const e = await env(() => openclaw({ state: 'connected', version: '2026.9.6' }, { state: 'paired', deviceId: DEVICE_ID }));
  assert.equal(deviceRow(e.host), 'Device: Paired with OpenClaw (device abcdef123456)');
  assert.equal(text($(e.host, '.ap-pill')), 'Connected · OpenClaw 2026.9.6');
  byText(e.host, 'button', 'Pair again').click(); await flush();
  const posts = () => e.requests.filter(r => r.url === '/api/agent-providers/device').map(r => r.body);
  assert.deepEqual(posts(), [{ id: 'openclaw', action: 'repair' }]);
  byText(e.host, 'button', 'Forget this device').click(); await flush();
  byText($(e.document, '.ap-modal'), 'button', 'Forget').click(); await flush();
  assert.deepEqual(posts()[1], { id: 'openclaw', action: 'forget' });
});

test('loopback office: no device row at all', { skip: SKIP }, async () => {
  const e = await env(() => openclaw({ state: 'connected', version: '2026.9.6' }, { state: 'off' }));
  assert.equal($(e.host, '.ap-device'), null);
  assert.equal(byText(e.host, 'button', 'Pair again'), undefined);
});

test('scopes missing: Needs attention with the reason and the fix, never Connected', { skip: SKIP }, async () => {
  const e = await env(() => openclaw({ state: 'error', code: 'scope_missing', version: '2026.9.6',
    detail: 'Connected, but OpenClaw did not give this office permission (missing operator.read).', fix: 'Pair the office.' }, { state: 'off' }));
  assert.equal(text($(e.host, '.ap-pill')), 'Needs attention');
  const card = $(e.host, '.ap-card.bad');
  assert.ok(text(card).startsWith('Connected, but OpenClaw did not give this office permission'));
  assert.ok(text(card).includes('Pair the office.'));
});

test('only operator.admin missing: "limited access", with the reason and the fix', { skip: SKIP }, async () => {
  const e = await env(() => openclaw({ state: 'connected', code: 'scope_limited', version: '2026.9.6',
    detail: 'Connected, but OpenClaw did not give this office full access (missing operator.admin).', fix: 'Set this connection to Chat only.' }, { state: 'off' }));
  assert.equal(text($(e.host, '.ap-pill')), 'Connected · limited access');
  const card = $(e.host, '.ap-card.wait');
  assert.ok(text(card).includes('did not give this office full access'));
  assert.ok(text(card).includes('Chat only'));
});
