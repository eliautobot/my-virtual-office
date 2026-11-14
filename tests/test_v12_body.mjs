// v0.12 body: tops, neckwear, side-view body, full-body costumes, Studio outfit tiles and saving.
// Renders the real agent art through VOOffice.renderAgentPreview (hermetic page, fixtures) and
// counts pixels. Every check fails on rc-v0.11.0 (no BODY_LOOKS table, 14 px side strip, no badge
// in profile, no new tops / neckwear / costumes).
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v12_body';
const browser = await launch(NAME);
const R = reporter();
// Every section runs even when an earlier one fails, so a run on rc-v0.11.0 shows each one failing.
const failed = [];
async function section(name, fn) {
    try { await fn(); R.pass(name); } catch (e) { failed.push(name); console.log('[FAIL] ' + name + ': ' + String(e.message).slice(0, 300)); }
}
try {
    const { page, errors } = await openPage(browser);
    await page.evaluate(() => new Promise(res => _voLazyLoad('studio', res)));
    await page.waitForFunction(() => window.VOOffice && typeof window.VOOffice.renderAgentPreview === 'function', null, { timeout: 15000 });

    // 1. One table, read by drawing and Studio; unknown or missing values fall back to today's look.
    await section('one body-look table; unknown or missing tops, neckwear and costumes fall back to today\'s look', async () => {
    const table = await page.evaluate(() => {
        if (typeof BODY_LOOKS === 'undefined') return null;
        const ids = l => l.map(o => o.id);
        return {
            tops: ids(BODY_LOOKS.tops), neck: ids(BODY_LOOKS.neckwear), cos: ids(BODY_LOOKS.costumes),
            fall: [_lookTop({}), _lookTop({ shirtStyle: 'toga' }), _lookTop(null), _lookNeckwear({ neckwear: 'cravat' }),
                _lookNeckwear({ neckwear: 'none' }), _lookCostume({ costume: 'yeti' }), _lookCostume({ costume: 'ghost' })],
            tee: (() => { const t = _topColors({}, '#1e88e5'), x = document.createElement('canvas').getContext('2d'), n = v => { x.fillStyle = '#000000'; x.fillStyle = v; return x.fillStyle; };
                return t.hand === null && n(t.torso) === '#1e88e5' && n(t.shade) === n(darken('#1e88e5', 0.12)) && n(t.sleeve) === n(darken('#1e88e5', 0.2)) && n(t.fore) === n(darken('#1e88e5', 0.3)); })()
        };
    });
    assert.ok(table, 'BODY_LOOKS table exists');
    assert.deepEqual(table.tops, ['tee', 'hoodie', 'suit', 'labcoat', 'sweater', 'vest', 'blouse']);
    assert.deepEqual(table.neck, ['none', 'scarf', 'tie', 'bowtie', 'necklace']);
    assert.deepEqual(table.cos, ['none', 'lobster', 'chicken', 'ghost', 'santa', 'astronaut', 'dino']);
    assert.deepEqual(table.fall, ['tee', 'tee', 'tee', null, null, null, 'ghost']);
    assert.ok(table.tee, 'the tee keeps today\'s colours');
    });

    // Pixel helper in the page: render a look and report colour boxes in art pixels.
    await page.evaluate(() => {
        window.__v12 = (look, opts, colors) => {
            const c = document.createElement('canvas'), S = 4;
            window.VOOffice.renderAgentPreview(c, look, Object.assign({ scale: S, width: 200, height: 260, dpr: 1, floor: false, color: '#1e88e5' }, opts));
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, out = {};
            const hx = c.getContext('2d'), want = {};
            for (const k in colors) { hx.fillStyle = '#000000'; hx.fillStyle = colors[k]; want[parseInt(String(hx.fillStyle).slice(1), 16)] = k; } // rgb() or hex
            for (const k in colors) out[k] = { n: 0, x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, rows: {} };
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] < 200) continue;
                const k = want[(d[i] << 16) | (d[i + 1] << 8) | d[i + 2]]; if (!k) continue;
                const p = i / 4, x = Math.floor((p % c.width) / S), y = Math.floor(Math.floor(p / c.width) / S), o = out[k];
                o.n++; o.x0 = Math.min(o.x0, x); o.x1 = Math.max(o.x1, x); o.y0 = Math.min(o.y0, y); o.y1 = Math.max(o.y1, y);
                (o.rows[y] = o.rows[y] || []).push(x);
            }
            for (const k in out) { out[k].n = Math.round(out[k].n / (S * S)); out[k].w = out[k].x1 - out[k].x0 + 1; }
            return out;
        };
    });

    // 2. Side view: a torso with depth, the badge on the chest, the near arm swinging from the shoulder.
    await section('side view: torso with depth, badge on the chest, arm swinging from the shoulder', async () => {
    const side = await page.evaluate(() => {
        const look = { skinTone: '#ffcc80', hairStyle: 'bald', heldItem: null, costume: null };
        const cols = { torso: '#1e88e5', sleeve: darken('#1e88e5', 0.2), badge: '#eceff1' };
        const res = {};
        for (const f of ['left', 'right']) res[f] = window.__v12(look, { facing: f, pose: 'stand' }, cols);
        const mid = r => { const xs = r || []; return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
        const arm = t => { const o = window.__v12(look, { facing: 'right', pose: 'walk', time: t }, cols).sleeve, ys = Object.keys(o.rows).map(Number).sort((a, b) => a - b);
            return { top: mid(o.rows[ys[0]]), bottom: mid(o.rows[ys[ys.length - 1]]) }; };
        res.fwd = arm(134); res.back = arm(400);
        return res;
    });
    for (const f of ['left', 'right']) {
        assert.ok(side[f].torso.w >= 15, f + ': the profile torso is at least 15 px deep ' + JSON.stringify(side[f].torso.w));
        assert.ok(side[f].badge.n >= 8, f + ': the badge shows on the chest in profile ' + JSON.stringify(side[f].badge));
    }
    const lean = s => s.bottom - s.top;
    assert.ok(lean(side.fwd) >= 3 && lean(side.back) <= -3, 'walking: the arm swings from the shoulder (hand forward, then back) ' + JSON.stringify([side.fwd, side.back]));
    });

    // Pixel diff helper: art pixels that differ between two looks in the same pose and view.
    await page.evaluate(() => {
        window.__v12diff = (a, b, opts) => {
            const px = look => { const c = document.createElement('canvas');
                window.VOOffice.renderAgentPreview(c, look, Object.assign({ scale: 2, width: 100, height: 130, dpr: 1, floor: false, color: '#1e88e5' }, opts));
                return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
            const A = px(a), B = px(b); let n = 0;
            for (let i = 0; i < A.length; i += 4) if (A[i] !== B[i] || A[i + 1] !== B[i + 1] || A[i + 2] !== B[i + 2] || A[i + 3] !== B[i + 3]) n++;
            return Math.round(n / 4);
        };
    });
    const BASE = { skinTone: '#ffcc80', hairStyle: 'bald', heldItem: null, costume: null };
    const POSES = [['down', 'stand'], ['up', 'stand'], ['left', 'stand'], ['right', 'stand'], ['right', 'walk'], ['left', 'walk'], ['up', 'type'], ['down', 'sit']];

    // 3. Tops: every top shows in every view and pose (standing x 4, walking in profile, seated from behind, seated facing us).
    await section('tops: hoodie, suit, lab coat, sweater and vest show in every view and pose; sleeves follow the top', async () => {
        const res = await page.evaluate(([BASE, POSES]) => {
            const out = {};
            for (const top of ['hoodie', 'suit', 'labcoat', 'sweater', 'vest', 'blouse'])
                for (const [f, pose] of POSES) out[top + ' ' + f + ' ' + pose] = window.__v12diff(BASE, Object.assign({}, BASE, { shirtStyle: top }), { facing: f, pose, time: 134 });
            const sl = {};
            for (const [f, pose] of POSES) sl[f + ' ' + pose] = window.__v12(Object.assign({}, BASE, { shirtStyle: 'labcoat' }), { facing: f, pose, time: 134 }, { s: '#e3e7ea' }).s.n;
            const tee = window.__v12diff(BASE, Object.assign({}, BASE, { shirtStyle: 'tee' }), { facing: 'down', pose: 'stand' });
            return { out, sl, tee };
        }, [BASE, POSES]);
        const weak = Object.entries(res.out).filter(([, n]) => n < 6);
        assert.deepEqual(weak, [], 'each top differs from the tee by at least 6 art px in every view and pose');
        const bare = Object.entries(res.sl).filter(([, n]) => n < 4);
        assert.deepEqual(bare, [], 'lab coat sleeves are white in every view and pose ' + JSON.stringify(res.sl));
        assert.equal(res.tee, 0, 'shirtStyle tee draws exactly today\'s look');
    });

    // 4. Neckwear: scarf in every view; tie and bow tie in front and profile, not from behind; hidden by a costume.
    await section('neckwear: scarf, tie and bow tie in every view that shows them, in the chosen colour', async () => {
        const res = await page.evaluate(([BASE]) => {
            const out = {};
            for (const nw of ['scarf', 'tie', 'bowtie', 'necklace'])
                for (const f of ['down', 'up', 'left', 'right'])
                    out[nw + ' ' + f] = window.__v12(Object.assign({}, BASE, { neckwear: nw, neckwearColor: '#ff00ff' }), { facing: f, pose: 'stand' }, { n: '#ff00ff' }).n.n;
            out.walk = window.__v12(Object.assign({}, BASE, { neckwear: 'scarf', neckwearColor: '#ff00ff' }), { facing: 'right', pose: 'walk', time: 134 }, { n: '#ff00ff' }).n.n;
            out.seatedBack = window.__v12(Object.assign({}, BASE, { neckwear: 'scarf', neckwearColor: '#ff00ff' }), { facing: 'up', pose: 'type' }, { n: '#ff00ff' }).n.n;
            out.costume = window.__v12(Object.assign({}, BASE, { neckwear: 'tie', neckwearColor: '#ff00ff', costume: 'lobster' }), { facing: 'down', pose: 'stand' }, { n: '#ff00ff' }).n.n;
            return out;
        }, [BASE]);
        for (const f of ['down', 'up', 'left', 'right']) assert.ok(res['scarf ' + f] >= 10, 'scarf ' + f + ' ' + JSON.stringify(res));
        for (const nw of ['tie', 'bowtie']) {
            for (const f of ['down', 'left', 'right']) assert.ok(res[nw + ' ' + f] >= 3, nw + ' ' + f + ' ' + JSON.stringify(res));
            assert.equal(res[nw + ' up'], 0, nw + ' does not show from behind');
        }
        for (const f of ['down', 'left', 'right']) assert.ok(res['necklace ' + f] >= 3, 'necklace ' + f + ' ' + JSON.stringify(res)); // 0.12.0
        assert.ok(res.walk >= 10 && res.seatedBack >= 10, 'scarf walking and seated from behind ' + JSON.stringify(res));
        assert.equal(res.costume, 0, 'a costume hides the neckwear');
    });

    // 5. Costumes: ghost, santa, astronaut and dino cover the whole body in every view and pose (their colours
    // on the torso, sleeves, gloves, trousers and shoes; the head piece over the head); lobster and chicken get
    // a real profile instead of the front hood.
    await section('costumes: ghost, santa, astronaut, dino in every view and pose; lobster and chicken in profile', async () => {
        const res = await page.evaluate(([BASE, POSES]) => {
            const KEY = { ghost: ['#f5f5f5', '#e4e7e9'], santa: ['#d32f2f', '#c62828'], astronaut: ['#eceff1', '#e0e5e8'], dino: ['#43a047', '#3d9142'] };
            const out = {};
            for (const cos in KEY) for (const [f, pose] of POSES) {
                const o = window.__v12(Object.assign({}, BASE, { costume: cos }), { facing: f, pose, time: 134, color: '#ad1457' }, { torso: KEY[cos][0], pants: KEY[cos][1], skin: '#ffcc80', shirt: '#ad1457' }); // agent colour unused by any costume
                out[cos + ' ' + f + ' ' + pose] = [o.torso.n, o.pants.n, o.skin.n, o.shirt.n];
            }
            const sprite = (cos, view) => { const c = document.createElement('canvas'); c.width = 80; c.height = 80; const g = c.getContext('2d'); g.translate(40, 60);
                _drawCostume(g, cos, view); return Array.from(g.getImageData(0, 0, 80, 80).data); };
            const same = (a, b) => a.every((v, i) => v === b[i]);
            const mirror = (a) => { const o = a.slice(); for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) for (let k = 0; k < 4; k++) o[(y * 80 + x) * 4 + k] = a[(y * 80 + 79 - x) * 4 + k]; return o; };
            const prof = {};
            for (const cos of ['lobster', 'chicken', 'ghost', 'santa', 'astronaut', 'dino']) {
                const fr = sprite(cos, 'front'), r = sprite(cos, 'right'), l = sprite(cos, 'left'), b = sprite(cos, 'back');
                prof[cos] = { sideIsFront: same(fr, r), mirrored: same(mirror(r), l), backIsFront: same(fr, b), drawn: r.some((v, i) => i % 4 === 3 && v > 0) };
            }
            return { out, prof };
        }, [BASE, POSES]);
        for (const [k, [torso, pants, skin, shirt]] of Object.entries(res.out)) {
            assert.ok(torso >= 40, k + ': costume colour covers the body ' + torso);
            assert.equal(shirt, 0, k + ': no shirt colour shows through');
            const legsShow = !/ (up type)$/.test(k);                       // at the desk from behind the chair hides the legs
            if (legsShow) assert.ok(pants >= 6, k + ': the trousers follow the costume ' + pants);
            if (k.startsWith('ghost') || k.startsWith('astronaut')) assert.ok(k.startsWith('ghost') ? skin === 0 : true, k + ': the sheet hides the face and hands ' + skin);
        }
        for (const [cos, p] of Object.entries(res.prof)) {
            assert.ok(p.drawn && !p.sideIsFront && !p.backIsFront, cos + ': its own profile and back ' + JSON.stringify(p));
            assert.ok(p.mirrored, cos + ': left is the mirror of right ' + JSON.stringify(p));
        }
    });

    await section('no page errors', async () => assert.deepEqual(errors, []));
    if (failed.length) throw new Error(failed.length + ' section(s) failed: ' + failed.join(' / '));
} finally {
    await browser.close();
}
R.done(NAME);
