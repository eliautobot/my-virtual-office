// unify WP-D in a real browser: app/chat.js is only a router once the layer is mounted. On an office with every chat
// provider (tests/tools/office-labs.sh: Codex "Dex", Claude Code "Clara", OpenCode "OpenCode Main", Antigravity "Gravity"
// through the office bridge, OpenClaw "Main"/"Ops" on the lab gateway):
//   - 0.9 / 0.10 / 0.12 saved office windows come back ONCE as copied windows on the right agent, shown or put away as
//     saved (a phone: the front one), vo.chat.last = the front one, the old keys kept; a reload adds nothing;
//   - the Chat button puts the copied windows away / brings them back, and with none open reopens the agent used last,
//     whatever its kind (Codex -> Claude Code -> OpenClaw); "+" opens another copied window;
//   - never an office window, never the old window's provider routes or the legacy gateway feed.
// Usage: VO_URL=http://127.0.0.1:<p> LAB_OC=<lab> LAB_OC_PORT=<port> [UR_ONLY=desktop|phone] node tests/e2e/unify_router.mjs [off]
//   off: the same office started with PL_LAYER=0: the old window, exactly as before (0.9's windows come back in it, Dex
//        included; nothing moves; no copied window).
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { check, summary, sleep, VO } from './pl_lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || path.join(os.homedir(), '.hermes/hermes-agent/node_modules/playwright-core'));
const sel = (selectedAgentKey, sessionKey) => ({ selectedAgentKey, sessionKey });
const store = (wins, front, picks) => ({ 'vo.chat.windows': { v: 1, wins, front }, 'vo-chat-selection-v1': picks });
const V09 = store([{ slot: 'primary', min: false }, { slot: 'secondary-1', min: true }, { slot: 'secondary-2', min: false }], 'secondary-2',
  { primary: sel('main', 'agent:main:main'), 'secondary-1': sel('ops', 'agent:ops:main'), 'secondary-2': sel('codex-dex', 'codex:dex') });
const V10 = store([{ slot: 'primary', min: false }, { slot: 'secondary-1', min: false }, { slot: 'secondary-3', min: true }], 'secondary-1',
  { 'secondary-1': sel('claude-code-clara', 'claude-code:clara'), 'secondary-3': sel('opencode:main', 'opencode:main') });
const V12 = store([{ slot: 'secondary-1', min: true }, { slot: 'primary', min: false }], 'primary',
  { primary: sel('antigravity:gravity', 'antigravity:gravity'), 'secondary-1': sel('codex-dex', 'codex:dex:not-a-thread') });

