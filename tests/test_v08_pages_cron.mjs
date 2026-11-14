// Cron Manager page (CH-02 cron, CH-32, CH-33, DL-04 client, C6): run with
//   node tests/test_v08_pages_cron.mjs
// Skips when chrome, playwright-core or the running office (VO_BASE_URL, default :8095) is missing.
// The gateway is mocked; every unmocked write is aborted by the harness guard.
import { launchOrSkip, guardedPage, json, check, finish, shot, SIZES, BASE } from './test_v08_pages_lib.mjs';

const NOW = Date.now();
const JOBS = () => [
  {
    id: 'job-simple', name: 'Morning <b>brief</b>', agentId: 'adler', enabled: true, sessionTarget: 'isolated', wakeMode: 'now',
    schedule: { kind: 'cron', expr: '30 8 * * 1-5', tz: 'America/New_York', staggerMs: 0 },
    payload: { kind: 'agentTurn', message: 'Summarize the inbox', timeoutSeconds: 300, model: 'x/y', thinking: 'low' },
    delivery: { mode: 'announce', channel: 'telegram', to: '123', bestEffort: true },
    state: { lastStatus: 'ok', nextRunAtMs: NOW + 3600e3, lastRunAtMs: NOW - 7200e3, lastDurationMs: 12000 },
  },
  {
    id: 'job-multi', name: '"><img src=x onerror="window.__xss=1">', agentId: 'ghost-agent', enabled: true, sessionTarget: 'main', wakeMode: 'now',
    schedule: { kind: 'cron', expr: '0 8,10,12,14,16,18 * * *' },
    payload: { kind: 'systemEvent', text: "' onmouseover='window.__xss=2" },
    state: { lastStatus: 'x" autofocus onfocus="window.__xss=3', lastError: '"><svg onload=window.__xss=4>' },
  },
  {
    id: "a'b\"c<x>", name: 'Backup command', enabled: false, sessionTarget: 'isolated',
    schedule: { kind: 'every', everyMs: 3600000 }, payload: { kind: 'command', command: 'echo hi' }, state: {},
  },
  {
    id: 'job-stream', name: 'Build stream', enabled: true, sessionTarget: 'isolated',
    schedule: { kind: 'stream', command: ['node', 'x.mjs'] }, payload: { kind: 'agentTurn', message: 'Look' }, state: {},
  },
  {
    id: 'job-at', name: 'One shot', agentId: 'adler', enabled: true, sessionTarget: 'isolated', wakeMode: 'now',
    schedule: { kind: 'at', at: '2026-11-02T03:30:00.000Z' }, payload: { kind: 'agentTurn', message: 'Remind me' }, state: {},
  },
];

function licensed() { return { path: '/api/license', handle: (r) => json(r, { licensed: true, demo: false, tier: 'FULL', tierName: 'Full License', limits: null }) }; }
function demo() { return { path: '/api/license', handle: (r) => json(r, { licensed: false, demo: true, limits: { cronManager: false } }) }; }
const agentsMock = { path: '/api/agents', handle: (r) => json(r, { agents: [
  { id: 'adler', statusKey: 'adler', name: 'Adler', emoji: '🧍', role: 'Explorer', providerKind: 'openclaw', providerAgentId: 'adler' },
  { id: 'hermes-astra', statusKey: 'hermes-astra', name: 'Astra', emoji: '⚕️', providerKind: 'hermes', providerAgentId: 'astra' },
  { id: 'codex-main', statusKey: 'codex-main', name: 'Main', providerKind: 'codex' },
] }) };
const eventsMock = { path: '/api/openclaw/events', handle: (r) => r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"proxy.ready","payload":{}}\n\n' }) };

function rpcMock(store, opts = {}) {
  return {
    method: 'POST', path: '/api/openclaw/rpc',
    handle: (route, req, url, body) => {
      const m = body && body.method; const p = (body && body.params) || {};
      if (opts.fail) return json(route, { ok: false, error: { message: "Gateway method 'cron.list' is not allowed by the chat proxy", code: 'method_not_allowed' } }, 403);
      if (m === 'cron.list') return json(route, { ok: true, payload: { jobs: store.jobs } });
      if (m === 'channels.status') return json(route, { ok: true, payload: { channels: { telegram: { configured: true }, discord: { configured: true } }, channelOrder: ['telegram', 'discord'], channelLabels: { telegram: 'Telegram', discord: 'Discord' }, channelAccounts: {} } });
      if (m === 'cron.update') {
        store.updates.push(p);
        const job = store.jobs.find((j) => j.id === p.id);
        const merged = JSON.parse(JSON.stringify(job));
        for (const [k, v] of Object.entries(p.patch || {})) {
          if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') merged[k] = Object.assign({}, merged[k], v);
          else merged[k] = v;
        }
        store.saved = merged;
        return json(route, { ok: true, payload: merged });
      }
      if (m === 'cron.get') return json(route, { ok: true, payload: store.saved || store.jobs.find((j) => j.id === p.id) });
      if (m === 'cron.add') { store.adds.push(p); store.saved = Object.assign({ id: 'new-1' }, p); return json(route, { ok: true, payload: store.saved }); }
      return json(route, { ok: false, error: { message: 'unexpected ' + m } }, 500);
    },
  };
}

