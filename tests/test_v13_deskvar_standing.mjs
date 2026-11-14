#!/usr/bin/env node
// v0.13 standing desks, the day of a standing worker in a real office (seeded page, Office life with needs-you and
// click reactions, the world invariant on every step), at a standing desk at 0 and one turned 90:
//  1. works standing: the stand pose (no chair) with the work animation running (typing taps over time);
//  2. needs you: leaves the desk (gets up on the stand seat's floor point, never through the desk), walks to the
//     front and holds up the needs-you sign; when the need closes it walks back and steps in standing again;
//  3. asleep (offline): stays at the desk on its feet, the work animation stops (a standing sleeper dozes standing:
//     head down, Zs; the v13 sleep pose decides its arms), wakes back to work.
// The walk in, the spin (signature move) and the wave are in tests/test_v13_deskvar_variants.mjs.
// Fails on 0.12 (no standing desk). Run: node tests/test_v13_deskvar_standing.mjs
import assert from 'node:assert/strict';
import { openOffice, checker, defaultOffice } from './v12_pets_page.mjs';

const T = checker();
const P = [['s0', 'Sam'], ['s1', 'Sid']];
const ROSTER = P.map(([k, n]) => ({ id: k, statusKey: k, name: n, emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }));
const STATUS = Object.fromEntries(P.map(([k]) => [k, { state: 'working', task: 'Standing up for once', activeToolCount: 1 }]));
const OFF = ['interns', 'handoffs', 'visitors', 'alarmClock', 'moods', 'celebrations', 'standup', 'seasons', 'tournaments', 'newspaper'];
const LIFE = { ok: true, seq: 1, day: '2026-11-04', tz: 'UTC', settings: { enabled: true, calm: false, timeZone: 'UTC',
    features: Object.assign(Object.fromEntries(OFF.map(k => [k, false])), { reactions: true, needsYou: true }) },
    open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], cake: false }, paper: { day: '2026-11-04', ready: false } };
const office = defaultOffice();
office.canvasWidth = 1200; office.canvasHeight = 800; office.walls.interior = [];
office.furniture = [
    { id: 's0', type: 'desk', variant: 'standing', x: 400, y: 400, assignedTo: 'Sam' },
    { id: 's1', type: 'desk', variant: 'standing', color: 'black', x: 800, y: 400, rotation: 90, assignedTo: 'Sid' }];

const o = await openOffice('test_v13_deskvar_standing', { office, agents: ROSTER, status: STATUS, seed: 21, extra: { '/api/office-life/state': LIFE } }, { width: 1600, height: 1000 });
const { page } = o;
const at = (id) => page.evaluate((id) => { const a = agents.find(q => q.id === id), f = officeConfig.furniture.find(x => x.id === id), P = a._lastSeat, s = _deskSeatSpot(f);
    return { x: Math.round(a.x), y: Math.round(a.y), fx: f.x, fy: f.y, sit: a.isSitting, stand: !!(P && P.stand), view: P && P.view, chair: P ? P.chair : 'none', work: a._workNow || null,
        hold: a._lifeHold ? a._lifeHold.kind : null, pose: a._lifePose || null, state: a.state, floor: [f.x + s.floor[0], f.y + s.floor[1]] }; }, id);
