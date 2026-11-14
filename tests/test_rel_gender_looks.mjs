// Male / Female looks (0.12.0 gender package).
//
// a. Agent Studio (look tabs) and the new-agent look step show a Male / Female
//    toggle: one radiogroup, two radio buttons, that sets the agent's gender.
// b. Each look list offers Male items to a Male agent, Female items to a Female
//    agent and the shared items to both (game.js LOOK_GENDER, the one table).
//    Lashes: a Male agent gets "No lashes" only; a Female agent gets five lash
//    styles. Lip colour is Female; facial hair is Male.
// c. The new lash styles draw in the four views at game size; front and profile
//    show distinct pixels per style (from behind the face is hidden, as today).
// d. Switching gender keeps shared choices and swaps the other gender's items
//    for the new gender's defaults; Randomize keeps the gender and its items.
// e. Saved agents draw pixel-for-pixel as the release candidate drew them, and
//    opening them in the Studio changes nothing; a look the filter would not
//    offer stays shown as the current choice.
// f. Save writes gender, lashes and lashStyle into the office layout.
//
// Hermetic: app/ from this tree, fixture APIs, fake 200s for writes. The
// before/after pixel check serves game.js and v10-studio.js from git BASE.
// Run: node tests/test_rel_gender_looks.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openStudio, showStudio, fixtures, ORIGIN } from './test_v10_studio_lib.mjs';

const NAME = 'test_rel_gender_looks';
const BASE = process.env.GENDER_BASE || '003dfe4';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await launch(NAME);
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.log(`not ok - ${name}: ${String(e && e.message || e).split('\n')[0].slice(0, 300)}`); }
}

// Visible tile / swatch values of one Studio group.
const visible = (page, key) => page.evaluate(k => {
  VOStudio.refreshNow();
  const g = document.querySelector(`.st-panel [data-group="${k}"]`);
  if (!g) return null;
  return Array.from(g.querySelectorAll('[role="radio"]')).filter(b => !b.hidden && b.offsetParent !== null).map(b => b.dataset.value);
}, key);
const st = page => page.evaluate(() => JSON.parse(JSON.stringify(window._agentPanelEditState)));
const setLook = (page, gender, app) => page.evaluate(([gd, ap]) => {
  const s = window._agentPanelEditState; s.gender = gd; s.appearance = Object.assign({}, s.appearance, ap); VOStudio.refreshNow();
}, [gender, app]);
const clickGender = (page, g) => page.click(`.st-panel .st-gender [data-value="${g}"]`);

const TABS = { hairStyle: 'hair', eyebrowStyle: 'face', lashes: 'face', facialHair: 'face', shirtStyle: 'outfit', neckwear: 'outfit',
  costume: 'outfit', headwear: 'hats', glasses: 'hats' };

