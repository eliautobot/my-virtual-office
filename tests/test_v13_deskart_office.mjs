#!/usr/bin/env node
// v0.13 deskart: the seven seated and two standing desk variants of app/furniture-variants/desk.js in a real office
// (seeded page, the world invariant on every step):
//  1. every agent walks to its variant desk and works there: seated ones on the variant's (closer) seat with its chair,
//     standing ones on their feet with no chair (180: legs hidden behind the top), in all four rotations;
//  2. the world invariant never fires (no one inside a footprint, seats reachable, clearance kept);
//  3. every screen of every multi-screen deskart variant shows the agent's state in all 4 rotations;
//  4. no page errors.
// Run: node tests/test_v13_deskart_office.mjs
import assert from 'node:assert/strict';
import { openOffice, checker, defaultOffice } from './v12_pets_page.mjs';

const T = checker();
const DESKS = [
    ['developer', 0], ['creative', 90], ['trader', 180], ['streamer', 270],
    ['retro', 90], ['maker', 180], ['cosy', 270], ['trader', 0],
    ['treadmill', 0], ['treadmill', 90], ['treadmill', 180], ['treadmill', 270],
    ['counter', 0], ['counter', 90], ['counter', 180], ['counter', 270]
];
const P = DESKS.map((d, i) => ['d' + i, 'Dee' + i]);
const ROSTER = P.map(([k, n]) => ({ id: k, statusKey: k, name: n, emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }));
const STATUS = Object.fromEntries(P.map(([k]) => [k, { state: 'working', task: 'Working at a variant desk', activeToolCount: 1 }]));
const office = defaultOffice();
office.canvasWidth = 1600; office.canvasHeight = 1320;
office.walls.interior = [];
office.walls.sections = [{ x: 0, w: 1600, color: '#37474f', accentColor: '#263238' }];
office.furniture = DESKS.map(([v, rot], i) => {
    const it = { id: 'f' + i, type: 'desk', variant: v, x: 220 + (i % 4) * 380, y: 280 + Math.floor(i / 4) * 280, assignedTo: 'Dee' + i };
    if (rot) it.rotation = rot;
    return it;
});
const o = await openOffice('test_v13_deskart_office', { office, agents: ROSTER, status: STATUS, seed: 1313 }, { width: 1600, height: 1000 });
const { page } = o;
try {
    // everyone at their desk (walking from the spawn), at most 90 s
    await page.waitForFunction(() => agents.length >= 16 && agents.every(a => a.isSitting && a.desk && Math.abs(a.x - a.desk.x) < 1 && Math.abs(a.y - a.desk.y) < 1 && a._lastSeat),
        null, { timeout: 90000, polling: 500 }).catch(() => {});
    const st = await page.evaluate(() => officeConfig.furniture.filter(f => f.type === 'desk').map(f => {
        const a = agents.find(q => q.desk && q.desk.x === f.x && q.desk.y === f.y), Pp = a && a._lastSeat, s = _deskSeatSpot(f);
        return { id: f.variant + '/' + (f.rotation || 0), key: _mk(f), at: !!(a && a.isSitting && Math.abs(a.x - f.x) < 1 && Math.abs(a.y - f.y) < 1),
            mkey: Pp && Pp.mkey, stand: !!(Pp && Pp.stand), chair: !!(Pp && Pp.chair), legs: Pp && Pp.legs, dx: Pp && Pp.dx, dy: Pp && Pp.dy,
            hx: s && s.hx, hy: s && s.hy, standSeat: !!(s && s.stand) };
    }));

    await T.check('every agent works at its variant desk (16 desks, 0/90/180/270)', async () => {
        const away = st.filter(s => !s.at || s.mkey !== s.key);
        assert.deepEqual(away.map(s => s.id + ':' + s.mkey), [], JSON.stringify(away).slice(0, 600));
    });

    await T.check('seated variants: the variant seat (closer hips) with its chair; standing: on the feet, no chair', async () => {
        const bad = st.filter(s => s.at && (s.standSeat ? !(s.stand && !s.chair && s.dx === s.hx && s.dy === s.hy && (s.id.endsWith('/180') ? s.legs === 'hidden' : s.legs === 'stand'))
            : !(!s.stand && s.dx === s.hx && s.dy === s.hy - 1 && (s.chair || s.legs === 'hidden'))));
        assert.deepEqual(bad.map(s => s.id), [], JSON.stringify(bad).slice(0, 700));
        const seated0 = st.find(s => s.id === 'developer/0');
        assert.equal(seated0.hy, 6, 'the developer desk seats the hips at y 6 (classic 13): the hands reach the keys');
    });

    await T.check('the world invariant never fired (footprints, seats, clearance)', async () => {
        const log = await page.evaluate(() => (_wr.log || []).map(v => JSON.stringify(v).slice(0, 160)));
        assert.equal(log.length, 0, log.slice(0, 4).join(' | '));
    });

    await T.check('every screen of every multi-screen deskart variant shows the state in all 4 rotations', async () => {
        const r = await page.evaluate(() => {
            const kinds = ['thinking', 'approval', 'error', 'offline'], out = [], saved = window.ctx, sa = window._deskScreenAgent, mk = window._monitorKind;
            const c = document.createElement('canvas'); c.width = 400; c.height = 400; const g = c.getContext('2d', { willReadFrequently: true });
            let kind = null; window._deskScreenAgent = () => agents[0]; window._monitorKind = () => kind ? { kind, act: null } : null;
            const MINE = ['developer', 'creative', 'trader', 'streamer', 'retro', 'maker', 'cosy', 'treadmill', 'counter'];
            try {
                FURNITURE_VARIANTS.desk.filter(row => MINE.includes(row.id)).forEach(row => {
                    [0, 90, 180, 270].forEach(rot => {
                        const it = { id: 'scr', type: 'desk', variant: row.id, x: 0, y: 0, rotation: rot };
                        const draw = (k) => { kind = k; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 400, 400); window.ctx = g; g.setTransform(1, 0, 0, 1, 200, 220);
                            try { drawFurnitureItem(it, { staticOnly: true }); if (k) _drawDeskMonitor(it); } finally { window.ctx = saved; } return g.getImageData(0, 0, 400, 400).data; };
                        const base = draw(null), imgs = kinds.map(draw), rects = _deskMonitorRects(it);
                        rects.forEach((q, j) => {
                            const bx = [], by = [];
                            if (q.w != null) { bx.push(q.x, q.x + q.w); by.push(q.y, q.y + q.h); }
                            if (q.bw != null) { bx.push(q.bx, q.bx + q.bw); by.push(q.by - 2, q.by + q.bh); }
                            const x0 = Math.floor(Math.min(...bx)), x1 = Math.ceil(Math.max(...bx)), y0 = Math.floor(Math.min(...by)), y1 = Math.ceil(Math.max(...by));
                            const diff = (a, b) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = ((y + 220) * 400 + x + 200) * 4; if (a[k] !== b[k] || a[k + 1] !== b[k + 1] || a[k + 2] !== b[k + 2]) n++; } return n; };
                            const lit = imgs.map((im, i) => kinds[i] === 'offline' && q.view === 'back' ? 2 : diff(base, im));
                            const distinct = rot === 180 ? 1 : diff(imgs[0], imgs[1]) && diff(imgs[1], imgs[2]) ? 1 : 0;
                            if (lit.some(n => n < 2) || !distinct) out.push(row.id + '/' + rot + ' screen ' + j + ' (' + (q.view || 'front') + '): ' + lit.join(',') + ' distinct ' + distinct);
                        });
                    });
                });
            } finally { window._deskScreenAgent = sa; window._monitorKind = mk; window.ctx = saved; }
            return out;
        });
        assert.deepEqual(r, [], JSON.stringify(r).slice(0, 900));
    });

    await T.check('no page errors', async () => { assert.deepEqual(o.errors, []); });
} finally {
    await o.close();
}
console.log(T.failures ? `test_v13_deskart_office: ${T.failures} failed` : 'test_v13_deskart_office: all passed');
process.exit(T.failures ? 1 : 0);
