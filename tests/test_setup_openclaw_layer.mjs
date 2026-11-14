// v0.11 relfix: the setup wizard's OpenClaw step and the office's agent list with the provider layer on.
//
// Headless Chrome through playwright-core against the app files in this tree; every request is answered by the test
// (static files from app/, API fixtures), so no server runs and nothing is saved.
//
// Checks:
//   setup.html, layer on
//   1. a valid OpenClaw folder whose layer connection waits for approval: "OpenClaw folder found" with the agents
//      openclaw.json lists, never "No agents found at this path"; the step shows Agent Providers' card (Waiting for
//      approval, `openclaw devices approve <id>` with Copy, Open Agent Providers) and no "Allow this office" edit;
//   2. Detect runs the gateway test (it hands the saved gateway to the layer) and, once approved, lists the agents;
//   3. Connect with a token saves only that token, clears the field, then tests;
//   4. a folder without openclaw.json says so and shows the tips, and which folder the office reads when it differs;
//   5. phone 412x915: no sideways scroll with the pairing card;
//   setup.html, layer off
//   6. 0.10's path: the roster, "No agents found at this path" when empty, "Allow this office" after agents are found;
//   office agent list (ui-modern.js)
//   7. OpenClaw waiting for approval / offline: said in the list with a link that opens Agent Providers;
//      connected: no note; no provider at all: a link to connect one.
//
// Run: node tests/test_setup_openclaw_layer.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);

function skip(reason) {
  console.log(`SKIP test_setup_openclaw_layer: ${reason}`);
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
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}
const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = findChrome();
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const ORIGIN = 'http://pages.test';
const REQ = '5f0c3a2e-1b2c-4d5e-8f90-123456789abc';
const OC = state => ({ id: 'oc-1', kind: 'openclaw', name: 'OpenClaw', label: 'OpenClaw', enabled: true, access: 'full', status: state, agents: [] });
const PAIRING = OC({ state: 'pairing', requestId: REQ, detail: 'My Virtual Office is waiting to be approved as a device of this gateway.' });
const CONNECTED = { ...OC({ state: 'connected', version: '2026.11.2' }), agents: [{ id: 'a1', name: 'Main' }, { id: 'a2', name: 'Ops' }] };
const OFFLINE = OC({ state: 'offline', detail: 'The gateway is not answering.' });
const FOLDER = { ok: true, path: '/srv/openclaw', found: true, readable: true, layer: true,
  agents: [{ id: 'main', name: 'Main', emoji: '' }, { id: 'ops', name: 'Ops', emoji: '' }] };
const OC_AGENTS = [{ id: 'main', name: 'Main', provider: 'openclaw', role: 'main' }, { id: 'ops', name: 'Ops', provider: 'openclaw', role: 'ops' }];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const LIST_PAGE = `<!doctype html><html><head><link rel="stylesheet" href="/ui-modern.css"></head><body>
<div class="vo-card" data-vo-card="agents" data-open="true"><div class="vo-card-head">Agents</div><ul id="vo-agent-list"></ul></div>
<script>window.agents = [];</script><script src="/ui-modern.js"></script></body></html>`;

function makeRoute(state) {
  return async routeObj => {
    const request = routeObj.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return routeObj.abort();
    const json = (body, status = 200) => routeObj.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    state.gets.push(url.pathname);
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      let body = null;
      try { body = JSON.parse(request.postData() || 'null'); } catch { body = request.postData(); }
      state.posts.push({ path: url.pathname, body });
      return json({ ok: true });
    }
    if (url.pathname === '/t-list.html') return routeObj.fulfill({ status: 200, contentType: TYPES['.html'], body: LIST_PAGE });
    if (url.pathname === '/api/office/provider-layer') return json({ enabled: state.layer, running: state.layer });
    if (url.pathname === '/api/setup/openclaw-folder') return json(state.folder);
    if (url.pathname === '/api/gateway/test') return json(state.gwTest);
    if (url.pathname === '/api/agent-providers') return json({ ok: true, providers: state.providers, manifests: {} });
    if (url.pathname === '/api/agents') return json({ agents: state.agents });
    if (url.pathname === '/vo-config') {
      return json({ version: '0.11.0', setupComplete: false, office: { name: 'Test Office' }, features: {}, weather: { location: null },
        openclaw: { homePath: '/srv/openclaw' }, hermes: { enabled: false, connections: [] }, codex: {}, claudeCode: {}, license: { demo: false } });
    }
    if (url.pathname === '/api/access/status') return json({ protected: false, authenticated: true, viaLoopback: true, canManage: true });
    if (url.pathname === '/api/license') return json({ demo: false, valid: true });
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel);
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
const newState = extra => ({ posts: [], gets: [], errors: [], layer: true, folder: FOLDER, providers: [PAIRING], agents: [],
  gwTest: { via: 'layer', ok: true, gateway: 'reachable', token: true, permission: false, detail: PAIRING.status.detail, agents: 0 }, ...extra });
