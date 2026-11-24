// Hand-built stack models (misc): filing cabinet, whiteboard, dart board,
// ping-pong table, wall pieces (windows, clock, notice board) and the text
// labels / branch signs. See stack/README.md for the conventions.
//
// Wall pieces (window, interactiveWindow, clock, noticeBoard and labels on
// the back wall) are built wall-style: local x = classic art x, local z =
// minus the classic art y (art row r -> z -r), local y = 0..3 out of the
// wall face (y 0 touches the wall).
(function () {
    'use strict';
    var S = window.VOStack;
    var C = S.color, MAT = S.MAT;
    function tone(c, k) { return C.tone(c, k); }

    // ---------- shared helpers ----------
    // A box given by a classic wall-art rect (x, y, w, h) at depth y0 .. y0 + d.
    function wbox(m, ax, ay, aw, ah, y0, d, c, mat) { return m.box(ax, y0, -(ay + ah - 1), aw, d, ah, c, mat); }
    function wpaint(m, ax, ay, aw, ah, y, c, mat) { return m.paint(ax, y, -(ay + ah - 1), aw, 1, ah, c, mat); }
    function wcarve(m, ax, ay, aw, ah, y0, d) { return m.carve(ax, y0, -(ay + ah - 1), aw, d, ah); }
    // A disc facing +y (axis along y) centred on the corner (cx, cz), radius r,
    // y0 .. y0 + d. col: colour or fn(dx, dz, rho, angleDeg from 12 o'clock, clockwise).
    function discY(m, cx, cz, y0, d, r, col, mat) {
        var R = Math.ceil(r);
        for (var iz = -R; iz < R; iz++) for (var ix = -R; ix < R; ix++) {
            var dx = ix + 0.5, dz = iz + 0.5, rho = Math.sqrt(dx * dx + dz * dz);
            if (rho > r) continue;
            var c = col;
            if (typeof col === 'function') {
                var ang = Math.atan2(dx, dz) * 180 / Math.PI; if (ang < 0) ang += 360;
                c = col(dx, dz, rho, ang);
            }
            if (c == null) continue;
            for (var k = 0; k < d; k++) m.set(cx + ix, y0 + k, cz + iz, c, mat);
        }
        return m;
    }
    // Calm label colour, as the classic _labelDisplayColor: saturation <= 60 %, lightness >= 68 %.
    var _calm = {};
    function calmColor(c) {
        if (_calm[c]) return _calm[c];
        var mm = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
        if (!mm) return (_calm[c] = '#f3ead8');
        var n = parseInt(mm[1], 16), rr = (n >> 16 & 255) / 255, gg = (n >> 8 & 255) / 255, bb = (n & 255) / 255;
        var mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb), l = (mx + mn) / 2, d = mx - mn, sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0, hue = 0;
        if (d) { hue = mx === rr ? ((gg - bb) / d) % 6 : mx === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4; hue *= 60; if (hue < 0) hue += 360; }
        var s2 = Math.min(sat, 0.6), l2 = Math.max(l, 0.68);
        var cc = (1 - Math.abs(2 * l2 - 1)) * s2, xx = cc * (1 - Math.abs((hue / 60) % 2 - 1)), m0 = l2 - cc / 2;
        var rgb = hue < 60 ? [cc, xx, 0] : hue < 120 ? [xx, cc, 0] : hue < 180 ? [0, cc, xx] : hue < 240 ? [0, xx, cc] : hue < 300 ? [xx, 0, cc] : [cc, 0, xx];
        return (_calm[c] = '#' + rgb.map(function (v) { return ('0' + Math.round((v + m0) * 255).toString(16)).slice(-2); }).join(''));
    }
    function safeHex(c, fb) { return /^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : fb; }
    function rxState(ctx) { return ctx && ctx.rx ? (ctx.rx.state | 0) : 0; }

    // =====================================================================
    // FILING CABINET  plan [0, 25, 28, 24], z 0..36. Click: drawer 1, 2, 3 open, then all shut.
    // =====================================================================
    var FC = { steel: '#93a7b1', drawer: '#a2b5bf', plinth: '#4a575e', gap: '#5c6d76', inside: '#36434a', brass: '#c9a227', brassL: '#e8c547', card: '#f5f1e6', ink: '#5c7c99' };
    var FC_DZ = [24, 13, 2];   // drawer bottoms: top, middle, bottom (10 tall each)
    function fcDrawerFront(m, dz, y, idx) {
        m.material(MAT.SHINY);
        m.box(3, y, dz, 22, 2, 10, FC.drawer);
        // decals go 2 deep (both rows of the front) so a turned stack never shows the row behind
        m.paint(3, y, dz + 9, 22, 2, 1, tone(FC.drawer, 1.1));             // lit top lip
        m.paint(3, y, dz, 22, 2, 1, tone(FC.drawer, 0.84));                // shaded bottom lip
        m.paint(9, y, dz + 2, 10, 2, 4, tone(FC.drawer, 0.9));             // the handle's backplate
        m.box(10, y + 2, dz + 3, 8, 1, 2, FC.brass);                        // pull handle
        m.paint(10, y + 2, dz + 4, 8, 1, 1, FC.brassL);
        m.material(MAT.SOLID);
        if (idx === 0) {                                                    // label card (the classic top drawer)
            m.paint(8, y, dz + 6, 12, 2, 3, FC.card);
            m.paint(9, y, dz + 7, 8, 2, 1, FC.ink);
        } else {
            m.paint(11, y, dz + 6, 6, 2, 2, FC.card);
        }
    }
    S.def('filingCabinet', function (item, ctx) {
        var open = rxState(ctx);            // 0 shut, 1..3 = that drawer (1 = top) pulled open
        var m = S.model(-1, 24, 29, 62, 37);
        m.material(MAT.SHINY);
        m.box(1, 26, 0, 26, 21, 2, FC.plinth);                              // recessed kick plinth
        m.box(0, 25, 2, 28, 22, 33, FC.steel);                              // carcass y 25..46, z 2..34
        m.box(0, 47, 2, 3, 1, 33, FC.steel); m.box(25, 47, 2, 3, 1, 33, FC.steel);   // front stiles
        m.box(0, 25, 35, 28, 24, 1, tone(FC.steel, 1.08));                  // top cap, flush with the drawer fronts
        m.paint(0, 48, 35, 28, 1, 1, tone(FC.steel, 1.16));
        m.material(MAT.SOLID);
        m.paint(3, 46, 2, 22, 1, 33, FC.gap);                               // the dark seams between drawers
        for (var i = 0; i < 3; i++) {
            var dz = FC_DZ[i];
            if (open === i + 1) {
                // pulled out 8 px: a tray with 2 px walls, hanging folders with tabs
                m.carve(3, 45, dz, 22, 4, 10);
                m.paint(3, 44, dz, 22, 1, 10, FC.inside);
                m.material(MAT.SHINY);
                m.box(3, 45, dz, 22, 11, 9, tone(FC.drawer, 0.92));
                m.material(MAT.SOLID);
                m.carve(5, 45, dz + 2, 18, 10, 8);
                m.paint(5, 45, dz + 1, 18, 10, 1, FC.inside);               // the tray floor
                var folders = [[46, '#f5f1e6', 5], [49, '#e0a23a', 11], [52, '#cfe0ea', 16]];
                for (var f = 0; f < folders.length; f++) {
                    var fy = folders[f][0];
                    m.box(5, fy, dz + 2, 18, 2, 6, tone(folders[f][1], 0.92));
                    m.box(folders[f][2], fy, dz + 8, 6, 2, 2, folders[f][1]);   // the tab
                }
                fcDrawerFront(m, dz, 55, i);
            } else {
                fcDrawerFront(m, dz, 47, i);
            }
        }
        return m;
    }, function (item, ctx) { return 'd' + rxState(ctx); });

    // =====================================================================
    // WHITEBOARD  board plan [0, 36, 28, 2] z 7..38, legs [0, 23, 28, 20] z 0..12.
    // Click: 1 = a diagram, 2 = wiped clean.
    // =====================================================================
    var WB = { alu: '#a9b5bc', face: '#f4f7f8', back: '#b8c3c9', brace: '#a3afb6', leg: '#90a4ae', caster: '#3f4b52', tray: '#b0bec5',
               blue: '#1e66c8', red: '#c62828', green: '#2e7d32', grey: '#90a4ae', smudge: '#e2e8eb' };
    // classic board art (x, row) -> voxel (x, z 37 - row) on the face rows y 37..38 (2 deep:
    // a turned stack never shows the row behind)
    function wbInk(m, x, r, w, h, c) { m.paint(x, 37, 37 - (r + h - 1), w, 2, h, c); }
    function wbNote(m, x, r, c) {
        m.paint(x, 38, 37 - (r + 5), 6, 1, 6, c);
        m.box(x, 39, 37 - (r + 5), 6, 1, 6, c);
        m.paint(x + 1, 38, 37 - (r + 2), 4, 2, 1, tone(c, 0.72));
        m.paint(x + 1, 38, 37 - (r + 4), 3, 2, 1, tone(c, 0.72));
        m.paint(x + 5, 38, 37 - (r + 5), 1, 2, 1, tone(c, 0.86));          // a curled corner
    }
    S.def('whiteboard', function (item, ctx) {
        var st = rxState(ctx);
        var m = S.model(-1, 22, 29, 45, 40);
        // legs: an A-frame at each end on casters, a spreader bar
        [4, 22].forEach(function (lx) {
            m.line([lx + 0.5, 38, 10], [lx + 0.5, 41, 2], 1, WB.leg, MAT.SHINY);
            m.line([lx + 0.5, 36.5, 10], [lx + 0.5, 25.5, 2], 1, WB.leg, MAT.SHINY);
            m.line([lx + 0.5, 30, 5], [lx + 0.5, 39.5, 5], 1, tone(WB.leg, 1.1), MAT.SHINY);
            m.box(lx - 1, 39, 0, 4, 4, 2, WB.caster);
            m.box(lx - 1, 23, 0, 4, 4, 2, WB.caster);
            m.paint(lx - 1, 39, 1, 4, 4, 1, tone(WB.caster, 1.25));
            m.paint(lx - 1, 23, 1, 4, 4, 1, tone(WB.caster, 1.25));
        });
        // the board: an aluminium frame standing 1 px proud round the white face
        m.material(MAT.SHINY);
        m.box(0, 35, 7, 28, 5, 31, WB.alu);
        m.paint(0, 35, 37, 28, 5, 1, tone(WB.alu, 1.14));
        m.paint(0, 35, 7, 28, 5, 1, tone(WB.alu, 0.86));
        m.material(MAT.SOLID);
        m.carve(2, 39, 9, 24, 1, 27);
        m.paint(2, 37, 9, 24, 2, 27, WB.face);
        // the plain back with braces (seen at 180)
        m.paint(2, 35, 9, 24, 2, 27, WB.back);
        m.paint(2, 35, 22, 24, 2, 2, WB.brace); m.paint(13, 35, 9, 2, 2, 27, WB.brace);
        // what is on the board
        if (st === 1) {
            var boxes = [[4, 5, WB.blue], [16, 5, WB.green], [10, 18, WB.red]];
            boxes.forEach(function (b) { wbInk(m, b[0], b[1], 7, 5, b[2]); m.paint(b[0] + 1, 37, 37 - (b[1] + 3), 5, 1, 3, WB.face); });
            wbInk(m, 11, 7, 5, 1, '#546e7a'); wbInk(m, 7, 10, 1, 11, '#546e7a'); wbInk(m, 8, 20, 2, 1, '#546e7a');
            wbInk(m, 19, 10, 1, 11, '#546e7a'); wbInk(m, 17, 20, 2, 1, '#546e7a');
            wbNote(m, 4, 22, '#ffe066');
        } else if (st === 2) {
            wbInk(m, 5, 7, 10, 2, WB.smudge); wbInk(m, 11, 15, 11, 2, WB.smudge); wbInk(m, 6, 22, 6, 1, WB.smudge);
        } else {
            wbInk(m, 4, 4, 13, 2, WB.blue); wbInk(m, 4, 6, 8, 1, WB.blue);                 // a heading
            wbInk(m, 4, 9, 2, 2, WB.red); wbInk(m, 7, 10, 9, 1, WB.red);                  // a list
            wbInk(m, 4, 12, 2, 2, WB.red); wbInk(m, 7, 13, 7, 1, WB.red);
            wbInk(m, 4, 15, 2, 2, WB.green); wbInk(m, 7, 16, 10, 1, WB.green);
            wbInk(m, 16, 26, 8, 1, WB.grey); wbInk(m, 16, 19, 1, 8, WB.grey);              // a little bar chart
            wbInk(m, 17, 24, 2, 2, WB.blue); wbInk(m, 19, 22, 2, 4, WB.blue); wbInk(m, 21, 19, 2, 7, WB.blue);
            wbNote(m, 19, 3, '#ffe066');                                                    // sticky notes
            wbNote(m, 5, 20, '#ff9ec4');
        }
        // marker tray with three markers
        m.material(MAT.SHINY);
        m.box(3, 39, 6, 22, 4, 2, WB.tray);
        m.box(3, 42, 8, 22, 1, 1, tone(WB.tray, 1.08));
        m.material(MAT.SOLID);
        [[6, '#d32f2f'], [12, '#1976d2'], [18, '#388e3c']].forEach(function (mk) {
            m.box(mk[0], 39, 8, 4, 2, 2, mk[1]);
            m.box(mk[0] + 3, 39, 8, 1, 2, 2, '#eceff1');
        });
        return m;
    }, function (item, ctx) { return 's' + rxState(ctx); });

    // =====================================================================
    // DART BOARD  (x, y) = board centre; a 34 px cabinet board on a tripod.
    // Click: one more amber dart per click, the third in the bull.
    // =====================================================================
    var DB_ZC = 42;                // the board's centre height (corner between z 41 and 42)
    function dbDart(m, ox, oy, flight, barrel) {
        var x = Math.round(ox), z = DB_ZC - 1 - Math.round(oy);
        m.box(x - 1, 44, z - 1, 2, 2, 2, barrel || '#cfd8dc', MAT.SHINY);           // barrel, rising a little
        m.box(x - 1, 46, z, 2, 2, 2, barrel || '#cfd8dc', MAT.SHINY);
        m.box(x - 2, 48, z, 4, 3, 2, flight);                                        // the flight: a 4 x 4 cross
        m.box(x - 1, 48, z - 1, 2, 3, 4, flight);
        m.paint(x - 1, 50, z, 2, 1, 2, tone(flight, 0.8));
    }
    S.def('dartBoard', function (item, ctx) {
        var rd = Math.max(0, Math.min(3, rxState(ctx)));
        var m = S.model(-22, 28, 22, 54, 62);
        var steel = '#5f6b72', foot = '#323d43';
        // tripod: two legs splayed forward-out, one back; a hub and a mast behind the board
        m.material(MAT.SHINY);
        m.line([-4, 39.5, 24], [-17.5, 46, 1], 1, steel);
        m.line([4, 39.5, 24], [17.5, 46, 1], 1, steel);
        m.line([0, 38, 24], [0, 32.5, 1], 1, steel);
        m.box(-3, 36, 21, 6, 5, 4, tone(steel, 0.85));
        m.box(-2, 37, 25, 4, 2, 22, tone(steel, 0.9));
        m.material(MAT.SOLID);
        m.box(-20, 45, 0, 5, 3, 2, foot); m.box(15, 45, 0, 5, 3, 2, foot); m.box(-2, 31, 0, 4, 3, 2, foot);
        // cabinet backboard with a raised dark rim
        m.box(-17, 39, 25, 34, 3, 34, S.tex.wood('#6d4c41', { axis: 'y' }));
        m.box(-17, 42, 25, 34, 1, 34, '#4e342e');
        m.carve(-15, 42, 27, 30, 1, 30);
        m.paint(-17, 42, 58, 34, 1, 1, '#6d4c41');
        // the sisal board: 20 segments, double and treble rings, bull
        var dark = '#262222', cream = '#efe3c8', red = '#c62828', green = '#2e7d32';
        discY(m, 0, DB_ZC, 42, 2, 14.2, function (dx, dz, rho, ang) {
            // 16 segments (cleaner than 20 at this size), 12 o'clock centred on a dark one
            if (rho > 12.6) return Math.abs(((ang + 11.25) % 22.5) - 11.25) < 2.6 && rho > 13 ? '#cfc6b0' : dark;   // number ring marks
            if (rho <= 1.2) return red;
            if (rho <= 2.4) return green;
            var seg = Math.floor(((ang + 11.25) % 360) / 22.5), even = seg % 2 === 0;
            if (rho > 10.6) return even ? red : green;
            if (rho > 7.4) return even ? dark : cream;
            if (rho > 5.4) return even ? red : green;
            return even ? dark : cream;
        });
        // darts: two resting in the board, the click ones (amber flights)
        dbDart(m, 8, 6, '#1e88e5', '#37474f');
        dbDart(m, -8, -7, '#e53935', '#37474f');
        var spots = [[-5, 5], [6, -3], [0, 0]];
        for (var i = 0; i < rd; i++) dbDart(m, spots[i][0], spots[i][1], '#ffb300');
        return m;
    }, function (item, ctx) { return 'r' + rxState(ctx); });

    // =====================================================================
    // PING-PONG TABLE  (x, y) = centre of the plan: top [-46, -20, 92, 44] z 16..21,
    // legs z 0..16, net [-1, -21, 3, 46] z 21..25 (here 2 px thick).
    // =====================================================================
    S.def('pingPongTable', function () {
        var m = S.model(-48, -24, 48, 28, 27);
        var top = '#2f7546', apron = '#1f5130', line = '#f2f2ec', leg = '#3e4a51';
        // legs (3 x 3) at the ends and the middle, stretchers front to back, rubber feet
        m.material(MAT.SHINY);
        [-43, -2, 40].forEach(function (lx) {
            [-17, 19].forEach(function (ly) {
                m.box(lx, ly, 0, 3, 3, 16, leg);
                m.paint(lx, ly, 0, 3, 3, 2, '#1d2428');
            });
            m.box(lx, -14, 5, 3, 33, 2, tone(leg, 1.08));
        });
        m.box(-40, 1, 9, 80, 2, 2, tone(leg, 1.08));                        // a long bar under the middle
        m.material(MAT.SOLID);
        // apron ring and the top
        m.box(-44, -18, 16, 88, 40, 2, apron);
        m.carve(-42, -16, 16, 84, 36, 2);
        m.box(-46, -20, 18, 92, 44, 3, function (x, y, z) {
            if (z < 20) return apron;
            var edge = x <= -45 || x >= 44 || y <= -19 || y >= 22;
            if (edge) return line;
            if (y === 1) return C.mix(top, line, 0.6);
            return C.hash(x, y, 3) < 0.08 ? tone(top, 1.05) : top;
        });
        m.paint(-46, -20, 19, 92, 1, 1, tone(line, 0.92));                 // the white top edge, seen on the sides too
        m.paint(-46, 23, 19, 92, 1, 1, tone(line, 0.92));
        m.paint(-46, -20, 19, 1, 44, 1, tone(line, 0.92));
        m.paint(45, -20, 19, 1, 44, 1, tone(line, 0.92));
        // net: white tape on a grey mesh, clamp posts at both sides
        m.box(-1, -20, 21, 2, 44, 4, function (x, y, z) {
            if (z === 24) return '#f6f6f0';
            return ((y + z) % 3 === 0) ? '#8f989d' : '#d5d9d6';
        });
        m.material(MAT.SHINY);
        m.box(-2, -23, 15, 4, 3, 11, '#5f6b72'); m.box(-2, 24, 15, 4, 3, 11, '#5f6b72');
        m.paint(-2, -23, 25, 4, 3, 1, '#78868d'); m.paint(-2, 24, 25, 4, 3, 1, '#78868d');
        m.material(MAT.SOLID);
        // a resting paddle (red rubber on a wood blade) and a ball
        m.cyl(26, 14.5, 21, 4.6, 4.6, 1, '#a1785c');
        m.cyl(26, 14.5, 22, 4.0, 4.0, 1, '#c62828');
        m.box(30, 13, 21, 6, 3, 2, '#8d6e63');
        m.paint(30, 13, 22, 6, 1, 1, '#a1887f');
        m.ellipsoid(-28.5, 12.5, 22.5, 1.7, 1.7, 1.7, '#fafaf4');
        return m;
    });

    // =====================================================================
    // WINDOW (wall): glass 36 x 40 at art (0, 0), frame -3..39, sill below.
    // =====================================================================
    S.def('window', function () {
        var m = S.model(-5, 0, 41, 8, 5, -46);
        var frame = '#d9d3c8', sill = '#e8e4dc';
        // frame: 3 px wide, 3 deep, with a stepped inner moulding
        wbox(m, -3, -3, 42, 46, 0, 4, frame);
        wcarve(m, 0, 0, 36, 40, 0, 4);
        wcarve(m, -1, -1, 38, 42, 3, 1);
        m.material(MAT.GLASS);
        wbox(m, 0, 0, 36, 40, 0, 2, '#d4ecfa');                             // 2 deep: no see-through when turned
        for (var g = 0; g < 5; g++) wbox(m, 26 - g * 2, 3 + g * 2, 2, 2, 0, 2, '#ffffff');      // glints
        wbox(m, 6, 24, 2, 2, 0, 2, '#ffffff'); wbox(m, 8, 22, 2, 2, 0, 2, '#ffffff');
        m.material(MAT.SOLID);
        wpaint(m, -3, -3, 42, 1, 3, tone(frame, 1.08));
        // mullions (a cross), flush with the frame
        wbox(m, 17, 0, 2, 40, 0, 4, frame);
        wbox(m, 0, 19, 36, 2, 0, 4, frame);
        wbox(m, 16, 18, 4, 4, 0, 4, tone(frame, 0.95));
        // sill: 44 wide, standing out 5 px, a shaded underside
        wbox(m, -4, 41, 44, 4, 0, 6, sill);
        wpaint(m, -4, 41, 44, 1, 5, tone(sill, 1.06));
        wpaint(m, -4, 41, 44, 1, 4, tone(sill, 1.06));
        m.paint(-4, 0, -44, 44, 6, 1, tone(sill, 0.82));
        return m;
    }, null, { mount: 'wall' });

    // =====================================================================
    // INTERACTIVE WINDOW (wall): glass 36 x 44 at art (0, 0); a grey casing, a
    // white frame with a cross pane and hub, a deep sill. The glass shows the
    // sky of the hour, rain and stars (shader).
    // =====================================================================
    S.def('interactiveWindow', function () {
        var m = S.model(-5, 0, 41, 8, 5, -50);
        var casing = '#a3a3a3', frame = '#e6e6e6', cross = '#f7f7f7', hub = '#cfcfcf', sill = '#c2c2c2';
        // casing (outer ledge) 2 deep, x -4..39, art y -4..47
        wbox(m, -4, -4, 44, 52, 0, 3, S.tex.speckle(casing, 0.05));
        // white frame, 4 deep, art -2..37 x -2..45
        wbox(m, -2, -2, 40, 48, 0, 5, frame);
        wpaint(m, -2, -2, 40, 1, 4, tone(frame, 1.06));
        wcarve(m, 0, 0, 36, 44, 0, 5);
        wcarve(m, -1, -1, 38, 46, 4, 1);                                    // a stepped inner edge
        m.material(MAT.GLASS);
        wbox(m, 0, 0, 36, 44, 0, 2, '#d4ecfa');                             // 2 deep: no see-through when turned
        wbox(m, 2, 2, 5, 3, 0, 2, '#ffffff'); wbox(m, 3, 5, 3, 2, 0, 2, '#ffffff');      // shine
        wbox(m, 23, 27, 4, 3, 0, 2, '#f0f8ff');
        m.material(MAT.SOLID);
        // cross panes (3 px) and the hub
        wbox(m, 17, 0, 3, 44, 0, 4, cross);
        wbox(m, 0, 21, 36, 3, 0, 4, cross);
        wbox(m, 16, 20, 5, 5, 0, 5, hub);
        // bottom sill: deep, a lit top, a shaded underside
        wbox(m, -3, 46, 42, 3, 0, 7, sill);
        wpaint(m, -3, 46, 42, 1, 6, tone(sill, 1.1));
        wpaint(m, -3, 46, 42, 1, 5, tone(sill, 1.1));
        m.paint(-3, 0, -48, 42, 7, 1, tone(sill, 0.8));
        return m;
    }, null, { mount: 'wall' });

    // =====================================================================
    // CLOCK (wall): (x, y) = centre. A dark case, a recessed cream face, four
    // hour bars, 2 px hands showing the time (like the classic clock: rebuilt
    // each minute in the dynamic pool). Click: a cuckoo door, the bird pops out.
    // =====================================================================
    function clockHand(m, angDeg, len, c) {
        var a = (angDeg - 90) * Math.PI / 180;           // screen angle (0 = 3 o'clock, y down)
        for (var i = 1; i <= len; i++) {
            var px = Math.round(Math.cos(a) * i), py = Math.round(Math.sin(a) * i);
            m.box(px - 1, 3, -py, 2, 1, 2, c);           // art rows py-1, py -> z -py+1, -py
        }
    }
    S.def('clock', function (item, ctx) {
        var rx = ctx && ctx.rx, up = -1;
        if (rx && (rx.t >= 0 || rx.held)) up = rx.t >= 0 ? Math.round(rx.t * 2) : 2;
        var m = S.model(-15, 0, 15, 8, 16, -15);
        var cz = 1;   // the centre corner (art rows -1 | 0)
        // (faces seen from the front sit >= 2 voxels in front of solid, so the baked normal points +y)
        discY(m, 0, cz, 0, 3, 13.6, '#4f5b62', MAT.SHINY);                 // case
        discY(m, 0, cz, 3, 1, 13.6, function (dx, dz, rho) { return rho > 10.6 ? (dz > 0 && dx < 4 ? '#6b7880' : '#56636a') : null; }, MAT.SHINY);  // bezel
        discY(m, 0, cz, 1, 2, 10.6, function (dx, dz, rho) {             // face (2 deep)
            if (rho > 7.4 && rho < 8.8) {
                var ang = Math.atan2(dx, dz) * 180 / Math.PI; if (ang < 0) ang += 360;
                if (Math.abs(((ang + 15) % 30) - 15) < 3.2) return '#a1887f';    // minute marks
            }
            return rho > 9.6 ? '#e6dfcf' : '#f4efe3';
        });
        // hour bars at 12, 3, 6, 9 (raised 1)
        var bar = '#5d4037';
        wbox(m, -1, -9, 2, 3, 3, 1, bar); wbox(m, -1, 7, 2, 3, 3, 1, bar);
        wbox(m, -9, -1, 3, 2, 3, 1, bar); wbox(m, 7, -1, 3, 2, 3, 1, bar);
        if (up >= 0) {
            // the cuckoo door under the centre, the bird coming out
            wbox(m, -3, 3, 7, 6, 3, 1, '#5d4037');
            wpaint(m, -3, 3, 7, 1, 3, '#3e2723'); wpaint(m, -3, 3, 1, 6, 3, '#3e2723');
            wcarve(m, -2, 4, 5, 4, 3, 1);
            wpaint(m, -2, 4, 5, 4, 2, '#2b1d18');
            wbox(m, -2, 6 - up, 4, 3, 3, 1 + up, '#ffca28');
            wpaint(m, -2, 6 - up, 2, 1, 3 + up, '#ffe082');
            wpaint(m, -1, 7 - up, 1, 1, 3 + up, '#263238');
            wbox(m, -1, 7 - up, 2, 1, 4 + up, 1, '#ef6c00');                // beak
        }
        var now = new Date(), hh = now.getHours() % 12, mm = now.getMinutes();
        if (ctx && ctx.gallery) { hh = 10; mm = 10; }
        clockHand(m, (hh + mm / 60) * 30, 5, '#263238');                  // hour hand
        clockHand(m, mm * 6, 8, '#37474f');                                 // minute hand
        m.box(-1, 3, 0, 2, 2, 2, '#c62828');                                // centre cap
        return m;
    }, function (item, ctx) {
        var rx = ctx && ctx.rx, now = new Date(), t = (now.getHours() % 12) * 60 + now.getMinutes();
        return (rx && (rx.t >= 0 || rx.held) ? 'c' + (rx.t >= 0 ? Math.round(rx.t * 2) : 2) : 'c') + '@' + t;
    }, { mount: 'wall', pool: 'dynamic' });

    // =====================================================================
    // NOTICE BOARD (wall): (x, y) = top-left, 40 x 30. Wood frame, cork, notes, pins.
    // =====================================================================
    S.def('noticeBoard', function () {
        var m = S.model(-1, 0, 41, 6, 2, -31);
        var wood = '#6d4c41';
        wbox(m, 0, 0, 40, 30, 0, 4, S.tex.wood(wood, { axis: 'y' }));
        wpaint(m, 0, 0, 40, 1, 3, tone(wood, 1.12));
        wcarve(m, 2, 2, 36, 26, 3, 1);
        var cork = function (x, y, z) {
            var n = C.hash(x, z, 11);
            return n < 0.12 ? '#a8804a' : n > 0.9 ? '#d8b47a' : '#c8a165';
        };
        wpaint(m, 2, 2, 36, 26, 1, cork); wpaint(m, 2, 2, 36, 26, 2, cork);   // cork (front at y 2)
        // paper 1 px proud of the cork (its colour painted into the cork row behind too), pins 2 deep
        var note = function (ax, ay, aw, ah, c) { wbox(m, ax, ay, aw, ah, 3, 1, c); wpaint(m, ax, ay, aw, ah, 2, c); };
        var ink = function (ax, ay, aw, c) { wpaint(m, ax, ay, aw, 1, 2, c); wpaint(m, ax, ay, aw, 1, 3, c); };
        var pin = function (ax, ay, c) { wbox(m, ax, ay, 2, 2, 3, 2, c); wpaint(m, ax, ay, 1, 1, 4, tone(c, 1.25)); };
        // a white memo with a red pin
        note(5, 6, 11, 9, '#fafafa');
        ink(7, 9, 7, '#90a4ae'); ink(7, 11, 5, '#90a4ae'); ink(7, 13, 6, '#b0bec5');
        pin(10, 5, '#e53935');
        // a yellow sticky with a blue pin
        note(22, 13, 11, 10, '#fff59d');
        ink(24, 16, 7, '#9a9660'); ink(24, 18, 6, '#9a9660'); ink(24, 20, 4, '#9a9660');
        pin(27, 12, '#1e88e5');
        // a little photo (sky over a green hill) with a green pin, a pink note with a yellow pin
        note(6, 18, 9, 8, '#f3f1ea');
        note(7, 19, 7, 3, '#7ec8f0'); note(7, 22, 7, 2, '#66bb6a');
        wpaint(m, 11, 19, 2, 1, 3, '#fff3a0');
        pin(10, 17, '#43a047');
        note(27, 3, 7, 7, '#f8bbd0');
        ink(28, 6, 5, '#c48b9f'); ink(28, 8, 3, '#c48b9f');
        pin(30, 3, '#fdd835');
        return m;
    }, null, { mount: 'wall' });

    // =====================================================================
    // TEXT LABEL / BRANCH SIGN: a dark plaque with raised voxel letters.
    // On the back wall (item.y < wallH - 4) it is built wall-style (centred on
    // x 0 and z 0, standing out 0..3); on the floor it lies flat (letters 1 voxel up).
    // =====================================================================
    var PL = { body: '#2b373e', rim: '#1d272c', bevel: '#3f4e57', screw: '#9aa7ad' };
    // On a wall (the back wall or a drawn wall: the scene's placement says), else a floor label.
    function onWall(item, ctx) { if (ctx && ctx.labelWall != null) return ctx.labelWall; var wh = (ctx && ctx.wallH) || 90; return (+item.y || 0) < wh - 4; }
    function labelModel(text, color, sc, wall, branch, stripe) {
        var tw = S.textWidth(text, sc);
        var w = tw + (branch ? 16 : sc === 2 ? 20 : 14), h = branch ? 18 : 7 * sc + (sc === 2 ? 12 : 10);
        var x0 = -Math.floor(w / 2), tx = -Math.floor(tw / 2);
        var lmat = branch ? MAT.EMIT : MAT.SOLID, shadow = '#141b1f', sd = sc === 2 ? 2 : 1;
        var m;
        if (wall) {
            var zb = -Math.floor(h / 2), zt = zb + h - 1;                    // plaque rows: z zb..zt
            m = S.model(x0 - 1, 0, x0 + w + 1, 6, zt + 2, zb - 1);
            m.box(x0, 0, zb, w, 3, h, PL.body);                               // 3 deep: the face at y 2 bakes a +y normal
            // rounded corners, a dark rim and a lit bevel on the face (2 deep)
            m.carve(x0, 0, zb, 1, 3, 1); m.carve(x0 + w - 1, 0, zb, 1, 3, 1); m.carve(x0, 0, zt, 1, 3, 1); m.carve(x0 + w - 1, 0, zt, 1, 3, 1);
            m.paint(x0, 1, zb, w, 2, 1, PL.rim); m.paint(x0, 1, zt, w, 2, 1, PL.rim);
            m.paint(x0, 1, zb, 1, 2, h, PL.rim); m.paint(x0 + w - 1, 1, zb, 1, 2, h, PL.rim);
            m.paint(x0 + 1, 1, zt - 1, w - 2, 2, 1, PL.bevel); m.paint(x0 + 1, 1, zb + 1, 1, 2, h - 2, PL.bevel);
            // screws
            var sz = sc === 2 ? 2 : 1;
            [[x0 + 2, zt - 1 - sz], [x0 + w - 2 - sz, zt - 1 - sz], [x0 + 2, zb + 2], [x0 + w - 2 - sz, zb + 2]].forEach(function (p) {
                m.box(p[0], 3, p[1], sz, 1, sz, PL.screw, MAT.SHINY);
            });
            var tz = branch ? zt - 11 : zb + Math.round((h - 7 * sc) / 2);   // text bottom row (classic: rows 5..11 on a branch sign)
            // drop shadow on the plaque face, then the raised letters
            m.text(text, tx + sd, 1, tz - sd, 'south', shadow, { scale: sc, depth: 2 });
            m.text(text, tx, 2, tz, 'south', color, { scale: sc, depth: sc === 2 ? 3 : 2, mat: lmat });   // y 2 inlaid + raised 1-2
            if (stripe) m.paint(x0 + 4, 1, zb + 3, w - 8, 2, 1, stripe, MAT.EMIT);
        } else {
            var yb = -Math.floor(h / 2);
            m = S.model(x0 - 1, yb - 1, x0 + w + 1, yb + h + 1, 3, 0);
            m.box(x0, yb, 0, w, h, 1, PL.body);
            m.carve(x0, yb, 0, 1, 1, 1); m.carve(x0 + w - 1, yb, 0, 1, 1, 1); m.carve(x0, yb + h - 1, 0, 1, 1, 1); m.carve(x0 + w - 1, yb + h - 1, 0, 1, 1, 1);
            m.paint(x0, yb, 0, w, 1, 1, PL.bevel); m.paint(x0, yb, 0, 1, h, 1, PL.bevel);
            m.paint(x0, yb + h - 1, 0, w, 1, 1, PL.rim); m.paint(x0 + w - 1, yb, 0, 1, h, 1, PL.rim);
            var ty = branch ? yb + 5 : yb + Math.round((h - 7 * sc) / 2);
            m.text(text, tx + sd, ty + sd, 0, 'top', shadow, { scale: sc, depth: 1 });
            m.text(text, tx, ty, 1, 'top', color, { scale: sc, depth: 1, mat: lmat });
            if (stripe) m.paint(x0 + 4, yb + h - 5, 0, w - 8, 2, 1, stripe, MAT.EMIT);   // 2 rows: a 1 px row can drop out when the top is squashed
            [[x0 + 2, yb + 2], [x0 + w - 3, yb + 2], [x0 + 2, yb + h - 3], [x0 + w - 3, yb + h - 3]].forEach(function (p) { m.paint(p[0], p[1], 0, 1, 1, 1, PL.screw); });
        }
        return m;
    }
    function textLabelLook(item) {
        var text = String(item.text || 'Label').slice(0, 120);
        var fs = Math.max(8, Math.min(32, +item.fontSize || 12));
        return { text: text, color: calmColor(safeHex(item.labelColor, '#ffffff')), sc: fs >= 14 ? 2 : 1 };
    }
    // A sign's plaque size in world px (as labelModel builds it): where it fits on a wall.
    S.labelSize = function (item) {
        var branch = item.type === 'branchSign', L = branch ? branchLook(item) : textLabelLook(item), sc = branch ? 1 : L.sc;
        var tw = S.textWidth(L.text, sc);
        return { w: tw + (branch ? 16 : sc === 2 ? 20 : 14), h: branch ? 18 : 7 * sc + (sc === 2 ? 12 : 10) };
    };
    S.def('textLabel', function (item, ctx) {
        var L = textLabelLook(item);
        return labelModel(L.text, L.color, L.sc, onWall(item, ctx), false, null);
    }, function (item, ctx) {
        var L = textLabelLook(item);
        return L.text + '|' + L.color + '|' + L.sc + '|' + (onWall(item, ctx) ? 'w' : 'f');
    }, { flat: true });

    function branchLook(item) {
        var id = item.branchId || 'UNASSIGNED', name = id, col = '#ffffff';
        try {
            if (typeof getBranchById === 'function') {
                var b = getBranchById(id) || {};
                name = b.name || id;
                var neon = typeof _NEON_COLORS !== 'undefined' ? _NEON_COLORS[b.theme] : null;
                col = b.color || neon || '#ffffff';
            }
        } catch (e) { /* plain sign */ }
        if (item.text && typeof getBranchById !== 'function') name = item.text;   // gallery preview
        if (item.labelColor && typeof getBranchById !== 'function') col = item.labelColor;
        return { text: String(name).toUpperCase().slice(0, 60), color: calmColor(safeHex(col, '#ffffff')) };
    }
    S.def('branchSign', function (item, ctx) {
        var L = branchLook(item);
        return labelModel(L.text, L.color, 1, onWall(item, ctx), true, L.color);
    }, function (item, ctx) {
        var L = branchLook(item);
        return L.text + '|' + L.color + '|' + (onWall(item, ctx) ? 'w' : 'f');
    }, { flat: true });
})();
