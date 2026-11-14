// Office art regression test (v0.10 "Polish", art-sprites).
//
// Hermetic: headless Chrome through playwright-core, every request answered
// from app/ files and fixed fixtures, nothing saved. Draws assets into private
// canvases by swapping the global ctx that game.js draws with, and checks
// pixels, bounds and the art contracts (floor styles, look fields, rotation).
//
// Run: node tests/test_v10_art.mjs
// Needs playwright-core (or PLAYWRIGHT_CORE_PATH) and Chrome/Chromium
// (or CHROME_PATH). Prints SKIP and exits 0 when either is missing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);

function skip(reason) {
  console.log(`SKIP test_v10_art: ${reason}`);
  process.exit(0);
}

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
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = findChrome();
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

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
  '/vo-config': { version: '0.10.0', office: { name: 'Art Test' }, features: {}, weather: { location: null } },
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

const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.log(`not ok - ${name}: ${String(e && e.message || e).split('\n')[0].slice(0, 300)}`); }
}
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.route('**/*', route);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length > 0 && window.VOOffice, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  // Browser helpers: draw with the game's own functions into a private canvas.
  await page.evaluate(() => {
    window.__art = {
      canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
      withCtx(g, fn) { const saved = window.ctx; window.ctx = g; try { return fn(); } finally { window.ctx = saved; } },
      opaque(c, x, y, w, h) {
        const d = c.getContext('2d').getImageData(x || 0, y || 0, w || c.width, h || c.height).data; let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      },
      bbox(c) {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
        return x1 < 0 ? null : { x0, y0, x1, y1 };
      },
      drawItem(item, w, h) {
        const c = this.canvas(w || 300, h || 300); const g = c.getContext('2d');
        this.withCtx(g, () => drawFurnitureItem(item, { staticOnly: true }));
        return c;
      },
    };
  });

  await check('A1: the fridge has art and every catalog type draws pixels', async () => {
    const r = await page.evaluate(() => {
      const out = {};
      const types = Object.keys(FURNITURE_BOUNDS);
      types.forEach(t => {
        const item = { id: 'x-' + t, type: t, x: 150, y: 150 };
        if (t === 'branchSign') item.branchId = (getBranchList()[0] || {}).id;
        if (t === 'textLabel') { item.text = 'LABEL'; item.labelColor = '#ffffff'; item.fontSize = 12; }
        out[t] = __art.opaque(__art.drawItem(item));
      });
      return out;
    });
    assert.ok(r.fridge > 1500, 'fridge pixels ' + r.fridge);
    const empty = Object.keys(r).filter(t => r[t] < 30);
    assert.deepEqual(empty, [], 'types drawing nothing: ' + empty.join(','));
  });

  await check('A1: an unknown item type draws a visible placeholder inside its hit box', async () => {
    const r = await page.evaluate(() => {
      const item = { id: 'u', type: 'retiredThing', x: 100, y: 100 };
      const c = __art.drawItem(item); const rect = _furnitureRect(item);
      return { px: __art.opaque(c), bbox: __art.bbox(c), rect };
    });
    assert.ok(r.px > 200, 'placeholder pixels ' + r.px);
    assert.ok(r.bbox.x0 >= r.rect.x && r.bbox.y0 >= r.rect.y && r.bbox.x1 < r.rect.x + r.rect.w && r.bbox.y1 < r.rect.y + r.rect.h,
      'placeholder inside rect ' + JSON.stringify(r));
  });

  await check('A9: default walls are muted and user wall colours are clamped for display only', async () => {
    const hsl = hex => { const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
      return { s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l }; };
    const colours = [];
    (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object')
      Object.keys(o).forEach(k => { const v = o[k]; if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) && /olor/.test(k)) colours.push(v); else walk(v); }); })(DEFAULT_CFG.walls);
    const loud = colours.filter(c => hsl(c).s > 0.5);
    assert.deepEqual(loud, [], 'saturated default wall colours');
    const r = await page.evaluate((list) => {
      const wall = { color: '#0000ff', accentColor: '#ff7300' };
      const defaults = {}; list.forEach(c => { defaults[c] = _wallDisplayColor(c); });
      return { blue: _wallDisplayColor('#0000ff'), main: _wallMainColor(wall), accent: _wallAccentColor(wall), grey: _wallDisplayColor('#546e7a'),
        light: _wallDisplayColor('#4d79ff'), defaults,
        stored: wall.color, api: !!(window.VOOfficeArt && window.VOOfficeArt.wallDisplayColor) };
    }, colours);
    assert.notEqual(r.blue, '#0000ff');
    assert.ok(hsl(r.blue).s <= 0.41 && hsl(r.accent).s <= 0.41, JSON.stringify(r));
    assert.ok([r.blue, r.accent, r.light].every(c => hsl(c).l >= 0.29 && hsl(c).l <= 0.61), 'loud colours pulled to the mid lightness band (Q-06) ' + JSON.stringify(r));
    for (const c of colours) assert.equal(r.defaults[c], c, `default wall colour ${c} drawn unchanged`);
    assert.equal(r.main, r.blue);
    assert.equal(r.grey, '#546e7a', 'muted colours pass through unchanged');
    assert.equal(r.stored, '#0000ff', 'stored value untouched');
    assert.ok(r.api, 'window.VOOfficeArt.wallDisplayColor exported');
  });

  await check('A2 (v0.10.1): chair at the front turned to the desk, agent on it facing the desk at work and idle (back view, review 11-05), swivelled to face us with a drink; desk + v0.9 monitor behind; desk item and drink on the desk top in every rotation', async () => {
    const r = await page.evaluate(() => {
      const out = {};
      const px = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const sig = c => { const d = px(c); let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2] + d[i + 3]) >>> 0; return h; };
      const changed = (c0, c1) => { const a = px(c0), b = px(c1), pts = []; for (let i = 0; i < a.length; i += 4)
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]) > 24) pts.push([(i / 4) % c0.width, Math.floor(i / 4 / c0.width)]); return pts; };
      const inR = (p, r, pad) => p[0] >= r.x - (pad || 0) && p[0] < r.x + r.w + (pad || 0) && p[1] >= r.y - (pad || 0) && p[1] < r.y + r.h + (pad || 0);
      for (const type of ['desk', 'bossDesk']) for (const rot of [0, 90, 180, 270]) {
        const desk = { id: 'seat-' + type + rot, type, x: 150, y: 150 }; if (rot) desk.rotation = rot;
        const saved = officeConfig.furniture; officeConfig.furniture = saved.concat([desk]);
        try {
          const mkA = extra => { const a = new Agent({ id: 'seat' + type + rot, statusKey: 'seat', name: 'S', emoji: '', role: '', color: '#e53935', gender: 'M',
            appearance: { skinTone: '#e8b88a', hairStyle: 'bald', deskItem: 'calendar' }, _autoDesk: { x: 150, y: 150 } });
            a.x = a.targetX = 150; a.y = a.targetY = 150; a.desk = { x: 150, y: 150 }; a.isSitting = true; a.state = 'working'; a._seatT = 1; a.tick = 200; a.blinkTimer = 0;
            return Object.assign(a, extra || {}); };
          const a = mkA(), seat = a._seatPose(false), spot = _deskSeatSpot(desk);
          const draw = ag => { const c = __art.canvas(300, 300); __art.withCtx(c.getContext('2d'), () => ag.draw()); return c; };
          const body = draw(a), fv = mkA({ _forceView: 'down' }), front = sig(body) === sig(draw(fv));
          // idle (review 11-05 G): still facing the desk; with a drink the chair swivels to the room, the face shows
          const ia = mkA({ state: 'idle' }), idleView = (draw(ia), ia._lastSeat && ia._lastSeat.view);
          const da = mkA({ state: 'idle', carryItem: 'coffee' }), drink = draw(da), drinkView = da._lastSeat && da._lastSeat.view;
          const swiv = draw(mkA({ state: 'idle', _forceView: 'down' })), drinkFront = drinkView === 'down';
          const bodyPx = px(body), swPx = px(swiv), onBody = p => bodyPx[(p[1] * 300 + p[0]) * 4 + 3] > 8 || swPx[(p[1] * 300 + p[0]) * 4 + 3] > 8;
          // the top face (v0.10.1 camera: raised 21 px; turned desks are redrawn per view: the turned top face)
          const deskTop = _deskTopRect(desk);
          const mons = _deskMonitorRects(desk).map(m => ({ x: desk.x + m.bx, y: desk.y + m.by, w: m.bw, h: m.bh }));  // world axes at every turn
          // the unique desk item: desk alone vs desk + item
          const d0 = __art.drawItem(desk), d1 = __art.drawItem(desk);
          __art.withCtx(d1.getContext('2d'), () => { ctx.save(); ctx.translate(150, 150); a._drawDeskCharItem(ctx); ctx.restore(); });
          const item = changed(d0, d1);
          // a coffee resting on the desk (not in hand at tick 200; a drink = swivelled to the room)
          const coffee = changed(swiv, drink);
          const cup = { x: 150 + spot.food[0], y: 150 + spot.food[1], w: 11, h: 10 };
          let cupOnBody = 0; for (let y = cup.y; y < cup.y + cup.h; y++) for (let x = cup.x; x < cup.x + cup.w; x++) if (onBody([x, y])) cupOnBody++;
          const bb = __art.bbox(body);
          out[type + rot] = { seat: !!seat, view: seat && seat.view, front, idleView, drinkFront,
            item: item.length, itemOff: item.filter(p => !inR(p, deskTop)).length, itemOnMon: item.filter(p => mons.some(m => inR(p, m))).length, // never on the monitor (v0.10.1 layout: the item may stand beside it)
            itemOnBody: item.filter(onBody).length,
            cup: coffee.length, cupOff: coffee.filter(p => !inR(p, deskTop, 0) && p[1] >= cup.y).length, cupOnMon: coffee.filter(p => mons.some(m => inR(p, m))).length, cupOnBody,
            headTop: bb && bb.y0, bodyOnMon: (() => { let n = 0; mons.forEach(m => { for (let y = m.y; y < m.y + m.h; y++) for (let x = m.x; x < m.x + m.w; x++) if (onBody([x, y])) n++; }); return n; })(),
            monBottom: Math.max(...mons.map(m => m.y + m.h)), monTop: Math.min(...mons.map(m => m.y)), hip: 150 + spot.hy,
            tagBottom: a.nameTagRect.y + a.nameTagRect.h, tagX: a.nameTagRect.x + a.nameTagRect.w / 2,
            headX: (() => { let x0 = 1e9, x1 = -1; for (let y = bb.y0; y < bb.y0 + 8; y++) for (let x = 0; x < 300; x++) if (bodyPx[(y * 300 + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); } return (x0 + x1 + 1) / 2; })() }; // head rows (the hands reach out)
          if (!rot) {
            const empty = __art.drawItem(desk), e = px(empty), at = (x, y) => Array.from(e.slice((y * 300 + x) * 4, (y * 300 + x) * 4 + 4));
            out[type + rot].chair = at(150, 150 + spot.hy - 8);   // backrest of the empty chair, in front of the desk
          }
        } finally { officeConfig.furniture = saved; }
      }
      return out;
    });
    for (const k of Object.keys(r)) {
      const o = r[k], rot = +k.replace(/\D+/g, '');
      // v0.10.1 seating (review 11-05): at work the sitter faces the desk: the back at 0,
      // a profile at a desk turned 90 (faces right) / 270 (faces left), the front at 180
      // (behind the desk), idle too (review 11-05 G); with a drink the chair swivels to the room: front view.
      const want = rot === 90 ? 'right' : rot === 270 ? 'left' : rot === 180 ? 'down' : 'up';
      assert.ok(o.seat && o.view === want && (want !== 'down' || o.front), k + ': seated agent not in the ' + want + ' view ' + JSON.stringify(o));
      assert.ok(o.idleView === want, k + ': idle sitter not facing the desk ' + JSON.stringify(o));
      assert.ok(o.drinkFront, k + ': sitter with a drink not swivelled to face us ' + JSON.stringify(o));
      // desk 180 (perspective P2): the casing back leaves 16 px each side of the top, the 18 px item stands at the near
      // corner just in front of it (a few px over the casing's edge)
      // v0.13 bossDesk180 (40 deep): the casing backs came 8 px nearer the far edge, so the item and the drink stand on
      // the near edge like the desk's, at the outer corners: the item over the casing's outer edge (the sitter draws
      // the casings again over its torso: ~50 px of a calendar; the widest item keeps on the top), the cup's box (anchored left here, the cup is drawn
      // centred) touches the casing
      assert.ok(o.item > 10 && !o.itemOff && (k === 'desk180' ? o.itemOnMon <= 40 : k === 'bossDesk180' ? o.itemOnMon <= 52 && o.itemOnBody <= 52 : !o.itemOnMon && !o.itemOnBody), k + ': desk item not on the free desk top ' + JSON.stringify(o));
      // desk180 (P3, desk 64 wide): 12 px beside the 40 px casing back, the sitter's hand may touch the cup's edge
      assert.ok(o.cup > 20 && !o.cupOff && !o.cupOnMon && (k === 'desk180' ? o.cupOnBody <= 4 : k === 'bossDesk180' ? o.cupOnBody <= 26 : !o.cupOnBody), k + ': drink not on the free desk top ' + JSON.stringify(o));
      // 180: the sitter behind the desk draws the monitors' casing backs again over its body (the head stays clear)
      if (rot === 180) assert.ok(o.bodyOnMon > 0 && o.headTop < o.monTop, k + ': the casing back over the torso, the head above it ' + JSON.stringify(o));
      else assert.equal(o.bodyOnMon, 0, k + ': the body covers the monitor');
      assert.ok(o.tagBottom <= o.headTop, k + ': name tag not above the head');
      assert.ok(Math.abs(o.tagX - o.headX) <= 2, k + ': name tag not centred on the head');
      if (rot === 0) {
        // screen order from the top: monitor, agent (back of the head), chair
        assert.ok(o.monBottom <= o.headTop && o.headTop < o.hip, k + ': not monitor > agent > chair ' + JSON.stringify(o));
        assert.ok(o.tagBottom <= o.monTop, k + ': name tag overlaps the monitor');
        assert.ok(o.chair[3] === 255, k + ': no chair in front of the empty desk ' + o.chair);
      }
    }
  });

  await check('A2 (v0.10.1): meeting chairs on the far side, the ends and the near side (top, ends, near order); every sitter faces the table (far side: the front, ends: profile, near side: the back, review 11-05); the table top in front of far-side hips; near sitters seated as high as far ones; standing spots clear of the table', async () => {
    const r = await page.evaluate(() => {
      const out = {};
      const mk = (id, s) => { const a = new Agent({ id, statusKey: 'mt', name: 'M', emoji: '', role: '', color: '#29b6f6', gender: 'F', appearance: { skinTone: '#e8b88a' }, _autoDesk: { x: 0, y: 0 } });
        a.x = a.targetX = s.x; a.y = a.targetY = s.y; a.desk = { x: 9000, y: 9000 }; a.isSitting = false; a.state = 'meeting'; a._seatT = 1; a.blinkTimer = 0; return a; };
      for (const rot of [0, 90, 180, 270]) {
        const t = { id: 'mt' + rot, type: 'meetingTable', x: 400, y: 300 }; if (rot) t.rotation = rot;
        // the seat layout rect: the table's turned plan grown 22 px north and 18 deeper (= surface.rect at 0)
        const pl = _projTurn(FURNITURE_MANIFEST.meetingTable.projection.parts[0].plan, rot), tr = { x: t.x + pl[0], y: t.y + pl[1] - 22, w: pl[2], h: pl[3] + 18 }, seats = _meetingSeats(t);
        const bad = seats.filter(s => s.kind && !(s.kind === 'top' ? s.hy <= tr.y + 8 : s.kind === 'left' ? s.hx < tr.x : s.kind === 'right' ? s.hx > tr.x + tr.w : s.hy >= tr.y + tr.h));
        const standOver = seats.filter(s => !s.kind && s.y - 40 < tr.y + tr.h + 8).length;
        const rank = { top: 0, left: 1, right: 1, near: 2 }, order = seats.map(s => s.kind ? rank[s.kind] : 3);
        const saved = officeConfig.furniture, savedA = agents.slice(); officeConfig.furniture = saved.filter(f => f.type !== 'meetingTable').concat([t]);
        try {
          const views = seats.filter(s => s.kind).map(s => { const p = _meetingSeatAt(s.x, s.y); return s.kind + ':' + (p && p.view); });
          const s0 = seats.find(s => s.kind === 'top'), sn = seats.find(s => s.kind === 'near');
          const a = mk('mt-a' + rot, s0), b = mk('mt-b' + rot, sn);
          const c = __art.canvas(900, 800); __art.withCtx(c.getContext('2d'), () => a.draw());
          const cn = __art.canvas(900, 800); __art.withCtx(cn.getContext('2d'), () => b.draw());
          const bn = __art.bbox(cn);
          agents.length = 0; const tucked = _meetingSeatTaken(sn); agents.push(b); const taken = _meetingSeatTaken(sn);
          out[rot] = { n: seats.filter(s => s.kind).length, near: seats.filter(s => s.kind === 'near').length, bad: bad.length, standOver, views,
            sorted: order.every((v, i) => !i || order[i - 1] <= v), bottom: __art.bbox(c).y1, tableTop: tr.y,
            nearTop: bn.y0 - sn.hy, farTop: __art.bbox(c).y0 - s0.hy, tucked, taken,
            first: getMeetingSlots()[0].kind, slots: getMeetingSlots().length };
        } finally { officeConfig.furniture = saved; agents.length = 0; savedA.forEach(x => agents.push(x)); }
      }
      return out;
    });
    for (const rot of Object.keys(r)) {
      const o = r[rot];
      assert.ok(o.n >= 10 && o.near >= 1 && o.bad === 0, rot + ': seats ' + JSON.stringify(o));
      assert.ok(o.sorted, rot + ': seat order is not top, ends, near, standing ' + JSON.stringify(o));
      assert.ok(o.views.every(v => v === 'top:down' || v === 'left:right' || v === 'right:left' || v === 'near:up'), rot + ': sitter does not face the table ' + o.views);
      assert.ok(o.bottom <= o.tableTop + 4, rot + ': far-side sitter shows more than folded hands over the table ' + JSON.stringify(o));
      assert.ok(Math.abs(o.nearTop - o.farTop) <= 3, rot + ': near-side sitter not seated at the same height ' + JSON.stringify(o));
      assert.ok(!o.tucked && o.taken, rot + ': near chair taken flag ' + JSON.stringify(o));
      assert.equal(o.standOver, 0, rot + ': a standing spot overlaps the table or the near chairs');
      assert.ok(o.first === 'top' && o.slots >= 10, rot + ': meeting slots ' + JSON.stringify(o));
    }
  });

  await check('A6/A7: sleeves are darker than the shirt, stretch raises the arms over the head, idle actions look different', async () => {
    const r = await page.evaluate(() => {
      const mkA = () => { const a = new Agent({ id: 'pz' + Math.random(), statusKey: 'pz', name: 'P', emoji: '', role: '', color: '#1e88e5', gender: 'M',
        appearance: { skinTone: '#e8b88a', hairStyle: 'short', hairColor: '#5d4037' }, _autoDesk: { x: 0, y: 0 } });
        a.x = a.targetX = 50; a.y = a.targetY = 90; a.desk = { x: 500, y: 500 }; a.isSitting = false; a.tick = 30; a.interactTimer = 30; return a; };
      const sig = c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0;
        for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2] + (d[i + 3] ? 1 : 0)) >>> 0; return h; };
      const draw = setup => { const c = __art.canvas(100, 110); const a = mkA(); setup(a); a.blinkTimer = 0; __art.withCtx(c.getContext('2d'), () => a.draw()); return c; };
      const acts = ['stretch', 'read_book', 'watch_tv', 'get_snack', 'darts', 'couch', 'lounge', 'visit', 'petting', 'break_browse'];
      const sigs = {}; acts.forEach(act => { sigs[act] = sig(draw(a => { a.idleAction = act; a.state = 'idle'; a.isSitting = act === 'couch' || act === 'watch_tv'; })); });
      const plain = sig(draw(a => { a.state = 'idle'; }));
      const st = draw(a => { a.idleAction = 'stretch'; a.state = 'idle'; });
      const px = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
      // standing arm column (x -12..-9) at y -16: sleeve, not shirt
      const idle = draw(a => { a.state = 'idle'; });
      return { sigs, plain, handTop: px(st, 45, 90 - 45), sleeve: px(idle, 50 - 11, 90 - 16), shirt: px(idle, 50, 90 - 16) };
    });
    const vals = Object.values(r.sigs);
    assert.equal(new Set(vals).size, vals.length, 'two idle actions draw the same: ' + JSON.stringify(r.sigs));
    assert.ok(!vals.includes(r.plain), 'an idle action draws like plain idle');
    assert.deepEqual(r.handTop.slice(0, 3), [232, 184, 138], 'stretch: no hands above the head ' + r.handTop);
    assert.ok(r.sleeve[3] === 255 && r.sleeve[2] < r.shirt[2], 'sleeve not darker than the shirt ' + r.sleeve + ' vs ' + r.shirt);
  });

  await check('A21: offline agents are desaturated, not see-through', async () => {
    const r = await page.evaluate(() => {
      const c = __art.canvas(100, 110); const g = c.getContext('2d');
      const a = new Agent({ id: 'off1', statusKey: 'off1', name: 'O', emoji: '', role: '', color: '#e53935', gender: 'M',
        appearance: { skinTone: '#e8b88a', hairStyle: 'short' }, _autoDesk: { x: 0, y: 0 } });
      a.x = a.targetX = 50; a.y = a.targetY = 90; a.desk = { x: 500, y: 500 }; a.isSitting = false; a.state = 'offline';
      __art.withCtx(g, () => a.draw());
      return Array.from(g.getImageData(50, 90 - 16, 1, 1).data);
    });
    assert.equal(r[3], 255, 'offline body is transparent: ' + r);
    assert.ok(Math.max(r[0], r[1], r[2]) - Math.min(r[0], r[1], r[2]) < 40, 'offline shirt still saturated: ' + r);
  });

  await check('A3: costumes stay crisp at 3x (cached per device scale)', async () => {
    const r = await page.evaluate(() => {
      const c = __art.canvas(240, 240); const g = c.getContext('2d'); g.translate(120, 180); g.scale(3, 3); _drawCostume(g, 'lobster');
      const d = g.getImageData(0, 0, 240, 240).data; let n = 0, soft = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; if (d[i] < 255) soft++; }
      return { n, soft };
    });
    assert.ok(r.n > 3000, 'costume drawn ' + r.n);
    assert.ok(r.soft / r.n < 0.02, 'soft edge share ' + (r.soft / r.n).toFixed(3));
  });

  await check('A13: no system fonts or emoji drawn by furniture, agents and pets (pixel font only)', async () => {
    const r = await page.evaluate(() => {
      const fonts = new Set(); const proto = CanvasRenderingContext2D.prototype; const orig = proto.fillText;
      proto.fillText = function () { fonts.add(this.font + '|' + arguments[0]); return orig.apply(this, arguments); };
      try {
        const c = __art.canvas(1200, 900); const g = c.getContext('2d');
        __art.withCtx(g, () => {
          officeConfig.furniture.forEach(f => { if (f.type !== 'textLabel' && f.type !== 'branchSign') drawFurnitureItem(f); });
          agents.forEach(a => { const s = a._lifeExtra; a._lifeExtra = true; a.draw(); a._lifeExtra = s; });
          ['tv', 'microwave', 'vendingMachine'].forEach((t, i) => drawFurnitureItem({ id: 'ft' + i, type: t, x: 100 + i * 60, y: 700 }));
          _drawPixelText('3-2', 10, 10, '#fff', 1, 'left');
        });
      } finally { proto.fillText = orig; }
      return [...fonts];
    });
    assert.deepEqual(r, [], 'fillText used: ' + r.join(' / '));
  });

  await check('A12: every item is drawn inside its bounds (the shared 3 px shadow may spill down-right)', async () => {
    const r = await page.evaluate(() => {
      const out = {};
      Object.keys(FURNITURE_BOUNDS).forEach(t => {
        if (t === 'interactiveWindow' || t === 'textLabel' || t === 'branchSign') return; // light spill / text sized by content
        const item = { id: 'bb-' + t, type: t, x: 250, y: 250 };
        const c = __art.drawItem(item, 520, 520); const d = c.getContext('2d').getImageData(0, 0, 520, 520).data;
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = 0; y < 520; y++) for (let x = 0; x < 520; x++) if (d[(y * 520 + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
        const b = _furnitureRect(item);
        const o = [b.x - x0, b.y - y0, x1 + 1 - (b.x + b.w), y1 + 1 - (b.y + b.h)].map(v => Math.max(0, Math.round(v)));
        if (o[0] > 1 || o[1] > 1 || o[2] > 4 || o[3] > 4) out[t] = o.join(',');
      });
      return out;
    });
    assert.deepEqual(r, {}, 'art outside bounds (L,T,R,B): ' + JSON.stringify(r));
  });

  await check('C2: floor styles render, zones paint over the base, unknown styles fall back to checker, presets exported', async () => {
    const r = await page.evaluate(() => {
      const styles = (window.VOOfficeArt && window.VOOfficeArt.floorStyles) || [];
      const draw = floor => { const c = __art.canvas(160, 120); const g = c.getContext('2d');
        const sw = W, sh = H; __art.withCtx(g, () => { W = 160; H = 120; try { _drawOfficeFloor(floor); } finally { W = sw; H = sh; } }); return c; };
      const px = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data).slice(0, 3).join(',');
      const colours = c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const s = new Set();
        for (let i = 0; i < d.length; i += 4) s.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return s.size; };
      const out = { ids: styles.map(s => s.id), counts: {} };
      styles.forEach(s => { out.counts[s.id] = colours(draw({ style: s.id, color1: s.color1, color2: s.color2 })); });
      const legacy = draw({ color1: '#c0c0c0', color2: '#b0b0b0' });
      const bogus = draw({ style: 'lava', color1: '#c0c0c0', color2: '#b0b0b0' });
      out.legacy = [px(legacy, 5, 5), px(legacy, 45, 5)];
      out.bogus = [px(bogus, 5, 5), px(bogus, 45, 5)];
      const zoned = draw({ style: 'plain', color1: '#c9c3b7', zones: [{ x: 2, y: 1, w: 2, h: 2, style: 'plain', color1: '#336699' }] });
      out.zoneIn = px(zoned, 100, 60); out.zoneOut = px(zoned, 20, 20);
      return out;
    });
    assert.deepEqual(r.ids, ['checker', 'wood', 'carpet', 'tile', 'concrete', 'plain']);
    for (const id of ['wood', 'carpet', 'tile', 'concrete']) assert.ok(r.counts[id] >= 3, id + ' has no texture: ' + r.counts[id]);
    assert.deepEqual(r.legacy, ['192,192,192', '176,176,176'], 'legacy color1/color2 checker changed');
    assert.deepEqual(r.bogus, r.legacy, 'unknown style is not checker');
    assert.equal(r.zoneIn, '51,102,153', 'zone not painted');
    assert.equal(r.zoneOut, '201,195,183', 'zone painted outside its rect');
  });

  await check('A17: a rotated couch keeps the light from the top-left (top edges lighter than bottom edges)', async () => {
    const r = await page.evaluate(() => {
      const out = {};
      [0, 90, 180, 270].forEach(rot => {
        const c = __art.drawItem({ id: 'cr' + rot, type: 'couch', x: 150, y: 150, rotation: rot }, 300, 300);
        const d = c.getContext('2d').getImageData(0, 0, 300, 300).data, L = i => d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
        let top = 0, bot = 0, n = 0;
        for (let x = 0; x < 300; x += 3) {
          let first = -1, last = -1;
          for (let y = 0; y < 300; y++) if (d[(y * 300 + x) * 4 + 3] > 230) { if (first < 0) first = y; last = y; }
          if (first >= 0 && last - first > 10) { top += L((first * 300 + x) * 4); bot += L((last * 300 + x) * 4); n++; }
        }
        out[rot] = n ? Math.round(top / n - bot / n) : null;
      });
      return out;
    });
    for (const rot of [0, 90, 180, 270]) assert.ok(r[rot] > 8, 'rotation ' + rot + ': top-bottom luminance ' + r[rot] + ' ' + JSON.stringify(r));
  });

  await check('C3: pantsColor, shoeColor, lashes, lipColor, facialHair on any body; old agents keep their look', async () => {
    const r = await page.evaluate(() => {
      const shot = (gender, app) => { const c = __art.canvas(80, 100); const a = new Agent({ id: 'c3' + Math.random(), statusKey: 'c3', name: 'C', emoji: '', role: '',
        color: '#1e88e5', gender, appearance: Object.assign({ skinTone: '#e8b88a', hairStyle: 'bald' }, app), _autoDesk: { x: 0, y: 0 } });
        a.x = a.targetX = 40; a.y = a.targetY = 80; a.desk = { x: 900, y: 900 }; a.isSitting = false; a.state = 'idle'; a.blinkTimer = 0; a.tick = 0; a._lifeExtra = true;
        __art.withCtx(c.getContext('2d'), () => a.draw()); return c; };
      const px = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data).slice(0, 3).join(',');
      const sig = c => c.toDataURL();
      return {
        pants: px(shot('M', { pantsColor: '#5d7a99' }), 34, 80),
        pantsDefault: px(shot('M', {}), 34, 80),
        shoes: px(shot('M', { shoeColor: '#8d5a3a' }), 34, 84),
        lashesA: sig(shot('M', { lashes: true })) !== sig(shot('M', {})),
        noLashesB: sig(shot('F', { lashes: false })) !== sig(shot('F', {})),
        lipsA: sig(shot('M', { lipColor: '#b0505a' })) !== sig(shot('M', {})),
        beardB: sig(shot('F', { facialHair: 'beard' })) !== sig(shot('F', {})),
      };
    });
    assert.equal(r.pants, '93,122,153', 'pantsColor');
    assert.equal(r.pantsDefault, '26,26,46', 'default pants #1a1a2e');
    assert.equal(r.shoes, '141,90,58', 'shoeColor');
    assert.ok(r.lashesA && r.noLashesB && r.lipsA && r.beardB, JSON.stringify(r));
  });

  await check('A5: walking people show front, back and side views (no face from behind)', async () => {
    const r = await page.evaluate(() => {
      const shot = (tx, ty) => { const c = __art.canvas(80, 100); const a = new Agent({ id: 'v' + Math.random(), statusKey: 'v', name: 'V', emoji: '', role: '',
        color: '#1e88e5', gender: 'M', appearance: { skinTone: '#e8b88a', hairStyle: 'short', hairColor: '#6d4c41' }, _autoDesk: { x: 0, y: 0 } });
        a.x = 40; a.y = 80; a.targetX = 40 + tx; a.targetY = 80 + ty; a.desk = { x: 900, y: 900 }; a.isSitting = false; a.state = 'idle'; a.blinkTimer = 0; a.tick = 0; a._lifeExtra = true;
        __art.withCtx(c.getContext('2d'), () => a.draw()); return { c, view: a._walkFace };
      };
      const white = c => { const d = c.getContext('2d').getImageData(20, 30, 40, 30).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) n++; return n; };
      const down = shot(0, 60), up = shot(0, -60), left = shot(-60, 0), right = shot(60, 0);
      return { views: [down.view, up.view, left.view, right.view], whiteDown: white(down.c), whiteUp: white(up.c),
        differ: new Set([down.c.toDataURL(), up.c.toDataURL(), left.c.toDataURL(), right.c.toDataURL()]).size };
    });
    assert.deepEqual(r.views, ['down', 'up', 'left', 'right']);
    assert.equal(r.differ, 4, 'views look the same');
    assert.ok(r.whiteDown > 10 && r.whiteUp === 0, 'eyes: front ' + r.whiteDown + ', back ' + r.whiteUp);
  });

  await check('OE-16: desks, meeting table, counter and whiteboard rotate in 90 degree steps inside their rotated bounds', async () => {
    const r = await page.evaluate(() => {
      const out = { flags: {}, over: {} };
      ['desk', 'bossDesk', 'meetingTable', 'kitchenCounter', 'whiteboard'].forEach(t => {
        out.flags[t] = !!(FURNITURE_ACTIONS[t] && FURNITURE_ACTIONS[t].rotatable);
        [90, 180, 270].forEach(rot => {
          const item = { id: 'rot-' + t + rot, type: t, x: 260, y: 260, rotation: rot };
          const c = __art.drawItem(item, 540, 540); const d = c.getContext('2d').getImageData(0, 0, 540, 540).data;
          let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
          for (let y = 0; y < 540; y++) for (let x = 0; x < 540; x++) if (d[(y * 540 + x) * 4 + 3] > 8) { n++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
          const b = _getItemWorldRect(item), fr = _furnitureRect(item);
          const o = [b.x - x0, b.y - y0, x1 + 1 - (b.x + b.w), y1 + 1 - (b.y + b.h)].map(v => Math.max(0, Math.round(v)));
          if (!n || o[0] > 1 || o[1] > 1 || o[2] > 4 || o[3] > 4 || fr.w !== b.w || fr.x !== b.x) out.over[t + '@' + rot] = n + ':' + o.join(',');
        });
      });
      return out;
    });
    assert.deepEqual(r.flags, { desk: true, bossDesk: true, meetingTable: true, kitchenCounter: true, whiteboard: true });
    assert.deepEqual(r.over, {}, 'rotated art outside its bounds (px:L,T,R,B): ' + JSON.stringify(r.over));
  });

  // @@MORE_CHECKS@@

  await check('OE-16: a working agent\'s live monitor on a turned desk sits on the turned monitor (drawn live = static layer + monitor pass, not turned twice)', async () => {
    const r = await page.evaluate(() => {
      const out = {}, savedA = agents.slice(), realNow = Date.now;
      Date.now = () => 1.7e12;
      try {
        for (const type of ['desk', 'bossDesk']) for (const rot of [90, 180, 270]) {
          const d = { id: 'om' + type + rot, type, x: 150, y: 150, rotation: rot };
          const a = new Agent({ id: 'om-a', statusKey: 'om', name: 'O', emoji: '', role: '', color: '#29b6f6', gender: 'M', appearance: {}, _autoDesk: { x: 0, y: 0 } });
          a.desk = { x: d.x, y: d.y }; a.state = 'working';
          agents.length = 0; agents.push(a);
          const live = __art.canvas(300, 300), split = __art.canvas(300, 300);
          __art.withCtx(live.getContext('2d'), () => drawFurnitureItem(d));
          __art.withCtx(split.getContext('2d'), () => { drawFurnitureItem(d, { staticOnly: true }); _drawDeskMonitor(d); });
          const A = live.getContext('2d').getImageData(0, 0, 300, 300).data, B = split.getContext('2d').getImageData(0, 0, 300, 300).data;
          let diff = 0;
          for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) + Math.abs(A[i + 3] - B[i + 3]) > 8) diff++;
          out[type + rot] = diff;
        }
      } finally { Date.now = realNow; agents.length = 0; savedA.forEach(x => agents.push(x)); }
      return out;
    });
    assert.ok(Object.values(r).every(n => n === 0), 'live and split drawings differ ' + JSON.stringify(r));
  });
  await check('no page errors', async () => {
    assert.deepEqual(errors.filter(e => !/ResizeObserver/.test(e)), []);
  });
  await context.close();
} finally {
  await browser.close();
}
if (failures) { console.log(`FAILED ${failures} check(s)`); process.exit(1); }
console.log('test_v10_art: all checks passed');
