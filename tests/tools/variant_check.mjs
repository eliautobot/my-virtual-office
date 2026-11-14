// v0.13 variant art check (also run by tests/test_v13_deskvar_variants.mjs): every variant x rotation x colour
// draws inside its manifest art box (the static layer, selection box and depth parts rely on it), paints no
// unknown colour slot (magenta), is not empty, every colour shows its finish slots and no two colours draw the same. Prints one line per variant; exit 1 on a problem.
//   node tests/tools/variant_check.mjs [--type desk] [--ids gamer]
import { launch, openPage } from '../test_v10_ui_lib.mjs';

export function checkVariants(args) {
    const { TYPE, IDS } = args || {};
    const out = [];
    const saved = window.ctx, inUse = window._deskInUse;
    window._deskInUse = () => true;
    const c = document.createElement('canvas'); c.width = 400; c.height = 400;
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = false;
    try {
        Object.keys(FURNITURE_VARIANTS).filter(t => !TYPE || TYPE === t).forEach(t => FURNITURE_VARIANTS[t].forEach(r => {
            if (IDS && !IDS.split(',').includes(r.id)) return;
            const res = { key: r.key, bad: [], cells: 0 };
            const seen = {};   // rot -> image hash -> colour (two colours that draw the same art = a colour the art ignores)
            r.colors.forEach(col => [0, 90, 180, 270].forEach(rot => {
                const it = { id: 'chk', type: t, x: 0, y: 0, rotation: rot, color: col };
                if (r.id !== 'classic') it.variant = r.id;
                const a = _getItemWorldRect(it);
                g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 400, 400);
                window.ctx = g;
                g.setTransform(1, 0, 0, 1, 200, 220);
                try { _withoutFloorShadows(() => drawFurnitureItem(it, { staticOnly: true })); } finally { window.ctx = saved; }
                const d = g.getImageData(0, 0, 400, 400).data;
                let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, mag = 0, n = 0, h = 0, fin = 0;
                const slots = FURNITURE_COLORS[col].t, want = new Set(['top', 'topB', 'body', 'face', 'faceDk', 'metal', 'metalDk'].map(s => slots[s]).filter(v => /^#[0-9a-f]{6}$/i.test(v || '')).map(v => v.toLowerCase()));
                const hx = (v) => (v < 16 ? '0' : '') + v.toString(16);
                for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
                    const k = (y * 400 + x) * 4;
                    if (d[k + 3] < 8) continue;
                    n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
                    if (d[k] === 255 && d[k + 1] === 0 && d[k + 2] === 255) mag++;
                    h = (Math.imul(h, 31) + d[k] + d[k + 1] * 7 + d[k + 2] * 13 + d[k + 3] * 3 + k) | 0;
                    if (d[k + 3] > 250 && want.has('#' + hx(d[k]) + hx(d[k + 1]) + hx(d[k + 2]))) fin++;
                }
                const sr = seen[rot] || (seen[rot] = {});
                if (r.colors.length > 1 && sr[h]) res.bad.push(rot + ': ' + sr[h] + ' and ' + col + ' draw the same (a colour the art ignores)');
                sr[h] = col;
                if (fin < 50) res.bad.push(col + '/' + rot + ' the finish shows ' + fin + ' px of its colour slots (paint with the slots)');
                res.cells++;
                const bx0 = x0 - 200, by0 = y0 - 220, bx1 = x1 + 1 - 200, by1 = y1 + 1 - 220;
                const tol = 1;
                const outside = [a.x - bx0, a.y - by0, bx1 - (a.x + a.w), by1 - (a.y + a.h)].map(v => Math.max(0, Math.round(v)));
                if (!n) res.bad.push(col + '/' + rot + ' empty');
                if (mag) res.bad.push(col + '/' + rot + ' ' + mag + ' magenta px (unknown colour slot)');
                if (outside.some(v => v > tol)) res.bad.push(col + '/' + rot + ' drawn outside the art box by L' + outside[0] + ' T' + outside[1] + ' R' + outside[2] + ' B' + outside[3]);
            }));
            out.push(res);
        }));
    } finally { window.ctx = saved; window._deskInUse = inUse; }
    return out;
}

if (import.meta.url === 'file://' + process.argv[1]) {
    const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
    const browser = await launch('variant_check');
    let fail = 0;
    try {
        const { page, errors } = await openPage(browser, {});
        await page.waitForTimeout(1200);
        const res = await page.evaluate(checkVariants, { TYPE: arg('type', ''), IDS: arg('ids', '') });
        res.forEach(r => { console.log((r.bad.length ? 'BAD ' : 'ok  ') + r.key + ' (' + r.cells + ' cells) ' + r.bad.slice(0, 4).join('; ')); if (r.bad.length) fail++; });
        if (errors.length) { console.log('page errors: ' + errors.slice(0, 3).join(' | ')); fail++; }
    } finally { await browser.close(); }
    process.exit(fail ? 1 : 0);
}