const text = (page, sel) => page.evaluate(s => (document.querySelector(s) || {}).textContent || '', sel).then(t => t.replace(/\s+/g, ' ').trim());
const hidden = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return !el || el.hidden || !el.offsetParent; }, sel);
async function wizardStep2(state, opts) {
  const { context, page } = await openPage(state, '/setup.html', opts);
  await page.waitForFunction(() => window.VOSetup && !window.VOSetup.prefill.loading);
  await page.evaluate(() => window.VOSetup.showStep(2));
  return { context, page };
}

try {
  // 1 + 2: layer on, valid folder, connection waiting for approval; Detect; approved
  {
    const state = newState();
    const { context, page } = await wizardStep2(state);
    await page.waitForFunction(() => /Waiting for approval/.test(document.getElementById('oc-layer-status').textContent));
    await page.waitForFunction(() => /OpenClaw folder found/.test(document.getElementById('agent-status').textContent));
    const status = await text(page, '#agent-status');
    check(!/No agents found at this path/.test(status) && /lists 2 agents \(Main, Ops\)/.test(status), 'layer: a valid folder is found while pairing', status);
    const card = await text(page, '#oc-layer-status');
    check(card.includes(`openclaw devices approve ${REQ}`) && /Copy/.test(card) && /Open Agent Providers/.test(card), 'layer: the pairing card with the command', card);
    const link = await page.evaluate(() => document.querySelector('#oc-layer-status a').getAttribute('href'));
    check(link === '/providers.html?provider=openclaw', 'layer: the link opens Agent Providers', link);
    check(await hidden(page, '[data-action="configure-gateway"]') && !(await hidden(page, '[data-action="connect-openclaw"]')),
      'layer: no "Allow this office" edit, a Connect button instead');
    check(await hidden(page, '#no-agents-help'), 'layer: no "No agents found" tips for a valid folder');
    check(!state.gets.includes('/api/gateway/test'), 'layer: opening the step does not hand anything over');
    await page.click('[data-action="detect-agents"]');
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(e => e.name.endsWith('/api/gateway/test')));
    check(state.gets.includes('/api/gateway/test'), 'layer: Detect runs the gateway test (hands the saved gateway to the layer)');
    state.providers = [CONNECTED];
    state.agents = [...OC_AGENTS, { id: 'codex-x', name: 'Codex', provider: 'codex' }];
    await page.waitForFunction(() => /Found 2 agents!/.test(document.getElementById('agent-status').textContent), null, { timeout: 8000 });
    const rows = await page.evaluate(() => [...document.querySelectorAll('#agent-preview .agent-row .name')].map(e => e.textContent));
    check(rows.join(',') === 'Main,Ops', 'layer: approved -> the OpenClaw agents are listed', rows.join(','));
    const pill = await text(page, '#oc-layer-status');
    check(/Connected · OpenClaw 2026\.11\.2/.test(pill) && /2 agents connected/.test(pill), 'layer: the pill says connected with the version', pill);
    check(state.posts.length === 0, 'layer: nothing posted (the folder did not change)', state.posts.map(p => p.path).join(','));
    check(state.errors.length === 0, 'layer: no page errors', state.errors.join(' | '));
    await context.close();
  }
  // 3: Connect with a token
  {
    const state = newState({ providers: [] });
    const { context, page } = await wizardStep2(state);
    await page.waitForFunction(() => /No OpenClaw connection yet/.test(document.getElementById('oc-layer-status').textContent));
    await page.fill('#s-gateway-token', 'tok-relfix-0123456789');
    state.providers = [PAIRING];
    await page.click('[data-action="connect-openclaw"]');
    await page.waitForFunction(() => /Waiting for approval/.test(document.getElementById('oc-layer-status').textContent), null, { timeout: 8000 });
    const saves = state.posts.filter(p => p.path === '/setup/save');
    check(saves.length === 1 && JSON.stringify(saves[0].body) === JSON.stringify({ openclaw: { gatewayToken: 'tok-relfix-0123456789' } }),
      'connect: saves only the token, once', JSON.stringify(saves));
    check(await page.inputValue('#s-gateway-token') === '', 'connect: the token field is cleared after saving');
    check(state.gets.includes('/api/gateway/test'), 'connect: then tests the connection');
    check(state.errors.length === 0, 'connect: no page errors', state.errors.join(' | '));
    await context.close();
  }
  // 4: a folder without openclaw.json
  {
    const state = newState({ folder: { ...FOLDER, path: '/openclaw', found: false, readable: false, agents: [] } });
    const { context, page } = await wizardStep2(state);
    await page.waitForFunction(() => /No openclaw\.json in this folder/.test(document.getElementById('agent-status').textContent));
    check(!(await hidden(page, '#no-agents-help')), 'layer: a folder without openclaw.json shows the tips');
    check(/The office reads OpenClaw from \/openclaw/.test(await text(page, '#agent-status')), 'layer: says which folder the office reads (VO_OPENCLAW_PATH wins)');
    await context.close();
  }
  // 5: phone
  {
    const state = newState();
    const { context, page } = await wizardStep2(state, { width: 412, height: 915, mobile: true });
    await page.waitForFunction(() => /Waiting for approval/.test(document.getElementById('oc-layer-status').textContent));
    const wide = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth,
      card: Math.round(document.getElementById('oc-layer-status').getBoundingClientRect().right) }));
    check(wide.sw <= wide.w && wide.card <= wide.w, 'phone 412: no sideways scroll with the pairing card', JSON.stringify(wide));
    await context.close();
  }
  // 6: layer off: 0.10's path unchanged
  {
    const state = newState({ layer: false });
    const { context, page } = await wizardStep2(state);
    await page.waitForFunction(() => /No agents found at this path/.test(document.getElementById('agent-status').textContent));
    check(await hidden(page, '#oc-layer-status') && !state.gets.includes('/api/setup/openclaw-folder'), 'layer off: the roster path, no layer pieces');
    state.agents = OC_AGENTS;
    await page.click('[data-action="detect-agents"]');
    await page.waitForFunction(() => /Found 2 agents!/.test(document.getElementById('agent-status').textContent));
    check(!(await hidden(page, '[data-action="configure-gateway"]')) && await hidden(page, '[data-action="connect-openclaw"]'),
      'layer off: "Allow this office" stays (0.10 path)');
    await context.close();
  }
  // 7: the office's agent list
  for (const [name, providers, want, link] of [
    ['waiting for approval', [PAIRING], /OpenClaw is waiting for approval: approve this office in OpenClaw once/, true],
    ['offline', [OFFLINE], /OpenClaw is offline: The gateway is not answering\. Open Agent Providers/, true],
    ['connected', [CONNECTED], /^No agents yet\. Agents appear here when your providers report them\.$/, false],
    ['no provider', [], /No agents yet\. Connect an agent provider \(OpenClaw, Hermes, Claude Code, Codex or another\)/, true],
  ]) {
    const state = newState({ providers });
    const { context, page } = await openPage(state, '/t-list.html');
    await page.waitForFunction(() => document.getElementById('vo-agent-list').children.length > 0, null, { timeout: 5000 });
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(e => e.name.endsWith('/api/agent-providers')));
    await page.waitForTimeout(300);
    const list = await text(page, '#vo-agent-list');
    check(want.test(list), `office list, ${name}: ${want}`, list);
    const a = await page.evaluate(() => { const el = document.querySelector('#vo-agent-list a[data-ap-manage]'); return el ? [el.getAttribute('href'), el.dataset.apManage] : null; });
    check(link ? (a && a[0] === '/providers.html?provider=openclaw' && a[1] === 'openclaw') : !a, `office list, ${name}: ${link ? 'links to Agent Providers' : 'no link'}`, JSON.stringify(a));
    check(state.errors.length === 0, `office list, ${name}: no page errors`, state.errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`test_setup_openclaw_layer: ${passed} checks passed`);
