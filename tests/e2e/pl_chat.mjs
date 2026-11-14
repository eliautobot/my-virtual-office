// v0.11 C2 acceptance: the copied OpenClaw + Hermes chat window in the office, against the labs only (SHARED S2).
// Usage (office: tests/tools/pl-office.sh; labs: tests/tools/lab-openclaw.sh with LAB_OC_BIND=172.17.0.1, lab-hermes.sh):
//   VO_URL=http://127.0.0.1:<p> LAB_OC=<lab> LAB_OC_URL=ws://172.17.0.1:<port> LAB_H=<hlab> LAB_PORT_A=<a> \
//     node tests/e2e/pl_chat.mjs [look|oc|hermes|all]
// OpenClaw: the desk opens the copied window, "/" lists commands.list, /status runs on the gateway, a reload mid-answer
// keeps one whole answer, Ctrl+Enter queues a follow-up, an approval card resolves, a MEDIA: picture shows from a gateway
// on 172.17.0.1 (no shared disk path in the page). Hermes: "/" catalog by category, /title, edit and resend, branch,
// archive, the goal stack. Also: a non-layer agent still opens the office's own window.
import fs from 'node:fs';
import path from 'node:path';
import { check, summary, launch, open, api, sleep, shot, ensureOpenClaw, ensureHermes, LAB_OC } from './pl_lib.mjs';

const which = process.argv[2] || 'all';
const thread = page => page.evaluate(() => document.querySelector('.chat-back:not(.min) .cw-thread')?.innerText || '');
async function waitText(page, re, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const t = await thread(page); if (re.test(t)) return t; await sleep(300); }
  return null;
}
async function idle(page, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(() => !document.querySelector('.chat-back:not(.min) .cw-send.stop, .chat-back:not(.min) .cw-send[aria-label*="Stop"]'))) return true;
    await sleep(300);
  }
  return false;
}
async function newChat(page) {
  // (a window that is still loading its latest chat would put it back: click until the empty chat stays)
  for (let k = 0; k < 4; k++) {
    await page.evaluate(() => document.querySelector('.chat-back:not(.min) .cw-new')?.click());
    await sleep(1200);
    if (await page.evaluate(() => !document.querySelector('.chat-back:not(.min) .cw-msg'))) return true;
  }
  return false;
}
async function send(page, text, { ctrl = false } = {}) {
  await page.fill('.chat-back:not(.min) .cw-in', text);
  if (text.startsWith('/')) {   // (the / menu opens: Enter takes the command as written, the next Enter sends it)
    await page.waitForSelector('.cw-pop-cmds', { timeout: 4000 }).catch(() => {});
    if (await page.$('.cw-pop-cmds')) { await page.keyboard.press('Enter'); await sleep(200); }
    await page.evaluate(t => { const i = document.querySelector('.chat-back:not(.min) .cw-in'); if (i.value.trim() !== t) { i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); } }, text);
  }
  await page.keyboard.press(ctrl ? 'Control+Enter' : 'Enter');
}
const agentsOf = async () => (await api('/api/pl/agents')).body?.agents || [];

