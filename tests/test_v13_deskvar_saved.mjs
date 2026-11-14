#!/usr/bin/env node
// v0.13 desk variants and saved offices (seeded page, manual clock: the same frame every run):
//  1. an office saved by 0.12 (desks and boss desks in all 4 rotations, working agents, no variant / color fields)
//     loads every desk as the classic in wood, each desk and the office frame are pixel-identical to 0.12's with the
//     chair drawers off (v0.13 seat reach moved every chair in; the chairs themselves differ) (hashes recorded
//     from 161b407: V13_RECORD=1 VO_APP_DIR=<0.12 app> node tests/test_v13_deskvar_saved.mjs), and saving it again
//     adds no variant / color field (0.12 reads it back unchanged);
//  2. variants and colours survive a save and a reload: the posted office opens on a fresh page with the same
//     variants, colours and rotations and every desk draws the same art.
// Fails on 0.12 for 2 (the variants load as classic desks). Run: node tests/test_v13_deskvar_saved.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOffice, checker, defaultOffice } from './v12_pets_page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REF = path.join(here, 'fixtures', 'v13-saved-012.json');
const RECORD = process.env.V13_RECORD === '1';
// v0.13 classic boss desk 40 deep (0.12: 48, review 11-13 "the boss desk is too wide on the 0deg view"): the boss desks
// (b*) and the office frame (it has boss desks) compare with tests/fixtures/v13-saved-boss40.json, recorded at the
// commit that made it 40 deep (V13_RECORD_BOSS40=1); the desks (a*) stay 0.12's, every boss desk differs from 0.12.
const REF40 = path.join(here, 'fixtures', 'v13-saved-boss40.json');
const RECORD40 = process.env.V13_RECORD_BOSS40 === '1';
const isBoss = id => id[0] === 'b';
const T = checker();
const P = [['a0', 'Ann'], ['a1', 'Ben'], ['a2', 'Cy'], ['a3', 'Dee'], ['b0', 'Eve'], ['b1', 'Fox']];
const ROSTER = P.map(([k, n]) => ({ id: k, statusKey: k, name: n, emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }));
const STATUS = Object.fromEntries(P.map(([k], i) => [k, { state: i % 2 ? 'idle' : 'working', task: i % 2 ? '' : 'Saving the office', activeToolCount: i % 2 ? 0 : 1 }]));

function office012() {
    const o = defaultOffice();
    o.canvasWidth = 1440; o.canvasHeight = 900; o.walls.interior = [];
    o.furniture = [
        { id: 'a0', type: 'desk', x: 200, y: 250, assignedTo: 'Ann' },
        { id: 'a1', type: 'desk', x: 480, y: 250, rotation: 90, assignedTo: 'Ben' },
        { id: 'a2', type: 'desk', x: 760, y: 250, rotation: 180, assignedTo: 'Cy' },
        { id: 'a3', type: 'desk', x: 1040, y: 250, rotation: 270, assignedTo: 'Dee' },
        { id: 'a4', type: 'desk', x: 1280, y: 250 },
        { id: 'b0', type: 'bossDesk', x: 260, y: 600, assignedTo: 'Eve' },
        { id: 'b1', type: 'bossDesk', x: 640, y: 600, rotation: 90, assignedTo: 'Fox' },
        { id: 'b2', type: 'bossDesk', x: 980, y: 600, rotation: 180 },
        { id: 'b3', type: 'bossDesk', x: 1260, y: 600, rotation: 270 },
        { id: 'pl', type: 'plant', x: 60, y: 420 }
    ];
    return o;
}
// draws one frame (manual clock) and returns its hash + the desks as loaded. chairOff: the chair drawers switched off
// (v0.13 seat reach moves the chair of every desk in: the desk art itself stays 0.12's), static layer rebuilt
async function frame(page, chairOff) {
    return page.evaluate((chairOff) => {
        const CH = ['_drawChairRear', '_drawSeatChair', '_drawSideChair'], keep = CH.map(n => window[n]);
        if (chairOff) { CH.forEach(n => { window[n] = function() {}; }); _invalidateStaticLayer(); }
        try {
        for (let i = 0; i < 3; i++) { _lastDrawAt = -1e9; _sceneDirty = true; _renderFrame(performance.now()); }
        const c = document.getElementById('officeCanvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 0; for (let k = 0; k < d.length; k += 4) h = (Math.imul(h, 31) + d[k] + d[k + 1] * 7 + d[k + 2] * 13) | 0;
        // each desk's art as drawn (static, on its own canvas): what a variant + colour look like
        const g = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); g.canvas.width = 400; g.canvas.height = 400;
        const art = (f) => { const saved = window.ctx; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 400, 400); window.ctx = g; g.setTransform(1, 0, 0, 1, 200 - f.x, 220 - f.y);
            try { drawFurnitureItem(f, { staticOnly: true }); } finally { window.ctx = saved; }
            const q = g.getImageData(0, 0, 400, 400).data; let a = 0; for (let k = 0; k < q.length; k += 4) a = (Math.imul(a, 31) + q[k] + q[k + 1] * 7 + q[k + 2] * 13 + q[k + 3]) | 0; return a >>> 0; };
        const desks = officeConfig.furniture.filter(f => f.type === 'desk' || f.type === 'bossDesk').map(f => ({ id: f.id, rot: f.rotation || 0, v: f.variant || null, c: f.color || null,
            art: art(f), key: typeof _mk === 'function' ? _mk(f) : f.type, row: typeof _variantRow === 'function' ? _variantRow(f).id : 'classic', col: typeof _itemColor === 'function' ? _itemColor(f).id : 'wood' }));
        return { hash: h >>> 0, w: c.width, h: c.height, desks };
        } finally { if (chairOff) { CH.forEach((n, i) => { window[n] = keep[i]; }); _invalidateStaticLayer(); } }
    }, !!chairOff);
}
const open = (office) => openOffice('test_v13_deskvar_saved', { office, agents: ROSTER, status: STATUS, seed: 7, manual: true }, { width: 1600, height: 1000 });
const settle = async (page) => { await page.waitForTimeout(1500); await page.evaluate(() => { for (let i = 0; i < 40; i++) { window.__vAdvance(100); if (typeof _updateWorld === 'function') _updateWorld(); } }).catch(() => {}); };

