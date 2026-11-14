// Setup wizard Hermes step + models page Hermes tab (Hermes/OpenClaw port, phase C5).
//
// Drives headless Chrome through playwright-core against the app files in this
// tree. Every request is answered by the test itself (static files from app/,
// fixed API fixtures); POST bodies are recorded and answered by mocks, so no
// server is needed and nothing is saved anywhere.
//
// Checks:
//   setup.html
//   1. the Hermes section mounts the Agent Providers form (address, sign-in, Test, Connect, Skip);
//   2. connected Hermes connections are listed with "Manage in Agent Providers";
//   3. older API server rows show only when they exist (and stay editable);
//   4. Skip folds the form into a note; "Connect Hermes now" brings it back;
//   5. Connect posts /api/agent-providers/save {kind:'hermes', transport:'serve'} and never /setup/save;
//      Finish with nothing else changed sends no hermes section;
//   6. phone 412x915: no sideways scroll in the Hermes section.
//   models.html
//   7. Hermes tab: Full access serve connection -> "Change in Agent Providers" (opens its Models tab);
//      older API server -> "Open in Agent Providers" with the switch note; Chat only -> note, no button;
//   8. without /api/agent-providers the tab still shows the profile cards, no buttons, no errors.
//
// Run: node tests/test_hp_pages_setup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);

function skip(reason) {
  console.log(`SKIP test_hp_pages_setup: ${reason}`);
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

const ORIGIN = 'http://pages.test';
const SERVE = { id: 'main', kind: 'hermes', transport: 'serve', name: 'Hermes', enabled: true, access: 'full',
  status: { state: 'connected', version: '0.22.2' }, fields: { url: 'http://hermes.test:9119' },
  agents: [{ id: 'hermes-main-default' }, { id: 'hermes-main-coby' }, { id: 'x', hidden: true }] };
const SERVE_CHAT = { ...SERVE, id: 'lab', name: 'Lab Hermes', access: 'chat', agents: [] };
const LEGACY = { id: 'astra', kind: 'hermes', transport: 'api', name: 'Astra', enabled: true, access: 'full', status: { state: 'connected' }, agents: [{ id: 'hermes-astra' }] };
const OPENCLAW = { id: 'openclaw', kind: 'openclaw', transport: 'gateway', name: 'OpenClaw', enabled: true, access: 'full', status: { state: 'connected' }, agents: [] };

function config({ legacy }) {
  return { version: '0.8.0', setupComplete: true, office: { name: 'Test Office' }, features: {}, weather: { location: null },
    openclaw: { homePath: '/srv/openclaw' },
    hermes: { enabled: true, platformEnabled: false, platformAgentId: 'hermes-gateway',
      connections: legacy ? [{ id: 'astra', name: 'Astra', apiUrl: 'http://hermes.test:8642', apiKeyConfigured: true }] : [] },
    codex: {}, claudeCode: {}, license: { demo: false } };
}

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
      if (url.pathname === '/api/agent-providers/save') {
        state.providers = [...state.providers, { ...SERVE, id: 'home', name: body.name || 'Hermes' }];
        return json({ ok: true, id: 'home', status: { state: 'connected' } });
      }
      return json({ ok: true });
    }
    if (url.pathname === '/api/agent-providers') {
      state.apReads += 1;
      return state.apMissing ? json({ ok: false, error: 'not_found' }, 404) : json({ ok: true, providers: state.providers, manifests: {} });
    }
    if (url.pathname === '/vo-config') return json(config(state));
    if (url.pathname === '/api/native-models') {
      return json({ openclaw: { models: [], providers: {}, agents: {} }, codex: {}, claudeCode: {},
        hermes: { profiles: state.legacy ? [{ id: 'astra', name: 'Astra', apiUrl: 'http://hermes.test:8642', available: true, model: 'm-1' }] : [] } });
    }
    if (url.pathname === '/api/access/status') return json({ protected: false, authenticated: true, viaLoopback: true, canManage: true });
    if (url.pathname === '/api/license') return json({ demo: false, valid: true });
    if (url.pathname === '/api/agents') return json({ agents: [] });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel.endsWith('.html') || path.extname(rel) ? rel : rel + '.html');
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

