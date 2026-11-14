// v0.13 presence2: the layer's bus tells a listener that (re)connects what goes on now (app/provider-layer/vo-bus-state.mjs,
// vo-host.mjs /api/pl/internal/bus). Live 8085 after a restart: the layer reached the gateway and told agent.activity
// "coder works" before the office server listened; with no listener the event was gone, and OpenClaw's activity is told
// once per change, so a working agent read idle for its whole turn. Hermetic: BusState alone, then the real vo-host with events put
// on its bus before any listener.   node --test tests/test_pl_bus_replay.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHost } from '../app/provider-layer/vo-host.mjs';
import { signPrincipal, PRINCIPAL_HEADER } from '../app/provider-layer/vo-router.mjs';
import { BusState, RUN_QUIET_MS } from '../app/provider-layer/vo-bus-state.mjs';

const OC = { kind: 'openclaw', connectionId: '1' };
const status = (state, cid = '1') => ({ type: 'provider.status', kind: 'openclaw', connectionId: cid, state });
const activity = (agentKey, active, extra = {}) => ({ type: 'agent.activity', ...OC, agentKey, active, sessions: active ? 1 : 0, keys: active ? [`agent:${agentKey}:main`] : [], ...extra });
const runStart = (runId, agentKey, outside = true) => ({ type: 'run.start', ...OC, agentKey, sessionKey: `agent:${agentKey}:main`, runId, ...(outside ? { outside: true } : {}) });
const toolStart = (runId, toolId, title) => ({ type: 'tool.start', ...OC, agentKey: 'coder', runId, toolId, name: 'exec', title });
const toolEnd = (runId, toolId) => ({ type: 'tool.end', ...OC, agentKey: 'coder', runId, toolId, ok: true });
const brief = e => e.type === 'bus.hello' || e.type === 'bus.synced' ? e.type : `${e.type}:${e.agentKey || ''}:${e.runId || ''}:${e.toolId || ''}${e.active === false ? ':off' : ''}`;

test('BusState: hello, connections, active agents, open runs with their running steps, synced; ended ones are not told', () => {
  let now = 1000;
  const s = new BusState({ now: () => now });
  s.take(status('connected'));
  s.take(activity('coder', true)); s.take(activity('main', true)); s.take(activity('main', false));
  s.take(runStart('r1', 'coder')); s.take(toolStart('r1', 't1', 'Exec sleep 40')); s.take(toolStart('r1', 't2', 'Read a')); s.take(toolEnd('r1', 't2'));
  s.take(runStart('r2', 'main', false)); s.take({ type: 'run.end', ...OC, runId: 'r2', status: 'ok' });
  const out = s.replay();
  assert.deepEqual(out.map(brief), ['bus.hello', 'provider.status:::', 'agent.activity:coder::', 'run.start:coder:r1:', 'tool.start:coder:r1:t1', 'bus.synced']);
  assert.ok(out.slice(1, -1).every(e => e.replay === true));
  assert.equal(out[0].boot, out.at(-1).boot); assert.equal(out.at(-1).replayed, 4);
  assert.equal(out[3].outside, true);
  // (a connection that goes down: nothing runs there any more)
  s.take(status('offline'));
  assert.deepEqual(s.replay().map(brief), ['bus.hello', 'provider.status:::', 'bus.synced']);
  // (a run quiet for longer than RUN_QUIET_MS is let go)
  s.take(status('connected')); s.take(runStart('r3', 'coder'));
  now += RUN_QUIET_MS + 1;
  assert.deepEqual(s.replay().map(brief), ['bus.hello', 'provider.status:::', 'bus.synced']);
  // (another layer process: another boot)
  assert.notEqual(new BusState().boot, s.boot);
});

test('vo-host: a listener that connects after the events still hears what goes on, first, in order', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-pl-bus-replay-'));
  const officeDir = path.join(tmp, 'office'), secret = 'test-bus-replay-secret-0123456789';
  fs.mkdirSync(officeDir, { recursive: true });
  const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {} });
  const h = await createHost({ data: path.join(officeDir, 'provider-layer'), secret, keyFile: path.join(tmp, 'pl.key'), officeDir, log: quiet });
  await new Promise(r => h.server.listen(0, '127.0.0.1', r));
  const port = h.server.address().port;
  const internal = signPrincipal(secret, { role: 'owner', via: 'internal', authAt: 0, csrf: null });
  const listen = () => {
    const lines = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/pl/internal/bus', headers: { [PRINCIPAL_HEADER]: internal } }, res => {
      res.setEncoding('utf8'); let buf = '';
      res.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); if (l.startsWith('data: ')) lines.push(JSON.parse(l.slice(6))); } });
      res.on('error', () => {});
    });
    req.on('error', () => {});
    return { lines, close: () => req.destroy() };
  };
  const until = async (what, fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } assert.fail(`timed out: ${what}`); };
  try {
    // the layer reached the gateway before the office server listened: an agent mid-run, in a step
    h.providerBus.emit(status('connected'));
    h.providerBus.emit(activity('coder', true, { task: 'Working on “fish”' }));
    h.providerBus.emit(runStart('oc-run-1', 'coder'));
    h.providerBus.emit(toolStart('oc-run-1', 'call-1', 'Exec sleep 40'));
    const a = listen();
    await until('synced', () => a.lines.some(e => e.type === 'bus.synced'));
    assert.deepEqual(a.lines.map(brief), ['bus.hello', 'provider.status:::', 'agent.activity:coder::', 'run.start:coder:oc-run-1:', 'tool.start:coder:oc-run-1:call-1', 'bus.synced']);
    assert.equal(a.lines[2].task, 'Working on “fish”');
    // live events follow the replay on the same stream
    h.providerBus.emit(toolEnd('oc-run-1', 'call-1'));
    await until('live tool.end', () => a.lines.some(e => e.type === 'tool.end'));
    assert.ok(!a.lines.at(-1).replay);
    // the run ends while nobody listens; a listener that reconnects is not told it again (so the office ends it)
    a.close();
    h.providerBus.emit({ type: 'run.end', ...OC, runId: 'oc-run-1', status: 'ok' });
    h.providerBus.emit(activity('coder', false));
    const b = listen();
    await until('synced again', () => b.lines.some(e => e.type === 'bus.synced'));
    assert.deepEqual(b.lines.map(brief), ['bus.hello', 'provider.status:::', 'bus.synced']);
    assert.equal(b.lines[0].boot, a.lines[0].boot);   // (the same layer process)
    b.close();
  } finally {
    await h.close?.();
    try { h.server.close(); } catch { /* closed */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
