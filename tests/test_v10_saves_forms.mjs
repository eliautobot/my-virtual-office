// v0.10.1 save safety (client forms): a save on the way never eats a later edit.
//
// One headless Chrome, hermetic page: every request is answered by the test
// (static files from app/, fixed fixtures); POSTs are recorded and can be held
// so an edit lands while a save is on the way. Nothing is saved anywhere.
//
//   node tests/test_v10_saves_forms.mjs
import fs from 'node:fs';
import path from 'node:path';
import { APP, launch, makeChecker, officeFixture } from './test_v10_editor_lib.mjs';
import { openStudio, showStudio, fixtures as studioFixtures } from './test_v10_studio_lib.mjs';

const check = makeChecker('test_v10_saves_forms');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ORIGIN = 'http://office.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.jpg': 'image/jpeg' };

// state: { posts, errors, inFlight, maxInFlight, hold: { [path]: n posts to hold }, held: [], answer: { [path]: fn(body) } , fixtures }
function makeState(extra = {}) {
  return Object.assign({ posts: [], errors: [], inFlight: {}, maxInFlight: {}, hold: {}, held: [], answer: {}, fixtures: {} }, extra);
}

const BASE_FIXTURES = {
  '/api/license': { demo: false, valid: true, limits: {} },
  '/vo-config': { version: '0.10.1', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
  '/api/agents': { agents: [{ id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }] },
  '/status': { alpha: { state: 'idle', task: '' } }, '/agent-chat': {}, '/api/layouts': { layouts: [] },
  '/api/agent-providers': { ok: true, providers: [] },
  '/api/office-config': { canvasWidth: 1040, canvasHeight: 740, furniture: [], agents: [], branches: [], pet: { enabled: false } },
  '/weather-proxy': { current_condition: [], configured: false },
};

async function openPage(browser, state, url = '/', init = null) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  if (init) await context.addInitScript(init.fn, init.arg);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== ORIGIN) return route.abort();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch { body = req.postData(); }
      const p = u.pathname;
      const entry = { path: p, method: req.method(), body, headers: req.headers() };
      state.posts.push(entry);
      state.inFlight[p] = (state.inFlight[p] || 0) + 1;
      state.maxInFlight[p] = Math.max(state.maxInFlight[p] || 0, state.inFlight[p]);
      if (state.hold[p] > 0) {
        state.hold[p] -= 1;
        await new Promise(resolve => state.held.push(resolve));
      }
      state.inFlight[p] -= 1;
      const fn = state.answer[p];
      const out = fn ? fn(entry) : { ok: true };
      return json(out && out.__status ? out.body : out, out && out.__status ? out.__status : 200);
    }
    const fixtures = Object.assign({}, BASE_FIXTURES, state.fixtures);
    if (typeof fixtures[u.pathname] === 'function') {
      const out = fixtures[u.pathname](u);
      if (out === 'abort') return route.abort();
      return json(out);
    }
    if (Object.prototype.hasOwnProperty.call(fixtures, u.pathname)) return json(fixtures[u.pathname]);
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel);
    const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return route.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    }
    return json({});
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => state.errors.push(String(e && e.message || e)));
  await page.goto(ORIGIN + url, { waitUntil: 'load' });
  return { context, page };
}

const release = (state) => { const r = state.held.shift(); if (r) r(); return !!r; };
async function waitHeld(state, n = 1) {
  for (let i = 0; i < 200 && state.held.length < n; i++) await sleep(25);
  return state.held.length >= n;
}

