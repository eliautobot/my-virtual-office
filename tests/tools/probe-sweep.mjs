// PROBE SWEEP (v0.10.1, review 11-07): walk the PROBE (app/vo-probe.js) round every furniture type x rotation, through
// gaps, along every wall kind, into every seat and use spot, carrying things; render each sample through the real
// frame and score it from the pixels (tests/tools/probe-sweep-page.js has the rules). Headless, hermetic (fixture
// APIs; a live layout is read from a file, never written).
//   node tests/tools/probe-sweep.mjs [--app DIR] [--out DIR] [--mode gallery,gaps,walls,live] [--only type,...]
//        [--layout FILE] [--sheet N] [--walks N] [--quiet]
// Writes OUT/samples.jsonl (every scored sample with a finding), OUT/summary.json + summary.txt (ranked findings
// by tag and by case), OUT/sheet.jpg (contact sheet of the worst samples, one per case first) and prints a short
// summary. Exit 0 always (a tool; tests/test_v10_probe_sweep.mjs is the gate).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findChrome, openOffice, launch } from './probe-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const APP = path.resolve(arg('app', path.resolve(here, '..', '..', 'app')));
const OUT = path.resolve(arg('out', '/tmp/vo8096p-probe/sweep'));
const MODES = arg('mode', 'gallery,gaps,walls').split(',');
const ONLY = arg('only', '') ? arg('only').split(',') : null;
const SHEET = Number(arg('sheet', 36)), WALKS = Number(arg('walks', 16)), QUIET = argv.includes('--quiet');
const LAYOUT = arg('layout', '');
fs.mkdirSync(OUT, { recursive: true });
const pw = loadPlaywright(), chrome = findChrome();
if (!pw || !chrome) { console.log('probe-sweep: playwright-core / Chrome not found'); process.exit(0); }

const def = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
const empty = JSON.parse(JSON.stringify(def));
empty.furniture = []; empty.walls.interior = []; empty.pet = Object.assign({}, empty.pet, { enabled: false });
const T = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const WALL_CASES = [
  { name: 'wall horizontal', interior: [T(9, 11, 16, 11)], win: { x: 300, y: 330, w: 400, h: 220 } },
  { name: 'wall vertical', interior: [T(14, 7, 14, 13)], win: { x: 440, y: 230, w: 240, h: 330 } },
  { name: 'wall door gap h', interior: [T(7, 11, 12, 11), T(14, 11, 19, 11)], win: { x: 380, y: 330, w: 280, h: 220 } },
  { name: 'wall door gap v', interior: [T(14, 4, 14, 8), T(14, 10, 14, 15)], win: { x: 440, y: 250, w: 240, h: 230 } },
  { name: 'wall corner L', interior: [T(9, 12, 14, 12), T(14, 7, 14, 12)], win: { x: 380, y: 240, w: 300, h: 300 } },
  { name: 'wall junction T', interior: [T(9, 10, 19, 10), T(14, 10, 14, 15)], win: { x: 420, y: 300, w: 280, h: 300 } },
  { name: 'wall back (top)', interior: [], win: { x: 300, y: 60, w: 400, h: 200 } },
];

