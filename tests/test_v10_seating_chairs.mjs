// Seating regression test (v0.10.1 "seating": agents sit IN their chairs).
//
// Hermetic: headless Chrome through playwright-core, every request answered
// from app/ files and fixed fixtures, nothing saved. Draws seated and walking
// agents with the game's own functions into private canvases (the global ctx
// is swapped) and checks pixels and the seat contract: the chair front part is
// drawn over the sitter (also unfiltered when offline), feet rest on the floor
// below the seat, the seated view follows the seat facing (never the back),
// chairs are 10-15 % smaller, legs show in the four walk views, carried items
// follow the view, desk arrival ends at the chair base (Z-03), sitters sort
// on their feet (seatInfo / _sortY), no ghost meeting seats.
//
// Run: node tests/test_v10_seating_chairs.mjs
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
  console.log(`SKIP test_v10_seating_chairs: ${reason}`);
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
const OFFICE = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
const IDS = ['ann', 'bob', 'cat', 'dan', 'eve', 'fay'];
const FIXTURES = {
  '/api/license': { demo: false, valid: true, limits: {} },
  '/vo-config': { version: '0.10.1', office: { name: 'Seating Test' }, features: {}, weather: { location: null } },
  '/api/agents': { agents: IDS.map(id => ({ id, statusKey: id, name: id, emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true })) },
  '/status': Object.fromEntries(IDS.map(id => [id, { state: 'working', task: 'Testing' }])),
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
  // a noon clock that can stand still (the real-frame check renders the same scene twice)
  await context.addInitScript(() => {
    const R = Date, base = new R(2026, 10, 4, 12, 0, 0).getTime(), t0 = R.now();
    const t = () => base + (window.__seatFreeze ? 0 : R.now() - t0);
    class FD extends R { constructor(...a) { if (a.length === 0) super(t()); else super(...a); } static now() { return t(); } }
    window.Date = FD;
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length >= 6 && window.VOOffice, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const realFurniture = officeConfig.furniture;
    window.__seat = {
      realFurniture, SHOE: '#7a2f2f', PANTS: '#2f5a3d',
      DESK: ['#3c4650', '#66737e'], BOSS: ['#3e2723', '#795548'],
      freeze() { agents.forEach(a => { a.__upd = a.__upd || a.update; a.update = function () {}; }); },
      withCtx(g, fn) { const s = window.ctx; window.ctx = g; try { return fn(); } finally { window.ctx = s; } },
      place(a, p) {
        a.appearance = Object.assign({}, getDefaultAppearance(a), { pantsColor: this.PANTS, shoeColor: this.SHOE, costume: null, heldItem: null });
        a.gender = 'M';
        Object.assign(a, { isSitting: false, state: 'idle', idleAction: null, meetingId: null, carryItem: null, _lifePose: null, _lifeCarry: null,
          _seatCache: null, _xSeat: null, _seatT: 1, _seatFrom: null, _seatGoal: null, _walkFace: null, _pvx: null, _pvy: null,
          _forceView: null, tick: p.tick || 0, _offlineSprites: null, idleFaceDir: null, faceDir: 1, _path: null, notify: false, _lastSeat: null, _swv: null, _dIdle: null, waitingApprovalCount: 0 });
        const at = (x, y) => { a.x = a.targetX = a._prevTargetX = x; a.y = a.targetY = a._prevTargetY = y; };
        if (p.desk) {
          at(p.desk.x, p.desk.y); a.desk = { x: p.desk.x, y: p.desk.y }; a.deskType = p.desk.type === 'bossDesk' ? 'boss' : 'regular';
          a.isSitting = true; a.state = 'working';
        } else if (p.meet) {
          const s = _meetingSeats(p.meet).filter(s => s.kind === p.seat)[0]; at(s.x, s.y); a.desk = { x: -999, y: -999 }; a.state = 'meeting'; a.meetingId = 'm';
        } else if (p.couch) {
          const s = _couchSeatsNow()[p.n || 0]; at(s.x, s.y); a.desk = { x: -999, y: -999 }; a.isSitting = true; a.idleAction = 'couch';
        } else {
          at(p.x, p.y); a.desk = { x: -999, y: -999 };
          if (p.walk) {
            const v = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[p.walk];
            a.targetX = a._prevTargetX = p.x + v[0] * 200; a.targetY = a._prevTargetY = p.y + v[1] * 200;
            a._walkFace = p.walk; a._pvx = p.x - v[0]; a._pvy = p.y - v[1]; a.faceDir = v[0] < 0 ? -1 : 1;
          }
        }
        if (p.carry) a.carryItem = p.carry;
        if (p.state) a.state = p.state;
        if (p.force) a._forceView = p.force;
        if (p.anim) a._dIdle = { kind: p.anim[0], t0: a.tick - p.anim[1] };   // idle-at-desk animation at frame p.anim[1]
        if (p.offline) a.state = 'offline';
      },
      // Static furniture, near meeting chairs, then the people y-sorted, as a frame does (world px, scale 1).
      render(items, people, box, opts) {
        const c = document.createElement('canvas'); c.width = box.w; c.height = box.h;
        const g = c.getContext('2d');
        officeConfig.furniture = items.slice(); officeConfig.agents = [];
        const list = people.map((p, k) => { const a = agents[k]; this.place(a, p); return a; });
        if (opts && opts.noFront) list.forEach(a => { a._drawSeatFront = function () {}; });
        try {
          this.withCtx(g, () => {
            g.setTransform(1, 0, 0, 1, -box.x, -box.y);
            g.fillStyle = '#d3c8b8'; g.fillRect(box.x, box.y, box.w, box.h);
            items.forEach(it => drawFurnitureItem(it, { staticOnly: true }));
            _drawMeetingNearChairs(null);
            const ents = list.concat(_tallFurnitureEntries()); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
          });
        } finally { list.forEach(a => { delete a._drawSeatFront; }); }
        this.last = list;
        return c;
      },
      // Pixels of a world rect: how many have one of the colours (hex), and how many in total.
      count(c, box, r, colors) {
        const d = c.getContext('2d').getImageData(r.x - box.x, r.y - box.y, r.w, r.h).data; let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const hex = '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
          if (colors.includes(hex)) n++;
        }
        return { n, total: d.length / 4 };
      },
      // World pixels of one colour: count, x/y range.
      find(c, box, colors) {
        if (!Array.isArray(colors)) colors = [colors];
        colors = colors.map(col => { const t = document.createElement('canvas').getContext('2d'); t.fillStyle = col; t.fillRect(0, 0, 1, 1);
          return '#' + Array.from(t.getImageData(0, 0, 1, 1).data.slice(0, 3)).map(v => v.toString(16).padStart(2, '0')).join(''); });
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (let i = 0; i < d.length; i += 4) {
          const hex = '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
          if (!colors.includes(hex)) continue;
          const p = i / 4, x = p % c.width + box.x, y = Math.floor(p / c.width) + box.y; n++;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        return { n, x0, x1, y0, y1 };
      },
    };
    __seat.freeze();
  });
  const BOX = { x: 120, y: 110, w: 160, h: 170 };
  const desk = (type, rot) => ({ id: 'd1', type, x: 200, y: 200, rotation: rot || 0 });
  const MEET = { id: 'm1', type: 'meetingTable', x: 100, y: 100 };

  await check('seated view = the seat\'s real facing at every rotation, back views included (review 11-05)', async () => {
    const r = await page.evaluate((M) => {
      const out = {};
      ['desk', 'bossDesk'].forEach(t => [0, 90, 180, 270].forEach(rot => {
        const P = _deskSeatPoses(_deskSeatSpot({ type: t, x: 200, y: 200, rotation: rot }), t === 'bossDesk');
        out[t + rot] = P.work.view + '/' + P.idle.view + '/' + P.path.length;
      }));
      officeConfig.furniture = [M];
      out.meet = _meetingSeatsNow().filter(s => s.kind).map(s => s.kind + ':' + _meetingSeatAt(s.x, s.y).view).join(',');
      [0, 90, 180, 270].forEach(rot => {
        officeConfig.furniture = [{ id: 'c', type: 'couch', x: 300, y: 300, rotation: rot }, { id: 'e', type: 'engLounge', x: 100, y: 100, rotation: rot }];
        out['couch' + rot] = _couchSeatsNow().filter(s => s.pose.kind === 'couch').map(s => s.pose.view[0]).join('');
        out['eng' + rot] = _couchSeatsNow().filter(s => s.pose.kind === 'engLounge').map(s => s.pose.view[0]).join('');
      });
      return out;
    }, MEET);
    assert.equal(r.desk0, 'up/down/3'); assert.equal(r.desk90, 'right/down/2'); assert.equal(r.desk180, 'down/down/1'); assert.equal(r.desk270, 'left/down/2');
    assert.equal(r.bossDesk0, 'up/down/3'); assert.equal(r.bossDesk90, 'right/down/2'); assert.equal(r.bossDesk180, 'down/down/1'); assert.equal(r.bossDesk270, 'left/down/2');
    assert.ok(/top:down/.test(r.meet) && /left:right/.test(r.meet) && /right:left/.test(r.meet) && /near:up/.test(r.meet) && !/near:(left|right|down)/.test(r.meet), r.meet);
    assert.deepEqual([r.couch0, r.couch90, r.couch180, r.couch270], ['ddddl', 'llllu', 'uuuur', 'rrrrd']);
    // the straight couch turns too (v0.10.1 perspective P2): its seats face with it
    assert.deepEqual([r.eng0, r.eng90, r.eng180, r.eng270], ['dddd', 'llll', 'uuuu', 'rrrr'], 'the straight couch seats turn: ' + JSON.stringify(r));
  });

  await check('at the desk the chair faces the desk, typing or idle (back view, review 11-05 G); a drink or a snack swivels it to the room through a middle frame', async () => {
    const r = await page.evaluate(async ([BOX, D, B]) => {
      const S = __seat, out = {};
      const view = (items, ppl) => { S.render(items, ppl, BOX); return S.last[0]._lastSeat && S.last[0]._lastSeat.view; };
      out.work = view([D], [{ desk: D }]);
      out.idle = view([D], [{ desk: D, state: 'idle' }]);
      out.eating = view([D], [{ desk: D, carry: 'food', tick: 300 }]);
      out.offline = view([D], [{ desk: D, offline: true }]);
      out.bossWork = view([B], [{ desk: B }]);
      const D90 = Object.assign({}, D, { rotation: 90 }), D180 = Object.assign({}, D, { rotation: 180 });
      out.d90idle = view([D90], [{ desk: D90, state: 'idle' }]);
      out.d180idle = view([D180], [{ desk: D180, state: 'idle' }]);
      // swivel: a snack arrives -> the side frame, then the front; eaten -> side, back
      S.render([D], [{ desk: D, state: 'idle' }], BOX);
      const a = S.last[0], draw = () => { const c = document.createElement('canvas'); c.width = c.height = 300; S.withCtx(c.getContext('2d'), () => a.draw()); return a._lastSeat.view; };
      out.seq = [draw()];
      a.carryItem = 'snack'; a.tick = 300; out.seq.push(draw());
      await new Promise(res => setTimeout(res, SWIVEL_STEP_MS + 30)); out.seq.push(draw());
      a.carryItem = null; await new Promise(res => setTimeout(res, SWIVEL_STEP_MS + 30)); out.seq.push(draw());
      await new Promise(res => setTimeout(res, SWIVEL_STEP_MS + 30)); out.seq.push(draw());
      return out;
    }, [BOX, desk('desk'), desk('bossDesk')]);
    assert.equal(r.work, 'up', JSON.stringify(r)); assert.equal(r.bossWork, 'up', JSON.stringify(r));
    assert.equal(r.idle, 'up'); assert.equal(r.eating, 'down'); assert.equal(r.offline, 'up');
    assert.equal(r.d90idle, 'right'); assert.equal(r.d180idle, 'down');
    assert.deepEqual(r.seq, ['up', 'right', 'down', 'right', 'up'], JSON.stringify(r));
  });

  await check('chair back over the sitter: turned desk chair (desk, boss, meeting near) and couch back; armrests of a swivelled chair; also offline', async () => {
    const r = await page.evaluate(([BOX, D, B, M]) => {
      const S = __seat, out = {}, PAL = ['#2b333b', '#3c4650', '#4f5b66'], BPAL = ['#2e1c17', '#3e2723', '#5d4037', '#795548'];
      // the seat lines from DESK_SEAT (v0.13 seatreach moved the chairs in: 0.12 had 213 / 228, the 90 seat at -15, 2)
      const DY = D.y + DESK_SEAT.desk[0].hy, BY = B.y + DESK_SEAT.bossDesk[0].hy, T90 = DESK_SEAT.desk[90];
      const shell = (hx, hy, hw, top) => ({ x: hx - hw + 1, y: hy - top + 1, w: hw * 2 - 2, h: top + 3 }); // inside the rounded shell
      const full = (c, box, rect, pal) => { const k = S.count(c, box, rect, pal); return k.n + '/' + k.total; };
      out.desk = full(S.render([D], [{ desk: D }], BOX), BOX, shell(D.x, DY, 13, 9), PAL);
      out.deskIdle = full(S.render([D], [{ desk: D, state: 'idle' }], BOX), BOX, shell(D.x, DY, 13, 9), PAL);
      out.deskNoFront = S.count(S.render([D], [{ desk: D }], BOX, { noFront: true }), BOX, shell(D.x, DY, 13, 9), PAL).n;
      const bb = { x: 100, y: 120, w: 200, h: 180 };
      out.boss = full(S.render([B], [{ desk: B }], bb), bb, shell(B.x, BY, 16, 11), BPAL);
      out.bossIdle = full(S.render([B], [{ desk: B, state: 'idle' }], bb), bb, shell(B.x, BY, 16, 11), BPAL);
      out.offline = full(S.render([D], [{ desk: D, offline: true }], BOX), BOX, shell(D.x, DY, 13, 9), PAL);
      const pads = (hx, hy, hw) => [{ x: hx - hw - 1, y: hy - 5, w: 4, h: 2 }, { x: hx + hw - 3, y: hy - 5, w: 4, h: 2 }];
      const front = (c, rects, colors, box) => rects.reduce((n, q) => n + S.count(c, box || BOX, q, colors).n, 0);
      out.idlePads = front(S.render([D], [{ desk: D, carry: 'coffee', tick: 300 }], BOX), pads(D.x, DY, 13), S.DESK);  // swivelled to the room
      out.offlinePads = front(S.render([D], [{ desk: D, offline: true, force: 'down' }], BOX), pads(D.x, DY, 13), S.DESK);
      out.bossIdlePads = front(S.render([B], [{ desk: B, carry: 'coffee', tick: 300 }], bb), pads(B.x, BY, 16), S.BOSS, bb);
      const D90 = Object.assign({}, D, { rotation: 90 });
      out.turned = S.count(S.render([D90], [{ desk: D90 }], BOX), BOX, { x: D.x + T90.hx - 6, y: D.y + T90.hy - 5, w: 11, h: 2 }, S.DESK).n;
      const box2 = { x: 40, y: 60, w: 300, h: 200 };
      const c2 = S.render([M], [{ meet: M, seat: 'left' }, { meet: M, seat: 'near' }], box2);
      const seats = _meetingSeats(M), l = seats.find(s => s.kind === 'left'), n = seats.find(s => s.kind === 'near');
      out.end = S.count(c2, box2, { x: l.hx - 6, y: l.hy - 5, w: 11, h: 2 }, S.DESK).n;
      out.near = full(c2, box2, shell(n.hx, n.hy, 13, 11), PAL);
      // couch turned 180: the couch back strip behind a back-view sitter is the couch's own pixels
      const C = { id: 'c1', type: 'couch', x: 300, y: 300, rotation: 180 }, cb = { x: 120, y: 200, w: 200, h: 120 };
      officeConfig.furniture = [C]; const cs = _couchSeatsNow()[1];
      const withA = S.render([C], [{ couch: true, n: 1 }], cb), bare = S.render([C], [], cb), noF = S.render([C], [{ couch: true, n: 1 }], cb, { noFront: true });
      const ch = cs.pose.chair, strip = { x: cs.x - 13, y: Math.round(ch.y0) + 1, w: 26, h: Math.min(9, Math.round(ch.y1 - ch.y0) - 2) };  // the back's drawn rows
      const px = (c) => Array.from(c.getContext('2d').getImageData(strip.x - cb.x, strip.y - cb.y, strip.w, strip.h).data).join(',');
      out.couchBack = px(withA) === px(bare); out.couchCovers = px(noF) !== px(bare);
      return out;
    }, [BOX, desk('desk'), desk('bossDesk'), MEET]);
    const all = v => { const [a, b] = v.split('/'); return a === b; };
    assert.ok(all(r.desk), 'desk chair back not all chair colour over the sitter: ' + JSON.stringify(r));
    assert.ok(r.deskNoFront < +r.desk.split('/')[1], 'without the chair back the sitter would show there: ' + JSON.stringify(r));
    assert.ok(all(r.boss) && all(r.deskIdle) && all(r.bossIdle) && all(r.offline), JSON.stringify(r));
    assert.ok(all(r.near), 'meeting near chair back: ' + JSON.stringify(r));
    assert.equal(r.idlePads, 16, JSON.stringify(r)); assert.equal(r.offlinePads, 16, 'offline: unfiltered ' + JSON.stringify(r));
    assert.equal(r.bossIdlePads, 16, JSON.stringify(r));
    assert.equal(r.turned, 22, JSON.stringify(r)); assert.equal(r.end, 22, JSON.stringify(r));
    assert.ok(r.couchBack && r.couchCovers, 'couch back over a sitter facing away: ' + JSON.stringify(r));
  });

  await check('desk top: keyboard + mouse in the front half, desk item at the left end (back-left), drinks/snacks on the right half, nothing outside the top (all rotations)', async () => {
    const r = await page.evaluate(() => {
      const S = __seat, bad = [], out = {};
      // x0, y0, x1, y1 of the top face from the desk origin: v0.10.1 camera at 0 (raised 21 px); turned desks are
      // redrawn per view (perspective P2): their top face, keyboard and mouse in world axes (no turning back)
      const TOP0 = { desk: [-32, -39, 31, -8], bossDesk: [-48, -35, 47, 12] };  // P3: the whole top face of the desk 64 x 32 / boss desk 96 x 48
      const topAt = (t, rot) => { const r = _deskTopRect({ type: t, x: 0, y: 0, rotation: rot }); return [r.x + 1, r.y + 1, r.x + r.w - 2, r.y + r.h - 2]; };
      const kbAt = (t, rot) => { const P = t === 'desk' ? DESK_PLAN : BOSS_PLAN, k = _projTurn(P.keys, rot), m = t === 'desk' ? P.mouse[rot] : _projTurn(P.mouse, rot);
        const my = t === 'desk' ? m[1] : m[1] - 21;
        return [Math.min(k[0], m[0]), Math.min(k[1] - 21, my), Math.max(k[0] + k[2], m[0] + m[2]) - 1, Math.max(k[1] - 21 + k[3], my + m[3]) - 1]; };
      const toLocal = (x, y) => [x, y];
      const scan = (c, box, fn) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) { const p = i / 4; fn(p % c.width + box.x, Math.floor(p / c.width) + box.y, d[i], d[i + 1], d[i + 2], d[i + 3], i); } };
      const diff = (a, b, box, fn) => { const A = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, B2 = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
        for (let i = 0; i < A.length; i += 4) if (A[i] !== B2[i] || A[i + 1] !== B2[i + 1] || A[i + 2] !== B2[i + 2]) { const p = i / 4; fn(p % a.width + box.x, Math.floor(p / a.width) + box.y); } };
      const KEY = { desk: [[0x60, 0x7d, 0x8b]], bossDesk: [[0x54, 0x6e, 0x7a], [0x60, 0x7d, 0x8b]] };
      const KB0 = { desk: [-15, -20, 22, -13], bossDesk: [-14, 1, 22, 8] };  // keyboard + mouse at 0
      ['desk', 'bossDesk'].forEach(t => [0, 90, 180, 270].forEach(rot => {
        const D = { id: 'd1', type: t, x: 200, y: 200, rotation: rot }, box = { x: 110, y: 110, w: 180, h: 180 }, T = rot ? topAt(t, rot) : TOP0[t], KB = rot ? { [t]: kbAt(t, rot) } : KB0, midY = (T[1] + T[3]) / 2;
        const inTop = (lx, ly) => lx >= T[0] && lx <= T[2] && ly >= T[1] && ly <= T[3];
        // keyboard and mouse keys (no one at the desk): on the top, in its front half (below the monitor)
        const mons = _deskMonitorRects(D);
        const c = S.render([D], [], box); let keys = 0;
        scan(c, box, (x, y, R, G, B) => { if (!KEY[t].some(k => k[0] === R && k[1] === G && k[2] === B)) return;
          const [lx, ly] = toLocal(x - 200, y - 200, rot); if (!inTop(lx, ly) || mons.some(m => lx >= m.bx && lx < m.bx + m.bw && ly >= m.by && ly < m.by + m.bh + 6)) return;
          keys++; if (!rot && ly < midY) bad.push(t + rot + ' key at ' + lx + ',' + ly); });
        if (keys < 20 && !(t === 'desk' && rot === 180)) bad.push(t + rot + ' keys ' + keys);  // 180: the keyboard is behind the monitor's casing back
        // the agent's desk item, every kind: inside the top, centre in the back-left quarter
        ['trophy', 'wrench', 'calendar', 'envelope', 'money', 'ruler', 'marker', 'chart', 'plans', 'checklist', 'microscope', 'shield', 'phone', 'anvil', 'files'].forEach(kind => {
          const a = agents[0]; S.place(a, { desk: D }); a.appearance.deskItem = kind;
          const g = document.createElement('canvas'); g.width = box.w; g.height = box.h; const gc = g.getContext('2d');
          S.withCtx(gc, () => { gc.setTransform(1, 0, 0, 1, -box.x + 200, -box.y + 200); a._drawDeskCharItem(gc); });
          let n = 0, sx = 0, sy = 0, maxY = -1e9, onMon = null;
          scan(g, box, (x, y, R, G, B, A) => { if (A < 40) return; const [lx, ly] = toLocal(x - 200, y - 200, rot); n++; sx += lx; sy += ly; maxY = Math.max(maxY, ly);
            if (!inTop(lx, ly)) bad.push(t + rot + ' ' + kind + ' off the top at ' + lx + ',' + ly);
            if (lx >= KB[t][0] && lx <= KB[t][2] && ly >= KB[t][1] && ly <= KB[t][3]) bad.push(t + rot + ' ' + kind + ' on the keyboard at ' + lx + ',' + ly);
            // 180: the item stands on the near edge, in front of the casing back's corner (desk; boss desk since v0.13 40
            // deep: the casing backs' tops came 8 px nearer the far edge, where it stood): checked below, its base in front
            const mon = mons.find(m => lx >= m.bx && lx < m.bx + m.bw && ly >= m.by && ly < m.by + m.bh);
            if (mon && rot === 180) onMon = mon;
            else if (mon && !(t === 'desk' && rot === 180)) bad.push(t + rot + ' ' + kind + ' on the monitor at ' + lx + ',' + ly); });
          if (onMon && t === 'bossDesk' && maxY < onMon.by + onMon.bh) bad.push(t + rot + ' ' + kind + ' over the casing back, its base (' + maxY + ') not in front of it (' + (onMon.by + onMon.bh) + ')');
          // the left end of the top, beside the monitor (a 29 px deep desk turned with upright sprites leaves no room for a strict back-left quarter)
          if (!rot && n && !(sx / n < (t === 'desk' ? -16 : -27) && sy / n < (t === 'desk' ? -15 : 0))) bad.push(t + rot + ' ' + kind + ' centre ' + (sx / n).toFixed(1) + ',' + (sy / n).toFixed(1));
          out[kind] = (out[kind] || 0) + n;
        });
        // a drink or snack resting on the desk (sitter swivelled, item not in hand)
        ['coffee', 'water', 'snack', 'food'].forEach(item => {
          const withI = S.render([D], [{ desk: D, carry: item, tick: 300 }], box), without = S.render([D], [{ desk: D, state: 'idle', tick: 300, force: 'down' }], box);
          let n = 0;
          diff(withI, without, box, (x, y) => { const [lx, ly] = toLocal(x - 200, y - 200, rot); n++;
            if (!inTop(lx, ly) || (!rot && lx <= 0)) bad.push(t + rot + ' ' + item + ' at ' + lx + ',' + ly); });
          if (!n) bad.push(t + rot + ' ' + item + ' not drawn');
        });
      }));
      return { bad: bad.slice(0, 12), nbad: bad.length, out };
    });
    assert.equal(r.nbad, 0, JSON.stringify(r));
  });

  await check('feet rest on the floor below the seat (shoes + floor shadow) on chairs, couches and sofas', async () => {
    const r = await page.evaluate(([BOX, D, B, M]) => {
      const S = __seat, out = {}, DY = D.y + DESK_SEAT.desk[0].hy, BY = B.y + DESK_SEAT.bossDesk[0].hy;  // seat lines (v0.13 seatreach)
      const shoes = (c, box, seatY) => { const f = S.find(c, box, S.SHOE); return f.n && f.y0 > seatY ? f.y1 - seatY : -1; };
      out.desk = shoes(S.render([D], [{ desk: D, carry: 'coffee', tick: 300 }], BOX), BOX, DY);   // swivelled to the room
      const bb = { x: 100, y: 120, w: 200, h: 180 };
      out.boss = shoes(S.render([B], [{ desk: B, carry: 'coffee', tick: 300 }], bb), bb, BY);
      const box2 = { x: 40, y: 60, w: 300, h: 200 }, l = _meetingSeats(M).find(s => s.kind === 'left');
      out.meetEnd = shoes(S.render([M], [{ meet: M, seat: 'left' }], box2), box2, l.hy);
      [0, 90, 180, 270].forEach(rot => {
        const C = { id: 'c1', type: 'couch', x: 300, y: 300, rotation: rot }, cb = { x: 100, y: 100, w: 400, h: 400 };
        officeConfig.furniture = [C];
        const s = _couchSeatsNow()[1];
        if (rot === 180) out.couch180Back = S.find(S.render([C], [{ couch: true, n: 1 }], cb), cb, S.SHOE).n === 0; // facing away: legs in front, hidden
        else out['couch' + rot] = shoes(S.render([C], [{ couch: true, n: 1 }], cb), cb, s.y);
      });
      const E = { id: 'e1', type: 'engLounge', x: 100, y: 100 }, eb = { x: 60, y: 40, w: 260, h: 120 };
      officeConfig.furniture = [E];
      out.eng = shoes(S.render([E], [{ couch: true, n: 1 }], eb), eb, _couchSeatsNow()[1].y);
      out.engBelowSofa = S.find(S.render([E], [{ couch: true, n: 1 }], eb), eb, S.SHOE).y1 > 100 + 36;
      return out;
    }, [BOX, desk('desk'), desk('bossDesk'), MEET]);
    for (const [k, v] of Object.entries(r)) assert.ok(v === true || v >= 8, `${k}: shoes not on the floor below the seat (${JSON.stringify(r)})`);
  });

  await check('chairs are 10-15 % smaller (desk and boss chair, front and side)', async () => {
    const r = await page.evaluate(() => {
      const bb = (fn) => {
        const c = document.createElement('canvas'); c.width = c.height = 120; const g = c.getContext('2d');
        __seat.withCtx(g, fn);
        const d = g.getImageData(0, 0, 120, 120).data; let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 40) { const p = (i - 3) / 4, x = p % 120, y = Math.floor(p / 120);
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
      };
      return { desk: bb(() => _drawSeatChair(60, 60, false)), boss: bb(() => _drawSeatChair(60, 60, true)), side: bb(() => _drawSideChair(60, 60, 1)),
        rear: bb(() => _drawChairRear(60, 60, false)), bossRear: bb(() => _drawChairRear(60, 60, true)) };
    });
    // v0.10.0: desk 34 x 32, boss 40 x 36 (with the headrest), side 24 x 38
    assert.ok(r.desk.w <= 30 && r.desk.w >= 26 && r.desk.h <= 29, JSON.stringify(r));
    assert.ok(r.boss.w <= 35 && r.boss.w >= 30 && r.boss.h <= 33, JSON.stringify(r));
    assert.ok(r.side.w <= 22 && r.side.h <= 35, JSON.stringify(r));
    assert.ok(r.rear.w <= 30 && r.rear.h <= 29 && r.bossRear.w <= 35 && r.bossRear.h <= 33, JSON.stringify(r));
  });

  await check('side legs as thick as front legs (same trousers + shoes); no gap between torso and trousers at any idle bob', async () => {
    const r = await page.evaluate(() => {
      const S = __seat, out = { gaps: [] };
      const solo = (spec) => { const c = document.createElement('canvas'); c.width = c.height = 120; const g = c.getContext('2d');
        const a = agents[0]; S.place(a, Object.assign({ x: 60, y: 90 }, spec)); S.withCtx(g, () => a.draw()); return g.getImageData(0, 0, 120, 120).data; };
      const P = [0x2f, 0x5a, 0x3d], isP = (d, i) => d[i] === P[0] && d[i + 1] === P[1] && d[i + 2] === P[2];
      const runW = (d, y) => { let best = 0, cur = 0; for (let x = 0; x < 120; x++) { const i = (y * 120 + x) * 4; cur = isP(d, i) ? cur + 1 : 0; best = Math.max(best, cur); } return best; };
      // a leg row (y 89 = body y -1): front = one leg, side (no stride) = the legs overlap
      const front = solo({ force: 'down' }), side = solo({ force: 'right' });
      out.front = runW(front, 89); out.side = runW(side, 89);
      // every column through a leg is one opaque run from the hair to the shoe at each bob offset
      [[0, 'down'], [31, 'down'], [94, 'down'], [94, 'up'], [94, 'right'], [31, 'left']].forEach(([tick, v]) => {
        const d = solo({ force: v, tick });
        (v === 'left' || v === 'right' ? [-2, 1] : [-5, 4]).forEach(dx => { const x = 60 + dx; let state = 0, gap = 0; // columns through a leg
          for (let y = 66; y < 120; y++) { const op = d[(y * 120 + x) * 4 + 3] > 200; if (state === 0 && op) state = 1; else if (state === 1 && !op) state = 2; else if (state === 2 && op && y < 96) gap++; }
          if (gap) out.gaps.push(v + tick + ' x' + dx + ' gap ' + gap); });
      });
      return out;
    });
    assert.ok(r.front >= 7 && r.side === r.front, 'leg width front vs side: ' + JSON.stringify(r));
    assert.deepEqual(r.gaps, [], JSON.stringify(r));
  });

  await check('legs and shoes in the four walk views; a stride shows two feet apart', async () => {
    const r = await page.evaluate(() => {
      const S = __seat, box = { x: 160, y: 130, w: 80, h: 90 }, out = {};
      ['down', 'up', 'left', 'right'].forEach(v => {
        const f = S.find(S.render([], [{ x: 200, y: 200, walk: v, tick: 8 }], box), box, [S.SHOE, darken(S.SHOE, 0.2), darken(S.SHOE, 0.25)]);
        const p = S.find(S.render([], [{ x: 200, y: 200, walk: v, tick: 8 }], box), box, S.PANTS);
        out[v] = { n: f.n, w: f.x1 - f.x0 + 1, h: f.y1 - f.y0 + 1, pants: p.n };
      });
      return out;
    });
    for (const v of ['down', 'up', 'left', 'right']) assert.ok(r[v].n >= 8 && r[v].pants >= 40, `${v}: ${JSON.stringify(r)}`);
    assert.ok(r.left.w >= 10 && r.right.w >= 10, 'side stride: feet apart ' + JSON.stringify(r));
    assert.ok(r.down.h >= 4, 'front stride: one foot forward ' + JSON.stringify(r));
  });

  await check('a carried coffee follows the walk view (front hand in profile, hidden from behind)', async () => {
    const r = await page.evaluate(() => {
      const S = __seat, box = { x: 160, y: 140, w: 80, h: 80 }, out = {};
      ['left', 'right', 'up'].forEach(v => {
        const c = S.render([], [{ x: 200, y: 200, walk: v, tick: 8, carry: 'coffee' }], box);
        out[v] = { L: S.count(c, box, { x: 160, y: 170, w: 31, h: 40 }, ['#ffffff']).n, R: S.count(c, box, { x: 209, y: 170, w: 31, h: 40 }, ['#ffffff']).n };
      });
      return out;
    });
    assert.ok(r.left.L >= 10 && r.left.R === 0, JSON.stringify(r));
    assert.ok(r.right.R >= 10 && r.right.L === 0, JSON.stringify(r));
    assert.ok(r.up.L === 0 && r.up.R === 0, JSON.stringify(r));
  });

  await check('sitters sort on their feet (seatInfo / _sortY contract)', async () => {
    const r = await page.evaluate(([BOX, D]) => {
      const S = __seat;
      S.render([D], [{ desk: D }, { x: 260, y: 200 }], BOX);
      const [a, b] = S.last, info = a.seatInfo();
      // relative to the seat's hips (v0.13 seatreach moved the desk chair 9 px in: 0.12 dy 21, box 28+ from the desk origin)
      const hy = DESK_SEAT.desk[0].hy;
      return { dy: a._sortY() - a.y - hy, kind: info && info.kind, id: info && info.furnitureId, standDy: b._sortY() - b.y, standInfo: b.seatInfo(),
        box: a._bodyBox.y + a._bodyBox.h - a.y - hy };
    }, [BOX, desk('desk')]);
    assert.ok(r.dy >= 7 && r.dy <= 17, JSON.stringify(r));  // the chair base below the hips
    assert.equal(r.kind, 'desk'); assert.equal(r.id, 'd1');
    assert.equal(r.standDy, 0); assert.equal(r.standInfo, null);
    assert.ok(r.box >= 15, 'drawn body box reaches the feet: ' + JSON.stringify(r));
  });

  await check('desk arrival ends at the chair base in front of the desk, never over the desk top (Z-03)', async () => {
    const r = await page.evaluate(() => {
      const S = __seat;
      officeConfig.furniture = S.realFurniture;
      const a = agents[0];
      for (const item of S.realFurniture) {
        if (item.type !== 'desk' || (item.rotation || 0) !== 0) continue;
        for (const [ox, oy] of [[0, 70], [70, 50], [-70, 50]]) {
          S.place(a, { x: item.x + ox, y: item.y + oy });
          a.desk = { x: item.x, y: item.y }; a._seatCache = null; a.state = 'working'; a.task = 'Testing';
          a.targetX = item.x; a.targetY = item.y; a._prevTargetX = a.x; a._prevTargetY = a.y; // a new target: plan the walk
          const over = []; let arrived = false;
          for (let i = 0; i < 800; i++) {
            a.__upd.call(a);
            if (a.targetX !== item.x || a.targetY !== item.y) break;
            if (a.x === item.x && a.y === item.y) { arrived = true; break; }
            if (Math.abs(a.x - item.x) <= 35 && a.y >= item.y - 26 && a.y <= item.y + 3) over.push([Math.round(a.x - item.x), Math.round(a.y - item.y)]);
          }
          if (arrived) return { over: over.length, from: a._seatFrom, sitting: a.isSitting, base: DESK_SEAT.desk[0].hy + 13, edge: 14 };
        }
      }
      return { none: true };
    });
    assert.ok(!r.none, 'no agent reached its desk in the hermetic office');
    assert.equal(r.over, 0, 'walked over the desk top: ' + JSON.stringify(r));
    // from the chair base (hips + 13), in front of the desk's front edge (v0.13 seatreach: 0.12 had the base at 26)
    assert.ok(r.sitting && r.from && r.from.y >= r.base - 1 && r.from.y > r.edge, 'arrival should step up from the chair base: ' + JSON.stringify(r));
  });

  await check('no ghost meeting seats after the table is removed', async () => {
    const r = await page.evaluate((M) => {
      officeConfig.furniture = [M]; const before = _meetingSeatsNow().length;
      officeConfig.furniture = []; return { before, after: _meetingSeatsNow().length };
    }, MEET);
    assert.ok(r.before > 0 && r.after === 0, JSON.stringify(r));
  });

  await page.evaluate(() => { officeConfig.furniture = __seat.realFurniture; agents.forEach(a => { if (a.__upd) a.update = a.__upd; }); });
  await check('idle-at-desk animations (review 11-05 G): in every frame the chair stays over the sitter (back/side view: the chair back, front view: the armrests), the chair turns a quarter at a time, starts and ends facing the desk; desk + boss desk at every rotation; never at work or while the agent needs you; the scheduler starts them', async () => {
    const r = await page.evaluate(() => {
      const S = __seat, bad = [], out = { frames: 0, views: {} };
      const PAL = { desk: ['#2b333b', '#3c4650', '#4f5b66', '#66737e'], bossDesk: ['#2e1c17', '#3e2723', '#5d4037', '#795548'] };
      const a = agents[0], STEP = 3;
      const drawA = () => { const c = document.createElement('canvas'); c.width = c.height = 400; S.withCtx(c.getContext('2d'), () => a.draw()); return c; };
      for (const t of ['desk', 'bossDesk']) for (const rot of [0, 90, 180, 270]) {
        const D = { id: 'd1', type: t, x: 200, y: 200, rotation: rot }, work = _deskSeatPoses(_deskSeatSpot(D), t === 'bossDesk').work.view;
        officeConfig.furniture = [D];
        for (const kind of Object.keys(DESK_IDLE_DUR)) {
          let prev = null; const seen = new Set();
          for (let f = 0; f < DESK_IDLE_DUR[kind]; f += STEP) {
            const last = f + STEP >= DESK_IDLE_DUR[kind], ft = last ? DESK_IDLE_DUR[kind] - 1 : f;
            S.place(a, { desk: D, state: 'idle', tick: 1000, anim: [kind, ft] }); a._lifeHold = null;
            const c = drawA(), seat = a._lastSeat, ch = seat && seat.chair, v = seat && seat.view, k = t + rot + ' ' + kind + ' t' + ft;
            out.frames++; seen.add(v);
            if (!a._dIdle) { bad.push(k + ' animation dropped'); break; }
            if (prev && (DESK_VIEWS.indexOf(v) - DESK_VIEWS.indexOf(prev) + 4) % 4 === 2) bad.push(k + ' jumped ' + prev + '->' + v);
            if ((f === 0 || last) && v !== work) bad.push(k + ' not facing the desk at the ' + (f ? 'end' : 'start') + ': ' + v);
            prev = v;
            if (!ch) continue;
            const cnt = (x, y, w, h) => S.count(c, { x: 0, y: 0 }, { x, y, w, h }, PAL[t]);
            const hx = 200 + ch.x, hy = 200 + ch.y, hw = t === 'desk' ? 13 : 16;
            if (ch.t === 'rear') { const top = ch.tall || t !== 'desk' ? 11 : 9, q = cnt(hx - hw + 1, hy - top + 1, hw * 2 - 2, top + 3); if (q.n !== q.total) bad.push(k + ' chair back ' + q.n + '/' + q.total); }
            else if (ch.t === 'front') { const n = cnt(hx - hw - 1, hy - 5, 4, 2).n + cnt(hx + hw - 3, hy - 5, 4, 2).n; if (n !== 16) bad.push(k + ' armrests ' + n); }
            else if (ch.t === 'side') { const n = cnt(ch.dir > 0 ? hx - 6 : hx - 4, hy - 5, 11, 2).n; if (n !== 22) bad.push(k + ' side armrest ' + n); }
          }
          out.views[t + rot + ' ' + kind] = Array.from(seen).map(v => v[0]).join('');
        }
      }
      const D0 = { id: 'd1', type: 'desk', x: 200, y: 200 }; officeConfig.furniture = [D0];
      S.place(a, { desk: D0, tick: 1000, anim: ['spin', 30] }); drawA(); out.atWork = !!a._dIdle;
      S.place(a, { desk: D0, state: 'idle', tick: 1000, anim: ['spin', 30] }); a.waitingApprovalCount = 1; drawA(); out.needsYou = !!a._dIdle;
      S.place(a, { desk: D0, state: 'idle', tick: 1000, anim: ['spin', 30] }); a._lifeHold = null; drawA(); out.idle = !!a._dIdle;
      // the desk idle scheduler (Agent.update) starts one when its timer runs out
      S.place(a, { desk: D0, state: 'idle', tick: 1000 }); a._lifeHold = null; a.idleTimer = 1e9; a.deskIdleTimer = 1;
      try { a.__upd.call(a); } catch (e) { out.updErr = String(e).slice(0, 120); }
      out.started = a._dIdle && a._dIdle.kind; out.next = a.deskIdleTimer;
      a._dIdle = null;
      return { bad: bad.slice(0, 10), nbad: bad.length, out };
    });
    assert.equal(r.nbad, 0, JSON.stringify(r).slice(0, 900));
    assert.ok(r.out.frames > 1500, 'frames ' + r.out.frames);
    assert.ok(!r.out.atWork && !r.out.needsYou && r.out.idle, JSON.stringify(r.out).slice(0, 300));
    // the spin passes all four facings, the room swivel shows the face, sip/phone go sideways
    for (const k of Object.keys(r.out.views)) {
      if (/ spin$/.test(k)) assert.equal(r.out.views[k].length, 4, k + ' ' + r.out.views[k]);
      if (/ (room|lean)$/.test(k)) assert.ok(r.out.views[k].includes('d'), k + ' ' + r.out.views[k]);
      if (/ (sip|phone)$/.test(k)) assert.ok(/[lr]/.test(r.out.views[k]), k + ' ' + r.out.views[k]);
    }
    assert.ok(r.out.started && r.out.next > 240, 'scheduler: ' + JSON.stringify(r.out).slice(-200));
  });

  await check('through the real frame (depth sort of every piece, zorder): the chair back stays over the sitter at desk and boss desk, working and idle, also when a walker behind the desk makes the desk and its sitter draw again', async () => {
    const r = await page.evaluate(() => {
      const keep = { run: window._runSimulation, sdf: window._shouldDrawFrame, chips: window.drawAgentActivityChips, mm: window._drawMiniMap, bub: window.drawChatBubbles };
      window.__seatFreeze = true;
      window._runSimulation = () => 0; window._shouldDrawFrame = () => true; window.drawAgentActivityChips = () => {}; window._drawMiniMap = () => {}; window.drawChatBubbles = () => {};
      const out = {}, walls = officeConfig.walls.interior;
      try {
        for (const t of ['desk', 'bossDesk']) for (const st of ['working', 'idle']) for (const walker of [false, true]) {
          const D = { id: 'd1', type: t, x: 400, y: 300 };
          const frame = (sitter) => {
            officeConfig.furniture = [D]; officeConfig.walls.interior = [];
            agents.forEach(a => __seat.place(a, { x: -9000, y: -9000 }));
            if (sitter) __seat.place(agents[0], { desk: D, state: st });
            if (walker) __seat.place(agents[1], { x: 396, y: 300 - (t === 'desk' ? 28 : 38) });
            camera.zoom = 2; camera.x = 400 - W / 2; camera.y = 290 - H / 2;
            for (let i = 0; i < 2; i++) { _invalidateStaticLayer(); _staticSigCheckedAt = -1e9; _renderFrame(performance.now()); }
            const o = _cameraOrigin(), sp = _deskSeatSpot(D), hw = t === 'desk' ? 13 : 16, top = t === 'desk' ? 9 : 11;
            const q = { x: 400 + sp.hx - hw + 1, y: 300 + sp.hy - top + 1, w: hw * 2 - 2, h: top + 3 };
            const dev = (x, y, w, h) => ctx.getImageData(Math.round((o.x + x * o.s) * DPR) + 1, Math.round((o.y + y * o.s) * DPR) + 1, Math.round(w * o.s * DPR) - 2, Math.round(h * o.s * DPR) - 2).data;
            return { shell: dev(q.x, q.y, q.w, q.h), above: dev(q.x, q.y - 10, q.w, 8) };
          };
          const withS = frame(true), without = frame(false);
          let diff = 0, seen = 0;
          for (let i = 0; i < withS.shell.length; i++) if (Math.abs(withS.shell[i] - without.shell[i]) > 2) diff++;
          for (let i = 0; i < withS.above.length; i++) if (Math.abs(withS.above[i] - without.above[i]) > 8) seen++;
          out[t + ' ' + st + (walker ? ' +walker' : '')] = { diff, seen };
        }
      } finally {
        window._runSimulation = keep.run; window._shouldDrawFrame = keep.sdf; window.drawAgentActivityChips = keep.chips; window._drawMiniMap = keep.mm; window.drawChatBubbles = keep.bub;
        window.__seatFreeze = false; officeConfig.walls.interior = walls;
      }
      return out;
    });
    for (const [k, v] of Object.entries(r)) assert.ok(v.diff === 0 && v.seen > 50, k + ': the sitter paints over its chair back or is not drawn ' + JSON.stringify(r));
  });

  await check('no page errors', async () => {
    assert.deepEqual(errors.filter(e => !/ResizeObserver/.test(e)), []);
  });
  await context.close();
} finally {
  await browser.close();
}
if (failures) { console.log(`FAILED ${failures} check(s)`); process.exit(1); }
console.log('test_v10_seating_chairs: all checks passed');
