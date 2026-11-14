// Shared helpers for the v0.10 office editor browser tests (test_v10_editor_*.mjs).
//
// Every request is answered here: static files from this tree's app/, small API
// fixtures, office-config POSTs recorded and answered 200 (or failed on request).
// Nothing reaches a server, so nothing is ever saved.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);
const ORIGIN = 'http://office.test';

export function skip(name, reason) {
  console.log(`SKIP ${name}: ${reason}`);
  process.exit(0);
}

export function loadPlaywright() {
  for (const candidate of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
    try { return require(candidate); } catch { /* try next */ }
  }
  return null;
}

export function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

export function officeFixture() {
  return {
    canvasWidth: 1040, canvasHeight: 760,
    walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#5d6271', accentColor: '#3f4a5c', trimColor: '#d2d4da' },
      sections: [{ x: 0, w: 1040, color: '#5d6271', accentColor: '#3f4a5c' }],
      interior: [{ x1: 20, y1: 10, x2: 20, y2: 16, color: '#5d6271', accentColor: '#5d6271', trimColor: '#d2d4da', trim2Color: '#989ca8' }] },
    floor: { color1: '#c8c3b8', color2: '#bdb7ab' },
    furniture: [
      { id: 'd1', type: 'desk', x: 560, y: 250, assignedTo: 'Alpha' },
      { id: 'c1', type: 'couch', x: 600, y: 560 },
      { id: 'k1', type: 'kitchenCounter', x: 840, y: 200 },
      { id: 'p1', type: 'plant', x: 900, y: 420 },
    ],
    branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
    agents: [],
    pet: { enabled: false },
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

// Launch Chrome or print SKIP and exit 0.
export async function launch(name) {
  const playwright = loadPlaywright();
  if (!playwright) skip(name, 'playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
  const chromePath = findChrome();
  if (!chromePath) skip(name, 'Chrome/Chromium was not found (set CHROME_PATH)');
  return playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
}

// Open the office in edit-ready state. opts: { width, height, mobile, office, failSave, layouts, agents, status, fixtures }
export async function openEditor(browser, opts = {}) {
  const office = opts.office || officeFixture();
  const saves = [];
  const fixtures = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: opts.agents || [{ id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }] },
    '/status': opts.status || { alpha: { state: 'idle', task: '' } },
    '/agent-chat': {},
    '/api/office-config': office,
    '/weather-proxy': { current_condition: [], configured: false },
    '/api/layouts': opts.layouts || { layouts: [] },
  };
  Object.assign(fixtures, opts.fixtures || {});   // extra GET fixtures (e.g. Office Life state)
  const size = { width: opts.width || 1600, height: opts.height || 900 };
  const options = { viewport: size };
  if (opts.mobile) Object.assign(options, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const context = await browser.newContext(options);
  await context.route('**/*', async (routeObj) => {
    const request = routeObj.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return routeObj.abort();
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      if (url.pathname === '/api/office-config') {
        saves.push({ at: Date.now(), body: request.postData() });
        if (opts.failSave) return routeObj.abort();
      }
      return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (opts.layoutAssets && url.pathname.startsWith('/api/layouts/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/layouts/'.length));
      const asset = opts.layoutAssets[id];
      return routeObj.fulfill({ status: asset ? 200 : 404, contentType: 'application/json', body: JSON.stringify(asset || { error: 'not found' }) });
    }
    if (Object.prototype.hasOwnProperty.call(fixtures, url.pathname)) {
      return routeObj.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname]) });
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel);
    const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return routeObj.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    }
    return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.toggleEditMode === 'function' && window.officeConfig &&
    window.officeConfig.furniture && window.officeConfig.furniture.some(f => f.id === 'd1'), null, { timeout: 30000 });
  await page.evaluate(() => { window._voLicense = Object.assign(window._voLicense || {}, { demo: false }); });
  // The editor UI loads on first use (Q-13): load it before the tests drive it.
  await page.evaluate(() => new Promise(r => (window._voLazyLoad ? window._voLazyLoad('editor', r) : r())));
  await page.waitForTimeout(300);
  if (opts.edit !== false) {
    await page.evaluate(() => { if (!editMode) toggleEditMode(); });
    await page.waitForTimeout(400);
  }
  return { context, page, saves, errors };
}

// World point -> client point.
export function toScreen(page, wx, wy) {
  return page.evaluate(([x, y]) => {
    const z = getBaseScale() * camera.zoom;
    const r = canvas.getBoundingClientRect();
    const dx = (x - W / 2 - camera.x) * z + displayW / 2;
    const dy = (y - H / 2 - camera.y) * z + displayH / 2;
    return { x: r.left + dx * r.width / displayW, y: r.top + dy * r.height / displayH };
  }, [wx, wy]);
}

export function makeChecker(name) {
  const results = [];
  return {
    ok(cond, label, detail) {
      if (!cond) { console.log(`[FAIL] ${label}${detail ? ': ' + detail : ''}`); results.push(false); }
      else { console.log(`[PASS] ${label}`); results.push(true); }
    },
    done() {
      const failed = results.filter(r => !r).length;
      if (failed) { console.log(`${name}: ${failed} of ${results.length} checks FAILED`); process.exit(1); }
      console.log(`${name}: all ${results.length} checks passed`);
    }
  };
}
