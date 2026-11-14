// Chat helpers for the hp e2e checks: open the office, open a chat with an agent, send, wait for the turn to end.
import { VO, sleep } from './hp_lib.mjs';

export async function openChat(page, agentId) {
  await page.goto(VO + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.VirtualOfficeChat && typeof window.VirtualOfficeChat.openForAgent === 'function', null, { timeout: 30000 });
  // close any first-run tour / overlay that sits over the office
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(id => window.VirtualOfficeChat.openForAgent(id), agentId);
  await page.waitForSelector('#chat-panel #chat-input', { state: 'visible', timeout: 20000 });
  await sleep(800);
}

// Start a fresh chat (new session) in the open window.
export async function newChat(page) {
  const btn = page.locator('#chat-new-session');
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click();
  // "Start a new session?" confirm (VOUI): press its Start button
  const ok = page.locator('button:visible', { hasText: /^Start/ }).last();
  await ok.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (await ok.count()) await ok.click();
  await page.waitForFunction(() => /No messages yet/.test(document.getElementById('chat-messages')?.innerText || ''), null, { timeout: 10000 }).catch(() => {});
  await sleep(500);
  return true;
}

export const turns = page => page.$$eval('#chat-messages > *', els => els.length);
export const lastText = page => page.evaluate(() => {
  const all = [...document.querySelectorAll('#chat-messages .chat-msg, #chat-messages [class*="msg"]')];
  return all.length ? all[all.length - 1].innerText.slice(-400) : '';
});
export const busy = page => page.evaluate(() => { const s = document.getElementById('chat-stop'); return !!s && !s.hidden && s.offsetParent !== null && getComputedStyle(s).display !== 'none'; });

export async function send(page, text, { key = 'Enter' } = {}) {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', key);
}

// Wait until the composer is idle (Stop hidden) and some text matched, or the timeout.
export async function waitIdle(page, ms = 45000) {
  const t0 = Date.now();
  await sleep(600);
  while (Date.now() - t0 < ms) {
    if (!(await busy(page))) { await sleep(500); if (!(await busy(page))) return true; }
    await sleep(400);
  }
  return false;
}

export async function waitText(page, re, ms = 45000) {
  return page.waitForFunction(src => new RegExp(src).test(document.getElementById('chat-messages').innerText), re.source, { timeout: ms }).then(() => true, () => false);
}
