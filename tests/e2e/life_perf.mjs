// Office life perf gate (L10): one idle desktop page (1600x900) on the PRIVATE office, Office life ON vs OFF in
// alternating blocks (LIFE_PERF_BLOCK_S, default 150 s; LIFE_PERF_ROUNDS, default 4 => 10 min each). Per block: page
// main-thread CPU (CDP TaskDuration), draws/s and main-thread ms per draw, rAF frame interval p50/p95, the private
// server's CPU (LIFE_SERVER_PID, /proc), and every request path. Gate: ON within 5 % of OFF for page CPU and ms per
// draw, and no request path repeating periodically in ON that OFF does not have (the stream is one long request; its
// heartbeat is bytes on it, not new requests).
//   node tests/e2e/life_perf.mjs   (no other activity on the private office while it runs)
import fs from 'node:fs';
import { VO, check, sleep, api, launch, openOffice, summary } from './life_lib.mjs';

const BLOCK = Number(process.env.LIFE_PERF_BLOCK_S || 150) * 1000;
const ROUNDS = Number(process.env.LIFE_PERF_ROUNDS || 4);
const SETTLE = 10000;
const PID = process.env.LIFE_SERVER_PID || '';
const serverCpu = () => { try { const f = fs.readFileSync(`/proc/${PID}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / 100; } catch (_) { return null; } };

const { browser, page, errors } = await launch({ width: 1600, height: 900 });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const reqs = [];
page.on('request', r => { const u = new URL(r.url()); reqs.push({ t: Date.now(), path: u.pathname }); });
const metric = async () => { const m = (await cdp.send('Performance.getMetrics')).metrics; const g = n => (m.find(x => x.name === n) || {}).value || 0; return { task: g('TaskDuration'), script: g('ScriptDuration') }; };

async function block(on, n) {
  await api('/api/office-life/settings', { enabled: on });
  await page.waitForFunction(want => window.VOLife && window.VOLife.isOn() === want, on, { timeout: 15000 }).catch(() => {});
  await sleep(SETTLE);
  await page.evaluate(() => { window.__iv = []; let last = performance.now(); const tick = t => { window.__iv.push(t - last); last = t; if (window.__iv.length < 200000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  const t0 = Date.now(), m0 = await metric(), d0 = await page.evaluate(() => window.__voStats.draws), s0 = serverCpu(), r0 = reqs.length;
  await sleep(BLOCK);
  const t1 = Date.now(), m1 = await metric(), d1 = await page.evaluate(() => window.__voStats.draws), s1 = serverCpu();
  const iv = await page.evaluate(() => { const a = window.__iv.slice(1).sort((x, y) => x - y); window.__iv = []; return { p50: a[Math.floor(a.length * 0.5)], p95: a[Math.floor(a.length * 0.95)], n: a.length }; });
  const wall = (t1 - t0) / 1000, draws = d1 - d0;
  const out = { on, n, cpu: (m1.task - m0.task) / wall, script: (m1.script - m0.script) / wall, dps: draws / wall,
    msPerDraw: draws ? (m1.task - m0.task) * 1000 / draws : null, p50: iv.p50, p95: iv.p95,
    server: s0 !== null && s1 !== null ? (s1 - s0) / wall : null, reqs: reqs.slice(r0).map(r => r.path) };
  console.log(JSON.stringify({ ...out, reqs: Object.entries(out.reqs.reduce((a, p) => (a[p] = (a[p] || 0) + 1, a), {})) }));
  return out;
}

const blocks = [];
try {
  await openOffice(page);
  for (let i = 0; i < ROUNDS; i++) {
    const order = i % 2 ? [false, true] : [true, false];
    for (const on of order) blocks.push(await block(on, i));
  }
  const avg = (on, k) => { const xs = blocks.filter(b => b.on === on && b[k] !== null).map(b => b[k]); return xs.reduce((a, b) => a + b, 0) / (xs.length || 1); };
  const f = (x, d = 4) => (x === null || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(d));
  const cpuOn = avg(true, 'cpu'), cpuOff = avg(false, 'cpu'), mpdOn = avg(true, 'msPerDraw'), mpdOff = avg(false, 'msPerDraw');
  const dOn = avg(true, 'dps'), dOff = avg(false, 'dps');
  const rel = (a, b) => (b ? (a - b) / b : 0);
  const line = `page CPU ON ${f(cpuOn)} vs OFF ${f(cpuOff)} (${f(rel(cpuOn, cpuOff) * 100, 1)}%), ms/draw ON ${f(mpdOn, 3)} vs OFF ${f(mpdOff, 3)} (${f(rel(mpdOn, mpdOff) * 100, 1)}%), draws/s ON ${f(dOn, 1)} vs OFF ${f(dOff, 1)}, rAF p50/p95 ON ${f(avg(true, 'p50'), 1)}/${f(avg(true, 'p95'), 1)} OFF ${f(avg(false, 'p50'), 1)}/${f(avg(false, 'p95'), 1)} ms, server CPU ON ${f(avg(true, 'server'))} OFF ${f(avg(false, 'server'))}`;
  check('perf: page main-thread CPU with Office life ON within 5 % of OFF (10 min each, alternating blocks)', rel(cpuOn, cpuOff) <= 0.05, line, 'app/office-life/*');
  check('perf: main-thread time per drawn frame ON within 5 % of OFF', rel(mpdOn, mpdOff) <= 0.05, `ms/draw ON ${f(mpdOn, 3)} OFF ${f(mpdOff, 3)}`, 'app/office-life/* + app/game.js');
  check('perf: idle draw rate the same ON vs OFF (no extra busy frames)', rel(dOn, dOff) <= 0.05, `draws/s ON ${f(dOn, 1)} OFF ${f(dOff, 1)}`, 'app/office-life/*');
  const per = on => { const c = {}; for (const b of blocks.filter(x => x.on === on)) for (const p of b.reqs) c[p] = (c[p] || 0) + 1; return c; };
  const pOn = per(true), pOff = per(false);
  const extra = Object.entries(pOn).filter(([p, n]) => n >= ROUNDS && !(p in pOff) && !/\/api\/office-life\/(stream|settings)$/.test(p));
  check('perf: no new periodic request with Office life ON (stream heartbeat rides the open stream)', extra.length === 0,
    `ON-only repeating: ${JSON.stringify(extra)}; ON paths ${JSON.stringify(pOn).slice(0, 160)}; OFF paths ${JSON.stringify(pOff).slice(0, 120)}`, 'app/office-life/life.js');
  check('perf: no page errors during 20 min', errors.length === 0, errors.slice(0, 2).join(' | '), 'app/office-life/*');
} catch (e) { check('perf script', false, e.message.split('\n')[0]); } finally { await api('/api/office-life/settings', { enabled: true }).catch(() => {}); await browser.close(); }
process.exit(summary('life_perf') ? 1 : 0);
