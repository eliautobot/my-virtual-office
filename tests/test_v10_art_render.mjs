// v0.10 art-render checks (headless Chrome, fixture APIs, no server, nothing written):
//   1. crisp pixels: the fit view and the phone start view sit on a whole device
//      scale, the world origin on a whole device pixel, zoom steps and a resting
//      wheel zoom land on whole steps, few soft edge pixels (A4);
//   2. view insets (contract C1): the office fits and centres in the free area,
//      the picture glides, zeros give the whole canvas back;
//   3. phone start view hangs from the top wall: no band under the top bar (UI-05).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);

function skip(reason) { console.log(`SKIP test_v10_art_render: ${reason}`); process.exit(0); }
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
const agentsList = ['Alpha', 'Beta', 'Gamma', 'Codex Agent', 'Hermes Agent', 'Desk Helper'];
const FIXTURES = {
  '/api/license': { demo: false, valid: true, limits: {} },
  '/vo-config': { version: '0.10.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
  '/api/agents': { agents: agentsList.map((n, i) => ({ id: 'a' + i, statusKey: 'a' + i, name: n, emoji: '🤖', role: 'Tester',
    providerKind: ['openclaw', 'hermes', 'codex'][i % 3], available: true })) },
  '/status': Object.fromEntries(agentsList.map((n, i) => ['a' + i, i % 2 ? { state: 'working', task: 'Running tests', activeToolCount: 1 } : { state: 'idle', task: '' }])),
  '/agent-chat': {},
  '/api/office-config': {
    canvasWidth: 1040, canvasHeight: 740,
    walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#55606a', accentColor: '#3b444c', trimColor: '#ffffff' },
      sections: [{ x: 0, w: 1040, color: '#55606a', accentColor: '#3b444c' }],
      interior: [{ x1: 13, y1: 3, x2: 13, y2: 10 }, { x1: 17, y1: 15, x2: 24, y2: 15 }] },
    floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
    furniture: [
      { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' }, { id: 'd2', type: 'desk', x: 320, y: 220, assignedTo: 'Beta' },
      { id: 'd3', type: 'desk', x: 160, y: 380, assignedTo: 'Gamma' }, { id: 'd4', type: 'desk', x: 320, y: 380, assignedTo: 'Codex Agent' },
      { id: 'd5', type: 'desk', x: 480, y: 220, assignedTo: 'Hermes Agent' }, { id: 'd6', type: 'desk', x: 480, y: 380, assignedTo: 'Desk Helper' },
      { id: 'c1', type: 'couch', x: 620, y: 560 }, { id: 'p1', type: 'plant', x: 900, y: 140 },
      { id: 'm1', type: 'meetingTable', x: 640, y: 260 }, { id: 'v1', type: 'vendingMachine', x: 720, y: 520 },
    ],
    branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
    agents: [], pet: { enabled: false },
  },
  '/weather-proxy': { current_condition: [], configured: false },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };
function makeRoute(fixtures) {
  return async function route(routeObj) {
    const request = routeObj.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return routeObj.abort();
    if (request.method() !== 'GET' && request.method() !== 'HEAD') return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (url.pathname === '/api/office-life/stream') return routeObj.fulfill({ status: 200, contentType: 'text/event-stream', body: ': hi\n\n' });
    if (Object.prototype.hasOwnProperty.call(fixtures, url.pathname)) return routeObj.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname]) });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel);
    const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return routeObj.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    }
    return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  };
}
const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
const results = [];
function pass(name) { results.push(name); console.log(`[PASS] ${name}`); }
async function openOffice({ width, height, dpr = 1, mobile = false, fixtures = FIXTURES, init = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
  await context.route('**/*', makeRoute(fixtures));
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length >= 3 && window.VOOffice && typeof displayW === 'number', null, { timeout: 20000 });
  await page.waitForTimeout(900);
  return { context, page, errors };
}
// Fake wall clock (local time) for day/night checks.
const clockAt = (h) => `(() => { const R = Date; const base = new R(2026, 10, 3, ${h}, 0, 0).getTime(); const t0 = R.now();
  class FD extends R { constructor(...a) { if (a.length === 0) super(base + (R.now() - t0)); else super(...a); } static now() { return base + (R.now() - t0); } }
  window.Date = FD; })();`;
const camInfo = () => {
  const o = _cameraOrigin(); const dpr = DPR;
  return { S: o.s * dpr, ox: o.x * dpr, oy: o.y * dpr, top: o.y, bottom: o.y + H * o.s, left: o.x, right: o.x + W * o.s, displayW, displayH, zoom: camera.zoom, mode: _cameraMode };
};
const whole = (v, label) => assert.ok(Math.abs(v - Math.round(v)) < 1e-6, `${label}: ${v} is not whole`);

