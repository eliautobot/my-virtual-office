// v0.12 click reactions (react builder): furniture reacts to a click, declared per type in the world manifest
// (the one optional field "react") and drawn by the piece's own art; the click plumbing must not break any
// existing click. Headless Chrome on a fixture page (the product's default office plus a floor lamp), fixture
// APIs, seeded Math.random; nothing is written anywhere. WORLD_APP points at another app tree (to show the
// test fails on old code). REACT_ONLY=<word> narrows the run to the checks whose name contains the word.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.WORLD_APP || path.resolve(here, '..', 'app'));
const ONLY = process.env.REACT_ONLY || '';
const require = createRequire(import.meta.url);
function skip(reason) { console.log('SKIP test_v12_react: ' + reason); process.exit(0); }
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
const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
cfg.pet = { enabled: false };
cfg.furniture.push({ id: 'rx_lamp', type: 'floorLamp', x: 420, y: 470 });
const people = Array.from({ length: 3 }, (_, i) => { const id = 'a' + (i + 1); return { id, statusKey: id, name: 'Agent ' + (i + 1), emoji: '🤖', role: 'Tester', providerKind: 'openclaw', color: '#4fc3f7', gender: 'M', branch: 'UNASSIGNED' }; });
const FEATURES = { needsYou: false, interns: false, handoffs: false, visitors: false, alarmClock: false, moods: false, celebrations: false,
  standup: false, seasons: false, tournaments: false, newspaper: false, reactions: true };
const FIX = { '/api/license': { demo: false, valid: true, limits: {} }, '/vo-config': { version: '0.12.0', office: { name: 'React' }, features: {}, weather: { location: null } },
  '/api/agents': { agents: people }, '/status': Object.fromEntries(people.map(p => [p.id, { state: 'working', task: 'testing' }])), '/agent-chat': {}, '/api/office-config': cfg,
  '/weather-proxy': { current_condition: [], configured: false },
  '/api/office-life/state': { ok: true, seq: 1, day: '2026-11-04', tz: 'UTC', settings: { enabled: true, calm: false, timeZone: 'UTC', features: FEATURES },
    open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], cake: false }, paper: { day: '2026-11-04', ready: false } } };

let failed = 0, passed = 0;
const writes = [];
function check(name, ok, detail) { if (ok) passed++; else failed++; console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' | ' + detail : '')); }
async function open(browser, opts) {
  const context = await browser.newContext(opts);
  await context.route('**/*', async (r) => {
    const req = r.request(); const url = new URL(req.url());
    if (url.origin !== ORIGIN) return r.abort();
    if (url.pathname === '/api/office-life/stream') return r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 5000\n\n' });
    if (req.method() !== 'GET' && req.method() !== 'HEAD') { writes.push(req.method() + ' ' + url.pathname); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
    if (Object.prototype.hasOwnProperty.call(FIX, url.pathname)) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX[url.pathname]) });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel); const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) return r.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.addInitScript((seed) => {
    let s = seed >>> 0;
    Math.random = function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }, 21);
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length >= 3 && window.VOLife && window.VOLife.status() === 'ready', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  // Helpers in the page: everything goes through the game's own functions.
  await page.evaluate(() => {
    const T = window.__rxT = {};
    T.item = (id) => officeConfig.furniture.find(f => f.id === id || (id.startsWith('type:') && f.type === id.slice(5) && !(f.rotation || 0)));
    T.spot = (id, dx, dy) => { const it = T.item(id), r = _furnitureRect(it), wx = r.x + r.w / 2 + (dx || 0), wy = r.y + r.h / 2 + (dy || 0), p = _worldToScreen(wx, wy);
      return { x: p.x, y: p.y, agent: !!_agentAtWorld(wx, wy, 0), top: typeof _reactItemAt === 'function' ? (_reactItemAt(wx, wy, false) || {}).id || '' : '', id: it.id }; };
    T.state = (id) => (typeof _rxStateOf === 'function' ? _rxStateOf(T.item(id)) : -1);
    // The piece through its own draw code on a spare canvas (the art's animation tick pinned, so two renders of the
    // same state are equal pixel for pixel): how many pixels have exactly this colour.
    T.count = (id, rgb) => { const it = T.item(id), r = _furnitureRect(it), cv = document.createElement('canvas'); cv.width = r.w + 16; cv.height = r.h + 16;
      const g = cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 8 - Math.floor(r.x), 8 - Math.floor(r.y)); const main = ctx, tick = _weatherTick; ctx = g; _weatherTick = 1000; try { drawFurnitureItem(it, { staticOnly: true }); } finally { ctx = main; _weatherTick = tick; }
      const d = g.getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) n++; return n; };
    T.builds = () => window.__voStats.staticBuilds;
    // Bounding box (in the piece's own box) of the pixels with exactly this colour, drawn by the piece's own code.
    T.bbox = (id, rgb) => { const it = T.item(id), r = _furnitureRect(it), cv = document.createElement('canvas'); cv.width = r.w + 16; cv.height = r.h + 16;
      const g = cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 8 - Math.floor(r.x), 8 - Math.floor(r.y)); const main = ctx, tick = _weatherTick; ctx = g; _weatherTick = 1000; try { drawFurnitureItem(it, { staticOnly: true }); } finally { ctx = main; _weatherTick = tick; }
      const d = g.getImageData(0, 0, cv.width, cv.height).data; let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) { const i = (y * cv.width + x) * 4; if (d[i + 3] === 255 && d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
      return { n, x0: x0 - 8, x1: x1 - 8, y0: y0 - 8, y1: y1 - 8 }; };
    T.entry = (id) => _rxTable.get(_rxKey(T.item(id)));
    T.hash = (id) => { const it = T.item(id), r = _furnitureRect(it), cv = document.createElement('canvas'); cv.width = r.w + 16; cv.height = r.h + 16;
      const g = cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 8 - Math.floor(r.x), 8 - Math.floor(r.y)); const main = ctx, tick = _weatherTick; ctx = g; _weatherTick = 1000; try { drawFurnitureItem(it, { staticOnly: true }); } finally { ctx = main; _weatherTick = tick; }
      const d = g.getImageData(0, 0, cv.width, cv.height).data; let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) | 0; return h; };
    T.look = (id, rgb) => ({ hash: T.hash(id), mark: T.count(id, rgb), info: T.info(id) });
    T.at = (id, t) => { const e = T.entry(id); e.at = performance.now() - t * e.ms; };   // put a playing motion at progress t
    T.info = (id) => { const it = T.item(id), e = T.entry(id) || {}; return { n: e.n || 0, moving: !!e.moving, held: !!e.held, dyn: _isDynamicFurniture(it), busy: _sceneIsBusy(), builds: T.builds() }; };
    T.saved = () => JSON.stringify(officeConfig.furniture);
  });
  return { context, page, errors };
}
const want = (name) => !ONLY || name.includes(ONLY);
const click = async (page, id, opts) => { const s = await page.evaluate(([i]) => window.__rxT.spot(i), [id]); if (s.agent) throw new Error('an agent stands on ' + id);
  if (s.top && s.top !== s.id && !(opts && opts.button)) throw new Error('another reacting piece lies over ' + id + ': ' + s.top); await page.mouse.click(s.x, s.y, opts); await page.waitForTimeout(120); return s; };

