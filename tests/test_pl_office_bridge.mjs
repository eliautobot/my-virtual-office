// The layer kind "office" (unify WP-B; app/provider-layer/server/office-bridge.mjs): the office's own providers in the
// layer's chat window, through the office server's chat bridge. Hermetic: vo-host (createHost) against a STUB bridge (a
// small HTTP server speaking the bridge's routes with scripted event sequences), in a temporary folder.
// - discovery: the office's agents become layer agents (office id = the office's own id, provider label, role), each
//   with its own capabilities (/api/chat/can); a change the office announces (internal sync) shows at once; one it stops
//   listing is switched off and comes back with the same ids;
// - hidden: no "This office" connection in Connections / Agent Providers / provider kinds; it can't be changed, made or
//   removed; its agents are not in the office server's id map, its events never reach the office server's bus;
// - a run: events in (run.status, thinking, deltas, a step, an approval answered through the layer, usage, run.end) and
//   frames out on the page's socket, the session key the office gave adopted, the caller's X-VO-Principal forwarded
//   unchanged; a dropped stream is read again from where it stopped (since); stop; a busy agent (409); a run whose
//   stream never comes back ends interrupted; chats, history, rename and delete go to the office;
// - the bridge off (no VO_PL_OFFICE_URL): its agents are switched off; on again: the same records.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHost } from '../app/provider-layer/vo-host.mjs';
import { signPrincipal, readPrincipal } from '../app/provider-layer/vo-router.mjs';

const require = createRequire(new URL('../app/provider-layer/package.json', import.meta.url));
const WebSocket = require('ws');
const STUB_PORT = Number(process.env.VO_UB_STUB_PORT || 19651), LAYER_PORT = Number(process.env.VO_UB_LAYER_PORT || 19652);
const SECRET = 'test-secret-' + process.pid;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vo-pl-office-'));
const quiet = Object.assign(() => {}, { info() {}, warn() {}, error() {}, debug() {} });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const until = async (what, fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(25); } };

