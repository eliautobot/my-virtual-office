// v0.13 mobileui (review 11-13): the compact layout (phones, tablets) gets an Edit office button in the action
// bar where Projects was (Projects moves into the More menu and still opens the projects window); the Edit
// office catalog is a bottom sheet with a drag handle (peek / half / full, remembered) and the office is
// framed in the part of the canvas above it; the More menu is a real bottom sheet (drag the handle to
// resize, swipe down to close) above the dashboard sheet; desktop keeps its dock and the More pane is never
// covered by the dashboard.
import { launch, openEditor, makeChecker } from './test_v10_editor_lib.mjs';

const NAME = 'test_v13_mobileui';
const browser = await launch(NAME);
const c = makeChecker(NAME);

const box = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height,
    vis: !e.closest('[hidden]') && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 };
}, sel);

async function dragBy(page, sel, dy) {
  const r = await box(page, sel);
  const vh = page.viewportSize().height;
  const x = r.l + r.w / 2, y = r.t + r.h / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x, Math.max(2, Math.min(vh - 2, y + dy * i / 10)));
  await page.mouse.up();
  await page.waitForTimeout(500);
}

// The office (world 0,0 .. W,H) on screen and the free canvas band above the sheet.
const framing = (page) => page.evaluate(() => {
  const cr = canvas.getBoundingClientRect(), a = _worldToCanvas(0, 0), b = _worldToCanvas(W, H);
  const sheet = document.getElementById('furniture-catalog').getBoundingClientRect();
  return { ot: cr.top + a.y, ob: cr.top + b.y, ol: cr.left + a.x, or: cr.left + b.x, top: cr.top, bottom: Math.min(cr.bottom, sheet.top), vw: innerWidth };
});
const framed = (f) => f.ot >= f.top - 2 && f.ob <= f.bottom + 2 && f.ol >= -2 && f.or <= f.vw + 2 &&
  ((f.or - f.ol) >= 0.6 * f.vw || (f.ob - f.ot) >= 0.6 * (f.bottom - f.top - 14));

// Every probe point along the More pane's edges hits the pane itself.
const moreUncovered = (page) => page.evaluate(() => {
  const m = document.getElementById('vo-more-menu'), r = m.getBoundingClientRect(), bad = [];
  for (let i = 1; i < 10; i++) for (const y of [r.bottom - 3, r.top + 3, (r.top + r.bottom) / 2]) {
    const x = r.left + r.width * i / 10, at = document.elementFromPoint(x, y);
    if (!at || !m.contains(at)) bad.push(Math.round(x) + ',' + Math.round(y) + ' ' + (at ? (at.id || String(at.className)).slice(0, 30) : 'none'));
  }
  return bad;
});

async function placedCount(page) { return page.evaluate(() => officeConfig.furniture.length); }

