// v0.13 seat reach (review 11-13: "agents should be moved up in the desk sitting position so they actually reach the
// mouse and keyboard ... the chair and sitting position should be closer into the actual table"). A working agent at
// the classic desk and the classic boss desk, every rotation (0 from behind, 90 / 270 in profile, 180 from the front),
// the work animations that use the keys (plain typing, typing bursts, the mouse): the hands, found as pixels (drawn
// white, then black), land on the keyboard / mouse area of the desk art (the keys and the mouse as drawn: DESK_PLAN /
// BOSS_PLAN, turned and lifted onto the top), not on the top's front edge. 180: the hands are hidden behind the
// screens or on the keys, never reaching past them. Profile: no hand behind the back. The chair (rotation 0) tucks
// in under the top, its back below the keyboard (hands and keys in view); seated variants without their own seat share the type's chair.
// The reference variants that inherit the seat (analyst, gamer, command) reach their keyboard / mouse at rotation 0.
// A standing desk's sleeper keeps the arms down / folded, off the keys.
//   node tests/test_v13_seatreach.mjs
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v13_seatreach';
const R = reporter();
const browser = await launch(NAME);
try {
    const { page, errors } = await openPage(browser, { viewport: { width: 1400, height: 900 } });
    await page.waitForTimeout(1200);
    const res = await page.evaluate(() => {
        const out = [], ok = (c, m) => out.push([!!c, m]);
        const orig = window._topColors, wa0 = window._workAnim;
        window._topColors = function (look, color) { const r = orig(look, color); return window.__rc ? Object.assign({}, r, window.__rc) : r; };
        const B = { x: 200, y: 190, w: 200, h: 170 };
        function draw(type, rot, tick, col, keep, anim) {
            window._workAnim = () => anim;
            const item = { id: 'reach', type, x: 300, y: 300, rotation: rot }, a = agents[0];
            officeConfig.furniture = [item];
            a.appearance = Object.assign({}, getDefaultAppearance(a), { costume: null, heldItem: null, hairStyle: 'short', shirtStyle: 'tee' });
            if (!keep) Object.assign(a, { isSitting: true, idleAction: null, meetingId: null, carryItem: null, _lifeCarry: null, _lifeExtra: false,
                _seatCache: null, _seatT: 1, _seatFrom: null, _forceView: null, _lastSeat: null, _swv: null, _dIdle: null, notify: false,
                waitingApprovalCount: 0, activeToolCount: 0, _activityFrame: -1, _react: null, _sigMove: null, _slk: null });
            Object.assign(a, { tick, state: 'working', _lifePose: null, _lifePoseData: null });
            a.x = a.targetX = a._prevTargetX = item.x; a.y = a.targetY = a._prevTargetY = item.y; a.desk = { x: item.x, y: item.y };
            agentChatData[a.statusKey] = [{ role: 'assistant', text: '', tools: [{ name: 'exec', status: 'running' }] }];
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
        function hands(type, rot, anim) {
            const set = new Set();
            for (const tick of [10, 19, 28, 47, 66, 85]) {
                const p = draw(type, rot, tick, { hand: '#ffffff' }, false, anim), q = draw(type, rot, tick, { hand: '#000000' }, true, anim);
                for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2])
                    set.add(((i >> 2) % B.w + B.x - 300) + ',' + (Math.floor((i >> 2) / B.w) + B.y - 300));
            }
            return [...set].map(s => s.split(',').map(Number));
        }
        const box = pts => pts.length ? [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))] : null;
        const ctr = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
        const inside = (p, r, t) => p[0] >= r[0] - t && p[0] <= r[0] + r[2] - 1 + t && p[1] >= r[1] - t && p[1] <= r[1] + r[3] - 1 + t;
        const union = (a, b) => { const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]); return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0]; };
        // the keys and the mouse as the classic art draws them (screen, desk-local)
        function kit(type, rot) {
            const P = type === 'desk' ? DESK_PLAN : BOSS_PLAN, k = _projTurn(P.keys, rot), keys = [k[0], k[1] - 21, k[2], k[3]];
            let mouse;
            if (type === 'desk') mouse = rot ? DESK_PLAN.mouse[rot].slice() : [18, -20, 5, 7];
            else { const m = _projTurn(P.mouse, rot); mouse = [m[0], m[1] - 21, m[2], m[3]]; }
            return { keys, mouse, area: union(keys, mouse) };
        }
        for (const type of ['desk', 'bossDesk']) for (const rot of [0, 90, 180, 270]) {
            const S = DESK_SEAT[type][rot], K = kit(type, rot), tag = `${type} ${rot}`;
            for (const anim of ['type', 'burst', 'scroll']) {
                const pts = hands(type, rot, anim);
                if (rot === 0) {
                    const L = box(pts.filter(p => p[0] < S.hx)), Rr = box(pts.filter(p => p[0] >= S.hx));
                    if (anim === 'scroll') ok(Rr && inside(ctr(Rr), K.mouse, 1), `${tag} ${anim}: the right hand ${Rr} on the mouse ${K.mouse}`);
                    else ok(L && Rr && inside(ctr(L), K.area, 1) && inside(ctr(Rr), K.area, 1), `${tag} ${anim}: hands ${L} / ${Rr} on the keyboard / mouse ${K.area}`);
                } else if (rot === 180) {
                    const out180 = pts.filter(p => !inside(p, K.area, 1));
                    ok(!out180.length, `${tag} ${anim}: the hands hidden behind the screens or on the keys ${K.area} (${out180.length} px past them, ${box(out180)})`);
                } else {
                    // profile (a coarser sprite): typing hands centred on the keys / mouse within 2 px; the mouse hand (scroll, the
                    // wheel finger reaching on) touches the area within 3 px; never a hand behind the back
                    const dir = S.view === 'left' ? -1 : 1, back = pts.filter(p => (p[0] - S.hx) * dir < 0), fp = pts.filter(p => (p[0] - S.hx) * dir >= 0), fwd = box(fp);
                    const on = anim === 'scroll' ? fp.some(p => inside(p, K.area, 3)) : fwd && inside(ctr(fwd), K.area, 2);
                    ok(!back.length && fwd && on, `${tag} ${anim}: the hands ${fwd} forward on the keyboard / mouse ${K.area} (${back.length} px behind the back)`);
                }
            }
            if (rot === 0) {
                // the chair back (drawn in front of the desk, _drawChairRearFront: top = hips - 9, boss - 11) stays below the keys
                const top = S.hy - (type === 'bossDesk' ? 11 : 9), kb = K.keys[1] + K.keys[3] - 1;
                ok(top > kb + 1, `${tag}: the chair back (top ${top}) below the keyboard's front row (${kb}): the hands and keys stay in view`);
            }
        }
        // seated variants without their own seat: the type's chair; the reference variants reach their keys at 0
        for (const type of ['desk', 'bossDesk']) for (const row of FURNITURE_VARIANTS[type]) {
            if (row.id === 'classic' || row.seat !== 'sit') continue;
            const def = (window.VO_FURNITURE_VARIANTS || []).find(d => d.type === type && d.id === row.id), M = FURNITURE_MANIFEST[row.key];
            if (def && def.manifest && def.manifest.seats) continue;
            const ch = p => (p.projection.parts || []).find(q => q.seat);
            ok(JSON.stringify(ch(M).plan) === JSON.stringify(ch(FURNITURE_MANIFEST[type]).plan) && DESK_SEAT[row.key][0].hy === DESK_SEAT[type][0].hy,
                `${row.key}: inherits the ${type} seat and its chair (${ch(M).plan})`);
        }
        window._workAnim = wa0;
        return out;
    });
    // the reference variants, drawn as placed (variant field), rotation 0: hands on their keyboard / mouse spots
    const res2 = await page.evaluate(() => {
        const out = [], ok = (c, m) => out.push([!!c, m]);
        const orig = window._topColors, wa0 = window._workAnim;
        window._topColors = function (look, color) { const r = orig(look, color); return window.__rc ? Object.assign({}, r, window.__rc) : r; };
        window._workAnim = () => 'type';
        const B = { x: 200, y: 190, w: 200, h: 170 };
        for (const [type, id] of [['desk', 'analyst'], ['desk', 'gamer'], ['bossDesk', 'command']]) {
            const key = type + '~' + id, M = FURNITURE_MANIFEST[key];
            if (!M) continue;
            const set = new Set(), a = agents[0], item = { id: 'rv', type, variant: id, x: 300, y: 300 };
            for (const tick of [10, 28, 66]) {
                const px = [];
                for (const col of ['#ffffff', '#000000']) {
                    officeConfig.furniture = [item];
                    Object.assign(a, { isSitting: true, idleAction: null, meetingId: null, _lastSeat: null, _seatT: 1, _seatFrom: null, _forceView: null, _swv: null, _dIdle: null,
                        notify: false, _sigMove: null, _slk: null, _react: null, tick, state: 'working', _lifePose: null });
                    a.x = a.targetX = a._prevTargetX = 300; a.y = a.targetY = a._prevTargetY = 300; a.desk = { x: 300, y: 300 };
                    const c = document.createElement('canvas'); c.width = B.w; c.height = B.h;
                    const g = c.getContext('2d'), s = window.ctx; window.ctx = g; window.__rc = { hand: col };
                    try {
                        g.setTransform(1, 0, 0, 1, -B.x, -B.y); g.fillStyle = '#d3c8b8'; g.fillRect(B.x, B.y, B.w, B.h);
                        drawFurnitureItem(item, { staticOnly: true });
                        const ents = [a].concat(_tallFurnitureEntries()); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
                    } finally { window.ctx = s; window.__rc = null; }
                    px.push(c.getContext('2d').getImageData(0, 0, B.w, B.h).data);
                }
                for (let i = 0; i < px[0].length; i += 4) if (px[0][i] !== px[1][i]) set.add(((i >> 2) % B.w + B.x - 300) + ',' + (Math.floor((i >> 2) / B.w) + B.y - 300));
            }
            const pts = [...set].map(s => s.split(',').map(Number)), S = DESK_SEAT[key][0], sp = M.surface.spots;
            const L = pts.filter(p => p[0] < S.hx), Rr = pts.filter(p => p[0] >= S.hx);
            const cy = q => q.reduce((t, p) => t + p[1], 0) / q.length, cx = q => q.reduce((t, p) => t + p[0], 0) / q.length;
            // spots of the keys / mouse (a variant without them draws the type's: BOSS_PLAN keys / mouse, lifted 21)
            const kc = sp.keyboard || [0, 5], mc = sp.mouse || [20, 5];
            const kb = [kc[0] - 15, kc[1] - 5, 30, 10], ms = [mc[0] - 4, mc[1] - 5, 8, 10];
            const inK = q => q.length && cx(q) >= kb[0] && cx(q) <= kb[0] + kb[2] && cy(q) >= kb[1] && cy(q) <= kb[1] + kb[3];
            const inM = q => q.length && cy(q) >= ms[1] && cy(q) <= ms[1] + ms[3];
            ok(inK(L) && (inK(Rr) || inM(Rr)), `${key} 0: hands (${L.length && [cx(L), cy(L)].map(Math.round)} / ${Rr.length && [cx(Rr), cy(Rr)].map(Math.round)}) on the keyboard ${kc} / mouse ${mc}`);
        }
        window._workAnim = wa0;
        return out;
    });
    // a standing desk's sleeper (deskvar open item after the sleeppose merge): the arms down / folded, off the keys
    const res3 = await page.evaluate(() => {
        const out = [], ok = (c, m) => out.push([!!c, m]);
        if (!FURNITURE_MANIFEST['desk~standing']) return out;
        const orig = window._topColors, wa0 = window._workAnim, still0 = window._rxStill;
        window._topColors = function (look, color) { const r = orig(look, color); return window.__rc ? Object.assign({}, r, window.__rc) : r; };
        window._workAnim = () => 'type'; window._rxStill = () => true;   // the sleep pose without its ease
        const B = { x: 200, y: 170, w: 200, h: 200 };
        const hands = (rot, state) => {
            const set = new Set(), a = agents[0], item = { id: 'st', type: 'desk', variant: 'standing', x: 300, y: 300, rotation: rot };
            let cx = null;
            for (const tick of [10, 28, 66]) {
                const px = [];
                for (const col of ['#ffffff', '#000000']) {
                    officeConfig.furniture = [item];
                    Object.assign(a, { isSitting: true, idleAction: null, meetingId: null, _lastSeat: null, _seatT: 1, _seatFrom: null, _forceView: null, _swv: null, _dIdle: null,
                        notify: false, waitingApprovalCount: 0, _sigMove: null, _slk: null, _react: null, tick, state, _lifePose: null, _offlineSprites: null, _offlinePass: false });
                    a.x = a.targetX = a._prevTargetX = 300; a.y = a.targetY = a._prevTargetY = 300; a.desk = { x: 300, y: 300 };
                    const c = document.createElement('canvas'); c.width = B.w; c.height = B.h;
                    const g = c.getContext('2d'), sv = window.ctx; window.ctx = g; window.__rc = { hand: col };
                    try {
                        g.setTransform(1, 0, 0, 1, -B.x, -B.y); g.fillStyle = '#d3c8b8'; g.fillRect(B.x, B.y, B.w, B.h);
                        drawFurnitureItem(item, { staticOnly: true });
                        const ents = [a].concat(_tallFurnitureEntries()); ents.sort(_entitySortCompare); _drawSortedGroup(ents);
                    } finally { window.ctx = sv; window.__rc = null; }
                    px.push(c.getContext('2d').getImageData(0, 0, B.w, B.h).data);
                    if (a._bodyBox) cx = a._bodyBox.x + 17 - 300;
                }
                for (let i = 0; i < px[0].length; i += 4) if (px[0][i] !== px[1][i]) set.add(((i >> 2) % B.w + B.x - 300) + ',' + (Math.floor((i >> 2) / B.w) + B.y - 300));
            }
            return { pts: [...set].map(q => q.split(',').map(Number)), cx };
        };
        for (const rot of [0, 90, 180, 270]) {
            const awake = hands(rot, 'working').pts, asleep = hands(rot, 'offline');
            const box = awake.length ? [Math.min(...awake.map(p => p[0])), Math.min(...awake.map(p => p[1])), Math.max(...awake.map(p => p[0])), Math.max(...awake.map(p => p[1]))] : null;
            const on = box ? asleep.pts.filter(p => p[0] >= box[0] - 1 && p[0] <= box[2] + 1 && p[1] >= box[1] - 1 && p[1] <= box[3] + 1).length : 0;
            const reach = asleep.cx == null ? 99 : Math.max(0, ...asleep.pts.map(p => Math.abs(p[0] - asleep.cx)));
            ok(on === 0 && reach <= 15, `standing desk ${rot}: asleep, the hands off the keys (awake hands ${box}, ${on} px there) and at the body (${reach} px out; hands ${asleep.pts.length ? [Math.min(...asleep.pts.map(p => p[0])), Math.min(...asleep.pts.map(p => p[1])), Math.max(...asleep.pts.map(p => p[0])), Math.max(...asleep.pts.map(p => p[1]))] : 'hidden'}, body x ${asleep.cx})`);
        }
        window._topColors = orig; window._workAnim = wa0; window._rxStill = still0;
        return out;
    });
    let bad = 0;
    for (const [pass, msg] of res.concat(res2, res3)) { if (pass) R.pass(msg); else { bad++; console.log('FAIL ' + msg); } }
    assert.deepEqual(errors, [], 'page errors');
    assert.equal(bad, 0, bad + ' seat reach checks failed');
    R.done(NAME);
} finally {
    await browser.close();
}