try {
  const { page, errors, writes } = await openStudio(browser);
  await showStudio(page, 'alpha');
  await page.evaluate(() => { VOStudio.state.playing = false; });

  await check('a. look tabs show a Male / Female toggle (radiogroup, two radios) that sets the gender', async () => {
    for (const cat of ['body', 'hair', 'face', 'outfit', 'hats']) {
      await page.evaluate(c => VOStudio.showCategory(c), cat);
      const r = await page.evaluate(() => {
        const g = document.querySelector('.st-panel .st-gender');
        if (!g) return null;
        return { role: g.getAttribute('role'), label: g.getAttribute('aria-label') || (document.getElementById(g.getAttribute('aria-labelledby')) || {}).textContent,
          btns: Array.from(g.querySelectorAll('button')).map(b => [b.dataset.value, b.textContent.trim(), b.getAttribute('role'), b.getAttribute('aria-checked')]) };
      });
      assert.ok(r, `no gender toggle on ${cat}`);
      assert.equal(r.role, 'radiogroup');
      assert.ok(/male|gender/i.test(r.label || ''), 'toggle has no accessible name');
      assert.deepEqual(r.btns.map(b => b.slice(0, 3)), [['M', 'Male', 'radio'], ['F', 'Female', 'radio']], cat);
      assert.deepEqual(r.btns.map(b => b[3]), ['true', 'false'], 'alpha is Male');
    }
    await page.evaluate(() => VOStudio.showCategory('body'));
    assert.equal(await page.evaluate(() => !!document.querySelector('.st-tiles[data-group="gender"]')), false, 'Body A/B tiles are gone');
    await clickGender(page, 'F');
    assert.equal((await st(page)).gender, 'F');
    assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('.st-panel .st-gender button')).map(b => b.getAttribute('aria-checked'))), ['false', 'true']);
    await clickGender(page, 'M');
    assert.equal((await st(page)).gender, 'M');
  });

  await check('a. the new-agent look step has the same Male / Female toggle', async () => {
    const r = await page.evaluate(() => {
      const host = document.createElement('div'); document.body.appendChild(host);
      const state = VOStudio.newAgentLook(); state.gender = 'M';
      VOStudio.mountLookStep(host, state);
      const btns = Array.from(host.querySelectorAll('.st-gender button'));
      const out = { labels: btns.map(b => b.textContent.trim()), role: (host.querySelector('.st-gender') || {}).getAttribute && host.querySelector('.st-gender').getAttribute('role') };
      btns[1].click(); out.after = state.gender; out.lashes = state.appearance.lashes;
      host.remove(); return out;
    });
    assert.deepEqual(r.labels, ['Male', 'Female']);
    assert.equal(r.role, 'radiogroup');
    assert.equal(r.after, 'F');
    assert.equal(r.lashes, true, 'a new Female gets lashes');
  });

  await check('b. every category offers the gender its own items plus the shared ones (LOOK_GENDER)', async () => {
    const table = await page.evaluate(() => window.LOOK_GENDER);
    assert.ok(table, 'game.js has no LOOK_GENDER table');
    const catalog = await page.evaluate(() => VOStudio.catalog.looks || {});
    for (const k of Object.keys(TABS)) assert.ok(Array.isArray(catalog[k]) && catalog[k].length, `catalog.looks.${k}`);
    for (const g of ['M', 'F']) {
      await setLook(page, g, { hairStyle: 'buzz', eyebrowStyle: 'thick', lashes: false, lashStyle: null, lipColor: null, facialHair: null,
        shirtStyle: 'tee', neckwear: null, costume: null, headwear: null, glasses: null });
      for (const [key, tab] of Object.entries(TABS)) {
        await page.evaluate(t => VOStudio.showCategory(t), tab);
        const shown = await visible(page, key);
        assert.ok(shown && shown.length, `${key}: no tiles`);
        const all = catalog[key] || shown;
        for (const id of (catalog[key] || [])) {
          const want = !(table[key] && table[key][id]) || table[key][id] === g;
          assert.equal(shown.includes(id), want, `${g} ${key} ${id}: shown=${shown.includes(id)}`);
        }
        assert.ok(all.length, key);
      }
    }
    // the classification itself: beards Male, lashes / lips / tiara Female, most clothes shared
    assert.equal(table.facialHair.beard, 'M'); assert.equal(table.lashes.natural, 'F'); assert.equal(table.headwear.tiara, 'F');
    assert.ok(!table.glasses || Object.keys(table.glasses).length === 0, 'glasses are for everyone');
    assert.ok(!table.costume || Object.keys(table.costume).length === 0, 'costumes are for everyone');
  });

  await check('b. lashes: Male = No lashes only; Female = five lash styles (and No lashes); lip colour Female only', async () => {
    await setLook(page, 'M', { lashes: false, lashStyle: null, lipColor: null });
    await page.evaluate(() => VOStudio.showCategory('face'));
    assert.deepEqual(await visible(page, 'lashes'), ['none']);
    const lipsM = await visible(page, 'lipColor');
    assert.deepEqual(lipsM, [''], 'Male lip colour offers None only');
    await setLook(page, 'F', { lashes: true, lashStyle: null, lipColor: '#c4626a' });
    const f = await visible(page, 'lashes');
    for (const id of ['none', 'natural', 'long', 'curled', 'winged', 'full']) assert.ok(f.includes(id), `F lashes lack ${id}`);
    assert.ok((await visible(page, 'lipColor')).length >= 8, 'Female lip colours');
  });

  await check('c. the five Female lash styles draw in 4 views at game size; front and profile are distinct per style', async () => {
    const r = await page.evaluate(() => {
      const styles = ['none', 'natural', 'long', 'curled', 'winged', 'full'];
      const draw = (style, view) => {
        const c = document.createElement('canvas'); c.width = 60; c.height = 80;
        const a = new Agent({ id: 'lash-' + style + view, statusKey: 'lash', name: 'L', emoji: '', role: '', color: '#1e88e5', gender: 'F',
          appearance: { skinTone: '#e8b88a', hairStyle: 'bald', eyebrowStyle: 'thin', lipColor: null, lashes: style !== 'none', lashStyle: style === 'none' ? null : style },
          _autoDesk: { x: 0, y: 0 } });
        a.x = a.targetX = 30; a.y = a.targetY = 70; a.desk = { x: 900, y: 900 }; a.isSitting = false; a.state = 'idle'; a.blinkTimer = 0; a.tick = 0;
        a._lifeExtra = true; a._forceView = view;
        const saved = window.ctx; window.ctx = c.getContext('2d');
        try { a.draw(); } finally { window.ctx = saved; }
        return c.getContext('2d').getImageData(0, 0, 60, 80).data;
      };
      const diff = (x, y) => { let n = 0; for (let i = 0; i < x.length; i += 4) if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) n++; return n; };
      const out = {};
      for (const view of ['down', 'left', 'right', 'up']) {
        const px = {}; styles.forEach(s => { px[s] = draw(s, view); });
        out[view] = {};
        styles.forEach(s => { out[view][s] = styles.map(t => diff(px[s], px[t])); });
      }
      return out;
    });
    for (const view of ['down', 'left', 'right']) {
      const m = r[view];
      for (const [s, row] of Object.entries(m)) row.forEach((d, j) => {
        if (Object.keys(m)[j] !== s) assert.ok(d >= 1, `${view}: ${s} looks like ${Object.keys(m)[j]}`);
      });
      for (const s of ['natural', 'long', 'curled', 'winged', 'full']) assert.ok(m[s][0] >= 2, `${view}: ${s} hardly shows (${m[s][0]} px)`);
    }
    for (const row of Object.values(r.up)) assert.ok(row.every(d => d === 0), 'from behind the face (and lashes) is hidden');
  });

  await check('d. switching gender keeps shared choices and swaps the rest to the new gender\'s defaults', async () => {
    await page.evaluate(() => VOStudio.showCategory('hair'));
    await setLook(page, 'F', { hairStyle: 'bob', hairColor: '#bf360c', skinTone: '#8d5524', eyebrowStyle: 'arched', lashes: true, lashStyle: 'winged',
      lipColor: '#a1424a', facialHair: null, shirtStyle: 'blouse', neckwear: 'necklace', neckwearColor: '#eceff1', headwear: 'tiara', headwearColor: '#ffd700',
      glasses: 'round', glassesColor: '#333333', costume: null, heldItem: 'book' });
    await clickGender(page, 'M');
    const m = await st(page);
    const allowed = await page.evaluate(s => Object.keys(s.appearance).every(k => lookAllowed(k, s.appearance[k], 'M')), m);
    assert.equal(m.gender, 'M');
    assert.ok(allowed, 'a Female item stayed on the Male look');
    assert.deepEqual([m.appearance.lashes, m.appearance.lipColor, m.appearance.shirtStyle, m.appearance.neckwear || null, m.appearance.headwear || null],
      [false, null, 'tee', null, null]);
    assert.notEqual(m.appearance.hairStyle, 'bob'); assert.notEqual(m.appearance.eyebrowStyle, 'arched');
    assert.deepEqual([m.appearance.hairColor, m.appearance.skinTone, m.appearance.glasses, m.appearance.heldItem], ['#bf360c', '#8d5524', 'round', 'book'], 'shared choices kept');
    await setLook(page, 'M', { hairStyle: 'fade', facialHair: 'beard', facialHairColor: '#3e2723', eyebrowStyle: 'angular', lashes: false, lipColor: null });
    await clickGender(page, 'F');
    const f = await st(page);
    assert.equal(f.gender, 'F');
    assert.notEqual(f.appearance.hairStyle, 'fade');
    assert.equal(f.appearance.facialHair || null, null);
    assert.equal(f.appearance.eyebrowStyle, 'angular', 'shared brows kept');
    assert.deepEqual([f.appearance.lashes, f.appearance.lipColor], [true, '#c4626a'], 'a new Female gets the Female face defaults');
    assert.ok(await page.evaluate(s => Object.keys(s.appearance).every(k => lookAllowed(k, s.appearance[k], 'F')), f));
  });

  await check('d. Randomize keeps the gender and only picks that gender\'s items', async () => {
    for (const g of ['M', 'F']) {
      await setLook(page, g, {});
      const bad = await page.evaluate(gd => {
        const out = [];
        for (let i = 0; i < 60; i++) {
          VOStudio.randomize();
          const s = window._agentPanelEditState;
          if (s.gender !== gd) out.push('gender ' + s.gender);
          Object.keys(s.appearance).forEach(k => { if (!lookAllowed(k, s.appearance[k], gd)) out.push(k + '=' + s.appearance[k]); });
        }
        return out.slice(0, 5);
      }, g);
      assert.deepEqual(bad, [], g);
    }
    const ideas = await page.evaluate(() => { const s = VOStudio.newAgentLook(); return Object.keys(s.appearance).every(k => lookAllowed(k, s.appearance[k], s.gender)); });
    assert.ok(ideas, 'a new agent look mixes genders');
  });

  await check('f. Save writes gender, lashes and lashStyle; other agents untouched', async () => {
    await setLook(page, 'M', { lashes: false, lashStyle: null, lipColor: null, hairStyle: 'buzz', facialHair: null });
    await page.evaluate(() => VOStudio.showCategory('face'));
    await clickGender(page, 'F');
    await page.click('.st-panel [data-group="lashes"] [data-value="curled"]');
    await page.evaluate(() => VOStudio.showCategory('hair'));
    await page.click('.st-panel [data-group="hairStyle"] [data-value="bun"]');
    writes.length = 0;
    assert.equal(await page.evaluate(() => _acpSave()), true);
    const w = writes.filter(x => x.path === '/api/office-config').pop();
    const alpha = w.body.agents.find(a => a.id === 'alpha'), beta = w.body.agents.find(a => a.id === 'beta');
    assert.deepEqual([alpha.gender, alpha.appearance.lashes, alpha.appearance.lashStyle, alpha.appearance.hairStyle], ['F', true, 'curled', 'bun']);
    assert.equal('lashStyle' in beta.appearance, false);
  });

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  await page.context().close();
} catch (e) { failures++; console.log('not ok - setup: ' + String(e && e.message || e).split('\n')[0]); }

