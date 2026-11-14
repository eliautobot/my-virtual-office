// v0.10.1 volumes (review 11-05, boss-hidden-phone.jpg): an agent with its own desk is always seated in it, never
// standing at the desk's anchor inside the desk (where the desk is drawn over it). Headless Chrome, fixture APIs,
// nothing written.
//   - the default layout (desks assigned by name in a copy) and the live 8096 layout (fixtures/world-layout-8096.json
//     = anonymised copy; the live file named by WORLD_LIVE_CONFIG is used instead when
//     present, read only), 3 and 12 agents, the desks turned 0/90/180/270, and three load orders (the layout before
//     the roster, the layout after the roster = the live bug, the roster late): every agent whose desk is a desk or
//     boss desk is seated in it (isSitting, at the desk, seatInfo() on that desk), VOWorld.check() is empty, and the
//     body is not covered by its own desk (pixels of the agent inside its body box through the real _renderFrame);
//   - an owner that loses isSitting at its desk without a walk (a script stops it there) sits again on the next step;
//     someone at rest at another agent's desk anchor steps out to the chair's floor point.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.WORLD_APP || path.resolve(here, '..', 'app'));
const REPORT = !!process.env.WORLD_REPORT;
const LIVE_FILE = process.env.WORLD_LIVE_CONFIG || '';
const require = createRequire(import.meta.url);

function skip(reason) { console.log(`SKIP test_v10_world_seated: ${reason}`); process.exit(0); }
function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) { try { return require(c); } catch { /* next */ } }
  return null;
}
function findChrome() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = findChrome();
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const ORIGIN = 'http://office.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };

const isDesk = f => f.type === 'desk' || f.type === 'bossDesk';
function layouts() {
  const def = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
  // the default office has free desks: give the first 8 (and the boss desk) owners by name
  let k = 0;
  def.furniture.forEach(f => { if (isDesk(f) && (f.type === 'bossDesk' || k < 8)) f.assignedTo = f.type === 'bossDesk' ? 'Boss' : 'Owner ' + (++k); });
  let live = null, src = 'live file (read only)';
  try { live = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')); } catch { /* fixture */ }
  if (!live) { live = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'world-layout-8096.json'), 'utf8')); src = 'anonymised fixture'; }
  return [{ name: 'default', config: def }, { name: 'live', config: live, src }];
}
// The boss desk's owner first (the live bug: the main agent), then other desk owners, then agents without a desk.
function roster(config, n) {
  const desks = (config.furniture || []).filter(f => isDesk(f) && f.assignedTo);
  const names = [...new Set(desks.sort((a, b) => (b.type === 'bossDesk') - (a.type === 'bossDesk')).map(f => f.assignedTo))];
  const owners = n <= 3 ? 1 : Math.ceil(n * 2 / 3);
  return Array.from({ length: n }, (_, i) => {
    const id = 'a' + String(i + 1).padStart(2, '0');
    return { id, statusKey: id, name: i < owners && names[i] ? names[i] : 'Agent ' + (i + 1), emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true };
  });
}
function turned(config, rot) {
  const c = JSON.parse(JSON.stringify(config));
  if (rot) c.furniture.forEach(f => { if (isDesk(f) && f.assignedTo) f.rotation = rot; });
  return c;
}

