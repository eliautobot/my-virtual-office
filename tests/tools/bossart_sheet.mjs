// v0.13 bossart sheet tool: one sheet per few boss desk variants = art cells (variant x 2 colours x
// 0/90/180/270, screens on) + zoomed scene crops (each variant x rotation in a fixture office with a
// working agent, live screens). Writes PNG parts to --tmp; tests/tools/bossart_compose.py joins them.
//   node tests/tools/bossart_sheet.mjs --ids executive,glass --tmp /tmp/x [--type bossDesk] [--zoom 2.5] [--wait 9000]
// Env: PLAYWRIGHT_CORE_PATH, NODE_PATH as for the tests (tests/test_v10_ui_lib.mjs).
import fs from 'node:fs';
import { launch, openPage, FIXTURES } from '../test_v10_ui_lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const TYPE = arg('type', 'bossDesk'), IDS = arg('ids', '').split(',').filter(Boolean), TMP = arg('tmp', '/tmp/bossart-sheet');
const ZOOM = Number(arg('zoom', '2.5')), WAIT = Number(arg('wait', '9000')), SCALE = Number(arg('scale', '2'));
fs.mkdirSync(TMP, { recursive: true });

const browser = await launch('bossart_sheet');
try {
    // 1. art: rows = variant x first two colours (or --colors a,b when the variant lists them)
    {
        const { page } = await openPage(browser, { viewport: { width: 1600, height: 900 } });
        await page.waitForTimeout(1200);
        const size = await page.evaluate(({ TYPE, IDS, SCALE, COLS }) => {
            const rows = [];
            FURNITURE_VARIANTS[TYPE].forEach(r => {
                if (IDS.length && !IDS.includes(r.id)) return;
                const want = COLS ? COLS.split(',').filter(c => r.colors.includes(c)) : [];
                (want.length >= 2 ? want.slice(0, 2) : r.colors.slice(0, 2)).forEach(c => rows.push({ r, c }));
            });
            let cw = 0, ch = 0;
            rows.forEach(row => [0, 90, 180, 270].forEach(rot => {
                const a = _getItemWorldRect({ id: 's', type: TYPE, variant: row.r.id, x: 0, y: 0, rotation: rot, color: row.c });
                cw = Math.max(cw, a.w * SCALE + 12); ch = Math.max(ch, a.h * SCALE + 8);
            }));
            const head = 16, c = document.createElement('canvas'); c.id = 'vo-sheet';
            c.width = cw * 4 + 110; c.height = rows.length * (ch + head) + 4;
            Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 99999 });
            document.body.appendChild(c);
            const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
            g.fillStyle = '#2a2f3a'; g.fillRect(0, 0, c.width, c.height);
            const saved = window.ctx, inUse = window._deskInUse;
            window._deskInUse = () => true;
            try {
                rows.forEach((row, i) => {
                    const y0 = i * (ch + head) + 2;
                    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#e8eaf0'; g.font = 'bold 12px sans-serif';
                    g.fillText(row.r.label, 4, y0 + 30); g.font = '11px sans-serif'; g.fillText(row.c, 4, y0 + 46);
                    [0, 90, 180, 270].forEach((rot, j) => {
                        const x0 = 110 + j * cw;
                        g.setTransform(1, 0, 0, 1, 0, 0);
                        g.fillStyle = (i + j) % 2 ? '#3a4150' : '#353b48'; g.fillRect(x0, y0 + head, cw - 2, ch - 2);
                        g.fillStyle = '#c8ccd6'; g.fillText(rot + '°', x0 + 4, y0 + 12);
                        const it = { id: 'sheet', type: TYPE, variant: row.r.id, x: 0, y: 0, rotation: rot, color: row.c };
                        const a = _getItemWorldRect(it);
                        window.ctx = g;
                        g.setTransform(SCALE, 0, 0, SCALE, Math.round(x0 + (cw - a.w * SCALE) / 2 - a.x * SCALE), Math.round(y0 + head + (ch - a.h * SCALE) / 2 - a.y * SCALE));
                        drawFurnitureItem(it, { staticOnly: true });
                        window.ctx = saved;
                    });
                });
            } finally { window.ctx = saved; window._deskInUse = inUse; }
            return { w: c.width, h: c.height };
        }, { TYPE, IDS, SCALE, COLS: arg('colors', '') });
        await page.setViewportSize({ width: Math.min(size.w, 4000), height: Math.min(size.h, 4000) });
        await page.locator('#vo-sheet').screenshot({ path: TMP + '/art.png' });
        await page.close();
    }
    // 2. scene: each variant x rotation, a working agent at each; crops at camera zoom ZOOM
    {
        const cfg = JSON.parse(JSON.stringify(FIXTURES['/api/office-config']));
        const roster = JSON.parse(JSON.stringify(FIXTURES['/api/agents']));
        const status = JSON.parse(JSON.stringify(FIXTURES['/status']));
        cfg.canvasWidth = 1440; cfg.canvasHeight = Math.max(1000, 230 + IDS.length * 230); cfg.furniture = []; roster.agents = [];
        const desks = [];
        IDS.forEach((v, i) => [0, 90, 180, 270].forEach((rot, j) => {
            const id = 'a' + i + j, x = 180 + j * 340, y = 210 + i * 230;
            cfg.furniture.push({ id: 'f' + i + j, type: TYPE, variant: v, x, y, rotation: rot || undefined, assignedTo: id });
            roster.agents.push({ id, statusKey: id, name: 'Agent ' + i + j, emoji: '🙂', role: 'Tester', providerKind: 'openclaw', available: true });
            status[id] = { state: 'working', task: 'Testing ' + v };
            desks.push({ v, rot, x, y });
        }));
        const { page } = await openPage(browser, { viewport: { width: 1600, height: 1100 }, fixtures: { '/api/office-config': cfg, '/api/agents': roster, '/status': status } });
        await page.waitForTimeout(WAIT);
        const seated = await page.evaluate(() => agents.map(a => (a.isSitting || a._lastSeat ? 'S' : '-')).join(''));
        let n = 0;
        for (const d of desks) {
            const box = await page.evaluate(({ d, ZOOM, TYPE }) => {
                const a = _getItemWorldRect({ id: 'x', type: TYPE, variant: d.v, x: d.x, y: d.y, rotation: d.rot });
                const pad = 22, x0 = a.x - pad, y0 = a.y - 34, x1 = a.x + a.w + pad, y1 = a.y + a.h + 30;
                camera.zoom = ZOOM / getBaseScale(); camera.x = (x0 + x1) / 2 - W / 2; camera.y = (y0 + y1) / 2 - H / 2;
                if (typeof camera.targetZoom === 'number') camera.targetZoom = camera.zoom;
                const p = _worldToScreen(x0, y0), q = _worldToScreen(x1, y1);
                return { x: Math.max(0, p.x), y: Math.max(0, p.y), width: q.x - p.x, height: q.y - p.y };
            }, { d, ZOOM, TYPE });
            await page.waitForTimeout(350);
            await page.screenshot({ path: `${TMP}/scene-${String(n).padStart(2, '0')}-${d.v}-${d.rot}.png`, clip: box });
            n++;
        }
        console.log('scene crops ' + n + ' seated ' + seated);
    }
} finally {
    await browser.close();
}
