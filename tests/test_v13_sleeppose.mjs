// Sleep pose test (v0.13, sleeppose): an agent asleep at a desk (offline / dozing, the Office life snooze) keeps
// its hands off the keyboard and the mouse and leans over to one side, in every desk view; waking eases back.
//
// Run: node tests/test_v13_sleeppose.mjs
// Needs playwright-core (or PLAYWRIGHT_CORE_PATH) and Chrome/Chromium (or CHROME_PATH); without them it prints SKIP.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
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
    return routeObj.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
  }
  // Any other API: an empty but valid answer.
  return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
}



// One agent at a desk (type, rotation) drawn as a frame draws it, in a mode: awake (working, a tool running), offline
// (dozing) or the Office life snooze. col = top colour overrides (_topColors: sleeve / fore / hand), hair = hairColor.
const PAGE = () => {
  const orig = window._topColors;
  window._topColors = function (look, color) { const r = orig(look, color); return window.__slCol ? Object.assign({}, r, window.__slCol) : r; };
  window.__sl = {
    box: { x: 210, y: 200, w: 180, h: 150 },
    draw(type, rot, mode, o) {
      o = o || {};
      const item = { id: 'sld', type, x: 300, y: 300, rotation: rot }, a = agents[0], keep = officeConfig.furniture;
      officeConfig.furniture = [item];
      a.appearance = Object.assign({}, getDefaultAppearance(a), { costume: null, heldItem: null, hairStyle: 'short', shirtStyle: 'tee', hairColor: o.hair || '#6d4c41' });
      if (!o.keep) Object.assign(a, { isSitting: true, idleAction: null, meetingId: null, carryItem: null, _lifeCarry: null, _lifeExtra: false,
        _seatCache: null, _seatT: 1, _seatFrom: null, _forceView: null, _lastSeat: null, _swv: null, _dIdle: null, notify: false,
        waitingApprovalCount: 0, activeToolCount: 0, _activityFrame: -1, _react: null, _sigMove: null, _slk: null });
      Object.assign(a, { tick: o.tick || 10, _offlineSprites: null, _offlinePass: false,
        state: mode === 'offline' ? 'offline' : 'working', _lifePose: mode === 'snooze' ? 'snooze' : null, _lifePoseData: mode === 'snooze' ? {} : null });
      a.x = a.targetX = a._prevTargetX = item.x; a.y = a.targetY = a._prevTargetY = item.y; a.desk = { x: item.x, y: item.y };
      const tool = o.tool == null ? 'exec' : o.tool;
      agentChatData[a.statusKey] = tool ? [{ role: 'assistant', text: '', tools: [{ name: tool, status: 'running' }] }] : [{ role: 'assistant', text: 'x' }];
      const B = __sl.box, c = document.createElement('canvas'); c.width = B.w; c.height = B.h;
      const g = c.getContext('2d'), s = window.ctx; window.ctx = g; window.__slCol = o.col || null;
      try {
        g.setTransform(1, 0, 0, 1, -B.x, -B.y); g.fillStyle = '#d3c8b8'; g.fillRect(B.x, B.y, B.w, B.h);
        drawFurnitureItem(item, { staticOnly: true });
        const ents = [a].concat(_tallFurnitureEntries()); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
      } finally { window.ctx = s; window.__slCol = null; officeConfig.furniture = keep; }
      c.work = a._workNow; c.cx = a._bodyBox ? a._bodyBox.x + 17 - B.x : null; c.k = a._slk; c.hdx = a._drawHeadDx;
      return c;
    },
    // pixels that differ between two canvases, as a list of [x, y]
    px(c1, c2) { const p = c1.getContext('2d').getImageData(0, 0, c1.width, c1.height).data, q = c2.getContext('2d').getImageData(0, 0, c1.width, c1.height).data, out = [];
      for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2]) out.push([(i >> 2) % c1.width, Math.floor((i >> 2) / c1.width)]); return out; },
    bbox(pts) { if (!pts.length) return null; const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; },
    // the pixels of one coloured part: drawn white, then black
    part(type, rot, mode, which, o) {
      const W = which === 'hair' ? { hair: '#ffffff' } : { col: which === 'hand' ? { hand: '#ffffff' } : { hand: '#ffffff', fore: '#ffffff', sleeve: '#ffffff' } };
      const K = which === 'hair' ? { hair: '#000000' } : { col: which === 'hand' ? { hand: '#000000' } : { hand: '#000000', fore: '#000000', sleeve: '#000000' } };
      const c1 = __sl.draw(type, rot, mode, Object.assign({}, o, W)), c2 = __sl.draw(type, rot, mode, Object.assign({}, o, K, { keep: true }));
      return { pts: __sl.px(c1, c2), c: c1 };
    },
  };
};

