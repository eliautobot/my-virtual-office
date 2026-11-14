// Settings > Connections and the agent dialog model control (Hermes/OpenClaw port, phase C4).
//
// Drives headless Chrome through playwright-core against the app files in this
// tree. Every request is answered by the test itself (static files from app/,
// fixed API fixtures); POST bodies are recorded and answered {"ok":true}, so no
// server is needed and nothing is saved anywhere.
//
// Checks:
//   1. Connections shows a read-only summary of the Agent Providers rows and
//      "Manage in Agent Providers" links; the old OpenClaw/Hermes editors are gone.
//   2. Settings save never posts hermes.connections (nor an openclaw section),
//      even when the loaded config has Hermes connections; the Hermes switch and
//      bridge still save, and untouched sections are not posted.
//   3. A failed /api/agent-providers read shows a readable error with Retry.
//   4. The agent dialog Model control follows caps.models from /api/agent-chat/can
//      (OpenClaw keeps its picker until the answer arrives).
//   5. Phone 412x915: the Connections section has no sideways scroll, and the
//      Manage buttons are at least 40 px tall. HP_OFFICE_SHOT=<file.jpg> writes one crop.
//
// Run: node tests/test_hp_office_settings.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);

function skip(reason) {
  console.log(`SKIP test_hp_office_settings: ${reason}`);
  process.exit(0);
}

function loadPlaywright() {
  for (const candidate of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
    try { return require(candidate); } catch { /* try next */ }
  }
  return null;
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = findChrome();
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const ORIGIN = 'http://office.test';
const PROVIDERS = { ok: true, providers: [
  { id: 'openclaw', kind: 'openclaw', transport: 'gateway', name: 'OpenClaw', enabled: true, access: 'chat',
    status: { state: 'connected' }, agents: [{ id: 'alpha' }, { id: 'gamma' }] },
  { id: 'main', kind: 'hermes', transport: 'serve', name: 'Hermes', enabled: true, access: 'full',
    status: { state: 'connected', version: '0.22.2' }, agents: [{ id: 'hermes-main-default' }, { id: 'x', hidden: true }] },
  { id: 'astra', kind: 'hermes', transport: 'api', name: 'Astra', enabled: false, access: 'full',
    status: { state: 'offline' }, agents: [{ id: 'beta' }] },
  { id: 'codex', kind: 'codex', transport: 'app', name: 'Codex', enabled: true, status: { state: 'connected' }, agents: [] },
] };
const CAN = {
  alpha: { ok: true, kind: 'openclaw', access: 'full', manage: true, caps: { models: true }, connection: { id: 'openclaw' } },
  beta: { ok: true, kind: 'hermes', access: 'full', manage: true, caps: { models: true }, connection: { id: 'main' } },
  gamma: { ok: true, kind: 'opencode', access: 'full', manage: true, caps: { models: false }, connection: { id: 'default' } },
};

const FIXTURES = {
  '/api/license': { demo: false, valid: true, limits: {} },
  '/vo-config': { version: '0.8.0', office: { name: 'Test Office' }, features: {}, weather: { location: null },
    openclaw: { gatewayUrl: 'ws://127.0.0.1:18789', homePath: '/srv/openclaw' },
    hermes: { enabled: true, platformEnabled: false, platformAgentId: 'hermes-gateway',
      connections: [{ id: 'astra', name: 'Astra', apiUrl: 'http://hermes.test:8642', apiKeyConfigured: true }] } },
  '/api/agents': { agents: [
    { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true },
    { id: 'beta', statusKey: 'beta', name: 'Beta', emoji: '🦊', role: 'Tester', providerKind: 'hermes', available: true },
    { id: 'gamma', statusKey: 'gamma', name: 'Gamma', emoji: '🐙', role: 'Tester', providerKind: 'opencode', available: true },
  ] },
  '/status': { alpha: { state: 'idle' }, beta: { state: 'idle' }, gamma: { state: 'idle' } },
  '/api/office-config': { canvasWidth: 1040, canvasHeight: 740, furniture: [], agents: [], branches: [], pet: { enabled: false } },
  '/weather-proxy': { current_condition: [], configured: false },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };

function makeRoute(state) {
  return async routeObj => {
    const request = routeObj.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return routeObj.abort();
    const json = (body, status = 200) => routeObj.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      let body = null;
      try { body = JSON.parse(request.postData() || 'null'); } catch { body = request.postData(); }
      state.posts.push({ path: url.pathname, body });
      return json({ ok: true });
    }
    if (url.pathname === '/api/agent-providers') {
      state.providerReads += 1;
      return state.providersFail ? json({ ok: false, error: 'boom' }, 500) : json(PROVIDERS);
    }
    if (url.pathname === '/api/agent-chat/can') return json(CAN[url.searchParams.get('agent')] || { ok: false, reason: 'offline' });
    if (url.pathname === '/api/agent-chat/models') return json({ ok: true, models: [{ id: 'hm/one', label: 'One' }, { id: 'hm/two' }], default: 'hm/one' });
    if (url.pathname === '/api/native-models') return json({ openclaw: { models: [{ id: 'oc/alpha', provider: 'oc' }], defaultModel: 'oc/alpha', agents: {} } });
    if (Object.prototype.hasOwnProperty.call(FIXTURES, url.pathname)) return json(FIXTURES[url.pathname]);
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel);
    const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return routeObj.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    }
    return json({});
  };
}

