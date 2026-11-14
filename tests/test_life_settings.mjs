// Office life Settings (L9): tests/test_life_settings.mjs
//
// Node part: the form's diff (only changed keys are saved) and validation rules
// (mirror of office_life/settings.py) on settings.js in a vm.
// Browser part (playwright-core + Chrome, fixture server through context.route,
// no real office is written): the office time zone adopted once from a browser
// that may save (and not when it may not, when the server already has a zone
// from TZ, or from a UTC browser), the "Office life" Settings category (every
// toggle, stand-up time + day chips, newspaper time, seasons + holidays + custom
// occasions, tournament frequency, zone picker + warning, retention), dirty state,
// the save payload (changed keys only), calm flag propagated to VOLife, errors
// (validation, 400 field errors, 403 cross-site, 401 -> login), the close guard,
// "Run stand-up now" / "Print today's paper now", another tab's change rebased
// under the user's edits, More menu "Daily Office" / "Replay the day" following
// the newspaper switch (desktop + phone), desktop 1600x900 and phone 412x915 in
// dark and light (L9_SHOT_DIR=dir saves 2 JPEG crops), and tournament.js ending
// a decided game through VOLifeHost.stopGame (walkover, next match).
// Skips the browser part cleanly when playwright-core or Chrome is missing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const results = [];
function pass(name) { results.push(name); console.log(`[PASS] ${name}`); }

// ---------------------------------------------------------------------------
// Node part
// ---------------------------------------------------------------------------
{
    const listeners = {};
    const win = {
        addEventListener(n, f) { (listeners[n] = listeners[n] || []).push(f); },
        dispatchEvent() { return true; },
        fetch() { throw new Error('no fetch in the node part'); },
    };
    const doc = { readyState: 'complete', querySelectorAll: () => [], getElementById: () => null, head: { appendChild() {} } };
    const ctx = vm.createContext({ window: win, document: doc, Intl, JSON, Math, Date, Object, Array, String, Number, RegExp, isFinite, CustomEvent: class {} });
    vm.runInContext(fs.readFileSync(path.join(APP, 'office-life', 'settings.js'), 'utf8'), ctx);
    const LS = win.VOLifeSettings;
    assert.ok(LS && LS.mount && LS.dirty && LS.save, 'VOLifeSettings API');
    const base = { enabled: true, calm: false, features: { moods: true, newspaper: true }, standup: { time: '09:30', days: [1, 2, 3, 4, 5] },
        seasons: { holidays: { halloween: true }, custom: [] }, journal: { retentionDays: 14 } };
    assert.equal(LS._diff(base, JSON.parse(JSON.stringify(base))), null, 'no change -> nothing to save');
    const draft = JSON.parse(JSON.stringify(base));
    draft.calm = true; draft.features.moods = false; draft.standup.days = [1, 2, 3, 4, 5, 6];
    draft.seasons.custom = [{ name: 'Launch', date: '06-15', icon: 'flag' }];
    assert.deepEqual(JSON.parse(JSON.stringify(LS._diff(base, draft))), { calm: true, features: { moods: false }, standup: { days: [1, 2, 3, 4, 5, 6] },
        seasons: { custom: [{ name: 'Launch', date: '06-15', icon: 'flag' }] } }, 'only changed keys, arrays whole');
    const ok = { standup: { time: '07:05' }, newspaper: { time: '23:59' }, seasons: { custom: [{ name: 'Leap', date: '02-29' }] }, journal: { retentionDays: 60 }, timeZone: 'Europe/Paris' };
    assert.deepEqual(JSON.parse(JSON.stringify(LS._validate(ok))), {}, 'valid settings');
    const bad = { standup: { time: '24:00' }, newspaper: { time: '9.30' }, seasons: { custom: [{ name: '  ', date: '02-30' }, { name: 'x', date: '13-01' }] },
        journal: { retentionDays: 0 }, timeZone: 'Mars/Olympus' };
    assert.deepEqual(Object.keys(LS._validate(bad)).sort(), ['journal.retentionDays', 'newspaper.time', 'seasons.custom.0.date', 'seasons.custom.0.name',
        'seasons.custom.1.date', 'standup.time', 'timeZone']);
    assert.ok(LS._validate({ standup: { time: '09:30' }, newspaper: { time: '18:00' }, journal: { retentionDays: 1.5 } })['journal.retentionDays']);
    // 0.12.0: Most interns in the office (interns.maxShown) 1-48, like the server
    for (const v of [1, 24, 48]) assert.deepEqual(JSON.parse(JSON.stringify(LS._validate(Object.assign({}, ok, { interns: { maxShown: v } })))), {}, 'maxShown ' + v);
    for (const v of [0, 49, 2.5, 'x']) assert.deepEqual(Object.keys(LS._validate(Object.assign({}, ok, { interns: { maxShown: v } }))), ['interns.maxShown'], 'maxShown ' + v);
    pass('node: save payload = changed keys only (arrays whole), validation mirrors the server (times, Feb 29, dates, names, retention 1-60, zones)');
}

