// v0.8 SMS and Browser panel regression tests: run the real app/sms-panel.js
// and app/browser-panel.js against the real index.html in a linkedom DOM.
// Covers: SMS media rows cannot inject attributes and only open web or
// /sms-media addresses (CH-06), the 5 s poll appends instead of rebuilding
// (CH-43), Escape closes both panels (CH-42), Browser panel polls nothing
// while the feature is off (CH-39) and frames only http(s) viewers (CH-07).
// Needs linkedom: NODE_PATH=<openclaw>/node_modules node tests/test_v08_chat_panels.cjs
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
setTimeout(() => { console.error('test_v08_chat_panels: global timeout'); process.exit(2); }, 60000).unref();
nodeTest.after(() => { setTimeout(() => process.exit(process.exitCode || 0), 300).unref(); });

const app = path.join(__dirname, '../app');
const read = name => fs.readFileSync(path.join(app, name), 'utf8');
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

function fixture(file, routes) {
  const { document, window: dom } = parseHTML(read('index.html'));
  const requests = [];
  const intervals = [];
  const respond = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const win = {
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'http://fixture.invalid/', origin: 'http://fixture.invalid' },
    innerWidth: 1600, innerHeight: 900, requestAnimationFrame: fn => setTimeout(fn, 0), setTimeout, clearTimeout
  };
  const context = vm.createContext({
    document, window: win, console, URL, URLSearchParams, Event: dom.Event, CustomEvent: dom.CustomEvent,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: id => clearTimeout(id),
    getComputedStyle: () => ({}), MutationObserver: class { observe() {} disconnect() {} },
    fetch: async url => {
      const u = String(url);
      requests.push(u);
      const handler = routes[u.split('?')[0]];
      return respond(handler ? handler(u) : { ok: true });
    }
  });
  vm.runInContext(read(file), context, { filename: file });
  const escape = el => { const evt = new dom.Event('keydown', { bubbles: true, cancelable: true }); evt.key = 'Escape'; el.dispatchEvent(evt); };
  return { document, requests, intervals, escape, tick: async () => { for (const fn of intervals) fn(); await settle(); } };
}

const EVIL = 'x" onerror="alert(1)';
function smsRoutes(state) {
  return {
    '/sms-status': () => ({ enabled: true, ownerAgent: { name: 'Owner' } }),
    '/sms-contacts': () => ({ ok: true, contacts: { '+15550001111': { name: 'Pat' } } }),
    '/sms-threads': () => ({ ok: true, threads: [{ phone: '+15550001111', name: 'Pat', lastMessage: 'hi', lastTimestamp: '2026-11-01T10:00:00Z' }] }),
    '/sms-thread': () => ({ ok: true, thread: { phone: '+15550001111', name: 'Pat' }, messages: state.messages })
  };
}

test('SMS media cannot inject attributes and only opens web or /sms-media links (CH-06)', async () => {
  const state = { messages: [{ id: 'm1', type: 'inbound', body: 'pic <b>bold</b>', timestamp: '2026-11-01T10:00:00Z', media: [
    { url: EVIL, contentType: 'image/png', filename: 'a"b.png' },
    { url: 'javascript:alert(1)', contentType: 'application/pdf', filename: 'doc' },
    { url: '/sms-media?sid=1', contentType: 'image/jpeg', filename: 'ok.jpg' },
    { url: 'https://media.example/x.mp3', contentType: 'audio/mpeg', filename: 'voice' }
  ] }] };
  const f = fixture('sms-panel.js', smsRoutes(state));
  await settle();
  f.document.getElementById('sms-toggle').click();
  await settle(60);
  const thread = f.document.querySelector('.sms-thread-item, [data-phone]');
  if (thread) thread.click();
  await settle(60);
  const messages = f.document.getElementById('sms-messages') || f.document.querySelector('.sms-messages');
  assert.ok(messages.querySelector('.sms-msg'), 'message rendered');
  assert.equal(messages.querySelector('[onerror]'), null, 'no injected handler');
  assert.equal(messages.querySelector('b'), null, 'body text is not HTML');
  const srcs = [...messages.querySelectorAll('img, audio, video')].map(el => el.getAttribute('src'));
  assert.deepEqual(srcs, ['/sms-media?sid=1', 'https://media.example/x.mp3'], JSON.stringify(srcs));
  const hrefs = [...messages.querySelectorAll('a')].map(a => a.getAttribute('href'));
  assert.ok(hrefs.every(h => h === '/sms-media?sid=1' || h === 'https://media.example/x.mp3'), hrefs.join(','));
  assert.ok([...messages.querySelectorAll('a')].every(a => a.getAttribute('rel') === 'noopener noreferrer'));
  assert.match(messages.textContent, /not a web address/);
});

