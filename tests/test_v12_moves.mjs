// Moves test (v0.12 "Characters", moves): work animations at the desk from the real tool kind,
// signature moves played on real wins, waves on the click hook.
//
// Run: node tests/test_v12_moves.mjs
// Needs playwright-core (or PLAYWRIGHT_CORE_PATH) and Chrome/Chromium (or CHROME_PATH); without them it prints SKIP.

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

// ===================== Part 1: celebrate.js hands real wins to the host (vm, copied from test_v12_face) =====================
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
    const calls = { pose: [], walk: [], hold: [], release: [], food: [], sig: [] };
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
        signature(k) { calls.sig.push(k); return !flags.noSig; }, // v0.12 moves: game.js plays the agent's move
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

await check('signature moves: real wins play the move (task done, project done, back on track), rate-limited, not when celebrations are off', () => {
    const W = world({ agents: [{ key: 'a', x: 200, y: 300 }, { key: 'b', x: 400, y: 300 }, { key: 'c', x: 600, y: 300 }] });
    W.ev({ type: 'task.done', agent: 'a', points: 10 }); W.step(200);
    assert.deepEqual(W.calls.sig, ['a'], 'task done');
    W.ev({ type: 'task.done', agent: 'a', points: 10 }); W.step(200);
    assert.deepEqual(W.calls.sig, ['a'], 'one per 20 s (the celebration rate limit)');
    W.ev({ type: 'project.done', agents: ['b', 'c'] }); W.step(200);
    assert.deepEqual(W.calls.sig, ['a', 'b', 'c'], 'project done');
    W.clock.t += 25000;
    W.ev({ type: 'mood', agent: 'a', mood: 'clear', backOnTrack: true }); W.step(200);
    assert.deepEqual(W.calls.sig, ['a', 'b', 'c', 'a'], 'back on track');
    assert.ok(!W.calls.pose.some(p => p[0] === 'a' && p[1] === 'fistpump'), 'the move replaces the generic fist pump');
    W.flags.noSig = true; W.clock.t += 25000;
    W.ev({ type: 'mood', agent: 'b', mood: 'clear', backOnTrack: true }); W.step(200);
    assert.ok(W.calls.pose.some(p => p[0] === 'b' && p[1] === 'fistpump'), 'no move played (Office life off in game.js): the old fist pump');
    W.flags.celebrations = false; W.flags.noSig = false; W.clock.t += 25000;
    const n = W.calls.sig.length;
    W.ev({ type: 'task.done', agent: 'c', points: 5 }); W.ev({ type: 'project.done', agents: ['a'] }); W.step(200);
    assert.equal(W.calls.sig.length, n, 'celebrations off: nothing');
});

// ===================== browser harness (copied from test_v12_face) =====================
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
  '/vo-config': { version: '0.10.0', office: { name: 'Moves Test' }, features: {}, weather: { location: null } },
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
  window.__mv = {
    canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
    withCtx(g, fn) { const saved = window.ctx; window.ctx = g; try { return fn(); } finally { window.ctx = saved; } },
    agent(app, extra) {
      const a = new Agent({ id: 'f' + Math.random(), statusKey: 'f', name: 'F', emoji: '', role: '', color: '#1e88e5', gender: 'M',
        appearance: Object.assign({ skinTone: '#e8b88a', hairStyle: 'short', hairColor: '#6d4c41' }, app || {}), _autoDesk: { x: 0, y: 0 } });
      a.x = a.targetX = 40; a.y = a.targetY = 80; a.desk = { x: 900, y: 900 }; a.isSitting = false; a.state = 'idle';
      a.blinkTimer = 0; a.tick = 0; a._lifeExtra = true;
      return Object.assign(a, extra || {});
    },
    shot(app, extra) { const c = __mv.canvas(80, 100); const a = __mv.agent(app, extra); __mv.withCtx(c.getContext('2d'), () => a.draw()); return c; },
    // the head box (x 26..54, y 26..62 for an agent at 40,80) as a string signature
    head(c) { return Array.from(c.getContext('2d').getImageData(24, 22, 32, 42).data).join(','); },
    diff(c1, c2, x, y, w, h) {
      const p = c1.getContext('2d').getImageData(x, y, w, h).data, q = c2.getContext('2d').getImageData(x, y, w, h).data; let n = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2] || p[i + 3] !== q[i + 3]) n++;
      return n;
    },
  };
};

