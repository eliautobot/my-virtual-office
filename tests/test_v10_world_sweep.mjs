// v0.10.1 world sweep (W2): the placement rule holds for a whole simulated day. Headless Chrome, fixture
// APIs, a scripted Office life stream, seeded Math.random, a virtual clock; nothing is written anywhere.
// The engine's runtime invariant (_worldCheck: nobody inside a footprint, nobody seated without a seat, no
// counter appliance off a counter, and since v0.10.1 volumes the 3D one: no person's or pet's solid core inside a
// furniture box, no exemption but the declared seat holes; since v0.10.1 clearance: nobody standing at rest in a
// clearance band round a wall or a piece, no walk along one for more than CLR.runMax px) runs on EVERY simulation
// step and must never fire:
//   - the default layout and the live 8096 layout (fixtures/world-layout-8096.json = anonymised copy; the live
//     file named by WORLD_LIVE_CONFIG is used instead when present, read only)
//     with 3, 12 and 30 agents for a simulated 10-minute day at 60 steps/s: work and idle flips, idle actions
//     (couch, books, window, TV, break room, food trips, visits, wander, ping pong), a meeting, a gathering,
//     a stand-up, interns, couriers, a needs-you trip, the pet;
//   - targeted cases: the invariant itself fires on a bad state; delete an occupied desk (its owner gets a free
//     desk or a standing spot, never the middle of the office); move a desk onto a standing person; add a sofa
//     over an idle agent; rotate a desk with its sitter; an intern gives a free desk back to a newcomer;
//     Office life place/walkTo into furniture.
// WORLD_SWEEP_MINUTES (default 10), WORLD_SWEEP_ONLY=default|live, WORLD_SWEEP_COUNTS=3,12 narrow the run;
// WORLD_REPORT=1 prints per-minute stats.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.WORLD_APP || path.resolve(here, '..', 'app'));
const REPORT = !!process.env.WORLD_REPORT;
const MINUTES = Number(process.env.WORLD_SWEEP_MINUTES || 10);
const COUNTS = process.env.WORLD_SWEEP_COUNTS === 'none' ? [] : (process.env.WORLD_SWEEP_COUNTS || '3,12,30').split(',').map(Number);
const ONLY = process.env.WORLD_SWEEP_ONLY || '';
const LIVE_FILE = process.env.WORLD_LIVE_CONFIG || '';
const require = createRequire(import.meta.url);

function skip(reason) { console.log(`SKIP test_v10_world_sweep: ${reason}`); process.exit(0); }
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
const PET = { enabled: true, species: 'cat', name: 'Mochi' };

function layouts() {
  const out = [];
  const def = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
  out.push({ name: 'default', config: def });
  let live = null, src = '';
  try { live = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')); src = 'live file (read only)'; } catch { /* fixture */ }
  if (!live) { live = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'world-layout-8096.json'), 'utf8')); src = 'anonymised fixture'; }
  out.push({ name: 'live', config: live, src });
  return out.filter(l => !ONLY || l.name === ONLY);
}
// n agents; the first ones answer to the names the layout's desks are assigned to, so they sit at those desks
// (the rest take free desks or stand).
function roster(config, n) {
  const names = [...new Set((config.furniture || []).filter(f => (f.type === 'desk' || f.type === 'bossDesk') && f.assignedTo).map(f => f.assignedTo))];
  return Array.from({ length: n }, (_, i) => {
    const id = 'a' + String(i + 1).padStart(2, '0');
    return { id, statusKey: id, name: i < Math.ceil(n / 2) && names[i] ? names[i] : 'Agent ' + (i + 1), emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true };
  });
}
function lifeState(ids) {
  return { ok: true, seq: 100, day: '2026-11-04', tz: 'UTC',
    settings: { enabled: true, calm: false, timeZone: 'UTC', features: { needsYou: true, interns: true, handoffs: true, visitors: true, alarmClock: false,
      moods: true, celebrations: false, standup: true, seasons: false, tournaments: false, newspaper: false } },
    open: { needs: [], interns: ids.length > 1 ? { [ids[0]]: 2, [ids[1]]: 1 } : {}, moods: {} }, today: { birthdays: [], cake: false }, paper: { day: '2026-11-04', ready: false } };
}

