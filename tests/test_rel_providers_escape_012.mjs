// 0.12.0 (deskpick): the Agent Providers window (the provider layer's, ui/agent-providers.js) closes on Escape and
// gives focus back. providers.html opens it over the page by itself (OpenClaw / Hermes rows): nothing had focus, so
// Escape went to the page and only ✕ closed it. Now the window takes focus when it opens, Escape closes it also
// while nothing has focus, and focus returns to what had it (else the page's Open Agent Providers button).
// Hermetic: the layer's modules are served from app/provider-layer/client, every API answer is a fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP, ORIGIN, skip, loadPlaywright, findChrome } from './test_v10_studio_lib.mjs';

const NAME = 'test_rel_providers_escape_012';
const pw = loadPlaywright();
if (!pw) skip(NAME, 'playwright-core not found (set PLAYWRIGHT_CORE_PATH)');
const chrome = findChrome();
if (!chrome) skip(NAME, 'Chrome not found (set CHROME_PATH)');

const CLIENT = path.join(APP, 'provider-layer', 'client');
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/pl/css/agent-providers.css"></head>
<body><main><div id="slot"><button type="button" class="pl-ap-open">Open Agent Providers</button></div>
<button type="button" id="other">Other</button></main><div id="ui"></div>
<script type="module">
  import * as providers from '/pl/js/ui/agent-providers.js';
  import { auth } from '/pl/js/core/auth.js';
  auth.set({ account: { id: 1, name: 'Owner' }, caps: { 'connections.use': true, 'connections.manage': true } });
  providers.init({ toast() {} });
  window.AP = providers;
  window.apReady = true;
</script></body></html>`;
const API = {
  '/api/agent-providers': { providers: [{ id: 1, kind: 'openclaw', name: 'OpenClaw', status: 'connected', agents: [] }], kinds: [] },
  '/api/office/hermes-api': { providers: [] },
};

const browser = await pw.chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const passed = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
    if (url.pathname.startsWith('/pl/')) {
      const file = path.join(CLIENT, url.pathname.slice(4));
      if (!file.startsWith(CLIENT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const type = file.endsWith('.css') ? 'text/css' : 'text/javascript';
      return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(API[url.pathname] || {}) });
  });
  await page.goto(ORIGIN + '/');
  await page.waitForFunction(() => window.apReady === true);
  const open = () => page.evaluate(() => !!document.querySelector('.ap-back'));
  const focused = () => page.evaluate(() => {
    const a = document.activeElement;
    return a === document.body ? 'body' : a.id || a.className || a.tagName;
  });

  // 1. opened by the page itself (providers.html at load): nothing had focus
  await page.evaluate(() => window.AP.open());
  await page.waitForSelector('.ap-back .ap');
  assert.equal(await page.evaluate(() => document.querySelector('.ap-back').contains(document.activeElement)), true,
    'the window takes focus when it opens');
  await page.keyboard.press('Escape');
  assert.equal(await open(), false, 'Escape closes it');
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('pl-ap-open')), true,
    'focus goes to the page\'s Open Agent Providers button');
  passed.push('opened at load: focus moves in, Escape closes, focus on Open Agent Providers');

  // 2. Escape while nothing has focus (a click on the page, then the window opened again by code)
  await page.evaluate(() => window.AP.open());
  await page.waitForSelector('.ap-back .ap');
  await page.evaluate(() => document.activeElement.blur());
  assert.equal(await focused(), 'body');
  await page.keyboard.press('Escape');
  assert.equal(await open(), false, 'Escape closes it while nothing has focus');
  passed.push('Escape with nothing focused closes it');

  // 3. opened from a button: Escape and ✕ return focus to that button
  await page.focus('#other');
  await page.evaluate(() => window.AP.open());
  await page.waitForSelector('.ap-back .ap');
  await page.keyboard.press('Escape');
  assert.equal(await open(), false);
  assert.equal(await focused(), 'other', 'focus returns to the button that had it');
  await page.focus('#other');
  await page.evaluate(() => window.AP.open());
  await page.waitForSelector('.ap-back .ap-x');
  await page.click('.ap-back .ap-x');
  assert.equal(await open(), false, '✕ still closes it');
  assert.equal(await focused(), 'other', '✕ returns focus too');
  passed.push('opened from a button: Escape and ✕ give focus back to it');

  // 4. the page's own Escape handlers are not touched once it is closed
  const pageEsc = await page.evaluate(() => new Promise(res => {
    document.addEventListener('keydown', e => res(e.key), { once: true });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }));
  assert.equal(pageEsc, 'Escape');
  assert.deepEqual(errors, [], 'no page errors');
  passed.push('no page errors; nothing left listening after it closed');
  console.log(`PASS ${NAME}: ${passed.length} checks\n - ` + passed.join('\n - '));
} catch (e) {
  console.log(`FAIL ${NAME}: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
