// v0.10 UI-12 + UI-13 + UI-22: Settings has one save model (Discard / Save changes appear only when
// something changed, on every tab), a fade at the fold while more is below, and on phones the tab
// strip fades at its scrolling edge.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_settings';
const browser = await launch(NAME);
const r = reporter();
try {
    const { context, page } = await openPage(browser);
    await page.evaluate(() => toggleMainMenu());
    await page.waitForTimeout(500);
    const state = () => page.evaluate(() => {
        const f = document.querySelector('#main-menu-panel .settings-footer');
        const c = document.querySelector('#main-menu-panel .settings-content');
        return { footer: getComputedStyle(f).display !== 'none', label: f.querySelector('.mm-save-all')?.textContent.trim(),
            fade: c.classList.contains('vo-has-more'), fadeOpacity: getComputedStyle(c, '::after').opacity };
    });
    const tab = c => page.evaluate(c => document.querySelector(`#main-menu-panel .settings-nav button[data-category="${c}"]`).click(), c);

    let s = await state();
    assert.equal(s.footer, false, 'clean General: no Save footer');
    for (const c of ['help', 'integrations', 'themes', 'data']) {
        await tab(c); await page.waitForTimeout(120);
        assert.equal((await state()).footer, false, `clean ${c}: no Save footer`);
    }
    r.pass('nothing changed: no Discard / Save on any tab');

    await tab('general'); await page.waitForTimeout(400);
    s = await state();
    assert.equal(s.fade, true, 'General is taller than the window: fade at the fold');
    await page.evaluate(() => { const b = document.querySelector('#main-menu-panel .main-menu-body'); b.scrollTop = b.scrollHeight; });
    await page.waitForTimeout(150);
    assert.equal((await state()).fade, false, 'scrolled to the end: no fade');
    r.pass('fade at the fold only while more content is below');

    await page.evaluate(() => { const i = document.querySelector('#main-menu-panel .mm-section[data-category="general"] input:not([type=checkbox]):not([type=hidden])'); i.value = i.value + 'x'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(150);
    s = await state();
    assert.deepEqual([s.footer, s.label], [true, 'Save changes']);
    await tab('help'); await page.waitForTimeout(120);
    assert.equal((await state()).footer, true, 'unsaved changes stay reachable from any tab');
    r.pass('a change shows Discard / Save changes, on every tab until saved or discarded');
    await context.close();

    // Phone: the settings tab strip fades at the edge it can still scroll to.
    const ph = await openPage(browser, { viewport: { width: 412, height: 915 }, phone: true });
    await ph.page.evaluate(() => toggleMainMenu());
    await ph.page.waitForTimeout(500);
    const nav = () => ph.page.evaluate(() => { const n = document.querySelector('#main-menu-panel .settings-nav');
        return { scrolls: n.scrollWidth > n.clientWidth + 4, cls: n.className, mask: getComputedStyle(n).maskImage || getComputedStyle(n).webkitMaskImage, snap: getComputedStyle(n).scrollSnapType }; });
    let n = await nav();
    assert.ok(n.scrolls, 'tab strip scrolls on a phone');
    assert.match(n.cls, /vo-fade-end/); assert.doesNotMatch(n.cls, /vo-fade-start/);
    assert.match(n.mask, /linear-gradient/); assert.match(n.snap, /x/);
    await ph.page.evaluate(() => { const nv = document.querySelector('#main-menu-panel .settings-nav'); nv.scrollLeft = nv.scrollWidth; nv.dispatchEvent(new Event('scroll')); });
    await ph.page.waitForTimeout(150);
    n = await nav();
    assert.match(n.cls, /vo-fade-start/); assert.doesNotMatch(n.cls, /vo-fade-end/);
    r.pass('phone tab strip: edge fade on the side that scrolls, scroll snap');
    await ph.context.close();
} finally {
    await browser.close();
}
r.done(NAME);
