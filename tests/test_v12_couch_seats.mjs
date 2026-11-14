// v0.12 couch (owner report on 0.12.0: "when they sit on the couches they sit outside the couch"): an agent that goes to
// relax on a couch sits ON its cushion at every rotation. Headless Chrome, fixture APIs, nothing written.
//   For the L-couch and the straight couch (engLounge) turned 0/90/180/270 and the legacy lounge (not rotatable: 0), alone
//   in an empty room, and for every seat of the piece:
//   - the idle trip's seat (LOCATIONS.interactions couchSeats / engCouchSeats, also VOLife lounge seats and pet naps) is the
//     seat's hip point of the one seat model (_worldSeats: the walk, the seated check; _couchSeatAt: the pose);
//   - the real trip (startIdleAction picking that seat) ends seated in it: isSitting, at the hip point, seatInfo() on the
//     piece, the pose's view = the seat's turned facing, faceDir to that side in a side view;
//   - through the real _renderFrame: the couch's own art is under the hip point (the person is on the couch, not beside
//     it); facing away, the couch back covers the hips (every hidden pixel of the person shows the couch); otherwise the
//     upper body is in view;
//   - one seat per piece and turn: a wave and the signature move play on the seat (v0.12 moves), then still seated there.
//   Failed on aef2a90 (0.12.0 candidate) and rc-v0.11.0: 26 of 41 seats (every turned seat but one) ended beside the
//   couch, unseated (getInteractionSpots turned the hip point instead of the plan point under it, _seatTurn).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.WORLD_APP || path.resolve(here, '..', 'app'));
const REPORT = !!process.env.WORLD_REPORT;
const require = createRequire(import.meta.url);

function skip(reason) { console.log(`SKIP test_v12_couch_seats: ${reason}`); process.exit(0); }
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
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };

