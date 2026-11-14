// Models page (CH-07 models part, CH-08 client, CH-34, CH-36 models part, CH-47 models items, DS-24):
//   node tests/test_v08_pages_models.mjs
// Skips when chrome, playwright-core or the running office is missing. All writes are mocked or aborted.
import { launchOrSkip, guardedPage, json, check, finish, shot, SIZES, BASE } from './test_v08_pages_lib.mjs';

const FIXTURE = () => ({
  openclaw: {
    ok: true, defaultModel: 'prov/a',
    models: [{ id: 'prov/a', provider: 'prov', name: 'A', available: true }],
    providers: ['prov'],
    authProfiles: [{ id: '"><img src=x onerror=window.__xss=1>', provider: 'p', type: 'api' }],
    managedAuth: { sourceAgent: 'main', managedStaticProfiles: [], agentRows: [{ agent: "x');window.__xss=2;('", staticInSync: false }] },
    cloudProviders: [{ provider: '"><svg onload=window.__xss=3>', authProfiles: [], models: [] }],
    localProviders: [{ provider: "lm'studio", baseUrl: 'http://lan-host:1234/v1', api: 'openai-completions', apiKeyConfigured: true,
      models: [{ id: 'qwen-7b', name: 'Qwen 7B Friendly' }, { id: 'llama', name: 'Llama' }] }],
    agents: { a: { id: 'ag"ent<1>', model: 'prov/a' }, b: { id: 'main', model: 'other/unknown' } },
  },
  hermes: { profiles: [{ id: 'h', name: '<b>H</b>', available: true, model: 'm' }] },
  codex: { enabled: true, sandbox: 'workspace-write', approvalPolicy: 'weird-mode', homePath: '/x', binary: '', model: '' },
  claudeCode: { enabled: true, permissionMode: 'dontAsk', model: '', homePath: '/c' },
});

