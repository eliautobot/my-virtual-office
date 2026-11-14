// v0.13 variant sheet tool: renders furniture variants in every rotation and colour into one JPEG.
//   node tests/tools/variant_sheet.mjs --out /tmp/sheet.jpg [--type desk] [--ids analyst,gamer]
//        [--colors first|first2|all|wood,black] [--scale 2] [--mode art|scene] [--quality 70] [--cell 150x140]
//        [--editor desk:gamer]   (art: the editor's catalog with the type's variants open + the Variants dropdown)
// art:   each cell = drawFurnitureItem(item, {staticOnly: true}) (screen on), rows = variant x colour,
//        columns = rotation 0 / 90 / 180 / 270; a magenta pixel means an unknown colour slot.
// scene: the variants placed in a fixture office with a working agent at each one (seated or
//        standing, live monitors, desk props), screenshotted from the real frame.
// Env: PLAYWRIGHT_CORE_PATH, NODE_PATH as for the tests (tests/test_v10_ui_lib.mjs).
import { launch, openPage, FIXTURES } from '../test_v10_ui_lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', '/tmp/variant-sheet.jpg'), TYPE = arg('type', ''), IDS = arg('ids', ''), COLORS = arg('colors', 'first');
const SCALE = Number(arg('scale', '2')), MODE = arg('mode', 'art'), Q = Number(arg('quality', '70'));
const [CW, CH] = arg('cell', '150x140').split('x').map(Number);

