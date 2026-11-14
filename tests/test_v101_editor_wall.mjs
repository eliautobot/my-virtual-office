// v0.10.1 N9: floor pieces never land on a wall band; the delete message names the item.
// 1) a plant pointed at the top wall lands on the floor right under it (the ghost and the click share the candidate);
//    a drag/nudge/duplicate to the wall band is refused with a plain reason;
// 2) pieces standing against the top wall the way the default office has them stay valid; wall pieces (window,
//    notice board, clock), counter appliances and labels keep their own rules;
// 3) an interior wall's face is a wall band too, on any layout;
// 4) a label is clicked and selected, and deleting it says "Deleted label LOUNGE" (a plant: "Deleted Plant").
import assert from 'node:assert/strict';
import { launch, openPage, reporter, FIXTURES } from './test_v10_ui_lib.mjs';

const NAME = 'test_v101_editor_wall';
const browser = await launch(NAME);
const r = reporter();
const cfg = JSON.parse(JSON.stringify(FIXTURES['/api/office-config']));
cfg.walls.height = 90;
cfg.walls.interior = [{ x1: 12, y1: 10, x2: 20, y2: 10 }];
cfg.furniture.push({ id: 'lbl', type: 'textLabel', x: 160, y: 40, text: 'LOUNGE' },
    { id: 'vm', type: 'vendingMachine', x: 900, y: 40 }, { id: 'bk', type: 'bookshelf', x: 700, y: 20 });
try {
    const { context, page, errors } = await openPage(browser, { fixtures: { '/api/office-config': cfg } });
    await page.evaluate(() => { if (window._voLicense) window._voLicense.demo = false; window.saveOfficeConfig = function () {}; });
    await page.evaluate(() => toggleEditMode()); await page.waitForTimeout(600);
    const a = await page.evaluate(() => {
        const wallH = officeConfig.walls.height;
        const base = (t, p) => _floorBaseLine(t, p.x, p.y, p.rotation || 0, _getItemWorldRect({ type: t, x: p.x, y: p.y, rotation: p.rotation || 0 })).y;
        const c = _placementCandidate('plant', 300, 20);
        return { wallH, cand: c, candBase: base('plant', c), onWall: _placementProblem('plant', 300, 13, 0, null),
            existing: officeConfig.furniture.map(it => it.id + ':' + _placementProblem(it.type, it.x, it.y, it.rotation || 0, [it.id])).filter(s => !/:$/.test(s)),
            wallPieces: ['interactiveWindow', 'noticeBoard', 'clock', 'textLabel', 'branchSign'].filter(t => FURNITURE_BOUNDS[t])
                .map(t => t + ':' + _floorContactProblem(t, 300, 20, 0, _getItemWorldRect({ type: t, x: 300, y: 20 }), wallH)).filter(s => !/:$/.test(s)) };
    });
    assert.ok(a.candBase >= a.wallH - 12, `plant lands on the floor: base ${a.candBase} (wall ${a.wallH}) ` + JSON.stringify(a.cand));
    assert.ok(!/wall/.test(a.cand.reason), a.cand.reason);
    assert.equal(a.onWall, 'Floor items go on the floor, not on the wall');
    r.pass(`top wall: a plant pointed at the wall lands on the floor (y ${a.cand.y}); one dragged onto the wall is refused`);
    assert.deepEqual(a.existing, [], 'pieces against the wall stay valid');
    assert.deepEqual(a.wallPieces, [], 'wall pieces and labels keep their rules');
    r.pass('vending machine and bookshelf against the top wall stay valid; windows, boards, clocks and labels unaffected');
    const iw = await page.evaluate(() => {
        // The interior wall runs y = 10 tiles; its face is the band above that line.
        const line = 10 * TILE, x = 16 * TILE;
        const at = baseY => { const b = _floorBaseLine('plant', x, 0, 0, _getItemWorldRect({ type: 'plant', x, y: 0 })); return _placementProblem('plant', x, baseY - b.y, 0, null); };
        return { face: at(line - 20), front: at(line + 30), behind: at(line - 60) };
    });
    assert.equal(iw.face, 'Floor items cannot stand on a wall');
    assert.ok(!/wall/.test(iw.front) && !/wall/.test(iw.behind), JSON.stringify(iw));
    r.pass('interior wall: standing on its face is refused, in front of it and behind it is fine');
    // 4) click the label: it is selected; Delete names it.
    const flashes = [];
    await page.exposeFunction('__flash', t => flashes.push(t));
    await page.evaluate(() => window.addEventListener('vo:editor-flash', e => window.__flash(e.detail.text)));
    const pt = await page.evaluate(() => _worldToScreen(160, 40));
    await page.mouse.click(pt.x, pt.y); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => selectedItemId), 'lbl', 'clicking the wall label selects it');
    await page.evaluate(() => _deleteSelectedItem()); await page.waitForTimeout(100);
    const p = await page.evaluate(() => { officeConfig.furniture.push({ id: 'pl', type: 'plant', x: 300, y: 300 }); selectedItemId = 'pl'; _deleteSelectedItem(); });
    await page.waitForTimeout(100);
    assert.deepEqual(flashes, ['Deleted label LOUNGE', 'Deleted Plant']);
    r.pass('a click selects the label; delete says "Deleted label LOUNGE" and "Deleted Plant"');
    assert.deepEqual(errors, []);
    await context.close();
} finally {
    await browser.close();
}
r.done(NAME);
