// Shared helpers for the v0.8 pages browser tests (cron, models, providers, setup, widgets).
// Every test page runs behind a write guard: any non-GET request that is not explicitly
// mocked is aborted and recorded, so a test can never save to the real OpenClaw/Codex/Hermes homes.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const BASE = process.env.VO_BASE_URL || 'http://127.0.0.1:8095';
export const SHOTS = process.env.VO_SHOTS_DIR || path.join(os.tmpdir(), 'vo-v08-pages-shots');

// playwright-core from PLAYWRIGHT_CORE_PATH, then the normal module lookup (NODE_PATH included).
export function loadPlaywright() {
  for (const candidate of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
    try { return require(candidate); } catch { /* try next */ }
  }
  return null;
}

// Chrome/Chromium from CHROME_PATH, then common install locations.
export function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

export async function launchOrSkip(name) {
  const playwright = loadPlaywright();
  if (!playwright) { console.log(`SKIP ${name}: playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)`); return null; }
  const chromePath = findChrome();
  if (!chromePath) { console.log(`SKIP ${name}: Chrome/Chromium was not found (set CHROME_PATH)`); return null; }
  try {
    const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error('status ' + res.status);
  } catch (e) { console.log(`SKIP ${name}: ${BASE} not reachable (${e.message})`); return null; }
  fs.mkdirSync(SHOTS, { recursive: true });
  return playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
}

export function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

// mocks: [{ method?, path (string or RegExp), handle(route, req, url, body) }]
export async function guardedPage(browser, { viewport = { width: 1600, height: 900 }, theme = 'dark', preset = 'classic', mocks = [], timezoneId } = {}) {
  const context = await browser.newContext({ viewport, timezoneId });
  await context.addInitScript(([t, p]) => {
    try { localStorage.setItem('vo-ui-theme', t); localStorage.setItem('vo-ui-preset', p); } catch (_) {}
  }, [theme, preset]);
  const blocked = [];
  const calls = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    for (const m of mocks) {
      if (m.method && m.method !== method) continue;
      const hit = typeof m.path === 'string' ? url.pathname === m.path : m.path.test(url.pathname + url.search);
      if (!hit) continue;
      let body = null;
      try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (_) { body = req.postData(); }
      calls.push({ method, path: url.pathname, body });
      return m.handle(route, req, url, body);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      blocked.push(`${method} ${url.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
  return { context, page, blocked, calls, errors };
}

export function check(results, ok, label) {
  results.push({ ok: !!ok, label });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

export function finish(name, results) {
  const failed = results.filter((r) => !r.ok);
  console.log(`${name}: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

export function shot(page, file) {
  return page.screenshot({ path: path.join(SHOTS, file) });
}

export const SIZES = [
  { tag: 'd', viewport: { width: 1600, height: 900 } },
  { tag: 'm', viewport: { width: 412, height: 915 } },
];
