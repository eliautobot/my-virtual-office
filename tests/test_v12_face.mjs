// Faces test (v0.12 "Characters", face).
//
// Part 1 (always): the two Office Life hooks in a vm with a fake VOLife, the real
// director and a fake host (the test_life_moods_party pattern): VOLifeMoods.face
// hands over waiting / stuck / focused / relieved, VOLifeCelebrate.wonAt the last
// real win; both answer nothing when their feature is off.
// Part 2 (browser, hermetic): game.js _agentExpression picks the face from real
// state only, and every expression, headwear, glasses and facial hair is drawn
// through Agent.draw in front, left, right and back.
//
// Run: node tests/test_v12_face.mjs
// Part 2 needs playwright-core (or PLAYWRIGHT_CORE_PATH) and Chrome/Chromium
// (or CHROME_PATH); without them it prints SKIP for that part.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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

// ===================== Part 1: fake host (copied from test_life_moods_party) =====================
const Director = require(path.join(APP, 'office-life', 'director.js'));
const MOODS_SRC = fs.readFileSync(path.join(APP, 'office-life', 'moods.js'), 'utf8');
const PARTY_SRC = fs.readFileSync(path.join(APP, 'office-life', 'celebrate.js'), 'utf8');
function overlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }
function ctlFor(a) {
    const tag = { x: a.x - 22, y: a.y - 68, w: 44, h: 14 };
    return { tag, launcher: { x: a.x - 11, y: tag.y - 25, w: 22, h: 22 }, bubble: { x: tag.x + 47, y: tag.y - 4, w: 22, h: 22 }, bubbleShown: false, chip: null };
}
function fakeCtx() {
    const noop = () => {};
    return { save: noop, restore: noop, fillRect: noop, fillText: noop, strokeText: noop, drawImage: noop,
        measureText: s => ({ width: String(s).length * 6 }), globalAlpha: 1, font: '', fillStyle: '', strokeStyle: '' };
}

