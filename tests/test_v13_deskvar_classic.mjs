// v0.13 desk variants: an existing desk / boss desk (no variant, or variant "classic" with colour "wood") draws
// its desk art pixel-identical to 0.12 in every rotation, screen on and off, and keeps the desk's geometry
// (footprints, monitor rects, the top). v0.13 seat reach (review 11-13) moves the chair and the sitter in: the chair
// is part of the static desk drawing, so the desk art is compared with the chair drawers switched off (artHash),
// and the seat moved exactly by the seat reach (SHIFT; desk-top spots, views and legs unchanged, side floor points
// where they were). The reference is tests/fixtures/v13-classic-desks.json, dumped from 0.12 (161b407) with
// V13_DUMP=<file> on a copy of that tree. Fails on 0.12 itself: the variant API (FURNITURE_VARIANTS, explicit
// "classic"/"wood" items) does not exist there.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launch, openPage, reporter } from './test_v10_ui_lib.mjs';

const NAME = 'test_v13_deskvar_classic';
const here = path.dirname(fileURLToPath(import.meta.url));
const DUMP = process.env.V13_DUMP || '';
const REF = path.join(here, 'fixtures', 'v13-classic-desks.json');
// v0.13 classic boss desk 40 deep (review 11-13 "the boss desk is too wide on the 0deg view", like every boss variant;
// 0.12: 48): its art is compared with tests/fixtures/v13-classic-boss40.json (dumped with V13_DUMP_BOSS40=<file>
// at the commit that made it 40 deep) and its geometry with 0.12's minus the back 8 px: the footprint and the top
// lose their back strip, the screens move 8 px forward, the item / drink spots too (SPOTS40), the seat as the seat reach left it. The classic desk stays pixel-identical to 0.12.
const BOSS40 = path.join(here, 'fixtures', 'v13-classic-boss40.json');
const DUMP40 = process.env.V13_DUMP_BOSS40 || '';
const BACK = 8;
const fwd = rot => ({ 0: [0, BACK], 90: [-BACK, 0], 180: [0, -BACK], 270: [BACK, 0] })[rot];  // plan +y turned
// a 0.12 rect (array or {x,y,w,h}) without its back strip (the back edge = plan -y turned)
function shrinkBack(r, rot) {
    const a = Array.isArray(r) ? r.slice() : [r.x, r.y, r.w, r.h];
    if (rot === 0) { a[1] += BACK; a[3] -= BACK; } else if (rot === 90) a[2] -= BACK;
    else if (rot === 180) a[3] -= BACK; else { a[0] += BACK; a[2] -= BACK; }
    return Array.isArray(r) ? a : Object.assign({}, r, { x: a[0], y: a[1], w: a[2], h: a[3] });
}
const moveBy = (r, [dx, dy]) => Object.assign({}, r, { x: r.x + dx, y: r.y + dy }, r.bx != null ? { bx: r.bx + dx, by: r.by + dy } : {});
const movePt = (p, [dx, dy]) => Array.isArray(p) ? [p[0] + dx, p[1] + dy] : p && Object.assign({}, p, { x: p.x + dx, y: p.y + dy });
// the desk-top spots' move (game.js bossDesk surface): forward with the screens (90: the drink 2 px, its cup clear of
// the sitter's forearms); 180: onto the near edge in front of the casing backs (their tops came 8 px nearer the far
// edge, where the item stood), at the outer corners (the sitter draws the casings again over its torso); 270: the
// item 6 px (the widest item clear of the keys), the drink 1 px out and 2 px down (clear of the papers and the sitter)
const SPOTS40 = { 0: { item: [0, BACK], food: [0, BACK] }, 90: { item: [-BACK, 0], food: [-2, 0] }, 180: { item: [4, 21], food: [-7, 21] },
    270: { item: [6, 0], food: [1, 2] } };
// the classic desk's spots after the seat reach (the sitter 5 px further north at 270: the drink 2 px out, 1 px down)
const DESK_SPOTS = { 270: { food: [-2, 1] } };
// the 0.12 reference of a boss desk case as the 40-deep desk has it
function boss40(rot, b) {
    const geo = Object.assign({}, b.geo), f = fwd(rot);
    geo.foot = b.geo.foot && b.geo.foot.map(r => shrinkBack(r, rot));
    geo.top = b.geo.top && shrinkBack(b.geo.top, rot);
    geo.mon = b.geo.mon && b.geo.mon.map(r => moveBy(r, f));
    const sp = SPOTS40[rot];
    geo.seat = Object.assign({}, b.geo.seat, { item: movePt(b.geo.seat.item, sp.item), food: movePt(b.geo.seat.food, sp.food) });
    return Object.assign({}, b, { geo });
}

