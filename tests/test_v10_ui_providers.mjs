// v0.10 UI-26 (+ loading skeleton): Agent Providers shows one quiet outline Chat per agent row that fills
// on row hover; while the list loads it shows skeleton rows in the house style, not a dashed text box.
import assert from 'node:assert/strict';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v10_ui_providers';
const browser = await launch(NAME);
const r = reporter();
const PROVIDERS = { ok: true, manifests: { openclaw: { kind: 'openclaw', name: 'OpenClaw' } }, providers: [{
    id: 'openclaw', kind: 'openclaw', transport: 'gateway', manifest: 'openclaw', name: 'OpenClaw', enabled: true, access: 'full',
    status: { state: 'connected', detail: 'Connected.' }, signsIn: false, fields: {}, secrets: {}, tokenSource: 'office',
    agents: [{ id: 'alpha', name: 'Alpha', emoji: '🤖' }, { id: 'beta', name: 'Beta', emoji: '🦊' }, { id: 'gamma', name: 'Gamma', emoji: '🐙' }] }] };
try {
    let release;
    const gate = new Promise(res => { release = res; });
    const { context, page } = await openPage(browser, { pagePath: '/providers.html', waitAgents: false, fixtures: { '/api/provider-settings': { ok: true, contractVersion: '1.1', providers: [{ id: 'openclaw', name: 'OpenClaw', description: 'Gateway agents', capabilities: {}, settingsSchema: { sections: [] }, resourceSchema: [], skillSchema: [], values: {}, health: { state: 'connected' } }] } } });
    await page.route('**/api/agent-providers', async route => { await gate; route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVIDERS) }); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const loading = await page.evaluate(() => ({ sk: document.querySelectorAll('.vo-skeleton-row').length, dashed: [...document.querySelectorAll('*')].some(e => getComputedStyle(e).borderStyle.includes('dashed') && /Loading/.test(e.textContent || '') && e.children.length === 0) }));
    assert.ok(loading.sk >= 3 && !loading.dashed, JSON.stringify(loading));
    r.pass('loading: skeleton rows, no dashed text box');
    release();
    await page.waitForSelector('a.ap-chat', { timeout: 8000 });
    const look = await page.evaluate(() => { const a = [...document.querySelectorAll('a.ap-chat')]; const cs = getComputedStyle(a[0]);
        return { n: a.length, primary: a.some(x => x.classList.contains('primary')), bg: cs.backgroundColor, color: cs.color }; });
    assert.equal(look.n, 3); assert.equal(look.primary, false);
    assert.equal(look.bg, 'rgba(0, 0, 0, 0)', 'outline Chat button at rest');
    await page.hover('.ap-agent >> nth=1');
    await page.waitForTimeout(150);
    const hov = await page.evaluate(() => [...document.querySelectorAll('a.ap-chat')].map(a => getComputedStyle(a).backgroundColor));
    assert.notEqual(hov[1], 'rgba(0, 0, 0, 0)', 'the hovered row fills its Chat');
    assert.equal(hov[0], 'rgba(0, 0, 0, 0)', 'other rows stay quiet');
    r.pass('agent rows: quiet outline Chat, filled on row hover');
    await context.close();

    // R-08: provider tabs use a pixel icon per built-in kind (the server still sends emoji); a custom provider
    // keeps its own emoji.
    const kinds = [['openclaw', '🦞'], ['hermes', '⚕️'], ['codex', '⌨️'], ['claude-code', '🟣'], ['opencode', '⚡'], ['antigravity', '🌌'], ['acme', '🧪']];
    const rows = kinds.map(([id, icon]) => ({ id, name: id, icon, description: '', capabilities: {}, settingsSchema: { sections: [] }, resourceSchema: [], skillSchema: [], values: {}, health: { state: 'connected' } }));
    const p2 = await openPage(browser, { pagePath: '/providers.html', waitAgents: false, fixtures: { '/api/provider-settings': { ok: true, contractVersion: '1.1', providers: rows }, '/api/agent-providers': PROVIDERS } });
    await p2.page.waitForSelector('.ps-provider-tab', { timeout: 8000 });
    await p2.page.waitForTimeout(300);
    const tabs = await p2.page.evaluate(() => [...document.querySelectorAll('.ps-provider-tab')].map(b => { const i = b.querySelector('.ps-tab-icon'); const use = i.querySelector('use');
        const ref = use && use.getAttribute('href'); const sym = ref && document.querySelector(ref); const box = i.querySelector('svg') && i.querySelector('svg').getBoundingClientRect();
        return { id: b.dataset.providerId, text: i.textContent, ok: !!(sym && sym.querySelector('path')), w: box ? Math.round(box.width) : 0 }; }));
    const head = await p2.page.evaluate(() => !!document.querySelector('#ps-icon svg use'));
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}]/u;
    for (const t of tabs.filter(t => t.id !== 'acme')) assert.ok(t.ok && t.w === 16 && !EMOJI.test(t.text), `R-08 tab ${JSON.stringify(t)}`);
    assert.equal(new Set(tabs.filter(t => t.id !== 'acme').map(t => t.id)).size, 6, JSON.stringify(tabs));
    assert.equal(tabs.find(t => t.id === 'acme').text, '🧪', 'a custom provider keeps its emoji');
    assert.ok(head, 'the provider heading shows the pixel icon');
    assert.deepEqual(p2.errors, [], 'page errors (provider icons)');
    r.pass('R-08 provider tabs: a pixel icon per built-in kind (6), custom providers keep their emoji');
    await p2.context.close();
} finally {
    await browser.close();
}
r.done(NAME);