function world(opts = {}) {
    const clock = { t: 1_800_000_000_000 };
    const flags = { calm: false, rm: false, moods: true, celebrations: true };
    const list = (opts.agents || []).map(a => Object.assign({ statusKey: a.key, id: a.key, state: 'working', _statusState: 'working',
        isSitting: true, desk: { x: a.x, y: a.y }, faceDir: 1 }, a));
    const map = Object.fromEntries(list.map(a => [a.key, a]));
    list.forEach(a => { a._ctl = ctlFor(a); });
    const calls = { pose: [], walk: [], hold: [], release: [], food: [] };
    const host = {
        agents: () => list.slice(),
        agent: k => (k && typeof k === 'object' ? k : map[k] || null),
        hold(k, kind, o) { map[k]._lifeHold = { kind, label: (o && o.label) || '' }; calls.hold.push([k, kind]); return true; },
        release(k) { const a = map[k]; if (!a) return false; a._lifeHold = null; a._lifePose = null; a._lifeCarry = null; a._walk = null; calls.release.push(k); return true; },
        walkTo(k, x, y) { map[k]._walk = { x, y }; calls.walk.push([k, x, y]); return true; },
        walkStatus(k) { const a = map[k]; return !a._walk ? 'idle' : (a._arrive ? 'arrived' : 'walking'); },
        arrived(k) { return host.walkStatus(k) === 'arrived'; },
        place(k, x, y) { Object.assign(map[k], { x, y, _walk: null }); return true; },
        face(k, d) { map[k].faceDir = d; return true; },
        pose(k, name, data) { map[k]._lifePose = name || null; map[k]._lifePoseData = data || null; calls.pose.push([k, name || null]); return true; },
        carry(k, item) { map[k]._lifeCarry = item || null; return true; },
        spots: () => ({ kitchen: { x: 900, y: 572, standX: 916, standY: 618 } }),
        nearestWalkable: (x, y) => ({ x: Math.round(x), y: Math.round(y) }),
        walkable: () => true,
        ctlMetrics: () => ({ h: 22, gap: 3, font: 'bold 11px Arial' }),
        chrome: () => opts.chrome || [],
        keepOutOfChrome: r => r,
        view: () => ({ w: 1600, h: 900 }),
        scale: () => 1,
        worldToCanvas: (x, y) => ({ x, y }),
        editMode: () => false, markDirty() {}, markBusy() {}, invalidateStatic() { host.inv = (host.inv || 0) + 1; },
        // food-trip hook (game.js): choosers asked on an idle food break; trips are idle life, not holds
        choosers: {},
        foodChoice(name, fn) { if (fn) host.choosers[name] = fn; else delete host.choosers[name]; },
        foodTrip(k, o) { const a = map[k]; if (!a || a._food || a.state !== 'idle' || a._lifeHold) return false; a._food = o; calls.food.push([k, o && o.item]); return true; },
        foodTripOf(k) { const a = map[k]; return a && a._food ? { phase: 'go', item: a._food.item } : null; }
    };
    const director = Director.create(host, { now: () => clock.t, hidden: () => false, atDesk: () => flags.calm || flags.rm });
    const TEXT = { xp: '+{n} XP', projectDone: 'Project done!', backOnTrack: 'Back on track', phew: 'phew', holdHighfive: 'high-five', holdCake: 'getting cake' };
    const defs = {};
    const life = {
        host: () => host, director: () => director, sprites: () => null,
        t: (k, v) => String(TEXT[k] || '').replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : '')),
        addText(o) { Object.keys(o).forEach(k => { if (!(k in TEXT)) TEXT[k] = o[k]; }); },
        isOn: n => (n === 'moods' ? flags.moods : n === 'celebrations' ? flags.celebrations : true),
        atDesk: () => flags.calm || flags.rm, reducedMotion: () => flags.rm, noParticles: () => flags.calm || flags.rm,
        officeParts(ms) { const d = new Date(ms); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() || 7 }; },
        serverNow: () => clock.t, day: () => '',
        feature(name, def) { def.name = name; defs[name] = def; if (def.init) def.init(life); return def; }
    };
    const win = { VOLife: life };
    const ctx = vm.createContext({ window: win, console, __clock: clock });
    vm.runInContext('Date.now = function () { return __clock.t; };', ctx);
    vm.runInContext(MOODS_SRC, ctx, { filename: 'moods.js' });
    vm.runInContext(PARTY_SRC, ctx, { filename: 'celebrate.js' });
    const W = {
        clock, flags, host, director, calls, map, defs, win,
        ev(e) { const full = Object.assign({ _age: 0, _stale: false }, e); defs.moods.onEvent(full); defs.celebrate.onEvent(full); },
        step(ms, every = 50) {
            for (let t = 0; t < ms; t += every) {
                clock.t += every;
                director.update();
                defs.moods.update(clock.t);
                defs.celebrate.update(clock.t);
            }
        },
        draw() { const c = fakeCtx(); defs.moods.drawScreen(c); defs.celebrate.drawScreen(c); defs.celebrate.drawWorld(c); },
        party: () => JSON.parse(JSON.stringify(win.VOLifeCelebrate._debug())),
        moods: () => JSON.parse(JSON.stringify(win.VOLifeMoods._debug()))
    };
    return W;
}

await check('hooks: moods hand over waiting / stuck / focused / relieved, nothing when moods are off', () => {
    const W = world({ agents: [{ key: 'a', x: 200, y: 300 }, { key: 'b', x: 400, y: 300 }] });
    const M = W.win.VOLifeMoods;
    assert.equal(typeof M.face, 'function', 'VOLifeMoods.face exists');
    assert.equal(M.face(W.map.a), '');
    W.defs.moods.onState({ open: { moods: { a: 'stuck', b: 'focused' }, needs: [] } });
    assert.equal(M.face(W.map.a), 'stuck');
    assert.equal(M.face(W.map.b), 'focused');
    W.defs.moods.onState({ open: { moods: { a: 'stuck' }, needs: [{ agent: 'a', ref: 'r1' }] } });
    assert.equal(M.face(W.map.a), 'waiting', 'waiting for you wins over stuck');
    W.ev({ type: 'mood', agent: 'b', mood: 'relieved' });
    assert.equal(M.face(W.map.b), 'relieved', 'relieved after a stuck spell');
    W.ev({ type: 'mood', agent: 'b', mood: 'clear' });
    W.step(9000, 500);
    assert.equal(M.face(W.map.b), '', 'relief is over after 8 s');
    W.flags.moods = false;
    assert.equal(M.face(W.map.a), '', 'moods off: no face');
    W.flags.moods = true;
    W.map.a.state = W.map.a._statusState = 'offline';
    assert.equal(M.face(W.map.a), '', 'offline: no mood face');
});
await check('hooks: a real win is handed over with its time, nothing when celebrations are off', () => {
    const W = world({ agents: [{ key: 'a', x: 200, y: 300 }] });
    const C = W.win.VOLifeCelebrate;
    assert.equal(typeof C.wonAt, 'function', 'VOLifeCelebrate.wonAt exists');
    assert.equal(C.wonAt(W.map.a), 0);
    W.ev({ type: 'task.done', agent: 'a', points: 10 });
    assert.equal(C.wonAt(W.map.a), W.clock.t, 'task done = a win now');
    W.flags.celebrations = false;
    assert.equal(C.wonAt(W.map.a), 0, 'celebrations off: no win');
});

