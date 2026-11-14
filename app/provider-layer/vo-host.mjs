// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The provider layer's process (OpenClaw and Hermes, from My Virtual World): started and watched by the office server
// (server.py), loopback only, reached through the office server's proxy. It builds what My Virtual World's index.mjs
// builds for its providers (index.mjs:327-360, :715, :1723-1737 at 620b23ce): the registry (OpenClaw and Hermes only),
// the event bus, the supervised helper process with the two adapters, Connections, AgentProviders, Chat with its
// sessions, transcripts, attachments, references, projects and provider media, and the agents' screen relay.
//
// Environment (set by server.py):
//   VO_PL_DATA         the layer's data folder (next.db, chat/, attachments/, provider-media/)
//   VO_PL_PORT         the loopback port to answer on
//   VO_PL_SECRET_FILE  a 0600 file holding this boot's secret (signs X-VO-Principal); never in argv
//   VO_PL_KEY_FILE     the key for stored secrets (default: <VO_PL_DATA>/../provider-layer.key, outside the layer's data)
//   VO_PL_TEST=1       also loads My Virtual World's mock provider (tests)
//   VO_PL_OFFICE_DATA  the office's data folder, for the 0.10 saved connections (default: <VO_PL_DATA>/..)
//   VO_PL_OFFICE_URL   the office server's own address on this machine (http://127.0.0.1:<port>): its chat bridge, through
//                      which the office's other providers (Codex, Claude Code ...) chat in the same window (kind `office`,
//                      server/office-bridge.mjs). Unset: no kind `office`, the layer as before.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { openDb } from './server/db.js';
import { SecretBox, KeyConfigError, unreadableHelp } from './server/secrets.js';
import { registerSecretHolders } from './server/secret-holders.js';
import { Permissions } from './server/auth/permissions.js';
import { Registry } from './server/providers/registry.js';
import { BUILTIN_MANIFESTS } from './server/providers/manifest.js';
import { EventBus } from './server/providers/bus.js';
import { ProviderHost } from './server/providers/host.js';
import { Connections } from './server/connections.js';
import { Agents, peopleResolver } from './server/agents.js';
import { AgentProviders, isProviderKey } from './server/agent-providers.js';
import { Attachments } from './server/chat/attachments.js';
import { References } from './server/chat/references.js';
import { ProviderMedia } from './server/chat/provider-media.js';
import { Chat } from './server/chat/chat.js';
import { Sessions, LAZY_KEY } from './server/chat/sessions.js';
import { Transcripts } from './server/chat/transcript.js';
import { Projects } from './server/chat/projects.js';
import { ScreenRelay, PATH as SCREEN_WS } from './server/providers/screen-relay.js';
import { addProviderRoutes } from './server/provider-routes.mjs';
import { Voice } from './server/voice/voice.js';
import { addVoiceRoutes } from './server/voice/routes.js';
import { addOfficeVoiceRoutes, officeVoiceConfig, adoptOfficeWhisper } from './vo-voice.mjs';
import { Router, handleApi, readPrincipal, principalOf, PRINCIPAL_HEADER, OFFICE_ACCOUNT, sendJSON } from './vo-router.mjs';
import { migrateOffice, adoptOpenClaw } from './vo-migrate.mjs';
import { BusState } from './vo-bus-state.mjs';
import { OfficeAgents } from './vo-agents-bridge.mjs';
import { OfficeBridge, OFFICE_KIND, OFFICE_LABEL, withCaller } from './server/office-bridge.mjs';

export const KINDS = Object.freeze(['openclaw', 'hermes', 'voice']);   // (voice: Settings → Voice's services, vo-voice.mjs)
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS_PATH = '/api/pl/ws';

/** Log lines "time level [pl] message", with every secret this process handled scrubbed. */
function makeLog(known) {
  const scrub = s => { let t = String(s); for (const k of known) if (k && t.includes(k)) t = t.split(k).join('***'); return t; };
  const out = (level, args) => process.stdout.write(`${new Date().toISOString()} ${level} ${scrub(args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))}\n`);
  const log = (...a) => out('info', a);
  log.info = (...a) => out('info', a); log.warn = (...a) => out('warn', a); log.error = (...a) => out('error', a); log.debug = () => {};
  return log;
}

