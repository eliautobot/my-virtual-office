#!/usr/bin/env node
// v0.12 pets (f): the editor's Pet tab. Species tiles (one per PET_SPECIES entry, pictures drawn by the pet art,
// one checked, arrow keys move), name, favourite (nobody / picked from the team / each agent; a saved favourite who
// left stays chosen and is shown as away). Every change goes through the existing layout save (POST
// /api/office-config) and _applyPetConfig keeps every other saved pet field. Phone: tiles fit, 44 px targets.
// Fails on rc-v0.11.0 (a select with three kinds, no favourite). Run: node tests/test_v12_pets_editor.mjs
import assert from 'node:assert/strict';
import { openOffice, checker, defaultOffice } from './v12_pets_page.mjs';

const T = checker();
const ROSTER = [['ava', 'Ava'], ['bo', 'Bo'], ['cyd', 'Cyd']].map(([k, n]) => ({ id: k, statusKey: k, name: n, emoji: '🤖',
  role: 'Tester', providerKind: 'openclaw', available: true }));
const office = defaultOffice();
office.pet = { enabled: true, species: 'pug', name: 'Biscuit', favorite: 'bo', mood: 'keep-me', x: 400, y: 420 };

async function openPetTab(o) {
  await o.page.evaluate(() => { if (window._voLicense) window._voLicense.demo = false; toggleEditMode(); });
  await o.page.waitForTimeout(900);
  await o.page.evaluate(() => document.querySelector('#furniture-catalog .catalog-tabs button[data-pane=pet]').click());
  await o.page.waitForTimeout(300);
}
const lastPet = (o) => {
  const p = o.posts.filter(x => x.path === '/api/office-config').pop();
  return p ? JSON.parse(p.body).pet : null;
};
const settle = (o) => o.page.waitForTimeout(1500);  // saveOfficeConfig may wait a moment before it posts

const o = await openOffice('test_v12_pets_editor', { office, agents: ROSTER });
try {
  await openPetTab(o);

  await T.check('one tile per species, in PET_SPECIES order, each a drawn picture with its name; the saved kind checked', async () => {
    const r = await o.page.evaluate(async () => {
      const tiles = [...document.querySelectorAll('#pet-species-tiles .vo-pet-tile')], out = [];
      for (const t of tiles) {
        const img = t.querySelector('img'); await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
        const b = t.getBoundingClientRect();
        out.push({ id: t.dataset.species, label: t.textContent.trim(), px: n, checked: t.getAttribute('aria-checked'), role: t.getAttribute('role'), w: b.width, h: b.height });
      }
      return { out, ids: PET_SPECIES.map(s => s.id), labels: PET_SPECIES.map(s => s.label), select: !!document.getElementById('pet-species-select') };
    });
    assert.deepEqual(r.out.map(t => t.id), r.ids);
    assert.deepEqual(r.out.map(t => t.label), r.labels);
    r.out.forEach(t => assert.ok(t.px > 60 && t.role === 'radio' && t.w > 30 && t.h >= 44, JSON.stringify(t)));
    assert.deepEqual(r.out.filter(t => t.checked === 'true').map(t => t.id), ['pug']);
    assert.equal(r.select, false, 'the old three-kind select is gone');
  });

  await T.check('favourite list: nobody, picked from the team, each agent; the saved one selected', async () => {
    const r = await o.page.evaluate(() => {
      const s = document.getElementById('pet-favorite-select');
      return { opts: [...s.options].map(x => x.value + '=' + x.textContent), value: s.value };
    });
    assert.deepEqual(r.opts, ['=Nobody', 'auto=Picked from the team', 'ava=Ava', 'bo=Bo', 'cyd=Cyd']);
    assert.equal(r.value, 'bo');
  });

  await T.check('a species tile saves through the layout save and keeps every other pet field', async () => {
    const n0 = o.posts.length;
    await o.page.click('#pet-species-tiles .vo-pet-tile[data-species=corgi]');
    await settle(o);
    const live = await o.page.evaluate(() => ({ cfg: officeConfig.pet, sp: officePets[0] && officePets[0].species,
      checked: [...document.querySelectorAll('#pet-species-tiles [aria-checked=true]')].map(t => t.dataset.species) }));
    const saved = lastPet(o);
    assert.ok(o.posts.length > n0, 'nothing was posted');
    assert.equal(live.sp, 'corgi');
    assert.deepEqual(live.checked, ['corgi']);
    for (const pet of [live.cfg, saved]) {
      assert.equal(pet.species, 'corgi');
      assert.equal(pet.favorite, 'bo');
      assert.equal(pet.mood, 'keep-me', 'an unknown saved field was dropped');
      assert.equal(pet.name, 'Biscuit');
      assert.ok(pet.x === 400 && pet.y === 420 && pet.enabled === true);
    }
  });

  await T.check('arrow keys move the checked tile (a radio group)', async () => {
    await o.page.focus('#pet-species-tiles .vo-pet-tile[data-species=corgi]');
    await o.page.keyboard.press('ArrowRight');
    await settle(o);
    const r = await o.page.evaluate(() => ({ sp: officeConfig.pet.species, focus: document.activeElement && document.activeElement.dataset.species }));
    assert.deepEqual(r, { sp: 'bunny', focus: 'bunny' });
  });

  await T.check('"picked from the team" saves auto and names today\'s pick; "Nobody" saves no favourite', async () => {
    await o.page.selectOption('#pet-favorite-select', 'auto');
    await settle(o);
    const r = await o.page.evaluate(() => ({ hint: document.getElementById('pet-favorite-hint').textContent,
      pick: agentMap[petFavoriteKey(officeConfig.pet, agents)].name, live: officePets[0]._favorite() && officePets[0]._favorite().name }));
    assert.equal(lastPet(o).favorite, 'auto');
    assert.ok(r.hint.includes('Now: ' + r.pick), r.hint);
    assert.equal(r.live, r.pick);
    await o.page.selectOption('#pet-favorite-select', '');
    await settle(o);
    const saved = lastPet(o);
    assert.ok(!('favorite' in saved), 'favourite still saved: ' + JSON.stringify(saved));
    assert.equal(saved.mood, 'keep-me');
  });

  await T.check('name change saved', async () => {
    await o.page.fill('#pet-name-input', 'Waffles');
    await o.page.press('#pet-name-input', 'Enter');
    await o.page.evaluate(() => document.getElementById('pet-name-input').dispatchEvent(new Event('change')));
    await settle(o);
    assert.equal(lastPet(o).name, 'Waffles');
  });

  await T.check('no page errors', async () => { assert.deepEqual(o.errors, []); });
} finally {
  await o.close();
}

