// 0.12.0 interns: every running helper gets its own intern character (no 2-per-agent cap); only an office-wide
// safety cap (Office life setting interns.maxShown, default 24) is left, shared fairly between agents, and past it
// the chip reads "30 helpers · 24 shown". Placement for many interns: free desks nearest the agent (same room
// first), then standing spots in a ring round the agent's desk (walkable, apart, clear of every seat and of
// doorways, on the agent's side of the walls), then lounge seats, then near the front.
//
// Part 1 (always): crew.js + director.js in a vm with a fake host that has real geometry (desk footprints, an
// interior wall with a door, a doorway band). Part 2 (with PLAYWRIGHT_CORE_PATH): the real office page served by
// tests/perf/office-server.mjs, desktop 1600x900 and phone 412x915: helpers already running at load (5 and 12)
// are seated at once, distinct, walkable and off every seat, the chips read "5 helpers" / "12 helpers"; 30 more on
// a third agent -> 24 shown in all and "30 helpers · N shown". SHEET=1 writes .work/v13/sheets/v13-interns-all.jpg.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, 'app');
const Director = require(path.join(APP, 'office-life', 'director.js'));
const CREW_SRC = fs.readFileSync(path.join(APP, 'office-life', 'crew.js'), 'utf8');
let passed = 0;
function pass(name) { passed++; console.log(`[PASS] ${name}`); }