/** The office's two accounts in next.db: the office itself (owner) and the office's agents (member, agent token). */
function ensureAccounts(dbs) {
  const now = Date.now();
  const ins = dbs.db.prepare(`INSERT OR IGNORE INTO accounts (id, world_id, login, display_name, display_key, role, password_hash, password_changed, created, updated, no_password)
    VALUES (?, ?, ?, ?, ?, ?, '!', ?, ?, ?, 1)`);
  for (const role of ['owner', 'member']) {
    const a = OFFICE_ACCOUNT[role];
    ins.run(a.id, dbs.worldId, a.login, a.displayName, a.login, role, now, now, now);
  }
}

/** Builds the layer; returns { server, close, ... }. Exported for tests. */
export async function createHost({ data, secret, keyFile = null, officeDir = null, test = false, log = null, adapters = null, find = null, officeUrl = null, officeOpts = null } = {}) {
  if (!data) throw new Error('VO_PL_DATA is required');
  if (!secret) throw new Error('the principal secret is required');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const box = new SecretBox();
  log = log || makeLog(box.known);
  const dbs = openDb(data);
  ensureAccounts(dbs);
  registerSecretHolders(box, dbs);
  const k = box.load({ env: { MVW_KEY_FILE: keyFile || path.join(path.dirname(path.resolve(data)), 'provider-layer.key') }, dataDir: data });
  for (const w of k.warnings) log.warn('[secrets]', w);
  if (k.created) log(`[secrets] created the key file ${k.file}; back it up separately from the office data`);
  const bad = box.unreadable();
  if (bad.length) throw new KeyConfigError(unreadableHelp(bad, box));
  const perms = new Permissions(dbs);

  // (the office's own kind is always listed — hidden — so its connection and agents stay known while the bridge is off)
  const registry = new Registry({ manifests: BUILTIN_MANIFESTS.filter(m => KINDS.includes(m.id) || m.id === OFFICE_KIND), allowTest: test });
  const providerBus = new EventBus({ log });
  // the office's other providers, answered in this process through the office server's chat bridge (unify)
  let officeBridge = null;
  if (officeUrl) {
    // (onSessionKey: a new chat's key named by the provider only once its run started — Codex's thread — is the chat's)
    const onSessionKey = (runId, key) => {
      const r = chat.runs.get(runId), s = r && chat.sessions.get(r.accountId, r.sessionId);
      if (s && s.key === LAZY_KEY) chat.sessions.setKey(s.id, key);
    };
    try { officeBridge = new OfficeBridge({ url: officeUrl, secret, bus: providerBus, log, onAgents: id => agentProviders.syncSoon(id), onSessionKey, ...(officeOpts || {}) }); registry.addInProcess(OFFICE_KIND); }
    catch (e) { log.warn('[office] the office chat bridge is off:', e.message); }
  }
  const inproc = officeBridge ? { [OFFICE_KIND]: officeBridge.handler } : {};
  const adapterPath = f => path.join(HERE, 'server', 'providers', f);
  const host = new ProviderHost({ adapters: adapters || [adapterPath('openclaw/adapter.js'), adapterPath('hermes/adapter.js'), adapterPath('voice.js'), ...(test ? [adapterPath('mock.js')] : [])], bus: providerBus, registry, log });
  host.start().catch(e => log.warn('[providers] the helper did not start:', e.message));
  const audit = auditLog(path.join(officeDir || path.dirname(path.resolve(data)), 'provider-audit.log'));
  const connections = new Connections(dbs, { box, registry, host, can: (P, cap) => perms.allowed(P, cap), log, audit });
  const agents = new Agents(dbs, { resolver: peopleResolver(() => []), log });
  // (the office's 0.10 saved OpenClaw and Hermes connections, once, before any connection opens: vo-migrate.mjs)
  try { migrateOffice({ dbs, box, registry, data, officeDir, log }); } catch (e) { log.error('[migrate] the saved connections were not moved:', e.message); }

  // the office's live sockets (/api/pl/ws, relayed by the office server): frames to one account, or to whoever a rule picks
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const sendToAccount = (accountId, frame) => {
    const text = JSON.stringify(frame);
    for (const ws of wss.clients) if (ws.readyState === 1 && ws.P && ws.P.account && ws.P.account.id === accountId) ws.send(text);
  };
  const pushWhere = (pred, frame) => {
    const text = JSON.stringify(frame);
    for (const ws of wss.clients) if (ws.readyState === 1 && ws.P && ws.P.account && pred(ws.P)) ws.send(text);
  };
  const agentProviders = new AgentProviders({ connections, registry, host, bus: providerBus, agents, push: pushWhere, log, find, audit, inproc }).start();
  // (each listed agent's office id, desk and roster place: vo-agents-bridge.mjs)
  const officeAgents = new OfficeAgents({ dbs, agents, connections, log });
  agentProviders.useBodies(officeAgents);
  // (the pages' agent lists follow the records: a provider's agents listed again — the office's own after it changed —
  // reach the open pickers at once; vo-mount reloads its agents on an 'agents' frame)
  let agentsSoon = null;
  agents.listeners.add(() => { clearTimeout(agentsSoon); agentsSoon = setTimeout(() => { try { pushWhere(() => true, { t: 'agents' }); } catch { /* the pages read them next time */ } }, 300); agentsSoon.unref?.(); });
  // the office's own connection ("This office", hidden): opened now, whatever the helper does; with the bridge off, its
  // agents are switched off (they come back, same records and office ids, when it is on again)
  if (officeBridge) {
    const { connection: oc } = connections.ensureInternal(OFFICE_KIND, OFFICE_LABEL);
    if (oc.enabled) agentProviders.open(oc);
  } else {
    for (const oc of connections.list().filter(c => c.kind === OFFICE_KIND)) {
      for (const a of agents.list()) if (a.connectionId === oc.id && a.enabled) { agents.update(a.id, { enabled: false }); agentProviders.followBody(agents.get(a.id), false); }
    }
  }
  const attachments = new Attachments(dbs, path.join(data, 'attachments'), {
    limits: () => ({ maxBytes: Number(perms.setting('chat.attachmentMaxMb', '25')) * 1048576, quotaBytes: Number(perms.setting('chat.attachmentQuotaMb', '2048')) * 1048576 }),
  });
  const references = new References(dbs);
  const providerMedia = new ProviderMedia({ dbs, box, dir: path.join(data, 'provider-media'), log });
  // (the office: every agent may chat, no Work modes, nothing the server answers itself)
  const chat = new Chat({ media: providerMedia, agents, connections, registry, host, bus: providerBus, sessions: new Sessions(dbs), transcripts: new Transcripts(dbs, { root: path.join(data, 'chat'), log }), attachments, references, projects: new Projects(dbs),
    agentOk: () => true, agentShown: () => true, send: sendToAccount, log, inproc });
  // the voice (My Virtual World's server/voice/, vo-voice.mjs): Settings → Voice's services, each agent's own voice. As for
  // chat, every agent may be heard by whoever may chat (agentOk above); only the office's owners manage an agent's voice.
  const voiceAgents = { get: id => agents.get(id), list: () => agents.list(), update: (id, patch, actor) => agents.update(id, patch, actor),
    isOwner: (P, a) => agents.isOwner(P, a), canManage: (P, a) => agents.canManage(P, a), canUse: (P, a) => !!(a && a.enabled && P && P.account) };
  const voice = new Voice({ dbs, agents: voiceAgents, connections, registry, host, chat, log,
    principalFor: ownerId => principalOf({ role: ownerId === OFFICE_ACCOUNT.member.id ? 'member' : 'owner', via: 'internal' }),
    config: () => officeVoiceConfig(perms) });
  try { adoptOfficeWhisper({ perms, connections, P: principalOf({ role: 'owner', via: 'internal' }), officeDir: officeDir || path.dirname(path.resolve(data)), log }); }
  catch (e) { log.warn('[voice] the office\'s Whisper server was not adopted:', e.message); }

  const principal = req => principalOf(readPrincipal(secret, req.headers[PRINCIPAL_HEADER]));
  const screenRelay = new ScreenRelay({
    principal,
    originAllowed: () => true,   // (the office server checked the page's origin before relaying)
    ticketFor: async (P, agentId) => {
      if (!perms.allowed(P, 'chat.use')) throw Object.assign(new Error('forbidden'), { status: 403 });
      return chat.screenTicket(P, agentId);
    },
    allowed: (P, agentId) => { if (!perms.allowed(P, 'chat.use')) return false; chat.screenOf(P, agentId); return true; },
    log,
  });

  // ---------------------------------------------------------------- routes
  const router = new Router();
  const ok = (json, status = 200) => ({ status, json });
  addProviderRoutes(router, { registry, host, connections, agentProviders, chat, references, attachments, agents });
  addVoiceRoutes(router, voice);
  addOfficeVoiceRoutes(router, { voice, perms, connections });
  const health = () => ({ ok: true, host: host.status(), helperPid: host.child?.pid ?? null, pid: process.pid, kinds: registry.list().filter(m => m.implemented).map(m => m.id),
    clients: wss.clients.size, screens: screenRelay.open.size });
  router.add({ method: 'GET', path: '/api/pl/health', cap: 'chat.use', handler: () => ok(health()) });
  router.add({ method: 'GET', path: '/api/pl/internal/health', cap: 'chat.use', internal: true, handler: () => ok(health()) });
  // what the page needs to know about its caller (core/auth.js)
  router.add({ method: 'GET', path: '/api/pl/me', cap: 'chat.use', handler: ({ P }) => ok({
    account: { ...P.account }, role: P.role, via: P.via, caps: perms.capsFor(P), csrf: P.session.csrf,
    reauthLeftMs: Math.max(0, P.session.authAt + 10 * 60 * 1000 - Date.now()) }) });
  // the agents the caller may chat with (core/state.js S.agentList)
  router.add({ method: 'GET', path: '/api/pl/agents', cap: 'chat.use', handler: ({ P }) => ok({ agents: agents.enabled().filter(a => agents.canUse(P, a)).map(a => {
    const o = { id: a.id, key: a.key, name: a.name, emoji: a.emoji, role: a.role, i: -1, level: agents.level(P, a), mine: agents.isOwner(P, a) };
    if (isProviderKey(a.key)) { const c = connections.get(a.connectionId), m = c && registry.manifest(c.kind); if (c && m) o.provider = { kind: c.kind, label: m.label, connection: c.label, connectionId: c.id }; }
    // (an agent of the office's own providers: its provider's name — "Codex" — and id; the connection is "This office")
    if (o.provider && o.provider.kind === OFFICE_KIND) { const x = a.ext && a.ext.office; o.provider.label = (x && x.providerLabel) || o.provider.label; o.provider.provider = (x && x.provider) || null; o.provider.model = (x && x.model) || null; }
    o.officeId = officeAgents.officeIdOf(a.id);
    return o;
  }) }) });
  // (tests only, VO_PL_TEST=1: an agent of the mock provider, which lists none of its own)
  if (test) router.add({ method: 'POST', path: '/api/pl/test/agent', cap: 'connections.manage', handler: ({ body }) => ok({ agent: agents.create({
    key: `prov-${Number(body.connectionId)}-${String(body.nativeId)}`, name: String(body.name || body.nativeId), connectionId: Number(body.connectionId), nativeId: String(body.nativeId) }) }) });
  // every bus event, for the office server (Office Life, presence, Agent PC): server-sent events, the office server only
  const busClients = new Set();
  // (what goes on now — connections, agents mid-run, open runs and their running steps — told first to a listener that
  //  (re)connects: the layer reaches its gateways before the office server listens, and a state is told once: vo-bus-state.mjs)
  const busState = new BusState();
  // (not the office's own kind: those runs are the office server's, which reports them itself — told twice they would count twice)
  const toBus = e => {
    if (e && e.kind === OFFICE_KIND) return;
    busState.take(e);
    if (!busClients.size) return;
    const line = `data: ${JSON.stringify(e)}\n\n`; for (const res of busClients) res.write(line);
  };
  providerBus.on(toBus);
  officeAgents.listeners.add(toBus);
  // the office id of every layer agent (server.py's id map and roster)
  router.add({ method: 'GET', path: '/api/pl/internal/office-agents', cap: 'chat.use', internal: true, handler: () => ok({ agents: officeAgents.list() }) });
  // the office server's own OpenClaw calls (its New agent wizard, chat list, skills workshop, gateway restart, progress
  // cards): through this layer's link, so they work wherever the layer does and never open a second pairing.
  // A gateway's refusal is { ok: false, error } (200), as the gateway said it; not reaching the gateway is 503.
  const NOT_REACHED = new Set(['host_down', 'timeout', 'not_connected', 'pairing', 'unreachable', 'not_configured', 'switched_off']);
  const officeCall = async fn => {
    try { return ok({ ok: true, ...(await fn()) }); } catch (e) {
      const code = String(e.code || 'provider_error'), error = { code, message: String(e.message || 'OpenClaw failed').slice(0, 500), ...(e.fix ? { fix: String(e.fix).slice(0, 500) } : {}) };
      return ok({ ok: false, error }, NOT_REACHED.has(code) ? (code === 'not_configured' || code === 'switched_off' ? 409 : 503) : e.status === 404 ? 404 : 200);
    }
  };
  router.add({ method: 'POST', path: '/api/pl/internal/openclaw/call', cap: 'chat.use', internal: true, handler: ({ body }) => officeCall(() => agentProviders.office(
    body && body.connection, body && body.method, body && body.params, body && body.timeoutMs)) });
  router.add({ method: 'POST', path: '/api/pl/internal/openclaw/status', cap: 'chat.use', internal: true, handler: ({ body }) => officeCall(() => agentProviders.officeStatus(body && body.connection)) });
  // a gateway the office's setup wizard saved becomes the layer's OpenClaw connection while it has none yet (vo-migrate.mjs)
  router.add({ method: 'POST', path: '/api/pl/internal/openclaw/adopt', cap: 'chat.use', internal: true, handler: ({ body }) => {
    const r = adoptOpenClaw({ dbs, box, registry, data, url: body && body.url, token: body && body.token, log });
    if (r.connectionId && r.adopted) connections.fire(r.connectionId, 'create');
    return ok(r);
  } });
  // the office's agents changed (its /agents-list): read them again now, not at the next minute
  router.add({ method: 'POST', path: '/api/pl/internal/office/sync', cap: 'chat.use', internal: true, handler: () => {
    if (!officeBridge) return ok({ ok: false, error: { code: 'not_configured', message: 'The office chat bridge is off' } }, 409);
    officeBridge.poke();
    return ok({ ok: true });
  } });
  router.add({ method: 'GET', path: '/api/pl/internal/bus', cap: 'chat.use', internal: true, handler: ({ req, res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`: vo provider layer bus\n\n`);
    for (const e of busState.replay()) res.write(`data: ${JSON.stringify(e)}\n\n`);
    busClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); busClients.delete(res); });
    return undefined;
  } });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      // (who asked, for the office chat bridge: the office checks its own rules again on every call it gets from here)
      if (url.pathname.startsWith('/api/')) return await withCaller(req.headers[PRINCIPAL_HEADER], () => handleApi(req, res, url, { router, perms, secret, log }));
      sendJSON(req, res, 404, { error: 'Not found', code: 'not_found' });
    } catch (e) {
      log.error('[pl] request', e && e.message);
      if (!res.headersSent) sendJSON(req, res, 500, { error: 'The provider layer failed', code: 'internal_error' });
      else res.destroy();
    }
  });
  server.on('upgrade', (req, sock, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* refused below */ }
    if (pathname === SCREEN_WS) { screenRelay.handle(req, sock, head).catch(e => { log.error('[screen] relay', e.message); sock.destroy(); }); return; }
    if (pathname !== WS_PATH) return sock.destroy();
    const P = principal(req);
    if (!P || P.via === 'internal') { sock.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(req, sock, head, ws => {
      ws.P = P;
      ws.on('error', () => {});
      ws.on('message', () => {});   // (the office page only listens)
      ws.send(JSON.stringify({ t: 'hello', account: P.account.id, role: P.role }));
    });
  });

  let closed = false;
  async function close() {
    if (closed) return; closed = true;
    for (const res of busClients) { try { res.end(); } catch { /* gone */ } }
    try { screenRelay.close(); } catch { /* closing */ }
    for (const ws of wss.clients) { try { ws.close(1001, 'office stopping'); } catch { /* gone */ } }
    if (officeBridge) officeBridge.close();
    clearTimeout(agentsSoon);
    agentProviders.stop();
    await host.stop().catch(() => {});
    await new Promise(r => server.close(() => r()));
    server.closeAllConnections?.();
    try { dbs.db.close(); } catch { /* closed */ }
  }
  return { server, close, host, router, registry, connections, agents, agentProviders, officeAgents, chat, voice, providerBus, perms, dbs, officeBridge };
}

