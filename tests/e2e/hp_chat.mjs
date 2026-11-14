// D2 chat checks in the temp office against lab a. Usage: node hp_chat.mjs <section> (think|tool|approval|clarify|stop|
// redirect|queue|model|newchat|idle|restart). Each section opens the office, starts a new chat with the lab's default profile.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { check, launch, sleep, summary, api } from './hp_lib.mjs';
import { openChat, newChat, send, waitIdle, waitText, busy } from './hp_chatlib.mjs';

const AGENT = process.env.HPQA_AGENT || 'hermes-lab-a';
const section = process.argv[2] || 'think';
const msgs = page => page.evaluate(() => document.getElementById('chat-messages').innerText);
const { browser, page, errors } = await launch();

const S = {
  async think() {
    await send(page, '[[think]] hi');
    const ok = await waitText(page, /Stub reply \d+ to: hi/);
    const fold = await page.evaluate(() => { const d = document.querySelector('#chat-messages details.chat-thinking-card'); return d ? { open: d.open, title: d.querySelector('.chat-thinking-title')?.innerText } : null; });
    check('[[think]] hi -> reasoning folded', ok && fold && fold.open === false, JSON.stringify(fold));
  },
  async tool() {
    await send(page, '[[tool:terminal {"command":"echo hpqa-tool-ok"}]] run it');
    const ok = await waitText(page, /The tool answered:[^\n]*hpqa-tool-ok/); await waitIdle(page);
    const steps = await page.evaluate(() => [...document.querySelectorAll('#chat-messages .chat-tool-call')].map(e => e.innerText.replace(/\s+/g, ' ').slice(0, 80)));
    check('tool turn -> steps shown', ok && steps.length === 1 && steps.some(s => /terminal|echo/i.test(s)), steps.slice(0, 3).join(' | ') || 'no steps');
  },
  async approval() {
    fs.mkdirSync('/tmp/vo8095-hpqa/scratch', { recursive: true }); fs.writeFileSync('/tmp/vo8095-hpqa/scratch/keep', 'x');
    await send(page, '[[tool:terminal {"command":"rm -rf /tmp/vo8095-hpqa/scratch"}]] clean up');
    const shown = await page.waitForSelector('#chat-messages button:has-text("Allow once")', { timeout: 40000 }).then(() => true, () => false);
    const labels = await page.evaluate(() => { const b = [...document.querySelectorAll('#chat-messages button')].find(x => /Allow once/.test(x.innerText)); const card = b && b.closest('.hp-card'); return card ? { btns: [...card.querySelectorAll('button')].map(x => x.innerText.trim()).filter(Boolean), cmd: (card.querySelector('.hp-approval-command') || {}).innerText || '' } : null; });
    const want = ['Allow once', 'Allow in this chat', 'Always allow', 'Deny'];
    check('approval card with all 4 options', shown && labels && want.every(w => labels.btns.includes(w)), JSON.stringify(labels));
    if (!shown) return;
    await page.click('#chat-messages button:has-text("Allow once")');
    const settled = await waitText(page, /Allowed once/, 20000);
    const done = await waitText(page, /The tool answered/, 40000); await waitIdle(page);
    check('allow once runs the command', settled && done && !fs.existsSync('/tmp/vo8095-hpqa/scratch'), `settled=${settled} reply=${done} dirGone=${!fs.existsSync('/tmp/vo8095-hpqa/scratch')}`);
  },
  async clarify() {
    await send(page, '[[tool:clarify {"questions":[{"question":"Which colour?","choices":["Red","Blue"]}]}]] ask me');
    const shown = await page.waitForSelector('#chat-messages .hp-question', { timeout: 40000 }).then(() => true, () => false);
    const q = await page.evaluate(() => { const c = document.querySelector('#chat-messages .hp-question'); return c ? { text: (c.querySelector('.hp-question-text') || c).innerText.slice(0, 80), choices: [...c.querySelectorAll('.hp-question-choice')].map(x => x.innerText.replace(/\s+/g, ' ').trim().slice(0, 30)) } : null; });
    check('clarify -> question card', shown && q && /Which colour/.test(q.text) && q.choices.length >= 2, JSON.stringify(q));
    if (!shown) return;
    await page.locator('#chat-messages .hp-question-choice', { hasText: 'Blue' }).first().click();
    const submit = page.locator('#chat-messages .hp-card button', { hasText: /Confirm|Send|Submit/ });
    if (await submit.count()) await submit.first().click().catch(() => {});
    const done = await waitText(page, /The tool answered/, 40000); await waitIdle(page);
    check('clarify answer reaches Hermes, turn ends', done && /Answered/.test(await msgs(page)), done ? 'reply after answer' : (await msgs(page)).slice(-160));
  },
  async stop() {
    await send(page, '[[slow:200]][[long:10]] stop me');
    await page.waitForFunction(() => /\S/.test(document.querySelector('#chat-messages .chat-stream-segment, #chat-messages .chat-msg.assistant:last-child')?.innerText || ''), null, { timeout: 30000 }).catch(() => {});
    await sleep(1200);
    const wasBusy = await busy(page);
    await page.click('#chat-stop');
    const idle = await waitIdle(page, 20000);
    const t = await msgs(page);
    const tail = t.slice(-220).replace(/\s+/g, ' ');
    const st = await api('/api/agent-chat/state?agent=' + AGENT);
    check('Stop mid [[slow:200]] -> stopped', wasBusy && idle && /stopp/i.test(t), `busy=${wasBusy} idle=${idle} tail="${tail.slice(-120)}"`);
    void st;
  },
  async redirect() {
    await send(page, '[[slow:250]][[long:10]] first');
    await sleep(2500);
    const wasBusy = await busy(page);
    await send(page, 'second please', { key: 'Enter' });
    const ok = await waitText(page, /Stub reply \d+ to: (second please|\[Context from the interrupted)/, 45000); await waitIdle(page);
    const t = await msgs(page);
    const i1 = t.indexOf('first'), i2 = t.indexOf('second please');
    const between = t.slice(i1, i2).replace(/\s+/g, ' ');
    const firstLeft = /redirect|steer|stopp|interrupt/i.test(between);
    console.log('between first and second:', between.slice(0, 220));
    check('Enter while busy -> redirect (words under the cut answer, Hermes gets the interrupted context)', wasBusy && ok && i2 > i1 && /Stub reply \d+ to: first/.test(between), `busy=${wasBusy} secondAnswered=${ok} marker=${(t.match(/[^\n]*(redirect|steer|stopp|interrupt)[^\n]*/i) || [''])[0].slice(0, 90)}`);
  },
  async queue() {
    await send(page, '[[slow:200]][[long:6]] first');
    await sleep(2000);
    const wasBusy = await busy(page);
    const hint = await page.evaluate(() => [...document.querySelectorAll('#chat-panel *')].filter(e => e.children.length === 0 && e.offsetParent && /Enter (adds|sends)/.test(e.textContent)).map(e => e.textContent.trim()).join(' / ').slice(0, 120));
    check('busy hint under the composer (design 4.3)', /Enter adds to this turn/.test(hint) && /Ctrl\+Enter sends after it/.test(hint), hint || 'no hint');
    await send(page, 'queued one', { key: 'Control+Enter' });
    await sleep(800);
    const chips = await page.evaluate(() => [...document.querySelectorAll('.hp-queue-chip, .hp-queue .hp-queue-text')].map(e => e.innerText.trim().slice(0, 40)));
    const firstDone = await waitText(page, /Stub reply \d+ to: first/, 60000);
    const queuedDone = await waitText(page, /Stub reply \d+ to: queued one/, 45000); await waitIdle(page);
    check('Ctrl+Enter while busy -> queued, sent after', wasBusy && chips.some(c => /queued one/.test(c)) && firstDone && queuedDone, `busy=${wasBusy} chips=${JSON.stringify(chips)} first=${firstDone} queued=${queuedDone}`);
  },
  async model() {
    const btn = page.locator('.hp-picker-btn').first();
    const before = (await btn.innerText().catch(() => '')).trim();
    await btn.click();
    await page.waitForSelector('.hp-picker-pop .hp-picker-row', { timeout: 10000 });
    const row = page.locator('.hp-picker-pop .hp-picker-row', { hasText: 'stub-2' }).first();
    const has = await row.count();
    if (has) await row.click();
    await sleep(1200);
    const after = (await btn.innerText().catch(() => '')).trim();
    await send(page, 'which model');
    await waitText(page, /Stub reply \d+ to: which model/); await waitIdle(page);
    const stubLog = fs.readFileSync('/tmp/vo8095-hermes-lab/stub.log', 'utf8').split('\n').filter(l => /stub-[12]/.test(l)).slice(-3).join(' / ').slice(-200);
    // another chat of the same agent (a second window = fresh page, its first chat) keeps the agent default
    const p2 = await browser.newPage(); page.__orig = page;
    await openChat(p2, AGENT); await newChat(p2);
    const fresh = (await p2.locator('.hp-picker-btn').first().innerText().catch(() => '')).trim();
    await send(p2, 'fresh chat model');
    await waitText(p2, /Stub reply \d+ to: fresh chat model/); await waitIdle(p2);
    const lastModel = (fs.readFileSync('/tmp/vo8095-hermes-lab/stub.log', 'utf8').split('\n').filter(l => /stub-[12] /.test(l)).pop() || '').match(/stub-[12]/)?.[0];
    const cfg = fs.readFileSync('/tmp/vo8095-hermes-lab/a/home/config.yaml', 'utf8').match(/^\s*default:\s*(\S+)/m)?.[1] || '?';
    console.log('new chat used', lastModel, '| lab config default', cfg);
    check('model switch to custom:stub-2 for this chat only (other chat of the agent stays stub-1)', has && /stub-2/.test(after) && /stub-1/.test(fresh) && lastModel === 'stub-1', `before="${before}" after="${after}" newChat picker="${fresh}" newChat used=${lastModel} labDefault=${cfg}`);
  },
  async newchat() {
    // QA D2: 'New chat' after a first message starts a NEW Hermes session (no post into the old one, no carried model)
    const posts = [];
    page.on('request', r => { if (r.method() === 'POST' && /\/api\/agent-chat\/runs(\?|$)/.test(r.url())) { try { const b = JSON.parse(r.postData() || '{}'); posts.push({ session: b.session, queue: b.queue || '', text: b.text }); } catch {} } });
    const latest = () => api('/api/office/chat-sessions?agentId=' + AGENT + '&limit=1').then(r => (r.json.sessions || [])[0]?.key || '');
    await send(page, 'old chat first');
    await waitText(page, /Stub reply \d+ to: old chat first/); await waitIdle(page);
    const btn = page.locator('.hp-picker-btn').first();
    await btn.click();
    await page.waitForSelector('.hp-picker-pop .hp-picker-row', { timeout: 10000 });
    await page.locator('.hp-picker-pop .hp-picker-row', { hasText: 'stub-2' }).first().click();
    await sleep(1200);
    const oldPicker = (await btn.innerText().catch(() => '')).trim();
    const oldKey = await latest();
    await newChat(page);
    const empty = /No messages yet/.test(await msgs(page));
    const newPicker = (await btn.innerText().catch(() => '')).trim();
    await send(page, 'new chat first');
    const ok = await waitText(page, /Stub reply \d+ to: new chat first/); await waitIdle(page);
    const newKey = await latest();
    const t = await msgs(page);
    const p2 = posts.find(p => p.text === 'new chat first') || {};
    const used = (fs.readFileSync('/tmp/vo8095-hermes-lab/stub.log', 'utf8').split('\n').filter(l => /stub-[12] /.test(l)).pop() || '').match(/stub-[12]/)?.[0];
    check('New chat starts a new Hermes chat (new session, not a redirect into the old turn)', empty && ok && newKey && newKey !== oldKey && !(p2.session && oldKey && p2.session.includes(oldKey)) && p2.queue !== 'redirect' && !/old chat first/.test(t),
      `old=${oldKey} new=${newKey} post2=${JSON.stringify(p2).slice(0, 90)} emptyFirst=${empty} oldTurnShown=${/old chat first/.test(t)}`);
    check('New chat does not carry the old chat\'s model', /stub-2/.test(oldPicker) && /stub-1/.test(newPicker) && used === 'stub-1', `old picker="${oldPicker}" new picker="${newPicker}" new chat used=${used}`);
  },
  async idle() {
    // lab a restarted while the chat is idle: the connection line comes, then clears when Hermes is back
    await send(page, 'hello before restart');
    await waitText(page, /Stub reply \d+ to: hello before restart/); await waitIdle(page);
    const rs = spawn(new URL('../tools/lab-hermes.sh', import.meta.url).pathname, ['restart', 'a'], { stdio: 'ignore' });
    const seen = []; const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const v = await page.evaluate(() => { const e = document.querySelector('#chat-panel .hp-conn-line'); return e && !e.hidden && e.offsetParent ? e.innerText.trim().slice(0, 60) : '(none)'; });
      if (seen[seen.length - 1] !== v) seen.push(v);
      if (seen.length > 2 && v === '(none)') break;
      await sleep(250);
    }
    await new Promise(r => rs.exitCode !== null ? r() : rs.on('exit', r));
    const shown = seen.some(v => /lost|reconnect|not answering/i.test(v));
    check('reconnect line with an idle chat, cleared when back', shown && seen[seen.length - 1] === '(none)', seen.join(' -> '));
  },
  async restart() {
    await send(page, '[[slow:300]][[long:14]] long answer');
    await page.waitForFunction(() => /\S/.test(document.querySelector('#chat-messages .chat-stream-segment')?.innerText || ''), null, { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    // restart lab a without blocking the page polls (lab-hermes.sh restart waits until a answers again)
    const rs = spawn(new URL('../tools/lab-hermes.sh', import.meta.url).pathname, ['restart', 'a'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let rsOut = ''; rs.stdout.on('data', d => { rsOut += d; }); rs.stderr.on('data', d => { rsOut += d; });
    const t0 = Date.now();
    let banner = '', sawBanner = false;
    while (Date.now() - t0 < 25000) {
      // the connection line (.hp-conn-line) or, during a run, the run's own status line (#chat-status, run.status)
      banner = await page.evaluate(() => [...document.querySelectorAll('#chat-panel .hp-conn-line, #chat-panel [class*="banner"], #chat-panel [class*="reconnect"], #chat-status')].filter(e => e.offsetParent).map(e => e.innerText.trim()).filter(Boolean).join(' / ').slice(0, 140));
      // first "...was lost; reconnecting..." (the run's line + the connection line), ~0.2 s later the next offline frame says
      // "Hermes is not answering ..." until it is back: either counts
      if (/reconnect|offline|lost|not answering/i.test(banner)) { sawBanner = true; break; }
      await sleep(300);
    }
    await new Promise(r => rs.exitCode !== null ? r() : rs.on('exit', r));
    console.log(rsOut.trim().split('\n').slice(0, 2).join(' | '));
    // the reason row only (the reconnect line also says "connection to Hermes was lost")
    const interrupted = await waitText(page, /stopped before it answered|restarted before|may be cut off/i, 60000);
    const lastRun = await api('/api/office/chat-sessions?agentId=' + AGENT + '&limit=1').then(r => (r.json.sessions || [])[0]?.key).then(k => api(`/api/agent-chat/state?agent=${AGENT}&session=${k}`)).then(r => Object.values(r.json.runs || {}).map(x => `${x.status}/${x.reason || '-'}`).join(','));
    console.log('runs in /state after restart:', lastRun);
    const t = await msgs(page);
    const reason = (t.match(/[^\n]*(stopped before it answered|restarted before|interrupted|cut off)[^\n]*/i) || [''])[0].slice(0, 140);
    check('lab restart mid-answer -> interrupted with reason', interrupted, (reason || 'cut answer shown with no reason: ' + t.slice(-90)) + ' | /state runs ' + lastRun);
    // wait for the lab to answer again, then for the banner to clear
    let cleared = false; const t1 = Date.now();
    while (Date.now() - t1 < 90000) {
      const b = await page.evaluate(() => [...document.querySelectorAll('#chat-panel .hp-conn-line, #chat-panel [class*="banner"], #chat-panel [class*="reconnect"]')].filter(e => e.offsetParent && !e.hidden && e.innerText.trim()).map(e => e.innerText.trim()).join(' / '));
      const st = await page.evaluate(() => document.getElementById('chat-status')?.innerText || '');
      if (!/reconnect|offline|lost|not answering/i.test(b + ' ' + st)) { cleared = true; break; }
      await sleep(1000);
    }
    if (!sawBanner) console.log('chat streams:', JSON.stringify(await page.evaluate(() => window.__es.filter(r => /agent-chat/.test(r.u)).map(r => r.ev))).slice(0, 600));
    check('reconnect banner shown then clears', sawBanner && cleared, `banner="${banner}" cleared=${cleared} after ${Math.round((Date.now() - t1) / 1000)} s`);
    await send(page, 'after restart');
    const again = await waitText(page, /Stub reply \d+ to: after restart/, 45000);
    check('next turn after the lab restart answers', again, again ? 'ok' : (await msgs(page)).slice(-140));
  },
};

if (section === 'restart') await page.addInitScript(() => {   // event types per chat stream, printed when the line is missed
  const ES = window.EventSource; window.__es = [];
  window.EventSource = function (url, o) { const e = new ES(url, o); const rec = { u: String(url).replace(/^https?:\/\/[^/]+/, '').slice(0, 60), t: Date.now(), ev: [] }; window.__es.push(rec);
    e.addEventListener('message', m => { const ty = (m.data.match(/"type":\s*"([\w.]+)"/) || [])[1]; if (ty && !/delta|activity/.test(ty)) rec.ev.push(ty + (/status/.test(ty) ? ':' + ((m.data.match(/"(?:state|phase|text)":\s*"([^"]{0,24})/) || [])[1]) : '')); });
    e.addEventListener('error', () => rec.ev.push('ES-error')); return e; };
  window.EventSource.prototype = ES.prototype;
});
try {
  await openChat(page, AGENT);
  await newChat(page);
  await S[section]();
  check(`no page errors (${section})`, errors.length === 0, errors.slice(0, 3).join(' ; '));
} catch (e) {
  check(`chat ${section} script`, false, e.message.split('\n')[0]);
} finally { await browser.close(); }
process.exit(summary('hp_chat ' + section) ? 1 : 0);
