// v0.10.1 save safety (client): saving twice quickly never loses a change.
//
// Part 1 (plain Node): VOSave.queue (one save at a time, coalesced, retried) and
// VOSave.merge3 (three-way merge after a 409).
// Part 2 (one headless Chrome, hermetic page): the office editor saves against a
// PRIVATE server from this tree (scratch data dir, a free loopback port) through page
// routes, so request arrival order can be forced. Nothing touches a live office.
//
//   node tests/test_v10_saves.mjs            (part 2 skips without Chrome)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { APP, launch, officeFixture, makeChecker } from './test_v10_editor_lib.mjs';

const require = createRequire(import.meta.url);
const VOSave = require(path.join(APP, 'vo-save-queue.js'));
const check = makeChecker('test_v10_saves');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- part 1
async function partQueue() {
  // Rapid requests while a save is on the way: never two at once, latest state last.
  {
    let state = 0, inFlight = 0, maxInFlight = 0;
    const sent = [];
    const q = VOSave.queue({ send: async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const snap = state; sent.push(snap);
      await sleep(60);
      inFlight--;
      return { ok: true };
    } });
    state = 1; const p1 = q.request(0);
    await sleep(5);
    state = 2; const p2 = q.request(0);
    state = 3; const p3 = q.request(0);
    const results = await Promise.all([p1, p2, p3]);
    check.ok(maxInFlight === 1, 'queue: one save on the way at a time', `max ${maxInFlight}`);
    check.ok(sent.join(',') === '1,3', 'queue: saves during a save coalesce into the latest state', sent.join(','));
    check.ok(results.every(Boolean), 'queue: every request resolves true once stored');
    check.ok(q.state().state === 'saved' && !q.pending(), 'queue: ends saved, nothing pending');
  }
  // Failures retry with backoff and keep the change pending; a newer edit goes with the retry.
  {
    let calls = 0, state = 'a';
    const states = [];
    const stored = [];
    const q = VOSave.queue({ retryMs: [30, 60], onState: (s) => states.push(s), send: async () => {
      calls++;
      if (calls <= 2) return { ok: false, retry: true, error: 'no answer' };
      stored.push(state); return { ok: true };
    } });
    const first = q.request(0);
    check.ok((await first) === false, 'queue: the caller hears about a failed save');
    state = 'b';
    await sleep(200);
    check.ok(stored.join() === 'b' && calls === 3, 'queue: retried with backoff, the newest state stored', `${calls} ${stored}`);
    check.ok(states.includes('failed') && states[states.length - 1] === 'saved', 'queue: failed shown, then saved');
  }
  // A 409 merged by the sender goes out again at once, waiters keep waiting.
  {
    let calls = 0;
    const q = VOSave.queue({ send: async () => (++calls === 1 ? { ok: false, again: true } : { ok: true }) });
    const ok = await q.request(0);
    check.ok(ok === true && calls === 2, 'queue: a merged conflict is sent again before the caller hears back');
  }
  // keepalive flush while a save is on the way sends the newest state too.
  {
    const ctxs = [];
    const q = VOSave.queue({ send: async (ctx) => { ctxs.push(ctx); await sleep(40); return { ok: true }; } });
    q.request(0);
    await sleep(5);
    q.request(500);
    q.flush(true);
    check.ok(ctxs.length === 2 && ctxs[1].keepalive && ctxs[1].seq > ctxs[0].seq, 'queue: unload flush overlaps with a newer sequence number');
    await sleep(120);
  }
}

