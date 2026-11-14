/* Provider-neutral, bounded session progress viewer. Never derives plans from chat. */
(() => {
  'use strict';
  const identityKey = id => id ? JSON.stringify(['connectionId', 'providerKind', 'nativeOwnerId', 'nativeSessionId'].map(k => id[k])) : '';
  const supportedStates = new Set(['supported', 'unknown', 'denied', 'unsupported', 'unavailable']);
  const labels = {
    unknown: 'Progress not yet known', denied: 'Access denied — progress hidden',
    unsupported: 'Native task progress is not supported by this connection',
    unavailable: 'Progress unavailable', supported: 'No native progress card',
  };
  const safeText = value => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');

  // Parse untrusted HTML in inert template content, then rebuild a NEW tree.
  // No source element is adopted, and no images, CSS, namespaces, ids or events
  // survive. The small node/depth/text budgets also bound malformed markup.
  function renderNote(target, markdown) {
    target.replaceChildren();
    const source = safeText(markdown).slice(0, 8192);
    const template = document.createElement('template');
    const html = globalThis.marked?.parse ? globalThis.marked.parse(source, { gfm: true, breaks: true }) : null;
    if (typeof html !== 'string' || html.length > 131072) { target.textContent = source; return; }
    template.innerHTML = html;
    const tags = new Set(['P','BR','STRONG','EM','B','I','S','DEL','H1','H2','H3','H4','UL','OL','LI','BLOCKQUOTE','HR','PRE','CODE','A','TABLE','THEAD','TBODY','TR','TH','TD','PROGRESS']);
    const drop = new Set(['SCRIPT','STYLE','SVG','MATH','IFRAME','OBJECT','EMBED','FORM','INPUT','IMG','VIDEO','AUDIO','LINK','META','TEMPLATE']);
    let nodes = 0, chars = 0, bars = 0;
    function copy(node, parent, depth) {
      if (++nodes > 1200 || depth > 24 || chars > 32768) return;
      if (node.nodeType === 3) { const text = safeText(node.textContent).slice(0, 32768 - chars); chars += text.length; parent.append(document.createTextNode(text)); return; }
      if (node.nodeType !== 1 || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || drop.has(node.tagName)) return;
      let destination = parent;
      if (tags.has(node.tagName)) {
        destination = document.createElement(node.tagName.toLowerCase());
        if (node.tagName === 'A') {
          const href = node.getAttribute('href') || '';
          // Explicit absolute web/mail links only; never auto-fetch resources.
          if (/^(https?:\/\/|mailto:)/i.test(href) && !/[\u0000-\u0020\u007f]/.test(href)) {
            try { const url = new URL(href); if (!url.username && !url.password && ['https:', 'http:', 'mailto:'].includes(url.protocol)) destination.setAttribute('href', url.href); } catch (_) {}
          }
          destination.setAttribute('rel', 'noopener noreferrer');
          destination.setAttribute('target', '_blank');
        }
        if (node.tagName === 'PROGRESS') {
          if (++bars > 8) return;
          const max = Number(node.getAttribute('max') || 1);
          const raw = node.getAttribute('value');
          const value = Number(raw);
          if (!Number.isFinite(max) || max <= 0 || max > 1e12 || (raw !== null && (!Number.isFinite(value) || value < 0 || value > max))) return;
          destination.max = max;
          if (raw !== null) destination.value = value;
          const label = safeText(node.getAttribute('aria-label') || 'Native progress').slice(0, 200);
          destination.setAttribute('aria-label', label);
          parent.append(document.createTextNode(label + ' '));
        }
        parent.append(destination);
      }
      for (const child of node.childNodes) copy(child, destination, depth + 1);
    }
    for (const child of template.content.childNodes) copy(child, target, 0);
  }

  class ProgressStore {
    constructor(request = async (body, signal) => {
      const response = await fetch('/api/openclaw/task-progress', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (response.status === 401 || response.status === 403) return { availability: 'denied', card: null };
      if (response.status === 429) {
        const header = response.headers.get('Retry-After') || '30';
        const delay = Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        const e = new Error('rate_limited'); e.retryAfter = Math.min(300000, Math.max(10000, Number.isFinite(delay) ? delay : 30000)); throw e;
      }
      if (!response.ok) throw new Error('unavailable');
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let bytes = 0;
        try {
          for (;;) {
            const {done, value} = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > 1200000) { await reader.cancel(); throw new Error('oversized'); }
            text += decoder.decode(value, {stream: true});
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
      } else { text = await response.text(); }
      if (text.length > 1200000) throw new Error('oversized');
      return JSON.parse(text);
    }) { this.request = request; this.entries = new Map(); this.epoch = 0; }
    watch(identity, listener) {
      const key = identityKey(identity);
      let entry = this.entries.get(key);
      if (!entry) {
        // Only active viewers are retained; four current chat slots, hard cap 16.
        if (this.entries.size >= 16) throw new Error('Too many progress viewers');
        entry = { identity: { ...identity }, listeners: new Set(), state: { availability: 'unknown', card: null }, version: 0, pending: false, dirty: false, nextAt: 0, failures: 0 };
        this.entries.set(key, entry);
      }
      entry.listeners.add(listener); listener(entry.state); this.refresh(entry);
      return () => { entry.listeners.delete(listener); if (!entry.listeners.size) { entry.version++; entry.abort?.abort(); clearTimeout(entry.timer); this.entries.delete(key); } };
    }
    emit(entry) { for (const listener of entry.listeners) listener(entry.state); }
    invalidate(identity, { disconnect = false } = {}) {
      for (const entry of this.entries.values()) {
        if (identity && identityKey(identity) !== identityKey(entry.identity)) continue;
        if (!entry.dirty) entry.version++;
        entry.dirty = true;
        if (!entry.state.stale) {
          entry.state = { ...entry.state, stale: true };
          this.emit(entry);
        }
        if (!disconnect) { entry.nextAt = 0; this.refresh(entry); }
      }
    }
    connectionChanged() {
      this.epoch++;
      for (const entry of this.entries.values()) {
        entry.state = { availability: 'unknown', card: null, stale: true };
        this.emit(entry);
      }
      this.invalidate(null);
    }
    async refresh(entry, action = 'read', expectedRevision) {
      if (!entry.listeners.size) return;
      if (entry.pending) { entry.dirty = true; return; }
      if (action === 'read' && Date.now() < entry.nextAt) return;
      entry.pending = true; entry.dirty = false;
      const version = entry.version, epoch = this.epoch;
      const controller = new AbortController(); entry.abort = controller;
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const result = await this.request({ identity: entry.identity, action,
          ...(action === 'dismiss' ? { expectedRevision, connectionEpoch: entry.state.connectionEpoch } : {}) }, controller.signal);
        if (entry.version !== version || this.epoch !== epoch || !entry.listeners.size) return;
        if (!supportedStates.has(result?.availability)) throw new Error('invalid_contract');
        if (result.availability !== 'denied' && identityKey(result.identity) !== identityKey(entry.identity)) throw new Error('identity_mismatch');
        if (result.availability === 'supported' && result.schemaVersion !== 'vw-session-progress/v1') throw new Error('invalid_contract');
        const old = entry.state;
        if (result.availability === 'supported' && old.connectionEpoch === result.connectionEpoch && old.card && result.card && result.card.nativeRevision < old.card.nativeRevision) throw new Error('stale_revision');
        if (result.availability === 'unavailable') {
          // Retain only same-connection previously authorized data on transient loss.
          entry.state = { ...result, card: old.connectionEpoch === result.connectionEpoch ? old.card : null, stale: true };
          entry.failures++;
        } else { entry.state = { ...result, stale: false }; entry.failures = 0; }
        entry.nextAt = Date.now() + (Number.isFinite(result.retryAfterMs) ? Math.min(300000, Math.max(15000, result.retryAfterMs)) : result.availability === 'supported' ? 15000 : Math.min(120000, 15000 * 2 ** Math.min(3, entry.failures)));
        this.emit(entry);
      } catch (error) {
        if (entry.version !== version || this.epoch !== epoch || !entry.listeners.size) return;
        entry.failures++;
        entry.state = { ...entry.state, availability: 'unavailable', stale: true };
        entry.nextAt = Date.now() + (error.retryAfter || Math.min(120000, 15000 * 2 ** Math.min(3, entry.failures)));
        this.emit(entry);
      } finally {
        clearTimeout(timeout); entry.pending = false;
        if (entry.dirty && entry.listeners.size) { entry.nextAt = 0; clearTimeout(entry.timer); entry.timer = setTimeout(() => this.refresh(entry), 150); }
      }
    }
    tick() { for (const entry of this.entries.values()) this.refresh(entry); }
    dismiss(identity) {
      const entry = this.entries.get(identityKey(identity)), state = entry?.state;
      if (!entry || entry.pending || state.stale || !state.capabilities?.dismissCompleted || !state.card?.items?.length || state.card.items.some(i => i.status !== 'completed')) return;
      return this.refresh(entry, 'dismiss', state.card.nativeRevision);
    }
  }

  function hasProgressContent(state) {
    if (!state?.card || ['denied', 'unsupported'].includes(state.availability)) return false;
    return (Array.isArray(state.card.items) && state.card.items.some(item => safeText(item?.text).trim()))
      || Boolean(safeText(state.card.note?.content).trim());
  }

  let panelSequence = 0;
  class ProgressPanel {
    constructor(root, store) {
      this.root = root; this.drawerOpen = false;
      this.store = store; this.identity = null; this.run = { state: 'unknown' }; this.retiredRuns = new Set(); this.state = { availability: 'unknown', card: null };
      // Secondary chat templates can be cloned after a primary panel was mounted.
      root.querySelectorAll('.task-progress, .chat-tasks-rail, .chat-tasks-drawer').forEach(el => el.remove());
      root.classList.remove('chat-tasks-open');
      this.el = document.createElement('details'); this.el.className = 'task-progress';
      this.summary = document.createElement('summary'); this.summary.textContent = 'Task progress';
      this.body = document.createElement('div'); this.body.className = 'task-progress-body';
      this.status = document.createElement('p'); this.status.setAttribute('role', 'status');
      this.content = document.createElement('div');
      this.dismissButton = document.createElement('button'); this.dismissButton.type = 'button'; this.dismissButton.textContent = 'Dismiss completed native plan';
      this.dismissButton.addEventListener('click', () => {
        if (globalThis.confirm('Clear this completed native plan for all viewers? A newer revision will be preserved.')) this.store.dismiss(this.identity);
      });
      this.body.append(this.status, this.content, this.dismissButton); this.el.append(this.summary, this.body);
      root.querySelector('.chat-input-row')?.before(this.el);
      this.buildDrawer(); this.render();
    }
    buildDrawer() {
      const host = this.root.querySelector('.chat-body');
      this.rail = document.createElement('button'); this.rail.type = 'button';
      this.rail.className = 'chat-tasks-rail'; this.rail.title = 'Session tasks';
      this.rail.setAttribute('aria-label', 'Open session tasks'); this.rail.setAttribute('aria-expanded', 'false');
      const icon = document.createElement('span'); icon.textContent = '☷'; icon.setAttribute('aria-hidden', 'true');
      this.railCount = document.createElement('span'); this.railCount.className = 'chat-tasks-count'; this.railCount.hidden = true;
      this.rail.append(icon, this.railCount);
      this.drawer = document.createElement('aside'); this.drawer.className = 'chat-tasks-drawer';
      this.drawer.id = `chat-session-tasks-${++panelSequence}`;
      this.drawer.setAttribute('aria-label', 'Session tasks'); this.drawer.hidden = true; this.drawer.inert = true;
      this.rail.setAttribute('aria-controls', this.drawer.id);
      const head = document.createElement('div'); head.className = 'chat-tasks-head';
      this.drawerTitle = document.createElement('strong'); this.drawerTitle.textContent = 'Tasks';
      this.closeButton = document.createElement('button'); this.closeButton.type = 'button';
      this.closeButton.className = 'chat-tasks-close'; this.closeButton.textContent = '×';
      this.closeButton.setAttribute('aria-label', 'Close session tasks');
      head.append(this.drawerTitle, this.closeButton);
      this.drawer.append(head);
      host?.append(this.rail, this.drawer);
      this.rail.addEventListener('click', () => this.setOpen(!this.drawerOpen));
      this.closeButton.addEventListener('click', () => this.setOpen(false, { restoreFocus: true }));
      this.drawer.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); this.setOpen(false, { restoreFocus: true });
      });
      this.onOtherDrawer = event => {
        if (event.detail?.drawer !== 'tasks') this.setOpen(false);
      };
      this.root.addEventListener('vw:chat-drawer-open', this.onOtherDrawer);
    }
    setOpen(open, { restoreFocus = false } = {}) {
      const next = Boolean(open);
      if (next === this.drawerOpen) return;
      this.drawerOpen = next;
      if (next) {
        this.root.dispatchEvent(new CustomEvent('vw:chat-drawer-open', { detail: { drawer: 'tasks' } }));
        this.root.querySelector('.chat-prompt-nav')?.classList.remove('open');
      }
      this.root.classList.toggle('chat-tasks-open', next);
      this.drawer.hidden = !next; this.drawer.inert = !next;
      this.rail.setAttribute('aria-expanded', String(next));
      // Move the SAME view, including safe notes and dismissal state. No duplicate
      // renderer, native subscriptions, requests, or competing checklist state.
      (next ? this.drawer : this.el).append(this.body);
      this.updatePlacement();
      if (next) this.closeButton.focus({ preventScroll: true });
      else if (restoreFocus) this.rail.focus({ preventScroll: true });
    }
    updatePlacement() {
      const hide = this.drawerOpen || !hasProgressContent(this.state);
      if (hide && this.el.contains(document.activeElement)) this.rail.focus({ preventScroll: true });
      this.el.hidden = hide;
    }
    select(identity) {
      if (identityKey(identity) === identityKey(this.identity)) return;
      this.unwatch?.(); this.unwatch = null; this.identity = identity ? { ...identity } : null;
      this.run = { state: 'unknown' }; this.retiredRuns.clear(); this.state = { availability: 'unknown', card: null }; this.el.open = false; this.render();
      if (identity) this.unwatch = this.store.watch(identity, state => { this.state = state; this.render(); });
    }
    runEvent(event) {
      // Explicit lifecycle events only; tool completion is never plan completion.
      const states = { 'run.start': 'running', 'run.complete': 'completed', 'run.failed': 'failed', 'run.cancelled': 'cancelled', 'run.paused': 'paused', 'approval.required': 'waiting approval', 'approval': 'waiting approval', 'run.timed_out': 'timed out' };
      const state = event?.kind === 'run.terminal' && ['completed', 'failed', 'cancelled', 'timed_out'].includes(event.status) ? event.status : states[event?.kind];
      if (!state || typeof event.runId !== 'string' || !event.runId || event.runId.length > 1024 || (event.kind === 'run.start' && this.retiredRuns.has(event.runId))) return;
      if (this.run.runId && this.run.runId !== event.runId && event.kind !== 'run.start') return;
      if (this.run.runId && this.run.runId !== event.runId) this.retiredRuns.add(this.run.runId);
      if (['completed', 'failed', 'cancelled', 'timed_out'].includes(state)) this.retiredRuns.add(event.runId);
      while (this.retiredRuns.size > 64) this.retiredRuns.delete(this.retiredRuns.values().next().value);
      this.run = { runId: event.runId, state }; this.render();
    }
    render() {
      const { card, availability, stale } = this.state;
      const items = Array.isArray(card?.items) ? card.items.slice(0, 256) : [];
      const done = items.filter(i => i.status === 'completed').length, cancelled = items.filter(i => i.status === 'cancelled').length;
      this.updatePlacement();
      this.railCount.hidden = !items.length || availability === 'denied';
      this.railCount.textContent = String(items.length);
      this.rail.setAttribute('aria-label', `${this.drawerOpen ? 'Close' : 'Open'} session tasks${items.length && availability !== 'denied' ? ` (${done} completed of ${items.length})` : ''}`);
      this.drawerTitle.textContent = `Tasks${items.length && availability !== 'denied' ? ` · ${done}/${items.length} completed` : ''}${stale ? ' · stale' : ''}`;
      this.summary.textContent = `Task progress${items.length ? ` · ${done}/${items.length} completed` : ''}${stale ? ' · stale' : ''}`;
      let status = card ? `${done} completed, ${cancelled} cancelled, ${items.length} total. ` : labels[availability] || labels.unknown;
      if (this.state.code === 'hermes_native_bridge_required') status = 'Hermes native todo snapshot is unsupported on the current run transport; a session-owned native bridge is required. No native notes support.';
      if (this.state.source?.kind === 'hermes-paired-todo-history') status += ' Limited Hermes history snapshot (latest 500 messages); not live todo or guaranteed reload/compaction parity. No native notes.';
      if (this.state.code === 'history_snapshot_missing') status += ' No complete paired native todo result in the bounded history; current checklist is unknown.';
      if (stale) status += ' Stale — waiting for an authoritative refresh.';
      if (availability === 'denied') status = labels.denied;
      status += ` Run: ${this.run.state} (independent of checklist).`;
      if (this.state.observedAt && !card?.nativeUpdatedAt) status += ` Checked ${new Date(this.state.observedAt).toLocaleTimeString()}.`;
      if (card?.nativeUpdatedAt) status += ` Updated ${new Date(card.nativeUpdatedAt).toLocaleString()}.`;
      this.status.textContent = status;
      const displayContent = hasProgressContent(this.state);
      const contentSignature = JSON.stringify(displayContent ? [items, card.note?.content || ''] : []);
      if (contentSignature !== this.contentSignature) {
        this.contentSignature = contentSignature;
        // Keep the reader's place only when there was a list on screen: reading scrollTop forces a layout,
        // which cost 4 forced layouts per chat while the page loads (perf v0.13).
        const keepScroll = this.content.firstChild !== null && (this.drawerOpen || !this.el.hidden);
        const scrollTop = keepScroll ? this.body.scrollTop : 0;
        this.content.replaceChildren();
        if (displayContent) {
          const list = document.createElement('ol');
          for (const item of items) { const li = document.createElement('li'); li.dataset.state = item.status; li.textContent = `${safeText(item.nativeStatus || item.status)} — ${safeText(item.text).slice(0, 4000)}`; list.append(li); }
          if (items.length) this.content.append(list);
          if (card.note?.content) { const note = document.createElement('div'); note.className = 'task-progress-note'; renderNote(note, card.note.content); this.content.append(note); }
        }
        if (keepScroll) this.body.scrollTop = scrollTop;
      }
      this.dismissButton.hidden = !(availability === 'supported' && !stale && this.state.capabilities?.dismissCompleted && items.length && items.every(i => i.status === 'completed'));
    }
    destroy() {
      this.unwatch?.(); this.unwatch = null;
      this.root.removeEventListener('vw:chat-drawer-open', this.onOtherDrawer);
      this.root.classList.remove('chat-tasks-open');
      this.el.remove(); this.drawer.remove(); this.rail.remove();
    }
  }
  globalThis.VirtualWorldSessionProgress = Object.freeze({ ProgressStore, ProgressPanel, renderNote, identityKey, hasProgressContent });
})();