// ---- part 1: fake host with geometry ----
// 1200 x 800 office. Interior wall x = 600 from y 0 to 500, door gap 500..560, wall again 560..800.
// Each seat (agent or free desk) has its desk 18..48 px above it (a footprint). A doorway band round the gap.
const WALLS = [{ x1: 600, y1: 0, x2: 600, y2: 500 }, { x1: 600, y1: 560, x2: 600, y2: 800 }];
const DOOR_BAND = { x: 580, y: 495, w: 40, h: 70 };
function inRect(x, y, r) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
function segsCross(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function world(opts = {}) {
    const W = { clock: 1_000_000, calls: [], extras: [], labels: [], settings: { interns: true } };
    const seats = opts.seats || { alpha: { x: 200, y: 300 }, beta: { x: 300, y: 300 }, gamma: { x: 800, y: 300 }, delta: { x: 900, y: 650 } };
    const agents = {};
    Object.entries(seats).forEach(([k, s]) => {
        agents[k] = { id: k, statusKey: k, name: k[0].toUpperCase() + k.slice(1), x: s.x, y: s.y, desk: s ? { x: s.x, y: s.y } : null,
            isSitting: true, state: 'idle', faceDir: 1, _ctl: { tag: { x: s.x - 20, y: s.y - 60, w: 40, h: 14 } } };
    });
    const freeDesks = opts.freeDesks || [{ x: 260, y: 470 }, { x: 850, y: 470 }];
    const lounge = opts.lounge || [{ x: 1000, y: 200 }, { x: 1040, y: 200 }];
    const deskRects = [...Object.values(seats), ...freeDesks].map(s => ({ x: s.x - 26, y: s.y - 48, w: 52, h: 30 }));
    const walkable = opts.walkable || ((x, y) => x >= 16 && y >= 40 && x <= 1184 && y <= 784 && !deskRects.some(r => inRect(x, y, r))
        && !inRect(x, y, DOOR_BAND) && !WALLS.some(w => Math.abs(x - w.x1) < 10 && y >= w.y1 - 6 && y <= w.y2 + 6));
    const id = k => (typeof k === 'object' ? k.id : k);
    const host = {
        agent: k => (k && typeof k === 'object' ? k : agents[k]) || null,
        agents: () => Object.values(agents),
        walkTo(k, x, y) { const a = host.agent(k); a._walk = { x, y, st: 'walking' }; W.calls.push(['walkTo', id(k), x, y]); return true; },
        walkStatus(k) { const a = host.agent(k); return a && a._walk ? a._walk.st : 'idle'; },
        place(k, x, y, o) { const a = host.agent(k); a.x = x; a.y = y; a._walk = null; a.isSitting = !!(o && o.sit); return true; },
        sit(k, on) { host.agent(k).isSitting = on !== false; return true; },
        face() { return true; },
        pose(k, name) { host.agent(k)._lifePose = name || null; W.calls.push(['pose', id(k), name || null]); return true; },
        carry(k, item) { host.agent(k)._lifeCarry = item || null; return true; },
        spots: () => ({ front: { x: 300, y: 760 }, freeDesks: freeDesks.slice(), loungeSeats: lounge.slice() }),
        walkable, nearestWalkable: (x, y) => (walkable(x, y) ? { x, y } : null),
        wallBetween: (x0, y0, x1, y1) => WALLS.some(w => segsCross({ x: x0, y: y0 }, { x: x1, y: y1 }, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })),
        worldToCanvas: (x, y) => ({ x, y }), view: () => ({ w: 1200, h: 800 }), editMode: () => false,
        makeCharacter(o) { return { id: 'life-' + o.id, statusKey: 'life-' + o.id, x: o.x, y: o.y, _lifeExtra: true, _lifeAlpha: o.alpha, state: 'idle', isSitting: false, faceDir: 1 }; },
        addExtra(ch) { W.extras.push(ch); return ch; },
        removeExtra(ch) { const i = W.extras.indexOf(ch); if (i >= 0) W.extras.splice(i, 1); return i >= 0; },
        openChat() { return true; }, markBusy() {}, markDirty() {}
    };
    const director = Director.create(host, { now: () => W.clock, hidden: () => false, atDesk: () => false });
    const sprites = { label(ctx, text) { W.labels.push(String(text)); return { x: 0, y: 0, w: 80, h: 22 }; }, draw() { return true; }, hitRect() { return false; } };
    const feats = {}, text = {};
    const life = {
        feature(name, def) { def.name = name; feats[name] = def; return def; },
        host: () => host, director: () => director, sprites: () => sprites,
        t: (k, v) => (text[k] || k) + (v ? ':' + Object.values(v).join(',') : ''),
        clip: (s, n) => String(s).slice(0, n || 32), addText(o) { Object.assign(text, o); },
        isOn: n => W.settings[n] !== false, enabled: () => true, atDesk: () => false, reducedMotion: () => false,
        serverNow: () => W.clock, snapshot: () => null, layer: () => null
    };
    const sandbox = { VOLife: life, console, setTimeout: () => 0, Date: { now: () => W.clock } };
    vm.createContext(sandbox);
    vm.runInContext(CREW_SRC, sandbox, { filename: 'crew.js' });
    Object.assign(W, { agents, host, director, crew: feats.crew, seats, freeDesks, lounge });
    W.dbg = () => JSON.parse(JSON.stringify(feats.crew._debug()));
    W.tick = (ms = 100) => { for (let t = 0; t < ms; t += 100) { W.clock += 100; director.update(); feats.crew.update(W.clock); } };
    W.arriveAll = () => W.extras.forEach(a => { if (a._walk && a._walk.st === 'walking') { a.x = a._walk.x; a.y = a._walk.y; a._walk.st = 'arrived'; } });
    W.set = (agent, count) => feats.crew.onEvent({ type: 'interns.set', agent, count, at: W.clock });
    W.chip = () => { W.labels = []; feats.crew.drawScreen({}); return W.labels.filter(l => /^helpers/.test(l)); };
    return W;
}
// Every intern's spot: distinct (STAND_GAP apart), standing ones walkable, nobody on an agent's seat,
// ring spots on their agent's side of the wall.
function checkSpots(W, label) {
    const d = W.dbg(), list = d.interns.map(i => Object.assign({}, i, { x: i.sx ?? i.x, y: i.sy ?? i.y })); // where each one goes
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const dd = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
            assert.ok(dd >= 20, `${label}: interns ${i} and ${j} overlap (${dd.toFixed(1)} px) ${JSON.stringify([list[i], list[j]])}`);
        }
        const it = list[i];
        if (it.seat === 'shadow' || it.seat === 'front') assert.ok(W.host.walkable(it.x, it.y), `${label}: standing spot not walkable ${JSON.stringify(it)}`);
        Object.values(W.seats).forEach(s => assert.ok(Math.hypot(it.x - s.x, it.y - s.y) >= 30, `${label}: on an agent's seat ${JSON.stringify(it)}`));
        if (it.seat === 'shadow') {
            const s = W.seats[it.parent];
            assert.ok(!W.host.wallBetween(s.x, s.y, it.x, it.y), `${label}: ring spot behind a wall ${JSON.stringify(it)}`);
            assert.ok(Math.hypot(it.x - s.x, it.y - s.y) <= 200, `${label}: ring spot far from the agent ${JSON.stringify(it)}`);
        }
    }
    d.interns = list;
    return d;
}