function partMerge() {
  const base = officeFixture();
  const local = JSON.parse(JSON.stringify(base));
  const remote = JSON.parse(JSON.stringify(base));
  local.furniture.find(f => f.id === 'd1').x = 600;                 // moved here
  local.furniture.push({ id: 'n1', type: 'plant', x: 10, y: 10 });   // added here
  local.walls.interior.push({ x1: 1, y1: 1, x2: 1, y2: 4 });         // wall added here
  remote.furniture.find(f => f.id === 'c1').x = 700;                // moved there
  remote.furniture = remote.furniture.filter(f => f.id !== 'p1');    // deleted there
  remote.floor = { color1: '#000000', color2: '#111111' };           // painted there
  remote.agents = [{ id: 'alpha', model: 'gpt-x' }];                 // agent settings there
  const merged = VOSave.merge3(base, local, remote);
  const by = Object.fromEntries(merged.furniture.map(f => [f.id, f]));
  check.ok(by.d1.x === 600 && by.c1.x === 700, 'merge: both moves kept');
  check.ok(!by.p1 && by.n1, 'merge: delete there and add here both kept');
  check.ok(merged.floor.color1 === '#000000' && merged.walls.interior.length === 2, 'merge: floor paint there and wall here both kept');
  check.ok(merged.agents[0].model === 'gpt-x', 'merge: server-side agent change kept');
  const both = VOSave.merge3({ a: 1 }, { a: 2 }, { a: 3 });
  check.ok(both.a === 2, 'merge: same value changed on both sides -> this window wins');
  const wb = { walls: [{ x: 1 }, { x: 2 }] };
  const wl = { walls: [{ x: 2 }] };                 // deleted {x:1} here
  const wr = { walls: [{ x: 1 }, { x: 2 }, { x: 3 }] }; // added {x:3} there
  check.ok(JSON.stringify(VOSave.merge3(wb, wl, wr).walls) === '[{"x":2},{"x":3}]', 'merge: id-less lists merge as add/delete');
}

// ---------------------------------------------------------------- part 2
// A free loopback port unless VO_SAVES_PORT says otherwise (a fixed port clashed with a parallel run of this test).
const PORT = Number(process.env.VO_SAVES_PORT) || await new Promise((resolve, reject) => {
  const srv = net.createServer(); srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});
const ORIGIN = 'http://office.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.jpg': 'image/jpeg' };

async function startServer(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'openclaw'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'office-config.json'), JSON.stringify(officeFixture()));
  const code = [
    'import sys', `sys.path.insert(0, ${JSON.stringify(APP)})`, 'import server',
    `httpd = server.VirtualOfficeThreadingHTTPServer(("127.0.0.1", ${PORT}), server.OfficeHandler)`,
    'print("ready", flush=True)', 'httpd.serve_forever()'].join('\n');
  const env = Object.assign({}, process.env, { VO_STATUS_DIR: dataDir, VO_CONFIG: path.join(dataDir, 'vo-config.json'),
    VO_OPENCLAW_PATH: path.join(dataDir, 'openclaw'), OPENCLAW_HOME: path.join(dataDir, 'home'),
    VO_CODEX_INCLUDE_NATIVE_AGENTS: '0', VO_CLAUDE_CODE_INCLUDE_NATIVE_AGENTS: '0' });
  const proc = spawn('python3', ['-c', code], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('private server did not start')), 60000);
    proc.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error('private server exited ' + c)); });
  });
  return proc;
}

// One page of the office. officeConfig requests go to the private server, after
// `hold(request)` ms (forces arrival order); everything else is answered here.
async function openPage(context, log, hold) {
  const page = await context.newPage();
  page.on('pageerror', (e) => log.errors.push(e.message));
  return page;
}

