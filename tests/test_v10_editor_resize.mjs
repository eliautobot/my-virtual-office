// v0.10 office editor: the office grows and shrinks on all four sides (OE-24).
// Left/top moves everything on the floor by whole tiles; things on the top wall
// stay on it; a shrink that would cut something off is refused with a reason.
// Hermetic: see test_v10_editor_lib.mjs.
//
// Run: node tests/test_v10_editor_resize.mjs
import { launch, openEditor, officeFixture, toScreen, makeChecker } from './test_v10_editor_lib.mjs';

const NAME = 'test_v10_editor_resize';
const browser = await launch(NAME);
const t = makeChecker(NAME);
try {
  const office = officeFixture();
  office.furniture.push({ id: 'w1', type: 'window', x: 300, y: 20 });
  office.floor.zones = [{ x: 12, y: 8, w: 2, h: 2, style: 'wood', color1: '#a27b55', color2: '#946f4b' }];
  const { page, saves, errors } = await openEditor(browser, { office });

  const snap = () => page.evaluate(() => ({
    W, H, d1: officeConfig.furniture.find(f => f.id === 'd1'), w1: officeConfig.furniture.find(f => f.id === 'w1'),
    wall: officeConfig.walls.interior[0], zone: officeConfig.floor.zones && officeConfig.floor.zones[0],
    buttons: _editButtons.map(b => b.edge + ':' + b.action).sort().join(',')
  }));
  const s0 = await snap();
  t.ok(['left', 'right', 'top', 'bottom'].every(e => s0.buttons.includes(e + ':expand') && s0.buttons.includes(e + ':shrink')), 'grips with + and - on all four sides', s0.buttons);

  // Add a column on the left: floor content moves one tile right.
  await page.evaluate(() => expandCanvas('left'));
  const s1 = await snap();
  t.ok(s1.W === s0.W + 40 && s1.d1.x === s0.d1.x + 40 && s1.wall.x1 === s0.wall.x1 + 1 && s1.zone.x === s0.zone.x + 1 && s1.w1.x === s0.w1.x + 40,
    'a column on the left moves items, walls and painted floor one tile right', JSON.stringify({ W: s1.W, d1: s1.d1.x, wall: s1.wall.x1, zone: s1.zone.x }));

  // Add a row at the top: the floor moves down, the window stays on the wall.
  await page.evaluate(() => expandCanvas('top'));
  const s2 = await snap();
  t.ok(s2.H === s0.H + 40 && s2.d1.y === s0.d1.y + 40 && s2.wall.y1 === s0.wall.y1 + 1 && s2.zone.y === s0.zone.y + 1 && s2.w1.y === s0.w1.y,
    'a row at the top moves the floor down and keeps wall items on the wall', JSON.stringify({ H: s2.H, d1: s2.d1.y, w1: s2.w1.y }));

  // Undo twice brings the exact office back.
  await page.evaluate(() => { undoEdit(); undoEdit(); });
  const s3 = await snap();
  t.ok(s3.W === s0.W && s3.H === s0.H && s3.d1.x === s0.d1.x && s3.d1.y === s0.d1.y && s3.wall.x1 === s0.wall.x1, 'undo restores the office after left/top resizes');

  // Shrinking into an item is refused with a reason.
  await page.evaluate(() => { officeConfig.furniture.push({ id: 'edge', type: 'plant', x: 2, y: 400 }); });
  await page.evaluate(() => shrinkCanvas('left'));
  const s4 = await page.evaluate(() => ({ W, flash: _editFlashState && _editFlashState.text }));
  t.ok(s4.W === s0.W && /Move or remove/.test(s4.flash || ''), 'a shrink that would cut an item off is refused and says why', JSON.stringify(s4));
  await page.evaluate(() => { officeConfig.furniture = officeConfig.furniture.filter(f => f.id !== 'edge'); });

  // Dragging the left grip two tiles outwards adds two columns in one undo step.
  // (until the camera honours the panel inset, the left edge sits under the panel: hide it for this drag)
  await page.evaluate(() => { document.getElementById('furniture-catalog').style.display = 'none'; fitView(); });
  await page.waitForTimeout(450);
  const grip = await page.evaluate(() => { const h = _editResizeHandles.find(h => h.edge === 'left'); return { x: h.x + h.w / 2, y: h.y + h.h / 2 }; });
  const g = await toScreen(page, grip.x, grip.y);
  const per = await page.evaluate(() => getBaseScale() * camera.zoom * canvas.getBoundingClientRect().width / displayW);
  const u0 = await page.evaluate(() => _undoStack.length);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x - 40 * per * 2.1, g.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const s5 = await page.evaluate(() => ({ W, d1: officeConfig.furniture.find(f => f.id === 'd1').x, undo: _undoStack.length }));
  t.ok(s5.W === s0.W + 80 && s5.d1 === s0.d1.x + 80 && s5.undo === u0 + 1, 'dragging the left grip adds columns in one undo step', JSON.stringify(s5));
  const saved = JSON.parse(saves[saves.length - 1].body);
  t.ok(saved.canvasWidth === s0.W + 80 && saved.furniture.find(f => f.id === 'd1').x === s0.d1.x + 80, 'the resized office is saved');
  const pill = await page.evaluate(() => document.getElementById('vo-office-save-status').textContent);
  t.ok(pill.includes(((s0.W + 80) / 40) + ' × '), 'the edit pill shows the new size', pill);

  t.ok(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
t.done();
