// v0.10.1 N8: the emoji left in the interface after v0.10 are pixel icons now.
// 1) static: New Agent, Create Agent, Unassigned branch, Studio branch options, chat session delete, skill and meeting
//    delete, Agent PC / workspace / browser window glyphs, catalog cards and the setup wizard carry no emoji or glyphs;
// 2) the setup wizard has the pixel sprite symbols it uses;
// 3) the newspaper draws pixel sprites through the Studio's data-studio-sprite hook (view, size, no floor per canvas);
// 4) in the page: the Studio's New Agent button and the Unassigned branch header show pixel icons.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v101_ui_icons';
const r = reporter();
const read = f => fs.readFileSync(path.join(APP, f), 'utf8');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}]/u;

const game = read('game.js');
for (const needle of ["'➕ New Agent'", '<span class="modal-emoji">➕</span>', "emoji: '❓'", "delBtn.textContent = '🗑️'", '🗑️ Delete</button>',
    '✅ End Meeting', "'▣' : '□'", 'iconSpan.textContent = item.icon']) assert.ok(!game.includes(needle), 'game.js still has ' + needle);
assert.ok(game.includes("addBtn.innerHTML = '<svg class=\"vo-icon\" aria-hidden=\"true\" focusable=\"false\"><use href=\"#i-plus\"/></svg><span>New Agent</span>'"));
const idx = read('index.html');
for (const label of ['Snap left', 'Snap right', 'Maximize or restore', 'Close Agent PC', 'Maximize workspace', 'Close workspace', 'Minimize browser', 'Maximize browser']) {
    const m = idx.match(new RegExp('aria-label="' + label + '">(.*?)</button>'));
    assert.ok(m && /^<svg class="vo-icon"[^>]*><use href="#i-[a-z-]+"\/><\/svg>$/.test(m[1]), label + ' is a pixel icon: ' + (m && m[1]));
}
for (const id of ['i-snap-left', 'i-snap-right', 'i-maximize', 'i-restore']) assert.ok(idx.includes(`<symbol id="${id}"`), id);
const bp = read('browser-panel.js');
assert.ok(!/textContent = '[—▲❐□]'/.test(bp), 'browser window buttons use pixel icons');
const chat = read('chat.js');
assert.ok(!chat.includes("del.textContent = '\\u{1F5D1}'") && chat.includes('<use href="#i-trash"/>'), 'chat session delete is a pixel trash icon');
const studio = read('v10-studio.js');
assert.ok(studio.includes("var o = el('option', '', b.name);"), 'Studio branch options: names only');
assert.ok(!/else thumb\.textContent = info\.icon/.test(read('ui-modern.js')), 'quick catalog cards: no emoji fallback');
r.pass('static: New Agent, Create Agent, branch, session/skill/meeting delete, window glyphs and catalog cards use pixel icons');

const setup = read('setup.html');
const body = setup.slice(setup.indexOf('<body'));
const visible = body.replace(/<!--[\s\S]*?-->/g, '');
assert.ok(!EMOJI.test(visible), 'setup.html has no emoji: ' + (visible.match(EMOJI) || [''])[0]);
const used = new Set([...setup.matchAll(/#i-([a-z0-9-]+)|icon\('([a-z0-9-]+)'\)/g)].map(m => 'i-' + (m[1] || m[2])));
for (const id of used) assert.ok(setup.includes(`<symbol id="${id}"`), 'setup.html sprite has ' + id);
assert.ok(/data-action="finish" id="finish-btn"><svg class="vo-icon"[^>]*><use href="#i-play"\/><\/svg>Launch Office<\/button>/.test(setup));
r.pass(`setup wizard: no emoji, its ${used.size} pixel icons are in the page sprite`);

const paper = read('office-life/paper.js');
assert.ok(!paper.includes('vo-paper-emoji') && paper.includes("cv.dataset.studioSprite = String(key);"), 'newspaper: sprites, not emoji');

const browser = await launch(NAME);
try {
    const { context, page, errors } = await openPage(browser, {});
    await page.evaluate(() => new Promise(res => _voLazyLoad('studio', res)));
    const px = await page.evaluate(() => {
        const cv = document.createElement('canvas');
        Object.assign(cv.dataset, { studioSprite: 'alpha', studioView: 'card', studioSize: '24', studioFloor: '0' });
        document.body.appendChild(cv);
        VOStudio.drawSprites(document.body);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let opaque = 0, corner = d[3];
        for (let i = 3; i < d.length; i += 4) if (d[i] > 200) opaque++;
        return { w: cv.width, h: cv.height, opaque, corner };
    });
    assert.equal(px.w, 24); assert.equal(px.h, 24);
    assert.ok(px.opaque > 40, 'the sprite is drawn: ' + px.opaque); assert.equal(px.corner, 0, 'no floor behind it');
    r.pass(`newspaper hook: a 24 px card sprite without floor (${px.opaque} opaque px)`);
    await page.evaluate(() => toggleAgentPanel()); await page.waitForTimeout(600);
    const s = await page.evaluate(() => {
        const add = document.querySelector('.agent-add-btn');
        const un = [...document.querySelectorAll('.branch-header-row')].find(h => /Unassigned/.test(h.textContent));
        return { addText: add && add.textContent.trim(), addIcon: !!(add && add.querySelector('use[href="#i-plus"]')),
            unText: un ? un.textContent.trim() : null, unIcon: un ? !!un.querySelector('use[href="#i-branch"]') : null };
    });
    assert.equal(s.addText, 'New Agent'); assert.ok(s.addIcon);
    if (s.unText !== null) { assert.ok(!EMOJI.test(s.unText), s.unText); assert.ok(s.unIcon); }
    r.pass('Studio: New Agent shows a pixel plus' + (s.unText !== null ? '; Unassigned branch header a pixel branch icon' : ''));
    assert.deepEqual(errors, []);
    await context.close();
} finally {
    await browser.close();
}
r.done(NAME);