// 1. the 0.12 office: each desk's art with its real agent (working / idle / free), and the whole frame of the same
//    office without agents (agents move on the real clock; a frame with them is not the same twice even on 0.12)
const empty = await openOffice('test_v13_deskvar_saved', { office: office012(), agents: [{ id: 'zz', statusKey: 'zz', name: 'Zed', emoji: '🤖', role: 'Tester', providerKind: 'openclaw', available: true }],
    status: { zz: { state: 'idle', task: '' } }, seed: 7, manual: true }, { width: 1600, height: 1000 });
let emptyFrame, emptyDesk;
try { await settle(empty.page); await empty.page.evaluate(() => agents.splice(0)); emptyFrame = await frame(empty.page); emptyDesk = await frame(empty.page, true); } finally { await empty.close(); }   // the one (unassigned) agent the page needs leaves
let o = await open(office012());
try {
    await settle(o.page);
    const f = await frame(o.page), fd = await frame(o.page, true);
    if (RECORD) {
        fs.mkdirSync(path.dirname(REF), { recursive: true });
        fs.writeFileSync(REF, JSON.stringify({ from: '161b407 (0.12)', w: emptyFrame.w, h: emptyFrame.h, empty: emptyFrame.hash,
            desks: Object.fromEntries(f.desks.map(d => [d.id, d.art])),
            emptyNoChair: emptyDesk.hash, desksNoChair: Object.fromEntries(fd.desks.map(d => [d.id, d.art])) }, null, 1) + '\n');
        console.log('recorded ' + REF);
        await o.close(); process.exit(0);
    }
    if (RECORD40) {
        fs.writeFileSync(REF40, JSON.stringify({ from: 'v0.13 classic boss desk 40 deep', emptyNoChair: emptyDesk.hash,
            desks: Object.fromEntries(f.desks.filter(d => isBoss(d.id)).map(d => [d.id, d.art])),
            desksNoChair: Object.fromEntries(fd.desks.filter(d => isBoss(d.id)).map(d => [d.id, d.art])) }, null, 1) + '\n');
        console.log('recorded ' + REF40);
        await o.close(); process.exit(0);
    }
    const ref = JSON.parse(fs.readFileSync(REF, 'utf8')), ref40 = JSON.parse(fs.readFileSync(REF40, 'utf8'));
    await T.check('an office saved by 0.12 loads every desk as the classic in wood', async () => {
        assert.equal(f.desks.length, 9);
        for (const d of f.desks) assert.deepEqual([d.key, d.row, d.col, d.v, d.c], [d.id[0] === 'a' ? 'desk' : 'bossDesk', 'classic', 'wood', null, null], JSON.stringify(d));
    });
    // v0.13 seat reach: the chair (part of the desk drawing) moved in; the desk art without it is 0.12's
    await T.check('every desk draws its desk art (chair off) pixel-identical to 0.12, the boss desks as the 40-deep reference (4 rotations, working / idle / free)', async () => {
        const want = Object.assign({}, ref.desksNoChair, ref40.desksNoChair);
        assert.deepEqual(Object.fromEntries(fd.desks.map(d => [d.id, d.art])), want);
        assert.deepEqual(fd.desks.filter(d => isBoss(d.id) && d.art === ref.desksNoChair[d.id]).map(d => d.id), [], 'every boss desk changed (40 deep)');
    });
    await T.check('the whole office frame (no agents, chairs off) is the recorded one (0.12 with the boss desks 40 deep)', async () => {
        assert.deepEqual([emptyDesk.w, emptyDesk.h, emptyDesk.hash], [ref.w, ref.h, ref40.emptyNoChair]);
        assert.notEqual(emptyDesk.hash, ref.emptyNoChair);
    });
    await T.check('the chairs moved in (seat reach): every desk with its chair differs from 0.12 (the boss desk at 90 too: 40 deep, its seat stays); boss desks as recorded', async () => {
        const same = f.desks.filter(d => d.art === ref.desks[d.id]).map(d => d.id);
        assert.deepEqual(same, []);
        assert.deepEqual(Object.fromEntries(f.desks.filter(d => isBoss(d.id)).map(d => [d.id, d.art])), ref40.desks);
    });
    await T.check('saved again it has no variant / color field (0.12 reads it back unchanged)', async () => {
        await o.page.evaluate(() => { _lastSavedOfficeJson = ''; saveOfficeConfig(); });
        await o.page.waitForTimeout(1200);
        const post = o.posts.filter(p => p.path === '/api/office-config').pop();
        assert.ok(post, 'posted');
        const desks = JSON.parse(post.body).furniture.filter(x => x.type === 'desk' || x.type === 'bossDesk');
        assert.equal(desks.length, 9);
        assert.ok(desks.every(x => !('variant' in x) && !('color' in x)), JSON.stringify(desks).slice(0, 200));
    });
} finally { await o.close(); }

