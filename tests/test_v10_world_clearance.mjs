// v0.10.1 clearance (review 11-06: people walk too close to walls, "on top of a wall", and so close behind a piece
// that a chair "is on their face"): the CLEARANCE rules in game.js (bands round walls and furniture the feet keep
// out of, use spots exempt) and the planner following them. Headless Chrome, fixture APIs, seeded Math.random, a
// virtual clock; nothing is written anywhere. On the default layout and the live 8096 layout (anonymised fixture):
//   1 the bands: every horizontal interior wall a front band (CLR.wFront) and a back band (face depth + height +
//     CLR.wTop, half a head past both ends), every vertical wall a side band (2 x CLR.vSide); every footprint a
//     margin; tall parts a band behind (vending, bookshelf, tall plant, filing cabinet, desk monitors), low pieces
//     (couch, coffee/end table) none; cached per layout (no rebuild on a second call, rebuilt after a change);
//   2 use spots: every manifest stand spot and seat floor point is clear;
//   3 goals: a walk goal inside any band (centre of every band) becomes clear floor, a use spot or a seat;
//   4 walks: planWalk between seeded pairs of clear points: the path ends clear, never stands in a band at a
//     corner, and no band run (sampled every 2 px, CLR.tol in) is longer than CLR.runMax (a crossing, not a walk
//     along a wall or behind a shelf); Office life walkable spots and pet spots are clear;
//   5 rest: the invariant fires on a person at rest behind a bookshelf, the person steps out to clear floor within
//     3 s and the invariant is quiet again;
//   6 a simulated few minutes with 12 agents (work/idle flips, wander, visits, a meeting, a gathering), the whole
//     invariant (footprints, seats, 3D volumes, clearance, the body box) on every step: never fires; no walker's
//     drawn body overlaps a piece side by side outside a band crossing.
// Round 3, the BODY BOX (review 11-06 ~12:20: a person beside the TV console, the table top drawn across the leg):
//   1 every piece's band is a 'body' band: its drawn art (footprint + part boxes) + CLR.bodyW + CLR.fp each side,
//     its footprint + CLR.bodyD + CLR.fp front and back; use spots are clear, except where the layout puts another
//     piece's art there (then the goal snaps to a spot clear of it);
//   7 every furniture type x rotation alone: every valid standing point round it (2 px lattice) and every sampled
//     point of 24 walks past it never overlaps its drawn art side by side (VOWorld.sideHit, the screen-space rule;
//     side view for walks that run sideways); the meeting chairs' stop points are seats (drawn seated) and excluded;
//   8 the review case on the layout: a person 8 px beside a low piece's end at its depth (coffee table, couch, desk,
//     counter, end table, ping pong) is in a body band, the invariant fires, they step out clear; the TV's watch goal
//     snaps clear of the coffee table.
// CLEARANCE_MINUTES (default 3), WORLD_REPORT=1 prints every check.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.WORLD_APP || path.resolve(here, '..', 'app'));
const REPORT = !!process.env.WORLD_REPORT;
const MINUTES = Number(process.env.CLEARANCE_MINUTES || 3);
const require = createRequire(import.meta.url);

function skip(reason) { console.log(`SKIP test_v10_world_clearance: ${reason}`); process.exit(0); }
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
const LAYOUTS = [
  { name: 'default', config: JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8')) },
  { name: 'live', config: JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'world-layout-8096.json'), 'utf8')) },
];