async function makeContext(browser, log, holdFn) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  const fixtures = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.1', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: [{ id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }] },
    '/status': { alpha: { state: 'idle', task: '' } }, '/agent-chat': {}, '/api/layouts': { layouts: [] },
    '/weather-proxy': { current_condition: [], configured: false },
  };
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/api/office-config') {
      const entry = { method: req.method(), headers: req.headers(), body: req.postData(), at: Date.now() };
      if (entry.method === 'POST') { log.inFlight++; log.maxInFlight = Math.max(log.maxInFlight, log.inFlight); log.posts.push(entry); }
      const wait = holdFn ? holdFn(entry) : 0;
      if (wait === 'abort') { log.inFlight--; return route.abort(); }
      if (wait) await sleep(wait);
      const headers = Object.assign({}, entry.headers);
      delete headers.origin; delete headers.referer; delete headers.host; delete headers.cookie;
      try {
        const res = await route.fetch({ url: `http://127.0.0.1:${PORT}/api/office-config`, headers });
        const text = await res.text();
        entry.status = res.status();
        await route.fulfill({ status: res.status(), headers: res.headers(), body: text });
      } catch (e) {
        entry.status = 0;
        await route.abort().catch(() => {});
      } finally {
        if (entry.method === 'POST') log.inFlight--;
      }
      return;
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (Object.prototype.hasOwnProperty.call(fixtures, url.pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[url.pathname]) });
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel);
    const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return route.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  return context;
}

async function loadOffice(page) {
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof _serverConfigLoaded !== 'undefined' && _serverConfigLoaded && window.officeConfig &&
    officeConfig.furniture.some(f => f.id === 'd1'), null, { timeout: 30000 });
}

const move = (page, id, x) => page.evaluate(([i, v]) => { officeConfig.furniture.find(f => f.id === i).x = v; return saveOfficeConfig(); }, [id, x]);
const kick = (page, id, x) => { move(page, id, x).catch(() => {}); }; // not awaited: the save is held on the way
const settled = (page) => page.waitForFunction(() => _officeSaveState.state === 'saved' &&
  (typeof _officeQueue !== 'function' || !_officeQueue() || !_officeQueue().pending()), null, { timeout: 20000 });