async function session({ phone = false, seed = null } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext(phone ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true } : { viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(s => {
    try {
      if (sessionStorage.getItem('ur-seeded')) return;   // (once: a reload keeps what the page saved)
      sessionStorage.setItem('ur-seeded', '1');
      localStorage.setItem('vo-ui-theme', 'dark');
      for (const [k, v] of Object.entries(s || {})) localStorage.setItem(k, JSON.stringify(v));
    } catch { /* private */ }
  }, seed);
  const page = await ctx.newPage();
  const net = { legacy: [] };
  // (the old window's own provider routes and gateway feed: the router never uses them)
  const OLD = /\/api\/(openclaw\/events|codex\/(runs|chat|history|approval)|claude-code\/(runs|chat|history)|hermes\/(runs|chat|history)|provider-runs|provider-chat|provider-history|agent-chat\/|office\/chat-sessions)/;
  page.on('request', r => { if (OLD.test(r.url())) net.legacy.push(r.url().replace(VO, '')); });
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror ${e.message}`));
  await page.goto(`${VO}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => { await window.voPLReady; });
  return { browser, page, net, errors };
}
const look = page => page.evaluate(() => {
  const name = w => (w.querySelector('.cw-name')?.textContent || '').trim();
  return {
    shown: [...document.querySelectorAll('.chat-back:not(.min) .chatwin')].map(name).sort(),
    away: [...document.querySelectorAll('.chat-back.min .chatwin')].map(name).sort(),
    office: [...document.querySelectorAll('[data-chat-slot].open')].map(p => p.dataset.chatSlot),
    last: JSON.parse(localStorage.getItem('vo.chat.last') || 'null'),
    unified: JSON.parse(localStorage.getItem('vo.chat.unified.v1') || 'null'),
    wins: localStorage.getItem('vo.chat.windows'), picks: localStorage.getItem('vo-chat-selection-v1'),
    isOpen: window.VirtualOfficeChat.isOpen(),
    dockOpen: document.body.classList.contains('vo-chat-open'),
    badge: [...document.querySelectorAll('[data-vo-chat-unread]')].filter(b => !b.hidden).map(b => b.textContent.trim()),
  };
});
async function until(page, fn, ms = 20000) {
  const end = Date.now() + ms;
  let v = await look(page);
  while (Date.now() < end && !fn(v)) { await sleep(300); v = await look(page); }
  return v;
}
const clickChat = page => page.evaluate(() => {
  const b = [...document.querySelectorAll('[data-vo-chat-launch], #chat-toggle')].find(e => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden');
  if (!b) return false;
  b.click();
  return b.id || b.className;
});
const closeAll = page => page.evaluate(() => { for (const b of document.querySelectorAll('.chat-back .cw-x')) b.click(); });
const keysKept = (v, seed) => v.wins === JSON.stringify(seed['vo.chat.windows']) && v.picks === JSON.stringify(seed['vo-chat-selection-v1']);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function cases(phone) {
  const tag = phone ? 'phone 412' : 'desktop 1600';
  // 1. 0.9: Main + Dex (Codex) in front, Ops put away
  {
    const { browser, page, net, errors } = await session({ phone, seed: V09 });
    try {
      // (settled: the front window, opened last, has recorded itself as last used)
      const v = await until(page, x => x.unified && x.shown.length + x.away.length >= 3 && x.last?.officeId === 'codex-dex', 30000);
      check(`[${tag}] 0.9: three copied windows, ${phone ? 'Dex in front, the others put away' : 'Dex + Main shown, Ops put away'}`,
        phone ? eq(v.shown, ['Dex']) && eq(v.away, ['Main', 'Ops']) : eq(v.shown, ['Dex', 'Main']) && eq(v.away, ['Ops']), JSON.stringify(v));
      check(`[${tag}] 0.9: last used = Dex (the front one), moved once, old keys kept`, v.last?.officeId === 'codex-dex' && v.unified?.done === true && keysKept(v, V09), JSON.stringify({ l: v.last, u: v.unified }));
      check(`[${tag}] 0.9: no office window`, !v.office.length, JSON.stringify(v.office));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => { await window.voPLReady; });
      await sleep(3000);
      const r = await look(page);
      check(`[${tag}] reload: the same three come back (copied manager), nothing moved again`, r.shown.length + r.away.length === 3 && !r.office.length, JSON.stringify(r));
      // the Chat button: shown -> put away; again -> back
      await clickChat(page);
      const a = await until(page, x => !x.shown.length, 8000);
      check(`[${tag}] Chat button puts them away (isOpen false)`, !a.shown.length && a.away.length === 3 && !a.isOpen, JSON.stringify(a));
      await clickChat(page);
      const b = await until(page, x => x.shown.length > 0, 8000);
      check(`[${tag}] Chat button brings them back`, (phone ? b.shown.length === 1 : b.shown.length === 3) && b.isOpen, JSON.stringify(b));
      // none open: the Chat button reopens the agent used last, of any kind
      const reopen = async (key, name) => {
        await page.evaluate(k => window.VirtualOfficeChat.openForAgent(k), key);
        await until(page, x => x.shown.includes(name) && x.last?.officeId === key, 15000);
        await closeAll(page);
        await until(page, x => !x.shown.length && !x.away.length, 8000);
        await clickChat(page);
        const w = await until(page, x => x.shown.length > 0, 15000);
        await sleep(600);
        return look(page);
      };
      const c1 = await reopen('claude-code-clara', 'Clara');
      check(`[${tag}] last used Claude Code: Chat button reopens Clara`, eq(c1.shown, ['Clara']) && !c1.away.length, JSON.stringify(c1));
      const c2 = await reopen('main', 'Main');
      check(`[${tag}] last used OpenClaw: Chat button reopens Main`, eq(c2.shown, ['Main']), JSON.stringify(c2));
      const c3 = await reopen('antigravity:gravity', 'Gravity');
      check(`[${tag}] last used Antigravity: Chat button reopens Gravity`, eq(c3.shown, ['Gravity']), JSON.stringify(c3));
      // "+": another copied window (the office's "+" meaning), never an office window
      await page.evaluate(() => window.VirtualOfficeChat.openNewWindow());
      const p = await until(page, x => x.shown.length + x.away.length === 2, 10000);
      check(`[${tag}] "+" opens a second copied window`, p.shown.length + p.away.length === 2 && !p.office.length, JSON.stringify(p));
      // the dock (ui-modern.js) follows the copied windows: open state, and an answer that came while they were put away
      if (!phone) {
        await closeAll(page);
        await page.evaluate(() => window.VirtualOfficeChat.openForAgent('codex-dex'));
        const d = await until(page, x => eq(x.shown, ['Dex']), 15000);
        check(`[${tag}] dock shows chat open (body.vo-chat-open)`, d.dockOpen, JSON.stringify(d));
        await page.fill('.chat-back:not(.min) .cw-in', 'router badge check');
        await page.keyboard.press('Enter');
        await clickChat(page);   // (put away at once: the answer comes meanwhile)
        const u = await until(page, x => !x.shown.length && x.badge.length > 0, 30000);
        check(`[${tag}] dock: put away -> not open; the Codex answer meanwhile shows on the dock badge`, !u.dockOpen && u.badge.length > 0 && u.badge.every(t => t === '1'), JSON.stringify({ o: u.dockOpen, b: u.badge }));
      }
      check(`[${tag}] never the old window's provider routes or gateway feed`, !net.legacy.length, net.legacy.slice(0, 4).join(' '));
      check(`[${tag}] no page errors`, !errors.length, errors.slice(0, 2).join(' | '));
    } finally { await browser.close(); }
  }
  // 2. 0.10: the main window on its default agent, Clara (Claude Code) in front, OpenCode put away
  {
    const { browser, page, net } = await session({ phone, seed: V10 });
    try {
      const v = await until(page, x => x.unified && x.shown.length + x.away.length >= 3 && x.last?.officeId === 'claude-code-clara', 30000);
      check(`[${tag}] 0.10: Clara in front, Main ${phone ? 'put away' : 'shown'}, OpenCode Main put away`,
        phone ? eq(v.shown, ['Clara']) && eq(v.away, ['Main', 'OpenCode Main']) : eq(v.shown, ['Clara', 'Main']) && eq(v.away, ['OpenCode Main']), JSON.stringify(v));
      check(`[${tag}] 0.10: last used Clara, old keys kept, no office window, no old routes`, v.last?.officeId === 'claude-code-clara' && keysKept(v, V10) && !v.office.length && !net.legacy.length, JSON.stringify({ l: v.last, o: v.office, n: net.legacy }));
    } finally { await browser.close(); }
  }
  // 3. 0.12: chatroute's leftovers (Gravity in front, Dex put away; its session key no longer exists: the latest chat)
  {
    const { browser, page } = await session({ phone, seed: V12 });
    try {
      const v = await until(page, x => x.unified && x.shown.length + x.away.length >= 2 && x.last?.officeId === 'antigravity:gravity', 30000);
      check(`[${tag}] 0.12: Gravity shown, Dex put away`, eq(v.shown, ['Gravity']) && eq(v.away, ['Dex']), JSON.stringify(v));
      check(`[${tag}] 0.12: last used Gravity`, v.last?.officeId === 'antigravity:gravity' && !v.office.length, JSON.stringify(v.last));
    } finally { await browser.close(); }
  }
}

