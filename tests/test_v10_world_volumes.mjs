// v0.10.1 world volumes (review 11-05: "the area covered in XYZ directions needs to be properly accounted for"):
// every drawn thing is a set of 3D boxes (furniture parts from the manifest projection per rotation, people,
// pets, wall faces) and the frame's draw order between overlapping things comes from those boxes. Headless
// Chrome, fixture APIs, nothing written. Per furniture type x rotation x placement (behind, in front, beside at
// mid-depth on both sides, seated in its first seat, at its first stand spot, carrying a coffee in front, a pet
// in front / behind / beside), a person or pet and the piece alone in the office:
//   - the frame's order (VOWorld.order(): the person after or before the piece's parts it overlaps) is the
//     expected one: behind -> the piece in front; in front / at a stand spot / carrying / seated on it -> the
//     person in front; beside a LOW piece -> the person in front (its torso is above the top: the old base-line
//     order put the piece over the person's side); beside a tall piece -> the piece (no 3D answer: base line);
//   - the pixels agree (four renders through the real _renderFrame: both / piece only / person only / none; in
//     the overlap the expected one is on top);
//   - wall items: a person standing below the wall is in front;
//   - the 3D invariant (VOWorld.check) fires for a person standing at a desk's anchor, a pet inside a vending
//     machine's back, a person inside an end table's top, and not for a seated owner or a person at a stand spot.
// WORLD_REPORT=1 prints every case; VOL_ONLY=<type> runs one type.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.WORLD_APP || path.resolve(here, '..', 'app'));
const REPORT = !!process.env.WORLD_REPORT;
const ONLY = process.env.VOL_ONLY || '';
const require = createRequire(import.meta.url);

function skip(reason) { console.log(`SKIP test_v10_world_volumes: ${reason}`); process.exit(0); }
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

