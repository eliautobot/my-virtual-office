// Read-only smoke of a RUNNING office (life-qa2): LIVE_URL=http://127.0.0.1:8096 node tests/e2e/life_live_smoke.mjs
// Self-contained on purpose (life_lib.mjs refuses real offices). GET-only guard: every non-GET/HEAD request the page
// makes is answered locally with 403 and never reaches the office (counted, listed). Checks: /api/office-life/state
// ok, the office page at 1600x900 and 412x915 loads Office life (ready + live) with 0 page/console errors.
// No injector, no saves, no chat.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || require('node:path').join(require('node:os').homedir(), '.hermes/hermes-agent/node_modules/playwright-core'));

const VO = (process.env.LIVE_URL || '').replace(/\/$/, '');
if (!VO) { console.error('usage: LIVE_URL=http://host:port node tests/e2e/life_live_smoke.mjs'); process.exit(2); }
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + String(detail).slice(0, 200) : ''}`); };

const state = await fetch(VO + '/api/office-life/state').then(r => r.json()).catch(e => ({ error: String(e) }));
check('live: /api/office-life/state ok', state && state.ok === true,
  JSON.stringify({ ok: state.ok, enabled: state.enabled, tz: state.tz, seq: state.seq, error: state.error }));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const [W, H] of [[1600, 900], [412, 915]]) {
    const phone = W < 700, tag = `live ${W}x${H}`;
    const context = await browser.newContext({ viewport: { width: W, height: H }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2.625 : 1 });
    const page = await context.newPage(), errors = [], blocked = [];
    page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 160)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|favicon/i.test(m.text())) errors.push(m.text().slice(0, 160)); });
    await context.route('**/*', route => {
      const m = route.request().method();
      if (m === 'GET' || m === 'HEAD') return route.continue();
      blocked.push(`${m} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"ok":false,"error":"read-only smoke"}' });
    });
    await page.goto(VO + '/', { waitUntil: 'domcontentloaded' });
    const ready = await page.waitForFunction(() => window.VOLife && window.VOLife._debug && window.VOLife._debug().status === 'ready'
      && window.VOLife._debug().live && window.agents && window.agents.length > 0, null, { timeout: 30000 }).then(() => true, () => false);
    await page.waitForTimeout(4000);
    const info = await page.evaluate(() => ({ agents: (window.agents || []).length, status: window.VOLife && window.VOLife._debug().status }));
    check(`${tag}: page loads, Office life ready + live`, ready, JSON.stringify(info));
    check(`${tag}: 0 page/console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    console.log(`${tag}: GET-only guard held back ${blocked.length} write request(s) ${JSON.stringify([...new Set(blocked)]).slice(0, 160)}`);
    await context.close();
  }
} finally { await browser.close(); }
console.log(`life_live_smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
