// v0.13 deskart: the desk-top spots of every desk variant (app/furniture-variants/desk.js) stay off the
// keyboard, the screens and their feet and the other things standing on the top, in every turn; a seated
// variant's hips sit close enough for the hands to reach the keys (review 11-13). Plain node, no browser.
//   node tests/test_v13_deskart_spots.mjs [--ids developer,trader]
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '../app/furniture-variants/desk.js'), 'utf8');
const window = {};
new Function('window', src)(window);
const ids = (() => { const i = process.argv.indexOf('--ids'); return i > 0 ? process.argv[i + 1].split(',') : null; })();
const turnXY = (x, y, rot) => { const c = Math.round(Math.cos(rot * Math.PI / 180)), s = Math.round(Math.sin(rot * Math.PI / 180)); return [x * c - y * s, x * s + y * c]; };
const turn = (r, rot) => { if (!rot) return r; const a = turnXY(r[0], r[1], rot), b = turnXY(r[0] + r[2], r[1] + r[3], rot); return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])]; };
const hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
let fails = 0, n = 0;
const ok = (c, m) => { n++; if (!c) { fails++; console.log('FAIL ' + m); } };
// the sprites' plan footprints round a spot (plan point): the desk item ~16 x 5, a drink ~10 x 5, papers ~16 x 9
const SPR = { item: [-8, -2, 16, 5], food: [-5, -2, 10, 5], papers: [-8, -4, 16, 9] };
// the deskvar reference variants (analyst, gamer, standing) keep the classic seat and their own spots: --ids to include them
const REFERENCE = ['analyst', 'gamer', 'standing'];
(window.VO_FURNITURE_VARIANTS || []).filter(d => d.type === 'desk' && (ids ? ids.includes(d.id) : !REFERENCE.includes(d.id))).forEach(d => {
    const M = d.manifest, P = M.projection, S = M.surface, top = P.parts.find(p => p.name === 'top');
    const lift = top.z + top.h;
    const things = P.parts.filter(p => (p.name === 'keyboard' || (p.z >= lift - 1 && p.name !== 'top') ) && !p.seat).map(p => ({ name: p.name, plan: p.plan, low: p.h <= 3 && p.name !== 'keyboard' }));
    (d.screens || []).forEach((sc, i) => { things.push({ name: 'screen' + i, plan: sc.plan }); if (sc.foot) things.push({ name: 'foot' + i, plan: sc.foot }); });
    (M.avoid || []).forEach((r, i) => things.push({ name: 'avoid' + i, plan: r }));
    [0, 90, 180, 270].forEach(rot => {
        const sp = rot ? S.spotsAt[rot] : S.spots;
        ['item', 'food', 'papers'].forEach(k => {
            const s = sp[k], px = [s[0], s[1] + lift], o = SPR[k], box = [px[0] + o[0], px[1] + o[1], o[2], o[3]];
            const tt = turn(top.plan, rot);
            ok(px[0] >= tt[0] && px[0] <= tt[0] + tt[2] && px[1] >= tt[1] && px[1] <= tt[1] + tt[3], `${d.id}/${rot} ${k} (${s}) on the top`);
            // turned: game.js _deskTopRect lifts the turned top by its own z + h (v0.13 finish; it was the seated 21)
            if (rot && k !== 'papers') ok(s[1] >= tt[1] - lift && s[1] <= tt[1] + tt[3] - lift, `${d.id}/${rot} ${k} (${s}) inside _deskTopRect (lift ${lift})`);
            // the papers lie flat: they may overlap a low flat thing (a mat, a pad), never a screen, a foot or an upright
            things.forEach(t => { if (k === 'papers' && t.low) return; const r = turn(t.plan, rot); ok(!hit(box, r), `${d.id}/${rot} ${k} (${s}) clear of ${t.name} [${r}]`); });
        });
        const a = sp.item, b = sp.food;
        ok(!hit([a[0] - 8, a[1] - 2, 16, 5], [b[0] - 5, b[1] - 2, 10, 5]), `${d.id}/${rot} item and drink apart`);
    });
    // reach (review 11-13): the hands land on the keyboard. Body origin: seated hips - 1 + 8, standing the feet. Back view
    // (rotation 0): the forearms end 26 px over the origin; front view (behind a 180 desk): the hands hang 3 px over it.
    // Screen y + lift = the plan y on the top.
    const kb = P.parts.find(p => p.name === 'keyboard'), se = M.seats && M.seats[0];
    ok(!!se && !!kb, `${d.id} has its own seat and a keyboard part`);
    if (se && kb) {
        const o0 = d.seat === 'sit' ? se.y + 7 : se.y, o180 = d.seat === 'sit' ? se.at[180].y + 7 : se.at[180].y;
        const h0 = o0 - 26 + lift, h180 = o180 - 3 + lift, k180 = turn(kb.plan, 180);
        ok(h0 >= kb.plan[1] && h0 <= kb.plan[1] + kb.plan[3], `${d.id}/0 hands (plan y ${h0}) on the keyboard ${kb.plan[1]}..${kb.plan[1] + kb.plan[3]}`);
        ok(h180 >= k180[1] && h180 <= k180[1] + k180[3], `${d.id}/180 hands (plan y ${h180}) on the keyboard ${k180[1]}..${k180[1] + k180[3]}`);
    }
});
console.log(`test_v13_deskart_spots: ${n - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
