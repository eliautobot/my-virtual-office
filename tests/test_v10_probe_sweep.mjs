// v0.10.1 PROBE SWEEP regression (review 11-07: walk a test person round every piece and wall, assess how it looks,
// correct it). A representative subset of tests/tools/probe-sweep.mjs, < 60 s: the probe (app/vo-probe.js) at the
// closest allowed spots round pieces and walls, walked past by the planner, seated, at use spots, holding / carrying
// things, each rendered through the real frame and scored from the pixels (tests/tools/probe-sweep-page.js).
// Checks:
//   0 the scorer works: the review case (a person 8 px beside the coffee table's end at its depth, ghost-placed) scores a
//     side overlap; the same person clear in front of it scores nothing;
//   1 meeting table (every rotation): nobody rests among the chairs (side / layering findings, was 9411 px^2);
//   2 vertical walls, door gaps, corners: no hand or held item over a wall strip (was 3595);
//   3 dart board: no face behind its board (was 2126 incl. the gap case); desk, couch, coffee table, vending machine,
//     bookshelf, water cooler, ping pong, boss desk turned: no side overlap, no wrong layering, no covered face;
//   4 the live 8096 layout (anonymised fixture): two windows (the lounge + the boss office): clean at rest; walking,
//     only a wall strip in the layout-forced narrow passages;
//   no page errors. SWEEP_REPORT=1 prints every check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findChrome, openOffice, launch } from './tools/probe-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.WORLD_APP || path.resolve(here, '..', 'app'));
const REPORT = !!process.env.SWEEP_REPORT;
const pw = loadPlaywright(), chrome = findChrome();
if (!pw || !chrome) { console.log('SKIP test_v10_probe_sweep: playwright-core / Chrome not found'); process.exit(0); }
const PAGE = fs.readFileSync(path.join(here, 'tools', 'probe-sweep-page.js'), 'utf8');
const def = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
const empty = JSON.parse(JSON.stringify(def));
empty.furniture = []; empty.walls.interior = []; empty.pet = Object.assign({}, empty.pet, { enabled: false });
const live = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'world-layout-8096.json'), 'utf8'));
live.pet = Object.assign({}, live.pet, { enabled: false });
const T = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const results = [];
const ok = (c, what) => results.push([!!c, what]);
const t0 = Date.now();

// visual findings (art-out is a note); side / layering / face / wall tags summed per run
const sum = (runs, re) => runs.reduce((a, r) => a + Object.entries(r.tags).filter(([k]) => re.test(k)).reduce((b, [, v]) => b + v, 0), 0);
const VISUAL = /^(side|hidden-front|over-behind|face|wall-|inside|seat-hidden)/;
const worst = (runs) => { const r = runs.slice().sort((a, b) => b.score - a.score)[0]; return r ? `${r.case} ${r.s.kind} ${r.s.x},${r.s.y} ${JSON.stringify(r.tags)}` : '-'; };