// ---------------------------------------------------------------------------
// Browser part
// ---------------------------------------------------------------------------
function skip(reason) {
    console.log(`SKIP test_life_settings (browser part): ${reason}`);
    console.log(`OK test_life_settings: ${results.length} passed`);
    process.exit(0);
}
function loadPlaywright() {
    for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
        try { return require(c); } catch { /* next */ }
    }
    return null;
}
const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .filter(Boolean).find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const ORIGIN = 'http://office.test';
const TODAY = new Date().toISOString().slice(0, 10);
const STATUS = { alpha: { state: 'idle' }, beta: { state: 'idle' }, gamma: { state: 'idle' }, delta: { state: 'idle' } };
const FIXTURES = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.9.0', office: { name: 'Test Office' }, features: {}, weather: { location: null } },
    '/api/agents': { agents: ['alpha', 'beta', 'gamma', 'delta'].map(k => ({ id: k, statusKey: k, name: k[0].toUpperCase() + k.slice(1), emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true })) },
    '/agent-chat': {},
    '/api/meetings/active': { meetings: [] },
    '/api/meetings/history': { history: [] },
    '/api/office-config': {
        canvasWidth: 1040, canvasHeight: 740,
        walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' },
            sections: [{ x: 0, w: 1040, color: '#37474f', accentColor: '#263238' }], interior: [] },
        floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
        furniture: [
            { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' }, { id: 'd2', type: 'desk', x: 300, y: 220, assignedTo: 'Beta' },
            { id: 'd3', type: 'desk', x: 160, y: 360, assignedTo: 'Gamma' }, { id: 'd4', type: 'desk', x: 300, y: 360, assignedTo: 'Delta' },
            { id: 'n1', type: 'noticeBoard', x: 600, y: 30 }, { id: 't1', type: 'pingPongTable', x: 820, y: 300 },
            { id: 'r1', type: 'receptionDesk', x: 520, y: 600 },
        ],
        branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
        agents: [], pet: { enabled: false },
    },
    '/weather-proxy': { current_condition: [], configured: false },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const OFF = { needsYou: false, interns: false, handoffs: false, visitors: false, alarmClock: false, moods: false, celebrations: false,
    standup: true, seasons: false, tournaments: true, newspaper: true };

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function mergeDeep(a, b) {
    const out = JSON.parse(JSON.stringify(a || {}));
    for (const k of Object.keys(b || {})) out[k] = isObj(b[k]) && isObj(out[k]) ? mergeDeep(out[k], b[k]) : JSON.parse(JSON.stringify(b[k]));
    return out;
}
// One fake office per browser context. srv.mode drives the settings POST answer.
function makeServer(opts = {}) {
    const srv = {
        settings: Object.assign({ enabled: true, calm: false, timeZone: '', features: Object.assign({}, OFF) }, opts.settings || {}),
        envTz: opts.envTz || 'UTC', canManage: opts.canManage !== false, mode: 'ok', posts: [], actions: [], logins: 0,
    };
    srv.tz = () => srv.settings.timeZone || srv.envTz;
    srv.route = async r => {
        const req = r.request(), url = new URL(req.url());
        const json = (status, body) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin !== ORIGIN) return r.abort();
        const p = url.pathname;
        if (p === '/api/office-life/state') return r.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() },
            body: JSON.stringify({ ok: true, seq: 100, day: TODAY, tz: srv.tz(), settings: srv.settings,
                open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], cake: false }, paper: { day: TODAY, ready: false } }) });
        if (p === '/api/office-life/stream') return r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 3000\n: seq 100\n\n' });
        if (p === '/api/access/status') return json(200, { protected: !srv.canManage, authenticated: true, viaLoopback: false, canManage: srv.canManage });
        if (p === '/login.html') { srv.logins++; return r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>login</title>' }); }
        if (p === '/api/office-life/settings' && req.method() === 'POST') {
            const body = JSON.parse(req.postData() || '{}');
            srv.posts.push(body);
            if (srv.mode === 'slow') await new Promise(done => setTimeout(done, 900));
            if (srv.mode === 'invalid') return json(400, { ok: false, error: 'invalid', message: 'Pick a time zone from the list.', errors: [{ field: 'timeZone', message: 'Pick a time zone from the list.' }] });
            if (srv.mode === 'cross') return json(403, { ok: false, error: 'cross_site_blocked', message: 'Changes to the office must come from the office page itself.' });
            if (srv.mode === 'auth') return json(401, { ok: false, error: 'auth_required' });
            srv.settings = mergeDeep(srv.settings, body);
            return json(200, { ok: true, settings: srv.settings, tz: srv.tz() });
        }
        if (p === '/api/office-life/standup/now' || p === '/api/office-life/paper/now') {
            srv.actions.push(p);
            return json(200, p.endsWith('standup/now') ? { ok: true, started: true, id: 'standup-x', participants: 3 } : { ok: true, made: true, day: TODAY });
        }
        if (p === '/api/office-life/days') return json(200, { ok: true, today: TODAY, days: [{ day: TODAY, paper: false, standup: false, lines: 0 }] });
        if (p === '/api/office-life/paper') return json(200, { ok: true, day: TODAY, preview: true, paper: { day: TODAY, tz: 'UTC', masthead: 'The Daily Office', headline: 'A quiet day', columns: [], stats: [], generatedAt: Date.now() } });
        if (p === '/api/office-life/journal') return json(200, { ok: true, day: TODAY, rows: [], next: null });
        if (req.method() !== 'GET' && req.method() !== 'HEAD') { srv.actions.push(p); return json(200, { ok: true }); }
        if (p === '/status') return json(200, STATUS);
        if (Object.prototype.hasOwnProperty.call(FIXTURES, p)) return json(200, FIXTURES[p]);
        const file = path.resolve(APP, p === '/' ? 'index.html' : decodeURIComponent(p.replace(/^\/+/, '')));
        if (file.startsWith(APP + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
            return r.fulfill({ status: 200, contentType: TYPES[path.extname(file)], body: fs.readFileSync(file) });
        }
        return json(200, {});
    };
    return srv;
}