async function openOffice(browser, config, agentsList, opts = {}) {
  const ids = agentsList.map(a => a.id);
  const life = { pending: [], seq: 100 };
  const cfg = JSON.parse(JSON.stringify(config));
  cfg.pet = PET;
  const FIX = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.1', office: { name: 'World Sweep' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: agentsList },
    '/status': Object.fromEntries(ids.map((id, i) => [id, { state: i % 3 ? 'working' : 'idle', task: i % 3 ? 'Building the thing' : '' }])),
    '/agent-chat': {}, '/api/office-config': cfg, '/weather-proxy': { current_condition: [], configured: false },
    '/api/office-life/state': lifeState(ids),
  };
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1600, height: 900 } });
  await context.route('**/*', async (r) => {
    const req = r.request(); const url = new URL(req.url());
    if (url.origin !== ORIGIN) return r.abort();
    if (url.pathname === '/api/office-life/stream') {
      let body = `retry: 500\n: seq ${life.seq}\n\n`;
      for (const ev of life.pending.splice(0)) { life.seq++; body += `id: ${life.seq}\ndata: ${JSON.stringify({ seq: life.seq, scope: 'connection', event: ev })}\n\n`; }
      return r.fulfill({ status: 200, contentType: 'text/event-stream', body });
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (Object.prototype.hasOwnProperty.call(FIX, url.pathname))
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() }, body: JSON.stringify(FIX[url.pathname]) });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel); const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile())
      return r.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.addInitScript((seed) => {
    // Virtual clock: real time plus what the simulated steps add. Seeded random (mulberry32).
    const R = Date, base = new R(2026, 10, 4, 10, 0, 0).getTime(), t0 = R.now();
    let off = 0;
    const now = () => base + (R.now() - t0) + off;
    window.__vAdvance = (ms) => { off += ms; };
    class VD extends R { constructor(...a) { if (a.length === 0) super(now()); else super(...a); } static now() { return now(); } }
    window.Date = VD;
    let s = seed >>> 0;
    Math.random = function() { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    window.__voWorldCheck = 'every';
  }, opts.seed || 7);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((k) => window.agents && window.agents.length >= k && window.VOWorld && window.VOLifeHost, agentsList.length, { timeout: 30000 });
  await page.waitForTimeout(800);
  return { page, errors, context, life, FIX };
}