// v0.13 seat reach: the hips' move per rotation [dx, dy] (game.js FURNITURE_MANIFEST desk / bossDesk seats)
const SHIFT = { desk: { 0: [0, -9], 90: [1, 0], 180: [0, 1], 270: [-1, -5] }, bossDesk: { 0: [0, -4], 90: [0, 0], 180: [0, 4], 270: [0, -5] } };
// geometry of the desk itself (not the chair): identical to 0.12
const STABLE = ['foot', 'mon', 'top'];
// ... without what follows the sitter: a turned screen's night-glow centre (fx, fy: between the screen and the hips)
const desk = (g, v) => g === 'mon' && Array.isArray(v) ? v.map(({ fx, fy, ...r }) => r) : v;
// a seat (DESK_SEAT entry) vs its 0.12 reference: moved by SHIFT, the rest as it was ('' = ok)
function seatMoved(type, rot, a, b) {
    const [dx, dy] = SHIFT[type][rot], side = rot === 90 || rot === 270, out = [], ds = type === 'desk' && DESK_SPOTS[rot];
    if (ds) b = Object.assign({}, b, { food: movePt(b.food, ds.food) });
    if (a.hx !== b.hx + dx || a.hy !== b.hy + dy) out.push(`hips ${a.hx},${a.hy} vs 0.12 ${b.hx},${b.hy} + ${dx},${dy}`);
    for (const k of ['legs', 'view', 'over', 'item', 'food', 'papers', 'wide']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
    // the walk's end: beside a turned desk where it was; in front / behind the chair base, with the chair
    // (the desk at 0: at the chair part's front, 2 px past the drawn chair's base)
    const fw = side ? b.floor : [b.floor[0] + dx, b.floor[1] + dy + (type === 'desk' && !rot ? 2 : 0)];
    if (JSON.stringify(a.floor) !== JSON.stringify(fw)) out.push(`floor ${a.floor} vs ${fw}`);
    if (b.cut && JSON.stringify(a.cut) !== JSON.stringify([b.cut[0] + dx, b.cut[1] + dy, b.cut[2], b.cut[3]])) out.push('cut ' + a.cut);
    // the name tag stays where it was (desk: the tag above the screen; tagDy = tagY + 68 is measured from the desk spot,
    // not the hips, so tagY itself stays) or rides with the head (boss: default)
    const tg = b.tagY;
    if (a.tagY !== tg) out.push(`tagY ${a.tagY} vs ${tg}`);
    return out.join('; ');
}

// Renders and measures one item in the page (no agents near it, world origin far from the office).
function probe(args) {
    const { type, rot, use, extra } = args;
    const it = Object.assign({ id: 'cl-' + type + rot, type, x: 600, y: 470, rotation: rot }, extra || {});
    if (!rot) delete it.rotation;
    officeConfig.furniture = [it];
    _worldChanged && _worldChanged();
    const live = officeConfig.furniture[0];
    const c = document.createElement('canvas'); c.width = 320; c.height = 320;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    const saved = window.ctx;
    const inUse = window._deskInUse;
    window._deskInUse = () => use;   // screen on (in use) / off
    const shot = () => {  // FNV hash + opaque count of the static drawing
        let hash = 0x811c9dc5, opaque = 0;
        g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
        g.setTransform(2, 0, 0, 2, 160 - 2 * live.x, 180 - 2 * live.y);  // origin at (160, 180): world x +-80, y -90..70
        drawFurnitureItem(live, { staticOnly: true });
        const d = g.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i++) { hash ^= d[i]; hash = Math.imul(hash, 16777619) >>> 0; }
        for (let i = 3; i < d.length; i += 4) if (d[i]) opaque++;
        return [hash.toString(16), opaque];
    };
    // the desk art without its chair (seat reach moves the chair): the chair drawers switched off
    const CH = ['_drawChairRear', '_drawSeatChair', '_drawSideChair'], keep = CH.map(n => window[n]);
    let hash, opaque, artHash, artOpaque;
    try {
        window.ctx = g;
        [hash, opaque] = shot();
        CH.forEach(n => { window[n] = function() {}; });
        [artHash, artOpaque] = shot();
    } finally { CH.forEach((n, i) => { window[n] = keep[i]; }); window.ctx = saved; window._deskInUse = inUse; }
    const R = o => o && JSON.parse(JSON.stringify(o));
    const geo = {
        art: R(_getItemWorldRect(live)),
        foot: R(_itemFootprints(live)),
        depth: R(_depthParts(live).map(p => ({ rect: p.rect, y: p.y, part: p.part || null, chair: !!p.chair, clip: p.clip }))),
        mon: R(_deskMonitorRects(live)),
        seat: R((({ hx, hy, legs, view, cut, over, floor, item, food, papers, tagY, wide }) => ({ hx, hy, legs, view, cut, over, floor, item, food, papers, tagY, wide }))(Object.assign({ wide: !!DESK_SEAT[type].wide }, _deskSeatSpot(live)))),
        seatsWorld: R(_itemSeatsWorld(live)),
        top: R(_deskTopRect(live)),
        bands: R(typeof _clrBodyRects === 'function' ? _clrBodyRects(live) : null),
    };
    return { hash, opaque, artHash, artOpaque, geo };
}

