// The real app/chat.js on the real app/index.html in linkedom, with a stub copied window (window.voPL) that records
// what the office asks of it. Shared by tests/test_v12_chatroute.cjs and tests/test_unify_migrate.cjs (unify WP-D).
//   layer: true  = the layer mounted (voPL with the unify API: every chattable agent is a layer agent)
//          'dead' = the server runs the layer for OpenClaw (/gateway-info provider "layer") but voPL never mounts
//          false = VO_PROVIDER_LAYER=0 (no voPL, the office's own window)
//   layerAgents: keys the layer lists (default: every agent); lateAgents: { key: ms } listed only after ms;
//   copied: { count, shown } windows the copied manager restored before the office asked anything.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

const app = path.join(__dirname, '../../app');
const read = name => fs.readFileSync(path.join(app, name), 'utf8');
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (check()) return; await settle(15); }
  throw new Error(`timed out waiting for ${label}`);
}
const row = (key, name, providerKind, providerConnectionId, extra = {}) => ({
  key, agentId: key, statusKey: key, name, emoji: '🙂', branch: 'Team',
  sessionKey: providerKind === 'openclaw' ? `agent:${key}:main` : `${providerKind}:${key}`, providerKind,
  providerAgentId: key, providerConnectionId, apiAvailable: true, capabilities: { sessions: true }, ...extra,
});

