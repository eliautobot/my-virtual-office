// Shared hermetic harness for the v0.10 Agent Studio tests (not a test itself:
// run_all.sh skips *_lib.mjs).
//
// Serves app/ from this tree to headless Chrome through playwright-core. Every
// API answer is a fixture; every write (POST/PUT/DELETE) gets a fake 200 and is
// recorded in `writes`, so Save and Create can be tested without any server.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);

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
  return candidates.find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

export const ORIGIN = 'http://office.test';

export function fixtures() {
  return {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: [
      { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true },
      { id: 'beta', statusKey: 'beta', name: 'Beta', emoji: '🦊', role: 'Writer', providerKind: 'hermes', available: true },
      { id: 'gamma', statusKey: 'gamma', name: 'Gamma', emoji: '🐙', role: 'Coder', providerKind: 'codex', available: true },
    ] },
    '/agents-list': { agents: [
      { key: 'alpha', agentId: 'alpha', name: 'Alpha', emoji: '🤖' },
      { key: 'beta', agentId: 'beta', name: 'Beta', emoji: '🦊' },
      { key: 'gamma', agentId: 'gamma', name: 'Gamma', emoji: '🐙' },
    ] },
    '/api/agent-platforms': { platforms: [
      { id: 'openclaw', label: 'OpenClaw', available: true, create: true },
      { id: 'hermes', label: 'Hermes', available: true, create: true },
    ] },
    '/status': { alpha: { state: 'idle', task: '' }, beta: { state: 'working', task: 'Writing' }, gamma: { state: 'idle', task: '' } },
    '/api/office-config': {
      canvasWidth: 1040, canvasHeight: 740,
      walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' },
        sections: [{ x: 0, w: 1040, color: '#37474f', accentColor: '#263238' }], interior: [] },
      floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
      furniture: [
        { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' },
        { id: 'd2', type: 'desk', x: 320, y: 220, assignedTo: 'Beta' },
        { id: 'd3', type: 'desk', x: 160, y: 380, assignedTo: 'Gamma' },
        { id: 'd4', type: 'desk', x: 480, y: 380 },
        { id: 'p1', type: 'plant', x: 900, y: 140 },
      ],
      branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
      agents: [
        // A saved v0.9 look: M body, no v0.10 fields.
        { id: 'alpha', name: 'Alpha', role: 'Tester', emoji: '🤖', color: '#1e88e5', gender: 'M', branch: 'HQ',
          appearance: { skinTone: '#d4a574', hairStyle: 'spiky', hairColor: '#1a1a1a', hairHighlight: null, eyebrowStyle: 'thick',
            eyeColor: '#212121', facialHair: null, facialHairColor: null, headwear: 'crown', headwearColor: '#ffd700',
            glasses: null, glassesColor: null, costume: null, heldItem: null, deskItem: 'trophy' } },
        { id: 'beta', name: 'Beta', role: 'Writer', emoji: '🦊', color: '#e53935', gender: 'F', branch: 'HQ',
          appearance: { skinTone: '#8d5524', hairStyle: 'long', hairColor: '#3e2723', hairHighlight: null, eyebrowStyle: 'thin',
            eyeColor: '#2e7d32', facialHair: null, facialHairColor: null, headwear: null, headwearColor: null,
            glasses: 'round', glassesColor: '#333333', costume: null, heldItem: 'book', deskItem: 'files' } },
      ],
      pet: { enabled: false },
    },
    '/weather-proxy': { current_condition: [], configured: false },
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

// opts.writeReply(pathname, body) may return {status, body} to fake a server answer.
export function makeRouter(fx, writes, opts = {}) {
  return async function route(routeObj) {
    const request = routeObj.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return routeObj.abort();
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
      let body = null;
      try { body = JSON.parse(request.postData() || 'null'); } catch { body = request.postData(); }
      writes.push({ method: request.method(), path: url.pathname, body, at: Date.now() });
      const custom = opts.writeReply ? await opts.writeReply(url.pathname, body) : null;
      if (custom) {
        return routeObj.fulfill({ status: custom.status || 200, contentType: 'application/json', body: JSON.stringify(custom.body || {}) });
      }
      return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (Object.prototype.hasOwnProperty.call(fx, url.pathname)) {
      return routeObj.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx[url.pathname]) });
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

export async function launch(name) {
  const playwright = loadPlaywright();
  if (!playwright) skip(name, 'playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
  const chromePath = findChrome();
  if (!chromePath) skip(name, 'Chrome/Chromium was not found (set CHROME_PATH)');
  return playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
}

// Open the office (desktop 1600x900 or phone 412x915) with the studio ready.
export async function openStudio(browser, { phone = false, theme = null, fx = fixtures(), writeReply = null } = {}) {
  const options = phone
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }
    : { viewport: { width: 1600, height: 900 } };
  const context = await browser.newContext(options);
  const writes = [];
  await context.route('**/*', makeRouter(fx, writes, { writeReply }));
  if (theme) {
    await context.addInitScript(t => { try { localStorage.setItem('vo-ui-theme', t); } catch (e) {} }, theme);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length === 3 && window.VOOffice && window._serverConfigLoaded !== false,
    null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => { if (window._voLicense) window._voLicense.demo = false; });
  // The studio loads on first use (Q-13): load it before the tests drive it.
  await page.evaluate(() => new Promise(r => (window._voLazyLoad ? window._voLazyLoad('studio', r) : r())));
  return { context, page, writes, errors };
}

export async function showStudio(page, agentId = 'alpha') {
  await page.evaluate(id => {
    if (!document.getElementById('agent-creator-panel') || !document.getElementById('agent-creator-panel').classList.contains('visible')) {
      toggleAgentPanel();
    }
    if (window._agentPanelSelectedId !== id) _acpSelectAgent(id);
  }, agentId);
  await page.waitForTimeout(150);
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