async function openOffice(browser, config, n, seed) {
  // half the people own a desk (desks are assigned by name, as in the world sweep), the rest float
  const names = [...new Set((config.furniture || []).filter(f => (f.type === 'desk' || f.type === 'bossDesk') && f.assignedTo).map(f => f.assignedTo))];
  const list = Array.from({ length: n }, (_, i) => ({ id: 'c' + i, statusKey: 'c' + i, name: i < Math.ceil(n / 2) && names[i] ? names[i] : 'Clear ' + i, emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }));
  const FIX = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.1', office: { name: 'Clearance' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: list }, '/status': Object.fromEntries(list.map((a, i) => [a.id, { state: i % 2 ? 'working' : 'idle', task: i % 2 ? 'Clearance' : '' }])),
    '/agent-chat': {}, '/api/office-config': config, '/weather-proxy': { current_condition: [], configured: false },
  };
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.route('**/*', async (r) => {
    const req = r.request(); const url = new URL(req.url());
    if (url.origin !== ORIGIN) return r.abort();
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (Object.prototype.hasOwnProperty.call(FIX, url.pathname))
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() }, body: JSON.stringify(FIX[url.pathname]) });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel); const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile())
      return r.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.addInitScript((sd) => {
    // Virtual clock (real time + simulated steps) and seeded random (mulberry32), the invariant on every step.
    const R = Date, base = new R(2026, 10, 4, 10, 0, 0).getTime(), t0 = R.now();
    let off = 0;
    const now = () => base + (R.now() - t0) + off;
    window.__vAdvance = (ms) => { off += ms; };
    class VD extends R { constructor(...a) { if (a.length === 0) super(now()); else super(...a); } static now() { return now(); } }
    window.Date = VD;
    let s = sd >>> 0;
    Math.random = function() { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__voWorldCheck = 'every';
  }, seed);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((k) => window.agents && window.agents.length >= k && window.VOWorld && window.officeConfig && officeConfig.furniture.length > 3, n, { timeout: 30000 });
  await page.waitForTimeout(600);
  return { page, errors, context };
}