// A saved favourite who has left the office, on a phone.
const away = defaultOffice();
away.pet = { enabled: true, species: 'turtle', name: 'Shelly', favorite: 'zed' };
const p = await openOffice('test_v12_pets_editor', { office: away, agents: ROSTER }, { width: 412, height: 915 });
try {
  await openPetTab(p);
  await T.check('a favourite who left stays chosen, shown as away, and is kept when something else changes', async () => {
    const r = await p.page.evaluate(() => {
      const s = document.getElementById('pet-favorite-select');
      return { value: s.value, text: s.options[s.selectedIndex].textContent, hint: document.getElementById('pet-favorite-hint').textContent };
    });
    assert.equal(r.value, 'zed');
    assert.ok(/not in the office/.test(r.text), r.text);
    assert.ok(/Not in the office now/.test(r.hint), r.hint);
    await p.page.click('#pet-species-tiles .vo-pet-tile[data-species=duck]');
    await settle(p);
    const saved = lastPet(p);
    assert.equal(saved.favorite, 'zed');
    assert.equal(saved.species, 'duck');
  });
  await T.check('phone: the tiles fit the pane (no sideways scroll) and are 44 px targets', async () => {
    const r = await p.page.evaluate(() => {
      const pane = document.querySelector('.vo-pet-pane'), grid = document.getElementById('pet-species-tiles');
      const tiles = [...grid.children].map(t => t.getBoundingClientRect()), g = grid.getBoundingClientRect();
      return { over: pane.scrollWidth - pane.clientWidth, inside: tiles.every(b => b.left >= g.left - 0.5 && b.right <= g.right + 0.5),
        minH: Math.min(...tiles.map(b => b.height)), minW: Math.min(...tiles.map(b => b.width)) };
    });
    assert.ok(r.over <= 0 && r.inside && r.minH >= 44 && r.minW >= 44, JSON.stringify(r));
  });
  await T.check('no page errors (phone)', async () => { assert.deepEqual(p.errors, []); });
} finally {
  await p.close();
}
console.log(T.failures ? `FAIL ${T.failures}` : 'PASS');
process.exit(T.failures ? 1 : 0);
