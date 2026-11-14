// v0.11 parity rows (docs/dev/PARITY-openclaw-hermes.md): the office's copy of the OpenClaw + Hermes layer driven against
// the labs only. Each PASS row that pl_chat.mjs / pl_menu.mjs do not cover has its check here.
// Setup (all on loopback or the docker0 address; ports are examples):
//   lab OpenClaw:  LAB=<lab> LAB_OC_PORT=<p> LAB_OC_STUB=<p+1> LAB_OC_BIND=172.17.0.1 tests/tools/lab-openclaw.sh start
//                  (section brw: also LAB_OC_BROWSER_CDP_URL=http://127.0.0.1:<cdp>: its browser attaches to this test's Chrome)
//   lab 2:         the same with LAB_OC_AUTH=password (section conn)
//   lab Hermes:    LAB=<hlab> LAB_PORT_A/B/STUB=... LAB_CWD=<dir> HERMES_LAB_SRC=... HERMES_STUB=... tests/tools/lab-hermes.sh start
//                  (section hsecret: a lab skill skills/plparity/plparity-secret needing PLPARITY_LAB_KEY in lab a's copy)
//   office:        PL_ROOT=<dir> PL_PORT=<q> PL_FIND=<lab urls> tests/tools/pl-office.sh start
//   passcode office (section passcode): PL_HOST=172.17.0.1 PL_PASSCODE=<code> tests/tools/pl-office.sh start
// Env: VO_URL, LAB_OC, LAB_OC_URL, LAB_OC_STUB, LAB_OC2, LAB_OC2_URL, VO_PASS_URL, VO_PASSCODE, VO_PASS_AUDIT (its
//   provider-audit.log), LAB_H, LAB_PORT_A, LAB_CWD, LAB_OC_BROWSER_PORT (<cdp>), S (scratch), PL_OUT.
// Usage: node tests/e2e/pl_parity.mjs <section|all>
// Sections: conn (Find, password auth, Chat only), passcode (the office passcode asked again, audit), ocx / ocy (the
//   OpenClaw window), agents (a gateway agent made / deleted), brw (the agent's browser: card, panel, frames), hx / hx2 /
//   hx3 (the Hermes window), hsecret (Hermes' masked secret dialog), hscreen (Hermes' Bot Desktop).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, summary, launch, open, api, sleep, providers, sameUrl, ensureOpenClaw, ensureHermes, labCli, LAB_OC_URL, VO } from './pl_lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] || 'all';
const LAB_OC2 = process.env.LAB_OC2 || '';
const LAB_OC2_URL = process.env.LAB_OC2_URL || '';
const VO_PASS_URL = process.env.VO_PASS_URL || '';
const VO_PASSCODE = process.env.VO_PASSCODE || '';
for (const u of [LAB_OC2_URL, VO_PASS_URL]) if (/:(8085|8088|8090|8095|8096|8097|8099|18789)\/?$/.test(u)) throw new Error(`refusing a real service ${u}`);

const lab2Cli = (...args) => spawnSync(path.join(HERE, '..', 'tools', 'lab-openclaw.sh'), ['cli', ...args], { encoding: 'utf8', timeout: 90000, env: { ...process.env, LAB: LAB_OC2 } });
const thread = page => page.evaluate(() => document.querySelector('.chat-back:not(.min) .cw-thread')?.innerText || '');
async function waitText(page, re, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const t = await thread(page); if (re.test(t)) return t; await sleep(300); }
  return null;
}
async function until(fn, ms = 60000, every = 700) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(every); }
}
/** Approve the newest pending device request on a lab gateway (cli: labCli or lab2Cli). */
function approveNewest(cli) {
  const listed = JSON.parse(cli('devices', 'list', '--json').stdout || '{}');
  const req = (listed.pending || []).slice(-1)[0];
  if (req) cli('devices', 'approve', req.requestId || req.id);
  return !!req;
}
async function sendIn(page, text) {
  await page.fill('.chat-back:not(.min) .cw-in', text);
  await page.keyboard.press('Enter');
}

