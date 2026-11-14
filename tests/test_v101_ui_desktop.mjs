// v0.10.1 desktop playtest fixes (ptui).
// I3: an open dashboard folds away while the office editor is open and comes back after; the saved
//     "dashboard hidden" choice is not touched; a dashboard hidden before editing stays hidden.
// I5: (v0.12) themes style the interface only: Retro and Gameboy draw the office as Classic does, by day and by night.
// I10: in the 380 px chat window the chips are not cut (the model chip drops its provider, the row may wrap) and a
//      session row keeps the rename pencil on its title line (compact rows).
// I16: the editor Pet tab's "Office pet" checkbox sits on the line of its label (desktop and phone).
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v101_ui_desktop';
const browser = await launch(NAME);
const r = reporter();
const dash = page => page.evaluate(() => ({ collapsed: document.getElementById('sidebar').classList.contains('collapsed'),
    saved: localStorage.getItem('vo-dashboard-hidden'), canvasW: Math.round(document.getElementById('officeCanvas').getBoundingClientRect().width) }));
try {
    {
        const { context, page, errors } = await openPage(browser, {});
        await page.evaluate(() => { if (window._voLicense) window._voLicense.demo = false; });
        const before = await dash(page);
        assert.equal(before.collapsed, false);
        await page.evaluate(() => toggleEditMode()); await page.waitForTimeout(700);
        const editing = await dash(page);
        assert.equal(editing.collapsed, true, 'dashboard folded while editing');
        assert.notEqual(editing.saved, '1', 'the saved choice stays "shown"');
        assert.ok(editing.canvasW > before.canvasW + 200, `the office got the room: ${before.canvasW} -> ${editing.canvasW}`);
        await page.evaluate(() => toggleEditMode()); await page.waitForTimeout(700);
        assert.equal((await dash(page)).collapsed, false, 'dashboard back after editing');
        r.pass(`I3: dashboard folds while editing (office ${before.canvasW} -> ${editing.canvasW} px wide) and comes back`);
        // Reopened during editing: stays open after; hidden before editing: stays hidden.
        await page.evaluate(() => toggleEditMode()); await page.waitForTimeout(400);
        await page.evaluate(() => toggleSidebar()); await page.waitForTimeout(400);
        await page.evaluate(() => toggleEditMode()); await page.waitForTimeout(400);
        assert.equal((await dash(page)).collapsed, false);
        await page.evaluate(() => toggleSidebar()); await page.waitForTimeout(400);
        await page.evaluate(() => toggleEditMode()); await page.waitForTimeout(400);
        await page.evaluate(() => toggleEditMode()); await page.waitForTimeout(400);
        const hidden = await dash(page);
        assert.equal(hidden.collapsed, true); assert.equal(hidden.saved, '1');
        r.pass('I3: a dashboard reopened while editing stays open; one hidden before stays hidden');
        assert.deepEqual(errors, []);
        await context.close();
    }
    // I5 (v0.12): themes style the interface only. Retro and Gameboy used to tint the office (sepia, four greens
    // with outlined people); now, by day and by night, they draw the office exactly as Classic does.
    for (const night of [0, 1]) {
        const { context, page, errors } = await openPage(browser, { preset: 'classic', theme: 'dark' });
        const m = await page.evaluate(async (night) => {
            window.requestAnimationFrame = () => 0; await new Promise(res => setTimeout(res, 100));
            const T = Date.now(), R0 = Date; window.Date = class extends R0 { constructor(...a) { if (a.length === 0) super(T); else super(...a); } static now() { return T; } };
            const P = performance.now(); performance.now = () => P;
            window.getAmbientLight = () => (night ? { dark: 0.4, tint: '0,10,40' } : { dark: 0, tint: '0,0,0' });
            const shot = async (preset) => {
                window.VOThemeSuite.applyPreset(preset, false);
                await new Promise(res => setTimeout(res, 30));
                for (let i = 0; i < 2; i++) { _simLastAt = P; _simAccumulator = 0; _lastDrawAt = -1e9; _sceneDirty = true; _staticLayerForce = true; _renderFrame(P); }
                const c = document.getElementById('officeCanvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let h = 0; for (let i = 0; i < d.length; i += 4) h = (Math.imul(h, 31) + (d[i] << 16 | d[i + 1] << 8 | d[i + 2])) | 0;
                return h;
            };
            return { classic: await shot('classic'), retro: await shot('retro'), gameboy: await shot('gameboy'), level: _nightLevel() };
        }, night);
        assert.equal(m.retro, m.classic, `Retro ${night ? 'night' : 'day'}: office drawn as in Classic`);
        assert.equal(m.gameboy, m.classic, `Gameboy ${night ? 'night' : 'day'}: office drawn as in Classic`);
        assert.equal(m.level > 0, !!night, `night level ${m.level}`);
        assert.deepEqual(errors, []);
        await context.close();
    }
    r.pass('I5 (v0.12): Retro and Gameboy draw the office as Classic does, by day and by night (themes style the UI only)');
    // I10: chat window chips and session rows.
    {
        const { context, page, errors } = await openPage(browser, {});
        await page.evaluate(() => VirtualOfficeChat.openForAgent('beta', {})); await page.waitForTimeout(1200);
        await page.evaluate(() => [...document.querySelectorAll('.chat-panel .chat-sessions-toggle')].find(b => b.getBoundingClientRect().width > 0)?.click());
        await page.waitForTimeout(500);
        const c = await page.evaluate(() => {
            const p = [...document.querySelectorAll('.chat-panel')].find(x => x.getBoundingClientRect().width > 0);
            const bar = p.querySelector('.chat-model-bar'), pk = p.querySelector('.hp-pickers');
            pk.hidden = false; bar.hidden = false;
            const m = pk.querySelector('.hp-model-btn'), e = pk.querySelector('.hp-effort-btn');
            m.hidden = false; e.hidden = false;
            m.innerHTML = '<span>stub-1</span><span class="hp-chip-provider"> · Custom endpoint</span>';
            e.innerHTML = '<span class="hp-chip-prefix">Effort: </span><span>Default</span>';
            const ctxi = p.querySelector('.chat-context-info'); if (ctxi) { ctxi.hidden = false; ctxi.textContent = 'Context 6%'; }
            const cut = [m, e, ctxi].filter(Boolean).filter(x => x.scrollWidth > x.clientWidth + 1).map(x => x.textContent);
            // a session row as chat.js builds it (title, meta, rename, delete)
            const list = p.querySelector('.chat-sessions-list') || p.querySelector('.chat-sessions-panel') || p;
            const row = document.createElement('div'); row.className = 'chat-session-item';
            row.innerHTML = '<div class="cs-title">A long session title that goes on</div><div class="cs-meta"><span>2m</span><span>4 messages</span></div>' +
                '<button class="chat-session-rename" type="button">e</button><button class="chat-session-delete" type="button">x</button>';
            list.appendChild(row);
            const rr = row.getBoundingClientRect(), rn = row.querySelector('.chat-session-rename').getBoundingClientRect(), ti = row.querySelector('.cs-title').getBoundingClientRect();
            return { width: Math.round(p.getBoundingClientRect().width), narrow: p.classList.contains('chat-narrow'),
                provider: getComputedStyle(m.querySelector('.hp-chip-provider')).display, cut, rowH: Math.round(rr.height),
                pencilOnTitleLine: rn.top < ti.bottom && rn.left >= ti.right - 1, displayed: rr.height > 0 };
        });
        assert.ok(c.narrow && c.width <= 400, JSON.stringify(c));
        assert.equal(c.provider, 'none'); assert.deepEqual(c.cut, [], 'no chip cut');
        if (c.displayed) { assert.ok(c.rowH <= 64, 'compact session row (was 80 with the pencil on its own line): ' + c.rowH); assert.ok(c.pencilOnTitleLine, JSON.stringify(c)); }
        r.pass(`I10: ${c.width} px chat window - no chip cut (provider hidden)` + (c.displayed ? `; session row ${c.rowH} px with the pencil on the title line` : ''));
        assert.deepEqual(errors, []);
        await context.close();
    }
    // I16: Pet tab checkbox inline with its label.
    for (const phone of [false, true]) {
        const { context, page, errors } = await openPage(browser, phone ? { viewport: { width: 412, height: 915 }, phone: true } : {});
        await page.evaluate(() => { if (window._voLicense) window._voLicense.demo = false; toggleEditMode(); });
        await page.waitForTimeout(800);
        await page.evaluate(() => document.querySelector('#furniture-catalog .catalog-tabs button[data-pane=pet]').click());
        await page.waitForTimeout(300);
        const p = await page.evaluate(() => {
            const cb = document.getElementById('pet-enable-check'), lab = cb.closest('label').querySelector('span');
            const a = cb.getBoundingClientRect(), b = lab.getBoundingClientRect();
            return { dy: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2), left: a.right <= b.left, cb: [a.width, a.height], h: cb.closest('label').getBoundingClientRect().height };
        });
        assert.ok(p.dy <= 4 && p.left, `${phone ? 'phone' : 'desktop'}: checkbox beside "Office pet" ${JSON.stringify(p)}`);
        if (phone) assert.ok(p.h >= 44, 'phone: the row is a 44 px target');
        assert.deepEqual(errors, []);
        await context.close();
    }
    r.pass('I16: the Office pet checkbox sits on its label line (desktop and phone, 44 px row on touch)');
} finally {
    await browser.close();
}
r.done(NAME);