// In page: checks 1-4 (returns [[ok, what], ...]).
function rules() {
  const out = [], ok = (c, w) => out.push([!!c, w]);
  const C = VOWorld.clearance, T = TILE, bands = VOWorld.bands(), wallH = officeConfig.walls.height || 0;
  const near = (a, b) => Math.abs(a - b) <= 0.5;
  // 1 walls
  (officeConfig.walls.interior || []).forEach((wl, i) => {
    const X1 = Math.min(wl.x1, wl.x2) * T, X2 = Math.max(wl.x1, wl.x2) * T, Y1 = Math.min(wl.y1, wl.y2) * T, Y2 = Math.max(wl.y1, wl.y2) * T;
    const wb = bands.filter(b => b.type === 'wall');
    if (X1 === X2) {
      // (probe sweep 11-07: the side band runs CLR.tol + 1 past both ends: no rest-tolerance gap at the seams)
      ok(wb.some(b => b.kind === 'wall side' && near(b.x, X1 - C.vSide) && near(b.w, 2 * C.vSide) && near(b.y, Y1 - C.tol - 1) && near(b.h, Y2 - Y1 + 2 * (C.tol + 1))), `wall ${i} (vertical): side band 2 x ${C.vSide}`);
      ok(wb.some(b => b.kind === 'behind wall end' && near(b.y + b.h, Y1) && b.h >= 30 + C.wTop), `wall ${i} (vertical): band behind its top end`);
    } else {
      ok(wb.some(b => b.kind === 'wall front' && near(b.y, Y1) && near(b.h, C.wFront) && b.x <= X1 - C.head && b.x + b.w >= X2 + C.head), `wall ${i} (horizontal): front band ${C.wFront}`);
      ok(wb.some(b => b.kind === 'behind wall' && near(b.y + b.h, Y1) && b.h >= 30 + C.wTop && b.x <= X1 - C.head && b.x + b.w >= X2 + C.head), `wall ${i} (horizontal): back band (face + ${C.wTop})`);
    }
  });
  ok(bands.some(b => b.kind === 'top wall' && near(b.y + b.h, wallH + C.topFront)), 'top wall: front band');
  const ends = C.bodyW + C.wm;
  ok(bands.filter(b => b.kind === 'wall front' || b.kind === 'behind wall').every(b => (officeConfig.walls.interior || []).some(wl => near(b.x, Math.min(wl.x1, wl.x2) * T - ends))),
    `horizontal walls: bands ${ends} px past the ends (body + ${C.wm})`);
  // 1 furniture
  const TALL = { vendingMachine: 20, bookshelf: 20, tallPlant: 20, filingCabinet: 8, desk: 12 }, LOW = { couch: 1, coffeeTable: 1, endTable: 1 };
  officeConfig.furniture.forEach(it => {
    const mine = bands.filter(b => b.id === it.id && b.type === it.type);
    if (!_itemFootprints(it).length || WALL_ITEM_TYPES[it.type]) return;
    // body band: the drawn art's x range + body + margin, the footprint's depth + body depth + margin
    const fps = _itemFootprints(it), boxes = _clrArtBoxes(it);
    ok(fps.every(r => mine.some(b => b.kind === 'body' && b.x <= r.x - C.bodyW - C.fp + 0.5 && b.x + b.w >= r.x + r.w + C.bodyW + C.fp - 0.5 &&
      near(b.y, Math.min(r.y, ...boxes.filter(q => q.x < r.x + r.w && q.x + q.w > r.x && q.y < r.y + r.h && q.y + q.d > r.y).map(q => q.y)) - C.bodyD - C.fp))),
      `${it.type}#${it.id}: body band (art + ${C.bodyW} + ${C.fp}, depth + ${C.bodyD} + ${C.fp})`);
    ok(!mine.some(b => b.kind === 'margin'), `${it.type}#${it.id}: no feet-point margin band`);
    if (TALL[it.type]) ok(mine.some(b => b.kind === 'behind' && b.h >= TALL[it.type]), `${it.type}#${it.id}: band behind (>= ${TALL[it.type]} px)`);
    if (LOW[it.type]) ok(!mine.some(b => b.kind === 'behind'), `${it.type}#${it.id}: low, no band behind`);
  });
  // 1 cache: the same index twice, rebuilt after a layout change (a plant moved 40 px)
  const k0 = _clrIndex(); ok(_clrIndex() === k0 && k0.key === _clr.key, 'bands cached per layout');
  const pl = officeConfig.furniture.find(f => f.type === 'tallPlant' || f.type === 'plant');
  if (pl) {
    const m0 = VOWorld.bands().find(b => b.id === pl.id && b.kind === 'body');
    pl.x += 40; _worldChanged();
    const m1 = VOWorld.bands().find(b => b.id === pl.id && b.kind === 'body');
    pl.x -= 40; _worldChanged();
    ok(m0 && m1 && near(m1.x - m0.x, 40), 'bands rebuilt after a layout change');
  }
  // 2 use spots
  // (round 3: a use spot in ANOTHER piece's body band where the body overlaps that piece's art is a layout conflict:
  //  the TV's watch spot on the coffee table in front of it; its goal snaps to a point clear of every art)
  const spots = VOWorld.spots(), conflict = [];
  const spotOk = spots.every(s => {
    const b = VOWorld.clearAt(s.x, s.y);
    if (!b) return true;
    const own = _clrIndex().spots.find(q => q.x === s.x && q.y === s.y), h = VOWorld.sideHit(s.x, s.y, C.bodyW, [b.id]);
    const g = _worldGoal(s.x, s.y) || s;
    conflict.push(`${own && own.item ? own.item.type : '?'} (${s.x},${s.y}) on ${b.type} -> ${g.x},${g.y}`);
    return b.kind === 'body' && h && own && own.item && own.item.id !== b.id && !VOWorld.clearAt(g.x, g.y) && !VOWorld.sideHit(g.x, g.y);
  });
  ok(spots.length > 10 && spotOk, `use spots exempt (${spots.length}; layout conflicts: ${conflict.join('; ') || 'none'})`);
  // 3 goals: the centre of every band (on the floor) -> clear floor, a use spot or a seat
  let goals = 0, badGoal = [];
  bands.forEach(b => {
    const x = b.x + b.w / 2, y = b.y + b.h / 2;
    if (y < wallH + 6 || x < 0 || x > W || y > H) return;
    const g = _worldGoal(x, y) || { x, y };
    goals++;
    if (!_worldSeatAt(g.x, g.y, 0) && _clrAt(g.x, g.y)) badGoal.push(`${b.kind} ${b.type}#${b.id} -> ${Math.round(g.x)},${Math.round(g.y)}`);
  });
  ok(goals > 20 && !badGoal.length, `goals in a band snap out (${goals}) ${badGoal.slice(0, 3).join('; ')}`);
  // 4 walks between seeded clear points
  const pts = [];
  for (let k = 0; pts.length < 60 && k < 4000; k++) {
    const x = 20 + Math.random() * (W - 40), y = wallH + 10 + Math.random() * (H - wallH - 30);
    if (_worldFloorOk(x, y) && !_clrAt(x, y)) pts.push({ x: Math.round(x), y: Math.round(y) });
  }
  let walks = 0, longest = 0, badWalk = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[(i * 7 + 3) % pts.length];
    const p = planWalk(a.x, a.y, b.x, b.y);
    if (!p || !p.length || p.partial) continue;
    walks++;
    const end = p[p.length - 1];
    if (_clrAt(end.x, end.y, C.tol)) badWalk.push(`ends in a band ${end.x},${end.y}`);
    let x = a.x, y = a.y, run = 0;
    for (const q of p) {
      const L = Math.hypot(q.x - x, q.y - y), n = Math.max(1, Math.ceil(L / 2));
      for (let s = 1; s <= n; s++) {
        const sx = x + (q.x - x) * s / n, sy = y + (q.y - y) * s / n;
        run = _clrAt(sx, sy, C.tol) ? run + L / n : 0;
        longest = Math.max(longest, run);
        if (run > C.runMax) { badWalk.push(`${a.x},${a.y} -> ${b.x},${b.y}: ${Math.round(run)} px in a band at ${Math.round(sx)},${Math.round(sy)} (${_clrAt(sx, sy).kind})`); run = -1e9; }
      }
      x = q.x; y = q.y;
    }
  }
  ok(walks >= 40 && !badWalk.length, `walks keep the clearance (${walks} walks, longest band run ${Math.round(Math.max(0, longest))} px) ${badWalk.slice(0, 3).join('; ')}`);
  // 4 Office life walkable spots, pet spots
  let lifeBad = 0, life = 0, petBad = 0, pet = 0, k = 0;
  for (let y = wallH + 10; y < H - 10; y += 15) for (let x = 15; x < W - 10; x += 15) {
    if (typeof _lifeWalkable === 'function' && _lifeWalkable(x, y)) { life++; if (_clrAt(x, y)) lifeBad++; }
    if (typeof _petFreeSpot === 'function' && ++k % 3 === 0) { const s = _petFreeSpot(x, y); if (s) { pet++; if (_clrAt(s.x, s.y)) petBad++; } }
  }
  ok(life > 50 && !lifeBad, `Office life walkable spots clear (${life}, ${lifeBad} in a band)`);
  ok(pet > 20 && !petBad, `pet spots clear (${pet}, ${petBad} in a band)`);
  return out;
}

