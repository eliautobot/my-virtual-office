#!/usr/bin/env node
// v0.12 pets (c): the favourite agent. officeConfig.pet.favorite = 'auto' or a statusKey ('' / missing = none, as
// before). 'auto' resolves from the roster alone (two tabs with the roster in another order agree), someone leaving
// only changes the pick when it was them, a favourite who left falls back to the auto pick. The pet naps by the
// favourite's desk, sits by the chair while they work and greets them (walk up + hop) when they come online or finish
// a run. "By" = the nearest free tile (tiles are TILE px; chairs keep their clearance), so within 1.75 tiles. Fails on rc-v0.11.0 (no petFavoriteKey, no favourite behaviour).
// Run: node tests/test_v12_pets_favorite.mjs   (VO_APP_DIR=<other app/> runs it against another tree)
import assert from 'node:assert/strict';
import { openOffice, checker } from './v12_pets_page.mjs';

const T = checker();
const ROSTER = ['ana', 'bo', 'cyd', 'dee', 'eve'].map((k, i) => ({ id: k, statusKey: k, name: k.toUpperCase(), emoji: '🤖',
  role: 'Tester', providerKind: 'openclaw', available: true }));

// A sitting pet with this favourite on free floor away from every agent; Math.random can be pinned per call.
const HELPERS = () => {
  window.__f = {
    place(favorite) {
      officeConfig.pet = { enabled: true, species: 'corgi', name: 'Biscuit', favorite };
      initPets();
      const pet = officePets[0];
      let spot = null;
      for (let fy = 0.75; fy > 0.3 && !spot; fy -= 0.05) for (let fx = 0.2; fx < 0.85 && !spot; fx += 0.05) {
        const s = _petFreeSpot(W * fx, H * fy);
        if (agents.every(a => Math.hypot(a.x - s.x, a.y - s.y) > 90)) spot = s;
      }
      pet.x = pet.targetX = pet._prevTargetX = spot.x; pet.y = pet.targetY = pet._prevTargetY = spot.y;
      pet.tick = 5; pet._transitionTo('sitting', 100000);
      return pet;
    },
    withRandom(values, fn) {
      const orig = Math.random; let i = 0;
      Math.random = () => values[Math.min(i++, values.length - 1)];
      try { return fn(); } finally { Math.random = orig; }
    },
  };
};

