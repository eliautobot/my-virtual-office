// v0.10.1 z-order (what is drawn in front of what), headless Chrome, fixture APIs, nothing written.
// Every case is a small scene drawn through the real _renderFrame four times: group P on/off x group Q
// on/off (a group = furniture, people, pets or walls; everything else stays). In the pixels where P and Q
// overlap the test decides which one is on top (soft drop shadows are left out) and checks it against
// the 3/4 top-down rules: the thing whose floor (base) line is lower is in front, things on a surface go
// with the surface, wall items are behind everyone, an interior wall face covers what stands behind it.
// Cases: walk-past matrix (a person behind / in front / beside / on the tile row of every piece), seated
// people vs pieces in front, pets, overlapping pieces in both array orders, live (dynamic) pieces vs pieces
// in front, pieces and people near a horizontal interior wall. Then draw-order checks for Office Life
// desk props, the gathering circle and the chat bubbles. ZORDER_REPORT=1 prints every case.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.Z_APP || path.resolve(here, '..', 'app'));
const REPORT = !!process.env.ZORDER_REPORT;
const ONLY = process.env.ZORDER_ONLY || '';
const require = createRequire(import.meta.url);

function skip(reason) { console.log(`SKIP test_v10_zorder: ${reason}`); process.exit(0); }
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
const NAMES = ['Ava', 'Ben', 'Cy', 'Dee'];
const FIXTURES = {
  '/api/license': { demo: false, valid: true, limits: {} },
  '/vo-config': { version: '0.10.1', office: { name: 'Z Office' }, features: {}, weather: { location: null } },
  '/api/agents': { agents: NAMES.map((n, i) => ({ id: 'z' + i, statusKey: 'z' + i, name: n, emoji: '🤖', role: 'Tester',
    providerKind: 'openclaw', available: true })) },
  '/status': Object.fromEntries(NAMES.map((n, i) => ['z' + i, { state: 'idle', task: '' }])),
  '/agent-chat': {},
  '/api/office-config': {
    canvasWidth: 1200, canvasHeight: 800,
    walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#55606a', accentColor: '#3b444c', trimColor: '#ffffff' },
      sections: [{ x: 0, w: 1200, color: '#55606a', accentColor: '#3b444c' }], interior: [] },
    floor: { color1: '#c8c4bc', color2: '#bdb8af' },
    furniture: [],
    branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
    agents: [], pet: { enabled: false },
  },
  '/weather-proxy': { current_condition: [], configured: false },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };
async function route(routeObj) {
  const request = routeObj.request();
  const url = new URL(request.url());
  if (url.origin !== ORIGIN) return routeObj.abort();
  if (request.method() !== 'GET' && request.method() !== 'HEAD') return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  if (url.pathname === '/api/office-life/stream') return routeObj.fulfill({ status: 200, contentType: 'text/event-stream', body: ': hi\n\n' });
  if (Object.prototype.hasOwnProperty.call(FIXTURES, url.pathname)) return routeObj.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES[url.pathname]) });
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const file = path.resolve(APP, rel);
  const ext = path.extname(file);
  if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return routeObj.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
  }
  return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
}