async function offCases(phone) {
  const tag = phone ? 'phone 412' : 'desktop 1600';
  const { browser, page, errors } = await session({ phone, seed: V09 });
  try {
    const slots = () => page.evaluate(() => [...document.querySelectorAll('[data-chat-slot].open')].map(p => [p.dataset.chatSlot, p.querySelector('.chat-agent-select')?.value || '']));
    const end = Date.now() + 20000;
    let s = await slots();
    while (Date.now() < end && !s.some(([, a]) => a === 'codex-dex')) { await sleep(300); s = await slots(); }
    const v = await look(page);
    const pl = await page.evaluate(async () => !!(await window.voPLReady));
    check(`[${tag}] layer off: no copied layer, nothing moved (no vo.chat.unified.v1 / vo.chat.last)`, !pl && !v.shown.length && !v.unified && !v.last, JSON.stringify({ pl, v }));
    check(`[${tag}] layer off: 0.9's office windows come back as before (${phone ? 'Dex in front only' : 'Main + Dex shown'})`,
      phone ? JSON.stringify(s) === JSON.stringify([['secondary-2', 'codex-dex']]) : s.some(([k, a]) => k === 'primary' && a === 'main') && s.some(([k, a]) => k === 'secondary-2' && a === 'codex-dex'), JSON.stringify(s));
    await clickChat(page);
    await sleep(600);
    const away = await slots();
    await clickChat(page);
    await sleep(600);
    const back = await slots();
    check(`[${tag}] layer off: the Chat button puts the office windows away and back`, !away.length && back.length >= 1, JSON.stringify({ away, back }));
    check(`[${tag}] layer off: no page errors`, !errors.length, errors.slice(0, 2).join(' | '));
  } finally { await browser.close(); }
}

const only = process.env.UR_ONLY || '';
const sizes = [false, true].filter(p => !only || only === (p ? 'phone' : 'desktop'));
if (process.argv[2] === 'off') for (const phone of sizes) await offCases(phone);
else for (const phone of sizes) await cases(phone);
process.exit(summary(`unify_router${process.argv[2] === 'off' ? '-off' : ''}`));