function fixture({ layer = true, agents, storage = {}, layerAgents = null, lateAgents = {}, copied = { count: 0, shown: 0 }, search = '', phone = false } = {}) {
  const { document, window: dom } = parseHTML(read('index.html'));
  Object.defineProperty(dom.HTMLSelectElement.prototype, 'selectedOptions', { configurable: true, get() {
    return [...this.querySelectorAll('option')].filter(o => o.hasAttribute('selected'));
  } });
  const store = new Map(Object.entries(storage).map(([k, v]) => [k, JSON.stringify(v)]));
  const listeners = {};
  const sources = [], sockets = [], calls = [], toasts = [], fetched = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 0; sources.push(this); }
    addEventListener() {}
    close() { this.readyState = 2; }
  }
  FakeEventSource.CONNECTING = 0; FakeEventSource.OPEN = 1; FakeEventSource.CLOSED = 2;
  class FakeWebSocket { constructor(url) { this.url = url; sockets.push(this); } close() {} send() {} }
  const respond = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const fetch = async url => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    fetched.push(p);
    if (p === '/gateway-info') return respond(layer ? { transport: 'proxy', rpcUrl: '/api/openclaw/rpc', eventsUrl: '', provider: 'layer' } : { transport: 'proxy', rpcUrl: '/api/openclaw/rpc', eventsUrl: '/api/openclaw/events' });
    if (p === '/agents-list') return respond({ agents });
    if (p === '/api/openclaw/rpc') return respond({ ok: true, payload: { messages: [], session: {} } });
    return respond({ ok: true, messages: [], sessions: [] });
  };
  // the copied manager, as far as the office sees it: windows (count, shown), the agents it lists
  const listedKeys = new Set(layerAgents || agents.map(a => a.key));
  const born = Date.now();
  const listed = key => {
    const k = String(key);
    const a = agents.find(x => [x.key, x.agentId, x.statusKey].includes(k));
    if (!a || !listedKeys.has(a.key)) return null;
    return lateAgents[a.key] && Date.now() - born < lateAgents[a.key] ? null : a;
  };
  const wins = { count: copied.count || 0, shown: copied.shown || 0 };
  const pl = {
    ready: true,
    isLayerAgent: id => !!listed(id),
    layerIdFor: id => { const a = listed(id); return a ? agents.indexOf(a) + 1 : null; },
    agents: () => agents.filter(a => listed(a.key)).map(a => ({ id: agents.indexOf(a) + 1, key: `prov-${a.key}`, officeId: a.key, name: a.name, level: a.noChat ? null : 'chat' })),
    async open(id, opts = {}) {
      calls.push(['open', String(id), opts.session ?? null, !!opts.newWindow]);
      if (opts.focus || opts.panel) calls.push(['point', String(id), opts.focus || null, opts.panel || null]);
      if (!listed(id)) return null;
      if (opts.newWindow || !wins.count) { if (wins.count >= 4) return null; wins.count += 1; }
      wins.shown = phone ? 1 : Math.min(wins.count, wins.shown + 1);
      return `pl-${id}`;
    },
    openLayer: async (id, opts = {}) => { calls.push(['openLayer', id, !!opts.newWindow]); wins.count += 1; wins.shown += 1; return true; },
    showChats: () => { calls.push(['showChats']); if (!wins.count) wins.count = 1; wins.shown = phone ? 1 : wins.count; return true; },
    toggleChats: () => {
      calls.push(['toggleChats']);
      if (wins.shown) wins.shown = 0; else { if (!wins.count) wins.count = 1; wins.shown = phone ? 1 : wins.count; }
      return true;
    },
    chatsShown: () => wins.shown > 0,
    openRecent: opts => { calls.push(['openRecent', !!opts?.newWindow]); return true; },
    newWindow: () => { calls.push(['newWindow']); return true; },
    windows: () => wins.count,
    unread: () => 0,
    lastUsed: () => null,
  };
  const win = {
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(evt) { (listeners[evt.type] || []).forEach(fn => fn(evt)); return true; },
    matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
    location: { search, origin: 'http://fixture.invalid', hostname: 'fixture.invalid', protocol: 'http:', href: 'http://fixture.invalid/' + search },
    innerWidth: phone ? 412 : 1600, innerHeight: phone ? 860 : 900,
    confirm: () => true,
    VOUI: { toast: text => toasts.push(String(text)) },
  };
  // (as vo-provider-layer.js leaves it: voPLReady resolves the layer, or null when it is off or could not start)
  if (layer === true) win.voPLReady = Promise.resolve(pl).then(x => { win.voPL = x; return x; });
  else if (layer === 'dead') win.voPLReady = Promise.resolve(null);
  const context = vm.createContext({
    document, window: win, globalThis: null, console, URL, URLSearchParams, AbortController, TextDecoder,
    CustomEvent: dom.CustomEvent, Event: dom.Event, Blob, performance, navigator: {},
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: id => clearTimeout(id),
    getComputedStyle: () => ({ fontSize: '14px', getPropertyValue: () => '' }), CSS: { escape: v => String(v).replace(/["\\]/g, '\\$&') },
    EventSource: FakeEventSource, WebSocket: FakeWebSocket, fetch, confirm: () => true,
  });
  context.globalThis = context;
  win.document = document;
  const markedLibrary = require('../../app/marked.min.js');
  context.marked = { ...markedLibrary, parse: markedLibrary.parse };
  for (const file of ['chat-markdown.js', 'chat-events.js', 'chat-caps.js', 'chat-universal.js', 'chat-cards.js', 'chat-queue.js', 'chat-pickers.js', 'chat-media.js', 'chat-sidepanel.js', 'chat-windows.js', 'session-progress.js', 'office-chat-references.js']) {
    vm.runInContext(read(file), context, { filename: file });
  }
  // (the hook goes before the first /gateway-info answer's handler)
  const source = read('chat.js').replace(/^ {2}(gatewayInfoAtStart|loadGatewayInfo\(\))\.then\(\(\) => \{/m,
    m => `  globalThis.__chatInternals = { primaryWindow, chatWindows, windowManager };\n${m}`);
  assert(source.includes('__chatInternals'), 'bootstrap hook marker not found in chat.js');
  vm.runInContext(source, context, { filename: 'chat.js' });
  const internals = context.__chatInternals;
  const bySlot = slot => internals.chatWindows.find(w => w.slotId === slot);
  const shown = () => [...internals.chatWindows].filter(w => w.root.classList.contains('open')).map(w => [w.slotId, w.selectedAgentKey]);
  const legacy = () => [...sources.map(s => s.url), ...sockets.map(s => s.url)];
  const saved = key => JSON.parse(store.get(key) || 'null');
  const choose = (w, value) => {
    for (const o of w.agentSelect.querySelectorAll('option')) { if (o.value === value) o.setAttribute('selected', ''); else o.removeAttribute('selected'); }
    w.agentSelect.dispatchEvent(new dom.Event('change'));
  };
  const opens = () => calls.filter(c => c[0] === 'open').map(c => c.slice(1));
  return { win, dom, internals, bySlot, shown, legacy, saved, choose, calls, opens, toasts, store, fetched, pl, wins };
}

module.exports = { fixture, row, settle, until };
