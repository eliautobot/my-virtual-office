// Office life canvas test (v0.9, L2): the client core in a real browser.
//
// Same fixture approach as test_v08_office_canvas.mjs: headless Chrome via
// playwright-core, every request answered by the test (static files from app/,
// JSON fixtures, a scripted /api/office-life/stream body), no server, nothing
// saved. A tiny test feature registered in the page drives the director.
//
// Checks:
//   1. state loads, the stream is read (and re-opened with ?since=), no page errors;
//   2. needs.open from the stream -> the held agent walks to the front desk spot
//      and holds a placard; needs.close -> released, back at its desk;
//   3. a late transient event is dropped, a late stateful one is applied;
//   4. an intern from makeCharacter walks, is drawn and never joins the roster;
//   5. ping pong with a decided result ends with exactly that winner and score;
//   6. frame pacing drops to the idle rate once nothing moves;
//   7. enabled:false draws nothing and hides the layer; a 429 stream falls back
//      to reading /state.
//
// Run: node tests/test_life_canvas.mjs   (prints SKIP without playwright/Chrome)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);

function skip(reason) { console.log(`SKIP test_life_canvas: ${reason}`); process.exit(0); }
function loadPlaywright() {
    for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
        try { return require(c); } catch { /* next */ }
    }
    return null;
}
function findChrome() {
    return [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
        '/usr/bin/chromium-browser'].filter(Boolean).find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}
const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = findChrome();
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const ORIGIN = 'http://office.test';
const FIXTURES = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.9.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
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
    '/agent-chat': {},
    '/api/office-config': {
        canvasWidth: 1040, canvasHeight: 740,
        walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' },
            sections: [{ x: 0, w: 1040, color: '#37474f', accentColor: '#263238' }], interior: [] },
        floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
        furniture: [
            { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' },
            { id: 'd2', type: 'desk', x: 320, y: 220, assignedTo: 'Beta' },
            { id: 'd3', type: 'desk', x: 160, y: 380, assignedTo: 'Gamma' },
            { id: 'd4', type: 'desk', x: 320, y: 380 },
            { id: 'r1', type: 'receptionDesk', x: 520, y: 590 },
            { id: 'n1', type: 'noticeBoard', x: 600, y: 30 },
            { id: 't1', type: 'pingPongTable', x: 820, y: 300 },
            { id: 'k1', type: 'kitchenCounter', x: 880, y: 560 },
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

function lifeState(settings) {
    return { ok: true, seq: 100, day: '2026-11-02', tz: 'UTC', settings,
        open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], cake: false }, paper: { day: '2026-11-02', ready: false } };
}

// One fixture world per browser context: its Office life state and stream script.
function makeRouter(life) {
    return async function route(routeObj) {
        const request = routeObj.request();
        const url = new URL(request.url());
        if (url.origin !== ORIGIN) return routeObj.abort();
        if (url.pathname === '/api/office-life/state') {
            life.stateReads++;
            return routeObj.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() }, body: JSON.stringify(life.state) });
        }
        if (url.pathname === '/api/office-life/stream') {
            life.streamUrls.push(url.search);
            (life.streamClients = life.streamClients || []).push(request.headers()['x-vo-client'] || '');
            if (life.streamStatus === 429) {
                return routeObj.fulfill({ status: 429, contentType: 'application/json', body: '{"ok":false,"error":"too_many_streams"}' });
            }
            let body = `retry: 3000\n: seq ${life.seq}\n\n`;
            for (const ev of life.pending.splice(0)) {
                life.seq++;
                body += `id: ${life.seq}\ndata: ${JSON.stringify({ seq: life.seq, ts: Date.now() / 1000, scope: 'connection', event: ev })}\n\n`;
            }
            return routeObj.fulfill({ status: 200, contentType: 'text/event-stream', body });
        }
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
        return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    };
}

const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
const results = [];
function pass(name) { results.push(name); console.log(`[PASS] ${name}`); }

