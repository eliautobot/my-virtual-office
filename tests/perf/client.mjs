// Perf harness: browser measurements against the fixture office (office-server.mjs). One Chrome at a time; every
// context is closed in a finally. All numbers are main-thread numbers from Chrome itself (CDP Performance metrics,
// PerformanceObserver long tasks, the office's own frame counter window.__voStats).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

export function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core'].filter(Boolean)) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error('playwright-core not found (set PLAYWRIGHT_CORE_PATH)');
}
export function findChrome() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser'].filter(Boolean);
  const hit = c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!hit) throw new Error('Chrome not found (set CHROME_PATH)');
  return hit;
}

export const VIEWS = {
  desktop: { width: 1600, height: 900, dpr: 1, throttle: 1 },
  phone: { width: 412, height: 915, dpr: 2, throttle: 4, mobile: true },
  phone26: { width: 412, height: 915, dpr: 2.625, throttle: 4, mobile: true },
  phone3: { width: 412, height: 915, dpr: 3, throttle: 4, mobile: true },
};

// Installed before any page script: long-task log, a frame-time wrapper hook and a hidden-tab emulation (headless Chrome
// never hides a background tab, so `__perfHide(true)` makes document.hidden true, fires visibilitychange and holds
// requestAnimationFrame callbacks like a real hidden tab does).
const INIT = `(() => {
  window.__perfLT = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__perfLT.push([e.startTime, e.duration]); })
    .observe({ type: 'longtask', buffered: true }); } catch (e) {}
  let hidden = false; const held = [];
  const rawRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => { if (hidden) { held.push(cb); return -1; } return rawRAF(cb); };
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return hidden; } });
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return hidden ? 'hidden' : 'visible'; } });
  window.__perfHide = h => { hidden = !!h; document.dispatchEvent(new Event('visibilitychange'));
    if (!hidden) held.splice(0).forEach(cb => rawRAF(cb)); };
  try { localStorage.setItem('vo-onboarding-done', '1'); } catch (e) {}
})();`;

const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const r2 = x => Math.round(x * 100) / 100;

async function metrics(cdp) {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  const o = {}; for (const x of m) o[x.name] = x.value; return o;
}

export async function openOffice(browser, url, view, { nAgents = 27 } = {}) {
  const v = VIEWS[view];
  const context = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.dpr,
    isMobile: !!v.mobile, hasTouch: !!v.mobile });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
  if (v.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: v.throttle });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  await page.goto(url + '/', { waitUntil: 'commit' });
  // "interactive" = the office has its agents, drew a frame, the load event fired and no long task for 500 ms.
  const load = await page.evaluate(async (n) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const ready = () => document.readyState === 'complete' && window.__voStats && window.__voStats.draws > 0
      && Array.isArray(window.agents) && window.agents.length >= Math.min(n, 19);
    let readyAt = 0; const tEnd = performance.now() + 60000;
    while (performance.now() < tEnd) {
      if (!readyAt && ready()) readyAt = performance.now();
      if (readyAt) {
        const lastLT = window.__perfLT.reduce((m, e) => Math.max(m, e[0] + e[1]), 0);
        if (performance.now() - Math.max(readyAt, lastLT) >= 500) break;
      }
      await sleep(25);
    }
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const fcp = (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0;
    const lastLT = window.__perfLT.reduce((m, e) => Math.max(m, e[0] + e[1]), 0);
    const tti = readyAt ? Math.max(readyAt, lastLT) : -1;
    const lt = window.__perfLT.filter(e => e[0] < tti);
    return { fcp, dcl: nav.domContentLoadedEventEnd || 0, load: nav.loadEventEnd || 0, officeReady: readyAt, interactive: tti,
      longTasks: lt.length, tbt: lt.reduce((s, e) => s + Math.max(0, e[1] - 50), 0), longest: lt.reduce((m, e) => Math.max(m, e[1]), 0),
      agents: (window.agents || []).length };
  }, nAgents);
  load.wallMs = Date.now() - t0;
  const { profile: lp } = await cdp.send('Profiler.stop');
  await cdp.send('Profiler.disable');
  load.profile = aggregateProfile(lp, 30);
  return { context, page, cdp, errors, load };
}