try {
  // 1. Crisp pixels.
  {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900 });
    let c = await page.evaluate(camInfo);
    whole(c.S, '1600x900 fit device scale'); whole(c.ox, '1600x900 origin x'); whole(c.oy, '1600x900 origin y');
    assert.equal(c.S, 1, '1600x900 fit is 1:1');
    // Panning by a fraction keeps the origin on a whole pixel.
    c = await page.evaluate(() => { _cameraUserMoved(); camera.zoom = 2 / getBaseScale(); camera.x = 13.37; camera.y = 7.77; clampCamera(); _markSceneDirty(); return null; });
    c = await page.evaluate(camInfo);
    whole(c.ox, 'panned origin x'); whole(c.oy, 'panned origin y');
    // v0.12: manual zoom is smooth and stays where it is put (no snap to a crisp step): the buttons glide by 1.25x
    // and back, a wheel notch glides toward the pointer and rests where the glide ended.
    await page.evaluate(() => { _camAnim = null; fitView(); _camAnim = null; camera.zoom = 1; camera.x = 0; camera.y = 0; });
    const steps = await page.evaluate(async () => {
      const out = [];
      for (const f of ['zoomIn', 'zoomIn', 'zoomOut', 'zoomOut']) { VOOffice[f](); await new Promise(r => setTimeout(r, 450)); out.push(camera.zoom); }
      return out;
    });
    const near = (a, b) => Math.abs(a / b - 1) < 0.01;
    assert.ok(near(steps[0], 1.25) && near(steps[1], 1.5625) && near(steps[2], 1.25) && near(steps[3], 1), `zoom buttons ${steps.join(',')}`);
    const box = await page.locator('#officeCanvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -140);
    const during = [];
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(30); during.push(await page.evaluate(() => camera.zoom)); }
    await page.waitForTimeout(350);
    const glided = await page.evaluate(() => camera.zoom);
    await page.waitForTimeout(700);
    const rested = await page.evaluate(() => camera.zoom);
    assert.ok(during[0] < glided && during.some((z, i) => i && z > during[i - 1]), `wheel zoom glides: ${during.join(',')} -> ${glided}`);
    assert.ok(Math.abs(rested / glided - 1) < 1e-6, `wheel zoom stays where it rested (no snap): ${glided} -> ${rested}`);
    // Few soft (anti-aliased) edge pixels in the fit view.
    await page.evaluate(() => { _camAnim = null; fitView(); });
    await page.waitForTimeout(600);
    const soft = await page.evaluate(() => {
      const cv = document.getElementById('officeCanvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const o = _cameraOrigin(); const x0 = Math.ceil(o.x * DPR) + 2, y0 = Math.ceil((o.y + 100 * o.s) * DPR), x1 = Math.floor((o.x + W * o.s) * DPR) - 2, y1 = Math.floor((o.y + H * o.s) * DPR) - 2;
      let s = 0, n = 0; const w4 = cv.width * 4;
      const mid = (a, b, x) => x > Math.min(a, b) + 6 && x < Math.max(a, b) - 6;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * cv.width + x) * 4; n++;
        let h = true, v = true, hd = 0, vd = 0;
        for (let k = 0; k < 3; k++) {
          hd = Math.max(hd, Math.abs(d[i - 4 + k] - d[i + 4 + k])); vd = Math.max(vd, Math.abs(d[i - w4 + k] - d[i + w4 + k]));
          if (!mid(d[i - 4 + k], d[i + 4 + k], d[i + k]) && Math.abs(d[i - 4 + k] - d[i + 4 + k]) > 12) h = false;
          if (!mid(d[i - w4 + k], d[i + w4 + k], d[i + k]) && Math.abs(d[i - w4 + k] - d[i + w4 + k]) > 12) v = false;
        }
        if ((hd > 12 && h) || (vd > 12 && v)) s++;
      }
      return s / n;
    });
    assert.ok(soft < 0.03, `fit view has ${(soft * 100).toFixed(2)} % soft edge pixels`);
    assert.deepEqual(errors, [], 'page errors (1600x900)');
    await context.close();
    pass(`crisp pixels: fit on a whole device scale, origin on whole pixels; manual zoom glides and stays (no snap), soft edges ${(soft * 100).toFixed(2)} %`);
  }

  // 2. View insets (C1).
  {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900 });
    const events = [];
    await page.exposeFunction('__camEvt', d => events.push(d));
    await page.evaluate(() => window.addEventListener('vo:camera-change', e => window.__camEvt(e.detail)));
    const before = await page.evaluate(camInfo);
    const mid = await page.evaluate(async () => { const r = VOOffice.setViewInsets({ left: 200 }); await new Promise(r2 => setTimeout(r2, 60)); return { r, c: (() => { const o = _cameraOrigin(); return { left: o.x, s: o.s }; })() }; });
    assert.equal(mid.r.insets.left, 200, 'setViewInsets returns the camera state with the insets');
    assert.ok(mid.c.left < 200 && mid.c.left > before.left - 2, 'the picture glides instead of jumping');
    await page.waitForTimeout(500);
    const after = await page.evaluate(camInfo);
    assert.ok(after.left >= 200 - 0.5 && after.right <= after.displayW + 0.5, `office not inside the free area: ${after.left}..${after.right}`);
    const freeMid = 200 + (after.displayW - 200) / 2;
    assert.ok(Math.abs((after.left + after.right) / 2 - freeMid) <= 1, 'office not centred in the free area');
    whole(after.S, 'inset fit device scale');
    assert.ok(events.some(e => e.insets && e.insets.left === 200), 'vo:camera-change carries the insets');
    assert.ok(await page.evaluate(() => _cameraState().fit), 'the inset fit view counts as fit');
    // Bottom sheet (phone-like) inset, then back to zero.
    // (a short free area would switch the default view to phone framing: use Fit)
    await page.evaluate(() => { VOOffice.fitView(); VOOffice.setViewInsets({ bottom: 400 }); });
    await page.waitForTimeout(500);
    const sheet = await page.evaluate(camInfo);
    assert.ok(sheet.bottom <= sheet.displayH - 400 + 0.5, 'office not above the bottom sheet');
    await page.evaluate(() => VOOffice.setViewInsets({ left: 0, right: 0, top: 0, bottom: 0 }));
    await page.waitForTimeout(500);
    const back = await page.evaluate(camInfo);
    assert.ok(Math.abs(back.left - before.left) <= 1 && Math.abs(back.S - before.S) < 1e-6, 'zeros give the whole canvas back');
    // A user view keeps its zoom and stays in bounds.
    await page.evaluate(() => { VOOffice.zoomIn(); });
    await page.waitForTimeout(450);
    const z0 = await page.evaluate(() => getBaseScale() * camera.zoom);
    await page.evaluate(() => VOOffice.setViewInsets({ right: 360 }));
    await page.waitForTimeout(500);
    const z1 = await page.evaluate(() => getBaseScale() * camera.zoom);
    assert.ok(Math.abs(z1 - z0) < 1e-6, 'a zoomed-in view keeps its scale when an overlay opens');
    await page.evaluate(() => VOOffice.setViewInsets({}));
    assert.deepEqual(errors, [], 'page errors (insets)');
    await context.close();
    pass('view insets (C1): office fits and centres in the free area, glides, event carries insets, zeros restore, user zoom kept');
  }

  // 3. Phone start view: crisp, every agent framed (R-01), hanging from the top wall (UI-05). A whole device
  // scale when one still fits the agents, else the fractional framing drawn through the whole-scale layer.
  const phoneStart = () => { _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
    const o = _cameraOrigin(), fv = _freeView(), S = o.s * DPR, out = [];
    agents.forEach(a => { const t = a._ctl && a._ctl.tag; if (!t) { out.push(a.name + ' (no tag)'); return; }
      if (t.x < fv.x || t.x + t.w > fv.x + fv.w || t.y < fv.y || t.y + t.h > fv.y + fv.h) out.push(a.name + ' ' + [t.x, t.y, t.w].map(Math.round)); });
    return { S, k: _staticLayerK, top: o.y, wide: W * o.s > displayW, cut: out, dpr: DPR, back: canvas.width / displayW }; };
  const sharp = (c, label) => { if (Math.abs(c.S - Math.round(c.S)) > 1e-6) assert.equal(c.k, Math.ceil(c.S), `${label}: fractional ${c.S} not drawn through the whole-scale layer`); };
  for (const [w, h, dpr] of [[412, 915, 2], [390, 844, 2], [412, 915, 2.625], [390, 844, 3], [375, 667, 2], [360, 800, 3]]) {
    const { context, page, errors } = await openOffice({ width: w, height: h, dpr, mobile: true });
    const c = await page.evaluate(phoneStart);
    sharp(c, `${w}x${h}@${dpr}`);
    assert.deepEqual(c.cut, [], `${w}x${h}@${dpr}: agents cut at the screen edges (scale ${c.S})`);
    assert.ok(Math.abs(c.top) <= 0.5, `${w}x${h}@${dpr}: band of ${c.top.toFixed(1)} px between the top bar and the wall`);
    assert.ok(c.wide, `${w}x${h}@${dpr}: start view is not zoomed onto the agents`);
    assert.deepEqual(errors, [], `page errors (${w}x${h}@${dpr})`);
    await context.close();
  }
  pass('phone start view (412, 390, 375, 360): every agent tag inside the view, crisp (whole step or whole-scale layer), office hangs from the top wall');

  // 3b. Q-03: phones at DPR 2.625 / 3 / 3.5: backing store at the real ratio; a whole device scale where it fits.
  for (const dpr of [2.625, 3, 3.5]) {
    const { context, page, errors } = await openOffice({ width: 412, height: 915, dpr, mobile: true });
    const c = await page.evaluate(phoneStart);
    assert.ok(Math.abs(c.dpr - dpr) < 1e-6 && Math.abs(c.back - dpr) < 0.01, `@${dpr}: backing store ${c.back} not at the device ratio`);
    sharp(c, `412x915@${dpr}`);
    assert.deepEqual(c.cut, [], `@${dpr}: agents cut at the screen edges (scale ${c.S})`);
    assert.ok(c.top <= 0.5, `@${dpr}: band of ${c.top} px under the top bar`);
    if (dpr === 2.625) {
      // The step rule (total, cover, agents' fitting scale): up only while the agents fit, else a close step
      // down, else the fractional framing itself.
      const s = await page.evaluate(() => [_crispFramingScale(1.0, 1.1, 1.2), _crispFramingScale(1.0, 1.1, 1.0), _crispFramingScale(0.85, 1.1, 0.86)].map(v => v * DPR));
      assert.deepEqual(s.map(v => +v.toFixed(3)), [3, 2.625, 2], `R-01 step rule @2.625: ${s}`);
    }
    assert.deepEqual(errors, [], `page errors (@${dpr})`);
    await context.close();
  }
  pass('Q-03 phones at DPR 2.625 / 3 / 3.5: backing at the device ratio, agents framed, whole step up only while the agents fit, no band under the top bar');

  // 3c. Q-03 fractional fits draw the environment through a whole-scale layer (sharp bilinear), Q-10 Fill = v0.9 fit.
  {
    const { context, page, errors } = await openOffice({ width: 1920, height: 1080 });
    const r = await page.evaluate(() => { _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      return { S: _cameraOrigin().s * DPR, k: _staticLayerK, lw: _staticLayer && _staticLayer.width, W }; });
    assert.ok(Math.abs(r.S - Math.round(r.S)) > 0.01, `fixture: 1920x1080 fit is fractional (${r.S})`);
    assert.equal(r.k, Math.ceil(r.S), 'fractional fit draws the static art at the next whole scale');
    assert.equal(r.lw, r.W * r.k, 'world-sized layer');
    assert.deepEqual(errors, [], 'page errors (sharp layer)');
    await context.close();
    const fill = await openOffice({ width: 1600, height: 900, init: `localStorage.setItem('vo-display-prefs', JSON.stringify({ officeFit: 'fill' }));` });
    const f = await fill.page.evaluate(() => { _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      const fv = _freeView(); return { S: _cameraOrigin().s * DPR, k: _staticLayerK, fit: Math.min((fv.w - 2 * CAM_FIT_MARGIN) / W, (fv.h - 2 * CAM_FIT_MARGIN) / H) }; });
    assert.ok(Math.abs(f.S - f.fit) < 1e-6 && f.k === 0, `Fill the screen = the plain fractional fit, drawn directly ${JSON.stringify(f)}`);
    assert.deepEqual(fill.errors, [], 'page errors (fill)');
    await fill.context.close();
  }
  pass('Q-03/Q-10 fractional fit through a whole-scale layer; "Fill the screen" = v0.9 fractional fit');

  // 3d. Q-09: a tight cluster of agents: tags of different agents do not overlap (nudged), and every agent keeps
  // its menu control (v0.13: the name tag itself, no ••• above it; nothing hidden).
  // R-04: also zoomed to 1.36 (1920x1080's fit), where the tags are a font step bigger.
  for (const [w, h, dpr, mobile, fit, zoom] of [[1600, 900, 1, false, false, 0], [1600, 900, 1, false, false, 1.36], [1600, 900, 2, false, false, 1.36], [375, 667, 2, true, true, 0]]) {
    const { context, page, errors } = await openOffice({ width: w, height: h, dpr, mobile });
    const r = await page.evaluate(([fit, zoom]) => {
      if (fit) { camera.zoom = 1; camera.x = 0; camera.y = 0; _cameraMode = 'fit'; }
      if (zoom) { camera.zoom = zoom / getBaseScale(); const cc = _cameraCentre(zoom); camera.x = 340 - W / 2 + cc.x; camera.y = 300 - H / 2 + cc.y; }
      const list = agents.slice(0, Math.min(agents.length, 6));
      // Desktop: a shoulder-to-shoulder row (40 px apart, two rows); compact phone fit (whole office in 375 px):
      // neighbouring desks (72 x 76 world px apart = about 25 CSS px there, narrower than a name tag).
      const dx = fit ? 72 : 40, dy = fit ? 76 : 34;
      list.forEach((a, i) => { a.x = a.targetX = 300 + (i % 3) * dx; a.y = a.targetY = 330 + Math.floor(i / 3) * dy; a.isSitting = false; });
      _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      const rects = [], folded = [];
      list.forEach(a => { const c = a._ctl; if (!c) return; if (c.folded) folded.push(a.name); rects.push([a.name, c.tag], [a.name, c.launcher]); });
      const ov = (p, q) => Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y));
      const cross = [];
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (rects[i][0] !== rects[j][0] && ov(rects[i][1], rects[j][1]) > 2) cross.push(rects[i][0] + 'x' + rects[j][0]);
      return { n: list.length, shown: list.filter(a => a._ctl).length, withMenu: list.filter(a => a._ctl && ((L, T) => !!(L && T && L.x === T.x && L.w === T.w && Math.abs(L.y + L.h - T.y - T.h) < 0.01 && L.y <= T.y && L.h <= Math.max(T.h, 24) + 0.01))(a._ctl.launcher, a._ctl.tag) && a._ctl.tag.w > 0).length, cross, folded,
        tagH: list[0]._ctl && list[0]._ctl.tag.h };
    }, [fit, zoom]);
    if (zoom) assert.ok(r.tagH * dpr >= 13 * Math.ceil(dpr) + 1, `${w}x${h}@${dpr} zoom ${zoom}: tags did not grow (${r.tagH})`);
    assert.ok(r.shown >= 3, `fixture: ${r.shown} agents laid out`);
    assert.deepEqual(r.cross, [], `${w}x${h}: overlapping controls of different agents ${JSON.stringify(r)}`);
    assert.equal(r.withMenu, r.shown, 'every agent keeps its menu control (the name tag)');
    assert.deepEqual(errors, [], `page errors (Q-09 ${w}x${h})`);
    await context.close();
  }
  pass('Q-09 crowded agents: name tags (the menu controls) of different agents never overlap (nudged), none hidden');

  // 3e. R-04: name tags grow with the office like v0.9 (14 world px tall) in whole pixel-font steps: crisp
  // (13 device px per font px), never smaller than at scale 1, at most ~60 % of the character, font scale 2 at most.
  for (const dpr of [1, 2]) {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900, dpr });
    const r = await page.evaluate(() => [1.0, 1.2, 1.36, 1.6, 1.75, 2.5].map(t => {
      camera.zoom = t / getBaseScale(); const a = agents[0], cc = _cameraCentre(t);
      camera.x = a.x - W / 2 + cc.x; camera.y = a.y - H / 2 + cc.y;
      _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      return { t, h: a._ctl ? a._ctl.tag.h : 0, fp: _tagFontPx(t), base: _chipFontPx(1), two: _chipFontPx(2) }; }));
    let prev = 0;
    for (const x of r) {
      assert.ok(Math.abs(x.h * dpr - 13 * x.fp) < 1e-6, `@${dpr} scale ${x.t}: tag ${x.h} px is not 13 x ${x.fp} device px`);
      assert.ok(x.h >= prev && x.fp >= x.base && x.fp <= x.two, `@${dpr} scale ${x.t}: ${JSON.stringify(x)} after ${prev}`);
      if (x.fp > x.base) assert.ok(x.h <= 0.6 * 32 * x.t + 1e-6, `@${dpr} scale ${x.t}: tag ${x.h} px over 60 % of the character`);
      prev = x.h;
    }
    const at = t => r.find(x => x.t === t).h;
    assert.equal(at(1.0), 13, `@${dpr}: tag at scale 1 stays 13 px`);
    assert.ok(at(1.36) >= 19, `@${dpr}: tag at 1920x1080's scale 1.36 is ${at(1.36)} px (v0.9 19)`);
    assert.equal(at(2.5), at(1.75), `@${dpr}: tags stop growing past font scale 2`);
    assert.deepEqual(errors, [], `page errors (R-04 @${dpr})`);
    await context.close();
  }
  pass('R-04 name tags grow with the office (scale 1 -> 1.75) in whole pixel-font steps, capped at the character and at font scale 2');

  // 4. One chip family (A8, UI-02, UI-11, UI-23).
  for (const dpr of [1, 2]) {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900, dpr });
    const r = await page.evaluate(async () => {
      const F = window.VOPixelFont;
      const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
      const out = { ascii: F.has(ascii), accent: F.has('José'), fit: F.measure(F.fit('A very long agent name indeed', 60)) <= 60 };
      // Agents a desk apart, one per activity kind.
      const kinds = [{ s: 'working', t: 0 }, { s: 'working', t: 1 }, { s: 'idle', t: 0 }];
      agents.forEach((a, i) => { const k = kinds[i % 3]; a.state = k.s; a.activeToolCount = k.t; });
      _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      out.tags = agents.filter(a => a._ctl).map(a => {
        const c = a._ctl, fp = _chipFontPx(1), textW = F.measure(F.fit(a.name, Math.floor(NAME_TAG_MAX * DPR / fp))) * fp / DPR;
        return { name: a.name, w: c.tag.w, h: c.tag.h, textW, pad: (c.tag.w - textW) / 2, chip: !!c.chip, state: a.state, tools: a.activeToolCount,
          tagIsMenu: ((L, T) => !!(L && T && L.x === T.x && L.w === T.w && Math.abs(L.y + L.h - T.y - T.h) < 0.01 && L.y <= T.y && L.h <= Math.max(T.h, 24) + 0.01))(c.launcher, c.tag), thinking: !!c.thinking, dots: !!c.tag.dots, hit: a.nameTagRect && a.nameTagRect.w > 0 };
      });
      // UI-02: a needs sign takes the chip's place for that agent.
      const busy = agents.find(a => a.activeToolCount > 0 && a.state === 'working');
      const saved = window.VOLife && window.VOLife.suppressApprovalChip;
      if (window.VOLife) window.VOLife.suppressApprovalChip = k => k === busy.statusKey;
      _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      out.suppressed = !busy._ctl.chip;
      if (window.VOLife) window.VOLife.suppressApprovalChip = saved;
      // UI-23: an Office life label at the canvas edge stays inside the view.
      const lab = VOLifeSprites.label(ctx, 'Needs your OK', -40, displayH + 30, { kind: 'warning', icon: 'placard' });
      out.clamped = lab.x >= 2 && lab.y + lab.h <= displayH - 2;
      // Pills are cached bitmaps: drawing a frame again adds none.
      const n0 = _chipCache.size; _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      out.cacheStable = _chipCache.size === n0;
      return out;
    });
    assert.ok(r.ascii, 'pixel font covers printable ASCII');
    assert.ok(!r.accent, 'names outside the pixel font are reported (system font fallback)');
    assert.ok(r.fit, 'pixel font fit() cuts with … inside the width');
    for (const t of r.tags) {
      assert.ok(t.pad >= 4 - 1e-6, `dpr ${dpr}: tag "${t.name}" padding ${t.pad} px < 4 (A8 text spills)`);
      assert.ok(t.w <= 96 + 14, `dpr ${dpr}: tag "${t.name}" ${t.w} px wide`);
      assert.ok(t.tagIsMenu, `dpr ${dpr}: the menu control of "${t.name}" is not its name tag (a ••• above it?)`);
      assert.ok(t.hit, `dpr ${dpr}: tag "${t.name}" has no hit box`);
      if (t.state === 'working' && !t.tools) assert.ok(!t.chip && t.thinking && t.dots, `dpr ${dpr}: thinking "${t.name}": separate chip ${t.chip}, dots in the tag ${t.dots}`);
      if (t.state !== 'working' || t.tools) assert.ok(!t.thinking && !t.dots, `dpr ${dpr}: "${t.name}" (${t.state}) shows thinking dots`);
      if (t.state === 'working' && t.tools) assert.ok(t.chip, `dpr ${dpr}: "${t.name}" using tools has no chip`);
    }
    assert.ok(r.tags.some(t => t.name === 'Hermes Agent') && r.tags.some(t => t.name === 'Desk Helper'), 'long names drawn');
    assert.ok(r.suppressed, 'UI-02: chip still drawn under the needs-you sign');
    assert.ok(r.clamped, 'UI-23: label not clamped inside the view');
    assert.ok(r.cacheStable, 'pill bitmaps are rebuilt every frame');
    assert.deepEqual(errors, [], `page errors (chips dpr ${dpr})`);
    await context.close();
  }
  pass('one chip family: measured pixel-font name tags (4 px padding, …), thinking as dots in the tag, needs sign replaces the chip, labels clamped, pills cached');

  // 4b. v0.13 (review): no ••• chip above the agents in any state or zoom, desktop or phone. The name tag is the
  // menu control (same 32 / 44 px grown hit boxes the ••• had), thinking ripples as dots after the name.
  for (const [w, h, dpr, mobile] of [[1600, 900, 1, false], [1600, 900, 2, false], [412, 915, 2, true]]) {
    const { context, page, errors } = await openOffice({ width: w, height: h, dpr, mobile });
    const r = await page.evaluate((mobile) => {
      const drawn = [], real = _drawAgentCtlCircle;
      _drawAgentCtlCircle = function(rect, stroke, lw, text) { drawn.push(text); return real.apply(this, arguments); };
      const states = [['idle', 0], ['working', 0], ['working', 1], ['offline', 0], ['menu', 0], ['hover', 0]];
      const bad = [], hits = [], dots = [], miss = [];
      for (const z of [null, 0.5, 1.36, 2.5]) {
        for (const [s, t] of states) {
          if (z === null) VOOffice.fitView(); else { camera.zoom = z / getBaseScale(); camera.x = 0; camera.y = 0; clampCamera(); }
          const list = agents.slice(0, 3);
          const c0 = screenToWorld(canvas.getBoundingClientRect().left + displayW / 2, canvas.getBoundingClientRect().top + displayH / 2);
          const apart = Math.min(240, displayW / 3.2) / (getBaseScale() * camera.zoom);
          list.forEach((a, i) => { a.x = a.targetX = c0.x + (i - 1) * apart; a.y = a.targetY = c0.y; a.path = []; a.isSitting = false;
            a.state = s === 'menu' || s === 'hover' ? 'working' : s; a.activeToolCount = t; a.actionMenuOpen = false; });
          _hoverAgent = s === 'hover' ? list[1] : null;
          if (s === 'menu') list[1].actionMenuOpen = true;
          drawn.length = 0;
          _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
          if (drawn.some(x => x !== '💬')) bad.push(`${z}/${s}: drew ${drawn.join(',')}`);
          list.forEach(a => {
            const c = a._ctl; if (!c) return;
            if (!((L, T) => !!(L && T && L.x === T.x && L.w === T.w && Math.abs(L.y + L.h - T.y - T.h) < 0.01 && L.y <= T.y && L.h <= Math.max(T.h, 24) + 0.01))(c.launcher, c.tag)) bad.push(`${z}/${s}: ${a.name} menu control is not the name tag`);
            // The activity chip sits above the controls' row (clear of the 💬 and mood badge beside the tag).
            if (c.chip && c.chip.y + c.chip.h > c.launcher.y - 2) bad.push(`${z}/${s}: ${a.name} chip not above the tag row`);
            const thinking = a.state === 'working' && !a.activeToolCount;
            if (!!c.thinking !== thinking || !!c.tag.dots !== thinking) bad.push(`${z}/${s}: ${a.name} thinking ${c.thinking} dots ${!!c.tag.dots}`);
            // The tag (exact) and a point 20 px above / below its middle (a 40 px box at least on touch) open the menu.
            const cx = c.tag.x + c.tag.w / 2, cy = c.tag.y + c.tag.h / 2, grow = mobile ? 44 : 32, off = mobile ? 20 : 15;
            for (const [y, min] of [[cy, 0], [cy - off, grow], [cy + off, grow]]) {
              // Skip a point a neighbour's (nudged) tag, chip or 💬 box also covers: crowding, not the target size.
              if (agents.some(b => b !== a && b._ctl && [b._ctl.tag, b._ctl.chip, b._ctl.bubbleShown ? b._ctl.bubble : null].some(q => _hitCanvasRect(q, cx, y, min)))) continue;
              const hit = _agentControlAtCanvas(cx, y, min);
              // The middle of the tag is the tag; off it, its own activity chip (same menu) may be nearer.
              const ok = !!(hit && hit.agent === a && hit.kind === 'menu' && (hit.tag || (min > 0 && hit.agent._ctl.chip)));
              hits.push(ok);
              if (!ok && miss.length < 4) miss.push(`${z}/${s}/${a.name}/${Math.round(y - cy)}/${min}: ${hit ? hit.agent.name + ' ' + hit.kind + ' ' + hit.tag + ' d=' + hit.d.toFixed(1) : 'none'}`);
            }
            if (thinking && c.tag.dots && a.state !== 'offline') {
              // The dots are drawn in the tag's text colour after the name.
              const D = c.tag.dots, px = Math.round(c.tag.x * DPR) + D.x, py = Math.round(c.tag.y * DPR) + D.y - D.d;
              // Only tags fully in the view (a neighbour at the edge of a phone can be cut by the screen).
              if (px < 0 || py < 0 || px + 3 * D.d + 2 * D.gap > canvas.width || py + 2 * D.d > canvas.height) return;
              const img = ctx.getImageData(px, py, 3 * D.d + 2 * D.gap, 2 * D.d).data;
              const want = [1, 3, 5].map(k => parseInt(D.color.slice(k, k + 2), 16));
              let n = 0; for (let k = 0; k < img.length; k += 4) if (Math.abs(img[k] - want[0]) + Math.abs(img[k + 1] - want[1]) + Math.abs(img[k + 2] - want[2]) < 24) n++;
              dots.push(n >= 3 * D.d * D.d);
              if (n < 3 * D.d * D.d && miss.length < 6) miss.push(`dots ${z}/${s}/${a.name}: ${n} px at ${px},${py} view ${Math.round(displayW * DPR)}x${Math.round(displayH * DPR)}`);
            }
          });
        }
      }
      _drawAgentCtlCircle = real; _hoverAgent = null;
      // Reduced motion / Calm: the dots stand still on the baseline (none lifted), still drawn.
      const rx = _rxStill; _rxStill = () => true;
      VOOffice.fitView();
      agents.forEach(a => { a.actionMenuOpen = false; });
      const a1 = agents[1]; a1.state = 'working'; a1.activeToolCount = 0;
      _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
      _rxStill = rx;
      let still = null;
      if (a1._ctl && a1._ctl.tag.dots) {
        const D = a1._ctl.tag.dots, px = Math.round(a1._ctl.tag.x * DPR) + D.x, py = Math.round(a1._ctl.tag.y * DPR) + D.y;
        const want = [1, 3, 5].map(k => parseInt(D.color.slice(k, k + 2), 16));
        const count = (y) => { const img = ctx.getImageData(px, y, 3 * D.d + 2 * D.gap, D.d).data; let n = 0;
          for (let k = 0; k < img.length; k += 4) if (Math.abs(img[k] - want[0]) + Math.abs(img[k + 1] - want[1]) + Math.abs(img[k + 2] - want[2]) < 24) n++; return n; };
        still = { base: count(py), lifted: count(py - D.d), need: 3 * D.d * D.d };
      }
      return { bad, hits: hits.length, hitOk: hits.filter(Boolean).length, dots: dots.length, dotsOk: dots.filter(Boolean).length,
        noFold: typeof _foldAgentLauncher === 'undefined', still, miss };
    }, mobile);
    assert.deepEqual(r.bad, [], `${w}x${h}@${dpr}: a ••• or a wrong menu control/thinking state`);
    assert.ok(r.hits > 0 && r.hitOk === r.hits, `${w}x${h}@${dpr}: name tag hit boxes ${r.hitOk}/${r.hits} open the menu ${r.miss.join(' | ')}`);
    assert.ok(r.dots > 0 && r.dotsOk === r.dots, `${w}x${h}@${dpr}: thinking dots drawn in ${r.dotsOk}/${r.dots} tags ${r.miss.join(' | ')}`);
    assert.ok(r.noFold, 'the Q-09 ••• fold is gone (nothing to fold)');
    assert.ok(r.still && r.still.base >= r.still.need && r.still.lifted === 0, `${w}x${h}@${dpr}: reduced motion dots ${JSON.stringify(r.still)}`);
    assert.deepEqual(errors, [], `page errors (v0.13 no ••• ${w}x${h})`);
    await context.close();
  }
  pass('v0.13 no ••• above agents (any state, any zoom, desktop and phone): the name tag is the menu control (32 / 44 px boxes), thinking = dots in the tag');

  // 5. Night (A10, v0.10.1 "lit, not glowing"): a light map from the real sources only (screens, lamps, vending fronts,
  // the TV, moonlit windows). Sources keep full brightness, the floor next to a source is lit, the far floor is dark,
  // and nothing is painted over people: screens glow in the z-order before the bodies (Z-06, Z-19). None by day.
  {
    // Settings > Night inside: 'dim' is the moonlit look these checks were made for; 'lit' (the default) keeps
    // the office lights on (checked after).
    const probe = async (hour, look = 'dim') => {
      const prefs = `localStorage.setItem('vo-display-prefs', JSON.stringify({ nightLook: '${look}' }));`;
      const { context, page, errors } = await openOffice({ width: 1600, height: 900, init: clockAt(hour) + '\n' + prefs });
      const r = await page.evaluate(() => {
        // Alpha works (monitor on), Beta and the rest rest.
        agents.forEach(a => { a.state = a.name === 'Alpha' ? 'working' : 'idle'; a.activeToolCount = 0; });
        _nightStateAt = 0;
        // Two frames of the same instant (frozen clocks: no animation or simulation step between them).
        const t0 = Date.now(), realNow = Date.now; Date.now = () => t0;
        const p0 = performance.now(); performance.now = () => p0;
        const realRandom = Math.random; let seed = 1;
        Math.random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
        const render = () => { seed = 1; _sceneDirty = true; _lastDrawAt = 0; _renderFrame(p0); };
        const cv = document.getElementById('officeCanvas'), g = cv.getContext('2d');
        const shot = () => g.getImageData(0, 0, cv.width, cv.height).data;
        // Draw order: the screens' glow comes before any person; keep the world transform for the sitter mask.
        const order = [], oScreens = drawNightScreens, oDraw = Agent.prototype.draw; let T = null;
        window.drawNightScreens = function () { order.push('screens'); T = ctx.getTransform(); return oScreens.apply(this, arguments); };
        Agent.prototype.draw = function () { if (!order.includes('agent')) order.push('agent'); return oDraw.apply(this, arguments); };
        render();
        Agent.prototype.draw = oDraw; window.drawNightScreens = oScreens;
        const A = shot();
        window.drawNightScreens = () => {}; render(); const B = shot(); window.drawNightScreens = oScreens;
        render(); const A2 = shot();
        // The working sitter's own pixels: none of them may change when the screens glow (a pixel counts when both
        // glowing frames agree and differ from the frame without glow: per-frame animation is not glow).
        const alpha = agents.find(a => a.name === 'Alpha');
        let body = 0, painted = 0, glow = 0;
        if (T) {
          const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
          const og = off.getContext('2d'); og.setTransform(T);
          const main = ctx; ctx = og; try { alpha.draw(og); } finally { ctx = main; }
          const S = og.getImageData(0, 0, cv.width, cv.height).data;
          for (let i = 0; i < S.length; i += 4) {
            const diff = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
            if (diff > 6) glow++;
            const same = Math.abs(A[i] - A2[i]) + Math.abs(A[i + 1] - A2[i + 1]) + Math.abs(A[i + 2] - A2[i + 2]) <= 6;
            if (S[i + 3] === 255) { body++; if (diff > 6 && same) painted++; }   // opaque body pixels
          }
        }
        render();
        Date.now = realNow; delete performance.now; Math.random = realRandom;
        const rgbAt = (wx, wy) => { const p = _worldToCanvas(wx, wy); return Array.from(g.getImageData(Math.round(p.x * DPR), Math.round(p.y * DPR), 1, 1).data.slice(0, 3)); };
        const lum = (wx, wy) => { const p = _worldToCanvas(wx, wy); const d = g.getImageData(Math.round(p.x * DPR), Math.round(p.y * DPR), 1, 1).data; return 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]; };
        const avg = (x, y, w, h) => { let s = 0, n = 0; for (let i = 1; i < w; i += 2) for (let j = 1; j < h; j += 2) { s += lum(x + i, y + j); n++; } return s / n; };
        const deskOf = n => officeConfig.furniture.find(f => f.assignedTo === n);
        const mon = d => { const m = _deskMonitorRects(d)[0]; return avg(d.x + m.x, d.y + m.y, m.w, m.h); };
        const v = officeConfig.furniture.find(f => f.type === 'vendingMachine');
        return { level: _nightLevel(), active: mon(deskOf('Alpha')), rest: mon(deskOf('Desk Helper')),
          panel: avg(v.x + 5, v.y + 5, 28, 45), near: lum(v.x + 22, v.y + 90), far: lum(1010, 715), farRgb: rgbAt(1010, 715),
          map: !!_lightMap && _lightMapKey !== '', order: order.join(','), body, painted, glow,
          drewEmissiveOverPeople: typeof window.drawEmissivePass === 'function' };
      });
      assert.deepEqual(errors, [], `page errors (night ${hour})`);
      await context.close();
      return r;
    };
    const day = await probe(13), night = await probe(22);
    assert.equal(day.level, 0, 'no night level by day');
    assert.equal(day.glow, 0, `screens do not glow by day (${day.glow} px)`);
    assert.equal(night.level, 1, 'full night level at 22:00');
    assert.ok(night.map, 'night light map built');
    assert.ok(night.far < day.far * 0.55, `the far floor does not get dark at night (${(night.far / day.far).toFixed(2)})`);
    assert.ok(night.near / day.near > night.far / day.far + 0.15, `the floor in front of the vending machine is not lit (${(night.near / day.near).toFixed(2)} vs far ${(night.far / day.far).toFixed(2)})`);
    assert.ok(night.panel > day.panel * 0.85, `the vending front is not bright (${night.panel.toFixed(0)} vs day ${day.panel.toFixed(0)})`);
    assert.ok(night.active > day.active, `a working monitor is not brighter than by day (${night.active.toFixed(0)} vs ${day.active.toFixed(0)})`);
    assert.ok(night.active > night.rest + 6, `a working monitor does not glow brighter (${night.active.toFixed(0)} vs ${night.rest.toFixed(0)})`);
    assert.equal(night.order, 'screens,agent', 'screens glow before the people are drawn');
    assert.ok(night.glow > 50 && night.body > 200, `screen glow / sitter mask measured (${night.glow} glow px, ${night.body} body px)`);
    assert.equal(night.painted, 0, `screen glow painted over the sitter (${night.painted} of ${night.body} px)`);
    assert.ok(!night.drewEmissiveOverPeople, 'no emissive pass after the light map');
    pass(`night (dim): lit by its sources (far floor ${(night.far / day.far * 100).toFixed(0)} %, vending floor ${(night.near / day.near * 100).toFixed(0)} %), bright screens, nothing painted over the sitter`);
    // Lights on (default): a lit indoor room, not a dark blue one.
    const lit = await probe(22, 'lit');
    const [fr, , fb] = lit.farRgb;
    assert.equal(lit.level, 1, 'full night level at 22:00 (lights on)');
    assert.ok(lit.far > day.far * 0.8, `lights on: the far floor stays bright (${(lit.far / day.far).toFixed(2)} of day)`);
    assert.ok(fb - fr <= 12, `lights on: the floor is not blue (rgb ${lit.farRgb.join(',')})`);
    assert.ok(lit.active > lit.rest, `lights on: a working monitor is brighter than a resting one (${lit.active.toFixed(0)} vs ${lit.rest.toFixed(0)})`);
    assert.equal(lit.order, 'screens,agent', 'lights on: screens glow before the people are drawn');
    assert.equal(lit.painted, 0, `lights on: screen glow painted over the sitter (${lit.painted} px)`);
    pass(`night (lights on): far floor ${(lit.far / day.far * 100).toFixed(0)} % of day, warm not blue, nothing painted over the sitter`);
  }

  // 6. A19: someone behind a horizontal interior wall shows as a faint silhouette on the wall face.
  {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900 });
    const r = await page.evaluate(() => {
      const wall = officeConfig.walls.interior.find(w => w.y1 === w.y2);
      const wy = wall.y1 * TILE, wx = (Math.max(wall.x1, wall.x2) - 2) * TILE; // clear of the couch in front of the wall
      const a = agents[0];
      const sample = () => {
        _sceneDirty = true; _lastDrawAt = 0; _renderFrame(performance.now());
        const g = document.getElementById('officeCanvas').getContext('2d');
        let sum = 0;
        for (let dy = -30; dy <= -10; dy += 4) for (let dx = -6; dx <= 6; dx += 3) {
          const p = _worldToCanvas(wx + dx, wy + dy); const d = g.getImageData(Math.round(p.x * DPR), Math.round(p.y * DPR), 1, 1).data;
          sum += d[0] + d[1] + d[2];
        }
        return sum;
      };
      agents.forEach(o => { o.x = o.targetX = 120; o.y = o.targetY = 700; o.path = []; o.isSitting = false; });
      const empty = sample();
      a.x = a.targetX = wx; a.y = a.targetY = wy - 12; a.path = []; a.isSitting = false;
      const behind = _isAgentBehindHorizontalWall(a);
      const withAgent = sample();
      return { behind, diff: Math.abs(withAgent - empty) };
    });
    assert.ok(r.behind, 'fixture: the agent is not behind the wall');
    assert.ok(r.diff > 200, `no silhouette on the wall face (pixel difference ${r.diff})`);
    assert.deepEqual(errors, [], 'page errors (silhouette)');
    await context.close();
    pass('A19: an agent behind an interior wall shows as a faint silhouette on the wall face');
  }

  // 6b. Q-01: the Agent PC preview anchor + control point sit on the drawn monitor (side monitor, every rotation).
  {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900 });
    const r = await page.evaluate(() => {
      const out = [];
      const desk = officeConfig.furniture.find(f => f.type === 'desk' && _getDeskAgent(f));
      const boss = officeConfig.furniture.find(f => f.type === 'bossDesk' && _getDeskAgent(f));
      const rot0 = desk.rotation;
      const measure = (d, label) => {
        const a = _getDeskAgent(d), an = window.__voResolveAgentPreviewAnchor(a.statusKey || a.id);
        const rr = _deskMonitorRects(d).map(m => ({ x: d.x + m.bx, y: d.y + m.by, w: m.bw, h: m.bh }));  // world axes at every turn (per-view monitors)
        const p0 = rr.map(q => _worldToScreen(q.x, q.y)), p1 = rr.map(q => _worldToScreen(q.x + q.w, q.y + q.h));
        const b = { x0: Math.min(...p0.map(p => p.x)), y0: Math.min(...p0.map(p => p.y)), x1: Math.max(...p1.map(p => p.x)), y1: Math.max(...p1.map(p => p.y)) };
        out.push({ label, dx: Math.abs(an.x - (b.x0 + b.x1) / 2), dy: Math.abs(an.y - b.y0),
          ctl: an.controlX >= b.x0 && an.controlX <= b.x1 && an.controlY >= b.y0 && an.controlY <= b.y1 });
      };
      for (const rot of [0, 90, 180, 270]) { desk.rotation = rot; measure(desk, 'desk ' + rot); }
      desk.rotation = rot0;
      if (boss) measure(boss, 'boss');
      return out;
    });
    assert.deepEqual(errors, [], 'page errors (preview anchor)');
    await context.close();
    for (const m of r) {
      assert.ok(m.dx <= 1 && m.dy <= 1, `${m.label}: preview anchor ${m.dx.toFixed(1)}/${m.dy.toFixed(1)} px off the top centre of the drawn monitor`);
      assert.ok(m.ctl, `${m.label}: preview control point is not on the drawn monitor`);
    }
    pass('Q-01: Agent PC preview anchor = top centre of the drawn monitor, control point on it, at 0/90/180/270 and on the boss desk');
  }

  // 7. A14: a wall banner per holiday, 2x props, holiday lights glow at night.
  {
    const lifeState = (day) => ({ ok: true, seq: 1, day, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      settings: { enabled: true, calm: false, features: { seasons: true }, seasons: { decor: true, fridayTreat: false, rain: false, birthdays: true,
        holidays: { newYear: true, valentines: true, earthDay: true, halloween: true, yearEndLights: true }, custom: [] } },
      open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], birthdayYears: {}, cake: false } });
    const out = {};
    for (const [label, mo, d, h] of [['halloween', 10, 31, 14], ['yearEnd', 12, 20, 21]]) {
      const day = `2026-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const fixtures = Object.assign({}, FIXTURES, { '/api/office-life/state': lifeState(day) });
      const init = clockAt(h).replace('new R(2026, 10, 3,', `new R(2026, ${mo - 1}, ${d},`);
      const { context, page, errors } = await openOffice({ width: 1600, height: 900, fixtures, init });
      await page.waitForFunction(() => window.VOLifeSeasons && VOLifeSeasons._state && VOLifeSeasons._state().banner, null, { timeout: 12000 }).catch(() => {});
      out[label] = await page.evaluate(() => ({ st: VOLifeSeasons._state(), glow: window.VOOfficeGlow ? VOOfficeGlow.get('decor') : [], night: _nightLevel() }));
      assert.deepEqual(errors, [], `page errors (decor ${label})`);
      await context.close();
    }
    assert.equal(out.halloween.st.banner && out.halloween.st.banner.text, 'Happy Halloween', 'Halloween banner');
    assert.ok(out.halloween.glow.length >= 1 && out.halloween.glow.every(g => g.color === '255,170,60'), 'pumpkin candles register a glow');
    assert.equal(out.yearEnd.st.banner && out.yearEnd.st.banner.text, 'Happy Holidays', 'year-end banner');
    assert.ok(out.yearEnd.glow.length >= 4 && out.yearEnd.night === 1, `year-end lights glow at night (${out.yearEnd.glow.length} bulbs)`);
    pass(`seasonal decor: banner per holiday, pumpkin candles and ${out.yearEnd.glow.length} light bulbs glow at night`);
  }

  // 8. v0.12: UI themes no longer grade the office (was UI-04 step 2). With the animation frozen, Gameboy,
  //    Cyberpunk and Retro draw the same canvas as Classic (no tint, no posterised greens, no outline, no neon night).
  {
    const { context, page, errors } = await openOffice({ width: 1600, height: 900, init: clockAt(13) });
    const r = await page.evaluate(async () => {
      window.requestAnimationFrame = () => 0; await new Promise(res => setTimeout(res, 100));
      const T = Date.now(), R0 = Date; window.Date = class extends R0 { constructor(...a) { if (a.length === 0) super(T); else super(...a); } static now() { return T; } };
      const P = performance.now(); performance.now = () => P;
      const set = async (preset) => {
        window.VOThemeSuite.applyPreset(preset, false); window.VOThemeSuite.setMode('dark', false);
        await new Promise(res => setTimeout(res, 30));
        for (let i = 0; i < 2; i++) { _simLastAt = P; _simAccumulator = 0; _lastDrawAt = -1e9; _sceneDirty = true; _staticLayerForce = true; _renderFrame(P); }
        const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let h = 0; for (let i = 0; i < d.length; i += 4) h = (Math.imul(h, 31) + (d[i] << 16 | d[i + 1] << 8 | d[i + 2])) | 0;
        return { h, night: _nightLevel() };
      };
      const out = {};
      for (const p of ['classic', 'gameboy', 'cyberpunk', 'retro']) out[p] = await set(p);
      out.back = await set('classic');
      return out;
    });
    for (const p of ['gameboy', 'cyberpunk', 'retro', 'back']) assert.equal(r[p].h, r.classic.h, `${p}: the office canvas is drawn as in Classic`);
    assert.ok(Object.values(r).every(o => o.night === 0), `no theme makes it night by day ${JSON.stringify(r)}`);
    assert.deepEqual(errors, [], 'page errors (themes)');
    await context.close();
    pass('themes leave the office as drawn: Gameboy, Cyberpunk and Retro render the same canvas as Classic, no night by day');
  }
} finally {
  await browser.close();
}
console.log(`ALL ${results.length} art-render checks passed`);
