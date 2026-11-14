// One chat window for every agent (unify WP-E): the office's providers on fakes and labs, driven in a real browser.
// The office: tests/tools/office-labs.sh (Codex "Dex" fake-codex, Claude Code "Clara" fake-claude, OpenCode "OpenCode
// Main" fake-opencode, Antigravity "Gravity" fake-agy, Hermes API "Astra" lab-hermes-api, OpenClaw "Main"/"Ops"
// lab-openclaw). The fakes answer "<Fake X> reply <n>: <message>" and obey [[tool]] [[approval]] [[slow]] [[error]]
// (tests/tools/fake_cli_lib.py); the Hermes and OpenClaw stub models answer "Stub reply ...".
//   smoke     the CURRENT office (old window for office providers, copied window for OpenClaw): every provider answers
//             through the office, Codex asks for approval and goes on when allowed, Stop ends a slow answer.
//   unified   A+B+C+D merged (every agent in the copied window), desktop 1600x900 and phone 412: one window switched
//             in place across every provider (no second window), send + stream + reply, tool step, thinking, Codex
//             approval (allow, then deny), Stop, controls per agent (Antigravity: no chat list), history after a
//             reload, Chat button reopens the last-used agent and chat, "+" and ⧉ are the only ways to a second window.
// Usage: eval "$(LABS_ROOT=... tests/tools/office-labs.sh env)"; export VO_URL VO_LOG
//        PL_OUT=/tmp/x node tests/e2e/pl_office_chat.mjs smoke|unified|all [desk|phone|both]
//        smoke (the old window) needs an office with the layer OFF: SMOKE_URL / SMOKE_LOG = a second office-labs.sh run
//        with PL_LAYER=0 (other LABS_ROOT and ports, LABS_OC=0)
// Env for Playwright: PLAYWRIGHT_CORE_PATH (default ~/.hermes/hermes-agent/node_modules/playwright-core), CHROME_PATH.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { check, summary, sleep, results } from './pl_lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || path.join(require('node:os').homedir(), '.hermes/hermes-agent/node_modules/playwright-core'));
const VO = process.env.VO_URL || 'http://127.0.0.1:19700';
const LOG = process.env.VO_LOG || '';
// (unify: with the layer on every agent chats in the copied window, so the old window lives only in an office with the
// layer OFF: smoke runs there when SMOKE_URL/SMOKE_LOG name one — office-labs.sh with PL_LAYER=0 — else on VO_URL)
const SMOKE_VO = process.env.SMOKE_URL || VO;
const SMOKE_LOG = process.env.SMOKE_LOG || LOG;
const OUT = process.env.PL_OUT || '/tmp/vo-pl-office-chat';
const MODE = process.argv[2] || 'smoke';
const VIEWS = (process.argv[3] || 'both') === 'both' ? ['desk', 'phone'] : [process.argv[3]];
const RUN = Date.now().toString(36).slice(-4);     // makes every message of this run unique

// The office agents the lab makes (office ids = the /agents-list key: OpenCode and Antigravity keys are kind:profile) and
// what each answers.
const AGENTS = [
  { id: 'codex-dex', name: 'Dex', label: 'Codex', reply: /Fake Codex reply \d+:/, tool: true, thinking: true, approval: true, stop: true },
  { id: 'claude-code-clara', name: 'Clara', label: 'Claude Code', reply: /Fake Claude reply \d+:/, tool: true, stop: true },
  { id: 'opencode:main', name: 'OpenCode Main', label: 'OpenCode', reply: /Fake OpenCode reply \d+:/, tool: true, stop: true },
  { id: 'antigravity:gravity', name: 'Gravity', label: 'Antigravity', reply: /Fake Antigravity reply \d+:/, sessions: false, stop: true },
  { id: 'hermes-astra', name: 'Astra', label: 'Hermes', reply: /Stub reply/i },
];
const OPENCLAW = { id: 'main', name: 'Main', label: 'OpenClaw', reply: /Stub reply/i };

