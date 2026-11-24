// Virtual Office Chat — Gateway WebSocket Client (Multi-Window)
(() => {
  let GATEWAY_TOKEN = '';
  let GATEWAY_URL = '';
  let GATEWAY_TRANSPORT = 'proxy';
  let GATEWAY_RPC_URL = '/api/openclaw/rpc';
  let GATEWAY_EVENTS_URL = '/api/openclaw/events';
  let ws = null;
  let gatewayEvents = null;
  let reqId = 0;
  let connected = false;
  let pendingCallbacks = {};
  let _chatWsPort = 8091;
  let GATEWAY_CLIENT_VERSION = 'unknown';
  let GATEWAY_PROTOCOL_VERSION = 4;
  let _modelBarInterval = null;
  let _sessionsListCache = { at: 0, promise: null, payload: null };
  const runOwners = new Map();
  let canRouteMissingUntil = 0;
  const canRequests = new Map();
  const LOCAL_GATEWAY_HOSTS = new Set(['127.0.0.1', 'localhost', '0.0.0.0', 'host.docker.internal']);

  // v0.12: with the copied provider layer on (VO_PROVIDER_LAYER, the default since 0.11) OpenClaw and Hermes agents
  // chat in the copied window (window.voPL) and this window never holds one: there is no office gateway client behind
  // it any more. The server says so in /gateway-info (provider "layer"); vo-provider-layer.js (the script after this
  // one) resolves window.voPLReady. Until both are known nothing here restores, lists or connects for OpenClaw.
  let layerHasGateway = false;   // /gateway-info: the layer has OpenClaw (no EventSource, no WebSocket from here)
  let layerPL = null;            // window.voPL once mounted
  let layerKnown = false;
  const LAYER_WAIT_MS = 8000;    // (a layer that never mounts: decide without it; its agents still never come here)
  const afterPageScripts = () => (document.readyState === 'loading'
    ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve());
  const layerMounted = afterPageScripts().then(() => (window.voPLReady
    ? Promise.race([Promise.resolve(window.voPLReady).catch(() => null), new Promise(r => setTimeout(() => r(null), LAYER_WAIT_MS))])
    : null)).then(pl => { layerPL = pl || window.voPL || null; return layerPL; });
  const gatewayInfoAtStart = loadGatewayInfo();
  /** Resolves once it is known whether the layer owns OpenClaw and Hermes (true/false). */
  const layerDecided = gatewayInfoAtStart.then(() => (layerHasGateway ? true : layerMounted.then(pl => !!pl)))
    .catch(() => false).then(owns => { layerKnown = true; return owns; });
  window.addEventListener('vo:pl-ready', () => { layerPL = window.voPL || layerPL; });
  /** window.voPL, waiting as long as the layer takes to mount (null: it is off or could not start). */
  async function theLayer() {
    const pl = await layerMounted;
    if (pl || window.voPL) return pl || window.voPL;
    return window.voPLReady ? Promise.resolve(window.voPLReady).catch(() => null).then(x => x || window.voPL || null) : null;
  }
  function layerOwnsChats() { return layerHasGateway || !!layerPL || !!window.voPL; }
  /** Option `opt` of an agent picker is an OpenClaw agent, or a Hermes agent of the layer (its pl- connection; a
   *  Hermes API-server agent stays here), while the layer owns them. */
  function isLayerOption(opt) {
    if (!opt || !layerOwnsChats()) return false;
    const kind = String(opt.dataset?.providerKind || 'openclaw').toLowerCase();
    if (kind === 'openclaw') return true;
    if (kind === 'hermes') return String(opt.dataset?.providerConnectionId || '').startsWith('pl-');
    return false;
  }
  /** The options a window of this office may show (all of them with the layer off). */
  function officeOptions(select) {
    return [...(select?.querySelectorAll('option') || [])].filter(opt => !isLayerOption(opt));
  }

  // unify (0.12): with the layer mounted (window.voPL) EVERY agent chats in the copied window: OpenClaw and Hermes, and
  // the office's own providers (Codex, Claude Code, OpenCode, Antigravity, a Hermes API server, extensions) as the
  // layer's kind `office`. This file then only routes: the Chat button, the dock and phone bar, "+", desk menus, the
  // roster, notifications, Office Life and ?chatAgents go to voPL; no office window is restored, filled or shown, and the
  // windows 0.9-0.12 saved move over once (migrateSavedChats). Layer off (VO_PROVIDER_LAYER=0) or no Node.js: voPL
  // never mounts, `router` is false and every path below is the office window as it was (frozen fallback).
  let router = null;             // null: not known yet; true: every agent goes to voPL; false: the office window
  const routerDecided = layerDecided.then(owns => (owns ? theLayer() : null)).catch(() => null)
    .then(pl => { router = !!pl; return router; });
  const routerOn = () => (router !== null ? Promise.resolve(router) : routerDecided);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  /** The office roster's row for agent `needle` (its key, agent id, status key or an alias), from /agents-list. */
  async function rosterRow(needle) {
    const id = String(needle ?? '');
    try {
      const data = await fetchAgentsListShared();
      return (data.agents || []).find(a => [a.key, a.agentId, a.statusKey, ...(Array.isArray(a.selectionAliases) ? a.selectionAliases : [])]
        .some(n => n !== undefined && n !== null && String(n) === id)) || null;
    } catch (_) { return null; }
  }
  /** An office chat key in the layer's terms (the copied window finds a chat by its provider key, else shows the agent's
   *  latest): OpenClaw keeps the gateway's key (agent:<id>:<chat>); every other provider's office key is
   *  `<kind>:<profile>[:<native id>]` and the layer keys that chat by its native id. null: no chat named. */
  function layerChatKey(sessionKey, row) {
    const key = String(sessionKey || '').trim();
    if (!key) return null;
    const kind = String(row?.providerKind || '').toLowerCase();
    if (kind === 'openclaw' || (!kind && key.startsWith('agent:'))) return key;
    const base = String(row?.sessionKey || '');
    if (base && key === base) return null;
    if (base && key.startsWith(base + ':')) return key.slice(base.length + 1) || null;
    const parts = key.split(':');
    return parts.length >= 3 ? parts.slice(2).join(':') : null;
  }
  /** unify: agent `needle` in the copied window (options.sessionKey: that office chat; options.newWindow: a window of its
   *  own; Office Life's options.focus {approvalId|questionId} and options.panel 'tasks' as in the office window). A layer that has not listed it yet (a connection coming up, the office kind's first look) gets a few seconds;
   *  it never opens in the office window instead. */
  async function routeAgent(needle, options = {}) {
    const pl = await theLayer();
    if (!pl) return null;
    for (let waited = 0; !pl.isLayerAgent(needle) && waited < LAYER_WAIT_MS; waited += 400) await sleep(400);
    const row = options.sessionKey || !pl.isLayerAgent(needle) ? await rosterRow(needle) : null;
    if (!pl.isLayerAgent(needle)) {
      chatToast(`${row?.name || needle} can't chat right now.`);
      return null;
    }
    const session = options.sessionKey ? layerChatKey(options.sessionKey, row) : null;
    const point = {};
    if (options.focus && (options.focus.approvalId || options.focus.questionId)) point.focus = options.focus;
    if (options.panel) point.panel = String(options.panel);
    return pl.open(needle, { session, newWindow: !!options.newWindow, ...point });
  }
  /** unify: ?chatAgents=a,b (each in a copied window of its own) or =auto (the first agents), ?chatView=all (the copied
   *  windows back) with the layer mounted. */
  async function routeQueryAgents() {
    const pl = await theLayer();
    if (!pl) return;
    const mode = new URLSearchParams(window.location.search).get('chatAgents');
    const max = globalThis.ChatWindows?.MAX || 4;
    if (!mode) { pl.showChats(); return; }
    if (mode === 'auto') {
      const agents = (typeof pl.agents === 'function' ? pl.agents() : []).filter(a => a && a.level).slice(0, max);
      for (const a of agents) if (typeof pl.openLayer === 'function') await pl.openLayer(a.id, { newWindow: true });
      return;
    }
    const keys = [...new Set(mode.split(',').map(s => s.trim()).filter(Boolean))].slice(0, max);
    for (const [i, key] of keys.entries()) await routeAgent(key, { newWindow: i > 0 });
  }
  let routerMigration = null;   // (the one-time move of the saved office windows, once it started: tests read it)

  const UNIFIED_KEY = 'vo.chat.unified.v1';
  const LAST_USED_KEY = 'vo.chat.last';   // (written and read by vo-mount.mjs: { officeId, agent, session, at })
  const readStored = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; } };
  const writeStored = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode */ } };
  /** unify, once per browser: the office windows 0.9-0.12 saved (vo.chat.windows; the agent and chat of each in
   *  vo-chat-selection-v1) come back as copied windows on the same agent and chat, shown or put away as they were (a
   *  phone: the front one shown); the one shown last seeds vo.chat.last, so the Chat button reopens it. The old keys stay
   *  as they are (a restart with VO_PROVIDER_LAYER=0 reads them). An agent the office lists but the layer has not yet (its
   *  connection coming up) is tried again on the next load, three loads at most; one the office no longer has is dropped.
   *  Resolves what it did (tests). */
  async function migrateSavedChats() {
    const pl = await theLayer();
    const mark = readStored(UNIFIED_KEY);
    if (!pl || (mark && mark.done)) return null;
    const listed = () => (typeof pl.agents === 'function' ? pl.agents() : []) || [];
    if (typeof pl.agents === 'function' && !listed().some(a => a && a.level)) return null;   // (signed out, nothing shared yet: next load)
    const savedWins = readStored(globalThis.ChatWindows?.STORAGE_KEY || 'vo.chat.windows');
    const picks = readSavedChatSelections();
    const front = typeof savedWins?.front === 'string' ? savedWins.front : null;
    const pickOf = slot => {
      const p = picks[slot];
      if (p && typeof p === 'object' && p.selectedAgentKey) return { key: String(p.selectedAgentKey), sessionKey: String(p.sessionKey || '') };
      return slot === 'primary' ? { key: 'main', sessionKey: '' } : null;   // (the main window without a choice showed "main")
    };
    const slots = new Set();
    let entries = (Array.isArray(savedWins?.wins) ? savedWins.wins : [])
      .filter(w => w && typeof w.slot === 'string' && !slots.has(w.slot) && slots.add(w.slot))
      .map(w => ({ slot: w.slot, min: !!w.min, ...(pickOf(w.slot) || {}) }))
      .filter(e => e.key);
    // (the window the Chat button brought back last: the front one, else the last shown, else the last saved; no window
    // saved: the main window's own choice, which it opened on)
    const seed = entries.find(e => e.slot === front && !e.min) || [...entries].reverse().find(e => !e.min) || entries[entries.length - 1]
      || (picks.primary ? { slot: 'primary', min: true, ...pickOf('primary') } : null);
    if (Array.isArray(mark?.pending)) entries = entries.filter(e => mark.pending.includes(e.slot));
    const seeding = !!seed && !readStored(LAST_USED_KEY);   // (this browser chose since: its own choice stands)
    const wanted = [...entries, ...(seeding ? [seed] : [])];
    for (let waited = 0; wanted.some(e => !pl.isLayerAgent(e.key)) && waited < LAYER_WAIT_MS; waited += 400) await sleep(400);
    const rows = new Map();
    for (const e of wanted) if (!rows.has(e.key)) rows.set(e.key, await rosterRow(e.key));
    const chattable = e => {
      if (!pl.isLayerAgent(e.key)) return false;
      if (typeof pl.layerIdFor !== 'function' || typeof pl.agents !== 'function') return true;
      const id = pl.layerIdFor(e.key);
      return listed().some(a => a && a.id === id && a.level);
    };
    const sessionOf = e => layerChatKey(e.sessionKey, rows.get(e.key));
    // (listed by the office, not by the layer yet: next load; tries counts this one)
    const pending = entries.filter(e => !pl.isLayerAgent(e.key) && rows.get(e.key)).map(e => e.slot);
    const tries = (Number(mark?.tries) || 0) + 1;
    const done = !pending.length || tries >= 3;
    writeStored(UNIFIED_KEY, { v: 1, at: Date.now(), done, tries, pending: done ? [] : pending });
    if (seeding && !readStored(LAST_USED_KEY) && chattable(seed)) {
      const id = typeof pl.layerIdFor === 'function' ? pl.layerIdFor(seed.key) : null;
      writeStored(LAST_USED_KEY, { officeId: seed.key, agent: Number.isInteger(id) ? id : null, session: sessionOf(seed), at: Date.now() });
    }
    // the windows: shown ones last (the front one on top), put away ones put away again; no room for all (four windows,
    // the copied ones that came back count): the front one, then shown ones, then the latest put away ones
    const max = globalThis.ChatWindows?.MAX || 4;
    const room = Math.max(0, max - (Number(typeof pl.windows === 'function' ? pl.windows() : 0) || 0));
    const rank = e => (e.slot === front && !e.min ? 0 : e.min ? 2 : 1);
    const usable = entries.filter(chattable);
    const keep = new Set(usable.map((e, i) => [e, i]).sort((p, q) => rank(p[0]) - rank(q[0]) || q[1] - p[1]).slice(0, room).map(p => p[0]));
    const away = usable.filter(e => keep.has(e) && e.min);
    const shown = usable.filter(e => keep.has(e) && !e.min).sort((p, q) => (p.slot === front) - (q.slot === front));
    const shownBefore = typeof pl.chatsShown === 'function' && !!pl.chatsShown();
    const opened = [];
    const openOne = async e => { try { if (await pl.open(e.key, { session: sessionOf(e), newWindow: true })) opened.push(e.slot); } catch (_) { /* that agent: not this time */ } };
    for (const e of away) await openOne(e);
    // (put away again only while no copied window that came back was shown: they stay as they were, the moved ones shown)
    if (away.length && !shownBefore && typeof pl.chatsShown === 'function' && pl.chatsShown()) pl.toggleChats();
    for (const e of shown) await openOne(e);
    return { opened, pending: done ? [] : pending, seeded: seed ? seed.key : null };
  }

  async function loadGatewayInfo() {
    try {
      const response = await fetch('/gateway-info', { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json();
      if (data.wsPort) _chatWsPort = data.wsPort;
      GATEWAY_URL = typeof data.gatewayUrl === 'string' ? data.gatewayUrl.trim() : '';
      GATEWAY_TRANSPORT = data.transport === 'direct' ? 'direct' : 'proxy';
      GATEWAY_RPC_URL = typeof data.rpcUrl === 'string' && data.rpcUrl ? data.rpcUrl : '/api/openclaw/rpc';
      GATEWAY_EVENTS_URL = typeof data.eventsUrl === 'string' && data.eventsUrl ? data.eventsUrl : '/api/openclaw/events';
      GATEWAY_TOKEN = typeof data.token === 'string' ? data.token : '';
      if (data.openclawVersion) GATEWAY_CLIENT_VERSION = data.openclawVersion;
      if (data.gatewayProtocol) GATEWAY_PROTOCOL_VERSION = Number(data.gatewayProtocol) || 4;
      layerHasGateway = data.provider === 'layer';
      return data;
    } catch (error) {
      console.warn('[chat] Failed to load Gateway info:', error);
      return null;
    }
  }

  const MAX_INPUT_LINES = 15;
  // Reading window.innerWidth makes a phone browser lay the page out first (the layout viewport depends on it);
  // isPhone() and the single-window check ran 22 forced layouts while the page loaded. The width only changes
  // with a (visual) viewport resize, so it is read once per resize (perf v0.13).
  let chatViewportWidthCache = 0;
  const chatViewportWidth = () => chatViewportWidthCache || (chatViewportWidthCache = window.innerWidth || 0);
  const chatViewportWidthReset = () => { chatViewportWidthCache = 0; };
  window.addEventListener('resize', chatViewportWidthReset, { capture: true, passive: true });
  window.addEventListener('orientationchange', chatViewportWidthReset, { passive: true });
  window.visualViewport?.addEventListener?.('resize', chatViewportWidthReset, { passive: true });

  const CHAT_STACK_GAP = 12;
  const CHAT_RAIL_GUTTER = 72;   // fallback for --vo-right-col (ui-modern.css)
  const CHAT_RAIL_EDGE = 18;     // window buttons centred over the map controls

  /** Desktop: the office keeps a column at its right edge for the map controls (bottom) and the
   *  chat window buttons (stacked on them). Windows (docked, snapped, dragged)
   *  stay left of it, so they never cover those buttons and nothing has to move them.
   *  Phones (<= 900 px) show one window at a time and keep their own placement. */
  function chatRightInset() {
    const sidebarWidth = typeof _getSidebarWidth === 'function' ? _getSidebarWidth() : 0;
    if (window.matchMedia?.('(max-width: 900px)')?.matches) return sidebarWidth;
    const col = parseFloat(getComputedStyle(document.documentElement).getPropertyValue?.('--vo-right-col')) || CHAT_RAIL_GUTTER;
    return sidebarWidth + col;
  }
  const STREAM_RENDER_INTERVAL_MS = 80;
  const MAX_LIVE_TOOL_CARDS = 40;
  const MAX_TOOL_PAYLOAD_CHARS = 6000;
  const ACTIVE_RUN_RECOVERY_MS = 15000;
  const HERMES_APPROVAL_POLL_MS = 1500;
  const HERMES_HISTORY_POLL_MS = 250;
  const CHAT_SELECTION_STORAGE_KEY = 'vo-chat-selection-v1';
  const MOBILE_CHAT_SCROLL_SURFACE_SELECTOR = '.chat-messages, .chat-sessions-list, .chat-input, .task-progress-body';
  const CHAT_BOTTOM_FOLLOW_THRESHOLD = 28;
  const CHAT_BOTTOM_REATTACH_THRESHOLD = 2;
  const CHAT_MANUAL_SCROLL_INTENT_MS = 180;
  const NATIVE_PROVIDER_UI = Object.freeze({
    hermes: {
      label: 'Hermes',
      path: 'hermes',
      sourceProperty: 'hermesEventSource',
      completedKeysProperty: 'hermesCompletedToolKeys',
      progressMarker: 'hermes-progress',
      approval: 'hermes'
    },
    codex: {
      label: 'Codex',
      path: 'codex',
      sourceProperty: 'codexEventSource',
      completedKeysProperty: 'codexCompletedToolKeys',
      progressMarker: 'codex-progress',
      approval: 'codex'
    },
    'claude-code': {
      label: 'Claude Code',
      path: 'claude-code',
      sourceProperty: 'claudeCodeEventSource',
      completedKeysProperty: 'claudeCodeCompletedToolKeys',
      progressMarker: 'claude-code-progress',
      approval: ''
    }
  });
  const secondarySlotButtons = Array.from(document.querySelectorAll('[data-chat-slot-toggle]'));
  let activeSecondarySlot = null;
  const secondaryPanelPlaceholders = {
    1: document.getElementById('chat-secondary-1'),
    2: document.getElementById('chat-secondary-2'),
    3: document.getElementById('chat-secondary-3')
  };
  let secondaryChatPanels = {};
  // Chat windows (chat-windows.js): set up once the four window engines exist.
  let windowManager = null;
  let windowRailPainter = null;
  /** The window buttons repaint on the next frame (once chat.js has set them up). */
  function scheduleWindowRailPaint() {
    if (windowManager && windowRailPainter) windowRailPainter();
  }

  // Icon buttons use the office's pixel sprite (index.html <symbol id="i-...">).
  function setChatIcon(button, name) {
    if (!button) return;
    let svg = button.querySelector('svg.chat-ic');
    if (!svg) {
      button.textContent = '';
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'vo-icon chat-ic');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'use'));
      button.appendChild(svg);
    }
    const use = svg.firstChild;
    use.setAttribute('href', '#i-' + name);
    svg.dataset.icon = name;
    button.classList.add('chat-icon-btn');
  }


  function usesMobileChatLayout() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function installMobileChatTouchContainment(root) {
    let gesture = null;

    root.addEventListener('touchstart', (event) => {
      if (!usesMobileChatLayout() || event.touches.length !== 1) {
        gesture = null;
        return;
      }
      const candidate = event.target.closest?.(MOBILE_CHAT_SCROLL_SURFACE_SELECTOR);
      gesture = {
        surface: candidate && root.contains(candidate) ? candidate : null,
        y: event.touches[0].clientY
      };
    }, { passive: true });

    root.addEventListener('touchmove', (event) => {
      if (!gesture || !usesMobileChatLayout() || event.touches.length !== 1) return;
      const nextY = event.touches[0].clientY;
      const fingerDelta = nextY - gesture.y;
      gesture.y = nextY;

      const surface = gesture.surface;
      if (!surface) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        return;
      }

      const maxScroll = Math.max(0, surface.scrollHeight - surface.clientHeight);
      const atTop = surface.scrollTop <= 0;
      const atBottom = surface.scrollTop >= maxScroll - 1;
      const wouldLeaveSurface = maxScroll <= 0 || (atTop && fingerDelta > 0) || (atBottom && fingerDelta < 0);
      if (wouldLeaveSurface && event.cancelable) event.preventDefault();
      event.stopPropagation();
    }, { passive: false });

    const endGesture = () => { gesture = null; };
    root.addEventListener('touchend', endGesture, { passive: true });
    root.addEventListener('touchcancel', endGesture, { passive: true });
  }

  function readSavedChatSelections() {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_SELECTION_STORAGE_KEY) || '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch (e) {
      return {};
    }
  }

  function getSavedChatSelection(slotId) {
    const saved = readSavedChatSelections()[slotId];
    if (!saved || typeof saved !== 'object') return null;
    if (!saved.selectedAgentKey || !saved.sessionKey) return null;
    return saved;
  }

  function saveChatSelection(slotId, selection) {
    if (!slotId || !selection?.selectedAgentKey || !selection?.sessionKey) return;
    try {
      const saved = readSavedChatSelections();
      saved[slotId] = {
        selectedAgentKey: selection.selectedAgentKey,
        sessionKey: selection.sessionKey
      };
      localStorage.setItem(CHAT_SELECTION_STORAGE_KEY, JSON.stringify(saved));
    } catch (e) {
      console.warn('[chat] Failed to save chat selection:', e);
    }
  }

  function optionSelectionAliases(opt) {
    try {
      const aliases = JSON.parse(opt?.dataset?.selectionAliases || '[]');
      return Array.isArray(aliases) ? aliases.map(String) : [];
    } catch (_) {
      return [];
    }
  }

  function optionMatchesSelectedAgent(opt, selectedAgentKey) {
    const selected = String(selectedAgentKey || '');
    return !!opt && (opt.value === selected || optionSelectionAliases(opt).includes(selected));
  }

  function canonicalSessionKeyForOption(opt, sessionKey, selectedAgentKey) {
    const base = String(opt?.dataset?.sessionKey || '');
    const current = String(sessionKey || '');
    if (!base) return current;
    if (current === base || current.startsWith(base + ':')) return current;

    // A mounted local profile and its authenticated API connection can be the
    // same Hermes identity under different labels. Preserve the native session
    // id while migrating a saved local alias to the canonical API profile.
    if (optionMatchesSelectedAgent(opt, selectedAgentKey)) {
      const baseParts = base.split(':');
      const currentParts = current.split(':');
      // OpenClaw roster options advertise the agent's main session, while an
      // explicit window may own any validated child session for that same
      // agent. Preserve it across roster refreshes without ever carrying a
      // session key across agent ids.
      if (
        baseParts[0] === 'agent' && currentParts[0] === 'agent'
        && baseParts.length >= 3 && currentParts.length >= 3
        && baseParts[1] === currentParts[1]
      ) return current;
      if (baseParts.length === 2 && currentParts.length >= 3 && baseParts[0] === currentParts[0]) {
        return base + ':' + currentParts.slice(2).join(':');
      }
    }
    return base;
  }

  function formatSessionTimestamp(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null') return '';
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) return trimmed.length > 28 ? trimmed.slice(0, 28) : trimmed;
      return parsed.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function providerHistorySessionIdFromKey(sessionKey, providerKind) {
    const kind = String(providerKind || '').trim();
    const value = String(sessionKey || '');
    if (!kind || !value.startsWith(kind + ':')) return '';
    const parts = value.split(':');
    if (parts.length < 3) return '';
    return parts.slice(2).join(':');
  }

  function providerSessionIdFromKey(sessionKey, providerKind) {
    const sessionId = providerHistorySessionIdFromKey(sessionKey, providerKind);
    return sessionId.startsWith('@new:') ? '' : sessionId;
  }

  function isPendingProviderSessionKey(sessionKey, providerKind) {
    const kind = String(providerKind || '').trim();
    if (!kind || !String(sessionKey || '').startsWith(kind + ':')) return false;
    return String(sessionKey || '').split(':').slice(2).join(':').startsWith('@new:');
  }

  const progressStore = new globalThis.VirtualWorldSessionProgress.ProgressStore();

  // v0.8 limits. Files are read into memory as data URLs, so refuse very large
  // files up front instead of failing later with "Failed to fetch".
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
  const MAX_NATIVE_OPENCLAW_ATTACHMENT_BYTES = 450 * 1024;
  const MAX_OPENCLAW_RPC_ATTACHMENT_CHARS = 850000;
  const MAX_RENDERED_HISTORY_MESSAGES = 200;
  const HISTORY_OLDER_PAGE = 200;
  const MAX_TERMINAL_RUNS_KEPT = 3;
  const MAX_SEEN_COMMENTARY_KEYS = 400;
  const COMMENTARY_SYNC_MIN_MS = 1500;
  const RUN_STREAM_RETRY_MS = 20000;

  /** sessionStorage, or null where the browser refuses it (private modes, sandboxed frames). */
  function safeLocalStorage() {
    try { return globalThis.localStorage || null; } catch (_) { return null; }
  }

  /** A picture route of the side panel (browser frame, screen thumbnail) as an object URL; 204 = none yet. */
  async function fetchSideImage(path, params) {
    const res = await fetch(path + '?' + new URLSearchParams(params).toString(), { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 204) return { status: 204 };
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { status: res.status, message: (data && (data.message || data.error)) || '' };
    }
    const blob = await res.blob();
    return { status: res.status, url: URL.createObjectURL(blob) };
  }

  function safeSessionStorage() {
    try { return globalThis.sessionStorage || null; } catch (_) { return null; }
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1) + ' MB';
    if (value >= 1024) return Math.round(value / 1024) + ' KB';
    return value + ' B';
  }

  // Turn a raw provider/gateway error into one plain sentence plus the raw
  // detail. The raw text is still shown (small) so nothing is hidden.
  function friendlyRunError(raw) {
    const detail = String(raw?.message || raw || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const text = detail.toLowerCase();
    let title = 'The agent could not finish this reply.';
    if (!text) title = 'The agent stopped without a reply.';
    else if (/model[^.]{0,40}not (?:found|available|supported)|unknown model|no such model|model_not_found/.test(text)) title = "The model this agent is set to use was not found. Check the agent's model in Settings.";
    else if (/not connected|econnrefused|gateway proxy unavailable|gateway unavailable|gateway proxy http 50[234]|socket hang up|network ?error|failed to fetch/.test(text)) title = 'Could not reach the agent service. Check that it is running, then try again.';
    else if (/stream disconnected|connection (?:lost|closed)|disconnected/.test(text)) title = 'The live connection to the agent was lost.';
    else if (/missing scope|forbidden|\b403\b|unauthori[sz]ed|\b401\b|permission denied|not allowed/.test(text)) title = 'The request was refused (permission). Check the connection settings for this agent.';
    else if (/rate.?limit|\b429\b|too many requests|quota|insufficient[_ ]credit|billing/.test(text)) title = 'The model provider is limiting requests or is out of credit. Wait a moment, then try again.';
    else if (/timed? ?out|timeout|deadline/.test(text)) title = 'The agent took too long to answer.';
    else if (/too large|payload|\b413\b|body (?:is )?too|exceeds/.test(text)) title = 'The message or attachment is too large to send.';
    else if (/context (?:length|window)|maximum context|too many tokens/.test(text)) title = 'This conversation is too long for the model. Start a new session and try again.';
    else if (/api key|invalid key|authentication/.test(text)) title = 'The model provider rejected the API key. Check the key in Settings.';
    return { title, detail };
  }

  // CH-31: one shared /agents-list request for all chat windows, retried
  // with backoff and jitter instead of four parallel calls that never retry.
  const agentsListState = { promise: null, at: 0 };
  function fetchAgentsListShared({ force = false } = {}) {
    const now = Date.now();
    if (!force && agentsListState.promise && now - agentsListState.at < 3000) return agentsListState.promise;
    agentsListState.at = now;
    const attemptFetch = async () => {
      let delay = 700;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const res = await fetch('/agents-list', { cache: 'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.json();
          if (!Array.isArray(data?.agents)) throw new Error('The agent list was empty');
          return data;
        } catch (error) {
          if (attempt >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, delay + Math.random() * delay * 0.5));
          delay *= 2;
        }
      }
    };
    const promise = attemptFetch();
    agentsListState.promise = promise;
    promise.catch(() => { if (agentsListState.promise === promise) agentsListState.promise = null; });
    return promise;
  }

  // C3: use the in-app dialog when the design layer provides it.
  async function confirmAction(options) {
    const ui = window.VOUI;
    if (ui && typeof ui.confirm === 'function') {
      try { return !!(await ui.confirm(options)); } catch (_) {}
    }
    return window.confirm([options.title, options.body].filter(Boolean).join('\n\n'));
  }

  async function promptAction(options) {
    const ui = window.VOUI;
    if (ui && typeof ui.prompt === 'function') {
      try { return await ui.prompt(options); } catch (_) {}
    }
    const value = window.prompt(options.label || options.title || '', options.value || '');
    return value === null ? null : String(value);
  }

  // CH-21: the server wraps what the user typed in a routing note for the
  // agent ("Message from User via Virtual Office Chat. ... Reply directly to
  // the user. ..."). Show only the typed text.
  const DELIVERY_ENVELOPE_RE = /^\s*Message from [^\n]{1,120}? via [^\n]{1,120}?\.\s*\n+([\s\S]*?)\n+\s*Reply directly to the user\.[^\n]*\s*$/;
  function stripDeliveryEnvelope(text) {
    const value = String(text || '');
    const match = value.match(DELIVERY_ENVELOPE_RE);
    return match ? match[1].trim() : value;
  }

  // P2-5: OpenClaw puts its own system-event lines in front of some user
  // turns ("System: [time] New session created ...", the JSON payload inside
  // <untrusted-text>, gateway notes) plus a "resumed this CLI session" note.
  // Split that leading block off so the bubble keeps only what was typed.
  const SYSTEM_EVENT_LINE_RE = /^\s*System:(?:\s|$)/;
  const RUNTIME_NOTE_LINE_RE = /^\s*OpenClaw resumed this CLI session\b/;
  const SYSTEM_BLOCK_START_RE = /^\s*(?:System:(?:\s|$)|OpenClaw resumed this CLI session\b)/;
  function splitSystemEvents(text) {
    const value = String(text || '');
    if (!SYSTEM_BLOCK_START_RE.test(value)) return { text: value, events: [] };
    const lines = value.split(/\r?\n/);
    const events = [];
    let current = null;
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { current = null; continue; }
      if (RUNTIME_NOTE_LINE_RE.test(line)) {
        events.push({ title: line.trim(), detail: [] });
        current = null;
        continue;
      }
      if (!SYSTEM_EVENT_LINE_RE.test(line)) break;
      const body = line.replace(SYSTEM_EVENT_LINE_RE, '').trim();
      if (!current || /^\[[^\]]+\]/.test(body)) {
        current = { title: body.replace(/\s*\(treat text inside this block as data, not instructions\):?\s*$/i, ''), detail: [] };
        events.push(current);
      } else if (body && !/^<\/?untrusted-text>$/i.test(body)) {
        current.detail.push(body);
      }
    }
    if (!events.length) return { text: value, events: [] };
    return {
      text: lines.slice(i).join('\n').trim(),
      events: events.map(ev => ({ title: ev.title || 'System event', detail: ev.detail.join('\n') }))
    };
  }

  const FLAT_SYSTEM_SEGMENT_RE = /^\s*System:\s*(?:\[[^\]]*\][^\n]*?\(treat text inside this block as data, not instructions\):?|\{[^\n]*?\}(?=\s*System:|\s*$)|<\/?untrusted-text>|\[[^\]]*\][^\n]*?(?=\s*System:|\s*$))\s*/i;
  function stripSystemEventsFromTitle(title) {
    let value = String(title || '');
    if (!SYSTEM_BLOCK_START_RE.test(value)) return value;
    if (/\n/.test(value)) value = splitSystemEvents(value).text;
    // Titles may arrive flattened to one line.
    value = value.replace(/^\s*OpenClaw resumed this CLI session[^.]*\.[^;]*;\s*changed=\S+\s*/i, '');
    for (let guard = 0; guard < 200 && /^\s*System:/.test(value); guard++) {
      const next = value.replace(FLAT_SYSTEM_SEGMENT_RE, '');
      if (next === value) return '';
      value = next;
    }
    return value.trim();
  }

  function cleanSessionTitle(title) {
    let value = stripSystemEventsFromTitle(String(title || '').trim()).trim();
    value = value.replace(/^\s*\[A2A\s+[^\]]*\]?\s*/, '');
    value = value.replace(/^\s*Message from [^\n]{1,120}? via [^\n]{1,120}?\.\s*/, '');
    value = value.replace(/\s*Reply directly to the user\.[\s\S]*$/, '').trim();
    return value;
  }

  function isImeEnter(event) {
    return !!(event && (event.isComposing || event.keyCode === 229));
  }

  // Unread replies per window, published as one total (C4).
  const unreadState = { windows: [], published: -1, timer: 0 };
  function totalUnreadCount() {
    return unreadState.windows.reduce((sum, w) => sum + (Number(w.unreadCount) || 0), 0);
  }
  function publishUnreadCount() {
    unreadState.timer = 0;
    const count = totalUnreadCount();
    for (const w of unreadState.windows) {
      if (!w.slot) continue;
      const button = secondarySlotButtons.find(btn => String(btn.dataset.chatSlotToggle) === String(w.slot));
      if (!button) continue;
      if (w.unreadCount) button.dataset.unread = w.unreadCount > 9 ? '9+' : String(w.unreadCount);
      else delete button.dataset.unread;
    }
    const toggle = document.getElementById('chat-toggle');
    if (toggle) {
      if (count) toggle.dataset.unread = count > 9 ? '9+' : String(count);
      else delete toggle.dataset.unread;
    }
    scheduleWindowRailPaint();
    if (router === true) return;   // (unify: vo-mount.mjs publishes every window's unread answers, this file's included)
    if (count === unreadState.published) return;
    unreadState.published = count;
    try { window.dispatchEvent(new CustomEvent('vo:chat-unread', { detail: { count } })); } catch (_) {}
  }
  function notifyUnreadChanged() {
    if (unreadState.timer) return;
    unreadState.timer = setTimeout(publishUnreadCount, 0);
  }

  class ChatWindow {
    constructor(root, options = {}) {
      this.root = root;
      this.isPrimary = !!options.isPrimary;
      this.slot = options.slot || null;
      this.slotId = this.isPrimary ? 'primary' : `secondary-${this.slot}`;
      this.root.dataset.chatSlot = this.slotId;
      const savedSelection = getSavedChatSelection(this.slotId);
      this.agentList = [];
      this.selectedAgentKey = options.selectedAgentKey || savedSelection?.selectedAgentKey || 'main';
      this.sessionKey = options.sessionKey || savedSelection?.sessionKey || 'agent:main:main';
      this.hasExplicitAgentSelection = !!savedSelection;
      this.agentListLoaded = false;
      this.restoreSelection = null;
      this.currentRunId = null;
      this.turnEvents = new ChatEvents.TurnEventReducer();
      // Universal chat path (design 4.1): the agent's capability manifest and,
      // for `hermes serve` agents, one event stream per chat.
      this.can = null;
      this.canAgent = '';
      this.canAt = 0;
      this.canSeq = 0;
      this.capsView = null;
      this.chatStream = null;
      this.universal = globalThis.ChatUniversal ? globalThis.ChatUniversal.createTranslator({}) : null;
      this.universalRuns = new Set();
      this.steeredRuns = new Set();
      this.serveRunWaiters = new Map();
      this.secretDialogs = new Map();
      this.planCardEl = null;
      this.openClawEventQueue = Promise.resolve();
      this.seenOpenClawCommentary = new Set();
      this.streamingMsg = null;
      this.liveToolCards = new Map();
      this.pendingStreamContent = '';
      this.streamRenderTimer = null;
      this.scrollFrame = null;
      this.scrollSettleFrame = null;
      this.scrollSettleTimer = null;
      this.followLatest = true;
      this.scrollTrackingSuspended = false;
      this.manualScrollIntentUntil = 0;
      this.manualScrollBottomTarget = 0;
      this.manualScrollDirection = 0;
      this.lastMessagesScrollTop = 0;
      this.lastTouchScrollY = null;
      this.scrollbarPointerDown = false;
      this.lastLiveEventAt = 0;
      this.recoveryTimer = null;
      this.hermesProgressTimers = [];
      this.hermesHistoryPollTimer = null;
      this.hermesEventSource = null;
      this.hermesCompletedToolKeys = new Set();
      this.liveThinkingEl = null;
      this.liveThinkingPre = null;
      this.liveThinkingRunId = '';
      this.codexHistoryPollTimer = null;
      this.codexEventSource = null;
      this.codexCompletedToolKeys = new Set();
      this.claudeCodeHistoryPollTimer = null;
      this.claudeCodeEventSource = null;
      this.claudeCodeCompletedToolKeys = new Set();
      this.providerEventSource = null;
      this.providerHistoryPollTimer = null;
      this.providerHistorySignature = '';
      this.hermesApprovalPollTimer = null;
      this.hermesApprovalLastId = '';
      this.codexApprovalPollTimer = null;
      this.codexApprovalLastId = '';
      this.sessionModel = '—';
      this.contextWindow = 0;
      this.contextUsed = 0;
      this.pendingAttachments = [];
      this.isRecording = false;
      this.mediaRecorder = null;
      this.audioChunks = [];
      this.sessionsRefreshSeq = 0;
      this.sessionsRefreshTimer = null;
      this.sessionsPanelOpen = false;
      this.currentSessions = [];
      this.historyRefreshSeq = 0;
      this.historyDirty = true;
      this.historyLoad = null;
      this.historyState = 'idle';
      this.historyHiddenItems = [];
      this.liveTerminalSeq = 0;
      this.runState = null;
      this.lastRunError = null;
      this.linkLostRun = null;
      this.lastSend = null;
      this.sendInFlight = false;
      this.unreadCount = 0;
      this.providerHealth = '';
      this.commentarySyncTimer = null;
      this.commentarySyncAt = 0;
      this.commentarySyncInFlight = null;
      this.pollGuards = new Set();

      this.messages = root.querySelector('.chat-messages');
      this.scrollLatestBtn = root.querySelector('.chat-scroll-latest');
      this.status = root.querySelector('.chat-status');
      this.agentSelect = root.querySelector('.chat-agent-select');
      this.agentPick = root.querySelector('.chat-agent-pick');
      this.newWindowBtn = root.querySelector('.chat-new-window');
      this.putAwayBtn = root.querySelector('.chat-put-away');
      this.modelName =root.querySelector('.chat-model-name, #chat-model-name');
      this.contextInfo = root.querySelector('.chat-context-info, #chat-context-info');
      // Model + effort pickers (design 4.2), shown only when the manifest allows them.
      this.pickers = globalThis.ChatPickers ? globalThis.ChatPickers.controller({
        doc: document,
        bar: root.querySelector('.chat-model-bar'),
        load: () => this.chatFetch('/api/agent-chat/models', { agent: this.chatAgentId(), session: this.agentChatSession() })
          .then(({ res, data }) => (res.ok ? data : { ok: false, message: data.message || data.error || ('HTTP ' + res.status), fix: data.fix || '' })),
        save: (patch) => this.chatFetch('/api/agent-chat/prefs', null, { agent: this.chatAgentId(), session: this.agentChatSession(), ...patch })
          .then(({ res, data }) => (res.ok && data.ok !== false ? { ok: true, prefs: data.prefs || null }
            : { ok: false, message: data.message || data.error || ('HTTP ' + res.status), fix: data.fix || '' })),
        isPhone: () => (chatViewportWidth() || 1600) <= 600,
        toast: (text, kind) => { if (kind === 'error') globalThis.VOUI?.toast?.(text, { kind }); },
        onChange: (prefs) => { if (prefs.model) { this.sessionModel = prefs.model; this.updateModelBar(); } }
      }) : null;
      // Permissions picker (v0.13.1): Codex and Claude Code agents, which the office launches itself.
      this.permissions = globalThis.ChatPermissions ? globalThis.ChatPermissions.controller({
        doc: document,
        bar: root.querySelector('.chat-model-bar'),
        load: (kind, agent) => this.chatFetch('/api/agent-permissions', { kind, agent }).then(({ data }) => data),
        save: (kind, agent, mode) => this.chatFetch('/api/agent-permissions', null, { kind, agent, mode }).then(({ data }) => data),
        confirm: (text) => confirmAction({ title: 'Give this agent full access?', body: text, okLabel: 'Give full access', danger: true }),
        isPhone: () => (chatViewportWidth() || 1600) <= 600,
        toast: (text, kind) => globalThis.VOUI?.toast?.(text, kind === 'error' ? { kind } : undefined)
      }) : null;
      this.queue = globalThis.ChatQueue ? globalThis.ChatQueue.create({ storage: safeSessionStorage() }) : null;
      this.queueEl = null;
      this.input = root.querySelector('.chat-input');
      this.progressPanel = new globalThis.VirtualWorldSessionProgress.ProgressPanel(root, progressStore);
      this.taskReferences = new globalThis.OfficeChatReferences.ReferencesPanel(root);
      // Side panel (Tasks, Browser, Screen, Files) + running-tasks chip, from the manifest (design 4.2, D1).
      this.sidePanel = globalThis.ChatSidePanel ? globalThis.ChatSidePanel.create({
        doc: document,
        root,
        api: {
          get: (path, params) => this.chatFetch(path, params).then(({ res, data }) => ({ ok: res.ok && data.ok !== false, status: res.status, data })),
          post: (path, body) => this.chatFetch(path, null, body).then(({ res, data }) => ({ ok: res.ok && data.ok !== false, status: res.status, data })),
          image: (path, params) => fetchSideImage(path, params),
          release: (url) => { try { URL.revokeObjectURL(url); } catch (_) {} }
        },
        storage: safeLocalStorage(),
        isPhone: () => (chatViewportWidth() || 1600) <= 600,
        isVisible: () => this.isVisibleForPolling() && !document.hidden,
        confirm: (text) => confirmAction({ title: text, okLabel: 'Yes' }),
        prompt: (label, value) => promptAction({ title: label, label, value }),
        toast: (text, kind) => globalThis.VOUI?.toast?.(text, kind === 'error' ? { kind } : undefined)
      }) : null;
      this.sendBtn = root.querySelector('.chat-send-btn');
      this.stopBtn = root.querySelector('.chat-stop-btn');
      this.attachBtn = root.querySelector('.chat-attach-btn');
      this.fileInput = root.querySelector('.chat-file-input');
      this.attachmentsPreview = root.querySelector('.chat-attachments-preview');
      this.micBtn = root.querySelector('.chat-mic-btn');
      this.newSessionBtn = root.querySelector('.chat-new-session');
      this.closeBtn = root.querySelector('.chat-close, .chat-secondary-close');
      this.sessionsToggleBtn = root.querySelector('.chat-sessions-toggle');
      this.sessionsPanel = root.querySelector('.chat-sessions-panel');
      this.sessionsListEl = root.querySelector('.chat-sessions-list');
      this.sessionsNewBtn = root.querySelector('.chat-sessions-new');
      // Keep the existing header control for history; the shared rail is References / Tasks.
      root.querySelectorAll('.chat-history-rail').forEach(el => el.remove());
      this.historyRail = this.sessionsToggleBtn;
      this.historyRail?.setAttribute('aria-label', 'Open session history');
      this.historyRail?.setAttribute('aria-expanded', 'false');
      if (this.sessionsPanel) {
        this.sessionsPanel.id = `office-session-history-${this.slotId}`;
        this.historyRail?.setAttribute('aria-controls', this.sessionsPanel.id);
        this.sessionsPanel.inert = true;
      }
      root.addEventListener('vw:chat-drawer-open', event => {
        if (event.detail?.drawer !== 'history') this.toggleSessionsPanel(false);
      });
      // Phones show the sessions drawer as a full-screen sheet: Back returns to the chat (design 4.5).
      const sessionsHead = this.sessionsPanel?.querySelector('.chat-sessions-head');
      if (sessionsHead) {
        let sheetBack = sessionsHead.querySelector('.hp-sheet-back');
        if (!sheetBack) {
          sheetBack = document.createElement('button');
          sheetBack.type = 'button';
          sheetBack.className = 'hp-sheet-back';
          sheetBack.textContent = '‹ Back';
          sheetBack.title = 'Back to the chat';
          sheetBack.setAttribute('aria-label', 'Back to the chat');
          sessionsHead.insertBefore(sheetBack, sessionsHead.firstChild);
        }
        sheetBack.addEventListener('click', () => {
          this.toggleSessionsPanel(false);
          this.historyRail?.focus({ preventScroll: true });
        });
      }
      this.sessionsPanel?.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); this.toggleSessionsPanel(false);
        this.historyRail?.focus({ preventScroll: true });
      });
      installMobileChatTouchContainment(this.root);

      this.messages.addEventListener('click', (e) => {
        const actionButton = e.target.closest?.('[data-chat-action]');
        if (actionButton && this.messages.contains(actionButton)) {
          e.preventDefault();
          this.handleMessageAction(actionButton);
          return;
        }
        if (e.target.classList.contains('chat-image-clickable') || e.target.classList.contains('chat-image-thumb')) {
          openImageLightbox(e.target.src, e.target.dataset.mediaName || e.target.alt || '');
        }
      });
      // Keyboard scrolling (PageUp, Home, arrows) is a real user intent too,
      // not only wheel and touch (CH-22).
      this.messages.addEventListener('keydown', (event) => {
        if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) this.noteManualScrollIntent(-1);
        else if (['PageDown', 'ArrowDown', 'End'].includes(event.key)) this.noteManualScrollIntent(1);
      });
      if (!this.messages.hasAttribute('tabindex')) this.messages.tabIndex = 0;
      this.messages.addEventListener('scroll', () => this.handleMessagesScroll(), { passive: true });
      this.messages.addEventListener('wheel', (event) => {
        this.noteManualScrollIntent(Math.sign(event.deltaY));
      }, { passive: true });
      this.messages.addEventListener('touchstart', (event) => {
        this.lastTouchScrollY = event.touches?.[0]?.clientY ?? null;
      }, { passive: true });
      this.messages.addEventListener('touchmove', (event) => {
        const nextY = event.touches?.[0]?.clientY ?? this.lastTouchScrollY;
        const direction = this.lastTouchScrollY == null || nextY == null
          ? 0
          : Math.sign(this.lastTouchScrollY - nextY);
        this.lastTouchScrollY = nextY;
        this.noteManualScrollIntent(direction);
      }, { passive: true });
      this.messages.addEventListener('touchend', () => { this.lastTouchScrollY = null; }, { passive: true });
      this.messages.addEventListener('touchcancel', () => { this.lastTouchScrollY = null; }, { passive: true });
      this.messages.addEventListener('pointerdown', (event) => {
        const rect = this.messages.getBoundingClientRect();
        const scrollbarWidth = Math.max(0, this.messages.offsetWidth - this.messages.clientWidth);
        this.scrollbarPointerDown = scrollbarWidth > 0 && event.clientX >= rect.right - scrollbarWidth - 2;
        if (this.scrollbarPointerDown) this.noteManualScrollIntent();
      }, { passive: true });
      window.addEventListener('pointermove', () => {
        if (this.scrollbarPointerDown) this.noteManualScrollIntent();
      }, { passive: true });
      const releaseScrollbarPointer = () => { this.scrollbarPointerDown = false; };
      window.addEventListener('pointerup', releaseScrollbarPointer, { passive: true });
      window.addEventListener('pointercancel', releaseScrollbarPointer, { passive: true });
      this.scrollLatestBtn?.addEventListener('click', () => this.resumeLatest());

      this.agentSelect?.addEventListener('change', () => {
        const opt = this.agentSelect.selectedOptions[0];
        if (opt && isLayerOption(opt)) {
          // v0.12: an OpenClaw/Hermes agent of the layer opens the copied window; this one keeps its agent (or closes)
          this.syncAgentSelect();
          if (!this.leaveToLayer()) this.syncAgentPickFace();
          handToLayer(opt.value);
          return;
        }
        this.syncAgentPickFace();
        if (!opt) return;
        const previousAgentKey = this.selectedAgentKey;
        this.applySelection(opt, { markExplicit: true, systemPrefix: 'Switched to' });
        keepChatInOneWindow(this, { previousAgentKey });
      });

      this.sendBtn?.addEventListener('click', () => this.submitComposer());
      this.stopBtn?.addEventListener('click', () => this.sendStop());
      this.input?.addEventListener('keydown', (e) => {
        // Never send while an IME is composing (CH-24). On touch-first
        // devices Enter inserts a new line; the Send button sends.
        if (e.key === 'Enter' && !e.shiftKey && !isImeEnter(e) && !this.enterInsertsNewline()) {
          e.preventDefault();
          // While the agent works: Enter adds to the turn, Ctrl/Cmd+Enter waits for it (design 4.3).
          this.submitComposer({ ctrl: !!(e.ctrlKey || e.metaKey) });
        } else if (e.key === 'Escape' && !isImeEnter(e) && this.isRunActive() && this.stopBtn && !this.stopBtn.hidden) {
          e.preventDefault();
          this.sendStop();
        }
      });
      this.input?.addEventListener('input', () => this.autoResizeInput());
      this.input?.addEventListener('paste', (e) => this.handlePaste(e));
      if (this.sendBtn) {
        this.sendBtn.type = 'button';
        if (!this.sendBtn.getAttribute('aria-label')) this.sendBtn.setAttribute('aria-label', 'Send message');
        if (!this.sendBtn.title) this.sendBtn.title = 'Send message';
      }
      if (this.stopBtn) {
        this.stopBtn.type = 'button';
        this.stopBtn.setAttribute('aria-label', 'Stop the current reply');
      }
      if (this.newSessionBtn) {
        // A pencil ("write a new one"): the "+" beside the agent's name opens
        // another chat window; the old refresh arrow read as "reload" (CH-31).
        setChatIcon(this.newSessionBtn, 'edit');
        this.newSessionBtn.title = 'Start a new session';
        this.newSessionBtn.setAttribute('aria-label', 'Start a new session');
      }
      this.installDropTarget();

      this.attachBtn?.addEventListener('click', () => this.fileInput?.click());
      this.fileInput?.addEventListener('change', () => this.handleFiles());
      this.micBtn?.addEventListener('click', () => this.toggleRecording());
      this.newSessionBtn?.addEventListener('click', () => this.newSession());
      this.newWindowBtn?.addEventListener('click', () => openAnotherChatWindow(this));
      this.putAwayBtn?.addEventListener('click', () => {
        if (windowManager) windowManager.putAway(this.slotId);
        else this.closeBtn?.click();
      });
      this.sessionsToggleBtn?.addEventListener('click', () => this.toggleSessionsPanel());
      this.sessionsNewBtn?.addEventListener('click', () => this.createSessionFromPanel());
      this.sessionsListEl?.addEventListener('click', (e) => {
        const item = e.target.closest('.chat-session-item');
        if (!item || !this.sessionsListEl.contains(item)) return;
        const session = this.currentSessions.find((candidate) => String(candidate.id) === item.dataset.sessionId);
        if (!session) return;
        if (e.target.closest('.chat-session-delete')) {
          e.stopPropagation();
          this.deleteSessionFromPanel(session);
          return;
        }
        if (e.target.closest('.chat-session-rename')) {
          e.stopPropagation();
          this.renameSessionFromPanel(session);
          return;
        }
        this.switchToSession(session);
      });
      this.closeBtn?.addEventListener('click', () => {
        if (windowManager) {
          windowManager.close(this.slotId);
          return;
        }
        if (this.isPrimary) {
          const chatPanel = document.getElementById('chat-panel');
          const chatBtn = document.getElementById('chat-toggle');
          // Clear snap/floating state and inline styles before closing
          chatPanel.classList.remove('open', 'floating', 'snap-left', 'snap-right', 'dragging', 'move-active');
          chatPanel.style.left = '';
          chatPanel.style.top = '';
          chatPanel.style.right = '';
          chatPanel.style.bottom = '';
          chatPanel.style.width = '';
          chatPanel.style.height = '';
          chatPanel.style.transform = '';
          chatBtn.style.display = 'flex';
          chatBtn.classList.remove('active');
          if (exteriorTabs) exteriorTabs.classList.remove('visible');
          closeAllSecondaryPanels();
          this.suspendWhenHidden();
          _chatCancelDrag();
          releaseChatWindow();
        } else if (this.slot) {
          _secExitMoveMode(this.slot);
          setSecondaryPanelOpen(this.slot, false);
        }
      });

      this.root.addEventListener('mousedown', () => {
        if (!this.isPrimary && this.slot) setActiveSecondarySlot(this.slot);
        windowManager?.touch(this.slotId);
      });
      this.root.addEventListener('focusin', () => {
        if (!this.isPrimary && this.slot) setActiveSecondarySlot(this.slot);
        windowManager?.touch(this.slotId);
      });
    }

    markHistoryDirty() {
      this.historyDirty = true;
    }

    suspendWhenHidden() {
      // A closed window must never keep the microphone open (CH-29).
      if (this.isRecording) this.stopRecording({ discard: true });
      // Settle any send that is waiting on a live stream and remember the run
      // so reopening the window can reattach to it (CH-16).
      this.detachActiveRun({ remember: true });
      // A universal chat re-reads /state when the window opens again.
      this.closeChatStream();
      this.releaseServeWaiters();
      if (this.commentarySyncTimer) { clearTimeout(this.commentarySyncTimer); this.commentarySyncTimer = null; }
      const keepRunState = this.runState && ['sending', 'running'].includes(this.runState.state) && !this.isProviderAgentSelected();
      if (!keepRunState) this.runState = null;
      this.lastRunError = null;
      this.historyHiddenItems = [];
      this.taskReferences?.clear();
      this.progressPanel?.select(null);
      this.progressPanel?.setOpen(false);
      this.historyDirty = true;
      this.historyRefreshSeq += 1;
      this.toggleSessionsPanel(false);
      if (this.streamRenderTimer) { clearTimeout(this.streamRenderTimer); this.streamRenderTimer = null; }
      this.cancelPendingScrollBottom();
      this.followLatest = true;
      this.clearManualScrollIntent();
      this.stopRecoveryWatchdog();
      this.stopHermesProgressTimers();
      this.stopHermesHistoryPolling();
      this.stopCodexHistoryPolling();
      this.stopClaudeCodeHistoryPolling();
      this.stopProviderHistoryPolling();
      this.stopHermesApprovalPolling();
      this.stopCodexApprovalPolling();
      this.closeHermesEventSource();
      this.closeCodexEventSource();
      this.closeClaudeCodeEventSource();
      this.closeProviderEventSource();
      this.streamingMsg = null;
      this.pendingStreamContent = '';
      this.liveToolCards.clear();
      this.currentRunId = null;
      this.turnEvents.reset();
      this.openClawEventQueue = Promise.resolve();
      this.seenOpenClawCommentary.clear();
      this.liveThinkingEl = null;
      this.liveThinkingPre = null;
      this.liveThinkingRunId = '';
      this.removeTypingIndicator();
      this.messages?.replaceChildren();
      this.lastMessagesScrollTop = 0;
      this.updateScrollLatestButton();
      this.sessionsListEl?.replaceChildren();
      this.currentSessions = [];
      for (const [runId, owner] of runOwners.entries()) {
        if (owner?.slotId === this.slotId) runOwners.delete(runId);
      }
    }

    resumeWhenVisible() {
      if (!this.isVisibleForPolling()) return;
      this.clearUnread();
      if (connected || this.isProviderAgentSelected()) {
        const detached = this.detachedRun;
        this.detachedRun = null;
        const historyDone = this.loadHistory();
        this.fetchSessionInfo();
        if (detached && detached.fence === this.selectionFence() && detached.sessionKey === this.sessionKey) {
          Promise.resolve(historyDone).then(() => this.reattachRun(detached)).catch(() => {});
        }
      }
      if (this.runState && ['sending', 'running'].includes(this.runState.state) && !this.isProviderAgentSelected()) this.ensureRecoveryWatchdog();
      this.updateComposerControls();
    }

    // ── v0.8 run lifecycle: one state line, error bubbles, Retry ─────────
    enterInsertsNewline() {
      try {
        return !!window.matchMedia?.('(pointer: coarse)')?.matches && !window.matchMedia?.('(pointer: fine)')?.matches;
      } catch (_) {
        return false;
      }
    }

    isRunActive() {
      return !!(this.sendInFlight || this.currentRunId || this.streamingMsg ||
        (this.runState && ['sending', 'running'].includes(this.runState.state)));
    }

    updateComposerControls() {
      const caps = this.getSelectedCapabilities();
      const declared = Object.keys(caps).length > 0;
      const view = this.serverCapsView();
      const stopSupported = view ? view.showStop : (!declared || !!caps.interrupt);
      const running = this.isRunActive();
      if (this.stopBtn) {
        const hide = !stopSupported || !running;
        if (this.stopBtn.hidden !== hide) this.stopBtn.hidden = hide;
        this.stopBtn.disabled = hide;
        this.stopBtn.setAttribute('aria-hidden', hide ? 'true' : 'false');
        this.stopBtn.title = 'Stop the current reply';
      }
      if (this.sendBtn) {
        const busy = !!this.sendInFlight;
        // With the queue (design 4.3) Send stays usable while the agent works;
        // it is off only while a message is still uploading / not delivered (CH-25).
        const queueing = !!(globalThis.ChatQueue && this.queue);
        const uploading = busy && (!this.runState || this.runState.state === 'sending');
        const disabled = busy && (!queueing || uploading);
        if (this.sendBtn.disabled !== disabled) this.sendBtn.disabled = disabled;
        this.sendBtn.classList.toggle('is-busy', busy);
        let title = busy ? 'Sending… wait for this message to finish, or press Stop' : 'Send message';
        if (queueing && running) title = this.queueMode() === 'local' ? 'Queue this message for after the answer' : 'Add this to the running turn';
        if (this.sendBtn.title !== title) this.sendBtn.title = title;
      }
      this.root.classList.toggle('chat-run-active', running);
      this.renderBusyHint();
      if (!running && this.queue?.size && !this.queue.paused) this.maybeDrainQueue();
    }

    setRunState(state, text = '', runId = '') {
      if (!state) return this.clearRunState();
      this.runState = { state, text, runId: String(runId || this.runState?.runId || ''), at: Date.now() };
      this.renderRunState();
      this.updateComposerControls();
    }

    clearRunState() {
      this.runState = null;
      this.messages?.querySelectorAll('.chat-run-state').forEach(el => el.remove());
      this.updateComposerControls();
    }

    renderRunState() {
      if (!this.messages) return;
      const existing = [...this.messages.querySelectorAll('.chat-run-state')];
      if (!this.runState) { existing.forEach(el => el.remove()); return; }
      const el = existing.shift() || document.createElement('div');
      existing.forEach(extra => extra.remove());
      el.className = 'chat-run-state';
      el.dataset.state = this.runState.state;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      const defaults = { sending: 'Sending…', running: 'Delivered · working on it', error: 'Not finished', cancelled: 'Stopped' };
      el.textContent = this.runState.text || defaults[this.runState.state] || '';
      const users = this.messages.querySelectorAll('.chat-msg.user');
      const anchor = users[users.length - 1];
      if (anchor) {
        if (anchor.nextSibling !== el) anchor.after(el);
      } else if (el.parentNode !== this.messages) {
        this.messages.appendChild(el);
      }
    }

    showRunError(raw, { runId = '', allowRetry = true } = {}) {
      if (!this.messages) return null;
      const { title, detail } = friendlyRunError(raw);
      const key = String(runId || '') + '\u0000' + detail;
      if (this.lastRunError && this.lastRunError.key === key && this.lastRunError.el?.isConnected) return this.lastRunError.el;
      const send = this.lastSend;
      const runMatches = !runId || !send?.runId || send.runId === String(runId) || /-failed-/.test(String(runId));
      const retryText = allowRetry && send && send.fence === this.selectionFence() && send.sessionKey === this.sessionKey &&
        runMatches && Date.now() - send.at < 30 * 60 * 1000 ? send.text : '';
      const el = document.createElement('div');
      el.className = 'chat-msg system chat-run-error';
      el.dataset.runId = String(runId || '');
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble system-bubble chat-error-bubble';
      bubble.setAttribute('role', 'alert');
      const head = document.createElement('div');
      head.className = 'chat-error-title';
      head.textContent = title;
      bubble.appendChild(head);
      if (detail && detail !== title) {
        const small = document.createElement('div');
        small.className = 'chat-error-detail';
        small.textContent = 'Details: ' + detail;
        bubble.appendChild(small);
      }
      if (retryText) {
        const actions = document.createElement('div');
        actions.className = 'chat-error-actions';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'chat-error-retry';
        retry.dataset.chatAction = 'retry';
        retry.textContent = 'Retry';
        retry.title = 'Send the same message again';
        actions.appendChild(retry);
        bubble.appendChild(actions);
      }
      el.appendChild(bubble);
      this.lastRunError = { key, runId: String(runId || ''), retryText, el };
      this.messages.querySelector('.chat-empty-state')?.remove();
      this.messages.appendChild(el);
      this.scrollBottom();
      return el;
    }

    renderRunError() {
      const entry = this.lastRunError;
      if (!entry?.el || entry.el.isConnected || !this.messages) return;
      this.messages.appendChild(entry.el);
    }

    retireRunErrors() {
      this.lastRunError = null;
      this.messages?.querySelectorAll('.chat-error-retry').forEach(btn => {
        btn.disabled = true;
        btn.title = 'A newer message was sent';
      });
    }

    onRunTerminal(runId, status, errorText = '') {
      this.liveTerminalSeq += 1;
      // A failed or stopped turn parks what is queued until Resume.
      if ((status === 'failed' || status === 'cancelled') && this.queue?.pause()) this.renderQueue();
      if (status === 'failed') {
        if (this.runState?.state !== 'error') this.setRunState('error', 'Not finished', runId);
        this.showRunError(errorText || 'Run failed', { runId });
      } else if (status === 'cancelled') {
        this.setRunState('cancelled', 'Stopped', runId);
      } else {
        this.clearRunState();
        this.noteUnreadReply(runId);
      }
      this.updateComposerControls();
    }

    retryLastSend(button) {
      const entry = this.lastRunError;
      const text = entry?.retryText || '';
      if (!text || this.sendInFlight || this.sessionSelectionPending) return;
      if (button) {
        button.disabled = true;
        button.textContent = 'Retrying…';
      }
      this.lastRunError = null;
      this.sendMessage({ retryText: text });
    }

    abandonSend(typedText, notice) {
      if (typedText && this.input && !this.input.value.trim()) {
        this.input.value = typedText;
        this.autoResizeInput();
      }
      if (this.runState?.state === 'sending') this.clearRunState();
      this.appendSystem(notice);
    }

    handleMessageAction(button) {
      const action = button?.dataset?.chatAction;
      if (action === 'retry') return this.retryLastSend(button);
      if (action === 'reload-history') {
        button.disabled = true;
        if (!this.agentListLoaded) return this.refreshAgentList({ force: true });
        return this.loadHistory();
      }
      if (action === 'load-older') return this.showOlderMessages(button);
      if (action === 'suggest') {
        if (!this.input) return;
        this.input.value = button.dataset.text || button.textContent || '';
        this.autoResizeInput();
        this.input.focus();
        return;
      }
      if (action === 'copy-code' || action === 'copy-message') return this.copyFromButton(button, action);
    }

    async copyFromButton(button, action) {
      let text = '';
      if (action === 'copy-code') {
        text = button.closest('.chat-code-block')?.querySelector('pre')?.innerText || '';
      } else {
        const msg = button.closest('.chat-msg');
        text = msg?.dataset?.copyText || msg?.querySelector('.chat-message-content')?.innerText || '';
      }
      if (!text) return;
      let ok = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch (_) {}
      if (!ok) {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { ok = document.execCommand('copy'); } catch (_) {}
        area.remove();
      }
      // The icon turns into a check mark for a moment (a cross when the
      // browser refused), and the label says what happened.
      const label = button.dataset.label || button.getAttribute('aria-label') || 'Copy';
      button.dataset.label = label;
      setChatIcon(button, ok ? 'check' : 'close');
      button.title = ok ? 'Copied' : 'Copy failed';
      button.setAttribute('aria-label', button.title);
      button.classList.toggle('copied', ok);
      button.classList.toggle('copy-failed', !ok);
      clearTimeout(button._copyTimer);
      button._copyTimer = setTimeout(() => {
        setChatIcon(button, 'copy');
        button.title = button.dataset.label || 'Copy';
        button.setAttribute('aria-label', button.title);
        button.classList.remove('copied', 'copy-failed');
      }, 1400);
    }

    detachActiveRun({ remember = false } = {}) {
      const active = this.activeStream;
      if (!active) return;
      if (remember) {
        this.detachedRun = {
          provider: active.provider,
          runId: active.runId,
          sessionKey: this.sessionKey,
          fence: this.selectionFence(),
          startedAt: active.startedAt || Date.now()
        };
      }
      try { active.detach(); } catch (_) {}
    }

    async reattachRun(detached) {
      if (!detached?.runId || !this.isVisibleForPolling() || this.sendInFlight) return;
      if (detached.fence !== this.selectionFence()) return;
      const provider = detached.provider;
      this.sendInFlight = true;
      this.currentRunId = detached.runId;
      this.registerRunOwner(detached.runId, this.sessionKey);
      this.setRunState('running', 'Reconnected · working on it', detached.runId);
      try {
        if (provider === 'provider-sdk') await this.streamProviderRunEvents(detached.runId);
        else await this.streamNativeRunEvents(provider, detached.runId);
      } catch (error) {
        if (error?.detached) return;
      } finally {
        this.sendInFlight = false;
        this.updateComposerControls();
      }
      if (!this.isVisibleForPolling() || detached.fence !== this.selectionFence()) return;
      await this.loadHistory({ recoverFinal: true }).catch(() => {});
      if (this.runState?.state === 'running' || this.runState?.state === 'sending') this.clearRunState();
      if (this.currentRunId === detached.runId) this.currentRunId = null;
      this.updateComposerControls();
    }

    // ── Unread replies (C4) ──────────────────────────────────────────────
    noteUnreadReply(runId = '') {
      const visible = this.isVisibleForPolling() && !document.hidden;
      if (visible && this.followLatest) return;
      const key = String(runId || '') || ('reply-' + Date.now());
      this.unreadRuns = this.unreadRuns || new Set();
      if (this.unreadRuns.has(key)) return;
      this.unreadRuns.add(key);
      if (this.unreadRuns.size > 50) this.unreadRuns.delete(this.unreadRuns.values().next().value);
      this.unreadCount += 1;
      notifyUnreadChanged();
    }

    clearUnread() {
      if (!this.unreadCount) return;
      this.unreadCount = 0;
      notifyUnreadChanged();
    }

    resetConversation(systemText) {
      this.detachActiveRun();
      this.detachedRun = null;
      this.runState = null;
      this.lastRunError = null;
      this.historyHiddenItems = [];
      if (this.isRecording) this.stopRecording({ discard: true });
      this.taskReferences?.clear();
      this.syncTaskProgress?.();
      this.cancelPendingScrollBottom();
      this.followLatest = true;
      this.clearManualScrollIntent();
      this.messages.innerHTML = '';
      this.lastMessagesScrollTop = 0;
      this.updateScrollLatestButton();
      this.streamingMsg = null;
      this.pendingStreamContent = '';
      if (this.streamRenderTimer) { clearTimeout(this.streamRenderTimer); this.streamRenderTimer = null; }
      if (this.recoveryTimer) { clearInterval(this.recoveryTimer); this.recoveryTimer = null; }
      this.stopHermesProgressTimers();
      this.stopHermesHistoryPolling();
      this.stopCodexHistoryPolling();
      this.stopClaudeCodeHistoryPolling();
      this.stopProviderHistoryPolling();
      this.closeHermesEventSource();
      this.closeCodexEventSource();
      this.closeClaudeCodeEventSource();
      this.closeProviderEventSource();
      this.currentRunId = null;
      // A serve send still waiting for the previous chat's run lets go now (not on the next 1 s tick).
      if (this.serveRunWaiters?.size) this.releaseServeWaiters();
      this.turnEvents.reset();
      this.openClawEventQueue = Promise.resolve();
      this.seenOpenClawCommentary.clear();
      this.sessionModel = '—';
      this.contextWindow = 0;
      this.contextUsed = 0;
      this.updateModelBar();
      if (systemText) this.appendSystem(systemText);
    }

    setStatus(text, cls) {
      if (cls === 'disconnected' && this.progressPanel?.identity?.providerKind === 'openclaw') progressStore.invalidate(this.progressPanel.identity, { disconnect: true });
      if (!this.status) return;
      this.status.textContent = text;
      this.status.className = 'chat-status ' + (cls || '');
      // Phones show the status as a dot; the words stay available as a tooltip.
      this.status.title = text;
      this.status.setAttribute('aria-label', 'Chat status: ' + text);
    }

    formatTokens(n, options = {}) {
      const value = Number(n) || 0;
      if (options.exact && value < 1000000) return Math.round(value).toLocaleString();
      if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
      if (value >= 1000) return (value / 1000).toFixed(value < 100000 ? 1 : 0).replace(/\.0$/, '') + 'k';
      return String(Math.round(value));
    }

    updateModelBar() {
      if (!this.modelName || !this.contextInfo) return;
      const shortModel = this.sessionModel.includes('/') ? this.sessionModel.split('/').pop() : this.sessionModel;
      this.modelName.textContent = shortModel;
      if (this.contextWindow > 0 && this.contextUsed > 0) {
        this.contextInfo.textContent = this.formatTokens(this.contextUsed) + ' / ' + this.formatTokens(this.contextWindow);
      } else if (this.contextWindow > 0) {
        this.contextInfo.textContent = '— / ' + this.formatTokens(this.contextWindow);
      } else {
        this.contextInfo.textContent = '';
      }
      this.syncPickers();
      this.syncSidePanel();
      this.renderContextMeter();
    }

    /** "Context 41%" from the run's `usage` (or the session metrics), hidden when unknown (design 4.2). */
    renderContextMeter() {
      const bar = this.root.querySelector('.chat-model-bar');
      if (!bar) return;
      const view = this.serverCapsView();
      const usage = this.lastUsage || {};
      let used = Number(usage.used);
      let size = Number(usage.size);
      if (!(used >= 0 && size > 0)) { used = this.contextUsed; size = this.contextWindow; }
      let percent = Number.isFinite(Number(usage.percent)) ? Number(usage.percent) : NaN;
      if (!Number.isFinite(percent) && used > 0 && size > 0) percent = Math.round((used / size) * 100);
      let meter = bar.querySelector('.hp-context-meter');
      const show = !!view?.showContext && Number.isFinite(percent);
      if (!show) {
        if (meter) meter.hidden = true;
        if (this.contextInfo) this.contextInfo.hidden = false;
        return;
      }
      percent = Math.max(0, Math.min(100, Math.round(percent)));
      if (!meter) {
        meter = document.createElement('span');
        meter.className = 'hp-context-meter';
        meter.setAttribute('role', 'meter');
        meter.setAttribute('aria-valuemin', '0');
        meter.setAttribute('aria-valuemax', '100');
        const label = document.createElement('span');
        label.className = 'hp-context-label';
        const track = document.createElement('span');
        track.className = 'hp-context-track';
        const fill = document.createElement('span');
        fill.className = 'hp-context-fill';
        track.appendChild(fill);
        meter.append(label, track);
        bar.appendChild(meter);
      }
      meter.hidden = false;
      meter.dataset.level = percent >= 90 ? 'high' : (percent >= 70 ? 'mid' : 'low');
      meter.setAttribute('aria-valuenow', String(percent));
      meter.querySelector('.hp-context-label').textContent = `Context ${percent}%`;
      meter.querySelector('.hp-context-fill').style.width = percent + '%';
      meter.title = used > 0 && size > 0
        ? `${this.formatTokens(used)} of ${this.formatTokens(size)} tokens used in this chat`
        : `${percent}% of the context used`;
      // The meter replaces the plain "used / window" text.
      if (this.contextInfo) this.contextInfo.hidden = true;
    }

    applySessionMetrics(data = {}) {
      if (!data || typeof data !== 'object') return;
      if (data.model) this.sessionModel = data.model;
      const tokenUsage = data.tokenUsage && typeof data.tokenUsage === 'object' ? data.tokenUsage : {};
      const lastUsage = tokenUsage.last && typeof tokenUsage.last === 'object' ? tokenUsage.last : {};
      const totalUsage = tokenUsage.total && typeof tokenUsage.total === 'object' ? tokenUsage.total : {};
      const used = Number.isFinite(Number(data.contextUsed))
        ? Number(data.contextUsed)
        : (Number.isFinite(Number(lastUsage.totalTokens)) ? Number(lastUsage.totalTokens)
          : (Number.isFinite(Number(lastUsage.inputTokens)) ? Number(lastUsage.inputTokens)
            : (Number.isFinite(Number(totalUsage.totalTokens)) ? Number(totalUsage.totalTokens) : null)));
      const windowSize = Number.isFinite(Number(data.contextWindow))
        ? Number(data.contextWindow)
        : (Number.isFinite(Number(tokenUsage.modelContextWindow)) ? Number(tokenUsage.modelContextWindow) : null);
      if (used !== null && used >= 0) this.contextUsed = used;
      if (windowSize !== null && windowSize > 0) this.contextWindow = windowSize;
      this.updateModelBar();
    }

    autoResizeInput() {
      if (!this.input) return;
      const lineHeight = parseInt(getComputedStyle(this.input).fontSize) * 1.4;
      const inputMaxHeight = lineHeight * MAX_INPUT_LINES;
      this.input.style.height = 'auto';
      const newHeight = Math.min(this.input.scrollHeight, inputMaxHeight);
      this.input.style.height = newHeight + 'px';
      this.input.style.overflowY = this.input.scrollHeight > inputMaxHeight ? 'auto' : 'hidden';
    }

    syncAgentSelect() {
      if (!this.agentSelect) return;
      // (v0.12: OpenClaw and Hermes agents of the layer stay listed but this window never shows one: the copied one does)
      const options = officeOptions(this.agentSelect);
      // CH-18: a saved agent that was missing from an earlier list (still
      // starting, or a slow provider) is restored once it shows up.
      if (this.restoreSelection && options.some(opt => optionMatchesSelectedAgent(opt, this.restoreSelection.selectedAgentKey))) {
        this.selectedAgentKey = this.restoreSelection.selectedAgentKey;
        this.sessionKey = this.restoreSelection.sessionKey;
        this.restoreSelection = null;
      }
      const selected = options.find(opt => {
        if (!optionMatchesSelectedAgent(opt, this.selectedAgentKey)) return false;
        const canonical = canonicalSessionKeyForOption(opt, this.sessionKey, this.selectedAgentKey);
        return canonical === opt.dataset.sessionKey || canonical.startsWith(opt.dataset.sessionKey + ':');
      }) || options.find(opt => optionMatchesSelectedAgent(opt, this.selectedAgentKey))
        || options.find(opt => this.sessionKey === opt.dataset.sessionKey || this.sessionKey.startsWith(opt.dataset.sessionKey + ':'))
        || options[0];
      if (selected) {
        // A single select deselects the others itself.
        selected.selected = true;
        const previousAgentKey = this.selectedAgentKey;
        const previousSessionKey = this.sessionKey;
        const matchedWanted = optionMatchesSelectedAgent(selected, previousAgentKey) ||
          previousSessionKey === selected.dataset.sessionKey || previousSessionKey.startsWith(selected.dataset.sessionKey + ':');
        // (a saved OpenClaw/Hermes agent of the layer never comes back here: the choice moves on, saved, quietly)
        const wantedLayer = !matchedWanted && [...this.agentSelect.querySelectorAll('option')]
          .some(opt => isLayerOption(opt) && optionMatchesSelectedAgent(opt, previousAgentKey));
        if (wantedLayer) this.restoreSelection = null;
        if (!matchedWanted && !wantedLayer && this.hasExplicitAgentSelection && !this.restoreSelection) {
          this.restoreSelection = { selectedAgentKey: previousAgentKey, sessionKey: previousSessionKey };
        }
        this.sessionKey = canonicalSessionKeyForOption(selected, previousSessionKey, previousAgentKey);
        this.selectedAgentKey = selected.value;
        if (this.selectedAgentKey !== previousAgentKey || this.sessionKey !== previousSessionKey) {
          // Never overwrite the saved choice with a temporary fallback.
          if (matchedWanted || !this.restoreSelection) this.saveSelection();
          else this.syncTaskProgress?.();
        }
      }
      this.syncAgentPickFace();
    }

    /** The chosen agent's emoji and name (the header picker and the window buttons). */
    agentFace() {
      const opt = this.agentSelect?.selectedOptions?.[0];
      const text = String(opt?.textContent || '').trim();
      let emoji = String(opt?.dataset?.emoji || '').trim();
      let name = String(opt?.dataset?.name || '').trim();
      if (!name) {
        const m = text.match(/^([^\p{L}\p{N}]+)\s+(.+)$/u);
        if (m && !emoji) emoji = m[1].trim();
        name = m ? m[2].trim() : text;
      }
      return { emoji, name };
    }

    // The header shows the chosen agent as avatar + readable name + chevron;
    // the native select stays on top (invisible) so the OS picker, keyboard
    // and screen readers keep working.
    syncAgentPickFace() {
      scheduleWindowRailPaint();
      const pick = this.agentPick;
      if (!pick) return;
      const { emoji, name } = this.agentFace();
      const av = pick.querySelector('.chat-agent-pick-av');
      const label = pick.querySelector('.chat-agent-pick-name');
      if (av && av.textContent !== (emoji || '🤖')) av.textContent = emoji || '🤖';
      if (label && label.textContent !== (name || 'Agent')) label.textContent = name || 'Agent';
      const tip = name ? `${name}: switch agent` : 'Switch agent';
      if (pick.title !== tip) pick.title = tip;
    }

    selectionFence() {
      const o = this.agentSelect?.selectedOptions?.[0];
      return JSON.stringify([this.selectionGeneration || 0, this.selectedAgentKey,
        o?.dataset.providerKind, o?.dataset.providerConnectionId, o?.dataset.providerAgentId]);
    }

    beginSessionSelection() {
      this.selectionGeneration = (this.selectionGeneration || 0) + 1;
      this.sessionSelectionPending = true;
      this.providerHealth = '';
      this.lastUsage = null;
      ++this.historyRefreshSeq;
      ++this.sessionsRefreshSeq;
      this.progressPanel?.select(null);
      this.taskReferences?.clear();
      return this.selectionFence();
    }

    syncTaskProgress() {
      const option = this.agentSelect?.selectedOptions?.[0];
      const kind = option?.dataset.providerKind;
      const owner = option?.dataset.providerAgentId;
      const base = option?.dataset.sessionKey;
      const belongs = kind === 'openclaw' ? this.sessionKey.startsWith(`agent:${owner}:`) :
        (this.sessionKey === base || this.sessionKey.startsWith(`${base}:`));
      const nativeSessionId = kind === 'openclaw' ? this.sessionKey : this.selectedProviderSessionId();
      const identity = !this.sessionSelectionPending && this.root.classList.contains('open') && !document.hidden && option?.value === this.selectedAgentKey &&
        belongs && owner && option?.dataset.providerConnectionId && nativeSessionId && !nativeSessionId.includes('@new') ? {
          connectionId: option.dataset.providerConnectionId, providerKind: kind, nativeOwnerId: owner, nativeSessionId
        } : null;
      if (globalThis.VirtualWorldSessionProgress.identityKey(identity) !== globalThis.VirtualWorldSessionProgress.identityKey(this.progressPanel?.identity)) this.taskReferences?.clear();
      this.progressPanel?.select(identity);
    }

    saveSelection() {
      this.syncTaskProgress?.();
      saveChatSelection(this.slotId, {
        selectedAgentKey: this.selectedAgentKey,
        sessionKey: this.sessionKey
      });
    }

    applySelection(opt, { markExplicit = false, systemPrefix = 'Switched to' } = {}) {
      if (!opt) return;
      const newSessionKey = opt.dataset.sessionKey;
      const newAgentKey = opt.value;
      if (newSessionKey === this.sessionKey && newAgentKey === this.selectedAgentKey) {
        if (markExplicit) {
          this.hasExplicitAgentSelection = true;
          this.saveSelection();
        }
        this.syncCapabilityControls();
        this.syncSelectionStatus();
        if (this.isVisibleForPolling() && (connected || this.isProviderAgentSelected())) this.fetchSessionInfo();
        return;
      }
      this.beginSessionSelection();
      this.sessionSelectionPending = false;
      this.selectedAgentKey = newAgentKey;
      this.sessionKey = newSessionKey;
      if (markExplicit) {
        this.hasExplicitAgentSelection = true;
        this.restoreSelection = null;
      }
      this.saveSelection();
      this.currentRunId = null;
      this.streamingMsg = null;
      this.syncAgentSelect();
      this.syncCapabilityControls();
      this.syncSelectionStatus();
      this.resetConversation(`${systemPrefix} ${opt.textContent.trim()}`);
      this.closeChatStream();
      this.releaseServeWaiters();
      this.renderPlanCard(null);
      if (this.sessionsPanelOpen) this.refreshSessionsList({ showLoading: true });
      const isHermes = this.isNativeHermesSelected();
      const isCodex = this.isCodexSelected();
      const isClaudeCode = this.isClaudeCodeSelected();
      if (isHermes && this.isVisibleForPolling()) this.startHermesApprovalPolling();
      else this.stopHermesApprovalPolling();
      if (isCodex && this.isVisibleForPolling()) this.startCodexApprovalPolling();
      else this.stopCodexApprovalPolling();
      if (connected || this.isProviderAgentSelected()) {
        this.loadHistory();
        this.fetchSessionInfo();
      }
    }

    async loadAgentList() {
      return this.refreshAgentList();
    }

    /** v0.12: nothing this window may show (every agent listed is an OpenClaw/Hermes agent of the layer): it closes,
     *  the copied window is theirs. True then. */
    leaveToLayer() {
      if (!this.agentSelect?.querySelector('option') || officeOptions(this.agentSelect).length) return false;
      if (windowManager?.has(this.slotId)) windowManager.close(this.slotId);
      return true;
    }

    async refreshAgentList(options = {}) {
      let data;
      try {
        data = await fetchAgentsListShared(options);
      } catch (e) {
        console.warn('[chat] Failed to load agent list:', e);
        if (!this.agentListLoaded && this.isVisibleForPolling()) {
          this.showHistoryStatus('error', 'Could not load the list of agents. ' + friendlyRunError(e).title);
        }
        return;
      }
      if (!data.agents || !this.agentSelect) return;
      if (!layerKnown) await layerDecided;   // (v0.12: which agents this window may show)
      if (await routerOn()) return;           // (unify: the layer mounted: no office window, no picker to fill)
      const fenceBefore = this.selectionFence();
      this.agentList = data.agents;
      this.agentSelect.innerHTML = '';
      const branches = {};
      // (two agents with one name, e.g. OpenClaw's and Codex's "Main": the picker adds the provider to both)
      const optionLabels = new Map();
      const labels = globalThis.ChatPickers?.agentOptionLabels ? globalThis.ChatPickers.agentOptionLabels(this.agentList) : [];
      this.agentList.forEach((a, i) => { if (labels[i]) optionLabels.set(a, labels[i]); });
      for (const a of this.agentList) {
        if (!branches[a.branch]) branches[a.branch] = [];
        branches[a.branch].push(a);
      }
      for (const [branch, agents] of Object.entries(branches)) {
        const group = document.createElement('optgroup');
        group.label = branch;
        for (const a of agents) {
          const opt = document.createElement('option');
          opt.value = a.key;
          opt.textContent = optionLabels.get(a) || `${a.emoji} ${a.name}`;
          opt.dataset.emoji = a.emoji || '';
          opt.dataset.name = a.name || '';
          opt.dataset.sessionKey = a.sessionKey;
          opt.dataset.agentId = a.agentId;
          opt.dataset.providerKind = a.providerKind || 'openclaw';
          opt.dataset.providerType = a.providerType || 'runtime';
          opt.dataset.providerAgentId = a.providerAgentId || a.agentId;
          opt.dataset.providerConnectionId = a.providerConnectionId || ''; // exact registry connection, never an owner alias
          opt.dataset.apiAvailable = a.apiAvailable ? 'true' : 'false';
          opt.dataset.cliAvailable = a.cliAvailable ? 'true' : 'false';
          opt.dataset.connectionModes = JSON.stringify(a.connectionModes || []);
          opt.dataset.selectionAliases = JSON.stringify(a.selectionAliases || []);
          opt.dataset.capabilities = JSON.stringify(a.capabilities || {});
          group.appendChild(opt);
        }
        this.agentSelect.appendChild(group);
      }
      const firstLoad = !this.agentListLoaded;
      this.agentListLoaded = true;
      this.syncAgentSelect();
      if (this.leaveToLayer()) return;
      this.syncCapabilityControls();
      this.syncSelectionStatus();
      if (this.sessionsPanelOpen) this.refreshSessionsList({ showLoading: true });
      // Reload only on the first list or when the list changed the selection;
      // a routine refresh must not wipe and repaint the open conversation.
      if (!firstLoad && fenceBefore === this.selectionFence() && !this.historyDirty) return;
      if (connected || this.isProviderAgentSelected()) {
        this.loadHistory();
        this.fetchSessionInfo();
      }
    }

    isVisibleForPolling() {
      return this.root.classList.contains('open');
    }

    async fetchContextUsage() {
      if (!this.isVisibleForPolling()) return;
      if (this.isProviderAgentSelected()) return;
      try {
        // Avoid broad sessions.list polling. Describe only the selected session.
        const res = await rpc('sessions.describe', { key: this.sessionKey });
        const s = res?.payload?.session;
        if (!res.ok || !s) return;
        if (s.totalTokens > 0) this.contextUsed = s.totalTokens;
        if (s.contextTokens > 0 && s.contextTokens > this.contextWindow) this.contextWindow = s.contextTokens;
        // Don't update model from gateway transcript — it can be stale.
        // Model display is driven by fetchSessionInfo() from server config.
        this.updateModelBar();
      } catch (e) {
        console.warn('[chat] Failed to fetch context usage:', e);
      }
    }

    getSelectedAgentId() {
      if (!this.agentSelect) return null;
      const opt = this.agentSelect.selectedOptions[0];
      return opt?.dataset?.agentId || null;
    }

    getSelectedProviderKind() {
      const opt = this.agentSelect?.selectedOptions?.[0];
      return opt?.dataset?.providerKind || 'openclaw';
    }

    getSelectedProviderProfile() {
      const opt = this.agentSelect?.selectedOptions?.[0];
      return opt?.dataset?.providerAgentId || opt?.dataset?.agentId || 'main';
    }

    selectedProviderSessionId() {
      return providerSessionIdFromKey(this.sessionKey, this.getSelectedProviderKind());
    }

    selectedProviderHistorySessionId() {
      return providerHistorySessionIdFromKey(this.sessionKey, this.getSelectedProviderKind());
    }

    isPendingProviderSession() {
      return isPendingProviderSessionKey(this.sessionKey, this.getSelectedProviderKind());
    }

    selectedProviderBaseSessionKey() {
      const opt = this.agentSelect?.selectedOptions?.[0];
      return opt?.dataset?.sessionKey || `${this.getSelectedProviderKind()}:${this.getSelectedProviderProfile()}`;
    }

    setSelectedSessionKey(sessionKey) {
      const next = String(sessionKey || '').trim();
      if (!next || next === this.sessionKey) return false;
      this.sessionKey = next;
      this.saveSelection();
      return true;
    }

    /** A chat not on the provider yet (`<kind>:<profile>:@new:<id>`): sends with an empty session. */
    newPendingSessionKey() {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      return `${this.getSelectedProviderKind()}:${this.getSelectedProviderProfile()}:@new:${id}`;
    }

    adoptProviderSessionId(sessionId) {
      const value = String(sessionId || '').trim();
      const kind = this.getSelectedProviderKind();
      if (!value || kind === 'openclaw') return false;
      return this.setSelectedSessionKey(`${kind}:${this.getSelectedProviderProfile()}:${value}`);
    }

    registerRunOwner(runId, sessionKey = this.sessionKey) {
      const value = String(runId || '').trim();
      if (!value) return;
      runOwners.set(value, {
        slotId: this.slotId,
        sessionKey: String(sessionKey || ''),
        agentId: String(this.getSelectedAgentId() || this.selectedAgentKey || '')
      });
    }

    registerProviderRun(runId, sessionKey = this.sessionKey) {
      this.registerRunOwner(runId, sessionKey);
    }

    previewOwnerForRun(runId) {
      const owner = runOwners.get(String(runId || '').trim());
      return owner || {
        slotId: this.slotId,
        sessionKey: String(this.sessionKey || ''),
        agentId: String(this.getSelectedAgentId() || this.selectedAgentKey || '')
      };
    }

    acceptsProviderRunEvent(runId, data, eventName) {
      if (this.sessionSelectionPending) return false;
      const value = String(runId || '').trim();
      const eventSessionId = String(data?.sessionId || '').trim();
      const owner = value ? runOwners.get(value) : null;
      let accepted = !owner || (owner.slotId === this.slotId && owner.sessionKey === this.sessionKey);
      if (!owner && eventSessionId) {
        const selectedSessionId = this.selectedProviderSessionId();
        accepted = this.isPendingProviderSession() || !selectedSessionId || selectedSessionId === eventSessionId;
      }
      if (accepted && eventSessionId) {
        this.adoptProviderSessionId(eventSessionId);
        if (owner) owner.sessionKey = this.sessionKey;
      }
      if (!accepted && value && ['run.completed', 'run.failed', 'run.cancelled', 'run.canceled'].includes(eventName)) {
        runOwners.delete(value);
      }
      return accepted;
    }

    getSelectedCapabilities() {
      const opt = this.agentSelect?.selectedOptions?.[0];
      try {
        return JSON.parse(opt?.dataset?.capabilities || '{}') || {};
      } catch (_) {
        return {};
      }
    }

    syncCapabilityControls() {
      try { syncChatSlotTabs(); } catch (_) {} // P3-7: tab names follow the selected agent
      this.maybeRefreshCan();
      const view = this.serverCapsView();
      const caps = this.getSelectedCapabilities();
      const declared = !!view || Object.keys(caps).length > 0;
      const update = (element, supported) => {
        if (!element) return;
        const unavailable = declared && !supported;
        element.hidden = unavailable;
        element.disabled = unavailable;
        element.setAttribute('aria-hidden', unavailable ? 'true' : 'false');
      };
      const sessionsSupported = view ? view.showSessions : !!(caps.sessions || caps.sessionCreate || caps.sessionSwitch);
      update(this.sessionsToggleBtn, sessionsSupported);
      update(this.newSessionBtn, view ? view.showNewSession : !!caps.sessionCreate);
      update(this.sessionsNewBtn, view ? view.showNewSession : !!caps.sessionCreate);
      update(this.attachBtn, view ? view.showAttach : !!caps.attachments);
      this.renderConnectionLine();
      this.syncPickers();
      this.renderContextMeter();
      this.syncQueue();
      this.syncSidePanel();
      // Stop is shown only while a reply is running (CH-31).
      this.updateComposerControls();
      if (!sessionsSupported && this.sessionsPanelOpen) this.toggleSessionsPanel(false);
    }

    /** The selected agent's office id (the `agent` of every /api/agent-chat call). */
    chatAgentId() {
      return String(this.getSelectedAgentId() || this.selectedAgentKey || '');
    }

    /** An OpenClaw agent on the office's own gateway connection (not a provider agent). */
    isNativeOpenClawSelected() {
      return this.getSelectedProviderKind() === 'openclaw' && !this.isProviderAgentSelected();
    }

    /** The `session` of /api/agent-chat calls: OpenClaw's session key, else the provider session id. */
    agentChatSession() {
      if (this.isNativeOpenClawSelected()) return String(this.sessionKey || '');
      return this.selectedProviderSessionId();
    }

    /** One key per chat (agent + session): pickers and the queue keep their state per chat. */
    chatStateKey() {
      return this.chatAgentId() + '\u0000' + (this.agentChatSession() || String(this.sessionKey || ''));
    }

    /** Pickers follow the manifest and the chat (design 4.2 "Model + effort pickers"). */
    syncPickers() {
      if (this.permissions) {
        const permKind = this.isCodexSelected() ? 'codex' : (this.isClaudeCodeSelected() ? 'claude-code' : '');
        this.permissions.setAgent(permKind, permKind ? this.chatAgentId() : '');
      }
      if (!this.pickers) return;
      const view = this.serverCapsView();
      // A chat's own choice is read with its model list (`current`); until then the bar shows the session model.
      const key = this.chatStateKey();
      const prefs = this.pickersKey === key ? this.pickers.prefs() : {};
      this.pickersKey = key;
      this.pickers.setChat(key, prefs, this.sessionModel || '');
      this.pickers.setVisible({ model: !!view?.showModelPicker, effort: !!view?.showEffortPicker });
      const pickersShown = !!(view?.showModelPicker || view?.showEffortPicker);
      // Read the list once per chat (a GET) so the buttons name the chat's model before the first open.
      if (pickersShown && this.pickersPrimed !== key && this.isVisibleForPolling()) {
        this.pickersPrimed = key;
        this.pickers.prime().catch(() => {});
      }
      if (this.modelName) this.modelName.hidden = pickersShown;
    }

    /** The side panel follows the manifest, the agent and the chat (design 4.2, D1). */
    syncSidePanel() {
      if (!this.sidePanel) return;
      const view = this.serverCapsView();
      const label = this.agentSelect?.selectedOptions?.[0]?.textContent || '';
      this.sidePanel.setContext({
        view,
        agent: this.chatAgentId(),
        session: this.agentChatSession(),
        agentName: label.replace(/^\S+\s+/, '').trim() || label.trim(),
        transport: view?.transport || '',
        taskSteer: !!(view && this.can?.caps?.taskSteer)
      });
    }

    /** Fetch the manifest when the agent changed or the last one is a minute old. */
    maybeRefreshCan() {
      const agent = this.chatAgentId();
      if (!agent || !globalThis.ChatCaps || !this.agentListLoaded) return;
      // (only an agent of the picker: an office without "main" never asks for the default one)
      if (!this.getSelectedAgentId()) return;
      if (this.canInFlight === agent) return;
      if (this.canAgent === agent && Date.now() - this.canAt < 60000) return;
      this.refreshCan().catch(() => {});
    }

    /**
     * `GET /api/agent-chat/can` (design 4.1).  A server without the route, or
     * an answer that is not a manifest, keeps today's registry flags so every
     * provider looks as before.
     */
    async refreshCan() {
      const agent = this.chatAgentId();
      if (!agent || !globalThis.ChatCaps) return null;
      const seq = ++this.canSeq;
      this.canInFlight = agent;
      let manifest = null, notListed = false;
      try {
        // An office server without the route answers 404 not_found: ask again
        // only every few minutes instead of once per agent and window.
        if (Date.now() < canRouteMissingUntil) throw new Error('no can route');
        // An agent that is not in the picker (none chosen yet, or not in this office): nothing to ask.
        if (!this.getSelectedAgentId()) { notListed = true; throw new Error('not an agent of the picker'); }
        // Windows asking for the same agent at once share one request.
        let shared = canRequests.get(agent);
        if (!shared) {
          shared = fetch('/api/agent-chat/can?agent=' + encodeURIComponent(agent), { cache: 'no-store', credentials: 'same-origin' })
            .then(async (res) => ({ status: res.status, data: await res.json().catch(() => null) }))
            .finally(() => canRequests.delete(agent));
          canRequests.set(agent, shared);
        }
        const { status, data } = await shared;
        if (status === 404 && data?.error === 'not_found') canRouteMissingUntil = Date.now() + 5 * 60 * 1000;
        const failure = data && data.ok === false && typeof data.reason === 'string' && data.reason;
        const live = data && data.ok === true && data.caps && typeof data.caps === 'object' && typeof data.transport === 'string' && data.transport;
        if (failure || live) manifest = ChatCaps.normalize(data);
      } catch (_) {}
      if (this.canInFlight === agent) this.canInFlight = '';
      if (seq !== this.canSeq || agent !== this.chatAgentId()) return null;
      const applied = this.applyCaps(manifest || ChatCaps.fromRegistry(this.getSelectedCapabilities(), { kind: this.getSelectedProviderKind(), agent }), agent);
      if (notListed) this.canAt = 0;   // (ask as soon as it is in the picker, not a minute later)
      return applied;
    }

    /** Store the manifest for `agent` and re-apply every control (design 4.2 "Capability gating"). */
    applyCaps(can, agent = this.chatAgentId()) {
      const wasServe = this.isServeHermesSelected();
      this.can = can || null;
      this.canAgent = String(agent || '');
      this.canAt = Date.now();
      this.capsView = can && globalThis.ChatCaps ? ChatCaps.derive(can) : null;
      this.syncCapabilityControls();
      if (wasServe !== this.isServeHermesSelected() && this.isVisibleForPolling()) this.loadHistory().catch(() => {});
      return this.capsView;
    }

    /** Derived flags from the server's manifest for the selected agent, else null (registry rules apply). */
    serverCapsView() {
      if (!this.capsView || !this.can || this.can.source !== 'server') return null;
      return this.canAgent === this.chatAgentId() ? this.capsView : null;
    }

    /** One line above the composer when the agent's connection is not ready (design 4.1 failure, 4.4). */
    renderConnectionLine() {
      const view = this.serverCapsView();
      const line = view ? view.connectionLine : null;
      let el = this.root.querySelector('.hp-conn-line');
      if (!line) { if (el) el.hidden = true; return; }
      if (!el) {
        el = document.createElement('div');
        el.className = 'hp-conn-line';
        el.setAttribute('role', 'status');
        const anchor = this.root.querySelector('.chat-attachments-preview') || this.root.querySelector('.chat-input-row');
        if (anchor?.parentNode) anchor.parentNode.insertBefore(el, anchor);
        else this.root.appendChild(el);
      }
      el.hidden = false;
      el.dataset.tone = line.tone || 'info';
      el.textContent = '';
      const text = document.createElement('span');
      text.className = 'hp-conn-text';
      text.textContent = line.text || '';
      el.appendChild(text);
      if (line.fix) {
        const fix = document.createElement('span');
        fix.className = 'hp-conn-fix';
        fix.textContent = line.fix;
        el.appendChild(fix);
      }
      if (line.action) {
        const link = document.createElement('a');
        link.className = 'hp-conn-action';
        link.href = 'providers.html';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = line.action;
        el.appendChild(link);
      }
    }

    syncSelectionStatus() {
      const kind = this.getSelectedProviderKind();
      const label = this.agentSelect?.selectedOptions?.[0]?.textContent.trim() || kind;
      if (kind === 'openclaw') {
        this.setStatus(connected ? 'Connected' : 'Offline', connected ? 'connected' : 'disconnected');
      } else if (this.providerHealth === 'ok') {
        this.setStatus('Ready', 'connected');
      } else if (this.providerHealth === 'error') {
        this.setStatus('Not reachable', 'disconnected');
      } else {
        this.setStatus('Loading…', 'connecting');
      }
      if (this.status) this.status.title = `${label}: ${this.status.textContent}`;
    }

    setProviderHealth(state) {
      if (this.providerHealth === state) return;
      this.providerHealth = state;
      if (this.isProviderAgentSelected()) this.syncSelectionStatus();
    }

    isHermesSelected() {
      return this.getSelectedProviderKind() === 'hermes' || String(this.sessionKey || '').startsWith('hermes:');
    }

    isNativeHermesSelected() {
      const opt = this.agentSelect?.selectedOptions?.[0];
      return this.isHermesSelected() && opt?.dataset?.apiAvailable === 'true' && !this.isServeHermesSelected();
    }

    /**
     * A Hermes agent reached through `hermes serve` (design 2.10: discovery
     * rows carry connectionModes ['serve']; the manifest's transport wins).
     */
    isServeHermesSelected() {
      const opt = this.agentSelect?.selectedOptions?.[0];
      if (!opt || opt.dataset.providerKind !== 'hermes') return false;
      if (this.can?.source === 'server' && this.can.ok && this.canAgent === this.chatAgentId()) return this.can.transport === 'hermes-serve';
      try { return JSON.parse(opt.dataset.connectionModes || '[]').includes('serve'); } catch (_) { return false; }
    }

    selectedHermesSessionId() {
      const active = this.activeSessionIdForPanel();
      if (active) return active;
      const match = String(this.sessionKey || '').match(/^hermes:[^:]+:(.+)$/);
      return match ? match[1] : '';
    }

    isCodexSelected() {
      return this.getSelectedProviderKind() === 'codex' || String(this.sessionKey || '').startsWith('codex:');
    }

    isClaudeCodeSelected() {
      return this.getSelectedProviderKind() === 'claude-code' || String(this.sessionKey || '').startsWith('claude-code:');
    }

    isProviderAgentSelected() {
      return this.getSelectedProviderKind() !== 'openclaw' || this.isHermesSelected() || this.isCodexSelected() || this.isClaudeCodeSelected();
    }

    isGenericProviderSelected() {
      const kind = this.getSelectedProviderKind();
      if (kind === 'hermes') return !this.isNativeHermesSelected() && !this.isServeHermesSelected();
      return kind !== 'openclaw' && kind !== 'codex' && kind !== 'claude-code';
    }

    startHermesApprovalPolling() {
      if (!this.isNativeHermesSelected() || this.hermesApprovalPollTimer) return;
      this.pollHermesApproval().catch(() => {});
      this.hermesApprovalPollTimer = setInterval(() => {
        this.pollHermesApproval().catch(() => {});
      }, HERMES_APPROVAL_POLL_MS);
    }

    stopHermesApprovalPolling() {
      if (this.hermesApprovalPollTimer) {
        clearInterval(this.hermesApprovalPollTimer);
        this.hermesApprovalPollTimer = null;
      }
      this.hermesApprovalLastId = '';
    }

    // One request at a time per poll kind, and nothing while the browser tab
    // is hidden (CH-28).
    async runGuardedPoll(name, fn) {
      if (this.pollGuards.has(name) || document.hidden) return;
      this.pollGuards.add(name);
      try {
        return await fn();
      } finally {
        this.pollGuards.delete(name);
      }
    }

    async pollHermesApproval() {
      if (!this.isNativeHermesSelected() || !this.isVisibleForPolling()) return;
      return this.runGuardedPoll('hermes-approval', async () => {
        const fence = this.selectionFence();
        const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
        const params = new URLSearchParams({ agentId });
        const sessionId = this.selectedProviderSessionId();
        if (sessionId) params.set('sessionId', sessionId);
        const res = await fetch('/api/hermes/approval/pending?' + params.toString());
        const data = await res.json();
        // The selection may have changed while the request was in flight (CH-26).
        if (fence !== this.selectionFence() || this.sessionSelectionPending || !this.isNativeHermesSelected()) return;
        if (!data.ok || !data.pending) return;
        this.appendHermesPendingApproval({ ...data.pending, _voAgentId: agentId }, data.pending_count || 1);
      });
    }

    appendHermesPendingApproval(approval, pendingCount = 1) {
      if (!approval) return;
      const approvalId = approval.approval_id || approval.id || '';
      if (approvalId) {
        const existing = [...this.messages.querySelectorAll('[data-approval-id]')].find(el => el.dataset.approvalId === approvalId);
        if (existing) return;
      }
      const enriched = {
        ...approval,
        id: approvalId || approval.id,
        approval_id: approvalId || approval.approval_id,
        pending_count: pendingCount,
        _voAgentId: approval._voAgentId || this.getSelectedAgentId() || this.selectedAgentKey
      };
      this.hermesApprovalLastId = enriched.id || '';
      this.appendMessage(
        'assistant',
        '',
        Date.now(),
        [],
        {
          label: this.agentSelect.selectedOptions[0]?.textContent.trim() || 'Hermes',
          kind: 'agent',
          approval: enriched
        },
        []
      );
      this.scrollBottom();
    }

    startCodexApprovalPolling() {
      if (this.codexApprovalPollTimer) return;
      this.pollCodexApproval().catch(() => {});
      this.codexApprovalPollTimer = setInterval(() => {
        this.pollCodexApproval().catch(() => {});
      }, HERMES_APPROVAL_POLL_MS);
    }

    stopCodexApprovalPolling() {
      if (this.codexApprovalPollTimer) {
        clearInterval(this.codexApprovalPollTimer);
        this.codexApprovalPollTimer = null;
      }
      this.codexApprovalLastId = '';
    }

    async pollCodexApproval() {
      if (!this.isCodexSelected() || !this.isVisibleForPolling()) return;
      return this.runGuardedPoll('codex-approval', async () => {
        const fence = this.selectionFence();
        const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
        const res = await fetch('/api/codex/approval/pending?agentId=' + encodeURIComponent(agentId));
        const data = await res.json();
        if (fence !== this.selectionFence() || this.sessionSelectionPending || !this.isCodexSelected()) return;
        if (!data.ok || !data.pending) return;
        this.appendCodexPendingApproval({ ...data.pending, _voAgentId: agentId }, data.pending_count || 1);
      });
    }

    appendCodexPendingApproval(approval, pendingCount = 1) {
      if (!approval) return;
      const approvalId = approval.approval_id || approval.id || '';
      if (approvalId) {
        const existing = [...this.messages.querySelectorAll('[data-approval-id]')].find(el => el.dataset.approvalId === approvalId);
        if (existing) return;
      }
      const enriched = {
        ...approval,
        id: approvalId || approval.id,
        approval_id: approvalId || approval.approval_id,
        pending_count: pendingCount,
        provider: approval.provider || 'codex-app-server',
        _voAgentId: approval._voAgentId || this.getSelectedAgentId() || this.selectedAgentKey
      };
      this.codexApprovalLastId = enriched.id || '';
      this.appendMessage(
        'assistant',
        '',
        Date.now(),
        [],
        {
          label: this.agentSelect.selectedOptions[0]?.textContent.trim() || 'Codex',
          kind: 'agent',
          approval: enriched
        },
        []
      );
      this.scrollBottom();
    }

    async fetchSessionInfo() {
      if (!this.isVisibleForPolling()) return;
      if (!this.agentListLoaded && !this.agentSelect?.selectedOptions?.[0]?.dataset?.providerKind) return;
      const fence = this.selectionFence();
      const session = this.sessionKey;
      const stale = () => fence !== this.selectionFence() || session !== this.sessionKey || this.sessionSelectionPending;
      if (stale()) return;
      let gatewayContext = 0;
      try {
        // Targeted lookup avoids rebuilding the full sessions.list index.
        if (!this.isProviderAgentSelected()) {
          const res = await rpc('sessions.describe', { key: this.sessionKey });
          if (stale()) return;
          const s = res?.payload?.session;
          if (res.ok && s) {
            if (s.totalTokens > 0) this.contextUsed = s.totalTokens;
            if (s.contextTokens > 0) gatewayContext = s.contextTokens;
          }
        }
      } catch (e) {
        console.warn('[chat] sessions.describe failed:', e);
      }
      let serverContext = 0;
      try {
        // Pass current agent ID so server returns the correct configured model
        const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
        const qs = agentId ? `?agent=${encodeURIComponent(agentId)}` : '';
        const res = await fetch('/session-info' + qs);
        const data = await res.json();
        if (stale()) return;
        // Always use the configured model from the server — this reflects
        // what the agent is SET to use, not what was last used historically.
        // The gateway transcript model can be stale (from before a model change).
        this.applySessionMetrics(data);
        if (data.contextWindow) serverContext = data.contextWindow;
      } catch (e) {
        console.warn('[chat] /session-info failed:', e);
      }
      if (stale()) return;
      this.contextWindow = Math.max(gatewayContext, serverContext, this.contextWindow || 0);
      this.updateModelBar();
    }

    renderHistoryItems(items) {
      const merged = ChatEvents.mergeHistoryItems(items);
      // CH-27: render only the newest messages; older ones wait behind a
      // "Show older messages" button so long chats stay fast on phones.
      const hiddenCount = Math.max(0, merged.length - MAX_RENDERED_HISTORY_MESSAGES);
      this.nextHiddenItems = merged.slice(0, hiddenCount).map(item => ({ item }));
      this.replaceHistoryMessages(() => {
        this.liveThinkingEl = null;
        this.liveThinkingPre = null;
        this.liveThinkingRunId = '';
        for (const item of merged.slice(hiddenCount)) this.renderHistoryItem(item);
      });
    }

    renderHistoryItem(item) {
      const role = normalizeChatRole(item.role);
      const rendered = this.appendMessage(
        role,
        item.text || '',
        item.epochMs || item.ts || item.timestamp || Date.now(),
        normalizeChatMedia(item.media || item.attachments || []),
        item.meta || normalizeSenderMeta({}, role, this),
        item.tools || []
      );
      if (item.commentary && rendered) {
        this.markOpenClawCommentaryMessage(rendered, item);
        this.turnEvents.rememberCommentary(item);
      }
      return rendered;
    }

    // Keep the live DOM bounded for any render path. Rows beyond the cap are
    // detached (kept in memory) and come back with "Show older messages".
    windowHistoryDom() {
      if (!this.messages) return;
      const rows = [...this.messages.children].filter(el => el.classList.contains('chat-msg') && !el.classList.contains('chat-run-error'));
      const extra = rows.length - MAX_RENDERED_HISTORY_MESSAGES;
      if (extra > 0) {
        const detached = rows.slice(0, extra).map(node => { node.remove(); return { node }; });
        this.historyHiddenItems = [...(this.historyHiddenItems || []), ...detached];
      }
      this.renderOlderButton();
    }

    renderOlderButton() {
      if (!this.messages) return;
      let button = [...this.messages.children].find(el => el.classList.contains('chat-load-older'));
      const hidden = this.historyHiddenItems?.length || 0;
      if (!hidden) { button?.remove(); return; }
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-load-older';
        button.dataset.chatAction = 'load-older';
      }
      button.textContent = `Show older messages (${hidden})`;
      if (this.messages.firstChild !== button) this.messages.prepend(button);
    }

    showOlderMessages() {
      const hidden = this.historyHiddenItems || [];
      if (!hidden.length || !this.messages) return;
      const page = hidden.splice(Math.max(0, hidden.length - HISTORY_OLDER_PAGE));
      const fragment = document.createDocumentFragment();
      const previousTarget = this.renderTarget;
      this.renderTarget = fragment;
      try {
        for (const entry of page) {
          if (entry.node) fragment.appendChild(entry.node);
          else this.renderHistoryItem(entry.item);
        }
      } finally {
        this.renderTarget = previousTarget;
      }
      const before = this.messages.scrollHeight;
      const top = this.messages.scrollTop;
      this.followLatest = false;
      this.scrollTrackingSuspended = true;
      const button = [...this.messages.children].find(el => el.classList.contains('chat-load-older'));
      this.messages.insertBefore(fragment, button ? button.nextSibling : this.messages.firstChild);
      this.renderOlderButton();
      this.messages.scrollTop = top + (this.messages.scrollHeight - before);
      this.lastMessagesScrollTop = this.messages.scrollTop;
      this.scrollTrackingSuspended = false;
      this.updateScrollLatestButton();
    }

    providerHistoryItems(messages, progressMarker) {
      const output = [];
      for (const msg of (messages || [])) {
        const role = normalizeChatRole(msg.role);
        const ts = msg.epochMs || msg.ts || msg.timestamp || Date.now();
        if (role === 'assistant') {
          const meta = resolveMessageSender(msg, this);
          const isProgress = msg.ephemeral === progressMarker;
          // Provider history is already in transcript order. Preserve each
          // message boundary and only order the blocks inside that message.
          // This matters when a runtime reuses one timestamp for a whole turn.
          if (msg.thinking) {
            output.push({
              role: 'assistant',
              text: '',
              thinking: msg.thinking,
              ts,
              meta: { ...meta, thinking: msg.thinking, reasoningTokens: msg.reasoningTokens || 0 }
            });
          }
          if (msg.commentary) {
            output.push({ role: 'assistant', text: msg.commentary, ts, meta });
          }
          normalizeHermesTools(msg.tools || [], !isProgress).forEach((tool) => {
            output.push({ role: 'assistant', text: '', tools: [tool], ts, meta });
          });
          if (msg.text || msg.approval) {
            output.push({
              role: 'assistant',
              text: msg.text || '',
              ts,
              meta: { ...meta, approval: msg.approval || null },
              media: msg.attachments || []
            });
          }
          continue;
        }
        if (msg.text || msg.attachments?.length) {
          output.push({
            role,
            text: msg.text || '',
            ts,
            media: msg.attachments || [],
            meta: resolveMessageSender(msg, this),
            tools: []
          });
        }
      }
      return output;
    }

    openClawHistoryItems(messages) {
      const items = [];
      for (const msg of (messages || [])) {
        const rawRole = msg?.role || msg?.message?.role || '';
        const role = normalizeChatRole(rawRole);
        let text = extractText(msg) || (typeof msg.content === 'string' ? msg.content : '');
        const media = extractMedia(msg, text);
        let tools = extractToolItems(msg);
        const persistedCommentary = ChatEvents.openClawStreamFallbackItem(msg, text, rawRole);
        if (persistedCommentary) {
          items.push({
            ...persistedCommentary,
            media: [],
            tools: [],
            ts: msg.timestamp || msg.ts || msg.message?.timestamp || null,
            meta: normalizeSenderMeta({}, 'assistant', this)
          });
          continue;
        }
        if (isToolResultRole(rawRole)) {
          if (!tools.length && text) {
            tools = [{
              id: msg?.toolCallId || msg?.message?.toolCallId || '',
              name: msg?.name || msg?.message?.name || 'tool result',
              status: msg?.error || msg?.message?.error ? 'error' : 'done',
              result: text,
              error: msg?.error || msg?.message?.error || ''
            }];
          }
          text = '';
        }
        if (!text && !media.length && !tools.length) continue;
        items.push({
          role,
          text,
          media,
          tools,
          ts: msg.timestamp || msg.ts || msg.message?.timestamp || null,
          meta: role === 'assistant' ? normalizeSenderMeta({}, 'assistant', this) : resolveMessageSender(msg, this)
        });
      }
      return items;
    }

    async fetchRecoveredActivityItems() {
      if (!this.isVisibleForPolling()) return [];
      try {
        const url = '/api/session-activity?sessionKey=' + encodeURIComponent(this.sessionKey) + '&limit=80';
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        if (!this.isVisibleForPolling() || !data.ok || !Array.isArray(data.messages)) return [];
        return data.messages.map(msg => {
          if (msg.source === 'codex-commentary' && msg.id) this.rememberCommentaryKey(String(msg.id));
          return {
            id: msg.id || '',
            itemId: msg.source === 'codex-commentary' ? (msg.id || '') : '',
            runId: msg.runId || '',
            source: msg.source || '',
            commentary: msg.source === 'codex-commentary',
            role: normalizeChatRole(msg.role || 'assistant'),
            text: msg.text || '',
            tools: normalizeHistoricalTools(msg.tools || []),
            ts: msg.epochMs || msg.ts || Date.now(),
            meta: normalizeSenderMeta({}, 'assistant', this),
            media: msg.media || []
          };
        });
      } catch (e) {
        console.warn('[chat] recovered activity load failed:', e);
        return [];
      }
    }

    scheduleCommentarySync(runId) {
      if (this.commentarySyncTimer) return;
      const wait = Math.max(0, COMMENTARY_SYNC_MIN_MS - (Date.now() - this.commentarySyncAt));
      this.commentarySyncTimer = setTimeout(() => {
        this.commentarySyncTimer = null;
        this.syncOpenClawCommentary(runId).catch(() => {});
      }, wait);
    }

    rememberCommentaryKey(key) {
      this.seenOpenClawCommentary.add(key);
      // CH-27: bounded dedupe memory for very long sessions.
      while (this.seenOpenClawCommentary.size > MAX_SEEN_COMMENTARY_KEYS) {
        this.seenOpenClawCommentary.delete(this.seenOpenClawCommentary.values().next().value);
      }
    }

    async syncOpenClawCommentary(runId, { force = false } = {}) {
      if (!runId || !this.isVisibleForPolling() || this.isProviderAgentSelected()) return;
      if (this.commentarySyncInFlight) {
        if (!force) return;
        await this.commentarySyncInFlight.catch(() => {});
      }
      const pass = this.fetchOpenClawCommentary(runId);
      this.commentarySyncInFlight = pass;
      try {
        await pass;
      } finally {
        if (this.commentarySyncInFlight === pass) this.commentarySyncInFlight = null;
      }
    }

    async fetchOpenClawCommentary(runId) {
      this.commentarySyncAt = Date.now();
      try {
        const params = new URLSearchParams({
          sessionKey: this.sessionKey,
          runId: String(runId),
          commentaryOnly: '1',
          limit: '80'
        });
        const res = await fetch('/api/session-activity?' + params.toString());
        if (!res.ok) return;
        const data = await res.json();
        if (!data.ok || !Array.isArray(data.messages)) return;
        for (const msg of data.messages) {
          if (msg.source !== 'codex-commentary' || !String(msg.text || '').trim()) continue;
          const key = String(msg.id || [msg.runId || runId, msg.epochMs || msg.ts || '', msg.text].join(':'));
          if (this.seenOpenClawCommentary.has(key)) continue;
          this.rememberCommentaryKey(key);
          this.applyTurnEvent({
            kind: 'commentary.update',
            runId: msg.runId || runId,
            itemId: msg.id || key,
            text: msg.text,
            ts: msg.epochMs || msg.ts || 0
          });
        }
      } catch (e) {
        console.warn('[chat] safe commentary recovery failed:', e);
      }
    }

    queueOpenClawEvent(eventName, payload) {
      this.openClawEventQueue = this.openClawEventQueue
        .catch(() => {})
        .then(async () => {
          const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
          const stream = payload?.stream || data.stream || '';
          const runId = payload?.runId || data.runId || this.currentRunId || '';
          const isToolEvent = eventName === 'agent' && (
            stream === 'tool' ||
            (stream === 'item' && (data.kind === 'command' || data.kind === 'tool')) ||
            ['tool_start', 'tool_end', 'tool_result'].includes(payload?.type)
          );
          const isFinalChat = eventName === 'chat' && ['final', 'done', 'error', 'aborted'].includes(payload?.state);
          // CH-28: tool events no longer wait on an HTTP round trip each.
          // Commentary is synced in the background (at most every 1.5 s) and
          // once, in order, before the final answer.
          if (isToolEvent && runId) this.scheduleCommentarySync(runId);
          if (isFinalChat && runId) {
            if (this.commentarySyncTimer) { clearTimeout(this.commentarySyncTimer); this.commentarySyncTimer = null; }
            await this.syncOpenClawCommentary(runId, { force: true });
          }
          if (eventName === 'chat') return this.handleChatEvent(payload);
          if (eventName === 'agent') return this.handleAgentEvent(payload);
          if (eventName === 'session.message') return this.handleSessionMessageEvent(payload);
        });
      return this.openClawEventQueue;
    }

    // Single-flight history loading per window (CH-18): overlapping calls
    // share one request; a call made while one is running asks for exactly
    // one more pass afterwards, and a response made stale by session-key
    // adoption is retried instead of leaving the pane empty.
    async loadHistory(opts = {}) {
      if (!this.isVisibleForPolling()) {
        this.markHistoryDirty();
        return;
      }
      if (this.sessionSelectionPending) return;
      // History needs the real agent option (provider kind, session base);
      // the static placeholder option must never drive a request (CH-18).
      if (!this.agentListLoaded && !this.agentSelect?.selectedOptions?.[0]?.dataset?.providerKind) { this.markHistoryDirty(); return; }
      if (this.historyLoad) {
        this.historyLoad.again = true;
        if (opts.recoverFinal) this.historyLoad.recoverFinal = true;
        return this.historyLoad.promise;
      }
      const state = { again: false, recoverFinal: !!opts.recoverFinal, promise: null };
      this.historyLoad = state;
      state.promise = (async () => {
        try {
          let result = await this.loadHistoryOnce(opts);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (!(state.again || result === 'stale-adopted' || result === 'retry')) break;
            if (!this.isVisibleForPolling() || this.sessionSelectionPending) break;
            if (result === 'retry') await new Promise(resolve => setTimeout(resolve, 350));
            const nextOpts = { ...opts, recoverFinal: state.recoverFinal, afterTerminal: result === 'retry' };
            state.again = false;
            result = await this.loadHistoryOnce(nextOpts);
          }
          return result;
        } finally {
          if (this.historyLoad === state) this.historyLoad = null;
        }
      })();
      return state.promise;
    }

    showHistoryStatus(kind, text = '') {
      if (!this.messages) return;
      this.messages.querySelectorAll('.chat-history-status').forEach(el => el.remove());
      if (!kind) return;
      const row = document.createElement('div');
      row.className = 'chat-history-status ' + kind;
      row.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      const label = document.createElement('span');
      label.textContent = text;
      row.appendChild(label);
      if (kind === 'error') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'chat-history-retry';
        retry.dataset.chatAction = 'reload-history';
        retry.textContent = 'Retry';
        row.appendChild(retry);
      }
      if (kind === 'error') this.messages.appendChild(row);
      else this.messages.prepend(row);
    }

    hasConversationContent() {
      return !!this.messages?.querySelector('.chat-msg:not(.system), .chat-run-error');
    }

    renderEmptyState() {
      if (!this.messages || this.hasConversationContent()) return;
      this.messages.querySelector('.chat-empty-state')?.remove();
      const label = (this.agentSelect?.selectedOptions?.[0]?.textContent || '').trim() || 'this agent';
      const name = label.replace(/^\S+\s+/, '') || label;
      const box = document.createElement('div');
      box.className = 'chat-empty-state';
      const title = document.createElement('div');
      title.className = 'chat-empty-title';
      title.textContent = 'No messages yet';
      const hint = document.createElement('div');
      hint.className = 'chat-empty-hint';
      hint.textContent = `Say hi to ${name}. Try one of these:`;
      const chips = document.createElement('div');
      chips.className = 'chat-empty-suggestions';
      for (const suggestion of ['What are you working on right now?', 'Give me a short status update.', 'What can you help me with?']) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chat-suggestion';
        chip.dataset.chatAction = 'suggest';
        chip.dataset.text = suggestion;
        chip.textContent = suggestion;
        chips.appendChild(chip);
      }
      box.append(title, hint, chips);
      this.messages.appendChild(box);
    }

    async loadHistoryOnce(opts = {}) {
      if (!this.isVisibleForPolling()) {
        this.markHistoryDirty();
        return 'hidden';
      }
      if (this.sessionSelectionPending) return 'stale';
      const selectionFence = this.selectionFence();
      const requestSessionKey = this.sessionKey;
      const historyRefreshSeq = ++this.historyRefreshSeq;
      const terminalSeqAtStart = this.liveTerminalSeq;
      const historyRequestIsStale = () => historyRefreshSeq !== this.historyRefreshSeq ||
        selectionFence !== this.selectionFence() || requestSessionKey !== this.sessionKey ||
        this.sessionSelectionPending || !this.isVisibleForPolling();
      // Only a session-key adoption inside the same selection is retried;
      // a real selection change loads its own history.
      const staleResult = () => (historyRefreshSeq === this.historyRefreshSeq && selectionFence === this.selectionFence() &&
        !this.sessionSelectionPending && this.isVisibleForPolling() && requestSessionKey !== this.sessionKey) ? 'stale-adopted' : 'stale';
      // CH-20: a live final that lands while this request is in flight is
      // newer than the response. Do not paint the older snapshot over it;
      // ask again once the transcript has caught up.
      const finalArrivedMeanwhile = () => !opts.afterTerminal && this.liveTerminalSeq !== terminalSeqAtStart;
      const loadingTimer = setTimeout(() => {
        if (!historyRequestIsStale() && !this.hasConversationContent()) this.showHistoryStatus('loading', 'Loading conversation…');
      }, 180);
      this.historyState = 'loading';
      try {
        if (this.isServeHermesSelected()) {
          return await this.loadServeHistory({ historyRequestIsStale, staleResult, finalArrivedMeanwhile });
        }
        if (this.isGenericProviderSelected()) {
          const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
          const selectedSessionId = this.selectedProviderSessionId();
          const selectedHistorySessionId = this.selectedProviderHistorySessionId();
          let historyUrl = '/api/provider-history?agentId=' + encodeURIComponent(agentId);
          if (selectedHistorySessionId) historyUrl += '&sessionId=' + encodeURIComponent(selectedHistorySessionId);
          const res = await fetch(historyUrl);
          const data = await res.json();
          if (historyRequestIsStale()) { this.markHistoryDirty(); return staleResult(); }
          if (finalArrivedMeanwhile()) return 'retry';
          if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
          if (data.sessionKey && (
            !selectedHistorySessionId
            || data.requestedSessionId === selectedHistorySessionId
            || data.activeSessionId === selectedHistorySessionId
          )) this.setSelectedSessionKey(data.sessionKey);
          this.startProviderHistoryPolling();
          this.providerHistorySignature = this.providerHistorySignatureFor(data.messages || []);
          this.replaceHistoryMessages(() => {
            this.liveThinkingEl = null;
            this.liveThinkingPre = null;
            this.liveThinkingRunId = '';
            for (const msg of (data.messages || [])) {
              this.applySessionMetrics(msg);
              const tools = normalizeHermesTools(msg.tools || [], msg.ephemeral !== 'provider-progress');
              const meta = msg.role === 'assistant'
                ? { ...resolveMessageSender(msg, this), thinking: msg.thinking || '', approval: msg.approval || null, reasoningTokens: msg.reasoningTokens || 0 }
                : { label: 'You', kind: 'human' };
              if (msg.text || msg.thinking || msg.approval || tools.length) {
                const splitTools = msg.role === 'assistant' && msg.ephemeral !== 'provider-progress' && msg.text && tools.length;
                if (splitTools) tools.forEach((tool, idx) => this.appendMessage('assistant', '', (msg.ts || Date.now()) + idx, [], resolveMessageSender(msg, this), [tool]));
                this.appendMessage(msg.role, msg.text || '', msg.ts || Date.now(), normalizeChatMedia(msg.attachments || []), meta, splitTools ? [] : tools);
              }
            }
          });
          this.scrollBottomAfterLayout();
          this.historyDirty = false;
          this.afterHistoryRendered(data.messages || []);
          return 'rendered';
        }
        if (this.isNativeHermesSelected() || this.isCodexSelected() || this.isClaudeCodeSelected()) {
          const isHermes = this.isNativeHermesSelected();
          const isCodex = this.isCodexSelected();
          const isClaudeCode = this.isClaudeCodeSelected();
          const providerPath = isHermes ? 'hermes' : (isClaudeCode ? 'claude-code' : 'codex');
          const progressMarker = isHermes ? 'hermes-progress' : (isClaudeCode ? 'claude-code-progress' : 'codex-progress');
          if (isHermes) this.startHermesApprovalPolling();
          if (isCodex) this.startCodexApprovalPolling();
          const historyParams = new URLSearchParams({ agentId: this.getSelectedAgentId() || this.selectedAgentKey });
          const selectedSessionId = this.selectedProviderSessionId();
          if (selectedSessionId) historyParams.set('sessionId', selectedSessionId);
          const res = await fetch('/api/' + providerPath + '/history?' + historyParams.toString());
          const data = await res.json();
          if (historyRequestIsStale()) { this.markHistoryDirty(); return staleResult(); }
          if (finalArrivedMeanwhile()) return 'retry';
          if (!data.ok || !Array.isArray(data.messages)) throw new Error(data.error || res.statusText || 'History unavailable');
          if (data.sessionKey && (!selectedSessionId || data.requestedSessionId === selectedSessionId)) {
            // Adopting the provider's own session id for this same selection
            // is not a selection change; keep rendering this response.
            this.setSelectedSessionKey(data.sessionKey);
          }
          this.applySessionMetrics(data);
          this.renderHistoryItems(this.providerHistoryItems(data.messages, progressMarker));
          this.scrollBottomAfterLayout();
          this.historyDirty = false;
          this.afterHistoryRendered(data.messages);
          if (isHermes) await this.pollHermesApproval().catch(() => {});
          if (isCodex) await this.pollCodexApproval().catch(() => {});
          return 'rendered';
        }
        const res = await rpc('chat.history', { sessionKey: this.sessionKey, limit: 500 });
        if (historyRequestIsStale()) { this.markHistoryDirty(); return staleResult(); }
        if (finalArrivedMeanwhile()) return 'retry';
        if (!res.ok || !Array.isArray(res.payload?.messages)) throw new Error(res.error?.message || res.error?.code || 'History unavailable');
        {
          const messages = res.payload.messages;
          const recovered = await this.fetchRecoveredActivityItems();
          if (historyRequestIsStale()) { this.markHistoryDirty(); return staleResult(); }
          if (finalArrivedMeanwhile()) return 'retry';
          this.renderHistoryItems([...this.openClawHistoryItems(messages), ...recovered]);
          const lastMeaningful = [...messages].reverse().find(m => {
            const t = extractText(m) || (typeof m.content === 'string' ? m.content : '');
            return t || extractToolItems(m).length;
          });
          const role = lastMeaningful?.role || lastMeaningful?.message?.role || '';
          if (opts.recoverFinal && role === 'assistant') {
            this.streamingMsg = null;
            this.pendingStreamContent = '';
            this.liveToolCards.clear();
            this.currentRunId = null;
            this.turnEvents.reset();
            this.removeTypingIndicator();
            this.clearActivityFeed();
            this.stopRecoveryWatchdog();
            const lastAt = ChatEvents.timestampMs(lastMeaningful?.timestamp || lastMeaningful?.ts || lastMeaningful?.message?.timestamp);
            if (['sending', 'running'].includes(this.runState?.state) && (!this.lastSend || !lastAt || lastAt >= this.lastSend.at - 2000)) this.clearRunState();
          }
          this.scrollBottomAfterLayout();
          this.historyDirty = false;
          this.afterHistoryRendered(messages);
          return 'rendered';
        }
      } catch (e) {
        if (historyRequestIsStale()) return staleResult();
        console.warn('Failed to load history:', e);
        this.historyState = 'error';
        if (this.isProviderAgentSelected()) this.setProviderHealth('error');
        this.showHistoryStatus('error', 'Could not load this conversation. ' + (friendlyRunError(e).title));
        return 'error';
      } finally {
        clearTimeout(loadingTimer);
        if (this.historyState === 'loading') this.historyState = 'idle';
        if (!historyRequestIsStale()) this.messages?.querySelectorAll('.chat-history-status.loading').forEach(el => el.remove());
      }
    }

    afterHistoryRendered(messages) {
      this.historyState = 'ready';
      this.showHistoryStatus(null);
      if (this.isProviderAgentSelected()) this.setProviderHealth('ok');
      if (!Array.isArray(messages) || !messages.length) this.renderEmptyState();
      // OpenClaw chats re-show waiting approvals / questions and follow new ones (serve chats do this in loadServeHistory).
      if (!this.isServeHermesSelected() && this.usesChatStream() && this.chatStreamKey() !== this.chatStream?.key) this.reattachChat().catch(() => {});
    }

    async newSession() {
      const agentName = this.agentSelect.selectedOptions[0]?.textContent.trim() || 'this agent';
      const ok = await confirmAction({ title: 'Start a new session?', body: `Start a new session with ${agentName}. The current session stays saved in Sessions.`, okLabel: 'Start new session' });
      if (!ok) return;
      try {
        await this.createSessionFromPanel({ skipConfirm: true });
      } catch (e) {
        this.appendSystem('Could not start a new session: ' + e.message);
      }
    }

    // ── Sessions panel (hamburger) ────────────────────────────────────────
    toggleSessionsPanel(force) {
      const next = typeof force === 'boolean' ? force : !this.sessionsPanelOpen;
      this.sessionsPanelOpen = next;
      if (next) this.root.dispatchEvent(new CustomEvent('vw:chat-drawer-open', { detail: { drawer: 'history' } }));
      if (this.sessionsPanel) this.sessionsPanel.inert = !next;
      this.historyRail?.setAttribute('aria-expanded', String(next));
      this.root.classList.toggle('chat-history-open', next);
      this.sessionsPanel?.classList.toggle('open', next);
      this.sessionsToggleBtn?.classList.toggle('active', next);
      if (next) {
        this.refreshSessionsList();
        if (!this.sessionsRefreshTimer) {
          this.sessionsRefreshTimer = setInterval(() => {
            if (this.sessionsPanelOpen) this.refreshSessionsList();
          }, 15000);
        }
      } else if (this.sessionsRefreshTimer) {
        clearInterval(this.sessionsRefreshTimer);
        this.sessionsRefreshTimer = null;
      }
    }

    async refreshSessionsList({ showLoading = false } = {}) {
      if (!this.sessionsListEl || this.sessionSelectionPending) return;
      const selectionFence = this.selectionFence();
      const requestSessionKey = this.sessionKey;
      const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
      if (!agentId) return;
      const requestSeq = ++this.sessionsRefreshSeq;
      const requestAgentId = String(agentId);
      if (showLoading) {
        this.currentSessions = [];
        this.sessionsListEl.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'chat-sessions-empty';
        div.textContent = 'Loading sessions...';
        this.sessionsListEl.appendChild(div);
      }
      let data = null;
      try {
        const res = await fetch('/api/office/chat-sessions?agentId=' + encodeURIComponent(agentId) + '&limit=40');
        data = await res.json();
      } catch (e) {
        if (requestSeq !== this.sessionsRefreshSeq || selectionFence !== this.selectionFence() || requestSessionKey !== this.sessionKey || this.sessionSelectionPending) return;
        this.sessionsListEl.innerHTML = '<div class="chat-sessions-empty">Sessions unavailable</div>';
        return;
      }
      const currentAgentId = String(this.getSelectedAgentId() || this.selectedAgentKey || '');
      if (requestSeq !== this.sessionsRefreshSeq || requestAgentId !== currentAgentId || selectionFence !== this.selectionFence() || requestSessionKey !== this.sessionKey || this.sessionSelectionPending) return;
      if (!data?.ok || !Array.isArray(data.sessions)) {
        const err = (data && data.error) ? String(data.error) : 'Sessions unavailable';
        this.sessionsListEl.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'chat-sessions-empty';
        div.textContent = err.slice(0, 200);
        this.sessionsListEl.appendChild(div);
        return;
      }
      this.currentSessions = data.sessions;
      this.renderSessionsList(data);
    }

    activeSessionIdForPanel() {
      if (this.getSelectedProviderKind() === 'openclaw' && !this.isProviderAgentSelected()) return this.sessionKey;
      if (this.isPendingProviderSession()) return '@pending';
      const selected = this.selectedProviderSessionId();
      if (selected) return selected;
      const active = this.currentSessions.find(s => s.active);
      return active ? active.id : '';
    }

    renderSessionsList(data) {
      const listEl = this.sessionsListEl;
      if (!listEl) return;
      if (!this.currentSessions.length) {
        const empty = document.createElement('div');
        empty.className = 'chat-sessions-empty';
        empty.textContent = 'No sessions yet';
        listEl.replaceChildren(empty);
        return;
      }
      const selectedId = this.activeSessionIdForPanel();
      // Agents with a server manifest get Hermes-style marks: dot, age, Rename (design 4.2 "Session picker").
      const view = this.serverCapsView();
      const nowMs = Date.now();
      const existingItems = new Map(
        [...listEl.querySelectorAll('.chat-session-item[data-session-id]')]
          .map((item) => [item.dataset.sessionId, item])
      );
      const orderedItems = [];
      for (const session of this.currentSessions) {
        const sessionId = String(session.id);
        const item = existingItems.get(sessionId) || document.createElement('div');
        item.className = 'chat-session-item';
        item.dataset.sessionId = sessionId;
        if (session.id === selectedId || (!selectedId && session.active && data.providerKind !== 'openclaw')) item.classList.add('selected');
        const renderKey = JSON.stringify([
          session.title || session.id,
          session.preview || '',
          !!session.liveMode,
          !!session.active,
          session.updatedAt || '',
          session.messageCount || 0,
          session.toolCallCount || 0,
          session.model || '',
          !!session.deletable,
          view ? this.sessionMark(session) : '',
          !!view?.showRename,
          view && globalThis.ChatCards?.ageText ? ChatCards.ageText(session.updatedAt, nowMs) : ''
        ]);
        if (item._chatSessionRenderKey !== renderKey) {
          item._chatSessionRenderKey = renderKey;
          const content = [];
          const title = document.createElement('div');
          title.className = 'cs-title';
          title.textContent = cleanSessionTitle(session.title) || cleanSessionTitle(session.preview).slice(0, 80) || 'Untitled session';
          title.title = title.textContent;
          const mark = view ? this.sessionMark(session) : '';
          if (mark) {
            const dot = document.createElement('span');
            dot.className = 'cs-dot';
            dot.dataset.state = mark;
            const label = mark === 'needs' ? 'Waiting for you' : 'Working';
            dot.title = label;
            dot.setAttribute('role', 'img');
            dot.setAttribute('aria-label', label);
            title.prepend(dot);
          }
          content.push(title);

          if (session.preview) {
            const preview = document.createElement('div');
            preview.className = 'cs-preview';
            preview.textContent = cleanSessionTitle(session.preview);
            content.push(preview);
          }

          const meta = document.createElement('div');
          meta.className = 'cs-meta';
          if (session.liveMode) {
            const live = document.createElement('span');
            live.className = 'cs-live-badge';
            live.textContent = session.active ? 'LIVE' : 'Live Mode';
            meta.appendChild(live);
          }
          if (session.updatedAt) {
            const when = document.createElement('span');
            const age = view && globalThis.ChatCards?.ageText ? ChatCards.ageText(session.updatedAt, nowMs) : '';
            when.textContent = age || formatSessionTimestamp(session.updatedAt);
            if (age) {
              when.className = 'cs-age';
              when.title = formatSessionTimestamp(session.updatedAt);
            }
            meta.appendChild(when);
          }
          if (Number(session.messageCount || 0) > 0) {
            const count = document.createElement('span');
            count.textContent = `${Number(session.messageCount)} messages`;
            meta.appendChild(count);
          }
          if (Number(session.toolCallCount || 0) > 0) {
            const tools = document.createElement('span');
            tools.textContent = `${Number(session.toolCallCount)} tools`;
            meta.appendChild(tools);
          }
          if (session.model) {
            const model = document.createElement('span');
            model.textContent = String(session.model);
            meta.appendChild(model);
          }
          if (meta.childNodes.length) content.push(meta);

          if (view?.showRename) {
            const rename = document.createElement('button');
            rename.type = 'button';
            rename.className = 'chat-session-rename';
            rename.title = 'Rename chat';
            rename.setAttribute('aria-label', 'Rename chat');
            rename.textContent = '✎';
            content.push(rename);
          }

          if (session.deletable) {
            const del = document.createElement('button');
            del.className = 'chat-session-delete';
            del.type = 'button';
            del.title = 'Delete session';
            del.setAttribute('aria-label', ('Delete session ' + (cleanSessionTitle(session.title) || '')).trim());
            del.innerHTML = '<svg class="vo-icon" aria-hidden="true" focusable="false"><use href="#i-trash"/></svg>';
            content.push(del);
          }
          item.replaceChildren(...content);
        }
        orderedItems.push(item);
      }
      listEl.replaceChildren(...orderedItems);
    }

    async switchToSession(session) {
      // One chat is never in two windows: a chat another window shows comes forward there.
      const shownElsewhere = session?.sessionKey && session.sessionKey !== this.sessionKey
        ? windowManager?.holder(`${this.selectedAgentKey}\u0000${session.sessionKey}`, this.slotId) : null;
      if (shownElsewhere) {
        this.toggleSessionsPanel(false);
        windowManager.show(shownElsewhere);
        return;
      }
      const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
      const selectionFence = this.beginSessionSelection();
      const isCurrent = () => selectionFence === this.selectionFence();
      try {
        if (this.getSelectedProviderKind() === 'openclaw' && !this.isProviderAgentSelected()) {
          this.sessionSelectionPending = false;
          if (session.sessionKey && session.sessionKey !== this.sessionKey) {
            this.sessionKey = session.sessionKey;
            saveChatSelection(this.slotId, { selectedAgentKey: this.selectedAgentKey, sessionKey: this.sessionKey });
            this.resetConversation('Switched to session: ' + (cleanSessionTitle(session.title) || session.sessionKey));
            await this.loadHistory();
            if (!isCurrent()) return;
            this.fetchSessionInfo();
          }
          this.syncTaskProgress();
          this.refreshSessionsList();
          return;
        }
        const res = await fetch('/api/office/chat-sessions/switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, sessionId: session.id })
        });
        const data = await res.json();
        if (!isCurrent()) return;
        if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
        this.sessionSelectionPending = false;
        this.setSelectedSessionKey(data.sessionKey || session.sessionKey || `${this.getSelectedProviderKind()}:${this.getSelectedProviderProfile()}:${data.sessionId || session.id}`);
        this.resetConversation('Switched to session: ' + (cleanSessionTitle(session.title) || session.id));
        // CH-31: switched-to history uses the provider's progress marker and
        // the same empty state as a normal load.
        const nativeConfig = this.isGenericProviderSelected() ? null : NATIVE_PROVIDER_UI[this.getSelectedProviderKind()];
        if (Array.isArray(data.messages) && !this.isServeHermesSelected()) {
          this.renderHistoryItems(this.providerHistoryItems(data.messages, nativeConfig?.progressMarker || 'provider-progress'));
          this.afterHistoryRendered(data.messages);
        } else {
          // A universal chat reads its history, state and stream for the new session.
          await this.loadHistory();
        }
        if (!isCurrent()) return;
        this.fetchSessionInfo();
        this.refreshSessionsList();
      } catch (e) {
        if (!isCurrent()) return;
        this.sessionSelectionPending = false;
        this.syncTaskProgress();
        this.appendSystem('Session switch failed: ' + e.message);
      }
    }

    async createSessionFromPanel({ skipConfirm = false } = {}) {
      const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
      const agentName = this.agentSelect?.selectedOptions?.[0]?.textContent.trim() || agentId;
      if (!skipConfirm && !(await confirmAction({ title: 'Start a new session?', body: `Start a new session with ${agentName}. The current session stays saved.`, okLabel: 'Start new session' }))) return;
      const selectionFence = this.beginSessionSelection();
      const isCurrent = () => selectionFence === this.selectionFence();
      try {
        const body = { agentId };
        if (this.getSelectedProviderKind() === 'openclaw' && !this.isProviderAgentSelected()) body.sessionKey = this.sessionKey;
        const res = await fetch('/api/office/chat-sessions/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!isCurrent()) return;
        if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
        this.sessionSelectionPending = false;
        if (data.sessionKey) this.setSelectedSessionKey(data.sessionKey);
        // `hermes serve` answers without a key (its first message creates the chat): leave the
        // previous chat for a pending one, so the next message starts a new Hermes session.
        else if (data.newSessionPending && !this.isNativeOpenClawSelected()) this.setSelectedSessionKey(this.newPendingSessionKey());
        this.resetConversation('New session started — the previous session is still saved');
        await this.loadHistory();
        if (!isCurrent()) return;
        this.fetchSessionInfo();
        this.refreshSessionsList();
      } catch (e) {
        if (!isCurrent()) return;
        this.sessionSelectionPending = false;
        this.syncTaskProgress();
        this.appendSystem('Could not start a new session: ' + e.message);
      }
    }

    /** Rename a chat on the agent's platform (`caps.sessionRename`, POST /api/agent-chat/session). */
    async renameSessionFromPanel(session) {
      const current = cleanSessionTitle(session.title) || '';
      const title = await promptAction({ title: 'Rename chat', label: 'Name', value: current });
      if (title === null) return;
      const next = String(title).trim().slice(0, 120);
      if (!next || next === current) return;
      const { res, data } = await this.chatFetch('/api/agent-chat/session', null, {
        agent: this.chatAgentId(), session: String(session.key || session.id), op: 'rename', title: next
      }).catch((error) => ({ res: { ok: false, status: 0, statusText: error.message }, data: {} }));
      if (!res.ok || data.ok === false) {
        this.appendSystem('Rename failed: ' + [data.message || data.error || res.statusText || 'error', data.fix].filter(Boolean).join(' '));
        return;
      }
      session.title = next;
      this.renderSessionsList({});
      this.refreshSessionsList().catch(() => {});
    }

    /** Drawer marks (design 4.2): blue = working, orange = waiting for you; from presence frames and this window. */
    sessionMark(session) {
      const id = String(session?.key || session?.id || '');
      const own = id && (id === this.agentChatSession() || id === this.activeSessionIdForPanel());
      if (own) {
        const waiting = this.waitingCards();
        if (waiting.blocking || waiting.clarify.length) return 'needs';
        if (this.isRunActive()) return 'working';
      }
      const seen = this.sessionActivity?.get(id);
      if (seen?.needs) return 'needs';
      if (seen?.working || session?.working === true) return 'working';
      return '';
    }

    /** `agent.activity` frames: which chats of this agent are working right now (Desktop, Telegram, other windows). */
    applyAgentActivity(event) {
      if (!event || typeof event !== 'object') return;
      if (!this.sessionActivity) this.sessionActivity = new Map();
      const keys = Array.isArray(event.keys) ? event.keys : (Array.isArray(event.sessions) ? event.sessions : null);
      if (keys) {
        const live = new Set(keys.map(k => String(k && typeof k === 'object' ? (k.key || k.id || '') : k)).filter(Boolean));
        for (const [key, mark] of this.sessionActivity) if (!live.has(key)) this.sessionActivity.set(key, { ...mark, working: false });
        for (const key of live) this.sessionActivity.set(key, { ...(this.sessionActivity.get(key) || {}), working: true });
      } else if (event.sessionKey) {
        const key = String(event.sessionKey);
        const mark = { ...(this.sessionActivity.get(key) || {}), working: event.active === true };
        if (typeof event.waiting === 'boolean') mark.needs = event.waiting;
        this.sessionActivity.set(key, mark);
      } else if (event.active === false) {
        for (const [key, mark] of this.sessionActivity) this.sessionActivity.set(key, { ...mark, working: false });
      }
      if (this.sessionsPanelOpen && this.currentSessions.length) this.renderSessionsList({});
    }

    /** Live chat titles (`caps.titles`): a `native {op:'title'}` frame renames the open chat in the drawer. */
    applyLiveTitle(event) {
      const view = this.serverCapsView();
      const title = String(event?.text || event?.title || '').trim().slice(0, 120);
      if (!view?.liveTitles || !title) return;
      const id = this.agentChatSession();
      const session = this.currentSessions.find(s => String(s.key || s.id) === id);
      if (session && session.title !== title) {
        session.title = title;
        if (this.sessionsPanelOpen) this.renderSessionsList({});
      }
      this.liveTitle = title;
    }

    async deleteSessionFromPanel(session) {
      const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
      const sessionTitle = cleanSessionTitle(session.title) || session.id;
      if (!(await confirmAction({ title: 'Delete this session?', body: `"${sessionTitle}" will be deleted. This cannot be undone.`, okLabel: 'Delete', danger: true }))) return;
      const selectionFence = this.selectionFence();
      const requestSessionKey = this.sessionKey;
      const isCurrent = () => selectionFence === this.selectionFence() && requestSessionKey === this.sessionKey && !this.sessionSelectionPending;
      try {
        const res = await fetch('/api/office/chat-sessions/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, sessionId: session.id })
        });
        const data = await res.json();
        if (!isCurrent()) return;
        if (!res.ok || !data.ok) throw new Error(data.error || res.statusText);
        const deletingCurrent = session.sessionKey === this.sessionKey
          || session.id === this.selectedProviderSessionId()
          || (this.getSelectedProviderKind() === 'openclaw' && session.id === this.sessionKey)
          || (!this.selectedProviderSessionId() && !this.isPendingProviderSession() && session.active);
        if (deletingCurrent) {
          this.setSelectedSessionKey(this.selectedProviderBaseSessionKey());
          this.resetConversation('Session deleted');
          await this.loadHistory();
        }
        this.refreshSessionsList();
      } catch (e) {
        if (!isCurrent()) return;
        this.appendSystem('Delete failed: ' + e.message);
      }
    }

    // CH-25: size check before reading a file into memory, one entry point
    // for the file picker, paste and drag-and-drop.
    addAttachmentFiles(files) {
      const list = Array.from(files || []).filter(Boolean);
      // Agents with a manifest: its own limits (pictures only, files per message, size);
      // pictures over 3 MB are shrunk to 2048 px instead of refused (design 4.2 "Attachments").
      const view = globalThis.ChatCaps ? this.serverCapsView() : null;
      let accepted = 0;
      for (const file of list) {
        let shrink = false;
        if (view) {
          const check = ChatCaps.checkAttachment(view, file, this.pendingAttachments.length + accepted);
          if (!check.ok) {
            this.appendSystem(`${file.name || 'This file'} was not attached: ${check.reason}`);
            continue;
          }
          shrink = !!check.shrink;
        } else if (file.size > MAX_ATTACHMENT_BYTES) {
          this.appendSystem(`${file.name || 'This file'} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_ATTACHMENT_BYTES)} per file, so it was not attached.`);
          continue;
        }
        accepted += 1;
        const reader = new FileReader();
        reader.addEventListener('load', async () => {
          const att = {
            id: Date.now() + '-' + Math.random().toString(36).slice(2),
            dataUrl: reader.result,
            mimeType: file.type || 'application/octet-stream',
            name: file.name || (String(file.type || '').startsWith('image/') ? 'pasted-image.png' : 'attachment'),
            size: file.size || 0
          };
          if (shrink) {
            const smaller = await shrinkImage(att.dataUrl, 2048, att.mimeType).catch(() => null);
            if (smaller) {
              att.dataUrl = smaller.dataUrl;
              att.mimeType = smaller.mimeType;
              att.size = smaller.size;
            }
          }
          this.pendingAttachments.push(att);
          this.renderAttachmentPreviews();
        });
        reader.addEventListener('error', () => this.appendSystem(`Could not read ${file.name || 'the file'}.`));
        reader.readAsDataURL(file);
      }
    }

    handleFiles() {
      if (!this.fileInput) return;
      this.addAttachmentFiles(this.fileInput.files);
      this.fileInput.value = '';
    }

    handlePaste(e) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file' || String(item.type || '').startsWith('image/')) {
          const file = item.getAsFile?.();
          if (file) files.push(file);
        }
      }
      if (!files.length) return;
      // Keep pasted text: only stop the default paste when the clipboard has
      // nothing but files (CH-25).
      const hasText = [...items].some(item => item.kind === 'string' && item.type === 'text/plain');
      if (!hasText) e.preventDefault();
      this.addAttachmentFiles(files);
    }

    installDropTarget() {
      if (!this.root) return;
      let depth = 0;
      const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
      this.root.addEventListener('dragenter', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth += 1;
        this.root.classList.add('chat-drop-active');
      });
      this.root.addEventListener('dragover', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      });
      this.root.addEventListener('dragleave', (event) => {
        if (!hasFiles(event)) return;
        depth = Math.max(0, depth - 1);
        if (!depth) this.root.classList.remove('chat-drop-active');
      });
      this.root.addEventListener('drop', (event) => {
        if (!hasFiles(event)) return;
        // Dropping a file on the chat must never navigate away from the office.
        event.preventDefault();
        depth = 0;
        this.root.classList.remove('chat-drop-active');
        const caps = this.getSelectedCapabilities();
        if (Object.keys(caps).length && !caps.attachments) {
          this.appendSystem('This agent does not accept attachments.');
          return;
        }
        this.addAttachmentFiles(event.dataTransfer?.files);
      });
    }

    renderAttachmentPreviews() {
      if (!this.attachmentsPreview) return;
      this.attachmentsPreview.innerHTML = '';
      for (const att of this.pendingAttachments) {
        const div = document.createElement('div');
        div.className = 'chat-attach-item';
        if (att.mimeType.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = att.dataUrl;
          img.alt = att.name || 'image';
          div.appendChild(img);
        } else {
          const span = document.createElement('div');
          span.className = 'file-name';
          span.textContent = att.size ? `${att.name} (${formatBytes(att.size)})` : att.name;
          div.appendChild(span);
        }
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'chat-attach-remove';
        rm.textContent = '×';
        rm.title = 'Remove attachment';
        rm.setAttribute('aria-label', 'Remove ' + (att.name || 'attachment'));
        rm.addEventListener('click', () => {
          this.pendingAttachments = this.pendingAttachments.filter(a => a.id !== att.id);
          this.renderAttachmentPreviews();
        });
        div.appendChild(rm);
        this.attachmentsPreview.appendChild(div);
      }
    }

    async sendMessage(options = {}) {
      // One send at a time per window: a second Enter while files upload or a
      // native run streams would orphan the first one (CH-25, CH-31). A queued
      // message that cannot leave yet goes back first in line.
      if (this.sessionSelectionPending || this.sendInFlight) {
        if (options.item && this.queue?.unshift(options.item)) this.renderQueue();
        return;
      }
      this.sendInFlight = true;
      this.updateComposerControls();
      try {
        return await this.sendMessageNow(options);
      } finally {
        this.sendInFlight = false;
        this.updateComposerControls();
      }
    }

    /** How a message sent while the agent works travels (design 4.3): redirect, steer or local. */
    queueMode() {
      const view = this.serverCapsView();
      if (view) return view.queue;
      // Without a manifest an OpenClaw turn takes new words as today (the gateway steers).
      return this.isNativeOpenClawSelected() ? 'steer' : 'local';
    }

    /** Open cards: an approval or a secret blocks words; a question can be skipped by them. */
    waitingCards() {
      const clarify = [];
      let blocking = (this.secretDialogs?.size || 0) > 0;
      this.messages?.querySelectorAll('.hp-approval-card').forEach((card) => {
        if (card.dataset.state !== 'settled') blocking = true;
      });
      this.messages?.querySelectorAll('.hp-question-card').forEach((card) => {
        if (card.dataset.state === 'settled' || !card.dataset.questionId) return;
        clarify.push({ id: card.dataset.questionId, runId: card.closest('[data-run-id]')?.dataset.runId || '' });
      });
      return { clarify, blocking };
    }

    /** Enter, Ctrl/Cmd+Enter or the Send button: send, add to the turn, or queue (design 4.3). */
    submitComposer({ ctrl = false } = {}) {
      if (this.sessionSelectionPending) return null;
      if (!globalThis.ChatQueue || !this.queue) return this.sendMessage();
      this.syncQueue();
      const sending = !!this.sendInFlight && (!this.runState || this.runState.state === 'sending');
      const decision = ChatQueue.decide({
        busy: this.isRunActive() && !sending,
        sending,
        mode: this.queueMode(),
        ctrl,
        text: this.input?.value || '',
        files: this.pendingAttachments,
        waiting: this.waitingCards()
      });
      if (decision.action === 'send' || decision.action === 'steer') return this.sendMessage();
      if (decision.action === 'followup') return this.sendMessage({ followup: true });
      if (decision.action === 'queue') return this.enqueueComposer();
      if (decision.action === 'redirect' || decision.action === 'skip-redirect') {
        const item = this.takeComposer();
        if (!item) return null;
        return decision.action === 'redirect' ? this.sendRedirect(item) : this.skipThenRedirect(item, decision.questions);
      }
      return null;
    }

    /** The composer's words and files, cleared (they now belong to a queued or redirected message). */
    takeComposer() {
      const text = this.input?.value || '';
      const files = this.pendingAttachments.slice();
      if (!text.trim() && !files.length) return null;
      if (this.input) {
        this.input.value = '';
        this.input.style.height = 'auto';
        this.input.style.overflowY = 'hidden';
      }
      this.pendingAttachments = [];
      this.renderAttachmentPreviews();
      return { text, files };
    }

    /** Edit: a queued message goes back into the composer (before what is typed there now). */
    restoreComposer(item) {
      if (!item) return;
      if (this.input) {
        const typed = this.input.value;
        this.input.value = typed.trim() ? item.text + '\n' + typed : item.text;
        this.autoResizeInput();
      }
      const files = (item.files || []).filter(f => f && f.dataUrl);
      if (files.length) {
        this.pendingAttachments = [...files, ...this.pendingAttachments];
        this.renderAttachmentPreviews();
      }
      if (item.lostFiles?.length) this.appendSystem(`Attach again: ${item.lostFiles.join(', ')} (files are not kept across a page reload).`);
    }

    enqueueComposer() {
      const item = this.takeComposer();
      if (!item) return null;
      const added = this.queue.add(item);
      if (!added) {
        this.restoreComposer(item);
        (globalThis.VOUI?.toast || (() => {}))(`Up to ${globalThis.ChatQueue.MAX_ITEMS} messages can wait. Your message is back in the box.`, { kind: 'error' });
        return null;
      }
      this.renderQueue();
      return added;
    }

    /**
     * Hermes: the words go into the running turn at a safe point
     * (`queue:'redirect'`) and appear at once under what the turn wrote.
     * Hermes may take them into the turn (`redirected` / `steered`: that run
     * ends empty) or answer them right after (`queued`).
     */
    async sendRedirect(item) {
      const text = String(item?.text || '').trim();
      if (!text) return;
      const agent = this.chatAgentId();
      const session = this.agentChatSession();
      const fence = this.selectionFence();
      this.retireRunErrors();
      const bubble = this.appendMessage('user', text, Date.now(), [], { label: 'You', kind: 'human' });
      bubble?.classList.add('hp-redirected');
      this.scrollBottom();
      let data = null;
      try {
        const sent = await this.chatFetch('/api/agent-chat/runs', null, {
          agent, session, text, queue: 'redirect', clientId: `office-${Date.now()}-${Math.random().toString(36).slice(2)}`
        });
        data = sent.data;
        if (!sent.res.ok || data.ok === false || !data.runId) throw new Error(data.message || data.error || sent.res.statusText || 'not sent');
      } catch (error) {
        if (fence !== this.selectionFence()) return;
        // Not taken into the turn: it waits for the next one instead of getting lost.
        bubble?.remove();
        this.queue?.unshift({ text: item.text, files: item.files || [] });
        this.renderQueue();
        return;
      }
      if (fence !== this.selectionFence()) return;
      const runId = String(data.runId);
      if (data.status === 'redirected' || data.status === 'steered') {
        // Its own run carries nothing: the running turn answers these words.
        this.steeredRuns.add(runId);
        return;
      }
      this.registerProviderRun(runId, this.sessionKey);
      this.universalRuns.add(runId);
    }

    /** Words while Hermes asks a question: the question is skipped, the words go into the turn. */
    async skipThenRedirect(item, questions = []) {
      const agent = this.chatAgentId();
      const session = this.agentChatSession();
      await Promise.all((questions || []).map((q) => {
        const id = String(q?.id || q || '');
        if (!id) return null;
        return this.postChatAnswer('/api/agent-chat/questions', { agent, session, run: String(q?.runId || ''), question: id, cancel: true })
          .then((result) => { if (result.ok || result.notPending) settleEverywhere('question', id, result.ok ? 'skipped' : 'not-pending', this); })
          .catch(() => {});
      }));
      if (this.isRunActive()) return this.sendRedirect(item);
      return this.sendMessage({ item });
    }

    /** The queue follows the chat: each chat keeps its own (a new chat keeps its own when it gets its id). */
    syncQueue() {
      if (!this.queue) return;
      const key = this.chatStateKey();
      const before = this.queue.key;
      if (before !== key) {
        const [agentBefore] = before.split('\u0000');
        if (this.queue.size && agentBefore === this.chatAgentId() && /@new:|\u0000$/.test(before)) this.queue.moveTo(key);
        else this.queue.rekey(key);
      }
      this.renderQueue();
    }

    /** Chips above the composer: "2 queued", each with Edit, Delete, Send now (design 4.3). */
    renderQueue() {
      if (!this.queue || !this.root) return;
      const items = this.queue.items;
      let el = this.queueEl;
      if (!items.length) {
        if (el) el.hidden = true;
        this.renderBusyHint();
        return;
      }
      if (!el || !el.isConnected) {
        el = document.createElement('div');
        el.className = 'hp-queue';
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', 'Queued messages');
        el.addEventListener('click', (event) => this.onQueueClick(event));
        const anchor = this.root.querySelector('.chat-attachments-preview') || this.root.querySelector('.chat-input-row');
        if (anchor?.parentNode) anchor.parentNode.insertBefore(el, anchor);
        else this.root.appendChild(el);
        this.queueEl = el;
      }
      el.hidden = false;
      el.dataset.paused = this.queue.paused ? 'true' : 'false';
      const mode = this.queueMode();
      const head = document.createElement('div');
      head.className = 'hp-queue-head';
      const label = document.createElement('span');
      label.className = 'hp-queue-label';
      label.textContent = this.queue.label();
      head.appendChild(label);
      if (this.queue.paused) {
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.className = 'hp-queue-btn hp-queue-resume';
        resume.dataset.queueAction = 'resume';
        resume.textContent = 'Resume';
        head.appendChild(resume);
      }
      const chips = document.createElement('div');
      chips.className = 'hp-queue-chips';
      const button = (action, text, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hp-queue-btn';
        b.dataset.queueAction = action;
        b.textContent = text;
        b.title = title;
        b.setAttribute('aria-label', title);
        return b;
      };
      for (const item of items) {
        const chip = document.createElement('div');
        chip.className = 'hp-queue-chip';
        chip.dataset.queueId = item.id;
        const words = document.createElement('span');
        words.className = 'hp-queue-text';
        words.textContent = globalThis.ChatQueue.preview(item);
        words.title = item.text;
        const edit = button('edit', 'Edit', 'Edit this queued message');
        setChatIcon(edit, 'edit');
        chip.append(words, edit, button('delete', '✕', 'Delete this queued message'));
        if (mode === 'redirect' || mode === 'steer') chip.appendChild(button('send-now', 'Send now', 'Send this message now'));
        chips.appendChild(chip);
      }
      el.replaceChildren(head, chips);
      this.renderBusyHint();
    }

    onQueueClick(event) {
      const btn = event.target?.closest?.('[data-queue-action]');
      if (!btn || !this.queue) return;
      const action = btn.dataset.queueAction;
      const id = btn.closest('[data-queue-id]')?.dataset.queueId || '';
      if (action === 'resume') {
        this.queue.resume();
        this.renderQueue();
        this.maybeDrainQueue();
      } else if (action === 'delete') {
        this.queue.remove(id);
        this.renderQueue();
      } else if (action === 'edit') {
        const item = this.queue.edit(id);
        this.renderQueue();
        this.restoreComposer(item);
        this.input?.focus();
      } else if (action === 'send-now') {
        const item = this.queue.pick(id);
        this.renderQueue();
        this.sendQueuedNow(item);
      }
    }

    /** Send now: at once when idle; into the turn when it can take it; else first in line. */
    sendQueuedNow(item) {
      if (!item) return null;
      if (!this.isRunActive()) return this.sendMessage({ item });
      const mode = this.queueMode();
      const wordsOnly = !!String(item.text || '').trim() && !(item.files || []).length;
      if (mode === 'redirect' && wordsOnly && !this.waitingCards().blocking) return this.sendRedirect(item);
      if (mode === 'steer' && !this.sendInFlight) return this.sendMessage({ item });
      this.queue.unshift(item);
      this.queue.resume();
      this.renderQueue();
      return null;
    }

    /** After a turn ends, the next queued message leaves by itself (one at a time). */
    maybeDrainQueue() {
      if (!this.queue || !this.queue.size || this.queue.paused || this.queueDrainTimer) return;
      this.queueDrainTimer = setTimeout(() => {
        this.queueDrainTimer = null;
        if (this.sessionSelectionPending || this.chatStateKey() !== this.queue.key) return;
        if (!this.queue.next({ busy: this.isRunActive(), sending: !!this.sendInFlight })) return;
        const item = this.queue.take();
        this.renderQueue();
        this.sendMessage({ item });
      }, 700);
    }

    /** One line under the composer while the agent works: what Enter does now. */
    renderBusyHint() {
      if (!this.root || !globalThis.ChatQueue) return;
      const show = this.isRunActive() && !this.sessionSelectionPending;
      let hint = this.root.querySelector('.hp-busy-hint');
      if (!show) {
        if (hint && !hint.hidden) hint.hidden = true;
        return;
      }
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'hp-busy-hint';
        hint.setAttribute('aria-live', 'polite');
        const row = this.root.querySelector('.chat-input-row');
        if (row?.parentNode) row.after(hint);
        else this.root.appendChild(hint);
      }
      const mode = this.queueMode();
      let text;
      if (this.enterInsertsNewline()) {
        text = mode === 'local' ? 'Send queues your message for after this answer' : 'Send adds to this turn';
      } else {
        text = ChatQueue.hint(mode);
        if (/Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '')) text = text.replace('Ctrl+Enter', 'Cmd+Enter');
      }
      if (hint.textContent !== text) hint.textContent = text;
      if (hint.hidden) hint.hidden = false;
    }

    async sendMessageNow(options = {}) {
      // CH-15: snapshot the target at send start. Any switch of agent or
      // session while files upload or audio transcribes cancels the send and
      // puts the text back, instead of delivering it to the new selection.
      const sendFence = this.selectionFence();
      const sendSessionKey = this.sessionKey;
      const sendStillCurrent = () => sendFence === this.selectionFence() && !this.sessionSelectionPending;
      const selectionUnchanged = () => sendStillCurrent() && sendSessionKey === this.sessionKey;
      const retryText = typeof options.retryText === 'string' ? options.retryText : null;
      // A queued message (chat-queue.js) brings its own words and files; the composer is left alone.
      const item = retryText === null && options.item && typeof options.item === 'object' ? options.item : null;
      let text = retryText !== null ? retryText.trim() : (item ? String(item.text || '').trim() : this.input.value.trim());
      const typedText = text;
      const sendAttachments = retryText !== null ? [] : (item ? (Array.isArray(item.files) ? item.files.filter(f => f && f.dataUrl) : []) : this.pendingAttachments.slice());
      const hasAttachments = sendAttachments.length > 0;
      if (!text && !hasAttachments) return;
      if (!connected && !this.isProviderAgentSelected()) {
        this.appendSystemIfMissing('', 'Not connected to the OpenClaw gateway yet. Your message is still in the box; press Send again when the status says Connected.');
        return;
      }
      if (hasAttachments && this.isProviderAgentSelected() && this.getSelectedCapabilities().attachments === false) {
        this.appendSystem(this.getSelectedProviderKind() + ' does not support chat attachments.');
        return;
      }

      // Snapshot and clear the composer at send start so a second Enter can
      // never send the same text or files twice (CH-25).
      if (retryText === null && !item) {
        this.input.value = '';
        this.input.style.height = 'auto';
        this.input.style.overflowY = 'hidden';
        this.pendingAttachments = [];
        this.renderAttachmentPreviews();
      }
      this.retireRunErrors();

      let displayText = text || '';
      const imageDataUrls = sendAttachments.filter(a => a.mimeType.startsWith('image/')).map(a => a.dataUrl);
      const nonImageNames = sendAttachments.filter(a => !a.mimeType.startsWith('image/')).map(a => a.name);
      if (nonImageNames.length) displayText += (displayText ? '\n' : '') + '📎 ' + nonImageNames.join(', ');
      const userBubble = this.appendMessage('user', displayText, Date.now(), imageDataUrls, { label: 'You', kind: 'human' });
      this.setRunState('sending', hasAttachments ? `Uploading ${sendAttachments.length} file${sendAttachments.length === 1 ? '' : 's'}…` : 'Sending…');
      this.scrollBottom();

      let attachments;
      let uploadedFiles = [];
      if (hasAttachments) {
        const UPLOAD_URL = window.location.origin + '/upload';
        const gatewayAttachments = [];
        let gatewayAttachmentChars = 0;
        const nativeOpenClaw = !this.isProviderAgentSelected();
        const uploadAttachment = async (a) => {
          const b64 = a.dataUrl.split(',')[1];
          const resp = await fetch(UPLOAD_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: a.name, content: b64, mimeType: a.mimeType || '' })
          });
          if (!resp.ok) {
            const detail = await resp.json().catch(() => ({}));
            throw new Error(detail.error || resp.statusText || ('HTTP ' + resp.status));
          }
          const result = await resp.json();
          return {
            name: a.name,
            mimeType: a.mimeType || '',
            path: result.path || '',
            url: result.url || (result.path ? '/chat-media?path=' + encodeURIComponent(result.path) : ''),
            size: result.size || 0
          };
        };
        const addGatewayAttachment = (entry) => {
          if (gatewayAttachmentChars + entry.content.length > MAX_OPENCLAW_RPC_ATTACHMENT_CHARS) return false;
          gatewayAttachmentChars += entry.content.length;
          gatewayAttachments.push(entry);
          return true;
        };

        for (const a of sendAttachments) {
          let uploaded = null;
          try {
            uploaded = await uploadAttachment(a);
            if (uploaded?.path || uploaded?.url) uploadedFiles.push(uploaded);
          } catch (e) {
            if (!selectionUnchanged()) return this.abandonSend(typedText, 'Not sent: the agent or session changed while files were uploading. Your text is back in the box.');
            this.appendSystem('Upload failed for ' + a.name + ': ' + e.message);
            continue;
          }
          if (!selectionUnchanged()) return this.abandonSend(typedText, 'Not sent: the agent or session changed while files were uploading. Your text is back in the box.');
          if (a.mimeType.startsWith('image/')) {
            const url = await compressImage(a.dataUrl);
            const parsed = parseDataUrl(url);
            if (parsed) addGatewayAttachment({
              type: 'image',
              mimeType: parsed.mimeType,
              fileName: a.name,
              content: parsed.content,
              sizeBytes: uploaded?.size || Math.floor(parsed.content.length * 3 / 4)
            });
          } else if (a.mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|webm|opus|aac)$/i.test(a.name)) {
            this.appendSystem('🎤 Transcribing ' + a.name + '...');
            try {
              const b64 = a.dataUrl.split(',')[1];
              const audioBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
              const resp = await fetch('/transcribe', {
                method: 'POST', headers: { 'Content-Type': a.mimeType || 'audio/webm' }, body: audioBytes
              });
              const data = await resp.json();
              if (!selectionUnchanged()) return this.abandonSend(typedText, 'Not sent: the agent or session changed while the audio was being transcribed. Your text is back in the box.');
              if (data.text && data.text.trim()) {
                text = text ? text + '\n[Audio transcription: ' + data.text.trim() + ']' : '[Audio transcription: ' + data.text.trim() + ']';
                this.appendSystem('✅ Transcription complete');
              } else if (data.error) {
                this.appendSystem('❌ Transcription error: ' + data.error);
              } else {
                this.appendSystem('⚠️ No speech detected in audio');
              }
            } catch (e) {
              if (!selectionUnchanged()) return this.abandonSend(typedText, 'Not sent: the agent or session changed while the audio was being transcribed. Your text is back in the box.');
              this.appendSystem('❌ Transcription failed: ' + e.message);
            }
          } else if (nativeOpenClaw && (a.size || 0) <= MAX_NATIVE_OPENCLAW_ATTACHMENT_BYTES) {
            // DL-17: small non-image files go to OpenClaw natively; the
            // path note below stays as the fallback for every file.
            const parsed = parseDataUrl(a.dataUrl);
            if (parsed) addGatewayAttachment({
              type: a.mimeType.startsWith('video/') ? 'video' : 'file',
              mimeType: parsed.mimeType || a.mimeType || 'application/octet-stream',
              fileName: a.name,
              content: parsed.content,
              sizeBytes: uploaded?.size || a.size || Math.floor(parsed.content.length * 3 / 4)
            });
          }
        }

        if (!uploadedFiles.length) {
          // Every upload failed: send nothing, give the files and text back.
          this.pendingAttachments = [...sendAttachments, ...this.pendingAttachments];
          this.renderAttachmentPreviews();
          if (typedText && !this.input.value.trim()) {
            this.input.value = typedText;
            this.autoResizeInput();
          }
          userBubble?.classList.add('chat-msg-unsent');
          this.setRunState('error', 'Not sent');
          this.showRunError('Could not upload the attached files, so nothing was sent. Your message and files are back in the box.', { allowRetry: false });
          return;
        }

        if (uploadedFiles.length) {
          const pathNote = uploadedFiles.map(f => '(attached file: ' + (f.path || f.url) + ')').join('\n');
          text = text ? text + '\n' + pathNote : pathNote;
        }
        attachments = gatewayAttachments.length ? gatewayAttachments : undefined;
      }

      if (!selectionUnchanged()) return this.abandonSend(typedText, 'Not sent: the agent or session changed before the message left. Your text is back in the box.');
      this.lastSend = { text, fence: sendFence, sessionKey: sendSessionKey, at: Date.now(), runId: '' };

      const params = { sessionKey: sendSessionKey, message: text || '(attached files)', idempotencyKey: `office-${Date.now()}-${Math.random().toString(36).slice(2)}` };
      if (attachments?.length) params.attachments = attachments;
      // Ctrl/Cmd+Enter while OpenClaw works: after this answer instead of into it (design 4.3 steer).
      if (options.followup === true) params.queueMode = 'followup';

      if (this.isServeHermesSelected()) {
        // `hermes serve` reads the uploaded files itself (design 2.11): send
        // the typed words and the upload refs, not the path notes.
        return this.sendServeMessage({ text: typedText, files: uploadedFiles, sessionKey: sendSessionKey, stillCurrent: sendStillCurrent });
      }

      if (this.isGenericProviderSelected()) {
        const providerKind = this.getSelectedProviderKind();
        const providerLabel = this.agentSelect.selectedOptions[0]?.textContent.trim() || providerKind;
        const sendStartedAt = Date.now();
        const providerOriginSessionKey = this.sessionKey;
        this.updateTypingIndicator(providerLabel + ' is starting…');
        this.setStatus(providerLabel + ' running…', 'connecting');
        try {
          const response = await fetch('/api/provider-runs', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
              agentId:this.getSelectedAgentId() || this.selectedAgentKey,
              message:text || '(attached files)',
              sessionId:this.selectedProviderSessionId(),
              sessionKey:providerOriginSessionKey,
              newSessionPending:this.isPendingProviderSession(),
              fromType:'human',
              fromDisplayName:'User',
              sourceApp:'virtual-office',
              sourceSurface:'chat-window',
              sourceLabel:'Virtual Office Chat',
              attachments:uploadedFiles
            })
          });
          const data = await response.json();
          if (!sendStillCurrent()) return;
          if (!response.ok || data.ok === false) throw new Error(data.error || data.reply || response.statusText);
          this.currentRunId = data.runId || null;
          this.registerProviderRun(data.runId, providerOriginSessionKey);
          this.markRunDelivered(data.runId);
          if (data.sessionId && this.sessionKey === providerOriginSessionKey) {
            this.adoptProviderSessionId(data.sessionId);
            const owner = runOwners.get(data.runId);
            if (owner) owner.sessionKey = this.sessionKey;
          }
          await this.streamProviderRunEvents(data.runId);
          await this.loadHistory({ recoverFinal:true, startedAt:sendStartedAt });
          await this.fetchSessionInfo();
          await this.refreshSessionsList();
          if (this.isNativeHermesSelected()) await this.pollHermesApproval().catch(() => {});
          if (this.isCodexSelected()) await this.pollCodexApproval().catch(() => {});
          this.setStatus(providerLabel + ' ready', 'connected');
        } catch (error) {
          this.closeProviderEventSource();
          this.removeTypingIndicator();
          if (error.lateRunIgnored) return;
          if (error.streamDisconnected && await this.recoverFinalFromHistory('', sendStartedAt).catch(() => false)) {
            this.finishRecoveredRun();
            this.setStatus(providerLabel + ' ready', 'connected');
            return;
          }
          if (!error.turnReducerHandled) {
            this.applyTurnEvent({ kind: 'run.failed', runId: this.currentRunId || `provider-failed-${sendStartedAt}`, error: error.message });
          }
          await this.loadHistory({ recoverFinal:true, startedAt:sendStartedAt }).catch(() => {});
          this.setStatus(providerLabel + ' run failed', 'disconnected');
        }
        return;
      }

      if (this.isNativeHermesSelected()) {
        const hermesLabel = this.agentSelect.selectedOptions[0]?.textContent.trim() || 'Hermes';
        const hermesProgress = this.startHermesProgress(hermesLabel);
        const hermesSendStartedAt = Date.now();
        const hermesOriginSessionKey = this.sessionKey;
        const hermesBody = {
          agentId: this.getSelectedAgentId() || this.selectedAgentKey,
          message: text || '(attached files)',
          sessionId: this.selectedProviderSessionId(),
          sessionKey: hermesOriginSessionKey,
          newSessionPending: this.isPendingProviderSession(),
          fromType: 'human',
          fromDisplayName: 'User',
          sourceApp: 'virtual-office',
          sourceSurface: 'chat-window',
          sourceLabel: 'Virtual Office Chat',
          attachments: uploadedFiles
        };
        try {
          const resp = await fetch('/api/hermes/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(hermesBody)
          });
          const data = await resp.json();
          if (!sendStillCurrent()) return;
          if (!resp.ok || data.ok === false) {
            if (data.fallback) {
              await this.sendHermesBlockingMessage(hermesBody, hermesProgress, hermesSendStartedAt);
              return;
            }
            throw new Error(data.error || data.reply || resp.statusText);
          }
          this.currentRunId = data.runId || null;
          this.registerProviderRun(data.runId, hermesOriginSessionKey);
          this.markRunDelivered(data.runId);
          if (data.sessionId && this.sessionKey === hermesOriginSessionKey) {
            this.adoptProviderSessionId(data.sessionId);
            const owner = runOwners.get(data.runId);
            if (owner) owner.sessionKey = this.sessionKey;
          }
          await this.streamHermesRunEvents(data.runId, hermesProgress);
          this.removeTypingIndicator();
          this.finishHermesProgress(hermesProgress, true);
          await this.loadHistory({ recoverFinal: true, startedAt: hermesSendStartedAt });
          await this.pollHermesApproval().catch(() => {});
          this.setStatus('Hermes ready', 'connected');
        } catch (e) {
          this.closeHermesEventSource();
          this.removeTypingIndicator();
          if (e.lateRunIgnored) {
            this.finishHermesProgress(hermesProgress, false, e.message);
            return;
          }
          const recovered = !e.turnReducerHandled && await this.recoverHermesFinalFromHistory(hermesSendStartedAt, e.streamDisconnected ? 45000 : 4000).catch(() => false);
          if (recovered) {
            this.finishHermesProgress(hermesProgress, true);
            this.finishRecoveredRun();
            await this.pollHermesApproval().catch(() => {});
            this.setStatus('Hermes ready', 'connected');
            return;
          }
          const failedRunId = this.currentRunId || hermesProgress?.runId || `hermes-failed-${hermesSendStartedAt}`;
          this.finishHermesProgress(hermesProgress, false, e.message);
          if (!e.turnReducerHandled) this.applyTurnEvent({ kind: 'run.failed', runId: failedRunId, error: e.message });
          this.setStatus('Hermes error', 'disconnected');
        }
        return;
      }

      if (this.isCodexSelected()) {
        const codexLabel = this.agentSelect.selectedOptions[0]?.textContent.trim() || 'Codex';
        const codexSendStartedAt = Date.now();
        const codexOriginSessionKey = this.sessionKey;
        const codexBody = {
          agentId: this.getSelectedAgentId() || this.selectedAgentKey,
          message: text || '(attached files)',
          sessionId: this.selectedProviderSessionId(),
          sessionKey: codexOriginSessionKey,
          newSessionPending: this.isPendingProviderSession(),
          fromType: 'human',
          fromDisplayName: 'User',
          sourceApp: 'virtual-office',
          sourceSurface: 'chat-window',
          sourceLabel: 'Virtual Office Chat',
          attachments: uploadedFiles
        };
        this.updateTypingIndicator(codexLabel + ' is running Codex');
        this.setStatus('Codex running...', 'connecting');
        try {
          const resp = await fetch('/api/codex/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(codexBody)
          });
          const data = await resp.json();
          if (!sendStillCurrent()) return;
          if (!resp.ok || data.ok === false) {
            if (data.fallback) {
              await this.sendCodexBlockingMessage(codexBody, codexSendStartedAt);
              return;
            }
            throw new Error(data.error || data.reply || resp.statusText);
          }
          this.currentRunId = data.runId || null;
          this.registerProviderRun(data.runId, codexOriginSessionKey);
          this.markRunDelivered(data.runId);
          if (data.sessionId && this.sessionKey === codexOriginSessionKey) {
            this.adoptProviderSessionId(data.sessionId);
            const owner = runOwners.get(data.runId);
            if (owner) owner.sessionKey = this.sessionKey;
          }
          await this.fetchSessionInfo();
          await this.streamCodexRunEvents(data.runId);
          this.removeTypingIndicator();
          await this.loadHistory({ recoverFinal: true, startedAt: codexSendStartedAt });
          await this.fetchSessionInfo();
          await this.pollCodexApproval().catch(() => {});
          this.setStatus('Codex ready', 'connected');
        } catch (e) {
          this.closeCodexEventSource();
          this.removeTypingIndicator();
          if (e.lateRunIgnored) return;
          if (e.streamDisconnected && await this.recoverFinalFromHistory('codex', codexSendStartedAt).catch(() => false)) {
            this.finishRecoveredRun();
            this.setStatus('Codex ready', 'connected');
            return;
          }
          if (!e.turnReducerHandled) this.applyTurnEvent({ kind: 'run.failed', runId: this.currentRunId || `codex-failed-${codexSendStartedAt}`, error: e.message });
          await this.loadHistory({ recoverFinal: true, startedAt: codexSendStartedAt }).catch(() => {});
          this.setStatus('Codex error', 'disconnected');
        }
        return;
      }

      if (this.isClaudeCodeSelected()) {
        const claudeLabel = this.agentSelect.selectedOptions[0]?.textContent.trim() || 'Claude Code';
        const claudeSendStartedAt = Date.now();
        const claudeOriginSessionKey = this.sessionKey;
        const claudeBody = {
          agentId: this.getSelectedAgentId() || this.selectedAgentKey,
          message: text || '(attached files)',
          sessionId: this.selectedProviderSessionId(),
          sessionKey: claudeOriginSessionKey,
          newSessionPending: this.isPendingProviderSession(),
          fromType: 'human',
          fromDisplayName: 'User',
          sourceApp: 'virtual-office',
          sourceSurface: 'chat-window',
          sourceLabel: 'Virtual Office Chat',
          attachments: uploadedFiles
        };
        this.updateTypingIndicator(claudeLabel + ' is running Claude Code');
        this.setStatus('Claude Code running...', 'connecting');
        try {
          const resp = await fetch('/api/claude-code/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(claudeBody)
          });
          const data = await resp.json();
          if (!sendStillCurrent()) return;
          if (!resp.ok || data.ok === false) {
            if (data.fallback) {
              await this.sendClaudeCodeBlockingMessage(claudeBody, claudeSendStartedAt);
              return;
            }
            throw new Error(data.error || data.reply || resp.statusText);
          }
          this.currentRunId = data.runId || null;
          this.registerProviderRun(data.runId, claudeOriginSessionKey);
          this.markRunDelivered(data.runId);
          if (data.sessionId && this.sessionKey === claudeOriginSessionKey) {
            this.adoptProviderSessionId(data.sessionId);
            const owner = runOwners.get(data.runId);
            if (owner) owner.sessionKey = this.sessionKey;
          }
          await this.fetchSessionInfo();
          await this.streamClaudeCodeRunEvents(data.runId);
          this.removeTypingIndicator();
          await this.loadHistory({ recoverFinal: true, startedAt: claudeSendStartedAt });
          await this.fetchSessionInfo();
          this.setStatus('Claude Code ready', 'connected');
        } catch (e) {
          this.closeClaudeCodeEventSource();
          this.removeTypingIndicator();
          if (e.lateRunIgnored) return;
          if (e.streamDisconnected && await this.recoverFinalFromHistory('claude-code', claudeSendStartedAt).catch(() => false)) {
            this.finishRecoveredRun();
            this.setStatus('Claude Code ready', 'connected');
            return;
          }
          if (!e.turnReducerHandled) this.applyTurnEvent({ kind: 'run.failed', runId: this.currentRunId || `claude-code-failed-${claudeSendStartedAt}`, error: e.message });
          await this.loadHistory({ recoverFinal: true, startedAt: claudeSendStartedAt }).catch(() => {});
          this.setStatus('Claude Code error', 'disconnected');
        }
        return;
      }

      if (this.isGenericProviderSelected()) {
        const providerKind = this.getSelectedProviderKind();
        const providerLabel = this.agentSelect.selectedOptions[0]?.textContent.trim() || providerKind;
        this.updateTypingIndicator(providerLabel + ' is working');
        this.setStatus(providerKind + ' running...', 'connecting');
        try {
          const resp = await fetch('/api/provider-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: this.getSelectedAgentId() || this.selectedAgentKey,
              message: text || '(attached files)',
              fromType: 'human',
              fromDisplayName: 'User',
              sourceApp: 'virtual-office',
              sourceSurface: 'chat-window',
              attachments: uploadedFiles
            })
          });
          const data = await resp.json();
          if (!sendStillCurrent()) return;
          if (!resp.ok || data.ok === false) throw new Error(data.error || data.reply || resp.statusText);
          this.removeTypingIndicator();
          await this.loadHistory({ recoverFinal: true });
          this.setStatus(providerKind + ' ready', 'connected');
        } catch (e) {
          this.removeTypingIndicator();
          await this.loadHistory({ recoverFinal: true }).catch(() => {});
          this.showRunError(e.message, { runId: `provider-chat-failed-${Date.now()}` });
          this.setStatus(providerKind + ' error', 'disconnected');
        }
        return;
      }

      try {
        const res = await rpc('chat.send', params);
        // DL-03 / CH-14: in proxy mode rpc() resolves {ok:false} instead of
        // throwing, so a rejected send must be turned into an error here.
        if (!res?.ok) throw new Error(res?.error?.message || res?.error?.code || 'Gateway rejected chat.send');
        const runId = res.payload?.runId;
        if (runId) {
          this.registerRunOwner(runId, sendSessionKey);
          if (sendStillCurrent() && sendSessionKey === this.sessionKey) {
            this.currentRunId = runId;
            this.markLiveEvent();
            this.ensureRecoveryWatchdog();
            this.markRunDelivered(runId);
          }
        } else if (this.runState?.state === 'sending') {
          this.setRunState('running');
        }
      } catch (e) {
        if (!sendStillCurrent()) return;
        const failedRunId = `openclaw-failed-${Date.now()}`;
        this.setRunState('error', 'Not delivered', failedRunId);
        this.applyTurnEvent({ kind: 'run.failed', runId: failedRunId, error: e.message });
      }
    }

    markRunDelivered(runId) {
      if (this.lastSend && runId) this.lastSend.runId = String(runId);
      if (!this.runState || this.runState.state === 'sending') this.setRunState('running', '', runId);
    }

    finishRecoveredRun() {
      if (this.runState && ['sending', 'running'].includes(this.runState.state)) this.clearRunState();
      this.currentRunId = null;
      this.updateComposerControls();
    }

    async sendStop() {
      // Stop pauses what is queued until Resume (design 4.3).
      if (this.queue?.pause()) this.renderQueue();
      try {
        if (this.isServeHermesSelected()) {
          await this.stopServeRun();
          return;
        }
        if (this.isGenericProviderSelected()) {
          if (this.getSelectedCapabilities().interrupt === false) throw new Error(this.getSelectedProviderKind() + ' does not support interruption');
          const response = await fetch('/api/provider-interrupt', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({ agentId:this.getSelectedAgentId() || this.selectedAgentKey, runId:this.currentRunId || '' })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
          this.applyTurnEvent({ kind: 'run.cancelled', runId: this.currentRunId || '' });
          this.removeTypingIndicator();
          this.appendSystem('Stop sent');
          this.setStatus(this.getSelectedProviderKind() + ' stopping…', 'connecting');
          return;
        }
        if (this.isNativeHermesSelected()) {
          const resp = await fetch('/api/hermes/interrupt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: this.getSelectedAgentId() || this.selectedAgentKey, runId: this.currentRunId || '' })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
          this.applyTurnEvent({ kind: 'run.cancelled', runId: this.currentRunId || '' });
          this.appendSystem('Stop sent');
          this.setStatus('Hermes stopping...', 'connecting');
          return;
        }
        if (this.isCodexSelected()) {
          const resp = await fetch('/api/codex/interrupt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: this.getSelectedAgentId() || this.selectedAgentKey })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
          this.applyTurnEvent({ kind: 'run.cancelled', runId: this.currentRunId || '' });
          await this.loadHistory({ recoverFinal: true }).catch(() => {});
          this.appendSystem('Stop sent');
          this.setStatus('Codex stopping...', 'connecting');
          return;
        }
        if (this.isClaudeCodeSelected()) {
          const resp = await fetch('/api/claude-code/interrupt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId: this.getSelectedAgentId() || this.selectedAgentKey, runId: this.currentRunId || '' })
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || data.ok === false) throw new Error(data.error || resp.statusText);
          this.applyTurnEvent({ kind: 'run.cancelled', runId: this.currentRunId || '' });
          await this.loadHistory({ recoverFinal: true }).catch(() => {});
          this.appendSystem('Stop sent');
          this.setStatus('Claude Code stopping...', 'connecting');
          return;
        }
        const params = { sessionKey: this.sessionKey };
        if (this.currentRunId) params.runId = this.currentRunId;
        const res = await rpc('chat.abort', params);
        if (res?.ok === false) throw new Error(res.error?.message || 'abort failed');
        this.applyTurnEvent({ kind: 'run.cancelled', runId: this.currentRunId || '' });
        this.appendSystem('🛑 Stop sent');
      } catch (e) {
        this.appendSystem('Failed to stop: ' + e.message);
      }
    }

    async toggleRecording() {
      if (this.isRecording) return this.stopRecording();
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        this.appendSystem('Voice input is not available in this browser.');
        return;
      }
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        this.appendSystem(e?.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in the browser to use voice input.' : 'Could not start the microphone: ' + (e?.message || e));
        return;
      }
      // CH-29: pick a format this browser can record (Safari has no
      // opus/webm) and always release the microphone if anything fails.
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      const mimeType = candidates.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
      try {
        this.mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        this.recordingStream = stream;
        this.audioChunks = [];
        this.discardRecording = false;
        const recorder = this.mediaRecorder;
        recorder.ondataavailable = (e) => { if (e.data.size > 0) this.audioChunks.push(e.data); };
        recorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          if (this.recordingStream === stream) this.recordingStream = null;
          if (this.discardRecording) { this.audioChunks = []; return; }
          const type = recorder.mimeType || mimeType || 'audio/webm';
          const blob = new Blob(this.audioChunks, { type });
          this.audioChunks = [];
          await this.transcribeAudio(blob);
        };
        recorder.start();
        this.isRecording = true;
        this.micBtn.classList.add('recording');
        this.micBtn.textContent = '■';
        this.micBtn.title = 'Stop recording';
      } catch (e) {
        stream.getTracks().forEach(t => t.stop());
        this.recordingStream = null;
        this.mediaRecorder = null;
        this.isRecording = false;
        this.appendSystem('This browser cannot record audio here: ' + (e?.message || e));
      }
    }

    stopRecording({ discard = false } = {}) {
      this.discardRecording = !!discard;
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
      else if (this.recordingStream) {
        this.recordingStream.getTracks().forEach(t => t.stop());
        this.recordingStream = null;
      }
      this.isRecording = false;
      if (this.micBtn) {
        this.micBtn.classList.remove('recording');
        this.micBtn.innerHTML = '<svg class="vo-icon" aria-hidden="true" focusable="false"><use href="#i-mic"/></svg>';
        this.micBtn.title = 'Voice input';
      }
    }

    async transcribeAudio(blob) {
      this.micBtn.textContent = '···';
      this.micBtn.disabled = true;
      try {
        const resp = await fetch('/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
        const data = await resp.json();
        if (data.text) {
          this.input.value = (this.input.value ? this.input.value + ' ' : '') + data.text;
          this.autoResizeInput();
          this.input.focus();
        } else if (data.error) {
          this.appendSystem('Transcription error: ' + data.error);
        }
      } catch (e) {
        this.appendSystem('Transcription failed: ' + e.message);
      }
      this.micBtn.innerHTML = '<svg class="vo-icon" aria-hidden="true" focusable="false"><use href="#i-mic"/></svg>';
      this.micBtn.disabled = false;
    }

    ownsPayload(payload) {
      if (!payload) return false;
      if (payload.sessionKey) return payload.sessionKey === this.sessionKey;
      if (payload.runId && this.currentRunId && payload.runId === this.currentRunId) return true;
      const owner = payload.runId ? runOwners.get(payload.runId) : null;
      if (owner) return owner.slotId === this.slotId && owner.sessionKey === this.sessionKey;
      return false;
    }

    applyTurnEvent(event) {
      const actions = this.turnEvents.ingest(event);
      this.syncTaskProgress?.();
      actions.forEach(action => {
        this.applyTurnAction(action);
        this.progressPanel?.runEvent(action);
      });
      if (['run.complete', 'run.failed', 'run.cancelled'].includes(event.kind) && this.progressPanel?.identity) progressStore.invalidate(this.progressPanel.identity);
      return actions;
    }

    applyDistinctThinking(runId, value) {
      const thinking = String(value || '').trim();
      const visibleText = this.turnEvents.get(runId)?.fullText?.trim() || '';
      // Some runtimes report their final answer through a reasoning field
      // after already streaming it as assistant text. Do not render that as a
      // duplicate Thinking card below the answer.
      if (!thinking || thinking === visibleText) return false;
      this.applyTurnEvent({ kind: 'thinking', runId, text: thinking });
      return true;
    }

    markOpenClawCommentaryMessage(element, item) {
      if (!element) return;
      element.classList.add('chat-commentary-segment');
      element.dataset.runId = String(item?.runId || '');
      element.dataset.commentaryItemId = String(item?.itemId || '');
    }

    applyOpenClawCommentaryAction(action) {
      const runId = String(action?.runId || '');
      const itemId = String(action?.itemId || '');
      const existing = [...this.messages.querySelectorAll('.chat-commentary-segment')].find((element) => (
        element.dataset.runId === runId && element.dataset.commentaryItemId === itemId
      ));
      if (!existing) {
        const rendered = this.appendMessage(
          'assistant',
          action?.text || '',
          action?.ts || Date.now(),
          [],
          normalizeSenderMeta({}, 'assistant', this),
          []
        );
        this.markOpenClawCommentaryMessage(rendered, action);
        return;
      }
      const bubble = existing.querySelector('.chat-bubble');
      if (!bubble) return;
      let textDiv = bubble.querySelector('.chat-markdown, .chat-message-content');
      if (!textDiv) {
        textDiv = document.createElement('div');
        textDiv.className = 'chat-message-content chat-markdown';
        const time = bubble.querySelector('.chat-time');
        bubble.insertBefore(textDiv, time || null);
      }
      renderMarkdownInto(textDiv, action?.text || '');
      this.scrollBottom();
    }

    applyTurnAction(action) {
      if (!action) return;
      const runId = action.runId || this.currentRunId || '';
      if (runId && action.kind !== 'run.terminal') this.currentRunId = runId;
      if (action.kind !== 'run.terminal' && this.runState?.state === 'sending') this.setRunState('running', '', runId);
      // Work after an approval (paths with no resolved event): no longer waiting on you.
      if (['text.delta', 'tool.start', 'thinking'].includes(action.kind)) this.stopWaitingForYou(runId);

      if (action.kind === 'run.start') {
        if (action.label) this.updateTypingIndicator(action.label);
        return;
      }

      if (action.kind === 'commentary.open' || action.kind === 'commentary.update') {
        this.applyOpenClawCommentaryAction(action);
        return;
      }

      if (action.kind === 'text.open' || action.kind === 'text.update') {
        if (!this.streamingMsg || this.streamingMsg.id !== runId || !this.messages.querySelector('.streaming-msg')) {
          this.streamingMsg = { id: runId, role: 'assistant', content: '' };
          this.pendingStreamContent = '';
          this.appendStreamingMessage(runId);
        }
        this.pendingStreamContent = action.text || '';
        this.scheduleStreamingRender();
        return;
      }

      if (action.kind === 'text.finalize') {
        this.pendingStreamContent = action.text || this.pendingStreamContent || '';
        this.flushStreamingRender(true);
        if (this.streamingMsg) {
          this.finalizeStreamingMessage(this.pendingStreamContent, undefined, runId, action.ts || Date.now());
          this.streamingMsg = null;
        }
        this.pendingStreamContent = '';
        return;
      }

      if (action.kind === 'text.amend') {
        this.amendFinalizedMessage(runId, action.text || '');
        return;
      }

      if (action.kind === 'text.discard') {
        const existing = this.messages.querySelector('.streaming-msg');
        if (existing) existing.remove();
        this.streamingMsg = null;
        this.pendingStreamContent = '';
        return;
      }

      if (action.kind === 'thinking') {
        this.updateLiveThinking(runId, action.text || '');
        return;
      }

      if (action.kind === 'tool.start' || action.kind === 'tool.update' || action.kind === 'tool.result') {
        const tool = action.tool || {};
        const phase = action.kind === 'tool.start' ? 'start' : (action.kind === 'tool.update' ? 'update' : 'result');
        const previewOwner = this.previewOwnerForRun(runId);
        const payload = {
          runId,
          data: {
            toolCallId: tool.id || tool.key || '',
            phase,
            name: tool.name || 'tool',
            args: tool.arguments || {},
            result: tool.result || '',
            isError: tool.status === 'error' || !!tool.error,
            error: tool.error || ''
          }
        };
        window.dispatchEvent(new CustomEvent('vo:agent-tool-preview', {
          detail: {
            agentId: previewOwner.agentId,
            sessionKey: previewOwner.sessionKey,
            slotId: previewOwner.slotId,
            runId,
            phase,
            tool: {
              id: tool.id || tool.key || '',
              name: tool.name || 'tool',
              arguments: tool.arguments || {},
              result: tool.result || '',
              status: tool.status || (phase === 'result' ? 'completed' : 'running'),
              error: tool.error || ''
            }
          }
        }));
        if (this.universalRuns.has(runId)) {
          // Universal steps carry a title, exit code and time (design 4.2 "Tool rows").
          if (tool.title) payload.data.name = tool.title;
          const meta = [];
          if (Number.isFinite(tool.exitCode)) meta.push('exit ' + tool.exitCode);
          if (Number.isFinite(tool.ms)) meta.push((tool.ms / 1000).toFixed(tool.ms < 10000 ? 1 : 0) + ' s');
          if (meta.length && action.kind === 'tool.result') {
            if (payload.data.isError) payload.data.error = (payload.data.error ? payload.data.error + '\n' : '') + meta.join(' · ');
            else payload.data.result = (payload.data.result ? payload.data.result + '\n' : '') + meta.join(' · ');
          }
        }
        if (action.kind === 'tool.start') this.appendToolCall(payload);
        else if (action.kind === 'tool.update') this.updateToolCall(payload);
        else {
          this.finishToolCall(payload);
          this.foldUniversalTools(runId);
        }
        return;
      }

      // Universal kinds (chat-universal.js -> chat-events.js): status line,
      // plan card, cards that settle everywhere.
      if (action.kind === 'status') {
        const text = globalThis.ChatCards ? ChatCards.statusText(action.phase) : String(action.phase || '');
        if (/^Waiting for your/.test(text)) { this.showWaitingForYou(/answer/.test(text) ? 'question' : 'approval', runId); return; }
        this.setRunState('running', text, runId);
        // The typing line follows (a retry, compacting): it never stays on "starting" (N6).
        if (text && this.messages?.querySelector('.typing-indicator')) this.updateTypingIndicator(text);
        return;
      }
      if (action.kind === 'plan') {
        this.renderPlanCard(action.plan);
        return;
      }
      if (action.kind === 'usage') {
        this.lastUsage = action.usage || null;
        this.renderContextMeter();
        return;
      }
      if ((action.kind === 'approval' && action.provider === 'universal') ||
          ['approval.resolved', 'question', 'question.resolved'].includes(action.kind)) {
        if (globalThis.ChatCards) this.applyUniversalCardAction(action);
        if (action.kind === 'approval.resolved' || action.kind === 'question.resolved') this.stopWaitingForYou(runId);
        return;
      }

      if (action.kind === 'approval') {
        this.showWaitingForYou('approval', runId);
        if (action.provider === 'codex') this.appendCodexPendingApproval(action.approval, action.approval?.pending_count || 1);
        else if (action.provider === 'hermes') this.appendHermesPendingApproval(action.approval, action.approval?.pending_count || 1);
        else {
          const approvalId = action.approval?.id || action.approval?.approval_id || '';
          const selector = approvalId ? `[data-approval-id="${CSS.escape(approvalId)}"]` : '';
          if (!selector || !this.messages.querySelector(selector)) {
            this.appendMessage('assistant', '', Date.now(), [], {
              label: this.agentSelect?.selectedOptions?.[0]?.textContent.trim() || action.provider || 'Provider',
              kind: 'agent',
              approval: action.approval
            }, []);
          }
        }
        return;
      }

      if (action.kind === 'run.terminal') {
        this.finishRunUi(runId, action.status, action.error || '');
        this.onRunTerminal(runId, action.status, action.error || '');
        if (this.universalRuns.has(runId)) this.afterUniversalTerminal(runId, action);
      }
    }

    afterUniversalTerminal(runId, action) {
      if (action.fix && this.lastRunError?.runId === runId && this.lastRunError.el?.isConnected) {
        const bubble = this.lastRunError.el.querySelector('.chat-error-bubble');
        if (bubble && !bubble.querySelector('.chat-error-fix')) {
          const fix = document.createElement('div');
          fix.className = 'chat-error-fix';
          fix.textContent = action.fix;
          bubble.insertBefore(fix, bubble.querySelector('.chat-error-actions'));
        }
      }
      for (const [id, dialog] of [...this.secretDialogs.entries()]) {
        if (!this.turnEvents.get(runId)?.questions?.has(id)) continue;
        dialog.close();
      }
      this.foldUniversalTools(runId);
      if (Array.isArray(action.media) && action.media.length) this.attachRunMedia(runId, action.media);
      const done = this.serveRunWaiters.get(runId);
      if (done) done();
    }

    /**
     * Media a run ended with (the hub's signed links, design 2.11): under the
     * run's answer, or as their own message when the answer had no words.
     */
    attachRunMedia(runId, items) {
      const media = normalizeChatMedia(items);
      if (!media.length || !this.messages) return null;
      const segment = [...this.messages.querySelectorAll('.chat-stream-segment')].reverse()
        .find(el => el.dataset.runId === String(runId));
      const bubble = segment?.querySelector('.chat-bubble');
      if (!bubble) {
        const appended = this.appendMessage('assistant', '', Date.now(), media);
        if (appended) {
          appended.classList.add('chat-stream-segment');
          appended.dataset.runId = String(runId || '');
        }
        return appended;
      }
      const shown = new Set([...bubble.querySelectorAll('.chat-media-item [src], .chat-media-item [href]')]
        .map(node => node.getAttribute('src') || node.getAttribute('href')));
      const fresh = media.filter(item => !shown.has(item.url));
      if (fresh.length) bubble.insertBefore(renderChatMedia(fresh), bubble.querySelector('.chat-markdown, .chat-message-content') || bubble.querySelector('.chat-time'));
      return segment;
    }

    /** Finished steps beyond the last 3 fold into "✓ N steps" (design 4.2 "Tool rows"). */
    foldUniversalTools(runId) {
      if (!globalThis.ChatCards || !runId || !this.universalRuns.has(runId)) return;
      const live = new Set(this.liveToolCards.values());
      ChatCards.foldTools(this.messages, runId, { keep: 3, isLive: row => live.has(row) });
    }

    finishRunUi(runId, status = 'completed', errorText = '') {
      this.flushStreamingRender(true);
      if (this.streamingMsg) {
        const text = this.pendingStreamContent || this.streamingMsg.content || '';
        if (text.trim()) this.finalizeStreamingMessage(text, undefined, runId);
        else this.messages.querySelector('.streaming-msg')?.remove();
      }
      this.streamingMsg = null;
      this.pendingStreamContent = '';
      this.clearActivityFeed();
      this.removeTypingIndicator();
      this.settleLiveThinking(runId);
      this.finalizeRunToolCards(runId, status, errorText);
      if (runId) runOwners.delete(runId);
      if (!runId || this.currentRunId === runId) this.currentRunId = null;
      this.stopRecoveryWatchdog();
      this.scrollBottom();
    }

    settleLiveThinking(runId) {
      if (!this.liveThinkingEl) return;
      if (runId && this.liveThinkingEl.dataset.runId && this.liveThinkingEl.dataset.runId !== runId) return;
      this.liveThinkingEl.classList.remove('chat-thinking-live');
      this.liveThinkingEl.classList.add('chat-thinking-settled');
      const card = this.liveThinkingEl.querySelector('.chat-thinking-card');
      if (card) card.open = false;
      if (card?.classList.contains('hp-thinking-collapsed') && globalThis.ChatCards) {
        const title = card.querySelector('.chat-thinking-title');
        if (title) title.textContent = ChatCards.thoughtFor(Number(card.dataset.lastAt || Date.now()) - Number(card.dataset.startedAt || Date.now()));
      }
      this.liveThinkingEl = null;
      this.liveThinkingPre = null;
      this.liveThinkingRunId = '';
    }

    handleChatEvent(payload) {
      if (!this.ownsPayload(payload)) return;
      this.markLiveEvent();
      const text = extractText(payload);
      const runId = payload?.runId || this.currentRunId || 'openclaw-run';
      if (payload?.state === 'delta' || payload?.state === 'streaming') {
        if (text) this.applyTurnEvent({ kind: 'text.replace', runId, text });
        this.ensureRecoveryWatchdog();
      } else if (payload?.state === 'final' || payload?.state === 'done') {
        const finalText = text || this.pendingStreamContent || (this.streamingMsg ? this.streamingMsg.content : '');
        if (finalText) this.applyTurnEvent({ kind: 'text.replace', runId, text: finalText });
        this.applyTurnEvent({ kind: 'run.complete', runId });
        this.fetchContextUsage();
      } else if (payload?.state === 'error') {
        // CH-13: a failed run must never leave the chat silent. Keep any
        // partial text, then show the reason with Retry.
        if (text) this.applyTurnEvent({ kind: 'text.replace', runId, text });
        const errorText = payload.errorMessage || payload.error?.message || payload.error || payload.message?.errorMessage || 'Run failed';
        this.applyTurnEvent({ kind: 'run.failed', runId, error: String(errorText) });
        this.fetchContextUsage();
      } else if (payload?.state === 'aborted') {
        if (text) this.applyTurnEvent({ kind: 'text.replace', runId, text });
        this.applyTurnEvent({ kind: 'run.cancelled', runId });
      }
    }

    handleAgentEvent(payload) {
      if (!this.ownsPayload(payload)) return;

      const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
      const stream = payload?.stream || data.stream || '';
      const phase = data.phase || payload?.phase || '';
      const isToolLikeItem = stream === 'item' && (data.kind === 'command' || data.kind === 'tool');
      const runId = payload?.runId || data.runId || this.currentRunId || 'openclaw-run';

      const publicProgress = ChatEvents.normalizeOpenClawProgressEvent(payload, runId);
      if (publicProgress) {
        this.markLiveEvent();
        this.applyTurnEvent(publicProgress);
        this.ensureRecoveryWatchdog();
        return;
      }

      // Current OpenClaw emits tool activity as agent events:
      // { stream:"tool", data:{ phase:"start|update|result", name, toolCallId, args, result } }
      if (stream === 'tool' || isToolLikeItem || payload?.type === 'tool_start' || payload?.type === 'tool_end' || payload?.type === 'tool_result') {
        this.markLiveEvent();
        const tool = normalizeToolEvent(payload, phase === 'result' ? 'done' : 'running');
        const label = formatToolLabel(tool.name, coerceToolArgs(tool.arguments));
        this.updateTypingIndicator((phase === 'result' || phase === 'end' || payload?.type === 'tool_end' || payload?.type === 'tool_result') ? 'Processing...' : label);
        const isTerminal = phase === 'result' || phase === 'end' || payload?.type === 'tool_end' || payload?.type === 'tool_result';
        const isUpdate = phase === 'update';
        this.applyTurnEvent({ kind: isTerminal ? 'tool.result' : (isUpdate ? 'tool.update' : 'tool.start'), runId, tool });
        this.ensureRecoveryWatchdog();
        return;
      }

      if (payload?.type === 'thinking') {
        const thinking = data.thinking || data.text || payload?.thinking || payload?.text || '';
        if (this.applyDistinctThinking(runId, thinking)) this.updateTypingIndicator('Thinking...');
        return;
      }

      if (stream === 'lifecycle') {
        if (phase === 'start') {
          this.applyTurnEvent({ kind: 'run.start', runId, label: 'Thinking...' });
          this.ensureRecoveryWatchdog();
          return;
        }
        const normalizedPhase = String(phase || '').toLowerCase();
        if (['error', 'failed', 'failure'].includes(normalizedPhase)) {
          this.applyTurnEvent({ kind: 'run.failed', runId, error: data.error || payload?.error || 'Run failed' });
        } else if (['cancel', 'cancelled', 'canceled', 'aborted', 'interrupted'].includes(normalizedPhase)) {
          this.applyTurnEvent({ kind: 'run.cancelled', runId });
        } else if (['end', 'done', 'complete', 'completed', 'finish', 'finished'].includes(normalizedPhase)) {
          this.applyTurnEvent({ kind: 'run.complete', runId });
        }
      }
    }

    markLiveEvent() {
      this.lastLiveEventAt = Date.now();
    }

    scheduleStreamingRender() {
      if (this.streamRenderTimer) return;
      this.streamRenderTimer = setTimeout(() => this.flushStreamingRender(), STREAM_RENDER_INTERVAL_MS);
    }

    flushStreamingRender(force = false) {
      if (this.streamRenderTimer) { clearTimeout(this.streamRenderTimer); this.streamRenderTimer = null; }
      if (!this.streamingMsg) return;
      if (!force && this.pendingStreamContent === this.streamingMsg.content) return;
      this.streamingMsg.content = this.pendingStreamContent || this.streamingMsg.content || '';
      this.updateStreamingMessage(this.streamingMsg.content);
      this.scrollBottom();
    }

    pruneToolCards() {
      const cards = [...this.messages.querySelectorAll('.chat-tool-msg')];
      const extra = cards.length - MAX_LIVE_TOOL_CARDS;
      if (extra <= 0) return;
      for (const el of cards.slice(0, extra)) {
        const key = el.dataset.toolKey;
        if (key) this.liveToolCards.delete(key);
        el.remove();
      }
      let notice = this.messages.querySelector('.chat-tool-pruned-notice');
      if (!notice) {
        notice = document.createElement('div');
        notice.className = 'chat-msg system chat-tool-pruned-notice';
        notice.innerHTML = '<div class="chat-bubble system-bubble">Earlier live tool activity was collapsed to keep the chat responsive.</div>';
        this.messages.prepend(notice);
      }
    }

    ensureRecoveryWatchdog() {
      if (this.recoveryTimer) return;
      this.lastLiveEventAt = this.lastLiveEventAt || Date.now();
      this.recoveryTimer = setInterval(() => {
        const waiting = this.runState && ['sending', 'running'].includes(this.runState.state);
        if (!this.currentRunId && !this.streamingMsg && !this.liveToolCards.size && !waiting && !this.messages.querySelector('.typing-indicator')) return this.stopRecoveryWatchdog();
        if (!connected || document.hidden) return;
        if (Date.now() - this.lastLiveEventAt > ACTIVE_RUN_RECOVERY_MS) {
          this.lastLiveEventAt = Date.now();
          this.loadHistory({ recoverFinal: true }).catch(() => {});
        }
      }, ACTIVE_RUN_RECOVERY_MS);
    }

    stopRecoveryWatchdog() {
      if (this.recoveryTimer) { clearInterval(this.recoveryTimer); this.recoveryTimer = null; }
    }

    handleSessionMessageEvent(payload) {
      if (!this.ownsPayload(payload)) return;
      const msg = payload?.message && typeof payload.message === 'object' ? payload.message : payload;
      const role = msg?.role || payload?.role || '';
      if (role === 'assistant') {
        this.markLiveEvent();
        return this.loadHistory({ recoverFinal: true });
      } else if (role === 'user') {
        this.markLiveEvent();
      }
    }

    appendMessage(role, content, ts, mediaItems, meta = {}, toolItems = []) {
      const div = document.createElement('div');
      div.className = `chat-msg ${role}`;
      if (role === 'assistant') div.dataset.providerKind = this.getSelectedProviderKind() || 'openclaw';
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      let displayContent = content || '';
      let deliveryEnvelope = '';
      let systemEvents = [];
      if (role === 'user') {
        const split = splitSystemEvents(displayContent);
        if (split.events.length) {
          systemEvents = split.events;
          displayContent = split.text;
        }
      }
      const envelope = parseA2AEnvelope(displayContent);
      if (envelope) {
        displayContent = envelope.text;
        // CH-21: a message the user typed, wrapped by the server for routing,
        // is shown as the user's own words.
        meta = envelope.isUser
          ? { ...meta, label: 'You', toLabel: '', kind: 'human' }
          : { ...meta, label: envelope.label, toLabel: envelope.toLabel || meta.toLabel, kind: 'agent' };
        deliveryEnvelope = String(content || '');
      }
      if (role === 'user') {
        const stripped = stripDeliveryEnvelope(displayContent);
        if (stripped !== displayContent) {
          deliveryEnvelope = deliveryEnvelope || displayContent;
          displayContent = stripped;
        }
      }
      if (role === 'assistant' && meta.thinking && String(meta.thinking).trim() === String(displayContent || '').trim()) {
        meta = { ...meta, thinking: '', reasoningTokens: 0 };
      }
      meta = normalizeSenderMeta(meta, role, this);
      if (meta.kind) div.dataset.senderKind = meta.kind;
      if (role === 'tool' && displayContent.length > 3000) {
        displayContent = displayContent.substring(0, 2000) + '\n\n... [truncated - ' + displayContent.length + ' chars total] ...';
      }
      const extractedMedia = extractMedia({ content: displayContent }, displayContent);
      const media = normalizeChatMedia([...(mediaItems || []), ...extractedMedia]);
      displayContent = displayContent.split(/\r?\n/).filter(line => {
        const t = line.trim();
        return !(t.match(/^\(attached file:\s*(.+?)\)$/i) || t.match(/^attached file:\s*(.+)$/i) || t.match(/^MEDIA:/i));
      }).join('\n').trim();
      if (media.length) {
        bubble.appendChild(renderChatMedia(media));
      }
      const senderHeader = renderSenderHeader(meta, role);
      if (senderHeader) bubble.appendChild(senderHeader);
      if (role === 'assistant' && (meta.thinking || meta.reasoningTokens)) {
        bubble.appendChild(renderThinkingCard(meta.thinking || `Reasoning trace stored by Hermes provider. Reasoning tokens: ${meta.reasoningTokens}`));
      }
      if (role === 'assistant' && meta.approval) {
        bubble.appendChild(renderHermesApprovalCard(meta.approval, this));
      }
      if (displayContent.trim()) {
        const textDiv = document.createElement('div');
        textDiv.className = 'chat-message-content chat-markdown';
        renderMarkdownInto(textDiv, displayContent);
        bubble.appendChild(textDiv);
        if (role === 'user' || role === 'assistant') div.dataset.copyText = displayContent;
      }
      if (deliveryEnvelope) bubble.appendChild(renderEnvelopeDetails(deliveryEnvelope));
      for (const tool of toolItems) bubble.appendChild(renderToolCallCard(tool, { historical: true }));
      // P3-6: Copy sits on the time's line (floated left of it), never over the time.
      if (div.dataset.copyText) bubble.appendChild(renderMessageCopyButton());
      if (ts) {
        const time = document.createElement('span');
        time.className = 'chat-time';
        time.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        bubble.appendChild(time);
      }
      if (systemEvents.length) {
        // Its own row above the bubble (same .chat-msg, so history windowing keeps them together).
        div.classList.add('has-system-events');
        div.appendChild(renderSystemEventsRow(systemEvents));
      }
      const bubbleHasContent = !!(displayContent.trim() || media.length || deliveryEnvelope || toolItems.length ||
        (role === 'assistant' && (meta.thinking || meta.reasoningTokens || meta.approval)));
      if (bubbleHasContent || !systemEvents.length) div.appendChild(bubble);
      else div.classList.add('system-events-only');
      const target = this.renderTarget || this.messages;
      if (target === this.messages) {
        this.removeTypingIndicator();
        this.messages.querySelector('.chat-empty-state')?.remove();
      }
      target.appendChild(div);
      if (target === this.messages && !this.renderingHistory && this.followLatest &&
        this.messages.childElementCount > MAX_RENDERED_HISTORY_MESSAGES * 1.5) this.windowHistoryDom();
      return div;
    }

    appendStreamingMessage(runId = '') {
      this.removeTypingIndicator();
      const existing = this.messages.querySelector('.streaming-msg');
      if (existing) existing.classList.remove('streaming-msg');
      const div = document.createElement('div');
      div.className = 'chat-msg assistant streaming-msg';
      div.dataset.runId = runId || this.currentRunId || '';
      div.dataset.providerKind = this.getSelectedProviderKind() || 'openclaw';
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble streaming';
      const text = document.createElement('div');
      text.className = 'chat-message-content chat-markdown streaming-text';
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      cursor.textContent = '▊';
      bubble.appendChild(text);
      bubble.appendChild(cursor);
      div.appendChild(bubble);
      this.messages.appendChild(div);
      this.scrollBottom();
    }

    updateStreamingMessage(content) {
      const div = this.messages.querySelector('.streaming-msg');
      if (!div) return;
      const bubble = div.querySelector('.chat-bubble');
      let text = bubble.querySelector('.streaming-text');
      if (!text) {
        text = document.createElement('div');
        text.className = 'chat-message-content chat-markdown streaming-text';
        const cursor = document.createElement('span');
        cursor.className = 'cursor';
        cursor.textContent = '▊';
        bubble.appendChild(text);
        bubble.appendChild(cursor);
      }
      renderMarkdownInto(text, content || '');
    }

    finalizeStreamingMessage(content, mediaItems, runId = '', ts = Date.now()) {
      const div = this.messages.querySelector('.streaming-msg');
      if (!div) {
        const appended = this.appendMessage('assistant', content, Date.now(), mediaItems);
        if (appended) {
          appended.classList.add('chat-stream-segment');
          appended.dataset.runId = runId || this.currentRunId || '';
        }
        return appended;
      }
      const bubble = div.querySelector('.chat-bubble');
      bubble.classList.remove('streaming');
      let textDiv = bubble.querySelector('.streaming-text');
      const cursor = bubble.querySelector('.cursor');
      const finalContent = content || '';
      if (textDiv) renderMarkdownInto(textDiv, finalContent);
      cursor?.remove();
      textDiv?.classList.remove('streaming-text');
      const senderHeader = renderSenderHeader(normalizeSenderMeta({}, 'assistant', this), 'assistant');
      if (senderHeader) bubble.insertBefore(senderHeader, textDiv || bubble.firstChild);
      const media = normalizeChatMedia(mediaItems || extractMedia({ content }, content));
      if (media.length) {
        const renderedMedia = renderChatMedia(media);
        bubble.insertBefore(renderedMedia, textDiv || bubble.querySelector('.chat-time'));
      }
      if (!finalContent.trim()) {
        textDiv?.remove();
      } else if (!textDiv) {
        textDiv = document.createElement('div');
        textDiv.className = 'chat-message-content chat-markdown';
        renderMarkdownInto(textDiv, finalContent);
        bubble.appendChild(textDiv);
      }
      const time = document.createElement('span');
      time.className = 'chat-time';
      time.textContent = new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      bubble.appendChild(time);
      div.classList.remove('streaming-msg');
      div.classList.add('chat-stream-segment');
      div.dataset.runId = runId || div.dataset.runId || this.currentRunId || '';
      return div;
    }

    amendFinalizedMessage(runId, content) {
      const segments = [...this.messages.querySelectorAll('.chat-stream-segment')];
      const div = segments.reverse().find(item => !runId || item.dataset.runId === String(runId));
      if (!div) return this.finalizeStreamingMessage(content, undefined, runId);
      const bubble = div.querySelector('.chat-bubble');
      if (!bubble) return;
      let textDiv = bubble.querySelector('.chat-markdown, .chat-message-content');
      if (!textDiv) {
        textDiv = document.createElement('div');
        textDiv.className = 'chat-message-content chat-markdown';
        const time = bubble.querySelector('.chat-time');
        bubble.insertBefore(textDiv, time || null);
      }
      renderMarkdownInto(textDiv, content || '');
      div.classList.remove('chat-stream-segment-settling');
      void div.offsetWidth;
      div.classList.add('chat-stream-segment-settling');
      this.scrollBottom();
    }

    appendSystem(text) {
      const div = document.createElement('div');
      div.className = 'chat-msg system';
      div.innerHTML = `<div class="chat-bubble system-bubble">${escHtml(text)}</div>`;
      this.messages.appendChild(div);
      this.scrollBottom();
    }

    appendSystemIfMissing(prefix, error) {
      const message = String(error || '').trim();
      if (!message) return;
      const recent = [...this.messages.querySelectorAll('.chat-msg')].slice(-4);
      if (recent.some((item) => String(item.textContent || '').includes(message))) return;
      this.appendSystem(prefix + message);
    }

    updateTypingIndicator(text, { still = false } = {}) {
      // The moving dots are the ellipsis: a text's own "..." would double it ("starting......", N6).
      text = String(text == null ? '' : text).replace(/\s*(?:\u2026|\.{2,})\s*$/, '');
      let ind = this.messages.querySelector('.typing-indicator');
      if (!ind) {
        ind = document.createElement('div');
        ind.className = 'chat-msg assistant typing-indicator';
        ind.innerHTML = `<div class="chat-bubble typing"><span class="typing-text">${escHtml(text)}</span><span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></div>`;
        this.messages.appendChild(ind);
      } else {
        ind.querySelector('.typing-text').textContent = text;
      }
      // Waiting on you is not work in progress: no moving dots.
      const dots = ind.querySelector('.typing-dots');
      if (dots) dots.hidden = !!still;
      this.scrollBottom();
    }

    /** N6: an approval or question card waits on the user; both status lines say so. */
    showWaitingForYou(kind, runId = '') {
      const text = kind === 'question' ? 'Waiting for your answer' : 'Waiting for your OK';
      this.setRunState('running', text, runId || this.currentRunId || '');
      if (this.messages?.querySelector('.typing-indicator')) this.updateTypingIndicator(text, { still: true });
    }

    stopWaitingForYou(runId = '') {
      if (!/^Waiting for your/.test(this.runState?.text || '')) return;
      if (this.messages?.querySelector('.hp-approval-card:not([data-state="settled"]), .hp-question-card:not([data-state="settled"])')) return;
      this.setRunState('running', '', runId);
      if (this.messages?.querySelector('.typing-indicator')) this.updateTypingIndicator('Working on it');
    }

    removeTypingIndicator() {
      const ind = this.messages.querySelector('.typing-indicator');
      if (ind) ind.remove();
    }

    clearActivityFeed() { this.messages.querySelectorAll('.chat-activity').forEach(el => el.remove()); }

    closeNativeEventSource(provider) {
      const cfg = NATIVE_PROVIDER_UI[provider];
      if (!cfg) return;
      const source = this[cfg.sourceProperty];
      if (source) {
        try { source.close(); } catch (_) {}
        this[cfg.sourceProperty] = null;
      }
    }

    closeHermesEventSource() { this.closeNativeEventSource('hermes'); }
    closeCodexEventSource() { this.closeNativeEventSource('codex'); }
    closeClaudeCodeEventSource() { this.closeNativeEventSource('claude-code'); }

    closeProviderEventSource() {
      if (this.providerEventSource) {
        try { this.providerEventSource.close(); } catch (_) {}
        this.providerEventSource = null;
      }
    }

    providerHistorySignatureFor(messages) {
      return JSON.stringify((messages || []).slice(-4).map(msg => [
        msg.role, msg.ts, msg.runId, msg.progressId, msg.sessionId, msg.activeSession,
        msg.text, msg.thinking, msg.approval?.id || msg.approval?.approval_id || '', msg.tools
      ]));
    }

    startProviderHistoryPolling() {
      if (!this.isGenericProviderSelected() || this.providerHistoryPollTimer) return;
      this.providerHistoryPollTimer = setInterval(() => {
        this.runGuardedPoll('provider-history', () => this.pollProviderActiveSession()).catch(() => {});
      }, 3000);
    }

    stopProviderHistoryPolling() {
      if (this.providerHistoryPollTimer) clearInterval(this.providerHistoryPollTimer);
      this.providerHistoryPollTimer = null;
      this.providerHistorySignature = '';
    }

    async pollProviderActiveSession() {
      const fence = this.selectionFence();
      const selectedKey = this.sessionKey;
      if (this.sessionSelectionPending) return;
      if (!this.isGenericProviderSelected() || !this.isVisibleForPolling() || this.currentRunId) return;
      const params = new URLSearchParams({ agentId: this.getSelectedAgentId() || this.selectedAgentKey });
      const selectedHistorySessionId = this.selectedProviderHistorySessionId();
      if (selectedHistorySessionId) params.set('sessionId', selectedHistorySessionId);
      const response = await fetch('/api/provider-history?' + params.toString(), { cache:'no-store' });
      const data = await response.json();
      if (fence !== this.selectionFence() || selectedKey !== this.sessionKey || this.sessionSelectionPending) return;
      if (!response.ok || !data.ok) return;
      const signature = this.providerHistorySignatureFor(data.messages || []);
      if (signature && signature !== this.providerHistorySignature) {
        this.providerHistorySignature = signature;
        await this.loadHistory();
        await this.refreshSessionsList();
      }
    }

    streamProviderRunEvents(runId) {
      if (!runId) return Promise.reject(new Error('Provider SDK did not return a run id'));
      this.closeProviderEventSource();
      this.currentRunId = runId;
      this.markLiveEvent();
      const url = '/api/provider-runs/' + encodeURIComponent(runId) + '/events';
      return this.followRunStream({
        url,
        runId,
        provider: 'provider-sdk',
        sourceProperty: 'providerEventSource',
        eventNames: ['run.started', 'turn.progress', 'run.completed', 'run.failed', 'run.cancelled', 'run.canceled'],
        failureMessage: 'Provider SDK stream disconnected',
        handle: (eventName, data) => this.handleProviderSdkEvent(eventName, data)
      });
    }

    // Shared EventSource follower for provider and native runs (CH-16):
    // - the server replays a run's buffered events from the start on every
    //   connection, so events are de-duplicated by their SSE id;
    // - a dropped connection gets RUN_STREAM_RETRY_MS of browser retries
    //   before the run counts as disconnected;
    // - closing or switching the window settles the promise ("detached")
    //   instead of leaving the send waiting forever.
    // ── Universal chat (Hermes over `hermes serve`): design 2.5, 2.6, 4.2 ──

    chatFetch(path, params, body) {
      const url = params ? path + '?' + new URLSearchParams(params).toString() : path;
      const init = { cache: 'no-store', credentials: 'same-origin' };
      if (body !== undefined) {
        init.method = 'POST';
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      return fetch(url, init).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        return { res, data: data && typeof data === 'object' ? data : {} };
      });
    }

    /** Post an answer; resolves {ok, notPending, error} for chat-cards.js. */
    async postChatAnswer(path, body) {
      try {
        const { res, data } = await this.chatFetch(path, null, body);
        if (res.ok && data.ok !== false) return { ok: true };
        if (res.status === 409 || data.error === 'not_pending') return { ok: false, notPending: true };
        return { ok: false, error: data.message || data.error || res.statusText || ('HTTP ' + res.status) };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    }

    chatStreamKey() {
      return this.chatAgentId() + '\u0000' + this.agentChatSession();
    }

    /**
     * Who follows `/api/agent-chat/events`: `hermes serve` chats (everything),
     * and OpenClaw chats with a manifest for their approval / question cards
     * (their reply text keeps coming over /api/openclaw/events; design 2.9).
     */
    usesChatStream() {
      if (this.isServeHermesSelected()) return true;
      const view = this.serverCapsView();
      return !!(view && view.transport === 'openclaw' && this.isNativeOpenClawSelected() && (view.approvals || view.questions));
    }

    /** "Reconnecting to the office..." while the chat's event stream is down (design 4.4). */
    setStreamBanner(on) {
      if (!this.root) return;
      let el = this.root.querySelector('.hp-stream-line');
      if (!on) {
        if (el && !el.hidden) el.hidden = true;
        return;
      }
      if (!el) {
        el = document.createElement('div');
        el.className = 'hp-stream-line';
        el.setAttribute('role', 'status');
        el.textContent = 'Reconnecting to the office...';
        const anchor = this.root.querySelector('.hp-conn-line') || this.root.querySelector('.chat-attachments-preview') || this.root.querySelector('.chat-input-row');
        if (anchor?.parentNode) anchor.parentNode.insertBefore(el, anchor);
        else this.root.appendChild(el);
      }
      el.hidden = false;
    }

    closeChatStream() {
      this.setStreamBanner(false);
      const stream = this.chatStream;
      this.chatStream = null;
      if (stream) { try { stream.source.close(); } catch (_) {} }
    }

    /**
     * The chat's own event stream (`/api/agent-chat/events?agent&session`).
     * The browser resumes with Last-Event-ID by itself; a closed stream is
     * reopened with `?since=<last seq>`.  A chat not created yet has none.
     */
    openChatStream({ since = null } = {}) {
      if (!this.usesChatStream() || typeof EventSource === 'undefined' || !this.universal) return null;
      const agent = this.chatAgentId();
      const session = this.agentChatSession();
      if (!agent || !session) { this.closeChatStream(); return null; }
      const key = agent + '\u0000' + session;
      if (this.chatStream && this.chatStream.key === key && this.chatStream.source.readyState !== 2) return this.chatStream;
      this.closeChatStream();
      const params = new URLSearchParams({ agent, session });
      if (globalThis.VOSave?.pageId) params.set('client', globalThis.VOSave.pageId); // stream slots count per page
      const from = since !== null ? since : this.universal.lastSeq;
      if (Number.isInteger(from)) params.set('since', String(from));
      const source = new EventSource('/api/agent-chat/events?' + params.toString(), { withCredentials: true });
      const stream = { key, source };
      this.chatStream = stream;
      source.onmessage = (evt) => {
        if (this.chatStream !== stream) return;
        let frame;
        try { frame = JSON.parse(evt.data); } catch (_) { return; }
        if (!frame || typeof frame !== 'object') return;
        const seq = Number(evt.lastEventId);
        if (!Number.isInteger(frame.seq) && evt.lastEventId && Number.isInteger(seq)) frame.seq = seq;
        this.chatStreamRetries = 0;
        this.setStreamBanner(false);
        this.handleUniversalFrame(frame);
      };
      source.onopen = () => { if (this.chatStream === stream) this.setStreamBanner(false); };
      source.addEventListener('resync', () => { if (this.chatStream === stream) this.resyncChat(); });
      source.onerror = () => {
        if (this.chatStream !== stream) return;
        // Dropped: the browser comes back with Last-Event-ID by itself; say so meanwhile (design 4.4).
        this.setStreamBanner(true);
        if (source.readyState !== 2) return;
        this.chatStream = null;
        this.chatStreamRetries = (this.chatStreamRetries || 0) + 1;
        const delay = Math.min(15000, 1000 * 2 ** Math.min(this.chatStreamRetries, 4));
        setTimeout(() => {
          if (this.chatStream || !this.isVisibleForPolling() || this.chatStreamKey() !== key) {
            if (!this.chatStream) this.setStreamBanner(false);
            return;
          }
          this.openChatStream();
          // Connection frames sent while the stream was closed are not replayed: read the manifest again.
          if (this.can?.source === 'server') this.refreshCan().catch(() => {});
        }, delay);
      };
      return stream;
    }

    /** One SSE frame: turn frames feed the reducer; others go to their part of the window. */
    handleUniversalFrame(frame) {
      if (!this.universal || !globalThis.ChatUniversal) return;
      const route = ChatUniversal.route(frame);
      if (route === 'turn') {
        for (const event of this.universal.toReducer(frame)) this.applyUniversalEvent(event);
        return;
      }
      if (route === 'resync') { this.resyncChat(); return; }
      const event = ChatUniversal.unwrap(frame).event;
      if (route === 'provider') this.applyProviderStatus(event);
      else if (route === 'activity') this.applyAgentActivity(event);
      else if (route === 'native' && (event?.op === 'title' || event?.ev?.op === 'title')) this.applyLiveTitle(event.ev || event);
      else if (route === 'tasks') this.sidePanel?.onTask(event);
    }

    applyUniversalEvent(event) {
      if (!event || !event.kind) return;
      const runId = String(event.runId || '');
      // A redirected message's own run ends empty: the running turn answers it.
      if (runId && this.steeredRuns.has(runId)) return;
      if (runId) {
        this.universalRuns.add(runId);
        if (!runOwners.has(runId)) this.registerRunOwner(runId);
      }
      this.markLiveEvent();
      if (event.kind === 'run.start' && runId && !this.turnEvents.get(runId)?.terminal) {
        this.currentRunId = runId;
        if (!this.runState || !['sending', 'running'].includes(this.runState.state)) this.setRunState('running', '', runId);
      }
      this.applyTurnEvent(event);
    }

    applyProviderStatus(event) {
      const state = String(event?.state || event?.status || '').trim();
      if (!state || !this.can || this.can.source !== 'server') return;
      // A manifest read while the link was down is a failure one: read it again once the link is back.
      if (!this.can.ok) { if (state === 'connected') this.refreshCan().catch(() => {}); return; }
      const before = this.can.connection.state;
      this.can = { ...this.can, connection: { ...this.can.connection, state, detail: String(event.detail || ''), fix: String(event.fix || '') } };
      this.capsView = ChatCaps.derive(this.can);
      this.renderConnectionLine();
      // The link dropped while an answer was coming: if that answer is over when it is back, say it may be cut off.
      const runId = String(this.currentRunId || '');
      if (state !== 'connected' && runId && this.universalRuns.has(runId) && !this.turnEvents.get(runId)?.terminal) {
        this.linkLostRun = { runId, fence: this.selectionFence(), name: this.can.connection.name || 'the agent' };
      }
      if (state === 'connected' && before && before !== 'connected') this.resyncChat({ statusKnown: true });
    }

    /** `resync` or a reconnect: forget what the stream said and read history + state again. */
    resyncChat({ statusKnown = false } = {}) {
      this.closeChatStream();
      this.universal?.reset();
      // Connection frames sent while the stream was away are not replayed: read the manifest again.
      if (!statusKnown && this.can?.source === 'server') this.refreshCan().catch(() => {});
      if (this.isVisibleForPolling()) this.loadHistory().catch(() => {});
    }

    /** After a reconnect: the answer that was coming when the link dropped ended meanwhile; give it a reason row. */
    noteLinkLostRun(liveRuns) {
      const lost = this.linkLostRun;
      if (!lost) return;
      if (lost.fence !== this.selectionFence()) { this.linkLostRun = null; return; }
      if (liveRuns.some(run => String(run.runId) === lost.runId)) return;
      this.linkLostRun = null;
      if (this.lastRunError?.runId === lost.runId) return;
      this.showRunError(`The connection to ${lost.name} was lost during this answer, so it may be cut off.`, { runId: lost.runId });
    }

    /**
     * After history: read `/state`, rebuild the runs still going (answer so far,
     * steps, open cards, plan) and follow the stream from the snapshot's seq.
     */
    async reattachChat() {
      const agent = this.chatAgentId();
      const session = this.agentChatSession();
      if (!agent || !session || !this.universal) return;
      const fence = this.selectionFence();
      let state = null;
      try {
        const { res, data } = await this.chatFetch('/api/agent-chat/state', { agent, session });
        if (res.ok && data.ok !== false && Number.isInteger(data.seq)) state = data;
      } catch (_) {}
      if (fence !== this.selectionFence() || session !== this.agentChatSession()) return;
      if (!state) {
        this.openChatStream();
        return;
      }
      const ended = new Set(['ok', 'stopped', 'error', 'interrupted', 'completed', 'failed', 'cancelled']);
      const live = (Array.isArray(state.runs) ? state.runs : []).filter((run) => run && run.runId && !ended.has(String(run.status || '')));
      this.noteLinkLostRun(live);
      this.closeChatStream();
      this.universal.reset();
      for (const run of live) this.turnEvents.reset(String(run.runId));
      for (const event of this.universal.seed({ ...state, runs: live })) this.applyUniversalEvent(event);
      // OpenClaw's task card stays in its own progress panel (session-progress.js).
      if (state.plan && this.isServeHermesSelected()) this.renderPlanCard(state.plan);
      this.openChatStream({ since: state.seq });
    }

    async loadServeHistory(guard) {
      const agent = this.chatAgentId();
      const session = this.selectedProviderSessionId();
      if (!session) {
        // A chat not created yet: nothing to read; the first message creates it.
        this.closeChatStream();
        this.universal?.reset();
        this.renderPlanCard(null);
        this.renderHistoryItems([]);
        this.historyDirty = false;
        this.afterHistoryRendered([]);
        return 'rendered';
      }
      const { res, data } = await this.chatFetch('/api/agent-chat/history', { agent, session });
      if (guard.historyRequestIsStale()) { this.markHistoryDirty(); return guard.staleResult(); }
      if (guard.finalArrivedMeanwhile()) return 'retry';
      if (!res.ok || data.ok === false || !Array.isArray(data.messages)) throw new Error(data.message || data.error || res.statusText || 'History unavailable');
      const messages = data.messages.map(msg => (msg && typeof msg === 'object' ? {
        ...msg,
        text: typeof msg.text === 'string' ? msg.text : (typeof msg.content === 'string' ? msg.content : ''),
        attachments: msg.attachments || msg.media || []
      } : {}));
      this.renderPlanCard(data.plan || null);
      this.renderHistoryItems(this.providerHistoryItems(messages, 'hermes-progress'));
      this.scrollBottomAfterLayout();
      this.historyDirty = false;
      this.afterHistoryRendered(messages);
      await this.reattachChat();
      return 'rendered';
    }

    /** Resolves when `runId` ends (or the window leaves this chat). */
    waitForServeRun(runId) {
      const fence = this.selectionFence();
      return new Promise((resolve) => {
        const done = () => { clearInterval(timer); this.serveRunWaiters.delete(runId); resolve(); };
        const timer = setInterval(() => {
          if (fence !== this.selectionFence() || !this.isVisibleForPolling()) done();
        }, 1000);
        this.serveRunWaiters.set(runId, done);
      });
    }

    releaseServeWaiters(runId = '') {
      for (const [id, done] of [...this.serveRunWaiters.entries()]) {
        if (!runId || id === runId) done();
      }
    }

    async sendServeMessage({ text, files = [], sessionKey, stillCurrent }) {
      const label = this.agentSelect?.selectedOptions?.[0]?.textContent.trim() || 'Hermes';
      const agent = this.chatAgentId();
      const session = this.selectedProviderSessionId();
      const failedRunId = `serve-failed-${Date.now()}`;
      this.updateTypingIndicator(label + ' is starting…');
      let data;
      try {
        const sent = await this.chatFetch('/api/agent-chat/runs', null, {
          agent,
          session,
          text,
          files: files.map(f => ({ name: f.name, mimeType: f.mimeType, path: f.path, size: f.size })),
          clientId: `office-${Date.now()}-${Math.random().toString(36).slice(2)}`
        });
        data = sent.data;
        if (!sent.res.ok || data.ok === false || !data.runId) {
          const error = new Error(data.message || data.error || sent.res.statusText || 'The message was not sent.');
          error.fix = data.fix || '';
          throw error;
        }
      } catch (error) {
        if (!stillCurrent()) return;
        this.removeTypingIndicator();
        this.applyTurnEvent({ kind: 'run.failed', runId: failedRunId, error: error.message, fix: error.fix || '' });
        return;
      }
      if (!stillCurrent()) return;
      const runId = String(data.runId);
      if (data.session?.key && this.sessionKey === sessionKey) this.adoptProviderSessionId(data.session.key);
      this.registerProviderRun(runId, this.sessionKey);
      this.universalRuns.add(runId);
      this.currentRunId = runId;
      this.markRunDelivered(runId);
      if (this.turnEvents.get(runId)?.terminal) return;
      const finished = this.waitForServeRun(runId);
      // A chat created by this message reads its stream from the start.
      if (!this.chatStream) this.openChatStream({ since: session ? null : 0 });
      await finished;
      if (this.sessionsPanelOpen) this.refreshSessionsList().catch(() => {});
    }

    async stopServeRun() {
      const runId = this.currentRunId || '';
      const { res, data } = await this.chatFetch('/api/agent-chat/stop', null, {
        agent: this.chatAgentId(), session: this.selectedProviderSessionId(), run: runId
      });
      if (!res.ok || data.ok === false) throw new Error(data.message || data.error || res.statusText);
      // The run may have ended while the request was out: never bring back a "Stopping…" line after it.
      if (runId && this.currentRunId === runId && !this.turnEvents.get(runId)?.terminal) this.setRunState('running', 'Stopping…', runId);
    }

    /** The plan / todo card above the composer (design 4.2 "Plan / todo"). */
    renderPlanCard(plan) {
      const normalized = plan && globalThis.ChatEvents?.normalizePlan ? ChatEvents.normalizePlan(plan) : null;
      if (!normalized || !normalized.steps?.length || !globalThis.ChatCards) {
        if (this.planCardEl) this.planCardEl.hidden = true;
        return;
      }
      const phone = (window.innerWidth || 1600) <= 600;
      if (!this.planCardEl || !this.planCardEl.isConnected) {
        this.planCardEl = ChatCards.planCard(normalized, { folded: phone });
        const anchor = this.root.querySelector('.hp-conn-line') || this.root.querySelector('.chat-attachments-preview') || this.root.querySelector('.chat-input-row');
        if (anchor?.parentNode) anchor.parentNode.insertBefore(this.planCardEl, anchor);
        else this.root.appendChild(this.planCardEl);
      } else {
        ChatCards.updatePlanCard(this.planCardEl, normalized);
      }
      this.planCardEl.hidden = false;
    }

    /** Approval / question cards and the secret dialog for universal runs. */
    applyUniversalCardAction(action) {
      const runId = String(action.runId || '');
      const agent = this.chatAgentId();
      const session = this.agentChatSession();
      const place = (el) => {
        this.messages.querySelector('.chat-empty-state')?.remove();
        const ind = this.messages.querySelector('.typing-indicator');
        if (ind) this.messages.insertBefore(el, ind);
        else this.messages.appendChild(el);
        this.scrollBottom();
      };
      if (action.kind === 'approval') {
        const approval = action.approval || {};
        const approvalId = String(approval.approvalId || approval.id || '');
        if (!approvalId || [...this.messages.querySelectorAll('.hp-approval-card')].some(card => card.dataset.approvalId === approvalId)) return;
        place(ChatCards.approvalCard(approval, {
          runId,
          buttons: this.capsView?.approvalButtons || [],
          onDecide: async (decision) => {
            const result = await this.postChatAnswer('/api/agent-chat/approvals', { agent, session, run: runId, approval: approvalId, decision });
            if (result.ok || result.notPending) settleEverywhere('approval', approvalId, result.ok ? decision : 'not-pending', this);
            return result;
          }
        }));
        this.showWaitingForYou('approval', runId);
        return;
      }
      if (action.kind === 'approval.resolved') {
        ChatCards.settleApproval(this.messages, action.approvalId, action.decision);
        return;
      }
      if (action.kind === 'question') {
        const question = action.question || {};
        const questionId = String(question.questionId || '');
        if (!questionId) return;
        const secret = (question.questions || []).some(item => item && item.secret);
        const post = (extra) => this.postChatAnswer('/api/agent-chat/questions', { agent, session, run: runId, question: questionId, ...extra });
        if (secret) {
          if (this.secretDialogs.has(questionId)) return;
          const dialog = ChatCards.openSecretDialog(question, {
            onSend: (value) => post({ answers: { value } }),
            onCancel: () => post({ cancel: true }),
            onClose: () => this.secretDialogs.delete(questionId)
          });
          this.secretDialogs.set(questionId, dialog);
        } else {
          if ([...this.messages.querySelectorAll('.hp-question-card')].some(card => card.dataset.questionId === questionId)) return;
          place(ChatCards.questionCard(question, {
            runId,
            onAnswer: async (answers) => {
              const result = await post({ answers });
              if (result.ok || result.notPending) settleEverywhere('question', questionId, result.ok ? 'answered' : 'not-pending', this);
              return result;
            },
            onSkip: async () => {
              const result = await post({ cancel: true });
              if (result.ok || result.notPending) settleEverywhere('question', questionId, result.ok ? 'skipped' : 'not-pending', this);
              return result;
            }
          }));
        }
        this.showWaitingForYou('question', runId);
        return;
      }
      if (action.kind === 'question.resolved') {
        ChatCards.settleQuestion(this.messages, action.questionId, action.status);
        const dialog = this.secretDialogs.get(String(action.questionId));
        if (dialog) dialog.close();
      }
    }

    followRunStream(spec) {
      const terminalEvents = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.canceled']);
      return new Promise((resolve, reject) => {
        let settled = false;
        let seenEventId = 0;
        let retryUntil = 0;
        const source = new EventSource(spec.url);
        this[spec.sourceProperty] = source;
        const cleanup = () => {
          if (this[spec.sourceProperty] === source) this[spec.sourceProperty] = null;
          if (this.activeStream?.source === source) this.activeStream = null;
          source.close();
        };
        const finish = (ok, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (ok) resolve(value);
          else reject(value instanceof Error ? value : new Error(String(value || spec.failureMessage)));
        };
        this.activeStream = {
          source,
          runId: spec.runId,
          provider: spec.provider,
          startedAt: Date.now(),
          detach: () => {
            const error = new Error('detached');
            error.detached = true;
            error.turnReducerHandled = true;
            error.lateRunIgnored = true;
            finish(false, error);
          }
        };
        const handle = (eventName, evt) => {
          if (settled) return;
          const eventId = Number(evt?.lastEventId);
          if (Number.isFinite(eventId) && eventId > 0) {
            if (eventId <= seenEventId) return;
            seenEventId = eventId;
          }
          if (retryUntil) {
            retryUntil = 0;
            if (this.runState?.text === 'Reconnecting…') this.setRunState('running', '', spec.runId);
          }
          let data = {};
          try { data = JSON.parse(evt.data || '{}'); } catch (_) {}
          const accepted = spec.handle(eventName, data);
          if (terminalEvents.has(eventName)) {
            if (eventName === 'run.completed') finish(true, data);
            else {
              const error = new Error(data.error || eventName);
              error.turnReducerHandled = true;
              error.lateRunIgnored = accepted === false;
              finish(false, error);
            }
          }
        };
        spec.eventNames.forEach(name => source.addEventListener(name, evt => handle(name, evt)));
        if (spec.onMessage) source.onmessage = evt => handle('message', evt);
        source.onerror = () => {
          if (settled) return;
          if (source.readyState === EventSource.CONNECTING) {
            const now = Date.now();
            if (!retryUntil) retryUntil = now + RUN_STREAM_RETRY_MS;
            if (now < retryUntil) {
              if (this.runState) this.setRunState('running', 'Reconnecting…', spec.runId);
              return;
            }
          }
          const accepted = this.acceptsProviderRunEvent(spec.runId, {}, 'stream.error');
          const error = new Error(spec.failureMessage);
          // Not marked as handled: the sender first checks history for a
          // final reply before calling the run failed.
          error.streamDisconnected = true;
          error.turnReducerHandled = false;
          error.lateRunIgnored = !accepted;
          finish(false, error);
        };
      });
    }

    handleProviderSdkEvent(eventName, data) {
      const runId = data?.runId || this.currentRunId || '';
      if (!this.acceptsProviderRunEvent(runId, data, eventName)) return false;
      this.markLiveEvent();
      this.applySessionMetrics(data || {});
      if (runId) this.currentRunId = runId;
      const providerKind = this.getSelectedProviderKind();
      const providerLabel = this.agentSelect?.selectedOptions?.[0]?.textContent.trim() || this.getSelectedProviderKind();

      if (eventName === 'run.started') {
        this.applyTurnEvent({ kind: 'run.start', runId, label: providerLabel + ' is starting…' });
        this.ensureRecoveryWatchdog();
      }

      const thinking = String(data?.thinking || '').trim();
      if (thinking && this.turnEvents.get(runId)?.thinkingText !== thinking) {
        this.applyDistinctThinking(runId, thinking);
        this.updateTypingIndicator(providerLabel + ' is working…');
      }

      const commentary = String(data?.commentary || '').trim();
      if (commentary) {
        const commentaryKey = `sdk:${runId}:${commentary}`;
        if (!this.seenOpenClawCommentary.has(commentaryKey)) {
          this.rememberCommentaryKey(commentaryKey);
          this.applyTurnEvent({ kind: 'commentary', runId, text: commentary });
        }
      }

      for (const [index, card] of (Array.isArray(data?.tools) ? data.tools : []).entries()) {
        if (!card || typeof card !== 'object') continue;
        const status = String(card.status || '').toLowerCase();
        const terminal = ['done', 'completed', 'complete', 'success', 'succeeded', 'error', 'failed', 'cancelled', 'canceled'].includes(status);
        const tool = {
          runId,
          id: card.id || `${index}:${card.name || card.tool || 'tool'}`,
          name: card.name || card.tool || 'Provider tool',
          status: ['error', 'failed'].includes(status) || card.error ? 'error' : (terminal ? 'done' : 'running'),
          arguments: card.arguments || card.args || {},
          result: card.result || card.output || '',
          error: card.error || ''
        };
        const key = ChatEvents.toolIdentity(tool);
        const existing = key ? this.turnEvents.get(runId)?.tools?.get(key) : null;
        const toolEventKind = terminal ? 'tool.result' : (existing ? 'tool.update' : 'tool.start');
        const label = formatToolLabel(tool.name, coerceToolArgs(tool.arguments));
        this.updateTypingIndicator(terminal ? 'Processing...' : label);
        this.applyTurnEvent({ kind: toolEventKind, runId, tool });
      }

      const reply = String(data?.reply || '');
      if (reply) this.applyTurnEvent({ kind: 'text.replace', runId, text: reply });

      if (data?.approval) {
        this.applyTurnEvent({
          kind: 'approval',
          runId,
          approval: { ...data.approval, pending_count: data.pending_count || data.approval.pending_count || 1 },
          provider: providerKind
        });
        this.showWaitingForYou('approval', runId);
      }

      if (['run.completed', 'run.failed', 'run.cancelled', 'run.canceled'].includes(eventName)) {
        const kind = eventName === 'run.completed'
          ? 'run.complete'
          : (eventName === 'run.failed' ? 'run.failed' : 'run.cancelled');
        this.applyTurnEvent({ kind, runId, error: data?.error || '' });
        this.fetchSessionInfo().catch(() => {});
        this.refreshSessionsList().catch(() => {});
      }
      return true;
    }

    async sendHermesBlockingMessage(hermesBody, hermesProgress, hermesSendStartedAt) {
      this.startHermesHistoryPolling();
      try {
        const resp = await fetch('/api/hermes/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hermesBody)
        });
        const data = await resp.json();
        this.stopHermesHistoryPolling();
        this.removeTypingIndicator();
        if (!resp.ok || (data.ok === false && !data.approval)) throw new Error(data.error || data.reply || resp.statusText);
        this.finishHermesProgress(hermesProgress, true);
        const runId = this.currentRunId || hermesProgress?.runId || '';
        if (data.reply) this.applyTurnEvent({ kind: 'text.replace', runId, text: data.reply });
        this.applyTurnEvent({ kind: 'run.complete', runId });
        await this.loadHistory({ recoverFinal: true, startedAt: hermesSendStartedAt });
        await this.pollHermesApproval().catch(() => {});
        this.setStatus('Hermes ready', 'connected');
      } catch (e) {
        this.stopHermesHistoryPolling();
        throw e;
      }
    }

    async sendCodexBlockingMessage(codexBody, codexSendStartedAt) {
      this.startCodexHistoryPolling();
      try {
        const resp = await fetch('/api/codex/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(codexBody)
        });
        const data = await resp.json();
        this.stopCodexHistoryPolling();
        this.removeTypingIndicator();
        if (!resp.ok || data.ok === false) throw new Error(data.error || data.reply || resp.statusText);
        const runId = this.currentRunId || `codex-blocking-${codexSendStartedAt}`;
        if (data.reply) this.applyTurnEvent({ kind: 'text.replace', runId, text: data.reply });
        this.applyTurnEvent({ kind: 'run.complete', runId });
        await this.loadHistory({ recoverFinal: true, startedAt: codexSendStartedAt });
        await this.pollCodexApproval().catch(() => {});
        this.setStatus('Codex ready', 'connected');
      } catch (e) {
        this.stopCodexHistoryPolling();
        throw e;
      }
    }

    async sendClaudeCodeBlockingMessage(claudeBody, claudeSendStartedAt) {
      this.startClaudeCodeHistoryPolling();
      try {
        const resp = await fetch('/api/claude-code/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(claudeBody)
        });
        const data = await resp.json();
        this.stopClaudeCodeHistoryPolling();
        this.removeTypingIndicator();
        if (!resp.ok || data.ok === false) throw new Error(data.error || data.reply || resp.statusText);
        const runId = this.currentRunId || `claude-code-blocking-${claudeSendStartedAt}`;
        if (data.reply) this.applyTurnEvent({ kind: 'text.replace', runId, text: data.reply });
        this.applyTurnEvent({ kind: 'run.complete', runId });
        await this.loadHistory({ recoverFinal: true, startedAt: claudeSendStartedAt });
        this.setStatus('Claude Code ready', 'connected');
      } catch (e) {
        this.stopClaudeCodeHistoryPolling();
        throw e;
      }
    }

    streamNativeRunEvents(provider, runId) {
      const cfg = NATIVE_PROVIDER_UI[provider];
      if (!cfg || !runId) return Promise.reject(new Error(`${cfg?.label || provider} run did not return a run id`));
      this.closeNativeEventSource(provider);
      this[cfg.completedKeysProperty] = new Set();
      this.currentRunId = runId;
      this.setStatus(cfg.label + ' stream active...', 'connecting');
      this.markLiveEvent();
      const agentId = this.getSelectedAgentId() || this.selectedAgentKey || '';
      const url = '/api/' + cfg.path + '/runs/' + encodeURIComponent(runId) + '/events?agentId=' + encodeURIComponent(agentId);
      return this.followRunStream({
        url,
        runId,
        provider,
        sourceProperty: cfg.sourceProperty,
        onMessage: true,
        eventNames: [
          'run.started',
          'session.metrics',
          'message.delta',
          'reasoning.available',
          'tool.started',
          'tool.updated',
          'tool.completed',
          'tool.failed',
          'approval.request',
          'run.completed',
          'run.failed',
          'run.cancelled',
          'run.canceled'
        ],
        failureMessage: cfg.label + ' native stream disconnected',
        handle: (eventName, data) => this.handleNativeRunEvent(provider, eventName, data)
      });
    }

    // After a lost stream, look for the reply in the provider's history
    // before calling the run failed (CH-16).
    async recoverFinalFromHistory(provider, startedAt, timeoutMs = 30000) {
      const cfg = NATIVE_PROVIDER_UI[provider];
      const fence = this.selectionFence();
      const stale = () => fence !== this.selectionFence() || this.sessionSelectionPending || !this.isVisibleForPolling();
      const deadline = Date.now() + timeoutMs;
      const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
      if (this.runState) this.setRunState('running', 'Connection lost · checking for the reply…');
      while (Date.now() < deadline) {
        if (stale()) return false;
        const params = new URLSearchParams({ agentId });
        const sessionId = cfg ? this.selectedProviderSessionId() : this.selectedProviderHistorySessionId();
        if (sessionId) params.set('sessionId', sessionId);
        const url = cfg ? '/api/' + cfg.path + '/history?' : '/api/provider-history?';
        try {
          const res = await fetch(url + params.toString(), { cache: 'no-store' });
          const data = await res.json();
          if (stale()) return false;
          const progressMarker = cfg ? cfg.progressMarker : 'provider-progress';
          const finalMsg = data.ok && Array.isArray(data.messages) && [...data.messages].reverse().find(msg =>
            msg && msg.role === 'assistant' && msg.ephemeral !== progressMarker &&
            (msg.text || msg.approval) && ChatEvents.timestampMs(msg.ts || msg.epochMs || 0) >= Number(startedAt || 0) - 1000
          );
          if (finalMsg) {
            this.messages.querySelector('.streaming-msg')?.remove();
            this.streamingMsg = null;
            await this.loadHistory({ recoverFinal: true });
            return true;
          }
        } catch (_) {
          if (stale()) return false;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      return false;
    }

    streamHermesRunEvents(runId, hermesProgress) {
      return this.streamNativeRunEvents('hermes', runId).finally(() => this.finishHermesProgress(hermesProgress, true));
    }

    streamCodexRunEvents(runId) {
      return this.streamNativeRunEvents('codex', runId);
    }

    streamClaudeCodeRunEvents(runId) {
      return this.streamNativeRunEvents('claude-code', runId);
    }

    handleNativeRunEvent(provider, eventName, data) {
      const cfg = NATIVE_PROVIDER_UI[provider];
      if (!cfg) return false;
      const runId = data?.runId || this.currentRunId || '';
      if (!this.acceptsProviderRunEvent(runId, data, eventName)) return false;
      this.markLiveEvent();
      this.applySessionMetrics(data);
      if (runId) this.currentRunId = runId;

      if (eventName === 'run.started') {
        this.applyTurnEvent({ kind: 'run.start', runId, label: cfg.label + ' is running...' });
        if (provider !== 'hermes') this.fetchSessionInfo().catch(() => {});
        return true;
      }

      if (eventName === 'session.metrics') return true;

      if (eventName === 'message.delta') {
        if (data.reply) this.applyTurnEvent({ kind: 'text.replace', runId, text: data.reply });
        else if (data.delta) this.applyTurnEvent({ kind: 'text.delta', runId, text: data.delta });
        return true;
      }

      if (eventName === 'reasoning.available') {
        const thinking = data.thinking || data.text || '';
        if (this.applyDistinctThinking(runId, thinking)) {
          this.updateTypingIndicator(cfg.label + ' is reasoning...');
        }
        return true;
      }

      if (eventName === 'approval.request') {
        if (data.approval) {
          const approval = { ...data.approval, pending_count: data.pending_count || data.approval.pending_count || 1 };
          this.applyTurnEvent({ kind: 'approval', runId, approval, provider: cfg.approval || provider });
        }
        this.showWaitingForYou('approval', runId);
        return true;
      }

      if (['tool.started', 'tool.updated', 'tool.completed', 'tool.failed'].includes(eventName)) {
        const card = data.toolCard || {};
        const isTerminal = eventName === 'tool.completed' || eventName === 'tool.failed';
        const tool = {
          id: card.id || data.toolCallId || data.id || '',
          runId,
          status: eventName === 'tool.failed' || card.status === 'error' || data.error ? 'error' : (isTerminal ? 'done' : 'running'),
          name: card.name || data.tool || data.name || cfg.label + ' tool',
          arguments: card.arguments || (card.args_preview ? { command: card.args_preview } : (data.preview ? { command: data.preview } : {})),
          result: card.result || data.result || data.output || '',
          error: data.error || card.error || ''
        };
        const label = formatToolLabel(tool.name, coerceToolArgs(tool.arguments));
        this.updateTypingIndicator(isTerminal ? 'Processing...' : label);
        this.applyTurnEvent({ kind: isTerminal ? 'tool.result' : (eventName === 'tool.updated' ? 'tool.update' : 'tool.start'), runId, tool });
        if (isTerminal) this[cfg.completedKeysProperty].add(`${runId}:${tool.id}`);
        return true;
      }

      if (eventName === 'run.completed' || eventName === 'run.failed' || eventName === 'run.cancelled' || eventName === 'run.canceled') {
        const finalText = data.reply || data.output || '';
        if (finalText) this.applyTurnEvent({ kind: 'text.replace', runId, text: finalText });
        const kind = eventName === 'run.completed'
          ? 'run.complete'
          : (eventName === 'run.failed' ? 'run.failed' : 'run.cancelled');
        this.applyTurnEvent({ kind, runId, error: data.error || '' });
        if (provider !== 'hermes') this.fetchSessionInfo().catch(() => {});
      }
      return true;
    }

    handleHermesNativeEvent(eventName, data) {
      this.handleNativeRunEvent('hermes', eventName, data);
    }

    handleCodexNativeEvent(eventName, data) {
      this.handleNativeRunEvent('codex', eventName, data);
    }

    handleClaudeCodeNativeEvent(eventName, data) {
      this.handleNativeRunEvent('claude-code', eventName, data);
    }
    stopHermesProgressTimers() {
      if (!this.hermesProgressTimers?.length) return;
      for (const timer of this.hermesProgressTimers) clearTimeout(timer);
      this.hermesProgressTimers = [];
    }

    startHermesHistoryPolling() {
      this.stopHermesHistoryPolling();
      this.hermesCompletedToolKeys = new Set();
      this.pollHermesLiveActivity().catch(() => {});
      this.hermesHistoryPollTimer = setInterval(() => {
        if (this.isNativeHermesSelected()) this.pollHermesLiveActivity().catch(() => {});
      }, HERMES_HISTORY_POLL_MS);
    }

    stopHermesHistoryPolling() {
      if (this.hermesHistoryPollTimer) clearInterval(this.hermesHistoryPollTimer);
      this.hermesHistoryPollTimer = null;
    }

    startCodexHistoryPolling() {
      this.stopCodexHistoryPolling();
      this.codexCompletedToolKeys = new Set();
      this.pollCodexLiveActivity().catch(() => {});
      this.codexHistoryPollTimer = setInterval(() => {
        if (this.isCodexSelected()) this.pollCodexLiveActivity().catch(() => {});
      }, HERMES_HISTORY_POLL_MS);
    }

    stopCodexHistoryPolling() {
      if (this.codexHistoryPollTimer) clearInterval(this.codexHistoryPollTimer);
      this.codexHistoryPollTimer = null;
    }

    startClaudeCodeHistoryPolling() {
      this.stopClaudeCodeHistoryPolling();
      this.claudeCodeCompletedToolKeys = new Set();
      this.pollClaudeCodeLiveActivity().catch(() => {});
      this.claudeCodeHistoryPollTimer = setInterval(() => {
        if (this.isClaudeCodeSelected()) this.pollClaudeCodeLiveActivity().catch(() => {});
      }, HERMES_HISTORY_POLL_MS);
    }

    stopClaudeCodeHistoryPolling() {
      if (this.claudeCodeHistoryPollTimer) clearInterval(this.claudeCodeHistoryPollTimer);
      this.claudeCodeHistoryPollTimer = null;
    }

    // CH-28: the 250 ms live poll never overlaps itself (a cold history read
    // can take seconds) and stops while the tab is hidden.
    pollNativeLiveActivity(provider) {
      return this.runGuardedPoll('native-live', () => this.pollNativeLiveActivityNow(provider));
    }

    async pollNativeLiveActivityNow(provider) {
      const fence = this.selectionFence();
      const selectedKey = this.sessionKey;
      if (this.sessionSelectionPending) return;
      const cfg = NATIVE_PROVIDER_UI[provider];
      if (!cfg) return;
      const agentId = this.getSelectedAgentId() || this.selectedAgentKey;
      const params = new URLSearchParams({ agentId });
      const sessionId = this.selectedProviderSessionId();
      if (sessionId) params.set('sessionId', sessionId);
      const res = await fetch('/api/' + cfg.path + '/history?' + params.toString());
      const data = await res.json();
      if (fence !== this.selectionFence() || selectedKey !== this.sessionKey || this.sessionSelectionPending) return;
      if (!data.ok || !Array.isArray(data.messages)) return;
      const progress = [...data.messages].reverse().find(msg =>
        msg && msg.role === 'assistant' && msg.ephemeral === cfg.progressMarker
      );
      if (!progress) return;

      this.applySessionMetrics(progress);
      const runId = progress.runId || progress.progressId || this.currentRunId || `${provider}-progress`;
      this.currentRunId = runId;

      if (progress.thinking) {
        this.applyTurnEvent({ kind: 'thinking', runId, text: progress.thinking });
        this.updateTypingIndicator(cfg.label + ' is reasoning...');
      }

      if (progress.approval && String(progress.approval.status || 'pending').toLowerCase() === 'pending') {
        this.applyTurnEvent({
          kind: 'approval',
          runId,
          approval: progress.approval,
          provider: cfg.approval || provider
        });
      }

      const completedKeys = this[cfg.completedKeysProperty];
      const tools = normalizeHermesTools(progress.tools || []);
      tools.forEach((tool, idx) => {
        const toolId = tool.id || `${idx}:${tool.name}:${JSON.stringify(tool.arguments || {}).slice(0, 80)}`;
        const key = `${runId}:${toolId}`;
        const status = String(tool.status || '').toLowerCase();
        const isDone = ['done', 'completed', 'error', 'failed', 'cancelled', 'canceled'].includes(status);
        if (isDone && completedKeys.has(key)) return;
        const normalized = { ...tool, id: toolId, runId };
        this.applyTurnEvent({ kind: isDone ? 'tool.result' : 'tool.start', runId, tool: normalized });
        if (isDone) completedKeys.add(key);
      });

      // Snapshot fallbacks do not carry an interleaved event log. Render the
      // current answer after known activity so tools never drift below a
      // continuously growing response bubble.
      if (progress.text) this.applyTurnEvent({ kind: 'text.replace', runId, text: progress.text });
    }

    async pollHermesLiveActivity() {
      return this.pollNativeLiveActivity('hermes');
    }

    async pollCodexLiveActivity() {
      return this.pollNativeLiveActivity('codex');
    }

    async pollClaudeCodeLiveActivity() {
      return this.pollNativeLiveActivity('claude-code');
    }
    async recoverHermesFinalFromHistory(startedAt, timeoutMs = 45000) {
      if (!this.isNativeHermesSelected()) return false;
      return this.recoverFinalFromHistory('hermes', startedAt, timeoutMs);
    }

    startHermesProgress(label) {
      this.stopHermesProgressTimers();
      const runId = 'hermes-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      this.currentRunId = runId;
      this.setStatus('Hermes stream active...', 'connecting');
      this.updateTypingIndicator(label + ' is running Hermes');
      return { runId, label };
    }

    finishHermesProgress(progress, ok, errorText = '') {
      if (!progress) return;
      this.stopHermesProgressTimers();
      if (this.currentRunId === progress.runId) this.currentRunId = null;
    }

    approvalOwnerMismatch(approval) {
      const owner = String(approval?._voAgentId || '');
      const current = String(this.getSelectedAgentId() || this.selectedAgentKey || '');
      if (!owner || owner === current) return false;
      this.appendSystem('This approval belongs to another agent. Switch back to that agent to answer it.');
      return true;
    }

    async respondHermesApproval(approval, choice, card) {
      if (!approval || !this.isNativeHermesSelected()) return;
      if (this.approvalOwnerMismatch(approval)) return;
      const { _voAgentId: approvalAgentId, ...approvalPayload } = approval;
      const buttons = card ? [...card.querySelectorAll('button')] : [];
      buttons.forEach(btn => btn.disabled = true);
      if (card) {
        card.classList.add('responding');
        const status = card.querySelector('.chat-approval-status');
        if (status) status.textContent = choice === 'approve_once' ? 'Approving once...' : 'Denying...';
      }
      try {
        const resp = await fetch('/api/hermes/approval/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: approvalAgentId || this.getSelectedAgentId() || this.selectedAgentKey,
            approval: approvalPayload,
            approval_id: approval.approval_id || approval.id || '',
            session_id: approval.session_id || approval.sessionId || '',
            choice,
            fromDisplayName: 'User'
          })
        });
        const data = await resp.json();
        if (!resp.ok || data.ok === false) throw new Error(data.error || data.reply || resp.statusText);
        if (card) {
          card.classList.remove('responding');
          card.classList.add(choice === 'approve_once' ? 'approved' : 'denied');
          const status = card.querySelector('.chat-approval-status');
          if (status) status.textContent = choice === 'approve_once' ? 'approved once' : 'denied';
        }
        settleApprovalCardsEverywhere(approval.approval_id || approval.id || '', choice === 'approve_once' ? 'approved' : 'denied', card);
        if (choice === 'approve_once') {
          await this.pollHermesApproval().catch(() => {});
        } else if (choice === 'deny') {
          this.appendSystem('Hermes approval denied.');
          await this.pollHermesApproval().catch(() => {});
        }
        this.setStatus(choice === 'approve_once' ? 'Hermes approval sent' : 'Hermes ready', 'connected');
      } catch (e) {
        buttons.forEach(btn => btn.disabled = false);
        if (card) {
          card.classList.remove('responding');
          const status = card.querySelector('.chat-approval-status');
          if (status) status.textContent = 'error';
        }
        this.appendSystem('Hermes approval failed: ' + e.message);
        this.setStatus('Hermes error', 'disconnected');
      }
    }

    async respondCodexApproval(approval, choice, card) {
      if (!approval || !this.isCodexSelected()) return;
      if (this.approvalOwnerMismatch(approval)) return;
      const { _voAgentId: approvalAgentId, ...approvalPayload } = approval;
      const normalized = choice === 'approve' ? 'approve' : 'cancel';
      const buttons = card ? [...card.querySelectorAll('button')] : [];
      buttons.forEach(btn => btn.disabled = true);
      if (card) {
        card.classList.add('responding');
        const status = card.querySelector('.chat-approval-status');
        if (status) status.textContent = normalized === 'approve' ? 'Approving...' : 'Cancelling...';
      }
      try {
        const resp = await fetch('/api/codex/approval/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: approvalAgentId || this.getSelectedAgentId() || this.selectedAgentKey,
            approval: approvalPayload,
            approval_id: approval.approval_id || approval.id || '',
            choice: normalized,
            fromDisplayName: 'User'
          })
        });
        const data = await resp.json();
        if (!resp.ok || data.ok === false) throw new Error(data.error || data.reply || resp.statusText);
        if (card) {
          card.classList.remove('responding');
          card.classList.add(normalized === 'approve' ? 'approved' : 'denied');
          const status = card.querySelector('.chat-approval-status');
          if (status) status.textContent = normalized === 'approve' ? 'approved' : 'cancelled';
        }
        settleApprovalCardsEverywhere(approval.approval_id || approval.id || '', normalized === 'approve' ? 'approved' : 'denied', card);
        if (normalized === 'cancel') {
          this.appendSystem('Codex approval cancelled.');
        }
        await this.pollCodexApproval().catch(() => {});
        this.setStatus(normalized === 'approve' ? 'Codex approval sent' : 'Codex ready', 'connected');
      } catch (e) {
        buttons.forEach(btn => btn.disabled = false);
        if (card) {
          card.classList.remove('responding');
          const status = card.querySelector('.chat-approval-status');
          if (status) status.textContent = 'error';
        }
        this.appendSystem('Codex approval failed: ' + e.message);
        this.setStatus('Codex error', 'disconnected');
      }
    }
    isNearBottom(threshold = CHAT_BOTTOM_FOLLOW_THRESHOLD) {
      if (!this.messages) return true;
      return this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight <= threshold;
    }

    noteManualScrollIntent(direction = 0) {
      this.manualScrollIntentUntil = performance.now() + CHAT_MANUAL_SCROLL_INTENT_MS;
      this.manualScrollBottomTarget = Math.max(0, this.messages.scrollHeight - this.messages.clientHeight);
      this.manualScrollDirection = Number(direction) || 0;
      if (this.manualScrollDirection < 0) {
        this.followLatest = false;
        this.cancelPendingScrollBottom();
        this.updateScrollLatestButton();
      }
    }

    clearManualScrollIntent() {
      this.manualScrollIntentUntil = 0;
      this.manualScrollBottomTarget = 0;
      this.manualScrollDirection = 0;
    }

    hasManualScrollIntent() {
      return performance.now() <= this.manualScrollIntentUntil;
    }

    handleMessagesScroll() {
      if (this.scrollTrackingSuspended) return;
      const nearBottom = this.isNearBottom();
      const manualScrollIntent = this.hasManualScrollIntent();
      const currentScrollTop = this.messages.scrollTop;
      const movedUp = currentScrollTop < this.lastMessagesScrollTop - 0.5;
      this.lastMessagesScrollTop = currentScrollTop;
      const reachedManualBottom = manualScrollIntent && (
        this.messages.scrollTop >= this.manualScrollBottomTarget - CHAT_BOTTOM_REATTACH_THRESHOLD
      );
      if (manualScrollIntent && (this.manualScrollDirection < 0 || movedUp)) {
        this.followLatest = false;
        this.cancelPendingScrollBottom();
      } else if (movedUp && !nearBottom) {
        // CH-22: keyboard, find-in-page, text selection and scrollbar drags
        // move the view without wheel or touch events. Our own code never
        // scrolls up while following, so any upward move away from the
        // bottom is the user's.
        this.followLatest = false;
        this.cancelPendingScrollBottom();
      } else if (reachedManualBottom || (!manualScrollIntent && nearBottom)) {
        this.followLatest = true;
        this.clearManualScrollIntent();
        this.clearUnread();
      }
      this.updateScrollLatestButton();
      if (this.followLatest && !nearBottom) this.scrollBottom();
    }

    replaceHistoryMessages(renderMessages) {
      const scrollState = {
        followLatest: this.followLatest,
        scrollTop: this.messages.scrollTop
      };
      this.scrollTrackingSuspended = true;
      this.messages.innerHTML = '';
      this.historyHiddenItems = this.nextHiddenItems || [];
      this.nextHiddenItems = null;
      this.renderingHistory = true;
      try {
        renderMessages();
      } finally {
        this.renderingHistory = false;
        // Client-only rows (run state line, last error with Retry) are not in
        // the transcript; put them back after every full re-render.
        this.windowHistoryDom();
        this.renderRunError();
        this.renderRunState();
        if (scrollState.followLatest) {
          this.followLatest = true;
          this.messages.scrollTop = this.messages.scrollHeight;
          this.lastMessagesScrollTop = this.messages.scrollTop;
          this.scrollTrackingSuspended = false;
          this.scrollBottom(true);
        } else {
          const maxScrollTop = Math.max(0, this.messages.scrollHeight - this.messages.clientHeight);
          this.messages.scrollTop = Math.min(scrollState.scrollTop, maxScrollTop);
          this.lastMessagesScrollTop = this.messages.scrollTop;
          this.followLatest = !maxScrollTop;
          this.scrollTrackingSuspended = false;
          this.updateScrollLatestButton();
        }
      }
    }

    updateScrollLatestButton() {
      if (!this.scrollLatestBtn) return;
      const hasOverflow = this.messages.scrollHeight > this.messages.clientHeight + CHAT_BOTTOM_FOLLOW_THRESHOLD;
      this.scrollLatestBtn.hidden = this.followLatest || !hasOverflow;
    }

    resumeLatest() {
      this.clearUnread();
      this.cancelPendingScrollBottom();
      this.followLatest = true;
      this.clearManualScrollIntent();
      this.updateScrollLatestButton();
      this.scrollBottom(true);
    }

    cancelPendingScrollBottom() {
      if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
      if (this.scrollSettleFrame) cancelAnimationFrame(this.scrollSettleFrame);
      if (this.scrollSettleTimer) clearTimeout(this.scrollSettleTimer);
      this.scrollFrame = null;
      this.scrollSettleFrame = null;
      this.scrollSettleTimer = null;
    }

    scrollBottom(force = false) {
      if (force) {
        this.cancelPendingScrollBottom();
        this.followLatest = true;
        this.clearManualScrollIntent();
      }
      if (this.scrollTrackingSuspended) return;
      if (!this.followLatest) {
        this.updateScrollLatestButton();
        return;
      }
      const scrollToEnd = () => {
        if (this.scrollTrackingSuspended || !this.followLatest) return;
        this.messages.scrollTop = this.messages.scrollHeight;
        this.lastMessagesScrollTop = this.messages.scrollTop;
        this.updateScrollLatestButton();
      };
      if (force) scrollToEnd();
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        scrollToEnd();
        this.scrollSettleFrame = requestAnimationFrame(() => {
          this.scrollSettleFrame = null;
          scrollToEnd();
        });
        this.scrollSettleTimer = setTimeout(() => {
          this.scrollSettleTimer = null;
          scrollToEnd();
        }, 80);
      });
    }

    scrollBottomAfterLayout() {
      this.scrollBottom();
      setTimeout(() => this.scrollBottom(), 80);
      setTimeout(() => this.scrollBottom(), 300);
    }

    toolKey(payload) {
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
      const id = data.toolCallId || data.itemId || payload?.toolCallId || payload?.callId || payload?.itemId || payload?.id;
      const runId = payload?.runId || data.runId || this.currentRunId || 'run';
      const name = data.name || payload?.name || payload?.tool || payload?.toolName || 'tool';
      let args = data.args || data.arguments || payload?.arguments || payload?.args || payload?.input || {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = { value: args };
      const preview = args.command || args.path || args.file_path || args.url || args.query || args.message || args.value || JSON.stringify(args).slice(0, 120);
      return id || `${runId}:${name}:${String(preview).slice(0, 160)}`;
    }

    appendToolCall(payload) {
      const tool = normalizeToolEvent(payload, 'running');
      const key = this.toolKey(payload);
      tool.key = key;
      const existing = this.liveToolCards.get(key);
      if (existing) {
        updateToolCallCard(existing.querySelector('.chat-tool-call'), tool);
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'chat-msg assistant chat-tool-msg';
      wrap.dataset.runId = payload?.runId || tool.runId || this.currentRunId || '';
      wrap.dataset.toolKey = key;
      wrap.appendChild(renderToolCallCard(tool, { live: true }));
      const ind = this.messages.querySelector('.typing-indicator');
      if (ind) this.messages.insertBefore(wrap, ind);
      else this.messages.appendChild(wrap);
      this.liveToolCards.set(key, wrap);
      this.pruneToolCards();
      this.scrollBottom();
    }

    updateToolCall(payload) {
      const key = this.toolKey(payload);
      const wrap = this.liveToolCards.get(key);
      if (!wrap) return this.appendToolCall(payload);
      updateToolCallCard(wrap.querySelector('.chat-tool-call'), normalizeToolEvent(payload, 'running'));
      this.scrollBottom();
    }

    finishToolCall(payload) {
      let key = this.toolKey(payload);
      let wrap = this.liveToolCards.get(key);
      if (!wrap && this.liveToolCards.size) {
        const sameRun = [...this.liveToolCards.entries()].reverse().find(([, el]) => !payload?.runId || el.dataset.runId === payload.runId);
        if (sameRun) { key = sameRun[0]; wrap = sameRun[1]; }
      }
      if (!wrap) return;
      const tool = normalizeToolEvent(payload, payload?.error ? 'error' : 'done');
      const card = wrap.querySelector('.chat-tool-call');
      updateToolCallCard(card, tool);
      this.liveToolCards.delete(key);
      this.scrollBottom();
    }

    finalizeRunToolCards(runId, runStatus = 'completed', errorText = '') {
      for (const [key, wrap] of [...this.liveToolCards.entries()]) {
        if (!runId || wrap.dataset.runId === runId) {
          const failed = runStatus === 'failed';
          const result = runStatus === 'cancelled' ? 'Cancelled' : 'Completed';
          updateToolCallCard(wrap.querySelector('.chat-tool-call'), failed
            ? { status: 'error', error: errorText || 'Run failed' }
            : { status: 'done', result });
          this.liveToolCards.delete(key);
        }
      }
    }

    updateLiveThinking(runId, text) {
      const cleaned = String(text || '').trim();
      if (!cleaned) return;
      const key = runId || this.currentRunId || 'hermes';
      if (!this.liveThinkingEl || this.liveThinkingRunId !== key || !this.liveThinkingEl.isConnected) {
        const wrap = document.createElement('div');
        wrap.className = 'chat-msg assistant chat-thinking-live';
        wrap.dataset.runId = key;
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        const card = renderThinkingCard(cleaned);
        card.open = true;
        if (this.universalRuns.has(key)) {
          // Universal runs: one collapsed line, "Thinking..." while live (design 4.2 "Reasoning").
          card.open = false;
          card.classList.add('hp-thinking-collapsed');
          card.dataset.startedAt = String(Date.now());
          card.dataset.lastAt = card.dataset.startedAt;
          const title = card.querySelector('.chat-thinking-title');
          if (title) title.textContent = 'Thinking...';
          const state = card.querySelector('.chat-tool-state');
          if (state) state.textContent = '';
        }
        bubble.appendChild(card);
        wrap.appendChild(bubble);
        const ind = this.messages.querySelector('.typing-indicator');
        if (ind) this.messages.insertBefore(wrap, ind);
        else this.messages.appendChild(wrap);
        this.liveThinkingEl = wrap;
        this.liveThinkingPre = card.querySelector('.chat-thinking-body pre');
        this.liveThinkingRunId = key;
      } else if (this.liveThinkingPre) {
        this.liveThinkingPre.textContent = cleaned;
        const collapsed = this.liveThinkingEl.querySelector('.hp-thinking-collapsed');
        if (collapsed) collapsed.dataset.lastAt = String(Date.now());
      }
      this.scrollBottom();
    }

    appendActivity(text) {
      const existing = this.messages.querySelectorAll('.chat-activity');
      if (existing.length >= 8) existing[0].remove();
      const div = document.createElement('div');
      div.className = 'chat-activity';
      div.innerHTML = '<span class="activity-text">' + escHtml(text) + '</span><span class="activity-time">' + new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) + '</span>';
      const ind = this.messages.querySelector('.typing-indicator');
      if (ind) this.messages.insertBefore(div, ind);
      else this.messages.appendChild(div);
      this.scrollBottom();
    }
  }

  function buildSecondaryChatPanel(slotNum) {
    const placeholder = secondaryPanelPlaceholders[slotNum];
    const primaryPanel = document.getElementById('chat-panel');
    if (!placeholder || !primaryPanel) return null;
    const panel = primaryPanel.cloneNode(true);
    panel.id = `chat-secondary-${slotNum}`;
    panel.dataset.chatSlot = `secondary-${slotNum}`;
    panel.classList.remove('open', 'floating', 'dragging', 'move-active', 'snap-left', 'snap-right');
    panel.classList.add('chat-panel-secondary');
    panel.setAttribute('aria-hidden', 'true');
    panel.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    // The primary window's live parts (pickers, meter, queue, lines, plan) belong to it: each window builds its own.
    panel.querySelectorAll('.hp-pickers, .hp-picker-pop, .hp-context-meter, .hp-queue, .hp-perm-btn, .hp-busy-hint, .hp-stream-line, .hp-conn-line, .hp-plan-msg, .hp-plan-card, .hp-side, .hp-side-btn, .hp-task-chip')
      .forEach((el) => el.remove());
    panel.querySelectorAll('.chat-model-name, .chat-context-info').forEach((el) => { el.hidden = false; });
    panel.querySelector('.chat-secondary-controls')?.remove();
    panel.querySelector('.chat-exterior-tabs')?.remove();

    const header = panel.querySelector('.chat-header');
    header.classList.add('chat-secondary-header');
    const closeBtn = panel.querySelector('.chat-close');
    if (closeBtn) {
      closeBtn.classList.add('chat-secondary-close');
      closeBtn.dataset.chatSlotClose = String(slotNum);
    }
    placeholder.replaceWith(panel);
    globalThis.VOChatTools?.observe(panel);
    return panel;
  }

  function updateChatStackLayout() {
    const root = document.documentElement;
    const sidebarWidth = typeof _getSidebarWidth === 'function' ? _getSidebarWidth() : 0;
    root.style.setProperty('--chat-stack-gap', CHAT_STACK_GAP + 'px');
    // The docked windows end left of the office's right column (chatRightInset);
    // the window buttons stand in that column on the map controls (short screens: beside them).
    root.style.setProperty('--chat-stack-main-right', chatRightInset() + 'px');
    root.style.setProperty('--chat-rail-right', (sidebarWidth + CHAT_RAIL_EDGE) + 'px');
    root.style.setProperty('--chat-sidebar-w', sidebarWidth + 'px');
    _tileSecondaryPanels();
  }

  /**
   * Tile all open secondary panels to the left of the main panel.
   * Order: Main | 1 | 2 | 3 (right to left).
   * Only sets horizontal position + width. Height is independent per panel.
   * New panels get the main panel's height; existing panels keep theirs.
   */
  let _tileRafPending = false;
  function _tileSecondaryPanels() {
    if (_tileRafPending) return;
    _tileRafPending = true;
    requestAnimationFrame(_tileSecondaryPanelsNow);
  }
  function _tileSecondaryPanelsNow() {
    _tileRafPending = false;
    const mainPanel = document.getElementById('chat-panel');
    if (!mainPanel) return;
    if (shouldUseSingleWindowMobileLayout()) return;
    const mainShown = mainPanel.classList.contains('open');

    const GAP = CHAT_STACK_GAP;
    const MIN_W = 220;

    // Collect open secondary panels in order (1, 2, 3)
    const openSecondaries = [];
    [1, 2, 3].forEach((slotNum) => {
      const p = secondaryChatPanels[String(slotNum)];
      if (p && p.classList.contains('open')) openSecondaries.push(p);
    });

    if (openSecondaries.length === 0) return;

    // With the main window put away or closed, the first extra window takes
    // its spot at the dock (same right edge, width and height).
    const mainBox = mainPanel.getBoundingClientRect();
    let mainRect = mainBox;
    if (!mainShown) {
      const rootStyle = getComputedStyle(document.documentElement);
      const dockH = parseFloat(rootStyle.getPropertyValue?.('--vo-dock-h')) || 0;
      const height = mainBox.height || 500;
      const stackRight = parseFloat(rootStyle.getPropertyValue?.('--chat-stack-main-right')) || 0;
      const right = window.innerWidth - stackRight;
      mainRect = { left: right + GAP, right, width: mainBox.width || 380, height, top: Math.max(0, window.innerHeight - dockH - height) };
    }
    const mainLeft = mainRect.left;

    // Available space to the left of the main panel
    const availableLeft = mainLeft - GAP;
    const totalGaps = (openSecondaries.length - 1) * GAP;
    const availableWidth = Math.max(0, availableLeft - totalGaps);

    // A secondary window should open at a useful window-sized width, not
    // stretch across every unused pixel to the left of the main chat. Keep a
    // user's horizontal resize as its preferred width and only compress the
    // group when the viewport cannot fit all open windows side by side.
    const desiredWidths = openSecondaries.map((panel) => {
      const preferred = Number(panel.dataset.chatPreferredWidth);
      const desired = panel.dataset.hasCustomWidth && Number.isFinite(preferred)
        ? preferred
        : mainRect.width;
      return Math.max(MIN_W, Math.min(desired, window.innerWidth * 0.92));
    });
    const desiredTotal = desiredWidths.reduce((sum, width) => sum + width, 0);
    let tiledWidths = desiredWidths.slice();
    if (desiredTotal > availableWidth && availableWidth >= MIN_W * openSecondaries.length) {
      const shrinkableTotal = desiredWidths.reduce((sum, width) => sum + Math.max(0, width - MIN_W), 0);
      const overflow = desiredTotal - availableWidth;
      tiledWidths = desiredWidths.map((width) => {
        if (shrinkableTotal <= 0) return width;
        const share = Math.max(0, width - MIN_W) / shrinkableTotal;
        return Math.max(MIN_W, width - overflow * share);
      });
    } else if (availableWidth < MIN_W * openSecondaries.length) {
      const constrainedWidth = Math.max(120, availableWidth / openSecondaries.length);
      tiledWidths = desiredWidths.map(() => constrainedWidth);
    }

    // Position each open secondary from right to left, starting just left of main
    let cursor = mainLeft - GAP;
    openSecondaries.forEach((panel, index) => {
      const panelWidth = Math.floor(tiledWidths[index]);
      const left = cursor - panelWidth;
      panel.style.position = 'fixed';
      panel.style.left = Math.max(0, left) + 'px';
      panel.style.right = 'auto';
      panel.style.width = panelWidth + 'px';
      panel.style.transform = 'none';
      // Only set height/bottom if panel doesn't have an explicit height yet
      if (!panel.dataset.hasCustomHeight) {
        panel.style.bottom = '0px';
        panel.style.height = mainRect.height + 'px';
        panel.style.top = mainRect.top + 'px';
      }
      cursor = left - GAP;
    });
  }

  /**
   * Reset all chat panels to equal size, tiled side by side, bottom-anchored.
   */
  function _resetChatLayout() {
    const mainPanel = document.getElementById('chat-panel');
    if (!mainPanel || !mainPanel.classList.contains('open')) return;

    const GAP = CHAT_STACK_GAP;

    // Reset main panel to default docked position
    mainPanel.classList.remove('floating', 'snap-left', 'snap-right', 'dragging', 'move-active');
    mainPanel.style.left = '';
    mainPanel.style.top = '';
    mainPanel.style.right = chatRightInset() + 'px';
    mainPanel.style.bottom = '';
    mainPanel.style.height = '500px';
    mainPanel.style.transform = '';
    _chatCancelDrag();

    // Count open panels (main + open secondaries)
    const openSecondaries = [];
    [1, 2, 3].forEach((slotNum) => {
      const p = secondaryChatPanels[String(slotNum)];
      if (p && p.classList.contains('open')) openSecondaries.push(p);
    });

    const totalPanels = 1 + openSecondaries.length;
    const available = window.innerWidth - chatRightInset();
    const totalGaps = (totalPanels - 1) * GAP;
    const equalWidth = Math.max(160, Math.floor((available - totalGaps) / totalPanels));

    // Set main panel width
    mainPanel.style.width = equalWidth + 'px';
    mainPanel.style.right = chatRightInset() + 'px';

    // Reset secondaries — clear custom heights, equal size
    openSecondaries.forEach((panel) => {
      delete panel.dataset.hasCustomHeight;
      delete panel.dataset.hasCustomWidth;
      delete panel.dataset.chatPreferredWidth;
      panel.style.height = '500px';
      panel.style.bottom = '0px';
      panel.style.top = '';
    });

    // Re-tile with new sizes
    _tileSecondaryPanelsNow();
    _positionExteriorTabs();

    // Scroll all to bottom
    chatWindows.forEach(w => w.scrollBottom());
  }

  function syncSecondaryChatControls() {
    secondarySlotButtons.forEach((button) => {
      const slotNum = button.dataset.chatSlotToggle;
      const panel = secondaryChatPanels[slotNum];
      const isOpen = !!panel && panel.classList.contains('open');
      button.classList.toggle('active', isOpen);
      button.classList.toggle('state-open', isOpen);
      button.classList.toggle('state-hidden', !isOpen);
      button.classList.remove('state-active');
      button.dataset.chatSlotState = isOpen ? 'open' : 'hidden';
      button.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
      button.setAttribute('aria-label', `${isOpen ? 'Hide' : 'Open'} chat window ${slotNum}`);
      button.title = isOpen ? `Hide chat window ${slotNum}` : `Open chat window ${slotNum}`;
    });
    syncChatSlotTabs();
    _tileSecondaryPanels();
  }

  function chatSlotAgentName(windowInstance) {
    const option = windowInstance?.agentSelect?.selectedOptions?.[0];
    const full = String(option?.textContent || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const first = full.split(/\s+/)[0] || '';
    return { full, short: first.length > 10 ? first.slice(0, 9) + '\u2026' : first };
  }

  // P3-7: the window strip appears only once a second chat window is open.
  // Each extra window's tab names its agent; one "+" tab opens the next slot.
  function syncChatSlotTabs() {
    if (windowManager || !document.getElementById('chat-exterior-tabs')) { scheduleWindowRailPaint(); return; }
    let extraOpen = 0;
    let addShown = false;
    secondarySlotButtons.forEach((button) => {
      const slotNum = button.dataset.chatSlotToggle;
      const panel = secondaryChatPanels[slotNum];
      const isOpen = !!panel && panel.classList.contains('open');
      const label = button.querySelector('.chat-slot-tab-label') || button;
      button.classList.toggle('is-add', !isOpen);
      if (isOpen) {
        extraOpen += 1;
        const name = chatSlotAgentName(chatWindowsByRoot?.get(panel));
        label.textContent = name.short || slotNum;
        const text = `Hide chat window ${slotNum}${name.full ? ' (' + name.full + ')' : ''}`;
        button.title = text;
        button.setAttribute('aria-label', text);
        button.hidden = false;
      } else {
        label.textContent = '+';
        button.title = 'Open another chat window';
        button.setAttribute('aria-label', 'Open another chat window');
        button.hidden = addShown;
        addShown = true;
      }
    });
    const strip = document.getElementById('chat-exterior-tabs');
    if (!strip) return;
    strip.classList.toggle('is-single', extraOpen === 0);
    // The strip sits above the main window: its first tab names that window.
    let mainTab = strip.querySelector('.chat-slot-tab-main');
    if (!mainTab) {
      mainTab = document.createElement('button');
      mainTab.type = 'button';
      mainTab.className = 'chat-slot-tab chat-slot-tab-main state-open active';
      const span = document.createElement('span');
      span.className = 'chat-slot-tab-label';
      mainTab.appendChild(span);
      mainTab.addEventListener('click', () => primaryWindow.input?.focus());
      strip.insertBefore(mainTab, strip.firstChild);
    }
    const mainName = chatSlotAgentName(primaryWindow);
    mainTab.querySelector('.chat-slot-tab-label').textContent = mainName.short || 'Main';
    const mainText = `Main chat window${mainName.full ? ' (' + mainName.full + ')' : ''}`;
    mainTab.title = mainText;
    mainTab.setAttribute('aria-label', mainText);
  }

  function setActiveSecondarySlot(slotNum) {
    const slotKey = slotNum == null ? null : String(slotNum);
    if (slotKey && !secondaryChatPanels[slotKey]?.classList.contains('open')) return;
    activeSecondarySlot = slotKey;
    Object.entries(secondaryChatPanels).forEach(([otherSlot, panel]) => {
      panel?.classList.toggle('chat-panel-active', !!slotKey && otherSlot === slotKey && panel.classList.contains('open'));
    });
    syncSecondaryChatControls();
  }

  // CH-31: a new chat window opens on the next agent that no other open
  // window shows, instead of duplicating the primary window.
  function inheritPrimarySelection(windowInstance) {
    if (!windowInstance || windowInstance.hasExplicitAgentSelection) return;
    const options = officeOptions(primaryWindow.agentSelect).filter(opt => opt.dataset.sessionKey);
    if (!options.length) return;
    const used = new Set(chatWindows
      .filter(w => w !== windowInstance && w.root.classList.contains('open'))
      .map(w => w.selectedAgentKey));
    const current = primaryWindow.agentSelect?.selectedOptions?.[0];
    const pick = options.find(opt => !used.has(opt.value)) || (isLayerOption(current) ? null : current) || options[0];
    if (!pick?.dataset?.sessionKey) return;
    const target = chatOptionForAgent(windowInstance, pick.value) || pick;
    windowInstance.applySelection(target, { markExplicit: false, systemPrefix: 'Ready to chat with' });
  }

  function shouldUseSingleWindowMobileLayout() {
    return chatViewportWidth() <= 900;
  }

  function enforceSingleWindowMobileLayout() {
    if (!shouldUseSingleWindowMobileLayout()) return;
    if (windowManager) {
      // Phones show one window: the others are put away (their buttons stay).
      windowManager.settle();
      chatWindows.forEach((w) => {
        if (w.isPrimary) return;
        ['left', 'top', 'width', 'height', 'right', 'bottom', 'transform', 'position'].forEach((k) => { w.root.style[k] = ''; });
      });
      scheduleWindowRailPaint();
      return;
    }
    // A desktop layout can be resized while several secondary windows are
    // open. Mobile intentionally exposes one full-width chat surface, so do
    // not leave desktop panels layered over the primary conversation.
    Object.keys(secondaryChatPanels).forEach((slotNum) => {
      if (secondaryChatPanels[slotNum]?.classList.contains('open')) {
        setSecondaryPanelOpen(slotNum, false);
      }
    });
    setActiveSecondarySlot(null);
  }

  function setSecondaryPanelOpen(slotNum, shouldOpen, { focus = true } = {}) {
    const slotKey = String(slotNum);
    const panel = secondaryChatPanels[slotKey];
    if (!panel) return;

    const isOpen = panel.classList.contains('open');
    if (isOpen === shouldOpen) {
      syncSecondaryChatControls();
      return;
    }

    if (shouldOpen && shouldUseSingleWindowMobileLayout()) {
      Object.entries(secondaryChatPanels).forEach(([otherSlot, otherPanel]) => {
        if (otherSlot === slotKey || !otherPanel.classList.contains('open')) return;
        setSecondaryPanelOpen(otherSlot, false);
      });
    }

    const windowInstance = chatWindowsByRoot.get(panel);
    if (shouldOpen) inheritPrimarySelection(windowInstance);

    panel.classList.toggle('open', shouldOpen);
    windowInstance?.syncTaskProgress();
    panel.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');

    if (shouldOpen) {
      panel.dataset.hiddenByUser = 'false';
      windowInstance?.scrollBottom();
      windowInstance?.resumeWhenVisible();
      if (focus && !shouldUseSingleWindowMobileLayout()) windowInstance?.input?.focus();
    } else {
      panel.dataset.hiddenByUser = 'true';
      if (windowInstance?.streamingMsg) {
        windowInstance.finalizeStreamingMessage(windowInstance.streamingMsg.content || '');
        windowInstance.streamingMsg = null;
      }
      windowInstance?.removeTypingIndicator();
      windowInstance?.suspendWhenHidden();
    }
    syncSecondaryChatControls();
  }

  function closeAllSecondaryPanels() {
    Object.keys(secondaryChatPanels).forEach((slotNum) => {
      _secExitMoveMode(slotNum);
      setSecondaryPanelOpen(slotNum, false);
    });
  }

  function toggleSecondaryPanel(slotNum) {
    if (!primaryWindow.root.classList.contains('open')) return;
    const slotKey = String(slotNum);
    const panel = secondaryChatPanels[slotKey];
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    setSecondaryPanelOpen(slotKey, !isOpen);
  }

  secondarySlotButtons.forEach((button) => button.addEventListener('click', () => toggleSecondaryPanel(button.dataset.chatSlotToggle)));

  // Reset layout button
  const chatResetBtn = document.getElementById('chat-reset-layout');
  if (chatResetBtn) chatResetBtn.addEventListener('click', () => _resetChatLayout());

  function nextId() { return `office-${++reqId}-${Date.now()}`; }

  function browserGatewayUrlFromConfig(rawUrl) {
    if (!rawUrl) return '';
    try {
      const parsed = new URL(rawUrl);
      if (!['ws:', 'wss:'].includes(parsed.protocol)) return '';
      const browserHost = window.location.hostname || '127.0.0.1';
      if (LOCAL_GATEWAY_HOSTS.has(parsed.hostname)) parsed.hostname = browserHost;
      if (window.location.protocol === 'https:' && parsed.protocol === 'ws:') parsed.protocol = 'wss:';
      return parsed.toString();
    } catch (error) {
      console.warn('[chat] Invalid Gateway URL:', rawUrl, error);
      return '';
    }
  }

  function getGatewayUrl() {
    const configured = browserGatewayUrlFromConfig(GATEWAY_URL);
    if (configured) return configured;
    const host = window.location.hostname || '127.0.0.1';
    // Behind HTTPS the tunnel goes through the office's own address (host and port), like cron.html.
    if (window.location.protocol === 'https:') return `wss://${window.location.host || host}/ws-gateway`;
    return `ws://${host}:${_chatWsPort}`;
  }

  function startModelBarRefresh() {
    if (_modelBarInterval) clearInterval(_modelBarInterval);
    _modelBarInterval = setInterval(() => {
      if (!connected || document.hidden) return;
      chatWindows.forEach(w => {
        if (!w.isVisibleForPolling()) return;
        if (w.isHermesSelected?.() || w.isCodexSelected?.()) w.fetchSessionInfo();
        else w.fetchContextUsage();
      });
    }, 60000);
  }

  // CH-31: reconnect with exponential backoff and jitter instead of a fixed
  // 3 s loop, reset once the gateway is connected again.
  let gatewayReconnectTimer = 0;
  let gatewayReconnectDelay = 2000;
  function scheduleGatewayReconnect() {
    if (gatewayReconnectTimer) return;
    if (!chatWindows.some(w => w.root.classList.contains('open') || w.currentRunId || w.streamingMsg)) return;
    const delay = Math.min(30000, gatewayReconnectDelay) * (0.75 + Math.random() * 0.5);
    gatewayReconnectDelay = Math.min(30000, gatewayReconnectDelay * 2);
    gatewayReconnectTimer = setTimeout(() => {
      gatewayReconnectTimer = 0;
      if (document.hidden) {
        document.addEventListener('visibilitychange', () => scheduleGatewayReconnect(), { once: true });
        return;
      }
      connectGateway();
    }, delay);
  }

  function setGatewayDisconnectedStatus(windowInstance, message) {
    if (windowInstance?.progressPanel?.identity?.providerKind === 'openclaw') progressStore.invalidate(windowInstance.progressPanel.identity, { disconnect: true });
    if (windowInstance?.isProviderAgentSelected?.()) {
      windowInstance.syncSelectionStatus();
      return;
    }
    windowInstance.setStatus(message, 'disconnected');
  }

  function markGatewayConnected() {
    connected = true;
    gatewayReconnectDelay = 2000;
    progressStore.connectionChanged();
    chatWindows.forEach(w => {
      w.syncSelectionStatus();
      if (w.isPrimary || w.root.classList.contains('open')) {
        w.fetchSessionInfo();
        w.loadHistory();
      }
    });
    startModelBarRefresh();
  }

  async function connectGateway() {
    if (ws || gatewayEvents) return;
    // v0.12: the layer has OpenClaw: no office gateway connection at all (no EventSource, no WebSocket, no status)
    if (!layerKnown && await layerDecided) return;
    if (layerOwnsChats()) return;
    chatWindows.forEach(w => {
      if (w.getSelectedProviderKind() === 'openclaw') w.setStatus('Connecting...', 'connecting');
      else w.syncSelectionStatus();
    });
    await loadGatewayInfo();
    if (ws || gatewayEvents || layerOwnsChats()) return;
    if (GATEWAY_TRANSPORT === 'proxy') {
      connectGatewayProxy();
      return;
    }
    const gatewayUrl = getGatewayUrl();
    if (!gatewayUrl) {
      chatWindows.forEach(w => setGatewayDisconnectedStatus(w, 'Gateway unavailable'));
      return;
    }
    try {
      ws = new WebSocket(gatewayUrl);
    } catch (_) {
      chatWindows.forEach(w => setGatewayDisconnectedStatus(w, 'Gateway unavailable'));
      return;
    }
    const socket = ws;
    socket.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'event' && msg.event === 'connect.challenge') return sendConnect(socket);
      if (msg.type === 'res') {
        const cb = pendingCallbacks[msg.id];
        if (cb) { delete pendingCallbacks[msg.id]; cb(msg); }
        return;
      }
      if (msg.type === 'event') handleEvent(msg);
    };
    socket.onclose = (evt) => {
      if (ws !== socket) return;
      connected = false;
      ws = null;
      chatWindows.forEach(w => setGatewayDisconnectedStatus(w, `Disconnected (${evt.code})`));
      scheduleGatewayReconnect();
    };
    socket.onerror = () => {
      if (ws === socket) chatWindows.forEach(w => setGatewayDisconnectedStatus(w, 'Connection error'));
    };
  }

  function connectGatewayProxy() {
    if (gatewayEvents) return;
    let source;
    try {
      source = new EventSource(GATEWAY_EVENTS_URL, { withCredentials: true });
    } catch (_) {
      chatWindows.forEach(w => setGatewayDisconnectedStatus(w, 'Gateway proxy unavailable'));
      return;
    }
    gatewayEvents = source;
    source.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'proxy.ready') {
        markGatewayConnected();
        return;
      }
      if (msg.type === 'proxy.error') {
        connected = false;
        chatWindows.forEach(w => setGatewayDisconnectedStatus(w, msg.payload?.message || 'Gateway proxy unavailable'));
        source.close();
        if (gatewayEvents === source) gatewayEvents = null;
        scheduleGatewayReconnect();
        return;
      }
      if (msg.type === 'event') handleEvent(msg);
    };
    source.onerror = () => {
      if (gatewayEvents !== source) return;
      connected = false;
      const terminal = source.readyState === EventSource.CLOSED;
      chatWindows.forEach(w => setGatewayDisconnectedStatus(w, terminal ? 'Gateway proxy unavailable' : 'Reconnecting...'));
      if (terminal) {
        gatewayEvents = null;
        scheduleGatewayReconnect();
      }
    };
  }

  function sendConnect(socket = ws) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const id = nextId();
    const msg = {
      type: 'req', id, method: 'connect',
      params: {
        minProtocol: GATEWAY_PROTOCOL_VERSION, maxProtocol: GATEWAY_PROTOCOL_VERSION,
        client: { id: 'openclaw-control-ui', version: GATEWAY_CLIENT_VERSION || 'unknown', platform: 'web', mode: 'webchat' },
        role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'], caps: ['tool-events'], commands: [], permissions: {},
        auth: { token: GATEWAY_TOKEN }, locale: 'en-US', userAgent: 'virtual-office-chat/1.0'
      }
    };
    pendingCallbacks[id] = (res) => {
      if (res.ok) {
        markGatewayConnected();
      } else {
        chatWindows.forEach(w => w.setStatus(`Auth failed: ${res.error?.message || 'unknown'}`, 'disconnected'));
      }
    };
    socket.send(JSON.stringify(msg));
  }

  async function rpc(method, params) {
    if (GATEWAY_TRANSPORT === 'proxy') {
      if (!connected) throw new Error('Not connected');
      const response = await fetch(GATEWAY_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ method, params })
      });
      const result = await response.json().catch(() => ({ ok: false, error: { message: `Gateway proxy HTTP ${response.status}` } }));
      if (!response.ok && result.ok !== false) result.ok = false;
      return result;
    }
    return new Promise((resolve, reject) => {
      if (!ws || !connected) return reject(new Error('Not connected'));
      const id = nextId();
      pendingCallbacks[id] = resolve;
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => {
        if (pendingCallbacks[id]) { delete pendingCallbacks[id]; reject(new Error('Timeout')); }
      }, 30000);
    });
  }

  function getSessionsListCached(maxAgeMs = 2500) {
    // Deprecated: broad sessions.list polling was replaced by targeted
    // sessions.describe calls and the backend presence cache.
    const now = Date.now();
    if (_sessionsListCache.promise && now - _sessionsListCache.at < maxAgeMs) return _sessionsListCache.promise;
    _sessionsListCache.at = now;
    _sessionsListCache.promise = rpc('sessions.list', { limit: 100 }).then((res) => {
      _sessionsListCache.payload = res;
      return res;
    }).catch((err) => {
      _sessionsListCache.promise = null;
      throw err;
    });
    return _sessionsListCache.promise;
  }

  function handleEvent(msg) {
    const { event, payload } = msg;
    if (event === 'progressCard.changed') {
      if (typeof payload?.sessionKey !== 'string') return;
      for (const entry of progressStore.entries.values()) {
        if (entry.identity.providerKind === 'openclaw' && entry.identity.connectionId === 'default' && entry.identity.nativeSessionId === payload.sessionKey) {
          if (Number.isSafeInteger(payload.revision) && payload.revision <= (entry.state.card?.nativeRevision || 0)) continue;
          progressStore.invalidate(entry.identity);
        }
      }
      return;
    }
    const matchingWindows = chatWindows.filter(w => w.ownsPayload(payload));
    const visibleWindows = matchingWindows.filter(w => w.isVisibleForPolling());
    const isFinalReply = event === 'chat' && ['final', 'done'].includes(payload?.state);
    matchingWindows.forEach(w => {
      if (!w.isVisibleForPolling()) w.markHistoryDirty();
    });
    // One reply = one unread, even when several closed windows follow the
    // same session (the first match is the primary window when it does).
    if (isFinalReply && !visibleWindows.length) matchingWindows[0]?.noteUnreadReply(payload?.runId || '');
    if (event === 'chat' || event === 'agent' || event === 'session.message') {
      visibleWindows.forEach(w => w.queueOpenClawEvent(event, payload));
    }
  }

  function agentLabelFromId(agentId) {
    if (!agentId) return '';
    const opt = document.querySelector(`.chat-agent-select option[value="${CSS.escape(String(agentId))}"]`);
    return opt ? opt.textContent.trim() : String(agentId);
  }

  function getWindowAgentLabel(win) {
    return win?.agentSelect?.selectedOptions?.[0]?.textContent?.trim() || agentLabelFromId(win?.agentSelect?.value) || 'Assistant';
  }

  function parseAgentIdFromSessionKey(sessionKey) {
    const m = String(sessionKey || '').match(/^agent:([^:]+):/);
    return m ? m[1] : '';
  }

  function parseA2AEnvelope(text) {
    const m = String(text || '').match(/^\s*\[A2A\s+([^\]]+)\]\s*\n?/);
    if (!m) return null;
    const attrs = {};
    const raw = m[1];
    raw.replace(/([A-Za-z][\w-]*)=("[^"]*"|'[^']*'|\S+)/g, (_, k, v) => {
      v = String(v || '').trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      attrs[k] = v;
      return '';
    });
    const fromId = attrs.from || '';
    const toId = attrs.to || '';
    return {
      fromId,
      toId,
      isUser: String(attrs.isUser || '').toLowerCase() === 'true' || fromId === 'user',
      label: attrs.name || agentLabelFromId(fromId) || fromId || 'Agent',
      toLabel: agentLabelFromId(toId) || toId || '',
      text: String(text || '').slice(m[0].length).trimStart()
    };
  }

  function renderMessageCopyButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-msg-copy';
    button.dataset.chatAction = 'copy-message';
    button.title = 'Copy message';
    button.setAttribute('aria-label', 'Copy message');
    setChatIcon(button, 'copy');
    return button;
  }

  function renderSystemEventsRow(events) {
    const list = Array.isArray(events) ? events : [];
    const details = document.createElement('details');
    details.className = 'chat-system-events';
    const summary = document.createElement('summary');
    summary.textContent = `System events (${list.length})`;
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'chat-system-events-list';
    for (const ev of list.slice(0, 60)) {
      const item = document.createElement('div');
      item.className = 'chat-system-event';
      const title = document.createElement('div');
      title.className = 'chat-system-event-title';
      title.textContent = String(ev.title || 'System event').slice(0, 300);
      item.appendChild(title);
      if (ev.detail) {
        const pre = document.createElement('pre');
        pre.textContent = String(ev.detail).slice(0, 2000);
        item.appendChild(pre);
      }
      body.appendChild(item);
    }
    if (list.length > 60) {
      const more = document.createElement('div');
      more.className = 'chat-system-event-title';
      more.textContent = `+ ${list.length - 60} more`;
      body.appendChild(more);
    }
    details.appendChild(body);
    return details;
  }

  function renderEnvelopeDetails(raw) {
    const details = document.createElement('details');
    details.className = 'chat-envelope-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Delivery details';
    const pre = document.createElement('pre');
    pre.textContent = String(raw || '').slice(0, 4000);
    details.append(summary, pre);
    return details;
  }

  // Wrap each rendered code block with a Copy button (U5).
  function decorateCodeBlocks(container) {
    if (!container?.querySelectorAll) return;
    for (const pre of container.querySelectorAll('pre')) {
      if (pre.parentElement?.classList.contains('chat-code-block')) continue;
      if (!pre.querySelector('code')) continue;
      const wrap = document.createElement('div');
      wrap.className = 'chat-code-block';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-code-copy';
      button.dataset.chatAction = 'copy-code';
      button.title = 'Copy code';
      button.setAttribute('aria-label', 'Copy code');
      setChatIcon(button, 'copy');
      pre.replaceWith(wrap);
      wrap.append(button, pre);
    }
  }

  function settleApprovalCardsEverywhere(approvalId, outcome, exceptCard) {
    const id = String(approvalId || '');
    if (!id) return;
    for (const win of chatWindows) {
      for (const card of win.messages?.querySelectorAll('.chat-approval-card[data-approval-id]') || []) {
        if (card === exceptCard || card.dataset.approvalId !== id) continue;
        card.classList.remove('pending', 'responding');
        card.classList.add(outcome === 'approved' ? 'approved' : 'denied');
        card.querySelectorAll('button').forEach(btn => { btn.disabled = true; });
        const status = card.querySelector('.chat-approval-status');
        if (status) status.textContent = outcome === 'approved' ? 'approved' : 'answered';
      }
    }
  }

  function normalizeSenderMeta(meta, role, win) {
    const out = { ...(meta || {}) };
    if (!out.label) {
      if (role === 'assistant') {
        out.label = getWindowAgentLabel(win);
        out.kind = out.kind || 'agent';
      } else if (role === 'user') {
        out.label = 'You';
        out.kind = out.kind || 'human';
      }
    }
    return out;
  }

  function isToolResultRole(role) {
    return ['tool', 'toolresult', 'tool_result', 'tool-result'].includes(String(role || '').toLowerCase());
  }

  function normalizeChatRole(role) {
    const normalized = String(role || '').toLowerCase();
    if (normalized === 'assistant' || isToolResultRole(normalized)) return 'assistant';
    if (normalized === 'system') return 'system';
    return 'user';
  }

  function resolveMessageSender(msg, win) {
    const message = msg?.message || msg || {};
    const role = message.role || msg?.role || '';
    const text = extractText(msg) || (typeof message.content === 'string' ? message.content : '') || '';
    const prov = message.provenance || msg?.provenance || {};
    const targetLabel = getWindowAgentLabel(win);

    if (role === 'assistant' || isToolResultRole(role)) return { label: targetLabel, kind: 'agent' };

    if (role === 'user' && prov?.kind === 'inter_session') {
      const sourceAgentId = parseAgentIdFromSessionKey(prov.sourceSessionKey || '');
      return {
        label: agentLabelFromId(sourceAgentId) || 'Agent',
        toLabel: targetLabel,
        kind: 'agent',
        isInterSession: true,
        sourceAgentId
      };
    }

    const envelope = parseA2AEnvelope(text);
    if (role === 'user' && envelope?.isUser) return { label: 'You', kind: 'human' };
    if (role === 'user' && envelope) {
      return { label: envelope.label, toLabel: envelope.toLabel || targetLabel, kind: 'agent', isInterSession: true, sourceAgentId: envelope.fromId };
    }

    return { label: 'You', kind: 'human' };
  }

  function renderSenderHeader(meta, role) {
    if (!meta?.label || role === 'system') return null;
    const div = document.createElement('div');
    div.className = 'chat-sender-label ' + (meta.kind === 'agent' ? 'agent' : 'human');
    div.textContent = meta.toLabel ? `${meta.label} → ${meta.toLabel}` : meta.label;
    return div;
  }

  function extractToolItems(msg) {
    const c = msg?.message?.content ?? msg?.content;
    if (!Array.isArray(c)) return [];
    const tools = [];
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      const type = b.type || '';
      if (type === 'toolCall' || type === 'tool_call') {
        tools.push({
          status: 'done',
          name: b.name || b.toolName || b.function?.name || 'tool',
          arguments: b.arguments || b.args || b.input || b.function?.arguments || {},
          id: b.id || b.toolCallId || b.callId || ''
        });
      } else if (type === 'toolResult' || type === 'tool_result') {
        const last = tools[tools.length - 1];
        const result = b.result ?? b.output ?? b.content ?? b.text ?? b.error ?? '';
        if (last && (!b.toolCallId || b.toolCallId === last.id)) {
          last.result = result;
          last.status = b.error ? 'error' : 'done';
        } else {
          tools.push({ status: b.error ? 'error' : 'done', name: b.name || 'tool result', result, id: b.toolCallId || b.id || '' });
        }
      }
    }
    return tools;
  }

  function normalizeToolStatus(value, error = '', result = '') {
    if (error) return 'error';
    const status = String(value || '').toLowerCase();
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(status)) return 'error';
    if (['done', 'completed', 'complete', 'success', 'succeeded', 'result', 'end'].includes(status)) return 'done';
    if (!status && result) return 'done';
    return 'running';
  }

  function normalizeHistoricalTools(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(Boolean).map((item) => {
      const rawStatus = String(item.status || (item.error ? 'error' : item.result ? 'done' : 'running')).toLowerCase();
      const status = normalizeToolStatus(rawStatus, item.error, item.result ?? item.output);
      return {
        id: item.id || item.toolCallId || item.callId || '',
        runId: item.runId || '',
        status,
        name: item.name || item.toolName || item.tool_name || 'tool',
        arguments: coerceToolArgs(item.arguments || item.args || item.input || {}),
        result: item.result ?? item.output ?? item.content ?? (['cancelled', 'canceled'].includes(rawStatus) ? 'Cancelled' : ''),
        error: item.error || ''
      };
    });
  }

  function toolHistoryKey(tool) {
    if (!tool) return '';
    if (tool.id) return 'id:' + tool.id;
    const args = coerceToolArgs(tool.arguments || {});
    const preview = args.command || args.path || args.file_path || args.url || args.query || args.message || args.value || '';
    return [tool.runId || '', tool.name || 'tool', tool.status || '', String(preview).slice(0, 160)].join('|');
  }

  function normalizeHermesTools(items, coerceCompleted = false) {
    if (!Array.isArray(items)) return [];
    return items.filter(Boolean).map((item) => {
      const rawStatus = String(item.status || (item.error ? 'error' : 'done')).toLowerCase();
      let status = normalizeToolStatus(rawStatus, item.error, item.result ?? item.output ?? item.content);
      let result = item.result ?? item.output ?? item.content ?? '';
      if (!result && ['cancelled', 'canceled'].includes(rawStatus)) result = 'Cancelled';
      if (coerceCompleted && String(status).toLowerCase() === 'running') {
        status = 'done';
        if (!result || result === 'Running') result = 'Completed';
      }
      return {
        id: item.id || item.toolCallId || item.callId || '',
        status,
        name: item.name || item.toolName || item.tool_name || 'tool',
        arguments: coerceToolArgs(item.arguments || item.args || item.input || (item.args_preview ? { command: item.args_preview } : {})),
        result,
        error: item.error || ''
      };
    });
  }

  /** An answered approval / question settles in every chat window of this page at once. */
  function settleEverywhere(kind, id, outcome, origin) {
    if (!globalThis.ChatCards || !id) return;
    const windows = typeof chatWindows !== 'undefined' ? chatWindows : [origin];
    for (const w of windows) {
      if (!w?.messages) continue;
      if (kind === 'approval') ChatCards.settleApproval(w.messages, id, outcome);
      else ChatCards.settleQuestion(w.messages, id, outcome);
    }
  }

  function normalizeToolEvent(payload, fallbackStatus = 'running') {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const phase = data.phase || payload?.phase || '';
    const isError = data.isError || payload?.isError || payload?.error;
    let status = payload?.status || fallbackStatus;
    if (phase === 'start' || phase === 'update') status = 'running';
    if (phase === 'result' || phase === 'end') status = isError ? 'error' : 'done';
    const result = data.result ?? data.partialResult ?? payload?.result ?? payload?.output ?? payload?.content ?? payload?.text ?? '';
    const error = data.error || payload?.error || (isError && typeof result === 'string' ? result : '');
    let args = data.args || data.arguments || payload?.arguments || payload?.args || payload?.input || {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = { value: args };
    if (data.meta && !args.command && !args.description) args.description = data.meta;
    return {
      id: data.toolCallId || data.itemId || payload?.toolCallId || payload?.callId || payload?.itemId || payload?.id || '',
      runId: payload?.runId || data.runId || '',
      status,
      name: data.name || data.title || payload?.name || payload?.tool || payload?.toolName || 'tool',
      arguments: args,
      result,
      error
    };
  }

  function renderToolCallCard(tool, opts = {}) {
    const details = document.createElement('details');
    details.className = `chat-tool-call ${tool.status || 'running'}`;
    if (opts.live || tool.status === 'running') details.open = true;
    details.dataset.toolName = tool.name || 'tool';

    const summary = document.createElement('summary');
    summary.className = 'chat-tool-summary';
    const dot = document.createElement('span');
    dot.className = 'chat-tool-running-dot';
    const icon = document.createElement('span');
    icon.className = 'chat-tool-icon';
    icon.textContent = toolIcon(tool);
    const name = document.createElement('span');
    name.className = 'chat-tool-name';
    name.textContent = formatToolName(tool.name, tool.arguments);
    const preview = document.createElement('span');
    preview.className = 'chat-tool-preview';
    preview.textContent = formatToolPreview(tool);
    const toggle = document.createElement('span');
    toggle.className = 'chat-tool-toggle';
    toggle.innerHTML = '<svg class="vo-icon vo-chev vo-chev-r" aria-hidden="true" focusable="false"><use href="#i-chev"/></svg>';
    const state = document.createElement('span');
    state.className = 'chat-tool-state';
    state.textContent = tool.status === 'error' ? 'error' : tool.status === 'done' ? 'done' : 'running';
    summary.append(dot, icon, name, preview, toggle, state);
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'chat-tool-body';
    body.appendChild(renderToolSection('Input', formatToolPayload(tool.arguments || {})));
    if (tool.result || tool.error) body.appendChild(renderToolSection(tool.error ? 'Error' : 'Result', formatToolPayload(tool.error || tool.result)));
    details.appendChild(body);
    return details;
  }

  function updateToolCallCard(card, tool) {
    if (!card) return;
    const previousStatus = card.classList.contains('running') ? 'running' : card.classList.contains('error') ? 'error' : card.classList.contains('done') ? 'done' : '';
    card.classList.remove('running', 'done', 'error');
    card.classList.add(tool.status || 'done');
    if (previousStatus && previousStatus !== (tool.status || 'done')) {
      card.classList.add('status-changed');
      setTimeout(() => card.classList.remove('status-changed'), 850);
      if ((tool.status === 'done' || tool.status === 'error') && card.open) {
        setTimeout(() => { if (card.classList.contains('done') || card.classList.contains('error')) card.open = false; }, 900);
      }
    }
    const icon = card.querySelector('.chat-tool-icon');
    if (icon) icon.textContent = toolIcon(tool);
    const state = card.querySelector('.chat-tool-state');
    if (state) state.textContent = tool.status === 'error' ? 'error' : tool.status === 'done' ? 'done' : 'running';
    const name = card.querySelector('.chat-tool-name');
    if (name) name.textContent = formatToolName(tool.name, tool.arguments);
    const preview = card.querySelector('.chat-tool-preview');
    if (preview) preview.textContent = formatToolPreview(tool);
    const body = card.querySelector('.chat-tool-body');
    if (body) {
      body.innerHTML = '';
      body.appendChild(renderToolSection('Input', formatToolPayload(tool.arguments || {})));
      if (tool.result || tool.error) body.appendChild(renderToolSection(tool.error ? 'Error' : tool.status === 'running' ? 'Progress' : 'Result', formatToolPayload(tool.error || tool.result)));
    }
  }

  function renderToolSection(label, text) {
    const section = document.createElement('div');
    section.className = 'chat-tool-section';
    const h = document.createElement('div');
    h.className = 'chat-tool-section-label';
    h.textContent = label;
    const pre = document.createElement('pre');
    pre.textContent = text || '—';
    section.append(h, pre);
    return section;
  }

  function renderThinkingCard(text) {
    const details = document.createElement('details');
    details.className = 'chat-thinking-card';
    const summary = document.createElement('summary');
    summary.className = 'chat-thinking-summary';
    const label = document.createElement('span');
    label.className = 'chat-thinking-title';
    label.textContent = 'Thinking';
    const state = document.createElement('span');
    state.className = 'chat-tool-state';
    state.textContent = 'trace';
    const toggle = document.createElement('span');
    toggle.className = 'chat-tool-toggle';
    toggle.innerHTML = '<svg class="vo-icon vo-chev vo-chev-r" aria-hidden="true" focusable="false"><use href="#i-chev"/></svg>';
    summary.append('💡', label, toggle, state);
    const body = document.createElement('div');
    body.className = 'chat-thinking-body';
    const pre = document.createElement('pre');
    pre.textContent = String(text || '').trim();
    body.appendChild(pre);
    details.append(summary, body);
    return details;
  }

  function renderHermesApprovalCard(approval, windowInstance) {
    const card = document.createElement('div');
    const status = String(approval.status || 'pending').toLowerCase();
    const isCodex = String(approval.provider || '').startsWith('codex') || String(approval.agentId || '').startsWith('codex-') || String(approval.title || '').toLowerCase().includes('codex');
    // DL-11: expired cards are closed, "allowed" counts as approved.
    const isClosed = status.includes('denied') || status.includes('cancel') || status.includes('expired');
    const isAllowed = status.includes('approved') || status.includes('allowed');
    card.className = 'chat-approval-card ' + (isClosed ? 'denied' : isAllowed ? 'approved' : 'pending');
    card.dataset.approvalId = approval.approval_id || approval.id || '';
    if (approval._voAgentId) card.dataset.agentId = String(approval._voAgentId);

    const header = document.createElement('div');
    header.className = 'chat-approval-header';
    const icon = document.createElement('span');
    icon.className = 'chat-approval-icon';
    icon.textContent = isClosed ? '✕' : isAllowed ? '✓' : '!';
    const title = document.createElement('span');
    title.className = 'chat-approval-title';
    title.textContent = approval.title || (isCodex ? 'Codex approval required' : 'Hermes approval required');
    const state = document.createElement('span');
    state.className = 'chat-approval-status';
    const pendingCount = Number(approval.pending_count || approval.pendingCount || 0);
    state.textContent = status === 'pending' && pendingCount > 1 ? `${pendingCount} pending` : (status === 'pending' ? 'pending' : status);
    header.append(icon, title, state);

    const desc = document.createElement('div');
    desc.className = 'chat-approval-desc';
    desc.textContent = approval.description || (isCodex ? 'Codex needs user approval before it can continue.' : 'Hermes needs user approval before it can continue.');

    const cmd = document.createElement('pre');
    cmd.className = 'chat-approval-command';
    cmd.textContent = approval.command || (isCodex ? 'Approval-gated Codex action' : 'Approval-gated Hermes command');

    card.append(header, desc, cmd);
    if (status === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'chat-approval-actions';
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.className = 'chat-approval-btn primary';
      allow.textContent = isCodex ? 'Approve' : 'Allow once';
      allow.title = isCodex ? 'Approve this Codex action for the active turn' : 'Retry this Hermes turn with one-time approval for this invocation only';
      allow.addEventListener('click', () => {
        if (isCodex) windowInstance?.respondCodexApproval(approval, 'approve', card);
        else windowInstance?.respondHermesApproval(approval, 'approve_once', card);
      });
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.className = 'chat-approval-btn';
      deny.textContent = isCodex ? 'Cancel' : 'Deny';
      deny.title = isCodex ? 'Cancel this Codex action' : 'Do not retry this blocked Hermes command';
      deny.addEventListener('click', () => {
        if (isCodex) windowInstance?.respondCodexApproval(approval, 'cancel', card);
        else windowInstance?.respondHermesApproval(approval, 'deny', card);
      });
      actions.append(allow, deny);
      card.appendChild(actions);
    }
    return card;
  }

  function coerceToolArgs(value) {
    if (!value) return {};
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return { input: value }; }
    }
    return typeof value === 'object' ? value : { value };
  }

  function formatToolPayload(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'string') return value.length > MAX_TOOL_PAYLOAD_CHARS ? value.slice(0, MAX_TOOL_PAYLOAD_CHARS) + '\n… [truncated]' : value;
    try {
      const s = JSON.stringify(value, null, 2);
      return s.length > MAX_TOOL_PAYLOAD_CHARS ? s.slice(0, MAX_TOOL_PAYLOAD_CHARS) + '\n… [truncated]' : s;
    } catch {
      return String(value);
    }
  }

  function extractText(msg) {
    const c = msg?.message?.content ?? msg?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join('');
    return '';
  }

  function extractMedia(msg, text) {
    const media = [];
    const c = msg?.message?.content ?? msg?.content;
    const add = (item) => {
      const normalized = normalizeOneChatMedia(item);
      if (normalized) media.push(normalized);
    };
    if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || b.type === 'text') continue;
        if (b.type === 'image' || b.type === 'image_url' || b.type === 'input_image') {
          add({ url: b.url || b.image_url?.url || b.source?.url || b.path || b.filePath, mimeType: b.mimeType || b.media_type || b.source?.media_type || 'image/*', name: b.name || b.filename || 'image' });
        } else if (b.type === 'file' || b.type === 'media' || b.type === 'attachment' || b.type === 'video' || b.type === 'audio') {
          add({ url: b.url || b.path || b.filePath || b.source?.url, mimeType: b.mimeType || b.media_type || b.contentType || b.source?.media_type || '', name: b.name || b.filename });
        }
      }
    }
    const sourceText = text || '';
    for (const rawLine of sourceText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (/^MEDIA:/i.test(line)) add({ url: line.replace(/^MEDIA:/i, '').trim() });
      const attachMatch = line.match(/^\(attached file:\s*(.+?)\)$/i) || line.match(/^attached file:\s*(.+)$/i);
      if (attachMatch) add({ url: attachMatch[1].trim() });
    }
    const seen = new Set();
    return media.filter(item => {
      const key = item.url || item.path;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function normalizeOneChatMedia(item) {
    if (globalThis.ChatMedia) return globalThis.ChatMedia.normalize(item);
    if (!item) return null;
    if (typeof item === 'string') item = { url: item };
    let url = item.url || item.path || item.filePath || item.href || item.mediaUrl || item.proxyUrl || '';
    if (!url) return null;
    url = String(url).trim();
    const dataUrlMatch = url.match(/^data:([^;,]+)[;,]/i);
    const dataMime = dataUrlMatch ? dataUrlMatch[1].toLowerCase() : '';
    const name = item.name || item.filename || (dataMime ? (dataMime.split('/')[0] || 'media') : decodeURIComponent((url.split('/').pop() || 'media').split('?')[0]));
    const mimeType = item.mimeType || item.contentType || (dataMime && dataMime !== 'text/plain' ? dataMime : '') || item.type || guessMimeFromName(name, url);
    const isLocalPath = url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/__openclaw__') && !url.startsWith('/sms-media') && !url.startsWith('/chat-media');
    const src = isLocalPath ? '/chat-media?path=' + encodeURIComponent(url) : url;
    return { url: src, originalUrl: url, name, mimeType };
  }

  function normalizeChatMedia(items) {
    if (!items) return [];
    if (!Array.isArray(items)) items = [items];
    return items.map(normalizeOneChatMedia).filter(Boolean);
  }

  function guessMimeFromName(name, url) {
    const v = (name || url || '').toLowerCase().split('?')[0];
    if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/.test(v)) return 'image/*';
    if (/\.(mp4|webm|mov|m4v|ogg)$/.test(v)) return 'video/*';
    if (/\.(mp3|wav|m4a|aac|flac|opus)$/.test(v)) return 'audio/*';
    if (/\.pdf$/.test(v)) return 'application/pdf';
    return '';
  }

  function renderChatMedia(media) {
    // Signed hub links, size limits, file cards (chat-media.js, design 4.2 "Media").
    if (globalThis.ChatMedia) return globalThis.ChatMedia.render(document, media);
    const wrap = document.createElement('div');
    wrap.className = 'chat-media-list';
    for (const item of media) {
      const type = (item.mimeType || '').toLowerCase();
      const card = document.createElement('figure');
      card.className = 'chat-media-item';
      if (type.startsWith('image/') || type === 'image/*') {
        const img = document.createElement('img');
        img.src = item.url;
        img.alt = item.name || 'image';
        img.className = 'chat-image-thumb chat-image-clickable';
        img.loading = 'lazy';
        card.appendChild(img);
      } else if (type.startsWith('video/') || type === 'video/*') {
        const video = document.createElement('video');
        video.src = item.url;
        video.controls = true;
        video.preload = 'metadata';
        video.className = 'chat-media-video';
        card.appendChild(video);
      } else if (type.startsWith('audio/') || type === 'audio/*') {
        const audio = document.createElement('audio');
        audio.src = item.url;
        audio.controls = true;
        audio.preload = 'metadata';
        audio.className = 'chat-media-audio';
        card.appendChild(audio);
      } else {
        const link = document.createElement('a');
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'chat-media-file';
        link.textContent = '📎 ' + (item.name || 'Open attachment');
        card.appendChild(link);
      }
      if (item.name && (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/') || type.endsWith('/*'))) {
        const cap = document.createElement('figcaption');
        cap.textContent = item.name;
        card.appendChild(cap);
      }
      wrap.appendChild(card);
    }
    return wrap;
  }

  function parseDataUrl(dataUrl) {
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return null;
    return { mimeType: m[1], content: m[2] };
  }

  function compressImage(dataUrl, maxBase64Len = 350000) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        const maxDim = 800;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * ratio); h = Math.round(h * ratio);
        }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        let quality = 0.7;
        let result = canvas.toDataURL('image/jpeg', quality);
        while (result.length - 23 > maxBase64Len && quality > 0.05) {
          quality -= 0.1;
          if (quality < 0.3 && w > 400) {
            w = Math.round(w * 0.7); h = Math.round(h * 0.7);
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          }
          result = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(result);
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  /** A big picture scaled to at most `maxDim` px (PNG stays PNG, others become JPEG); null when it cannot be drawn. */
  function shrinkImage(dataUrl, maxDim = 2048, mimeType = '') {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (!w || !h) { resolve(null); return; }
        const ratio = Math.min(1, maxDim / Math.max(w, h));
        w = Math.max(1, Math.round(w * ratio));
        h = Math.max(1, Math.round(h * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const type = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
        const out = canvas.toDataURL(type, 0.88);
        const comma = out.indexOf(',');
        resolve({ dataUrl: out, mimeType: type, size: Math.floor((out.length - comma - 1) * 3 / 4) });
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  /** Copy a picture (or, where the browser cannot, its link) for the viewer's Copy. */
  async function copyMediaItem(item) {
    try {
      if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        const res = await fetch(item.url, { credentials: 'same-origin' });
        const blob = await res.blob();
        if (/^image\/(png)$/i.test(blob.type)) {
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          globalThis.VOUI?.toast?.('Picture copied.');
          return;
        }
      }
      await navigator.clipboard.writeText(new URL(item.url, location.href).href);
      globalThis.VOUI?.toast?.('Link copied.');
    } catch (_) {
      globalThis.VOUI?.toast?.('Could not copy the picture.', { kind: 'error' });
    }
  }

  function openImageLightbox(src, name = '') {
    if (globalThis.ChatMedia) {
      globalThis.ChatMedia.openViewer(document, { url: src, name }, { copy: copyMediaItem });
      return;
    }
    let overlay = document.getElementById('image-lightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'image-lightbox';
      overlay.className = 'image-lightbox';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.classList.contains('lightbox-close')) overlay.classList.remove('active');
      });
      const closeBtn = document.createElement('button');
      closeBtn.className = 'lightbox-close';
      closeBtn.textContent = '✕';
      overlay.appendChild(closeBtn);
      const img = document.createElement('img');
      img.className = 'lightbox-img';
      overlay.appendChild(img);
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.lightbox-img').src = src;
    overlay.classList.add('active');
  }

  function formatContent(text) {
    return globalThis.VirtualOfficeChatMarkdown.renderMarkdown(text);
  }
  function renderMarkdownInto(target, text) {
    const html = globalThis.VirtualOfficeChatMarkdown.renderMarkdownInto(target, text);
    decorateCodeBlocks(target);
    return html;
  }
  function escHtml(value) { return globalThis.VirtualOfficeChatMarkdown.escapeHtml(value); }

  // (an OpenClaw deferred tool's wrapper, tool_call / dispatch_action {id, args}, shows as the tool it calls)
  function shownTool(name, args) {
    return typeof ChatEvents.unwrapToolCall === 'function' ? ChatEvents.unwrapToolCall(name, args) : { name, args };
  }

  function formatToolLabel(name, args) {
    const truncate = (s, n) => s && s.length > n ? s.slice(0, n) + '...' : (s || '');
    ({ name, args } = shownTool(name, args));
    args = coerceToolArgs(args);
    switch (name) {
      case 'exec': return '⚙️ exec: ' + truncate(args.command || '', 60);
      case 'bash': return '⚙️ bash: ' + truncate(args.command || args.description || '', 60);
      case 'Command': return '⚙️ command: ' + truncate(args.command || args.description || '', 60);
      case 'read': return '📄 read: ' + truncate(args.path || args.file_path || '', 50);
      case 'write': return '💾 write: ' + truncate(args.path || args.file_path || '', 50);
      case 'edit': return '✏️ edit: ' + truncate(args.path || args.file_path || '', 50);
      case 'sessions_send': return '📡 sessions_send → ' + truncate(args.sessionKey || args.label || '', 40);
      case 'sessions_spawn': return '🤖 spawn: ' + truncate(args.agentId || '', 30) + (args.task ? ' — ' + truncate(args.task, 40) : '');
      case 'sessions_history': return '📜 history: ' + truncate(args.sessionKey || '', 40);
      case 'sessions_list': return '📋 sessions_list';
      case 'todo': return '✅ tasks: ' + truncate(args.todos ? `${args.todos.length} updates` : args.content || args.id || '', 50);
      case 'memory_search': return '🧠 memory: ' + truncate(args.query || '', 50);
      case 'memory_get': return '🧠 memory_get: ' + truncate(args.path || '', 40);
      case 'web_search': return '🔍 search: ' + truncate(args.query || '', 50);
      case 'web_fetch': return '🌐 fetch: ' + truncate(args.url || '', 50);
      case 'browser': return '🖥️ browser: ' + truncate(args.action || '', 20);
      case 'process': return '🔄 process: ' + truncate(args.action || '', 20);
      case 'tts': return '🔊 tts';
      case 'image': return '🖼️ image analysis';
      default: return '🔧 ' + (name || 'tool');
    }
  }

  function formatToolName(name, args) {
    const raw = String(shownTool(name, args).name || 'tool');
    if (raw === 'Command') return 'command';
    if (raw === 'Hermes task breakdown') return 'task plan';
    return raw.replace(/^functions\./, '');
  }

  function toolIcon(tool) {
    const name = String(shownTool(tool?.name, tool?.arguments).name || '').toLowerCase();
    if (tool?.status === 'error' || tool?.error) return '⚠️';
    if (name.includes('task') || name === 'todo') return tool?.status === 'done' ? '✓' : '◌';
    if (name.includes('read') || name.includes('fetch')) return '📄';
    if (name.includes('write') || name.includes('edit')) return '✎';
    if (name.includes('search')) return '⌕';
    if (name.includes('browser')) return '◈';
    if (tool?.status === 'done') return '✓';
    return '⚡';
  }

  function formatToolPreview(tool) {
    const shown = shownTool(tool?.name, tool?.arguments);
    const args = coerceToolArgs(shown.args || {});
    const result = String(tool?.error || tool?.result || '').replace(/\s+/g, ' ').trim();
    const pick = (...keys) => {
      for (const key of keys) if (args[key]) return String(args[key]);
      return '';
    };
    let preview = '';
    switch (shown.name) {
      case 'exec':
      case 'bash':
      case 'Command':
        preview = pick('command', 'description', 'value');
        break;
      case 'read':
      case 'write':
      case 'edit':
        preview = pick('path', 'file_path', 'filePath');
        break;
      case 'sessions_send':
        preview = pick('sessionKey', 'label', 'message');
        break;
      case 'sessions_spawn':
        preview = [pick('agentId'), pick('task')].filter(Boolean).join(' · ');
        break;
      case 'todo':
        preview = args.todos ? `${args.todos.length} task updates` : pick('content', 'id');
        break;
      case 'Hermes task breakdown':
        preview = args.now || (Array.isArray(args.done) ? `${args.done.length} steps complete` : 'receive · run · export · render');
        break;
      default:
        preview = pick('query', 'url', 'action', 'input', 'value');
    }
    if (!preview && result) preview = result;
    if (!preview) preview = tool?.status === 'running' ? 'running...' : 'completed';
    return preview.length > 90 ? preview.slice(0, 87) + '...' : preview;
  }

  updateChatStackLayout();
  const primaryWindow = new ChatWindow(document.getElementById('chat-panel'), { isPrimary: true });
  const chatWindows = [primaryWindow];
  const chatWindowsByRoot = new Map([[primaryWindow.root, primaryWindow]]);
  secondaryChatPanels = Object.fromEntries(Object.keys(secondaryPanelPlaceholders).map((slot) => [slot, buildSecondaryChatPanel(Number(slot))]));
  Object.entries(secondaryChatPanels).forEach(([slot, panel]) => {
    const w = new ChatWindow(panel, { slot: Number(slot) });
    chatWindows.push(w);
    chatWindowsByRoot.set(panel, w);
  });

  unreadState.windows = chatWindows;

  // ── Chat windows (review 2026-11-02, like MVW's): up to four, each with its
  // own button stacked above the chat launcher; put away / bring back; one
  // chat never in two windows; they come back after a reload (chat-windows.js).
  const chatWindowBySlot = slot => chatWindows.find(w => w.slotId === slot) || null;
  const chatKeyOf = w => (w && w.sessionKey ? `${w.selectedAgentKey}\u0000${w.sessionKey}` : '');
  const chatWindowZBase = parseInt(getComputedStyle(primaryWindow.root).zIndex, 10) || 300;
  const chatWindowRail = document.getElementById('chat-window-rail');
  const chatWindowRailHome = chatWindowRail?.parentElement || null;
  function chatToast(text) {
    const ui = window.VOUI || globalThis.VOUI;
    if (ui?.toast) ui.toast(text);
    else console.info('[chat]', text);
  }
  function resetPrimaryGeometry() {
    const chatPanel = primaryWindow.root;
    chatPanel.classList.remove('floating', 'snap-left', 'snap-right', 'dragging', 'move-active');
    ['left', 'top', 'right', 'bottom', 'width', 'height', 'transform'].forEach((k) => { chatPanel.style[k] = ''; });
    _chatCancelDrag();
  }
  windowManager = globalThis.ChatWindows ? globalThis.ChatWindows.createManager({
    slots: chatWindows.map(w => w.slotId),
    storage: (() => { try { return localStorage; } catch (_) { return null; } })(),
    isPhone: () => shouldUseSingleWindowMobileLayout(),
    // v0.11: OpenClaw/Hermes's copied chat windows (vo-mount.mjs) count toward the same four.
    others: () => (window.voPL && typeof window.voPL.windows === 'function' ? window.voPL.windows() : 0),
    adapter: {
      show(slot, { focus = true } = {}) {
        const w = chatWindowBySlot(slot);
        if (!w) return;
        if (w.isPrimary) {
          if (!w.root.classList.contains('open')) setPrimaryPanelOpen(true, null, { focus });
          else if (focus && !shouldUseSingleWindowMobileLayout()) w.input?.focus?.();
        } else if (!w.root.classList.contains('open')) {
          setSecondaryPanelOpen(w.slot, true, { focus });
        } else if (focus && !shouldUseSingleWindowMobileLayout()) {
          w.input?.focus?.();
        }
        if (!ws) connectGateway();
        updateChatStackLayout();
        globalThis.VOWindowStack?.raise?.(w.root);
      },
      hide(slot, why) {
        const w = chatWindowBySlot(slot);
        if (!w) return;
        if (w.isPrimary) {
          if (why === 'close') resetPrimaryGeometry();
          if (w.root.classList.contains('open')) setPrimaryPanelOpen(false);
        } else {
          _secExitMoveMode(w.slot);
          setSecondaryPanelOpen(w.slot, false);
        }
        updateChatStackLayout();
      },
      chatKey: slot => chatKeyOf(chatWindowBySlot(slot)),
      idle(slot) {
        const w = chatWindowBySlot(slot);
        return !!w && !w.isRunActive() && !String(w.input?.value || '').trim();
      },
      paint(view) {
        const shownCount = view.filter(v => !v.min).length;
        const stack = globalThis.VOWindowStack?.raise ? globalThis.VOWindowStack : null;
        for (const v of view) {
          const w = chatWindowBySlot(v.slot);
          if (!w) continue;
          // One window stack (vo-window-stack.js) orders chats, the Agent PC, SMS and the browser together.
          if (stack) { if (v.min) stack.release(w.root); }
          else w.root.style.zIndex = v.min ? '' : String(chatWindowZBase + 1 + Math.max(0, v.z));
          w.root.classList.toggle('chat-window-front', v.front && shownCount > 1);
        }
        for (const w of chatWindows) {
          if (!windowManager?.has(w.slotId)) { if (stack) stack.release(w.root); else w.root.style.zIndex = ''; w.root.classList.remove('chat-window-front'); }
        }
        scheduleWindowRailPaint();
      }
    }
  }) : null;

  let windowRailQueued = false;
  windowRailPainter = () => {
    if (windowRailQueued) return;
    windowRailQueued = true;
    requestAnimationFrame(paintWindowRail);
  };
  // One button per chat window above the launcher: the agent's emoji, a ring
  // while it works, unread answers, lit while shown. On phones (one window at a
  // time) the buttons sit in the shown chat as a strip under its header.
  function paintWindowRail() {
    windowRailQueued = false;
    const rail = chatWindowRail;
    if (!rail || !windowManager) return;
    const view = windowManager.view();
    const single = shouldUseSingleWindowMobileLayout();
    const shownView = view.filter(v => !v.min);
    const host = single && shownView.length ? chatWindowBySlot(shownView[0].slot)?.root : null;
    const visible = view.length > 0 && (!host || view.length > 1);
    if (host && visible) {
      const header = host.querySelector('.chat-header');
      if (header && header.nextElementSibling !== rail) header.after(rail);
    } else if (chatWindowRailHome && rail.parentElement !== chatWindowRailHome) {
      chatWindowRailHome.insertBefore(rail, primaryWindow.root);
    }
    rail.classList.toggle('is-strip', !!host);
    rail.hidden = !visible;
    const html = view.map((v) => {
      const w = chatWindowBySlot(v.slot);
      if (!w) return '';
      const { emoji, name } = w.agentFace();
      const label = name || 'Chat';
      const working = w.isRunActive();
      const unread = Number(w.unreadCount) || 0;
      const action = v.min ? 'show it' : (v.front || shownView.length === 1) ? 'put it away' : 'bring it forward';
      const tip = `${label}${working ? ' (working)' : ''}${unread ? `, ${unread} new` : ''}: ${action}`;
      const cls = ['chat-win-btn', v.min ? 'is-away' : 'is-shown', v.front ? 'is-front' : '', working ? 'is-working' : ''].filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-chat-win="${escHtml(v.slot)}" title="${escHtml(tip)}" aria-label="${escHtml(tip)}" aria-pressed="${v.min ? 'false' : 'true'}">` +
        `<span class="chat-win-av" aria-hidden="true">${escHtml(emoji || label.charAt(0).toUpperCase() || '?')}</span>` +
        (unread ? `<span class="chat-win-n" aria-hidden="true">${unread > 9 ? '9+' : unread}</span>` : '') + '</button>';
    }).join('');
    if (rail._html !== html) { rail._html = html; rail.innerHTML = html; }
    const root = document.documentElement;
    const gutter = visible && !single;
    if (root.classList.contains('vo-chat-rail') !== gutter) {
      root.classList.toggle('vo-chat-rail', gutter);
      updateChatStackLayout();
    }
    try { window.dispatchEvent(new CustomEvent('vo:chat-windows', { detail: { count: view.length, shown: shownView.length } })); } catch (_) {}
  }
  chatWindowRail?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-chat-win]');
    if (button && windowManager) windowManager.press(button.dataset.chatWin);
  });

  // ── Phone chat sheet (review 2026-11-02, like the 8090 chat) ──────────────
  // On phones the shown chat (one at a time) is a bottom sheet above the
  // action bar. It opens about half way up the screen; its grip drags it
  // from a small height up to just under the top bar, a tap (Enter/Space)
  // on the grip switches half / full, arrows step it, and the height is
  // remembered on this device as a share of the room between the bars (so
  // turning the phone keeps the feel). The office stays visible and usable
  // above it: the map controls ride above it (--vo-chat-sheet-h) and step
  // aside when there is no room (html.vo-chat-sheet-tall). The on-screen
  // keyboard lifts it (visualViewport -> --vo-chat-sheet-bottom) so the
  // composer stays in view.
  const CHAT_SHEET_KEY = 'vo-chat-sheet-share';
  const CHAT_SHEET_MIN = 200;
  const CHAT_SHEET_MIN_LINES = 72; // the small height still shows a few lines of messages
  const chatSheet = { share: null, drag: null, applied: '' };
  try {
    const saved = parseFloat(localStorage.getItem(CHAT_SHEET_KEY));
    if (saved > 0 && saved <= 1) chatSheet.share = saved;
  } catch (_) {}
  function chatSheetTouch() {
    try { return shouldUseSingleWindowMobileLayout() && window.matchMedia('(pointer: coarse)').matches; } catch (_) { return false; }
  }
  function chatSheetPanel() {
    if (!shouldUseSingleWindowMobileLayout()) return null;
    return document.querySelector('.chat-panel.open');
  }
  // Header, model bar, task chips and composer: everything but the messages.
  function chatSheetFixedHeight(panel) {
    let sum = 0;
    for (const child of panel?.children || []) {
      if (child.classList?.contains('chat-body')) continue;
      const cs = getComputedStyle(child);
      if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
      sum += child.offsetHeight || 0;
    }
    return sum;
  }
  function chatSheetRoom(panel) {
    const H = window.innerHeight || 0;
    const vv = window.visualViewport;
    const visTop = vv ? vv.offsetTop : 0;
    const visBottom = vv ? vv.offsetTop + vv.height : H;
    const kb = Math.max(0, Math.round(H - visBottom));
    const keyboard = kb > 80 && (!vv || Math.abs((vv.scale || 1) - 1) < 0.01);
    const barH = document.querySelector('.vo-actionbar')?.getBoundingClientRect?.().height || 0;
    const tb = document.querySelector('.vo-topbar')?.getBoundingClientRect?.() || { bottom: 0, height: 0 };
    const rest = Math.max(CHAT_SHEET_MIN, Math.round(H - barH - tb.bottom));
    const max = keyboard ? Math.max(120, Math.round(visBottom - visTop - tb.height)) : rest;
    const min = Math.min(max, Math.max(CHAT_SHEET_MIN, chatSheetFixedHeight(panel || chatSheetPanel()) + CHAT_SHEET_MIN_LINES));
    return { H, kb, keyboard, barH, top: tb.bottom, rest, max, min, half: Math.round(H / 2 - barH) };
  }
  function chatSheetClamp(h, room) {
    return Math.round(Math.max(room.min, Math.min(room.max, h)));
  }
  // A task chip or a wrapped row appearing squeezes the messages: re-check the small height then.
  const chatSheetObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => applyChatSheet()) : null;
  function applyChatSheet() {
    const root = document.documentElement;
    const panel = chatSheetPanel();
    const body = panel?.querySelector('.chat-body') || null;
    if (chatSheetObserver && chatSheet.observed !== body) {
      chatSheetObserver.disconnect();
      chatSheet.observed = body;
      if (body) chatSheetObserver.observe(body);
    }
    if (!panel) {
      if (chatSheet.applied) {
        chatSheet.applied = '';
        root.style.removeProperty('--vo-chat-sheet-h');
        root.style.removeProperty('--vo-chat-sheet-bottom');
        root.classList.remove('vo-chat-sheet-tall');
      }
      return;
    }
    const room = chatSheetRoom(panel);
    const want = chatSheet.drag?.moved ? chatSheet.drag.h : chatSheet.share != null ? chatSheet.share * room.rest : room.half;
    const h = chatSheetClamp(want, room);
    const mapH = document.querySelector('.vo-mapctl')?.offsetHeight || 0;
    const tall = room.keyboard || room.H - room.barH - h - room.top < mapH + 16;
    const key = `${h}|${room.keyboard ? room.kb : ''}|${tall}`;
    if (key === chatSheet.applied) return;
    chatSheet.applied = key;
    root.style.setProperty('--vo-chat-sheet-h', h + 'px');
    if (room.keyboard) root.style.setProperty('--vo-chat-sheet-bottom', room.kb + 'px');
    else root.style.removeProperty('--vo-chat-sheet-bottom');
    root.classList.toggle('vo-chat-sheet-tall', tall);
  }
  function setChatSheetHeight(h) {
    const room = chatSheetRoom();
    chatSheet.share = Math.max(0.05, Math.min(1, chatSheetClamp(h, room) / room.rest));
    try { localStorage.setItem(CHAT_SHEET_KEY, chatSheet.share.toFixed(3)); } catch (_) {}
    applyChatSheet();
  }
  function chatSheetGripOf(event) {
    const grip = event.target?.closest?.('.chat-sheet-grip');
    const panel = grip?.closest?.('.chat-panel');
    return grip && panel && panel === chatSheetPanel() ? { grip, panel } : null;
  }
  document.addEventListener('pointerdown', (event) => {
    const hit = chatSheetGripOf(event);
    if (!hit || event.button > 0) return;
    event.preventDefault();
    const height = hit.panel.getBoundingClientRect().height;
    chatSheet.drag = { id: event.pointerId, y: event.clientY, start: height, h: height, moved: false, grip: hit.grip };
    hit.grip.classList.add('is-dragging');
    try { hit.grip.setPointerCapture(event.pointerId); } catch (_) {}
  });
  document.addEventListener('pointermove', (event) => {
    const drag = chatSheet.drag;
    if (!drag || event.pointerId !== drag.id) return;
    const dy = drag.y - event.clientY;
    if (!drag.moved && Math.abs(dy) < 5) return;
    drag.moved = true;
    drag.h = drag.start + dy;
    if (event.cancelable) event.preventDefault();
    applyChatSheet();
  }, { passive: false });
  function endChatSheetDrag(event) {
    const drag = chatSheet.drag;
    if (!drag || event.pointerId !== drag.id) return;
    chatSheet.drag = null;
    drag.grip.classList.remove('is-dragging');
    if (!drag.moved) return; // a tap: the click below switches half / full
    drag.grip.dataset.dragged = '1';
    setTimeout(() => { delete drag.grip.dataset.dragged; }, 0);
    const room = chatSheetRoom();
    let h = chatSheetClamp(drag.h, room);
    if (h >= room.max - 48) h = room.max; // snap to full
    else if (h <= room.min + 24) h = room.min; // and to the small height
    setChatSheetHeight(h);
  }
  document.addEventListener('pointerup', endChatSheetDrag);
  document.addEventListener('pointercancel', endChatSheetDrag);
  document.addEventListener('click', (event) => {
    const hit = chatSheetGripOf(event);
    if (!hit) return;
    if (hit.grip.dataset.dragged) { delete hit.grip.dataset.dragged; return; }
    const room = chatSheetRoom();
    const now = hit.panel.getBoundingClientRect().height;
    setChatSheetHeight(now >= room.max - 24 ? room.half : room.max);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const hit = chatSheetGripOf(event);
    if (!hit) return;
    event.preventDefault();
    const room = chatSheetRoom();
    const step = Math.round(room.rest / 10) * (event.key === 'ArrowUp' ? 1 : -1);
    setChatSheetHeight(hit.panel.getBoundingClientRect().height + step);
  });
  window.addEventListener('resize', applyChatSheet);
  window.addEventListener('vo:chat-windows', applyChatSheet);
  window.visualViewport?.addEventListener?.('resize', applyChatSheet);
  window.visualViewport?.addEventListener?.('scroll', applyChatSheet);

  /** The next agent no chat window shows (the first one when all are taken). */
  function nextFreeAgentOption(except) {
    const options = officeOptions(primaryWindow.agentSelect).filter(opt => opt.dataset.sessionKey);
    const used = new Set((windowManager?.slots() || []).map(chatWindowBySlot).filter(w => w && w !== except).map(w => w.selectedAgentKey));
    return options.find(opt => !used.has(opt.value)) || null;
  }

  /** The header's "+": another chat window; its agent picker opens so the person chooses. */
  function openAnotherChatWindow(fromWin) {
    // unify: the layer mounted: a new copied window (its picker open); not known yet: once it is
    if (router === true) return openLayerChats({ newWindow: true });
    if (router === null && (layerHasGateway || window.voPLReady)) {
      routerDecided.then(() => openAnotherChatWindow(fromWin));
      return null;
    }
    if (!windowManager) return null;
    if (!windowManager.canOpen()) {
      chatToast(`${windowManager.max} chat windows are open. Close one to open another.`);
      return null;
    }
    // (v0.12: an office with only OpenClaw/Hermes agents of the layer: a new copied window)
    if (layerOnlyOffice()) return openLayerChats({ newWindow: true });
    const slot = windowManager.freeSlot();
    const win = chatWindowBySlot(slot);
    if (!win) return null;
    const fromPick = fromWin?.agentSelect?.selectedOptions?.[0] || null;
    const pick = nextFreeAgentOption(win) || (isLayerOption(fromPick) ? null : fromPick);
    windowManager.show(slot);
    if (pick) {
      const option = chatOptionForAgent(win, pick.value) || pick;
      win.applySelection(option, { markExplicit: true, systemPrefix: 'Ready to chat with' });
      if (!keepChatInOneWindow(win, { fresh: true })) return null;
    }
    try {
      win.agentSelect?.focus?.({ preventScroll: true });
      win.agentSelect?.showPicker?.();
    } catch (_) { /* the picker opens on the next click instead */ }
    return slot;
  }

  /** One chat is never in two windows: an agent picked in a second window gets a new
   *  chat; an agent that has only one chat sends the person to the window that shows it. */
  function keepChatInOneWindow(win, { previousAgentKey = '', fresh = false } = {}) {
    if (!windowManager || !win) return true;
    const other = windowManager.holder(chatKeyOf(win), win.slotId);
    if (!other) return true;
    const canStartNew = !!win.newSessionBtn && !win.newSessionBtn.hidden && !win.newSessionBtn.disabled;
    if (canStartNew) {
      Promise.resolve(win.createSessionFromPanel({ skipConfirm: true })).catch(() => {});
      return true;
    }
    const name = win.agentFace().name || 'This agent';
    if (fresh) windowManager.close(win.slotId);
    else {
      const back = previousAgentKey ? chatOptionForAgent(win, previousAgentKey) : null;
      if (back) win.applySelection(back, { markExplicit: true, systemPrefix: 'Back to' });
    }
    windowManager.show(other);
    chatToast(`${name}'s chat is already open in another window.`);
    return false;
  }
  const startupAgentLists = Promise.all(chatWindows.map(w => w.loadAgentList())).catch(() => null);
  const tickTaskProgress = () => {
    chatWindows.forEach(w => {
      w.syncTaskProgress();
      if (w.isVisibleForPolling()) w.updateComposerControls();
    });
    if (!document.hidden) progressStore.tick();
    if (windowManager?.count()) scheduleWindowRailPaint();   // a window's "working" ring follows its run
  };
  let progressTick = setInterval(tickTaskProgress, 1000);
  document.addEventListener('visibilitychange', () => {
    chatWindows.forEach(w => w.syncTaskProgress());
    if (!document.hidden) {
      progressStore.connectionChanged();
      // Coming back to the tab: read what arrived while it was hidden.
      chatWindows.forEach(w => { if (w.isVisibleForPolling() && w.followLatest) w.clearUnread(); });
    }
  });
  window.addEventListener('pagehide', () => {
    clearInterval(progressTick);
    chatWindows.forEach(w => w.progressPanel?.select(null));
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { clearInterval(progressTick); progressTick = setInterval(tickTaskProgress, 1000); tickTaskProgress(); }
  });
  syncSecondaryChatControls();

  function applyQueryAgentAssignments() {
    // (unify: the layer mounted: those agents in copied windows)
    if (router === null) { routerDecided.then(applyQueryAgentAssignments); return; }
    if (router) { routeQueryAgents(); return; }
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('chatAgents');
    if (!mode) return;
    const windows = [primaryWindow, ...Object.values(secondaryChatPanels).map(panel => chatWindowsByRoot.get(panel)).filter(Boolean)];
    const allOptions = primaryWindow.agentSelect ? Array.from(primaryWindow.agentSelect.querySelectorAll('option')) : [];
    if (!allOptions.length) return;

    let assignments = [];
    if (mode === 'auto') {
      assignments = officeOptions(primaryWindow.agentSelect).slice(0, windows.length);
    } else {
      const requestedKeys = mode.split(',').map(s => s.trim()).filter(Boolean);
      assignments = requestedKeys.map((key) => allOptions.find(opt => opt.value === key || opt.dataset.agentId === key || opt.dataset.sessionKey === key)).filter(Boolean);
      // (v0.12: an OpenClaw/Hermes agent of the layer asked for by name: the copied window)
      assignments.filter(isLayerOption).forEach(opt => handToLayer(opt.value));
      assignments = assignments.filter(opt => !isLayerOption(opt));
    }

    assignments.forEach((opt, index) => {
      const windowInstance = windows[index];
      if (!windowInstance || !opt) return;
      windowInstance.applySelection(opt, { markExplicit: false, systemPrefix: 'Loaded' });
    });
  }

  const chatBtn = document.getElementById('chat-toggle');
  const exteriorTabs = document.getElementById('chat-exterior-tabs');

  /* Position the exterior tabs bar right above the chat panel */
  let _tabsRafPending = false;
  function _positionExteriorTabs() {
    if (_tabsRafPending) return;
    _tabsRafPending = true;
    requestAnimationFrame(() => {
      _tabsRafPending = false;
      if (!exteriorTabs) return;
      const panel = primaryWindow.root;
      const rect = panel.getBoundingClientRect();
      exteriorTabs.style.bottom = (window.innerHeight - rect.top) + 'px';
      exteriorTabs.style.right = (window.innerWidth - rect.right) + 'px';
      exteriorTabs.style.width = rect.width + 'px';
    });
  }

  // P2-1: on phones the chat covers the screen, so it is a window like any
  // other: registered with the design layer (VOUI) so Tab stays inside and Esc
  // closes it, and closing gives focus back to whatever opened it.
  const chatWindowState = { registered: false, opener: null, addedRole: false, addedModal: false };
  // Phones show chat as a bottom sheet with the office usable above it (review
  // 2026-11-02), not as a full-screen window: no layout makes chat modal now.
  function chatIsFullScreenLayout() {
    return false;
  }
  function rememberChatOpener(opener) {
    const el = opener && opener.nodeType === 1 ? opener : document.activeElement;
    if (el && el !== document.body && !el.closest?.('.chat-panel')) chatWindowState.opener = el;
  }
  function focusPrimaryComposer() {
    const input = primaryWindow.input;
    if (!input || input.disabled) return;
    // Touch phones: no keyboard over the half-height sheet (like 8090); a tap on the composer types.
    if (chatSheetTouch()) return;
    try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
  }
  function registerChatWindow() {
    const ui = window.VOUI;
    const root = primaryWindow.root;
    if (chatWindowState.registered || !ui || typeof ui.openWindow !== 'function' || !chatIsFullScreenLayout()) return;
    chatWindowState.registered = true;
    chatWindowState.addedRole = !root.hasAttribute('role');
    chatWindowState.addedModal = !root.hasAttribute('aria-modal');
    try {
      ui.openWindow(root, {
        opener: chatWindowState.opener,
        initialFocus: primaryWindow.input,
        scrim: false,
        onClose: () => {
          // Same rule as the panel's own Esc: never drop a draft being typed.
          const input = primaryWindow.input;
          if (input && document.activeElement === input && String(input.value || '').trim()) return;
          if (windowManager) windowManager.putAway(primaryWindow.slotId);
          else setPrimaryPanelOpen(false);
        }
      });
    } catch (_) {
      chatWindowState.registered = false;
    }
  }
  function unregisterChatWindow() {
    const root = primaryWindow.root;
    if (!chatWindowState.registered) return;
    chatWindowState.registered = false;
    try { window.VOUI?.closeWindow?.(root); } catch (_) {}
    if (chatWindowState.addedRole) root.removeAttribute('role');
    if (chatWindowState.addedModal) root.removeAttribute('aria-modal');
  }
  function releaseChatWindow() {
    const root = primaryWindow.root;
    unregisterChatWindow();
    // Never leave focus on a control of the closed (hidden) chat.
    const active = document.activeElement;
    if (active && active !== document.body && root.contains(active)) {
      const back = chatWindowState.opener;
      const backVisible = back && back.isConnected && !back.closest('[inert]') && back.getClientRects().length > 0;
      if (backVisible) {
        try { back.focus({ preventScroll: true }); } catch (_) { back.focus(); }
      } else {
        active.blur();
      }
    }
  }

  function syncChatWindowRegistration() {
    if (!primaryWindow.root.classList.contains('open')) return;
    if (chatIsFullScreenLayout()) registerChatWindow();
    else if (chatWindowState.registered) {
      // Back to the desktop layout with chat still open: stay where focus is.
      const active = document.activeElement;
      unregisterChatWindow();
      if (active && primaryWindow.root.contains(active) && document.activeElement !== active) {
        try { active.focus({ preventScroll: true }); } catch (_) {}
      }
    }
  }

  function setPrimaryPanelOpen(shouldOpen, opener = null, { focus = true } = {}) {
    const wasOpen = primaryWindow.root.classList.contains('open');
    if (shouldOpen && !wasOpen) rememberChatOpener(opener);
    primaryWindow.root.classList.toggle('open', shouldOpen);
    primaryWindow.syncTaskProgress();
    chatBtn.classList.toggle('active', shouldOpen);
    chatBtn.style.display = shouldOpen ? 'none' : 'flex';
    if (exteriorTabs) exteriorTabs.classList.toggle('visible', shouldOpen);
    if (shouldOpen) {
      requestAnimationFrame(_positionExteriorTabs);
      // The panel opens with a transform transition, so the first geometry
      // read still sees it off-screen. Re-tile secondary windows and re-anchor
      // the tabs once that finishes; otherwise a secondary opened during the
      // transition can retain the primary panel's intermediate top position
      // and leave its composer below the viewport.
      setTimeout(() => {
        if (!primaryWindow.root.classList.contains('open')) return;
        _tileSecondaryPanelsNow();
        _clampOpenChatPanelsToViewport();
        _positionExteriorTabs();
      }, 320);
    }
    if (shouldOpen && !ws) connectGateway();
    if (shouldOpen) {
      if (focus && !shouldUseSingleWindowMobileLayout()) primaryWindow.input.focus();
      registerChatWindow();
      primaryWindow.scrollBottom();
      primaryWindow.resumeWhenVisible();
    } else {
      // The other chat windows have their own buttons now: they stay as they are.
      if (!windowManager) closeAllSecondaryPanels();
      primaryWindow.suspendWhenHidden();
      releaseChatWindow();
    }
  }

  // open()/toggle() from the dock and the phone bar behave like openForAgent:
  // the composer gets focus (P2-1).
  function openPrimaryChat(options = {}, { known = false, toggle = false } = {}) {
    // unify: the layer mounted: the copied windows for every agent (back, else the agent and chat used last)
    if (router === true) {
      openLayerChats({ toggle });
      return true;
    }
    // v0.12: first whether the layer owns OpenClaw and Hermes and which agents this office lists (a page without the
    // layer's script opens at once, as before)
    const layerMaybe = !layerKnown && (!!window.voPLReady || document.readyState === 'loading');
    if (!known && (layerMaybe || (router === null && layerOwnsChats()) || (layerOwnsChats() && !primaryWindow.agentListLoaded))) {
      routerDecided.then(on => (!on && layerOwnsChats() && !primaryWindow.agentListLoaded ? primaryWindow.loadAgentList() : null))
        .catch(() => null).then(() => openPrimaryChat(options, { known: true, toggle }));
      return true;
    }
    // (only OpenClaw/Hermes agents of the layer: their copied windows, the most recent chat when none is open)
    if (layerOnlyOffice()) {
      openLayerChats({ toggle });
      return true;
    }
    if (windowManager) {
      if (options?.opener) rememberChatOpener(options.opener);
      // Windows already there come back; else the main window opens.
      if (!windowManager.count() || !windowManager.showAll()) windowManager.show(primaryWindow.slotId);
      const front = chatWindowBySlot(windowManager.front());
      if (front === primaryWindow) focusPrimaryComposer();
      else if (front && !shouldUseSingleWindowMobileLayout()) front.input?.focus?.();
      return true;
    }
    setPrimaryPanelOpen(true, options?.opener || null);
    focusPrimaryComposer();
    return true;
  }
  /** v0.12: this office lists agents, every one an OpenClaw/Hermes agent of the layer (nothing for this window). */
  function layerOnlyOffice() {
    return layerOwnsChats() && !!primaryWindow.agentSelect?.querySelector('option') && !officeOptions(primaryWindow.agentSelect).length;
  }
  /** v0.12: the copied windows instead of this one: shown (toggle: put away when shown), or a new one (newWindow). */
  async function openLayerChats({ newWindow = false, toggle = false } = {}) {
    const pl = await theLayer();
    if (!pl || typeof pl.showChats !== 'function') {
      chatToast('OpenClaw and Hermes are off in this office.');
      return null;
    }
    // (unify: "+" is a new window beside the others, its agent picker open)
    if (newWindow) return typeof pl.newWindow === 'function' ? pl.newWindow() : pl.openRecent({ newWindow: true });
    return toggle ? pl.toggleChats() : pl.showChats();
  }
  function chatWindowsShown() {
    if (router === true) {
      const pl = layerPL || window.voPL;
      return !!(pl && typeof pl.chatsShown === 'function' && pl.chatsShown());
    }
    return windowManager ? windowManager.shownCount() > 0 : primaryWindow.root.classList.contains('open');
  }
  function putAllChatsAway() {
    if (router === true) {
      if (chatWindowsShown()) (layerPL || window.voPL).toggleChats();
      return;
    }
    if (windowManager) { if (windowManager.shownCount()) windowManager.toggleAll(); }
    else setPrimaryPanelOpen(false);
  }

  function chatOptionForAgent(windowInstance, agentId) {
    const needle = String(agentId || '').toLowerCase();
    return [...(windowInstance?.agentSelect?.querySelectorAll('option') || [])].find(option => {
      let aliases = [];
      try { aliases = JSON.parse(option.dataset.selectionAliases || '[]'); } catch { aliases = []; }
      return [option.value, option.dataset.agentId, option.dataset.providerAgentId, option.dataset.sessionKey, ...aliases]
        .some(value => value != null && String(value).toLowerCase() === needle);
    }) || null;
  }

  function chatWindowHasAgentSelected(windowInstance, agentId) {
    const selected = windowInstance?.agentSelect?.selectedOptions?.[0];
    if (!selected) return false;
    const match = chatOptionForAgent(windowInstance, agentId);
    return Boolean(match && selected === match);
  }

  // Office life (needs-you, interns, visitors) opens a chat at a given place:
  // options.sessionKey switches the window to that session, options.focus
  // ({approvalId} | {questionId}) scrolls to that card and flashes it,
  // options.panel ('tasks') opens the side panel on that tab.
  function sessionMatches(session, key) {
    if (!session || !key) return false;
    return [session.sessionKey, session.key, session.id].some(value => value != null && String(value) === key) ||
      (session.id != null && key.endsWith(':' + String(session.id)));
  }
  async function switchWindowToSession(win, sessionKey) {
    const key = String(sessionKey || '');
    if (!key || win.sessionKey === key) return;
    let found = null;
    try {
      const agentId = win.getSelectedAgentId() || win.selectedAgentKey;
      const res = await fetch('/api/office/chat-sessions?agentId=' + encodeURIComponent(agentId) + '&limit=40');
      const data = await res.json();
      found = (Array.isArray(data?.sessions) ? data.sessions : []).find(session => sessionMatches(session, key)) || null;
    } catch (_) { found = null; }
    if (found) {
      if (!sessionMatches({ sessionKey: win.sessionKey }, found.sessionKey || key)) await win.switchToSession(found);
    } else if (win.getSelectedProviderKind() === 'openclaw' && !win.isProviderAgentSelected()) {
      // OpenClaw gateway sessions are opened by key even when the list does not show them.
      await win.switchToSession({ sessionKey: key });
    }
  }
  // Bring a card into view by scrolling the window's own message list (never
  // the page: element scrolling into view would move the office page too).
  // A card above the latest messages pauses follow mode so new output does not
  // pull the view away; "Jump to latest" brings it back.
  function revealChatCard(win, card, reduce) {
    const box = win.messages;
    if (!box || !box.contains(card)) return;
    const view = box.getBoundingClientRect();
    const rect = card.getBoundingClientRect();
    if (rect.top >= view.top && rect.bottom <= view.bottom) return;
    const maxTop = Math.max(0, box.scrollHeight - box.clientHeight);
    const top = Math.round(Math.min(maxTop, Math.max(0, box.scrollTop + (rect.top - view.top) - (box.clientHeight - rect.height) / 2)));
    if (maxTop - top > CHAT_BOTTOM_FOLLOW_THRESHOLD) {
      win.followLatest = false;
      win.cancelPendingScrollBottom?.();
    }
    try { box.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' }); } catch (_) { box.scrollTop = top; }
    win.updateScrollLatestButton?.();
  }
  function focusChatCard(win, focus) {
    const id = String(focus?.approvalId || focus?.questionId || '');
    if (!id) return;
    const attr = focus.approvalId ? 'approvalId' : 'questionId';
    const started = Date.now();
    const look = () => {
      const card = [...(win.messages?.querySelectorAll(attr === 'approvalId' ? '[data-approval-id]' : '[data-question-id]') || [])]
        .find(el => el.dataset[attr] === id);
      if (!card) {
        // The card may still be on its way (history load, Hermes follow).
        if (Date.now() - started < 8000) setTimeout(look, 250);
        return;
      }
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      revealChatCard(win, card, reduce);
      card.dataset.voFocus = 'true';
      try {
        card.animate([{ boxShadow: '0 0 0 0 rgba(251,191,36,0)' }, { boxShadow: '0 0 0 3px rgba(251,191,36,0.95)' }, { boxShadow: '0 0 0 0 rgba(251,191,36,0)' }],
          { duration: 700, iterations: reduce ? 1 : 2 });
      } catch (_) {}
      setTimeout(() => { delete card.dataset.voFocus; }, 1600);
    };
    look();
  }
  async function applyOpenOptions(win, options) {
    if (!win || !options) return;
    try {
      if (options.sessionKey) await switchWindowToSession(win, options.sessionKey);
      if (options.panel && win.sidePanel?.open) win.sidePanel.open(String(options.panel));
      if (options.focus) focusChatCard(win, options.focus);
    } catch (e) {
      console.warn('chat: open options', e);
    }
  }
  function chatOpenedForAgent(agentId, slotId, options) {
    if (slotId) {
      const win = chatWindowBySlot(slotId);
      if (options && (options.sessionKey || options.focus || options.panel)) applyOpenOptions(win, options);
      try { window.dispatchEvent(new CustomEvent('vo:chat-opened-agent', { detail: { agentId, slot: slotId } })); } catch (_) {}
    }
    return slotId;
  }

  /** v0.12: agent `needle` belongs to the copied window (the layer owns OpenClaw and Hermes and it is one of theirs). */
  async function layerTakes(needle) {
    if (!(await layerDecided)) return false;
    const pl = layerPL || window.voPL;
    if (pl && pl.isLayerAgent(needle)) return true;
    let opt = chatOptionForAgent(primaryWindow, needle);
    if (!opt) {
      await primaryWindow.loadAgentList();
      opt = chatOptionForAgent(primaryWindow, needle);
    }
    return isLayerOption(opt);
  }

  /** v0.12: OpenClaw/Hermes agent `needle` in the copied window. A layer that has not listed it yet (its connection
   *  still coming up) gets a few seconds; it never opens here instead. */
  async function handToLayer(needle, options = {}) {
    const pl = await theLayer();
    if (pl) {
      for (let waited = 0; !pl.isLayerAgent(needle) && waited < LAYER_WAIT_MS; waited += 400) await new Promise(r => setTimeout(r, 400));
      if (pl.isLayerAgent(needle)) return pl.open(needle, options);
    }
    const opt = chatOptionForAgent(primaryWindow, needle);
    const name = opt?.dataset?.name || needle;
    chatToast(pl ? `${name} can't chat right now. Agent Providers shows why.` : `${name} can't chat right now: OpenClaw and Hermes are off in this office.`);
    return null;
  }

  async function openChatForAgent(agentId, options = {}) {
    const needle = String(agentId || '').trim();
    if (!needle) return null;
    // unify: the layer mounted: every agent (its chat when Office Life names one) in the copied window
    if (await routerOn()) return routeAgent(needle, options);
    // v0.11 (VO_PROVIDER_LAYER=1): OpenClaw and Hermes agents open the copied chat window; every other provider stays here
    // (v0.12: also when asked before the layer mounted, or for an agent it has not listed yet).
    if (await layerTakes(needle)) return handToLayer(needle, options);
    if (!chatOptionForAgent(primaryWindow, needle)) await Promise.all(chatWindows.map(windowInstance => windowInstance.loadAgentList()));
    if (!windowManager) return null;

    // A window that shows this agent comes forward (back from put away too).
    const listed = windowManager.slots().map(chatWindowBySlot).filter(Boolean);
    const front = chatWindowBySlot(windowManager.front());
    const holderWin = (front && listed.includes(front) && chatWindowHasAgentSelected(front, needle) ? front : null) ||
      listed.find(windowInstance => chatWindowHasAgentSelected(windowInstance, needle));
    if (holderWin) {
      windowManager.show(holderWin.slotId);
      const option = chatOptionForAgent(holderWin, needle);
      if (option) holderWin.applySelection(option, { markExplicit: true, systemPrefix: 'Ready to chat with' });
      if (!chatSheetTouch()) holderWin.input?.focus();
      return chatOpenedForAgent(needle, holderWin.slotId, options);
    }

    // Else a new window (the main one first); with four open, the one used
    // longest ago that has nothing going on.
    const slot = windowManager.canOpen() ? windowManager.freeSlot() : windowManager.reusable();
    if (!slot) {
      chatToast(`${windowManager.max} chat windows are open. Close one to open another.`);
      return null;
    }
    const targetWindow = chatWindowBySlot(slot);
    windowManager.show(slot);
    const option = chatOptionForAgent(targetWindow, needle) || chatOptionForAgent(primaryWindow, needle);
    if (!option) return null;
    targetWindow.applySelection(option, { markExplicit: true, systemPrefix: 'Ready to chat with' });
    if (!chatSheetTouch()) targetWindow.input?.focus();
    return chatOpenedForAgent(needle, targetWindow.slotId, options);
  }

  // C4 chat API used by the dock and other surfaces.
  window.VirtualOfficeChat = Object.assign(window.VirtualOfficeChat || {}, {
    openForAgent: openChatForAgent,
    open(options) { return openPrimaryChat(options); },
    close() { putAllChatsAway(); return false; },
    toggle(options) {
      if (chatWindowsShown()) {
        putAllChatsAway();
        return false;
      }
      return openPrimaryChat(options, { toggle: true });
    },
    isOpen() { return chatWindowsShown(); },
    openNewWindow() { return openAnotherChatWindow(chatWindowBySlot(windowManager?.front()) || primaryWindow); },
    windows() { return windowManager ? windowManager.view() : []; },
    unreadCount() { return totalUnreadCount(); }
  });
  window.addEventListener('vo:open-agent-chat', event => openChatForAgent(event.detail?.agentId));

  chatBtn.addEventListener('click', () => {
    if (chatWindowsShown()) putAllChatsAway();
    else openPrimaryChat({ opener: chatBtn }, { toggle: true });
  });
  // (unify: the layer mounted: this button's count is the copied windows' total, as the dock's)
  window.addEventListener('vo:chat-unread', event => {
    if (router !== true || event.detail?.source !== 'pl' || !chatBtn) return;
    const n = Number(event.detail.count) || 0;
    if (n) chatBtn.dataset.unread = n > 9 ? '9+' : String(n);
    else delete chatBtn.dataset.unread;
  });

  const chatUrlParams = new URLSearchParams(window.location.search);
  const chatViewParam = chatUrlParams.get('chatView');
  if (chatViewParam === 'all') {
    setTimeout(function showEveryWindow() {
      // (unify: the layer mounted: the copied windows, and ?chatAgents' agents in them)
      if (router === null) { routerDecided.then(showEveryWindow); return; }
      if (router) { routeQueryAgents(); return; }
      if (windowManager) chatWindows.forEach(w => windowManager.show(w.slotId, { focus: false }));
      else {
        setPrimaryPanelOpen(true);
        setSecondaryPanelOpen('1', true);
        setSecondaryPanelOpen('2', true);
        setSecondaryPanelOpen('3', true);
      }
      enforceSingleWindowMobileLayout();
      setTimeout(applyQueryAgentAssignments, 400);
    }, 50);
  } else if (chatUrlParams.get('chatAgents')) {
    setTimeout(applyQueryAgentAssignments, 400);
  } else if (windowManager) {
    // The chat windows open before the reload come back (each on its saved chat).
    restoreChatWindows();
  }
  scheduleWindowRailPaint();

  /** v0.12: once it is known whether the layer owns OpenClaw and Hermes (with the layer off: as before). With it on, an
   *  office window saved on one of their agents (0.9 and 0.10 chatted with them here; a 0.11 picker could choose one)
   *  is left out quietly and its agent opens in the copied window instead when the window was shown (a phone: the
   *  front one only). The other windows come back as they were. */
  async function restoreChatWindows() {
    const savedWins = (() => {
      try { return JSON.parse(localStorage.getItem(globalThis.ChatWindows?.STORAGE_KEY || 'vo.chat.windows') || 'null'); } catch (_) { return null; }
    })();
    const savedPicks = readSavedChatSelections();
    if (!(await layerDecided)) {
      windowManager.restore();
      scheduleWindowRailPaint();
      return;
    }
    // unify: no office window comes back; the saved ones move to the copied window once (their keys stay as they are)
    if (await routerDecided) {
      routerMigration = migrateSavedChats().catch(e => { console.warn('[chat] saved windows not moved:', e); return null; });
      return;
    }
    await startupAgentLists;
    const all = [...(primaryWindow.agentSelect?.querySelectorAll('option') || [])];
    // (the main window without a saved choice showed the default agent, "main")
    const layerPick = slot => {
      const key = savedPicks[slot]?.selectedAgentKey;
      let opt = key ? all.find(o => optionMatchesSelectedAgent(o, key)) : null;
      if (!key && slot === primaryWindow.slotId) {
        opt = all.find(o => optionMatchesSelectedAgent(o, 'main')) || all.find(o => o.dataset.sessionKey === 'agent:main:main') || all[0] || null;
      }
      return opt && isLayerOption(opt) ? opt.value : '';
    };
    const wins = Array.isArray(savedWins?.wins) ? savedWins.wins.filter(w => w && typeof w.slot === 'string') : [];
    const front = savedWins?.front || null;
    const gone = wins.filter(w => layerPick(w.slot));
    // (a slot saved on such an agent but not open: its choice goes too, so it opens on a free agent next time)
    const goneSlots = new Set([...gone.map(w => w.slot), ...Object.keys(savedPicks).filter(slot => layerPick(slot))]);
    if (goneSlots.size) {
      const phone = shouldUseSingleWindowMobileLayout();
      const frontGone = gone.some(w => w.slot === front && !w.min);
      const handOver = gone.filter(w => !w.min && (!phone || w.slot === front))
        .sort((a, b) => (a.slot === front) - (b.slot === front))
        .map(w => layerPick(w.slot));
      const keep = wins.filter(w => !goneSlots.has(w.slot)).map(w => (phone && frontGone ? { ...w, min: true } : w));
      try {
        if (savedWins) localStorage.setItem(globalThis.ChatWindows?.STORAGE_KEY || 'vo.chat.windows', JSON.stringify({ ...savedWins, wins: keep, front: keep.some(w => w.slot === front) ? front : null }));
        const picks = readSavedChatSelections();
        goneSlots.forEach(slot => { delete picks[slot]; });
        localStorage.setItem(CHAT_SELECTION_STORAGE_KEY, JSON.stringify(picks));
      } catch (_) { /* private mode: nothing was saved either */ }
      goneSlots.forEach(slot => {
        const w = chatWindowBySlot(slot);
        if (w) { w.hasExplicitAgentSelection = false; w.restoreSelection = null; }
      });
      windowManager.restore();
      chatWindows.forEach(w => w.leaveToLayer());
      scheduleWindowRailPaint();
      for (const key of [...new Set(handOver)]) await handToLayer(key);
      return;
    }
    windowManager.restore();
    chatWindows.forEach(w => w.leaveToLayer());   // (an office with only their agents: nothing here)
    scheduleWindowRailPaint();
  }

  // Query-gated replay surface used by the regression suite on development
  // instances. It exercises the real ChatWindow renderer without exposing
  // provider credentials, gateway RPC, or mutation endpoints.
  if (chatUrlParams.get('chatTest') === '1') {
    window.__VO_CHAT_TEST__ = {
      reset() {
        if (!primaryWindow.root.classList.contains('open')) setPrimaryPanelOpen(true);
        primaryWindow.historyRefreshSeq += 1;
        primaryWindow.resetConversation();
        primaryWindow.root.classList.add('open');
      },
      normalized(event) {
        return primaryWindow.applyTurnEvent(event);
      },
      native(provider, eventName, data = {}) {
        return primaryWindow.handleNativeRunEvent(provider, eventName, data);
      },
      openclawChat(payload = {}) {
        return primaryWindow.handleChatEvent({ sessionKey: primaryWindow.sessionKey, ...payload });
      },
      openclawAgent(payload = {}) {
        return primaryWindow.handleAgentEvent({ sessionKey: primaryWindow.sessionKey, ...payload });
      },
      renderHistory(items = []) {
        primaryWindow.renderHistoryItems(items);
      },
      renderOpenClawHistory(messages = []) {
        primaryWindow.renderHistoryItems(primaryWindow.openClawHistoryItems(messages));
      },
      renderProviderHistory(messages = [], progressMarker = '') {
        primaryWindow.renderHistoryItems(primaryWindow.providerHistoryItems(messages, progressMarker));
      },
      runState() {
        return primaryWindow.runState ? { ...primaryWindow.runState } : null;
      },
      primeSend(text) {
        primaryWindow.lastSend = { text: String(text || ''), fence: primaryWindow.selectionFence(), sessionKey: primaryWindow.sessionKey, at: Date.now(), runId: '' };
        primaryWindow.appendMessage('user', String(text || ''), Date.now(), [], { label: 'You', kind: 'human' });
        primaryWindow.setRunState('running');
      },
      snapshot() {
        return [...primaryWindow.messages.children].map((el, index) => ({
          index,
          className: el.className,
          runId: el.dataset.runId || '',
          text: el.textContent.trim(),
          tool: el.querySelector('.chat-tool-name')?.textContent || '',
          toolState: el.querySelector('.chat-tool-state')?.textContent || '',
          thinkingOpen: el.querySelector('.chat-thinking-card')?.open || false
        }));
      }
    };
  }

  gatewayInfoAtStart.then(() => {
    if (chatWindowsShown() && !ws) connectGateway();
  });

  // --- DIRECT TITLE-BAR MOVE / SNAP SYSTEM (primary window only) ---
  const chatPanel = primaryWindow.root;
  let _chatDragPending = false;
  let _chatDragging = false;
  let _chatDragStartX = 0, _chatDragStartY = 0;
  let _chatOrigLeft = 0, _chatOrigTop = 0;
  let _chatOrigWidth = 0, _chatOrigHeight = 0;
  let _chatSnapZoneL = null, _chatSnapZoneR = null;
  let _chatDragMoveFrame = 0;
  let _chatDragPointer = null;
  let _chatDragSidebarWidth = 0;
  let _chatDragDockTop = 0;

  function _chatCreateSnapZones() {
    if (_chatSnapZoneL) return;
    _chatSnapZoneL = document.createElement('div'); _chatSnapZoneL.className = 'chat-snap-zone left';
    _chatSnapZoneR = document.createElement('div'); _chatSnapZoneR.className = 'chat-snap-zone right';
    document.body.appendChild(_chatSnapZoneL); document.body.appendChild(_chatSnapZoneR);
  }
  function _chatRemoveSnapZones() {
    if (_chatSnapZoneL) { _chatSnapZoneL.remove(); _chatSnapZoneL = null; }
    if (_chatSnapZoneR) { _chatSnapZoneR.remove(); _chatSnapZoneR = null; }
  }
  function _getSidebarWidth() {
    var sb = document.querySelector('.sidebar'); var edge = document.querySelector('.sidebar-edge');
    if (!sb || sb.classList.contains('collapsed')) return (edge ? edge.offsetWidth : 20);
    return sb.offsetWidth + (edge ? edge.offsetWidth : 20);
  }
  function _chatCancelDrag() {
    if (_chatDragMoveFrame) cancelAnimationFrame(_chatDragMoveFrame);
    _chatDragMoveFrame = 0;
    _chatDragPointer = null;
    _chatDragPending = false;
    _chatDragging = false;
    chatPanel.classList.remove('dragging');
    _chatRemoveSnapZones();
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    document.body.style.cursor = '';
  }
  function _chatBeginDrag() {
    _chatDragPending = false;
    _chatDragging = true;
    chatPanel.classList.remove('snap-left', 'snap-right', 'move-active');
    chatPanel.classList.add('floating', 'dragging');
    chatPanel.style.left = _chatOrigLeft + 'px';
    chatPanel.style.top = _chatOrigTop + 'px';
    chatPanel.style.right = 'auto';
    chatPanel.style.bottom = 'auto';
    chatPanel.style.width = _chatOrigWidth + 'px';
    chatPanel.style.height = _chatOrigHeight + 'px';
    _chatDragSidebarWidth = chatRightInset();
    _chatDragDockTop = document.querySelector('.toolbar.vo-dock')?.getBoundingClientRect().top || window.innerHeight;
    _chatCreateSnapZones();
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }
  function _chatSnapTo(side) {
    chatPanel.classList.remove('floating', 'dragging', 'move-active');
    chatPanel.style.left = ''; chatPanel.style.right = ''; chatPanel.style.bottom = ''; chatPanel.style.width = '380px';
    var wrapper = document.querySelector('.game-wrapper');
    var wRect = wrapper ? wrapper.getBoundingClientRect() : { top: 0, height: window.innerHeight };
    chatPanel.style.top = wRect.top + 'px'; chatPanel.style.height = wRect.height + 'px';
    if (side === 'left') { chatPanel.classList.remove('snap-right'); chatPanel.classList.add('snap-left'); }
    else { chatPanel.classList.remove('snap-left'); chatPanel.classList.add('snap-right'); chatPanel.style.right = chatRightInset() + 'px'; }
    _chatCancelDrag();
    setTimeout(() => { _tileSecondaryPanels(); _positionExteriorTabs(); _resolveOverlaps(chatPanel); }, 50);
  }
  function _chatUpdateSnapPosition() {
    if (chatPanel.classList.contains('snap-right')) chatPanel.style.right = chatRightInset() + 'px';
    if (chatPanel.classList.contains('snap-left') || chatPanel.classList.contains('snap-right')) {
      var wrapper = document.querySelector('.game-wrapper');
      var wRect = wrapper ? wrapper.getBoundingClientRect() : { top: 0, height: window.innerHeight };
      chatPanel.style.top = wRect.top + 'px'; chatPanel.style.height = wRect.height + 'px';
    }
    requestAnimationFrame(_positionExteriorTabs);
  }
  var _sidebarEdge = document.getElementById('sidebar-edge');
  if (_sidebarEdge) _sidebarEdge.addEventListener('click', () => setTimeout(() => { updateChatStackLayout(); _chatUpdateSnapPosition(); }, 350));
  // Chromium can dispatch `resize` before the new media-query layout has
  // finished recalculating. Reading the sidebar width synchronously in that
  // event can therefore preserve the old mobile width and dock the chat far
  // outside the desktop viewport. Wait for two animation frames so layout is
  // settled, then recompute every viewport-dependent chat position.
  let _chatViewportResizeFrame = 0;
  let _chatViewportResizeTimer = 0;
  function _syncChatLayoutAfterViewportResize() {
    const applyViewportLayout = () => {
      enforceSingleWindowMobileLayout();
      syncChatWindowRegistration();
      updateChatStackLayout();
      _chatUpdateSnapPosition();
      _clampOpenChatPanelsToViewport();
      _positionExteriorTabs();
    };
    if (_chatViewportResizeFrame) cancelAnimationFrame(_chatViewportResizeFrame);
    if (_chatViewportResizeTimer) clearTimeout(_chatViewportResizeTimer);
    _chatViewportResizeFrame = requestAnimationFrame(() => {
      _chatViewportResizeFrame = requestAnimationFrame(() => {
        _chatViewportResizeFrame = 0;
        applyViewportLayout();
      });
    });
    // A trailing pass covers browser/device viewport changes whose responsive
    // sidebar transition settles after requestAnimationFrame (notably mobile
    // orientation changes and DevTools device emulation).
    _chatViewportResizeTimer = setTimeout(() => {
      _chatViewportResizeTimer = 0;
      applyViewportLayout();
    }, 180);
  }
  window.addEventListener('resize', _syncChatLayoutAfterViewportResize);
  if (typeof ResizeObserver !== 'undefined') {
    const chatChromeResizeObserver = new ResizeObserver(_syncChatLayoutAfterViewportResize);
    const chatSidebar = document.querySelector('.sidebar');
    const chatSidebarEdge = document.querySelector('.sidebar-edge');
    if (chatSidebar) chatChromeResizeObserver.observe(chatSidebar);
    if (chatSidebarEdge) chatChromeResizeObserver.observe(chatSidebarEdge);
  }
  const chatHeader = chatPanel.querySelector('.chat-header');
  chatHeader.addEventListener('mousedown', (e) => {
    if (window.matchMedia('(max-width: 900px)').matches || e.button !== 0) return;
    if (e.target.closest('button, select, input, textarea, label, a')) return;
    e.preventDefault();
    _chatDragPending = true;
    _chatDragStartX = e.clientX; _chatDragStartY = e.clientY;
    var rect = chatPanel.getBoundingClientRect();
    _chatOrigLeft = rect.left; _chatOrigTop = rect.top;
    _chatOrigWidth = rect.width; _chatOrigHeight = rect.height;
  });
  function _flushChatDragMove() {
    _chatDragMoveFrame = 0;
    if (!_chatDragging || !_chatDragPointer) return;
    const e = _chatDragPointer;
    var dx = e.clientX - _chatDragStartX; var dy = e.clientY - _chatDragStartY;
    // The window stays left of the office's right column (map controls, window buttons) and above the dock.
    var maxLeft = Math.max(0, window.innerWidth - _chatDragSidebarWidth - _chatOrigWidth);
    var maxTop = Math.max(0, _chatDragDockTop - _chatOrigHeight);
    chatPanel.style.left = Math.min(_chatOrigLeft + dx, maxLeft) + 'px'; chatPanel.style.top = Math.min(_chatOrigTop + dy, maxTop) + 'px';
    _tileSecondaryPanels();
    _positionExteriorTabs();
    var rightEdge = window.innerWidth - _chatDragSidebarWidth;
    if (_chatSnapZoneL) _chatSnapZoneL.classList.toggle('active', e.clientX < 80);
    if (_chatSnapZoneR) { _chatSnapZoneR.style.right = _chatDragSidebarWidth + 'px'; _chatSnapZoneR.classList.toggle('active', e.clientX > rightEdge - 80); }
  }

  window.addEventListener('mousemove', (e) => {
    if (_chatDragPending && !_chatDragging) {
      if (Math.hypot(e.clientX - _chatDragStartX, e.clientY - _chatDragStartY) < 4) return;
      _chatBeginDrag();
    }
    if (!_chatDragging) return;
    _chatDragPointer = { clientX: e.clientX, clientY: e.clientY };
    if (!_chatDragMoveFrame) _chatDragMoveFrame = requestAnimationFrame(_flushChatDragMove);
  });
  window.addEventListener('mouseup', (e) => {
    if (_chatDragPending) {
      _chatCancelDrag();
      return;
    }
    if (!_chatDragging) return;
    if (_chatDragMoveFrame) {
      cancelAnimationFrame(_chatDragMoveFrame);
      _flushChatDragMove();
    }
    _chatDragging = false; chatPanel.classList.remove('dragging');
    _chatDragPointer = null;
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    document.body.style.cursor = '';
    var sbW = _chatDragSidebarWidth || chatRightInset(); var rightEdge = window.innerWidth - sbW;
    if (e.clientX < 80) _chatSnapTo('left'); else if (e.clientX > rightEdge - 80) _chatSnapTo('right');
    _chatRemoveSnapZones();
    _tileSecondaryPanels();
    _positionExteriorTabs();
    _resolveOverlaps(chatPanel);
  });
  window.addEventListener('blur', _chatCancelDrag);

  // ─── SHARED CHAT RESIZE SYSTEM (primary + secondary, all directions) ───
  const CHAT_MIN_W = 220;
  const CHAT_MAX_W_RATIO = 0.92;
  const CHAT_MIN_H = 250;
  const CHAT_MAX_H_RATIO = 0.95;

  // Collect primary panel handles
  const _primaryHandleEls = chatPanel.querySelectorAll('.chat-resize-handle');

  /** Generic resize state — one per panel, keyed by slotId */
  const _resizeStates = {};
  let _resizeMoveFrame = 0;
  let _resizePointer = null;

  /** Detect which direction class a handle element has */
  function _getHandleDir(handleEl) {
    if (handleEl.classList.contains('top-left'))     return 'topLeft';
    if (handleEl.classList.contains('top-right'))    return 'topRight';
    if (handleEl.classList.contains('bottom-left'))  return 'bottomLeft';
    if (handleEl.classList.contains('bottom-right')) return 'bottomRight';
    if (handleEl.classList.contains('top'))    return 'top';
    if (handleEl.classList.contains('bottom')) return 'bottom';
    if (handleEl.classList.contains('left'))   return 'left';
    if (handleEl.classList.contains('right'))  return 'right';
    return null;
  }

  /** Is this panel anchored via CSS `right` (default docked mode)? */
  function _isRightAnchored(panel) {
    // Secondary panels are explicitly positioned from the left by the tiling
    // system. Treating them as right-anchored makes a left-edge drag move the
    // wrong edge and then lets the next tile pass overwrite the result.
    if (panel.classList.contains('chat-panel-secondary')) return false;
    // Floating or snapped-left panels are NOT right-anchored
    if (panel.classList.contains('floating') || panel.classList.contains('snap-left')) return false;
    // Default docked-right or snap-right panels ARE right-anchored
    return true;
  }

  /**
   * Apply a width+height resize delta to a panel, respecting min/max and
   * handling the difference between right-anchored and left/floating panels.
   *
   * @param {HTMLElement} panel — the chat-panel element
   * @param {Object} rs — resize state (startX, startY, startW, startH, startRect, dir)
   * @param {number} dx — mouse delta X (positive = moved right)
   * @param {number} dy — mouse delta Y (positive = moved down)
   */
  function _applyResizeDelta(panel, rs, dx, dy) {
    const maxW = rs.maxW;
    const maxH = rs.maxH;
    const dir = rs.dir;
    const rightAnchored = rs.rightAnchored;
    const { startW, startH, startRect } = rs;

    // Determine which axes this direction affects
    const movesLeft   = dir === 'left'   || dir === 'topLeft'    || dir === 'bottomLeft';
    const movesRight  = dir === 'right'  || dir === 'topRight'   || dir === 'bottomRight';
    const movesTop    = dir === 'top'    || dir === 'topLeft'    || dir === 'topRight';
    const movesBottom = dir === 'bottom' || dir === 'bottomLeft' || dir === 'bottomRight';

    // --- Horizontal resize ---
    if (movesRight) {
      if (rightAnchored) {
        // Right edge is CSS-anchored — dragging right handle means we want the LEFT side to stay,
        // but CSS right is fixed. So we just widen by moving the right anchor inward (shrink) or expand.
        // Actually in right-anchored mode, dragging right edge outward goes INTO the sidebar.
        // More intuitive: dx>0 = wider. We grow leftward by increasing width.
        const newW = Math.min(Math.max(startW + dx, CHAT_MIN_W), maxW);
        panel.style.width = newW + 'px';
      } else {
        // Floating or left-snapped: right edge expands rightward
        const newW = Math.min(Math.max(startW + dx, CHAT_MIN_W), maxW);
        panel.style.width = newW + 'px';
      }
    }

    if (movesLeft) {
      if (rightAnchored) {
        // Right-anchored: left edge resize simply changes width (right stays put)
        // dx < 0 = moved left = wider; dx > 0 = moved right = narrower
        const newW = Math.min(Math.max(startW - dx, CHAT_MIN_W), maxW);
        panel.style.width = newW + 'px';
      } else {
        // Floating/left-snap: left edge moves, right edge stays fixed
        const newW = Math.min(Math.max(startW - dx, CHAT_MIN_W), maxW);
        const widthDelta = newW - startW;
        panel.style.width = newW + 'px';
        panel.style.left = (startRect.left - widthDelta) + 'px';
      }
    }

    if (panel.classList.contains('chat-panel-secondary') && (movesLeft || movesRight)) {
      const preferredWidth = parseFloat(panel.style.width);
      if (Number.isFinite(preferredWidth)) {
        panel.dataset.hasCustomWidth = '1';
        panel.dataset.chatPreferredWidth = String(preferredWidth);
      }
    }

    // --- Vertical resize ---
    if (movesTop) {
      // Top edge: dragging up = dy < 0 = taller
      const newH = Math.min(Math.max(startH - dy, CHAT_MIN_H), maxH);
      const heightDelta = newH - startH;
      panel.style.height = newH + 'px';
      // Adjust top position: for secondary panels (position:fixed with explicit top)
      // and for floating/snapped primary panels
      if (panel.classList.contains('chat-panel-secondary') ||
          panel.classList.contains('floating') || panel.classList.contains('snap-left') || panel.classList.contains('snap-right')) {
        panel.style.top = (startRect.top - heightDelta) + 'px';
      }
      // Mark secondary panels as having custom height so tiling doesn't override
      if (panel.classList.contains('chat-panel-secondary')) {
        panel.dataset.hasCustomHeight = '1';
      }
    }

    if (movesBottom) {
      // Bottom edge: dragging down = dy > 0.
      if (panel.classList.contains('chat-panel-secondary')) {
        // Secondary panels: bottom edge can grow downward (they have explicit positioning)
        const newH = Math.min(Math.max(startH + dy, CHAT_MIN_H), maxH);
        panel.style.height = newH + 'px';
        panel.dataset.hasCustomHeight = '1';
      } else if (panel.classList.contains('floating')) {
        const newH = Math.min(Math.max(startH + dy, CHAT_MIN_H), maxH);
        panel.style.height = newH + 'px';
      }
    }
  }

  function _chatResizeStart(panel, handleEl, e) {
    const dir = _getHandleDir(handleEl);
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    // Activate this panel so it gets highest z-index (prevents overlapping panels from blocking)
    const chatSlot = panel.dataset.chatSlot || '';
    if (chatSlot.startsWith('secondary-')) {
      const slotNum = chatSlot.replace('secondary-', '');
      if (typeof setActiveSecondarySlot === 'function') setActiveSecondarySlot(slotNum);
    }
    const rect = panel.getBoundingClientRect();
    const slotId = chatSlot || 'primary';
    _resizeStates[slotId] = {
      active: true,
      panel,
      handleEl,
      dir,
      rightAnchored: _isRightAnchored(panel),
      startX: e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX,
      startY: e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY,
      startW: rect.width,
      startH: rect.height,
      maxW: Math.floor(window.innerWidth * CHAT_MAX_W_RATIO),
      maxH: Math.floor(window.innerHeight * CHAT_MAX_H_RATIO),
      startRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    };
    panel.style.transition = 'none';
    handleEl.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    // Lock cursor to resize direction for the entire drag (prevents cursor flicker
    // when mouse moves off the narrow handle zone)
    const cursorMap = {
      left: 'ew-resize', right: 'ew-resize',
      top: 'ns-resize', bottom: 'ns-resize',
      topLeft: 'nw-resize', topRight: 'ne-resize',
      bottomLeft: 'sw-resize', bottomRight: 'se-resize',
    };
    document.body.style.cursor = cursorMap[dir] || 'default';
  }

  function _flushChatResizeMove() {
    _resizeMoveFrame = 0;
    if (!_resizePointer) return;
    let resizedPrimary = false;
    for (const slotId in _resizeStates) {
      const rs = _resizeStates[slotId];
      if (!rs || !rs.active) continue;
      const dx = _resizePointer.clientX - rs.startX;
      const dy = _resizePointer.clientY - rs.startY;
      _applyResizeDelta(rs.panel, rs, dx, dy);
      if (rs.panel === chatPanel) resizedPrimary = true;
    }
    if (resizedPrimary) {
      _tileSecondaryPanels();
      _positionExteriorTabs();
    }
  }

  function _chatResizeMove(e) {
    const resizing = Object.values(_resizeStates).some((rs) => rs?.active);
    if (!resizing) return;
    const point = e.type.startsWith('touch') ? e.touches[0] : e;
    if (!point) return;
    _resizePointer = { clientX: point.clientX, clientY: point.clientY };
    if (e.cancelable) e.preventDefault();
    if (!_resizeMoveFrame) _resizeMoveFrame = requestAnimationFrame(_flushChatResizeMove);
  }

  function _chatResizeEnd() {
    if (_resizeMoveFrame) {
      cancelAnimationFrame(_resizeMoveFrame);
      _flushChatResizeMove();
    }
    _resizePointer = null;
    let resizedPanels = [];
    for (const slotId in _resizeStates) {
      const rs = _resizeStates[slotId];
      if (!rs || !rs.active) continue;
      rs.active = false;
      rs.handleEl.classList.remove('dragging');
      rs.panel.style.transition = '';
      resizedPanels.push(rs.panel);
      // Scroll chat to bottom after resize
      const w = chatWindowsByRoot.get(rs.panel);
      if (w) w.scrollBottom();
    }
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    document.body.style.cursor = '';
    // Apply the final tile synchronously so overlap detection sees the final
    // geometry instead of the pre-tile frame.
    _tileSecondaryPanelsNow();
    _positionExteriorTabs();
    resizedPanels.forEach(p => _resolveOverlaps(p));
  }

  // Bind resize events for PRIMARY panel
  _primaryHandleEls.forEach(handle => {
    handle.addEventListener('mousedown', (e) => _chatResizeStart(chatPanel, handle, e));
    handle.addEventListener('touchstart', (e) => _chatResizeStart(chatPanel, handle, e), { passive: false });
  });

  // Bind resize events for SECONDARY panels
  [1, 2, 3].forEach((slotNum) => {
    const slotKey = String(slotNum);
    const panel = secondaryChatPanels[slotKey];
    if (!panel) return;
    const handles = panel.querySelectorAll('.chat-resize-handle');
    handles.forEach(handle => {
      handle.addEventListener('mousedown', (e) => _chatResizeStart(panel, handle, e));
      handle.addEventListener('touchstart', (e) => _chatResizeStart(panel, handle, e), { passive: false });
    });
  });

  // Global move/end listeners (shared for all panels)
  document.addEventListener('mousemove', _chatResizeMove);
  document.addEventListener('touchmove', _chatResizeMove, { passive: false });
  document.addEventListener('mouseup', _chatResizeEnd);
  document.addEventListener('touchend', _chatResizeEnd);
  document.addEventListener('touchcancel', _chatResizeEnd);

  // ─── OVERLAP PREVENTION SYSTEM ───
  // After any move/resize/snap, push overlapping chat windows apart.
  // Uses getBoundingClientRect() for detection (always accurate for visual position)
  // and converts pushed panels to floating with explicit left/top positioning.

  const OVERLAP_PAD = 8; // minimum gap (px) between windows

  /** Get all open, visible chat panels (primary + secondaries) */
  function _getAllOpenChatPanels() {
    const panels = [];
    if (chatPanel.classList.contains('open')) panels.push(chatPanel);
    [1, 2, 3].forEach((slotNum) => {
      const p = secondaryChatPanels[String(slotNum)];
      if (p && p.classList.contains('open')) panels.push(p);
    });
    return panels;
  }

  /** Keep explicitly positioned chat windows reachable after a resize or
   * orientation change. Docked primary chat is positioned by the stack CSS
   * variable; floating and secondary windows need their inline coordinates
   * clamped to the newly usable viewport. */
  function _clampOpenChatPanelsToViewport() {
    if (window.matchMedia('(max-width: 900px)').matches) return;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const usableRight = Math.max(0, viewW - chatRightInset());

    _getAllOpenChatPanels().forEach((panel) => {
      if (panel.classList.contains('snap-left') || panel.classList.contains('snap-right')) return;
      if (panel === chatPanel && !panel.classList.contains('floating')) return;

      const rect = _getPanelRect(panel);
      const width = Math.min(rect.width, Math.max(220, usableRight));
      const height = Math.min(rect.height, Math.max(250, viewH));
      const maxLeft = Math.max(0, usableRight - width);
      const maxTop = Math.max(0, viewH - height);
      const left = Math.max(0, Math.min(rect.left, maxLeft));
      const top = Math.max(0, Math.min(rect.top, maxTop));

      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      if (width !== rect.width) panel.style.width = width + 'px';
      if (height !== rect.height) panel.style.height = height + 'px';
    });
  }

  /**
   * Read a panel's position. For floating panels with explicit inline styles,
   * reads from style.left/top (avoids stale CSS-transform issues). Otherwise
   * falls back to getBoundingClientRect (reliable for stacked/docked panels).
   */
  function _getPanelRect(panel) {
    // Floating panels: trust inline styles as source of truth
    if (panel.classList.contains('floating')) {
      const l = parseFloat(panel.style.left);
      const t = parseFloat(panel.style.top);
      if (!isNaN(l) && !isNaN(t)) {
        const w = parseFloat(panel.style.width) || panel.offsetWidth || 300;
        const h = parseFloat(panel.style.height) || panel.offsetHeight || 500;
        return { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h };
      }
    }
    // Docked/stacked panels: getBoundingClientRect reflects transforms correctly
    const r = panel.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  /** Check if two rects overlap (accounting for minimum gap) */
  function _rectsOverlap(a, b, pad) {
    return !(a.right + pad <= b.left || b.right + pad <= a.left ||
             a.bottom + pad <= b.top || b.bottom + pad <= a.top);
  }

  /**
   * Convert a panel from stacked/docked layout to floating so we can
   * reposition it freely. Captures getBoundingClientRect BEFORE adding
   * the floating class, then applies all styles in one cssText batch
   * to avoid layout thrash.
   */
  function _convertToFloating(panel) {
    // Already floating — just make sure transform is killed
    if (panel.classList.contains('floating') || panel.classList.contains('snap-left') || panel.classList.contains('snap-right')) {
      panel.style.setProperty('transform', 'none', 'important');
      return;
    }
    // Capture current visual position (getBoundingClientRect includes CSS transforms)
    const rect = panel.getBoundingClientRect();
    // Apply floating class + all position props in one batch
    panel.classList.add('floating');
    panel.style.cssText = 'transform: none !important; left: ' + rect.left + 'px; top: ' + rect.top + 'px; right: auto; bottom: auto; width: ' + rect.width + 'px; height: ' + rect.height + 'px;';
  }

  /**
   * After a panel is moved/resized/snapped, detect and resolve overlaps
   * with all other open chat windows. The moved panel stays put;
   * overlapping neighbors get pushed out of the way.
   *
   * Algorithm: multi-pass pairwise resolution with viewport clamping.
   * On each pass, every overlapping pair is resolved by pushing the
   * non-mover in the shortest-escape direction. If a horizontal push
   * would send the panel off-screen, a vertical push is tried instead.
   * Up to 8 passes handle cascading shifts.
   */
  function _resolveOverlaps(movedPanel) {
    const allPanels = _getAllOpenChatPanels();
    if (allPanels.length < 2) return;

    // The normal tiled layout is already collision-free. Avoid converting
    // every other panel to floating unless a collision actually exists.
    let hasOverlap = false;
    for (let i = 0; i < allPanels.length && !hasOverlap; i++) {
      const a = _getPanelRect(allPanels[i]);
      for (let j = i + 1; j < allPanels.length; j++) {
        if (_rectsOverlap(a, _getPanelRect(allPanels[j]), OVERLAP_PAD)) {
          hasOverlap = true;
          break;
        }
      }
    }
    if (!hasOverlap) return;

    // First, convert any non-floating panels to floating so we can
    // position them via style.left/top. Do this BEFORE reading rects
    // to avoid mid-loop transform issues.
    allPanels.forEach(p => {
      if (p !== movedPanel) _convertToFloating(p);
    });

    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    const usableRight = viewW - chatRightInset();
    const minVisible = 100;
    const maxPasses = 8;

    // Build mutable position map: panel → {left, top, width, height}
    // For the moved panel, use getBoundingClientRect (it may not be floating)
    const posMap = new Map();
    allPanels.forEach(p => {
      const r = _getPanelRect(p);
      posMap.set(p, { left: r.left, top: r.top, width: r.width, height: r.height });
    });

    function getRect(p) {
      const pos = posMap.get(p);
      return { left: pos.left, top: pos.top, right: pos.left + pos.width, bottom: pos.top + pos.height, width: pos.width, height: pos.height };
    }

    for (let pass = 0; pass < maxPasses; pass++) {
      let anyMoved = false;

      for (let i = 0; i < allPanels.length; i++) {
        for (let j = i + 1; j < allPanels.length; j++) {
          const pA = allPanels[i], pB = allPanels[j];
          const rA = getRect(pA), rB = getRect(pB);

          if (!_rectsOverlap(rA, rB, OVERLAP_PAD)) continue;

          // Decide who moves: never move the movedPanel
          let fixed, push, fR, pR;
          if (pA === movedPanel) { fixed = pA; push = pB; fR = rA; pR = rB; }
          else if (pB === movedPanel) { fixed = pB; push = pA; fR = rB; pR = rA; }
          else {
            // Neither is the moved panel — push whichever is further from mover
            const mR = getRect(movedPanel);
            const dA = Math.abs((rA.left + rA.width / 2) - (mR.left + mR.width / 2));
            const dB = Math.abs((rB.left + rB.width / 2) - (mR.left + mR.width / 2));
            if (dA >= dB) { fixed = pB; push = pA; fR = rB; pR = rA; }
            else { fixed = pA; push = pB; fR = rA; pR = rB; }
          }

          // Calculate shortest escape direction
          const overlapX = Math.min(fR.right, pR.right) - Math.max(fR.left, pR.left);
          const overlapY = Math.min(fR.bottom, pR.bottom) - Math.max(fR.top, pR.top);
          const fCX = (fR.left + fR.right) / 2, fCY = (fR.top + fR.bottom) / 2;
          const pCX = (pR.left + pR.right) / 2, pCY = (pR.top + pR.bottom) / 2;

          // Try up to 4 candidate positions (preferred direction, opposite, then other axis)
          // and pick the first that resolves the overlap while staying in viewport.
          const candidates = [];

          // Preferred axis first (shorter escape)
          if (overlapX <= overlapY) {
            // Horizontal preferred
            if (pCX >= fCX) {
              candidates.push({ l: fR.right + OVERLAP_PAD, t: pR.top });             // right
              candidates.push({ l: fR.left - pR.width - OVERLAP_PAD, t: pR.top });   // left
            } else {
              candidates.push({ l: fR.left - pR.width - OVERLAP_PAD, t: pR.top });   // left
              candidates.push({ l: fR.right + OVERLAP_PAD, t: pR.top });             // right
            }
            // Fallback: vertical
            candidates.push({ l: pR.left, t: fR.bottom + OVERLAP_PAD });             // down
            candidates.push({ l: pR.left, t: fR.top - pR.height - OVERLAP_PAD });    // up
          } else {
            // Vertical preferred
            if (pCY >= fCY) {
              candidates.push({ l: pR.left, t: fR.bottom + OVERLAP_PAD });           // down
              candidates.push({ l: pR.left, t: fR.top - pR.height - OVERLAP_PAD });  // up
            } else {
              candidates.push({ l: pR.left, t: fR.top - pR.height - OVERLAP_PAD });  // up
              candidates.push({ l: pR.left, t: fR.bottom + OVERLAP_PAD });           // down
            }
            // Fallback: horizontal
            candidates.push({ l: fR.right + OVERLAP_PAD, t: pR.top });               // right
            candidates.push({ l: fR.left - pR.width - OVERLAP_PAD, t: pR.top });     // left
          }

          // Evaluate each candidate: prefer one that doesn't overlap with ANY other panel
          let newLeft = pR.left, newTop = pR.top;
          let bestScore = -1;
          for (const c of candidates) {
            const cl = Math.max(0, Math.min(c.l, usableRight - minVisible));
            const ct = Math.max(0, Math.min(c.t, viewH - minVisible));
            const tr = { left: cl, top: ct, right: cl + pR.width, bottom: ct + pR.height };
            // Must not overlap the fixed panel
            if (_rectsOverlap(fR, tr, OVERLAP_PAD)) continue;
            // Count how many OTHER panels it would overlap (fewer = better)
            let collisions = 0;
            for (let k = 0; k < allPanels.length; k++) {
              if (allPanels[k] === push || allPanels[k] === fixed) continue;
              if (_rectsOverlap(getRect(allPanels[k]), tr, OVERLAP_PAD)) collisions++;
            }
            const score = 100 - collisions; // higher is better
            if (score > bestScore) {
              bestScore = score; newLeft = cl; newTop = ct;
              if (collisions === 0) break; // perfect placement found
            }
          }
          if (bestScore < 0) {
            // No candidate avoids the fixed panel — use first clamped as fallback
            newLeft = Math.max(0, Math.min(candidates[0].l, usableRight - minVisible));
            newTop = Math.max(0, Math.min(candidates[0].t, viewH - minVisible));
          }

          // Update the position map
          const pos = posMap.get(push);
          pos.left = newLeft;
          pos.top = newTop;
          anyMoved = true;
        }
      }
      if (!anyMoved) break;
    }

    // Apply final positions to DOM (skip the moved panel)
    allPanels.forEach(p => {
      if (p === movedPanel) return;
      const pos = posMap.get(p);
      p.style.left = pos.left + 'px';
      p.style.top = pos.top + 'px';
    });
  }

  // No-op stubs for backward compat (secondary panels no longer have independent move)
  function _secExitMoveMode() {}

  window._secExitMoveMode = _secExitMoveMode;
  window._resolveOverlaps = _resolveOverlaps;
  window._convertToFloating = _convertToFloating;
  window._getPanelRect = _getPanelRect;
})();

// ── Chat window header tools (v0.10 UI-14) ──
// A narrow window (under 480 px) folds its tool buttons (new window, side panel, new session, put
// away) into one ⋯ menu; the menu items press the real buttons, so every handler stays where it is.
// Width classes: chat-narrow (< 480), chat-wide (>= 640: the sessions list sits beside the messages;
// narrower windows show it as an overlay so the message column keeps its width).
(function chatHeaderTools(root) {
  'use strict';
  if (!root.document || root.VOChatTools) return;
  const doc = root.document;
  const TOOLS = '.chat-new-window, .hp-side-btn, .chat-new-session, .chat-put-away';
  let menuOpen = null;
  const ro = typeof root.ResizeObserver === 'function' ? new root.ResizeObserver((entries) => {
    for (const e of entries) sync(e.target, e.contentRect.width);
  }) : null;
  function sync(panel, width) {
    const w = width || panel.getBoundingClientRect().width;
    if (!w) return;
    panel.classList.toggle('chat-narrow', w < 480);
    panel.classList.toggle('chat-wide', w >= 640);
  }
  function observe(panel) {
    if (!panel || panel.__voChatTools) return;
    panel.__voChatTools = true;
    if (ro) ro.observe(panel); else sync(panel);
  }
  function closeMenu(focusButton) {
    if (!menuOpen) return;
    const { btn, menu } = menuOpen;
    menuOpen = null;
    menu.remove();
    btn.setAttribute('aria-expanded', 'false');
    if (focusButton) btn.focus();
  }
  function openMenu(btn) {
    const panel = btn.closest('.chat-panel');
    const header = btn.closest('.chat-header');
    if (!panel || !header) return;
    const tools = [...header.querySelectorAll(TOOLS)].filter((b) => !b.hidden && !b.disabled);
    const menu = doc.createElement('div');
    menu.className = 'chat-more-menu';
    menu.setAttribute('role', 'menu');
    for (const t of tools) {
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'chat-more-item';
      item.setAttribute('role', 'menuitem');
      const icon = t.querySelector('svg');
      if (icon) item.appendChild(icon.cloneNode(true));
      const label = doc.createElement('span');
      label.textContent = String(t.getAttribute('aria-label') || t.title || '').split(' (')[0];
      item.appendChild(label);
      item.addEventListener('click', () => { closeMenu(false); t.click(); });
      menu.appendChild(item);
    }
    if (!menu.children.length) return;
    const pr = panel.getBoundingClientRect(), br = btn.getBoundingClientRect();
    menu.style.top = Math.round(br.bottom - pr.top + 4) + 'px';
    menu.style.right = Math.max(6, Math.round(pr.right - br.right)) + 'px';
    panel.appendChild(menu);
    menuOpen = { btn, menu };
    btn.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus();
  }
  doc.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.chat-more-tools');
    if (btn) {
      e.preventDefault();
      const same = menuOpen && menuOpen.btn === btn;
      closeMenu(false);
      if (!same) openMenu(btn);
      return;
    }
    if (menuOpen && !menuOpen.menu.contains(e.target)) closeMenu(false);
  }, true);
  doc.addEventListener('keydown', (e) => {
    if (!menuOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...menuOpen.menu.querySelectorAll('button')];
      const i = items.indexOf(doc.activeElement);
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) { e.preventDefault(); next.focus(); }
    }
  }, true);
  root.VOChatTools = { observe, sync, closeMenu };
  const start = () => doc.querySelectorAll('.chat-panel').forEach(observe);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})(typeof globalThis !== 'undefined' ? globalThis : this);