const browser = await launch(pw, chrome);
try {
  const open = async (config) => {
    const o = await openOffice(browser, { app: APP, config, agents: [], viewport: { width: 960, height: 720 }, noSpawn: true, seed: 11 });
    await o.page.evaluate(() => VOProbe.spawn(W / 2, H / 2));
    await o.page.addScriptTag({ content: PAGE });
    await o.page.waitForFunction(() => window.__ps && __ps.ready);
    return o;
  };
  const run = async (page, cases, walks) => {
    const out = [];
    for (const spec of cases) {
      await page.evaluate((s) => __ps.setup(s), spec);
      const samples = await page.evaluate((o) => __ps.samples(o), { walks, extraWalks: spec.extraWalks || [] });
      for (let i = 0; i < samples.length; i += 80) {
        const res = await page.evaluate((list) => list.map((s) => __ps.score(s)), samples.slice(i, i + 80));
        res.forEach((r, j) => { if (r && r.score) out.push({ case: spec.name, s: samples[i + j], score: r.score, tags: r.tags }); });
      }
      out.n = (out.n || 0) + samples.length;
    }
    return out;
  };
  const g = await open(empty);
  // 0 the scorer: the review case
  const ctl = await g.page.evaluate(() => {
    const spec = __ps.galleryCases(['coffeeTable'], 0).find(c => c.name === 'coffeeTable/0');
    __ps.setup(spec);
    const fp = _itemFootprints(officeConfig.furniture[0])[0];
    const beside = __ps.score({ x: fp.x - 8, y: fp.y + fp.h / 2, view: 'down', kind: 'ctl' });
    const front = __ps.score({ x: fp.x + fp.w / 2, y: fp.y + fp.h + 30, view: 'down', kind: 'ctl' });
    return { beside: beside.tags, front: front.tags };
  });
  ok((ctl.beside['side|coffeeTable/box'] || 0) > 30, 'scorer: a person 8 px beside the coffee table end at its depth is a side overlap ' + JSON.stringify(ctl.beside));
  ok(!Object.keys(ctl.front).length, 'scorer: clear in front of it: nothing ' + JSON.stringify(ctl.front));
  // 1-3 gallery subset
  const types = ['meetingTable', 'dartBoard', 'desk', 'couch', 'coffeeTable', 'vendingMachine', 'bookshelf', 'waterCooler', 'pingPongTable', 'bossDesk'];
  const all = await g.page.evaluate((t) => __ps.galleryCases(t, 0), types);
  const pick = all.filter(c => /^meetingTable\//.test(c.name) || ['dartBoard/0', 'desk/0', 'desk/90', 'couch/90', 'coffeeTable/0', 'vendingMachine/0', 'bookshelf/0', 'waterCooler/0', 'pingPongTable/0', 'bossDesk/180', 'bossDesk/270'].includes(c.name));
  const gal = await run(g.page, pick, 8);
  const meet = gal.filter(r => /^meetingTable/.test(r.case)), dart = gal.filter(r => /^dartBoard/.test(r.case)), rest = gal.filter(r => !/^meetingTable|^dartBoard/.test(r.case));
  ok(sum(meet, VISUAL) < 120, `meeting table x 4 rotations: nobody among the chairs (visual ${Math.round(sum(meet, VISUAL))} px^2, was 9411; worst ${worst(meet)})`);
  ok(sum(dart, /^face/) === 0 && sum(dart, VISUAL) < 40, `dart board: no face behind the board (face ${sum(dart, /^face/)}, visual ${Math.round(sum(dart, VISUAL))}; worst ${worst(dart)})`);
  ok(sum(rest, VISUAL) < 60, `desk, couch, coffee table, vending, bookshelf, water cooler, ping pong, boss desk: visual ${Math.round(sum(rest, VISUAL))} px^2 (worst ${worst(rest)})`);
  const walls = await run(g.page, [
    { name: 'wall vertical', furniture: [], interior: [T(14, 7, 14, 13)], win: { x: 440, y: 230, w: 240, h: 330 } },
    { name: 'wall door gap v', furniture: [], interior: [T(14, 4, 14, 8), T(14, 10, 14, 15)], win: { x: 440, y: 250, w: 240, h: 230 } },
    { name: 'wall corner L', furniture: [], interior: [T(9, 12, 14, 12), T(14, 7, 14, 12)], win: { x: 380, y: 240, w: 300, h: 300 } },
    { name: 'wall door gap h', furniture: [], interior: [T(7, 11, 12, 11), T(14, 11, 19, 11)], win: { x: 380, y: 330, w: 280, h: 220 } },
  ], 8);
  ok(sum(walls, VISUAL) < 30, `walls (vertical, door gaps, corner): no body over a wall (visual ${Math.round(sum(walls, VISUAL))} px^2, wall-side was 3595; worst ${worst(walls)})`);
  ok(gal.n + walls.n > 3000, `samples scored: ${gal.n + walls.n}`);
  ok(!g.errors.length, 'no page errors (gallery) ' + (g.errors[0] || ''));
  await g.context.close();
  // 4 live fixture, two windows
  const l = await open(live);
  const lcases = (await l.page.evaluate(() => __ps.liveCases(360, 300))).filter(c => c.name === 'live 0,0' || c.name === 'live 600,0');
  const lr = await run(l.page, lcases, 8);
  // at rest (standing, use spots, seats) nothing; walking, only a wall strip in the layout's narrow passages (a lane
  // between the lounge couch / the boss office and a partition wall narrower than the bands: a crossing, rule 3)
  const lrest = lr.filter(r => !r.s.walk), lwalk = lr.filter(r => r.s.walk), other = lwalk.filter(r => Object.keys(r.tags).some(k => VISUAL.test(k) && !/^wall-side/.test(k)));
  ok(lcases.length === 2 && sum(lrest, VISUAL) < 20, `live layout (lounge + boss office windows, ${lr.n} samples): at rest clean (visual ${Math.round(sum(lrest, VISUAL))}; worst ${worst(lrest)})`);
  ok(sum(other, VISUAL) < 30 && sum(lwalk, /^wall-side/) < 600, `live walks: only a wall strip in the narrow passages (wall-side ${Math.round(sum(lwalk, /^wall-side/))}, other ${Math.round(sum(other, VISUAL))}; worst ${worst(lwalk)})`);
  ok(!l.errors.length, 'no page errors (live) ' + (l.errors[0] || ''));
  await l.context.close();
} finally {
  await browser.close();
}
const bad = results.filter(r => !r[0]);
results.forEach(([c, w]) => { if (!c || REPORT) console.log((c ? 'ok   ' : 'FAIL ') + w.slice(0, 400)); });
console.log(`test_v10_probe_sweep: ${results.length - bad.length}/${results.length} passed (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(bad.length ? 1 : 0);
