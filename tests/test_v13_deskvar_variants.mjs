#!/usr/bin/env node
// v0.13 desk variants in a real office (seeded page, the world invariant on every step):
//  1. a saved office with variants + colours loads as those variants (manifest key, seat, monitors, colour), keeps
//     both fields through the layout save (POST body) and an undo snapshot, and an unknown id falls back to classic;
//  2. every screen of a multi-monitor desk shows the agent's activity, a recolour reaches the static layer;
//  3. standing desks in all 4 rotations: the agent walks to the stand seat's floor point, steps in and works standing
//     (no chair, stand legs; 180: legs hidden behind the top, the screen back over the torso), sorts on its feet,
//     turns on the spot for a spin (signature move) and to wave, and the world invariant never fires;
//  4. every variant x rotation x colour draws inside its art box with known colour slots (tools/variant_check.mjs).
// Fails on 0.12 (no FURNITURE_VARIANTS: the desks load as classic desks). Run: node tests/test_v13_deskvar_variants.mjs
import assert from 'node:assert/strict';
import { openOffice, checker, defaultOffice } from './v12_pets_page.mjs';
import { checkVariants } from './tools/variant_check.mjs';

const T = checker();
const P = [['ava', 'Ava'], ['gus', 'Gus'], ['cleo', 'Cleo'], ['s0', 'Sam'], ['s1', 'Sid'], ['s2', 'Sue'], ['s3', 'Sol'], ['cl', 'Cal']];
const ROSTER = P.map(([k, n]) => ({ id: k, statusKey: k, name: n, emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }));
const STATUS = Object.fromEntries(P.map(([k]) => [k, { state: 'working', task: 'Working on the variants', activeToolCount: 1 }]));
const office = defaultOffice();
office.canvasWidth = 1440; office.canvasHeight = 980;
office.walls.interior = [];
office.walls.sections = [{ x: 0, w: 1440, color: '#37474f', accentColor: '#263238' }];
office.furniture = [
    { id: 'va', type: 'desk', variant: 'analyst', color: 'grey', x: 220, y: 260, assignedTo: 'Ava' },
    { id: 'vg', type: 'desk', variant: 'gamer', color: 'black-cyan', x: 560, y: 260, rotation: 90, assignedTo: 'Gus' },
    { id: 'vc', type: 'bossDesk', variant: 'command', color: 'black-gold', x: 960, y: 270, rotation: 270, assignedTo: 'Cleo' },
    { id: 's0', type: 'desk', variant: 'standing', color: 'white', x: 220, y: 640, assignedTo: 'Sam' },
    { id: 's1', type: 'desk', variant: 'standing', x: 520, y: 640, rotation: 90, assignedTo: 'Sid' },
    { id: 's2', type: 'desk', variant: 'standing', color: 'walnut', x: 820, y: 640, rotation: 180, assignedTo: 'Sue' },
    { id: 's3', type: 'desk', variant: 'standing', color: 'black', x: 1120, y: 640, rotation: 270, assignedTo: 'Sol' },
    { id: 'cl', type: 'desk', variant: 'zz-retired', color: 'zz', x: 1240, y: 260, assignedTo: 'Cal' }
];

// Office life on with only the click reactions (the wave), as tests/test_v12_react.mjs
const LIFE_OFF = ['needsYou', 'interns', 'handoffs', 'visitors', 'alarmClock', 'moods', 'celebrations', 'standup', 'seasons', 'tournaments', 'newspaper'];
const LIFE = { ok: true, seq: 1, day: '2026-11-04', tz: 'UTC', settings: { enabled: true, calm: false, timeZone: 'UTC',
    features: Object.assign(Object.fromEntries(LIFE_OFF.map(k => [k, false])), { reactions: true }) },
    open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], cake: false }, paper: { day: '2026-11-04', ready: false } };