const browser = await launch('variant_sheet');
try {
    if (MODE === 'art') {
        const { page } = await openPage(browser, { viewport: { width: 1600, height: 900 } });
        await page.waitForTimeout(1200);
        const size = await page.evaluate(({ TYPE, IDS, COLORS, SCALE, CW, CH }) => {
            const rows = [];
            Object.keys(FURNITURE_VARIANTS).filter(t => !TYPE || TYPE.split(',').includes(t)).forEach(t => {
                FURNITURE_VARIANTS[t].forEach(r => {
                    if (IDS && !IDS.split(',').includes(r.id)) return;
                    const cols = COLORS === 'all' ? r.colors : /^first\d*$/.test(COLORS) ? r.colors.slice(0, Number(COLORS.slice(5)) || 1) : COLORS.split(',').filter(c => r.colors.includes(c));
                    cols.forEach(c => rows.push({ t, r, c }));
                });
            });
            const c = document.createElement('canvas'); c.id = 'vo-sheet';
            // cells grow to the largest art box (a long desk turned 90 is tall): one width, a height per row
            const box = (row, rot) => { const it = { id: 'sheet', type: row.t, x: 0, y: 0, rotation: rot }; if (row.r.id !== 'classic') it.variant = row.r.id; return _getItemWorldRect(it); };
            const cw = Math.max(CW * SCALE, ...rows.flatMap(row => [0, 90, 180, 270].map(rot => Math.ceil(box(row, rot).w * SCALE) + 8))), head = 18;
            rows.forEach(row => { row.ch = Math.max(CH * SCALE, ...[0, 90, 180, 270].map(rot => Math.ceil(box(row, rot).h * SCALE) + 8)); });
            let yy = 2; rows.forEach(row => { row.y0 = yy; yy += row.ch + head; });
            c.width = cw * 4 + 120; c.height = yy + 2;
            Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 99999, background: '#2a2f3a' });
            document.body.appendChild(c);
            const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
            g.fillStyle = '#2a2f3a'; g.fillRect(0, 0, c.width, c.height);
            const saved = window.ctx, inUse = window._deskInUse;
            window._deskInUse = () => true;
            try {
                rows.forEach((row, i) => {
                    const y0 = row.y0, ch = row.ch;
                    g.setTransform(1, 0, 0, 1, 0, 0);
                    g.fillStyle = '#e8eaf0'; g.font = '12px sans-serif';
                    g.fillText(row.t + ' / ' + row.r.id, 4, y0 + 14); g.fillText(row.c, 4, y0 + 30);
                    [0, 90, 180, 270].forEach((rot, j) => {
                        const x0 = 120 + j * cw;
                        g.setTransform(1, 0, 0, 1, 0, 0);
                        g.fillStyle = (i + j) % 2 ? '#3a4150' : '#353b48'; g.fillRect(x0, y0 + head, cw - 2, ch - 2);
                        g.fillStyle = '#c8ccd6'; g.fillText(rot + '°', x0 + 4, y0 + 12);
                        const it = { id: 'sheet', type: row.t, x: 0, y: 0, rotation: rot, color: row.c };
                        if (row.r.id !== 'classic') it.variant = row.r.id;
                        const a = _getItemWorldRect(it);
                        window.ctx = g;
                        g.setTransform(SCALE, 0, 0, SCALE, Math.round(x0 + (cw - a.w * SCALE) / 2 - a.x * SCALE), Math.round(y0 + head + (ch - a.h * SCALE) / 2 - a.y * SCALE));
                        drawFurnitureItem(it, { staticOnly: true });
                        window.ctx = saved;
                    });
                });
            } finally { window.ctx = saved; window._deskInUse = inUse; }
            return { w: c.width, h: c.height, rows: rows.length };
        }, { TYPE, IDS, COLORS, SCALE, CW, CH });
        // --editor desk:gamer: the editor beside the grid: the type's catalog tile with its types open, and a placed
        // variant selected with its Variants dropdown open (a 1600x900 office editor, screenshots of both)
        const ED = arg('editor', '');
        if (ED) {
            const { openEditor, officeFixture, toScreen } = await import('../test_v10_editor_lib.mjs');
            const [et, ev] = ED.split(':');
            const office = officeFixture();
            office.furniture.push(Object.assign({ id: 'vsel', type: et, x: 360, y: 330 }, ev && ev !== 'classic' ? { variant: ev } : {}));
            const e = await openEditor(browser, { office, width: 1600, height: 900 });
            const ep = e.page;
            await ep.waitForTimeout(600);
            const union = (sels, pad) => ep.evaluate(({ sels, pad }) => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
                sels.forEach(s => { const el = typeof s === 'string' ? document.querySelector(s) : null; const r = el ? el.getBoundingClientRect() : s;
                    if (!r) return; x0 = Math.min(x0, r.left ?? r.x); y0 = Math.min(y0, r.top ?? r.y); x1 = Math.max(x1, r.right ?? r.x + r.w); y1 = Math.max(y1, r.bottom ?? r.y + r.h); });
                x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(innerWidth, x1 + pad); y1 = Math.min(innerHeight, y1 + pad);
                return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) }; }, { sels, pad });
            await ep.click('.catalog-item[data-type=' + et + '] .catalog-variant-toggle');
            await ep.waitForTimeout(1200);
            await ep.locator('#catalog-variants-' + et).scrollIntoViewIfNeeded();
            const s1 = await ep.screenshot({ clip: await union(['.catalog-item[data-type=' + et + ']', '#catalog-variants-' + et], 4) });
            const p = await toScreen(ep, 360, 318);
            await ep.mouse.click(p.x, p.y); await ep.waitForTimeout(300);
            await ep.click('#ftb-variant-btn'); await ep.waitForTimeout(900);
            const art = await ep.evaluate(() => { const f = officeConfig.furniture.find(x => x.id === 'vsel'), r = _getItemWorldRect(f), a = _worldToCanvas(r.x, r.y), b = _worldToCanvas(r.x + r.w, r.y + r.h), c = document.getElementById('officeCanvas').getBoundingClientRect();
                return { x: c.left + a.x, y: c.top + a.y, w: b.x - a.x, h: b.y - a.y }; });
            const s2 = await ep.screenshot({ clip: await union(['#variant-menu', '#ftb-variant-btn', art], 6) });
            await e.context.close();
            Object.assign(size, await page.evaluate(async ({ a, b }) => {
                const load = (s) => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = 'data:image/png;base64,' + s; });
                const A = await load(a), B = await load(b), old = document.getElementById('vo-sheet');
                const c = document.createElement('canvas'), gap = 8, w = Math.max(A.width, B.width);
                c.width = old.width + gap + w; c.height = Math.max(old.height, A.height + gap + B.height + 20);
                const g = c.getContext('2d'); g.fillStyle = '#2a2f3a'; g.fillRect(0, 0, c.width, c.height); g.drawImage(old, 0, 0);
                g.fillStyle = '#e8eaf0'; g.font = '12px sans-serif'; g.fillText('Editor: objects menu (types open) and the Variants dropdown', old.width + gap, 14);
                g.drawImage(A, old.width + gap, 20); g.drawImage(B, old.width + gap, 20 + A.height + gap);
                c.id = 'vo-sheet'; Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 99999 }); old.replaceWith(c);
                return { w: c.width, h: c.height };
            }, { a: s1.toString('base64'), b: s2.toString('base64') }));
        }
        await page.setViewportSize({ width: Math.min(size.w, 4000), height: Math.min(size.h, 4000) });
        await page.locator('#vo-sheet').screenshot({ path: OUT, type: 'jpeg', quality: Q });
        console.log('sheet ' + OUT + ' ' + size.w + 'x' + size.h + ' rows ' + size.rows);
    } else {
        // scene: one desk per variant x rotation in a roomy office, a working agent at each
        const ids = [];
        const cfg = JSON.parse(JSON.stringify(FIXTURES['/api/office-config']));
        const roster = JSON.parse(JSON.stringify(FIXTURES['/api/agents']));
        const status = JSON.parse(JSON.stringify(FIXTURES['/status']));
        cfg.canvasWidth = 1440; cfg.canvasHeight = 1000; cfg.furniture = [];
        roster.agents = [];
        const want = (arg('items', 'desk:analyst,desk:gamer,desk:standing,bossDesk:command')).split(',').map(s => s.split(':'));
        want.forEach(([t, v], i) => [0, 90, 180, 270].forEach((rot, j) => {
            const id = 'a' + i + j, x = 160 + j * 320, y = 190 + i * 210;
            const it = { id: 'f' + i + j, type: t, x, y, rotation: rot || undefined, assignedTo: id };
            if (v && v !== 'classic') it.variant = v;
            const col = arg('color', ''); if (col) it.color = col;
            cfg.furniture.push(it);
            roster.agents.push({ id, statusKey: id, name: 'Agent ' + id, emoji: '🙂', role: 'Tester', providerKind: 'openclaw', available: true });
            status[id] = { state: 'working', task: 'Testing ' + (v || t) };
            ids.push(id);
        }));
        const { page } = await openPage(browser, { viewport: { width: 1600, height: 1100 }, fixtures: { '/api/office-config': cfg, '/api/agents': roster, '/status': status } });
        await page.waitForTimeout(Number(arg('wait', '9000')));
        await page.screenshot({ path: OUT, type: 'jpeg', quality: Q });
        const seated = await page.evaluate(() => agents.map(a => a.id + ':' + (a.isSitting ? 'S' : '-') + (a._lastSeat ? 'L' : '')).join(' '));
        console.log('scene ' + OUT + ' ' + seated.slice(0, 300));
    }
} finally {
    await browser.close();
}