// e. Saved looks: the release candidate and this tree draw them the same, the Studio keeps them.
const LEGACY = [
  ['M', { skinTone: '#d4a574', hairStyle: 'spiky', hairColor: '#1a1a1a', eyebrowStyle: 'thick', headwear: 'crown', headwearColor: '#ffd700' }],
  ['F', { skinTone: '#8d5524', hairStyle: 'long', hairColor: '#3e2723', eyebrowStyle: 'thin', glasses: 'round', glassesColor: '#333333' }],
  ['F', { skinTone: '#ffcc80', hairStyle: 'bob', lashes: false, lipColor: null, facialHair: 'goatee' }],
  ['M', { skinTone: '#c68642', hairStyle: 'pigtails', lashes: true, lipColor: '#a1424a', headwear: 'tiara', headwearColor: '#90caf9' }],
  ['F', { skinTone: '#e8b88a', hairStyle: 'pixie', lashes: true, eyebrowStyle: 'arched', shirtStyle: 'suit', neckwear: 'tie', neckwearColor: '#283593' }],
  ['M', { skinTone: '#6b3e26', hairStyle: 'fade', facialHair: 'beard', shirtStyle: 'hoodie', costume: null, glasses: 'sunglasses' }],
];
const sigs = page => page.evaluate(list => {
  const out = [];
  list.forEach(([g, app], i) => ['down', 'left', 'right', 'up'].forEach(view => {
    const c = document.createElement('canvas'); c.width = 70; c.height = 90;
    const a = new Agent({ id: 'legacy' + i, statusKey: 'legacy' + i, name: 'L', emoji: '', role: '', color: '#1e88e5', gender: g,
      appearance: JSON.parse(JSON.stringify(app)), _autoDesk: { x: 0, y: 0 } });
    a.x = a.targetX = 35; a.y = a.targetY = 80; a.desk = { x: 900, y: 900 }; a.isSitting = false; a.state = 'idle'; a.blinkTimer = 0; a.tick = 0;
    a._lifeExtra = true; a._forceView = view;
    const saved = window.ctx; window.ctx = c.getContext('2d');
    try { a.draw(); } finally { window.ctx = saved; }
    out.push(c.toDataURL());
  }));
  return out;
}, LEGACY);

