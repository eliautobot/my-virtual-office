// v0.10 office editor tools: catalog thumbnails + search (OE-12, OE-13), the
// status bar reason (OE-09), item toolbar (OE-15), duplicate / copy / paste /
// select all (OE-17), nudge undo bursts + blocked feedback (OE-25), colour
// window on screen (OE-08) with removable favourites (OE-26), floor zones and
// wall paint (OE-10, contract C2), shortcut card, snap toggle (OE-11), select
// area (OE-27), phone peek bar + tabs + footer bar (OE-04..OE-07; v0.13: the sheet stays open while placing unless full).
// Hermetic: see test_v10_editor_lib.mjs.
//
// Run: node tests/test_v10_editor_tools.mjs
import { launch, openEditor, toScreen, makeChecker } from './test_v10_editor_lib.mjs';

const NAME = 'test_v10_editor_tools';
const browser = await launch(NAME);
const t = makeChecker(NAME);
try {
  const { page, saves, errors } = await openEditor(browser);
  await page.waitForTimeout(500);

  // Catalog: thumbnails drawn by the game, 3 columns, sizes in tiles.
  const cat = await page.evaluate(async () => {
    const items = document.querySelectorAll('#furniture-catalog .catalog-item');
    // v0.13: previews are canvas tiles drawn as they come into view: scroll through the list first
    for (const it of items) { it.scrollIntoView({ block: 'nearest' }); await new Promise(r => setTimeout(r, 40)); }
    for (let i = 0; i < 80 && document.querySelector('#furniture-catalog .catalog-item .catalog-icon:not([data-thumb="1"])'); i++) await new Promise(r => setTimeout(r, 50));
    document.querySelector('#furniture-catalog .catalog-item').scrollIntoView({ block: 'nearest' });
    const thumbs = [...document.querySelectorAll('#furniture-catalog .catalog-item .catalog-thumb')];
    const painted = c => { if (!c.getContext || c.dataset.pending) return false; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n > 40; };
    const drawn = thumbs.filter(painted).length;
    const cols = getComputedStyle(document.querySelector('#furniture-catalog .catalog-items')).gridTemplateColumns.split(' ').length;
    const meta = document.querySelector('#furniture-catalog .catalog-item[data-type=desk] .catalog-item-meta').textContent;
    return { items: items.length, drawn, cols, meta };
  });
  t.ok(cat.drawn === cat.items && cat.cols === 3 && cat.meta === '2 × 2', 'catalog shows drawn thumbnails in 3 columns with tile sizes', JSON.stringify(cat));

  // Search: synonyms and an empty state.
  await page.fill('.catalog-search', 'sofa');
  const sofa = await page.evaluate(() => [...document.querySelectorAll('#furniture-catalog .catalog-item')].filter(i => i.style.display !== 'none').map(i => i.dataset.type));
  await page.fill('.catalog-search', 'zzz');
  const empty = await page.evaluate(() => { const e = document.querySelector('.catalog-empty'); return e && !e.hidden ? e.textContent : ''; });
  await page.fill('.catalog-search', '');
  t.ok(sofa.includes('couch') && sofa.includes('engLounge') && /Nothing matches/.test(empty), 'search finds synonyms and says when nothing matches', JSON.stringify(sofa) + ' ' + empty);

  // Status bar: the reason for a red ghost, in words.
  await page.click('.catalog-item[data-type=coffeeMaker]');
  const far = await toScreen(page, 500, 600);
  await page.mouse.move(far.x, far.y, { steps: 2 });
  await page.waitForTimeout(120);
  const status = await page.evaluate(() => { const b = document.getElementById('vo-editor-status'); return b.hidden ? '' : b.innerText; });
  t.ok(/Coffee Maker/.test(status) && /Needs a kitchen counter/.test(status), 'status bar names the item and why it can not go there', status.replace(/\n/g, ' | '));
  await page.keyboard.press('Escape');

  // Item toolbar: name + only the tools that apply, as SVG icons.
  const desk = await page.evaluate(() => { const r = _getItemWorldRect(officeConfig.furniture.find(f => f.id === 'd1')); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; });
  const dp = await toScreen(page, desk.x, desk.y);
  await page.mouse.click(dp.x, dp.y);
  await page.waitForTimeout(150);
  const tb = await page.evaluate(() => {
    const el = document.getElementById('furniture-toolbar');
    const vis = [...el.querySelectorAll('.ftb-btn')].filter(b => !b.hidden);
    return { shown: el.style.display, name: document.getElementById('ftb-selection-count').textContent,
      allSvg: vis.every(b => b.querySelector('svg use')), emoji: /[\u{1F300}-\u{1FAFF}]/u.test(el.textContent), labels: vis.map(b => b.getAttribute('aria-label')) };
  });
  t.ok(tb.shown === 'flex' && tb.name === 'Desk' && tb.allSvg && !tb.emoji && tb.labels.some(l => /Duplicate/.test(l)), 'item toolbar shows the name and SVG tools', JSON.stringify(tb));

  // Ctrl+D: a copy to the right, selected, saved; no desk owner copied.
  const n0 = await page.evaluate(() => officeConfig.furniture.length);
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(100);
  const dup = await page.evaluate(() => { const s = officeConfig.furniture.find(f => f.id === selectedItemId); const o = officeConfig.furniture.find(f => f.id === 'd1'); return { n: officeConfig.furniture.length, dx: s && s.x - o.x, dy: s && s.y - o.y, owner: s && s.assignedTo, same: s && s.id === 'd1' }; });
  t.ok(dup.n === n0 + 1 && dup.dx === 80 && dup.dy === 0 && !dup.owner && !dup.same, 'Ctrl+D duplicates one step right and selects the copy', JSON.stringify(dup));
  await page.keyboard.press('Control+d');
  const dup2 = await page.evaluate(() => { const s = officeConfig.furniture.find(f => f.id === selectedItemId); return s && s.x; });
  t.ok(dup2 === 560 + 160, 'the next Ctrl+D continues the row', String(dup2));

  // Nudge: a burst of arrow presses is one undo step; a blocked nudge says why.
  const u0 = await page.evaluate(() => _undoStack.length);
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  const u1 = await page.evaluate(() => _undoStack.length);
  t.ok(u1 === u0 + 1, 'a burst of nudges is one undo step', `${u0} -> ${u1}`);
  await page.keyboard.press('Escape');
  await page.mouse.click(dp.x, dp.y);
  await page.waitForTimeout(80);
  await page.keyboard.press('Shift+ArrowRight'); // into the first copy
  await page.waitForTimeout(80);
  const blocked = await page.evaluate(() => ({ x: officeConfig.furniture.find(f => f.id === 'd1').x, flash: _editFlashState && _editFlashState.text }));
  t.ok(blocked.x === 560 && /Overlaps Desk/.test(blocked.flash || ''), 'a blocked nudge does not move and says why', JSON.stringify(blocked));

  // Copy / paste at the pointer, and select all.
  await page.keyboard.press('Control+c');
  const target = await toScreen(page, 500, 640);
  await page.mouse.move(target.x, target.y);
  const n1 = await page.evaluate(() => officeConfig.furniture.length);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(80);
  const pasted = await page.evaluate(() => { const s = officeConfig.furniture.find(f => f.id === selectedItemId); const r = _getItemWorldRect(s); return { n: officeConfig.furniture.length, cx: r.x + r.w / 2, cy: r.y + r.h / 2 }; });
  t.ok(pasted.n === n1 + 1 && Math.abs(pasted.cx - 500) <= 40 && Math.abs(pasted.cy - 640) <= 40, 'Ctrl+V pastes the copy at the pointer', JSON.stringify(pasted));
  await page.keyboard.press('Control+a');
  const all = await page.evaluate(() => ({ sel: _multiSelected.length + _multiSelectedWalls.length, total: officeConfig.furniture.length + officeConfig.walls.interior.length, name: document.getElementById('ftb-selection-count').textContent }));
  t.ok(all.sel === all.total && all.name === all.total + ' selected', 'Ctrl+A selects everything', JSON.stringify(all));
  await page.keyboard.press('Escape');

  // Colour window: opens fully on screen above the edit bar; favourites removable without right-click.
  await page.evaluate(() => { selectedWallIdx = 0; _updateFloatingToolbarPosition(); });
  await page.waitForTimeout(80);
  await page.click('#ftb-color-btn');
  await page.waitForTimeout(150);
  const cp = await page.evaluate(() => {
    const el = document.getElementById('edit-color-picker'); const r = el.getBoundingClientRect();
    const bar = document.querySelector('.ui-edit-toolbar').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, right: r.right, vh: innerHeight, vw: innerWidth, barTop: bar.top, cls: el.className, inline: el.getAttribute('style') || '' };
  });
  t.ok(cp.top >= 0 && cp.bottom <= cp.barTop && cp.right <= cp.vw && cp.cls === 'vo-editor-color' && !/Press Start/.test(cp.inline), 'wall colour window is token-styled and fully on screen above the edit bar', JSON.stringify(cp));
  await page.click('#edit-cp-save-favorite');
  const favBefore = await page.evaluate(() => colorFavorites.length);
  await page.hover('.vo-ec-fav');
  await page.click('.vo-ec-fav .vo-ec-fav-remove');
  const favAfter = await page.evaluate(() => colorFavorites.length);
  t.ok(favBefore >= 1 && favAfter === favBefore - 1, 'a favourite colour can be removed with its own button', `${favBefore} -> ${favAfter}`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Paint tab: a floor area becomes a zone (tile units) and is saved; the eraser cuts it.
  await page.click('.catalog-tabs button[data-pane=floor]');
  await page.click('.vo-paint-grid .vo-paint-swatch:nth-child(2)'); // Wood: starts painting areas
  const z0 = await toScreen(page, 11 * 40 + 10, 12 * 40 + 10), z1 = await toScreen(page, 14 * 40 + 10, 14 * 40 + 10);
  await page.mouse.move(z0.x, z0.y); await page.mouse.down();
  await page.mouse.move(z1.x, z1.y, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(700);
  const zones = await page.evaluate(() => officeConfig.floor.zones);
  const lastSaved = JSON.parse(saves[saves.length - 1].body).floor;
  t.ok(zones && zones.length === 1 && JSON.stringify([zones[0].x, zones[0].y, zones[0].w, zones[0].h]) === '[11,12,4,3]' && zones[0].style === 'wood' && lastSaved.zones && lastSaved.zones.length === 1,
    'dragging with a floor preset paints a saved zone in tile units', JSON.stringify(zones));
  await page.click('#vo-floor-erase-btn');
  const e0 = await toScreen(page, 12 * 40 + 10, 13 * 40 + 10);
  await page.mouse.click(e0.x, e0.y); await page.mouse.click(e0.x, e0.y);
  await page.waitForTimeout(80);
  const cut = await page.evaluate(() => officeConfig.floor.zones.map(z => z.w * z.h).reduce((a, b) => a + b, 0));
  t.ok(cut === 11, 'the eraser cuts one tile out of the zone', String(cut));

  // Wall paint bucket.
  await page.click('.vo-paint-grid--walls .vo-paint-swatch:nth-child(3)'); // Sage
  const w0 = await toScreen(page, 20 * 40, 14 * 40);
  await page.mouse.click(w0.x, w0.y);
  const wall = await page.evaluate(() => officeConfig.walls.interior[0].color);
  t.ok(wall === '#7d8f7a', 'the paint roller paints the clicked wall', wall);
  await page.keyboard.press('Escape');
  const painting = await page.evaluate(() => _wallPaint.active || _floorPaint.active);
  t.ok(!painting, 'Esc puts the paint tools away');
  await page.click('.catalog-tabs button[data-pane=objects]');

  // Snap toggle, select area, shortcut card.
  await page.click('.vo-ed-snap-opt[data-snap=half]');
  const snap = await page.evaluate(() => [editSnapMode, localStorage.getItem('vo-editor-snap')]);
  await page.click('.vo-ed-snap-opt[data-snap=tile]');
  t.ok(snap[0] === 'half' && snap[1] === 'half', 'snap toggle switches and is remembered', JSON.stringify(snap));
  await page.click('#btn-select-area');
  const m0 = await toScreen(page, 520, 180), m1 = await toScreen(page, 800, 330);
  await page.mouse.move(m0.x, m0.y); await page.mouse.down(); await page.mouse.move(m1.x, m1.y, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(100);
  const area = await page.evaluate(() => _multiSelected.length);
  t.ok(area >= 3, 'Select area button + drag selects the items in the box', String(area));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+?');
  const card = await page.evaluate(() => { const c = document.getElementById('vo-editor-keys'); return c && !c.hidden ? c.querySelectorAll('dt').length : 0; });
  await page.keyboard.press('Escape');
  const cardClosed = await page.evaluate(() => document.getElementById('vo-editor-keys').hidden && editMode);
  t.ok(card >= 10 && cardClosed, 'the ? card lists the shortcuts and Esc closes only the card', String(card));

  t.ok(errors.length === 0, 'no page errors (desktop)', errors.join(' | ').slice(0, 300));

  // Phone: tabs fit, the action bar is the sheet footer, the sheet folds while placing.
  const phone = await openEditor(browser, { width: 412, height: 915, mobile: true });
  const pg = phone.page;
  await pg.waitForTimeout(500);
  const layout = await pg.evaluate(() => {
    const tabs = document.querySelector('.catalog-tabs');
    const sheet = document.getElementById('furniture-catalog').getBoundingClientRect();
    const bar = document.querySelector('.ui-edit-toolbar').getBoundingClientRect();
    return { tabsFit: tabs.scrollWidth <= tabs.clientWidth + 1, sheetBottom: Math.round(sheet.bottom), barTop: Math.round(bar.top), barRight: Math.round(bar.right), vw: innerWidth,
      barFits: document.querySelector('.ui-edit-toolbar').scrollWidth <= document.querySelector('.ui-edit-toolbar').clientWidth + 1 };
  });
  t.ok(layout.tabsFit && layout.sheetBottom <= layout.barTop + 1 && layout.barFits, 'phone: tabs fit, the action bar sits under the sheet and fits', JSON.stringify(layout));
  // v0.13 mobileui: the catalog sheet stays open while placing (the office is framed above it) and the
  // placing bar rides on top of it; only a full-height sheet folds into the peek bar.
  await pg.click('.catalog-item[data-type=plant]');
  await pg.waitForTimeout(350);
  const open = await pg.evaluate(() => { const s = document.getElementById('furniture-catalog'), b = document.getElementById('vo-editor-status');
    return { sheet: getComputedStyle(s).visibility, sheetTop: Math.round(s.getBoundingClientRect().top), barBottom: Math.round(b.getBoundingClientRect().bottom), bar: b.innerText }; });
  t.ok(open.sheet === 'visible' && open.barBottom <= open.sheetTop + 1 && /Tap the floor/.test(open.bar) && /Done placing/.test(open.bar), 'phone: placing keeps the half sheet open, the peek bar with touch words and a Done button sits on it', JSON.stringify(open));
  await pg.click('#vo-editor-status .vo-es-actions button');
  await pg.waitForTimeout(300);
  await pg.focus('[data-vo-edsheet-grab]');
  await pg.keyboard.press('ArrowUp');
  await pg.waitForTimeout(350);
  await pg.click('.catalog-item[data-type=plant]');
  await pg.waitForTimeout(350);
  const peek = await pg.evaluate(() => ({ full: document.body.classList.contains('vo-edsheet-full'), sheet: getComputedStyle(document.getElementById('furniture-catalog')).visibility, bar: document.getElementById('vo-editor-status').innerText }));
  t.ok(peek.full && peek.sheet === 'hidden' && /Tap the floor/.test(peek.bar) && /Done placing/.test(peek.bar), 'phone: a full-height sheet folds into a peek bar with touch words and a Done button', JSON.stringify(peek));
  await pg.click('#vo-editor-status .vo-es-actions button');
  await pg.waitForTimeout(300);
  const back = await pg.evaluate(() => ({ placing: placingType, sheet: getComputedStyle(document.getElementById('furniture-catalog')).visibility }));
  t.ok(!back.placing && back.sheet === 'visible', 'phone: Done placing brings the sheet back', JSON.stringify(back));
  await pg.evaluate(() => { try { localStorage.removeItem('vo-edit-sheet'); } catch (e) {} });
  const tips = await pg.evaluate(() => document.querySelector('#catalog-instr').textContent);
  t.ok(/Tap/.test(tips) && !/Right-click|Esc /.test(tips), 'phone: tips use touch words', tips.slice(0, 80));
  t.ok(phone.errors.length === 0, 'no page errors (phone)', phone.errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
t.done();
