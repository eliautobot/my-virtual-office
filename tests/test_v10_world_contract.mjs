// v0.10.1 world contract (W1): FURNITURE_MANIFEST is complete and true for every furniture type x rotation,
// and agents never start inside furniture. Headless Chrome, fixture APIs, nothing written.
// Contract (per type; every rotation when the type turns, else rotation 0):
//   - every type the app can draw or offer (catalog, _drawFurnitureArt cases, layouts) has a manifest entry;
//   - the drawn pixels stay inside the art bounds; every footprint lies inside the art;
//   - every seat's floor point and every stand spot is outside every footprint (a seat marked tuck may sit
//     under its own piece) and reachable from free floor (the game's own planWalk, strict);
//   - seat layering through the real frame: the sitter is drawn over its own piece, and what the manifest puts
//     in front of the sitter is there ('chair' / 'backrest' drawn by the sitter, 'cut' = the top over the hips);
//   - per-turn seat values stay near the turned rotation-0 seat (no typos); surface spots inside the surface;
//   - wall pieces sort with the wall and the editor only puts top-wall pieces on the top wall; counter pieces
//     only on a counter, standing on its top.
// Spawn: the default layout and the live 8096 layout (fixtures/world-layout-8096.json = anonymised copy; the live
// file named by WORLD_LIVE_CONFIG is read too when present, read only) with 1, 3,
// 12 and 30 agents: nobody inside a footprint, own or free desks only, standing spots spread out, a roster refresh
// moves nobody, a desk that gets an owner is handed over. WORLD_REPORT=1 prints every check.
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

function skip(reason) { console.log(`SKIP test_v10_world_contract: ${reason}`); process.exit(0); }
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

// Use spots known to stand inside a footprint (none since W2). Each listed one must still fail: a fixed one has to
// leave the list.
const KNOWN = {};  // W2 fixed the 6 pre-existing bad use spots (toaster, notice board, legacy lounge tv, legacy break area)
const ORIGIN = 'http://office.test';
const ROOM = {
  canvasWidth: 1200, canvasHeight: 900,
  walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#55606a', accentColor: '#3b444c', trimColor: '#ffffff' },
    sections: [{ x: 0, w: 1200, color: '#55606a', accentColor: '#3b444c' }], interior: [] },
  floor: { color1: '#c8c4bc', color2: '#bdb8af' }, furniture: [],
  branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }], agents: [], pet: { enabled: false },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };
function fixtures(config, n) {
  const ids = Array.from({ length: n }, (_, i) => 'w' + i);
  return {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.1', office: { name: 'World Test' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: ids.map((id, i) => ({ id, statusKey: id, name: 'Tester ' + i, emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true })) },
    '/status': Object.fromEntries(ids.map(id => [id, { state: 'idle', task: '' }])),
    '/agent-chat': {}, '/api/office-config': config, '/weather-proxy': { current_condition: [], configured: false },
  };
}
async function openPage(browser, config, n) {
  const FIX = fixtures(config, n);
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.route('**/*', async (r) => {
    const req = r.request(); const url = new URL(req.url());
    if (url.origin !== ORIGIN) return r.abort();
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (url.pathname === '/api/office-life/stream') return r.fulfill({ status: 200, contentType: 'text/event-stream', body: ': hi\n\n' });
    if (Object.prototype.hasOwnProperty.call(FIX, url.pathname)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX[url.pathname]) });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel); const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile())
      return r.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.addInitScript(() => {  // noon, frozen: no animation between the renders of one check
    const R = Date, base = new R(2026, 10, 4, 12, 0, 0).getTime();
    class FD extends R { constructor(...a) { if (a.length === 0) super(base); else super(...a); } static now() { return base; } }
    window.Date = FD;
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((k) => window.agents && window.agents.length >= k && window.VOOffice && window.FURNITURE_MANIFEST !== undefined, Math.min(n, 1), { timeout: 30000 });
  await page.waitForTimeout(400);
  return { page, errors, context };
}

// ---------------------------------------------------------------------------------------------
// In-page contract checks for one type x rotation. Returns [{ok, what}].
function typeContract(args) {
  const { type, rot } = args;
  const res = [];
  const ok = (cond, what) => res.push({ ok: !!cond, what: type + '/' + rot + ': ' + what });
  const M = FURNITURE_MANIFEST[type];
  const wallH = officeConfig.walls.height;
  const counterType = M.mount === 'surface';  // counter appliances (mount 'surface', z 25)
  // v0.13 variants: a key 'desk~analyst' is placed as {type: 'desk', variant: 'analyst'}
  const vi = type.indexOf('~'), it = Object.assign({ id: 'p', x: 600, y: 470, rotation: rot }, vi < 0 ? { type } : { type: type.slice(0, vi), variant: type.slice(vi + 1) });
  if (M.mount === 'wall') it.y = type === 'noticeBoard' ? 20 : type === 'clock' ? 40 : 10;
  if (type === 'branchSign') { it.branchId = 'HQ'; it.y = 42; }
  if (type === 'textLabel') it.text = 'Label';
  const counter = { id: 'k', type: 'kitchenCounter', x: 560, y: 470 };
  if (counterType) { it.x = 570; it.y = counter.y - M.bounds.h + 2; }
  const scene = counterType ? [counter, it] : [it];
  officeConfig.furniture = scene.map(o => Object.assign({}, o));
  getInteractionSpots(); buildCollisionGrid();
  const live = officeConfig.furniture[officeConfig.furniture.length - 1];
  const art = _getItemWorldRect(live);
  const inside = (p, r) => p.x > r.x + 0.01 && p.x < r.x + r.w - 0.01 && p.y > r.y + 0.01 && p.y < r.y + r.h - 0.01;
  // 1. drawn pixels inside the art bounds (solid pixels; soft shadows and light pools excluded)
  {
    const c = document.createElement('canvas'); c.width = 1400; c.height = 1000;
    const g = c.getContext('2d'), saved = window.ctx; window.ctx = g;
    // rotation rule: no draw call while the canvas is turned (every view is redrawn, never a turned picture)
    let turnedCalls = 0;
    ['fillRect', 'fill', 'stroke', 'strokeRect', 'drawImage', 'fillText', 'putImageData'].forEach(fn => {
      const o = g[fn]; g[fn] = function (...a) { const t = g.getTransform(); if (Math.abs(t.b) > 1e-9 || Math.abs(t.c) > 1e-9) turnedCalls++; return o.apply(g, a); };
    });
    try { drawFurnitureItem(live, { staticOnly: true }); } finally { window.ctx = saved; }
    ok(turnedCalls === 0, `no draw call under a turned canvas (${turnedCalls})`);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] >= 200) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
    const T = 2;
    ok(x1 > x0, 'draws something');
    ok(x0 >= art.x - T && y0 >= art.y - T && x1 <= art.x + art.w + T && y1 <= art.y + art.h + T,
      `drawn ${[x0, y0, x1, y1]} inside art ${[art.x, art.y, art.x + art.w, art.y + art.h].map(v => Math.round(v * 10) / 10)}`);
  }
  // 2. footprints inside the art
  const fps = _itemFootprints(live);
  fps.forEach((r, i) => ok(r.x >= art.x - 0.5 && r.y >= art.y - 0.5 && r.x + r.w <= art.x + art.w + 0.5 && r.y + r.h <= art.y + art.h + 0.5,
    `footprint ${i} ${[r.x, r.y, r.w, r.h]} inside art`));
  ok(M.mount === 'wall' || counterType || M.depth === 'label' || fps.length > 0, 'a floor piece has a footprint');
  // 3. seats and stand spots: outside every footprint, reachable from free floor
  const allFp = officeConfig.furniture.reduce((a, f) => a.concat(_itemFootprints(f).map(r => ({ r, f }))), []);
  const reach = (p) => { const w = planWalk(40, officeConfig.canvasHeight - 40, p.x, p.y, { strict: true }); return !!(w && !w.partial); };
  const seats = _itemSeatsWorld(live), stands = _itemStandWorld(live);
  seats.forEach(s => {
    const hit = allFp.filter(q => inside(s, q.r) && !(s.tuck && q.f === live));
    ok(!hit.length, `seat ${s.id} floor (${s.x},${s.y}) outside every footprint`);
    ok(reach(s), `seat ${s.id} reachable`);
  });
  stands.forEach(s => {
    ok(!allFp.some(q => inside(s, q.r)), `stand ${s.id} (${s.x},${s.y}) outside every footprint`);
    ok(s.y > wallH, `stand ${s.id} on the floor`);
    ok(reach(s), `stand ${s.id} reachable`);
  });
  // 3b. body box (review 11-06 ~12:20): a person standing on a stand spot or a seat's floor point (the walk's end before
  //     the hop into the seat) never overlaps the piece's drawn art side by side: wholly in front, wholly behind or
  //     beside with a gap (front / back view width; the meeting chairs are drawn seated where the walk stops)
  if (typeof _clrSideHit === 'function') {
    const sideHit = (s) => { const h = _clrSideHit(s.x, s.y, CLR.bodyW, officeConfig.furniture); return h ? ` beside ${h.item.type} [${[h.box.x, h.box.y, h.box.w, h.box.d].map(Math.round)}]` : ''; };
    stands.forEach(s => { const h = sideHit(s); ok(!h, `stand ${s.id} (${s.x},${s.y}): the body clear of the art${h}`); });
    seats.filter(s => s.kind !== 'meeting').forEach(s => { const h = sideHit(s); ok(!h, `seat ${s.id} floor (${s.x},${s.y}): the body clear of the art${h}`); });
  }
  // 4. per-turn seat values: the hips stand on the turned chair (VO 3/4 camera: the chair's turned plan front edge
  //    is 13 px under the hips, the hips within 6 px of its centre line)
  (M.seats || []).forEach(se => {
    if (!se.at || !se.at[rot]) return;
    if (se.stand) {  // v0.13 standing desk: no chair; the feet stand clear of the footprint, facing the desk
      const a = se.at[rot], fp = _itemFootprints(live), f = { x: live.x + a.x, y: live.y + a.y };
      ok(!fp.some(r => f.x > r.x && f.x < r.x + r.w && f.y > r.y && f.y < r.y + r.h), `stand seat ${se.id} at ${rot}: the feet clear of the footprint`);
      return;
    }
    const ch = (M.projection.parts || []).find(p => p.seat), r = _projTurn(ch.plan, rot), a = se.at[rot], q = [r[0] + r[2] / 2, r[1] + r[3] - 13];
    ok(Math.abs(q[0] - a.x) <= 6 && Math.abs(q[1] - a.y) <= 6, `seat ${se.id} at ${rot} (${a.x},${a.y}) on the turned chair (${q})`);
  });
  // 5. surface spots inside the surface
  if (M.surface && M.surface.spots) {
    // turned desks: the spots of the turned top face (spotsAt, world axes); the rotation-0 spots at rotation 0
    const sr = DESK_SEAT[type] ? _deskTopRect(live) : _rotatedLocalRect(live, ...M.surface.rect);
    if (!rot || !DESK_SEAT[type]) Object.keys(M.surface.spots).forEach(n => {
      const p = M.surface.spots[n], q = _rotXY(p[0] + 0.5, p[1] + 0.5, rot);
      ok(inside({ x: live.x + q[0], y: live.y + q[1] }, sr), `surface spot ${n} inside the surface`);
    });
    if (DESK_SEAT[type]) { const s = DESK_SEAT[type][rot]; ['item', 'food'].forEach(n => ok(inside({ x: live.x + s[n][0] + 6, y: live.y + s[n][1] + 4 }, sr), `DESK_SEAT ${n} on the desk top`)); }
  }
  if (M.surface && M.surface.counters) M.surface.counters.forEach((c, i) => {
    const r = { x: live.x + c.x, y: live.y + c.y, w: c.w, h: 1 };
    ok(r.x >= art.x && r.x + r.w <= art.x + art.w + 0.5 && r.y >= art.y && r.y <= art.y + art.h, `built-in counter ${i} inside the art`);
  });
  if (type === 'kitchenCounter' && !rot) ['coffeeMaker', 'microwave', 'toaster'].forEach(t => {
    const b = FURNITURE_BOUNDS[t], p = _snapToCounterTop(t, live.x + 20, live.y - 20);
    ok(p && Math.abs(p.y + b.h - (live.y + M.surface.top + 2)) < 0.5 && p.x >= live.x && p.x + b.w <= live.x + M.bounds.w, `${t} snaps onto the counter top`);
  });
  // 6. mounts and wall rules
  if (M.mount === 'wall') {
    ok(WALL_ITEM_TYPES[type], 'wall piece sorts with the wall');
    ok(art.y + art.h <= wallH + 2, 'wall piece inside the wall band');
    if (M.topWall) {
      ok(_placementProblem(type, 600, 400, 0, ['p']) !== '', 'refused on the floor');
      ok(_placementProblem(type, 200, it.y, 0, ['p']) === '', 'allowed on the top wall');
    }
  } else if (counterType) {
    officeConfig.furniture = [];
    ok(_placementProblem(type, 600, 400, 0, null) !== '', 'refused off a counter');
    officeConfig.furniture = [Object.assign({}, counter)];
    const p = _snapToCounterTop(type, counter.x + 20, counter.y - 20);
    ok(p && _placementProblem(type, p.x, p.y, 0, null) === '', 'allowed on a counter');
  } else if (M.depth !== 'label') {
    ok(!WALL_ITEM_TYPES[type] && !NO_DEPTH_TYPES[type], 'floor piece sorts with people');
    ok(_depthParts(live).length > 0, 'has depth parts');
  }
  // 7. VO 3/4 camera (perspective-audit.md section 3): projection data, derived art, drawn heights, shadows.
  const P = M.projection;
  ok(P && ['low', 'tall', 'wall', 'flat'].indexOf(P.class) >= 0, 'has a projection with a class');
  if (!P) return res;
  const body = (P.parts || []).filter(p => !p.upright && !p.seat);
  // low: the body's front face (upright screens/appliances may stand on it); tall: the whole height (the cooler's jug)
  const zh = P.asDrawn ? P.h : (P.class === 'tall' ? P.parts.filter(p => !p.seat) : body).reduce((m, p) => Math.max(m, (p.z || 0) + p.h), 0);
  // class ranges for pieces drawn on the camera (asDrawn = not rebuilt yet: class only)
  if (P.class === 'low' && !P.asDrawn) ok(zh <= 31, `low piece: front face ${zh} px <= 31 (1.1 m)`);
  if (P.class === 'tall' && !P.asDrawn) {
    ok(zh > 31 && (zh <= 54 || P.huge), `tall piece: front face ${zh} px in 32..54 (about a person)`);
    body.forEach(p => ok(p.cap >= 4 && p.cap <= 8, `tall part ${p.name}: cap ${p.cap} px in 4..8`));
  }
  if (P.class === 'flat') ok(zh <= 2, 'flat piece lies on the floor');
  if (P.class === 'wall') ok(M.mount === 'wall' && !(M.footprint || []).length, 'wall piece: on the wall, no floor footprint');
  (P.parts || []).forEach(p => ok(Array.isArray(p.plan) && p.plan.length === 4 && p.h >= 0 && (p.z || 0) >= 0, `part ${p.name} has plan + z + h`));
  // the art box is DERIVED from the projection (the bounds the editor and hit tests use)
  if (!rot) {
    const a = M.art, fr = _furnitureRect(live);
    ok(a && Math.abs(fr.x - (live.x + a[0])) < 0.01 && Math.abs(fr.y - (live.y + a[1])) < 0.01 && Math.abs(fr.w - a[2]) < 0.01 && Math.abs(fr.h - a[3]) < 0.01,
      `bounds = derived art ${a && a.map(v => Math.round(v * 100) / 100)}`);
    if (P.base !== undefined && !M.parts.some(q => q.seat === undefined && q.baseRect)) ok(Math.abs(_tallFurnitureSortY(live) - (live.y + P.base)) < 0.6, `depth base line = plan front ${P.base}`);
  }
  // drawn height, every view: the solid pixels span the parts' boxes at this turn (top within 2 px: drawn height -
  // turned plan depth = max(z + h); bottom = the turned plan front edge) plus the drawn boxes of that turn (the
  // chairs round a turned table); at rotation 0 pieces with extra drawn boxes (a table's placement box) and pieces
  // not rebuilt on the camera (asDrawn) are skipped. A turned view must exist for every turn the piece offers.
  const turnable = M.rotatable && !P.asDrawn;
  if (rot && turnable) ok(P.views && P.views[rot] && P.at && P.at[rot], `turn ${rot} has its own view (${P.views && P.views[rot]})`);
  if ((rot ? turnable : !P.asDrawn && !(P.drawn || []).length) && (P.parts || []).length) {
    const c = document.createElement('canvas'); c.width = 1400; c.height = 1000;
    const g = c.getContext('2d'), saved = window.ctx, sh = FLOOR_SHADOW; window.ctx = g; FLOOR_SHADOW = 'rgba(0,0,0,0)';
    try { drawFurnitureItem(live, { staticOnly: true }); if (type === 'meetingTable') _drawMeetingNearChairs(); } finally { window.ctx = saved; FLOOR_SHADOW = sh; }
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const solid = (x, y) => x >= 0 && y >= 0 && x < c.width && y < c.height && d[(y * c.width + x) * 4 + 3] >= 200;
    let y0 = 1e9, y1 = -1e9, x0 = 1e9, x1 = -1e9;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (solid(x, y)) { y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); }
    const dA = rot ? (typeof P.drawnAt === 'function' ? P.drawnAt(rot) : (P.drawnAt && P.drawnAt[rot])) || [] : [];
    const boxes = P.parts.map(p => _projBoxAt(p, rot)).concat(dA), top = live.y + Math.min(...boxes.map(b => b[1])), bot = live.y + Math.max(...boxes.map(b => b[1] + b[3]));
    ok(Math.abs(y0 - top) <= 2 && Math.abs(y1 - bot) <= 2, `drawn rows ${y0 - live.y}..${y1 - live.y} = projection ${top - live.y}..${bot - live.y} (2 px)`);
    // on-screen width per view (P3): the drawn columns = the projection's turned boxes (2 px), and the top face spans
    // the FULL turned plan of the top part: the solid run through its middle row at its centre = its turned width
    const lft = live.x + Math.min(...boxes.map(b => b[0])), rgt = live.x + Math.max(...boxes.map(b => b[0] + b[2]));
    ok(Math.abs(x0 - lft) <= 2 && Math.abs(x1 - rgt) <= 2, `drawn columns ${x0 - live.x}..${x1 - live.x} = projection ${lft - live.x}..${rgt - live.x} (2 px)`);
    const tp = P.parts.find(p => p.name === 'top');
    if (tp) {
      const r = _projTurn(tp.plan, rot), lift = (tp.z || 0) + tp.h, cy = Math.round(live.y + r[1] - lift + r[3] / 2);
      let cx = Math.round(live.x + r[0] + r[2] / 2), k = 0;
      while (!solid(cx, cy) && k < 6) { k++; if (solid(cx + k, cy)) cx += k; else if (solid(cx - k, cy)) cx -= k; }
      let a = cx, e = cx; while (solid(a - 1, cy)) a--; while (solid(e + 1, cy)) e++;
      ok(solid(cx, cy) && Math.abs(e - a + 1 - r[2]) <= 2, `top face run ${e - a + 1} px = turned plan width ${r[2]} (2 px)`);
    }
    if (rot) { const A = P.at[rot]; ok(Math.abs(_tallFurnitureSortY(live) - (live.y + A.base)) < 1.1, `depth base line = turned plan front ${A.base}`); }
  }
  // shadow = the turned footprint offset 3/3 (area within 10 %), never the art or selection box
  if ((M.footprint || []).length && M.shadow !== 'round' && M.shadow !== 'none') {
    const c = document.createElement('canvas'); c.width = 1400; c.height = 1000;
    const g = c.getContext('2d'), saved = window.ctx, art0 = window._drawFurnitureTurned; window.ctx = g; window._drawFurnitureTurned = function() {};
    try { drawFurnitureItem(live, { staticOnly: true }); } finally { window.ctx = saved; window._drawFurnitureTurned = art0; }
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, out = 0;
    const inFp = (x, y) => fps.some(r => x + 0.5 >= r.x + 3 && x + 0.5 <= r.x + 3 + r.w && y + 0.5 >= r.y + 3 && y + 0.5 <= r.y + 3 + r.h);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 0) { n++; if (!inFp(x, y)) out++; }
    let area = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (inFp(x, y)) area++;
    ok(area > 0 && Math.abs(n - area) <= area * 0.1 && out === 0, `shadow ${n} px = footprint ${area} px (10 %), ${out} px outside`);
  }
  // 8. screens face their user (P3), every view: desk / boss desk monitors face the chair (the hips lie in front of
  //    the screen's turned normal; lit screen pixels inside the monitor at 0, on the sitter's side of the casing in
  //    profile at 90/270, none at 180 = the casing back; the night glow centre between screen and sitter), the meeting
  //    laptop faces a seat, the front desk screen faces the receptionist (lit side away from the visitor's spot).
  const screenPx = () => {
    const c = document.createElement('canvas'); c.width = 1400; c.height = 1000;
    const g = c.getContext('2d'), saved = window.ctx, inUse = window._deskInUse; window.ctx = g;
    window._deskInUse = () => true;  // a desk in use (v0.10.1 I15: a free desk's screens are off)
    try { drawFurnitureItem(live, { staticOnly: true }); } finally { window.ctx = saved; window._deskInUse = inUse; }
    const d = g.getImageData(0, 0, c.width, c.height).data;
    return (r, test) => { let n = 0, sx = 0; for (let y = Math.floor(r.y); y < r.y + r.h; y++) for (let x = Math.floor(r.x); x < r.x + r.w; x++) { const i = (y * c.width + x) * 4; if (d[i + 3] >= 200 && test(d[i], d[i + 1], d[i + 2])) { n++; sx += x + 0.5; } } return { n, mx: n ? sx / n : null }; };
  };
  const lit = (r, gg, b) => b >= 140 && b - r >= 60;                    // screen blues (not the casing greys)
  const casing = (r, gg, b) => r < 70 && gg < 80 && b < 90 && b - r <= 30;
  if (DESK_SEAT[type]) {
    const mp = M.monitorPlan, seat = DESK_SEAT[type][rot], nv = _rotXY(0, 1, rot), px = screenPx();
    _deskMonitorRects(live).forEach((m, i) => {
      const pr = _projTurn(mp.plans[i], rot), mc = [pr[0] + pr[2] / 2, pr[1] + pr[3] / 2];
      ok((seat.hx - mc[0]) * nv[0] + (seat.hy - mc[1]) * nv[1] > 4, `monitor ${i} faces the chair (hips ${seat.hx},${seat.hy}, screen ${mc})`);
      const wk = _deskSeatPoses(seat, DESK_SEAT[type].wide).work, fv = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[wk.view];
      ok(fv && (mc[0] - seat.hx) * fv[0] + (mc[1] - seat.hy) * fv[1] > 4, `the sitter at work faces monitor ${i} (view ${wk.view})`);
      const R = { x: live.x + m.bx, y: live.y + m.by, w: m.bw, h: m.bh }, L = px(R, lit), K = px(R, casing);
      if (rot === 180) ok(m.view === 'back' && L.n === 0 && K.n > 20, `monitor ${i} at 180: the casing back toward us (${L.n} lit px)`);
      else if (rot) ok(m.view === 'side' && L.n > 4 && K.n > 4 && Math.sign(L.mx - K.mx) === Math.sign(nv[0]), `monitor ${i} in profile: the screen on the sitter's side (lit x ${L.mx}, casing x ${K.mx})`);
      else ok(L.n > 100, `monitor ${i} at 0: its screen toward the chair (${L.n} lit px)`);
      if (rot) ok((seat.hx - m.fx) * nv[0] + (seat.hy - m.fy) * nv[1] > 0 && (m.fx - mc[0]) * nv[0] + (m.fy - mc[1]) * nv[1] > 0, `monitor ${i} glow centre between the screen and the sitter`);
    });
  }
  if (type === 'meetingTable') {
    const lp = P.parts.find(p => p.name === 'laptop'), r = _projTurn(lp.plan, rot), nv = _rotXY(0, 1, rot);
    const c0 = [live.x + r[0] + r[2] / 2, live.y + r[1] + r[3] / 2];
    const faced = _meetingSeats(live).filter(s => s.kind).filter(s => { const v = [s.hx - c0[0], s.hy - c0[1]]; return v[0] * nv[0] + v[1] * nv[1] > 0 && Math.abs(v[0] * nv[1] - v[1] * nv[0]) <= 6; });
    ok(faced.length >= 1, `laptop faces a seat (${faced.map(s => s.kind + ' ' + s.hx + ',' + s.hy).join(' ')})`);
  }
  if (type === 'receptionDesk') {
    const sp = P.parts.find(p => p.name === 'screen'), r = _projTurn(sp.plan, rot), nv = _rotXY(0, -1, rot), st = _itemStandWorld(live)[0];
    const c0 = [live.x + r[0] + r[2] / 2, live.y + r[1] + r[3] / 2];
    ok((st.x - c0[0]) * nv[0] + (st.y - c0[1]) * nv[1] < 0, 'front desk screen faces the receptionist, away from the visitor spot');
    if (rot === 90 || rot === 270) {
      const px = screenPx(), R = { x: live.x + r[0] - 3, y: live.y + r[1] - 46, w: r[2] + 6, h: r[3] + 20 }, L = px(R, lit), K = px(R, casing);
      ok(L.n > 4 && K.n > 4 && Math.sign(L.mx - K.mx) === Math.sign(nv[0]), `front desk screen in profile lit toward the receptionist (lit x ${L.mx}, casing x ${K.mx})`);
    }
  }
  return res;
}

