// v0.13 standing reach (deskart API REQUEST 3 + 4): a working agent at every standing desk and standing boss desk
// (FURNITURE_VARIANTS rows with seat 'stand'), every rotation (0 from behind, 90 / 270 in profile, 180 from the front),
// the work animations that use the keys (plain typing, typing bursts, the mouse): the hands, found as pixels (drawn
// white, then black), land on the variant's keyboard / mouse (its 'keyboard' projection part and its mouse spot, turned
// and lifted onto its top), not on the top's front apron. 180: the hands hidden behind the screens or on the keys,
// never past them. Profile: no hand behind the back. The lift is for the hands on the desk only: a desk idle pose
// (stretch, phone) draws the same arms at every standing desk, a sleeper keeps the hands off the keys and at the body
// (every standing desk, every rotation). _deskTopRect lifts a turned standing top by its own height (the top part's
// z + h), not the seated desk's 21.
//   node tests/test_v13_standreach.mjs [--report]
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v13_standreach';
const REPORT = process.argv.includes('--report');
const R = reporter();
const browser = await launch(NAME);
try {
    const { page, errors } = await openPage(browser, { viewport: { width: 1400, height: 900 } });
    await page.waitForTimeout(1200);
    const res = await page.evaluate(() => {
        const out = [], ok = (c, m) => out.push([!!c, m]), rep = [];
        const orig = window._topColors, wa0 = window._workAnim;
        window._topColors = function (look, color) { const r = orig(look, color); return window.__rc ? Object.assign({}, r, window.__rc) : r; };
        const B = { x: 200, y: 180, w: 200, h: 190 };
        function draw(item, tick, col, keep, anim, state, extra) {
            window._workAnim = () => anim;
            const a = agents[0];
            officeConfig.furniture = [item];
            a.appearance = Object.assign({}, getDefaultAppearance(a), { costume: null, heldItem: null, hairStyle: 'short', shirtStyle: 'tee' });
            if (!keep) Object.assign(a, { isSitting: true, idleAction: null, meetingId: null, carryItem: null, _lifeCarry: null, _lifeExtra: false,
                _seatCache: null, _seatT: 1, _seatFrom: null, _forceView: null, _lastSeat: null, _swv: null, _dIdle: null, notify: false,
                waitingApprovalCount: 0, activeToolCount: 0, _activityFrame: -1, _react: null, _sigMove: null, _slk: null });
            Object.assign(a, { tick, state: state || 'working', _lifePose: null, _lifePoseData: null, _offlineSprites: null, _offlinePass: false }, extra ? extra(tick) : {});
            a.x = a.targetX = a._prevTargetX = item.x; a.y = a.targetY = a._prevTargetY = item.y; a.desk = { x: item.x, y: item.y };
            agentChatData[a.statusKey] = [{ role: 'assistant', text: '', tools: state === 'idle' ? [] : [{ name: 'exec', status: 'running' }] }];
            const c = document.createElement('canvas'); c.width = B.w; c.height = B.h;
            const g = c.getContext('2d'), s = window.ctx; window.ctx = g; window.__rc = col;
            try {
                g.setTransform(1, 0, 0, 1, -B.x, -B.y); g.fillStyle = '#d3c8b8'; g.fillRect(B.x, B.y, B.w, B.h);
                drawFurnitureItem(item, { staticOnly: true });
                const ents = [a].concat(_tallFurnitureEntries()); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
            } finally { window.ctx = s; window.__rc = null; }
            return c.getContext('2d').getImageData(0, 0, B.w, B.h).data;
        }
        // hand pixels (desk-local) over a few ticks of one work animation
        function hands(item, anim, state, extra) {
            const set = new Set();
            for (const tick of [10, 19, 28, 47, 66, 85]) {
                const p = draw(item, tick, { hand: '#ffffff' }, false, anim, state, extra), q = draw(item, tick, { hand: '#000000' }, true, anim, state, extra);
                for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2])
                    set.add(((i >> 2) % B.w + B.x - item.x) + ',' + (Math.floor((i >> 2) / B.w) + B.y - item.y));
            }
            return [...set].map(s => s.split(',').map(Number));
        }
        const box = pts => pts.length ? [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))] : null;
        const ctr = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
        const inside = (p, r, t) => p[0] >= r[0] - t && p[0] <= r[0] + r[2] - 1 + t && p[1] >= r[1] - t && p[1] <= r[1] + r[3] - 1 + t;
        const union = (a, b) => { const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]); return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0]; };
        // the variant's keys (keyboard part) and mouse (rotation-0 spot, a lifted point) on its top, turned (screen, desk-local)
        function kit(M, rot) {
            const P = M.projection.parts, top = P.find(p => p.name === 'top'), L = top.z + top.h, kb = P.find(p => p.name === 'keyboard');
            const k = _projTurn(kb.plan, rot), keys = [k[0], k[1] - L, k[2], k[3]];
            const ms = M.surface.spots.mouse, mp = _rotXY(ms[0], ms[1] + L, rot), mouse = [mp[0] - 2, mp[1] - L - 3, 5, 6];
            return { keys, mouse, area: union(keys, mouse), L, front: _projTurn(top.plan, rot) };
        }
        const rows = [], idle = {}, still0 = window._rxStill;
        for (const type of ['desk', 'bossDesk']) for (const row of FURNITURE_VARIANTS[type]) if (row.seat === 'stand') rows.push([type, row]);
        ok(rows.length >= 5, `standing rows: ${rows.map(r => r[1].key).join(', ')}`);
        for (const [type, row] of rows) {
            const M = FURNITURE_MANIFEST[row.key];
            for (const rot of [0, 90, 180, 270]) {
                const item = { id: 'sr', type, variant: row.id, x: 300, y: 290, rotation: rot }, S = DESK_SEAT[row.key][rot], K = kit(M, rot), tag = `${row.key} ${rot}`;
                for (const anim of ['type', 'burst', 'scroll']) {
                    const pts = hands(item, anim);
                    rep.push(`${tag} ${anim} hands ${box(pts)} area ${K.area} feet ${S.hx},${S.hy}`);
                    if (rot === 0) {
                        const L = box(pts.filter(p => p[0] < S.hx)), Rr = box(pts.filter(p => p[0] >= S.hx));
                        if (anim === 'scroll') ok(Rr && inside(ctr(Rr), K.mouse, 2), `${tag} ${anim}: the right hand ${Rr} on the mouse ${K.mouse}`);
                        else ok(L && Rr && inside(ctr(L), K.area, 1) && inside(ctr(Rr), K.area, 1), `${tag} ${anim}: hands ${L} / ${Rr} on the keyboard / mouse ${K.area}`);
                    } else if (rot === 180) {
                        const past = pts.filter(p => !inside(p, K.area, 1));
                        ok(!past.length, `${tag} ${anim}: the hands hidden behind the screens or on the keys ${K.area} (${past.length} px past them, ${box(past)})`);
                    } else {
                        const dir = S.view === 'left' ? -1 : 1, back = pts.filter(p => (p[0] - S.hx) * dir < 0), fp = pts.filter(p => (p[0] - S.hx) * dir >= 0), fwd = box(fp);
                        const on = anim === 'scroll' ? fp.some(p => inside(p, K.area, 3)) : fwd && inside(ctr(fwd), K.area, 2);
                        ok(!back.length && fwd && on, `${tag} ${anim}: the hands ${fwd} forward on the keyboard / mouse ${K.area} (${back.length} px behind the back)`);
                    }
                }
                // a desk idle pose (not working): its own arms, the same at every standing desk (no lift), rotation 0
                if (rot === 0) for (const kind of ['stretch', 'phone']) {
                    const b = box(hands(item, null, 'idle', t => ({ _dIdle: { kind, t0: t - 40 } })));
                    const rel = b && [b[0] - S.hx, b[1] - S.hy, b[2] - S.hx, b[3] - S.hy].join(',');
                    rep.push(`${tag} idle ${kind} hands ${b} rel ${rel}`);
                    idle[kind] = idle[kind] || {}; (idle[kind][rel] = idle[kind][rel] || []).push(row.key);
                }
                // asleep (offline): the hands off the keys and at the body
                window._rxStill = () => true;
                try {
                    const pts = hands(item, 'type', 'offline'), onKeys = pts.filter(p => inside(p, K.keys, 0)).length;
                    const out = pts.length ? Math.max(...pts.map(p => Math.abs(p[0] - S.hx))) : 0;
                    ok(!onKeys && out <= 16, `${tag} asleep: the hands off the keys ${K.keys} (${onKeys} px there) and at the body (${out} px out)`);
                } finally { window._rxStill = still0; }
                // _deskTopRect: a turned top lifted by its own z + h (spots on it are checked against the real top face)
                const t = _deskTopRect(item), tp = _projTurn(M.projection.parts.find(p => p.name === 'top').plan, rot);
                if (rot) ok(t.y - item.y === tp[1] - K.L && t.h === tp[3], `${tag}: _deskTopRect ${t.x - item.x},${t.y - item.y},${t.w},${t.h} = the turned top lifted by ${K.L}`);
            }
        }
        for (const kind of Object.keys(idle)) {
            const groups = Object.keys(idle[kind]);
            ok(groups.length === 1 && groups[0] !== 'null', `desk idle '${kind}' at a standing desk: the same arms at every standing desk, not lifted (${JSON.stringify(idle[kind])})`);
        }
        window._workAnim = wa0;
        return { out, rep };
    });
    if (REPORT) console.log(res.rep.join('\n'));
    let bad = 0;
    for (const [c, m] of res.out) { if (c) R.pass(m); else { bad++; console.log('FAIL ' + m); } }
    assert.deepEqual(errors, [], 'page errors');
    assert.equal(bad, 0, bad + ' standing reach checks failed');
    R.done(NAME);
} finally {
    await browser.close();
}
