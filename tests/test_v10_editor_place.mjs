// v0.10 office editor: placing is "what you see is what you get" and every
// placement, wall and door is saved at once (OE-01, OE-02, OE-11, OE-20,
// OE-21, OE-22). Hermetic: see test_v10_editor_lib.mjs.
//
// Run: node tests/test_v10_editor_place.mjs
import { launch, openEditor, toScreen, makeChecker } from './test_v10_editor_lib.mjs';

const NAME = 'test_v10_editor_place';
const browser = await launch(NAME);
const t = makeChecker(NAME);
try {
  const { page, saves, errors } = await openEditor(browser);

  // 1. Every click places exactly the ghost, wherever inside the tile it lands.
  await page.click('.catalog-item[data-type=plant]');
  let mismatches = 0, placed = 0;
  const offsets = [[-17, -17], [-11, -11], [-5, 7], [0, 0], [9, -9], [13, 13], [17, -3], [-15, 16]];
  for (let i = 0; i < offsets.length; i++) {
    const [ox, oy] = offsets[i];
    const tx = 10 + (i % 4) * 2, ty = 10 + Math.floor(i / 4) * 2;
    const p = await toScreen(page, tx * 40 + 20 + ox, ty * 40 + 20 + oy);
    await page.mouse.move(p.x, p.y, { steps: 2 });
    await page.waitForTimeout(40);
    const before = await page.evaluate(() => ({ n: officeConfig.furniture.length, g: _ghostPos && { x: _ghostPos.x, y: _ghostPos.y, valid: _ghostPos.valid } }));
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(40);
    const after = await page.evaluate(() => { const f = officeConfig.furniture[officeConfig.furniture.length - 1]; return { n: officeConfig.furniture.length, x: f.x, y: f.y }; });
    if (before.g && before.g.valid) {
      if (after.n !== before.n + 1 || after.x !== before.g.x || after.y !== before.g.y) mismatches++;
      else placed++;
    } else if (after.n !== before.n) mismatches++;
  }
  t.ok(mismatches === 0 && placed === offsets.length, 'every click places exactly what the ghost shows', `placed ${placed}, mismatches ${mismatches}`);

  // 2. Whole-tile snap: a 1-tile plant sits centred in the pointer's tile.
  const snap = await page.evaluate(() => {
    const c = _placementCandidate('plant', 10 * 40 + 3, 9 * 40 + 37);
    const r = _getItemWorldRect({ type: 'plant', x: c.x, y: c.y });
    return { cx: Math.round(r.x + r.w / 2), cy: Math.round(r.y + r.h / 2) };
  });
  t.ok(Math.abs(snap.cx - 420) <= 1 && Math.abs(snap.cy - 380) <= 1, 'whole tile snap centres the item in the tile', JSON.stringify(snap));

  // 3. Placements are saved without any other action (debounced POST).
  await page.waitForTimeout(900);
  const lastSave = saves.length ? JSON.parse(saves[saves.length - 1].body) : null;
  t.ok(lastSave && lastSave.furniture.filter(f => f.type === 'plant').length === 1 + placed, 'placed items are saved', `saves ${saves.length}`);

  // 4. Red ghost: the click places nothing and the reason is known.
  const overDesk = await page.evaluate(() => { const r = _getItemWorldRect(officeConfig.furniture.find(f => f.id === 'd1')); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; });
  const pd = await toScreen(page, overDesk.x, overDesk.y);
  await page.mouse.move(pd.x, pd.y, { steps: 2 });
  await page.waitForTimeout(60);
  const nBefore = await page.evaluate(() => officeConfig.furniture.length);
  await page.mouse.click(pd.x, pd.y);
  await page.waitForTimeout(60);
  const red = await page.evaluate(() => ({ n: officeConfig.furniture.length, reason: _placementReason }));
  t.ok(red.n === nBefore && red.reason === 'Overlaps Desk', 'a red ghost places nothing and says why', JSON.stringify(red));

  // 5. Walls: start corner, end corner, saved at once; the tool keeps going.
  await page.keyboard.press('Escape');
  await page.click('.catalog-item[data-type=wall]');
  const s0 = saves.length;
  const a = await toScreen(page, 12 * 40 + 6, 15 * 40 - 5), b = await toScreen(page, 17 * 40 - 4, 15 * 40 + 9);
  await page.mouse.click(a.x, a.y); await page.waitForTimeout(40);
  await page.mouse.click(b.x, b.y); await page.waitForTimeout(900);
  const wall = await page.evaluate(() => officeConfig.walls.interior.find(w => w.y1 === 15 && w.y2 === 15));
  t.ok(wall && wall.x1 === 12 && wall.x2 === 17, 'wall runs between the clicked grid corners', JSON.stringify(wall));
  t.ok(saves.length > s0 && JSON.parse(saves[saves.length - 1].body).walls.interior.length === 2, 'a new wall is saved at once');

  // 6. Doors: a click next to the wall line opens it; a miss changes nothing.
  await page.keyboard.press('Escape');
  await page.click('.catalog-item[data-type=door]');
  const miss = await toScreen(page, 600, 300);
  await page.mouse.click(miss.x, miss.y); await page.waitForTimeout(40);
  const wallsAfterMiss = await page.evaluate(() => officeConfig.walls.interior.length);
  const near = await toScreen(page, 20 * 40 - 12, 12 * 40 + 20); // left of the x=20 wall line
  const s1 = saves.length;
  await page.mouse.click(near.x, near.y); await page.waitForTimeout(900);
  const split = await page.evaluate(() => officeConfig.walls.interior.filter(w => w.x1 === 20 && w.x2 === 20).map(w => [w.y1, w.y2]));
  t.ok(wallsAfterMiss === 2 && JSON.stringify(split) === '[[10,12],[13,16]]', 'door opens one tile of the wall next to the click', JSON.stringify(split));
  t.ok(saves.length > s1, 'a new door is saved at once');

  // 7. Esc never leaves the editor.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Escape');
  t.ok(await page.evaluate(() => editMode && !placingType), 'Esc steps back but never closes the editor');

  // 8. Closing the tab with a pending save sends it right away.
  await page.click('.catalog-item[data-type=plant]');
  const free = await toScreen(page, 22 * 40 + 20, 7 * 40 + 20);
  await page.mouse.move(free.x, free.y); await page.mouse.click(free.x, free.y);
  const s2 = saves.length;
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  await page.waitForTimeout(150);
  t.ok(saves.length === s2 + 1, 'a pending save is sent at once when the tab closes', `${s2} -> ${saves.length}`);

  // 9. The new text label dialog starts empty (typing does not append to "Label").
  await page.keyboard.press('Escape');
  await page.click('.catalog-item[data-type=textLabel]');
  const lp = await toScreen(page, 16 * 40, 3 * 40 + 20);
  await page.mouse.move(lp.x, lp.y); await page.mouse.click(lp.x, lp.y);
  await page.waitForTimeout(250);
  const dlg = await page.evaluate(() => { const d = [...document.querySelectorAll('.vo-dialog')].pop(); const i = d && d.querySelector('input'); return i ? { value: i.value, ph: i.placeholder } : null; });
  t.ok(dlg && dlg.value === '' && /Team/.test(dlg.ph), 'label dialog starts empty with a placeholder', JSON.stringify(dlg));

  t.ok(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
t.done();
