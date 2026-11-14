/*
 * Virtual Office chat capabilities.
 *
 * The chat window turns features on from the server's capability manifest
 * (`GET /api/agent-chat/can?agent=<id>`), never from the provider name.  This
 * file normalises that manifest (anything missing is off), builds the same
 * shape from the older registry flags when no manifest is available (Codex,
 * Claude Code, OpenCode, Antigravity look exactly as before), and derives the
 * small set of UI flags and texts the window needs.  No browser APIs: the same
 * code runs in Node regression tests.
 */
(function initChatCaps(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatCaps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatCapsFactory() {
  'use strict';

  const BOOLEAN_CAPS = [
    'stream', 'sessions', 'sessionCreate', 'sessionRename', 'sessionDelete', 'history', 'stop', 'models', 'effort',
    'context', 'attachments', 'files', 'approvals', 'questions', 'secrets', 'plan', 'progressCard', 'tasks', 'taskSteer',
    'observe', 'presence', 'titles', 'media', 'browser', 'screen', 'computer', 'computerWrite'
  ];
  const TRANSPORTS = ['hermes-serve', 'hermes-api', 'openclaw', 'codex', 'claude-code', 'opencode', 'antigravity', 'builtin'];
  const QUEUE_MODES = ['redirect', 'steer', 'local'];
  const APPROVAL_OPTIONS = ['allow-once', 'allow-session', 'allow-always', 'deny'];
  const APPROVAL_LABELS = {
    'allow-once': 'Allow once',
    'allow-session': 'Allow in this chat',
    'allow-always': 'Always allow',
    deny: 'Deny'
  };
  const APPROVAL_ALIASES = {
    once: 'allow-once', allow: 'allow-once', approve: 'allow-once', 'allow-once': 'allow-once', allow_once: 'allow-once',
    session: 'allow-session', 'allow-session': 'allow-session', allow_session: 'allow-session',
    always: 'allow-always', 'allow-always': 'allow-always', allow_always: 'allow-always',
    deny: 'deny', reject: 'deny', decline: 'deny'
  };
  const DEFAULT_APPROVAL_OPTIONS = ['allow-once', 'deny'];
  const DEFAULT_LIMITS = { attachmentBytes: 25 * 1024 * 1024, maxFiles: 10 };
  const IMAGE_SHRINK_BYTES = 3 * 1024 * 1024;
  const FAILURE_REASONS = ['offline', 'signin', 'gone', 'licence'];

  const FULL_ACCESS_FIX = 'Open Agent Providers, Edit the connection and choose Full access.';
  const LOCKED_TEXTS = {
    settings: (provider) => `This connection has Chat only access: ${possessive(provider)} settings are not changed from here.`,
    computerWrite: (provider) => `This connection has Chat only access: files on ${possessive(provider)} computer are not changed from here.`,
    screen: () => "This connection is set up for chat only: the agent's screen needs Full access (Agent Providers, then its connection).",
    browser: () => "This connection is set up for chat only: the agents' browser needs Full access (Agent Providers, then its connection)."
  };
  const FAILURE_TEXTS = {
    offline: { message: "The agent's provider is not answering.", fix: 'The office keeps trying by itself.' },
    signin: { message: 'The provider needs you to sign in again.', fix: 'Open Agent Providers, Edit the connection and enter the credentials.' },
    gone: { message: 'This agent is no longer on its provider.', fix: 'Open Agent Providers to check the connection.' },
    licence: { message: 'This agent is not available with the current licence.', fix: '' }
  };
  const SIDE_TABS = [
    { id: 'tasks', label: 'Tasks', cap: 'tasks' },
    { id: 'browser', label: 'Browser', cap: 'browser' },
    { id: 'screen', label: 'Screen', cap: 'screen' },
    { id: 'files', label: 'Files', cap: 'computer' }
  ];

  function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function possessive(name) {
    return /s$/i.test(name) ? `${name}'` : `${name}'s`;
  }

  function text(value, max = 400) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  function positiveInt(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  }

  function providerName(kind, transport) {
    const key = String(transport || kind || '').toLowerCase();
    if (key.startsWith('hermes')) return 'Hermes';
    if (key === 'openclaw') return 'OpenClaw';
    if (key === 'codex') return 'Codex';
    if (key === 'claude-code' || key === 'claude') return 'Claude Code';
    if (key === 'opencode') return 'OpenCode';
    if (key === 'antigravity') return 'Antigravity';
    return 'the provider';
  }

  /** Map any spelling of an approval option to allow-once / allow-session / allow-always / deny. */
  function approvalOption(value) {
    const key = String(value || '').trim().toLowerCase();
    return APPROVAL_ALIASES[key] || '';
  }

  function approvalOptions(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const option = approvalOption(item);
      if (option && !out.includes(option)) out.push(option);
    }
    return out.sort((a, b) => APPROVAL_OPTIONS.indexOf(a) - APPROVAL_OPTIONS.indexOf(b));
  }

  function emptyCaps() {
    const caps = {};
    for (const name of BOOLEAN_CAPS) caps[name] = false;
    caps.approvalOptions = [];
    caps.queue = 'local';
    return caps;
  }

  function normalizeCaps(value) {
    const raw = asRecord(value);
    const caps = emptyCaps();
    for (const name of BOOLEAN_CAPS) caps[name] = raw[name] === true;
    // Write access to the agent's computer means nothing without read access.
    if (!caps.computer) caps.computerWrite = false;
    if (!caps.approvals) caps.approvalOptions = [];
    else {
      const options = approvalOptions(raw.approvalOptions);
      caps.approvalOptions = options.length ? options : DEFAULT_APPROVAL_OPTIONS.slice();
    }
    if (!caps.questions) caps.secrets = false;
    if (!caps.plan) caps.progressCard = false;
    if (!caps.tasks) caps.taskSteer = false;
    caps.queue = QUEUE_MODES.includes(raw.queue) ? raw.queue : 'local';
    return caps;
  }

  function normalizeFailure(raw, base) {
    const reason = FAILURE_REASONS.includes(raw.reason) ? raw.reason : 'offline';
    const fallback = FAILURE_TEXTS[reason];
    return {
      ...base,
      ok: false,
      reason,
      message: text(raw.message) || fallback.message,
      fix: text(raw.fix) || fallback.fix
    };
  }

  /**
   * Normalise a `can` response.  Always returns an object with every field
   * present; `ok:false` keeps `caps` all off so nothing is offered.
   */
  function normalize(value) {
    const raw = asRecord(value);
    const transport = TRANSPORTS.includes(raw.transport) ? raw.transport : '';
    const connection = asRecord(raw.connection);
    const base = {
      ok: raw.ok === true,
      agent: text(raw.agent, 200),
      kind: text(raw.kind, 80),
      transport,
      view: raw.view === 'hermes' ? 'hermes' : 'default',
      manage: raw.manage === true,
      access: raw.access === 'full' ? 'full' : 'chat',
      connection: {
        id: text(connection.id, 200),
        name: text(connection.name, 200),
        state: text(connection.state, 40),
        detail: text(connection.detail),
        fix: text(connection.fix)
      },
      caps: emptyCaps(),
      locked: {},
      limits: { ...DEFAULT_LIMITS },
      prefs: { model: '', effort: '' },
      source: raw.source === 'registry' ? 'registry' : 'server',
      normalized: true
    };
    if (!base.ok) return normalizeFailure(raw, base);

    base.caps = normalizeCaps(raw.caps);
    const locked = asRecord(raw.locked);
    for (const key of ['screen', 'browser', 'computerWrite', 'settings']) {
      const reason = text(locked[key]);
      if (reason) base.locked[key] = reason;
    }
    const limits = asRecord(raw.limits);
    base.limits = {
      attachmentBytes: positiveInt(limits.attachmentBytes, DEFAULT_LIMITS.attachmentBytes),
      maxFiles: Math.min(positiveInt(limits.maxFiles, DEFAULT_LIMITS.maxFiles), 50)
    };
    const prefs = asRecord(raw.prefs);
    base.prefs = { model: text(prefs.model, 200), effort: text(prefs.effort, 40) };
    return base;
  }

  /**
   * The manifest shape built from today's registry capability flags (the
   * `data-capabilities` of the agent picker).  Used while the server route is
   * missing or did not answer, so providers keep behaving as before.
   */
  function fromRegistry(capabilities, options = {}) {
    const flags = asRecord(capabilities);
    const kind = text(options.kind, 80);
    const transport = TRANSPORTS.includes(options.transport) ? options.transport : (TRANSPORTS.includes(kind) ? kind : '');
    return normalize({
      ok: true,
      source: 'registry',
      agent: options.agent || '',
      kind,
      transport,
      manage: options.manage === true,
      access: 'chat',
      caps: {
        stream: flags.streaming === true,
        sessions: !!(flags.sessions || flags.sessionCreate || flags.sessionSwitch),
        sessionCreate: flags.sessionCreate === true,
        sessionDelete: flags.sessionDelete === true,
        history: !!(flags.sessions || flags.chat),
        stop: flags.interrupt === true,
        attachments: flags.attachments === true,
        files: flags.attachments === true,
        approvals: flags.approvals === true,
        approvalOptions: DEFAULT_APPROVAL_OPTIONS,
        queue: 'local'
      }
    });
  }

  /** True when the registry flags declared nothing (an older agent row). */
  function registryDeclared(capabilities) {
    return Object.keys(asRecord(capabilities)).length > 0;
  }

  function lockedText(n, key) {
    if (n.locked[key]) return n.locked[key];
    if (n.access === 'full') return '';
    const make = LOCKED_TEXTS[key];
    return make ? make(providerName(n.kind, n.transport)) : '';
  }

  /** Side panel tabs in order: shown when the cap is on or a lock explains it. */
  function sideTabs(n) {
    const tabs = [];
    for (const tab of SIDE_TABS) {
      const on = n.caps[tab.cap] === true;
      const locked = on ? '' : (n.locked[tab.cap] || '');
      if (!on && !locked) continue;
      const entry = { id: tab.id, label: tab.label, locked };
      if (tab.id === 'files') {
        entry.write = n.caps.computerWrite;
        if (!entry.write && n.locked.computerWrite) entry.writeLocked = n.locked.computerWrite;
      }
      if (locked) entry.action = n.manage ? 'Open Agent Providers' : '';
      tabs.push(entry);
    }
    return tabs;
  }

  function busyHint(queue) {
    if (queue === 'redirect' || queue === 'steer') return 'Enter adds to this turn · Ctrl+Enter sends after it';
    return 'Enter sends after this answer';
  }

  function connectionLine(n) {
    const name = n.connection.name || providerName(n.kind, n.transport);
    const state = n.connection.state;
    if (!n.ok) {
      return { tone: 'error', text: n.message, fix: n.fix, action: n.manage ? 'Open Agent Providers' : '' };
    }
    if (state === 'connecting') return { tone: 'info', text: `Reconnecting to ${name}...`, fix: '', action: '' };
    if (state === 'pairing') {
      return { tone: 'info', text: n.connection.detail || `${name} is waiting for approval.`, fix: n.connection.fix, action: n.manage ? 'Open Agent Providers' : '' };
    }
    if (state === 'error' || state === 'offline') {
      return {
        tone: 'error',
        text: n.connection.detail || `${name} is not answering.`,
        fix: n.connection.fix,
        action: n.manage ? 'Open Agent Providers' : ''
      };
    }
    if (state === 'off') {
      return { tone: 'error', text: `The ${name} connection is switched off.`, fix: '', action: n.manage ? 'Open Agent Providers' : '' };
    }
    return null;
  }

  /**
   * Everything the window toggles, in one flat object.  `chat.js` applies it
   * (buttons hidden and disabled when off) and never asks for the provider name.
   */
  function derive(value) {
    const n = value && value.normalized === true ? value : normalize(value);
    const caps = n.caps;
    const live = n.ok === true;
    const tabs = live ? sideTabs(n) : [];
    return {
      derived: true,
      ok: live,
      view: n.view,
      transport: n.transport,
      access: n.access,
      manage: n.manage,
      showSessions: live && caps.sessions,
      showNewSession: live && caps.sessionCreate,
      showRename: live && caps.sessionRename,
      showDelete: live && caps.sessionDelete,
      showStop: live && caps.stop,
      showAttach: live && caps.attachments,
      picturesOnly: live && caps.attachments && !caps.files,
      showModelPicker: live && caps.models,
      showEffortPicker: live && caps.effort,
      showContext: live && caps.context,
      showPlan: live && caps.plan,
      showProgressActions: live && caps.progressCard,
      liveTitles: live && caps.titles,
      observe: live && caps.observe,
      approvals: live && caps.approvals,
      approvalButtons: live ? caps.approvalOptions.map((value) => ({
        value,
        label: APPROVAL_LABELS[value],
        confirm: value === 'allow-always' ? 'Always allow this command?' : ''
      })) : [],
      questions: live && caps.questions,
      secrets: live && caps.secrets,
      queue: live ? caps.queue : 'local',
      busyHint: busyHint(live ? caps.queue : 'local'),
      sideTabs: tabs,
      showPanelButton: tabs.length > 0,
      settingsLocked: live ? lockedText(n, 'settings') : '',
      lockedFix: live && n.access !== 'full' ? FULL_ACCESS_FIX : '',
      connectionLine: connectionLine(n),
      maxFiles: n.limits.maxFiles,
      attachmentBytes: n.limits.attachmentBytes
    };
  }

  function isImage(file) {
    const type = String(file?.type || '').toLowerCase();
    if (type) return type.startsWith('image/');
    return /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(String(file?.name || ''));
  }

  function megabytes(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10);
  }

  /**
   * Check one file before upload.  Images over 3 MB are not refused: the
   * window shrinks them to 2048 px (`shrink:true`).
   */
  function checkAttachment(value, file, alreadyAttached = 0) {
    const d = value && value.derived === true ? value : derive(value);
    if (!d.showAttach) return { ok: false, reason: 'This agent does not take attachments.' };
    if (alreadyAttached >= d.maxFiles) return { ok: false, reason: `Up to ${d.maxFiles} files per message.` };
    const image = isImage(file);
    if (!image && d.picturesOnly) return { ok: false, reason: 'This agent takes pictures only.' };
    const size = Number(file?.size) || 0;
    if (image) return { ok: true, shrink: size > IMAGE_SHRINK_BYTES };
    if (size > d.attachmentBytes) {
      return { ok: false, reason: `This file is too big for this agent (limit ${megabytes(d.attachmentBytes)} MB).` };
    }
    return { ok: true, shrink: false };
  }

  /** Stable text for "did anything change" checks before re-rendering. */
  function signature(value) {
    const n = value && value.normalized === true ? value : normalize(value);
    return JSON.stringify([n.ok, n.agent, n.transport, n.view, n.manage, n.access, n.caps, n.locked, n.limits,
      n.connection.state, n.ok ? '' : n.reason]);
  }

  return {
    APPROVAL_LABELS,
    BOOLEAN_CAPS,
    FULL_ACCESS_FIX,
    approvalOption,
    approvalOptions,
    checkAttachment,
    derive,
    fromRegistry,
    isImage,
    normalize,
    providerName,
    registryDeclared,
    signature
  };
});
