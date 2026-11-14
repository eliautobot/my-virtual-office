// v0.10 UI-18: when the office config cannot be loaded the office says so once (a toast, never an
// alert), keeps the cached layout, and says again when the server is back.
import assert from 'node:assert/strict';
import { launch, openPage, reporter, FIXTURES } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_config_toast';
const browser = await launch(NAME);
const r = reporter();
try {
    let fail = true;
    const { context, page } = await openPage(browser, {
        init: () => { window.alert = m => { window.__alerts = (window.__alerts || 0) + 1; }; },
        fixtures: { '/api/office-config': () => (fail ? { __status: 500, error: 'boom' } : FIXTURES['/api/office-config']) } });
    await page.waitForFunction(() => document.querySelector('.vo-toast--warning'), null, { timeout: 10000 });
    const warn = await page.evaluate(() => ({ n: document.querySelectorAll('.vo-toast--warning').length, text: document.querySelector('.vo-toast--warning').textContent,
        icon: document.querySelector('.vo-toast--warning use')?.getAttribute('href'), alerts: window.__alerts || 0 }));
    assert.equal(warn.n, 1); assert.match(warn.text, /Cannot reach the office server/); assert.equal(warn.icon, '#i-warn'); assert.equal(warn.alerts, 0);
    r.pass('config load failure: one warning toast, pixel warn icon, no alert');
    // Retries do not repeat it; recovery says so.
    fail = false;
    await page.waitForFunction(() => document.querySelector('.vo-toast--success'), null, { timeout: 15000 });
    const ok = await page.evaluate(() => ({ text: document.querySelector('.vo-toast--success').textContent, warns: document.querySelectorAll('.vo-toast--warning').length }));
    assert.match(ok.text, /again/); assert.ok(ok.warns <= 1);
    r.pass('server back: a success toast, the warning was not repeated');
    await context.close();
} finally {
    await browser.close();
}
r.done(NAME);
