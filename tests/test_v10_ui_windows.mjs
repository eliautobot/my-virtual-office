// v0.10 UI-06 + UI-17: one window shell (same radius, shadow, header height, backdrop, S/M/L widths)
// for Projects, Meetings, Skills and the confirm/tournament dialogs; one empty-state block;
// Projects closes its grid with a "New project" tile.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_windows';
const browser = await launch(NAME);
const r = reporter();
const PROJECT = { id: 'p1', title: 'Launch checklist', description: 'Get the release out', status: 'active', priority: 'medium',
    createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z', tags: [], tasks: [] };
try {
    for (const [preset, theme, radius] of [['classic', 'dark', '12px'], ['gameboy', 'light', '4px']]) {
        const { context, page } = await openPage(browser, { preset, theme, fixtures: {
            '/api/meetings/active': { ok: true, meetings: [] }, '/api/meetings/history': { ok: true, meetings: [] },
            '/api/skills-library': { skills: [] }, '/api/projects': { ok: true, projects: [PROJECT] },
        } });
        const frame = async sel => { await page.waitForTimeout(260); return page.evaluate(s => {
            const m = document.querySelector(s);
            const c = m.querySelector('.modal-content');
            const h = c.querySelector('.modal-header');
            const cs = getComputedStyle(c), ms = getComputedStyle(m);
            return { radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, head: Math.round(h.getBoundingClientRect().height),
                width: Math.round(c.getBoundingClientRect().width), blur: ms.backdropFilter, z: +ms.zIndex };
        }, sel); };
        const close = sel => page.evaluate(s => document.querySelector(s).classList.add('hidden'), sel);

        await page.evaluate(() => openMeetingsDashboard());
        await page.waitForSelector('#mtg-cards .vo-empty', { timeout: 5000 });
        const mt = await frame('#meetingsModal');
        const mtEmpty = await page.evaluate(() => document.querySelector('#mtg-cards .vo-empty-title').textContent);
        await close('#meetingsModal');
        await page.evaluate(() => openSkillsLibrary());
        await page.waitForSelector('#skl-cards .vo-empty', { timeout: 5000 });
        const sk = await frame('#skillsLibraryModal');
        await close('#skillsLibraryModal');
        await page.evaluate(() => window.openProjectsManager());
        await page.waitForSelector('#projectsModal .proj-card-new', { timeout: 6000 });
        const pj = await frame('#projectsModal');
        const tile = await page.evaluate(() => document.querySelector('#projectsModal .proj-card-new').textContent.trim());

        for (const f of [mt, sk, pj]) {
            assert.equal(f.radius, radius, `${preset}: window radius`);
            assert.equal(f.shadow, mt.shadow, `${preset}: one window shadow`);
            assert.ok(Math.abs(f.head - 56) <= 1, `${preset}: header height ${f.head}`);
            assert.match(f.blur, /blur\(6px\)/, `${preset}: backdrop blur`);
        }
        assert.equal(mt.width, 760); assert.equal(sk.width, 760); assert.equal(pj.width, 1120);
        assert.equal(mtEmpty, 'No meetings right now');
        assert.equal(tile, 'New project');
        r.pass(`${preset}/${theme}: Meetings, Skills, Projects share one frame (radius ${radius}, shadow, 56 px header, 6 px backdrop, M/M/L)`);

        // The confirm dialog (vo-window--sm) uses the same frame and stays above the modal band.
        await page.evaluate(() => { window.VOUI.confirm && window.VOUI.confirm({ title: 'Delete?', message: 'Sure?' }); });
        await page.waitForTimeout(250);
        const dlg = await page.evaluate(() => { const d = document.querySelector('.vo-dialog'); if (!d) return null; const cs = getComputedStyle(d);
            return { radius: cs.borderTopLeftRadius, w: Math.round(d.getBoundingClientRect().width), z: +cs.zIndex }; });
        if (dlg) {
            assert.equal(dlg.radius, radius); assert.ok(Math.abs(dlg.w - 480) <= 2, `dialog width ${dlg.w} (open animation may still run under load)`); assert.ok(dlg.z > pj.z, 'dialog above the open window');
            r.pass(`${preset}/${theme}: confirm dialog on the same frame, S width, above windows`);
        }
        // The branch editor popup moved onto the same frame (no inline colours left).
        await page.evaluate(() => { document.querySelectorAll('.vo-dialog').forEach(d => d.remove()); branchEditPrompt('HQ'); });
        await page.waitForTimeout(250);
        const be = await page.evaluate(() => { const p = document.getElementById('branch-edit-popup'); const cs = getComputedStyle(p);
            return { cls: p.className, radius: cs.borderTopLeftRadius, inline: /#[0-9a-f]{3,6}/i.test(p.innerHTML.replace(/value="#[0-9a-f]{6}"|>#[0-9a-f]{6}</gi, '')), rows: p.querySelectorAll('.vo-check-row').length }; });
        assert.match(be.cls, /vo-window/); assert.equal(be.radius, radius); assert.equal(be.inline, false); assert.equal(be.rows, 3);
        r.pass(`${preset}/${theme}: branch editor on the window frame`);
        // Q-12: the text label and weather window editors too, with previews drawn by the office code.
        const mini = await page.evaluate(async () => {
            document.querySelectorAll('.vo-dialog').forEach(d => d.remove());
            const out = [];
            const one = (id) => {
                const p = document.getElementById(id), cs = getComputedStyle(p), cv = p.querySelector('canvas');
                const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let drawn = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i]) drawn++;
                const styled = [...p.querySelectorAll('[style]')].filter(n => n.tagName !== 'CANVAS').length + (p.hasAttribute('style') ? 1 : 0);
                return { id, cls: p.className, radius: cs.borderTopLeftRadius, styled, drawn, emoji: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(p.textContent) };
            };
            _showTextLabelEditor({ id: 'q12', type: 'textLabel', x: 200, y: 200, text: 'Kitchen', labelColor: '#ffcc00', fontSize: 12 });
            out.push(one('text-label-editor'));
            document.querySelector('#text-label-editor [data-mini-cancel]').click();
            _showInteractiveWindowEditor({ id: 'q12w', type: 'interactiveWindow', x: 100, y: 100 });
            out.push(one('iw-editor'));
            document.querySelector('#iw-editor [data-mini-close]').click();
            out.push(!document.getElementById('iw-editor'));
            return out;
        });
        for (const m of mini.slice(0, 2)) {
            assert.match(m.cls, /vo-window/, m.id); assert.equal(m.radius, radius, m.id);
            assert.equal(m.styled, 0, `${m.id}: inline styles left`); assert.ok(m.drawn > 500, `${m.id}: preview not drawn`); assert.equal(m.emoji, false, `${m.id}: emoji`);
        }
        assert.equal(mini[2], true, 'close button removes the editor');
        r.pass(`${preset}/${theme}: text label + weather window editors on the window frame, no inline styles, previews drawn by the office`);
        await context.close();
    }
} finally {
    await browser.close();
}
r.done(NAME);
