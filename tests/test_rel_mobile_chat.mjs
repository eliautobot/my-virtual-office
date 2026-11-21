// 0.12.0 mobilechat (review 11-13): the chat window on a phone (<= 640 px wide) was too large — a few lines of the
// conversation showed —, its "N running tasks" row ran off the right edge, and the progress card (the pinned task
// card above the message box) did not keep the person's closed/open choice. Checked on a private office with a real
// lab OpenClaw gateway (stub model), the latest chat of its "main" agent, at 360x740, 390x844 and 412x915:
//   - a compact window: title bar <= 44 px, messages 13-15 px at line height <= 1.45, the message box 16 px (a phone
//     zooms in on less), composer targets >= 36 px, at least 24 conversation lines at 412x915 (0.12 candidate: 19)
//     and >= 3.7 lines per 100 px of conversation (0.12 candidate: 3.4);
//   - the running-tasks row (drawn as chat-dock.js draws it, 2 tasks, a long title) inside the screen, on one line;
//   - the progress card closed by the person stays closed through a send (and while it runs), the window closed and
//     opened again and a reload; opened by the person, it is open again after a reload;
//   - a desktop (1600x1000): the window's sizes as 0.12 (title bar 55 px, 15 px / 24.3 px messages, the card 37 px),
//     and a card closed there stays closed through the window opening again and a send.
// 0.12.1 composer (phone report: the message box's focus outline ran into the + and Send buttons): on a phone, dark
// and light, the message box focused draws one ring (the composer's border, the accent, 2 px; the box itself none),
// + and Send are 32 px circles with 15 px icons and a >= 36 px tap area, and every composer tool's focus ring (+ and
// Send included) stays >= 2 px inside the composer's rounded border; the desktop composer is as 0.12.0.
// Office: VO_URL=http://127.0.0.1:<port> LAB_OC=<its LABS_ROOT>/oc LAB_OC_PORT=<its gateway> (tests/tools/office-labs.sh
// with the OpenClaw lab; the office's connection is paired as tests/e2e/pl_lib.mjs ensureOpenClaw does), or none:
// this test starts one (LABS_ROOT /tmp/vo-rel-mobile-chat, LABS_PORT 19650, LABS_OC_PORT 19654; no Hermes) and stops it.
// Needs PLAYWRIGHT_CORE_PATH (playwright-core), Chrome (CHROME_PATH or /usr/bin/google-chrome) and, for its own office,
// `openclaw` on PATH; otherwise SKIP. Details: $REL_OUT/test_rel_mobile_chat.json (default /tmp/vo-rel-mobile-chat-out).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const NAME = 'test_rel_mobile_chat';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const skip = why => { console.log(`SKIP ${NAME}: ${why}`); process.exit(0); };
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core')); } catch { skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)'); }
const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].find(p => p && fs.existsSync(p));
if (!CHROME) skip('Chrome was not found (set CHROME_PATH)');
const OUT = process.env.REL_OUT || '/tmp/vo-rel-mobile-chat-out';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the office
let VO = process.env.VO_URL, ownLabs = null;
if (!VO) {
  const env = { ...process.env, LABS_ROOT: process.env.LABS_ROOT || '/tmp/vo-rel-mobile-chat', LABS_PORT: process.env.LABS_PORT || '19650',
    LABS_OC_PORT: process.env.LABS_OC_PORT || '19654', LABS_HAPI: '0' };
  if (spawnSync('sh', ['-c', 'command -v openclaw'], { stdio: 'ignore' }).status !== 0) skip('no VO_URL and no `openclaw` for a lab office');
  const r = spawnSync(path.join(HERE, 'tools', 'office-labs.sh'), ['start'], { env, encoding: 'utf8', timeout: 240000 });
  fs.writeFileSync(path.join(OUT, 'labs-start.log'), `${r.stdout || ''}${r.stderr || ''}`);
  if (r.status !== 0) skip(`the lab office did not start (${path.join(OUT, 'labs-start.log')})`);
  ownLabs = env; VO = `http://127.0.0.1:${env.LABS_PORT}`;
}
for (const p of [8085, 8088, 8090, 8095, 8096, 8097, 8099]) if (VO.endsWith(`:${p}`)) throw new Error(`refusing a live office port ${p}`);
// (the office's connection to the lab gateway, paired: tests/e2e/pl_lib.mjs reads these when it loads)
process.env.VO_URL = VO;
if (ownLabs) { process.env.LAB_OC = path.join(ownLabs.LABS_ROOT, 'oc'); process.env.LAB_OC_PORT = ownLabs.LABS_OC_PORT; }
const { ensureOpenClaw } = await import('./e2e/pl_lib.mjs');