async function openPage(state, url, { width = 1600, height = 900, mobile = false } = {}) {
  const options = { viewport: { width, height } };
  if (mobile) Object.assign(options, { deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  const context = await browser.newContext(options);
  await context.route('**/*', makeRoute(state));
  const page = await context.newPage();
  page.on('pageerror', error => state.errors.push(String(error && error.message || error)));
  await page.goto(`${ORIGIN}${url}`, { waitUntil: 'load' });
  return { context, page };
}

const newState = extra => ({ posts: [], errors: [], apReads: 0, apMissing: false, legacy: false, providers: [OPENCLAW], ...extra });
const formReady = page => page.waitForFunction(() => !!document.querySelector('#hermes-ap-form form [data-act="submit"]'));

try {
  // ---- setup: no legacy rows, nothing connected yet ------------------------------------
  {
    const state = newState();
    const { context, page } = await openPage(state, '/setup.html');
    await page.waitForFunction(() => window.VOSetup && !window.VOSetup.prefill.loading);
    await formReady(page);
    await page.evaluate(() => window.VOSetup.showStep(2));
    const view = await page.evaluate(() => {
      const form = document.querySelector('#hermes-ap-form form');
      return {
        acts: [...form.querySelectorAll('[data-act]')].map(el => el.dataset.act),
        keys: [...form.querySelectorAll('.apf[data-key]')].map(el => el.dataset.key),
        legacyHidden: document.getElementById('hermes-legacy').hidden,
        existingHidden: document.getElementById('hermes-ap-existing').hidden,
        addLegacy: !!document.querySelector('[data-action="add-hermes"]'),
      };
    });
    check(['test', 'submit', 'skip'].every(a => view.acts.includes(a)), 'setup: Hermes step mounts the Agent Providers form with Test, Connect and Skip', view.acts.join(','));
    check(view.keys.includes('url') && view.keys.includes('auth'), 'setup: form asks for the Hermes address and sign-in', view.keys.join(','));
    check(view.legacyHidden && view.existingHidden && !view.addLegacy, 'setup: no older API server block or "Add connection" when none exist');

    // Skip folds the form; "Connect Hermes now" brings it back.
    await page.click('#hermes-ap-form [data-act="skip"]');
    const skipped = await page.evaluate(() => ({ formHidden: document.getElementById('hermes-ap-form').hidden,
      later: document.getElementById('hermes-ap-later').hidden ? '' : document.getElementById('hermes-ap-later').textContent.replace(/\s+/g, ' ').trim() }));
    check(skipped.formHidden && /Skipped\. You can connect Hermes any time in Agent Providers/.test(skipped.later) && /Connect Hermes now/.test(skipped.later),
      'setup: Skip leaves a note and a way back', JSON.stringify(skipped));
    await page.click('[data-action="hermes-ap-again"]');
    await formReady(page);
    check(await page.evaluate(() => document.getElementById('hermes-ap-later').hidden), 'setup: "Connect Hermes now" mounts the form again');

    // Connect saves through Agent Providers only.
    await page.fill('#hermes-ap-form .apf[data-key="url"]', 'http://hermes.test:9119');
    await page.fill('#hermes-ap-form .apf[data-key="token"]', 'tok-1');
    await page.click('#hermes-ap-form [data-act="submit"]');
    await page.waitForFunction(() => !document.getElementById('hermes-ap-later').hidden);
    await page.waitForFunction(() => !document.getElementById('hermes-ap-existing').hidden);
    const save = state.posts.find(p => p.path === '/api/agent-providers/save');
    check(save && save.body.kind === 'hermes' && save.body.transport === 'serve' && save.body.values.url === 'http://hermes.test:9119',
      'setup: Connect posts /api/agent-providers/save for a hermes serve connection', JSON.stringify(save && save.body));
    const after = await page.evaluate(() => ({ later: document.getElementById('hermes-ap-later').textContent.replace(/\s+/g, ' ').trim(),
      existing: document.getElementById('hermes-ap-existing').textContent }));
    check(/Hermes is connected/.test(after.later) && /Add another Hermes connection/.test(after.later), 'setup: after Connect the step says so', after.later);
    check(/Already connected: Hermes \(Connected, 2 agents\)\. Manage in Agent Providers/.test(after.existing), 'setup: the new connection is listed', after.existing);

    // Finish: nothing else changed, so no hermes section is sent.
    await page.evaluate(() => window.VOSetup.showStep(7));
    const payload = await page.evaluate(() => window.VOSetup.buildPayload());
    const sent = JSON.stringify(payload);
    check(!/"hermes"/.test(sent) && !state.posts.some(p => p.path === '/setup/save'), 'setup: the wizard itself sends no Hermes connection', sent.slice(0, 160));
    check(state.errors.length === 0, 'setup: no page errors', state.errors.join(' | '));
    await context.close();
  }

  // ---- setup: older API server rows + an existing serve connection ---------------------
  {
    const state = newState({ legacy: true, providers: [OPENCLAW, SERVE, LEGACY] });
    const { context, page } = await openPage(state, '/setup.html');
    await page.waitForFunction(() => window.VOSetup && !window.VOSetup.prefill.loading);
    await formReady(page);
    const view = await page.evaluate(() => ({
      legacyHidden: document.getElementById('hermes-legacy').hidden,
      rows: document.querySelectorAll('#s-hermes-connections .hermes-connection').length,
      existing: document.getElementById('hermes-ap-existing').textContent,
      link: (document.querySelector('#hermes-ap-existing a') || {}).getAttribute?.('href') || '',
    }));
    check(!view.legacyHidden && view.rows === 1, 'setup: existing older API server rows stay listed and editable', JSON.stringify(view));
    check(/^Already connected: Hermes \(Connected, 2 agents\)\. Manage in Agent Providers$/.test(view.existing) && view.link === '/providers.html?provider=hermes',
      'setup: connected Hermes is listed with a Manage link (older rows not counted)', view.existing);
    check(state.errors.length === 0, 'setup (legacy): no page errors', state.errors.join(' | '));
    await context.close();
  }

  // ---- setup on a phone --------------------------------------------------------------
  {
    const state = newState({ legacy: true, providers: [OPENCLAW, SERVE, LEGACY] });
    const { context, page } = await openPage(state, '/setup.html', { width: 412, height: 915, mobile: true });
    await page.waitForFunction(() => window.VOSetup && !window.VOSetup.prefill.loading);
    await formReady(page);
    await page.evaluate(() => window.VOSetup.showStep(2));
    const geo = await page.evaluate(() => {
      const section = document.getElementById('hermes-fields').closest('.section');
      return { over: section.scrollWidth - section.clientWidth, doc: document.documentElement.scrollWidth - window.innerWidth };
    });
    check(geo.over <= 1 && geo.doc <= 1, 'setup phone: Hermes step has no sideways scroll', JSON.stringify(geo));
    check(state.errors.length === 0, 'setup phone: no page errors', state.errors.join(' | '));
    await context.close();
  }

  // ---- models.html Hermes tab ---------------------------------------------------------
  {
    const state = newState({ legacy: true, providers: [OPENCLAW, SERVE, SERVE_CHAT, LEGACY] });
    const { context, page } = await openPage(state, '/models.html');
    await page.evaluate(() => { window.__opened = []; window.open = (url, target) => { window.__opened.push([url, target]); return null; }; });
    await page.waitForFunction(() => document.querySelector('#hermes-models [data-ap-id="main"]'));
    const cards = await page.evaluate(() => [...document.querySelectorAll('#hermes-models .card')].map(card => ({
      name: (card.querySelector('.provider-name') || {}).textContent,
      buttons: [...card.querySelectorAll('[data-action="open-ap"]')].map(b => [b.textContent, b.dataset.href]),
      text: card.textContent.replace(/\s+/g, ' ').trim(),
    })));
    const byName = name => cards.find(c => c.name === name) || { buttons: [], text: '' };
    const full = byName('Hermes');
    check(full.buttons.length === 1 && full.buttons[0][0] === 'Change in Agent Providers' && full.buttons[0][1] === '/providers.html?provider=hermes&connection=main&tab=models',
      'models: Full access connection has "Change in Agent Providers"', JSON.stringify(full.buttons));
    check(/Hermes 0\.22\.2 · 2 agents/.test(full.text) && /Connected/.test(full.text), 'models: serve card shows version, agents and state', full.text.slice(0, 120));
    const chat = byName('Lab Hermes');
    check(chat.buttons.length === 0 && /Chat only/.test(chat.text), 'models: Chat only connection has no Change button', chat.text.slice(0, 160));
    const legacy = byName('Astra');
    check(legacy.buttons.length === 1 && legacy.buttons[0][0] === 'Open in Agent Providers' && /switch it to the full Hermes connection/.test(legacy.text) && /m-1/.test(legacy.text),
      'models: older API server card keeps its model and points to the switch', legacy.text.slice(0, 200));
    await page.click('#tab-hermes');
    await page.click('#hermes-models [data-ap-id="main"] [data-action="open-ap"]');
    const opened = await page.evaluate(() => window.__opened);
    check(opened.length === 1 && opened[0][0] === '/providers.html?provider=hermes&connection=main&tab=models' && opened[0][1] === '_blank',
      'models: Change opens Agent Providers in a new tab', JSON.stringify(opened));
    check(state.posts.length === 0, 'models: nothing was posted', state.posts.map(p => p.path).join(','));
    check(state.errors.length === 0, 'models: no page errors', state.errors.join(' | '));
    await context.close();
  }
  {
    const state = newState({ legacy: true, apMissing: true });
    const { context, page } = await openPage(state, '/models.html');
    await page.waitForFunction(() => /Astra/.test(document.getElementById('hermes-models').textContent));
    await page.waitForFunction(() => window.performance.getEntriesByType('resource').some(e => e.name.includes('/api/agent-providers')));
    await page.waitForTimeout(100);
    const view = await page.evaluate(() => ({ buttons: document.querySelectorAll('#hermes-models [data-action="open-ap"]').length,
      text: document.getElementById('hermes-models').textContent.replace(/\s+/g, ' ') }));
    check(view.buttons === 0 && /m-1/.test(view.text), 'models: without Agent Providers the cards stay, with no buttons', view.text.slice(0, 160));
    check(state.errors.length === 0, 'models (no AP): no page errors', state.errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`test_hp_pages_setup: ${passed} checks passed`);
