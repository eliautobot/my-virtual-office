// Hand-built stack models (desks): the classic desk, the executive desk, the
// three chairs (desk, boss, meeting), the meeting table and the front desk.
// See stack/README.md. Rotation 0 only, front = +y (the sitter's side of a desk,
// the visitor's side of the front desk), origin = the item anchor, plans as in
// FURNITURE_MANIFEST (projection.parts).
(function () {
    'use strict';
    var S = window.VOStack, C = S.color, MAT = S.MAT, T = S.tex;

    // ---------- colours ----------
    // FURNITURE_COLORS base table (game.js): the fallback when the gallery has no
    // ctx.colors; in the office ctx.colors is the resolved slot map of the item.
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
    function palette(item, ctx) {
        if (ctx && ctx.colors && ctx.colors.top) return ctx.colors;
        var id = (item && item.color) || 'wood';
        if (BASE[id]) return Object.assign({ id: id }, BASE[id]);
        if (ACC[id]) return Object.assign({ id: id }, BASE[ACC[id][0]], { accent: ACC[id][1] });
        return Object.assign({ id: 'wood' }, BASE.wood);
    }
    function colorKey(item, ctx) { return palette(item, ctx).id || (item && item.color) || 'wood'; }
    // Desk variants keep the converter's model (stack-legacy: the variant's own art).
    function variantModel(item) {
        try {
            if (typeof _mk === 'function' && _mk(item) !== item.type && S.legacyModel) return S.legacyModel(item);
        } catch (e) { /* the classic model */ }
        return null;
    }
    var tone = C.tone, mix = C.mix;
    function hx(c) { return C.hex(c); }

    // ---------- shared bits ----------
    // A rod with a 2x2 section from p to q (chair legs, posts).
    function rod(m, p, q, col, mat) {
        var dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
        var n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) * 2));
        for (var i = 0; i <= n; i++) {
            var t = i / n;
            m.box(Math.floor(p[0] + dx * t - 0.5), Math.floor(p[1] + dy * t - 0.5), Math.floor(p[2] + dz * t - 0.5), 2, 2, 2, col, mat);
        }
    }
    // Wood with the grain along x (planks) or y, plus a lighter rim on the top layer.
    // Long, calm grain for big tops (streaks seg px long, staggered per row).
    function longGrain(base, seg) {
        var c0 = C.rgb(base), dark = tone(c0, 0.9), light = tone(c0, 1.06);
        return function (x, y) {
            var n = C.hash(y, Math.floor((x + (y * 7) % seg) / seg), 11);
            return n < 0.15 ? dark : n > 0.9 ? light : c0;
        };
    }
    function woodTop(base, x0, y0, x1, y1, zTop, seg) {
        var g = seg ? longGrain(base, seg) : T.wood(base), rim = tone(base, 1.07), side = tone(base, 0.93);
        return function (x, y, z) {
            if (z === zTop && (x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1)) return rim;
            if (z < zTop) return (x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1) ? side : g(x, y, z);
            return g(x, y, z);
        };
    }
    // Vertical grain for fronts (drawer faces, panels).
    function grainV(base) {
        var c0 = C.rgb(base), d = tone(c0, 0.93), l = tone(c0, 1.05);
        return function (x, y, z) { var n = C.hash(x, 3, Math.floor(z / 7)); return n < 0.2 ? d : n > 0.88 ? l : c0; };
    }

    // A flat-panel monitor, screen facing +y. o: x0, x1 (bezel), yb (the screen's
    // row: the panel is rows yb - 2, yb - 1 (back plate, 2 px so no turn shows the
    // screen through it), yb (screen, recessed), yb + 1 (bezel)), z0, z1, bez
    // (sides), top, chin, frame (outer 2 px colour or null), hump [x0, x1, z0, z1]
    // (casing back, rows yb - 4, yb - 3), neck [x, w], foot [x, y, w, d], footZ, led.
    var MON = { bezel: '#263238', bezelHi: '#3b4c55', chin: '#1f2a30', hump: '#2e3b42', vent: '#20292e', neck: '#3c4b53', foot: '#455a64', footHi: '#566d79', screen: '#2c4a63' };
    function monitor(m, o) {
        var yb = o.yb, fz = o.footZ;
        // foot plate + neck
        m.rbox(o.foot[0], o.foot[1], fz, o.foot[2], o.foot[3], 1, 1, MON.foot, MAT.SHINY);
        m.paint(o.foot[0] + 1, o.foot[1] + o.foot[3] - 1, fz, o.foot[2] - 2, 1, 1, MON.footHi);
        m.box(o.neck[0], yb - 4, fz + 1, o.neck[1], 2, Math.max(2, Math.round((o.z0 + o.z1) / 2) - fz - 1), MON.neck, MAT.SHINY);
        // casing back
        var h = o.hump;
        m.rbox(h[0], yb - 4, h[2], h[1] - h[0], 2, h[3] - h[2], 1, MON.hump);
        for (var vz = h[2] + 3; vz < h[3] - 2; vz += 3) m.paint(h[0] + 3, yb - 4, vz, h[1] - h[0] - 6, 1, 1, MON.vent);
        // panel: back plate, bezel ring (front row) round the recessed screen (yb)
        var fr = o.frame;
        m.box(o.x0, yb - 2, o.z0, o.x1 - o.x0, 4, o.z1 - o.z0, function (x, y, z) {
            if (z >= o.z1 - 1) return MON.bezelHi;
            if (y < yb) return x === o.x0 || x === o.x1 - 1 ? MON.bezel : MON.hump;
            if (fr && (x < o.x0 + 2 || x >= o.x1 - 2 || z < o.z0 + 2 || z >= o.z1 - 2)) return fr;
            if (z < o.z0 + 1) return MON.chin;
            return MON.bezel;
        });
        var sx0 = o.x0 + o.bez, sx1 = o.x1 - o.bez, sz0 = o.z0 + o.chin, sz1 = o.z1 - o.top;
        m.carve(sx0, yb + 1, sz0, sx1 - sx0, 1, sz1 - sz0);
        m.box(sx0, yb, sz0, sx1 - sx0, 1, sz1 - sz0, MON.screen, MAT.SCREEN);
        // power LED on the chin
        if (o.led) m.box(o.x1 - o.bez - 2, yb + 1, o.z0 + (o.frame ? 2 : 1), 2, 1, 1, '#69f0ae', MAT.EMIT);
    }
    // Keyboard (case + key caps in alternating tones) lying on z.
    function keyboard(m, x, y, w, d, z, kc) {
        kc = kc || { caseC: '#2f3d44', key: '#607d8b', key2: '#546e7a', gap: '#37474f', hi: '#78909c' };
        m.rbox(x, y, z, w, d, 1, 1, kc.caseC);
        m.box(x + 1, y + 1, z + 1, w - 2, d - 2, 1, function (xx, yy) {
            var cx = xx - x - 1, cy = yy - y - 1, last = cy === d - 3;
            if (last && cx > (w - 2) * 0.25 && cx < (w - 2) * 0.72) return kc.key2;      // space bar
            if (cy % 2 === 1 && !last) return kc.gap;
            var u = cx + (cy >> 1);
            if (u % 3 === 2) return kc.gap;
            if (cy === 0) return kc.hi;                                                // function row
            return Math.floor(u / 3) % 2 ? kc.key2 : kc.key;
        });
    }
    function mouse(m, x, y, z, w, d, col) {
        col = col || '#607d8b';
        m.rbox(x, y, z, w, d, 2, 1, col);
        m.paint(x, y, z + 1, w, 2, 1, tone(col, 1.25));
        m.paint(x + Math.floor(w / 2), y, z + 1, 1, 2, 1, tone(col, 0.8));
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
        // a few leaf tips sticking out
        m.box(Math.round(cx - w * 0.55), Math.round(cy), top + 3, 2, 2, 2, leafA, MAT.SOFT);
        m.box(Math.round(cx + w * 0.45), Math.round(cy - 1), top + 4, 2, 2, 2, leafA, MAT.SOFT);
    }

    // ---------- the classic desk ----------
    // top [-32,-18,64,32] z16 h5, four legs, pedestal [10,-16,18,30], modesty
    // panel [-28,-18,38,2], monitor [-20,-11,40,2] z23 h26 (screen +y), keyboard
    // [-15,1,30,8] z21, mouse.
    S.def('desk', function (item, ctx) {
        var vm = variantModel(item);
        if (vm) return vm;
        var P = palette(item, ctx);
        var m = S.model(-33, -19, 33, 16, 50);
        // legs (4x4) with a lighter edge and a dark glide
        [[-32, -18], [28, -18], [-32, 10], [28, 10]].forEach(function (l) {
            m.box(l[0], l[1], 0, 4, 4, 16, function (x, y, z) {
                if (z === 0) return P.seam;
                return (x === l[0] && l[0] < 0) || (x === l[0] + 3 && l[0] > 0) || y === l[1] + 3 ? P.legHi : P.leg;
            });
        });
        // side stretcher between the left legs (the open end)
        m.box(-31, -14, 3, 2, 24, 2, P.leg);
        // modesty panel at the back with two grooves
        m.box(-28, -18, 2, 38, 2, 14, function (x, y, z) { return z === 6 || z === 11 ? P.seam : P.faceDk; });
        // drawer pedestal: carcass, plinth, two drawer fronts, pulls
        m.box(10, -16, 0, 18, 29, 16, function (x, y, z) { return (x === 10 || x === 27) && y > -15 ? tone(P.face, 0.96) : P.face; });
        m.box(11, 12, 0, 16, 1, 2, P.leg);                                   // recessed plinth
        m.box(11, 13, 9, 16, 1, 6, grainV(P.faceDk));                        // upper drawer z 9..15
        m.box(11, 13, 2, 16, 1, 6, grainV(P.faceDk));                        // lower drawer z 2..8
        m.paint(11, 13, 14, 16, 1, 1, tone(P.faceDk, 1.1));                  // lit top edges
        m.paint(11, 13, 7, 16, 1, 1, tone(P.faceDk, 1.1));
        m.box(16, 14, 12, 6, 1, 1, P.pull, MAT.SHINY);                        // pulls
        m.box(16, 14, 5, 6, 1, 1, P.pull, MAT.SHINY);
        // apron under the top (inset 1) with the pencil drawer
        m.box(-31, -17, 16, 62, 30, 3, P.face);
        m.paint(-31, 12, 16, 62, 1, 1, tone(P.face, 0.88));
        m.box(-27, 13, 16, 16, 1, 3, P.faceDk);
        m.box(-21, 14, 17, 4, 1, 1, P.pull, MAT.SHINY);
        // the top: 2 px board, rim light, wood grain
        m.box(-32, -18, 19, 64, 32, 2, woodTop(P.top, -32, -18, 32, 14, 20));
        // cable grommet at the back left
        m.cyl(-24, -14.5, 20, 2.2, 1.8, 1, P.seam);
        m.cyl(-24, -14.5, 20, 1.2, 1, 1, '#16181b');
        // monitor (screen +y), stand on the back third
        monitor(m, { x0: -20, x1: 20, yb: -11, z0: 23, z1: 49, bez: 3, top: 3, chin: 3, frame: null,
            hump: [-15, 15, 28, 45], neck: [-2, 4], foot: [-9, -14, 18, 6], footZ: 21, led: true });
        // keyboard, mouse pad + mouse
        keyboard(m, -15, 1, 30, 8, 21);
        m.rbox(16, -1, 21, 10, 11, 1, 1, '#263238');
        mouse(m, 18, 1, 22, 5, 7);
        return m;
    }, colorKey);

    // ---------- the executive desk ----------
    // top [-48,-6,96,40] z16 h5, two drawer pedestals [-48,0,26,34] / [22,0,26,34],
    // back panel [-48,-6,96,3], two monitors [-40,-1,34,2] / [6,-1,34,2] z24 h24
    // (stands from z21), pen holder [37,5,8,6], plant pot [36,17,10,6], notepad
    // [-44,13,14,18], keyboard [-14,22,28,8], mouse [17,22,6,8].
    S.def('bossDesk', function (item, ctx) {
        var vm = variantModel(item);
        if (vm) return vm;
        var P = palette(item, ctx);
        var m = S.model(-49, -7, 49, 36, 50);
        var gold = mix(P.faceDk, P.accent, 0.55), handle = mix(P.accent, P.faceDk, 0.35);
        // back panel (full width): the inner face with two panel lines, the outer
        // (visitor) face in frame-and-panel: four sunk panels with a lit lower rail
        m.box(-47, -6, 0, 94, 3, 16, function (x, y, z) {
            if (y === -4 && (x === -8 || x === 7 || z === 14)) return P.face;
            if (z === 0) return P.seam;
            return P.faceDk;
        });
        for (var pi = 0; pi < 4; pi++) {
            var px0 = -42 + pi * 22;
            m.carve(px0, -6, 3, 18, 1, 10);
            m.paint(px0, -5, 3, 18, 1, 10, grainV(tone(P.faceDk, 1.06)));
            m.paint(px0, -6, 2, 18, 1, 1, tone(P.faceDk, 1.12));
            m.paint(px0 - 1, -6, 3, 1, 1, 10, tone(P.faceDk, 1.08));
        }
        // two drawer pedestals: carcass, plinth, drawers, gold handles
        [-48, 22].forEach(function (px) {
            m.box(px, -3, 0, 26, 36, 16, function (x, y, z) { return z === 15 ? tone(P.body, 1.05) : P.body; });
            m.box(px + 2, 32, 0, 22, 1, 2, P.leg);                                  // plinth
            m.box(px + 2, 33, 9, 22, 1, 6, grainV(P.face));                         // drawers
            m.box(px + 2, 33, 2, 22, 1, 6, grainV(P.face));
            m.paint(px + 2, 33, 14, 22, 1, 1, tone(P.face, 1.1));
            m.paint(px + 2, 33, 7, 22, 1, 1, tone(P.face, 1.1));
            m.box(px + 8, 34, 11, 10, 1, 2, handle, MAT.SHINY);                    // handles
            m.box(px + 8, 34, 4, 10, 1, 2, handle, MAT.SHINY);
            m.paint(px + 9, 34, 12, 4, 1, 1, P.accent, MAT.SHINY);
            m.paint(px + 9, 34, 5, 4, 1, 1, P.accent, MAT.SHINY);
            // side panel inset line (the end faces)
            var ex = px < 0 ? px : px + 25;
            m.paint(ex, 1, 3, 1, 29, 1, tone(P.body, 0.9)); m.paint(ex, 1, 13, 1, 29, 1, tone(P.body, 0.9));
            m.paint(ex, 1, 3, 1, 1, 11, tone(P.body, 0.9)); m.paint(ex, 29, 3, 1, 1, 11, tone(P.body, 0.9));
        });
        // apron (inset 1) with a gold line along the front
        m.box(-47, -5, 16, 94, 38, 3, P.faceDk);
        m.paint(-47, 32, 17, 94, 1, 1, gold, MAT.SHINY);
        // top: 2 px board, polished inlay 3 px in
        var wt = woodTop(P.topB, -48, -6, 48, 34, 20);
        m.box(-48, -6, 19, 96, 40, 2, function (x, y, z) {
            if (z === 20 && ((x === -45 || x === 44) && y >= -3 && y <= 30 || (y === -3 || y === 30) && x >= -45 && x <= 44)) return P.inlay;
            return wt(x, y, z);
        });
        // leather blotter under the keyboard
        m.box(-22, 18, 21, 44, 15, 1, function (x, y) { return x === -22 || x === 21 || y === 18 || y === 32 ? '#22382c' : '#2f4a3a'; });
        m.paint(-20, 19, 21, 40, 1, 1, '#3d5c49');
        // notepad + pen
        m.box(-44, 13, 21, 14, 18, 1, '#fffde7');
        m.box(-43, 14, 22, 12, 16, 1, function (x, y) { return y > 15 && (y - 16) % 3 === 0 && x < -32 ? '#e0d9b8' : '#fff9c4'; });
        m.box(-43, 14, 22, 12, 1, 1, '#ef9a9a');
        m.box(-29, 15, 21, 2, 13, 1, '#1e3a8a'); m.box(-29, 26, 21, 2, 2, 1, '#cfd8dc', MAT.SHINY);
        // pen holder with three pens
        m.cyl(41, 8, 21, 4, 3, 10, '#546e7a', MAT.SHINY);
        m.cyl(41, 8, 30, 4, 3, 1, '#78909c', MAT.SHINY);
        m.carve(39, 7, 29, 4, 2, 2);
        m.box(38, 7, 26, 2, 2, 9, '#1565c0'); m.box(40, 8, 26, 2, 2, 8, '#c62828'); m.box(42, 7, 26, 2, 2, 7, '#2e7d32');
        m.box(38, 7, 34, 2, 2, 1, '#eceff1');
        // small plant
        plant(m, 36, 17, 10, 6, 21, 7, '#6d4c41', '#4caf50', '#66bb6a', 9);
        // two monitors
        [-40, 6].forEach(function (x0) {
            monitor(m, { x0: x0, x1: x0 + 34, yb: -1, z0: 24, z1: 48, bez: 4, top: 4, chin: 4, frame: '#1a1a2e',
                hump: [x0 + 6, x0 + 28, 28, 44], neck: [x0 + 14, 6], foot: [x0 + 9, -3, 16, 5], footZ: 21, led: true });
        });
        // keyboard + mouse on the blotter
        keyboard(m, -14, 22, 28, 8, 22, { caseC: '#232e34', key: '#546e7a', key2: '#455a64', gap: '#2b373e', hi: '#6c8591' });
        mouse(m, 17, 23, 22, 5, 7, '#37474f');
        return m;
    }, colorKey);

    // ---------- chairs ----------
    // Origin = the seat centre on the floor, the sitter faces +y.
    var CH = {
        desk: { c0: '#3c4650', c1: '#4f5b66', c2: '#66737e', c3: '#2b333b', base: '#2b333b', baseMat: MAT.SOLID, piston: '#8d9aa4' },
        boss: { c0: '#3e2723', c1: '#5d4037', c2: '#795548', c3: '#2e1c17', base: '#9aa5ad', baseMat: MAT.SHINY, piston: '#b0bcc4' }
    };
    function starBase(m, r, legZ, col, mat, hubR) {
        for (var k = 0; k < 5; k++) {
            var a = (54 + k * 72) * Math.PI / 180, tx = Math.cos(a) * r, ty = Math.sin(a) * r;
            rod(m, [tx * 0.25, ty * 0.25, legZ + 1.5], [tx, ty, legZ + 0.5], col, mat);
            m.cyl(tx, ty, 0, 1.6, 1.6, 2, '#1c2228');                        // caster
            m.box(Math.round(tx) - 1, Math.round(ty) - 1, 0, 2, 2, 1, '#14181c');
        }
        m.cyl(0, 0, legZ, hubR, hubR, 3, col, mat);
    }
    function fabric(c) { return T.speckle(c, 0.05); }

    S.def('chair:desk', function () {
        var c = CH.desk, m = S.model(-15, -15, 15, 14, 30);
        starBase(m, 11, 1, c.base, c.baseMat, 2.6);
        m.cyl(0, 0, 4, 2, 2, 4, '#262d34');                                  // gas lift: sleeve + piston
        m.cyl(0, 0, 8, 1.5, 1.5, 2, c.piston, MAT.SHINY);
        m.box(-5, -5, 9, 10, 10, 1, '#262d34');                              // mechanism
        m.box(5, 2, 9, 5, 2, 1, '#262d34'); m.box(9, 2, 9, 2, 2, 1, '#1c2228');   // lever
        // seat: fabric cushion on a dark shell, lit front roll
        m.rbox(-11, -9, 10, 22, 19, 4, 2, fabric(c.c1), MAT.SOFT);
        m.paint(-11, -9, 10, 22, 19, 1, c.c0);
        m.paint(-10, 8, 13, 20, 2, 1, c.c2, MAT.SOFT);
        // spine from under the seat to the backrest
        m.box(-2, -13, 8, 4, 9, 2, c.c3);
        m.box(-2, -14, 8, 4, 2, 11, c.c3);
        // backrest: dark shell + fabric cushion with side bolsters and a lumbar seam
        m.rbox(-11, -13, 14, 22, 2, 15, 3, c.c3);
        m.rbox(-10, -11, 15, 20, 2, 13, 3, fabric(c.c1), MAT.SOFT);
        m.box(-10, -9, 16, 2, 1, 10, c.c1, MAT.SOFT); m.box(8, -9, 16, 2, 1, 10, c.c1, MAT.SOFT);
        m.paint(-8, -10, 20, 16, 1, 1, c.c0, MAT.SOFT);
        m.paint(-8, -11, 26, 16, 2, 1, c.c2, MAT.SOFT);
        m.box(-3, -14, 21, 6, 1, 2, '#1c2228');                              // handle slot on the back
        m.paint(-9, -13, 27, 18, 1, 1, tone(c.c3, 1.3));                     // lit top rim of the shell
        // armrests: posts + pads
        [-1, 1].forEach(function (s) {
            var px = s < 0 ? -13 : 11, pd = s < 0 ? -14 : 10;
            m.box(s < 0 ? -11 : 5, -3, 9, 6, 2, 1, c.c3);
            m.box(px, -3, 9, 2, 2, 10, c.c3);
            m.rbox(pd, -7, 19, 4, 11, 2, 1, c.c0);
            m.paint(pd, -6, 20, 4, 9, 1, c.c2);
        });
        return m;
    });

    S.def('chair:boss', function () {
        var c = CH.boss, m = S.model(-19, -17, 19, 15, 34);
        var leather = function (base) { var a = C.rgb(base), b = tone(a, 1.05); return function (x, y, z) { return C.hash(x, y, z) > 0.8 ? b : a; }; };
        starBase(m, 13, 1, c.base, c.baseMat, 3.2);
        m.cyl(0, 0, 4, 2, 2, 3, '#1c1c1c');
        m.cyl(0, 0, 7, 1.5, 1.5, 3, c.piston, MAT.SHINY);
        m.box(-6, -6, 9, 12, 12, 1, '#1c1c1c');
        m.box(6, 2, 9, 5, 2, 1, '#1c1c1c'); m.box(10, 2, 9, 2, 2, 1, c.base, MAT.SHINY);
        // plush seat with a piped edge
        m.rbox(-14, -11, 10, 28, 22, 5, 2, leather(c.c1), MAT.SHINY);
        m.paint(-14, -11, 10, 28, 22, 1, c.c3);
        m.paint(-14, -11, 12, 28, 22, 1, c.c0);
        m.paint(-12, 9, 14, 24, 2, 1, c.c2, MAT.SHINY);
        // spine
        m.box(-3, -15, 8, 6, 10, 2, '#1c1c1c');
        m.box(-3, -16, 8, 6, 2, 9, '#1c1c1c');
        // high back: shell, channel-tufted cushion, wings, headrest
        m.rbox(-14, -16, 15, 28, 3, 14, 3, c.c0);
        m.rbox(-8, -16, 28, 16, 3, 5, 2, c.c0);
        m.rbox(-12, -13, 16, 24, 2, 12, 2, function (x, y, z) { return (z - 16) % 4 === 3 ? tone(c.c1, 0.86) : c.c1; }, MAT.SHINY);
        m.rbox(-7, -13, 29, 14, 2, 4, 2, c.c1, MAT.SHINY);
        m.paint(-6, -13, 31, 12, 2, 1, c.c2, MAT.SHINY);
        m.box(-14, -13, 16, 2, 2, 12, c.c0); m.box(12, -13, 16, 2, 2, 12, c.c0);           // wings
        m.paint(-14, -13, 27, 2, 2, 1, c.c2); m.paint(12, -13, 27, 2, 2, 1, c.c2);
        [[-6, 18], [0, 18], [6, 18], [-3, 22], [3, 22], [-6, 26], [0, 26], [6, 26]].forEach(function (b) {
            m.paint(b[0] - 1, -12, b[1], 2, 1, 1, c.c3);                    // buttons
        });
        m.paint(-11, -13, 27, 22, 1, 1, c.c2, MAT.SHINY);
        // the back of the shell: a stitched panel and a lit top roll
        var st = tone(c.c0, 1.22);
        m.paint(-10, -16, 18, 20, 1, 1, st); m.paint(-10, -16, 26, 20, 1, 1, st);
        m.paint(-11, -16, 18, 1, 1, 9, st); m.paint(10, -16, 18, 1, 1, 9, st);
        m.paint(-12, -16, 28, 24, 2, 1, tone(c.c0, 1.12));
        // padded arms on chrome posts
        [-1, 1].forEach(function (s) {
            var px = s < 0 ? -16 : 14, pd = s < 0 ? -18 : 13;
            m.box(s < 0 ? -15 : 6, -4, 9, 9, 2, 1, c.base, MAT.SHINY);
            m.box(px, -4, 9, 2, 2, 9, c.base, MAT.SHINY);
            m.rbox(pd, -10, 17, 5, 15, 3, 1, leather(c.c0), MAT.SHINY);
            m.paint(pd, -9, 19, 5, 13, 1, c.c2, MAT.SHINY);
        });
        return m;
    });

    S.def('chair:meeting', function () {
        var c = CH.desk, m = S.model(-12, -13, 12, 12, 28);
        starBase(m, 9, 1, '#2b333b', MAT.SOLID, 2.4);
        m.cyl(0, 0, 4, 2, 2, 4, '#262d34');
        m.cyl(0, 0, 8, 1.5, 1.5, 2, '#8d9aa4', MAT.SHINY);
        m.box(-4, -4, 9, 8, 8, 1, '#262d34');
        // seat
        m.rbox(-9, -8, 10, 18, 17, 4, 2, fabric(c.c1), MAT.SOFT);
        m.paint(-9, -8, 10, 18, 17, 1, c.c0);
        m.paint(-8, 7, 13, 16, 2, 1, c.c2, MAT.SOFT);
        // spine + mesh back in a frame
        m.box(-2, -11, 8, 4, 7, 2, c.c3);
        m.box(-2, -12, 8, 4, 2, 9, c.c3);
        m.rbox(-9, -12, 14, 18, 2, 13, 3, function (x, y, z) {
            if (x <= -8 || x >= 7 || z >= 25 || z <= 15) return c.c3;
            return (z + x) % 2 ? c.c0 : tone(c.c0, 0.85);
        }, MAT.SOFT);
        m.paint(-8, -12, 26, 16, 2, 1, tone(c.c3, 1.25));
        // slim arms
        [-1, 1].forEach(function (s) {
            var px = s < 0 ? -11 : 9;
            m.box(s < 0 ? -9 : 5, -2, 9, 4, 2, 1, c.c3);
            m.box(px, -2, 9, 2, 2, 9, c.c3);
            m.rbox(px, -7, 18, 2, 10, 2, 1, c.c0);
            m.paint(px, -6, 19, 2, 8, 1, c.c2);
        });
        return m;
    });

    // ---------- the meeting table ----------
    // top [36,40,168,52] z16 h5, legs inset at the corners; on the top: notepad +
    // pen [66,50,14,15], laptop (deck [104,79,32,7], lid [106,77,28,2] z21 h13,
    // screen +y), two mugs [48,70,6,6] / [186,70,6,6], plant pot [152,56,10,8].
    S.def('meetingTable', function () {
        var m = S.model(35, 39, 205, 93, 42);
        var top = '#a1887f', apron = '#6d4c41', leg = '#4e342e', legHi = '#6a4a40';
        // tapered legs with dark feet
        [[39, 43], [196, 43], [39, 84], [196, 84]].forEach(function (l) {
            m.box(l[0], l[1], 0, 5, 5, 16, function (x, y, z) {
                if (z <= 1) return '#3a2620';
                if (z < 8 && (x === l[0] || x === l[0] + 4) && (y === l[1] || y === l[1] + 4)) return null;   // taper
                return x === l[0] || y === l[1] + 4 ? legHi : leg;
            });
        });
        // apron (inset 2) and a low stretcher along the middle
        m.box(38, 42, 16, 164, 48, 3, apron);
        m.paint(38, 89, 16, 164, 1, 1, tone(apron, 0.88));
        m.box(40, 47, 4, 3, 37, 2, leg); m.box(197, 47, 4, 3, 37, 2, leg);   // H stretcher
        m.box(43, 65, 4, 154, 3, 2, leg);
        // the top: 2 px board, rounded corners, an inlay border
        var wt = woodTop(top, 36, 40, 204, 92, 20, 26);
        m.box(36, 40, 19, 168, 52, 2, function (x, y, z) {
            if (z === 20 && ((x === 40 || x === 199) && y >= 44 && y <= 87 || (y === 44 || y === 87) && x >= 40 && x <= 199)) return '#8d6e63';
            return wt(x, y, z);
        });
        [[36, 40], [203, 40], [36, 91], [203, 91]].forEach(function (p) { m.carve(p[0], p[1], 19, 1, 1, 2); });
        // cable port in the middle
        m.box(115, 58, 21, 10, 6, 1, '#37474f');
        m.paint(116, 59, 21, 8, 4, 1, '#455a64');
        m.box(117, 60, 21, 2, 2, 1, '#1c2429'); m.box(121, 60, 21, 2, 2, 1, '#1c2429');
        // notepad + pen
        m.box(66, 50, 21, 14, 15, 1, function (x, y) { return y > 52 && (y - 53) % 3 === 0 && x > 67 && x < 78 ? '#c9c1ad' : '#f5f1e6'; });
        m.box(66, 50, 21, 14, 2, 1, '#e57373');
        m.box(82, 51, 21, 2, 11, 1, '#1e66c8'); m.box(82, 60, 21, 2, 2, 1, '#eceff1', MAT.SHINY);
        // loose sheets
        m.box(86, 66, 21, 11, 14, 1, '#fafafa');
        m.paint(88, 68, 21, 7, 1, 1, '#b0bec5'); m.paint(88, 71, 21, 6, 1, 1, '#b0bec5'); m.paint(88, 74, 21, 7, 1, 1, '#b0bec5');
        // laptop: deck (keys + trackpad), lid with the screen toward +y
        m.rbox(104, 79, 21, 32, 7, 1, 1, '#90a4ae', MAT.SHINY);
        m.box(107, 79, 22, 26, 3, 1, function (x, y) { return (x + y) % 2 ? '#607d8b' : '#78909c'; });
        m.box(116, 83, 22, 8, 2, 1, '#a7b6be');
        m.box(106, 77, 21, 28, 2, 13, function (x, y, z) { return y === 77 ? (z === 33 ? '#607d8b' : '#546e7a') : (z === 33 ? '#455a64' : '#263238'); });
        m.box(108, 78, 23, 24, 1, 9, '#3d7fb0', MAT.SCREEN);
        m.paint(118, 77, 27, 4, 1, 3, '#cfd8dc');           // logo on the lid's back
        // mugs with coffee and handles
        [[48, 70], [186, 70]].forEach(function (p, i) {
            var cx = p[0] + 3, cy = p[1] + 3, mc = i ? '#eceff1' : '#ffcc80';
            m.cyl(cx, cy, 21, 3, 3, 6, mc);
            m.cyl(cx, cy, 26, 2, 2, 1, '#5d4037');
            m.box(p[0] + 6, cy - 1, 22, 2, 2, 4, mc); m.carve(p[0] + 6, cy - 1, 23, 1, 2, 2);
        });
        // plant
        plant(m, 152, 56, 10, 8, 21, 8, '#b5745a', '#3f8a45', '#5aa85a', 10);
        return m;
    });

    // ---------- the front desk ----------
    // body [-48,-12,96,28] z0 h26 (visitor side +y: panels + amber kick plate;
    // receptionist side -y: knee recess between two drawer pedestals), counter
    // top z26 h3, screen [-10,-1,22,2] z29 h14 facing the receptionist (-y),
    // sign-in book [-36,3,14,8], service bell [26,9,12,3].
    S.def('receptionDesk', function () {
        var m = S.model(-49, -14, 49, 17, 44);
        var body = '#795548', joint = '#6d4c41', reveal = '#8a6356', drawer = '#6d4c41', seam = '#5d4037';
        m.box(-47, -12, 0, 94, 27, 26, function (x, y, z) {
            if (y === 14 && z === 24) return reveal;                         // reveal under the top
            return body;
        });
        // vertical slats on the visitor side (7 px slats, 1 px grooves)
        m.paint(-47, 14, 4, 94, 1, 20, grainV(body));
        for (var gx = -40; gx <= 40; gx += 8) {
            m.carve(gx, 14, 4, 1, 1, 20);
            m.paint(gx, 13, 4, 1, 1, 20, tone(joint, 0.9));
        }
        m.paint(-47, 14, 4, 94, 1, 1, tone(body, 0.85));
        // amber kick plate wrapping the front corners
        m.box(-48, 12, 0, 96, 4, 4, function (x, y, z) { return z === 0 ? '#c68a00' : z === 3 ? '#ffd54f' : '#ffb300'; }, MAT.SHINY);
        // receptionist side: knee recess, tray, drawer pedestals
        m.carve(-20, -12, 0, 40, 14, 21);
        m.box(-20, -12, 19, 40, 4, 2, seam);
        m.box(-19, -13, 19, 38, 1, 2, joint);
        m.box(-6, -14, 19, 12, 1, 1, '#bcaaa4', MAT.SHINY);
        [-47, 20].forEach(function (px) {
            m.paint(px, -12, 1, 27, 1, 24, drawer);
            for (var d = 0; d < 3; d++) {
                var z0 = 2 + d * 7;
                m.paint(px + 1, -12, z0 + 6, 25, 1, 1, seam);
                m.box(px + 10, -13, z0 + 3, 7, 1, 1, '#bcaaa4', MAT.SHINY);
            }
            m.paint(px + 1, -12, 23, 25, 1, 1, tone(drawer, 1.1));
        });
        m.paint(-47, -12, 0, 94, 1, 1, seam);
        // counter top: 3 px with a darker edge band, overhanging 1 px front and back
        var wt = woodTop('#a1887f', -48, -13, 48, 16, 28, 18);
        m.box(-48, -13, 26, 96, 29, 3, function (x, y, z) { return z < 28 ? (z === 26 ? '#7b5c51' : '#8d6e63') : wt(x, y, z); });
        // screen [-10,-1,22,2] z32 h11 facing the receptionist (-y): built facing
        // +y, turned 180 into place
        var mon = S.model(-14, -8, 14, 4, 44);
        monitor(mon, { x0: -12, x1: 10, yb: -1, z0: 32, z1: 43, bez: 2, top: 2, chin: 2, frame: null,
            hump: [-8, 6, 34, 41], neck: [-2, 3], foot: [-5, -5, 9, 6], footZ: 29, led: true });
        m.put(mon, 0, 0, 0, 180);
        // a keyboard on the receptionist side
        keyboard(m, -9, -10, 20, 6, 29);
        // sign-in book (open) with a pen
        m.box(-37, 2, 29, 16, 10, 1, '#1e3a5f');
        m.box(-36, 3, 30, 14, 8, 1, function (x, y) {
            if (x === -29) return '#90a4ae';
            if ((y === 5 || y === 7 || y === 9) && x !== -36 && x !== -23 && x !== -30 && x !== -28) return '#b0bec5';
            return '#eceff1';
        });
        m.box(-20, 4, 29, 2, 7, 1, '#263238'); m.box(-20, 10, 29, 2, 1, 1, '#cfd8dc');
        // service bell on a wooden base
        m.cyl(32, 10.5, 29, 5.5, 4, 2, '#6d4c41');
        for (var k = 0; k < 5; k++) {
            var f = Math.sqrt(1 - Math.pow((k + 0.5) / 5, 2));
            m.cyl(32, 10.5, 31 + k, 4.8 * f, 3.8 * f, 1, k === 3 ? '#ffe082' : '#ffca28', MAT.SHINY);
        }
        m.box(31, 10, 35, 2, 2, 2, '#ffa000', MAT.SHINY);
        return m;
    });
})();