const T0 = Date.now();
const log = msg => console.log(`  [${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);
const until = async (fn, ms = 30000, every = 250) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch { /* page busy */ } await sleep(every); } return false; };
const logSize = (file = LOG) => { try { return fs.statSync(file).size; } catch { return 0; } };
const tracebacks = (from, file = LOG) => { try { const b = fs.readFileSync(file); return b.subarray(from).toString('utf8').split('\n').filter(l => /Traceback|Exception in thread/.test(l)); } catch { return []; } };

async function launch(view) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext(view === 'phone'
    ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror ${e.message}`));
  page.on('response', async r => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url().slice(0, 90)}`); });
  return { browser, ctx, page, errors };
}
async function load(page, { reload = false, url = VO } = {}) {
  if (reload) await page.reload({ waitUntil: 'domcontentloaded' }); else await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.VOOffice && window.VirtualOfficeChat && typeof window.VirtualOfficeChat.openForAgent === 'function', null, { timeout: 30000 });
  await page.evaluate(async () => { try { await window.voPLReady; } catch { /* layer off */ } });
}
async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 55 }).catch(() => {});
}

// ---------------------------------------------------------------- the office's own (old) window
const P = '[data-e2e-win="1"]';   // the old window showing the agent under test (the office opens one per agent)
const own = {
  text: page => page.evaluate(p => document.querySelector(`${p} .chat-messages`)?.innerText || '', P),
  busy: page => page.evaluate(p => { const s = document.querySelector(`${p} .chat-stop-btn`); return !!s && !s.hidden && s.offsetParent !== null && getComputedStyle(s).display !== 'none'; }, P),
  async open(page, id) {   // (the desk's agent menu, Chat; then mark the window that shows that agent)
    const found = await page.waitForFunction(i => window.VOOffice.openAgent(i, 'chat'), id, { timeout: 30000, polling: 1000 }).then(() => true, () => false);
    const on = await until(() => page.evaluate(i => {
      document.querySelectorAll('[data-e2e-win]').forEach(el => el.removeAttribute('data-e2e-win'));
      const w = [...document.querySelectorAll('.chat-panel.open')].find(el => el.querySelector('select')?.value === i);
      if (w) w.dataset.e2eWin = '1';
      return !!w && w.querySelector('.chat-input')?.getBoundingClientRect().width > 0;
    }, id), 20000);
    await sleep(800);
    if (!on) log(`no open old window shows ${id}`);
    return found && on;
  },
  async close(page) { await page.evaluate(p => document.querySelector(`${p} .chat-close, ${p} .chat-secondary-close`)?.click(), P); await sleep(400); },
  async send(page, text) { await page.fill(`${P} .chat-input`, text); await page.press(`${P} .chat-input`, 'Enter'); },
  async stop(page) { await page.evaluate(p => document.querySelector(`${p} .chat-stop-btn`)?.click(), P); },
  async idle(page, ms = 60000) { const end = Date.now() + ms; await sleep(500); while (Date.now() < end) { if (!(await own.busy(page))) { await sleep(400); if (!(await own.busy(page))) return true; } await sleep(250); } return false; },
  waitText: (page, re, ms = 60000) => until(async () => re.test(await own.text(page)), ms, 300),
};


async function smoke() {
  const from = logSize(SMOKE_LOG);
  const { browser, page, errors } = await launch('desk');
  try {
    await load(page, { url: SMOKE_VO });
    for (const a of AGENTS) {
      log(`smoke ${a.label}`);
      const opened = await own.open(page, a.id);
      const msg = `smoke-${RUN}-${a.id}${a.tool ? ' [[tool]]' : ''}`;
      if (opened) await own.send(page, msg);
      const re = new RegExp(`${a.reply.source}[^\\n]*smoke-${RUN}-${a.id}|smoke-${RUN}-${a.id}[\\s\\S]*${a.reply.source}`, 'i');
      const answered = opened && await own.waitText(page, re, 60000);
      check(`smoke ${a.label}: the office runs it and shows its reply (old window)`, answered, opened ? (await own.text(page)).slice(-160).replace(/\s+/g, ' ') : 'window did not open');
      await own.idle(page, 30000);
      if (opened && a.sessions === false) {   // (the same conversation, once it is the agent's active one)
        await own.send(page, `smoke-${RUN}-second`);
        const second = await own.waitText(page, new RegExp(`${a.reply.source} smoke-${RUN}-second`), 60000);
        check(`smoke ${a.label}: a second turn in that conversation shows its reply (old window)`, second, (await own.text(page)).slice(-160).replace(/\s+/g, ' '));
        await own.idle(page, 30000);
      }
      if (a.label === 'Codex') {
        await own.send(page, `smoke-${RUN}-approve [[approval]]`);
        const card = await until(() => page.evaluate(p => !!document.querySelector(`${p} .chat-approval-card.pending .chat-approval-actions button`), P), 30000);
        if (card) await page.click(`${P} .chat-approval-card.pending .chat-approval-actions button`);
        const done = card && await own.waitText(page, new RegExp(`Fake Codex reply \\d+: smoke-${RUN}-approve`), 40000);
        check('smoke Codex approval: the card shows, Allow lets the turn finish', done, `card=${card}`);
        await own.idle(page, 30000);
      }
      if (a.label === 'Claude Code') {
        await own.send(page, `smoke-${RUN}-slow [[slow]]`);
        const started = await own.waitText(page, new RegExp(`Fake Claude reply \\d+: smoke-${RUN}-slow`), 30000);
        if (started) await own.stop(page);
        const idle = started && await own.idle(page, 20000);
        const all = await own.text(page), text = all.slice(all.lastIndexOf(`smoke-${RUN}-slow`));   // (this run's answer only)
        check('smoke Claude Code stop: Stop ends a slow answer before its end', idle && !/\bw60\b/.test(text), `started=${started} idle=${idle} ${text.slice(-160)}`);
      }
      await own.close(page);
    }
    // OpenClaw on the copied window (unchanged by this package; proves the lab is wired) — only where the layer runs
    // (a SMOKE_URL office has it off: OpenClaw then has no chat there)
    if (!process.env.SMOKE_URL) {
    await page.evaluate(id => window.VirtualOfficeChat.openForAgent(id), OPENCLAW.id);
    const pl = await page.waitForSelector('.chat-back:not(.min) .cw-in', { state: 'visible', timeout: 20000 }).then(() => true, () => false);
    if (pl) { await page.fill('.chat-back:not(.min) .cw-in', `smoke-${RUN}-oc`); await page.press('.chat-back:not(.min) .cw-in', 'Enter'); }
    const ocOk = pl && await until(() => page.evaluate(() => /Stub reply/i.test(document.querySelector('.chat-back:not(.min) .cw-thread')?.innerText || '')), 60000);
    check('smoke OpenClaw: the lab gateway answers in the copied window', ocOk);
    }
    await shot(page, 'smoke-desk');
    // (known, pre-existing: the old window asks Antigravity for a chat list; the office answers 502 "does not expose
    //  persistent sessions". The bridge answers it {supported:false}, so the unified run has no such exception.)
    const known = errors.filter(e => /HTTP 502 .*\/api\/office\/chat-sessions\?agentId=antigravity/.test(e));
    if (known.length) log(`known: ${known.length} x 502 /api/office/chat-sessions for Antigravity (old window)`);
    const rest = errors.filter(e => !known.includes(e));
    check('smoke: no page errors or 5xx (besides the known Antigravity chat-list 502)', rest.length === 0, rest.slice(0, 3).join(' | '));
    const tb = tracebacks(from, SMOKE_LOG);
    check('smoke: no server tracebacks', tb.length === 0, tb.slice(0, 2).join(' | '));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- unified (A+B+C+D): the copied window for every agent
const W = '[data-e2e-pl="1"]';   // the copied window under test
const pl = {
  count: page => page.evaluate(() => document.querySelectorAll('.chat-back').length),
  shown: page => page.evaluate(() => [...document.querySelectorAll('.chat-back:not(.min)')].filter(b => b.querySelector('.chatwin')?.getBoundingClientRect().width > 0).length),
  async mark(page) {   // the front shown copied window (the last one in the layer that is not put away)
    return page.evaluate(() => {
      document.querySelectorAll('[data-e2e-pl]').forEach(el => el.removeAttribute('data-e2e-pl'));
      const shown = [...document.querySelectorAll('.chat-back:not(.min)')].filter(b => b.querySelector('.chatwin')?.getBoundingClientRect().width > 0);
      const w = shown.sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0))[0];
      if (w) w.dataset.e2ePl = '1';
      return w ? (w.querySelector('.cw-name')?.textContent || '').trim() : '';
    });
  },
  name: page => page.evaluate(w => (document.querySelector(`${w} .cw-name`)?.textContent || '').trim(), W),
  text: page => page.evaluate(w => document.querySelector(`${w} .cw-thread`)?.innerText || '', W),
  busy: page => page.evaluate(w => !!document.querySelector(`${w} .cw-send.stop`), W),
  async send(page, text) { await page.fill(`${W} .cw-in`, text); await page.press(`${W} .cw-in`, 'Enter'); },
  async idle(page, ms = 60000) { const end = Date.now() + ms; await sleep(400); while (Date.now() < end) { if (!(await pl.busy(page))) { await sleep(500); if (!(await pl.busy(page))) return true; } await sleep(250); } return false; },
  waitText: (page, re, ms = 60000) => until(async () => re.test(await pl.text(page)), ms, 250),
  visible: (page, sel) => page.evaluate(([w, s]) => { const e = document.querySelector(`${w} ${s}`); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.hidden'); }, [W, sel]),
  async rows(page) {   // open the agent picker; its rows {name, sub}
    await page.click(`${W} .cw-agent`);
    await page.waitForSelector('.cw-pop-agents .cw-pi', { timeout: 10000 });
    return page.evaluate(() => [...document.querySelectorAll('.cw-pop-agents .cw-pi')].map(b => ({ name: b.querySelector('.cw-pi-l')?.textContent.replace(/^\S+\s+/, '').trim(), sub: b.querySelector('.cw-pi-s')?.textContent || '' })));
  },
  async pick(page, name, { newWindow = false } = {}) {   // a plain click on the row (or its ⧉)
    const rows = await pl.rows(page);
    const k = rows.findIndex(r => r.name === name);
    if (k < 0) { await page.keyboard.press('Escape'); return false; }
    await page.click(newWindow ? `.cw-pop-agents [data-new="${k}"]` : `.cw-pop-agents [data-k="${k}"]`);
    await sleep(900);
    return true;
  },
};

async function unified(view) {
  const from = logSize();
  const V = `unified ${view}:`;
  const { browser, page, errors } = await launch(view);
  try {
    await load(page);
    const mounted = await page.evaluate(() => !!window.voPL && typeof window.voPL.isLayerAgent === 'function');
    check(`${V} the copied layer is mounted`, mounted);
    if (!mounted) return;
    const layerAll = await page.evaluate(ids => ids.map(i => window.voPL.isLayerAgent(i)), [...AGENTS.map(a => a.id), OPENCLAW.id]);
    check(`${V} every office agent is a layer agent (one window for all)`, layerAll.every(Boolean), JSON.stringify(layerAll));

    // 1. open Codex in the copied window
    await page.evaluate(id => window.VirtualOfficeChat.openForAgent(id), AGENTS[0].id);
    await until(async () => (await pl.mark(page)) === 'Dex', 20000);
    check(`${V} Codex opens in the copied window (not the old one)`, (await pl.name(page)) === 'Dex' && !(await page.evaluate(() => !!document.querySelector('.chat-panel.open'))));
    const rows = await pl.rows(page); await page.keyboard.press('Escape');
    const want = [...AGENTS, OPENCLAW].map(a => a.name);
    check(`${V} the picker lists every provider's agent`, want.every(n => rows.some(r => r.name === n)), rows.map(r => `${r.name}/${r.sub.split(' · ').slice(0, 2).join('·')}`).join(', '));
    const dexRow = rows.find(r => r.name === 'Dex');
    check(`${V} provider label "Codex · This office"`, /Codex · This office/.test(dexRow?.sub || ''), dexRow?.sub);

    // 2. per provider, switched IN PLACE: send, stream, reply, tool step, thinking
    const before = await pl.count(page);
    await page.evaluate(() => { window.__toolPreview = []; window.addEventListener('vo:agent-tool-preview', e => window.__toolPreview.push(e.detail)); });
    for (const a of [...AGENTS, OPENCLAW]) {
      if ((await pl.name(page)) !== a.name) {
        const ok = await pl.pick(page, a.name);
        await pl.mark(page);
        check(`${V} picker switches to ${a.label} in place (same window count)`, ok && (await pl.name(page)) === a.name && (await pl.count(page)) === before, `name=${await pl.name(page)} windows=${await pl.count(page)}/${before}`);
      }
      const tag = `u-${RUN}-${view}-${a.id}`;
      await pl.send(page, `${tag}${a.tool ? ' [[tool]]' : ''}`);
      const re = new RegExp(`${a.reply.source}[\\s\\S]{0,40}${tag}|${tag}[\\s\\S]*${a.reply.source}`, 'i');
      const answered = await pl.waitText(page, re, 90000);
      check(`${V} ${a.label}: send and its answer shows`, answered, (await pl.text(page)).slice(-140));
      await pl.idle(page, 60000);
      if (a.tool) {
        const step = await page.evaluate(w => [...document.querySelectorAll(`${w} .cw-tstep`)].some(s => /echo fake-tool-ok|fake-tool-ok|bash|Bash|shell/i.test(s.textContent)), W);
        check(`${V} ${a.label}: its tool step shows`, step);
        // its input is the whole command, not the first fragment of a streaming input (Claude Code: {"partial": ...})
        const partial = await page.evaluate(w => [...document.querySelectorAll(`${w} .cw-tstep`)].some(s => /"partial"/.test(s.textContent)), W);
        check(`${V} ${a.label}: its tool step shows no partial input`, !partial);
        if (AGENTS.includes(a)) {
          // the office's Agent PC preview gets the step's arguments as an object (JSON text read back)
          // (start, or the update that carries an input still streaming at the start: Claude Code)
          const args = await page.evaluate(id => (window.__toolPreview || []).filter(d => d.agentId === id && d.phase !== 'result').map(d => d.tool.arguments), a.id);
          check(`${V} ${a.label}: tool preview carries the arguments as an object`, args.some(x => x && typeof x === 'object' && /fake-tool-ok/.test(JSON.stringify(x))), JSON.stringify(args).slice(0, 140));
        }
      }
      if (a.thinking) {
        const think = await page.evaluate(w => [...document.querySelectorAll(`${w} .cw-think`)].some(t => /Thinking about/.test(t.textContent)), W);
        check(`${V} ${a.label}: its thinking shows`, think);
      }
      if (a.sessions === false) {
        check(`${V} ${a.label}: no chat list / New chat (one conversation)`, !(await pl.visible(page, '.cw-new')) && !(await pl.visible(page, '.cw-side')));
        await pl.send(page, `u-${RUN}-${view}-second`);   // (its one conversation, now that it has one)
        const second = await pl.waitText(page, new RegExp(`${a.reply.source} u-${RUN}-${view}-second`), 90000);
        check(`${V} ${a.label}: a second turn shows its answer`, second, (await pl.text(page)).slice(-140));
        await pl.idle(page, 30000);
      }
      if (a.label === 'Codex') {
        // streaming: a slow answer is seen growing before it ends, then Stop ends it
        await pl.send(page, `u-${RUN}-${view}-slow [[slow]]`);
        const t0 = await pl.waitText(page, new RegExp(`u-${RUN}-${view}-slow[\\s\\S]*w3\\b`), 30000);
        const mid = await pl.text(page);
        await sleep(1200);
        const grew = (await pl.text(page)).length > mid.length && (await pl.busy(page));
        check(`${V} Codex: the answer streams (text grows while it runs)`, t0 && grew);
        await page.click(`${W} .cw-send.stop`).catch(() => {});
        const idle = await pl.idle(page, 20000);
        const all = await pl.text(page), mine = all.slice(all.lastIndexOf(`u-${RUN}-${view}-slow`));
        check(`${V} Codex: Stop ends the slow answer`, idle && !/\bw60\b/.test(mine), `idle=${idle} ${mine.slice(-120)}`);
        for (const [dec, re2] of [['allow-once', new RegExp(`Fake Codex reply \\d+: u-${RUN}-${view}-appr-allow-once`)], ['deny', /the command was declined/]]) {
          await pl.send(page, `u-${RUN}-${view}-appr-${dec} [[approval]]`);
          const card = await until(() => page.evaluate(([w, d]) => !!document.querySelector(`${w} .cw-appr-b [data-dec="${d}"]`), [W, dec]), 30000);
          if (card && dec === 'allow-once') {
            // Office Life's open options in the copied window: focus {approvalId} scrolls to that card and flashes it
            const apprId = await page.evaluate(w => [...document.querySelectorAll(`${w} [data-appr-id]`)].pop()?.dataset.apprId || '', W);
            await page.evaluate(([id, ap]) => window.VirtualOfficeChat.openForAgent(id, { focus: { approvalId: ap } }), [a.id, apprId]);
            const flashed = !!apprId && await until(() => page.evaluate(([w, ap]) => [...document.querySelectorAll(`${w} [data-appr-id]`)].some(el => el.dataset.apprId === ap && el.dataset.voFocus === 'true'), [W, apprId]), 8000, 100);
            check(`${V} Office Life focus: the approval card is scrolled to and flashed`, flashed, `id=${apprId}`);
          }
          if (card) await page.click(`${W} .cw-appr-b [data-dec="${dec}"]`);
          const done = card && await pl.waitText(page, re2, 40000);
          check(`${V} Codex approval ${dec}: the card shows and the answer follows`, done, `card=${card}`);
          await pl.idle(page, 30000);
        }
      }
    }
    check(`${V} still one window after every switch`, (await pl.count(page)) === before, `${await pl.count(page)}/${before}`);

    // 3. back to Codex: its chat (history) is there; then reload: last used + history
    await pl.pick(page, 'Dex'); await pl.mark(page);
    check(`${V} back on Codex its chat shows again`, (await pl.text(page)).includes(`u-${RUN}-${view}-codex-dex`));
    await load(page, { reload: true });
    const last = await page.evaluate(() => ({ last: window.voPL.lastUsed?.(), dex: window.voPL.layerIdFor?.('codex-dex'), raw: localStorage.getItem('vo.chat.last') }));
    check(`${V} vo.chat.last remembers Codex (per browser)`, !!last.last && last.last.agent === last.dex && /codex-dex/.test(last.raw || ''), JSON.stringify(last));
    await page.evaluate(() => document.querySelectorAll('.chat-back').forEach(b => b.querySelector('.cw-x')?.click()));
    await sleep(600);
    await page.click('#chat-toggle').catch(() => page.evaluate(() => document.getElementById('chat-toggle')?.click()));
    const reopened = await until(async () => (await pl.mark(page)) === 'Dex', 20000);
    check(`${V} Chat button reopens the last-used agent and chat (D's router)`, reopened, `front=${await pl.mark(page)} oldWindow=${await page.evaluate(() => !!document.querySelector('.chat-panel.open'))}`);
    if (!reopened) {   // (without D the Chat button is still the old router: C's own reopen, voPL.openRecent, is what it will call)
      await page.evaluate(() => { document.querySelectorAll('.chat-panel.open .chat-close').forEach(b => b.click()); return window.voPL.openRecent?.(); });
      const viaC = await until(async () => (await pl.mark(page)) === 'Dex', 20000);
      check(`${V} voPL.openRecent() reopens the last-used agent (C)`, viaC, `front=${await pl.mark(page)}`);
    }
    const hist = await pl.waitText(page, new RegExp(`u-${RUN}-${view}-codex-dex`), 20000);
    check(`${V} history after reload (the last-used chat shows its messages)`, hist);
    // the person's own words, not the office's delivery wrapper the provider stored ("[A2A from=user ...] Message from
    // User via ... Reply directly to the user ..."): Codex keeps it in thread/read, Claude Code in its session file
    const wrapped = await page.evaluate(w => [...document.querySelectorAll(`${w} .cw-thread .cw-msg`)].map(m => m.innerText).filter(t => /\[A2A from=user|Message from User via|Reply directly to the user/.test(t)).length, W);
    check(`${V} history shows the person's words, not the office's delivery wrapper`, hist && wrapped === 0, `wrapped bubbles=${wrapped}`);

    // 4. "+" and ⧉ are the only ways to a second window
    const n0 = await pl.count(page);
    await page.click(`${W} .cw-plus`).catch(() => {});
    await sleep(1200);
    check(`${V} "+" opens a new window`, (await pl.count(page)) === n0 + 1, `${n0} -> ${await pl.count(page)}`);
    await page.keyboard.press('Escape'); await sleep(300);
    await pl.mark(page);
    if (await pl.pick(page, 'Clara', { newWindow: true })) {
      check(`${V} ⧉ on a picker row opens a new window`, (await pl.count(page)) === n0 + 2, `${n0} -> ${await pl.count(page)}`);
    } else check(`${V} ⧉ on a picker row opens a new window`, false, 'row not found');
    await shot(page, `unified-${view}`);
    if (view === 'phone') {
      // phone (one window on screen): closing the window ⧉ / "+" opened brings back the one it put away; one the
      // person put away themselves stays away (no Escape here: on an empty new window it closes it)
      const closeFront = async () => { await pl.mark(page); await page.click(`${W} .cw-x`).catch(() => {}); await sleep(900); };
      const n1 = await pl.count(page);
      await closeFront();
      check(`${V} phone: closing the ⧉ window brings back the one it put away`, (await pl.count(page)) === n1 - 1 && (await pl.shown(page)) === 1, `windows=${await pl.count(page)} shown=${await pl.shown(page)}`);
      await closeFront();
      const back = await pl.mark(page);
      check(`${V} phone: closing the "+" window brings back the first (Dex)`, (await pl.shown(page)) === 1 && back === 'Dex', `shown=${await pl.shown(page)} front=${back}`);
      await page.click(`${W} .cw-min`).catch(() => {}); await sleep(600);
      await page.evaluate(() => window.voPL.newWindow()); await sleep(1500);
      await page.keyboard.press('Escape'); await sleep(300);
      await closeFront();
      check(`${V} phone: a window the person put away stays away when another closes`, (await pl.shown(page)) === 0 && (await pl.count(page)) === n1 - 2, `shown=${await pl.shown(page)} windows=${await pl.count(page)}`);
    }
    check(`${V} no page errors or 5xx`, errors.length === 0, errors.slice(0, 3).join(' | '));
    const tb = tracebacks(from);
    check(`${V} no server tracebacks`, tb.length === 0, tb.slice(0, 2).join(' | '));
  } finally { await browser.close(); }
}

(async () => {
  try {
    if (MODE === 'smoke' || MODE === 'all') await smoke();
    if (MODE === 'unified' || MODE === 'all') for (const v of VIEWS) await unified(v);
  } catch (e) { check(`run ${MODE}`, false, String(e && e.stack || e).slice(0, 300)); }
  const failed = results.filter(r => !r.ok).length;
  summary(`pl_office_chat ${MODE}`);
  process.exit(failed ? 1 : 0);
})();
