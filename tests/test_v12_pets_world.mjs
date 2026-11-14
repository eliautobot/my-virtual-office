#!/usr/bin/env node
// v0.12 pets (e): the pet keeps the world rules with beds, bowls and a favourite. Several layouts (the default office,
// the anonymised real layout, a crowded one with the pieces pushed into corners), seeded random, virtual clock, the
// world invariant on every step, the whole game simulated (_simulationStep). Every step the pet: is on the floor
// (a grid tile, below the top wall), never inside a footprint except lying on its own bed's petRest, takes only
// legal steps (_petStepOk; no jump), at rest is in no clearance band (use spots are not in one), never walks in place
// (walk animation while staying within 3 px for 1.5 s, the kitchen-walk rule), and the engine's own invariant logs
// nothing about it. Over the whole run it must also really use the pieces: a nap in a bed, a meal at a bowl, a
// greeting (per layout these depend on chance: a greeting or an agent petting it cuts a walk short).
// Fails on rc-v0.11.0 (no petBed / petBowl). Run: node tests/test_v12_pets_world.mjs [MINUTES per layout, default 6]  (PET_SEED=n or n,m: other seeds; default 12,43)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openOffice, defaultOffice } from './v12_pets_page.mjs';

const MIN = Number(process.argv[2] || 6);
// Seed 43 is the reported case (resting in a bowl's clearance band; it failed on the base commit of v12/polish).
const SEEDS = String(process.env.PET_SEED || '12,43').split(',').map(Number);
const used = { bed: 0, meals: 0, greets: 0 };
const here = path.dirname(new URL(import.meta.url).pathname);
const real = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'world-layout-8096.json'), 'utf8'));
const ROSTER = ['ana', 'bo', 'cyd', 'dee', 'eve', 'fay'].map(k => ({ id: k, statusKey: k, name: k.toUpperCase(), emoji: '🤖',
  role: 'Tester', providerKind: 'openclaw', available: true }));
const STATUS = Object.fromEntries(ROSTER.map((a, i) => [a.statusKey, { state: i % 2 ? 'working' : 'idle', task: i % 2 ? 'Busy' : '' }]));
// anchors are fractions of the office size (no coordinates of any office)
const LAYOUTS = [
  { name: 'default office', office: defaultOffice(), species: ['corgi', 'bunny'], beds: [[0.1, 0.9], [0.6, 0.5]], bowls: [[0.9, 0.9], [0.3, 0.6]] },
  { name: 'real layout (anonymised)', office: real, species: ['turtle', 'cat'], beds: [[0.5, 0.95], [0.05, 0.2]], bowls: [[0.95, 0.2], [0.5, 0.5]] },
  { name: 'crowded: pieces pushed into corners', office: defaultOffice(), species: ['duck', 'fox'], beds: [[0, 0], [1, 1]], bowls: [[1, 0], [0, 1]] },
];