async function openOffice(life) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    await context.route('**/*', makeRouter(life));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.agents && window.agents.length === 3 && window.VOLife && window.VOLife.status() === 'ready', null, { timeout: 20000 });
    // The page's test feature: needs.open -> walk to the front with a sign; needs.close -> done.
    await page.evaluate(() => {
        const T = window.__life = { drawn: 0, arrived: null, ended: null, ctl: null, events: [] };
        window.addEventListener('vo:life-event', e => T.events.push(e.detail.type));
        window.VOLife.feature('zz-test', {
            order: 99,
            onEvent(ev) {
                if (ev.type === 'needs.open' && ev.agent === 'alpha') {
                    window.VOLife.director().request(ev.agent, {
                        kind: 'needs', feature: 'zz-test', moves: true, forWork: true, requeue: true, label: window.VOLife.t('holdFront'),
                        start(ctl) {
                            T.ctl = ctl;
                            const f = window.VOLifeHost.spots().front;
                            T.front = f;
                            ctl.walk(f.x, f.y, r => { T.arrived = r; ctl.pose('sign', { glyph: '!' }); });
                        },
                        end(ctl, reason) { T.ended = reason; }
                    });
                }
                if (ev.type === 'needs.close' && T.ctl) T.ctl.done('answered');
            },
            drawScreen() { T.drawn++; }
        });
    });
    return { context, page, errors };
}

// The core is driven by the test feature above; the real feature modules that react to the
// same events (needs, interns, handoffs, visitors, alarm clocks) are off here and have their
// own test (tests/test_life_needs_crew.mjs).
const SETTINGS = { enabled: true, calm: false, features: { needsYou: false, interns: false, handoffs: false, visitors: false, alarmClock: false } };

