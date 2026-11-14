// v0.10 UI-21: small controls keep their look but get 40 px hit areas (sidebar links, phone sheet grab,
// chat sheet grip), and the dock/sidebar/sheet layout does not move.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_hit_areas';
const browser = await launch(NAME);
const r = reporter();
try {
    const d = await openPage(browser);
    await d.page.waitForTimeout(500);
    const links = await d.page.evaluate(() => [...document.querySelectorAll('.vo-sidebar .vo-link')].filter(b => b.getBoundingClientRect().height).map(b => Math.round(b.getBoundingClientRect().height)));
    assert.ok(links.length >= 2 && links.every(h => h >= 40), `sidebar links ${links}`);
    r.pass('sidebar "Open projects" / "Meeting history" are 40 px targets');
    await d.context.close();

    const p = await openPage(browser, { viewport: { width: 412, height: 915 }, phone: true });
    await p.page.waitForTimeout(500);
    const grab = await p.page.evaluate(() => { const g = document.querySelector('[data-vo-sheet-grab]'); const r = g.getBoundingClientRect(); const bar = g.querySelector('span').getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + 20); return { h: Math.round(r.height), barTop: Math.round(bar.top - r.top), hit: !!(at && (at === g || g.contains(at))) }; });
    assert.ok(grab.h >= 40 && grab.barTop <= 6 && grab.hit, JSON.stringify(grab));
    await p.page.evaluate(() => window.VirtualOfficeChat.openForAgent('alpha'));
    await p.page.waitForFunction(() => document.querySelector('#chat-panel.open'), null, { timeout: 8000 });
    await p.page.waitForTimeout(500);
    const grip = await p.page.evaluate(() => { const g = document.querySelector('#chat-panel .chat-sheet-grip'); const r = g.getBoundingClientRect(); const head = document.querySelector('#chat-panel .chat-header').getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + 34);
        return { h: Math.round(r.height), hit: !!at && (at === g || g.contains(at)), headGap: Math.round(head.top - r.top) }; });
    assert.ok(grip.hit && grip.h >= 40 && grip.headGap === grip.h, JSON.stringify(grip));
    r.pass('phone: sheet grab and chat grip are 40 px targets, the grab bar stays where it was');
    await p.context.close();

    // R-02: the 40 px grab must not push the peek row (title + status counts) under the action bar,
    // and in the half sheet the header's buttons stay tappable over the grab's overlap.
    for (const [w, h] of [[412, 915], [375, 667], [360, 740]]) {
        const q = await openPage(browser, { viewport: { width: w, height: h }, phone: true });
        await q.page.waitForTimeout(400);
        const peek = await q.page.evaluate(() => { const head = document.querySelector('.vo-sidebar-head').getBoundingClientRect();
            const bar = document.querySelector('.vo-actionbar').getBoundingClientRect(); const stats = document.querySelector('.vo-peek-stats').getBoundingClientRect();
            return { headBottom: Math.round(head.bottom), statsBottom: Math.round(stats.bottom), barTop: Math.round(bar.top) }; });
        assert.ok(peek.headBottom <= peek.barTop && peek.statsBottom <= peek.barTop, `${w}: ${JSON.stringify(peek)}`);
        await q.page.click('[data-vo-sheet-grab]'); // (the dashboard's grab: the More sheet has one too, v0.13)
        await q.page.waitForTimeout(500);
        const btn = await q.page.evaluate(() => { const b = document.querySelector('.vo-sidebar-head [data-vo-cards-toggle]'); const r = b.getBoundingClientRect();
            const at = document.elementFromPoint(r.left + r.width / 2, r.top + 3); return !!at && (at === b || b.contains(at)); });
        assert.ok(btn, `${w}: header button covered by the grab`);
        await q.context.close();
    }
    r.pass('phone: the Dashboard peek row sits above the action bar (412, 375, 360), header buttons stay on top of the grab');
} finally {
    await browser.close();
}
r.done(NAME);