// The second tab first (one headless Chrome at a time): the roster in reverse order.
const AUTO = () => { const p = __f.place('auto'); return [p._favorite() && p._favorite().statusKey, agents.map(x => x.statusKey).join()]; };
const two = await openOffice('test_v12_pets_favorite', { agents: ROSTER.slice().reverse() });
let tabTwo, errorsTwo;
try { await two.page.evaluate(HELPERS); tabTwo = await two.page.evaluate(AUTO); errorsTwo = two.errors.slice(); }
finally { await two.close(); }
const one = await openOffice('test_v12_pets_favorite', { agents: ROSTER });
try {
  await one.page.evaluate(HELPERS);

  await T.check('"auto" picks the same agent in two tabs with the roster in another order', async () => {
    const a = await one.page.evaluate(AUTO), b = tabTwo;
    assert.notEqual(a[1], b[1], 'the two tabs must really see different orders');
    assert.ok(a[0], 'auto resolved to nobody');
    assert.equal(a[0], b[0]);
  });

  await T.check('someone leaving changes the pick only when it was the favourite; a departed favourite falls back to auto', async () => {
    const r = await one.page.evaluate(() => {
      const roster = agents.map(a => ({ statusKey: a.statusKey }));
      const cfg = { favorite: 'auto', name: 'Biscuit' };
      const fav = petFavoriteKey(cfg, roster);
      const other = roster.find(a => a.statusKey !== fav).statusKey;
      const withoutOther = petFavoriteKey(cfg, roster.filter(a => a.statusKey !== other));
      const withoutFav = petFavoriteKey(cfg, roster.filter(a => a.statusKey !== fav));
      const explicitGone = petFavoriteKey({ favorite: 'zed', name: 'Biscuit' }, roster);
      const explicit = petFavoriteKey({ favorite: other, name: 'Biscuit' }, roster);
      const none = [petFavoriteKey({ name: 'Biscuit' }, roster), petFavoriteKey({ favorite: '', name: 'B' }, roster),
        petFavoriteKey({ favorite: 'none', name: 'B' }, roster), petFavoriteKey({ favorite: 'auto', name: 'B' }, [])];
      return { fav, other, withoutOther, withoutFav, explicitGone, explicit, none };
    });
    assert.equal(r.withoutOther, r.fav);
    assert.ok(r.withoutFav && r.withoutFav !== r.fav, 'a new favourite from the ones left');
    assert.equal(r.explicitGone, r.fav, 'a favourite who left = the auto pick');
    assert.equal(r.explicit, r.other);
    assert.deepEqual(r.none, [null, null, null, null]);
  });

  await T.check('the live pet copes with its favourite leaving the office mid-walk', async () => {
    const r = await one.page.evaluate(() => {
      const pet = __f.place('auto');
      const fav = pet._favorite();
      pet._goToFavorite(fav, true);
      const idx = agents.indexOf(fav);
      agents.splice(idx, 1);
      for (let i = 0; i < 90; i++) pet.update();
      const after = pet._favorite();
      agents.splice(idx, 0, fav);
      return { greet: pet.greetTarget === fav, state: pet.state, after: after && after.statusKey, was: fav.statusKey };
    });
    assert.equal(r.greet, false, 'still walking to someone who left');
    assert.ok(r.after && r.after !== r.was, `new favourite ${r.after}`);
  });

  await T.check('naps by the favourite\'s desk', async () => {
    const r = await one.page.evaluate(() => {
      const pet = __f.place('auto');
      const fav = pet._favorite(); fav.state = 'idle';
      __f.withRandom([0.1, 0.1, 0.2, 0.1], () => pet._pickBehavior());
      return { state: pet.state, d: Math.hypot(pet.targetX - fav.desk.x, pet.targetY - fav.desk.y), near: TILE * 1.75 };
    });
    assert.equal(r.state, 'walking_to_sleep');
    assert.ok(r.d < r.near, `nap spot ${r.d.toFixed(1)} px from the desk`);
  });

  await T.check('sits by the chair while the favourite works, and stays a while', async () => {
    const r = await one.page.evaluate(() => {
      const pet = __f.place('auto');
      const fav = pet._favorite(); const st = fav.state, sit = fav.isSitting;
      fav.state = 'working'; fav.isSitting = true;
      __f.withRandom([0.9, 0.9, 0.1, 0.5], () => pet._pickBehavior());
      const out = { state: pet.state, target: pet.greetTarget === fav, d: Math.hypot(pet.targetX - fav.x, pet.targetY - fav.y), near: TILE * 1.75 };
      for (let i = 0; i < 2500 && pet.state === 'walking_to_greet'; i++) pet.update();
      out.after = pet.state; out.timer = pet.stateTimer; out.end = Math.hypot(pet.x - fav.x, pet.y - fav.y);
      fav.state = st; fav.isSitting = sit;
      return out;
    });
    assert.equal(r.state, 'walking_to_greet');
    assert.ok(r.target);
    assert.ok(r.d < r.near, `spot ${r.d.toFixed(1)} px from the chair`);
    assert.equal(r.after, 'sitting');
    assert.ok(r.timer > 300, `sits ${r.timer} ticks`);
    assert.ok(r.end < r.near, `ended ${r.end.toFixed(1)} px away`);
  });

  for (const how of ['comes online', 'finishes a run']) {
    await T.check(`greets the favourite when it ${how}: walks up, then a happy hop`, async () => {
      const r = await one.page.evaluate((how) => {
        const pet = __f.place('auto');
        const fav = pet._favorite(); const st = fav.state;
        fav.state = how === 'comes online' ? 'offline' : 'idle';
        pet.update();
        if (how === 'comes online') fav.state = 'idle'; else fav._finishedAt = Date.now();
        pet.update();
        const out = { state: pet.state, fav: !!pet._favGreet, to: pet.greetTarget === fav };
        let trick = null;
        for (let i = 0; i < 3000 && !trick; i++) { pet.update(); if (pet.state === 'trick') trick = pet._trick; }
        out.trick = trick; out.end = Math.hypot(pet.x - fav.x, pet.y - fav.y); out.near = TILE * 1.75;
        fav.state = st;
        return out;
      }, how);
      assert.equal(r.state, 'walking_to_greet');
      assert.ok(r.fav && r.to);
      assert.equal(r.trick, 'hop');
      assert.ok(r.end < r.near, `hopped ${r.end.toFixed(1)} px away`);
    });
  }

  await T.check('no favourite = no favourite behaviour (as before)', async () => {
    const r = await one.page.evaluate(() => {
      const pet = __f.place(undefined);
      const fav = agents[0]; const st = fav.state;
      fav.state = 'offline'; pet.update(); fav.state = 'idle'; pet.update();
      const out = { fav: pet._favorite(), state: pet.state };
      fav.state = st;
      return out;
    });
    assert.equal(r.fav, null);
    assert.equal(r.state, 'sitting');
  });

  await T.check('no page errors', async () => {
    assert.deepEqual(one.errors.concat(errorsTwo), []);
  });
} finally {
  await one.close();
}
console.log(T.failures ? `FAIL ${T.failures}` : 'PASS');
process.exit(T.failures ? 1 : 0);