async function openOffice(browser, config, agentsList) {
  const ids = agentsList.map(a => a.id);
  const FIX = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.12.0', office: { name: 'Couch Seats' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: agentsList },
    '/status': Object.fromEntries(ids.map(id => [id, { state: 'idle', task: '' }])),
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
    let s = 7;
    const seeded = function() { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    // a test can queue the next draws (startIdleAction: the roll, then the seat)
    window.__rq = [];
    Math.random = function() { return window.__rq.length ? window.__rq.shift() : seeded(); };
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((k) => window.agents && window.agents.length >= k && window.VOWorld, agentsList.length, { timeout: 30000 });
  await page.waitForFunction((n) => officeConfig.furniture.length === n, config.furniture.length, { timeout: 30000 });
  await page.waitForTimeout(700);
  return { page, errors, context };
}

// In page: every seat of every couch type at every rotation the editor allows.
function seatsCheck() {
  const out = [], ok = (c, what) => out.push({ ok: !!c, what });
  window._runSimulation = function () { return 0; }; window._shouldDrawFrame = function () { return true; };
  window.drawAgentActivityChips = function () {}; window._drawMiniMap = function () {}; window.drawChatBubbles = function () {};
  // 8 frames: a sitter eases onto its seat over 7 drawn frames (_seatT), also after the test moves it away and back
  const render = () => { for (let k = 0; k < 8; k++) { _invalidateStaticLayer(); _staticSigCheckedAt = -1e9; _renderFrame(performance.now()); } };
  const a = agents[0], away = () => agents.forEach(b => { if (b !== a) { b.x = b.targetX = -9000; b.y = b.targetY = -9000; b._path = null; } });
  // the middle of the room, the piece's footprint well inside it
  const CX = Math.round((officeConfig.canvasWidth || 1400) / 2) - 80, CY = Math.round((officeConfig.canvasHeight || 800) / 2) - 40;
  const SIDE = { left: -1, right: 1 };
  const diff = (U, V, k) => U[k] !== V[k] || U[k + 1] !== V[k + 1] || U[k + 2] !== V[k + 2];
  let n = 0;
  for (const type of ['couch', 'engLounge', 'lounge']) {
    const M = FURNITURE_MANIFEST[type];
    if (!M || !M.seats) continue;
    for (const rot of (M.rotatable ? [0, 90, 180, 270] : [0])) {
      const item = { id: 'probe-' + type, type, x: CX, y: CY, rotation: rot };
      officeConfig.furniture = [item];
      _worldChanged(); getInteractionSpots();
      const spots = type === 'engLounge' ? LOCATIONS.interactions.engCouchSeats : LOCATIONS.interactions.couchSeats;
      const world = _worldSeats().filter(s => s.item === item);
      ok(spots.length === M.seats.length && world.length === M.seats.length, `${type} r${rot}: ${M.seats.length} seats (trip ${spots.length}, world ${world.length})`);
      world.forEach((W, i) => {
        const L = `${type} r${rot} ${M.seats[i].id}`;
        n++;
        // the trip's seat = the seat's hip point
        ok(spots.some(s => s.x === W.x && s.y === W.y), `${L}: idle trip seat at the hip point ${W.x - CX},${W.y - CY} (trip seats ${spots.map(s => (s.x - CX) + ',' + (s.y - CY)).join(' ')})`);
        // the real trip: startIdleAction picks this seat (roll, then the seat among the open ones), the walk from free floor
        const start = { x: CX + 80, y: CY + 230 };
        ok(!VOWorld.feetIn(start.x, start.y), `${L}: the trip starts on free floor`);
        away();
        Object.assign(a, { x: start.x, y: start.y, targetX: start.x, targetY: start.y, state: 'idle', isSitting: false, idleAction: null, meetingId: null,
          visitTarget: null, _path: null, _seatGoal: null, desk: { x: -999, y: -999 }, _lifeHold: null });
        const k = spots.findIndex(s => s.x === W.x && s.y === W.y);
        window.__rq = [type === 'engLounge' ? 0.02 : 0.10, ((k < 0 ? i : k) + 0.5) / spots.length];
        a.startIdleAction();
        window.__rq = [];
        ok(a.idleAction === 'couch' && a.targetX === W.x && a.targetY === W.y, `${L}: startIdleAction heads for the seat (${a.idleAction} ${a.targetX - CX},${a.targetY - CY})`);
        a.idleReturnTimer = 1e6;
        for (let t = 0; t < 700 && !(a.isSitting && a.x === a.targetX && a.y === a.targetY); t++) { away(); _simulationStep(); }
        for (let t = 0; t < 12; t++) { away(); _simulationStep(); }
        const pose = _couchSeatAt(a.x, a.y), info = a.seatInfo && (render(), a.seatInfo());
        ok(a.isSitting && a.x === W.x && a.y === W.y, `${L}: seated at the hip point (sit ${a.isSitting}, at ${Math.round(a.x - CX)},${Math.round(a.y - CY)}, seat ${W.x - CX},${W.y - CY})`);
        ok(info && info.item === item && info.kind === type, `${L}: seatInfo() on the ${type} (${info ? info.kind : null})`);
        ok(pose && pose.view === W.facing, `${L}: the pose faces ${W.facing} (${pose ? pose.view : null})`);
        if (SIDE[W.facing]) ok(a.faceDir === SIDE[W.facing], `${L}: faceDir ${a.faceDir} to the ${W.facing}`);
        if (!(a.isSitting && a.x === W.x && a.y === W.y)) return;
        // pixels through the real frame: A = with the sitter, E = the couch alone, F = the empty room; P = the sitter alone
        // (offscreen, its full silhouette). v0.13 finish: P replaces T (the frame + the sitter re-drawn on top of it), which
        // depended on the time of day: by day the re-draw over the same frame changed no pixel (the hidden hips never
        // showed: 0 % hidden, 12 seats failed 09:00-17:00), by night the untinted re-draw differed everywhere
        const o = _cameraOrigin(), S = o.s * DPR, bx = W.x - 40, by = W.y - 70, bw = 80, bh = 110;
        const X0 = Math.floor((o.x + bx * o.s) * DPR), Y0 = Math.floor((o.y + by * o.s) * DPR), w = Math.ceil(bw * S), h = Math.ceil(bh * S);
        render(); const A = ctx.getImageData(X0, Y0, w, h).data;
        const keep = { x: a.x, y: a.y };
        a.x = a.targetX = -9000; a.y = a.targetY = -9000; render(); const E = ctx.getImageData(X0, Y0, w, h).data;
        officeConfig.furniture = []; _worldChanged(); render(); const F = ctx.getImageData(X0, Y0, w, h).data;
        officeConfig.furniture = [item]; _worldChanged(); getInteractionSpots();
        a.x = a.targetX = keep.x; a.y = a.targetY = keep.y; render();
        const G = document.createElement('canvas'); G.width = w; G.height = h;
        const gc = G.getContext('2d'), sv = window.ctx; window.ctx = gc; gc.setTransform(S, 0, 0, S, DPR * o.x - X0, DPR * o.y - Y0);  // = the frame's crop
        try { a.draw(); } finally { window.ctx = sv; }
        const P = gc.getImageData(0, 0, w, h).data;
        render();
        // the couch's own art under the drawn hips (the seat point + the pose's shift, a 5 x 5 px square) and, side on,
        // under the knee (SEAT_SIDE_KNEE px ahead, a 3 x 3 square 1 px inside): the person sits on it, not in front of it
        const artAt = (wx, wy, rad) => {
          const cx = Math.floor((wx - bx) * S), cy = Math.floor((wy - by) * S);
          let art = 0, cells = 0;
          for (let yy = cy - rad * S; yy <= cy + rad * S; yy++) for (let xx = cx - rad * S; xx <= cx + rad * S; xx++) {
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            cells++; if (diff(E, F, (Math.floor(yy) * w + Math.floor(xx)) * 4)) art++;
          }
          return cells ? art / cells : 0;
        };
        const hipX = W.x + pose.dx, hipY = W.y + pose.dy, hipArt = artAt(hipX, hipY, 2);
        ok(hipArt >= 0.9, `${L}: on the couch: its art under the hips (${Math.round(hipArt * 100)} %, pose shift ${pose.dx},${pose.dy})`);
        if (SIDE[W.facing]) {
          const K = typeof SEAT_SIDE_KNEE === "number" ? SEAT_SIDE_KNEE : 8;  // (8 = the knee drawn by 0.12.0)
          const kneeArt = artAt(hipX + SIDE[W.facing] * (K - 1), hipY, 1);
          ok(kneeArt >= 0.9, `${L}: side on, the knee is over the cushion, not past the couch (${Math.round(kneeArt * 100)} %)`);
        }
        // what of the person is hidden in the frame, and by what
        const px = [];
        for (let q = 0; q < P.length; q += 4) if (P[q + 3] > 200) px.push(q);  // the sitter's opaque pixels
        let hid = 0, hidOnCouch = 0;
        for (const q of px) if (!diff(A, E, q)) { hid++; if (diff(E, F, q)) hidOnCouch++; }
        if (W.facing === 'up') {
          ok(hid / px.length >= 0.08 && hidOnCouch === hid, `${L}: facing away, the couch back covers the hips (${Math.round(hid / px.length * 100)} % hidden, ${hid - hidOnCouch} px by something else)`);
        } else {
          const top = Math.floor(px[0] / 4 / w), bot = Math.floor(px[px.length - 1] / 4 / w), cut = top + (bot - top) * 0.45;
          let mine = 0, seen = 0;
          for (const q of px) { if (Math.floor(q / 4 / w) > cut) break; mine++; if (diff(A, E, q)) seen++; }
          ok(mine && seen / mine >= 0.85, `${L}: the upper body in view (${Math.round(seen / Math.max(1, mine) * 100)} %)`);
        }
        // v0.12 moves on the couch (one seat per piece and turn): a wave and the signature move play on the seat (the
        // drawn person changes, the body stays over the seat), then the sitter is still seated there
        if (i !== 1) return;
        const grab = () => { render(); return ctx.getImageData(X0, Y0, w, h).data; };
        const centre = () => a._bodyBox.x + a._bodyBox.w / 2;
        const S0 = grab(), c0 = centre();
        const changed = U => { let d = 0; for (let q = 0; q < U.length; q += 4) if (diff(U, S0, q)) d++; return d; };
        // click reactions are an Office life switch: on for this check
        const VL = window.VOLife || (window.VOLife = {}), isOn0 = VL.isOn;
        VL.isOn = n => (n === 'reactions' ? true : isOn0 ? isOn0.call(VL, n) : false);
        const waved = _reactAgent(a, 'wave');
        VL.isOn = isOn0;
        ok(waved && a._react, `${L}: the wave starts (${waved})`);
        if (!a._react) return;
        a._react.at -= 450;
        const S1 = grab(), c1 = centre();
        ok(changed(S1) > 10 && Math.abs(c1 - c0) <= 4, `${L}: a wave plays on the seat (${changed(S1)} px change, body centre ${Math.round(c1 - c0)} px)`);
        a._react = null;
        const played = _playSignature(a, { preview: true });
        if (played && a._sigMove) {
          a._sigMove.at -= a._sigMove.ms * 0.5;
          const S2 = grab();
          ok(changed(S2) > 10, `${L}: the signature move ${a._sigMove.id} plays seated (${changed(S2)} px change)`);
          a._sigMove.at -= 1e6;
        } else ok(false, `${L}: the signature move starts (${played})`);
        for (let t = 0; t < 6; t++) { away(); _simulationStep(); }
        render();
        ok(a.isSitting && a.x === W.x && a.y === W.y && !a._sigMove && Math.abs(centre() - c0) <= 1, `${L}: after the move still seated on the seat (sit ${a.isSitting}, move ${a._sigMove ? a._sigMove.id : null})`);
      });
    }
  }
  ok(n >= 41, `${n} seats checked`);
  return out;
}

const roster = Array.from({ length: 2 }, (_, i) => ({ id: 'c' + (i + 1), statusKey: 'c' + (i + 1), name: 'Sitter ' + (i + 1), emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }));
const config = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
let passed = 0, failed = 0;
const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
  const { page, errors, context } = await openOffice(browser, config, roster);
  try {
    const results = await page.evaluate(seatsCheck);
    results.push({ ok: errors.length === 0, what: 'no page errors ' + (errors[0] || '') });
    for (const r of results) {
      if (r.ok) { passed++; if (REPORT) console.log('  ok ' + r.what); }
      else { failed++; console.log('  FAIL ' + r.what); }
    }
  } finally { await context.close(); }
} finally { await browser.close(); }
console.log(`test_v12_couch_seats: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} check(s) failed`);
