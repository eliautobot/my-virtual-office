// D2 access checks on lab a: side panel tabs by caps with Full access; switch the connection to Chat only on the Agent
// Providers page -> menu has no write controls, the server refuses a write with its plain text, Screen/Files show their
// locked texts; then back to Full access.
import { VO, check, launch, api, sleep, summary } from './hp_lib.mjs';
import { openChat } from './hp_chatlib.mjs';

const AGENT = 'hermes-lab-a', CID = 'lab-a';
const { browser, page, errors } = await launch();

async function sidePanel(p) {
  await openChat(p, AGENT);
  const btn = p.locator('#chat-panel .hp-side-btn').first();
  const shown = await btn.isVisible().catch(() => false);
  if (!shown) return { shown, tabs: [] };
  await btn.click();
  await p.waitForSelector('.hp-side .hp-side-tab', { timeout: 10000 }).catch(() => {});
  const tabs = await p.$$eval('.hp-side .hp-side-tab', els => els.map(e => e.textContent.trim()));
  const locked = [], notes = []; let fileWrite = -1;
  for (const t of tabs) {
    await p.locator('.hp-side .hp-side-tab', { hasText: t }).first().click(); await sleep(400);
    const txt = await p.evaluate(() => [...document.querySelectorAll('.hp-side .hp-side-locked-text, .hp-side .hp-side-locked')].filter(e => e.offsetParent).map(e => e.innerText.replace(/\s+/g, ' ').trim()).join(' / ').slice(0, 200));
    const open = await p.locator('.hp-side .hp-side-open-providers:visible').count();
    if (txt) locked.push(`${t}: ${txt}${open ? ' [Open Agent Providers]' : ''}`);
    // a tab that reads but does not write (Files under Chat only) says so in a note; its write buttons are gone
    const note = await p.evaluate(() => [...document.querySelectorAll('.hp-side .hp-side-note')].filter(e => e.offsetParent).map(e => e.innerText.replace(/\s+/g, ' ').trim()).join(' / ').slice(0, 200));
    if (note) notes.push(`${t}: ${note}`);
    if (/Files/.test(t)) fileWrite = await p.locator('.hp-side .hp-fl-upload:visible, .hp-side .hp-fl-mkdir:visible').count();
  }
  return { shown, tabs, locked, notes, fileWrite };
}
async function setAccess(p, access) {
  await p.goto(VO + '/providers.html?provider=hermes', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.ap-tab', { timeout: 20000 });
  await p.click('.ap-tab:text-is("Connection")');
  await p.click('.ap-acts button:text("Edit")');
  await p.selectOption('.ap-form .apf[data-key="access"]', access);
  await p.click('.ap-form button[data-act="submit"]');
  await sleep(2500);
  const row = (await api('/api/agent-providers')).json.providers.find(x => x.id === CID);
  return row && row.access;
}

try {
  const full = await sidePanel(page);
  check('Full access: side panel tabs by caps', full.shown && full.tabs.includes('Tasks'), `tabs [${full.tabs.join(', ')}] locked [${full.locked.join(' ; ')}]`);
  check('Full access: Hermes side panel has Screen and Files with Upload / New folder (design 4.2/D1)', full.tabs.some(t => /Screen/.test(t)) && full.tabs.some(t => /Files/.test(t)) && full.fileWrite > 0 && !full.notes.length,
    `tabs [${full.tabs.join(', ')}] files write buttons ${full.fileWrite} notes [${full.notes.join(' ; ')}]; /can caps screen/files/computer = ` + JSON.stringify(Object.fromEntries(Object.entries((await api('/api/agent-chat/can?agent=' + AGENT)).json.caps || {}).filter(([k]) => /screen|files|computer/.test(k)))));

  const acc = await setAccess(page, 'chat');
  check('switch lab a to Chat only on the page', acc === 'chat', 'row access ' + acc);
  // menu: no write controls, a plain notice
  await page.click('.ap-tab:text-is("Settings")'); await sleep(800);
  const notice = await page.evaluate(() => (document.querySelector('.ap-pane') || document.body).innerText.match(/[^\n]*Chat only[^\n]*/)?.[0] || '');
  await page.locator('.pm-sec').first().click().catch(() => {}); await sleep(400);
  const writableList = await page.evaluate(() => [...document.querySelectorAll('.ap-pane input:not([disabled]), .ap-pane select:not([disabled]), .ap-pane textarea:not([disabled])')].filter(e => e.offsetParent && !/search|find|filter/i.test(e.placeholder + e.className + (e.getAttribute('aria-label') || ''))).map(e => `${e.tagName.toLowerCase()}.${String(e.className).split(' ').slice(0, 2).join('.')}[${e.getAttribute('aria-label') || e.closest('[data-field]')?.dataset.field || ''}]`));
  const writable = writableList.filter(d => !/pick|profile|pm-agent/i.test(d)).length;
  console.log('enabled inputs on Settings (Chat only):', writableList.join(' '));
  const writeBtns = [];
  for (const t of ['Models', 'Tools', 'Skills', 'Keys', 'Automations']) {
    if (!(await page.locator(`.ap-tab:text-is("${t}")`).count())) continue;
    await page.click(`.ap-tab:text-is("${t}")`); await sleep(700);
    const b = await page.evaluate(() => [...document.querySelectorAll('.ap-pane button')].filter(e => e.offsetParent && /^(Save|Set|Change|Switch on|Switch off|Create|Delete|Add|Use it|Review and save|Run now|Pause|Resume)\b/.test(e.innerText.trim())).map(e => e.innerText.trim().slice(0, 20)));
    if (b.length) writeBtns.push(`${t}: ${b.slice(0, 4).join(',')}`);
  }
  check('Chat only: menu shows no write controls, plain notice', writable === 0 && writeBtns.length === 0 && /Chat only/.test(notice), `notice="${notice.slice(0, 120)}" writable inputs ${writable}; write buttons [${writeBtns.join(' ; ')}]`);
  const refused = await api('/api/agent-providers/call', { method: 'POST', body: { id: CID, method: 'config.patch', params: { profile: 'default', changes: { 'display.busy_input_mode': 'queue' }, base: { 'display.busy_input_mode': 'interrupt' } } } });
  check('Chat only: server refuses a menu write with a plain text', refused.status === 403 && /Full access|Chat only/i.test(JSON.stringify(refused.json)), `${refused.status} ${JSON.stringify(refused.json).slice(0, 200)}`);
  const can = (await api('/api/agent-chat/can?agent=' + AGENT)).json;
  const co = await sidePanel(page);
  // design 3.6: Screen locked ("...the agent's screen needs Full access..."); Files stays to read, its writes locked with
  // "This connection has Chat only access: files on Hermes' computer are not changed from here." (no Upload / New folder)
  const screenLock = co.locked.find(l => /^Screen/.test(l)) || '';
  const filesNote = co.notes.find(l => /^Files/.test(l)) || '';
  check('Chat only: Screen locked with the plain text', /screen needs Full access/.test(screenLock) && /Open Agent Providers/.test(screenLock), screenLock || `tabs [${co.tabs.join(', ')}] locked []`);
  check('Chat only: Files read-only, writes locked with the plain text', co.tabs.some(t => /Files/.test(t)) && !co.locked.some(l => /^Files/.test(l)) && /Chat only access: files on Hermes' computer are not changed from here/.test(filesNote) && co.fileWrite === 0,
    `${filesNote || 'no note'} | write buttons ${co.fileWrite} | /can locked ${Object.keys(can.locked || {}).join(',')}`);
  check('Chat only: chat itself still works', can.ok && can.caps && can.caps.stream === true && can.caps.approvals === true, `access=${can.access}`);
} catch (e) {
  check('access script', false, e.message.split('\n')[0]);
} finally {
  const back = await setAccess(page, 'full').catch(e => 'restore failed: ' + e.message.split('\n')[0]);
  check('lab a back to Full access', back === 'full', 'row access ' + back);
  check('no page errors (access)', errors.filter(e => !/status of 403/.test(e)).length === 0, errors.slice(0, 3).join(' ; '));
  await browser.close();
}
process.exit(summary('hp_access') ? 1 : 0);
