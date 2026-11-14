/*
 * Virtual Office chat: the side panel (design 4.2 "Running-tasks chip + side panel", 4.5 phone).
 *
 * Tabs come from the agent's manifest (chat-caps.js `sideTabs`), in order:
 *   Tasks   (Hermes + OpenClaw): "This chat" / "All of <agent>", Running and
 *           Finished (folded), a task's prompt, output and transcript, Stop,
 *           Steer for Hermes.
 *   Browser (OpenClaw, Full access): the browser's tabs, an address bar, the
 *           page as pictures read again every second while shown; click, keys.
 *   Screen  (Hermes Bot Desktop, Full access): Start / Stop, a picture every
 *           1.5 s while shown, Take over / Hand back, browser-on-screen toggle.
 *   Files   (the agent's computer): list, open, download; Upload, New folder,
 *           Delete with Full access.
 * A tab that needs Full access on a Chat only connection shows its plain text
 * (and "Open Agent Providers" for people who manage the office).
 * The header gets a button with the running count, the window a chip
 * "2 running tasks · <title> +1 more" that opens Tasks.  Beside the
 * conversation when it keeps 440 px, over it when not, a full-screen sheet
 * with Back on phones.  The window passes `api` (get/post/image), so this file
 * never fetches by itself and runs under linkedom in Node tests.
 */
