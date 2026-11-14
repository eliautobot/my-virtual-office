// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The provider layer's network helpers in the office (replaces My Virtual World's city connection): JSON fetches with
// the office CSRF token, and one live socket (/api/pl/ws, relayed by the office server) whose frames {t} become bus
// events 'msg:' + t, as in My Virtual World.
import { bus } from './state.js';
import { auth } from './auth.js';

export async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) {
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    throw Object.assign(new Error((j && j.error) || `${url}: HTTP ${r.status}`), { status: r.status, code: j && j.code });
  }
  return r.json();
}
/** POST with the office CSRF token. A stale token is refreshed and the request retried once; a request that needs the
 *  passcode again asks for it (auth.ui) and is retried once. Errors carry .status and .code. */
export async function post(url, body, retried = false) {
  const headers = { 'content-type': 'application/json' };
  if (auth.csrf) headers['x-csrf-token'] = auth.csrf;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  if (r.ok) return j;
  const code = j && j.code;
  if (!retried) {
    if (code === 'csrf') { await auth.refresh(); return post(url, body, true); }
    if (code === 'reauth_required' && auth.ui && await auth.ui.confirmPassword(j.error)) return post(url, body, true);
  }
  if (code === 'signin_required') { await auth.refresh(); if (auth.ui?.signIn) auth.ui.signIn(j.error); }
  throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { status: r.status, code, quiet: code === 'signin_required' || code === 'reauth_required' });
}

/** The live socket: reconnects with backoff (0.8 s .. 15 s); 4401 = the office session ended (no reconnect loop). */
export class Net {
  constructor(path = '/api/pl/ws') {
    this.path = path; this.ws = null; this.connected = false; this.retry = 0; this.closed = false;
  }
  connect() {
    if (this.closed) return;
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + this.path);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.retry = 0; bus.emit('net', true); };
    ws.onclose = (ev) => {
      this.connected = false;
      if (this.ws !== ws || this.closed) return;
      if (ev.code === 4401) { bus.emit('net', false, 'signin'); return; }
      bus.emit('net', false);
      setTimeout(() => this.connect(), Math.min(15000, 800 * Math.pow(1.7, this.retry++)));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'session') { auth.refresh().then(() => bus.emit('msg:session', m)); return; }
      bus.emit('msg:' + m.t, m);
    };
  }
  /** Opens a fresh connection now (after the office session changed). */
  reconnect() {
    const old = this.ws; this.ws = null;
    if (old) { old.onclose = null; old.onmessage = null; old.onopen = null; try { old.close(); } catch { /* gone */ } }
    this.connected = false;
    this.connect();
  }
  /** Sends a text message on the live connection; false when it is not open. */
  send(obj) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj)); return true;
  }
  close() { this.closed = true; try { this.ws?.close(); } catch { /* gone */ } }
}
