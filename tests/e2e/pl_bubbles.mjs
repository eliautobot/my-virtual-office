// v0.12 bubbles: the floor's chat bubbles show the layer's agents' sessions LIVE, whatever started them (as 0.9 did from
// the gateway's transcripts), against the labs only. A run started OUTSIDE the office (the lab gateway's own CLI; for
// Hermes another client of `hermes serve`) must open the agent's bubble with the person's message, then a tool step
// running, then the answer as it is written, then the final answer; two agents at once; the bubble follows the agent's
// newest session. Frames of each bubble are written to $BUBBLES_FRAMES (default /tmp/pl_bubbles_frames.txt).
// Usage (office: tests/tools/pl-office.sh; labs: tests/tools/lab-openclaw.sh, optional tests/tools/lab-hermes.sh):
//   VO_URL=http://127.0.0.1:<p> LAB_OC=<lab> LAB_OC_PORT=<port> [LAB_H=<hlab> LAB_PORT_A=<a>] node tests/e2e/pl_bubbles.mjs
//   BUBBLES_ONLY=openclaw|hermes runs one part only.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAB_OC, check, summary, ensureOpenClaw, ensureHermes, launch, sleep, api } from './pl_lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAMES = process.env.BUBBLES_FRAMES || '/tmp/pl_bubbles_frames.txt';
const ONLY = process.env.BUBBLES_ONLY || '';
const TAG = `bb${Date.now().toString(36).slice(-5)}`;
const out = [];
const note = line => out.push(line);