let failures = 0;
for (const SEED of SEEDS) for (const L of LAYOUTS) {
  const office = JSON.parse(JSON.stringify(L.office));
  office.pet = { enabled: true, species: L.species[0], name: 'Rover', favorite: 'auto' };
  const o = await openOffice('test_v12_pets_world', { office, agents: ROSTER, status: STATUS, seed: SEED, manual: true });
  let out = null;
  try {
    // Beds and bowls where the editor's own placement rule allows them, nearest to each anchor.
    const placed = await o.page.evaluate(([beds, bowls, seed]) => {
      if (!window.__simRand) { let s = seed >>> 0; window.__simRand = function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
      const pageRandom = Math.random; Math.random = window.__simRand;  // see the run below
      const put = (type, fx, fy, id) => {
        const ax = fx * W, ay = Math.max(_petMinY() + 10, fy * H);
        const cand = [];
        for (let y = 0; y < H; y += 6) for (let x = 0; x < W; x += 6) cand.push({ x, y, d: Math.hypot(x - ax, y - ay) });
        cand.sort((u, v) => u.d - v.d);
        const best = cand.find(q => _placementProblem(type, q.x, q.y, 0, null) === '');
        if (!best) return null;
        officeConfig.furniture.push({ id, type, x: best.x, y: best.y });
        buildCollisionGrid();
        return id + '@' + best.x + ',' + best.y;
      };
      const out = beds.map((a, i) => put('petBed', a[0], a[1], 'pb' + i)).concat(bowls.map((a, i) => put('petBowl', a[0], a[1], 'pw' + i)));
      initPets(); VOWorld.reset();
      Math.random = pageRandom;
      return out;
    }, [L.beds, L.bowls, SEED]);
    const chunks = Math.max(1, Math.round(MIN * 2));
    for (let c = 0; c < chunks; c++) {
      out = await o.page.evaluate(([steps, sp, seed]) => {
        // The simulation draws from its own seeded stream while this synchronous chunk runs: other page code
        // (chat.js retries a missing fixture with a random back-off at wall-clock moments) must not shift it.
        if (!window.__simRand) { let s = seed >>> 0; window.__simRand = function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
        const pageRandom = Math.random; Math.random = window.__simRand;
        try {
        const S = window.__pw || (window.__pw = { step: 0, bad: {}, hist: [], run: 0, maxRun: 0, runInfo: null, bedSteps: 0, meals: 0, greets: 0,
          chair: 0, tricks: 0, was: '', prev: null, fp: 0 });
        const p = officePets[0];
        if (sp && p.species !== sp) p.species = sp;
        const bad = (k, extra) => { if (!S.bad[k]) S.bad[k] = Object.assign({ n: 0, at: [Math.round(p.x), Math.round(p.y)], state: p.state, step: S.step }, extra || {}); S.bad[k].n++; };
        const RESTING = ['sitting', 'sleeping', 'grooming', 'looking_around', 'eating', 'trick', 'being_pet'];
        for (let i = 0; i < steps; i++) {
          S.step++;
          if (S.step % 4000 === 700) { const f = p._favorite(); if (f) f._finishedAt = Date.now(); }  // the favourite finishes a run
          const bedBefore = p._inBed, px = p.x, py = p.y, end = p._spotGoal(), wasState = p.state;
          // A pet that starts on a blocked tile hops off it on its first update (as on rc-v0.11.0). That one move is
          // legal; where it lands is still checked below. The page's own frame loop may or may not have run that
          // first update before this loop starts, so it is told apart by the pet's tick, not by the step number.
          const spawnHop = p.tick === 0;
          window.__vAdvance(1000 / 60); _simulationStep();
          const inBed = _petInOwnBed(p), hop = bedBefore !== p._inBed;
          S.fp = (Math.imul(S.fp, 31) + Math.round(p.x * 8) * 7 + Math.round(p.y * 8)) >>> 0;  // run fingerprint
          // floor and walls
          const t = _gridTileAt(p.x, p.y);
          if (!t || p.y < _petMinY()) bad('off the floor');
          const f = VOWorld.feetIn(p.x, p.y);
          if (f && !inBed) bad('inside ' + f.type + '#' + f.id);
          if (!hop && !spawnHop && (px !== p.x || py !== p.y)) {
            if (Math.hypot(p.x - px, p.y - py) > 6) bad('jump', { from: [Math.round(px), Math.round(py)] });
            else if (!_petStepOk(px, py, p.x, p.y, false, end, true)) bad('illegal step', { from: [Math.round(px), Math.round(py)] });  // the pet's own step rule
          }
          // clearance at rest
          if (RESTING.includes(p.state) && !inBed && !p.isMoving) { const b = VOWorld.clearAt(p.x, p.y); if (b) bad('at rest in a clearance band: ' + b.kind + ' ' + b.type); }
          // walking in place
          S.hist.push(p.x, p.y); if (S.hist.length > 180) S.hist.splice(0, 2);
          if (p.isMoving && S.hist.length >= 180 && Math.hypot(p.x - S.hist[0], p.y - S.hist[1]) < 3) {
            if (++S.run > S.maxRun) { S.maxRun = S.run; S.runInfo = { state: p.state, at: [Math.round(p.x), Math.round(p.y)], to: [Math.round(p.targetX), Math.round(p.targetY)] }; }
          } else S.run = 0;
          // what it did
          if (inBed) S.bedSteps++;
          if (p.state !== S.was) {
            if (p.state === 'eating') S.meals++;
            if (p.state === 'walking_to_bowl') S.bowlWalks = (S.bowlWalks || 0) + 1;
            if (p.state === 'trick') S.tricks++;
            if (S.was === 'walking_to_greet' && p.state === 'trick' && p._trick === 'hop') S.greets++;
            if (S.was === 'walking_to_greet' && p.state === 'sitting' && p.stateTimer > 300) S.chair++;
            S.was = p.state;
          }
        }
        const log = VOWorld.log().filter(v => /pet/.test(v.kind) || v.who === p.name);
        return { steps: S.step, bad: S.bad, maxRun: S.maxRun, runInfo: S.runInfo, bedSteps: S.bedSteps, meals: S.meals, greets: S.greets,
          chair: S.chair, tricks: S.tricks, bowlWalks: S.bowlWalks || 0, fp: S.fp, log: log.slice(0, 3) };
        } finally { Math.random = pageRandom; }
      }, [1800, L.species[c >= chunks / 2 ? 1 : 0], SEED]);
    }
    const sum = `${out.steps} steps, beds/bowls ${placed.filter(Boolean).length}/4, in bed ${out.bedSteps} steps, meals ${out.meals}, greetings ${out.greets}, ` +
      `walks to a bowl ${out.bowlWalks}, by the chair ${out.chair}, tricks ${out.tricks}, longest walk in place ${out.maxRun}, run ${out.fp.toString(16)}`;
    try {
      assert.equal(placed.filter(Boolean).length, 4, 'every bed and bowl placed: ' + placed.join(' '));
      assert.deepEqual(out.bad, {}, 'world rules');
      assert.deepEqual(out.log, [], 'the engine invariant');
      assert.ok(out.maxRun <= 30, 'walks in place: ' + JSON.stringify(out.runInfo));
      assert.deepEqual(o.errors, [], 'page errors');
      used.bed += out.bedSteps; used.meals += out.meals; used.greets += out.greets;
      console.log(`ok - seed ${SEED} ${L.name}: ${sum}`);
    } catch (e) {
      failures++;
      console.log(`not ok - seed ${SEED} ${L.name}: ${String(e.message).split('\n')[0].slice(0, 200)} | ${sum} | ${JSON.stringify(out.bad).slice(0, 400)}`);
    }
  } finally {
    await o.close();
  }
}
if (!(used.bed > 0 && used.meals > 0 && used.greets > 0)) { failures++; console.log('not ok - used the beds, bowls and greeted: ' + JSON.stringify(used)); }
else console.log('ok - used the beds, bowls and greeted: ' + JSON.stringify(used));
console.log(failures ? `FAIL ${failures}` : 'PASS');
process.exit(failures ? 1 : 0);
