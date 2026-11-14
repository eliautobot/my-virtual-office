// v0.10.1 N1: the office says when it lost its server and when it is back.
//
// Hermetic page (context.route serves app/ and fixtures). The "server" is stopped by aborting
// every request (connection refused) and started again by answering them.
//   1. one failed request while the server answers: no banner (a check of /status clears it)
//   2. server stops: one banner "Lost connection to the office. Retrying..." (role alert),
//      html.vo-offline, the dashboard count dims and says when it was last seen
//   3. server starts: the banner goes, a "Back online" toast, 'vo:online', /status read again
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);

function skip(reason) { console.log(`SKIP test_v101_connection: ${reason}`); process.exit(0); }
function loadPlaywright() {
    for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
        try { return require(c); } catch { /* next */ }
    }
    return null;
}
function findChrome() {
    return [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
        '/usr/bin/chromium-browser'].filter(Boolean).find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}
const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = findChrome();
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const ORIGIN = 'http://office.test';
const FIXTURES = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.10.1', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: [
        { id: 'alpha', statusKey: 'alpha', name: 'Alpha', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true },
        { id: 'beta', statusKey: 'beta', name: 'Beta', emoji: '🦊', role: 'Tester', providerKind: 'hermes', available: true },
    ] },
    '/status': { alpha: { state: 'idle', task: '' }, beta: { state: 'working', task: 'Running tests' } },
    '/agent-chat': {},
    '/weather-proxy': { current_condition: [], configured: false },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };

const world = { down: false, statusReads: 0 };
async function route(routeObj) {
    const request = routeObj.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return routeObj.abort();
    if (world.down || url.pathname === '/api/flaky') return routeObj.abort('connectionrefused');
    if (url.pathname === '/status') world.statusReads++;
    if (request.method() !== 'GET' && request.method() !== 'HEAD') {
        return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (Object.prototype.hasOwnProperty.call(FIXTURES, url.pathname)) {
        return routeObj.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURES[url.pathname]) });
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const file = path.resolve(APP, rel);
    const ext = path.extname(file);
    if (file.startsWith(APP + path.sep) && TYPES[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return routeObj.fulfill({ status: 200, contentType: TYPES[ext], body: fs.readFileSync(file) });
    }
    return routeObj.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
}

const results = [];
function pass(name) { results.push(name); console.log(`[PASS] ${name}`); }
const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    await context.route('**/*', route);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.agents && window.agents.length === 2 && window.VOConnection, null, { timeout: 20000 });
    await page.evaluate(() => {
        window.__conn = { online: 0, offline: 0 };
        window.addEventListener('vo:online', () => window.__conn.online++);
        window.addEventListener('vo:offline', () => window.__conn.offline++);
    });
    const view = () => page.evaluate(() => {
        const b = document.getElementById('voConnBanner');
        const count = document.querySelector('[data-vo-online]');
        return {
            state: window.VOConnection.state(),
            banner: !!b && !b.hidden && getComputedStyle(b).display !== 'none',
            text: b ? b.textContent : '',
            role: b ? b.getAttribute('role') : '',
            offlineClass: document.documentElement.classList.contains('vo-offline'),
            countOpacity: count ? Number(getComputedStyle(count).opacity) : null,
            countAfter: count ? getComputedStyle(count, '::after').content : '',
            toasts: Array.from(document.querySelectorAll('.vo-toast-text')).map(t => t.textContent),
            events: window.__conn,
        };
    });

    // 1. A single failed request while the server answers: a quick check clears it, no banner.
    await page.evaluate(() => fetch('/api/flaky').catch(() => {}));
    await page.waitForTimeout(1500);
    let v = await view();
    assert.equal(v.state, 'online', JSON.stringify(v));
    assert.equal(v.banner, false);
    assert.equal(v.events.offline, 0);
    pass('one failed request while the server answers: no banner, no flicker');

    // 2. The server stops.
    world.down = true;
    const downAt = Date.now();
    await page.waitForFunction(() => window.VOConnection.state() === 'offline', null, { timeout: 20000 });
    const tookMs = Date.now() - downAt;
    v = await view();
    assert.equal(v.banner, true);
    assert.match(v.text, /Lost connection to the office\. Retrying\.\.\./);
    assert.equal(v.role, 'alert');
    assert.equal(v.offlineClass, true);
    assert.ok(v.countOpacity !== null && v.countOpacity < 0.6, 'dashboard count dimmed: ' + v.countOpacity);
    assert.match(v.countAfter, /last seen \d\d:\d\d/);
    assert.equal(v.events.offline, 1);
    assert.equal(await page.locator('#voConnBanner').count(), 1, 'one banner');
    pass(`server stopped: one "Lost connection" banner after ${(tookMs / 1000).toFixed(1)} s, counts dimmed with last seen`);

    // 3. The server starts again.
    const readsBefore = world.statusReads;
    world.down = false;
    await page.waitForFunction(() => window.VOConnection.state() === 'online', null, { timeout: 20000 });
    await page.waitForTimeout(300);
    v = await view();
    assert.equal(v.banner, false);
    assert.equal(v.offlineClass, false);
    assert.ok(v.toasts.includes('Back online'), v.toasts.join(' | '));
    assert.equal(v.events.online, 1);
    assert.ok(world.statusReads >= readsBefore + 1, 'status read again on recovery');
    assert.equal(v.countAfter === 'none' || v.countAfter === 'normal' || v.countAfter === '', true, v.countAfter);
    pass('server back: banner gone, "Back online" toast, vo:online, state read again');

    assert.deepEqual(errors, [], errors.join('\n'));
    await context.close();
} finally {
    await browser.close();
}
console.log(`v0.10.1 connection tests passed (${results.length})`);
