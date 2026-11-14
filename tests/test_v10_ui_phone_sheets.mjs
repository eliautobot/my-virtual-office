// v0.10 UI-03 + UI-24: phone sheets. The agent menu sheet gets the one dim backdrop over an open
// chat sheet (one header, tap outside closes); the More menu is a real bottom sheet with a backdrop.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_phone_sheets';
const browser = await launch(NAME);
const r = reporter();
try {
    const { context, page } = await openPage(browser, { viewport: { width: 412, height: 915 }, phone: true });
    await page.waitForTimeout(600);

    // More menu: a full-width bottom sheet with the backdrop.
    await page.click('.vo-actionbar [data-vo-action="more"]');
    await page.waitForTimeout(250);
    const more = await page.evaluate(() => {
        const m = document.getElementById('vo-more-menu').getBoundingClientRect();
        const scrim = getComputedStyle(document.body, '::before');
        return { left: Math.round(m.left), right: Math.round(m.right), bottom: Math.round(m.bottom), vw: innerWidth, vh: innerHeight,
            scrim: scrim.content !== 'none' && scrim.position === 'fixed', blur: scrim.backdropFilter };
    });
    assert.equal(more.left, 0); assert.equal(more.right, more.vw); assert.equal(more.bottom, more.vh);
    assert.ok(more.scrim, 'backdrop behind the More sheet'); assert.match(more.blur, /blur\(6px\)/);
    // The sheet sits above its backdrop: its items get the tap.
    const onTop = await page.evaluate(() => { const items = [...document.querySelectorAll('#vo-more-menu .vo-menu-item')].filter(b => !b.hidden && b.getBoundingClientRect().height);
        return items.slice(0, 4).every(b => { const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return at && b.contains(at); }); });
    assert.ok(onTop, 'menu items are above the backdrop');
    r.pass('phone More menu is a bottom sheet with the 6 px backdrop');
    // A tap on the backdrop closes it (nothing underneath gets the tap).
    await page.mouse.click(200, 120);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.getElementById('vo-more-menu').hidden), true);
    r.pass('tap on the backdrop closes the More sheet');

    // Agent menu sheet over an open chat sheet: the chat header is behind the backdrop.
    await page.evaluate(() => window.VirtualOfficeChat.openForAgent('alpha'));
    await page.waitForFunction(() => document.querySelector('#chat-panel.open'), null, { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => _openAgentMenu(window.agents.find(a => a.statusKey === 'alpha'), {}));
    await page.waitForTimeout(300);
    const hit = await page.evaluate(() => {
        const head = document.querySelector('#chat-panel .chat-header, #chat-panel header, #chat-panel');
        const hr = head.getBoundingClientRect();
        const menu = document.getElementById('vo-agent-menu').getBoundingClientRect();
        const y = Math.max(hr.top + 10, 4);
        const at = document.elementFromPoint(200, Math.min(y, menu.top - 10));
        return { sheetClass: document.body.classList.contains('vo-agent-sheet-open'), atChat: !!(at && at.closest('#chat-panel')), menuTop: Math.round(menu.top) };
    });
    assert.ok(hit.sheetClass, 'body marks the open agent sheet');
    assert.equal(hit.atChat, false, 'the chat sheet is behind the backdrop');
    r.pass('agent menu sheet covers the chat sheet with the backdrop');
    await page.mouse.click(200, Math.max(40, hit.menuTop - 60));
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ hidden: document.getElementById('vo-agent-menu').hidden, cls: document.body.classList.contains('vo-agent-sheet-open') }));
    assert.deepEqual(after, { hidden: true, cls: false });
    r.pass('tap on the backdrop closes the agent sheet and removes the backdrop');
    await context.close();
} finally {
    await browser.close();
}
r.done(NAME);
