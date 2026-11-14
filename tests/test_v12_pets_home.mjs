#!/usr/bin/env node
// v0.12 pets (d): petBed and petBowl. Complete manifest entries (the world contract checks the geometry), editor
// catalog + search words + real thumbnails, placement rules (free floor, the pet's spots kept free), and the pet's
// use of them: the nearest bed it can reach to sleep in (lying inside the bed like a sitter on a chair, the world
// invariant silent, out by the bed's spot on waking or when the bed goes), the nearest bowl now and then (at most
// once a minute), and today's behaviour without them. A saved layout is not changed. Fails on rc-v0.11.0 (no types).
// Run: node tests/test_v12_pets_home.mjs   (VO_APP_DIR=<other app/> runs it against another tree)
import assert from 'node:assert/strict';
import { openOffice, checker, defaultOffice } from './v12_pets_page.mjs';

const T = checker();
const HELPERS = () => {
  window.__h = {
    pet() {
      officeConfig.pet = { enabled: true, species: 'fox', name: 'Ember' };
      initPets();
      const pet = officePets[0];
      let spot = null;
      for (let fy = 0.7; fy > 0.3 && !spot; fy -= 0.05) for (let fx = 0.3; fx < 0.7 && !spot; fx += 0.05) {
        const s = _petFreeSpot(W * fx, H * fy);
        if (agents.every(a => Math.hypot(a.x - s.x, a.y - s.y) > 90)) spot = s;
      }
      pet.x = pet.targetX = pet._prevTargetX = spot.x; pet.y = pet.targetY = pet._prevTargetY = spot.y;
      pet.tick = 5; pet._transitionTo('sitting', 100000);
      return pet;
    },
    // A free place for a piece (the editor's own rule) at distance dmin..dmax from (x, y) whose pet spots the pet reaches.
    place(type, x, y, dmin, dmax, id) {
      for (let r = dmin; r <= dmax; r += 20) for (let a = 0; a < 360; a += 15) {
        const px = Math.round(x + r * Math.cos(a * Math.PI / 180)), py = Math.round(y + r * Math.sin(a * Math.PI / 180));
        if (_placementProblem(type, px, py, 0, null) !== '') continue;
        const it = { id, type, x: px, y: py };
        officeConfig.furniture.push(it); buildCollisionGrid();
        const ok = _petPlaces(type).filter(p => p.item === it).some(p => {
          const f = _petFreeSpot(p.x, p.y); const w = planWalk(x, y, p.x, p.y, { strict: true });
          return Math.abs(f.x - p.x) < 1 && Math.abs(f.y - p.y) < 1 && w && w.length && !w.partial;
        });
        if (ok) return it;
        officeConfig.furniture.pop(); buildCollisionGrid();
      }
      return null;
    },
    drop(it) { const i = officeConfig.furniture.indexOf(it); if (i >= 0) officeConfig.furniture.splice(i, 1); buildCollisionGrid(); },
    withRandom(values, fn) {
      const orig = Math.random; let i = 0;
      Math.random = () => values[Math.min(i++, values.length - 1)];
      try { return fn(); } finally { Math.random = orig; }
    },
    petViolations() { return VOWorld.check().filter(v => /pet/.test(v.kind || '') || v.who === 'pet' || (v.id && /pet/i.test(String(v.id)))); },
  };
};

