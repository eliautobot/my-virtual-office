/*
 * Virtual Office chat: send while working (design 4.3).
 *
 * Decides what Enter / Ctrl+Enter / the Send button do while the agent is
 * still answering, and keeps the per-chat queue of messages that wait for the
 * turn to end.  Three modes come from the capability manifest (`caps.queue`):
 *   redirect (Hermes)  Enter = into this turn; Ctrl+Enter, files or a waiting
 *                      approval / secret = queued; words while a question
 *                      waits = skip the question, then into this turn.
 *   steer (OpenClaw)   Enter = into this turn; Ctrl+Enter = after this answer.
 *   local (others)     every message while busy waits in the queue.
 * The queue is per chat, survives a reload (sessionStorage) and is paused by
 * Stop until Resume.  No DOM: the same code runs in Node regression tests.
 */
(function initChatQueue(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatQueueFactory() {
  'use strict';

  const MODES = ['redirect', 'steer', 'local'];
  const STORAGE_PREFIX = 'vo.chat.queue:';
  const MAX_ITEMS = 20;
  const MAX_TEXT = 100000;
  // sessionStorage holds ~5 MB per origin: files above this budget are not
  // kept across a reload (the words are).
  const MAX_STORED_CHARS = 1500000;

  function mode(value) {
    return MODES.includes(value) ? value : 'local';
  }

  function textOf(value) {
    return typeof value === 'string' ? value.slice(0, MAX_TEXT) : '';
  }

  /**
   * What a submit does.
   * input: { busy, sending, mode, ctrl, text, files, waiting: { clarify: [ids], blocking } }
   *   busy     a turn is running for this chat
   *   sending  the last message is still uploading / not delivered yet
   * returns { action } with action one of
   *   none | send | queue | redirect | steer | followup | skip-redirect
   */
  function decide(input = {}) {
    const text = textOf(input.text).trim();
    const files = Array.isArray(input.files) ? input.files.length : (Number(input.files) || 0);
    if (!text && !files) return { action: 'none' };
    if (!input.busy && !input.sending) return { action: 'send' };
    // One message at a time leaves the window: a second one waits its turn.
    if (input.sending) return { action: 'queue', reason: 'sending' };
    const m = mode(input.mode);
    if (m === 'local') return { action: 'queue', reason: 'local' };
    const waiting = input.waiting || {};
    const clarify = Array.isArray(waiting.clarify) ? waiting.clarify.filter(Boolean) : [];
    const blocking = waiting.blocking === true;
    if (m === 'steer') {
      // An approval cannot be answered with words: they wait for it.
      if (blocking) return { action: 'queue', reason: 'blocking' };
      return { action: input.ctrl ? 'followup' : 'steer' };
    }
    // redirect
    const wordsOnly = !!text && !files;
    if (!input.ctrl && wordsOnly && clarify.length && !blocking) return { action: 'skip-redirect', questions: clarify };
    if (input.ctrl) return { action: 'queue', reason: 'later' };
    if (!wordsOnly) return { action: 'queue', reason: 'files' };
    if (blocking) return { action: 'queue', reason: 'blocking' };
    return { action: 'redirect' };
  }

  /** The hint under the composer while busy (design 4.3). */
  function hint(queueMode) {
    const m = mode(queueMode);
    if (m === 'redirect' || m === 'steer') return 'Enter adds to this turn · Ctrl+Enter sends after it';
    return 'Enter sends after this answer';
  }

  function newId() {
    return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function cleanFile(file) {
    if (!file || typeof file !== 'object') return null;
    const out = {
      name: String(file.name || 'attachment').slice(0, 200),
      mimeType: String(file.mimeType || file.type || 'application/octet-stream').slice(0, 120),
      size: Number(file.size) || 0
    };
    if (typeof file.dataUrl === 'string') out.dataUrl = file.dataUrl;
    if (file.id) out.id = String(file.id);
    return out;
  }

  function cleanItem(item) {
    if (!item || typeof item !== 'object') return null;
    const text = textOf(item.text);
    const files = (Array.isArray(item.files) ? item.files : []).map(cleanFile).filter(Boolean).slice(0, 10);
    const lostFiles = (Array.isArray(item.lostFiles) ? item.lostFiles : []).map(String).slice(0, 10);
    if (!text.trim() && !files.length && !lostFiles.length) return null;
    const out = { id: String(item.id || newId()), text, files, at: Number(item.at) || Date.now() };
    if (lostFiles.length) out.lostFiles = lostFiles;
    return out;
  }

  /** One chat's queue. `storage` is sessionStorage (or a test double); `key` the chat. */
  class Queue {
    constructor({ key = '', storage = null } = {}) {
      this.key = String(key || '');
      this.storage = storage;
      this.items = [];
      this.paused = false;
      this.load();
    }

    get size() { return this.items.length; }

    storageKey() { return STORAGE_PREFIX + this.key; }

    load() {
      this.items = [];
      this.paused = false;
      if (!this.storage || !this.key) return this;
      let raw = null;
      try { raw = this.storage.getItem(this.storageKey()); } catch (_) { raw = null; }
      if (!raw) return this;
      try {
        const data = JSON.parse(raw);
        this.items = (Array.isArray(data.items) ? data.items : []).map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS);
        this.paused = data.paused === true && this.items.length > 0;
      } catch (_) {}
      return this;
    }

    save() {
      if (!this.storage || !this.key) return false;
      const key = this.storageKey();
      try {
        if (!this.items.length) { this.storage.removeItem(key); return true; }
        let items = this.items;
        let json = JSON.stringify({ items, paused: this.paused });
        if (json.length > MAX_STORED_CHARS) {
          // Keep the words; files too big to keep are named so the person can attach them again.
          items = this.items.map((item) => (item.files.length ? {
            ...item, files: [], lostFiles: [...(item.lostFiles || []), ...item.files.map(f => f.name)]
          } : item));
          json = JSON.stringify({ items, paused: this.paused });
        }
        this.storage.setItem(key, json);
        return true;
      } catch (_) {
        return false;
      }
    }

    /** Move to another chat: what was queued here stays saved under this chat. */
    rekey(key) {
      const next = String(key || '');
      if (next === this.key) return this;
      this.key = next;
      return this.load();
    }

    /** Hand this chat's items to `key` (a new chat that just got its id). */
    moveTo(key) {
      const next = String(key || '');
      if (!next || next === this.key) return this;
      const items = this.items;
      const paused = this.paused;
      this.items = [];
      this.save();
      this.key = next;
      this.load();
      this.items = [...this.items, ...items].slice(0, MAX_ITEMS);
      this.paused = this.paused || paused;
      this.save();
      return this;
    }

    add(item) {
      const clean = cleanItem(item);
      if (!clean) return null;
      if (this.items.length >= MAX_ITEMS) return null;
      this.items.push(clean);
      this.save();
      return clean;
    }

    /** Put an item back first in line (a send that could not leave). */
    unshift(item) {
      const clean = cleanItem(item);
      if (!clean) return null;
      this.items.unshift(clean);
      this.items = this.items.slice(0, MAX_ITEMS);
      this.save();
      return clean;
    }

    find(id) {
      return this.items.find(item => item.id === String(id)) || null;
    }

    remove(id) {
      const before = this.items.length;
      this.items = this.items.filter(item => item.id !== String(id));
      if (!this.items.length) this.paused = false;
      this.save();
      return this.items.length !== before;
    }

    /** Edit = the item leaves the queue and goes back into the composer. */
    edit(id) {
      const item = this.find(id);
      if (!item) return null;
      this.remove(id);
      return item;
    }

    /** Take one item out now (Send now); the queue keeps its order. */
    pick(id) {
      const item = this.find(id);
      if (!item) return null;
      this.remove(id);
      return item;
    }

    /** First item, removed (the drain sends it). */
    take() {
      const item = this.items.shift() || null;
      if (!this.items.length) this.paused = false;
      this.save();
      return item;
    }

    /** What the drain should send now, or null. Does not remove it. */
    next({ busy = false, sending = false } = {}) {
      if (this.paused || busy || sending || !this.items.length) return null;
      return this.items[0];
    }

    pause() {
      if (!this.items.length) return false;
      this.paused = true;
      this.save();
      return true;
    }

    resume() {
      const was = this.paused;
      this.paused = false;
      this.save();
      return was;
    }

    clear() {
      this.items = [];
      this.paused = false;
      this.save();
    }

    label() {
      if (!this.items.length) return '';
      return `${this.items.length} queued${this.paused ? ', paused' : ''}`;
    }

    toJSON() {
      return { key: this.key, paused: this.paused, items: this.items.map(item => ({ ...item })) };
    }
  }

  function create(options) {
    return new Queue(options);
  }

  /** A short one-line preview of an item for its chip. */
  function preview(item, max = 60) {
    if (!item) return '';
    const words = String(item.text || '').replace(/\s+/g, ' ').trim();
    const files = (item.files || []).length + (item.lostFiles || []).length;
    let out = words.length > max ? words.slice(0, max - 1) + '…' : words;
    if (files) out += (out ? ' ' : '') + `📎${files}`;
    return out || '(empty)';
  }

  return { MODES, STORAGE_PREFIX, MAX_ITEMS, Queue, create, decide, hint, mode, preview };
});
