// Shared helpers for the v0.11 copied-window checks (pl_chat.mjs, pl_menu.mjs): a private office from this tree with
// VO_PROVIDER_LAYER=1 (tests/tools/pl-office.sh) and the labs only (tests/tools/lab-openclaw.sh, lab-hermes.sh).
// Env: VO_URL (office, default http://127.0.0.1:18720), LAB_OC (lab OpenClaw folder), LAB_OC_PORT, LAB_OC_STUB,
// LAB_OC_URL (what the office dials, e.g. ws://172.17.0.1:<port> for the Docker-bridge case), LAB_H (lab Hermes folder),
// LAB_PORT_A (lab Hermes a, token sign-in), PL_OUT (screenshots), PLAYWRIGHT_CORE_PATH, CHROME_PATH.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || require('node:path').join(require('node:os').homedir(), '.hermes/hermes-agent/node_modules/playwright-core'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VO = process.env.VO_URL || 'http://127.0.0.1:18720';
export const LAB_OC = process.env.LAB_OC || '/tmp/vo-openclaw-lab';
export const LAB_OC_URL = process.env.LAB_OC_URL || `ws://127.0.0.1:${process.env.LAB_OC_PORT || 19690}`;
export const LAB_H = process.env.LAB_H || '/tmp/vo-hermes-lab';
export const LAB_A = `http://127.0.0.1:${process.env.LAB_PORT_A || 19338}`;
export const OUT = process.env.PL_OUT || '/tmp/vo-pl-e2e';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
for (const p of [8085, 8088, 8090, 8095, 8096, 8097, 8099, 18789]) if (VO.endsWith(`:${p}`) || LAB_OC_URL.endsWith(`:${p}`)) throw new Error(`refusing a real service port ${p}`);

