// Sheet (v0.13 sleeppose): asleep at a desk in the 4 views, before (SHEET_BASE_GAME) / after, awake for comparison.
// Run: SHEET_BASE_GAME=/tmp/base-game.js node tests/sheets_v13_sleeppose.mjs out.jpg  (needs playwright-core and Chrome)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app'); // before rows: SHEET_BASE_GAME=<a game.js from the base, e.g. git show 161b407:app/game.js>
const require = createRequire(import.meta.url);
let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { failures++; console.log(`not ok - ${name}: ${String(e && e.message || e).split('\n')[0].slice(0, 300)}`); }
}
// ===================== browser harness (copied from test_v12_face) =====================
function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean);
  for (const candidate of candidates) {
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
const chromePath = findChrome();
const noBrowser = !playwright ? 'playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)' : !chromePath ? 'Chrome/Chromium was not found (set CHROME_PATH)' : '';

const ORIGIN = 'http://office.test';
const DEFAULT_CFG = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
const OFFICE = Object.assign({}, DEFAULT_CFG, {
  furniture: (DEFAULT_CFG.furniture || []).concat([
    { id: 't-fridge', type: 'fridge', x: 40, y: 600 },
    { id: 't-unknown', type: 'retiredThing', x: 120, y: 600 },
  ]),
});
const FIXTURES = {
  '/api/license': { demo: false, valid: true, limits: {} },
  '/vo-config': { version: '0.10.0', office: { name: 'Moves Test' }, features: {}, weather: { location: null } },
  '/api/agents': { agents: [
    { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true },
    { id: 'beta', statusKey: 'beta', name: 'Beta', emoji: '🦊', role: 'Tester', providerKind: 'hermes', available: true },
  ] },
  '/status': { alpha: { state: 'working', task: 'Testing' }, beta: { state: 'idle', task: '' } },
  '/agent-chat': {},
  '/api/office-config': OFFICE,
  '/weather-proxy': { current_condition: [], configured: false },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };

async function route(routeObj) {
  const request = routeObj.request();
  const url = new URL(request.url());
  if (url.origin !== ORIGIN) return routeObj.abort();
  if (request.method() !== 'GET' && request.method() !== 'HEAD') {
    return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  }
  if (Object.prototype.hasOwnProperty.call(FIXTURES, url.pathname)) {
    return routeObj.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES[url.pathname]) });
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const file = path.resolve(APP, rel);
  const ext = path.extname(file);
  if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return routeObj.fulfill({ status: 200, contentType: TYPES[ext], body: (globalThis.__BASE && rel === 'game.js') ? fs.readFileSync(process.env.SHEET_BASE_GAME) : fs.readFileSync(file) });
  }
  // Any other API: an empty but valid answer.
  return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
}




