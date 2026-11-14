// officeab.mjs --view desktop|phone --rounds N --secs S [--profile] [--out f.json] label=appdir ...  (env VO_PERF_FIXTURES, VO_PERF_PORT)
// The perf office (27 agents, busy), trees alternating: frame time p50/p95 (forced full rate, like run.mjs busyFrame)
// per round, and optionally a CPU profile per tree (owner-charged, top 30) saved as JSON.
import fs from 'node:fs';
import path from 'node:path';
const WT = new URL('../../perf', import.meta.url).pathname;
const { loadPlaywright, findChrome, openOffice, frameTimes, aggregateProfile } = await import(WT + '/client.mjs');
const { buildOffice, loadFixtures, startOfficeServer } = await import(WT + '/office-server.mjs');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const view = opt('view', 'desktop'), rounds = Number(opt('rounds', 3)), secs = Number(opt('secs', 6)), prof = argv.includes('--profile');
const trees = argv.filter(a => a.includes('=') && !a.startsWith('--')).map(a => ({ label: a.split('=')[0], app: a.split('=')[1] }));
const pw = loadPlaywright();
let browser = null;
const out = {};
try {
  for (let r = 0; r < rounds; r++) for (let ti = 0; ti < trees.length; ti++) {
    const t = trees[(ti + r) % trees.length];   // order rotates per round (no tree always last)
    browser = await pw.chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });   // a fresh browser per measurement
    const office = buildOffice(t.app, loadFixtures(process.env.VO_PERF_FIXTURES || ''), 27);
    const fx = await startOfficeServer({ appDir: t.app, office, port: Number(process.env.VO_PERF_PORT || 19486) });
    const o = await openOffice(browser, fx.url, view);
    try {
      fx.setMode('busy');
      await o.page.waitForTimeout(8000);
      const f = await frameTimes(o.page, secs, { full: true });
      (out[t.label] = out[t.label] || { p50: [], p95: [], mean: [], n: [] });
      out[t.label].p50.push(f.p50); out[t.label].p95.push(f.p95); out[t.label].mean.push(f.mean); out[t.label].n.push(f.frames); (out[t.label].sec = out[t.label].sec || []).push(f.sections);
      if (prof && r === rounds - 1) {
        await o.page.evaluate(() => { window.__perfSaved = window._shouldDrawFrame; window._shouldDrawFrame = () => true; });
        await o.cdp.send('Profiler.enable'); await o.cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await o.cdp.send('Profiler.start');
        await o.page.waitForTimeout(secs * 1000);
        const { profile } = await o.cdp.send('Profiler.stop');
        await o.page.evaluate(() => { window._shouldDrawFrame = window.__perfSaved; });
        out[t.label].profile = aggregateProfile(profile, 40);
        const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n])), dt = profile.timeDeltas || [];
        (profile.samples || []).forEach((id, i) => { const cf = byId.get(id).callFrame; if (/^\((idle|program|root)\)$/.test(cf.functionName)) return;
          const k = (cf.functionName || '(anon)') + ' ' + (cf.url ? cf.url.split('/').pop().split('?')[0] + ':' + (cf.lineNumber + 1) : '#native'); self.set(k, (self.get(k) || 0) + (dt[i] || 0)); });
        out[t.label].raw = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, us]) => [k, +(us / 1000).toFixed(2)]);
        out[t.label].rawTotal = +([...self.values()].reduce((a, b) => a + b, 0) / 1000).toFixed(1);
        out[t.label].draws = await o.page.evaluate(() => window.__voStats && window.__voStats.draws);
      }
    } finally { await o.context.close(); await fx.close(); await browser.close(); browser = null; }
  }
} finally { if (browser) await browser.close(); }
const file = opt('out', `/tmp/officeab-${view}-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(out));
for (const [k, v] of Object.entries(out)) {
  const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
  console.log(`${view} ${k.padEnd(6)} busy frame p50 ${v.p50.map(x => (+x).toFixed(2)).join(' ')} (med ${(+med(v.p50)).toFixed(2)}); p95 ${v.p95.map(x => (+x).toFixed(2)).join(' ')} (med ${(+med(v.p95)).toFixed(2)}); mean ${v.mean.map(x => (+x).toFixed(2)).join(' ')} (med ${(+med(v.mean)).toFixed(2)}); frames ${v.n.join(' ')}`);
}
for (const [k, v] of Object.entries(out)) { const names = Object.keys(v.sec[0] || {}).slice(0, 7);
  console.log(`  ${k} sections ms/frame: ` + names.map(nm => nm + ' ' + v.sec.map(x => (x[nm] || 0).toFixed(3)).join('/')).join('; ')); }
console.log('saved', file);