await check('e. saved looks draw pixel-for-pixel as the release candidate (' + BASE + ') drew them', async () => {
  let oldGame, oldStudio;
  try {
    oldGame = execFileSync('git', ['show', `${BASE}:app/game.js`], { cwd: ROOT, maxBuffer: 64 << 20 });
    oldStudio = execFileSync('git', ['show', `${BASE}:app/v10-studio.js`], { cwd: ROOT, maxBuffer: 64 << 20 });
  } catch (e) { console.log(`# skip: git ${BASE} not available`); return; }
  const now = await openStudio(browser);
  const after = await sigs(now.page);
  await now.page.context().close();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const { makeRouter } = await import('./test_v10_studio_lib.mjs');
  const inner = makeRouter(fixtures(), []);
  await ctx.route('**/*', r => {
    const p = new URL(r.request().url()).pathname;
    if (p === '/game.js') return r.fulfill({ status: 200, contentType: 'application/javascript', body: oldGame });
    if (p === '/v10-studio.js') return r.fulfill({ status: 200, contentType: 'application/javascript', body: oldStudio });
    return inner(r);
  });
  const old = await ctx.newPage();
  await old.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await old.waitForFunction(() => window.agents && window.agents.length === 3 && window.VOOffice, null, { timeout: 20000 });
  const before = await sigs(old);
  await ctx.close();
  assert.equal(after.length, LEGACY.length * 4);
  const changed = after.map((s, i) => s === before[i] ? null : i).filter(i => i !== null);
  assert.deepEqual(changed, [], 'renders that changed (look*4+view)');
});