// 1, 5, 12 and 30 helpers on one agent.
for (const n of [1, 5, 12, 30]) {
    const W = world();
    W.set('alpha', n);
    W.tick(100); W.arriveAll(); W.tick(200);
    const d = checkSpots(W, `${n} helpers`);
    const shown = Math.min(n, 24);
    assert.equal(d.interns.length, shown, `${n} helpers -> ${shown} interns`);
    assert.equal(W.extras.length, shown);
    assert.equal(W.director.used('interns'), shown);
    assert.ok(d.interns.every(i => i.phase === 'seated'), JSON.stringify(d.interns.map(i => i.phase)));
    const kinds = d.interns.map(i => i.seat);
    // the free desks first: the one in alpha's room, then the one through the door; then the ring round its desk
    assert.deepEqual(kinds.slice(0, 2), ['desk', 'desk'].slice(0, Math.min(2, n)));
    if (n >= 1) assert.deepEqual([d.interns[0].x, d.interns[0].y], [260, 470], 'the same-room desk first');
    assert.ok(kinds.slice(2).every(k => k === 'shadow'), JSON.stringify(kinds));
    const chip = W.chip();
    const want = n === 1 ? 'helpersOne' : n <= 24 ? 'helpersMany:' + n : 'helpersShown:30,24';
    assert.deepEqual(chip, [want], JSON.stringify(chip));
}
pass('one agent: 1, 5, 12, 30 helpers -> 1, 5, 12, 24 interns (cap 24); distinct, walkable, off every seat, same room; chip "30 helpers · 24 shown"');

// Ring order: the sides of the desk first, the back last; a ring spot never in the doorway band.
{
    const W = world({ freeDesks: [] });
    W.set('alpha', 6);
    W.tick(100);
    const d = checkSpots(W, 'ring');
    const s = W.seats.alpha;
    const firstTwo = d.interns.slice(0, 2).map(i => Math.sign(i.x - s.x));
    assert.deepEqual(firstTwo.sort(), [-1, 1], 'the first two stand on both sides: ' + JSON.stringify(d.interns.slice(0, 2)));
    assert.ok(d.interns.every(i => i.seat === 'shadow'));
    assert.ok(d.interns.every(i => i.y >= s.y - 20), 'nobody behind the desk while the sides and front have room: ' + JSON.stringify(d.interns));
    pass('ring: sides first, then the front; never behind the desk while there is room');
}

// Several agents at once, past the cap: fair shares, nobody overlaps, every chip honest.
{
    const W = world();
    [['alpha', 10], ['beta', 8], ['gamma', 6], ['delta', 12]].forEach(([k, n]) => W.set(k, n));
    W.tick(100); W.arriveAll(); W.tick(200);
    const d = checkSpots(W, 'four agents');
    assert.equal(d.interns.length, 24);
    assert.deepEqual(d.internShare, { alpha: 6, beta: 6, gamma: 6, delta: 6 });
    assert.deepEqual(W.chip().sort(), ['helpersShown:10,6', 'helpersShown:12,6', 'helpersMany:6', 'helpersShown:8,6'].sort());
    // below the cap: one each again, every chip a plain count
    W.set('delta', 2); W.set('alpha', 3);
    W.tick(1000); W.arriveAll(); W.tick(1000); W.arriveAll(); W.tick(600);
    const d2 = checkSpots(W, 'four agents below the cap');
    assert.equal(d2.interns.length, 3 + 8 + 6 + 2);
    assert.deepEqual(W.chip().sort(), ['helpersMany:2', 'helpersMany:3', 'helpersMany:6', 'helpersMany:8']);
    pass('several agents: 10+8+6+12 -> 6 each (24), chips "10 helpers · 6 shown"; below the cap one intern per helper again');
}

