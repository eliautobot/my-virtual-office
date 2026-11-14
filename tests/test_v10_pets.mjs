// Pet art regression test (v0.10.1 pets redo).
//
// Hermetic: headless Chrome through playwright-core, every request answered
// from app/ files and fixed fixtures, nothing saved. Draws the cat, the pug and
// the lobster in every state and direction into private canvases (the global
// ctx swapped) and checks pixels, bounds, facing, caching and the name tag.
//
// Run: node tests/test_v10_pets.mjs
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
  console.log(`SKIP test_v10_pets: ${reason}`);
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
OFFICE.pet = { enabled: true, species: 'lobster', name: 'Clawy' };
const FIXTURES = {
  '/api/license': { demo: false, valid: true, limits: {} },
  '/vo-config': { version: '0.10.1', office: { name: 'Pet Test' }, features: {}, weather: { location: null } },
  '/api/agents': { agents: [
    { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true },
  ] },
  '/status': { alpha: { state: 'idle', task: '' } },
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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.agents && window.agents.length > 0 && window.VOOffice, null, { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__pets = {
      canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
      withCtx(g, fn) { const saved = window.ctx; window.ctx = g; try { return fn(); } finally { window.ctx = saved; } },
      // Every state the pet state machine has, in every direction it can face.
      cases() {
        const out = [];
        const states = ['sitting', 'walking', 'walking_to_sleep', 'walking_to_greet', 'walking_to_curious', 'sleeping', 'grooming',
          'looking_around', 'being_pet', 'chased'];
        ['cat', 'pug', 'lobster'].forEach(sp => states.forEach(st => [1, -1].forEach(fd => ['side', 'up', 'down'].forEach(md =>
          [false, true].forEach(mv => [0, 5, 10, 15, 50].forEach(t => out.push({ sp, st, fd, md, mv, t, blink: t === 50 })))))));
        return out;
      },
      draw(g, sp, o, x, y) {
        const pet = new OfficePet({ species: sp, name: 'Pet', x, y });
        Object.assign(pet, { state: o.st, faceDir: o.fd, moveDir: o.md, isMoving: o.mv, tick: o.t, _blinking: !!o.blink,
          sleepZ: 0.3, curiosityTarget: o.st === 'looking_around' ? { x: 0, y: 0 } : null });
        pet.x = x; pet.y = y;
        let r = null;
        this.withCtx(g, () => { r = pet._artPose(); pet.draw(); });
        return r;
      },
    };
  });

  await check('every pet state x direction draws a sprite inside its bounds, no errors, no system font', async () => {
    const r = await page.evaluate(() => {
      const bad = []; let n = 0; const fonts = [];
      const proto = CanvasRenderingContext2D.prototype, orig = proto.fillText;
      proto.fillText = function () { fonts.push(this.font); return orig.apply(this, arguments); };
      try {
        for (const o of __pets.cases()) {
          n++;
          const c = __pets.canvas(120, 120), g = c.getContext('2d');
          let pose;
          try { pose = __pets.draw(g, o.sp, o, 60, 80); } catch (e) { bad.push(o.sp + '/' + o.st + ' threw ' + e.message); continue; }
          const def = PET_ART[o.sp][pose[0]];
          const ax = pose[2] ? def.w - 1 - def.ax : def.ax, left = 60 - ax - 1, top = 80 + PET_FOOT - (def.h - 1);
          const d = g.getImageData(0, 0, 120, 120).data;
          let inside = 0, outside = 0;
          for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
            if (d[(y * 120 + x) * 4 + 3] < 200) continue;
            if (x >= left && x < left + def.w + 3 && y >= top && y < top + def.h + 2) inside++;
            else if (y > 80 + PET_FOOT + 2) outside++; // effects and the tag sit above, never below the feet
          }
          if (inside < 40 || outside) bad.push(o.sp + '/' + o.st + '/' + pose.join(':') + ' inside ' + inside + ' below ' + outside);
        }
      } finally { proto.fillText = orig; }
      return { n, bad: bad.slice(0, 6), nbad: bad.length, fonts: fonts.slice(0, 3) };
    });
    assert.ok(r.n >= 1800, 'cases ' + r.n);
    assert.deepEqual(r.bad, [], r.nbad + ' bad cases');
    assert.deepEqual(r.fonts, [], 'fillText used: ' + r.fonts.join(' / '));
  });

  await check('each state maps to the intended pose; walking left mirrors walking right; sleep faces faceDir', async () => {
    const r = await page.evaluate(() => {
      const P = (st, extra) => { const p = new OfficePet({ species: 'cat', x: 0, y: 0 }); Object.assign(p, { state: st, isMoving: false, moveDir: 'side', faceDir: 1, tick: 0 }, extra); return p._artPose().join(':'); };
      const head = (sp, fd) => { const p = new OfficePet({ species: sp, x: 0, y: 0 }); Object.assign(p, { state: 'sleeping', faceDir: fd, tick: 0 });
        const def = PET_ART[sp].sleep, pose = p._artPose(); return (pose[2] ? def.w - 1 - def.head[0] : def.head[0]) - (pose[2] ? def.w - 1 - def.ax : def.ax); };
      return {
        poses: [P('sitting'), P('being_pet'), P('grooming', { faceDir: -1 }), P('looking_around'), P('sleeping', { faceDir: -1 }),
          P('walking', { isMoving: true, tick: 5 }), P('walking', { isMoving: true, faceDir: -1, tick: 10 }), P('walking', { isMoving: true, moveDir: 'up' }),
          P('walking_to_greet', { isMoving: true, moveDir: 'down', tick: 15 }), P('chased', { isMoving: true, tick: 3 }), P('walking')],
        heads: ['cat', 'pug', 'lobster'].map(sp => [head(sp, 1) > 0, head(sp, -1) < 0]),
        species: Object.keys(PET_ART).sort(), poses2: Object.keys(PET_ART.lobster).filter(k => k[0] !== '_').sort(),
      };
    });
    assert.deepEqual(r.poses, ['sit:0:false', 'pet:0:false', 'groom:0:true', 'look:0:false', 'sleep:0:true', 'walkR:1:false', 'walkR:2:true',
      'walkU:0:false', 'walkD:3:false', 'walkR:1:false', 'walkR:0:false']);
    assert.deepEqual(r.heads, [[true, true], [true, true], [true, true]], 'sleeping head on the faced side');
    // v0.12 added five species (PET_SPECIES); the three originals keep their ids.
    assert.deepEqual(r.species, ['bunny', 'cat', 'corgi', 'duck', 'fox', 'lobster', 'pug', 'turtle']);
    // v0.12 added the trick pose (tests/test_v12_pets_tricks.mjs).
    assert.deepEqual(r.poses2, ['groom', 'look', 'pet', 'sit', 'sleep', 'trick', 'walkD', 'walkR', 'walkU']);
  });

  await check('walk cycles move: the 4 walk frames differ in every direction (lobster claws swing)', async () => {
    const r = await page.evaluate(() => {
      const out = [];
      ['cat', 'pug', 'lobster'].forEach(sp => ['walkR', 'walkD', 'walkU'].forEach(pn => {
        const keys = [0, 1, 2, 3].map(f => _petGrid(sp, pn, f).map(row => row.join('')).join('/'));
        if (new Set(keys).size < 3) out.push(sp + ' ' + pn + ' ' + new Set(keys).size);
      }));
      // Lobster side walk: the claw rows change between frames.
      const claw = f => _petGrid('lobster', 'walkR', f).map(row => row.slice(20).join('')).join('/');
      if (claw(0) === claw(1)) out.push('lobster claw still');
      return out;
    });
    assert.deepEqual(r, []);
  });

  await check('sprites are cached per pose and device scale, crisp (whole pixels) at 3x, lit from the top-left', async () => {
    const r = await page.evaluate(() => {
      const c1 = _petSprite('lobster', 'walkR', 0, false, 3), c2 = _petSprite('lobster', 'walkR', 0, false, 3);
      const d = c1.getContext('2d').getImageData(0, 0, c1.width, c1.height).data, W = c1.width;
      let blocky = 0, cells = 0, partial = 0;
      for (let y = 0; y + 3 <= c1.height; y += 3) for (let x = 0; x + 3 <= W; x += 3) {
        const i0 = (y * W + x) * 4; cells++; let same = true;
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) { const i = ((y + dy) * W + x + dx) * 4; for (let k = 0; k < 4; k++) if (d[i + k] !== d[i0 + k]) same = false; }
        if (same) blocky++;
        if (d[i0 + 3] && d[i0 + 3] < 255 && Math.abs(d[i0 + 3] - 51) > 2) partial++;
      }
      // Light: the carapace's top rim is lighter than its body, its bottom edge darker.
      const px = (gx, gy) => { const i = ((gy * 3) * W + (gx + 1) * 3) * 4; return d[i] + d[i + 1] + d[i + 2]; };
      return { same: c1 === c2, size: [c1.width, c1.height], blocky, cells, partial, top: px(17, 6), mid: px(17, 8), bottom: px(17, 11) };
    });
    assert.ok(r.same, 'not cached');
    assert.deepEqual(r.size, [(28 + 3) * 3, (16 + 2) * 3]);
    assert.equal(r.blocky, r.cells, 'every sprite pixel is a solid 3x3 block');
    assert.equal(r.partial, 0, 'only the 20% shadow is translucent');
    assert.ok(r.top > r.mid && r.mid > r.bottom, 'top rim ' + r.top + ' body ' + r.mid + ' bottom edge ' + r.bottom);
  });

  await check('name tag keeps one on-screen size when zoomed in and shrinks with the office when zoomed out', async () => {
    const r = await page.evaluate(() => {
      const tagH = s => {
        const c = __pets.canvas(400, 400), g = c.getContext('2d'); g.translate(200, 300); g.scale(s, s);
        let h = null; const di = g.drawImage.bind(g);
        g.drawImage = function (img) { if (img && img._w) h = arguments[4] * s; return di.apply(null, arguments); };
        __pets.withCtx(g, () => { const p = new OfficePet({ species: 'pug', name: 'Biscuit', x: 0, y: 0 }); Object.assign(p, { state: 'sitting', tick: 0 }); p.x = 0; p.y = 0; p.draw(); });
        return h;
      };
      return [tagH(0.5), tagH(1), tagH(3)];
    });
    assert.equal(r[0], 5.5, 'half zoom ' + JSON.stringify(r));
    assert.equal(r[1], 11, JSON.stringify(r));
    assert.equal(r[2], 11 * Math.max(1, Math.round(await page.evaluate(() => window.devicePixelRatio || 1))));
  });

  await check('live office: pets of every species update and draw in the real loop; petting and chasing still work', async () => {
    const r = await page.evaluate(async () => {
      const out = [];
      for (const sp of ['cat', 'pug', 'lobster']) {
        officeConfig.pet = { enabled: true, species: sp, name: 'P-' + sp };
        initPets();
        const pet = officePets[0];
        for (let i = 0; i < 400; i++) { updatePets(); }
        const a = agents[0];
        pet.state = 'sitting'; pet.startBeingPet(a);
        const petted = pet._artPose()[0];
        pet.startChase(a); for (let i = 0; i < 20; i++) updatePets();
        out.push([sp, pet.species, officePets.length, petted, pet.state, isFinite(pet.x) && isFinite(pet.y)].join(','));
        await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      }
      officeConfig.pet = { enabled: true, species: 'lobster', name: 'Clawy' }; initPets();
      return out;
    });
    assert.deepEqual(r.map(s => s.split(',').slice(0, 4).concat(s.split(',')[5]).join(',')), ['cat,cat,1,pet,true', 'pug,pug,1,pet,true', 'lobster,lobster,1,pet,true'], JSON.stringify(r));
    assert.deepEqual(errors, [], 'page errors: ' + errors.slice(0, 2).join(' | '));
  });

  await context.close();
} finally {
  await browser.close();
}
if (failures) { console.log(`FAILED ${failures} check(s)`); process.exit(1); }
console.log('ALL PET CHECKS PASSED');
