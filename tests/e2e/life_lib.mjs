// Shared helpers for the Office life end-to-end page checks (L10) against the PRIVATE office started by
// tests/tools/life-e2e.sh (VO_URL, default http://127.0.0.1:18396). Never point these at a real office.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || require('node:path').join(require('node:os').homedir(), '.hermes/hermes-agent/node_modules/playwright-core'));

export const VO = process.env.VO_URL || 'http://127.0.0.1:18396';
if (/:(8085|8088|8090|8095|8096|8099)\b/.test(VO)) throw new Error('refusing a real office: ' + VO);
const LOG = process.env.LIFE_QA_LOG || '';
export const OUT = process.env.LIFE_SHOT_DIR || '/tmp/vo8096-l10/shots';
export const SECRETS = ['SECRET-CMD-7731', 'SECRET-Q-5521', 'SECRET-MSG-9917', 'SECRET-GOAL-4410', 'SECRET-SEND-8802'];

export const results = [];
export function check(name, ok, detail = '', owner = '') {
  const line = `${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + String(detail).replace(/\s+/g, ' ').slice(0, 240) : ''}${!ok && owner ? ` (owner ${owner})` : ''}`;
  results.push({ name, ok });
  console.log(line);
  if (LOG) fs.appendFileSync(LOG, '- ' + line + '\n');
  return ok;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function api(path, body, method) {
  const opts = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Origin: VO } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(VO + path, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}
export async function inject(...events) {
  const r = await api('/api/office-life/test-event', { events });
  if (r.status !== 200) throw new Error('inject ' + r.status + ' ' + r.text.slice(0, 120));
  return r.json;
}
export const injectAction = (action, extra = {}) => api('/api/office-life/test-event', { action, ...extra });
export const now = () => Date.now();

export async function launch({ width = 1600, height = 900, mobile = false, reducedMotion = 'no-preference', timezoneId } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile,
    deviceScaleFactor: mobile ? 2.625 : 1, reducedMotion, ...(timezoneId ? { timezoneId } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|favicon/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
  return { browser, context, page, errors };
}

export async function openOffice(page) {
  await page.goto(VO + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.VOLife && window.VOLife._debug && window.VOLife._debug().status === 'ready'
    && window.VOLife._debug().live && window.agents && window.agents.length >= 3, null, { timeout: 30000 });
  await sleep(1500);
}

export async function shot(page, name, clip) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = `${OUT}/${name}.jpg`;
  await page.screenshot({ path: file, type: 'jpeg', quality: 60, clip });
  return file;
}

// Rect helpers (CSS px, page coordinates)
export const overlap = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export async function chromeRects(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of [document.querySelector('.vo-mapctl'), document.querySelector('#chat-window-rail:not(.is-strip)'), document.querySelector('.vo-topbar'),
      ...document.querySelectorAll('[data-vo-canvas-obstacle], .vo-chat-window, .chat-window, .vo-sheet, .vo-sidebar')]) {
      if (!el) continue;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || cs.display === 'none' || cs.visibility === 'hidden') continue;
      out.push({ x: r.left, y: r.top, w: r.width, h: r.height, sel: el.className.toString().slice(0, 40) });
    }
    return out;
  });
}
export function summary(name) {
  const bad = results.filter(r => r.ok === false).length;
  console.log(`${name}: ${results.filter(r => r.ok).length} passed, ${bad} failed`);
  return bad;
}