(function initChatSidePanel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatSidePanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatSidePanelFactory() {
  'use strict';

  const SCOPE_KEY = 'vo.chat.taskScope';
  const VIEWER_KEY = 'vo.chat.screenViewer';
  const WIDTH = 360;
  const WIDE = 560;
  const MAIN_MIN = 440;
  const PHONE_MAX = 600;
  const RECENT_MAX = 50;
  const TASKS_POLL_MS = 10000;
  const BROWSER_POLL_MS = 5000;
  const FRAME_MS = 1000;
  const THUMB_MS = 1500;
  const TYPE_MS = 150;
  const TEXT_PREVIEW_MAX = 200 * 1024;
  const FULL_ACCESS_FIX = 'Open Agent Providers, Edit the connection and choose Full access.';
  const LOCAL_TEXT = "OpenClaw's gateway does not open local addresses.";
  const NO_DESKTOP = 'This Hermes has no Bot Desktop yet (update Hermes).';
  const STATUS = {
    queued: 'Queued', running: 'Running', completed: 'Done', succeeded: 'Done', success: 'Done', done: 'Done', ok: 'Done',
    failed: 'Failed', error: 'Failed', timed_out: 'Timed out', timeout: 'Timed out', cancelled: 'Cancelled',
    canceled: 'Cancelled', lost: 'Lost'
  };
  const RUNTIME = { subagent: 'Subagent', cron: 'Scheduled job', cli: 'Command', exec: 'Command', acp: 'ACP session' };
  const PAGE_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
    'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

  // ------------------------------------------------------------------ pure helpers (tested)
  function str(value, max = 400) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  function ms(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  function isLive(task) {
    return task.status === 'queued' || task.status === 'running';
  }

  /** A task row from Hermes (subagents, cron) or OpenClaw (tasks ledger), in one shape. */
  function normalizeTask(raw, session = '') {
    if (!raw || typeof raw !== 'object') return null;
    const id = str(raw.id || raw.taskId, 300);
    if (!id) return null;
    const ex = raw.execution && typeof raw.execution === 'object' ? raw.execution : {};
    let status = str(raw.status || ex.state, 40).toLowerCase() || 'running';
    if (status === 'active' || status === 'in_progress' || status === 'started') status = 'running';
    if (status === 'pending' || status === 'waiting') status = 'queued';
    const firstLine = (text) => str(text, 2000).split('\n')[0].slice(0, 200);
    const title = str(raw.title, 200) || str(raw.label, 200) || str(raw.goal, 200) || firstLine(raw.prompt) || firstLine(raw.task) || 'Background task';
    const tool = ex.currentTool && typeof ex.currentTool === 'object' ? str(ex.currentTool.name, 80)
      : ex.tool && typeof ex.tool === 'object' ? str(ex.tool.name, 80) : str(ex.tool, 80);
    const owner = str(raw.sessionKey || raw.ownerSessionKey || raw.session, 400);
    const task = {
      id, status, title,
      runtime: str(raw.runtime || raw.kind, 30).toLowerCase(),
      startedAt: ms(raw.startedAt || raw.createdAt),
      endedAt: ms(raw.endedAt || raw.finishedAt || raw.updatedAt),
      tool, lastTool: str(raw.lastToolName, 80),
      toolUses: Number.isFinite(Number(raw.toolUseCount)) ? Number(raw.toolUseCount) : 0,
      progress: str(raw.progressSummary || raw.lastActivity, 600),
      summary: str(raw.terminalSummary, 2000),
      error: str(typeof raw.error === 'string' ? raw.error : raw.error?.message, 600),
      prompt: str(raw.prompt || raw.task, 20000),
      result: str(typeof raw.result === 'string' ? raw.result : raw.output, 20000),
      hasTranscript: raw.hasTranscript !== false,
      here: typeof raw.here === 'boolean' ? raw.here : (!owner || !session || owner === session)
    };
    return task;
  }

  function span(millis) {
    const s = Math.max(0, Math.floor(millis / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function ago(at, now) {
    const s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  /** "Running · 1m 4s · Current tool: Bash · 3 tool uses · from another chat". */
  function statusLine(task, now = Date.now(), scope = 'chat') {
    const bits = [STATUS[task.status] || task.status];
    if (isLive(task)) {
      if (task.startedAt) bits.push(span(now - task.startedAt));
      if (task.tool) bits.push(`Current tool: ${task.tool}`);
      else if (task.lastTool) bits.push(`Last tool: ${task.lastTool}`);
    } else if (task.endedAt) {
      bits.push(ago(task.endedAt, now));
    }
    if (task.toolUses) bits.push(task.toolUses === 1 ? '1 tool use' : `${task.toolUses} tool uses`);
    if (scope === 'agent' && task.here === false && task.runtime !== 'cron') bits.push('from another chat');
    return bits.join(' · ');
  }

  /** The chip under the conversation, '' when nothing runs. */
  function chipText(running) {
    const n = running.length;
    if (!n) return '';
    return `${n === 1 ? '1 running task' : `${n} running tasks`} · ${running[0].title}${n > 1 ? ` +${n - 1} more` : ''}`;
  }

  /** The tabs to show (chat-caps.js `sideTabs`), each {id, label, locked, write?, writeLocked?, action?}. */
  function tabsFor(view) {
    const list = view && view.ok && Array.isArray(view.sideTabs) ? view.sideTabs : [];
    return list.filter(t => t && typeof t.id === 'string').map(t => ({
      id: t.id, label: t.label || t.id, locked: str(t.locked, 600), write: t.write === true,
      writeLocked: str(t.writeLocked, 600), action: str(t.action, 60)
    }));
  }

  /** Addresses OpenClaw's gateway refuses (this machine, the home network). */
  function isLocalAddress(value) {
    let text = str(value, 2000);
    if (!text) return false;
    if (!/^[a-z][\w+.-]*:\/\//i.test(text)) text = 'http://' + text;
    let host = '';
    try { host = new URL(text).hostname.toLowerCase(); } catch (_) { return false; }
    host = host.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
    if (host === '::1' || host === '0.0.0.0' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }

  function webAddress(value) {
    const text = str(value, 2000);
    if (!text) return '';
    return /^[a-z][\w+.-]*:/i.test(text) ? text : 'https://' + text;
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function errorText(r, fallback) {
    const d = r && r.data && typeof r.data === 'object' ? r.data : {};
    return str(d.message || d.reason || d.error, 600) || fallback;
  }

  // ------------------------------------------------------------------ the panel
  function create(opts) {
    const doc = opts.doc;
    const host = opts.root;
    const io = opts.api;
    const timers = opts.timers || { set: (fn, t) => setTimeout(fn, t), clear: (id) => clearTimeout(id) };
    const storage = opts.storage || null;
    const isPhone = opts.isPhone || (() => (doc.defaultView?.innerWidth || 1600) <= PHONE_MAX);
    const isVisible = opts.isVisible || (() => !doc.hidden);
    const confirmFn = opts.confirm || ((text) => (doc.defaultView?.confirm ? doc.defaultView.confirm(text) : true));
    const promptFn = opts.prompt || ((text, value) => (doc.defaultView?.prompt ? doc.defaultView.prompt(text, value) : null));
    const toast = opts.toast || (() => {});
    const now = opts.now || (() => Date.now());

    const P = { open: false, tab: 'tasks', tabs: [], view: null, agent: '', session: '', agentName: '', transport: '', manage: false, taskSteer: false };
    const T = { key: null, scope: readScope(), active: [], recent: [], loaded: false, loading: false, error: '', detail: null,
      details: new Map(), transcripts: new Map(), stopping: new Set(), seq: 0, finishedOpen: false, poll: null, tick: null };
    const B = { key: null, state: null, loading: false, error: '', notice: '', tab: null, img: null, frameTimer: null, poll: null,
      typed: '', typeTimer: null, loop: 0 };
    const S = { key: null, state: null, loading: false, error: '', img: null, timer: null, busy: false, loop: 0 };
    const F = { key: null, path: '', list: null, loading: false, error: '', file: null, busy: false };

    // --- DOM: header button, chip, panel
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const button = (cls, text, title) => { const b = el('button', cls, text); b.type = 'button'; if (title) { b.title = title; b.setAttribute('aria-label', title); } return b; };
    // Pixel icon from the shared sprite (UI-07); text stays a separate node so labels read the same.
    const icon = name => { const s = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'vo-icon'); s.setAttribute('aria-hidden', 'true'); const u = doc.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.appendChild(u); return s; };
    const iconButton = (cls, name, title) => { const b = button(cls, undefined, title); b.appendChild(icon(name)); return b; };

    const headBtn = button('hp-side-btn', '', 'Side panel');
    headBtn.hidden = true;
    headBtn.setAttribute('aria-pressed', 'false');
    const sideIcon = el('span', 'hp-side-btn-icon');
    sideIcon.appendChild(icon('sidebar'));
    headBtn.append(sideIcon, el('span', 'hp-side-count'));
    headBtn.querySelector('.hp-side-count').hidden = true;
    const headBtns = host.querySelector('.chat-header-btns');
    if (headBtns) headBtns.insertBefore(headBtn, headBtns.firstChild);

    const chip = button('hp-task-chip', '', 'Open the running tasks');
    chip.hidden = true;
    const chipAnchor = host.querySelector('.chat-attachments-preview') || host.querySelector('.chat-input-row');
    if (chipAnchor?.parentNode) chipAnchor.parentNode.insertBefore(chip, chipAnchor);
    else host.appendChild(chip);

    const panel = el('aside', 'hp-side');
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Side panel');
    const head = el('div', 'hp-side-head');
    const back = button('hp-side-back', '‹ Back', 'Back to the chat');
    const tabsBox = el('div', 'hp-side-tabs');
    tabsBox.setAttribute('role', 'tablist');
    tabsBox.setAttribute('aria-label', 'Side panel');
    const reload = button('hp-side-reload', '↻', 'Refresh');
    const closeBtn = button('hp-side-close', '✕', 'Close the side panel');
    head.append(back, tabsBox, el('span', 'hp-side-grow'), reload, closeBtn);
    const body = el('div', 'hp-side-body');
    body.setAttribute('role', 'tabpanel');
    panel.append(head, body);
    const chatBody = host.querySelector('.chat-body') || host;
    chatBody.appendChild(panel);

    const fileInput = el('input', 'hp-side-upload');
    fileInput.type = 'file';
    fileInput.hidden = true;
    panel.appendChild(fileInput);

    // ------------------------------------------------------------ context
    function readScope() {
      try { return storage?.getItem(SCOPE_KEY) === 'agent' ? 'agent' : 'chat'; } catch (_) { return 'chat'; }
    }

    function tabById(id) { return P.tabs.find(t => t.id === id) || null; }
    function usable(id) { const t = tabById(id); return !!(t && !t.locked); }

    /** The window's agent, chat and manifest view changed (or were set again). */
    function setContext(ctx) {
      P.view = ctx.view || null;
      P.tabs = tabsFor(P.view);
      P.agent = str(ctx.agent, 300);
      P.session = str(ctx.session, 400);
      P.agentName = str(ctx.agentName, 80) || 'the agent';
      P.transport = str(ctx.transport || P.view?.transport, 40);
      P.manage = !!(P.view && P.view.manage);
      P.taskSteer = !!ctx.taskSteer;
      if (!P.tabs.length) P.open = false;
      if (!tabById(P.tab)) P.tab = P.tabs[0]?.id || 'tasks';
      const tk = usable('tasks') ? `${P.agent}\u0000${P.session}\u0000${T.scope}` : null;
      if (tk !== T.key) {
        T.key = tk; T.active = []; T.recent = []; T.loaded = false; T.error = ''; T.detail = null;
        T.details.clear(); T.transcripts.clear(); T.stopping.clear();
        if (tk) loadTasks();
      }
      const agentKey = P.agent;
      if (B.key !== (usable('browser') ? agentKey : null)) resetBrowser(usable('browser') ? agentKey : null);
      if (S.key !== (usable('screen') ? agentKey : null)) { stopScreen(); S.key = usable('screen') ? agentKey : null; S.state = null; S.error = ''; }
      if (F.key !== (usable('files') ? agentKey : null)) { F.key = usable('files') ? agentKey : null; F.path = ''; F.list = null; F.file = null; F.error = ''; }
      paint();
    }

    function params(extra) {
      return Object.assign({ agent: P.agent, session: P.session }, extra || {});
    }

    // ------------------------------------------------------------ tasks
    async function loadTasks() {
      const key = T.key;
      if (!key) return;
      if (T.scope === 'chat' && !P.session) { T.active = []; T.recent = []; T.loaded = true; paint(); return; }
      const seq = ++T.seq;
      T.loading = true; T.error = '';
      paint();
      try {
        const r = await io.get('/api/agent-chat/tasks', params({ scope: T.scope }));
        if (seq !== T.seq || key !== T.key) return;
        if (!r.ok) { T.error = errorText(r, 'Could not load the tasks.'); return; }
        const rows = (list) => (Array.isArray(list) ? list : []).map(x => normalizeTask(x, P.session)).filter(Boolean);
        T.active = rows(r.data.active).filter(isLive);
        T.recent = rows(r.data.recent).concat(rows(r.data.active).filter(t => !isLive(t)))
          .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, RECENT_MAX);
        T.loaded = true;
      } catch (e) {
        if (seq === T.seq) T.error = 'Could not load the tasks.';
      } finally {
        if (seq === T.seq) { T.loading = false; paint(); }
      }
    }

    async function loadDetail(id) {
      const key = T.key;
      T.transcripts.set(id, { loading: true });
      paint();
      const q = params({ scope: T.scope, task: id });
      const [one, tr] = await Promise.allSettled([io.get('/api/agent-chat/tasks/one', q), io.get('/api/agent-chat/tasks/history', q)]);
      if (key !== T.key) return;
      const oneR = one.status === 'fulfilled' ? one.value : null;
      if (oneR && oneR.ok && oneR.data.task) {
        const t = normalizeTask(oneR.data.task, P.session);
        if (t) { T.details.set(id, t); upsert(t, false); }
      } else {
        T.details.set(id, { error: oneR && oneR.status === 404 ? 'This task is no longer available.' : 'Could not load the task details.' });
      }
      const trR = tr.status === 'fulfilled' ? tr.value : null;
      T.transcripts.set(id, trR && trR.ok ? { messages: Array.isArray(trR.data.messages) ? trR.data.messages : [] } : { error: 'Could not load the transcript.' });
      paint();
    }

    function upsert(task, repaint = true) {
      if (!task) return;
      T.active = T.active.filter(x => x.id !== task.id);
      T.recent = T.recent.filter(x => x.id !== task.id);
      if (isLive(task)) T.active = [task, ...T.active];
      else {
        T.recent = [task, ...T.recent].sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, RECENT_MAX);
        T.stopping.delete(task.id);
      }
      const d = T.details.get(task.id);
      if (d && !d.error) {
        const ended = isLive(d) && !isLive(task);
        T.details.set(task.id, Object.assign({}, d, task, { prompt: task.prompt || d.prompt, result: task.result || d.result }));
        if (ended && T.detail === task.id) loadDetail(task.id);
      }
      if (repaint) paint();
    }

    /** A `session.task` frame (the chat's own, or the agent's: `sessionKey` says which). */
    function onTask(event) {
      if (!T.key || !event || typeof event !== 'object') return;
      const change = str(event.change, 20) || 'upserted';
      const here = !event.sessionKey || !P.session || event.sessionKey === P.session;
      if (change === 'deleted' && event.taskId) {
        T.active = T.active.filter(x => x.id !== event.taskId);
        T.recent = T.recent.filter(x => x.id !== event.taskId);
        if (T.detail === event.taskId) T.detail = null;
        paint();
      } else if (change === 'restored') {
        loadTasks();
      } else if (event.task && (T.scope === 'agent' || here)) {
        const t = normalizeTask(Object.assign({}, event.task, { here }), P.session);
        if (t) upsert(t);
      }
    }

    async function stopTask(id) {
      if (T.stopping.has(id)) return;
      const key = T.key;
      T.stopping.add(id); paint();
      try {
        const r = await io.post('/api/agent-chat/tasks/cancel', params({ task: id, scope: T.scope }));
        if (key !== T.key) return;
        if (r.ok && r.data.task) upsert(normalizeTask(r.data.task, P.session), false);
        if (!r.ok || r.data.cancelled === false) toast(errorText(r, 'Could not stop the task.'), 'error');
      } catch (_) { toast('Could not stop the task.', 'error'); }
      finally { T.stopping.delete(id); paint(); }
    }

    async function steerTask(id, text) {
      const words = str(text, 4000);
      if (!words) return false;
      const r = await io.post('/api/agent-chat/tasks/steer', params({ task: id, text: words })).catch(() => null);
      if (!r || !r.ok) { toast(errorText(r, 'Could not send that to the task.'), 'error'); return false; }
      toast('Sent to the task.');
      return true;
    }

    function setScope(scope) {
      const next = scope === 'agent' ? 'agent' : 'chat';
      if (next === T.scope) return;
      T.scope = next;
      try { storage?.setItem(SCOPE_KEY, next); } catch (_) {}
      T.key = null;
      setContext({ view: P.view, agent: P.agent, session: P.session, agentName: P.agentName, transport: P.transport, taskSteer: P.taskSteer });
    }

    // ------------------------------------------------------------ browser (OpenClaw)
    function resetBrowser(key) {
      B.loop++;
      timers.clear(B.frameTimer); B.frameTimer = null;
      timers.clear(B.poll); B.poll = null;
      if (B.img) io.release?.(B.img);
      Object.assign(B, { key, state: null, loading: false, error: '', notice: '', tab: null, img: null });
    }

    function browserShowing() { return P.open && P.tab === 'browser' && usable('browser') && isVisible() && host.isConnected !== false; }

    async function loadBrowser() {
      if (B.loading) return;
      B.loading = true;
      const key = B.key;
      try {
        const r = await io.get('/api/agent-chat/browser', params({ op: 'state' }));
        if (key !== B.key) return;
        if (!r.ok) { B.error = errorText(r, "Could not read OpenClaw's browser."); B.state = null; return; }
        B.error = '';
        B.state = r.data;
        const tabs = Array.isArray(r.data.tabs) ? r.data.tabs : [];
        if (!tabs.some(t => t.id === B.tab)) B.tab = tabs[0]?.id || null;
      } catch (_) {
        B.error = "Could not read OpenClaw's browser.";
      } finally {
        B.loading = false;
        paint();
      }
    }

    function browserLive() {
      if (!browserShowing()) {
        timers.clear(B.frameTimer); B.frameTimer = null;
        timers.clear(B.poll); B.poll = null;
        return;
      }
      if (!B.state && !B.loading && !B.error) loadBrowser();
      if (!B.poll) {
        const again = () => { B.poll = null; if (!browserShowing()) return; loadBrowser(); B.poll = timers.set(again, BROWSER_POLL_MS); };
        B.poll = timers.set(again, BROWSER_POLL_MS);
      }
      if (B.tab && !B.frameTimer) nextFrame(0);
    }

    function nextFrame(delay) {
      const loop = B.loop;
      B.frameTimer = timers.set(async () => {
        if (loop !== B.loop || !browserShowing() || !B.tab) { B.frameTimer = null; return; }
        const tab = B.tab;
        try {
          const r = await io.image('/api/agent-chat/browser/frame', params({ tab }));
          if (loop !== B.loop) return;
          if (r && r.url && tab === B.tab) {
            const old = B.img;
            B.img = r.url;
            B.notice = '';
            const img = body.querySelector('.hp-bw-img');
            if (img) img.src = r.url;
            if (old) io.release?.(old);
          } else if (r && r.status === 204) {
            B.notice = 'The page is not showing yet.';
          } else if (r && r.status >= 400) {
            B.notice = r.message || 'Could not show the page.';
          }
          const note = body.querySelector('.hp-bw-notice');
          if (note) { note.textContent = B.notice; note.hidden = !B.notice; }
        } catch (_) { /* the next frame tries again */ }
        if (loop === B.loop) { B.frameTimer = null; if (browserShowing() && B.tab) nextFrame(FRAME_MS); }
      }, delay);
    }

    async function browserAct(op, extra = {}) {
      const r = await io.post('/api/agent-chat/browser', params(Object.assign({ op }, B.tab && !extra.noTab ? { tab: B.tab } : {}, extra))).catch(() => null);
      if (!r || !r.ok) { toast(errorText(r, 'The browser did not do that.'), 'error'); return null; }
      return r.data || {};
    }

    function openAddress(value) {
      const url = webAddress(value);
      if (!url) return;
      if (isLocalAddress(url)) { B.notice = LOCAL_TEXT; paint(); return; }
      const run = B.tab ? browserAct('navigate', { url }) : browserAct('open', { url, noTab: true }).then(r => { if (r?.tab?.id) B.tab = r.tab.id; return r; });
      run.then(() => loadBrowser());
    }

    function flushTyped() {
      timers.clear(B.typeTimer); B.typeTimer = null;
      const text = B.typed; B.typed = '';
      if (text) browserAct('text', { text });
    }

    // ------------------------------------------------------------ screen (Hermes Bot Desktop)
    function viewerId() {
      let id = '';
      try { id = doc.defaultView?.sessionStorage?.getItem(VIEWER_KEY) || ''; } catch (_) {}
      if (!id) {
        id = 'vo-' + Math.random().toString(36).slice(2, 12);
        try { doc.defaultView?.sessionStorage?.setItem(VIEWER_KEY, id); } catch (_) {}
      }
      return id;
    }

    function screenShowing() { return P.open && P.tab === 'screen' && usable('screen') && isVisible(); }

    function stopScreen() {
      S.loop++;
      timers.clear(S.timer); S.timer = null;
      if (S.img) io.release?.(S.img);
      S.img = null;
    }

    async function loadScreen() {
      if (S.loading) return;
      S.loading = true;
      const key = S.key;
      try {
        const r = await io.get('/api/agent-chat/screen', params({ viewer: viewerId() }));
        if (key !== S.key) return;
        if (!r.ok) {
          const code = r.data && r.data.error;
          S.state = null;
          S.error = code === 'unsupported' ? NO_DESKTOP : errorText(r, "Could not read the agent's screen.");
          return;
        }
        S.error = '';
        S.state = r.data;
      } catch (_) {
        S.error = "Could not read the agent's screen.";
      } finally {
        S.loading = false;
        paint();
      }
    }

    function screenLive() {
      if (!screenShowing()) { stopScreen(); return; }
      if (!S.state && !S.loading && !S.error) loadScreen();
      if (S.state && S.state.running && !S.timer) nextThumb(0);
    }

    function nextThumb(delay) {
      const loop = S.loop;
      S.timer = timers.set(async () => {
        if (loop !== S.loop || !screenShowing() || !S.state?.running) { S.timer = null; return; }
        try {
          const r = await io.image('/api/agent-chat/screen/thumb', params());
          if (loop !== S.loop) return;
          const img = body.querySelector('.hp-sc-img');
          const note = body.querySelector('.hp-sc-notice');
          if (r && r.url) {
            const old = S.img; S.img = r.url;
            if (img) { img.src = r.url; img.hidden = false; }
            if (note) note.hidden = true;
            if (old) io.release?.(old);
          } else if (note) {
            note.textContent = S.state?.holder === 'human' ? 'No picture while a person has control of the screen.' : 'No picture of the screen yet.';
            note.hidden = false;
          }
        } catch (_) { /* tries again */ }
        if (loop === S.loop) { S.timer = null; if (screenShowing() && S.state?.running) nextThumb(THUMB_MS); }
      }, delay);
    }

    async function screenAct(op, extra = {}) {
      if (S.busy) return;
      S.busy = true; paint();
      try {
        const r = await io.post('/api/agent-chat/screen', params(Object.assign({ op, viewer: viewerId() }, extra)));
        if (!r.ok) toast(errorText(r, 'The screen did not do that.'), 'error');
        else if (r.data && typeof r.data === 'object' && 'available' in r.data) S.state = r.data;
        else await (S.loading ? null : loadScreen());
      } catch (_) {
        toast('The screen did not do that.', 'error');
      } finally {
        S.busy = false;
        stopScreen();
        paint();
      }
    }

    // ------------------------------------------------------------ files
    function filesWrite() {
      const t = tabById('files');
      return !!(t && t.write && P.transport === 'hermes-serve');
    }

    async function loadFiles(path = F.path) {
      F.loading = true; F.error = ''; F.file = null;
      paint();
      const key = F.key;
      try {
        const r = await io.get('/api/agent-chat/files', params({ op: 'list', path }));
        if (key !== F.key) return;
        if (!r.ok) { F.error = errorText(r, 'Could not list the files.'); return; }
        F.path = str(r.data.path, 2000);
        F.list = r.data;
      } catch (_) {
        F.error = 'Could not list the files.';
      } finally {
        F.loading = false; paint();
      }
    }

    async function openFile(path) {
      F.busy = true; paint();
      try {
        const r = await io.get('/api/agent-chat/files/read', params({ path }));
        if (!r.ok) { toast(errorText(r, 'Could not open the file.'), 'error'); return; }
        F.file = r.data;
      } catch (_) {
        toast('Could not open the file.', 'error');
      } finally { F.busy = false; paint(); }
    }

    function fileHref(file) {
      const mime = str(file.mime, 120) || 'application/octet-stream';
      if (file.encoding === 'base64') return `data:${mime};base64,${file.content || ''}`;
      return `data:${mime};charset=utf-8,${encodeURIComponent(String(file.content || ''))}`;
    }

    function textOf(file) {
      if (file.encoding !== 'base64') return String(file.content || '');
      try {
        const bin = (doc.defaultView?.atob || globalThis.atob)(String(file.content || ''));
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch (_) { return ''; }
    }

    async function filesChange(op, extra) {
      F.busy = true; paint();
      try {
        const r = await io.post('/api/agent-chat/files', params(Object.assign({ op }, extra)));
        if (!r.ok) toast(errorText(r, 'The file was not changed.'), 'error');
      } catch (_) { toast('The file was not changed.', 'error'); }
      finally { F.busy = false; }
      loadFiles(F.path);
    }

    function joinPath(dir, name) {
      return dir ? `${dir.replace(/\/+$/, '')}/${name}` : name;
    }

    // ------------------------------------------------------------ open / close / layout
    function setOpen(open, tab) {
      if (tab && tabById(tab)) P.tab = tab;
      P.open = !!open && P.tabs.length > 0;
      if (P.open) host.dispatchEvent?.(new (doc.defaultView?.CustomEvent || globalThis.CustomEvent)('vw:chat-drawer-open', { detail: { drawer: 'side' } }));
      if (P.open && P.tab === 'tasks' && T.key && !T.loading) loadTasks();
      if (P.open && P.tab === 'files' && F.key && !F.list && !F.loading) loadFiles('');
      if (P.open && P.tab === 'screen') { S.state = null; S.error = ''; }
      paint();
      if (P.open) { try { panel.querySelector('.hp-side-tab.on')?.focus({ preventScroll: true }); } catch (_) {} }
      opts.onChange?.(P.open);
    }

    function layout() {
      const wide = P.tab === 'browser' || P.tab === 'screen';
      const w = wide ? WIDE : WIDTH;
      const phone = isPhone();
      const rect = chatBody.getBoundingClientRect ? chatBody.getBoundingClientRect() : { width: 0 };
      const beside = P.open && !phone && (rect.width || 0) - w >= MAIN_MIN;
      panel.classList.toggle('hp-side-sheet', P.open && phone);
      panel.classList.toggle('hp-side-beside', beside);
      panel.classList.toggle('hp-side-over', P.open && !phone && !beside);
      panel.classList.toggle('hp-side-wide', wide);
      panel.style.setProperty('--hp-side-w', w + 'px');
      chatBody.classList.toggle('hp-side-beside-on', beside);
      host.classList.toggle('hp-side-open', P.open);
    }

    function running() { return T.active.filter(isLive); }

    function paintChrome() {
      const enabled = P.tabs.length > 0;
      headBtn.hidden = !enabled;
      headBtn.setAttribute('aria-pressed', String(P.open));
      headBtn.title = 'Side panel: ' + P.tabs.map(t => t.label).join(', ');
      headBtn.setAttribute('aria-label', headBtn.title);
      const n = running().length;
      const count = headBtn.querySelector('.hp-side-count');
      count.textContent = n ? String(n) : '';
      count.hidden = !n;
      const text = usable('tasks') ? chipText(running()) : '';
      const show = !!text && !(P.open && P.tab === 'tasks');
      chip.hidden = !show;
      if (show && chip.textContent !== text) {
        chip.textContent = '';
        chip.append(el('span', 'hp-task-chip-mark'), el('span', 'hp-task-chip-text', text));
      }
    }

    function paintTabs() {
      tabsBox.textContent = '';
      for (const t of P.tabs) {
        const b = button('hp-side-tab' + (t.id === P.tab ? ' on' : '') + (t.locked ? ' locked' : ''), t.label);
        b.dataset.tab = t.id;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(t.id === P.tab));
        if (t.locked) b.title = t.locked;
        if (t.id === 'tasks' && !t.locked && running().length) b.appendChild(el('span', 'hp-side-n', String(running().length)));
        tabsBox.appendChild(b);
      }
      reload.hidden = !(P.tab === 'tasks' || P.tab === 'files' || P.tab === 'browser' || P.tab === 'screen') || !!tabById(P.tab)?.locked;
    }

    function paintLocked(t) {
      body.textContent = '';
      const box = el('div', 'hp-side-locked');
      box.appendChild(el('p', 'hp-side-locked-text', t.locked));
      box.appendChild(el('p', 'hp-side-fix', P.view?.lockedFix || FULL_ACCESS_FIX));
      if (t.action || P.manage) {
        const a = el('a', 'hp-side-open-providers', 'Open Agent Providers');
        a.href = 'providers.html';
        a.target = '_blank';
        a.rel = 'noopener';
        box.appendChild(a);
      }
      body.appendChild(box);
    }

    function taskRow(t) {
      const row = el('div', 'hp-task-row');
      row.dataset.task = t.id;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = 'Task details';
      row.appendChild(el('span', 'hp-task-mark ' + t.status));
      const b = el('div', 'hp-task-main');
      const l1 = el('div', 'hp-task-l1');
      l1.append(el('b', 'hp-task-title', t.title), el('span', 'hp-task-kind', RUNTIME[t.runtime] || 'Task'));
      const l2 = el('div', 'hp-task-l2', statusLine(t, now(), T.scope));
      l2.dataset.statusLine = '1';
      b.append(l1, l2);
      const note = t.error || (isLive(t) ? t.progress : t.summary || t.progress);
      if (note) { const l3 = el('div', 'hp-task-l3' + (t.error ? ' bad' : ''), note); b.appendChild(l3); }
      row.appendChild(b);
      if (isLive(t)) {
        const stop = button('hp-task-stop', '■', `Stop ${t.title}`);
        stop.dataset.act = 'task-stop';
        stop.disabled = T.stopping.has(t.id);
        row.appendChild(stop);
      }
      return row;
    }

    function paintTasks() {
      body.textContent = '';
      if (T.detail) { paintDetail(T.detail); return; }
      const scope = el('div', 'hp-task-scope');
      scope.setAttribute('role', 'radiogroup');
      scope.setAttribute('aria-label', 'Which tasks');
      for (const [id, label] of [['chat', 'This chat'], ['agent', `All of ${P.agentName}`]]) {
        const b = button('hp-task-scope-btn' + (T.scope === id ? ' on' : ''), label);
        b.dataset.scope = id;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(T.scope === id));
        scope.appendChild(b);
      }
      body.appendChild(scope);
      if (T.error) {
        const err = el('div', 'hp-side-error', T.error);
        err.setAttribute('role', 'alert');
        const again = button('hp-side-again', 'Try again');
        again.dataset.act = 'tasks-reload';
        err.appendChild(again);
        body.appendChild(err);
      }
      if (!T.loaded) {
        if (!T.error) body.appendChild(el('div', 'hp-side-empty', 'Loading background tasks…'));
        return;
      }
      if (!T.active.length && !T.recent.length) {
        const empty = el('div', 'hp-side-empty');
        if (T.scope === 'agent') empty.textContent = `${P.agentName} has no background tasks. Its subagents and scheduled jobs show here.`;
        else empty.textContent = P.session ? 'No background tasks from this chat.' : 'Nothing from this chat yet. Subagents it starts show here.';
        body.appendChild(empty);
        return;
      }
      const run = el('section', 'hp-task-sec hp-task-running');
      run.appendChild(el('h4', 'hp-task-head', `Running (${T.active.length})`));
      if (!T.active.length) run.appendChild(el('div', 'hp-side-none', 'No queued or running tasks.'));
      for (const t of T.active) run.appendChild(taskRow(t));
      body.appendChild(run);
      const fin = el('details', 'hp-task-sec hp-task-finished');
      fin.open = T.finishedOpen;
      fin.appendChild(el('summary', 'hp-task-head', `Finished (${T.recent.length})`));
      for (const t of T.recent) fin.appendChild(taskRow(t));
      fin.addEventListener('toggle', () => { T.finishedOpen = fin.open; });
      body.appendChild(fin);
    }

    function paintDetail(id) {
      const backBtn = button('hp-task-back', '‹ Back to tasks');
      backBtn.dataset.act = 'task-back';
      body.appendChild(backBtn);
      const d = T.details.get(id);
      const t = (d && !d.error ? d : null) || T.active.find(x => x.id === id) || T.recent.find(x => x.id === id);
      if (!t) {
        body.appendChild(el('div', d?.error ? 'hp-side-error' : 'hp-side-empty', d?.error || 'Loading task details…'));
        return;
      }
      const top = el('div', 'hp-task-detail');
      top.appendChild(el('span', 'hp-task-mark ' + t.status));
      const main = el('div', 'hp-task-main');
      const l1 = el('div', 'hp-task-l1');
      l1.append(el('b', 'hp-task-title', t.title), el('span', 'hp-task-kind', RUNTIME[t.runtime] || 'Task'));
      const l2 = el('div', 'hp-task-l2', statusLine(t, now(), T.scope));
      l2.dataset.statusLine = '1';
      main.append(l1, l2);
      top.appendChild(main);
      if (isLive(t)) {
        const stop = button('hp-task-dstop', T.stopping.has(t.id) ? 'Stopping…' : 'Stop', `Stop ${t.title}`);
        stop.dataset.act = 'task-stop';
        stop.dataset.task = t.id;
        stop.disabled = T.stopping.has(t.id);
        top.appendChild(stop);
      }
      body.appendChild(top);
      if (t.error) body.appendChild(el('div', 'hp-side-error', t.error));
      const read = !!(d && !d.error);
      const section = (label, text, none) => {
        body.appendChild(el('h4', 'hp-task-h', label));
        body.appendChild(el('div', 'hp-task-text' + (text ? '' : ' dim'), text || none));
      };
      if (isLive(t) && t.progress) section('Latest update', t.progress, '');
      section('Prompt', t.prompt, read ? 'Prompt unavailable.' : 'Loading task details…');
      section('Output', t.result || t.summary, 'No output yet.');
      if (isLive(t) && P.taskSteer) {
        const box = el('form', 'hp-task-steer');
        const input = el('textarea', 'hp-task-steer-input');
        input.rows = 2;
        input.placeholder = 'Tell this task something…';
        input.setAttribute('aria-label', 'Steer this task');
        const send = button('hp-task-steer-send', 'Steer');
        send.type = 'submit';
        box.append(input, send);
        box.addEventListener('submit', (e) => {
          e.preventDefault();
          send.disabled = true;
          steerTask(t.id, input.value).then((ok) => { if (ok) input.value = ''; send.disabled = false; });
        });
        body.appendChild(box);
      }
      if (t.hasTranscript) {
        body.appendChild(el('h4', 'hp-task-h', 'Transcript'));
        const tr = T.transcripts.get(id);
        const box = el('div', 'hp-task-transcript');
        if (!tr || tr.loading) box.appendChild(el('div', 'hp-side-none', 'Loading task transcript…'));
        else if (tr.error) box.appendChild(el('div', 'hp-side-none bad', tr.error));
        else if (!tr.messages.length) box.appendChild(el('div', 'hp-side-none', 'No transcript messages yet.'));
        else {
          for (const m of tr.messages.slice(-80)) {
            const role = str(m.role, 20);
            const row = el('div', 'hp-task-msg ' + (role === 'user' ? 'user' : 'agent'));
            const who = el('span', 'hp-task-who', role === 'user' ? 'Prompt' : role === 'system' ? 'Note' : 'Agent');
            const at = ms(m.ts || m.timestamp);
            if (at) who.appendChild(el('time', '', new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
            row.append(who, el('div', 'hp-task-text', str(m.text || m.content, 20000)));
            box.appendChild(row);
          }
        }
        body.appendChild(box);
      }
    }

    function paintBrowser() {
      body.textContent = '';
      const st = B.state;
      if (B.error && !st) {
        const err = el('div', 'hp-side-error', B.error);
        err.setAttribute('role', 'alert');
        body.appendChild(err);
        return;
      }
      if (!st) { body.appendChild(el('div', 'hp-side-empty', "Reading OpenClaw's browser…")); return; }
      if (st.available === false) { body.appendChild(el('div', 'hp-side-locked-text', str(st.reason, 600) || "OpenClaw's browser is not available.")); return; }
      if (!st.running) {
        body.appendChild(el('div', 'hp-side-empty', "OpenClaw's browser is not running."));
        const start = button('hp-bw-start', 'Start the browser');
        start.dataset.act = 'bw-start';
        body.appendChild(start);
        return;
      }
      const tabs = Array.isArray(st.tabs) ? st.tabs : [];
      const strip = el('div', 'hp-bw-tabs');
      strip.setAttribute('role', 'tablist');
      for (const t of tabs) {
        const b = button('hp-bw-tab' + (t.id === B.tab ? ' on' : ''), str(t.title, 80) || 'New tab');
        b.dataset.btab = str(t.id, 120);
        b.title = str(t.url, 400);
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(t.id === B.tab));
        strip.appendChild(b);
      }
      const add = button('hp-bw-new', '+', 'New tab');
      add.dataset.act = 'bw-new';
      strip.appendChild(add);
      body.appendChild(strip);
      const bar = el('form', 'hp-bw-bar');
      const back2 = button('hp-bw-nav', '‹', 'Back'); back2.dataset.act = 'bw-back';
      const fwd = button('hp-bw-nav', '›', 'Forward'); fwd.dataset.act = 'bw-forward';
      const rel = button('hp-bw-nav', '↻', 'Reload the page'); rel.dataset.act = 'bw-reload';
      const url = el('input', 'hp-bw-url');
      url.type = 'text';
      url.placeholder = 'Address';
      url.setAttribute('aria-label', 'Address');
      url.value = str(tabs.find(t => t.id === B.tab)?.url, 2000);
      const go = button('hp-bw-go', 'Open');
      go.type = 'submit';
      bar.append(back2, fwd, rel, url, go);
      bar.addEventListener('submit', (e) => { e.preventDefault(); openAddress(url.value); });
      body.appendChild(bar);
      const notice = el('div', 'hp-bw-notice', B.notice);
      notice.hidden = !B.notice;
      body.appendChild(notice);
      const view = el('div', 'hp-bw-view');
      view.tabIndex = 0;
      view.setAttribute('aria-label', 'The page (click it, then type)');
      if (B.tab) {
        const img = el('img', 'hp-bw-img');
        img.alt = 'The page in OpenClaw\'s browser';
        if (B.img) img.src = B.img;
        view.appendChild(img);
      } else {
        view.appendChild(el('div', 'hp-side-empty', 'No tab open. Type an address and press Open.'));
      }
      body.appendChild(view);
    }

    function paintScreen() {
      body.textContent = '';
      if (S.error && !S.state) {
        body.appendChild(el('div', S.error === NO_DESKTOP ? 'hp-side-empty' : 'hp-side-error', S.error));
        return;
      }
      const st = S.state;
      if (!st) { body.appendChild(el('div', 'hp-side-empty', "Reading the agent's screen…")); return; }
      if (st.available === false) { body.appendChild(el('div', 'hp-side-locked-text', str(st.reason, 600) || "The agent's screen is not available.")); return; }
      if (st.supported === false || st.installed === false) {
        body.appendChild(el('div', 'hp-side-empty', NO_DESKTOP));
        if (st.install) body.appendChild(el('code', 'hp-sc-install', str(st.install, 600)));
        return;
      }
      const bar = el('div', 'hp-sc-bar');
      const add = (cls, text, act, title) => { const b = button(cls, text, title); b.dataset.act = act; b.disabled = S.busy; bar.appendChild(b); return b; };
      if (!st.running) add('hp-sc-start', 'Start', 'sc-start', "Start the agent's screen");
      else {
        add('hp-sc-stop', 'Stop', 'sc-stop', "Stop the agent's screen");
        if (st.holder === 'human' && st.mine) add('hp-sc-release', 'Hand back', 'sc-release', 'Give the screen back to the agent');
        else if (st.holder !== 'human') add('hp-sc-take', 'Take over', 'sc-take', 'Take control of the screen');
      }
      if (typeof st.browserOnScreen === 'boolean') {
        const label = el('label', 'hp-sc-toggle');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = st.browserOnScreen;
        box.disabled = S.busy;
        box.dataset.act = 'sc-browser';
        label.append(box, doc.createTextNode(' Show the browser on this screen'));
        bar.appendChild(label);
      }
      body.appendChild(bar);
      if (st.blocker) body.appendChild(el('div', 'hp-side-error', str(st.blocker, 400)));
      if (st.holder === 'human') body.appendChild(el('div', 'hp-side-none', st.mine ? 'You have control of the screen.' : 'Someone else has control of the screen.'));
      if (!st.running) { body.appendChild(el('div', 'hp-side-empty', "The agent's screen is off.")); return; }
      const view = el('div', 'hp-sc-view');
      const img = el('img', 'hp-sc-img');
      img.alt = "The agent's screen";
      if (S.img) img.src = S.img; else img.hidden = true;
      const note = el('div', 'hp-sc-notice', 'Loading the screen…');
      note.hidden = !!S.img;
      view.append(img, note);
      body.appendChild(view);
    }

    function paintFiles() {
      body.textContent = '';
      const t = tabById('files');
      const bar = el('div', 'hp-fl-bar');
      const up = button('hp-fl-up', '‹ Up', 'Up one folder');
      up.dataset.act = 'fl-up';
      up.disabled = !(F.list && F.list.parent !== null && F.list.parent !== undefined && F.path);
      bar.append(up, el('span', 'hp-fl-path', F.path || 'Home'));
      if (filesWrite()) {
        const upl = button('hp-fl-upload', 'Upload'); upl.dataset.act = 'fl-upload'; upl.disabled = F.busy;
        const mk = button('hp-fl-mkdir', 'New folder'); mk.dataset.act = 'fl-mkdir'; mk.disabled = F.busy;
        bar.append(upl, mk);
      }
      body.appendChild(bar);
      if (t && !t.write && t.writeLocked) body.appendChild(el('div', 'hp-side-note', t.writeLocked));
      if (F.file) { paintFile(F.file); return; }
      if (F.error) { const e = el('div', 'hp-side-error', F.error); e.setAttribute('role', 'alert'); body.appendChild(e); return; }
      if (!F.list) { body.appendChild(el('div', 'hp-side-empty', 'Loading the files…')); return; }
      const entries = Array.isArray(F.list.entries) ? F.list.entries : [];
      if (!entries.length) { body.appendChild(el('div', 'hp-side-empty', 'This folder is empty.')); return; }
      const list = el('div', 'hp-fl-list');
      for (const e of entries) {
        const row = el('div', 'hp-fl-row' + (e.dir ? ' dir' : ''));
        row.dataset.path = str(e.path, 2000);
        row.dataset.dir = e.dir ? '1' : '';
        const open = button('hp-fl-open', undefined, e.dir ? 'Open the folder' : 'Open the file');
        open.append(icon(e.dir ? 'folder' : 'file'), doc.createTextNode(' ' + (str(e.name, 200) || str(e.path, 200))));
        open.dataset.act = 'fl-open';
        row.append(open, el('span', 'hp-fl-size', e.dir ? '' : formatBytes(e.size)));
        if (filesWrite()) { const del = iconButton('hp-fl-del', 'trash', `Delete ${str(e.name, 200)}`); del.dataset.act = 'fl-del'; row.appendChild(del); }
        list.appendChild(row);
      }
      body.appendChild(list);
    }

    function paintFile(file) {
      const box = el('div', 'hp-fl-file');
      const close2 = button('hp-fl-close', '‹ Back to the folder');
      close2.dataset.act = 'fl-close';
      const name = str(file.name, 200) || 'file';
      const save = el('a', 'hp-fl-download', 'Download');
      save.href = fileHref(file);
      save.setAttribute('download', name);
      box.append(close2, el('div', 'hp-fl-name', `${name}${file.size ? ` · ${formatBytes(file.size)}` : ''}`), save);
      const mime = str(file.mime, 120).toLowerCase();
      if (mime.startsWith('image/')) {
        const img = el('img', 'hp-fl-img');
        img.src = fileHref(file);
        img.alt = name;
        box.appendChild(img);
      } else if (mime.startsWith('text/') || /json|xml|javascript|yaml|markdown|csv/.test(mime) || file.encoding !== 'base64') {
        const text = textOf(file);
        box.appendChild(el('pre', 'hp-fl-text', text.length > TEXT_PREVIEW_MAX ? text.slice(0, TEXT_PREVIEW_MAX) + '\n…' : text));
      } else {
        box.appendChild(el('div', 'hp-side-empty', 'No preview for this kind of file: use Download.'));
      }
      body.appendChild(box);
    }

    function paint() {
      paintChrome();
      layout();
      panel.hidden = !P.open;
      if (!P.open) {
        timers.clear(T.tick); T.tick = null;
        timers.clear(T.poll); T.poll = null;
        browserLive(); screenLive();
        return;
      }
      paintTabs();
      const t = tabById(P.tab);
      panel.dataset.tab = P.tab;
      // Only a change rebuilds the tab: pictures update in place, and what is typed keeps its place.
      const sig = bodySig(t);
      if (body._sig !== sig) {
        const focused = doc.activeElement && body.contains(doc.activeElement) ? doc.activeElement.className : '';
        const steer = body.querySelector('.hp-task-steer-input')?.value || '';
        const typedUrl = doc.activeElement?.classList?.contains('hp-bw-url') ? doc.activeElement.value : null;
        body._sig = sig;
        if (t && t.locked) paintLocked(t);
        else if (P.tab === 'tasks') paintTasks();
        else if (P.tab === 'browser') paintBrowser();
        else if (P.tab === 'screen') paintScreen();
        else if (P.tab === 'files') paintFiles();
        const input = body.querySelector('.hp-task-steer-input');
        if (input && steer) input.value = steer;
        const url = body.querySelector('.hp-bw-url');
        if (url && typedUrl !== null) url.value = typedUrl;
        if (focused) { try { body.querySelector('.' + focused.split(' ')[0])?.focus({ preventScroll: true }); } catch (_) {} }
      }
      browserLive();
      screenLive();
      timers.clear(T.poll); T.poll = null;
      if (P.tab === 'tasks' && usable('tasks') && (T.scope === 'agent' || T.active.length)) {
        T.poll = timers.set(() => { T.poll = null; if (P.open && P.tab === 'tasks' && isVisible() && !T.loading) loadTasks(); }, TASKS_POLL_MS);
      }
      timers.clear(T.tick); T.tick = null;
      if (P.tab === 'tasks' && (T.active.length || T.detail)) T.tick = timers.set(tickTimes, 1000);
    }

    function bodySig(t) {
      const parts = [P.tab, P.agent, P.session, t ? t.locked + '|' + t.write + '|' + t.writeLocked : ''];
      if (t && t.locked) return parts.join('\u0000');
      if (P.tab === 'tasks') {
        parts.push(T.scope, T.loaded, T.error, T.detail || '', T.finishedOpen, [...T.stopping].join(','), P.agentName, P.taskSteer,
          JSON.stringify(T.active), JSON.stringify(T.recent));
        if (T.detail) parts.push(JSON.stringify(T.details.get(T.detail) || null), JSON.stringify(T.transcripts.get(T.detail) || null));
      } else if (P.tab === 'browser') {
        parts.push(B.error, B.tab, B.notice, JSON.stringify(B.state && { a: B.state.available, r: B.state.running, reason: B.state.reason, tabs: B.state.tabs }));
      } else if (P.tab === 'screen') {
        parts.push(S.error, S.busy, JSON.stringify(S.state));
      } else if (P.tab === 'files') {
        parts.push(F.path, F.error, F.busy, F.loading, JSON.stringify(F.list), F.file ? `${F.file.path}|${F.file.size}|${String(F.file.content || '').length}` : '', P.transport);
      }
      return parts.join('\u0000');
    }

    function tickTimes() {
      T.tick = null;
      if (!P.open || P.tab !== 'tasks') return;
      const rows = body.querySelectorAll('[data-status-line]');
      for (const line of rows) {
        const id = line.closest('[data-task]')?.dataset.task || T.detail;
        const t = T.active.find(x => x.id === id) || (T.detail === id ? T.details.get(id) : null);
        if (t && !t.error) line.textContent = statusLine(t, now(), T.scope);
      }
      T.tick = timers.set(tickTimes, 1000);
    }

    // ------------------------------------------------------------ events
    function onClick(e) {
      const target = e.target;
      const tab = target.closest?.('.hp-side-tab');
      if (tab) {
        P.tab = tab.dataset.tab; T.detail = null; F.file = null;
        setOpen(true, tab.dataset.tab);
        return;
      }
      if (target.closest?.('.hp-side-close') || target.closest?.('.hp-side-back')) { setOpen(false); headBtn.focus?.({ preventScroll: true }); return; }
      if (target.closest?.('.hp-side-reload')) {
        if (P.tab === 'tasks') { if (T.detail) loadDetail(T.detail); loadTasks(); }
        else if (P.tab === 'files') loadFiles(F.path);
        else if (P.tab === 'browser') loadBrowser();
        else if (P.tab === 'screen') loadScreen();
        return;
      }
      const sc = target.closest?.('[data-scope]');
      if (sc) { setScope(sc.dataset.scope); return; }
      const btab = target.closest?.('[data-btab]');
      if (btab) { B.tab = btab.dataset.btab; B.loop++; timers.clear(B.frameTimer); B.frameTimer = null; paint(); browserAct('focus'); return; }
      const img = target.closest?.('.hp-bw-img');
      if (img && B.tab) {
        const r = img.getBoundingClientRect();
        if (r.width && r.height) {
          const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
          const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
          img.closest('.hp-bw-view')?.focus?.({ preventScroll: true });
          browserAct('click', Object.assign({ fx, fy }, e.detail === 2 ? { double: true } : {}));
        }
        return;
      }
      const a = target.closest?.('[data-act]');
      const row = target.closest?.('.hp-task-row');
      if (a) {
        const act = a.dataset.act;
        if (act === 'task-stop') { stopTask(a.dataset.task || row?.dataset.task || T.detail); return; }
        if (act === 'task-back') { T.detail = null; paint(); return; }
        if (act === 'tasks-reload') { loadTasks(); return; }
        if (act === 'bw-start') { a.disabled = true; browserAct('start', { noTab: true }).then(() => loadBrowser()); return; }
        if (act === 'bw-new') { browserAct('open', { noTab: true }).then(r => { if (r?.tab?.id) B.tab = r.tab.id; loadBrowser(); }); return; }
        if (act === 'bw-back' || act === 'bw-forward') { browserAct(act === 'bw-back' ? 'back' : 'forward'); return; }
        if (act === 'bw-reload') { const cur = (B.state?.tabs || []).find(t => t.id === B.tab); browserAct('reload', cur?.url ? { url: cur.url } : {}); return; }
        if (act === 'sc-start') { screenAct('start'); return; }
        if (act === 'sc-stop') { screenAct('stop'); return; }
        if (act === 'sc-take') { screenAct('take'); return; }
        if (act === 'sc-release') { screenAct('release'); return; }
        if (act === 'fl-up') { const parent = F.list && F.list.parent; loadFiles(typeof parent === 'string' ? parent : ''); return; }
        if (act === 'fl-close') { F.file = null; paint(); return; }
        if (act === 'fl-open') {
          const r = a.closest('.hp-fl-row');
          if (r?.dataset.dir) loadFiles(r.dataset.path); else if (r) openFile(r.dataset.path);
          return;
        }
        if (act === 'fl-upload') { fileInput.value = ''; fileInput.click?.(); return; }
        if (act === 'fl-mkdir') {
          Promise.resolve(promptFn('Name of the new folder:', '')).then((value) => {
            const name = str(value, 200);
            if (name && !/[\\/]/.test(name)) filesChange('mkdir', { path: joinPath(F.path, name) });
          });
          return;
        }
        if (act === 'fl-del') {
          const r = a.closest('.hp-fl-row');
          if (!r) return;
          Promise.resolve(confirmFn(`Delete ${r.dataset.path} on the agent's computer?`)).then((ok) => {
            if (ok) filesChange('remove', { path: r.dataset.path, recursive: !!r.dataset.dir });
          });
          return;
        }
        return;
      }
      if (row && !target.closest('button')) { T.detail = row.dataset.task; loadDetail(T.detail); }
    }

    function onChange(e) {
      const box = e.target.closest?.('[data-act="sc-browser"]');
      if (box) {
        const on = !!box.checked;
        box.checked = !on;
        Promise.resolve(confirmFn(on ? "Change Hermes' settings so its browser opens on this screen?" : "Change Hermes' settings so its browser no longer opens on this screen?"))
          .then((ok) => { if (ok) screenAct('browser', { on }); });
      }
    }

    function onKey(e) {
      if (e.key === 'Escape' && !e.target.closest?.('.hp-bw-view')) {
        e.preventDefault();
        if (T.detail) { T.detail = null; paint(); } else if (F.file) { F.file = null; paint(); } else { setOpen(false); headBtn.focus?.({ preventScroll: true }); }
        return;
      }
      if (e.key === 'Enter' && e.target.classList?.contains('hp-task-row')) { T.detail = e.target.dataset.task; loadDetail(T.detail); return; }
      if (!e.target.closest?.('.hp-bw-view') || !B.tab || e.ctrlKey || e.metaKey || e.altKey) return;
      if (PAGE_KEYS.has(e.key)) { e.preventDefault(); flushTyped(); browserAct('key', { key: e.key }); return; }
      if (e.key && e.key.length === 1) {
        e.preventDefault();
        B.typed += e.key;
        timers.clear(B.typeTimer);
        B.typeTimer = timers.set(flushTyped, TYPE_MS);
      }
    }

    function onWheel(e) {
      if (!e.target.closest?.('.hp-bw-view') || !B.tab) return;
      e.preventDefault();
      browserAct('scroll', { dx: Math.round(e.deltaX || 0), dy: Math.round(e.deltaY || 0) });
    }

    async function onUpload() {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) { toast('Files up to 25 MB go to the agent\'s computer from here.', 'error'); return; }
      const data = await new Promise((resolve) => {
        const reader = new (doc.defaultView?.FileReader || globalThis.FileReader)();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      });
      const m = data.match(/^data:([^;,]*)(;base64)?,(.*)$/);
      if (!m) { toast('Could not read that file.', 'error'); return; }
      filesChange('write', { path: joinPath(F.path, file.name), content: m[3], encoding: 'base64', mime: file.type || 'application/octet-stream' });
    }

    const onOtherDrawer = (e) => {
      const which = e.detail && e.detail.drawer;
      if (!P.open || which === 'side') return;
      // The left sessions drawer may stay beside a wide window; on phones every sheet is full screen.
      if (which === 'history' && !isPhone()) return;
      setOpen(false);
    };
    const onResize = () => { if (P.open) layout(); };

    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('keydown', onKey);
    panel.addEventListener('wheel', onWheel, { passive: false });
    fileInput.addEventListener('change', onUpload);
    headBtn.addEventListener('click', () => setOpen(!P.open));
    chip.addEventListener('click', () => { T.detail = null; setOpen(true, 'tasks'); });
    host.addEventListener('vw:chat-drawer-open', onOtherDrawer);
    doc.defaultView?.addEventListener?.('resize', onResize);
    const onVisible = () => { if (P.open) paint(); };
    doc.addEventListener?.('visibilitychange', onVisible);

    function destroy() {
      resetBrowser(null); stopScreen();
      timers.clear(T.poll); timers.clear(T.tick); timers.clear(B.typeTimer);
      host.removeEventListener('vw:chat-drawer-open', onOtherDrawer);
      doc.defaultView?.removeEventListener?.('resize', onResize);
      doc.removeEventListener?.('visibilitychange', onVisible);
      headBtn.remove(); chip.remove(); panel.remove();
      chatBody.classList.remove('hp-side-beside-on');
      host.classList.remove('hp-side-open');
    }

    return {
      setContext,
      onTask,
      open: (tab) => setOpen(true, tab),
      close: () => setOpen(false),
      toggle: () => setOpen(!P.open),
      isOpen: () => P.open,
      refresh: () => { if (T.key) loadTasks(); },
      runningCount: () => running().length,
      destroy,
      elements: { button: headBtn, chip, panel },
      _state: { P, T, B, S, F }
    };
  }

  return { create, normalizeTask, statusLine, chipText, tabsFor, isLocalAddress, webAddress, isLive, FULL_ACCESS_FIX, LOCAL_TEXT, NO_DESKTOP };
});