try {
  // ---------------- phones and the tablet ----------------
  for (const size of [{ width: 375, height: 667 }, { width: 412, height: 915 }, { width: 820, height: 1180 }]) {
    const tag = `${size.width}x${size.height}`;
    const e = await openEditor(browser, Object.assign({ mobile: true, edit: false }, size));
    const page = e.page;
    await page.evaluate(() => { try { localStorage.removeItem('vo-edit-sheet'); } catch (_) {} });
    await page.waitForTimeout(400);

    // 1. Edit office sits in the action bar where Projects was; Projects is in the More menu.
    const bar = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.vo-actionbar .vo-action')].filter(x => x.getBoundingClientRect().width > 0)
        .map(x => x.dataset.voAction || (x.hasAttribute('data-vo-chat-launch') ? 'chat' : '?'));
      const edit = document.querySelector('.vo-actionbar [data-vo-action="edit"]');
      const sp = edit && edit.querySelector('span'), br = edit && edit.getBoundingClientRect(), sr = sp && sp.getBoundingClientRect();
      return { items, label: edit ? (edit.getAttribute('aria-label') || edit.textContent).trim() : '', fits: !!sp && sp.scrollWidth <= sp.clientWidth + 1 && sr.left >= br.left - 1 && sr.right <= br.right + 1 };
    });
    c.ok(bar.items.join() === 'office,agents,chat,edit,more' && /Edit office/.test(bar.label) && bar.fits, `${tag}: the action bar is Office, Agents, Chat, Edit office, More`, JSON.stringify(bar));

    // 2. The More menu: a bottom sheet above the dashboard sheet, with a real handle.
    await page.click('.vo-actionbar [data-vo-action="more"]');
    await page.waitForTimeout(350);
    const m1 = await box(page, '#vo-more-menu');
    const grab = await page.evaluate(() => { const g = document.querySelector('#vo-more-menu [data-vo-more-grab]'); if (!g) return null; const r = g.getBoundingClientRect(); const sp = g.querySelector('span').getBoundingClientRect(); return { label: g.getAttribute('aria-label') || '', t: r.top, w: r.width, h: r.height, mid: Math.round(sp.left + sp.width / 2 - innerWidth / 2), at: (() => { const a = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!a && g.contains(a); })() }; });
    c.ok(m1 && m1.vis && Math.abs(m1.b - size.height) <= 1 && m1.l <= 1 && Math.abs(m1.r - size.width) <= 1, `${tag}: the More menu is a full-width bottom sheet`, JSON.stringify(m1));
    c.ok(grab && grab.label && grab.at && grab.t - m1.t < 24 && Math.abs(grab.mid) <= 4, `${tag}: the More sheet has a labelled, centred drag handle at its top`, JSON.stringify(grab));
    const covered = await moreUncovered(page);
    c.ok(covered.length === 0, `${tag}: nothing covers the More sheet (the dashboard sheet is under it)`, covered.slice(0, 4).join(' | '));
    const projects = await page.evaluate(() => { const it = [...document.querySelectorAll('#vo-more-menu .vo-menu-item')].find(x => /^\s*Projects\s*$/.test(x.textContent)); return it ? { vis: it.getBoundingClientRect().height > 0, role: it.getAttribute('role') } : null; });
    c.ok(projects && projects.vis && projects.role === 'menuitem', `${tag}: Projects is in the More menu`, JSON.stringify(projects));

    // Drag the handle up: the sheet grows and stays open; swipe it down: it closes and focus goes back.
    await dragBy(page, '#vo-more-menu [data-vo-more-grab]', -Math.round(size.height * 0.45));
    const m2 = await box(page, '#vo-more-menu');
    c.ok(m2 && m2.vis && m2.h > m1.h + 40 && Math.abs(m2.b - size.height) <= 1, `${tag}: dragging the More handle up makes the sheet taller`, JSON.stringify({ before: m1.h, after: m2 && m2.h }));
    await dragBy(page, '#vo-more-menu [data-vo-more-grab]', Math.round(size.height * 0.8));
    const closed = await page.evaluate(() => ({ hidden: document.getElementById('vo-more-menu').hidden, focus: document.activeElement && document.activeElement.dataset.voAction }));
    c.ok(closed.hidden && closed.focus === 'more', `${tag}: swiping the More sheet down closes it and focus returns to More`, JSON.stringify(closed));
    // It opens again at its own size; Escape closes it.
    await page.click('.vo-actionbar [data-vo-action="more"]');
    await page.waitForTimeout(350);
    const m3 = await box(page, '#vo-more-menu');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const esc = await page.evaluate(() => ({ hidden: document.getElementById('vo-more-menu').hidden, focus: document.activeElement && document.activeElement.dataset.voAction }));
    c.ok(m3 && Math.abs(m3.h - m1.h) <= 2 && esc.hidden && esc.focus === 'more', `${tag}: the More sheet reopens at its own size, Escape closes it`, JSON.stringify({ m1: m1.h, m3: m3 && m3.h, esc }));
    // Projects opens from the More menu, as from the old button.
    await page.click('.vo-actionbar [data-vo-action="more"]');
    await page.waitForTimeout(300);
    await page.evaluate(() => [...document.querySelectorAll('#vo-more-menu .vo-menu-item')].find(x => /^\s*Projects\s*$/.test(x.textContent)).click());
    await page.waitForTimeout(500);
    const pj = await page.evaluate(() => ({ open: !document.getElementById('projectsModal').classList.contains('hidden'), menu: document.getElementById('vo-more-menu').hidden }));
    c.ok(pj.open && pj.menu, `${tag}: Projects in the More menu opens the projects window`, JSON.stringify(pj));
    await page.evaluate(() => { if (typeof closeProjectsModal === 'function') closeProjectsModal(); });
    await page.waitForTimeout(300);

    // Themes: in the light theme the More sheet is light and its handle still shows.
    if (size.width === 412) {
      await page.click('.vo-actionbar [data-vo-action="more"]');
      await page.waitForTimeout(300);
      await page.click('#vo-more-menu [data-theme-mode="light"]');
      await page.waitForTimeout(300);
      if (await page.evaluate(() => document.getElementById('vo-more-menu').hidden)) { await page.click('.vo-actionbar [data-vo-action="more"]'); await page.waitForTimeout(300); }
      const light = await page.evaluate(() => {
        const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
        const menu = getComputedStyle(document.getElementById('vo-more-menu')).backgroundColor;
        const grab = getComputedStyle(document.querySelector('#vo-more-menu [data-vo-more-grab] span')).backgroundColor;
        return { menu: lum(menu), grab: lum(grab) };
      });
      c.ok(light.menu > 0.6 && Math.abs(light.menu - light.grab) > 0.12, `${tag}: light theme: the More sheet is light and its handle shows`, JSON.stringify(light));
      await page.click('#vo-more-menu [data-theme-mode="dark"]');
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await page.evaluate(() => { const m = document.getElementById('vo-more-menu'); if (!m.hidden) document.querySelector('.vo-actionbar [data-vo-action="more"]').click(); });
      await page.waitForTimeout(200);
    }

    // 3. Edit office from the action bar: a bottom sheet (half by default) with the office framed above it.
    await page.click('.vo-actionbar [data-vo-action="edit"]');
    await page.waitForTimeout(900);
    const ed = await page.evaluate(() => {
      const sheet = document.getElementById('furniture-catalog').getBoundingClientRect();
      const tb = document.querySelector('.ui-edit-toolbar').getBoundingClientRect();
      const g = document.querySelector('#furniture-catalog [data-vo-edsheet-grab]');
      const gr = g && g.getBoundingClientRect();
      return { editing: !!editMode, half: document.body.classList.contains('vo-edsheet-half'), sheetTop: sheet.top, sheetBottom: sheet.bottom, tbTop: tb.top,
        canvasTop: canvas.getBoundingClientRect().top, grab: g ? { label: g.getAttribute('aria-label') || '', expanded: g.getAttribute('aria-expanded'), t: gr.top - sheet.top, h: gr.height, mid: (() => { const sp = g.querySelector('span').getBoundingClientRect(); return Math.round(sp.left + sp.width / 2 - (sheet.left + sheet.width / 2)); })() } : null };
    });
    c.ok(ed.editing && ed.half && Math.abs(ed.sheetBottom - ed.tbTop) <= 2 && ed.sheetTop > ed.canvasTop + 150, `${tag}: Edit office opens the catalog as a half-height bottom sheet over the toolbar`, JSON.stringify(ed));
    c.ok(ed.grab && /catalog/i.test(ed.grab.label) && ed.grab.t <= 2 && ed.grab.h >= 10 && Math.abs(ed.grab.mid) <= 4, `${tag}: the Edit office sheet has a labelled, centred drag handle`, JSON.stringify(ed.grab));
    const f1 = await framing(page);
    c.ok(framed(f1), `${tag}: the office is framed in the canvas above the half sheet`, JSON.stringify(f1));

    // Drag the handle: full, then peek; the camera refits each time; the size is remembered.
    await dragBy(page, '#furniture-catalog [data-vo-edsheet-grab]', -Math.round(size.height * 0.5));
    const full = await page.evaluate(() => ({ full: document.body.classList.contains('vo-edsheet-full'), top: document.getElementById('furniture-catalog').getBoundingClientRect().top, bar: document.querySelector('.vo-topbar').getBoundingClientRect().bottom }));
    c.ok(full.full && full.top <= full.bar + 24, `${tag}: dragging the handle up snaps the sheet to full height`, JSON.stringify(full));
    await dragBy(page, '#furniture-catalog [data-vo-edsheet-grab]', Math.round(size.height * 0.9));
    await page.waitForTimeout(400);
    const peek = await page.evaluate(() => ({ peek: document.body.classList.contains('vo-edsheet-peek'), h: document.getElementById('furniture-catalog').getBoundingClientRect().height, saved: localStorage.getItem('vo-edit-sheet') }));
    const f2 = await framing(page);
    c.ok(peek.peek && peek.h <= 100 && peek.saved === 'peek', `${tag}: dragging it down snaps to the peek and is remembered`, JSON.stringify(peek));
    c.ok(framed(f2) && f2.bottom > f1.bottom + 100, `${tag}: the camera refits to the larger free area above the peek`, JSON.stringify({ f1, f2 }));
    await page.evaluate(() => { toggleEditMode(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { toggleEditMode(); });
    await page.waitForTimeout(700);
    const again = await page.evaluate(() => ({ peek: document.body.classList.contains('vo-edsheet-peek'), h: document.getElementById('furniture-catalog').getBoundingClientRect().height }));
    c.ok(again.peek && again.h <= 100, `${tag}: the sheet reopens at the remembered size`, JSON.stringify(again));
    // Keyboard / tap on the handle steps through the sizes like the dashboard's.
    await page.click('#furniture-catalog [data-vo-edsheet-grab]');
    await page.waitForTimeout(450);
    const tapped = await page.evaluate(() => document.body.classList.contains('vo-edsheet-half'));
    await page.focus('#furniture-catalog [data-vo-edsheet-grab]');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(300);
    const up = await page.evaluate(() => document.body.classList.contains('vo-edsheet-full'));
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(500);
    const down = await page.evaluate(() => document.body.classList.contains('vo-edsheet-half'));
    c.ok(tapped && up && down, `${tag}: a tap and the arrow keys on the handle step peek / half / full`, JSON.stringify({ tapped, up, down }));

    // 4. Work inside the sheet: tabs, tap-to-place with the sheet open, mouse drag from the catalog, undo.
    const tabs = await page.evaluate(async () => {
      const out = [];
      const sheet = document.getElementById('furniture-catalog');
      for (const b of [...document.querySelectorAll('#furniture-catalog .catalog-tabs button')]) {
        b.click();
        await new Promise(r => setTimeout(r, 150));
        const r = sheet.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height * 0.7);
        out.push(b.textContent.trim() + ':' + (!!at && sheet.contains(at)));
      }
      document.querySelector('#furniture-catalog .catalog-tabs button').click();
      return out;
    });
    c.ok(tabs.length >= 4 && tabs.every(t => /:true$/.test(t)), `${tag}: every catalog tab shows its pane inside the sheet`, tabs.join(' '));
    await page.waitForTimeout(250);
    const before = await placedCount(page);
    const sheetBefore = await box(page, '#furniture-catalog');
    await page.tap('#furniture-catalog .catalog-item[data-type=plant]');
    await page.waitForTimeout(400);
    const placing = await page.evaluate(() => {
      const s = document.getElementById('furniture-catalog'), r = s.getBoundingClientRect(), bar = document.getElementById('vo-editor-status');
      const br = bar && !bar.hidden ? bar.getBoundingClientRect() : null;
      return { type: placingType, vis: getComputedStyle(s).visibility, top: r.top, barBottom: br ? br.bottom : null, barTop: br ? br.top : null, words: bar ? bar.innerText : '' };
    });
    c.ok(placing.type === 'plant' && placing.vis === 'visible' && Math.abs(placing.top - sheetBefore.t) <= 2 && placing.barBottom !== null && placing.barBottom <= placing.top + 1 && /Tap the floor/.test(placing.words),
      `${tag}: picking an item keeps the sheet open, the placing bar sits above it`, JSON.stringify(placing));
    const fp = await framing(page);
    let placed = false;
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.4], [0.7, 0.6], [0.4, 0.7], [0.6, 0.3]]) {
      const x = fp.ol + (fp.or - fp.ol) * fx, y = fp.ot + (Math.min(fp.ob, placing.barTop - 4) - fp.ot) * fy;
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(250);
      if (await placedCount(page) > before) { placed = true; break; }
    }
    c.ok(placed, `${tag}: tap-to-place on the floor above the open sheet places the item`);
    await page.evaluate(() => { const b = document.querySelector('#vo-editor-status .vo-es-actions button'); if (b) b.click(); });
    await page.waitForTimeout(300);
    if (size.width === 412) {
      const n1 = await placedCount(page);
      const card = await box(page, '#furniture-catalog .catalog-item[data-type=plant]');
      const f3 = await framing(page);
      await page.mouse.move(card.l + card.w / 2, card.t + card.h / 2);
      await page.mouse.down();
      const tx = f3.ol + (f3.or - f3.ol) * 0.35, ty = f3.ot + (f3.ob - f3.ot) * 0.45;
      for (let i = 1; i <= 12; i++) await page.mouse.move(card.l + card.w / 2 + (tx - card.l - card.w / 2) * i / 12, card.t + card.h / 2 + (ty - card.t - card.h / 2) * i / 12);
      await page.mouse.up();
      await page.waitForTimeout(400);
      const n2 = await placedCount(page);
      c.ok(n2 === n1 + 1, `${tag}: dragging a catalog item onto the floor above the sheet places it`, JSON.stringify({ n1, n2 }));
      await page.evaluate(() => { const b = document.querySelector('#vo-editor-status .vo-es-actions button'); if (b) b.click(); });
      await page.waitForTimeout(200);
      await page.click('#btn-undo-edit');
      await page.waitForTimeout(300);
      c.ok(await placedCount(page) === n1, `${tag}: Undo in the toolbar under the sheet works`);
    }
    const tb = await page.evaluate(() => ['[data-vo-edit="done"]', '[data-vo-edit="cancel"]', '#btn-undo-edit'].map(s => { const b = document.querySelector('.ui-edit-toolbar ' + s); const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return s + ':' + (!!at && b.contains(at)); }));
    c.ok(tb.every(t => /:true$/.test(t)), `${tag}: Done, Cancel and Undo stay reachable under the sheet`, tb.join(' '));
    c.ok(e.errors.length === 0, `${tag}: no page errors`, e.errors.join(' | ').slice(0, 300));
    await e.context.close();
  }

  // ---------------- desktop ----------------
  for (const size of [{ width: 1280, height: 720 }, { width: 1600, height: 1000 }, { width: 1920, height: 1080 }, { width: 1000, height: 700 }]) {
    const tag = `${size.width}x${size.height}`;
    const e = await openEditor(browser, Object.assign({ edit: false }, size));
    const page = e.page;
    await page.waitForTimeout(500);
    const dock = await page.evaluate(() => ({ projects: !!document.getElementById('btn-projects').getBoundingClientRect().width, edit: !!document.getElementById('btn-edit-office').getBoundingClientRect().width }));
    c.ok(dock.projects && dock.edit, `${tag}: the desktop dock keeps Edit office and Projects`, JSON.stringify(dock));
    for (const collapsed of [false, true]) {
      if (collapsed) { await page.evaluate(() => toggleSidebar()); await page.waitForTimeout(450); }
      await page.click('#btn-more');
      await page.waitForTimeout(300);
      const bad = await moreUncovered(page);
      const dup = await page.evaluate(() => [...document.querySelectorAll('#vo-more-menu .vo-menu-item')].some(x => /^\s*Projects\s*$/.test(x.textContent) && x.getBoundingClientRect().height > 0));
      c.ok(bad.length === 0 && !dup, `${tag}: the More pane is fully visible with the dashboard ${collapsed ? 'collapsed' : 'open'} (no duplicate Projects)`, bad.slice(0, 4).join(' | '));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    if (size.width === 1280) {
      await page.evaluate(() => toggleEditMode());
      await page.waitForTimeout(600);
      const g = await page.evaluate(() => { const el = document.querySelector('#furniture-catalog [data-vo-edsheet-grab]'); return el ? getComputedStyle(el).display : 'none'; });
      c.ok(g === 'none', `${tag}: the desktop catalog panel has no sheet handle`, g);
    }
    c.ok(e.errors.length === 0, `${tag}: no page errors`, e.errors.join(' | ').slice(0, 300));
    await e.context.close();
  }
} finally {
  await browser.close();
}
c.done();
