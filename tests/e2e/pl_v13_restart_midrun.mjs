// v0.13 presence2 e2e: an agent mid-run when the office restarts reads working within seconds, and a run started on
// another channel shows its steps. Private office + REAL lab OpenClaw gateway (stub model); restarts only that office.
//   driver: tests/e2e/pl_v13_restart_midrun.sh (starts the lab, runs this, stops the lab; one process tree)
//   env: VO_URL, LAB, LAB_OC_PORT, LAB_OC_STUB, PL_ROOT, PL_PORT, PL_GATEWAY_URL, PL_GATEWAY_HTTP, PL_GATEWAY_TOKEN
// A live office: an agent ran a turn OpenClaw-side; after the office restarted it read idle ("snapshot") all along.
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
const office = cmd => spawnSync(path.join(TREE, 'tests/tools/pl-office.sh'), [cmd], { encoding: 'utf8', timeout: 90000, env: process.env });
const main = async () => { try { return (await api('/status')).body?.main || {}; } catch { return {}; } };
const until = async (fn, ms, step = 250) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const running = () => (gw('sessions.list', { agentId: 'main', limit: 10 }).sessions || []).some(s => s.key === 'agent:main:main' && s.hasActiveRun);
const say = (id, message) => gw('chat.send', { sessionKey: 'agent:main:main', idempotencyKey: `v13p2-${id}-${Date.now()}`, message });
const brief = s => `${s.state} ${s.source} "${String(s.task || '').slice(0, 60)}" runs=${s.activeRunCount}`;

check('office up, main known', !!(await until(async () => (await main()).state, 30000)), brief(await main()));
await until(async () => (await main()).providerHealth?.connected !== false && (await main()).state === 'idle', 20000);

// 1. main starts a long turn on another channel (as from OpenClaw's own dashboard): a quiet 9 s step (no event at all
//    while it runs: a claude-cli turn's long command, the reported case), then a reply streamed over 30 s (the stub reads
//    "slow:30000" in the step's output). (OpenClaw backgrounds a command after 10 s, so the step is kept under it.)
let r = say('long', '[[tool:exec {"command":"sleep 9; echo slow:30000","timeoutSeconds":60}]]');
const sent = Date.now();
check('gateway accepted the long turn', !!r.runId, JSON.stringify(r).slice(0, 160));
const before = await until(async () => { const s = await main(); return s.state === 'working' ? s : null; }, 15000, 150);
check('before the restart: main working', !!before, brief(before || await main()));

// 2. the office restarts (only this private office) while main is mid-run, mid-step
const stop = office('stop');
check('office stopped', stop.status === 0, (stop.stderr || stop.stdout).slice(-160));
const t0 = Date.now();
const start = office('start');
check('office started again', start.status === 0, (start.stderr || start.stdout).slice(-160));
const up = await until(async () => (await main()).state ? Date.now() : null, 30000, 100);
check('office answering', !!up);
const after = await until(async () => { const s = await main(); return s.state === 'working' ? s : null; }, 10000, 200);
const took = after ? ((Date.now() - up) / 1000).toFixed(1) : '-';
check(`after the restart: main working within 5 s of the office answering (${took} s; restart ${((up - t0) / 1000).toFixed(1)} s)`,
  !!after && Date.now() - up <= 5000 + 500, brief(after || await main()));
const quiet = (Date.now() - sent) / 1000;
check(`... while its step was still running, no event since (${quiet.toFixed(1)} s after the message; the step is 9 s)`, !!after && quiet < 9);
check('OpenClaw: the turn still runs', running());
await sleep(20000);
const mid = await main();
check('20 s later, still mid-run (its reply streaming): still working', mid.state === 'working', brief(mid));

// 3. the turn ends: main idle (finish grace 12 s)
const done = await until(async () => !running(), 60000, 1000);
check('OpenClaw: the turn ended', !!done);
const idle = await until(async () => { const s = await main(); return s.state === 'idle' ? s : null; }, 30000, 500);
check('main idle after its turn ends (nothing sticks)', !!idle, brief(idle || await main()));
const said = JSON.stringify((gw('chat.history', { sessionKey: 'agent:main:main', limit: 4 }).messages || []).slice(-2));
check('the step really ran (its output came back, no tool error)', /slow:30000/.test(said) && !/\\"status\\": ?\\"error/.test(said), said.slice(0, 160));

// 4. a new turn on another channel after the restart: its steps reach main's state (the floor follows it, marked outside)
r = say('steps', '[[tool:exec {"command":"sleep 8; echo floor-step","timeoutSeconds":60}]]');
check('gateway accepted a turn with a step', !!r.runId);
const step = await until(async () => { const s = await main(); return s.state === 'working' && s.source === 'openclaw-tool' ? s : null; }, 12000, 200);
check('its step is main\'s task line (source openclaw-tool)', !!step, brief(step || await main()));
check('one turn, one run', !step || step.activeRunCount === 1, brief(step || {}));
await until(async () => !running(), 60000, 1000);
const idle2 = await until(async () => { const s = await main(); return s.state === 'idle' ? s : null; }, 30000, 500);
check('main idle after that turn too', !!idle2, brief(idle2 || await main()));

process.exitCode = summary('pl_v13_restart_midrun');
