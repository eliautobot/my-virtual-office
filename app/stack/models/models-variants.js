// Hand-built stack models for the desk / executive-desk variants (furniture-variants/desk.js and
// boss-desk.js): one model per variant, registered as 'desk~<id>' / 'bossDesk~<id>' (the scene looks
// the variant's own def up first). Rotation 0 only, front (the sitter's / stander's side) = +y,
// origin = the item anchor, plans as in the variant's manifest.projection.parts. Colours: the item's
// resolved slot map (ctx.colors in the office), else the variant's colour list (gallery).
// See stack/README.md.
(function () {
    'use strict';
    var S = window.VOStack;
    if (!S) return;
    var C = S.color, MAT = S.MAT, T = S.tex, tone = C.tone, mix = C.mix;

    // ---------- colours ----------
    var BASE = {
        wood:     { top: '#a1887f', topB: '#8d6e63', inlay: '#7b5e53', body: '#795548', face: '#6d4c41', legHi: '#6a4a40', faceDk: '#5d4037', leg: '#4e342e', seam: '#4a3129', pull: '#bcaaa4', accent: '#ffd700', metal: '#90a4ae', metalDk: '#607d8b' },
        walnut:   { top: '#7d5a42', topB: '#6f4e39', inlay: '#5f4030', body: '#5e402f', face: '#513626', legHi: '#4b3223', faceDk: '#432b1e', leg: '#382418', seam: '#2c1c12', pull: '#d4b26a', accent: '#d4af37', metal: '#a1887f', metalDk: '#6d4c41' },
        white:    { top: '#eef1f3', topB: '#e4e8eb', inlay: '#d2d9dd', body: '#d8dee2', face: '#c6ced3', legHi: '#bcc5ca', faceDk: '#aeb8be', leg: '#98a3aa', seam: '#87939a', pull: '#7d8a92', accent: '#b0bec5', metal: '#dfe5e8', metalDk: '#a3b0b7' },
        black:    { top: '#3d4147', topB: '#363a40', inlay: '#2c3035', body: '#30343a', face: '#282c31', legHi: '#383c42', faceDk: '#212429', leg: '#1b1e22', seam: '#141619', pull: '#9aa3a9', accent: '#cfd8dc', metal: '#4a4f56', metalDk: '#2a2d32' },
        mahogany: { top: '#8e4a3a', topB: '#7f4031', inlay: '#6d3427', body: '#6e3528', face: '#602d21', legHi: '#592a1f', faceDk: '#4f241a', leg: '#421d15', seam: '#33160f', pull: '#d9b36c', accent: '#d4af37', metal: '#a1887f', metalDk: '#6d4c41' },
        grey:     { top: '#b0bec5', topB: '#a3b2ba', inlay: '#90a4ae', body: '#8c9ea7', face: '#78909c', legHi: '#6f8590', faceDk: '#607d8b', leg: '#546e7a', seam: '#455a64', pull: '#eceff1', accent: '#ffd54f', metal: '#cfd8dc', metalDk: '#90a4ae' }
    };
    var ACC = {
        'black-red': ['black', '#ff1744'], 'black-cyan': ['black', '#00e5ff'], 'black-green': ['black', '#76ff03'], 'black-gold': ['black', '#ffc400'],
        'white-pink': ['white', '#ff4081'], 'white-blue': ['white', '#2979ff'], 'grey-orange': ['grey', '#ff9100'], 'walnut-brass': ['walnut', '#e0b84a']
    };
    // The slot map of an item: the office's resolved colour, else the item's colour when the variant
    // offers it, else the variant's first colour.
    function pal(item, ctx, list) {
        if (ctx && ctx.colors && ctx.colors.top) return ctx.colors.id ? ctx.colors : Object.assign({ id: (item && item.color) || list[0] }, ctx.colors);
        var id = item && item.color;
        if (!id || list.indexOf(id) < 0) id = list[0];
        if (typeof FURNITURE_COLORS !== 'undefined' && FURNITURE_COLORS[id]) return FURNITURE_COLORS[id].t;
        if (BASE[id]) return Object.assign({ id: id }, BASE[id]);
        if (ACC[id]) return Object.assign({ id: id }, BASE[ACC[id][0]], { accent: ACC[id][1] });
        return Object.assign({ id: 'wood' }, BASE.wood);
    }
    function reg(type, id, list, build) {
        S.def(type + '~' + id, function (item, ctx) { return build(pal(item, ctx, list), item, ctx); },
            function (item, ctx) { return pal(item, ctx, list).id || ''; });
    }
    // is the palette's body dark (black family)?
    function dark(c) { var a = C.rgb(c); return a[0] + a[1] + a[2] < 200; }

    // ---------- textures ----------
    function longGrain(base, seg) {
        var c0 = C.rgb(base), dk = tone(c0, 0.9), lt = tone(c0, 1.06);
        return function (x, y) {
            var n = C.hash(y, Math.floor((x + (y * 7) % seg) / seg), 11);
            return n < 0.15 ? dk : n > 0.9 ? lt : c0;
        };
    }
    function grainV(base) {
        var c0 = C.rgb(base), d = tone(c0, 0.93), l = tone(c0, 1.05);
        return function (x, y, z) { var n = C.hash(x, 3, Math.floor(z / 7)); return n < 0.2 ? d : n > 0.88 ? l : c0; };
    }
    function speck(base, a) { return T.speckle(base, a == null ? 0.04 : a); }
    // ---------- shared pieces ----------
    // A rod with a 2x2 section from p to q.
    function rod(m, p, q, col, mat) {
        var dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
        var n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) * 2));
        for (var i = 0; i <= n; i++) {
            var t = i / n;
            m.box(Math.floor(p[0] + dx * t - 0.5), Math.floor(p[1] + dy * t - 0.5), Math.floor(p[2] + dz * t - 0.5), 2, 2, 2, col, mat);
        }
    }
    // A desk top: an apron (inset 1 at the back and the ends, flush at the front) under a board of
    // `board` px. plan [x, y, w, d], z, h as the manifest's top part. o: grain (long-grain seg),
    // apron colour, rim (top-layer edge colour), side (board edge colour), mat (board material).
    function deskTop(m, plan, z, h, top, front, o) {
        o = o || {};
        var x0 = plan[0], y0 = plan[1], x1 = x0 + plan[2], y1 = y0 + plan[3], zt = z + h, bd = Math.min(h, o.board || 2);
        var ap = o.apron || front;
        if (h > bd) {
            m.box(x0 + 1, y0 + 1, z, plan[2] - 2, plan[3] - 1, h - bd, ap, o.apronMat);
            m.paint(x0 + 1, y1 - 1, z, plan[2] - 2, 1, 1, tone(ap, 0.86));
        }
        var g = o.grain ? longGrain(top, o.grain) : o.speckle ? speck(top, o.speckle) : null;
        var rim = o.rim || tone(top, 1.07), side = o.side || mix(top, front, 0.55);
        m.box(x0, y0, zt - bd, plan[2], plan[3], bd, function (x, y, zz) {
            var edge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
            if (zz === zt - 1) return edge ? rim : (g ? g(x, y, zz) : top);
            return edge ? side : top;
        }, o.mat);
    }
    // A leg (w x d x h) with a lighter edge toward the light and a dark glide.
    function leg(m, x, y, w, d, z, h, col, hi, mat) {
        m.box(x, y, z, w, d, h, function (xx, yy, zz) {
            if (zz === z && z === 0) return tone(col, 0.8);
            return xx === x || yy === y + d - 1 ? (hi || tone(col, 1.15)) : col;
        }, mat);
    }
    // A drawer pedestal: carcass, n drawer fronts in its +y row, pulls 1 px proud.
    function pedestal(m, P, x, y, w, d, h, n, o) {
        o = o || {};
        var body = o.body || P.face, front = o.front || P.faceDk, pull = o.pull || P.pull, z0 = o.z0 || 0;
        m.box(x, y, z0, w, d - 1, h, function (xx, yy, z) { return (xx === x || xx === x + w - 1) && yy > y ? tone(body, 0.95) : body; }, o.mat);
        m.box(x + 1, y + d - 2, z0, w - 2, 1, 2, P.leg);
        var zA = z0 + 2, zB = z0 + h - 1, bh = (zB - zA) / n, fy = y + d - 1;
        for (var i = 0; i < n; i++) {
            var a = Math.round(zA + i * bh), b = Math.round(zA + (i + 1) * bh) - 1;
            m.box(x + 1, fy, a, w - 2, 1, b - a, o.flat ? front : grainV(front), o.mat);
            m.paint(x + 1, fy, b - 1, w - 2, 1, 1, tone(front, 1.1));
            if (pull) m.box(Math.round(x + w / 2 - (o.pw || 6) / 2), fy + 1, a + Math.max(1, Math.floor((b - a) / 2) - (b - a > 4 ? 0 : 1)), o.pw || 6, 1, o.ph || 1, pull, o.pullMat == null ? MAT.SHINY : o.pullMat);
        }
    }
    // A flat-panel monitor facing +y. sc = a variant screens entry {plan: [x, y, w, d], z, h, foot}.
    // The panel takes rows y - 3 .. y + 1 (back plate 3 px: the bake gives the row right behind the
    // screen the screen's look, so two more rows keep it out of every back view; the recessed screen
    // in row y, the bezel ring in row y + 1), the casing back rows y - 5, y - 4. o: bc (bezel colour), stand (foot
    // colour), footZ (the surface under the foot), mount 'foot' | 'none' (an arm or a pole holds it:
    // a VESA plate instead of the casing hump), bez, top, chin (screen inset), led, frame.
    function mon(m, sc, o) {
        o = o || {};
        var pl = sc.plan, x0 = pl[0], x1 = pl[0] + pl[2], yb = pl[1], z0 = sc.z, z1 = sc.z + sc.h, W = x1 - x0, H = z1 - z0;
        var bc = o.bc || '#263238', hi = mix(bc, '#ffffff', 0.16), chin = tone(bc, 0.86), back = mix(bc, '#ffffff', 0.07), vent = tone(bc, 0.8);
        var cx = Math.round((x0 + x1) / 2), fz = o.footZ || 21, mount = o.mount || 'foot';
        if (mount === 'foot' && sc.foot) {
            var f = sc.foot, st = o.stand || '#455a64';
            m.rbox(f[0], f[1], fz, f[2], f[3], 1, 1, st, MAT.SHINY);
            m.paint(f[0] + 1, f[1] + f[3] - 1, fz, f[2] - 2, 1, 1, tone(st, 1.2));
            var ny = Math.max(f[1], yb - 5), nw = W >= 20 ? 4 : 2;
            m.box(cx - nw / 2, ny, fz + 1, nw, 2, Math.max(2, Math.round(z0 + H * 0.45) - fz - 1), tone(st, 0.9), MAT.SHINY);
        }
        if (mount === 'foot') {
            var ix = Math.max(3, Math.round(W * 0.16)), iz0 = Math.max(2, Math.round(H * 0.18)), iz1 = Math.max(2, Math.round(H * 0.14));
            m.rbox(x0 + ix, yb - 5, z0 + iz0, W - 2 * ix, 2, H - iz0 - iz1, 1, back);
            for (var vz = z0 + iz0 + 3; vz < z1 - iz1 - 2; vz += 3) m.paint(x0 + ix + 2, yb - 5, vz, W - 2 * ix - 4, 1, 1, vent);
        } else {
            var vz0 = Math.round(z0 + H / 2) - 3;
            m.box(cx - 3, yb - 5, vz0, 6, 2, 6, vent);
        }
        var bez = o.bez || (W >= 16 ? 3 : 2), tp = o.top || 2, ch = o.chin || 3, fr = o.frame;
        m.box(x0, yb - 3, z0, W, 5, H, function (x, y, z) {
            if (z >= z1 - 1) return hi;
            if (y < yb) return x === x0 || x === x1 - 1 ? bc : back;
            if (fr && (x < x0 + 1 || x >= x1 - 1 || z < z0 + 1)) return fr;
            if (z < z0 + 1) return chin;
            return bc;
        });
        var sx0 = x0 + bez, sx1 = x1 - bez, sz0 = z0 + ch, sz1 = z1 - tp;
        m.carve(sx0, yb + 1, sz0, sx1 - sx0, 1, sz1 - sz0);
        m.box(sx0, yb, sz0, sx1 - sx0, 1, sz1 - sz0, '#2c4a63', MAT.SCREEN);
        if (o.led !== false) m.box(x1 - bez - 2, yb + 1, z0 + 1, 2, 1, 1, o.ledC || '#69f0ae', MAT.EMIT);
    }
    // A monitor arm: a clamp on the top's back edge (plan clamp, the top surface at fz), a post up
    // to zTop, and for each screen a 2x2 bar from the post to its VESA plate (rows screen.y - 5, - 4).
    function armMount(m, clamp, fz, zTop, screens, col) {
        col = col || '#3c474e';
        var px = Math.round(clamp[0] + clamp[2] / 2) - 1, py = clamp[1];
        m.box(clamp[0], clamp[1], fz - 4, clamp[2], clamp[3], 6, tone(col, 0.85), MAT.SHINY);     // the clamp round the edge
        m.box(clamp[0] - 1, clamp[1] + 1, fz + 1, clamp[2] + 2, clamp[3] - 1, 1, tone(col, 1.1), MAT.SHINY);
        m.box(px, py, fz, 2, 2, zTop - fz, col, MAT.SHINY);                                          // post
        m.box(px - 1, py - 1 < clamp[1] ? py : py - 1, zTop - 1, 4, 2, 2, tone(col, 1.15), MAT.SHINY); // post cap
        screens.forEach(function (sc) {
            var zc = Math.round(sc.z + sc.h / 2) - 1, sx = Math.round(sc.plan[0] + sc.plan[2] / 2) - 1, vy = sc.plan[1] - 5;
            if (vy > py + 1) m.box(px, py, zc, 2, vy - py + 1, 2, col, MAT.SHINY);                   // out from the post
            if (sx !== px) m.box(Math.min(px, sx), vy - 1, zc, Math.abs(sx - px) + 2, 2, 2, col, MAT.SHINY);  // along to the screen
            m.box(sx - 1, vy - 1, zc - 1, 4, 2, 4, tone(col, 0.9), MAT.SHINY);                         // the joint at the plate
        });
    }
    // Keyboard (case + key caps) lying on z: kc {caseC, key, key2, gap, hi, acc (accent caps), light (backlight)}.
    function keyboard(m, x, y, w, d, z, kc) {
        kc = kc || {};
        var cs = kc.caseC || '#2f3d44', k1 = kc.key || '#607d8b', k2 = kc.key2 || '#546e7a', gap = kc.gap || '#37474f', hi = kc.hi || '#78909c';
        m.rbox(x, y, z, w, d, 1, 1, cs);
        m.box(x + 1, y + 1, z + 1, w - 2, d - 2, 1, function (xx, yy) {
            var cx = xx - x - 1, cy = yy - y - 1, last = cy === d - 3;
            if (last && cx > (w - 2) * 0.25 && cx < (w - 2) * 0.72) return k2;
            if (cy % 2 === 1 && !last) return gap;
            var u = cx + (cy >> 1);
            if (u % 3 === 2) return gap;
            if (kc.acc && ((cy === 0 && cx < 3) || (cy === 2 && cx > w - 8))) return kc.acc;
            if (cy === 0) return hi;
            return Math.floor(u / 3) % 2 ? k2 : k1;
        });
        if (kc.light) m.paint(x, y + d - 1, z, w, 1, 1, kc.light, MAT.EMIT);
    }
    function mouse(m, x, y, z, w, d, col, lightC) {
        col = col || '#607d8b';
        m.rbox(x, y, z, w, d, 2, 1, col);
        m.paint(x, y, z + 1, w, 2, 1, tone(col, 1.25));
        m.paint(x + Math.floor(w / 2), y, z + 1, 1, 2, 1, tone(col, 0.8));
        if (lightC) m.paint(x, y + d - 1, z, w, 1, 1, lightC, MAT.EMIT);
    }
    // A pad / mat lying on the top: fill, an optional border colour (and its material).
    function mat(m, x, y, w, d, z, fill, edge, edgeMat, h) {
        m.box(x, y, z, w, d, h || 1, fill);
        if (edge) {
            m.paint(x, y, z + (h || 1) - 1, w, 1, 1, edge, edgeMat); m.paint(x, y + d - 1, z, w, 1, h || 1, edge, edgeMat);
            m.paint(x, y, z + (h || 1) - 1, 1, d, 1, edge, edgeMat); m.paint(x + w - 1, y, z + (h || 1) - 1, 1, d, 1, edge, edgeMat);
        }
    }
    // A small potted plant (pot plan x, y, w, d on z, pot height ph).
    function plant(m, x, y, w, d, z, ph, potC, leafA, leafB, tall) {
        var cx = x + w / 2, cy = y + d / 2;
        m.cone(cx, cy, z, w / 2 - 1, w / 2, ph, potC, MAT.SOLID, d / w);
        m.cyl(cx, cy, z + ph - 1, w / 2, (w / 2) * d / w, 1, tone(potC, 1.12));
        m.cyl(cx, cy, z + ph - 1, w / 2 - 1.2, (w / 2 - 1.2) * d / w, 1, '#4e342e');
        var top = z + ph, H = tall || 8;
        m.ellipsoid(cx, cy, top + H * 0.45, w * 0.42, d * 0.55, H * 0.5, leafA, MAT.SOFT);
        m.ellipsoid(cx - w * 0.22, cy + 0.5, top + H * 0.75, w * 0.24, d * 0.36, H * 0.32, leafB, MAT.SOFT);
        m.ellipsoid(cx + w * 0.24, cy - 0.5, top + H * 0.62, w * 0.22, d * 0.34, H * 0.3, leafB, MAT.SOFT);
        m.ellipsoid(cx + 0.5, cy, top + H * 0.95, w * 0.16, d * 0.26, H * 0.2, tone(leafB, 1.08), MAT.SOFT);
        m.box(Math.round(cx - w * 0.55), Math.round(cy), top + 3, 2, 2, 2, leafA, MAT.SOFT);
        m.box(Math.round(cx + w * 0.45), Math.round(cy - 1), top + 4, 2, 2, 2, leafA, MAT.SOFT);
    }
    // A mug (cx, cy) on z with coffee and a handle on +x.
    function mug(m, cx, cy, z, col) {
        m.cyl(cx, cy, z, 2.6, 2.6, 6, col);
        m.cyl(cx, cy, z + 5, 1.7, 1.7, 1, '#4e342e');
        m.box(Math.round(cx + 2), Math.round(cy) - 1, z + 1, 2, 2, 4, col); m.carve(Math.round(cx + 3), Math.round(cy) - 1, z + 2, 1, 2, 2);
    }
    // A circle of voxels standing in the x-z plane (rows y .. y + d - 1): r0 inner, r1 outer radius.
    function ringXZ(m, cx, cz, y, d, r0, r1, col, mat) {
        for (var z = Math.floor(cz - r1); z <= Math.ceil(cz + r1); z++) for (var x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
            var dd = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
            if (dd <= r1 && dd >= r0) m.box(x, y, z, 1, d, 1, col, mat);
        }
    }
    // A disc lying flat (x-y plane) on z.
    function discXY(m, cx, cy, z, r, col, mat, h) { m.cyl(cx, cy, z, r, r, h || 1, col, mat); }
    // Paint a disc into the top layer (z) of what is there.
    function paintDisc(m, cx, cy, z, r, col, mat) {
        for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
            if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) m.paint(x, y, z, 1, 1, 1, col, mat);
    }
    function paintRing(m, cx, cy, z, r, col, mat) {
        for (var y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) for (var x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
            var d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
            if (d <= r + 0.5 && d > r - 0.6) m.paint(x, y, z, 1, 1, 1, col, mat);
        }
    }
    var RAINBOW = ['#ff1744', '#ff9100', '#ffea00', '#76ff03', '#00e5ff', '#2979ff', '#d500f9'];
    var BOOKS = ['#8d2f2f', '#2f5d8d', '#c49a2a', '#3f7d4a', '#6d4c8d', '#d7ccc8', '#a0522d'];
    var BRASS = '#c9a24a', BRASS_HI = '#ecd28a', BRASS_DK = '#8d6e2f';

    // =====================================================================================
    // Desk variants (top [.., -18, .., 32] z16 h5: the top surface at z 21, the sitter at +y)
    // =====================================================================================

    // ---- Analyst: four screens (three in a row + one on a riser post), a cable tray, a calculator ----
    reg('desk', 'analyst', ['grey', 'white', 'black', 'wood', 'walnut', 'white-blue'], function (P) {
        var m = S.model(-46, -20, 46, 16, 70);
        [[-44, -18], [41, -18], [-44, 11], [41, 11]].forEach(function (l) { leg(m, l[0], l[1], 3, 3, 0, 16, P.metalDk, P.metal, MAT.SHINY); });
        m.box(-43, -14, 3, 2, 24, 2, P.metalDk, MAT.SHINY);                                         // end stretcher (open end)
        pedestal(m, P, 24, -16, 18, 30, 16, 3);
        m.box(-40, -18, 2, 62, 2, 14, function (x, y, z) { return z === 8 ? P.leg : z === 15 ? tone(P.faceDk, 1.1) : P.faceDk; });   // modesty panel
        // cable tray under the top with a few cables in it
        m.box(-40, -15, 11, 62, 3, 3, P.metalDk, MAT.SHINY);
        m.carve(-39, -14, 12, 60, 1, 2);
        m.box(-36, -14, 12, 30, 1, 1, '#1e88e5'); m.box(-20, -14, 12, 22, 1, 1, '#263238'); m.box(-8, -14, 12, 14, 1, 1, '#fdd835');
        deskTop(m, [-44, -18, 88, 32], 16, 5, P.top, P.face, { grain: P.id === 'wood' || P.id === 'walnut' ? 22 : 0, speckle: 0.025 });
        // desk mat (accent front edge), calculator
        mat(m, -20, -1, 46, 12, 21, '#263238');
        m.paint(-20, 10, 21, 46, 1, 1, P.accent, MAT.EMIT);
        m.rbox(30, -4, 21, 8, 10, 2, 1, '#455a64');
        m.box(31, -3, 23, 6, 2, 1, '#a5d6a7', MAT.EMIT);
        m.box(31, 0, 23, 6, 5, 1, function (x, y) { return (x + y) % 2 ? '#90a4ae' : '#b0bec5'; });
        m.paint(36, 4, 23, 1, 1, 1, '#ff7043');
        // the riser post (behind the middle screen) and the four screens
        var SC = [
            { plan: [-15, -12, 30, 2], z: 46, h: 20 },
            { plan: [-43, -11, 28, 2], z: 23, h: 22, foot: [-35, -14, 12, 5] },
            { plan: [-14, -11, 28, 2], z: 23, h: 22, foot: [-6, -14, 12, 5] },
            { plan: [15, -11, 28, 2], z: 23, h: 22, foot: [23, -14, 12, 5] }];
        m.rbox(-4, -18, 21, 8, 4, 1, 1, '#455a64', MAT.SHINY);                                      // riser foot
        m.box(-1, -18, 22, 2, 2, 34, '#3c4b53', MAT.SHINY);                                          // riser post
        m.box(-3, -17, 53, 6, 1, 6, '#2f3a40');                                                      // VESA plate of the top screen
        var o = { bc: '#1e272c', stand: '#546e7a' };
        mon(m, SC[0], Object.assign({ mount: 'none' }, o));
        mon(m, SC[1], o); mon(m, SC[2], o); mon(m, SC[3], o);
        keyboard(m, -15, 1, 30, 8, 22);
        mouse(m, 19, 2, 22, 5, 6);
        return m;
    });

    // ---- Gamer: two screens, an RGB strip under the top, speakers, a headset stand, a big lit pad ----
    reg('desk', 'gamer', ['black-red', 'black-cyan', 'black-green', 'white-pink', 'black', 'white'], function (P) {
        var m = S.model(-39, -19, 39, 15, 50);
        var frame = P.leg, frameHi = P.legHi, A = P.accent;
        // T-frame: foot bars along y, uprights, a crossbar
        [-36, 32].forEach(function (fx) {
            m.rbox(fx, -16, 0, 4, 28, 3, 1, frame);
            m.paint(fx, -16, 2, 4, 28, 1, tone(frame, 1.18));
            m.box(fx + 1, 11, 0, 2, 1, 1, '#111316');                                              // glides
            m.box(fx + 1, -16, 0, 2, 1, 1, '#111316');
            m.box(fx, -3, 3, 4, 4, 13, function (x, y) { return x === fx || y === 0 ? frameHi : frame; });
            m.paint(fx + (fx < 0 ? 0 : 3), -2, 6, 1, 2, 7, A, MAT.EMIT);                              // lit insert down the outer face
        });
        m.box(-33, -11, 12, 66, 2, 2, frame);
        deskTop(m, [-38, -18, 76, 32], 16, 5, P.top, P.faceDk, { speckle: 0.03, side: tone(P.faceDk, 1.15) });
        // the RGB strip under the front edge (and a lit line along the apron)
        m.box(-36, 12, 15, 72, 2, 1, A, MAT.EMIT);
        // mouse pad with lit rims
        m.box(-24, 0, 21, 54, 11, 1, '#1b1d21');
        m.paint(-24, 0, 21, 54, 1, 1, A, MAT.EMIT); m.paint(-24, 10, 21, 54, 1, 1, A, MAT.EMIT);
        // speakers: cabinet, a woofer, a lit accent dot
        [[-37, -16], [32, -16]].forEach(function (s) {
            m.rbox(s[0], s[1], 21, 5, 5, 11, 1, '#2b2e33');
            m.paint(s[0], s[1] + 4, 23, 5, 1, 7, '#1e2024');
            m.paint(s[0] + 1, s[1] + 4, 25, 3, 1, 3, '#4a4e55');
            m.paint(s[0] + 2, s[1] + 4, 29, 2, 1, 1, A, MAT.EMIT);
            m.paint(s[0] + 1, s[1] + 4, 31, 3, 1, 1, '#3a3e45');
        });
        // headset on its stand
        m.rbox(-31, 2, 21, 6, 6, 1, 1, '#37474f');
        m.box(-29, 4, 22, 2, 2, 9, '#263238');
        m.box(-33, 4, 30, 10, 2, 2, '#212121');                                                     // headband
        m.box(-33, 3, 25, 2, 4, 5, '#1b1c1f'); m.box(-25, 3, 25, 2, 4, 5, '#1b1c1f');               // ear cups
        m.paint(-33, 4, 26, 1, 2, 3, A, MAT.EMIT); m.paint(-24, 4, 26, 1, 2, 3, A, MAT.EMIT);
        // two screens (thin bezels, dark stands)
        var o = { bc: '#15171a', stand: '#2b2e33', ledC: A };
        mon(m, { plan: [-31, -11, 30, 2], z: 23, h: 22, foot: [-22, -14, 12, 5] }, o);
        mon(m, { plan: [1, -11, 30, 2], z: 23, h: 22, foot: [10, -14, 12, 5] }, o);
        m.paint(-29, -13, 25, 26, 1, 1, A, MAT.EMIT); m.paint(3, -13, 25, 26, 1, 1, A, MAT.EMIT);   // back glow strips
        // RGB keyboard (lit caps), gaming mouse
        keyboard(m, -16, 2, 28, 7, 22, { caseC: '#16181b', key: '#2a2d33', key2: '#23262b', gap: '#101215', hi: '#3a3f47', acc: A, light: A });
        mouse(m, 21, 3, 22, 4, 6, '#26292e', A);
        return m;
    });

    // ---- Developer: two portrait screens, a laptop, a mechanical keyboard, a glass-side PC tower, a duck ----
    reg('desk', 'developer', ['walnut', 'wood', 'black', 'white', 'grey', 'black-green'], function (P) {
        var m = S.model(-37, -19, 37, 15, 64);
        var A = P.accent;
        // steel sled legs: runners, posts, a back rail
        [-35, 32].forEach(function (lx) {
            m.box(lx, -16, 0, 3, 30, 2, P.metalDk, MAT.SHINY);
            leg(m, lx, -16, 3, 3, 2, 14, P.metal, tone(P.metal, 1.15), MAT.SHINY);
            leg(m, lx, 11, 3, 3, 2, 14, P.metal, tone(P.metal, 1.15), MAT.SHINY);
            m.box(lx, -13, 13, 3, 24, 2, P.metalDk, MAT.SHINY);
        });
        m.box(-33, -15, 13, 66, 2, 3, P.metalDk, MAT.SHINY);
        // the PC tower under the right end: glass sides with lit fans, front vents, a power LED
        m.box(18, -12, 0, 11, 22, 15, function (x, y, z) {
            if (z === 14) return '#3a3f47';
            if (y === 9) return '#2a2e35';
            if (x === 18 || x === 28) return (y > -11 && y < 8 && z > 1 && z < 13) ? '#14181d' : '#2a2e35';
            return '#1f2329';
        });
        [18, 28].forEach(function (gx) {                                                            // fans + GPU behind the glass
            [[-6, 9.5], [2, 9.5]].forEach(function (f) { ringXZY(m, gx, f[0], f[1], 2.8, 1.5, A); });
            m.paint(gx, -2, 3, 1, 8, 2, '#78909c');
            m.paint(gx, -2, 5, 1, 8, 1, A, MAT.EMIT);
        });
        m.paint(20, 9, 13, 7, 1, 1, '#14171b');                                                     // drive bay
        for (var vz = 3; vz < 11; vz += 2) m.paint(20, 9, vz, 7, 1, 1, '#16191d');                  // vents
        m.paint(26, 9, 11, 1, 1, 1, A, MAT.EMIT);
        // butcher-block top
        deskTop(m, [-36, -18, 72, 32], 16, 5, P.top, P.faceDk, { grain: 6 });
        m.each(function (x, y, z, v) { return z === 20 && y > -18 && y < 13 && x > -36 && x < 35 && (x + 36) % 6 === 0 ? tone(P.top, 0.9) : null; });
        // desk mat with accent stitching, sticky notes
        mat(m, -19, 1, 42, 11, 21, '#20242a');
        m.paint(-19, 11, 21, 42, 1, 1, A);
        m.box(-31, 2, 21, 6, 6, 1, '#fff176'); m.paint(-31, 7, 21, 6, 1, 1, '#f9a825');
        m.box(-30, 3, 22, 5, 5, 1, '#ffee58');
        // the laptop on the left: deck (keys + pad), lid with the screen toward the sitter
        m.rbox(-35, -7, 21, 17, 7, 1, 1, '#b0bec5', MAT.SHINY);
        m.box(-33, -7, 22, 13, 3, 1, function (x, y) { return (x + y) % 2 ? '#78909c' : '#90a4ae'; });
        m.box(-29, -3, 22, 5, 2, 1, '#cfd8dc');
        m.box(-35, -10, 21, 17, 3, 15, function (x, y, z) { return y < -8 ? (z === 35 ? '#90a4ae' : '#78909c') : (z === 35 ? '#546e7a' : '#37474f'); });
        m.box(-34, -8, 23, 15, 1, 11, '#2c4a63', MAT.SCREEN);
        m.paint(-28, -10, 27, 3, 1, 3, '#eceff1');                                                  // logo on the lid
        // two portrait screens on light stands
        var o = { bc: '#1b1f24', stand: '#a7b1b9' };
        mon(m, { plan: [-16, -11, 18, 2], z: 23, h: 30, foot: [-10, -14, 6, 5] }, o);
        mon(m, { plan: [3, -11, 18, 2], z: 23, h: 30, foot: [9, -14, 6, 5] }, o);
        // the rubber duck on top of the right screen (beak toward the sitter)
        m.ellipsoid(16, -11.5, 55, 2.6, 2.2, 2, '#ffd54f');
        m.ellipsoid(15.5, -11, 58, 1.7, 1.6, 1.7, '#ffe082');
        m.box(15, -10, 58, 2, 2, 1, '#ff8f00');
        m.paint(14, -10, 59, 1, 1, 1, '#212121'); m.paint(17, -10, 59, 1, 1, 1, '#212121');
        // mechanical keyboard: cream caps, blue mods, accent escape
        keyboard(m, -15, 3, 30, 7, 22, { caseC: '#2d3035', key: '#ece6d6', key2: '#d9d2bf', gap: '#22252a', hi: '#8fa8bf', acc: A });
        mouse(m, 17, 4, 22, 4, 6, '#3a3f45');
        return m;
    });
    // A ring (fan) painted on a side face x = gx: centre (cy, cz) in y/z.
    function ringXZY(m, gx, cy, cz, r1, r0, col) {
        for (var z = Math.floor(cz - r1); z <= Math.ceil(cz + r1); z++) for (var y = Math.floor(cy - r1); y <= Math.ceil(cy + r1); y++) {
            var d = Math.hypot(y + 0.5 - cy, z + 0.5 - cz);
            if (d <= r1 && d >= r0) m.paint(gx, y, z, 1, 1, 1, col, MAT.EMIT);
            else if (d < r0) m.paint(gx, y, z, 1, 1, 1, '#2a2e35');
        }
    }

    // ---- Creative Studio: a calibrated screen under a shading hood, a pen tablet, a monstera, birch trestles ----
    reg('desk', 'creative', ['white', 'wood', 'white-pink', 'white-blue', 'black', 'walnut'], function (P) {
        var m = S.model(-40, -19, 39, 15, 58);
        var BIRCH = '#d9b98c', BIRCH_DK = '#b8955f', A = P.accent;
        // birch trestles: splayed legs (wide at the floor), a stretcher, the back rail
        [-38, 34].forEach(function (lx) {
            rod(m, [lx + 1.5, -16, 0.5], [lx + 1.5, -12, 15], BIRCH);
            rod(m, [lx + 2.5, -16, 0.5], [lx + 2.5, -12, 15], BIRCH);
            rod(m, [lx + 1.5, 12, 0.5], [lx + 1.5, 8, 15], BIRCH);
            rod(m, [lx + 2.5, 12, 0.5], [lx + 2.5, 8, 15], BIRCH);
            m.box(lx, -14, 7, 4, 24, 2, BIRCH_DK);
            m.box(lx, -13, 14, 4, 22, 2, BIRCH_DK);
            m.paint(lx, -17, 0, 4, 31, 1, tone(BIRCH, 0.8));
        });
        m.box(-30, -16, 13, 60, 2, 3, BIRCH_DK);
        deskTop(m, [-38, -18, 76, 32], 16, 5, P.top, P.face, { apron: BIRCH, side: tone(P.top, 0.95), board: 3 });
        // the screen under its hood: two side flaps and a top flap, dark felt
        var HOOD = '#1d2024', HOOD_HI = '#33373d';
        mon(m, { plan: [-20, -12, 40, 2], z: 24, h: 25, foot: [-6, -15, 12, 4] }, { bc: '#263238', stand: '#cfd8dc', bez: 2 });
        m.box(-24, -14, 24, 4, 6, 30, function (x, y, z) { return x === -21 ? HOOD_HI : HOOD; }, MAT.SOFT);
        m.box(20, -14, 24, 4, 6, 30, function (x, y, z) { return x === 20 ? HOOD_HI : HOOD; }, MAT.SOFT);
        m.box(-24, -14, 51, 48, 6, 3, function (x, y, z) { return z === 53 ? '#2a2e33' : HOOD; }, MAT.SOFT);
        m.paint(-24, -9, 24, 4, 1, 1, '#2a2e33'); m.paint(20, -9, 24, 4, 1, 1, '#2a2e33');
        // pen tablet with its active area, an accent LED and the pen lying on it
        m.rbox(7, 1, 21, 22, 12, 1, 1, '#2b2d31');
        m.box(9, 3, 21, 18, 8, 1, '#3a3d42');
        m.paint(8, 2, 21, 2, 1, 1, A, MAT.EMIT);
        m.box(12, 6, 22, 12, 2, 1, '#eceff1'); m.paint(12, 6, 22, 2, 2, 1, '#212121');
        // monstera in a cream pot: big split leaves
        m.cone(-31, -12, 21, 4.2, 5, 7, '#e7e2da', MAT.SOLID, 1);
        m.cyl(-31, -12, 27, 4.8, 4.8, 1, '#f3efe8');
        m.cyl(-31, -12, 27, 3.6, 3.6, 1, '#4e342e');
        var LEAF = '#2e7d4f', LEAF2 = '#3f9a63', LEAF3 = '#256b42';
        [[-31, -12, 28, -36, -16, 38], [-31, -12, 28, -26, -16, 40], [-31, -12, 28, -33, -9, 36], [-31, -12, 28, -27, -8, 35], [-31, -12, 28, -31, -14, 42]].forEach(function (s, i) {
            m.line([s[0], s[1], s[2]], [s[3], s[4], s[5]], 1, '#33691e');
            m.ellipsoid(s[3], s[4], s[5], 3.6, 2.6, 1.6, i % 2 ? LEAF2 : LEAF, MAT.SOFT);
            m.carve(s[3] - 3, s[4], s[5], 2, 1, 1);                                                  // the splits
            m.paint(Math.round(s[3]) - 1, Math.round(s[4]), Math.round(s[5]), 3, 1, 1, LEAF3, MAT.SOFT);
        });
        // pen cup with three pens
        m.cyl(32.5, -13.5, 21, 2.6, 2.6, 7, '#455a64');
        m.box(31, -15, 27, 2, 2, 4, '#e53935'); m.box(33, -14, 27, 2, 2, 5, '#1e88e5'); m.box(32, -13, 27, 2, 2, 3, A);
        // white keyboard, a white mouse, a swatch book
        keyboard(m, -20, 3, 24, 7, 21, { caseC: '#dfe3e6', key: '#ffffff', key2: '#eef1f3', gap: '#cfd8dc', hi: '#cfd8dc', acc: A });
        return m;
    });

    // ---- Trader: six screens on a pole, an LED ticker in the front edge, a phone, a brass bull ----
    reg('desk', 'trader', ['black', 'black-gold', 'black-green', 'grey', 'walnut', 'white'], function (P) {
        var m = S.model(-49, -19, 49, 15, 70);
        var A = P.accent;
        // waterfall ends with a lit slit, a modesty panel
        [-48, 44].forEach(function (ex) {
            m.box(ex, -18, 0, 4, 32, 16, function (x, y, z) { return z === 0 ? P.seam : y === 13 ? P.face : P.body; });
            m.paint(ex + 1, 13, 2, 2, 1, 12, A, MAT.EMIT);
            m.paint(ex + (ex < 0 ? 0 : 3), -15, 3, 1, 26, 1, tone(P.body, 0.9));
        });
        m.box(-44, -16, 2, 88, 2, 14, function (x, y, z) { return z === 8 ? P.leg : P.faceDk; });
        deskTop(m, [-48, -18, 96, 32], 16, 5, P.top, P.faceDk, { speckle: 0.025 });
        m.paint(-48, 13, 20, 96, 1, 1, A, MAT.EMIT);                                                // lit trim on the front lip
        // the LED ticker in the front edge: a dark band with green / red dots
        m.paint(-42, 13, 16, 84, 1, 3, '#0b0f0c');
        for (var x = -41, k = 0; x < 41; x += 2, k++) if (k % 7 !== 3) m.paint(x, 13, 17 + (k % 3 === 0 ? 1 : 0), 1, 1, 1, k % 11 < 6 ? '#4caf50' : '#ef5350', MAT.EMIT);
        // the pole and six screens on arms
        var SC = [[-44, 44], [-14, 44], [16, 44], [-44, 23], [-14, 23], [16, 23]].map(function (s) { return { plan: [s[0], -11, 28, 2], z: s[1], h: 19 }; });
        m.rbox(-4, -18, 21, 8, 4, 1, 1, '#3a3f45', MAT.SHINY);
        m.box(-2, -17, 22, 4, 3, 44, function (x, y, z) { return z === 42 || z === 43 ? '#5c636b' : x === -2 ? '#5a6068' : '#4a4f56'; }, MAT.SHINY);
        m.box(-3, -18, 65, 6, 4, 1, '#5c636b', MAT.SHINY);
        [33, 53].forEach(function (az) {                                                            // cross arms with three VESA plates each
            m.box(-38, -18, az - 1, 76, 2, 3, '#3a3f45', MAT.SHINY);
            [-30, 0, 30].forEach(function (vx) { m.box(vx - 3, -16, az - 3, 6, 2, 6, '#2b2f34'); });
        });
        SC.forEach(function (sc) { mon(m, sc, { mount: 'none', bc: '#15181b', chin: 2 }); });
        // desk phone: body, handset, keypad
        m.rbox(-45, -6, 21, 11, 8, 3, 1, '#37474f');
        m.box(-44, -5, 24, 3, 6, 2, '#1c2326');
        m.box(-40, -4, 24, 4, 4, 1, function (x, y) { return (x + y) % 2 ? '#90a4ae' : '#b0bec5'; });
        m.paint(-40, -4, 24, 1, 1, 1, '#ffca28', MAT.EMIT);
        m.box(-43, 2, 21, 2, 1, 1, '#1c2326');                                                     // cord
        // a phone face up, the brass bull (body, head, horns)
        m.box(-26, 4, 21, 4, 7, 1, '#111417'); m.box(-25, 5, 21, 2, 5, 1, '#3949ab', MAT.EMIT);
        m.rbox(40, -6, 21, 5, 4, 1, 1, '#5d4037');
        m.ellipsoid(42.5, -4, 25, 3, 2, 2.2, BRASS, MAT.SHINY);
        m.ellipsoid(44.5, -4, 26.5, 1.4, 1.4, 1.4, BRASS, MAT.SHINY);
        m.box(44, -6, 27, 2, 1, 2, BRASS_HI, MAT.SHINY); m.box(44, -3, 27, 2, 1, 2, BRASS_HI, MAT.SHINY);
        m.box(40, -5, 22, 2, 2, 2, BRASS_DK, MAT.SHINY); m.box(43, -5, 22, 2, 2, 2, BRASS_DK, MAT.SHINY);
        // the trading keyboard: yellow function row, red / green keys
        keyboard(m, -16, 3, 32, 7, 21, { caseC: '#25292e', key: '#5b6168', key2: '#4a5057', gap: '#1a1d21', hi: '#f9a825' });
        m.paint(-15, 6, 22, 5, 1, 1, '#e53935'); m.paint(-15, 8, 22, 5, 1, 1, '#43a047');
        mouse(m, 20, 4, 21, 4, 6, '#37474f');
        return m;
    });

    // ---- Streamer: an ultrawide + a chat screen on a lit riser, a ring light, a boom mic, a webcam ----
    reg('desk', 'streamer', ['black-cyan', 'white-pink', 'black-red', 'black-gold', 'white-blue', 'black'], function (P) {
        var m = S.model(-40, -19, 39, 15, 70);
        var A = P.accent, WARM = '#fff3d6';
        // feet, posts, cable tray
        [-38, 35].forEach(function (fx) {
            m.rbox(fx, -17, 0, 3, 30, 2, 1, P.leg);
            m.box(fx, -3, 2, 3, 4, 14, function (x, y) { return y === 0 ? P.legHi : P.leg; });
        });
        m.box(-34, -12, 12, 68, 3, 3, P.metalDk, MAT.SHINY);
        deskTop(m, [-38, -18, 76, 32], 16, 5, P.top, P.faceDk, { speckle: 0.03 });
        m.box(-36, 12, 15, 72, 2, 1, A, MAT.EMIT);                                                  // underglow strip
        // big mouse pad
        m.box(-20, 1, 21, 46, 11, 1, '#16181b'); m.paint(-20, 11, 21, 46, 1, 1, A, MAT.EMIT);
        // the riser shelf with its lit front strip
        m.box(-36, -18, 21, 72, 8, 5, function (x, y, z) { return z === 25 ? (y === -11 || x === -36 || x === 35 ? tone(P.top, 1.07) : P.top) : y === -11 ? P.face : tone(P.face, 0.9); });
        m.carve(-30, -11, 21, 60, 1, 3);                                                            // the shelf's open front
        m.paint(-30, -12, 21, 60, 1, 3, tone(P.face, 0.7));
        m.paint(-35, -11, 24, 70, 1, 1, A, MAT.EMIT);
        // stream deck: a grid of lit buttons
        m.rbox(-34, 3, 21, 12, 8, 2, 1, '#1e2125');
        var BT = ['#ff1744', '#00e5ff', '#76ff03', '#ffc400', '#d500f9', '#2979ff'];
        for (var i = 0, n = 0; i < 4; i++) for (var j = 0; j < 2; j++) m.box(-33 + i * 3, 4 + j * 3, 23, 2, 2, 1, BT[(n++) % BT.length], MAT.EMIT);
        // screens on the riser
        var o = { bc: '#111316', stand: '#2b2f35', footZ: 26 };
        mon(m, { plan: [-30, -13, 52, 2], z: 28, h: 20, foot: [-10, -16, 12, 3] }, o);
        mon(m, { plan: [24, -13, 12, 2], z: 28, h: 20, foot: [27, -16, 6, 3] }, o);
        // webcam on the ultrawide
        m.rbox(-7, -14, 48, 6, 3, 4, 1, '#1c1f23');
        m.paint(-5, -12, 49, 2, 1, 2, '#5c6bc0', MAT.EMIT); m.paint(-2, -12, 51, 1, 1, 1, '#ff1744', MAT.EMIT);
        // the ring light on its pole from the riser: a lit ring toward the sitter, a phone clamp
        m.box(-31, -18, 26, 2, 2, 26, '#2b2f35', MAT.SHINY);
        ringXZ(m, -30, 59, -18, 3, 5.2, 8.6, function (x, y, z) { return y === -16 ? WARM : '#e0d2b0'; }, MAT.EMIT);
        ringXZ(m, -30, 59, -18, 1, 5.2, 8.6, '#3a3f45');
        m.box(-32, -17, 57, 4, 2, 4, '#2b2f35');
        // the boom mic: a post at the front-right corner, an arm, the mic hanging by the sitter + pop filter
        m.box(33, 7, 21, 2, 2, 25, '#2b2f35', MAT.SHINY);
        m.box(32, 6, 21, 4, 4, 1, '#3a3f45');
        m.box(17, 7, 44, 18, 2, 2, '#3a3f45', MAT.SHINY);
        m.box(17, 7, 40, 2, 2, 4, '#3a3f45');
        m.rbox(16, 6, 30, 4, 4, 10, 1, '#1c1f23');
        m.box(16, 6, 37, 4, 4, 3, '#8d949c', MAT.SHINY);
        m.paint(16, 6, 39, 4, 4, 1, '#5b6168');
        ringXZ(m, 18, 35, 10, 2, 2.5, 3.6, '#455a64');
        ringXZ(m, 18, 35, 10, 2, 0, 2.5, '#2d3136', MAT.SOFT);
        // keyboard + mouse
        keyboard(m, -15, 3, 30, 7, 22, { caseC: '#16181b', key: '#2a2d33', key2: '#23262b', gap: '#101215', hi: '#3a3f47', light: A });
        mouse(m, 18, 4, 22, 4, 6, '#26292e', A);
        return m;
    });

    // ---- Retro 80s: a steel tanker desk, a beige CRT terminal, a dot-matrix printer, floppies, a cube ----
    reg('desk', 'retro', ['wood', 'walnut', 'grey', 'white', 'grey-orange', 'black'], function (P) {
        var m = S.model(-37, -19, 37, 15, 52);
        var BEIGE = '#d8cfb4', BEIGE_DK = '#c2b796', BEIGE_LT = '#e6dec7', STEEL = P.id === 'black' ? '#4a4f56' : '#9aa7ae', STEEL_DK = tone(STEEL, 0.8);
        // steel pedestals: three drawers with chrome handles, the 80s trim stripe
        [-36, 20].forEach(function (px) {
            pedestal(m, P, px, -16, 16, 30, 16, 3, { body: STEEL_DK, front: STEEL, pull: '#eceff1', flat: true, pw: 6 });
            m.paint(px, 13, 15, 16, 1, 1, P.accent, MAT.SHINY);
            m.paint(px, -16, 15, 1, 29, 1, P.accent, MAT.SHINY); m.paint(px + 15, -16, 15, 1, 29, 1, P.accent, MAT.SHINY);
            for (var d = 0; d < 3; d++) m.paint(px + 5, 14, 3 + d * 4, 6, 1, 1, '#90a4ae', MAT.SHINY);    // the handle's lower lip
        });
        m.box(-20, -16, 2, 40, 2, 14, STEEL_DK, MAT.SHINY);
        // wood-grain top (the laminate), the centre drawer in the apron
        deskTop(m, [-36, -18, 72, 32], 16, 5, P.top, P.faceDk, { grain: 6 });
        m.paint(-12, 13, 16, 24, 1, 3, tone(P.faceDk, 0.92));
        m.paint(-12, 13, 16, 1, 1, 3, P.seam); m.paint(11, 13, 16, 1, 1, 3, P.seam);
        m.box(-4, 14, 17, 8, 1, 1, '#eceff1', MAT.SHINY);
        // the CRT: the back hump, the casing with a dark recess round the glass, an LED, a sticky note
        m.rbox(-11, -17, 24, 22, 8, 20, 3, function (x, y, z) { return y === -17 && z > 27 && z < 41 && (z % 3 === 0) && x > -8 && x < 7 ? '#a99f80' : '#cfc5a8'; });
        m.rbox(-16, -9, 21, 32, 8, 28, 2, function (x, y, z) {
            if (z === 48 || (z === 47 && (y === -9 || y === -2))) return BEIGE_LT;
            if ((x === -16 || x === 15) && z > 24 && z < 44 && (z % 4 === 0)) return BEIGE_DK;           // side vents
            return BEIGE;
        });
        m.carve(-13, -2, 22, 26, 1, 22);
        m.box(-13, -3, 22, 26, 1, 22, '#1a1d1a');
        m.box(-12, -2, 25, 24, 1, 19, '#263238');
        m.box(-10, -2, 27, 20, 1, 15, '#2c4a63', MAT.SCREEN);
        m.box(-10, -2, 22, 6, 1, 1, '#3e4a3e');                                                      // vent slot
        m.box(10, -2, 22, 2, 1, 1, '#76ff03', MAT.EMIT);                                             // power LED
        m.box(11, -1, 44, 5, 1, 5, function (x, y, z) { return z === 44 ? '#fbc02d' : '#fff176'; });  // sticky note
        // dot-matrix printer with tractor-feed paper rising from its back
        m.rbox(18, -17, 21, 16, 10, 6, 1, '#e0d7bd');
        m.paint(20, -8, 24, 12, 1, 1, '#3e3a30'); m.paint(31, -8, 22, 1, 1, 1, '#76ff03', MAT.EMIT);
        m.paint(19, -15, 26, 14, 4, 1, '#cbc1a3');
        m.box(20, -17, 27, 12, 2, 8, function (x, y, z) {
            if (x === 20 || x === 31) return '#b0aa98';
            return (z - 27) % 3 === 1 ? '#cfe8cf' : '#f6f4ec';
        });
        // floppy disks (a stack) and a puzzle cube
        [['#1565c0', 21], ['#c62828', 22], ['#2e7d32', 23]].forEach(function (f, i) {
            m.box(-34 + (i === 1 ? 1 : 0), -4 - (i === 2 ? 1 : 0), f[1], 7, 7, 1, f[0]);
            m.paint(-32 + (i === 1 ? 1 : 0), -4 - (i === 2 ? 1 : 0), f[1], 3, 2, 1, '#b0bec5');
        });
        m.box(-31, 0, 24, 3, 2, 1, '#eceff1');
        m.box(26, 4, 21, 4, 4, 4, function (x, y, z) {
            if (z === 24) return (x + y) % 2 ? '#ffffff' : '#fdd835';
            if (y === 7) return z === 22 ? '#1e88e5' : '#c62828';
            if (x === 29) return z === 23 ? '#43a047' : '#ff9800';
            return '#1e88e5';
        });
        // the chunky beige keyboard, a beige mouse with its cord to the terminal
        keyboard(m, -16, 3, 32, 8, 21, { caseC: BEIGE, key: '#efe8d2', key2: '#e3dbc3', gap: '#bdb394', hi: '#a89f86', acc: '#c62828' });
        m.paint(20, -1, 20, 1, 6, 1, '#5d5747');
        m.rbox(19, 5, 21, 4, 6, 2, 1, BEIGE);
        m.paint(19, 5, 22, 4, 2, 1, BEIGE_LT); m.paint(21, 5, 22, 1, 2, 1, '#a89f86');
        return m;
    });

    // ---- Maker Bench: a pegboard of tools, an oscilloscope, a soldering mat + board, parts drawers, bins ----
    reg('desk', 'maker', ['wood', 'grey-orange', 'black-green', 'walnut', 'grey', 'black'], function (P) {
        var m = S.model(-41, -19, 41, 15, 58);
        var PEG = '#c8a46e', PEG_DK = '#a8844e', HOLE = '#6d5230', A = P.accent;
        [[-40, -18], [37, -18], [-40, 11], [37, 11]].forEach(function (l) { leg(m, l[0], l[1], 3, 3, 0, 16, P.metalDk, P.metal, MAT.SHINY); });
        m.box(-38, -16, 4, 76, 28, 2, function (x, y) { return y === 11 ? tone(P.metalDk, 1.15) : P.metalDk; }, MAT.SHINY);   // lower shelf
        // parts bins on the shelf (open tops with parts), white labels
        [[-36, A], [22, '#1e88e5']].forEach(function (b) {
            m.box(b[0], 1, 6, 14, 11, 7, b[1]);
            m.carve(b[0] + 1, 2, 9, 12, 9, 4);
            m.box(b[0] + 1, 2, 9, 12, 9, 1, function (x, y) { var h = C.hash(x, y, 5); return h < 0.3 ? '#90a4ae' : h < 0.5 ? '#ffca28' : h < 0.6 ? '#e53935' : '#455a64'; });
            m.paint(b[0] + 2, 11, 9, 5, 1, 2, '#eceff1');
        });
        deskTop(m, [-40, -18, 80, 32], 16, 5, P.top, P.faceDk, { grain: 9 });
        m.each(function (x, y, z) { return z === 20 && (y + 18) % 4 === 3 && y < 13 && x > -40 && x < 39 ? tone(P.top, 0.9) : null; });   // workbench planks
        // the pegboard with holes and the tools hanging on it
        m.box(-40, -18, 21, 24, 3, 34, function (x, y, z) {
            if (z === 54) return tone(PEG, 1.1);
            if (y === -16 && (x + 40) % 3 === 2 && (z - 21) % 3 === 2) return HOLE;
            return y === -16 ? PEG : PEG_DK;
        });
        m.box(-37, -15, 49, 2, 1, 6, '#90a4ae', MAT.SHINY); m.box(-34, -15, 49, 2, 1, 6, '#90a4ae', MAT.SHINY);   // pliers
        m.box(-38, -15, 42, 2, 1, 7, '#d32f2f'); m.box(-33, -15, 42, 2, 1, 7, '#d32f2f');
        m.box(-28, -15, 46, 2, 1, 8, '#b0bec5', MAT.SHINY); m.box(-29, -15, 39, 3, 1, 7, '#fbc02d');              // screwdriver
        m.box(-21, -15, 39, 2, 1, 12, '#6d4c41'); m.box(-24, -15, 50, 8, 1, 4, '#607d8b', MAT.SHINY);           // hammer
        [['#e53935', -38], ['#1e88e5', -31], ['#43a047', -24]].forEach(function (s) {                          // wire spools
            m.box(s[1], -15, 29, 6, 2, 6, '#5d4037');
            m.box(s[1] + 1, -14, 30, 4, 1, 4, s[0]);
            m.paint(s[1] + 2, -14, 31, 2, 1, 2, '#3e2723');
        });
        // the oscilloscope: case, a screen with a green trace, knobs
        m.rbox(-37, -14, 21, 16, 10, 10, 1, '#cfd8dc');
        m.paint(-37, -5, 21, 16, 1, 10, '#b0bec5');
        m.paint(-35, -5, 23, 9, 1, 6, '#0b1a10', MAT.EMIT);
        var TR = [0, -1, -2, -2, -1, 0, 1, 2, 2];
        for (var i = 0; i < 9; i++) m.paint(-35 + i, -5, 26 - TR[i], 1, 1, 1, '#69f0ae', MAT.EMIT);
        m.box(-25, -4, 27, 2, 1, 2, '#37474f'); m.box(-25, -4, 23, 2, 1, 2, '#37474f');
        m.box(-23, -4, 23, 1, 1, 1, '#ff5252', MAT.EMIT);
        // soldering mat (grid) with a circuit board, chips and gold pads
        m.box(-24, -6, 21, 46, 19, 1, function (x, y) { return (x + 24) % 5 === 4 || (y + 6) % 5 === 4 ? '#26a69a' : '#00897b'; }, MAT.SOFT);
        m.box(-22, -4, 22, 10, 7, 1, '#2e7d32');
        m.box(-20, -2, 23, 3, 2, 1, '#212121'); m.box(-15, -3, 23, 2, 2, 1, '#212121');
        m.paint(-21, 2, 22, 8, 1, 1, '#ffd54f', MAT.SHINY);
        // helping hands: a weighted base, a post, two clip arms
        m.rbox(-18, -10, 22, 4, 4, 2, 1, '#37474f');
        m.box(-17, -9, 24, 2, 2, 6, '#b0bec5', MAT.SHINY);
        m.box(-21, -9, 29, 4, 2, 1, '#b0bec5', MAT.SHINY); m.box(-15, -9, 28, 4, 2, 1, '#b0bec5', MAT.SHINY);
        m.box(-22, -9, 28, 2, 2, 2, '#d32f2f'); m.box(-12, -9, 27, 2, 2, 2, '#d32f2f');
        // parts drawers: rows of coloured fronts, the lit top edge
        m.box(25, -17, 21, 13, 8, 14, '#cfd8dc');
        m.paint(25, -17, 34, 13, 8, 1, A, MAT.EMIT);
        var DC = ['#ef5350', '#ffca28', '#66bb6a', '#42a5f5'];
        for (var r = 0; r < 4; r++) for (var c = 0; c < 3; c++) {
            m.box(26 + c * 4, -10, 22 + r * 3, 3, 1, 2, DC[(r + c) % 4]);
            m.paint(27 + c * 4, -10, 22 + r * 3, 1, 1, 1, '#eceff1');
        }
        // soldering station (red read-out) and the iron in its holder
        m.rbox(24, -6, 21, 10, 8, 4, 1, '#37474f');
        m.paint(25, 1, 22, 4, 1, 2, '#ff5252', MAT.EMIT);
        m.box(30, 1, 22, 2, 1, 2, '#90a4ae');
        m.cyl(31.5, -3.5, 25, 1.6, 1.6, 4, '#b0bec5', MAT.SHINY);
        m.box(30, -5, 29, 2, 2, 4, '#1565c0');
        m.box(30, -5, 33, 2, 2, 1, '#ffca28', MAT.EMIT);
        // the screen on an arm from the back edge
        var sc = { plan: [-6, -12, 30, 2], z: 30, h: 20 };
        armMount(m, [7, -18, 4, 3], 21, 41, [sc]);
        mon(m, sc, { mount: 'none', bc: '#1b1f24' });
        keyboard(m, -14, 3, 26, 7, 22);
        mouse(m, 16, 4, 22, 4, 6);
        return m;
    });

    // ---- Cosy Home Office: warm wood, fairy lights, a fabric lamp, a cat asleep in its bed ----
    reg('desk', 'cosy', ['wood', 'walnut', 'white', 'white-pink', 'grey', 'walnut-brass'], function (P) {
        var m = S.model(-35, -19, 35, 15, 52);
        var BULB = ['#ffe082', '#ffcc80', P.accent, '#fff59d'];
        // tapered legs with brass feet
        [[-32, -16], [29, -16], [-32, 10], [29, 10]].forEach(function (l) {
            m.box(l[0], l[1], 7, 3, 3, 9, function (x, y) { return x === l[0] || y === l[1] + 2 ? P.legHi : P.leg; });
            m.box(l[0] + (l[0] < 0 ? 1 : 0), l[1] + (l[1] < 0 ? 1 : 0), 2, 2, 2, 5, P.leg);
            m.box(l[0] + (l[0] < 0 ? 1 : 0), l[1] + (l[1] < 0 ? 1 : 0), 0, 2, 2, 2, P.pull, MAT.SHINY);
        });
        deskTop(m, [-34, -18, 68, 32], 16, 5, P.top, P.face, { grain: 8 });
        // the drawer in the apron with its knob
        m.paint(-12, 13, 16, 1, 1, 3, P.seam); m.paint(12, 13, 16, 1, 1, 3, P.seam);
        m.box(-1, 14, 17, 2, 1, 2, P.pull, MAT.SHINY);
        // fairy lights strung along the front edge (a sagging wire, warm bulbs)
        for (var x = -33, k = 0; x < 33; x++) {
            var u = ((x + 33) % 12) / 12, sag = Math.round(Math.sin(u * Math.PI) * 2);
            m.paint(x, 13, 19 - sag, 1, 1, 1, '#5d4a3a');
            if ((x + 33) % 4 === 2) { m.box(x, 14, 17 - sag, 1, 1, 2, BULB[k % 4], MAT.EMIT); k++; }
        }
        m.box(-34, 13, 16, 1, 1, 4, '#5d4a3a'); m.box(33, 13, 16, 1, 1, 4, '#5d4a3a');
        // the table lamp: a pool of warm light, a brass base and stem, a cream fabric shade lit from inside
        m.each(function (x, y, z) { return z === 20 && x >= -34 && x < -18 && y >= -18 && y < -4 && Math.hypot(x + 28, y + 12) < 8 ? mix(P.top, '#ffe082', 0.22) : null; });
        m.cyl(-28, -12, 21, 3.2, 3.2, 1, '#a8861c', MAT.SHINY);
        m.box(-29, -13, 22, 2, 2, 9, '#c9a227', MAT.SHINY);
        m.cone(-28, -12, 30, 5, 3.6, 8, function (x, y, z) { return z === 30 ? '#fff3d6' : z === 37 ? '#e8d3a8' : '#f3e5c8'; }, MAT.EMIT);
        m.cyl(-28, -12, 30, 3.4, 3.4, 1, '#ffe7a8', MAT.EMIT);
        // the cat bed (a soft rim) and the cat curled up asleep
        m.rbox(16, -12, 21, 16, 12, 3, 2, '#b39ddb', MAT.SOFT);
        m.box(18, -10, 22, 12, 8, 2, '#d1c4e9', MAT.SOFT);
        m.box(19, -9, 23, 10, 6, 1, '#ede7f6', MAT.SOFT);
        m.ellipsoid(25, -6, 25, 5.4, 3.6, 2.6, function (x, y, z) { return (x % 3 === 0 && z > 24) ? '#c66f1c' : z >= 27 ? '#f5b971' : '#ef9a3a'; }, MAT.SOFT);
        m.ellipsoid(20, -5.5, 26, 2.6, 2.6, 2.2, '#f0a24a', MAT.SOFT);                                // the head tucked in
        m.box(18, -7, 28, 2, 2, 1, '#ef9a3a', MAT.SOFT); m.box(21, -7, 28, 2, 2, 1, '#ef9a3a', MAT.SOFT);   // ears
        m.paint(18, -4, 26, 1, 1, 1, '#6d3b12'); m.paint(21, -4, 26, 1, 1, 1, '#6d3b12');           // closed eyes
        m.paint(19, -3, 24, 3, 1, 1, P.accent);                                                      // collar
        m.box(26, -3, 24, 4, 2, 2, '#c66f1c', MAT.SOFT);                                             // the tail round the front
        // the screen with a string of lights along its top
        mon(m, { plan: [-19, -11, 32, 2], z: 23, h: 22, foot: [-9, -14, 12, 5] }, { bc: '#263238', stand: '#8d6e63' });
        for (var bx = -17, b = 1; bx < 12; bx += 4, b++) m.box(bx, -9, 43, 1, 1, 2, BULB[b % 4], MAT.EMIT);
        m.paint(-19, -9, 44, 32, 1, 1, '#5d4a3a');
        keyboard(m, -15, 3, 30, 7, 21, { caseC: '#4e4038', key: '#efe7da', key2: '#e0d6c6', gap: '#8d7b6b', hi: '#d7ccc8' });
        mouse(m, 17, 4, 21, 4, 6, '#d7ccc8');
        return m;
    });

    // ---- Standing Desk: a sit-stand frame raised to standing height, one screen on an arm ----
    reg('desk', 'standing', ['white', 'black', 'wood', 'walnut', 'grey'], function (P) {
        var m = S.model(-33, -19, 33, 11, 66);
        [[-32, -30], [24, 26]].forEach(function (s) {
            var fx = s[0], cx = s[1];
            m.rbox(fx, -16, 0, 8, 24, 2, 1, P.metalDk, MAT.SHINY);                                      // T foot
            m.box(fx + 1, -16, 0, 2, 1, 1, '#1b1e22'); m.box(fx + 1, 7, 0, 2, 1, 1, '#1b1e22');
            m.box(cx, -6, 2, 4, 4, 13, function (x, y) { return x === cx || y === -3 ? tone(P.metal, 1.1) : P.metal; }, MAT.SHINY);   // lower stage
            m.box(cx, -6, 15, 4, 4, 11, function (x, y) { return x === cx || y === -3 ? tone(P.metal, 1.18) : tone(P.metal, 1.05); }, MAT.SHINY);
            m.paint(cx, -6, 14, 4, 4, 1, P.metalDk);                                                   // the telescoping seam
        });
        m.box(-24, -5, 22, 48, 2, 3, P.metalDk, MAT.SHINY);
        deskTop(m, [-32, -18, 64, 28], 26, 4, P.top, P.face, { grain: P.id === 'wood' || P.id === 'walnut' ? 20 : 0 });
        // height keypad under the front edge
        m.box(18, 6, 23, 6, 4, 3, '#263238');
        m.paint(19, 9, 24, 2, 1, 1, '#76ff03', MAT.EMIT); m.paint(22, 9, 24, 1, 1, 1, '#90a4ae');
        // phone face up, sticky notes
        m.rbox(-27, -13, 30, 6, 9, 1, 1, '#212121'); m.box(-26, -12, 30, 4, 7, 1, '#37474f');
        m.box(-26, 1, 30, 7, 7, 1, '#fff176'); m.paint(-26, 7, 30, 7, 1, 1, '#fbc02d');
        // the screen on a clamp arm at eye height
        var sc = { plan: [-16, -12, 32, 2], z: 42, h: 21 };
        armMount(m, [-2, -18, 4, 3], 30, 54, [sc]);
        mon(m, sc, { mount: 'none', bc: '#222b30' });
        keyboard(m, -14, 2, 28, 7, 30);
        mouse(m, 19, 3, 30, 4, 6);
        return m;
    });

    // ---- Treadmill Desk: a walking pad under a standing top, the screen on an arm, a bottle ----
    reg('desk', 'treadmill', ['black-green', 'white', 'grey-orange', 'black', 'wood', 'white-blue'], function (P) {
        var m = S.model(-33, -19, 33, 31, 64);
        var A = P.accent;
        [[-32, -30], [25, 26]].forEach(function (s) {
            var fx = s[0], cx = s[1];
            m.rbox(fx, -16, 0, 7, 16, 2, 1, P.metalDk, MAT.SHINY);
            m.box(cx, -14, 2, 4, 4, 11, function (x, y) { return x === cx || y === -11 ? tone(P.metal, 1.1) : P.metal; }, MAT.SHINY);
            m.box(cx, -14, 13, 4, 4, 11, function (x, y) { return x === cx || y === -11 ? tone(P.metal, 1.18) : tone(P.metal, 1.05); }, MAT.SHINY);
            m.paint(cx, -14, 12, 4, 4, 1, P.metalDk);
        });
        m.box(-24, -13, 20, 48, 2, 3, P.metalDk, MAT.SHINY);
        deskTop(m, [-32, -18, 64, 32], 24, 4, P.top, P.face, { speckle: 0.03 });
        // the walking pad: deck, belt with tread lines, lit side rails, a read-out at the front
        m.rbox(-14, -6, 0, 28, 36, 3, 1, '#3a3f45');
        m.box(-11, -5, 2, 22, 33, 1, function (x, y) { return (y + 5) % 3 === 0 ? '#2c3035' : '#1b1d20'; }, MAT.SOFT);
        m.paint(-13, -5, 2, 2, 33, 1, A, MAT.EMIT); m.paint(11, -5, 2, 2, 33, 1, A, MAT.EMIT);
        m.box(-5, 28, 3, 10, 2, 1, '#263238'); m.paint(-3, 29, 3, 6, 1, 1, A, MAT.EMIT);
        m.paint(-14, 29, 0, 28, 1, 2, '#2a2e33');
        // step counter on the top, a water bottle
        m.box(-30, 2, 28, 9, 6, 1, '#263238');
        m.paint(-29, 3, 28, 5, 1, 1, '#76ff03', MAT.EMIT); m.paint(-29, 5, 28, 2, 1, 1, '#76ff03', MAT.EMIT);
        m.cyl(27, -12, 28, 2, 2, 9, function (x, y, z) { return z < 31 ? '#0288d1' : '#29b6f6'; });
        m.cyl(27, -12, 37, 1.6, 1.6, 2, '#eceff1');
        m.paint(26, -11, 31, 1, 1, 5, '#b3e5fc');
        // the screen on a clamp arm
        var sc = { plan: [-16, -12, 32, 2], z: 42, h: 20 };
        armMount(m, [-2, -18, 4, 3], 28, 53, [sc]);
        mon(m, sc, { mount: 'none', bc: '#1e272c' });
        keyboard(m, -14, 3, 28, 7, 28);
        mouse(m, 17, 4, 28, 4, 6);
        return m;
    });

    // ---- Counter Desk: a bar-height counter on a cabinet, shelves of books behind, a brass foot rail ----
    reg('desk', 'counter', ['walnut-brass', 'white', 'black-gold', 'wood', 'grey', 'black'], function (P) {
        var m = S.model(-35, -19, 35, 21, 66);
        var A = P.accent;
        // the cabinet: doors with long pulls (front), open shelves with books (back), a dark kick plate
        m.box(-32, -18, 0, 64, 16, 25, function (x, y, z) {
            if (z < 3) return '#1c1f22';
            if (y === -3 && (x === 0 || x === -30 || x === 29)) return P.seam;
            if (y === -3) return P.face;
            return P.body;
        });
        m.box(-5, -2, 8, 2, 1, 11, A, MAT.SHINY); m.box(3, -2, 8, 2, 1, 11, A, MAT.SHINY);
        m.paint(-30, -3, 22, 60, 1, 1, tone(P.face, 1.12));
        [4, 14].forEach(function (sz, s) {
            m.carve(-30, -18, sz, 60, 4, 9);
            m.box(-30, -15, sz, 60, 1, 9, P.faceDk);
            m.box(-30, -18, sz - 1, 60, 4, 1, A, MAT.SHINY);                                             // the shelf's brass lip
            for (var x = -29, k = s * 3; x < 28; x += 3, k++) {
                if (k % 5 === 4) continue;
                var bh = 8 - (k % 3 === 1 ? 1 : 0) - (k % 4 === 2 ? 1 : 0);
                m.box(x, -17, sz, 2, 2, bh, BOOKS[k % BOOKS.length]);
                m.paint(x, -17, sz + bh - 1, 2, 1, 1, tone(BOOKS[k % BOOKS.length], 1.25));
            }
        });
        // the thick top, overhanging the front (knee room)
        deskTop(m, [-34, -18, 68, 38], 25, 5, P.top, P.faceDk, { grain: 10, board: 5, side: tone(P.top, 0.9) });
        m.paint(-34, 19, 25, 68, 1, 1, P.faceDk);
        // the brass foot rail on two brackets
        m.box(-30, -1, 3, 60, 2, 3, function (x, y, z) { return z === 5 ? tone(A, 1.2) : A; }, MAT.SHINY);
        [-26, 24].forEach(function (bx) { m.box(bx, -2, 0, 2, 2, 4, tone(A, 0.75), MAT.SHINY); });
        // a herb pot, a cork coaster
        plant(m, -32, -16, 6, 6, 30, 5, '#9e9e9e', '#558b2f', '#7cb342', 7);
        m.box(-30, -2, 30, 7, 7, 1, '#6d4c41'); m.paint(-29, -1, 30, 5, 5, 1, '#8d6e63');
        // the screen and a laptop
        mon(m, { plan: [-26, -12, 32, 2], z: 42, h: 20, foot: [-14, -15, 8, 5] }, { bc: '#1e272c', stand: '#b0bec5', footZ: 30 });
        m.rbox(9, -7, 30, 19, 7, 1, 1, '#b0bec5', MAT.SHINY);
        m.box(11, -7, 31, 15, 3, 1, function (x, y) { return (x + y) % 2 ? '#78909c' : '#90a4ae'; });
        m.box(15, -3, 31, 6, 2, 1, '#cfd8dc');
        m.box(9, -10, 30, 19, 3, 15, function (x, y, z) { return y < -8 ? (z === 44 ? '#90a4ae' : '#78909c') : (z === 44 ? '#546e7a' : '#37474f'); });
        m.box(10, -8, 32, 17, 1, 11, '#2c4a63', MAT.SCREEN);
        m.paint(17, -10, 36, 3, 1, 3, '#eceff1');
        keyboard(m, -14, 10, 28, 7, 30);
        mouse(m, 17, 11, 30, 4, 6);
        return m;
    });

    // =====================================================================================
    // Executive desk variants (top [.., -6, .., 40] z16 h5: the front edge at y 33, keys at y 22-30)
    // =====================================================================================
    // Move the voxels of columns x0 <= x < x1 (rows y0 <= y < y1, z0 <= z < z1) dy rows toward +y
    // (a curved or angled screen).
    function shiftY(m, x0, x1, y0, y1, z0, z1, dy) {
        for (var z = z0; z < z1; z++) for (var x = x0; x < x1; x++) {
            var col = [];
            for (var y = y0; y < y1; y++) { col.push(m.get(x, y, z)); m.set(x, y, z, null); }
            for (var k = 0; k < col.length; k++) if (col[k]) { var i = m.idx(x, y0 + k + dy, z); if (i >= 0) m.v[i] = col[k]; }
        }
    }
    // A boss-desk back panel (rows y -6 .. -4), the visitor face in frame-and-panel.
    function bossBack(m, P, x0, w, n, c) {
        c = c || P.faceDk;
        m.box(x0 + 1, -6, 0, w - 2, 3, 16, function (x, y, z) { return z === 0 ? P.seam : z === 15 ? tone(c, 1.1) : c; });
        var pw = Math.floor((w - 8 - (n - 1) * 3) / n);
        for (var i = 0; i < n; i++) {
            var px = x0 + 4 + i * (pw + 3);
            m.carve(px, -6, 3, pw, 1, 10);
            m.paint(px, -5, 3, pw, 1, 10, grainV(tone(c, 1.06)));
            m.paint(px, -6, 2, pw, 1, 1, tone(c, 1.12));
        }
    }
    // Two classic boss pedestals at px (w wide, plan y 0..33), two drawers each, handles.
    function bossPed(m, P, px, w, o) {
        o = o || {};
        m.box(px, -3, 0, w, 36, 16, function (x, y, z) { return z === 15 ? tone(P.body, 1.05) : P.body; });
        m.box(px + 2, 32, 0, w - 4, 1, 2, P.leg);
        if (o.drawers !== false) {
            m.box(px + 2, 33, 9, w - 4, 1, 6, grainV(P.face)); m.box(px + 2, 33, 2, w - 4, 1, 6, grainV(P.face));
            m.paint(px + 2, 33, 14, w - 4, 1, 1, tone(P.face, 1.1)); m.paint(px + 2, 33, 7, w - 4, 1, 1, tone(P.face, 1.1));
        }
        var ex = px < 0 ? px : px + w - 1;                                                          // the end face's inset panel
        m.paint(ex, 1, 3, 1, 29, 1, tone(P.body, 0.9)); m.paint(ex, 1, 13, 1, 29, 1, tone(P.body, 0.9));
        m.paint(ex, 1, 3, 1, 1, 11, tone(P.body, 0.9)); m.paint(ex, 29, 3, 1, 1, 11, tone(P.body, 0.9));
    }
    // A raised panel facing +y: its frame in row y (darker), the panel 1 px proud in row y + 1 with a
    // lighter top and left edge.
    function raisedPanel(m, x, y, z, w, h, c) {
        m.box(x, y, z, w, 1, h, tone(c, 0.82));
        m.box(x + 1, y + 1, z + 1, w - 2, 1, h - 2, c);
        m.paint(x + 1, y + 1, z + h - 2, w - 2, 1, 1, tone(c, 1.16));
        m.paint(x + 1, y + 1, z + 1, 1, 1, h - 2, tone(c, 1.1));
    }
    // A knee-hole modesty panel (mid depth) between the pedestals.
    function kneePanel(m, P, x0, x1, y, c) {
        m.box(x0, y, 2, x1 - x0, 2, 14, function (x, yy, z) { return z === 2 ? P.seam : c || P.faceDk; });
    }
    // Boss-desk top inlay border (3 px in) on the top layer.
    function inlay(m, plan, z, c, inset) {
        var i = inset || 3, x0 = plan[0] + i, y0 = plan[1] + i, x1 = plan[0] + plan[2] - i - 1, y1 = plan[1] + plan[3] - i - 1;
        m.paint(x0, y0, z, x1 - x0 + 1, 1, 1, c); m.paint(x0, y1, z, x1 - x0 + 1, 1, 1, c);
        m.paint(x0, y0, z, 1, y1 - y0 + 1, 1, c); m.paint(x1, y0, z, 1, y1 - y0 + 1, 1, c);
    }
    var BKEYS = { caseC: '#232e34', key: '#546e7a', key2: '#455a64', gap: '#2b373e', hi: '#6c8591' };

    // ---- Command Center: a 2.9 m top, three screens, a lit trim line, a desk lamp, a tablet ----
    reg('bossDesk', 'command', ['black-gold', 'walnut', 'wood', 'black', 'white', 'grey', 'black-cyan'], function (P) {
        var m = S.model(-59, -7, 59, 36, 52);
        var A = P.accent;
        bossBack(m, P, -58, 116, 4);
        [-58, 32].forEach(function (px) {
            bossPed(m, P, px, 26);
            m.box(px + 7, 34, 11, 12, 1, 1, A, MAT.EMIT); m.box(px + 7, 34, 4, 12, 1, 1, A, MAT.EMIT);   // lit handles
        });
        kneePanel(m, P, -32, 32, 12);
        m.paint(-30, 13, 14, 60, 1, 1, P.face); m.paint(-11, 13, 3, 1, 1, 11, P.face); m.paint(10, 13, 3, 1, 1, 11, P.face);
        deskTop(m, [-58, -6, 116, 40], 16, 5, P.topB, P.faceDk, { grain: 18 });
        inlay(m, [-58, -6, 116, 40], 20, P.inlay);
        m.paint(-57, 33, 17, 114, 1, 1, mix(P.faceDk, A, 0.7), MAT.EMIT);                           // the lit trim line
        // tablet, name plate, desk lamp
        m.rbox(-50, 14, 21, 16, 12, 1, 1, '#212121');
        m.box(-49, 15, 21, 14, 10, 1, '#4fc3f7', MAT.EMIT);
        m.paint(-48, 16, 21, 8, 1, 1, '#b3e5fc', MAT.EMIT); m.paint(-48, 18, 21, 5, 1, 1, '#b3e5fc', MAT.EMIT);
        m.box(24, 25, 21, 14, 4, 3, function (x, y, z) { return y === 28 ? A : P.faceDk; }, MAT.SHINY);
        m.rbox(45, 4, 21, 8, 6, 2, 1, '#37474f', MAT.SHINY);
        m.box(48, 6, 23, 2, 2, 14, '#455a64', MAT.SHINY);
        m.cone(49, 7, 37, 4.6, 2.6, 4, A, MAT.SHINY);
        m.cyl(49, 7, 37, 3.2, 3.2, 1, '#fff59d', MAT.EMIT);
        // three screens
        var o = { bc: '#1a1a2e', stand: '#455a64' };
        mon(m, { plan: [-54, -1, 34, 2], z: 24, h: 22, foot: [-43, -3, 12, 5] }, o);
        mon(m, { plan: [-18, -2, 36, 2], z: 24, h: 25, foot: [-6, -4, 12, 5] }, o);
        mon(m, { plan: [20, -1, 34, 2], z: 24, h: 22, foot: [31, -3, 12, 5] }, o);
        keyboard(m, -14, 22, 28, 8, 21, BKEYS);
        mouse(m, 17, 23, 21, 5, 7, '#37474f');
        return m;
    });

    // ---- Executive: raised-panel pedestals, a tooled leather pad, a globe, a decanter, one big screen ----
    reg('bossDesk', 'executive', ['walnut', 'wood', 'walnut-brass', 'black-gold', 'black', 'white'], function (P) {
        var m = S.model(-53, -7, 53, 36, 52);
        var A = P.accent, leather = P.id === 'white' ? '#1f3554' : '#5a1e1e';
        // the finished back: three raised panels on the visitor face
        m.box(-51, -6, 0, 102, 3, 16, function (x, y, z) { return z === 0 ? P.seam : z === 15 ? tone(P.faceDk, 1.1) : P.faceDk; });
        [0, 1, 2].forEach(function (i) {
            var px = -48 + i * 33;
            m.paint(px, -6, 3, 30, 1, 10, tone(P.faceDk, 0.82));
            m.box(px + 1, -7, 4, 28, 1, 8, P.faceDk);
            m.paint(px + 1, -7, 11, 28, 1, 1, tone(P.faceDk, 1.16));
        });
        // pedestals: a drawer, a door with a raised panel, a knob, a plinth
        [-52, 24].forEach(function (px) {
            m.box(px, -3, 0, 28, 36, 16, function (x, y, z) { return z === 15 ? tone(P.body, 1.05) : P.body; });
            m.box(px, 32, 0, 28, 2, 2, P.faceDk); m.paint(px, 33, 1, 28, 1, 1, tone(P.faceDk, 1.2));
            m.box(px + 1, 33, 2, 26, 1, 14, tone(P.face, 0.8));
            raisedPanel(m, px + 2, 33, 10, 24, 5, P.face);
            m.box(px + 11, 35, 12, 6, 1, 1, P.pull, MAT.SHINY);
            raisedPanel(m, px + 2, 33, 2, 24, 8, P.face);
            m.paint(px + 5, 34, 4, 18, 1, 1, tone(P.face, 0.85)); m.paint(px + 5, 34, 7, 18, 1, 1, tone(P.face, 0.85));
            m.paint(px + 5, 34, 4, 1, 1, 4, tone(P.face, 0.85)); m.paint(px + 22, 34, 4, 1, 1, 4, tone(P.face, 0.85));
            m.box(px + (px < 0 ? 21 : 5), 35, 5, 2, 1, 2, P.pull, MAT.SHINY);
            var ex = px < 0 ? px : px + 27;                                                           // the end: a raised panel
            m.paint(ex, 1, 3, 1, 29, 11, tone(P.face, 0.85));
            m.paint(ex, 2, 4, 1, 27, 9, P.face); m.paint(ex, 2, 12, 1, 27, 1, tone(P.face, 1.15));
        });
        kneePanel(m, P, -24, 24, 12);
        m.paint(-20, 13, 4, 18, 1, 9, P.face); m.paint(2, 13, 4, 18, 1, 9, P.face);
        // top with a moulded edge
        deskTop(m, [-52, -6, 104, 40], 16, 5, P.topB, P.faceDk, { grain: 16 });
        m.paint(-52, 33, 19, 104, 1, 1, tone(P.faceDk, 1.25)); m.paint(-51, 33, 16, 102, 1, 1, tone(P.faceDk, 0.8));
        // the tooled leather writing pad
        m.box(-30, 6, 21, 60, 27, 1, function (x, y) {
            if (x === -30 || x === 29 || y === 6 || y === 32) return tone(leather, 0.7);
            if (((x === -28 || x === 27) && y >= 8 && y <= 30) || ((y === 8 || y === 30) && x >= -28 && x <= 27)) return A;
            return C.hash(x, y, 9) > 0.85 ? tone(leather, 1.06) : leather;
        });
        // the antique globe: a turned base, a parchment sphere with sepia lands, a brass meridian
        m.cyl(-41, 3.5, 21, 5, 3, 2, P.faceDk);
        m.box(-42, 3, 23, 2, 2, 3, P.leg);
        m.ellipsoid(-41, 3.5, 31, 6, 6, 6, function (x, y, z) {
            var n = C.hash(Math.floor((x + 50) / 3), Math.floor((y + 10) / 3), Math.floor(z / 3));
            return n > 0.58 ? '#8a6538' : z > 35 && n < 0.15 ? '#f0e2b8' : '#cdb27a';
        });
        ringXZ(m, -41, 31, 3, 2, 7.2, 8.4, BRASS, MAT.SHINY);
        m.box(-42, 3, 39, 2, 2, 1, BRASS_HI, MAT.SHINY);
        // decanter + two tumblers on a silver tray
        m.rbox(31, -1, 21, 17, 6, 1, 1, '#b0b9be', MAT.SHINY);
        m.paint(31, 4, 21, 17, 1, 1, '#cfd6da', MAT.SHINY);
        m.cyl(39, 2, 22, 3.6, 3, 9, function (x, y, z) { return z < 27 ? (z === 26 ? '#d48a3c' : '#b5651d') : '#dfeef3'; }, MAT.SHINY);
        m.cyl(39, 2, 31, 1.6, 1.4, 3, '#dfeef3', MAT.SHINY);
        m.ellipsoid(39, 2, 35, 1.8, 1.6, 1.4, '#e8f4f8', MAT.SHINY);
        m.paint(36, 3, 28, 1, 1, 3, '#ffffff');
        [[45, 2], [33, 2.5]].forEach(function (t) { m.cyl(t[0], t[1], 22, 2, 2, 4, function (x, y, z) { return z < 24 ? '#b5651d' : '#dfeef3'; }, MAT.SHINY); });
        // a marble pen stand with two fountain pens
        m.rbox(31, 11, 21, 10, 4, 2, 1, '#2e3133', MAT.SHINY);
        m.paint(31, 11, 22, 10, 4, 1, '#4b5054');
        m.box(33, 12, 23, 2, 2, 6, '#111'); m.box(33, 12, 29, 2, 2, 1, BRASS, MAT.SHINY);
        m.box(37, 12, 23, 2, 2, 5, '#111'); m.box(37, 12, 28, 2, 2, 1, BRASS, MAT.SHINY);
        // brass name plate facing the visitors
        m.box(-28, -5, 21, 18, 3, 3, function (x, y, z) { return y === -5 ? tone(A, 0.8) : tone(A, 1.1); }, MAT.SHINY);
        m.paint(-25, -5, 22, 12, 1, 1, tone(A, 0.55));
        // one big screen
        mon(m, { plan: [-21, 0, 42, 2], z: 24, h: 25, foot: [-6, -2, 12, 5] }, { bc: '#1c1f24', stand: '#2b2e33' });
        keyboard(m, -14, 22, 28, 8, 22, BKEYS);
        mouse(m, 17, 23, 22, 5, 7, '#37474f');
        return m;
    });

    // ---- CEO Glass: a smoked glass top on chrome sled legs, a curved ultrawide, an orchid, a sculpture ----
    reg('bossDesk', 'glass', ['white', 'black', 'grey', 'white-blue', 'black-gold', 'walnut'], function (P) {
        var m = S.model(-51, -7, 51, 36, 50);
        var A = P.accent, CH = dark(P.body) ? '#9aa5ab' : '#d5dde1', CH_DK = tone(CH, 0.8);
        // chrome sled frames, the back stretcher
        [-48, 45].forEach(function (sx) {
            m.box(sx, -4, 0, 3, 35, 2, CH_DK, MAT.SHINY);
            m.box(sx, -4, 16, 3, 35, 2, CH, MAT.SHINY);
            m.box(sx, -4, 2, 3, 3, 14, CH, MAT.SHINY);
            m.box(sx, 28, 2, 3, 3, 14, CH, MAT.SHINY);
            m.paint(sx + (sx < 0 ? 0 : 2), -4, 2, 1, 35, 16, tone(CH, 1.12), MAT.SHINY);
        });
        m.box(-45, -3, 14, 90, 2, 2, CH_DK, MAT.SHINY);
        // the mobile pedestal under the glass: three drawers, casters
        pedestal(m, P, 22, 4, 20, 26, 13, 3, { z0: 2, body: P.body, front: P.face });
        [[23, 5], [39, 5], [23, 27], [39, 27]].forEach(function (c) { m.box(c[0], c[1], 0, 2, 2, 2, '#222'); });
        // the glass: a smoked top face, a bright edge, an LED line in the front edge, two glints
        var G = '#96c4d2', G_DK = '#6aa0b0', EDGE = '#e8fbff';
        m.box(-50, -6, 18, 100, 40, 3, function (x, y, z) {
            var edge = x === -50 || x === 49 || y === -6 || y === 33;
            if (z === 20) {
                if (edge) return EDGE;
                var d = (x + 50) - (y + 6);
                if ((d >= 6 && d < 9) || (d >= 14 && d < 16)) return '#c4e6ee';
                return G;
            }
            return edge ? G_DK : G;
        }, MAT.SHINY);
        m.paint(-48, 33, 18, 96, 1, 1, A, MAT.EMIT);
        // orchid in a white pot: two broad leaves, an arching stem, white flowers
        m.rbox(-44, 2, 21, 8, 6, 6, 1, '#e9edf0');
        m.paint(-44, 2, 26, 8, 6, 1, '#ffffff'); m.paint(-43, 3, 26, 6, 4, 1, '#6d4c41');
        m.ellipsoid(-43, 5, 28, 3.4, 1.6, 1, '#3f7a3a', MAT.SOFT); m.ellipsoid(-37.5, 4.5, 28, 3.2, 1.6, 1, '#4f9447', MAT.SOFT);
        m.box(-41, 4, 27, 2, 2, 12, '#5b7f3a');
        m.box(-40, 4, 38, 4, 2, 2, '#5b7f3a');
        [[-36, 39], [-35, 35], [-43, 37], [-34, 31]].forEach(function (f) {
            m.box(f[0] - 1, 4, f[1] - 1, 3, 2, 3, '#fdfdfd', MAT.SOFT); m.paint(f[0], 5, f[1], 1, 1, 1, '#d81b60');
        });
        // chrome sphere on a black cube
        m.box(36, 2, 21, 6, 5, 4, function (x, y, z) { return z === 24 ? '#3a3f44' : '#1d2023'; });
        m.ellipsoid(39, 4.5, 29, 4, 4, 4, function (x, y, z) { return z > 30 && x < 39 ? '#e6ecef' : z < 27 ? '#5f6a70' : '#9aa5ab'; }, MAT.SHINY);
        // phone, face down
        m.rbox(-30, -2, 21, 6, 9, 1, 1, '#15171a'); m.paint(-29, -1, 21, 4, 1, 1, '#3a3f44');
        // the curved ultrawide: its ends bent toward the sitter
        mon(m, { plan: [-28, 1, 56, 2], z: 24, h: 21, foot: [-7, -2, 14, 5] }, { bc: '#16181b', stand: '#c9d1d5' });
        shiftY(m, -28, -21, -5, 4, 24, 45, 1); shiftY(m, 21, 28, -5, 4, 24, 45, 1);
        shiftY(m, -28, -25, -5, 5, 24, 45, 1); shiftY(m, 25, 28, -5, 5, 24, 45, 1);
        keyboard(m, -14, 22, 28, 8, 21, { caseC: '#cfd8dc', key: '#eceff1', key2: '#e0e5e8', gap: '#b0bec5', hi: '#ffffff' });
        mouse(m, 17, 23, 21, 5, 7, '#eceff1');
        return m;
    });

    // ---- Studio Producer: a 14-channel mixing desk with a meter bridge, studio monitors, rack gear ----
    reg('bossDesk', 'producer', ['black', 'black-red', 'walnut', 'black-cyan', 'grey-orange', 'white'], function (P) {
        var m = S.model(-61, -10, 61, 37, 58);
        var A = P.accent, PANEL = '#24272c', FADERS = [5, 2, 7, 3, 6, 1, 4, 6, 2, 5, 3, 7, 4, 2];
        bossBack(m, P, -60, 120, 4);
        // rack bays: three rack units each (screws, knobs, LEDs)
        [-60, 36].forEach(function (px) {
            m.box(px, -3, 0, 24, 36, 16, function (x, y, z) { return z === 15 ? tone(P.body, 1.05) : P.body; });
            m.box(px + 1, 33, 0, 22, 1, 16, P.metalDk);
            [11, 6, 1].forEach(function (uz, j) {
                m.box(px + 2, 33, uz, 20, 2, 4, function (x, y, z) { return z === uz + 3 ? '#33373d' : '#1c1e22'; });
                m.paint(px + 2, 34, uz + 1, 1, 1, 2, P.metal, MAT.SHINY); m.paint(px + 21, 34, uz + 1, 1, 1, 2, P.metal, MAT.SHINY);
                for (var k = 0; k < 3; k++) m.box(px + 5 + k * 4 + j, 35, uz + 1, 2, 1, 2, '#9ea4aa', MAT.SHINY);
                m.paint(px + 18, 34, uz + 2, 1, 1, 1, j === 1 ? A : j ? '#ff5252' : '#76ff03', MAT.EMIT);
            });
            var ex = px < 0 ? px : px + 23;
            m.paint(ex, 2, 4, 1, 28, 8, tone(P.body, 0.9)); m.paint(ex, 3, 8, 1, 26, 2, '#1c1e22');
        });
        kneePanel(m, P, -36, 36, 12);
        deskTop(m, [-60, -6, 120, 40], 16, 5, P.topB, P.faceDk, { speckle: 0.025 });
        // the patch bay in the apron front, a few patch cables hanging at its ends
        m.paint(-36, 33, 16, 72, 1, 3, '#15171a');
        for (var px2 = -34; px2 < 35; px2 += 3) { m.paint(px2, 33, 17, 1, 1, 1, '#45494f'); m.paint(px2 + 1, 33, 18, 1, 1, 1, '#45494f'); }
        [[-33, '#e53935', 4], [-27, '#1e88e5', 6], [26, '#fdd835', 5], [31, '#43a047', 3]].forEach(function (c) { m.box(c[0], 33, 16 - c[2], 2, 1, c[2], c[1]); });
        // the mixing desk: channel strips (knobs, fader slots + caps, LEDs), wood cheeks, a master section
        m.box(-36, 1, 21, 72, 21, 3, function (x, y, z) {
            if (x <= -35 || x >= 34) return P.body;
            if (y === 21) return '#1a1c20';
            return PANEL;
        });
        m.paint(-36, 1, 23, 2, 21, 1, tone(P.body, 1.1)); m.paint(34, 1, 23, 2, 21, 1, tone(P.body, 1.1));
        for (var i = 0; i < 14; i++) {
            var x = -33 + i * 4;
            m.paint(x + 1, 3, 23, 1, 1, 1, '#e53935'); m.paint(x + 1, 5, 23, 1, 1, 1, '#fdd835');
            m.paint(x + 1, 7, 23, 1, 1, 1, '#43a047'); m.paint(x + 1, 9, 23, 1, 1, 1, '#1e88e5');
            m.paint(x + 1, 11, 23, 1, 9, 1, '#0e0f11');
            m.box(x, 11 + FADERS[i], 24, 3, 2, 1, '#d7dde1', MAT.SHINY);
            m.paint(x + 1, 20, 23, 1, 1, 1, i % 3 ? '#2e7d32' : '#76ff03', MAT.EMIT);
        }
        m.paint(24, 3, 23, 10, 7, 1, '#0e0f11'); m.paint(25, 4, 23, 3, 5, 1, A, MAT.EMIT); m.paint(30, 5, 23, 3, 4, 1, A, MAT.EMIT);
        m.paint(28, 11, 23, 1, 9, 1, '#0e0f11'); m.box(27, 14, 24, 3, 2, 1, '#ff1744', MAT.SHINY);
        // the meter bridge: a row of LED meters toward the sitter
        m.box(-36, -3, 21, 72, 4, 9, function (x, y, z) { return z === 29 ? '#2b2e33' : y === 0 ? '#16181b' : '#202328'; });
        for (var b = 0; b < 16; b++) {
            var mx = -34 + b * 4 + (b > 13 ? 4 : 0), lv = 2 + (FADERS[b % 14] % 5);
            if (mx > 32) continue;
            m.paint(mx, 0, 22, 3, 1, 7, '#0b0c0e');
            for (var l = 0; l < lv; l++) m.paint(mx, 0, 22 + l, 3, 1, 1, l >= 5 ? '#e53935' : l >= 4 ? '#fdd835' : '#43a047', MAT.EMIT);
        }
        // the studio monitors on isolation pads: a woofer with an accent surround, a tweeter
        [-58, 47].forEach(function (sx) {
            m.box(sx, -2, 21, 11, 9, 2, '#3a3d42', MAT.SOFT);
            m.rbox(sx, -2, 23, 11, 9, 17, 1, function (x, y, z) { return y === 6 ? '#212428' : '#1b1d20'; });
            var cx = sx + 5.5;
            for (var z = 24; z < 34; z++) for (var xx = sx + 1; xx < sx + 10; xx++) {
                var d = Math.hypot(xx + 0.5 - cx, z + 0.5 - 28.5);
                if (d <= 4.4) m.paint(xx, 6, z, 1, 1, 1, d > 3.3 ? A : d > 1.6 ? '#14161a' : '#2a2d32', d > 3.3 ? MAT.SHINY : MAT.SOLID);
            }
            for (var z2 = 34; z2 < 39; z2++) for (var x2 = sx + 3; x2 < sx + 9; x2++) {
                var d2 = Math.hypot(x2 + 0.5 - cx, z2 + 0.5 - 36.5);
                if (d2 <= 2) m.paint(x2, 6, z2, 1, 1, 1, d2 > 1 ? '#5c6166' : '#0c0d0f');
            }
        });
        // MIDI pad grid, the padded arm rest along the front
        m.box(-40, 22, 21, 13, 9, 1, '#1b1d20');
        var PADS = [A, '#7c4dff', '#00e5ff', A, '#ff9100', A, '#7c4dff', '#00e5ff', '#00e5ff', '#ff9100', A, '#7c4dff', A, '#00e5ff', '#ff9100', A];
        for (var p = 0; p < 16; p++) m.box(-39 + (p % 4) * 3, 23 + (p >> 2) * 2, 22, 2, 1, 1, PADS[p], MAT.EMIT);
        m.rbox(-60, 31, 21, 120, 3, 2, 1, '#1d1e20', MAT.SOFT);
        m.paint(-59, 33, 22, 118, 1, 1, '#3a3c40', MAT.SOFT);
        // headphones on a hook under the front edge (in front of the left rack bay)
        m.box(-53, 34, 14, 2, 2, 3, '#2b2e33');
        m.box(-56, 34, 14, 9, 2, 2, '#111');
        m.box(-57, 34, 8, 2, 2, 7, '#111'); m.box(-48, 34, 8, 2, 2, 7, '#111');
        m.box(-58, 34, 7, 3, 2, 4, '#202226'); m.box(-47, 34, 7, 3, 2, 4, '#202226');
        m.paint(-58, 35, 8, 1, 1, 2, A, MAT.EMIT); m.paint(-45, 35, 8, 1, 1, 2, A, MAT.EMIT);
        // the big screen behind the bridge
        var sc = { plan: [-25, -5, 50, 2], z: 31, h: 25 };
        m.rbox(-6, -6, 21, 12, 3, 1, 1, '#2b2e33', MAT.SHINY);
        m.box(-2, -6, 22, 4, 2, 21, '#3a3f45', MAT.SHINY);
        mon(m, sc, { mount: 'none', bc: '#121417' });
        keyboard(m, -14, 22, 28, 8, 21, { caseC: '#16181b', key: '#33373d', key2: '#2a2d32', gap: '#101215', hi: '#45494f' });
        mouse(m, 17, 23, 21, 5, 7, '#26292e');
        return m;
    });

    // ---- Architect's Studio: a tilted drafting board with a blueprint, a plan chest, a steel trestle,
    //      an articulated lamp, a scale model, blueprint rolls, a big screen ----
    reg('bossDesk', 'architect', ['white', 'wood', 'grey', 'black', 'white-blue', 'grey-orange'], function (P) {
        var m = S.model(-57, -7, 57, 36, 56);
        var A = P.accent, STEEL = dark(P.body) ? '#5d656d' : P.metal, STEEL_DK = tone(STEEL, 0.78);
        // the flat-file plan chest: five shallow drawers with labels and long pulls
        m.box(-56, -3, 0, 34, 36, 16, function (x, y, z) { return z === 15 ? tone(P.body, 1.05) : P.body; });
        m.box(-55, 33, 1, 32, 1, 15, P.face);
        for (var i = 0; i < 5; i++) {
            var dz = 1 + i * 3;
            m.paint(-55, 33, dz, 32, 1, 1, P.seam);
            m.box(-44, 34, dz + 1, 10, 1, 1, P.pull, MAT.SHINY);
            m.paint(-53, 33, dz + 1, 4, 1, 1, '#fafafa');
        }
        // the steel trestle: two posts, a foot, two braces; the back stretcher
        m.box(50, -4, 0, 4, 35, 2, STEEL_DK, MAT.SHINY);
        m.box(50, -4, 2, 4, 3, 14, STEEL, MAT.SHINY); m.box(50, 28, 2, 4, 3, 14, STEEL, MAT.SHINY);
        rod(m, [52, 0, 2], [52, 13, 14], STEEL, MAT.SHINY); rod(m, [52, 27, 2], [52, 15, 14], STEEL, MAT.SHINY);
        m.box(-22, -3, 12, 74, 2, 2, STEEL_DK, MAT.SHINY);
        deskTop(m, [-56, -6, 112, 40], 16, 5, P.top, P.face, { speckle: 0.02 });
        m.paint(-56, 33, 17, 112, 1, 1, tone(P.face, 0.85));
        // the drafting board: a wedge rising to the back on a steel riser, the blueprint, a T-square, a pencil
        var BOARD = '#e6ece8', BOARD_SIDE = '#b9c2bd', zt = function (y) { return 30 - Math.round((y + 2) * 7 / 22); };
        m.box(-54, -2, 21, 40, 4, 8, STEEL_DK, MAT.SHINY);
        for (var y = -2; y < 21; y++) {
            m.box(-54, y, 21, 40, 1, zt(y) - 21, function (x, yy, z) {
                if (z === zt(yy) - 1) return x === -54 || x === -15 || yy === 20 ? '#f4f8f5' : BOARD;
                return x === -54 || x === -15 ? STEEL_DK : BOARD_SIDE;
            });
        }
        for (var by = 0; by < 18; by++) for (var bx = -51; bx < -18; bx++) {
            var zz = zt(by) - 1, c = '#1e5aa8';
            if ((bx + 51) % 4 === 3 || by % 4 === 3) c = '#3a72bd';
            var ix = bx + 46, iy = by - 3;                                                           // a floor plan in white lines
            if ((iy === 0 || iy === 10) && ix >= 0 && ix <= 22 || (ix === 0 || ix === 22) && iy >= 0 && iy <= 10 || ix === 11 && iy >= 0 && iy <= 5 || iy === 5 && ix >= 0 && ix <= 11) c = '#e3f2fd';
            if (iy === 8 && ix >= 3 && ix <= 5) c = '#ffeb3b';
            m.paint(bx, by, zz, 1, 1, 1, c);
        }
        for (var ty = -1; ty < 21; ty++) m.box(-53, ty, zt(ty), 3, 1, 1, ty === -1 ? '#a07a42' : '#c8a165');   // T-square stock
        for (var tx = -50; tx < -22; tx++) m.box(tx, 13, zt(13), 1, 2, 1, '#d7b47c');                   // its blade
        m.box(-34, 9, zt(9), 8, 1, 1, '#ff7043'); m.box(-26, 9, zt(9), 1, 1, 1, '#ffe0b2');           // a pencil
        // the articulated lamp clamped to the board's back corner
        m.box(-53, -3, 27, 4, 3, 3, STEEL_DK, MAT.SHINY);
        rod(m, [-51, -2, 30], [-48, 2, 40], STEEL, MAT.SHINY);
        rod(m, [-48, 2, 40], [-41, 8, 37], STEEL, MAT.SHINY);
        m.cone(-40, 9, 31, 4, 2.2, 5, A, MAT.SHINY);
        m.cyl(-40, 9, 31, 2.8, 2.8, 1, '#fff59d', MAT.EMIT);
        // the white scale model on a base board
        m.box(24, 6, 21, 12, 6, 2, function (x, y, z) { return z === 22 ? '#e3d6b8' : '#c8b99a'; });
        m.box(26, 7, 23, 4, 4, 10, function (x, y, z) { return y === 10 && z % 3 === 0 && x > 26 && x < 29 ? '#90caf9' : x === 29 ? '#d9dcde' : '#f5f5f5'; });
        m.box(31, 8, 23, 4, 3, 5, function (x) { return x === 34 ? '#cfd8dc' : '#eceff1'; });
        m.ellipsoid(25, 10.5, 25, 1.4, 1.4, 1.8, '#66bb6a', MAT.SOFT);
        // blueprint rolls in a round bin
        m.cyl(46, 5, 21, 4.6, 4.6, 9, function (x, y, z) { return z === 29 ? tone(A, 1.2) : A; });
        m.cyl(46, 5, 29, 3.4, 3.4, 1, tone(A, 0.6));
        m.box(43, 3, 21, 2, 2, 16, '#ffffff'); m.box(46, 3, 21, 2, 2, 17, '#90caf9');
        m.box(47, 6, 21, 2, 2, 14, '#e3f2fd'); m.box(44, 6, 21, 2, 2, 13, '#1e5aa8');
        // the big screen
        mon(m, { plan: [2, -2, 48, 2], z: 24, h: 28, foot: [20, -4, 12, 5] }, { bc: '#20262b', stand: '#9aa5ab' });
        keyboard(m, -14, 22, 28, 8, 21, BKEYS);
        mouse(m, 17, 23, 21, 5, 7, '#37474f');
        return m;
    });

    // ---- Captain's Desk: brass-bound campaign drawers, a ship's wheel, a sea chart, a telescope, a ship in
    //      a bottle, a porthole clock, a compass, one screen ----
    // a ship's wheel standing on a face (plane x = fx, centre (cy, cz)): 8 spokes, a rim, a hub
    function wheelX(m, fx, cy, cz, r) {
        for (var k = 0; k < 8; k++) {
            var a = k * Math.PI / 4;
            for (var d = 1; d <= r + 2; d++) m.paint(fx, Math.round(cy + Math.cos(a) * d), Math.round(cz + Math.sin(a) * d), 1, 1, 1, d > r ? BRASS_HI : BRASS_DK, MAT.SHINY);
        }
        for (var z = Math.floor(cz - r - 1); z <= cz + r + 1; z++) for (var y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
            var dd = Math.hypot(y - cy, z - cz);
            if (dd <= r + 0.5 && dd > r - 0.7) m.paint(fx, y, z, 1, 1, 1, BRASS, MAT.SHINY);
            if (dd < 1.2) m.paint(fx, y, z, 1, 1, 1, BRASS_HI, MAT.SHINY);
        }
    }
    function wheelY(m, fy, cx, cz, r) {
        for (var k = 0; k < 8; k++) {
            var a = k * Math.PI / 4;
            for (var d = 1; d <= r + 2; d++) m.paint(Math.round(cx + Math.cos(a) * d), fy, Math.round(cz + Math.sin(a) * d), 1, 1, 1, d > r ? BRASS_HI : BRASS_DK, MAT.SHINY);
        }
        for (var z = Math.floor(cz - r - 1); z <= cz + r + 1; z++) for (var x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
            var dd = Math.hypot(x - cx, z - cz);
            if (dd <= r + 0.5 && dd > r - 0.7) m.paint(x, fy, z, 1, 1, 1, BRASS, MAT.SHINY);
            if (dd < 1.2) m.paint(x, fy, z, 1, 1, 1, BRASS_HI, MAT.SHINY);
        }
    }
    function brassCorners(m, x0, y, z0, w, h) {              // L brackets on the corners of a +y / -y face (row y)
        [[x0, z0], [x0 + w - 3, z0], [x0, z0 + h - 1], [x0 + w - 3, z0 + h - 1]].forEach(function (c) { m.paint(c[0], y, c[1], 3, 1, 1, BRASS, MAT.SHINY); });
        [[x0, z0], [x0 + w - 1, z0], [x0, z0 + h - 3], [x0 + w - 1, z0 + h - 3]].forEach(function (c) { m.paint(c[0], y, c[1], 1, 1, 3, BRASS, MAT.SHINY); });
    }
    reg('bossDesk', 'captain', ['walnut-brass', 'walnut', 'wood', 'black-gold', 'white-blue', 'grey'], function (P) {
        var m = S.model(-53, -7, 53, 36, 52);
        var A = P.accent;
        m.box(-51, -6, 0, 102, 3, 16, function (x, y, z) { return z === 0 ? P.seam : P.faceDk; });
        brassCorners(m, -51, -6, 0, 102, 16);
        m.paint(-49, -6, 15, 98, 1, 1, A, MAT.SHINY);
        [-52, 24].forEach(function (px) {
            m.box(px, -3, 0, 28, 36, 16, function (x, y, z) { return z === 15 ? tone(P.body, 1.05) : P.body; });
            m.box(px, 33, 0, 28, 1, 16, function (x, y, z) { return z === 8 ? P.seam : z === 0 ? P.faceDk : grainV(P.face)(x, y, z); });
            brassCorners(m, px, 33, 0, 28, 16);
            [11, 3].forEach(function (hz) {                                                           // flush brass handles
                m.box(px + 10, 34, hz, 8, 1, 2, BRASS_DK, MAT.SHINY); m.paint(px + 10, 34, hz + 1, 8, 1, 1, BRASS, MAT.SHINY);
            });
            var ex = px < 0 ? px : px + 27;
            m.paint(ex, -3, 0, 1, 36, 16, grainV(P.body));
            wheelX(m, ex, 15, 8, 4);
            [[-3, 0], [30, 0], [-3, 13], [30, 13]].forEach(function (c) { m.paint(ex, c[0], c[1], 1, 3, 3, BRASS, MAT.SHINY); });
        });
        // the knee panel: a rope border round a ship's wheel
        kneePanel(m, P, -24, 24, 12);
        for (var rx = -22; rx < 22; rx += 2) { m.paint(rx, 13, 14, 1, 1, 1, '#c8a96e'); m.paint(rx + 1, 13, 14, 1, 1, 1, '#8d6e3f'); m.paint(rx, 13, 3, 1, 1, 1, '#c8a96e'); m.paint(rx + 1, 13, 3, 1, 1, 1, '#8d6e3f'); }
        wheelY(m, 13, 0, 8.5, 3.5);
        // the top: brass corner caps, an inlay stripe, a brass lip
        deskTop(m, [-52, -6, 104, 40], 16, 5, P.topB, P.faceDk, { grain: 14 });
        inlay(m, [-52, -6, 104, 40], 20, mix(P.topB, A, 0.45), 5);
        [[-52, -6], [48, -6], [-52, 30], [48, 30]].forEach(function (c) {
            m.paint(c[0], c[1], 19, 4, 4, 2, BRASS, MAT.SHINY);
        });
        m.paint(-48, 33, 17, 96, 1, 1, BRASS_DK, MAT.SHINY);
        // the sea chart: sea, a coast, rhumb lines, a compass rose
        m.box(-46, 2, 21, 28, 18, 1, function (x, y) {
            if (x === -46 || x === -19 || y === 2 || y === 19) return '#b89f6a';
            var coast = -32 + Math.round(Math.sin(y * 0.7) * 2);
            if (x === coast) return '#a1866a';
            if (y === 10 || x === -39) return '#c9b48a';
            return x < coast ? '#9fc4d6' : '#e8d9b0';
        });
        m.paint(-24, 11, 21, 1, 7, 1, '#b71c1c'); m.paint(-27, 14, 21, 7, 1, 1, '#b71c1c'); m.paint(-25, 13, 21, 3, 3, 1, '#5d4037'); m.paint(-24, 14, 21, 1, 1, 1, '#b71c1c');
        // a brass compass
        m.cyl(30.5, 12.5, 21, 4.5, 4.5, 2, BRASS, MAT.SHINY);
        m.cyl(30.5, 12.5, 22, 3.3, 3.3, 1, '#f3ead2');
        m.paint(30, 10, 22, 1, 2, 1, '#b71c1c'); m.paint(30, 12, 22, 1, 2, 1, '#263238');
        // the telescope on a tripod
        rod(m, [37, 0, 21.5], [41, 2, 30], '#6d4c41'); rod(m, [45, 0, 21.5], [41, 2, 30], '#6d4c41'); rod(m, [41, 6, 21.5], [41, 2, 30], '#5d4037');
        m.line([34.5, 2, 30], [42, 2, 34.5], 1, BRASS_DK, MAT.SHINY);
        m.line([42, 2, 34.5], [48.5, 2, 38], 1.5, BRASS, MAT.SHINY);
        m.box(47, 1, 37, 3, 3, 3, BRASS_HI, MAT.SHINY);
        // the porthole clock on a stand
        m.box(23, -2, 21, 9, 3, 2, P.faceDk);
        m.box(26, -2, 23, 3, 2, 3, P.leg);
        ringXZ(m, 27.5, 32, -2, 2, 0, 6.2, BRASS, MAT.SHINY);
        for (var cz = 27; cz < 38; cz++) for (var cx = 22; cx < 34; cx++) if (Math.hypot(cx + 0.5 - 27.5, cz + 0.5 - 32) <= 4.3) m.paint(cx, -1, cz, 1, 1, 1, '#f3ead2');
        m.paint(27, -1, 32, 1, 1, 3, '#222'); m.paint(27, -1, 32, 3, 1, 1, '#222');
        m.paint(23, -1, 36, 2, 1, 1, BRASS_HI, MAT.SHINY);
        // the ship in a bottle on its cradle
        m.box(-45, -4, 21, 2, 5, 2, '#5d4037'); m.box(-36, -4, 21, 2, 5, 2, '#5d4037');
        for (var bx = -47; bx < -33; bx++) for (var bz = 22; bz < 31; bz++) for (var by = -5; by < 3; by++) {
            if (Math.hypot((by + 0.5 + 1) / 3.8, (bz + 0.5 - 26.5) / 4.2) <= 1) m.set(bx, by, bz, Math.hypot((by + 0.5 + 1) / 3.8, (bz + 0.5 - 26.5) / 4.2) > 0.78 || bz > 29 ? '#d6f2e6' : '#bfe3d3');
        }
        m.box(-33, -2, 25, 3, 2, 3, '#bfe3d3'); m.box(-30, -2, 25, 2, 2, 3, '#a1887f');
        [2, -5].forEach(function (fy) {                                                             // the ship, seen through the glass
            m.paint(-44, fy, 23, 8, 1, 2, '#7a4a2a'); m.paint(-43, fy, 23, 6, 1, 1, '#3e2723');
            m.paint(-41, fy, 25, 1, 1, 5, '#4e342e'); m.paint(-44, fy, 26, 3, 1, 3, '#fafafa'); m.paint(-40, fy, 26, 3, 1, 3, '#fafafa');
            m.paint(-41, fy, 29, 2, 1, 1, '#e53935');
        });
        mon(m, { plan: [-20, 0, 40, 2], z: 24, h: 24, foot: [-6, -2, 12, 5] }, { bc: '#1b1a17', stand: BRASS_DK });
        keyboard(m, -14, 22, 28, 8, 21, BKEYS);
        mouse(m, 17, 23, 21, 5, 7, '#4e342e');
        return m;
    });

    // ---- Zen Garden: a thick slab with waterfall ends and a kintsugi seam, a raked sand garden with stones
    //      and incense, a bonsai, a cast-iron tea set, one slim screen ----
    reg('bossDesk', 'zen', ['wood', 'white', 'black', 'walnut', 'grey', 'black-green'], function (P) {
        var m = S.model(-53, -7, 53, 35, 50);
        var A = P.accent, GOLD = mix(P.face, A, 0.75), gv = grainV(P.face), gvT = grainV(tone(P.top, 0.95));
        [-52, 46].forEach(function (ex) {
            m.box(ex, -6, 0, 6, 40, 15, function (x, y, z) { return y === 33 ? gv(x, y, z) : gvT(x, y, z); });
        });
        deskTop(m, [-52, -6, 104, 40], 15, 6, P.top, P.face, { board: 6, grain: 14, side: P.face });
        m.each(function (x, y, z) { return y === 33 && z >= 15 && z < 20 ? gv(x, y, z) : null; });
        m.box(-46, 28, 2, 92, 2, 2, P.leg);
        // the kintsugi seam: a gold crack down the left end
        [[-50, 9, 4], [-49, 4, 5], [-50, 1, 3]].forEach(function (s) { m.paint(s[0], 33, s[1], 1, 1, s[2], GOLD, MAT.SHINY); });
        [[0, 13, 6], [6, 12, 5], [11, 11, 7]].forEach(function (s) { m.paint(-52, s[0], s[1], 1, s[2], 1, GOLD, MAT.SHINY); });
        m.paint(-52, 18, 10, 1, 1, 2, GOLD, MAT.SHINY);
        // the sand garden: a frame, raked lines along its length, rings round two stones, incense
        m.box(18, -2, 21, 30, 18, 2, function (x, y, z) { return z === 22 ? P.face : P.faceDk; });
        m.box(19, -1, 22, 28, 16, 1, function (x, y) { return (y + 1) % 2 ? '#d3c6a6' : '#e9dfc6'; });
        [[28, 6, 3], [40, 9, 2]].forEach(function (s) {
            for (var y = s[1] - 7; y <= s[1] + 7; y++) for (var x = s[0] - 7; x <= s[0] + 7; x++) {
                var d = Math.hypot(x + 0.5 - s[0], y + 0.5 - s[1]);
                if (d <= s[2] + 3.6) m.paint(x, y, 22, 1, 1, 1, (Math.round(d) - s[2]) % 2 === 1 ? '#d3c6a6' : '#e9dfc6');
            }
            m.ellipsoid(s[0], s[1], 23, s[2], s[2] * 0.85, s[2] * 0.8, function (x, y, z) { return z > 23 ? '#8a8f93' : '#5f6366'; });
        });
        m.box(43, 1, 23, 3, 2, 1, '#4e342e');
        m.box(44, 1, 24, 1, 1, 5, '#8d6e63'); m.box(44, 1, 29, 1, 1, 1, '#ff7043', MAT.EMIT);
        [[44, 30], [45, 31], [45, 32], [44, 33], [43, 34]].forEach(function (s) { m.box(s[0], 1, s[1], 1, 1, 1, '#e1e1e6'); });
        // the bonsai in a glazed pot: a twisted trunk, three cloud pads
        m.box(-49, 3, 21, 14, 5, 4, function (x, y, z) { return z === 24 ? '#5b7383' : '#3f4f5a'; });
        m.paint(-48, 4, 24, 12, 3, 1, '#6b4f3a');
        rod(m, [-42, 5, 25], [-41, 5, 29], '#5d4037'); rod(m, [-41, 5, 29], [-39.5, 5, 33], '#5d4037'); rod(m, [-39.5, 5, 33], [-42, 5, 37], '#5d4037');
        rod(m, [-41, 5, 31], [-45, 5, 34], '#4e342e');
        [[-46, 36, 4.6], [-36.5, 38, 4.8], [-42, 41.5, 4.4]].forEach(function (pd) {
            m.ellipsoid(pd[0], 5, pd[1], pd[2], 3, 2.2, function (x, y, z) { return z > pd[1] ? '#4caf50' : '#2e7d32'; }, MAT.SOFT);
            m.paint(Math.round(pd[0]) - 1, 4, Math.round(pd[1]) + 1, 3, 2, 1, '#81c784', MAT.SOFT);
        });
        // the cast-iron teapot with a bamboo handle, a cup
        m.ellipsoid(-28, 8, 25, 4, 3.6, 3.4, '#2b2f33', MAT.SHINY);
        m.paint(-31, 6, 26, 3, 2, 1, '#3e454b');
        rod(m, [-24, 8, 25], [-21.5, 8, 27.5], '#2b2f33', MAT.SHINY);
        m.box(-29, 7, 28, 2, 2, 1, '#3e454b');
        m.line([-31.5, 8, 27.5], [-28, 8, 31], 1, '#8d6e3f'); m.line([-28, 8, 31], [-24.5, 8, 27.5], 1, '#8d6e3f');
        m.cyl(-19, 11, 21, 2, 2, 3, '#e8e2d0'); m.cyl(-19, 11, 23, 1.2, 1.2, 1, '#8fae7a');
        // one slim screen
        mon(m, { plan: [-18, 0, 36, 2], z: 23, h: 21, foot: [-5, -2, 10, 4] }, { bc: '#2a2a2a', stand: '#b0a58f' });
        keyboard(m, -14, 22, 28, 8, 21, { caseC: '#3e3a35', key: '#d7ccc8', key2: '#c8bbb3', gap: '#5d544c', hi: '#efebe9' });
        mouse(m, 17, 23, 21, 5, 7, '#d7ccc8');
        return m;
    });

    // ---- Data Ops: a 2x2 screen wall on a pole, a full server rack with blinking units and a stack light ----
    reg('bossDesk', 'dataops', ['black-cyan', 'black-green', 'black', 'grey', 'white-blue', 'grey-orange'], function (P) {
        var m = S.model(-51, -9, 75, 35, 70);
        var A = P.accent;
        [-50, 46].forEach(function (lx) {
            m.box(lx, -6, 0, 4, 40, 16, function (x, y, z) { return z === 0 ? P.seam : y === 33 ? P.metal : P.metalDk; }, MAT.SHINY);
            var ex = lx < 0 ? lx : lx + 3;
            m.paint(ex, -3, 3, 1, 34, 1, P.metal, MAT.SHINY); m.paint(ex, -3, 13, 1, 34, 1, P.metal, MAT.SHINY);
            m.paint(ex, -3, 3, 1, 1, 11, P.metal, MAT.SHINY); m.paint(ex, 30, 3, 1, 1, 11, P.metal, MAT.SHINY);
        });
        m.box(-46, -4, 10, 92, 4, 3, P.metalDk, MAT.SHINY);
        [[-30, '#1e88e5', 6], [-24, '#fdd835', 8], [-10, '#e53935', 5], [12, '#1e88e5', 7], [30, '#43a047', 6]].forEach(function (c) { m.box(c[0], -4, 10 - c[2], 2, 1, c[2], c[1]); });
        m.box(46, 23, 10, 6, 1, 1, '#1e88e5'); m.box(46, 26, 10, 6, 1, 1, '#fdd835');               // cables into the rack
        deskTop(m, [-50, -6, 100, 40], 16, 5, P.topB, P.faceDk, { speckle: 0.025 });
        m.paint(-48, 33, 18, 96, 1, 1, A, MAT.EMIT);
        // desk mat with a lit border, the debugging duck
        m.box(-30, 18, 21, 64, 14, 1, function (x, y) { return x === -30 || x === 33 || y === 18 || y === 31 ? mix('#1b1f24', A, 0.55) : '#1b1f24'; }, MAT.EMIT);
        m.ellipsoid(-40, 2, 23.5, 3, 2.4, 2.2, '#fdd835');
        m.ellipsoid(-39, 2, 27, 1.9, 1.8, 1.8, '#fdd835');
        m.box(-38, 2, 27, 3, 2, 1, '#fb8c00'); m.paint(-38, 3, 28, 1, 1, 1, '#212121');
        // the server rack: rails and units with LEDs (front), a perforated door (back), vents (sides), a stack light
        m.box(52, -8, 0, 22, 24, 58, function (x, y, z) {
            if (y === 15) return '#17191c';
            if (y === -8) return (x % 2 === 0 && z % 2 === 0 && x > 53 && x < 72 && z > 1 && z < 56) ? '#2a2e33' : P.metalDk;
            if ((x === 52 || x === 73) && z > 40 && z < 52 && z % 2 === 0 && y > -5 && y < 12) return '#121416';
            return z === 57 ? tone(P.metalDk, 1.12) : P.metalDk;
        }, MAT.SHINY);
        m.paint(53, 15, 1, 2, 1, 56, P.metal, MAT.SHINY); m.paint(71, 15, 1, 2, 1, 56, P.metal, MAT.SHINY);
        m.paint(70, -8, 22, 1, 1, 8, P.metal, MAT.SHINY);
        m.paint(52, 4, 8, 1, 6, 2, A, MAT.EMIT); m.paint(73, 4, 8, 1, 6, 2, A, MAT.EMIT);
        var UNITS = [[3, 'srv'], [3, 'srv'], [4, 'sw'], [3, 'patch'], [5, 'srv2'], [3, 'srv'], [5, 'srv2'], [4, 'kvm'], [3, 'srv'], [6, 'ups']], top = 56;
        UNITS.forEach(function (u, i) {
            var h = u[0], z0 = top - h + 1, ux = 56, uw = 14;
            m.box(ux, 16, z0, uw, 1, h - 1, function (x, y, z) { return z === z0 + h - 2 ? '#30353a' : '#23272b'; });
            if (u[1] === 'sw') for (var p = 0; p < 7; p++) { m.paint(ux + 1 + p * 2, 16, z0, 1, 1, 2, '#0b0c0e'); m.paint(ux + 1 + p * 2, 16, z0 + 1, 1, 1, 1, p % 3 ? '#76ff03' : '#ffab00', MAT.EMIT); }
            else if (u[1] === 'patch') for (var c = 0; c < 6; c++) m.paint(ux + 1 + c * 2, 16, z0, 1, 1, 2, ['#1e88e5', '#fdd835', '#e53935', '#1e88e5', '#43a047', '#fdd835'][c], MAT.EMIT);
            else if (u[1] === 'kvm') { m.paint(ux + 2, 16, z0 + 1, uw - 4, 1, 2, '#0d1b2a'); m.paint(ux + 3, 16, z0 + 2, 4, 1, 1, A, MAT.EMIT); }
            else if (u[1] === 'ups') { m.paint(ux + 2, 16, z0 + 1, 5, 1, 3, '#0b0c0e'); m.paint(ux + 3, 16, z0 + 2, 3, 1, 1, '#76ff03', MAT.EMIT); for (var v = 0; v < 3; v++) m.paint(ux + 9, 16, z0 + 1 + v, uw - 10, 1, 1, '#15171a'); }
            else {
                for (var vv = 0; vv < h - 2; vv++) m.paint(ux + 1, 16, z0 + vv, uw - 6, 1, 1, '#15171a');
                m.paint(ux + uw - 4, 16, z0 + h - 3, 1, 1, 1, i % 2 ? A : '#76ff03', MAT.EMIT);
                m.paint(ux + uw - 2, 16, z0 + h - 3, 1, 1, 1, i % 3 ? '#76ff03' : '#ffab00', MAT.EMIT);
                if (u[1] === 'srv2') m.paint(ux + uw - 4, 16, z0, 1, 1, 1, '#1e88e5', MAT.EMIT);
            }
            top -= h;
        });
        m.box(61, 12, 58, 5, 3, 1, '#37474f');
        m.box(62, 12, 59, 3, 3, 3, '#76ff03', MAT.EMIT); m.box(62, 12, 62, 3, 3, 3, '#ffab00', MAT.EMIT); m.box(62, 12, 65, 3, 3, 2, '#ff1744', MAT.EMIT);
        m.paint(62, 14, 61, 1, 1, 1, '#ccff90', MAT.EMIT);
        // the 2x2 screen wall on a pole
        m.rbox(-4, -5, 21, 8, 4, 1, 1, '#3b4148', MAT.SHINY);
        m.box(-2, -6, 22, 4, 2, 47, '#3b4148', MAT.SHINY);
        m.box(-17, -5, 34, 34, 2, 2, '#3b4148', MAT.SHINY);
        m.box(-17, -6, 56, 34, 2, 2, '#3b4148', MAT.SHINY);
        var o = { mount: 'none', bc: '#111317' };
        [[-31, -2, 47], [1, -2, 47], [-31, 0, 25], [1, 0, 25]].forEach(function (s) { mon(m, { plan: [s[0], s[1], 30, 2], z: s[2], h: 21 }, o); });
        keyboard(m, -14, 22, 28, 8, 22, { caseC: '#16181b', key: '#33373d', key2: '#2a2d32', gap: '#101215', hi: '#45494f', light: A });
        mouse(m, 17, 23, 22, 5, 7, '#26292e');
        return m;
    });

    // ---- Gaming Throne: three screens, a glass-panel RGB tower as the right pedestal, an angular lit leg,
    //      a rainbow edge strip, an XL mat, a headset stand, a controller ----
    reg('bossDesk', 'gaming', ['black-red', 'black-cyan', 'black-green', 'white-pink', 'black', 'white-blue'], function (P) {
        var m = S.model(-61, -7, 61, 36, 52);
        var A = P.accent, CASE = '#1a1b1e';
        // the angular leg: two posts, a foot, a diagonal brace, a lit insert
        m.box(-60, -4, 0, 5, 34, 2, P.metalDk, MAT.SHINY);
        m.box(-60, -4, 2, 5, 4, 14, P.metalDk, MAT.SHINY); m.box(-60, 26, 2, 5, 4, 14, P.metalDk, MAT.SHINY);
        rod(m, [-58, 0, 2.5], [-58, 25, 14], P.metal, MAT.SHINY);
        m.paint(-59, 29, 3, 3, 1, 10, A, MAT.EMIT); m.paint(-60, 27, 3, 1, 2, 10, A, MAT.EMIT);
        // the tower: mesh front with two RGB fans, a glass side (GPU, RAM, a fan), an exhaust at the back
        m.box(42, 6, 0, 18, 26, 16, function (x, y, z) { return z === 15 ? '#26282c' : (y === 31 && z % 2 === 0 && z > 0 && z < 15 && x > 43 && x < 58) ? '#22242a' : CASE; });
        [[51, 10.5], [51, 4.5]].forEach(function (f) {
            for (var z = 0; z < 16; z++) for (var x = 46; x < 57; x++) {
                var d = Math.hypot(x + 0.5 - f[0], z + 0.5 - f[1]);
                if (d <= 3.2 && d > 2.1) m.paint(x, 31, z, 1, 1, 1, A, MAT.EMIT);
            }
        });
        m.paint(57, 31, 14, 1, 1, 1, '#ffffff', MAT.EMIT);
        m.paint(59, 7, 1, 1, 24, 14, '#0c0d10');
        m.paint(59, 9, 4, 1, 15, 3, '#2b2e35'); m.paint(59, 9, 3, 1, 15, 1, A, MAT.EMIT);
        for (var r = 0; r < 4; r++) m.paint(59, 10 + r * 2, 9, 1, 1, 5, RAINBOW[r * 2 % 7], MAT.EMIT);
        for (var z2 = 6; z2 < 15; z2++) for (var y2 = 22; y2 < 31; y2++) { var d2 = Math.hypot(y2 + 0.5 - 26, z2 + 0.5 - 10); if (d2 <= 3.2 && d2 > 2.1) m.paint(59, y2, z2, 1, 1, 1, A, MAT.EMIT); }
        m.paint(59, 7, 13, 1, 2, 1, '#ffffff');
        for (var zz = 7; zz < 14; zz++) for (var xx = 43; xx < 52; xx++) { var dd = Math.hypot(xx + 0.5 - 47, zz + 0.5 - 10.5); if (dd <= 3.2 && dd > 2.1) m.paint(xx, 6, zz, 1, 1, 1, '#3a3d42'); }
        m.paint(52, 6, 8, 4, 1, 6, '#3a3d42'); m.paint(53, 6, 12, 2, 1, 1, '#1e88e5', MAT.EMIT); m.paint(53, 6, 10, 2, 1, 1, '#43a047', MAT.EMIT);
        // the top: a rainbow strip in the front edge, underglow
        deskTop(m, [-60, -6, 120, 40], 16, 5, P.topB, P.faceDk, { speckle: 0.03 });
        for (var i = 0; i < 7; i++) { var a = -58 + Math.floor(i * 116 / 7), b = -58 + Math.floor((i + 1) * 116 / 7); m.paint(a, 33, 18, b - a, 1, 1, RAINBOW[i], MAT.EMIT); }
        m.box(-54, 31, 15, 95, 2, 1, A, MAT.EMIT);
        // the XL mat with a lit border, a controller
        m.box(-42, 17, 21, 84, 15, 1, function (x, y) { return x === -42 || x === 41 || y === 17 || y === 31 ? A : '#141518'; }, MAT.EMIT);
        m.paint(-41, 18, 21, 82, 13, 1, '#141518', MAT.SOLID);
        m.rbox(-31, 8, 21, 10, 5, 2, 1, '#26282c');
        m.box(-31, 12, 21, 3, 2, 2, '#26282c'); m.box(-24, 12, 21, 3, 2, 2, '#26282c');
        m.paint(-24, 9, 22, 1, 1, 1, A, MAT.EMIT); m.paint(-23, 10, 22, 1, 1, 1, '#76ff03', MAT.EMIT); m.paint(-29, 10, 22, 2, 1, 1, '#5c6166');
        // the headset on its stand
        m.rbox(-52, 12, 21, 8, 4, 2, 1, '#26282c');
        m.box(-49, 13, 23, 2, 2, 11, '#3a3d42');
        m.box(-53, 13, 34, 11, 2, 2, '#1b1c1f');
        m.box(-54, 13, 30, 2, 2, 4, '#1b1c1f'); m.box(-43, 13, 30, 2, 2, 4, '#1b1c1f');
        m.box(-55, 12, 24, 3, 4, 6, '#1b1c1f'); m.box(-43, 12, 24, 3, 4, 6, '#1b1c1f');
        m.paint(-55, 13, 25, 1, 2, 4, A, MAT.EMIT); m.paint(-41, 13, 25, 1, 2, 4, A, MAT.EMIT);
        // three screens, the side ones angled in
        var o = { bc: '#0d0d0f', stand: '#26282c', ledC: A };
        mon(m, { plan: [-58, 4, 34, 2], z: 24, h: 22, foot: [-46, 2, 10, 4] }, o);
        mon(m, { plan: [-20, 0, 40, 2], z: 24, h: 25, foot: [-5, -2, 10, 4] }, o);
        mon(m, { plan: [24, 4, 34, 2], z: 24, h: 22, foot: [36, 2, 10, 4] }, o);
        shiftY(m, -58, -49, -1, 7, 24, 46, 1); shiftY(m, -58, -53, -1, 8, 24, 46, 1);
        shiftY(m, 49, 58, -1, 7, 24, 46, 1); shiftY(m, 53, 58, -1, 8, 24, 46, 1);
        keyboard(m, -14, 22, 28, 8, 22, { caseC: '#16181b', key: '#2a2d33', key2: '#23262b', gap: '#101215', hi: '#3a3f47', acc: A, light: A });
        mouse(m, 17, 23, 22, 5, 7, '#26292e', A);
        return m;
    });

    // ---- Executive Lectern (standing): a wood podium with a sloped cantilevered top, corbels, a crest, a
    //      leather inlay, two screens on a pole at eye height, a brass clock ----
    reg('bossDesk', 'exec-standing', ['walnut', 'wood', 'walnut-brass', 'black-gold', 'black', 'white'], function (P) {
        var m = S.model(-41, -20, 41, 11, 68);
        var A = P.accent, leather = P.id === 'white' ? '#1f3554' : '#5a1e1e';
        // the podium: raised panels and a crest (front), one panel and two studs (back), plinth
        m.box(-40, -18, 0, 80, 14, 26, function (x, y, z) {
            if (z < 2) return z === 1 ? tone(P.faceDk, 1.2) : P.faceDk;
            if (y === -5 || y === -18) return P.face;
            return P.body;
        });
        [[-36, 30], [6, 30]].forEach(function (p) {
            m.paint(p[0], -5, 2, p[1], 1, 9, tone(P.face, 0.82));
            m.box(p[0] + 1, -4, 3, p[1] - 2, 1, 7, P.face);
            m.paint(p[0] + 1, -4, 9, p[1] - 2, 1, 1, tone(P.face, 1.16)); m.paint(p[0] + 1, -4, 3, 1, 1, 7, tone(P.face, 1.1));
            m.paint(p[0], -5, 13, p[1], 1, 1, tone(P.face, 0.82)); m.paint(p[0], -5, 22, p[1], 1, 1, tone(P.face, 0.82));
            m.paint(p[0], -5, 13, 1, 1, 10, tone(P.face, 0.82)); m.paint(p[0] + p[1] - 1, -5, 13, 1, 1, 10, tone(P.face, 0.82));
        });
        m.box(-2, -4, 6, 4, 1, 4, A, MAT.SHINY); m.paint(-1, -4, 7, 2, 1, 2, tone(A, 0.7), MAT.SHINY);
        m.paint(-37, -18, 3, 74, 1, 1, tone(P.face, 0.82)); m.paint(-37, -18, 22, 74, 1, 1, tone(P.face, 0.82));
        m.paint(-37, -18, 3, 1, 1, 20, tone(P.face, 0.82)); m.paint(36, -18, 3, 1, 1, 20, tone(P.face, 0.82));
        [-34, 32].forEach(function (x) { m.box(x, -19, 19, 2, 1, 2, A, MAT.SHINY); });
        [-40, 39].forEach(function (ex) { m.paint(ex, -15, 3, 1, 8, 1, tone(P.body, 0.85)); m.paint(ex, -15, 22, 1, 8, 1, tone(P.body, 0.85)); m.paint(ex, -15, 3, 1, 1, 20, tone(P.body, 0.85)); m.paint(ex, -8, 3, 1, 1, 20, tone(P.body, 0.85)); });
        // carved corbels under the overhang at the front corners
        [-38, 34].forEach(function (x) {
            for (var z = 17; z < 26; z++) m.box(x, -4, z, 4, z - 16, 1, z === 25 ? tone(P.face, 1.1) : P.face);
        });
        // the top, sloping up toward the back, a lit front lip
        deskTop(m, [-40, -18, 80, 28], 26, 4, P.topB, P.faceDk, { grain: 16 });
        var slope = function (y) { return Math.max(0, Math.round((-6 - y) * 3 / 12)); };
        for (var y = -18; y < -6; y++) {
            var e = slope(y);
            if (e > 0) m.box(-40, y, 30, 80, 1, e, function (x, yy, z) { return z === 29 + e ? (x === -40 || x === 39 || yy === -18 ? tone(P.topB, 1.07) : longGrain(P.topB, 16)(x, yy)) : mix(P.topB, P.faceDk, 0.5); });
        }
        m.paint(-40, 9, 29, 80, 1, 1, tone(P.faceDk, 1.3));
        // the leather inlay with gold tooling
        m.box(-24, -6, 30, 48, 15, 1, function (x, y) {
            if (x === -24 || x === 23 || y === -6 || y === 8) return tone(leather, 0.7);
            if ((y === -4 || y === 6) && x > -23 && x < 22 || (x === -22 || x === 21) && y > -5 && y < 7) return A;
            return leather;
        });
        // the brass carriage clock
        var cz = 30 + slope(-12);
        m.box(-36, -14, cz, 8, 4, 2, BRASS_DK, MAT.SHINY);
        m.box(-35, -14, cz + 2, 6, 4, 7, function (x, y, z) { return z === cz + 8 ? BRASS_HI : BRASS; }, MAT.SHINY);
        m.box(-33, -13, cz + 9, 2, 2, 1, BRASS, MAT.SHINY);
        m.paint(-34, -11, cz + 3, 4, 1, 4, '#f3ead2'); m.paint(-32, -11, cz + 4, 1, 1, 2, '#222');
        // two screens on a pole at eye height
        m.box(-3, -18, 30 + slope(-17), 6, 3, 1, '#2b2e33', MAT.SHINY);
        m.box(-1, -18, 30 + slope(-18), 2, 2, 57 - 30 - slope(-18), '#2b2e33', MAT.SHINY);
        m.box(-20, -18, 53, 40, 2, 2, '#2b2e33', MAT.SHINY);
        mon(m, { plan: [-36, -15, 34, 2], z: 44, h: 21 }, { mount: 'none', bc: '#1c1f24' });
        mon(m, { plan: [2, -15, 34, 2], z: 44, h: 21 }, { mount: 'none', bc: '#1c1f24' });
        keyboard(m, -14, 1, 28, 7, 30, BKEYS);
        mouse(m, 18, 2, 30, 4, 6, '#37474f');
        return m;
    });

    // ---- War Table (standing): the whole top a glowing tactical map on a lit plinth, a status screen ----
    reg('bossDesk', 'war-table', ['black-cyan', 'black-red', 'black-green', 'grey-orange', 'black-gold', 'white-blue'], function (P) {
        var m = S.model(-49, -26, 49, 17, 70);
        var A = P.accent, SEA = '#08131d', LAND = '#123247', GRID = mix(SEA, A, 0.3), DIM = mix(SEA, A, 0.55);
        // the plinth: lit slits on every face, a dark base, a glow line
        m.box(-36, -16, 0, 72, 14, 26, function (x, y, z) { return z < 2 ? P.faceDk : P.face; });
        for (var sx = -32; sx < 34; sx += 8) { m.paint(sx, -3, 3, 1, 1, 6, A, MAT.EMIT); m.paint(sx, -16, 3, 1, 1, 6, A, MAT.EMIT); }
        [-13, -9, -5].forEach(function (sy) { m.paint(-36, sy, 3, 1, 1, 6, A, MAT.EMIT); m.paint(35, sy, 3, 1, 1, 6, A, MAT.EMIT); });
        m.each(function (x, y, z) { return z === 2 && (y === -3 || y === -16 || x === -36 || x === 35) ? mix(P.face, A, 0.45) : null; });
        m.paint(-36, -16, 23, 72, 14, 3, tone(P.face, 0.9));
        // the top: a lit edge all round
        deskTop(m, [-48, -24, 96, 40], 26, 4, P.metalDk, P.leg, { board: 4, side: P.leg });
        m.each(function (x, y, z) { return z === 28 && (y === -24 || y === 15 || x === -48 || x === 47) ? A : null; });
        m.paint(-48, 15, 28, 96, 1, 1, A, MAT.EMIT); m.paint(-48, -24, 28, 96, 1, 1, A, MAT.EMIT);
        m.paint(-48, -24, 28, 1, 40, 1, A, MAT.EMIT); m.paint(47, -24, 28, 1, 40, 1, A, MAT.EMIT);
        // the map: sea, grid, landmasses with lit coasts, a radar, units, a route
        var X0 = -46, Y0 = -22, W = 92, H = 36;
        var X = function (f) { return X0 + Math.round(f * W); }, Y = function (f) { return Y0 + Math.round(f * H); };
        m.box(X0, Y0, 29, W, H, 1, function (x, y) { return (x - X0) % 6 === 3 || (y - Y0) % 6 === 3 ? GRID : SEA; }, MAT.EMIT);
        [[0.08, 0.15, 0.32, 0.45], [0.22, 0.45, 0.25, 0.4], [0.55, 0.55, 0.3, 0.3], [0.62, 0.1, 0.2, 0.3]].forEach(function (q) {
            var a = X(q[0]), c = Y(q[1]), aw = Math.max(3, Math.round(q[2] * W)), ch = Math.max(3, Math.round(q[3] * H));
            m.paint(a, c, 29, aw, ch, 1, LAND, MAT.EMIT);
            m.paint(a, c, 29, aw, 1, 1, A, MAT.EMIT); m.paint(a, c, 29, 1, ch, 1, A, MAT.EMIT);
            m.paint(a + aw - 1, c, 29, 1, ch, 1, DIM, MAT.EMIT); m.paint(a, c + ch - 1, 29, aw, 1, 1, DIM, MAT.EMIT);
        });
        var rx = X(0.78), ry = Y(0.62);
        paintRing(m, rx, ry, 29, 8, A, MAT.EMIT); paintRing(m, rx, ry, 29, 4, DIM, MAT.EMIT);
        for (var k = 0; k < 8; k++) m.paint(rx + k, ry - Math.round(k * 0.6), 29, 1, 1, 1, '#e0f7fa', MAT.EMIT);
        m.box(rx - 2, ry + 2, 30, 2, 2, 1, '#ff5252', MAT.EMIT);
        [[0.2, 0.3], [0.26, 0.36], [0.35, 0.62], [0.12, 0.7]].forEach(function (u) { m.box(X(u[0]), Y(u[1]), 30, 2, 2, 1, '#40c4ff', MAT.EMIT); });
        [[0.6, 0.22], [0.7, 0.3], [0.66, 0.68]].forEach(function (u) { m.box(X(u[0]), Y(u[1]), 30, 3, 2, 1, '#ff5252', MAT.EMIT); });
        for (var d = 0; d < 10; d += 2) m.paint(X(0.26 + d * 0.035), Y(0.36 - d * 0.012), 29, 1, 1, 1, '#fff176', MAT.EMIT);
        // the touch keyboard and a puck toward the person
        m.paint(-14, 3, 29, 28, 7, 1, '#04090e', MAT.EMIT);
        m.paint(-14, 3, 29, 28, 1, 1, A, MAT.EMIT); m.paint(-14, 9, 29, 28, 1, 1, A, MAT.EMIT);
        for (var i = 0; i < 6; i++) { m.paint(-12 + i * 4, 5, 29, 3, 1, 1, DIM, MAT.EMIT); m.paint(-11 + i * 4, 7, 29, 3, 1, 1, DIM, MAT.EMIT); }
        m.cyl(20, 6.5, 30, 2.2, 2.2, 1, A, MAT.EMIT); m.box(20, 6, 30, 1, 1, 1, SEA, MAT.EMIT);
        // the status screen on its post at the far edge
        m.box(-2, -24, 30, 4, 2, 15, '#2b2f35', MAT.SHINY);
        m.rbox(-5, -24, 30, 10, 3, 1, 1, '#2b2f35', MAT.SHINY);
        mon(m, { plan: [-30, -23, 60, 2], z: 44, h: 24 }, { mount: 'none', bc: '#0e1116' });
        m.paint(-30, -22, 67, 60, 1, 1, A, MAT.EMIT);
        return m;
    });
})();
