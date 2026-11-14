// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The provider, connection and chat routes of the provider layer: My Virtual World's route block (routes.js:669-859 at
// 620b23ce, inside createApi) taken as it is, in a module of its own. d = { registry, host, connections, agentProviders,
// chat, references, attachments, agents }. Each route names the capability it needs; vo-router.mjs checks it, the CSRF
// token and re-authentication before a handler runs.
import fs from 'node:fs';
import { AuthError, LIMITS } from '../vo-router.mjs';
import { ConnectionError } from './connections.js';
import { ProviderError } from './agent-providers.js';
import { HostError } from './providers/host.js';
import { ChatError } from './chat/chat.js';
import { INLINE as INLINE_MEDIA } from './chat/provider-media.js';
import { AttachmentError } from './chat/attachments.js';

export function addProviderRoutes(router, d) {
  const ok = (json, status = 200, headers = null) => ({ status, json, headers });
  const actorOf = P => (P.account ? { id: P.account.id, login: P.account.login } : null);

  // ---------------------------------------------------------------- providers and connections (WP2.2; DECISIONS C60, A8, A9)
  const connCall = async fn => {
    try { return ok(await fn()); } catch (e) {
      if (e instanceof ConnectionError) throw new AuthError(e.status, e.code, e.message);
      throw e;
    }
  };
  const connId = body => { const n = Number(body && body.id); if (!Number.isInteger(n) || n < 1) throw new AuthError(400, 'bad_request', 'Which connection?'); return n; };
  // Every kind that works (nothing announces adapters still to come), whether this account may add one
  // (d.connections.addable: the same rule create() keeps), and the helper's state.
  // (a credential the server keeps for a connection itself — system: a device key — is never a field of a form)
  // (My Virtual Office: an internal kind — the office's own providers — is never listed: nobody adds or picks it)
  const pageKind = (P, k) => ({ ...k, fields: k.fields.filter(f => !f.system), addable: d.connections.addable(P, k) });
  router.add({ method: 'GET', path: '/api/providers', cap: 'connections.use', handler: ({ P }) => ok({
    kinds: d.registry.list().filter(k => k.implemented && !k.internal).map(k => pageKind(P, k)), host: d.host.status() }) });
  router.add({ method: 'GET', path: '/api/connections', cap: 'connections.use', handler: ({ P }) => ok({ connections: d.connections.visible(P).map(c => d.connections.view(P, c)) }) });
  router.add({ method: 'POST', path: '/api/connections', cap: 'connections.use', handler: ({ P, body }) => connCall(() => d.connections.view(P, d.connections.create(P, body || {}, actorOf(P)))) });
  router.add({ method: 'POST', path: '/api/connections/update', cap: 'connections.use', handler: ({ P, body }) => connCall(() => d.connections.view(P, d.connections.update(P, connId(body), body, actorOf(P)))) });
  router.add({ method: 'POST', path: '/api/connections/remove', cap: 'connections.use', handler: ({ P, body }) => connCall(() => ({ removed: d.connections.remove(P, connId(body), actorOf(P)).id })) });
  router.add({ method: 'POST', path: '/api/connections/share', cap: 'connections.use', handler: ({ P, body }) => connCall(() => ({ shares: d.connections.share(P, connId(body), body.kind, body.who, actorOf(P)) })) });
  router.add({ method: 'POST', path: '/api/connections/unshare', cap: 'connections.use', handler: ({ P, body }) => connCall(() => ({ shares: d.connections.unshare(P, connId(body), body.kind, body.who, actorOf(P)) })) });
  for (const action of ['test', 'refresh', 'discover']) {
    router.add({ method: 'POST', path: `/api/connections/${action}`, cap: 'connections.use', handler: ({ P, body }) => connCall(() => d.connections.probe(P, connId(body), action, actorOf(P))) });
  }

  // ---------------------------------------------------------------- Agent Providers (docs/features/agent-providers.md)
  // The live provider connections (OpenClaw): their state, their agents; finding one on this machine (administrators: it
  // looks at this machine and the local network); connecting one again now; listing its agents again.
  const provCall = async fn => {
    try { return ok(await fn()); } catch (e) {
      if (e instanceof ProviderError || e instanceof ConnectionError) throw new AuthError(e.status, e.code, e.message);
      // (what the provider refused, in its own words: a request it found wrong — a stale base hash, a bad value — is the
      // person's to fix; anything else is the provider's or the link's)
      // (conflict: changed elsewhere meanwhile — read again; not_found: gone on the provider; unavailable: busy, retry shortly)
      if (e instanceof HostError) throw new AuthError(['INVALID_REQUEST', 'unsupported', 'bad_request', 'conflict'].includes(e.code) ? 400 : e.code === 'not_found' ? 404 : ['UNAVAILABLE', 'unavailable'].includes(e.code) ? 503 : 502, e.code || 'provider_error', e.message || 'The provider failed');
      throw e;
    }
  };
  router.add({ method: 'GET', path: '/api/agent-providers', cap: 'connections.use', handler: ({ P }) => ok({
    providers: d.agentProviders.list(P), kinds: d.registry.list().filter(k => k.implemented && k.live && !k.internal).map(k => pageKind(P, k)), host: d.host.status() }) });
  router.add({ method: 'POST', path: '/api/agent-providers/detect', cap: 'connections.manage', handler: ({ body }) => provCall(() => d.agentProviders.detect(String((body && body.kind) || ''))) });
  router.add({ method: 'POST', path: '/api/agent-providers/reconnect', cap: 'connections.use', handler: ({ P, body }) => provCall(() => d.agentProviders.reconnect(P, connId(body))) });
  router.add({ method: 'POST', path: '/api/agent-providers/remove', cap: 'connections.use', handler: ({ P, body }) => provCall(() => d.agentProviders.remove(P, connId(body), actorOf(P))) });
  // a call of a provider's sub-menu (its managers only; its listed calls only; changes are audited)
  // (a change — the provider's settings, its approval rules, its agents — needs the password entered within the last 10
  // minutes, like the world's own destructive edits: a stolen session alone never reconfigures the agent platform)
  router.add({ method: 'POST', path: '/api/agent-providers/call', cap: 'connections.use', handler: ({ P, body }) => provCall(() => {
    const id = connId(body), method = body && body.method;
    if (d.agentProviders.isChange(P, id, method) && !(P.session && Date.now() - P.session.authAt <= LIMITS.reauthMs)) {
      throw new AuthError(403, 'reauth_required', 'Changing the agent platform needs your password: confirm it to continue');
    }
    return d.agentProviders.menu(P, id, method, body && body.params, actorOf(P));
  }) });
  router.add({ method: 'POST', path: '/api/agent-providers/sync', cap: 'connections.use', handler: ({ P, body }) => provCall(async () => {
    const c = d.connections.need(P, connId(body), 'manage');
    await d.agentProviders.syncAgents(c.id);
    return d.agentProviders.view(P, d.connections.get(c.id));
  }) });

  // ---------------------------------------------------------------- chat over the providers (WP2.2; DECISIONS C11, C14, C53, C119, C120, A8, A9)
  const chatCall = async fn => {
    try { return ok(await fn()); } catch (e) {
      if (e instanceof ChatError || e instanceof AttachmentError) throw new AuthError(e.status, e.code, e.message);
      throw e;
    }
  };
  const qnum = (url, k) => { const v = url.searchParams.get(k); return v !== null && /^\d{1,15}$/.test(v) ? Number(v) : null; };
  const need = (v, what) => { if (v === null || v === undefined) throw new AuthError(400, 'bad_request', `${what} is required`); return v; };
  router.add({ method: 'GET', path: '/api/chat-sessions', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.listSessions(P, need(qnum(url, 'agent'), 'agent'))) });
  router.add({ method: 'POST', path: '/api/chat-sessions/create', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => ({ session: d.chat.createSession(P, body.agent, body.label) })) });
  router.add({ method: 'POST', path: '/api/chat-sessions/switch', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.switchSession(P, body.agent, body.session)) });
  router.add({ method: 'POST', path: '/api/chat-sessions/rename', cap: 'chat.use', handler: ({ P, body }) => chatCall(async () => ({ session: await d.chat.renameSession(P, body.agent, body.session, body.label) })) });
  router.add({ method: 'POST', path: '/api/chat-sessions/delete', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.deleteSession(P, body.agent, body.session)) });
  router.add({ method: 'POST', path: '/api/providers/runs', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.startRun(P, body)) });
  router.add({ method: 'GET', path: '/api/providers/runs/events', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.events(P, url.searchParams.get('run') || '', qnum(url, 'since') || 0)) });
  router.add({ method: 'POST', path: '/api/providers/interrupt', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.stop(P, body.run)) });
  router.add({ method: 'POST', path: '/api/providers/approvals', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.approve(P, body.run, body.approval, body.approved, body.decision ?? null)) });
  // live activity in an open provider session (Agent Providers): watched while the chat is open
  // the media of a provider's answers (Agent Providers: an agent's images, video, audio): only at an address this server
  // signed for that agent and session, for whoever may read that session; streamed from the cache, byte ranges for video
  router.add({ method: 'GET', path: '/api/providers/media', cap: 'chat.use', handler: async ({ P, url }) => {
    let f;
    try { f = await d.chat.mediaFile(P, need(qnum(url, 'agent'), 'agent'), need(qnum(url, 'session'), 'session'), url.searchParams.get('r'), url.searchParams.get('s')); }
    catch (e) {
      if (e instanceof ChatError && e.status === 404) throw new AuthError(404, 'not_found', 'No such attachment');
      // (what the provider said: the file is not one this session may show, too large, gone)
      throw new AuthError(e instanceof ChatError && e.code === 'too_large' ? 413 : 502, (e && e.code) || 'unavailable', (e && e.message) || 'The provider did not send it');
    }
    const inline = INLINE_MEDIA.test(f.mime);
    return { file: { path: f.file, size: f.size }, headers: { 'content-type': inline ? f.mime : 'application/octet-stream', 'cache-control': 'private, max-age=3600',
      'content-disposition': inline ? 'inline' : 'attachment', 'content-security-policy': "sandbox; default-src 'none'" } };
  } });
  // the progress card brought up to date by the agent (OpenClaw's Refresh task progress)
  router.add({ method: 'POST', path: '/api/providers/progress/refresh', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.refreshCard(P, need(body && body.agent, 'agent'), need(body && body.session, 'session'), body.key ?? null)) });
  // (scope=agent: all of the agent's tasks, wherever they started — then no chat need be named)
  const taskScope = v => (v === 'agent' ? 'agent' : 'chat');
  router.add({ method: 'GET', path: '/api/providers/tasks', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.tasks(P, need(qnum(url, 'agent'), 'agent'), qnum(url, 'session'), taskScope(url.searchParams.get('scope')))) });
  router.add({ method: 'GET', path: '/api/providers/tasks/one', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.task(P, need(qnum(url, 'agent'), 'agent'), qnum(url, 'session'), need(url.searchParams.get('task'), 'task'), taskScope(url.searchParams.get('scope')))) });
  router.add({ method: 'GET', path: '/api/providers/tasks/history', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.taskHistory(P, need(qnum(url, 'agent'), 'agent'), qnum(url, 'session'), need(url.searchParams.get('task'), 'task'), url.searchParams.get('cursor'), taskScope(url.searchParams.get('scope')))) });
  // the provider's own calls for its chat view (Hermes: slash commands as its Desktop runs them, / and @ suggestions, side
  // questions): one of that provider's, on the chat's session, for whoever manages the provider
  router.add({ method: 'POST', path: '/api/providers/native', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.native(P, need(body && body.agent, 'agent'), body.session ?? null, need(body.method, 'method'), body.params || {}, typeof body.preview === 'string' ? body.preview : null)) });
  router.add({ method: 'POST', path: '/api/providers/archive', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.archiveSession(P, need(body && body.agent, 'agent'), need(body.session, 'session'))) });
  router.add({ method: 'POST', path: '/api/providers/branch', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.branchSession(P, need(body && body.agent, 'agent'), need(body.session, 'session'), body.upto)) });
  router.add({ method: 'POST', path: '/api/providers/tasks/steer', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.steerTask(P, need(body && body.agent, 'agent'), body.session ?? null, need(body.task, 'task'), body.text, taskScope(body.scope))) });
  router.add({ method: 'POST', path: '/api/providers/tasks/cancel', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.cancelTask(P, need(body && body.agent, 'agent'), body.session ?? null, need(body.task, 'task'), taskScope(body.scope))) });
  router.add({ method: 'GET', path: '/api/providers/browser', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.browser(P, need(qnum(url, 'agent'), 'agent'), url.searchParams.get('tab'))) });
  router.add({ method: 'POST', path: '/api/providers/browser', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.browserAct(P, need(body && body.agent, 'agent'), body)) });
  // the live picture: the tab's next frame after `after` (a JPEG, with the page's address and size), or 204 — none yet
  router.add({ method: 'GET', path: '/api/providers/browser/frame', cap: 'chat.use', handler: async ({ P, url }) => {
    let f;
    try { f = await d.chat.browserFrame(P, need(qnum(url, 'agent'), 'agent'), need(url.searchParams.get('tab'), 'tab'), qnum(url, 'after') || 0); }
    catch (e) { if (e instanceof ChatError) throw new AuthError(e.status, e.code, e.message); throw e; }
    const h = { 'cache-control': 'no-store', 'x-frame-seq': String(f.seq || 0) };
    if (!f.jpeg) return { status: 204, body: Buffer.alloc(0), headers: h };
    return { body: Buffer.from(f.jpeg, 'base64'), headers: { ...h, 'content-type': 'image/jpeg', 'x-page-width': String(f.head.cssWidth), 'x-page-height': String(f.head.cssHeight),
      'x-page-url': encodeURIComponent(f.head.url || '') } };
  } });
  // the agent's own screen (Hermes' Bot Desktop): its state and controls, and one picture of it now (a JPEG, or 204 — not
  // running, or a person has control); the live screen itself is a WebSocket, /api/providers/screen/ws (server/providers/screen-relay.js)
  router.add({ method: 'GET', path: '/api/providers/screen', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.screen(P, need(qnum(url, 'agent'), 'agent'))) });
  router.add({ method: 'POST', path: '/api/providers/screen', cap: 'chat.use', handler: ({ P, body }) => {
    // (its browser put on its screen or taken off: the provider's own settings changed — a recent password, as its sub-menu's changes)
    if (body && body.action === 'browser' && !(P.session && Date.now() - P.session.authAt <= LIMITS.reauthMs)) throw new AuthError(403, 'reauth_required', 'Changing the agent platform needs your password: confirm it to continue');
    return chatCall(() => d.chat.screenAct(P, need(body && body.agent, 'agent'), body));
  } });
  router.add({ method: 'GET', path: '/api/providers/screen/thumb', cap: 'chat.use', handler: async ({ P, url }) => {
    let f;
    try { f = await d.chat.screenThumb(P, need(qnum(url, 'agent'), 'agent')); }
    catch (e) { if (e instanceof ChatError) throw new AuthError(e.status, e.code, e.message); throw e; }
    if (!f || !f.jpeg) return { status: 204, body: Buffer.alloc(0), headers: { 'cache-control': 'no-store' } };
    return { body: Buffer.from(f.jpeg, 'base64'), headers: { 'cache-control': 'no-store', 'content-type': 'image/jpeg' } };
  } });
  router.add({ method: 'POST', path: '/api/providers/progress/dismiss', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.dismissCard(P, need(body && body.agent, 'agent'), need(body && body.session, 'session'), body.revision)) });
  router.add({ method: 'POST', path: '/api/providers/watch', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.watch(P, body.agent, body.session, body.on !== false)) });
  // what the agent asks the person (Agent Providers: its questions), and the slash commands it takes
  router.add({ method: 'POST', path: '/api/providers/questions', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.answer(P, body.run, body.question, { answers: body.answers ?? null, cancel: body.cancel === true })) });
  router.add({ method: 'GET', path: '/api/providers/commands', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.commands(P, need(qnum(url, 'agent'), 'agent'), qnum(url, 'session'))) });
  // approvals waiting on visitors' runs of the agents this account owns (C129)
  router.add({ method: 'GET', path: '/api/providers/approvals', cap: 'chat.use', handler: ({ P }) => chatCall(() => d.chat.pendingApprovals(P)) });
  router.add({ method: 'GET', path: '/api/providers/history', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.history(P, need(qnum(url, 'agent'), 'agent'), need(qnum(url, 'session'), 'session'))) });
  router.add({ method: 'GET', path: '/api/providers/models', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.models(P, need(qnum(url, 'agent'), 'agent'))) });
  router.add({ method: 'GET', path: '/api/providers/task', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.taskProgress(P, need(qnum(url, 'agent'), 'agent'), qnum(url, 'session'))) });
  // references: shared by everyone who may use the agent; whoever manages the agent changes them (C53)
  router.add({ method: 'GET', path: '/api/chat-references', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => { const a = d.chat.agentFor(P, need(qnum(url, 'agent'), 'agent')); return { references: d.references.list(a.id), canManage: d.agents.canManage(P, a) }; }) });
  router.add({ method: 'POST', path: '/api/chat-references/add', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => {
    const a = d.chat.agentFor(P, body.agent);
    if (!d.agents.canManage(P, a)) throw new ChatError(403, 'forbidden', 'Only whoever manages this agent may change its references');
    const r = d.references.add(a.id, body, P.account.id);
    if (r.error) throw new ChatError(400, r.error, r.message);
    return r;
  }) });
  router.add({ method: 'POST', path: '/api/chat-references/remove', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => {
    const a = d.chat.agentFor(P, body.agent);
    if (!d.agents.canManage(P, a)) throw new ChatError(403, 'forbidden', 'Only whoever manages this agent may change its references');
    return { removed: d.references.remove(a.id, body.id) };
  }) });
  // attachments: a raw upload (the file is the body; its name is ?name=), private to the account (C121)
  router.add({ method: 'POST', path: '/api/chat/attachments', cap: 'chat.use', raw: true, handler: ({ P, req, url }) => chatCall(async () => {
    const len = /^\d{1,15}$/.test(String(req.headers['content-length'] || '')) ? Number(req.headers['content-length']) : null;
    try { return { attachment: await d.attachments.store(P.account.id, url.searchParams.get('name') || '', req, len) }; }
    catch (e) { req.resume(); throw e; }   // a refused upload is read and dropped, so the client still receives the answer
  }) });
  router.add({ method: 'GET', path: '/api/chat/attachments', cap: 'chat.use', handler: ({ P }) => ok({ attachments: d.attachments.list(P.account.id), used: d.attachments.used(P.account.id), ...d.attachments.limits() }) });
  router.add({ method: 'POST', path: '/api/chat/attachments/delete', cap: 'chat.use', handler: ({ P, body }) => {
    const f = d.attachments.remove(P.account.id, need(body.id, 'id'));
    if (!f) throw new AuthError(404, 'not_found', 'No such attachment');   // someone else's, or gone: not confirmed
    return ok({ deleted: f.id, used: d.attachments.used(P.account.id) });
  } });
  // one of the account's own attachments, to show it again in a chat (an image, a PDF, a video or recording opens; anything
  // else downloads) — from the disk in byte ranges: a video plays and seeks
  router.add({ method: 'GET', path: '/api/chat/attachments/file', cap: 'chat.use', handler: ({ P, url }) => {
    const f = d.attachments.pathOf(P.account.id, url.searchParams.get('id') || '');
    let size = null;
    try { size = f ? fs.statSync(f.path).size : null; } catch { size = null; }
    if (size === null) throw new AuthError(404, 'not_found', 'No such attachment');   // someone else's, or gone: not confirmed
    const inline = /^image\/(png|jpeg|gif|webp)$/.test(f.mime) || f.mime === 'application/pdf' || /^(video|audio)\//.test(f.mime);
    const name = String(f.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 100);
    return { file: { path: f.path, size }, headers: { 'content-type': f.mime, 'cache-control': 'private, max-age=86400', 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"` } };
  } });
  router.add({ method: 'GET', path: '/api/providers/limits', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.limits(P, need(qnum(url, 'agent'), 'agent'))) });
  // the chat window: every chat of the account (any agent), search through them, and a chat's own model and effort
  router.add({ method: 'GET', path: '/api/chat/recent', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.recent(P, qnum(url, 'agent'), qnum(url, 'project'))) });
  // projects: an account's folders of chats with one agent, with their own instructions (CHAT.md §12)
  router.add({ method: 'GET', path: '/api/chat/projects', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.listProjects(P, need(qnum(url, 'agent'), 'agent'))) });
  router.add({ method: 'POST', path: '/api/chat/projects/create', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.createProject(P, body.agent, body)) });
  router.add({ method: 'POST', path: '/api/chat/projects/update', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.updateProject(P, body.agent, body.project, body)) });
  router.add({ method: 'POST', path: '/api/chat/projects/delete', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.deleteProject(P, body.agent, body.project)) });
  router.add({ method: 'POST', path: '/api/chat-sessions/move', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.moveSession(P, body.agent, body.session, body.project ?? null)) });
  router.add({ method: 'GET', path: '/api/chat/can', cap: 'chat.use', handler: ({ P, url }) => ok(d.chat.canChat(P, qnum(url, 'agent'))) });
  router.add({ method: 'GET', path: '/api/chat/search', cap: 'chat.use', handler: ({ P, url }) => chatCall(() => d.chat.search(P, url.searchParams.get('q') || '', qnum(url, 'agent'))) });
  router.add({ method: 'POST', path: '/api/chat-sessions/prefs', cap: 'chat.use', handler: ({ P, body }) => chatCall(() => d.chat.setPrefs(P, body.agent, body.session, body)) });
}