// Seat layering through the real frame: (a) piece alone, (b) + sitter, (e) + sitter without its front pass.
function seatLayering(args) {
  const { type, rot } = args;
  const res = [], ok = (cond, what) => res.push({ ok: !!cond, what: type + '/' + rot + ' layering: ' + what });
  const M = FURNITURE_MANIFEST[type];
  const vi = type.indexOf('~'), it = Object.assign({ id: 'p', x: 600, y: 470, rotation: rot }, vi < 0 ? { type } : { type: type.slice(0, vi), variant: type.slice(vi + 1) });
  officeConfig.furniture = [Object.assign({}, it)];
  const live = officeConfig.furniture[0];
  const seats = _itemSeatsWorld(live).map((s, i) => Object.assign({ i }, s));
  const a0 = agents[0];
  const park = () => agents.forEach(a => { a.x = a.targetX = -9000; a.y = a.targetY = -9000; a.desk = { x: -9000, y: -9000 }; a.isSitting = false; a.state = 'idle'; a.meetingId = null; a.idleAction = null; a._seatCache = null; });
  const art = _getItemWorldRect(live);
  const region = { x: Math.floor(art.x - 40), y: Math.floor(art.y - 80), w: Math.ceil(art.w + 80), h: Math.ceil(art.h + 120) };
  const grab = () => {
    for (let k = 0; k < 2; k++) { _invalidateStaticLayer(); _staticSigCheckedAt = -1e9; _renderFrame(performance.now()); }
    const o = _cameraOrigin();
    const X0 = Math.round((o.x + region.x * o.s) * DPR), Y0 = Math.round((o.y + region.y * o.s) * DPR);
    const w = Math.round(region.w * o.s * DPR), h = Math.round(region.h * o.s * DPR);
    return { d: ctx.getImageData(X0, Y0, w, h).data, w, h, X0, Y0, s: o.s * DPR, o };
  };
  camera.zoom = 2; camera.x = art.x + art.w / 2 - W / 2; camera.y = art.y + art.h / 2 - H / 2;
  park(); const A = grab();
  const toWorld = (k, G) => ({ x: region.x + ((k / 4) % G.w) / G.s, y: region.y + Math.floor((k / 4) / G.w) / G.s });
  for (const s of seats) {
    park();
    const a = a0;
    if (s.kind === 'desk' || s.kind === 'bossDesk') { a.x = a.targetX = live.x; a.y = a.targetY = live.y; a.desk = { x: live.x, y: live.y }; a.isSitting = true; a.state = 'working'; }
    else if (s.kind === 'meeting') { a.x = a.targetX = s.x; a.y = a.targetY = s.y; a.state = 'meeting'; a.meetingId = 'm1'; }
    else { a.x = a.targetX = s.hx; a.y = a.targetY = s.hy; a.isSitting = true; a.idleAction = 'couch'; }
    a._seatT = 1; a._seatFrom = null; a.path = []; a.tick = 100; a._walkFace = null; a._pvx = null; a._pvy = null;
    const B = grab();
    const info = a.seatInfo && a.seatInfo();
    ok(info && info.item === live, `seat ${s.id}: seated on the piece`);
    a._drawSeatFront = function () {};
    const E = grab();
    delete a._drawSeatFront;
    const box = a._bodyBox;
    let front = 0, frontSame = 0, visible = 0, cutCovered = 0, cutPx = 0;
    const kind = s.kind === 'meeting' ? (M.seatLayout.front[_meetingSeats(live)[+s.id.slice(1)].kind]) : null;
    const se = (M.seats || []).find(x => x.id === s.id) || {};
    const want = kind ? [kind] : (se.at && se.at[rot] && se.at[rot].front) || se.front || [];
    for (let k = 0; k < B.d.length; k += 4) {
      const fb = B.d[k] !== E.d[k] || B.d[k + 1] !== E.d[k + 1] || B.d[k + 2] !== E.d[k + 2];
      const ea = E.d[k] !== A.d[k] || E.d[k + 1] !== A.d[k + 1] || E.d[k + 2] !== A.d[k + 2];
      if (fb) { front++; if (B.d[k] === A.d[k] && B.d[k + 1] === A.d[k + 1] && B.d[k + 2] === A.d[k + 2]) frontSame++; }
      const p = toWorld(k, B);
      if (ea && p.x >= art.x && p.x < art.x + art.w && p.y >= art.y && p.y < art.y + art.h) visible++;
      if (box && p.x >= box.x && p.x < box.x + box.w && p.y >= box.y && p.y < box.y + box.h && p.y >= Math.min(live.y - 200, art.y)) { cutPx++; if (!ea) cutCovered++; }
    }
    ok(visible >= 30, `seat ${s.id}: sitter drawn over its own piece (${visible} px)`);
    const facesAway = s.facing === 'up';
    if (!want.length) ok(front === 0, `seat ${s.id}: nothing drawn over the sitter (${front} px)`);
    if (want.includes('chair')) ok(front >= 6, `seat ${s.id}: chair front drawn over the sitter (${front} px)`);
    if (want.includes('backrest')) ok(facesAway ? front >= 6 : front === 0, `seat ${s.id}: couch back over the hips only when facing away (${front} px, facing ${s.facing})`);
    if (want.includes('cut')) ok(front === 0 && cutCovered > 0, `seat ${s.id}: table top over the hips (${cutCovered} px of the body box left as the table)`);
  }
  park();
  return res;
}

