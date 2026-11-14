// Dashboard widgets (CH-40, DL-09 client, CH-07 api-usage part): PC Performance and API Usage.
//   node tests/test_v08_pages_widgets.mjs
// Loads the real office page with writes blocked; widget data endpoints are mocked where noted.
import { launchOrSkip, guardedPage, json, check, finish, shot, BASE } from './test_v08_pages_lib.mjs';

function counter(page) {
  const counts = { pc: 0, api: 0 };
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (path === '/pc-metrics') counts.pc += 1;
    if (path === '/api-usage') counts.api += 1;
  });
  return counts;
}

// Real /vo-config with the PC monitor fields of the case under test (pcMetrics undefined = older server).
async function withConfig(route, featureOn, pcMetrics) {
  const res = await route.fetch(); const cfg = await res.json();
  cfg.features = Object.assign({}, cfg.features, { pcMetrics: featureOn });
  if (pcMetrics === undefined) delete cfg.pcMetrics; else cfg.pcMetrics = pcMetrics;
  return json(route, cfg);
}

async function openSystemCard(page) {
  const head = page.locator('.vo-card[data-vo-card="system"] .vo-card-head');
  if (await head.count()) {
    // The dashboard is a bottom sheet on phones: pull it up (peek -> half -> full) so the card is on screen,
    // then click through the DOM like a keyboard user would.
    await page.evaluate(() => {
      const grab = document.querySelector('[data-vo-sheet-grab]');
      for (let i = 0; i < 2 && grab && !document.body.classList.contains('vo-sheet-full') && document.body.className.includes('vo-sheet-'); i++) grab.click();
    });
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.evaluate((el) => el.click());
    return true;
  }
  await page.evaluate(() => { window.VOApiUsage && window.VOApiUsage.setOpen(true); window.VOPcMonitor && window.VOPcMonitor.setOpen(true); });
  return false;
}

async function closeSystemCard(page) {
  const head = page.locator('.vo-card[data-vo-card="system"] .vo-card-head');
  if (await head.count()) { if ((await head.getAttribute('aria-expanded')) === 'true') await head.evaluate((el) => el.click()); return; }
  await page.evaluate(() => { window.VOApiUsage && window.VOApiUsage.setOpen(false); window.VOPcMonitor && window.VOPcMonitor.setOpen(false); });
}

const HOSTILE_USAGE = { ageSeconds: 30, providers: [
  { provider: 'anthropic', displayName: '<img src=x onerror=window.__xss=1>', plan: '"><svg onload=window.__xss=2>', usage: { dailyPctLeft: 140, dailyTimeLeft: '<b>2h</b>', weeklyPctLeft: -20, fooPctLeft: 50 } },
  { provider: 'evil', displayName: 'Evil', error: '<img src=x onerror=window.__xss=3>', message: 'API key configured. This provider has a long message that must wrap instead of being cut in the middle.' },
] };

