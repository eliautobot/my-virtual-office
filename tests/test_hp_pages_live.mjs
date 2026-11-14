// Agent Providers page catches up by itself (QA D2: "still Connecting... 20 s after Connect; correct after a reload").
//   NODE_PATH=<dir with linkedom> node tests/test_hp_pages_live.mjs
// After Connect/Save/Reconnect, and while a row is connecting, the page reads GET /api/agent-providers again every
// 2 s (backing off to 10 s), stops once nothing is pending or after 2 minutes, pauses while the tab is hidden, and
// draws each answer in place: an open form, menu tab or select stays. Fake clock, every request mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = ['agent-providers.js', 'provider-menu-hermes.js'].map(f => fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'));

function loadLinkedom() {
  for (const dir of (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
    try { return require(path.join(dir, 'linkedom')); } catch (e) { /* next */ }
  }
  try { return require('linkedom'); } catch (e) { return null; }
}
const linkedom = loadLinkedom();
const SKIP = linkedom ? false : 'linkedom not found (set NODE_PATH)';

const AGENTS = [{ id: 'hermes-lab-default', name: 'Nova', nativeId: 'default' }, { id: 'hermes-lab-quill', name: 'Quill', nativeId: 'quill' }];
const row = (id, state, agents = [], extra = {}) => Object.assign({ id, kind: 'hermes', transport: 'serve', name: 'Hermes ' + id, enabled: true, access: 'full',
  status: state === 'connected' ? { state, version: '0.22.2' } : { state, code: 'checking', detail: 'Checking the server...' },
  fields: { url: 'http://127.0.0.1:9119', auth: 'token', access: 'full' }, secrets: { token: true }, agents }, extra);

async function env(providers) {
  const { window, document } = linkedom.parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const srv = { providers, gets: [], writes: [], calls: 0 };
  let T = 1_000_000, nextId = 1;
  const timers = [];
  const setTimeout_ = (fn, ms = 0) => { const id = nextId++; timers.push({ at: T + (ms || 0), fn, id }); return id; };
  const clearTimeout_ = id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    let json = { ok: true };
    if (url === '/api/agent-providers' && !body) { srv.gets.push(T); json = { manifests: {}, providers: JSON.parse(JSON.stringify(srv.providers)) }; }
    else if (url === '/api/agent-providers/call') { srv.calls++; json = { ok: true, result: {} }; }
    else { srv.writes.push({ url, body }); if (url.endsWith('/save')) json = { ok: true, id: body.id || 'hermes-new' }; }
    return { ok: true, status: 200, json: async () => json };
  };
  const ctx = { window, document, fetch, setTimeout: setTimeout_, clearTimeout: clearTimeout_, URL, URLSearchParams, console, navigator: {},
    Date: class extends Date { static now() { return T; } } };
  window.fetch = fetch;
  vm.createContext(ctx);
  for (const code of CODE) vm.runInContext(code, ctx);
  const host = document.getElementById('host');
  const advance = async ms => {
    const end = T + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift(); T = t.at; t.fn(); await flush();
    }
    T = end; await flush();
  };
  const AP = window.VOAgentProviders;
  return { window, document, host, AP, P: AP._test.P, srv, advance, now: () => T };
}
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));
const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const byText = (root, sel, t) => $$(root, sel).find(el => text(el) === t);
const side = (host, id) => text($(host, `.ap-conn[data-id="${id}"] .ap-conn-meta`));