/** The lab gateway's own CLI, not waited for (the page is sampled meanwhile). */
function cliRun(args) {
  return new Promise(resolve => {
    const p = spawn(path.join(HERE, '..', 'tools', 'lab-openclaw.sh'), ['cli', ...args], { env: { ...process.env, LAB: LAB_OC }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', d => { o += d; }); p.stderr.on('data', d => { o += d; });
    const t = setTimeout(() => p.kill('SIGTERM'), 120000);
    p.on('close', code => { clearTimeout(t); resolve({ code, out: o.slice(-300) }); });
  });
}

/** Another client of lab Hermes a (as Hermes Desktop would be): a new session of a profile, one prompt. */
async function hermesOutside(profile, text) {
  const WS = createRequire(import.meta.url)(path.join(HERE, '..', '..', 'app', 'provider-layer', 'node_modules', 'ws'));
  const token = fs.readFileSync(path.join(process.env.LAB_H, 'a', 'session-token'), 'utf8').trim();
  return new Promise(resolve => {
    const ws = new WS(`ws://127.0.0.1:${process.env.LAB_PORT_A}/api/ws?token=${encodeURIComponent(token)}`);
    let id = 0, buf = '';
    const pending = new Map();
    const call = (method, params) => new Promise((ok, no) => { const k = ++id; pending.set(k, { ok, no }); ws.send(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n'); });
    const t = setTimeout(() => { try { ws.close(); } catch { /* gone */ } resolve({ ok: false, error: 'timeout' }); }, 30000);
    ws.on('message', async d => {
      buf += String(d);
      for (let i; (i = buf.indexOf('\n')) >= 0 || (buf.trim().startsWith('{') && (i = buf.length));) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let f; try { f = JSON.parse(line); } catch { continue; }
        if (f.id && pending.has(f.id)) { const p = pending.get(f.id); pending.delete(f.id); f.error ? p.no(new Error(f.error.message)) : p.ok(f.result); continue; }
        if (f.method === 'event' && f.params?.type === 'gateway.ready') {
          try {
            const c = await call('session.create', { profile, source: 'cli' });
            await call('prompt.submit', { session_id: c.session_id, text });
            clearTimeout(t);
            // (stays connected while the turn runs: a client that leaves may end its turn)
            setTimeout(() => { try { ws.close(); } catch { /* gone */ } }, 40000);
            resolve({ ok: true, key: c.stored_session_id });
          } catch (e) { clearTimeout(t); resolve({ ok: false, error: e.message }); }
        }
      }
    });
    ws.on('error', e => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
  });
}

/** What the page has for one agent's bubble now: drawn on the canvas, open, its last messages. */
const frameOf = (page, key) => page.evaluate(k => {
  const msgs = (window.agentChatData || {})[k] || [];
  const drawn = (window.renderedChatBubbles || []).some(b => b && b.agentKey === k);
  const open = typeof _chatBubbleShownFor === 'function' ? (_chatBubbleShownFor(k) && !window.chatMinimized[k]) : null;
  return { drawn, open, n: msgs.length, tail: msgs.slice(-2).map(m => ({ role: m.role, text: String(m.text || ''), tools: (m.tools || []).map(t => `${t.name}:${t.status}`),
    live: !!m.live, dots: !String(m.text || '').trim() && !!(m.thinking || (m.tools || []).some(t => t.status === 'running')), session: m.sessionKey || '' })) };
}, key);

const user = f => f.tail.find(m => m.role === 'user');
const answer = f => f.tail.find(m => m.role === 'assistant');
const line = (t, f) => `${(t / 1000).toFixed(1)}s drawn=${f.drawn ? 1 : 0} open=${f.open ? 1 : 0} | ` + f.tail.map(m =>
  `${m.role}${m.live ? '(live)' : ''}${m.dots ? '(dots)' : ''}: "${m.text.replace(/\s+/g, ' ').slice(0, 46)}" [${m.tools.join(',')}]`).join(' | ');

/** Samples agents' bubbles every 400 ms until each one's answer has its final words (or the time is up). */
async function watch(page, keys, done, ms = 70000) {
  const t0 = Date.now(), frames = Object.fromEntries(keys.map(k => [k, []]));
  const last = {};
  while (Date.now() - t0 < ms) {
    for (const k of keys) {
      const f = await frameOf(page, k);
      const s = line(0, f).replace(/^[^|]*\|/, '') + f.drawn + f.open;
      if (s !== last[k]) { last[k] = s; frames[k].push({ t: Date.now() - t0, f }); note(`[${k}] ${line(Date.now() - t0, f)}`); }
    }
    if (keys.every(k => { const a = answer(frames[k].at(-1)?.f || { tail: [] }); return a && !a.live && done[k](a.text); })) break;
    await sleep(400);
  }
  return frames;
}

/** The checks for one agent's run: its message, a tool step running, words before the final ones, then the answer. */
function runChecks(label, frames, { said, toolRx, final }) {
  const fs_ = frames.map(x => x.f);
  const iUser = fs_.findIndex(f => f.drawn && f.open && (user(f)?.text || '').includes(said));
  const iTool = fs_.findIndex(f => f.drawn && (answer(f)?.tools || []).some(t => toolRx.test(t) && /:running$/.test(t)));
  const iFinal = fs_.findIndex(f => { const a = answer(f); return a && !a.live && a.text.includes(final); });
  const iStream = fs_.findIndex((f, i) => { const a = answer(f); return f.drawn && a && a.live && a.text.trim() && (iFinal < 0 || i < iFinal); });
  const finalA = iFinal >= 0 ? answer(fs_[iFinal]) : null;
  check(`${label}: the bubble opens with the person's message`, iUser >= 0, `frame ${iUser}/${fs_.length}`);
  check(`${label}: a tool step shows running`, iTool >= 0, `frame ${iTool}`);
  check(`${label}: the answer shows as it is written, before the final answer`, iStream >= 0 && iStream < iFinal, `stream ${iStream} final ${iFinal}`);
  check(`${label}: the final answer, its tool done`, !!finalA && finalA.tools.every(t => !/:running$/.test(t)), finalA ? `${finalA.text.slice(0, 60)} [${finalA.tools}]` : 'none');
  check(`${label}: the bubble is drawn on the floor while it works`, iUser >= 0 && iTool >= 0 && fs_[iTool].drawn, '');
}

const oc = await ensureOpenClaw();
check('lab OpenClaw connected', oc?.status?.state === 'connected', oc?.status?.state);
let hermesKey = null;
if (process.env.LAB_H) {
  const h = await ensureHermes();
  check('lab Hermes connected', h?.status?.state === 'connected', h?.status?.state);
  const roster = (await api('/agents-list')).body;
  const list = Array.isArray(roster) ? roster : (roster?.agents || []);
  hermesKey = (list.find(a => a.providerKind === 'hermes' && a.providerAgentId === 'default') || {}).statusKey || null;
}

const { browser, page, errors } = await launch();
try {
  await page.waitForFunction(() => Array.isArray(window.agents) && window.agents.some(a => a.statusKey === 'main') && window.lastChatPoll > 0, null, { timeout: 30000 });
  if (hermesKey === null && process.env.LAB_H) {
    hermesKey = await page.evaluate(() => (window.agents.find(a => a.providerKind === 'hermes' && (a.providerAgentId === 'default' || /default/.test(a.statusKey))) || {}).statusKey || null);
  }
  await sleep(3000);   // (the first poll seen: what comes next is new)

  if (ONLY !== 'hermes') {
  // 1. OpenClaw: two agents at once, both started outside the office (the gateway's CLI)
  const runA = cliRun(['agent', '--agent', 'main', '--message', `bubble probe ${TAG} [[think:weighing it]] [[exec:sleep 4; echo slow:5000 ${TAG}-ran]]`]);
  const runB = cliRun(['agent', '--agent', 'ops', '--message', `ops probe ${TAG} [[exec:sleep 3; echo slow:4000 ${TAG}-ops]]`]);
  const fr = await watch(page, ['main', 'ops'], { main: t => t.includes(`${TAG}-ran`), ops: t => t.includes(`${TAG}-ops`) });
  const [ra, rb] = await Promise.all([runA, runB]);
  check('the CLI runs finished on the lab gateway', ra.code === 0 && rb.code === 0, `${ra.code} ${rb.code} ${ra.out.slice(-80)}`);
  runChecks('OpenClaw main (CLI)', fr.main, { said: `bubble probe ${TAG}`, toolRx: /^exec:/, final: `${TAG}-ran` });
  runChecks('OpenClaw ops at the same time (CLI)', fr.ops, { said: `ops probe ${TAG}`, toolRx: /^exec:/, final: `${TAG}-ops` });

  // 2. the bubble follows the agent's newest session
  const key2 = `agent:main:bubbles-${TAG}`;
  const runC = cliRun(['agent', '--agent', 'main', '--session-key', key2, '--message', `second session ${TAG} [[exec:sleep 3; echo slow:3000 ${TAG}-two]]`]);
  const fr2 = await watch(page, ['main'], { main: t => t.includes(`${TAG}-two`) });
  await runC;
  const end2 = fr2.main.at(-1)?.f;
  check('OpenClaw: the bubble follows the newest session (its messages only)', !!end2 && (user(end2)?.text || '').includes(`second session ${TAG}`)
    && end2.tail.every(m => m.session === key2), end2 ? end2.tail.map(m => m.session).join(',') : 'none');
    // (a new session can be followed only once it works: the steps it took before are filled in from its history)
    check('OpenClaw: a session followed late still shows its earlier step', !!end2 && (answer(end2)?.tools || []).some(t => /^exec:completed$/.test(t)),
      end2 ? String(answer(end2)?.tools) : 'none');

    // 4. the office's own chat window (the layer's chat): its run shows in the bubble too
    const ag = ((await api('/api/pl/agents')).body?.agents || []).find(a => a.key === `prov-${oc.id}-main`);
    check('OpenClaw: the layer agent of main', !!ag, ag ? ag.id : 'none');
    if (ag) {
      const W_ = '.chat-back:not(.min)';
      await page.evaluate(id => window.voPL.openLayer(id), ag.id);
      await page.waitForSelector(`${W_} .cw-in`, { timeout: 15000 });
      await page.evaluate(s => document.querySelector(`${s} .cw-new`)?.click(), W_);
      await sleep(1500);
      await page.fill(`${W_} .cw-in`, `office chat ${TAG} [[exec:sleep 3; echo slow:3000 ${TAG}-own]]`);
      await page.keyboard.press('Enter');
      const fr3 = await watch(page, ['main'], { main: t => t.includes(`${TAG}-own`) });
      runChecks('OpenClaw main (the office chat window)', fr3.main, { said: `office chat ${TAG}`, toolRx: /^exec:/, final: `${TAG}-own` });
      await page.keyboard.press('Escape');
    }
  }

  // 3. Hermes (serve): a turn of another client of the same Hermes
  if (process.env.LAB_H && ONLY !== 'openclaw') {
    check('Hermes: its agent is on the floor', !!hermesKey, String(hermesKey));
    const hx = await hermesOutside('default', `hermes probe ${TAG} [[think]] [[slow:120]] [[tool:terminal {"command":"sleep 4; echo ${TAG}-hx"}]]`);
    check('Hermes: another client started a turn', hx.ok, hx.error || hx.key);
    if (hermesKey && hx.ok) {
      const frh = await watch(page, [hermesKey], { [hermesKey]: t => t.includes(`${TAG}-hx`) || /stub|tool/i.test(t) }, 60000);
      runChecks('Hermes default (another client)', frh[hermesKey], { said: `hermes probe ${TAG}`, toolRx: /^terminal:/, final: '' });
    }
  }
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' / '));
} finally {
  fs.writeFileSync(FRAMES, out.join('\n') + '\n');
  await browser.close();
}
process.exit(summary('pl_bubbles'));
