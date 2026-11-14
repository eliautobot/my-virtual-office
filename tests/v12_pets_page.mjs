// Shared harness for the v0.12 pet tests: serves this tree's app/ on
// http://office.test with fixture APIs (no network, no live office) and opens
// the office in headless Chrome. Same pattern as tests/test_v10_pets.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP = process.env.VO_APP_DIR ? path.resolve(process.env.VO_APP_DIR) : path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);
export const ORIGIN = 'http://office.test';

export function skip(name, reason) {
  console.log(`SKIP ${name}: ${reason}`);
  process.exit(0);
}

export function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
    try { return require(c); } catch { /* next */ }
  }
  return null;
}

export function findChrome() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

export function defaultOffice() {
  return JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };

// fixtures: { office, agents: [{id, name, ...}], status: {key: {state, task}} }; posts collects POST bodies.
export function makeRoute(fixtures, posts) {
  const agents = fixtures.agents || [{ id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }];
  const status = fixtures.status || Object.fromEntries(agents.map(a => [a.statusKey || a.id, { state: 'idle', task: '' }]));
  const F = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.12.0', office: { name: 'Pet Test' }, features: {}, weather: { location: null } },
    '/api/agents': { agents },
    '/status': status,
    '/agent-chat': {},
    '/api/office-config': fixtures.office || defaultOffice(),
    '/weather-proxy': { current_condition: [], configured: false },
    ...(fixtures.extra || {}),   // v0.13: more fixture APIs (e.g. '/api/office-life/state')
  };
  return async (routeObj) => {
    const request = routeObj.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return routeObj.abort();
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      if (posts) posts.push({ path: url.pathname, body: request.postData() });
      return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (Object.prototype.hasOwnProperty.call(F, url.pathname)) {
      return routeObj.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(F[url.pathname]) });
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel);
    const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return routeObj.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    }
    return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  };
}

// Opens the office; returns { browser, page, errors, posts, close }.
export async function openOffice(name, fixtures = {}, viewport = { width: 1600, height: 900 }) {
  const playwright = loadPlaywright();
  if (!playwright) skip(name, 'playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
  const chromePath = findChrome();
  if (!chromePath) skip(name, 'Chrome/Chromium was not found (set CHROME_PATH)');
  const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport, reducedMotion: fixtures.reducedMotion ? 'reduce' : 'no-preference' });
  const posts = [];
  await context.route('**/*', makeRoute(fixtures, posts));
  // fixtures.seed: seeded Math.random, a virtual clock (window.__vAdvance(ms)) and the world invariant on every step,
  // as tests/test_v11_kitchen_walk.mjs does.
  // fixtures.manual (v0.12 polish): the test alone moves the world. The page's own frame loop and its interval
  // timers never run and the clock moves only by __vAdvance, so a seed gives the same run every time.
  if (fixtures.seed != null) await context.addInitScript(([seed, manual]) => {
    const R = Date, base = new R(2026, 10, 4, 10, 0, 0).getTime(), t0 = R.now(); let off = 0;
    const now = manual ? () => base + off : () => base + (R.now() - t0) + off; window.__vAdvance = (ms) => { off += ms; };
    if (manual) { window.requestAnimationFrame = () => 0; window.setInterval = () => 0; }
    class VD extends R { constructor(...a) { if (a.length === 0) super(now()); else super(...a); } static now() { return now(); } }
    window.Date = VD; let s = seed >>> 0; window.__vReseed = (n) => { s = n >>> 0; };
    Math.random = function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__voWorldCheck = 'every';
  }, [fixtures.seed, !!fixtures.manual]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length > 0 && window.VOOffice, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  // manual: boot finished (no requests in flight) and the same random sequence from here, whatever order the
  // fixture responses arrived in.
  if (fixtures.manual) { await page.waitForLoadState('networkidle'); await page.evaluate((n) => window.__vReseed(n), fixtures.seed); }
  return { browser, page, errors, posts, close: () => browser.close() };
}

export function checker() {
  const state = { failures: 0 };
  state.check = async (name, fn) => {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { state.failures++; console.log(`not ok - ${name}: ${String(e && e.message || e).split('\n')[0].slice(0, 300)}`); }
  };
  return state;
}
