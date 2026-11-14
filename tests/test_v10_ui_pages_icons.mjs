// v0.10 UI-07 on the standalone pages: no emoji used as icons in cron / models / login / providers
// chrome, and every pixel icon the cron page asks for exists in its inline sprite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{23E9}-\u{23FA}]/u;
const cron = fs.readFileSync(path.join(APP, 'cron.html'), 'utf8');
const have = new Set([...cron.matchAll(/<symbol id="(i-[a-z0-9-]+)"/g)].map(m => m[1]));
const used = new Set([...cron.matchAll(/ic\('([a-z0-9-]+)'\)/g)].map(m => 'i-' + m[1]).concat([...cron.matchAll(/href="#(i-[a-z0-9-]+)"/g)].map(m => m[1])));
const missing = [...used].filter(n => !have.has(n));
assert.deepEqual(missing, [], 'cron icons exist in its sprite');
// Agent emoji and user content stay; the page chrome (markup + templates) has no emoji icons.
for (const f of ['cron.html', 'models.html', 'login.html', 'providers.html']) {
    const lines = fs.readFileSync(path.join(APP, f), 'utf8').split('\n').filter(l => EMOJI.test(l) && !/emoji|avatar|data-emoji|\.emoji/i.test(l));
    assert.deepEqual(lines.map(l => l.trim().slice(0, 80)), [], `${f}: emoji used as icons`);
}
// The theme toggles say Light / Dark in words.
for (const f of ['ui-themes.js', 'ui-standalone.js']) assert.doesNotMatch(fs.readFileSync(path.join(APP, f), 'utf8'), /['"](☀️|🌙) /u, f);
console.log(`[PASS] standalone pages use pixel icons (${used.size} cron icons resolve)`);
console.log('ALL 1 test_v10_ui_pages_icons CHECKS PASSED');