test('SMS poll appends new messages instead of rebuilding the thread (CH-43) and Escape closes (CH-42)', async () => {
  const state = { messages: [{ id: 'm1', type: 'inbound', body: 'one', timestamp: '2026-11-01T10:00:00Z' }] };
  const f = fixture('sms-panel.js', smsRoutes(state));
  await settle();
  f.document.getElementById('sms-toggle').click();
  await settle(60);
  const thread = f.document.querySelector('.sms-thread-item, [data-phone]');
  if (thread) thread.click();
  await settle(60);
  const messages = f.document.getElementById('sms-messages') || f.document.querySelector('.sms-messages');
  const first = messages.querySelector('.sms-msg');
  assert.ok(first);
  const select = f.document.getElementById('sms-recipient') || f.document.querySelector('.sms-panel select');
  const firstOption = select?.querySelector('option[value="+15550001111"]');
  state.messages = [...state.messages, { id: 'm2', type: 'outbound', body: 'two', timestamp: '2026-11-01T10:01:00Z' }];
  await f.tick();
  await settle(60);
  const rows = messages.querySelectorAll('.sms-msg');
  assert.equal(rows.length, 2);
  assert.equal(rows[0], first, 'the first row was kept, not rebuilt');
  if (firstOption) assert.equal(select.querySelector('option[value="+15550001111"]'), firstOption, 'contacts not rebuilt');
  const panel = f.document.getElementById('sms-panel');
  assert.ok(panel.classList.contains('open'));
  f.escape(panel);
  assert.equal(panel.classList.contains('open'), false, 'Escape closed the SMS panel');
});

test('Browser panel polls nothing while the feature is off and frames only http(s) (CH-39, CH-07)', async () => {
  const off = fixture('browser-panel.js', { '/browser-status': () => ({ enabled: false }) });
  await settle();
  const before = off.requests.length;
  await off.tick();
  await off.tick();
  assert.equal(off.requests.length, before, 'no /browser-controller or /browser-tabs polls: ' + off.requests.slice(before).join(','));

  const bad = fixture('browser-panel.js', { '/browser-status': () => ({ enabled: true, viewerUrl: 'javascript:alert(1)' }), '/browser-tabs': () => [], '/browser-controller': () => ({}) });
  await settle();
  bad.document.getElementById('browser-toggle').click();
  await settle();
  const frame = bad.document.getElementById('browser-neko-frame');
  assert.ok(!String(frame.getAttribute('src') || '').startsWith('javascript:'));
  assert.match(String(frame.getAttribute('srcdoc') || frame.srcdoc || ''), /Browser Not Configured[\s\S]*in Settings\./);
  const panel = bad.document.getElementById('browser-panel');
  assert.ok(panel.classList.contains('open'));
  bad.escape(panel);
  assert.equal(panel.classList.contains('open'), false, 'Escape closed the Browser panel');
});

test('closed SMS and Browser panels are inert (no Tab stops), open ones are not (P3-10)', async () => {
  const sms = fixture('sms-panel.js', { '/sms-status': () => ({ enabled: false }) });
  await settle();
  const smsPanel = sms.document.getElementById('sms-panel');
  assert.ok(smsPanel.hasAttribute('inert'), 'SMS panel inert at load, even when SMS is off (demo)');
  const on = fixture('sms-panel.js', smsRoutes({ messages: [] }));
  await settle();
  const panel = on.document.getElementById('sms-panel');
  assert.ok(panel.hasAttribute('inert'));
  on.document.getElementById('sms-toggle').click();
  assert.ok(!panel.hasAttribute('inert'), 'open SMS panel is reachable');
  on.escape(panel);
  assert.ok(panel.hasAttribute('inert'), 'closed again by Escape');

  const br = fixture('browser-panel.js', { '/browser-status': () => ({ enabled: true, viewerUrl: 'https://viewer.invalid/' }), '/browser-tabs': () => [], '/browser-controller': () => ({}) });
  await settle();
  const browser = br.document.getElementById('browser-panel');
  assert.ok(browser.hasAttribute('inert'), 'Browser panel inert at load');
  br.document.getElementById('browser-toggle').click();
  await settle();
  assert.ok(!browser.hasAttribute('inert'));
  br.document.getElementById('browser-close').click();
  assert.ok(browser.hasAttribute('inert'));
});
