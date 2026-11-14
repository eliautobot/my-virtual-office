// Agent Studio and the v0.12 faces (face, items c and d).
//
// c. The Hats tab offers every id of the one headwear table in game.js
//    (HEADWEAR_STYLES), with its human name, including santa, witch and sunhat.
// d. The Face tab has a small row to preview the expressions (game.js
//    AGENT_EXPRESSIONS): one tile per face, each drawn through Agent.draw;
//    picking one changes the stage, but nothing is saved (not a look setting).
//    The stage keeps its size (the row is in the panel, not under the stage).
//
// Hermetic: app/ from this tree, fixture APIs, fake 200s for writes.
// Run: node tests/test_v12_face_studio.mjs

import assert from 'node:assert/strict';
import { launch, openStudio, showStudio } from './test_v10_studio_lib.mjs';

const NAME = 'test_v12_face_studio';
const browser = await launch(NAME);
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.log(`not ok - ${name}: ${String(e && e.message || e).split('\n')[0].slice(0, 300)}`); }
}

const stageHash = page => page.evaluate(() => { VOStudio.refreshNow(); return document.querySelector('.st-stage-canvas').toDataURL(); });

try {
  const { page, errors, writes } = await openStudio(browser);
  await showStudio(page, 'alpha');
  await page.evaluate(() => { VOStudio.state.playing = false; });

  await check('Hats tab offers every headwear id of the one game.js table, santa, witch and sunhat included', async () => {
    const r = await page.evaluate(() => {
      VOStudio.showCategory('hats');
      const table = (window.HEADWEAR_STYLES || []).map(h => ({ id: h.id, label: h.label }));
      const tiles = Array.from(document.querySelectorAll('[data-key="headwear"] [data-value], .st-panel [data-value]'))
        .filter(b => b.closest('[data-key="headwear"]') || table.some(h => h.id === b.dataset.value));
      const offered = Array.from(new Set(tiles.map(b => b.dataset.value)));
      const labels = Array.from(document.querySelectorAll('.st-tile-label')).map(x => x.textContent.trim());
      return { table, offered, catalog: VOStudio.catalog.headwear, labels };
    });
    for (const id of ['santa', 'witch', 'sunhat']) assert.ok(r.table.some(h => h.id === id), `table lacks ${id}`);
    assert.deepEqual(r.catalog, ['none'].concat(r.table.map(h => h.id)), 'studio list is not the game.js table');
    for (const h of r.table) assert.ok(r.labels.includes(h.label), `no tile named ${h.label}`);
  });

  await check('the Face tab has an expression row: one tile per expression, each a different face drawn by Agent.draw', async () => {
    const r = await page.evaluate(() => {
      VOStudio.showCategory('face');
      VOStudio.refreshNow();
      const list = window.AGENT_EXPRESSIONS || [];
      const grid = document.querySelector('[data-group="expression"]');
      const btns = grid ? Array.from(grid.querySelectorAll('.st-tile')) : [];
      const pics = btns.map(b => {
        const c = b.querySelector('canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) ink++;
        return { ink, url: c.toDataURL() };
      });
      return { list, ids: btns.map(b => b.dataset.value), names: btns.map(b => b.textContent.trim()),
        role: grid && grid.getAttribute('role'),
        checked: btns.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.dataset.value),
        inks: pics.map(p => p.ink), distinct: new Set(pics.map(p => p.url)).size };
    });
    assert.ok(r.list.length >= 6, 'AGENT_EXPRESSIONS missing');
    assert.deepEqual(r.ids, r.list);
    assert.equal(r.role, 'radiogroup');
    assert.deepEqual(r.checked, ['neutral']);
    assert.ok(r.inks.every(n => n > 200), `an empty face picture: ${r.inks.join()}`);
    assert.equal(r.distinct, r.list.length, `only ${r.distinct} different faces`);
    assert.ok(r.names.every(n => n && !/[a-z][A-Z]/.test(n)), r.names.join());
  });

  await check('picking a face shows it on the stage in front and profile and saves nothing', async () => {
    const before = await page.evaluate(() => JSON.stringify(_agentPanelEditState));
    const writesBefore = writes.length;
    const neutral = await stageHash(page);
    await page.click('[data-group="expression"] .st-tile[data-value="sleepy"]', { timeout: 5000 });
    const sleepy = await stageHash(page);
    const checked = await page.evaluate(() => Array.from(document.querySelectorAll('[data-group="expression"] .st-tile[aria-checked="true"]')).map(b => b.dataset.value));
    // Profile: the same face picked, now in a side view.
    await page.evaluate(() => { VOStudio.state.facing = 'right'; });
    const sideSleepy = await stageHash(page);
    await page.click('[data-group="expression"] .st-tile[data-value="neutral"]', { timeout: 5000 });
    const sideNeutral = await stageHash(page);
    await page.evaluate(() => { VOStudio.state.facing = null; });
    const after = await page.evaluate(() => JSON.stringify(_agentPanelEditState));
    assert.notEqual(sleepy, neutral, 'stage did not change for sleepy');
    assert.notEqual(sideSleepy, sideNeutral, 'profile did not change for sleepy');
    assert.deepEqual(checked, ['sleepy']);
    assert.equal(after, before, 'the look changed');
    assert.equal(writes.length, writesBefore, 'a write was sent');
  });

  await check('the face row fits a 412 px phone without scrolling sideways', async () => {
    const ph = await openStudio(browser, { phone: true });
    await showStudio(ph.page, 'alpha');
    const r = await ph.page.evaluate(() => {
      VOStudio.showCategory('face');
      VOStudio.refreshNow();
      const row = document.querySelector('[data-group="expression"]');
      if (!row) return null;
      const rr = row.getBoundingClientRect();
      const out = Array.from(row.querySelectorAll('.st-tile')).filter(b => { const q = b.getBoundingClientRect(); return q.left < 0 || q.right > innerWidth; }).length;
      return { overflow: row.scrollWidth - row.clientWidth, out, w: Math.round(rr.width), vw: innerWidth };
    });
    assert.ok(r, 'no face row on the phone');
    assert.ok(r.overflow <= 0 && r.out === 0, JSON.stringify(r));
    assert.deepEqual(ph.errors, []);
    await ph.context.close();
  });

  await check('the stage keeps its size: nothing new under it', async () => {
    const r = await page.evaluate(() => ({ under: document.querySelectorAll('.st-stage-col [data-group="expression"]').length,
      scale: Number(document.querySelector('.st-stage').dataset.scale) }));
    assert.equal(r.under, 0, 'the expression row is under the stage');
    assert.ok(r.scale >= 4, `stage scale ${r.scale}`);
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
}
if (failures) { console.log(`${NAME}: FAILED ${failures} check(s)`); process.exit(1); }
console.log(`${NAME}: all passed`);
process.exit(0);