// In page: check 7 (every furniture type x rotation alone, no interior walls; the layout is restored after).
function bodyTypes() {
  const out = [], ok = (c, w) => out.push([!!c, w]), C = VOWorld.clearance;
  const saveF = officeConfig.furniture, saveW = officeConfig.walls.interior;
  const types = Object.keys(FURNITURE_MANIFEST).filter(t => t !== '_unknown' && FURNITURE_MANIFEST[t].mount !== 'wall');
  let pieces = 0, stand = 0, walked = 0, walks = 0;
  const bad = [];
  try {
    officeConfig.walls.interior = [];
    for (const type of types) for (const rot of FURNITURE_MANIFEST[type].rotatable ? [0, 90, 180, 270] : [0]) {
      const M = FURNITURE_MANIFEST[type], it = { id: 'p', type, x: 600, y: 470, rotation: rot }, counter = { id: 'k', type: 'kitchenCounter', x: 560, y: 470 };
      if (M.mount === 'surface') { it.x = 570; it.y = counter.y - M.bounds.h + 2; }
      officeConfig.furniture = (M.mount === 'surface' ? [counter, it] : [it]).map(o => Object.assign({}, o));
      getInteractionSpots(); buildCollisionGrid();
      const live = officeConfig.furniture[officeConfig.furniture.length - 1];
      if (!_itemFootprints(live).length) continue;
      pieces++;
      const tag = type + '/' + rot, art = _getItemWorldRect(live);
      const held = _clrIndex().spots.filter(q => q.held), onSeat = (x, y) => held.some(q => Math.abs(q.x - x) <= 1 && Math.abs(q.y - y) <= 1);
      const x0 = Math.floor(art.x - 50), x1 = Math.ceil(art.x + art.w + 50), y0 = Math.floor(art.y - 30), y1 = Math.ceil(art.y + art.h + 50);
      // every valid standing point round it
      for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
        if (!_worldFloorOk(x, y) || _clrAt(x, y) || onSeat(x, y)) continue;
        stand++;
        const h = VOWorld.sideHit(x, y, C.bodyW);
        if (h && bad.length < 6) bad.push(`${tag}: standing at ${x},${y} beside ${h.type}`);
        if (h) bad.n = (bad.n || 0) + 1;
      }
      // 24 walks past it: between points on a ring round the art (valid standing points)
      const cx = art.x + art.w / 2, cy = art.y + art.h / 2, R = Math.max(art.w, art.h) / 2 + 45, ring = [];
      for (let k = 0; k < 24; k++) {
        const a = k * Math.PI / 12, x = Math.round(cx + R * Math.cos(a)), y = Math.round(cy + R * Math.sin(a) * 0.8);
        const g = _worldGoal(x, y) || { x, y };
        if (_worldFloorOk(g.x, g.y) && !_clrAt(g.x, g.y)) ring.push(g);
      }
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 7 + (k % 5)) % ring.length], p = planWalk(a.x, a.y, b.x, b.y);
        if (!p || !p.length || p.partial) continue;
        walks++;
        let x = a.x, y = a.y;
        for (const q of p) {
          const L = Math.hypot(q.x - x, q.y - y), n = Math.max(1, Math.ceil(L / 2)), hw = Math.abs(q.x - x) > Math.abs(q.y - y) ? C.bodySide : C.bodyW;
          for (let s = 1; s <= n; s++) {
            const sx = x + (q.x - x) * s / n, sy = y + (q.y - y) * s / n;
            walked++;
            const h = VOWorld.sideHit(sx, sy, hw);
            if (h) { bad.n = (bad.n || 0) + 1; if (bad.length < 6) bad.push(`${tag}: walk ${a.x},${a.y} -> ${b.x},${b.y} at ${Math.round(sx)},${Math.round(sy)} beside ${h.type}`); }
          }
          x = q.x; y = q.y;
        }
      }
    }
  } finally {
    officeConfig.furniture = saveF; officeConfig.walls.interior = saveW; getInteractionSpots(); buildCollisionGrid(); _worldChanged();
  }
  ok(pieces > 25 && stand > 100000 && walks > 400 && !bad.length,
    `every type x rotation (${pieces}): ${stand} standing points, ${walks} walks past (${walked} samples): ${bad.n || 0} side overlaps ${bad.join('; ')}`);
  return out;
}