// ---------------------------------------------------------------- S1 Settings Save
async function partSettings(browser) {
  const state = makeState();
  const { context, page } = await openPage(browser, state);
  try {
    await page.waitForFunction(() => typeof window.toggleMainMenu === 'function' && typeof window.mmSaveSettings === 'function');
    await page.evaluate(() => { if (!_mainMenuOpen) toggleMainMenu(); });
    await page.waitForFunction(() => _mmSettingsLoaded === true);
    await sleep(800);                       // the panel ignores input for 700 ms after opening (hydration)
    const type = (v) => page.evaluate((val) => {
      const el = document.getElementById('mm-office-name'); el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
    const saves = () => state.posts.filter(p => p.path === '/setup/save');

    // Save pressed twice while the first save is on the way: one at a time, the latest text is sent after.
    state.hold['/setup/save'] = 1;
    await type('Alpha Office');
    await page.evaluate(() => { window.__s1 = mmSaveSettings(); });
    await waitHeld(state);
    await type('Beta Office');
    await page.evaluate(() => { window.__s2 = mmSaveSettings(); window.__s3 = mmSaveSettings(); });
    await sleep(200);
    check.ok(saves().length === 1, 'settings: Save during a save waits (one at a time)', String(saves().length));
    release(state);
    const r = await page.evaluate(async () => [await window.__s1, await window.__s2, await window.__s3]);
    const names = saves().map(p => p.body && p.body.office && p.body.office.name);
    check.ok(r[0] === true && r[1] === true && r[2] === true, 'settings: every Save press resolves true', JSON.stringify(r));
    check.ok(names.length === 2 && names[0] === 'Alpha Office' && names[1] === 'Beta Office',
      'settings: the text typed during the save is sent by the follow-up save', JSON.stringify(names));
    check.ok((state.maxInFlight['/setup/save'] || 0) === 1, 'settings: never two saves at once');

    // Edit typed during a save, Save not pressed again: it stays unsaved (not marked saved).
    state.hold['/setup/save'] = 1;
    await type('Gamma Office');
    await page.evaluate(() => { window.__s4 = mmSaveSettings(); });
    await waitHeld(state);
    await type('Delta Office');
    release(state);
    const after = await page.evaluate(async () => {
      const ok = await window.__s4;
      await new Promise(r => setTimeout(r, 50));
      const panel = document.getElementById('main-menu-panel');
      return { ok, unsaved: _mmHasUnsavedEdits(), dirtyClass: !!(panel && panel.classList.contains('ui-settings-dirty')) };
    });
    check.ok(after.ok === true && after.unsaved === true, 'settings: an edit typed during the save stays unsaved', JSON.stringify(after));
    check.ok(after.dirtyClass === true, 'settings: the unsaved marker stays on for it', JSON.stringify(after));
    await page.evaluate(() => mmSaveSettings());
    const last = saves().map(p => p.body && p.body.office && p.body.office.name).pop();
    check.ok(last === 'Delta Office', 'settings: the next Save sends it', String(last));
    // v0.10.1 B4: after a clean save the footer (Discard / Save changes) goes away.
    const clean = await page.evaluate(async () => {
      await new Promise(r => setTimeout(r, 50));
      const panel = document.getElementById('main-menu-panel');
      const footer = panel && panel.querySelector('.settings-footer');
      return { dirty: !!(panel && panel.classList.contains('ui-settings-dirty')), footer: footer ? getComputedStyle(footer).display : 'none' };
    });
    check.ok(clean.dirty === false && clean.footer === 'none', 'settings: after a clean save Discard / Save changes hide (B4)', JSON.stringify(clean));

    // S2: a Test button saves its section as the form shows it, after a Save on the way,
    // and the form then agrees with what was saved (the switch was forced on only on the server).
    state.hold['/setup/save'] = 1;
    await page.evaluate(() => {
      document.getElementById('mm-browser-enable').checked = false;
      document.getElementById('mm-cdp-url').value = 'http://127.0.0.1:9222';
      const name = document.getElementById('mm-office-name'); name.value = 'Echo Office';
      window.__s5 = mmSaveSettings();
    });
    await waitHeld(state);
    const before = saves().length;
    await page.evaluate(() => { mmTestCdp(); });
    await sleep(200);
    check.ok(saves().length === before, 'test button: waits for the Save on the way', String(saves().length - before));
    release(state);
    await page.evaluate(() => window.__s5);
    for (let i = 0; i < 80 && saves().length < before + 1; i++) await sleep(25);
    await sleep(100);
    const t = await page.evaluate(() => ({ on: document.getElementById('mm-browser-enable').checked, unsaved: _mmHasUnsavedEdits(),
      baseline: _mmBaseline.browser, now: _mmCollectSections().browser }));
    const testPost = saves()[saves().length - 1].body || {};
    check.ok(testPost.features && testPost.features.browserPanel === true && t.on === true,
      'test button: the switch is on in the form too', JSON.stringify([testPost.features, t.on]));
    check.ok(t.baseline === t.now, 'test button: the browser section counts as saved', JSON.stringify(t));
    check.ok((state.maxInFlight['/setup/save'] || 0) === 1, 'test button: never two settings saves at once');
    check.ok(state.errors.length === 0, 'settings: no page errors', state.errors[0]);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- L5 edits before the server answered
async function partOfflineBoot(browser) {
  let gets = 0;
  const server = officeFixture();
  server.furniture.find(f => f.id === 'c1').x = 555;           // changed elsewhere while this tab was offline
  const state = makeState({ fixtures: { '/api/office-config': () => (++gets === 1 ? 'abort' : server) } });
  const cached = officeFixture();
  const { context, page } = await openPage(browser, state, '/', {
    fn: ([key, doc]) => { try { localStorage.setItem(key, doc); } catch (e) {} },
    arg: ['vo-product-office-config', JSON.stringify(cached)] });
  try {
    await page.waitForFunction(() => typeof saveOfficeConfig === 'function' && window.officeConfig &&
      officeConfig.furniture.some(f => f.id === 'd1'));
    await page.waitForFunction(() => _serverConfigWarned === true, null, { timeout: 10000 });
    const blocked = await page.evaluate(() => { officeConfig.furniture.find(f => f.id === 'd1').x = 777; return saveOfficeConfig(); });
    check.ok(blocked === false, 'offline boot: a save before the server answered is held');
    await page.waitForFunction(() => _serverConfigLoaded === true, null, { timeout: 15000 });
    await page.waitForFunction(() => _officeSaveState.state === 'saved', null, { timeout: 15000 }).catch(() => {});
    const view = await page.evaluate(() => ({ d1: officeConfig.furniture.find(f => f.id === 'd1').x, c1: officeConfig.furniture.find(f => f.id === 'c1').x }));
    const posts = state.posts.filter(p => p.path === '/api/office-config');
    const sent = posts.length ? posts[posts.length - 1].body : null;
    const sx = (id) => sent && (sent.furniture.find(f => f.id === id) || {}).x;
    check.ok(view.d1 === 777 && view.c1 === 555, 'offline boot: the edit is kept when the server answers, merged with its copy', JSON.stringify(view));
    check.ok(sx('d1') === 777 && sx('c1') === 555, 'offline boot: the merged layout is saved', JSON.stringify([sx('d1'), sx('c1'), posts.length]));
    check.ok(state.errors.length === 0, 'offline boot: no page errors', state.errors[0]);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- L6 Settings > Full reset
async function partFullReset(browser) {
  const state = makeState({ answer: { '/api/office-config': () => ({ ok: true, reset: true, rev: '0' }) } });
  const { context, page } = await openPage(browser, state);
  try {
    await page.waitForFunction(() => typeof mmFullReset === 'function' && typeof _voConfirm === 'function');
    await page.evaluate(() => { window._voConfirm = async () => true; window._voPrompt = async () => 'RESET'; mmFullReset(); });
    for (let i = 0; i < 80 && !state.posts.some(p => p.path === '/api/office-config'); i++) await sleep(25);
    const post = state.posts.find(p => p.path === '/api/office-config');
    check.ok(post && post.body && post.body.reset === true, 'full reset: asks the server to reset (it refused {})', JSON.stringify(post && post.body));
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- S5 Agent Providers settings
async function partProviderSettings(browser) {
  const provider = () => ({ id: 'gen', name: 'Generic', icon: '*', description: 'Test provider', capabilities: {}, health: { ok: true },
    values: { label: 'one', timeoutSec: 600 },
    settingsSchema: { sections: [{ id: 's', label: 'Setup', fields: [
      { key: 'label', type: 'text', label: 'Label' }, { key: 'timeoutSec', type: 'number', label: 'Timeout' }] }] } });
  const state = makeState({
    fixtures: { '/api/provider-settings': { ok: true, providers: [provider()] }, '/api/agent-providers': { ok: true, providers: [] } },
    answer: { '/api/provider-settings/save': (e) => {
      const p = provider(); Object.assign(p.values, (e.body && e.body.values) || {}); return { ok: true, provider: p }; } },
  });
  const { context, page } = await openPage(browser, state, '/providers.html');
  try {
    await page.waitForSelector('#ps-gen-label', { timeout: 15000 });
    const type = (id, v) => page.evaluate(([i, val]) => { const el = document.getElementById(i); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, [id, v]);
    state.hold['/api/provider-settings/save'] = 1;
    await type('ps-gen-label', 'two');
    await page.click('#ps-save');
    await waitHeld(state);
    await type('ps-gen-timeoutSec', '42');
    release(state);
    await page.waitForFunction(() => !document.getElementById('ps-save').disabled, null, { timeout: 10000 });
    await sleep(100);
    const shown = await page.evaluate(() => document.getElementById('ps-gen-timeoutSec').value);
    check.ok(shown === '42', 'providers: a field typed during the save keeps its value', shown);
    await page.click('#ps-save');
    for (let i = 0; i < 80 && state.posts.filter(p => p.path === '/api/provider-settings/save').length < 2; i++) await sleep(25);
    const sent = state.posts.filter(p => p.path === '/api/provider-settings/save').map(p => p.body.values);
    check.ok(sent.length === 2 && sent[0].label === 'two' && sent[1].timeoutSec === 42 && !('label' in sent[1]),
      'providers: the next save sends it (and only it)', JSON.stringify(sent));
    check.ok(state.errors.length === 0, 'providers: no page errors', state.errors[0]);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- S6 Models page redraw
async function partModelsPage(browser) {
  let reads = 0;
  const native = { openclaw: { ok: true, defaultModel: '', models: [], providers: [], authProfiles: [], agents: {} },
    hermes: { profiles: [] }, codex: { enabled: true, homePath: '/x', sandbox: 'workspace-write', approvalPolicy: 'never' },
    claudeCode: { enabled: true, permissionMode: 'default', homePath: '/c' } };
  const state = makeState({
    fixtures: { '/api/native-models': () => { reads++; return native; }, '/api/agent-providers': { ok: true, providers: [] } },
    answer: { '/setup/save': (e) => { Object.assign(native.claudeCode, (e.body && e.body.claudeCode) || {}); return { ok: true }; } },
  });
  const { context, page } = await openPage(browser, state, '/models.html');
  try {
    await page.waitForSelector('#setup-codex-home', { state: 'attached', timeout: 15000 });
    const type = (id, v) => page.evaluate(([i, val]) => { const el = document.getElementById(i); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }, [id, v]);
    await type('setup-codex-home', '/typed/codex');            // not saved yet
    await type('setup-claude-home', '/saved/claude');
    const before = reads;
    await page.evaluate(() => document.querySelector('[data-action="save-claude"]').click());
    for (let i = 0; i < 120 && reads <= before; i++) await sleep(25);
    await sleep(300);
    const v = await page.evaluate(() => ({ codex: document.getElementById('setup-codex-home').value, claude: document.getElementById('setup-claude-home').value }));
    check.ok(reads > before, 'models: the page redrew after the save');
    check.ok(v.codex === '/typed/codex', 'models: an unsaved field in another form survives the redraw', JSON.stringify(v));
    check.ok(v.claude === '/saved/claude', 'models: the saved field shows the saved value', JSON.stringify(v));
    check.ok(state.errors.length === 0, 'models: no page errors', state.errors[0]);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------- A1 Agent Studio save during a save
async function partStudio(browser) {
  let holdNext = 0;
  const held = [];
  const writeReply = async (p) => {
    if (p.startsWith('/api/agent-workspace/') && holdNext > 0) { holdNext--; await new Promise(r => held.push(r)); }
    return null;
  };
  const run = await openStudio(browser, { writeReply });
  const { page, writes, errors } = run;
  try {
    await showStudio(page, 'alpha');
    const desk = () => writes.filter(w => w.path.startsWith('/api/agent-workspace/'));
    holdNext = 1;
    await page.evaluate(() => { _agentPanelEditState.role = 'Role A'; window.__a1 = _acpSave(); });
    for (let i = 0; i < 80 && !held.length; i++) await sleep(25);
    await page.evaluate(() => { _agentPanelEditState.role = 'Role B'; window._acpUnsaved = true; window.__a2 = _acpSave(); window.__a3 = _acpSave(); });
    // Switch agents right after asking for the save (the "Save them first?" path).
    await page.evaluate(() => { _agentPanelEditState.emoji = '🦄'; window.__a4 = _acpSave(); _acpSelectAgent('beta'); });
    await sleep(150);
    check.ok(desk().length === 1, 'studio: a save asked for during a save waits', String(desk().length));
    held.splice(0).forEach(r => r());
    const r = await page.evaluate(async () => [await window.__a1, await window.__a2, await window.__a3, await window.__a4]);
    await sleep(100);
    const sent = desk().map(w => w.path + ':' + w.body.role + ':' + w.body.emoji);
    const cfg = await page.evaluate(() => { const a = officeConfig.agents.find(x => x.id === 'alpha'); return a && [a.role, a.emoji]; });
    check.ok(r.every(v => v === true), 'studio: every save resolves saved', JSON.stringify(r));
    check.ok(desk().length === 2 && desk()[1].path.endsWith('/alpha') && desk()[1].body.role === 'Role B' && desk()[1].body.emoji === '🦄',
      'studio: the follow-up save sends the latest edits of that agent (after switching too)', JSON.stringify(sent));
    check.ok(cfg && cfg[0] === 'Role B' && cfg[1] === '🦄', 'studio: the office copy has them', JSON.stringify(cfg));
    check.ok(errors.length === 0, 'studio: no page errors', errors[0]);
  } finally {
    await run.context.close();
  }
}

// ---------------------------------------------------------------- A3/A4/A5 Agent desk forms
async function partDesk(browser) {
  const fx = studioFixtures();
  const desk = { ok: true, agent: { id: 'alpha', statusKey: 'alpha', name: 'Alpha', role: 'Tester', emoji: '🤖', branch: 'HQ', providerKind: 'openclaw' },
    workspace: { notes: [{ id: 'n1', title: 'Note', content: 'c', tags: ['red'], folder: 'General', kind: 'note' }], tasks: [], bulletin: [] },
    settings: { modelEditable: false, heartbeatApplicable: true, heartbeatContent: 'hb', heartbeatRevision: 'rev-1' }, score: {} };
  fx['/api/agent-workspace/alpha'] = desk;
  fx['/api/skills-library/tidy'] = { name: 'tidy', content: '---\nname: tidy\ndescription: d\n---\n', revision: 'r-lib' };
  let holdNext = 0;
  const held = [];
  const writeReply = async (p) => {
    if (!p.startsWith('/api/agent-workspace/')) return null;
    if (holdNext > 0) { holdNext--; await new Promise(r => held.push(r)); }
    return { body: desk };
  };
  const run = await openStudio(browser, { fx, writeReply });
  const { page, writes, errors } = run;
  try {
    await page.evaluate(() => { _openAgentWorkspace(agents.find(a => a.id === 'alpha')); });
    await page.waitForFunction(() => _agentWorkspace.data && _agentWorkspace.data.ok, null, { timeout: 10000 });
    await page.evaluate(() => { _agentWorkspace.activeTab = 'notes'; _renderAgentWorkspace(); });
    const posts = () => writes.filter(w => w.path === '/api/agent-workspace/alpha');
    // Typing in the task form, then a redraw (another tab and back): the text stays.
    await page.evaluate(() => {
      _agentWorkspace.activeTab = 'tasks'; _renderAgentWorkspace();
      const t = document.querySelector('[data-aw-form="task"] [name="text"]');
      t.value = 'draft task'; t.dispatchEvent(new Event('input', { bubbles: true }));
      _agentWorkspace.activeTab = 'notes'; _renderAgentWorkspace();
    });
    // Saving the open note twice quickly, and typing while the save is on the way.
    await page.evaluate(() => {
      const edit = document.querySelector('[data-aw-form="note-save"] [name="title"]');
      edit.value = 'Edited'; edit.dispatchEvent(new Event('input', { bubbles: true }));
    });
    holdNext = 1;
    await page.evaluate(() => { const f = document.querySelector('[data-aw-form="note-save"]'); f.requestSubmit(); f.requestSubmit(); });
    for (let i = 0; i < 80 && !held.length; i++) await sleep(25);
    await page.evaluate(() => {
      const edit = document.querySelector('[data-aw-form="note-save"] [name="title"]');
      edit.value = 'Edited more'; edit.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(100);
    check.ok(posts().length === 1, 'desk: a double submit sends once', String(posts().length));
    held.splice(0).forEach(r => r());
    await sleep(300);
    const b = posts()[0] && posts()[0].body;
    check.ok(b && b.action === 'updateNote' && b.title === 'Edited' && !('tags' in b), 'desk: editing a note does not send tags (they were erased)', JSON.stringify(b));
    const typed = await page.evaluate(() => document.querySelector('[data-aw-form="note-save"] [name="title"]').value);
    check.ok(typed === 'Edited more', 'desk: text typed while the save was on the way survives its answer', typed);
    const task = await page.evaluate(() => { _agentWorkspace.activeTab = 'tasks'; _renderAgentWorkspace(); return document.querySelector('[data-aw-form="task"] [name="text"]').value; });
    check.ok(task === 'draft task', 'desk: typing in another form survives redraws', task);
    // HEARTBEAT.md is saved with the revision it was opened at.
    await page.evaluate(() => { _agentWorkspace.activeTab = 'settings'; _renderAgentWorkspace(); document.querySelector('[data-aw-form="settings"]').requestSubmit(); });
    await sleep(400);
    const sb = posts().map(w => w.body).find(x => x.action === 'updateSettings');
    check.ok(sb && sb.heartbeatRevision === 'rev-1', 'desk: the heartbeat is sent with its revision', JSON.stringify(sb && sb.heartbeatRevision));
    // Skill editors send back the revision they opened (A6).
    await page.evaluate(() => {
      _agentWorkspace.data.skills = [{ name: 'tidy', content: '---\nname: tidy\ndescription: d\n---\n', rootId: 'workspace', revision: 'r-skill', writable: true }];
      _agentWorkspace.data.settings.skillSchema = [{ id: 'workspace', writable: true }];
      _agentWorkspace.activeTab = 'skills'; _renderAgentWorkspace();
      document.querySelector('[data-aw-skill-edit="tidy"]').click();
    });
    await sleep(150);
    await page.evaluate(() => document.querySelector('[data-aw-form="agent-skill-save"]').requestSubmit());
    await sleep(300);
    const ks = posts().map(w => w.body).find(x => x.action === 'saveAgentSkill');
    check.ok(ks && ks.revision === 'r-skill', 'skills: the desk skill editor sends its revision', JSON.stringify(ks && ks.revision));
    await page.evaluate(async () => { await openSkillEditor('tidy'); await saveSkill(); });
    await sleep(200);
    const lib = writes.filter(w => w.path === '/api/skills-library').map(w => w.body);
    check.ok(lib.length === 1 && lib[0].revision === 'r-lib', 'skills: the library editor sends its revision', JSON.stringify(lib));
    await page.evaluate(async () => { await openSkillEditor(); document.getElementById('skl-editor-name').value = 'fresh'; await saveSkill(); });
    await sleep(200);
    const add = writes.filter(w => w.path === '/api/skills-library').map(w => w.body)[1];
    check.ok(add && add.revision === 'new', 'skills: Add Skill never replaces one with the same name', JSON.stringify(add));
    check.ok(errors.length === 0, 'desk: no page errors', errors[0]);
  } finally {
    await run.context.close();
  }
}

// ---------------------------------------------------------------- P2/P3 Projects board
async function partProjects(browser) {
  const project = { id: 'p1', title: 'Board', status: 'active', priority: 'medium', columns: [{ id: 'c1', title: 'Backlog' }, { id: 'c2', title: 'Doing' }],
    tasks: [
      { id: 't1', title: 'One', columnId: 'c1', order: 0, priority: 'medium', checklist: [{ id: 'k1', text: 'a', done: false }, { id: 'k2', text: 'b', done: false }] },
      { id: 't2', title: 'Two', columnId: 'c1', order: 1, priority: 'medium' },
      { id: 't3', title: 'Three', columnId: 'c2', order: 0, priority: 'medium' }], activity: [] };
  const state = makeState({ fixtures: { '/api/projects': { projects: [project] }, '/api/projects/p1': { project } } });
  const { context, page } = await openPage(browser, state);
  try {
    await page.waitForFunction(() => window.ProjMgr && typeof ProjMgr.openProject === 'function');
    await page.evaluate(async () => { ProjMgr.openProjectsManager(); await ProjMgr.openProject('p1'); });
    await page.waitForSelector('.proj-col[data-col-id="c2"]', { state: 'attached', timeout: 10000 });
    // P2: a drop sends only the column it went to (t2 untouched).
    await page.evaluate(() => {
      const dt = new DataTransfer(); dt.setData('text/plain', 't1');
      document.querySelector('.proj-task-card[data-task-id="t1"]').dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      const col = document.querySelector('.proj-col[data-col-id="c2"] .proj-col-tasks') || document.querySelector('.proj-col[data-col-id="c2"]');
      col.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    for (let i = 0; i < 80 && !state.posts.some(p => p.path.endsWith('/tasks/reorder')); i++) await sleep(25);
    const re = state.posts.find(p => p.path.endsWith('/tasks/reorder'));
    const ups = (re && re.body && re.body.updates) || [];
    check.ok(re && !ups.some(u => u.id === 't2') && ups.some(u => u.id === 't1' && u.columnId === 'c2') && !ups.some(u => u.id === 't3' && 'columnId' in u),
      'projects: a move sends only the column it went to (no other task\'s column from this copy)', JSON.stringify(ups));
    // P3: quick checklist saves go one at a time and the last list wins.
    await page.evaluate(() => ProjMgr.openTaskDetail('t1'));
    await sleep(200);
    const before = state.posts.filter(p => p.path === '/api/projects/p1/tasks/t1').length;
    state.hold['/api/projects/p1/tasks/t1'] = 1;
    await page.evaluate(() => { ProjMgr.toggleChecklistItem(0, true); });
    await waitHeld(state);
    await page.evaluate(() => { ProjMgr.toggleChecklistItem(1, true); ProjMgr.toggleChecklistItem(0, false); });
    await sleep(150);
    release(state);
    for (let i = 0; i < 80 && state.posts.filter(p => p.path === '/api/projects/p1/tasks/t1').length < before + 2; i++) await sleep(25);
    await sleep(200);
    const puts = state.posts.filter(p => p.path === '/api/projects/p1/tasks/t1').slice(before);
    const last = puts.length && puts[puts.length - 1].body.checklist;
    check.ok((state.maxInFlight['/api/projects/p1/tasks/t1'] || 0) === 1, 'projects: task saves go one at a time', String(state.maxInFlight['/api/projects/p1/tasks/t1']));
    check.ok(puts.length === 2 && last && last[0].done === false && last[1].done === true, 'projects: the latest checklist is the one saved last', JSON.stringify(puts.map(p => p.body.checklist && p.body.checklist.map(c => c.done))));
    check.ok(state.errors.length === 0, 'projects: no page errors', state.errors[0]);
  } finally {
    await context.close();
  }
}

const PARTS = { settings: partSettings, offline: partOfflineBoot, reset: partFullReset, providers: partProviderSettings, models: partModelsPage, studio: partStudio, desk: partDesk, projects: partProjects };

async function main() {
  setTimeout(() => { console.log('[FAIL] test_v10_saves_forms: timed out'); process.exit(1); }, 280000).unref();
  const only = process.argv.slice(2);
  const browser = await launch('test_v10_saves_forms');
  try {
    for (const [name, fn] of Object.entries(PARTS)) {
      if (only.length && !only.includes(name)) continue;
      await fn(browser);
    }
  } finally {
    await browser.close();
  }
  check.done();
}

main().catch((e) => { console.log('[FAIL] crashed: ' + (e && e.stack || e).toString().slice(0, 400)); process.exit(1); });
