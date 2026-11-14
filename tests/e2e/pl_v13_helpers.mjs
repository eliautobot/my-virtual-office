// v0.13 presence e2e on a private office with a REAL lab OpenClaw gateway (2026.11: no task ledger), stub model:
//   LABS_ROOT=/tmp/x LABS_PORT=<p> LABS_OC_PORT=<g> LABS_HAPI=0 tests/tools/office-labs.sh run   (another shell)
//   VO_URL=http://127.0.0.1:<p> LAB_OC=$LABS_ROOT/oc LAB_OC_PORT=<g> PL_OUT=<dir> node tests/e2e/pl_v13_helpers.mjs
// "main" is told (through the gateway, as from OpenClaw's own dashboard) to spawn two helpers that answer slowly (60 s,
// the stub's cap). Then: main reads working "Waiting on 2 helpers" past the old 45 s cut-off, Office Life counts 2
// helpers, the chat window's Tasks panel lists both running (live), and when they end main goes idle and the panel
// shows them finished. No live office is touched.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, summary, launch, open, api, sleep, shot, VO } from './pl_lib.mjs';

const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const gw = (method, params) => {
  const r = spawnSync(path.join(TREE, 'tests/tools/lab-openclaw.sh'), ['cli', 'gateway', 'call', method, '--params', JSON.stringify(params), '--json'],
    { encoding: 'utf8', timeout: 60000, env: process.env });
  try { return JSON.parse(r.stdout); } catch { return { error: (r.stderr || r.stdout || '').slice(0, 200) }; }
};
const status = async () => (await api('/status')).body?.main || {};

const t0 = Date.now();
for (const n of ['A', 'B']) {
  const r = gw('chat.send', { sessionKey: 'agent:main:main', idempotencyKey: `v13-e2e-${n}-${t0}`,
    message: `[[tool:sessions_spawn {"task":"slow:60000 helper ${n} working","label":"Helper ${n}"}]]` });
  check(`gateway accepted spawn ${n}`, !!r.runId, JSON.stringify(r).slice(0, 120));
  await sleep(6000);
}
const rows = gw('sessions.list', { agentId: 'main', limit: 20 }).sessions || [];
const running = rows.filter(s => /:subagent:/.test(s.key) && s.hasActiveRun);
check('OpenClaw: 2 helper sessions running, spawnedBy the chat', running.length === 2 && running.every(s => s.spawnedBy === 'agent:main:main'),
  running.map(s => `${s.label}:${s.status}`).join(', '));

let st = await status();
check('main working "Waiting on 2 helpers"', st.state === 'working' && st.task === 'Waiting on 2 helpers', `${st.state} ${st.task} ${st.source}`);
const life = (await api('/api/office-life/state')).body?.open?.interns || {};
check('Office Life: 2 helpers', life.main === 2, JSON.stringify(life));

const { browser, page, errors } = await launch();
await page.addInitScript(() => {   // (every label Office Life draws, for the helper chip)
  window.__labels = new Set();
  const hook = () => { const S = window.VOLifeSprites; if (!S || S.__v13) return; const l = S.label; S.label = function (c, t) { window.__labels.add(String(t)); return l.apply(this, arguments); }; S.__v13 = 1; };
  const iv = setInterval(hook, 100); setTimeout(() => clearInterval(iv), 20000);
});
await open(page);
let floor = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  floor = await page.evaluate(() => { const a = window.agentMap && window.agentMap.main; return a ? { state: a.state, sitting: !!a.isSitting, atDesk: !!a.desk && Math.hypot(a.x - a.desk.x, a.y - a.desk.y) < 60, chip: window.__labels.has('2 helpers') } : null; });
  if (floor && floor.state === 'working' && floor.chip) break;
}
check('floor: main working at its desk, chip "2 helpers"', floor && floor.state === 'working' && floor.atDesk && floor.chip, JSON.stringify(floor));
await page.screenshot({ path: path.join(process.env.PL_OUT || '/tmp', 'v13-floor-helpers.jpg'), type: 'jpeg', quality: 60 });
const ag = ((await api('/api/pl/agents')).body?.agents || []).find(a => a.officeId === 'main');
await page.evaluate(id => window.voPL.openLayer(id, { session: 'agent:main:main' }), ag.id);
await page.waitForSelector('.chat-back:not(.min) .cw-dockb', { timeout: 20000 });
await page.evaluate(() => document.querySelector('.chat-back:not(.min) .cw-dockb')?.click());
const panel = async () => page.evaluate(() => (document.querySelector('.chat-back:not(.min) .cw-dock')?.innerText || '').replace(/\s+/g, ' '));
let text = '';
for (let i = 0; i < 40 && !/Helper A/.test(text); i++) { await sleep(500); text = await panel(); }
check('Tasks panel: both helpers running, with their runtime', /Running \(2\)/i.test(text) && /Helper A/.test(text) && /Helper B/.test(text) && /Subagent/.test(text) && !/No background task list/.test(text), text.slice(0, 220));
await shot(page, 'v13-helpers-running');

const quiet = Math.max(0, 55000 - (Date.now() - t0));   // past the old 45 s cut-off since the last presence event
await sleep(quiet);
st = await status();
check('still working after the old 45 s cut-off', st.state === 'working' && st.activeRunCount > 0, `${st.state} ${st.task} age ${Math.round(Date.now() / 1000 - st.updated)}s`);

for (let i = 0; i < 60 && st.state !== 'idle'; i++) { await sleep(1000); st = await status(); }
check('helpers done -> main idle (nothing sticks)', st.state === 'idle' && !st.activeRunCount, `${st.state} ${st.source}`);
const ran = () => /Running \((\d+)\)/i.exec(text);
for (let i = 0; i < 20 && ran() && ran()[1] !== '0'; i++) { await sleep(500); text = await panel(); }
check('Tasks panel (live, no reload): no helper running, both finished', (!ran() || ran()[1] === '0') && /Finished \([2-9]\)/i.test(text), text.slice(0, 220));   // (the finished list is folded, as in OpenClaw's)
await shot(page, 'v13-helpers-done');
const life2 = (await api('/api/office-life/state')).body?.open?.interns || {};
check('Office Life: no helpers left', !life2.main, JSON.stringify(life2));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
summary("pl_v13_helpers");
