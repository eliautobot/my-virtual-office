// v0.13 perf: the office canvas stops drawing while an opaque screen covers all of it (phone Settings, Projects,
// Agent Studio) and draws again at once when it shows; translucent scrims (desktop Settings / Studio) and a partial
// chat window keep it drawing; the simulation keeps running while covered.
// Fails on b193266 (the office drew at 30 fps under the phone's full-screen Settings: ~92% CPU at 4x).
// Run: PLAYWRIGHT_CORE_PATH=... node tests/test_v13_perf_covered.mjs [--app app] [--port 19955]
import path from 'path';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const APP = path.resolve(opt('app', path.join(HERE, '../app')));
const { loadPlaywright, findChrome, openOffice } = await import(path.join(HERE, 'perf/client.mjs'));
const { buildOffice, startOfficeServer } = await import(path.join(HERE, 'perf/office-server.mjs'));

const fails = [];
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails.push(msg); };
const office = buildOffice(APP, {}, 27);
const fx = await startOfficeServer({ appDir: APP, office, port: Number(opt('port', 19955)) });
const browser = await loadPlaywright().chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const drawsIn = (page, ms) => page.evaluate(async ms => { const d0 = __voStats.draws, s0 = __voStats.simSteps; await new Promise(r => setTimeout(r, ms));
  return { draws: __voStats.draws - d0, sim: __voStats.simSteps - s0, covered: !!(window.__voCover && window.__voCover.covered) }; }, ms);
const run = (page, js) => page.evaluate(js);
try {
  // Desktop: scrims and a chat window leave the office in view.
  {
    const o = await openOffice(browser, fx.url, 'desktop');
    const p = o.page; await p.waitForTimeout(1500);
    let r = await drawsIn(p, 1500); check(r.draws > 10, `desktop: office draws (${r.draws} in 1.5 s)`);
    await run(p, 'window.VOUI.openSettings()'); await p.waitForTimeout(800);
    r = await drawsIn(p, 1500); check(r.draws > 10 && !r.covered, `desktop Settings (translucent scrim): still draws (${r.draws})`);
    await run(p, 'window.toggleMainMenu()'); await p.waitForTimeout(500);
    await run(p, 'window.VirtualOfficeChat.openForAgent(window.agents[0].id)'); await p.waitForTimeout(800);
    r = await drawsIn(p, 1500); check(r.draws > 10 && !r.covered, `desktop chat window: still draws (${r.draws})`);
    check(o.errors.length === 0, 'desktop: no page errors ' + o.errors.slice(0, 2).join(' | '));
    await o.context.close();
  }
  // Phone: full-screen opaque screens pause drawing, the world keeps going, closing draws at once.
  {
    const o = await openOffice(browser, fx.url, 'phone');
    const p = o.page; await p.waitForTimeout(1500);
    let r = await drawsIn(p, 1500); check(r.draws > 10, `phone: office draws (${r.draws} in 1.5 s)`);
    await run(p, 'window.VOUI.openSettings()'); await p.waitForTimeout(1200);
    r = await drawsIn(p, 2000); check(r.draws <= 1 && r.covered, `phone Settings (opaque, full screen): no drawing (${r.draws} in 2 s, covered ${r.covered})`);
    check(r.sim > 20, `phone Settings: the simulation keeps running (${r.sim} steps)`);
    // Programmatic close (no input event): drawn again within the 250 ms check.
    const back = await p.evaluate(async () => { const d0 = __voStats.draws; const t0 = performance.now(); window.toggleMainMenu();
      while (__voStats.draws === d0 && performance.now() - t0 < 2000) await new Promise(r => requestAnimationFrame(r)); return Math.round(performance.now() - t0); });
    check(back <= 400, `phone Settings closed by code: drawn again after ${back} ms (<= 400)`);
    r = await drawsIn(p, 1500); check(r.draws > 10 && !r.covered, `phone after Settings: draws (${r.draws})`);
    // Closed by a key/click: the next frames recheck (urgent window).
    await run(p, 'openProjectsManager()'); await p.waitForTimeout(1200);
    r = await drawsIn(p, 1500); check(r.draws <= 1 && r.covered, `phone Projects (full screen): no drawing (${r.draws})`);
    const back2 = await p.evaluate(async () => { const d0 = __voStats.draws; const t0 = performance.now();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      while (__voStats.draws === d0 && performance.now() - t0 < 2000) await new Promise(r => requestAnimationFrame(r)); return Math.round(performance.now() - t0); });
    check(back2 <= 400, `phone Projects closed by Escape: drawn again after ${back2} ms`);
    await run(p, 'toggleAgentPanel()'); await p.waitForTimeout(1500);
    r = await drawsIn(p, 1500); check(r.draws <= 1 && r.covered, `phone Agent Studio (full screen): no drawing (${r.draws})`);
    await run(p, 'toggleAgentPanel()'); await p.waitForTimeout(600);
    r = await drawsIn(p, 1500); check(r.draws > 10, `phone after Studio: draws (${r.draws})`);
    await run(p, 'window.VirtualOfficeChat.openForAgent(window.agents[0].id)'); await p.waitForTimeout(1000);
    r = await drawsIn(p, 1500); check(r.draws > 10 && !r.covered, `phone chat window (part of the office in view): draws (${r.draws})`);
    check(o.errors.length === 0, 'phone: no page errors ' + o.errors.slice(0, 2).join(' | '));
    await o.context.close();
  }
} catch (e) { fails.push('crash: ' + String(e && e.stack || e).slice(0, 200)); console.log('FAIL crash', String(e).slice(0, 200)); }
finally { await browser.close(); await fx.close(); }
console.log(fails.length ? `FAILED ${fails.length}` : 'PASS');
process.exit(fails.length ? 1 : 0);