// ---------------------------------------------------------------------------------------------
// In-page helper: freezes the office, builds a scene, renders the 4 variants, classifies pixels.
function installHelper() {
  window.__zFreeze = true; // the noon clock (init script) stops: no animation between the 4 renders
  window._runSimulation = function () { return 0; };
  window._shouldDrawFrame = function () { return true; };
  window.drawAgentActivityChips = function () {};
  window._drawMiniMap = function () {};
  const realBubbles = window.drawChatBubbles;
  window.__zRealBubbles = realBubbles;
  window.drawChatBubbles = function () {};
  if (window.VOLife) window.VOLife.drawScreen = function () {};
  const OFF = -9000;
  const actorsAll = agents.slice();
  function rectOfItem(it) { return _furnitureRect(it); }
  function placeActor(a, s, on) {
    const x = on ? s.x : OFF, y = on ? s.y : OFF;
    a.x = a.targetX = x; a.y = a.targetY = y;
    a.path = []; a.idleAction = null; a.carryItem = null; a.state = s.state || 'idle'; a._statusState = a.state;
    a.tick = 0; a.meetingId = null; a._lifeHold = null; a._lifePose = null; a._lifeCarry = null;
    a.isSitting = !!(on && s.sit);
    a.desk = s.desk ? { x: s.desk.x, y: s.desk.y } : { x: OFF, y: OFF };
    a._seatT = on && (s.sit || s.meeting) ? 1 : 0;
    a._walkFace = s.view || 'down'; a._pvx = x; a._pvy = y; a.faceDir = s.view === 'left' ? -1 : 1;
    a.chatOpen = false; a.characterRect = null;
  }
  function frame() {
    _invalidateStaticLayer();
    _staticSigCheckedAt = -1e9;
    _renderFrame(performance.now());
  }
  window.__zCase = function (spec) {
    // The walk matrix checks the steady state (redraws blitted from cached sprites), the other scenes the
    // live path used while the camera moves.
    if (typeof DEPTH_SPRITE_REST_MS !== 'undefined') DEPTH_SPRITE_REST_MS = spec.sprites ? 0 : 1e9;
    if (typeof DEPTH_SPRITE_BUILDS !== 'undefined') DEPTH_SPRITE_BUILDS = 99;
    const items = spec.furniture || [], walls = spec.walls || [], actors = spec.actors || [], pets = spec.pets || [];
    const inP = new Set(spec.P), inQ = new Set(spec.Q);
    const petObjs = pets.map(p => { const o = new OfficePet({ species: p.species || 'cat', x: p.x, y: p.y }); o.name = ''; o.state = 'sitting'; o.stateTimer = 1e9; return o; });
    function setup(pOn, qOn) {
      const on = id => (inP.has(id) ? pOn : inQ.has(id) ? qOn : true);
      officeConfig.furniture = items.filter(it => on(it.id)).map(it => Object.assign({}, it));
      officeConfig.walls.interior = walls.filter(w => on(w.id)).map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }));
      agents.length = 0; actorsAll.forEach(a => agents.push(a));
      actorsAll.forEach((a, i) => { const s = actors[i]; placeActor(a, s || {}, !!s && on(s.id)); });
      officePets.length = 0;
      petObjs.forEach((o, i) => { const p = pets[i]; const v = on(p.id); o.x = o.targetX = v ? p.x : OFF; o.y = o.targetY = v ? p.y : OFF; officePets.push(o); });
      // two warm-up frames: seat easing, desk lookups, caches
      frame(); frame();
    }
    // Region: union of the scene's rects (world px) -> device px.
    let rx0 = 1e9, ry0 = 1e9, rx1 = -1e9, ry1 = -1e9;
    const grow = (x, y, w, h) => { rx0 = Math.min(rx0, x); ry0 = Math.min(ry0, y); rx1 = Math.max(rx1, x + w); ry1 = Math.max(ry1, y + h); };
    items.forEach(it => { const r = rectOfItem(it); grow(r.x - 4, r.y - 50, r.w + 8, r.h + 60); });
    actors.forEach(s => grow(s.x - 30, s.y - 80, 60, 100));
    pets.forEach(p => grow(p.x - 30, p.y - 40, 60, 60));
    walls.forEach(w => grow(Math.min(w.x1, w.x2) * TILE - 8, w.y1 * TILE - 60, Math.abs(w.x2 - w.x1) * TILE + 16, Math.abs(w.y2 - w.y1) * TILE + 70));
    if (spec.region) { rx0 = spec.region.x; ry0 = spec.region.y; rx1 = rx0 + spec.region.w; ry1 = ry0 + spec.region.h; }
    const o = _cameraOrigin();
    const X0 = Math.max(0, Math.floor((o.x + rx0 * o.s) * DPR)), Y0 = Math.max(0, Math.floor((o.y + ry0 * o.s) * DPR));
    const X1 = Math.min(canvas.width, Math.ceil((o.x + rx1 * o.s) * DPR)), Y1 = Math.min(canvas.height, Math.ceil((o.y + ry1 * o.s) * DPR));
    const w = X1 - X0, h = Y1 - Y0;
    const grab = () => ctx.getImageData(X0, Y0, w, h).data;
    if (spec.fidelity && typeof DEPTH_SPRITE_REST_MS === 'undefined') return { diff: 0, sprites: 0 };
    if (spec.fidelity) { // sprite blits vs live drawing of the same scene: the same pixels
      DEPTH_SPRITE_REST_MS = 0; setup(true, true); const S = grab();
      const sprites = _depthLayout().parts.filter(q => q._spr && q._spr.c).length;
      DEPTH_SPRITE_REST_MS = 1e9; setup(true, true); const L = grab();
      let diff = 0;
      for (let i = 0; i < S.length; i += 4) if (Math.abs(S[i] - L[i]) + Math.abs(S[i + 1] - L[i + 1]) + Math.abs(S[i + 2] - L[i + 2]) > 6) diff++;
      return { diff, sprites };
    }
    setup(true, true); const A = grab();
    setup(false, true); const B = grab();   // Q only
    setup(true, false); const C = grab();   // P only
    setup(false, false); const D = grab();  // neither
    setup(true, true);
    const same = (u, v, i) => Math.abs(u[i] - v[i]) <= 6 && Math.abs(u[i + 1] - v[i + 1]) <= 6 && Math.abs(u[i + 2] - v[i + 2]) <= 6;
    const shade = (u, i) => { // u is a soft darkening of the bare floor (drop shadow): not "solid"
      let lo = 9, hi = 0;
      for (let k = 0; k < 3; k++) { if (D[i + k] < 40) return false; const r = u[i + k] / D[i + k]; lo = Math.min(lo, r); hi = Math.max(hi, r); }
      return lo >= 0.66 && hi <= 0.92 && hi - lo < 0.08;
    };
    let overlap = 0, pTop = 0, qTop = 0, other = 0, pPx = 0, pVis = 0;
    for (let i = 0; i < A.length; i += 4) {
      const qSolid = !same(B, D, i) && !shade(B, i), pSolid = !same(C, D, i) && !shade(C, i);
      if (pSolid) { pPx++; if (same(A, C, i)) pVis++; }
      if (!qSolid || !pSolid) continue;
      overlap++;
      const isQ = same(A, B, i), isP = same(A, C, i);
      if (isP && !isQ) pTop++; else if (isQ && !isP) qTop++; else other++;
    }
    if (spec.dump) {
      const cv = document.createElement('canvas'); cv.width = w * 4 + 12; cv.height = h; const g = cv.getContext('2d');
      [A, B, C, D].forEach((buf, k) => g.putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), k * (w + 4), 0));
      return { dump: cv.toDataURL('image/png') };
    }
    if (spec.debug) {
      let bd = 0, cd = 0, rep = 0; setup(true, true); const A2 = grab();
      for (let i = 0; i < A.length; i += 4) { if (!same(B, D, i)) bd++; if (!same(C, D, i)) cd++; if (!same(A, A2, i)) rep++; }
      return { overlap, pTop, qTop, other, pPx, pVis, px: A.length / 4, bd, cd, rep };
    }
    return { overlap, pTop, qTop, other, pPx, pVis };
  };
  // Draw-order checks that are not about furniture (Z-14, Z-15, Z-17).
  const PXX = 520, PYY = 420;
  function setup2(items, actors) {
    officeConfig.furniture = items.map(it => Object.assign({}, it)); officeConfig.walls.interior = []; officePets.length = 0;
    agents.length = 0; actorsAll.forEach(a => agents.push(a));
    actorsAll.forEach((a, i) => placeActor(a, actors[i] || {}, !!actors[i]));
    frame(); frame();
  }
  window.__zOrderChecks = function () {
    const out = {};
    const count = (x, y, w, h, test) => {
      const o = _cameraOrigin(), X = Math.round((o.x + x * o.s) * DPR), Y = Math.round((o.y + y * o.s) * DPR);
      const d = ctx.getImageData(X, Y, Math.round(w * o.s * DPR), Math.round(h * o.s * DPR)).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++; return n;
    };
    const magenta = (r, g, b) => r > 240 && g < 20 && b > 240;
    // Z-14: Office Life desk props are drawn with the desk: a person in front covers them, a person behind does not.
    const life = window.VOLife, keep = life && life.drawDesk;
    if (life) life.drawDesk = (c, owners) => owners.forEach(a => { c.fillStyle = '#ff00ff'; c.fillRect(a.desk.x + 22, a.desk.y - 14, 8, 8); });
    const desk = { id: 'd', type: 'desk', x: PXX, y: PYY };
    const sit = { id: 's', x: PXX, y: PYY, sit: true, desk: { x: PXX, y: PYY } };
    setup2([desk], [sit]);
    const alone = count(PXX + 22, PYY - 14, 8, 8, magenta);
    setup2([desk], [sit, { id: 'w', x: PXX + 26, y: PYY + 20 }]);
    const covered = count(PXX + 22, PYY - 14, 8, 8, magenta);
    setup2([desk], [sit, { id: 'w', x: PXX + 26, y: PYY - 24 }]);
    const behind = count(PXX + 22, PYY - 14, 8, 8, magenta);
    if (life) life.drawDesk = keep;
    out.deskProps = { alone, covered, behind };
    // Z-15: the gathering circle lies on the floor, under the members (their pixels unchanged).
    const g = { id: 'zg', spot: { x: PXX, y: PYY }, members: ['z0', 'z1'], phase: 'socializing', timer: 0, socializeDuration: 1e9, activeInteractions: [], interactionCooldown: 0 };
    const body = () => { const o = _cameraOrigin(); return ctx.getImageData(Math.round((o.x + (PXX - 12) * o.s) * DPR), Math.round((o.y + (PYY - 40) * o.s) * DPR), Math.round(24 * o.s * DPR), Math.round(30 * o.s * DPR)).data; };
    setup2([], [{ id: 'a', x: PXX, y: PYY }]); const plain = body();
    groupGatherings.push(g); setup2([], [{ id: 'a', x: PXX, y: PYY }]); const inCircle = body(); groupGatherings.splice(groupGatherings.indexOf(g), 1);
    let tinted = 0; for (let i = 0; i < plain.length; i += 4) if (Math.abs(plain[i] - inCircle[i]) + Math.abs(plain[i + 2] - inCircle[i + 2]) > 4) tinted++;
    out.circle = { tinted };
    // Z-17: collapsed chat icons: front-most owner last.
    const order = [], realIcon = window._drawChatTabIcon;
    window._drawChatTabIcon = a => order.push(a.name);
    const keys = agents.slice(0, 3).map(a => a.statusKey);
    setup2([], [{ id: 'a', x: PXX, y: PYY + 60 }, { id: 'b', x: PXX + 60, y: PYY - 40 }, { id: 'c', x: PXX - 60, y: PYY + 10 }]);
    keys.forEach(k => { agentChatData[k] = [{ role: 'assistant', text: 'hi', ts: Date.now() }]; chatMinimized[k] = true; });
    try { window.__zRealBubbles(); } finally { window._drawChatTabIcon = realIcon; keys.forEach(k => { delete agentChatData[k]; delete chatMinimized[k]; }); }
    out.icons = { order, expected: agents.slice(0, 3).slice().sort((p, q) => p.y - q.y).map(a => a.name) };
    // Night: things in the air and minigame extras are drawn before the light map (lit like the people).
    const calls = [], names = ['drawAirplanes', 'drawRPS', 'drawSocialInteractions', 'drawGatherings', 'drawDartGames', 'drawPongGames', 'drawAmbientOverlay'];
    const real = names.map(n => window[n]);
    names.forEach((n, k) => { window[n] = function () { calls.push(n); return real[k].apply(this, arguments); }; });
    const lifeWorld = life && life.drawWorld;
    if (life) life.drawWorld = function () { calls.push('VOLife.drawWorld'); return lifeWorld.apply(this, arguments); };
    try { frame(); } finally { names.forEach((n, k) => { window[n] = real[k]; }); if (life) life.drawWorld = lifeWorld; }
    out.night = { order: calls };
    return out;
  };
  // World bbox of what a piece really paints (no drop shadow), from a render with and without it.
  window.__zArt = function (it) {
    const r = _furnitureRect(it), m = 40;
    const o = _cameraOrigin();
    const X0 = Math.max(0, Math.floor((o.x + (r.x - m) * o.s) * DPR)), Y0 = Math.max(0, Math.floor((o.y + (r.y - m) * o.s) * DPR));
    const w = Math.ceil((r.w + 2 * m) * o.s * DPR), h = Math.ceil((r.h + 2 * m) * o.s * DPR);
    agents.forEach(a => placeActor(a, {}, false)); officePets.length = 0; officeConfig.walls.interior = [];
    officeConfig.furniture = [Object.assign({ id: 'f' }, it)]; frame(); const B = ctx.getImageData(X0, Y0, w, h).data;
    officeConfig.furniture = []; frame(); const D = ctx.getImageData(X0, Y0, w, h).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const solid = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(B[i] - D[i]) <= 6 && Math.abs(B[i + 1] - D[i + 1]) <= 6 && Math.abs(B[i + 2] - D[i + 2]) <= 6) continue;
      let lo = 9, hi = 0, ok = true;
      for (let k = 0; k < 3; k++) { if (D[i + k] < 40) { ok = false; break; } const q = B[i + k] / D[i + k]; lo = Math.min(lo, q); hi = Math.max(hi, q); }
      if (ok && lo >= 0.66 && hi <= 0.92 && hi - lo < 0.08) continue; // drop shadow
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      solid.push(x, y);
    }
    // centre x of the lowest rows: where the piece reaches furthest to the front (an L-couch's daybed)
    let sx = 0, sn = 0;
    for (let k = 0; k < solid.length; k += 2) if (solid[k + 1] >= y1 - 8 * DPR) { sx += solid[k]; sn++; }
    const wx = X => ((X0 + X) / DPR - o.x) / o.s, wy = Y => ((Y0 + Y) / DPR - o.y) / o.s;
    return x1 < 0 ? { x: r.x, y: r.y, w: r.w, h: r.h, bx: r.x + r.w / 2 } :
      { x: Math.round(wx(x0)), y: Math.round(wy(y0)), w: Math.round(wx(x1 + 1) - wx(x0)), h: Math.round(wy(y1 + 1) - wy(y0)), bx: Math.round(wx(sx / sn)) };
  };
}

