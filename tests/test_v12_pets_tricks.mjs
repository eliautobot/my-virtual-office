#!/usr/bin/env node
// v0.12 pets (b): tricks. Every species has its own trick pose; a click or tap on the pet plays the next trick
// (its own, a double hop, a spin), now and then one plays alone; the pet stays where it stands; reduced motion or
// Calm = one still pose with a star. Clicks on agents and the floor are not taken. Fails on rc-v0.11.0 (no tricks).
// Run: node tests/test_v12_pets_tricks.mjs   (VO_APP_DIR=<other app/> runs it against another tree)
import assert from 'node:assert/strict';
import { openOffice, checker } from './v12_pets_page.mjs';

const T = checker();
const HELPERS = () => {
  window.__t = {
    // A pet of this species, resting on free floor away from every agent, drawn once so its body box is known.
    place(sp) {
      officeConfig.pet = { enabled: true, species: sp, name: 'Trixie' };
      initPets();
      const pet = officePets[0];
      let spot = null;
      for (let fy = 0.75; fy > 0.3 && !spot; fy -= 0.05) for (let fx = 0.2; fx < 0.85 && !spot; fx += 0.05) {
        const s = _petFreeSpot(W * fx, H * fy);
        if (agents.every(a => Math.hypot(a.x - s.x, a.y - s.y) > 70) && !_getAgentPreviewScreenHit(s.x, s.y - 6)) spot = s;
      }
      pet.x = pet.targetX = pet._prevTargetX = spot.x; pet.y = pet.targetY = pet._prevTargetY = spot.y;
      pet.tick = 5; pet._transitionTo('sitting', 100000);
      pet.draw();
      return pet;
    },
    client(wx, wy) {
      const rect = canvas.getBoundingClientRect(), z = getBaseScale() * camera.zoom;
      const cx = (wx - W / 2 - camera.x) * z + displayW / 2, cy = (wy - H / 2 - camera.y) * z + displayH / 2;
      return { x: rect.left + cx * (rect.width / displayW), y: rect.top + cy * (rect.height / displayH) };
    },
    bodyCenter(pet) { const b = pet._bodyBox; return this.client(b.x + b.w / 2, b.y + b.h / 2); },
    // Draw the pet alone on a scratch canvas: sprite rect, the lowest opaque row, and which sprites were drawn.
    drawn(pet) {
      const c = document.createElement('canvas'); c.width = 160; c.height = 160; const g = c.getContext('2d');
      const saved = window.ctx, sx = pet.x, sy = pet.y, names = [], name = pet.name;
      pet.name = ''; // no tag: the topmost pixel is the sprite's
      const S = window.VOLifeSprites, orig = S && S.draw;
      if (S) S.draw = function (cx, name) { names.push(name); return orig.apply(S, arguments); };
      window.ctx = g; pet.x = 80; pet.y = 110;
      let pose;
      try { pose = pet._artPose(); pet.draw(); } finally { window.ctx = saved; pet.x = sx; pet.y = sy; pet.name = name; if (S) S.draw = orig; }
      const d = g.getImageData(0, 0, 160, 160).data; let topSolid = 999;
      for (let y = 0; y < 160 && topSolid === 999; y++) for (let x = 0; x < 160; x++) if (d[(y * 160 + x) * 4 + 3] > 200) { topSolid = y; break; }
      let shadowRow = false; // translucent floor shadow at the feet line
      for (let x = 0; x < 160; x++) { const a = d[((110 + PET_FOOT) * 160 + x) * 4 + 3]; if (a > 20 && a < 90) shadowRow = true; }
      return { pose: pose.join(':'), topSolid, shadowRow, names };
    },
  };
};

