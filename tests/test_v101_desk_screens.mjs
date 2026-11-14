// v0.10.1 I15: monitors of desks nobody owns, nobody has as an automatic desk and nobody sits at are off
// (dark screen, no glow); desks in use keep the lit resting screen; a desk lights up once someone takes it.
// Every desk type and view: desk front, desk turned 90 (screen strip), boss desk. Hermetic page (fixtures).
import assert from 'node:assert/strict';
import { launch, openPage, reporter, FIXTURES } from './test_v10_ui_lib.mjs';

const NAME = 'test_v101_desk_screens';
const cfg = JSON.parse(JSON.stringify(FIXTURES['/api/office-config']));
cfg.furniture.push(
    { id: 'd4', type: 'desk', x: 520, y: 220 },
    { id: 'd5', type: 'desk', x: 700, y: 380, rotation: 90 },
    { id: 'b1', type: 'bossDesk', x: 820, y: 560 },
    { id: 'd6', type: 'desk', x: 520, y: 560, assignedTo: 'Nobody Here' });  // owner not in this office = free
// Three agents with their own desks plus one without: it takes a free desk (automatic), which stays lit.
const roster = JSON.parse(JSON.stringify(FIXTURES['/api/agents']));
roster.agents.push({ id: 'delta', statusKey: 'delta', name: 'Delta', emoji: '🐢', role: 'Tester', providerKind: 'openclaw', available: true });
const status = Object.assign({}, FIXTURES['/status'], { delta: { state: 'idle', task: '' } });

const browser = await launch(NAME);
const R = reporter();
try {
    const { page, errors } = await openPage(browser, { fixtures: { '/api/office-config': cfg, '/api/agents': roster, '/status': status } });
    await page.waitForTimeout(2500);
    const sample = () => page.evaluate(() => {
        const c = document.getElementById('officeCanvas'), g = c.getContext('2d'), k = c.width / c.getBoundingClientRect().width;
        const out = {};
        officeConfig.furniture.filter(f => f.type === 'desk' || f.type === 'bossDesk').forEach(f => {
            const r = _deskMonitorRects(f).filter(q => q.view !== 'back')[0];
            const p = _worldToCanvas(f.x + r.x + r.w / 2, f.y + r.y + Math.min(r.h / 2, 6));
            const d = g.getImageData(Math.round(p.x * k), Math.round(p.y * k), 1, 1).data;
            out[f.id] = { lum: d[0] + d[1] + d[2], use: _deskInUse(f) };
        });
        const delta = agents.find(a => a.id === 'delta');
        out.deltaDesk = officeConfig.furniture.filter(f => Math.abs(f.x - delta.desk.x) < 1 && Math.abs(f.y - delta.desk.y) < 1).map(f => f.id)[0] || null;
        return out;
    });
    let s = await sample();
    const free = ['d4', 'd5', 'b1', 'd6'].filter(id => id !== s.deltaDesk);
    assert.ok(s.deltaDesk && s[s.deltaDesk].use, 'the automatic desk counts as in use: ' + JSON.stringify(s));
    assert.ok(free.every(id => !s[id].use), JSON.stringify(s));
    for (const id of free) assert.ok(s[id].lum < 110, `${id} screen off: ` + JSON.stringify(s[id]));
    for (const id of ['d1', 'd3', s.deltaDesk]) assert.ok(s[id].lum > 150, `${id} resting screen lit: ` + JSON.stringify(s[id]));
    R.pass('free desks (front, turned, boss) show their screens off; owned and automatic desks stay lit');
    // Someone sits at a free desk (a helper): lit within the next static check (about a second).
    const take = free[0];
    await page.evaluate(id => {
        const f = officeConfig.furniture.find(x => x.id === id), H = window.VOLifeHost;
        const ch = H.addExtra(H.makeCharacter({ id: 'helper-t', x: f.x, y: f.y, sitting: true, state: 'working' }));
        ch.x = ch.targetX = f.x; ch.y = ch.targetY = f.y; ch.isSitting = true; _markSceneDirty();
    }, take);
    await page.waitForTimeout(1800);
    s = await sample();
    assert.ok(s[take].use && s[take].lum > 150, `${take} lit once taken: ` + JSON.stringify(s[take]));
    R.pass('a desk lights up once someone sits at it');
    assert.deepEqual(errors, []);
    R.pass('no page errors');
} finally {
    await browser.close();
}
R.done(NAME);
