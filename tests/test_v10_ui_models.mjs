// v0.10 UI-16: the Models page in the Agent Providers style: Inter body text on the type scale, plain
// tab labels, 40+ px controls, quiet danger buttons, rows that stack on phones (no one-word lines),
// pixel state icons instead of emoji, auth stores in a closed Advanced fold.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_models';
const r = reporter();
const src = fs.readFileSync(path.join(APP, 'models.html'), 'utf8');
assert.match(src, /models-v10\.css/);
assert.match(src, /<details class="advanced">/, 'auth stores fold starts closed');
assert.doesNotMatch(src, /class="btn btn-red" data-action="reset-overrides"/, 'reset is a quiet danger button');
assert.doesNotMatch(src.match(/<div class="tabs"[\s\S]*?<\/div>/)[0], /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'tab labels without emoji');
r.pass('markup: v10 stylesheet, closed Advanced fold, quiet reset, plain tabs');
const SAMPLE = `<div class="card"><div class="row"><label>Provider ID</label><input value="local-llm"></div>
  <div class="model-list auth-help"><div class="model-item"><span>Managed Static Profiles</span><span>uses main as the source for API-key and static-token profiles.</span></div></div>
  <button type="button" class="btn btn-danger-quiet">Reset overrides</button><button type="button" class="btn btn-gold">Save</button></div>`;
const browser = await launch(NAME);
try {
    for (const [w, h, phone] of [[1600, 900, false], [412, 915, true]]) {
        const { context, page } = await openPage(browser, { pagePath: '/models.html', viewport: { width: w, height: h }, phone, waitAgents: false,
            fixtures: { '/api/native-models': { __status: 500, ok: false, error: 'boom' } } });
        await page.waitForSelector('#openclaw-models .vo-state-card.is-error', { timeout: 10000 });
        await page.evaluate(html => { document.getElementById('codex-models').innerHTML = html; document.querySelector('[data-tab="codex"]').click(); }, SAMPLE);
        await page.waitForTimeout(200);
        const m = await page.evaluate(() => {
            const cs = s => getComputedStyle(document.querySelector(s));
            const item = document.querySelector('#codex-models .model-item span:last-child').getBoundingClientRect();
            return { font: cs('body').fontFamily.split(',')[0].replace(/"/g, ''), size: parseFloat(cs('body').fontSize), tab: document.querySelector('.tab').getBoundingClientRect().height,
                stateIcon: !!document.querySelector('#openclaw-models .vo-state-icon svg path'), row: cs('#codex-models .row').flexDirection,
                danger: [cs('#codex-models .btn-danger-quiet').backgroundColor, cs('#codex-models .btn-danger-quiet').color], valueW: Math.round(item.width), vw: innerWidth };
        });
        assert.equal(m.font, 'Inter'); assert.ok(m.size >= 13, `body ${m.size}px`); assert.ok(m.tab >= 40, `tab ${m.tab}px`);
        assert.ok(m.stateIcon, 'pixel icon in the error state');
        assert.equal(m.danger[0], 'rgba(0, 0, 0, 0)', 'danger button is quiet at rest');
        if (phone) { assert.equal(m.row, 'column'); assert.ok(m.valueW > m.vw * 0.6, `phone: value text uses the row width (${m.valueW})`); }
        await context.close();
    }
    r.pass('desktop + phone: Inter 14 px, 40+ px tabs, pixel state icon, quiet danger, stacked rows on phones');
} finally {
    await browser.close();
}
r.done(NAME);
