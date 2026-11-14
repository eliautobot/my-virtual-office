// v0.10 office editor: room templates in the Layouts tab (drawn previews,
// placing saves at once, the preview and the click agree) and "Expand office to
// fit" when a layout sticks out of the office. The template list comes from the
// real app/layout_library.py. Hermetic: see test_v10_editor_lib.mjs.
//
// Run: node tests/test_v10_editor_layouts.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { launch, openEditor, toScreen, makeChecker, APP } from './test_v10_editor_lib.mjs';

const NAME = 'test_v10_editor_layouts';
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
const templates = data.list.filter(l => l.source === 'template');

const browser = await launch(NAME);
const t = makeChecker(NAME);
t.ok(data.list[0].id === 'default-office' && templates.length >= 8 && templates.every(l => l.readOnly), 'library lists the default office first and the room templates as read-only', String(templates.length));
try {
  const { page, saves, errors } = await openEditor(browser, { layouts: { layouts: data.list }, layoutAssets: data.assets });

  // Every template is valid on its own: inside its bounds, nothing overlaps,
  // appliances stand on counters (checked with the editor's own rules).
  const geometry = await page.evaluate((assets) => {
    const bad = [];
    const saved = officeConfig.furniture;
    for (const a of assets) {
      const items = a.objects.furniture.map((f, i) => Object.assign({}, f, { id: 'tpl' + i, x: f.x + 200, y: f.y + 200 }));
      officeConfig.furniture = items;
      for (const it of items) {
        const r = _getItemWorldRect(it);
        if (r.x < 199 || r.y < 199 || r.x + r.w > 201 + a.bounds.width || r.y + r.h > 201 + a.bounds.height) bad.push(a.id + ':' + it.type + ' outside bounds');
        const why = _placementProblem(it.type, it.x, it.y, it.rotation || 0, [it.id]);
        if (why) bad.push(a.id + ':' + it.type + ' ' + why);
      }
    }
    officeConfig.furniture = saved;
    return bad;
  }, templates.map(l => data.assets[l.id]));
  t.ok(geometry.length === 0, 'every room template fits its bounds with no overlaps', geometry.slice(0, 4).join('; '));

  // Layouts tab: templates first, each with a drawn preview.
  await page.click('.catalog-tabs button[data-pane=layouts]');
  await page.waitForTimeout(1500);
  const tab = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('.layout-group-title')].map(h => h.textContent);
    const previews = [...document.querySelectorAll('.layout-preview')];
    const drawn = previews.filter(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 2000; }).length;
    const emoji = /[\u{1F300}-\u{1FAFF}⬆⬇]/u.test(document.getElementById('office-editor-layouts-view').textContent);
    return { titles, previews: previews.length, drawn, emoji };
  });
  t.ok(tab.titles[0] === 'Room templates' && tab.drawn === tab.previews && tab.previews >= 9 && !tab.emoji, 'Layouts tab shows room templates first with drawn previews and no emoji', JSON.stringify(tab));

  // Place the 4-desk pod: the click places what the preview showed, saved at once.
  const n0 = await page.evaluate(() => officeConfig.furniture.length);
  await page.click('[data-layout-place="room-desk-pod"]');
  await page.waitForTimeout(200);
  const spot = await toScreen(page, 480, 560);
  await page.mouse.move(spot.x, spot.y, { steps: 3 });
  await page.waitForTimeout(100);
  const preview = await page.evaluate(() => OfficeLayouts.getPlacementState());
  const s0 = saves.length;
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(800);
  const placed = await page.evaluate(() => ({ n: officeConfig.furniture.length, sel: _multiSelected.length, first: officeConfig.furniture[officeConfig.furniture.length - 6] }));
  t.ok(preview && preview.valid && placed.n === n0 + 6 && placed.sel === 6 && placed.first.x === preview.origin.x + 40 && placed.first.y === preview.origin.y + 64,
    'placing a template puts it where the preview was and selects it', JSON.stringify({ preview, placed }));
  t.ok(saves.length > s0 && JSON.parse(saves[saves.length - 1].body).furniture.length === n0 + 6, 'a placed template is saved at once');

  // Expand office to fit: the kitchenette at the right edge sticks out.
  await page.keyboard.press('Escape');
  await page.click('[data-layout-place="room-kitchenette"]');
  await page.waitForTimeout(200);
  const W0 = await page.evaluate(() => W);
  const edge = await toScreen(page, W0 - 40, 300);
  await page.mouse.move(edge.x, edge.y, { steps: 3 });
  await page.waitForTimeout(150);
  const st = await page.evaluate(() => ({ state: OfficeLayouts.getPlacementState(), bar: document.getElementById('vo-editor-status').innerText }));
  t.ok(st.state && st.state.code === 'outside' && /Expand office to fit/.test(st.bar), 'status bar offers "Expand office to fit" when a layout sticks out', JSON.stringify(st).slice(0, 200));
  const n1 = await page.evaluate(() => officeConfig.furniture.length);
  await page.click('#vo-editor-status .ui-primary-action');
  await page.waitForTimeout(800);
  const grown = await page.evaluate(() => ({ W, n: officeConfig.furniture.length, placing: OfficeLayouts.isPlacing() }));
  t.ok(grown.W > W0 && grown.n === n1 + 8 && !grown.placing, 'Expand office to fit grows the office and places the layout', JSON.stringify(grown));

  t.ok(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
t.done();