// ---------------------------------------------------------------------------------------------
// Cases.
const FLOOR_TYPES = ['desk', 'bossDesk', 'trashCan', 'filingCabinet', 'whiteboard', 'plant', 'tallPlant', 'meetingTable',
  'engLounge', 'pingPongTable', 'dartBoard', 'vendingMachine', 'waterCooler', 'coffeeMaker', 'microwave', 'toaster',
  'bookshelf', 'couch', 'endTable', 'coffeeTable', 'tv', 'kitchenCounter', 'floorLamp', 'receptionDesk', 'fridge',
  'lounge', 'breakArea'];
const WALL_TYPES = ['window', 'interactiveWindow', 'clock', 'noticeBoard'];
const PX = 520, PY = 420; // where each piece is placed
let SEATS = null; // seat spots of pieces placed at PX, PY (from the page)

function walkCases(rects) {
  const out = [];
  for (const type of FLOOR_TYPES) {
    const it = { id: 'f', type, x: PX, y: PY };
    const r = rects[type];
    const cx = Math.round(r.x + r.w / 2), bot = r.y + r.h, bx = r.bx;
    const behindY = Math.round(r.y + Math.min(r.h * 0.35, Math.max(8, r.h - 30)));
    // (an L-couch or a composite has gaps: a side position that meets no art is skipped)
    const add = (pos, x, y, expect) => out.push({ name: `walk ${type} ${pos}`, furniture: [it], actors: [{ id: 'p', x, y }], P: ['p'], Q: ['f'], expect, sprites: true, optional: pos.startsWith('side') || /lounge|breakArea/.test(type) });
    add('behind', cx, behindY, 'Q');
    add('behind-left', Math.round(r.x + 8), behindY, 'Q');
    add('behind-right', Math.round(r.x + r.w - 8), behindY, 'Q');
    add('front', bx, Math.round(bot + 4), 'P');
    add('front-left', Math.round(r.x + 6), Math.round(bot + 2), 'P');
    add('side-front', Math.round(r.x - 4), Math.round(bot + 1), 'P');
    // (the L-couch's right side is its daybed's back: a walker at the back-right corner is in front of the main
    // backrest and behind the daybed's back, no single answer; v0.10.1 volumes)
    if (type !== 'couch') add('side-behind', Math.round(r.x + r.w + 4), behindY, 'Q');
    // a realistic route: the centre of the tile row just behind the piece's front edge
    const tileY = 20 + 40 * Math.floor((bot - 12 - 20) / 40);
    if (type !== 'couch' && tileY >= r.y + 4 && tileY < bot - 12 && tileY <= r.y + r.h * 0.6) add('tile-row', bx, tileY, 'Q');
  }
  for (const type of WALL_TYPES) {
    const it = { id: 'f', type, x: PX, y: PY };
    const r = rects[type];
    const cx = Math.round(r.x + r.w / 2);
    for (const [pos, y] of [['behind', Math.round(r.y + r.h * 0.4)], ['front', Math.round(r.y + r.h + 4)]]) {
      out.push({ name: `walk ${type} ${pos} (wall item)`, furniture: [it], actors: [{ id: 'p', x: cx, y }], P: ['p'], Q: ['f'], expect: 'P' });
    }
  }
  return out;
}

