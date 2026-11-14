// 0.12.0 (presence3): an OpenClaw heartbeat turn no longer holds its agent "working" for ever.
// The layer's LinkActivity (providers/openclaw/activity.js) holds a session running from sessions.changed. OpenClaw
// 2026.11.2's scheduled heartbeat (cron job "Heartbeat (main)", main session) sends hasActiveRun true while it runs and,
// at its end, a change with phase "end" that STILL says hasActiveRun true / status running, then `heartbeat` and `cron`
// (action finished) events; never a change with hasActiveRun false (an ordinary turn sends one, reason
// agent.input.settled). The event shapes below are the ones a real lab gateway sent (OpenClaw 2026.11.2, stub model,
// .work/release/PRESENCE3-0.12.md), trimmed to the fields that matter plus a few of the rest.
// Run: node --test tests/test_pl_rel_heartbeat_activity.mjs   (ACTIVITY_JS=<path> runs it against another activity.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.ACTIVITY_JS || path.join(here, '../app/provider-layer/server/providers/openclaw/activity.js');
const { LinkActivity } = await import(pathToFileURL(file).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A gateway link stand-in: sessions.subscribe / sessions.list answer from `rows` (what the gateway lists now). */
function fakeLink(rows = []) {
  const link = {
    connectionId: '1', connected: true, rows, calls: [], listDelayMs: 0, beforeAnswer: null,
    offers: (m) => ['sessions.subscribe', 'sessions.list'].includes(m),
    async request(method, params) {
      link.calls.push(method);
      if (method === 'sessions.subscribe') return { subscribed: true, list: { sessions: link.rows.map((r) => ({ ...r })) } };
      if (method === 'sessions.list') {
        const snapshot = link.rows.map((r) => ({ ...r }));
        if (link.beforeAnswer) { const f = link.beforeAnswer; link.beforeAnswer = null; f(); }
        if (link.listDelayMs) await sleep(link.listDelayMs);
        return { sessions: snapshot, count: snapshot.length, ts: Date.now(), params };
      }
      throw new Error(`unknown method: ${method}`);
    },
  };
  return link;
}

function setup(rows, opts = {}) {
  const link = fakeLink(rows);
  const out = [];
  const act = new LinkActivity(link, { emit: (e) => out.push(e), kind: 'openclaw', recheckMs: 60, reconcileMs: 400, ...opts });
  return { link, out, act, last: (agent) => [...out].reverse().find((e) => e.agentKey === agent) };
}

// --- recorded shapes (lab OpenClaw 2026.11.2) ---
const row = (key, active, status, extra = {}) => ({ key, agentId: key.split(':')[1], kind: 'direct', chatType: 'direct', hasActiveRun: active, status, ...extra });
const changed = (key, active, status, extra = {}) => ({
  event: 'sessions.changed',
  payload: { sessionKey: key, agentId: key.split(':')[1], ts: Date.now(), hasActiveRun: active, status, kind: 'direct', ...extra,
    session: { key, agentId: key.split(':')[1], isMain: true, kind: 'direct', status, hasActiveRun: active, abortedLastRun: false } },
});
const message = (key) => ({ event: 'session.message', payload: { sessionKey: key, agentId: 'main', hasActiveRun: true, status: 'running', kind: 'direct' } });
const heartbeatEvt = { event: 'heartbeat', payload: { ts: Date.now(), status: 'skipped', reason: 'target-none', preview: '', hasMedia: false, durationMs: 4021 } };
const cronFinished = { event: 'cron', payload: { jobId: 'hb-job', action: 'finished', status: 'ok', completionStatus: 'ok', deliveryStatus: 'not-requested', durationMs: 4300, job: { name: 'Heartbeat (main)' } } };
const cronScheduled = { event: 'cron', payload: { jobId: 'hb-job', action: 'scheduled', nextRunAtMs: Date.now() + 60000 } };

test('a heartbeat turn (the gateway never says it ended) leaves the agent idle within seconds', async () => {
  const MAIN = 'agent:main:main';
  const { link, act, last } = setup([row(MAIN, false, 'done')]);
  await act.onHello();
  // the scheduled heartbeat runs in main's session
  link.rows = [row(MAIN, true, 'running')];
  act.onEvent(changed(MAIN, true, 'running', { phase: 'message' }));
  act.onEvent(changed(MAIN, true, 'running', { phase: 'start' }));
  act.onEvent(message(MAIN));
  await sleep(320);
  assert.equal(last('main')?.active, true, 'main working while its heartbeat runs');
  // its end: a phase "end" change that still says running, then heartbeat + cron finished; the listing says done
  link.rows = [row(MAIN, false, 'done')];
  act.onEvent(changed(MAIN, true, 'running', { phase: 'end' }));
  act.onEvent(heartbeatEvt);
  act.onEvent(cronFinished);
  act.onEvent(cronScheduled);
  await sleep(600);
  assert.equal(last('main')?.active, false, 'main idle after its heartbeat turn ended');
  assert.ok(link.calls.includes('sessions.list'), 'the held row was checked against sessions.list');
});

test('only the end sign (heartbeat / cron finished event) is enough, and the periodic check ends it even without one', async () => {
  const MAIN = 'agent:main:main';
  const a = setup([row(MAIN, false, 'done')], { reconcileMs: 100000 });
  await a.act.onHello();
  a.link.rows = [row(MAIN, true, 'running')];
  a.act.onEvent(changed(MAIN, true, 'running', { phase: 'start' }));
  await sleep(300);
  a.link.rows = [row(MAIN, false, 'done')];
  a.act.onEvent(heartbeatEvt);
  await sleep(300);
  assert.equal(a.last('main')?.active, false, 'heartbeat event -> checked -> idle');

  const b = setup([row(MAIN, false, 'done')], { recheckMs: 100000, reconcileMs: 400 });
  await b.act.onHello();
  b.link.rows = [row(MAIN, true, 'running')];
  b.act.onEvent(changed(MAIN, true, 'running', { phase: 'start' }));
  await sleep(300);
  assert.equal(b.last('main')?.active, true);
  b.link.rows = [row(MAIN, false, 'done')];   // ended, and nothing at all said so
  await sleep(700);
  assert.equal(b.last('main')?.active, false, 'the periodic check let the missed end go');
});

test('an ordinary turn still ends from the feed alone, and a session still running is never let go', async () => {
  const KEY = 'agent:main:dashboard:abc';
  const { link, act, last, out } = setup([row(KEY, false, 'done')], { reconcileMs: 150 });
  await act.onHello();
  link.rows = [row(KEY, true, 'running')];
  act.onEvent(changed(KEY, true, 'running', { reason: 'agent.run.started' }));
  await sleep(700);   // several periodic checks: still running there -> still working, told once
  assert.equal(last('main')?.active, true);
  assert.equal(out.filter((e) => e.agentKey === 'main' && e.active).length, 1, 'no flapping while it runs');
  const before = link.calls.length;
  link.rows = [row(KEY, false, 'done')];
  act.onEvent({ event: 'sessions.changed', payload: { sessionKey: KEY, agentId: 'main', reason: 'agent.input.settled', hasActiveRun: false, session: { key: KEY, agentId: 'main', hasActiveRun: false } } });
  await sleep(300);
  assert.equal(last('main')?.active, false);
  await sleep(400);
  assert.equal(link.calls.length, before, 'nothing held -> no more checks');
});

test('a row without a boolean hasActiveRun is read by its status; a removed session runs nothing', async () => {
  const KEY = 'agent:ops:main';
  const { link, act, last } = setup([], { reconcileMs: 100000 });
  await act.onHello();
  act.onEvent({ event: 'sessions.changed', payload: { sessionKey: KEY, agentId: 'ops', status: 'running' } });
  await sleep(300);
  assert.equal(last('ops')?.active, true, 'status running -> working');
  act.onEvent({ event: 'sessions.changed', payload: { sessionKey: KEY, agentId: 'ops', status: 'done' } });
  await sleep(300);
  assert.equal(last('ops')?.active, false, 'status done -> idle');
  // recorded removal: {sessionKey, sessionId, agentId, reason: "delete", ts} (no hasActiveRun, no status)
  act.onEvent({ event: 'sessions.changed', payload: { sessionKey: KEY, agentId: 'ops', status: 'running' } });
  await sleep(300);
  assert.equal(last('ops')?.active, true);
  act.onEvent({ event: 'sessions.changed', payload: { sessionKey: KEY, sessionId: 's-1', agentId: 'ops', reason: 'delete', ts: Date.now() } });
  await sleep(300);
  assert.equal(last('ops')?.active, false, 'deleted -> idle');
  // the keyless removal notice {reason: "delete", ts}: the held rows are checked; a session no longer listed ended
  act.onEvent({ event: 'sessions.changed', payload: { sessionKey: KEY, agentId: 'ops', status: 'running' } });
  await sleep(300);
  link.rows = [];
  act.onEvent({ event: 'sessions.changed', payload: { reason: 'delete', ts: Date.now() } });
  await sleep(300);
  assert.equal(last('ops')?.active, false, 'no longer listed -> idle');
});

test('a check never undoes a feed change newer than its request; it finds a missed start', async () => {
  const A = 'agent:main:main', B = 'agent:ops:main', C = 'agent:main:subagent:1';
  const { link, act, last } = setup([], { reconcileMs: 100000 });
  await act.onHello();
  link.rows = [row(A, true, 'running')];
  act.onEvent(changed(A, true, 'running', { phase: 'start' }));
  await sleep(300);
  // a check starts with A ended in its snapshot; while it is in flight A starts again (the feed says so): kept
  link.rows = [row(A, false, 'done'), row(C, true, 'running', { spawnedBy: A })];
  link.listDelayMs = 100;
  link.beforeAnswer = () => act.onEvent(changed(A, true, 'running', { phase: 'start' }));
  act.onEvent(heartbeatEvt);
  await sleep(500);
  assert.equal(last('main')?.active, true, 'the newer feed change wins');
  assert.equal(last('main')?.sessions, 2, 'and the missed helper session is counted');
  link.listDelayMs = 0;
  // ops' own end with a stale row is not ops' business of main's: untouched
  assert.equal(last('ops'), undefined);
  link.rows = [row(A, false, 'done'), row(C, false, 'done'), row(B, false, 'done')];
  act.onEvent(heartbeatEvt);
  await sleep(300);
  assert.equal(last('main')?.active, false);
});

test('connection down: nothing held, no check left running', async () => {
  const MAIN = 'agent:main:main';
  const { link, act, last } = setup([row(MAIN, true, 'running')], { reconcileMs: 100 });
  await act.onHello();
  assert.equal(last('main')?.active, true, 'running at hello -> working');
  act.onDown();
  assert.equal(last('main')?.active, false);
  const n = link.calls.length;
  await sleep(350);
  assert.equal(link.calls.length, n, 'no check after the connection went');
});
