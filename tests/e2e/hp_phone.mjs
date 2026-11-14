// D2 phone 412x915: chat, an approval card, side panel, sessions drawer, Agent Providers page. Programmatic geometry
// (no sideways scroll, inside the screen, tap targets >= 44 px); two small JPEG crops for the log.
import { VO, check, launch, sleep, summary, crop } from './hp_lib.mjs';
import { openChat, newChat, send, waitText, waitIdle } from './hp_chatlib.mjs';

const AGENT = process.env.HPQA_AGENT || 'hermes-lab-a-research';
const W = 412, H = 915;
// never a lab profile wired to a real model (lab quill/scout use OpenRouter in the copied MVW lab)
if (/quill|scout/.test(AGENT)) throw new Error('refusing ' + AGENT + ': not on the stub model');
const { browser, page, errors } = await launch({ phone: true });
const box = (sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e || !e.offsetParent && getComputedStyle(e).position !== 'fixed') return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);
const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const small = (root) => page.evaluate(r => [...document.querySelectorAll(r + ' button, ' + r + ' a, ' + r + ' select, ' + r + ' [role="tab"]')].filter(e => e.offsetParent && getComputedStyle(e).visibility !== 'hidden').map(e => { const b = e.getBoundingClientRect(); return { t: (e.innerText || e.getAttribute('aria-label') || e.className).trim().replace(/\s+/g, ' ').slice(0, 18), w: Math.round(b.width), h: Math.round(b.height), out: b.right > window.innerWidth + 1 || b.left < -1 }; }).filter(x => x.w > 0 && (x.h < 44 || x.out)), root);

try {
  await openChat(page, AGENT); await newChat(page);
  const panel = await box('#chat-panel');
  check('phone: chat fills the screen, no sideways scroll', panel && panel.x <= 0 && panel.w >= W - 1 && (await sideways()) <= 0, `panel ${JSON.stringify(panel)} sideways ${await sideways()}`);
  const comp = await box('#chat-input');
  check('phone: composer inside the screen', comp && comp.y + comp.h <= H && comp.x >= 0 && comp.x + comp.w <= W, JSON.stringify(comp));
  await page.fill('#chat-input', '[[tool:terminal {"command":"rm -rf /tmp/vo8095-hpqa/phone-scratch"}]] phone card');
  await page.click('#chat-send');
  const shown = await page.waitForSelector('#chat-messages button:has-text("Allow once")', { timeout: 40000 }).then(() => true, () => false);
  const card = await page.evaluate(() => { const b = [...document.querySelectorAll('#chat-messages button')].find(x => /Allow once/.test(x.innerText)); const c = b && b.closest('.hp-card'); if (!c) return null; c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), btns: [...c.querySelectorAll('button')].map(x => { const q = x.getBoundingClientRect(); return `${x.innerText.trim()}:${Math.round(q.width)}x${Math.round(q.height)}${q.right > window.innerWidth ? '(OUT)' : ''}`; }) }; });
  const cardSmall = await small('#chat-messages .hp-card');
  check('phone: approval card inside the screen, 4 buttons >= 44 px', !!card && shown && card && card.x >= 0 && card.x + card.w <= W && card.btns.length >= 4 && cardSmall.length === 0, `${JSON.stringify(card)}${cardSmall.length ? ' small ' + JSON.stringify(cardSmall) : ''}`);
  if (card) await crop(page, 'phone-card', { x: 0, y: Math.max(0, (await page.evaluate(() => document.querySelector('#chat-messages .hp-card').getBoundingClientRect().y)) - 20), width: W, height: 360 });
  if (shown) { await page.click('#chat-messages button:has-text("Deny")'); await waitText(page, /Denied/, 15000); await waitIdle(page, 30000); }
  // side panel: full-screen sheet with Back
  const sbtn = page.locator('#chat-panel .hp-side-btn').first();
  if (await sbtn.isVisible().catch(() => false)) {
    await sbtn.click(); await sleep(800);
    const sheet = await page.evaluate(() => { const e = document.querySelector('.hp-side'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cls: e.className.slice(0, 60), back: !!e.querySelector('.hp-side-back') && e.querySelector('.hp-side-back').offsetParent !== null }; });
    const sSmall = await small('.hp-side');
    check('phone: side panel is a full-screen sheet with Back, targets >= 44 px', sheet && sheet.x <= 1 && sheet.w >= W - 1 && sheet.h >= H - 60 && sheet.back && sSmall.length === 0, `${JSON.stringify(sheet)}${sSmall.length ? ' small ' + JSON.stringify(sSmall.slice(0, 5)) : ''}`);
    await crop(page, 'phone-side', { x: 0, y: 0, width: W, height: 420 });
    await page.locator('.hp-side .hp-side-back').first().click().catch(() => {});
    await sleep(500);
  } else check('phone: side panel button shown', false, 'no .hp-side-btn visible');
  // sessions drawer
  const tg = await box('#chat-sessions-toggle');
  await page.click('#chat-sessions-toggle').catch(e => console.log('toggle click', e.message.split('\n')[0]));
  await sleep(800);
  const drawer = await box('#chat-panel .chat-sessions-panel.open, .chat-sessions-panel.open');
  const dSmall = await small('.chat-sessions-panel.open');
  check('phone: sessions drawer as a sheet, rows inside, targets >= 44 px', !!drawer && drawer.x <= 1 && drawer.w >= W - 1 && dSmall.length === 0 && (await sideways()) <= 0, `${JSON.stringify(drawer)} small ${dSmall.length}${dSmall.length ? ' small ' + JSON.stringify(dSmall.slice(0, 5)) : ''}`);
  // Agent Providers page
  await page.goto(VO + '/providers.html?provider=hermes', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ap-tab', { timeout: 20000 });
  await sleep(800);
  const pick = await box('.ap-pick');
  const apSmall = await small('.ap-pane, .ap-head');
  check('phone: Agent Providers page, no sideways scroll, list becomes a select, targets >= 44 px', (await sideways()) <= 0 && pick && pick.w > 100 && apSmall.length === 0, `pick ${JSON.stringify(pick)} sideways ${await sideways()}${apSmall.length ? ' small ' + JSON.stringify(apSmall.slice(0, 6)) : ''}`);
  for (const t of ['Settings', 'Models', 'Keys']) {
    await page.click(`.ap-tab:text-is("${t}")`).catch(() => {}); await sleep(900);
    const sw = await sideways(); if (sw > 0) check(`phone: ${t} tab no sideways scroll`, false, 'scrollWidth over by ' + sw);
  }
  check('no page errors (phone)', errors.length === 0, errors.slice(0, 3).join(' ; '));
} catch (e) {
  check('phone script', false, e.message.split('\n')[0]);
} finally { await browser.close(); }
process.exit(summary('hp_phone') ? 1 : 0);
