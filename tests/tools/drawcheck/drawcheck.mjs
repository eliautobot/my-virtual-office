// Draw check (v0.12 perf): pixel comparison and a draw micro-benchmark of the real Agent.draw between trees.
//
//   node tests/tools/drawcheck/drawcheck.mjs pixels <treeA> <treeB> [--out file.json]
//   node tests/tools/drawcheck/drawcheck.mjs bench <label=tree> [<label=tree> ...] [--rounds 5] [--reps 150]
//
// A tree is a checkout root (its app/ is served through its own tests/test_v10_studio_lib.mjs on fixture APIs).
// pixels: every hair style x view x headwear (standing, two walking sway frames), hair colours, seated views, every
// expression x view (Agent.draw and the face helpers called directly with every mouth, blink and eye shift), every
// top and neckwear, costumes, signature moves and waves frames, dozing; each at 1:1 and at fractional transforms
// (camera zoom and sub-pixel positions). Prints the number of cases, the number that differ and the first few.
// bench: microseconds per Agent.draw for a mixed crew (median of rounds, trees alternating) and canvas calls per draw.
// Siblings: officeab.mjs (perf office A/B: frame time and the renderer's section timers, fresh browser per
// measurement, order rotated per round), passprof.mjs (CPU self time under one function per frame), aa.mjs (shows
// that canvas fillRect edges are anti-aliased at fractional transforms, so sprite caches are not pixel-identical).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const mode = argv[0];
const PROBE = fs.readFileSync(path.join(here, 'probe.js'), 'utf8');

async function openTree(browser, root) {
  const lib = await import(path.resolve(root, 'tests', 'test_v10_studio_lib.mjs'));
  const { page, context, errors } = await lib.openStudio(browser);
  await page.addScriptTag({ content: PROBE });
  return { page, context, errors };
}

const TF = [[1, 0, 0], [1.37, 0.37, 0.61], [2.625, 0.5, 0.25]];
const LOOK = { skinTone: '#f5d0b0', hairColor: '#5d4037', hairHighlight: null, eyebrowStyle: 'thin', eyeColor: '#212121' };
const COLOURS = [{ hairColor: '#5d4037', hairHighlight: '#8d6e63' }, { hairColor: '#f4d03f', hairHighlight: null, skinTone: '#8d5524' },
  { hairColor: '#fa0', hairHighlight: null, skinTone: '#ffcc80' }, { hairColor: 'red', hairHighlight: null }];