async function openClaw() {
  await ensureOpenClaw();
  const { browser, page, errors } = await launch();
  try {
    // the desk's agent menu (Chat) -> the copied window
    await page.evaluate(() => window.VOOffice.openAgent('main', 'chat'));
    const opened = await page.waitForSelector('.chat-back .chatwin', { timeout: 15000 }).then(() => true, () => false);
    const head = await page.evaluate(() => ({ name: document.querySelector('.chat-back .cw-name')?.textContent, z: +document.querySelector('.chat-back')?.style.zIndex, office: !!document.querySelector('.chat-panel.open') }));
    check('desk -> copied chat window for main', opened && head.name === 'Main' && !head.office && head.z > 300 && head.z < 400, JSON.stringify(head));
    await newChat(page);

    // "/" lists the gateway's commands (commands.list)
    const main = (await agentsOf()).find(a => a.key.endsWith('-main'));
    const listed = (await api(`/api/providers/commands?agent=${main.id}`)).body?.commands || [];
    await page.fill('.chat-back .cw-in', '/');
    await page.waitForSelector('.cw-pop-cmds [data-k]', { timeout: 10000 }).catch(() => {});
    const menu = await page.$$eval('.cw-pop-cmds [data-k]', b => b.map(x => x.innerText.split('\n')[0].trim()));
    const aliases = new Set(listed.map(c => c.alias));
    check('"/" menu lists commands.list', menu.length > 3 && menu.every(m => aliases.has(m)) && menu.includes('/status'), `${menu.length} shown of ${listed.length}: ${menu.slice(0, 6).join(' ')}`);
    await page.keyboard.press('Escape');

    // /status answered by the gateway (not the model)
    await send(page, '/status');
    const st = await waitText(page, /\/status[\s\S]+(OpenClaw|Model|Session|Context|Runtime)/i, 30000);
    check('/status answered by OpenClaw', !!st && !/stub reply: \/status/.test(st), (st || '').split('/status')[1]?.slice(0, 120));
    await idle(page);

    // reload mid-answer: the answer goes on, whole and once
    await newChat(page);
    await send(page, 'slow:9000 plui reload check');
    await waitText(page, /\b3 4\b/, 20000);
    await open(page, { reload: true, dismiss: false });
    await page.waitForSelector('.chat-back:not(.min) .chatwin', { timeout: 15000 }).catch(() => {});
    // (while it still streams: the words from before the reload are there, no gap)
    const mid = await waitText(page, /\b(7|8|9|10) \b/, 20000);
    const midOk = !!mid && !/stub reply:[^]*plui reload check/.test(mid) && /0 1 2 3 4 5 6 7/.test(mid);
    const after = await waitText(page, /stub reply:[^]*slow:9000 plui reload check/, 40000);
    const count = (after || '').split('stub reply:').length - 1;
    check('reload mid-answer -> the answer goes on with no gap, one whole answer', midOk && count === 1 && /0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19/.test(after || ''), `mid ${midOk} answers ${count}`);
    await idle(page);

    // Ctrl+Enter while it works: a follow-up queued on the gateway, answered after the first
    await newChat(page);
    await send(page, 'slow:5000 plui first');
    await waitText(page, /\b2 3\b/, 20000);
    await send(page, 'plui second queued', { ctrl: true });
    const q = await waitText(page, /stub reply:[^]*?plui first[^]*?stub reply:[^]*?plui second queued/, 45000);
    check('Ctrl+Enter queues a follow-up (answered after the first)', !!q, q ? 'in order' : (await thread(page)).slice(-160));
    await idle(page);

    // an approval card (the gateway asks before exec) resolves with Allow once
    const pol = (await api('/api/agent-providers/call', { method: 'POST', body: { id: main.provider.connectionId, method: 'exec.approvals.get' } })).body;
    const file = { version: 1, defaults: { ...(pol.file?.defaults || {}), security: 'full', ask: 'always' } };
    const set = await api('/api/agent-providers/call', { method: 'POST', body: { id: main.provider.connectionId, method: 'exec.approvals.set', params: { file, baseHash: pol.hash } } });
    try {
      await newChat(page);
      await send(page, '[[exec:echo plui-approval-ok]] run it');
      const card = await page.waitForSelector('.chat-back .cw-appr.prov.pending [data-dec="allow-once"]', { timeout: 40000 }).then(() => true, () => false);
      if (card) await page.click('.chat-back .cw-appr.prov.pending [data-dec="allow-once"]');
      const done = await waitText(page, /the command said:[^\n]*plui-approval-ok/, 40000);
      check('approval card -> Allow once -> the command ran', set.status === 200 && card && !!done, `set ${set.status} card ${card} done ${!!done}`);
    } finally {
      const now = (await api('/api/agent-providers/call', { method: 'POST', body: { id: main.provider.connectionId, method: 'exec.approvals.get' } })).body;
      await api('/api/agent-providers/call', { method: 'POST', body: { id: main.provider.connectionId, method: 'exec.approvals.set', params: { file: { version: 1, defaults: pol.file?.defaults || {} }, baseHash: now.hash } } });
    }
    await idle(page);

    // a MEDIA: picture from the gateway's machine (the gateway dialled on 172.17.0.1; the page never asks for a disk path)
    const pic = path.join(LAB_OC, 'ws-main', 'plui-pic.png');
    fs.mkdirSync(path.dirname(pic), { recursive: true });
    fs.writeFileSync(pic, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==', 'base64'));
    await newChat(page);
    await send(page, `[[media:${pic}]] show it`);
    await waitText(page, /here is the picture/, 30000);
    const img = await page.waitForFunction(() => { const i = document.querySelector('.chat-back .cw-msg.assistant img'); return i && i.complete && i.naturalWidth > 0 ? { src: i.getAttribute('src'), w: i.naturalWidth } : null; }, null, { timeout: 30000 }).then(h => h.jsonValue(), () => null);
    check('MEDIA: picture shows from the gateway (no disk path)', !!img && img.w === 2 && !/chat-media\?path=|plui-pic\.png$/.test(img.src), JSON.stringify(img));
    await shot(page, 'pl-chat-openclaw');

    // Stop while it answers
    await newChat(page);
    await send(page, 'slow:20000 plui stop check');
    await waitText(page, /\b2 3\b/, 20000);
    await page.click('.chat-back .cw-send.stop').catch(() => {});
    const stopped = await idle(page, 15000);
    const full = /stub reply:[^]*plui stop check/.test(await thread(page));
    check('Stop ends the answer', stopped && !full, `idle ${stopped} finished ${full}`);
    // the side panel's background tasks: the gateway's tasks.list (OpenClaw 2026.9), or on a gateway without a task
    // list (OpenClaw 2026.11 removed it) the chat's helpers from their sessions (v0.13); never an error, never stuck on Loading
    await page.evaluate(() => document.querySelector('.chat-back .cw-dockb')?.click());
    const dock = await page.waitForFunction(() => {
      const d = document.querySelector('.chat-back .cw-dock');
      if (!d || !(d.getBoundingClientRect().width > 0)) return null;
      const t = d.innerText.replace(/\s+/g, ' ');
      return /Loading background tasks/.test(t) ? null : t.slice(0, 200);
    }, null, { timeout: 15000 }).then(h => h.jsonValue(), () => null);
    // (which one: the gateway's version as the connection reports it; 2026.11 and later have no task list)
    const gwv = (JSON.stringify((await api('/api/agent-providers')).body || {}).match(/"version":"(20\d\d\.\d+\.\d+)/) || [])[1] || '';
    const noLedger = /^20\d\d\./.test(gwv) && (([y, m]) => y > 2026 || (y === 2026 && m >= 11))(gwv.split('.').map(Number));
    const taskList = /No background tasks|Nothing from this chat|Running \(|Finished \(/.test(dock || '');
    const told = /No background task list\. This OpenClaw keeps no background task list/.test(dock || '');
    check('side panel: background tasks (the ledger, or the helpers\' sessions)', !!dock && !/could not|failed|does not do that/i.test(dock) && taskList && !told,
      `OpenClaw ${gwv || '?'}${noLedger ? ' (no ledger: helper sessions)' : ''}: ${told ? 'says it has no task list' : taskList ? 'lists tasks' : '?'} | ${dock}`);

    // the office's own window still opens for a non-layer agent (and the layer says no)
    const own = await page.evaluate(() => ({ codex: window.voPL.isLayerAgent('codex-lab'), main: window.voPL.isLayerAgent('main') }));
    check('non-layer agents keep the office window (isLayerAgent)', own.codex === false && own.main === true, JSON.stringify(own));
    check('no page errors / 5xx (OpenClaw)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

async function hermes() {
  await ensureHermes();
  const { browser, page, errors } = await launch();
  try {
    const ag = (await agentsOf()).find(a => a.provider?.kind === 'hermes' && /-default$/.test(a.key)) || (await agentsOf()).find(a => a.provider?.kind === 'hermes');
    await page.evaluate(id => window.voPL.openLayer(id), ag.id);
    await page.waitForSelector('.chat-back .chatwin', { timeout: 15000 });
    await newChat(page);
    await HERMES_SECTIONS(page);
    check('no page errors / 5xx (Hermes)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}
// the Hermes Desktop checks, in one chat (A, B, C, edit B) and its branch
const users = page => page.$$eval('.chat-back:not(.min) .cw-msg.user', els => els.map(e => (e.querySelector('.cw-mbody, .hv-ut') || e).innerText.trim().split('\n')[0]));
async function HERMES_SECTIONS(page) {
  // "/" opens Hermes' own catalog, by category
  await page.fill('.chat-back .cw-in', '/');
  await page.waitForSelector('.cw-pop-cmds .pv-ci', { timeout: 15000 }).catch(() => {});
  const cat = await page.evaluate(() => ({ groups: [...document.querySelectorAll('.cw-pop-cmds .cw-pop-h')].map(e => e.textContent.trim()), items: document.querySelectorAll('.cw-pop-cmds .pv-ci').length }));
  check('Hermes "/" catalog by category', cat.groups.length >= 2 && cat.items >= 6, `${cat.items} items in ${cat.groups.join(', ')}`);
  await page.fill('.chat-back .cw-in', '');   // (the menu closes with the text; Esc here would close the window)

  // A, B, C, then edit B: Hermes' record holds A, B'
  for (const t of ['plui A', 'plui B', 'plui C']) { await send(page, t); await waitText(page, new RegExp(`to: ${t}`), 40000); await idle(page); }
  // /title renames the chat (Hermes' own title; after its own first title has landed, which would race it)
  await page.waitForFunction(() => /plui/.test(document.querySelector('.chat-back .cw-title')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  await sleep(1500);
  const TITLE = `Lab chat ${Date.now().toString(36)}`;   // (Hermes keeps titles unique across its sessions)
  await send(page, `/title ${TITLE}`);
  const titled = await page.waitForFunction(t => (document.querySelector('.chat-back .cw-title')?.textContent || '').trim() === t, TITLE, { timeout: 30000 }).then(() => true, () => false);
  check('/title <name> renames the chat', titled, await page.evaluate(() => document.querySelector('.chat-back .cw-title')?.textContent));
  const b = await page.evaluateHandle(() => [...document.querySelectorAll('.chat-back .cw-msg.user')].find(m => /plui B/.test(m.innerText)));
  await b.hover().catch(() => {});
  await page.evaluate(m => m.querySelector('[data-a="hv-edit"]')?.click(), b);
  const box = await page.waitForSelector('.chat-back .hv-edit-in', { timeout: 8000 }).then(() => true, () => false);
  if (box) { await page.fill('.chat-back .hv-edit-in', 'plui B2'); await page.keyboard.press('Enter'); }
  await waitText(page, /to: plui B2/, 40000); await idle(page);
  await sleep(1500);
  await open(page, { reload: true, dismiss: false });
  await page.waitForSelector('.chat-back:not(.min) .cw-msg.user', { timeout: 20000 }).catch(() => {});
  await sleep(1500);
  const rec = await users(page);
  check('edit B of A,B,C -> Hermes holds A,B2', box && rec.join('|') === 'plui A|plui B2', rec.join('|'));

  // Branch (an answer's Branch in new chat) opens a new chat
  const before = await page.evaluate(() => document.querySelectorAll('.chat-back .cw-list [data-open], .chat-back .cw-list .cw-item').length);
  await page.evaluate(() => { const a = [...document.querySelectorAll('.chat-back .cw-msg.assistant')].pop(); a?.querySelector('[data-a="hv-branch"]')?.click(); });
  await sleep(4000);
  const branched = await page.evaluate(() => ({ list: document.querySelectorAll('.chat-back .cw-list [data-open], .chat-back .cw-list .cw-item').length, title: document.querySelector('.chat-back .cw-title')?.textContent || '' }));
  check('Branch opens a new chat', branched.list > before && branched.title.trim() !== TITLE, JSON.stringify({ before, ...branched }));

  // Archive (the chat's menu): out of the list
  const n0 = branched.list;
  await page.evaluate(() => document.querySelector('.chat-back .cw-list [data-more]')?.click());
  const archived = await page.waitForSelector('.cw-pop [data-k]', { timeout: 5000 }).then(async () => {
    const ok = await page.evaluate(() => { const it = [...document.querySelectorAll('.cw-pop [data-k]')].find(x => /^Archive/.test(x.innerText.trim())); it?.click(); return !!it; });
    if (!ok) return false;
    await sleep(800);
    await page.evaluate(() => [...document.querySelectorAll('.vo-dialog button, .cw-pop button, .hv-ovl button')].find(x => /^(Archive|OK|Yes)$/i.test(x.innerText.trim()))?.click());
    await sleep(2500);
    return true;
  }, () => false);
  const n1 = await page.evaluate(() => document.querySelectorAll('.chat-back .cw-list [data-open], .chat-back .cw-list .cw-item').length);
  check('Archive hides the chat', archived && n1 < n0, `${n0} -> ${n1}`);

  // /goal: the goal stack shows
  await newChat(page);
  await send(page, '/goal finish the plui lab check');
  const goal = await page.waitForSelector('.chat-back .hv-sec[data-sec="goal"]', { timeout: 30000 }).then(() => true, () => false);
  check('/goal -> goal stack visible', goal, goal ? '' : (await thread(page)).slice(-160));
  await shot(page, 'pl-chat-hermes');

  // the Desktop's own rows and cards (the lab stub's directives, as tests/e2e/hp_chat.mjs uses them)
  const last = () => page.evaluate(() => { const a = [...document.querySelectorAll('.chat-back:not(.min) .cw-msg.assistant')].pop(); return a ? { html: a.innerHTML.length, think: !!a.querySelector('.hv-think'), tool: !!a.querySelector('.hv-tool, .hv-cmd, .hv-run'), text: a.innerText.replace(/\s+/g, ' ').slice(-160) } : null; });
  const clickIn = (sel, re) => page.evaluate(([s, r]) => { const b = [...document.querySelectorAll(`${s} button`)].find(x => new RegExp(r, 'i').test(x.innerText.trim())); b?.click(); return b ? b.innerText.trim() : null; }, [sel, re]);
  await newChat(page);
  await send(page, '[[think]] plui hi'); await waitText(page, /to: plui hi|plui hi/, 30000); await idle(page);
  const th = await last();
  check('Hermes: reasoning folded in the Desktop turn', !!th?.think, JSON.stringify(th));
  await send(page, '[[tool:terminal {"command":"echo plui-tool-ok"}]] run it');
  const tt = await waitText(page, /plui-tool-ok[^]*plui-tool-ok|answered:[^\n]*plui-tool-ok/, 40000); await idle(page);
  const tr = await last();
  check('Hermes: tool row in Desktop words', !!tt && !!tr?.tool, JSON.stringify(tr));
  fs.mkdirSync('/tmp/vo8096p-plui/hscratch', { recursive: true }); fs.writeFileSync('/tmp/vo8096p-plui/hscratch/keep', 'x');
  await send(page, '[[tool:terminal {"command":"rm -rf /tmp/vo8096p-plui/hscratch"}]] clean up');
  const card = await page.waitForSelector('.chat-back .hv-appr', { timeout: 40000 }).then(() => true, () => false);
  const pressed = card ? await clickIn('.chat-back .hv-appr', '^(Run|Allow once|Allow)\\b') : null;
  await idle(page, 40000); await sleep(800);
  check('Hermes: Command approval card -> Run', card && !!pressed && !fs.existsSync('/tmp/vo8096p-plui/hscratch'), `card ${card} pressed ${pressed} gone ${!fs.existsSync('/tmp/vo8096p-plui/hscratch')}`);
  await send(page, '[[tool:clarify {"questions":[{"question":"Which colour?","choices":["Red","Blue"]}]}]] ask me');
  const cl = await page.waitForSelector('.chat-back .hv-cl', { timeout: 40000 }).then(() => true, () => false);
  const chose = cl ? await clickIn('.chat-back .hv-cl', '(^|\\s)Red$|^A\\s*Red|Red') : null;
  await sleep(500); if (cl) await clickIn('.chat-back .hv-cl', '^(Confirm|Send|Submit|Continue)');
  const ans = await waitText(page, /Red/, 30000); await idle(page);
  check('Hermes: clarify question answered', cl && !!chose && !!ans, `card ${cl} chose ${chose}`);
  await newChat(page);
  await send(page, '[[slow:300]][[long:40]] plui stop me');
  await waitText(page, /to: plui stop me/, 20000); await sleep(1000);
  await page.focus('.chat-back .cw-in'); await page.keyboard.press('Escape');
  const escStop = await idle(page, 15000);
  check('Hermes: Esc stops a running turn (window stays)', escStop && !!(await page.$('.chat-back:not(.min) .chatwin')), `idle ${escStop}`);
  await send(page, '[[slow:250]][[long:10]] plui first');
  await waitText(page, /plui first/, 20000); await sleep(1200);
  await send(page, 'plui redirected');
  await waitText(page, /user correction|to: plui redirected/, 40000); await idle(page, 40000); await sleep(800);
  // (Hermes stops the turn and answers the correction; the stub quotes what it was given)
  const red = await page.evaluate(() => { const a = [...document.querySelectorAll('.chat-back:not(.min) .cw-msg.assistant')].pop()?.innerText || ''; return /Stub reply \d+ to:[^]*(plui redirected|user correction)/.test(a) ? a.replace(/\s+/g, ' ').slice(0, 120) : null; });
  check('Hermes: Enter while it works redirects the turn', !!red, red || (await thread(page)).slice(-140));
  await send(page, '[[slow:200]][[long:6]] plui busy');
  await waitText(page, /plui busy/, 20000); await sleep(1000);
  await send(page, 'plui queued one', { ctrl: true });
  const qd = await waitText(page, /to: plui queued one/, 50000); await idle(page, 40000);
  check('Hermes: Ctrl+Enter queues a message for after the turn', !!qd, (await thread(page)).slice(-140));
}

// v0.12 chatui: a chat with a progress card (the stub's progress_card through the deferred-tool wrapper) and a thread long
// enough to scroll, so the composer's card row and "go to the latest" show together
async function withCard(page) {
  const W_ = '.chat-back:not(.min) .chatwin';
  if (!(await page.$(`${W_} .cw-card:not(.hidden)`))) {
    const pc = { id: 'openclaw:core:progress_card', input: { plan: [{ status: 'completed', step: 'Lab step one, a longer step name' }, { status: 'in_progress', step: 'Lab step two' }] } };
    await send(page, `[[tool:tool_call ${JSON.stringify(pc)}]] A reply.\n\n` + 'A long line for a thread that scrolls. '.repeat(40));
    for (let k = 0; k < 100 && !(await page.$(`${W_} .cw-card:not(.hidden)`)); k++) await sleep(400);
    await idle(page);
  }
  await sleep(600);
  // (scrolled up: the window shows "go to the latest" itself; a short thread gets it shown by hand, the place is CSS's)
  await page.evaluate(s => { const w = document.querySelector(s), sc = w.querySelector('.cw-scroll'); sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll')); }, W_);
  await sleep(300);
  await page.evaluate(s => document.querySelector(`${s} .cw-down`).classList.remove('hidden'), W_);
  return !!(await page.$(`${W_} .cw-card:not(.hidden)`));
}
// Every control of the title bar, the composer and the thread overlay: its icon centred in it (|dx|, |dy| <= 1 px), a
// label's line centred, no icon button cut to an ellipsis (Attach was "+…"), the round ones round, the model chip's ▾
// inside it, "go to the latest" clear of the composer stack (it lay on the progress card) and centred over the thread.
async function controls(page, label) {
  const v = await page.evaluate(() => {
    const w = document.querySelector('.chat-back:not(.min) .chatwin'), bad = [], seen = [];
    const box = e => e && e.getClientRects().length ? e.getBoundingClientRect() : null;
    for (const b of w.querySelectorAll('.cw-head button, .cw-tools button, .cw-card button, .cw-down')) {
      const r = box(b); if (!r || !r.width || getComputedStyle(b).visibility === 'hidden') continue;
      const name = [...b.classList].filter(c => /^cw-/.test(c)).join('.') || 'button', cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const svgs = [...b.querySelectorAll('svg')].filter(s => box(s)), text = b.innerText.trim(); seen.push(name);
      if (/cw-agent|cw-card-tg/.test(name)) {   // (a row with its words at the left: only its line is centred)
        const rg = document.createRange(); rg.selectNodeContents(b); const q = rg.getBoundingClientRect();
        if (Math.abs(q.y + q.height / 2 - cy) > 1.5) bad.push(`${name} line dy ${(q.y + q.height / 2 - cy).toFixed(1)}`);
        continue;
      }
      if (!text && svgs.length === 1) {
        const s = svgs[0].getBoundingClientRect(), dx = s.x + s.width / 2 - cx, dy = s.y + s.height / 2 - cy;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) bad.push(`${name} icon dx ${dx.toFixed(1)} dy ${dy.toFixed(1)}`);
      } else {
        const rg = document.createRange(); rg.selectNodeContents(b); const q = rg.getBoundingClientRect(), dx = q.x + q.width / 2 - cx, dy = q.y + q.height / 2 - cy;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) bad.push(`${name} content dx ${dx.toFixed(1)} dy ${dy.toFixed(1)}`);
        const chev = svgs[svgs.length - 1]; if (text && chev && box(chev).right > r.right - 1) bad.push(`${name} ▾ cut`);
      }
      if (!text && b.scrollWidth > b.clientWidth + 1) bad.push(`${name} cut (${b.clientWidth}/${b.scrollWidth})`);
      if (/cw-send|cw-down|cw-attach/.test(name) && Math.abs(r.width - r.height) > 0.5) bad.push(`${name} ${r.width}x${r.height} not round/square`);
    }
    const d = box(w.querySelector('.cw-down')), foot = box(w.querySelector('.cw-foot')), sc = box(w.querySelector('.cw-scroll'));
    if (!d) bad.push('no go-to-latest'); else {
      if (d.bottom > foot.top - 4) bad.push(`go-to-latest bottom ${Math.round(d.bottom)} on the composer stack (top ${Math.round(foot.top)})`);
      if (Math.abs(d.x + d.width / 2 - (foot.x + foot.width / 2)) > 1) bad.push('go-to-latest not centred over the thread');
      if (d.top < sc.top) bad.push('go-to-latest above the thread');
    }
    return { bad, n: seen.length, attach: w.querySelector('.cw-attach')?.innerText.trim() };
  });
  check(`${label}: every title-bar, composer and card control centred, nothing cut, go-to-latest above the composer`, v.n >= 10 && !v.bad.length && v.attach === '', JSON.stringify(v).slice(0, 400));
}

// the office look: VO's accent (no sky blue left), frame, pixel titles, dark and light; the phone sheet
async function look() {
  for (const theme of ['dark', 'light']) {
    const { browser, page } = await launch({ theme });
    try {
      await page.evaluate(() => window.VOOffice.openAgent('main', 'chat'));
      await page.waitForSelector('.chat-back .chatwin', { timeout: 15000 });
      // (the frame of the office's own chat window: its window shadow, 1 px border, tinted header, 14 px text; the tokens
      //  resolved by a probe element)
      const v = await page.evaluate(() => { const w = document.querySelector('.chat-back .chatwin'), cs = getComputedStyle(w), root = getComputedStyle(document.documentElement);
        const probe = Object.assign(document.createElement('div'), { style: 'position:fixed;box-shadow:var(--vo-shadow-3);background:var(--vo-surface-2);font-size:var(--vo-text-md)' });
        document.body.appendChild(probe); const pc = getComputedStyle(probe), want = { shadow: pc.boxShadow, head: pc.backgroundColor, fs: pc.fontSize }; probe.remove();
        return { acc: cs.getPropertyValue('--cw-acc').trim(), vo: root.getPropertyValue('--vo-accent').trim(), border: cs.borderTopWidth, shadowOk: cs.boxShadow === want.shadow, headOk: getComputedStyle(w.querySelector('.cw-head')).backgroundColor === want.head,
          fs: cs.fontSize, fsOk: cs.fontSize === want.fs, font: getComputedStyle(w.querySelector('.cw-name')).fontFamily, theme: document.documentElement.dataset.uiTheme,
          blue: [...w.querySelectorAll('*')].slice(0, 400).some(e => /rgb\(56, 189, 248\)/.test(getComputedStyle(e).color + getComputedStyle(e).borderTopColor)) }; });
      check(`look ${theme}: VO accent, the office window's frame, pixel name, no sky blue`, v.theme === theme && v.acc === v.vo && v.border === '1px' && v.shadowOk && v.headOk && v.fsOk && /Press Start 2P/.test(v.font) && !v.blue, JSON.stringify(v).slice(0, 170));
      await shot(page, `pl-look-${theme}`);
      check(`look ${theme}: a chat with a progress card`, await withCard(page));
      await controls(page, `look ${theme} (380 px window)`);
      await shot(page, `pl-look-${theme}-card`);
      await page.evaluate(() => Object.assign(document.querySelector('.chat-back:not(.min) .chatwin').style, { width: '720px', height: '640px' }));
      await sleep(500);
      await controls(page, `look ${theme} (a window made wider)`);
    } finally { await browser.close(); }
  }
  const { browser, page } = await launch({ phone: true });
  try {
    await page.evaluate(() => window.VOOffice.openAgent('main', 'chat'));
    await page.waitForSelector('.chat-back .chatwin', { timeout: 15000 });
    await sleep(800);
    const g = await page.evaluate(() => { const w = document.querySelector('.chat-back .chatwin').getBoundingClientRect(), bar = document.querySelector('.vo-actionbar')?.getBoundingClientRect();
      return { top: Math.round(w.top), bottom: Math.round(w.bottom), h: Math.round(w.height), bar: bar ? Math.round(bar.top) : null, grip: !!document.querySelector('.chat-back .pl-sheet-grip'), sheet: document.documentElement.classList.contains('pl-sheet-open') }; });
    check('phone: the chat is the office bottom sheet with a grip', g.sheet && g.grip && g.bar !== null && Math.abs(g.bottom - g.bar) <= 2 && g.h >= 200 && g.h < 844 - 100, JSON.stringify(g));
    await withCard(page);
    await controls(page, 'phone');
  } finally { await browser.close(); }
}

try {
  if (which === 'look' || which === 'all') { await ensureOpenClaw(); await look(); }
  if (which === 'oc' || which === 'all') await openClaw();
  if (which === 'hermes' || which === 'all') await hermes();
} catch (e) { check('run', false, e.stack || e.message); }
process.exitCode = summary(`pl_chat-${which}`);