const SHOTS = process.env.L9_SHOT_DIR || '';
const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
async function waitFor(page, label, fn, ms, arg) {
    try { await page.waitForFunction(fn, arg === undefined ? null : arg, { timeout: ms || 15000 }); } catch (e) {
        const dump = await page.evaluate(() => ({ life: window.VOLife && window.VOLife._debug(), ls: window.VOLifeSettings && window.VOLifeSettings._debug() })).catch(() => null);
        throw new Error(`wait "${label}" timed out: ${JSON.stringify(dump).slice(0, 1500)}`);
    }
}
async function openOffice(srv, contextOpts = {}) {
    const context = await browser.newContext(Object.assign({ viewport: { width: 1600, height: 900 }, timezoneId: 'America/Chicago' }, contextOpts));
    await context.route('**/*', srv.route);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.agents && window.agents.length === 4 && window.VOLife && window.VOLife.status() === 'ready'
        && window.VOLifeSettings && window.VOUI, null, { timeout: 20000 });
    return { context, page, errors };
}
async function openLifeTab(page) {
    await page.evaluate(() => window.VOUI.openSettings('life'));
    await waitFor(page, 'life form', () => !!document.querySelector('#voLifeSettings form.vo-ls') && document.querySelector('#voLifeSettings').offsetParent !== null);
    await waitFor(page, 'permission known', () => window.VOLifeSettings._debug().canSave !== null, 5000);
    // The panel slides in: measure only once its box holds still for a frame (the phone
    // Save bar check once caught it 12 px below the screen mid-animation).
    await page.evaluate(async () => {
        const el = document.querySelector('#main-menu-panel');
        let last = '';
        for (let i = 0; i < 90 && el; i++) {
            await new Promise(r => requestAnimationFrame(r));
            const r = el.getBoundingClientRect(), now = [r.left, r.top, r.width, r.height].join(',');
            if (now === last) break;
            last = now;
        }
    });
}
const toasts = page => page.evaluate(() => Array.from(document.querySelectorAll('.vo-toast .vo-toast-text')).map(t => t.textContent));
const status = page => page.evaluate(() => document.querySelector('#voLifeSettings .vo-ls-status').textContent);