// No free floor round the agent: lounge seats, then spots near the front (still apart).
{
    const W = world({ freeDesks: [], walkable: (x, y) => (y >= 700 && y <= 790 && x >= 20 && x <= 580) });
    W.set('alpha', 5);
    W.tick(100);
    const d = checkSpots(W, 'cramped');
    assert.deepEqual(d.interns.map(i => i.seat), ['lounge', 'lounge', 'front', 'front', 'front']);
    pass('cramped: no ring spot -> lounge seats, then distinct spots near the front');
}

// Page load: helpers already running are seated at once (no walk-in); a new one walks in; leaving ones wave.
{
    const W = world();
    W.crew.onState({ open: { interns: { alpha: 5, beta: 12 } } });
    W.tick(100);
    assert.equal(W.calls.filter(c => c[0] === 'walkTo').length, 0, 'no walk-ins at page load');
    assert.equal(W.dbg().interns.length, 17);
    assert.ok(W.dbg().interns.every(i => i.phase === 'seated'));
    checkSpots(W, 'load');
    W.set('alpha', 6);
    W.tick(100);
    assert.equal(W.calls.filter(c => c[0] === 'walkTo').length, 1, 'the new helper walks in');
    W.set('beta', 10);
    W.tick(100);
    assert.equal(W.calls.filter(c => c[0] === 'pose' && c[2] === 'wave').length, 2, 'two wave goodbye');
    W.tick(1000); W.arriveAll(); W.tick(600);
    assert.equal(W.dbg().interns.length, 16);
    pass('load: 5 + 12 running -> 17 seated without walk-ins; a new one walks in; two leave with a wave');
}

// The setting: interns.maxShown raises or lowers the cap (1..48, else the default 24).
{
    const W = world();
    W.crew.onSettings({ interns: { maxShown: 30 } });
    W.set('alpha', 30);
    W.tick(100);
    assert.equal(W.dbg().interns.length, 30);
    assert.deepEqual(W.chip(), ['helpersMany:30']);
    W.crew.onSettings({ interns: { maxShown: 4 } });
    W.tick(1000); W.arriveAll(); W.tick(600);
    assert.equal(W.dbg().interns.length, 4);
    assert.deepEqual(W.chip(), ['helpersShown:30,4']);
    for (const [v, want] of [['x', 24], [0, 24], [500, 48]]) { W.crew.onSettings({ interns: { maxShown: v } }); assert.equal(W.dbg().maxShown, want, String(v)); }
    pass('setting interns.maxShown: 30 -> 30 shown, 4 -> "30 helpers · 4 shown"; bad values -> 24, at most 48');
}