// The tool names each provider sends, with the work they are (one per provider family at least).
const TOOL_CASES = [
  // OpenClaw (incl. its wrappers and prefixes)
  ['exec', 'terminal'], ['process', 'terminal'], ['read', 'editor'], ['write', 'editor'], ['edit', 'editor'],
  ['apply_patch', 'editor'], ['browser', 'browser'], ['web_fetch', 'browser'], ['web_search', 'search'],
  ['memory_search', 'search'], ['sessions_send', 'message'], ['sessions_spawn', 'message'], ['message', 'message'],
  ['openclaw:main:exec', 'terminal'], ['functions.read', 'editor'],
  // Hermes
  ['terminal', 'terminal'], ['execute_code', 'terminal'], ['read_file', 'editor'], ['write_file', 'editor'], ['patch', 'editor'],
  ['search_files', 'search'], ['browser_navigate', 'browser'], ['web_extract', 'browser'], ['delegate_task', 'message'],
  ['send_message', 'message'],
  // Codex
  ['shell', 'terminal'], ['local_shell', 'terminal'], ['exec_command', 'terminal'], ['write_stdin', 'terminal'], ['view_image', 'editor'],
  // Claude Code / OpenCode (and MCP tools of any server)
  ['Bash', 'terminal'], ['Read', 'editor'], ['Edit', 'editor'], ['MultiEdit', 'editor'], ['NotebookEdit', 'editor'],
  ['Glob', 'search'], ['Grep', 'search'], ['LS', 'search'], ['list', 'search'], ['WebFetch', 'browser'], ['WebSearch', 'search'],
  ['Task', 'message'], ['Agent', 'message'], ['mcp__openclaw__exec', 'terminal'], ['mcp__playwright__browser_click', 'browser'],
  // Gemini / Antigravity
  ['run_shell_command', 'terminal'], ['read_many_files', 'editor'], ['replace', 'editor'], ['search_file_content', 'search'],
  ['google_web_search', 'search'], ['list_directory', 'search'],
  // unknown: plain typing
  ['TodoWrite', 'other'], ['update_plan', 'other'], ['image_generate', 'other'],
];

