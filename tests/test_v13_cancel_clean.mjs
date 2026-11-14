// v0.13 cancel (review 11-13): Edit office -> change nothing -> Cancel showed "Discard office changes?" (desktop and
// phone). Cancel now asks only when there is something to discard: the office on screen differs from the snapshot
// taken when the editor opened in anything Cancel puts back (walls, floor, furniture, branches, office size; key
// order, float noise and the default variant id do not count). No change (also: select / Variants menu / Esc /
// a move undone) leaves quietly and saves nothing; a real change (move, add, delete, rotate, variant, colour,
// paint, layout) still asks, "Keep editing" keeps it, "Discard changes" puts the office back.
// An office like a lived-in one (desk variants and colours, boss desk, labels, windows, a pet, assigned desks),
// Office Life on, agents working and idle. Hermetic: see test_v10_editor_lib.mjs.
//
// Run: node tests/test_v13_cancel_clean.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launch, openEditor, makeChecker, toScreen, APP } from './test_v10_editor_lib.mjs';

const NAME = 'test_v13_cancel_clean';
const py = spawnSync('python3', ['-c', `
import sys, json, tempfile
sys.path.insert(0, ${JSON.stringify(APP)})
import layout_library as L
lib = L.LayoutLibrary(tempfile.mkdtemp(), ${JSON.stringify(path.join(APP, 'default-office-config.json'))})
items = lib.list()
print(json.dumps({'list': items, 'assets': {i['id']: lib.get(i['id']) for i in items}}))
`], { encoding: 'utf8' });
if (py.status !== 0) { console.log(py.stderr.slice(-400)); process.exit(1); }
const LAYOUTS = JSON.parse(py.stdout);

const NAMES = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fen'];
function office() {
  const o = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
  const desks = o.furniture.filter(f => f.type === 'desk');
  desks[0].id = 'd1';   // openEditor waits for it
  const looks = [['maker'], ['creative'], ['analyst'], ['developer', 'black'], ['developer', 'black-green'], ['streamer', 'black-red']];
  desks.forEach((d, i) => {
    if (i < NAMES.length) d.assignedTo = NAMES[i];
    const lk = looks[i - 2];
    if (lk) { d.variant = lk[0]; if (lk[1]) d.color = lk[1]; }
  });
  const boss = o.furniture.find(f => f.type === 'bossDesk');
  if (boss) Object.assign(boss, { variant: 'command', color: 'black-gold' });
  // a lived-in office's size (room left for a template and a plant); the wall runs the full width
  const grow = 1520 - o.canvasWidth;
  o.canvasWidth = 1520; o.canvasHeight = 1060;
  const last = o.walls.sections[o.walls.sections.length - 1];
  if (last) last.w += grow;
  o.pet = { enabled: true, species: 'pug', name: 'Pip', x: 520, y: 600 };
  o.agents = NAMES.map((n, i) => ({ id: 'a' + i, statusKey: 'a' + i, name: n, displayName: n, role: 'Tester', emoji: '🤖',
    color: '#ffd700', gender: i % 2 ? 'F' : 'M', branch: 'UNASSIGNED' }));
  return o;
}
const TODAY = new Date().toISOString().slice(0, 10);
const LIFE = { enabled: true, calm: false, timeZone: 'UTC',
  features: { needsYou: true, interns: true, handoffs: true, visitors: true, alarmClock: true, moods: true, celebrations: true,
    standup: false, seasons: true, tournaments: false, newspaper: false },
  seasons: { decor: true, fridayTreat: true, rain: true, birthdays: true, custom: [] } };
const OPTS = {
  layouts: { layouts: LAYOUTS.list }, layoutAssets: LAYOUTS.assets, edit: false,
  agents: NAMES.map((n, i) => ({ id: 'a' + i, statusKey: 'a' + i, name: n, emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true })),
  status: Object.fromEntries(NAMES.map((n, i) => ['a' + i, i % 2 ? { state: 'idle', task: '' } : { state: 'working', task: 'Testing' }])),
  fixtures: {
    '/api/office-life/state': { ok: true, seq: 1, day: TODAY, tz: 'UTC', settings: LIFE, open: { needs: [], interns: {}, moods: {} },
      today: { birthdays: [], cake: false }, paper: { day: TODAY, ready: false } },
    '/api/office-life/settings': { ok: true, settings: LIFE },
  },
};

const browser = await launch(NAME);
const t = makeChecker(NAME);

