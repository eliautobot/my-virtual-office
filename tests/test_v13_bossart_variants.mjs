// v0.13 bossart: the boss desk family (app/furniture-variants/boss-desk.js) beyond classic + command.
// For every bossart variant: a menu row (label, info, >= 2 colours that exist), a manifest key with a
// seat in all 4 turns; seated: the hands reach the keys and the mouse seen from behind (review 11-13: "sit
// closer so the hands reach the mouse and keyboard"), the chair as close as the classic boss desk's (seatreach);
// standing: a stand seat in every turn; every screen listed as a monitor rect that is drawn (lit) at
// rotation 0, inside the art box; the desk-top spots (item, drink, papers) off the keyboard, the mouse
// and the monitor feet. Geometry, art box, footprints and layering: test_v10_world_contract.mjs.
//   node tests/test_v13_bossart_variants.mjs
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v13_bossart_variants';
const MINE = ['executive', 'glass', 'producer', 'architect', 'captain', 'zen', 'dataops', 'gaming', 'exec-standing', 'war-table'];
const R = reporter();
const browser = await launch(NAME);
try {
    const { page } = await openPage(browser, { viewport: { width: 1400, height: 900 } });
    await page.waitForTimeout(1200);
    const res = await page.evaluate((MINE) => {
        const out = [], ok = (c, m) => out.push([!!c, m]);
        const rows = FURNITURE_VARIANTS.bossDesk, have = rows.map(r => r.id);
        const hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
        const cl = DESK_SEAT.bossDesk[0];
        MINE.filter(id => have.includes(id)).forEach(id => {
            const row = rows.find(r => r.id === id), key = row.key, M = FURNITURE_MANIFEST[key], S = DESK_SEAT[key];
            const def = (window.VO_FURNITURE_VARIANTS || []).find(d => d.type === 'bossDesk' && d.id === id);
            ok(row.label && row.label.length <= 24 && row.info && row.info.length >= 30, `${id}: label + info (${row.label})`);
            ok(row.colors.length >= 2 && row.colors.every(c => FURNITURE_COLORS[c]) && row.colors.length === def.colors.length, `${id}: ${row.colors.length} colours, all known`);
            ok(M && S && [0, 90, 180, 270].every(r => S[r]), `${id}: manifest + seat in every turn`);
            const sp = M.surface.spots;
            const kb = [sp.keyboard[0] - 14, sp.keyboard[1] - 4, 28, 8], ms = [sp.mouse[0] - 3, sp.mouse[1] - 4, 6, 8];
            if (row.seat === 'sit') {
                // seen from behind (game.js Agent.draw, desk seat 'up'): body origin (hx, hy + 7); the left hand
                // ends at (-15, -26), the right on the mouse at (18, -27): desk-local (hx - 15, hy - 19), (hx + 18, hy - 20)
                const s = S[0], L = [s.hx - 15, s.hy - 19], Rh = [s.hx + 18, s.hy - 20];
                ok(L[0] >= kb[0] - 2 && L[0] <= kb[0] + kb[2] && L[1] >= kb[1] && L[1] <= kb[1] + kb[3] - 2, `${id}: left hand ${L} on the keys ${kb} (upper rows)`);
                ok(Math.abs(Rh[0] - sp.mouse[0]) <= 3 && Math.abs(Rh[1] - sp.mouse[1]) <= 4, `${id}: right hand ${Rh} on the mouse ${sp.mouse}`);
                // v0.13 seatreach: the classic boss desk now sits as close (REACH 6): at least as close as the classic, not doubled
                ok(s.hy <= cl.hy && S[180].hy >= DESK_SEAT.bossDesk[180].hy, `${id}: chair as close in as the classic (0: ${s.hy} <= ${cl.hy}, 180: ${S[180].hy} >= ${DESK_SEAT.bossDesk[180].hy})`);
                ok(!S[0].stand, `${id}: seated`);
            } else {
                ok([0, 90, 180, 270].every(r => S[r].stand), `${id}: standing in every turn`);
                // standing, seen from behind: the body origin on the feet (hx, hy), the hands at (-15, -26) / (18, -27)
                const s = S[0], L = [s.hx - 15, s.hy - 26], Rh = [s.hx + 18, s.hy - 27];
                ok(L[0] >= kb[0] - 2 && L[0] <= kb[0] + kb[2] && L[1] >= kb[1] && L[1] <= kb[1] + kb[3], `${id}: standing left hand ${L} on the keys ${kb}`);
                ok(Math.abs(Rh[0] - sp.mouse[0]) <= 3 && Math.abs(Rh[1] - sp.mouse[1]) <= 4, `${id}: standing right hand ${Rh} on the mouse ${sp.mouse}`);
                // 180: the forearms onto the near edge, hands ~3 px over the feet: on the turned keys
                const k180 = M.surface.spots.keyboard, s180 = S[180], kt = _projTurn([kb[0], kb[1] + 30, kb[2], kb[3]], 180);
                ok(s180.hy - 3 >= kt[1] - 30 - 2 && s180.hy - 3 <= kt[1] + kt[3] - 30 + 2, `${id}: 180 hands (y ${s180.hy - 3}) on the turned keys (${kt[1] - 30}..${kt[1] + kt[3] - 30})`);
            }
            // screens: every screen is a monitor rect, inside the art box and lit at rotation 0
            const mons = M.monitors || [];
            ok(def.screens && mons.length === def.screens.length && mons.length >= 1, `${id}: ${mons.length} monitor rects = screens`);
            ok(mons.every((m, i) => !def.screens[i].bc || m.bc === def.screens[i].bc), `${id}: the live overlay keeps each screen's bezel colour (bc)`);
            const it = { id: 'b', type: 'bossDesk', variant: id, x: 300, y: 300 }, a = _getItemWorldRect(it);
            const c = document.createElement('canvas'); c.width = 700; c.height = 700;
            const g = c.getContext('2d'), saved = window.ctx, inUse = window._deskInUse;
            window._deskInUse = () => true; window.ctx = g;
            try { drawFurnitureItem(it, { staticOnly: true }); } finally { window.ctx = saved; window._deskInUse = inUse; }
            mons.forEach((m, i) => {
                ok(300 + m.bx >= a.x && 300 + m.bx + m.bw <= a.x + a.w && 300 + m.by >= a.y, `${id}: monitor ${i} inside the art box`);
                const px = g.getImageData(300 + m.x + (m.w >> 1), 300 + m.y + (m.h >> 1), 1, 1).data;
                ok(px[3] === 255 && px[2] > px[0], `${id}: monitor ${i} screen drawn (${px.slice(0, 3)})`);
            });
            // desk-top spots at rotation 0 off the keyboard, the mouse and the monitor feet (sprite boxes)
            const foot = (M.monitorPlan.foot || []).map(f => [f[0], f[1] - M.monitorPlan.top, f[2], f[3]]);
            const boxes = { item: [sp.item[0] - 9, sp.item[1] - 7, 18, 14], food: [sp.food[0] - 7, sp.food[1] - 7, 13, 14], papers: [sp.papers[0] - 6, sp.papers[1] - 4, 12, 8] };
            Object.keys(boxes).forEach(k => {
                const b = boxes[k], bad = [['keyboard', kb], ['mouse', ms]].concat(foot.map((f, i) => ['foot ' + i, f])).filter(o => hit(b, o[1]));
                ok(!bad.length, `${id}: ${k} spot ${sp[k]} clear of ${bad.map(o => o[0]).join(', ') || 'keys, mouse, feet'}`);
            });
        });
        // bossdepth (review 11-13: "the boss desk is too wide on the 0deg view ... the 180 deg has better width"): the
        // desk top's front-to-back depth as drawn (the real draw calls: the largest fillRect spanning >= 60 px along
        // the desk's width) is the same at 0 and 180 (and 90 / 270) for every boss desk, and no variant's top is
        // deeper than 40 px (the classic boss desk, game.js, keeps its 48 for now)
        {
            const c2 = document.createElement('canvas'); c2.width = 600; c2.height = 600;
            const g2 = c2.getContext('2d'), fr = g2.fillRect.bind(g2), saved2 = window.ctx, inUse2 = window._deskInUse;
            let rec = null;
            g2.fillRect = function (x, y, w, h) { const m = g2.getTransform(); if (rec) rec.push([w * m.a, h * m.d]); return fr(x, y, w, h); };
            window._deskInUse = () => true;
            try {
                rows.forEach(r => {
                    const d = {};
                    [0, 90, 180, 270].forEach(rot => {
                        rec = []; window.ctx = g2; g2.setTransform(1, 0, 0, 1, 300, 300);
                        drawFurnitureItem({ id: 'd', type: 'bossDesk', variant: r.id, x: 0, y: 0, rotation: rot, color: r.colors[0] }, { staticOnly: true });
                        window.ctx = saved2;
                        let best = null;
                        rec.forEach(q => { if ((rot % 180 ? q[1] : q[0]) >= 60 && (!best || q[0] * q[1] > best[0] * best[1])) best = q; });
                        d[rot] = best ? Math.round(rot % 180 ? best[0] : best[1]) : 0;
                        rec = null;
                    });
                    ok(d[0] >= 20 && Math.abs(d[0] - d[180]) <= 2 && Math.abs(d[90] - d[270]) <= 2, `${r.id}: top depth 0: ${d[0]} = 180: ${d[180]} (90: ${d[90]}, 270: ${d[270]})`);
                    if (r.id !== 'classic') ok(Math.max(d[0], d[90], d[180], d[270]) <= 40, `${r.id}: top no deeper than 40 px (${d[0]})`);
                });
            } finally { window.ctx = saved2; window._deskInUse = inUse2; }
        }
        ok(MINE.filter(id => have.includes(id)).length >= 1, 'bossart variants present: ' + MINE.filter(id => have.includes(id)).join(','));
        return out;
    }, MINE);
    let bad = 0;
    res.forEach(([ok, m]) => { if (ok) R.pass(m); else { bad++; console.log('FAIL ' + m); } });
    assert.equal(bad, 0, bad + ' bossart variant checks failed');
    R.done(NAME);
} finally {
    await browser.close();
}
