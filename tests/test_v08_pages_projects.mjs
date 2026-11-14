// Projects board (CH-02 projects part, CH-42 projects part, CH-44, CH-48 project title, C3, C8).
// Run: node tests/test_v08_pages_projects.mjs   (or node --test tests/test_v08_pages_projects.mjs)
//
// 1. Static: no inline on*= handlers in projects.js, escHtml escapes & < > " ', allow-lists hold.
// 2. DOM (linkedom, skipped when missing): projects.js renders hostile API data without creating
//    handler attributes, <img>/<svg> elements or url() styles, and names agents instead of raw ids.
// 3. Browser (skipped when chrome, playwright-core or the office at VO_BASE_URL is missing): the real
//    page with every /api/projects call mocked with XSS payloads; window.__xss must stay undefined,
//    no request may reach the payload host, no write request is sent, Escape closes detail then board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findChrome } from './test_v08_pages_lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', 'app');
const SRC = fs.readFileSync(path.join(APP, 'projects.js'), 'utf8');
const require = createRequire(import.meta.url);
// linkedom's window falls back to globalThis: keep the real fetch for the health probe.
const realFetch = globalThis.fetch;

const BASE = process.env.VO_BASE_URL || 'http://127.0.0.1:8095';
const SHOTS = process.env.VO_SHOT_DIR || '';

// ── hostile fixture ─────────────────────────────────────────────
const P_TAG = '"><img src=x onerror=window.__xss=1>';
const P_ATTR = "' onmouseover='window.__xss=2";
const P_FOCUS = 'x" autofocus onfocus="window.__xss=3';
const P_CSS = 'red;background:url(https://x.invalid/css)';
const P_ID = "p1'),window.__xss=4,('";
const P_COL = 'c1"] , [x="';

function fixture() {
  const project = {
    id: P_ID,
    title: `Proj ${P_TAG}`,
    description: `Desc ${P_ATTR}`,
    status: P_FOCUS,
    priority: P_FOCUS,
    branch: P_TAG,
    dueDate: `2026-01-01" onfocus="window.__xss=5`,
    tags: [P_TAG, "t');window.__xss=6;//"],
    taskCount: `<img src=x onerror=window.__xss=7>`,
    taskDone: 1,
    autoMode: false,
    columns: [
      { id: P_COL, title: `Col ${P_TAG}`, color: P_CSS, order: 0 },
      { id: 'col-done', title: 'Done', color: '#198754', order: 1 },
    ],
    tasks: [
      {
        id: `t1" onclick="window.__xss=8`, columnId: P_COL, title: `Task ${P_TAG}`, description: `**b** ${P_TAG}`,
        priority: P_FOCUS, assignee: 'main', dueDate: '2026-02-03T12:00:00Z', tags: [P_ATTR],
        checklist: [{ id: 'c', text: P_TAG, done: false }],
        comments: [{ id: 'k', author: P_TAG, text: P_TAG, createdAt: '2026-01-01T00:00:00Z' }],
        reviewCheck: [{ text: P_TAG, status: P_FOCUS }],
        order: 0,
      },
      { id: 't2', columnId: 'col-done', title: 'Second', assignee: 'ghost-agent', priority: 'high', order: 0 },
    ],
    activity: [{ taskId: `t1" onclick="window.__xss=8`, at: '2026-01-01T00:00:00Z', detail: P_TAG }],
  };
  return {
    project,
    list: [
      { ...project, columns: undefined, tasks: undefined },
      { id: 's1"><img src=x onerror=window.__xss=11>', title: `Side ${P_TAG}`, status: 'active', priority: P_FOCUS, taskCount: 2, taskDone: 1 },
    ],
    scores: { ok: true, leaderboard: [
      { agent: 'main', score: 120, completed: 3, streak: 2 },
      { agent: 'hermes-default', score: 30, completed: 1, streak: 1 },
      { agent: P_TAG, score: `<img src=x onerror=window.__xss=9>`, completed: 1, streak: P_TAG },
      { agent: 'coder', score: 35, completed: 2, streak: 1 },
    ] },
    agents: { agents: [
      { key: 'main', agentId: 'main', name: 'Ada', emoji: '⚡', selectionAliases: [] },
      { key: 'hermes-astra', agentId: 'hermes-astra', name: `Astra ${P_TAG}`, emoji: P_TAG, selectionAliases: ['hermes-default'] },
    ] },
    templates: { templates: [
      { id: `tpl'),window.__xss=10,('`, title: `Tpl ${P_TAG}`, description: P_ATTR,
        columns: [{ title: P_TAG, color: P_CSS }, { title: 'ok', color: '#abc' }] },
    ] },
    report: { report: {
      title: `Report ${P_TAG}`, generatedAt: P_TAG,
      stats: { total: P_TAG, done: 1, inProgress: 0, overdue: 0 },
      columns: [{ title: P_TAG, count: P_TAG, color: P_CSS }],
      agentWorkload: { main: 2, [P_TAG]: 1, coder: 1 },
      timeline: [{ title: P_TAG, dueDate: '2020-01-01', assignee: 'coder', priority: P_FOCUS }],
    } },
    workflow: { active: false, autoMode: false, phase: 'idle' },
    chat: { phase: 'idle', messages: [{ role: P_FOCUS, text: P_TAG, timestamp: P_TAG, tools: [{ name: P_TAG }, null] }] },
  };
}