// In page: check 8 (the review case): a person 8 px beside the end of a low piece at its depth.
function elisCase() {
  const out = [], ok = (c, w) => out.push([!!c, w]), C = VOWorld.clearance;
  const a = agents.find(q => !q.meetingId && q.state === 'idle') || agents[0];
  const low = officeConfig.furniture.filter(f => /^(coffeeTable|couch|endTable|desk|kitchenCounter|pingPongTable)$/.test(f.type) && _itemFootprints(f).length);
  let cases = 0;
  const seen = {};
  for (const it of low) {
    if (seen[it.type] >= 2) continue;
    const r = _itemFootprints(it)[0], y = Math.round(r.y + r.h / 2);
    for (const x of [Math.round(r.x - 8), Math.round(r.x + r.w + 8)]) {
      if (!_worldFloorOk(x, y) || _feetIn(x, y)) continue;
      const h = VOWorld.sideHit(x, y, C.bodyW);
      if (!h) continue;  // another piece or a wall right there: not this case
      seen[it.type] = (seen[it.type] || 0) + 1; cases++;
      const band = VOWorld.clearAt(x, y);
      a.moveTo('idle'); a.isSitting = false; a.idleAction = null; a._path = null;
      a.x = a.targetX = a._prevTargetX = x; a.y = a.targetY = a._prevTargetY = y;
      VOWorld.reset();
      const hits = VOWorld.check().filter(v => v.id === a.id).map(v => v.kind);
      for (let i = 0; i < 240; i++) { window.__vAdvance(1000 / 60); _simulationStep(); if (!_clrAt(a.x, a.y, C.tol) && Math.hypot(a.targetX - a.x, a.targetY - a.y) < 2) break; }
      const after = VOWorld.sideHit(a.x, a.y, C.bodyW);
      ok(band && hits.some(k => /^at rest (in a clearance band|beside a piece)/.test(k)) && !after && !_clrAt(a.x, a.y, C.tol),
        `${it.type}#${it.id}: standing 8 px beside its end at (${x},${y}) is in a ${band ? band.kind : 'NO'} band, the invariant fires (${hits.join(', ')}), steps out clear to ${Math.round(a.x)},${Math.round(a.y)}${after ? ' STILL beside ' + after.type : ''}`);
    }
  }
  ok(cases >= 4, `the review case covered on ${cases} piece ends (${Object.keys(seen).join(', ')})`);
  const tv = officeConfig.furniture.find(f => f.type === 'tv');
  if (tv) {
    const w = _itemStandWorld(tv)[0], g = _worldGoal(w.x, w.y) || w;
    ok(!VOWorld.sideHit(g.x, g.y, C.bodyW) && !_clrAt(g.x, g.y), `TV watch goal (${w.x},${w.y}) -> (${g.x},${g.y}) clear of every piece's art`);
  }
  return out;
}

