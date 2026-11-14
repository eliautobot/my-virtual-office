// Agent Studio: signature moves (v0.12 moves).
//
// The Moves category offers 'auto' plus every move of game.js SIGNATURE_MOVES (the one list) as picture tiles drawn
// by Agent.draw; picking one stores appearance.signatureMove and plays it on the stage; the stage's "Play move"
// button plays it with Office life off (the office never would); Save writes the field and a reload of the saved
// office gives that agent that move; 'auto' gives the move picked from the agent's id. Phone: the tiles fit.
//
// Run: node tests/test_v12_moves_studio.mjs (hermetic: fixture APIs, fake 200s for writes; SKIP without a browser)

import assert from 'node:assert/strict';
import { launch, openStudio, showStudio, fixtures, sleep } from './test_v10_studio_lib.mjs';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.log(`not ok - ${name}: ${String(e && e.message || e).split('\n')[0].slice(0, 300)}`); }
}

const browser = await launch('test_v12_moves_studio');
const stage = page => page.evaluate(() => document.querySelector('.st-stage-canvas').toDataURL());
try {
  const { page, errors, writes } = await openStudio(browser);
  await showStudio(page, 'alpha');
  await page.evaluate(() => { VOStudio.state.playing = false; if (window.VOLife && VOLife.isOn) window.__isOn = VOLife.isOn; });

  await check('Moves tab: auto + every move of the one game.js table as picture tiles, each drawn and different', async () => {
    const r = await page.evaluate(() => {
      VOStudio.showCategory('moves');
      VOStudio.refreshNow();
      const grid = document.querySelector('[data-group="signatureMove"]');
      const btns = grid ? Array.from(grid.querySelectorAll('.st-tile')) : [];
      const pics = btns.map(b => b.querySelector('canvas').toDataURL());
      return { ids: btns.map(b => b.dataset.value), table: (window.SIGNATURE_MOVES || []).map(m => m.id),
        labels: btns.map(b => b.textContent.trim()), distinct: new Set(pics.slice(1)).size, sel: grid && grid.querySelector('[aria-checked="true"]')?.dataset.value };
    });
    assert.equal(r.table.length, 8);
    assert.deepEqual(r.ids, ['auto'].concat(r.table));
    assert.equal(r.distinct, 8, 'every move tile shows its own pose');
    assert.equal(r.sel, 'auto', 'a look without the field is auto');
    assert.ok(/^Auto: /.test(r.labels[0]), 'the auto tile names the move it resolves to: ' + r.labels[0]);
  });

  await check('picking a tile stores the move and plays it on the stage; Play move plays it with Office life off; it ends in the pose before', async () => {
    const before = await stage(page);
    await page.click('[data-group="signatureMove"] .st-tile[data-value="jump"]', { timeout: 5000 });
    await sleep(350);
    const mid = await stage(page);
    const stored = await page.evaluate(() => (window._agentPanelEditState || {}).appearance.signatureMove);
    assert.equal(stored, 'jump');
    assert.notEqual(mid, before, 'the stage plays the jump');
    await sleep(1400);
    assert.equal(await stage(page), before, 'after the move the stage is back to the pose it had');
    await page.evaluate(() => { window.VOLife.isOn = () => false; });
    await page.click('.st-sigplay', { timeout: 5000 });
    await sleep(300);
    assert.notEqual(await stage(page), before, 'Play move works with Office life off (Studio preview)');
    await page.evaluate(() => { window.VOLife.isOn = window.__isOn; });
    await sleep(1400);
  });

  await check('Save writes signatureMove for the edited agent only; the saved office gives it that move after a reload', async () => {
    writes.length = 0;
    const ok = await page.evaluate(() => _acpSave());
    assert.equal(ok, true);
    const cfg = writes.filter(w => w.path === '/api/office-config').pop().body;
    const alpha = cfg.agents.find(x => x.id === 'alpha'), beta = cfg.agents.find(x => x.id === 'beta');
    assert.equal(alpha.appearance.signatureMove, 'jump');
    assert.equal('signatureMove' in (beta.appearance || {}), false, 'other agents untouched');
    const fx = fixtures(); fx['/api/office-config'] = cfg;
    const re = await openStudio(browser, { fx });
    const got = await re.page.evaluate(() => agents.map(x => [x.id, _sigMoveOf(x)]));
    const auto = await re.page.evaluate(() => _sigMoveOf({ id: 'beta' }));
    assert.deepEqual(got.find(x => x[0] === 'alpha'), ['alpha', 'jump']);
    assert.deepEqual(got.find(x => x[0] === 'beta'), ['beta', auto], 'no field: auto from the id');
    assert.deepEqual(re.errors, []);
    await re.context.close();
  });

  await check('no page errors (desktop)', async () => { assert.deepEqual(errors, []); });

  const ph = await openStudio(browser, { phone: true });
  await showStudio(ph.page, 'alpha');
  await check('phone 412 px: the Moves tiles fit the panel (no sideways scroll) and the Play move button is on the stage', async () => {
    const r = await ph.page.evaluate(() => {
      VOStudio.showCategory('moves'); VOStudio.refreshNow();
      const grid = document.querySelector('[data-group="signatureMove"]');
      const tiles = Array.from(grid.querySelectorAll('.st-tile')).map(t => t.getBoundingClientRect());
      const b = document.querySelector('.st-sigplay');
      return { n: tiles.length, over: tiles.filter(t => t.right > window.innerWidth + 0.5 || t.left < -0.5).length, sw: grid.scrollWidth - grid.clientWidth,
        btn: !!b && b.getBoundingClientRect().width > 0 };
    });
    assert.equal(r.n, 9);
    assert.equal(r.over, 0);
    assert.ok(r.sw <= 1, 'sideways scroll ' + r.sw);
    assert.ok(r.btn, 'Play move button visible');
  });
  await check('no page errors (phone)', async () => { assert.deepEqual(ph.errors, []); });
} finally {
  await browser.close();
}
console.log(failures ? `FAIL test_v12_moves_studio (${failures})` : 'PASS test_v12_moves_studio');
process.exit(failures ? 1 : 0);
