// My Virtual Office. Copyright (c) 2026 My Virtual Office. Licensed under the GNU AGPL-3.0 (see LICENSE).
// The office's mount of the copied OpenClaw + Hermes chat window and Agent Providers window (VO_PROVIDER_LAYER=1).
// Loaded by vo-provider-layer.js (a classic script) only when the office runs the layer. It gives the copied modules the
// page they expect (toast, key hooks, the agents, the socket, the passcode confirm), loads their styles, and exposes
//   window.voPL = { open(officeId, opts), isLayerAgent(officeId), openProviders(kind|connectionId), mountProviders(host,
//                   {kind}), windows(), layerIdFor(officeId), officeIdFor(layerId), ready, agents(), mountScreen(el, officeId),
//                   screenKind(officeId), openRecent(opts), newWindow(), lastUsed(), unread(), showChats(), toggleChats() }
// to the office's classic scripts: chat.js asks isLayerAgent() before it opens its own window, so a desk click, the
// agent menu, the roster and Office Life all open the copied window. (unify) Every agent the layer lists is one of its
// agents: OpenClaw and Hermes, and the office's own providers (Codex, Claude Code, OpenCode, Antigravity, a Hermes API
// server, extensions) as the layer's kind `office`, keyed by the office agent's id. One window hosts any of them and its
// agent picker switches in place; "+" and a picker row's ⧉ open another. The Chat button reopens the agent and chat this
// browser used last (vo.chat.last). The windows fire the office's hooks (vo:chat-opened-agent, vo:chat-windows,
// vo:chat-unread, vo:agent-tool-preview). The office's own window remains only with the layer off (VO_PROVIDER_LAYER=0)
// or without Node.js; both window managers share the office's window stack and the limit of four.
import { S, bus, setAgents } from './core/state.js';
import { auth } from './core/auth.js';
import { Net, getJSON } from './core/net.js';
import { watchIcons } from './core/icons.js';
import * as chat from './ui/chat.js';
import * as providers from './ui/agent-providers.js';
import { mountProviderScreen } from './ui/provider-screen.js';
import { mountProviderBrowser } from './ui/provider-browser.js';

const KINDS = new Set(['openclaw', 'hermes']);
const PLACE_KEY = 'mvw.chat.place';   // (chat-window.js GEO_KEY)
const STYLES = ['/pl/css/chat.css', '/pl/css/agent-providers.css', '/pl/css/pl-office.css', '/pl/css/pl-voice.css'];   // (pl-voice: uV-voice)
const office = { rows: [], byNeedle: new Map() };   // the office roster (/agents-list): who sits at which desk
let mounted = null;

