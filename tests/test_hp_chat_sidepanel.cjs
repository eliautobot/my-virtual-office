// Hermes/OpenClaw port (D1): side panel, running-tasks chip and media (app/chat-sidepanel.js, app/chat-media.js;
// design 4.2, 4.5). NODE_PATH must reach linkedom: node --test tests/test_hp_chat_sidepanel.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const Caps = require('../app/chat-caps.js');
const Side = require('../app/chat-sidepanel.js');
const Media = require('../app/chat-media.js');

// What GET /api/agent-chat/can answers (OpenClaw as read live on 8095; Hermes serve per design 4.1).
const OPENCLAW = {
  ok: true, agent: 'main', kind: 'openclaw', transport: 'openclaw', view: 'default', manage: true, access: 'full',
  connection: { id: 'openclaw', name: 'OpenClaw', state: 'connected', detail: 'Connected' },
  caps: { stream: true, sessions: true, history: true, stop: true, models: true, effort: true, attachments: true, files: true,
    approvals: true, approvalOptions: ['allow-once', 'allow-always', 'deny'], questions: true, plan: true, progressCard: true,
    tasks: true, taskSteer: false, queue: 'steer', presence: true, media: true, browser: true, screen: false, computer: true, computerWrite: true },
  locked: {}, limits: { attachmentBytes: 19464192 }, prefs: {}
};
const HERMES_FULL = {
  ok: true, agent: 'hermes-astra', kind: 'hermes', transport: 'hermes-serve', view: 'hermes', manage: true, access: 'full',
  connection: { id: 'hc1', name: 'Hermes', state: 'connected' },
  caps: { stream: true, sessions: true, tasks: true, taskSteer: true, media: true, screen: true, computer: true, computerWrite: true, queue: 'redirect' },
  locked: {}
};
const SCREEN_TEXT = "This connection is set up for chat only: the agent's screen needs Full access (Agent Providers, then its connection).";
const FILES_TEXT = "This connection has Chat only access: files on Hermes' computer are not changed from here.";
const HERMES_CHAT = {
  ...HERMES_FULL, access: 'chat',
  caps: { ...HERMES_FULL.caps, screen: false, computerWrite: false },
  locked: { screen: SCREEN_TEXT, computerWrite: FILES_TEXT }
};

function dom() {
  const { document, window } = parseHTML(`<!doctype html><html><body><div class="chat-panel">
    <div class="chat-header"><div class="chat-header-btns"><button class="chat-new-session">n</button><button class="chat-close">x</button></div></div>
    <div class="chat-body"><div class="chat-sessions-panel"></div><div class="chat-messages"></div></div>
    <div class="chat-attachments-preview"></div><div class="chat-input-row"></div></div></body></html>`);
  return { document, window, root: document.querySelector('.chat-panel') };
}

function fakeTimers() {
  const due = new Map();
  let n = 0;
  return {
    set: (fn, ms) => { n += 1; due.set(n, { fn, ms }); return n; },
    clear: (id) => { due.delete(id); },
    run: async (filter = () => true) => {
      for (const [id, t] of [...due]) if (filter(t)) { due.delete(id); await t.fn(); }
    },
    size: () => due.size
  };
}

function fakeApi(routes) {
  const calls = [];
  const answer = (method, path, args) => {
    calls.push({ method, path, args });
    const r = routes[`${method} ${path}`];
    const out = typeof r === 'function' ? r(args) : r;
    return Promise.resolve(out || { ok: false, status: 404, data: { error: 'not_found' } });
  };
  return {
    calls,
    get: (path, params) => answer('GET', path, params),
    post: (path, body) => answer('POST', path, body),
    image: (path, params) => answer('IMG', path, params),
    release: () => {}
  };
}

const ok = (data) => ({ ok: true, status: 200, data });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const texts = (nodes) => [...nodes].map(n => n.textContent.trim());

function storage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