async function partBrowser(dataDir) {
  const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'office-config.json'), 'utf8'));
  const x = (id) => (stored().furniture.find(f => f.id === id) || {}).x;
  const reset = () => fs.writeFileSync(path.join(dataDir, 'office-config.json'), JSON.stringify(officeFixture()));
  const browser = await launch('test_v10_saves');
  try {
    // 1. Two quick saves while the first is slow: one at a time, both changes stored.
    {
      reset();
      const log = { posts: [], errors: [], inFlight: 0, maxInFlight: 0 };
      let n = 0;
      const ctx = await makeContext(browser, log, (e) => (e.method === 'POST' && ++n === 1 ? 1500 : 0));
      const page = await openPage(ctx, log); await loadOffice(page);
      kick(page, 'd1', 611);
      await sleep(700);                      // first save is on the way (held 1.5 s)
      kick(page, 'c1', 622);
      await sleep(700);
      kick(page, 'k1', 633);
      await settled(page);
      check.ok(log.maxInFlight === 1, 'editor: rapid saves go one at a time', `max ${log.maxInFlight}`);
      check.ok(x('d1') === 611 && x('c1') === 622 && x('k1') === 633, 'editor: every change of three quick saves is stored',
        `${x('d1')} ${x('c1')} ${x('k1')}`);
      check.ok(log.posts.length === 2, 'editor: changes made during a save coalesce into one follow-up save', String(log.posts.length));
      check.ok(log.errors.length === 0, 'editor: no page errors', log.errors[0]);
      await ctx.close();
    }
    // 2. Two tabs: the second tab's stale copy merges instead of overwriting.
    {
      reset();
      const log = { posts: [], errors: [], inFlight: 0, maxInFlight: 0 };
      const ctx = await makeContext(browser, log, null);
      const a = await openPage(ctx, log); await loadOffice(a);
      const b = await openPage(ctx, log); await loadOffice(b);
      await move(a, 'd1', 701); await settled(a);
      await move(b, 'p1', 702); await settled(b);
      const statuses = log.posts.map(p => p.status).join(',');
      check.ok(x('d1') === 701 && x('p1') === 702, 'two tabs: both tabs\' changes are stored', `${x('d1')} ${x('p1')} [${statuses}]`);
      check.ok(statuses.includes('409'), 'two tabs: the stale tab got 409 and merged', statuses);
      const bView = await b.evaluate(() => officeConfig.furniture.find(f => f.id === 'd1').x);
      check.ok(bView === 701, 'two tabs: the second tab now shows the first tab\'s change');
      // A third save from tab A (now stale too) after B's merge keeps B's change.
      await move(a, 'k1', 703); await settled(a);
      check.ok(x('d1') === 701 && x('p1') === 702 && x('k1') === 703, 'two tabs: back and forth keeps every change');
      // A server-side writer (agent settings) changes the agents list; tab B saves after.
      const doc = stored(); doc.agents = [{ id: 'alpha', statusKey: 'alpha', model: 'gpt-x' }];
      fs.writeFileSync(path.join(dataDir, 'office-config.json.tmp'), JSON.stringify(doc));
      fs.renameSync(path.join(dataDir, 'office-config.json.tmp'), path.join(dataDir, 'office-config.json'));
      await move(b, 'c1', 704); await settled(b);
      const alpha = (stored().agents || []).find(ag => ag.id === 'alpha') || {};
      check.ok(alpha.model === 'gpt-x' && x('c1') === 704, 'server-side agent change survives a later layout save', JSON.stringify(alpha));
      check.ok(log.errors.length === 0, 'two tabs: no page errors', log.errors[0]);
      await ctx.close();
    }
    // 3. Out of order: a save is held on the way, the unload flush sends a newer one
    //    that arrives first; the older one must not overwrite it.
    {
      reset();
      const log = { posts: [], errors: [], inFlight: 0, maxInFlight: 0 };
      let n = 0;
      const ctx = await makeContext(browser, log, (e) => (e.method === 'POST' && ++n === 1 ? 1500 : 0));
      const page = await openPage(ctx, log); await loadOffice(page);
      kick(page, 'd1', 801);
      await sleep(700);
      await page.evaluate(() => { officeConfig.furniture.find(f => f.id === 'c1').x = 802; saveOfficeConfig(); window.dispatchEvent(new Event('pagehide')); });
      await settled(page);
      await sleep(300);
      const statuses = log.posts.map(p => p.status).join(',');
      check.ok(x('d1') === 801 && x('c1') === 802, 'out of order: the newer save is kept when the older arrives last', `${x('d1')} ${x('c1')} [${statuses}]`);
      check.ok(/409/.test(statuses), 'out of order: the late older save was refused', statuses);
      await ctx.close();
    }
    // 4. Server unreachable for a while (restart): retries, then stored; Saving/failed shown.
    {
      reset();
      const log = { posts: [], errors: [], inFlight: 0, maxInFlight: 0 };
      let n = 0;
      const ctx = await makeContext(browser, log, (e) => (e.method === 'POST' && ++n <= 2 ? 'abort' : 0));
      const page = await openPage(ctx, log); await loadOffice(page);
      const states = [];
      await page.exposeFunction('__saveState', (s) => states.push(s));
      await page.evaluate(() => window.addEventListener('vo:office-save', (e) => window.__saveState(e.detail.state)));
      kick(page, 'd1', 901);
      await page.waitForFunction(() => _officeSaveState.state === 'saved', null, { timeout: 15000 });
      check.ok(x('d1') === 901, 'restart: the save is retried until the server takes it');
      check.ok(states.includes('failed') && states[states.length - 1] === 'saved', 'restart: failed shown, then saved', states.join(','));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  setTimeout(() => { console.log('[FAIL] test_v10_saves: timed out'); process.exit(1); }, 160000).unref();
  await partQueue();
  partMerge();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-v10-saves-'));
  let server = null;
  try {
    server = await startServer(dataDir);
    process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
    await partBrowser(dataDir);
  } finally {
    if (server) server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  check.done();
}

main().catch((e) => { console.log('[FAIL] crashed: ' + (e && e.stack || e).toString().slice(0, 400)); process.exit(1); });