const o = await openOffice('test_v12_pets_tricks');
try {
  await o.page.evaluate(HELPERS);

  await T.check('every species has a trick pose (2+ frames, inside its grid, on its feet) and a trick name and move in PET_SPECIES', async () => {
    const r = await o.page.evaluate(() => {
      if (typeof PET_SPECIES === 'undefined') return ['no PET_SPECIES'];
      const bad = [];
      for (const s of PET_SPECIES) {
        const def = PET_ART[s.id] && PET_ART[s.id].trick;
        if (!def || def.frames.length < 2) { bad.push(s.id + ' no trick pose'); continue; }
        if (!s.trick || ['leap', 'pose'].indexOf(s.move) < 0 || (s.move === 'leap' && !(s.lift > 0))) bad.push(s.id + ' trick spec');
        for (let f = 0; f < def.frames.length; f++) {
          const g = _petGrid(s.id, 'trick', f);
          if (!g[def.h - 1].some(ch => ch !== '.')) bad.push(s.id + ' frame ' + f + ' not on its feet');
          if (g.flat().filter(ch => ch !== '.').length < 40) bad.push(s.id + ' frame ' + f + ' too small');
          if ([...new Set(g.flat())].some(ch => ch !== '.' && !PET_PALETTES[s.id][ch])) bad.push(s.id + ' frame ' + f + ' unknown colour');
        }
        if (_petGrid(s.id, 'trick', 0).map(r => r.join('')).join('/') === _petGrid(s.id, 'trick', 1).map(r => r.join('')).join('/')) bad.push(s.id + ' frames equal');
      }
      return bad;
    });
    assert.deepEqual(r, [], r.join('; '));
  });

  await T.check('a real mouse click on the pet plays the next trick (own, hop, spin, own...); it stays where it stands, then sits', async () => {
    const seq = [];
    for (let i = 0; i < 4; i++) {
      const at = await o.page.evaluate(() => { const p = __t.place('corgi'); if (window.__trickN != null) p._trickN = window.__trickN; return __t.bodyCenter(p); });
      await o.page.mouse.click(at.x, at.y);
      seq.push(await o.page.evaluate(() => { const p = officePets[0]; window.__trickN = p._trickN; return p.state + ':' + p._trick; }));
    }
    assert.deepEqual(seq, ['trick:species', 'trick:hop', 'trick:spin', 'trick:species']);
    const r = await o.page.evaluate(() => {
      const p = officePets[0], x = p.x, y = p.y, states = new Set();
      for (let i = 0; i < PET_TRICK_TICKS + 2; i++) { p.update(); states.add(p.state); if (p.x !== x || p.y !== y) return 'moved'; }
      return [...states].join(',') + '|' + p._trick;
    });
    assert.equal(r, 'trick,sitting|null');
  });

  await T.check('motion: a leap lifts the bare sprite with the shadow left on the floor; the hop lifts; the spin turns through four views', async () => {
    const r = await o.page.evaluate(() => {
      const out = {};
      for (const sp of ['fox', 'bunny', 'cat']) {
        const p = __t.place(sp);
        p.startTrick('species'); for (let i = 0; i < 37; i++) p.update();
        const peak = __t.drawn(p), lift = p._trickLift();
        p._trickLift = () => 0; const flat = __t.drawn(p); delete p._trickLift;
        out[sp] = [lift > 4, peak.pose.split(':')[1], peak.shadowRow, flat.topSolid - peak.topSolid === lift];
      }
      const p = __t.place('pug'); p.startTrick('hop'); for (let i = 0; i < 15; i++) p.update();
      out.hop = p._trickLift();
      const q = __t.place('duck'); q.startTrick('spin'); const views = new Set();
      for (let i = 0; i < 30; i++) { q.update(); views.add(q._artPose().slice(0, 1).concat(q._artPose()[2]).join(':')); }
      out.spin = [...views].sort().join(',');
      return out;
    });
    for (const sp of ['fox', 'bunny', 'cat']) assert.deepEqual(r[sp], [true, '1', true, true], sp + ' ' + JSON.stringify(r[sp]));
    assert.equal(r.hop, 5);
    assert.equal(r.spin, 'walkD:false,walkR:false,walkR:true,walkU:false');
  });

  await T.check('touch: a tap a little off the body (inside the 44 px box) plays a trick; a mouse click there does not', async () => {
    const r = await o.page.evaluate(() => {
      const p = __t.place('turtle'), b = p._bodyBox, edge = b.x + b.w + 6 * _worldPerCssPx(), cy = b.y + b.h / 2;
      const c = __t.client(edge, cy);
      if (_agentAtWorld(edge, cy, 44)) return 'agent there';
      const mouse = handleCanvasClick(c.x, c.y, { touch: false }) && p.state === 'trick';
      p._transitionTo('sitting', 100000);
      const touch = handleCanvasClick(c.x, c.y, { touch: true }) && p.state === 'trick';
      return [mouse, touch].join(',');
    });
    assert.equal(r, 'false,true');
  });

  await T.check('clicks that are not on the pet keep working: an agent opens its menu, the floor plays no trick, a chased pet keeps running', async () => {
    const r = await o.page.evaluate(() => {
      const p = __t.place('cat'), a = agents[0];
      a.draw && a.draw();
      const rect = a.characterRect, at = __t.client(rect.x + rect.w / 2, rect.y + rect.h / 2);
      handleCanvasClick(at.x, at.y, { touch: false });
      const menu = !!a.actionMenuOpen; _closeAgentMenu();
      const floor = __t.client(p.x + 120 > W - 20 ? p.x - 120 : p.x + 120, p.y);
      handleCanvasClick(floor.x, floor.y, { touch: false });
      const floorTrick = p.state === 'trick';
      p.startChase(a); const st = p.state; const c = __t.bodyCenter(p);
      handleCanvasClick(c.x, c.y, { touch: false });
      return [menu, floorTrick, st, p.state].join(',');
    });
    assert.equal(r, 'true,false,chased,chased');
  });

  await T.check('now and then a trick plays on its own, at most one every 30 s', async () => {
    const r = await o.page.evaluate(() => {
      const p = __t.place('fox'), rnd = Math.random;
      Math.random = () => 0.01;
      try {
        p.tick = 4000; p._trickAt = undefined; p._pickBehavior(); const first = p.state;
        p._transitionTo('sitting', 10); p._pickBehavior(); const again = p.state;
        p.tick += 1801; p._transitionTo('sitting', 10); p._pickBehavior(); const later = p.state;
        return [first, again === 'trick' ? 'trick' : 'other', later].join(',');
      } finally { Math.random = rnd; }
    });
    assert.equal(r, 'trick,other,trick');
  });

  await T.check('Calm mode: the trick is one still pose (the trick pose) with a star, no lift, no frame change', async () => {
    const r = await o.page.evaluate(() => {
      const L = window.VOLife, calm = L.calm; L.calm = () => true;
      try {
        const p = __t.place('bunny'); p.startTrick('species'); const seen = new Set(); let lift = 0, star = false;
        for (let i = 0; i < 60; i++) { p.update(); const d = __t.drawn(p); seen.add(d.pose); lift = Math.max(lift, p._trickLift()); star = star || d.names.includes('star'); }
        p.startTrick(); p._transitionTo('sitting', 1); p.startTrick('spin'); const spin = new Set();
        for (let i = 0; i < 30; i++) { p.update(); spin.add(p._artPose().join(':')); }
        return [[...seen].join('/'), lift, star, [...spin].join('/')].join('|');
      } finally { L.calm = calm; }
    });
    assert.equal(r, 'trick:1:false|0|true|walkD:0:false');
    assert.deepEqual(o.errors, [], 'page errors: ' + o.errors.slice(0, 2).join(' | '));
  });
} finally {
  await o.close();
}

// prefers-reduced-motion: the same still pose and star, through the browser setting itself.
const rm = await openOffice('test_v12_pets_tricks', { reducedMotion: true });
try {
  await rm.page.evaluate(HELPERS);
  await T.check('prefers-reduced-motion: still pose with a star, no lift', async () => {
    const r = await rm.page.evaluate(() => {
      const p = __t.place('fox'); p.startTrick('species'); const seen = new Set(); let lift = 0, star = false;
      for (let i = 0; i < 60; i++) { p.update(); const d = __t.drawn(p); seen.add(d.pose); lift = Math.max(lift, p._trickLift()); star = star || d.names.includes('star'); }
      return [_lifeReducedMotion(), [...seen].join('/'), lift, star].join('|');
    });
    assert.equal(r, 'true|trick:1:false|0|true');
  });
} finally {
  await rm.close();
}
if (T.failures) { console.log(`FAILED ${T.failures} check(s)`); process.exit(1); }
console.log('ALL V12 PET TRICK CHECKS PASSED');