function buildCases(t) {
  const out = [];
  const add = (kind, name, look, o, tfs = [0, 1]) => { for (const k of tfs) out.push({ kind, name: `${name} tf${k}`, look, o, tf: TF[k] }); };
  const F4 = ['down', 'left', 'right', 'up'];
  for (const hs of t.hair) for (const f of F4) for (const hat of ['none'].concat(t.hats)) for (const [p, tick] of [['stand', 0], ['walk', 3], ['walk', 12]]) {
    add('agent', `hair ${hs} ${f} ${hat} ${p}${tick}`, { ...LOOK, hairStyle: hs, headwear: hat === 'none' ? undefined : hat, headwearColor: '#e53935' }, { facing: f, pose: p, tick });
  }
  for (const hs of t.hair) for (const f of ['down', 'right', 'up']) COLOURS.forEach((c, i) => add('agent', `hair-colour ${hs} ${f} c${i}`, { ...LOOK, ...c, hairStyle: hs }, { facing: f }, [1]));
  for (const hs of t.hair) for (const f of F4) for (const p of ['sit', 'type', 'idle']) for (const hat of ['none', 'cap', 'crown']) {
    add('agent', `seated ${hs} ${f} ${p} ${hat}`, { ...LOOK, hairStyle: hs, headwear: hat === 'none' ? undefined : hat }, { facing: f, pose: p, tick: 7 }, [1]);
  }
  const lookVariants = [
    { eyebrowStyle: 'thin', lashes: true, facialHair: 'none', glasses: 'none' },
    { eyebrowStyle: 'thick', lashes: false, facialHair: 'beard', glasses: 'round', facialHairColor: '#3e2723' },
    { eyebrowStyle: t.brows[2] || 'thin', facialHair: 'goatee', glasses: 'square', eyeColor: '#1565c0', lipColor: '#c4626a' },
    { eyebrowStyle: t.brows[3] || 'thick', facialHair: 'mustache', glasses: 'sunglasses', hairStyle: 'bald' },
    { facialHair: 'stubble', glasses: 'none', skinTone: '#5d4037', hairColor: '#212121', hairStyle: 'afro' },
    { eyebrowStyle: 'nope', lashes: null, hairColor: 'blue', hairStyle: 'curly' }];
  for (const e of t.expr) for (const f of F4) for (const gd of ['M', 'F']) lookVariants.forEach((v, i) => {
    add('agent', `face ${e} ${f} ${gd} v${i}`, { ...LOOK, hairStyle: 'short', ...v }, { facing: f, expression: e, gender: gd, tick: 5 });
  });
  const apps = lookVariants.slice(0, 4).map(v => ({ ...LOOK, hairStyle: 'short', ...v }));
  for (const e of t.expr) for (const mouth of [undefined, 'laugh', 'open', 'half', 'smile', 'closed', 'talk', 'talkShut'])
    for (const es of [-2, 0, 1]) for (const closed of [false, true]) for (const fem of [false, true]) apps.forEach((a, i) => {
      for (const k of [0, 1]) out.push({ kind: 'direct', fn: '_drawFaceFront', name: `faceFront ${e} ${mouth} es${es} c${closed} f${fem} a${i} tf${k}`, args: [a, fem, es, closed, e, mouth], tf: TF[k] });
    });
  for (const e of t.expr) for (const dir of [-1, 1]) for (const blink of [false, true]) for (const fem of [false, true]) apps.forEach((a, i) => {
    for (const k of [0, 1]) out.push({ kind: 'direct', fn: '_drawHeadSide', name: `headSide ${e} d${dir} b${blink} f${fem} a${i} tf${k}`, args: [a, dir, fem, blink, e], tf: TF[k] });
  });
  // the hair art directly: every style x view x dir x colours x sway x headwear
  for (const hs of t.hair) for (const [view, dir] of [['front', 1], ['back', 1], ['side', 1], ['side', -1]]) for (const sway of [0, -1, 1])
    for (const hat of [null].concat(t.hats)) COLOURS.slice(0, 3).forEach((c, i) => {
      out.push({ kind: 'direct', fn: '_drawHairArt', name: `hairArt ${hs} ${view}${dir} s${sway} ${hat} c${i}`, args: [hs, view, dir, c.hairColor, c.hairHighlight],
        pose: { sway, hat, skin: c.skinTone || '#f5d0b0' }, tf: TF[1] });
    });
  for (const top of t.tops) for (const f of F4) for (const p of ['stand', 'walk', 'sit', 'type']) for (const nk of t.neck) for (const col of ['#1e88e5', '#212121']) {
    add('agent', `top ${top} ${f} ${p} ${nk} ${col}`, { ...LOOK, hairStyle: 'short', top, neckwear: nk, neckwearColor: '#c62828' }, { facing: f, pose: p, color: col, tick: 4 }, [1]);
  }
  for (const cos of t.costumes) for (const f of F4) for (const p of ['stand', 'walk', 'sit', 'type'])
    add('agent', `costume ${cos} ${f} ${p}`, { ...LOOK, hairStyle: 'long', costume: cos }, { facing: f, pose: p, tick: 4 });
  for (const mv of t.moves) for (const p of ['stand', 'sit']) {
    for (let i = 0; i < 20; i++) add('agent', `move ${mv} ${p} ${i}`, { ...LOOK, hairStyle: 'ponytail', headwear: i % 5 === 0 ? 'cap' : undefined }, { facing: 'down', pose: p, sigMove: mv, sigP: i / 20 });
    add('agent', `move ${mv} ${p} still`, { ...LOOK, hairStyle: 'ponytail' }, { facing: 'down', pose: p, sigMove: mv, sigP: 0.5, sigStill: true });
  }
  if (t.waveMs) for (const wk of Object.keys(t.waveMs)) for (const kind of ['wave', 'tap']) for (const still of [false, true]) for (const p of ['stand', 'sit']) {
    const dur = kind === 'wave' && wk !== 'stir' ? t.waveBig : t.waveMs[wk];
    for (let i = 0; i < 10; i++) add('agent', `waveframe ${wk} ${kind} ${still} ${p} ${i}`, { ...LOOK, hairStyle: 'bun' }, { facing: 'down', pose: p, wave: { wk, kind, still, ms: dur * i / 10 } }, [1]);
  }
  for (const f of F4) for (const hs of ['short', 'afro', 'long', 'bald']) for (const p of ['sit', 'stand'])
    add('agent', `dozing ${hs} ${f} ${p}`, { ...LOOK, hairStyle: hs, headwear: 'beanie' }, { facing: f, pose: p, state: 'offline', tick: 9 });
  return out;
}

function benchCases(t) {
  const out = [], F4 = ['down', 'left', 'right', 'up'];
  for (let i = 0; i < 28; i++) {
    const p = ['stand', 'walk', 'type', 'sit'][i % 4], f = F4[(i >> 2) % 4];
    out.push({ look: { ...LOOK, hairStyle: t.hair[i % t.hair.length], top: t.tops[i % t.tops.length], headwear: i % 7 === 3 ? t.hats[i % t.hats.length] : undefined,
      glasses: i % 5 === 1 ? 'round' : 'none', facialHair: i % 6 === 2 ? 'beard' : 'none' },
      o: { facing: f, pose: p, gender: i % 2 ? 'F' : 'M', expression: t.expr[i % t.expr.length], preview: false } });
  }
  return out;
}

