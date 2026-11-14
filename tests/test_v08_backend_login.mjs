// Headless check of app/login.html: after sign-in (here: an already signed-in
// status) the page may only go to a path on the same office. Tabs, newlines,
// backslashes, protocol-relative and absolute URLs in ?next= must land on "/".
//
// Needs playwright-core (or PLAYWRIGHT_CORE_PATH) and Chrome/Chromium
// (or CHROME_PATH). Prints SKIP and exits 0 when either is missing.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', 'app');
const require = createRequire(import.meta.url);

function skip(reason) {
  console.log(`SKIP test_v08_backend_login: ${reason}`);
  process.exit(0);
}

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try next */ }
  }
  return null;
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

const playwright = loadPlaywright();
if (!playwright) skip('playwright-core is not installed (set PLAYWRIGHT_CORE_PATH)');
const chromePath = findChrome();
if (!chromePath) skip('Chrome/Chromium was not found (set CHROME_PATH)');

const ORIGIN = 'http://office.test';
const LOGIN_HTML = fs.readFileSync(path.join(APP, 'login.html'), 'utf8');

// [raw ?next= value, expected landing path or null for "must be /"]
const CASES = [
  ['/%09/evil.example/', null],
  ['/%0a/evil.example/', null],
  ['/%0d/evil.example/', null],
  ['%09//evil.example/', null],
  ['//evil.example/', null],
  ['/%5C/evil.example/', null],
  ['/%5Cevil.example/', null],
  ['https://evil.example/', null],
  ['javascript:alert(1)', null],
  ['/%2F/evil.example/', null],
  ['/%252F/evil.example/', '/%2F/evil.example/'],
  ['%2Fcron.html%3Fx%3D1%23top', '/cron.html?x=1#top'],
  ['', '/'],
];

const browser = await playwright.chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
let failures = 0;
try {
  const context = await browser.newContext();
  const foreign = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      foreign.push(url.href);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>foreign</p>' });
    }
    if (url.pathname === '/login.html') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: LOGIN_HTML });
    }
    if (url.pathname === '/api/access/status') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ protected: true, authenticated: true, viaLoopback: false }) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>office</p>' });
  });
  for (const [raw, expected] of CASES) {
    const page = await context.newPage();
    foreign.length = 0;
    await page.goto(`${ORIGIN}/login.html?next=${raw}`);
    try {
      await page.waitForURL(u => !String(u).includes('/login.html'), { timeout: 5000 });
    } catch { /* checked below */ }
    const landed = new URL(page.url());
    const want = expected || '/';
    const got = landed.pathname + landed.search + landed.hash;
    const ok = landed.origin === ORIGIN && got === want && foreign.length === 0;
    if (!ok) {
      failures += 1;
      console.log(`FAIL next=${JSON.stringify(raw)} landed ${landed.href} (want ${want}) foreign=${foreign.join(',')}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures) {
  console.log(`test_v08_backend_login: ${failures} of ${CASES.length} cases FAILED`);
  process.exit(1);
}
console.log(`test_v08_backend_login: OK (${CASES.length} next= cases stay on the office)`);
