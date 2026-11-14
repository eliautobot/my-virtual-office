// v0.11 kitchen walk test (review 11-10): nobody walks in place on a break trip, in any kitchen arrangement.
// Headless Chrome, fixture APIs, seeded Math.random, a virtual clock; nothing is written anywhere.
// Six arrangements (the default office, an anonymised real layout, a kitchen at the bottom edge, in a wall corner,
// with desks where the waiting line would stand, with the machines packed together), 12 idle agents sent on break
// trips every 10 s for KITCHEN_MINUTES (default 2) simulated minutes each. Checks per arrangement:
//   - nobody "walks" (a goal further than one step away) while staying within 3 px for more than 2 s;
//   - people are served at the counter appliances (coffee maker, microwave or toaster): the fix is not "give up";
//   - the engine's own invariant (_worldCheck) never fires and the page has no errors.
// Three causes were fixed: a counter appliance's use spot was not a use spot (no footprint of its own), so the walk
// ended beside it and the first in line never began; a waiting place inside furniture was set as the goal again on
// every step; and two people held off one spot (or a turn in the route) by each other were never counted as stuck.
// KITCHEN_ONLY=<name> narrows the run; WORLD_APP points at another app tree (to show the test fails on old code).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.WORLD_APP || path.resolve(here, '..', 'app'));
const MIN = Number(process.env.KITCHEN_MINUTES || 2), N = 12, ONLY = process.env.KITCHEN_ONLY || '';
const require = createRequire(import.meta.url);
function skip(reason) { console.log('SKIP test_v11_kitchen_walk: ' + reason); process.exit(0); }
function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) { try { return require(c); } catch { /* next */ } }
  return null;
}
const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const ORIGIN = 'http://office.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
const KIT = ['kitchenCounter', 'coffeeMaker', 'microwave', 'toaster', 'vendingMachine', 'waterCooler', 'fridge', 'breakArea'];
const def = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
const real = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'world-layout-8096.json'), 'utf8'));
function withKitchen(base, items, drop) {
  const c = JSON.parse(JSON.stringify(base));
  c.furniture = c.furniture.filter(f => !KIT.includes(f.type) && !(drop && drop(f)));
  items.forEach((it, i) => c.furniture.push(Object.assign({ id: 'k' + i }, it)));
  return c;
}
// Two counters side by side at (cx, cy) with the appliances on them (an appliance's y = counter y + 2 - its height).
function kitchenAt(cx, cy, extra) {
  return [{ type: 'kitchenCounter', x: cx, y: cy }, { type: 'kitchenCounter', x: cx + 80, y: cy },
    { type: 'coffeeMaker', x: cx + 12, y: cy - 20 }, { type: 'toaster', x: cx + 48, y: cy - 14 }, { type: 'microwave', x: cx + 92, y: cy - 22 }].concat(extra || []);
}
const inBox = (x0, y0, x1, y1) => f => f.x > x0 && f.x < x1 && f.y > y0 && f.y < y1;
const LAYOUTS = [
  { name: 'default office', config: def },
  { name: 'real layout (anonymised)', config: real },
  { name: 'kitchen at the bottom edge', config: withKitchen(def, kitchenAt(700, 640, [{ type: 'vendingMachine', x: 900, y: 600 }, { type: 'waterCooler', x: 960, y: 620 }]), inBox(660, 560, 1000, 740)) },
  { name: 'kitchen in a wall corner', config: withKitchen(def, kitchenAt(30, 560, [{ type: 'vendingMachine', x: 30, y: 420 }, { type: 'waterCooler', x: 100, y: 440 }]), inBox(0, 380, 260, 740)) },
  { name: 'desks where the line would wait', config: withKitchen(def, kitchenAt(720, 80, [{ type: 'vendingMachine', x: 900, y: 40 }, { type: 'waterCooler', x: 960, y: 60 }, { type: 'desk', x: 760, y: 190 }, { type: 'desk', x: 860, y: 190 }])) },
  { name: 'machines packed together', config: withKitchen(def, kitchenAt(720, 80, [{ type: 'vendingMachine', x: 884, y: 40 }, { type: 'waterCooler', x: 944, y: 60 }, { type: 'fridge', x: 660, y: 40 }])) },
].filter(l => !ONLY || l.name.includes(ONLY));