// ---------- A: Office life on ----------
const lifeA = { state: lifeState(SETTINGS), seq: 100, pending: [], streamUrls: [], stateReads: 0, streamStatus: 200 };
{
    const { context, page, errors } = await openOffice(lifeA);
    await page.waitForFunction(() => window.__life.drawn > 3, null, { timeout: 5000 });
    const desk = await page.evaluate(() => { const a = window.agentMap.alpha; return { x: a.desk.x, y: a.desk.y }; });

    const now = Date.now();
    lifeA.pending.push(
        { type: 'needs.open', agent: 'alpha', at: now, provider: 'openclaw', ref: 'ap1', need: 'approval', count: 1 },
        { type: 'visitor', agent: 'gamma', at: now - 60000, provider: 'openclaw', channel: 'telegram' },
        { type: 'mood', agent: 'gamma', at: now - 60000, provider: 'openclaw', mood: 'focused' },
        { type: 'handoff', agent: 'gamma', at: now, provider: 'openclaw', to: 'alpha', via: 'send' });
    await page.waitForFunction(() => window.__life.arrived, null, { timeout: 20000 });
    const atFront = await page.evaluate(() => {
        const a = window.agentMap.alpha, T = window.__life;
        return { arrived: T.arrived, front: T.front, x: a.x, y: a.y, hold: a._lifeHold && a._lifeHold.kind, label: a._lifeHold && a._lifeHold.label,
            pose: a._lifePose, inAgents: window.agents.indexOf(a) >= 0, events: T.events.slice(), live: window.VOLife._debug() };
    });
    assert.equal(atFront.arrived.ok, true, JSON.stringify(atFront.arrived));
    assert.equal(atFront.front.source, 'receptionDesk');
    assert.ok(Math.abs(atFront.x - atFront.front.x) <= 6 && Math.abs(atFront.y - atFront.front.y) <= 6, JSON.stringify(atFront));
    assert.equal(atFront.hold, 'needs');
    assert.equal(atFront.label, 'waiting at the front desk');
    assert.equal(atFront.pose, 'sign');
    assert.ok(lifeA.streamUrls.length >= 2 && /since=\d+/.test(lifeA.streamUrls[lifeA.streamUrls.length - 1]), lifeA.streamUrls.join(','));
    pass('stream: needs.open walks the held agent to the front desk spot with a placard (since= on reconnect)');
    assert.ok(atFront.events.includes('handoff'), 'fresh transient event delivered');
    assert.ok(atFront.events.includes('mood'), 'late stateful event applied');
    assert.ok(!atFront.events.includes('visitor'), 'late transient event dropped');
    pass('late events: transient visitor dropped, stateful mood applied, fresh handoff delivered');

    await page.waitForTimeout(300);
    const spriteCount = await page.evaluate(() => window.VOLifeSprites.cacheSize());
    assert.ok(spriteCount >= 1, 'placard sprite drawn from the cache');

    lifeA.pending.push({ type: 'needs.close', agent: 'alpha', at: Date.now(), provider: 'openclaw', ref: 'ap1', outcome: 'answered' });
    await page.waitForFunction(() => window.__life.ended === 'answered', null, { timeout: 12000 });
    await page.waitForFunction(d => { const a = window.agentMap.alpha; return Math.abs(a.x - d.x) < 3 && Math.abs(a.y - d.y) < 3; }, desk, { timeout: 20000 });
    const back = await page.evaluate(() => { const a = window.agentMap.alpha; return { hold: a._lifeHold, pose: a._lifePose, state: a.state, running: window.VOLife._debug().running }; });
    assert.equal(back.hold, null);
    assert.equal(back.pose, null);
    assert.equal(back.state, 'idle');
    assert.deepEqual(back.running, []);
    pass('needs.close releases the agent: back at its desk, no hold, no pose');

    // Intern: a character outside the roster that walks and is drawn.
    const intern = await page.evaluate(async () => {
        const H = window.VOLifeHost;
        const f = H.spots().front, desk = H.spots().freeDesks[0];
        const ch = H.makeCharacter({ id: 'intern-test', seed: 'alpha:0', x: f.x, y: f.y, color: '#26a69a' });
        H.addExtra(ch);
        H.walkTo(ch, desk.x, desk.y);
        const d0 = Math.hypot(ch.x - desk.x, ch.y - desk.y);
        await new Promise(r => setTimeout(r, 2500));
        const out = { d0, d1: Math.hypot(ch.x - desk.x, ch.y - desk.y), inAgents: window.agents.indexOf(ch) >= 0,
            inMap: !!window.agentMap[ch.id], roster: window.agents.length, extras: H.extras().length, draws: window.__voStats.draws };
        H.removeExtra(ch);
        out.after = H.extras().length;
        return out;
    });
    assert.ok(intern.d1 < intern.d0 - 40, JSON.stringify(intern));
    assert.equal(intern.inAgents, false);
    assert.equal(intern.inMap, false);
    assert.equal(intern.roster, 3);
    assert.equal(intern.extras, 1);
    assert.equal(intern.after, 0);
    pass('makeCharacter: an intern walks and is drawn, never in agents/agentMap');

    // Free desks: a desk with an agent's seat within ~40 px is taken (auto-placed seats sit off the item).
    const desks = await page.evaluate(() => {
        const H = window.VOLifeHost, g = window.agentMap.gamma, keep = g.desk;
        const ids = () => H.spots().freeDesks.map(d => d.id).sort().join(',');
        const out = { base: ids() };
        g.desk = { x: 340, y: 400 }; out.near = ids();
        g.desk = { x: 320 + 60, y: 380 }; out.far = ids();
        g.desk = keep;
        return out;
    });
    assert.equal(desks.base, 'd4', JSON.stringify(desks));
    assert.ok(!desks.near.split(',').includes('d4'), 'a seat 20 px off d4 takes it: ' + JSON.stringify(desks));
    assert.ok(desks.far.split(',').includes('d4'), 'a seat 60 px away leaves d4 free: ' + JSON.stringify(desks));
    pass('freeDesks: a desk near any agent\'s seat (within ~40 px) is never offered');

    // Food trip hook: idle life (no hold) to the kitchen and back, take + eat poses, ends cleanly.
    const food = await page.evaluate(async () => {
        const H = window.VOLifeHost, g = window.agentMap.gamma, a = window.agentMap.alpha, out = { phases: [] };
        out.refusedWorking = H.foodTrip('beta', { item: 'donut' });
        let done = null;
        out.started = H.foodTrip('gamma', { item: 'donut', takeMs: 300, eatMs: 700, onTake: () => { out.took = true; }, onDone: r => { done = r; } });
        out.act = g.idleAction; out.held = !!g._lifeHold;
        const t0 = Date.now();
        let last = '';
        while (!done && Date.now() - t0 < 40000) {
            const f = H.foodTripOf('gamma');
            if (f && last !== f.phase) { last = f.phase; out.phases.push(f.phase + ':' + (g._lifePose || '') + ':' + (g._lifeCarry || '')); }
            await new Promise(r => setTimeout(r, 50));
        }
        out.done = done; out.after = { pose: g._lifePose, carry: g._lifeCarry, act: g.idleAction, sitting: g.isSitting };
        // A hold (director script) ends a trip at once, before the script poses.
        let held = null;
        out.alphaStarted = H.foodTrip('alpha', { item: 'donut', onDone: r => { held = r; } });
        H.hold('alpha', 'test');
        out.heldDone = held; out.alphaTrip = H.foodTripOf('alpha'); out.alphaAct = a.idleAction;
        H.release('alpha');
        // Lean-in typing: a working agent at its desk; the pose draws without errors.
        H.pose('beta', 'type', { ambient: true });
        await new Promise(r => setTimeout(r, 300));
        out.betaPose = window.agentMap.beta._lifePose;
        H.pose('beta', null);
        return out;
    });
    assert.equal(food.refusedWorking, false, 'a working agent never goes: ' + JSON.stringify(food));
    assert.ok(food.started && food.act === 'life_food' && !food.held, JSON.stringify(food));
    assert.deepEqual(food.phases.map(p => p.split(':')[0]), ['go', 'take', 'back', 'eat'], JSON.stringify(food.phases));
    assert.ok(food.phases[1] === 'take:take:donut' && food.phases[3] === 'eat:eat:donut', JSON.stringify(food.phases));
    assert.ok(food.took && food.done && food.done.ok === true && food.done.reason === 'done', JSON.stringify(food));
    assert.deepEqual(food.after, { pose: null, carry: null, act: null, sitting: true });
    assert.ok(food.alphaStarted && food.heldDone && food.heldDone.ok === false && food.heldDone.reason === 'held', JSON.stringify(food));
    assert.ok(food.alphaTrip === null && food.alphaAct === null);
    assert.equal(food.betaPose, 'type');
    pass('foodTrip: idle life to the kitchen spot (take), back to the desk (eat), done; a hold ends it; refused while working; lean-in pose draws');

    // Decided ping pong: gamma wins 3-1 (p1 = alpha).
    const plan = await page.evaluate(() => [
        window._lifeGamePlan({ statusKey: 'a' }, { statusKey: 'b' }, { winner: 'b', score: '1-3' }, 3),
        window._lifeGamePlan({ statusKey: 'a' }, { statusKey: 'b' }, { winner: 'a', score: [2, 1] }, 2),
        window._lifeGamePlan({ statusKey: 'a' }, { statusKey: 'b' }, { winner: 'a' }, 3)]);
    assert.deepEqual(plan[0], { winner: 'p2', points: ['p2', 'p1', 'p2', 'p2'] });
    assert.deepEqual(plan[1], { winner: 'p1', points: ['p1', 'p2', 'p1'] });
    assert.deepEqual(plan[2].points, ['p1', 'p1', 'p1']);
    await page.evaluate(() => {
        const H = window.VOLifeHost;
        window.__game = null;
        H.hold('alpha', 'tournament'); H.hold('gamma', 'tournament');
        H.startPong('alpha', 'gamma', { winner: 'gamma', score: '1-3', ms: 8000,
            onEnd: r => { window.__game = r; H.release('alpha'); H.release('gamma'); },
            onAbort: reason => {
                const a = window.agentMap.alpha, g = window.agentMap.gamma;
                window.__game = { aborted: reason, a: [a.x, a.y, a.targetX, a.targetY], g: [g.x, g.y, g.targetX, g.targetY], table: window.PONG_TABLE };
            } });
    });
    await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
    const game = await page.evaluate(() => window.__game);
    assert.deepEqual(game, { winner: 'gamma', p1Score: 1, p2Score: 3 });
    pass('ping pong with a decided result: gamma wins 3-1 as planned (onEnd), players released');

    // stopGame: a decided game still on the table is stopped by name (onAbort 'stopped', not 'moved').
    const stop = await page.evaluate(async () => {
        const H = window.VOLifeHost;
        let aborted = null;
        H.hold('alpha', 'tournament'); H.hold('gamma', 'tournament');
        const started = H.startPong('alpha', 'gamma', { winner: 'alpha', score: '3-0', ms: 8000, onAbort: (reason, key) => { aborted = [reason, key]; } });
        const during = H.gameOf('gamma');
        const stopped = H.stopGame('gamma');
        const out = { started, during, stopped, aborted, after: H.gameOf('alpha'), again: H.stopGame('gamma'),
            held: H.held('alpha') && H.held('gamma'), idle: window.agentMap.alpha.idleAction };
        H.release('alpha'); H.release('gamma');
        return out;
    });
    assert.deepEqual(stop, { started: true, during: 'pong', stopped: true, aborted: ['stopped', 'gamma'], after: null, again: false, held: true, idle: null });
    pass('stopGame: ends a decided game by name (onAbort "stopped"), players stay held by their script');

    // Idle pacing once everyone is back and nothing moves.
    await page.waitForFunction(() => window.agents.every(a => Math.abs(a.targetX - a.x) < 0.5 && Math.abs(a.targetY - a.y) < 0.5 && !a._lifeHold), null, { timeout: 25000 });
    await page.waitForTimeout(500);
    // Only frames decided while the scene was idle (not busy, not dirty) count, over the idle time
    // only: a short life animation inside the window (busy, full rate) no longer skews the rate.
    const pacing = await page.evaluate(() => new Promise(resolve => {
        const real = _shouldDrawFrame, t0 = performance.now();
        let lastAt = 0, idleMs = 0, idleDraws = 0, busyDraws = 0;
        _shouldDrawFrame = function (now) {
            const busy = _sceneDirty || _sceneIsBusy();
            const draw = real(now);
            if (lastAt && !busy) idleMs += now - lastAt;
            lastAt = now;
            if (draw) { if (busy) busyDraws++; else idleDraws++; }
            if (idleMs >= 2000 || now - t0 > 10000) {
                _shouldDrawFrame = real;
                resolve({ idleDraws, busyDraws, idleMs: Math.round(idleMs) });
            }
            return draw;
        };
    }));
    assert.ok(pacing.idleMs >= 1000, `enough idle time observed: ${JSON.stringify(pacing)}`);
    const idleFps = pacing.idleDraws / (pacing.idleMs / 1000);
    assert.ok(idleFps <= 37.5, `idle frame rate expected (~30 fps), got ${idleFps.toFixed(1)} fps: ${JSON.stringify(pacing)}`);
    pass(`frame pacing: idle rate when nothing moves (${pacing.idleDraws} idle draws in ${pacing.idleMs} idle ms, ${pacing.busyDraws} busy draws not counted)`);

    assert.deepEqual(errors, [], errors.join('\n'));
    pass('no page errors with Office life on');
    await context.close();
}

