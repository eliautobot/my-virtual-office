// v0.11 plhapi real check: a Hermes API-server connection (0.7.x, a vo-config.json hermes.connections row) beside the
// copied OpenClaw + Hermes layer, against labs only. One Chrome at a time.
//   layer    an office started with the layer ON and an API-server row (tests/tools/pl-office.sh with PL_GATEWAY_URL at
//            a lab OpenClaw): (a) roster = the lab's OpenClaw agents + the API-server agent; (b) the API-server agent
//            opens the OFFICE's own chat window: send, streamed answer, history after a reload, stop; (c) an OpenClaw
//            agent opens the copied window and answers; (d) Agent Providers' "Hermes API server (older connection)"
//            section and its hint, its Chat button opens the office's window; (f) 0 page errors, 0 server tracebacks.
//   restart  (e) an office of its own (0.10.1 data: the API-server row + the lab OpenClaw as the office's gateway)
//            first started with the layer OFF (a turn with the API-server agent), then restarted with it ON: the
//            API-server agent keeps its desk, its chat and its history; the OpenClaw agents move to the layer.
// Usage (labs: tests/tools/lab-openclaw.sh, tests/tools/lab-hermes-api.sh; office: tests/tools/pl-office.sh):
//   VO_URL=http://127.0.0.1:<p> VO_LOG=<office>/logs/server.log LAB_OC=<oc lab> LAB_HAPI=<hapi lab> HAPI_PORT=<p> \
//   PL_B_ROOT=<scratch> PL_B_PORT=<p> node tests/e2e/pl_hapi.mjs [layer|restart|all]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { check, summary, sleep } from './pl_lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || require('node:path').join(require('node:os').homedir(), '.hermes/hermes-agent/node_modules/playwright-core'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] || 'all';
const VO_A = process.env.VO_URL || 'http://127.0.0.1:18720';
const LOG_A = process.env.VO_LOG || '';
const LAB_OC = process.env.LAB_OC || '/tmp/vo-openclaw-lab';
const OC_PORT = process.env.LAB_OC_PORT || '19690';
const LAB_HAPI = process.env.LAB_HAPI || '/tmp/vo-hermes-api-lab';
const HAPI_PORT = process.env.HAPI_PORT || '19236';
const B_ROOT = process.env.PL_B_ROOT || '/tmp/vo-pl-hapi-restart';
const B_PORT = process.env.PL_B_PORT || '18730';
const AGENT = 'hermes-astra';
for (const p of [8085, 8088, 8090, 8095, 8096, 8097, 8099, 18789, 8642, 8954, 8977, 9128]) {
  for (const u of [VO_A, `:${B_PORT}`, `:${OC_PORT}`, `:${HAPI_PORT}`]) if (u.endsWith(`:${p}`)) throw new Error(`refusing a real service port ${p}`);
}

async function api(base, p) {
  const r = await fetch(base + p); let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: j };
}
const roster = async base => (await api(base, '/agents-list')).body?.agents || [];
async function until(fn, ms, every = 700) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(every); }
}
const tracebacks = file => { try { return (fs.readFileSync(file, 'utf8').match(/Traceback \(most recent call last\)/g) || []).length; } catch { return -1; } };

