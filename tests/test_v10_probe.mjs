// v0.10.1 PROBE (review 11-07: "a test character you can control the movement of ... get close to objects/furniture/
// walls"): app/vo-probe.js, dev only. Headless Chrome on the default layout, fixture APIs, the simulation stepped by
// hand. Checks: without ?debug=probe nothing loads; with it window.VOProbe + the HUD; the probe is not an agent but
// a world person (stepped, drawn, in the invariant); walking obeys the rules (stops at walls and footprints, never
// rests in a clearance band: let go in one it steps out), sits / stands at a seat by the planner, ghost mode ignores
// the rules and leaves the invariant, the keyboard walks it, carry / pose / face / frame / state work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findChrome, openOffice, launch, rosterFor } from './tools/probe-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.WORLD_APP || path.resolve(here, '..', 'app'));
const pw = loadPlaywright(), chrome = findChrome();
if (!pw || !chrome) { console.log('SKIP test_v10_probe: playwright-core / Chrome not found'); process.exit(0); }
const config = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
const results = [];
const ok = (c, what) => results.push([!!c, what]);

const browser = await launch(pw, chrome);
try {
  // 1 off by default
  {
    const { page, context, errors } = await openOffice(browser, { app: APP, config, agents: rosterFor(config, 2), query: '' });
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => ({ api: !!window.VOProbe, list: _probePeople.length,
      script: !!document.querySelector('script[src^="vo-probe.js"]'), hud: !!document.getElementById('voProbeHud') }));
    ok(!r.api && !r.list && !r.script && !r.hud, 'no ?debug=probe: no probe script, API, person or HUD ' + JSON.stringify(r));
    ok(!errors.length, 'no page errors (off) ' + (errors[0] || ''));
    await context.close();
  }
  // 2 on
  const { page, context, errors } = await openOffice(browser, { app: APP, config, agents: rosterFor(config, 3), noSpawn: true, seed: 7 });
  await page.evaluate(() => { window._runSimulation = function() { return 0; }; window.__voWorldCheck = 'every'; });
  const out = await page.evaluate(() => {
    const res = [], ok = (c, w) => res.push([!!c, w]);
    const run = (n) => { for (let i = 0; i < n; i++) _simulationStep(); };
    const P = VOProbe, wallH = officeConfig.walls.height || 0;
    const probeHits = () => VOWorld.check().filter(v => v.id === '__probe');
    // spawn
    let s = P.spawn(W / 2, H / 2);
    const a = P.agent();
    ok(a instanceof Agent && agents.indexOf(a) < 0 && _worldPeople().indexOf(a) >= 0, 'the probe is an Agent, not in agents, a world person');
    ok(s && s.ok && !s.sitting, 'spawned on clear floor ' + JSON.stringify(s && s.flags));
    // walk north into the top wall: stops below it, then rests clear
    P.place(W / 2 + 40, wallH + 120, {}); run(5);
    let st = P.step(0, -400);
    ok(st.blocked && st.y >= wallH + 6, 'walking north stops at the top wall ' + JSON.stringify(st));
    run(300);
    s = P.state();
    ok(s.ok && !s.band && s.y >= wallH + 6, 'let go at the wall it rests clear (stepped out of the band) ' + JSON.stringify([s.x, s.y, s.flags]));
    ok(!probeHits().length, 'no invariant hit for the probe ' + JSON.stringify(probeHits()[0] || ''));
    // walk into a desk from the front: never inside its footprint
    const desk = officeConfig.furniture.find(f => f.type === 'desk' && (f.rotation || 0) === 0);
    const fp = _itemFootprints(desk)[0];
    P.place(fp.x + fp.w / 2, fp.y + fp.h + 60, {}); run(200);
    let inside = false;
    for (let i = 0; i < 60; i++) { P.step(0, -2); if (_feetIn(a.x, a.y)) inside = true; }
    ok(!inside && a.y >= fp.y + fp.h, 'walking into a desk stops outside its footprint (' + Math.round(a.y) + ' vs front ' + (fp.y + fp.h) + ')');
    run(300);
    s = P.state();
    ok(s.ok, 'at rest by the desk: clear (no band, no side overlap) ' + JSON.stringify([s.x, s.y, s.flags]));
    // an interior wall: never crossed
    const wl = (officeConfig.walls.interior || []).find(w => w.y1 === w.y2 && Math.abs(w.x2 - w.x1) >= 3);
    if (wl) {
      const wy = wl.y1 * TILE, wx = (Math.min(wl.x1, wl.x2) + 1.5) * TILE;
      P.place(wx, wy + 50, {}); run(5);
      let crossed = false;
      for (let i = 0; i < 60; i++) { P.step(0, -3); if (a.y < wy) crossed = true; }
      ok(!crossed, 'walking north never crosses an interior wall (y ' + Math.round(a.y) + ', wall ' + wy + ')');
    }
    // the rest rule: placed in a band (not ghost) it walks out
    const band = VOWorld.bands().find(b => b.kind === 'body' && b.w > 40 && b.h > 20);
    if (band) {
      const bx = band.x + 3, by = band.y + band.h / 2;
      P.place(bx, by, {}); run(1);
      const before = VOWorld.clearAt(a.x, a.y);
      run(300);
      s = P.state();
      ok(before && s.ok && !VOWorld.clearAt(a.x, a.y), 'placed in a body band it steps out to clear floor ' + JSON.stringify([s.x, s.y, s.flags]));
    }
    // sit at the nearest seat (the planner walks it there), stand up on the floor point
    const seats = P.seats(), couch = seats.find(t => t.kind !== 'meeting' && !/desk/i.test(t.kind)) || seats[0];
    P.place(couch.fx, couch.fy + 40, {}); run(5);
    const got = P.sit('near');
    let sat = false;
    for (let i = 0; i < 80 && !sat; i++) { run(10); sat = P.state().sitting; }
    s = P.state();
    ok(got && sat && s.seat && !probeHits().length, 'Space / sit(near) walks to a seat and sits ' + JSON.stringify([got && got.type, s.seat && s.seat.type, s.flags]));
    P.stand(); run(2);
    s = P.state();
    ok(!s.sitting && Math.abs(a.x - got.fx) <= 1 && Math.abs(a.y - got.fy) <= 1, 'stand() gets up on the seat floor point');
    // ghost: any spot, out of the invariant; back on: put on valid ground
    P.ghost(true);
    P.place(fp.x + fp.w / 2, fp.y + fp.h / 2, { view: 'down' }); run(3);
    s = P.state();
    ok(s.ghost && s.inFootprint === 'desk' && Math.abs(a.y - (fp.y + fp.h / 2)) < 0.01 && !probeHits().length && _worldPeople().indexOf(a) < 0,
      'ghost: placed inside a desk it stays there, out of the invariant ' + JSON.stringify(s.flags));
    P.ghost(false); run(60);
    ok(!_feetIn(a.x, a.y), 'ghost off: the world puts it on free floor');
    // carry / pose / face / frame
    P.place(W / 2, H / 2, { view: null }); run(120);
    P.carry('coffee'); P.pose('stretch'); P.face('left');
    s = P.state();
    ok(s.carry === 'coffee' && s.pose === 'stretch' && s.view === 'left' && a.idleAction === 'stretch', 'carry / pose / face ' + JSON.stringify([s.carry, s.pose, s.view]));
    P.pose('stand'); P.carry(null); P.face(null);
    const fr = P.frame({ x: a.x - 50, y: a.y - 60, w: 100, h: 80 });
    ok(fr.w > 100 && camera.zoom > 1, 'frame(rect) zooms the camera on the rect ' + JSON.stringify([Math.round(fr.w), camera.zoom.toFixed(2)]));
    return { res, x: a.x, y: a.y };
  });
  out.res.forEach(([c, w]) => ok(c, w));
  // keyboard: ArrowRight walks it east (under the rules), letting go stops it
  const k = await page.evaluate(() => { const a = VOProbe.agent(); VOProbe.place(W / 2 - 100, H / 2, {}); for (let i = 0; i < 120; i++) _simulationStep(); return { x: a.x, y: a.y }; });
  await page.keyboard.down('ArrowRight');
  const k2 = await page.evaluate(() => { for (let i = 0; i < 20; i++) _simulationStep(); const a = VOProbe.agent(); return { x: a.x, view: VOProbe.state().view, moving: VOProbe.state().moving }; });
  await page.keyboard.up('ArrowRight');
  const k3 = await page.evaluate(() => { const a = VOProbe.agent(); _simulationStep(); const x1 = a.x; for (let i = 0; i < 200; i++) _simulationStep(); return { x1, x: a.x, rest: a.x === a.targetX && a.y === a.targetY, ok: VOProbe.state().ok }; });
  ok(k2.x > k.x + 10 && k2.view === 'right' && k2.moving, 'ArrowRight walks east in a side view ' + JSON.stringify([Math.round(k.x), Math.round(k2.x), k2.view]));
  ok(k3.x1 <= k2.x + 0.01 && k3.rest && k3.ok, 'key up: it stops (no key motion), at rest clear (a step out of a band is the rest rule) ' + JSON.stringify([k2.x, k3]));
  await page.keyboard.press('g');
  const g = await page.evaluate(() => VOProbe.state().ghost);
  await page.keyboard.press('g');
  ok(g === true, 'G toggles ghost mode');
  await page.waitForTimeout(450);
  const hud = await page.evaluate(() => { const h = document.getElementById('voProbeHud'); return h ? (h.style.display === 'none' ? 'hidden' : h.textContent) : 'none'; });
  ok(/PROBE \d+,\d+/.test(hud), 'the HUD shows position and flags ' + JSON.stringify(hud.slice(0, 80)));
  ok(!errors.length, 'no page errors ' + (errors[0] || ''));
  await context.close();
} finally {
  await browser.close();
}
const bad = results.filter(r => !r[0]);
results.forEach(([c, w]) => { if (!c || process.env.WORLD_REPORT) console.log((c ? 'ok   ' : 'FAIL ') + w); });
console.log(`test_v10_probe: ${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