// In page: check 5 (a person at rest behind a bookshelf).
function rest() {
  const out = [], ok = (c, w) => out.push([!!c, w]);
  // a tall piece whose band behind lies on open floor (not against the top wall)
  const band = VOWorld.bands().find(b => b.kind === 'behind' && /bookshelf|vendingMachine|tallPlant|filingCabinet/.test(b.type) && _worldFloorOk(b.x + b.w / 2, b.y + b.h / 2));
  const shelf = band && { type: band.type };
  const a = agents.find(q => !q.meetingId && q.state === 'idle') || agents[0];
  if (!band) { ok(false, 'a tall piece with a band behind on open floor'); return out; }
  const x = Math.round(band.x + band.w / 2), y = Math.round(band.y + band.h / 2);
  a.moveTo('idle'); a.isSitting = false; a.idleAction = null;
  a.x = a.targetX = a._prevTargetX = x; a.y = a.targetY = a._prevTargetY = y; a._path = null;
  VOWorld.reset();
  const hits = VOWorld.check().filter(v => v.id === a.id).map(v => v.kind);
  ok(hits.some(k => /^at rest in a clearance band/.test(k)), `invariant fires at rest behind ${shelf.type} (${hits.join(', ')})`);
  for (let i = 0; i < 180; i++) { window.__vAdvance(1000 / 60); _simulationStep(); if (!_clrAt(a.x, a.y, VOWorld.clearance.tol) && Math.hypot(a.targetX - a.x, a.targetY - a.y) < 2) break; }
  ok(!_clrAt(a.x, a.y, VOWorld.clearance.tol), `steps out to clear floor (${Math.round(a.x)},${Math.round(a.y)})`);
  VOWorld.reset();
  ok(!VOWorld.check().some(v => v.id === a.id), 'invariant quiet after');
  return out;
}

