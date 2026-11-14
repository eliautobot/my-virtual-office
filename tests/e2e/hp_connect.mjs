// D2 check 1: add lab a (Session token, Full access) on the Agent Providers page; agents = lab profiles.
import { VO, LAB_A, check, labToken, launch, api, sleep, summary } from './hp_lib.mjs';

const { browser, page, errors } = await launch();
const pre = await api('/api/agent-providers');
for (const p of (pre.json.providers || []).filter(p => p.kind === 'hermes' && p.transport === 'serve'))
  console.log('remove old', p.id, (await api('/api/agent-providers/remove', { method: 'POST', body: { id: p.id } })).status);
try {
  await page.goto(VO + '/providers.html?provider=hermes', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ps-provider-tab', { timeout: 15000 });
  const tabs = await page.$$eval('.ps-provider-tab', els => els.map(e => e.dataset.providerId + '=' + e.textContent.trim().slice(0, 20)));
  console.log('tabs', tabs.join(' | '));
  const addBtn = page.locator('button:has-text("Add a connection")').first();
  if (await addBtn.count()) await addBtn.click();
  await page.waitForSelector('.apf[data-key="url"]');
  const typeRadio = page.locator('input[name="ap-type"][value="hermes:serve"], input[name="ap-type"][value="serve"]');
  if (await typeRadio.count()) await typeRadio.first().check();
  const name = page.locator('.apf[data-key="name"]');
  if (await name.count()) await name.fill('Lab A');
  await page.fill('.apf[data-key="url"]', LAB_A);
  await page.selectOption('.apf[data-key="auth"]', 'token');
  await page.fill('.apf[data-key="token"]', labToken());
  await page.selectOption('.apf[data-key="access"]', 'full');
  await page.click('.ap-form button[data-act="test"]');
  await page.waitForFunction(() => { const s = document.querySelector('.ap-form-status'); return s && s.textContent.trim() && !/^Testing/.test(s.textContent.trim()); }, null, { timeout: 20000 });
  const testText = await page.$eval('.ap-form-status', e => e.textContent.trim());
  check('add lab a: Test before saving', /connect|ok|reach|hermes/i.test(testText) && !/fail|refus|could not/i.test(testText), testText);
  await page.click('.ap-form button[data-act="submit"]');
  // a switch dialog may open after the first Connect when legacy rows match (none here)
  const t0 = Date.now();
  const caught = await page.waitForFunction(() => document.querySelectorAll('.ap-agent').length >= 4, null, { timeout: 20000 }).then(() => true, () => false);
  check('page catches up after Connect (agents shown without reload)', caught, caught ? `${Date.now() - t0} ms` : 'still ' + await page.evaluate(() => (document.querySelector('.ap-card h4') || {}).textContent || '') + ' after 20 s');
  if (!caught) { await page.reload(); await page.waitForSelector('.ap-agent', { timeout: 15000 }).catch(() => {}); }
  const pill = await page.evaluate(() => (document.querySelector('.ap-pill, .ap-status, .ap-state') || {}).textContent || '');
  const tag = await page.evaluate(() => (document.querySelector('.ap-tag') || {}).textContent || '');
  const body = await page.evaluate(() => document.body.innerText);
  check('add lab a: connected, Full access tag', /Connected/.test(pill + body) && /Full access/.test(tag), `pill="${pill.trim()}" tag="${tag.trim()}"`);
  const rows = await api('/api/agent-providers');
  const conn = (rows.json.providers || []).find(p => p.kind === 'hermes' && p.transport === 'serve');
  const agents = (conn && conn.agents || []).map(a => a.nativeId || a.profile || a.id);
  check('lab a row: access full, state connected', conn && conn.access === 'full' && conn.status && conn.status.state === 'connected',
    conn ? `id=${conn.id} access=${conn.access} state=${conn.status && conn.status.state} code=${conn.status && conn.status.code}` : 'no serve row');
  const want = ['default', 'quill', 'research', 'scout'];
  check('agents = lab profiles', want.every(p => agents.includes(p)) && agents.length === want.length, 'agents ' + agents.join(','));
  const ui = await page.$$eval('.ap-agent, .ap-agents li, .ap-agent-row', els => els.map(e => e.textContent.trim().slice(0, 40)));
  check('Agent Providers page lists the profiles', ui.length >= 4, ui.join(' | '));
  const secretLeak = JSON.stringify(rows.json).includes(labToken());
  check('token never sent back to the page', !secretLeak, secretLeak ? 'token found in /api/agent-providers' : 'not in the row');
  check('no page errors (connect)', errors.length === 0, errors.slice(0, 3).join(' ; '));
} catch (e) {
  check('connect script', false, e.message.split('\n')[0]);
} finally { await browser.close(); }
process.exit(summary('hp_connect') ? 1 : 0);
