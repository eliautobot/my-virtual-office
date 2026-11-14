// v0.10.1 phone playtest fixes (ptui).
// I1: on the phone the office framing keeps the sheet peek + toast band clear, and toasts show one at a time,
//     so a toast never covers an agent on first open (agents at the bottom of the office included).
// I2: every control the playtest measured under 44 px has a 44 x 44 hit area on a touch phone (the control or a
//     transparent hit box around it; its label for a checkbox), measured with elementFromPoint from its centre.
// I14: editor controls are named by their labels (Add Boss Desk to favorites), never internal ids (bossDesk).
// I11: the phone top bar shows the whole office name beside DEMO and the cog (375 and 320 px wide): the pill drops
//      "Upgrade", the default name shortens to "My Office" only if needed, a long custom name is cut with a tooltip.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v101_ui_phone';
const browser = await launch(NAME);
const r = reporter();
// Hit extents from the control's centre (1 px rounding allowed; the screen edge counts as reachable).
const hitAudit = (page, sel) => page.evaluate((sel) => {
    const vw = innerWidth, vh = innerHeight, out = [];
    const owns = (el, hit) => !!hit && (el === hit || el.contains(hit) || !!(hit.closest('label') && (hit.closest('label').contains(el) || (el.id && hit.closest('label').htmlFor === el.id))));
    let n = 0;
    for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (!owns(el, document.elementFromPoint(cx, cy))) continue;
        n++;
        const ext = (dx, dy) => { let k = 0; for (let i = 1; i <= 30; i++) { const x = cx + dx * i, y = cy + dy * i; if (x < 0 || y < 0 || x >= vw || y >= vh) { k = 30; break; } if (!owns(el, document.elementFromPoint(x, y))) break; k = i; } return k; };
        const w = ext(-1, 0) + ext(1, 0) + 1, h = ext(0, -1) + ext(0, 1) + 1;
        if (w < 43 || h < 43) out.push(`${el.getAttribute('aria-label') || el.className || el.id} ${Math.round(r.width)}x${Math.round(r.height)} hit ${w}x${h}`);
    }
    return { n, small: out };
}, sel);
const settle = page => page.waitForFunction(() => {
    const c = VOOffice.getCamera(); const a = window.__camLast; window.__camLast = c.x + ',' + c.y + ',' + c.zoom; return a === window.__camLast;
}, null, { timeout: 8000, polling: 300 });
try {
    // I1: phone 412x915, agents moved to the bottom of the office.
    {
        const { context, page, errors } = await openPage(browser, { viewport: { width: 412, height: 915 }, phone: true });
        await page.evaluate(() => {
            agents.forEach((a, i) => { a.x = W * (0.3 + 0.05 * i); a.y = H - 40; a.desk = null; a.targetX = a.x; a.targetY = a.y; a.path = []; });
            VOOffice.resetView();
        });
        await settle(page);
        await page.evaluate(() => { VOUI.toast('The Daily Office is out', { duration: 30000 }); VOUI.toast('Second', { duration: 30000 }); VOUI.toast('Third', { duration: 30000 }); });
        await page.waitForTimeout(300);
        const s = await page.evaluate(() => {
            const shown = [...document.querySelectorAll('.vo-toast:not(.is-leaving)')].map(t => { const b = t.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, text: t.textContent }; });
            const cv = document.getElementById('officeCanvas').getBoundingClientRect();
            const ag = agents.map(a => ({ name: a.name, head: _worldToScreen(a.x, a.y - 92).y, feet: _worldToScreen(a.x, a.y + 12).y }));
            return { shown, cvBottom: cv.bottom, ag, reserve: getComputedStyle(document.body).getPropertyValue('--vo-framing-reserve').trim() };
        });
        assert.equal(s.reserve, '116px');
        assert.equal(s.shown.length, 1, 'one toast at a time on the phone: ' + JSON.stringify(s.shown));
        assert.match(s.shown[0].text, /Daily Office/);
        for (const a of s.ag) {
            assert.ok(a.feet <= s.shown[0].top, `${a.name} feet ${a.feet} under the toast top ${s.shown[0].top}`);
            assert.ok(a.feet <= s.cvBottom - 116 + 1, `${a.name} feet ${a.feet} in the reserved band (canvas bottom ${s.cvBottom})`);
        }
        r.pass('phone: agents at the bottom of the office are framed above the sheet peek and the toast band');
        // The shown toast hurries (about 1.6 s), then the queued ones follow in order.
        await page.waitForFunction(() => /Second/.test(document.querySelector('.vo-toast:not(.is-leaving)')?.textContent || ''), null, { timeout: 5000 });
        const n = await page.evaluate(() => document.querySelectorAll('.vo-toast:not(.is-leaving)').length);
        assert.equal(n, 1);
        r.pass('phone: queued toasts follow one at a time');
        assert.deepEqual(errors, []);
        await context.close();
    }
    // I2: touch targets on a 412 px phone.
    {
        const { context, page, errors } = await openPage(browser, { viewport: { width: 412, height: 915 }, phone: true });
        await page.evaluate(() => { if (window._voLicense) window._voLicense.demo = false; });
        const map = await hitAudit(page, '.vo-mapctl .vo-btn, .vo-topbar .vo-btn--icon');
        assert.ok(map.n >= 4, 'map controls found'); assert.deepEqual(map.small, []);
        await page.evaluate(() => toggleEditMode()); await page.waitForTimeout(900);
        const ed = await hitAudit(page, '.furniture-catalog .catalog-tabs button, .furniture-catalog .catalog-fav, .ui-edit-toolbar button');
        const search = await page.evaluate(() => Math.round(document.querySelector('.furniture-catalog .catalog-search').getBoundingClientRect().height));
        assert.ok(ed.n >= 8, 'editor controls found: ' + ed.n); assert.deepEqual(ed.small, []); assert.ok(search >= 44, 'search ' + search);
        const names = await page.evaluate(() => {
            const ids = Object.keys(FURNITURE_BOUNDS).filter(t => /[A-Z]/.test(t));
            const bad = [], all = [];
            document.querySelectorAll('#furniture-catalog button, #furniture-catalog [role=button], .ui-edit-toolbar button, #vo-editor-status button').forEach(el => {
                const n = (el.getAttribute('aria-label') || el.textContent || '').trim();
                all.push(n);
                if (ids.some(id => new RegExp('\\b' + id + '\\b').test(n))) bad.push(n);
            });
            return { bad: [...new Set(bad)].slice(0, 6), boss: all.find(n => /Boss Desk to favorites/.test(n)) || '', n: all.length };
        });
        assert.deepEqual(names.bad, [], 'names with internal ids'); assert.match(names.boss, /^(Add|Remove) Boss Desk (to|from) favorites$/);
        await page.evaluate(() => toggleEditMode()); await page.waitForTimeout(500);
        r.pass(`I14: ${names.n} editor control names use labels ("${names.boss}"), no internal ids`);
        r.pass(`phone: map controls (${map.n}) and editor tabs, stars, toolbar (${ed.n}) have 44 px hit areas; search is 44 px tall`);
        await page.evaluate(() => VirtualOfficeChat.openForAgent('alpha', {})); await page.waitForTimeout(1500);
        await page.evaluate(() => { const p = document.querySelector('.chat-panel .hp-pickers'); if (p) { p.hidden = false; p.querySelectorAll('.hp-picker-btn').forEach(b => { b.hidden = false; }); } });
        const chat = await hitAudit(page, '.chat-panel .chat-header button, .chat-panel .hp-picker-btn, .chat-panel .chat-input-row button');
        assert.ok(chat.n >= 6, 'chat controls found: ' + chat.n); assert.deepEqual(chat.small, []);
        await page.keyboard.press('Escape'); await page.waitForTimeout(300);
        await page.evaluate(() => toggleMainMenu()); await page.waitForTimeout(900);
        const set = await hitAudit(page, '.mm-check input[type=checkbox]');
        assert.ok(set.n >= 2, 'settings checkboxes found: ' + set.n); assert.deepEqual(set.small, []);
        r.pass(`phone: chat header, model and effort chips, composer (${chat.n}) and settings checkboxes (${set.n}) have 44 px hit areas`);
        assert.deepEqual(errors, []);
        await context.close();
    }
    // I11: top bar at 375 / 320 px, demo on.
    for (const [w, name] of [[375, 'My Virtual Office'], [320, 'My Virtual Office'], [375, 'Acme Robotics Research Laboratory North']]) {
        const { context, page, errors } = await openPage(browser, { viewport: { width: w, height: 812 }, phone: true,
            fixtures: { '/api/license': { demo: true, valid: false, limits: { maxAgents: 3 } },
                '/vo-config': { version: '0.10.0', office: { name }, features: {}, weather: { location: null } } } });
        await page.waitForFunction(() => !document.querySelector('.vo-topbar [data-vo-demo-pill]').hidden, null, { timeout: 8000 });
        await page.waitForTimeout(400);
        const t = await page.evaluate(() => {
            const el = document.getElementById('vo-topbar-title'), pill = document.querySelector('.vo-topbar [data-vo-demo-pill]');
            const cog = [...document.querySelectorAll('.vo-topbar .vo-btn--icon')].pop();
            const a = el.getBoundingClientRect(), b = pill.getBoundingClientRect(), c = cog.getBoundingClientRect();
            return { text: el.textContent, tip: el.title, cut: el.scrollWidth > el.clientWidth + 1, overlap: a.right > b.left + 0.5 || b.right > c.left + 0.5,
                pillText: getComputedStyle(pill.querySelector('.vo-demo-pill-text')).display, font: getComputedStyle(el).fontSize };
        });
        assert.ok(!t.overlap, 'title, DEMO and the cog do not overlap ' + JSON.stringify(t));
        assert.equal(t.pillText, 'none'); assert.ok(parseFloat(t.font) >= 11, 'the 11 px text floor');
        if (name === 'My Virtual Office') { assert.ok(!t.cut, `${w}: the title fits ${JSON.stringify(t)}`); assert.ok(t.text === name || (t.text === 'My Office' && t.tip === name), JSON.stringify(t)); }
        else { assert.equal(t.tip, name, 'a cut custom name keeps the whole name as its tooltip'); }
        assert.deepEqual(errors, []);
        await context.close();
        r.pass(`I11: ${w} px top bar "${name}" shows "${t.text}"${t.cut ? ' (cut, tooltip)' : ''} beside DEMO and the cog`);
    }
    // Desktop keeps the stack and has no framing reserve.
    {
        const { context, page } = await openPage(browser, { viewport: { width: 1600, height: 900 } });
        const d = await page.evaluate(() => { VOUI.toast('A'); VOUI.toast('B'); VOUI.toast('C');
            return { n: document.querySelectorAll('.vo-toast').length, reserve: getComputedStyle(document.body).getPropertyValue('--vo-framing-reserve').trim() }; });
        assert.equal(d.n, 3); assert.equal(d.reserve, '');
        r.pass('desktop: toasts stack as before, no framing reserve');
        await context.close();
    }
} finally {
    await browser.close();
}
r.done(NAME);