/** One headless Chrome on the office page (layer: wait for the copied layer to mount). Close it in a finally. */
async function browse(base, { layer = true } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror ${e.message} @ ${String(e.stack || '').split('\n')[1]?.trim() || ''}`));
  page.on('response', async r => {
    if (r.status() < 500) return;
    let b = ''; try { b = (await r.text()).slice(0, 120); } catch { /* gone */ }
    errors.push(`HTTP ${r.status()} ${r.url().slice(0, 80)} -> ${b}`);
  });
  await load(page, base, { layer });
  return { browser, page, errors };
}
async function load(page, base, { layer = true, reload = false } = {}) {
  if (reload) await page.reload({ waitUntil: 'domcontentloaded' }); else await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.VOOffice && window.VirtualOfficeChat && typeof window.VirtualOfficeChat.openForAgent === 'function', null, { timeout: 30000 });
  if (layer && !(await page.evaluate(async () => !!(await window.voPLReady)))) throw new Error('the copied layer did not mount');
  for (let k = 0; k < 3; k++) { await page.keyboard.press('Escape'); await sleep(120); }
}

// ---------------------------------------------------------------- the office's own window (#chat-panel)
const own = {
  text: page => page.evaluate(() => document.getElementById('chat-messages')?.innerText || ''),
  busy: page => page.evaluate(() => { const s = document.getElementById('chat-stop'); return !!s && !s.hidden && s.offsetParent !== null && getComputedStyle(s).display !== 'none'; }),
  lastReply: page => page.evaluate(() => { const m = [...document.querySelectorAll('#chat-messages .chat-msg')]; return m.length ? m[m.length - 1].innerText : ''; }),
  async open(page, id) {   // (the desk's agent menu, Chat)
    const found = await page.waitForFunction(i => window.VOOffice.openAgent(i, 'chat'), id, { timeout: 30000, polling: 1000 }).then(() => true, () => false);
    const shown = await page.waitForSelector('#chat-panel #chat-input', { state: 'visible', timeout: 20000 }).then(() => true, () => false);
    await sleep(900);
    return found && shown;
  },
  async send(page, text) { await page.fill('#chat-input', text); await page.press('#chat-input', 'Enter'); },
  async idle(page, ms = 60000) {
    const end = Date.now() + ms; await sleep(600);
    while (Date.now() < end) { if (!(await own.busy(page))) { await sleep(500); if (!(await own.busy(page))) return true; } await sleep(300); }
    return false;
  },
  waitText: (page, re, ms = 60000) => until(async () => re.test(await own.text(page)), ms, 300),
};
const copiedOpen = page => page.evaluate(() => { const w = document.querySelector('.chat-back:not(.min) .chatwin'); return !!w && w.getBoundingClientRect().width > 0; });
const ownOpen = page => page.evaluate(() => {   // (#chat-panel is position: fixed: no offsetParent)
  const i = document.querySelector('#chat-panel #chat-input'), r = i && i.getBoundingClientRect();
  return !!r && r.width > 0 && r.height > 0 && getComputedStyle(document.getElementById('chat-panel')).visibility !== 'hidden';
});
const ownAgent = page => page.evaluate(() => {
  const s = document.querySelector('#chat-panel select'); if (s && s.value) return s.value;
  return document.querySelector('#chat-panel [data-agent-id]')?.dataset.agentId || document.getElementById('chat-panel')?.dataset.agentId || '';
});

/** (b) send, a streamed answer (the reply grows while Stop shows), the turn ends. */
async function streamedTurn(page, marker) {
  await own.send(page, `[[slow:120]] [[long:2]] ${marker}`);
  const seen = new Set(); let busySeen = false;
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const b = await own.busy(page); busySeen ||= b;
    const t = await own.text(page);
    if (b && t.includes(marker)) seen.add(t.length);
    if (busySeen && !b) break;
    await sleep(150);
  }
  const done = await own.idle(page, 30000);
  const all = await own.text(page);
  return { grew: seen.size, busySeen, done, answered: /stub reply|lorem|paragraph/i.test(all.split(marker).slice(1).join(marker)) || all.split(marker).length > 2, tail: all.slice(-160) };
}
/** (b) stop: a long, slow answer stops at Stop and stays stopped. */
async function stopTurn(page, marker) {
  await own.send(page, `[[slow:350]] [[long:8]] ${marker}`);
  const started = await until(async () => (await own.busy(page)) && (await own.lastReply(page)).length > 20 && !(await own.lastReply(page)).includes(marker), 30000, 250);
  await page.click('#chat-stop').catch(() => page.evaluate(() => document.getElementById('chat-stop')?.click()));
  const stopped = await own.idle(page, 15000);
  const a = (await own.text(page)).length; await sleep(4000); const b = (await own.text(page)).length;
  return { started: !!started, stopped, still: a === b, a, b };
}

// ---------------------------------------------------------------- layer: (a) (b) (c) (d) (f)
async function layerChecks() {
  const tb0 = tracebacks(LOG_A);
  const rows = await until(async () => { const r = await roster(VO_A); return ['main', 'ops', AGENT].every(id => r.some(x => (x.key || x.id) === id)) ? r : null; }, 60000, 1500) || await roster(VO_A);
  const kinds = Object.fromEntries(rows.map(r => [r.key || r.id, r.providerKind]));
  check('(a) office roster: lab OpenClaw main + ops and the API-server agent', kinds.main === 'openclaw' && kinds.ops === 'openclaw' && kinds[AGENT] === 'hermes', JSON.stringify(kinds));
  const { browser, page, errors } = await browse(VO_A);
  try {
    const desks = await page.waitForFunction(ids => ids.every(i => window.VOOffice.focusAgent(i)), ['main', 'ops', AGENT], { timeout: 30000, polling: 1000 }).then(() => true, () => false);
    const gates = await page.evaluate(ids => ids.map(i => window.voPL.isLayerAgent(i)), ['main', 'ops', AGENT]);
    check('(a) desks in the office for main, ops and Astra; only the OpenClaw ones are layer agents', desks && gates.join() === 'true,true,false', `desks ${desks} gates ${gates}`);

    // (b) the API-server agent opens the office's own window
    const opened = await own.open(page, AGENT);
    const where = { own: await ownOpen(page), copied: await copiedOpen(page), agent: await ownAgent(page) };
    check('(b) Astra opens the office\'s own chat window (not the copied one)', opened && where.own && !where.copied && (!where.agent || where.agent === AGENT), JSON.stringify(where));
    const s = await streamedTurn(page, 'plhapi-stream-1');
    check('(b) send -> streamed answer from the lab API server', s.busySeen && s.grew >= 3 && s.done && s.answered, `grew ${s.grew} busy ${s.busySeen} done ${s.done} | ${s.tail}`);
    await load(page, VO_A, { reload: true });
    await own.open(page, AGENT);
    const hist = await own.waitText(page, /plhapi-stream-1[\s\S]+\S/, 20000);
    const htxt = await own.text(page);
    check('(b) history after a reload (question and answer)', hist && (htxt.match(/plhapi-stream-1/g) || []).length >= 1 && htxt.length > 120, htxt.replace(/\s+/g, ' ').slice(-140));
    const st = await stopTurn(page, 'plhapi-stop-1');
    check('(b) Stop ends a running answer and it stays stopped', st.started && st.stopped && st.still, JSON.stringify(st));
    const after = await (async () => { await own.send(page, 'plhapi-after-stop'); const ok = await own.waitText(page, /plhapi-after-stop[\s\S]*Stub reply/i, 45000); await own.idle(page); return ok; })();
    check('(b) the next turn after Stop answers', after, (await own.text(page)).replace(/\s+/g, ' ').slice(-120));

    // (c) an OpenClaw agent opens the copied window and answers
    await page.evaluate(() => window.VOOffice.openAgent('main', 'chat'));
    const cw = await page.waitForSelector('.chat-back:not(.min) .chatwin', { timeout: 20000 }).then(() => true, () => false);
    const name = await page.evaluate(() => document.querySelector('.chat-back:not(.min) .cw-name')?.textContent || '');
    check('(c) Main opens the copied window', cw && name === 'Main', name);
    await page.fill('.chat-back:not(.min) .cw-in', 'plhapi-oc-hello');
    await page.keyboard.press('Enter');
    const ocText = () => page.evaluate(() => document.querySelector('.chat-back:not(.min) .cw-thread')?.innerText || '');
    const oc = await until(async () => ((await ocText()).match(/plhapi-oc-hello/g) || []).length >= 2, 45000, 400);
    check('(c) Main answers through the layer (lab gateway)', !!oc, (await ocText()).replace(/\s+/g, ' ').slice(-140));
    await page.click('.chat-back:not(.min) .cw-x').catch(() => {});
    await until(async () => !(await copiedOpen(page)), 5000, 200);

    // (d) Agent Providers: the older connection's section, its page, the hint, Chat -> the office's window
    await page.evaluate(() => window.voPL.openProviders());
    const sec = await page.waitForSelector('.ap-hapi', { timeout: 20000 }).then(() => true, () => false);
    const title = await page.evaluate(() => document.querySelector('.ap-hapi .ap-hapi-t')?.textContent || '');
    // (a row nobody looked at since the office started says "Connecting..." until its background check answers: a moment)
    const rowText = () => page.evaluate(() => document.querySelector('.ap-hapi-row')?.innerText.replace(/\s+/g, ' ') || '');
    const row = await until(async () => { const t = await rowText(); return /Connected/i.test(t) ? t : null; }, 10000, 400) || await rowText();
    check('(d) Agent Providers: "Hermes API server (older connection)" with the Astra row', sec && title === 'Hermes API server (older connection)' && /Astra/.test(row) && /Connected/i.test(row), `${title} | ${row}`);
    await page.click('.ap-hapi-row');
    await page.waitForSelector('.ap-hapi-page', { timeout: 10000 }).catch(() => {});
    const pg = await page.evaluate(() => document.querySelector('.ap-hapi-page')?.innerText.replace(/\s+/g, ' ') || '');
    check('(d) its page: address and the hint (office window; connect hermes serve for the full window)',
      pg.includes(`127.0.0.1:${HAPI_PORT}`) && /keep working as before in the office's own chat window/.test(pg) && /Connect hermes serve/.test(pg) && /Edit in the office's settings/.test(pg), pg.slice(0, 200));
    await page.click('.ap-hapi-chat');
    const viaChat = await until(async () => (await ownOpen(page)) && !(await page.$('.ap-hapi-page')), 15000, 300);
    check('(d) its Chat button opens the office\'s own window for Astra', !!viaChat && !(await copiedOpen(page)), `own ${await ownOpen(page)} copied ${await copiedOpen(page)}`);
    await page.goto(`${VO_A}/providers.html?provider=hermes&hapi=1&connection=astra`, { waitUntil: 'domcontentloaded' });
    const settings = await until(async () => { const t = await page.evaluate(() => document.body.innerText); return /Astra/.test(t) && t.includes(`127.0.0.1:${HAPI_PORT}`) ? t : null; }, 20000, 500);
    check('(d) "Edit in the office\'s settings" lists the API-server row', !!settings, (settings || '').replace(/\s+/g, ' ').slice(0, 140));

    await sleep(1000);
    check('(f) no page errors / 5xx (layer office)', !errors.length, errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
  const tb = tracebacks(LOG_A);
  check('(f) no server tracebacks (layer office)', tb === 0 && tb0 === 0, `before ${tb0} after ${tb} (${LOG_A || 'VO_LOG unset'})`);
}

// ---------------------------------------------------------------- restart: (e) layer OFF -> ON, same data
function office(cmd, env) {
  const r = spawnSync('bash', [path.join(HERE, '..', 'tools', 'pl-office.sh'), cmd], { encoding: 'utf8', timeout: 150000, env: { ...process.env, PL_ROOT: B_ROOT, PL_PORT: B_PORT, ...env } });
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}
function seed() {   // (a 0.10.1 office: hermes.connections holds the API-server row; the lab OpenClaw is its own gateway)
  fs.mkdirSync(path.join(B_ROOT, 'data'), { recursive: true });
  const key = fs.readFileSync(path.join(LAB_HAPI, 'api-key'), 'utf8').trim();
  fs.writeFileSync(path.join(B_ROOT, 'data', 'vo-config.json'), JSON.stringify({
    codex: { enabled: false }, claudeCode: { enabled: false }, openCode: { enabled: false }, antigravity: { enabled: false }, officeLife: { enabled: true },
    hermes: { enabled: true, preferApi: false, timeoutSec: 600, platformEnabled: false, platformAgentId: 'hermes-gateway', localProfilesEnabled: false, followActiveSession: true, sessionSyncIntervalSec: 3,
      connections: [{ id: 'astra', name: 'Astra', apiUrl: `http://127.0.0.1:${HAPI_PORT}`, apiKey: key, emoji: '⚕️', role: 'Hermes Agent', resourcePath: '', resourceAccess: 'inherit', enabled: true, endpointMode: 'auto' }] },
  }, null, 1));
}
async function restartChecks() {
  const B = `http://127.0.0.1:${B_PORT}`, LOG_B = path.join(B_ROOT, 'logs', 'server.log');
  if (fs.existsSync(B_ROOT)) throw new Error(`${B_ROOT} exists: give the restart check a fresh folder`);
  seed();
  const gw = { PL_GATEWAY_URL: `ws://127.0.0.1:${OC_PORT}`, PL_GATEWAY_HTTP: `http://127.0.0.1:${OC_PORT}`, PL_GATEWAY_TOKEN: fs.readFileSync(path.join(LAB_OC, 'token'), 'utf8').trim() };
  try {
    console.log(office('start', { ...gw, PL_LAYER: '0' }));
    const off = await until(async () => { const r = await roster(B); return r.some(x => (x.key || x.id) === AGENT) ? r : null; }, 60000, 1500) || [];
    const layerOff = (await api(B, '/api/office/provider-layer')).body;
    check('(e) layer OFF (0.10.1): Astra in the roster, the layer not running', off.some(x => (x.key || x.id) === AGENT) && layerOff?.enabled === false, `${off.map(x => x.key || x.id).join(',')} layer ${JSON.stringify(layerOff).slice(0, 80)}`);
    let { browser, page, errors } = await browse(B, { layer: false });
    try {
      await own.open(page, AGENT);
      await own.send(page, 'plhapi-before-restart');
      const ok = await own.waitText(page, /plhapi-before-restart[\s\S]*Stub reply/i, 60000); await own.idle(page);
      check('(e) layer OFF: Astra answers in the office window', ok, (await own.text(page)).replace(/\s+/g, ' ').slice(-120));
      check('(e) layer OFF: no page errors / 5xx', !errors.length, errors.slice(0, 3).join(' | '));
    } finally { await browser.close(); }
    console.log(office('stop', {}));

    console.log(office('start', { ...gw, PL_LAYER: '1' }));
    const on = await until(async () => { const r = await roster(B); return ['main', 'ops', AGENT].every(id => r.some(x => (x.key || x.id) === id)) ? r : null; }, 90000, 1500) || await roster(B);
    const kinds = Object.fromEntries(on.map(r => [r.key || r.id, r.providerKind]));
    const layerOn = (await api(B, '/api/office/provider-layer')).body;
    check('(e) restarted with the layer ON: running, roster keeps Astra beside main + ops', layerOn?.running === true && kinds[AGENT] === 'hermes' && kinds.main === 'openclaw' && kinds.ops === 'openclaw', `${JSON.stringify(kinds)} running ${layerOn?.running}`);
    ({ browser, page, errors } = await browse(B));
    try {
      const gate = await page.evaluate(i => window.voPL.isLayerAgent(i), AGENT);
      // (the first look after a start: the row says Connecting until the office's probe answers; the window asks again)
      await page.evaluate(() => window.voPL.openProviders());
      const first = await page.waitForSelector('.ap-hapi-row', { timeout: 20000 }).then(() => page.evaluate(() => document.querySelector('.ap-hapi-row').innerText.replace(/\s+/g, ' ')), () => '');
      const settled = await until(async () => /Connected/.test(await page.evaluate(() => document.querySelector('.ap-hapi-row')?.innerText || '')), 20000, 400);
      check('(e) layer ON: Agent Providers lists the older connection and it turns Connected', !!settled, `first "${first}"`);
      await page.click('.ap-x').catch(() => {});
      await own.open(page, AGENT);
      const where = { own: await ownOpen(page), copied: await copiedOpen(page), gate };
      const kept = await own.waitText(page, /plhapi-before-restart[\s\S]*Stub reply/i, 20000);
      check('(e) layer ON: Astra opens the office window with its chat from before the restart', where.own && !where.copied && !gate && kept, JSON.stringify(where));
      await own.send(page, 'plhapi-after-restart');
      const ok = await own.waitText(page, /plhapi-after-restart[\s\S]*Stub reply/i, 60000); await own.idle(page);
      check('(e) layer ON: Astra answers after the restart', ok, (await own.text(page)).replace(/\s+/g, ' ').slice(-120));
      await page.evaluate(() => window.VOOffice.openAgent('main', 'chat'));
      const cw = await page.waitForSelector('.chat-back:not(.min) .chatwin', { timeout: 20000 }).then(() => true, () => false);
      await page.fill('.chat-back:not(.min) .cw-in', 'plhapi-oc-after-restart').catch(() => {});
      await page.keyboard.press('Enter');
      const oc = await until(async () => ((await page.evaluate(() => document.querySelector('.chat-back:not(.min) .cw-thread')?.innerText || '')).match(/plhapi-oc-after-restart/g) || []).length >= 2, 45000, 400);
      check('(e) layer ON: Main (the office\'s own gateway, migrated) opens the copied window and answers', cw && !!oc);
      await sleep(1000);
      check('(e)(f) layer ON: no page errors / 5xx', !errors.length, errors.slice(0, 3).join(' | '));
    } finally { await browser.close(); }
  } finally {
    console.log(office('stop', {}));
  }
  const tb = tracebacks(LOG_B);
  check('(e)(f) no server tracebacks (restarted office, both starts)', tb === 0, `${tb} in ${LOG_B}`);
}

try {
  if (which === 'layer' || which === 'all') await layerChecks();
  if (which === 'restart' || which === 'all') await restartChecks();
} catch (e) {
  check('run', false, e.stack || e.message);
}
process.exit(summary(`pl_hapi-${which}`));
