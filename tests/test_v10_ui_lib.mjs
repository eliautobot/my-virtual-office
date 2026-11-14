// Shared hermetic harness for the v0.10 UI tests (test_v10_ui_*.mjs). Not a test itself.
// Serves app/ from this tree with fixture JSON; every non-GET request is aborted and recorded,
// so nothing can ever reach a real office, gateway or provider home.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);
export const ORIGIN = 'http://office.test';

export const FIXTURES = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: [
        { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true },
        { id: 'beta', statusKey: 'beta', name: 'Beta', emoji: '🦊', role: 'Tester', providerKind: 'hermes', available: true },
        { id: 'gamma', statusKey: 'gamma', name: 'Gamma', emoji: '🐙', role: 'Tester', providerKind: 'opencode', available: true },
    ] },
    '/status': {
        alpha: { state: 'idle', task: '' },
        beta: { state: 'working', task: 'Running tests', activeToolCount: 1 },
        gamma: { state: 'idle', task: '' },
    },
    '/agent-chat': {},
    '/api/office-config': {
        canvasWidth: 1040, canvasHeight: 740,
        walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' },
            sections: [{ x: 0, w: 1040, color: '#37474f', accentColor: '#263238' }], interior: [] },
        floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
        furniture: [
            { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' },
            { id: 'd2', type: 'desk', x: 320, y: 220, assignedTo: 'Beta' },
            { id: 'd3', type: 'desk', x: 160, y: 380, assignedTo: 'Gamma' },
        ],
        branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
        agents: [],
        pet: { enabled: false },
    },
    '/weather-proxy': { current_condition: [], configured: false },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

export function skip(name, reason) { console.log(`SKIP ${name}: ${reason}`); process.exit(0); }

export async function launch(name) {
    let playwright = null;
    for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
        try { playwright = require(c); break; } catch { /* next */ }
    }
    if (!playwright) skip(name, 'playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
    const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
        '/usr/bin/chromium-browser'].filter(Boolean).find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    if (!chrome) skip(name, 'Chrome/Chromium was not found (set CHROME_PATH)');
    return playwright.chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
}

/** Opens `pagePath` from this tree. fixtures override/extend FIXTURES (value or fn(url) -> value,
 *  `{ __status }` sets the HTTP status). Returns { context, page, errors, blocked }. */
export async function openPage(browser, { pagePath = '/', viewport = { width: 1600, height: 900 }, phone = false, preset = 'classic',
    theme = 'dark', fixtures = {}, waitAgents = pagePath === '/', init = null } = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
    await context.addInitScript(([p, t]) => {
        try { localStorage.setItem('vo-ui-preset', p); localStorage.setItem('vo-ui-theme', t); } catch (_) {}
    }, [preset, theme]);
    if (init) await context.addInitScript(init);
    const all = Object.assign({}, FIXTURES, fixtures);
    const blocked = [];
    await context.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.origin !== ORIGIN) return route.abort();
        if (req.method() !== 'GET' && req.method() !== 'HEAD') { blocked.push(req.method() + ' ' + url.pathname); return route.abort(); }
        if (url.pathname === '/api/office-life/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
        if (Object.prototype.hasOwnProperty.call(all, url.pathname)) {
            const f = all[url.pathname];
            const v = typeof f === 'function' ? f(url) : f;
            return route.fulfill({ status: (v && v.__status) || 200, contentType: 'application/json', body: JSON.stringify(v) });
        }
        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        const file = path.resolve(APP, rel);
        const ext = path.extname(file);
        if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
            return route.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
        }
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(ORIGIN + pagePath, { waitUntil: 'domcontentloaded' });
    if (waitAgents) await page.waitForFunction(() => window.agents && window.agents.length > 0, null, { timeout: 20000 });
    return { context, page, errors, blocked };
}

export function reporter() {
    const passed = [];
    return { pass(name) { passed.push(name); console.log(`[PASS] ${name}`); }, done(name) { console.log(`ALL ${passed.length} ${name} CHECKS PASSED`); } };
}