function panelFor(manifest, routes = {}, extra = {}) {
  const d = dom();
  const timers = fakeTimers();
  const api = fakeApi(routes);
  const st = extra.storage || storage();
  const side = Side.create({ doc: d.document, root: d.root, api, timers, storage: st, isPhone: () => !!extra.phone,
    isVisible: () => true, confirm: () => true, prompt: () => 'notes', toast: () => {}, now: () => 1793549500000 });
  const view = Caps.derive(manifest);
  side.setContext({ view, agent: manifest.agent, session: extra.session === undefined ? 'agent:main:main' : extra.session,
    agentName: extra.name || 'Main', transport: manifest.transport, taskSteer: !!manifest.caps.taskSteer });
  return { ...d, side, api, timers, storage: st, view };
}

test('tabs follow the manifest: OpenClaw Tasks/Browser/Files, Hermes Tasks/Screen/Files, others none', () => {
  assert.deepEqual(Side.tabsFor(Caps.derive(OPENCLAW)).map(t => t.label), ['Tasks', 'Browser', 'Files']);
  assert.deepEqual(Side.tabsFor(Caps.derive(HERMES_FULL)).map(t => t.label), ['Tasks', 'Screen', 'Files']);
  const chat = Side.tabsFor(Caps.derive(HERMES_CHAT));
  assert.deepEqual(chat.map(t => [t.id, !!t.locked]), [['tasks', false], ['screen', true], ['files', false]]);
  assert.equal(chat[1].locked, SCREEN_TEXT);
  assert.equal(chat[2].write, false);
  assert.equal(chat[2].writeLocked, FILES_TEXT);
  const codex = Caps.fromRegistry({ sessions: true, attachments: true }, { kind: 'codex', agent: 'cx' });
  assert.deepEqual(Side.tabsFor(Caps.derive(codex)), []);
  assert.deepEqual(Side.tabsFor(Caps.derive({ ok: false, reason: 'offline' })), [], 'a failed manifest shows no tabs');
});

