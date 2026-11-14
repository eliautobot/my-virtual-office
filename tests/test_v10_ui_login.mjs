// v0.10 UI-15: the login page shows the office's own render (dimmed) behind a frosted card, a bigger
// mark and the version in the footer; the card stays readable (AA) at desktop and phone sizes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_login';
const r = reporter();
const img = fs.statSync(path.join(APP, 'login-backdrop.jpg'));
assert.ok(img.size > 10000 && img.size < 150000, `backdrop weight ${img.size}`);
r.pass(`backdrop is a light asset (${Math.round(img.size / 1024)} KB)`);
const browser = await launch(NAME);
const contrast = (a, b) => { const lum = c => { const [R, G, B] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * R + 0.7152 * G + 0.0722 * B; };
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
try {
    for (const [w, h, phone, theme] of [[1600, 900, false, 'dark'], [412, 915, true, 'dark'], [1600, 900, false, 'light']]) {
        const { context, page, blocked } = await openPage(browser, { pagePath: '/login.html', viewport: { width: w, height: h }, phone, theme, waitAgents: false,
            fixtures: { '/api/access/status': { authenticated: false, enabled: true, passcode: true }, '/api/version': { ok: true, status: 'running', version: '0.10.1' } } });
        await page.waitForTimeout(600);
        const s = await page.evaluate(() => {
            const before = getComputedStyle(document.body, '::before');
            const card = document.querySelector('.card').getBoundingClientRect();
            const cs = getComputedStyle(document.querySelector('.card'));
            const p = getComputedStyle(document.querySelector('.lead'));
            return { bg: before.backgroundImage, blur: cs.backdropFilter, cardBg: cs.backgroundColor, text: p.color, logo: document.querySelector('.brand img').getBoundingClientRect().width,
                foot: document.getElementById('foot').textContent, fits: card.left >= 0 && card.right <= innerWidth && card.bottom <= innerHeight + 1 };
        });
        assert.match(s.bg, /login-backdrop\.jpg/); assert.match(s.blur, /blur/);
        assert.ok(s.logo >= 64 && s.fits, JSON.stringify(s));
        assert.equal(s.foot, 'My Virtual Office 0.10.1');
        // Card text contrast against the card colour composited over the darkest/lightest backdrop.
        const base = theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)';
        const nums = s.cardBg.match(/[\d.]+/g).map(Number);
        const [cr, cg, cb] = s.cardBg.startsWith('color(') ? nums.slice(0, 3).map(v => v * 255) : nums.slice(0, 3);
        const ca = nums.length > 3 ? nums[3] : 1;
        const mix = ch => Math.round(ch * ca + (theme === 'dark' ? 0 : 255) * (1 - ca));
        assert.ok(contrast(s.text, `rgb(${mix(cr)}, ${mix(cg)}, ${mix(cb)})`) >= 4.5, `${w} ${theme}: card text contrast`);
        assert.deepEqual(blocked, []);
        if (process.env.VO_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.VO_SHOTS_DIR, `login-${w}-${theme}.jpg`), type: 'jpeg', quality: 60 });
        await context.close();
    }
    r.pass('login: office backdrop, frosted card, 72 px mark, version footer, AA text, fits desktop + phone, dark + light');
} finally {
    await browser.close();
}
r.done(NAME);