const browser = await launch(NAME);
const R = reporter();
try {
    const { page, errors } = await openPage(browser, {});
    await page.waitForTimeout(1500);
    const hasApi = await page.evaluate(() => typeof FURNITURE_VARIANTS !== 'undefined');
    const cases = [];
    for (const type of ['desk', 'bossDesk']) for (const rot of [0, 90, 180, 270]) for (const use of [true, false]) cases.push({ type, rot, use });
    const out = {};
    for (const cs of cases) out[cs.type + '/' + cs.rot + '/' + (cs.use ? 'on' : 'off')] = await page.evaluate(probe, cs);
    if (DUMP) {
        fs.writeFileSync(DUMP, JSON.stringify(out, null, 1));
        console.log('dumped ' + Object.keys(out).length + ' cases to ' + DUMP);
    } else if (DUMP40) {
        const o = {};
        for (const k of Object.keys(out)) if (k.startsWith('bossDesk/')) o[k] = { artHash: out[k].artHash, artOpaque: out[k].artOpaque };
        fs.writeFileSync(DUMP40, JSON.stringify(o, null, 1) + '\n');
        console.log('dumped ' + Object.keys(o).length + ' boss desk cases to ' + DUMP40);
    } else {
        assert.ok(hasApi, 'FURNITURE_VARIANTS exists (the variant API)');
        const ref = JSON.parse(fs.readFileSync(REF, 'utf8')), ref40 = JSON.parse(fs.readFileSync(BOSS40, 'utf8'));
        let bad = [];
        for (const k of Object.keys(ref)) {
            const boss = k.startsWith('bossDesk/');
            const a = out[k], b = boss ? Object.assign(boss40(+k.split('/')[1], ref[k]), ref40[k]) : ref[k];
            if (!a) { bad.push(k + ' missing'); continue; }
            if (a.artHash !== b.artHash || a.artOpaque !== b.artOpaque) bad.push(k + ' desk art ' + a.artHash + '/' + a.artOpaque + ' vs ' + b.artHash + '/' + b.artOpaque);
            for (const g of STABLE) if (JSON.stringify(desk(g, a.geo[g])) !== JSON.stringify(desk(g, b.geo[g]))) bad.push(k + ' ' + g + ' differs');
            const why = seatMoved(k.split('/')[0], +k.split('/')[1], a.geo.seat, b.geo.seat);
            if (why) bad.push(k + ' seat: ' + why);
        }
        assert.deepEqual(bad, [], 'classic desks identical to 0.12 but the seat reach (boss desk: 40 deep)');
        R.pass('desk and boss desk without a variant: the desk art (chair off) and the desk geometry identical to 0.12, the boss desk 40 deep (0.12 minus its back 8 px; 16 cases: 4 rotations x screen on/off)');
        R.pass('the seat moved by the seat reach only (desk ' + JSON.stringify(SHIFT.desk) + ', boss ' + JSON.stringify(SHIFT.bossDesk) + '): spots, views, legs, side floor points as 0.12');
        // explicit variant "classic" + colour "wood" (what the editor writes) is the same desk
        bad = [];
        for (const cs of cases) {
            const r = await page.evaluate(probe, Object.assign({ extra: { variant: 'classic', color: 'wood' } }, cs));
            const b = out[cs.type + '/' + cs.rot + '/' + (cs.use ? 'on' : 'off')];
            const k = cs.type + '/' + cs.rot + '/' + (cs.use ? 'on' : 'off');
            if (r.hash !== b.hash || r.artHash !== (cs.type === 'bossDesk' ? ref40 : ref)[k].artHash) bad.push(cs.type + '/' + cs.rot);
            for (const g of Object.keys(b.geo)) if (JSON.stringify(r.geo[g]) !== JSON.stringify(b.geo[g])) bad.push(cs.type + '/' + cs.rot + ' ' + g);
        }
        assert.deepEqual(bad, [], 'variant classic + colour wood identical');
        R.pass('variant "classic" with colour "wood" is the same desk (pixels and geometry)');
        // an unknown variant / colour from a newer or hand-edited office falls back to classic / the default colour
        bad = [];
        for (const cs of cases.filter(c => c.use)) {
            const r = await page.evaluate(probe, Object.assign({ extra: { variant: 'zz-no-such', color: 'zz-nope' } }, cs));
            if (r.hash !== out[cs.type + '/' + cs.rot + '/on'].hash) bad.push(cs.type + '/' + cs.rot);
        }
        assert.deepEqual(bad, [], 'unknown variant/colour falls back');
        R.pass('an unknown variant or colour id draws the classic desk in its default colour');
        // a recoloured classic desk really changes (the colour slots reach the art) and keeps the geometry
        const r0 = await page.evaluate(probe, { type: 'desk', rot: 0, use: true, extra: { color: 'black' } });
        const r1 = await page.evaluate(probe, { type: 'bossDesk', rot: 90, use: true, extra: { color: 'white' } });
        assert.ok(r0.hash !== out['desk/0/on'].hash && r1.hash !== out['bossDesk/90/on'].hash, 'recolour changes the pixels');
        assert.equal(JSON.stringify(r0.geo), JSON.stringify(out['desk/0/on'].geo));
        R.pass('a recoloured classic desk changes colour only (same geometry)');
    }
    assert.deepEqual(errors, []);
    R.pass('no page errors');
} finally {
    await browser.close();
}
R.done(NAME);