// In page: run `steps` simulation steps on the virtual clock (60 per second); returns new invariant hits.
// WORLD_TRACE=1: keep the last 30 steps of every person and print the culprit's history at the first hit.
const TRACE = !!process.env.WORLD_TRACE;
async function run(page, steps) {
  const r = await page.evaluate(([n, trace]) => {
    const before = VOWorld.log().length, H = window.__hist || (window.__hist = {});
    if (trace && !window.__pw) { const pw = planWalk; window.__pw = []; window.planWalk = function(sx, sy, ex, ey, o) { const r = pw(sx, sy, ex, ey, o); const pet = officePets.find(q => q.targetX === ex && q.targetY === ey); const k = (pet ? 'pet:' + pet.state + ':' + Math.round(sx) + ',' + Math.round(sy) + '>' : '') + Math.round(ex) + ',' + Math.round(ey); (window.__pwN || (window.__pwN = {}))[k] = (window.__pwN[k] || 0) + 1; window.__pw.push([Math.round(sx), Math.round(sy), Math.round(ex), Math.round(ey), r && r.map(q => [Math.round(q.x), Math.round(q.y)]), r && r.partial, _fpLineClear(sx, sy, ex, ey, [sx, sy, ex, ey])]); if (window.__pw.length > 400) window.__pw.shift(); return r; }; }
    for (let i = 0; i < n; i++) {
      window.__vAdvance(1000 / 60); _simulationStep();
      if (!trace) continue;
      _worldPeople().forEach(p => { const h = H[p.id] || (H[p.id] = []); h.push([Math.round(p.x), Math.round(p.y), Math.round(p.targetX), Math.round(p.targetY), p._path ? p._path.length : 0, p.isSitting ? 1 : 0, p.idleAction || p.state, p._lifeIntern ? p._lifeIntern.phase : '']); if (h.length > 30) h.shift(); });
      if (VOWorld.log().length > before && !window.__traced) { window.__traced = 1; const v = VOWorld.log()[before], c = _worldPeople().find(q => q.id === v.id); return { hits: VOWorld.log().slice(before), trace: { v, h: H[v.id], path: c && c._path && c._path.map(q => [Math.round(q.x), Math.round(q.y)]), goal: c && c._seatGoal, fine: VOWorld.stats().finePlans,
        plans: (window.__pw || []).filter(e => Math.abs(e[2] - (c._seatGoal || c).targetX) < 2 || (c._path && c._path.length && Math.abs(e[2] - c._path[c._path.length - 1].x) < 2)).slice(-3), fp: VOWorld.feetIn(c.x, c.y) } }; }
    }
    return { hits: VOWorld.log().slice(before) };
  }, [steps, TRACE]);
  if (r.trace) console.log('TRACE ' + JSON.stringify(r.trace.v) + ' path ' + JSON.stringify(r.trace.path) + ' goal ' + JSON.stringify(r.trace.goal) + ' fine ' + r.trace.fine + ' fp ' + JSON.stringify(r.trace.fp) + '\n  plans ' + JSON.stringify(r.trace.plans) + '\n  ' + (r.trace.h || []).slice(0, +(process.env.WORLD_TRACE_N || 3)).map(e => JSON.stringify(e)).join('\n  '));
  return r.hits;
}

// One minute of the day script (in page): status flips, the meeting, the gathering.
async function dayEvents(page, minute) {
  return page.evaluate((m) => {
    const out = {};
    const free = agents.filter(a => !a.meetingId && !a._lifeHold);
    // a third of the agents flip between work and idle every minute
    free.forEach((a, i) => {
      if ((i + m) % 3) return;
      const work = a.state !== 'working';
      a.task = work ? 'Shipping v0.10.1' : '';
      a.moveTo(work ? 'working' : 'idle');
    });
    if (m === 1) {  // a meeting at the table: up to 6 agents
      const slots = getMeetingSlots();
      const who = free.filter(a => !a._lifeHold).slice(0, Math.min(6, slots.length));
      who.forEach((a, i) => a.joinMeeting('sweep-meeting', slots[i], 'Sweep'));
      out.meeting = who.length;
    }
    if (m === 3) agents.forEach(a => { if (a.meetingId === 'sweep-meeting') { a.leaveMeeting(); a.moveTo('idle'); } });
    if (m === 2 || m === 7) { startGathering(); out.gathering = groupGatherings.length; }
    return out;
  }, minute);
}
function lifeEvents(life, minute, ids) {
  const a = (i) => ids[i % ids.length];
  if (minute === 2) life.pending.push({ type: 'visitor', agent: a(2), channel: 'telegram', session: 's1' });
  if (minute === 4) life.pending.push({ type: 'standup.start', id: 'su-1', status: 'open',
    lines: ids.slice(0, 4).map((id, i) => ({ agent: id, line: 'Line ' + (i + 1) })), summary: 'All good.' });
  if (minute === 5) life.pending.push({ type: 'needs.open', agent: a(3), ref: 'n1', need: 'approval', title: 'Sign this' });
  if (minute === 6) { life.pending.push({ type: 'visitor', agent: a(4), channel: 'slack', session: 's2' }); life.pending.push({ type: 'interns.set', agent: a(2), count: 2 }); }
  if (minute === 7) life.pending.push({ type: 'needs.close', agent: a(3), ref: 'n1', outcome: 'approved' });
  if (minute === 8) life.pending.push({ type: 'standup.end', id: 'su-1' });
}