const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
let passed = 0;
function check(cond, name, detail = '') {
  if (!cond) throw new Error(`FAIL ${name}${detail ? ': ' + detail : ''}`);
  passed += 1;
  console.log(`[PASS] ${name}`);
}

async function openOffice(state, { width, height, mobile = false }) {
  const options = { viewport: { width, height } };
  if (mobile) Object.assign(options, { deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  const context = await browser.newContext(options);
  await context.route('**/*', makeRoute(state));
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(String(error && error.message || error)));
  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.toggleMainMenu === 'function' && typeof window.mmSaveSettings === 'function');
  return { context, page };
}

async function openSettings(page) {
  await page.evaluate(() => { if (!_mainMenuOpen) toggleMainMenu(); });
  await page.waitForFunction(() => _mmSettingsLoaded === true);
  await page.waitForFunction(() => !document.querySelector('#mm-ap-hermes-list').textContent.includes('Loading'));
}

const summaryOf = page => page.evaluate(() => ({
  oc: [...document.querySelectorAll('#mm-ap-openclaw-list .mm-status')].map(el => [el.className, el.textContent]),
  hm: [...document.querySelectorAll('#mm-ap-hermes-list .mm-status')].map(el => [el.className, el.textContent]),
  manage: [...document.querySelectorAll('[data-ap-manage]')].map(a => a.getAttribute('href')),
  old: ['mm-gateway-url', 'mm-gateway-token', 'mm-oc-path', 'mm-hermes-connections', 'mm-hermes-status']
    .filter(id => document.getElementById(id)),
}));

