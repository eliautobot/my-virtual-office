// Office life L8: seasons and occasions (decor.js) + The Daily Office and replay (paper.js).
// Node part: the date matrix (north/south, tropics, no location, each holiday and its switch, custom
// occasions with 02-29, Friday treat, weather kinds) and the static layer rebuilt once per change,
// on decor.js in a vm with a fake host. Browser part (playwright-core + Chrome, fixture server, no
// real backend): decor drawn from a configured southern weather location and a custom occasion,
// no idle static rebuilds, the newspaper window rendering a saved fixture paper with hostile
// strings (escaping), archive + today's preview, paper.ready prop + toast once + click, replay
// enter/seek/exit without moving live state (no writes), phone layout of window and bar.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);
const results = [];
function pass(name) { results.push(name); console.log(`[PASS] ${name}`); }

const DECOR_SRC = fs.readFileSync(path.join(APP, 'office-life', 'decor.js'), 'utf8');
const R = require(path.join(APP, 'office-life', 'decor.js'));
const P = (y, m, d, extra = {}) => Object.assign({ year: y, month: m, day: d, hour: 12, minute: 0, weekday: 3 }, extra);

// ---- 1. seasons: hemisphere, tropics, no location ----
{
    const north = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
    const flip = { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' };
    for (let m = 1; m <= 12; m++) {
        assert.equal(R.season(m, 40.7), north[m - 1], `north month ${m}`);
        assert.equal(R.season(m, -33.9), flip[north[m - 1]], `south month ${m}`);
        assert.equal(R.season(m, 1.35), null, `tropics month ${m}`);
        assert.equal(R.season(m, -12), null, `southern tropics month ${m}`);
        assert.equal(R.season(m, null), null, `no location month ${m}`);
        assert.equal(R.season(m, undefined), null);
        assert.equal(R.season(m, ''), null);
    }
    assert.equal(R.season(1, 23.44), 'winter', 'the tropic line itself has seasons');
    assert.equal(R.season(1, 23.43), null);
    assert.equal(R.season(7, -23.44), 'winter');
    assert.equal(R.season(1, 'abc'), null);
    assert.equal(R.season(13, 40), null);
    assert.equal(R.season(1, '51.5'), 'winter', 'a string latitude from the weather feed');
    // The plan: no location = neutral decor, holidays still apply.
    const p = R.plan({ parts: P(2026, 10, 31), lat: null, seasons: {} });
    assert.equal(p.season, null);
    assert.deepEqual(p.holidays, ['halloween']);
    assert.equal(R.plan({ parts: P(2026, 10, 31), lat: 48.8, seasons: { decor: false } }).season, null, 'decor switch off');
    pass('seasons: meteorological north, swapped south, tropics (|lat| < 23.44) and no location = no seasonal decor, holidays still on');
}

// ---- 2. holidays: dates and switches ----
{
    const cases = [
        [P(2026, 12, 31), ['newYear', 'yearEndLights']], [P(2027, 1, 1), ['newYear']], [P(2027, 1, 2), []],
        [P(2026, 2, 14), ['valentines']], [P(2026, 2, 13), []], [P(2026, 4, 22), ['earthDay']], [P(2026, 10, 31), ['halloween']],
        [P(2026, 12, 14), []], [P(2026, 12, 15), ['yearEndLights']], [P(2026, 12, 24), ['yearEndLights']], [P(2026, 11, 2), []],
    ];
    for (const [parts, want] of cases) assert.deepEqual(R.holidaysOn(parts, {}).sort(), want.slice().sort(), JSON.stringify(parts));
    for (const id of ['newYear', 'valentines', 'earthDay', 'halloween', 'yearEndLights']) {
        const day = { newYear: P(2027, 1, 1), valentines: P(2026, 2, 14), earthDay: P(2026, 4, 22), halloween: P(2026, 10, 31), yearEndLights: P(2026, 12, 20) }[id];
        assert.ok(R.holidaysOn(day, {}).includes(id), id + ' on by default');
        assert.ok(!R.holidaysOn(day, { [id]: false }).includes(id), id + ' switched off');
    }
    pass('holidays: New Year (12-31, 01-01), Valentine (02-14), Earth Day (04-22), Halloween (10-31), year-end lights (12-15..31), each switchable');
}

// ---- 3. custom occasions + Feb 29 ----
{
    const list = [{ name: 'Leap party', date: '02-29', icon: 'balloon' }, { name: 'Founders day <b>', date: '06-15', icon: 'nope' },
        { name: '', date: '06-15', icon: 'star' }, { name: 'Bad date', date: '6-15', icon: 'star' }, null,
        { name: 'A very long occasion name that goes on and on', date: '06-15', icon: 'heart' }];
    assert.deepEqual(R.customOn(P(2028, 2, 29), list), [{ name: 'Leap party', icon: 'balloon' }], 'leap year: on 02-29');
    assert.deepEqual(R.customOn(P(2028, 2, 28), list), [], 'leap year: not on 02-28');
    assert.deepEqual(R.customOn(P(2027, 2, 28), list), [{ name: 'Leap party', icon: 'balloon' }], 'other years: 02-29 falls on 02-28');
    assert.deepEqual(R.customOn(P(2100, 2, 28), list).length, 1, '2100 is not a leap year');
    const june = R.customOn(P(2026, 6, 15), list);
    assert.equal(june.length, 2);
    assert.deepEqual(june[0], { name: 'Founders day <b>', icon: 'star' }, 'unknown icon -> star; text kept as plain text');
    assert.ok(june[1].name.length <= 24 && june[1].name.endsWith('…'), 'names clipped to 24');
    assert.equal(R.customOn(P(2026, 6, 15), new Array(20).fill({ name: 'x', date: '06-15', icon: 'star' })).length, 12, 'max 12');
    pass('custom occasions: MM-DD, 02-29 on 02-28 in other years, name clip 24, icon whitelist, max 12');
}

// ---- 4. Friday treat + weather kinds + plan ----
{
    assert.equal(R.fridayTreat(P(2026, 11, 6, { weekday: 5, hour: 7 })), false);
    assert.equal(R.fridayTreat(P(2026, 11, 6, { weekday: 5, hour: 8 })), true);
    assert.equal(R.fridayTreat(P(2026, 11, 6, { weekday: 5, hour: 16, minute: 59 })), true);
    assert.equal(R.fridayTreat(P(2026, 11, 6, { weekday: 5, hour: 17 })), false);
    assert.equal(R.fridayTreat(P(2026, 11, 5, { weekday: 4, hour: 10 })), false);
    for (const c of ['drizzle', 'light_rain', 'rain', 'heavy_rain', 'thunderstorm', 'sleet']) assert.equal(R.weatherKind(c), 'rain', c);
    for (const c of ['light_snow', 'snow', 'snow_storm']) assert.equal(R.weatherKind(c), 'snow', c);
    for (const c of ['sunny', 'clear', 'cloudy', 'foggy', '', null]) assert.equal(R.weatherKind(c), '', String(c));
    const wet = R.plan({ parts: P(2026, 11, 6, { weekday: 5, hour: 9 }), lat: 40, condition: 'rain', present: 9, seasons: {} });
    assert.equal(wet.friday, true);
    assert.equal(wet.umbrellas, 6, 'min(present, 6)');
    assert.equal(R.plan({ parts: P(2026, 11, 6), condition: 'rain', present: 2, seasons: {} }).umbrellas, 2);
    assert.equal(R.plan({ parts: P(2026, 11, 6), condition: 'rain', present: 2, seasons: { rain: false } }).weather, '', 'rain switch off');
    assert.equal(R.plan({ parts: P(2026, 11, 6, { weekday: 5, hour: 9 }), seasons: { fridayTreat: false } }).friday, false);
    assert.deepEqual(R.plan({ parts: P(2026, 11, 6), birthdays: [{ key: 'a', years: 2 }], seasons: { birthdays: false } }).birthdays, []);
    pass('Friday treat 08:00-17:00 office time, rain/snow kinds, umbrellas min(present, 6), each sub-switch');
}

// ---- 5. the feature in a vm: static layer rebuilt once per change, hats ----
function decorWorld() {
    const clock = { t: Date.UTC(2026, 10, 2, 15, 0) };
    const agents = ['alpha', 'beta', 'gamma'].map((k, i) => ({ statusKey: k, id: k, name: k[0].toUpperCase() + k.slice(1), _statusState: 'working',
        x: 100 + i * 100, y: 200, desk: { x: 100 + i * 100, y: 200 } }));
    const map = Object.fromEntries(agents.map(a => [a.key || a.statusKey, a]));
    const W = { condition: 'sunny', lat: 40.7, inv: 0, parts: P(2026, 11, 2, { weekday: 1, hour: 10 }) };
    const host = {
        agents: () => agents.slice(), agent: k => map[k] || null, weather: () => ({ condition: W.condition, lat: W.lat }),
        invalidateStatic() { W.inv++; }, spots: () => ({}), furniture: () => [], editMode: () => false,
    };
    let settings = { enabled: true, features: { seasons: true }, seasons: { decor: true, fridayTreat: true, rain: true, birthdays: true, holidays: {}, custom: [] } };
    const TEXT = { birthday: 'Happy {n}{suffix} office birthday, {name}!' };
    const defs = {};
    const life = {
        host: () => host, sprites: () => null, settings: () => JSON.parse(JSON.stringify(settings)),
        isOn: n => settings.enabled !== false && (!n || settings.features[n] !== false),
        officeParts: () => Object.assign({}, W.parts), day: () => '2026-11-02',
        t: (k, v) => String(TEXT[k] || '').replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : '')),
        ordinal: n => ['th', 'st', 'nd', 'rd'][n % 10] || 'th', clip: s => s,
        addText(o) { Object.assign(TEXT, o); },
        feature(name, def) { def.name = name; defs[name] = def; if (def.init) def.init(life); return def; },
    };
    const win = { VOLife: life };
    const ctx = vm.createContext({ window: win, console, __clock: clock, JSON });
    vm.runInContext('Date.now = function () { return __clock.t; };', ctx);
    vm.runInContext(DECOR_SRC, ctx, { filename: 'decor.js' });
    const f = defs.decor;
    return { W, f, clock, agents, win, setSettings(s) { settings = s; f.onSettings(s); }, step(ms = 5000) { clock.t += ms; f.update(clock.t); } };
}
{
    const w = decorWorld();
    assert.ok(w.f && w.f.drawStatic && w.f.drawScreen, 'decor feature registered with static + screen hooks');
    w.f.onState({ today: { birthdays: ['beta'], birthdayYears: { beta: 3 } } });
    assert.equal(w.W.inv, 1, 'first snapshot -> one rebuild');
    for (let i = 0; i < 6; i++) w.step();
    assert.equal(w.W.inv, 1, 'no change -> no rebuild (30 s of checks)');
    w.W.condition = 'rain';
    w.step(1000);
    assert.equal(w.W.inv, 1, 'checks are throttled to every 5 s');
    w.step();
    assert.equal(w.W.inv, 2, 'weather change -> one rebuild');
    w.step(); w.step();
    assert.equal(w.W.inv, 2);
    w.agents[0]._statusState = 'offline';
    w.step();
    assert.equal(w.W.inv, 3, 'umbrella count follows who is present while it rains');
    w.W.condition = 'sunny';
    w.agents[1]._statusState = 'offline';
    w.step();
    assert.equal(w.W.inv, 4);
    w.agents[1]._statusState = 'working';
    w.step();
    assert.equal(w.W.inv, 4, 'presence changes without rain do not rebuild');
    w.W.parts = P(2026, 12, 1, { weekday: 2, hour: 10 });
    w.step();
    assert.equal(w.W.inv, 5, 'a new season -> one rebuild');
    const st = w.win.VOLifeSeasons._state();
    assert.equal(st.plan.season, 'winter');
    assert.deepEqual([...st.hats], ['beta'], 'party hat only on the birthday agent');
    assert.equal(st.banner.text, 'Happy 3rd office birthday, Beta!');
    assert.ok(w.win.VOLifeDecor === undefined || w.agents[1]._lifeDecorate, 'hat decorator set');
    w.W.parts = P(2027, 1, 1, { weekday: 5, hour: 10 });
    w.step();
    assert.deepEqual([...w.win.VOLifeSeasons._state().hats].sort(), ['alpha', 'beta', 'gamma'], 'New Year: hats on everyone');
    w.setSettings({ enabled: true, features: { seasons: false }, seasons: {} });
    assert.deepEqual([...w.win.VOLifeSeasons._state().hats], [], 'feature off -> hats removed');
    w.setSettings({ enabled: true, features: { seasons: true }, seasons: { holidays: { newYear: false }, birthdays: false } });
    w.step();
    assert.deepEqual([...w.win.VOLifeSeasons._state().hats], [], 'New Year off and birthdays off -> no hats');
    pass('decor feature: one static rebuild per change (snapshot, weather, presence in rain, season), 5 s throttle, hats for birthdays / New Year, removed when off');
}

