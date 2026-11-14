#!/usr/bin/env node
// v0.12 pets (a): five new species (corgi, bunny, fox, duck, turtle) in the PET_ART grid system with the full pose
// set of the cat, pug and lobster; PET_SPECIES is the one species list. Fails on rc-v0.11.0 (no PET_SPECIES, no art).
// Run: node tests/test_v12_pets_species.mjs   (VO_APP_DIR=<other app/> runs it against another tree)
import assert from 'node:assert/strict';
import { openOffice, checker } from './v12_pets_page.mjs';

const NEW = ['corgi', 'bunny', 'fox', 'duck', 'turtle'];
const POSES = ['groom', 'look', 'pet', 'sit', 'sleep', 'walkD', 'walkR', 'walkU'];
const T = checker();
const o = await openOffice('test_v12_pets_species');
const { page, errors } = o;
try {
  await T.check('PET_SPECIES is the one species list: same ids as PET_ART, old ids kept, five new ones', async () => {
    const r = await page.evaluate(() => ({
      list: typeof PET_SPECIES === 'undefined' ? null : PET_SPECIES.map(s => s.id),
      labels: typeof PET_SPECIES === 'undefined' ? [] : PET_SPECIES.filter(s => !s.label || !s.trick).map(s => s.id),
      art: Object.keys(PET_ART).filter(k => k[0] !== '_').sort(),
    }));
    assert.ok(r.list, 'no PET_SPECIES table');
    assert.deepEqual(r.list.slice().sort(), r.art, 'PET_SPECIES vs PET_ART');
    assert.deepEqual(r.list.slice(0, 3), ['cat', 'pug', 'lobster'], 'old species keep their ids and order');
    for (const sp of NEW) assert.ok(r.list.includes(sp), sp + ' missing');
    assert.deepEqual(r.labels, [], 'species without a label or trick name');
  });

  await T.check('every new species has the full pose set; every frame stays inside its grid, stands on its last row, uses only its palette', async () => {
    const r = await page.evaluate(({ NEW, POSES }) => {
      const bad = [];
      for (const sp of NEW) {
        const art = PET_ART[sp], pal = PET_PALETTES[sp];
        if (!art || !pal) { bad.push(sp + ' missing'); continue; }
        for (const pn of POSES) {
          const def = art[pn];
          if (!def) { bad.push(sp + '/' + pn + ' missing'); continue; }
          def.frames.forEach((layers, f) => {
            let out = 0;
            layers.forEach(l => {
              if (l.p) { l.p.forEach(q => { if (q[0] < 0 || q[1] < 0 || q[0] >= def.w || q[1] >= def.h) out++; }); return; }
              l[2].forEach((row, ry) => row.split('').forEach((ch, rx) => {
                if (ch === '.') return;
                const x = l[0] + rx, y = l[1] + ry;
                if (x < 0 || y < 0 || x >= def.w || y >= def.h) out++;
              }));
            });
            const g = _petGrid(sp, pn, f);
            const letters = new Set(); let solid = 0;
            g.forEach(row => row.forEach(ch => { if (ch !== '.') { letters.add(ch); solid++; } }));
            const unknown = [...letters].filter(ch => !pal[ch]);
            const last = g[def.h - 1].some(ch => ch !== '.');
            const axCol = g.slice(def.h - 4).some(row => row.slice(Math.max(0, def.ax - 4), def.ax + 5).some(ch => ch !== '.'));
            if (out || unknown.length || !last || solid < 40 || !axCol || def.ax < 0 || def.ax >= def.w) {
              bad.push(`${sp}/${pn}/${f} out=${out} unknown=${unknown.join('')} feetRow=${last} solid=${solid} ax=${def.ax}/${axCol}`);
            }
          });
        }
        // House style: lit body tones (highlight, base, shadow) in the standing poses.
        ['sit', 'walkR'].forEach(pn => { const s = new Set(_petGrid(sp, pn, 0).flat()); if (!s.has('H') || !s.has('B') || !s.has('S')) bad.push(sp + '/' + pn + ' lacks H/B/S tones'); });
      }
      return bad;
    }, { NEW, POSES });
    assert.deepEqual(r.slice(0, 6), [], r.length + ' bad');
  });

  await T.check('walk cycles move (3+ distinct frames per direction); asleep, the head lies on the faced side', async () => {
    const r = await page.evaluate((NEW) => {
      const out = [];
      for (const sp of NEW) {
        if (!PET_ART[sp]) { out.push(sp + ' missing'); continue; }
        ['walkR', 'walkD', 'walkU'].forEach(pn => {
          const keys = [0, 1, 2, 3].map(f => _petGrid(sp, pn, f).map(row => row.join('')).join('/'));
          if (PET_ART[sp][pn].frames.length !== 4 || new Set(keys).size < 3) out.push(sp + ' ' + pn + ' ' + new Set(keys).size);
        });
        [1, -1].forEach(fd => {
          const p = new OfficePet({ species: sp, x: 0, y: 0 }); Object.assign(p, { state: 'sleeping', faceDir: fd, tick: 0 });
          const def = PET_ART[sp].sleep, pose = p._artPose();
          const d = (pose[2] ? def.w - 1 - def.head[0] : def.head[0]) - (pose[2] ? def.w - 1 - def.ax : def.ax);
          if (!(fd > 0 ? d > 0 : d < 0)) out.push(sp + ' sleeping head on the wrong side for faceDir ' + fd);
        });
      }
      return out;
    }, NEW);
    assert.deepEqual(r, []);
  });

  await T.check('every state x direction of every new species draws through OfficePet.draw inside its bounds, no errors', async () => {
    const r = await page.evaluate((NEW) => {
      const bad = []; let n = 0;
      const states = ['sitting', 'walking', 'walking_to_sleep', 'walking_to_greet', 'walking_to_curious', 'sleeping', 'grooming', 'looking_around', 'being_pet', 'chased'];
      for (const sp of NEW) for (const st of states) for (const fd of [1, -1]) for (const md of ['side', 'up', 'down']) for (const mv of [false, true]) for (const t of [0, 5, 10, 15, 50]) {
        n++;
        const c = document.createElement('canvas'); c.width = 120; c.height = 120; const g = c.getContext('2d');
        const pet = new OfficePet({ species: sp, name: 'Pet', x: 60, y: 80 });
        Object.assign(pet, { state: st, faceDir: fd, moveDir: md, isMoving: mv, tick: t, _blinking: t === 50, sleepZ: 0.3,
          curiosityTarget: st === 'looking_around' ? { x: 0, y: 0 } : null });
        pet.x = 60; pet.y = 80;
        let pose; const saved = window.ctx; window.ctx = g;
        try { pose = pet._artPose(); pet.draw(); } catch (e) { bad.push(sp + '/' + st + ' threw ' + e.message); continue; } finally { window.ctx = saved; }
        const def = PET_ART[sp][pose[0]];
        const ax = pose[2] ? def.w - 1 - def.ax : def.ax, left = 60 - ax - 1, top = 80 + PET_FOOT - (def.h - 1);
        const d = g.getImageData(0, 0, 120, 120).data; let inside = 0, below = 0;
        for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
          if (d[(y * 120 + x) * 4 + 3] < 200) continue;
          if (x >= left && x < left + def.w + 3 && y >= top && y < top + def.h + 2) inside++;
          else if (y > 80 + PET_FOOT + 2) below++;
        }
        if (inside < 40 || below) bad.push(sp + '/' + st + '/' + pose.join(':') + ' inside ' + inside + ' below ' + below);
      }
      return { n, bad: bad.slice(0, 5), nbad: bad.length };
    }, NEW);
    assert.ok(r.n >= 1500, 'cases ' + r.n);
    assert.deepEqual(r.bad, [], r.nbad + ' bad');
  });

  await T.check('pet-sized and readable: awake height 10..24 px, width 12..30 px, like the existing three', async () => {
    const r = await page.evaluate((NEW) => NEW.filter(sp => PET_ART[sp]).map(sp => {
      const h = _petAwakeTop(sp) + 1, w = Math.max(...['sit', 'walkR', 'walkD'].map(pn => PET_ART[sp][pn].w));
      return (h >= 10 && h <= 24 && w >= 12 && w <= 30) ? null : sp + ' ' + w + 'x' + h;
    }).filter(Boolean), NEW);
    assert.deepEqual(r, []);
  });

  await T.check('live office: each new species is chosen through officeConfig.pet, updates and draws in the real loop', async () => {
    const r = await page.evaluate(async (NEW) => {
      const out = [];
      for (const sp of NEW) {
        officeConfig.pet = { enabled: true, species: sp, name: 'P-' + sp };
        initPets();
        const pet = officePets[0];
        for (let i = 0; i < 300; i++) updatePets();
        out.push(pet.species + ':' + (isFinite(pet.x) && isFinite(pet.y) && !!PET_ART[pet.species]));
        await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      }
      return out;
    }, NEW);
    assert.deepEqual(r, NEW.map(sp => sp + ':true'));
    assert.deepEqual(errors, [], 'page errors: ' + errors.slice(0, 2).join(' | '));
  });
} finally {
  await o.close();
}
if (T.failures) { console.log(`FAILED ${T.failures} check(s)`); process.exit(1); }
console.log('ALL V12 PET SPECIES CHECKS PASSED');