test('1. a row going connecting -> connected updates in place without a reload, then the polling stops', { skip: SKIP }, async () => {
  const e = await env([row('lab', 'connecting')]);
  await e.AP.mountPage(e.host, { kind: 'hermes' });
  const page = $(e.host, '.ap-page');
  assert.equal(side(e.host, 'lab'), 'Connecting... · 0 agents');
  assert.equal(text($(e.host, '.ap-card.wait h4')), 'Connecting...');
  assert.equal(e.srv.gets.length, 1);
  await e.advance(2000);
  assert.equal(e.srv.gets.length, 2, 'read again after 2 s');
  e.srv.providers = [row('lab', 'connected', AGENTS)];
  await e.advance(2999);
  assert.equal(e.srv.gets.length, 2, 'backs off: the next read is 3 s later');
  await e.advance(1);
  assert.equal(e.srv.gets.length, 3);
  assert.equal($(e.host, '.ap-page'), page, 'drawn in place, not a new page');
  assert.equal(side(e.host, 'lab'), 'Connected · 2 agents');
  assert.match(text($(e.host, '.ap-pill')), /^Connected/);
  assert.equal($(e.host, '.ap-card.wait'), null, 'no Connecting card');
  assert.deepEqual($$(e.host, 'a.ap-chat').map(text), ['Chat', 'Chat'], 'Chat buttons usable');
  assert.equal(e.P.timer, 0, 'nothing pending: polling stopped');
  await e.advance(60000);
  assert.equal(e.srv.gets.length, 3, 'no more reads');
});

test('2. Connect: the new connection catches up by itself (QA D2 FAIL), agents listed once they come', { skip: SKIP }, async () => {
  const e = await env([]);
  await e.AP.mountPage(e.host, { kind: 'hermes' });
  const form = $(e.host, '.ap-form');
  assert.ok(form, 'no connection yet: the Add form');
  $(form, '.apf[data-key="url"]').value = 'http://127.0.0.1:9119';
  $(form, '.apf[data-key="token"]').value = 'tok-1';
  e.srv.providers = [row('hermes-new', 'connecting')];
  byText(form, 'button', 'Connect Hermes').click(); await flush(30);
  assert.deepEqual(e.srv.writes.map(w => w.url), ['/api/agent-providers/save']);
  assert.equal(text($(e.host, '.ap-card.wait h4')), 'Connecting...');
  e.srv.providers = [row('hermes-new', 'connected', [])];
  await e.advance(2000);
  assert.match(text($(e.host, '.ap-pill')), /^Connected/);
  assert.equal(text($(e.host, '.ap-connection .ap-hint')), 'Its agents are being listed...');
  assert.ok(e.P.timer, 'connected with no agents yet: still watching');
  e.srv.providers = [row('hermes-new', 'connected', AGENTS)];
  await e.advance(3000);
  assert.deepEqual($$(e.host, '.ap-agent b').map(text), ['Nova', 'Quill']);
  const reads = e.srv.gets.length;
  await e.advance(60000); // one last check inside the 6 s a just-saved row is watched, then it stops
  assert.equal(e.P.timer, 0, 'agents listed: polling stopped');
  assert.ok(e.srv.gets.length <= reads + 1, `${e.srv.gets.length - reads} reads after the agents came`);
  assert.equal(e.srv.writes.length, 1, 'polling never writes');
});

test('3. an open form, menu tab and the phone select are kept while the rows update', { skip: SKIP }, async () => {
  const e = await env([row('lab', 'connected', AGENTS), row('b', 'connecting')]);
  await e.AP.mountPage(e.host, { kind: 'hermes', select: 'lab' });
  byText(e.host, '.ap-acts button', 'Edit').click(); await flush();
  const form = $(e.host, '.ap-form'), name = $(form, '.apf[data-key="name"]');
  name.value = 'Typed, not saved';
  e.srv.providers = [row('lab', 'connected', AGENTS), row('b', 'connected', AGENTS)];
  await e.advance(2000);
  assert.equal(side(e.host, 'b'), 'Connected · 2 agents', 'the row updates');
  assert.equal($(e.host, '.ap-form'), form, 'the same form element');
  assert.equal(name.value, 'Typed, not saved');
  assert.equal(e.P.timer, 0);

  byText(form, 'button', 'Cancel').click(); await flush();
  e.srv.providers = [row('lab', 'connected', AGENTS), row('b', 'connecting')];
  byText(e.host, '.ap-acts button', 'Reconnect').click(); await flush(20);
  $(e.host, '.ap-tab[data-tab="settings"]').click(); await flush(20);
  const body = $(e.host, '.ap-menu-body'), calls = e.srv.calls;
  assert.ok(body, 'Settings tab open');
  const pick = $(e.host, '.ap-pick');
  Object.defineProperty(e.document, 'activeElement', { configurable: true, get: () => pick });
  e.srv.providers = [row('lab', 'connected', AGENTS), row('b', 'connected', AGENTS)];
  await e.advance(2000);
  assert.equal($(e.host, '.ap-menu-body'), body, 'the menu tab is not drawn again');
  assert.equal(e.srv.calls, calls, 'the menu read nothing again');
  assert.equal($(e.host, '.ap-pick'), pick, 'the focused (open) select stays');
  assert.deepEqual($$(pick, 'option').map(text), ['Hermes lab (Connected)', 'Hermes b (Connected)']);
  assert.equal(side(e.host, 'b'), 'Connected · 2 agents');
});

