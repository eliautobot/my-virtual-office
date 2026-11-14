// v0.10 UI-19: keyboard focus rings only for keyboard users. After a pointer press, a menu that moves
// focus on open (agent menu, replay bar) does not look "selected"; the first key press brings rings back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_focus';
const r = reporter();
// Outline colours must be colours: --vo-focus is a box-shadow list.
for (const f of ['office-life/life.css', 'office-life/paper.css', 'ui-modern.css', 'v10-ui.css', 'style.css', 'hp-chat.css', 'v08-chat.css']) {
    const src = fs.readFileSync(path.join(APP, f), 'utf8');
    assert.doesNotMatch(src, /outline:[^;]*var\(--vo-focus/, `${f}: outline uses --vo-focus (a box-shadow token)`);
}
r.pass('no outline uses the box-shadow focus token');
const browser = await launch(NAME);
try {
    const { context, page } = await openPage(browser);
    const ring = () => page.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a);
        return { el: a.className, shadow: cs.boxShadow, outline: cs.outlineStyle !== 'none' && cs.outlineColor !== 'rgba(0, 0, 0, 0)' ? cs.outlineColor : '', border: cs.borderTopColor }; });
    // A pointer press anywhere, then a scripted open that focuses the first action.
    await page.mouse.click(800, 450);
    await page.evaluate(() => { _closeAgentMenu(); _openAgentMenu(window.agents[0], {}); });
    await page.waitForTimeout(150);
    const p = await ring();
    assert.match(p.el, /vo-agent-menu-card/);
    assert.ok(!/rgb\(25[0-5], 2\d\d, \d+\) 0px 0px 0px [24]px/.test(p.shadow) && (p.shadow === 'none' || /transparent|rgba\(0, 0, 0, 0\)/.test(p.shadow)), `no ring after pointer: ${p.shadow}`);
    assert.equal(p.outline, '');
    r.pass('pointer user: the focused first action has no ring');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(80);
    const k = await ring();
    assert.ok(k.shadow !== 'none' && !/^rgba\(0, 0, 0, 0\) 0px 0px 0px 0px$/.test(k.shadow), `keyboard user sees the ring: ${k.shadow}`);
    r.pass('keyboard user: the ring is back after a key press');
    await context.close();
} finally {
    await browser.close();
}
r.done(NAME);