const office = defaultOffice();
const o = await openOffice('test_v12_pets_home', { office });
try {
  await o.page.evaluate(HELPERS);

  await T.check('manifest: footprint, the pet spots outside it, the bed\'s lying point inside it, depth parts', async () => {
    const r = await o.page.evaluate(() => ['petBed', 'petBowl'].map(t => {
      const m = FURNITURE_MANIFEST[t], fp = m.footprint[0], inFp = (x, y) => x > fp[0] && x < fp[0] + fp[2] && y > fp[1] && y < fp[1] + fp[3];
      return { t, fp: !!fp, spots: (m.stand || []).length, outside: (m.stand || []).every(s => !inFp(s.x, s.y) && s.extra),
        rest: m.petRest ? inFp(m.petRest[0], m.petRest[1]) : null, parts: _depthParts({ type: t, x: 300, y: 300 }).length,
        names: (m.stand || []).every(s => !!USE_SPOT_NAMES[s.id]), cls: m.projection && m.projection.class };
    }));
    r.forEach(x => { assert.ok(x.fp && x.spots >= 1 && x.outside && x.parts >= 1 && x.names && x.cls === 'low', JSON.stringify(x)); });
    assert.equal(r[0].rest, true, 'bed lying point inside its footprint');
    assert.equal(r[1].rest, null, 'a bowl has no lying point');
  });

  await T.check('editor: in the catalog, found by search words, thumbnails drawn by the game\'s art', async () => {
    await o.page.evaluate(() => new Promise(res => _voLazyLoad('editor', res)));  // the editor loads on first use
    await o.page.waitForFunction(() => window.VOEditor && typeof VOEditor.thumb === 'function', null, { timeout: 10000 });
    const r = await o.page.evaluate(async () => {
      const cat = CATALOG_CATEGORIES.flatMap(c => c.items.map(i => i.type));
      const out = {};
      for (const t of ['petBed', 'petBowl']) {
        const url = VOEditor.thumb(t, 48);
        const img = new Image(); img.src = url; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
        out[t] = { inCat: cat.includes(t), search: VOEditor.matches(t, t === 'petBed' ? 'dog bed' : 'water'), label: _furnitureLabel(t), px: n };
      }
      return out;
    });
    for (const t of ['petBed', 'petBowl']) {
      const x = r[t];
      assert.ok(x.inCat && x.search && /Pet/.test(x.label) && x.px > 40, `${t} ${JSON.stringify(x)}`);
    }
  });

  await T.check('placement rules: free floor allowed, on a desk refused, a bowl whose pet spot is inside a piece refused', async () => {
    const r = await o.page.evaluate(() => {
      const pet = __h.pet();
      const bowl = __h.place('petBowl', pet.x, pet.y, 60, 400, 'probe-bowl');
      const ok = bowl ? _placementProblem('petBowl', bowl.x, bowl.y, 0, ['probe-bowl']) : 'none found';
      if (bowl) __h.drop(bowl);
      const desk = officeConfig.furniture.find(f => f.type === 'desk');
      const onDesk = _placementProblem('petBed', desk.x - 10, desk.y - 10, 0, null);
      // the bowl's own plan on free floor, its 'pet' spot (10, -6) inside another piece's footprint
      let spotIn = null;
      for (let y = 140; y < H - 40 && !spotIn; y += 2) for (let x = 40; x < W - 60 && !spotIn; x += 4) {
        if (!_feetIn(x + 10, y - 6) || [[1, 1], [19, 1], [1, 7], [19, 7]].some(c => _feetIn(x + c[0], y + c[1]))) continue;
        spotIn = { x, y, why: _placementProblem('petBowl', x, y, 0, null) };
      }
      return { ok, onDesk, spotIn };
    });
    assert.equal(r.ok, '');
    assert.notEqual(r.onDesk, '');
    assert.ok(r.spotIn, 'no position found to try');
    assert.notEqual(r.spotIn.why, '', `bowl at ${r.spotIn.x},${r.spotIn.y} with its spot inside a piece was allowed`);
  });

  await T.check('without beds or bowls the pet sleeps as before (couch or corner) and never looks for a bowl', async () => {
    const r = await o.page.evaluate(() => {
      const pet = __h.pet();
      const none = [pet._nearestPlace('petBed'), pet._nearestPlace('petBowl')];
      __h.withRandom([0.9, 0.1, 0.1, 0.9], () => pet._pickBehavior());
      return { none, state: pet.state, goal: pet._goal };
    });
    assert.deepEqual(r.none, [null, null]);
    assert.equal(r.state, 'walking_to_sleep');
    assert.equal(r.goal, null);
  });

  await T.check('two beds: walks to the nearer, lies in it (invariant silent), gets out by its spot on waking', async () => {
    const r = await o.page.evaluate(() => {
      const pet = __h.pet();
      const far = __h.place('petBed', pet.x, pet.y, 320, 700, 'bed-far');
      const near = __h.place('petBed', pet.x, pet.y, 70, 220, 'bed-near');
      if (!far || !near) return { missing: true };
      VOWorld.reset();
      __h.withRandom([0.9, 0.1, 0.9], () => pet._pickBehavior());
      const goal = pet._goal && pet._goal.item.id;
      for (let i = 0; i < 4000 && pet.state !== 'sleeping'; i++) pet.update();
      const lying = { state: pet.state, inBed: pet._inBed && pet._inBed.id, own: _petInOwnBed(pet), feet: VOWorld.feetIn(pet.x, pet.y), bad: __h.petViolations() };
      _worldSettle();
      lying.afterSettle = _petInOwnBed(pet);
      pet.stateTimer = 1; __h.withRandom([0.9, 0.45, 0.9, 0.5], () => { pet.update(); pet.update(); });  // wakes to groom
      const woke = { state: pet.state, inBed: !!pet._inBed, feet: VOWorld.feetIn(pet.x, pet.y), d: Math.hypot(pet.x - (near.x + 15), pet.y - (near.y + 27)) };
      __h.drop(near); __h.drop(far);
      return { goal, lying, woke };
    });
    assert.ok(!r.missing, 'no room for two beds');
    assert.equal(r.goal, 'bed-near');
    assert.equal(r.lying.state, 'sleeping');
    assert.equal(r.lying.inBed, 'bed-near');
    assert.ok(r.lying.own && r.lying.afterSettle, 'lying in its own bed, kept there by the world settle');
    assert.equal(r.lying.feet && r.lying.feet.type, 'petBed', 'inside the bed footprint');
    assert.deepEqual(r.lying.bad, []);
    assert.ok(r.woke.state !== 'sleeping' && !r.woke.inBed && !r.woke.feet, `woke ${JSON.stringify(r.woke)}`);
    assert.ok(r.woke.d < 2, `out by the bed's spot (${r.woke.d.toFixed(1)} px)`);
  });

  await T.check('the bed is taken away while it sleeps: out onto free floor at once', async () => {
    const r = await o.page.evaluate(() => {
      const pet = __h.pet();
      const bed = __h.place('petBed', pet.x, pet.y, 70, 300, 'bed-gone');
      __h.withRandom([0.9, 0.1, 0.9], () => pet._pickBehavior());
      for (let i = 0; i < 4000 && pet.state !== 'sleeping'; i++) pet.update();
      const was = !!pet._inBed;
      __h.drop(bed); pet.update();
      return { was, inBed: !!pet._inBed, feet: VOWorld.feetIn(pet.x, pet.y), tile: !!(_gridTileAt(pet.x, pet.y) && !_gridTileAt(pet.x, pet.y).blocked) };
    });
    assert.ok(r.was && !r.inBed && !r.feet && r.tile, JSON.stringify(r));
  });

  await T.check('two bowls: eats at the nearer one now and then, at most once a minute', async () => {
    const r = await o.page.evaluate(() => {
      const pet = __h.pet();
      const far = __h.place('petBowl', pet.x, pet.y, 320, 700, 'bowl-far');
      const near = __h.place('petBowl', pet.x, pet.y, 70, 220, 'bowl-near');
      if (!far || !near) return { missing: true };
      VOWorld.reset();
      __h.withRandom([0.9, 0.9, 0.1], () => pet._pickBehavior());
      const goal = pet._goal && pet._goal.item.id;
      let eatAt = -1;
      for (let i = 0; i < 4000 && pet.state !== 'eating'; i++) { pet.update(); if (pet.state === 'eating') eatAt = i; }
      const spot = _petPlaces('petBowl').filter(p => p.item === near).map(p => Math.hypot(pet.x - p.x, pet.y - p.y));
      const eating = { state: pet.state, d: Math.min(...spot), pose: pet._artPose()[0], view: pet._eatView, feet: VOWorld.feetIn(pet.x, pet.y), bad: __h.petViolations() };
      pet._transitionTo('sitting', 10);
      __h.withRandom([0.9, 0.9, 0.1, 0.9], () => pet._pickBehavior());
      const again = pet.state;
      __h.drop(near); __h.drop(far);
      return { goal, eating, again };
    });
    assert.ok(!r.missing, 'no room for two bowls');
    assert.equal(r.goal, 'bowl-near');
    assert.equal(r.eating.state, 'eating');
    assert.ok(r.eating.d < 2, `at the bowl's spot (${r.eating.d.toFixed(1)} px)`);
    assert.ok(!r.eating.feet && r.eating.bad.length === 0, JSON.stringify(r.eating));
    assert.ok(r.eating.view === 'back' ? r.eating.pose === 'walkU' : ['sit', 'pet'].includes(r.eating.pose), `pose ${r.eating.pose} for view ${r.eating.view}`);
    assert.notEqual(r.again, 'walking_to_bowl', 'went back to the bowl within a minute');
  });

  await T.check('lying in its bed, drawn on the cushion: after the back rim, before the front rim (real frame)', async () => {
    await o.page.evaluate(() => {
      const pet = __h.pet();
      const bed = __h.place('petBed', pet.x, pet.y, 70, 300, 'bed-draw');
      const r = _petPlaces('petBed').find(q => q.item === bed).rest;
      pet.x = pet.targetX = pet._prevTargetX = r.x; pet.y = pet.targetY = pet._prevTargetY = r.y;
      pet._transitionTo('sleeping', 1e6); pet._inBed = bed;
      window.__bedDraw = bed;
    });
    await o.page.waitForTimeout(400);
    const r = await o.page.evaluate(() => {
      const pet = officePets[0], bed = window.__bedDraw, list = VOWorld.order();
      const at = (part) => list.findIndex(e => e && e.item === bed && e.part === part);
      const out = { back: at('back'), pet: list.indexOf(pet), front: at('front'), own: _petInOwnBed(pet),
        body: pet._bodyBox && [pet._bodyBox.x - bed.x, pet._bodyBox.y - bed.y, pet._bodyBox.w, pet._bodyBox.h] };
      __h.drop(bed);
      return out;
    });
    assert.ok(r.own, 'not lying in its bed');
    assert.ok(r.back >= 0 && r.pet > r.back && r.front > r.pet, `order back ${r.back}, pet ${r.pet}, front ${r.front}`);
    const [bx, by, bw, bh] = r.body;
    assert.ok(bx >= -2 && bx + bw <= 32 && by >= -8 && by + bh <= 19, `drawn body ${r.body} inside the bed's art (0,-7,30,25)`);
  });

  await T.check('a saved layout is not changed: no bed or bowl added, nothing saved on load', async () => {
    const r = await o.page.evaluate(() => officeConfig.furniture.filter(f => f.type === 'petBed' || f.type === 'petBowl').length);
    assert.equal(r, 0);
    assert.ok(!o.posts.some(p => p.path === '/api/office-config'), 'the office was saved on load');
    assert.ok(!office.furniture.some(f => f.type === 'petBed' || f.type === 'petBowl'));
  });

  await T.check('no page errors', async () => { assert.deepEqual(o.errors, []); });
} finally {
  await o.close();
}
console.log(T.failures ? `FAIL ${T.failures}` : 'PASS');
process.exit(T.failures ? 1 : 0);
