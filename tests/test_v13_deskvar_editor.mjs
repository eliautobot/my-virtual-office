// v0.13 desk variants in the office editor, end to end, at 1600x900 and on a 412 px phone (touch):
//  1. the objects menu's desk and boss desk tiles show the number of types and an arrow; the arrow opens the
//     types under the tile: a preview, the name, the facts (footprint in tiles, screens, seated/standing), the
//     one-line info and the colour dots, all inside the screen;
//  2. a type's card places that type (the ghost, then a click/tap on the floor), saved with its variant;
//  3. a selected desk has a Variants button: its dropdown lists the types (the current one ticked) and the
//     colours; a type switches the desk in place (same spot and rotation); a type that does not fit there is
//     refused (the collision check of a move); a colour recolours it;
//  4. undo and redo step back and forth through the colour and the type, one step each.
// Fails on 0.12 (no count badge, no Variants button). Run: node tests/test_v13_deskvar_editor.mjs
import { launch, openEditor, toScreen, makeChecker, officeFixture } from './test_v10_editor_lib.mjs';

const NAME = 'test_v13_deskvar_editor';
const browser = await launch(NAME);
const t = makeChecker(NAME);

async function run(label, opts) {
  const office = officeFixture();
  office.furniture.push({ id: 'b1', type: 'bossDesk', x: 300, y: 250 });
  office.furniture.push({ id: 'p2', type: 'plant', x: 0, y: 0 });   // moved next to d1 below (fits classic, not analyst)
  const { page, saves, errors, context } = await openEditor(browser, Object.assign({ office }, opts));
  const phone = !!opts.mobile;
  await page.waitForTimeout(500);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  let lastAt = null;
  const tap = async (w) => { const p = await toScreen(page, w.x, w.y);
    lastAt = await ev((p) => { const e = document.elementFromPoint(p.x, p.y); return [Math.round(p.x), Math.round(p.y), e && (e.id || e.className)].join(' '); }, p);
    if (phone) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); await page.waitForTimeout(250); };

  // 1. catalog tiles: count + arrow, the types under the tile
  for (const type of ['desk', 'bossDesk']) {
    const tile = await ev((type) => { const el = document.querySelector('.catalog-item[data-type=' + type + ']'), tg = el && el.querySelector('.catalog-variant-toggle');
      return { n: FURNITURE_VARIANTS[type].length, count: tg && tg.querySelector('.catalog-variant-count').textContent, arrow: !!(tg && tg.querySelector('.vo-chev')),
        hidden: document.getElementById('catalog-variants-' + type).hidden }; }, type);
    t.ok(tile.n >= 2 && tile.count === String(tile.n) && tile.arrow && tile.hidden, label + ': ' + type + ' tile shows ' + tile.n + ' types and an arrow (closed)', JSON.stringify(tile));
    await page.locator('.catalog-item[data-type=' + type + '] .catalog-variant-toggle').scrollIntoViewIfNeeded();
    await page.click('.catalog-item[data-type=' + type + '] .catalog-variant-toggle');
    await page.waitForTimeout(500);
    const open = await ev((type) => {
      const list = document.getElementById('catalog-variants-' + type), rows = FURNITURE_VARIANTS[type];
      const cards = [...list.querySelectorAll('.catalog-variant')];
      return { expanded: document.querySelector('.catalog-item[data-type=' + type + '] .catalog-variant-toggle').getAttribute('aria-expanded'),
        shown: !list.hidden && list.getBoundingClientRect().height > 0, n: cards.length, want: rows.length, vw: innerWidth,
        bad: cards.map((c, i) => { const r = c.getBoundingClientRect(), th = c.querySelector('.catalog-icon canvas, .catalog-icon img'), row = rows[i];
          const facts = c.querySelector('.catalog-variant-facts').textContent, dots = c.querySelectorAll('.vo-var-swatch').length;
          const why = [];
          if (c.dataset.type !== row.key) why.push('key');
          if (!th || !(th.width > 0)) why.push('preview');
          if (!/^\d+(\.\d)? × \d+(\.\d)? tiles · \d+ screens? · (seated|standing)$/.test(facts)) why.push('facts ' + facts);
          if ((row.seat === 'stand') !== /standing/.test(facts)) why.push('seat');
          if (dots !== Math.min(8, row.colors.length)) why.push('colours ' + dots);
          if (!c.querySelector('.catalog-variant-info').textContent) why.push('info');
          if (r.width < 40 || r.right > innerWidth + 1 || r.left < -1) why.push('box ' + Math.round(r.left) + '..' + Math.round(r.right));
          return why.length ? row.id + ': ' + why.join(',') : null; }).filter(Boolean) };
    }, type);
    t.ok(open.expanded === 'true' && open.shown && open.n === open.want && !open.bad.length, label + ': the arrow opens the ' + type + ' types (preview, facts, info, colours, on screen)', JSON.stringify(open).slice(0, 400));
  }
  // the thumbnails are not blank (the variant art, not a plain box)
  // (v0.13: canvas tiles, drawn as they come into view: each card is scrolled into view and its tile read)
  const thumbs = await ev(async () => { const out = []; for (const im of document.querySelectorAll('#catalog-variants-desk .catalog-icon canvas')) {
    im.scrollIntoView({ block: 'nearest' }); for (let i = 0; i < 60 && im.dataset.pending; i++) await new Promise(r => setTimeout(r, 50)); out.push(await (async () => {
    const c = im; const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0, cols = new Set();
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { n++; cols.add(d[i] >> 4 << 8 | d[i + 1] >> 4 << 4 | d[i + 2] >> 4); } return n > 200 && cols.size > 6 ? 1 : 0; })()); } return out; });
  t.ok(thumbs.length >= 2 && thumbs.every(Boolean), label + ': every desk type preview is drawn', JSON.stringify(thumbs));

  // the cards are buttons for the keyboard: Enter on a card starts placing that type
  if (!phone) {
    await page.focus('.catalog-variant[data-type="bossDesk~command"]'); await page.keyboard.press('Enter'); await page.waitForTimeout(250);
    const kb = await ev(() => ({ placing: placingType, roles: [...document.querySelectorAll('.catalog-variant')].every(c => c.getAttribute('role') === 'button' && c.tabIndex === 0 && /^Place /.test(c.getAttribute('aria-label') || '')) }));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    t.ok(kb.placing === 'bossDesk~command' && kb.roles, label + ': the type cards are buttons (Enter places)', JSON.stringify(kb));
  }

  // 2. place a variant from its card
  await page.locator('.catalog-variant[data-type="desk~gamer"]').scrollIntoViewIfNeeded();
  await page.click('.catalog-variant[data-type="desk~gamer"]');
  await page.waitForTimeout(400);
  const placing = await ev(() => placingType);
  // a free floor spot for the type that is on the screen (the phone shows a part of the office)
  const findFree = (key, skip) => ev(({ key, skip }) => {
    const c = document.getElementById('officeCanvas'), r = c.getBoundingClientRect(), hit = (x, y) => document.elementFromPoint(x, y) === c;
    for (let sy = r.top + r.height * 0.3; sy < r.bottom - 70; sy += 16) for (let sx = r.left + 70; sx < r.right - 70; sx += 16) {
      if (!hit(sx, sy) || !hit(sx - 60, sy - 50) || !hit(sx + 60, sy - 50) || !hit(sx, sy + 20)) continue;
      const w = screenToWorld(sx, sy), x = Math.round(w.x), y = Math.round(w.y);
      if (!_placementProblem(key, x, y, 0, skip || [], 2) && !_placementProblem(key, x, y, 90, skip || [], 2)) return { x, y };
    }
    return null; }, { key, skip });
  const spot = (await findFree('desk~analyst')) || { x: 200, y: 520 };
  const free = await ev((s) => !_placementProblem('desk~gamer', s.x, s.y, 0, [], 2), spot);
  const before = await ev(() => officeConfig.furniture.length);
  await tap(spot);
  await page.waitForTimeout(400);
  const placed = await ev((n) => { const f = officeConfig.furniture.slice(n).find(x => x.type === 'desk'); return f ? { id: f.id, v: f.variant, x: f.x, y: f.y, key: _mk(f) } : null; }, before);
  if (phone) await page.locator('#vo-editor-status .vo-es-actions button', { hasText: 'Done placing' }).click({ timeout: 5000 }).catch(() => {});
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(1300);
  const stillPlacing = await ev(() => placingType);
  const saved = saves.length && JSON.parse(saves[saves.length - 1].body).furniture.find(x => placed && x.id === placed.id);
  t.ok(placing === 'desk~gamer' && !stillPlacing && free && placed && placed.v === 'gamer' && placed.key === 'desk~gamer' && saved && saved.variant === 'gamer',
    label + ': a type card places that type (saved with its variant)', JSON.stringify({ placing, stillPlacing, lastAt, free, placed, saved: saved && saved.variant }));

  // 3. select it, Variants dropdown, switch in place (turned 90 first), colour
  const g = placed || { x: spot.x, y: spot.y, id: '?' };
  await tap({ x: g.x, y: g.y - 12 });
  let sel = await ev(() => ({ id: selectedItemId, btn: (() => { const b = document.getElementById('ftb-variant-btn'); return !!b && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0; })() }));
  await page.click('#ftb-rotate-btn'); await page.waitForTimeout(300);
  await page.click('#ftb-variant-btn'); await page.waitForTimeout(400);
  const menu = await ev(() => { const m = document.getElementById('variant-menu'); if (!m) return null; const r = m.getBoundingClientRect();
    return { opts: m.querySelectorAll('.vo-variant-opt').length, cur: (m.querySelector('.vo-variant-opt[aria-checked=true]') || {}).dataset?.key, colors: m.querySelectorAll('.vo-variant-color').length,
      inView: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1, want: FURNITURE_VARIANTS.desk.length, wc: _variantRow('desk~gamer').colors.length }; });
  t.ok(sel.id === g.id && sel.btn && menu && menu.opts === menu.want && menu.cur === 'desk~gamer' && menu.colors === menu.wc && menu.inView,
    label + ': a selected desk has a Variants button; its dropdown lists the types (current ticked) and colours, on screen', JSON.stringify({ sel, menu }));
  const pre = await ev((id) => { const f = officeConfig.furniture.find(x => x.id === id); return { x: f.x, y: f.y, r: f.rotation || 0 }; }, g.id);
  const fits = await ev((p) => !_placementProblem('desk~analyst', p.x, p.y, p.r, [p.id], 2), Object.assign({ id: g.id }, pre));
  await page.click('#variant-menu .vo-variant-opt[data-key="desk~analyst"]'); await page.waitForTimeout(400);
  const sw = await ev((id) => { const f = officeConfig.furniture.find(x => x.id === id); const m = document.getElementById('variant-menu');
    return { v: f.variant, x: f.x, y: f.y, r: f.rotation || 0, cur: m && (m.querySelector('.vo-variant-opt[aria-checked=true]') || {}).dataset?.key }; }, g.id);
  t.ok(fits && sw.v === 'analyst' && sw.x === pre.x && sw.y === pre.y && sw.r === pre.r && pre.r === 90 && sw.cur === 'desk~analyst',
    label + ': a type switches the desk in place (same spot, rotation 90 kept)', JSON.stringify({ fits, pre, sw }));
  await page.click('#variant-menu .vo-variant-color[data-color="black"]'); await page.waitForTimeout(400);
  const col = await ev((id) => { const f = officeConfig.furniture.find(x => x.id === id); return { c: f.color, item: _itemColor(f).id, cur: (document.querySelector('#variant-menu .vo-variant-color[aria-checked=true]') || {}).dataset?.color }; }, g.id);
  t.ok(col.c === 'black' && col.item === 'black' && col.cur === 'black', label + ': a colour recolours it', JSON.stringify(col));
  await page.waitForTimeout(1300);
  const sv = saves.length && JSON.parse(saves[saves.length - 1].body).furniture.find(x => x.id === g.id);
  t.ok(sv && sv.variant === 'analyst' && sv.color === 'black' && sv.rotation === 90, label + ': the switch and the colour are saved', JSON.stringify(sv));

  // 4. undo / redo (the buttons): colour, type, then forward again
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  const st = () => ev((id) => { const f = officeConfig.furniture.find(x => x.id === id); return f ? (f.variant || 'classic') + '/' + (f.color || '-') + '/' + (f.rotation || 0) : 'gone'; }, g.id);
  const seq = [await st()];
  for (const b of ['#btn-undo-edit', '#btn-undo-edit', '#btn-redo-edit', '#btn-redo-edit']) { await ev((b) => document.querySelector(b).click(), b); await page.waitForTimeout(250); seq.push(await st()); }
  t.ok(seq.join(' ') === 'analyst/black/90 analyst/-/90 gamer/-/90 analyst/-/90 analyst/black/90', label + ': undo/redo step through the colour and the type', seq.join(' '));

  // 3b. a type that does not fit is refused: d1 (classic) with a plant just right of its footprint
  const room = await findFree('bossDesk~command', ['d1', 'p2']);   // d1 moved where it is on the screen, with room around
  const set = await ev((room) => { const d = officeConfig.furniture.find(x => x.id === 'd1'), p = officeConfig.furniture.find(x => x.id === 'p2');
    if (room) { d.x = room.x; d.y = room.y; _syncAllDeskAssignments(); }
    const fr = _itemFootprints(d).reduce((a, r) => Math.max(a, r.x + r.w), -1e9);
    p.x = fr + 2; p.y = d.y - 40; _worldChanged(); buildCollisionGrid(); _invalidateStaticLayer();
    return { room: !!room, classic: !_placementProblem('desk', d.x, d.y, 0, ['d1'], 2), analyst: _placementProblem('desk~analyst', d.x, d.y, 0, ['d1'], 2) }; }, room);
  const d1 = await ev(() => { const d = officeConfig.furniture.find(x => x.id === 'd1'); return { x: d.x, y: d.y }; });
  await tap({ x: d1.x, y: d1.y - 12 });
  await page.click('#ftb-variant-btn'); await page.waitForTimeout(300);
  await page.click('#variant-menu .vo-variant-opt[data-key="desk~analyst"]'); await page.waitForTimeout(300);
  const ref = await ev(() => { const d = officeConfig.furniture.find(x => x.id === 'd1'); return { v: d.variant || 'classic', sel: selectedItemId, undo: _undoStack.length }; });
  t.ok(set.classic && !!set.analyst && ref.v === 'classic' && ref.sel === 'd1', label + ': a type with no room there is refused (the move rule)', JSON.stringify({ set, ref }));

  t.ok(errors.length === 0, label + ': no page errors', errors.join(' | ').slice(0, 300));
  await context.close();
}

try {
  await run('desktop 1600', { width: 1600, height: 900 });
  await run('phone 412', { width: 412, height: 915, mobile: true });
} finally {
  await browser.close();
}
t.done();
