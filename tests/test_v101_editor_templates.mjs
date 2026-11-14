// v0.10.1 I4: a room template that does not fit where it is pointed at shows where it fits (dashed outlines, the
// nearest three) and offers "Place at a free spot"; when no clear spot is big enough it offers "Expand office to
// fit", which adds a strip as big as the layout (right or bottom) and places it there. Hermetic (editor lib).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { launch, openEditor, toScreen, makeChecker, APP } from './test_v10_editor_lib.mjs';

const NAME = 'test_v101_editor_templates';
const py = spawnSync('python3', ['-c', `
import json, sys, tempfile
sys.path.insert(0, ${JSON.stringify(APP)})
import layout_library as L
lib = L.LayoutLibrary(tempfile.mkdtemp(), ${JSON.stringify(path.join(APP, 'default-office-config.json'))})
items = lib.list()
print(json.dumps({'list': items, 'assets': {i['id']: lib.get(i['id']) for i in items}}))
`], { encoding: 'utf8' });
if (py.status !== 0) { console.log(py.stderr.slice(-400)); process.exit(1); }
const data = JSON.parse(py.stdout);

const browser = await launch(NAME);
const t = makeChecker(NAME);
try {
  const { page, errors } = await openEditor(browser, { layouts: { layouts: data.list }, layoutAssets: data.assets });
  await page.click('.catalog-tabs button[data-pane=layouts]');
  await page.waitForTimeout(1200);
  // Point the desk pod at a desk: blocked there.
  const desk = await page.evaluate(() => { const d = officeConfig.furniture.find(f => f.type === 'desk'); return { x: d.x, y: d.y }; });
  await page.click('[data-layout-place="room-desk-pod"]');
  await page.waitForTimeout(200);
  let p = await toScreen(page, desk.x + 20, desk.y + 20);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.waitForTimeout(250);
  const st = await page.evaluate(() => ({ state: OfficeLayouts.getPlacementState(), spots: OfficeLayouts.fitSpots().length,
    bar: document.getElementById('vo-editor-status').innerText, primary: document.querySelector('#vo-editor-status .ui-primary-action')?.textContent }));
  t.ok(st.state && !st.state.valid && st.state.code !== 'outside' && st.state.fits > 0 && st.spots === st.state.fits,
    'blocked over a desk, and the scan finds clear spots', JSON.stringify(st).slice(0, 240));
  t.ok(/dashed outlines/.test(st.bar) && st.primary === 'Place at a free spot' && /Expand office to fit/.test(st.bar),
    'the status bar says where it fits and offers "Place at a free spot" (and "Expand office to fit")', st.bar.replace(/\n/g, ' | '));
  const before = await page.evaluate(() => ({ n: officeConfig.furniture.length, W, H, spot: OfficeLayouts.fitSpots()[0] }));
  await page.click('#vo-editor-status .ui-primary-action');
  await page.waitForTimeout(600);
  const placed = await page.evaluate(() => ({ n: officeConfig.furniture.length, W, H, placing: OfficeLayouts.isPlacing(),
    bad: officeConfig.furniture.filter(f => _placementProblem(f.type, f.x, f.y, f.rotation || 0, [f.id])).length }));
  t.ok(placed.n > before.n && placed.W === before.W && placed.H === before.H && !placed.placing && placed.bad === 0,
    'Place at a free spot puts it on a clear spot (office size unchanged, nothing overlaps)', JSON.stringify({ before, placed }));
  // A full office: no clear spot anywhere; Expand office to fit makes room and places it.
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    for (let y = 100; y < H; y += 60) for (let x = 0; x < W; x += 60) officeConfig.furniture.push({ id: 'fill' + x + '_' + y, type: 'plant', x, y });
  });
  await page.click('[data-layout-place="room-desk-pod"]');
  await page.waitForTimeout(200);
  const scanMs = await page.evaluate(() => { const t0 = performance.now(); OfficeLayouts.fitSpots(); return Math.round(performance.now() - t0); });
  console.log(`  (free-spot scan of ${await page.evaluate(() => officeConfig.furniture.length)} pieces: ${scanMs} ms, once per office change)`);
  p = await toScreen(page, desk.x + 20, desk.y + 20);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.waitForTimeout(400);
  const full = await page.evaluate(() => ({ state: OfficeLayouts.getPlacementState(), bar: document.getElementById('vo-editor-status').innerText,
    primary: document.querySelector('#vo-editor-status .ui-primary-action')?.textContent, n: officeConfig.furniture.length, W, H }));
  t.ok(full.state && !full.state.valid && full.state.fits === 0 && /expand the office/i.test(full.bar) && full.primary === 'Expand office to fit' && !/Place at a free spot/.test(full.bar),
    'no clear spot: the bar offers "Expand office to fit" only', full.bar.replace(/\n/g, ' | '));
  await page.click('#vo-editor-status .ui-primary-action');
  await page.waitForTimeout(800);
  const grown = await page.evaluate(() => ({ n: officeConfig.furniture.length, W, H, placing: OfficeLayouts.isPlacing() }));
  t.ok((grown.W > full.W || grown.H > full.H) && grown.n > full.n && !grown.placing,
    'Expand office to fit grows the office and places the layout in the new room', JSON.stringify({ full: [full.W, full.H, full.n], grown }));
  t.ok(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
t.done();