const people = Array.from({ length: N }, (_, i) => { const id = 'a' + String(i + 1).padStart(2, '0'); return { id, statusKey: id, name: 'Agent ' + (i + 1), emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }; });
const ids = people.map(p => p.id);
let failed = 0;
const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
try {
  for (const L of LAYOUTS) {
    const cfg = JSON.parse(JSON.stringify(L.config)); cfg.pet = { enabled: false };
    const FIX = { '/api/license': { demo: false, valid: true, limits: {} }, '/vo-config': { version: '0.11.0', office: { name: 'Kitchen' }, features: {}, weather: { location: null } },
      '/api/agents': { agents: people }, '/status': Object.fromEntries(ids.map(id => [id, { state: 'idle', task: '' }])), '/agent-chat': {}, '/api/office-config': cfg,
      '/weather-proxy': { current_condition: [], configured: false },
      '/api/office-life/state': { ok: true, seq: 1, day: '2026-11-04', tz: 'UTC', settings: { enabled: false, calm: false, timeZone: 'UTC', features: {} },
        open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], cake: false }, paper: { day: '2026-11-04', ready: false } } };
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.route('**/*', async (r) => {
      const req = r.request(); const url = new URL(req.url());
      if (url.origin !== ORIGIN) return r.abort();
      if (url.pathname === '/api/office-life/stream') return r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 5000\n\n' });
      if (req.method() !== 'GET' && req.method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      if (Object.prototype.hasOwnProperty.call(FIX, url.pathname)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX[url.pathname]) });
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const file = path.resolve(APP, rel); const ext = path.extname(file);
      if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) return r.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await context.addInitScript((seed) => {
      const R = Date, base = new R(2026, 10, 4, 10, 0, 0).getTime(), t0 = R.now(); let off = 0;
      const now = () => base + (R.now() - t0) + off; window.__vAdvance = (ms) => { off += ms; };
      class VD extends R { constructor(...a) { if (a.length === 0) super(now()); else super(...a); } static now() { return now(); } }
      window.Date = VD; let s = seed >>> 0;
      Math.random = function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      window.__voWorldCheck = 'every';
    }, 21);
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((k) => window.agents && window.agents.length >= k && window.VOWorld, N, { timeout: 30000 });
    await page.waitForTimeout(800);
    // Service: two people sent straight to every machine (the game's own queue call). Both must be served in turn.
    const svc = await page.evaluate(() => {
      const inter = LOCATIONS.interactions, ACT = { coffeeMaker: 'make_coffee', microwave: 'make_food', toaster: 'make_food', vendingMachine: 'get_snack', waterCooler: 'get_water' };
      const free = agents.filter(a => !a._lifeExtra), jobs = [], why = {}, rel = releaseObjectServiceQueueForAgent;
      window.releaseObjectServiceQueueForAgent = function (a, reason) { if (a && a.objectQueueKey) why[a.id] = reason; return rel(a, reason); };
      Object.keys(ACT).forEach(k => {
        const t = inter[k]; if (!t) return;
        for (let n = 0; n < 2; n++) {
          const a = free.shift(); if (!a) return;
          a.idleAction = null; a.state = 'idle';
          if (k === 'microwave' || k === 'toaster') a.foodSource = k;
          const target = Object.assign({}, t, { furnitureType: t.furnitureType || k, action: ACT[k], queueKey: t.queueKey || (k + ':' + Math.round(t.x) + ',' + Math.round(t.y)), queueConfig: t.queueConfig });
          jobs.push({ k, a, act: ACT[k], queued: enqueueAgentForObjectService(a, target, { action: ACT[k], faceDir: -1, serviceTicks: 120 }), served: false });
        }
      });
      for (let i = 0; i < 3600; i++) {
        window.__vAdvance(1000 / 60); _simulationStep();
        jobs.forEach(j => { if (j.a.idleAction === j.act && j.a.objectQueueKey) j.served = true; });
        if (jobs.every(j => j.served || !j.a.objectQueueKey)) break;
      }
      window.releaseObjectServiceQueueForAgent = rel;
      return jobs.map(j => ({ machine: j.k, id: j.a.id, queued: !!j.queued, served: j.served, waiting: !!j.a.objectQueueKey && !j.served, why: why[j.a.id] || '' }));
    });
    let out = null;
    for (let chunk = 0; chunk < MIN * 2; chunk++) {
      out = await page.evaluate(([steps, last]) => {
        const W = window.__wip || (window.__wip = {}), S = window.__ks || (window.__ks = { step: 0, trips: 0, served: {}, was: {} });
        const inter = LOCATIONS.interactions, USE = { make_coffee: 'coffee', make_food: 'food', get_snack: 'snack', get_water: 'water' };
        for (let i = 0; i < steps; i++) {
          S.step++;
          if (S.step % 600 === 30) agents.forEach((a, k) => {            // every 10 s: half of the idle people at rest go on a break trip
            if (a._lifeExtra || a.idleAction || a.state !== 'idle' || k % 2 !== (S.step / 600 | 0) % 2) return;
            const kit = ['vendingMachine', 'coffeeMaker', 'waterCooler', 'microwave', 'toaster'].map(q => inter[q]).filter(Boolean);
            if (!kit.length) return;
            const kx = kit.reduce((s, p) => s + p.x, 0) / kit.length, ky = kit.reduce((s, p) => s + p.y, 0) / kit.length;
            const e = _worldNear(kx, ky + 24, 20, 15);
            a.targetX = e.x; a.targetY = e.y; a.idleAction = 'break_browse'; a.breakPhase = 0; a.breakStops = 0; a.breakMaxStops = 1 + Math.floor(Math.random() * 3);
            a.breakChoice = null; a.idleReturnTimer = 0; a.isSitting = false; S.trips++;
          });
          window.__vAdvance(1000 / 60); _simulationStep();
          agents.forEach(a => {
            if (a._lifeExtra) return;
            const u = USE[a.idleAction] || '';
            if (u && S.was[a.id] !== u) S.served[u] = (S.served[u] || 0) + 1;
            S.was[a.id] = u;
            const w = W[a.id] || (W[a.id] = { hist: [], run: 0, max: 0, info: null });
            w.hist.push(a.x, a.y); if (w.hist.length > 180) w.hist.splice(0, 2);
            const walking = Math.abs(a.targetX - a.x) > a.speed || Math.abs(a.targetY - a.y) > a.speed;
            if (walking && w.hist.length >= 180 && Math.hypot(a.x - w.hist[0], a.y - w.hist[1]) < 3) {
              if (++w.run > w.max) { w.max = w.run; w.info = { doing: a.idleAction || a.state, at: [Math.round(a.x), Math.round(a.y)], to: [Math.round(a.targetX), Math.round(a.targetY)] }; }
            } else w.run = 0;
          });
        }
        if (!last) return null;
        const stuck = Object.keys(W).filter(id => W[id].max > 30).map(id => Object.assign({ id, steps: W[id].max }, W[id].info));
        return { trips: S.trips, served: S.served, stuck, hits: VOWorld.log().slice(0, 3) };
      }, [1800, chunk === MIN * 2 - 1]);
    }
    await context.close();
    const s = out.served, notServed = svc.filter(j => !j.served).map(j => j.machine + (j.waiting ? ' (still waiting)' : j.queued ? ' (left the line: ' + j.why + ')' : ' (no line)'));
    const summary = 'machines ' + [...new Set(svc.map(j => j.machine))].length + ', served ' + svc.filter(j => j.served).length + '/' + svc.length + ', busy trips ' + out.trips;
    try {
      assert.deepEqual(out.stuck, [], 'nobody walks in place');
      assert.ok(out.trips >= 20, 'break trips were made');
      assert.ok(svc.length >= 6, 'the kitchen has its machines');
      assert.deepEqual(notServed, [], 'everyone sent to a machine is served in turn');
      assert.deepEqual(out.hits, [], 'the world invariant never fires');
      assert.deepEqual(errors, [], 'no page errors');
      console.log('[PASS] ' + L.name + ': ' + summary + ', nobody walking in place');
    } catch (e) {
      failed++;
      console.log('[FAIL] ' + L.name + ': ' + e.message.split('\n')[0] + ' (' + summary + ') ' + JSON.stringify(notServed) + ' ' + JSON.stringify(out.stuck.slice(0, 3)));
    }
  }
} finally { await browser.close(); }
if (failed) { console.log('FAILED test_v11_kitchen_walk: ' + failed + ' of ' + LAYOUTS.length); process.exit(1); }
console.log('OK test_v11_kitchen_walk: ' + LAYOUTS.length + ' passed');
