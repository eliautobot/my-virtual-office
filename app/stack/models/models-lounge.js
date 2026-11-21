// Hand-built stack models (lounge): the L-couch, the straight couch, coffee and
// end tables, the TV on its media console, the floor lamp, the bookshelf, the
// two plants, the pet bed and bowl and the mesh waste bin. See stack/README.md.
// Every model is built at rotation 0 in the piece's FURNITURE_MANIFEST space
// (x right, y south = front, z up), base colours only (the renderer lights).
(function () {
    'use strict';
    var S = window.VOStack;
    if (!S || !S.def) return;
    var C = S.color, TX = S.tex, MAT = S.MAT;
    var hash = C.hash, tone = C.tone;

    // ---------- helpers ----------
    function safeHex(c, dflt) {
        return (typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim())) ? c.trim().toLowerCase() : dflt;
    }
    // Pick one of a list of colours per voxel (fine texture with a weight for the first).
    function pick(list, seed) {
        return function (x, y, z) { return list[Math.floor(hash(x, y, z + (seed || 0)) * list.length)]; };
    }
    // Horizontal cylinder along y (sofa arm rolls).
    function rollY(m, cx, cz, r, y0, y1, c, mat) {
        for (var z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
            var dx = x + 0.5 - cx, dz = z + 0.5 - cz;
            if (dx * dx + dz * dz <= r * r) for (var y = y0; y < y1; y++) m.set(x, y, z, c, mat);
        }
    }
    // Any solid given by a point test over a bounding box: fn(x, y, z) -> colour | null.
    function solid(m, x0, y0, z0, x1, y1, z1, fn, mat) {
        for (var z = Math.floor(z0); z <= Math.ceil(z1); z++) for (var y = Math.floor(y0); y <= Math.ceil(y1); y++) for (var x = Math.floor(x0); x <= Math.ceil(x1); x++) {
            var c = fn(x + 0.5, y + 0.5, z + 0.5, x, y, z);
            if (c != null) m.set(x, y, z, c, mat);
        }
    }
    // A puffy throw pillow (square-ish face, fat middle) standing at (cx, cy, cz),
    // turned by yaw, leaning back by tilt (radians). colour fn gets (u, w) in -1..1.
    function pillow(m, cx, cy, cz, a, b, t, yaw, tilt, col, mat) {
        var cyw = Math.cos(yaw), syw = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
        var R = Math.max(a, b) + t + 1;
        solid(m, cx - R, cy - R, cz - R, cx + R, cy + R, cz + R, function (px, py, pz) {
            var dx = px - cx, dy = py - cy, dz = pz - cz;
            var u = dx * cyw + dy * syw, f = -dx * syw + dy * cyw;           // across, forward (unturned)
            var v = f * ct + dz * st, w = -f * st + dz * ct;                 // thickness, up the face (top leans back)
            var U = u / a, W = w / b;
            var e = Math.pow(Math.abs(U), 4) + Math.pow(Math.abs(W), 4);
            if (e > 1) return null;
            var mx = Math.max(Math.abs(U), Math.abs(W)), th = Math.max(1.15, t * (1 - 0.55 * mx * mx));
            if (Math.abs(v) > th) return null;
            return col(U, W);
        }, mat);
    }
    // A leaf as a ribbon swept along a drooping curve: base (bx, by, bz), heading
    // yaw, pitch p0 at the stem to p1 at the tip, length len, half width hw.
    // pal: { base, rib, edge, under }. The edges cup up a little.
    function leaf(m, bx, by, bz, yaw, p0, p1, len, hw, pal, cup) {
        var n = Math.max(6, Math.ceil(len * 2.5)), step = len / n;
        var cy = Math.cos(yaw), sy = Math.sin(yaw), vx = -sy, vy = cy;
        var x = bx, y = by, z = bz;
        cup = cup == null ? 0.9 : cup;
        for (var i = 0; i <= n; i++) {
            var s = i / n, ph = p0 + (p1 - p0) * s;
            var hx = Math.cos(ph) * cy, hy = Math.cos(ph) * sy, hz = Math.sin(ph);
            if (i) { x += hx * step; y += hy * step; z += hz * step; }
            var wp = s < 0.12 ? 0.3 : Math.sin(Math.PI * Math.pow((s - 0.12) / 0.88, 0.8));
            var w = Math.max(0.45, hw * wp);
            var steep = Math.abs(hz) > 0.55;
            for (var t = -w; t <= w + 0.001; t += 0.5) {
                var rel = Math.abs(t) / (hw + 0.001);
                var X = Math.floor(x + vx * t), Y = Math.floor(y + vy * t), Z = Math.floor(z + rel * rel * cup * hw * 0.5);
                var col = (Math.abs(t) < 0.5 && s > 0.08 && s < 0.85) ? pal.rib : rel > 0.72 ? pal.edge : pal.base;
                m.set(X, Y, Z, col, MAT.SOFT);
                if (!m.has(X, Y, Z - 1)) m.set(X, Y, Z - 1, pal.under, MAT.SOFT);
                if (steep) { var bx2 = Math.floor(x + vx * t - cy * 0.8), by2 = Math.floor(y + vy * t - sy * 0.8); if (!m.has(bx2, by2, Z)) m.set(bx2, by2, Z, pal.under, MAT.SOFT); }
            }
        }
        return [x, y, z];
    }
    function leafPal(base) {
        return { base: base, rib: tone(base, 1.16), edge: tone(base, 0.9), under: tone(base, 0.78) };
    }
    // Foliage as lit leaf clumps (round from every side) with pointed leaf
    // tips breaking the silhouette. ring() lays n clumps round a centre; a
    // clump is { x, y, z, r, rz, g (palette index), a (heading), tips }.
    function ring(list, cx, cy, z, r, n, size, rz, g0, g1, seed, phase, tips) {
        for (var i = 0; i < n; i++) {
            var a = phase + i * Math.PI * 2 / n + (hash(seed, i, 1) - 0.5) * 0.5;
            var rr = r + (hash(seed, i, 2) - 0.5) * 1.4;
            list.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr, z: z + (hash(seed, i, 3) - 0.5) * 1.8,
                        r: size + (hash(seed, i, 4) - 0.5) * 0.8, rz: rz, g: i % 2 ? g1 : g0, a: a, tips: tips });
        }
        return list;
    }
    function canopy(m, list, greens, seed, tipLen) {
        list.forEach(function (L, k) {
            var base = C.rgb(greens[Math.min(greens.length - 1, L.g)]), lo = tone(base, 0.84), hi = tone(base, 1.16);
            m.ellipsoid(L.x, L.y, L.z, L.r, L.r, L.rz, function (x, y, z) {
                var n = hash(x, y, z + k * 7);
                if (z + 0.5 > L.z + L.rz * 0.3) return n < 0.3 ? base : hi;
                return n < 0.4 ? lo : base;
            }, MAT.SOFT);
        });
        list.forEach(function (L, k) {
            for (var j = 0; j < L.tips; j++) {
                var ya = L.a + (j ? 0.6 : -0.5) + (hash(seed, k, j + 9) - 0.5) * 0.4;
                var gi = Math.min(greens.length - 1, L.g + (j ? 1 : 0));
                leaf(m, L.x, L.y, L.z + 0.6, ya, 0.3, -0.75, L.r + (tipLen || 2.6), 1.6, leafPal(greens[gi]), 0.2);
            }
        });
    }
    // Plant sway: the higher the slice, the more it moves; a rustle while a click plays.
    function swayAnim(lo) {
        return function (spec, item, t, ctx) {
            var rx = ctx && ctx.rx, ph = (item.x || 0) * 0.1 + (item.y || 0) * 0.05;
            var rus = rx && rx.t >= 0 ? (1 - rx.t) : 0;
            spec.sway = function (k, n) {
                var f = lo ? Math.max(0, (k - lo) / Math.max(1, n - lo)) : k / n;
                var a = Math.sin(t * 1.3 + ph) * 0.6 * Math.pow(f, 2);
                var b = 0;
                if (rus) { a += Math.sin(rx.t * Math.PI * 9) * 1.3 * rus * f; b = (Math.floor(rx.t * 8) % 2 ? 0 : 0.8) * f; }
                return [a, b];
            };
        };
    }
    function droppedLeaf(rx) { return !!(rx && rx.held && (rx.t < 0 || rx.t > 0.6)); }

    // Even out the side faces: a turned stack shows its side faces as a staircase
    // of slice edges, i.e. the voxels 1-2 px inside a face too, which the baked
    // AO makes 6-12 % darker (vertical stripes on flat sides). Lift those inner
    // rows by the same amount (unseen straight on, even at an angle).
    function evenFaces(m) {
        var w = m.w, d = m.d, h = m.h, v = m.v, out = new Uint32Array(v);
        function e(x, y, z) { return x < 0 || y < 0 || x >= w || y >= d || !v[x + w * (y + d * z)]; }
        for (var z = 0; z < h; z++) for (var y = 0; y < d; y++) for (var x = 0; x < w; x++) {
            var i = x + w * (y + d * z), c = v[i];
            if (!c || (c >>> 24) === MAT.EMIT || (c >>> 24) === MAT.SCREEN) continue;
            if (z + 1 >= h || !v[i + w * d]) continue;                                   // top surface: leave
            if (e(x - 1, y, z) || e(x + 1, y, z) || e(x, y - 1, z) || e(x, y + 1, z)) continue;   // the face itself
            var k = 0;
            if (e(x - 2, y, z) || e(x + 2, y, z) || e(x, y - 2, z) || e(x, y + 2, z)) k = 1.07;
            else if (e(x - 3, y, z) || e(x + 3, y, z) || e(x, y - 3, z) || e(x, y + 3, z)) k = 1.13;
            if (!k) continue;
            var r = Math.min(255, Math.round((c & 255) * k)), g = Math.min(255, Math.round(((c >>> 8) & 255) * k)), b = Math.min(255, Math.round(((c >>> 16) & 255) * k));
            out[i] = (r | (g << 8) | (b << 16) | (c & 0xff000000)) >>> 0;
        }
        m.v = out;
        return m;
    }
    // Register a model: every build goes through evenFaces.
    function def(type, build, key, opts) {
        S.def(type, function (item, ctx) { return evenFaces(build(item, ctx)); }, key, opts);
    }

    // ---------- sofas ----------
    // One build for the L-couch (back along the top and down the right side, an
    // arm on the left, the daybed under the right end) and the straight couch
    // (back, two arms): legs, a plinth, back frame, rolled arms with piped
    // scrolls, tufted back cushions and boxed seat cushions with front piping,
    // two throw pillows.
    function sofaPalette(c) {
        return {
            cush: TX.speckle(tone(c, 1.08), 0.04),
            back: TX.speckle(tone(c, 1.0), 0.04),
            frame: TX.speckle(tone(c, 0.8), 0.035),
            arm: TX.speckle(tone(c, 0.86), 0.035),
            plinth: tone(c, 0.64),
            pipe: tone(c, 0.62),
            seam: tone(c, 0.7),
            leg: TX.wood('#4a332b', { axis: 'y' }), foot: '#2e211c'
        };
    }
    function sofaArm(m, x0, P) {
        m.box(x0, 6, 3, 8, 34, 10, P.arm, MAT.SOFT);
        rollY(m, x0 + 4, 14, 4, 6, 40, P.arm, MAT.SOFT);
        // the scroll on the front of the roll: a piped ring and a darker panel under it
        solid(m, x0, 39, 9, x0 + 8, 39, 18, function (px, py, pz) {
            var d = Math.hypot(px - (x0 + 4), pz - 14);
            return d >= 2.5 && d <= 3.7 ? P.pipe : null;
        });
        m.paint(x0, 39, 3, 8, 1, 7, P.frame);
        m.paint(x0 + 1, 39, 4, 6, 1, 1, P.seam);
    }
    function seatCushion(m, x, y, w, d, P, leftPipe) {
        m.rbox(x, y, 9, w, d, 5, 2, P.cush, MAT.SOFT);
        m.paint(x, y, 11, 1, d, 3, P.seam); m.paint(x + w - 1, y, 11, 1, d, 3, P.seam);   // the seams between cushions
        m.paint(x, y + d - 1, 12, w, 1, 1, P.pipe);
        m.paint(x, y + d - 2, 13, w, 1, 1, P.pipe);
        if (leftPipe) { m.paint(x, y, 12, 1, d, 1, P.pipe); m.paint(x + 1, y, 13, 1, d, 1, P.pipe); }
    }
    function backCushionS(m, x, w, P) {          // along the back, facing +y
        m.rbox(x, 6, 9, w, 6, 15, 3, P.back, MAT.SOFT);
        m.rbox(x + 1, 11, 12, w - 2, 2, 10, 2, P.back, MAT.SOFT);             // the plump middle
        m.paint(x, 6, 9, 1, 7, 15, P.seam); m.paint(x + w - 1, 6, 9, 1, 7, 15, P.seam);
        var cx = x + w / 2;
        m.paint(Math.round(cx - 8), 12, 16, 2, 1, 2, P.seam);                 // tufting buttons
        m.paint(Math.round(cx + 6), 12, 16, 2, 1, 2, P.seam);
    }
    function backCushionW(m, y, d, P) {           // down the right side, facing -x
        m.rbox(148, y, 9, 6, d, 15, 3, P.back, MAT.SOFT);
        m.rbox(147, y + 1, 12, 2, d - 2, 10, 2, P.back, MAT.SOFT);
        var cy = y + d / 2;
        m.paint(147, Math.round(cy - 8), 16, 1, 2, 2, P.seam);
        m.paint(147, Math.round(cy + 6), 16, 1, 2, 2, P.seam);
    }
    function stripePillow(base, stripe) {
        var b = C.rgb(base), s = C.rgb(stripe), edge = tone(base, 0.84);
        return function (U, W) {
            if (Math.pow(Math.abs(U), 4) + Math.pow(Math.abs(W), 4) > 0.8) return edge;
            return Math.abs(W) > 0.22 && Math.abs(W) < 0.48 ? s : b;
        };
    }
    function plainPillow(base) {
        var b = C.rgb(base), edge = tone(base, 0.82), mid = tone(base, 1.05);
        return function (U, W) {
            if (Math.pow(Math.abs(U), 4) + Math.pow(Math.abs(W), 4) > 0.8) return edge;
            return Math.abs(U) < 0.15 && Math.abs(W) < 0.15 ? mid : b;
        };
    }
    function buildSofa(item, L) {
        var c = L ? safeHex(item.couchColor, '#3f51b5') : '#68717a';
        var P = sofaPalette(c), len = L ? 160 : 168;
        var m = S.model(-2, -2, len + 2, L ? 80 : 44, 28);
        // little legs
        var legs = L ? [[1, 1], [78, 1], [156, 1], [1, 35], [58, 35], [116, 35], [121, 73], [156, 73]]
                     : [[1, 1], [82, 1], [164, 1], [1, 35], [82, 35], [164, 35]];
        legs.forEach(function (p) { m.box(p[0], p[1], 0, 3, 3, 3, P.leg); m.box(p[0], p[1], 0, 3, 3, 1, P.foot); });
        // plinth (the seat base, 1 px in under the cushions' front)
        m.box(0, 0, 3, len, 39, 6, P.plinth);
        m.paint(0, 38, 8, len, 1, 1, P.pipe);
        if (L) { m.box(120, 39, 3, 40, 38, 6, P.plinth); m.paint(120, 39, 8, 1, 38, 1, P.pipe); m.paint(120, 76, 8, 40, 1, 1, P.pipe); }
        // back frame
        m.rbox(0, 0, 3, len, 6, 22, 3, P.frame, MAT.SOFT);
        if (L) m.rbox(154, 0, 3, 6, 78, 22, 3, P.frame, MAT.SOFT);
        // arms
        sofaArm(m, 0, P);
        if (!L) sofaArm(m, 160, P);
        // cushions
        var cush = L ? [[8, 35], [43, 35], [78, 35], [113, 35]] : [[8, 38], [46, 38], [84, 38], [122, 38]];
        cush.forEach(function (q) { backCushionS(m, q[0], q[1], P); });
        if (L) { backCushionW(m, 6, 34, P); backCushionW(m, 40, 37, P); }
        cush.forEach(function (q) { seatCushion(m, q[0], 12, q[1], 28, P, false); });
        if (L) seatCushion(m, 120, 40, 28, 38, P, true);
        // throw pillows
        if (L) {
            pillow(m, 14.5, 15.5, 19.5, 6, 6, 2.4, 0.3, 0.38, stripePillow('#efe4cf', '#d9774b'), MAT.SOFT);
            pillow(m, 141, 16.5, 19.5, 6, 6, 2.4, -0.35, 0.38, plainPillow('#efe4cf'), MAT.SOFT);
        } else {
            pillow(m, 14.5, 15.5, 19.5, 6, 6, 2.4, 0.3, 0.38, plainPillow('#e0a63a'), MAT.SOFT);
            pillow(m, 153.5, 15.5, 19.5, 6, 6, 2.4, -0.3, 0.38, stripePillow('#e7dcc6', '#4f8a8b'), MAT.SOFT);
        }
        return m;
    }
    def('couch', function (item) { return buildSofa(item, true); },
        function (item) { return safeHex(item.couchColor, '#3f51b5'); });
    def('engLounge', function (item) { return buildSofa(item, false); });

    // ---------- coffee table ----------
    // Plan y 4..28, top z 9..13: a wood slab on tapered legs with a low shelf
    // (two books), a magazine, the remote and a mug on top.
    def('coffeeTable', function () {
        var m = S.model(-1, 2, 65, 30, 20);
        var wood = TX.wood('#8d6e63'), dark = '#4e342e';
        [[1, 5], [60, 5], [1, 24], [60, 24]].forEach(function (p) {
            m.box(p[0], p[1], 2, 3, 3, 7, dark);
            m.box(p[0] + (p[0] < 30 ? 1 : 0), p[1] + (p[1] < 15 ? 1 : 0), 0, 2, 2, 2, dark);
        });
        m.box(3, 7, 2, 58, 18, 2, TX.wood('#7b584c'));                        // low shelf
        m.box(10, 10, 4, 14, 10, 2, '#3f6fa8'); m.paint(10, 19, 4, 14, 1, 2, '#f1ead8'); m.paint(10, 10, 5, 14, 10, 1, '#4a7db8');
        m.box(11, 11, 6, 12, 8, 2, '#b23b3b'); m.paint(11, 18, 6, 12, 1, 2, '#f1ead8'); m.paint(11, 11, 7, 12, 8, 1, '#c44a45');
        m.box(40, 9, 4, 12, 12, 3, '#c9a36a');                                 // a woven basket
        m.paint(40, 9, 4, 12, 12, 3, TX.checker('#c9a36a', '#a98250', 2)); m.carve(41, 10, 6, 10, 10, 1);
        m.box(1, 5, 9, 62, 22, 2, '#5d4037');                                  // apron
        m.rbox(0, 4, 11, 64, 24, 2, 1, wood);                                  // top
        // magazine (lying flat), remote, mug
        m.box(7, 8, 13, 14, 16, 1, '#e3f2fd');
        m.paint(9, 10, 13, 10, 6, 1, '#1976d2'); m.paint(11, 11, 13, 4, 3, 1, '#ffca28');
        m.paint(9, 18, 13, 10, 1, 1, '#90a4ae'); m.paint(9, 20, 13, 7, 1, 1, '#90a4ae');
        m.box(31, 14, 13, 12, 5, 2, '#212121'); m.set(33, 15, 14, '#f44336'); m.set(34, 15, 14, '#f44336');
        m.paint(37, 15, 14, 4, 3, 1, TX.checker('#424242', '#616161', 1));
        m.cyl(52.5, 12.5, 13, 2.6, 2.6, 5, '#eceff1', MAT.SHINY);
        m.cyl(52.5, 12.5, 17, 1.6, 1.6, 1, '#5d4037');
        m.box(55, 12, 14, 2, 2, 3, '#eceff1'); m.carve(55, 12, 15, 1, 2, 1);
        return m;
    });

    // ---------- end table ----------
    // Plan y -6..14, top z 10..13 with a drawer, a lower shelf, and a little
    // potted plant on top (plan [3, 5, 14, 3], 16 high).
    def('endTable', function (item, ctx) {
        var m = S.model(-2, -9, 22, 16, 34);
        var dark = '#4e342e';
        [[1, -5], [16, -5], [1, 11], [16, 11]].forEach(function (p) { m.box(p[0], p[1], 0, 3, 3, 10, dark); });
        m.box(2, -4, 2, 16, 15, 2, TX.wood('#7b584c'));                        // lower shelf
        m.box(5, -2, 4, 9, 7, 2, '#5c7c99'); m.paint(5, 4, 4, 9, 1, 2, '#f1ead8');
        m.box(1, -5, 8, 18, 18, 3, '#6d4c41');                                 // apron + drawer
        m.paint(3, 12, 8, 14, 1, 2, '#7e5a4c'); m.box(9, 13, 8, 2, 1, 2, '#c9a227', MAT.SHINY);
        m.rbox(0, -6, 11, 20, 20, 2, 1, TX.wood('#8d6e63'));                   // top
        // the pot: terracotta with a lighter rim and soil
        m.cone(10, 4, 13, 3.4, 4.3, 6, TX.speckle('#b5745a', 0.05));
        m.cyl(10, 4, 18, 5, 5, 2, '#c98b70');
        m.cyl(10, 4, 19, 3.8, 3.8, 1, '#4e3b2f');
        var G = ['#2f6a34', '#3f8a45', '#4f9a50', '#5aa85a', '#86c47a'], L = [];
        m.ellipsoid(10, 4, 21.5, 3.6, 3.6, 2.6, G[0], MAT.SOFT);
        ring(L, 10, 4, 21, 3.5, 5, 2.7, 1.9, 0, 1, 31, 0.3, 1);
        ring(L, 10, 4, 23.6, 1.5, 3, 2.4, 1.8, 2, 3, 32, 0.9, 1);
        L.push({ x: 10.3, y: 3.8, z: 25.8, r: 2.0, rz: 1.6, g: 4, a: 0, tips: 0 });
        canopy(m, L, G, 31, 2.0);
        void item; void ctx;
        return m;
    }, null, { animate: swayAnim(17) });

    // ---------- TV on its media console ----------
    // Console 50 x 11 x 11 (doors, a cubby with a set-top box), the screen on
    // a neck above it, its +y face MAT.SCREEN, a soundbar in front.
    def('tv', function (item, ctx) {
        var m = S.model(-1, 20, 51, 36, 42);
        var on = !!(ctx && ctx.rx && ctx.rx.state > 0);
        var body = TX.wood('#6d4c41'), door = TX.wood('#5d4037', { axis: 'z' });
        // legs + body + top
        [[1, 24], [46, 24], [1, 31], [46, 31]].forEach(function (p) { m.box(p[0], p[1], 0, 3, 3, 2, '#3e2723'); });
        m.box(1, 23, 2, 48, 11, 6, body);
        m.box(0, 22, 8, 50, 13, 2, TX.wood('#8d6e63'));
        // doors (front face y 33) with frames and handles; the middle cubby
        m.paint(2, 33, 3, 16, 1, 4, door); m.paint(32, 33, 3, 16, 1, 4, door);
        m.paint(3, 33, 4, 14, 1, 2, '#654338'); m.paint(33, 33, 4, 14, 1, 2, '#654338');
        m.box(15, 34, 4, 2, 1, 2, '#bcaaa4', MAT.SHINY); m.box(33, 34, 4, 2, 1, 2, '#bcaaa4', MAT.SHINY);
        m.carve(19, 26, 3, 12, 8, 5);
        m.box(19, 26, 2, 12, 8, 1, '#4e342e');
        m.box(20, 27, 3, 10, 6, 2, '#263238'); m.box(28, 32, 4, 1, 1, 1, '#66bb6a', MAT.EMIT); m.box(21, 32, 4, 4, 1, 1, '#37474f');
        // the screen: foot, neck, back housing, bezel, glass
        m.box(16, 25, 10, 18, 6, 1, '#263238', MAT.SHINY);
        m.box(22, 26, 11, 6, 2, 3, '#263238');
        m.box(9, 24, 15, 32, 3, 17, '#20282d');
        m.box(3, 27, 12, 44, 3, 25, '#1b2125', MAT.SHINY);
        m.paint(3, 27, 36, 44, 3, 1, '#3a4248');
        m.paint(3, 29, 12, 1, 1, 25, '#2a3238');
        // glass: dark with a faint diagonal glare (the shader draws the picture when on)
        m.box(5, 28, 14, 40, 2, 21, function (x, y, z) {
            var g = (x - 5) + (z - 14);
            return g >= 26 && g <= 31 ? '#2a3542' : '#1c2530';
        }, MAT.SCREEN);
        m.box(42, 29, 12, 2, 1, 1, on ? '#4fc3f7' : '#ef5350', MAT.EMIT);  // standby LED
        // soundbar
        m.rbox(12, 31, 10, 26, 3, 3, 1, TX.checker('#2b3238', '#353d44', 1));
        return m;
    }, function (item, ctx) { return ctx && ctx.rx && ctx.rx.state > 0 ? 'on' : 'off'; });

    // ---------- floor lamp ----------
    // A weighted base, a slim pole and a pleated drum shade open at the top
    // (the bulb shows inside); the shade is MAT.EMIT so it glows at night.
    def('floorLamp', function (item, ctx) {
        var off = !!(ctx && ctx.rx && ctx.rx.state === 1);
        var m = S.model(-10, -9, 10, 11, 36);
        var cx = 0, cy = 1;
        m.cyl(cx, cy, 0, 6, 6, 1, '#2f393f', MAT.SHINY);
        m.cone(cx, cy, 1, 5.6, 4, 2, '#3e4a51', MAT.SHINY);
        m.box(cx - 1, cy - 1, 3, 2, 2, 19, '#6d7a82', MAT.SHINY);
        m.box(cx - 1, cy - 1, 11, 2, 2, 1, '#8a979e', MAT.SHINY);           // a joint collar
        m.box(cx - 1, cy - 1, 20, 2, 2, 5, '#8a979e', MAT.SHINY);           // socket
        var shade = off ? ['#aeb0ab', '#a2a49e'] : ['#f3e2b6', '#e9d5a8'];
        var mat = off ? MAT.SOFT : MAT.EMIT;
        var z0 = 21, h = 13;
        for (var k = 0; k < h; k++) {
            var r = 8.2 - 3 * k / (h - 1);
            solid(m, cx - r - 1, cy - r - 1, z0 + k, cx + r + 1, cy + r + 1, z0 + k, function (px, py) {
                var d = Math.hypot(px - cx, py - cy);
                if (d > r || d < r - 2.1) return null;
                if (k === 0) return off ? '#83857e' : '#ffe9b0';                // warm rim
                if (k === h - 1) return off ? '#c0c2bc' : '#f5e4b8';
                var a = Math.atan2(py - cy, px - cx);
                return shade[Math.floor((a + Math.PI) / (Math.PI * 2) * 18) % 2];
            }, mat);
        }
        m.ellipsoid(cx, cy, 27, 2.3, 2.3, 2.8, off ? '#d8d8d0' : '#ffe8a8', off ? MAT.SHINY : MAT.EMIT);
        return m;
    }, function (item, ctx) { return ctx && ctx.rx && ctx.rx.state === 1 ? 'off' : 'on'; });

    // ---------- bookshelf ----------
    // Plan [0, 58, 50, 16], 53 high: sides, top, plinth, back panel, three
    // shelves of varied books (heights, widths, colours, a leaning one, a lying
    // stack), a gold trophy, a small succulent on top. Click: the third book
    // of the middle row is pulled out.
    var BOOK_COLS = ['#e57373', '#c62828', '#64b5f6', '#1e5aa8', '#fff176', '#f9a825', '#81c784', '#2e7d32',
                     '#ce93d8', '#7b1fa2', '#ff8a65', '#4dd0e1', '#a1887f', '#37474f', '#f5f5f5', '#ffb74d'];
    function book(m, x, z, w, h, dep, col, front, seed) {
        var c0 = C.rgb(col), dk = tone(c0, 0.82), lt = tone(c0, 1.22);
        m.box(x, front - dep, z, w, dep, h, c0);
        m.paint(x, front - 1, z + h - 3, w, 1, 1, lt);                         // title band
        if (h > 9) m.paint(x, front - 1, z + 2, w, 1, 1, dk);                 // tail band
        if (hash(seed, 3, 5) > 0.5 && w >= 3) m.paint(x + 1, front - 1, z + 4, w - 2, 1, Math.max(1, h - 9), tone(c0, 1.1));
        if (w >= 3) m.paint(x + 1, front - dep + 1, z + h - 1, w - 2, dep - 2, 1, '#f3ead2');   // pages from above
    }
    function tiltBook(m, xp, z0, w, h, dep, ang, col, front) {
        var ca = Math.cos(ang), sa = Math.sin(ang), c0 = C.rgb(col), lt = tone(c0, 1.22);
        solid(m, xp - h, front - dep, z0, xp + w + 1, front - 1, z0 + h + 1, function (px, py, pz) {
            var dx = px - xp, dz = pz - z0;
            var u = dx * ca + dz * sa, v = -dx * sa + dz * ca;
            if (u < 0 || u > w || v < 0 || v > h) return null;
            if (py > front - 1 && v > h - 3 && v <= h - 2) return lt;
            return v > h - 1 && u > 1 && u < w - 1 && py > front - dep + 1 && py < front - 1 ? '#f3ead2' : c0;
        });
    }
    def('bookshelf', function (item, ctx) {
        var pulled = !!(ctx && ctx.rx && ctx.rx.state === 1);
        var m = S.model(-1, 56, 51, 82, 62);
        var frame = TX.wood('#8d6e63', { axis: 'z' }), shelfW = TX.wood('#8d6e63'), back = TX.speckle('#5d4037', 0.04);
        m.box(0, 58, 0, 3, 16, 53, frame); m.box(47, 58, 0, 3, 16, 53, frame);
        m.box(0, 57, 50, 50, 17, 3, TX.wood('#9a7a6e'));
        m.paint(0, 73, 50, 50, 1, 1, '#a1887f');
        m.box(3, 58, 0, 44, 15, 4, '#6d4c41'); m.box(3, 72, 0, 44, 2, 4, null); m.carve(3, 72, 0, 44, 2, 3);
        m.box(3, 58, 4, 44, 2, 46, back);
        [4, 19, 34].forEach(function (z) { m.box(3, 60, z, 44, 14, 2, shelfW); m.paint(3, 73, z, 44, 1, 2, '#a1887f'); });
        // rows: bottom (z 6), middle (z 21), top (z 36)
        var rows = [{ z: 6, h: 13, end: 46 }, { z: 21, h: 13, end: 46 }, { z: 36, h: 14, end: 34 }];
        var pullBook = null;
        rows.forEach(function (row, r) {
            var x = 4, i = 0, seedR = 11 + r * 7;
            while (x < row.end - 1) {
                var a = hash(seedR, i, 1), b = hash(seedR, i, 2), c = hash(seedR, i, 3);
                // the bottom row ends in a stack of books lying flat
                if (r === 0 && x >= 33) {
                    var lz = row.z;
                    [['#1e5aa8', 11], ['#f9a825', 10], ['#7b1fa2', 9]].forEach(function (L, j) {
                        m.box(x + j % 2, 62, lz, L[1], 10, 2, L[0]);
                        m.paint(x + j % 2, 71, lz, L[1], 1, 2, tone(L[0], 1.2));
                        lz += 2;
                    });
                    break;
                }
                // the middle row: a leaning book after the fourth
                if (r === 1 && i === 5) {
                    tiltBook(m, x + 2, row.z, 3, row.h - 3, 10, 0.42, '#4dd0e1', 72);
                    x += 9; i++; continue;
                }
                var w = 2 + Math.floor(a * 3.2);
                var h = row.h - 1 - Math.floor(b * 4);
                var dep = 10 + Math.floor(c * 3);
                var col = BOOK_COLS[Math.floor(hash(seedR, i, 4) * BOOK_COLS.length)];
                var front = 73 - Math.floor(hash(seedR, i, 6) * 2);
                if (r === 1 && i === 2) {
                    pullBook = [x, row.z, w + 1, h, dep, col];
                    if (pulled) { m.box(x, 60, row.z, w + 1, 2, 1, '#3e2723'); x += w + 1; i++; continue; }
                    w += 1;
                }
                if (x + w > row.end) w = row.end - x;
                if (w >= 2) book(m, x, row.z, w, h, dep, col, front, i + r * 31);
                x += w + (hash(seedR, i, 7) > 0.82 ? 1 : 0);
                i++;
            }
        });
        if (pulled && pullBook) {                                              // slid out towards you, tipped down a little
            var pb = pullBook;
            tiltBook(m, pb[0], pb[1], pb[2], pb[3], pb[4], 0, pb[5], 80);
            m.paint(pb[0], 79, pb[1] + pb[3] - 3, pb[2], 1, 1, tone(pb[5], 1.22));
        }
        // gold trophy on the top shelf
        m.box(37, 63, 36, 7, 6, 2, '#4e342e');
        m.box(39, 65, 38, 3, 2, 3, '#e0a800', MAT.SHINY);
        m.cone(40.5, 66, 41, 1.8, 3.4, 5, '#ffca28', MAT.SHINY);
        m.carve(39, 65, 45, 3, 2, 1);
        m.box(35, 65, 42, 2, 2, 3, '#ffca28', MAT.SHINY); m.box(44, 65, 42, 2, 2, 3, '#ffca28', MAT.SHINY);
        // a small succulent on top
        m.cyl(9.5, 66, 53, 3, 3, 4, '#eceff1');
        m.cyl(9.5, 66, 56, 2.2, 2.2, 1, '#4e3b2f');
        m.ellipsoid(9.5, 66, 58, 3.2, 3.2, 2.4, pick(['#6a9e7a', '#7fb38e', '#5b8a6a'], 4), MAT.SOFT);
        m.ellipsoid(9.5, 66, 60, 1.6, 1.6, 1.4, '#9fd0a8', MAT.SOFT);
        return m;
    }, function (item, ctx) { return ctx && ctx.rx && ctx.rx.state === 1 ? 'pulled' : ''; });

    // ---------- plant (small) ----------
    // A white glazed pot (plan centre 9, 13) with a lush round bush of lit
    // leaf clumps and pointed tips; it sways, rustles on a click and drops a
    // leaf over the rim (held look).
    def('plant', function (item, ctx) {
        var m = S.model(-4, 0, 22, 27, 28);
        var cx = 9, cy = 13;
        m.cone(cx, cy, 0, 5.8, 7, 9, TX.speckle('#f2f3f4', 0.03), MAT.SHINY);
        m.cyl(cx, cy, 0, 5.6, 5.6, 1, '#b8bdc1');
        m.cyl(cx, cy, 8, 7.6, 7.6, 2, '#ffffff', MAT.SHINY);
        m.cyl(cx, cy, 9, 6.2, 6.2, 1, '#4e3b2f');
        m.paint(cx - 8, cy - 8, 4, 16, 16, 1, function (x, y) {           // a thin blue band round the pot
            return '#9fb8c8';
        });
        var G = ['#2f6a34', '#3f8a45', '#4f9a50', '#5aa85a', '#86c47a'], L = [];
        m.ellipsoid(cx, cy, 12, 5.2, 5.2, 4, G[0], MAT.SOFT);
        ring(L, cx, cy, 11.2, 5.3, 7, 3.6, 2.4, 0, 1, 7, 0.2, 2);
        ring(L, cx, cy, 14.6, 2.6, 4, 3.4, 2.4, 2, 3, 8, 0.7, 1);
        L.push({ x: cx + 0.4, y: cy - 0.3, z: 17.6, r: 2.8, rz: 2.1, g: 4, a: 0, tips: 0 });
        canopy(m, L, G, 7, 2.2);
        if (droppedLeaf(ctx && ctx.rx)) leaf(m, cx + 5, cy + 4, 10, 0.9, -0.2, -1.2, 6, 1.8, leafPal('#9ccc65'), 0.3);
        return m;
    }, function (item, ctx) { return droppedLeaf(ctx && ctx.rx) ? 'drop' : ''; }, { animate: swayAnim(8) });

    // ---------- tall plant ----------
    // A banded terracotta pot on a saucer (plan centre 9, 39) and a tall leafy
    // ficus: three trunks inside five staggered rings of leaf clumps, round
    // from every side; sways, rustles and drops a leaf like the small plant.
    def('tallPlant', function (item, ctx) {
        var m = S.model(-8, 22, 27, 56, 66);
        var cx = 9, cy = 39;
        m.cyl(cx, cy, 0, 7.6, 7.6, 1, '#8a5240');
        m.cone(cx, cy, 1, 6.6, 8, 12, function (x, y, z) {
            var c = z % 4 === 0 ? '#a8664e' : '#b5745a';
            return hash(x, y, z) < 0.15 ? tone(c, 0.94) : c;
        });
        m.cyl(cx, cy, 12, 9.2, 9.2, 3, TX.speckle('#c98b70', 0.04));
        m.paint(cx - 10, cy - 10, 14, 20, 20, 1, '#dda588');
        m.cyl(cx, cy, 14, 7.6, 7.6, 1, TX.speckle('#4e3b2f', 0.08));
        var trunk = TX.speckle('#5d4a32', 0.08);
        var trunks = [[cx - 1, cy - 1, 15, cx - 3, cy - 3, 44], [cx + 1, cy, 15, cx + 2, cy - 1, 48], [cx, cy + 1, 15, cx + 1, cy + 3, 40]];
        trunks.forEach(function (T) { m.line([T[0], T[1], T[2]], [T[3], T[4], T[5]], 1, trunk); });
        var greens = ['#3d5e34', '#4f7942', '#5b8a4a', '#6b9452', '#8fb26b'], L = [];
        m.ellipsoid(cx - 0.5, cy - 0.5, 34, 5.2, 5.2, 14, greens[0], MAT.SOFT);
        ring(L, cx, cy, 21.5, 6.2, 6, 4.0, 2.6, 0, 1, 21, 0.1, 2);
        ring(L, cx - 0.5, cy - 0.5, 28.5, 6.8, 6, 4.3, 2.7, 1, 2, 22, 0.6, 2);
        ring(L, cx - 1, cy - 1, 36, 6.0, 6, 4.1, 2.6, 2, 3, 23, 0.05, 2);
        ring(L, cx - 1, cy - 1.5, 43, 4.4, 5, 3.9, 2.5, 3, 2, 24, 0.7, 1);
        ring(L, cx - 1, cy - 1.5, 48.5, 1.6, 3, 3.2, 2.3, 4, 3, 25, 0.3, 0);
        canopy(m, L, greens, 21, 3.0);
        if (droppedLeaf(ctx && ctx.rx)) leaf(m, cx + 6, cy + 5, 15, 0.8, -0.15, -1.3, 7, 2, leafPal('#aed581'), 0.3);
        return m;
    }, function (item, ctx) { return droppedLeaf(ctx && ctx.rx) ? 'drop' : ''; }, { animate: swayAnim(15) });

    // ---------- pet bed ----------
    // An oval bolster bed (plan 30 x 18): a rounded rim higher at the back,
    // a cream cushion in the hollow, a seam round the crest.
    def('petBed', function () {
        var m = S.model(-1, -1, 31, 19, 9);
        var cx = 15, cy = 9, rx = 15, ry = 9, IN = 0.6;
        var rim = TX.speckle('#b4533b', 0.05), inner = '#9c4632', cushion = TX.speckle('#e9dcbc', 0.05);
        solid(m, 0, 0, 0, 30, 18, 8, function (px, py, pz) {
            var dx = (px - cx) / rx, dy = (py - cy) / ry, rho = Math.sqrt(dx * dx + dy * dy);
            if (rho > 1) return null;
            if (rho < IN) {
                var hc = 2.6 + 0.9 * (1 - rho / IN);
                if (pz > hc) return null;
                return rho > IN - 0.07 ? '#d8c8a2' : cushion;
            }
            var s = (rho - IN) / (1 - IN), back = Math.max(0, Math.min(1, (cy - py) / ry + 0.3));
            var H = (5 + 2.2 * back) * Math.sqrt(Math.max(0, 1 - Math.pow(2 * s - 1, 2) * 0.72));
            if (pz > H) return null;
            if (pz > H - 1 && Math.abs(s - 0.5) < 0.12) return '#cf6a4e';       // seam on the crest
            return s < 0.3 && pz > 2 ? inner : rim;
        }, MAT.SOFT);
        m.paint(0, 0, 0, 30, 18, 1, '#7e3524');
        return m;
    });

    // ---------- pet bowl ----------
    // A blue double-diner (plan 20 x 8) with two steel bowls: kibble and water.
    def('petBowl', function () {
        var m = S.model(-1, -2, 21, 10, 6);
        m.rbox(0, -1, 0, 20, 10, 4, 2, TX.speckle('#4a7db8', 0.03));
        m.paint(0, -1, 0, 20, 10, 1, '#2f5785');
        [[5, 'kibble'], [15, 'water']].forEach(function (b) {
            var bx = b[0], by = 4;
            m.cyl(bx, by, 3, 3.4, 3.4, 1, function (x, y) {                 // the steel rim round each hollow
                return Math.hypot(x + 0.5 - bx, y + 0.5 - by) > 2.6 ? '#93a4ad' : null;
            });
            m.cyl(bx, by, 3, 2.6, 2.6, 1, null);
            m.cyl(bx, by, 2, 2.6, 2.6, 1, '#23426a');
            if (b[1] === 'kibble') {
                m.cyl(bx, by, 2, 2.3, 2.3, 1, pick(['#9a5a26', '#c98a45', '#7c4519', '#b06f33'], 2));
                m.box(bx - 1, by - 1, 3, 2, 2, 1, pick(['#9a5a26', '#c98a45', '#b06f33'], 3));
            } else {
                m.cyl(bx, by, 2, 2.3, 2.3, 1, '#7fc6ee', MAT.SHINY);
                m.set(bx - 1, by - 2, 2, '#d4f0ff', MAT.SHINY); m.set(bx, by - 2, 2, '#d4f0ff', MAT.SHINY);
            }
        });
        m.paint(0, 8, 1, 20, 1, 2, '#3f6ea6');                                  // a darker band round the foot
        m.paint(9, 3, 3, 2, 2, 1, '#e8c547');                                   // a paw-print tag between the bowls
        return m;
    });

    // ---------- waste bin ----------
    // A wire-mesh bin (centre 0, 6) with solid bands at the rim and foot,
    // crumpled paper inside (seen through the mesh) and a paper ball on top.
    // Click: the ball hops out onto the floor, next click back in.
    function binK(rx) { return !rx ? 0 : rx.t >= 0 ? (rx.state === 1 ? rx.t : 1 - rx.t) : rx.state; }
    def('trashCan', function (item, ctx) {
        var m = S.model(-9, -1, 14, 21, 22);
        var cx = 0, cy = 8, H = 13, paperTop = 8;
        var k = Math.round(binK(ctx && ctx.rx) * 6) / 6;
        solid(m, cx - 8, cy - 8, 0, cx + 8, cy + 8, H - 1, function (px, py, pz, x, y, z) {
            var r = 5.4 + 1.5 * z / (H - 1), d = Math.hypot(px - cx, py - cy);
            if (d > r) return null;
            if (z < 1) return '#2c3337';
            if (d < r - 2.0) return null;
            if (z >= H - 2) return z === H - 1 ? '#8e9ba2' : '#6b787f';            // rim band
            if (z <= 1) return '#56626a';                                        // foot band
            var u = Math.floor((Math.atan2(py - cy, px - cx) + Math.PI) * 6.4);
            var wire = ((u + z) % 4 === 0) || (((u - z) % 4 + 4) % 4 === 0);
            if (wire) return '#6a777e';
            return z >= paperTop - 3 && z < paperTop && hash(u, z, 3) > 0.55 ? '#cfc8b8' : '#232a2e';
        }, MAT.SHINY);
        m.cyl(cx, cy, 1, 4.6, 4.6, paperTop - 1, '#e8e3d6');
        var crumple = pick(['#f4f1ea', '#f4f1ea', '#d6d0c2', '#e6e0d2'], 5);
        m.ellipsoid(cx - 2, cy + 1.5, paperTop, 2.4, 2.4, 2.0, crumple);
        m.ellipsoid(cx + 2.2, cy - 1.2, paperTop + 0.4, 2.2, 2.2, 2.0, crumple);
        m.ellipsoid(cx + 1.6, cy + 2.4, paperTop - 0.4, 1.9, 1.9, 1.7, pick(['#fff59d', '#fdd835'], 6));
        // the paper ball: in the bin (k 0) or on the floor beside it (k 1), a hop in between
        var bx = cx - 1 + k * 9, by = cy - 1 + k * 6, bz = (paperTop + 2.6) * (1 - k) + 2 * k + Math.sin(k * Math.PI) * 7;
        m.ellipsoid(bx, by, bz, 2.1, 2.1, 2.0, pick(['#fbf8f1', '#fbf8f1', '#d6d0c2'], 8));
        return m;
    }, function (item, ctx) { return 'b' + Math.round(binK(ctx && ctx.rx) * 6); });
})();
