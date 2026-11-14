// v0.10.1 I13: costumes from behind. The lobster's back view is shell segments, a tail and claws over the
// whole back of the head (no grey head block, no hood eyes); the chicken's back has no beak or eyes.
// Renders the real agent art through VOOffice.renderAgentPreview (hermetic page, fixtures).
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v101_costume_back';
const browser = await launch(NAME);
const R = reporter();
try {
    const { page, errors } = await openPage(browser);
    await page.evaluate(() => new Promise(res => _voLazyLoad('studio', res)));  // the studio part (lazy) holds the preview
    await page.waitForFunction(() => window.VOOffice && typeof window.VOOffice.renderAgentPreview === 'function', null, { timeout: 15000 });
    const stats = await page.evaluate(() => {
        const base = agents.find(a => a.id === 'alpha').getAppearance();
        const count = (costume, facing) => {
            const c = document.createElement('canvas');
            const look = Object.assign({}, base, { costume, hairColor: '#9e9e9e' });  // grey hair: what showed through before
            window.VOOffice.renderAgentPreview(c, look, { facing, scale: 4, width: 200, height: 260, dpr: 1, floor: false });
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            const n = { red: 0, rim: 0, dark: 0, white: 0, grey: 0, beak: 0 };
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] < 200) continue;
                const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
                if (k === 0xd32f2f) n.red++;
                else if (k === 0xe05555) n.rim++;
                else if (k === 0xa51c1c) n.dark++;
                else if (k === 0xffffff) n.white++;
                else if (k === 0x9e9e9e) n.grey++;
                else if (k === 0xff8f00) n.beak++;
            }
            return n;
        };
        return { lf: count('lobster', 'down'), lb: count('lobster', 'up'), cf: count('chicken', 'down'), cb: count('chicken', 'up'), nb: count(null, 'up') };
    });
    assert.ok(stats.nb.grey > 200, 'control: without a costume the grey hair shows from behind ' + JSON.stringify(stats.nb));
    assert.equal(stats.lb.grey, 0, 'lobster back: no grey head block ' + JSON.stringify(stats.lb));
    assert.ok(stats.lf.white > 0 && stats.lb.white < stats.lf.white, 'lobster back: no hood eyes ' + JSON.stringify([stats.lf, stats.lb]));
    assert.ok(stats.lb.red > stats.lf.red * 1.3, 'lobster back: shell + tail cover more ' + JSON.stringify([stats.lf, stats.lb]));
    assert.ok(stats.lb.rim > stats.lf.rim && stats.lb.dark > stats.lf.dark, 'lobster back: segment rims and seams ' + JSON.stringify([stats.lf, stats.lb]));
    R.pass('lobster from behind: shell segments, tail and claws over the head, no grey block, no eyes');
    assert.ok(stats.cf.beak > 0 && stats.cb.beak === 0 && stats.cb.grey === 0, 'chicken back: no beak, no grey ' + JSON.stringify([stats.cf, stats.cb]));
    R.pass('chicken from behind: no beak or eyes, the hood covers the head');
    assert.deepEqual(errors, []);
    R.pass('no page errors');
} finally {
    await browser.close();
}
R.done(NAME);
