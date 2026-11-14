// v0.13 Edit office performance (review: "when i open the edit office it slows down the whole page while the objects
// seem to load on the edit panel"), at 1600x900 and on a 412 px phone (touch):
//  1. a still editor draws from a cached static layer: no whole-office redraw per frame, no forced full frame rate;
//  2. every edit still shows on the next frame: delete + undo (pixel-identical back), a mouse drag (the dragged piece
//     live over a cached layer, no whole redraw per frame), the selected wall;
//  3. opening the editor measures the panel after the toggle (no layout read inside the click) and the editing style
//     does not restyle the whole page (the map-control gap variable is set on its readers, not on <body>);
//  4. catalog previews are canvases from a cache (no PNG data URLs), drawn when they come into view, at most 6 per
//     slice; a closed variants list draws nothing until it opens; a reopened list redraws nothing; tiles keep their size.
// Fails on e5237e5 (whole redraw each frame, busy at 60 fps, <img> data URLs, all thumbnails at once, insets read
// inside the toggle, --vo-mapctl-b on body). Run: node tests/test_v13_editorperf.mjs
import { launch, openEditor, toScreen, makeChecker } from './test_v10_editor_lib.mjs';

const NAME = 'test_v13_editorperf';
const browser = await launch(NAME);
const t = makeChecker(NAME);
const raf = (page, n = 2) => page.evaluate((n) => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

// Instruments installed before edit mode opens: thumbnail draws per idle/timer slice, layout reads inside the toggle.
async function instrument(page) {
  await page.evaluate(() => {
    window.__slice = 0; window.__sliceN = {}; window.__thumbDraws = 0;
    let sid = 0;
    const wrap = (cb) => function () { const prev = window.__slice; window.__slice = ++sid; try { return cb.apply(this, arguments); } finally { window.__slice = prev; } };
    const ric = window.requestIdleCallback;
    if (ric) window.requestIdleCallback = (cb, o) => ric.call(window, wrap(cb), o);
    const st = window.setTimeout;
    window.setTimeout = function (cb, ms, ...a) { return st.call(window, typeof cb === 'function' ? wrap(cb) : cb, ms, ...a); };
    const dfi = window.drawFurnitureItem;
    window.drawFurnitureItem = function (item) {
      if (item && item.id === '__thumb') { window.__thumbDraws++; const k = window.__slice || 'sync'; window.__sliceN[k] = (window.__sliceN[k] || 0) + 1; }
      return dfi.apply(this, arguments);
    };
    window.__inToggle = false; window.__canvasReads = 0;
    const gb = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { if (window.__inToggle && this.id === 'officeCanvas') window.__canvasReads++; return gb.call(this); };
  });
}
async function openWatched(page) {
  return page.evaluate(() => { window.__inToggle = true; try { toggleEditMode(); } finally { window.__inToggle = false; } return { edit: editMode, reads: window.__canvasReads }; });
}
// Environment passes over `ms` of a still editor.
async function stillEditor(page, ms) {
  return page.evaluate(async (ms) => {
    const orig = window.drawEnvironment, modes = {};
    window.drawEnvironment = function (m) { modes[m || 'all'] = (modes[m || 'all'] || 0) + 1; return orig.apply(this, arguments); };
    const d0 = __voStats.draws;
    await new Promise(r => setTimeout(r, ms));
    window.drawEnvironment = orig;
    return { modes, frames: __voStats.draws - d0, busy: _sceneIsBusy() };
  }, ms);
}
// A checksum of the canvas pixels around a world point.
async function region(page, wx, wy, half = 14) {
  const p = await toScreen(page, wx, wy);
  return page.evaluate(([x, y, h]) => {
    const c = document.getElementById('officeCanvas'), r = c.getBoundingClientRect(), s = c.width / r.width;
    const d = c.getContext('2d').getImageData(Math.round((x - r.left) * s) - h, Math.round((y - r.top) * s) - h, 2 * h, 2 * h).data;
    let sum = 0, yellow = 0; for (let i = 0; i < d.length; i += 4) { sum = (sum * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2]) % 1000000007; if (d[i] > 200 && d[i + 1] > 170 && d[i + 2] < 90) yellow++; }
    return { sum, yellow };
  }, [p.x, p.y, half]);
}