async function openOffice(browser, config, agentsList, delay) {
  const ids = agentsList.map(a => a.id);
  const FIX = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.1', office: { name: 'World Seated' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: agentsList },
    '/status': Object.fromEntries(ids.map((id, i) => [id, { state: i % 2 ? 'idle' : 'working', task: i % 2 ? '' : 'Shipping' }])),
    '/agent-chat': {}, '/api/office-config': config, '/weather-proxy': { current_condition: [], configured: false },
  };
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.route('**/*', async (r) => {
    const req = r.request(); const url = new URL(req.url());
    if (url.origin !== ORIGIN) return r.abort();
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (Object.prototype.hasOwnProperty.call(FIX, url.pathname)) {
      if (delay[url.pathname]) await new Promise(res => setTimeout(res, delay[url.pathname]));
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() }, body: JSON.stringify(FIX[url.pathname]) });
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel); const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile())
      return r.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.addInitScript(() => {
    let s = 7;
    Math.random = function() { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__voWorldCheck = 'every';
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((k) => window.agents && window.agents.length >= k && window.VOWorld, agentsList.length, { timeout: 30000 });
  // the layout (maybe late) is in: its desks are the ones assigned
  await page.waitForFunction((n) => officeConfig.furniture.length === n, config.furniture.length, { timeout: 30000 });
  await page.waitForTimeout(700);
  return { page, errors, context };
}

// In page: every desk owner seated in its own desk, nothing covering its body; VOWorld.check() empty.
function seatedCheck(label) {
  const SEEN_MIN = 0.85;
  const out = [], ok = (c, what) => out.push({ ok: !!c, what: label + ': ' + what });
  for (let i = 0; i < 3; i++) _simulationStep();
  window._runSimulation = function () { return 0; }; window._shouldDrawFrame = function () { return true; };
  window.drawAgentActivityChips = function () {}; window._drawMiniMap = function () {}; window.drawChatBubbles = function () {};
  const hits = VOWorld.check();
  ok(hits.length === 0, 'VOWorld.check() is empty' + (hits.length ? ' ' + JSON.stringify(hits.slice(0, 3)) : ''));
  const desks = officeConfig.furniture.filter(f => f.type === 'desk' || f.type === 'bossDesk');
  const render = () => { for (let k = 0; k < 2; k++) { _invalidateStaticLayer(); _staticSigCheckedAt = -1e9; _renderFrame(performance.now()); } };
  agents.forEach(a => {
    const d = desks.find(f => a.desk && f.x === a.desk.x && f.y === a.desk.y);
    if (!d) { ok(!VOWorld.feetIn(a.x, a.y), `${a.name} (no desk) stands outside every piece`); return; }
    // v0.10.1: a desk assigned to someone who is not in this office is free
    const own = !d.assignedTo || d.assignedTo === a.name || !agents.some(x => !x._lifeExtra && (x.name === d.assignedTo || x.id === d.assignedTo));
    ok(own, `${a.name} has its own or a free desk`);
    ok(a.isSitting && a.x === d.x && a.y === d.y, `${a.name} seated at its ${d.type} r${d.rotation || 0} (sit ${a.isSitting}, at ${Math.round(a.x)},${Math.round(a.y)})`);
    render();
    const info = a.seatInfo();
    ok(info && info.item === d, `${a.name} seatInfo() on its ${d.type} (${info ? info.kind : null})`);
    const b = a._bodyBox;
    if (!b) { ok(false, `${a.name} has a body box`); return; }
    const o = _cameraOrigin(), S = o.s * DPR;
    const X0 = Math.floor((o.x + b.x * o.s) * DPR), Y0 = Math.floor((o.y + b.y * o.s) * DPR);
    const w = Math.max(1, Math.ceil(b.w * S)), h = Math.max(1, Math.ceil(b.h * S));
    const A = ctx.getImageData(X0, Y0, w, h).data;
    const keep = { x: a.x, y: a.y, tx: a.targetX, ty: a.targetY };
    a.x = a.targetX = -9000; a.y = a.targetY = -9000;
    render();
    const E = ctx.getImageData(X0, Y0, w, h).data;
    a.x = keep.x; a.y = keep.y; a.targetX = keep.tx; a.targetY = keep.ty;
    // the same person drawn over everything = what it would show uncovered
    ctx.save(); ctx.setTransform(DPR * o.s, 0, 0, DPR * o.s, DPR * o.x, DPR * o.y); a.draw(); ctx.restore();
    const T = ctx.getImageData(X0, Y0, w, h).data;
    // the upper half of the person as drawn uncovered (head, shoulders, torso: a sitter's are above the desk top
    // in every view; the chair parts below may equal the empty chair's pixels) is in view in the frame
    const px = [];
    for (let k = 0; k < A.length; k += 4) if (T[k] !== E[k] || T[k + 1] !== E[k + 1] || T[k + 2] !== E[k + 2]) px.push(k);
    const top = px.length ? Math.floor(px[0] / 4 / w) : 0, bot = px.length ? Math.floor(px[px.length - 1] / 4 / w) : 0;
    const cut = top + (bot - top) * 0.45;
    let mine = 0, seen = 0;
    for (const k of px) {
      if (Math.floor(k / 4 / w) > cut) break;
      mine++;
      if (A[k] !== E[k] || A[k + 1] !== E[k + 1] || A[k + 2] !== E[k + 2]) seen++;
    }
    const frac = mine ? seen / mine : 0;
    ok(frac >= SEEN_MIN, `${a.name} body not covered by its ${d.type} r${d.rotation || 0} (${Math.round(frac * 100)} % of its upper body in view)`);
  });
  render();
  return out;
}

// In page: lose isSitting at the desk (no walk) -> seated again; at rest at someone else's desk -> steps out.
function restCheck(label) {
  const out = [], ok = (c, what) => out.push({ ok: !!c, what: label + ': ' + what });
  const desks = officeConfig.furniture.filter(f => f.type === 'desk' || f.type === 'bossDesk');
  const owner = agents.find(a => a.isSitting && desks.some(f => f.x === a.desk.x && f.y === a.desk.y));
  if (!owner) { ok(false, 'a seated owner'); return out; }
  owner.isSitting = false;
  _simulationStep();
  ok(owner.isSitting && owner.x === owner.desk.x && owner.y === owner.desk.y, `${owner.name}: stopped at its desk unseated -> seated again`);
  const other = agents.find(a => a !== owner && !a.isSitting && !a.meetingId);
  if (other) {
    other.x = other.targetX = owner.desk.x; other.y = other.targetY = owner.desk.y; other._path = null; other.isSitting = false;
    _simulationStep();
    ok(!other.isSitting && !VOWorld.feetIn(other.x, other.y),
      `${other.name}: at rest at ${owner.name}'s desk anchor -> steps out (now ${Math.round(other.x)},${Math.round(other.y)}, sit ${other.isSitting})`);
    ok(owner.isSitting, `${owner.name} keeps its seat`);
  }
  return out;
}

let passed = 0, failed = 0;
function tally(results) {
  for (const r of results) {
    if (r.ok) { passed++; if (REPORT) console.log('  ok ' + r.what); }
    else { failed++; console.log('  FAIL ' + r.what); }
  }
}

const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
  const ORDERS = [['layout first', { '/api/agents': 900 }], ['layout late', { '/api/office-config': 1500 }], ['together', {}]];
  for (const L of layouts()) {
    if (L.src) console.log(`live layout: ${L.src}`);
    const cases = []; let firstDesks = null;
    for (const [order, delay] of ORDERS) cases.push({ rot: 0, n: 3, order, delay });
    for (const rot of [90, 180, 270]) cases.push({ rot, n: 3, order: 'layout late', delay: { '/api/office-config': 1500 } });
    for (const rot of [0, 180]) cases.push({ rot, n: 12, order: 'together', delay: {} });
    for (const c of cases) {
      const config = turned(L.config, c.rot), list = roster(config, c.n);
      const label = `${L.name} r${c.rot} x${c.n} ${c.order}`;
      const { page, errors, context } = await openOffice(browser, config, list, c.delay);
      try {
        tally(await page.evaluate(seatedCheck, label));
        if (c.n === 3) tally(await page.evaluate(restCheck, label));
        if (c.n === 3 && c.rot === 0) {
          // N5: the same desks whichever arrives first, the layout or the roster
          const desks = await page.evaluate(() => agents.filter(a => !a._lifeExtra).map(a => a.name + '@' + (a.desk && a.desk.x) + ',' + (a.desk && a.desk.y)).sort().join(' | '));
          if (firstDesks === null) firstDesks = desks;
          tally([{ ok: desks === firstDesks, what: `${label}: same desks as the first order (${desks} vs ${firstDesks})` }]);
        }
        tally([{ ok: errors.length === 0, what: label + ': no page errors ' + (errors[0] || '') }]);
      } finally { await context.close(); }
    }
  }
} finally {
  await browser.close();
}
console.log(`test_v10_world_seated: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