function sceneCases(rects) {
  const out = [];
  const seatOf = (type, rot) => SEATS.desk.find(d => d[0] === type && d[1] === rot)[2];  // a desk seat's hips (world)
  const R = (t, x, y) => { const b = rects[t]; return { x: b.x - PX + x, y: b.y - PY + y, w: b.w, h: b.h }; };
  // Pets walk behind pieces like people.
  for (const type of ['desk', 'coffeeTable', 'kitchenCounter', 'bookshelf']) {
    const r = R(type, PX, PY);
    out.push({ name: `pet behind ${type}`, furniture: [{ id: 'f', type, x: PX, y: PY }], pets: [{ id: 'c', x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h * 0.45) }], P: ['c'], Q: ['f'], expect: 'Q' });
  }
  // Seated at a desk: a plant / tall plant / bin in front of the chair covers the sitter, a desk behind does not.
  for (const rot of [0, 90, 270]) {
    const desk = { id: 'd', type: 'desk', x: PX, y: PY, rotation: rot };
    const sitter = { id: 's', x: PX, y: PY, sit: true, desk: { x: PX, y: PY } };
    // rot 0: the sitter faces the desk (back view, the chair back over its hips): the plant's leaves reach its back;
    // turned: from the seat (v0.13 seat reach moved it: 0.12 had (PX - 22, PY + 16) / (PX + 4, PY + 16))
    const st = seatOf('desk', rot);
    const front = rot === 0 ? { x: PX - 8, y: PY + 2 } : rot === 90 ? { x: st.x - 7, y: st.y + 14 } : { x: st.x - 11, y: st.y + 14 };
    out.push({ name: `seated desk ${rot} vs tall plant in front`, furniture: [desk, { id: 'f', type: 'tallPlant', x: front.x, y: front.y }], actors: [sitter], P: ['s'], Q: ['f'], expect: 'Q' });
  }
  for (const rot of [0, 90]) {
    const desk = { id: 'd', type: 'bossDesk', x: PX, y: PY, rotation: rot };
    const sitter = { id: 's', x: PX, y: PY, sit: true, desk: { x: PX, y: PY } };
    const front = rot === 0 ? { x: PX - 10, y: PY + 12 } : { x: PX - 34, y: PY + 20 };
    out.push({ name: `seated boss ${rot} vs tall plant in front`, furniture: [desk, { id: 'f', type: 'tallPlant', x: front.x, y: front.y }], actors: [sitter], P: ['s'], Q: ['f'], expect: 'Q' });
  }
  // Someone beside a sitter, between the desk front and the chair base: behind the sitter (Z-18);
  // a little further forward: in front of the sitter.
  // (from the seat: v0.13 seat reach moved the chair 9 px in; 0.12 had the hips at PY + 13)
  const s0 = seatOf('desk', 0);
  out.push({ name: 'person beside a sitter, behind the chair', furniture: [{ id: 'd', type: 'desk', x: PX, y: PY }],
    actors: [{ id: 's', x: PX, y: PY, sit: true, desk: { x: PX, y: PY } }, { id: 'w', x: s0.x + 22, y: s0.y + 7 }], P: ['s'], Q: ['w'], expect: 'P' });
  out.push({ name: 'person beside a sitter, in front', furniture: [{ id: 'd', type: 'desk', x: PX, y: PY }],
    actors: [{ id: 's', x: PX, y: PY, sit: true, desk: { x: PX, y: PY } }, { id: 'w', x: s0.x + 22, y: s0.y + 27 }], P: ['s'], Q: ['w'], expect: 'Q' });
  out.push({ name: 'person behind an empty chair', furniture: [{ id: 'd', type: 'desk', x: PX, y: PY }],
    actors: [{ id: 'w', x: s0.x + 4, y: s0.y + 7 }], P: ['w'], Q: ['d'], expect: 'Q', region: { x: s0.x - 20, y: s0.y + 2, w: 40, h: 14 } }); // the chair below the desk legs
  // Seated people (seating's seatInfo/sortY) vs standing neighbours: someone just behind the seat is
  // covered by the sitter, someone in front covers the sitter. Desks and boss desks at every turn,
  // every meeting side, couches at every turn. (Sitter vs its own piece: test_v10_seating_*; here the
  // piece cannot be switched off without unseating the sitter.)
  for (const [type, rot, c] of SEATS.desk) {
    const desk = { id: 'd', type, x: PX, y: PY, rotation: rot }, sitter = { id: 's', x: PX, y: PY, sit: true, desk: { x: PX, y: PY } };
    // just behind the sitter's feet (at 0 beside the chair, in front of the desk legs)
    const behind = rot % 180 ? { x: c.x + 4, y: c.y - 16 } : rot ? { x: c.x + 20, y: c.y - 4 } : { x: c.x + 22, y: c.y + 7 };
    out.push({ name: `seated ${type} ${rot} vs walker behind`, furniture: [desk], actors: [sitter, Object.assign({ id: 'w' }, behind)], P: ['s'], Q: ['w'], expect: 'P' });
    // in front: 30 px; a boss desk turned 180 keeps the walker where 0.12 had it (inside the desk's plan, the head over
    // the top: the v0.13 seat reach moved the seat 4 px toward it and the two no longer meet at 30)
    const fwd = type === 'bossDesk' && rot === 180 ? 26 : 30;
    out.push({ name: `seated ${type} ${rot} vs walker in front`, furniture: [desk], actors: [sitter, { id: 'w', x: c.x + 4, y: c.y + fwd }], P: ['s'], Q: ['w'], expect: 'Q' });
  }
  for (const m of SEATS.meet) {
    const table = { id: 't', type: 'meetingTable', x: PX, y: PY }, sitter = { id: 's', x: m.x, y: m.y, meeting: true };
    out.push({ name: `meeting ${m.kind} sitter vs walker behind`, furniture: [table], actors: [sitter, { id: 'w', x: m.hx + 4, y: m.hy - 14 }], P: ['s'], Q: ['w'], expect: 'P' });
    if (m.kind !== 'top') out.push({ name: `meeting ${m.kind} sitter vs walker in front`, furniture: [table], actors: [sitter, { id: 'w', x: m.hx + 4, y: m.hy + 30 }], P: ['s'], Q: ['w'], expect: 'Q' });
  }
  for (const [rot, c] of SEATS.couch) {
    const couch = { id: 'c', type: 'couch', x: PX, y: PY, rotation: rot }, sitter = { id: 's', x: c.x, y: c.y, sit: true };
    // walkers just outside the couch (never on it); a sitter perched on a deep couch may not meet them: optional
    out.push({ name: `couch ${rot} sitter vs walker behind`, furniture: [couch], actors: [sitter, { id: 'w', x: c.x + 4, y: c.top - 6 }], P: ['s'], Q: ['w'], expect: 'P', optional: true });
    out.push({ name: `couch ${rot} sitter vs walker in front`, furniture: [couch], actors: [sitter, { id: 'w', x: c.x + 4, y: c.bot + 12 }], P: ['s'], Q: ['w'], expect: 'Q', optional: rot !== 0 });
  }
  // A walker behind a desk somebody sits at: the desk covers the walker, the sitter stays.
  out.push({ name: 'walker behind an occupied desk', furniture: [{ id: 'd', type: 'desk', x: PX, y: PY }],
    actors: [{ id: 'w', x: PX + 6, y: PY - 26 }, { id: 's', x: PX, y: PY, sit: true, desk: { x: PX, y: PY } }], P: ['w'], Q: ['d'], expect: 'Q' });
  // Two people: strict base order (the lower feet in front).
  out.push({ name: 'two people overlapping', actors: [{ id: 'a', x: PX, y: PY }, { id: 'b', x: PX + 10, y: PY + 12 }], P: ['a'], Q: ['b'], expect: 'Q' });
  // Overlapping pieces, both array orders: the lower base line wins (Z-09).
  const pairs = [
    ['plant behind a desk corner', { type: 'plant', x: PX + 20, y: PY - 34 }, { type: 'desk', x: PX, y: PY }, 'B'],
    ['floor lamp behind a couch', { type: 'floorLamp', x: PX + 30, y: PY + 16 }, { type: 'couch', x: PX, y: PY }, 'B'],
    ['bin in front of a desk leg', { type: 'trashCan', x: PX + 30, y: PY + 10 }, { type: 'desk', x: PX, y: PY }, 'A'],
    ['tall plant behind a counter', { type: 'tallPlant', x: PX + 30, y: PY - 40 }, { type: 'kitchenCounter', x: PX, y: PY }, 'B'],
    ['coffee maker on a counter', { type: 'coffeeMaker', x: PX + 6, y: PY - 20 }, { type: 'kitchenCounter', x: PX, y: PY }, 'A'],
    ['toaster on a counter', { type: 'toaster', x: PX + 40, y: PY - 14 }, { type: 'kitchenCounter', x: PX, y: PY }, 'A'],
    ['end table in front of a bookshelf', { type: 'endTable', x: PX + 10, y: PY + 66 }, { type: 'bookshelf', x: PX, y: PY }, 'A'],
  ];
  for (const [name, a, b, win] of pairs) {
    for (const order of ['AB', 'BA']) {
      const ia = Object.assign({ id: 'a' }, a), ib = Object.assign({ id: 'b' }, b);
      out.push({ name: `pair ${name} (${order})`, furniture: order === 'AB' ? [ia, ib] : [ib, ia], P: ['a'], Q: ['b'], expect: win === 'A' ? 'P' : 'Q' });
    }
  }
  // Live (dynamic) pieces vs a still piece in front of them (Z-07).
  const dyn = [
    ['TV behind a couch back', { type: 'tv', x: PX + 40, y: PY - 26 }, { type: 'couch', x: PX, y: PY }],
    ['water cooler behind a plant', { type: 'waterCooler', x: PX, y: PY }, { type: 'plant', x: PX - 4, y: PY + 34 }],
    ['microwave behind a plant', { type: 'microwave', x: PX, y: PY }, { type: 'plant', x: PX + 4, y: PY + 16 }],
    ['window behind a bookshelf', { type: 'interactiveWindow', x: PX + 10, y: PY }, { type: 'bookshelf', x: PX, y: PY + 10 }],
  ];
  for (const [name, d, s] of dyn) {
    out.push({ name: `dynamic ${name}`, furniture: [Object.assign({ id: 's' }, s), Object.assign({ id: 'd' }, d)], P: ['d'], Q: ['s'], expect: 'Q' });
  }
  // Horizontal interior wall at tile row 10 (y = 400), x 200..760.
  const WY = 400, wall = { id: 'w', x1: 5, y1: 10, x2: 19, y2: 10 };
  const wallCases = [
    // pieces just below the wall: their art rises over the face (Z-04)
    ['desk at wall+20', { type: 'desk', x: 400, y: WY + 20 }],
    ['desk at wall+40', { type: 'desk', x: 400, y: WY + 40 }],
    ['boss desk at wall+30', { type: 'bossDesk', x: 400, y: WY + 30 }],
    ['front desk at wall+14', { type: 'receptionDesk', x: 400, y: WY + 14 }],
    ['water cooler at wall-8', { type: 'waterCooler', x: 400, y: WY - 8 }],    // v0.10.1 camera: person-height cooler (art from y - 7)
    ['floor lamp at wall+14', { type: 'floorLamp', x: 400, y: WY + 14 }],
    ['dart board at wall+14', { type: 'dartBoard', x: 400, y: WY + 14 }],
    ['bookshelf at wall-24', { type: 'bookshelf', x: 400, y: WY - 24 }],     // v0.10.1 camera: 53 + cap 4 (art from y + 17)
  ];
  for (const [name, f] of wallCases) {
    out.push({ name: `wall: ${name} over the face`, walls: [wall], furniture: [Object.assign({ id: 'f' }, f)], P: ['f'], Q: ['w'], expect: 'P' });
  }
  out.push({ name: 'wall: plant behind the wall', walls: [wall], furniture: [{ id: 'f', type: 'tallPlant', x: 400, y: WY - 60 }], P: ['f'], Q: ['w'], expect: 'Q' });
  // People and the wall face (Z-13): behind, in front, past the wall end.
  out.push({ name: 'wall: person behind', walls: [wall], actors: [{ id: 'p', x: 400, y: WY - 12 }], P: ['p'], Q: ['w'], expect: 'Q' });
  out.push({ name: 'wall: person in front', walls: [wall], actors: [{ id: 'p', x: 400, y: WY + 16 }], P: ['p'], Q: ['w'], expect: 'P' });
  out.push({ name: 'wall: person behind, a few px past the wall end', walls: [wall], actors: [{ id: 'p', x: 772, y: WY - 12 }], P: ['p'], Q: ['w'], expect: 'Q' });
  out.push({ name: 'wall: person behind, a few px before the wall start', walls: [wall], actors: [{ id: 'p', x: 190, y: WY - 12 }], P: ['p'], Q: ['w'], expect: 'Q' });
  // A seated agent at a desk whose art straddles the wall line goes with the desk (Z-10).
  out.push({ name: 'wall: sitter at a desk in the wall band', walls: [wall], furniture: [{ id: 'd', type: 'desk', x: 400, y: WY - 10 }],
    actors: [{ id: 's', x: 400, y: WY - 10, sit: true, desk: { x: 400, y: WY - 10 } }], P: ['s'], Q: ['w'], expect: 'visible' });
  out.push({ name: 'wall: sitter at a desk at wall+20', walls: [wall], furniture: [{ id: 'd', type: 'desk', x: 400, y: WY + 20 }],
    actors: [{ id: 's', x: 400, y: WY + 20, sit: true, desk: { x: 400, y: WY + 20 } }], P: ['s'], Q: ['w'], expect: 'visible' });
  return out;
}

