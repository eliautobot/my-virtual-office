// v0.10 UI-08 + UI-09 + UI-06 (projects tokens): one type scale with an 11 px floor, one UI font token,
// and projects.css on the shared colour tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_type';
const r = reporter();
const CSS = ['ui-modern.css', 'projects.css', 'hp-chat.css', 'v08-chat.css', 'v08-panels.css', 'office-life/life.css', 'office-life/paper.css',
    'ui-themes.css', 'agent-providers.css', 'provider-settings.css', 'office-layouts.css', 'ui-standalone.css', 'session-progress.css', 'v10-ui.css', 'style.css'];
const stripVars = v => v.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '');
const bad = [], small = [];
for (const f of CSS) {
    const src = fs.readFileSync(path.join(APP, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/(?:^|[;{\s])(font-family|font)\s*:\s*([^;{}]+)/g)) {
        const val = stripVars(m[2]);
        if (/apple-system|system-ui|Segoe UI(?! Emoji)|\bArial\b|Helvetica|ui-sans-serif/i.test(val)) bad.push(`${f}: ${m[1]}: ${m[2].trim().slice(0, 50)}`);
    }
    for (const m of src.matchAll(/(?:^|[;{\s])(font-size|font)\s*:\s*([^;{}]+)/g)) {
        for (const px of m[2].matchAll(/(?<![\w.-])(\d+(?:\.\d+)?)px/g)) {
            if (/calc\(/.test(m[2])) break;   // scaled miniatures (Agent PC live preview zoom)
            if (m[1] === 'font' && !/^\s*(?:[a-z0-9]+\s+)*\d/.test(m[2])) continue;
            if (+px[1] < 11 && (m[1] === 'font-size' || m[2].trim().split(/\s+/).some(t => t.startsWith(px[0])))) { small.push(`${f}: ${m[1]}: ${m[2].trim().slice(0, 40)}`); break; }
        }
    }
}
assert.deepEqual(bad, [], 'no literal UI font stacks: use var(--vo-font-ui)');
assert.deepEqual(small, [], 'no font size under 11 px');
const tokens = fs.readFileSync(path.join(APP, 'ui-tokens.css'), 'utf8');
assert.match(tokens, /--vo-pixel-sm: \.6875rem;/, 'pixel caps are 11 px');
r.pass('stylesheets: one font token, 11 px floor');

const proj = stripVars(fs.readFileSync(path.join(APP, 'projects.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
assert.deepEqual(proj.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], 'projects.css uses tokens, not hex colours');
r.pass('projects.css is on the colour tokens');

const browser = await launch(NAME);
try {
    for (const [preset, theme] of [['classic', 'dark'], ['retro', 'light']]) {
        const { context, page } = await openPage(browser, { preset, theme });
        const measure = () => page.evaluate(() => {
            const out = { min: 99, fonts: {}, offenders: [] };
            for (const el of document.querySelectorAll('body *')) {
                if (['SCRIPT', 'STYLE', 'svg', 'use', 'path', 'CANVAS', 'OPTION'].includes(el.tagName)) continue;
                if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
                const rc = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                if (!rc.width || !rc.height || cs.visibility === 'hidden' || rc.bottom < 0 || rc.top > innerHeight) continue;
                if (el.closest('.chat-messages, .agent-preview-source, iframe, .vo-agent-menu-avatar')) continue;
                const fs_ = parseFloat(cs.fontSize);
                if (fs_ < out.min) out.min = fs_;
                if (fs_ < 11) out.offenders.push(el.className + ' ' + fs_);
                const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
                out.fonts[fam] = (out.fonts[fam] || 0) + 1;
            }
            return out;
        });
        await page.waitForTimeout(500);
        await page.evaluate(() => window.VirtualOfficeChat.openForAgent('alpha'));
        await page.waitForTimeout(500);
        await page.evaluate(() => window.VirtualOfficePreviews.openPC('alpha'));
        await page.waitForTimeout(700);
        const a = await measure();
        await page.evaluate(() => { document.querySelector('.agent-preview-panel').style.display = 'none'; window.VirtualOfficeChat.closeAll?.(); toggleMainMenu(); });
        await page.waitForTimeout(500);
        const b = await measure();
        for (const m of [a, b]) {
            assert.deepEqual(m.offenders, [], `${preset}/${theme}: text under 11 px`);
            const fams = Object.keys(m.fonts).filter(f => !['Inter', 'Press Start 2P', 'ui-monospace', 'monospace', 'Apple Color Emoji', 'Georgia'].includes(f));
            assert.deepEqual(fams, [], `${preset}/${theme}: only the token fonts render (${JSON.stringify(m.fonts)})`);
        }
        await context.close();
    }
    r.pass('office, chat, Agent PC and Settings render only token fonts at 11 px or more (classic dark, retro light)');
} finally {
    await browser.close();
}
r.done(NAME);