const results = [];
const browser = await launchOrSkip('widgets');
if (browser) {
  try {
    // 1. Real config (8095: pcMetrics off). Nothing polls while the card is closed; API usage polls once when opened.
    {
      const { page, context, blocked } = await guardedPage(browser, { mocks: [{ path: '/api-usage', handle: (r) => json(r, HOSTILE_USAGE) }] });
      await page.addInitScript(() => { try { localStorage.removeItem('vo-dashboard-cards'); } catch (_) {} });
      const counts = counter(page);
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.VOApiUsage && window.VOPcMonitor && window.VOPcMonitor.state().enabled !== null, null, { timeout: 20000 });
      await page.waitForTimeout(3000);
      check(results, counts.api === 0 && counts.pc === 0, `closed card: no polling (api ${counts.api}, pc ${counts.pc})`);
      check(results, await page.evaluate(() => !window.VOApiUsage.isOpen() && !window.VOPcMonitor.isOpen()), 'widgets start closed');
      const usedCard = await openSystemCard(page);
      await page.waitForFunction(() => document.querySelectorAll('#api-usage-cards .api-provider').length > 0, null, { timeout: 8000 });
      await page.waitForTimeout(2500);
      check(results, counts.api === 1, 'open: API usage asked once (' + counts.api + ')');
      check(results, counts.pc === 0, 'PC metrics off: never polled (' + counts.pc + ')');
      check(results, await page.evaluate(() => window.__xss === undefined), 'hostile provider data does not run script');
      check(results, (await page.locator('#api-usage-cards img, #api-usage-cards svg').count()) === 0, 'no injected elements in API usage');
      const widths = await page.$$eval('#api-usage-cards .pc-bar', (bars) => bars.map((b) => parseFloat(b.style.width)));
      check(results, widths.length >= 3 && widths.every((w) => w >= 0 && w <= 100), 'quota bars clamped to 0-100: ' + widths.join(','));
      if (usedCard) {
        const pcNote = page.locator('[data-vo-pc-off]');
        check(results, (await pcNote.count()) === 0 || await pcNote.isVisible(), 'PC "not connected" note shown when the feature is off');
      }
      await page.locator('.vo-card[data-vo-card="system"]').scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, 'widgets-system-d-dark.png');
      await closeSystemCard(page);
      const before = counts.api;
      await page.waitForTimeout(1500);
      check(results, counts.api === before && await page.evaluate(() => !window.VOApiUsage.state().polling), 'closing stops polling');
      check(results, blocked.length === 0 || blocked.every((b) => !/pc-metrics|api-usage/.test(b)), 'no widget writes');
      await context.close();
    }

    // 2a. Current server, no address: /vo-config says features.pcMetrics false and pcMetrics.urlConfigured
    //     false (aefb15a). The widget never asks /pc-metrics, shows the "set up" note, and the System card
    //     still opens it through VOPcMonitor.setOpen (3ec3fc0).
    {
      const mocks = [
        { path: '/vo-config', handle: (route) => withConfig(route, false, { urlConfigured: false }) },
        { path: '/pc-metrics', handle: (r) => json(r, { ok: false, error: 'PC metrics not configured', configured: false }, 404) },
        { path: '/api-usage', handle: (r) => json(r, { providers: [] }) },
      ];
      const { page, context } = await guardedPage(browser, { mocks });
      await page.addInitScript(() => { try { localStorage.removeItem('vo-dashboard-cards'); } catch (_) {} });
      const counts = counter(page);
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.VOPcMonitor && window.VOPcMonitor.state().enabled !== null, null, { timeout: 20000 });
      await openSystemCard(page);
      await page.waitForTimeout(3000);
      const st = await page.evaluate(() => window.VOPcMonitor.state());
      check(results, counts.pc === 0 && st.open && st.notConfigured && !st.polling, `no address: open, never asked, not polling (pc ${counts.pc}, ${JSON.stringify(st)})`);
      const note = page.locator('[data-vo-pc-off]');
      if (await note.count()) check(results, await note.isVisible(), '"set up" note visible');
      check(results, /Connect OpenClaw|No API providers/.test(await page.textContent('#api-usage-cards')), 'API usage empty state explains what to do');
      await shot(page, 'widgets-pc-notset-d-dark.png');
      await context.close();
    }

    // 2b. Older server (no pcMetrics summary, feature flag on, no address): asked once, then stopped (DL-09).
    {
      const mocks = [
        { path: '/vo-config', handle: (route) => withConfig(route, true, undefined) },
        { path: '/pc-metrics', handle: (r) => json(r, { ok: false, error: 'PC metrics not configured', configured: false }, 404) },
        { path: '/api-usage', handle: (r) => json(r, { providers: [] }) },
      ];
      const { page, context } = await guardedPage(browser, { mocks });
      await page.addInitScript(() => { try { localStorage.removeItem('vo-dashboard-cards'); } catch (_) {} });
      const counts = counter(page);
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.VOPcMonitor && window.VOPcMonitor.state().enabled === true, null, { timeout: 20000 });
      await openSystemCard(page);
      await page.waitForTimeout(5000);
      const st = await page.evaluate(() => window.VOPcMonitor.state());
      check(results, counts.pc === 1 && st.notConfigured && !st.polling, `older server, no address: asked once then stopped (pc ${counts.pc}, ${JSON.stringify(st)})`);
      await context.close();
    }

    // 3. Working PC metrics: polls about every 2 s while open, stops when the tab is hidden.
    {
      const sample = { cpu: { percent: 37.5, threads: 16, freqMHz: 3600 }, memory: { percent: 81, usedGB: 26, totalGB: 32 },
        gpus: [{ name: '<b>GPU</b>', utilization: 95, memoryUsedMB: 4096, memoryTotalMB: 0, tempC: 0, powerW: 120, powerLimitW: 300 }] };
      const mocks = [
        { path: '/vo-config', handle: (route) => withConfig(route, true, { urlConfigured: true }) },
        { path: '/pc-metrics', handle: (r) => json(r, sample) },
        { path: '/api-usage', handle: (r) => json(r, { providers: [] }) },
      ];
      const { page, context } = await guardedPage(browser, { viewport: { width: 412, height: 915 }, theme: 'light', mocks });
      await page.addInitScript(() => { try { localStorage.removeItem('vo-dashboard-cards'); } catch (_) {} });
      const counts = counter(page);
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.VOPcMonitor && window.VOPcMonitor.state().enabled === true, null, { timeout: 20000 });
      await openSystemCard(page);
      check(results, await page.evaluate(() => window.VOPcMonitor.isOpen()), 'System card opens the PC widget');
      await page.waitForTimeout(5200);
      check(results, counts.pc >= 2 && counts.pc <= 4, 'open: about one poll per 2 s (' + counts.pc + ' in ~5 s)');
      await page.waitForSelector('#pc-gpu0-detail', { state: 'attached', timeout: 3000 }).catch(() => {});
      const gpuDetail = await page.textContent('#pc-gpu0-detail', { timeout: 3000 }).catch(() => '');
      check(results, gpuDetail.includes('<b>GPU</b>') && !gpuDetail.includes('NaN'), 'GPU name as text, no NaN with zero total memory');
      check(results, /0°C/.test(await page.textContent('#pc-gpu0-detail2', { timeout: 3000 }).catch(() => '')), '0 °C shown as 0, not "?"');
      check(results, await page.evaluate(() => !!document.getElementById('pc-gpu0-bar')?.classList.contains('is-danger')), 'high load bar uses the danger class');
      check(results, await page.locator('#pc-monitor-body').isVisible(), 'live PC readings visible in the System card');
      await page.locator('#pc-monitor').scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, 'widgets-pc-live-m-light.png');
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      const hiddenStart = counts.pc;
      await page.waitForTimeout(4500);
      check(results, counts.pc <= hiddenStart + 1, 'hidden tab: polling paused (' + (counts.pc - hiddenStart) + ' extra)');
      await context.close();
    }
  } finally {
    await browser.close();
  }
  finish('widgets', results);
}
