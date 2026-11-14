// D2 Hermes settings menu on the Agent Providers page (temp office, lab a only): every tab reads, one config change
// with confirm (read back from the LAB's config.yaml), conflict message when the page is stale. Restores the value.
import fs from 'node:fs';
import { VO, LAB, check, launch, sleep, summary } from './hp_lib.mjs';

const FIELD = 'display.busy_input_mode';
const labCfg = () => (fs.readFileSync(LAB + '/a/home/config.yaml', 'utf8').match(/^\s*busy_input_mode:\s*(\S+)/m) || [])[1] || '(unset)';
const { browser, page, errors } = await launch();

async function openMenu(p, conn = 'lab-a') {
  await p.goto(VO + '/providers.html?provider=hermes', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.ap-tab, .ap-conn', { timeout: 20000 });
  const pick = p.locator(`.ap-conn[data-id="${conn}"]`);
  if (await pick.count()) { await pick.first().click(); await sleep(400); }
  await p.waitForSelector('.ap-tab', { timeout: 20000 });
}
async function openField(p) {
  await p.click('.ap-tab:text-is("Settings")');
  await p.waitForSelector('.pm-sec', { timeout: 20000 });
  for (const cat of await p.$$eval('.pm-sec', els => els.map(e => e.dataset.cat))) {
    await p.click(`.pm-sec[data-cat="${cat}"]`);
    if (await p.locator(`.pm-field[data-field="${FIELD}"]`).count()) return cat;
  }
  return '';
}
async function setAndSave(p, value) {
  await p.selectOption(`.pm-field[data-field="${FIELD}"] select`, value);
  await p.click('.pm-savebar button:has-text("Review and save")');
  const yes = p.locator('button:visible', { hasText: /^Save$/ }).last();
  await yes.waitFor({ state: 'visible', timeout: 8000 });
  const dlg = await p.evaluate(() => { const d = [...document.querySelectorAll('[role="dialog"], dialog')].find(e => e.offsetParent); return d ? d.innerText.replace(/\s+/g, ' ').slice(0, 160) : ''; });
  await yes.click();
  await sleep(1500);
  return dlg;
}

try {
  await openMenu(page);
  const tabs = await page.$$eval('.ap-tab', els => els.map(e => e.textContent.trim()));
  const bad = [];
  for (const t of tabs) {
    await page.click(`.ap-tab:text-is("${t}")`);
    await sleep(300);
    await page.waitForFunction(() => !/Loading|Reading/i.test((document.querySelector('.ap-pane') || document.body).innerText.slice(0, 200)), null, { timeout: 15000 }).catch(() => {});
    const info = await page.evaluate(() => { const p = document.querySelector('.ap-pane') || document.body; const errs = [...p.querySelectorAll('.ap-card.bad, .ap-err:not([hidden]), .pm-error')].filter(e => e.offsetParent).map(e => e.innerText.trim().slice(0, 90)); return { len: p.innerText.length, errs }; });
    if (info.len < 40 || info.errs.length) bad.push(`${t}: ${info.errs.join(' / ') || 'empty (' + info.len + ' chars)'}`);
  }
  check('Hermes menu: every tab reads', bad.length === 0 && tabs.length >= 8, `${tabs.length} tabs [${tabs.join(', ')}]${bad.length ? ' BAD ' + bad.join(' ; ') : ''}`);

  const before = labCfg();
  const cat = await openField(page);
  const target = before === 'queue' ? 'interrupt' : 'queue';
  const dlg = cat ? await setAndSave(page, target) : '';
  const after = labCfg();
  const toast = await page.evaluate(() => (document.querySelector('.ap-toast') || {}).innerText || '');
  check('one config change with confirm, written to the lab Hermes', cat && after === target && /busy_input_mode/.test(dlg), `section=${cat} lab ${before} -> ${after}; confirm="${dlg.slice(0, 110)}"; toast="${toast}"`);

  // stale: a second window changes the same setting back; this (stale) page then saves -> conflict message
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const p2 = await ctx2.newPage();
  await openMenu(p2); await openField(p2);
  await setAndSave(p2, before === '(unset)' ? 'interrupt' : before);
  const restored = labCfg();
  // the page still believes the value is `target`; save another option from it (reopen the section, no reload)
  if (!(await page.locator(`.pm-field[data-field="${FIELD}"] select`).count())) {
    if (!(await page.locator('.pm-sec').count())) await page.click('.ap-tab:text-is("Settings")');
    await page.click(`.pm-sec[data-cat="${cat}"]`);
  }
  const sel = await page.evaluate(f => { const e = document.querySelector(`.pm-field[data-field="${f}"] select`); return e ? { v: e.value, opts: [...e.options].map(o => o.value) } : null; }, FIELD);
  const other = sel && sel.opts.find(o => o && o !== sel.v && o !== target) || sel && sel.opts.find(o => o && o !== sel.v);
  console.log('stale page select', JSON.stringify(sel), '-> pick', other);
  if (other) await page.selectOption(`.pm-field[data-field="${FIELD}"] select`, other);
  await sleep(300);
  console.log('savebar', await page.evaluate(() => { const b = document.querySelector('.pm-savebar'); return b ? (b.hidden ? 'hidden' : b.innerText.replace(/\s+/g, ' ')) : 'none'; }));
  let conflict = '';
  try {
    await page.click('.pm-savebar button:has-text("Review and save")');
    await page.locator('button:visible', { hasText: /^Save$/ }).last().click();
    await page.waitForSelector('.pm-conflict:not([hidden])', { timeout: 10000 });
    conflict = await page.$eval('.pm-conflict', e => e.innerText.replace(/\s+/g, ' ').trim());
  } catch (e) { conflict = 'no conflict box: ' + e.message.split('\n')[0]; }
  check('stale save -> conflict message, nothing written', /changed elsewhere meanwhile/.test(conflict) && labCfg() === restored, `"${conflict.slice(0, 140)}" lab now ${labCfg()} (restored ${restored})`);
  await ctx2.close();
  const real = errors.filter(e => !/status of 409/.test(e));
  check('no page errors (menu; the expected 409 network line not counted)', real.length === 0, real.slice(0, 3).join(' ; '));
} catch (e) {
  check('menu script', false, e.message.split('\n')[0]);
} finally { await browser.close(); }
process.exit(summary('hp_menu') ? 1 : 0);