// ===================== browser part =====================
function skip(reason) {
    console.log(`SKIP test_life_decor_paper (browser part): ${reason}`);
    console.log(`OK test_life_decor_paper: ${results.length} passed`);
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
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const DAY0 = Date.parse(YESTERDAY + 'T00:00:00Z');
const STATUS = {
    alpha: { state: 'working', task: 'Writing docs' }, beta: { state: 'working', task: 'Running tests' },
    gamma: { state: 'working', task: 'Review' }, delta: { state: 'working', task: 'Build' },
};
const EVIL = '<img src=x onerror="window.__xss=1">';
const PAPER = {
    day: YESTERDAY, tz: 'UTC', masthead: 'The Daily Office', headline: 'Alpha shipped 3 tasks ' + EVIL, subhead: 'Quiet <script>window.__xss=2</script> afternoon',
    columns: [
        { agent: 'alpha', name: 'Alpha', line: 'Finished 3 tasks <b>bold</b>', stats: { tasks: 3, runs: 5, visitors: 0, handoffs: 1 } },
        { agent: 'ghost', name: 'Ghost ' + EVIL, line: 'A quiet day', stats: { tasks: 0, runs: 0, visitors: 0, handoffs: 0 } },
    ],
    mvp: { agent: 'alpha', name: 'Alpha', score: 17, reason: 'Finished 3 tasks ' + EVIL },
    stats: [{ label: 'Busiest hour', value: '14:00' }, { label: 'Messages <i>', value: 'Telegram 2' }],
    standup: { id: 'standup-1', at: Math.floor(DAY0 / 1000) + 9.5 * 3600, participants: 3 },
    tournament: { id: 't1', game: 'pong', champion: 'beta', championName: 'Beta', status: 'done' },
    generatedAt: DAY0 + 18 * 3600000,
};
const PREVIEW = { day: TODAY, tz: 'UTC', masthead: 'The Daily Office', headline: 'A quiet day at the office', subhead: '', columns: [], mvp: null, stats: [], generatedAt: Date.now() };
const at = (h, m = 0) => DAY0 + (h * 60 + m) * 60000;
const JOURNAL = [
    ...['alpha', 'beta', 'gamma', 'delta'].map(a => ({ type: 'state', at: at(8), agent: a, to: 'idle' })),
    { type: 'state', at: at(9), agent: 'alpha', from: 'idle', to: 'working' },
    { type: 'state', at: at(9, 5), agent: 'gamma', from: 'idle', to: 'offline' },
    { type: 'needs.open', at: at(10), agent: 'delta', ref: 'appr-1', need: 'approval' },
    { type: 'visitor', at: at(10, 1), agent: 'beta', channel: 'telegram' },
    { type: 'xp', at: at(10, 2), agent: 'alpha', points: 12, total: 40, reason: 'task' },
    { type: 'needs.close', at: at(10, 30), agent: 'delta', ref: 'appr-1', outcome: 'approved' },
];
const FIXTURES = {
    '/api/license': { demo: false, valid: true, limits: {} },
    '/vo-config': { version: '0.9.0', office: { name: 'Test Office' }, features: {}, weather: { location: 'Sydney' } },
    '/api/agents': { agents: ['alpha', 'beta', 'gamma', 'delta'].map(k => ({ id: k, statusKey: k, name: k[0].toUpperCase() + k.slice(1), emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true })) },
    '/agent-chat': {},
    '/api/office-config': {
        canvasWidth: 1040, canvasHeight: 740,
        walls: { height: 90, trimColor: '#ffffff', topWall: { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' },
            sections: [{ x: 0, w: 1040, color: '#37474f', accentColor: '#263238' }], interior: [] },
        floor: { color1: '#c0c0c0', color2: '#b0b0b0' },
        furniture: [
            { id: 'd1', type: 'desk', x: 160, y: 220, assignedTo: 'Alpha' }, { id: 'd2', type: 'desk', x: 460, y: 220, assignedTo: 'Beta' },
            { id: 'd3', type: 'desk', x: 160, y: 380, assignedTo: 'Gamma' }, { id: 'd4', type: 'desk', x: 460, y: 380, assignedTo: 'Delta' },
            { id: 'k1', type: 'kitchenCounter', x: 760, y: 560 }, { id: 'r1', type: 'receptionDesk', x: 520, y: 600 },
            { id: 'n1', type: 'noticeBoard', x: 700, y: 30 }, { id: 'p1', type: 'plant', x: 60, y: 140 }, { id: 'p2', type: 'tallPlant', x: 960, y: 140 },
            { id: 'w1', type: 'window', x: 300, y: 20 },
        ],
        branches: [{ id: 'HQ', name: 'Headquarters', emoji: '⚡', theme: 'branch-gold' }],
        agents: [], pet: { enabled: false },
    },
    // A configured southern location (Sydney) in the rain: summer in the south in November, umbrellas.
    '/weather-proxy': { current_condition: [{ weatherCode: '302', temp_F: '68', windspeedMiles: '5', humidity: '80', FeelsLikeF: '68', uvIndex: '1', visibility: '10', precipMM: '2', cloudcover: '90' }],
        nearest_area: [{ latitude: '-33.87', longitude: '151.21' }], weather: [{ astronomy: [{ sunrise: '05:45 AM', sunset: '07:40 PM' }] }] },
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const life = {
    state: { ok: true, seq: 100, day: TODAY, tz: 'UTC', settings: { enabled: true, calm: false,
        features: { needsYou: false, interns: false, handoffs: false, visitors: false, alarmClock: false, moods: false, celebrations: false,
            standup: false, seasons: true, tournaments: false, newspaper: true },
        seasons: { decor: true, fridayTreat: true, rain: true, birthdays: true, custom: [{ name: 'Launch day <b>', date: TODAY.slice(5), icon: 'balloon' }] } },
        open: { needs: [], interns: {}, moods: {} }, today: { birthdays: [], cake: false }, paper: { day: TODAY, ready: false } },
    seq: 100, pending: [], writes: [], paperHits: [],
};
function json(r, status, body) { return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }); }
function route(r) {
    const req = r.request(), url = new URL(req.url());
    if (url.origin !== ORIGIN) return r.abort();
    if (req.method() !== 'GET' && req.method() !== 'HEAD') { life.writes.push(url.pathname); return json(r, 200, { ok: true }); }
    if (url.pathname === '/api/office-life/state') return r.fulfill({ status: 200, contentType: 'application/json', headers: { Date: new Date().toUTCString() }, body: JSON.stringify(life.state) });
    if (url.pathname === '/api/office-life/stream') {
        let body = `retry: 3000\n: seq ${life.seq}\n\n`;
        for (const ev of life.pending.splice(0)) { life.seq++; body += `id: ${life.seq}\ndata: ${JSON.stringify({ seq: life.seq, ts: Date.now() / 1000, scope: 'connection', event: ev })}\n\n`; }
        return r.fulfill({ status: 200, contentType: 'text/event-stream', body });
    }
    if (url.pathname === '/api/office-life/days') return json(r, 200, { ok: true, today: TODAY, days: [{ day: TODAY, paper: life.state.paper.ready, standup: false, lines: 3 }, { day: YESTERDAY, paper: true, standup: true, lines: 9 }] });
    if (url.pathname === '/api/office-life/paper') {
        const day = url.searchParams.get('day'); life.paperHits.push(url.search);
        if (day === YESTERDAY) return json(r, 200, { ok: true, day, paper: PAPER, preview: false });
        if (day === TODAY && url.searchParams.get('preview') === '1') return json(r, 200, { ok: true, day, paper: PREVIEW, preview: true });
        if (day === TODAY && life.state.paper.ready) return json(r, 200, { ok: true, day, paper: Object.assign({}, PREVIEW, { headline: 'Printed today' }), preview: false });
        return json(r, 404, { ok: false, error: 'no_paper', message: 'No newspaper was made that day.' });
    }
    if (url.pathname === '/api/office-life/journal') {
        const day = url.searchParams.get('day');
        return json(r, 200, { ok: true, day, rows: day === YESTERDAY ? JOURNAL : [], next: null });
    }
    if (url.pathname === '/status') return json(r, 200, STATUS);
    if (Object.prototype.hasOwnProperty.call(FIXTURES, url.pathname)) return json(r, 200, FIXTURES[url.pathname]);
    const file = path.resolve(APP, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.replace(/^\/+/, '')));
    if (file.startsWith(APP + path.sep) && TYPES[path.extname(file)] && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return r.fulfill({ status: 200, contentType: TYPES[path.extname(file)], body: fs.readFileSync(file) });
    }
    return json(r, 200, {});
}