async function openOffice(browser) {
  const config = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
  const list = ['a1', 'a2', 'a3'].map(id => ({ id, statusKey: id, name: 'Vol ' + id, emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }));
  const FIX = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.1', office: { name: 'Volumes' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: list }, '/status': Object.fromEntries(list.map(a => [a.id, { state: 'idle', task: '' }])),
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
  await context.addInitScript(() => {
    const R = Date, base = new R(2026, 10, 4, 12, 0, 0).getTime();  // noon, frozen: no animation between renders
    class VD extends R { constructor(...a) { if (a.length === 0) super(base); else super(...a); } static now() { return base; } }
    window.Date = VD;
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length >= 3 && window.VOWorld && window.officeConfig && officeConfig.furniture.length > 3, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  return { page, errors, context };
}

// In page: the scene runner (P = the person or pet, Q = the piece).
function install() {
  window._runSimulation = function () { return 0; }; window._shouldDrawFrame = function () { return true; };
  window.drawAgentActivityChips = function () {}; window._drawMiniMap = function () {}; window.drawChatBubbles = function () {};
  if (window.VOLife) window.VOLife.drawScreen = function () {};
  if (typeof DEPTH_SPRITE_REST_MS !== 'undefined') DEPTH_SPRITE_REST_MS = 1e9;
  const OFF = -9000, A0 = agents.slice(), pet = new OfficePet({ species: 'cat', x: OFF, y: OFF });
  pet.name = ''; pet.state = 'sitting'; pet.stateTimer = 1e9;
  const frame = () => { _invalidateStaticLayer(); _staticSigCheckedAt = -1e9; _renderFrame(performance.now()); };
  const park = (a) => { a.x = a.targetX = OFF; a.y = a.targetY = OFF; a.desk = { x: OFF, y: OFF }; a.isSitting = false; a.state = 'idle'; a.meetingId = null;
    a.idleAction = null; a.carryItem = null; a._lifeHold = null; a._path = null; a._seatGoal = null; a._lastSeat = null; a._seatT = 1; a._seatFrom = null; a.tick = 100; };
  window.__vScene = function (spec) {
    officeConfig.walls.interior = [];
    const item = Object.assign({ id: 'v' }, spec.item);
    const on = (pOn, qOn) => {
      officeConfig.furniture = qOn ? [Object.assign({}, item)] : [];
      agents.length = 0; A0.forEach(a => { agents.push(a); park(a); });
      officePets.length = 0; pet.x = pet.targetX = OFF; pet.y = pet.targetY = OFF; officePets.push(pet);
      buildCollisionGrid();
      const s = spec.who;
      if (pOn && s.pet) { pet.x = pet.targetX = s.x; pet.y = pet.targetY = s.y; }
      else if (pOn) {
        const a = A0[0];
        a.x = a.targetX = s.x; a.y = a.targetY = s.y; a._walkFace = s.view || 'down'; a._pvx = s.x; a._pvy = s.y;
        if (s.sit === 'desk') { a.desk = { x: item.x, y: item.y }; a.isSitting = true; a.state = 'working'; a.task = 'Volumes'; }
        else if (s.sit === 'meeting') { a.state = 'meeting'; a.meetingId = 'm1'; }
        else if (s.sit) { a.isSitting = true; a.idleAction = 'couch'; }
        if (s.carry) a.carryItem = 'coffee';
      }
      frame(); frame();
    };
    // Region: the piece's art and the actor's body.
    const live0 = Object.assign({}, item), r = _getItemWorldRect(live0), s = spec.who;
    const rx0 = Math.min(r.x, s.x - 30) - 4, ry0 = Math.min(r.y, s.y - 80) - 4, rx1 = Math.max(r.x + r.w, s.x + 30) + 4, ry1 = Math.max(r.y + r.h, s.y + 20) + 4;
    const o = _cameraOrigin();
    const X0 = Math.max(0, Math.floor((o.x + rx0 * o.s) * DPR)), Y0 = Math.max(0, Math.floor((o.y + ry0 * o.s) * DPR));
    const w = Math.min(canvas.width, Math.ceil((o.x + rx1 * o.s) * DPR)) - X0, h = Math.min(canvas.height, Math.ceil((o.y + ry1 * o.s) * DPR)) - Y0;
    const grab = () => ctx.getImageData(X0, Y0, w, h).data;
    on(true, false); const C = grab();
    on(false, true); const B = grab();
    on(false, false); const D = grab();
    on(true, true); const A = grab();
    // the frame's order: the actor after (P) or before (Q) the piece's parts it overlaps
    const live = officeConfig.furniture[0], actor = s.pet ? pet : A0[0];
    const valid = !VOWorld.feetIn(s.x, s.y) || !!s.sit;
    let order = '-';
    if (VOWorld.order) {
      const L = VOWorld.order(), ai = L.indexOf(actor), box = s.pet ? { x: pet.x - 16, y: pet.y - 30, w: 32, h: 38 } : (actor._bodyBox || { x: s.x - 17, y: s.y - 52, w: 34, h: 62 });
      let before = 0, after = 0;
      _depthLayout().parts.forEach(q => {
        if (q._tallItem !== live || !_rectsOverlap(q.rect, box)) return;
        const qi = L.findIndex(e => e.item === live && e.part === (q.part || '') && e.chair === !!q.chair);
        if (qi < 0 || ai < 0) return;
        if (qi < ai) before++; else after++;
      });
      order = after ? 'Q' : before ? 'P' : '-';
      if (actor._depthSeat === live) order = 'P';  // a sitter's own piece is never drawn over it (the seat hole)
    }
    const same = (u, v, i) => Math.abs(u[i] - v[i]) <= 6 && Math.abs(u[i + 1] - v[i + 1]) <= 6 && Math.abs(u[i + 2] - v[i + 2]) <= 6;
    const shade = (u, i) => { let lo = 9, hi = 0; for (let k = 0; k < 3; k++) { if (D[i + k] < 40) return false; const q = u[i + k] / D[i + k]; lo = Math.min(lo, q); hi = Math.max(hi, q); } return lo >= 0.66 && hi <= 0.92 && hi - lo < 0.08; };
    let overlap = 0, pTop = 0, qTop = 0;
    for (let i = 0; i < A.length; i += 4) {
      const q = !same(B, D, i) && !shade(B, i), p = !same(C, D, i) && !shade(C, i);
      if (!q || !p) continue;
      overlap++;
      const isQ = same(A, B, i), isP = same(A, C, i);
      if (isP && !isQ) pTop++; else if (isQ && !isP) qTop++;
    }
    // (staged spots right behind / beside a piece are clearance-band and body-box spots on purpose: this suite checks
    //  the 3D order only; test_v10_world_clearance owns the bands and the screen-space rule)
    const hits = VOWorld.check().filter(v => !v.kind.startsWith('off') && !/clearance band|beside a piece/.test(v.kind));
    const band = s.sit || s.pet ? null : _clrAt(s.x, s.y, CLR.tol);
    return { order, overlap, pTop, qTop, valid, band: band ? band.kind : '', hits: hits.map(v => v.kind + ' ' + v.item) };
  };
  // Placements of one piece: [{pos, who, expect}] (expect 'P' person/pet in front, 'Q' the piece in front).
  window.__vPlacements = function (type, rot) {
    const m = FURNITURE_MANIFEST[type], X = 600, Y = 440;
    const wall = m.mount === 'wall', wallH = (officeConfig.walls && officeConfig.walls.height) || 90;
    // v0.13 variants: a manifest key 'desk~gamer' is placed as it is saved, { type: 'desk', variant: 'gamer' }
    const base = type.split('~')[0], variant = type.split('~')[1];
    const item = Object.assign({ type: base, x: X, y: wall ? Math.max(4, wallH - 60) : Y, rotation: rot }, variant ? { variant } : {});
    const out = [];
    if (wall) {
      const r = _getItemWorldRect(item);
      out.push({ pos: 'below the wall', who: { x: Math.round(r.x + r.w / 2), y: wallH + 24 }, expect: 'P' });
      return { item, list: out };
    }
    const fps = _itemFootprints(item);
    if (!fps.length) return { item, list: out };
    const u = fps.reduce((a, f) => ({ x0: Math.min(a.x0, f.x), y0: Math.min(a.y0, f.y), x1: Math.max(a.x1, f.x + f.w), y1: Math.max(a.y1, f.y + f.h) }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
    const cx = Math.round((u.x0 + u.x1) / 2), my = Math.round(u.y0 + (u.y1 - u.y0) * 0.55);
    // beside at mid-depth: a piece lower than the hands (16 px: a bin, an end or coffee table) is under the hands and
    // the body -> the person is in front; taller pieces touch the hands at the edge: no 3D answer (base line)
    const P = m.projection, at = (P.parts || []).filter(p => !p.seat && !p.open && !p.flat && p.h).map(p => (p.z || 0) + p.h);
    const low = (at.length ? Math.max(...at) : P.h || 99) <= 16 && (m.footprint || []).length <= 1 && !/lounge|breakArea/.test(type);  // (L-shapes, legacy composites: any)
    const seats = _itemSeatsWorld(item), stand = _itemStandWorld(item);
    // v0.13: also on (within 4 px of) a seat's own use space (the chair, a stander's place from the walk's end to the feet):
    // a standing desk's stander stands under its top's front edge, 14-16 px in from the walk's end
    const use = _useSpaces(item).map(u => u.rect);
    const nearSeat = (x, y) => seats.some(s => Math.abs(s.x - x) < 24 && Math.abs(s.y - y) < 24) || stand.some(s => Math.abs(s.x - x) < 16 && Math.abs(s.y - y) < 16) ||
      use.some(r => x > r.x - 4 && x < r.x + r.w + 4 && y > r.y - 4 && y < r.y + r.h + 4);
    const add = (pos, who, expect) => { if (!nearSeat(who.x, who.y) || who.sit) out.push({ pos, who, expect }); };
    add('behind', { x: cx, y: Math.round(u.y0 - 8) }, 'Q');
    add('front', { x: cx, y: Math.round(u.y1 + 8) }, 'P');
    add('carry front', { x: cx, y: Math.round(u.y1 + 8), carry: true }, 'P');
    // beside at mid-depth: a low piece's top is under the torso (person in front); a tall piece: base line
    add('left', { x: Math.round(u.x0 - 6), y: my, view: 'right' }, low ? 'P' : 'any');
    add('right', { x: Math.round(u.x1 + 6), y: my, view: 'left' }, low ? 'P' : 'any');
    if (seats.length) {
      const s = seats[0], desk = base === 'desk' || base === 'bossDesk';
      add('seated', desk ? { x: item.x, y: item.y, sit: 'desk' } : s.kind === 'meeting' ? { x: s.x, y: s.y, sit: 'meeting' } : { x: s.hx, y: s.hy, sit: 'couch' }, /lounge|breakArea/.test(type) ? 'any' : 'P');  // (legacy lounge: generic pose, no seat)
    }
    if (stand.length) add('stand spot', { x: stand[0].x, y: stand[0].y }, 'P');
    add('pet front', { x: cx, y: Math.round(u.y1 + 6), pet: true }, 'P');
    add('pet behind', { x: cx, y: Math.round(u.y0 - 6), pet: true }, 'Q');
    add('pet beside', { x: Math.round(u.x1 + 10), y: my, pet: true }, 'any');  // a cat is no taller than a desk's top
    return { item, list: out };
  };
  // The 3D invariant on purpose-made bad and good states (the office as loaded).
  window.__vInvariant = function () {
    const res = [], ok = (c, what) => res.push({ ok: !!c, what: 'invariant: ' + what });
    const desk = { id: 'i1', type: 'desk', x: 400, y: 400 }, vend = { id: 'i2', type: 'vendingMachine', x: 700, y: 300 }, end = { id: 'i3', type: 'endTable', x: 900, y: 500 };
    officeConfig.furniture = [desk, vend, end]; officeConfig.walls.interior = []; buildCollisionGrid();
    agents.length = 0; A0.forEach(a => { agents.push(a); park(a); }); officePets.length = 0; officePets.push(pet);
    pet.x = pet.targetX = OFF; pet.y = pet.targetY = OFF;
    const a = A0[0], kinds = () => { VOWorld.reset(); return VOWorld.check().map(v => v.kind + ' ' + v.item.split('#')[0]); };
    a.x = a.targetX = desk.x; a.y = a.targetY = desk.y; a.isSitting = false; a.desk = { x: OFF, y: OFF };
    let k = kinds();
    ok(k.some(s => s.startsWith('volume meets') && s.endsWith('desk')) && k.some(s => s.startsWith('inside a footprint')), `a person standing at a desk's anchor: ${k.join(', ')}`);
    a.desk = { x: desk.x, y: desk.y, id: desk.id }; a.isSitting = true; a.state = 'working';
    k = kinds(); ok(k.length === 0, `its owner seated there: ${k.join(', ') || 'no hit'}`);
    const st = _itemStandWorld(vend)[0];
    park(a); a.x = a.targetX = st.x; a.y = a.targetY = st.y;
    k = kinds(); ok(k.length === 0, `a person at the vending machine's stand spot: ${k.join(', ') || 'no hit'}`);
    const vb = _volItemBoxes(vend)[0];
    park(a); pet.x = pet.targetX = Math.round(vb.x + vb.w / 2); pet.y = pet.targetY = Math.round(vb.y + 4);
    k = kinds(); ok(k.length > 0, `a pet inside the vending machine's back half: ${k.join(', ')}`);
    pet.x = pet.targetX = OFF; pet.y = pet.targetY = OFF;
    const eb = _volItemBoxes(end).find(b => b.z > 0) || _volItemBoxes(end)[0];
    a.x = a.targetX = Math.round(eb.x + eb.w / 2); a.y = a.targetY = Math.round(eb.y + 3);
    k = kinds(); ok(k.length > 0, `a person under the end table's top: ${k.join(', ')}`);
    park(a);
    return res;
  };
  return Object.keys(FURNITURE_MANIFEST).filter(t => t !== '_unknown' && FURNITURE_MANIFEST[t].projection && FURNITURE_MANIFEST[t].mount !== 'surface' &&
    FURNITURE_MANIFEST[t].mount !== 'label').map(t => ({ type: t, rots: FURNITURE_MANIFEST[t].rotatable ? [0, 90, 180, 270] : [0] }));
}

let passed = 0, failed = 0, fixes = 0;
const fail = (what) => { failed++; console.log('  FAIL ' + what); };
const pass = (what) => { passed++; if (REPORT) console.log('  ok ' + what); };

const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
  const { page, errors, context } = await openOffice(browser);
  try {
    const types = (await page.evaluate(install)).filter(t => !ONLY || t.type === ONLY);
    for (const { type, rots } of types) {
      for (const rot of rots) {
        const { item, list } = await page.evaluate(([t, r]) => window.__vPlacements(t, r), [type, rot]);
        for (const c of list) {
          const name = `${type} r${rot} ${c.pos}`;
          const r = await page.evaluate((spec) => window.__vScene(spec), { item, who: c.who });
          if (!r.valid) { pass(`${name}: (placement inside the piece, skipped)`); continue; }
          // the frame's order (when the actor overlaps one of the piece's parts)
          const want = c.expect === 'any' ? r.order : c.expect;
          if (r.order !== '-' && c.expect !== 'any') (r.order === want ? pass : fail)(`${name}: order ${r.order}, expected ${want}`);
          // pixels: in the overlap the expected one is on top (needs a real overlap)
          if (r.overlap >= 12 && !c.who.sit) {  // (seated: the piece decides the pose; world_contract checks the layering)
            const top = r.pTop > r.qTop * 2 ? 'P' : r.qTop > r.pTop * 2 ? 'Q' : 'mixed';
            if (want === '-' || (c.expect === 'any' && top === 'mixed')) { pass(`${name}: pixels ${top} (no single answer: ${want})`); }  // an L-couch beside both parts
            else if (top === want || (want === 'P' && c.who.sit && r.pTop >= r.qTop)) pass(`${name}: pixels ${top} (${r.pTop}/${r.qTop} of ${r.overlap})`);
            else fail(`${name}: pixels ${top} (P ${r.pTop} / Q ${r.qTop} of ${r.overlap}), expected ${want}`);
            if (/left|right|beside/.test(c.pos) && c.expect === 'P' && top === 'P') fixes++;
          }
          // nobody placed on valid ground trips the 3D invariant (v0.13 standing desks: a top at standing height overhangs
          // its frame, the stander's knee room at the front, the War Table's map top on every side. A footprint cannot
          // cover the floor under it: the world contract keeps footprints inside the drawn art (the top is drawn 25-30
          // px up) and at 0 the stander's feet stand under the front edge. The clearance rule holds a body band round
          // the art there: nobody rests under it (test_v10_world_clearance owns the bands))
          const knee = r.band === 'body' && r.hits.length && r.hits.every(h => /^volume meets top /.test(h)) && !c.who.sit && !c.who.pet;
          if (knee) pass(`${name}: under an overhanging top, in a body band (${r.hits.join(', ')})`);
          else (r.hits.length === 0 ? pass : fail)(`${name}: 3D invariant quiet ${r.hits.join(', ')}`);
        }
      }
    }
    for (const r of await page.evaluate(() => window.__vInvariant())) (r.ok ? pass : fail)(r.what);
    (errors.length === 0 ? pass : fail)('no page errors ' + (errors[0] || ''));
  } finally { await context.close(); }
} finally {
  await browser.close();
}
console.log(`test_v10_world_volumes: ${passed} passed, ${failed} failed (${fixes} beside-a-low-piece cases with the person over the top)`);
assert.equal(failed, 0, `${failed} check(s) failed`);
