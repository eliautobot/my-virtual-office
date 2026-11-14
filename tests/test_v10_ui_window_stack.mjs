// v0.10 UI-01: one window stack. A window comes to the front when it opens and when it is
// pressed: chat windows, the Agent PC, SMS, browser and workspace panels share one z band.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_window_stack';
const browser = await launch(NAME);
const r = reporter();
try {
    const { context, page, errors } = await openPage(browser);
    const z = sel => page.evaluate(s => +getComputedStyle(document.querySelector(s)).zIndex, sel);

    // Real chat window, then the real Agent PC: the PC opens on top.
    await page.evaluate(() => window.VirtualOfficeChat.openForAgent('alpha'));
    await page.waitForFunction(() => document.querySelector('#chat-panel.open'), null, { timeout: 8000 });
    await page.evaluate(() => window.VirtualOfficePreviews && window.VirtualOfficePreviews.openPC('alpha'));
    await page.waitForFunction(() => { const p = document.querySelector('.agent-preview-panel'); return p && getComputedStyle(p).display !== 'none'; }, null, { timeout: 8000 });
    const chatZ = await z('#chat-panel'), pcZ = await z('.agent-preview-panel');
    assert.ok(pcZ > chatZ, `Agent PC (${pcZ}) opens above the chat (${chatZ})`);
    r.pass('Agent PC opens in front of an open chat window');

    // Pressing the chat brings it back to the front.
    await page.evaluate(() => document.querySelector('#chat-panel').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    assert.ok(await z('#chat-panel') > await z('.agent-preview-panel'), 'chat raised on press');
    r.pass('pressing a window raises it');

    // Every floating window stays inside the window band (below sheets, scrims and modals).
    const band = await page.evaluate(() => window.VOWindowStack.order('window').map(el => +el.style.zIndex));
    assert.ok(band.every(v => v > 300 && v < 400), `window band: ${band}`);
    r.pass('window z stays between --vo-z-window and --vo-z-sheet');

    // A window shown later by class or display (SMS/browser style) is raised on open; hiding hands z back to CSS.
    const res = await page.evaluate(async () => {
        const el = document.createElement('div');
        el.className = 'sms-panel test-win';
        el.style.cssText = 'position:fixed;display:none;left:0;top:0;width:50px;height:50px';
        document.body.appendChild(el);
        await new Promise(r => setTimeout(r, 30));
        el.style.display = 'flex';
        await new Promise(r => setTimeout(r, 30));
        const top = window.VOWindowStack.top('window') === el;
        el.style.left = '20px';           // a drag: no re-raise churn, still on top
        await new Promise(r => setTimeout(r, 30));
        el.style.display = 'none';
        await new Promise(r => setTimeout(r, 30));
        return { top, cleared: el.style.zIndex === '', gone: !window.VOWindowStack.order('window').includes(el) };
    });
    assert.deepEqual(res, { top: true, cleared: true, gone: true });
    r.pass('display/class open raises; close releases');

    // Modal band: the last opened modal is on top of an earlier one, and confirm dialogs stay above both.
    const modal = await page.evaluate(async () => {
        const a = document.createElement('div'); a.className = 'modal'; a.style.display = 'none'; document.body.appendChild(a);
        const b = document.createElement('div'); b.className = 'modal'; b.style.display = 'none'; document.body.appendChild(b);
        await new Promise(r => setTimeout(r, 30));
        b.style.display = 'flex'; await new Promise(r => setTimeout(r, 30));
        a.style.display = 'flex'; await new Promise(r => setTimeout(r, 30));
        return { a: +a.style.zIndex, b: +b.style.zIndex };
    });
    assert.ok(modal.a > modal.b && modal.a < 620, JSON.stringify(modal));
    r.pass('modal band: last opened on top, below confirm dialogs');

    assert.deepEqual(errors.filter(e => !/Failed to fetch|NetworkError|aborted/i.test(e)), []);
    await context.close();
} finally {
    await browser.close();
}
r.done(NAME);