function apiResponse(fx, method, url) {
  const u = new URL(url, 'http://x.local');
  const p = u.pathname;
  if (method !== 'GET') return { blockedWrite: true };
  if (p === '/agents-list') return fx.agents;
  if (p === '/api/agents') return { agents: [] };
  if (p === '/api/projects') return { ok: true, projects: fx.list };
  if (p === '/api/projects/scores') return fx.scores;
  if (p === '/api/projects/templates') return fx.templates;
  if (p.endsWith('/workflow/status')) return fx.workflow;
  if (p.endsWith('/workflow/chat')) return fx.chat;
  if (p.endsWith('/report')) return fx.report;
  if (p.startsWith('/api/projects/')) return { ok: true, project: JSON.parse(JSON.stringify(fx.project)) };
  return null;
}

// ── 1. static checks ────────────────────────────────────────────
test('projects.js has no inline on*= handler attributes in its templates', () => {
  const hits = SRC.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /(^|[\s"'`])on[a-z]+\s*=\s*["']/.test(line));
  assert.deepEqual(hits, [], 'inline handlers left: ' + hits.map(h => h[0]).join(', '));
  assert.ok(!/ProjMgr\.[a-zA-Z]+\(\s*'\$\{/.test(SRC), 'no ProjMgr.fn(\'${...}\') strings');
});

test('projects.js uses VOUI dialogs with a native fallback only', () => {
  const nativeCalls = SRC.split('\n').filter(l => /(^|[^.\w])(alert|confirm|prompt)\(/.test(l));
  assert.deepEqual(nativeCalls, [], 'bare alert/confirm/prompt calls: ' + nativeCalls.join(' | '));
  assert.match(SRC, /window\.VOUI/);
  assert.match(SRC, /ui\.confirm\(opts\)/);
  assert.match(SRC, /window\.confirm\(/);
});

function loadHelpers() {
  const esc = SRC.match(/function escHtml\(s\) \{[\s\S]*?\n    \}/);
  const block = SRC.match(/const STATUS_VALUES[\s\S]*?(?=\n    \/\/ DOM lookups)/);
  assert.ok(esc && block, 'helper source found');
  const ctx = { window: {}, String, Number, Array };
  vm.createContext(ctx);
  vm.runInContext(`${esc[0]}\n${block[0]}\nthis.h = { escHtml, safeStatus, safePriority, safeReviewStatus, safeColor, hexBase, safeDateValue, num, cssEsc };`, ctx);
  return ctx.h;
}

test('escHtml escapes all five characters and keeps zero', () => {
  const { escHtml } = loadHelpers();
  assert.equal(escHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escHtml(P_ATTR).includes("'"), false);
  assert.equal(escHtml(0), '0');
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
});

test('allow-lists for status, priority, color, date, numbers', () => {
  const h = loadHelpers();
  assert.equal(h.safeStatus('paused'), 'paused');
  assert.equal(h.safeStatus(P_FOCUS), 'active');
  assert.equal(h.safePriority('critical'), 'critical');
  assert.equal(h.safePriority('x y'), 'medium');
  assert.equal(h.safeReviewStatus('needs_more_work'), 'needs_more_work');
  assert.equal(h.safeReviewStatus('"><x'), 'pending');
  assert.equal(h.safeColor('#1a2b3c'), '#1a2b3c');
  assert.equal(h.safeColor('#abc'), '#abc');
  assert.equal(h.safeColor(P_CSS), '#6c757d');
  assert.equal(h.safeColor('#12345678'), '#12345678');
  assert.equal(h.safeColor('#123456789'), '#6c757d');
  assert.equal(h.hexBase('#abc'), '#aabbcc');
  assert.equal(h.hexBase('#11223344'), '#112233');
  assert.equal(h.safeDateValue('2026-11-01T12:00:00Z'), '2026-11-01');
  assert.equal(h.safeDateValue('2026-01-01" onfocus="x'), '2026-01-01');
  assert.equal(h.safeDateValue('" onfocus="x'), '');
  assert.equal(h.num('<img>'), 0);
  assert.equal(h.num('42'), 42);
  assert.equal(h.cssEsc('a"b'), 'a\\22 b');
});

// ── 2. linkedom render ──────────────────────────────────────────
function loadLinkedom() {
  for (const base of [process.env.NODE_PATH].filter(Boolean)) {
    for (const dir of base.split(path.delimiter)) {
      try { return require(path.join(dir, 'linkedom')); } catch (e) { /* next */ }
    }
  }
  try { return require('linkedom'); } catch (e) { return null; }
}

const MODAL_HTML = `
  <div id="sidebar-projects-lb"></div><div id="sidebar-projects-list"></div>
  <button id="opener">open</button>
  <div id="projectsModal" class="modal hidden">
    <div class="modal-content projects-modal-content"><div id="proj-main-content"></div></div>
    <div id="proj-detail-panel" class="proj-detail-panel"></div>
    <div id="proj-form-overlay" class="proj-form-modal hidden"></div>
  </div>`;

// Only what projects.js renders (the modal shell, header and backdrop belong to index.html).
const RENDERED = '#proj-main-content *, #proj-detail-panel *, #proj-form-overlay *, #sidebar-projects-lb *, #sidebar-projects-list *';

function badStyle(value) {
  if (/url\(|expression\(|javascript:|@import|behavior:/i.test(value)) return true;
  // Every background/color value we write is a hex color, a number or a fixed keyword.
  for (const m of value.matchAll(/(?:^|;)\s*(background|background-color|border-color|color|--col-color|--pri-color)\s*:\s*([^;]*)/gi)) {
    if (!/^(#[0-9a-f]{3,8}|transparent)$/i.test(m[2].trim())) return true;
  }
  return false;
}

// The only trusted SVG: a decorative sprite icon, <svg class="vo-icon" aria-hidden="true"><use href="#i-..."/></svg>.
function isSpriteIcon(el) {
  if (!/^svg$/i.test(el.tagName) || el.getAttribute('class') !== 'vo-icon' || el.getAttribute('aria-hidden') !== 'true') return false;
  const kids = Array.from(el.children || []);
  return kids.length === 1 && /^use$/i.test(kids[0].tagName) && /^#i-[a-z0-9-]+$/.test(kids[0].getAttribute('href') || '')
    && kids[0].attributes.length === 1;
}

function hostileFindings(document) {
  const out = [];
  for (const el of document.querySelectorAll(RENDERED)) {
    for (const attr of Array.from(el.attributes || [])) {
      if (/^on/i.test(attr.name)) out.push(`${el.tagName} ${attr.name}`);
      if (attr.name === 'style' && badStyle(attr.value)) out.push(`${el.tagName} style=${attr.value}`);
      if (attr.name === 'autofocus') out.push(`${el.tagName} autofocus`);
    }
    if (/^(IMG|SVG|SCRIPT|IFRAME)$/i.test(el.tagName) && !isSpriteIcon(el)) out.push(`element ${el.tagName}`);
  }
  return out;
}

const linkedom = loadLinkedom();
test('projects.js renders hostile API data inertly (linkedom)', { skip: linkedom ? false : 'linkedom not found (set NODE_PATH)' }, async () => {
  const { parseHTML } = linkedom;
  const { window, document } = parseHTML(`<!doctype html><html><body>${MODAL_HTML}</body></html>`);
  const fx = fixture();
  const writes = [];
  const ctx = {
    window, document, console,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({ position: 'static' }),
    crypto: { randomUUID: () => 'uuid-1' },
    fetch: async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      const body = apiResponse(fx, method, url);
      if (body && body.blockedWrite) writes.push(`${method} ${url}`);
      return { ok: true, json: async () => body || {} };
    },
  };
  window.VOUI = { confirm: async () => false, prompt: async () => null, toast: () => {} };
  ctx.self = window;
  vm.createContext(ctx);
  // projects.js assigns to window.*; give the context's globals the same window object.
  vm.runInContext(`var window = this.window; ${SRC}`, ctx);
  const ProjMgr = window.ProjMgr;
  assert.ok(ProjMgr && typeof window.openProjectsManager === 'function');
  const settle = () => new Promise(r => setTimeout(r, 20));
  await settle(); await settle();

  // Sidebar + leaderboard: names, no raw ids, one "Other agents" row.
  const lb = document.getElementById('sidebar-projects-lb').textContent;
  assert.match(lb, /Ada/);
  assert.match(lb, /Other agents \(2\)/, lb);
  assert.ok(!/\bcoder\b/.test(lb) && !/\bmain\b/.test(lb) && !/hermes-default/.test(lb), 'raw ids hidden: ' + lb);
  assert.match(lb, /Astra/, 'alias hermes-default resolves to Astra');

  window.openProjectsManager();
  await settle(); await settle();
  const card = document.querySelector('#projectsModal .proj-card');
  assert.ok(card, 'project card rendered');
  assert.equal(card.dataset.id, P_ID, 'id round-trips through data-id unchanged');
  assert.match(card.querySelector('.proj-card-title').textContent, /<img src=x/);
  assert.equal(card.querySelector('.proj-badge').className, 'proj-badge badge-active');

  await ProjMgr.openProject(P_ID);
  await settle(); await settle();
  const col = document.querySelector('#projectsModal .proj-col[data-col-id]');
  assert.equal(col.dataset.colId, P_COL);
  assert.equal(col.getAttribute('style'), '--col-color:#6c757d');
  assert.ok(document.querySelector('#projectsModal .proj-board-title'), 'board title rendered');
  ProjMgr.showQuickAdd(P_COL);
  const qa = document.querySelector('#projectsModal .proj-quick-add[data-col-id]');
  assert.ok(!qa.classList.contains('hidden'), 'quick add found through CSS.escape-safe lookup');

  ProjMgr.openTaskDetail(`t1" onclick="window.__xss=8`);
  await settle();
  const panel = document.getElementById('proj-detail-panel');
  assert.ok(panel.classList.contains('open'));
  assert.ok(panel.textContent.includes('Other agent') || panel.innerHTML.includes('⚡ Ada'));
  assert.match(panel.querySelector('#detail-due').getAttribute('value') || '', /^(\d{4}-\d{2}-\d{2})?$/);

  await ProjMgr.showTemplatesView(); await settle();
  assert.ok(document.querySelector('[data-action="delete-template"]'));
  await ProjMgr.showReport(P_ID); await settle();
  const reportText = document.getElementById('proj-main-content').textContent;
  assert.ok(!/\bcoder\b/.test(reportText), 'report workload hides raw ids');
  ProjMgr.editProjectDialog(P_ID);

  const findings = hostileFindings(document);
  assert.deepEqual(findings, [], findings.join('\n'));
  assert.equal(window.__xss, undefined);
  assert.deepEqual(writes, [], 'no writes');
  ProjMgr.hideFormModal();
  window.closeProjectsModal();
});

// ── 3. real browser against the running office ──────────────────
async function browserOrSkip(t) {
  const playwright = loadPlaywright();
  if (!playwright) { console.log('SKIP projects browser: playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)'); t.skip('playwright-core not found'); return null; }
  const chromePath = findChrome();
  if (!chromePath) { console.log('SKIP projects browser: Chrome/Chromium was not found (set CHROME_PATH)'); t.skip('chrome not found'); return null; }
  try {
    const r = await realFetch(BASE + '/health', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) { console.log(`SKIP projects browser: office not reachable at ${BASE}`); t.skip(`office not reachable at ${BASE}`); return null; }
  return playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
}

test('XSS payloads stay inert in the real page; Escape closes detail, then board', { timeout: 120000 }, async (t) => {
  const browser = await browserOrSkip(t);
  if (!browser) return;
  try {
    for (const vp of [{ width: 1600, height: 900, name: 'desk' }, { width: 412, height: 915, name: 'phone' }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.name === 'phone' });
      const page = await ctx.newPage();
      const fx = fixture();
      const writes = [];
      const payloadHosts = [];
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if (/\/\/(x|x\.invalid)(\/|:|$)/.test(url)) { payloadHosts.push(url); return route.abort(); }
        const u = new URL(url);
        if (u.origin === new URL(BASE).origin && (u.pathname === '/agents-list' || u.pathname === '/api/agents' || u.pathname.startsWith('/api/projects'))) {
          const body = apiResponse(fx, req.method(), url);
          if (body && body.blockedWrite) { writes.push(`${req.method()} ${u.pathname}`); return route.abort(); }
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body || {}) });
        }
        if (req.method() !== 'GET' && u.origin === new URL(BASE).origin && u.pathname.startsWith('/api/')) {
          // Nothing in this test may write to the office: other areas' writes are aborted too.
          return route.abort();
        }
        return route.continue();
      });
      await page.goto(BASE + '/?projects-test=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => typeof window.openProjectsManager === 'function', null, { timeout: 15000 });
      await page.waitForTimeout(1500);

      const lb = await page.evaluate(() => document.getElementById('sidebar-projects-lb')?.innerText || '');
      assert.ok(!/\bcoder\b/.test(lb), `leaderboard shows names, not raw ids (${vp.name}): ${lb}`);

      await page.evaluate(() => { document.getElementById('opener')?.remove(); const b = document.createElement('button'); b.id = 'opener'; b.textContent = 'open'; document.body.appendChild(b); b.focus(); window.openProjectsManager(); });
      await page.waitForSelector('#projectsModal .proj-card', { timeout: 10000 });
      await page.hover('#projectsModal .proj-card');
      await page.click('#projectsModal .proj-card .proj-card-title');
      await page.waitForSelector('#projectsModal .proj-board-title', { timeout: 10000 });
      await page.waitForTimeout(500);
      const title = await page.evaluate(() => {
        const el = document.querySelector('#projectsModal .proj-board-title');
        const r = el.getBoundingClientRect();
        return { size: parseFloat(getComputedStyle(el).fontSize), w: r.width, h: r.height, right: r.right };
      });
      assert.ok(title.size >= 14, `board title >= 14px (${vp.name}): ${title.size}`);
      assert.ok(title.w > 40 && title.h > 10 && title.right <= vp.width, `board title visible (${vp.name}): ${JSON.stringify(title)}`);
      for (const sel of ['.proj-task-card', '.proj-col-title', '.proj-badge']) {
        const el = await page.$(`#projectsModal ${sel}`);
        if (el) await el.hover().catch(() => {});
      }
      await page.click('#projectsModal .proj-task-card');
      await page.waitForSelector('#proj-detail-panel.open', { timeout: 5000 });
      await page.waitForTimeout(400);
      await page.focus('#detail-due').catch(() => {});
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `xss-${vp.name}-detail.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      const afterOne = await page.evaluate(() => ({
        detail: document.getElementById('proj-detail-panel').classList.contains('open'),
        modal: !document.getElementById('projectsModal').classList.contains('hidden'),
      }));
      assert.deepEqual(afterOne, { detail: false, modal: true }, `first Escape closes only the task detail (${vp.name})`);

      await page.click('#projectsModal [data-action="show-report"]');
      await page.waitForSelector('#projectsModal .proj-report-title', { timeout: 5000 });
      await page.click('#projectsModal [data-action="back-to-list"]');
      await page.waitForSelector('#projectsModal [data-action="show-templates"]', { timeout: 5000 });
      // Delete asks first (VOUI.confirm, or native confirm which Playwright dismisses). Escape on the
      // confirm closes only the confirm; the board stays open and nothing is deleted.
      await page.click('#projectsModal [data-action="delete-project"]');
      const hasVoui = await page.evaluate(() => !!(window.VOUI && window.VOUI.confirm));
      if (hasVoui) {
        await page.waitForSelector('.vo-dialog', { timeout: 5000 });
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `confirm-${vp.name}.png`) });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
      const afterConfirm = await page.evaluate(() => ({
        dialog: !!document.querySelector('.vo-dialog'),
        modal: !document.getElementById('projectsModal').classList.contains('hidden'),
      }));
      assert.deepEqual(afterConfirm, { dialog: false, modal: true }, `Escape on the confirm keeps the board open (${vp.name})`);
      assert.deepEqual(writes, [], `cancelled delete sends nothing (${vp.name})`);
      await page.click('#projectsModal [data-action="show-templates"]');
      await page.waitForSelector('#projectsModal .proj-tpl-card', { timeout: 5000 });
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `xss-${vp.name}-templates.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const after = await page.evaluate(({ sel, iconSrc }) => ({
        modal: !document.getElementById('projectsModal').classList.contains('hidden'),
        focus: document.activeElement && document.activeElement.id,
        xss: window.__xss,
        injected: [...document.querySelectorAll(sel)]
          .flatMap(el => [...el.attributes].filter(a => /^on/i.test(a.name) || a.name === 'autofocus').map(a => el.tagName + ' ' + a.name))
          .concat([...document.querySelectorAll(sel)].filter(e => /^(img|svg|script|iframe)$/i.test(e.tagName) && !(0, eval)('(' + iconSrc + ')')(e)).map(e => 'element ' + e.tagName)),
      }), { sel: RENDERED, iconSrc: isSpriteIcon.toString() });
      assert.equal(after.modal, false, `second Escape closes the board (${vp.name})`);
      assert.equal(after.focus, 'opener', `focus returns to the opener (${vp.name})`);
      assert.equal(after.xss, undefined, `window.__xss stays undefined (${vp.name})`);
      assert.deepEqual(after.injected, [], `no injected handlers or elements (${vp.name})`);
      assert.deepEqual(payloadHosts, [], `no request to the payload host (${vp.name})`);
      assert.deepEqual(writes, [], `no writes (${vp.name})`);
      const ours = errors.filter(m => /projects\.js|ProjMgr/.test(m));
      assert.deepEqual(ours, [], `no projects.js page errors (${vp.name})`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