// v13 sleeppose sheet: before (161b407) / after, asleep at a desk in the 4 views, awake for comparison.
const ROWS = [
  ['before: offline (dozing)', true, 'desk', 'offline', 0], ['before: Office life snooze', true, 'desk', 'snooze', 0],
  ['after: offline (dozing)', false, 'desk', 'offline', 0], ['after: snooze', false, 'desk', 'snooze', 0],
  ['after: boss desk, offline (other agent)', false, 'bossDesk', 'offline', 1], ['awake: typing (comparison)', false, 'desk', 'awake', 0],
];
const S = 2, B = { x: 236, y: 224, w: 128, h: 112 };
async function rows(base) {
  globalThis.__BASE = base;
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.route('**/*', route);
  const page = await context.newPage();
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length > 1 && window.VOOffice, null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const out = await page.evaluate(({ list, S, B }) => list.map(([, , type, mode, ai]) => [0, 90, 180, 270].map(rot => {
    const item = { id: 'sh', type, x: 300, y: 300, rotation: rot }, a = agents[ai], keep = officeConfig.furniture;
    officeConfig.furniture = [item];
    a.appearance = Object.assign({}, getDefaultAppearance(a), { costume: null, heldItem: null });
    Object.assign(a, { isSitting: true, idleAction: null, meetingId: null, carryItem: null, _lifeCarry: null, _lifeExtra: false, _seatCache: null, _seatT: 1,
      _seatFrom: null, _forceView: null, _lastSeat: null, _swv: null, _dIdle: null, notify: false, waitingApprovalCount: 0, activeToolCount: 0,
      _activityFrame: -1, _react: null, _sigMove: null, _slk: null, tick: 40, _offlineSprites: null, _offlinePass: false,
      state: mode === 'offline' ? 'offline' : 'working', _lifePose: mode === 'snooze' ? 'snooze' : null, _lifePoseData: mode === 'snooze' ? {} : null });
    a.x = a.targetX = a._prevTargetX = item.x; a.y = a.targetY = a._prevTargetY = item.y; a.desk = { x: item.x, y: item.y };
    agentChatData[a.statusKey] = [{ role: 'assistant', text: '', tools: [{ name: 'TodoWrite', status: 'running' }] }];
    const c = document.createElement('canvas'); c.width = B.w * S; c.height = B.h * S;
    const g = c.getContext('2d'), s = window.ctx; window.ctx = g; g.imageSmoothingEnabled = false;
    try {
      g.setTransform(S, 0, 0, S, -B.x * S, -B.y * S); g.fillStyle = '#c9c2b6'; g.fillRect(B.x, B.y, B.w, B.h);
      drawFurnitureItem(item, { staticOnly: true });
      const ents = [a].concat(_tallFurnitureEntries()); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
    } finally { window.ctx = s; officeConfig.furniture = keep; }
    return c.toDataURL('image/png');
  })).filter((_, i) => true), { list: ROWS.filter(r => r[1] === base), S, B });
  await context.close();
  return out;
}

if (noBrowser) { console.log('SKIP sheet: ' + noBrowser); process.exit(0); }
const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
try {
  if (!process.env.SHEET_BASE_GAME || !process.argv[2]) throw new Error('usage: SHEET_BASE_GAME=base-game.js node tests/sheets_v13_sleeppose.mjs out.jpg');
  const before = await rows(true), after = await rows(false), cells = before.concat(after);
  globalThis.__BASE = false;
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  await page.setContent('<html><body></body></html>');
  const jpg = await page.evaluate(async ({ cells, labels, W, H }) => {
    const LW = 150, TH = 22, G = 4, c = document.createElement('canvas'); c.width = LW + 4 * (W + G); c.height = TH + cells.length * (H + G);
    const g = c.getContext('2d'); g.fillStyle = '#20242b'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingEnabled = false;
    g.fillStyle = '#e0e0e0'; g.font = '13px sans-serif';
    ['from behind (0)', 'profile (90)', 'front, desk at 180', 'profile (270)'].forEach((t, i) => g.fillText(t, LW + i * (W + G) + 6, 15));
    for (let r = 0; r < cells.length; r++) {
      const y = TH + r * (H + G); g.fillStyle = r < 2 ? '#ffab91' : r === cells.length - 1 ? '#b0bec5' : '#a5d6a7';
      labels[r].split(': ').forEach((t, i) => g.fillText(t + (i ? '' : ':'), 6, y + 40 + i * 18));
      for (let i = 0; i < 4; i++) { const im = new Image(); im.src = cells[r][i]; await im.decode(); g.drawImage(im, LW + i * (W + G), y); }
    }
    return c.toDataURL('image/jpeg', 0.72);
  }, { cells, labels: ROWS.map(r => r[0]), W: B.w * S, H: B.h * S });
  const out = process.argv[2];
  fs.writeFileSync(out, Buffer.from(jpg.split(',')[1], 'base64'));
  console.log('sheet', out, fs.statSync(out).size, 'bytes');
} finally { await browser.close(); }
