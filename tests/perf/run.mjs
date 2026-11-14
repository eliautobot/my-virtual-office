#!/usr/bin/env node
// Virtual Office perf harness: one command, one short table, one JSON result.
//   node tests/perf/run.mjs --app <app folder> [--label name] [--minutes 10] [--quick] [--out file.json]
//        [--fixtures dir] [--capture http://host:port] [--no-server] [--no-client] [--no-long] [--views desktop,phone,phone26,phone3]
// The browser half runs ANY app/ folder against a loopback fixture office (tests/perf/office-server.mjs: 27 agents,
// live-like /status + chat, Office Life on, SSE); the server half starts that tree's server.py on a private port with a
// throwaway HOME (tests/perf/server-bench.mjs). --capture saves the office layout + Office Life state of a running
// office with read-only GETs into --fixtures (default: a temp folder), so a real layout can be replayed.
// Memory rule: one Chrome at a time, closed in a finally; one private server, stopped in a finally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright, findChrome, openOffice, sampleCpu, frameTimes, profile, domNodes, heapMB, VIEWS, r2 } from './client.mjs';
import { buildOffice, loadFixtures, startOfficeServer } from './office-server.mjs';
import { startPrivateServer, benchEndpoints, idleCpu, pollMix, get } from './server-bench.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const APP = path.resolve(String(opt('app', path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../app'))));
const QUICK = !!opt('quick', false);
const MINUTES = Number(opt('minutes', QUICK ? 1 : 10));
const LABEL = String(opt('label', path.basename(path.dirname(APP))));
const FIXTURES = String(opt('fixtures', path.join(os.tmpdir(), 'vo-perf-fixtures')));
const OUT = String(opt('out', path.join(os.tmpdir(), 'vo-perf-results', `${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)));
const SECS = QUICK ? 5 : 10;
const FIX_PORT = Number(opt('fixture-port', 19460));
const SRV_PORT = Number(opt('server-port', 18460));
const GW_CTL = Number(opt('gw-ctl', 18462));
const log = (...a) => { if (!opt('silent', false)) console.error('[perf]', ...a); };
if (!fs.existsSync(path.join(APP, 'index.html')) || !fs.existsSync(path.join(APP, 'game.js'))) {
  console.error('not an app folder: ' + APP); process.exit(2);
}

async function capture(from) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  for (const [p, f] of [['/api/office-config', 'office_config'], ['/api/office-life/state', 'office_life_state']]) {
    const r = await fetch(from.replace(/\/$/, '') + p, { method: 'GET', signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`capture ${p}: ${r.status}`);
    fs.writeFileSync(path.join(FIXTURES, f + '.json'), Buffer.from(await r.arrayBuffer()));
  }
  log('captured layout + Office Life state from', from, 'into', FIXTURES);
}

function perMinute(reqs, t0, t1) {
  const mins = (t1 - t0) / 60000; const by = {};
  for (const q of reqs) {
    if (q.t < t0 || q.t > t1 || q.kind === 'static') continue;
    const b = by[q.p] = by[q.p] || { n: 0, bytes: 0, n304: 0 };
    b.n++; b.bytes += q.bytes || 0; if (q.status === 304) b.n304++;
  }
  const rows = Object.entries(by).map(([p, b]) => ({ path: p, perMin: r2(b.n / mins), kbPerMin: r2(b.bytes / 1024 / mins), share304: r2(b.n304 / b.n) }))
    .sort((a, b) => b.kbPerMin - a.kbPerMin);
  return { rows, totalPerMin: r2(rows.reduce((s, r) => s + r.perMin, 0)), totalKbPerMin: r2(rows.reduce((s, r) => s + r.kbPerMin, 0)) };
}

// wait until the agents reached their seats and the scene stopped animating (max 30 s)
async function settle(page) {
  return page.evaluate(async () => {
    const t0 = performance.now(); let calm = 0;
    while (performance.now() - t0 < 30000) {
      calm = (typeof _sceneIsBusy === 'function' && !_sceneIsBusy()) ? calm + 1 : 0;
      if (calm >= 8) break;
      await new Promise(r => setTimeout(r, 250));
    }
    return Math.round(performance.now() - t0);
  });
}

async function clientRuns(result) {
  const office = buildOffice(APP, loadFixtures(FIXTURES), 27);
  const fx = await startOfficeServer({ appDir: APP, office, port: FIX_PORT });
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
  try {
    for (const view of String(opt('views', 'desktop,phone')).split(',')) {
      fx.setMode('idle');
      const l0 = Date.now();
      const o = await openOffice(browser, fx.url, view);
      try {
        const loadReq = fx.stats.requests.filter(q => q.t >= l0);
        const v = { load: Object.assign(o.load, { requests: loadReq.length, kb: r2(loadReq.reduce((s, q) => s + q.bytes, 0) / 1024) }) };
        v.settleMs = await settle(o.page);
        v.idle = await sampleCpu(o.page, o.cdp, SECS);
        v.idleFrame = await frameTimes(o.page, 4, { full: true });
        await o.page.evaluate(() => window.__perfHide(true));
        await o.page.waitForTimeout(1000);
        v.hidden = await sampleCpu(o.page, o.cdp, SECS);
        await o.page.evaluate(() => window.__perfHide(false));
        fx.setMode('busy');
        await o.page.waitForTimeout(6000);
        v.busy = await sampleCpu(o.page, o.cdp, SECS);
        v.busyFrame = await frameTimes(o.page, 4, { full: true });
        await o.page.evaluate(() => { window.__perfSaved = window._shouldDrawFrame; window._shouldDrawFrame = () => true; });
        v.profile = await profile(o.page, o.cdp, 4);
        await o.page.evaluate(() => { window._shouldDrawFrame = window.__perfSaved; });
        v.dom = await domNodes(o.page);
        v.errors = o.errors.slice(0, 5);
        result.client[view] = v;
        log(view, 'load', Math.round(v.load.interactive), 'ms; idle cpu', v.idle.cpuPct + '%; busy p95', r2(v.busyFrame.p95), 'ms');
      } finally { await o.context.close(); }
    }
    if (!opt('no-long', false)) {
      fx.setMode('busy');
      const o = await openOffice(browser, fx.url, 'desktop');
      try {
        await o.page.waitForTimeout(3000);
        const h0 = await heapMB(o.cdp); const d0 = await domNodes(o.page); const t0 = Date.now();
        log('long run', MINUTES, 'min (busy office, desktop)');
        const step = 30000; let done = 0;
        while (done < MINUTES * 60000) { await o.page.waitForTimeout(Math.min(step, MINUTES * 60000 - done)); done += step; }
        const t1 = Date.now();
        const h1 = await heapMB(o.cdp); const d1 = await domNodes(o.page);
        const s = await sampleCpu(o.page, o.cdp, SECS);
        result.client.long = { minutes: MINUTES, heapStartMB: h0, heapEndMB: h1, heapGrowthMB: r2(h1 - h0), domStart: d0, domEnd: d1,
          cpuAfterPct: s.cpuPct, net: perMinute(fx.stats.requests, t0, t1), refusedWrites: fx.stats.refused.length, errors: o.errors.slice(0, 5) };
      } finally { await o.context.close(); }
    }
  } finally {
    await browser.close();
    await fx.close();
  }
}

async function serverRuns(result) {
  const srv = await startPrivateServer({ appDir: APP, port: SRV_PORT, gwCtl: GW_CTL, root: path.join(os.tmpdir(), 'vo-perf-srv-' + SRV_PORT), log });
  try {
    await new Promise(r => setTimeout(r, QUICK ? 5000 : 10000));      // let the startup scans finish
    for (const p of ['/status', '/agent-chat?limit=20&lite=1', '/api/agents']) await get(srv.url + p).catch(() => 0);
    const idle = await idleCpu(srv, QUICK ? 10 : 30);
    const endpoints = await benchEndpoints(srv, { n: QUICK ? 8 : 15, idleCpuPerSec: idle.cpuMsPerSec / 1000 });
    // the steady browser mix: measured per-minute rates when available, else the v0.9 cadences
    const three = encodeURIComponent(srv.ids.slice(0, 3).join(','));
    const net = (result.client.long && result.client.long.net.rows) || [];
    const rate = (p, d) => { const r = net.find(x => x.path === p); return r ? r.perMin : d; };
    const mix = {
      '/status': rate('/status', 12), [`/agent-chat?agents=${three}&limit=20&lite=1`]: rate('/agent-chat', 20),
      '/api/previews?after=0': rate('/api/previews', 27), '/api/meetings/active': rate('/api/meetings/active', 7),
      '/api/agents': rate('/api/agents', 3), [`/api/agent-chat/tasks?agent=${srv.ids[0]}&session=agent%3A${srv.ids[0]}%3Amain&scope=chat`]: rate('/api/agent-chat/tasks', 3),
    };
    const poll = await pollMix(srv, mix, QUICK ? 15 : 30);
    result.server = { idle, endpoints, poll, mix };
  } finally { await srv.stop(); }
}

function table(res) {
  const c = res.client;
  const f = (x, k = 1) => (x === undefined || x === null || Number.isNaN(x)) ? '-' : String(Math.round(x * k) / k);
  const row = (name, ...cols) => console.log(name.padEnd(34) + cols.map((x, i) => i < cols.length - 1 ? String(x).padEnd(22) : String(x)).join(''));
  console.log(`\n${res.label}  (${res.app})`);
  const views = Object.keys(c).filter(k => VIEWS[k] && c[k].load);
  const head = k => { const v = VIEWS[k]; return `${k} ${v.width}x${v.height}@${v.dpr}${v.throttle > 1 ? ' cpu/' + v.throttle : ''}`; };
  const all = (fn) => views.map(k => fn(c[k]));
  if (views.length) {
  row('metric', ...views.map(head));
  row('load FCP / interactive ms', ...all(v => `${f(v.load.fcp)} / ${f(v.load.interactive)}`));
  row('load TBT ms / long tasks / KB', ...all(v => `${f(v.load.tbt)} / ${v.load.longTasks} / ${f(v.load.kb)}`));
  row('frame idle p50/p95 ms', ...all(v => `${f(v.idleFrame.p50, 100)} / ${f(v.idleFrame.p95, 100)}`));
  row('frame busy p50/p95 ms', ...all(v => `${f(v.busyFrame.p50, 100)} / ${f(v.busyFrame.p95, 100)}`));
  row('cpu idle visible % (fps)', ...all(v => `${v.idle.cpuPct} (${v.idle.fps})`));
  row('cpu idle hidden %', ...all(v => `${v.hidden.cpuPct}`));
  row('cpu busy % (fps) / long tasks', ...all(v => `${v.busy.cpuPct} (${v.busy.fps}) / ${v.busy.longTasks}`));
  row('DOM nodes', ...all(v => v.dom));
  }
  if (c.long) {
    row(`heap MB start/after ${c.long.minutes} min`, `${c.long.heapStartMB} / ${c.long.heapEndMB}`, `dom ${c.long.domStart} -> ${c.long.domEnd}`);
    row('requests/min, KB/min (busy)', `${c.long.net.totalPerMin}, ${c.long.net.totalKbPerMin}`,
      c.long.net.rows.slice(0, 3).map(r => `${r.path} ${r.perMin}/${r.kbPerMin}`).join('  '));
  }
  if (res.server) {
    const s = res.server;
    row('server idle cpu % / RSS MB', `${s.idle.cpuPct} / ${s.idle.rssMB}`, `1 client poll mix: ${s.poll.cpuPct} %`);
    for (const e of s.endpoints.filter(e => !e.error).sort((a, b) => b.p50 - a.p50).slice(0, 6)) {
      row('  ' + e.path.slice(0, 30), `${e.p50} ms p50 ${e.cpuMs} cpu`, `${Math.round(e.raw / 1024)}K raw ${e.gz === null ? 'no gz' : Math.round(e.gz / 1024) + 'K gz'} 304:${e.revalidate === 304 ? 'yes' : 'no'}`);
    }
  }
  const errs = [].concat(...Object.keys(c).filter(k => VIEWS[k]).map(k => c[k].errors || []));
  if (errs.length) console.log('page errors: ' + errs.slice(0, 3).join(' | '));
}

const result = { label: LABEL, app: APP, at: new Date().toISOString(), quick: QUICK, client: {}, server: null };
try {
  if (opt('capture', false)) await capture(String(opt('capture')));
  if (!opt('no-client', false)) await clientRuns(result);
  if (!opt('no-server', false)) await serverRuns(result);
} finally {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
}
table(result);
console.log('saved ' + OUT);
