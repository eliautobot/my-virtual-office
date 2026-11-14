// D2: add lab b in Password mode on the Agent Providers page -> signs in, the password is not stored, the sign-in
// tokens are kept (survive an office-side reconnect).
import fs from 'node:fs';
import path from 'node:path';
import { VO, LAB_B, check, labPassword, launch, api, sleep, summary } from './hp_lib.mjs';

const DATA = process.env.HPQA_DATA || '/tmp/vo8095-hpqa/data';
const { browser, page, errors } = await launch();
const pre = await api('/api/agent-providers');
for (const p of (pre.json.providers || []).filter(p => p.transport === 'serve' && /19229/.test(JSON.stringify(p.fields || {}))))
  console.log('remove old', p.id, (await api('/api/agent-providers/remove', { method: 'POST', body: { id: p.id } })).status);

function grepData(needle) {
  const hits = [];
  const walk = d => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); const st = fs.statSync(f);
    if (st.isDirectory()) walk(f); else if (st.size < 5e6 && fs.readFileSync(f).includes(needle)) hits.push(f.slice(DATA.length + 1)); } };
  walk(DATA); return hits;
}

try {
  await page.goto(VO + '/providers.html?provider=hermes', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ap-tab, .ap-conn', { timeout: 20000 });
  await page.locator('button:has-text("Add a connection")').first().click();
  await page.waitForSelector('.apf[data-key="url"]');
  const typeRadio = page.locator('input[name="ap-type"][value="hermes:serve"]');
  if (await typeRadio.count()) await typeRadio.check();
  if (await page.locator('.apf[data-key="name"]').count()) await page.fill('.apf[data-key="name"]', 'Lab B');
  await page.fill('.apf[data-key="url"]', LAB_B);
  await page.selectOption('.apf[data-key="auth"]', 'password');
  await page.fill('.apf[data-key="username"]', 'lab');
  await page.fill('.apf[data-key="password"]', labPassword());
  await page.selectOption('.apf[data-key="access"]', 'full');
  await page.click('.ap-form button[data-act="test"]');
  await page.waitForFunction(() => { const s = document.querySelector('.ap-form-status'); return s && s.textContent.trim() && !/^Testing/.test(s.textContent.trim()); }, null, { timeout: 30000 });
  const testText = await page.$eval('.ap-form-status', e => e.textContent.trim());
  check('lab b (password): Test signs in', /Connected|signed in/i.test(testText) && !/fail|wrong|refus/i.test(testText), testText);
  const pwBox = await page.inputValue('.apf[data-key="password"]').catch(() => '');
  await page.click('.ap-form button[data-act="submit"]');
  let row = null; const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    row = ((await api('/api/agent-providers')).json.providers || []).find(p => p.transport === 'serve' && /19229/.test(JSON.stringify(p.fields || {})));
    if (row && row.status && row.status.state === 'connected') break;
    await sleep(1000);
  }
  check('lab b (password): connects, profiles listed', row && row.status.state === 'connected' && (row.agents || []).length === 4,
    row ? `id=${row.id} state=${row.status.state} code=${row.status.code || ''} agents=${(row.agents || []).map(a => a.nativeId).join(',')}` : 'no row');
  const formAfter = await page.locator('.apf[data-key="password"]').count() ? await page.inputValue('.apf[data-key="password"]').catch(() => '') : '';
  const pwHits = grepData(labPassword());
  check('password not stored (data dir, row, form cleared)', pwHits.length === 0 && !JSON.stringify(row || {}).includes(labPassword()) && !formAfter,
    `files with it: [${pwHits.join(', ')}]; secrets ${JSON.stringify(row && row.secrets)}; box before submit ${pwBox ? 'filled' : 'empty'}, after ${formAfter ? 'still filled' : 'empty'}`);
  check('sign-in tokens kept', row && row.secrets && row.secrets.tokens === true, 'secrets ' + JSON.stringify(row && row.secrets));
  // the office reconnects with its kept tokens (no password any more)
  const rc = await api('/api/agent-providers/reconnect', { method: 'POST', body: { id: row.id } });
  let st = ''; const t1 = Date.now();
  while (Date.now() - t1 < 20000) { await sleep(1000); const r = ((await api('/api/agent-providers')).json.providers || []).find(p => p.id === row.id); st = r && r.status.state; if (st === 'connected') break; }
  check('reconnect with kept tokens only', rc.status === 200 && st === 'connected', `reconnect ${rc.status} -> ${st}`);
  // edit form says the password is not needed (signed in)
  await page.goto(VO + '/providers.html?provider=hermes', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ap-conn', { timeout: 15000 });
  const pick = page.locator(`.ap-conn[data-id="${row.id}"]`);
  if (await pick.count()) await pick.click();
  await page.click('.ap-tab:text-is("Connection")').catch(() => {});
  await page.click('.ap-acts button:text("Edit")');
  const ph = await page.getAttribute('.apf[data-key="password"]', 'placeholder').catch(() => '');
  const pwShown = await page.locator('.ap-f[data-key="password"]').isVisible().catch(() => false);
  check('Edit form: no password needed once signed in', !pwShown || /Not needed|signed in/i.test(ph || ''), `password field ${pwShown ? 'shown, placeholder "' + ph + '"' : 'hidden'}`);
  check('no page errors (password)', errors.length === 0, errors.slice(0, 3).join(' ; '));
} catch (e) {
  check('password script', false, e.message.split('\n')[0]);
} finally { await browser.close(); }
process.exit(summary('hp_password') ? 1 : 0);