// ===================== Part 2: browser (harness copied from test_v10_art) =====================
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
  '/vo-config': { version: '0.10.0', office: { name: 'Face Test' }, features: {}, weather: { location: null } },
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


// One agent drawn through Agent.draw into a private canvas, in a forced view.
const PAGE_HELPERS = () => {
  window.__face = {
    canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
    withCtx(g, fn) { const saved = window.ctx; window.ctx = g; try { return fn(); } finally { window.ctx = saved; } },
    agent(app, extra) {
      const a = new Agent({ id: 'f' + Math.random(), statusKey: 'f', name: 'F', emoji: '', role: '', color: '#1e88e5', gender: 'M',
        appearance: Object.assign({ skinTone: '#e8b88a', hairStyle: 'short', hairColor: '#6d4c41' }, app || {}), _autoDesk: { x: 0, y: 0 } });
      a.x = a.targetX = 40; a.y = a.targetY = 80; a.desk = { x: 900, y: 900 }; a.isSitting = false; a.state = 'idle';
      a.blinkTimer = 0; a.tick = 0; a._lifeExtra = true;
      return Object.assign(a, extra || {});
    },
    shot(app, extra) { const c = __face.canvas(80, 100); const a = __face.agent(app, extra); __face.withCtx(c.getContext('2d'), () => a.draw()); return c; },
    // the head box (x 26..54, y 26..62 for an agent at 40,80) as a string signature
    head(c) { return Array.from(c.getContext('2d').getImageData(24, 22, 32, 42).data).join(','); },
    diff(c1, c2, x, y, w, h) {
      const p = c1.getContext('2d').getImageData(x, y, w, h).data, q = c2.getContext('2d').getImageData(x, y, w, h).data; let n = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2] || p[i + 3] !== q[i + 3]) n++;
      return n;
    },
  };
};