// ---------- B: Office life off + a 429 stream ----------
const lifeB = { state: lifeState({ enabled: false }), seq: 100, pending: [], streamUrls: [], stateReads: 0, streamStatus: 429 };
{
    const { context, page, errors } = await openOffice(lifeB);
    await page.waitForTimeout(1500);
    const off = await page.evaluate(() => ({ drawn: window.__life.drawn, offClass: document.documentElement.classList.contains('vo-life-off'),
        enabled: window.VOLife.enabled(), click: window.VOLife.click(10, 10, false), busy: window.VOLife.isBusy(),
        layerShown: (() => { const l = document.getElementById('voLifeLayer'); return !!l && getComputedStyle(l).display !== 'none'; })(),
        mode: window.VOLife._debug().mode }));
    assert.equal(off.drawn, 0);
    assert.equal(off.offClass, true);
    assert.equal(off.enabled, false);
    assert.equal(off.click, false);
    assert.equal(off.busy, false);
    assert.equal(off.layerShown, false);
    pass('enabled:false: nothing drawn, no clicks taken, the layer is hidden');
    assert.equal(off.mode, 'poll');
    assert.ok(lifeB.streamUrls.length === 1, 'one stream attempt, then no retry storm');
    pass('stream refused with 429: falls back to reading /state (no reconnect storm)');
    // v0.10.1 B2: the stream is tried again within seconds (not 5 minutes) and comes back once a slot is free.
    const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await page.waitForTimeout(100); } return cond(); };
    assert.ok(await waitFor(() => lifeB.streamUrls.length >= 2, 3000), 'second stream attempt within about 2 s of the 429');
    assert.equal(lifeB.streamUrls.length, 2, 'backoff: no third attempt yet');
    lifeB.streamStatus = 200;
    assert.ok(await waitFor(async () => (await page.evaluate(() => window.VOLife._debug().mode)) === 'stream', 6000),
        'stream mode again once a slot is free');
    assert.equal(await page.evaluate(() => window.VOLife._debug().tries429), 0);
    assert.ok(lifeB.streamClients.every((c) => /^p[a-z0-9]{8,}$/.test(c) && c === lifeB.streamClients[0]),
        'every stream request carries the same page id: ' + lifeB.streamClients.join(','));
    pass('after a 429 the stream retries in seconds with backoff and returns when a slot frees (page id sent)');
    // Turned on (saved, then applied here like the settings form does): features draw again.
    lifeB.state = lifeState({ enabled: true });
    await page.evaluate(() => window.VOLife.applySettings({ enabled: true }));
    await page.waitForFunction(() => window.__life.drawn > 0, null, { timeout: 5000 });
    pass('switching Office life on again draws at once');
    assert.deepEqual(errors, [], errors.join('\n'));
    await context.close();
}

await browser.close();
console.log(`life canvas tests passed (${results.length})`);