test('header button + panel: hidden without tabs; OpenClaw shows its three tabs; phone opens a full-screen sheet', async () => {
  const codex = panelFor(Caps.fromRegistry({ sessions: true }, { kind: 'codex', agent: 'cx' }) && { ...OPENCLAW, ok: false, reason: 'offline', caps: {} });
  assert.equal(codex.side.elements.button.hidden, true);
  codex.side.open('tasks');
  assert.equal(codex.side.isOpen(), false, 'no tabs: the panel does not open');
  codex.side.destroy();

  const p = panelFor(OPENCLAW, { 'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }) });
  const btn = p.root.querySelector('.chat-header-btns .hp-side-btn');
  assert.ok(btn && !btn.hidden, 'button in the header');
  assert.equal(btn.title, 'Side panel: Tasks, Browser, Files');
  btn.click();
  await tick();
  assert.equal(p.side.isOpen(), true);
  const panel = p.root.querySelector('.chat-body .hp-side');
  assert.equal(panel.hidden, false);
  assert.deepEqual(texts(panel.querySelectorAll('.hp-side-tab')), ['Tasks', 'Browser', 'Files']);
  assert.equal(panel.querySelector('.hp-side-tab.on').dataset.tab, 'tasks');
  assert.ok(panel.querySelector('.hp-side-back'), 'Back button (shown on phones)');
  p.side.destroy();

  const phone = panelFor(OPENCLAW, { 'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }) }, { phone: true });
  phone.side.open('tasks');
  const sheet = phone.root.querySelector('.hp-side');
  assert.ok(sheet.classList.contains('hp-side-sheet'), 'phone: full-screen sheet');
  assert.ok(!sheet.classList.contains('hp-side-beside'));
  sheet.querySelector('.hp-side-back').click();
  assert.equal(phone.side.isOpen(), false, 'Back closes the sheet');
  phone.side.destroy();
});

test('locked tabs show the plain Chat only text, the fix, and Open Agent Providers only for managers', async () => {
  const p = panelFor(HERMES_CHAT, { 'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }) }, { session: 'sess-1' });
  p.side.open('screen');
  await tick();
  const body = p.root.querySelector('.hp-side-body');
  assert.equal(body.querySelector('.hp-side-locked-text').textContent, SCREEN_TEXT);
  assert.equal(body.querySelector('.hp-side-fix').textContent, 'Open Agent Providers, Edit the connection and choose Full access.');
  const link = body.querySelector('.hp-side-open-providers');
  assert.equal(link.textContent, 'Open Agent Providers');
  assert.equal(link.getAttribute('href'), 'providers.html');
  assert.equal(p.api.calls.filter(c => c.path.includes('/screen')).length, 0, 'a locked screen is never asked for');
  p.side.destroy();

  const viewer = panelFor({ ...HERMES_CHAT, manage: false }, { 'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }) }, { session: 's' });
  viewer.side.open('screen');
  assert.equal(viewer.root.querySelector('.hp-side-open-providers'), null, 'no link for people who do not manage');
  viewer.side.destroy();

  const files = panelFor(HERMES_CHAT, {
    'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }),
    'GET /api/agent-chat/files': ok({ path: '', parent: null, entries: [{ name: 'notes.md', path: 'notes.md', dir: false, size: 2048 }] })
  }, { session: 's' });
  files.side.open('files');
  await tick();
  const fb = files.root.querySelector('.hp-side-body');
  assert.equal(fb.querySelector('.hp-side-note').textContent, FILES_TEXT, 'Chat only: the write text above the list');
  assert.equal(fb.querySelector('.hp-fl-upload'), null, 'no Upload under Chat only');
  assert.deepEqual(texts(fb.querySelectorAll('.hp-fl-open')), ['notes.md']);
  assert.equal(fb.querySelector('.hp-fl-open use').getAttribute('href'), '#i-file');
  assert.equal(fb.querySelector('.hp-fl-size').textContent, '2 KB');
  files.side.destroy();
});

const RUNNING = { id: 't1', status: 'running', title: 'Research the venues', runtime: 'subagent', startedAt: 1793549452000,
  sessionKey: 'agent:main:main', execution: { state: 'running', currentTool: { name: 'Bash' } }, toolUseCount: 3, progressSummary: 'Reading pages' };
const DONE = { id: 't0', status: 'completed', title: 'Draft the email', runtime: 'cron', endedAt: 1793549000000, terminalSummary: 'Sent the draft.' };

test('task rows, chip and count; frames add, end and delete tasks; detail, Stop, Steer', async () => {
  let stopped = false;
  const p = panelFor(HERMES_FULL, {
    'GET /api/agent-chat/tasks': ok({ active: [RUNNING], recent: [DONE] }),
    'GET /api/agent-chat/tasks/one': () => ok({ task: { ...RUNNING, prompt: 'Find three venues', result: '', ...(stopped ? { status: 'cancelled' } : {}) } }),
    'GET /api/agent-chat/tasks/history': ok({ messages: [{ role: 'user', text: 'Find three venues', ts: 1793549452000 }, { role: 'assistant', text: 'Looking now' }] }),
    'POST /api/agent-chat/tasks/cancel': () => { stopped = true; return ok({ cancelled: true, task: { ...RUNNING, status: 'cancelled', endedAt: 1793549499000 } }); },
    'POST /api/agent-chat/tasks/steer': ok({ ok: true })
  }, { session: 'agent:main:main' });
  await tick();
  const get = p.api.calls.find(c => c.path === '/api/agent-chat/tasks');
  assert.deepEqual(get.args, { agent: 'hermes-astra', session: 'agent:main:main', scope: 'chat' });
  const chip = p.root.querySelector('.hp-task-chip');
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, '1 running task · Research the venues');
  assert.equal(p.root.querySelector('.hp-side-count').textContent, '1');
  assert.ok(p.root.querySelector('.chat-attachments-preview').previousElementSibling === chip, 'chip sits above the composer');

  chip.click();
  await tick();
  assert.equal(p.side.isOpen(), true);
  assert.equal(chip.hidden, true, 'chip hidden while Tasks shows');
  const body = p.root.querySelector('.hp-side-body');
  assert.deepEqual(texts(body.querySelectorAll('.hp-task-head')), ['Running (1)', 'Finished (1)']);
  const row = body.querySelector('.hp-task-running .hp-task-row');
  assert.equal(row.querySelector('.hp-task-title').textContent, 'Research the venues');
  assert.equal(row.querySelector('.hp-task-kind').textContent, 'Subagent');
  assert.equal(row.querySelector('.hp-task-l2').textContent, 'Running · 48s · Current tool: Bash · 3 tool uses');
  assert.equal(row.querySelector('.hp-task-l3').textContent, 'Reading pages');
  assert.ok(row.querySelector('.hp-task-stop'), 'running task: Stop');
  const fin = body.querySelector('.hp-task-finished .hp-task-row');
  assert.equal(fin.querySelector('.hp-task-kind').textContent, 'Scheduled job');
  assert.equal(fin.querySelector('.hp-task-stop'), null);
  assert.deepEqual(texts(body.querySelectorAll('.hp-task-scope-btn')), ['This chat', 'All of Main']);

  p.side.onTask({ type: 'session.task', change: 'upserted', sessionKey: 'agent:main:main', task: { id: 't2', status: 'queued', title: 'Book the room' } });
  p.side.close();
  assert.equal(chip.textContent, '2 running tasks · Book the room +1 more');
  p.side.onTask({ type: 'session.task', change: 'upserted', sessionKey: 'agent:main:other', task: { id: 't9', status: 'running', title: 'Elsewhere' } });
  assert.equal(p.side.runningCount(), 2, "another chat's task stays out of This chat");
  p.side.onTask({ type: 'session.task', change: 'deleted', taskId: 't2' });
  assert.equal(p.side.runningCount(), 1);

  p.side.open('tasks');
  p.root.querySelector('.hp-task-running .hp-task-row .hp-task-main').click();
  await tick(); await tick();
  const detail = p.root.querySelector('.hp-side-body');
  const heads = texts(detail.querySelectorAll('.hp-task-h'));
  assert.deepEqual(heads, ['Latest update', 'Prompt', 'Output', 'Transcript']);
  assert.ok(detail.textContent.includes('Find three venues'));
  assert.ok(detail.querySelector('.hp-task-steer-input'), 'Hermes: Steer box on a running task');
  assert.deepEqual(texts(detail.querySelectorAll('.hp-task-who')).map(t => t.replace(/\d.*$/, '').trim()), ['Prompt', 'Agent']);

  detail.querySelector('.hp-task-steer-input').value = 'only Brooklyn';
  detail.querySelector('.hp-task-steer').dispatchEvent(new p.window.Event('submit', { cancelable: true }));
  await tick();
  const steer = p.api.calls.find(c => c.path === '/api/agent-chat/tasks/steer');
  assert.deepEqual(steer.args, { agent: 'hermes-astra', session: 'agent:main:main', task: 't1', text: 'only Brooklyn' });

  detail.querySelector('.hp-task-dstop').click();
  await tick(); await tick();
  const cancel = p.api.calls.find(c => c.path === '/api/agent-chat/tasks/cancel');
  assert.deepEqual(cancel.args, { agent: 'hermes-astra', session: 'agent:main:main', task: 't1', scope: 'chat' });
  assert.equal(p.side.runningCount(), 0, 'the cancelled task moved to Finished');
  assert.equal(chip.hidden, true);
  p.side.destroy();
});

test('scope switch is kept in localStorage and reads all of the agent; OpenClaw has no Steer box', async () => {
  const st = storage();
  const p = panelFor(OPENCLAW, { 'GET /api/agent-chat/tasks': (q) => ok({ active: q.scope === 'agent' ? [{ ...RUNNING, sessionKey: 'agent:main:dash' }] : [], recent: [] }) }, { storage: st });
  await tick();
  p.side.open('tasks');
  p.root.querySelector('[data-scope="agent"]').click();
  await tick();
  assert.equal(st.map.get('vo.chat.taskScope'), 'agent');
  assert.equal(p.api.calls.filter(c => c.path === '/api/agent-chat/tasks').pop().args.scope, 'agent');
  const line = p.root.querySelector('.hp-task-row .hp-task-l2').textContent;
  assert.ok(line.endsWith('from another chat'), line);
  p.root.querySelector('.hp-task-row .hp-task-main').click();
  await tick();
  assert.equal(p.root.querySelector('.hp-task-steer-input'), null, 'OpenClaw tasks are not steered');
  p.side.destroy();
  const again = panelFor(OPENCLAW, { 'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }) }, { storage: st });
  assert.equal(again.side._state.T.scope, 'agent', 'the choice comes back');
  again.side.destroy();
});

test('Browser: tabs, frame polling while shown, local addresses refused before anything is sent', async () => {
  const p = panelFor(OPENCLAW, {
    'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }),
    'GET /api/agent-chat/browser': ok({ available: true, running: true, tabs: [{ id: 'A', title: 'Docs', url: 'https://example.com/' }, { id: 'B', title: 'News', url: 'https://news.example/' }] }),
    'IMG /api/agent-chat/browser/frame': { status: 200, url: 'blob:frame-1' },
    'POST /api/agent-chat/browser': ok({ ok: true })
  });
  p.side.open('browser');
  await tick();
  const body = p.root.querySelector('.hp-side-body');
  assert.ok(p.root.querySelector('.hp-side').classList.contains('hp-side-wide'), 'Browser is the wide panel (560)');
  assert.deepEqual(texts(body.querySelectorAll('.hp-bw-tab')), ['Docs', 'News']);
  assert.equal(body.querySelector('.hp-bw-url').value, 'https://example.com/');
  await p.timers.run(t => t.ms === 0);
  const frame = p.api.calls.find(c => c.path === '/api/agent-chat/browser/frame');
  assert.deepEqual(frame.args, { agent: 'main', session: 'agent:main:main', tab: 'A' });
  assert.equal(body.querySelector('.hp-bw-img').getAttribute('src'), 'blob:frame-1');
  assert.ok(p.timers.size() > 0, 'next frame scheduled');
  body.querySelector('.hp-bw-url').value = 'http://192.168.1.20:8080';
  body.querySelector('.hp-bw-bar').dispatchEvent(new p.window.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(p.root.querySelector('.hp-bw-notice').textContent, "OpenClaw's gateway does not open local addresses.");
  assert.equal(p.api.calls.filter(c => c.method === 'POST').length, 0, 'nothing sent for a local address');
  p.side.close();
  await p.timers.run();
  const frames = p.api.calls.filter(c => c.path.endsWith('/frame')).length;
  await p.timers.run();
  assert.equal(p.api.calls.filter(c => c.path.endsWith('/frame')).length, frames, 'no frames once the panel closed');
  p.side.destroy();
  for (const [url, local] of [['localhost:3000', true], ['http://127.0.0.1/', true], ['10.0.0.5', true], ['https://[::1]/', true],
    ['http://100.64.1.2:8095', true], ['example.com', false], ['https://8.8.8.8/', false], ['http://172.32.0.1', false]]) {
    assert.equal(Side.isLocalAddress(url), local, url);
  }
});

test('Screen (Hermes Full): Start when off; thumbnails every 1.5 s while running; Take over; install hint', async () => {
  const p = panelFor(HERMES_FULL, {
    'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }),
    'GET /api/agent-chat/screen': ok({ available: true, supported: true, installed: true, running: true, holder: 'agent', mine: false, browserOnScreen: false }),
    'IMG /api/agent-chat/screen/thumb': { status: 200, url: 'blob:screen-1' },
    'POST /api/agent-chat/screen': (b) => ok({ available: true, installed: true, running: true, holder: 'human', mine: true, browserOnScreen: false, op: b.op })
  }, { session: 's' });
  p.side.open('screen');
  await tick();
  const body = () => p.root.querySelector('.hp-side-body');
  assert.deepEqual(texts(body().querySelectorAll('.hp-sc-bar button')), ['Stop', 'Take over']);
  assert.ok(body().querySelector('.hp-sc-toggle').textContent.includes('Show the browser on this screen'));
  await p.timers.run(t => t.ms === 0);
  assert.equal(body().querySelector('.hp-sc-img').getAttribute('src'), 'blob:screen-1');
  let pending = [];
  p.timers.run(t => { if (t.ms === 1500) pending.push(t); return false; });
  assert.ok(pending.length === 1, 'next thumbnail in 1.5 s');
  body().querySelector('.hp-sc-take').click();
  await tick(); await tick();
  const take = p.api.calls.find(c => c.method === 'POST' && c.path === '/api/agent-chat/screen');
  assert.equal(take.args.op, 'take');
  assert.ok(take.args.viewer, 'a viewer id goes with Take over');
  assert.deepEqual(texts(body().querySelectorAll('.hp-sc-bar button')), ['Stop', 'Hand back']);
  p.side.destroy();

  const old = panelFor(HERMES_FULL, {
    'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }),
    'GET /api/agent-chat/screen': { ok: false, status: 400, data: { ok: false, error: 'unsupported', message: 'This Hermes has no Bot Desktop yet (update Hermes).' } }
  }, { session: 's' });
  old.side.open('screen');
  await tick();
  assert.equal(old.root.querySelector('.hp-side-body').textContent, 'This Hermes has no Bot Desktop yet (update Hermes).');
  old.side.destroy();
});

test('Files with Full access on Hermes: Upload, New folder, Delete; a file opens with Download', async () => {
  const p = panelFor(HERMES_FULL, {
    'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }),
    'GET /api/agent-chat/files': ok({ path: 'work', parent: '', entries: [{ name: 'a.txt', path: 'work/a.txt', dir: false, size: 5 }, { name: 'img', path: 'work/img', dir: true }] }),
    'GET /api/agent-chat/files/read': ok({ name: 'a.txt', path: 'work/a.txt', size: 5, mime: 'text/plain', encoding: 'base64', content: Buffer.from('hello').toString('base64') }),
    'POST /api/agent-chat/files': ok({ ok: true })
  }, { session: 's' });
  p.side.open('files');
  await tick();
  const body = () => p.root.querySelector('.hp-side-body');
  assert.ok(body().querySelector('.hp-fl-upload') && body().querySelector('.hp-fl-mkdir'), 'write buttons with Full access');
  assert.equal(body().querySelectorAll('.hp-fl-del').length, 2);
  body().querySelector('.hp-fl-mkdir').click();
  await tick(); await tick();
  assert.deepEqual(p.api.calls.find(c => c.method === 'POST').args, { agent: 'hermes-astra', session: 's', op: 'mkdir', path: 'work/notes' });
  await tick();
  body().querySelector('.hp-fl-row .hp-fl-open').click();
  await tick();
  assert.equal(body().querySelector('.hp-fl-text').textContent, 'hello');
  assert.equal(body().querySelector('.hp-fl-download').getAttribute('download'), 'a.txt');
  p.side.destroy();

  const oc = panelFor(OPENCLAW, { 'GET /api/agent-chat/tasks': ok({ active: [], recent: [] }), 'GET /api/agent-chat/files': ok({ path: '', parent: null, entries: [] }) });
  oc.side.open('files');
  await tick();
  assert.equal(oc.root.querySelector('.hp-fl-upload'), null, "OpenClaw's workspace is read here (its writes are documents)");
  oc.side.destroy();
});

test('media: signed hub links kept, mime/kind read, size limits, nodes per kind, viewer with Download', () => {
  const signed = Media.normalize({ url: '/api/agent-chat/media?t=abc.def', name: 'chart.png', mime: 'image/png', size: 1200 });
  assert.equal(signed.url, '/api/agent-chat/media?t=abc.def', 'signed link not rewritten');
  assert.equal(signed.kind, 'image');
  assert.equal(Media.normalize('/home/me/out.mp3').url, '/chat-media?path=%2Fhome%2Fme%2Fout.mp3', 'local paths keep the older relay');
  assert.equal(Media.normalize({ url: '/api/agent-chat/media?t=x', kind: 'video' }).kind, 'video', 'hub kind hint');
  assert.equal(Media.normalize({ url: 'https://x.example/a.pdf' }).kind, 'file');
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const list = Media.normalizeList([
    signed,
    { url: '/api/agent-chat/media?t=v', name: 'clip.mp4', mime: 'video/mp4', size: 5 * 1024 * 1024 },
    { url: '/api/agent-chat/media?t=a', name: 'voice.ogg', mime: 'audio/ogg' },
    { url: '/api/agent-chat/media?t=f', name: 'report.pdf', mime: 'application/pdf', size: 300000 },
    { url: '/api/agent-chat/media?t=big', name: 'huge.mp4', mime: 'video/mp4', size: 80 * 1024 * 1024 },
    { url: '/api/agent-chat/media?t=f', name: 'dup' }
  ]);
  assert.equal(list.length, 5, 'duplicates dropped');
  const wrap = Media.render(document, list);
  const kinds = [...wrap.querySelectorAll('.chat-media-item')].map(f => f.dataset.kind);
  assert.deepEqual(kinds, ['image', 'video', 'audio', 'file', 'video']);
  assert.ok(wrap.querySelector('img.chat-image-clickable'), 'picture opens the viewer on click');
  assert.equal(wrap.querySelectorAll('video').length, 1, 'only the small video plays inline');
  assert.equal(wrap.querySelector('audio').controls, true, 'audio player');
  const cards = [...wrap.querySelectorAll('.chat-media-file-card')];
  assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector('.chat-media-file-meta').textContent, '293 KB');
  assert.equal(cards[1].querySelector('.chat-media-file-meta').textContent, '80 MB · Too large to show here');
  assert.equal(cards[1].querySelector('.chat-media-file-download').getAttribute('download'), 'huge.mp4');
  const viewer = Media.openViewer(document, { url: signed.url, name: 'chart.png' }, { copy: () => {} });
  assert.equal(viewer.hidden, false);
  assert.equal(viewer.querySelector('.hp-media-viewer-download').getAttribute('href'), signed.url);
  assert.deepEqual(texts(viewer.querySelectorAll('.hp-media-viewer-bar button')), ['Zoom', 'Copy', '✕']);
  viewer.querySelector('.hp-media-viewer-close').click();
  assert.equal(viewer.hidden, true);
});

test('pure helpers: status lines, chip text, task shapes from both providers', () => {
  const now = 1793549500000;
  const t = Side.normalizeTask(RUNNING, 'agent:main:main');
  assert.equal(Side.statusLine(t, now), 'Running · 48s · Current tool: Bash · 3 tool uses');
  const done = Side.normalizeTask({ id: 'x', status: 'succeeded', title: 'Y', endedAt: (now - 7200000) / 1000 });
  assert.equal(Side.statusLine(done, now), 'Done · 2h ago', 'seconds turned into ms');
  assert.equal(Side.normalizeTask({ id: 'h', status: 'timed_out', goal: 'Summarise logs', lastToolName: 'read' }).title, 'Summarise logs');
  assert.equal(Side.normalizeTask({ id: 'q', prompt: 'Line one\nline two' }).title, 'Line one');
  assert.equal(Side.normalizeTask({ title: 'no id' }), null);
  assert.equal(Side.chipText([]), '');
  assert.equal(Side.chipText([t]), '1 running task · Research the venues');
});
