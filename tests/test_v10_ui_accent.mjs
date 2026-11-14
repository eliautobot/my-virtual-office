// v0.10 UI-25: solid accent surfaces use --vo-accent-fill / --vo-accent-fill-ink. Classic light keeps
// the warm yellow fill with dark text (not brown-gold); brown stays for text links. Every preset/mode
// keeps fill text at AA contrast.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_accent';
const browser = await launch(NAME);
const r = reporter();
const contrast = (a, b) => {
    const lum = c => { const [R, G, B] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05);
};
try {
    for (const [preset, theme] of [['classic', 'dark'], ['classic', 'light'], ['retro', 'dark'], ['retro', 'light'], ['cyberpunk', 'dark'], ['cyberpunk', 'light'], ['gameboy', 'dark'], ['gameboy', 'light']]) {
        const { context, page } = await openPage(browser, { preset, theme });
        await page.evaluate(() => toggleMainMenu());
        await page.waitForTimeout(300);
        await page.evaluate(() => { const i = document.querySelector('#main-menu-panel .mm-section[data-category="general"] input:not([type=checkbox]):not([type=hidden])'); i.value += 'x'; i.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.waitForTimeout(150);
        const c = await page.evaluate(() => { const b = document.querySelector('#main-menu-panel .settings-footer .mm-save-all'); const cs = getComputedStyle(b);
            return { bg: cs.backgroundColor, fg: cs.color, accent: getComputedStyle(document.documentElement).getPropertyValue('--vo-accent').trim() }; });
        const ratio = contrast(c.fg, c.bg);
        assert.ok(ratio >= 4.5, `${preset}/${theme}: Save text ${c.fg} on ${c.bg} = ${ratio.toFixed(2)}`);
        if (preset === 'classic' && theme === 'light') {
            assert.equal(c.bg, 'rgb(245, 200, 76)', 'classic light primary is the warm yellow');
            assert.equal(c.accent, '#8a5800', 'brown stays the text accent');
        }
        await context.close();
    }
    r.pass('primary fill keeps AA text in all 8 preset/mode combinations; classic light primary is yellow with dark text');
} finally {
    await browser.close();
}
r.done(NAME);