// One row per reacting piece of the default office: "mark" = a colour only its reaction look has (the piece's own art).
const PIECES = [
  { type: 'toaster', mark: [255, 112, 67], min: 16, what: 'the bread goes down and the slots glow' },
  { type: 'filingCabinet', mark: [224, 162, 58], min: 15, what: 'a drawer opens (folders inside)' },
  { type: 'trashCan', mark: [189, 182, 166], min: 2, what: 'the paper ball hops out onto the floor' },
  { type: 'bookshelf', mark: [255, 248, 225], min: 10, what: 'a book is pulled out (its pages show)' },
  { type: 'plant', mark: [156, 204, 101], min: 6, what: 'the leaves rustle and one drops onto the pot rim' },
  { type: 'tallPlant', mark: [174, 213, 129], min: 6, what: 'the leaves rustle and one drops onto the pot rim' },
  { type: 'whiteboard', mark: [84, 110, 122], min: 30, what: 'the notes become a diagram', rot0: true },
  { type: 'clock', mark: [255, 202, 40], min: 8, what: 'the cuckoo looks out' },
  { type: 'dartBoard', mark: [255, 179, 0], min: 9, what: 'a dart sticks in the board' },
  { type: 'waterCooler', mark: [79, 195, 247], min: 4, what: 'the jug glugs and a filled cup stands on the tray' },
  { type: 'coffeeMaker', mark: [109, 76, 65], min: 5, what: 'it brews and the cup is full' },
  { type: 'microwave', mark: [255, 229, 127], min: 8, what: 'it runs for a moment and shows END' },
];
async function piece(page, P) {
  const id = 'type:' + P.type, ev = (fn, arg) => page.evaluate(fn, arg);
  const spec = await ev((t) => (FURNITURE_MANIFEST[t] || {}).react || null, P.type);
  check(P.type + ': the manifest declares its reaction', !!spec, JSON.stringify(spec));
  if (!spec) return;
  const live = await ev((t) => !!DYNAMIC_FURNITURE_TYPES[t], P.type), ms = spec.ms || 0;
  // A rebuild asked for by an earlier group (a settings save) must be done before the baseline is read.
  await page.waitForFunction(() => !_staticLayerForce, null, { timeout: 5000 }); await page.waitForTimeout(150);
  const rest = await ev(([i, c]) => window.__rxT.look(i, c), [id, P.mark]);
  await click(page, id);
  const during = await ev((i) => window.__rxT.info(i), id);
  await page.waitForTimeout(ms + 300);
  const after = await ev(([i, c]) => window.__rxT.look(i, c), [id, P.mark]);
  await page.waitForTimeout(400);
  const idle = await ev((i) => window.__rxT.info(i), id);
  check(P.type + ': a click and ' + P.what + ', drawn by its own art', during.n === rest.info.n + 1 && rest.mark === 0 && after.mark >= P.min && after.hash !== rest.hash,
    'mark px ' + rest.mark + ' -> ' + after.mark);
  const most = live ? 0 : ms ? 2 : 1;
  check(P.type + ': ' + (ms ? 'the motion plays in the dynamic pass only, ' : 'no motion, ') + (live ? 'no' : 'at most ' + most) + ' static rebuild(s), none afterwards',
    during.moving === ms > 0 && (live || during.dyn === during.moving) && !after.info.moving && !after.info.dyn === !live && after.info.builds - rest.info.builds <= most && idle.builds === after.info.builds,
    'during ' + JSON.stringify(during) + ', builds +' + (after.info.builds - rest.info.builds) + ' then +' + (idle.builds - after.info.builds));
  if (P.rot0) {
    const turned = await ev((i) => { const it = window.__rxT.item(i), n = (window.__rxT.entry(i) || {}).n || 0, had = Object.prototype.hasOwnProperty.call(it, 'rotation'), old = it.rotation;
      it.rotation = 180; const spec = _rxSpec(it), did = _reactFurniture(it); if (had) it.rotation = old; else delete it.rotation;
      return { spec: !!spec, did, n: ((window.__rxT.entry(i) || {}).n || 0) - n }; }, id);
    check(P.type + ': turned away (its back or side to you) it does not react', !turned.spec && !turned.did && turned.n === 0, JSON.stringify(turned));
  }
  for (let k = 1; k < (spec.states || 1); k++) { await click(page, id); await page.waitForTimeout(ms + 300); }
  if (spec.hold) { await ev((i) => { window.__rxT.entry(i).holdUntil = performance.now() - 1; }, id); await page.waitForTimeout(300); }
  const end = await ev(([i, c]) => window.__rxT.look(i, c), [id, P.mark]);
  check(P.type + ': after ' + (spec.states || 1) + ' click(s)' + (spec.hold ? ' and its time' : '') + ' it looks exactly as before', end.hash === rest.hash && end.mark === 0, 'mark px ' + end.mark);
}