const { launch } = await import(path.resolve(here, '..', '..', 'test_v10_studio_lib.mjs'));
const browser = await launch('drawcheck');
try {
  if (mode === 'pixels') {
    const [A, B] = [argv[1], argv[2]];
    const a = await openTree(browser, A);
    const t = await a.page.evaluate(() => __drawcheck.tables());
    const cases = buildCases(t);
    const run = async (pg) => {
      const res = [];
      for (let i = 0; i < cases.length; i += 400) {
        res.push(...await pg.evaluate(list => list.map(c => c.kind === 'agent' ? __drawcheck.render(c.look, c.o, c.tf) : __drawcheck.direct(c.fn, c.args, c.tf, c.pose)), cases.slice(i, i + 400)));
      }
      return res;
    };
    const ha = await run(a.page);
    await a.context.close();
    const b = await openTree(browser, B);
    const hb = await run(b.page);
    await b.context.close();
    const diff = [], errs = [], kinds = {};
    cases.forEach((c, i) => {
      const k = c.name.split(' ')[0]; kinds[k] = (kinds[k] || 0) + 1;
      if (ha[i] !== hb[i]) diff.push(c.name);
      if (String(ha[i]).startsWith('ERR') || String(hb[i]).startsWith('ERR')) errs.push(`${c.name}: ${ha[i]} | ${hb[i]}`);
    });
    const blank = cases.filter((c, i) => String(ha[i]).endsWith(':0')).length;
    if (opt('out')) fs.writeFileSync(opt('out'), JSON.stringify({ cases: cases.map(c => c.name), a: ha, b: hb, diff, errs }, null, 0));
    console.log(`cases ${cases.length} (${Object.entries(kinds).map(([k, v]) => k + ' ' + v).join(', ')}); blank ${blank}; errors ${errs.length}; DIFFER ${diff.length}`);
    diff.slice(0, 8).forEach(n => console.log('  differs: ' + n));
    errs.slice(0, 4).forEach(n => console.log('  error: ' + n.slice(0, 200)));
    process.exitCode = diff.length || errs.length ? 1 : 0;
  } else if (mode === 'bench') {
    const trees = argv.slice(1).filter(x => x.includes('=')).map(x => ({ label: x.split('=')[0], root: x.split('=')[1] }));
    const rounds = Number(opt('rounds', 5)), reps = Number(opt('reps', 150));
    const pages = [];
    for (const tr of trees) pages.push({ ...tr, ...(await openTree(browser, tr.root)) });
    const t = await pages[0].page.evaluate(() => __drawcheck.tables());
    const cases = benchCases(t);
    const times = Object.fromEntries(trees.map(x => [x.label, []]));
    for (let r = 0; r < rounds; r++) for (const p of pages) times[p.label].push(await p.page.evaluate(([c, n]) => __drawcheck.bench(c, n), [cases, reps]));
    for (const p of pages) {
      const s = times[p.label].slice().sort((x, y) => x - y), calls = await p.page.evaluate(c => __drawcheck.countCalls(c), cases);
      console.log(`${p.label}: ${s[s.length >> 1].toFixed(1)} us/agent draw (min ${s[0].toFixed(1)}, max ${s[s.length - 1].toFixed(1)}); calls/draw ${JSON.stringify(calls)}`);
    }
  } else if (mode === 'profile') {
    // profile <tree>: CPU profile of the bench crew's draws, top self-time functions (file:line)
    const aggregateProfile = (pr, top) => {        // raw self time per function (native calls under their own name)
      const self = new Map(), byId = new Map(pr.nodes.map(n => [n.id, n])), dt = pr.timeDeltas || [];
      (pr.samples || []).forEach((id, i) => { const cf = byId.get(id).callFrame; if (/^\((idle|program|root|garbage collector)\)$/.test(cf.functionName)) return;
        const k = (cf.functionName || '(anon)') + ' ' + (cf.url ? cf.url.split('/').pop().split('?')[0] + ':' + (cf.lineNumber + 1) : ''); self.set(k, (self.get(k) || 0) + (dt[i] || 0)); });
      const busy = [...self.values()].reduce((a, b) => a + b, 0);
      return [{ fn: 'TOTAL', ms: +(busy / 1000).toFixed(1) }].concat([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, us]) => ({ fn: k, ms: +(us / 1000).toFixed(1), pct: +(100 * us / busy).toFixed(1) })));
    };
    const p = await openTree(browser, argv[1]);
    const t = await p.page.evaluate(() => __drawcheck.tables());
    const cases = benchCases(t), cdp = await p.context.newCDPSession(p.page);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp.send('Profiler.start');
    await p.page.evaluate(([c, n]) => __drawcheck.bench(c, n), [cases, Number(opt('reps', 400))]);
    const { profile } = await cdp.send('Profiler.stop');
    const top = aggregateProfile(profile, Number(opt('top', 16)));
    for (const row of top) console.log(JSON.stringify(row).slice(0, 160));
  } else console.log('usage: drawcheck.mjs pixels <treeA> <treeB> | bench <label=tree>... | profile <tree>');
} finally {
  await browser.close();
}
