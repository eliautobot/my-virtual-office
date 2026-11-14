// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The layer kind "office" (unify, .work/unify/DESIGN.md §3.1): the office's own providers (Codex, Claude Code, OpenCode,
// Antigravity, Hermes API servers, the office's provider extensions) in the layer's one chat window. They keep running
// in the office server (app/office_chat_bridge.py), which speaks the layer's event vocabulary; this module is the
// in-process handler for the kind (Chat's `inproc` and AgentProviders' `inproc`: async (connection, method, params)):
// each call is one loopback request to the office's bridge routes, a run's events come back as server-sent events and go
// on the layer's bus with the kind's common fields, exactly as an adapter's would.
//
// Who is asking: the office server signed the X-VO-Principal of the request that led here; it is forwarded unchanged
// (withCaller, around every request: vo-host.mjs), so the office checks its own access rules (a chat-only member stays
// chat-only). A call with no request behind it (discovery at start, the periodic re-read) is the layer's own: the
// internal principal, signed with the same boot secret.
//
// The bridge's routes (the office answers: app/office_chat_bridge.py; the contract is in the unify build logs,
// uA-bridge.md "CONTRACT CHANGE (A)" and uB-layer.md):
//   GET  /api/office-bridge/agents                       { agents: [{ officeId, id, name, emoji, provider, transport, model, caps }] }
//   GET  /api/office-bridge/models?agent                 { models, effort }
//   GET  /api/office-bridge/sessions?agent               { sessions: [{ key, title, updatedAt }] }
//   POST /api/office-bridge/sessions/rename|delete       { agent, session[, title] }
//   GET  /api/office-bridge/history?agent&session        { messages, authoritative, usage, running }
//   POST /api/office-bridge/runs                         { agent, session ('' = a new chat), input, attachments } -> { runId, sessionKey|null }
//   GET  /api/office-bridge/runs/events?run&since        text/event-stream: `id: <n>` + `data: <event>`; ends after run.end
//   POST /api/office-bridge/stop                         { run }
//   POST /api/office-bridge/approve                      { run, approvalId, approved, decision }
// A new chat's key may come only with the run's events (Codex names its thread once it starts): the first one they
// carry is the chat's (onSessionKey).
import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EVENT_SPEC } from './providers/bus.js';
import { signPrincipal, PRINCIPAL_HEADER } from '../vo-router.mjs';

export const OFFICE_KIND = 'office';
export const OFFICE_LABEL = 'This office';
const BASE = '/api/office-bridge';
// the events a run may carry (every run-scoped one but run.start, which the layer sends itself when the run is taken)
const RUN_EVENTS = new Set(Object.entries(EVENT_SPEC).filter(([t, s]) => Object.hasOwn(s, 'runId') && t !== 'run.start').map(([t]) => t));
const CAP_NAMES = ['chat', 'sessions', 'models', 'effort', 'attachments', 'files', 'approvals', 'stop', 'tools', 'context', 'questions', 'plan', 'media'];
// (the office's provider ids, by the names its own window shows; an extension's id is its own name)
const PROVIDER_LABELS = { codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', antigravity: 'Antigravity', hermes: 'Hermes', 'hermes-api': 'Hermes' };
export const providerLabel = id => PROVIDER_LABELS[id] || String(id || 'Agent').replace(/[-_]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
const KEEP_MS = 10 * 60 * 1000;   // a finished run's office id, for a late stop or approval answer
const str = (v, n) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)).replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

const caller = new AsyncLocalStorage();
/** Runs fn with the X-VO-Principal of the request it serves (vo-host.mjs wraps every request). */
export function withCaller(header, fn) { return caller.run(header ? String(header) : null, fn); }

export class OfficeBridgeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Only the office server on this machine: http on a loopback address. Returns the URL or null. */
export function officeUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return null; }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) return null;
  return u;
}

/** An office agent's capabilities: the layer's names, true where it has them (unknown names dropped). */
export function capsOf(raw) {
  const out = {};
  if (raw && typeof raw === 'object') for (const k of CAP_NAMES) if (raw[k] === true) out[k] = true;
  out.chat = true;
  return out;
}