if (noBrowser) console.log(`SKIP test_v13_sleeppose: ${noBrowser}`);
else {
  const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.route('**/*', route);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.agents && window.agents.length > 0 && window.VOOffice, null, { timeout: 20000 });
    await page.waitForTimeout(500);
    await page.evaluate(PAGE);

    // Per desk type, rotation (0 = from behind, 90 / 270 = profiles, 180 = from the front) and sleep (offline, snooze):
    // the keyboard / mouse area = where the awake agent's hands are (typing in bursts, the mouse, plain typing).
    const r = await page.evaluate(() => {
      const out = [];
      for (const type of ['desk', 'bossDesk']) for (const rot of [0, 90, 180, 270]) {
        const tools = rot === 90 || rot === 270 ? ['exec', 'web_fetch'] : ['exec', 'web_fetch', 'TodoWrite'];
        const hands = [].concat(...tools.map(t => __sl.part(type, rot, 'awake', 'hand', { tool: t }).pts)), area = __sl.bbox(hands);
        const awakeHair = __sl.part(type, rot, 'awake', 'hair', { tool: 'TodoWrite' }), hx0 = __sl.bbox(awakeHair.pts);
        for (const mode of ['offline', 'snooze']) {
          const arms = __sl.part(type, rot, mode, 'arms'), hair = __sl.part(type, rot, mode, 'hair'), hb = __sl.bbox(hair.pts), cx = arms.c.cx;
          const inArea = area ? arms.pts.filter(p => p[0] >= area[0] - 1 && p[0] <= area[2] + 1 && p[1] >= area[1] - 1 && p[1] <= area[3] + 1).length : -1;
          const reach = Math.max(0, ...arms.pts.map(p => Math.abs(p[0] - cx)));
          const shift = hb && hx0 ? (hb[0] + hb[2]) / 2 - (hx0[0] + hx0[2]) / 2 : null;
          out.push({ id: type + '@' + rot + ' ' + mode, area, ab: __sl.bbox(arms.pts), cx, view: (agents[0]._lastSeat || {}).view || 'down', hands: hands.length, inArea, reach, shift, work: arms.c.work, k: arms.c.k, hair: hair.pts.length });
        }
      }
      return out;
    });
    await check('asleep at a desk (every view, both desk types, offline and snooze): no hand or arm on the keyboard / mouse area', async () => {
      // the desk turned 180 hides the awake hands behind the monitor's back (nothing to reach there); since the seat reach
      // (v0.13 seatreach: the boss chair 6 px in) the boss desk's screens hide them too; every other view shows them
      const hidden = r.filter(x => !(x.hands > 0)).map(x => x.id);
      assert.deepEqual(hidden, ['desk@180 offline', 'desk@180 snooze', 'bossDesk@180 offline', 'bossDesk@180 snooze'], 'awake hands visible: ' + hidden.join(','));
      const bad = r.filter(x => x.hands > 0 && x.inArea !== 0).map(x => x.id + ' hands=' + x.hands + ' inArea=' + x.inArea);
      assert.deepEqual(bad, [], bad.join('; '));
    });
    await check('asleep at a desk: the arms stay at the body (no arm reaching out to the mouse or a clock), no work animation', async () => {
      const bad = r.filter(x => x.reach > 15 || x.work != null).map(x => x.id + ' reach=' + x.reach + ' work=' + x.work);
      const views = r.map(x => x.id + '=' + x.view).filter(s => !/@0 .*=up$|@90 .*=right$|@180 .*=down$|@270 .*=left$/.test(s));
      assert.deepEqual(views, [], 'a sleeper faces its desk: ' + views.join(','));
      assert.deepEqual(bad, [], bad.join('; '));
    });
    await check('asleep at a desk: the head leans over to one side (>= 2 px sideways of the awake head) in every view', async () => {
      const bad = r.filter(x => !(x.hair > 0) || x.shift == null || Math.abs(x.shift) < 2).map(x => x.id + ' shift=' + x.shift + ' hair=' + x.hair);
      assert.deepEqual(bad, [], bad.join('; '));
    });

    await check('waking (a new run): eases back to the awake pose, hands back on the keys; a click (stir) lifts the lean', async () => {
      const w = await page.evaluate(() => {
        const a = agents[0], ks = [], sh = [];
        __sl.draw('desk', 0, 'offline', {});
        const k0 = a._slk;
        for (let i = 0; i < 8; i++) { a._slkAt = performance.now() - 100; const c = __sl.draw('desk', 0, 'awake', { keep: true, tool: 'TodoWrite' }); ks.push(+c.k.toFixed(2)); sh.push(c.hdx); }
        const hands = __sl.part('desk', 0, 'awake', 'hand', { keep: true, tool: 'TodoWrite' }).pts.length;
        __sl.draw('desk', 0, 'offline', {}); a._react = { kind: 'click', at: performance.now() };
        for (let i = 0; i < 3; i++) { a._slkAt = performance.now() - 100; __sl.draw('desk', 0, 'offline', { keep: true }); }
        const kStir = a._slk; a._react = null;
        return { k0, ks, sh, hands, kStir };
      });
      assert.equal(w.k0, 1);
      assert.ok(w.ks[0] > 0 && w.ks[0] < 1, 'first awake frame is part way: ' + w.ks.join(','));
      assert.ok(w.ks.every((k, i) => !i || k <= w.ks[i - 1]), 'monotonic: ' + w.ks.join(','));
      assert.equal(w.ks[w.ks.length - 1], 0, w.ks.join(','));
      assert.equal(w.sh[w.sh.length - 1], 0, 'head back: ' + w.sh.join(','));
      assert.ok(w.hands > 0, 'hands back on the keys');
      assert.ok(w.kStir < 1, 'stir lifts the lean: ' + w.kStir);
    });

    await check('asleep: a slow breathing bob (slower than awake); reduced motion / Calm: still, no ease', async () => {
      const b = await page.evaluate(() => {
        const a = agents[0]; __sl.draw('desk', 0, 'offline', {}); const seat = a._lastSeat, run = (still) => {
          const keep = window._rxStill; window._rxStill = () => still; const ys = [];
          try { for (let t = 0; t < 360; t += 3) { a.tick = t; const br = Math.round(Math.sin(t * 0.05)), f = _sleepPose(a, seat, false, null, br); ys.push(br + f.uy); } }
          finally { window._rxStill = keep; } return ys; };
        const moving = run(false), still = run(true), flips = ys => ys.filter((v, i) => i && v !== ys[i - 1]).length;
        a._slk = 0; const keep = window._rxStill; window._rxStill = () => true; _sleepPose(a, seat, false, null, 0); const snap = a._slk; window._rxStill = keep;
        return { moving: flips(moving), still: flips(still), awake: flips(Array.from({ length: 120 }, (_, i) => Math.round(Math.sin(i * 3 * 0.05)))), snap };
      });
      assert.ok(b.moving > 0 && b.moving < b.awake, JSON.stringify(b));
      assert.equal(b.still, 0, JSON.stringify(b));
      assert.equal(b.snap, 1, JSON.stringify(b));
    });

    await check('no page errors', async () => { assert.deepEqual(errors, [], errors.join(' | ')); });
    if (process.env.SLEEP_DUMP) fs.writeFileSync(process.env.SLEEP_DUMP, JSON.stringify(r, null, 1));
  } finally {
    await browser.close();
  }
}
if (failures) { console.log(`${failures} check(s) failed`); process.exit(1); }
console.log('test_v13_sleeppose: all checks passed');
