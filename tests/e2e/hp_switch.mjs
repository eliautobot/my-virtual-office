// D2: legacy API-server row -> full Hermes (serve) switch on the Agent Providers page, with a fake legacy API server
// (FakeHermesHandler from tests/test_hermes_native_connections.py) as legacy row "astra" and lab a as the serve row.
// The office agent keeps its id, nothing shows twice, chat goes through lab a; then Switch back.
import { VO, check, launch, api, sleep, summary } from './hp_lib.mjs';
import { openChat, newChat, send, waitText } from './hp_chatlib.mjs';

const LEGACY = process.env.HPQA_LEGACY_ID || 'astra', SERVE = 'lab-a', PROFILE = 'default';
const { browser, page, errors } = await launch();
const roster = async () => { const d = (await api('/api/agents')).json; return (Array.isArray(d) ? d : d.agents || []).map(a => ({ id: a.id, name: a.name, cid: a.providerConnectionId || '', prof: a.providerAgentId || '', t: a.providerTransport || a.transport || '' })); };
const twice = list => { const seen = {}; const dup = []; for (const a of list) { if (a.cid !== SERVE) continue; const k = a.prof; if (seen[k]) dup.push(`${k}: ${seen[k]} + ${a.id}`); seen[k] = a.id; } return dup; };

try {
  // design 2.10: the legacy agent and the serve profile its API server answers for (/v1/models 'hermes-agent' = default)
  // never both show; the guess is probed in the background, so allow it a few seconds
  const shownTwice = list => list.some(a => a.id === 'hermes-' + LEGACY && a.cid === LEGACY) && list.some(a => a.cid === SERVE && a.prof === PROFILE);
  let before = await roster();
  for (let i = 0; i < 20 && shownTwice(before); i++) { await sleep(1000); before = await roster(); }
  console.log('roster before', before.map(a => `${a.id}(${a.cid}/${a.prof})`).join(' '));
  check('before the switch the profile does not show twice (legacy agent shown, serve default hidden)', before.some(a => a.id === 'hermes-' + LEGACY && a.cid === LEGACY) && !shownTwice(before),
    before.map(a => `${a.id}(${a.cid}/${a.prof})`).join(' '));
  await page.goto(VO + '/providers.html?provider=hermes', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`.ap-conn[data-id="${LEGACY}"]`, { timeout: 20000 });
  await page.click(`.ap-conn[data-id="${LEGACY}"]`);
  const banner = await page.waitForSelector('.ap-banner', { timeout: 10000 }).then(e => e.innerText()).catch(() => '');
  check('legacy row: banner offers the switch', /Switch to the full Hermes connection/.test(banner), banner.replace(/\s+/g, ' ').slice(0, 160));
  await page.click('.ap-banner button:has-text("Switch to the full Hermes connection")');
  await page.waitForSelector('.ap-switch-row', { timeout: 15000 });
  const rows = await page.$$eval('.ap-switch-row', els => els.map(r => ({ legacy: r.dataset.legacy, checked: r.querySelector('[data-role="move"]')?.checked, profile: r.querySelector('[data-role="profile"]')?.value, guess: !!r.querySelector('.ap-guess'), opts: [...(r.querySelector('[data-role="profile"]')?.options || [])].map(o => o.value) })));
  check('switch dialog: the legacy agent, a profile select', rows.length === 1 && rows[0].legacy === LEGACY && rows[0].opts.includes(PROFILE), JSON.stringify(rows));
  const sel = page.locator(`.ap-switch-row[data-legacy="${LEGACY}"] [data-role="profile"]`);
  if (await sel.count()) await sel.selectOption(PROFILE).catch(() => {});
  await page.locator('button:visible', { hasText: /^Switch$/ }).last().click();
  const toast = await page.waitForSelector('.ap-toast', { timeout: 15000 }).then(e => e.innerText()).catch(() => '');
  check('switch: toast names the agent', /now uses the full Hermes connection/.test(toast), toast);
  let after = []; const t0 = Date.now();
  while (Date.now() - t0 < 20000) { after = await roster(); if (after.some(a => a.id === 'hermes-' + LEGACY && a.cid === SERVE)) break; await sleep(1000); }
  const moved = after.find(a => a.id === 'hermes-' + LEGACY);
  check('switch keeps the agent id, now on the serve connection', moved && moved.cid === SERVE && moved.prof === PROFILE, JSON.stringify(moved || null));
  const dup = twice(after);
  const names = after.map(a => a.name); const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  check('after the switch nothing shows twice (roster)', dup.length === 0 && dupNames.length === 0 && !after.some(a => a.cid === LEGACY), `roster ${after.map(a => `${a.id}(${a.cid}/${a.prof})`).join(' ')}${dup.length ? ' DUP ' + dup.join(';') : ''}`);
  const prov = (await api('/api/agent-providers')).json.providers;
  const serveRow = prov.find(p => p.id === SERVE), legRow = prov.find(p => p.id === LEGACY);
  const listing = (serveRow.agents || []).map(a => `${a.id}:${a.nativeId}${a.hidden ? '(hidden)' : ''}`);
  check('Agent Providers: profile default listed once as the moved agent, legacy row switched', listing.filter(x => /:default/.test(x)).length === 1 && listing.some(x => x.startsWith('hermes-' + LEGACY + ':default')) && legRow && (legRow.enabled === false || (legRow.legacy || {}).replacedBy === SERVE),
    `serve listing [${listing.join(', ')}] legacy enabled=${legRow && legRow.enabled} legacy=${JSON.stringify(legRow && legRow.legacy)}`);
  // chat with the moved agent goes through lab a
  await openChat(page, 'hermes-' + LEGACY); await newChat(page);
  await send(page, 'hello after switch');
  const ok = await waitText(page, /Stub reply \d+ to: hello after switch/, 40000);
  check('moved agent chats through the serve connection', ok, ok ? 'stub reply via lab a' : (await page.evaluate(() => document.getElementById('chat-messages').innerText)).slice(-140));
  // switch back
  const back = await api('/api/agent-providers/switch-back', { method: 'POST', body: { legacyId: LEGACY, id: LEGACY } });
  await sleep(4000);
  const r2 = await roster();
  const a2 = r2.find(a => a.id === 'hermes-' + LEGACY);
  check('Switch back: same id on the older connection again', back.status === 200 && a2 && a2.cid === LEGACY, `${back.status} ${JSON.stringify(back.json).slice(0, 120)} -> ${JSON.stringify(a2 || null)}`);
  check('after Switch back the profile does not show twice', !shownTwice(r2), r2.map(a => `${a.id}(${a.cid}/${a.prof})`).join(' '));
  check('no page errors (switch)', errors.length === 0, errors.slice(0, 3).join(' ; '));
} catch (e) {
  check('switch script', false, e.message.split('\n')[0]);
} finally { await browser.close(); }
process.exit(summary('hp_switch') ? 1 : 0);