export class OfficeBridge {
  /**
   * @param {{ url: string, secret: string, bus: { emit: Function }, log?: object, onAgents?: (connectionId: number) => void,
   *   resyncMs?: number, retryMs?: number[], timeoutMs?: number }} o
   */
  constructor({ url, secret, bus, log = null, onAgents = null, onSessionKey = null, resyncMs = 60000, retryMs = [500, 1500, 4000], timeoutMs = 30000 }) {
    this.url = officeUrl(url);
    if (!this.url) throw new Error('VO_PL_OFFICE_URL must be an http address on this machine');
    Object.assign(this, { secret, bus, log, onAgents, onSessionKey, resyncMs, retryMs, timeoutMs });
    // (a fresh loopback connection per call, agent: false — the office's server closes its connections, and a reused one it
    // already closed would fail the call)
    this.host = this.url.hostname.replace(/^\[|\]$/g, ''); this.port = Number(this.url.port) || 80;
    this.links = new Map();   // connection id → { timer, state, sig }
    this.runs = new Map();    // the layer's run id → { office run id, connectionId, agentKey, sessionKey, principal, since, done, req }
    this.closed = false;
  }
  /** The handler for Chat's and AgentProviders' `inproc`. */
  get handler() { return (c, method, params) => this.handle(c, method, params || {}); }