if (noBrowser) console.log(`SKIP test_v12_face part 2: ${noBrowser}`);
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
    await page.evaluate(PAGE_HELPERS);

    await check('expression: one function picks the face from real state only', async () => {
      const r = await page.evaluate(() => {
        const M0 = window.VOLifeMoods, C0 = window.VOLifeCelebrate, out = {};
        const a = __face.agent();
        try {
          let mood = '', won = 0;
          window.VOLifeMoods = { face: () => mood };
          window.VOLifeCelebrate = { wonAt: () => won };
          out.neutral = _agentExpression(a);
          for (const m of ['focused', 'stuck', 'waiting', 'relieved']) { mood = m; out[m] = _agentExpression(a); }
          mood = 'focused'; won = Date.now() - 1000; out.win = _agentExpression(a);
          won = Date.now() - 10000; out.oldWin = _agentExpression(a);
          a.state = 'offline'; out.offline = _agentExpression(a); a.state = 'idle';
          a._lifePose = 'snooze'; out.snooze = _agentExpression(a); a._lifePose = null;
          out.flashOk = agentFlashExpression(a, 'surprised', 800); out.flash = _agentExpression(a);
          out.flashBad = agentFlashExpression(a, 'nope', 800);
          a._exprFlash = null;
          window.VOLifeMoods = undefined; window.VOLifeCelebrate = undefined;
          out.lifeOff = _agentExpression(a);
          a.state = 'offline'; out.lifeOffOffline = _agentExpression(a);
        } finally { window.VOLifeMoods = M0; window.VOLifeCelebrate = C0; }
        return out;
      });
      assert.deepEqual(r, { neutral: 'neutral', focused: 'focused', stuck: 'stuck', waiting: 'waiting', relieved: 'happy',
        win: 'happy', oldWin: 'focused', offline: 'sleepy', snooze: 'sleepy', flashOk: true, flash: 'surprised', flashBad: false,
        lifeOff: 'neutral', lifeOffOffline: 'sleepy' });
    });


    // Pixel helpers on 80x100 shots of an agent standing at (40, 80): head x 28..52, y 42..60, hats up to y 26.
    await page.evaluate(() => {
      __face.count = (c, x, y, w, h, rgb) => { const d = c.getContext('2d').getImageData(x, y, w, h).data; let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (!rgb || (d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]))) n++; return n; };
      __face.px = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data).join(',');
      __face.sig = (c) => { const d = c.getContext('2d').getImageData(20, 20, 40, 44).data; let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) >>> 0; return h; };
    });

    await check('expressions: seven different faces in front and in both profiles; offline closes the eyes in profile too', async () => {
      const r = await page.evaluate(() => {
        const EX = ['neutral', 'focused', 'stuck', 'happy', 'sleepy', 'surprised', 'waiting'], out = {};
        for (const v of ['down', 'left', 'right']) out[v] = new Set(EX.map(e => __face.sig(__face.shot({}, { _forceView: v, _previewExpression: e })))).size;
        const white = c => __face.count(c, 26, 40, 30, 22, [255, 255, 255]);
        out.offlineSideWhite = white(__face.shot({}, { _forceView: 'right', state: 'offline' }));
        out.onlineSideWhite = white(__face.shot({}, { _forceView: 'right' }));
        out.blinkHappySame = __face.sig(__face.shot({}, { _previewExpression: 'happy', blinkTimer: 4 })) === __face.sig(__face.shot({}, { _previewExpression: 'happy' }));
        // a conversation mouth wins over the expression's mouth
        const m = (e) => __face.shot({}, { _previewExpression: e, _socialMouth: 'laugh' });
        out.socialWins = __face.diff(m('stuck'), m('neutral'), 30, 54, 20, 8);
        return out;
      });
      assert.deepEqual(r, { down: 7, left: 7, right: 7, offlineSideWhite: 0, onlineSideWhite: r.onlineSideWhite, blinkHappySame: true, socialWins: 0 });
      assert.ok(r.onlineSideWhite > 0, 'an awake profile shows the white of the eye');
    });

    await check('headwear: one table with 12 ids (0.12.0: + hair bow), each drawn in front, left, right and back', async () => {
      const r = await page.evaluate(() => {
        const ids = (window.HEADWEAR_STYLES || []).map(h => h.id), out = { ids, empty: [] };
        for (const id of ids) for (const v of ['down', 'left', 'right', 'up']) {
          const n = __face.diff(__face.shot({ headwear: id, headwearColor: '#8e24aa' }, { _forceView: v }), __face.shot({}, { _forceView: v }), 0, 0, 80, 100);
          if (n < 12) out.empty.push(id + ':' + v + '=' + n);
        }
        out.unknown = __face.diff(__face.shot({ headwear: 'retiredHat' }), __face.shot({}), 0, 0, 80, 100);
        return out;
      });
      assert.deepEqual(r.ids, ['hardhat', 'cap', 'crown', 'tiara', 'headband', 'goggles', 'headset', 'beanie', 'santa', 'witch', 'sunhat', 'bow']);
      assert.deepEqual(r.empty, [], 'every hat draws in every view');
      assert.equal(r.unknown, 0, 'an unknown id draws nothing');
    });

    await check('headwear follows the head: no jewels or lenses on the back, mic on the wearer\'s right, cap visor forward', async () => {
      const r = await page.evaluate(() => {
        const sh = (id, v) => __face.shot({ headwear: id, headwearColor: '#8e24aa' }, { _forceView: v });
        const out = {};
        out.crownJewelsBack = __face.count(sh('crown', 'up'), 20, 20, 40, 42, [229, 57, 53]);
        out.crownJewelsFront = __face.count(sh('crown', 'down'), 20, 20, 40, 42, [229, 57, 53]);
        out.gogglesLensBack = __face.count(sh('goggles', 'up'), 20, 20, 40, 42, [129, 212, 250]);
        out.micScreenLeftBack = __face.count(sh('headset', 'up'), 18, 50, 8, 8);
        out.micScreenRightBack = __face.count(sh('headset', 'up'), 54, 50, 8, 8);
        out.micFacingLeft = __face.count(sh('headset', 'left'), 18, 50, 8, 8);
        out.micFacingRight = __face.count(sh('headset', 'right'), 46, 50, 6, 6, [85, 85, 85]);
        out.capVisorRight = __face.count(sh('cap', 'right'), 52, 38, 8, 6);
        out.capVisorLeft = __face.count(sh('cap', 'left'), 20, 38, 8, 6);
        return out;
      });
      assert.equal(r.crownJewelsBack, 0, 'crown jewels face front'); assert.ok(r.crownJewelsFront > 0);
      assert.equal(r.gogglesLensBack, 0, 'goggle lenses face front');
      assert.equal(r.micScreenLeftBack, 0, 'from behind the mic is on screen right'); assert.ok(r.micScreenRightBack > 0);
      assert.equal(r.micFacingLeft, 0, 'facing left the mic is behind the head'); assert.ok(r.micFacingRight > 0, 'facing right the boom shows');
      assert.ok(r.capVisorRight > 0 && r.capVisorLeft > 0, 'the visor points the way the face looks');
    });

    await check('headwear and glasses stay on the head when it bends over a phone at the desk', async () => {
      const r = await page.evaluate(() => {
        const out = {};
        for (const rot of [0, 90]) {
          const desk = { id: 'face-desk' + rot, type: 'desk', x: 150, y: 150 }; if (rot) desk.rotation = rot;
          const saved = officeConfig.furniture; officeConfig.furniture = saved.concat([desk]);
          try {
            const top = (headDy, app) => {
              const c = __face.canvas(300, 300);
              const a = new Agent({ id: 'hdy' + rot, statusKey: 'hdy', name: 'H', emoji: '', role: '', color: '#e53935', gender: 'M',
                appearance: Object.assign({ skinTone: '#e8b88a', hairStyle: 'bald' }, app), _autoDesk: { x: 150, y: 150 } });
              a.x = a.targetX = 150; a.y = a.targetY = 150; a.desk = { x: 150, y: 150 }; a.isSitting = true; a.state = 'working'; a._seatT = 1; a.tick = 200; a.blinkTimer = 0; a._lifeExtra = true;
              a._deskIdleNow = () => ({ k: 0, arms: 'desk', s: 0, up: 0, lift: 0, tilt: 0, headDy }); // an idle-at-desk frame (phone)
              __face.withCtx(c.getContext('2d'), () => a.draw());
              const d = c.getContext('2d').getImageData(0, 0, 300, 300).data;
              for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) { const i = (y * 300 + x) * 4; if (d[i] === 0 && d[i + 1] === 255 && d[i + 2] === 0 && d[i + 3] === 255) return y; }
              return -1;
            };
            out['hat' + rot] = top(1, { headwear: 'beanie', headwearColor: '#00ff00' }) - top(0, { headwear: 'beanie', headwearColor: '#00ff00' });
            out['skin' + rot] = top(1, { skinTone: '#00ff00' }) - top(0, { skinTone: '#00ff00' });
          } finally { officeConfig.furniture = saved; }
        }
        return out;
      });
      assert.equal(r.skin0, 1, 'the head bends 1 px'); assert.equal(r.skin90, 1);
      assert.deepEqual([r.hat0, r.hat90], [1, 1], 'the hat moves with the head');
    });

    await check('glasses: arms over the ears from behind, round and square differ in profile', async () => {
      const r = await page.evaluate(() => {
        const g = (type, v) => __face.shot({ glasses: type, glassesColor: '#00ff00' }, { _forceView: v });
        return {
          back: ['round', 'square', 'sunglasses'].map(t => __face.count(g(t, 'up'), 20, 30, 40, 32, [0, 255, 0])),
          profileDiffer: ['left', 'right'].map(v => __face.diff(g('round', v), g('square', v), 0, 0, 80, 100) > 0),
          side: ['left', 'right'].map(v => __face.count(g('round', v), 20, 30, 40, 32, [0, 255, 0]) > 0),
        };
      });
      assert.ok(r.back.every(n => n > 0), 'from behind the arms show over the ears ' + r.back);
      assert.deepEqual(r.profileDiffer, [true, true]); assert.deepEqual(r.side, [true, true]);
    });

    await check('facial hair: one colour in every view, a beard leaves the nose and mouth clear, shows at the jaw from behind', async () => {
      const r = await page.evaluate(() => {
        const fh = (type, v, extra) => __face.shot({ facialHair: type, facialHairColor: '#00ff00' }, Object.assign({ _forceView: v }, extra || {}));
        const plain = __face.shot({}, {});
        const green = c => __face.count(c, 20, 30, 40, 34, [0, 255, 0]);
        return {
          stubbleColour: ['down', 'left', 'right'].map(v => green(fh('stubble', v)) > 0),
          beardBack: green(fh('beard', 'up')) > 0, mustacheBack: green(fh('mustache', 'up')),
          nose: __face.px(fh('beard', 'down'), 40, 53) === __face.px(plain, 40, 53),
          mouth: __face.px(fh('beard', 'down'), 40, 56) === __face.px(plain, 40, 56),
          mustacheNose: __face.px(fh('mustache', 'down'), 40, 53) === __face.px(plain, 40, 53),
        };
      });
      assert.deepEqual(r, { stubbleColour: [true, true, true], beardBack: true, mustacheBack: 0, nose: true, mouth: true, mustacheNose: true });
    });

    await check('every glasses and facial hair type draws in each view; seated at a desk from behind, hats and glasses face away', async () => {
      const r = await page.evaluate(() => {
        const out = { glassesEmpty: [], fhEmpty: [] };
        for (const t of ['round', 'square', 'sunglasses']) for (const v of ['down', 'left', 'right', 'up']) {
          const n = __face.diff(__face.shot({ glasses: t, glassesColor: '#00ff00' }, { _forceView: v }), __face.shot({}, { _forceView: v }), 0, 0, 80, 100);
          if (n < 4) out.glassesEmpty.push(t + ':' + v + '=' + n);
        }
        for (const t of ['stubble', 'beard', 'goatee', 'mustache']) for (const v of ['down', 'left', 'right']) {
          const n = __face.diff(__face.shot({ facialHair: t, facialHairColor: '#00ff00' }, { _forceView: v }), __face.shot({}, { _forceView: v }), 0, 0, 80, 100);
          if (n < 3) out.fhEmpty.push(t + ':' + v + '=' + n);
        }
        // Seated at a desk, drawn from behind (the usual desk view), standing still and typing.
        const desk = { id: 'face-back-desk', type: 'desk', x: 150, y: 150 };
        const saved = officeConfig.furniture; officeConfig.furniture = saved.concat([desk]);
        const seated = (app) => {
          const c = __face.canvas(300, 300);
          const a = new Agent({ id: 'sb', statusKey: 'sb', name: 'S', emoji: '', role: '', color: '#1e88e5', gender: 'M',
            appearance: Object.assign({ skinTone: '#e8b88a', hairStyle: 'short', hairColor: '#6d4c41' }, app), _autoDesk: { x: 150, y: 150 } });
          a.x = a.targetX = 150; a.y = a.targetY = 150; a.desk = { x: 150, y: 150 }; a.isSitting = true; a.state = 'working'; a._seatT = 1; a.tick = 0; a.blinkTimer = 0; a._lifeExtra = true;
          __face.withCtx(c.getContext('2d'), () => a.draw());
          return c;
        };
        const all = (c, rgb) => __face.count(c, 0, 0, 300, 300, rgb);
        try {
          const plain = seated({});
          out.seatedJewels = all(seated({ headwear: 'crown', headwearColor: '#8e24aa' }), [229, 57, 53]) - all(plain, [229, 57, 53]);
          out.seatedLenses = all(seated({ headwear: 'goggles', headwearColor: '#8e24aa' }), [129, 212, 250]) - all(plain, [129, 212, 250]);
          out.seatedHatsEmpty = (window.HEADWEAR_STYLES || []).map(h => h.id)
            .filter(id => __face.diff(seated({ headwear: id, headwearColor: '#8e24aa' }), plain, 0, 0, 300, 300) < 12);
          out.seatedArms = all(seated({ glasses: 'sunglasses', glassesColor: '#00ff00' }), [0, 255, 0]);
        } finally { officeConfig.furniture = saved; }
        return out;
      });
      assert.deepEqual(r.glassesEmpty, [], 'glasses missing in a view');
      assert.deepEqual(r.fhEmpty, [], 'facial hair missing in a view');
      assert.equal(r.seatedJewels, 0, 'seated from behind the crown jewels face front');
      assert.equal(r.seatedLenses, 0, 'seated from behind the goggle lenses face front');
      assert.deepEqual(r.seatedHatsEmpty, [], 'a hat is missing at the desk');
      assert.ok(r.seatedArms > 0, 'seated from behind the glasses arms show');
    });

    // ---- more checks are added above this line ----
    await check('no page errors', async () => {
      assert.deepEqual(errors.filter(e => !/ResizeObserver/.test(e)), []);
    });
    await context.close();
  } finally {
    await browser.close();
  }
}
if (failures) { console.log(`FAILED ${failures} check(s)`); process.exit(1); }
console.log('test_v12_face: all checks passed');
process.exit(0); // the vm world's timers would keep node alive