async function run(label, view) {
  const { page, saves, errors, context } = await openEditor(browser, Object.assign({ office: office() }, OPTS, view));
  const phone = !!view.mobile;
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.waitForTimeout(3000);   // agents walk in, Office Life starts
  const env = await ev(() => ({ life: !document.documentElement.classList.contains('vo-life-off'), agents: agents.length,
    variants: officeConfig.furniture.filter(f => f.variant).length, pet: !!(officeConfig.pet && officeConfig.pet.enabled) }));
  t.ok(env.life && env.agents >= 6 && env.variants >= 7 && env.pet, label + ': Office Life on, agents in, desk variants and a pet', JSON.stringify(env));

  // Click the first visible control matching sel (and text), like a user.
  const press = async (sel, re) => {
    const i = await ev(([sel, src]) => {
      const rx = src ? new RegExp(src, 'i') : null;
      return [...document.querySelectorAll(sel)].findIndex(e => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden]') &&
          (!rx || rx.test((e.getAttribute('aria-label') || '') + ' ' + (e.title || '') + ' ' + e.textContent)); });
    }, [sel, re ? re.source : '']);
    if (i < 0) return false;
    const loc = page.locator(sel).nth(i);
    try { if (phone) await loc.tap({ timeout: 4000 }); else await loc.click({ timeout: 4000 }); } catch (e) { return false; }
    return true;
  };
  // officeLayoutKey is the app's (v0.13 cancel); without it (an older tree) the plain parts Cancel restores
  const KEY = (c) => typeof officeLayoutKey === 'function' ? officeLayoutKey(c)
    : JSON.stringify([c.walls, c.floor, c.furniture, c.branches, c.canvasWidth, c.canvasHeight]);
  const KEY_SRC = KEY.toString();
  const layoutKey = () => ev((src) => (0, eval)('(' + src + ')')(officeConfig), KEY_SRC);
  const dialogUp = () => ev(() => [...document.querySelectorAll('[role=alertdialog],[role=dialog]')].some(d =>
    d.getBoundingClientRect().height > 0 && /Discard office changes/i.test(d.textContent)));
  const enter = async () => {
    const ok = await press('button', /edit office/);
    await page.waitForTimeout(2500);   // the reported wait
    return ok && await ev(() => editMode);
  };
  // Select a furniture item by tapping a point the editor hits as that item.
  const selectItem = async (id) => {
    const w = await ev((id) => { const f = officeConfig.furniture.find(x => x.id === id);
      for (let dy = -30; dy <= 40; dy += 5) for (let dx = -10; dx <= 60; dx += 5) { const h = _findFurnitureAt(f.x + dx, f.y + dy); if (h && h.id === id) return { x: f.x + dx, y: f.y + dy }; }
      return null; }, id);
    if (!w) return false;
    const p = await toScreen(page, w.x, w.y);
    if (phone) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(350);
    return await ev(() => selectedItemId) === id;
  };
  const closeOverlays = async () => { for (let i = 0; i < 3; i++) await ev(() => window.VOEditor && VOEditor.closeOverlays && VOEditor.closeOverlays()); };
  const openVariants = async () => {
    const shown = () => ev(() => { const m = document.getElementById('variant-menu'); return !!m && m.getBoundingClientRect().height > 0; });
    for (let i = 0; i < 2 && !await shown(); i++) { await press('#ftb-variant-btn'); await page.waitForTimeout(400); }
    return shown();
  };
  // Select the first item of these types the editor lets us pick.
  const selectAny = async (types) => {
    const ids = await ev((types) => officeConfig.furniture.filter(f => types.includes(f.type)).map(f => f.id), types);
    for (const id of ids) if (await selectItem(id)) return id;
    return null;
  };
  const cancel = async () => { const ok = await press('[data-vo-edit=cancel]'); await page.waitForTimeout(700); return ok; };
  const idOf = (pred) => ev((src) => { const f = officeConfig.furniture.find(new Function('f', 'return ' + src)); return f && f.id; }, pred);
  const freeDesk = await idOf("f.type === 'desk' && !f.assignedTo && !f.variant");
  const pos = (id) => ev((id) => { const f = officeConfig.furniture.find(x => x.id === id); return f ? f.x + ',' + f.y : ''; }, id);
  // Select an item and nudge it with the arrow keys (the first direction that is free).
  const nudge = async (id) => {
    if (!await selectItem(id)) return false;
    const p0 = await pos(id);
    for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) {
      await page.keyboard.press(k); await page.waitForTimeout(250);
      if (await pos(id) !== p0) return true;
    }
    return false;
  };
  // A free floor spot on screen for a type (the phone shows a part of the office).
  const findFree = (key) => ev((key) => {
    const c = document.getElementById('officeCanvas'), r = c.getBoundingClientRect(), hit = (x, y) => document.elementFromPoint(x, y) === c;
    for (let sy = r.top + r.height * 0.2; sy < r.bottom - 40; sy += 12) for (let sx = r.left + 40; sx < r.right - 40; sx += 12) {
      if (!hit(sx, sy) || !hit(sx - 30, sy - 30) || !hit(sx + 30, sy + 20)) continue;
      const w = screenToWorld(sx, sy), x = Math.round(w.x), y = Math.round(w.y);
      if ([-16, 0, 16].every(dx => [-16, 0, 16].every(dy => !_placementProblem(key, x + dx, y + dy, 0, [], 2)))) return { sx, sy };
    }
    return null; }, key);

  // --- no change: Cancel leaves quietly and saves nothing
  async function clean(what, fn) {
    const before = await layoutKey();
    const n0 = saves.length;
    const entered = await enter();
    const res = fn ? await fn() : true, did = res === true;
    const pressed = await cancel();
    const st = { entered, did, why: did ? undefined : res, pressed, prompt: await dialogUp(), editing: await ev(() => editMode) };
    await page.waitForTimeout(400);
    // nothing saved, or (a move undone) the last save is the office as it was
    const last = saves.length > n0 ? saves[saves.length - 1].body : null;
    st.saves = saves.length - n0;
    st.savedSame = !last || await ev(([b, k, src]) => (0, eval)('(' + src + ')')(JSON.parse(b)) === k, [last, before, KEY_SRC]);
    st.same = (await layoutKey()) === before;
    if (st.prompt) { await press('button', /keep editing/); await page.waitForTimeout(300); await ev(() => { if (editMode) toggleEditMode(); }); await page.waitForTimeout(300); }
    await closeOverlays();
    t.ok(st.entered && st.did && st.pressed && !st.prompt && !st.editing && (st.saves === 0 || what.includes('Undo')) && st.savedSame && st.same,
      label + ': ' + what + ' -> Cancel leaves without asking, nothing saved', JSON.stringify(st));
  }
  await clean('open, change nothing');
  await clean('select a desk, Esc, Esc', async () => {
    const s = await selectItem(freeDesk);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    return s && !(await dialogUp()) && await ev(() => editMode && !selectedItemId);
  });
  await clean('open the Variants menu and close it', async () => {
    const s = await selectItem(freeDesk);
    const opened = await press('#ftb-variant-btn'); await page.waitForTimeout(400);
    const menu = await ev(() => { const m = document.getElementById('variant-menu'); return !!m && m.getBoundingClientRect().height > 0; });
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    return s && opened && menu;
  });
  await clean('move a desk, then Undo', async () => {
    const p0 = await pos(freeDesk);
    const moved = await nudge(freeDesk);
    await ev(() => _deselectItem());
    for (let i = 0; i < 4 && await pos(freeDesk) !== p0; i++) { await ev(() => undoEdit()); await page.waitForTimeout(250); }
    return moved && await pos(freeDesk) === p0;
  });
  if (!phone) {
    // the catalog's close button (= Done) and E leave quietly too
    const n0 = saves.length;
    const a = await enter(); const closed = await press('.catalog-close-btn'); await page.waitForTimeout(500);
    const b = await enter(); await page.keyboard.press('e'); await page.waitForTimeout(500);
    const st = { a, closed, b, prompt: await dialogUp(), editing: await ev(() => editMode), saves: saves.length - n0 };
    t.ok(a && closed && b && !st.prompt && !st.editing && st.saves === 0, label + ': close (x) and E leave quietly', JSON.stringify(st));
  }

  // --- a real change: Cancel asks; Keep editing keeps it; Discard puts the office back
  async function changed(what, fn) {
    const before = await layoutKey();
    const entered = await enter();
    const res = await fn(), did = res === true;
    const after = await layoutKey();
    await cancel();
    const st = { entered, did, why: did ? undefined : res, differs: after !== before, prompt: await dialogUp() };
    if (st.prompt) {
      await press('button', /keep editing/); await page.waitForTimeout(400);
      st.kept = await ev(() => editMode) && (await layoutKey()) === after && !(await dialogUp());
      await cancel();
      st.prompt2 = await dialogUp();
      await press('button', /discard changes/); await page.waitForTimeout(800);
    }
    st.editing = await ev(() => editMode);
    st.restored = (await layoutKey()) === before;
    if (st.editing) { await ev(() => toggleEditMode()); await page.waitForTimeout(300); }
    await closeOverlays();
    t.ok(st.entered && st.did && st.differs && st.prompt && st.kept && st.prompt2 && !st.editing && st.restored,
      label + ': ' + what + ' -> Cancel asks; Keep editing keeps it, Discard puts it back', JSON.stringify(st));
  }
  const sel = (id) => async () => selectItem(id);
  await changed('move', async () => nudge(freeDesk));
  await changed('add (place a plant from the catalog)', async () => {
    const n = await ev(() => officeConfig.furniture.length);
    const c = await press('.catalog-item[data-type=plant]'); await page.waitForTimeout(400);
    const spot = await findFree('plant');
    if (spot) { if (phone) await page.touchscreen.tap(spot.sx, spot.sy); else await page.mouse.click(spot.sx, spot.sy); }
    await page.waitForTimeout(400);
    if (phone) await press('#vo-editor-status .vo-es-actions button', /done placing/); else await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await ev(() => !!placingType)) await ev(() => _cancelPlacement());
    const added = await ev((n) => officeConfig.furniture.length - n, n);
    return (c && !!spot && added === 1) || { c, spot: !!spot, added }; });
  await changed('delete', async () => { const s = await selectAny(['trashCan', 'filingCabinet', 'plant', 'tallPlant']);
    const n = await ev(() => officeConfig.furniture.length);
    await ev(() => _deleteSelectedItem()); await page.waitForTimeout(300);
    return !!s && await ev((n) => officeConfig.furniture.length === n - 1, n); });
  await changed('rotate', async () => { const s = await sel(freeDesk)(); const r = await press('#ftb-rotate-btn'); await page.waitForTimeout(400); return s && r; });
  await changed('variant', async () => { const s = await sel(freeDesk)(); const m = await openVariants();
    const v = await press('#variant-menu .vo-variant-opt[data-key="desk~analyst"]'); await page.waitForTimeout(400);
    return s && m && v && await ev((id) => officeConfig.furniture.find(f => f.id === id).variant === 'analyst', freeDesk); });
  await changed('colour', async () => { const s = await sel(freeDesk)(); const m = await openVariants();
    const other = await ev((id) => { const f = officeConfig.furniture.find(x => x.id === id), row = FURNITURE_VARIANTS.desk[0];
      const cur = f.color || row.colors[0]; const el = [...document.querySelectorAll('#variant-menu .vo-variant-color')].find(e => e.dataset.color !== cur);
      return el ? el.dataset.color : null; }, freeDesk);
    const v = other && await press('#variant-menu .vo-variant-color[data-color="' + other + '"]'); await page.waitForTimeout(400);
    const now = await ev((id) => officeConfig.furniture.find(f => f.id === id).color || null, freeDesk);
    return (s && m && !!v && now === other) || { s, m, other, v: !!v, now }; });
  await changed('paint the floor', async () => ev(() => paintWholeFloor(FLOOR_STYLES.find(s => s.id !== (officeConfig.floor.style || 'checker'))) !== false));
  await changed('place a room layout', async () => {
    const n = await ev(() => officeConfig.furniture.length);
    await press('.catalog-tabs button[data-pane=layouts]'); await page.waitForTimeout(1200);
    // the first room template that has a free spot in this (full) office
    const ids = await ev(() => [...document.querySelectorAll('[data-layout-place]')].map(b => b.dataset.layoutPlace));
    let p = false, placed = false;
    for (const id of ids) {
      p = await press('[data-layout-place="' + id + '"]'); await page.waitForTimeout(250);
      placed = p && await ev(() => OfficeLayouts.placeAtFreeSpot() !== false);
      await page.waitForTimeout(400);
      if (placed && await ev((n) => officeConfig.furniture.length > n, n)) break;
      await ev(() => OfficeLayouts.cancelPlacement());
    }
    await press('.catalog-tabs button[data-pane]', /^\s*(objects|furniture)/);
    const added = await ev((n) => officeConfig.furniture.length - n, n);
    return (p && placed && added > 0) || { ids: ids.length, p, placed, added };
  });

  // nothing left behind: no error, the editor closed
  t.ok(errors.length === 0, label + ': no page errors', errors.slice(0, 3).join(' | '));
  await context.close();
}

await run('desktop 1600x1000', { width: 1600, height: 1000 });
await run('phone 412x915', { width: 412, height: 915, mobile: true });
await browser.close();
t.done();