// ---------------------------------------------------------------------------------------------
const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
let failures = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  await context.route('**/*', route);
  // Local noon (daylight: no night light pools or glow), frozen once the helper is installed.
  await context.addInitScript(() => {
    const R = Date, base = new R(2026, 10, 4, 12, 0, 0).getTime(), t0 = R.now();
    const t = () => base + (window.__zFreeze ? 0 : R.now() - t0);
    class FD extends R { constructor(...a) { if (a.length === 0) super(t()); else super(...a); } static now() { return t(); } }
    window.Date = FD;
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length >= 4 && window.VOOffice && typeof displayW === 'number', null, { timeout: 20000 });
  await page.waitForTimeout(700);
  await page.evaluate(installHelper);
  const rects = {};
  for (const t of FLOOR_TYPES.concat(WALL_TYPES)) rects[t] = await page.evaluate(it => window.__zArt(it), { type: t, x: PX, y: PY });
  SEATS = await page.evaluate(([x, y]) => {
    const desk = [];
    for (const type of ['desk', 'bossDesk']) for (const rot of [0, 90, 180, 270]) { const s = _deskSeatSpot({ type, rotation: rot }); desk.push([type, rot, { x: x + s.hx, y: y + s.hy }]); }
    const meet = [], kinds = new Set();
    _meetingSeats({ type: 'meetingTable', x, y }).forEach(s => { if (s.kind && !kinds.has(s.kind)) { kinds.add(s.kind); meet.push({ kind: s.kind, x: s.x, y: s.y, hx: s.hx, hy: s.hy }); } });
    const couch = [0, 90, 180, 270].map(rot => {
      const it = { type: 'couch', x, y, rotation: rot }, o = []; _addCouchSeats(it, o);
      // the couch's floor contact at the walker's x: walkers stand outside it (VO 3/4 camera: the couch is 40 deep)
      const fp = _itemFootprints(it).filter(r => o[0].x + 4 >= r.x && o[0].x + 4 <= r.x + r.w);
      return [rot, { x: o[0].x, y: o[0].y, top: Math.min(...fp.map(r => r.y)), bot: Math.max(...fp.map(r => r.y + r.h)) }];
    });
    return { desk, meet, couch };
  }, [PX, PY]);
  if (process.env.ZORDER_BBOX) { for (const t in rects) { const r = rects[t]; console.log(`${t}: x ${r.x - PX} y ${r.y - PY} w ${r.w} h ${r.h}`); } }
  const cases = walkCases(rects).concat(sceneCases(rects)).filter(c => !ONLY || c.name.includes(ONLY));
  if (process.env.ZORDER_DEBUG) cases.forEach(c => { c.debug = true; });
  let walk = 0, walkOk = 0, skipped = 0;
  for (const c of cases) {
    if (process.env.ZORDER_DUMP) {
      const d = await page.evaluate(spec => window.__zCase(Object.assign({ dump: true }, spec)), c);
      fs.writeFileSync(process.env.ZORDER_DUMP, Buffer.from(d.dump.split(',')[1], 'base64'));
    }
    const r = await page.evaluate(spec => window.__zCase(spec), c);
    // Wrong order shows as clean pixels of the thing that should be behind; blended pixels (glass,
    // a silhouette on a wall face, soft highlights) are not wrong.
    const decided = c.expect === 'visible' ? r.pPx : r.overlap;
    const share = decided ? (c.expect === 'visible' ? r.pVis : decided - (c.expect === 'P' ? r.qTop : r.pTop)) / decided : 0;
    if (c.optional && decided < 8) { skipped++; if (REPORT) console.log(`skip ${c.name}: nothing overlaps`); continue; }
    const ok = decided >= 8 && share >= 0.85;
    if (c.name.startsWith('walk ')) { walk++; if (ok) walkOk++; }
    const line = `${ok ? 'ok  ' : 'FAIL'} ${c.name}: overlap ${r.overlap}, ${c.expect} on top ${(share * 100).toFixed(0)}% (P ${r.pTop} / Q ${r.qTop} / mixed ${r.other})`;
    if (!ok) failures.push(line);
    if (REPORT || !ok) console.log(line + (c.debug ? ' ' + JSON.stringify(r) : ''));
  }
  // Office Life desk props, gathering circle, chat icons.
  if (!ONLY) {
    const r = await page.evaluate(() => window.__zOrderChecks());
    const checks = [
      [`desk props drawn with the desk (${r.deskProps.alone} px shown)`, r.deskProps.alone >= 40],
      [`a person in front of the desk covers its props (${r.deskProps.covered} px left)`, r.deskProps.covered < r.deskProps.alone * 0.5],
      [`a person behind the desk does not (${r.deskProps.behind} px)`, r.deskProps.behind === r.deskProps.alone],
      [`gathering circle under the members (${r.circle.tinted} body px tinted)`, r.circle.tinted === 0],
      [`chat icons front-most last (${r.icons.order.join(',')})`, r.icons.order.join(',') === r.icons.expected.join(',')],
      [`world extras before the light map (${r.night.order.join(',')})`, r.night.order.length >= 7 && r.night.order[r.night.order.length - 1] === 'drawAmbientOverlay'],
    ];
    for (const [name, ok] of checks) {
      const line = `${ok ? 'ok  ' : 'FAIL'} ${name}`;
      if (!ok) failures.push(line);
      if (REPORT || !ok) console.log(line);
    }
  }
  // Sprite fidelity: a redraw blitted from its sprite paints exactly what the live redraw paints.
  for (const c of cases.filter(c => /^walk (desk|bossDesk|couch|bookshelf|kitchenCounter|meetingTable) behind$/.test(c.name))) {
    const r = await page.evaluate(spec => window.__zCase(Object.assign({}, spec, { fidelity: true })), c);
    const bad = r.diff || !r.sprites;
    const line = `${bad ? 'FAIL' : 'ok  '} sprite = live: ${c.name}: ${r.sprites} sprite(s), ${r.diff} px differ`;
    if (bad) failures.push(line);
    if (REPORT || bad) console.log(line);
  }
  console.log(`[${failures.length ? 'FAIL' : 'PASS'}] z-order scenes: ${cases.length - skipped - failures.length}/${cases.length - skipped} (walk-past ${walkOk}/${walk}; ${skipped} beside-the-art positions skipped)`);
  assert.deepEqual(errors, [], 'page errors');
  await context.close();
} finally {
  await browser.close();
}
if (failures.length) { console.log(`FAIL test_v10_zorder: ${failures.length} case(s)`); process.exit(1); }
console.log('PASS test_v10_zorder');