async function run(label, opts) {
  const phone = !!opts.mobile;
  const { page, errors, context } = await openEditor(browser, Object.assign({ edit: false }, opts));
  await instrument(page);
  const open = await openWatched(page);
  t.ok(open.edit && open.reads === 0, label + ': the toggle does not read the layout (the panel is measured after it)', JSON.stringify(open));
  await page.waitForTimeout(phone ? 1800 : 1200);
  await page.mouse.move(2, 2);

  // 1. still editor
  const still = await stillEditor(page, 1000);
  t.ok(!still.modes.all && (still.modes.static || 0) <= 1 && still.modes.dynamic >= 5, label + ': a still editor draws the cached layer + live parts, not the whole office', JSON.stringify(still));
  t.ok(!still.busy && still.frames <= 45, label + ': a still editor is not forced to full frame rate', JSON.stringify(still));

  // 3b. the editing style is set on its readers, not on <body>
  const vars = await page.evaluate(() => ({ body: getComputedStyle(document.body).getPropertyValue('--vo-mapctl-b').trim(),
    ctl: (document.querySelector('.vo-mapctl') && getComputedStyle(document.querySelector('.vo-mapctl')).getPropertyValue('--vo-mapctl-b').trim()) || '' }));

  // 4. catalog previews
  const cat = await page.evaluate(() => {
    const icons = [...document.querySelectorAll('#furniture-catalog .catalog-icon')];
    const imgs = [...document.querySelectorAll('#furniture-catalog .catalog-icon img')].filter(i => /^data:/.test(i.src)).length;
    // in view: inside the window and every scrolling box around it
    const visible = icons.filter(h => { const r = h.getBoundingClientRect(); if (!h.offsetParent || !(r.width > 0) || r.bottom <= 0 || r.top >= innerHeight) return false;
      for (let p = h.parentElement; p && p !== document.body; p = p.parentElement) { const cs = getComputedStyle(p);
        if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) { const q = p.getBoundingClientRect(); if (r.bottom <= q.top || r.top >= q.bottom || r.right <= q.left || r.left >= q.right) return false; } }
      return true; });
    const drawn = icons.filter(h => h.querySelector('canvas:not([data-pending])'));
    const sizes = new Set(icons.filter(h => h.offsetParent && h.closest('.catalog-item:not(.catalog-variant)')).map(h => { const r = h.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); }));
    return { icons: icons.length, imgs, drawn: drawn.length, pending: icons.length - drawn.length, sizes: [...sizes], maxSlice: Math.max(0, ...Object.values(window.__sliceN)), sync: window.__sliceN.sync || 0,
      visibleDrawn: visible.filter(h => h.querySelector('canvas:not([data-pending])')).length, visible: visible.length };
  });
  t.ok(cat.imgs === 0 && cat.drawn > 0, label + ': previews are canvases from the cache (no PNG data URLs)', JSON.stringify(cat));
  t.ok(cat.visible > 0 && cat.visibleDrawn >= cat.visible - 1, label + ': every preview in view is drawn', JSON.stringify(cat));
  t.ok(cat.maxSlice <= 6 && cat.sync === 0, label + ': previews are drawn at most 6 per slice, none inside the click', JSON.stringify(cat));
  if (phone) t.ok(cat.pending > 0, label + ': previews out of view wait until they come into view', JSON.stringify(cat));
  t.ok(cat.sizes.length === 1, label + ': every tile keeps one size (no reflow when previews arrive)', JSON.stringify(cat.sizes));
  // scrolled into view: drawn
  const scrolled = await page.evaluate(async () => {
    const icons = [...document.querySelectorAll('#furniture-catalog .catalog-item:not(.catalog-variant) .catalog-icon')].filter(h => h.offsetParent);
    const last = icons[icons.length - 1]; last.scrollIntoView({ block: 'center' });
    for (let i = 0; i < 60 && !last.querySelector('canvas:not([data-pending])'); i++) await new Promise(r => setTimeout(r, 50));
    return { drawn: !!last.querySelector('canvas:not([data-pending])'), type: last.closest('[data-type]').dataset.type };
  });
  t.ok(scrolled.drawn, label + ': a preview scrolled into view is drawn', JSON.stringify(scrolled));
  // a closed variants list draws nothing; opened: its cards are drawn; reopened: nothing redrawn
  const v0 = await page.evaluate(() => ({ cards: document.querySelectorAll('#catalog-variants-desk canvas').length, draws: window.__thumbDraws }));
  await page.locator('.catalog-item[data-type=desk] .catalog-variant-toggle').scrollIntoViewIfNeeded();
  await page.click('.catalog-item[data-type=desk] .catalog-variant-toggle');
  const v1 = await page.evaluate(async () => {
    const list = document.getElementById('catalog-variants-desk');
    const first = list.querySelector('.catalog-variant .catalog-icon canvas');
    for (let i = 0; i < 60 && first && first.dataset.pending; i++) await new Promise(r => setTimeout(r, 50));
    const c = first; let px = 0;
    if (c) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) px++; }
    return { cards: list.querySelectorAll('.catalog-variant').length, firstDrawn: !!(c && !c.dataset.pending), px, draws: window.__thumbDraws };
  });
  t.ok(v0.cards === 0 && v1.cards >= 2 && v1.firstDrawn && v1.px > 200, label + ': a variants list draws its previews when it opens', JSON.stringify({ v0, v1 }));
  await page.click('.catalog-item[data-type=desk] .catalog-variant-toggle');
  await page.click('.catalog-item[data-type=desk] .catalog-variant-toggle');
  await page.waitForTimeout(400);
  const v2 = await page.evaluate(() => ({ draws: window.__thumbDraws, same: VOEditor.thumbCanvas && VOEditor.thumbCanvas('plant', 44) === VOEditor.thumbCanvas('plant', 44) }));
  t.ok(v2.draws === v1.draws && v2.same, label + ': a reopened list and a cached preview draw nothing again', JSON.stringify({ v1: v1.draws, v2 }));
  await page.click('.catalog-item[data-type=desk] .catalog-variant-toggle');

  // 2. edits show on the next frame
  if (!phone) {
    await page.evaluate(() => { camera.x = 0; camera.y = 0; }); await raf(page, 3);
    const before = await region(page, 920, 440);
    await page.evaluate(() => { selectedItemId = 'p1'; _deleteSelectedItem(); });
    await raf(page, 2);
    const gone = await region(page, 920, 440);
    await page.evaluate(() => undoEdit());
    await raf(page, 2);
    const back = await region(page, 920, 440);
    t.ok(gone.sum !== before.sum && back.sum === before.sum, label + ': delete and undo show on the next frame (pixel-identical back)', JSON.stringify({ before, gone, back }));
    // a mouse drag of the couch
    const cOld = await region(page, 680, 580, 10), cNew0 = await region(page, 680, 700, 10);
    const a = await toScreen(page, 680, 580), b = await toScreen(page, 680, 700);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.evaluate(() => { const o = window.drawEnvironment; window.__envModes = {}; window.__envOrig = o;
      window.drawEnvironment = function (m) { window.__envModes[m || 'all'] = (window.__envModes[m || 'all'] || 0) + 1; return o.apply(this, arguments); }; });
    await page.mouse.move(a.x, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 });
    await raf(page, 2);
    const mid = await page.evaluate(() => { const c = officeConfig.furniture.find(f => f.id === 'c1'); window.drawEnvironment = window.__envOrig;
      return { y: c.y, dragging: isDragging, modes: window.__envModes }; });
    t.ok(!mid.modes.all && (mid.modes.static || 0) <= 1 && mid.modes.dynamic >= 3, label + ': a drag draws the dragged piece live, not the whole office each frame', JSON.stringify(mid.modes));
    const cNew1 = await region(page, 680, 700, 10);
    await page.mouse.up(); await raf(page, 2);
    t.ok(mid.dragging && mid.y > 600 && cNew1.sum !== cNew0.sum, label + ': a dragged couch is drawn where it is while dragging', JSON.stringify({ mid, cNew0, cNew1 }));
    await page.evaluate(() => undoEdit()); await raf(page, 2);
    const cBack = await region(page, 680, 580, 10);
    t.ok(cBack.sum === cOld.sum, label + ': undo puts the couch back (pixel-identical)', JSON.stringify({ cOld, cBack }));
    // the selected wall turns yellow at once and back
    const w0 = await region(page, 800, 520, 6);
    await page.evaluate(() => { selectedWallIdx = 0; }); await raf(page, 2);
    const w1 = await region(page, 800, 520, 6);
    await page.evaluate(() => { selectedWallIdx = null; }); await raf(page, 2);
    const w2 = await region(page, 800, 520, 6);
    t.ok(w1.yellow > 10 && w0.yellow === 0 && w2.sum === w0.sum, label + ': a selected wall shows yellow on the next frame, then its own colour', JSON.stringify({ w0, w1, w2 }));
  }

  // 3b. leave edit mode: the map control's gap changes back; <body> never carried it
  await page.evaluate(() => { if (editMode) toggleEditMode(); }); await page.waitForTimeout(300);
  const varsOff = await page.evaluate(() => ({ body: getComputedStyle(document.body).getPropertyValue('--vo-mapctl-b').trim(),
    ctl: (document.querySelector('.vo-mapctl') && getComputedStyle(document.querySelector('.vo-mapctl')).getPropertyValue('--vo-mapctl-b').trim()) || '' }));
  t.ok(vars.body === varsOff.body && vars.ctl !== varsOff.ctl, label + ': the editing gap is set on the map control, not on <body> (no whole-page restyle)', JSON.stringify({ vars, varsOff }));
  t.ok(!errors.length, label + ': no page errors', errors.slice(0, 3).join(' | '));
  await context.close();
}

try {
  await run('desktop', {});
  await run('phone', { mobile: true, width: 412, height: 915 });
} finally { await browser.close(); }
t.done();
