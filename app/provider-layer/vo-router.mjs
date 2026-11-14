// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The provider layer's request rules (My Virtual World's Router and request pipeline, routes.js:22-62 and
// index.mjs handleApi/sendJSON/sendFile/readBody, adapted for the office): every request comes through the office server
// (server.py), which checks the office passcode, the agent token and the same-origin rule first and then names the caller
// in X-VO-Principal, signed with this boot's secret. Here: no valid principal = 401; then the route's capability, the
// CSRF token on POST (browser callers), JSON only, re-authentication, and the answer shapes json / file (with Range) /
// body (a Buffer).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CAPS } from './server/auth/permissions.js';

/** A refusal a handler throws: { status, code, message }; answered as { error, code }. */
export class AuthError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status; this.code = code;
    Object.assign(this, extra);
  }
}

/** The passcode (or this machine) was confirmed this recently for a change of the agent platform (VO RECENT_CONFIRM_SEC). */
export const LIMITS = Object.freeze({ reauthMs: 10 * 60 * 1000 });

export class Router {
  constructor() { this.routes = []; }
  /**
   * @param {object} r
   * @param {'GET'|'POST'} r.method
   * @param {string} [r.path]    exact path
   * @param {string} [r.prefix]  path prefix; the rest of the path reaches the handler as ctx.param
   * @param {string} r.cap       the capability a caller needs (server/auth/permissions.js)
   * @param {boolean} [r.csrf]   POSTs need the session's CSRF token (default true for POST)
   * @param {boolean} [r.reauth] the caller must have confirmed the passcode within the last 10 minutes
   * @param {boolean} [r.raw]    an upload: the handler reads the body stream itself
   * @param {boolean} [r.internal] the office server's own call (the bus): only the 'internal' principal
   * @param {function} r.handler async ctx => ({ status, json | file | body, headers }); ctx = { req, url, P, body, param }
   */
  add(r) {
    const where = `${r.method} ${r.path || `${r.prefix}*`}`;
    if (!['GET', 'POST'].includes(r.method)) throw new Error(`route ${where}: the method must be GET or POST`);
    if (!r.path === !r.prefix) throw new Error(`route ${where}: give a path or a prefix`);
    if (!r.cap || !CAPS[r.cap]) throw new Error(`route ${where}: unknown capability "${r.cap}"`);
    if (typeof r.handler !== 'function') throw new Error(`route ${where}: no handler`);
    if (this.routes.some(o => o.method === r.method && o.path === r.path && o.prefix === r.prefix)) throw new Error(`route ${where}: defined twice`);
    this.routes.push({ csrf: r.method === 'POST', reauth: false, ...r });
    return this;
  }
  /** { route, param } for a request; { wrongMethod: true } when the path exists for other methods only; else null. */
  match(method, pathname) {
    let other = false;
    for (const r of this.routes) {
      if (r.path ? r.path !== pathname : !pathname.startsWith(r.prefix)) continue;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) return { route: r, param: r.prefix ? pathname.slice(r.prefix.length) : null };
      other = true;
    }
    return other ? { wrongMethod: true } : null;
  }
  list() {
    return this.routes.map(r => ({ method: r.method, path: r.path || `${r.prefix}*`, cap: r.cap, csrf: r.csrf, reauth: r.reauth }));
  }
}

// ---------------------------------------------------------------- who is calling (X-VO-Principal)
export const PRINCIPAL_HEADER = 'x-vo-principal';
const ROLES = new Set(['owner', 'member']);
const VIAS = new Set(['session', 'loopback', 'open', 'token', 'internal']);
export const OFFICE_ACCOUNT = Object.freeze({ owner: { id: 1, login: 'office', displayName: 'Office' }, member: { id: 2, login: 'office-agents', displayName: 'Office agents' } });