// ---- part 2: the real office page ----
async function browserPart() {
    let pw = null;
    for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) { try { pw = require(c); break; } catch { /* next */ } }
    if (!pw) { console.log('SKIP browser part: playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)'); return; }
    const { buildOffice, startOfficeServer } = await import(path.join(ROOT, 'tests', 'perf', 'office-server.mjs'));
    const office = buildOffice(APP, {}, 27);
    const keys = office.agents.map(a => a.statusKey);
    const A = keys[0], B = keys[1], C = keys[2];
    office.lifeState.open.interns = { [A]: 5, [B]: 12 };
    const srv = await startOfficeServer({ appDir: APP, office, port: Number(process.env.INTERNS_PORT || 19770) });
    const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
    const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const shots = [];
    try {
        for (const [view, vp] of [['desktop', { width: 1600, height: 900, dpr: 1 }], ['phone', { width: 412, height: 915, dpr: 2, mobile: true }]]) {
            const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });
            await ctx.addInitScript(() => { try { localStorage.setItem('vo-onboarding-done', '1'); } catch (e) { /* */ } });
            const page = await ctx.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
            await page.goto(srv.url + '/', { waitUntil: 'load' });
            await page.waitForFunction(n => window.VOLifeCrew && window.VOLifeCrew._debug().interns.length === n, 17, { timeout: 30000 });
            await page.evaluate(() => {
                const T = window.__t = { labels: new Set() };
                const S = window.VOLifeSprites, label = S.label;
                S.label = function (ctx, text) { T.labels.add(String(text)); return label.apply(this, arguments); };
            });
            const check = async (label) => page.evaluate(() => {
                const H = window.VOLifeHost, d = window.VOLifeCrew._debug(), bad = [];
                const seats = (window.agents || []).map(a => a.desk || a._autoDesk).filter(s => s && isFinite(s.x));
                const list = d.interns.filter(i => i.phase !== 'waving' && i.phase !== 'leaving' && i.phase !== 'fading')
                    .map(i => Object.assign({}, i, { x: i.sx ?? i.x, y: i.sy ?? i.y }));
                for (let i = 0; i < list.length; i++) {
                    for (let j = i + 1; j < list.length; j++) if (Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) < 20) bad.push(['overlap', i, j]);
                    const it = list[i];
                    if (it.seat === 'shadow' || it.seat === 'front') { if (!H.walkable(it.x, it.y)) bad.push(['not walkable', it]); }
                    if (seats.some(s => Math.hypot(it.x - s.x, it.y - s.y) < 30)) bad.push(['on a seat', it]);
                    if (it.seat === 'shadow') {
                        const a = window.agentMap[it.parent] || (window.agents || []).find(x => x.statusKey === it.parent), s = a && (a.desk || a._autoDesk);
                        if (s && H.wallBetween(s.x, s.y, it.x, it.y)) bad.push(['behind a wall', it]);
                    }
                }
                const per = {}; list.forEach(i => { per[i.parent] = (per[i.parent] || 0) + 1; });
                return { n: list.length, per, bad: bad.slice(0, 3), phases: [...new Set(list.map(i => i.phase))], share: d.internShare };
            });
            const r1 = await check();
            assert.deepEqual(r1.bad, [], `${view}: ${JSON.stringify(r1.bad)}`);
            assert.deepEqual(r1.per, { [A]: 5, [B]: 12 }, view);
            assert.deepEqual(r1.phases, ['seated'], `${view}: running at load -> seated at once`);
            await page.waitForFunction(() => window.__t.labels.has('5 helpers') && window.__t.labels.has('12 helpers'), null, { timeout: 8000 });
            // INTERN tags never pile up: a tag that would cover another one is left out (most still show)
            const tags = await page.evaluate(async () => {
                const H = window.VOLifeHost, orig = H.extraTag, frame = [];
                H.extraTag = function () { const r = orig.apply(this, arguments); frame.push(r); return r; };
                window.markSceneDirty && window.markSceneDirty();
                await new Promise(r => setTimeout(r, 400));
                H.extraTag = orig;
                const n = window.VOLifeCrew._debug().interns.length, last = frame.slice(-n), drawn = last.filter(Boolean);
                let overlaps = 0;
                for (let i = 0; i < drawn.length; i++) for (let j = i + 1; j < drawn.length; j++) {
                    const a = drawn[i], b = drawn[j];
                    if (a.x < b.x + b.w - 1 && a.x + a.w > b.x + 1 && a.y < b.y + b.h - 1 && a.y + a.h > b.y + 1) overlaps++;
                }
                return { calls: frame.length, n, drawn: drawn.length, overlaps };
            });
            // (the phone fits the whole office: every agent's chat icon is there too, so fewer tags fit)
            assert.ok(tags.calls >= tags.n && tags.overlaps === 0 && tags.drawn >= (view === 'desktop' ? 5 : 2), `${view}: INTERN tags ${JSON.stringify(tags)}`);
            pass(`page ${view}: 5 + 12 helpers running at load -> 17 interns seated at once, distinct, walkable, off every seat; chips "5 helpers", "12 helpers"; ${tags.drawn}/17 INTERN tags, none overlapping`);
            if (process.env.SHEET) {
                // frame the two agents (and their interns) for the sheet
                const box = await page.evaluate(([a, b]) => {
                    const H = window.VOLifeHost, pts = window.VOLifeCrew._debug().interns.map(i => H.worldToCanvas(i.x, i.y));
                    [a, b].forEach(k => { const ag = window.agentMap[k]; if (ag) pts.push(H.worldToCanvas(ag.x, ag.y)); });
                    const c = document.querySelector('canvas').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
                    const xs = pts.map(p => p.x / dpr + c.left), ys = pts.map(p => p.y / dpr + c.top);
                    return { x: Math.min(...xs) - 70, y: Math.min(...ys) - 80, x2: Math.max(...xs) + 70, y2: Math.max(...ys) + 50 };
                }, [A, B]);
                await page.waitForTimeout(600);
                const clip = view === 'desktop' ? { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(1600, box.x2) - Math.max(0, box.x), height: Math.min(900, box.y2) - Math.max(0, box.y) } : undefined;
                shots.push({ view, png: (await page.screenshot({ clip, type: 'png' })).toString('base64') });
            }
            // 30 more on a third agent: 47 running, 24 shown in all, every agent keeps a share.
            await page.evaluate(k => window.VOLifeCrew.onEvent({ type: 'interns.set', agent: k, count: 30, at: Date.now() }), C);
            await page.waitForFunction(() => window.VOLifeCrew._debug().interns.filter(i => i.phase !== 'waving' && i.phase !== 'leaving' && i.phase !== 'fading').length === 24, null, { timeout: 30000 });
            const r2 = await check();
            assert.deepEqual(r2.bad, [], `${view} 47: ${JSON.stringify(r2.bad)}`);
            const share = r2.share;
            assert.equal(share[A] + share[B] + share[C], 24, JSON.stringify(share));
            assert.equal(share[A], 5, 'the agent with 5 keeps all 5');
            await page.waitForFunction(n => [...window.__t.labels].some(l => l === '30 helpers · ' + n + ' shown'), share[C], { timeout: 8000 });
            assert.deepEqual(errors, [], view + ' page errors');
            pass(`page ${view}: +30 on a third agent -> 24 shown (${share[A]}/${share[B]}/${share[C]}), chip "30 helpers · ${share[C]} shown", no page errors`);
            await ctx.close();
        }
        if (process.env.SHEET && shots.length === 2) {
            const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
            const page = await ctx.newPage();
            await page.setContent(`<body style="margin:0;background:#22252b;font:14px Arial;color:#eee;display:flex;gap:10px;padding:10px;align-items:flex-start">
              <div><div>Desktop: an agent with 5 helpers and one with 12 (helpers running at load, seated at once)</div><img id=a style="max-width:960px;max-height:840px"></div>
              <div><div>Phone 412x915</div><img id=b style="height:840px"></div></body>`);
            await page.evaluate(([a, b]) => { document.getElementById('a').src = 'data:image/png;base64,' + a; document.getElementById('b').src = 'data:image/png;base64,' + b; }, [shots[0].png, shots[1].png]);
            await page.waitForTimeout(300);
            const out = path.join(ROOT, '.work', 'v13', 'sheets', 'v13-interns-all.jpg');
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const size = await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
            for (const q of [70, 55, 40]) {
                fs.writeFileSync(out, await page.screenshot({ type: 'jpeg', quality: q, clip: { x: 0, y: 0, width: Math.min(1400, size.w), height: Math.min(900, size.h) } }));
                if (fs.statSync(out).size < 150 * 1024) break;
            }
            console.log('sheet', out, fs.statSync(out).size);
            await ctx.close();
        }
    } finally {
        await browser.close();
        await srv.close();
    }
}
await browserPart();
console.log(`v13 interns-all tests passed (${passed})`);
