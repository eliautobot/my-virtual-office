// Captures the login page backdrop from the office's own renderer (v0.10 UI-15).
// Hermetic: serves app/ from this tree with the shipped default layout and generic agents, so no
// operator data can reach the image. Every non-GET request is aborted.
// Usage: node tests/tools/capture-login-backdrop.mjs <out.png> [--theme dark|light]
// Then grade it: python3 tests/tools/grade-login-backdrop.py <out.png> app/login-backdrop.jpg
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', '..', 'app');
const require = createRequire(import.meta.url);
const out = process.argv[2] || '/tmp/vo-login-backdrop-raw.png';
const theme = process.argv.includes('--theme') ? process.argv[process.argv.indexOf('--theme') + 1] : 'dark';
let playwright = null;
for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) { try { playwright = require(c); break; } catch { /* next */ } }
if (!playwright) { console.error('playwright-core not found (set PLAYWRIGHT_CORE_PATH)'); process.exit(2); }

const office = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
office.agents = [];
const names = [['ada', 'Ada', '🦊'], ['bo', 'Bo', '🐙'], ['cy', 'Cy', '🤖'], ['dee', 'Dee', '🦉'], ['eve', 'Eve', '🐝'], ['fin', 'Fin', '🐳']];
const desks = (office.furniture || []).filter(f => /desk/i.test(f.type || '') && !/reception|boss/i.test(f.type || '')).slice(0, names.length);
desks.forEach((d, i) => { d.assignedTo = names[i][1]; });
const FIX = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.0', office: { name: 'Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: names.map(([id, name, emoji], i) => ({ id, statusKey: id, name, emoji, role: 'Agent', providerKind: 'openclaw', available: true })) },
    '/status': Object.fromEntries(names.map(([id], i) => [id, i % 3 === 1 ? { state: 'idle', task: '' } : { state: 'working', task: 'Working' }])),
    '/api/office-config': office,
    '/weather-proxy': { current_condition: [], configured: false },
};
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };
const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(c => fs.existsSync(c));
const browser = await playwright.chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await ctx.addInitScript(t => { localStorage.setItem('vo-ui-preset', 'classic'); localStorage.setItem('vo-ui-theme', t); }, theme);
await ctx.route('**/*', route => {
    const req = route.request(); const url = new URL(req.url());
    if (url.origin !== 'http://office.test' || (req.method() !== 'GET' && req.method() !== 'HEAD')) return route.abort();
    if (url.pathname === '/api/office-life/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (FIX[url.pathname]) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX[url.pathname]) });
    const file = path.resolve(APP, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (file.startsWith(APP + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file)) return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)], body: fs.readFileSync(file) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
});
const page = await ctx.newPage();
await page.goto('http://office.test/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.agents && window.agents.length >= 6 && document.body.classList.contains('vo-ready'), null, { timeout: 30000 });
await page.waitForTimeout(2500);
// Hide every piece of chrome: walk up from the canvas and hide all siblings at each level.
const hidden = await page.evaluate(() => {
    const c = document.getElementById('officeCanvas'); let n = 0;
    for (let e = c; e && e !== document.body; e = e.parentElement) {
        for (const s of e.parentElement.children) if (s !== e && s.tagName !== 'SCRIPT' && s.tagName !== 'STYLE') { s.style.setProperty('display', 'none', 'important'); n++; }
    }
    for (const s of document.body.children) if (!s.contains(c) && s.tagName !== 'SCRIPT') { s.style.setProperty('display', 'none', 'important'); n++; }
    document.documentElement.style.background = '#000';
    window.dispatchEvent(new Event('resize'));
    return n;
});
await page.waitForTimeout(800);
await page.evaluate(() => { window.VOOffice?.fitView?.(); window.VOOffice?.resetView?.(); });
await page.waitForTimeout(1500);
const box = await page.locator('#officeCanvas').boundingBox();
await page.locator('#officeCanvas').screenshot({ path: out });
console.log(JSON.stringify({ out, hidden, canvas: [Math.round(box.width), Math.round(box.height)], theme }));
await browser.close();