// Main-thread cost while the page runs `secs` seconds as it is (natural frame scheduling).
export async function sampleCpu(page, cdp, secs) {
  await page.evaluate(() => { window.__perfLT.length = 0; window.__perfD0 = window.__voStats.draws; });
  const m0 = await metrics(cdp); const w0 = Date.now();
  await page.waitForTimeout(secs * 1000);
  const m1 = await metrics(cdp); const w1 = Date.now();
  const extra = await page.evaluate(() => ({ draws: window.__voStats.draws - window.__perfD0, lt: window.__perfLT.slice() }));
  const wall = (w1 - w0) / 1000;
  return { cpuPct: r2(100 * (m1.TaskDuration - m0.TaskDuration) / wall), scriptPct: r2(100 * (m1.ScriptDuration - m0.ScriptDuration) / wall),
    layoutPct: r2(100 * ((m1.LayoutDuration + m1.RecalcStyleDuration) - (m0.LayoutDuration + m0.RecalcStyleDuration)) / wall),
    fps: r2(extra.draws / wall), longTasks: extra.lt.length, tbt: Math.round(extra.lt.reduce((s, e) => s + Math.max(0, e[1] - 50), 0)) };
}

// JS time per drawn frame (wraps _renderFrame), natural scheduling or forced full rate (`full`).
export async function frameTimes(page, secs, { full = false } = {}) {
  return page.evaluate(async ({ secs, full }) => {
    const orig = window._renderFrame; const times = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window._renderFrame = function (now) { const d0 = window.__voStats.draws; const t = performance.now(); orig(now);
      if (window.__voStats.draws > d0) times.push(performance.now() - t); };
    const origShould = window._shouldDrawFrame;
    if (full) window._shouldDrawFrame = () => true;
    // the renderer's own section timers (_perfStart/_perfEnd run only with VO_DEBUG): summed per section
    const sec = {}; const starts = {}; const ps = window._perfStart, pe = window._perfEnd, dbg = window.VO_DEBUG;
    if (typeof ps === 'function') {
      window._perfStart = l => { starts[l] = performance.now(); };
      window._perfEnd = l => { if (starts[l] != null) sec[l] = (sec[l] || 0) + performance.now() - starts[l]; };
    }
    window.__perfLT.length = 0;
    await sleep(secs * 1000);
    window._renderFrame = orig; if (full) window._shouldDrawFrame = origShould;
    if (typeof ps === 'function') { window._perfStart = ps; window._perfEnd = pe; window.VO_DEBUG = dbg; }
    const s = times.slice().sort((a, b) => a - b);
    const q = p => s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
    const sections = {};
    for (const [k, v] of Object.entries(sec).sort((a, b) => b[1] - a[1])) sections[k] = Math.round(1000 * v / Math.max(1, s.length)) / 1000;
    return { frames: s.length, p50: q(0.5), p95: q(0.95), max: s.length ? s[s.length - 1] : 0,
      mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), longTasks: window.__perfLT.length, sections };
  }, { secs, full });
}

// CPU profile of `secs` seconds: top self-time functions with url:line.
export async function profile(page, cdp, secs, top = 14) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await page.waitForTimeout(secs * 1000);
  const { profile: p } = await cdp.send('Profiler.stop');
  await cdp.send('Profiler.disable');
  return aggregateProfile(p, top);
}

export function aggregateProfile(p, top = 14) {
  const self = new Map(); const byId = new Map(p.nodes.map(n => [n.id, n])); const parent = new Map();
  for (const n of p.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
  const dt = p.timeDeltas || [];
  (p.samples || []).forEach((id, i) => { self.set(id, (self.get(id) || 0) + (dt[i] || 0)); });
  // native leaves (fillRect, drawImage, measureText, ...) are charged to the nearest script frame that called them
  const owner = id => { let n = byId.get(id); while (n && !n.callFrame.url && parent.has(n.id) && !/^\(/.test(n.callFrame.functionName)) n = byId.get(parent.get(n.id)); return n; };
  const agg = new Map(); let busy = 0;
  for (const [id, us] of self) {
    const cf = owner(id).callFrame;
    if (/^\((idle|program|root)\)$/.test(cf.functionName)) continue;
    busy += us;
    const file = (cf.url || '').split('/').pop().split('?')[0];
    const key = (cf.functionName || '(anon)') + ' ' + (file ? file + ':' + (cf.lineNumber + 1) : '');
    agg.set(key, (agg.get(key) || 0) + us);
  }
  return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([k, us]) => ({ fn: k.trim(), ms: r2(us / 1000), pctOfBusy: r2(100 * us / (busy || 1)) }));
}

export async function domNodes(page) { return page.evaluate(() => document.getElementsByTagName('*').length); }
export async function heapMB(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const m = await metrics(cdp); return r2(m.JSHeapUsedSize / 1048576);
}
export { pct, r2 };