// In page: `steps` simulation steps; a third of the agents flip work/idle every 20 s, a meeting at 30 s, a
// gathering at 60 s; returns the invariant hits.
function simulate(steps) {
  VOWorld.reset();
  let walked = 0;
  const side = { all: 0, free: 0, ex: [] };
  for (let i = 0; i < steps; i++) {
    const before = agents.map(a => [a.x, a.y]);
    if (i % 1200 === 0) agents.filter(a => !a.meetingId).forEach((a, k) => { if ((k + i / 1200) % 3) return; const w = a.state !== 'working'; a.task = w ? 'Clearance' : ''; a.moveTo(w ? 'working' : 'idle'); });
    if (i === 1800) { const slots = getMeetingSlots(); agents.filter(a => !a.meetingId).slice(0, Math.min(5, slots.length)).forEach((a, k) => a.joinMeeting('clr-meeting', slots[k], 'Clearance')); }
    if (i === 3600) { agents.forEach(a => { if (a.meetingId === 'clr-meeting') { a.leaveMeeting(); a.moveTo('idle'); } }); startGathering(); }
    window.__vAdvance(1000 / 60); _simulationStep();
    agents.forEach((a, k) => {
      const dx = a.x - before[k][0], dy = a.y - before[k][1];
      walked += Math.hypot(dx, dy);
      // a walker's drawn body beside a piece's art (side view when walking sideways): only on a band crossing
      if (!a.isSitting && (dx || dy) && !_worldSeatAt(a.x, a.y, 4) && VOWorld.sideHit(a.x, a.y, Math.abs(dx) > Math.abs(dy) ? VOWorld.clearance.bodySide : VOWorld.clearance.bodyW)) {
        side.all++;
        if (!_clrAt(a.x, a.y) && !_clrSpotNear(a.x, a.y)) { side.free++; if (side.ex.length < 3) side.ex.push(`${a.name} ${Math.round(a.x)},${Math.round(a.y)}`); }
      }
    });
  }
  window.__walked = Math.round(walked); window.__side = side;
  return VOWorld.log().map(v => `${v.kind}: ${v.who || ''} (${v.x},${v.y}) ${v.item || ''} [${v.state || ''}]`);
}

let passed = 0, failed = 0;
const ok = (c, what) => { if (c) { passed++; if (REPORT) console.log('  ok ' + what); } else { failed++; console.log('  FAIL ' + what); } };
const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
  for (const L of LAYOUTS) {
    const { page, errors, context } = await openOffice(browser, L.config, 12, 21);
    try {
      for (const [c, w] of await page.evaluate(rules)) ok(c, `${L.name}: ${w}`);
      for (const [c, w] of await page.evaluate(rest)) ok(c, `${L.name}: ${w}`);
      for (const [c, w] of await page.evaluate(elisCase)) ok(c, `${L.name}: ${w}`);
      if (L === LAYOUTS[0]) for (const [c, w] of await page.evaluate(bodyTypes)) ok(c, `${w}`);
      const hits = await page.evaluate(simulate, Math.round(MINUTES * 60 * 60));
      const walked = await page.evaluate(() => window.__walked), side = await page.evaluate(() => window.__side);
      ok(walked > 500 * MINUTES, `${L.name}: agents walked ${walked} px (the simulation ran)`);
      ok(side.free === 0, `${L.name}: walking, the drawn body beside a piece only on band crossings (${side.all} steps on crossings, ${side.free} elsewhere ${side.ex.join('; ')})`);
      ok(hits.length === 0, `${L.name}: ${MINUTES} simulated min, 12 agents, invariant every step: ${hits.length} hits ${[...new Set(hits)].slice(0, 4).join(' | ')}`);
      ok(errors.length === 0, `${L.name}: no page errors ${errors.slice(0, 2).join(' | ')}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
console.log(failed ? `test_v10_world_clearance: ${passed} passed, ${failed} FAILED` : `test_v10_world_clearance: ${passed} passed, 0 failed`);
process.exit(failed ? 1 : 0);
