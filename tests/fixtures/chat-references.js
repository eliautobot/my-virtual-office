// Agent-scoped, session-independent Chat References for every chat window.
(() => {
  'use strict';

  const PREVIEW_MAX = 260;
  const EVENT_NAME = 'vw:chat-references-changed';
  const SORT_STORAGE_KEY = 'vw-chat-reference-sort-v1';
  let instanceSequence = 0;

  function normalizeReferencePreview(text, max = PREVIEW_MAX) {
    const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
    if (!collapsed || collapsed.length <= max) return collapsed;
    return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  }

  function timestampIso(value) {
    const numeric = Number(value);
    const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  function stableHash(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function buildReferenceSourceKey({ agentId, sessionKey, role, text, ts }) {
    const source = [
      String(agentId || '').trim(),
      String(sessionKey || '').trim(),
      String(role || '').trim(),
      timestampIso(ts),
      String(text || '').trim()
    ].join('\u241f');
    return `message-${stableHash(source)}-${stableHash(String(text || ''))}`;
  }

  function sortReferences(references, order = 'newest') {
    const direction = order === 'oldest' ? 1 : -1;
    return [...(references || [])].sort((left, right) => {
      const leftTime = Date.parse(left?.createdAt || '') || 0;
      const rightTime = Date.parse(right?.createdAt || '') || 0;
      return (leftTime - rightTime) * direction;
    });
  }

  function formatReferenceDate(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return 'Date unavailable';
    return date.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function savedSortOrder() {
    try {
      return localStorage.getItem(SORT_STORAGE_KEY) === 'oldest' ? 'oldest' : 'newest';
    } catch (_) {
      return 'newest';
    }
  }

  function setSavedSortOrder(value) {
    try { localStorage.setItem(SORT_STORAGE_KEY, value); } catch (_) {}
  }

  function iconSvg(kind) {
    if (kind === 'bookmark-plus') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5c0-1.1.9-2 2-2h7c1.1 0 2 .9 2 2v17l-5.5-3.4-5.5 3.4v-17Z"></path><path d="M12 6.5v6M9 9.5h6"></path></svg>';
    }
    if (kind === 'bookmark') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5c0-1.1.9-2 2-2h7c1.1 0 2 .9 2 2v17l-5.5-3.4-5.5 3.4v-17Z"></path></svg>';
    }
    return '';
  }

  function ensureMessageActions(bubble) {
    if (!bubble) return null;
    let actions = bubble.querySelector(':scope > .chat-message-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'chat-message-actions';
      bubble.appendChild(actions);
    }
    bubble.classList.add('chat-message-actionable');
    return actions;
  }

  async function requestJson(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }

  class ChatReferencesPanel {
    constructor({ root, messages, getAgentId, getAgentLabel, getSessionKey, getInput, renderMarkdownInto }) {
      this.root = root;
      this.messages = messages;
      this.getAgentId = typeof getAgentId === 'function' ? getAgentId : () => '';
      this.getAgentLabel = typeof getAgentLabel === 'function' ? getAgentLabel : () => 'Agent';
      this.getSessionKey = typeof getSessionKey === 'function' ? getSessionKey : () => '';
      this.getInput = typeof getInput === 'function' ? getInput : () => null;
      this.renderMarkdownInto = typeof renderMarkdownInto === 'function'
        ? renderMarkdownInto
        : (target, text) => { target.textContent = text; };
      this.instanceId = `chat-reference-panel-${++instanceSequence}`;
      this.references = [];
      this.messageBindings = [];
      this.activeAgentId = '';
      this.selectedReferenceId = '';
      this.sortOrder = savedSortOrder();
      this.requestSequence = 0;
      this.statusTimer = null;

      // Secondary chat panels clone the initialized primary panel. Remove the
      // inert cloned controls before constructing this window's live instance.
      this.root.querySelectorAll('.chat-references-rail, .chat-references-drawer').forEach(node => node.remove());
      this.buildUi();
      this.bindEvents();
      this.refreshForAgent();
    }

    buildUi() {
      const body = this.root.querySelector('.chat-body');
      this.rail = document.createElement('button');
      this.rail.type = 'button';
      this.rail.className = 'chat-references-rail';
      this.rail.title = 'Chat References';
      this.rail.setAttribute('aria-label', 'Open Chat References');
      this.rail.setAttribute('aria-expanded', 'false');
      this.rail.innerHTML = `${iconSvg('bookmark')}<span class="chat-references-rail-count">0</span>`;
      this.railCount = this.rail.querySelector('.chat-references-rail-count');

      this.drawer = document.createElement('aside');
      this.drawer.className = 'chat-references-drawer';
      this.drawer.setAttribute('aria-label', 'Chat References');
      this.drawer.setAttribute('aria-hidden', 'true');

      const head = document.createElement('div');
      head.className = 'chat-references-head';
      const headingWrap = document.createElement('span');
      headingWrap.className = 'chat-references-heading-wrap';
      const heading = document.createElement('strong');
      heading.textContent = 'Chat References';
      this.headCount = document.createElement('span');
      this.headCount.className = 'chat-references-count';
      this.headCount.textContent = '0';
      headingWrap.append(heading, this.headCount);
      this.closeButton = document.createElement('button');
      this.closeButton.type = 'button';
      this.closeButton.className = 'chat-references-close';
      this.closeButton.title = 'Close Chat References';
      this.closeButton.setAttribute('aria-label', 'Close Chat References');
      this.closeButton.textContent = '×';
      head.append(headingWrap, this.closeButton);

      const toolbar = document.createElement('div');
      toolbar.className = 'chat-references-toolbar';
      const sortLabel = document.createElement('label');
      sortLabel.textContent = 'Sort by date';
      this.sortSelect = document.createElement('select');
      this.sortSelect.className = 'chat-references-sort';
      this.sortSelect.setAttribute('aria-label', 'Sort Chat References by date');
      for (const [value, label] of [['newest', 'Newest first'], ['oldest', 'Oldest first']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        option.selected = value === this.sortOrder;
        this.sortSelect.appendChild(option);
      }
      sortLabel.appendChild(this.sortSelect);
      toolbar.appendChild(sortLabel);

      this.list = document.createElement('div');
      this.list.className = 'chat-references-list';
      this.detail = document.createElement('div');
      this.detail.className = 'chat-reference-detail';
      this.detail.hidden = true;
      this.status = document.createElement('div');
      this.status.className = 'chat-references-status';
      this.status.setAttribute('aria-live', 'polite');
      this.status.hidden = true;

      this.drawer.append(head, toolbar, this.list, this.detail, this.status);
      body?.append(this.rail, this.drawer);
    }

    bindEvents() {
      this.root.addEventListener('vw:chat-drawer-open', event => {
        if (event.detail?.drawer !== 'references') this.setOpen(false);
      });
      this.rail.addEventListener('click', () => this.setOpen(!this.root.classList.contains('chat-references-open')));
      this.closeButton.addEventListener('click', () => this.setOpen(false, { restoreFocus: true }));
      this.sortSelect.addEventListener('change', () => {
        this.sortOrder = this.sortSelect.value === 'oldest' ? 'oldest' : 'newest';
        setSavedSortOrder(this.sortOrder);
        this.renderList();
      });
      this.drawer.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        this.setOpen(false, { restoreFocus: true });
      });
      window.addEventListener(EVENT_NAME, event => {
        const detail = event.detail || {};
        if (detail.sourceId === this.instanceId) return;
        if (String(detail.agentId || '') !== String(this.getAgentId() || '')) return;
        this.refreshForAgent({ preserveView: true });
      });
    }

    setOpen(open, { restoreFocus = false } = {}) {
      const next = Boolean(open);
      this.root.classList.toggle('chat-references-open', next);
      this.rail.setAttribute('aria-expanded', next ? 'true' : 'false');
      this.drawer.setAttribute('aria-hidden', next ? 'false' : 'true');
      if (next) {
        this.root.dispatchEvent(new CustomEvent('vw:chat-drawer-open', { detail: { drawer: 'references' } }));
        this.root.querySelector('.chat-prompt-nav')?.classList.remove('open');
        this.refreshForAgent({ preserveView: true });
        requestAnimationFrame(() => {
          if (this.root.classList.contains('chat-references-open')) this.closeButton.focus({ preventScroll: true });
        });
      } else {
        this.showListView();
        if (restoreFocus) this.rail.focus({ preventScroll: true });
      }
    }

    resetMessages() {
      this.messageBindings = [];
    }

    attachMessage(node, { role, text, ts, senderLabel, senderKind } = {}) {
      const normalizedRole = String(role || '').toLowerCase();
      const content = String(text || '').trim();
      if (!node || !['user', 'assistant'].includes(normalizedRole) || !content) return null;
      const bubble = node.querySelector('.chat-bubble');
      if (!bubble) return null;
      bubble.querySelectorAll(':scope > .chat-reference-add, :scope > .chat-message-actions > .chat-reference-add').forEach(button => button.remove());
      const actions = ensureMessageActions(bubble);
      if (!actions) return null;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-reference-add';
      button.title = 'Add to Chat References';
      button.setAttribute('aria-label', 'Add to Chat References');
      button.innerHTML = `${iconSvg('bookmark-plus')}<span>Add to Chat References</span>`;
      bubble.classList.add('chat-referenceable');
      actions.appendChild(button);

      const binding = {
        node,
        bubble,
        button,
        role: normalizedRole,
        text: content,
        ts: timestampIso(ts),
        senderLabel: String(senderLabel || (normalizedRole === 'user' ? 'You' : this.getAgentLabel()) || 'Agent'),
        senderKind: String(senderKind || (normalizedRole === 'user' ? 'human' : 'agent')),
        sourceKey: buildReferenceSourceKey({
          agentId: this.getAgentId(),
          sessionKey: this.getSessionKey(),
          role: normalizedRole,
          text: content,
          ts
        })
      };
      this.messageBindings.push(binding);
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        this.addMessageReference(binding);
      });
      this.syncMessageButton(binding);
      return button;
    }

    updateMessage(node, text) {
      const binding = this.messageBindings.find(item => item.node === node);
      if (!binding) return;
      binding.text = String(text || '').trim();
      binding.sourceKey = buildReferenceSourceKey({
        agentId: this.getAgentId(),
        sessionKey: this.getSessionKey(),
        role: binding.role,
        text: binding.text,
        ts: binding.ts
      });
      this.syncMessageButton(binding);
    }

    syncMessageButton(binding) {
      if (!binding?.button?.isConnected) return;
      const saved = this.references.some(reference => reference.sourceKey && reference.sourceKey === binding.sourceKey);
      binding.button.classList.toggle('is-saved', saved);
      binding.button.disabled = saved;
      binding.button.title = saved ? 'Already in Chat References' : 'Add to Chat References';
      binding.button.setAttribute('aria-label', saved ? 'Already in Chat References' : 'Add to Chat References');
      const label = binding.button.querySelector('span');
      if (label) label.textContent = saved ? 'Added to Chat References' : 'Add to Chat References';
    }

    syncMessageButtons() {
      this.messageBindings = this.messageBindings.filter(binding => binding.node?.isConnected);
      this.messageBindings.forEach(binding => this.syncMessageButton(binding));
    }

    async refreshForAgent({ preserveView = false } = {}) {
      const agentId = String(this.getAgentId() || '').trim();
      const sequence = ++this.requestSequence;
      this.activeAgentId = agentId;
      if (!agentId) {
        this.references = [];
        this.rail.disabled = true;
        this.renderList();
        return;
      }
      this.rail.disabled = false;
      if (!preserveView || !this.references.length) this.renderLoading();
      try {
        const params = new URLSearchParams({ agentId, order: this.sortOrder });
        const data = await requestJson(`/api/chat-references?${params.toString()}`);
        if (sequence !== this.requestSequence || agentId !== String(this.getAgentId() || '').trim()) return;
        this.references = Array.isArray(data.references) ? data.references : [];
        this.renderList();
        this.syncMessageButtons();
        if (preserveView && this.selectedReferenceId) {
          const selected = this.references.find(reference => reference.id === this.selectedReferenceId);
          if (selected) this.showDetail(selected);
          else this.showListView();
        }
      } catch (error) {
        if (sequence !== this.requestSequence) return;
        this.renderError(error?.message || 'Chat References are unavailable.');
      }
    }

    renderLoading() {
      this.list.replaceChildren();
      const row = document.createElement('div');
      row.className = 'chat-references-empty';
      row.textContent = 'Loading Chat References…';
      this.list.appendChild(row);
    }

    renderError(message) {
      this.list.replaceChildren();
      const row = document.createElement('div');
      row.className = 'chat-references-empty error';
      row.textContent = message;
      this.list.appendChild(row);
      this.showStatus(message, { kind: 'error' });
    }

    renderList() {
      const ordered = sortReferences(this.references, this.sortOrder);
      this.list.replaceChildren();
      this.railCount.textContent = String(ordered.length);
      this.headCount.textContent = String(ordered.length);
      this.rail.setAttribute('aria-label', `Open Chat References (${ordered.length})`);
      if (!ordered.length) {
        const empty = document.createElement('div');
        empty.className = 'chat-references-empty';
        const title = document.createElement('strong');
        title.textContent = 'No saved references';
        const copy = document.createElement('span');
        copy.textContent = 'Use “Add to Chat References” on a user or agent message.';
        empty.append(title, copy);
        this.list.appendChild(empty);
        this.showListView();
        return;
      }
      const fragment = document.createDocumentFragment();
      for (const reference of ordered) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `chat-reference-card ${reference.role === 'user' ? 'user' : 'assistant'}`;
        button.setAttribute('aria-label', `Open Chat Reference from ${reference.senderLabel || 'message'}`);
        const meta = document.createElement('span');
        meta.className = 'chat-reference-card-meta';
        const sender = document.createElement('strong');
        sender.textContent = reference.senderLabel || (reference.role === 'user' ? 'You' : 'Agent');
        const date = document.createElement('time');
        date.dateTime = reference.createdAt || '';
        date.textContent = formatReferenceDate(reference.createdAt);
        meta.append(sender, date);
        const preview = document.createElement('span');
        preview.className = 'chat-reference-card-preview';
        preview.textContent = normalizeReferencePreview(reference.content);
        const expand = document.createElement('span');
        expand.className = 'chat-reference-card-expand';
        expand.textContent = 'Open reference →';
        button.append(meta, preview, expand);
        button.addEventListener('click', () => this.showDetail(reference));
        fragment.appendChild(button);
      }
      this.list.appendChild(fragment);
    }

    showListView() {
      this.selectedReferenceId = '';
      this.detail.hidden = true;
      this.list.hidden = false;
      this.sortSelect.disabled = false;
    }

    showDetail(reference) {
      if (!reference) return;
      this.selectedReferenceId = reference.id;
      this.list.hidden = true;
      this.detail.hidden = false;
      this.sortSelect.disabled = true;
      this.renderDetail(reference);
    }

    renderDetail(reference, { editing = false } = {}) {
      this.detail.replaceChildren();
      const nav = document.createElement('div');
      nav.className = 'chat-reference-detail-nav';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'chat-reference-back';
      back.textContent = '← All references';
      back.addEventListener('click', () => this.showListView());
      nav.appendChild(back);

      const meta = document.createElement('div');
      meta.className = 'chat-reference-detail-meta';
      const sender = document.createElement('strong');
      sender.textContent = reference.senderLabel || (reference.role === 'user' ? 'You' : 'Agent');
      const saved = document.createElement('time');
      saved.dateTime = reference.createdAt || '';
      saved.textContent = `Saved ${formatReferenceDate(reference.createdAt)}`;
      meta.append(sender, saved);

      const content = document.createElement('div');
      content.className = 'chat-reference-detail-content';
      const actions = document.createElement('div');
      actions.className = 'chat-reference-detail-actions';

      if (editing) {
        const textarea = document.createElement('textarea');
        textarea.className = 'chat-reference-edit-input';
        textarea.value = reference.content || '';
        textarea.maxLength = 50000;
        textarea.setAttribute('aria-label', 'Edit Chat Reference');
        const cancel = this.actionButton('Cancel', 'secondary', () => this.renderDetail(reference));
        const saveButton = this.actionButton('Save changes', 'primary', async () => {
          const nextContent = textarea.value.trim();
          if (!nextContent) {
            this.showStatus('A Chat Reference cannot be empty.', { kind: 'error' });
            return;
          }
          saveButton.disabled = true;
          try {
            const data = await requestJson('/api/chat-references/update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agentId: this.getAgentId(),
                referenceId: reference.id,
                content: nextContent
              })
            });
            this.references = this.references.map(item => item.id === reference.id ? data.reference : item);
            this.renderList();
            this.showDetail(data.reference);
            this.syncMessageButtons();
            this.broadcastChange();
            this.showStatus('Chat Reference updated.');
          } catch (error) {
            saveButton.disabled = false;
            this.showStatus(error?.message || 'Could not update Chat Reference.', { kind: 'error' });
          }
        });
        content.appendChild(textarea);
        actions.append(cancel, saveButton);
        this.detail.append(nav, meta, content, actions);
        requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
        return;
      }

      content.classList.add('chat-markdown');
      this.renderMarkdownInto(content, reference.content || '');
      const use = this.actionButton('Use in prompt', 'primary', () => this.useInPrompt(reference));
      const copy = this.actionButton('Copy', 'secondary', () => this.copyReference(reference));
      const edit = this.actionButton('Edit', 'secondary', () => this.renderDetail(reference, { editing: true }));
      const remove = this.actionButton('Remove', 'danger', () => this.removeReference(reference));
      actions.append(use, copy, edit, remove);
      this.detail.append(nav, meta, content, actions);
    }

    actionButton(label, kind, handler) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `chat-reference-action ${kind || 'secondary'}`;
      button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    }

    async addMessageReference(binding) {
      if (!binding || binding.button.disabled) return;
      const agentId = String(this.getAgentId() || '').trim();
      if (!agentId) {
        this.showStatus('Select an agent before saving a reference.', { kind: 'error' });
        return;
      }
      binding.button.disabled = true;
      binding.button.classList.add('is-saving');
      try {
        const data = await requestJson('/api/chat-references', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            content: binding.text,
            role: binding.role,
            senderLabel: binding.senderLabel,
            senderKind: binding.senderKind,
            sourceSessionKey: this.getSessionKey(),
            sourceKey: binding.sourceKey,
            messageAt: binding.ts
          })
        });
        if (!this.references.some(reference => reference.id === data.reference.id)) {
          this.references.push(data.reference);
        }
        binding.button.classList.remove('is-saving');
        this.renderList();
        this.syncMessageButtons();
        this.broadcastChange();
        this.setOpen(true);
        this.showStatus(data.created ? 'Added to Chat References.' : 'This message is already in Chat References.');
      } catch (error) {
        binding.button.disabled = false;
        binding.button.classList.remove('is-saving');
        this.setOpen(true);
        this.showStatus(error?.message || 'Could not add Chat Reference.', { kind: 'error' });
      }
    }

    useInPrompt(reference) {
      const input = this.getInput();
      if (!input) return;
      const block = [
        `[Chat Reference — ${reference.senderLabel || 'Saved message'}, saved ${formatReferenceDate(reference.createdAt)}]`,
        reference.content || ''
      ].join('\n');
      const current = String(input.value || '').trimEnd();
      input.value = current ? `${current}\n\n${block}` : block;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      this.showStatus('Reference added to the prompt.');
    }

    async copyReference(reference) {
      try {
        await navigator.clipboard.writeText(reference.content || '');
        this.showStatus('Reference copied.');
      } catch (_) {
        this.showStatus('Could not copy this reference.', { kind: 'error' });
      }
    }

    async removeReference(reference) {
      try {
        await requestJson('/api/chat-references/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: this.getAgentId(), referenceId: reference.id })
        });
        this.references = this.references.filter(item => item.id !== reference.id);
        this.renderList();
        this.showListView();
        this.syncMessageButtons();
        this.broadcastChange();
        this.showStatus('Chat Reference removed.', {
          actionLabel: 'Undo',
          onAction: () => this.restoreReference(reference)
        });
      } catch (error) {
        this.showStatus(error?.message || 'Could not remove Chat Reference.', { kind: 'error' });
      }
    }

    async restoreReference(reference) {
      try {
        const data = await requestJson('/api/chat-references', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: this.getAgentId(),
            content: reference.content,
            role: reference.role,
            senderLabel: reference.senderLabel,
            senderKind: reference.senderKind,
            sourceSessionKey: reference.sourceSessionKey,
            sourceKey: reference.sourceKey,
            messageAt: reference.messageAt
          })
        });
        this.references.push(data.reference);
        this.renderList();
        this.syncMessageButtons();
        this.broadcastChange();
        this.showStatus('Chat Reference restored.');
      } catch (error) {
        this.showStatus(error?.message || 'Could not restore Chat Reference.', { kind: 'error' });
      }
    }

    broadcastChange() {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: { agentId: String(this.getAgentId() || ''), sourceId: this.instanceId }
      }));
    }

    showStatus(message, { kind = 'success', actionLabel = '', onAction = null } = {}) {
      window.clearTimeout(this.statusTimer);
      this.status.replaceChildren();
      this.status.className = `chat-references-status ${kind}`;
      const copy = document.createElement('span');
      copy.textContent = message;
      this.status.appendChild(copy);
      if (actionLabel && typeof onAction === 'function') {
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = actionLabel;
        action.addEventListener('click', () => {
          this.status.hidden = true;
          onAction();
        }, { once: true });
        this.status.appendChild(action);
      }
      this.status.hidden = false;
      this.statusTimer = window.setTimeout(() => { this.status.hidden = true; }, actionLabel ? 7000 : 3500);
    }
  }

  globalThis.VirtualWorldChatReferences = {
    ChatReferencesPanel,
    buildReferenceSourceKey,
    formatReferenceDate,
    ensureMessageActions,
    normalizeReferencePreview,
    sortReferences
  };
})();