test('4. a row that stays connecting: 2 s backing off to 10 s, stops after 2 minutes', { skip: SKIP }, async () => {
  const e = await env([row('lab', 'connecting')]);
  await e.AP.mountPage(e.host, { kind: 'hermes' });
  const t0 = e.now();
  await e.advance(200000);
  const gaps = e.srv.gets.slice(1).map((t, i) => t - (i ? e.srv.gets[i] : t0));
  assert.deepEqual(gaps.slice(0, 6), [2000, 3000, 4500, 6750, 10000, 10000]);
  assert.ok(e.srv.gets[e.srv.gets.length - 1] - t0 <= 120000 + 10000, 'last read within the 2 minutes (+ one step)');
  assert.ok(e.srv.gets.length < 20, `${e.srv.gets.length} reads`);
  assert.equal(e.P.timer, 0, 'stopped');
});

test('5. paused while the tab is hidden, reads at once when it is shown again', { skip: SKIP }, async () => {
  const e = await env([row('lab', 'connecting')]);
  let hidden = false;
  Object.defineProperty(e.document, 'hidden', { configurable: true, get: () => hidden });
  await e.AP.mountPage(e.host, { kind: 'hermes' });
  const Ev = e.window.Event || linkedom.Event;
  hidden = true; e.document.dispatchEvent(new Ev('visibilitychange'));
  await e.advance(30000);
  assert.equal(e.srv.gets.length, 1, 'no reads while hidden');
  e.srv.providers = [row('lab', 'connected', AGENTS)];
  hidden = false; e.document.dispatchEvent(new Ev('visibilitychange'));
  await e.advance(0);
  assert.equal(e.srv.gets.length, 2, 'read at once when shown');
  assert.equal(side(e.host, 'lab'), 'Connected · 2 agents');
  assert.equal(e.P.timer, 0);
});

test('6. Reconnect: watched even when the first answer still shows the old state; then stops', { skip: SKIP }, async () => {
  const e = await env([row('lab', 'connected', AGENTS)]);
  await e.AP.mountPage(e.host, { kind: 'hermes' });
  assert.equal(e.P.timer, 0, 'nothing pending on open: no polling');
  byText(e.host, '.ap-acts button', 'Reconnect').click(); await flush(20);
  assert.deepEqual(e.srv.writes.map(w => w.url), ['/api/agent-providers/reconnect']);
  assert.ok(e.P.timer, 'watching after Reconnect');
  e.srv.providers = [row('lab', 'connecting')];
  await e.advance(2000);
  assert.equal(text($(e.host, '.ap-card.wait h4')), 'Connecting...');
  e.srv.providers = [row('lab', 'connected', AGENTS)];
  await e.advance(30000);
  assert.match(text($(e.host, '.ap-pill')), /^Connected/);
  assert.equal(e.P.timer, 0);
  assert.ok(e.srv.gets.length <= 6, `${e.srv.gets.length} reads`);
});