try {
    await page.waitForFunction(() => agents.length === 2 && agents.every(a => a.isSitting && a._lastSeat && a._lastSeat.stand), null, { timeout: 30000, polling: 250 }).catch(() => {});

    await T.check('works standing: stand pose, no chair, the work animation runs (typing taps change over time)', async () => {
        for (const id of ['s0', 's1']) {
            const s = await at(id);
            assert.ok(s.sit && s.stand && s.chair === null && s.work, id + ' ' + JSON.stringify(s));
        }
        // the typing taps: the agent's pixels at its desk change between frames (the hands tap)
        const r = await page.evaluate(async () => {
            const a = agents.find(q => q.id === 's0'), c = document.getElementById('officeCanvas'), g = c.getContext('2d');
            const grab = () => { _lastDrawAt = -1e9; _sceneDirty = true; _renderFrame(performance.now()); const p = _worldToCanvas(a.x - 20, a.y - 60), q = _worldToCanvas(a.x + 20, a.y + 4), K = c.width / c.getBoundingClientRect().width;
                return g.getImageData(Math.round(p.x * K), Math.round(p.y * K), Math.max(1, Math.round((q.x - p.x) * K)), Math.max(1, Math.round((q.y - p.y) * K))).data; };
            const seen = new Set();
            for (let i = 0; i < 16; i++) { const d = grab(); let h = 0; for (let k = 0; k < d.length; k += 4) h = (Math.imul(h, 31) + d[k] + d[k + 1] * 3 + d[k + 2] * 7) | 0; seen.add(h); await new Promise(res => setTimeout(res, 120)); }
            return seen.size;
        });
        assert.ok(r >= 2, 'the standing worker moves while working: ' + r + ' distinct frames');
    });

    await T.check('needs you: leaves the standing desk from its floor point, walks to the front, holds up the sign', async () => {
        const firstSteps = await page.evaluate(() => { const a = agents.find(q => q.id === 's0'); window.__steps = [];
            const orig = a.update.bind(a); a.update = function () { const r = orig(); if (window.__steps.length < 400) window.__steps.push([Math.round(a.x), Math.round(a.y), a.isSitting ? 1 : 0]); return r; };
            VOLifeNeeds.onEvent({ type: 'needs.open', agent: 's0', ref: 'ap1', need: 'approval', session: 'agent:s0:main' }); return true; });
        await page.waitForFunction(() => { const a = agents.find(q => q.id === 's0'); return a._lifePose === 'sign' && !a.isSitting; }, null, { timeout: 15000, polling: 200 }).catch(() => {});
        const s = await at('s0');
        const path = await page.evaluate(() => window.__steps);
        const up = path.find(p => !p[2]);   // the first step off the desk
        assert.ok(firstSteps && s.hold === 'needs' && s.pose === 'sign' && !s.sit, 'holding the sign: ' + JSON.stringify(s));
        assert.ok(Math.hypot(s.x - s.fx, s.y - s.fy) > 80, 'walked away from the desk: ' + JSON.stringify(s));
        assert.ok(up && Math.hypot(up[0] - s.floor[0], up[1] - s.floor[1]) <= 6, 'got up on the floor point ' + JSON.stringify(s.floor) + ', first step ' + JSON.stringify(up));
        const s1 = await at('s1');
        assert.ok(s1.sit && s1.stand && s1.work, 'the other worker keeps working: ' + JSON.stringify(s1));
    });

    await T.check('the need closes: walks back and stands at the desk working again', async () => {
        await page.evaluate(() => VOLifeNeeds.onEvent({ type: 'needs.close', agent: 's0', ref: 'ap1', need: 'approval' }));
        await page.waitForFunction(() => { const a = agents.find(q => q.id === 's0'); return a.isSitting && a._lastSeat && a._lastSeat.stand && a._workNow && !a._lifeHold; }, null, { timeout: 20000, polling: 200 }).catch(() => {});
        const s = await at('s0');
        assert.ok(s.sit && s.stand && s.chair === null && s.work && !s.hold && s.x === s.fx && s.y === s.fy && s.view === 'up', JSON.stringify(s));
    });

    await T.check('asleep (offline): stays on its feet at the desk, the work animation stops; wakes back to work', async () => {
        STATUS.s0.state = 'offline'; STATUS.s1.state = 'offline';
        await page.waitForFunction(() => agents.every(a => a.state === 'offline'), null, { timeout: 15000, polling: 250 }).catch(() => {});
        await page.waitForTimeout(800);
        for (const id of ['s0', 's1']) {
            const s = await at(id);
            assert.ok(s.state === 'offline' && s.sit && s.stand && s.chair === null && !s.work && s.x === s.fx && s.y === s.fy, id + ' asleep standing: ' + JSON.stringify(s));
        }
        STATUS.s0.state = 'working'; STATUS.s1.state = 'working';
        await page.waitForFunction(() => agents.every(a => a.state === 'working' && a._workNow && a._lastSeat && a._lastSeat.stand), null, { timeout: 15000, polling: 250 }).catch(() => {});
        const s = await at('s0');
        assert.ok(s.state === 'working' && s.stand && s.work, 'awake and working: ' + JSON.stringify(s));
    });

    await T.check('the world invariant never fired; no page errors', async () => {
        const hits = await page.evaluate(() => (window.VOWorld && VOWorld.log ? VOWorld.log() : []).slice(0, 5));
        assert.deepEqual(hits, []);
        assert.deepEqual(o.errors, []);
    });
} finally {
    await o.close();
}
if (T.failures) { console.log('FAILED test_v13_deskvar_standing: ' + T.failures); process.exit(1); }
console.log('OK test_v13_deskvar_standing');
