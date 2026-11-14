// Shared helpers for the hp (Hermes port) end-to-end checks against a TEMP office (VO_URL, default
// http://127.0.0.1:18095) and the private lab Hermes (tests/tools/lab-hermes.sh). Never point these at a real office.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || require('node:path').join(require('node:os').homedir(), '.hermes/hermes-agent/node_modules/playwright-core'));

export const VO = process.env.VO_URL || 'http://127.0.0.1:18095';
export const LAB = process.env.LAB || '/tmp/vo8095-hermes-lab';
export const LAB_A = 'http://127.0.0.1:' + (process.env.LAB_PORT_A || 19228);
export const LAB_B = 'http://127.0.0.1:' + (process.env.LAB_PORT_B || 19229);
const LOG = process.env.HPQA_LOG || '';
const OUT = process.env.HPQA_OUT || '/tmp/vo8095-hpqa';

if (/:(8095|8090|8085|8088|8099)\b/.test(VO)) throw new Error('refusing a real office: ' + VO);

export const results = [];
export function check(name, ok, detail = '') {
  const line = `${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + String(detail).replace(/\s+/g, ' ').slice(0, 260) : ''}`;
  results.push({ name, ok, detail });
  console.log(line);
  if (LOG) fs.appendFileSync(LOG, '- ' + line + '\n');
  return ok;
}
export const labToken = () => fs.readFileSync(LAB + '/a/session-token', 'utf8').trim();
export const labPassword = () => fs.readFileSync(LAB + '/b/password', 'utf8').trim();
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function api(path, opts = {}) {
  const res = await fetch(VO + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  let json = null; const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

export async function launch({ phone = false } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
    : { viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.setDefaultTimeout(15000);
  return { browser, ctx, page, errors };
}

export async function crop(page, name, clip) {
  const path = `${OUT}/${name}.jpg`;
  await page.screenshot({ path, type: 'jpeg', quality: 60, clip });
  return path;
}

export function summary(label) {
  const pass = results.filter(r => r.ok === true).length, fail = results.filter(r => r.ok === false).length;
  console.log(`${label}: ${pass} pass, ${fail} fail, ${results.filter(r => r.ok === null).length} skip`);
  return fail;
}