try {
    // ---- A: a browser that may save, office on its UTC fallback -> adopts America/Chicago once ----
    const srvA = makeServer();
    let { context, page, errors } = await openOffice(srvA);
    await waitFor(page, 'zone adopted', () => window.VOLife.settings().timeZone === 'America/Chicago', 8000);
    assert.deepEqual(srvA.posts, [{ timeZone: 'America/Chicago' }], 'one settings write with only the zone');
    assert.ok((await toasts(page)).some(t => /Office time zone set to America\/Chicago/.test(t)), 'the user is told once');
    assert.equal((await page.evaluate(() => window.VOLifeSettings._debug().adopt.done)), 'America/Chicago');
    // A reload: the zone is saved now -> no second write.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.VOLife && window.VOLife.status() === 'ready' && window.VOLifeSettings, null, { timeout: 20000 });
    await page.waitForTimeout(800);
    assert.equal(srvA.posts.length, 1, 'adopted once');
    assert.equal(await page.evaluate(() => window.VOLifeSettings._debug().adopt.skipped), 'set');
    pass('time zone: no zone saved + UTC fallback -> this browser\'s zone saved once through the gated route (only timeZone), toast, no write after reload');

    // ---- the form ----
    await openLifeTab(page);
    const shape = await page.evaluate(() => {
        const host = document.getElementById('voLifeSettings');
        const q = s => host.querySelectorAll(s).length;
        const zone = host.querySelector('select[data-field="timeZone"]');
        return { checks: q('input[type="checkbox"]'), days: q('.vo-ls-day'), pressed: Array.from(host.querySelectorAll('.vo-ls-day[aria-pressed="true"]')).map(b => b.textContent),
            times: Array.from(host.querySelectorAll('input[type="time"]')).map(i => i.value), zone: zone && zone.value, zones: zone ? zone.options.length : 0,
            note: (host.querySelector('[data-life-zone-note]') || {}).textContent || '', warn: !!host.querySelector('[data-life-zone-warn]'),
            freq: host.querySelector('select[data-field="tournaments.frequency"]').value, keep: host.querySelector('[data-field="journal.retentionDays"]').value,
            internsMax: (host.querySelector('input[data-field="interns.maxShown"]') || {}).value,
            save: host.querySelector('[data-life-save]').disabled, status: host.querySelector('.vo-ls-status').textContent,
            nav: !!document.querySelector('#main-menu-panel .settings-nav button[data-category="life"].active'),
            footer: getComputedStyle(document.querySelector('#main-menu-panel .settings-footer')).display };
    });
    assert.equal(shape.checks, 2 + 12 + 4 + 5, 'master + calm, 12 features (v0.12: click reactions), 4 season parts, 5 holidays');
    assert.equal(shape.days, 7);
    assert.deepEqual(shape.pressed, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    assert.deepEqual(shape.times, ['09:30', '18:00']);
    assert.equal(shape.zone, 'America/Chicago');
    assert.ok(shape.zones > 300, 'every zone to pick from');
    assert.match(shape.note, /Office time now: .+ \(America\/Chicago\)/);
    assert.equal(shape.warn, false, 'browser and office agree: no warning');
    assert.deepEqual([shape.freq, shape.keep, shape.save, shape.status], ['daily', '14', true, 'All changes saved.']);
    assert.equal(shape.internsMax, '24', '0.12.0: Most interns in the office (1-48, default 24)');
    assert.ok(shape.nav, 'Office life tab active');
    assert.equal(shape.footer, 'none', 'the general Save footer is hidden on this tab');

    // Edit: calm on, tournaments off, stand-up 08:45, Saturday on.
    await page.check('#voLifeSettings label.vo-ls-toggle:has(b:text-is("Calm mode")) input');
    await page.uncheck('#voLifeSettings label.vo-ls-toggle:has(b:text-is("Break-time tournaments")) input');
    await page.fill('#voLifeSettings input[data-field="standup.time"]', '08:45');
    await page.click('#voLifeSettings .vo-ls-day[data-day="6"]');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.day), '6', 'the chip keeps focus after re-render');
    assert.equal(await page.evaluate(() => window.VOLifeSettings.dirty()), true);
    assert.equal(await status(page), 'Unsaved changes.');
    assert.equal(await page.evaluate(() => document.getElementById('main-menu-panel').classList.contains('ui-settings-dirty')), false,
        'Office life edits (even re-rendering ones) never mark the general settings dirty');
    assert.equal(await page.evaluate(() => document.querySelector('.vo-ls-card[data-life-card="tournaments"]').classList.contains('vo-ls-dim')), true, 'switched-off part dims');
    assert.equal(await page.evaluate(() => window.VOLife.calm()), false, 'nothing applied before Save');
    // Close guard: Settings close asks; Keep editing keeps the draft.
    await page.click('#main-menu-panel .catalog-close-btn');
    await waitFor(page, 'confirm', () => Array.from(document.querySelectorAll('.vo-dialog[role="alertdialog"]')).some(d => /Discard unsaved changes/.test(d.textContent)), 4000);
    await page.click('.vo-dialog[role="alertdialog"] button:has-text("Keep editing")');
    await waitFor(page, 'still open', () => document.getElementById('main-menu-panel').classList.contains('open') && window.VOLifeSettings.dirty(), 4000);
    // Save -> payload is the changed keys only; VOLife gets calm.
    await page.click('#voLifeSettings [data-life-save]');
    await waitFor(page, 'saved', () => !window.VOLifeSettings.dirty() && window.VOLife.calm(), 5000);
    assert.deepEqual(srvA.posts[1], { calm: true, features: { tournaments: false }, standup: { time: '08:45', days: [1, 2, 3, 4, 5, 6] } });
    const after = await page.evaluate(() => ({ calm: window.VOLife.calm(), cls: document.documentElement.classList.contains('vo-life-calm'),
        atDesk: window.VOLife.atDesk(), tour: window.VOLife.isOn('tournaments'), st: document.querySelector('#voLifeSettings .vo-ls-status').textContent }));
    assert.deepEqual(after, { calm: true, cls: true, atDesk: true, tour: false, st: 'All changes saved.' });
    assert.ok((await toasts(page)).includes('Office life settings saved.'));
    pass('form: every toggle, day chips, times, zone picker + office time, frequency, retention; dirty state + close guard; Save sends only the changed keys; calm reaches VOLife (class, at-desk, tournaments off)');

    // ---- validation + server errors ----
    await page.click('#voLifeSettings [data-add-occasion]');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.field), 'seasons.custom.0.name', 'new occasion name focused');
    const before = srvA.posts.length;
    await page.click('#voLifeSettings [data-life-save]');
    let v = await page.evaluate(() => { const i = document.querySelector('[data-field="seasons.custom.0.name"]');
        return { inv: i.getAttribute('aria-invalid'), err: (document.getElementById(i.getAttribute('aria-describedby')) || {}).textContent, focus: document.activeElement === i }; });
    assert.deepEqual(v, { inv: 'true', err: 'Give the occasion a name.', focus: true });
    assert.equal(srvA.posts.length, before, 'nothing sent with a client-side error');
    await page.fill('[data-field="seasons.custom.0.name"]', 'Launch <b>day</b> and more');
    assert.equal(await page.evaluate(() => document.querySelector('[data-field="seasons.custom.0.name"]').value.length), 24, 'name clipped at 24');
    await page.selectOption('#voLifeSettings select[data-field="seasons.custom.0.date"]', '02');
    await page.selectOption('#voLifeSettings select[data-field="seasons.custom.0.day"]', '29');
    await page.selectOption('#voLifeSettings select[data-field="seasons.custom.0.icon"]', 'balloon');
    await page.selectOption('#voLifeSettings select[data-field="timeZone"]', 'Europe/Paris');
    const warnTxt = await page.evaluate(() => (document.querySelector('[data-life-zone-warn]') || {}).textContent || '');
    assert.match(warnTxt, /This browser is on America\/Chicago\. Times here use the office zone, Europe\/Paris\./);
    srvA.mode = 'invalid';
    await page.click('#voLifeSettings [data-life-save]');
    await waitFor(page, 'field error', () => document.querySelector('[data-field="timeZone"]').getAttribute('aria-invalid') === 'true', 5000);
    assert.deepEqual(srvA.posts[srvA.posts.length - 1], { timeZone: 'Europe/Paris', seasons: { custom: [{ name: 'Launch <b>day</b> and mo', date: '02-29', icon: 'balloon' }] } });
    assert.equal(await status(page), 'Pick a time zone from the list.');
    srvA.mode = 'cross';
    await page.click('#voLifeSettings [data-life-save]');
    await waitFor(page, 'cross-site', () => /must come from the office page itself/.test(document.querySelector('#voLifeSettings .vo-ls-status').textContent), 5000);
    assert.equal(await page.evaluate(() => window.VOLifeSettings.dirty()), true, 'the draft survives a refused save');
    assert.equal(await page.evaluate(() => document.querySelector('#voLifeSettings .vo-ls-status').classList.contains('is-error')), true);
    pass('errors: client validation focuses the field (no request), occasion name clipped, Feb 29, 400 field error on the zone picker, 403 cross-site message, draft kept');

    // ---- another tab saved meanwhile: its values arrive, the user's edits stay on top ----
    await page.evaluate(() => window.VOLife._inject({ type: 'settings', provider: 'office', at: Date.now(),
        settings: Object.assign(window.VOLife.settings(), { newspaper: { time: '17:15' }, calm: false }) }));
    v = await page.evaluate(() => ({ paper: document.querySelector('[data-field="newspaper.time"]').value, zone: document.querySelector('[data-field="timeZone"]').value,
        occ: document.querySelectorAll('.vo-ls-occ').length, calm: document.querySelector('label.vo-ls-toggle:has(b) input').checked, d: window.VOLifeSettings._debug() }));
    assert.equal(v.paper, '17:15', 'other tab\'s change shown');
    assert.equal(v.zone, 'Europe/Paris', 'own edit kept');
    assert.equal(v.occ, 1, 'own occasion kept');
    assert.equal(v.d.draft.calm, false, 'calm from the other tab');
    // Discard -> back to the saved settings.
    await page.click('#voLifeSettings [data-life-discard]');
    v = await page.evaluate(() => ({ dirty: window.VOLifeSettings.dirty(), zone: document.querySelector('[data-field="timeZone"]').value, occ: document.querySelectorAll('.vo-ls-occ').length }));
    assert.deepEqual(v, { dirty: false, zone: 'America/Chicago', occ: 0 });
    srvA.mode = 'ok';
    pass('another tab\'s save is rebased under the user\'s own edits; Discard returns to the saved settings');

    // ---- v0.10.1 saves: an edit made while a save is on the way is kept (not reset by the answer) ----
    srvA.mode = 'slow';
    await page.fill('[data-field="newspaper.time"]', '18:05');
    await page.click('#voLifeSettings [data-life-save]');
    await waitFor(page, 'saving', () => window.VOLifeSettings._debug().saving === true, 3000);
    await page.fill('[data-field="standup.time"]', '09:10');
    await waitFor(page, 'answered', () => window.VOLifeSettings._debug().saving === false, 5000);
    v = await page.evaluate(() => ({ d: window.VOLifeSettings._debug(), st: document.querySelector('[data-field="standup.time"]').value }));
    assert.equal(v.d.base.newspaper.time, '18:05', 'the sent edit is saved');
    assert.equal(v.d.draft.standup.time, '09:10', 'the edit made during the save is kept');
    assert.equal(v.st, '09:10', 'and still shown');
    assert.equal(v.d.dirty, true, 'and still waits for its own save');
    srvA.mode = 'ok';
    await page.click('#voLifeSettings [data-life-save]');
    await waitFor(page, 'saved again', () => !window.VOLifeSettings.dirty(), 5000);
    assert.deepEqual(srvA.posts[srvA.posts.length - 1], { standup: { time: '09:10' } });
    pass('an edit made while a save is on the way stays in the form and goes out with the next save');

    // ---- a zone saved elsewhere reaches this open page at once (settings frame tz), no reload ----
    v = await page.evaluate(() => {
        const L = window.VOLife, real = L.officeParts, saved = L.settings(), before = L.timeZone();
        const FIXED = Date.UTC(2026, 10, 6, 0, 30); // Fri 00:30 UTC = Thu 18:30 Chicago = Fri 09:30 Tokyo
        const frame = extra => L._inject(Object.assign({ type: 'settings', provider: 'office', at: Date.now(), settings: saved }, extra));
        const plan = () => window.VOLifeSeasons._state().plan;
        const out = { before };
        // officeParts keeps one formatter per zone: no new Intl.DateTimeFormat per call.
        real.call(L, FIXED);
        const RealDTF = Intl.DateTimeFormat;
        let made = 0;
        Intl.DateTimeFormat = function (...a) { made++; return new RealDTF(...a); };
        Object.assign(Intl.DateTimeFormat, { supportedLocalesOf: RealDTF.supportedLocalesOf });
        Intl.DateTimeFormat.prototype = RealDTF.prototype;
        for (let i = 0; i < 50; i++) real.call(L, FIXED + i * 60000);
        out.made = made;
        Intl.DateTimeFormat = RealDTF;
        // Decor reads officeParts at a fixed instant so the Friday treat depends only on the zone.
        L.officeParts = ms => real.call(L, ms == null ? FIXED : ms);
        try {
            frame({ tz: before });
            out.friday0 = plan().friday;
            frame({ tz: 'Asia/Tokyo' });
            const p = real.call(L, FIXED);
            out.after = { tz: L.timeZone(), hour: p.hour, weekday: p.weekday, friday: plan().friday };
            frame({ settings: Object.assign({}, saved, { timeZone: 'Europe/Paris' }) }); // no tz in the frame: settings.timeZone
            out.paris = L.timeZone();
            frame({ tz: before });
            out.restored = L.timeZone();
        } finally { L.officeParts = real; }
        return out;
    });
    assert.equal(v.before, 'America/Chicago', JSON.stringify(v));
    assert.equal(v.made, 0, 'officeParts reuses the zone formatter: ' + JSON.stringify(v));
    assert.equal(v.friday0, false, 'Thursday evening in Chicago: no Friday treat ' + JSON.stringify(v));
    assert.deepEqual(v.after, { tz: 'Asia/Tokyo', hour: 9, weekday: 5, friday: true }, 'Tokyo applied at once, decor re-derived: ' + JSON.stringify(v));
    assert.equal(v.paris, 'Europe/Paris');
    assert.equal(v.restored, 'America/Chicago');
    pass('time zone: the settings frame zone (tz, else settings.timeZone) applies to an open page at once; seasons/Friday treat re-derived; one formatter per zone');

    // ---- "now" buttons ----
    await page.click('#voLifeSettings [data-life-now="standup"]');
    await waitFor(page, 'standup toast', () => Array.from(document.querySelectorAll('.vo-toast-text')).some(t => t.textContent === 'Stand-up started with 3 agents.'), 5000);
    await page.click('#voLifeSettings [data-life-now="paper"]');
    await waitFor(page, 'paper toast', () => Array.from(document.querySelectorAll('.vo-toast-text')).some(t => /Daily Office is printed/.test(t.textContent)), 5000);
    assert.deepEqual(srvA.actions.filter(a => /now$/.test(a)), ['/api/office-life/standup/now', '/api/office-life/paper/now']);
    await page.uncheck('#voLifeSettings label.vo-ls-toggle:has(b:text-is("Daily Office newspaper")) input');
    v = await page.evaluate(() => { const b = document.querySelector('[data-life-now="paper"]'); return [b.disabled, b.title]; });
    assert.deepEqual(v, [true, 'Save your changes first.']);
    await page.click('#voLifeSettings [data-life-discard]');
    pass('"Run stand-up now" and "Print today\'s paper now" call the server and report; blocked while the newspaper is switched off in the draft');

    // ---- More menu: Daily Office + Replay the day ----
    await page.evaluate(() => window.toggleMainMenu());
    await waitFor(page, 'settings closed', () => !document.getElementById('main-menu-panel').classList.contains('open'), 4000);
    await page.click('#btn-more');
    v = await page.evaluate(() => Array.from(document.querySelectorAll('#vo-more-menu [data-vo-life-menu]')).map(b => [b.textContent.trim(), b.hidden, b.getBoundingClientRect().height > 0]));
    assert.deepEqual(v, [['Daily Office', false, true], ['Replay the day', false, true]]);
    await page.click('#vo-more-menu [data-vo-life-paper]:not([data-vo-life-paper="replay"])');
    await waitFor(page, 'paper open', () => window.VOLifePaper && window.VOLifePaper.isOpen() && document.getElementById('vo-more-menu').hidden, 5000);
    await page.keyboard.press('Escape');
    await waitFor(page, 'paper closed', () => !window.VOLifePaper.isOpen(), 4000);
    await page.evaluate(() => { const s = window.VOLife.settings(); s.features.newspaper = false; window.VOLife.applySettings(s); });
    v = await page.evaluate(() => Array.from(document.querySelectorAll('[data-vo-life-menu]')).map(b => b.hidden));
    assert.deepEqual(v, [true, true], 'hidden while the newspaper is off');
    await page.evaluate(() => { const s = window.VOLife.settings(); s.features.newspaper = true; window.VOLife.applySettings(s); });
    pass('More menu: "Daily Office" opens the newspaper, "Replay the day" listed, both hidden when the newspaper is off (vo:life-settings)');

    // ---- item 4: tournament.js ends decided games through VOLifeHost.stopGame ----
    await page.evaluate(() => { const s = window.VOLife.settings(); s.calm = false; s.features.tournaments = true; window.VOLife.applySettings(s);
        window.__stops = []; window.__holds = [];
        const h = window.VOLifeHost, stop = h.stopGame, hold = h.hold;
        h.stopGame = function (k) { window.__stops.push(k); return stop.apply(this, arguments); };
        h.hold = function (k, kind) { window.__holds.push([k, kind]); return hold.apply(this, arguments); }; });
    const inj = ev => page.evaluate(e => window.VOLife._inject(Object.assign({ at: Date.now(), provider: 'office' }, e)), ev);
    await inj({ type: 'tournament.start', id: 'tour-s1', game: 'pong', players: ['alpha', 'beta', 'gamma', 'delta'],
        bracket: { size: 4, byes: [], matches: [{ match: 1, round: 1, p1: 'alpha', p2: 'beta' }, { match: 2, round: 1, p1: 'gamma', p2: 'delta' }, { match: 3, round: 2, p1: null, p2: null }] } });
    await inj({ type: 'tournament.match', id: 'tour-s1', match: 1, round: 1, p1: 'alpha', p2: 'beta', winner: 'beta', score: [1, 3], startsAt: Date.now() + 2500, ms: 30000, walkover: false });
    await waitFor(page, 'game 1 on', () => { const t = window.VOLifeTournament._debug(); return t.live && t.live.game === 'on' && window.pongGames.length === 1; }, 30000);
    const holdsBefore = await page.evaluate(() => window.__holds.length);
    // The next match arrives while match 1 is still on the table: stopGame ends it, the decided result stands.
    await inj({ type: 'tournament.match', id: 'tour-s1', match: 2, round: 1, p1: 'gamma', p2: 'delta', winner: 'gamma', score: [3, 0], startsAt: Date.now() + 2500, ms: 30000, walkover: false });
    v = await page.evaluate(() => ({ stops: window.__stops.slice(), games: window.pongGames.length, res: window.VOLifeTournament._debug().results['1'], holds: window.__holds.length }));
    assert.deepEqual(v.stops, ['alpha'], 'stopGame for the running game');
    assert.equal(v.games, 0, 'the table is free');
    assert.deepEqual(v.res, { winner: 'beta', score: [1, 3], walkover: false });
    assert.equal(v.holds, holdsBefore, 'no hold() workaround');
    await waitFor(page, 'game 2 on', () => { const t = window.VOLifeTournament._debug(); return t.live && t.live.match === 2 && t.live.game === 'on' && window.pongGames.length === 1; }, 30000);
    // A walkover for the match on the table ends that game too; players keep watching (still held by the tournament).
    await inj({ type: 'tournament.match', id: 'tour-s1', match: 2, round: 1, p1: 'gamma', p2: 'delta', winner: 'delta', walkover: true, startsAt: Date.now(), ms: 0 });
    v = await page.evaluate(() => ({ stops: window.__stops.slice(), games: window.pongGames.length, res: window.VOLifeTournament._debug().results['2'],
        held: ['gamma', 'delta'].map(k => (window.VOLifeHost.agent(k)._lifeHold || {}).kind || null) }));
    assert.deepEqual(v.stops, ['alpha', 'gamma']);
    assert.equal(v.games, 0);
    assert.deepEqual(v.res, { winner: 'delta', walkover: true });
    assert.deepEqual(v.held, ['tournament', 'tournament'], 'players stay in the tournament after the stop');
    await inj({ type: 'tournament.end', id: 'tour-s1', status: 'called_off' });
    assert.deepEqual(errors, [], 'no page errors');
    pass('tournament: next match and walkover end the decided game on the table through VOLifeHost.stopGame (no hold workaround), results stand, players keep watching');

    // ---- desktop look, dark + light ----
    for (const mode of ['dark', 'light']) {
        await page.evaluate(() => { const d = document.querySelector('#voLifeSettings [data-life-discard]'); if (d && !d.disabled) d.click(); });
        await page.evaluate(m => { const b = document.querySelector('#vo-more-menu [data-theme-mode="' + m + '"]'); if (b) b.click(); }, mode);
        await openLifeTab(page);
        // v0.10 UI-12: the Save bar shows only with something to save, so make one change first.
        await page.evaluate(() => { const c = document.querySelector('#voLifeSettings input[type="checkbox"][data-field="calm"]') || document.querySelectorAll('#voLifeSettings input[type="checkbox"]')[1]; c.click(); });
        const g = await page.evaluate(() => {
            const body = document.querySelector('#main-menu-panel .main-menu-body'), form = document.querySelector('#voLifeSettings form'), bar = form.querySelector('.vo-ls-bar');
            const card = form.querySelector('.vo-ls-card'), b = body.getBoundingClientRect(), r = bar.getBoundingClientRect();
            body.scrollTop = 400;
            const r2 = bar.getBoundingClientRect();
            const cs = getComputedStyle(card), title = getComputedStyle(card.querySelector('.mm-section-title')), hint = getComputedStyle(card.querySelector('small'));
            const tg = card.querySelector('.vo-ls-toggle'), tb = tg.querySelector('b').getBoundingClientRect(), ts = tg.querySelector('small').getBoundingClientRect(), ti = tg.querySelector('input').getBoundingClientRect();
            return { theme: document.documentElement.dataset.uiTheme, overflowX: body.scrollWidth - body.clientWidth, barBottomGap: Math.round(b.bottom - r2.bottom),
                hintGap: Math.round(ts.top - tb.bottom), boxOff: Math.round(Math.abs((ti.top + ti.bottom) / 2 - (tb.top + tb.bottom) / 2)),
                barInside: r2.top >= b.top && r2.bottom <= b.bottom + 1, barBg: getComputedStyle(bar).backgroundColor, cardBg: cs.backgroundColor,
                title: title.color, hint: hint.color, formW: Math.round(form.getBoundingClientRect().width), initialBarBottom: Math.round(r.bottom), bodyBottom: Math.round(b.bottom) };
        });
        assert.equal(g.theme, mode);
        assert.ok(g.overflowX <= 0, `no sideways scroll (${mode})`);
        assert.ok(g.barInside && Math.abs(g.barBottomGap) <= 1, `Save bar sticks to the bottom (${mode}: ${JSON.stringify(g)})`);
        assert.notEqual(g.barBg, 'rgba(0, 0, 0, 0)', 'bar has a solid background');
        assert.ok(g.hintGap >= 0 && g.hintGap <= 6 && g.boxOff <= 4, `toggle: hint right under the label, box on the label line (${g.hintGap}, ${g.boxOff})`);
        console.log(`  desktop ${mode}: form ${g.formW}px, card ${g.cardBg}, title ${g.title}, hint ${g.hint}`);
        if (SHOTS && mode === 'dark') {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.evaluate(() => { document.querySelector('#main-menu-panel .main-menu-body').scrollTop = 0; });
            const box = await page.evaluate(() => { const r = document.getElementById('main-menu-panel').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
            await page.screenshot({ path: path.join(SHOTS, 'l9-settings-desktop-dark.jpg'), type: 'jpeg', quality: 60,
                clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(800, box.w), height: Math.min(560, box.h) } });
        }
    }
    pass('desktop 1600x900: Office life tab in dark and light, no sideways scroll, Save bar pinned to the bottom with a solid background');

    // ---- 401: vo-auth.js sends the browser to the login page ----
    await page.check('#voLifeSettings label.vo-ls-toggle:has(b:text-is("Moods")) input');
    srvA.mode = 'auth';
    await page.click('#voLifeSettings [data-life-save]');
    await page.waitForURL(/\/login\.html\?next=/, { timeout: 8000 });
    assert.equal(srvA.logins, 1);
    pass('401 auth_required on save -> login page (vo-auth.js)');
    await context.close();

    // ---- B: a browser that may not save: no adoption, read-only form ----
    const srvB = makeServer({ canManage: false });
    ({ context, page, errors } = await openOffice(srvB));
    await page.waitForTimeout(1200);
    assert.equal(srvB.posts.length, 0, 'no write without permission');
    assert.equal(await page.evaluate(() => window.VOLifeSettings._debug().adopt.skipped), 'no-permission');
    await openLifeTab(page);
    v = await page.evaluate(() => ({ fs: document.querySelector('#voLifeSettings fieldset').disabled, ro: (document.querySelector('.vo-ls-readonly') || {}).textContent,
        save: document.querySelector('[data-life-save]').disabled, now: document.querySelector('[data-life-now="standup"]').disabled }));
    assert.deepEqual(v, { fs: true, ro: 'Only the office owner can change these settings (sign in with the office passcode).', save: true, now: true });
    await context.close();
    // ---- C: the server already has a zone from TZ (no zone saved): kept; the form warns + offers the browser zone ----
    const srvC = makeServer({ envTz: 'Europe/Berlin' });
    ({ context, page, errors } = await openOffice(srvC));
    await page.waitForTimeout(1200);
    assert.equal(srvC.posts.length, 0, 'an operator TZ is kept');
    assert.equal(await page.evaluate(() => window.VOLifeSettings._debug().adopt.skipped), 'env');
    await openLifeTab(page);
    v = await page.evaluate(() => ({ zone: document.querySelector('[data-field="timeZone"]').value, label: document.querySelector('[data-field="timeZone"]').options[0].textContent,
        warn: (document.querySelector('[data-life-zone-warn]') || {}).textContent || '' }));
    assert.equal(v.zone, '');
    assert.equal(v.label, 'Server default (Europe/Berlin)');
    assert.match(v.warn, /This browser is on America\/Chicago\. Times here use the office zone, Europe\/Berlin\.Use America\/Chicago/);
    await page.click('[data-life-zone-warn] button');
    assert.equal(await page.evaluate(() => document.querySelector('[data-field="timeZone"]').value), 'America/Chicago');
    assert.equal(await page.evaluate(() => !!document.querySelector('[data-life-zone-warn]')), false, 'warning gone once they agree');
    await context.close();
    pass('time zone: no write without permission (read-only form), an operator TZ is kept (picker shows "Server default (Europe/Berlin)", warning + "Use America/Chicago")');

    // ---- D: phone 412x915, UTC browser (no adoption), light theme ----
    const srvD = makeServer();
    ({ context, page, errors } = await openOffice(srvD, { viewport: { width: 412, height: 915 }, timezoneId: 'UTC', isMobile: true, hasTouch: true, deviceScaleFactor: 2 }));
    await page.waitForTimeout(1000);
    assert.equal(srvD.posts.length, 0, 'a UTC browser saves nothing');
    assert.equal(await page.evaluate(() => window.VOLifeSettings._debug().adopt.skipped), 'utc');
    await page.click('.vo-actionbar [data-vo-action="more"]');
    await waitFor(page, 'menu open', () => !document.getElementById('vo-more-menu').hidden, 4000);
    v = await page.evaluate(() => Array.from(document.querySelectorAll('#vo-more-menu [data-vo-life-menu]')).map(b => {
        const r = b.getBoundingClientRect(); return [b.hidden, Math.round(r.height), r.top >= 0 && r.bottom <= innerHeight]; }));
    assert.deepEqual(v, [[false, v[0][1], true], [false, v[1][1], true]], 'both items visible on the phone menu');
    assert.ok(v[0][1] >= 40, 'touch-sized items');
    await page.tap('#vo-more-menu [data-vo-life-paper="replay"]');
    await waitFor(page, 'replay', () => window.VOLifePaper.replaying(), 6000);
    await page.evaluate(() => window.VOLifePaper.exitReplay());
    for (const mode of ['light', 'dark']) {
        await page.evaluate(m => { const b = document.querySelector('#vo-more-menu [data-theme-mode="' + m + '"]'); if (b) b.click(); }, mode);
        await openLifeTab(page);
        // v0.10 UI-12: the Save bar shows only with something to save, so make one change first.
        await page.evaluate(() => { const c = document.querySelector('#voLifeSettings input[type="checkbox"][data-field="calm"]') || document.querySelectorAll('#voLifeSettings input[type="checkbox"]')[1]; c.click(); });
        const g = await page.evaluate(() => {
            const body = document.querySelector('#main-menu-panel .main-menu-body'), bar = document.querySelector('#voLifeSettings .vo-ls-bar');
            const tab = document.querySelector('#main-menu-panel .settings-nav button[data-category="life"]').getBoundingClientRect();
            body.scrollTop = 600;
            const b = body.getBoundingClientRect(), r = bar.getBoundingClientRect();
            const chips = Array.from(document.querySelectorAll('.vo-ls-day')).map(c => c.getBoundingClientRect());
            const occ = document.querySelector('[data-add-occasion]').getBoundingClientRect();
            const tg = document.querySelector('#voLifeSettings .vo-ls-toggle'), tb = tg.querySelector('b').getBoundingClientRect(), ts = tg.querySelector('small').getBoundingClientRect(), ti = tg.querySelector('input').getBoundingClientRect();
            return { theme: document.documentElement.dataset.uiTheme, overflowX: body.scrollWidth - body.clientWidth, docX: document.documentElement.scrollWidth - innerWidth,
                // The buttons (the bar's padding may sit under the screen edge with the panel's own height).
                barInside: r.top >= b.top - 1 && Array.from(bar.querySelectorAll('button')).every(x => { const q = x.getBoundingClientRect(); return q.bottom <= innerHeight && q.top >= b.top; }),
                barH: Math.round(r.height), geo: [Math.round(b.top), Math.round(b.bottom), Math.round(r.top), Math.round(r.bottom), innerHeight],
                chipMin: Math.round(Math.min(...chips.map(c => Math.min(c.width, c.height)))), tabH: Math.round(tab.height), occW: Math.round(occ.width),
                hintGap: Math.round(ts.top - tb.bottom), boxOff: Math.round(Math.abs((ti.top + ti.bottom) / 2 - (tb.top + tb.bottom) / 2)), toggleH: Math.round(tg.getBoundingClientRect().height) };
        });
        assert.equal(g.theme, mode);
        assert.ok(g.overflowX <= 0 && g.docX <= 0, `phone: no sideways scroll (${mode}: ${JSON.stringify(g)})`);
        assert.ok(g.barInside, `phone: Save bar on screen (${mode}: ${JSON.stringify(g)})`);
        assert.ok(g.chipMin >= 44, 'phone: day chips are 44 px touch targets');
        assert.ok(g.hintGap >= 0 && g.hintGap <= 6 && g.boxOff <= 4 && g.toggleH >= 44, `phone toggle rows (${JSON.stringify(g)})`);
        if (SHOTS && mode === 'light') {
            await page.evaluate(() => { document.querySelector('#main-menu-panel .main-menu-body').scrollTop = 520; });
            await page.screenshot({ path: path.join(SHOTS, 'l9-settings-phone-light.jpg'), type: 'jpeg', quality: 60, clip: { x: 0, y: 0, width: 412, height: 915 } });
        }
        await page.click('#voLifeSettings [data-life-discard]');
    }
    assert.deepEqual(errors, [], 'no page errors (phone)');
    await context.close();
    pass('phone 412x915: More menu (action bar) lists Daily Office + Replay (tap starts the replay), Office life tab in light and dark: no sideways scroll, Save bar on screen, 44 px chips; UTC browser adopts nothing');
} finally {
    await browser.close();
}
console.log(`OK test_life_settings: ${results.length} passed`);