const t0 = Date.now();
const browser = await launch(pw, chrome);
const all = [], byCase = [];
let errors = [];
try {
  const pages = [];
  const open = async (config) => {
    const o = await openOffice(browser, { app: APP, config, agents: [], viewport: { width: 960, height: 720 }, noSpawn: true, seed: 11 });
    await o.page.evaluate(() => { VOProbe.spawn(W / 2, H / 2); });
    await o.page.addScriptTag({ content: fs.readFileSync(path.join(here, 'probe-sweep-page.js'), 'utf8') });
    await o.page.waitForFunction(() => window.__ps && __ps.ready);
    pages.push(o); errors = o.errors;
    return o.page;
  };
  const runCases = async (page, cases, tag) => {
    for (const spec of cases) {
      const info = await page.evaluate((s) => __ps.setup(s), spec);
      const samples = await page.evaluate((o) => __ps.samples(o), { walks: WALKS, extraWalks: spec.extraWalks || [] });
      let bad = 0, sum = 0;
      for (let i = 0; i < samples.length; i += 60) {
        const res = await page.evaluate((list) => list.map((s) => __ps.score(s)), samples.slice(i, i + 60));
        res.forEach((r, j) => {
          if (!r || !r.score) return;
          const s = samples[i + j];
          bad++; sum += r.score;
          all.push({ mode: tag, case: spec.name, spec: spec.name, s, score: r.score, tags: r.tags });
        });
      }
      byCase.push({ mode: tag, case: spec.name, samples: samples.length, bad, score: Math.round(sum), k: info.k });
      if (!QUIET && bad) console.log(`  ${spec.name}: ${bad}/${samples.length} bad, score ${Math.round(sum)}`);
    }
  };
  if (MODES.some(m => m === 'gallery' || m === 'gaps' || m === 'walls')) {
    const page = await open(empty);
    if (MODES.includes('gallery')) await runCases(page, await page.evaluate((f) => __ps.galleryCases(f, 0), ONLY), 'gallery');
    if (MODES.includes('gaps')) await runCases(page, await page.evaluate((f) => __ps.galleryCases(f, 4), ONLY), 'gaps');
    if (MODES.includes('walls')) await runCases(page, WALL_CASES.map(c => Object.assign({ furniture: [] }, c)), 'walls');
  }
  if (MODES.includes('live')) {
    const cfg = JSON.parse(fs.readFileSync(LAYOUT || '/tmp/vo8096p-probe/live-office-config.json', 'utf8'));
    cfg.pet = Object.assign({}, cfg.pet, { enabled: false });
    const page = await open(cfg);
    await runCases(page, await page.evaluate(() => __ps.liveCases(360, 300)), 'live');
  }
  // rank
  all.sort((a, b) => b.score - a.score);
  const byTag = {};
  all.forEach((f) => Object.entries(f.tags).forEach(([k, v]) => {
    const t = byTag[k] || (byTag[k] = { tag: k, n: 0, sum: 0, cases: new Set(), worst: null });
    t.n++; t.sum += v; t.cases.add(f.case); if (!t.worst || v > t.worst.v) t.worst = { v, case: f.case, x: f.s.x, y: f.s.y, view: f.s.view, kind: f.s.kind };
  }));
  const tags = Object.values(byTag).map(t => ({ tag: t.tag, n: t.n, sum: Math.round(t.sum), cases: [...t.cases].slice(0, 12), ncases: t.cases.size, worst: t.worst }))
    .sort((a, b) => b.sum - a.sum);
  const total = byCase.reduce((a, c) => ({ samples: a.samples + c.samples, bad: a.bad + c.bad, score: a.score + c.score }), { samples: 0, bad: 0, score: 0 });
  const summary = { app: APP, modes: MODES, total, cases: byCase.length, secs: Math.round((Date.now() - t0) / 1000), tags, byCase: byCase.filter(c => c.bad).sort((a, b) => b.score - a.score), errors: errors.slice(0, 3) };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(OUT, 'samples.jsonl'), all.map(f => JSON.stringify(f)).join('\n') + '\n');
  const txt = [`probe sweep ${MODES.join(',')} on ${APP}: ${total.samples} samples in ${byCase.length} cases, ${total.bad} with findings, score ${total.score} (${summary.secs} s)`,
    '', 'BY TAG (tag|piece/part: samples, world px^2 sum, cases)', ...tags.map(t => `${t.tag}: ${t.n} samples, ${t.sum}, ${t.ncases} cases e.g. ${t.cases.slice(0, 4).join('; ')} | worst ${t.worst.v} at ${t.worst.case} ${t.worst.x},${t.worst.y} ${t.worst.view || ''} ${t.worst.kind}`),
    '', 'BY CASE', ...summary.byCase.map(c => `${c.case}: ${c.bad}/${c.samples}, score ${c.score}`)];
  fs.writeFileSync(path.join(OUT, 'summary.txt'), txt.join('\n') + '\n');
  // contact sheet: the worst sample of each case first, then the next worst
  if (SHEET > 0 && all.length) {
    const pick = [], seenCase = new Set();
    for (const f of all) if (!seenCase.has(f.case) && pick.length < SHEET) { seenCase.add(f.case); pick.push(f); }
    for (const f of all) if (pick.length < SHEET && !pick.includes(f)) pick.push(f);
    const tiles = [];
    const pageFor = (f) => pages[f.mode === 'live' ? pages.length - 1 : 0].page;
    let curCase = null;
    for (const f of pick.sort((a, b) => (a.mode + a.case).localeCompare(b.mode + b.case))) {
      const page = pageFor(f);
      if (curCase !== f.mode + f.case) {
        const spec = f.mode === 'walls' ? Object.assign({ furniture: [] }, WALL_CASES.find(c => c.name === f.case))
          : f.mode === 'live' ? (await page.evaluate(() => __ps.liveCases(360, 300))).find(c => c.name === f.case)
          : (await page.evaluate(([fl, g]) => __ps.galleryCases(fl, g), [[f.case.replace(/^gap\d+ /, '').split('/')[0]], f.mode === 'gaps' ? 4 : 0])).find(c => c.name === f.case);
        await page.evaluate((s) => __ps.setup(s), spec);
        curCase = f.mode + f.case;
      }
      const url = await page.evaluate((s) => __ps.shot(s, 200, 200, 2.6), f.s);
      const top = Object.entries(f.tags).sort((a, b) => b[1] - a[1])[0];
      tiles.push({ url, bad: true, label: `${f.case} ${f.s.kind} ${f.s.view || 'seat'}${f.s.carry ? ' ' + f.s.carry : ''} ${f.s.x},${f.s.y}\n${top[0]} ${top[1]} (${f.score})`, score: f.score });
    }
    tiles.sort((a, b) => b.score - a.score);
    const jpg = await pages[0].page.evaluate(([t, title]) => __ps.sheet(t, 6, 200, 200, title), [tiles, `probe sweep ${MODES.join(',')}: worst ${tiles.length} (score ${total.score}, ${total.bad}/${total.samples} samples)`]);
    fs.writeFileSync(path.join(OUT, 'sheet.jpg'), Buffer.from(jpg.split(',')[1], 'base64'));
  }
  console.log(txt.slice(0, 1)[0]);
  tags.slice(0, 14).forEach(t => console.log(`  ${t.tag}: ${t.n} / ${t.sum} (${t.ncases} cases)`));
  if (errors.length) console.log('page errors: ' + errors[0]);
  for (const o of pages) await o.context.close();
} finally {
  await browser.close();
}