/** The office's provider-audit.log (the 0.10 file, same place): one line per change to an agent platform's settings
 *  or to a connection: what and which, never a value or a secret. */
export function auditLog(file) {
  return {
    log(event, { actor = null, detail = {} } = {}) {
      const d = detail || {};
      const line = { at: new Date().toISOString(), event, connection: d.id === undefined ? undefined : String(d.id), kind: d.kind, method: d.method,
        fields: d.fields, secretsChanged: d.secretsChanged, by: actor && actor.login ? String(actor.login) : undefined };
      try { fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 }); } catch { /* a line not written never stops the change */ }
    },
  };
}

/** Where Agent Providers' "Find" looks first: the office's own gateway setting (VO_GATEWAY_URL, Docker's
 *  ws://host.docker.internal:18789 by default); VO_PL_FIND (comma list) replaces the built-in places. */
export function findPlaces(env) {
  const list = v => String(v || '').split(',').map(x => x.trim()).filter(u => /^wss?:\/\//.test(u));
  const only = list(env.VO_PL_FIND);
  return { places: { openclaw: [...only, ...list(env.VO_GATEWAY_URL)] }, only: only.length > 0 };
}

// ---------------------------------------------------------------- run as the office's process
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const port = Number(env.VO_PL_PORT);
  let secret = '';
  try { secret = fs.readFileSync(String(env.VO_PL_SECRET_FILE || ''), 'utf8').trim(); } catch { /* checked below */ }
  if (!secret || !Number.isInteger(port) || port <= 0) {
    process.stderr.write('vo-host: VO_PL_PORT and a readable VO_PL_SECRET_FILE are required (the office server sets them)\n');
    process.exit(2);
  }
  let h;
  try {
    h = await createHost({ data: env.VO_PL_DATA, secret, keyFile: env.VO_PL_KEY_FILE || null, officeDir: env.VO_PL_OFFICE_DATA || null, test: env.VO_PL_TEST === '1', find: findPlaces(env),
      officeUrl: env.VO_PL_OFFICE_URL || null });
  } catch (e) {
    process.stderr.write(`vo-host: ${e instanceof KeyConfigError ? e.message : e.stack || e.message}\n`);
    process.exit(e instanceof KeyConfigError ? 3 : 1);
  }
  h.server.listen(port, '127.0.0.1', () => process.stdout.write(`${new Date().toISOString()} info [pl] listening on 127.0.0.1:${port}\n`));
  h.server.on('error', e => { process.stderr.write(`vo-host: ${e.message}\n`); process.exit(1); });
  let stopping = false;
  const stop = sig => {
    if (stopping) return; stopping = true;
    process.stdout.write(`${new Date().toISOString()} info [pl] ${sig}: stopping\n`);
    h.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  // (the office server went away without stopping us: stop too, never linger as an orphan)
  // (EPERM: the office runs as root and this layer as the data folder's owner; the parent is there)
  if (env.VO_PL_PARENT_PID) setInterval(() => { try { process.kill(Number(env.VO_PL_PARENT_PID), 0); } catch (e) { if (e.code !== 'EPERM') stop('parent gone'); } }, 2000).unref();
}