if (noBrowser) console.log(`SKIP test_v12_moves: ${noBrowser}`);
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

    await check('work kind: one table classifies the tool names of every provider (chips, monitors, desk)', async () => {
      const bad = await page.evaluate((cases) => cases.map(([n, k]) => [n, k, _shortToolLabel({ name: n }).kind]).filter(c => c[1] !== c[2]).map(c => c[0] + '=' + c[2] + '!=' + c[1]), TOOL_CASES);
      assert.deepEqual(bad, [], bad.join(' '));
      // wrappers: the inner tool decides, through the same path the chip uses
      const w = await page.evaluate(() => [
        _shortToolLabel({ name: 'tool_call', arguments: { id: 'exec', args: { command: 'ls' } } }).kind,
        _shortToolLabel({ name: 'dispatch_action', arguments: JSON.stringify({ name: 'web_fetch', args: { url: 'https://example.com/x' } }) }).kind]);
      assert.deepEqual(w, ['terminal', 'browser'], w.join(' '));
    });

    // A working agent at a desk (type, rotation), drawn as a frame draws it: the desk's static art, then the sorted
    // people and tall parts. tool = the running tool's name ('' = thinking, no tool).
    await page.evaluate(() => {
      window.__mvd = {
        TOOLS: { terminal: 'exec', browser: 'web_fetch', editor: 'read_file', search: 'Grep', message: 'sessions_send', thinking: '', other: 'TodoWrite' },
        scene(type, rot, tool, tick, fn, noDesk) {
          const item = { id: 'mvd', type, x: 300, y: 300, rotation: rot }, a = agents[0], keep = officeConfig.furniture;
          officeConfig.furniture = [item];
          a.appearance = Object.assign({}, getDefaultAppearance(a), { costume: null, heldItem: null, hairStyle: 'short', shirtStyle: 'tee' });
          Object.assign(a, { isSitting: true, state: 'working', idleAction: null, meetingId: null, carryItem: null, _lifePose: null, _lifeCarry: null,
            _lifeExtra: false, _seatCache: null, _seatT: 1, _seatFrom: null, _forceView: null, tick, _lastSeat: null, _swv: null, _dIdle: null,
            waitingApprovalCount: 0, activeToolCount: 0, _activityFrame: -1, _react: null, _sigMove: null });
          if (fn) fn(a);
          a.x = a.targetX = a._prevTargetX = item.x; a.y = a.targetY = a._prevTargetY = item.y; a.desk = { x: item.x, y: item.y };
          agentChatData[a.statusKey] = tool ? [{ role: 'assistant', text: '', tools: [{ name: tool, status: 'running' }] }] : [{ role: 'assistant', text: 'x' }];
          const box = { x: 230, y: 210, w: 140, h: 130 }, c = document.createElement('canvas'); c.width = box.w; c.height = box.h;
          const g = c.getContext('2d'), s = window.ctx; window.ctx = g;
          try {
            g.setTransform(1, 0, 0, 1, -box.x, -box.y); g.fillStyle = '#d3c8b8'; g.fillRect(box.x, box.y, box.w, box.h);
            if (!noDesk) drawFurnitureItem(item, { staticOnly: true });
            const ents = noDesk ? [a] : [a].concat(_tallFurnitureEntries()); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
          } finally { window.ctx = s; officeConfig.furniture = keep; }
          c.anim = a._workNow; c.monitor = (_monitorKind(a) || {}).kind;
          return c;
        },
        diff(c1, c2) { return __mv.diff(c1, c2, 0, 0, c1.width, c1.height); },
        count(c, hexes) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
          for (let i = 0; i < d.length; i += 4) { const h = '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join(''); if (hexes.includes(h)) n++; } return n; },
      };
    });

    await check('work animations: the desk shows what the monitor shows (one source: _agentActivity), unknown = typing', async () => {
      const r = await page.evaluate(() => Object.entries(__mvd.TOOLS).map(([kind, tool]) => { const c = __mvd.scene('desk', 0, tool, 10); return kind + ':' + c.anim + '/' + c.monitor; }));
      assert.deepEqual(r, ['terminal:burst/terminal', 'browser:scroll/browser', 'editor:papers/editor', 'search:scan/search', 'message:talk/message', 'thinking:ponder/thinking', 'other:type/other']);
    });

    await check('work animations: each one reads in the back view, both profiles and the front (differs from typing), and moves', async () => {
      const r = await page.evaluate(() => {
        const out = [];
        ['desk', 'bossDesk'].forEach(type => [0, 90, 180, 270].forEach(rot => {
          ['terminal', 'browser', 'editor', 'search', 'message', 'thinking'].forEach(kind => {
            const T = { burst: [0, 12], scroll: [0, 4], papers: [20, 120], scan: [0, 45], talk: [9, 18], ponder: [0, 100] };
            const typ = __mvd.scene(type, rot, 'TodoWrite', 10), a0 = __mvd.scene(type, rot, __mvd.TOOLS[kind], T[a0Name(kind)][0]);
            const a1 = __mvd.scene(type, rot, __mvd.TOOLS[kind], T[a0Name(kind)][1]);
            const dTyp = __mvd.diff(typ, a0), dMove = __mvd.diff(a0, a1);
            if (dTyp < 12 || dMove < 2) out.push(type + rot + ' ' + kind + ' vsTyping=' + dTyp + ' move=' + dMove);
          });
        }));
        function a0Name(k) { return WORK_ANIMS[k]; }
        return out;
      });
      assert.deepEqual(r, [], r.join(', '));
    });

    await check('work animations: reduced motion / Calm = one still key frame (no loop)', async () => {
      const r = await page.evaluate(() => {
        const out = [], keep = window._rxStill;
        Object.values(WORK_ANIMS).forEach(m => { if (JSON.stringify(_workFrame(m, 3, true)) !== JSON.stringify(_workFrame(m, 77, true))) out.push(m + ' moves'); });
        // and the drawn arms: the same agent at two ticks, breathing and the screen held (only the work frame may change)
        window._rxStill = () => true;
        const kb = Agent.prototype.draw;
        try {
          ['terminal', 'browser', 'editor', 'search', 'message', 'thinking'].forEach(kind => {
            const f1 = (__mvd.scene('desk', 0, __mvd.TOOLS[kind], 3), agents[0]._wkLast), f2 = (__mvd.scene('desk', 0, __mvd.TOOLS[kind], 77), agents[0]._wkLast);
            const J = f => JSON.stringify(Object.assign({}, f, { pc: 0 }));
            if (!f1 || J(f1) !== J(f2)) out.push(kind + ' drawn frame differs');
          });
        } finally { window._rxStill = keep; }
        return out;
      });
      assert.deepEqual(r, [], r.join(', '));
    });

    await check('work animations: the papers lie on the desk top at its papers spot (clear of the item, drink, monitor, keyboard) and show', async () => {
      const r = await page.evaluate(() => {
        const out = [], ov = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        ['desk', 'bossDesk'].forEach(type => [0, 90, 180, 270].forEach(rot => {
          const it = { type, x: 0, y: 0, rotation: rot }, s = DESK_SEAT[type][rot], p = s.papers, turned = rot === 90 || rot === 270;
          const w = turned ? 6 : 9, h = turned ? 8 : 6, pr = { x: p[0] - (w >> 1), y: p[1] - (h >> 1) - 3, w, h: h + 4 }; // as drawn: the turning page over it, the shadow row under it
          const top = _deskTopRect(it);
          if (!(pr.x >= top.x && pr.y >= top.y && pr.x + pr.w <= top.x + top.w && pr.y + pr.h <= top.y + top.h)) out.push(type + rot + ' off the top');
          const others = [{ n: 'item', x: s.item[0] - 3, y: s.item[1] - 3, w: 18, h: 14 }, { n: 'food', x: s.food[0] - 1, y: s.food[1] - 5, w: 13, h: 14 }]
            .concat(_deskMonitorRects(it).map(m => ({ n: 'monitor', x: m.x, y: m.y, w: m.w, h: m.h })));
          const kb = FURNITURE_MANIFEST[type].projection.parts.filter(q => q.name === 'keyboard')[0];
          if (kb) { const t = rot ? _projTurn(kb.plan, rot) : kb.plan; others.push({ n: 'keyboard', x: t[0], y: t[1] - 21, w: t[2], h: t[3] }); }
          others.forEach(o => { if (ov(pr, o)) out.push(type + rot + ' on the ' + o.n); });
          const n = __mvd.count(__mvd.scene(type, rot, 'read', 20), ['#f9a825', '#c79100']);
          if (n < 6) out.push(type + rot + ' hidden (' + n + ' px)');
        }));
        return out;
      });
      assert.deepEqual(r, [], r.join(', '));
    });

    await check('signature moves: one table (8 moves, each under 2.5 s); auto = a pure function of the agent id (every tab agrees); unknown id = auto', async () => {
      const r = await page.evaluate(() => {
        const ids = SIGNATURE_MOVES.map(m => m.id);
        const keys = Array.from({ length: 40 }, (_, i) => 'agent-' + i), pick = keys.map(k => _sigMoveOf({ id: k }));
        const a = __mv.agent({ signatureMove: 'moonwalk' }), b = __mv.agent({ signatureMove: 'salute' });
        return { ids, long: SIGNATURE_MOVES.filter(m => !(m.ms > 0 && m.ms <= 2500)).map(m => m.id), pick,
          unknown: _sigMoveOf(a) === _sigMoveOf({ id: a.id }), saved: _sigMoveOf(b) };
      });
      assert.equal(r.ids.length, 8); assert.equal(new Set(r.ids).size, 8); assert.deepEqual(r.long, []);
      const fnv = s => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
      assert.deepEqual(r.pick, Array.from({ length: 40 }, (_, i) => r.ids[fnv('agent-' + i) % 8]), 'auto is the id hash, nothing per tab');
      assert.ok(new Set(r.pick).size >= 6, 'auto spreads the moves');
      assert.equal(r.unknown, true); assert.equal(r.saved, 'salute');
    });

    await check('signature moves: every move draws standing (front, left, right, back) and seated (desk from behind, turned desk both ways, behind a desk turned 180), and moves', async () => {
      const r = await page.evaluate(() => {
        const out = [];
        const at = (a, id, p) => { const m = _sigMoveSpec(id); a._sigMove = { id, at: performance.now() - p * m.ms, ms: m.ms, still: false, until: Infinity }; };
        const HOLD = { salute: 1, bow: 1 };
        SIGNATURE_MOVES.forEach(m => {
          ['down', 'left', 'right', 'up'].forEach(v => {
            const shot = p => { const c = __mv.canvas(80, 100), a = __mv.agent({}, { _forceView: v, faceDir: v === 'left' ? -1 : 1 }); if (p != null) at(a, m.id, p); __mv.withCtx(c.getContext('2d'), () => a.draw()); return c; };
            const none = shot(null), fr = [0.2, 0.3, 0.55].map(shot);
            const d0 = Math.max(...fr.map(c => __mv.diff(none, c, 0, 0, 80, 100))), d1 = Math.max(__mv.diff(fr[0], fr[1], 0, 0, 80, 100), __mv.diff(fr[1], fr[2], 0, 0, 80, 100));
            if (d0 < 8 || (d1 < 2 && !HOLD[m.id])) out.push(m.id + ' stand ' + v + ' vsNone=' + d0 + ' move=' + d1);
          });
          [0, 90, 270, 180].forEach(rot => {
            const none = __mvd.scene('desk', rot, 'TodoWrite', 10), fr = [0.2, 0.3, 0.55].map(p => __mvd.scene('desk', rot, 'TodoWrite', 10, a => at(a, m.id, p)));
            const d0 = Math.max(...fr.map(c => __mvd.diff(none, c))), d1 = Math.max(__mvd.diff(fr[0], fr[1]), __mvd.diff(fr[1], fr[2]));
            if (d0 < 8 || (d1 < 2 && !HOLD[m.id])) out.push(m.id + ' seated ' + rot + ' vsNone=' + d0 + ' move=' + d1);
          });
        });
        return out;
      });
      assert.deepEqual(r, [], r.join(', '));
    });

    await check('signature moves: end cleanly in the pose the agent had (seated at work, standing), the work goes on', async () => {
      const r = await page.evaluate(() => {
        const at = (a, id, p) => { const m = _sigMoveSpec(id); a._sigMove = { id, at: performance.now() - p * m.ms, ms: m.ms, still: false, until: Infinity }; };
        const out = {};
        const before = __mvd.scene('desk', 0, 'exec', 10, null, true), during = __mvd.scene('desk', 0, 'exec', 10, a => at(a, 'dance', 0.3), true);
        out.workDuring = agents[0]._workNow;
        const after = __mvd.scene('desk', 0, 'exec', 10, a => at(a, 'dance', 1.01), true);
        out.seated = [__mvd.diff(before, during) > 0, __mvd.diff(before, after), agents[0]._sigMove, agents[0].state, agents[0]._workNow];
        const shot = p => { const c = __mv.canvas(80, 100), a = __mv.agent({}, { _forceView: 'left', faceDir: -1 }); if (p != null) at(a, 'spin', p); __mv.withCtx(c.getContext('2d'), () => a.draw()); return [c, a]; };
        const [s0] = shot(null), [s1, a1] = shot(1.02);
        out.standing = [__mv.diff(s0, s1, 0, 0, 80, 100), a1._sigMove, a1._drawView];
        return out;
      });
      assert.deepEqual(r.seated, [true, 0, null, 'working', 'burst']);
      assert.equal(r.workDuring, null, 'during the move the move draws, not the work');
      assert.deepEqual(r.standing, [0, null, 'left']);
    });

    await check('signature moves: played only with Office life and celebrations on (not offline, not for an intern); reduced motion / Calm = a still pose; no static redraw', async () => {
      const r = await page.evaluate(async () => {
        const keep = VOLife.isOn, keepRx = window._rxStill, a = agents[0], out = {};
        Object.assign(a, { state: 'idle', _sigMove: null, _lifePose: null, _lifeCarry: null, _lifeExtra: false });
        try {
          VOLife.isOn = () => false; out.off = [VOLifeHost.signature(a.statusKey), a._sigMove];
          VOLife.isOn = n => n !== 'celebrations'; out.celebOff = [VOLifeHost.signature(a.statusKey), a._sigMove];
          VOLife.isOn = () => true; out.on = [VOLifeHost.signature(a.statusKey), a._sigMove && a._sigMove.id === _sigMoveOf(a)];
          a._sigMove = null; a.state = 'offline'; out.offline = [VOLifeHost.signature(a.statusKey), a._sigMove]; a.state = 'idle';
          const x = __mv.agent(); out.intern = _playSignature(x);
          // reduced motion: one still pose (two moments of the move are the same picture, not the agent without it)
          window._rxStill = () => true;
          const shot = p => { const c = __mv.canvas(80, 100), b = __mv.agent({}, { _forceView: 'down' }); b._lifeExtra = false; _playSignature(b, { id: 'jump', preview: true }); b._sigMove.at -= p * b._sigMove.ms; __mv.withCtx(c.getContext('2d'), () => b.draw()); return [c, b]; };
          const [n0] = (() => { const c = __mv.canvas(80, 100), b = __mv.agent({}, { _forceView: 'down' }); __mv.withCtx(c.getContext('2d'), () => b.draw()); return [c]; })();
          const [c1, b1] = shot(0.2), [c2] = shot(0.7);
          out.still = [b1._sigMove && b1._sigMove.still, __mv.diff(c1, c2, 0, 0, 80, 100), __mv.diff(n0, c1, 0, 0, 80, 100) > 0];
          window._rxStill = keepRx;
          // in the live office: a move plays in the dynamic pass only
          a.state = 'idle'; a._sigMove = null;
          const b0 = window.__voStats.staticBuilds; await new Promise(res => setTimeout(res, 1500)); out.baseBuilds = window.__voStats.staticBuilds - b0;
          const s0 = window.__voStats.staticBuilds; VOLifeHost.signature(a.statusKey);
          await new Promise(res => setTimeout(res, 1500));
          out.staticBuilds = window.__voStats.staticBuilds - s0;
        } finally { VOLife.isOn = keep; window._rxStill = keepRx; }
        return out;
      });
      assert.deepEqual(r.off, [false, null]); assert.deepEqual(r.celebOff, [false, null]); assert.deepEqual(r.on, [true, true]);
      assert.deepEqual(r.offline, [false, null]); assert.equal(r.intern, false);
      assert.deepEqual(r.still, [true, 0, true]);
      assert.ok(r.staticBuilds <= r.baseBuilds, 'static rebuilds while a move plays ' + r.staticBuilds + ' (without: ' + r.baseBuilds + ')');
    });

    // A standing or walking agent (not a preview: it may turn), drawn alone; react = { kind, ago (ms) } or null.
    await page.evaluate(() => {
      window.__mvw = {
        stand(face, react, opts) {
          const c = __mv.canvas(80, 110), a = __mv.agent({}, { _lifeExtra: false, state: 'idle', _walkFace: face, faceDir: face === 'left' ? -1 : 1 });
          a.y = a.targetY = 90;
          if (opts && opts.walk) { a.targetX = a.x + 300; a._walkFace = 'right'; a._pvx = a.x - 1; a._pvy = a.y; }
          if (opts && opts.offline) a.state = 'offline';
          if (face === 'up') a.idleAction = 'look_window'; // standing with the back to you (at a window)
          if (react) a._react = { kind: react.kind, at: performance.now() - react.ago, n: 1 };
          __mv.withCtx(c.getContext('2d'), () => a.draw());
          return { c, view: a._drawView, state: a.state, wk: a._react && a._react.wk };
        },
        icon(c) { return __mvd.count(c, ['#ffd54f', '#4e342e']); },
      };
    });

    await check('waves: standing or idle turns to you and waves (the hand moves); walking = a quick wave on the move; then as before', async () => {
      const r = await page.evaluate(() => {
        const W = __mvw, none = W.stand('up'), w1 = W.stand('up', { kind: 'click', ago: 300 }), w2 = W.stand('up', { kind: 'click', ago: 450 });
        const done = W.stand('up', { kind: 'click', ago: WAVE_MS.wave + 50 });
        const wn = W.stand('right', null, { walk: true }), ww = W.stand('right', { kind: 'click', ago: 300 }, { walk: true }), wd = W.stand('right', { kind: 'click', ago: WAVE_MS.walk + 50 }, { walk: true });
        return { stand: [w1.view, w1.wk, w1.state, W.icon(w1.c) === 0, __mv.diff(none.c, w1.c, 0, 0, 80, 110) > 20, __mv.diff(w1.c, w2.c, 0, 0, 80, 110) > 0, done.view, __mv.diff(none.c, done.c, 0, 0, 80, 110)],
          walk: [ww.wk, ww.view, __mv.diff(wn.c, ww.c, 0, 0, 80, 110) > 10, __mv.diff(wn.c, wd.c, 0, 0, 80, 110)] };
      });
      assert.deepEqual(r.stand, ['down', 'wave', 'idle', true, true, true, 'up', 0], JSON.stringify(r));
      assert.deepEqual(r.walk, ['walk', 'right', true, 0]);
    });

    await check('waves: at work with the back to you (or in profile) the chair turns, a small wave, back to work; behind a desk turned 180 a wave', async () => {
      const r = await page.evaluate(() => {
        const out = {};
        [0, 90, 270, 180].forEach(rot => {
          const base = __mvd.scene('desk', rot, 'exec', 10), seat = agents[0]._lastSeat, v0 = seat.view || 'down';
          const during = __mvd.scene('desk', rot, 'exec', 10, a => { a._lastSeat = seat; a._react = { kind: 'click', at: performance.now() - 500, n: 1 }; });
          const vd = agents[0]._lastSeat.view || 'down', wk = agents[0]._react.wk, st = agents[0].state;
          const after = __mvd.scene('desk', rot, 'exec', 10, a => { a._lastSeat = seat; a._react = { kind: 'click', at: performance.now() - WAVE_MS.turn - 50, n: 1, wk }; });
          out[rot] = [v0, wk, vd, st, __mvd.diff(base, during) > 20, agents[0]._lastSeat.view || 'down', agents[0]._workNow];
        });
        return out;
      });
      assert.deepEqual(r[0], ['up', 'turn', 'right', 'working', true, 'up', 'burst']);
      assert.deepEqual(r[90], ['right', 'turn', 'down', 'working', true, 'right', 'burst']);
      assert.deepEqual(r[270], ['left', 'turn', 'down', 'working', true, 'left', 'burst']);
      assert.deepEqual(r[180], ['down', 'wave', 'down', 'working', true, 'down', 'burst']);
    });

    await check('waves: dozing or offline = stirs (no wave, no icon); the menu Wave = the bigger wave with a hand icon over the head', async () => {
      const r = await page.evaluate(() => {
        const W = __mvw, off = W.stand('down', null, { offline: true }), stir = W.stand('down', { kind: 'click', ago: 260 }, { offline: true });
        const click = W.stand('down', { kind: 'click', ago: 500 }), big = W.stand('down', { kind: 'wave', ago: 500 });
        return { stir: [stir.wk, __mv.diff(off.c, stir.c, 0, 0, 80, 110) > 10, W.icon(stir.c)], big: [big.wk, W.icon(big.c) > 20, W.icon(click.c), __mv.diff(click.c, big.c, 0, 0, 80, 110) > 10] };
      });
      assert.deepEqual(r.stir, ['stir', true, 0]);
      assert.deepEqual(r.big, ['wave', true, 0, true]);
    });

    await check('waves: reduced motion / Calm = the hand icon and a still hand; the click never changes what the agent does; the rate limit holds', async () => {
      const r = await page.evaluate(() => {
        const keep = window._rxStill, keepOn = VOLife.isOn, out = {};
        try {
          window._rxStill = () => true;
          const s1 = __mvw.stand('left', { kind: 'click', ago: 200 }), s2 = __mvw.stand('left', { kind: 'click', ago: 700 });
          out.still = [__mv.diff(s1.c, s2.c, 0, 0, 80, 110), __mvw.icon(s1.c) > 20];
          window._rxStill = keep;
          VOLife.isOn = () => true;
          const a = agents[0]; Object.assign(a, { state: 'working', _react: null, _sigMove: null }); const before = JSON.stringify([a.state, a.isSitting, a.targetX, a.targetY, a.idleAction, a._lifePose]);
          out.first = _reactAgent(a, 'click'); out.again = _reactAgent(a, 'click');
          out.same = before === JSON.stringify([a.state, a.isSitting, a.targetX, a.targetY, a.idleAction, a._lifePose]);
        } finally { window._rxStill = keep; VOLife.isOn = keepOn; }
        return out;
      });
      assert.deepEqual(r.still, [0, true]);
      assert.deepEqual([r.first, r.again, r.same], [true, false, true]);
    });

    await check('signature moves and waves: in profile no arm crosses the face (eyes, nose, mouth stay clear; the salute is a hand at the brow)', async () => {
      const r = await page.evaluate(() => {
        const out = [], A0 = window._drawSigArms, H0 = window._drawSigAfterHead;
        const shot = (v, id, p, bare) => {
          const c = __mv.canvas(80, 100), a = __mv.agent({}, { _forceView: v, faceDir: v === 'left' ? -1 : 1 }), m = _sigMoveSpec(id);
          if (m) a._sigMove = { id, at: performance.now() - p * m.ms, ms: m.ms, still: false, until: Infinity };
          else a._react = { kind: id === 'bigwave' ? 'wave' : 'click', at: performance.now() - p * 1000, n: 1, wk: 'wave' }; // a wave seen in profile
          if (bare) { window._drawSigArms = () => false; window._drawSigAfterHead = () => {}; }
          try { __mv.withCtx(c.getContext('2d'), () => a.draw()); } finally { window._drawSigArms = A0; window._drawSigAfterHead = H0; }
          return c;
        };
        SIGNATURE_MOVES.filter(m => m.id !== 'salute').concat([{ id: 'wave' }, { id: 'bigwave' }]).forEach(m => ['left', 'right'].forEach(v => [0.2, 0.3, 0.55].forEach(p => {
          const d = v === 'left' ? -1 : 1, x0 = d > 0 ? 40 + 3 : 40 - 10, n = __mv.diff(shot(v, m.id, p, false), shot(v, m.id, p, true), x0, 80 - 31, 8, 10);
          if (n > 2) out.push(m.id + ' ' + v + ' p' + p + ': ' + n + ' px of the face covered');
        })));
        return out;
      });
      assert.deepEqual(r, [], r.join(', '));
    });

//@@MORE@@

    await check('no page errors', async () => { assert.deepEqual(errors, []); });
  } finally {
    await browser.close();
  }
}
console.log(failures ? `FAIL test_v12_moves (${failures})` : 'PASS test_v12_moves');
process.exit(failures ? 1 : 0);
