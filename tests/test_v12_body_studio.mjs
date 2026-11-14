// v0.12 body: Agent Studio's Outfit tab. Picture tiles for tops, neckwear and costumes drawn by the office's
// own code (from game.js's BODY_LOOKS); outfit sets use the new tops (Scientist lab coat, Boss suit, Creative
// hoodie); four seasonal sets that change the outfit only; Randomize uses the new options; the new-agent look
// step shows every set. Fails on rc-v0.11.0 (no Top / Neckwear groups, 3 costumes, no seasonal sets).
import assert from 'node:assert/strict';
import { launch, openStudio, showStudio, sleep } from './test_v10_studio_lib.mjs';

const NAME = 'test_v12_body_studio';
const browser = await launch(NAME);
const failed = [];
const check = async (name, fn) => {
    try { await fn(); console.log('[PASS] ' + name); } catch (e) { failed.push(name); console.log('[FAIL] ' + name + ': ' + String(e.message).slice(0, 400)); }
};
try {
    for (const phone of [false, true]) {
        const tag = phone ? 'phone 412: ' : 'desktop: ';
        const { page, errors, context } = await openStudio(browser, { phone });
        await showStudio(page, 'alpha');
        await page.evaluate(() => VOStudio.showCategory('outfit'));
        await sleep(400);

        await check(tag + 'Outfit tab: Top (6), Neckwear (4) and Costume (7) picture tiles drawn by the office code, inside the screen', async () => {
            const g = await page.evaluate(() => {
                const one = key => {
                    const tiles = [...document.querySelectorAll('[data-group="' + key + '"] .st-tile')];
                    const drawn = tiles.filter(t => { const c = t.querySelector('canvas'); if (!c || !c.width) return false;
                        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }).length;
                    const out = tiles.filter(t => { const r = t.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).length;
                    return { n: tiles.length, drawn, out, values: tiles.map(t => t.dataset.value) };
                };
                return { top: one('shirtStyle'), neck: one('neckwear'), cos: one('costume') };
            });
            assert.deepEqual(g.top.values, ['tee', 'hoodie', 'suit', 'labcoat', 'sweater', 'vest', 'blouse'], JSON.stringify(g.top));
            assert.deepEqual(g.neck.values, ['none', 'scarf', 'tie', 'bowtie', 'necklace'], JSON.stringify(g.neck));
            assert.deepEqual(g.cos.values, ['none', 'lobster', 'chicken', 'ghost', 'santa', 'astronaut', 'dino'], JSON.stringify(g.cos));
            assert.ok(g.top.drawn === 6 && g.neck.drawn === 4 && g.cos.drawn === 7, 'every tile has a drawn picture ' + JSON.stringify([g.top.drawn, g.neck.drawn, g.cos.drawn]));
            assert.ok(g.top.out + g.neck.out + g.cos.out === 0, 'no tile runs off the screen');
        });

        await check(tag + 'picking a top and a neckwear tile changes the agent, the tee tile is selected for an old look', async () => {
            const before = await page.evaluate(() => document.querySelector('[data-group="shirtStyle"] .st-tile[aria-checked="true"], [data-group="shirtStyle"] .st-tile.is-selected')?.dataset.value);
            assert.equal(before, 'tee', 'a look without a top shows the tee as chosen');
            await page.click('[data-group="shirtStyle"] .st-tile[data-value="hoodie"]');
            await page.click('[data-group="neckwear"] .st-tile[data-value="scarf"]');
            await sleep(300);
            const a = await page.evaluate(() => { const ag = agents.find(x => x.id === 'alpha'); const l = ag.getAppearance(); return [l.shirtStyle, l.neckwear, !!document.querySelector('[data-group="neckwearColor"]:not([hidden])')]; });
            assert.deepEqual(a, ['hoodie', 'scarf', true], 'the agent wears the picked top and scarf, the colour row shows');
        });

        if (!phone) {
            await check('outfit sets: Scientist lab coat, Boss suit and tie, Creative hoodie; seasonal sets change only the outfit', async () => {
                const r = await page.evaluate(() => {
                    const ag = agents.find(x => x.id === 'alpha'), out = {};
                    for (const id of ['scientist', 'boss', 'creative', 'winter', 'summer', 'halloween', 'holiday']) {
                        const b = JSON.parse(JSON.stringify(ag.getAppearance())), g0 = ag.gender;
                        VOStudio.applyPreset(id);
                        const l = ag.getAppearance();
                        const kept = ['skinTone', 'hairStyle', 'hairColor', 'eyeColor', 'eyebrowStyle', 'facialHair'].every(k => JSON.stringify(l[k]) === JSON.stringify(b[k])) && ag.gender === g0;
                        out[id] = { top: l.shirtStyle, neck: l.neckwear || null, hat: l.headwear || null, kept, known: (VOStudio.catalog.presets || []).some(p => p.id === id) };
                    }
                    return out;
                });
                assert.equal(r.scientist.top, 'labcoat'); assert.equal(r.boss.top, 'suit'); assert.equal(r.boss.neck, 'tie'); assert.equal(r.creative.top, 'hoodie');
                for (const id of ['winter', 'summer', 'halloween', 'holiday']) assert.ok(r[id].known && r[id].kept, id + ' ' + JSON.stringify(r[id]));
                assert.deepEqual([r.winter.hat, r.summer.hat, r.halloween.hat, r.holiday.hat], ['beanie', 'sunhat', 'witch', 'santa']);
                assert.ok(Object.values(r).every(x => x.kept), 'skin, hair and face never change ' + JSON.stringify(r));
            });

            await check('Randomize picks every top, neckwear and the new costumes (seeded)', async () => {
                const r = await page.evaluate(() => {
                    const real = Math.random; let s = 12345;
                    Math.random = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
                    const tops = {}, necks = {}, cos = {};
                    try { for (let i = 0; i < 300; i++) { VOStudio.randomize(); const l = agents.find(x => x.id === 'alpha').getAppearance(); tops[l.shirtStyle] = 1; necks[l.neckwear || 'none'] = 1; if (l.costume) cos[l.costume] = 1; } }
                    finally { Math.random = real; }
                    return { tops: Object.keys(tops).sort(), necks: Object.keys(necks).sort(), cos: Object.keys(cos).sort() };
                });
                assert.deepEqual(r.tops, ['hoodie', 'labcoat', 'suit', 'sweater', 'tee', 'vest'], JSON.stringify(r));
                assert.deepEqual(r.necks, ['bowtie', 'none', 'scarf', 'tie'], JSON.stringify(r));
                assert.ok(r.cos.some(c => ['ghost', 'santa', 'astronaut', 'dino'].includes(c)), 'a new costume comes up ' + JSON.stringify(r.cos));
            });

            await check('new-agent look step shows every outfit set, the seasonal ones too', async () => {
                const ids = await page.evaluate(() => { const host = document.createElement('div'); document.body.appendChild(host);
                    VOStudio.mountLookStep(host, VOStudio.newAgentLook());
                    const labels = [...host.querySelectorAll('.st-tile-label')].map(x => x.textContent); host.remove(); return labels; });
                for (const l of ['Office classic', 'Analyst', 'Builder', 'Winter', 'Summer', 'Halloween', 'Holiday']) assert.ok(ids.includes(l), l + ' in ' + JSON.stringify(ids));
            });
        }
        await check(tag + 'no page errors', async () => assert.deepEqual(errors, []));
        await context.close();
    }
} finally {
    await browser.close();
}
if (failed.length) { console.log('FAILED ' + failed.length + ' ' + NAME + ' checks'); process.exit(1); }
console.log('ALL ' + NAME + ' CHECKS PASSED');
