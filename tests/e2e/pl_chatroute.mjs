// v0.12 chatroute: with the copied provider layer on (the default since 0.11) the office's own chat window never holds
// an OpenClaw or Hermes agent and never makes the legacy gateway connection (no EventSource to /api/openclaw/events, no
// WebSocket to a gateway): every way in hands the agent to the copied window. The bug: a browser that kept 0.9's saved
// chat windows came back with the office window on the OpenClaw agent, showing "Gateway proxy unavailable".
// Usage (office: tests/tools/pl-office.sh, lab: tests/tools/lab-openclaw.sh):
//   VO_URL=http://127.0.0.1:<p> LAB_OC=<lab> LAB_OC_PORT=<port> [CR_ONLY=desktop|phone] node tests/e2e/pl_chatroute.mjs [layer|off]
//   layer (default): the office's agents are the lab's "main" and "ops" (OpenClaw, the layer's); "mixed" cases add one
//                    non-layer agent to the office's list in the page (a Codex-kind row the layer never takes).
//                    unify (0.12): with the layer mounted no office window opens for ANY agent (app/chat.js routes);
//                    the saved windows move once (vo.chat.unified.v1), the old keys stay. Office kinds through the
//                    bridge: tests/e2e/unify_router.mjs.
//   off: an office started with PL_LAYER=0 (VO_PROVIDER_LAYER=0): 0.9's saved window comes back on the OpenClaw agent
//        in the office window and dials the office's gateway proxy, as before (the legacy path stays as it was).
// Each case runs on a 1600x900 desktop and a 412 px phone. Storage seeded exactly as 0.9.0 leaves it
// (app/chat-windows.js 'vo.chat.windows' v1 and app/chat.js 'vo-chat-selection-v1').
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { check, summary, sleep, ensureOpenClaw, VO, LAB_OC_URL } from './pl_lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || path.join(os.homedir(), '.hermes/hermes-agent/node_modules/playwright-core'));
const which = process.argv[2] || 'layer';
const GW_PORT = (LAB_OC_URL.match(/:(\d+)/) || [])[1] || '';

// (a provider the layer never takes: it stays in the office's own window)
const OTHER = { key: 'coda-lab', agentId: 'coda-lab', name: 'Coda', emoji: '🧪', branch: 'Lab', sessionKey: 'agent:coda-lab:main',
  providerKind: 'codex', providerType: 'cli', providerAgentId: 'coda-lab', providerConnectionId: '', selectionAliases: [] };
// 0.9.0's storage: the office window open on the OpenClaw agent "main"
const V09 = {
  'vo.chat.windows': { v: 1, wins: [{ slot: 'primary', min: false }], front: 'primary' },
  'vo-chat-selection-v1': { primary: { selectedAgentKey: 'main', sessionKey: 'agent:main:main' } },
};
// 0.9.0, the main window never chosen (it showed the default agent "main")
const V09_DEFAULT = { 'vo.chat.windows': { v: 1, wins: [{ slot: 'primary', min: false }], front: 'primary' } };
// 0.9.0 with two windows: Coda's (non-layer) and the OpenClaw agent's in front
const V09_MIXED = {
  'vo.chat.windows': { v: 1, wins: [{ slot: 'secondary-1', min: false }, { slot: 'primary', min: false }], front: 'primary' },
  'vo-chat-selection-v1': { primary: { selectedAgentKey: 'main', sessionKey: 'agent:main:main' }, 'secondary-1': { selectedAgentKey: 'coda-lab', sessionKey: 'agent:coda-lab:main' } },
};

