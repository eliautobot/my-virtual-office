// Shared fixture page for the moves sheets: serves an app dir on http://office.test with 8 agents.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export async function openPage(appDir, fn) {
  const APP = path.resolve(appDir);
  const pw = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
  const ORIGIN = 'http://office.test';
  const CFG = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
  const ids = ['ann', 'bo', 'cy', 'di', 'ed', 'fen', 'gus', 'hal'];
  const FIX = { '/api/license': { demo: false, valid: true, limits: {} }, '/vo-config': { version: '0.10.0', office: { name: 'S' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: ids.map(i => ({ id: i, statusKey: i, name: i.toUpperCase(), emoji: '🤖', role: 'T', providerKind: 'openclaw', available: true })) },
    '/status': Object.fromEntries(ids.map(i => [i, { state: 'idle', task: '' }])), '/agent-chat': {}, '/api/office-config': CFG, '/weather-proxy': { current_condition: [], configured: false } };
  const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const b = await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const c = await b.newContext({ viewport: { width: 1600, height: 900 } });
    await c.route('**/*', r => { const u = new URL(r.request().url()); if (u.origin !== ORIGIN) return r.abort();
      if (r.request().method() !== 'GET') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      if (FIX[u.pathname]) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX[u.pathname]) });
      const f = path.resolve(APP, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1)));
      if (f.startsWith(APP) && TYPES[path.extname(f)] && fs.existsSync(f) && fs.statSync(f).isFile()) return r.fulfill({ status: 200, contentType: TYPES[path.extname(f)], body: fs.readFileSync(f) });
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(ORIGIN + '/'); await p.waitForFunction(() => window.agents && window.agents.length >= 8 && window.VOOffice, null, { timeout: 20000 });
    await p.waitForTimeout(600);
    await p.evaluate(() => { agents.forEach(a => { a.update = function () {}; }); });
    const r = await fn(p);
    if (errs.length) console.log('pageerrors:', errs.slice(0, 3).join(' | ').slice(0, 300));
    return r;
  } finally { await b.close(); }
}
// Write a data URL to a file.
export function saveDataUrl(url, out) { fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64')); return fs.statSync(out).size; }
