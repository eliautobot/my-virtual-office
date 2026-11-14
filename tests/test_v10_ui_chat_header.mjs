// v0.10 UI-14: chat header compaction. A narrow chat window folds its tool buttons into one ⋯ menu
// whose items press the real buttons; a wide window shows them inline. The sessions list overlays the
// messages unless the window is wide, so the message column keeps its width; pickers are 32 px.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_chat_header';
const browser = await launch(NAME);
const r = reporter();
try {
    const { context, page, errors } = await openPage(browser);
    await page.evaluate(() => window.VirtualOfficeChat.openForAgent('alpha'));
    await page.waitForFunction(() => document.querySelector('#chat-panel.open'), null, { timeout: 8000 });
    await page.waitForTimeout(400);
    const head = () => page.evaluate(() => {
        const p = document.getElementById('chat-panel');
        const vis = s => { const e = p.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; };
        return { w: Math.round(p.getBoundingClientRect().width), narrow: p.classList.contains('chat-narrow'), wide: p.classList.contains('chat-wide'),
            more: vis('.chat-more-tools'), newSession: vis('.chat-new-session'), putAway: vis('.chat-put-away'), close: vis('.chat-close') };
    });
    let h = await head();
    assert.ok(h.w < 480, `default chat window is narrow (${h.w})`);
    assert.deepEqual([h.narrow, h.more, h.newSession, h.putAway, h.close], [true, true, false, false, true]);
    r.pass('narrow window: tool buttons fold into one ⋯ button, close stays');

    await page.evaluate(() => { window.__ns = 0; document.querySelector('#chat-panel .chat-new-session').addEventListener('click', e => { window.__ns++; e.stopImmediatePropagation(); }, true); });
    await page.click('#chat-panel .chat-more-tools');
    const items = await page.evaluate(() => [...document.querySelectorAll('#chat-panel .chat-more-menu .chat-more-item')].map(b => b.textContent.trim()));
    assert.ok(items.some(t => /new session/i.test(t)), `menu items: ${items}`);
    assert.ok(items.every(t => t.length > 2), 'every item has a label');
    const idx = items.findIndex(t => /new session/i.test(t));
    await page.evaluate(i => document.querySelectorAll('#chat-panel .chat-more-menu .chat-more-item')[i].click(), idx);
    assert.equal(await page.evaluate(() => window.__ns), 1, 'the menu item pressed the real New session button');
    assert.equal(await page.evaluate(() => !!document.querySelector('#chat-panel .chat-more-menu')), false, 'menu closes after a choice');
    await page.click('#chat-panel .chat-more-tools');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => !!document.querySelector('#chat-panel .chat-more-menu')), false, 'Esc closes the menu');
    r.pass('⋯ menu lists the tools, presses the real button, closes on choice and on Esc');

    // Sessions overlay keeps the message column.
    const before = await page.evaluate(() => Math.round(document.querySelector('#chat-panel .chat-messages').getBoundingClientRect().width));
    await page.evaluate(() => document.querySelector('#chat-panel .chat-sessions-toggle').click());
    await page.waitForTimeout(300);
    const sess = await page.evaluate(() => { const sp = document.querySelector('#chat-panel .chat-sessions-panel');
        return { open: sp.classList.contains('open'), pos: getComputedStyle(sp).position, msg: Math.round(document.querySelector('#chat-panel .chat-messages').getBoundingClientRect().width) }; });
    assert.ok(sess.open && sess.pos === 'absolute', JSON.stringify(sess));
    assert.ok(sess.msg >= before - 2 && sess.msg >= 240, `messages keep their width (${before} -> ${sess.msg})`);
    await page.evaluate(() => document.querySelector('#chat-panel .chat-sessions-toggle').click());
    r.pass('sessions list overlays a narrow window; the message column keeps its width');

    // A wide window shows the tools inline.
    await page.evaluate(() => { const p = document.getElementById('chat-panel'); p.style.width = '720px'; p.style.maxWidth = 'none'; });
    await page.waitForTimeout(250);
    h = await head();
    assert.deepEqual([h.wide, h.narrow, h.more, h.newSession], [true, false, false, true], JSON.stringify(h));
    r.pass('wide window: tools inline, no ⋯');

    const pick = await page.evaluate(() => [...document.querySelectorAll('#chat-panel .hp-picker-btn')].map(b => Math.round(b.getBoundingClientRect().height)).filter(Boolean));
    assert.ok(pick.every(v => v >= 32), `pickers are 32 px (${pick})`);
    assert.deepEqual(errors.filter(e => !/Failed to fetch|NetworkError|aborted/i.test(e)), []);
    await context.close();
} finally {
    await browser.close();
}
r.done(NAME);
