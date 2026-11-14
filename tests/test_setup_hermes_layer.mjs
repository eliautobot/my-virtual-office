// 0.12.0 fix: the setup wizard's Hermes step with the provider layer on (the default) connects the way Settings >
// Connections > Add provider > Hermes does, and a request the office does not answer is described truthfully.
//
// Headless Chrome through playwright-core against the app files in this tree; every request is answered by the test.
// The layer's answers follow app/provider-layer/server/provider-routes.mjs; its Hermes kind is the real manifest
// (BUILTIN_MANIFESTS), served the way GET /api/agent-providers serves it ({ providers, kinds, host }, no manifests).
//
// Checks:
//   layer on
//   1. the form shows the layer's Hermes fields and no Test button (the layer tests only a saved connection);
//   2. Connect: POST /api/connections with the page's CSRF token ({ kind, label, scope, config, secrets }: secrets only
//      the typed credential, the hidden token not sent), then POST /api/connections/test of that connection; the step
//      says Hermes is connected; the password field is cleared; nothing goes to /api/agent-providers/test or /save;
//   3. Hermes refuses: its own reason and fix are shown, the connection just made is removed (nothing half-made stays),
//      the typed address stays and a second Connect works;
//   4. the layer refuses the values (400 { error, code }): its sentence is shown;
//   5. Find: the layer's detect (a list of addresses) is offered with Use, which fills the address;
//   layer off
//   6. 0.10's path is unchanged: Test posts /api/agent-providers/test, Connect /api/agent-providers/save;
//   7. a 404 without a message of its own never tells an up-to-date person to update the office.
//
// Run: node tests/test_setup_hermes_layer.mjs   (PLAYWRIGHT_CORE_PATH / CHROME_PATH if not found)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);
function skip(reason) { console.log(`SKIP test_setup_hermes_layer: ${reason}`); process.exit(0); }
function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) { try { return require(c); } catch { /* next */ } }
  return null;
}
function findChrome() {
  return [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .filter(Boolean).find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}
const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = findChrome();
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const { BUILTIN_MANIFESTS } = await import(pathToFileURL(path.join(APP, 'provider-layer/server/providers/manifest.js')).href);
const HERMES = BUILTIN_MANIFESTS.find(m => m.id === 'hermes');
const LAYER_KIND = { ...HERMES, fields: HERMES.fields.filter(f => !f.system), addable: true };
const CSRF = 'csrf-test-token-1';
const ORIGIN = 'http://pages.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function makeRoute(state) {
  return async routeObj => {
    const request = routeObj.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return routeObj.abort();
    const json = (body, status = 200) => routeObj.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (request.method() === 'POST') {
      let body = null;
      try { body = JSON.parse(request.postData() || 'null'); } catch { body = request.postData(); }
      state.posts.push({ path: p, body, csrf: request.headers()['x-csrf-token'] || '' });
      if (state.layer) {
        // (the layer: every POST needs the session's CSRF token; answers { error: sentence, code })
        if (['/api/connections', '/api/connections/test', '/api/connections/remove', '/api/agent-providers/detect'].includes(p)
            && request.headers()['x-csrf-token'] !== CSRF) return json({ error: 'The page\'s security token is missing', code: 'csrf' }, 403);
        if (p === '/api/connections') {
          if (state.createRefusal) return json(state.createRefusal, 400);
          state.nextId += 1;
          const c = { id: state.nextId, kind: body.kind, label: body.label, scope: body.scope, config: body.config, enabled: true };
          state.made.push(c);
          return json(c);
        }
        if (p === '/api/connections/test') return json(state.testAnswers.length > 1 ? state.testAnswers.shift() : state.testAnswers[0]);
        if (p === '/api/connections/remove') { state.made = state.made.filter(c => c.id !== body.id); return json({ removed: body.id }); }
        if (p === '/api/agent-providers/detect') return json({ found: ['http://127.0.0.1:9119'] });
        return json({ error: 'Not found', code: 'not_found' }, 404);   // (the layer's router: /api/agent-providers/test, /save)
      }
      if (p === '/api/agent-providers/test') return state.legacy404 ? routeObj.fulfill({ status: 404, contentType: 'text/html', body: '<h1>404</h1>' })
        : json({ ok: true, version: '0.12.0', profiles: ['default'] });
      if (p === '/api/agent-providers/save') return json({ ok: true, id: 'hermes-1' });
      return json({ ok: true });
    }
    if (p === '/api/office/provider-layer') return json({ enabled: state.layer, running: state.layer, nodeOk: true });
    if (p === '/api/pl/me') return json({ account: { id: 1, login: 'owner' }, role: 'owner', caps: ['connections.use', 'connections.manage'], csrf: CSRF });
    if (p === '/api/agent-providers') {
      if (state.layer) return json({ providers: state.made.map(c => ({ ...c, status: { state: 'connected' }, agents: [] })), kinds: [LAYER_KIND], host: { running: true } });
      return json({ ok: true, providers: [], manifests: {} });
    }
    if (p === '/vo-config') {
      return json({ version: '0.12.0', setupComplete: false, office: { name: 'Test Office' }, features: {}, weather: { location: null },
        openclaw: {}, hermes: { enabled: false, connections: [] }, codex: {}, claudeCode: {}, license: { demo: false } });
    }
    if (p === '/api/access/status') return json({ protected: false, authenticated: true, viaLoopback: true, canManage: true });
    if (p === '/api/license') return json({ demo: false, valid: true });
    const file = path.resolve(APP, decodeURIComponent(p.replace(/^\/+/, '')));
    if (file.startsWith(APP + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return routeObj.fulfill({ status: 200, contentType: TYPES[path.extname(file)], body: fs.readFileSync(file) });
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
const CONNECTED = { ok: true, state: 'connected', detail: 'Connected to Hermes 0.12.0', version: '0.12.0' };
const REFUSED = { ok: false, state: 'error', code: 'auth', error: 'Hermes refused this username and password', fix: 'Check HERMES_DASHBOARD_BASIC_AUTH_USERNAME and _PASSWORD.' };
const newState = extra => ({ posts: [], errors: [], layer: true, made: [], nextId: 6, testAnswers: [CONNECTED], createRefusal: null, legacy404: false, ...extra });
const norm = t => String(t || '').replace(/\s+/g, ' ').trim();
const text = (page, sel) => page.evaluate(s => (document.querySelector(s) || {}).textContent || '', sel).then(norm);
const shown = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return !!(el && !el.hidden && el.offsetParent); }, sel);
const F = '#hermes-ap-form';
async function hermesStep(state) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.route('**/*', makeRoute(state));
  const page = await context.newPage();
  page.on('pageerror', e => state.errors.push(String(e && e.message || e)));
  await page.goto(`${ORIGIN}/setup.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.VOSetup && !window.VOSetup.prefill.loading);
  await page.evaluate(() => window.VOSetup.showStep(2));
  if (!(await page.isChecked('#s-hermes-enable'))) await page.check('#s-hermes-enable');
  await page.waitForSelector(`${F} .apf[data-key="url"]`, { timeout: 8000 });
  return { context, page };
}
async function fillPassword(page, { name = 'Home Hermes', url = 'http://192.0.2.10:9119', user = 'hermes', pass = 'pw-1' } = {}) {
  await page.fill(`${F} .apf[data-key="name"]`, name);
  await page.fill(`${F} .apf[data-key="url"]`, url);
  await page.selectOption(`${F} .apf[data-key="auth"]`, 'password');
  await page.fill(`${F} .apf[data-key="username"]`, user);
  await page.fill(`${F} .apf[data-key="password"]`, pass);
}
const status = page => text(page, `${F} .ap-form-status`);
const oldPaths = state => state.posts.filter(x => x.path === '/api/agent-providers/test' || x.path === '/api/agent-providers/save').length;

try {
  // ---------------------------------------------------------------- layer on: connects
  {
    const state = newState();
    const { context, page } = await hermesStep(state);
    const keys = await page.$$eval(`${F} .apf`, els => els.map(e => e.dataset.key));
    check(['url', 'auth', 'token', 'username', 'password', 'access'].every(k => keys.includes(k)), '1 layer on: the Hermes fields are shown', keys.join(','));
    check(!(await shown(page, `${F} [data-act="test"]`)), '1 layer on: no Test button (the layer tests a saved connection)');
    await fillPassword(page);
    await page.click(`${F} [data-act="submit"]`);
    await page.waitForFunction(() => !document.getElementById('hermes-ap-later').hidden, null, { timeout: 8000 }).catch(() => {});
    const create = state.posts.find(x => x.path === '/api/connections');
    check(!!create, '2 Connect posts /api/connections (as Settings > Add provider)', JSON.stringify(state.posts.map(x => x.path)));
    check(create.csrf === CSRF, '2 with the page\'s CSRF token');
    check(create.body.kind === 'hermes' && create.body.label === 'Home Hermes' && create.body.scope === 'installation', '2 kind, label, scope', JSON.stringify({ k: create.body.kind, l: create.body.label, s: create.body.scope }));
    check(create.body.config.url === 'http://192.0.2.10:9119' && create.body.config.auth === 'password' && create.body.config.username === 'hermes' && create.body.config.access === 'full',
      '2 config: address, sign-in, username, access', JSON.stringify(Object.keys(create.body.config)));
    check(create.body.secrets.password === 'pw-1' && !('token' in create.body.secrets) && !('password' in create.body.config), '2 secrets: the password only, never in config');
    const test = state.posts.find(x => x.path === '/api/connections/test');
    check(test && test.body.id === 7 && test.csrf === CSRF, '2 then the layer tests that connection');
    check(oldPaths(state) === 0, '2 nothing goes to /api/agent-providers/test or /save');
    check(/Hermes is connected/.test(await text(page, '#hermes-ap-later-text')), '2 the step says Hermes is connected', await text(page, '#hermes-ap-later-text'));
    check(state.made.length === 1, '2 one connection kept');
    check(state.errors.length === 0, '2 no page errors', state.errors.join(' | '));
    await context.close();
  }
  // ---------------------------------------------------------------- layer on: Hermes refuses, then works
  {
    const state = newState({ testAnswers: [REFUSED, CONNECTED] });
    const { context, page } = await hermesStep(state);
    await fillPassword(page, { pass: 'wrong' });
    await page.click(`${F} [data-act="submit"]`);
    await page.waitForFunction(() => /refused/.test(document.querySelector('#hermes-ap-form .ap-form-status')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    const s = await status(page);
    check(/Hermes refused this username and password/.test(s) && /HERMES_DASHBOARD_BASIC_AUTH_USERNAME/.test(s), '3 Hermes\' own reason and fix are shown', s);
    check(!/Update the office/i.test(s), '3 not told to update the office');
    const removed = state.posts.find(x => x.path === '/api/connections/remove');
    check(removed && removed.body.id === 7 && state.made.length === 0, '3 the connection just made is removed');
    check((await page.inputValue(`${F} .apf[data-key="url"]`)) === 'http://192.0.2.10:9119', '3 the typed address stays');
    check(await shown(page, F) && (await page.evaluate(() => document.getElementById('hermes-ap-later').hidden)), '3 the form stays open');
    await page.fill(`${F} .apf[data-key="password"]`, 'pw-1');
    await page.click(`${F} [data-act="submit"]`);
    await page.waitForFunction(() => !document.getElementById('hermes-ap-later').hidden, null, { timeout: 8000 }).catch(() => {});
    check(/Hermes is connected/.test(await text(page, '#hermes-ap-later-text')) && state.made.length === 1, '3 a second Connect works');
    check(oldPaths(state) === 0 && state.errors.length === 0, '3 no old endpoints, no page errors', state.errors.join(' | '));
    await context.close();
  }
  // ---------------------------------------------------------------- layer on: the layer refuses the values; Find
  {
    const state = newState({ createRefusal: { error: 'Hermes address must start with http:// or https://', code: 'bad_setting' } });
    const { context, page } = await hermesStep(state);
    await fillPassword(page);
    await page.click(`${F} [data-act="submit"]`);
    await page.waitForFunction(() => /must start/.test(document.querySelector('#hermes-ap-form .ap-form-status')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    check(/Hermes address must start with http:\/\/ or https:\/\//.test(await status(page)), '4 the layer\'s own sentence is shown', await status(page));
    await page.click(`${F} [data-act="find"]`);
    await page.waitForSelector(`${F} [data-act="use-found"]`, { timeout: 8000 }).catch(() => {});
    const det = state.posts.find(x => x.path === '/api/agent-providers/detect');
    check(det && det.csrf === CSRF, '5 Find asks the layer (with the CSRF token)');
    check(/127\.0\.0\.1:9119/.test(await text(page, `${F} .ap-found`)), '5 the found address is offered', await text(page, `${F} .ap-found`));
    await page.fill(`${F} .apf[data-key="url"]`, '');
    await page.click(`${F} [data-act="use-found"]`);
    check((await page.inputValue(`${F} .apf[data-key="url"]`)) === 'http://127.0.0.1:9119', '5 Use fills the address');
    check(state.errors.length === 0, '5 no page errors', state.errors.join(' | '));
    await context.close();
  }
  // ---------------------------------------------------------------- layer off: 0.10's path; a bare 404
  {
    const state = newState({ layer: false });
    const { context, page } = await hermesStep(state);
    check(await shown(page, `${F} [data-act="test"]`), '6 layer off: Test is there');
    await page.fill(`${F} .apf[data-key="token"]`, 'tok-1');
    await page.click(`${F} [data-act="test"]`);
    await page.waitForFunction(() => /Nothing was saved/.test(document.querySelector('#hermes-ap-form .ap-form-status')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
    check(state.posts.some(x => x.path === '/api/agent-providers/test'), '6 layer off: Test posts /api/agent-providers/test');
    await page.click(`${F} [data-act="submit"]`);
    await page.waitForFunction(() => !document.getElementById('hermes-ap-later').hidden, null, { timeout: 8000 }).catch(() => {});
    check(state.posts.some(x => x.path === '/api/agent-providers/save') && !state.posts.some(x => x.path === '/api/connections'), '6 layer off: Connect posts /api/agent-providers/save');
    await context.close();
  }
  {
    const state = newState({ layer: false, legacy404: true });
    const { context, page } = await hermesStep(state);
    await page.fill(`${F} .apf[data-key="token"]`, 'tok-1');
    await page.click(`${F} [data-act="test"]`);
    await page.waitForFunction(() => (document.querySelector('#hermes-ap-form .ap-form-status')?.className || '').includes('error'), null, { timeout: 8000 }).catch(() => {});
    const s = await status(page);
    check(s && !/Update the office/i.test(s) && !/does not offer that yet/i.test(s), '7 a bare 404 does not say "update the office"', s);
    check(/not found|did not recognise|no such/i.test(s), '7 it says the request was not found', s);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`test_setup_hermes_layer: ${passed} checks passed`);