const results = [];
const browser = await launchOrSkip('cron');
if (browser) {
  try {
    // 1. Licensed, mocked gateway, XSS fixtures, both sizes and themes.
    for (const size of SIZES) {
      for (const theme of ['dark', 'light']) {
        const store = { jobs: JOBS(), updates: [], adds: [], saved: null };
        const { page, context, blocked, errors } = await guardedPage(browser, { viewport: size.viewport, theme, timezoneId: 'America/New_York', mocks: [licensed(), agentsMock, eventsMock, rpcMock(store)] });
        await page.goto(BASE + '/cron.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.job-card', { timeout: 15000 });
        await page.waitForTimeout(400);
        const tag = `${size.tag}-${theme}`;
        await shot(page, `cron-list-${tag}.png`);
        if (size.tag === 'd' && theme === 'dark') {
          check(results, await page.evaluate(() => window.__xss === undefined), 'no injected script ran from job fields');
          check(results, (await page.locator('.job-card').count()) === 4, 'disabled job hidden by default (4 cards)');
          check(results, (await page.locator('img[src="x"], svg[onload]').count()) === 0, 'no injected elements');
          check(results, (await page.locator('[onclick]').count()) === 0, 'no inline onclick handlers on the page');
          const agentOpts = await page.$$eval('#f-agent option', (o) => o.map((x) => x.value));
          check(results, agentOpts.includes('adler') && !agentOpts.includes('astra') && !agentOpts.includes('hermes-astra') && !agentOpts.includes('codex-main'), 'only OpenClaw agents offered as targets');
          check(results, (await page.textContent('#ws-status')).includes('Connected'), 'status pill shows Connected');

          // Edit simple job: change only the name.
          await page.click('.job-card[data-job-id="job-simple"] [data-action="edit"]');
          await page.waitForSelector('#modal.open');
          check(results, await page.$eval('#f-cron-expr', (e) => e.value) === '30 8 * * 1-5', 'raw expression shown');
          check(results, await page.$eval('#cron-picker', (e) => !e.hidden), 'picker shown for a simple expression');
          const days = await page.$$eval('.day-cb:checked', (o) => o.map((x) => x.value).sort().join(','));
          check(results, days === '1,2,3,4,5', 'weekday range expanded into day chips');
          await shot(page, `cron-edit-${tag}.png`);
          await page.fill('#f-name', 'Morning brief v2');
          await page.click('#modal-save');
          await page.waitForFunction(() => !document.getElementById('modal').classList.contains('open'), null, { timeout: 5000 });
          const u = store.updates[0];
          check(results, u && u.id === 'job-simple' && JSON.stringify(u.patch) === JSON.stringify({ name: 'Morning brief v2' }), 'edit sends only the changed field: ' + JSON.stringify(u && u.patch));

          // Multi-hour expression keeps its schedule, picker hidden.
          store.saved = null;
          await page.click('.job-card[data-job-id="job-multi"] [data-action="edit"]');
          await page.waitForSelector('#modal.open');
          check(results, await page.$eval('#f-cron-expr', (e) => e.value) === '0 8,10,12,14,16,18 * * *', 'multi-hour expression kept verbatim');
          check(results, await page.$eval('#cron-picker', (e) => e.hidden) && await page.$eval('#cron-picker-note', (e) => !e.hidden), 'picker hidden with an explanation');
          const unknownAgent = await page.$eval('#f-agent', (e) => e.value);
          check(results, unknownAgent === 'ghost-agent', 'unknown agent id kept as (current)');
          await page.fill('#f-message', 'New reminder text');
          await page.click('#modal-save');
          await page.waitForFunction(() => !document.getElementById('modal').classList.contains('open'), null, { timeout: 5000 });
          const u2 = store.updates[1];
          check(results, u2 && JSON.stringify(u2.patch) === JSON.stringify({ payload: { kind: 'systemEvent', text: 'New reminder text' } }), 'message-only edit leaves schedule/agent alone: ' + JSON.stringify(u2 && u2.patch));

          // One-shot shows the LOCAL date (UTC is the next day).
          await page.click('.job-card[data-job-id="job-at"] [data-action="edit"]');
          await page.waitForSelector('#modal.open');
          check(results, await page.$eval('#f-at-date', (e) => e.value) === '2026-11-01' && await page.$eval('#f-at-time', (e) => e.value) === '22:30', 'one-shot date/time in local time');
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => !document.getElementById('modal').classList.contains('open'), null, { timeout: 3000 });
          check(results, true, 'Escape closes the editor');

          // Unknown schedule kind opens read-only.
          await page.click('.job-card[data-job-id="job-stream"] [data-action="edit"]');
          await page.waitForSelector('#modal.open');
          check(results, await page.$eval('#modal-readonly-note', (e) => !e.hidden) && await page.$eval('#modal-save', (e) => e.hidden) && await page.$eval('#job-form', (e) => e.disabled), 'unknown schedule kind is view-only');
          await shot(page, `cron-readonly-${tag}.png`);
          await page.click('#modal-cancel');

          // Disabled command job appears with the filter and stays view-only.
          await page.check('#filter-disabled');
          check(results, (await page.locator('.job-card').count()) === 5, 'Show Disabled reveals the disabled job');
          check(results, await page.evaluate(() => window.__xss === undefined), 'still no injected script after re-render');

          // New job: the form needs a day; picked days build the expression; payload has no timeout when blank.
          await page.click('#btn-new-job');
          await page.fill('#f-name', 'Test new');
          await page.fill('#f-message', 'Hello');
          await page.selectOption('#f-agent', 'adler');
          await page.click('.day-preset[data-days="weekdays"]');
          await page.fill('#f-cron-time', '07:15');
          check(results, await page.$eval('#f-cron-expr', (e) => e.value) === '15 7 * * 1,2,3,4,5', 'picker fills the expression');
          await page.click('#modal-save');
          await page.waitForFunction(() => !document.getElementById('modal').classList.contains('open'), null, { timeout: 5000 });
          const add = store.adds[0];
          check(results, add && add.schedule.expr === '15 7 * * 1,2,3,4,5' && add.agentId === 'adler' && !('timeoutSeconds' in add.payload), 'create sends picked schedule, no forced timeout');
          check(results, blocked.length === 0, 'no unmocked writes: ' + blocked.join(', '));
          check(results, errors.filter((e) => !/vo-auth\.js|404/.test(e)).length === 0, 'no page errors: ' + errors.join(' | '));
        } else {
          await page.click('.job-card[data-job-id="job-simple"] [data-action="edit"]');
          await page.waitForSelector('#modal.open');
          await shot(page, `cron-edit-${tag}.png`);
        }
        await context.close();
      }
    }

    // 2. Demo license: locked card, no gateway calls.
    for (const size of SIZES) {
      const store = { jobs: JOBS(), updates: [], adds: [] };
      const { page, context, calls } = await guardedPage(browser, { viewport: size.viewport, mocks: [demo(), agentsMock, eventsMock, rpcMock(store)] });
      await page.goto(BASE + '/cron.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.vo-state-card.is-locked', { timeout: 10000 });
      await shot(page, `cron-locked-${size.tag}-dark.png`);
      if (size.tag === 'd') {
        check(results, !calls.some((c) => c.path === '/api/openclaw/rpc'), 'demo: no gateway requests');
        check(results, await page.$eval('#btn-new-job', (e) => e.disabled), 'demo: New Job disabled');
      }
      await context.close();
    }

    // 3. Server refuses cron (backend allowlist missing): readable error with Retry that recovers.
    {
      const store = { jobs: JOBS(), updates: [], adds: [] };
      const mock = rpcMock(store, { fail: true });
      const { page, context } = await guardedPage(browser, { mocks: [licensed(), agentsMock, eventsMock, { method: 'POST', path: '/api/openclaw/rpc', handle: (...a) => mock.handle(...a) }] });
      await page.goto(BASE + '/cron.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.vo-state-card.is-error', { timeout: 10000 });
      await shot(page, 'cron-error-d-dark.png');
      check(results, /not available through this office server/i.test(await page.textContent('.vo-state-card')), 'refused method shows a plain explanation');
      delete mock.handle; Object.assign(mock, rpcMock(store));
      await page.click('[data-action="retry"]');
      await page.waitForSelector('.job-card', { timeout: 10000 });
      check(results, true, 'Retry recovers once the server allows cron');
      await context.close();
    }

    // 4. The real 8095 server (read only): page must end in a clear state, never "Loading jobs..." forever.
    {
      const READ = new Set(['cron.list', 'cron.get', 'cron.status', 'cron.runs', 'channels.status']);
      const readOnlyRpc = { method: 'POST', path: '/api/openclaw/rpc', handle: (route, req, url, body) => (READ.has(body && body.method) ? route.continue() : route.abort()) };
      const { page, context, blocked } = await guardedPage(browser, { mocks: [readOnlyRpc] });
      await page.goto(BASE + '/cron.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.vo-state-card, .job-card', { timeout: 20000 });
      await shot(page, 'cron-real-d-dark.png');
      const text = await page.textContent('#jobs-container');
      check(results, !/Loading jobs/.test(text), 'real server: page reaches a final state (' + text.trim().slice(0, 60).replace(/\s+/g, ' ') + ')');
      check(results, blocked.length === 0, 'real server: no writes attempted ' + blocked.join(', '));
      await context.close();
    }
  } finally {
    await browser.close();
  }
  finish('cron', results);
}