const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
let passed = 0, failed = 0;
function ok(cond, what) { if (cond) { passed++; if (REPORT) console.log('ok ' + what); } else { failed++; console.log('FAIL ' + what); } }
const fmt = (v) => `${v.kind}: ${v.who || ''} (${v.x},${v.y}) ${v.item} [${v.state}] ${v.walk ? JSON.stringify(v.walk) : ''}`;

try {
  // ---------------- the day sweep ----------------
  for (const L of layouts()) {
    for (const n of COUNTS) {
      const people = roster(L.config, n), ids = people.map(p => p.id);
      const { page, errors, context, life } = await openOffice(browser, L.config, people, { seed: 11 + n });
      try {
        const t0 = Date.now(), hits = [], seen = { interns: 0, couriers: 0, seated: 0, food: 0, couch: 0, meeting: 0, gathering: 0, standup: 0, moved: 0 };
        const start = await page.evaluate(() => agents.map(a => [a.x, a.y])), away = new Set();
        for (let m = 0; m < MINUTES; m++) {
          lifeEvents(life, m, ids);
          await page.waitForTimeout(700);  // the stream reconnects (retry 500 ms) and delivers
          const ev = await dayEvents(page, m);
          if (ev.meeting) seen.meeting = ev.meeting;
          if (ev.gathering) seen.gathering = Math.max(seen.gathering, ev.gathering);
          for (let k = 0; k < 6; k++) {  // a minute in 10 s slices, sampling who is where
            hits.push(...await run(page, 600));
            const s = await page.evaluate(() => {
              const ex = _lifeExtras.filter(x => x instanceof Agent);
              return { interns: ex.filter(x => x._lifeIntern).length, couriers: ex.filter(x => x._lifeCourier).length,
                seated: agents.filter(a => a.isSitting).length, food: agents.filter(a => a._lifeFood || a.idleAction === 'break_browse' || a.carryItem).length,
                couch: agents.filter(a => a.idleAction === 'couch').length, standup: agents.filter(a => a._lifeHold && a._lifeHold.kind === 'standup').length,
                pos: agents.map(a => [a.x, a.y]) };
            });
            s.pos.forEach((p, i) => { if (start[i] && Math.abs(p[0] - start[i][0]) + Math.abs(p[1] - start[i][1]) > 20) away.add(i); });
            delete s.pos;
            for (const k2 of Object.keys(s)) seen[k2] = Math.max(seen[k2] || 0, s[k2]);
          }
          if (REPORT) console.log(`  ${L.name}/${n} minute ${m + 1}: ${hits.length} hits, ${JSON.stringify(seen)}`);
        }
        const end = await page.evaluate(() => ({ stats: VOWorld.stats(), left: VOWorld.check(), top: Object.entries(window.__pwN || {}).sort((a, b) => b[1] - a[1]).slice(0, 4),
          who: Object.entries(window.__pwN || {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => { const [x, y] = k.split(',').map(Number); const a = agents.find(q => Math.abs(q.targetX - x) < 2 && Math.abs(q.targetY - y) < 2) || agents.find(q => q.desk && Math.abs(q.desk.x - x) < 2 && Math.abs(q.desk.y - y) < 2);
            return a && { id: a.id, x: Math.round(a.x), y: Math.round(a.y), desk: a.desk, st: a.state, idle: a.idleAction, hold: a._lifeHold && a._lifeHold.kind, meet: a.meetingId, partial: a._pathPartial }; }) }));
        if (TRACE) console.log('  plans by target ' + JSON.stringify(end.top) + ' ' + JSON.stringify(end.who));
        seen.moved = away.size;  // agents seen > 20 px away from where they started
        const tag = `${L.name}${L.src ? ' (' + L.src + ')' : ''} x ${n} agents, ${MINUTES} min`;
        console.log(`${tag}: ${((Date.now() - t0) / 1000).toFixed(1)} s real, ${end.stats.footprints} footprints, ${end.stats.seats} seats, ${end.stats.finePlans} free-floor walks, seen ${JSON.stringify(seen)}`);
        hits.slice(0, 8).forEach(v => console.log('   ' + fmt(v)));
        ok(hits.length === 0 && end.left.length === 0, `${tag}: the invariant never fired (${hits.length})`);
        ok(errors.length === 0, `${tag}: no page errors ${errors.slice(0, 2).join(' | ')}`);
        ok(seen.moved >= Math.ceil(n / 3), `${tag}: people got up and about during the day (${seen.moved} of ${n})`);
        if (n >= 12) {
          ok(seen.interns > 0, `${tag}: interns came in (${seen.interns})`);
          ok(seen.seated > 0, `${tag}: people sat (${seen.seated})`);
          ok(seen.meeting > 0, `${tag}: a meeting was held (${seen.meeting})`);
        }
      } finally { await context.close(); }
    }
  }

  // ---------------- targeted cases (default layout, 20 agents: 15 at desks, 5 standing) ----------------
  if (!ONLY || ONLY === 'default') {
    const def = layouts().find(l => l.name === 'default') || { config: JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8')) };
    const people = roster({ furniture: [] }, 20);
    const { page, errors, context } = await openOffice(browser, def.config, people, { seed: 5 });
    try {
      await run(page, 120);
      // 0. the invariant itself fires on a bad state (settle held off), then the state is put back
      const self = await page.evaluate(() => {
        const a = agents.find(x => !x.isSitting) || agents[0], save = { x: a.x, y: a.y, tx: a.targetX, ty: a.targetY, s: a.isSitting, p: a._path };
        const desk = officeConfig.furniture.find(f => f.type === 'desk'), fp = _itemFootprints(desk)[0];
        a.x = a.targetX = fp.x + fp.w / 2; a.y = a.targetY = fp.y + fp.h - 4; a.isSitting = false;
        const inside = VOWorld.check().some(v => v.kind === 'inside a footprint' && v.id === a.id);
        const fl = _worldNearestFree(W / 2, H - 40); a.x = a.targetX = fl.x; a.y = a.targetY = fl.y; a.isSitting = true; a._path = null;
        const air = VOWorld.check().some(v => v.kind === 'seated without a seat' && v.id === a.id);
        Object.assign(a, { x: save.x, y: save.y, targetX: save.tx, targetY: save.ty, isSitting: save.s, _path: save.p });
        const cm = { id: 'probe-cm', type: 'coffeeMaker', x: 600, y: 700 };
        officeConfig.furniture.push(cm);
        const off = VOWorld.check().some(v => v.kind === 'off its surface' && v.item === 'coffeeMaker#probe-cm');
        officeConfig.furniture.pop();
        VOWorld.reset();
        return { inside, air, off };
      });
      ok(self.inside && self.air && self.off, `invariant fires: inside a footprint ${self.inside}, seated without a seat ${self.air}, off its surface ${self.off}`);

      // 1. delete an occupied desk: its owner gets a free desk or a standing spot (was the middle of the office)
      const del = await page.evaluate(() => {
        const a = agents.find(x => x.desk && x.desk.id != null && x.isSitting);
        if (!a) return null;
        const d = officeConfig.furniture.find(f => f.id === a.desk.id);
        if (!d.assignedTo) d.assignedTo = a.name;
        editMode = true; selectedItemId = d.id; _deleteSelectedItem(); editMode = false;
        return { id: a.id, old: { x: d.x, y: d.y }, desk: { x: a.desk.x, y: a.desk.y, id: a.desk.id } };
      });
      ok(!!del, 'a seated agent with a desk exists');
      await run(page, 60 * 20);
      const delAfter = await page.evaluate((id) => {
        const a = agentMap[id], d = a.desk;
        return { x: a.x, y: a.y, desk: { x: d.x, y: d.y, id: d.id }, isDesk: !!officeConfig.furniture.find(f => f.id === d.id), spotOk: _spawnSpotOk(d.x, d.y),
          mid: d.x === Math.floor(W / 2) && d.y === Math.floor(H / 2), inside: !!_feetIn(a.x, a.y) && !_worldSeatAt(a.x, a.y) };
      }, del.id);
      ok(!delAfter.mid && (delAfter.isDesk || delAfter.spotOk), `delete an occupied desk: the owner moves to ${delAfter.isDesk ? 'a free desk' : 'a standing spot'} (${delAfter.desk.x},${delAfter.desk.y}), not the middle`);
      ok(!delAfter.inside, 'the owner of the deleted desk never stands inside furniture');

      // 2. move a desk onto a standing person; 3. add a sofa over an idle agent
      const moved = await page.evaluate(() => {
        const st = agents.filter(a => !a.isSitting && !a.meetingId && !_worldSeatAt(a.x, a.y) && a.x === a.targetX && a.y === a.targetY);
        if (st.length < 2) return null;
        const p = st[0], q = st[1];
        const desk = officeConfig.furniture.find(f => f.type === 'desk' && !agents.some(a => a.desk && a.desk.id === f.id && a.isSitting));
        const d = desk || officeConfig.furniture.find(f => f.type === 'desk');
        d.x = Math.round(p.x); d.y = Math.round(p.y) + 4;  // desk top over the feet
        const sofa = { id: 'sweep-sofa', type: 'couch', x: Math.round(q.x) - 60, y: Math.round(q.y) - 20, rotation: 0 };
        officeConfig.furniture.push(sofa);
        buildCollisionGrid(); getInteractionSpots();
        return { p: p.id, q: q.id, pIn: !!_feetIn(p.x, p.y), qIn: !!_feetIn(q.x, q.y) };
      });
      ok(!!moved && moved.pIn && moved.qIn, `the moved desk and the new sofa cover a standing person each (${JSON.stringify(moved)})`);
      await run(page, 60 * 15);
      const movedAfter = await page.evaluate((m) => [m.p, m.q].map(id => { const a = agentMap[id]; return !!_feetIn(a.x, a.y) && !_worldSeatAt(a.x, a.y); }), moved);
      ok(!movedAfter[0], 'move a desk onto a standing person: the person steps out');
      ok(!movedAfter[1], 'add a sofa over an idle agent: the agent steps out');

      // 4. rotate a desk with its sitter
      const rot = await page.evaluate(() => {
        const a = agents.find(x => x.isSitting && x.desk && x.desk.id != null && x.x === x.desk.x && x.y === x.desk.y);
        if (!a) return null;
        a.task = 'Typing'; a.state = 'working'; a.idleAction = null;
        const d = officeConfig.furniture.find(f => f.id === a.desk.id);
        d.rotation = 90; buildCollisionGrid();
        return { id: a.id, d: d.id };
      });
      ok(!!rot, 'a sitter at a desk exists');
      await run(page, 60 * 5);
      const rotAfter = await page.evaluate((r) => {
        const a = agentMap[r.id], d = officeConfig.furniture.find(f => f.id === r.d);
        a.draw && 0;
        return { at: a.x === d.x && a.y === d.y, sit: a.isSitting, seat: !!_worldSeatAt(a.x, a.y), pose: !!a._deskSeatInfo(false) };
      }, rot);
      ok(rotAfter.at && rotAfter.sit && rotAfter.seat && rotAfter.pose, `rotate a desk with its sitter: still seated at it, turned pose (${JSON.stringify(rotAfter)})`);

      // 5. Office life place / walkTo into furniture: snapped; sit on a non-seat: stays standing
      const lifeP = await page.evaluate(() => {
        const H = window.VOLifeHost, a = agents.find(x => !x.isSitting && !x.meetingId);
        const vm = officeConfig.furniture.find(f => f.type === 'vendingMachine') || officeConfig.furniture.find(f => f.type === 'bookshelf');
        const fp = _itemFootprints(vm)[0];
        H.place(a, fp.x + fp.w / 2, fp.y + fp.h / 2, { sit: true });
        const r1 = { inside: !!_feetIn(a.x, a.y), sit: a.isSitting };
        H.walkTo(a, fp.x + fp.w / 2, fp.y + fp.h / 2);
        const r2 = { goalInside: !!_feetIn(a.targetX, a.targetY) };
        H.release && H.release(a);
        return Object.assign(r1, r2);
      });
      ok(!lifeP.inside && !lifeP.sit && !lifeP.goalInside, `Office life place/walkTo into furniture snap to free floor, sit on a non-seat stays standing (${JSON.stringify(lifeP)})`);
      await run(page, 60 * 10);

      const log = await page.evaluate(() => VOWorld.log());
      log.slice(0, 8).forEach(v => console.log('   ' + fmt(v)));
      ok(log.length === 0, `targeted cases: the invariant never fired (${log.length})`);
      ok(errors.length === 0, `targeted cases: no page errors ${errors.slice(0, 2).join(' | ')}`);
    } finally { await context.close(); }
    // 6. an intern at a free desk gives it back to a newcomer (3 agents: free desks for the interns)
    {
      const people3 = roster({ furniture: [] }, 3);
      const { page, errors, context, FIX } = await openOffice(browser, def.config, people3, { seed: 3 });
      try {
        await run(page, 60 * 20);
        // 6. an intern at the last free desk gives it back to a newcomer
        const free = await page.evaluate(() => _lifeFreeDesks().length);
        const intern = await page.evaluate(() => {
          const it = _lifeExtras.find(x => x instanceof Agent && x._lifeIntern && x.isSitting && _worldSeatAt(x.x, x.y) && _isDeskType(_worldSeatAt(x.x, x.y).kind));
          return it ? { id: it.id, x: it.x, y: it.y } : null;
        });
        if (intern) {
          // the newcomer takes exactly that desk: every other free desk gets an absent owner
          await page.evaluate((it) => {
            officeConfig.furniture.forEach(f => { if (_isDeskType(f.type) && !f.assignedTo && !(f.x === it.x && f.y === it.y) && !agents.some(a => a.desk && a.desk.id === f.id)) f.assignedTo = 'Nobody Here'; });
          }, intern);
          FIX['/api/agents'] = { agents: roster({ furniture: [] }, 4) };
          await page.evaluate(() => _fetchRoster());
          await page.waitForFunction(() => agents.length === 4, null, { timeout: 10000 });
          await run(page, 60 * 10);
          const nc = await page.evaluate((it) => {
            const a = agentMap.a04, x = _lifeExtras.find(e => e.id === it.id);
            return { ix: x && [x.x, x.y, x.isSitting, x._lifeIntern && x._lifeIntern.phase], newDesk: a && a.desk.x === it.x && a.desk.y === it.y, newSeated: a && a.isSitting && a.x === it.x && a.y === it.y,
              internOff: !x || !(x.x === it.x && x.y === it.y), internInside: x ? (!!_feetIn(x.x, x.y) && !_worldSeatAt(x.x, x.y)) : false };
          }, intern);
          ok(nc.newDesk && nc.newSeated && nc.internOff && !nc.internInside, `an intern gives a free desk back to a newcomer (${JSON.stringify(nc)}, ${free} free desks before)`);
        } else ok(false, `an intern sat at a free desk (${free} free desks)`);
        const log = await page.evaluate(() => VOWorld.log());
        log.slice(0, 8).forEach(v => console.log('   ' + fmt(v)));
        ok(log.length === 0, `intern case: the invariant never fired (${log.length})`);
        ok(errors.length === 0, `intern case: no page errors ${errors.slice(0, 2).join(' | ')}`);
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }

console.log(`test_v10_world_sweep: ${passed} passed, ${failed} failed`);
if (failed) { console.log('WORLD SWEEP FAILED'); process.exit(1); }
console.log('ALL WORLD SWEEP CHECKS PASSED');
