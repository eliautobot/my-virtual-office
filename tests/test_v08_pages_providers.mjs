// Agent Providers page, ex Provider SDK (CH-07 provider-settings part, CH-35 client, CH-36 providers part, DS-14;
// Hermes port A5: hermes/openclaw handed to agent-providers.js, generic page kept when its routes are missing):
//   node tests/test_v08_pages_providers.mjs
// Skips when chrome, playwright-core or the running office is missing. All writes are mocked or aborted.
import { launchOrSkip, guardedPage, json, check, finish, shot, SIZES, BASE } from './test_v08_pages_lib.mjs';

const FIXTURE = () => ({
  ok: true,
  providers: [
    {
      id: 'hermes', name: 'Hermes', icon: '☤', description: 'Hermes gateways',
      capabilities: { chat: true, resourcesRead: true, sessionSwitch: true, agentCreate: false, fooBarBaz: true },
      health: { pending: true },
      values: { enabled: true, timeoutSec: 600, mode: 'legacy-mode', connections: [
        { id: 'astra', name: 'Astra', apiUrl: 'http://127.0.0.1:8642', apiKeyConfigured: true, enabled: true },
        { id: 'coby', name: 'Coby', apiUrl: 'http://127.0.0.1:8954', apiKeyConfigured: true, enabled: true },
      ] },
      settingsSchema: { sections: [
        { id: 'conn', label: 'Connections', fields: [
          { key: 'enabled', type: 'boolean', label: 'Enabled' },
          { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
          { key: 'timeoutSec', type: 'number', label: 'Timeout', default: 600 },
          { key: 'bad', type: 'link', label: 'Bad link', href: 'javascript:window.__xss=1', actionLabel: 'Open bad' },
          { key: 'good', type: 'link', label: 'Models', href: '/models.html', actionLabel: 'Open models' },
          { key: 'connections', type: 'connection-list', label: 'Gateways', itemLabel: 'Gateway', itemFields: [
            { key: 'id', type: 'slug', label: 'ID' }, { key: 'name', type: 'text', label: 'Name' },
            { key: 'apiUrl', type: 'url', label: 'API URL' }, { key: 'apiKey', type: 'secret', label: 'API key' },
            { key: 'port', type: 'number', label: 'Port' }, { key: 'enabled', type: 'boolean', label: 'Enabled', default: true },
          ] },
        ] },
      ] },
      resourceSchema: [], skillSchema: [],
    },
    {
      id: 'codex', name: 'Codex <b>CLI</b>', icon: '⌘', description: '<img src=x onerror=window.__xss=2>',
      capabilities: { chat: true }, health: { ok: true },
      values: { model: 'gpt' },
      settingsSchema: { sections: [{ id: 's', label: 'Setup', fields: [{ key: 'model', type: 'model', label: 'Model' }] }] },
      resourceSchema: [], skillSchema: [],
    },
  ],
});

const results = [];
const browser = await launchOrSkip('providers');
if (browser) {
  try {
    // 1. Real server, read only, both sizes and themes (including a non-classic preset for DS-14).
    for (const size of SIZES) {
      for (const theme of ['dark', 'light']) {
        const { page, context, blocked, errors } = await guardedPage(browser, { viewport: size.viewport, theme, preset: theme === 'dark' ? 'classic' : 'retro' });
        await page.goto(BASE + '/providers.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#ps-provider:not([hidden]), .vo-state-card', { timeout: 20000 });
        await page.waitForTimeout(300);
        await shot(page, `providers-${size.tag}-${theme}.png`);
        if (size.tag === 'd' && theme === 'dark') {
          check(results, (await page.locator('.ps-provider-tab').count()) > 0, 'real server: providers listed');
          check(results, blocked.length === 0, 'real server: no writes ' + blocked.join(','));
          check(results, errors.filter((e) => !/vo-auth\.js|404/.test(e)).length === 0, 'real server: no page errors ' + errors.join(' | '));
        }
        if (theme === 'light' && size.tag === 'd') {
          check(results, await page.evaluate(() => document.documentElement.dataset.uiPreset) === 'retro', 'preset reaches the providers page (DS-14)');
        }
        await context.close();
      }
    }

    // 2. Mocked: drafts, renames, numbers, links, capability labels, lazy health, save and test payloads.
    {
      const saves = []; const tests = [];
      let healthCalls = 0;
      const settings = { path: '/api/provider-settings', handle: (r, req, url) => {
        const id = url.searchParams.get('providerId');
        if (id) { healthCalls += 1; const f = FIXTURE(); const p = f.providers.find((x) => x.id === id); p.health = { ok: false, error: 'Gateway 2 unreachable' }; return json(r, { ok: true, providers: [p] }); }
        return json(r, FIXTURE());
      } };
      const save = { method: 'POST', path: '/api/provider-settings/save', handle: (r, req, url, body) => { saves.push(body); const f = FIXTURE(); return json(r, { ok: true, provider: Object.assign(f.providers[0], { health: { ok: true } }) }); } };
      const testRoute = { method: 'POST', path: '/api/provider-test', handle: (r, req, url, body) => { tests.push(body); return json(r, { ok: true }); } };
      // No Agent Providers routes (a server before the Hermes port): the generic page shows, as before.
      const noAp = { path: '/api/agent-providers', handle: (r) => json(r, { ok: false, error: 'not_found' }, 404) };
      const { page, context, blocked } = await guardedPage(browser, { mocks: [settings, save, testRoute, noAp] });
      page.on('dialog', (d) => d.accept());
      await page.goto(BASE + '/providers.html?provider=hermes', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#ps-provider:not([hidden])');
      await page.waitForFunction(() => /Needs attention|Connected/.test(document.getElementById('ps-health').textContent), null, { timeout: 5000 });
      check(results, healthCalls === 1, 'pending health is fetched lazily once');
      check(results, await page.evaluate(() => window.__xss === undefined), 'no script from manifest text or links');
      const badHref = await page.getAttribute('a.ps-link:text("Open bad")', 'href');
      check(results, badHref === '#', 'javascript: link neutralised (' + badHref + ')');
      check(results, await page.getAttribute('a.ps-link:text("Open models")', 'href') === '/models.html', 'office link kept');
      const capText = await page.textContent('#ps-capabilities');
      check(results, /Read agent files/.test(capText) && /Switch sessions/.test(capText) && /Foo bar baz/.test(capText) && !/agentCreate/.test(capText), 'capabilities in plain words');
      check(results, await page.$eval('[data-setting-key="mode"]', (s) => s.value) === 'legacy-mode', 'unknown select value kept as (current)');

      // Type in the second gateway, then add a row: the typing survives.
      const nameInput = page.locator('[data-connection-index="1"][data-connection-field="name"]');
      await nameInput.fill('Coby renamed');
      await page.click('button:text("＋ Add connection")');
      check(results, await page.locator('[data-connection-index="1"][data-connection-field="name"]').inputValue() === 'Coby renamed', 'Add connection keeps unsaved typing');
      // Rename the first gateway's id; clear the timeout number.
      await page.locator('[data-connection-index="0"][data-connection-field="id"]').fill('aster2');
      await page.locator('[data-setting-key="timeoutSec"]').fill('');
      // Switch provider and back: drafts survive.
      await page.click('.ps-provider-tab:nth-child(2)');
      await page.waitForFunction(() => /Codex/.test(document.getElementById('ps-name').textContent));
      check(results, await page.textContent('#ps-name') === 'Codex <b>CLI</b>', 'provider name rendered as text');
      await page.click('.ps-provider-tab:nth-child(1)');
      check(results, await page.locator('[data-connection-index="1"][data-connection-field="name"]').inputValue() === 'Coby renamed', 'switching providers keeps unsaved typing');
      check(results, (await page.locator('.ps-connection').count()) === 3, 'added row still there after switching');
      await shot(page, 'providers-draft-d-dark.png');

      // Remove the new empty row, then Test (no save) and Save (changed fields only).
      await page.locator('.ps-connection').nth(2).locator('button:text("Remove")').click();
      await page.click('#ps-test');
      await page.waitForFunction(() => /Nothing was saved|tested the saved/.test(document.getElementById('ps-status').textContent));
      check(results, tests.length === 1 && saves.length === 0 && tests[0].draft === true && tests[0].values && Array.isArray(tests[0].values.connections), 'Test sends the form values and does not save');
      await page.click('#ps-save');
      await page.waitForFunction(() => /Settings saved/.test(document.getElementById('ps-status').textContent));
      const v = saves[0] && saves[0].values;
      check(results, v && !('mode' in v) && !('enabled' in v) && !('timeoutSec' in v), 'save omits unchanged and blank-number fields: ' + JSON.stringify(v && Object.keys(v)));
      const rows = v && v.connections;
      check(results, rows && rows.length === 2 && rows[0].id === 'aster2' && rows[0].originalId === 'astra' && !('apiKey' in rows[0]) && rows[1].name === 'Coby renamed', 'renamed row carries originalId and no blank key: ' + JSON.stringify(rows));
      check(results, rows && !rows.some((row) => 'port' in row), 'blank numbers in rows are left out, not 0');
      check(results, blocked.length === 0, 'no unmocked writes ' + blocked.join(','));
      await context.close();
    }

    // 3. Mocked Agent Providers routes: hermes and openclaw handed to agent-providers.js, desktop and phone.
    const MENU_WRITES = ['profiles.create', 'model.default', 'toolsets.set', 'skills.set', 'mcp.set', 'cron.pause', 'cron.resume', 'cron.run', 'cron.remove', 'sessions.delete', 'config.patch'];
    const MENU = {
      'profiles.list': { profiles: [{ name: 'default', is_default: true }, { name: 'research' }] },
      'toolsets.list': [{ name: 'web', label: 'Web search', enabled: true, description: 'Search and read web pages.' }, { name: 'browser', label: 'Browser', enabled: false }],
      'config.schema': { category_order: ['model'], fields: { 'model.provider': { category: 'model', type: 'string' }, 'providers.openrouter.api_key': { category: 'model', type: 'string' } } },
      'config.get': { config: { model: { provider: 'openrouter' }, providers: { openrouter: { api_key: { secret: true, set: true } } } } },
    };
    for (const size of SIZES) {
      const apPosts = [];
      const AP = () => ({ providers: [
        { id: 'hermes-lab', kind: 'hermes', transport: 'serve', name: 'Hermes Lab', enabled: true, access: 'full',
          status: { state: 'connected', version: '0.22.2' }, fields: { url: 'http://127.0.0.1:9119', auth: 'token', access: 'full', token: 'LEAK-T1' },
          secrets: { token: true, tokens: true }, agents: [{ id: 'hermes-lab', name: 'Default', emoji: '☤', nativeId: 'default' }, { id: 'hermes-lab-astra', name: 'astra', nativeId: 'astra', hidden: true, reason: 'reached through the older connection "astra"' }] },
        { id: 'astra', kind: 'hermes', transport: 'api', name: 'Astra', enabled: true, access: 'full', status: { state: 'connected' },
          fields: { apiUrl: 'http://127.0.0.1:8642', access: 'full' }, secrets: { apiKey: true }, agents: [{ id: 'astra', name: 'Astra', nativeId: 'hermes-agent' }], legacy: {} },
        { id: 'coby', kind: 'hermes', transport: 'api', name: 'Coby', enabled: true, access: 'chat', status: { state: 'error', code: 'auth_rejected', detail: 'Hermes refused the session token.', fix: 'Enter the same token here (Edit).' },
          fields: { apiUrl: 'http://127.0.0.1:8954', access: 'chat' }, secrets: {}, agents: [{ id: 'coby', name: 'Coby', nativeId: 'coby' }], legacy: {} },
        { id: 'openclaw', kind: 'openclaw', transport: 'gateway', name: 'OpenClaw', enabled: true, access: 'full', status: { state: 'connected', version: '2026.10.1' },
          fields: { url: 'ws://127.0.0.1:18789', access: 'full' }, secrets: { token: true }, agents: [{ id: 'main', name: 'Main', emoji: '🦀', nativeId: 'main' }] },
      ], manifests: {} });
      const mocks = [
        { path: '/api/provider-settings', handle: (r) => { const f = FIXTURE(); f.providers.push({ id: 'openclaw', name: 'OpenClaw', icon: '🦀', capabilities: { chat: true }, health: { ok: true },
          values: { gatewayUrl: 'ws://127.0.0.1:18789', homePath: '~/.openclaw' }, settingsSchema: { sections: [{ id: 'connection', label: 'Connection', fields: [
            { key: 'homePath', type: 'path', label: 'Home folder' }, { key: 'gatewayUrl', type: 'url', label: 'Gateway URL' }, { key: 'gatewayToken', type: 'secret', label: 'Gateway token' }] }] },
          resourceSchema: [], skillSchema: [] }); return json(r, f); } },
        { path: '/api/agent-providers', handle: (r) => json(r, AP()) },
        { method: 'POST', path: /^\/api\/agent-providers\/test/, handle: (r, req, url, body) => { apPosts.push(['test', body]); return json(r, { ok: true, detail: 'Connected to Hermes 0.22.2: 2 profiles' }); } },
        { method: 'POST', path: /^\/api\/agent-providers\/call$/, handle: (r, req, url, body) => { menuCalls.push(body.method); return json(r, { ok: true, result: MENU[body.method] || {} }); } },
      ];
      const menuCalls = [];
      const { page, context, blocked, errors } = await guardedPage(browser, { viewport: size.viewport, mocks });
      await page.goto(BASE + '/providers.html?provider=hermes', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#ps-agent-providers:not([hidden]) .ap-pane', { timeout: 10000 });
      const tag = 'agent providers ' + size.tag + ': ';
      check(results, await page.textContent('h1') === 'Agent Providers', tag + 'page titled Agent Providers');
      check(results, (await page.locator('[data-connection-field]').count()) === 0, tag + 'old Hermes connection rows are not a second editor');
      check(results, (await page.locator('details.ps-advanced').count()) === 1 && !(await page.isVisible('#ps-save')), tag + 'provider-wide settings folded under Advanced');
      check(results, (await page.locator('.ap-conn').count()) === 3, tag + 'Hermes connections listed (serve + 2 legacy)');
      if (size.viewport.width <= 760) {
        check(results, (await page.isVisible('.ap-pick')) && !(await page.isVisible('.ap-list')), tag + 'phone: connection list is a select');
        const sel = await page.$eval('.ap-pick', (el) => el.options.length);
        check(results, sel === 3, tag + 'phone select has the 3 connections');
      } else check(results, (await page.isVisible('.ap-list')) && !(await page.isVisible('.ap-pick')), tag + 'desktop: connection list beside the page');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(results, over <= 0, tag + 'no sideways scroll (' + over + ' px)');
      const chatInk = await page.$eval('a.ap-chat', (el) => { const c = getComputedStyle(el); return [c.color, c.backgroundColor]; });
      check(results, chatInk[0] !== chatInk[1], tag + 'Chat link text is not painted in its own background colour ' + chatInk.join(' on '));
      await shot(page, `agent-providers-${size.tag}.png`);
      // B5 menus: Hermes' tabs after Connection; Settings from its schema; a secret setting is an empty password input.
      await page.click('.ap-tab:text("Settings")');
      await page.waitForSelector('.pm-sec', { timeout: 5000 });
      await page.click('.pm-sec:text("Model")');
      const sec = await page.$eval('.pm-field[data-field="providers.openrouter.api_key"] input', (el) => [el.type, el.value, el.placeholder]);
      check(results, sec[0] === 'password' && sec[1] === '' && sec[2] === 'Set: type a new value to change it', tag + 'menu: secret setting is an empty password input');
      const tabsOver = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(results, (await page.locator('.ap-tab').count()) === 11 && tabsOver <= 0, tag + 'menu: Connection + 10 tabs, no sideways scroll (' + tabsOver + ' px)');
      await page.click('.ap-tab:text("Tools")');
      await page.waitForSelector('.pm-row .ps-button', { timeout: 5000 });
      const btnH = await page.$eval('.pm-row .ps-button', (el) => el.getBoundingClientRect().height);
      check(results, size.viewport.width > 760 || btnH >= 44, tag + 'menu: row buttons ' + Math.round(btnH) + ' px tall');
      if (size.viewport.width <= 760) {
        // Every visible control on the page (header, connection select, tabs, buttons, inputs, summaries, switches) is 44 px tall.
        const small = await page.evaluate(() => Array.from(document.querySelectorAll('button, a.ps-button, select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, [role=tab], summary, label.pm-check'))
          .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.height < 43.5; }).map((el) => (el.textContent || el.className).trim().slice(0, 20)));
        check(results, small.length === 0, tag + 'phone: every control 44 px tall ' + small.join(','));
      }
      await shot(page, `agent-providers-menu-${size.tag}.png`);
      check(results, !menuCalls.some((m) => MENU_WRITES.includes(m)), tag + 'menu: reads only ' + menuCalls.join(','));
      await page.click('.ap-tab:text("Connection")');
      await page.click('.ap-acts button:text("Edit")');
      await page.fill('.apf[data-key="token"]', 'typed-token');
      await page.click('.ap-form button:text("Test")');
      await page.waitForFunction(() => /2 profiles/.test(document.querySelector('.ap-form-status').textContent));
      check(results, apPosts.length === 1 && apPosts[0][1].id === 'hermes-lab' && apPosts[0][1].values.token === 'typed-token', tag + 'Test posts the form and does not save');
      const html = await page.content();
      check(results, !/LEAK-T1/.test(html), tag + 'no secret value in the page');
      await page.click('.ps-provider-tab:has-text("OpenClaw")');
      await page.waitForFunction(() => document.querySelector('.ap-page') && document.querySelector('.ap-page').dataset.kind === 'openclaw');
      check(results, (await page.locator('[data-setting-key="gatewayToken"]').count()) === 0 && (await page.locator('.ap-acts button:text("Remove")').count()) === 0, tag + 'OpenClaw: no generic token field, no Remove');
      // "Change in Agent Providers" links (models.html) open the menu tab named in ?tab= on that connection.
      await page.goto(BASE + '/providers.html?provider=hermes&connection=hermes-lab&tab=models', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.ap-menu-body[data-tab="models"]', { timeout: 10000 });
      check(results, (await page.textContent('.ap-tab.on')) === 'Models' && (await page.textContent('.ap-conn.active .ap-conn-name')) === 'Hermes Lab', tag + '?tab=models opens the Models tab of that connection');
      check(results, blocked.length === 0, tag + 'no unmocked writes ' + blocked.join(','));
      check(results, errors.filter((e) => !/vo-auth\.js|404/.test(e)).length === 0, tag + 'no page errors ' + errors.join(' | '));
      await context.close();
    }
  } finally {
    await browser.close();
  }
  finish('providers', results);
}