  // ---------------------------------------------------------------- one request to the office
  principal() { return caller.getStore() || signPrincipal(this.secret, { role: 'owner', via: 'internal', authAt: 0, csrf: null }); }
  request(method, path, { query = null, body = null, principal = null, timeoutMs = this.timeoutMs } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))}` : '';
    const data = body === null ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({ host: this.host, port: this.port, agent: false, method, path: `${BASE}${path}${qs}`, timeout: timeoutMs,
        headers: { [PRINCIPAL_HEADER]: principal || this.principal(), accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
        const parts = []; let size = 0;
        res.on('data', d => { size += d.length; if (size <= 8 * 1048576) parts.push(d); });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(parts).toString('utf8') || 'null'); } catch { json = null; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json || {});
          const code = str(json && json.code, 60) || (res.statusCode === 404 ? 'not_found' : res.statusCode === 409 ? 'busy' : res.statusCode === 501 ? 'unsupported' : 'provider_error');
          reject(new OfficeBridgeError(res.statusCode === 501 ? 501 : res.statusCode >= 500 ? 502 : res.statusCode, code, str(json && (json.error || json.message), 500) || 'The office could not do that'));
        });
        res.on('error', e => reject(new OfficeBridgeError(502, 'unreachable', `The office did not answer: ${e.message}`)));
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', e => reject(new OfficeBridgeError(502, 'unreachable', `The office did not answer: ${e.message}`)));
      req.end(data || undefined);
    });
  }

  // ---------------------------------------------------------------- the calls
  async handle(c, method, p) {
    if (this.closed) throw new OfficeBridgeError(502, 'host_down', 'The layer is stopping');
    const cid = c ? c.id : Number(p.connectionId);
    const agent = str(p.agentKey, 120);
    switch (method) {
      case 'connect': return this.connect(cid);
      case 'disconnect': case 'forget': this.disconnect(cid); return {};
      case 'test': case 'refresh': { const r = await this.request('GET', '/agents'); return { ok: true, agents: (r.agents || []).length }; }
      case 'agents': return { agents: this.agentsOf(await this.request('GET', '/agents')) };
      case 'models': return this.request('GET', '/models', { query: { agent } });
      case 'sessions': {
        const r = await this.request('GET', '/sessions', { query: { agent } });
        return { sessions: (Array.isArray(r.sessions) ? r.sessions : []).filter(s => s && typeof s.key === 'string' && s.key)
          .map(s => ({ key: str(s.key, 300), title: str(s.title, 120), updatedAt: Number(s.updatedAt) || undefined })) };
      }
      case 'history': {
        const r = await this.request('GET', '/history', { query: { agent, session: p.sessionKey } });
        const messages = (Array.isArray(r.messages) ? r.messages : []).filter(m => m && typeof m === 'object' && typeof m.role === 'string')
          .map(m => ({ ...m, ts: Number(m.ts ?? m.at) || undefined }));
        return { messages, ...(r.authoritative ? { authoritative: true } : {}), ...(r.usage && typeof r.usage === 'object' ? { usage: r.usage } : {}),
          ...(r.session && typeof r.session === 'object' ? { session: r.session } : {}), ...(r.running ? { running: true } : {}) };
      }
      case 'patchSession': await this.request('POST', '/sessions/rename', { body: { agent, session: p.sessionKey, title: str(p.label, 120) } }); return {};
      case 'deleteSession': await this.request('POST', '/sessions/delete', { body: { agent, session: p.sessionKey } }); return {};
      case 'run': return this.run(cid, p);
      case 'stop': {
        const r = this.runs.get(String(p.runId));
        if (!r) throw new OfficeBridgeError(404, 'not_found', 'No such run');
        await this.request('POST', '/stop', { body: { run: r.run } });
        return {};
      }
      case 'approve': {
        const r = this.runs.get(String(p.runId));
        if (!r) throw new OfficeBridgeError(404, 'not_found', 'No such run');
        await this.request('POST', '/approve', { body: { run: r.run, approvalId: p.approvalId, approved: !!p.approved, ...(p.decision ? { decision: p.decision } : {}) } });
        return {};
      }
      default: throw new OfficeBridgeError(501, 'unsupported', 'This agent does not do that');
    }
  }

  /** The office's agents as the layer's discovery lists them: ext (its provider, what it can do) is kept per agent. */
  agentsOf(r) {
    const out = [];
    for (const x of Array.isArray(r && r.agents) ? r.agents : []) {
      const id = str(x && (x.officeId || x.id), 120);
      if (!id || out.some(o => o.id === id)) continue;
      const provider = str(x.provider, 60) || 'office', label = str(x.providerLabel, 60) || providerLabel(provider);
      out.push({ id, name: str(x.name, 60) || id, emoji: str(x.emoji, 32), role: str(x.role, 60) || `${label} agent`,
        ext: { provider, providerLabel: label, ...(str(x.transport, 40) ? { transport: str(x.transport, 40) } : {}), ...(str(x.model, 120) ? { model: str(x.model, 120) } : {}), caps: capsOf(x.caps) } });
      if (out.length >= 200) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- the link: is the office answering, and its agents
  async connect(cid) {
    let l = this.links.get(cid);
    if (!l) { l = { timer: null, state: null, sig: null }; this.links.set(cid, l); }
    await this.check(cid);
    return {};
  }
  disconnect(cid) {
    const l = this.links.get(cid);
    if (l && l.timer) clearTimeout(l.timer);
    this.links.delete(cid);
  }
  /** Reads the office's agents: tells the layer the link's state when it changes (connected: AgentProviders lists the
   *  agents), and the agents again when the list changed; then again after resyncMs (sooner while it is not answering). */
  async check(cid) {
    const l = this.links.get(cid);
    if (!l || this.closed) return;
    if (l.timer) { clearTimeout(l.timer); l.timer = null; }
    let state = 'connected', detail = '', sig = l.sig;
    try { sig = JSON.stringify(this.agentsOf(await this.request('GET', '/agents', { principal: this.principal(), timeoutMs: 10000 }))); }
    catch (e) { state = 'offline'; detail = e.message; }
    if (!this.links.has(cid) || this.closed) return;
    const was = l.state;
    l.state = state;
    if (state !== was) this.emit({ type: 'provider.status', kind: OFFICE_KIND, connectionId: String(cid), state, ...(detail ? { detail } : {}) });
    else if (state === 'connected' && sig !== l.sig && this.onAgents) { try { this.onAgents(cid); } catch { /* listed next time */ } }
    l.sig = sig;
    l.timer = setTimeout(() => this.check(cid).catch(() => {}), state === 'connected' ? this.resyncMs : Math.min(this.resyncMs, 5000));
    l.timer.unref?.();
  }
  /** The office's agents changed (it said so): read them now. */
  poke() { for (const cid of this.links.keys()) this.check(cid).catch(() => {}); }

  // ---------------------------------------------------------------- runs
  async run(cid, p) {
    const principal = this.principal();
    const lazy = !p.sessionKey || String(p.sessionKey).startsWith('@');   // (sessions.js LAZY_KEY: a new chat)
    const files = (Array.isArray(p.attachments) ? p.attachments : []).map(f => ({ name: str(f.name, 200), mime: str(f.mime, 120), size: Number(f.size) || 0, path: String(f.path || '') }));
    const out = await this.request('POST', '/runs', { principal, body: { agent: str(p.agentKey, 120), session: lazy ? '' : String(p.sessionKey), input: String(p.input ?? ''),
      attachments: files, ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}), ...(p.sender ? { sender: p.sender } : {}), layerRun: String(p.runId) } });
    const run = str(out && (out.runId || out.run), 200);
    if (!run) throw new OfficeBridgeError(502, 'provider_error', 'The office did not start the run');
    const sessionKey = str(out.sessionKey || out.session, 300) || (lazy ? '' : String(p.sessionKey));
    const r = { run, connectionId: String(cid), agentKey: str(p.agentKey, 120), sessionKey, principal, since: 0, done: false, req: null, tries: 0 };
    this.runs.set(String(p.runId), r);
    this.emit({ type: 'run.start', runId: String(p.runId), agentKey: r.agentKey, kind: OFFICE_KIND, connectionId: r.connectionId, sessionKey: r.sessionKey || undefined });
    // (after the layer has the run's session key: the first event may come at once)
    setImmediate(() => this.follow(String(p.runId)));
    return { runId: String(p.runId), ...(sessionKey ? { sessionKey } : {}) };
  }
  /** Follows a run's events (server-sent, replayed after `since`): each on the bus as the layer's; a dropped stream is
   *  read again from where it stopped, a few times; then the run ends interrupted (never sent again). */
  follow(id) {
    const r = this.runs.get(id);
    if (!r || r.done || this.closed) return;
    const req = http.request({ host: this.host, port: this.port, agent: false, method: 'GET',
      path: `${BASE}/runs/events?${new URLSearchParams({ run: r.run, since: String(r.since) })}`,
      headers: { [PRINCIPAL_HEADER]: r.principal, accept: 'text/event-stream' } });
    r.req = req;
    let buf = '', gotAny = false, over = false;
    const lost = why => {
      if (over) return;
      over = true;
      if (r.req === req) r.req = null;
      if (r.done || this.closed) return;
      if (gotAny) r.tries = 0;   // (it was answering: a fresh set of tries)
      r.tries += 1;
      if (r.tries > this.retryMs.length) { this.end(id, { status: 'interrupted', error: `The office stopped answering (${why}).` }); return; }
      const t = setTimeout(() => this.follow(id), this.retryMs[r.tries - 1]); t.unref?.();
    };
    req.on('response', res => {
      if (res.statusCode !== 200) {
        res.resume();
        if (res.statusCode === 404) { over = true; this.end(id, { status: 'interrupted', error: 'The office no longer knows this run.' }); return; }
        lost(`status ${res.statusCode}`);
        return;
      }
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buf += chunk;
        if (buf.length > 4 * 1048576) { req.destroy(); return; }
        let k;
        while ((k = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, k);
          buf = buf.slice(k + (buf[k] === '\r' ? 4 : 2));
          let seq = null; const data = [];
          for (const line of block.split(/\r?\n/)) {
            if (!line || line.startsWith(':')) continue;
            const i = line.indexOf(':'), field = i < 0 ? line : line.slice(0, i), value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
            if (field === 'id') seq = value; else if (field === 'data') data.push(value);
          }
          if (!data.length) continue;
          let e;
          try { e = JSON.parse(data.join('\n')); } catch { continue; }
          gotAny = true;
          if (seq !== null && Number.isFinite(Number(seq))) r.since = Number(seq);
          this.onRunEvent(id, e);
          if (r.done) { req.destroy(); return; }
        }
      });
      res.on('end', () => lost('the stream ended'));
      res.on('error', () => {});
      res.on('close', () => { if (!r.done) lost('the stream closed'); });
    });
    req.on('error', e => lost(e.message));
    req.end();
  }
  onRunEvent(id, e) {
    const r = this.runs.get(id);
    if (!r || r.done || !e || typeof e !== 'object') return;
    // (a new chat: its key, once the provider has named it, is the chat's from now on)
    if (!r.sessionKey && typeof e.sessionKey === 'string' && e.sessionKey) {
      r.sessionKey = str(e.sessionKey, 300);
      if (this.onSessionKey) { try { this.onSessionKey(id, r.sessionKey); } catch (err) { this.log?.warn?.('[office] the chat\'s key was not kept:', err.message); } }
    }
    if (!RUN_EVENTS.has(e.type)) return;
    if (e.type === 'run.end') { this.end(id, e); return; }
    this.emit({ ...e, runId: id, kind: OFFICE_KIND, connectionId: r.connectionId, agentKey: r.agentKey, sessionKey: r.sessionKey || undefined });
  }
  end(id, e) {
    const r = this.runs.get(id);
    if (!r || r.done) return;
    r.done = true;
    if (r.req) { try { r.req.destroy(); } catch { /* gone */ } r.req = null; }
    this.emit({ ...e, type: 'run.end', runId: id, status: ['ok', 'error', 'stopped', 'interrupted'].includes(e.status) ? e.status : 'error',
      kind: OFFICE_KIND, connectionId: r.connectionId, agentKey: r.agentKey, sessionKey: r.sessionKey || undefined });
    const t = setTimeout(() => this.runs.delete(id), KEEP_MS); t.unref?.();
  }
  emit(e) {
    try { this.bus.emit(e); } catch (err) { this.log?.warn?.('[office] an event was not passed on:', err.message); }
  }

  /** The layer is stopping: no more reading; runs still going end interrupted (the layer's rule: never sent again). */
  close() {
    for (const [id, r] of this.runs) if (!r.done) this.end(id, { status: 'interrupted', error: 'The office chat restarted.' });
    this.closed = true;
    for (const cid of [...this.links.keys()]) this.disconnect(cid);
  }
}