// ---------------------------------------------------------------- 2.1 Find, password auth, Chat only (typed Add form)
async function conn() {
  if (!LAB_OC2 || !LAB_OC2_URL) { check('conn: LAB_OC2 / LAB_OC2_URL set (the password lab)', false); return; }
  await ensureOpenClaw();
  const pw = fs.readFileSync(path.join(LAB_OC2, 'password'), 'utf8').trim();
  for (const x of (await providers()).filter(q => sameUrl(q.config?.url, LAB_OC2_URL))) await api('/api/connections/remove', { method: 'POST', body: { id: x.id } });
  const { browser, page, errors } = await launch();
  try {
    await page.evaluate(() => window.voPL.openProviders('openclaw'));
    await page.waitForSelector('.ap-back .ap-add', { timeout: 20000 });
    await page.click('.ap-back .ap-add');
    await page.waitForSelector('.ap-back form.ap-form', { timeout: 8000 });
    await page.evaluate(() => document.querySelector('.ap-back .ap-kind[data-kind="openclaw"]')?.click());
    await page.fill('.ap-back .ap-label', 'Lab password');

    // Find: the office's places (VO_PL_FIND here) and the saved connections' addresses that answer as a gateway
    await page.click('.ap-back .ap-find');
    const found = await page.waitForSelector('.ap-back .ap-use', { timeout: 20000 }).then(() => page.$$eval('.ap-back .ap-use', b => b.map(x => x.dataset.url)), () => []);
    check('Find offers the gateways that answer (never a closed address)', found.some(u => sameUrl(u, LAB_OC2_URL)) && found.some(u => sameUrl(u, LAB_OC_URL)) && !found.some(u => /:9\/?$/.test(u)), found.join(' '));
    await page.evaluate(u => [...document.querySelectorAll('.ap-back .ap-use')].find(b => b.dataset.url.replace(/\/+$/, '') === u.replace(/\/+$/, ''))?.click(), LAB_OC2_URL);
    const typed = await page.inputValue('.ap-back #apf-url');
    check('Find: Use puts the address in the field', sameUrl(typed, LAB_OC2_URL), typed);

    // password sign-in + Chat only, typed in the form
    await page.selectOption('.ap-back #apf-auth', 'password');
    const vis = await page.evaluate(() => ({ pw: !!document.querySelector('.ap-back #apf-password')?.offsetParent, tok: !!document.querySelector('.ap-back #apf-token')?.offsetParent }));
    await page.fill('.ap-back #apf-password', pw);
    await page.selectOption('.ap-back #apf-access', 'chat');
    await page.click('.ap-back form.ap-form [type=submit]');
    let p = await until(async () => (await providers()).find(x => x.kind === 'openclaw' && sameUrl(x.config?.url, LAB_OC2_URL)), 15000);
    p = await until(async () => { const q = (await providers()).find(x => x.id === p?.id); return q && ['pairing', 'connected'].includes(q.status?.state) ? q : null; }, 60000);
    if (p?.status?.state === 'pairing') approveNewest(lab2Cli);
    p = await until(async () => { const q = (await providers()).find(x => x.id === p?.id); return q?.status?.state === 'connected' && (q.agents || []).length ? q : null; }, 90000);
    check('password field shows for "Gateway password" (token hidden)', vis.pw && !vis.tok, JSON.stringify(vis));
    check('password auth: the typed form pairs with a password gateway; the password is not kept', !!p && p.config.auth === 'password' && p.secrets?.password === false, JSON.stringify({ state: p?.status?.state, auth: p?.config?.auth, secrets: p?.secrets }));

    // Chat only: a setting change is refused, chat works
    const ch = p ? await api('/api/agent-providers/call', { method: 'POST', body: { id: p.id, method: 'agents.update', params: { agentId: 'ops', model: 'stub/stub-1' } } }) : { status: 0 };
    check('Chat only: a settings change is refused', p?.config?.access === 'chat' && ch.status >= 400 && ch.status < 500, `${ch.status} ${JSON.stringify(ch.body).slice(0, 140)}`);
    const ag = p ? ((await api('/api/pl/agents')).body?.agents || []).find(a => a.key === `prov-${p.id}-main`) : null;
    if (ag) {
      await page.evaluate(() => document.querySelector('.ap-back .ap-x, .ap-back [data-close]')?.click());
      await page.keyboard.press('Escape');
      await page.evaluate(id => window.voPL.openLayer(id, { newWindow: true }), ag.id);
      await page.waitForSelector('.chat-back:not(.min) .cw-in', { timeout: 15000 });
      await sendIn(page, 'hello from a chat only connection');
    }
    const said = ag ? await waitText(page, /stub reply: .*hello from a chat only connection/, 60000) : null;
    check('Chat only: chat still works', !!said, ag ? '' : 'no prov-<id>-main agent');
    check('no page errors / 5xx (conn)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- 2.1 the office passcode, asked again before a change
async function passcode() {
  if (!VO_PASS_URL || !VO_PASSCODE) { check('passcode: VO_PASS_URL / VO_PASSCODE set', false); return; }
  const { browser, page, errors } = await launch({ url: VO_PASS_URL, login: VO_PASSCODE });
  try {
    // (a browser session from 172.17.0.1: not loopback, so the layer's authAt is the session's last confirm, none yet)
    const me = await page.evaluate(async () => (await fetch('/api/pl/me')).json());
    check('passcode office: the layer sees a stale confirm (reauthLeftMs 0)', me && me.reauthLeftMs === 0, JSON.stringify(me).slice(0, 160));
    const token = fs.readFileSync(path.join(process.env.LAB_OC, 'token'), 'utf8').trim();
    // add the lab gateway through the page's own call (a connection is not a gateway setting: no confirm asked)
    const made = await page.evaluate(async ({ url, token }) => {
      const had = ((await (await fetch('/api/agent-providers')).json()).providers || []).find(x => x.kind === 'openclaw' && String(x.config?.url || '').replace(/\/+$/, '') === url.replace(/\/+$/, ''));
      if (had) return { status: 200, body: had };
      const csrf = (await (await fetch('/api/pl/me')).json()).csrf;
      const r = await fetch('/api/connections', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ kind: 'openclaw', label: 'Lab gateway', scope: 'installation', config: { url, auth: 'token', access: 'full' }, secrets: { token } }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { url: LAB_OC_URL, token });
    const id = made.body?.id;
    const state = async () => page.evaluate(async id => ((await (await fetch('/api/agent-providers')).json()).providers || []).find(x => x.id === id)?.status?.state, id);
    let s = await until(async () => { const v = await state(); return ['pairing', 'connected'].includes(v) ? v : null; }, 60000);
    if (s === 'pairing') approveNewest(labCli);
    s = await until(async () => (await state()) === 'connected', 90000);
    check('passcode office: lab gateway connected', made.status === 200 && !!s, `${made.status} ${JSON.stringify(made.body).slice(0, 120)}`);

    // a setting change from the copied menu -> 403 reauth_required -> the office passcode prompt -> retried -> lands
    await page.evaluate(id => window.voPL.openProviders(id), id);
    await page.waitForSelector('.ap-back .ap-tabs .tab[data-tab="agents"]', { timeout: 20000 });
    await page.click('.ap-back .ap-tabs .tab[data-tab="agents"]');
    await page.waitForSelector('.ap-back .op-row [data-do="model"]', { timeout: 20000 });
    await page.evaluate(() => { const r = [...document.querySelectorAll('.ap-back .op-row')].find(x => /\bops\b/.test(x.innerText)); r?.querySelector('[data-do="model"]')?.click(); });
    await page.waitForSelector('.ap-back .op-inline select', { timeout: 8000 });
    const pick = await page.evaluate(() => { const s = document.querySelector('.ap-back .op-inline select'); const o = [...s.options].find(x => !x.selected && x.value); if (!o) return null; s.value = o.value; return o.value; });
    await page.evaluate(() => document.querySelector('.ap-back .op-inline [type="submit"]').click());
    await page.waitForSelector('.ap-back .ap-confirm .ap-yes', { timeout: 8000 }).then(() => page.click('.ap-back .ap-confirm .ap-yes'), () => {});
    const asked = await page.waitForSelector('.vo-dialog input.vo-input[type="password"]', { timeout: 10000 }).then(() => true, () => false);
    if (asked) {
      await page.fill('.vo-dialog input.vo-input[type="password"]', VO_PASSCODE);
      await page.click('.vo-dialog .vo-btn--primary');
    }
    const opsModel = () => { try { const m = JSON.parse(labCli('config', 'get', 'agents.entries.ops', '--json').stdout || '{}').model; return typeof m === 'string' ? m : m?.primary ?? null; } catch { return null; } };
    const landed = pick ? await until(() => String(opsModel() || '').includes(pick), 20000, 1000) : false;
    const me2 = await page.evaluate(async () => (await fetch('/api/pl/me')).json());
    check('passcode asked again before a gateway change; confirmed -> the change lands', asked && !!landed && me2.reauthLeftMs > 0, `asked ${asked} pick ${pick} landed ${landed} left ${me2.reauthLeftMs}`);
    const auditFile = process.env.VO_PASS_AUDIT || '';
    const lines = auditFile && fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n') : [];
    const rec = lines.map(l => { try { return JSON.parse(l); } catch { return {}; } }).filter(x => x.event === 'provider.change' && x.method === 'agents.update');
    check('the change is in the office\'s provider-audit.log (which call, no values)', rec.length > 0 && !lines.some(l => /stub\/stub|lab-[0-9a-f]{8}|pw-[0-9a-f]{8}/.test(l)), `${rec.length} of ${lines.length} lines`);
    // (back to the default)
    await page.evaluate(async ({ id }) => {
      const csrf = (await (await fetch('/api/pl/me')).json()).csrf;
      await fetch('/api/agent-providers/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ id, method: 'agents.update', params: { agentId: 'ops', model: null } }) });
    }, { id });
    check('no page errors / 5xx (passcode)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- 2.2 the OpenClaw chat window
const W_ = '.chat-back:not(.min)';
async function idle(page, ms = 40000) {
  return until(() => page.evaluate(s => !document.querySelector(`${s} .cw-send.stop, ${s} .cw-send[aria-label*="Stop"]`), W_), ms, 300);
}
async function newChat(page) {
  for (let k = 0; k < 4; k++) {
    await page.evaluate(s => document.querySelector(`${s} .cw-new`)?.click(), W_);
    await sleep(1200);
    if (await page.evaluate(s => !document.querySelector(`${s} .cw-msg`), W_)) return true;
  }
  return false;
}
const lastMeta = page => page.evaluate(s => [...document.querySelectorAll(`${s} .cw-meta`)].pop()?.textContent || '', W_);
async function popupPick(page, opener, re) {
  await page.click(`${W_} ${opener}`);
  await sleep(400);
  return page.evaluate(src => {
    const rx = new RegExp(src, 'i');
    const items = [...document.querySelectorAll('.cw-pop [data-model], .cw-pop button, .pv-pop button')].filter(b => b.offsetParent);
    const b = items.find(x => rx.test(x.innerText.trim()));
    const labels = items.map(x => x.innerText.trim().split('\n')[0]);
    if (b) b.click();
    return { picked: b ? b.innerText.trim().split('\n')[0] : null, labels };
  }, re.source);
}
/** The lab gateway's exec approval policy: these defaults and no allowlist entries (each run starts clean; a run's
 *  "Always allow" is taken back by the next call). Answers the defaults it had. */
async function approvalPolicy(id, defaults) {
  const pol = (await api('/api/agent-providers/call', { method: 'POST', body: { id, method: 'exec.approvals.get' } })).body;
  const was = pol.file?.defaults || {};
  const set = await api('/api/agent-providers/call', { method: 'POST', body: { id, method: 'exec.approvals.set', params: { file: { version: 1, defaults: { ...was, ...defaults } }, baseHash: pol.hash } } });
  return { set: set.status, was };
}
async function ocx() {
  const lab = await ensureOpenClaw();
  const main = ((await api('/api/pl/agents')).body?.agents || []).find(a => a.key === `prov-${lab.id}-main`);
  const cid = main.provider.connectionId;
  const { browser, page, errors } = await launch();
  try {
    await page.evaluate(id => window.voPL.openLayer(id), main.id);
    await page.waitForSelector(`${W_} .cw-in`, { timeout: 15000 });
    await newChat(page);

    // model picker: the lab's two models; pick Stub Two
    const m = await popupPick(page, '.cw-model', /Stub Two/);
    await sleep(500);
    const ml = await page.evaluate(s => document.querySelector(`${s} .cw-model`)?.innerText.trim(), W_);
    // effort picker: the chosen model's own levels; pick High
    const e = await popupPick(page, '.cw-effort', /^High/);
    await sleep(500);
    const el = await page.evaluate(s => { const b = document.querySelector(`${s} .cw-effort`); return `${b?.querySelector('.cw-tool-lb')?.textContent || ''}${b?.classList.contains('hidden') ? ' (hidden)' : ''}`; }, W_);
    await sendIn(page, '[[model]] [[think:pondering the lab]] plparity picker');
    const said = await waitText(page, /stub reply \(([^,]+), ([^)]+)\): .*plparity picker/, 60000);
    await idle(page);
    const got = said ? /stub reply \(([^,]+), ([^)]+)\)/.exec(said) : null;
    check('model picker: the lab\'s models; Stub Two -> the gateway runs stub-2', m.labels.some(x => /Stub One/.test(x)) && m.picked && /Stub Two/.test(ml) && /stub-2/.test(got?.[1] || ''), `${m.labels.join(',')} | chip ${ml} | ran ${got?.[1]}`);
    // (the gateway keeps it as the session's thinkingLevel; the lab's OpenAI-style stub is not sent an effort field)
    const key = await page.evaluate(async ({ id }) => { const r = await (await fetch(`/api/chat/recent?agent=${id}`)).json(); return (r.sessions || [])[0]?.key || null; }, { id: main.id });
    const rowOf = k => { try { const t = labCli('gateway', 'call', 'sessions.list', '--json', '--params', JSON.stringify({ limit: 80 })).stdout; return (JSON.parse(t.slice(t.indexOf('{'))).sessions || []).find(r => r.key === k) || null; } catch { return null; } };
    const row = key ? rowOf(key) : null;
    check('effort picker: the model\'s levels; High lands as the session\'s thinking level', !!e.picked && /High/i.test(el) && row?.thinkingLevel === 'high' && row?.model === 'stub-2', `${e.labels.join(',')} | chip ${el} | gateway ${row?.model} ${row?.thinkingLevel}`);
    const think = await page.evaluate(s => [...document.querySelectorAll(`${s} .cw-think`)].map(x => x.textContent.replace(/\s+/g, ' ')).join(' | '), W_);
    check('thinking: the reasoning shows folded in the answer', /pondering the lab/.test(think), think.slice(0, 120));
    // (shown once the turn's totals are in the session: OpenClaw 2026.11 writes them just after the answer ends)
    const t0 = Date.now();
    await page.waitForFunction(s => { const b = document.querySelector(`${s} .cw-ctx`); return b && !b.classList.contains('hidden') && /of .*tokens/.test(b.title); }, W_, { timeout: 15000 }).catch(() => {});
    const ctx = await page.evaluate(s => { const b = document.querySelector(`${s} .cw-ctx`); return b ? { hidden: b.classList.contains('hidden'), title: b.title, txt: b.innerText.trim() } : null; }, W_);
    check('context meter: shown with the session\'s tokens of the model\'s window', ctx && !ctx.hidden && /of .*tokens/.test(ctx.title), `${JSON.stringify(ctx)} after ${Date.now() - t0} ms`);
    await page.click(`${W_} .cw-ctx`);
    await sleep(400);
    const cost = await page.evaluate(() => [...document.querySelectorAll('.cw-pop-ctx')].map(x => x.innerText).join(' '));
    await page.keyboard.press('Escape');
    check('cost: the chat\'s cost so far (OpenClaw estimatedCostUsd, or on 2026.11 after a first turn the transcript\'s) in the context meter', /Cost so far: (<\$0\.0001|\$\d)/.test(cost) && (row?.estimatedCostUsd > 0 || row?.totalTokensFresh === false),
      `${cost.replace(/\s+/g, ' ').slice(0, 120)} | gateway ${row?.estimatedCostUsd ?? `no total yet (fresh ${row?.totalTokensFresh}): the transcript's`}`);

    // approvals: Deny, then Always allow (allowlist, ask on a miss) -> the second run asks no more
    const pol = await approvalPolicy(cid, { security: 'allowlist', ask: 'on-miss' });
    try {
      await newChat(page);
      await sendIn(page, '[[exec:echo plparity-deny-me]] run it');
      const dc = await page.waitForSelector(`${W_} .cw-appr.prov.pending [data-dec="deny"]`, { timeout: 40000 }).then(() => true, () => false);
      if (dc) await page.click(`${W_} .cw-appr.prov.pending [data-dec="deny"]`);
      await idle(page, 60000);
      const t1 = await thread(page);
      check('approval: Deny -> the gateway refuses the command (user-denied)', dc && /Exec denied[^\n]*user-denied/.test(t1), t1.slice(-160));
      await newChat(page);
      await sendIn(page, '[[exec:echo plparity-always]] run it');
      const ac = await page.waitForSelector(`${W_} .cw-appr.prov.pending [data-dec="allow-always"]`, { timeout: 40000 }).then(() => true, () => false);
      if (ac) await page.click(`${W_} .cw-appr.prov.pending [data-dec="allow-always"]`);
      const ran1 = await waitText(page, /the command said:[^\n]*plparity-always/, 40000);
      await idle(page);
      await newChat(page);
      await sendIn(page, '[[exec:echo plparity-always]] again');
      const ran2 = await waitText(page, /the command said:[^\n]*plparity-always/, 40000);
      const asked2 = await page.evaluate(s => !!document.querySelector(`${s} .cw-appr.prov`), W_);
      check('approval: Always allow -> it runs, and the same command asks no more', ac && !!ran1 && !!ran2 && !asked2, `card ${ac} ran ${!!ran1} again ${!!ran2} asked ${asked2}`);
      await idle(page);
    } finally { await approvalPolicy(cid, { ...pol.was, security: pol.was.security, ask: pol.was.ask }); }

    // ask_user through the deferred tool_call wrapper: the question card, answered, the turn goes on
    await newChat(page);
    const q = { id: 'openclaw:core:ask_user', input: { questions: [{ header: 'Colour', id: 'colour', question: 'Which colour for the lab?', options: [{ label: 'Red (Recommended)' }, { label: 'Blue' }] }], timeoutSeconds: 120 } };
    await sendIn(page, `[[tool:tool_call ${JSON.stringify(q)}]]`);
    const qc = await page.waitForSelector(`${W_} .cw-q [data-a="q-opt"]`, { timeout: 40000 }).then(() => true, () => false);
    if (qc) {
      await page.evaluate(s => [...document.querySelectorAll(`${s} .cw-q [data-a="q-opt"]`)].find(b => /Blue/.test(b.innerText))?.click(), W_);
      await sleep(300);
      await page.evaluate(s => document.querySelector(`${s} [data-a="q-send"]`)?.click(), W_);
    }
    const qa = await waitText(page, /the tool said:[^\n]*Blue/, 40000);
    check('ask_user: the question card, answered (Blue), the turn goes on', qc && !!qa, (qa || await thread(page)).slice(-160));
    await idle(page);

    // progress card (tool_call -> progress_card): in the composer, shown as the inner tool, Refresh, then Dismiss when done
    await newChat(page);
    const pc = st => ({ id: 'openclaw:core:progress_card', input: { plan: [{ status: 'completed', step: 'Lab step one' }, { status: st, step: 'Lab step two' }] } });
    await sendIn(page, `[[tool:tool_call ${JSON.stringify(pc('in_progress'))}]]`);
    const card = await until(() => page.evaluate(s => { const c = document.querySelector(`${s} .cw-card:not(.hidden)`); return c && /Lab step/.test(c.innerText) ? c.innerText.replace(/\s+/g, ' ').slice(0, 120) : null; }, W_), 40000, 400);
    await idle(page);
    check('progress card in the composer (on step 2 of 2, both steps listed)', !!card && /2 of 2/.test(card) && /Lab step one/.test(card) && /Lab step two/.test(card), card);
    check('card tools through tool_call show as their card, never also as a step', !(await page.evaluate(s => /tool_call|progress_card/.test([...document.querySelectorAll(`${s} .cw-thread .cw-tsteps`)].map(x => x.textContent).join(' ')), W_)));
    // a deferred tool through the tool_call wrapper: the step is the inner tool, the wrapper is not shown
    const rf = await page.evaluate(s => { const b = document.querySelector(`${s} [data-a="card-refresh"]`); if (b) b.click(); return !!b; }, W_);
    await sleep(2500);
    const rfs = await page.evaluate(s => document.querySelector(`${s} .cw-card-st`)?.innerText || '', W_);
    check('progress card: Refresh', rf && !/fail|could not/i.test(rfs), `button ${rf} ${rfs}`);
    await sendIn(page, `[[tool:tool_call ${JSON.stringify(pc('completed'))}]]`);
    const dx = await page.waitForSelector(`${W_} [data-a="card-dismiss"]`, { timeout: 40000 }).then(() => true, () => false);
    await idle(page);
    if (dx) await page.click(`${W_} [data-a="card-dismiss"]`);
    const gone = dx ? await until(() => page.evaluate(s => !document.querySelector(`${s} .cw-card:not(.hidden)`), W_), 15000, 400) : false;
    check('progress card: Dismiss when every step is done', dx && !!gone, `dismiss ${dx} gone ${gone}`);
    await newChat(page);
    await sendIn(page, `[[tool:tool_call ${JSON.stringify({ id: 'openclaw:core:sessions_search', input: { query: 'plparity' } })}]]`);
    await waitText(page, /the tool said:/, 40000);
    await idle(page);
    const steps = await page.evaluate(s => [...document.querySelectorAll(`${s} .cw-thread .cw-tsteps .cw-tstep, ${s} .cw-thread .cw-steps .cw-step`)].map(x => (x.querySelector('.cw-tt')?.textContent || x.textContent).replace(/\s+/g, ' ').trim()), W_);
    check('deferred tool_call wrapper shown as the inner tool (sessions search, not "tool_call")', steps.length > 0 && steps.some(t => /session/i.test(t)) && !steps.some(t => /tool_call|tool call/i.test(t)), steps.join(' | '));
    check('no page errors / 5xx (ocx)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

const menuSeen = [];
async function itemMenu(page, sid, re) {
  await page.keyboard.press('Escape').catch(() => {});   // (a menu still open would only close on this click)
  await page.evaluate(({ s, sid }) => document.querySelector(`${s} .cw-item-more[data-more="${sid}"]`)?.click(), { s: W_, sid });
  await sleep(400);
  const r = await page.evaluate(src => { const rx = new RegExp(src, 'i'); const all = [...document.querySelectorAll('.cw-pop button')].filter(x => x.offsetParent); const b = all.find(x => rx.test(x.innerText.trim().split('\n')[0])); if (b) b.click(); return { ok: !!b, labels: all.map(x => x.innerText.trim().split('\n')[0]) }; }, re.source);
  if (!r.ok) menuSeen.push(`${re.source}: ${r.labels.join(',')}`);
  return r.ok;
}
async function voDialog(page, value = null) {
  // (the office's dialog: OK is primary, or danger for a delete)
  const btn = '.vo-dialog .vo-btn--primary, .vo-dialog .vo-btn--danger';
  const ok = await page.waitForSelector(btn, { timeout: 8000 }).then(() => true, () => false);
  if (ok && value !== null) await page.fill('.vo-dialog input.vo-input', value);
  if (ok) await page.click(btn);
  return ok;
}
const sideItems = page => page.evaluate(s => [...document.querySelectorAll(`${s} .cw-side .cw-item`)].map(x => ({ t: x.querySelector('.cw-item-t')?.textContent || '', w: x.classList.contains('working'), on: x.classList.contains('on') })), W_);
async function ocy() {
  const lab = await ensureOpenClaw();
  const main = ((await api('/api/pl/agents')).body?.agents || []).find(a => a.key === `prov-${lab.id}-main`);
  const recent = async () => ((await api(`/api/chat/recent?agent=${main.id}`)).body?.sessions || []);
  const gwRows = () => { try { const t = labCli('gateway', 'call', 'sessions.list', '--json', '--params', JSON.stringify({ limit: 120 })).stdout; return JSON.parse(t.slice(t.indexOf('{'))).sessions || []; } catch { return []; } };
  const { browser, page, errors } = await launch();
  try {
    await page.evaluate(id => window.voPL.openLayer(id), main.id);
    await page.waitForSelector(`${W_} .cw-in`, { timeout: 15000 });

    // steer: Enter while it works goes into the running turn (messages.queue), answered; the list shows it working
    await newChat(page);
    await sendIn(page, 'slow:6000 plparity steer base');
    await waitText(page, /\b3 4 5\b/, 20000);
    const ring = (await sideItems(page)).find(x => x.on)?.w;
    await sendIn(page, 'plparity steer change');
    const st = await waitText(page, /stub reply: [^\n]*plparity steer change/, 60000);
    await idle(page, 60000);
    check('send while working: Enter steers the running turn, answered', !!st, (await thread(page)).slice(-140));
    check('the chat list marks the chat working while it answers (ring)', ring === true, JSON.stringify((await sideItems(page)).slice(0, 3)));

    // edit and resend / regenerate: not for OpenClaw (as MVW: caps.rewrite false, its history is the gateway's and it has
    // no rewind call); the answer's own actions are there
    await newChat(page);
    await sendIn(page, 'plparity edit A');
    await waitText(page, /stub reply: [^\n]*plparity edit A/);
    await idle(page);
    const acts = await page.evaluate(s => [...document.querySelectorAll(`${s} .cw-thread [data-a]`)].map(b => b.dataset.a), W_);
    check('OpenClaw: no edit / regenerate offered (rewrite false, as MVW); copy is', !acts.includes('edit') && !acts.includes('regen') && acts.includes('copy'), [...new Set(acts)].join(','));

    // observe: a turn sent to this chat from another channel (the CLI, its own gateway client) shows live here
    const key = (await recent())[0]?.key;
    const sent = key ? labCli('gateway', 'call', 'chat.send', '--json', '--params', JSON.stringify({ sessionKey: key, message: 'plparity observed from the cli', idempotencyKey: `pp-${Date.now()}` })) : null;
    const ob = await waitText(page, /stub reply: [^\n]*plparity observed from the cli/, 40000);
    check('observe: a run from another channel shows live in the open chat', !!ob, `${key} ${sent?.status} ${(sent?.stderr || '').slice(0, 80)}`);
    await idle(page);

    // the chat list: search, rename, pin, move to a new project, export, delete
    // (the sidebar is a drawer: its button opens it)
    await page.evaluate(s => document.querySelector(`${s} .cw-burger`)?.click(), W_);
    await until(() => page.evaluate(s => getComputedStyle(document.querySelector(`${s} .cw-side`)).visibility === 'visible', W_), 5000, 200);
    const sid = await page.evaluate(s => document.querySelector(`${s} .cw-side .cw-item.on .cw-item-more`)?.dataset.more, W_);
    await page.evaluate(s => document.querySelector(`${s} .cw-nav[data-view="search"]`)?.click(), W_);
    await page.fill(`${W_} .cw-search input`, 'plparity edit');
    const hit = await page.waitForSelector(`${W_} .cw-item.hit`, { timeout: 10000 }).then(() => page.$eval(`${W_} .cw-item.hit`, x => x.innerText.replace(/\s+/g, ' ').slice(0, 80)), () => null);
    check('sidebar: search finds the chat by its words', !!hit, hit);
    await page.evaluate(s => document.querySelector(`${s} .cw-nav[data-view="search"]`)?.click(), W_);   // (again: back to the chats)
    await sleep(500);
    const rn = await itemMenu(page, sid, /^Rename/) && await voDialog(page, 'Lab renamed chat');
    const renamed = await until(async () => (await sideItems(page)).some(x => x.t === 'Lab renamed chat'), 8000, 400);
    const gwLabel = renamed ? await until(() => gwRows().find(r => r.key === key)?.label === 'Lab renamed chat', 15000, 1500) : false;
    check('sidebar: Rename (office dialog) -> the list and the gateway session', rn && !!renamed && !!gwLabel, `dialog ${rn} list ${renamed} gateway ${gwLabel}`);
    await itemMenu(page, sid, /^Pin to the top/);
    const pinned = await until(() => page.evaluate(s => /Pinned/.test(document.querySelector(`${s} .cw-side`)?.innerText || ''), W_), 8000, 400);
    check('sidebar: Pin to the top -> a Pinned group', !!pinned);
    await itemMenu(page, sid, /^Move to a project/);
    await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.cw-pop-move button')].find(b => /New project/.test(b.innerText))?.click());
    const pj = await voDialog(page, 'Lab project');
    const inProj = await until(async () => (await recent()).find(x => x.key === key)?.projectId || null, 8000, 500);
    check('sidebar: Move to a new project', pj && !!inProj, `dialog ${pj} project ${inProj}`);
    const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await itemMenu(page, sid, /^Export as Markdown/);
    const file = await dl;
    let md = '';
    if (file) { const fp = await file.path(); md = fp ? fs.readFileSync(fp, 'utf8') : ''; }
    check('sidebar: Export as Markdown (who said what)', /^# /.test(md) && /plparity edit A/.test(md) && /plparity observed from the cli/.test(md), md.slice(0, 80));
    await itemMenu(page, sid, /^Delete$/);
    const del = await voDialog(page);
    const goneList = await until(async () => !(await recent()).some(x => x.key === key), 10000, 500);
    const goneGw = goneList ? await until(() => !gwRows().some(r => r.key === key), 20000, 2000) : false;
    check('sidebar: Delete (office dialog) -> gone from the list and the gateway', del && !!goneList && !!goneGw, `dialog ${del} list ${goneList} gateway ${goneGw} ${menuSeen.join(' / ')}`);

    // attachments in: a text file through the composer reaches the gateway
    await newChat(page);
    const att = path.join(process.env.S || '/tmp', 'plparity-attach.txt');
    fs.writeFileSync(att, 'attach-token-7731 from the plparity lab\n');
    await page.setInputFiles(`${W_} input.cw-file`, att);
    const chip = await page.waitForSelector(`${W_} .cw-files .cw-file-chip`, { timeout: 10000 }).then(() => true, () => false);
    await sendIn(page, 'plparity attach [[find:plparity-attach]]');
    const ar = await waitText(page, /stub reply: found plparity-attach/, 40000);
    check('attachments in: a file sent from the composer reaches the gateway', chip && !!ar, (ar || await thread(page)).slice(-160));
    await idle(page);
    check('no page errors / 5xx (ocy)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- 3.2 the Hermes chat window (lab a)
async function hsend(page, text) {
  await page.fill(`${W_} .cw-in`, text);
  if (text.startsWith('/')) {   // (the / menu opens: Enter takes the command as written, the next Enter sends it)
    await page.waitForSelector('.cw-pop-cmds', { timeout: 4000 }).catch(() => {});
    if (await page.$('.cw-pop-cmds')) { await page.keyboard.press('Enter'); await sleep(200); }
    await page.evaluate(({ s, t }) => { const i = document.querySelector(`${s} .cw-in`); if (i.value.trim() !== t) { i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); } }, { s: W_, t: text });
  }
  await page.keyboard.press('Enter');
}
async function hx() {
  const hm = await ensureHermes();
  const ag = ((await api('/api/pl/agents')).body?.agents || []).find(a => a.key === `prov-${hm.id}-default`);
  const { browser, page, errors } = await launch();
  try {
    await page.evaluate(id => window.voPL.openLayer(id), ag.id);
    await page.waitForSelector(`${W_} .cw-in`, { timeout: 15000 });
    await newChat(page);
    await hsend(page, '[[tools]] plparity tools');
    const tools = await waitText(page, /tools?:?[^\n]*(terminal|todo)/i, 40000);
    await idle(page);
    console.log('hermes tools:', (tools || '').split('\n').filter(l => /todo|terminal/.test(l)).join(' ').slice(0, 400));

    const offered = (tools || '').includes('todo_list');
    // delegation: delegate_task -> its card per child, the subagents strip
    await newChat(page);
    await hsend(page, `[[tool:delegate_task ${JSON.stringify({ goal: 'plparity child task', context: 'a lab check' })}]] delegate it`);
    const subs = await until(() => page.evaluate(s => { const x = document.querySelector(`${s} .hv-subs, ${s} .hv-deleg`); return x ? x.textContent.replace(/\s+/g, ' ').slice(0, 120) : null; }, W_), 60000, 400);
    await idle(page, 90000);
    const deleg = await page.evaluate(s => document.querySelector(`${s} .hv-deleg`)?.textContent.replace(/\s+/g, ' ').slice(0, 120) || null, W_);
    check('Hermes: subagents strip while the child works', !!subs, subs);
    check('Hermes: delegation card per child', !!deleg && /plparity child task/.test(deleg), deleg);

    // side question /btw, background /bg: answered later, beside the chat
    await newChat(page);
    await hsend(page, 'plparity before btw');
    await waitText(page, /to: plparity before btw/); await idle(page);
    await hsend(page, '/btw plparity side question');
    const btw = await waitText(page, /plparity side question/, 40000);
    check('Hermes: /btw side question answered beside the chat', !!btw && !/to: \/btw/.test(btw), (btw || '').slice(-140));
    await hsend(page, '/bg plparity background job');
    const bg = await waitText(page, /plparity background job/, 60000);
    check('Hermes: /bg background task answered later', !!bg, (bg || '').slice(-140));
    await idle(page);

    // attachments in, media out
    await newChat(page);
    const att = path.join(process.env.S || '/tmp', 'plparity-hattach.txt');
    fs.writeFileSync(att, 'hattach-token-8812 from the plparity lab\n');
    await page.setInputFiles(`${W_} input.cw-file`, att);
    await page.waitForSelector(`${W_} .cw-files .cw-file-chip`, { timeout: 10000 }).catch(() => {});
    await hsend(page, 'plparity hermes attach');
    const hat = await waitText(page, /hattach-token-8812|plparity-hattach/, 40000);
    await idle(page);
    check('Hermes: a file attached from the composer reaches Hermes', !!hat, (hat || await thread(page)).slice(-140));
    const pic = path.join(process.env.S || '/tmp', 'plparity-pic.png');
    fs.writeFileSync(pic, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMAAAA0MAQH2oN6dAAAAAElFTkSuQmCC', 'base64'));
    await newChat(page);
    await hsend(page, `[[media:${pic}]] plparity picture`);
    const img = await until(() => page.evaluate(s => { const i = [...document.querySelectorAll(`${s} .cw-thread img`)].find(x => x.complete && x.naturalWidth > 0); return i ? { src: i.getAttribute('src').slice(0, 60), w: i.naturalWidth } : null; }, W_), 40000, 500);
    await idle(page);
    check('Hermes: media out (MEDIA: line) shows the picture, no disk path', !!img && !img.src.includes(pic), JSON.stringify(img));

    // model + reasoning pickers, usage
    await newChat(page);
    const m = await popupPick(page, '.cw-model', /Stub Two|stub-2/);
    await sleep(500);
    const e = await popupPick(page, '.cw-effort', /^High/);
    await sleep(500);
    await hsend(page, 'plparity hermes pickers');
    await waitText(page, /to: plparity hermes pickers/, 40000);
    await idle(page);
    const chips = await page.evaluate(s => ({ m: document.querySelector(`${s} .cw-model .cw-tool-lb`)?.textContent, e: document.querySelector(`${s} .cw-effort .cw-tool-lb`)?.textContent }), W_);
    const meta = await lastMeta(page);
    check('Hermes: model picker (Hermes\' model options) -> the turn runs on it', !!m.picked && /stub-2|Stub Two/i.test(`${chips.m} ${meta}`), `${m.labels.join(',')} | chip ${chips.m} | ${meta}`);
    check('Hermes: reasoning picker sets the chat\'s effort', !!e.picked && /High/i.test(chips.e || ''), `${e.labels.join(',')} | chip ${chips.e}`);
    await hsend(page, '/usage');
    const usage = await waitText(page, /token|usage|context/i, 30000);
    await idle(page);
    check('Hermes: /usage answers with the session\'s usage', !!usage, (usage || '').slice(-140));
    // (the todo list needs a Hermes that offers its todo_list tool to the chat's session: this lab's does not)
    if (!offered) console.log('SKIP Hermes todo list: the lab Hermes offers no todo_list tool to the session');
    check('no page errors / 5xx (hx)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- 2.4 a gateway agent made / deleted: it joins / retires
async function agents() {
  const lab = await ensureOpenClaw();
  const plAgents = async () => (await api('/api/pl/agents')).body?.agents || [];
  const roster = async () => (await api('/agents-list')).body?.agents || [];
  const key = `prov-${lab.id}-lab-temp`;
  await api('/api/agent-providers/call', { method: 'POST', body: { id: lab.id, method: 'agents.delete', params: { agentId: 'lab-temp', deleteFiles: true } } });
  const made = await api('/api/agent-providers/call', { method: 'POST', body: { id: lab.id, method: 'agents.create', params: { name: 'Lab Temp' } } });
  const joined = await until(async () => (await plAgents()).find(a => a.key === key) || null, 30000, 1000);
  const inRoster = joined ? await until(async () => (await roster()).some(r => r.key === key || (r.providerAgentId === 'lab-temp')), 5000, 1000) : false;
  // (the office roster lists layer agents that have an office id: the roster is the C4 roster work's; shown, not asserted)
  check('a new gateway agent joins the layer (the copied window\'s agents)', made.status === 200 && !!joined, `create ${made.status} layer ${joined?.key} office roster ${inRoster}`);
  const del = await api('/api/agent-providers/call', { method: 'POST', body: { id: lab.id, method: 'agents.delete', params: { agentId: 'lab-temp', deleteFiles: true } } });
  const retired = await until(async () => !(await plAgents()).some(x => x.key === key), 30000, 1000);
  const offRoster = !(await roster()).some(r => r.key === key || r.providerAgentId === 'lab-temp');
  check('a deleted gateway agent retires (switched off in the layer, its chats kept; not in the roster)', del.status === 200 && !!retired && offRoster, `delete ${del.status} layer ${retired} roster ${!offRoster}`);
}

async function hx2() {
  const hm = await ensureHermes();
  const list = (await api('/api/pl/agents')).body?.agents || [];
  const def = list.find(a => a.key === `prov-${hm.id}-default`), scout = list.find(a => a.key === `prov-${hm.id}-scout`);
  const { browser, page, errors } = await launch();
  try {
    void scout;
    await page.evaluate(id => window.voPL.openLayer(id), def.id);
    await page.waitForSelector(`${W_} .cw-in`, { timeout: 15000 });
    // the waiting row while the provider has not started (a model that takes its time)
    await newChat(page);
    await hsend(page, '[[delay:6000]] plparity slow start');
    const wait = await until(() => page.evaluate(s => { const w = document.querySelector(`${s} .hv-act:not([hidden])`); return w ? w.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) || 'shown' : null; }, W_), 9000, 250);
    await waitText(page, /to: plparity slow start/, 30000);
    await idle(page);
    check('Hermes: the activity row while the provider has not started (with its time)', !!wait, wait);

    // Refresh the last answer; Restore checkpoint on the first prompt
    const nOf = t => [...t.matchAll(/Stub reply (\d+) to: plparity slow start/g)].map(m => +m[1]);
    const before = nOf(await thread(page));
    await page.evaluate(s => [...document.querySelectorAll(`${s} [data-a="hv-refresh"]`)].pop()?.click(), W_);
    const after = await until(async () => { const n = nOf(await thread(page)); return n.length && n[n.length - 1] > (before[before.length - 1] || 0) ? n : null; }, 40000, 500);
    await idle(page);
    check('Hermes: Refresh -> the last answer again (a new one in its place)', !!after && after.length === 1, `${before.join(',')} -> ${(after || []).join(',')}`);
    await hsend(page, 'plparity second prompt');
    await waitText(page, /to: plparity second prompt/, 30000); await idle(page);
    await page.evaluate(s => { const m = document.querySelector(`${s} .cw-msg.user`); m?.querySelector('[data-a="hv-restore"]')?.click(); }, W_);
    const cf = await page.waitForSelector(`${W_} .hv-ovl.confirm [data-v="1"]`, { timeout: 5000 }).then(() => true, () => false);
    if (cf) await page.click(`${W_} .hv-ovl.confirm [data-v="1"]`);
    const restored = await until(async () => { const t = await thread(page); return !/plparity second prompt/.test(t) && /to: plparity slow start/.test(t) ? true : null; }, 40000, 500);
    await idle(page);
    check('Hermes: Restore checkpoint -> later turns removed, the prompt runs again', cf && !!restored, (await thread(page)).replace(/\s+/g, ' ').slice(-140));

    // @ references: @file: lists the chat folder's files; the reference goes with the prompt
    const cwd = process.env.LAB_CWD || '';
    if (cwd) fs.writeFileSync(path.join(cwd, 'plparity-ref.txt'), 'ref-token-5521 from the plparity lab\n');
    await newChat(page);
    await sleep(1000);
    await page.fill(`${W_} .cw-in`, 'look at @file:plpar');
    await sleep(1500);
    const sug = await until(() => page.evaluate(() => { const l = [...document.querySelectorAll('.cw-pop [data-k]')].map(x => x.innerText.trim().split('\n')[0]); return l.length ? l : null; }), 10000, 300);
    if ((sug || []).some(x => /plparity-ref/.test(x))) { await page.keyboard.press('Enter'); await sleep(300); }
    const val = await page.inputValue(`${W_} .cw-in`);
    await page.keyboard.press('Enter');
    const refAns = await waitText(page, /to: look at @file:plparity-ref\.txt/, 40000);
    await idle(page);
    check('Hermes: @file: suggests the chat folder\'s file; the reference is sent', (sug || []).some(x => /plparity-ref/.test(x)) && /@file:plparity-ref\.txt/.test(val) && !!refAns, `${(sug || []).join(', ')} | ${val}`);
    check('no page errors / 5xx (hx2)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

/** A second Hermes client (as Hermes Desktop): its own WebSocket to the lab backend, a prompt into a session. */
async function hermesClient(token, sessionId, text) {
  const { createRequire } = await import('node:module');
  const WS = createRequire(import.meta.url)(path.join(HERE, '..', '..', 'app', 'provider-layer', 'node_modules', 'ws'));
  const base = (process.env.LAB_PORT_A ? `ws://127.0.0.1:${process.env.LAB_PORT_A}` : '') + '/api/ws';
  return new Promise((resolve) => {
    const ws = new WS(`${base}?token=${encodeURIComponent(token)}`);
    let id = 0, buf = '';
    const pending = new Map();
    const call = (method, params) => new Promise((ok, no) => { const k = ++id; pending.set(k, { ok, no }); ws.send(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
    const end = r => { try { ws.close(); } catch { /* gone */ } resolve(r); };
    const t = setTimeout(() => end({ ok: false, error: 'timeout' }), 30000);
    ws.on('message', async d => {
      buf += String(d);
      for (let i; (i = buf.indexOf('\n')) >= 0 || (buf.trim().startsWith('{') && (i = buf.length));) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let f; try { f = JSON.parse(line); } catch { continue; }
        if (f.id && pending.has(f.id)) { const p = pending.get(f.id); pending.delete(f.id); f.error ? p.no(new Error(f.error.message)) : p.ok(f.result); continue; }
        if (f.method === 'event' && f.params?.type === 'gateway.ready') {
          try {
            // (as Desktop: resume the stored session; the live id it answers is the one prompts go to)
            const live = await call('session.resume', { session_id: sessionId, omit_messages: true });
            const sid = live?.session_id || sessionId;
            const r = await call('prompt.submit', { session_id: sid, text });
            clearTimeout(t); setTimeout(() => end({ ok: true, r }), 8000);
          } catch (e) { clearTimeout(t); end({ ok: false, error: e.message }); }
        }
      }
    });
    ws.on('error', e => { clearTimeout(t); end({ ok: false, error: e.message }); });
  });
}
async function hx3() {
  const hm = await ensureHermes();
  const token = fs.readFileSync(path.join(process.env.LAB_H, 'a', 'session-token'), 'utf8').trim();
  // Chat only: a second connection to the same backend, Chat only: its agents listed, a settings change refused
  for (const x of (await providers()).filter(q => q.kind === 'hermes' && q.config?.access === 'chat')) await api('/api/connections/remove', { method: 'POST', body: { id: x.id } });
  const co = await api('/api/connections', { method: 'POST', body: { kind: 'hermes', label: 'Lab Hermes chat only', scope: 'installation', config: { url: `http://127.0.0.1:${process.env.LAB_PORT_A}`, auth: 'token', access: 'chat' }, secrets: { token } } });
  const coP = await until(async () => { const q = (await providers()).find(x => x.id === co.body?.id); return q?.status?.state === 'connected' && (q.agents || []).length ? q : null; }, 60000);
  const w = coP ? await api('/api/agent-providers/call', { method: 'POST', body: { id: coP.id, method: 'config.patch', params: { set: { 'display.compact': true } } } }) : { status: 0 };
  check('Hermes Chat only: its agents listed; a settings change refused', !!coP && w.status === 403, `${coP?.agents?.length} agents | ${w.status} ${JSON.stringify(w.body).slice(0, 120)}`);
  if (co.body?.id) await api('/api/connections/remove', { method: 'POST', body: { id: co.body.id } });

  const ag = ((await api('/api/pl/agents')).body?.agents || []).find(a => a.key === `prov-${hm.id}-default`);
  const { browser, page, errors } = await launch();
  try {
    await page.evaluate(id => window.voPL.openLayer(id), ag.id);
    await page.waitForSelector(`${W_} .cw-in`, { timeout: 15000 });
    await newChat(page);
    await hsend(page, 'plparity observe base');
    await waitText(page, /to: plparity observe base/, 40000); await idle(page);
    // observe: a prompt from another Hermes client into this chat shows live here
    const key = ((await api(`/api/chat/recent?agent=${ag.id}`)).body?.sessions || [])[0]?.key;
    const other = key ? await hermesClient(token, key, 'plparity from another client') : { ok: false, error: 'no key' };
    const ob = await waitText(page, /to: plparity from another client/, 30000);
    check('Hermes: a turn from another client shows live in the open chat', other.ok && !!ob, `${key} ${other.error || ''}`);
    await idle(page);

    // sidebar marks: the chat waiting for the person (a question) is marked, with its age
    await hsend(page, '[[tool:clarify {"questions":[{"question":"Which lab colour?","choices":["Red","Blue"]}]}]] ask me');
    await page.waitForSelector(`${W_} .hv-cl`, { timeout: 40000 }).catch(() => {});
    await page.evaluate(s => document.querySelector(`${s} .cw-burger`)?.click(), W_);
    await sleep(800);
    const mark = await until(() => page.evaluate(s => { const i = document.querySelector(`${s} .cw-side .cw-item.on`); return i ? { waiting: i.classList.contains('waiting'), working: i.classList.contains('working'), ago: i.querySelector('.cw-item-ago')?.textContent || '' } : null; }, W_).then(m => (m && m.waiting ? m : null)), 10000, 400);
    check('Hermes sidebar: the chat waiting for an answer is marked (and its age shown)', !!mark && mark.waiting, JSON.stringify(mark));
    await page.evaluate(s => document.querySelector(`${s} .cw-burger`)?.click(), W_);
    await page.keyboard.press('Escape');   // (the question: skipped)
    await page.evaluate(s => [...document.querySelectorAll(`${s} .hv-cl button`)].find(b => /skip|cancel/i.test(b.innerText))?.click(), W_);
    await idle(page, 30000);

    // background tasks in the side panel: Hermes' subagents and cron, this chat and all of the agent's
    await hsend(page, `[[tool:delegate_task ${JSON.stringify({ goal: 'plparity panel child', context: 'a lab check' })}]] delegate it`);
    await waitText(page, /plparity panel child/, 60000); await idle(page, 60000);
    await page.evaluate(s => document.querySelector(`${s} .cw-dockb`)?.click(), W_);
    const dock = await until(() => page.evaluate(() => { const d = document.querySelector('.cw-dock'); const t = d?.innerText.replace(/\s+/g, ' ') || ''; return /plparity panel child|FINISHED \(\d+\)|RUNNING \(\d+\)/i.test(t) ? t.slice(0, 160) : null; }), 15000, 500);
    const dockText = dock || await page.evaluate(() => (document.querySelector('.cw-dock')?.innerText || 'no .cw-dock').replace(/\s+/g, ' ').slice(0, 200));
    check('Hermes: background tasks side panel (subagents, scheduled jobs)', !!dock && !/could not|failed/i.test(dock), dockText);

    // reconnect: the lab backend restarts under an open chat; the connection comes back and the chat goes on
    const r = spawnSync(path.join(HERE, '..', 'tools', 'lab-hermes.sh'), ['restart', 'a'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, LAB: process.env.LAB_H } });
    const back = await until(async () => (await providers()).find(x => x.id === hm.id)?.status?.state === 'connected', 60000, 1000);
    await hsend(page, 'plparity after the restart');
    const again = await waitText(page, /to: plparity after the restart/, 60000);
    check('Hermes: reconnects by itself after its backend restarts; the chat goes on', r.status === 0 && !!back && !!again, `restart ${r.status} back ${back} again ${!!again}`);
    await idle(page);
    check('no page errors / 5xx (hx3)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- 2.2 / 2.4 the agent's browser (one Chrome: the lab gateway's
// browser profile attaches to this test's own headless Chrome, lab-openclaw.sh LAB_OC_BROWSER_CDP_URL=http://127.0.0.1:<port>)
async function brw() {
  const port = Number(process.env.LAB_OC_BROWSER_PORT || 0);
  if (!port) { check('brw: LAB_OC_BROWSER_PORT set (the lab browser attaches there)', false); return; }
  const lab = await ensureOpenClaw();
  const main = ((await api('/api/pl/agents')).body?.agents || []).find(a => a.key === `prov-${lab.id}-main`);
  const { browser, page, errors } = await launch({ args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
  try {
    await page.evaluate(id => window.voPL.openLayer(id), main.id);
    await page.waitForSelector(`${W_} .cw-in`, { timeout: 15000 });
    await newChat(page);
    // (a lab page on loopback: the lab stub's model list; the card is for http(s) tabs, as OpenClaw's Control UI)
    const pageUrl = `http://127.0.0.1:${process.env.LAB_OC_STUB}/v1/models`;
    await sendIn(page, `[[tool:tool_call ${JSON.stringify({ id: 'openclaw:browser:browser', input: { action: 'open', url: pageUrl } })}]] open a tab`);
    await waitText(page, /the tool said:/, 60000);
    await idle(page);
    const card = await until(() => page.evaluate(s => { const c = document.querySelector(`${s} .cw-thread .cw-btab`); return c ? { url: c.dataset.url, text: c.innerText.replace(/\s+/g, ' ').slice(0, 80), open: !!c.querySelector('[data-a="btab-open"]') } : null; }, W_), 15000, 500);
    check('browser card in the chat (the tab the agent opened, Open in panel)', !!card && card.open, JSON.stringify(card));

    // the side panel's browser: the tab, live
    if (card) await page.evaluate(s => document.querySelector(`${s} .cw-btab [data-a="btab-open"]:not([hidden])`)?.click(), W_);
    const view = await until(() => page.evaluate(() => { const i = document.querySelector('.cw-dock .cw-bw-img'); return i && i.naturalWidth > 0 ? { w: i.naturalWidth, h: i.naturalHeight } : null; }), 20000, 500);
    check('agents\' browser panel: the tab live in the side panel', !!view, JSON.stringify(view) || await page.evaluate(() => (document.querySelector('.cw-dock')?.innerText || 'no dock').replace(/\s+/g, ' ').slice(0, 140)));

    // the live stream: a new picture after the page changes (frames through the office, never the CDP port)
    const tabs = (await api(`/api/providers/browser?agent=${main.id}`)).body;
    const tab = (tabs?.tabs || []).find(t => /\/v1\/models/.test(t.url || ''))?.id;
    const frame = async after => { const r = await fetch(`${VO}/api/providers/browser/frame?agent=${main.id}&tab=${encodeURIComponent(tab)}&after=${after}`); return { status: r.status, seq: Number(r.headers.get('x-frame-seq') || 0), type: r.headers.get('content-type') || '', bytes: (await r.arrayBuffer()).byteLength }; };
    const f1 = tab ? await frame(0) : null;
    const act = tab ? await api('/api/providers/browser', { method: 'POST', body: { agent: main.id, action: 'reload', tab } }) : null;
    const f2 = tab ? await frame(f1.seq) : null;
    check('live browser stream: JPEG frames through the office, a new one after the page changes', tabs?.running && f1?.status === 200 && /jpeg/.test(f1.type) && act?.status === 200 && f2?.status === 200 && f2.seq > f1.seq, `tabs ${tabs?.tabs?.length} f1 ${JSON.stringify(f1)} act ${act?.status} f2 ${JSON.stringify(f2)}`);
    check('no page errors / 5xx (brw)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- 3.2 Hermes' masked secret dialog (a lab skill needing a key)
async function hsecret() {
  const hm = await ensureHermes();
  const home = path.join(process.env.LAB_H, 'a', 'home');
  if (!fs.existsSync(path.join(home, 'skills', 'plparity', 'plparity-secret', 'SKILL.md'))) { check('hsecret: the lab skill plparity-secret is in lab a\'s copy', false); return; }
  const ag = ((await api('/api/pl/agents')).body?.agents || []).find(a => a.key === `prov-${hm.id}-default`);
  const value = `plparity-secret-${Date.now().toString(36)}`;
  const { browser, page, errors } = await launch();
  try {
    await page.evaluate(id => window.voPL.openLayer(id), ag.id);
    await page.waitForSelector(`${W_} .cw-in`, { timeout: 15000 });
    await newChat(page);
    await hsend(page, '[[tool:skill_view {"name":"plparity-secret"}]] load the lab skill');
    const dlg = await page.waitForSelector(`${W_} .hv-dlg input.hv-dlg-in[type="password"]`, { timeout: 40000 }).then(() => true, () => false);
    const head = dlg ? await page.evaluate(s => document.querySelector(`${s} .hv-dlg`)?.innerText.replace(/\s+/g, ' ').slice(0, 120), W_) : '';
    if (dlg) { await page.fill(`${W_} .hv-dlg input.hv-dlg-in`, value); await page.click(`${W_} .hv-dlg [data-a="hv-dlg-send"]`); }
    await waitText(page, /the tool said|Stub reply \d+ to:[^\n]*(skill|plparity)/i, 40000);
    await idle(page);
    const shown = await page.evaluate(v => document.documentElement.outerHTML.includes(v), value);
    const env = fs.existsSync(path.join(home, '.env')) ? fs.readFileSync(path.join(home, '.env'), 'utf8') : '';
    check('Hermes: a secret request -> the masked dialog (named), the value reaches Hermes and is never shown in the page', dlg && /PLPARITY_LAB_KEY|Secret/i.test(head) && !shown && env.includes(value), `dialog ${dlg} "${head}" | shown ${shown} | stored ${env.includes(value)}`);
    check('no page errors / 5xx (hsecret)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- 3.4 Hermes' Bot Desktop (Xvnc on a 0600 Unix socket, no TCP)
async function hscreen() {
  const hm = await ensureHermes();
  const ag = ((await api('/api/pl/agents')).body?.agents || []).find(a => a.key === `prov-${hm.id}-default`);
  const scr = async () => (await api(`/api/providers/screen?agent=${ag.id}`)).body || {};
  const { browser, page, errors } = await launch();
  try {
    await page.evaluate(id => window.voPL.openLayer(id), ag.id);
    await page.waitForSelector(`${W_} .cw-in`, { timeout: 15000 });
    await page.evaluate(s => document.querySelector(`${s} .cw-dockb`)?.click(), W_);
    await page.waitForSelector('.cw-dock [data-dock="screen"]', { timeout: 10000 });
    await page.click('.cw-dock [data-dock="screen"]');
    await page.waitForSelector('.cw-dock .psc-bar', { timeout: 10000 });
    if (await page.$('.cw-dock [data-s="start"]:not([hidden])')) await page.click('.cw-dock [data-s="start"]');
    const up = await until(async () => (await scr()).running === true, 90000, 1500);
    // the live picture: noVNC's canvas in the panel, drawn (not one flat colour)
    const live = await until(() => page.evaluate(() => {
      const c = document.querySelector('.cw-dock .psc-cv canvas'); if (!c || !c.width) return null;
      try { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 997) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); return seen.size > 3 ? { w: c.width, h: c.height, colours: seen.size } : null; } catch (e) { return { w: c.width, h: c.height, err: e.message }; }
    }), 40000, 1000);
    const th = await fetch(`${VO}/api/providers/screen/thumb?agent=${ag.id}`);
    const thumb = { status: th.status, type: th.headers.get('content-type') || '', bytes: (await th.arrayBuffer()).byteLength };
    check('Hermes Bot Desktop: started from the side panel, live in it (noVNC through the office relay)', !!up && !!live && !live.err, `running ${up} ${JSON.stringify(live)}`);
    check('Hermes Bot Desktop: a thumbnail through the office', thumb.status === 200 && /jpeg|png/.test(thumb.type) && thumb.bytes > 500, JSON.stringify(thumb));
    // take over / hand back (Hermes' display lease: only the holder types)
    await page.waitForSelector('.cw-dock [data-s="take"]:not([hidden])', { timeout: 15000 }).catch(() => {});
    await page.click('.cw-dock [data-s="take"]').catch(() => {});
    const mine = await until(async () => (await scr()).mine === true, 15000, 800);
    await page.waitForSelector('.cw-dock [data-s="release"]:not([hidden])', { timeout: 10000 }).catch(() => {});
    await page.click('.cw-dock [data-s="release"]').catch(() => {});
    const back = await until(async () => { const x = await scr(); return x.mine === false && x.holder === 'agent'; }, 15000, 800);
    check('Hermes Bot Desktop: Take over -> the person holds it; Hand back -> the agent again', !!mine && !!back, `mine ${mine} back ${back}`);
    // off again (the office's own confirm dialog)
    await page.click('.cw-dock [data-s="stop"]').catch(() => {});
    const asked = await voDialog(page);
    const off = await until(async () => (await scr()).running === false, 40000, 1500);
    check('Hermes Bot Desktop: turned off (office confirm)', asked && !!off, `asked ${asked} off ${off}`);
    check('no page errors / 5xx (hscreen)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    if ((await scr()).running) await api('/api/providers/screen', { method: 'POST', body: { agent: ag.id, action: 'stop' } });
  }
}

const sections = { conn, passcode, ocx, ocy, hx, agents, hx2, hx3, brw, hsecret, hscreen };
let code = 0;
try {
  for (const [name, fn] of Object.entries(sections)) if (which === 'all' || which === name) await fn();
} catch (e) { check(`pl_parity ${which} ran`, false, e.stack || e.message); }
code = summary(`pl_parity-${which}`);
process.exit(code);