/** `<base64url JSON>.<hex HMAC-SHA256 of the first part>`, as server.py signs it. */
export function signPrincipal(secret, obj) {
  const data = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('hex')}`;
}
/** The caller named by a valid header, or null (missing, forged, malformed). */
export function readPrincipal(secret, header) {
  const s = String(header || '');
  const dot = s.lastIndexOf('.');
  if (!secret || dot < 1 || s.length > 4096) return null;
  const data = s.slice(0, dot), mac = Buffer.from(s.slice(dot + 1));
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(data).digest('hex'));
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
  let o;
  try { o = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
  if (!o || typeof o !== 'object' || !ROLES.has(o.role) || !VIAS.has(o.via)) return null;
  return o;
}
/** My Virtual World's principal for an office caller: the office account (owner) or the office's agents (member). */
export function principalOf(o) {
  if (!o) return null;
  const acct = OFFICE_ACCOUNT[o.role];
  return {
    account: { id: acct.id, login: acct.login, displayName: acct.displayName, role: o.role },
    role: o.role, via: o.via,
    // (a browser session carries a CSRF token; this machine's scripts and agent tokens send no cookies, so none is asked)
    session: { authAt: Number(o.authAt) || 0, csrf: typeof o.csrf === 'string' && o.csrf ? o.csrf : null },
  };
}

// ---------------------------------------------------------------- answers
const SECURITY_HEADERS = Object.freeze({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });

export function sendJSON(req, res, code, obj, extra = null) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...(extra || {}), 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}
/** A file a route answers with, streamed: whole, or one byte range of it (a video seeking): 206 with its range. */
export function sendFile(req, res, file, extra) {
  const size = file.size, h = { 'cache-control': 'no-store', ...SECURITY_HEADERS, ...(extra || {}), 'accept-ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  let start = 0, end = size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; } else { start = Math.max(0, size - Number(m[2])); }
    if (start > end || start >= size) { res.writeHead(416, { ...h, 'content-range': `bytes */${size}` }); return res.end(); }
    code = 206; h['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(code, { ...h, 'content-length': size ? end - start + 1 : 0 });
  if (!size || req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file.path, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
export function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    const fail = (status, msg) => reject(Object.assign(new Error(msg), { status }));
    req.on('data', c => {
      size += c.length;
      if (size > limit * 8) { fail(413, 'Body too large'); req.destroy(); return; }
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return fail(413, 'Body too large');
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(400, 'Bad JSON'); }
    });
    req.on('error', () => fail(400, 'Bad request'));
  });
}
/** Whether the request carries the session's CSRF token in X-CSRF-Token. */
export function csrfOk(req, expected) {
  const got = Buffer.from(String(req.headers['x-csrf-token'] || '')), want = Buffer.from(String(expected || ''));
  return want.length > 0 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * The request pipeline (My Virtual World's handleApi for the office).
 * @param {{ router: Router, perms: { allowed(P, cap): boolean }, secret: Buffer|string, log?: object }} o
 */
export async function handleApi(req, res, url, { router, perms, secret, log = null }) {
  const hit = router.match(req.method, url.pathname);
  if (!hit) return sendJSON(req, res, 404, { error: 'Not found', code: 'not_found' });
  if (hit.wrongMethod) return sendJSON(req, res, 405, { error: 'Method not allowed', code: 'method_not_allowed' });
  const route = hit.route;
  const o = readPrincipal(secret, req.headers[PRINCIPAL_HEADER]);
  if (!o) return sendJSON(req, res, 401, { error: 'Open the office first', code: 'signin_required' });
  if (!!route.internal !== (o.via === 'internal')) return sendJSON(req, res, 403, { error: 'Your role does not allow this', code: 'forbidden' });
  const P = principalOf(o);
  const deny = (status, code, error) => sendJSON(req, res, status, { error, code });
  if (!perms.allowed(P, route.cap)) return deny(403, 'forbidden', 'Your role does not allow this');
  if (route.method === 'POST') {
    if (route.csrf && P.session.csrf && !csrfOk(req, P.session.csrf)) return deny(403, 'csrf', 'The security token is missing or out of date; reload the page');
    // Only JSON: an HTML form on another site can send no such request without a CORS preflight.
    if (!route.raw && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return deny(415, 'unsupported_media_type', 'Send the request as JSON');
  }
  if (route.reauth && Date.now() - P.session.authAt > LIMITS.reauthMs) return deny(403, 'reauth_required', 'Confirm the office passcode to continue');
  let body = null;
  if (route.method === 'POST' && !route.raw) {
    try { body = await readBody(req); } catch (e) {
      if (!req.socket || req.socket.destroyed) return;
      return sendJSON(req, res, e.status || 400, { error: e.message, code: e.status === 413 ? 'too_large' : 'bad_request' });
    }
    if (!body || typeof body !== 'object') body = {};
  }
  try {
    const out = await route.handler({ req, res, url, P, body, param: hit.param });
    if (out === undefined && res.headersSent) return;   // (a stream the handler answers itself: the bus)
    if (out.file) return sendFile(req, res, out.file, out.headers || {});
    // (bytes made here: a browser frame, its own type, never sniffed)
    if (Buffer.isBuffer(out.body)) { res.writeHead(out.status || 200, { 'x-content-type-options': 'nosniff', ...(out.headers || {}), 'content-length': String(out.body.length) }); res.end(out.status === 204 ? undefined : out.body); return; }
    return sendJSON(req, res, out.status || 200, out.json, out.headers || null);
  } catch (e) {
    if (!(e instanceof AuthError)) { log?.error?.('[pl] route', url.pathname, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); return sendJSON(req, res, 500, { error: 'The provider layer failed', code: 'internal_error' }); }
    return sendJSON(req, res, e.status, { error: e.message, code: e.code }, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : null);
  }
}