async function session({ phone = false, seed = null, mixed = false } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext(phone ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true } : { viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(s => {
    try {
      if (sessionStorage.getItem('cr-seeded')) return;   // (once: a reload keeps what the page saved)
      sessionStorage.setItem('cr-seeded', '1');
      localStorage.setItem('vo-ui-theme', 'dark');
      for (const [k, v] of Object.entries(s || {})) localStorage.setItem(k, JSON.stringify(v));
    } catch { /* private */ }
  }, seed);
  const page = await ctx.newPage();
  const net = { events: [], ws: [] };
  page.on('request', r => { if (r.url().includes('/api/openclaw/events')) net.events.push(r.url()); });
  page.on('websocket', w => net.ws.push(w.url()));
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror ${e.message}`));
  if (mixed) {
    await page.route('**/agents-list', async route => {
      const res = await route.fetch();
      const j = await res.json();
      j.agents = [...(j.agents || []), OTHER];
      await route.fulfill({ response: res, json: j });
    });
  }
  await page.goto(`${VO}/`, { waitUntil: 'domcontentloaded' });
  return { browser, page, net, errors };
}

/** What shows: the office's own open windows (slot, agent, a gateway status line) and the copied windows' names. */
const look = page => page.evaluate(() => {
  const office = [...document.querySelectorAll('[data-chat-slot].open')].map(p => ({
    slot: p.dataset.chatSlot,
    agent: p.querySelector('.chat-agent-select')?.selectedOptions?.[0]?.value || '',
    status: (p.querySelector('.chat-status')?.textContent || '').trim(),
  }));
  const copied = [...document.querySelectorAll('.chat-back:not(.min) .chatwin')].map(w => (w.querySelector('.cw-name')?.textContent || '').trim());
  const deadText = /Gateway proxy unavailable|Gateway unavailable|Reconnecting\.\.\./.test(document.body.innerText);
  const officeConnecting = office.some(o => /Connecting|Gateway|Reconnecting/.test(o.status));
  return { office, copied, deadText, officeConnecting, wins: localStorage.getItem('vo.chat.windows'), picks: localStorage.getItem('vo-chat-selection-v1'),
    unified: localStorage.getItem('vo.chat.unified.v1') };
});
const legacyWs = net => net.ws.filter(u => (GW_PORT && u.includes(`:${GW_PORT}`)) || u.includes('/api/openclaw'));
async function until(page, fn, ms = 20000) {
  const end = Date.now() + ms;
  let v = await look(page);
  while (Date.now() < end && !fn(v)) { await sleep(300); v = await look(page); }
  return v;
}
const thread = page => page.evaluate(() => document.querySelector('.chat-back:not(.min) .cw-thread')?.innerText || '');
async function chats(page, words) {
  await page.fill('.chat-back:not(.min) .cw-in', words);
  await page.keyboard.press('Enter');
  const end = Date.now() + 60000;
  while (Date.now() < end) { if ((await thread(page)).includes(`stub reply: ${words}`) || new RegExp(`stub reply:[\\s\\S]*${words}`).test(await thread(page))) return true; await sleep(400); }
  return false;
}
const clickChat = page => page.evaluate(() => {
  const b = [...document.querySelectorAll('[data-vo-chat-launch], #chat-toggle')].find(e => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden');
  if (!b) return false;
  b.click();
  return b.id || b.className;
});

async function layerCases(phone) {
  const tag = phone ? 'phone 412' : 'desktop 1600';
  // 1. 0.9's saved office window on the OpenClaw agent (layer-only office: main + ops) -> the copied window, chatting
  {
    const { browser, page, net, errors } = await session({ phone, seed: V09 });
    try {
      const v = await until(page, x => x.copied.length > 0, 25000);
      await sleep(2500);   // (the old path retried and printed its status within a second or two)
      const w = await look(page);
      check(`[${tag}] 0.9 restore: the copied window opens on the saved OpenClaw agent`, w.copied.includes('Main'), JSON.stringify(w.copied));
      check(`[${tag}] 0.9 restore: no office window on an OpenClaw agent`, !w.office.length, JSON.stringify(w.office));
      check(`[${tag}] 0.9 restore: no "Gateway proxy unavailable" / "Connecting..."`, !w.deadText && !w.officeConnecting, JSON.stringify(w.office));
      check(`[${tag}] 0.9 restore: no legacy gateway connection (EventSource, WebSocket)`, !net.events.length && !legacyWs(net).length, JSON.stringify({ events: net.events.length, ws: legacyWs(net) }));
      const saved = { wins: JSON.parse(w.wins || 'null'), picks: JSON.parse(w.picks || '{}'), unified: JSON.parse(w.unified || 'null') };
      // (unify: moved once into the copied window, the old keys kept for a layer-off restart; chatroute deleted them)
      check(`[${tag}] 0.9 restore: saved state moved once (vo.chat.unified.v1), old keys kept`, saved.unified?.done === true && JSON.stringify(saved.wins) === JSON.stringify(V09['vo.chat.windows']) && saved.picks.primary?.selectedAgentKey === 'main', JSON.stringify(saved));
      if (!phone) check(`[${tag}] 0.9 restore: the copied window chats`, w.copied.length && await chats(page, 'chatroute hello'), (await thread(page)).slice(-120));
      // a reload keeps it so (the copied window comes back by itself; still no legacy window or connection)
      net.events.length = 0;
      await page.reload({ waitUntil: 'domcontentloaded' });
      const r = await until(page, x => x.copied.length > 0, 25000);
      await sleep(1500);
      const r2 = await look(page);
      check(`[${tag}] reload: copied window back, no office window, no legacy connection`, r.copied.includes('Main') && !r2.office.length && !net.events.length && !r2.deadText, JSON.stringify({ c: r2.copied, o: r2.office, e: net.events.length }));
      check(`[${tag}] no page errors`, !errors.length, errors.slice(0, 2).join(' | '));
    } finally { await browser.close(); }
  }
  // 2. 0.9, the main window on the default agent (nothing chosen) -> the same
  {
    const { browser, page, net } = await session({ phone, seed: V09_DEFAULT });
    try {
      await until(page, x => x.copied.length > 0, 25000);
      await sleep(2000);
      const w = await look(page);
      check(`[${tag}] 0.9 default "main": copied window, no office window, no legacy connection`, w.copied.includes('Main') && !w.office.length && !w.deadText && !net.events.length, JSON.stringify({ c: w.copied, o: w.office, e: net.events.length }));
    } finally { await browser.close(); }
  }
  // 3. layer-only office, fresh browser: the Chat button opens the copied window (the most recent chat, or the first agent);
  //    again: put away; desk menu / agent list (openForAgent) -> copied window
  {
    const { browser, page, net } = await session({ phone });
    try {
      await page.waitForFunction(() => window.voPLReady, null, { timeout: 15000 });
      await page.evaluate(async () => { await window.voPLReady; });
      await sleep(800);
      const btn = await clickChat(page);
      const w = await until(page, x => x.copied.length > 0, 15000);
      check(`[${tag}] layer-only office: Chat button -> copied window, no office window`, w.copied.length === 1 && !w.office.length && !w.deadText, `${btn} ${JSON.stringify({ c: w.copied, o: w.office })}`);
      await clickChat(page);
      const away = await until(page, x => !x.copied.length, 8000);
      check(`[${tag}] layer-only office: Chat button again puts it away`, !away.copied.length && !away.office.length, JSON.stringify(away.copied));
      await page.evaluate(() => window.VirtualOfficeChat.openForAgent('ops'));
      const o = await until(page, x => x.copied.includes('Ops'), 15000);
      check(`[${tag}] openForAgent (desk menu, agent list) -> copied window`, o.copied.includes('Ops') && !o.office.length, JSON.stringify(o.copied));
      check(`[${tag}] layer-only office: no legacy gateway connection`, !net.events.length && !legacyWs(net).length, String(net.events.length));
    } finally { await browser.close(); }
  }
  // 4. mixed office, 0.9 with two windows (Coda's and the OpenClaw agent's in front). unify: no office window at all; the
  //    OpenClaw agent's chat moves to the copied window; Coda (an office row the layer does not list: it cannot chat in
  //    any window here) waits for the next load, its saved state kept
  {
    const { browser, page, net } = await session({ phone, seed: V09_MIXED, mixed: true });
    try {
      await until(page, x => x.copied.length > 0, 25000);
      await sleep(2000);
      const w = await look(page);
      const saved = JSON.parse(w.wins || 'null');
      const codaKept = (saved?.wins || []).some(s => s.slot === 'secondary-1') && JSON.parse(w.picks || '{}')['secondary-1']?.selectedAgentKey === 'coda-lab';
      check(`[${tag}] mixed 0.9 restore: OpenClaw agent -> copied window`, w.copied.includes('Main') && !w.office.some(o => o.agent === 'main'), JSON.stringify(w));
      await until(page, x => !!x.unified, 15000);   // (the layer is given 8 s to list Coda)
      const u = JSON.parse((await look(page)).unified || 'null');
      check(`[${tag}] mixed 0.9 restore: no office window; Coda's saved window kept and pending (the layer does not list it)`, codaKept && !w.office.length && (u?.pending || []).includes('secondary-1'), JSON.stringify({ office: w.office, saved, u }));
      check(`[${tag}] mixed: no legacy gateway connection`, !net.events.length && !legacyWs(net).length && !w.deadText, String(net.events.length));
    } finally { await browser.close(); }
  }
  // 5. mixed office, fresh browser. unify: the Chat button opens the copied window (never an office window on Coda);
  //    Coda asked for by name (desk menu) is a toast, never the old window
  {
    const { browser, page, net } = await session({ phone, mixed: true });
    try {
      await page.evaluate(async () => { await window.voPLReady; });
      await sleep(800);
      await clickChat(page);
      const w = await until(page, x => x.copied.length > 0, 15000);
      check(`[${tag}] mixed: Chat button -> copied window, no office window`, w.copied.length === 1 && !w.office.length, JSON.stringify(w));
      const r = await page.evaluate(() => window.VirtualOfficeChat.openForAgent('coda-lab'));
      const toast = await page.evaluate(() => document.body.innerText.includes("Coda can't chat right now"));
      const p2 = await look(page);
      check(`[${tag}] mixed: Coda (not listed by the layer) -> a toast, never the office window`, r === null && toast && !p2.office.length, JSON.stringify({ r, toast, o: p2.office }));
      check(`[${tag}] mixed: no legacy gateway connection, no dead status`, !net.events.length && !legacyWs(net).length && !p2.deadText && !p2.officeConnecting, JSON.stringify(p2.office));
    } finally { await browser.close(); }
  }
}

async function offCases(phone) {
  const tag = phone ? 'phone 412' : 'desktop 1600';
  const { browser, page, net } = await session({ phone, seed: V09 });
  try {
    const w = await until(page, x => x.office.length > 0, 20000);
    await sleep(3000);
    const w2 = await look(page);
    const pl = await page.evaluate(async () => !!(await window.voPLReady));
    check(`[${tag}] layer off: no copied layer`, !pl && !w2.copied.length, String(pl));
    check(`[${tag}] layer off: 0.9's office window comes back on the OpenClaw agent, as before`, w.office.some(o => o.slot === 'primary' && o.agent === 'main'), JSON.stringify(w2.office));
    check(`[${tag}] layer off: the office's own gateway proxy is used, as before`, net.events.length > 0, String(net.events.length));
  } finally { await browser.close(); }
}

const only = process.env.CR_ONLY || '';   // (desktop | phone: one half)
const sizes = [false, true].filter(phone => !only || only === (phone ? 'phone' : 'desktop'));
if (which === 'off') {
  for (const phone of sizes) await offCases(phone);
} else {
  await ensureOpenClaw();
  for (const phone of sizes) await layerCases(phone);
}
process.exit(summary(`pl_chatroute-${which}`));