// ---------------------------------------------------------------- the stub office bridge
const stub = { agents: [], seen: [], runs: new Map(), bodies: [], sinces: [], history: [], renamed: [], deleted: [], n: 0 };
const AGENTS = {
  // (as uA-bridge.md's contract: officeId, provider, transport, caps in the layer's names plus the office's own extras)
  dev: { officeId: 'dev-codex', id: 'dev-codex', name: 'Dev', emoji: '🛠️', provider: 'codex', transport: 'app-server', model: 'gpt-5.5', available: true,
    caps: { chat: true, sessions: true, sessionCreate: true, sessionDelete: true, stop: true, approvals: true, attachments: true, tools: true, streaming: true, context: true, models: false, bogus: true } },
  agy: { officeId: 'agy-1', id: 'agy-native', name: 'Gravity', provider: 'antigravity', transport: 'sdk', caps: { chat: true, stop: true } },
  // (a provider that names each agent's job and its own label: both kept)
  cc: { officeId: 'claude-1', name: 'Claude', role: 'Reviewer', provider: 'claude-code', providerLabel: 'Claude Code', caps: { chat: true, sessions: true, stop: true, attachments: true, tools: true } },
};
stub.agents = [AGENTS.dev, AGENTS.agy];
const json = (res, status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
function script(input) {
  if (input === 'hello') return [
    { type: 'run.start', agentKey: 'dev-codex' },
    { type: 'run.status', phase: 'Thinking' }, { type: 'run.delta', thinking: 'hmm' }, { type: 'run.delta', text: 'Hel' }, { type: 'run.delta', text: 'lo' },
    { type: 'tool.start', toolId: 't1', name: 'shell', input: 'ls', toolKind: 'execute', raw: '{"command":"ls","cwd":"/w"}' }, { type: 'tool.end', toolId: 't1', ok: true, text: 'a.txt', exitCode: 0 },
    { type: 'approval.requested', approvalId: 'ap1', tool: 'shell', command: 'rm x', options: ['allow-once', 'deny'] },
    { wait: 'approve' },
    { type: 'approval.resolved', approvalId: 'ap1', approved: true, decision: 'allow-once' }, { type: 'usage.update', used: 100, size: 1000 },
    { type: 'not.a.type', text: 'dropped' },
    { type: 'run.end', status: 'ok', text: 'Hello', model: 'gpt-5.5', tokensIn: 5, tokensOut: 2, ms: 40 }];
  if (input === 'drop') return [{ type: 'run.delta', text: 'A' }, { type: 'run.delta', text: 'B' }, { drop: true }, { type: 'run.delta', text: 'C' }, { type: 'run.end', status: 'ok', text: 'ABC' }];
  if (input === 'long') return [{ type: 'run.delta', text: 'x' }, { wait: 'stop' }, { type: 'run.end', status: 'stopped' }];
  if (input === 'vanish') return [{ vanish: true }];
  return [{ type: 'run.end', status: 'ok', text: `echo ${input}` }];
}
const stubServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const P = readPrincipal(SECRET, req.headers['x-vo-principal']);
  stub.seen.push({ path: u.pathname, header: req.headers['x-vo-principal'], P });
  if (!P) return json(res, 401, { error: 'no principal', code: 'signed_out' });
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const p = u.pathname.replace('/api/office-bridge', '');
    if (p === '/agents') return json(res, 200, { agents: stub.agents });
    if (p === '/sessions') return json(res, 200, { sessions: u.searchParams.get('agent') === 'dev-codex' ? [{ key: 'th-old', title: 'Old thread', updatedAt: 1700000000000 }] : [] });
    if (p === '/history') return json(res, 200, { authoritative: true, messages: [{ role: 'user', text: 'hi', at: 1700000000000 }, { role: 'assistant', text: 'old answer', at: 1700000001000 }], usage: { used: 7, size: 100 } });
    if (p === '/sessions/rename') { stub.renamed.push(body); return json(res, 501, { ok: false, error: 'No office provider renames its chats', code: 'unsupported' }); }
    if (p === '/sessions/delete') { stub.deleted.push(body); return json(res, 200, { ok: true }); }
    if (p === '/models') return json(res, 501, { error: 'no models', code: 'unsupported' });
    if (p === '/runs') {
      stub.bodies.push({ body, header: req.headers['x-vo-principal'] });
      if (body.input === 'busy') return json(res, 409, { error: 'Dev is still answering in another chat', code: 'busy' });
      const id = `o${++stub.n}`;
      stub.runs.set(id, { events: script(body.input), at: 0, waits: new Map(), streams: 0 });
      // (a new chat: no key yet; its key comes with the run's events from the second one on, as Codex names its thread)
      stub.runs.get(id).key = body.session || `th-${id}`;
      return json(res, 200, { ok: true, runId: id, sessionKey: body.session || null, provider: 'codex', transport: 'app-server' });
    }
    if (p === '/runs/events') {
      const r = stub.runs.get(u.searchParams.get('run'));
      if (!r) return json(res, 404, { error: 'No such run', code: 'not_found' });
      stub.sinces.push(`${u.searchParams.get('run')}:${u.searchParams.get('since')}`);
      r.streams++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': stub\n\n');
      // (the events after `since`; the script's markers — drop, wait, vanish — are not events: an event's id is its place
      // among the events)
      const steps = r.events, since = Number(u.searchParams.get('since')) || 0;
      const pump = async () => {
        let i = 0, n = 0;
        while (i < steps.length && n < since) { if (steps[i].type) n++; i++; }
        for (; i < steps.length; i++) {
          const s = steps[i];
          if (s.vanish) { res.destroy(); return; }
          if (s.drop) { if (s.done) continue; s.done = true; res.destroy(); return; }
          if (s.wait) { if (!s.done) { await new Promise(ok => r.waits.set(s.wait, ok)); s.done = true; } continue; }
          n++;
          const ev = { ...s, runId: u.searchParams.get('run'), agentKey: 'dev-codex', ...(n > 1 ? { sessionKey: r.key } : {}) };
          res.write(`id: ${n}\nevent: ${s.type}\ndata: ${JSON.stringify(ev)}\n\n`);
          await sleep(5);
        }
        res.end();
      };
      pump().catch(() => res.destroy());
      return undefined;
    }
    if (p === '/stop' || p === '/approve') {
      const r = stub.runs.get(body.run);
      if (!r) return json(res, 404, { error: 'No such run', code: 'not_found' });
      if (p === '/approve') stub.approved = body;
      const go = r.waits.get(p === '/stop' ? 'stop' : 'approve');
      if (go) go();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found', code: 'not_found' });
  });
});

