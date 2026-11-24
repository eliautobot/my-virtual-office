// Hand-built stack models (kitchen). See stack/README.md.
// kitchenCounter, fridge, vendingMachine, waterCooler, breakArea and the counter
// pieces (mount 'surface': coffeeMaker, microwave, toaster). Built at rotation 0,
// front = +y. Surface pieces: z 0 = the worktop, front face at local y = 0
// (voxel rows y <= -1; 1 px details may sit on row 0), body extends into -y.
(function () {
    'use strict';
    var S = window.VOStack;
    if (!S || !S.def) return;
    var MAT = S.MAT, T = S.color.tone, RGB = S.color.rgb, H3 = S.color.hash;

    // ---------- small helpers ----------
    // the classic 3x5 pixel font (game.js PIXEL_FONT) for tiny displays and stencils
    var F3 = {
        '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001',
        '5': '111100111001111', '6': '111100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001111',
        'A': '010101111101101', 'B': '110101110101110', 'D': '110101101101110', 'E': '111100110100111', 'K': '101101110101101',
        'M': '101111111101101', 'N': '110101101101101', 'O': '010101101101010', 'R': '110101110101101', 'S': '011100010001110',
        'X': '101101010101101', ':': '000010000010000', ' ': '000000000000000'
    };
    // 3x5 text on a south face (row y), top row at zTop; or lying on the floor (face 'top', rows run +y)
    function text3(m, str, x, y, zTop, c, mat, face, sc) {
        sc = sc || 1;
        str = String(str).toUpperCase();
        for (var i = 0; i < str.length; i++) {
            var g = F3[str[i]] || F3[' '];
            for (var r = 0; r < 5; r++) for (var k = 0; k < 3; k++) {
                if (g.charAt(r * 3 + k) !== '1') continue;
                for (var a = 0; a < sc; a++) for (var b = 0; b < sc; b++) {
                    var xx = x + (i * 4 + k) * sc + a;
                    if (face === 'top') m.set(xx, y + r * sc + b, zTop, c, mat);
                    else m.set(xx, y, zTop - r * sc - b, c, mat);
                }
            }
        }
    }
    // stone / laminate worktop: soft cloudy patches + rare flecks
    function stone(base) {
        var c0 = RGB(base), lo = T(c0, 0.97), hi = T(c0, 1.025), fl = T(c0, 0.9);
        return function (x, y, z) {
            var n = H3(x, y, z), p = H3(Math.floor(x / 5), Math.floor(y / 4), 11);
            if (n > 0.985) return fl;
            return p < 0.25 ? lo : p > 0.8 ? hi : c0;
        };
    }
    // bold 5x5 digits (2 px vertical strokes) for small glowing displays, centred in [x, x + w)
    var FB = {
        '0': ['#####', '##.##', '##.##', '##.##', '#####'], '1': ['.###.', '..##.', '..##.', '..##.', '.####'],
        '2': ['#####', '...##', '#####', '##...', '#####'], '3': ['#####', '...##', '.####', '...##', '#####'],
        '4': ['##.##', '##.##', '#####', '...##', '...##'], '5': ['#####', '##...', '#####', '...##', '#####'],
        '6': ['#####', '##...', '#####', '##.##', '#####'], '7': ['#####', '...##', '...##', '..##.', '..##.'],
        '8': ['#####', '##.##', '#####', '##.##', '#####'], '9': ['#####', '##.##', '#####', '...##', '#####'],
        'E': ['#####', '##...', '####.', '##...', '#####'], 'N': ['##..#', '###.#', '#####', '#.###', '#..##'],
        'D': ['####.', '##.##', '##.##', '##.##', '####.'], ':': ['.', '#', '.', '#', '.']
    };
    function boldDigits(m, str, x, y, zTop, c, mat, w) {
        var gl = [], tw = 0, i;
        for (i = 0; i < str.length; i++) { var g = FB[str[i]] || FB['0']; gl.push(g); tw += g[0].length + (i ? 1 : 0); }
        var cx = x + Math.floor((w - tw) / 2);
        for (i = 0; i < gl.length; i++) {
            for (var r = 0; r < 5; r++) for (var k = 0; k < gl[i][r].length; k++) if (gl[i][r][k] === '#') m.set(cx + k, y, zTop - r, c, mat);
            cx += gl[i][0].length + 1;
        }
    }
    // bold 5x7 text on a south face: every stroke 2 px wide (1 px strokes break up as the stack turns)
    function boldText(m, str, x, y, z, c, mat, adv) {
        var gl = S.font.glyphs(String(str).toUpperCase()), cx = x;
        for (var g = 0; g < gl.length; g++) {
            for (var row = 0; row < 7; row++) for (var col = 0; col < gl[g].w; col++) {
                if (!gl[g].rows[row] || !(gl[g].rows[row] & (1 << (gl[g].w - 1 - col)))) continue;
                m.set(cx + col, y, z + 6 - row, c, mat); m.set(cx + col + 1, y, z + 6 - row, c, mat);
            }
            cx += adv || gl[g].w + 2;
        }
    }
    // brushed metal: fine streaks along z (fridge handles, chrome)
    function brushed(base) {
        var c0 = RGB(base), lo = T(c0, 0.93), hi = T(c0, 1.06);
        return function (x, y, z) { var n = H3(x, y, 3); return n < 0.25 ? lo : n > 0.8 ? hi : c0; };
    }
    // a can lying along x (vending tray), centre (cy, cz), radius r
    function canX(m, x0, x1, cy, cz, r, zMax) {
        var red = '#e53935', top = '#ff8a80', bot = '#b71c1c', rim = '#eceff1';
        for (var x = x0; x < x1; x++) for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (var z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
            var dy = (y + 0.5 - cy) / r, dz = (z + 0.5 - cz) / r;
            if (dy * dy + dz * dz > 1 || z > zMax) continue;
            var c = (x === x0 || x === x1 - 1) ? rim : z + 0.5 > cz + r * 0.45 ? top : z + 0.5 < cz - r * 0.35 ? bot : red;
            if (x === x0 + 3 || x === x0 + 4) c = c === rim ? rim : (z + 0.5 > cz ? '#fff3e0' : '#f5f5f5');   // white label band
            m.set(x, y, z, c, (x === x0 || x === x1 - 1) ? MAT.SHINY : MAT.SOLID);
        }
    }
    function rxOf(ctx) { return ctx && ctx.rx ? ctx.rx : null; }

    // =====================================================================
    // kitchenCounter: 72 x 24 base cabinet run, worktop at z 22..24
    // =====================================================================
    // Reads as kitchen base cabinets at every zoom (not a table): a drawer over
    // each door, dark shadow gaps round the fronts, metal pulls, a dark kick
    // plate set back under the doors, a thick worktop edge and a tiled
    // backsplash against the wall. Appliances stand on the worktop (z 25).
    var CARC = '#e9e6df', DOOR = '#f1eee8', PANEL = '#e3dfd6', GAP = '#9c968b', KICK = '#5f5a52', TOP = '#bcb4a5', EDGE = '#8f887b';
    var PULL = '#6f777e', PULL2 = '#59616a', GLINT = '#d3d9dd', TILE = '#f1f3f2', GROUT = '#dbe1e1';
    function buildCounter() {
        var m = S.model(0, 4, 72, 30, 31);
        // carcass + end panels (full depth, toe-kick notch at the front)
        m.box(2, 4, 3, 68, 21, 19, CARC);                              // y 4..24, z 3..21
        m.box(0, 4, 0, 2, 23, 22, T(CARC, 0.97));                      // left end panel, face at y 26
        m.box(70, 4, 0, 2, 23, 22, T(CARC, 0.97));                     // right end panel
        m.carve(0, 24, 0, 2, 3, 3); m.carve(70, 24, 0, 2, 3, 3);       // toe-kick notches
        // kick plate: dark, 3 px behind the fronts, so the cabinets stand on a shadow line
        m.box(2, 4, 0, 68, 20, 3, KICK);                               // face y 23
        m.paint(2, 23, 2, 68, 1, 1, T(KICK, 1.18));                    // its lit top edge
        // inset panels on the end panels (seen when turned)
        m.paint(0, 7, 5, 1, 15, 14, T(CARC, 0.92)); m.paint(71, 7, 5, 1, 15, 14, T(CARC, 0.92));
        m.paint(0, 8, 6, 1, 13, 12, T(CARC, 1.0)); m.paint(71, 8, 6, 1, 13, 12, T(CARC, 1.0));
        // back panel seams (seen from behind)
        m.paint(24, 4, 3, 1, 1, 19, T(CARC, 0.88)); m.paint(48, 4, 3, 1, 1, 19, T(CARC, 0.88));
        // the carcass front shows as dark gaps between and round the fronts
        m.paint(2, 24, 3, 68, 1, 19, GAP);
        // two cabinets: a drawer (z 17..20) over a shaker door (z 3..15), fronts are 2 px slabs (y 25..26)
        [[2, 33, 29], [37, 33, 39]].forEach(function (dd) {
            var dx = dd[0], w = dd[1], hx = dd[2];
            // door
            m.box(dx, 25, 3, w, 2, 13, DOOR);                          // z 3..15
            m.carve(dx + 3, 26, 5, w - 6, 1, 9);                       // recessed centre panel
            m.paint(dx + 3, 25, 5, w - 6, 1, 9, PANEL);
            m.paint(dx + 3, 25, 13, w - 6, 1, 1, T(PANEL, 0.9));       // the recess's shadowed top
            m.paint(dx, 26, 15, w, 1, 1, T(DOOR, 1.04));               // light top edge
            m.paint(dx, 26, 3, w, 1, 1, T(DOOR, 0.9));                 // shaded bottom edge
            // drawer
            m.box(dx, 25, 17, w, 2, 4, DOOR);                          // z 17..20
            m.paint(dx, 26, 20, w, 1, 1, T(DOOR, 1.04));
            m.paint(dx, 26, 17, w, 1, 1, T(DOOR, 0.92));
            // drawer pull: a horizontal bar on two standoffs
            var px = dx + Math.floor(w / 2) - 4;
            m.box(px, 27, 18, 8, 1, 2, PULL, MAT.SHINY);
            m.box(px, 26, 18, 1, 1, 2, PULL2, MAT.SHINY); m.box(px + 7, 26, 18, 1, 1, 2, PULL2, MAT.SHINY);
            m.paint(px + 1, 27, 19, 5, 1, 1, GLINT, MAT.SHINY);
            // door handle: a vertical bar on two standoffs, by the cabinets' meeting edge
            m.box(hx, 27, 7, 2, 1, 7, PULL, MAT.SHINY);
            m.box(hx, 26, 7, 2, 1, 1, PULL2, MAT.SHINY); m.box(hx, 26, 13, 2, 1, 1, PULL2, MAT.SHINY);
            m.paint(hx, 27, 11, 1, 1, 2, GLINT, MAT.SHINY);
        });
        // worktop: a 3 px slab, 1 px over the fronts, with a darker edge band and a lit front lip
        m.box(0, 4, 22, 72, 24, 3, stone(TOP));
        m.paint(0, 27, 22, 72, 1, 3, function (x, y, z) { return z === 24 ? T(EDGE, 1.25) : (x % 24 === 0 ? T(EDGE, 0.9) : EDGE); });
        m.paint(0, 4, 22, 1, 24, 3, T(EDGE, 1.05)); m.paint(71, 4, 22, 1, 24, 3, T(EDGE, 1.05));   // the ends of the slab
        // tiled backsplash along the back: 4 px thick (a thin tall slab steps into stripes when the
        // view turns), 6 tall, two rows of soft white tiles with a grout joint, a lighter cap
        m.box(0, 4, 25, 72, 4, 6, function (x, y, z) {
            var row = z - 25, off = row >= 3 ? 4 : 0;
            if (row === 2) return GROUT;                              // the joint between the tile rows
            return H3(Math.floor((x + off) / 8), row >= 3 ? 1 : 0, 7) > 0.5 ? T(TILE, 0.98) : TILE;
        });
        m.paint(0, 4, 30, 72, 4, 1, T(TILE, 1.02));                   // the cap
        m.paint(0, 7, 25, 72, 1, 1, T(GROUT, 0.9));                   // sealant line on the worktop
        return m;
    }
    S.def('kitchenCounter', buildCounter, null, { surfaceZ: 25 });

    // =====================================================================
    // coffeeMaker (surface, 24 x 22): head, column, tank, drip tray, cup
    // =====================================================================
    function coffeeState(ctx) {
        var rx = rxOf(ctx);
        var brew = !!(rx && rx.t >= 0), full = !!(rx && rx.held && (rx.t < 0 || rx.t > 0.5));
        var drip = brew ? Math.floor(rx.t * 12) % 2 : 0;
        return { brew: brew, full: full, drip: drip };
    }
    function buildCoffee(item, ctx, st) {
        st = st || coffeeState(ctx);
        var m = S.model(0, -17, 24, 1, 23);
        var BLK = '#3a393c', BLK2 = '#444347', DK = '#2a292c';
        // base plate with rounded top edges
        m.rbox(2, -16, 0, 20, 16, 3, 1, BLK2);
        m.paint(2, -1, 0, 20, 1, 1, DK);
        // drip tray (grille) on the plate under the head
        m.box(3, -13, 3, 12, 12, 1, function (x, y) { return (x + y) & 1 ? '#3d3d3d' : '#4a4a4a'; }, MAT.SHINY);
        m.box(3, -2, 2, 12, 1, 2, '#424242', MAT.SHINY);
        // back tower + right column (holds the water tank)
        m.box(2, -16, 3, 20, 6, 11, BLK);
        m.box(15, -16, 3, 7, 16, 11, BLK);
        m.paint(15, -1, 3, 1, 1, 10, DK);                              // column edge
        // water tank window on the column front (+ its side)
        m.paint(16, -2, 4, 5, 2, 9, function (x, y, z) { return z >= 10 ? '#7ec8ee' : z === 9 ? '#b3e5fc' : x === 16 ? '#5bb6e6' : '#2f8fcf'; }, MAT.SHINY);
        m.paint(21, -12, 4, 1, 10, 9, function (x, y, z) { return z >= 10 ? '#7ec8ee' : z === 9 ? '#b3e5fc' : '#2f8fcf'; }, MAT.SHINY);
        // head: rounded, overhanging the cup
        m.rbox(2, -16, 14, 20, 16, 8, 2, BLK);
        m.box(2, -16, 13, 20, 16, 1, DK);                              // underside line
        m.paint(4, -1, 15, 16, 1, 5, '#2b2b2e');                       // front control panel
        m.paint(2, -2, 14, 20, 2, 1, '#9aa1a7', MAT.SHINY);            // chrome band under the head
        m.paint(4, -14, 21, 16, 11, 1, '#333236');                     // lid
        m.paint(4, -14, 21, 16, 1, 1, '#252427');                      // lid hinge line
        // buttons (LEDs)
        m.box(5, 0, 17, 3, 1, 2, st.brew ? '#b9f6ca' : '#4caf50', MAT.EMIT);
        m.box(10, 0, 17, 3, 1, 2, '#f44336', MAT.EMIT);
        m.set(17, -1, 18, '#90a4ae', MAT.SHINY); m.set(18, -1, 18, '#90a4ae', MAT.SHINY);   // little badge
        // spout under the head
        m.box(8, -7, 11, 3, 3, 2, '#4a4a4a', MAT.SHINY);
        // the cup
        var cx = 9.5, cy = -5.5;
        m.cyl(cx, cy, 4, 2.6, 2.6, 6, '#f5f5f5');
        m.paint(7, -9, 9, 6, 7, 1, '#d7ccc8');                         // rim
        m.cyl(cx, cy, 6, 1.6, 1.6, 4, null);                           // hollow
        m.carve(8, -7, 6, 3, 3, 4);
        if (st.full) m.box(8, -7, 6, 3, 3, 3, '#6d4c41');
        else m.box(8, -7, 6, 3, 3, 1, '#e0dad6');
        m.box(5, -6, 5, 2, 2, 3, '#eeeeee');                           // cup handle
        // brewing: a coffee stream from the spout
        if (st.brew) m.box(9, -7, st.drip ? 10 : 9, 2, 2, st.drip ? 1 : 2, '#5d4037');
        return m;
    }
    S.def('coffeeMaker', function (item, ctx) { return buildCoffee(item, ctx); }, function (item, ctx) {
        var s = coffeeState(ctx); return (s.brew ? 'b' + s.drip : '') + (s.full ? 'f' : '');
    });

    // =====================================================================
    // microwave (surface, 30 x 24): door window, clock display, keypad
    // =====================================================================
    function microState(item, ctx) {
        var rx = rxOf(ctx), run = !!(rx && rx.t >= 0), done = !!(rx && rx.held && rx.t < 0);
        var use = false;
        if (!run && !ctx.gallery) {
            try {
                use = typeof agents !== 'undefined' && agents.some(function (a) {
                    return a.idleAction === 'make_food' && a.foodSource === 'microwave' && !a.isSitting && Math.abs(a.x - item.x) < 55 && Math.abs(a.y - item.y) < 70;
                });
            } catch (e) { use = false; }
        }
        var secs = run ? Math.max(1, Math.ceil((1 - rx.t) * 3)) : 0;
        return { on: run || use, run: run, use: use, done: done && !use, secs: secs };
    }
    function buildMicro(item, ctx, st) {
        st = st || microState(item, ctx || {});
        var m = S.model(0, -19, 30, 1, 25);
        var BODY = '#67808c', FRONT = '#34454d', DK = '#222c31';
        m.rbox(0, -18, 0, 30, 18, 24, 1, BODY);
        m.carve(2, -16, 0, 26, 17, 1);                                 // little feet at the ends
        // lighter top skin, vents on the top (back right) and the right side
        m.paint(0, -18, 23, 30, 18, 1, T(BODY, 1.06));
        for (var i = 0; i < 4; i++) { m.paint(19, -15 + i * 2, 23, 8, 1, 1, T(BODY, 0.8)); m.paint(29, -15 + i * 3, 12, 1, 1, 8, T(BODY, 0.8)); }
        // front: the dark door (clock + window) and the control panel (decals 2 deep: the row
        // behind the face shows at the slice steps when the stack turns)
        m.paint(1, -2, 1, 22, 2, 22, FRONT);
        m.paint(23, -2, 1, 1, 2, 22, DK);                              // door gap
        m.paint(24, -2, 2, 5, 2, 19, '#526a76');                       // control panel
        // window (recessed 2 px, mesh glass; glowing while it runs)
        m.paint(1, -2, 2, 18, 2, 11, DK);
        m.carve(2, -2, 3, 16, 2, 9);
        if (st.on) {
            m.paint(2, -3, 3, 16, 1, 9, function (x, y, z) { return (x + z) % 3 === 0 ? '#ffd166' : '#ffb84d'; }, MAT.EMIT);
            m.box(5, -3, 3, 10, 2, 1, '#fff3c4', MAT.EMIT);            // the turntable plate
            m.box(7, -3, 4, 6, 1, 3, '#ffe0a3', MAT.EMIT);             // a bowl on it
        } else {
            m.paint(2, -3, 3, 16, 1, 9, function (x, y, z) { return (x + z) & 1 ? '#1f2f36' : '#283c45'; }, MAT.SHINY);
            m.paint(3, -3, 4, 2, 1, 7, '#456673', MAT.SHINY);          // glass shine
            m.paint(6, -3, 9, 2, 1, 2, '#3d5a66', MAT.SHINY);
        }
        // clock display strip over the window (flush, glows), bold 2 px digits
        m.paint(1, -2, 13, 21, 2, 7, st.on ? '#1b3a12' : '#0f2412', MAT.EMIT);
        var dc = st.done ? '#ffe57f' : st.on ? '#9cff57' : '#5fae58', label = st.done ? 'END' : st.run ? '0:0' + st.secs : st.use ? '0:30' : '0:00';
        boldDigits(m, label, 1, -1, 18, dc, MAT.EMIT, 21);
        // handle: a raised 2 px bar beside the window
        m.box(19, 0, 3, 2, 1, 10, '#9fb3bd', MAT.SHINY);
        m.paint(19, 0, 11, 1, 1, 2, '#d5e0e5', MAT.SHINY);
        // keypad buttons
        m.box(25, 0, 17, 2, 1, 2, st.on ? '#76ff03' : '#4caf50', MAT.EMIT);
        m.box(25, 0, 13, 2, 1, 2, '#f44336', MAT.EMIT);
        m.box(25, 0, 9, 2, 1, 2, '#90a4ae', MAT.SHINY);
        m.box(25, 0, 5, 2, 1, 2, '#90a4ae', MAT.SHINY);
        m.paint(24, -1, 3, 5, 1, 1, '#455a64');
        return m;
    }
    S.def('microwave', function (item, ctx) { return buildMicro(item, ctx); }, function (item, ctx) {
        var s = microState(item, ctx || {}); return (s.run ? 'r' + s.secs : s.use ? 'u' : '') + (s.done ? 'e' : '');
    });

    // =====================================================================
    // toaster (surface, 18 x 16): rounded chrome body, two slots, side lever
    // =====================================================================
    function toastState(ctx) {
        var rx = rxOf(ctx);
        var down = !rx ? 0 : rx.t >= 0 ? Math.round((rx.state === 1 ? rx.t : 1 - rx.t) * 3) : rx.state === 1 ? 3 : 0;
        return { down: down, glow: !!(rx && down === 3 && rx.t < 0) };
    }
    function buildToaster(item, ctx, st) {
        st = st || toastState(ctx);
        var m = S.model(-1, -15, 21, 1, 17);
        var BODY = '#cfd3d6', DK = '#8e9499';
        m.rbox(0, -14, 0, 18, 14, 14, 3, brushed(BODY), MAT.SHINY);    // y -14..-1, top z 13
        m.box(0, -14, 0, 18, 14, 2, '#5f6468');                        // dark base band
        m.paint(1, -2, 2, 16, 2, 1, '#9aa0a5', MAT.SHINY);             // seam over the base
        // the two slots (run front-to-back), dark rims
        [3, 10].forEach(function (sx) {
            m.paint(sx - 1, -13, 13, 6, 12, 1, DK, MAT.SHINY);
            m.carve(sx, -12, 8, 4, 10, 7);
            m.box(sx, -12, 8, 4, 10, 1, st.glow ? '#ff7043' : '#3a3a3a', st.glow ? MAT.EMIT : MAT.SOLID);
            if (st.glow) {                                              // the slot walls glow (not the near wall: it shows through the rounded edge)
                var gc = function (x, y, z) { return z === 12 ? '#ffab91' : '#ff7043'; };
                m.paint(sx - 1, -12, 9, 1, 10, 4, gc, MAT.EMIT); m.paint(sx + 4, -12, 9, 1, 10, 4, gc, MAT.EMIT);
                m.paint(sx, -13, 9, 4, 1, 4, gc, MAT.EMIT);
            }
            // bread: a 2 px slice per slot, peeking 3 - down px over the top
            var top = 15 - st.down;
            if (top >= 9) {
                m.box(sx + 1, -11, 9, 2, 8, top - 9 + 1, '#e2b26b');
                m.box(sx + 1, -11, top, 2, 8, 1, '#b5793a');          // crust
                m.paint(sx + 1, -11, 9, 2, 1, top - 9 + 1, '#c98d48');
                m.paint(sx + 1, -4, 9, 2, 1, top - 9 + 1, '#c98d48');
            }
        });
        // side lever: a slot on the right side and its knob (pushed down = toasting)
        m.paint(17, -9, 3, 1, 3, 8, '#6c757b');
        var kz = 8 - st.down * 2;
        m.box(18, -10, kz, 2, 5, 2, '#546e7a');
        m.paint(18, -10, kz + 1, 2, 5, 1, '#78909c');
        // front: label strip + browning dial
        m.paint(5, -2, 4, 8, 2, 1, '#8a8f93', MAT.SHINY);
        m.box(13, 0, 6, 2, 1, 2, '#424242');
        m.set(2, 0, 9, '#f4f6f7', MAT.SHINY);                         // glint
        return m;
    }
    S.def('toaster', function (item, ctx) { return buildToaster(item, ctx); }, function (item, ctx) {
        var s = toastState(ctx); return s.down + (s.glow ? 'g' : '');
    });

    // =====================================================================
    // fridge (36 x 28 plan, 50 high): freezer over fridge, handles, magnets, note
    // =====================================================================
    function buildFridge() {
        var m = S.model(0, 38, 36, 68, 51);
        var BODY = '#ebe7de', DOORC = '#f2efe8', SPLIT = '#b8b2a5';
        m.rbox(0, 38, 0, 36, 28, 50, 2, BODY);
        // door slabs (front 2 px) and the groove between doors and cabinet on the sides
        m.paint(0, 64, 5, 36, 2, 45, DOORC);
        m.carve(0, 63, 5, 1, 1, 44); m.carve(35, 63, 5, 1, 1, 44);
        // freezer / fridge split
        m.carve(0, 64, 32, 36, 2, 2);
        m.paint(0, 63, 32, 36, 1, 2, SPLIT);
        // hinge-side highlights
        m.paint(2, 65, 34, 2, 1, 14, '#faf8f3'); m.paint(2, 65, 7, 2, 1, 24, '#faf8f3');
        // kick plate: recessed vent grille
        m.carve(2, 64, 0, 32, 2, 5);
        m.paint(2, 63, 0, 32, 1, 5, function (x, y, z) { return z === 2 ? '#8a857b' : '#9a958b'; });
        m.paint(0, 64, 5, 36, 2, 1, T(DOORC, 0.9));                    // fridge door bottom edge
        // handles: raised 2 px bars, brushed
        m.box(28, 66, 37, 3, 2, 8, brushed('#9aa1a7'), MAT.SHINY);
        m.box(28, 66, 17, 3, 2, 12, brushed('#9aa1a7'), MAT.SHINY);
        m.paint(28, 67, 37, 1, 1, 8, '#c3c9ce', MAT.SHINY); m.paint(28, 67, 17, 1, 1, 12, '#c3c9ce', MAT.SHINY);
        // a small badge on the freezer door
        m.box(5, 66, 45, 6, 1, 1, '#b9bec2', MAT.SHINY);
        // magnets and a note
        m.box(8, 66, 26, 3, 1, 3, '#d98f6a'); m.set(8, 66, 28, '#efb194');
        m.box(15, 66, 24, 3, 1, 3, '#7fa38a'); m.set(15, 66, 26, '#a3c4ad');
        m.box(9, 66, 14, 9, 1, 9, '#fbf6dc');
        m.paint(10, 66, 20, 7, 1, 1, '#b9ae86'); m.paint(10, 66, 18, 5, 1, 1, '#b9ae86'); m.paint(10, 66, 16, 6, 1, 1, '#b9ae86');
        m.box(12, 67, 21, 3, 1, 2, '#e57373');                         // the magnet holding it
        // top: a faint panel seam
        m.paint(2, 40, 49, 32, 1, 1, T(BODY, 0.93));
        return m;
    }
    S.def('fridge', buildFridge);

    // =====================================================================
    // vendingMachine (45 x 28 plan, 51 high): lit snack window, buttons, coin slot,
    // SNAX label, delivery tray. Click: it shakes, a can drops into the tray.
    // =====================================================================
    var SNACK = ['#ffc107', '#ff5722', '#4caf50', '#795548', '#e91e63', '#2196f3'];
    function vendState(ctx) {
        var rx = rxOf(ctx), rt = rx ? rx.t : -1;
        var lit = rt >= 0;
        var can = 0;   // 0 none, 1..3 falling/landed
        if (rx && (rt >= 0.45 || (rt < 0 && rx.held))) {
            var fall = rt < 0 ? 1 : Math.min(1, (rt - 0.45) / 0.35);
            can = fall >= 1 ? 3 : fall >= 0.5 ? 2 : 1;
        }
        return { lit: lit, can: can };
    }
    function buildVend(item, ctx, st) {
        st = st || vendState(ctx);
        var m = S.model(0, 41, 45, 71, 52);
        var RED = '#c62828', RED2 = '#b71c1c', DKR = '#7f1414';
        m.rbox(0, 41, 0, 45, 28, 51, 1, function (x, y, z) { var n = H3(x, y, z); return n < 0.12 ? T(RED, 0.97) : RED; });
        // top cap panel + side panels
        m.paint(2, 44, 50, 41, 20, 1, '#a31515');
        m.paint(3, 45, 50, 39, 18, 1, function (x, y) { return (y % 4 === 0) ? '#991313' : '#a31515'; });
        [0, 44].forEach(function (sx) {
            m.paint(sx, 44, 4, 1, 21, 43, T(RED, 0.9));
            m.paint(sx, 45, 5, 1, 19, 41, RED);
            for (var v = 0; v < 4; v++) m.paint(sx, 46 + v * 2, 7, 1, 1, 6, '#5d1010');   // vent slots
            m.paint(sx, 44, 40, 1, 21, 3, '#ffd54f');                  // a yellow band
            m.paint(sx, 44, 39, 1, 21, 1, '#8e1414');
        });
        // back: service panel, vents, power cord
        m.paint(6, 41, 6, 33, 1, 38, T(RED, 0.9));
        for (var bv = 0; bv < 5; bv++) m.paint(10, 41, 30 + bv * 2, 25, 1, 1, '#5d1010');
        m.paint(35, 41, 3, 4, 1, 4, '#263238'); m.paint(36, 41, 4, 2, 1, 2, '#90a4ae');   // power socket
        // plinth (recessed, dark)
        m.carve(2, 68, 0, 41, 1, 2);
        m.paint(2, 67, 0, 41, 1, 2, '#3a1d1d');
        // ---- the lit window: recessed 5 px, glowing back panel, three shelves of snacks ----
        m.paint(3, 68, 17, 31, 1, 32, DKR);                            // trim
        m.carve(4, 63, 18, 29, 6, 30);
        m.paint(3, 63, 17, 31, 5, 32, function (x, y, z) { return (x === 3 || x === 33) ? '#cfd8dc' : z === 17 ? '#b0bec5' : '#e3edf2'; }, MAT.EMIT);
        m.paint(4, 62, 18, 29, 1, 30, function (x, y, z) {
            var d = (x + z) % 23;                                       // diagonal glass sheen streaks
            return d < 2 ? '#ffffff' : d === 2 ? '#f3f9fd' : '#e3f2fd';
        }, MAT.EMIT);
        m.box(4, 63, 47, 29, 2, 1, '#ffffff', MAT.EMIT);               // light tube
        for (var r = 0; r < 3; r++) {
            var sz = 38 - r * 10;                                       // shelf z (38, 28, 18)
            m.box(4, 63, sz, 29, 6, 1, '#bdbdbd', MAT.EMIT);
            m.box(4, 68, sz - 1, 29, 1, 2, '#9e9e9e', MAT.SHINY);      // shelf lip
            for (var c = 0; c < 3; c++) {
                var col = SNACK[(r * 3 + c) % 6], x0 = 6 + c * 9, z0 = sz + 1;
                if (r === 1) {                                          // middle row: bottles
                    m.cyl(x0 + 3, 65.5, z0, 2.6, 1.8, 5, col, MAT.EMIT);
                    m.cyl(x0 + 3, 65.5, z0 + 5, 1.4, 1.2, 2, T(col, 1.15), MAT.EMIT);
                    m.paint(x0 + 1, 67, z0 + 1, 2, 1, 3, T(col, 1.3), MAT.EMIT);
                } else if (r === 0) {                                   // top row: chip bags
                    m.box(x0, 64, z0, 6, 3, 7, col, MAT.EMIT);
                    m.paint(x0, 64, z0 + 6, 6, 3, 1, T(col, 0.8), MAT.EMIT);    // crimp
                    m.paint(x0, 66, z0 + 3, 2, 1, 2, '#fff8e1', MAT.EMIT);       // highlight
                    m.paint(x0 + 2, 66, z0 + 1, 3, 1, 2, T(col, 0.85), MAT.EMIT);
                } else {                                                // bottom row: candy boxes
                    m.box(x0, 64, z0, 6, 3, 7, col, MAT.EMIT);
                    m.paint(x0, 66, z0 + 5, 2, 1, 2, '#ffffff', MAT.EMIT);
                    m.paint(x0, 66, z0 + 2, 6, 1, 1, T(col, 0.8), MAT.EMIT);
                }
                m.box(x0 + 2, 68, sz - 1, 2, 1, 1, '#ffffff', MAT.EMIT);      // price tag
            }
        }
        // ---- control column: buttons, coin slot ----
        m.paint(34, 67, 17, 9, 2, 32, T(RED, 0.92));
        m.box(35, 69, 42, 6, 1, 5, st.lit ? '#b9f6ca' : '#4caf50', MAT.EMIT);
        m.set(35, 69, 46, st.lit ? '#ffffff' : '#81c784', MAT.EMIT);
        m.box(35, 69, 34, 6, 1, 5, '#f44336', MAT.EMIT);
        m.set(35, 69, 38, '#ef9a9a', MAT.EMIT);
        m.box(35, 69, 23, 6, 1, 8, '#b0bec5', MAT.SHINY);              // coin slot bezel
        m.box(37, 69, 24, 2, 1, 6, '#1a1a1a');
        m.carve(37, 68, 24, 2, 1, 6); m.box(37, 67, 24, 2, 1, 6, '#1a1a1a');
        m.box(35, 69, 19, 6, 1, 2, '#263238');                         // bill slot
        // ---- SNAX label (bold, on a dark plate) ----
        m.paint(5, 67, 10, 29, 2, 7, '#8e1414');
        boldText(m, 'SNAX', 6, 69, 10, '#ffd54f', MAT.EMIT, 7);       // a lit sign
        // ---- delivery tray: dark bezel, open tray, the dropped can ----
        m.paint(5, 67, 2, 35, 2, 8, '#1a1a1a');
        m.carve(8, 63, 3, 28, 6, 6);
        m.paint(7, 62, 2, 30, 6, 8, function (x, y, z) { return z === 2 ? '#424242' : '#262626'; });
        m.box(8, 68, 2, 28, 1, 1, '#555555', MAT.SHINY);               // tray lip
        if (st.can) {
            var cz = st.can === 3 ? 5 : st.can === 2 ? 7 : 9;
            canX(m, 18, 27, 65.5, cz, 2.1, 8);
        }
        return m;
    }
    S.def('vendingMachine', function (item, ctx) { return buildVend(item, ctx); }, function (item, ctx) {
        var s = vendState(ctx); return (s.lit ? 'L' : '') + s.can;
    }, {
        animate: function (spec, item, t, ctx) {
            var rx = rxOf(ctx), rt = rx ? rx.t : -1;
            if (rt >= 0 && rt < 0.45) spec.x += Math.floor(rt * 20) % 2 ? 1 : -1;   // the machine shakes
        }
    });

    // =====================================================================
    // waterCooler (body 24 x 20 on legs, a blue jug on top, cup dispenser on the right)
    // =====================================================================
    function coolerState(ctx) {
        var rx = rxOf(ctx);
        var glug = !!(rx && rx.t >= 0);
        return { glug: glug, frame: glug ? Math.floor(rx.t * 6) % 3 : 0, cup: !!(rx && rx.held && (rx.t < 0 || rx.t > 0.5)) };
    }
    function buildCooler(item, ctx, st) {
        st = st || coolerState(ctx);
        var m = S.model(-12, 21, 27, 43, 47);
        var WH = '#eeeeee', WH2 = '#e2e2e2';
        // legs + a base frame
        [[-11, 22], [8, 22], [-11, 37], [8, 37]].forEach(function (p) { m.box(p[0], p[1], 0, 3, 3, 4, '#757575', MAT.SHINY); });
        m.box(-11, 22, 3, 22, 18, 1, '#8a8a8a', MAT.SHINY);
        // body with rounded top edges
        m.rbox(-12, 21, 4, 24, 20, 27, 2, function (x, y, z) { return H3(x, y, z) < 0.1 ? WH2 : WH; });
        // collar ring on the top that the jug sits in
        m.cyl(0, 31, 31, 10, 9.5, 1, '#d5dadd');
        // the jug (shiny blue, upright, half water half air), shoulder, neck, cap
        var JW = '#2f9fe0', JA = '#8fd0f3', JL = '#d4eefc';
        m.cyl(0, 31, 32, 9, 9, 10, function (x, y, z) {
            var c = z <= 37 ? JW : JA;
            if (z === 38) c = '#1f86c6';                                // water line
            if (z === 34 || z === 40) c = T(c, 0.9);                    // moulded ribs
            if (y > 31 && x >= -7 && x <= -5 && z >= 33 && z <= 40) c = JL;   // shine streak
            return c;
        }, MAT.SHINY);
        m.cone(0, 31, 42, 8, 5, 2, JA, MAT.SHINY);
        m.cyl(0, 31, 44, 3.6, 3.6, 1, '#0277bd', MAT.SHINY);
        m.cyl(0, 31, 45, 3.1, 3.1, 2, '#01579b', MAT.SHINY);
        // bubbles in the water (they rise faster while it glugs)
        var B = st.glug ? [[-3, 33 + st.frame], [1, 35 - st.frame], [4, 34 + st.frame], [-1, 36 - (st.frame & 1)], [2, 33 + ((st.frame + 1) % 3)]] : [[-3, 34], [2, 36], [4, 33]];
        B.forEach(function (b, i) { var s = st.glug && i % 2 ? 1 : 2; m.paint(b[0], 31, b[1], s, 11, s, '#e1f5fe', MAT.SHINY); });
        // front: tap panel with hot/cold paddles
        m.paint(-9, 39, 20, 18, 2, 8, '#c4c4c4');
        m.box(-7, 41, 22, 6, 1, 5, '#f44336'); m.box(1, 41, 22, 6, 1, 5, '#2196f3');
        m.paint(-6, 41, 24, 2, 1, 2, '#ffcdd2'); m.paint(2, 41, 24, 2, 1, 2, '#bbdefb');
        // dispensing niche (recessed), nozzles, drip tray
        m.carve(-9, 37, 14, 18, 4, 6);
        m.paint(-10, 36, 13, 20, 5, 8, '#bdbdbd');
        m.box(-5, 38, 18, 2, 2, 2, '#d32f2f', MAT.SHINY); m.box(3, 38, 18, 2, 2, 2, '#1976d2', MAT.SHINY);
        m.box(-9, 37, 13, 18, 5, 2, '#9e9e9e', MAT.SHINY);
        m.paint(-9, 37, 14, 18, 5, 1, function (x) { return x & 1 ? '#bdbdbd' : '#a8a8a8'; }, MAT.SHINY);
        m.paint(-2, 40, 14, 3, 1, 1, '#4fc3f7', MAT.SHINY);           // a drop on the tray
        // lower door panel
        m.paint(-10, 40, 5, 20, 1, 8, WH2);
        m.paint(-9, 40, 6, 18, 1, 6, '#f4f4f4');
        m.paint(-9, 40, 11, 18, 1, 1, '#fafafa');
        m.box(-2, 41, 8, 4, 1, 2, '#bdbdbd', MAT.SHINY);               // door pull
        // a filled paper cup under the cold tap
        if (st.cup) {
            m.cyl(4, 39, 15, 2.1, 1.6, 3, function (x, y, z) { return x >= 5 ? '#cfd8dc' : '#fafafa'; });
            m.paint(3, 38, 17, 2, 2, 1, '#4fc3f7', MAT.SHINY);
        }
        // cup dispenser tube on the right side
        m.box(12, 34, 11, 3, 3, 2, '#bdbdbd', MAT.SHINY); m.box(12, 34, 19, 3, 3, 2, '#bdbdbd', MAT.SHINY);   // brackets
        m.rbox(15, 33, 8, 11, 7, 16, 1, '#e0e0e0');
        m.carve(16, 39, 11, 9, 1, 11);
        m.paint(16, 38, 11, 9, 1, 11, '#f5f5f5');
        m.box(16, 38, 12, 4, 1, 9, function (x, y, z) { return z % 2 ? '#ffffff' : '#e0e0e0'; });
        m.box(21, 38, 12, 4, 1, 9, function (x, y, z) { return z % 2 ? '#ffffff' : '#e0e0e0'; });
        m.paint(15, 39, 8, 11, 1, 3, '#bdbdbd');
        m.box(17, 39, 9, 7, 1, 1, '#9e9e9e');                          // slot
        return m;
    }
    S.def('waterCooler', function (item, ctx) { return buildCooler(item, ctx); }, function (item, ctx) {
        var s = coolerState(ctx); return (s.glug ? 'g' + s.frame : '') + (s.cup ? 'c' : '');
    });

    // =====================================================================
    // breakArea (legacy composite, 242 x 154): vending machine, plant, water cooler,
    // two counters with a coffee machine, a microwave and a toaster, a floor stencil
    // =====================================================================
    function smallPlant() {
        var m = S.model(0, 0, 18, 22, 26);
        m.cone(9, 14.5, 0, 7, 8, 11, '#f2f3f4');
        m.cyl(9, 14.5, 10, 7, 7, 1, '#4e3b2f');
        [[9, 14, 17, 7, 5, '#3f8a45'], [5, 15, 14, 4, 4, '#5aa85a'], [13, 13, 15, 4, 4, '#2f6a34'], [9, 13, 21, 4, 3, '#5aa85a']].forEach(function (l) {
            m.ellipsoid(l[0], l[1], l[2], l[3], l[3], l[4], l[5], MAT.SOFT);
        });
        return m;
    }
    // One mesh lives in one 1024 x 1024 atlas page, and the whole break area (237 x 97 px,
    // 52 slices) does not fit one. The item's own model holds the plant, the two counters
    // and their appliances (x 60..242, 49 slices); the vending machine, the water cooler
    // and the floor stencil are extra stacks of the same item (same id: it picks and
    // selects as one piece), pushed through the scene's S.extraFor hook.
    var C0 = { rx: null, gallery: true };
    function buildBreak(item) {
        var m = S.model(55, 0, 242, 110, 50);
        var plant = null;
        try { if (S.defs.plant && S.defs.plant.build) plant = S.defs.plant.build({ type: 'plant', x: 0, y: 0, id: '_breakArea' }, C0); } catch (e) { plant = null; }
        m.put(plant || smallPlant(), 60, 10, 0);
        var counter = buildCounter();
        m.put(counter, 80, 78, 0); m.put(counter, 170, 78, 0);
        // counter pieces stand on the worktops (front 1 px inside the edge at y 106)
        m.put(buildCoffee(item, C0, { brew: false, full: false, drip: 0 }), 95, 105, 25);
        m.put(buildMicro(item, C0, { on: false, run: false, use: false, done: false, secs: 0 }), 175, 105, 25);
        m.put(buildToaster(item, C0, { down: 0, glow: false }), 212, 105, 25);
        return m;
    }
    function breakLabel() {                                             // BREAK ROOM stencilled on the floor
        var m = S.model(60, -21, 140, -9, 1);
        text3(m, 'BREAK ROOM', 61, -20, 0, '#8d919b', MAT.SOLID, 'top', 2);
        return m;
    }
    var BREAK_EXTRAS = [
        { key: 'vend', dx: 5, dy: 15, build: function () { return buildVend(null, C0, { lit: false, can: 0 }); } },
        { key: 'cooler', dx: 160, dy: 15, build: function () { return buildCooler(null, C0, { glug: false, frame: 0, cup: false }); } },
        { key: 'label', dx: 0, dy: 0, build: breakLabel, flat: true }
    ];
    function breakExtras(item, i, spec, out) {
        if (!S.mesh || !spec || !spec.mesh) return;
        var c = Math.cos(spec.turn || 0), s = Math.sin(spec.turn || 0);
        for (var k = 0; k < BREAK_EXTRAS.length; k++) {
            var e = BREAK_EXTRAS[k], mesh = S.mesh('kitchen|breakArea|' + e.key, e.build);
            if (!mesh || !mesh.alive) continue;
            var o = { mesh: mesh, x: spec.x + e.dx * c - e.dy * s, y: spec.y + e.dx * s + e.dy * c, z: spec.z || 0, turn: spec.turn || 0, id: spec.id, screen: 0 };
            if (spec.tint) { o.tint = spec.tint; o.tintAmt = spec.tintAmt; }
            if (spec.alpha != null) o.alpha = spec.alpha;
            if (e.flat || spec.shadow === false) o.shadow = false;
            out.push(o);
        }
    }
    // Chain onto S.extraFor (whatever else uses it keeps working); re-checked from the
    // piece's animate, which the scene calls just before S.extraFor for the same item.
    var hookTries = 0;
    function ensureBreakHook() {
        if (S.extraFor && S.extraFor.__kitchenBreak) return;
        if (hookTries++ > 20) return;
        var prev = S.extraFor;
        var hook = function (item, i, spec, out, t) {
            if (typeof prev === 'function') prev.apply(this, arguments);
            if (item && item.type === 'breakArea') breakExtras(item, i, spec, out);
        };
        hook.__kitchenBreak = true;
        S.extraFor = hook;
    }
    ensureBreakHook();
    S.breakAreaExtras = breakExtras;   // (gallery / tests)
    S.def('breakArea', buildBreak, null, { animate: function () { ensureBreakHook(); } });
})();
