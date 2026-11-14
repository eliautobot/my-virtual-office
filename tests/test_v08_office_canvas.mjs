// Canvas regression test for the office (v0.8, U10).
//
// Drives headless Chrome through playwright-core against the app files in
// this tree. Every request is answered by the test itself (static files from
// app/, fixed API fixtures), so no server is needed and nothing is saved.
//
// Checks:
//   1. the whole office is visible at 1600x900 and 1280x720 (fit camera);
//   2. the canvas bitmap equals its box x DPR (capped at 2) after a banner is
//      inserted and after a phone rotation;
//   3. no reasoning text and no internal markers are ever drawn;
//   4. one tap on a phone is exactly one click and opens the agent menu (a
//      bottom sheet with 44 px rows); on desktop the menu card sits inside the
//      office view clear of the map controls, keyboard works, locks say why;
//   5. entering and leaving edit mode throws no page errors.
//
// Run: node tests/test_v08_office_canvas.mjs
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
  console.log(`SKIP test_v08_office_canvas: ${reason}`);
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
const SECRET = 'SECRET-REASONING-7731';
const now = Date.now();

const FIXTURES = {
  '/api/license': { demo: false, valid: true, limits: {} },
  '/vo-config': { version: '0.8.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
  '/api/agents': { agents: [
    { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true },
    { id: 'beta', statusKey: 'beta', name: 'Beta', emoji: '🦊', role: 'Tester', providerKind: 'hermes', available: true },
    { id: 'gamma', statusKey: 'gamma', name: 'Gamma', emoji: '🐙', role: 'Tester', providerKind: 'opencode', available: true },
  ] },
  '/status': {
    alpha: { state: 'idle', task: '' },
    beta: { state: 'working', task: 'Running tests', activeToolCount: 1 },
    gamma: { state: 'idle', task: '' },
  },
  '/agent-chat': {
    alpha: [
      { role: 'user', from: 'You', text: 'Please check the build', epochMs: now - 60000, sessionTitle: 'Codex thread 5adfdd32' },
      { role: 'assistant', from: 'Alpha', text: 'The build is green.', thinking: `${SECRET} private chain of thought`, epochMs: now - 50000, sessionTitle: 'Codex thread 5adfdd32' },
    ],
    beta: [
      { role: 'user', from: 'You', text: 'Run the tests', epochMs: now - 40000 },
      { role: 'assistant', from: 'Beta', text: '', thinking: `${SECRET} still thinking`, tools: [{ name: 'exec', status: 'running', arguments: { command: 'npm test' } }], epochMs: now - 30000 },
    ],
  },
  '/api/office-config': {
    canvasWidth: 1040, canvasHeight: 740,
    walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' },
      sections: [{ x: 0, w: 1040, color: '#37474f', accentColor: '#263238' }],
      interior: [{ x1: 13, y1: 3, x2: 13, y2: 10 }, { x1: 17, y1: 15, x2: 24, y2: 15 }] },
    floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
    furniture: [
      { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' },
      { id: 'd2', type: 'desk', x: 320, y: 220, assignedTo: 'Beta' },
      { id: 'd3', type: 'desk', x: 160, y: 380, assignedTo: 'Gamma' },
      { id: 'c1', type: 'couch', x: 620, y: 560 },
      { id: 'p1', type: 'plant', x: 900, y: 140 },
      { id: 'm1', type: 'meetingTable', x: 640, y: 260 },
      { id: 'b1', type: 'bookshelf', x: 880, y: 420 },
      { id: 'v1', type: 'vendingMachine', x: 800, y: 520 },  // v0.10.1: its front clear of couch c1's footprint (was x 720)
      { id: 'l1', type: 'textLabel', x: 200, y: 40, text: 'TEAM', labelColor: '#ffffff', fontSize: 12 },
    ],
    branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
    agents: [],
    pet: { enabled: false },
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
const results = [];
function pass(name) { results.push(name); console.log(`[PASS] ${name}`); }

async function openOffice({ width, height, mobile = false }) {
  const options = { viewport: { width, height } };
  if (mobile) Object.assign(options, { deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  const context = await browser.newContext(options);
  await context.route('**/*', route);
  // Record every string drawn on any canvas, from the very first frame.
  await context.addInitScript(() => {
    window.__drawnText = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text) {
      if (window.__drawnText.length < 50000) window.__drawnText.push(String(text));
      return original.apply(this, arguments);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length === 3 && window.VOOffice, null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  return { context, page, errors };
}

function canvasState(page) {
  return page.evaluate(() => {
    const c = document.getElementById('officeCanvas');
    const r = c.getBoundingClientRect();
    // v0.10 Q-03: with Sharp pixels (default) the backing follows the device ratio up to 4 (was capped at 2).
    const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
    const tl = _worldToCanvas(0, 0);
    const br = _worldToCanvas(W, H);
    return { boxW: r.width, boxH: r.height, bitmapW: c.width, bitmapH: c.height, dpr,
      displayW, displayH, world: [tl.x, tl.y, br.x, br.y] };
  });
}

function assertBitmapMatchesBox(state, label) {
  assert.ok(Math.abs(state.bitmapW - state.boxW * state.dpr) <= 1.01, `${label}: bitmap width ${state.bitmapW} != ${state.boxW} x ${state.dpr}`);
  assert.ok(Math.abs(state.bitmapH - state.boxH * state.dpr) <= 1.01, `${label}: bitmap height ${state.bitmapH} != ${state.boxH} x ${state.dpr}`);
}

function assertWholeOfficeVisible(state, label) {
  const [x0, y0, x1, y1] = state.world;
  assert.ok(x0 >= -1 && y0 >= -1, `${label}: office top-left is cut off (${x0.toFixed(1)}, ${y0.toFixed(1)})`);
  assert.ok(x1 <= state.displayW + 1 && y1 <= state.displayH + 1, `${label}: office bottom-right is cut off (${x1.toFixed(1)}, ${y1.toFixed(1)}) in ${state.displayW}x${state.displayH}`);
}

// Per axis: an office larger than the view covers it, a smaller one is centred.
function assertOfficeStaysInside(state, label) {
  const [x0, y0, x1, y1] = state.world;
  for (const [a0, a1, d, axis] of [[x0, x1, state.displayW, 'x'], [y0, y1, state.displayH, 'y']]) {
    if (a1 - a0 >= d - 1) assert.ok(a0 <= 1 && a1 >= d - 1, `${label}: canvas shows outside the office on ${axis} (${a0.toFixed(1)}..${a1.toFixed(1)} in ${d})`);
    else assert.ok(Math.abs((a0 + a1) / 2 - d / 2) < 1.5, `${label}: office smaller than the view on ${axis} but not centred`);
  }
}

// When the view is smaller than the office it must show only the office.
function assertOfficeFillsCanvas(state, label) {
  const [x0, y0, x1, y1] = state.world;
  assert.ok(x0 <= 1 && y0 <= 1 && x1 >= state.displayW - 1 && y1 >= state.displayH - 1,
    `${label}: canvas shows outside the office (office at ${x0.toFixed(1)},${y0.toFixed(1)} .. ${x1.toFixed(1)},${y1.toFixed(1)} in ${state.displayW}x${state.displayH})`);
}

try {
  // 1 + 2 (banner) + 3 + 5 on desktop
  {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900 });
    let state = await canvasState(page);
    assertWholeOfficeVisible(state, '1600x900');
    assertBitmapMatchesBox(state, '1600x900');
    pass('whole office visible at 1600x900, bitmap = box x DPR');

    // A banner pushed in above the canvas must not squash the office.
    await page.evaluate(() => {
      const banner = document.createElement('div');
      banner.style.cssText = 'height:48px;background:#f80;flex:none';
      banner.textContent = 'test banner';
      const wrapper = document.getElementById('officeCanvas').parentElement;
      wrapper.parentElement.insertBefore(banner, wrapper);
    });
    await page.waitForTimeout(400);
    state = await canvasState(page);
    assertBitmapMatchesBox(state, 'after banner');
    assertWholeOfficeVisible(state, 'after banner');
    pass('bitmap = box x DPR after a banner is inserted');

    // Expand every chat bubble and let the typewriter finish.
    await page.waitForFunction(() => Object.keys(agentChatData).length >= 2, null, { timeout: 10000 });
    await page.evaluate(() => window.VOOffice.toggleBubbles(true));
    await page.waitForTimeout(2500);
    const drawn = await page.evaluate(() => window.__drawnText.join('\n'));
    assert.ok(drawn.includes('The build is green.'), 'chat bubble text was not drawn at all');
    for (const forbidden of [SECRET, '[thinking]', '[activity]', '[session:', '[image]', '5adfdd32']) {
      assert.ok(!drawn.includes(forbidden), `canvas drew forbidden text: ${forbidden}`);
    }
    pass('no reasoning text or internal markers drawn on the canvas');

    // CV-25: tall furniture is y-sorted with the characters. The pixel at the
    // head/torso of an agent standing behind a tall piece is the piece; in front
    // it is the agent. Behind a horizontal wall the same holds (the machine v1
    // and the agent are both behind the wall at y = 600). The static layer
    // stays cached while this happens.
    const sample = (id, agentDy, atDys) => page.evaluate(({ id, agentDy, atDys }) => {
      const gamma = agents.find(a => a.name === 'Gamma');
      agents.forEach(a => { if (a !== gamma) { a.x = 60; a.y = 700; } });
      const item = officeConfig.furniture.find(i => i.id === id);
      const sortY = _tallFurnitureSortY(item);
      const r = _furnitureRect(item);
      const px = r.x + r.w / 2;
      if (agentDy === null) { gamma.x = 40; gamma.y = 700; } else { gamma.x = px; gamma.y = sortY + agentDy; }
      agents.forEach(a => { a.targetX = a.x; a.targetY = a.y; a.path = []; });
      // Standing pose (a seated or sleeping body is drawn lower and would miss the sample points).
      gamma.isSitting = false; gamma.state = 'idle';
      const builds = window.__voStats.staticBuilds;
      _sceneDirty = true; _lastDrawAt = 0;
      // Render only: a simulation tick inside this frame (timing dependent) would
      // apply the world rules to Gamma (feet 10 px behind the bookshelf's base line
      // are inside its footprint, the spot in front of v1 is inside couch c1's)
      // and move it before the pixels are read (v0.10.1 clearance: the flaky
      // bookshelf / vending failures since W2).
      const run = window._runSimulation;
      window._runSimulation = function () { return 0; };
      try { _renderFrame(performance.now()); } finally { window._runSimulation = run; }
      const c2d = document.getElementById('officeCanvas').getContext('2d');
      const rgb = atDys.map(dy => {
        const p = _worldToCanvas(px, sortY + dy);
        const d = c2d.getImageData(Math.round(p.x * DPR), Math.round(p.y * DPR), 1, 1).data;
        return [d[0], d[1], d[2]];
      });
      return { pos: [Math.round(gamma.x), Math.round(gamma.y), Math.round(sortY), gamma.state, !!gamma.isSitting], rgb, rebuilt: window.__voStats.staticBuilds - builds,
        gammaBehindWall: _isAgentBehindHorizontalWall(gamma),
        itemBehindWall: _isFurnitureNearHorizontalWall(item) && !_isFurnitureInFrontOfWall(item) };
    }, { id, agentDy, atDys });
    const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const column = (feet, from, to) => { const out = []; for (let d = from; d <= to; d += 2) out.push(feet + d); return out; };
    for (const [id, behindDy, frontDy, label] of [['b1', -18, 4, 'bookshelf'], ['v1', -14, 2, 'vending machine behind a wall']]) {
      // Agent behind: every point of its torso shows the furniture.
      const behindPts = column(behindDy, -30, -20);
      const shelf = await sample(id, null, behindPts);
      const behind = await sample(id, behindDy, behindPts);
      behind.rgb.forEach((rgb, i) => assert.ok(near(rgb, shelf.rgb[i], 10), `${label}: agent behind it is drawn over it (${rgb} vs ${shelf.rgb[i]} at ${behind.pos})`));
      // Agent in front: its head covers the furniture.
      const frontPts = column(frontDy, -40, -26);
      const shelf2 = await sample(id, null, frontPts);
      const front = await sample(id, frontDy, frontPts);
      assert.ok(front.rgb.some((rgb, i) => !near(rgb, shelf2.rgb[i], 10)), `${label}: agent in front of it is hidden (at ${front.pos})`);
      assert.equal(behind.rebuilt + front.rebuilt, 0, `${label}: static layer rebuilt while an agent moved`);
      if (id === 'v1') assert.ok(behind.itemBehindWall && behind.gammaBehindWall && front.gammaBehindWall, 'fixture: machine and agent should both be behind the wall');
    }
    pass('tall furniture is y-sorted with agents (behind hidden, in front visible, walls respected, static layer cached)');

    // Edit mode in and out (license flag flipped locally; every write is stubbed).
    const before = errors.length;
    await page.evaluate(() => { window._voLicense = { demo: false }; toggleEditMode(); });
    await page.waitForTimeout(300);
    const box = await page.locator('#officeCanvas').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { if (editMode) toggleEditMode(); });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => editMode), false, 'still in edit mode');
    assert.deepEqual(errors.slice(before), [], 'page errors while entering/leaving edit mode');
    pass('no page errors entering and leaving edit mode');
    await context.close();
  }

  // 1 at 1280x720
  {
    const { context, page } = await openOffice({ width: 1280, height: 720 });
    const state = await canvasState(page);
    assertWholeOfficeVisible(state, '1280x720');
    assertBitmapMatchesBox(state, '1280x720');
    pass('whole office visible at 1280x720, bitmap = box x DPR');
    await context.close();
  }

  // 4 + 2 (rotation) on a phone
  {
    const { context, page } = await openOffice({ width: 412, height: 915, mobile: true });
    await page.evaluate(() => {
      window.__clicks = 0;
      const original = window.handleCanvasClick;
      window.handleCanvasClick = function() { window.__clicks++; return original.apply(this, arguments); };
    });
    const target = await page.evaluate(() => {
      const agent = agents.find(a => a.name === 'Alpha');
      agents.forEach(a => { a.targetX = a.x; a.targetY = a.y; });
      // the centre of the drawn body (a seated agent sits on the chair in front of its desk, v0.10.1)
      const r = agent.characterRect || { x: agent.x - 15, y: agent.y - 40, w: 30, h: 48 };
      const p = _worldToScreen(r.x + r.w / 2, r.y + r.h / 2);
      return { x: p.x, y: p.y };
    });
    await page.touchscreen.tap(target.x, target.y);
    await page.waitForTimeout(400);
    const tap = await page.evaluate(() => ({ clicks: window.__clicks, open: agents.filter(a => a.actionMenuOpen).map(a => a.name) }));
    assert.equal(tap.clicks, 1, `one tap produced ${tap.clicks} clicks`);
    assert.deepEqual(tap.open, ['Alpha'], 'tapping the character did not open its menu');
    const sheet = await page.evaluate(() => {
      const el = document.getElementById('vo-agent-menu');
      const r = el.getBoundingClientRect();
      const items = [...el.querySelectorAll('[role="menuitem"]')];
      const close = el.querySelector('.vo-agent-menu-close').getBoundingClientRect();
      return { hidden: el.hidden, sheet: el.classList.contains('is-sheet'), left: r.left, right: r.right, bottom: r.bottom, top: r.top,
        name: el.querySelector('.vo-agent-menu-name').textContent, actions: items.map(i => i.dataset.action),
        minRow: Math.min(...items.map(i => i.getBoundingClientRect().height)), close: Math.min(close.width, close.height), vw: innerWidth, vh: innerHeight };
    });
    assert.equal(sheet.hidden, false, 'the agent menu is not shown');
    assert.equal(sheet.sheet, true, 'a phone in portrait does not get the bottom sheet');
    assert.ok(sheet.left <= 0.5 && Math.abs(sheet.right - sheet.vw) <= 0.5 && Math.abs(sheet.bottom - sheet.vh) <= 0.5, `sheet not at the bottom edge: ${JSON.stringify(sheet)}`);
    assert.ok(sheet.top > sheet.vh * 0.25, `sheet covers too much of the screen (top ${sheet.top})`);
    assert.equal(sheet.name, 'Alpha');
    assert.deepEqual(sheet.actions.slice(0, 4), ['chat', 'pc', 'speech', 'settings'], 'primary actions');
    assert.ok(sheet.minRow >= 44 && sheet.close >= 44, `phone targets under 44 px: row ${sheet.minRow}, close ${sheet.close}`);
    pass('one tap = one click, and tapping a character opens its menu as a bottom sheet with 44 px rows');

    let state = await canvasState(page);
    assertBitmapMatchesBox(state, 'phone portrait');
    await context.close();
  }

  // Phone camera: the start view fills the canvas with the room (no empty band
  // outside the office) and is framed on the agents; panning never leaves the
  // office; Fit centres it.
  for (const [width, height] of [[412, 915], [375, 667], [915, 412]]) {
    const { context, page } = await openOffice({ width, height, mobile: true });
    const label = `${width}x${height}`;
    let state = await canvasState(page);
    // Start view: every agent fully in view with a margin (P3-2); the room fills
    // the canvas unless the agents need a band, which stays under 30 %.
    assertOfficeStaysInside(state, `${label} start view`);
    const sv = await page.evaluate(() => {
      const m = agents.map(a => { const p = _worldToCanvas(a.x - 24, a.y - 90), q = _worldToCanvas(a.x + 24, a.y + 8);
        return Math.min(p.x, displayW - q.x, p.y, displayH - q.y); });
      const t = getBaseScale() * camera.zoom;
      return { n: agents.length, margin: Math.min(...m), band: Math.max(0, 1 - W * t / displayW, 1 - H * t / displayH) };
    });
    assert.ok(sv.n >= 1 && sv.margin >= 30, `${label}: an agent is cut or touches the edge in the start view (margin ${sv.margin.toFixed(1)} px)`);
    assert.ok(sv.band <= 0.3, `${label}: start view leaves a ${(sv.band * 100).toFixed(0)} % band outside the office`);
    for (const [dx, dy] of [[-5000, -5000], [5000, 5000]]) {
      await page.evaluate(([x, y]) => _panByScreen(x, y, false), [dx, dy]);
      await page.waitForTimeout(80);
      assertOfficeStaysInside(await canvasState(page), `${label} after pan ${dx},${dy}`);
    }
    await page.evaluate(() => { _camAnim = null; _applyCameraView({ x: 0, y: 0, zoom: 1 }, false); });
    await page.waitForTimeout(80);
    state = await canvasState(page);
    const [x0, y0, x1, y1] = state.world;
    assertWholeOfficeVisible(state, `${label} fit`);
    assert.ok(Math.abs((x0 + x1) / 2 - state.displayW / 2) < 1.5 && Math.abs((y0 + y1) / 2 - state.displayH / 2) < 1.5,
      `${label}: fit view is not centred`);
    await context.close();
  }
  pass('phone camera: start view frames every agent with a margin (room fills the canvas, or a band under 30 %), pans stay inside, fit is centred');

  // Mini-map: off by default, M toggles it (not while typing), hidden while the whole office
  // fits, drawn inside the canvas clear of the top bar and the map controls, a tap jumps there.
  for (const [width, height, mobile] of [[1600, 900, false], [412, 915, true]]) {
    const { context, page, errors } = await openOffice({ width, height, mobile });
    const label = `${width}x${height}`;
    const api = await page.evaluate(() => {
      window.__mmEvents = [];
      window.addEventListener('vo:minimap-change', e => window.__mmEvents.push(e.detail && e.detail.visible));
      return { toggle: typeof VOOffice.toggleMiniMap, visible: typeof VOOffice.miniMapVisible, on: VOOffice.miniMapVisible() };
    });
    assert.deepEqual(api, { toggle: 'function', visible: 'function', on: false }, `${label}: mini-map API / default`);
    await page.evaluate(() => { _camAnim = null; _applyCameraView({ x: 0, y: 0, zoom: 1 }, false); document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    await page.keyboard.press('m');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => VOOffice.miniMapVisible()), true, `${label}: M did not turn the mini-map on`);
    assert.equal(await page.evaluate(() => _miniMapRect), null, `${label}: mini-map drawn while the whole office fits`);
    await page.evaluate(() => { _camAnim = null; _applyCameraView({ x: -W / 2, y: -H / 2, zoom: 3 }, false); });
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => ({ cx: W / 2 + camera.x, cy: H / 2 + camera.y }));
    const geo = await page.evaluate(() => {
      const c = document.getElementById('officeCanvas').getBoundingClientRect();
      const L = _miniMapRect;
      const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? [r.left, r.top, r.right, r.bottom] : null; };
      return { canvas: [c.left, c.top, c.right, c.bottom], displayW, displayH,
        map: L && [c.left + L.x - 4, c.top + L.y - 4, c.left + L.x + L.w + 4, c.top + L.y + L.h + 4],
        topbar: rect(document.querySelector('.vo-topbar')), mapctl: rect(document.querySelector('.vo-mapctl')) };
    });
    assert.ok(geo.map, `${label}: mini-map not drawn when zoomed in`);
    const [mx0, my0, mx1, my1] = geo.map;
    assert.ok(mx0 >= geo.canvas[0] && my0 >= geo.canvas[1] && mx1 <= geo.canvas[2] && my1 <= geo.canvas[3], `${label}: mini-map outside the canvas`);
    for (const [name, r] of [['top bar', geo.topbar], ['map controls', geo.mapctl]]) {
      if (!r) continue;
      const overlap = mx0 < r[2] && mx1 > r[0] && my0 < r[3] && my1 > r[1];
      assert.ok(!overlap, `${label}: mini-map ${geo.map.map(Math.round)} covers the ${name} ${r.map(Math.round)}`);
    }
    // A tap/click on the mini-map's bottom-right corner moves the view there.
    const target = { x: mx1 - 8, y: my1 - 8 };
    if (mobile) await page.touchscreen.tap(target.x, target.y); else await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({ cx: W / 2 + camera.x, cy: H / 2 + camera.y, W }));
    assert.ok(after.cx > before.cx + after.W * 0.2 && after.cy >= before.cy - 1,
      `${label}: mini-map tap did not move the view (centre ${Math.round(before.cx)},${Math.round(before.cy)} -> ${Math.round(after.cx)},${Math.round(after.cy)})`);
    // Typing in a field must not toggle it; M again turns it off.
    await page.evaluate(() => { const i = document.createElement('input'); i.id = '__mmInput'; document.body.appendChild(i); i.focus(); });
    await page.keyboard.press('m');
    assert.equal(await page.evaluate(() => VOOffice.miniMapVisible()), true, `${label}: M while typing toggled the mini-map`);
    await page.evaluate(() => { document.getElementById('__mmInput').remove(); document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
    await page.keyboard.press('M');
    await page.waitForTimeout(150);
    const off = await page.evaluate(() => ({ on: VOOffice.miniMapVisible(), rect: _miniMapRect, events: window.__mmEvents }));
    assert.deepEqual(off, { on: false, rect: null, events: [true, false] }, `${label}: M did not turn the mini-map off`);
    assert.deepEqual(errors, [], `${label}: page errors with the mini-map`);
    await context.close();
  }
  pass('mini-map: off by default, M toggles (not while typing), clear of top bar and map controls, tap jumps');

  // Chips and chat bubbles step out from under the map controls; a floor lamp glows at night only.
  {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900 });
    const res = await page.evaluate(() => {
      const c = canvas.getBoundingClientRect();
      const q = document.querySelector('.vo-mapctl').getBoundingClientRect();
      const ctl = { x: q.left - c.left, y: q.top - c.top, w: q.width, h: q.height };
      const alpha = agents.find(a => a.name === 'Alpha'), beta = agents.find(a => a.name === 'Beta');
      chatMinimized.alpha = false; chatMinimized.beta = true;
      const at = (a, cx, cy) => { const p = screenToWorld(c.left + cx, c.top + cy); a.x = a.targetX = Math.min(W - 12, p.x); a.y = a.targetY = Math.min(H - 12, p.y); a.path = []; };
      at(beta, ctl.x - 6, ctl.y + 110);     // chip would sit on the controls' left edge
      at(alpha, ctl.x - 20, ctl.y + ctl.h - 10);
      _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      const hit = r => r && r.x < ctl.x + ctl.w && r.x + r.w > ctl.x && r.y < ctl.y + ctl.h && r.y + r.h > ctl.y;
      const bubble = renderedChatBubbles.find(b => b.agentKey === 'alpha');
      return { ctl, chip: beta._chipRect, bubble: bubble && bubble.fullRect,
        chipHit: hit(beta._chipRect), bubbleHit: hit(bubble && bubble.fullRect) };
    });
    assert.ok(res.chip, 'fixture: Beta has no activity chip');
    assert.ok(res.bubble, 'fixture: Alpha has no expanded bubble');
    assert.ok(!res.chipHit, `activity chip ${JSON.stringify(res.chip)} under the map controls ${JSON.stringify(res.ctl)}`);
    assert.ok(!res.bubbleHit, `chat bubble ${JSON.stringify(res.bubble)} under the map controls ${JSON.stringify(res.ctl)}`);

    const lampPixel = hour => page.evaluate(h => {
      agents.forEach(a => { a.x = a.targetX = 60; a.y = a.targetY = 700; a.path = []; });
      chatMinimized.alpha = true;
      const sample = withLamp => {
        officeConfig.furniture = officeConfig.furniture.filter(i => i.id !== 'tLamp');
        if (withLamp) officeConfig.furniture.push({ id: 'tLamp', type: 'floorLamp', x: 520, y: 420 });
        _staticSigCheckedAt = 0; _staticLayerForce = true;
        _timeOverride = h; _updateAmbientCache();
        _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
        const p = _worldToCanvas(520 + 24, 420 + 6);
        const d = document.getElementById('officeCanvas').getContext('2d').getImageData(Math.round(p.x * DPR), Math.round(p.y * DPR), 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      return { lamp: sample(true), none: sample(false) };
    }, hour);
    const night = await lampPixel(23), day = await lampPixel(12.5);
    assert.ok(night.lamp[0] - night.none[0] >= 8, `no lamp glow at night (${night.lamp} vs ${night.none})`);
    assert.ok(Math.abs(day.lamp[0] - day.none[0]) <= 2, `lamp glows in daylight (${day.lamp} vs ${day.none})`);
    assert.deepEqual(errors, [], 'page errors in the chrome/lights check');
    await context.close();
  }
  pass('chips and bubbles stay clear of the map controls; floor lamps glow at night, not by day');

  // Controls over each character (activity chip, 💬): one fixed on-screen size at every zoom,
  // laid out around the name tag, clear of the neighbours, hit boxes >= 32 px (mouse) / 44 px (touch).
  // v0.13: no ••• above the tag; the menu control (ctl.launcher) is the name tag (plus the strip above it up to
  // the controls' row, so chips and Office life marks above it clear the 💬 and mood badge beside the tag).
  for (const mobile of [false, true]) {
    const label = mobile ? 'phone 412x915' : 'desktop 1600x900';
    const { context, page, errors } = await openOffice(mobile ? { width: 412, height: 915, mobile: true } : { width: 1600, height: 900 });
    const frames = await page.evaluate(() => {
      const out = [];
      ['alpha', 'beta', 'gamma'].forEach(k => { chatMinimized[k] = true; });
      for (const z of [null, 2.2, 0.5]) {
        if (z === null) VOOffice.fitView(); else { camera.zoom = z; camera.x = 0; camera.y = 0; clampCamera(); }
        _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now()); // the camera settles (phones pan inside)
        // Three agents a desk apart (100 world px) around the middle of the view, all busy.
        agents.forEach((a, i) => { a.x = a.targetX = W / 2 + camera.x + (i - 1) * 100; a.y = a.targetY = H / 2 + camera.y; a.path = []; a.state = 'working'; a.activeToolCount = 1; a.isSitting = false; });
        _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
        out.push({ total: getBaseScale() * camera.zoom, ctl: agents.map(a => a._ctl && { L: a._ctl.launcher, C: a._ctl.chip, B: a._ctl.bubbleShown ? a._ctl.bubble : null, T: a._ctl.tag }) });
      }
      VOOffice.fitView(); _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      return out;
    });
    const H = mobile ? 24 : 22;
    const ov = (a, b) => a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    frames.forEach((f, zi) => {
      const shown = f.ctl.filter(Boolean);
      assert.equal(shown.length, 3, `${label} zoom ${f.total.toFixed(2)}: not every agent has its controls`);
      shown.forEach(c => {
        assert.ok(c.L.x === c.T.x && c.L.w === c.T.w && Math.abs(c.L.y + c.L.h - c.T.y - c.T.h) < 0.01 && c.L.y <= c.T.y && c.L.h <= Math.max(c.T.h, H) + 0.01, `${label}: the menu control is not the name tag (a ••• above it?)`);
        assert.ok(c.C && c.C.h === H, `${label}: activity chip height ${c.C && c.C.h}, not ${H}`);
        if (c.B) assert.ok(c.B.w === H && c.B.h === H, `${label}: 💬 is ${c.B.w}x${c.B.h}, not ${H}`);
        assert.ok(c.C.y + c.C.h <= c.T.y - 2, `${label}: chip not above the name tag`);
      });
      if (zi === 0) {
        shown.filter(c => c.B).forEach(c => assert.ok(Math.abs(c.B.x - (c.T.x + c.T.w + 3)) <= 1, `${label}: 💬 not 3 px right of the name tag at fit`));
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) {
          const a = shown[i], b = shown[j];
          for (const x of [a.L, a.C, a.B]) for (const y of [b.L, b.C, b.B, b.T]) assert.ok(!ov(x, y), `${label}: agent ${i} controls overlap agent ${j} at fit view`);
        }
      }
    });
    // Hit targets (v0.13: on the name tag, where the ••• had them): a click 14 px (mouse) / a tap 19 px
    // (touch) from the tag's middle, above or below its 13 px, still opens the menu (32 / 44 px boxes).
    // Neighbours 250 world px away so this checks the target size, not crowding; thinking (no tools), so no chip above.
    await page.evaluate(() => agents.forEach((a, i) => { a.x = a.targetX = agents[1].x + (i - 1) * 250; a.targetY = a.y; a.path = []; a.activeToolCount = 0; }));
    await page.waitForTimeout(900); // the camera eases into the fit view
    const near = await page.evaluate(d => {
      const cr = canvas.getBoundingClientRect(), a = agents[1], L = a._ctl.launcher;
      const withB = agents.find(x => x._ctl && x._ctl.bubbleShown);
      const B = withB && withB._ctl.bubble;
      // Off the tag (above or below it, middle or near an end) where nothing else (a chip, a desk monitor, a
      // body) is drawn.
      const spot = ([fx, dy]) => ({ x: L.x + 4 + fx * (L.w - 8), y: L.y + L.h / 2 + dy });
      const free = o => { const { x, y } = spot(o), w = screenToWorld(cr.left + x, cr.top + y);
        const grown = _agentControlAtCanvas(x, y, d > 15 ? 44 : 32);
        return !_agentControlAtCanvas(x, y, 0) && !_agentAtWorld(w.x, w.y, 0) && !_getAgentPreviewScreenHit(w.x, w.y) && grown && grown.agent === a && grown.tag; };
      const o = [[0.5, -d], [0.5, d], [0, -d], [1, -d], [0, d], [1, d]].find(free), p = spot(o || [0.5, -d]);
      return { x: cr.left + p.x, y: cr.top + p.y, name: a.name, free: o !== undefined, tagIsMenu: L.x === a._ctl.tag.x && L.w === a._ctl.tag.w && L.y <= a._ctl.tag.y,
        b: B && { x: cr.left + B.x + B.w / 2, y: cr.top + B.y + B.h / 2 + (d > 15 ? 20 : 15), key: withB.statusKey } };
    }, mobile ? 19 : 14);
    assert.ok(near.tagIsMenu, `${label}: the menu control is not the name tag`);
    assert.ok(near.free, `${label}: fixture: above and below the name tag are covered by other targets`);
    if (mobile) await page.touchscreen.tap(near.x, near.y); else await page.mouse.click(near.x, near.y);
    await page.waitForTimeout(250);
    const opened = await page.evaluate(() => agents.filter(a => a.actionMenuOpen).map(a => a.name));
    assert.deepEqual(opened, [near.name], `${label}: a ${mobile ? 'tap 19' : 'click 14'} px off the name tag did not open its menu`);
    await page.evaluate(() => _closeAgentMenu());
    if (near.b) {
      await page.waitForTimeout(150);
      if (mobile) await page.touchscreen.tap(near.b.x, near.b.y); else await page.mouse.click(near.b.x, near.b.y);
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(k => chatMinimized[k], near.b.key), false, `${label}: a press just under the 💬 did not show the bubble`);
    }
    assert.deepEqual(errors, [], `${label}: page errors with the agent controls`);
    await context.close();
  }
  pass('controls over each character: one fixed size at every zoom, set around the name tag, clear of neighbours, 32/44 px hit targets');

  // Right column (like MVW's floating buttons; review 2026-11-05: bottom right): the map controls sit
  // fixed at the office's bottom right, 16 px in from its corner, with the chat window buttons stacked
  // right on them (short screens: beside them on the same baseline). Chat windows stay left of both.
  // Opening, resizing and putting windows away never moves or restyles the map controls; the column
  // follows them frame by frame while the dashboard slides, edit mode lifts it above the edit toolbar
  // and a dragged window stops at the column and the dock.
  for (const size of [{ width: 1600, height: 900 }, { width: 1366, height: 768 }, { width: 1600, height: 500 }, { width: 412, height: 915, mobile: true }, { width: 915, height: 412, mobile: true }]) {
    const label = `${size.width}x${size.height}`;
    const { context, page, errors } = await openOffice(size);
    const res = await page.evaluate(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const box = e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      const vis = e => { if (!e) return false; const cs = getComputedStyle(e), r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 && r.top < innerHeight - 4; };
      const ov = (a, b) => a && b ? Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) : 0;
      const map = document.querySelector('.vo-mapctl');
      let muts = 0;
      new MutationObserver(list => { muts += list.length; }).observe(map, { attributes: true, attributeFilter: ['style', 'class'] });
      const state = window.__colState = label => {
        const m = getComputedStyle(map).visibility === 'hidden' ? { x: 0, y: 0, w: 0, h: 0 } : box(map), rail = document.getElementById('chat-window-rail');
        const strip = !!(rail && rail.classList.contains('is-strip'));
        const btns = [...document.querySelectorAll('#chat-window-rail [data-chat-win]')].filter(vis).map(box);
        const wins = [...document.querySelectorAll('.chat-panel.open')].filter(vis).map(box);
        const launch = [...document.querySelectorAll('[data-vo-chat-launch]')].filter(vis).map(box)[0];
        const chrome = [...document.querySelectorAll('.toolbar.vo-dock, .sidebar.vo-sidebar, .ui-edit-toolbar')].filter(vis).map(box);
        let over = 0;
        btns.forEach(b => { over += ov(b, m); if (launch && !strip) over += ov(b, launch); });
        if (!strip) wins.forEach(w => { over += ov(w, m); btns.forEach(b => { over += ov(w, b); }); if (launch) over += ov(w, launch); });
        if (innerWidth > 900) chrome.forEach(c => { over += ov(c, m); if (!strip) btns.forEach(b => { over += ov(c, b); }); });
        // Desktop: where the column stands (the office's bottom right, the window buttons on the controls).
        let place = 'phone';
        if (innerWidth > 900 && m.w) {
          const wr = box(document.querySelector('.game-wrapper'));
          const gapB = Math.round(wr.y + wr.h - (m.y + m.h)), gapR = Math.round(wr.x + wr.w - (m.x + m.w));
          const top = btns.length ? Math.max(...btns.map(b => b.y + b.h)) : null, right = btns.length ? Math.max(...btns.map(b => b.x + b.w)) : null;
          const centred = btns.every(b => Math.abs(b.x + b.w / 2 - (m.x + m.w / 2)) <= 2);
          const stack = !btns.length ? 'none' : innerHeight <= 500
            ? (right <= m.x - 6 && Math.abs(top - (m.y + m.h)) <= 2 ? 'beside' : 'bad')
            : (top <= m.y - 6 && centred ? 'on' : 'bad');
          place = `bottom ${gapB} right ${gapR} buttons ${stack}`;
        }
        return { label, map: [m.x, m.y, m.w, m.h].map(Math.round).join(','), btns: btns.length, wins: wins.length, over: Math.round(over), place, transform: getComputedStyle(map).transform };
      };
      const api = window.VirtualOfficeChat;
      const states = [state('none')];
      api.open(); await wait(500); states.push(state('1 window'));
      api.openNewWindow(); await wait(500); states.push(state('2 windows'));
      api.openNewWindow(); await wait(400); api.openNewWindow(); await wait(600); states.push(state('4 windows'));
      muts = 0;
      const front = [...document.querySelectorAll('.chat-panel.open')].filter(vis)[0];
      if (front) for (let i = 0; i < 5; i++) { front.style.width = (420 + i * 30) + 'px'; front.style.height = (480 + i * 20) + 'px'; window.dispatchEvent(new Event('resize')); await wait(60); }
      await wait(300);
      const resizeMuts = muts;
      states.push(state('resized'));
      for (let k = 0; k < 4; k++) { document.querySelectorAll('.chat-panel.open .chat-put-away').forEach(b => { if (vis(b)) b.click(); }); await wait(200); }
      // Desktop puts a window away with its button in the column.
      if (innerWidth > 900) for (let k = 0; k < 8; k++) { const b = document.querySelector('#chat-window-rail [data-chat-win][aria-pressed="true"]'); if (!b) break; b.click(); await wait(150); }
      await wait(400);
      states.push(state('put away'));
      const extra = {};
      if (innerWidth > 900) {
        // The dashboard slides shut and open: the window buttons stay on (or beside) the controls every frame.
        api.open(); api.openNewWindow(); await wait(600);
        const rail = document.getElementById('chat-window-rail');
        const drift = () => { const a = box(rail), b = box(map); return innerHeight <= 500 ? Math.abs(a.x + a.w - (b.x - 8)) : Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)); };
        extra.drift = 0;
        for (let k = 0; k < 2; k++) {
          const t0 = performance.now();
          toggleSidebar();
          while (performance.now() - t0 < 600) { await new Promise(r => requestAnimationFrame(r)); extra.drift = Math.max(extra.drift, Math.round(drift())); }
          states.push(state(k ? 'dashboard open' : 'dashboard shut'));
        }
        // Edit mode: the column stands above the edit toolbar (state() counts any overlap with it).
        toggleEditMode(); await wait(1200);
        states.push(state('edit mode'));
        extra.editMap = box(map);
        toggleEditMode(); await wait(800);
      }
      return { states, resizeMuts, extra, phone: innerWidth <= 900 };
    });
    if (!res.phone) {
      // Drag the main window towards the column's bottom (left of the snap zone): it stops at the column and the dock.
      const h = await page.evaluate(() => {
        const hd = document.querySelector('#chat-panel .chat-header'), r = hd.getBoundingClientRect();
        for (let x = r.left + 4; x < r.right; x += 6) { const el = document.elementFromPoint(x, r.top + r.height / 2); if (el && hd.contains(el) && !el.closest('button, select, input, textarea, label, a')) return { x, y: r.top + r.height / 2 }; }
        return null;
      });
      assert.ok(h, `${label}: fixture: no free spot on the chat header to drag`);
      const to = await page.evaluate(() => {
        const m = document.querySelector('.vo-mapctl').getBoundingClientRect(), col = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vo-right-col'));
        return { x: m.right + 16 - col - 100, y: innerHeight - 20 };
      });
      await page.mouse.move(h.x, h.y); await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(h.x + (to.x - h.x) * i / 12, h.y + (to.y - h.y) * i / 12);
      await page.mouse.up(); await page.waitForTimeout(500);
      const dragged = await page.evaluate(() => ({ ...window.__colState('dragged'), floating: document.getElementById('chat-panel').classList.contains('floating'),
        dockGap: Math.round(document.querySelector('.toolbar.vo-dock').getBoundingClientRect().top - document.getElementById('chat-panel').getBoundingClientRect().bottom) }));
      assert.ok(dragged.floating, `${label}: fixture: the dragged window did not float`);
      assert.ok(dragged.dockGap >= 0, `${label}: the dragged window covers the dock (${dragged.dockGap} px)`);
      res.states.push(dragged);
    }
    const first = res.states[0];
    assert.ok(Math.max(...res.states.map(st => st.btns)) >= 2, `${label}: fixture: no chat window buttons`);
    for (const st of res.states) {
      assert.equal(st.over, 0, `${label} ${st.label}: windows, window buttons, map controls, the Chat launcher, dock, dashboard or edit toolbar overlap (${st.over} px2)`);
      // Phones: the map controls ride above the chat sheet (or step aside), so only desktop pins them.
      if (!res.phone && !/dashboard|edit/.test(st.label)) assert.equal(st.map, first.map, `${label} ${st.label}: the map controls moved (${first.map} -> ${st.map})`);
      if (!res.phone && st.label !== 'edit mode') assert.match(st.place, /^bottom 16 right 16 buttons (none|on|beside)$/, `${label} ${st.label}: the column is not at the office's bottom right (${st.place})`);
      if (!res.phone && size.height <= 500) assert.doesNotMatch(st.place, / on$/, `${label} ${st.label}: short screens put the window buttons beside the controls`);
      if (!res.phone && size.height > 500) assert.doesNotMatch(st.place, / beside$/, `${label} ${st.label}: the window buttons stand on the controls`);
      assert.equal(st.transform, 'none', `${label} ${st.label}: the map controls are shifted by a transform`);
    }
    assert.ok(res.states.find(st => st.label === 'put away').btns >= 2, `${label}: put-away windows lost their buttons`);
    if (!res.phone) {
      assert.equal(res.states.find(st => st.label === 'put away').wins, 0, `${label}: the column's buttons did not put the windows away`);
      assert.ok(res.extra.drift <= 1, `${label}: the window buttons lag behind the map controls while the dashboard slides (${res.extra.drift} px)`);
      assert.match(res.states.find(st => st.label === 'edit mode').place, /^bottom \d+ right 16 buttons (on|beside)$/, `${label}: edit mode column`);
    }
    assert.equal(res.resizeMuts, 0, `${label}: resizing a chat window restyled the map controls`);
    assert.deepEqual(errors, [], `${label}: page errors with chat windows open`);
    await context.close();
  }
  pass('right column: map controls fixed at the bottom right, chat window buttons on them (short screens: beside), windows, dock, dashboard, edit toolbar and a dragged window never cover them');

  // Phone chat sheet (review 2026-11-02, like the 8090 chat): opens half way up above the action bar,
  // the grip drags it from a small height to just under the top bar, a tap switches half / full,
  // the height is remembered on the device, the keyboard lifts it, the office above stays usable,
  // and the map controls (bottom right) ride above it or step aside. Desktop has no grip.
  for (const size of [{ width: 412, height: 915 }, { width: 375, height: 667 }, { width: 360, height: 672 }]) {
    const label = `phone sheet ${size.width}x${size.height}`;
    const { context, page, errors } = await openOffice({ ...size, mobile: true });
    const geo = () => page.evaluate(() => {
      const r = sel => { const e = document.querySelector(sel); if (!e || getComputedStyle(e).visibility === 'hidden' || !e.getClientRects().length) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, b: b.bottom }; };
      return { sheet: r('.chat-panel.open'), grip: r('.chat-panel.open .chat-sheet-grip'), head: r('.chat-panel.open .chat-header'), composer: r('.chat-panel.open .chat-input-row'), body: r('.chat-panel.open .chat-body'),
        bar: r('.vo-actionbar'), top: r('.vo-topbar'), map: r('.vo-mapctl'), launch: r('.vo-actionbar [data-vo-chat-launch]'), H: innerHeight, W: innerWidth,
        modal: !!document.querySelector('.chat-panel.open[aria-modal]'), share: localStorage.getItem('vo-chat-sheet-share') };
    });
    const drag = async (dy) => {
      const g = (await geo()).grip;
      await page.mouse.move(g.x + g.w / 2, g.y + g.h / 2); await page.mouse.down();
      await page.mouse.move(g.x + g.w / 2, g.y + g.h / 2 + dy, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(150);
      return geo();
    };
    await page.evaluate(() => document.querySelector('.vo-actionbar [data-vo-chat-launch]').click());
    await page.waitForTimeout(500);
    let g = await geo();
    assert.ok(g.sheet && g.grip, `${label}: no sheet or grip`);
    assert.ok(Math.abs(g.sheet.y - Math.min(g.H / 2, g.H - g.bar.h - 200)) <= 3, `${label}: sheet top ${g.sheet.y} not about half way (${g.H / 2})`);
    assert.ok(Math.abs(g.sheet.b - g.bar.y) <= 1 && g.sheet.w === g.W, `${label}: sheet not full width on the action bar (${JSON.stringify(g.sheet)})`);
    assert.ok(g.head.h <= 48, `${label}: chat header ${g.head.h} px tall (one compact row expected)`);
    const name = await page.evaluate(() => { const n = document.querySelector('.chat-panel.open .chat-agent-pick-name'); return n ? [n.getBoundingClientRect().width, n.scrollWidth] : null; });
    assert.ok(name && name[0] >= 20, `${label}: the agent's name is squeezed out of the header (${name})`);
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'chat-input', `${label}: the composer took focus on a touch phone (keyboard would pop up)`);
    assert.ok(g.launch.y >= g.sheet.b - 1, `${label}: the Chat launcher sits under the sheet`);
    assert.ok(!g.map || g.map.b <= g.sheet.y - 4, `${label}: map controls ${JSON.stringify(g.map)} under the sheet`);
    assert.equal(g.modal, false, `${label}: the sheet is modal`);
    const hitAbove = await page.evaluate(y => document.elementFromPoint(40, y)?.id, Math.round(g.sheet.y - 30));
    assert.equal(hitAbove, 'officeCanvas', `${label}: the office above the sheet is not reachable (${hitAbove})`);
    const half = g.sheet.h;
    g = await drag(-120);
    assert.ok(Math.abs(g.sheet.h - (half + 120)) <= 3, `${label}: drag up 120 -> height ${g.sheet.h} (was ${half})`);
    assert.ok(g.share && +g.share > 0, `${label}: height not remembered`);
    g = await drag(-2000);
    assert.ok(Math.abs(g.sheet.y - g.top.b) <= 1, `${label}: dragged to the top: sheet top ${g.sheet.y}, top bar ends ${g.top.b}`);
    assert.equal(g.map, null, `${label}: map controls still shown over a full-height sheet`);
    g = await drag(2000);
    // The small height keeps the composer inside and a few lines of messages (72 px) above it.
    assert.ok(g.sheet.h < half && g.composer.b <= g.sheet.b + 1 && Math.abs(g.body.h - 72) <= 2, `${label}: dragged down: sheet ${g.sheet.h}, messages ${g.body.h}, composer ends ${g.composer.b} (sheet ends ${g.sheet.b})`);
    assert.ok(g.map && g.map.b <= g.sheet.y - 4, `${label}: map controls not back above the small sheet`);
    // A tap on the grip: small -> full, full -> half.
    await page.evaluate(() => document.querySelector('.chat-panel.open .chat-sheet-grip').click());
    await page.waitForTimeout(100);
    g = await geo();
    assert.ok(Math.abs(g.sheet.y - g.top.b) <= 1, `${label}: tap did not switch to full height`);
    await page.evaluate(() => document.querySelector('.chat-panel.open .chat-sheet-grip').click());
    await page.waitForTimeout(100);
    g = await geo();
    assert.ok(Math.abs(g.sheet.h - half) <= 2, `${label}: second tap did not go back to half (${g.sheet.h} vs ${half})`);
    // The on-screen keyboard (visualViewport 300 px shorter) lifts the sheet; the composer stays in view.
    const kb = await page.evaluate(async () => {
      const real = window.visualViewport;
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: { offsetTop: 0, height: innerHeight - 300, scale: 1, addEventListener() {} } });
      window.dispatchEvent(new Event('resize'));
      await new Promise(r => setTimeout(r, 80));
      const p = document.querySelector('.chat-panel.open').getBoundingClientRect(), c = document.querySelector('.chat-panel.open .chat-input-row').getBoundingClientRect();
      const out = { bottom: p.bottom, top: p.top, composer: c.bottom, limit: innerHeight - 300, mapHidden: getComputedStyle(document.querySelector('.vo-mapctl')).visibility === 'hidden' };
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: real });
      window.dispatchEvent(new Event('resize'));
      await new Promise(r => setTimeout(r, 80));
      out.after = document.querySelector('.chat-panel.open').getBoundingClientRect().bottom;
      return out;
    });
    assert.ok(Math.abs(kb.bottom - kb.limit) <= 1 && kb.composer <= kb.limit && kb.top >= 0, `${label}: keyboard: sheet ${kb.top}-${kb.bottom}, composer ${kb.composer}, keyboard top ${kb.limit}`);
    assert.ok(kb.mapHidden, `${label}: map controls shown while typing`);
    assert.ok(Math.abs(kb.after - g.bar.y) <= 1, `${label}: sheet did not return to the action bar after the keyboard`);
    // The height is kept for this device: a reload opens at the same height.
    const share = (await geo()).share;
    await page.reload(); await page.waitForTimeout(1500);
    await page.evaluate(() => { if (!document.querySelector('.chat-panel.open')) document.querySelector('.vo-actionbar [data-vo-chat-launch]').click(); });
    await page.waitForTimeout(500);
    g = await geo();
    assert.ok(Math.abs(g.sheet.h - half) <= 2 && g.share === share, `${label}: height after reload ${g.sheet.h} (expected ${half})`);
    assert.deepEqual(errors, [], `${label}: page errors`);
    await context.close();
  }
  {
    const { context, page } = await openOffice({ width: 1600, height: 900 });
    await page.evaluate(() => window.VirtualOfficeChat.open());
    await page.waitForTimeout(400);
    const grip = await page.evaluate(() => getComputedStyle(document.querySelector('#chat-panel .chat-sheet-grip')).display);
    assert.equal(grip, 'none', 'desktop: the phone sheet grip shows');
    await context.close();
  }
  pass('phone chat sheet: half way up, drag/tap/arrows resize, remembered, keyboard lift, office usable, map controls ride above');

  // Agent menu on desktop: card inside the office view, clear of the map
  // controls; keyboard; locked actions say why; clicking elsewhere closes.
  {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900 });
    const menuState = () => page.evaluate(() => {
      const el = document.getElementById('vo-agent-menu');
      const r = el.getBoundingClientRect(), cv = document.getElementById('officeCanvas').getBoundingClientRect();
      const m = document.querySelector('.vo-mapctl').getBoundingClientRect();
      const over = Math.max(0, Math.min(r.right, m.right) - Math.max(r.left, m.left)) * Math.max(0, Math.min(r.bottom, m.bottom) - Math.max(r.top, m.top));
      return { hidden: el.hidden, open: agents.filter(a => a.actionMenuOpen).map(a => a.name), focus: document.activeElement && document.activeElement.dataset.action,
        inside: r.left >= cv.left && r.right <= cv.right && r.top >= cv.top && r.bottom <= cv.bottom, over, side: el.dataset.side,
        status: el.querySelector('.vo-agent-menu-status') && el.querySelector('.vo-agent-menu-status').textContent,
        locked: [...el.querySelectorAll('[aria-disabled="true"]')].map(i => i.dataset.action + ':' + i.querySelector('small').textContent),
        chip: !!el.querySelector('.vo-agent-menu-chip'), pcHint: el.querySelector('[data-action="pc"] small') && el.querySelector('[data-action="pc"] small').textContent,
        workspace: el.querySelector('[data-action="workspace"] strong') && el.querySelector('[data-action="workspace"] strong').textContent,
        oldName: /Agent details/.test(el.textContent) };
    });
    for (const id of ['alpha', 'beta', 'gamma']) {
      await page.evaluate(id => { agents.forEach(a => { a.targetX = a.x; a.targetY = a.y; }); VOOffice.openAgent(id); }, id);
      await page.waitForTimeout(900);
      const st = await menuState();
      assert.equal(st.hidden, false, `${id}: menu not shown`);
      assert.ok(st.inside, `${id}: menu card leaves the office view (${st.side})`);
      assert.equal(st.over, 0, `${id}: menu card covers the map controls`);
      assert.equal(st.focus, 'chat', `${id}: keyboard focus did not move into the menu`);
      if (id === 'beta') assert.match(st.status, /^Working/, 'beta status');
      if (id === 'alpha') assert.equal(st.status, 'Idle', 'alpha status');
      // Same name as the desk's right-click "Workspace" item.
      assert.equal(st.workspace, 'Agent workspace', `${id}: the workspace row is not called "Agent workspace"`);
      assert.equal(st.oldName, false, `${id}: the menu still says "Agent details"`);
    }
    await page.keyboard.press('ArrowRight');
    assert.equal((await menuState()).focus, 'pc', 'ArrowRight did not move to Open PC');
    await page.keyboard.press('ArrowDown');
    assert.equal((await menuState()).focus, 'settings', 'ArrowDown did not move to Settings');
    await page.keyboard.press('Escape');
    let st = await menuState();
    assert.ok(st.hidden && st.open.length === 0, 'Esc did not close the menu');
    // Demo: Look and desk is locked and says why; Chat only shows the chip.
    await page.evaluate(() => { window._voLicense = { demo: true }; agentChatData.alpha = []; _agentMenu.can.alpha = { access: 'chat', at: Date.now() }; VOOffice.openAgent('alpha'); });
    await page.waitForTimeout(300);
    st = await menuState();
    assert.ok(st.locked.some(l => /^studio:.*license/i.test(l)), `demo lock missing: ${st.locked}`);
    assert.ok(st.locked.some(l => /^speech:No messages/.test(l)), `bubble without messages is not locked: ${st.locked}`);
    assert.ok(st.chip && st.pcHint === 'View only', 'Chat only connection not shown');
    // Clicking elsewhere (the top bar) closes it.
    await page.mouse.click(5, 5);
    await page.waitForTimeout(100);
    st = await menuState();
    assert.ok(st.hidden && st.open.length === 0, 'clicking elsewhere did not close the menu');
    // Chat action runs and closes the menu; the old canvas fan is gone.
    await page.evaluate(() => { window.__chatFor = null; window.VirtualOfficeChat = Object.assign(window.VirtualOfficeChat || {}, { openForAgent: id => { window.__chatFor = id; } }); VOOffice.openAgent('gamma'); });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    const ran = await page.evaluate(() => ({ chat: window.__chatFor, hidden: document.getElementById('vo-agent-menu').hidden, fan: typeof _agentActionAtWorld }));
    assert.deepEqual(ran, { chat: 'gamma', hidden: true, fan: 'undefined' }, 'Chat from the menu');
    assert.deepEqual(errors, [], 'page errors in the agent menu check');
    pass('desktop agent menu: inside the view, clear of map controls, arrows/Enter/Esc, locks say why, click elsewhere closes');
    await context.close();
  }

  // Rotation on a phone
  {
    const { context, page } = await openOffice({ width: 412, height: 915, mobile: true });
    let state = await canvasState(page);
    await page.setViewportSize({ width: 915, height: 412 });
    await page.waitForTimeout(700);
    state = await canvasState(page);
    assertBitmapMatchesBox(state, 'phone landscape');
    pass('bitmap = box x DPR after a phone rotation');
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`office canvas tests passed (${results.length})`);