// ---------------------------------------------------------------- talking to the layer as the office does
const owner = signPrincipal(SECRET, { role: 'owner', via: 'loopback', authAt: Date.now(), csrf: null });
const internal = signPrincipal(SECRET, { role: 'owner', via: 'internal', authAt: 0, csrf: null });
function call(method, p, body = null, who = owner) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: LAYER_PORT, agent: false, method, path: p, headers: { 'x-vo-principal': who, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
      let raw = ''; res.on('data', d => { raw += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch { /* not JSON */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject); req.end(data || undefined);
  });
}
async function startLayer(officeUrl) {
  const h = await createHost({ data: path.join(tmp, 'layer'), secret: SECRET, officeDir: tmp, log: quiet, officeUrl, officeOpts: { retryMs: [30, 30, 30], resyncMs: 60000 } });
  await new Promise(r => h.server.listen(LAYER_PORT, '127.0.0.1', r));
  return h;
}

let h = null, ws = null, bus = null;
process.on('uncaughtException', e => { console.log('UNCAUGHT', e.stack.split('\n').slice(0, 8).join(' | ')); process.exit(1); });
try {
  await new Promise(r => stubServer.listen(STUB_PORT, '127.0.0.1', r));
  h = await startLayer(`http://127.0.0.1:${STUB_PORT}`);
  const frames = [];
  ws = new WebSocket(`ws://127.0.0.1:${LAYER_PORT}/api/pl/ws`, { headers: { 'x-vo-principal': owner } });
  ws.on('message', d => frames.push(JSON.parse(String(d))));
  await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
  // the office server's view of the bus (Office Life, presence)
  const busLines = [];
  bus = http.get({ host: '127.0.0.1', port: LAYER_PORT, path: '/api/pl/internal/bus', headers: { 'x-vo-principal': internal } }, res => { res.setEncoding('utf8'); res.on('data', d => busLines.push(...d.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6))))); res.on('error', () => {}); });
  bus.on('error', () => {});
  const layerAgents = async () => (await call('GET', '/api/pl/agents')).json.agents;
  const officeRows = async () => (await layerAgents()).filter(a => a.provider && a.provider.kind === 'office');

  let dev, agy;
  await test('discovery: the office\'s agents are layer agents with their office ids, provider label and role', async () => {
    const rows = await until('office agents listed', async () => { const r = await officeRows(); return r.length === 2 ? r : null; });
    dev = rows.find(a => a.officeId === 'dev-codex'); agy = rows.find(a => a.officeId === 'agy-1');
    assert.ok(dev && agy, JSON.stringify(rows.map(r => r.officeId)));
    assert.equal(dev.name, 'Dev'); assert.equal(dev.role, 'Codex agent'); assert.equal(agy.role, 'Antigravity agent');
    assert.deepEqual({ ...dev.provider, connectionId: undefined }, { kind: 'office', label: 'Codex', connection: 'This office', connectionId: undefined, provider: 'codex', model: 'gpt-5.5' });
    assert.equal(agy.provider.label, 'Antigravity');
    // (discovery at start had no request behind it: the layer's own internal principal)
    const first = stub.seen.find(s => s.path === '/api/office-bridge/agents');
    assert.equal(first.P.via, 'internal');
  });

  await test('capabilities per agent: /api/chat/can is the agent\'s own, within the kind\'s', async () => {
    const c1 = (await call('GET', `/api/chat/can?agent=${dev.id}`)).json, c2 = (await call('GET', `/api/chat/can?agent=${agy.id}`)).json;
    assert.equal(c1.ok, true); assert.equal(c1.kind, 'office');
    for (const k of ['chat', 'sessions', 'stop', 'approvals', 'attachments', 'tools', 'context']) assert.equal(c1.caps[k], true, k);
    for (const k of ['models', 'effort', 'files', 'rewrite', 'queue', 'bogus', 'sessionCreate', 'streaming']) assert.ok(!c1.caps[k], k);
    assert.equal(c2.caps.chat, true); assert.equal(c2.caps.stop, true);
    for (const k of ['sessions', 'approvals', 'attachments', 'tools']) assert.equal(c2.caps[k], false, k);
  });

  await test('hidden: no "This office" in Connections, Agent Providers or the kinds; it can\'t be made, changed or removed', async () => {
    const conns = (await call('GET', '/api/connections')).json.connections;
    assert.ok(!conns.some(c => c.kind === 'office'));
    const ap = (await call('GET', '/api/agent-providers')).json;
    assert.ok(!ap.providers.some(c => c.kind === 'office')); assert.ok(!ap.kinds.some(k => k.id === 'office'));
    assert.ok(!(await call('GET', '/api/providers')).json.kinds.some(k => k.id === 'office'));
    const oc = h.connections.list().find(c => c.kind === 'office');
    assert.equal((await call('POST', '/api/connections/remove', { id: oc.id })).status, 404);
    assert.equal((await call('POST', '/api/connections/update', { id: oc.id, label: 'x' })).status, 404);
    assert.equal((await call('POST', '/api/connections/test', { id: oc.id })).status, 404);
    assert.equal((await call('POST', '/api/connections', { kind: 'office', label: 'x', scope: 'installation' })).status, 400);
    assert.equal(h.connections.list().filter(c => c.kind === 'office').length, 1);
    // the office server's id map never holds them (its turns, A2A, presence stay its own)
    const map = (await call('GET', '/api/pl/internal/office-agents', null, internal)).json.agents;
    assert.ok(!map.some(r => r.kind === 'office' || r.officeId === 'dev-codex'), JSON.stringify(map));
  });

  let session;
  await test('a run: events in, frames out; the session key adopted; the caller\'s principal forwarded; approval through the layer', async () => {
    session = (await call('POST', '/api/chat-sessions/create', { agent: dev.id })).json.session;
    const r = await call('POST', '/api/providers/runs', { agent: dev.id, session: session.id, input: 'hello' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const runId = r.json.runId;
    const sent = stub.bodies.at(-1);
    assert.equal(sent.header, owner);   // (forwarded unchanged: the office re-checks its own rules)
    assert.equal(sent.body.agent, 'dev-codex'); assert.equal(sent.body.session, ''); assert.equal(sent.body.input, 'hello'); assert.equal(sent.body.layerRun, runId);
    await until('the approval frame', () => frames.some(f => f.run === runId && f.event && f.event.type === 'approval.requested'));
    const ap = frames.find(f => f.run === runId && f.event && f.event.type === 'approval.requested').event;
    assert.equal(ap.approvalId, 'ap1'); assert.deepEqual(ap.options, ['allow-once', 'deny']);
    assert.equal((await call('POST', '/api/providers/approvals', { run: runId, approval: 'ap1', decision: 'allow-once' })).status, 200);
    assert.deepEqual(stub.approved, { run: 'o1', approvalId: 'ap1', approved: true, decision: 'allow-once' });
    const end = await until('run.end', () => frames.find(f => f.run === runId && f.event && f.event.type === 'run.end'));
    assert.equal(end.event.status, 'ok'); assert.equal(end.event.text, 'Hello'); assert.equal(end.event.model, 'gpt-5.5');
    const mine = frames.filter(f => f.run === runId);
    const text = mine.filter(f => f.delta && f.delta.text).map(f => f.delta.text).join('');
    assert.equal(text, 'Hello');
    assert.ok(mine.some(f => f.delta && f.delta.thinking === 'hmm'));
    const types = mine.filter(f => f.event).map(f => f.event.type);
    assert.deepEqual(types, ['run.start', 'run.status', 'tool.start', 'tool.end', 'approval.requested', 'approval.resolved', 'usage.update', 'run.end']);
    assert.equal(mine.find(f => f.event && f.event.type === 'tool.start').event.toolKind, 'execute');
    // (the page gets the step's whole arguments too: the office's Agent PC preview reads them as an object)
    assert.equal(mine.find(f => f.event && f.event.type === 'tool.start').event.raw, '{"command":"ls","cwd":"/w"}');
    // the office's session key is the chat's now; the next message goes to it
    const s = (await call('GET', `/api/chat-sessions?agent=${dev.id}`)).json.sessions.find(x => x.id === session.id);
    assert.equal(s.key, 'th-o1');
    const r2 = await call('POST', '/api/providers/runs', { agent: dev.id, session: session.id, input: 'again' });
    assert.equal(r2.status, 200); assert.equal(stub.bodies.at(-1).body.session, 'th-o1');
    await until('second run ends', () => frames.some(f => f.run === r2.json.runId && f.event && f.event.type === 'run.end'));
  });

  await test('the office server\'s bus never carries the office kind (Office Life would count it twice)', async () => {
    // (the bus does carry the other kinds' events: one of OpenClaw's, put on it here, arrives)
    h.providerBus.emit({ type: 'run.status', kind: 'openclaw', connectionId: '999', runId: 'oc-probe', phase: 'probe' });
    await until('the OpenClaw probe on the office bus', () => busLines.some(e => e.runId === 'oc-probe'));
    assert.ok(!busLines.some(e => e.kind === 'office'), JSON.stringify(busLines.filter(e => e.kind === 'office').slice(0, 2)));
    assert.ok(!busLines.some(e => e.type === 'office.agent' && e.officeId === 'dev-codex'));
  });

  await test('a dropped stream is read again from where it stopped (since); its answer is whole', async () => {
    const r = await call('POST', '/api/providers/runs', { agent: dev.id, session: session.id, input: 'drop' });
    const runId = r.json.runId, office = `o${stub.n}`;
    const end = await until('run.end', () => frames.find(f => f.run === runId && f.event && f.event.type === 'run.end'));
    assert.equal(end.event.status, 'ok'); assert.equal(end.event.text, 'ABC');
    assert.deepEqual(stub.sinces.filter(s => s.startsWith(`${office}:`)), [`${office}:0`, `${office}:2`]);
    assert.equal(frames.filter(f => f.run === runId && f.delta).map(f => f.delta.text).join(''), 'ABC');
  });

  await test('stop goes to the office; busy is 409; a run whose stream never comes back ends interrupted', async () => {
    const r = await call('POST', '/api/providers/runs', { agent: dev.id, session: session.id, input: 'long' });
    await until('first piece', () => frames.some(f => f.run === r.json.runId && f.delta));
    const other = (await call('POST', '/api/chat-sessions/create', { agent: dev.id })).json.session;
    const busy = await call('POST', '/api/providers/runs', { agent: dev.id, session: other.id, input: 'busy' });
    assert.equal(busy.status, 409); assert.equal(busy.json.code, 'busy');
    // (the window queues a refused message and sends it again: the layer's copy of the chat keeps neither the refused
    // message nor a "failed" line for it)
    const after = (await call('GET', `/api/providers/history?agent=${dev.id}&session=${other.id}`)).json;
    assert.ok(!(after.messages || []).some(m => m.status === 'failed' || m.text === 'busy'), JSON.stringify(after.messages || []).slice(0, 200));
    assert.equal((await call('POST', '/api/providers/interrupt', { run: r.json.runId })).status, 200);
    const end = await until('stopped', () => frames.find(f => f.run === r.json.runId && f.event && f.event.type === 'run.end'));
    assert.equal(end.event.status, 'stopped');
    const v = await call('POST', '/api/providers/runs', { agent: dev.id, session: other.id, input: 'vanish' });
    const gone = await until('interrupted', () => frames.find(f => f.run === v.json.runId && f.event && f.event.type === 'run.end'));
    assert.equal(gone.event.status, 'interrupted'); assert.match(gone.event.error || '', /stopped answering/);
  });

  await test('chats, history, rename, delete and models go to the office', async () => {
    const list = (await call('GET', `/api/chat-sessions?agent=${dev.id}`)).json.sessions;
    const old = list.find(s => s.key === 'th-old');
    assert.ok(old, 'the office\'s own thread is a chat here');
    assert.equal(old.label, 'Old thread');
    const hist = (await call('GET', `/api/providers/history?agent=${dev.id}&session=${old.id}`)).json;
    assert.deepEqual(hist.messages.map(m => [m.role, m.text, m.ts]), [['user', 'hi', 1700000000000], ['assistant', 'old answer', 1700000001000]]);
    assert.deepEqual(hist.usage, { used: 7, size: 100 });
    assert.equal((await call('POST', '/api/chat-sessions/rename', { agent: dev.id, session: old.id, label: 'Renamed' })).status, 200);
    assert.deepEqual(stub.renamed.at(-1), { agent: 'dev-codex', session: 'th-old', title: 'Renamed' });   // (501 there: named here)
    assert.equal((await call('GET', `/api/chat-sessions?agent=${dev.id}`)).json.sessions.find(s => s.id === old.id).label, 'Renamed');
    assert.equal((await call('POST', '/api/chat-sessions/delete', { agent: dev.id, session: old.id })).status, 200);
    assert.deepEqual(stub.deleted.at(-1), { agent: 'dev-codex', session: 'th-old' });
    assert.equal((await call('GET', `/api/providers/models?agent=${dev.id}`)).status, 501);
    // (an agent without chats of its own: the office is not asked for any)
    const before = stub.seen.filter(s => s.path === '/api/office-bridge/sessions').length;
    await call('GET', `/api/chat-sessions?agent=${agy.id}`);
    assert.equal(stub.seen.filter(s => s.path === '/api/office-bridge/sessions').length, before);
  });

  await test('the office announces a change (internal sync): new agents at once, gone ones off, back with the same ids', async () => {
    stub.agents = [AGENTS.dev, AGENTS.cc];
    const mark = frames.length;
    assert.equal((await call('POST', '/api/pl/internal/office/sync', {}, internal)).status, 200);
    // (the open pages hear of it: vo-mount reloads its agents on an 'agents' frame)
    await until('an agents frame', () => frames.slice(mark).some(f => f.t === 'agents'));
    assert.equal((await call('POST', '/api/pl/internal/office/sync', {}, owner)).status, 403);
    const rows = await until('claude listed, gravity gone', async () => { const r = await officeRows(); return r.some(a => a.officeId === 'claude-1') && !r.some(a => a.officeId === 'agy-1') ? r : null; });
    assert.equal(rows.find(a => a.officeId === 'claude-1').provider.label, 'Claude Code');
    assert.equal(rows.find(a => a.officeId === 'claude-1').role, 'Reviewer');
    // the window's read-only model chip reads the office agent's own model from the row (null when the office names none)
    assert.equal(rows.find(a => a.officeId === 'dev-codex').provider.model, 'gpt-5.5');
    assert.equal(rows.find(a => a.officeId === 'claude-1').provider.model, null);
    stub.agents = [AGENTS.dev, AGENTS.cc, AGENTS.agy];
    await call('POST', '/api/pl/internal/office/sync', {}, internal);
    const back = await until('gravity back', async () => (await officeRows()).find(a => a.officeId === 'agy-1'));
    assert.equal(back.id, agy.id);
  });

  await test('the bridge off: its agents are switched off; on again: the same records', async () => {
    ws.terminate(); ws = null; bus.destroy(); bus = null;
    await h.close(); h = null;
    h = await startLayer(null);
    assert.equal((await officeRows()).length, 0);
    assert.equal((await call('GET', `/api/chat/can?agent=${dev.id}`)).json.ok, false);
    await h.close(); h = null;
    h = await startLayer(`http://127.0.0.1:${STUB_PORT}`);
    const rows = await until('back', async () => { const r = await officeRows(); return r.length === 3 ? r : null; });
    assert.equal(rows.find(a => a.officeId === 'dev-codex').id, dev.id);
    assert.equal(h.connections.list().filter(c => c.kind === 'office').length, 1);
  });

  await test('OpenClaw and Hermes stay as they were: their kinds listed, office ids untouched', async () => {
    // (listed once the helper with their adapters is up)
    const kinds = await until('OpenClaw and Hermes listed', async () => { const k = (await call('GET', '/api/providers')).json.kinds.map(x => x.id); return k.includes('openclaw') && k.includes('hermes') ? k : null; }, 15000);
    assert.ok(!kinds.includes('office'), kinds.join(','));
    assert.equal(h.registry.manifest('openclaw').internal, undefined);
    assert.equal(h.registry.implemented('office'), true);
  });
  console.log(`# ${passed} passed`);
} finally {
  if (ws) ws.terminate();
  if (bus) bus.destroy();
  if (h) await h.close().catch(() => {});
  stubServer.closeAllConnections?.();
  await new Promise(r => stubServer.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
