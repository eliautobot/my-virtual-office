// Setup wizard (CH-07 setup part, CH-12, CH-36 setup part, C1 passcode step, DS-14):
//   node tests/test_v08_pages_setup.mjs
// Skips when chrome, playwright-core or the running office is missing.
// Every write is mocked or aborted: the passcode request is intercepted, never sent to 8095.
import { launchOrSkip, guardedPage, json, check, finish, shot, SIZES, BASE } from './test_v08_pages_lib.mjs';

const CONFIG = () => ({
  office: { name: 'Test HQ' },
  features: { pcMetrics: true, smsPanel: true, browserPanel: false, apiUsage: true },
  weather: { location: 'Austin,TX' },
  openclaw: { homePath: '/openclaw', gatewayUrl: 'ws://127.0.0.1:18789' },
  browser: { cdpUrl: null, viewerUrl: null },
  hermes: { enabled: true, connections: [
    { id: 'astra', name: '<img src=x onerror=window.__xss=1>', apiUrl: 'http://127.0.0.1:8642', apiKeyConfigured: true, enabled: true },
    { id: 'coby', name: 'Coby', apiUrl: 'http://127.0.0.1:8954', apiKeyConfigured: true, enabled: false },
  ], platformEnabled: false, platformTokenConfigured: true, platformAgentId: 'hermes-gateway' },
  codex: { enabled: true, homePath: '/c', binary: '/bin/codex', model: '', sandbox: 'workspace-write', approvalPolicy: 'on-request', preferAppServer: true },
  claudeCode: { enabled: true, homePath: '/cc', permissionMode: 'dontAsk', includeMain: true, includeNativeAgents: true, registerNativeAgents: true },
  license: { demo: true },
});
const AGENTS = { agents: [
  { id: 'adler', statusKey: 'adler', name: '"><svg onload=window.__xss=2>', emoji: '🧍', providerKind: 'openclaw' },
  { id: 'codex-main', statusKey: 'codex-main', name: 'Main', providerKind: 'codex' },
] };