/** Loads the copied window's styles after the office's own (so the office layer in pl-office.css wins). */
function styles() {
  return Promise.all(STYLES.map(href => new Promise(done => {
    if (document.querySelector(`link[data-pl-css="${href}"]`)) return done();
    const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${href}?v=20261113-unify` });
    l.dataset.plCss = href;
    l.onload = l.onerror = () => done();
    document.head.appendChild(l);
  })));
}

/** The copied window first opens at the office chat window's size and height above the dock (style.css .chat-panel,
 *  ui-modern.css: --chat-stack-width x 500, bottom --vo-dock-h): its first place (chat-window.js keeps it in
 *  mvw.chat.place) is set only when none is kept yet, so a size the person chose stays theirs. */
function firstPlace() {
  try {
    if (localStorage.getItem(PLACE_KEY) !== null) return;
    const panel = document.getElementById('chat-panel'), rs = getComputedStyle(document.documentElement);
    const w = Math.round(panel?.offsetWidth || parseFloat(rs.getPropertyValue('--chat-stack-width')) || 380);
    const h = Math.round(panel?.offsetHeight || 500);
    // (room() leaves GAP under it; the office window sits on the dock's top edge)
    const b = Math.max(0, Math.round((parseFloat(rs.getPropertyValue('--vo-dock-h')) || 0) - 10));
    localStorage.setItem(PLACE_KEY, JSON.stringify({ w, h, r: 0, b }));
  } catch { /* private mode: the copied window's own first size */ }
}

/** OpenClaw's chat history goes cold on the gateway after 20 to 40 s unread (chat.history 0.3 to 0.4 s, under 10 ms warm;
 *  models and commands do not warm it, one history read of any chat warms them all), and the copied window shows its
 *  composer once the chat's history is in. So the office reads the latest OpenClaw chat of each gateway when a chat
 *  may be next: after the office loads, when an agent's menu opens at a desk, when the pointer moves (the way to a desk,
 *  a name or a button), on a press or key, and when the tab comes back; at most once per WARM_MS per gateway, never in
 *  a hidden tab, nothing while nobody is there. */
const WARM_MS = 15000;
const warmedAt = new Map();   // (OpenClaw connection id -> when its history was last read)
let warming = false;
async function warmHistory() {
  if (warming || document.hidden || !auth.can('chat.use')) return;   // (no chats to open: nothing asked, no 403 in the console)
  const now = Date.now();
  const due = [...new Set((S.agentList || []).filter(a => kindOf(a) === 'openclaw').map(a => a.provider?.connectionId))]
    .filter(c => c != null && now - (warmedAt.get(c) || 0) >= WARM_MS);
  if (!due.length) return;
  warming = true;
  try {
    due.forEach(c => warmedAt.set(c, now));
    const recent = (await getJSON('/api/chat/recent')).sessions || [];
    const connOf = new Map((S.agentList || []).map(a => [a.id, kindOf(a) === 'openclaw' ? a.provider?.connectionId : null]));
    await Promise.all(due.map(c => {
      const s = recent.find(x => connOf.get(x.agentId) === c && x.key && x.key !== '@new');   // (@new: not on the gateway yet, sessions.js LAZY_KEY)
      return s ? getJSON(`/api/providers/history?agent=${s.agentId}&session=${s.id}`).catch(() => null) : null;
    }));
  } catch { /* the window reads it itself */ } finally { warming = false; }
}
let warmTry = 0;
const nudge = () => { const now = Date.now(); if (now - warmTry < 1000) return; warmTry = now; warmHistory(); };   // (pointermove: cheap)
function warmWhenNear() {
  const soon = () => { if (typeof requestIdleCallback === 'function') requestIdleCallback(() => warmHistory(), { timeout: 800 }); else setTimeout(warmHistory, 200); };
  soon();
  for (const ev of ['pointermove', 'pointerdown', 'keydown']) document.addEventListener(ev, nudge, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) warmHistory(); });
  // (the desk's agent menu, game.js #vo-agent-menu, made on its first opening: Chat is one press away)
  const shown = new MutationObserver(() => { const m = document.getElementById('vo-agent-menu'); if (m && !m.hidden) warmHistory(); });
  const watchMenu = m => { shown.observe(m, { attributes: true, attributeFilter: ['hidden'] }); if (!m.hidden) warmHistory(); };
  const menu = document.getElementById('vo-agent-menu');
  if (menu) watchMenu(menu);
  else {
    const made = new MutationObserver(() => { const m = document.getElementById('vo-agent-menu'); if (m) { made.disconnect(); watchMenu(m); } });
    made.observe(document.body, { childList: true });
  }
}

const kindOf = a => String(a?.provider?.kind || '').toLowerCase();
const kindOfRow = r => String(r?.providerKind || '').toLowerCase();
/** A layer agent's id on its provider (key `prov-<connection>-<native>`). */
const nativeOf = a => {
  const pre = `prov-${a?.provider?.connectionId}-`;
  return a && typeof a.key === 'string' && a.key.startsWith(pre) ? a.key.slice(pre.length) : '';
};

/** The office roster: each row by every name the office calls it (key, agent id, aliases). */
const rowNames = r => [r.id, r.key, r.agentId, r.statusKey, ...(Array.isArray(r.selectionAliases) ? r.selectionAliases : [])].filter(n => n !== undefined && n !== null && n !== '').map(String);
async function loadOffice() {
  let rows = [];
  try { const d = await getJSON('/agents-list'); rows = Array.isArray(d?.agents) ? d.agents : []; } catch { /* keep the last */ return; }
  office.rows = rows;
  office.byNeedle = new Map();
  for (const r of rows) for (const n of rowNames(r)) if (!office.byNeedle.has(n)) office.byNeedle.set(n, r);
}

/** The layer agent the office's agent `needle` is (null: not an OpenClaw/Hermes agent of the layer). */
function layerAgent(needle) {
  const id = String(needle ?? '').trim();
  if (!id) return null;
  const list = S.agentList || [];
  // 1. the layer's own office id map (when the server sends it)
  const byOffice = n => list.find(x => x.officeId !== undefined && x.officeId !== null && String(x.officeId) === n) || null;
  let a = byOffice(id);
  if (a) return a;
  // 2. (unify) any other name the office calls that agent: an office provider's agent (Codex, Claude Code, OpenCode,
  //    Antigravity, a Hermes API server, an extension: the layer's kind `office`) is keyed by the office agent's id
  const row = office.byNeedle.get(id);
  if (row) for (const n of rowNames(row)) if ((a = byOffice(n))) return a;
  // 3. the office row's provider and its id there (never a Hermes row of VO's own path: a Hermes API-server agent,
  //    whose connection is not the layer's pl-<id>, is the office's own agent even when a layer profile has the same
  //    name; it is a layer agent only as kind `office`, found above)
  if (row && kindOfRow(row) === 'hermes' && !String(row.providerConnectionId || '').startsWith('pl-')) return null;
  if (row && KINDS.has(kindOfRow(row))) {
    const kind = String(row.providerKind).toLowerCase(), native = String(row.providerAgentId || row.agentId || '');
    const same = list.filter(x => kindOf(x) === kind && nativeOf(x) === native);
    a = same.find(x => String(x.officeId || '') === id) || same[0];
    if (a) return a;
  }
  // 4. OpenClaw's office ids are the gateway's own ids (main, ops, ...)
  return list.find(x => kindOf(x) === 'openclaw' && nativeOf(x) === id) || null;
}

/** (unify) The agent and chat this browser used last (DESIGN 3.1: vo.chat.last = { officeId, session, at }, plus
 *  `agent`, the layer id, for an agent with no office id): saved on every pick and send in a copied window; the Chat
 *  button reopens it while this person may still chat with that agent. `session`: the layer's chat id, or (written by
 *  the office's migration) the provider's session key, which the window looks up in the agent's chats. */
const LAST_KEY = 'vo.chat.last';
function saveLast(layerId, session) {
  const a = (S.agentList || []).find(x => x.id === Number(layerId));
  if (!a) return;
  const last = { officeId: officeIdFor(a.id), agent: a.id, session: session ?? null, at: Date.now() };
  try { localStorage.setItem(LAST_KEY, JSON.stringify(last)); } catch { /* private mode */ }
}
function lastUsed() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const list = S.agentList || [];
  const a = (v.officeId !== undefined && v.officeId !== null && v.officeId !== '' ? layerAgent(v.officeId) : null)
    || (Number.isInteger(v.agent) ? list.find(x => x.id === v.agent) : null);
  if (!a || !a.level) return null;   // (gone, or no longer shared with this person: the window's own choice)
  const s = v.session;
  return { agent: a.id, session: Number.isInteger(s) || (typeof s === 'string' && s) ? s : null };
}

/** (unify) The office hooks the office window fed, now from the copied windows (DESIGN 3.2): the agent's chat opened
 *  (Office Life reads its envelopes), the windows and their unread answers (the dock's badge and chat-open state), a tool
 *  step of a chat a window shows (the agent's live preview on its PC). */
const fire = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* old browser */ } };
function opened(layerId, session) {
  saveLast(layerId, session);
  const oid = officeIdFor(layerId);
  if (oid) fire('vo:chat-opened-agent', { agentId: oid, layerId: Number(layerId), session: session ?? null, slot: `pl-${layerId}` });
}
let lastWins = '', lastUnread = -1;
function windowsChanged({ count = 0, shown = 0, unread = 0 } = {}) {
  const w = `${count}|${shown}`;
  if (w !== lastWins) { lastWins = w; fire('vo:chat-windows', { count, shown, source: 'pl' }); }
  // (the badge shows every chat window's: the office's own too, while it has any)
  let own = 0; try { own = Number(window.VirtualOfficeChat?.unreadCount?.()) || 0; } catch { /* none */ }
  const total = unread + own;
  if (total !== lastUnread) { lastUnread = total; fire('vo:chat-unread', { count: total, source: 'pl' }); }
}
const PHASE = { 'tool.start': 'start', 'tool.update': 'update', 'tool.end': 'result' };
const steps = new Map();   // (run:toolId -> the step's name and input from its start: its update and end often carry neither)
function toolPreview(app, m) {
  const e = m?.event, phase = e && PHASE[e.type];
  if (!phase || !app.chat?.holder?.(m.agent, m.session)) return;   // (only a chat a window shows, as the office window did)
  const oid = officeIdFor(m.agent);
  if (!oid) return;
  const k = `${m.run}:${e.toolId || ''}`, was = steps.get(k) || {};
  // (the bus carries a step's input as text, its whole arguments as JSON text in `raw`: they are read back, as the
  // office window gave them; a later update replaces an input that was still streaming when the step started)
  const input = e.raw || e.input || was.input;
  if (phase === 'start') { steps.set(k, { name: e.name, input }); if (steps.size > 200) steps.delete(steps.keys().next().value); }
  if (phase === 'update' && (e.raw || e.input) && steps.has(k)) steps.set(k, { ...was, input });
  if (phase === 'result') steps.delete(k);
  const failed = phase === 'result' && e.ok === false;
  let args = input ?? {};
  if (typeof args === 'string' && /^\s*[{[]/.test(args)) { try { args = JSON.parse(args); } catch { /* the text as it is */ } }
  fire('vo:agent-tool-preview', { agentId: oid, sessionKey: String(m.session ?? ''), slotId: `pl-${m.agent}`, runId: m.run || '', phase,
    tool: { id: e.toolId || '', name: e.name || was.name || 'tool', arguments: args, result: phase === 'result' ? (e.text || '') : '',
      status: phase === 'result' ? (failed ? 'error' : 'completed') : 'running', error: failed ? (e.error || e.text || 'failed') : '' } });
}

/** The office id of layer agent `id`: its desk's agent, else its id on the provider. */
function officeIdFor(layerId) {
  const a = (S.agentList || []).find(x => x.id === Number(layerId));
  if (!a) return null;
  if (a.officeId) return String(a.officeId);
  const kind = kindOf(a), native = nativeOf(a);
  const row = office.rows.find(r => String(r.providerKind || '').toLowerCase() === kind && String(r.providerAgentId || r.agentId || '') === native);
  return row ? String(row.statusKey || row.key || row.agentId) : (kind === 'openclaw' ? native : null);
}

/** The roster for the chat window: the layer's agents, each with the office desk it sits at (S.people: "Find" pans
 *  the office to it). */
async function loadAgents() {
  let list = [];
  try { list = (await getJSON('/api/pl/agents')).agents || []; } catch { return; }
  S.agentList = list;   // (officeIdFor reads it; setAgents tells the windows once the desks are known)
  S.people = [];
  for (const a of list) {
    const oid = officeIdFor(a.id);
    a.i = -1;
    if (oid !== null) { a.i = S.people.length; S.people.push({ n: a.name, v: true, ag: a.key, office: oid }); }
  }
  setAgents(list);
}

/** The office passcode again (a change that needs it within 10 minutes): asks, confirms, true when it is right. */
async function confirmPassword(reason) {
  const ask = window.VOUI?.prompt;
  for (let i = 0; i < 3; i++) {
    const code = ask ? await ask({ title: 'Confirm the office passcode', body: reason || 'This change needs your office passcode.', label: 'Office passcode', type: 'password', okLabel: 'Confirm' })
      : window.prompt('Office passcode');
    if (code === null || code === undefined) return false;
    const r = await fetch('/api/access/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: String(code) }) });
    if (r.ok) { await auth.refresh(); return true; }
    toast('That passcode is not right.', 'bad');
  }
  return false;
}

function toast(text, tone = '', ms = 0) {
  const kind = tone === 'bad' ? 'error' : tone === 'good' ? 'success' : 'info';
  if (window.VOUI?.toast) window.VOUI.toast(String(text || ''), ms ? { kind, duration: ms } : { kind });
  else console.info('[chat]', text);
}

/** The page's key hooks (the copied chat manager adds its own): never while typing (Esc included: the composer's own Esc
 *  stops a turn or closes a menu first), never with Ctrl/Cmd/Alt; as My Virtual World's page dispatches them. */
function keyHooks(app) {
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || !app.hooks.key.length) return;
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
    if (typing) return;
    for (const fn of app.hooks.key) {
      let done = false;
      try { done = fn(e) === true; } catch (err) { console.warn('[chat] key hook', err); }
      if (done) { if (e.key === 'Escape') e.preventDefault(); e.stopImmediatePropagation(); return; }
    }
  }, true);
}

/** The copied windows' "put away" buttons: a second office chat window rail (VO's .chat-window-rail rules place it,
 *  desktop and phone), lifted above the office's own rail by that rail's height. */
function rail() {
  let box = document.getElementById('floatbtns');
  if (!box) {
    box = document.createElement('div');
    box.id = 'floatbtns';
    box.className = 'chat-window-rail pl-rail';
    box.innerHTML = '<div class="fb-chat"></div>';
    document.body.appendChild(box);
  }
  const vo = document.getElementById('chat-window-rail');
  const place = () => {
    const shown = vo && !vo.hidden && !vo.classList.contains('is-strip') && vo.getBoundingClientRect().height > 0;
    box.style.setProperty('--pl-rail-lift', shown ? `${Math.round(vo.getBoundingClientRect().height) + 6}px` : '0px');
  };
  if (vo && window.ResizeObserver) new ResizeObserver(place).observe(vo);
  if (vo && window.MutationObserver) new MutationObserver(place).observe(vo, { attributes: true, attributeFilter: ['hidden', 'class'] });
  place();
  return box;
}

/** Phones and narrow windows (900 px, the office's one-window width): the shown copied chat is the office's bottom sheet
 *  (pl-office.css 5). Its grip drags it between a small height and just under the top bar, a tap (Enter/Space) switches
 *  half / full, arrows step it; the height is kept on this device as a share of the room between the bars, under the
 *  office chat sheet's own key, so both feel the same. The map controls ride above it (--vo-chat-sheet-h). */
const SHEET_KEY = 'vo-chat-sheet-share', SHEET_MIN = 200;
function sheet() {
  const root = document.documentElement;
  let share = null, drag = null, applied = '';
  try { const v = parseFloat(localStorage.getItem(SHEET_KEY)); if (v > 0 && v <= 1) share = v; } catch { /* private mode */ }
  const narrow = () => innerWidth <= 900;
  const shown = () => document.querySelector('.chat-layer .chat-back.modal-back:not(.min) .chatwin');
  const officeSheet = () => !!document.querySelector('.chat-panel.open');
  function room() {
    const H = innerHeight, vv = window.visualViewport;
    const visTop = vv ? vv.offsetTop : 0, visBottom = vv ? vv.offsetTop + vv.height : H;
    const kb = Math.max(0, Math.round(H - visBottom)), keyboard = kb > 80 && (!vv || Math.abs((vv.scale || 1) - 1) < 0.01);
    const barH = document.querySelector('.vo-actionbar')?.getBoundingClientRect().height || 0;
    const tb = document.querySelector('.vo-topbar')?.getBoundingClientRect() || { bottom: 0, height: 0 };
    const rest = Math.max(SHEET_MIN, Math.round(H - barH - tb.bottom));
    const max = keyboard ? Math.max(120, Math.round(visBottom - visTop - tb.height)) : rest;
    return { H, kb, keyboard, barH, top: tb.bottom, rest, max, min: Math.min(max, SHEET_MIN), half: Math.round(H / 2 - barH) };
  }
  const clamp = (h, r) => Math.round(Math.max(r.min, Math.min(r.max, h)));
  function apply() {
    const win = narrow() ? shown() : null;
    root.classList.toggle('pl-sheet-open', !!win);
    if (!win) {
      if (applied) { root.style.removeProperty('--pl-sheet-h'); root.style.removeProperty('--pl-sheet-bottom'); if (!officeSheet()) { root.style.removeProperty('--vo-chat-sheet-h'); root.classList.remove('vo-chat-sheet-tall'); } }
      applied = '';
      return;
    }
    const r = room(), h = clamp(drag?.moved ? drag.h : share != null ? share * r.rest : r.half, r);
    const mapH = document.querySelector('.vo-mapctl')?.offsetHeight || 0, tall = r.keyboard || r.H - r.barH - h - r.top < mapH + 16;
    root.style.setProperty('--pl-sheet-h', `${h}px`);
    if (r.keyboard) root.style.setProperty('--pl-sheet-bottom', `${r.kb}px`); else root.style.removeProperty('--pl-sheet-bottom');
    root.style.setProperty('--vo-chat-sheet-h', `${h}px`);
    root.classList.toggle('vo-chat-sheet-tall', tall);
    applied = `${h}|${r.kb}|${tall}`;
  }
  const soon = () => requestAnimationFrame(apply);   // (after the office's own sheet code on the same event)
  const save = h => { share = Math.max(0.05, Math.min(1, h / room().rest)); try { localStorage.setItem(SHEET_KEY, String(share)); } catch { /* private mode */ } };
  function grip(win) {
    if (win.querySelector(':scope > .pl-sheet-grip')) return;
    const g = document.createElement('button');
    g.type = 'button'; g.className = 'pl-sheet-grip'; g.innerHTML = '<span></span>';
    g.title = 'Drag to resize the chat; tap for half or full'; g.setAttribute('aria-label', 'Chat height: drag, or tap for half or full');
    g.addEventListener('pointerdown', e => {
      if (!narrow()) return;
      e.preventDefault(); g.setPointerCapture?.(e.pointerId);
      const r = room(), bottom = innerHeight - (r.keyboard ? r.kb : r.barH);
      drag = { y: e.clientY, h: clamp(bottom - e.clientY, r), moved: false, bottom };
      g.classList.add('is-dragging');
    });
    g.addEventListener('pointermove', e => {
      if (!drag) return;
      if (Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) { drag.h = clamp(drag.bottom - e.clientY, room()); apply(); }
    });
    const end = () => {
      if (!drag) return;
      g.classList.remove('is-dragging');
      const d = drag; drag = null;
      if (d.moved) save(d.h); else { const r = room(); save(clamp(share != null && share * r.rest > r.half + 20 ? r.half : r.max, r)); }
      apply();
    };
    g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
    g.addEventListener('keydown', e => {
      const r = room(), now = share != null ? share * r.rest : r.half, step = Math.round(r.rest * 0.1);
      if (e.key === 'ArrowUp') save(clamp(now + step, r)); else if (e.key === 'ArrowDown') save(clamp(now - step, r)); else return;
      e.preventDefault(); apply();
    });
    win.prepend(g);
  }
  // (only the windows' own roots are watched: a window coming, going, put away or full screen; never the thread)
  const backs = new MutationObserver(soon), seen = new WeakSet();
  const scan = () => {
    document.querySelectorAll('.chat-layer > .chat-back').forEach(b => {
      if (!seen.has(b)) { seen.add(b); backs.observe(b, { attributes: true, attributeFilter: ['class'] }); }
      const win = b.querySelector(':scope > .chatwin');
      if (win) grip(win);
    });
    soon();
  };
  const watch = new MutationObserver(scan);
  const hook = () => { const layer = document.querySelector('.chat-layer'); if (layer && !layer._plSheet) { layer._plSheet = true; watch.observe(layer, { childList: true }); scan(); } };
  new MutationObserver(hook).observe(document.body, { childList: true });
  hook();
  addEventListener('resize', soon);
  window.visualViewport?.addEventListener('resize', soon);
  window.visualViewport?.addEventListener('scroll', soon);
  addEventListener('vo:chat-windows', soon);
}

/** The copied windows' emoji become line icons (the office draws no emoji as icons); people's words stay as written. */
function icons() {
  const seen = new WeakSet();
  const watch = el => { if (el && !seen.has(el)) { seen.add(el); watchIcons(el); } };
  const scan = () => document.querySelectorAll('.chat-layer, .ap-back').forEach(watch);
  new MutationObserver(scan).observe(document.body, { childList: true });
  scan();
}

/** Mounts once per page. page: 'office' (index.html) or 'providers' (providers.html). Resolves window.voPL. */
export async function mount({ page = 'office' } = {}) {
  if (mounted) return mounted;
  mounted = (async () => {
    await styles();
    const app = {
      toast,
      hooks: { key: [] },
      // its Agent Studio: the office's agent menu at the agent's desk
      studio: { open: id => { const oid = officeIdFor(id); if (!oid || !window.VOOffice?.openAgent?.(oid)) toast('This agent has no desk in the office.'); } },
      // the shared limit of four chat windows: the office's own count too
      otherWindows: () => { try { return (window.VirtualOfficeChat?.windows?.() || []).length; } catch { return 0; } },
      // the office's own dialogs for the copied windows' names and deletes (never the browser's prompt/confirm)
      ask: ({ title, value = '' }) => (window.VOUI?.prompt ? window.VOUI.prompt({ title, value, label: 'Name', okLabel: 'Save' }) : Promise.resolve(window.prompt(title, value))),
      sure: ({ title, body = '', okLabel = 'OK', danger = false }) => (window.VOUI?.confirm ? window.VOUI.confirm({ title, body, okLabel, danger }) : Promise.resolve(window.confirm(`${title} ${body}`))),
      // (unify) last used, the office hooks
      used: (id, session) => opened(id, session),
      lastUsed: () => lastUsed(),
      windowsChanged: s => windowsChanged(s),
    };
    auth.ui = { confirmPassword, signIn: () => location.reload() };
    await auth.refresh();
    keyHooks(app);
    if (page === 'office') { rail(); sheet(); firstPlace(); }
    icons();
    bus.on('vo:select', i => { const p = S.people[i]; if (p && p.office) window.VOOffice?.focusAgent?.(p.office); });
    // the side panel's PC tab: the office's own Agent PC for the agent's desk
    bus.on('vo:open-pc', id => { const oid = officeIdFor(id); if (oid && window.VirtualOfficePreviews?.openPC) window.VirtualOfficePreviews.openPC(oid, { section: 'screen' }); else toast('This agent has no PC in the office.'); });
    chat.init(app);
    providers.init(app);
    bus.on('msg:chat', m => toolPreview(app, m));
    const net = new Net('/api/pl/ws');
    net.connect();
    let again = null;
    const reload = () => { clearTimeout(again); again = setTimeout(() => loadOffice().then(loadAgents), 400); };
    bus.on('msg:agents', reload);
    bus.on('msg:provider', m => { if (m?.status?.state === 'connected') reload(); });
    await loadOffice();
    await loadAgents();
    if (page === 'office') warmWhenNear();
    const api = {
      ready: true,
      isLayerAgent: id => !!layerAgent(id),
      layerIdFor: id => layerAgent(id)?.id ?? null,
      /** Layer agent `layerId` (a number from agents()) in the copied window, desk or not (Hermes profiles, tests). */
      openLayer: (layerId, opts = {}) => app.chat.open(Number(layerId), { session: opts.session ?? null, newWindow: !!opts.newWindow }),
      officeIdFor,
      agents: () => (S.agentList || []).slice(),
      windows: () => app.chat?.windows?.() || 0,
      /** (v0.12, the office's Chat button when every agent it lists is one of the layer's) the copied windows back, or
       *  the most recent chat (or the first agent) when none is open; toggleChats puts shown ones away instead. */
      showChats: () => app.chat.show(),
      toggleChats: () => app.chat.toggle(),
      chatsShown: () => app.chat.isOpen(),
      /** (unify) The agent and chat this browser used last, else the account's most recent chat, else the first agent;
       *  opts.newWindow: the most recent chat in a window of its own. */
      openRecent: (opts = {}) => app.chat.open(null, { newWindow: !!opts.newWindow }),
      /** (unify) The office's "+": a new window beside the others, its agent picker open. */
      newWindow: () => app.chat.another(),
      /** (unify) { agent: layer id, session } this browser used last, while it may still chat with it; else null. */
      lastUsed: () => lastUsed(),
      /** (unify) The answers that came while the copied windows were put away (the dock's badge adds the office's own). */
      unread: () => app.chat.unread(),
      /** The office's agent `id` in the copied window (opts.session: that chat; opts.newWindow). (unify, Office Life)
       *  opts.focus {approvalId | questionId}: that card is scrolled to and flashed; opts.panel 'tasks': the side panel on
       *  that tab (as the office window's open options). */
      async open(id, opts = {}) {
        const a = layerAgent(id);
        if (!a) return null;
        const w = await app.chat.open(a.id, { session: opts.session ?? null, newWindow: !!opts.newWindow });
        if (w && (opts.focus || opts.panel)) w.point?.({ focus: opts.focus || null, panel: opts.panel || null });
        return w ? `pl-${a.id}` : null;
      },
      /** (pllife) The office Agent PC's Screen: a Hermes agent's own screen (watch, take over, hand back), an OpenClaw
       *  agent's browser (its tabs, live frames). Returns { destroy } or null when `id` is not a layer agent. */
      mountScreen(el, id) {
        const a = layerAgent(id);
        if (!a || !el || !KINDS.has(kindOf(a))) return null;   // (an office provider's agent: the office's own Agent PC)
        return kindOf(a) === 'hermes' ? mountProviderScreen(el, a.id, { toast }) : mountProviderBrowser(el, a.id);
      },
      screenKind: id => { const a = layerAgent(id); return a && KINDS.has(kindOf(a)) ? (kindOf(a) === 'hermes' ? 'screen' : 'browser') : null; },
      /** The Agent Providers window: on a provider's first connection of `kind`, or on connection `id`. */
      async openProviders(which = null) {
        let id = Number.isInteger(Number(which)) && which !== null && which !== '' ? Number(which) : null;
        if (id === null && which) {
          try { const d = await getJSON('/api/agent-providers'); id = (d.providers || []).find(p => p.kind === which)?.id ?? null; } catch { /* the window says why */ }
        }
        return providers.open(id);
      },
      /** (uV-voice) Settings → Voice drawn into `host` (office-voice-settings.js). */
      mountVoice: host => import('./ui/office-voice-settings.js').then(m => m.mountVoiceSettings(host, { toast })),
      /** (uV-voice) The office agent `id`'s own voice (its Agent Studio's Voice tab, Settings → Voice) drawn into `host`;
       `name`: what the office calls it (else the layer's name). `id` "pl:<n>": the layer's agent n (no office id). */
      mountAgentVoice: (host, id, name) => import('./ui/office-voice-settings.js').then(m => { const a = /^pl:\d+$/.test(String(id)) ? (S.agentList || []).find(x => x.id === Number(String(id).slice(3))) : layerAgent(id); return m.mountAgentVoice(host, a ? { id: a.id, name: name || a.name } : null, { toast }); }),
      /** providers.html: the office's Agent Providers slot for OpenClaw/Hermes opens the copied window. */
      mountProviders(host, { kind = '', open = true } = {}) {
        if (!host) return;
        host.innerHTML = `<div class="pl-ap-slot"><p>${kind === 'hermes' ? 'Hermes' : 'OpenClaw'} connections, their agents and the provider's own menu (models, tools, skills, automations, approvals, sessions, settings) are in Agent Providers.</p>
          <button type="button" class="ps-button primary pl-ap-open">Open Agent Providers</button></div>`;
        host.querySelector('.pl-ap-open').onclick = () => api.openProviders(kind || null);
        if (open) api.openProviders(kind || null);   // (VO: open false = the page shows the office's own rows first)
      },
    };
    window.voPL = api;
    try { window.dispatchEvent(new CustomEvent('vo:pl-ready')); } catch { /* old browser */ }
    return api;
  })();
  return mounted;
}
