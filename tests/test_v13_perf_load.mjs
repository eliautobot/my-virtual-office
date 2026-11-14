// v0.13 perf: layout-forcing reads while the phone page loads. Each read of scrollTop / innerWidth (and each hit
// test) on a half-built page forces a style + layout pass. Counts them by source file from navigation to 1.5 s after
// the load event on the 412 px phone view, with Office Life on and 27 agents.
// Fails on b193266: session-progress.js read scrollTop 4x per load and chat.js read innerWidth ~20x.
// Run: PLAYWRIGHT_CORE_PATH=... node tests/test_v13_perf_load.mjs [--app app] [--port 19956]
import path from 'path';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const APP = path.resolve(opt('app', path.join(HERE, '../app')));
const { loadPlaywright, findChrome, VIEWS } = await import(path.join(HERE, 'perf/client.mjs'));
const { buildOffice, startOfficeServer } = await import(path.join(HERE, 'perf/office-server.mjs'));

const SPY = `(() => {
  const C = window.__lfr = { on: true, by: {} };
  const file = () => { for (const l of (new Error().stack || '').split('\\n').slice(2)) { const m = l.match(/\\/([\\w.\\-]+\\.m?js)[?:]/); if (m) return m[1]; } return '?'; };
  const count = (what) => { if (!C.on) return; const k = what + ' ' + file(); C.by[k] = (C.by[k] || 0) + 1; };
  const st = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get() { count('scrollTop'); return st.get.call(this); }, set(v) { count('scrollTop='); st.set.call(this, v); } });
  const iw = Object.getOwnPropertyDescriptor(window, 'innerWidth') || Object.getOwnPropertyDescriptor(Window.prototype, 'innerWidth');
  if (iw && iw.get) Object.defineProperty(window, 'innerWidth', { configurable: true, get() { count('innerWidth'); return iw.get.call(window); } });
  const efp = Document.prototype.elementFromPoint;
  Document.prototype.elementFromPoint = function (x, y) { count('elementFromPoint'); return efp.call(this, x, y); };
  window.addEventListener('load', () => setTimeout(() => { C.on = false; }, 1500));
})();`;

const fails = [];
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails.push(msg); };
const office = buildOffice(APP, {}, 27);
const fx = await startOfficeServer({ appDir: APP, office, port: Number(opt('port', 19956)) });
const browser = await loadPlaywright().chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
try {
  const v = VIEWS.phone;
  const context = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.dpr, isMobile: true, hasTouch: true });
  await context.addInitScript(SPY);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e.message).slice(0, 120)));
  await page.goto(fx.url + '/', { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const by = await page.evaluate(() => window.__lfr.by);
  const n = (what, f) => by[what + ' ' + f] || 0;
  console.log('reads during load:', Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, c]) => k + ' ' + c).join(', '));
  check(n('scrollTop', 'session-progress.js') + n('scrollTop=', 'session-progress.js') === 0, `session-progress.js: no scrollTop read/write while the page loads (${n('scrollTop', 'session-progress.js')})`);
  check(n('innerWidth', 'chat.js') <= 2, `chat.js: innerWidth read at most twice while the page loads (${n('innerWidth', 'chat.js')})`);
  check(n('scrollTop=', 'ui-modern.js') === 0, `ui-modern.js: no scroll reset of an untouched panel while the page loads (${n('scrollTop=', 'ui-modern.js')})`);
  check(n('elementFromPoint', 'game.js') === 0, `game.js: the covered-office check does not hit-test while the page loads (${n('elementFromPoint', 'game.js')})`);
  const steady = await page.evaluate(async () => { const C = window.__lfr; C.by = {}; C.on = true; await new Promise(r => setTimeout(r, 3000)); C.on = false; return C.by['elementFromPoint game.js'] || 0; });
  check(steady <= 12, `game.js: the covered-office check hit-tests at most ~2x per second when nothing happens (${steady} in 3 s)`);
  // Behaviour kept: chat still knows it is on a phone (one window at a time) and Settings opens at the top.
  const ui = await page.evaluate(async () => {
    window.VOUI.openSettings('voice'); await new Promise(r => setTimeout(r, 400));
    const body = document.querySelector('#main-menu-panel .main-menu-body');
    body.scrollTop = 200; await new Promise(r => setTimeout(r, 200));
    const scrolled = body.scrollTop;
    window.VOUI.openSettings('life'); await new Promise(r => setTimeout(r, 300));
    return { scrolled, afterSwitch: body.scrollTop };
  });
  check(ui.scrolled === 0 || ui.afterSwitch === 0, `Settings: switching category scrolls back to the top (${ui.scrolled} -> ${ui.afterSwitch})`);
  check(errors.length === 0, 'no page errors ' + errors.slice(0, 2).join(' | '));
  await context.close();
} catch (e) { fails.push('crash ' + String(e).slice(0, 160)); console.log('FAIL crash', String(e).slice(0, 160)); }
finally { await browser.close(); await fx.close(); }
console.log(fails.length ? `FAILED ${fails.length}` : 'PASS');
process.exit(fails.length ? 1 : 0);