const results = [];
const browser = await launchOrSkip('setup');
if (browser) {
  try {
    // 1. Real server, read only: walk every step, pre-fill happens, Launch with no edits writes nothing.
    for (const size of SIZES) {
      for (const theme of ['dark', 'light']) {
        const { page, context, blocked, errors } = await guardedPage(browser, { viewport: size.viewport, theme });
        await page.goto(BASE + '/setup', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.VOSetup && !window.VOSetup.prefill.loading, null, { timeout: 15000 });
        const tag = `${size.tag}-${theme}`;
        await shot(page, `setup-step0-${tag}.png`);
        if (size.tag === 'd' && theme === 'dark') {
          check(results, await page.evaluate(() => window.VOSetup.prefill.ok), 'real server: current settings pre-filled');
          check(results, (await page.inputValue('#s-name')).length > 0, 'office name pre-filled');
          for (let n = 1; n <= 7; n++) {
            await page.click(`#step-${n - 1} [data-step="${n}"]`);
            await page.waitForSelector(`#step-${n}.active`);
          }
          await page.waitForFunction(() => !document.getElementById('access-loading') || document.getElementById('access-loading').hidden, null, { timeout: 8000 });
          const summary = await page.textContent('#change-summary');
          check(results, /Nothing changed|No settings changed/.test(summary), 'no edits: summary says nothing changes (' + summary.trim().slice(0, 50) + ')');
          await page.click('#finish-btn');
          await page.waitForTimeout(400);
          check(results, blocked.length === 0, 'real server: Launch with no edits sends no save ' + blocked.join(','));
          check(results, errors.filter((e) => !/404/.test(e)).length === 0, 'real server: no page errors ' + errors.join(' | '));
        } else {
          await page.click('#step-0 [data-step="1"]');
          await page.click('#step-1 [data-step="2"]');
          await page.waitForTimeout(500);
          await shot(page, `setup-step2-${tag}.png`);
          await page.evaluate(() => window.VOSetup.showStep(6));
          await page.waitForTimeout(400);
          await shot(page, `setup-passcode-${tag}.png`);
        }
        await context.close();
      }
    }

    // 2. Mocked config: hostile names stay text, only touched fields are saved, tests never save, passcode intercepted.
    {
      const saves = []; const passcodes = []; const cliTests = [];
      const mocks = [
        { path: '/vo-config', handle: (r) => json(r, CONFIG()) },
        { path: '/sms-status', handle: (r) => json(r, { enabled: true, ownerAgentId: 'adler', hasCredentials: true }) },
        { path: '/api/agents', handle: (r) => json(r, AGENTS) },
        { path: '/api/license', handle: (r) => json(r, { licensed: false, demo: true }) },
        { path: '/api/access/status', handle: (r) => json(r, { protected: false, authenticated: true, viaLoopback: true, canManage: true }) },
        { method: 'POST', path: '/api/access/passcode', handle: (r, req, url, body) => { passcodes.push(body); return json(r, { ok: true, protected: true }); } },
        { method: 'POST', path: '/setup/save', handle: (r, req, url, body) => { saves.push(body); return json(r, { ok: true }); } },
        { method: 'POST', path: '/api/codex/test', handle: (r, req, url, body) => { cliTests.push(body); return json(r, { ok: true, protocol: 'app-server', agents: [{ name: '<b>x</b>' }] }); } },
        { method: 'POST', path: '/api/browser/test', handle: (r) => json(r, { ok: false, error: 'not_found' }, 404) },
        { method: 'POST', path: '/api/license/activate', handle: (r) => json(r, { ok: true, tierName: '<img src=x onerror=window.__xss=3>' }) },
      ];
      const { page, context, blocked } = await guardedPage(browser, { mocks });
      await page.route('**/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>office</p>' }));
      await page.goto(BASE + '/setup', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.VOSetup && window.VOSetup.prefill.ok);
      check(results, !(await page.isHidden('#rerun-banner')), 're-run banner shown for a configured office');
      check(results, await page.inputValue('#s-weather-city') === 'Austin' && await page.inputValue('#s-weather-state') === 'TX', 'weather pre-filled');
      check(results, await page.$eval('#s-claude-permission', (s) => s.value) === 'dontAsk', 'unknown Claude permission kept as (current)');
      check(results, await page.$eval('#s-sms-agent', (s) => s.value) === 'adler', 'SMS owner pre-filled');
      await page.fill('#s-license-key', 'KEY');
      await page.click('[data-action="activate-license"]');
      await page.waitForSelector('#license-status .status-box.success');
      check(results, (await page.textContent('#license-status')).includes('<img'), 'license tier shown as text');

      await page.evaluate(() => window.VOSetup.showStep(2));
      await page.fill('#s-codex-model', 'gpt-x');
      await page.click('[data-action="test-codex"]');
      await page.waitForSelector('#codex-test-status .status-box.success');
      check(results, cliTests.length === 1 && saves.length === 0 && cliTests[0].model === 'gpt-x', 'Codex Test sends the form and saves nothing');
      // Rename a Hermes connection; the disabled one stays disabled.
      await page.locator('.hermes-connection').first().locator('.hermes-connection-id').fill('astra-2');
      await page.evaluate(() => window.VOSetup.showStep(3));
      await page.check('#s-browser-enable');
      await page.fill('#s-cdp-url', 'http://cdp:9222');
      await page.fill('#s-viewer-url', 'http://cdp:6902');
      await page.click('[data-action="test-browser"]');
      await page.waitForSelector('#browser-test-status .status-box.warn');
      check(results, saves.length === 0, 'Browser Test on an older server explains instead of saving');
      await page.evaluate(() => window.VOSetup.showStep(4));
      await page.fill('#s-twilio-token', 'tok-123');
      await page.evaluate(() => window.VOSetup.showStep(6));
      await page.waitForSelector('#access-form:not([hidden])');
      await page.fill('#s-passcode', 'abcd');
      await page.fill('#s-passcode-2', 'abce');
      await page.click('[data-action="set-passcode"]');
      check(results, /do not match/.test(await page.textContent('#access-status')) && passcodes.length === 0, 'mismatched passcodes are caught locally');
      await page.fill('#s-passcode-2', 'abcd');
      await page.click('[data-action="set-passcode"]');
      await page.waitForSelector('#access-on:not([hidden])');
      check(results, passcodes.length === 1 && passcodes[0].next === 'abcd' && passcodes[0].current === '', 'passcode step posts C1 {current, next} (intercepted)');
      await page.evaluate(() => window.VOSetup.showStep(7));
      await shot(page, 'setup-summary-d-dark.png');
      const summary = await page.textContent('#change-summary');
      check(results, /Codex/.test(summary) && /Hermes/.test(summary) && /SMS/.test(summary) && /Agent browser/.test(summary) && !/Office name/.test(summary), 'summary lists only changed steps');
      await page.click('#finish-btn');
      await page.waitForFunction(() => /Saved/.test(document.getElementById('save-status').textContent), null, { timeout: 5000 }).catch(() => {});
      const p = saves[0] || {};
      check(results, JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['browser', 'codex', 'features', 'hermes', 'sms']), 'only touched sections sent: ' + Object.keys(p).join(','));
      check(results, p.codex && JSON.stringify(p.codex) === JSON.stringify({ model: 'gpt-x' }), 'Codex: only the changed field ' + JSON.stringify(p.codex));
      check(results, p.sms && JSON.stringify(p.sms) === JSON.stringify({ twilioAuthToken: 'tok-123' }), 'SMS: typed secret only, nothing blank, no "undefined" ' + JSON.stringify(p.sms));
      const conns = p.hermes && p.hermes.connections;
      check(results, conns && conns.length === 2 && conns[0].id === 'astra-2' && conns[0].originalId === 'astra' && conns[1].enabled === false && !('apiKey' in conns[0]), 'Hermes rows keep enabled state, carry originalId, no blank keys ' + JSON.stringify(conns));
      check(results, p.features && JSON.stringify(p.features) === JSON.stringify({ browserPanel: true }), 'features: only the toggled flag (no forced apiUsage, no pcMetrics reset) ' + JSON.stringify(p.features));
      check(results, !('weather' in p) && !('office' in p) && !('claudeCode' in p) && !('pcMetrics' in p), 'untouched steps not sent');
      check(results, await page.evaluate(() => window.__xss === undefined), 'no injected script ran');
      check(results, blocked.length === 0, 'no unmocked writes ' + blocked.join(','));
      await context.close();
    }

    // 3. Config cannot be read: saving is blocked, nothing is written.
    {
      const saves = [];
      const mocks = [
        { path: '/vo-config', handle: (r) => json(r, { ok: false, error: 'boom' }, 500) },
        { method: 'POST', path: '/setup/save', handle: (r, req, url, body) => { saves.push(body); return json(r, { ok: true }); } },
      ];
      const { page, context } = await guardedPage(browser, { mocks });
      await page.goto(BASE + '/setup', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#prefill-error:not([hidden])');
      await shot(page, 'setup-prefill-error-d-dark.png');
      await page.evaluate(() => window.VOSetup.showStep(7));
      await page.click('#finish-btn');
      check(results, saves.length === 0 && /not loaded/.test(await page.textContent('#save-status')), 'failed pre-fill blocks the save');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  finish('setup', results);
}
