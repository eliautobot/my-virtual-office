#!/usr/bin/env node
// v0.12 polish: the probe-sweep scorer (tests/tools/probe-sweep-page.js, PS.score) skips the face measure for a person
// cut by the canvas edge (the ratio would be over the on-canvas sliver only; commit c52ca99). This test runs the
// scorer twice, each in a fresh page with the same config and seed: as it is, and with only that skip removed (built
// from the same source by replacing the one condition; the test fails if the condition is not found). Over every sample of the live fixture's windows and
// of pieces that hide faces, rendered through the real frame:
//   - a person fully on the canvas scores exactly the same with and without the skip (score, every tag, face %);
//   - a person cut by the edge never gets a face tag, and the sweep has such persons (the skip is exercised);
//   - the face measure still works for people fully on the canvas (one standing right behind each tall piece).
// The two pages agree sample for sample because the scorer pins the probe's eyes open (the random blink is not
// in the same state in two pages) and draws it alone on whole world pixels like the frame (v0.13 polish).
// Run: node tests/test_v12_probe_sweep_edge.mjs   (needs playwright-core and Chrome; else SKIP)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findChrome, openOffice, launch } from './tools/probe-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.VO_APP_DIR ? path.resolve(process.env.VO_APP_DIR) : path.resolve(here, '..', 'app');
const PAGE = fs.readFileSync(path.join(here, 'tools', 'probe-sweep-page.js'), 'utf8');
const SKIP_COND = 'if (face > 0.15 && !cut) tags[';
assert.equal(PAGE.split(SKIP_COND).length, 2, 'the edge skip is in the scorer (one place)');
const OLD = PAGE.replace(SKIP_COND, 'if (face > 0.15) tags[').replace('var PS = window.__ps = {};', 'var PS = window.__psNoSkip = {};');
assert.notEqual(OLD.indexOf('window.__psNoSkip'), -1);

const pw = loadPlaywright(), chrome = findChrome();
if (!pw || !chrome) { console.log('SKIP test_v12_probe_sweep_edge: playwright-core or Chrome missing'); process.exit(0); }
const live = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'world-layout-8096.json'), 'utf8'));
live.pet = Object.assign({}, live.pet, { enabled: false });
const def = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
const empty = JSON.parse(JSON.stringify(def));
empty.furniture = []; empty.walls.interior = []; empty.pet = Object.assign({}, empty.pet, { enabled: false });
let failures = 0;
const check = (c, what) => { console.log((c ? 'ok - ' : 'not ok - ') + what); if (!c) failures++; };

const browser = await launch(pw, chrome);
// Every sample of each config scored by one scorer in a fresh page (two copies in one page would share the frame clock).
const CONFIGS = [[live, 'live', (p) => p.evaluate(() => __ps.liveCases(360, 300))],
  [empty, 'pieces', (p) => p.evaluate(() => __ps.galleryCases(['bookshelf', 'tallPlant', 'vendingMachine', 'whiteboard'], 0))]];
async function scoreAll(config, pick, script) {
  const o = await openOffice(browser, { app: APP, config, agents: [], viewport: { width: 960, height: 720 }, noSpawn: true, seed: 11 });
  await o.page.evaluate(() => VOProbe.spawn(W / 2, H / 2));
  await o.page.addScriptTag({ content: script });
  await o.page.waitForFunction(() => (window.__ps && __ps.ready) || (window.__psNoSkip && __psNoSkip.ready));
  await o.page.evaluate(() => { if (!window.__ps) window.__ps = window.__psNoSkip; });
  const out = [];
  for (const spec of await pick(o.page)) {
    await o.page.evaluate((sp) => __ps.setup(sp), spec);
    const samples = await o.page.evaluate((w) => __ps.samples(w), { walks: 8, extraWalks: spec.extraWalks || [] });
    // and one person standing right behind each piece, its face behind the art (the face measure must fire)
    if (/^(bookshelf|tallPlant|vendingMachine|whiteboard)\//.test(spec.name)) samples.push(...await o.page.evaluate(() =>
      officeConfig.furniture.flatMap((it) => _itemFootprints(it).map((fp) => ({ x: Math.round(fp.x + fp.w / 2), y: Math.round(fp.y - 3), view: 'up', kind: 'behind' })))));
    for (let i = 0; i < samples.length; i += 80) {
      const res = await o.page.evaluate((l) => l.map((s) => __ps.score(s)), samples.slice(i, i + 80));
      res.forEach((r, j) => out.push({ name: spec.name, s: samples[i + j], r }));
    }
  }
  check(!o.errors.length, 'no page errors ' + (o.errors[0] || ''));
  await o.context.close();
  return out;
}
try {
  const stats = { on: 0, cut: 0, same: 0, diff: [], cutFace: [], onFace: 0, cutFaceOld: 0 };
  for (const [config, label, pick] of CONFIGS) {
    const now = await scoreAll(config, pick, PAGE), old = await scoreAll(config, pick, OLD);
    check(now.length === old.length && now.length > 0, `${label}: the same ${now.length} samples both times`);
    now.forEach((x, j) => {
      const r = x.r, q = old[j] && old[j].r;
      if (!r || r.empty || !q) return;
      const faceTag = Object.keys(r.tags).some((k) => /^face/.test(k)), faceOld = Object.keys(q.tags).some((k) => /^face/.test(k));
      if (r.cut) {
        stats.cut++;
        if (faceTag) stats.cutFace.push(x.name + ' ' + x.s.x + ',' + x.s.y);
        if (faceOld) stats.cutFaceOld++;
        return;
      }
      stats.on++;
      if (faceTag) stats.onFace++;
      const { cut: _c, ...a } = r, { cut: _d, ...b } = q;
      if (JSON.stringify(a) === JSON.stringify(b)) stats.same++;
      else if (stats.diff.length < 3) stats.diff.push(x.name + ' ' + JSON.stringify(a).slice(0, 80) + ' vs ' + JSON.stringify(b).slice(0, 80));
    });
  }
  console.log(`  ${stats.on} people fully on the canvas, ${stats.cut} cut by its edge (${stats.cutFaceOld} of them got a face tag without the skip)`);
  check(stats.on > 100 && stats.same === stats.on, `fully on the canvas: the same score with and without the skip (${stats.same}/${stats.on}) ${stats.diff.join(' | ')}`);
  check(stats.onFace > 0, `the face measure still works on the canvas (${stats.onFace} face tags)`);
  check(stats.cut > 0 && stats.cutFace.length === 0, `cut by the edge: no face tag (${stats.cut} people) ${stats.cutFace.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
}
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
