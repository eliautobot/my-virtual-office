// Boss desk variants (v0.13). Loaded before game.js; see desk.js and .work/v13/VARIANTS-API.md.
// The classic boss desk is row 0 in game.js. The boss chair (wide) and its seat come from the
// classic boss desk unless a variant overrides manifest.seats.
(function () {
    var V = window.VO_FURNITURE_VARIANTS = window.VO_FURNITURE_VARIANTS || [];

    // ---- Command Center: a 2.9 m top, three screens in an arc, a lit trim line, a desk lamp ----
    V.push({
        type: 'bossDesk', id: 'command', label: 'Command Center',
        info: 'A wide executive desk with three screens, a lit trim line, a desk lamp and a tablet.',
        seat: 'sit', colors: ['black-gold', 'walnut', 'wood', 'black', 'white', 'grey', 'black-cyan'],
        screens: [
            { plan: [-54, -1, 34, 2], z: 24, h: 22, foot: [-43, -3, 12, 5] },
            { plan: [-18, -2, 36, 2], z: 24, h: 25, foot: [-6, -4, 12, 5] },
            { plan: [20, -1, 34, 2], z: 24, h: 22, foot: [31, -3, 12, 5] }
        ],
        manifest: {
            footprint: [[-58, -28, 116, 62]], footBack: 22,
            projection: { class: 'low', views: { 0: 'front', 90: 'side', 180: 'back', 270: 'side' }, parts: [
                { name: 'top', plan: [-58, -6, 116, 40], z: 16, h: 5 }, { name: 'front', plan: [-58, -6, 116, 40], z: 0, h: 16, open: true },
                { name: 'back', plan: [-58, -6, 116, 3], z: 0, h: 16 },
                { name: 'lamp', plan: [45, 4, 8, 6], z: 21, h: 20, upright: true },
                { name: 'chair', plan: [-18, 30, 36, 11], z: 0, h: 33, upright: true, seat: true }] },
            surface: { rect: [-58, -27, 116, 40], spots: { item: [-47, -15], food: [38, -12], papers: [-27, 6] },
                spotsAt: { 90: { item: [-6, -54], food: [-8, -22], papers: [-20, -2] }, 180: { item: [43, -47], food: [-43, -47], papers: [0, -30] },
                           270: { item: [6, -54], food: [8, -22], papers: [20, -2] } } }
        },
        draw: function (K, rot, C, on) {
            K.desk(rot, on, {
                floor: [
                    [[-58, 0, 26, 34], 0, 16, 'body', 'face'], [[32, 0, 26, 34], 0, 16, 'body', 'face'],   // drawer pedestals
                    [[-58, -6, 116, 3], 0, 16, 'faceDk', 'leg']                                           // back panel
                ],
                top: [[-58, -6, 116, 40], 16, 5, 'topB', 'faceDk'], grain: 12,
                keys: [-14, 22, 28, 8], mouse: [17, 22, 6, 8],
                under: function (rot) {
                    if (!rot) {
                        K.rect('leg', -32, 18, 64, 16); K.rect('faceDk', -30, 19, 60, 13);               // recessed modesty panel
                        K.rect('face', -30, 19, 60, 1); K.rect('face', -11, 20, 1, 12); K.rect('face', 10, 20, 1, 12);
                        [-58, 32].forEach(function (px) {                                                // drawers, lit handles
                            K.rect('body', px + 2, 19, 22, 6); K.rect('body', px + 2, 26, 22, 6); K.rect('faceDk', px + 2, 25, 22, 1);
                            K.rect('accent', px + 7, 21, 12, 1); K.rect('accent', px + 7, 28, 12, 1);
                        });
                    } else if (rot === 180) K.rect('seam', -55, -4, 110, 1);                             // back panel seam
                    else K.inset(K.face(rot, rot === 90 ? [32, 0, 26, 34] : [-58, 0, 26, 34], 0, 16), 'faceDk');
                },
                onTop: function (rot, t, lift) {
                    var T = t[1] - lift;
                    K.rect('inlay', t[0] + 3, T + 3, t[2] - 6, 1); K.rect('inlay', t[0] + 3, T + t[3] - 4, t[2] - 6, 1);   // inlay border
                    K.rect('inlay', t[0] + 3, T + 3, 1, t[3] - 6); K.rect('inlay', t[0] + t[2] - 4, T + 3, 1, t[3] - 6);
                    var fy = t[1] + t[3] - lift;                                                         // lit trim along the front edge
                    K.rect('accentA', t[0] + 1, fy + 3, t[2] - 2, 1);
                    var tab = K.turn([-50, 14, 16, 12], rot);                                            // tablet
                    K.rect('#212121', tab[0], tab[1] - lift, tab[2], tab[3]);
                    K.rect('#4fc3f7', tab[0] + 1, tab[1] - lift + 1, tab[2] - 2, tab[3] - 2);
                    K.rect('#b3e5fc', tab[0] + 2, tab[1] - lift + 2, Math.max(1, tab[2] - 8), 1);
                    var np = K.turn([24, 25, 14, 4], rot);                                               // name plate
                    var ny = K.box(np[0], np[1], np[2], np[3], 21, 3, 'faceDk', { front: 'accent' });
                    // desk lamp (upright part 'lamp'): seen from the front its base and shade show 1 px of top,
                    // from the side their whole turned depth (the camera's rule for upright parts)
                    var lp = K.turn([45, 4, 8, 6], rot), o = rot === 90 || rot === 270 ? {} : { cap: 1 };
                    var ly = K.box(lp[0], lp[1], lp[2], lp[3], 21, 2, '#37474f', o);
                    var sy = K.box(lp[0], lp[1], lp[2], lp[3], 37, 4, 'accent', o), cx = lp[0] + Math.floor(lp[2] / 2);
                    K.rect('#455a64', cx - 1, sy + 4, 2, Math.max(1, ly - sy - 4));
                    K.rect('#fff59d', lp[0] + 1, sy + 4, lp[2] - 2, 1);
                },
                monitor: { bezel: '#1a1a2e' }
            });
        }
    });

    // ======================================================================================
    // v0.13 bossart: shared pieces for the boss desk family below.
    // Seat reach (review 11-13: "the chair and sitting position should be closer into the actual table
    // so that their hands can reach the mouse and keyboard"): the chair and the sitter sit REACH px
    // further in than the 0.12 boss desk at rotation 0 (seen from behind the hands then land on
    // the keys and the mouse, not on the top's front edge) and at 180 (the hips at the turned chair),
    // the same as the classic boss desk since v0.13 seatreach (4: the spine 2 px inside the top's
    // front edge, the most the 3D invariant allows).
    // In profile (90 / 270) the hands reach 8-12 px ahead of the hips and the torso hides the turned
    // keyboard, so the side seats move SIDE px in (the hands on the top just past the keys, not past
    // the middle). The side chair's backrest then reaches 4 px past the turned chair part: drawnAt.
    // Every seated variant keeps the classic top front edge (plan y 34), keyboard at plan y 22-30.
    // ======================================================================================
    var REACH = 4, SIDE = 3;
    var KEYS = [-14, 22, 28, 8], MOUSE = [17, 22, 6, 8];
    function bossSeats() {
        return [{ id: 'chair', kind: 'bossDesk', spot: [0, 0], x: 0, y: 28 - REACH, facing: 'up', legs: 'rear', tagY: -68,
            behind: ['body'], front: ['chair'],
            at: { 90: { x: -31 + SIDE, y: 4, legs: 'side', cut: [-24 + SIDE, 4, 90, 70], floor: [-17 - SIDE, 14] },
                  180: { x: 0, y: -43 + REACH, legs: 'hidden', tuck: true, front: ['monitor'] },
                  270: { x: 31 - SIDE, y: 4, legs: 'side', cut: [-66 - SIDE, 4, 90, 70], floor: [17 + SIDE, 14] } } }];
    }
    function chairPart() { return { name: 'chair', plan: [-18, 30 - REACH, 36, 11], z: 0, h: 33, upright: true, seat: true }; }
    // a seated boss desk's projection: its parts + the chair, the side chair's backrest (drawnAt)
    function bossProj(parts) {
        return { class: 'low', views: { 0: 'front', 90: 'side', 180: 'back', 270: 'side' }, parts: parts.concat([chairPart()]),
            drawnAt: { 90: [[-42 + SIDE, -20, 6, 30]], 270: [[36 - SIDE, -20, 6, 30]] } };
    }
    // rot-0 desk-top spots (screen, lifted) for the keyboard and mouse (tests/test_v13_bossart_variants.mjs: reach)
    function kmSpots(lift, keys, mouse) {
        keys = keys || KEYS; mouse = mouse || MOUSE;
        return { keyboard: [keys[0] + keys[2] / 2, keys[1] + keys[3] / 2 - lift], mouse: [mouse[0] + mouse[2] / 2, mouse[1] + mouse[3] / 2 - lift] };
    }
    function spots(o, lift, keys, mouse) { return Object.assign(o, kmSpots(lift || 21, keys, mouse)); }

    // Pixel helpers (crisp: rows of rects, no anti-aliasing).
    function disc(K, c, cx, cy, r) {
        for (var dy = -r; dy <= r; dy++) { var w = Math.round(Math.sqrt(r * r - dy * dy + r * 0.6)); K.rect(c, cx - w, cy + dy, w * 2, 1); }
    }
    function ring(K, c, cx, cy, r) {
        for (var dy = -r; dy <= r; dy++) {
            var w = Math.round(Math.sqrt(r * r - dy * dy + r * 0.6)), w2 = Math.abs(dy) < r - 1 ? Math.round(Math.sqrt(Math.max(0, (r - 1) * (r - 1) - dy * dy + r * 0.6))) : 0;
            if (w2 > 0 && w2 < w) { K.rect(c, cx - w, cy + dy, w - w2, 1); K.rect(c, cx + w2, cy + dy, w - w2, 1); } else K.rect(c, cx - w, cy + dy, w * 2, 1);
        }
    }
    // Things standing on the top: thing(name, px, py, H, fn) = drawn centred on the plan point (px, py)
    // (fn(cx, cy, rot): cx, cy = that point on the lifted top, screen), H px tall above it. A round or
    // irregular prop is no box: its projection part is an upright 2 x 1 post at its centre, H - 1 high,
    // so the part's top (front: bottom - h; turned: plan far edge - z - h) is the drawn top in every
    // view. name null = too low to matter (no part). Drawn far ones first for the turn.
    function thing(name, px, py, H, fn) { return { name: name, p: [px, py], H: H, fn: fn }; }
    function thingParts(list, z) {
        return list.filter(function (e) { return e.name; }).map(function (e) {
            return { name: e.name, plan: [e.p[0] - 1, e.p[1], 2, 1], z: z || 21, h: e.H - 1, upright: true };
        });
    }
    function onTopThings(K, rot, lift, list) {
        list.map(function (e) { var t = K.turn([e.p[0], e.p[1], 0, 0], rot); return { x: t[0], y: t[1], fn: e.fn }; })
            .sort(function (a, b) { return a.y - b.y; })
            .forEach(function (e) { e.fn.call(K, e.x, e.y - lift, rot); });
    }
    function side(rot) { return rot === 90 || rot === 270; }
    // a flat sheet lying on the top (turned plan), with an optional 1 px border
    function flat(K, rot, plan, lift, fill, edge) {
        var t = K.turn(plan, rot);
        K.rect(fill, t[0], t[1] - lift, t[2], t[3]);
        if (edge) { K.rect(edge, t[0], t[1] - lift, t[2], 1); K.rect(edge, t[0], t[1] - lift + t[3] - 1, t[2], 1); K.rect(edge, t[0], t[1] - lift, 1, t[3]); K.rect(edge, t[0] + t[2] - 1, t[1] - lift, 1, t[3]); }
        return t;
    }
    // a raised panel (door / drawer front) on a face [x, y, w, h]
    function panel(K, x, y, w, h, c) {
        K.rect(K.tone(c, 0.82), x, y, w, h); K.rect(c, x + 1, y + 1, w - 2, h - 2);
        K.rect(K.tone(c, 1.16), x + 1, y + 1, w - 2, 1); K.rect(K.tone(c, 1.16), x + 1, y + 1, 1, h - 2);
    }

    // ---- Executive: a 2.6 m mahogany-style partner desk: raised-panel pedestals, a tooled leather writing
    //      pad, an antique globe, a crystal decanter on a silver tray, a pen set and one big screen ----
    var EXEC = [
        thing('globe', -41, 3, 18, function (cx, cy) {                                               // antique globe on a turned base
            var K = this;
            K.rect('faceDk', cx - 5, cy + 3, 10, 2); K.rect('leg', cx - 1, cy - 1, 2, 4);
            disc(K, '#cdb27a', cx, cy - 9, 6);                                                        // parchment seas, sepia lands
            K.rect('#8a6538', cx - 4, cy - 12, 4, 3); K.rect('#8a6538', cx - 3, cy - 9, 2, 3); K.rect('#8a6538', cx + 1, cy - 8, 4, 4); K.rect('#8a6538', cx + 2, cy - 13, 2, 2);
            K.rect('#f0e2b8', cx - 3, cy - 13, 2, 1);
            ring(K, '#c9a24a', cx, cy - 9, 8); K.rect('rgba(0,0,0,0.35)', cx - 8, cy - 9, 16, 1);     // brass meridian, horizon line
            K.rect('#c9a24a', cx - 1, cy - 18, 2, 2);
        }),
        thing('decanter', 39, 2, 15, function (cx, cy) {                                             // decanter + two tumblers on a silver tray
            var K = this;
            K.rect('#9ea7ad', cx - 8, cy + 1, 17, 3); K.rect('#cfd6da', cx - 8, cy + 1, 17, 1);
            K.rect('#dfeef3', cx - 4, cy - 9, 7, 10); K.rect('#b5651d', cx - 3, cy - 4, 5, 5); K.rect('#d48a3c', cx - 3, cy - 4, 5, 1);
            K.rect('#dfeef3', cx - 2, cy - 12, 3, 3); K.rect('#ffffff', cx - 3, cy - 8, 1, 4); disc(K, '#e8f4f8', cx - 1, cy - 14, 1);
            K.rect('#dfeef3', cx + 4, cy - 3, 4, 4); K.rect('#b5651d', cx + 4, cy - 1, 4, 2);
            K.rect('#dfeef3', cx - 8, cy - 2, 3, 3); K.rect('#b5651d', cx - 8, cy - 1, 3, 2);
        }),
        thing(null, 36, 12, 8, function (cx, cy) {                                                     // fountain pen stand (marble)
            var K = this;
            K.rect('#2e3133', cx - 5, cy, 10, 3); K.rect('#4b5054', cx - 5, cy, 10, 1);
            K.rect('#111', cx - 3, cy - 7, 1, 7); K.rect('#c9a24a', cx - 3, cy - 8, 1, 1); K.rect('#111', cx + 2, cy - 6, 1, 6); K.rect('#c9a24a', cx + 2, cy - 7, 1, 1);
        })
    ];
    V.push({
        type: 'bossDesk', id: 'executive', label: 'Executive',
        info: 'A grand 2.6 m wood desk: raised-panel pedestals, a tooled leather pad, an antique globe, a whisky decanter and one big screen.',
        seat: 'sit', colors: ['walnut', 'wood', 'walnut-brass', 'black-gold', 'black', 'white'],
        screens: [{ plan: [-21, 0, 42, 2], z: 24, h: 25, foot: [-6, -2, 12, 5], bc: '#1c1f24' }],
        manifest: {
            footprint: [[-52, -28, 104, 62]], footBack: 22,
            projection: bossProj([
                { name: 'top', plan: [-52, -6, 104, 40], z: 16, h: 5 }, { name: 'front', plan: [-52, -6, 104, 40], z: 0, h: 16, open: true },
                { name: 'back', plan: [-52, -6, 104, 3], z: 0, h: 16 }].concat(thingParts(EXEC))),
            surface: { rect: [-52, -27, 104, 40], spots: spots({ item: [-42, -2], food: [41, -1], papers: [-24, 1] }),
                spotsAt: { 90: { item: [-6, -50], food: [-8, -22], papers: [-20, -2] }, 180: { item: [26, -48], food: [-26, -48], papers: [0, -30] },
                           270: { item: [6, -50], food: [8, -22], papers: [20, -2] } } },
            seats: bossSeats()
        },
        draw: function (K, rot, C, on) {
            // the gold tooling and the name plate in the accent slot (v0.13 finish: walnut / walnut-brass differ in every turn)
            var white = C.id === 'white', leather = white ? '#1f3554' : '#5a1e1e', tool = 'accent';
            K.desk(rot, on, {
                floor: [
                    [[-52, 0, 28, 34], 0, 16, 'body', 'face'], [[24, 0, 28, 34], 0, 16, 'body', 'face'],   // raised-panel pedestals
                    [[-52, -6, 104, 3], 0, 16, 'faceDk', 'leg']                                           // finished back
                ],
                top: [[-52, -6, 104, 40], 16, 5, 'topB', 'faceDk'], grain: 7,
                keys: KEYS, mouse: MOUSE,
                under: function (rot) {
                    if (!rot) {
                        K.rect('leg', -24, 18, 48, 16); K.rect('faceDk', -22, 19, 44, 15);                 // recessed modesty panel
                        panel(K, -20, 21, 18, 10, 'face'); panel(K, 2, 21, 18, 10, 'face');
                        [-52, 24].forEach(function (px) {
                            panel(K, px + 2, 19, 24, 5, 'face'); K.rect('pull', px + 11, 21, 6, 1);       // drawer + brass pull
                            panel(K, px + 2, 25, 24, 7, 'face'); panel(K, px + 5, 26, 18, 5, 'body');     // door: raised panel
                            K.rect('pull', px + (px < 0 ? 21 : 5), 28, 2, 2);                            // knob
                            K.rect('faceDk', px, 32, 28, 2); K.rect(K.tone('faceDk', 1.2), px, 32, 28, 1); // plinth
                        });
                    } else if (rot === 180) {
                        var b = K.face(rot, [-52, -6, 104, 3], 0, 16);                                  // the finished back: three raised panels
                        [0, 1, 2].forEach(function (i) { panel(K, b[0] + 4 + i * 33, b[1] + 3, 30, b[3] - 6, 'faceDk'); });
                    } else {
                        var f = K.face(rot, rot === 90 ? [24, 0, 28, 34] : [-52, 0, 28, 34], 0, 16);
                        panel(K, f[0] + 2, f[1] + 2, f[2] - 4, f[3] - 5, 'face'); K.rect('faceDk', f[0], f[1] + f[3] - 2, f[2], 2);
                    }
                },
                onTop: function (rot, t, lift) {
                    var fy = t[1] + t[3] - lift;                                                          // moulded edge: bead + shadow
                    K.rect(K.tone('faceDk', 1.25), t[0], fy + 1, t[2], 1); K.rect(K.tone('faceDk', 0.8), t[0], fy + 3, t[2], 1);
                    var pad = flat(K, rot, [-30, 6, 60, 27], lift, leather, K.tone(leather, 0.7));        // tooled leather writing pad
                    K.rect(tool, pad[0] + 2, pad[1] - lift + 2, pad[2] - 4, 1); K.rect(tool, pad[0] + 2, pad[1] - lift + pad[3] - 3, pad[2] - 4, 1);
                    K.rect(tool, pad[0] + 2, pad[1] - lift + 2, 1, pad[3] - 4); K.rect(tool, pad[0] + pad[2] - 3, pad[1] - lift + 2, 1, pad[3] - 4);
                    onTopThings(K, rot, lift, EXEC.concat([thing(null, -19, -4, 3, function () {      // brass name plate facing the visitors
                        var np = K.turn([-28, -5, 18, 3], rot); K.box(np[0], np[1], np[2], np[3], 21, 3, K.tone('accent', 1.1), { front: K.tone('accent', 0.8) });
                    })]));
                },
                monitor: { bezel: '#1c1f24', stand: '#2b2e33' }
            });
        }
    });
    // ---- CEO Glass: a smoked glass top floating on chrome sled legs, a curved ultrawide screen, a mobile
    //      pedestal under the glass, an orchid and a chrome sculpture; an LED line in the glass edge ----
    var GLASS = [
        thing('orchid', -40, 4, 21, function (cx, cy) {                                              // white orchid in a white pot
            var K = this;
            K.rect('#e9edf0', cx - 4, cy - 5, 8, 6); K.rect('#ffffff', cx - 4, cy - 5, 8, 1); K.rect('#c5cdd2', cx + 3, cy - 4, 1, 5);
            K.rect('#3f7a3a', cx - 6, cy - 7, 6, 2); K.rect('#4f9447', cx, cy - 8, 6, 2);               // two broad leaves
            K.rect('#5b7f3a', cx, cy - 19, 1, 12); K.rect('#5b7f3a', cx + 1, cy - 20, 3, 1);           // the arching stem
            [[cx + 3, cy - 20], [cx + 4, cy - 16], [cx - 3, cy - 18], [cx + 5, cy - 12]].forEach(function (f) {
                K.rect('#fdfdfd', f[0] - 1, f[1] - 1, 3, 3); K.rect('#d81b60', f[0], f[1], 1, 1);
            });
        }),
        thing('sculpture', 39, 4, 13, function (cx, cy) {                                          // chrome sphere on a black cube
            var K = this;
            K.rect('#1d2023', cx - 3, cy - 3, 6, 4); K.rect('#3a3f44', cx - 3, cy - 3, 6, 1);
            disc(K, '#9aa5ab', cx, cy - 8, 4); disc(K, '#cdd5d9', cx - 1, cy - 9, 2); K.rect('#ffffff', cx - 2, cy - 11, 1, 1);
            K.rect('#5f6a70', cx - 3, cy - 5, 6, 1);
        }),
        thing(null, -27, 2, 1, function (cx, cy, rot) {                                               // phone, face down
            var K = this, t = K.turn([-30, -2, 6, 9], rot);
            K.rect('#15171a', t[0], t[1] - 21, t[2], t[3]); K.rect('#3a3f44', t[0] + 1, t[1] - 20, Math.max(1, t[2] - 2), 1);
        })
    ];
    var GLASS_TOP = [-50, -6, 100, 40];
    V.push({
        type: 'bossDesk', id: 'glass', label: 'CEO Glass',
        info: 'A smoked glass top floating on chrome sled legs, one curved ultrawide screen, an orchid and a chrome sculpture.',
        seat: 'sit', colors: ['white', 'black', 'grey', 'white-blue', 'black-gold', 'walnut'],
        screens: [{ plan: [-28, 1, 56, 2], z: 24, h: 21, foot: [-7, -2, 14, 5], bc: '#16181b' }],
        manifest: {
            footprint: [[-48, -28, 96, 62]], footBack: 22,
            projection: bossProj([
                { name: 'top', plan: GLASS_TOP, z: 18, h: 3 }, { name: 'legs', plan: [-48, -6, 96, 40], z: 0, h: 18, open: true },
                { name: 'pedestal', plan: [22, 4, 20, 26], z: 0, h: 15 }].concat(thingParts(GLASS))),
            surface: { rect: [-50, -27, 100, 40], spots: spots({ item: [-40, 4], food: [40, 4], papers: [-27, -6] }),
                spotsAt: { 90: { item: [-6, -46], food: [-8, -20], papers: [-20, -2] }, 180: { item: [36, -48], food: [-36, -48], papers: [0, -30] },
                           270: { item: [6, -46], food: [8, -20], papers: [20, -2] } } },
            seats: bossSeats()
        },
        draw: function (K, rot, C, on) {
            var lift = 21, t = K.turn(GLASS_TOP, rot);
            K.chair(rot, 'behind');
            var legs = [];
            [-48, 45].forEach(function (sx) {                                                         // chrome sled frames
                legs.push([[sx, 28, 3, 3], 0, 18, 'metal'], [[sx, -4, 3, 3], 0, 18, 'metal'], [[sx, -4, 3, 35], 0, 2, 'metal'], [[sx, -4, 3, 35], 16, 2, 'metal']);
            });
            legs.push([[-45, -3, 90, 2], 14, 2, 'metalDk'], [[22, 4, 20, 26], 1, 14, 'body', 'face']);    // back stretcher, mobile pedestal
            K.parts(rot, legs);
            var pf = K.face(rot, [22, 4, 20, 26], 1, 14);                                            // pedestal: drawers, casters
            K.rect('seam', pf[0] + 1, pf[1] + 5, pf[2] - 2, 1); K.rect('seam', pf[0] + 1, pf[1] + 9, pf[2] - 2, 1);
            K.rect('pull', pf[0] + (pf[2] >> 1) - 3, pf[1] + 2, 6, 1); K.rect('#222', pf[0] + 1, pf[1] + pf[3], 2, 1); K.rect('#222', pf[0] + pf[2] - 3, pf[1] + pf[3], 2, 1);
            K.chair(rot, 'side');
            // the glass: a smoked top face, a bright 3 px edge with an LED line, reflections
            var ty = t[1] - lift, fy = t[1] + t[3] - lift;
            K.rect('rgba(150,196,210,0.80)', t[0], ty, t[2], t[3]);
            K.rect('rgba(232,251,255,0.9)', t[0], ty, t[2], 1); K.rect('rgba(232,251,255,0.6)', t[0], ty, 1, t[3]);
            K.rect('rgba(96,150,166,0.95)', t[0], fy, t[2], 3); K.rect('#e8fbff', t[0], fy, t[2], 1); K.rect('accent', t[0] + 2, fy + 2, t[2] - 4, 1);
            for (var i = 0; i < Math.min(t[3] - 2, 16); i++) {                                       // two diagonal glints
                K.rect('rgba(255,255,255,0.30)', t[0] + 6 + i, ty + 1 + i, 3, 1);
                if (i < 10) K.rect('rgba(255,255,255,0.18)', t[0] + 14 + i, ty + 1 + i, 2, 1);
            }
            onTopThings(K, rot, lift, GLASS);
            if (rot) { K.keys(rot, KEYS, lift); K.mouse(rot, MOUSE, lift); }
            K.monitors(rot, on, { bezel: '#16181b', stand: '#c9d1d5' });
            if (!rot) {
                K.rect('#16181b', -28, -43, 7, 1); K.rect('#16181b', 21, -43, 7, 1);              // the curve: taller ends
                K.rect('#16181b', -28, -21, 7, 1); K.rect('#16181b', 21, -21, 7, 1);
                K.rect('rgba(0,0,0,0.25)', -26, -40, 3, 16); K.rect('rgba(0,0,0,0.25)', 23, -40, 3, 16);
                K.keys(rot, KEYS, lift); K.mouse(rot, MOUSE, lift);
            }
            K.chair(rot, 'front');
        }
    });

    // ---- Studio Producer: a 3 m console desk: a 14-channel mixing desk with a meter bridge, studio monitor
    //      speakers on isolation pads, a MIDI pad grid, rack gear in the pedestals, a patch bay, one big screen ----
    var PROD_TOP = [-60, -6, 120, 40];
    var PROD_SPK = [[-58, -2, 11, 9], [47, -2, 11, 9]];
    var PROD_FADERS = [5, 2, 7, 3, 6, 1, 4, 6, 2, 5, 3, 7, 4, 2];
    function prodSpeaker(K, rot, plan) {                                                              // a speaker on an isolation pad
        var t = K.turn(plan, rot), o = side(rot) ? {} : { cap: 1 };
        K.box(t[0], t[1], t[2], t[3], 21, 2, '#3a3d42', o);
        var fy = K.box(t[0], t[1], t[2], t[3], 23, 17, '#1b1d20', Object.assign({ front: '#212428' }, o));
        if (!rot) {                                                                                  // the cones face the sitter (and us, from behind)
            var cx = t[0] + (t[2] >> 1);
            disc(K, '#0c0d0f', cx, fy + 4, 1); K.rect('#5c6166', cx, fy + 3, 1, 1);
            disc(K, 'accent', cx, fy + 11, 4); disc(K, '#14161a', cx, fy + 11, 3); disc(K, '#2a2d32', cx, fy + 11, 1);
        } else if (rot === 180) { K.rect('#2a2d31', t[0] + 2, fy + 3, t[2] - 4, 1); disc(K, '#0c0d0f', t[0] + (t[2] >> 1), fy + 12, 1); }   // back: plate, port
    }
    function prodBridge(K, rot) {                                                                     // meter bridge: a row of LED meters
        var t = K.turn([-36, -3, 72, 4], rot), fy = K.box(t[0], t[1], t[2], t[3], 21, 9, '#202328', { front: '#16181b' });
        if (!rot) for (var i = 0; i < 16; i++) {
            var x = -34 + i * 4 + (i > 13 ? 4 : 0), lv = 2 + (PROD_FADERS[i % 14] % 5);
            K.rect('#0b0c0e', x, fy + 1, 3, 7);
            K.rect('#43a047', x, fy + 8 - lv, 3, Math.min(lv, 4)); if (lv > 4) K.rect('#fdd835', x, fy + 8 - lv, 3, lv - 4); if (lv > 5) K.rect('#e53935', x, fy + 8 - lv, 3, 1);
        } else if (rot === 180) K.rect('#2b2e33', t[0] + 2, fy + 2, t[2] - 4, 1);
        else K.rect('#2b2e33', t[0] + 1, fy + 2, t[2] - 2, 1);
    }
    V.push({
        type: 'bossDesk', id: 'producer', label: 'Studio Producer',
        info: 'A 3 m studio console: a 14-channel mixing desk with meters, studio monitors, a MIDI pad, rack gear and a patch bay.',
        seat: 'sit', colors: ['black', 'black-red', 'walnut', 'black-cyan', 'grey-orange', 'white'],
        screens: [{ plan: [-25, -5, 50, 2], z: 31, h: 25, foot: [-6, -6, 12, 3], bc: '#121417' }],
        manifest: {
            footprint: [[-60, -28, 120, 62]], footBack: 22,
            projection: bossProj([
                { name: 'top', plan: PROD_TOP, z: 16, h: 5 }, { name: 'front', plan: PROD_TOP, z: 0, h: 16, open: true },
                { name: 'back', plan: [-60, -6, 120, 3], z: 0, h: 16 },
                { name: 'bridge', plan: [-36, -3, 72, 4], z: 21, h: 9, upright: true },
                { name: 'spkL', plan: PROD_SPK[0], z: 21, h: 19, upright: true }, { name: 'spkR', plan: PROD_SPK[1], z: 21, h: 19, upright: true }]),
            surface: { rect: [-60, -27, 120, 40], spots: spots({ item: [-50, 4], food: [50, 4], papers: [30, 7] }),
                spotsAt: { 90: { item: [-6, -50], food: [-14, 28], papers: [-20, -2] }, 180: { item: [46, -48], food: [-46, -48], papers: [0, -30] },
                           270: { item: [6, -50], food: [14, 28], papers: [20, -2] } } },
            seats: bossSeats()
        },
        draw: function (K, rot, C, on) {
            var panelC = '#24272c';
            K.desk(rot, on, {
                floor: [
                    [[-60, 0, 24, 34], 0, 16, 'body', 'face'], [[36, 0, 24, 34], 0, 16, 'body', 'face'],      // rack bays
                    [[-60, -6, 120, 3], 0, 16, 'faceDk', 'leg']
                ],
                top: [PROD_TOP, 16, 5, 'topB', 'faceDk'], grain: 0,
                keys: KEYS, mouse: MOUSE,
                under: function (rot) {
                    if (!rot) {
                        [-60, 36].forEach(function (px) {                                              // 3 rack units per bay
                            K.rect('metalDk', px + 1, 18, 22, 16);
                            [19, 24, 29].forEach(function (uy, j) {
                                K.rect('#1c1e22', px + 2, uy, 20, 4); K.rect('#33373d', px + 2, uy, 20, 1); K.rect('metal', px + 2, uy + 1, 1, 2); K.rect('metal', px + 21, uy + 1, 1, 2);
                                for (var k = 0; k < 3; k++) K.rect('#9ea4aa', px + 5 + k * 4 + j, uy + 2, 2, 1);
                                K.rect(j === 1 ? 'accent' : j ? '#ff5252' : '#76ff03', px + 18, uy + 2, 1, 1);
                            });
                        });
                        K.rect('#15171a', -36, 19, 72, 7); K.rect('#2a2d32', -36, 19, 72, 1);             // patch bay
                        for (var x = -34; x < 35; x += 3) { K.rect('#45494f', x, 21, 1, 1); K.rect('#45494f', x, 24, 1, 1); }
                        [[-28, '#e53935', 5], [-13, '#1e88e5', 8], [4, '#fdd835', 6], [19, '#43a047', 4]].forEach(function (pc) {   // patch cables
                            K.rect(pc[1], pc[0], 21, 1, pc[2]); K.rect(pc[1], pc[0], 21 + pc[2], 7, 1); K.rect(pc[1], pc[0] + 6, 24, 1, pc[2] - 3);
                        });
                    } else if (rot === 180) K.rect('seam', -57, -6, 114, 1);
                    else { var f = K.face(rot, rot === 90 ? [36, 0, 24, 34] : [-60, 0, 24, 34], 0, 16); K.inset(f, 'faceDk'); K.rect('#1c1e22', f[0] + 4, f[1] + 6, f[2] - 8, 2); }
                },
                onTop: function (rot, t, lift) {
                    // the mixing desk: channel strips (knobs, fader slots + caps, a channel LED), a master section
                    var c = K.turn([-36, 1, 72, 21], rot), fy = K.box(c[0], c[1], c[2], c[3], 21, 3, panelC, { front: '#1a1c20' }), ty = fy - c[3];
                    K.rect('body', c[0], ty, side(rot) ? c[2] : 2, side(rot) ? 2 : c[3]); K.rect('body', side(rot) ? c[0] : c[0] + c[2] - 2, side(rot) ? fy - 2 : ty, side(rot) ? c[2] : 2, side(rot) ? 2 : c[3]);   // wood end cheeks
                    if (!rot) {
                        for (var i = 0; i < 14; i++) {
                            var x = -33 + i * 4;
                            K.rect('#e53935', x + 1, ty + 2, 1, 1); K.rect('#fdd835', x + 1, ty + 4, 1, 1); K.rect('#43a047', x + 1, ty + 6, 1, 1); K.rect('#1e88e5', x + 1, ty + 8, 1, 1);
                            K.rect('#0e0f11', x + 1, ty + 10, 1, 9); K.rect('#d7dde1', x, ty + 10 + PROD_FADERS[i], 3, 2);
                            K.rect(i % 3 ? '#2e7d32' : '#76ff03', x + 1, ty + 20, 1, 1);
                        }
                        K.rect('#0e0f11', 24, ty + 2, 10, 7); K.rect('accent', 25, ty + 3, 3, 5); K.rect('accent', 30, ty + 4, 3, 4);   // master: meters, fader
                        K.rect('#0e0f11', 28, ty + 10, 1, 9); K.rect('#ff1744', 27, ty + 13, 3, 2);
                    } else {
                        // turned: the channel strips run across the view (knobs at the far end, faders at the sitter's)
                        var kn = ['#e53935', '#fdd835', '#43a047', '#1e88e5'];
                        if (side(rot)) {
                            var back = rot === 90 ? 1 : -1;   // 90: the strip's knob end (plan back) is on the right
                            for (var q = 0; q < 14; q++) {
                                var yy = ty + 3 + Math.floor(q * (c[3] - 6) / 14), x0 = back > 0 ? c[0] + c[2] - 3 : c[0] + 2;
                                for (var n = 0; n < 4; n++) K.rect(kn[n], x0 - back * n * 2, yy, 1, 1);
                                var fx = back > 0 ? c[0] + 2 : c[0] + c[2] - 12; K.rect('#0e0f11', fx, yy, 10, 1); K.rect('#d7dde1', fx + PROD_FADERS[q], yy - 1 + (q % 2), 2, 2);
                            }
                        } else for (var q2 = 0; q2 < 14; q2++) {                                        // 180: the strips seen from the far side
                            var xx = c[0] + 3 + Math.floor(q2 * (c[2] - 6) / 14);
                            for (var n2 = 0; n2 < 4; n2++) K.rect(kn[n2], xx, ty + c[3] - 3 - n2 * 2, 1, 1);
                            K.rect('#0e0f11', xx, ty + 2, 1, 9); K.rect('#d7dde1', xx - 1, ty + 2 + PROD_FADERS[q2], 3, 2);
                        }
                    }
                    flat(K, rot, [-60, 31, 120, 3], lift, '#1d1e20');                                  // padded arm rest along the front
                    var ar = K.turn([-60, 31, 120, 3], rot); K.rect('#3a3c40', ar[0], ar[1] - lift, ar[2], 1);
                    var md = flat(K, rot, [-40, 22, 13, 9], lift, '#1b1d20', '#33363b');              // MIDI pad grid (4 x 4)
                    var pads = ['accent', '#7c4dff', '#00e5ff', 'accent', '#ff9100', 'accent', '#7c4dff', '#00e5ff', '#00e5ff', '#ff9100', 'accent', '#7c4dff', 'accent', '#00e5ff', '#ff9100', 'accent'];
                    for (var p = 0; p < 16; p++) K.rect(pads[p], md[0] + 1 + (p % 4) * Math.floor((md[2] - 1) / 4), md[1] - lift + 1 + (p >> 2) * Math.floor((md[3] - 1) / 4), 2, 2);
                    if (rot) prodBridge(K, rot);
                    PROD_SPK.map(function (pl) { return pl; }).sort(function (a, b) { return K.turn(a, rot)[1] - K.turn(b, rot)[1]; }).forEach(function (pl) { prodSpeaker(K, rot, pl); });
                },
                monitor: { bezel: '#121417', stand: '#2b2e33' },
                last: function (rot) {
                    if (!rot) prodBridge(K, rot);
                    if (!rot) { K.rect('#2b2e33', -52, 12, 4, 2); K.rect('#111', -56, 13, 1, 6); K.rect('#111', -47, 13, 1, 6); K.rect('#111', -55, 12, 8, 1); disc(K, '#202226', -55, 20, 3); disc(K, '#202226', -47, 20, 3); K.rect('accent', -56, 19, 2, 2); K.rect('accent', -48, 19, 2, 2); }   // headphones on a hook under the front edge
                }
            });
        }
    });

    // ---- Architect's Studio: a 2.8 m drafting desk: a tilted drafting board with a blueprint and a T-square,
    //      a flat-file plan chest, a steel trestle, an articulated lamp, a scale model, blueprint rolls, a big screen ----
    var ARCH_TOP = [-56, -6, 112, 40], ARCH_BOARD = [-54, -2, 40, 23];
    var ARCH = [
        thing('lamp', -51, -2, 20, function (cx, cy, rot) {                                          // articulated lamp clamped to the board
            var K = this, d = rot === 180 ? -1 : 1, i, sx = cx;
            K.rect('metalDk', cx - 2, cy - 1, 4, 3);
            if (side(rot)) {                                                                          // in profile: the arm reaches toward us / away
                for (i = 0; i < 14; i++) K.rect('metal', cx, cy - 2 - i, 1, 1);
                K.rect('accent', cx - 3, cy - 19, 6, 4); K.rect(K.tone('accent', 0.7), cx - 3, cy - 16, 6, 1); K.rect('#fff59d', cx - 2, cy - 15, 4, 1);
                return;
            } else {
                for (i = 0; i < 12; i++) K.rect('metal', cx + d * Math.round(i * 0.6), cy - 2 - i, 1, 1);  // lower arm
                for (i = 0; i < 10; i++) K.rect('metal', cx + d * (7 + i), cy - 13 - Math.round(i * 0.5) + (i > 6 ? i - 6 : 0), 1, 1);   // upper arm
                sx = cx + d * 17;
            } K.rect('accent', sx - 4, cy - 17, 8, 4); K.rect('accent', sx - 3, cy - 19, 6, 2); K.rect(K.tone('accent', 0.7), sx - 4, cy - 14, 8, 1);
            K.rect('#fff59d', sx - 3, cy - 13, 6, 1); K.rect('rgba(255,245,157,0.18)', sx - 6, cy - 12, 12, 9);
        }),
        thing('model', 30, 9, 12, function (cx, cy) {                                                 // white scale model on a base board
            var K = this;
            K.rect('#c8b99a', cx - 6, cy - 1, 12, 3); K.rect('#e3d6b8', cx - 6, cy - 1, 12, 1);
            K.rect('#f5f5f5', cx - 4, cy - 11, 4, 10); K.rect('#d9dcde', cx - 1, cy - 11, 1, 10); K.rect('#90caf9', cx - 3, cy - 9, 2, 1); K.rect('#90caf9', cx - 3, cy - 6, 2, 1);
            K.rect('#eceff1', cx + 1, cy - 6, 4, 5); K.rect('#cfd8dc', cx + 4, cy - 6, 1, 5); K.rect('#66bb6a', cx - 6, cy - 3, 2, 2);
        }),
        thing('rolls', 46, 5, 16, function (cx, cy) {                                                 // blueprint rolls in a round bin
            var K = this;
            K.rect('#ffffff', cx - 3, cy - 15, 2, 8); K.rect('#90caf9', cx, cy - 16, 2, 9); K.rect('#e3f2fd', cx + 2, cy - 13, 2, 6); K.rect('#1e5aa8', cx - 1, cy - 12, 2, 6);
            K.rect('accent', cx - 4, cy - 8, 9, 9); K.rect(K.tone('accent', 1.2), cx - 4, cy - 8, 9, 1); K.rect(K.tone('accent', 0.75), cx + 3, cy - 7, 2, 8);
        })
    ];
    V.push({
        type: 'bossDesk', id: 'architect', label: "Architect's Studio",
        info: 'A 2.8 m drafting desk: a tilted board with a blueprint and T-square, a plan chest, a lamp, a scale model and a big screen.',
        seat: 'sit', colors: ['white', 'wood', 'grey', 'black', 'white-blue', 'grey-orange'],
        screens: [{ plan: [2, -2, 48, 2], z: 24, h: 28, foot: [20, -4, 12, 5], bc: '#20262b' }],
        manifest: {
            footprint: [[-56, -28, 112, 62]], footBack: 22,
            projection: bossProj([
                { name: 'top', plan: ARCH_TOP, z: 16, h: 5 }, { name: 'front', plan: ARCH_TOP, z: 0, h: 16, open: true },
                { name: 'board', plan: ARCH_BOARD, z: 21, h: 3 }, { name: 'riser', plan: [-54, -2, 40, 4], z: 21, h: 8, upright: true }].concat(thingParts(ARCH))),
            surface: { rect: [-56, -27, 112, 40], spots: spots({ item: [34, 5], food: [49, 4], papers: [-30, -8] }),
                spotsAt: { 90: { item: [-6, 34], food: [-14, 22], papers: [-20, -2] }, 180: { item: [-26, -48], food: [-46, -48], papers: [0, -30] },
                           270: { item: [6, -48], food: [8, -24], papers: [20, -2] } } },
            seats: bossSeats()
        },
        draw: function (K, rot, C, on) {
            K.desk(rot, on, {
                floor: [
                    [[-56, 0, 34, 34], 0, 16, 'body', 'face'],                                              // flat-file plan chest
                    [[50, 28, 4, 3], 0, 16, 'metal'], [[50, -4, 4, 3], 0, 16, 'metal'], [[50, -4, 4, 35], 0, 2, 'metalDk'],   // steel trestle
                    [[-22, -3, 74, 2], 12, 2, 'metalDk']                                                   // back stretcher
                ],
                top: [ARCH_TOP, 16, 5, 'top', 'face'], grain: 0,
                keys: KEYS, mouse: MOUSE,
                under: function (rot) {
                    if (!rot) {
                        for (var i = 0; i < 5; i++) { K.rect('seam', -55, 21 + i * 3, 32, 1); K.rect('pull', -44, 19 + i * 3, 10, 1); K.rect('#fafafa', -53, 19 + i * 3, 4, 1); }   // 5 shallow drawers, labels
                        K.rect('metalDk', 46, 32, 10, 2); K.rect('metal', 46, 32, 10, 1);   // trestle foot
                    } else if (side(rot)) {
                        var f = K.face(rot, [50, -4, 4, 35], 0, 16);                                     // the trestle's A in profile
                        for (var k = 0; k < 14; k++) { K.rect('metal', f[0] + Math.round(k * f[2] / 28), f[1] + 16 - k, 2, 1); K.rect('metal', f[0] + f[2] - 2 - Math.round(k * f[2] / 28), f[1] + 16 - k, 2, 1); }
                        if (rot === 90) K.inset(K.face(rot, [-56, 0, 34, 34], 0, 16), 'faceDk');
                    }
                },
                onTop: function (rot, t, lift) {
                    K.rect(K.tone('face', 0.85), t[0], t[1] + t[3] - lift + 1, t[2], 1);
                    var b = K.turn(ARCH_BOARD, rot), rz = K.turn([-54, -2, 40, 4], rot);
                    var tilt = rot ? 0 : 6;                                                                // the board rises toward the back
                    K.box(rz[0], rz[1], rz[2], rz[3], 21, 8, 'metalDk', side(rot) ? {} : { cap: 1 });
                    var fy = K.box(b[0], b[1], b[2], b[3], 21, 3, '#e6ece8', { front: '#b9c2bd' }), ty = fy - b[3] - tilt;
                    if (tilt) { K.rect('#e6ece8', b[0], ty, b[2], tilt); K.rect('#f4f8f5', b[0], ty, b[2], 1); for (var w = 0; w < tilt; w++) K.rect('#9aa39e', b[0] + b[2] - 1, ty + w, 1, 1); }
                    var bp = [b[0] + 3, ty + 2, b[2] - 6, fy - ty - 6];                                     // the blueprint
                    K.rect('#1e5aa8', bp[0], bp[1], bp[2], bp[3]);
                    for (var gx = bp[0] + 3; gx < bp[0] + bp[2]; gx += 4) K.rect('rgba(255,255,255,0.14)', gx, bp[1], 1, bp[3]);
                    for (var gy = bp[1] + 3; gy < bp[1] + bp[3]; gy += 4) K.rect('rgba(255,255,255,0.14)', bp[0], gy, bp[2], 1);
                    var ow = Math.max(6, bp[2] - 12), oh = Math.max(6, bp[3] - 10);                         // a floor plan in white lines
                    K.rect('#e3f2fd', bp[0] + 5, bp[1] + 4, ow, 1); K.rect('#e3f2fd', bp[0] + 5, bp[1] + 4 + oh, ow, 1);
                    K.rect('#e3f2fd', bp[0] + 5, bp[1] + 4, 1, oh); K.rect('#e3f2fd', bp[0] + 5 + ow, bp[1] + 4, 1, oh + 1);
                    K.rect('#e3f2fd', bp[0] + 5 + (ow >> 1), bp[1] + 4, 1, oh >> 1); K.rect('#e3f2fd', bp[0] + 5, bp[1] + 4 + (oh >> 1), ow >> 1, 1);
                    K.rect('#ffeb3b', bp[0] + 8, bp[1] + oh, 3, 1);
                    if (!rot) { K.rect('#c8a165', b[0] + 1, ty, 3, fy - ty); K.rect('#a07a42', b[0] + 1, ty + 5, 6, 3); K.rect('#d7b47c', b[0] + 4, fy - 7, b[2] - 8, 2); K.rect('#ff7043', b[0] + 22, fy - 11, 8, 1); }   // T-square, pencil
                    onTopThings(K, rot, lift, ARCH);
                },
                monitor: { bezel: '#20262b', stand: '#9aa5ab' }
            });
        }
    });

    // ---- Captain's Desk: a brass-bound campaign desk: a ship's wheel on the modesty panel with a rope border,
    //      a sea chart, a brass telescope on a tripod, a ship in a bottle, a porthole clock, a compass, one screen ----
    var BRASS = '#c9a24a', BRASS_HI = '#ecd28a', BRASS_DK = '#8d6e2f';
    var CAP_TOP = [-52, -6, 104, 40];
    function wheel(K, cx, cy, r) {                                                                    // a ship's wheel (8 spokes + handles)
        for (var k = 0; k < 8; k++) {
            var a = k * Math.PI / 4;
            for (var d = 1; d <= r + 2; d++) K.rect(d > r ? BRASS_HI : BRASS_DK, cx + Math.round(Math.cos(a) * d), cy + Math.round(Math.sin(a) * d), 1, 1);
        }
        ring(K, BRASS, cx, cy, r); disc(K, BRASS_HI, cx, cy, 1);
    }
    var CAPT = [
        thing('scope', 41, 2, 19, function (cx, cy, rot) {                                          // brass telescope on a tripod
            var K = this, d = rot === 180 || rot === 270 ? 1 : -1, i;
            K.rect('#5d4037', cx - 4, cy, 1, 1); K.rect('#5d4037', cx + 4, cy, 1, 1); K.rect('#5d4037', cx, cy + 1, 1, 1);
            for (i = 0; i < 9; i++) { K.rect('#6d4c41', cx - 4 + Math.round(i * 0.45), cy - i, 1, 1); K.rect('#6d4c41', cx + 4 - Math.round(i * 0.45), cy - i, 1, 1); }
            K.rect('#4e342e', cx, cy - 8, 1, 9);
            for (i = 0; i < 14; i++) K.rect(i < 5 ? BRASS_DK : BRASS, cx - 6 * d + d * i, cy - 9 - Math.round(i * 0.55), 2, i > 9 ? 3 : 2);   // the tube, widening
            K.rect(BRASS_HI, cx - 6 * d + d * 13, cy - 17, 1, 1);
        }),
        thing('clock', 27, -1, 14, function (cx, cy) {                                              // porthole clock on a stand
            var K = this;
            K.rect('faceDk', cx - 4, cy + 1, 9, 2); K.rect('leg', cx - 1, cy - 2, 3, 3);
            disc(K, BRASS, cx, cy - 8, 6); disc(K, '#f3ead2', cx, cy - 8, 4);
            K.rect('#222', cx, cy - 11, 1, 3); K.rect('#222', cx, cy - 8, 3, 1); K.rect(BRASS_HI, cx - 4, cy - 13, 2, 1);
        }),
        thing('bottle', -40, -2, 9, function (cx, cy, rot) {                                         // ship in a bottle on a cradle
            var K = this;
            if (side(rot)) {                                                                          // end on: the glass round the sails
                K.rect('#5d4037', cx - 3, cy + 1, 7, 2); K.rect('rgba(200,235,220,0.55)', cx - 4, cy - 8, 9, 9); K.rect('#e8fff6', cx - 3, cy - 8, 7, 1);
                K.rect('#7a4a2a', cx - 3, cy - 2, 7, 2); K.rect('#fafafa', cx - 2, cy - 7, 5, 4); K.rect('#4e342e', cx, cy - 7, 1, 5); K.rect('#e53935', cx, cy - 8, 2, 1);
                return;
            }
            K.rect('#5d4037', cx - 6, cy + 1, 3, 2); K.rect('#5d4037', cx + 3, cy + 1, 3, 2);
            K.rect('rgba(200,235,220,0.55)', cx - 8, cy - 7, 15, 8); K.rect('#e8fff6', cx - 7, cy - 7, 13, 1); K.rect('rgba(200,235,220,0.8)', cx + 7, cy - 5, 3, 4);
            K.rect('#7a4a2a', cx - 5, cy - 2, 9, 2); K.rect('#3e2723', cx - 4, cy - 1, 7, 1);           // hull
            K.rect('#4e342e', cx - 1, cy - 7, 1, 5); K.rect('#fafafa', cx - 4, cy - 6, 3, 3); K.rect('#fafafa', cx, cy - 6, 3, 3); K.rect('#e53935', cx - 1, cy - 8, 2, 1);
        })
    ];
    V.push({
        type: 'bossDesk', id: 'captain', label: "Captain's Desk",
        info: "A brass-bound campaign desk: a ship's wheel panel, a sea chart, a telescope, a ship in a bottle and a porthole clock.",
        seat: 'sit', colors: ['walnut-brass', 'walnut', 'wood', 'black-gold', 'white-blue', 'grey'],
        screens: [{ plan: [-20, 0, 40, 2], z: 24, h: 24, foot: [-6, -2, 12, 5], bc: '#1b1a17' }],
        manifest: {
            footprint: [[-52, -26, 104, 60]], footBack: 20,   // the art stands 21 px over the turned top's far edge at 90/270
            projection: bossProj([
                { name: 'top', plan: CAP_TOP, z: 16, h: 5 }, { name: 'front', plan: CAP_TOP, z: 0, h: 16, open: true },
                { name: 'back', plan: [-52, -6, 104, 3], z: 0, h: 16 }].concat(thingParts(CAPT))),
            surface: { rect: [-52, -27, 104, 40], spots: spots({ item: [-40, 6], food: [44, 4], papers: [-24, 1] }),
                spotsAt: { 90: { item: [-6, -46], food: [-8, -20], papers: [-20, -2] }, 180: { item: [12, -48], food: [-14, -48], papers: [0, -30] },
                           270: { item: [6, -46], food: [8, -20], papers: [20, -2] } } },
            seats: bossSeats()
        },
        draw: function (K, rot, C, on) {
            var corner = function (f) {                                                              // brass L brackets on a face's corners
                K.rect(BRASS, f[0], f[1], 3, 1); K.rect(BRASS, f[0], f[1], 1, 3); K.rect(BRASS, f[0] + f[2] - 3, f[1], 3, 1); K.rect(BRASS, f[0] + f[2] - 1, f[1], 1, 3);
                K.rect(BRASS, f[0], f[1] + f[3] - 1, 3, 1); K.rect(BRASS, f[0], f[1] + f[3] - 3, 1, 3); K.rect(BRASS, f[0] + f[2] - 3, f[1] + f[3] - 1, 3, 1); K.rect(BRASS, f[0] + f[2] - 1, f[1] + f[3] - 3, 1, 3);
            };
            K.desk(rot, on, {
                floor: [
                    [[-52, 0, 28, 34], 0, 16, 'body', 'face'], [[24, 0, 28, 34], 0, 16, 'body', 'face'],
                    [[-52, -6, 104, 3], 0, 16, 'faceDk', 'leg']
                ],
                top: [CAP_TOP, 16, 5, 'topB', 'faceDk'], grain: 6,
                keys: KEYS, mouse: MOUSE,
                under: function (rot) {
                    if (!rot) {
                        K.rect('leg', -24, 18, 48, 16); K.rect('faceDk', -22, 19, 44, 15);                 // modesty panel: rope border + wheel
                        for (var x = -21; x < 21; x += 2) { K.rect('#c8a96e', x, 20, 1, 1); K.rect('#8d6e3f', x + 1, 20, 1, 1); K.rect('#c8a96e', x, 32, 1, 1); K.rect('#8d6e3f', x + 1, 32, 1, 1); }
                        wheel(K, 0, 26, 4);
                        [-52, 24].forEach(function (px) {                                              // campaign drawers: flush brass handles
                            corner([px, 18, 28, 16]);
                            K.rect('seam', px + 2, 25, 24, 1);
                            K.rect(BRASS_DK, px + 10, 21, 8, 2); K.rect(BRASS, px + 10, 21, 8, 1);
                            K.rect(BRASS_DK, px + 10, 28, 8, 2); K.rect(BRASS, px + 10, 28, 8, 1);
                        });
                    } else if (rot === 180) { corner(K.face(rot, [-52, -6, 104, 3], 0, 16)); K.rect('accent', -50, -6, 100, 1); }
                    else { var f = K.face(rot, rot === 90 ? [24, 0, 28, 34] : [-52, 0, 28, 34], 0, 16); corner(f); wheel(K, f[0] + (f[2] >> 1), f[1] + 8, 3); }
                },
                onTop: function (rot, t, lift) {
                    var ty = t[1] - lift;                                                              // brass corner caps, a thin inlay stripe
                    K.rect(BRASS, t[0], ty, 4, 2); K.rect(BRASS, t[0], ty, 2, 4); K.rect(BRASS, t[0] + t[2] - 4, ty, 4, 2); K.rect(BRASS, t[0] + t[2] - 2, ty, 2, 4);
                    K.rect(BRASS, t[0], ty + t[3] - 2, 4, 2); K.rect(BRASS, t[0] + t[2] - 4, ty + t[3] - 2, 4, 2);
                    K.rect('accentA', t[0] + 5, ty + 3, t[2] - 10, 1); K.rect('accentA', t[0] + 5, ty + t[3] - 4, t[2] - 10, 1);
                    var fy = t[1] + t[3] - lift; K.rect(BRASS_DK, t[0], fy + 2, t[2], 1);
                    var ch = flat(K, rot, [-46, 2, 28, 18], lift, '#e8d9b0', '#b89f6a');                // sea chart: coast, rhumb lines, a rose
                    K.rect('#9fc4d6', ch[0] + 1, ch[1] - lift + 1, Math.max(2, ch[2] >> 1), Math.max(2, ch[3] - 2));
                    K.rect('#a1866a', ch[0] + (ch[2] >> 1), ch[1] - lift + 2, 1, ch[3] - 4); K.rect('#a1866a', ch[0] + (ch[2] >> 1) - 2, ch[1] - lift + 5, 3, 1);
                    K.rect('rgba(120,80,40,0.35)', ch[0] + 2, ch[1] - lift + (ch[3] >> 1), ch[2] - 4, 1); K.rect('rgba(120,80,40,0.35)', ch[0] + (ch[2] >> 2), ch[1] - lift + 1, 1, ch[3] - 2);
                    var rx = ch[0] + ch[2] - 6, ry = ch[1] - lift + ch[3] - 6;
                    K.rect('#b71c1c', rx, ry - 3, 1, 7); K.rect('#b71c1c', rx - 3, ry, 7, 1); K.rect('#5d4037', rx - 1, ry - 1, 3, 3);
                    var cp = K.turn([26, 8, 9, 9], rot), ccx = cp[0] + 4, ccy = cp[1] - lift + 4;        // a brass compass
                    disc(K, BRASS, ccx, ccy, 4); disc(K, '#f3ead2', ccx, ccy, 3); K.rect('#b71c1c', ccx, ccy - 2, 1, 2); K.rect('#263238', ccx, ccy, 1, 2);
                    onTopThings(K, rot, lift, CAPT);
                },
                monitor: { bezel: '#1b1a17', stand: BRASS_DK }
            });
        }
    });

    // ---- Zen Garden: a thick slab with waterfall ends and a kintsugi line, a raked sand garden with stones and
    //      incense, a bonsai in a glazed pot, a cast-iron tea set, one slim screen ----
    var ZEN_TOP = [-52, -6, 104, 40], ZEN_TRAY = [18, -2, 30, 18];
    var ZEN = [
        thing('bonsai', -42, 5, 23, function (cx, cy) {                                              // bonsai: a twisted trunk, three cloud pads
            var K = this;
            K.rect('#3f4f5a', cx - 7, cy - 2, 14, 4); K.rect('#5b7383', cx - 7, cy - 2, 14, 1); K.rect('#2c3840', cx - 6, cy + 2, 2, 1); K.rect('#2c3840', cx + 4, cy + 2, 2, 1);
            K.rect('#6b4f3a', cx - 6, cy - 3, 12, 1);                                                // soil
            K.rect('#5d4037', cx - 1, cy - 8, 3, 6); K.rect('#5d4037', cx + 1, cy - 12, 3, 5); K.rect('#5d4037', cx - 2, cy - 15, 3, 4); K.rect('#4e342e', cx - 4, cy - 11, 4, 2); K.rect('#795548', cx, cy - 7, 1, 4);
            [[cx - 11, cy - 14, 9, 4], [cx + 1, cy - 17, 10, 4], [cx - 5, cy - 22, 9, 4]].forEach(function (pd) {
                K.rect('#2e7d32', pd[0], pd[1] + 1, pd[2], pd[3] - 1); K.rect('#4caf50', pd[0] + 1, pd[1], pd[2] - 2, pd[3] - 1); K.rect('#81c784', pd[0] + 2, pd[1], pd[2] - 5, 1);
            });
        }),
        thing('teapot', -28, 8, 9, function (cx, cy) {                                               // cast-iron teapot + a cup
            var K = this;
            disc(K, '#2b2f33', cx, cy - 4, 4); K.rect('#3e454b', cx - 3, cy - 7, 3, 1); K.rect('#2b2f33', cx + 4, cy - 5, 3, 1); K.rect('#2b2f33', cx + 6, cy - 6, 1, 1);
            K.rect('#3e454b', cx - 1, cy - 9, 2, 1); K.rect('#5d4037', cx - 3, cy - 10, 6, 1); K.rect('#5d4037', cx - 3, cy - 10, 1, 3); K.rect('#5d4037', cx + 2, cy - 10, 1, 3);   // bamboo handle
            K.rect('#e8e2d0', cx + 7, cy - 2, 4, 3); K.rect('#8fae7a', cx + 8, cy - 2, 2, 1);
        }),
        thing('incense', 44, 2, 14, function (cx, cy) {                                             // incense in the sand: a holder, a smoke thread
            var K = this;
            K.rect('#4e342e', cx - 1, cy - 2, 3, 2); K.rect('#8d6e63', cx, cy - 7, 1, 5); K.rect('#ff7043', cx, cy - 8, 1, 1);
            for (var k = 0; k < 6; k++) K.rect('rgba(225,225,230,0.82)', cx + (k % 4 < 2 ? 0 : 1) - (k > 3 ? 1 : 0), cy - 9 - k, 1, 1);
        })
    ];
    V.push({
        type: 'bossDesk', id: 'zen', label: 'Zen Garden',
        info: 'A thick slab with waterfall ends, a raked sand garden with stones and incense, a bonsai, a tea set and one slim screen.',
        seat: 'sit', colors: ['wood', 'white', 'black', 'walnut', 'grey', 'black-green'],
        screens: [{ plan: [-18, 0, 36, 2], z: 23, h: 21, foot: [-5, -2, 10, 4], bc: '#2a2a2a' }],
        manifest: {
            footprint: [[-52, -26, 104, 60]], footBack: 20,
            projection: bossProj([
                { name: 'top', plan: ZEN_TOP, z: 15, h: 6 },
                { name: 'endL', plan: [-52, -6, 6, 40], z: 0, h: 15 }, { name: 'endR', plan: [46, -6, 6, 40], z: 0, h: 15 },
                { name: 'tray', plan: ZEN_TRAY, z: 21, h: 2 }].concat(thingParts(ZEN))),
            surface: { rect: [-52, -27, 104, 40], spots: spots({ item: [-40, 6], food: [43, 6], papers: [-26, 2] }),
                spotsAt: { 90: { item: [-16, -46], food: [-8, -22], papers: [-20, -2] }, 180: { item: [36, -48], food: [-8, -48], papers: [0, -30] },
                           270: { item: [12, -31], food: [12, -15], papers: [20, -2] } } },
            seats: bossSeats()
        },
        draw: function (K, rot, C, on) {
            var grainV = function (f) { for (var gx = f[0] + 2; gx < f[0] + f[2] - 1; gx += 3) K.rect('rgba(0,0,0,0.07)', gx, f[1] + 1, 1, f[3] - 2); };
            K.desk(rot, on, {
                floor: [
                    [[-52, -6, 6, 40], 0, 15, 'top', 'face'], [[46, -6, 6, 40], 0, 15, 'top', 'face'],     // waterfall ends
                    [[-46, 28, 92, 2], 2, 2, 'leg']                                                         // low foot rail
                ],
                top: [ZEN_TOP, 15, 6, 'top', 'face'], grain: 5,
                keys: KEYS, mouse: MOUSE,
                under: function (rot) {
                    [[-52, -6, 6, 40], [46, -6, 6, 40]].forEach(function (pl) { grainV(K.face(rot, pl, 0, 15)); });
                    if (!rot) { K.rect('accentA', -50, 22, 1, 4); K.rect('accentA', -49, 26, 1, 5); K.rect('accentA', -50, 31, 1, 3); }   // kintsugi seam
                    else if (side(rot)) { var f = K.face(rot, rot === 90 ? [46, -6, 6, 40] : [-52, -6, 6, 40], 0, 15); K.rect('accentA', f[0] + 9, f[1] + 2, 6, 1); K.rect('accentA', f[0] + 15, f[1] + 3, 5, 1); K.rect('accentA', f[0] + 20, f[1] + 4, 7, 1); }
                    else { var g = K.face(rot, [46, -6, 6, 40], 0, 15); K.rect('accentA', g[0] + 2, g[1] + 3, 1, 4); K.rect('accentA', g[0] + 3, g[1] + 7, 1, 5); K.rect('accentA', g[0] + 2, g[1] + 12, 1, 2); }   // 180: the seam on the far end
                },
                onTop: function (rot, t, lift) {
                    grainV(K.face(rot, ZEN_TOP, 15, 6));
                    // the sand garden: a low frame, raked lines along its length, rings round two stones, incense
                    var tr = K.turn(ZEN_TRAY, rot), fy = K.box(tr[0], tr[1], tr[2], tr[3], 21, 2, 'face', { front: 'faceDk' }), sx = tr[0] + 1, sy = fy - tr[3] + 1, sw = tr[2] - 2, sh = tr[3] - 2;
                    K.rect('#e9dfc6', sx, sy, sw, sh);
                    if (sw >= sh) for (var ly = sy + 1; ly < sy + sh; ly += 2) K.rect('#d3c6a6', sx, ly, sw, 1);
                    else for (var lx = sx + 1; lx < sx + sw; lx += 2) K.rect('#d3c6a6', lx, sy, 1, sh);
                    var st = [[0.32, 0.45, 3], [0.74, 0.62, 2]];
                    st.forEach(function (q) {
                        var qx = Math.round(sx + q[0] * sw), qy = Math.round(sy + q[1] * sh);
                        disc(K, '#e9dfc6', qx, qy, q[2] + 3); ring(K, '#d3c6a6', qx, qy, q[2] + 3); ring(K, '#d3c6a6', qx, qy, q[2] + 1);
                        disc(K, '#5f6366', qx, qy, q[2]); K.rect('#8a8f93', qx - 1, qy - q[2], 2, 1);
                    });
                    onTopThings(K, rot, lift, ZEN);
                },
                monitor: { bezel: '#2a2a2a', stand: '#b0a58f' }
            });
        }
    });

    // ---- Data Ops: an ops desk with a 2 x 2 screen wall on a pole and a full server rack beside it: servers with
    //      status LEDs, a switch, a patch panel, a stack light on top; a cable tray, a rubber duck ----
    var OPS_TOP = [-50, -6, 100, 40], OPS_RACK = [52, -8, 22, 24];
    var OPS = [
        thing(null, -40, 2, 6, function (cx, cy) {                                                  // rubber duck (debugging)
            var K = this;
            K.rect('#fdd835', cx - 3, cy - 3, 6, 4); K.rect('#fdd835', cx - 2, cy - 6, 4, 3); K.rect('#fb8c00', cx + 2, cy - 5, 2, 1); K.rect('#212121', cx, cy - 5, 1, 1); K.rect('#fff59d', cx - 2, cy - 3, 3, 1);
        })
    ];
    var OPS_BEACON = [thing('beacon', 63, 14, 9, function (cx, cy) {                                // stack light: green / amber / red
        var K = this;
        K.rect('#37474f', cx - 2, cy - 1, 5, 2); K.rect('#76ff03', cx - 1, cy - 4, 3, 3); K.rect('#ffab00', cx - 1, cy - 7, 3, 3); K.rect('#ff1744', cx - 1, cy - 9, 3, 2);
        K.rect('rgba(255,255,255,0.5)', cx - 1, cy - 4, 1, 1);
    })];
    function opsRack(K, rot) {
        var t = K.turn(OPS_RACK, rot), o = side(rot) ? {} : { cap: 1 };
        var fy = K.box(t[0], t[1], t[2], t[3], 0, 58, 'metalDk', Object.assign({ front: '#17191c' }, o)), x = t[0], w = t[2];
        if (!rot) {                                                                                 // the front: rails and units
            K.rect('metal', x + 1, fy + 1, 2, 56); K.rect('metal', x + w - 3, fy + 1, 2, 56);
            var u = [[3, 'srv'], [3, 'srv'], [4, 'sw'], [3, 'patch'], [5, 'srv2'], [3, 'srv'], [5, 'srv2'], [4, 'kvm'], [3, 'srv'], [6, 'ups']], y = fy + 2;
            u.forEach(function (q, i) {
                var h = q[0], ux = x + 4, uw = w - 8;
                K.rect('#23272b', ux, y, uw, h - 1); K.rect('#30353a', ux, y, uw, 1);
                if (q[1] === 'sw') for (var p = 0; p < 7; p++) { K.rect('#0b0c0e', ux + 1 + p * 2, y + 1, 1, 2); K.rect(p % 3 ? '#76ff03' : '#ffab00', ux + 1 + p * 2, y + 1, 1, 1); }
                else if (q[1] === 'patch') { for (var c = 0; c < 6; c++) K.rect(['#1e88e5', '#fdd835', '#e53935', '#1e88e5', '#43a047', '#fdd835'][c], ux + 1 + c * 2, y + 1, 1, 2); }
                else if (q[1] === 'kvm') { K.rect('#0d1b2a', ux + 2, y + 1, uw - 4, 2); K.rect('accent', ux + 3, y + 1, 4, 1); }
                else if (q[1] === 'ups') { K.rect('#0b0c0e', ux + 2, y + 1, 5, 3); K.rect('#76ff03', ux + 3, y + 2, 3, 1); for (var v = 0; v < 3; v++) K.rect('#15171a', ux + 9, y + 1 + v, uw - 10, 1); }
                else {
                    for (var vv = 0; vv < h - 2; vv++) K.rect('#15171a', ux + 1, y + 1 + vv, uw - 6, 1);
                    K.rect(i % 2 ? 'accent' : '#76ff03', ux + uw - 4, y + 1, 1, 1); K.rect(i % 3 ? '#76ff03' : '#ffab00', ux + uw - 2, y + 1, 1, 1);
                    if (q[1] === 'srv2') K.rect('#1e88e5', ux + uw - 4, y + 3, 1, 1);
                }
                y += h;
            });
        } else if (rot === 180) {                                                                   // the back: a perforated door, a handle
            for (var gy = fy + 2; gy < fy + 56; gy += 2) for (var gx = x + 2; gx < x + w - 2; gx += 2) K.rect('#2a2e33', gx, gy, 1, 1);
            K.rect('metal', x + w - 3, fy + 22, 1, 8);
        } else {                                                                                    // the side panel: vents, a badge
            for (var sv = 0; sv < 5; sv++) K.rect('#121416', x + 4, fy + 6 + sv * 2, w - 8, 1);
            K.rect('accent', x + 4, fy + 48, 6, 2);
        }
        onTopThings(K, rot, 58, OPS_BEACON);
    }
    V.push({
        type: 'bossDesk', id: 'dataops', label: 'Data Ops',
        info: 'An ops desk with a 2x2 screen wall on a pole and a full server rack beside it: blinking servers, a switch, a stack light.',
        seat: 'sit', colors: ['black-cyan', 'black-green', 'black', 'grey', 'white-blue', 'grey-orange'],
        screens: [   // raised row first (it stands on the pole behind the lower row)
            { plan: [-31, -2, 30, 2], z: 47, h: 21, foot: [-4, -5, 8, 4], bc: '#111317' }, { plan: [1, -2, 30, 2], z: 47, h: 21, foot: [-4, -5, 8, 4], bc: '#111317' },
            { plan: [-31, 0, 30, 2], z: 25, h: 21, foot: [-4, -5, 8, 4], bc: '#111317' }, { plan: [1, 0, 30, 2], z: 25, h: 21, foot: [-4, -5, 8, 4], bc: '#111317' }
        ],
        manifest: {
            footprint: [[-50, -26, 100, 60], [50, -28, 24, 44]], footBack: 20,
            projection: bossProj([
                { name: 'top', plan: OPS_TOP, z: 16, h: 5 }, { name: 'front', plan: OPS_TOP, z: 0, h: 16, open: true },
                { name: 'rack', plan: OPS_RACK, z: 0, h: 58, upright: true }].concat(thingParts(OPS), thingParts(OPS_BEACON, 58))),
            surface: { rect: [-50, -27, 100, 40], spots: spots({ item: [-40, 4], food: [41, 4], papers: [-26, 1] }),
                spotsAt: { 90: { item: [-12, -52], food: [-8, -24], papers: [-20, -2] }, 180: { item: [42, -44], food: [-42, -44], papers: [0, -30] },
                           270: { item: [12, -24], food: [8, 6], papers: [20, -2] } } },
            seats: bossSeats()
        },
        draw: function (K, rot, C, on) {
            var near = rot === 0 || rot === 90;                                                       // the rack is nearer the camera than the desk
            K.desk(rot, on, {
                floor: [
                    [[-50, -6, 4, 40], 0, 16, 'metalDk', 'metal'], [[46, -6, 4, 40], 0, 16, 'metalDk', 'metal'],   // panel legs
                    [[-46, -4, 92, 4], 10, 3, 'metalDk']                                                 // cable tray
                ],
                top: [OPS_TOP, 16, 5, 'topB', 'faceDk'], grain: 0,
                keys: KEYS, mouse: MOUSE,
                under: function (rot) {
                    if (!near) opsRack(K, rot);
                    if (rot === 180) {                                                                  // cables hanging from the tray
                        [[-30, '#1e88e5', 6], [-24, '#fdd835', 9], [-10, '#e53935', 5], [12, '#1e88e5', 8], [30, '#43a047', 6]].forEach(function (c) { K.rect(c[1], c[0], -6, 1, c[2]); });
                    } else if (!rot) { K.rect('#1e88e5', 46, 24, 6, 1); K.rect('#fdd835', 46, 27, 6, 1); }  // cables into the rack
                    var f = K.face(rot, rot === 180 ? [46, -6, 4, 40] : [-50, -6, 4, 40], 0, 16);
                    if (f[2] > 6) K.inset(f, 'metal');
                },
                onTop: function (rot, t, lift) {
                    var fy = t[1] + t[3] - lift; K.rect('accent', t[0] + 2, fy + 2, t[2] - 4, 1);       // lit edge
                    var mt = flat(K, rot, [-30, 18, 64, 14], lift, '#1b1f24', 'accentA');                // desk mat
                    onTopThings(K, rot, lift, OPS);
                },
                monitor: { bezel: '#111317', stand: '#3b4148' },
                last: function (rot) {
                    if (near) opsRack(K, rot);
                    if (!rot) { K.rect('#3b4148', -1, -47, 2, 3); }                                       // the pole between the rows
                }
            });
        }
    });

    // ---- Gaming Throne: a 3 m battle station: three screens, a glass-panel RGB tower as the right pedestal, an
    //      angular leg with lit inserts, a rainbow strip in the front edge, an XL mat, a headset stand, a controller ----
    var GAME_TOP = [-60, -6, 120, 40], GAME_PC = [42, 6, 18, 26], RAINBOW = ['#ff1744', '#ff9100', '#ffea00', '#76ff03', '#00e5ff', '#2979ff', '#d500f9'];
    var GAME = [
        thing('headset', -48, 13, 17, function (cx, cy) {                                             // headset on a stand
            var K = this;
            K.rect('#26282c', cx - 4, cy, 8, 2); K.rect('#3a3d42', cx - 4, cy, 8, 1); K.rect('#3a3d42', cx, cy - 11, 1, 11);
            K.rect('#1b1c1f', cx - 5, cy - 15, 11, 2); K.rect('#1b1c1f', cx - 6, cy - 13, 2, 3); K.rect('#1b1c1f', cx + 5, cy - 13, 2, 3);
            K.rect('#1b1c1f', cx - 7, cy - 10, 3, 6); K.rect('#1b1c1f', cx + 5, cy - 10, 3, 6); K.rect('accent', cx - 7, cy - 9, 1, 4); K.rect('accent', cx + 7, cy - 9, 1, 4);
        })
    ];
    function rainbow(K, x, y, w, h) { var n = RAINBOW.length; for (var i = 0; i < n; i++) { var a = x + Math.floor(i * w / n), b = x + Math.floor((i + 1) * w / n); K.rect(RAINBOW[i], a, y, b - a, h); } }
    V.push({
        type: 'bossDesk', id: 'gaming', label: 'Gaming Throne',
        info: 'A 3 m battle station: three screens, a glass-panel RGB tower, a rainbow edge strip, an XL mat and a headset stand.',
        seat: 'sit', colors: ['black-red', 'black-cyan', 'black-green', 'white-pink', 'black', 'white-blue'],
        screens: [
            { plan: [-58, 4, 34, 2], z: 24, h: 22, foot: [-46, 2, 10, 4], bc: '#0d0d0f' },
            { plan: [-20, 0, 40, 2], z: 24, h: 25, foot: [-5, -2, 10, 4], bc: '#0d0d0f' },
            { plan: [24, 4, 34, 2], z: 24, h: 22, foot: [36, 2, 10, 4], bc: '#0d0d0f' }
        ],
        manifest: {
            footprint: [[-60, -26, 120, 60]], footBack: 20,
            projection: bossProj([
                { name: 'top', plan: GAME_TOP, z: 16, h: 5 }, { name: 'front', plan: GAME_TOP, z: 0, h: 16, open: true }].concat(thingParts(GAME))),
            surface: { rect: [-60, -27, 120, 40], spots: spots({ item: [-50, 5], food: [49, 4], papers: [-26, 1] }),
                spotsAt: { 90: { item: [-22, -50], food: [-8, -22], papers: [-20, -2] }, 180: { item: [26, -48], food: [-26, -48], papers: [0, -30] },
                           270: { item: [22, -50], food: [8, -22], papers: [20, -2] } } },
            seats: bossSeats()
        },
        draw: function (K, rot, C, on) {
            K.desk(rot, on, {
                floor: [
                    [[-60, 26, 5, 4], 0, 16, 'metalDk', 'metal'], [[-60, -4, 5, 4], 0, 16, 'metalDk', 'metal'], [[-60, -4, 5, 34], 0, 2, 'metalDk'],   // the angular leg
                    [GAME_PC, 0, 16, '#1a1b1e', '#141518']                                                  // the tower (right pedestal)
                ],
                top: [GAME_TOP, 16, 5, 'topB', 'faceDk'], grain: 0,
                keys: KEYS, mouse: MOUSE,
                under: function (rot) {
                    var pc = K.face(rot, GAME_PC, 0, 16), cx = pc[0] + (pc[2] >> 1);
                    if (!rot) {                                                                         // the tower's front: mesh, two RGB ring fans, power
                        for (var my = pc[1] + 2; my < pc[1] + 15; my += 2) K.rect('#22242a', pc[0] + 2, my, pc[2] - 4, 1);
                        ring(K, 'accent', cx, pc[1] + 5, 3); ring(K, 'accent', cx, pc[1] + 11, 3); K.rect('#ffffff', pc[0] + pc[2] - 3, pc[1] + 1, 1, 1);
                        K.rect('accentA', -54, 30, 95, 4);                                              // under-desk glow on the floor
                        K.rect('accent', -58, 19, 1, 10);                                               // lit insert in the leg
                    } else if (rot === 90) {                                                            // the glass side: GPU, RAM, fans glowing
                        K.rect('#0c0d10', pc[0] + 1, pc[1] + 1, pc[2] - 2, pc[3] - 2); K.rect('accentA', pc[0] + 1, pc[1] + 1, pc[2] - 2, pc[3] - 2);
                        K.rect('#2b2e35', pc[0] + 3, pc[1] + 8, pc[2] - 8, 3); K.rect('accent', pc[0] + 3, pc[1] + 11, pc[2] - 8, 1);   // GPU
                        rainbow(K, pc[0] + 4, pc[1] + 2, 8, 4); for (var r = 0; r < 4; r++) K.rect('#0c0d10', pc[0] + 5 + r * 2, pc[1] + 2, 1, 4);   // RAM
                        ring(K, 'accent', pc[0] + pc[2] - 5, pc[1] + 5, 3); K.rect('rgba(255,255,255,0.18)', pc[0] + 2, pc[1] + 1, 2, pc[3] - 2);
                    } else if (rot === 180) {                                                           // the back: exhaust fan, I/O
                        ring(K, '#3a3d42', pc[0] + 5, pc[1] + 5, 3); K.rect('#3a3d42', pc[0] + 10, pc[1] + 2, 4, 6); K.rect('#1e88e5', pc[0] + 11, pc[1] + 3, 2, 1); K.rect('#43a047', pc[0] + 11, pc[1] + 5, 2, 1);
                    } else {
                        K.inset(pc, '#26282c');
                        var lg = K.face(rot, [-60, -4, 5, 34], 0, 16);                                 // the leg's brace in profile
                        for (var k = 0; k < 14; k++) K.rect('metal', lg[0] + Math.round(k * (lg[2] - 4) / 14), lg[1] + 14 - k, 2, 1);
                    }
                    if (rot === 90) { var lg2 = K.face(rot, [-60, -4, 5, 34], 0, 16); for (var k2 = 0; k2 < 14; k2++) K.rect('metal', lg2[0] + Math.round(k2 * (lg2[2] - 4) / 14), lg2[1] + 14 - k2, 2, 1); }
                },
                onTop: function (rot, t, lift) {
                    var fy = t[1] + t[3] - lift;                                                        // rainbow strip in the front edge
                    if (side(rot)) K.rect(RAINBOW[rot === 90 ? 0 : 4], t[0] + 1, fy + 2, t[2] - 2, 1);           // (the strip's end in profile)
                    else rainbow(K, t[0] + 2, fy + 2, t[2] - 4, 1);
                    var mat = flat(K, rot, [-42, 17, 84, 15], lift, '#141518', 'accent');              // XL mat with a lit border
                    var cp = K.turn([-31, 8, 10, 6], rot);                                              // a controller
                    K.rect('#26282c', cp[0], cp[1] - lift, cp[2], cp[3]); K.rect('accent', cp[0] + cp[2] - 3, cp[1] - lift + 1, 1, 1); K.rect('#76ff03', cp[0] + cp[2] - 2, cp[1] - lift + 2, 1, 1); K.rect('#5c6166', cp[0] + 2, cp[1] - lift + 2, 2, 1);
                    onTopThings(K, rot, lift, GAME);
                },
                monitor: { bezel: '#0d0d0f', stand: '#26282c' },
                last: function (rot) {
                    if (!rot) { K.rect('accentA', -16, 9, 32, 1); K.rect('accent', 17, 9, 6, 1); }      // keyboard + mouse underglow
                }
            });
        }
    });

    // ======================================================================================
    // Standing boss desks (seat 'stand'). A standing agent's hands land 26 px above the feet seen from
    // behind (the rear desk arms at body -26/-27, the body origin on the feet), 3 above them at 180
    // (forearms onto the near edge) and 8-12 px ahead in profile. So the base stands back under the top
    // (the top overhangs ~14 px like a lectern's) and the feet stand under the overhang: the hands then
    // land on the keys at 0, and on them at 90 / 180 / 270 with the feet where the stand seat puts them.
    // ======================================================================================
    function standSeat(o) {
        // floor (rot 0): the walk ends in front of the top (the clearance contract), then the person steps in under it
        return [{ id: 'stand', kind: 'bossDesk', spot: [0, 0], x: 0, y: o.y0, facing: 'up', legs: 'stand', floor: [0, o.f0],
            at: { 90: { x: -o.side, y: 0, legs: 'stand', floor: [-o.floor, 0] }, 180: { x: 0, y: o.y180, legs: 'stand', front: ['monitor'] },
                  270: { x: o.side, y: 0, legs: 'stand', floor: [o.floor, 0] } } }];
    }

    // ---- Executive Lectern: a wood podium with a cantilevered sloped top, carved corbels, a crest, a leather
    //      inlay, two screens on a pole at eye height, a brass clock ----
    var LECT_TOP = [-40, -18, 80, 28], LECT_BASE = [-40, -18, 80, 14], LECT_KEYS = [-14, 1, 28, 7], LECT_MOUSE = [18, 2, 4, 6];
    var LECT = [
        thing('clock', -32, -12, 10, function (cx, cy) {                                             // brass carriage clock
            var K = this;
            K.rect(BRASS_DK, cx - 4, cy - 1, 8, 2); K.rect(BRASS, cx - 3, cy - 8, 6, 7); K.rect(BRASS_HI, cx - 3, cy - 8, 6, 1); K.rect(BRASS, cx - 1, cy - 10, 2, 2);
            K.rect('#f3ead2', cx - 2, cy - 6, 4, 4); K.rect('#222', cx, cy - 5, 1, 2);
        })
    ];
    V.push({
        type: 'bossDesk', id: 'exec-standing', label: 'Executive Lectern',
        info: 'A standing executive desk: a wood podium with a sloped cantilevered top, a crest, a leather inlay and two screens at eye height.',
        seat: 'stand', colors: ['walnut', 'wood', 'walnut-brass', 'black-gold', 'black', 'white'],
        screens: [{ plan: [-36, -15, 34, 2], z: 44, h: 21, foot: [-3, -17, 6, 3], bc: '#1c1f24' }, { plan: [2, -15, 34, 2], z: 44, h: 21, foot: [-3, -17, 6, 3], bc: '#1c1f24' }],
        screenTop: 30,
        manifest: {
            footprint: [[-40, -30, 80, 26]], footBack: 12,      // the podium; the top overhangs it 14 px at the front
            projection: { class: 'low', views: { 0: 'front', 90: 'side', 180: 'back', 270: 'side' }, parts: [
                { name: 'top', plan: LECT_TOP, z: 26, h: 4 }, { name: 'podium', plan: LECT_BASE, z: 0, h: 26 },
                { name: 'keyboard', plan: LECT_KEYS, z: 30, h: 0, flat: true }].concat(thingParts(LECT, 30)) },
            parts: [{ name: 'body', rect: 'proj', base: -1 }],
            surface: { rect: [-40, -48, 80, 28], spots: spots({ item: [-30, -27], food: [31, -27], papers: [-20, -38] }, 30, LECT_KEYS, LECT_MOUSE),
                // turned: off the turned keys; at 180 below the raised screen backs (they cover the far half)
                spotsAt: { 90: { item: [2, -54], food: [4, -4], papers: [6, -30] }, 180: { item: [26, -20], food: [-26, -20], papers: [-14, -22] },
                           270: { item: [-2, -54], food: [-4, -4], papers: [-6, -30] } } },
            seats: standSeat({ y0: 1, f0: 13, side: 14, floor: 14, y180: -32 })
        },
        draw: function (K, rot, C, on) {
            var lift = 30, inlay = C.id === 'white' ? '#1f3554' : '#5a1e1e';
            K.parts(rot, [[LECT_BASE, 0, 26, 'body', 'face']]);
            var b = K.face(rot, LECT_BASE, 0, 26);
            if (!rot) {                                                                              // podium front: raised panels, a crest
                panel(K, b[0] + 4, b[1] + 15, 30, 9, 'face'); panel(K, b[0] + b[2] - 34, b[1] + 15, 30, 9, 'face');
                K.rect('accent', -2, b[1] + 16, 4, 4); K.rect(K.tone('accent', 0.7), -1, b[1] + 17, 2, 2); K.rect('faceDk', b[0], b[1] + b[3] - 2, b[2], 2);
            } else if (rot === 180) {                                                                // the back: one panel, two accent studs at its top corners
                panel(K, b[0] + 3, b[1] + 3, b[2] - 6, b[3] - 7, 'face'); K.rect('faceDk', b[0], b[1] + b[3] - 2, b[2], 2);
                [b[0] + 6, b[0] + b[2] - 8].forEach(function (x) { K.rect('accent', x, b[1] + 5, 2, 2); K.rect(K.tone('accent', 0.7), x, b[1] + 6, 2, 1); });
            }
            else { panel(K, b[0] + 2, b[1] + 3, b[2] - 4, b[3] - 7, 'face'); K.rect('faceDk', b[0], b[1] + b[3] - 2, b[2], 2); }
            // carved corbels under the overhang (0: seen from behind the person, at the podium's front corners)
            if (!rot) [-38, 33].forEach(function (x) { for (var k = 0; k < 5; k++) K.rect('face', x, -20 + k, 5 - k, 1); });
            var t = K.turn(LECT_TOP, rot), tilt = rot ? 0 : 3;
            var fy = K.box(t[0], t[1], t[2], t[3], 26, 4, 'topB', { front: 'faceDk' }), ty = fy - t[3] - tilt;
            if (tilt) { K.rect('topB', t[0], ty, t[2], tilt); K.rect(K.tone('topB', 1.12), t[0], ty, t[2], 1); }   // the slope rises to the back
            K.rect(K.tone('faceDk', 1.3), t[0], fy - 1, t[2], 1);                                    // the front lip
            var pd = flat(K, rot, [-24, -6, 48, 15], lift, inlay, K.tone(inlay, 0.7));               // leather inlay
            K.rect('accent', pd[0] + 2, pd[1] - lift + 2, pd[2] - 4, 1);                             // gold tooling (accent: every turn)
            onTopThings(K, rot, lift, LECT);
            if (rot) { K.keys(rot, LECT_KEYS, lift); K.mouse(rot, LECT_MOUSE, lift); }
            K.monitors(rot, on, { bezel: '#1c1f24', stand: '#2b2e33' });
            if (!rot) { K.rect('#2b2e33', -1, -45, 2, 3); K.keys(rot, LECT_KEYS, lift); K.mouse(rot, LECT_MOUSE, lift); }
        }
    });

    // ---- War Table: a standing command table: the whole top a glowing tactical touch map (grid, landmass, radar,
    //      units, a route, a touch keyboard) on a lit plinth, a status screen on a post at the far edge ----
    var WT_TOP = [-48, -24, 96, 40], WT_BASE = [-36, -16, 72, 14], WT_KEYS = [-14, 3, 28, 7], WT_MOUSE = [18, 4, 4, 5];
    V.push({
        type: 'bossDesk', id: 'war-table', label: 'War Table',
        info: 'A standing command table: the whole top a glowing tactical touch map with radar and units, on a lit plinth, a status screen.',
        seat: 'stand', colors: ['black-cyan', 'black-red', 'black-green', 'grey-orange', 'black-gold', 'white-blue'],
        screens: [{ plan: [-30, -23, 60, 2], z: 44, h: 24, foot: [-2, -24, 4, 2], bc: '#0e1116' }],
        screenTop: 30,
        manifest: {
            footprint: [[-36, -28, 72, 26]], footBack: 12,      // the plinth; the map top overhangs it on every side
            projection: { class: 'low', views: { 0: 'front', 90: 'side', 180: 'back', 270: 'side' }, parts: [
                { name: 'top', plan: WT_TOP, z: 26, h: 4 }, { name: 'plinth', plan: WT_BASE, z: 0, h: 26 },
                { name: 'keyboard', plan: WT_KEYS, z: 30, h: 0, flat: true }] },
            parts: [{ name: 'body', rect: 'proj', base: -1 }],
            surface: { rect: [-48, -54, 96, 40], spots: spots({ item: [-34, -26], food: [36, -24], papers: [-22, -40] }, 30, WT_KEYS, WT_MOUSE),
                spotsAt: { 90: { item: [6, -56], food: [6, 4], papers: [8, -30] }, 180: { item: [38, -14], food: [-38, -14], papers: [-16, -12] },
                           270: { item: [-6, -56], food: [-6, 4], papers: [-8, -30] } } },
            seats: standSeat({ y0: 6, f0: 15, side: 16, floor: 14, y180: -34 })   // feet 4 px clear of the footprint (the torso clears the top)
        },
        draw: function (K, rot, C, on) {
            var lift = 30;
            K.parts(rot, [[WT_BASE, 0, 26, 'body', 'face']]);
            var b = K.face(rot, WT_BASE, 0, 26);
            for (var sx = b[0] + 4; sx < b[0] + b[2] - 3; sx += 8) K.rect('accent', sx, b[1] + b[3] - 9, 1, 6);   // lit slits
            K.rect('faceDk', b[0], b[1] + b[3] - 2, b[2], 2); K.rect('accentA', b[0] + 1, b[1] + b[3] - 3, b[2] - 2, 1);
            var t = K.turn(WT_TOP, rot), fy = K.box(t[0], t[1], t[2], t[3], 26, 4, 'metalDk', { front: 'leg' });
            K.rect('accent', t[0] + 2, fy + 2, t[2] - 4, 1);                                        // lit edge
            var x = t[0] + 2, y = fy - t[3] + 2, w = t[2] - 4, h = t[3] - 4, X = function (f) { return x + Math.round(f * w); }, Y = function (f) { return y + Math.round(f * h); };
            K.rect('#08131d', x, y, w, h);
            for (var gx = x + 3; gx < x + w; gx += 6) K.rect('accentA', gx, y, 1, h);              // grid
            for (var gy = y + 3; gy < y + h; gy += 6) K.rect('accentA', x, gy, w, 1);
            [[0.08, 0.15, 0.32, 0.45], [0.22, 0.45, 0.25, 0.4], [0.55, 0.55, 0.3, 0.3], [0.62, 0.1, 0.2, 0.3]].forEach(function (q) {   // landmasses, coast lines
                var a = X(q[0]), c = Y(q[1]), aw = Math.max(3, Math.round(q[2] * w)), ch = Math.max(3, Math.round(q[3] * h));
                K.rect('#123247', a, c, aw, ch); K.rect('accent', a, c, aw, 1); K.rect('accent', a, c, 1, ch); K.rect(K.tone('accent', 0.6), a + aw - 1, c, 1, ch); K.rect(K.tone('accent', 0.6), a, c + ch - 1, aw, 1);
            });
            var rx = X(0.78), ry = Y(0.62), rr = Math.max(4, Math.min(8, Math.round(Math.min(w, h) * 0.22)));   // radar: rings, a sweep, a blip
            ring(K, 'accent', rx, ry, rr); ring(K, 'accentA', rx, ry, rr >> 1);
            for (var k = 0; k < rr; k++) K.rect('#e0f7fa', rx + k, ry - Math.round(k * 0.6), 1, 1);
            K.rect('#ff5252', rx - 2, ry + 2, 2, 2);
            [[0.2, 0.3], [0.26, 0.36], [0.35, 0.62], [0.12, 0.7]].forEach(function (u) { K.rect('#40c4ff', X(u[0]), Y(u[1]), 2, 2); });   // own units
            [[0.6, 0.22], [0.7, 0.3], [0.66, 0.68]].forEach(function (u) { K.rect('#ff5252', X(u[0]), Y(u[1]), 3, 1); K.rect('#ff5252', X(u[0]) + 1, Y(u[1]) - 1, 1, 1); });
            for (var d = 0; d < 10; d += 2) K.rect('#fff176', X(0.26 + d * 0.035), Y(0.36 - d * 0.012), 1, 1);   // a route
            if (!rot) {                                                                              // the touch keyboard + a puck, toward the person
                var kk = [WT_KEYS[0], WT_KEYS[1] - lift, WT_KEYS[2], WT_KEYS[3]];
                K.rect('rgba(0,0,0,0.55)', kk[0], kk[1], kk[2], kk[3]); K.rect('accent', kk[0], kk[1], kk[2], 1); K.rect('accent', kk[0], kk[1] + kk[3] - 1, kk[2], 1);
                for (var i = 0; i < 6; i++) { K.rect('accentA', kk[0] + 2 + i * 4, kk[1] + 2, 3, 1); K.rect('accentA', kk[0] + 3 + i * 4, kk[1] + 4, 3, 1); }
                disc(K, 'accent', WT_MOUSE[0] + 2, WT_MOUSE[1] - lift + 2, 2); K.rect('#08131d', WT_MOUSE[0] + 2, WT_MOUSE[1] - lift + 2, 1, 1);
            } else {
                var kt = K.turn(WT_KEYS, rot); K.rect('rgba(0,0,0,0.55)', kt[0], kt[1] - lift, kt[2], kt[3]); K.rect('accent', kt[0], kt[1] - lift, kt[2], 1);
            }
            K.monitors(rot, on, { arm: true, bezel: '#0e1116' });
            if (!rot) { K.rect('accent', -28, -90, 56, 1); }                                         // the status screen's lit top edge
        }
    });

    // screens[i].bc (the live overlay's bezel colour per screen) is copied onto monitors[i].bc by the engine
    // (game.js _variantScreens, v0.13 seatreach: API REQUEST 1).
})();
