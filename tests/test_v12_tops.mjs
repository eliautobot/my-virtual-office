// v0.12 outfits: every top reads at the office's normal size. Renders the real Agent.draw through
// VOOffice.renderAgentPreview at 1 art pixel per canvas pixel (the office at fit zoom) and counts the
// pixels that differ VISIBLY (luminance step >= 24 of 255, or one channel >= 64) between two looks
// that only change the top. Each top must differ from the tee and from every other top by a clear
// number of pixels in each view (front, back, left, right standing; walking left; seated at a desk
// seen from behind, the office's most common view), for light, mid and dark shirt colours and both
// body types. Fails on bf8594d (v12/merge): hoodie and suit (and the sweater / vest pairs) differ
// from the tee only by a 12% shade, which is invisible at normal size.
// MEASURE=1 prints the smallest counts per view instead of asserting only.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v12_tops';
const browser = await launch(NAME);
const R = reporter();
const failed = [];
async function section(name, fn) {
    try { await fn(); R.pass(name); } catch (e) { failed.push(name); console.log('[FAIL] ' + name + ': ' + String(e.message).slice(0, 600)); }
}
const TOPS = ['tee', 'hoodie', 'suit', 'labcoat', 'sweater', 'vest'];
const VIEWS = {
    front: { facing: 'down' }, back: { facing: 'up' }, left: { facing: 'left' }, right: { facing: 'right' },
    walkL: { facing: 'left', pose: 'walk', time: 240 }, deskBack: { facing: 'up', pose: 'type', withDesk: true }
};
const COLORS = ['#1e88e5', '#e53935', '#424242', '#fdd835'];
const GENDERS = ['M', 'F'];
const MIN_VS_TEE = 32, MIN_PAIR = 30, MIN_DESK = 36; // visible pixels at normal size, smallest over colours and body types
// (MIN_DESK was 40; v0.13 seat reach: the sitter sits 9 px nearer the desk, its chair 7, the arms forward on the keys:
//  less of the back and the suit's hem shows; tee vs suit from behind is 37 px for the blue M sitter, every other pair >= 40)
try {
    const { page, errors } = await openPage(browser);
    await page.evaluate(() => new Promise(res => _voLazyLoad('studio', res)));
    await page.waitForFunction(() => window.VOOffice && typeof window.VOOffice.renderAgentPreview === 'function', null, { timeout: 15000 });

    const res = await page.evaluate(([TOPS, VIEWS, COLORS, GENDERS]) => {
        const shot = (look, o) => {
            const V = o.withDesk ? { x: -40, y: -56, w: 80, h: 84 } : { x: -30, y: -60, w: 60, h: 72 }, c = document.createElement('canvas');
            window.VOOffice.renderAgentPreview(c, look, Object.assign({ view: V, scale: 1, dpr: 1, width: V.w, height: V.h, floor: false, time: 0 }, o));
            return c.getContext('2d').getImageData(0, 0, V.w, V.h).data;
        };
        const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const diff = (a, b) => {
            let n = 0;
            for (let i = 0; i < a.length; i += 4) {
                const ta = a[i + 3] > 128, tb = b[i + 3] > 128;
                if (ta !== tb) { n++; continue; }
                if (!ta) continue;
                const dl = Math.abs(lum(a, i) - lum(b, i)), dc = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
                if (dl >= 24 || dc >= 64) n++;
            }
            return n;
        };
        const out = {};   // view -> pair 'a/b' -> min over colours and genders
        const worst = {}; // view -> pair -> 'colour gender' of the min
        for (const v in VIEWS) {
            out[v] = {}; worst[v] = {};
            for (const col of COLORS) for (const g of GENDERS) {
                const img = {};
                for (const t of TOPS) img[t] = shot({ shirtStyle: t, hairStyle: 'short', hairColor: '#4e342e', skinTone: '#f1c27d' }, Object.assign({ color: col, gender: g }, VIEWS[v]));
                for (let i = 0; i < TOPS.length; i++) for (let j = i + 1; j < TOPS.length; j++) {
                    const k = TOPS[i] + '/' + TOPS[j], n = diff(img[TOPS[i]], img[TOPS[j]]);
                    if (out[v][k] === undefined || n < out[v][k]) { out[v][k] = n; worst[v][k] = col + ' ' + g; }
                }
            }
        }
        return { out, worst };
    }, [TOPS, VIEWS, COLORS, GENDERS]);

    if (process.env.MEASURE) {
        for (const v in res.out) console.log(v.padEnd(8) + Object.entries(res.out[v]).map(([k, n]) => k.replace(/labcoat/, 'lab').replace(/sweater/, 'swt').replace(/hoodie/, 'hood') + '=' + n).join(' '));
    }
    for (const v in VIEWS) {
        await section(`${v}: every top differs visibly from the tee and from every other top at normal size`, async () => {
            const bad = [];
            for (const [k, n] of Object.entries(res.out[v])) {
                const min = v === 'deskBack' ? MIN_DESK : k.startsWith('tee/') ? MIN_VS_TEE : MIN_PAIR;
                if (n < min) bad.push(`${k} ${n} < ${min} (${res.worst[v][k]})`);
            }
            assert.deepEqual(bad, []);
        });
    }

    // The tee stays today's tee: no pixel changes against a look without shirtStyle.
    await section('the tee is pixel-identical to a look without a top', async () => {
        const same = await page.evaluate(([VIEWS]) => {
            const shot = (look, o) => { const c = document.createElement('canvas'); window.VOOffice.renderAgentPreview(c, look, Object.assign({ scale: 2, dpr: 1, width: 140, height: 170, floor: false, time: 0, color: '#1e88e5' }, o)); return c.toDataURL(); };
            const bad = [];
            for (const v in VIEWS) for (const g of ['M', 'F']) {
                const base = { hairStyle: 'short', skinTone: '#f1c27d' };
                if (shot(base, Object.assign({ gender: g }, VIEWS[v])) !== shot(Object.assign({ shirtStyle: 'tee' }, base), Object.assign({ gender: g }, VIEWS[v]))) bad.push(v + ' ' + g);
            }
            return bad;
        }, [VIEWS]);
        assert.deepEqual(same, []);
    });

    await section('no page errors', async () => assert.deepEqual(errors, []));
    if (failed.length) throw new Error(failed.length + ' section(s) failed: ' + failed.join(' / '));
} finally {
    await browser.close();
}
R.done(NAME);
