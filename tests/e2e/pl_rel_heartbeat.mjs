// 0.12.0 presence3 e2e: after an OpenClaw heartbeat turn its agent returns to idle (it stayed "working" until the office
// restarted). Private office + REAL lab OpenClaw 2026.11 gateway (stub model) whose own scheduler runs main's heartbeat
// every minute (LAB_OC_HEARTBEAT_EVERY=1m, target none, a 4 s turn), as a real install does every 30 min.
//   driver: tests/e2e/pl_rel_heartbeat.sh (starts the lab, runs this, stops the lab; one process tree)
//   env: VO_URL, LAB, LAB_OC_PORT (+ what pl_lib.mjs reads)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, summary, api, sleep } from './pl_lib.mjs';

const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const gw = (method, params) => {
  const r = spawnSync(path.join(TREE, 'tests/tools/lab-openclaw.sh'), ['cli', 'gateway', 'call', method, '--params', JSON.stringify(params), '--json'],
    { encoding: 'utf8', timeout: 60000, env: process.env });
  try { return JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 200) }; }
};
const main = async () => { try { return (await api('/status')).body?.main || {}; } catch { return {}; } };
const until = async (fn, ms, step = 250) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const running = () => (gw('sessions.list', { agentId: 'main', limit: 10 }).sessions || []).some(s => s.key === 'agent:main:main' && s.hasActiveRun);
const brief = s => `${s.state} ${s.source} ${s.runId || '-'} "${String(s.task || '').slice(0, 50)}" runs=${s.activeRunCount}`;
const hbJob = () => (gw('cron.list', {}).jobs || []).find(j => /heartbeat/i.test(`${j.name} ${j.displayName} ${j.declarationKey}`) && j.agentId === 'main');
const hbRuns = id => (gw('cron.runs', { id, limit: 10 }).entries || []).filter(e => e.action === 'finished' && e.status === 'ok');

check('office up, main known', !!(await until(async () => (await main()).state, 30000)), brief(await main()));
const job = await until(async () => hbJob(), 60000, 2000);   // (the gateway writes its heartbeat job a little after it starts)
check('the lab gateway has main\'s heartbeat job (scheduled by OpenClaw itself)', !!job, job ? `${job.name} ${JSON.stringify(job.schedule).slice(0, 60)}` : 'none');
const idle0 = await until(async () => { const s = await main(); return s.state === 'idle' ? s : null; }, 90000, 500);
check('main idle before the heartbeat', !!idle0, brief(idle0 || await main()));

for (const round of [1, 2]) {
  const ran0 = job ? hbRuns(job.id).length : 0;
  // the scheduler's next tick (every minute): main's heartbeat turn starts -> the office shows main working
  const w = await until(async () => { const s = await main(); return s.state === 'working' ? s : null; }, 80000, 200);
  check(`heartbeat ${round}: main working while it runs`, !!w, brief(w || await main()));
  // OpenClaw: the turn ends (sessions.list: no run in agent:main:main; cron.runs: "heartbeat completed")
  const ended = await until(async () => !running(), 30000, 500);
  const tEnd = Date.now();
  check(`heartbeat ${round}: OpenClaw says it ended`, !!ended);
  const ran = await until(async () => (job && hbRuns(job.id).length > ran0) ? hbRuns(job.id)[0] : null, 20000, 1000);
  check(`heartbeat ${round}: cron.runs lists it finished ok`, !!ran, ran ? `${ran.summary} ${ran.durationMs} ms` : '');
  // the office: no longer working within seconds (the layer checks the held row against sessions.list), idle after the
  // finish grace (12 s)
  const off = await until(async () => { const s = await main(); return s.state !== 'working' ? s : null; }, 20000, 250);
  const took = ((Date.now() - tEnd) / 1000).toFixed(1);
  check(`heartbeat ${round}: main stops working within 10 s of the end (${took} s after OpenClaw's listing said so)`, !!off && Number(took) <= 10, brief(off || await main()));
  const idle = await until(async () => { const s = await main(); return s.state === 'idle' ? s : null; }, 30000, 500);
  check(`heartbeat ${round}: main idle`, !!idle && !idle.activeRunCount, brief(idle || await main()));
  if (round === 1) {
    await sleep(15000);
    const later = await main();
    check('15 s later still idle (nothing sticks)', later.state === 'idle', brief(later));
  }
}

// an ordinary turn (as from OpenClaw's dashboard) still shows working and ends
const r = gw('chat.send', { sessionKey: 'agent:main:main', idempotencyKey: `p3-${Date.now()}`, message: 'ordinary turn slow:5000' });
check('gateway accepted an ordinary turn', !!r.runId, JSON.stringify(r).slice(0, 120));
const ow = await until(async () => { const s = await main(); return s.state === 'working' ? s : null; }, 15000, 150);
check('ordinary turn: main working', !!ow, brief(ow || await main()));
await until(async () => !running(), 30000, 500);
const oi = await until(async () => { const s = await main(); return s.state === 'idle' ? s : null; }, 30000, 500);
check('ordinary turn: main idle after it ends', !!oi, brief(oi || await main()));
process.exit(summary('pl_rel_heartbeat'));
