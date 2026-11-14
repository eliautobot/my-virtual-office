// v0.12: UI themes style the interface only, never the office canvas. Every preset (Classic, Retro, Cyberpunk,
// Gameboy, Custom) in light and dark mode draws the same canvas as Classic dark: the world, the surround around the
// walls, name tags, chips and the night lighting. One page, the animation frozen (frame loop stopped, a fixed clock),
// each preset x mode switched live and one frame rendered, by day (10:00) and by night (23:00): the full canvas must
// be equal pixel for pixel, the surround is Classic dark's slate, and the interface itself did change.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_theme_surround';
const COMBOS = [['classic', 'dark'], ['classic', 'light'], ['retro', 'dark'], ['retro', 'light'], ['cyberpunk', 'dark'],
    ['cyberpunk', 'light'], ['gameboy', 'dark'], ['gameboy', 'light'], ['custom', 'dark'], ['custom', 'light']];
const browser = await launch(NAME);
const r = reporter();
try {
    const { context, page, errors } = await openPage(browser, { preset: 'classic', theme: 'dark' });
    await page.waitForTimeout(1500);
    const out = await page.evaluate(async (combos) => {
        window.requestAnimationFrame = () => 0;                 // the frame loop stops after its next frame
        await new Promise(res => setTimeout(res, 100));
        const R0 = Date; let T = R0.now();
        window.Date = class extends R0 { constructor(...a) { if (a.length === 0) super(T); else super(...a); } static now() { return T; } };
        const P = performance.now(); performance.now = () => P;
        const c = document.getElementById('officeCanvas'), g = c.getContext('2d'), root = document.documentElement;
        const res = [];
        for (const hour of [10, 23]) for (const [preset, mode] of combos) {
            T = new R0(2026, 10, 4, hour, 0, 0).getTime();
            window.VOThemeSuite.applyPreset(preset, false); window.VOThemeSuite.setMode(mode, false);
            await new Promise(res => setTimeout(res, 40));
            for (let i = 0; i < 2; i++) { _simLastAt = P; _simAccumulator = 0; _lastDrawAt = -1e9; _sceneDirty = true; _staticLayerForce = true; _renderFrame(P); }
            const d = g.getImageData(0, 0, c.width, c.height).data;
            let h = 0; for (let i = 0; i < d.length; i += 4) h = (Math.imul(h, 31) + (d[i] << 16 | d[i + 1] << 8 | d[i + 2])) | 0;
            res.push({ id: `${preset}/${mode}@${hour}`, hour, hash: h, edge: [d[8], d[9], d[10]].join(','), night: _nightLevel(),
                ds: root.dataset.uiPreset + '/' + root.dataset.uiTheme, ui: getComputedStyle(root).getPropertyValue('--vo-surface-0').trim(),
                chip: ['warning', 'info', 'success'].map(k => _chipTone(k).bg).join(' ') });
        }
        return res;
    }, COMBOS);
    assert.equal(out.length, COMBOS.length * 2);
    out.forEach((o, i) => assert.equal(o.ds, COMBOS[i % COMBOS.length].join('/'), `${o.id}: the theme reached the page`));
    const ui = new Set(out.map(o => o.ui));
    assert.ok(ui.size >= 7, `the interface follows the theme (${ui.size} distinct --vo-surface-0 values)`);
    for (const hour of [10, 23]) {
        const set = out.filter(o => o.hour === hour), ref = set[0];
        const diff = set.filter(o => o.hash !== ref.hash).map(o => o.id);
        assert.deepEqual(diff, [], `${hour}:00: canvas differs from Classic dark in ${diff.join(', ')}`);
        set.forEach(o => assert.equal(o.edge, '12,18,29', `${o.id}: surround is Classic dark's slate (got rgb ${o.edge})`));
        set.forEach(o => assert.equal(o.chip, '#fbbf24 #60a5fa #4ade80', `${o.id}: canvas chips keep their colours (${o.chip})`));
        set.forEach(o => assert.equal(o.night, ref.night, `${o.id}: night level ${o.night} vs ${ref.night}`));
    }
    assert.equal(out[0].night, 0, 'by day there is no night (no theme keeps it night)');
    assert.ok(out[COMBOS.length].night > 0, 'by night the night lighting runs');
    assert.deepEqual(errors, [], 'page errors');
    await context.close();
    r.pass(`office canvas identical in ${COMBOS.length} preset/mode combinations by day and by night (Classic dark surround, fixed chip colours), while the interface changes (${ui.size} palettes)`);
} finally {
    await browser.close();
}
r.done(NAME);