export const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
}
export function summary(label) {
  const bad = results.filter(r => !r.ok);
  console.log(`${label}: ${results.length - bad.length}/${results.length} passed`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${label}.json`), JSON.stringify(results, null, 1));
  return bad.length ? 1 : 0;
}

/** The office API from a script (loopback: the office's owner; no browser headers, so no CSRF). */
export async function api(p, { method = 'GET', body } = {}) {
  const r = await fetch(VO + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: j };
}
export const sameUrl = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
export const providers = async () => (await api('/api/agent-providers')).body?.providers || [];
async function waitState(id, states, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    const p = (await providers()).find(x => x.id === id);
    if (p && states.includes(p.status?.state) && (p.status.state !== 'connected' || (p.agents || []).length)) return p;
    if (Date.now() > end) return p || null;
    await sleep(700);
  }
}
export function labCli(...args) {
  return spawnSync(path.join(HERE, '..', 'tools', 'lab-openclaw.sh'), ['cli', ...args], { encoding: 'utf8', timeout: 90000, env: { ...process.env, LAB: LAB_OC } });
}
/** The lab OpenClaw gateway as an installation connection, paired (approves the lab's pending device request). */
export async function ensureOpenClaw() {
  // (the lab's connection by its address: the office's own saved gateway, moved into the layer by the C3 migration, is an
  //  openclaw connection too)
  let p = (await providers()).find(x => x.kind === 'openclaw' && sameUrl(x.config?.url, LAB_OC_URL));
  const fake = (await providers()).find(x => x.kind === 'openclaw' && String(x.id) === '1' && !sameUrl(x.config?.url, LAB_OC_URL));
  // (both: the fake one goes, so "the office's OpenClaw" (its first connection) is the lab's)
  if (p && fake) await api('/api/connections/remove', { method: 'POST', body: { id: fake.id } });
  const moved = !p && fake;
  if (moved) {   // (the office's own fake gateway, moved in by the migration: point it at the lab so the desks' id map holds)
    const token = fs.readFileSync(path.join(LAB_OC, 'token'), 'utf8').trim();
    const r = await api('/api/connections/update', { method: 'POST', body: { id: moved.id, label: 'Lab gateway', config: { url: LAB_OC_URL, auth: 'token', access: 'full' }, secrets: { token } } });
    if (r.status !== 200) throw new Error(`openclaw connection update: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    p = r.body;
  }
  if (!p) {
    const token = fs.readFileSync(path.join(LAB_OC, 'token'), 'utf8').trim();
    const r = await api('/api/connections', { method: 'POST', body: { kind: 'openclaw', label: 'Lab gateway', scope: 'installation', config: { url: LAB_OC_URL, auth: 'token', access: 'full' }, secrets: { token } } });
    if (r.status !== 200) throw new Error(`openclaw connection: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    p = r.body;
  }
  p = await waitState(p.id, ['pairing', 'connected'], 60000);
  if (p?.status?.state === 'pairing') {
    const listed = JSON.parse(labCli('devices', 'list', '--json').stdout || '{}');
    const req = (listed.pending || []).slice(-1)[0];
    if (req) labCli('devices', 'approve', req.requestId || req.id);
    p = await waitState(p.id, ['connected'], 90000);
  }
  if (p?.status?.state !== 'connected') throw new Error(`lab gateway not connected: ${JSON.stringify(p?.status)}`);
  return p;
}
/** Lab Hermes a (token sign-in) as an installation connection. */
export async function ensureHermes() {
  let p = (await providers()).find(x => x.kind === 'hermes' && sameUrl(x.config?.url, LAB_A));
  const token = fs.readFileSync(path.join(LAB_H, 'a', 'session-token'), 'utf8').trim();
  if (p && p.status?.state !== 'connected') {
    // (an office kept from an earlier run: lab Hermes made a new session token when it started again)
    const r = await api('/api/connections/update', { method: 'POST', body: { id: p.id, config: { url: LAB_A, auth: 'token', access: 'full' }, secrets: { token } } });
    if (r.status === 200) p = r.body;
  }
  if (!p) {
    const r = await api('/api/connections', { method: 'POST', body: { kind: 'hermes', label: 'Lab Hermes', scope: 'installation', config: { url: LAB_A, auth: 'token', access: 'full' }, secrets: { token } } });
    if (r.status !== 200) throw new Error(`hermes connection: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    p = r.body;
  }
  p = await waitState(p.id, ['connected'], 60000);
  if (p?.status?.state !== 'connected') throw new Error(`lab Hermes not connected: ${JSON.stringify(p?.status)}`);
  return p;
}

/** One headless Chrome with the office open and the copied layer mounted (voPL ready). Close it in a finally. */
export async function launch({ phone = false, theme = 'dark', url = VO, login = null, args = [] } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', ...args] });
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(t => { try { localStorage.setItem('vo-ui-theme', t); } catch { /* private */ } }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror ${e.message} @ ${String(e.stack || '').split('\n')[1]?.trim() || ''}`));
  page.on('response', async r => {
    if (r.status() < 500) return;
    let b = ''; try { b = (await r.text()).slice(0, 120); } catch { /* gone */ }
    errors.push(`HTTP ${r.status()} ${r.url().slice(0, 80)} ${(r.request().postData() || '').slice(0, 80)} -> ${b}`);
  });
  if (login) {   // (a passcode office reached from a non-loopback address: sign in the way its login page does)
    await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
    const st = await page.evaluate(async p => (await fetch('/api/access/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: p }) })).status, login);
    if (st !== 200) throw new Error(`office login: ${st}`);
  }
  await open(page, { url });
  return { browser, page, errors };
}
/** The office page with the layer mounted. dismiss: Esc away a first-run notice (only on a first load: Esc in a restored,
 *  focused chat window would close it). reload: reload instead of navigating. */
export async function open(page, { dismiss = true, reload = false, url = VO } = {}) {
  if (reload) await page.reload({ waitUntil: 'domcontentloaded' }); else await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  const ok = await page.evaluate(async () => !!(await window.voPLReady));
  if (!ok) throw new Error('the copied layer did not mount (VO_PROVIDER_LAYER=1 office?)');
  if (dismiss) for (let k = 0; k < 3; k++) { await page.keyboard.press('Escape'); await sleep(120); }
}
export async function shot(page, name, el = '.chat-back:not(.min) .chatwin') {
  fs.mkdirSync(OUT, { recursive: true });
  const r = await page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(b.width, 900), height: Math.min(b.height, 860) }; }, el);
  if (r) await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 60, clip: r });
}
