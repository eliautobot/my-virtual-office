// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// Who is using the office, for the provider layer's client (replaces My Virtual World's account client): the office has
// one passcode and no accounts, so GET /api/pl/me answers { account, role, caps, csrf, reauthLeftMs } for this browser's
// office session (capabilities derived from the office access rules, CSRF from the office server). auth.ui is set by the
// office page: confirmPassword(reason) opens the office passcode confirm, so a write that needs it again is retried once.
// Emits bus 'auth' (me, previous) whenever the answer changes.
import { bus } from './state.js';

export const auth = {
  /** The last GET /api/pl/me answer. */
  me: null,
  /** Dialog hooks set by the office page: confirmPassword(reason) -> Promise<boolean>, signIn(reason). */
  ui: null,
  can(cap) { return !!(this.me && this.me.caps && this.me.caps[cap]); },
  get csrf() { return (this.me && this.me.csrf) || null; },
  get account() { return (this.me && this.me.account) || null; },
  set(me) {
    const prev = this.me;
    this.me = me;
    bus.emit('auth', me, prev);
    return me;
  },
  async refresh() {
    try {
      const r = await fetch('/api/pl/me', { cache: 'no-store' });
      if (r.ok) return this.set(await r.json());
    } catch { /* offline: keep the last answer */ }
    return this.me;
  },
  /** POST with the office CSRF token; a request that needs the passcode again asks for it and is retried once. */
  async call(url, body, retried = false) {
    const headers = { 'content-type': 'application/json' };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    let j = null;
    try { j = await r.json(); } catch { /* empty */ }
    if (!r.ok) {
      const code = j && j.code;
      if (!retried && code === 'reauth_required' && this.ui && await this.ui.confirmPassword(j.error)) return this.call(url, body, true);
      throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { status: r.status, code, retryAfter: +r.headers.get('retry-after') || 0 });
    }
    return j;
  },
};
