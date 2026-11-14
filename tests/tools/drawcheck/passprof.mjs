// passprof.mjs <functionName> label=appdir ... (env VIEW=desktop|phone, TOP, VO_PERF_FIXTURES, VO_PERF_PORT)
// passprof.mjs <fnName> label=appdir ...: CPU profile (busy office, desktop, full-rate frames), self time of samples under <fnName>, per frame
const WT = new URL('../../perf', import.meta.url).pathname;
const { loadPlaywright, findChrome, openOffice } = await import(WT + '/client.mjs');
const { buildOffice, loadFixtures, startOfficeServer } = await import(WT + '/office-server.mjs');
const [root, ...rest] = process.argv.slice(2);
const view = process.env.VIEW || 'desktop';
const trees = rest.map(a => ({ label: a.split('=')[0], app: a.split('=')[1] }));
const pw = loadPlaywright();
const browser = await pw.chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
try {
  for (const t of trees) {
    const fx = await startOfficeServer({ appDir: t.app, office: buildOffice(t.app, loadFixtures(process.env.VO_PERF_FIXTURES || ''), 27), port: Number(process.env.VO_PERF_PORT || 19486) });
    const o = await openOffice(browser, fx.url, view);
    try {
      fx.setMode('busy');
      await o.page.waitForTimeout(6000);
      await o.page.evaluate(() => { window.__perfSaved = window._shouldDrawFrame; window._shouldDrawFrame = () => true; window.__d0 = __voStats.draws; });
      await o.cdp.send('Profiler.enable'); await o.cdp.send('Profiler.setSamplingInterval', { interval: 50 }); await o.cdp.send('Profiler.start');
      await o.page.waitForTimeout(6000);
      const { profile } = await o.cdp.send('Profiler.stop');
      const frames = await o.page.evaluate(() => __voStats.draws - window.__d0);
      const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
      for (const n of profile.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
      const under = new Map();
      const isUnder = id => { if (under.has(id)) return under.get(id); let n = byId.get(id), r = false; while (n) { if (n.callFrame.functionName === root) { r = true; break; } n = byId.get(parent.get(n.id)); } under.set(id, r); return r; };
      const self = new Map(), dt = profile.timeDeltas; let tot = 0;
      profile.samples.forEach((id, i) => { if (!isUnder(id)) return; const cf = byId.get(id).callFrame; const k = (cf.functionName || '(anon)') + (cf.url ? (cf.functionName ? '' : ':' + (cf.lineNumber + 1)) : '*'); self.set(k, (self.get(k) || 0) + dt[i]); tot += dt[i]; });
      console.log(`${t.label}: frames ${frames}, under ${root} ${(tot / frames).toFixed(1)} us/frame; ` + [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP || 18)).map(([k, v]) => `${k}=${(v / frames).toFixed(1)}`).join(', '));
    } finally { await o.context.close(); await fx.close(); }
  }
} finally { await browser.close(); }