const results = [], detail = {};
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` -- ${String(info).slice(0, 160)}`}`); };
const W_ = '.chat-back:not(.min) .chatwin';

async function page(browser, vp, phone, { ctx: shared, half = false, theme = 'dark' } = {}) {
  const ctx = shared || await browser.newContext(phone ? { viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { viewport: vp });
  // (half: the phone's default sheet, as the office opens it when no height was saved)
  if (!shared) await ctx.addInitScript(half => { try { if (half.half) localStorage.removeItem('vo-chat-sheet-share'); else if (!localStorage.getItem('vo-chat-sheet-share')) localStorage.setItem('vo-chat-sheet-share', '1'); localStorage.setItem('vo-ui-theme', half.theme); } catch { /* private */ } }, { half, theme });
  const p = await ctx.newPage();
  await p.goto(`${VO}/`, { waitUntil: 'domcontentloaded' });
  if (!(await p.evaluate(async () => !!(await window.voPLReady)))) throw new Error('the provider layer did not mount');
  for (let k = 0; k < 3; k++) { await p.keyboard.press('Escape'); await sleep(120); }
  await openChat(p);
  return { ctx, p };
}
async function openChat(p) {
  await p.evaluate(() => window.VOOffice.openAgent('main', 'chat'));
  await p.waitForSelector(W_, { timeout: 15000 });
  for (let k = 0; k < 40 && !(await p.$(`${W_} .cw-msg`)); k++) await sleep(250);
  await sleep(1200);
}
const running = p => p.evaluate(W => !!document.querySelector(`${W} .cw-send.stop, ${W} .cw-send[aria-label*="Stop"]`), W_);
async function idle(p, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { if (!(await running(p))) return true; await sleep(300); } return false; }
async function send(p, text) { await p.fill(`${W_} .cw-in`, text); await p.press(`${W_} .cw-in`, 'Enter'); await sleep(900); await idle(p); await sleep(700); }
const card = p => p.evaluate(W => { const c = document.querySelector(`${W} .cw-card`); return !c || c.classList.contains('hidden') ? 'none' : c.classList.contains('open') ? 'open' : 'closed'; }, W_);
async function toggleCard(p) { await p.click(`${W_} .cw-card-chev`); await sleep(350); }
// the open card's chevron and the conversation rail: what a finger (or the pointer) lands on across the chevron's box
const railGeo = p => p.evaluate(W => {
  const w = document.querySelector(W), q = s => w.querySelector(s);
  const R = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const chev = q('.cw-card-chev'), rail = q('.cw-rail'), b = chev.getBoundingClientRect(), other = [];
  let top = 0, of = 0;
  for (const fx of [.1, .3, .5, .7, .9]) for (const fy of [.1, .3, .5, .7, .9]) {
    const el = document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy); of++;
    if (el && chev.contains(el)) top++; else other.push(el ? String(el.className || el.tagName).slice(0, 24) : 'none');
  }
  return { chev: R(chev), rail: rail && !rail.hidden ? R(rail) : null, foot: R(q('.cw-foot')), scroll: R(q('.cw-scroll')), main: R(q('.cw-main')), win: R(w), top, of, other: [...new Set(other)] };
}, W_);
const railOpen = p => p.evaluate(W => !!document.querySelector(`${W} .cw-rail.open`), W_);
const inside = (a, b) => !!a && !!b && a.l >= b.l && a.r <= b.r && a.t >= b.t && a.b <= b.b;
// the rail's list when open: inside the chat's column
const popGeo = p => p.evaluate(W => { const w = document.querySelector(W), R = el => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  return { pop: R(w.querySelector('.cw-rail-pop')), main: R(w.querySelector('.cw-main')) }; }, W_);

async function measure(p) {
  return p.evaluate((W) => {
    const w = document.querySelector(W), q = s => w.querySelector(s);
    const R = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) }; };
    const cs = (e, k) => (e ? getComputedStyle(e)[k] : null);
    const sc = q('.cw-scroll'); sc.scrollTop = sc.scrollHeight;
    const vr = sc.getBoundingClientRect(), tops = new Set();
    const tw = document.createTreeWalker(q('.cw-thread'), NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest('.cw-mact, .cw-meta, button, .cw-mav, .cw-msg.sys')) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const b of rg.getClientRects()) if (b.height > 4 && b.width > 2 && b.top >= vr.top - 1 && b.bottom <= vr.bottom + 1) tops.add(Math.round(b.top));
    }
    const md = q('.cw-msg.assistant .cw-md p') || q('.cw-msg.assistant .cw-md');
    const chip = q('.cw-tchip'), chipB = chip?.querySelector('b');
    const tools = [...w.querySelectorAll('.cw-tools button:not(.cw-attach, .cw-send)')].filter(b => b.offsetParent && b.getBoundingClientRect().width > 0).map(b => Math.round(Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height)));
    return { vw: innerWidth, vh: innerHeight, docW: document.documentElement.scrollWidth, win: R(w), head: R(q('.cw-head')), scroll: R(sc), foot: R(q('.cw-foot')),
      input: R(q('.cw-in')), card: R(q('.cw-card')), chip: R(chip), chipLines: chipB ? Math.round(chipB.getBoundingClientRect().height / parseFloat(cs(chipB, 'lineHeight'))) : 0,
      lines: tops.size, mdFont: parseFloat(cs(md, 'fontSize')), mdLH: parseFloat(cs(md, 'lineHeight')), inFont: parseFloat(cs(q('.cw-in'), 'fontSize')),
      bubbleFont: parseFloat(cs(q('.cw-bubble'), 'fontSize') || '0'), minTool: Math.min(...tools), tools: R(q('.cw-tools')), send: R(q('.cw-send')), attach: R(q('.cw-attach')), headBtn: R(q('.cw-head .cw-acts .btn.icon')) };
  }, W_);
}
// 0.12.1 composer: with the message box focused, which focus rings are drawn, and how far the + and Send buttons (with
// the ring each draws when focused from the keyboard) and the other tools' rings keep from the composer's inner edge
// (its rounded border, corners included); a button's tap area is probed 1.5 px outside each side of its circle
async function composer(p, phone) {
  const W = W_;
  const idleBc = await p.evaluate(W => getComputedStyle(document.querySelector(`${W} .cw-box`)).borderTopColor, W);
  if (phone) await p.tap(`${W} .cw-in`); else await p.click(`${W} .cw-in`);
  await sleep(400);
  const st = await p.evaluate(W => {
    const w = document.querySelector(W), q = s => w.querySelector(s), box = q('.cw-box'), inn = q('.cw-in'), bs = getComputedStyle(box), is = getComputedStyle(inn);
    // the drawn circle: the button inside its border (a clear border widens the tap area around it)
    const vis = e => { const b = e.getBoundingClientRect(), s = getComputedStyle(e), bl = parseFloat(s.borderLeftWidth), bt = parseFloat(s.borderTopWidth);
      return { l: b.left + bl, t: b.top + bt, r: b.right - parseFloat(s.borderRightWidth), b: b.bottom - parseFloat(s.borderBottomWidth), w: e.clientWidth, h: e.clientHeight, tapW: Math.round(b.width), tapH: Math.round(b.height) }; };
    const hit = e => { const b = vis(e), cx = (b.l + b.r) / 2, cy = (b.t + b.b) / 2, at = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && e.contains(h); };
      return [at(b.l - 1.5, cy), at(b.r + 1.5, cy), at(cx, b.t - 1.5), at(cx, b.b + 1.5)].every(Boolean); };
    const svg = e => Math.round(e.querySelector('svg')?.getBoundingClientRect().width || 0);
    return { focused: document.activeElement === inn, inOutline: is.outlineStyle === 'none' ? 0 : parseFloat(is.outlineWidth), inOff: parseFloat(is.outlineOffset), inShadow: is.boxShadow,
      boxBc: bs.borderTopColor, boxShadow: bs.boxShadow, boxRad: bs.borderTopLeftRadius, boxPad: bs.padding,
      attachHit: hit(q('.cw-attach')), sendHit: hit(q('.cw-send')), attachVis: vis(q('.cw-attach')), sendVis: vis(q('.cw-send')), attachSvg: svg(q('.cw-attach')), sendSvg: svg(q('.cw-send')),
      after: ['.cw-attach', '.cw-send'].map(s => getComputedStyle(q(s), '::after').content) };
  }, W);
  // each tool focused from the keyboard: its ring's reach (outline width + offset) and the gap to the composer's inner edge
  // (a draft in the box, so Send is enabled and can take focus)
  await p.fill(`${W} .cw-in`, 'draft');
  const gaps = {};
  const n = await p.evaluate(W => document.querySelectorAll(`${W} .cw-tools button`).length, W);
  for (let i = 0; i < n; i++) {
    await p.keyboard.press('Shift');
    const g = await p.evaluate(([W, i]) => {
      const w = document.querySelector(W), box = w.querySelector('.cw-box'), e = w.querySelectorAll('.cw-tools button')[i];
      if (!e.offsetParent || !e.getBoundingClientRect().width) return null;
      e.focus(); const s = getComputedStyle(e), bs = getComputedStyle(box);
      const ext = e.matches(':focus-visible') && s.outlineStyle !== 'none' ? parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset) : 0;
      const bb = box.getBoundingClientRect(), bw = parseFloat(bs.borderTopWidth), R = Math.max(0, parseFloat(bs.borderTopLeftRadius) - bw);
      const l = bb.left + bw, t = bb.top + bw, r = bb.right - bw, b = bb.bottom - bw, cx = (l + r) / 2, cy = (t + b) / 2, hx = (r - l) / 2 - R, hy = (b - t) / 2 - R;
      const inside = (x, y) => { const qx = Math.abs(x - cx) - hx, qy = Math.abs(y - cy) - hy; return R - Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - Math.min(Math.max(qx, qy), 0); };
      const eb = e.getBoundingClientRect(), er = Math.min(parseFloat(s.borderTopLeftRadius) || 0, eb.width / 2, eb.height / 2) + ext;
      // the ring's outline: a rounded rect (the button's own radius + the ring's reach), sampled
      const rl = eb.left - ext, rt = eb.top - ext, rr = eb.right + ext, rb = eb.bottom + ext; let gap = Infinity;
      for (let k = 0; k < 360; k++) {
        const a = k / 360 * 2 * Math.PI, ux = Math.cos(a), uy = Math.sin(a);
        const ccx = ux < 0 ? rl + er : rr - er, ccy = uy < 0 ? rt + er : rb - er;
        gap = Math.min(gap, inside(ccx + er * ux, ccy + er * uy));
      }
      return { cls: String(e.className).split(' ').filter(c => c.startsWith('cw-') && c !== 'cw-tool')[0] || 'tool', w: Math.round(eb.width), h: Math.round(eb.height), ext, gap: Math.round(gap * 100) / 100 };
    }, [W, i]);
    if (g) gaps[g.cls] = g;
  }
  await p.evaluate(() => document.activeElement?.blur());
  await p.fill(`${W} .cw-in`, '');
  return { ...st, idleBc, gaps };
}
function composerChecks(tag, m, c) {
  check(`${tag}: the message box focused, one focus ring: the composer's (the accent, 2 px), none on the box itself`,
    c.focused && c.inOutline === 0 && c.inShadow === 'none' && c.boxBc !== c.idleBc && /0px 0px 0px 1px/.test(c.boxShadow), JSON.stringify([c.focused, c.inOutline, c.inShadow, c.idleBc, c.boxBc, c.boxShadow]));
  const av = c.attachVis, sv = c.sendVis;
  check(`${tag}: + and Send 32 px circles, 15 px icons, a tap area >= 36 px`,
    av.w === 32 && av.h === 32 && sv.w === 32 && sv.h === 32 && av.tapW >= 36 && av.tapH >= 36 && sv.tapW >= 36 && sv.tapH >= 36 && c.attachSvg === 15 && c.sendSvg === 15 && c.attachHit && c.sendHit,
    JSON.stringify([av.w, av.h, av.tapW, sv.w, sv.h, sv.tapW, c.attachSvg, c.sendSvg, c.attachHit, c.sendHit]));
  const a = c.gaps['cw-attach'], s = c.gaps['cw-send'];
  check(`${tag}: + and Send, with their focus rings, >= 2 px inside the composer's border (corners too)`, a && s && a.ext > 0 && s.ext > 0 && a.gap >= 2 && s.gap >= 2, JSON.stringify([a, s]));
  const bad = Object.values(c.gaps).filter(g => !(g.gap >= 2));
  check(`${tag}: every composer tool's focus ring >= 2 px inside the composer's border`, Object.keys(c.gaps).length >= 4 && !bad.length, JSON.stringify(bad.length ? bad : Object.keys(c.gaps)));
}
async function chip(p) {   // (the row as chat-dock.js draws it for two running tasks with a long title)
  await p.evaluate(W => { const c = document.querySelector(`${W} .cw-tchip`); c.classList.remove('hidden');
    c.innerHTML = '<span class="cw-tchip-mk" aria-hidden="true"></span><b>2 running tasks</b><span class="cw-tchip-t" data-noicon>VO 0.12 release: final Docker install/upgrade test on a fresh machine with the published image · +1 more</span>'; }, W_);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
try {
  await ensureOpenClaw();
  // a chat of its own: a progress card (OpenClaw's progress_card through its deferred-tool wrapper) and long answers
  {
    const { ctx, p } = await page(browser, { width: 1400, height: 900 }, false);
    for (let k = 0; k < 4; k++) { await p.evaluate(W => document.querySelector(`${W} .cw-new`)?.click(), W_); await sleep(1200); if (!(await p.$(`${W_} .cw-msg`))) break; }
    const pc = { id: 'openclaw:core:progress_card', input: { plan: [{ status: 'completed', step: 'Merge review fixes' }, { status: 'in_progress', step: 'Full test suite, release checks and the Docker image' },
      { status: 'pending', step: 'Release notes' }, { status: 'pending', step: 'Push' }, { status: 'pending', step: 'Fresh install test' }] } };
    for (let k = 0; k < 2 && (await card(p)) === 'none'; k++) {
      await send(p, `[[tool:tool_call ${JSON.stringify(pc)}]] Card.`);
      for (let j = 0; j < 60 && (await card(p)) === 'none'; j++) await sleep(500);
    }
    const para = 'If both pass, I will push one commit to GitHub, tag it and publish the release with the notes. Then I will download the published image, test it on a fresh install and update the office. ';
    await send(p, `${para}${para}\n\n- ${para}\n- ${para}\n\n${para}${para}\n\n${para}`);
    await send(p, `${para}\n\n${para}${para}`);
    const ready = (await card(p)) !== 'none' && !!(await p.$(`${W_} .cw-msg.assistant`));
    check('setup: a chat with a progress card and answers', ready, await card(p));
    await ctx.close();
    if (!ready) throw new Error('setup failed: no progress card or no answer from the lab agent');
  }

  // phones: compact, and the running-tasks row inside the screen
  for (const vp of [{ width: 412, height: 915 }, { width: 390, height: 844 }, { width: 360, height: 740 }]) {
    const { ctx, p } = await page(browser, vp, true);
    await chip(p);
    const m = await measure(p); detail[`phone${vp.width}`] = m;
    const tag = `${vp.width}x${vp.height}`;
    check(`${tag}: title bar <= 44 px`, m.head.h <= 44, m.head.h);
    check(`${tag}: messages 13-15 px, line height <= 1.45`, m.mdFont >= 13 && m.mdFont <= 15 && m.mdLH / m.mdFont <= 1.45 && (!m.bubbleFont || (m.bubbleFont >= 13 && m.bubbleFont <= 15)), `${m.mdFont}/${m.mdLH} bubble ${m.bubbleFont}`);
    check(`${tag}: the message box 16 px, >= 36 px tall`, m.inFont >= 16 && m.input.h >= 36, `${m.inFont} ${m.input.h}`);
    check(`${tag}: composer tools >= 36 px on one row (+ and Send: below), title bar buttons >= 32 px`, m.minTool >= 36 && m.tools.h <= 40 && m.headBtn.h >= 32, `${m.minTool} ${m.tools.h} ${m.headBtn.h}`);
    check(`${tag}: the composer (card, row, box) <= 165 px`, m.foot.h <= 165, m.foot.h);
    check(`${tag}: running-tasks row inside the screen, one line`, m.chip && m.chip.l >= 0 && m.chip.r <= vp.width && m.chipLines === 1 && m.docW <= vp.width, JSON.stringify([m.chip, m.chipLines, m.docW]));
    check(`${tag}: >= 3.7 conversation lines per 100 px`, m.lines / m.scroll.h * 100 >= 3.7, `${m.lines} lines / ${m.scroll.h} px`);
    if (vp.width === 412) {
      check('412x915: >= 24 conversation lines (0.12 candidate: 19)', m.lines >= 24, m.lines);
      if (process.env.REL_SHOT) await p.screenshot({ path: process.env.REL_SHOT, type: 'jpeg', quality: 70 });
    }
    composerChecks(tag, m, detail[`composer${vp.width}`] = await composer(p, true));
    await ctx.close();
  }
  // the light theme: the same composer
  {
    const { ctx, p } = await page(browser, { width: 412, height: 915 }, true, { theme: 'light' });
    composerChecks('412x915 light', await measure(p), detail.composerLight = await composer(p, true));
    await ctx.close();
  }

  // phone: the progress card keeps the person's choice
  {
    const { ctx, p } = await page(browser, { width: 412, height: 915 }, true);
    if ((await card(p)) === 'closed') await toggleCard(p);
    const opened = await card(p);
    await toggleCard(p);
    const closed = await card(p);
    await p.fill(`${W_} .cw-in`, 'slow:4000 another message'); await p.tap(`${W_} .cw-send`);
    const during = []; for (let i = 0; i < 10; i++) { await sleep(400); during.push(await card(p)); }
    await idle(p); await sleep(800);
    const after = await card(p);
    check('phone: a closed card stays closed through a send and its answer', opened === 'open' && closed === 'closed' && during.every(s => s === 'closed') && after === 'closed', `${opened} ${closed} [${during.join(',')}] ${after}`);
    await p.evaluate(W => document.querySelector(`${W} .cw-x, ${W} [aria-label="Close"]`)?.click(), W_); await sleep(800);
    await openChat(p);
    const reopened = await card(p);
    await p.reload({ waitUntil: 'domcontentloaded' }); await p.evaluate(async () => !!(await window.voPLReady)); await openChat(p);
    const reloaded = await card(p);
    check('phone: closed, it stays closed when the window opens again and after a reload', reopened === 'closed' && reloaded === 'closed', `${reopened} ${reloaded}`);
    await toggleCard(p);
    await p.reload({ waitUntil: 'domcontentloaded' }); await p.evaluate(async () => !!(await window.voPLReady)); await openChat(p);
    const kept = await card(p);
    check('phone: opened by the person, it is open again after a reload', kept === 'open', kept);
    await toggleCard(p);   // (closed again for the desktop part's own choice)
    await ctx.close();
  }

  // the open card's chevron is never under the conversation rail: the rail keeps to the conversation (0.12 candidate:
  // on the phone's default half-height sheet the rail lay over the chevron, a tap opened the rail, the card stayed open)
  for (const [tag, vp, phone, half] of [['phone half sheet', { width: 412, height: 915 }, true, true], ['phone full sheet', { width: 412, height: 915 }, true, false], ['desktop', { width: 1600, height: 1000 }, false, false]]) {
    const { ctx, p } = await page(browser, vp, phone, { half });
    const share = await p.evaluate(() => localStorage.getItem('vo-chat-sheet-share'));
    if ((await card(p)) === 'closed') { if (phone) await p.tap(`${W_} .cw-card-chev`, { timeout: 4000 }).catch(() => {}); else await toggleCard(p); await sleep(350); }
    const opened = await card(p), g = await railGeo(p); detail[`rail ${tag}`] = { share, ...g };
    check(`${tag}: the card open, the rail shown (the case to test)`, opened === 'open' && !!g.rail && (half ? share === null : true), `${opened} rail ${!!g.rail} share ${share}`);
    check(`${tag}: the rail keeps to the conversation (not over the composer or the card)`, inside(g.rail, g.scroll) && g.rail.b <= g.foot.t, JSON.stringify({ rail: g.rail, scroll: g.scroll, foot: g.foot }));
    check(`${tag}: the open card's chevron is the topmost element across its box`, g.top === g.of, `${g.top}/${g.of} ${g.other.join(' ')} chev ${JSON.stringify(g.chev)}`);
    let err = '';
    if (phone) await p.tap(`${W_} .cw-card-chev`, { timeout: 4000 }).catch(e => { err = String(e.message || e).split('\n')[0]; });
    else await p.click(`${W_} .cw-card-chev`, { timeout: 4000 }).catch(e => { err = String(e.message || e).split('\n')[0]; });
    await sleep(400);
    const closed = await card(p), ro = await railOpen(p);
    check(`${tag}: ${phone ? 'a tap' : 'a click'} on the chevron closes the card (the rail stays shut)`, !err && closed === 'closed' && !ro, `${err} ${closed} rail open ${ro}`);
    // the rail still works: a tap on a tick (or the pointer over it) opens its list, inside the chat
    if (g.rail) {
      if (phone) await p.tap(`${W_} .cw-rail-tick`, { timeout: 4000 }).catch(() => {}); else await p.hover(`${W_} .cw-rail-tick`, { timeout: 4000 }).catch(() => {});
      await sleep(400);
      const o = await railOpen(p), pg = await popGeo(p);
      check(`${tag}: the rail opens its list, inside the chat`, o && inside(pg.pop, pg.main), `${o} ${JSON.stringify(pg)}`);
    }
    await ctx.close();
  }

  // desktop: as 0.12, and its card keeps the person's choice too
  {
    const { ctx, p } = await page(browser, { width: 1600, height: 1000 }, false);
    const m = await measure(p); detail.desk = m;
    const c = await composer(p, false); detail.deskComposer = c;
    check('desktop 1600x1000: the composer as 0.12 (box, + 34 px, Send 36 px, the message box\'s own ring, no phone ring)',
      c.boxRad === '22px' && c.boxPad === '8px 8px 6px 12px' && m.attach.w === 34 && m.send.w === 36 && c.attachSvg === 17 && c.sendSvg === 17 && c.focused && c.inOutline === 2 && c.inOff === 2
        && !/0px 0px 0px 1px/.test(c.boxShadow) && c.after.every(a => a === 'none'), JSON.stringify([c.boxRad, c.boxPad, m.attach.w, m.send.w, c.attachSvg, c.sendSvg, c.inOutline, c.inOff, c.boxShadow, c.after]));
    check('desktop 1600x1000: window, title bar, messages and card as 0.12', m.win.w === 380 && m.win.h === 500 && m.head.h === 55 && m.mdFont === 15 && m.mdLH === 24.3 && m.inFont === 15 && m.card.h === 37,
      JSON.stringify([m.win.w, m.win.h, m.head.h, m.mdFont, m.mdLH, m.inFont, m.card.h]));
    if ((await card(p)) === 'open') await toggleCard(p);
    const closed = await card(p);
    await p.evaluate(W => document.querySelector(`${W} .cw-x, ${W} [aria-label="Close"]`)?.click(), W_); await sleep(800);
    await openChat(p);
    await send(p, 'one more message');
    const after = await card(p);
    check('desktop: a closed card stays closed when the window opens again and through a send', closed === 'closed' && after === 'closed', `${closed} ${after}`);
    await ctx.close();
  }
} catch (e) {
  check('no exception', false, e.stack || e);
} finally {
  await browser.close();
  fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify({ results, detail }, null, 1));
  if (ownLabs) spawnSync(path.join(HERE, 'tools', 'office-labs.sh'), ['stop'], { env: ownLabs, stdio: 'ignore', timeout: 60000 });
}
const failed = results.filter(r => !r.ok).length;
console.log(`${failed ? 'FAIL' : 'PASS'} ${NAME}: ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