const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
async function waitFor(page, label, fn, ms) {
    try { await page.waitForFunction(fn, null, { timeout: ms || 20000 }); } catch (e) {
        const dump = await page.evaluate(() => ({ life: window.VOLife && window.VOLife._debug(), paper: window.VOLifePaper && window.VOLifePaper._debug(),
            agents: (window.agents || []).map(a => [a.statusKey, a.state, Math.round(a.x), Math.round(a.y), a.isSitting, a._lifeHold && a._lifeHold.kind, a._lifePose]) })).catch(() => null);
        throw new Error(`wait "${label}" timed out: ${JSON.stringify(dump)}`);
    }
}
async function openOffice(contextOpts = {}) {
    const context = await browser.newContext(Object.assign({ viewport: { width: 1600, height: 900 } }, contextOpts));
    await context.route('**/*', route);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.agents && window.agents.length === 4 && window.VOLife && window.VOLife.status() === 'ready', null, { timeout: 20000 });
    await waitFor(page, 'seated', () => window.agents.every(a => a.isSitting && a.desk && Math.abs(a.x - a.desk.x) < 3 && Math.abs(a.y - a.desk.y) < 3), 20000);
    return { context, page, errors };
}

try {
    const { context, page, errors } = await openOffice();

    // ---- decor from the configured southern location + custom occasion ----
    await waitFor(page, 'weather', () => window.VOLifeSeasons && window.VOLifeSeasons._state().plan.weather === 'rain', 20000);
    // (the static layer is rebuilt on a later frame: waited for, not read the instant the weather is in)
    await waitFor(page, 'decor in the static layer', () => window.VOLifeSeasons._state().statics >= 1, 5000).catch(() => {});
    const dec = await page.evaluate(() => { const s = window.VOLifeSeasons._state(); return { plan: s.plan, banner: s.banner, statics: s.statics, month: window.VOLife.officeParts().month }; });
    const southern = { 12: 'summer', 1: 'summer', 2: 'summer', 3: 'autumn', 4: 'autumn', 5: 'autumn', 6: 'winter', 7: 'winter', 8: 'winter', 9: 'spring', 10: 'spring', 11: 'spring' };
    assert.equal(dec.plan.season, southern[dec.month], 'season from the southern weather location');
    assert.equal(dec.plan.umbrellas, 4, 'four present agents -> four umbrellas');
    assert.deepEqual(dec.plan.custom, [{ name: 'Launch day <b>', icon: 'balloon' }]);
    assert.equal(dec.banner.text, 'Launch day <b>');
    assert.ok(dec.statics >= 1, 'decor drawn into the static layer');
    // Idle: no static rebuilds from decor while nothing changes (> one 5 s check window).
    await page.waitForTimeout(1500);
    const b0 = await page.evaluate(() => ({ s: window.__voStats.staticBuilds, d: window.VOLifeSeasons._state().statics }));
    await page.waitForTimeout(6500);
    const b1 = await page.evaluate(() => ({ s: window.__voStats.staticBuilds, d: window.VOLifeSeasons._state().statics }));
    assert.equal(b1.d - b0.d, 0, `no idle decor redraws (${JSON.stringify([b0, b1])})`);
    assert.equal(b1.s - b0.s, 0, 'no idle static layer rebuilds');
    // A settings change (rain off) -> one rebuild that drops the umbrellas.
    await page.evaluate(() => { const s = window.VOLife.settings(); s.seasons.rain = false; window.VOLife.applySettings(s); });
    await waitFor(page, 'rain off', () => window.VOLifeSeasons._state().plan.umbrellas === 0, 8000);
    pass('decor on the page: southern hemisphere season from the weather feed, umbrellas in the rain, custom occasion banner, no idle rebuilds, settings rebuild');

    // ---- the newspaper: saved fixture paper with hostile strings ----
    await page.evaluate(d => window.VOLifePaper.open(d), YESTERDAY);
    await waitFor(page, 'paper', () => { const h = document.querySelector('.vo-paper-headline'); return h && /Alpha shipped/.test(h.textContent); }, 8000);
    const doc = await page.evaluate(() => {
        const w = document.querySelector('.vo-paper');
        const r = w.getBoundingClientRect();
        return { open: !w.hidden, title: w.querySelector('.vo-paper-title').textContent, headline: w.querySelector('.vo-paper-headline').textContent,
            subhead: w.querySelector('.vo-paper-subhead').textContent, imgs: w.querySelectorAll('img, script, b, i').length, xss: window.__xss || 0,
            cols: Array.from(w.querySelectorAll('.vo-paper-col-name')).map(e => e.textContent), stats: w.querySelector('.vo-paper-col-stats').textContent,
            mvp: w.querySelector('.vo-paper-mvp-name').textContent, notes: Array.from(w.querySelectorAll('.vo-paper-notes li')).map(e => e.textContent),
            options: Array.from(w.querySelectorAll('.vo-paper-day option')).map(o => [o.value, o.textContent, o.selected]),
            dt: Array.from(w.querySelectorAll('.vo-paper-stats dt')).map(e => e.textContent), modal: w.getAttribute('aria-modal'),
            box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], focus: w.contains(document.activeElement) };
    });
    assert.ok(doc.open && doc.modal === 'true');
    if (process.env.L8_SHOT_DIR) await page.screenshot({ path: path.join(process.env.L8_SHOT_DIR, 'paper.jpg'), type: 'jpeg', quality: 60,
        clip: { x: Math.max(0, doc.box[0]), y: Math.max(0, doc.box[1]), width: Math.min(800, doc.box[2]), height: Math.min(560, doc.box[3]) } });
    assert.equal(doc.title, 'The Daily Office');
    assert.ok(doc.headline.includes(EVIL), 'markup shown as text');
    assert.ok(doc.subhead.includes('<script>'), 'script tag shown as text');
    assert.equal(doc.imgs, 0, 'no element made from paper data');
    assert.equal(doc.xss, 0, 'nothing ran');
    assert.deepEqual(doc.cols, ['Alpha', 'Ghost <img src=x onerro…'], 'roster names and clipped unknown names as text');
    // v0.10.1 N8: a roster agent gets its pixel sprite (Studio hook), never an emoji; an unknown name gets none.
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.vo-paper-col-name')].map(h => h.querySelectorAll('canvas[data-studio-sprite]').length).join(',')), '1,0');
    assert.equal(doc.stats, '3 tasks · 5 runs · 1 handoff');
    assert.equal(doc.mvp, 'Alpha');
    assert.ok(doc.notes.some(n => /^Morning stand-up at 09:30 with 3 agents$/.test(n)), JSON.stringify(doc.notes));
    // v0.11 relux (playtest #9): a stand-up is named by its office-time hour (not "Morning" at 18:26)
    assert.deepEqual(await page.evaluate(() => [9, 13, 18, 23, 3].map(h => {
        const at = Date.now(), p = window.VOLife.officeParts(at);
        return window.VOLife.standupTitle(at + ((h - p.hour + 24) % 24) * 3600e3 - p.minute * 60e3);
    })), ['Morning stand-up', 'Afternoon stand-up', 'Evening stand-up', 'Night stand-up', 'Night stand-up']);
    assert.ok(doc.notes.includes('Ping pong champion: Beta'));
    assert.deepEqual(doc.dt, ['Busiest hour', 'Messages <i>']);
    assert.equal(doc.options.length, 2, 'archive: today + yesterday');
    assert.ok(doc.options[0][1].includes('Today') && doc.options[0][1].includes('Preview so far'));
    assert.ok(doc.options[1][2], 'the shown day is selected');
    assert.ok(doc.focus, 'focus moved into the window');
    assert.ok(doc.box[2] <= 860 && doc.box[1] >= 0, 'desktop window inside the viewport ' + doc.box);
    // Today before publish -> preview=1 (not saved).
    await page.selectOption('.vo-paper-day', TODAY);
    await waitFor(page, 'preview', () => /A quiet day at the office/.test((document.querySelector('.vo-paper-headline') || {}).textContent || ''), 8000);
    assert.ok(life.paperHits.some(s => s.includes('preview=1') && s.includes(TODAY)), 'today asked as a preview');
    assert.ok(await page.evaluate(() => /not printed yet/.test(document.querySelector('.vo-paper-note').textContent)));
    await page.keyboard.press('Escape');
    await waitFor(page, 'closed', () => document.querySelector('.vo-paper').hidden && document.querySelector('.vo-paper').getBoundingClientRect().width === 0, 4000);
    pass('newspaper window: saved fixture paper rendered as text (markup, script, names escaped), MVP, notes, stats, archive picker, today preview=1, Esc closes');

    // ---- paper.ready: prop on the front desk, one toast per day, click opens ----
    const toasts0 = await page.evaluate(() => document.querySelectorAll('.vo-toast').length);
    await page.evaluate(() => { try { localStorage.removeItem('vo-life-paper-toast'); } catch (e) {} });
    life.state.paper.ready = true;
    // (a quiet paper, news false: the prop, no toast; then one with news: one toast however often it is announced)
    await page.evaluate(d => window.VOLife._inject({ type: 'paper.ready', day: d, news: false, at: Date.now() }), TODAY);
    const quiet = await page.evaluate(() => Array.from(document.querySelectorAll('.vo-toast-text')).filter(e => e.textContent === 'The Daily Office is out').length);
    assert.equal(quiet - toasts0, 0, 'no toast for a quiet paper');
    await page.evaluate(d => window.VOLife._inject({ type: 'paper.ready', day: d, news: true, at: Date.now() }), TODAY);
    await page.evaluate(d => window.VOLife._inject({ type: 'paper.ready', day: d, news: true, at: Date.now() }), TODAY);
    const ready = await page.evaluate(() => ({ dbg: window.VOLifePaper._debug(), toasts: Array.from(document.querySelectorAll('.vo-toast-text')).map(e => e.textContent) }));
    assert.equal(ready.dbg.ready, true);
    assert.equal(ready.toasts.filter(x => x === 'The Daily Office is out').length - toasts0, 1, 'one toast per browser per day');
    const prop = await page.evaluate(() => {
        const desk = window.VOLifeHost.spots().front.item;
        const c = window.VOLifeHost.worldToCanvas(desk.x - 30, desk.y - 9);
        const r = document.getElementById('officeCanvas').getBoundingClientRect();
        document.querySelectorAll('.vo-toast').forEach(t => t.remove());
        const x = r.left + c.x, y = r.top + c.y, under = document.elementFromPoint(x, y);
        return { x, y, under: under && (under.id || under.className) };
    });
    assert.equal(prop.under, 'officeCanvas', 'the prop is on the canvas: ' + prop.under);
    await page.mouse.click(prop.x, prop.y);
    await waitFor(page, 'prop opens', () => !document.querySelector('.vo-paper').hidden && /Printed today/.test((document.querySelector('.vo-paper-headline') || {}).textContent || ''), 8000);
    await page.evaluate(() => window.VOLifePaper.close());
    pass('paper.ready: rolled newspaper on the front desk, toast once per day, clicking the prop opens today\'s saved paper');

    // ---- replay: enter, seek, exit without moving live state ----
    const live0 = await page.evaluate(() => window.agents.map(a => ({ k: a.statusKey, s: a._statusState, st: a.state, task: a.task, desk: a.desk && [a.desk.x, a.desk.y], m: a.meetingId || null })));
    const writes0 = life.writes.length;
    await page.evaluate(d => window.VOLifePaper.replay(d), YESTERDAY);
    await waitFor(page, 'replay loaded', () => { const d = window.VOLifePaper._debug().replay; return d && d.loaded && d.keys.length === 4; }, 8000);
    const bar = await page.evaluate(() => {
        const b = document.querySelector('.vo-life-replay'), c = document.querySelector('.vo-life-rclock'), m = document.querySelector('.vo-mapctl');
        const rb = b.getBoundingClientRect(), rm = m && m.getBoundingClientRect();
        return { bar: !!b, clock: c && c.textContent, overlap: !!(rm && rb.left < rm.right && rb.right > rm.left && rb.top < rm.bottom && rb.bottom > rm.top),
            obstacle: b.hasAttribute('data-vo-canvas-obstacle'), first: window.VOLifePaper._debug().replay.t };
    });
    assert.ok(bar.bar && /^Replaying 08:00$/.test(bar.clock), 'bar + clock at the first recorded moment: ' + bar.clock);
    assert.ok(!bar.overlap && bar.obstacle, 'replay bar clear of the map controls, labels keep out of it');
    await page.evaluate(t => window.VOLifePaper._seek(t), at(10, 15));
    const mid = await page.evaluate(() => {
        const d = window.VOLifePaper._debug().replay, f = window.VOLifeHost.spots().frontQueue(1)[0];
        const A = k => window.agents.find(a => a.statusKey === k);
        return { shown: d.shown, delta: [Math.round(A('delta').x), Math.round(A('delta').y), A('delta')._lifePose], front: [f.x, f.y],
            gammaAlpha: A('gamma')._lifeAlpha, held: window.agents.every(a => a._lifeHold && a._lifeHold.kind === 'replay'), clock: document.querySelector('.vo-life-rclock').textContent };
    });
    assert.equal(mid.shown.alpha.state, 'working');
    assert.equal(mid.shown.gamma.state, 'offline');
    assert.ok(mid.shown.gamma.zzz && mid.gammaAlpha < 1, 'offline: dimmed with Zz');
    assert.equal(mid.shown.delta.need, 'approval');
    assert.deepEqual(mid.delta.slice(0, 2), mid.front, 'open need -> front spot');
    assert.equal(mid.delta[2], 'sign');
    assert.ok(mid.held, 'every agent held by the replay script');
    assert.equal(mid.clock, 'Replaying 10:15');
    if (process.env.L8_SHOT_DIR) {
        const cr = await page.evaluate(() => { const r = document.querySelector('.game-wrapper').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(process.env.L8_SHOT_DIR, 'replay.jpg'), type: 'jpeg', quality: 60,
            clip: { x: cr[0] + Math.max(0, cr[2] / 2 - 400), y: cr[1] + Math.max(0, cr[3] - 520), width: Math.min(800, cr[2]), height: Math.min(520, cr[3]) } });
    }
    // Play a little at 300x: events in range pop, the clock moves.
    await page.evaluate(t => window.VOLifePaper._seek(t), at(9, 59));
    await page.click('.vo-life-rsp[data-speed="300"]');
    await page.click('.vo-life-rplay');
    await waitFor(page, 'played', () => window.VOLifePaper._debug().replay.t > Date.parse(new Date().toISOString().slice(0, 10)) - 86400000 + 10 * 3600000 + 3 * 60000, 8000);
    assert.ok((await page.evaluate(() => window.VOLifePaper._debug().replay.pops)) >= 1, 'events of the passing minutes pop');
    await page.click('.vo-life-rplay');
    // Exit with Escape from the bar.
    await page.focus('.vo-life-rslider');
    await page.keyboard.press('Escape');
    await waitFor(page, 'exit', () => !window.VOLifePaper.replaying() && !document.querySelector('.vo-life-replay'), 4000);
    await waitFor(page, 'back', () => window.agents.every(a => !a._lifeHold && !a._lifePose && a._lifeAlpha == null), 4000);
    const live1 = await page.evaluate(() => window.agents.map(a => ({ k: a.statusKey, s: a._statusState, st: a.state, task: a.task, desk: a.desk && [a.desk.x, a.desk.y], m: a.meetingId || null })));
    assert.deepEqual(live1, live0, 'live state (status, state, task, desk, meeting) unchanged');
    assert.equal(life.writes.length, writes0, 'replay wrote nothing');
    assert.deepEqual(await page.evaluate(() => window.VOLife._debug().running), [], 'no script left');
    await waitFor(page, 'home', () => window.agents.every(a => Math.abs(a.x - a.desk.x) < 3 && Math.abs(a.y - a.desk.y) < 3), 15000);
    pass('replay: bar + clock, journal state placed (working desk, offline dim Zz, open need at the front with the sign), 300x play pops events, Esc exits, live state and writes untouched, agents back at their desks');

    // ---- calm + reduced motion: replay still works without planes; decor stays ----
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(d => window.VOLifePaper.replay(d), YESTERDAY);
    await waitFor(page, 'replay rm', () => { const d = window.VOLifePaper._debug().replay; return d && d.loaded; }, 8000);
    await page.evaluate(t => window.VOLifePaper._seek(t), at(10, 0));
    await page.evaluate(() => window.VOLifePaper._step(5 * 60000));
    assert.equal(await page.evaluate(() => window.planesInFlight ? window.planesInFlight() : window.VOLifeHost.planesInFlight()), 0, 'no planes in reduced motion');
    await page.evaluate(() => window.VOLifePaper.exitReplay());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.deepEqual(errors, [], 'no page errors: ' + errors.join(' | '));
    pass('reduced motion: replay places agents with no planes; no page errors on desktop');
    await context.close();

    // ---- phone ----
    {
        const ph = await openOffice({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await ph.page.evaluate(d => window.VOLifePaper.open(d), YESTERDAY);
        await waitFor(ph.page, 'phone paper', () => { const h = document.querySelector('.vo-paper-headline'); return h && /Alpha shipped/.test(h.textContent); }, 8000);
        const pw = await ph.page.evaluate(() => {
            const r = document.querySelector('.vo-paper').getBoundingClientRect(), c = document.querySelector('.vo-paper-close').getBoundingClientRect();
            const cols = getComputedStyle(document.querySelector('.vo-paper-cols')).gridTemplateColumns.split(' ').length;
            return { r: [r.left, r.top, r.width, r.height], close: [c.width, c.height], cols, sw: document.documentElement.scrollWidth };
        });
        assert.deepEqual(pw.r.map(Math.round), [0, 0, 412, 915], 'full-screen sheet on phones');
        assert.ok(pw.close[0] >= 40 && pw.close[1] >= 40, 'close button 40 px+');
        assert.equal(pw.cols, 1, 'one column on phones');
        assert.ok(pw.sw <= 412, 'no sideways scroll');
        await ph.page.evaluate(() => window.VOLifePaper.close());
        await ph.page.evaluate(d => window.VOLifePaper.replay(d), YESTERDAY);
        await waitFor(ph.page, 'phone replay', () => { const d = window.VOLifePaper._debug().replay; return d && d.loaded; }, 8000);
        const pb = await ph.page.evaluate(() => {
            const b = document.querySelector('.vo-life-replay').getBoundingClientRect();
            const m = document.querySelector('.vo-mapctl').getBoundingClientRect();
            const bar = document.querySelector('.vo-actionbar, .vo-action-bar, [data-vo-actionbar]');
            const ab = bar ? bar.getBoundingClientRect() : null;
            const btns = Array.from(document.querySelectorAll('.vo-life-replay button')).map(x => { const r = x.getBoundingClientRect(); return Math.min(r.width, r.height); });
            return { b: [b.left, b.top, b.right, b.bottom], m: [m.left, m.top, m.right, m.bottom], ab: ab && [ab.top, ab.height], minBtn: Math.min.apply(null, btns), vw: innerWidth };
        });
        assert.ok(pb.b[0] >= 0 && pb.b[2] <= pb.vw, 'bar inside the screen');
        assert.ok(pb.b[2] <= pb.m[0] || pb.b[3] <= pb.m[1] || pb.b[1] >= pb.m[3], 'bar clear of the map controls ' + JSON.stringify(pb));
        if (pb.ab && pb.ab[1] > 0) assert.ok(pb.b[3] <= pb.ab[0] + 1, 'bar above the action bar');
        assert.ok(pb.minBtn >= 44, 'touch targets 44 px');
        await ph.page.evaluate(() => window.VOLifePaper.exitReplay());
        assert.deepEqual(ph.errors, [], 'no page errors on the phone: ' + ph.errors.join(' | '));
        pass('phone 412x915: newspaper is a full-screen one-column sheet, replay bar above the action bar and clear of the map controls, 44 px buttons');
        await ph.context.close();
    }
} finally {
    await browser.close();
}
console.log(`OK test_life_decor_paper: ${results.length} passed`);