function spawnRun(args) {
  const { n, boss } = args;
  const out = [];
  const ok = (cond, what) => out.push({ ok: !!cond, what: args.label + ' x' + n + ': ' + what });
  const list = Array.from({ length: n }, (_, i) => ({ id: 's' + i, statusKey: 's' + i, name: boss && i === 0 ? 'Boss' : 'Spawn ' + i, emoji: '🤖', role: 'T', providerKind: 'openclaw', available: true }));
  agents.length = 0;
  AGENT_DEFS = _buildAgentDefs(list); _autoAssignDesks(AGENT_DEFS); _rosterLoaded = true; _initAgentsFromDefs();
  buildCollisionGrid();
  const items = officeConfig.furniture, desks = items.filter(f => f.type === 'desk' || f.type === 'bossDesk');
  const main = _mainFloorTiles(), cols = Math.ceil(W / TILE);
  const used = new Map(), standing = [];
  const fp = items.reduce((a, f) => a.concat(_itemFootprints(f).map(r => ({ r, f }))), []);
  // v0.10.1: a desk assigned to someone who is not in this office is free
  const ownerHere = f => !!f.assignedTo && list.some(x => x.name === f.assignedTo || x.id === f.assignedTo);
  agents.forEach(a => {
    ok(a.x === a.desk.x && a.y === a.desk.y, `${a.name} starts at its own spot`);
    const d = desks.find(f => f.x === a.desk.x && f.y === a.desk.y);
    if (d) {
      ok(!ownerHere(d) || d.assignedTo === a.name, `${a.name} sits at its own or a free desk`);
      ok(!used.has(d), `${a.name} does not share a desk`); used.set(d, a);
      const info = a.seatInfo && a.seatInfo();
      return;
    }
    const foot = { x: a.x - 6, y: a.y - 3, w: 12, h: 6 };
    const hit = fp.filter(q => _rectsOverlap(foot, q.r));
    ok(!hit.length, `${a.name} at (${a.x},${a.y}) outside every footprint${hit.length ? ' (in ' + hit[0].f.type + ')' : ''}`);
    ok(main.has(Math.floor(a.y / TILE) * cols + Math.floor(a.x / TILE)), `${a.name} on the main walkable floor`);
    standing.push(a);
  });
  const freeDesks = desks.filter(f => !ownerHere(f)).length;
  ok(used.size >= Math.min(freeDesks, n - (boss ? 1 : 0)), `free desks taken first (${used.size} desks for ${n} agents, ${freeDesks} free)`);
  if (boss) ok(desks.some(f => f.assignedTo === 'Boss' && f.x === agents[0].desk.x && f.y === agents[0].desk.y), 'Boss starts at the desk assigned to it');
  for (let i = 0; i < standing.length; i++) for (let j = i + 1; j < standing.length; j++) {
    const p = standing[i], q = standing[j];
    ok(Math.hypot(p.x - q.x, p.y - q.y) >= 30, `${p.name} and ${q.name} stand apart`);
  }
  // N5 (v0.10.1): a reload with the roster in another order gives every agent the same place
  const first = Object.fromEntries(agents.map(a => [a.id, a.desk.x + ',' + a.desk.y]));
  _rosterLoaded = false;
  const again = _buildAgentDefs(list.slice().reverse()); _autoAssignDesks(again);
  _rosterLoaded = true;
  ok(again.every(d => first[d.id] === d._autoDesk.x + ',' + d._autoDesk.y), 'a reload (roster in another order) gives everyone the same place');
  // a roster refresh moves nobody; a newcomer takes a new place
  const before = agents.map(a => a.desk.x + ',' + a.desk.y).join(';');
  const more = list.concat([{ id: 'late', statusKey: 'late', name: 'Late', emoji: '🤖', role: 'T', providerKind: 'openclaw', available: true }]);
  AGENT_DEFS = _buildAgentDefs(more); _autoAssignDesks(AGENT_DEFS);
  ok(AGENT_DEFS.slice(0, n).map(d => d._autoDesk.x + ',' + d._autoDesk.y).join(';') === before, 'a roster refresh keeps everyone where they are');
  const late = AGENT_DEFS[n]._autoDesk;
  ok(!agents.some(a => a.desk.x === late.x && a.desk.y === late.y), 'the newcomer gets a place of its own');
  // a free desk that gets an owner is handed over
  const borrowed = desks.find(f => !f.assignedTo && agents.some(a => a.desk.x === f.x && a.desk.y === f.y));
  if (borrowed && n >= 3) {
    const sitter = agents.find(a => a.desk.x === borrowed.x && a.desk.y === borrowed.y);
    const owner = agents.find(a => a !== sitter && !desks.some(f => f.assignedTo === a.name));
    borrowed.assignedTo = owner.name;
    _syncAgentToDesk(borrowed);
    ok(owner.desk.x === borrowed.x && owner.desk.y === borrowed.y && !(sitter.desk.x === borrowed.x && sitter.desk.y === borrowed.y), 'a desk that gets an owner is handed over');
    delete borrowed.assignedTo;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
let failed = 0, passed = 0;
const knownSeen = new Set();
function tally(results) {
  for (const r of results) {
    if (KNOWN[r.what]) {
      if (r.ok) { failed++; console.log('FAIL known violation is fixed now, take it off KNOWN: ' + r.what); }
      else { passed++; knownSeen.add(r.what); console.log('known (W2): ' + r.what + ' - ' + KNOWN[r.what]); }
      continue;
    }
    if (r.ok) passed++; else { failed++; console.log('FAIL ' + r.what); }
    if (REPORT && r.ok) console.log('ok   ' + r.what);
  }
}
try {
  // --- contract ---
  {
    const { page, errors, context } = await openPage(browser, ROOM, 2);
    await page.evaluate(() => {
      window.__zFreeze = true; window._runSimulation = function () { return 0; }; window._shouldDrawFrame = function () { return true; };
      window.drawAgentActivityChips = function () {}; window._drawMiniMap = function () {}; window.drawChatBubbles = function () {};
      if (window.VOLife) window.VOLife.drawScreen = function () {};
      agents.forEach(a => { a.update = function () {}; });
      if (window.officePets) officePets.length = 0;
      if (typeof _weatherTick !== 'undefined') _weatherTick = 1000;
    });
    // coverage: every type the app can draw or offer has a manifest entry
    const src = fs.readFileSync(path.join(APP, 'game.js'), 'utf8');
    const fn = src.slice(src.indexOf('function _drawFurnitureArt('), src.indexOf('\n}\n', src.indexOf('function _drawFurnitureArt(')));
    const drawn = [...fn.matchAll(/case '([A-Za-z]+)':/g)].map(m => m[1]).filter(t => t !== 'wall' && t !== 'door');
    const layoutTypes = [path.join(APP, 'default-office-config.json'), path.join(here, 'fixtures', 'world-layout-8096.json')]
      .flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')).furniture.map(x => x.type));
    const cov = await page.evaluate((extra) => {
      const want = new Set(extra.concat(['lounge', 'breakArea', 'fridge']));
      // wall / door are editor tools that write officeConfig.walls.interior (drawn by the wall pass), never furniture
      CATALOG_CATEGORIES.forEach(c => c.items.forEach(i => { if (i.type !== 'wall' && i.type !== 'door') want.add(i.type); }));
      Object.keys(FURNITURE_BOUNDS).forEach(t => want.add(t));
      return { missing: [...want].filter(t => !FURNITURE_MANIFEST[t]), unknown: !!FURNITURE_MANIFEST._unknown, all: Object.keys(FURNITURE_MANIFEST).filter(t => t !== '_unknown'),
        rot: Object.fromEntries(Object.keys(FURNITURE_MANIFEST).map(t => [t, !!FURNITURE_MANIFEST[t].rotatable])) };
    }, drawn.concat(layoutTypes));
    tally([{ ok: cov.missing.length === 0, what: 'every type has a manifest entry (missing: ' + cov.missing.join(', ') + ')' },
      { ok: cov.unknown, what: 'the unknown-type placeholder has an entry' },
      { ok: drawn.length >= 30, what: `found the drawn types (${drawn.length})` }]);
    const types = cov.all.concat(['_unknown']);
    for (const type of types) {
      for (const rot of cov.rot[type] ? [0, 90, 180, 270] : [0]) {
        const t = type === '_unknown' ? 'zzNoSuchType' : type;
        if (t === 'zzNoSuchType') {
          const r = await page.evaluate(() => { officeConfig.furniture = [{ id: 'u', type: 'zzNoSuchType', x: 600, y: 470 }];
            const fp = _itemFootprints(officeConfig.furniture[0]), a = _getItemWorldRect(officeConfig.furniture[0]);
            return fp.length === 1 && fp[0].x >= a.x && fp[0].y >= a.y && fp[0].x + fp[0].w <= a.x + a.w && fp[0].y + fp[0].h <= a.y + a.h; });
          tally([{ ok: r, what: 'unknown type: placeholder footprint inside its 40x40 crate' }]);
          continue;
        }
        tally(await page.evaluate(typeContract, { type: t, rot }));
        if (['desk', 'bossDesk', 'meetingTable', 'couch', 'engLounge'].includes(t.split('~')[0])) tally(await page.evaluate(seatLayering, { type: t, rot }));
      }
    }
    // legacy composites migrate on load to catalog pieces (perspective P2): no two pieces overlap on the floor, the
    // appliances stand on the counters, every seat and stand spot is outside every footprint and reachable
    tally(await page.evaluate(() => {
      const res = [], ok = (c, w) => res.push({ ok: !!c, what: 'legacy migration: ' + w });
      const list = _migrateLegacyFurniture([{ id: 'L', type: 'lounge', x: 300, y: 300 }, { id: 'B', type: 'breakArea', x: 700, y: 300 }, { id: 'd', type: 'desk', x: 300, y: 600 }]);
      officeConfig.furniture = list; getInteractionSpots(); buildCollisionGrid();
      ok(!list.some(f => f.type === 'lounge' || f.type === 'breakArea') && list.length === 14 && list.some(f => f.id === 'd'), 'composites replaced, others kept (' + list.map(f => f.type).join(',') + ')');
      ok(_migrateLegacyFurniture(list) === list, 'a migrated list is left alone');
      const fps = []; list.forEach(f => _itemFootprints(f).forEach(r => fps.push({ r, f })));
      const clash = []; fps.forEach((a, i) => fps.forEach((b, j) => { if (j > i && a.f !== b.f && a.r.x < b.r.x + b.r.w && a.r.x + a.r.w > b.r.x && a.r.y < b.r.y + b.r.h && a.r.y + a.r.h > b.r.y) clash.push(a.f.id + '/' + b.f.id); }));
      ok(!clash.length, 'no floor overlaps (' + clash.join(' ') + ')');
      list.filter(f => (FURNITURE_MANIFEST[f.type] || {}).mount === 'surface').forEach(f => ok(_isOnCounter(f.type, f.x, f.y), f.type + ' on a counter'));
      const inside = (p, r) => p.x > r.x + 0.01 && p.x < r.x + r.w - 0.01 && p.y > r.y + 0.01 && p.y < r.y + r.h - 0.01;
      const reach = (p) => { const w = planWalk(40, officeConfig.canvasHeight - 40, p.x, p.y, { strict: true }); return !!(w && !w.partial); };
      list.forEach(f => _itemSeatsWorld(f).concat(_itemStandWorld(f)).forEach(p => ok(!fps.some(q => inside(p, q.r) && !(p.tuck && q.f === f)) && reach(p), f.id + ' ' + p.id + ' outside every footprint and reachable')));
      return res;
    }));
    tally([{ ok: errors.length === 0, what: 'no page errors in the contract page (' + errors.slice(0, 2).join(' | ') + ')' }]);
    await context.close();
  }
  // --- spawn ---
  const layouts = [['default', JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8')), false],
    ['live-copy', JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'world-layout-8096.json'), 'utf8')), true]];
  try { if (fs.existsSync(LIVE_FILE)) layouts.push(['live-file', JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')), false]); } catch { /* unreadable: the copy covers it */ }
  for (const [label, cfg, boss] of layouts) {
    const { page, errors, context } = await openPage(browser, cfg, 1);
    await page.evaluate(() => { window._runSimulation = function () { return 0; }; });
    for (const n of [1, 3, 12, 30]) tally(await page.evaluate(spawnRun, { label, n, boss }));
    tally([{ ok: errors.length === 0, what: label + ': no page errors (' + errors.slice(0, 2).join(' | ') + ')' }]);
    await context.close();
  }
} finally {
  await browser.close();
}
for (const k of Object.keys(KNOWN)) if (!knownSeen.has(k)) { failed++; console.log('FAIL known violation not seen (renamed?): ' + k); }
console.log(`test_v10_world_contract: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} world contract checks failed`);
console.log('ALL WORLD CONTRACT CHECKS PASSED');
