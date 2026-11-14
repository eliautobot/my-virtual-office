// v0.10 UI-07 + UI-20: pixel SVG icons instead of emoji, and readable Skills rows.
// 1) every #i-* icon referenced by the app exists in the index.html sprite;
// 2) chat, Agent PC, Skills and the branch rows show no emoji on their buttons;
// 3) Skills rows show a readable name + description and a quiet delete.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_icons';
const r = reporter();

// 1) Static: referenced icons exist.
const sprite = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const have = new Set([...sprite.matchAll(/<symbol id="(i-[a-z0-9-]+)"/g)].map(m => m[1]));
const files = ['index.html', 'game.js', 'chat.js', 'chat-cards.js', 'chat-sidepanel.js', 'sms-panel.js', 'browser-panel.js',
    'agent-preview-hub.mjs', 'ui-modern.js', 'vo-icons.js', 'projects.js'];
const missing = [];
for (const f of files) {
    const src = fs.readFileSync(path.join(APP, f), 'utf8');
    for (const m of src.matchAll(/#(i-[a-z0-9]+(?:-[a-z0-9]+)*)["'`]/g)) if (!have.has(m[1])) missing.push(`${f}: ${m[1]}`);
}
assert.deepEqual(missing, [], 'every referenced icon has a <symbol>');
const kinds = fs.readFileSync(path.join(APP, 'agent-preview-hub.mjs'), 'utf8').match(/const KIND_ICONS = Object\.freeze\(\{([\s\S]*?)\}\)/)[1];
for (const m of kinds.matchAll(/'([a-z]+)'/g)) assert.ok(have.has('i-' + m[1]), `Agent PC kind icon i-${m[1]}`);
r.pass(`all referenced pixel icons exist (${have.size} symbols)`);

// 2) + 3) Live, hermetic.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{23E9}-\u{23FA}\u{2B50}\u{21BB}\u{2630}]/u;
const browser = await launch(NAME);
try {
    const { context, page } = await openPage(browser, { fixtures: {
        '/api/skills-library': { skills: [
            { name: 'release-notes_writer', description: 'Writes short release notes from a list of commits.' },
            { name: 'triage', description: '' }] },
    } });
    const scan = () => page.evaluate(src => {
        const re = new RegExp(src, 'u');
        const out = [];
        for (const el of document.querySelectorAll('button, [role=button], [role=tab], h2, .modal-emoji, .chat-status, .browser-title, #agentPreviewPanelTitle')) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
            if (el.closest('.chat-messages, .vo-agent-menu-avatar, .chat-agent-pick-face, .agent-pc-identity-icon, .chat-win-av, [data-agent-emoji]')) continue;
            const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('');
            if (re.test(own)) out.push((el.id || el.className || el.tagName) + ' ' + own.trim().slice(0, 12));
        }
        return out;
    }, EMOJI.source);
    await page.evaluate(() => window.VirtualOfficeChat.openForAgent('alpha'));
    await page.waitForFunction(() => document.querySelector('#chat-panel.open'), null, { timeout: 8000 });
    await page.waitForTimeout(400);
    assert.deepEqual(await scan(), [], 'chat window');
    await page.evaluate(() => window.VirtualOfficePreviews.openPC('alpha'));
    await page.waitForTimeout(800);
    assert.deepEqual(await scan(), [], 'Agent PC');
    const pc = await page.evaluate(() => ({ title: document.getElementById('agentPreviewPanelTitle').textContent,
        tabs: [...document.querySelectorAll('[data-agent-pc-section] use')].length }));
    assert.ok(!EMOJI.test(pc.title) && pc.tabs >= 5, JSON.stringify(pc));
    r.pass('chat window and Agent PC use pixel icons, no emoji');

    await page.evaluate(() => { window.VirtualOfficeChat.closeAll?.(); document.querySelector('.agent-preview-panel').style.display = 'none'; });
    await page.evaluate(() => openSkillsLibrary());
    await page.waitForSelector('#skl-cards .skl-card', { timeout: 5000 });
    assert.deepEqual(await scan(), [], 'Skills library');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#skl-cards .skl-card')].map(c => ({
        key: c.dataset.sklName, name: c.querySelector('.skl-card-name').textContent, desc: c.querySelector('.skl-card-desc')?.textContent || '',
        icons: [...c.querySelectorAll('.skl-card-actions use')].map(u => u.getAttribute('href')),
        danger: !!c.querySelector('[data-skl-action="delete"].is-danger') })));
    assert.deepEqual(rows[0], { key: 'release-notes_writer', name: 'release notes writer', desc: 'Writes short release notes from a list of commits.',
        icons: ['#i-apply', '#i-edit', '#i-trash'], danger: true });
    assert.equal(rows[1].desc, '');
    r.pass('Skills rows: readable name + description, pixel icons, delete marked as danger');

    // Empty library: the shared empty-state block with one action.
    await page.evaluate(() => { _sklSkills = []; _sklLoadError = ''; renderSkillCards(); });
    const empty = await page.evaluate(() => { const e = document.querySelector('#skl-cards .vo-empty'); return e && { icon: !!e.querySelector('.vo-empty-icon use'), action: e.querySelector('.vo-empty-action')?.textContent }; });
    assert.deepEqual(empty, { icon: true, action: 'New skill' });
    r.pass('empty Skills library uses the shared empty-state block');
    await context.close();
} finally {
    await browser.close();
}
r.done(NAME);