const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
try {
  const { context, page, errors } = await open(browser, { viewport: { width: 1600, height: 900 } });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  if (want('lamp')) {
    const spec = await ev(() => (FURNITURE_MANIFEST.floorLamp || {}).react || null);
    check('lamp: the manifest declares its reaction (react.states = 2)', !!spec && spec.states === 2, JSON.stringify(spec));
    const fit = await ev(() => _placementProblem('floorLamp', 420, 470, 0, ['rx_lamp']));
    check('lamp: the fixture lamp stands on free floor', fit === '', String(fit));
    const WARM = [255, 243, 207], saved0 = await ev(() => window.__rxT.saved());
    const on0 = await ev((c) => window.__rxT.count('rx_lamp', c), WARM);
    const b0 = await ev(() => window.__rxT.builds()); await page.waitForTimeout(700); const b1 = await ev(() => window.__rxT.builds());
    await click(page, 'rx_lamp'); await page.waitForTimeout(600);
    const b2 = await ev(() => window.__rxT.builds()); await page.waitForTimeout(700); const b3 = await ev(() => window.__rxT.builds());
    const st1 = await ev(() => window.__rxT.state('rx_lamp')), off1 = await ev((c) => window.__rxT.count('rx_lamp', c), WARM);
    check('lamp: a click switches it off, drawn by its own art (warm rim gone)', st1 === 1 && on0 >= 16 && off1 === 0, 'state ' + st1 + ', warm rim px ' + on0 + ' -> ' + off1);
    check('lamp: one static layer rebuild for the click, none per frame', b1 - b0 === 0 && b2 - b1 === 1 && b3 - b2 === 0, 'builds idle ' + (b1 - b0) + ', click ' + (b2 - b1) + ', after ' + (b3 - b2));
    await click(page, 'rx_lamp');
    const st2 = await ev(() => window.__rxT.state('rx_lamp')), on2 = await ev((c) => window.__rxT.count('rx_lamp', c), WARM);
    check('lamp: a second click switches it on again', st2 === 0 && on2 === on0, 'state ' + st2 + ', warm rim px ' + on2);
    check('lamp: nothing is saved or sent (the layout is unchanged, no write request)', (await ev(() => window.__rxT.saved())) === saved0 && writes.length === 0, writes.join(', '));
  }
  if (want('clicks')) {
    const st = () => ev(() => window.__rxT.state('rx_lamp'));
    const s0 = await st();
    // An agent: its menu opens. With the menu open, a click on the lamp only closes the menu.
    const a = await ev(() => { const a = agents.find(x => x.isSitting) || agents[0], b = _characterBodyRect(a), wx = b.x + b.w / 2, wy = b.y + b.h / 2, p = _worldToScreen(wx, wy);
      return { id: a.id, x: p.x, y: p.y, hit: (_agentAtWorld(wx, wy, 0) || {}).id || '' }; });
    await page.mouse.click(a.x, a.y); await page.waitForTimeout(200);
    const menu = await ev(() => (_agentMenu.agent && _agentMenu.el && !_agentMenu.el.hidden) ? _agentMenu.agent.id : '');
    check('clicks: an agent still opens its menu', menu === a.id, 'menu of "' + menu + '", body hit "' + a.hit + '"');
    await click(page, 'rx_lamp');
    const closed = await ev(() => !_agentMenu.agent && (!_agentMenu.el || _agentMenu.el.hidden));
    check('clicks: with a menu open, a click on the lamp only closes the menu', menu === a.id && closed && (await st()) === s0, 'closed ' + closed + ', lamp state ' + (await st()));
    const s1 = await st();
    // A drag (panning) over the lamp and a right click are not clicks on it.
    const sp = await ev(() => window.__rxT.spot('rx_lamp'));
    await page.mouse.move(sp.x, sp.y); await page.mouse.down(); await page.mouse.move(sp.x + 40, sp.y + 10, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(150);
    check('clicks: dragging the office across the lamp does not switch it', (await st()) === s1, 'state ' + (await st()));
    await ev(() => { if (typeof resetCamera === 'function') resetCamera(); }); await page.waitForTimeout(500);
    await click(page, 'rx_lamp', { button: 'right' });
    check('clicks: a right click does not switch it', (await st()) === s1, 'state ' + (await st()));
    // The desk monitor opens the Agent PC; a right click on a desk opens the workspace menu.
    const desk = await ev(() => {
      window.__pc = []; window.__ws = [];
      const hub = window.VirtualOfficePreviews || (window.VirtualOfficePreviews = {}); hub.openPC = (k) => { window.__pc.push(k); };
      const real = window._showAgentWorkspaceMenu; window._showAgentWorkspaceMenu = function (d) { window.__ws.push(d.id); };
      const d = officeConfig.furniture.find(f => _isDeskItem(f) && _getDeskAgent(f)); if (!d) return null;
      const m = _deskMonitorRects(d)[0], wx = d.x + m.bx + m.bw / 2, wy = d.y + m.by + m.bh / 2, p = _worldToScreen(wx, wy), q = _worldToScreen(d.x - 26, d.y - 8);
      return { id: d.id, x: p.x, y: p.y, agent: !!_agentAtWorld(wx, wy, 0), dx: q.x, dy: q.y };
    });
    await page.mouse.click(desk.x, desk.y); await page.waitForTimeout(150);
    check('clicks: the desk monitor still opens the Agent PC', !desk.agent && (await ev(() => window.__pc.length)) === 1, JSON.stringify(await ev(() => window.__pc)));
    await page.mouse.click(desk.dx, desk.dy, { button: 'right' }); await page.waitForTimeout(150);
    check('clicks: a right click on a desk still opens its workspace menu', (await ev(() => window.__ws[0])) === desk.id, JSON.stringify(await ev(() => window.__ws)));
    await ev(() => _closeAgentMenu());
    // A window lying over the office takes the click.
    await ev((s) => { const w = document.createElement('div'); w.id = 'rx-win'; w.style.cssText = 'position:fixed;z-index:99999;background:#fff;left:' + (s.x - 60) + 'px;top:' + (s.y - 60) + 'px;width:120px;height:120px'; document.body.appendChild(w); }, sp);
    await page.mouse.click(sp.x, sp.y); await page.waitForTimeout(150);
    check('clicks: a click on a window over the lamp does not reach it', (await st()) === s1, 'state ' + (await st()));
    await ev(() => document.getElementById('rx-win').remove());
    // Edit mode: no reactions; the piece shows its normal look there.
    if ((await st()) !== 1) await click(page, 'rx_lamp');
    const offNow = await st(), n0 = await ev(() => _rxTable.get(_rxKey(window.__rxT.item('rx_lamp'))).n);
    await ev(() => toggleEditMode()); await page.waitForFunction(() => editMode === true, null, { timeout: 15000 }); await page.waitForTimeout(300);
    const warmEdit = await ev(() => window.__rxT.count('rx_lamp', [255, 243, 207]));
    const ep = await ev(() => window.__rxT.spot('rx_lamp')); await page.mouse.click(ep.x, ep.y); await page.waitForTimeout(200);
    const inEdit = await ev(() => { const e = _rxTable.get(_rxKey(window.__rxT.item('rx_lamp'))); return e ? e.n : -1; });
    await ev(() => { selectedItemId = null; toggleEditMode(); }); await page.waitForFunction(() => editMode === false, null, { timeout: 15000 }); await page.waitForTimeout(300);
    check('clicks: edit mode has no reactions (normal look, a click selects, nothing toggles)', offNow === 1 && warmEdit === 16 && inEdit === n0 && (await st()) === 1, 'off before ' + offNow + ', warm px in edit ' + warmEdit + ', clicks counted ' + inEdit + ', after ' + (await st()));
    // The switch: off = no reaction and every piece back to normal; on again = a fresh start.
    await ev(() => { const s = window.VOLife.settings(); s.features.reactions = false; window.VOLife.applySettings(s); }); await page.waitForTimeout(300);
    const cleared = await ev(() => _rxTable.size), warmOff = await ev(() => window.__rxT.count('rx_lamp', [255, 243, 207]));
    await click(page, 'rx_lamp');
    check('switch: "reactions" off = nothing reacts and every piece is back to normal', cleared === 0 && warmOff === 16 && (await ev(() => _rxTable.size)) === 0, 'entries ' + cleared + ', warm px ' + warmOff);
    await ev(() => { const s = window.VOLife.settings(); s.features.reactions = true; window.VOLife.applySettings(s); }); await page.waitForTimeout(200);
    await click(page, 'rx_lamp');
    check('switch: on again, the lamp reacts', (await st()) === 1, 'state ' + (await st()));
    await click(page, 'rx_lamp');
  }
  if (want('night')) {
    // The night light map (the real _nightLightMapCanvas): light round the lamp when on, none from it when off.
    await ev(() => { window.__rxT.lum = (id, dx, dy) => { const m = _nightLightMapCanvas(1), s = LIGHT_MAP_SCALE, it = window.__rxT.item(id);
      const d = m.getContext('2d').getImageData(Math.round((it.x + dx) * s) - 2, Math.round((it.y + dy) * s) - 2, 5, 5).data; let t = 0;
      for (let i = 0; i < d.length; i += 4) t += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; return Math.round(t / 25); }; });
    if ((await ev(() => window.__rxT.state('rx_lamp'))) !== 0) await click(page, 'rx_lamp');
    const read = () => ev(() => ({ near: window.__rxT.lum('rx_lamp', 0, -16), floor: window.__rxT.lum('rx_lamp', 30, 10), ver: _nightStateVer }));
    for (const look of ['lit', 'dim']) {   // Settings > General night look: lights on (default) and dim
      await ev((l) => { _displayPrefs.nightLook = l; }, look);
      const on = await read(); await click(page, 'rx_lamp');
      const off = await read(); await click(page, 'rx_lamp');
      const back = await read(), need = look === 'dim' ? 20 : 1;
      check('night (' + look + ' look): a lamp clicked off gives no light in the night light map, on again it does',
        on.near - off.near >= need && on.floor - off.floor >= need && off.ver !== on.ver && back.near === on.near && back.floor === on.floor,
        'lamp ' + on.near + ' -> ' + off.near + ' -> ' + back.near + ', floor beside it ' + on.floor + ' -> ' + off.floor + ' -> ' + back.floor);
    }
    await ev(() => { _displayPrefs.nightLook = 'lit'; });
  }
  if (want('tv')) {
    // TV: off while nobody watches; each click = the next channel (5 of them), the 6th click = as before.
    // Channel backgrounds are the art's own colours: sports green, news blue, cooking orange, cartoon sky, movie grey.
    const BG = [[46, 125, 50], [21, 101, 192], [255, 143, 0], [225, 245, 254], [55, 71, 79]], OFFGLASS = [28, 37, 48];
    const tvId = 'type:tv', b0 = await ev(() => window.__rxT.builds());
    const seen = [], offBefore = await ev((c) => window.__rxT.count('type:tv', c), OFFGLASS);
    for (let k = 0; k < 6; k++) {
      await click(page, tvId);
      const during = await ev(() => { const it = window.__rxT.item('type:tv'); return { moving: _rxIsMoving(it), busy: _sceneIsBusy() }; });
      await page.waitForTimeout(450);
      const px = await ev((bg) => bg.map(c => window.__rxT.count('type:tv', c)), BG);
      seen.push({ state: await ev(() => window.__rxT.state('type:tv')), ch: px.indexOf(Math.max(...px)), max: Math.max(...px), during });
    }
    const offAfter = await ev((c) => window.__rxT.count('type:tv', c), OFFGLASS);
    check('tv: clicks go through the 5 channels in order, each drawn by the TV art',
      seen.slice(0, 5).every((s, i) => s.state === i + 1 && s.ch === i && s.max >= 100), seen.map(s => s.state + ':ch' + s.ch + '(' + s.max + 'px)').join(' '));
    check('tv: a short burst of static plays in the dynamic pass (the scene draws at full rate meanwhile)', seen.every(s => s.during.moving && s.during.busy), JSON.stringify(seen[0].during));
    check('tv: the 6th click = as before (off while nobody watches)', seen[5].state === 0 && offBefore > 300 && offAfter === offBefore, 'off glass px ' + offBefore + ' -> ' + offAfter);
    check('tv: no static layer rebuild at all (the TV is drawn live)', (await ev(() => window.__rxT.builds())) === b0, 'builds +' + ((await ev(() => window.__rxT.builds())) - b0));
    await click(page, tvId); await page.waitForTimeout(400);
    const night = await ev(() => { _nightStateAt = 0; _nightRefreshState(); return _nightTvOn.slice(); });
    for (let k = 0; k < 5; k++) { await click(page, tvId); await page.waitForTimeout(300); }
    const nightOff = await ev(() => { _nightStateAt = 0; _nightRefreshState(); return _nightTvOn.slice(); });
    check('tv: switched on by a click it lights the room at night like a watched TV, off again it does not', night[0] === true && nightOff[0] === false, JSON.stringify(night) + ' -> ' + JSON.stringify(nightOff));
  }
  if (want('vending')) {
    // Vending machine: shakes, then a can drops into the tray and lies there for a while. Motion = dynamic pass only.
    const V = 'type:vendingMachine', PANEL = [163, 21, 21], CAN = [229, 57, 53];
    const i0 = await ev((v) => window.__rxT.info(v), V), rest = await ev(([v, c]) => window.__rxT.bbox(v, c), [V, PANEL]);
    await click(page, V);
    const i1 = await ev((v) => window.__rxT.info(v), V);
    const shakeA = await ev(([v, c]) => { window.__rxT.at(v, 0.12); return window.__rxT.bbox(v, c); }, [V, PANEL]);
    const shakeB = await ev(([v, c]) => { window.__rxT.at(v, 0.17); return window.__rxT.bbox(v, c); }, [V, PANEL]);
    const canEarly = await ev(([v, c]) => { window.__rxT.at(v, 0.3); return window.__rxT.bbox(v, c).n; }, [V, CAN]);
    const canMid = await ev(([v, c]) => { window.__rxT.at(v, 0.7); return window.__rxT.bbox(v, c); }, [V, CAN]);
    await click(page, V);   // a click while it plays is absorbed
    const i2 = await ev((v) => { window.__rxT.at(v, 0.75); return window.__rxT.info(v); }, V);
    await page.waitForTimeout(700);
    const i3 = await ev((v) => window.__rxT.info(v), V), canRest = await ev(([v, c]) => window.__rxT.bbox(v, c), [V, CAN]), still = await ev(([v, c]) => window.__rxT.bbox(v, c), [V, PANEL]);
    check('vending: a click starts the motion; the machine is drawn in the dynamic pass while it plays', i1.n === 1 && i1.moving && i1.dyn && i1.busy && !i0.dyn, JSON.stringify(i1));
    check('vending: it shakes 1 px left and right, drawn by its own art', shakeA.x0 === rest.x0 - 1 && shakeB.x0 === rest.x0 + 1 && shakeA.n === rest.n, 'panel x ' + rest.x0 + ' -> ' + shakeA.x0 + ' / ' + shakeB.x0);
    check('vending: the can drops into the tray after the shake', canEarly === 0 && canMid.n > 0 && canRest.n === 14 && canMid.y0 <= canRest.y0, 'can px ' + canEarly + ' -> ' + canMid.n + ' -> ' + canRest.n + ', rows ' + canMid.y0 + ' -> ' + canRest.y0);
    check('vending: a click while it plays is absorbed', i2.n === 1 && i2.moving, 'clicks counted ' + i2.n);
    check('vending: after the motion it is static again with the can in the tray; 2 static rebuilds in all (start, end)',
      !i3.moving && i3.held && !i3.dyn && still.x0 === rest.x0 && i3.builds - i0.builds === 2, 'builds +' + (i3.builds - i0.builds) + ', ' + JSON.stringify(i3));
    await page.waitForTimeout(500);
    const i4 = await ev((v) => { const r = window.__rxT.info(v); window.__rxT.entry(v).holdUntil = performance.now() - 1; return r; }, V);
    await page.waitForTimeout(300);
    const i5 = await ev((v) => window.__rxT.info(v), V), canGone = await ev(([v, c]) => window.__rxT.bbox(v, c).n, [V, CAN]);
    check('vending: the can is gone when its time is up (1 more rebuild, none while it lies there)', i4.builds === i3.builds && !i5.held && canGone === 0 && i5.builds - i4.builds === 1, 'builds +' + (i4.builds - i3.builds) + ' then +' + (i5.builds - i4.builds));
    // Reduced motion, then Calm mode: the state changes (the can appears), nothing shakes, nothing is dynamic.
    for (const mode of ['reduced motion', 'Calm mode']) {
      if (mode === 'reduced motion') await page.emulateMedia({ reducedMotion: 'reduce' });
      else await ev(() => { const s = window.VOLife.settings(); s.calm = true; window.VOLife.applySettings(s); });
      await page.waitForTimeout(250);
      const q0 = await ev((v) => window.__rxT.info(v), V); await click(page, V);
      const q1 = await ev((v) => window.__rxT.info(v), V), can = await ev(([v, c]) => window.__rxT.bbox(v, c).n, [V, CAN]), pan = await ev(([v, c]) => window.__rxT.bbox(v, c), [V, PANEL]);
      check('vending (' + mode + '): the can appears, no shake, never dynamic', q1.n === q0.n + 1 && !q1.moving && !q1.dyn && q1.held && can === 14 && pan.x0 === rest.x0, JSON.stringify(q1) + ', can px ' + can);
      await ev((v) => { window.__rxT.entry(v).holdUntil = performance.now() - 1; }, V); await page.waitForTimeout(250);
      if (mode === 'reduced motion') await page.emulateMedia({ reducedMotion: 'no-preference' });
      else await ev(() => { const s = window.VOLife.settings(); s.calm = false; window.VOLife.applySettings(s); });
    }
  }
  if (want('agent')) {
    // Agents: only the hook and the "Wave" menu entry today (the poses come later). Nothing visible changes.
    await ev(() => _closeAgentMenu());
    const hook = await ev(() => typeof _reactAgent === 'function');
    check('agent: the hook _reactAgent(agent, kind) exists', hook);
    const a = await ev(() => { const a = agents.find(x => x.isSitting) || agents[0], b = _characterBodyRect(a), p = _worldToScreen(b.x + b.w / 2, b.y + b.h / 2); delete a._react; return { id: a.id, x: p.x, y: p.y }; });
    await page.mouse.click(a.x, a.y); await page.waitForTimeout(250);
    const r1 = await ev((id) => { const a = agents.find(x => x.id === id); return { react: a._react ? { kind: a._react.kind, n: a._react.n } : null, menu: !!(_agentMenu.agent === a && !_agentMenu.el.hidden),
      wave: Array.from(_agentMenu.el.querySelectorAll('[data-action]')).map(b => b.dataset.action), label: (_agentMenu.el.querySelector('[data-action="wave"] strong') || {}).textContent || '',
      icon: !!document.getElementById('i-wave') }; }, a.id);
    check('agent: a click on a character calls the hook and still opens its menu', !!r1.react && r1.react.kind === 'click' && r1.react.n === 1 && r1.menu, JSON.stringify(r1.react) + ', menu ' + r1.menu);
    check('agent: the menu has a "Wave" entry with its pixel icon', r1.wave.includes('wave') && r1.label === 'Wave' && r1.icon, r1.wave.join(','));
    if (r1.wave.includes('wave')) await page.click('#' + (await ev(() => _agentMenu.el.id || (_agentMenu.el.id = 'rx-menu'))) + ' [data-action="wave"]');
    await page.waitForTimeout(200);
    const r2 = await ev((id) => { const a = agents.find(x => x.id === id); return { react: a._react ? { kind: a._react.kind, n: a._react.n } : null, closed: !_agentMenu.agent,
      again: typeof _reactAgent === 'function' ? _reactAgent(a, 'wave') : null, n: a._react ? a._react.n : 0 }; }, a.id);
    check('agent: "Wave" calls the hook with kind "wave" and closes the menu', !!r2.react && r2.react.kind === 'wave' && r2.react.n === 2 && r2.closed, JSON.stringify(r2.react) + ', closed ' + r2.closed);
    check('agent: rate-limited (a second wave at once is refused)', r2.again === false && r2.n === 2, 'again ' + r2.again + ', n ' + r2.n);
    const r3 = await ev((id) => { const a = agents.find(x => x.id === id), saved = JSON.stringify(officeConfig.agents || []);
      const s = window.VOLife.settings(); s.features.reactions = false; window.VOLife.applySettings(s);
      a._react.at = -1e9; const off = _reactAgent(a, 'wave'), entries = _agentMenuActions(a).more.map(d => d.key);
      s.features.reactions = true; window.VOLife.applySettings(s);
      return { off, entries, saved: saved === JSON.stringify(officeConfig.agents || []) }; }, a.id);
    check('agent: switch off = the hook does nothing and the menu has no "Wave"', r3.off === false && !r3.entries.includes('wave') && r3.saved, 'hook ' + r3.off + ', more: ' + r3.entries.join(','));
    check('agent: nothing was sent', writes.length === 0, writes.join(', '));
  }
  for (const P of PIECES) if (want(P.type)) await piece(page, P);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' ; '));
  await context.close();
  if (want('phone')) {
    // Phone 412x915: a tap reacts (44 px finger target, the nearest piece wins), a swipe and a two-finger pinch do not.
    const ph = await open(browser, { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const pev = (fn, arg) => ph.page.evaluate(fn, arg), st = () => pev(() => window.__rxT.state('rx_lamp'));
    await pev(() => { const T = window.__rxT;
      T.focus = (wx, wy, zoom) => { _applyCameraView({ x: wx - W / 2, y: wy - H / 2, zoom: zoom || camera.zoom }, false); };
      T.focusItem = (id, zoom) => { const r = _furnitureRect(T.item(id)); T.focus(r.x + r.w / 2, r.y + r.h / 2, zoom); };
      T.focusItem('rx_lamp'); });
    await ph.page.waitForTimeout(400);
    const sp = await pev(() => { const s = window.__rxT.spot('rx_lamp'), el = document.elementFromPoint(s.x, s.y); return Object.assign(s, { canvas: !!el && el.id === canvas.id, scale: getBaseScale() * camera.zoom }); });
    await ph.page.touchscreen.tap(sp.x, sp.y); await ph.page.waitForTimeout(250);
    const t1 = await st();
    check('phone: a tap on the lamp switches it', sp.canvas && !sp.agent && t1 === 1, 'state ' + t1 + ', canvas under the finger ' + sp.canvas + ', scale ' + sp.scale.toFixed(2));
    // Beside the lamp, inside its finger target: a mouse click there finds nothing, a tap finds the lamp.
    const near = await pev(() => { const it = window.__rxT.item('rx_lamp'), r = _furnitureRect(it), k = getBaseScale() * camera.zoom, wx = r.x + r.w + 9 / k, wy = r.y + r.h / 2, p = _worldToScreen(wx, wy);
      return { x: p.x, y: p.y, mouse: (_reactItemAt(wx, wy, false) || {}).id || '', touch: (_reactItemAt(wx, wy, true) || {}).id || '', agent: !!_agentAtWorld(wx, wy, 44) }; });
    await ph.page.touchscreen.tap(near.x, near.y); await ph.page.waitForTimeout(250);
    const t2 = await st();
    check('phone: a tap just beside the lamp (inside its 44 px finger target) still reaches it', near.mouse === '' && near.touch === 'rx_lamp' && !near.agent && t2 === 0, 'mouse "' + near.mouse + '", touch "' + near.touch + '", state ' + t2);
    const cdp = await ph.context.newCDPSession(ph.page), touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: Math.round(p[0]), y: Math.round(p[1]), id: p[2] == null ? i : p[2] })) });
    // One-finger swipe (panning) that starts on the lamp.
    await touch('touchStart', [[sp.x, sp.y]]); for (const d of [15, 30, 45, 60]) { await touch('touchMove', [[sp.x + d, sp.y + d / 3]]); await ph.page.waitForTimeout(20); } await touch('touchEnd', []);
    await ph.page.waitForTimeout(200);
    check('phone: a swipe that starts on the lamp does not switch it', (await st()) === t2, 'state ' + (await st()));
    await pev(() => window.__rxT.focusItem('rx_lamp', (getMinZoom() + getMaxZoom()) / 2)); await ph.page.waitForTimeout(400);
    // Two-finger pinch over the lamp (from half way between the zoom limits); the fingers lift one after the other.
    const z0 = await pev(() => camera.zoom), sp2 = await pev(() => window.__rxT.spot('rx_lamp'));
    await touch('touchStart', [[sp2.x - 20, sp2.y], [sp2.x + 20, sp2.y]]);
    for (const d of [30, 45, 60, 75]) { await touch('touchMove', [[sp2.x - d, sp2.y], [sp2.x + d, sp2.y]]); await ph.page.waitForTimeout(20); }
    const z1 = await pev(() => camera.zoom);
    await touch('touchEnd', [[sp2.x - 75, sp2.y, 0]]); await ph.page.waitForTimeout(30); await touch('touchEnd', []); await ph.page.waitForTimeout(200);
    check('phone: a two-finger pinch over the lamp zooms and does not switch it', z1 > z0 * 1.2 && (await st()) === t2, 'zoom ' + z0.toFixed(2) + ' -> ' + z1.toFixed(2) + ', state ' + (await st()));
    await pev(() => { const a = agents.find(x => x.isSitting) || agents[0], b = _characterBodyRect(a); window.__rxT.focus(b.x + b.w / 2, b.y + b.h / 2); }); await ph.page.waitForTimeout(400);
    // An agent still opens its sheet on a tap.
    const pa = await pev(() => { const a = agents.find(x => x.isSitting) || agents[0], b = _characterBodyRect(a), p = _worldToScreen(b.x + b.w / 2, b.y + b.h / 2); return { id: a.id, x: p.x, y: p.y }; });
    await ph.page.touchscreen.tap(pa.x, pa.y); await ph.page.waitForTimeout(300);
    check('phone: a tap on an agent still opens its menu', (await pev(() => (_agentMenu.agent || {}).id || '')) === pa.id, 'menu of "' + (await pev(() => (_agentMenu.agent || {}).id || '')) + '"');
    check('phone: no page errors', ph.errors.length === 0, ph.errors.slice(0, 3).join(' ; '));
    await ph.context.close();
  }
} finally { await browser.close(); }
console.log((failed ? 'FAILED' : 'OK') + ' test_v12_react: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
