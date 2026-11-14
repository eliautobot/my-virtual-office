// Shared harness for the PROBE tools and tests (v0.10.1): headless Chrome on the app folder with fixture APIs
// (nothing is written anywhere), an optional seeded Math.random + virtual clock, the probe loaded (?debug=probe).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', require('node:path').join(require('node:os').homedir(), '.hermes/hermes-agent/node_modules/playwright-core')].filter(Boolean)) {
    try { return require(c); } catch { /* next */ }
  }
  return null;
}
export function findChrome() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
const ORIGIN = 'http://office.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };

// Agents for a layout: the assigned desk owners first (by name), then plain ones.
export function rosterFor(config, n) {
  const names = [...new Set((config.furniture || []).filter(f => (f.type === 'desk' || f.type === 'bossDesk') && f.assignedTo).map(f => f.assignedTo))];
  return Array.from({ length: n }, (_, i) => ({ id: 'c' + i, statusKey: 'c' + i, name: names[i] || 'Probe Mate ' + i, emoji: '🤖', role: 'Tester',
    providerKind: 'openclaw', available: true }));
}

// opts: app, config, agents, viewport, mobile, query ('?debug=probe' default), seed (seeded random + virtual clock),
// noSpawn (the test spawns the probe), status
export async function openOffice(browser, opts) {
  const app = path.resolve(opts.app), cfg = JSON.parse(JSON.stringify(opts.config)), list = opts.agents || [];
  const FIX = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.1', office: { name: 'Probe' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: list },
    '/status': opts.status || Object.fromEntries(list.map(a => [a.id, { state: 'idle', task: '' }])),
    '/agent-chat': {}, '/api/office-config': cfg, '/weather-proxy': { current_condition: [], configured: false },
  };
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1600, height: 900 }, deviceScaleFactor: 1,
    isMobile: !!opts.mobile, hasTouch: !!opts.mobile });
  await context.route('**/*', async (r) => {
    const req = r.request(); const url = new URL(req.url());
    if (url.origin !== ORIGIN) return r.abort();
    if (req.method() !== 'GET' && req.method() !== 'HEAD') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    if (Object.prototype.hasOwnProperty.call(FIX, url.pathname))
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() }, body: JSON.stringify(FIX[url.pathname]) });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(app, rel); const ext = path.extname(file);
    if (file.startsWith(app + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile())
      return r.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.addInitScript((o) => {
    if (o.noSpawn) window.__voProbeNoSpawn = true;
    if (o.seed == null) return;
    const R = Date, base = new R(2026, 10, 4, 12, 0, 0).getTime(), t0 = R.now();
    let off = 0;
    const now = () => base + (R.now() - t0) + off;
    window.__vAdvance = (ms) => { off += ms; };
    class VD extends R { constructor(...a) { if (a.length === 0) super(now()); else super(...a); } static now() { return now(); } }
    window.Date = VD;
    let s = o.seed >>> 0;
    Math.random = function() { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }, { seed: opts.seed == null ? null : opts.seed, noSpawn: !!opts.noSpawn });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/' + (opts.query == null ? '?debug=probe' : opts.query), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((k) => window.agents && window.agents.length >= k && window.VOWorld && window.officeConfig && officeConfig.furniture,
    list.length, { timeout: 30000 });
  if ((opts.query == null || /probe/.test(opts.query))) await page.waitForFunction(() => !!window.VOProbe, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  return { page, errors, context };
}
export async function launch(pw, chrome) {
  return pw.chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
}