const o = await openOffice('test_v13_deskvar_variants', { office, agents: ROSTER, status: STATUS, seed: 13, extra: { '/api/office-life/state': LIFE } }, { width: 1600, height: 1000 });
const { page } = o;
try {
    await page.evaluate(() => { window.__seatGoals = {}; const orig = Agent.prototype._takeSeatFromGoal;
        Agent.prototype._takeSeatFromGoal = function () { if (this._seatGoal) window.__seatGoals[this.id] = { x: this._seatGoal.x, y: this._seatGoal.y }; return orig.apply(this, arguments); }; });
    // everyone at their desk (walking from the spawn), at most 40 s
    await page.waitForFunction(() => agents.length >= 8 && agents.every(a => a.isSitting && a.desk && Math.abs(a.x - a.desk.x) < 1 && Math.abs(a.y - a.desk.y) < 1 && a._lastSeat), null, { timeout: 40000, polling: 250 }).catch(() => {});

    await T.check('saved variants load as those variants (key, row, colour, seat, screens); an unknown id draws classic', async () => {
        const r = await page.evaluate(() => officeConfig.furniture.filter(f => f.type === 'desk' || f.type === 'bossDesk').map(f => ({ id: f.id, v: f.variant || null, c: f.color || null, key: _mk(f),
            row: _variantRow(f).id, col: _itemColor(f).id, mon: _deskMonitorRects(f).length, seatKey: (_deskSeatSpot(f) || {}).key })));
        const by = Object.fromEntries(r.map(x => [x.id, x]));
        assert.deepEqual([by.va.key, by.va.row, by.va.col, by.va.mon, by.va.seatKey], ['desk~analyst', 'analyst', 'grey', 4, 'desk~analyst']);
        assert.deepEqual([by.vg.key, by.vg.col, by.vg.mon], ['desk~gamer', 'black-cyan', 2]);
        assert.deepEqual([by.vc.key, by.vc.col, by.vc.mon, by.vc.seatKey], ['bossDesk~command', 'black-gold', 3, 'bossDesk~command']);
        assert.deepEqual([by.s1.key, by.s1.col, by.s1.mon], ['desk~standing', 'white', 1]);       // no colour = the variant's first
        assert.deepEqual([by.cl.key, by.cl.row, by.cl.col, by.cl.v, by.cl.c], ['desk', 'classic', 'wood', 'zz-retired', 'zz']); // kept, drawn classic
    });

    await T.check('a layout save and an undo snapshot keep variant and colour', async () => {
        const r = await page.evaluate(async () => {
            const snap = JSON.stringify(officeConfig);
            applyOfficeConfigSnapshot(snap);
            const back = officeConfig.furniture.map(f => [f.id, f.variant || '', f.color || ''].join(':')).join(' ');
            _lastSavedOfficeJson = ''; // an unchanged office is not posted again: force this save
            saveOfficeConfig();
            return back;
        });
        assert.match(r, /va:analyst:grey/); assert.match(r, /vc:command:black-gold/); assert.match(r, /s2:standing:walnut/);
        await page.waitForTimeout(1600);
        const post = o.posts.filter(p => p.path === '/api/office-config').pop();
        assert.ok(post, 'the layout was posted');
        const f = JSON.parse(post.body).furniture.find(x => x.id === 'vg');
        assert.deepEqual([f.variant, f.color, f.rotation], ['gamer', 'black-cyan', 90]);
    });

    await T.check('every screen of a multi-monitor desk shows the activity (analyst: 4, command: 3)', async () => {
        const r = await page.evaluate(() => ['va', 'vc'].map(id => {
            const f = officeConfig.furniture.find(x => x.id === id), saved = window.ctx;
            const c = document.createElement('canvas'); c.width = 400; c.height = 400;
            const g = c.getContext('2d', { willReadFrequently: true });
            const draw = (live) => { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 400, 400); window.ctx = g;
                g.setTransform(1, 0, 0, 1, 200 - f.x, 240 - f.y);
                try { drawFurnitureItem(f, { staticOnly: true }); if (live) _drawDeskMonitor(f); } finally { window.ctx = saved; }
                return g.getImageData(0, 0, 400, 400).data; };
            const a = draw(false), b = draw(true);
            return _deskMonitorRects(f).map(m => { let n = 0;
                for (let y = m.y; y < m.y + m.h; y++) for (let x = m.x; x < m.x + m.w; x++) { const k = ((y + 240) * 400 + x + 200) * 4; if (a[k] !== b[k] || a[k + 1] !== b[k + 1] || a[k + 2] !== b[k + 2]) n++; }
                return n; });
        }));
        assert.equal(r[0].length, 4); assert.equal(r[1].length, 3);
        r.flat().forEach((n, i) => assert.ok(n > 20, 'screen ' + i + ' changed ' + n + ' px: ' + JSON.stringify(r)));
    });

    await T.check('every screen of every multi-screen variant shows the state in all 4 rotations (thinking, approval, error, offline)', async () => {
        const r = await page.evaluate(() => {
            const kinds = ['thinking', 'approval', 'error', 'offline'], out = [], saved = window.ctx, sa = window._deskScreenAgent, mk = window._monitorKind;
            const c = document.createElement('canvas'); c.width = 400; c.height = 400; const g = c.getContext('2d', { willReadFrequently: true });
            let kind = null; window._deskScreenAgent = () => agents[0]; window._monitorKind = () => kind ? { kind, act: null } : null;
            try {
                Object.keys(FURNITURE_VARIANTS).forEach(t => FURNITURE_VARIANTS[t].forEach(row => {
                    if (FURNITURE_MANIFEST[row.key].monitors.length < 2) return;
                    [0, 90, 180, 270].forEach(rot => {
                        const it = { id: 'scr', type: t, x: 0, y: 0, rotation: rot }; if (row.id !== 'classic') it.variant = row.id;
                        const draw = (k) => { kind = k; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 400, 400); window.ctx = g; g.setTransform(1, 0, 0, 1, 200, 220);
                            try { drawFurnitureItem(it, { staticOnly: true }); if (k) _drawDeskMonitor(it); } finally { window.ctx = saved; } return g.getImageData(0, 0, 400, 400).data; };
                        const base = draw(null), imgs = kinds.map(draw), rects = _deskMonitorRects(it);
                        rects.forEach((q, j) => {
                            const bx = [], by = [];   // the screen and its bezel (+2 px above for a back's glow)
                            if (q.w != null) { bx.push(q.x, q.x + q.w); by.push(q.y, q.y + q.h); }
                            if (q.bw != null) { bx.push(q.bx, q.bx + q.bw); by.push(q.by - 2, q.by + q.bh); }
                            const x0 = Math.floor(Math.min(...bx)), x1 = Math.ceil(Math.max(...bx)), y0 = Math.floor(Math.min(...by)), y1 = Math.ceil(Math.max(...by));
                            const diff = (a, b) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = ((y + 220) * 400 + x + 200) * 4; if (a[k] !== b[k] || a[k + 1] !== b[k + 1] || a[k + 2] !== b[k + 2]) n++; } return n; };
                            const lit = imgs.map((im, i) => kinds[i] === 'offline' && q.view === 'back' ? 2 : diff(base, im));   // a casing back: no glow when off
                            const distinct = rot === 180 ? 1 : diff(imgs[0], imgs[1]) && diff(imgs[1], imgs[2]) ? 1 : 0;   // backs: one glow for every state
                            if (lit.some(n => n < 2) || !distinct) out.push(row.key + '/' + rot + ' screen ' + j + ' (' + (q.view || 'front') + '): ' + lit.join(',') + ' distinct ' + distinct);
                        });
                    });
                }));
            } finally { window._deskScreenAgent = sa; window._monitorKind = mk; window.ctx = saved; }
            return out;
        });
        assert.deepEqual(r, [], JSON.stringify(r).slice(0, 900));
    });

    await T.check('a recolour redraws the static layer (the desk top changes colour, nothing else)', async () => {
        const r = await page.evaluate(async () => {
            const f = officeConfig.furniture.find(x => x.id === 'va'), k = _mk(f);
            // the desk's area on the screen canvas (the art box), before and after: the top's pixels change
            const m = FURNITURE_MANIFEST[k], sr = m.surface.rect;
            const px = () => { _lastDrawAt = -1e9; _renderFrame(performance.now()); const c = document.getElementById('officeCanvas'), g = c.getContext('2d'); // a frame now (no frame cap)
                const a = _worldToCanvas(f.x + sr[0], f.y + sr[1]), b = _worldToCanvas(f.x + sr[0] + sr[2], f.y + sr[1] + sr[3]), K = c.width / c.getBoundingClientRect().width;
                const R = [Math.round(a.x * K), Math.round(a.y * K), Math.round((b.x - a.x) * K), Math.round((b.y - a.y) * K)];
                return { d: g.getImageData(R[0], R[1], R[2], R[3]).data, R, cw: c.width, ch: c.height }; };
            const A = px();
            editMode = true; selectedItemId = 'va';
            const ok = _setItemColor(f, 'black');
            editMode = false; selectedItemId = null;
            const B = px(); let n = 0;
            for (let i = 0; i < A.d.length; i += 4) if (A.d[i] !== B.d[i] || A.d[i + 1] !== B.d[i + 1] || A.d[i + 2] !== B.d[i + 2]) n++;
            return { changed: n, of: A.d.length / 4, R: A.R, cw: A.cw, ch: A.ch, ok, key: _mk(f), color: f.color };
        });
        assert.ok(r.ok && r.color === 'black' && r.key === 'desk~analyst', JSON.stringify(r));
        assert.ok(r.changed > r.of * 0.3, 'most of the desk top changed colour on the screen canvas: ' + JSON.stringify(r));
    });

    // the standing agents leave their desks (stand on the floor 150 px south) and walk back: the walk is recorded
    await page.evaluate(() => ['s0', 's1', 's2', 's3'].forEach(id => {
        const f = officeConfig.furniture.find(x => x.id === id), a = agents.find(q => q.desk && q.desk.x === f.x && q.desk.y === f.y);
        if (!a) return;
        a.isSitting = false; a._lastSeat = null; a._path = null; a.x = f.x; a.y = f.y + 150;
        a.targetX = a.desk.x; a.targetY = a.desk.y; a._prevTargetX = null; a._prevTargetY = null;
    }));
    await page.waitForFunction(() => ['s0', 's1', 's2', 's3'].every(id => {
        const f = officeConfig.furniture.find(x => x.id === id), a = agents.find(q => q.desk && q.desk.x === f.x && q.desk.y === f.y);
        return a && a.isSitting && a._lastSeat && Math.abs(a.x - f.x) < 1 && Math.abs(a.y - f.y) < 1 && window.__seatGoals[a.id];
    }), null, { timeout: 30000, polling: 250 }).catch(() => {});
    await page.waitForTimeout(1500); // eased onto the feet
    const stands = await page.evaluate(() => ['s0', 's1', 's2', 's3'].map(id => {
        const f = officeConfig.furniture.find(x => x.id === id), a = agents.find(q => q.desk && q.desk.x === f.x && q.desk.y === f.y);
        const s = _deskSeatSpot(f), P = a && a._lastSeat, g = a && window.__seatGoals[a.id];
        return { id, rot: f.rotation || 0, agent: a && a.id, sitting: a && a.isSitting, stand: P && P.stand, legs: P && P.legs, view: P && P.view,
            chair: P && P.chair, kind: P && P.kind, feet: [s.hx, s.hy], floor: s.floor, dx: P && P.dx, dy: P && P.dy, sortDy: a && a._sortDy,
            goal: g ? [g.x - f.x, g.y - f.y] : null, inFoot: _itemFootprints(f).some(r => f.x + s.floor[0] > r.x && f.x + s.floor[0] < r.x + r.w && f.y + s.floor[1] > r.y && f.y + s.floor[1] < r.y + r.h),
            over: P && P.over, work: a && a._workNow };
    }));
    await T.check('standing desks (0/90/180/270): the agent walked to the floor point, stands there with no chair, sorts on its feet', async () => {
        for (const s of stands) {
            assert.ok(s.agent && s.sitting, s.id + ' agent at the desk: ' + JSON.stringify(s));
            assert.equal(s.stand, true, s.id + ' stand pose');
            assert.equal(s.chair, null, s.id + ' no chair');
            assert.deepEqual([s.dx, s.dy], s.feet, s.id + ' body on the feet point');
            assert.equal(s.sortDy, s.feet[1], s.id + ' sorts on its feet');
            assert.ok(!s.inFoot, s.id + ' floor point outside the footprint');
            if (s.goal) assert.deepEqual(s.goal, s.floor, s.id + ' the walk ended at the floor point');
        }
        const by = Object.fromEntries(stands.map(s => [s.rot, s]));
        assert.deepEqual([by[0].view, by[90].view, by[180].view, by[270].view], ['up', 'right', 'down', 'left']);
        assert.deepEqual([by[0].legs, by[90].legs, by[180].legs, by[270].legs], ['stand', 'stand', 'hidden', 'stand']);
        assert.equal(by[180].over, 'monitor', 'behind a desk turned 180 the screen back is drawn over the torso');
        assert.ok(by[90].floor[0] < by[90].feet[0] && by[270].floor[0] > by[270].feet[0], 'beside a turned desk the walk ends clear of the art, then steps in');
        assert.ok(stands.filter(s => s.goal).length >= 3, 'seat goals recorded: ' + JSON.stringify(stands.map(s => s.goal)));
    });

    await T.check('a standing agent spins on the spot (signature move) and turns to wave, then goes back to work', async () => {
        const r = await page.evaluate(async () => {
            const f = officeConfig.furniture.find(x => x.id === 's0'), a = agents.find(q => q.desk && q.desk.x === f.x && q.desk.y === f.y);
            const views = new Set(); let stand = true, legs = new Set();
            _playSignature(a, { preview: true, id: 'spin' });
            for (let i = 0; i < 30; i++) { await new Promise(res => setTimeout(res, 70)); const P = a._lastSeat; if (P) { views.add(P.view); stand = stand && !!P.stand; legs.add(P.legs); } }
            const spun = [...views];
            await new Promise(res => setTimeout(res, 1500));
            _reactAgent(a, 'wave');
            const wv = new Set();
            for (let i = 0; i < 20; i++) { await new Promise(res => setTimeout(res, 60)); if (a._lastSeat) wv.add(a._lastSeat.view); }
            await new Promise(res => setTimeout(res, 3500));
            return { spun, stand, legs: [...legs], wave: [...wv], end: a._lastSeat && a._lastSeat.view, endStand: a._lastSeat && a._lastSeat.stand };
        });
        assert.ok(r.spun.length >= 3, 'the spin turns the standing body: ' + JSON.stringify(r));
        assert.ok(r.stand && !r.legs.includes('rear') && !r.legs.includes('front') && !r.legs.includes('side'), 'stays standing: ' + JSON.stringify(r));
        assert.ok(r.wave.includes('down'), 'turns to wave: ' + JSON.stringify(r));
        assert.ok(r.end === 'up' && r.endStand, 'back to work facing the desk: ' + JSON.stringify(r));
    });

    await T.check('seated variants: the chair, hips and the screen back follow the variant seat (gamer 90, command 270, analyst 0)', async () => {
        const r = await page.evaluate(() => ['va', 'vg', 'vc'].map(id => {
            const f = officeConfig.furniture.find(x => x.id === id), a = agents.find(q => q.desk && q.desk.x === f.x && q.desk.y === f.y), P = a && a._lastSeat, s = _deskSeatSpot(f);
            return { id, ok: !!(a && a.isSitting && P && !P.stand && P.mkey === _mk(f) && P.dx === s.hx), legs: P && P.legs, view: P && P.view };
        }));
        r.forEach(x => assert.ok(x.ok, JSON.stringify(r)));
    });

    await T.check('every variant x rotation x colour draws inside its art box, no unknown colour slot', async () => {
        const res = await page.evaluate(checkVariants, {});
        const bad = res.filter(x => x.bad.length).map(x => x.key + ': ' + x.bad.slice(0, 2).join('; '));
        assert.deepEqual(bad, []);
        assert.ok(res.length >= 6 && res.every(x => x.cells >= 20), JSON.stringify(res.map(x => x.key + ' ' + x.cells)));
    });

    await T.check('colours cost nothing per frame: 60 frames with every agent working draw no desk art (static layer + depth sprites)', async () => {
        const r = await page.evaluate(() => {
            const orig = window.drawFurnitureItem; let n = 0;
            window.drawFurnitureItem = function (it) { if (it && (it.type === 'desk' || it.type === 'bossDesk')) n++; return orig.apply(this, arguments); };
            try { for (let i = 0; i < 60; i++) { _lastDrawAt = -1e9; _sceneDirty = true; _renderFrame(performance.now() + i * 50); } } finally { window.drawFurnitureItem = orig; }
            return n;
        });
        assert.equal(r, 0, 'desk draws in 60 frames');
    });

    await T.check('the world invariant never fired; no page errors', async () => {
        const hits = await page.evaluate(() => (window.VOWorld && VOWorld.log ? VOWorld.log() : []).slice(0, 5));
        assert.deepEqual(hits, []);
        assert.deepEqual(o.errors, []);
    });
} finally {
    await o.close();
}
if (T.failures) { console.log('FAILED test_v13_deskvar_variants: ' + T.failures); process.exit(1); }
console.log('OK test_v13_deskvar_variants');