// 2. variants + colours: switch, save, reload
const ov = office012();
Object.assign(ov.furniture[0], { variant: 'analyst', color: 'grey' });
Object.assign(ov.furniture[1], { variant: 'gamer', color: 'black-red' });
Object.assign(ov.furniture[3], { variant: 'standing', color: 'walnut' });
Object.assign(ov.furniture[6], { variant: 'command', color: 'black-gold' });
ov.furniture[4].x = 1320;   // room for the switch below
o = await open(ov);
let body = null, before = null;
try {
    await settle(o.page);
    await T.check('a switch and a recolour in the office (a4: classic -> gamer in black-cyan, b0: black)', async () => {
        const r = await o.page.evaluate(() => { const a4 = officeConfig.furniture.find(x => x.id === 'a4'), b0 = officeConfig.furniture.find(x => x.id === 'b0');
            return [_setItemVariant(a4, 'desk~gamer'), _setItemColor(a4, 'black-cyan'), _setItemColor(b0, 'black')]; });
        assert.deepEqual(r, [true, true, true], JSON.stringify(r));
        await o.page.waitForTimeout(1200);
        const post = o.posts.filter(p => p.path === '/api/office-config').pop();
        assert.ok(post, 'posted');
        body = JSON.parse(post.body);
        before = await frame(o.page);
    });
} finally { await o.close(); }
if (body) {
    o = await open(body);
    try {
        await settle(o.page);
        const after = await frame(o.page);
        await T.check('reloaded: the same variants, colours and rotations', async () => {
            const want = { a0: 'desk~analyst/grey/0', a1: 'desk~gamer/black-red/90', a2: 'desk/wood/180', a3: 'desk~standing/walnut/270', a4: 'desk~gamer/black-cyan/0',
                b0: 'bossDesk/black/0', b1: 'bossDesk~command/black-gold/90', b2: 'bossDesk/wood/180', b3: 'bossDesk/wood/270' };
            const got = Object.fromEntries(after.desks.map(d => [d.id, d.key + '/' + d.col + '/' + d.rot]));
            assert.deepEqual(got, want, JSON.stringify(got));
            assert.deepEqual(after.desks.map(d => d.id + d.key + d.col), before.desks.map(d => d.id + d.key + d.col));
        });
        await T.check('reloaded: every desk draws the same art, pixel for pixel', async () => {
            assert.deepEqual(after.desks.map(d => d.id + ':' + d.art), before.desks.map(d => d.id + ':' + d.art));
            assert.equal(new Set(after.desks.map(d => d.art)).size, after.desks.length, 'every desk differs (rotation, variant or colour)');
        });
        await T.check('no page errors', async () => { assert.deepEqual(o.errors, []); });
    } finally { await o.close(); }
}
if (T.failures) { console.log('FAILED test_v13_deskvar_saved: ' + T.failures); process.exit(1); }
console.log('OK test_v13_deskvar_saved');