const results = [];
const browser = await launchOrSkip('models');
if (browser) {
  try {
    // 1. Real server, read only: every tab renders, nothing stuck on Loading.
    for (const size of SIZES) {
      for (const theme of ['dark', 'light']) {
        const { page, context, blocked, errors } = await guardedPage(browser, { viewport: size.viewport, theme });
        await page.goto(BASE + '/models.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#openclaw-models .card, #openclaw-models .vo-state-card.is-error', { timeout: 20000 });
        const tag = `${size.tag}-${theme}`;
        await shot(page, `models-openclaw-${tag}.png`);
        if (size.tag === 'd' && theme === 'dark') {
          for (const id of ['openclaw-models', 'hermes-models', 'codex-models', 'claude-code-models', 'native-setup']) {
            const text = await page.textContent('#' + id);
            check(results, text.trim().length > 0 && !/^\s*Loading/.test(text) && !/Unexpected end of JSON/.test(text), `real server: ${id} rendered`);
          }
          check(results, (await page.locator('[onclick], [onchange]').count()) === 0, 'no inline handlers');
          check(results, blocked.length === 0, 'real server: no writes ' + blocked.join(','));
          check(results, errors.filter((e) => !/vo-auth\.js|404/.test(e)).length === 0, 'real server: no page errors ' + errors.join(' | '));
          await page.goto(BASE + '/models.html#claude-code', { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('#panel-claude-code.active');
          check(results, await page.getAttribute('#tab-claude-code', 'aria-selected') === 'true', '#claude-code deep link opens that tab');
          await page.focus('#tab-claude-code');
          await page.keyboard.press('ArrowRight');
          check(results, await page.getAttribute('#tab-setup', 'aria-selected') === 'true', 'arrow keys move between tabs');
        }
        await page.click('#tab-codex');
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        await shot(page, `models-codex-${tag}.png`);
        await context.close();
      }
    }

    // 2. Server error (JSON 500), then empty 200 body, then success with hostile data.
    {
      let mode = 'error';
      const calls = [];
      const native = { path: '/api/native-models', handle: (r) => {
        if (mode === 'error') return json(r, { ok: false, error: "AttributeError: 'str' object has no attribute 'get'" }, 500);
        if (mode === 'empty') return r.fulfill({ status: 200, contentType: 'application/json', body: '' });
        return json(r, FIXTURE());
      } };
      let release;
      const slowSave = { method: 'POST', path: '/api/native-models/openclaw/provider', handle: async (r, req, url, body) => {
        calls.push(body); await new Promise((res) => { release = res; setTimeout(res, 600); }); return json(r, { ok: true, provider: body.provider });
      } };
      const setupSave = { method: 'POST', path: '/setup/save', handle: (r, req, url, body) => { calls.push({ setup: body }); return json(r, { ok: true }); } };
      const codexTest = { method: 'POST', path: '/api/codex/test', handle: (r, req, url, body) => { calls.push({ codexTest: body }); return json(r, { ok: false, error: 'codex not found' }, 200); } };  // (a failed test answers 200, 0.12.0)
      const { page, context, blocked } = await guardedPage(browser, { mocks: [native, slowSave, setupSave, codexTest] });
      await page.goto(BASE + '/models.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#openclaw-models .vo-state-card.is-error', { timeout: 10000 });
      await shot(page, 'models-error-d-dark.png');
      const errText = await page.textContent('#openclaw-models');
      check(results, /could not read the model settings \(error 500\)/i.test(errText), 'HTTP 500 shows a readable message');
      check(results, /could not read the model settings/i.test(await page.textContent('#hermes-models')), 'other tabs show the error too (no endless Loading)');
      mode = 'empty';
      await page.click('#openclaw-models [data-action="reload"]');
      await page.waitForFunction(() => /empty answer/.test(document.getElementById('openclaw-models').textContent));
      check(results, true, 'empty 200 body shows a readable message');
      mode = 'ok';
      await page.click('#openclaw-models [data-action="reload"]');
      await page.waitForSelector('#openclaw-models .card');
      check(results, await page.evaluate(() => window.__xss === undefined), 'hostile names do not run script');
      check(results, (await page.locator('#openclaw-models img[src="x"], #openclaw-models svg').count()) === 0, 'no injected elements');
      const agentLabel = await page.textContent('#openclaw-models');
      check(results, agentLabel.includes('ag"ent<1>'), 'agent id shown as text');
      check(results, await page.$eval('#oc-agent-1', (s) => s.value) === 'other/unknown', 'unknown current agent model kept selected');

      // Double click on Save: one request; names preserved.
      const saveBtn = page.locator('[data-action="save-local-provider"][data-index="0"]');
      await saveBtn.click();
      await saveBtn.click({ force: true }).catch(() => {});
      await page.waitForFunction(() => /Saved/.test(document.getElementById('oc-local-provider-status-0')?.textContent || ''), null, { timeout: 5000 });
      const provCalls = calls.filter((c) => c && c.provider);
      check(results, provCalls.length === 1, 'double click sends one save (' + provCalls.length + ')');
      const models = provCalls[0] && provCalls[0].models;
      check(results, Array.isArray(models) && models[0].name === 'Qwen 7B Friendly' && models[1].name === 'Llama', 'display names kept on save: ' + JSON.stringify(models));

      // Codex: Test sends the form only, no save; unknown approval value stays.
      await page.click('#tab-codex');
      check(results, await page.$eval('#setup-codex-approval', (s) => s.value) === 'weird-mode', 'unknown Codex approval value kept as (current)');
      await page.click('[data-action="test-codex"]');
      await page.waitForFunction(() => /codex not found/.test(document.getElementById('setup-codex-status').textContent));
      check(results, !calls.some((c) => c.setup) && calls.some((c) => c.codexTest), 'Test does not save first');
      await page.click('[data-action="save-codex"]');
      await page.waitForFunction(() => /Nothing changed/.test(document.getElementById('setup-codex-status').textContent));
      check(results, !calls.some((c) => c.setup), 'Save with no edits sends nothing');

      // Claude: dontAsk kept, only the changed field is sent.
      await page.click('#tab-claude-code');
      check(results, await page.$eval('#setup-claude-permission', (s) => s.value) === 'dontAsk', 'unknown Claude permission mode kept');
      await page.fill('#setup-claude-model', 'sonnet');
      await page.click('[data-action="save-claude"]');
      await page.waitForFunction(() => /saved/i.test(document.getElementById('setup-claude-status').textContent));
      const setupCall = calls.find((c) => c.setup);
      check(results, setupCall && JSON.stringify(setupCall.setup) === JSON.stringify({ claudeCode: { model: 'sonnet' } }), 'Claude save sends only the changed field: ' + JSON.stringify(setupCall && setupCall.setup));
      check(results, blocked.length === 0, 'no unmocked writes ' + blocked.join(','));
      await context.close();
    }
  } finally {
    await browser.close();
  }
  finish('models', results);
}