await check('e. opening saved agents in the Studio changes nothing; an out-of-set look shows as the current choice', async () => {
  const fx = fixtures();
  fx['/api/office-config'].agents[0].appearance = Object.assign({}, fx['/api/office-config'].agents[0].appearance, { hairStyle: 'pigtails', lashes: true });
  const { page, writes, errors } = await openStudio(browser, { fx });
  const saved = await page.evaluate(() => JSON.parse(JSON.stringify(officeConfig.agents.map(a => [a.id, a.gender, a.appearance]))));
  for (const id of ['alpha', 'beta']) {
    await showStudio(page, id);
    for (const cat of ['body', 'hair', 'face', 'outfit', 'hats']) await page.evaluate(c => { VOStudio.showCategory(c); VOStudio.refreshNow(); }, cat);
  }
  await showStudio(page, 'alpha');
  await page.evaluate(() => VOStudio.showCategory('hair'));
  const hair = await visible(page, 'hairStyle');
  assert.ok(hair.includes('pigtails'), 'the saved Female hair on a Male agent is shown as current');
  assert.equal(await page.evaluate(() => { const t = document.querySelector('[data-group="hairStyle"] [data-value="pigtails"]'); return t.getAttribute('aria-checked'); }), 'true');
  await page.evaluate(() => VOStudio.showCategory('face'));
  assert.deepEqual(await visible(page, 'lashes'), ['none', 'natural'], 'Male: No lashes, plus the saved lashes as current');
  const es = await st(page);
  const after = await page.evaluate(() => JSON.parse(JSON.stringify(officeConfig.agents.map(a => [a.id, a.gender, a.appearance]))));
  assert.deepEqual(after, saved, 'officeConfig changed');
  assert.deepEqual([es.gender, es.appearance], [saved[0][1], saved[0][2]], 'the edit state changed on load');
  assert.equal(writes.filter(w => w.path === '/api/office-config').length, 0, 'opening wrote the layout');
  assert.deepEqual(errors, []);
  await page.context().close();
});

await check('a. phone layout: the toggle fits and both buttons are at least 40 px tall; dark and light themes', async () => {
  for (const theme of ['dark', 'light']) {
    const { page } = await openStudio(browser, { phone: true, theme });
    await showStudio(page, 'alpha');
    await page.evaluate(() => VOStudio.showCategory('face'));
    const r = await page.evaluate(() => {
      const g = document.querySelector('.st-panel .st-gender'); if (!g) return null;
      const bs = Array.from(g.querySelectorAll('button')).map(b => { const q = b.getBoundingClientRect(); const cs = getComputedStyle(b);
        return { w: q.width, h: q.height, right: q.right, color: cs.color, bg: cs.backgroundColor }; });
      return { bs, vw: innerWidth };
    });
    assert.ok(r, theme + ': no toggle on phone');
    for (const b of r.bs) { assert.ok(b.h >= 40, `${theme}: button ${b.h}px tall`); assert.ok(b.right <= r.vw + 0.5, `${theme}: off screen`); assert.notEqual(b.color, b.bg); }
    await page.context().close();
  }
});

await browser.close();
console.log(failures ? `FAIL ${NAME}: ${failures}` : `PASS ${NAME}`);
process.exit(failures ? 1 : 0);