try {
  // ---- desktop: summary + save bodies -------------------------------------------------
  const state = { posts: [], errors: [], providerReads: 0, providersFail: false };
  const { context, page } = await openOffice(state, { width: 1600, height: 900 });
  await openSettings(page);
  const s = await summaryOf(page);
  check(s.old.length === 0, 'old OpenClaw/Hermes editors are gone', s.old.join(','));
  check(s.oc.length === 1 && /OpenClaw · Connected · 2 agents · Chat only/.test(s.oc[0][1]) && /\bok\b/.test(s.oc[0][0]),
    'OpenClaw summary row', JSON.stringify(s.oc));
  check(s.hm.length === 2 && /^Hermes · Connected · 1 agent$/.test(s.hm[0][1]),
    'Hermes serve row (hidden agents not counted)', JSON.stringify(s.hm));
  check(/^Astra · Switched off · 1 agent · older API server$/.test(s.hm[1][1]) && /\binfo\b/.test(s.hm[1][0]),
    'legacy Hermes row is marked and switched off', JSON.stringify(s.hm[1]));
  check(s.manage.join(' ') === '/providers.html?provider=openclaw /providers.html?provider=hermes',
    'Manage in Agent Providers links', s.manage.join(' '));

  // Only office changed: no hermes, no openclaw.
  await page.fill('#mm-office-name', 'Renamed Office');
  check(await page.evaluate(() => mmSaveSettings()) === true, 'save resolves true');
  let save = state.posts.filter(p => p.path === '/setup/save').pop();
  check(save && save.body.office && save.body.office.name === 'Renamed Office' && !('hermes' in save.body) && !('openclaw' in save.body),
    'office-only save posts only office', JSON.stringify(save && save.body));

  // Hermes switch + bridge changed: hermes posted without connections.
  await page.evaluate(() => {
    document.getElementById('mm-hermes-platform-enable').checked = true;
    document.getElementById('mm-hermes-platform-agent').value = 'bridge-one';
  });
  await page.evaluate(() => mmSaveSettings());
  save = state.posts.filter(p => p.path === '/setup/save').pop();
  const h = save && save.body.hermes;
  check(h && !('connections' in h) && h.platformEnabled === true && h.platformAgentId === 'bridge-one' && h.enabled === true,
    'hermes save has no connections (switch + bridge only)', JSON.stringify(save && save.body));
  check(!('openclaw' in save.body) && !('office' in save.body), 'unchanged sections are not posted again', Object.keys(save.body).join(','));
  check(state.posts.every(p => p.path === '/setup/save' && !(p.body && p.body.hermes && 'connections' in p.body.hermes)),
    'no request ever carried hermes.connections', state.posts.map(p => p.path).join(','));

  // ---- agent dialog model control by caps.models ------------------------------------
  const modes = await page.evaluate(async () => {
    const out = {};
    const render = (key, kind, editable) => _renderAgentWorkspaceSettings({ agent: { statusKey: key, providerKind: kind, model: 'cur' },
      settings: { modelEditable: editable }, workspace: {}, score: {} });
    _agentWorkspace.can = null; _agentWorkspace.panelKey = 'alpha';
    out.ocFallback = /id="agent-workspace-model-select"/.test(render('alpha', 'openclaw', true));
    out.hmFallback = /id="agent-workspace-model-select"/.test(render('beta', 'hermes', true));
    for (const key of ['alpha', 'beta', 'gamma']) {
      _agentWorkspace.panelKey = key;
      _loadAgentWorkspaceCaps(key);
      const t0 = Date.now();
      while (!(_agentWorkspace.can && _agentWorkspace.can.caps) && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 20));
      const kind = { alpha: 'openclaw', beta: 'hermes', gamma: 'opencode' }[key];
      out[key] = { editable: render(key, kind, true), locked: render(key, kind, false) };
    }
    _agentWorkspace.can = { key: 'beta', caps: { models: true }, kind: 'hermes', access: 'chat', manage: true, connection: { id: 'main' } };
    _agentWorkspace.panelKey = 'beta';
    out.chatOnly = render('beta', 'hermes', false);
    return out;
  });
  const sel = html => /id="agent-workspace-model-select"/.test(html);
  check(modes.ocFallback && !modes.hmFallback, 'before caps arrive only OpenClaw gets the picker');
  check(sel(modes.alpha.editable), 'OpenClaw caps.models -> picker');
  check(sel(modes.beta.editable), 'Hermes caps.models -> picker (no providerKind check)');
  check(!sel(modes.gamma.editable) && /placeholder="Use provider default"/.test(modes.gamma.editable),
    'caps.models false -> plain model field');
  check(/data-aw-model-note/.test(modes.beta.locked) && /href="\/providers\.html\?provider=hermes&amp;connection=main"/.test(modes.beta.locked) && /readonly/.test(modes.beta.locked),
    'provider-managed model: read-only + "Change the default in Agent Providers"');
  check(/data-aw-model-note/.test(modes.chatOnly) && !/providers\.html/.test(modes.chatOnly), 'Chat only: note without the Agent Providers link');
  check(!/data-aw-model-note/.test(modes.gamma.locked), 'no note when the platform has no model switching');

  // Hermes picker reads /api/agent-chat/models.
  const options = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.innerHTML = '<select id="agent-workspace-model-select"></select>';
    document.body.appendChild(host);
    await _populateAgentWorkspaceModels({ agent: { statusKey: 'beta', providerKind: 'hermes', model: 'hm/two' } });
    const select = document.getElementById('agent-workspace-model-select');
    const out = [...select.options].map(o => o.value).join(',') + '|' + select.value;
    host.remove();
    return out;
  });
  check(options === ',hm/one,hm/two|hm/two', 'Hermes picker lists /api/agent-chat/models and selects the current model', options);
  check(state.errors.length === 0, 'desktop: no page errors', state.errors.join(' | '));
  await context.close();

  // ---- failed read -------------------------------------------------------------------
  const failState = { posts: [], errors: [], providerReads: 0, providersFail: true };
  const failed = await openOffice(failState, { width: 1600, height: 900 });
  await openSettings(failed.page);
  const f = await summaryOf(failed.page);
  check(/Could not read the connections \(HTTP 500\)/.test(f.hm[0] && f.hm[0][1]) && /\berr\b/.test(f.hm[0][0]), 'failed read shows a readable error', JSON.stringify(f.hm));
  failState.providersFail = false;
  const reads = failState.providerReads;
  await failed.page.evaluate(() => document.querySelector('#mm-ap-hermes-list button').click());
  await failed.page.waitForFunction(() => /Connected/.test(document.querySelector('#mm-ap-hermes-list').textContent));
  check(failState.providerReads === reads + 1, 'Retry reads the connections again');
  await failed.context.close();

  // ---- phone ------------------------------------------------------------------------
  const phoneState = { posts: [], errors: [], providerReads: 0, providersFail: false };
  const phone = await openOffice(phoneState, { width: 412, height: 915, mobile: true });
  await openSettings(phone.page);
  await phone.page.evaluate(() => {
    const tab = document.querySelector('.settings-nav button[data-category="connections"]');
    if (tab) tab.click();
  });
  const geo = await phone.page.evaluate(() => {
    const sections = [...document.querySelectorAll('.mm-section[data-category="connections"]')].filter(el => el.offsetParent);
    const over = sections.map(el => el.scrollWidth - el.clientWidth).reduce((a, b) => Math.max(a, b), 0);
    const buttons = [...document.querySelectorAll('[data-ap-manage]')].filter(el => el.offsetParent).map(el => Math.round(el.getBoundingClientRect().height));
    const box = sections.length ? sections[0].getBoundingClientRect() : null;
    const last = sections.length ? sections[sections.length - 1].getBoundingClientRect() : null;
    return { visible: sections.length, over, buttons, docOver: document.documentElement.scrollWidth - window.innerWidth,
      clip: box && last ? { x: Math.max(0, box.left), y: Math.max(0, box.top), width: Math.min(412, box.width), height: Math.min(915 - Math.max(0, box.top), last.bottom - box.top) } : null };
  });
  check(geo.visible >= 2 && geo.over <= 1 && geo.docOver <= 1, 'phone: Connections fits without sideways scroll', JSON.stringify(geo));
  check(geo.buttons.length === 2 && geo.buttons.every(hgt => hgt >= 40), 'phone: Manage buttons are tap-sized', geo.buttons.join(','));
  if (process.env.HP_OFFICE_SHOT && geo.clip) {
    await phone.page.screenshot({ path: process.env.HP_OFFICE_SHOT, type: 'jpeg', quality: 60, clip: geo.clip });
    console.log(`shot: ${process.env.HP_OFFICE_SHOT}`);
  }
  check(phoneState.errors.length === 0, 'phone: no page errors', phoneState.errors.join(' | '));
  await phone.context.close();
} finally {
  await browser.close();
}
console.log(`test_hp_office_settings: ${passed} checks passed`);
