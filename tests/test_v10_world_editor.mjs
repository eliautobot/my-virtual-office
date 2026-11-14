// v0.10.1 world contract W3: the office editor uses the manifest. A floor
// piece may not cover another piece's footprint, seats (chair + floor point)
// or stand spots, and its own must stay free; the reason line names what is in
// the way. Covers every type x rotation (both directions), wall pieces,
// counter appliances, the rotation preview, nudge / drag / rotate / duplicate,
// the room templates, and a layout edit with people at desks, on a couch and
// at a stand spot (they re-settle by the W2 rules). Hermetic, one Chrome.
//
// Run: node tests/test_v10_world_editor.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, openEditor, officeFixture, toScreen, makeChecker, APP } from './test_v10_editor_lib.mjs';

const NAME = 'test_v10_world_editor';
const templates = JSON.parse(spawnSync('python3', ['-c',
  'import json, layout_library as L; print(json.dumps([L.build_room_template(t) for t in L.ROOM_TEMPLATES]))'],
  { cwd: APP, encoding: 'utf8' }).stdout || '[]');
const browser = await launch(NAME);
const t = makeChecker(NAME);
try {
  const { page, errors } = await openEditor(browser);

  // 1. Every type x rotation: every seat and stand spot is protected, both ways.
  const matrix = await page.evaluate(() => {
    officeConfig.walls.interior = [];
    const res = { cases: 0, own: 0, bad: [], missing: [], seen: {} };
    const types = Object.keys(FURNITURE_MANIFEST).filter(k => k !== '_unknown' && _manifestOf(k).mount !== 'wall' &&
      _useSpaces({ type: k, x: 500, y: 400, rotation: 0 }).length);
    const fpOf = (it) => _itemFootprints(it);
    const trashF = (x, y) => ({ x: x - 8, y: y + 3, w: 16, h: 6 });  // trashCan footprint at (x, y)
    types.forEach(type => {
      const m = _manifestOf(type), rots = m.rotatable ? [0, 90, 180, 270] : [0];
      rots.forEach(rot => {
        const surface = m.mount === 'surface';
        const P = { id: 'P', type, x: 500, y: 400, rotation: rot };
        const items = [];
        if (surface) { items.push({ id: 'K', type: 'kitchenCounter', x: 496, y: 400 }); P.y = 400 - FURNITURE_BOUNDS[type].h + 2; }
        items.push(P);
        officeConfig.furniture = items;
        const spaces = _useSpaces(P), solid = [].concat(...items.map(fpOf));
        const byWhat = {};
        // a) a trash can put on each space is refused with the name of what it covers
        // a tucked chair (a desk turned 180) lies under the piece's own footprint: the footprint guards it
        const under = (sp) => fpOf(P).some(r => sp.rect.x >= r.x - 1 && sp.rect.y >= r.y - 1 && sp.rect.x + sp.rect.w <= r.x + r.w + 1 && sp.rect.y + sp.rect.h <= r.y + r.h + 1);
        spaces.forEach((sp, si) => {
          const cx = sp.rect.x + sp.rect.w / 2, cy = sp.rect.y + sp.rect.h / 2;
          let done = false;
          if (under(sp)) {
            const got = _placementProblem('trashCan', Math.round(cx), Math.round(cy - 6), 0, null, 0);
            res.cases++; done = true; byWhat[sp.what] = true;
            if (got !== 'Overlaps ' + _furnitureLabel(type)) res.bad.push(`${type}@${rot} tucked space ${si}: got "${got}"`);
          }
          for (let d = 0; d <= 14 && !done; d += 2) for (let dy = -d; dy <= d && !done; dy += 2) for (let dx = -d; dx <= d && !done; dx += 2) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
            const x = Math.round(cx + dx), y = Math.round(cy + dy - 6), F = trashF(x, y);
            if (!_rectsHit(F, sp.rect, 1) || solid.some(r => _rectsHit(F, r, 0))) continue;
            let want = '';
            for (let i = items.length - 1; i >= 0 && !want; i--) for (const s of _useSpaces(items[i])) if (_rectsHit(F, s.rect, 1)) { want = s.verb + ' ' + s.what; break; }
            const got = _placementProblem('trashCan', x, y, 0, null, 0);
            res.cases++; done = true; byWhat[sp.what] = true;
            if (got !== want) res.bad.push(`${type}@${rot} space ${si}: got "${got}" want "${want}"`);
            res.seen[want] = true;
          }
        });
        spaces.forEach(sp => { if (!byWhat[sp.what]) res.missing.push(`${type}@${rot}: ${sp.what}`); });
        // b) the piece itself is refused where a trash can stands on one of its own spaces
        if (!surface) {
          const T = { id: 'T', type: 'trashCan', x: 520, y: 380 }, TF = trashF(T.x, T.y);
          officeConfig.furniture = [T];
          const ownDone = {};
          spaces.forEach(sp => {
            if (ownDone[sp.own + sp.what] || under(sp)) return;
            const sx = sp.rect.x + sp.rect.w / 2 - P.x, sy = sp.rect.y + sp.rect.h / 2 - P.y;
            for (let d = 0; d <= 14; d += 2) {
              let hit = false;
              for (let dy = -d; dy <= d && !hit; dy += 2) for (let dx = -d; dx <= d && !hit; dx += 2) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
                const Q = { type, x: Math.round(T.x - sx + dx), y: Math.round(T.y + 6 - sy + dy), rotation: rot };
                const qs = _useSpaces(Q);
                if (!qs.some(s => s.own === sp.own && _rectsHit(TF, s.rect, 1)) || fpOf(Q).some(r => _rectsHit(TF, r, 0))) continue;
                const r = _getItemWorldRect(Q);
                if (r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H) continue;
                let want = '';
                for (const s of qs) if (_rectsHit(TF, s.rect, 1)) { want = 'Trash Can blocks ' + s.own; break; }
                const got = _placementProblem(type, Q.x, Q.y, rot, null, 0);
                res.own++; hit = true; ownDone[sp.own + sp.what] = true;
                if (got !== want) res.bad.push(`${type}@${rot} own: got "${got}" want "${want}"`);
              }
              if (hit) break;
            }
            if (!ownDone[sp.own + sp.what]) res.missing.push(`${type}@${rot} own: ${sp.own}`);
          });
        }
      });
    });
    res.types = types;
    return res;
  });
  t.ok(matrix.types.length >= 19 && matrix.bad.length === 0 && matrix.missing.length === 0,
    `every type x rotation: a piece on a seat or stand spot is refused and named (${matrix.cases} cases), and a piece whose own seat/spot is covered is refused (${matrix.own} cases)`,
    JSON.stringify({ types: matrix.types.length, bad: matrix.bad.slice(0, 6), missing: matrix.missing.slice(0, 6) }));
  const names = Object.keys(matrix.seen);
  const expectNames = ['Blocks the chair of Desk', 'Blocks the chair of Boss Desk', "Covers the vending machine's front", 'Blocks a seat of L-Couch',
    'Blocks a chair of Meeting Table', 'Covers a standing spot of Meeting Table', "Covers the ping pong table's left end", "Covers the coffee maker's front"];
  t.ok(expectNames.every(n => names.includes(n)), 'the reason line names the chair / seat / front it hits', JSON.stringify(expectNames.filter(n => !names.includes(n))) + ' of ' + JSON.stringify(names.slice(0, 30)));

  // 2. Wall pieces, counter appliances, footprints (not drawn boxes).
  const rules = await page.evaluate(() => {
    officeConfig.walls.interior = [];
    officeConfig.furniture = [{ id: 'k1', type: 'kitchenCounter', x: 600, y: 300 }, { id: 'k2', type: 'kitchenCounter', x: 400, y: 300, rotation: 90 },
      { id: 'd1', type: 'desk', x: 300, y: 500 }, { id: 'w1', type: 'window', x: 200, y: 10 }];
    const out = {};
    out.clockFloor = _placementProblem('clock', 500, 400, 0, null);
    out.clockWall = _placementProblem('clock', 500, 40, 0, null);
    out.clockOnWindow = _placementProblem('clock', 216, 30, 0, null);
    out.windowFloor = _placementProblem('window', 500, 300, 0, null);
    out.coffeeFloor = _placementProblem('coffeeMaker', 500, 500, 0, null);
    out.turnedCounter = _placementCandidate('coffeeMaker', 420, 300).reason;
    out.deskAt180Wall = _placementProblem('desk', 600, 112, 180, null);
    out.deskAt180Room = _placementProblem('desk', 600, 130, 180, null);  // persp3 desk: its tucked chair's floor point 31 px north
    // footprints, not drawn boxes: a plant may stand right in front of the desk's
    // side (drawn boxes overlap), not on its footprint
    out.plantBesideDesk = _placementProblem('plant', 338, 500, 0, null);
    out.plantOnDesk = _placementProblem('plant', 300, 480, 0, null);
    // counter: three appliances fill the 72 px top, each snapped to the nearest free spot
    const placed = [];
    ['coffeeMaker', 'toaster', 'microwave'].forEach((type, i) => {
      const c = _placementCandidate(type, 612, 290);
      placed.push({ type, x: c.x, y: c.y, valid: c.valid, reason: c.reason });
      if (c.valid) officeConfig.furniture.push({ id: 'a' + i, type, x: c.x, y: c.y });
    });
    out.placed = placed;
    out.full = _placementCandidate('toaster', 612, 290).reason;
    const apps = officeConfig.furniture.filter(f => COUNTER_ONLY_ITEMS.indexOf(f.type) >= 0);
    out.appOverlap = apps.some((a, i) => apps.some((b, j) => j > i && _counterSlotTaken(a.type, a.x, a.y, [a.id]) ));
    return out;
  });
  t.ok(rules.clockFloor === 'Wall only' && rules.clockWall === '' && /^Overlaps Window/.test(rules.clockOnWindow) && rules.windowFloor === 'Windows go on the top wall',
    'wall pieces only on the wall band, clashing with wall pieces', JSON.stringify(rules).slice(0, 300));
  t.ok(rules.coffeeFloor === 'Needs a kitchen counter' && rules.turnedCounter === 'Needs a kitchen counter' && rules.deskAt180Wall === 'The wall blocks its chair' && rules.deskAt180Room === '',
    'appliances need a counter (not a turned one); a desk turned 180 can not back its chair into the wall', JSON.stringify(rules).slice(0, 300));
  t.ok(rules.plantBesideDesk === '' && rules.plantOnDesk === 'Overlaps Desk', 'placement is by footprint: beside a desk is fine, on it is refused', JSON.stringify([rules.plantBesideDesk, rules.plantOnDesk]));
  t.ok(rules.placed.every(p => p.valid) && !rules.appOverlap && /^Overlaps (Coffee Maker|Toaster|Microwave)$/.test(rules.full),
    'appliances snap onto free counter spots only; a full counter says what is there', JSON.stringify({ placed: rules.placed, full: rules.full }));

  // 3. Rotation preview (R while placing): the ghost checks the turned seats.
  // (a bookshelf beside the desk: one turn puts the chair against it)
  const probe = await page.evaluate(() => {
    officeConfig.furniture = [{ id: 'b1', type: 'bookshelf', x: 400, y: 330 }];
    buildCollisionGrid();
    // (a turned desk chair always falls inside the footprint of the turn before, so the
    // blocker that tells them apart is the top wall: at 180 the chair is behind the desk)
    for (const r1 of [0, 90, 180, 270]) for (let wy = 96; wy <= 520; wy += 4) for (let wx = 300; wx <= 560; wx += 4) {
      _placingRotation = r1; const a = _placementCandidate('desk', wx, wy);
      _placingRotation = (r1 + 90) % 360; const b = _placementCandidate('desk', wx, wy);
      if (a.valid && /^(Bookshelf|The wall) blocks its chair$/.test(b.reason)) { _placingRotation = 0; return { wx, wy, r1, why: b.reason }; }
    }
    _placingRotation = 0; return null;
  });
  if (probe) {
    await page.click('.catalog-item[data-type=desk]');
    for (let k = 0; k < probe.r1 / 90; k++) await page.evaluate(() => rotatePlacingGhost());
    const p = await toScreen(page, probe.wx, probe.wy);
    await page.mouse.move(p.x, p.y, { steps: 2 });
    await page.waitForTimeout(80);
    const r0 = await page.evaluate(() => ({ reason: _placementReason, rot: _ghostPos && _ghostPos.rotation }));
    await page.evaluate(() => rotatePlacingGhost());
    await page.waitForTimeout(80);
    const r1 = await page.evaluate(() => ({ reason: _placementReason, rot: _ghostPos && _ghostPos.rotation, n: officeConfig.furniture.length }));
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(60);
    const n2 = await page.evaluate(() => officeConfig.furniture.length);
    t.ok(r0.reason === '' && r0.rot === probe.r1 && r1.rot === (probe.r1 + 90) % 360 && r1.reason === probe.why && n2 === r1.n,
      'turning the ghost (R) checks the turned chair: green, then red "' + probe.why + '" one turn on; the click places nothing', JSON.stringify({ probe, r0, r1, n2 }));
    await page.keyboard.press('Escape');
    await page.evaluate(() => { _placingRotation = 0; });
  } else t.ok(false, 'rotation preview probe found a spot', 'none');
  // the ghost's facing ticks: the manifest facing turned with the piece; a stand spot faces its piece
  const faces = await page.evaluate(() => {
    const F = (t, r) => _useSpaces({ type: t, x: 500, y: 400, rotation: r || 0 }).filter(s => s.feet).map(s => s.face);
    return { desk: [0, 90, 180, 270].map(r => F('desk', r)[0]), boss: [0, 90, 180, 270].map(r => F('bossDesk', r)[0]),
      couch: [0, 90, 180, 270].map(r => F('couch', r)[0]), vend: F('vendingMachine'), pong: F('pingPongTable'), shelf: F('bookshelf') };
  });
  t.ok(faces.desk.join() === 'up,right,down,left' && faces.boss.join() === 'up,right,down,left' && faces.couch.join() === 'down,left,up,right' &&
    faces.vend.join() === 'up' && faces.pong.join() === 'right,left' && faces.shelf.join() === 'up',
    'the ghost shows each seat / stand spot facing as the manifest turns it (desks, couch, vending, ping pong ends, bookshelf)', JSON.stringify(faces));

  // 4. Nudge, drag, rotate, duplicate.
  const ops = await page.evaluate(() => {
    officeConfig.furniture = [{ id: 'd1', type: 'desk', x: 560, y: 250 }, { id: 'p1', type: 'plant', x: 552, y: 277 }, { id: 'd2', type: 'desk', x: 300, y: 420 }];
    buildCollisionGrid();
    const out = {};
    out.start = _placementProblem('plant', 552, 277, 0, ['p1']);
    selectedItemId = 'p1'; _multiSelected = [];
    out.nudged = _nudgeSelection(0, -10);
    out.nudgeFlash = _editFlashState && _editFlashState.text;
    out.p1y = officeConfig.furniture.find(f => f.id === 'p1').y;
    // rotate d2 with a trash can where its turned chair goes
    const d2 = officeConfig.furniture.find(f => f.id === 'd2');
    const before = _getItemWorldRect(d2), after = _getItemWorldRect({ type: 'desk', x: d2.x, y: d2.y, rotation: 90 });
    const nx = Math.round(d2.x + (before.x + before.w / 2) - (after.x + after.w / 2)), ny = Math.round(d2.y + (before.y + before.h / 2) - (after.y + after.h / 2));
    const chair = _useSpaces({ type: 'desk', x: nx, y: ny, rotation: 90 })[0].rect;
    officeConfig.furniture.push({ id: 't1', type: 'trashCan', x: Math.round(chair.x - 6), y: Math.round(chair.y + chair.h / 2 - 6) });
    out.turned = _rotateFurnitureItem(d2);
    out.turnFlash = _editFlashState && _editFlashState.text;
    out.rot = d2.rotation || 0;
    // duplicate d1: the copy lands where its chair and the original's are clear
    selectedItemId = 'd1'; _multiSelected = [];
    duplicateEditSelection();
    const copy = officeConfig.furniture[officeConfig.furniture.length - 1];
    out.copy = { type: copy.type, why: _placementProblem(copy.type, copy.x, copy.y, copy.rotation || 0, [copy.id]) };
    return out;
  });
  t.ok(ops.start === '' && ops.nudged === false && ops.nudgeFlash === 'Blocks the chair of Desk' && ops.p1y === 277,
    'a nudge onto a desk chair is refused and says so', JSON.stringify(ops));
  t.ok(ops.turned === false && ops.rot === 0 && ops.turnFlash === 'No room to turn it: Trash Can blocks its chair',
    'turning a desk whose turned chair would be blocked is refused and says so', JSON.stringify([ops.turned, ops.turnFlash]));
  t.ok(ops.copy.type === 'desk' && ops.copy.why === '', 'a duplicated desk lands with both chairs clear', JSON.stringify(ops.copy));
  // drag the plant up onto the chair: it stays where it was, the drag shows why (v0.13 seat reach: the chair and its
  // feet box came 7 px nearer the desk, so the plant starts 7 px higher, just below them as before)
  const pp = await page.evaluate(() => { selectedItemId = null; _multiSelected = []; const p = officeConfig.furniture.find(f => f.id === 'p1'); p.y -= 7; const r = _getItemWorldRect(p); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; });
  await page.evaluate(() => setEditSnapMode('free'));
  const a = await toScreen(page, pp.x, pp.y), b = await toScreen(page, pp.x, pp.y - 8);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.waitForTimeout(60);
  await page.mouse.move(b.x, b.y, { steps: 6 }); await page.waitForTimeout(80);
  const mid = await page.evaluate(() => _editDragTileHighlight && { valid: _editDragTileHighlight.valid, reason: _editDragTileHighlight.reason, hit: !!_editDragTileHighlight.hit });
  await page.mouse.up(); await page.waitForTimeout(80);
  const endY = await page.evaluate(() => { const p = officeConfig.furniture.find(f => f.id === 'p1'); setEditSnapMode('tile'); return _placementProblem('plant', p.x, p.y, 0, ['p1']) ? -1 : p.y; });
  t.ok(mid && mid.valid === false && mid.reason === 'Blocks the chair of Desk' && mid.hit && endY >= 267 && endY <= 270,
    'dragging a plant onto a desk chair shows the reason and leaves it in place', JSON.stringify({ mid, endY }));

  // 5. Room templates: valid on their own, placeable, and refused (named) over a desk chair.
  const tp = await page.evaluate((tpls) => {
    const out = { inner: [], free: [], chair: null };
    tpls.forEach(tp => {
      officeConfig.walls.interior = [];
      officeConfig.furniture = tp.objects.furniture.map((f, i) => Object.assign({}, f, { id: 'q' + i, x: f.x + 200, y: f.y + 200 }));
      officeConfig.furniture.forEach(f => { const w = _placementProblem(f.type, f.x, f.y, f.rotation || 0, [f.id], 0); if (w) out.inner.push(tp.id + ' ' + f.type + ': ' + w); });
      officeConfig.furniture = [];
      const c = OfficeLayouts.inspectAssetPlacement(tp, 500, 420);
      if (!c.valid) out.free.push(tp.id + ': ' + c.reason);
    });
    // (v0.13 seat reach: the chair came 7 px nearer its desk; the desk 7 px lower keeps the 20 px layout grid's pod
    //  desks landing on its chair and feet box without overlapping the desk, as at y 250 before)
    officeConfig.furniture = [{ id: 'd1', type: 'desk', x: 560, y: 257 }];
    const pod = tpls.find(x => x.id === 'room-desk-pod');
    for (let wy = 200; wy <= 420 && !out.chair; wy += 4) for (let wx = 440; wx <= 680 && !out.chair; wx += 4) {
      const c = OfficeLayouts.inspectAssetPlacement(pod, wx, wy);
      if (!c.valid && /chair of Desk|blocks its chair/.test(c.reason)) out.chair = c.reason;
    }
    return out;
  }, templates);
  t.ok(templates.length >= 8 && tp.inner.length === 0 && tp.free.length === 0, 'every room template keeps its own seats and spots clear and fits an empty office', JSON.stringify(tp).slice(0, 300));
  t.ok(tp.chair && /\. Move the layout to a clear area\.$/.test(tp.chair), 'a template over a desk chair is refused with the reason named', String(tp.chair));

  // 5b. Interior walls are part of the same rule: a piece never stands across one (it may stand against
  //     it), a wall never runs through a chair; a template's walls get the rule from the other side.
  const def = JSON.parse(fs.readFileSync(path.join(APP, 'default-office-config.json'), 'utf8'));
  const wl = await page.evaluate(({ tpls, def }) => {
    const out = {};
    const P = (t, x, y, r) => _placementProblem(t, x, y, r || 0, null);
    officeConfig.furniture = [];
    officeConfig.walls.interior = [{ x1: 20, y1: 3, x2: 20, y2: 9 }, { x1: 6, y1: 10, x2: 14, y2: 10 }];  // x = 800, y = 400
    out.acrossV = P('desk', 800, 240); out.hitV = _placementHit && [_placementHit.x, _placementHit.w];
    out.besideV = [P('desk', 760, 240), P('desk', 840, 240)];
    out.acrossH = [396, 400, 404].map(y => P('desk', 400, y));      // the plan's back 22 / 18 / 14 px over the line
    out.againstH = [406, 420].map(y => P('desk', 400, y));          // 12 px over (against the wall), clear
    out.cabinets = [P('filingCabinet', 400, 363), P('filingCabinet', 400, 361)];  // 12 px back (the default office) / 14
    out.chair90 = P('desk', 830, 240, 90);
    // a template's walls: through a piece, over a chair, over a vending machine's front, in front of a piece
    officeConfig.walls.interior = [];
    officeConfig.furniture = [{ id: 'd', type: 'desk', x: 400, y: 300 }, { id: 'v', type: 'vendingMachine', x: 700, y: 300 }];
    const L = (w) => _layoutWallsProblem([w], { x: 0, y: 0 });
    out.lw = [L({ x1: 10, y1: 6, x2: 10, y2: 9 }), L({ x1: 9, y1: 8, x2: 11, y2: 8 }), L({ x1: 17, y1: 9, x2: 20, y2: 9 }),
      L({ x1: 17, y1: 10, x2: 19, y2: 10 }), L({ x1: 2, y1: 12, x2: 6, y2: 12 })];
    officeConfig.furniture = [{ id: 'v', type: 'vendingMachine', x: 700, y: 300 }];
    out.lwFront = _layoutWallsProblem([{ x1: 17, y1: 9, x2: 19, y2: 9 }], { x: 0, y: 20 });  // y 380: 6 px from its front spot
    const wt = { id: 'wall-test', name: 'Wall test', bounds: { width: 160, height: 160 }, objects: { furniture: [], walls: [{ x1: 2, y1: 0, x2: 2, y2: 4 }] } };
    officeConfig.furniture = [{ id: 'd', type: 'desk', x: 400, y: 300 }];
    for (let wy = 200; wy <= 420 && !out.tpl; wy += 8) for (let wx = 300; wx <= 520 && !out.tpl; wx += 8) {
      const c = OfficeLayouts.inspectAssetPlacement(wt, wx, wy);
      if (!c.valid && /^A wall of the layout runs through Desk\./.test(c.reason)) out.tpl = c.reason;
    }
    // no false alarms: the default office and every template (its own walls) pass
    out.def = (def.furniture || []).filter(f => _wallThrough(f, _wallSegs(def.walls.interior))).map(f => f.type + '@' + f.x + ',' + f.y);
    out.tpls = [];
    tpls.forEach(tp => (tp.objects.furniture || []).forEach(f => { if (_wallThrough(f, _wallSegs(tp.objects.walls))) out.tpls.push(tp.id + ' ' + f.type); }));
    return out;
  }, { tpls: templates, def });
  t.ok(wl.acrossV === 'A wall is in the way' && wl.hitV && wl.hitV[1] === 6 && wl.besideV.every(w => w === '') && wl.chair90 === 'The wall blocks its chair',
    'a desk across a vertical wall is refused (the wall shown as the blocker), beside it is fine, a wall through its chair is named', JSON.stringify(wl));
  t.ok(wl.acrossH.every(w => w === 'A wall is in the way') && wl.againstH.every(w => w === '') && wl.cabinets[0] === '' && wl.cabinets[1] === 'A wall is in the way',
    'a piece stands against a horizontal wall (its back up to 12 px over the line, as the default office) but never across it', JSON.stringify(wl));
  t.ok(wl.lw[0] === 'A wall of the layout runs through Desk' && wl.lw[1] === 'A wall of the layout blocks the chair of Desk' &&
    wl.lw[2] === 'A wall of the layout runs through Vending Machine' && wl.lw[3] === 'A wall of the layout stands in front of Vending Machine' && wl.lw[4] === '' &&
    wl.lwFront === "A wall of the layout blocks the vending machine's front" && /\. Move the layout to a clear area\.$/.test(wl.tpl || ''),
    "a template's walls are refused through a piece, over its chair or front, in front of it, with the reason named", JSON.stringify(wl));
  t.ok(wl.def.length === 0 && wl.tpls.length === 0, 'no false alarms: the default office and every room template stand clear of their walls', JSON.stringify([wl.def, wl.tpls]));

  // 5c. Clearance (the body-box rule) is part of the rule and agrees with the runtime bands: a plant slid past a
  //     piece's seat / stand spot, and the piece slid past a plant: accepted = a person there is in no band, 'Too
  //     close' = they would be. The TV's viewing spot is soft; the default office passes the whole rule.
  const clr = await page.evaluate((def) => {
    officeConfig.walls.interior = [];
    const out = { cases: 0, close: 0, own: 0, bad: [], names: {} };
    const bandAt = (items, s) => { officeConfig.furniture = items; buildCollisionGrid(); return _clrAt(s.x, s.y, CLR.tol); };
    [['vendingMachine', 600, 300], ['waterCooler', 600, 300], ['bookshelf', 600, 300], ['desk', 600, 300], ['pingPongTable', 600, 300]].forEach(([type, x, y]) => {
      const A = { id: 'a', type, x, y };
      _useSpaces(A).filter(s => s.feet && !s.held).forEach(s => {
        for (let dx = -64; dx <= 64; dx += 4) for (const dy of [-40, -30, -20]) {
          officeConfig.furniture = [A];
          const why = _placementProblem('tallPlant', s.x + dx, s.y + dy, 0, null, 0);
          if (why && !/^Too close/.test(why)) continue;
          const band = bandAt([A, { id: 'p', type: 'tallPlant', x: s.x + dx, y: s.y + dy }], s);
          out.cases++; if (why) { out.close++; out.names[why] = 1; }
          if (!!why !== !!band) out.bad.push(`${type} plant ${dx},${dy}: "${why}" band ${band && band.kind}`);
        }
        // the piece slid past a fixed plant: its own spot
        const Pl = { id: 'p', type: 'tallPlant', x: s.x, y: s.y - 30 };
        for (let dx = -64; dx <= 64; dx += 4) {
          officeConfig.furniture = [Pl];
          const Q = { id: 'a', type, x: x + dx, y }, why = _placementProblem(type, Q.x, Q.y, 0, null, 0);
          if (why && !/is too close to/.test(why)) continue;
          const qs = _useSpaces(Q).find(q => q.feet && q.what === s.what && Math.abs(q.x - (s.x + dx)) < 1);
          if (!qs) continue;
          const band = bandAt([Pl, Q], qs);
          out.cases++; if (why) { out.own++; out.names[why] = 1; }
          if (!!why !== !!band) out.bad.push(`${type} own ${dx}: "${why}" band ${band && band.kind}`);
        }
      });
    });
    officeConfig.furniture = [{ id: 't', type: 'tv', x: 475, y: 203 }];
    out.tvSoft = _placementProblem('coffeeTable', 468, 243, 0, null, 0);
    officeConfig.walls.interior = def.walls.interior;
    officeConfig.furniture = def.furniture.map((f, i) => Object.assign({ id: 'k' + i }, f));
    out.def = officeConfig.furniture.map(f => [f.type, _placementProblem(f.type, f.x, f.y, f.rotation || 0, [f.id], 0)]).filter(p => p[1]);
    return out;
  }, def);
  t.ok(clr.bad.length === 0 && clr.close > 10 && clr.own > 3 && clr.cases > 200,
    "the editor's clearance agrees with the bands both ways (a person at a seat or stand spot beside a piece's art is refused, 'Too close to ...')",
    JSON.stringify(clr).slice(0, 500));
  t.ok(clr.tvSoft === '' && clr.def.length === 0, 'the TV viewing spot is soft (coffee table in front of it) and the default office passes the whole rule', JSON.stringify([clr.tvSoft, clr.def]));
  t.ok(errors.length === 0, 'no page errors (editor)', errors.join(' | ').slice(0, 300));
  await page.context().close();

  // 6. A layout edit with people at desks, on the couch and at a stand spot.
  const roster = ['Alpha', 'Bravo', 'Cara', 'Dex'].map(n => ({ id: n.toLowerCase(), statusKey: n.toLowerCase(), name: n, emoji: '🙂', role: 'Tester', providerKind: 'openclaw', available: true }));
  const office = officeFixture();
  office.walls.interior = [];
  office.furniture = [{ id: 'd1', type: 'desk', x: 300, y: 300, assignedTo: 'Alpha' }, { id: 'd2', type: 'desk', x: 460, y: 300, assignedTo: 'Bravo' },
    { id: 'c1', type: 'couch', x: 600, y: 520 }, { id: 'v1', type: 'vendingMachine', x: 300, y: 500 }, { id: 'k1', type: 'kitchenCounter', x: 840, y: 200 }];
  const two = await openEditor(browser, { office, agents: roster, status: Object.fromEntries(roster.map(r => [r.id, { state: 'idle', task: '' }])) });
  const people = await two.page.evaluate(() => {
    window.__voWorldCheck = 'every'; VOWorld.reset();
    window._runSimulation = function () { return 0; };  // only our steps move people
    const A = n => agents.find(a => a.name === n);
    const run = (n) => { for (let i = 0; i < n; i++) _simulationStep(); };
    const inFp = (p) => !p.isSitting && !!_feetIn(p.x, p.y);  // a sitter at a desk is at its origin (W2 seat)
    const out = { steps: [] };
    const cara = A('Cara'), dex = A('Dex');
    const vend = _itemStandWorld(officeConfig.furniture.find(f => f.id === 'v1'))[0];
    cara.targetX = vend.x; cara.targetY = vend.y; cara.idleAction = 'wander'; cara.idleReturnTimer = 1e7; cara.idleTimer = 1e9;
    const seat = _worldSeats().find(s => s.item.id === 'c1');
    dex.targetX = seat.x; dex.targetY = seat.y; dex.idleAction = 'couch'; dex.idleReturnTimer = 1e7; dex.idleTimer = 1e9;
    ['Alpha', 'Bravo'].forEach(n => { A(n).idleTimer = 1e9; });
    run(1500);
    const snap = () => agents.map(a => ({ n: a.name, x: Math.round(a.x), y: Math.round(a.y), sit: !!a.isSitting, inFp: inFp(a) }));
    out.steps.push({ at: 'start', ppl: snap(), cara: [vend.x, vend.y] });
    // move desk d1 (the editor's drag end), Alpha follows
    const d1 = officeConfig.furniture.find(f => f.id === 'd1'); d1.x += 120; d1.y += 120;
    buildCollisionGrid(); _syncAllDeskAssignments(); run(1500);
    out.alpha = { x: Math.round(A('Alpha').x), y: Math.round(A('Alpha').y), sit: A('Alpha').isSitting, desk: [d1.x, d1.y] };
    // move the couch with Dex on it
    const d0 = { x: dex.x, y: dex.y };
    const c1 = officeConfig.furniture.find(f => f.id === 'c1'); c1.y -= 60;
    buildCollisionGrid(); run(300);
    out.dex = { from: [Math.round(d0.x), Math.round(d0.y)], x: Math.round(dex.x), y: Math.round(dex.y), sit: dex.isSitting, inFp: inFp(dex) };
    // a bookshelf dropped on Cara's feet
    const c0 = { x: cara.x, y: cara.y };
    officeConfig.furniture.push({ id: 'b1', type: 'bookshelf', x: Math.round(cara.x) - 25, y: Math.round(cara.y) - 66 });
    buildCollisionGrid(); run(300);
    out.cara = { from: [Math.round(c0.x), Math.round(c0.y)], x: Math.round(cara.x), y: Math.round(cara.y), inFp: inFp(cara) };
    // delete the vending machine she was using, then desk d2 with Bravo at it
    selectedItemId = 'v1'; _deleteSelectedItem(); run(300);
    out.caraAfterDelete = { x: Math.round(cara.x), y: Math.round(cara.y), inFp: inFp(cara) };
    const b0 = { x: A('Bravo').x, y: A('Bravo').y };
    selectedItemId = 'd2'; _deleteSelectedItem(); run(1500);
    const bravo = A('Bravo');
    out.bravo = { from: [Math.round(b0.x), Math.round(b0.y)], x: Math.round(bravo.x), y: Math.round(bravo.y), sit: bravo.isSitting, inFp: inFp(bravo), mid: [W / 2, H / 2] };
    out.hits = VOWorld.log().length + VOWorld.check().length;
    out.log = VOWorld.log().slice(0, 2);
    out.end = snap();
    return out;
  });
  const st0 = people.steps[0].ppl;
  t.ok(st0.find(p => p.n === 'Alpha').sit && st0.find(p => p.n === 'Bravo').sit && st0.find(p => p.n === 'Dex').sit,
    'people start at their desks and on the couch', JSON.stringify(people.steps[0]));
  t.ok(people.alpha.sit && Math.abs(people.alpha.x - people.alpha.desk[0]) <= 1 && Math.abs(people.alpha.y - people.alpha.desk[1]) <= 1,
    'a moved desk takes its owner along (seated at the new place)', JSON.stringify(people.alpha));
  const dist = (o) => Math.hypot(o.x - o.from[0], o.y - o.from[1]);
  t.ok(!people.dex.sit && !people.dex.inFp && dist(people.dex) < 120, 'moving the couch stands its sitter up nearby, not inside it', JSON.stringify(people.dex));
  t.ok(!people.cara.inFp && dist(people.cara) < 90 && !people.caraAfterDelete.inFp, 'a piece put on a standing person moves them to free floor nearby; deleting the piece she used leaves her on free floor', JSON.stringify([people.cara, people.caraAfterDelete]));
  t.ok(!people.bravo.inFp && !(Math.abs(people.bravo.x - people.bravo.mid[0]) < 6 && Math.abs(people.bravo.y - people.bravo.mid[1]) < 6),
    'deleting a desk with its owner at it rehomes them (no jump to the middle)', JSON.stringify(people.bravo));
  t.ok(people.hits === 0 && people.end.every(p => !p.inFp), 'the world invariant stays quiet through the layout edit', JSON.stringify({ hits: people.hits, log: people.log, end: people.end }));
  t.ok(two.errors.length === 0, 'no page errors (people)', two.errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}
t.done();
