// v0.10 office editor extras: drag an item from the catalog onto the floor,
// "Deleted ... Undo" in the status bar, wall deletes saved at once, R turns
// the ghost of a rotatable item before placing, and the editor works in the
// light theme. Hermetic: see test_v10_editor_lib.mjs.
//
// Run: node tests/test_v10_editor_extras.mjs
import { launch, openEditor, toScreen, makeChecker } from './test_v10_editor_lib.mjs';

const NAME = 'test_v10_editor_extras';
const browser = await launch(NAME);
const t = makeChecker(NAME);
try {
  const { page, saves, errors } = await openEditor(browser);
  await page.waitForTimeout(400);

  // Drag the Plant card onto the floor: the drop places exactly the ghost.
  const card = await page.evaluate(() => { const r = document.querySelector('#furniture-catalog .catalog-item[data-type=plant]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const drop = await toScreen(page, 13 * 40 + 20, 12 * 40 + 20);
  const n0 = await page.evaluate(() => officeConfig.furniture.length);
  await page.mouse.move(card.x, card.y);
  await page.mouse.down();
  await page.mouse.move(card.x + 30, card.y, { steps: 3 });
  await page.mouse.move(drop.x, drop.y, { steps: 6 });
  const ghost = await page.evaluate(() => _ghostPos && { x: _ghostPos.x, y: _ghostPos.y });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const dropped = await page.evaluate(() => { const f = officeConfig.furniture[officeConfig.furniture.length - 1]; return { n: officeConfig.furniture.length, type: f.type, x: f.x, y: f.y, placing: placingType }; });
  t.ok(dropped.n === n0 + 1 && dropped.type === 'plant' && ghost && dropped.x === ghost.x && dropped.y === ghost.y, 'dragging a catalog card onto the floor places it where the ghost was', JSON.stringify({ ghost, dropped }));
  await page.keyboard.press('Escape');

  // Delete shows "Deleted Plant" with Undo; Undo brings it back.
  const pr = await page.evaluate(() => { const f = officeConfig.furniture[officeConfig.furniture.length - 1]; const r = _getItemWorldRect(f); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; });
  const pp = await toScreen(page, pr.x, pr.y);
  await page.mouse.click(pp.x, pp.y);
  await page.waitForTimeout(80);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(80);
  const bar = await page.evaluate(() => document.getElementById('vo-editor-status').innerText);
  t.ok(/Deleted Plant/.test(bar) && /Undo/.test(bar), 'deleting says what went and offers Undo', bar.replace(/\n/g, ' | '));
  await page.click('#vo-editor-status .vo-es-actions button');
  await page.waitForTimeout(80);
  t.ok(await page.evaluate((n) => officeConfig.furniture.length === n, n0 + 1), 'Undo in the status bar brings it back');

  // A deleted wall is saved at once.
  await page.evaluate(() => { selectedWallIdx = 0; _updateFloatingToolbarPosition(); });
  const s0 = saves.length;
  await page.click('#furniture-toolbar .delete-btn');
  await page.waitForTimeout(800);
  const walls = saves.length > s0 ? JSON.parse(saves[saves.length - 1].body).walls.interior.length : -1;
  t.ok(walls === 0, 'deleting a wall is saved at once', String(walls));

  // R turns the ghost before placing when the item can turn (any type flagged rotatable).
  const rot = await page.evaluate(() => {
    _selectCatalogItem('couch');
    _editPointerWorld = { x: 520, y: 520 };
    const before = _placementCandidate('couch', 520, 520);
    const turned = rotatePlacingGhost();
    const after = _ghostPos;
    _cancelPlacement();
    return { turned, rot: after && after.rotation, wBefore: _getItemWorldRect({ type: 'couch', x: before.x, y: before.y }).w, wAfter: after && _getItemWorldRect({ type: 'couch', x: after.x, y: after.y, rotation: after.rotation }).w };
  });
  t.ok(rot.turned && rot.rot === 90 && rot.wAfter < rot.wBefore, 'R turns the ghost of a rotatable item before it is placed', JSON.stringify(rot));
  t.ok(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 300));

  // Light theme: the editor chrome follows the tokens (no dark-only colours).
  const light = await openEditor(browser, {});
  const lp = light.page;
  await lp.evaluate(() => { document.documentElement.setAttribute('data-ui-theme', 'light'); });
  await lp.waitForTimeout(100);
  await lp.click('.catalog-item[data-type=desk]');
  await lp.waitForTimeout(150);
  const colors = await lp.evaluate(() => {
    const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255; };
    const panel = getComputedStyle(document.getElementById('furniture-catalog')).backgroundColor;
    const item = getComputedStyle(document.querySelector('#furniture-catalog .catalog-item')).color;
    const tokenBg = getComputedStyle(document.documentElement).getPropertyValue('--vo-surface-1').trim();
    return { panel, item, tokenBg, light: lum(panel) > 0.6, contrast: Math.abs(lum(panel) - lum(item)) };
  });
  t.ok(colors.light && colors.contrast > 0.4, 'catalog text keeps contrast in the light theme', JSON.stringify(colors));
  t.ok(light.errors.length === 0, 'no page errors (light)', light.errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
t.done();
