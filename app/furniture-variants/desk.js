// Desk variants (v0.13). Loaded before game.js: each entry is read once by game.js
// (FURNITURE_VARIANTS / FURNITURE_MANIFEST['desk~<id>']). How to add one: .work/v13/VARIANTS-API.md.
// The classic desk is row 0 in game.js (its own art); ids here are new rows, in menu order.
// draw(K, rot, C, on): desk-local (the origin of the desk), rot 0 / 90 / 180 / 270 redrawn with the
// camera (plans are unturned [x, y, w, d]; K.turn turns them), C = colour slots, on = screen active.
(function () {
    var V = window.VO_FURNITURE_VARIANTS = window.VO_FURNITURE_VARIANTS || [];

    // ---- Analyst: four screens (three in a row + one on a riser), a wide top, a cable tray ----
    // The top's front edge and the chair stay where the classic desk has them (same seat), the top
    // is 24 px wider (2.2 m).
    V.push({
        type: 'desk', id: 'analyst', label: 'Analyst',
        info: 'Four screens for charts and data: three in a row and one on a riser, a wide top with a cable tray.',
        seat: 'sit', colors: ['grey', 'white', 'black', 'wood', 'walnut', 'white-blue'],
        screens: [
            { plan: [-15, -12, 30, 2], z: 46, h: 20, foot: [-3, -15, 6, 4] },     // on the riser (drawn first: behind)
            { plan: [-43, -11, 28, 2], z: 23, h: 22, foot: [-35, -14, 12, 5] },
            { plan: [-14, -11, 28, 2], z: 23, h: 22, foot: [-6, -14, 12, 5] },
            { plan: [15, -11, 28, 2], z: 23, h: 22, foot: [23, -14, 12, 5] }
        ],
        manifest: {
            footprint: [[-44, -30, 88, 44]], footBack: 12,
            projection: { class: 'low', views: { 0: 'front', 90: 'side', 180: 'back', 270: 'side' }, parts: [
                { name: 'top', plan: [-44, -18, 88, 32], z: 16, h: 5 }, { name: 'legs', plan: [-44, -18, 88, 32], z: 0, h: 16, open: true },
                { name: 'pedestal', plan: [24, -16, 18, 30], z: 0, h: 16 }, { name: 'modesty', plan: [-40, -18, 62, 2], z: 2, h: 14 },
                { name: 'keyboard', plan: [-15, 1, 30, 8], z: 21, h: 0, flat: true },
                { name: 'chair', plan: [-15, 14, 30, 12], z: 0, h: 28, upright: true, seat: true }] },
            surface: { rect: [-44, -39, 88, 32], spots: { item: [-35, -22], food: [36, -22], keyboard: [0, -16], mouse: [21, -17], papers: [-27, -11] },
                spotsAt: { 90: { item: [-8, -58], food: [-8, 12], papers: [-5, -44] }, 180: { item: [33, -12], food: [-34, -12], papers: [-28, -24] },
                           270: { item: [8, -58], food: [8, 12], papers: [5, -44] } } }
        },
        draw: function (K, rot, C, on) {
            K.desk(rot, on, {
                floor: [
                    [[-44, -18, 3, 3], 0, 16, 'metalDk'], [[41, -18, 3, 3], 0, 16, 'metalDk'],
                    [[-44, 11, 3, 3], 0, 16, 'metalDk'], [[41, 11, 3, 3], 0, 16, 'metalDk'],
                    [[24, -16, 18, 30], 0, 16, 'face', 'faceDk'],                 // drawer pedestal
                    [[-40, -18, 62, 2], 2, 14, 'faceDk', 'leg'],                  // modesty panel
                    [[-40, -15, 62, 3], 11, 3, 'metalDk', 'metal']                // cable tray under the top
                ],
                top: [[-44, -18, 88, 32], 16, 5, 'top', 'face'], grain: 0,
                keys: [-15, 1, 30, 8], mouse: [19, 2, 5, 6],
                under: function (rot) {
                    var f = K.face(rot, [24, -16, 18, 30], 0, 16);              // pedestal face toward the camera
                    if (!rot) {                                                // three drawers with pulls
                        K.rect('seam', f[0] + 1, f[1] + 5, f[2] - 2, 1); K.rect('seam', f[0] + 1, f[1] + 10, f[2] - 2, 1);
                        K.rect('pull', f[0] + 6, f[1] + 2, 6, 1); K.rect('pull', f[0] + 6, f[1] + 7, 6, 1); K.rect('pull', f[0] + 6, f[1] + 12, 6, 1);
                    } else if (rot !== 180) K.inset(f, 'seam');
                },
                onTop: function (rot, t, lift) {
                    // a desk mat under the keyboard and mouse (accent edge), a calculator by the right screen
                    var mat = K.turn([-20, -1, 46, 12], rot);
                    K.rect('#263238', mat[0], mat[1] - lift, mat[2], mat[3]);
                    K.rect('accent', mat[0], mat[1] - lift + mat[3] - 1, mat[2], 1);
                    var ca = K.turn([30, -4, 8, 10], rot);
                    K.rect('#455a64', ca[0], ca[1] - lift, ca[2], ca[3]);
                    K.rect('#a5d6a7', ca[0] + 1, ca[1] - lift + 1, ca[2] - 2, 2);
                    K.rect('#90a4ae', ca[0] + 1, ca[1] - lift + 4, ca[2] - 2, ca[3] - 5);
                },
                monitor: { bezel: '#1e272c' },
                last: function (rot) {
                    if (rot) return;
                    K.rect('rgba(0,0,0,0.10)', -44, -18, 88, 1);                // the top's front lip shade
                }
            });
        }
    });

    // ---- Gamer: dual screens, RGB light strip, speakers and a headset stand ----
    V.push({
        type: 'desk', id: 'gamer', label: 'Gamer',
        info: 'Two screens, an RGB light strip under the top, speakers, a headset stand and a big mouse pad.',
        seat: 'sit', colors: ['black-red', 'black-cyan', 'black-green', 'white-pink', 'black', 'white'],
        screens: [
            { plan: [-31, -11, 30, 2], z: 23, h: 22, foot: [-22, -14, 12, 5] },
            { plan: [1, -11, 30, 2], z: 23, h: 22, foot: [10, -14, 12, 5] }
        ],
        manifest: {
            footprint: [[-38, -30, 76, 44]], footBack: 12,
            projection: { class: 'low', views: { 0: 'front', 90: 'side', 180: 'back', 270: 'side' }, parts: [
                { name: 'top', plan: [-38, -18, 76, 32], z: 16, h: 5 }, { name: 'legs', plan: [-38, -18, 76, 32], z: 0, h: 16, open: true },
                { name: 'speakerL', plan: [-37, -16, 5, 5], z: 21, h: 11, upright: true }, { name: 'speakerR', plan: [32, -16, 5, 5], z: 21, h: 11, upright: true },
                { name: 'keyboard', plan: [-15, 1, 30, 8], z: 21, h: 0, flat: true },
                { name: 'chair', plan: [-15, 14, 30, 12], z: 0, h: 28, upright: true, seat: true }] },
            surface: { rect: [-38, -39, 76, 32], spots: { item: [-28, -21], food: [30, -21], keyboard: [0, -16], mouse: [22, -17], papers: [-25, -11] },
                spotsAt: { 90: { item: [-6, -48], food: [-7, 8], papers: [-4, -40] }, 180: { item: [26, -12], food: [-27, -12], papers: [-26, -24] },
                           270: { item: [6, -48], food: [7, 8], papers: [4, -40] } } }
        },
        draw: function (K, rot, C, on) {
            K.desk(rot, on, {
                floor: [
                    [[-36, -16, 4, 28], 0, 3, 'leg'], [[32, -16, 4, 28], 0, 3, 'leg'],        // feet of the frame
                    [[-35, -2, 2, 3], 3, 13, 'leg', 'legHi'], [[33, -2, 2, 3], 3, 13, 'leg', 'legHi'], // uprights
                    [[-33, -10, 66, 2], 12, 2, 'leg']                                              // crossbar
                ],
                top: [[-38, -18, 76, 32], 16, 5, 'top', 'faceDk'], grain: 0,
                keys: [-16, 2, 28, 7], mouse: [21, 3, 4, 6],
                under: function (rot) {
                    // the RGB strip under the front edge of the top (glows on the floor in front of the desk)
                    var e = K.face(rot, [-38, -18, 76, 32], 16, 5);
                    K.rect('accent', e[0] + 2, e[1] + e[3], e[2] - 4, 1);
                    K.rect('accentA', e[0] + 2, e[1] + e[3] + 1, e[2] - 4, 2);
                },
                onTop: function (rot, t, lift) {
                    var pad = K.turn([-24, 0, 54, 11], rot);                                         // mouse pad, lit rim
                    K.rect('#1b1d21', pad[0], pad[1] - lift, pad[2], pad[3]);
                    K.rect('accent', pad[0], pad[1] - lift, pad[2], 1); K.rect('accent', pad[0], pad[1] - lift + pad[3] - 1, pad[2], 1);
                    [[-37, -16, 5, 5], [32, -16, 5, 5]].forEach(function (p) {                         // speakers
                        var s = K.turn(p, rot), y = K.box(s[0], s[1], s[2], s[3], 21, 11, '#2b2e33', { front: '#1e2024' });
                        if (rot !== 180 && s[2] >= 4) { K.rect('#4a4e55', s[0] + 1, y + 2, s[2] - 2, 2); K.rect('accent', s[0] + Math.floor(s[2] / 2) - 1, y + 7, 2, 2); }
                    });
                    var hs = K.turn([-30, 3, 4, 4], rot), hy = K.box(hs[0], hs[1], hs[2], hs[3], 21, 9, '#37474f', { front: '#263238' }); // headset stand
                    K.rect('accent', hs[0] - 1, hy - 5, hs[2] + 2, 2); K.rect('#212121', hs[0] - 1, hy - 3, 1, 4); K.rect('#212121', hs[0] + hs[2], hy - 3, 1, 4);
                },
                monitor: { bezel: '#15171a', stand: '#2b2e33' },
                last: function (rot) {
                    if (rot) return;
                    K.rect('accent', -15, -13, 28, 1);                                               // lit key row (front view)
                }
            });
        }
    });

    // =====================================================================================================
    // deskart (v0.13): seven more seated desks and two more standing desks. Shared pieces first.
    // =====================================================================================================

    // The closer seat (review 11-13: the hands reach the keyboard and the mouse, not the table edge). The
    // classic hips sit at y 13 (the hands land on the top's front lip); these sit 7 px further in at y 6
    // with the chair tucked under the front edge. Turned: the side hips 2 px nearer the top (the side
    // arms already reach the keys), behind a 180 desk 2 px further back than classic (its front-view hands
    // hang 4 px under the hips: on the keys, which sit 2 px nearer the front edge than the classic desk's). The chair's plan front is 13 px under the hips (the contract's rule); the floor points
    // (the walk's end before the hop) stay where the classic desk has them.
    var SEAT_Y = 6;
    function chairPart() { return { name: 'chair', plan: [-15, 10, 30, 9], z: 0, h: 28, upright: true, seat: true }; }
    function closeSeats() {
        return [{ id: 'chair', kind: 'desk', spot: [0, 0], x: 0, y: SEAT_Y, facing: 'up', legs: 'rear', tagY: -78,
            behind: ['body'], front: ['chair'],
            at: { 90: { x: -13, y: 2, legs: 'side', cut: [-9, 2, 70, 60], floor: [-15, 13] },
                  180: { x: 0, y: -29, legs: 'hidden', tuck: true, front: ['monitor'] },
                  270: { x: 13, y: 2, legs: 'side', cut: [-61, 2, 70, 60], floor: [15, 13] } } }];
    }
    function lowProj(parts, seated) {
        var P = { class: 'low', views: { 0: 'front', 90: 'side', 180: 'back', 270: 'side' }, parts: seated === false ? parts : parts.concat([chairPart()]) };
        // the side chair is drawn round the side hips (2 px nearer than the turned chair plan): its drawn boxes
        // and behind a 180 desk the chair back at the classic spot
        if (seated !== false) P.drawnAt = { 90: [[-24, -43, 16, 58]], 180: [[-16, -44, 32, 30]], 270: [[8, -43, 16, 58]] };
        return P;
    }
    // Desk-top spots from rotation-0 PLAN points ([x, y] on the top, before the lift): rotation 0 on the
    // lifted top face, spotsAt = the same plan points turned (world axes) and lifted. One layout, every turn.
    function topSpots(lift, p) {
        var L = function(q) { return [q[0], q[1] - lift]; };
        var T = function(q, rot) { var c = Math.round(Math.cos(rot * Math.PI / 180)), s = Math.round(Math.sin(rot * Math.PI / 180)); return [q[0] * c - q[1] * s, q[0] * s + q[1] * c - lift]; };
        var at = {};
        [90, 180, 270].forEach(function(rot) {
            var o = p.at && p.at[rot] || {};
            at[rot] = { item: o.item || T(p.item, rot), food: o.food || T(p.food, rot), papers: o.papers || T(p.papers, rot) };
        });
        return { spots: { item: L(p.item), food: L(p.food), keyboard: L(p.keyboard), mouse: L(p.mouse), papers: L(p.papers) }, spotsAt: at };
    }
    var SIDE = function(rot) { return rot === 90 || rot === 270; };
    // An upright thing on the top or the floor (a box seen from the front with a 1 px cap, from the side its
    // whole turned depth: the projection's rule). Returns the face toward the camera [x, y, w, h].
    // prof: the depth a side view shows (like a screen in profile; the projection part carries the same prof).
    function ubox(K, rot, plan, z, h, top, front, prof) {
        var r = K.turn(plan, rot);
        if (SIDE(rot) && prof && r[3] > prof) r = [r[0], r[1] + (r[3] - prof) / 2, r[2], prof];
        K.box(r[0], r[1], r[2], r[3], z, h, top, SIDE(rot) ? { front: front || null } : { front: front || null, cap: 1 });
        return [r[0], r[1] + r[3] - z - h, r[2], h];
    }
    // A flat thing lying on a top (mat, paper, tablet): the turned plan lifted.
    function flat(K, rot, plan, lift, c) { var r = K.turn(plan, rot); K.rect(c, r[0], r[1] - lift, r[2], r[3]); return [r[0], r[1] - lift, r[2], r[3]]; }
    // A keyboard with keycaps (mechanical / retro): a 2 px high case with rows of caps on its top face,
    // the odd caps in an accent colour. caps = [base, alt, accent].
    function capKeys(K, rot, plan, lift, cs, caps) {
        var r = K.turn(plan, rot), y = r[1] - lift;
        K.box(r[0], r[1], r[2], r[3], lift, 2, cs, { front: K.tone(cs, 0.7) });
        var t = y - 2, wide = r[2] >= r[3];
        if (wide) {
            for (var row = 0; row * 2 + 1 < r[3] - 1; row++) for (var i = 1; i + 2 <= r[2] - 1; i += 3) {
                var c = (i === 1 && row === 0) || (row === 1 && i + 5 > r[2] - 1) ? caps[2] : row === 3 || (i > r[2] - 8 && row) ? caps[1] : caps[0];
                K.rect(c, r[0] + i, t + 1 + row * 2, 2, 1);
            }
        } else {
            for (var col = 0; col * 2 + 1 < r[2] - 1; col++) for (var j = 1; j + 2 <= r[3] - 1; j += 3) {
                var cc = (j === 1 && col === 0) ? caps[2] : col === 3 ? caps[1] : caps[0];
                K.rect(cc, r[0] + 1 + col * 2, t + j, 1, 2);
            }
        }
    }
    // A potted plant (pot box + a leaf crown) on a surface at z: the crown is wider than the pot.
    function plant(K, rot, plan, z, potH, leafH, pot, leaf) {
        var r = K.turn(plan, rot), f = ubox(K, rot, plan, z, potH, pot, K.tone(pot, 0.8));
        K.rect(K.tone(pot, 1.15), f[0], f[1], f[2], 1);
        var side = SIDE(rot), cx = r[0] + Math.floor(r[2] / 2), lw = r[2] + 4;
        leafH += side ? Math.max(0, r[3] - 2) : 0;        // side-on the crown also spans the pot's turned depth
        var top = f[1] - leafH;
        K.rect(leaf, cx - lw / 2 + 2, top + 3, lw - 4, leafH - 3);                    // the crown
        K.rect(leaf, cx - 1, top, 3, 4); K.rect(leaf, cx - lw / 2, top + 4, 3, leafH - 6); K.rect(leaf, cx + lw / 2 - 3, top + 4, 3, leafH - 6);
        K.rect(K.tone(leaf, 1.3), cx - lw / 2 + 3, top + 4, 2, 2); K.rect(K.tone(leaf, 1.3), cx + 1, top + 2, 2, 2); K.rect(K.tone(leaf, 1.3), cx + lw / 2 - 5, top + 6, 2, 2);
        K.rect(K.tone(leaf, 0.7), cx - 2, top + leafH - 3, 5, 2); K.rect(K.tone(leaf, 0.7), cx - lw / 2 + 3, top + leafH - 4, 2, 2);
    }
    // A mug on a top (z = lift): body, a lighter rim, the handle on the camera's right.
    function mug(K, rot, plan, lift, c) {
        var f = ubox(K, rot, plan, lift, 5, c, K.tone(c, 0.85));
        K.rect('#3e2723', f[0] + 1, f[1] - 1, f[2] - 2, 1);
        K.rect(K.tone(c, 0.8), f[0] + f[2], f[1] + 1, 1, 3);
    }
    // A row of books (spines) standing on a surface: plan = the row, h = the height; colours cycle.
    var BOOKS = ['#8d2f2f', '#2f5d8d', '#c49a2a', '#3f7d4a', '#6d4c8d', '#d7ccc8', '#a0522d'];
    function books(K, rot, plan, z, h, seed) {
        var r = K.turn(plan, rot), f = ubox(K, rot, plan, z, h, '#5d4037', '#4e342e'), n = f[2], x = f[0], k = seed || 0;
        while (x < f[0] + n - 1) {
            var w = 2 + (k % 3 === 0 ? 1 : 0), bh = h - (k % 4 === 1 ? 2 : k % 5 === 2 ? 1 : 0), c = BOOKS[k % BOOKS.length];
            w = Math.min(w, f[0] + n - x);
            K.rect(c, x, f[1] + (h - bh), w, bh); K.rect(K.tone(c, 1.25), x, f[1] + (h - bh), w, 1); if (w > 2) K.rect(K.tone(c, 0.75), x + w - 1, f[1] + h - bh + 1, 1, bh - 1);
            if (bh > 5) K.rect('rgba(255,255,255,0.35)', x, f[1] + h - bh + 2, w, 1);
            x += w; k++;
        }
    }

    // ---- Developer: two portrait screens for long files, a laptop on the side, a mechanical keyboard ----
    // Butcher-block top on steel sled legs, a PC tower with a glass side under the right end, a rubber duck.
    V.push({
        type: 'desk', id: 'developer', label: 'Developer',
        info: 'Two portrait screens for long code, a laptop on the side, a mechanical keyboard, a PC tower with a glass side and a rubber duck.',
        seat: 'sit', colors: ['walnut', 'wood', 'black', 'white', 'grey', 'black-green'],
        screens: [
            { plan: [-16, -11, 18, 2], z: 23, h: 30, foot: [-10, -14, 6, 5] },
            { plan: [3, -11, 18, 2], z: 23, h: 30, foot: [9, -14, 6, 5] },
            { plan: [-35, -9, 17, 2], z: 22, h: 14, foot: [-35, -7, 17, 7] }        // the laptop (its deck = the foot)
        ],
        manifest: {
            footprint: [[-36, -30, 72, 44]], footBack: 12,
            projection: lowProj([
                { name: 'top', plan: [-36, -18, 72, 32], z: 16, h: 5 }, { name: 'legs', plan: [-36, -18, 72, 32], z: 0, h: 16, open: true },
                { name: 'tower', plan: [18, -12, 11, 22], z: 0, h: 15 },
                { name: 'duck', plan: [14, -12, 4, 3], z: 53, h: 5, upright: true },      // perched on the right screen
                { name: 'keyboard', plan: [-15, 3, 30, 7], z: 21, h: 2, flat: true }]),
            seats: closeSeats(),
            surface: Object.assign({ rect: [-36, -39, 72, 32] }, topSpots(21, {
                item: [29, -8], food: [30, 7], keyboard: [0, 6], mouse: [19, 7], papers: [-28, 8],
                at: { 180: { item: [-29, -27], food: [28, -29], papers: [-29, -13] }, 270: { item: [-6, -52], food: [9, 3], papers: [10, -49] } } }))
        },
        draw: function (K, rot, C, on) {
            var KB = [-15, 3, 30, 7], CAPS = ['#ece6d6', '#8fa8bf', 'accent'];
            K.desk(rot, on, {
                floor: [
                    [[-35, -16, 3, 30], 0, 2, 'metalDk'], [[32, -16, 3, 30], 0, 2, 'metalDk'],                       // sled runners
                    [[-35, -16, 3, 3], 2, 14, 'metal', 'metalDk'], [[32, -16, 3, 3], 2, 14, 'metal', 'metalDk'],     // back posts
                    [[-35, 11, 3, 3], 2, 14, 'metal', 'metalDk'], [[32, 11, 3, 3], 2, 14, 'metal', 'metalDk'],       // front posts
                    [[-33, -15, 66, 2], 13, 3, 'metalDk'],                                                          // back rail
                    [[18, -12, 11, 22], 0, 15, '#2a2e35', '#1f2329']                                                // PC tower
                ],
                top: [[-36, -18, 72, 32], 16, 5, 'top', 'faceDk'], grain: 6,
                mouse: [17, 4, 4, 6],
                under: function (rot) {
                    var f = K.face(rot, [18, -12, 11, 22], 0, 15);
                    if (!rot) {                                                                // front: drive bay, power, vents
                        K.rect('#14171b', f[0] + 2, f[1] + 2, f[2] - 4, 1); K.rect('accent', f[0] + f[2] - 3, f[1] + 4, 1, 1);
                        for (var i = 7; i < 13; i += 2) K.rect('#16191d', f[0] + 2, f[1] + i, f[2] - 4, 1);
                    } else if (SIDE(rot)) {                                                    // the glass side: two lit fans
                        K.rect('#0d1013', f[0] + 2, f[1] + 2, f[2] - 4, f[3] - 4); K.rect('accentA', f[0] + 2, f[1] + 2, f[2] - 4, f[3] - 4);
                        var fx = rot === 90 ? f[0] + f[2] - 8 : f[0] + 3;
                        K.rect('accent', fx, f[1] + 3, 5, 1); K.rect('accent', fx, f[1] + 7, 5, 1); K.rect('accent', fx, f[1] + 3, 1, 5); K.rect('accent', fx + 4, f[1] + 3, 1, 5);
                        K.rect('#cfd8dc', fx + 2, f[1] + 5, 1, 1);
                        K.rect('#78909c', f[0] + (rot === 90 ? 3 : f[2] - 9), f[1] + 9, 6, 3);       // the graphics card
                    } else {                                                                   // the back: ports and the fan grille
                        K.rect('#16191d', f[0] + 2, f[1] + 2, 4, 4); K.rect('#90a4ae', f[0] + 7, f[1] + 3, 1, 3); K.rect('#90a4ae', f[0] + 2, f[1] + 9, 7, 1);
                    }
                },
                onTop: function (rot, t, lift) {
                    var mat = flat(K, rot, [-19, 1, 42, 11], lift, '#20242a');                    // desk mat, accent stitching
                    K.rect('accent', mat[0], mat[1] + mat[3] - 1, mat[2], 1);
                    var n = flat(K, rot, [-31, 2, 6, 6], lift, '#fff176');                       // sticky notes
                    K.rect('#f9a825', n[0], n[1] + n[3] - 1, n[2], 1);
                    if (rot) capKeys(K, rot, KB, lift, '#2d3035', CAPS);
                },
                monitor: { bezel: '#1b1f24', stand: '#a7b1b9' },
                last: function (rot) {
                    // the rubber duck perched on the right screen (body, head, the beak toward the sitter)
                    var d = ubox(K, rot, [14, -12, 4, 3], 53, 3, '#ffd54f', '#fbc02d');
                    var hd = K.turn([14, -12, 3, 3], rot), hy = d[1] - (SIDE(rot) ? 4 : 2);
                    K.rect('#ffe082', hd[0], hy, hd[2], SIDE(rot) ? 4 : 3); K.rect('#ffca28', hd[0], hy + (SIDE(rot) ? 3 : 2), hd[2], 1);
                    if (rot !== 180) K.rect('#212121', hd[0] + (rot === 270 ? 0 : hd[2] - 1), hy + 1, 1, 1);
                    if (SIDE(rot)) K.rect('#ff8f00', rot === 90 ? hd[0] - 1 : hd[0] + hd[2], hy + 2, 1, 1);
                    if (rot) return;
                    capKeys(K, 0, KB, 21, '#2d3035', CAPS);
                    K.rect('#cfd8dc', -34, -22, 15, 1);                                         // the laptop deck's lit edge
                }
            });
        }
    });
    // ---- Creative: a colour-calibrated screen under a shading hood, a pen tablet, a monstera, birch trestles ----
    V.push({
        type: 'desk', id: 'creative', label: 'Creative Studio',
        info: 'A designer\'s desk: a big colour-calibrated screen under a shading hood, a pen tablet, a monstera and a pen cup on birch trestles.',
        seat: 'sit', colors: ['white', 'wood', 'white-pink', 'white-blue', 'black', 'walnut'],
        screens: [{ plan: [-20, -12, 40, 2], z: 24, h: 25, foot: [-6, -15, 12, 4] }],
        manifest: {
            footprint: [[-38, -30, 76, 44]], footBack: 12,
            projection: lowProj([
                { name: 'top', plan: [-38, -18, 76, 32], z: 16, h: 5 }, { name: 'legs', plan: [-38, -18, 76, 32], z: 0, h: 16, open: true },
                { name: 'hood', plan: [-24, -14, 48, 6], z: 24, h: 30, upright: true },
                { name: 'plant', plan: [-38, -17, 14, 10], z: 21, h: 21, upright: true },
                { name: 'pens', plan: [30, -16, 5, 5], z: 21, h: 10, upright: true },
                { name: 'keyboard', plan: [-20, 3, 24, 7], z: 21, h: 2, flat: true }]),
            seats: closeSeats(),
            surface: Object.assign({ rect: [-38, -39, 76, 32] }, topSpots(21, {
                item: [28, -5], food: [-29, 9], keyboard: [-8, 6], mouse: [18, 7], papers: [-29, -2],
                at: { 90: { item: [-7, 12], food: [6, 12], papers: [-5, -53] }, 270: { item: [-7, -49], food: [8, -57], papers: [1, 7] } } }))
        },
        draw: function (K, rot, C, on) {
            var BIRCH = '#d9b98c', BIRCH_DK = '#b8955f', KB = [-20, 3, 24, 7];
            var hood = function (rot) {                      // the shade round the screen: two side flaps and a top flap
                var r = K.turn([-24, -14, 48, 6], rot);
                if (!rot) {
                    K.rect('#1d2024', -24, -62, 4, 30); K.rect('#1d2024', 20, -62, 4, 30); K.rect('#1d2024', -24, -62, 48, 3);
                    K.rect('#33373d', -21, -59, 1, 27); K.rect('#33373d', 20, -59, 1, 27); K.rect('#33373d', -21, -60, 42, 1);
                    K.rect('#2a2e33', -24, -32, 4, 1); K.rect('#2a2e33', 20, -32, 4, 1);
                } else if (SIDE(rot)) {
                    K.box(r[0], r[1], r[2], r[3], 24, 30, '#2a2e33', { front: '#1d2024' });
                } else {
                    K.box(r[0], r[1], r[2], r[3], 24, 30, '#2a2e33', { front: '#1d2024', cap: 1 });
                    K.rect('#33373d', r[0] + 2, r[1] + r[3] - 24 - 28, r[2] - 4, 1);
                }
            };
            K.desk(rot, on, {
                floor: [
                    [[-38, -17, 4, 3], 0, 16, BIRCH, BIRCH_DK], [[-38, 11, 4, 3], 0, 16, BIRCH, BIRCH_DK],     // left trestle legs
                    [[34, -17, 4, 3], 0, 16, BIRCH, BIRCH_DK], [[34, 11, 4, 3], 0, 16, BIRCH, BIRCH_DK],       // right trestle legs
                    [[-38, -14, 4, 25], 7, 2, BIRCH_DK], [[34, -14, 4, 25], 7, 2, BIRCH_DK],                   // trestle stretchers
                    [[-30, -16, 60, 2], 13, 3, BIRCH_DK]                                                       // the back rail
                ],
                top: [[-38, -18, 76, 32], 16, 5, 'top', 'face'], grain: 0,
                under: function (rot) {
                    if (!SIDE(rot)) return;                                                   // the trestle's splay seen side-on
                    var a = K.face(rot, [-38, -17, 4, 31], 0, 16), x0 = a[0], w = a[2];
                    for (var i = 0; i < 6; i++) { K.rect(BIRCH, x0 + 3 + i, a[1] + 6 + i, 2, 1); K.rect(BIRCH, x0 + w - 5 - i, a[1] + 6 + i, 2, 1); }
                },
                onTop: function (rot, t, lift) {
                    // pen tablet: dark slab, its active area, an accent ring LED and the pen lying on it
                    var tb = flat(K, rot, [7, 1, 22, 12], lift, '#2b2d31');
                    K.rect('#3a3d42', tb[0] + 2, tb[1] + 2, tb[2] - 4, tb[3] - 4);
                    K.rect('accent', tb[0] + 1, tb[1] + 1, 2, 1);
                    var pn = flat(K, rot, [12, 6, 12, 1], lift, '#eceff1'); K.rect('#212121', pn[0], pn[1], 1, 1);
                    plant(K, rot, [-36, -17, 10, 10], lift, 7, 14, '#e7e2da', '#2e7d4f');
                    // pen cup with three coloured pens
                    var pc = ubox(K, rot, [30, -16, 5, 5], lift, 6, '#455a64', '#37474f');
                    K.rect('#e53935', pc[0], pc[1] - 3, 1, 3); K.rect('#1e88e5', pc[0] + Math.max(1, pc[2] - 3), pc[1] - 4, 1, 4); K.rect('accent', pc[0] + pc[2] - 1, pc[1] - 2, 1, 2);
                    if (rot) { capKeys(K, rot, KB, lift, '#dfe3e6', ['#ffffff', '#cfd8dc', 'accent']); hood(rot); }
                },
                monitor: { bezel: '#263238', stand: '#cfd8dc' },
                last: function (rot) {
                    if (rot) return;
                    hood(0);
                    capKeys(K, 0, KB, 21, '#dfe3e6', ['#ffffff', '#cfd8dc', 'accent']);
                }
            });
        }
    });

    // ---- Trader: a six-screen wall on a pole mount, a ticker in the front edge, a desk phone, a brass bull ----
    V.push({
        type: 'desk', id: 'trader', label: 'Trader',
        info: 'Six screens in two rows on a pole mount, an LED ticker along the front edge, a function-key keyboard, a desk phone and a brass bull. 2.4 m.',
        seat: 'sit', colors: ['black', 'black-gold', 'black-green', 'grey', 'walnut', 'white'],
        screens: [
            { plan: [-44, -11, 28, 2], z: 44, h: 19, foot: [-32, -18, 4, 3] },
            { plan: [-14, -11, 28, 2], z: 44, h: 19, foot: [-2, -18, 4, 3] },
            { plan: [16, -11, 28, 2], z: 44, h: 19, foot: [28, -18, 4, 3] },
            { plan: [-44, -11, 28, 2], z: 23, h: 19, foot: [-32, -18, 4, 3] },
            { plan: [-14, -11, 28, 2], z: 23, h: 19, foot: [-2, -18, 4, 3] },
            { plan: [16, -11, 28, 2], z: 23, h: 19, foot: [28, -18, 4, 3] }
        ],
        manifest: {
            footprint: [[-48, -30, 96, 44]], footBack: 12,
            projection: lowProj([
                { name: 'top', plan: [-48, -18, 96, 32], z: 16, h: 5 }, { name: 'legs', plan: [-48, -18, 96, 32], z: 0, h: 16, open: true },
                { name: 'pole', plan: [-2, -17, 4, 3], z: 21, h: 45, upright: true },
                { name: 'phone', plan: [-45, -6, 11, 8], z: 21, h: 5 },
                { name: 'bull', plan: [40, -6, 5, 4], z: 21, h: 6, upright: true },
                { name: 'keyboard', plan: [-16, 3, 32, 7], z: 21, h: 2, flat: true }]),
            seats: closeSeats(),
            surface: Object.assign({ rect: [-48, -39, 96, 32] }, topSpots(21, {
                item: [31, -4], food: [34, 7], keyboard: [0, 6], mouse: [22, 7], papers: [-30, 8],
                at: { 90: { item: [-3, 7] }, 270: { item: [2, -51], food: [8, -59], papers: [10, 3] } } }))
        },
        draw: function (K, rot, C, on) {
            var KB = [-16, 3, 32, 7];
            var keys = function (rot, lift) {                 // the trading keyboard: dark caps, a yellow function row, red / green keys
                var r = K.turn(KB, rot), y = r[1] - lift;
                K.box(r[0], r[1], r[2], r[3], lift, 2, '#25292e', { front: '#1a1d21' });
                var wide = r[2] >= r[3], len = wide ? r[2] : r[3], dep = wide ? r[3] : r[2];
                for (var row = 0; row * 2 + 1 < dep - 1; row++) for (var i = 1; i + 2 <= len - 1; i += 3) {
                    var c = row === 0 ? '#f9a825' : i < 7 && row === 1 ? '#e53935' : i < 7 && row === 2 ? '#43a047' : '#5b6168';
                    if (wide) K.rect(c, r[0] + i, y - 1 + row * 2, 2, 1); else K.rect(c, r[0] + 1 + row * 2, y - 2 + i, 1, 2);
                }
            };
            K.desk(rot, on, {
                floor: [
                    [[-48, -18, 4, 32], 0, 16, 'body', 'face'], [[44, -18, 4, 32], 0, 16, 'body', 'face'],      // waterfall ends
                    [[-44, -16, 88, 2], 2, 14, 'faceDk', 'leg']                                                // modesty panel
                ],
                top: [[-48, -18, 96, 32], 16, 5, 'top', 'faceDk'], grain: 0,
                mouse: [20, 4, 4, 6],
                under: function (rot) {
                    var e = K.face(rot, [-48, -18, 96, 32], 16, 5);
                    if (!rot) {                                                                // the LED ticker in the front edge
                        K.rect('#0b0f0c', e[0] + 6, e[1] + 1, e[2] - 12, 3);
                        for (var x = e[0] + 7, k = 0; x < e[0] + e[2] - 7; x += 2, k++) if (k % 7 !== 3) K.rect(k % 11 < 6 ? '#4caf50' : '#ef5350', x, e[1] + 2 - (k % 3 === 0 ? 1 : 0), 1, 1);
                    }
                    [[-48, -18, 4, 32], [44, -18, 4, 32]].forEach(function (p) {                // a lit slit down each end panel
                        var f = K.face(rot, p, 0, 16);
                        if (f[2] >= 4) K.rect('accent', f[0] + Math.floor(f[2] / 2), f[1] + 2, 1, f[3] - 4);
                    });
                },
                onTop: function (rot, t, lift) {
                    var po = ubox(K, rot, [-2, -17, 4, 3], lift, 45, '#4a4f56', '#3a3f45');          // the pole of the screen mount
                    K.rect('#5c636b', po[0], po[1] + 20, po[2], 2);
                    // desk phone: body, handset, keypad
                    var ph = K.turn([-45, -6, 11, 8], rot), py = K.box(ph[0], ph[1], ph[2], ph[3], lift, 3, '#37474f', { front: '#263238' });
                    var hs = K.turn([-44, -5, 3, 6], rot); K.rect('#1c2326', hs[0], hs[1] - lift - 5, hs[2], hs[3]);
                    var kp = K.turn([-39, -4, 4, 4], rot); K.rect('#90a4ae', kp[0], kp[1] - lift - 3, kp[2], kp[3]); K.rect('#ffca28', kp[0], kp[1] - lift - 3, 1, 1);
                    var sp = flat(K, rot, [-26, 4, 4, 7], lift, '#111417'); K.rect('#3949ab', sp[0] + 1, sp[1] + 1, sp[2] - 2, sp[3] - 2);   // a phone, face up
                    var bl = ubox(K, rot, [40, -6, 5, 4], lift, 4, '#d4af37', '#b8902a');            // the brass bull
                    K.rect('#d4af37', bl[0] + (rot === 270 ? bl[2] - 1 : 0), bl[1] - 2, 1, 2); K.rect('#d4af37', bl[0] + (rot === 90 ? 0 : bl[2] - 1), bl[1] - 2, 1, 2);
                    if (rot) keys(rot, lift);
                },
                monitor: { arm: true, bezel: '#15181b' },
                last: function (rot) {
                    if (rot) return;
                    keys(0, 21);
                    K.rect('accent', -48, -7, 96, 1);                                          // lit trim on the front lip
                }
            });
        }
    });
    // ---- Streamer: an ultrawide and a chat screen on a lit riser, a ring light, a mic on a boom arm, a webcam ----
    V.push({
        type: 'desk', id: 'streamer', label: 'Streamer',
        info: 'Ready to go live: an ultrawide and a chat screen on a lit riser, a ring light, a mic on a boom arm, a webcam and a stream deck.',
        seat: 'sit', colors: ['black-cyan', 'white-pink', 'black-red', 'black-gold', 'white-blue', 'black'],
        screens: [
            { plan: [-30, -13, 52, 2], z: 28, h: 20, foot: [-10, -16, 12, 3] },
            { plan: [24, -13, 12, 2], z: 28, h: 20, foot: [27, -16, 6, 3] }
        ], screenTop: 26,                                 // both on the riser
        manifest: {
            footprint: [[-38, -30, 76, 44]], footBack: 12,
            projection: lowProj([
                { name: 'top', plan: [-38, -18, 76, 32], z: 16, h: 5 }, { name: 'legs', plan: [-38, -18, 76, 32], z: 0, h: 16, open: true },
                { name: 'riser', plan: [-36, -18, 72, 8], z: 21, h: 5 },
                { name: 'ring', plan: [-39, -18, 18, 3], z: 26, h: 41, upright: true },
                { name: 'cam', plan: [-7, -14, 6, 3], z: 48, h: 5, upright: true },
                { name: 'micpost', plan: [33, 7, 2, 2], z: 21, h: 25, upright: true },
                { name: 'mic', plan: [15, 6, 20, 4], z: 33, h: 13, upright: true },
                { name: 'deck', plan: [-34, 3, 12, 8], z: 21, h: 2 },
                { name: 'keyboard', plan: [-15, 3, 30, 7], z: 21, h: 0, flat: true }]),
            seats: closeSeats(),
            surface: Object.assign({ rect: [-38, -39, 76, 32] }, topSpots(21, {
                item: [28, -5], food: [30, 1], keyboard: [0, 6], mouse: [20, 7], papers: [-24, -4],
                at: { 90: { item: [2, 13], food: [3, -27], papers: [2, 5] }, 270: { item: [-2, -51], food: [-3, -21], papers: [-2, 5] } } }))
        },
        draw: function (K, rot, C, on) {
            var WARM = '#fff3d6';
            var ring = function (rot) {                       // the ring light: a lit ring toward the sitter, a pole from the riser
                var r = K.turn([-39, -18, 18, 3], rot), side = SIDE(rot), cx = r[0] + Math.floor(r[2] / 2), bot = r[1] + r[3] - 26;
                var lit = rot === 180 ? '#3a3f45' : WARM, rim = rot === 180 ? '#25292e' : '#e0d2b0';
                K.rect('#2b2f35', cx - 1, bot - 33, 2, 33);                                     // pole
                if (side) {                                                                     // edge-on: a slim lit bar
                    K.rect('#30353b', cx - 1, bot - 41 - r[3], 3, 17 + r[3]);
                    K.rect(rot === 90 ? WARM : '#30353b', rot === 90 ? cx - 2 : cx + 2, bot - 40 - r[3], 1, 16 + r[3]);
                    if (rot === 270) K.rect(WARM, cx - 2, bot - 40 - r[3], 1, 16 + r[3]);
                    return;
                }
                var cy = bot - 33, HW = [3, 4, 5, 6, 7, 7, 8, 8, 8], IN = [0, 0, 0, 0, 3, 4, 5, 5, 5];   // a 17 px ring, a 9 px hole
                for (var i = 0; i < 17; i++) {
                    var k = i < 9 ? i : 16 - i, hw = HW[k], inner = IN[k], y = cy - 8 + i;
                    if (inner) { K.rect(lit, cx - hw, y, hw - inner, 1); K.rect(lit, cx + inner, y, hw - inner, 1); }
                    else K.rect(lit, cx - hw, y, hw * 2, 1);
                }
                K.rect(rim, cx - 8, cy, 2, 1); K.rect(rim, cx + 6, cy, 2, 1);
                if (rot !== 180) K.rect('#2b2f35', cx - 2, cy - 1, 4, 3);                     // the phone clamp in the middle
            };
            var mic = function (rot) {                        // boom arm from the front-right corner, the mic hanging by the sitter
                var p = K.turn([33, 7, 2, 2], rot), pb = p[1] + p[3] - 21;
                K.rect('#2b2f35', p[0], pb - 25, p[2], 25);                                     // post
                var a = K.turn([17, 7, 18, 2], rot), ay = a[1] + a[3] - 44;
                K.rect('#3a3f45', a[0], ay - 2 - (SIDE(rot) ? a[3] : 0), a[2], 2 + (SIDE(rot) ? a[3] : 0));   // arm
                var m = K.turn([16, 6, 4, 4], rot), my = m[1] + m[3] - 33;
                K.rect('#1c1f23', m[0], my - 11, m[2], 11); K.rect('#5b6168', m[0], my - 11, m[2], 1); K.rect('#8d949c', m[0] + 1, my - 9, Math.max(1, m[2] - 2), 4);
                if (rot !== 180) { K.rect('rgba(30,30,30,0.55)', m[0] - 2, my - 10, m[2] + 4, 7); K.rect('#455a64', m[0] - 2, my - 10, m[2] + 4, 1); }   // pop filter
            };
            K.desk(rot, on, {
                floor: [
                    [[-38, -17, 3, 30], 0, 2, 'leg'], [[35, -17, 3, 30], 0, 2, 'leg'],                         // feet
                    [[-37, -2, 2, 3], 2, 14, 'leg', 'legHi'], [[35, -2, 2, 3], 2, 14, 'leg', 'legHi'],         // posts
                    [[-34, -12, 68, 3], 12, 3, 'metalDk']                                                    // cable tray
                ],
                top: [[-38, -18, 76, 32], 16, 5, 'top', 'faceDk'], grain: 0,
                keys: [-15, 3, 30, 7], mouse: [18, 4, 4, 6],
                under: function (rot) {
                    var e = K.face(rot, [-38, -18, 76, 32], 16, 5);
                    K.rect('accentA', e[0] + 2, e[1] + e[3], e[2] - 4, 2);
                },
                onTop: function (rot, t, lift) {
                    var pad = flat(K, rot, [-20, 1, 46, 11], lift, '#16181b');                 // big mouse pad
                    K.rect('accent', pad[0], pad[1] + pad[3] - 1, pad[2], 1);
                    // the riser shelf with its lit front strip
                    var rs = K.turn([-36, -18, 72, 8], rot), ry = K.box(rs[0], rs[1], rs[2], rs[3], lift, 5, 'top', { front: 'face' });
                    var rf = K.face(rot, [-36, -18, 72, 8], lift, 5);
                    if (rot !== 180) K.rect('accent', rf[0] + 1, rf[1] + 3, rf[2] - 2, 1);
                    // stream deck: a grid of lit buttons
                    var sd = K.turn([-34, 3, 12, 8], rot), sy = K.box(sd[0], sd[1], sd[2], sd[3], lift, 2, '#1e2125', { front: '#141619' });
                    var BT = ['#ff1744', '#00e5ff', '#76ff03', '#ffc400', '#d500f9', '#2979ff'];
                    for (var i = 0, n = 0; i + 2 <= sd[2] - 1; i += 3) for (var j = 0; j + 2 <= sd[3] - 1; j += 3) K.rect(BT[(n++) % BT.length], sd[0] + 1 + i, sy - sd[3] + 1 + j, 2, 2);
                    ring(rot);
                },
                monitor: { bezel: '#111316', stand: '#2b2f35' },
                last: function (rot) {
                    var c = ubox(K, rot, [-7, -14, 6, 3], 48, 4, '#1c1f23', '#121417');              // the webcam on the ultrawide
                    if (rot !== 180) { K.rect('#5c6bc0', c[0] + Math.floor(c[2] / 2) - 1, c[1] + 1, 2, 2); K.rect('#ff1744', c[0] + c[2] - 1, c[1], 1, 1); }
                    mic(rot);
                }
            });
        }
    });
    // ---- Retro 80s: a steel tanker desk with a wood-grain top, a beige CRT terminal, a dot-matrix printer ----
    V.push({
        type: 'desk', id: 'retro', label: 'Retro 80s',
        info: 'An 80s steel tanker desk with a wood-grain top: a beige CRT terminal, a chunky keyboard, a dot-matrix printer, floppy disks and a puzzle cube.',
        seat: 'sit', colors: ['wood', 'walnut', 'grey', 'white', 'grey-orange', 'black'],
        // the screen is the dark glass only (the live overlay repaints it): the beige casing is its own part round it
        screens: [{ plan: [-12, -2, 24, 2], z: 25, h: 19, foot: [-1, -9, 2, 1] }],
        manifest: {
            footprint: [[-36, -30, 72, 44]], footBack: 12,
            projection: lowProj([
                { name: 'top', plan: [-36, -18, 72, 32], z: 16, h: 5 },
                { name: 'pedL', plan: [-36, -16, 16, 30], z: 0, h: 16 }, { name: 'pedR', plan: [20, -16, 16, 30], z: 0, h: 16 },
                { name: 'legs', plan: [-36, -18, 72, 32], z: 0, h: 16, open: true },
                { name: 'crt', plan: [-16, -9, 32, 8], z: 21, h: 28, upright: true, prof: 16 },     // side-on: a 16 px deep tube, not 32
                { name: 'crtBack', plan: [-11, -17, 22, 8], z: 24, h: 20, upright: true, prof: 12 },
                { name: 'printer', plan: [18, -17, 16, 10], z: 21, h: 6 },
                { name: 'paper', plan: [20, -17, 12, 2], z: 27, h: 8, upright: true },
                { name: 'floppies', plan: [-34, -4, 7, 7], z: 21, h: 3 },
                { name: 'cube', plan: [26, 4, 4, 4], z: 21, h: 4, upright: true },
                { name: 'keyboard', plan: [-16, 3, 32, 8], z: 21, h: 2, flat: true }]),
            seats: closeSeats(),
            surface: Object.assign({ rect: [-36, -39, 72, 32] }, topSpots(21, {
                item: [-26, -12], food: [30, -3], keyboard: [0, 7], mouse: [21, 8], papers: [-26, 9],
                at: { 90: { food: [1, 12] }, 270: { food: [-1, -55] } } }))
        },
        draw: function (K, rot, C, on) {
            var BEIGE = '#d8cfb4', BEIGE_DK = '#c2b796', BEIGE_LT = '#e6dec7', KB = [-16, 3, 32, 8];
            var crt = function (rot) {                        // the casing: the back hump, then the front with the glass recess
                var hb = ubox(K, rot, [-11, -17, 22, 8], 24, 20, '#cfc5a8', BEIGE_DK, 12);
                if (rot === 180) for (var i = 3; i < hb[3] - 3; i += 3) K.rect('#a99f80', hb[0] + 4, hb[1] + i, hb[2] - 8, 1);   // vents
                var f = ubox(K, rot, [-16, -9, 32, 8], 21, 28, BEIGE, BEIGE_DK, 16);
                if (!rot) {
                    K.rect('#1a1d1a', -13, -45, 26, 22);                                       // the recess round the glass
                    K.rect(BEIGE_LT, -16, -50, 32, 1); K.rect('#3e4a3e', -10, -23, 6, 1);      // the lit edge, a vent slot
                    K.rect('#76ff03', 11, -24, 2, 1);                                         // power LED
                    K.rect('#fff176', 11, -50, 5, 5); K.rect('#fbc02d', 11, -46, 5, 1);       // a sticky note on the casing
                } else if (SIDE(rot)) {
                    for (var j = 4; j < f[3] - 4; j += 4) K.rect(BEIGE_DK, f[0] + 2, f[1] + j, f[2] - 4, 1);    // side vents
                } else {
                    K.rect('#a99f80', f[0] + 3, f[1] + 3, f[2] - 6, 1); K.rect('#212121', f[0] + f[2] / 2 - 2, f[1] + f[3] - 6, 4, 3);   // label, power socket
                }
            };
            K.desk(rot, on, {
                floor: [
                    [[-36, -16, 16, 30], 0, 16, 'metal', 'metalDk'], [[20, -16, 16, 30], 0, 16, 'metal', 'metalDk'],  // steel pedestals
                    [[-20, -16, 40, 2], 2, 14, 'metalDk']                                                         // modesty panel
                ],
                top: [[-36, -18, 72, 32], 16, 5, 'top', 'faceDk'], grain: 6,
                under: function (rot) {
                    [[-36, -16, 16, 30], [20, -16, 16, 30]].forEach(function (p) {
                        var f = K.face(rot, p, 0, 16);
                        K.rect('accent', f[0], f[1] + (rot === 180 ? 4 : 1), f[2], 1);         // the 80s trim stripe (180: under the top's lip)
                        if (!rot || rot === 180) {
                            if (rot === 180) { K.inset(f, 'seam'); return; }
                            K.rect('seam', f[0] + 1, f[1] + 5, f[2] - 2, 1); K.rect('seam', f[0] + 1, f[1] + 10, f[2] - 2, 1);
                            for (var k = 0; k < 3; k++) { K.rect('#eceff1', f[0] + 5, f[1] + 2 + k * 5, 6, 1); K.rect('#90a4ae', f[0] + 5, f[1] + 3 + k * 5, 6, 1); }
                        } else K.inset(f, 'seam');
                    });
                    if (!rot) { K.rect('#eceff1', -4, -4, 8, 1); K.rect('seam', -12, -2, 24, 1); }   // the centre drawer in the apron
                },
                onTop: function (rot, t, lift) {
                    // dot-matrix printer with tractor-feed paper rising from its back
                    var pr = K.turn([18, -17, 16, 10], rot), py = K.box(pr[0], pr[1], pr[2], pr[3], lift, 6, '#e0d7bd', { front: '#cbc1a3' });
                    var pf = K.face(rot, [18, -17, 16, 10], lift, 6);
                    if (rot !== 180) { K.rect('#3e3a30', pf[0] + 2, pf[1] + 2, pf[2] - 4, 1); K.rect('#76ff03', pf[0] + pf[2] - 3, pf[1] + 4, 1, 1); }
                    var pp = ubox(K, rot, [20, -17, 12, 2], 27, 8, '#f6f4ec', '#eceadf');
                    if (!SIDE(rot)) for (var g = 2; g < 8; g += 3) K.rect('#cfe8cf', pp[0] + 1, pp[1] + g, pp[2] - 2, 1);
                    K.rect('#b0aa98', pp[0], pp[1], 1, pp[3]); K.rect('#b0aa98', pp[0] + pp[2] - 1, pp[1], 1, pp[3]);
                    // floppy disks (a stack) and a puzzle cube
                    var fl = K.turn([-34, -4, 7, 7], rot), fy = K.box(fl[0], fl[1], fl[2], fl[3], lift, 3, '#1565c0', { front: '#c62828' });
                    K.rect('#2e7d32', fl[0], fy + 1, fl[2], 1); K.rect('#b0bec5', fl[0] + 2, fy - fl[3], 3, 2);
                    var cb = ubox(K, rot, [26, 4, 4, 4], lift, 4, '#ffffff', '#c62828');
                    K.rect('#1e88e5', cb[0], cb[1] + 2, Math.ceil(cb[2] / 2), 2); K.rect('#fdd835', cb[0] + Math.ceil(cb[2] / 2), cb[1], Math.floor(cb[2] / 2), 2);
                    K.rect('#43a047', cb[0] + cb[2] - 1, cb[1] + 2, 1, 2);
                    if (rot) crt(rot);
                    if (rot) capKeys(K, rot, KB, lift, BEIGE, ['#efe8d2', '#a89f86', '#c62828']);
                    // beige mouse with its cord back to the terminal
                    var ms = K.turn([19, 5, 4, 6], rot), cd = K.turn([20, -1, 1, 6], rot);
                    K.rect('#5d5747', cd[0], cd[1] - lift, Math.max(1, cd[2]), Math.max(1, cd[3]));
                    K.rect(BEIGE, ms[0], ms[1] - lift, ms[2], ms[3]); K.rect(BEIGE_LT, ms[0], ms[1] - lift, ms[2], 1); K.rect('#a89f86', ms[0], ms[1] - lift + ms[3] - 1, ms[2], 1);
                },
                monitor: { bezel: '#263238', stand: BEIGE_DK },
                last: function (rot) {
                    if (rot) return;
                    crt(0);
                    K.monitors(0, on, { bezel: '#263238', stand: BEIGE_DK });                          // the glass over its casing
                    capKeys(K, 0, KB, 21, BEIGE, ['#efe8d2', '#a89f86', '#c62828']);
                }
            });
        }
    });
    // ---- Maker bench: a hardware hacker's workbench with a pegboard, an oscilloscope and a soldering station ----
    V.push({
        type: 'desk', id: 'maker', label: 'Maker Bench',
        info: 'A hardware hacker\'s workbench: a pegboard of tools, an oscilloscope, a soldering mat with a circuit board, a soldering station, parts drawers and bins on a lower shelf.',
        seat: 'sit', colors: ['wood', 'grey-orange', 'black-green', 'walnut', 'grey', 'black'],
        screens: [{ plan: [-6, -12, 30, 2], z: 30, h: 20, foot: [7, -17, 4, 3] }],
        manifest: {
            footprint: [[-40, -30, 80, 44]], footBack: 12,
            projection: lowProj([
                { name: 'top', plan: [-40, -18, 80, 32], z: 16, h: 5 }, { name: 'legs', plan: [-40, -18, 80, 32], z: 0, h: 16, open: true },
                { name: 'binL', plan: [-36, 1, 14, 11], z: 6, h: 7 }, { name: 'binR', plan: [22, 1, 14, 11], z: 6, h: 7 },
                { name: 'pegboard', plan: [-40, -18, 24, 3], z: 21, h: 34, upright: true },   // left of the screen: never in front of a 180 sitter
                { name: 'scope', plan: [-37, -14, 16, 10], z: 21, h: 10 },
                { name: 'drawers', plan: [25, -17, 13, 8], z: 21, h: 14, upright: true },
                { name: 'station', plan: [24, -6, 10, 8], z: 21, h: 4 },
                { name: 'iron', plan: [30, -5, 3, 3], z: 25, h: 7, upright: true },
                { name: 'hands', plan: [-18, -10, 4, 4], z: 21, h: 9, upright: true },
                { name: 'keyboard', plan: [-14, 3, 26, 7], z: 21, h: 0, flat: true }]),
            seats: closeSeats(),
            surface: Object.assign({ rect: [-40, -39, 80, 32] }, topSpots(21, {
                item: [-32, 8], food: [30, 8], keyboard: [-1, 6], mouse: [18, 7], papers: [-2, -2],
                at: { 90: { item: [-5, -41], food: [3, -21], papers: [-4, -55] }, 270: { item: [10, -51], food: [-4, -25], papers: [6, 7] } } }))
        },
        draw: function (K, rot, C, on) {
            var PEG = '#c8a46e', PEG_DK = '#a8844e', HOLE = '#7d5f35';
            var peg = function (rot) {                        // the pegboard: holes, and at 0 the tools hanging on it
                var f = ubox(K, rot, [-40, -18, 24, 3], 21, 34, PEG, PEG_DK);
                if (SIDE(rot)) { K.rect(PEG_DK, f[0], f[1], 1, f[3]); return; }
                for (var y = f[1] + 2; y < f[1] + f[3] - 1; y += 3) for (var x = f[0] + 2; x < f[0] + f[2] - 1; x += 3) K.rect(rot ? PEG_DK : HOLE, x, y, 1, 1);
                if (rot) return;
                // pliers, a screwdriver, a hammer, wire spools, a tape measure (all at 0, on the board's face)
                K.rect('#90a4ae', -36, -70, 2, 6); K.rect('#90a4ae', -33, -70, 2, 6); K.rect('#d32f2f', -37, -64, 2, 7); K.rect('#d32f2f', -32, -64, 2, 7);
                K.rect('#b0bec5', -27, -71, 1, 8); K.rect('#fbc02d', -28, -63, 3, 7); K.rect('#f57f17', -28, -57, 3, 1);
                K.rect('#6d4c41', -21, -66, 2, 12); K.rect('#455a64', -24, -70, 8, 4); K.rect('#607d8b', -24, -70, 8, 1);
                [['#e53935', -37], ['#1e88e5', -30], ['#43a047', -23]].forEach(function (s) {
                    K.rect('#5d4037', s[1], -51, 6, 6); K.rect(s[0], s[1] + 1, -50, 4, 4); K.rect('#3e2723', s[1] + 2, -49, 2, 2);
                });
            };
            var scope = function (rot, lift) {               // oscilloscope: case, a screen with a green trace, knobs
                var s = K.turn([-37, -14, 16, 10], rot); K.box(s[0], s[1], s[2], s[3], lift, 10, '#cfd8dc', { front: '#b0bec5' });
                var f = K.face(rot, [-37, -14, 16, 10], lift, 10);
                if (rot === 180) { K.rect('#90a4ae', f[0] + 3, f[1] + 3, f[2] - 6, 1); return; }
                var sw = Math.min(9, f[2] - 4);
                K.rect('#0b1a10', f[0] + 2, f[1] + 2, sw, 6);
                for (var i = 0; i < sw; i++) K.rect('#69f0ae', f[0] + 2 + i, f[1] + 5 + [0, -1, -2, -2, -1, 0, 1, 2, 2, 1][i % 10], 1, 1);
                if (f[2] > sw + 5) { K.rect('#37474f', f[0] + sw + 3, f[1] + 2, 2, 2); K.rect('#37474f', f[0] + sw + 3, f[1] + 6, 2, 2); }
            };
            K.desk(rot, on, {
                floor: [
                    [[-40, -18, 3, 3], 0, 16, 'metalDk', 'leg'], [[37, -18, 3, 3], 0, 16, 'metalDk', 'leg'],
                    [[-40, 11, 3, 3], 0, 16, 'metalDk', 'leg'], [[37, 11, 3, 3], 0, 16, 'metalDk', 'leg'],    // steel legs
                    [[-38, -16, 76, 28], 4, 2, 'metalDk', 'leg'],                                             // lower shelf
                    [[-36, 1, 14, 11], 6, 7, 'accent'], [[22, 1, 14, 11], 6, 7, '#1e88e5']                    // parts bins (in sight under the front edge)
                ],
                top: [[-40, -18, 80, 32], 16, 5, 'top', 'faceDk'], grain: 4,
                under: function (rot) {
                    [[-36, 1, 14, 11], [22, 1, 14, 11]].forEach(function (p) {                    // bin labels
                        var f = K.face(rot, p, 6, 7); K.rect('#eceff1', f[0] + 2, f[1] + 2, Math.min(5, f[2] - 3), 2);
                    });
                },
                onTop: function (rot, t, lift) {
                    peg(rot);
                    // soldering mat with its grid, a circuit board with chips and gold pads
                    var m = flat(K, rot, [-24, -6, 46, 19], lift, '#00897b');
                    for (var gx = m[0] + 4; gx < m[0] + m[2]; gx += 5) K.rect('#26a69a', gx, m[1], 1, m[3]);
                    var b = flat(K, rot, [-22, -4, 10, 7], lift, '#2e7d32');
                    K.rect('#212121', b[0] + 2, b[1] + 2, 3, 2); K.rect('#212121', b[0] + Math.max(2, b[2] - 4), b[1] + 1, 2, 2); K.rect('#ffd54f', b[0] + 1, b[1] + b[3] - 2, Math.max(1, b[2] - 2), 1);
                    // helping hands: a weighted base, a post and two clip arms
                    var hh = ubox(K, rot, [-18, -10, 4, 4], lift, 2, '#37474f', '#263238');
                    var hx = hh[0] + Math.floor(hh[2] / 2);
                    K.rect('#b0bec5', hx, hh[1] - 7, 1, 7); K.rect('#b0bec5', hx - 3, hh[1] - 7, 3, 1); K.rect('#b0bec5', hx + 1, hh[1] - 6, 3, 1);
                    K.rect('#d32f2f', hx - 4, hh[1] - 7, 1, 2); K.rect('#d32f2f', hx + 4, hh[1] - 6, 1, 2);
                    scope(rot, lift);
                    // parts drawers: rows of coloured fronts
                    var dr = ubox(K, rot, [25, -17, 13, 8], lift, 14, '#cfd8dc', '#90a4ae');
                    K.rect('accent', dr[0], dr[1], dr[2], 1);                                   // its lit top edge
                    if (rot !== 180) {
                        var DC = ['#ef5350', '#ffca28', '#66bb6a', '#42a5f5'];
                        for (var r = 0; r < 4; r++) for (var c = 0; c + 3 <= dr[2] - 1; c += 4) K.rect(DC[(r + c / 4) % 4], dr[0] + 1 + c, dr[1] + 1 + r * 3, 3, 2);
                    }
                    // soldering station (red read-out) and the iron in its holder
                    var st = K.turn([24, -6, 10, 8], rot), sy = K.box(st[0], st[1], st[2], st[3], lift, 4, '#37474f', { front: '#263238' });
                    var sf = K.face(rot, [24, -6, 10, 8], lift, 4);
                    if (rot !== 180) K.rect('#ff5252', sf[0] + 1, sf[1] + 1, Math.min(4, sf[2] - 2), 2);
                    var ir = ubox(K, rot, [30, -5, 3, 3], 25, 7, '#b0bec5', '#90a4ae');
                    K.rect('#1565c0', ir[0], ir[1] - 3, ir[2], 3); K.rect('#ffca28', ir[0] + ir[2], ir[1] - 3, 1, 1);
                    if (rot) { K.keys(rot, [-14, 3, 26, 7], lift); K.mouse(rot, [16, 4, 4, 6], lift); }
                },
                monitor: { arm: true, bezel: '#1b1f24' },
                last: function (rot) {
                    if (rot) return;
                    K.keys(0, [-14, 3, 26, 7], 21); K.mouse(0, [16, 4, 4, 6], 21);
                }
            });
        }
    });
    // ---- Cosy home office: warm wood, fairy lights along the edge, a table lamp, a sleeping cat in its bed ----
    V.push({
        type: 'desk', id: 'cosy', label: 'Cosy Home Office',
        info: 'A warm home-office desk: fairy lights strung along the edge and over the screen, a fabric table lamp and a cat asleep in its bed on the desk.',
        seat: 'sit', colors: ['wood', 'walnut', 'white', 'white-pink', 'grey', 'walnut-brass'],
        screens: [{ plan: [-19, -11, 32, 2], z: 23, h: 22, foot: [-9, -14, 12, 5] }],
        manifest: {
            footprint: [[-34, -30, 68, 44]], footBack: 12,
            projection: lowProj([
                { name: 'top', plan: [-34, -18, 68, 32], z: 16, h: 5 }, { name: 'legs', plan: [-34, -18, 68, 32], z: 0, h: 16, open: true },
                { name: 'lamp', plan: [-33, -17, 10, 10], z: 21, h: 17, upright: true },
                { name: 'catbed', plan: [16, -12, 16, 12], z: 21, h: 3 },
                { name: 'cat', plan: [18, -10, 12, 8], z: 24, h: 3 },
                { name: 'keyboard', plan: [-15, 3, 30, 7], z: 21, h: 0, flat: true }]),
            seats: closeSeats(),
            surface: Object.assign({ rect: [-34, -39, 68, 32] }, topSpots(21, {
                item: [-27, -3], food: [28, 7], keyboard: [0, 6], mouse: [19, 7], papers: [-26, 9],
                at: { 90: { item: [-4, -41], papers: [-4, -50] }, 270: { item: [-1, -1], papers: [8, 7] } } }))
        },
        draw: function (K, rot, C, on) {
            var BULB = ['#ffe082', '#ffcc80', 'accent', '#fff59d'];
            var lights = function (f, n0) {                   // a sagging string of warm bulbs across a face [x, y, w, h]
                if (f[2] < 6) return;
                for (var x = 1, k = n0 || 0; x < f[2] - 1; x++) {
                    var u = (x % 12) / 12, sag = Math.round(Math.sin(u * Math.PI) * 2);
                    K.rect('#5d4a3a', f[0] + x, f[1] + 1 + sag, 1, 1);
                    if (x % 4 === 2) { K.rect(BULB[k % 4], f[0] + x, f[1] + 2 + sag, 1, 2); k++; }
                }
            };
            var cat = function (rot, lift) {                  // the bed (a soft rim) and the cat curled up asleep
                var b = K.turn([16, -12, 16, 12], rot), by = K.box(b[0], b[1], b[2], b[3], lift, 3, '#b39ddb', { front: '#9575cd' });
                K.rect('#d1c4e9', b[0] + 1, by - b[3] + 1, b[2] - 2, b[3] - 2); K.rect('#ede7f6', b[0] + 2, by - b[3] + 2, b[2] - 4, b[3] - 4);
                var c = K.turn([18, -10, 12, 8], rot), cy = c[1] - lift - 3;
                K.rect('#ef9a3a', c[0] + 1, cy, c[2] - 2, c[3]); K.rect('#ef9a3a', c[0], cy + 1, c[2], c[3] - 2);
                K.rect('#f5b971', c[0] + 2, cy + 1, c[2] - 4, 1);
                for (var i = 2; i < (c[2] >= c[3] ? c[2] : c[3]) - 2; i += 3) {    // stripes across the back
                    if (c[2] >= c[3]) K.rect('#c66f1c', c[0] + i, cy + 1, 1, c[3] - 3); else K.rect('#c66f1c', c[0] + 1, cy + i, c[2] - 3, 1);
                }
                var h = K.turn([18, -9, 4, 5], rot), hy = h[1] - lift - 4;                 // the head tucked in, two ears
                K.rect('#f0a24a', h[0], hy, h[2], h[3]); K.rect('#ef9a3a', h[0], hy - 1, 1, 1); K.rect('#ef9a3a', h[0] + h[2] - 1, hy - 1, 1, 1);
                if (rot !== 180) K.rect('#6d3b12', h[0] + 1, hy + 2, Math.max(1, h[2] - 2), 1);   // closed eyes
                K.rect('accent', h[0], hy + h[3] - 1, h[2], 1);                                // collar
                var t = K.turn([28, -4, 3, 3], rot); K.rect('#c66f1c', t[0], t[1] - lift - 3, t[2], t[3]);   // the tail round the front
            };
            var lamp = function (rot, lift) {                 // brass stem, a cream fabric shade lit from inside, its pool of light
                flat(K, rot, [-34, -18, 16, 14], lift, 'rgba(255,224,130,0.22)');
                var st = ubox(K, rot, [-30, -14, 4, 4], lift, 9, '#c9a227', '#a8861c');
                var sh = ubox(K, rot, [-33, -17, 10, 10], 30, 8, '#f3e5c8', '#e8d3a8');
                K.rect('#fff3d6', sh[0] + 1, sh[1] + sh[3] - 2, sh[2] - 2, 1);
                if (rot !== 180) K.rect('rgba(255,224,130,0.45)', sh[0] + 1, sh[1] + sh[3], sh[2] - 2, 2);
            };
            K.desk(rot, on, {
                floor: [
                    [[-32, -16, 3, 3], 0, 16, 'leg', 'legHi'], [[29, -16, 3, 3], 0, 16, 'leg', 'legHi'],
                    [[-32, 10, 3, 3], 0, 16, 'leg', 'legHi'], [[29, 10, 3, 3], 0, 16, 'leg', 'legHi']         // tapered legs
                ],
                top: [[-34, -18, 68, 32], 16, 5, 'top', 'face'], grain: 8,
                keys: [-15, 3, 30, 7], mouse: [17, 4, 4, 6],
                under: function (rot) {
                    [[-32, -16, 3, 3], [29, -16, 3, 3], [-32, 10, 3, 3], [29, 10, 3, 3]].forEach(function (p) {   // the taper: a narrower foot
                        var f = K.face(rot, p, 0, 16); K.rect('rgba(0,0,0,0.18)', f[0] + f[2] - 1, f[1] + 8, 1, 8); K.rect('pull', f[0], f[1] + f[3] - 2, f[2], 2);
                    });
                    var e = K.face(rot, [-34, -18, 68, 32], 16, 5);
                    if (!rot) { K.rect('seam', -12, e[1] + 1, 1, 4); K.rect('seam', 12, e[1] + 1, 1, 4); K.rect('pull', -1, e[1] + 2, 2, 2); }   // the drawer, its knob
                    lights(e, rot / 90);
                },
                onTop: function (rot, t, lift) {
                    cat(rot, lift);
                    lamp(rot, lift);
                },
                monitor: { bezel: '#263238', stand: '#8d6e63' },
                last: function (rot) {
                    if (rot) return;
                    K.rect('#5d4a3a', -18, -55, 30, 1);                                             // a string along the screen's top edge
                    for (var x = -16, k = 1; x < 12; x += 4, k++) K.rect(BULB[k % 4], x, -57, 1, 2);
                }
            });
        }
    });

    // ---- Standing desk: a sit-stand frame raised to standing height, one screen on an arm ----
    // The person stands at the desk (seat 'stand': no chair); the stand point is in front of the
    // top's front edge (rot 0), beside it (90 / 270) or behind it (180).
    V.push({
        type: 'desk', id: 'standing', label: 'Standing Desk',
        info: 'A sit-stand desk raised to standing height: one screen on an arm, no chair. The agent works standing.',
        seat: 'stand', colors: ['white', 'black', 'wood', 'walnut', 'grey'],
        screens: [{ plan: [-16, -12, 32, 2], z: 42, h: 21, foot: [-2, -18, 4, 3] }], screenTop: 30,   // at eye height on a clamp arm
        manifest: {
            footprint: [[-32, -30, 64, 40]], footBack: 12,
            projection: { class: 'low', views: { 0: 'front', 90: 'side', 180: 'back', 270: 'side' }, parts: [
                { name: 'top', plan: [-32, -18, 64, 28], z: 26, h: 4 }, { name: 'legs', plan: [-32, -18, 64, 28], z: 0, h: 26, open: true },
                { name: 'keyboard', plan: [-14, 2, 28, 7], z: 30, h: 0, flat: true }] },
            parts: [{ name: 'body', rect: 'proj', base: -1 }],
            surface: { rect: [-32, -48, 64, 28], spots: { item: [-23, -33], food: [24, -33], keyboard: [0, -24], mouse: [21, -24], papers: [-22, -24] },
                // 90 / 270 drink 3 px north: on the turned top lifted by its own 30 (_deskTopRect since v0.13 finish), not 21
                spotsAt: { 90: { item: [-4, -52], food: [-4, -3], papers: [-6, -8] }, 180: { item: [22, -24], food: [-23, -24], papers: [-24, -34] },
                           270: { item: [4, -52], food: [4, -3], papers: [6, -8] } } },
            // the feet (x, y) of the person standing at it, 4 px clear of the footprint, facing the desk; floor (from the
            // feet) = where the walk ends when that is not the feet: beside a turned desk the walk ends with the body
            // clear of the art, then the person steps in. 180: behind the top, far enough north that the hips clear
            // its far edge (legs hidden, the screen's back over the torso)
            seats: [{ id: 'stand', kind: 'desk', spot: [0, 0], x: 0, y: 14, facing: 'up', legs: 'stand',
                at: { 90: { x: -14, y: 0, legs: 'stand', floor: [-14, 0] }, 180: { x: 0, y: -30, legs: 'stand', front: ['monitor'] },
                      270: { x: 14, y: 0, legs: 'stand', floor: [14, 0] } } }]
        },
        draw: function (K, rot, C, on) {
            K.desk(rot, on, {
                floor: [
                    [[-32, -16, 8, 24], 0, 2, 'metalDk'], [[24, -16, 8, 24], 0, 2, 'metalDk'],         // T feet
                    [[-30, -6, 4, 4], 2, 24, 'metal', 'metalDk'], [[26, -6, 4, 4], 2, 24, 'metal', 'metalDk'], // lifting columns
                    [[-24, -5, 48, 2], 22, 3, 'metalDk']                                               // crossbar under the top
                ],
                top: [[-32, -18, 64, 28], 26, 4, 'top', 'face'], grain: 0,
                keys: [-14, 2, 28, 7], mouse: [19, 3, 4, 6],
                under: function (rot) {
                    var c = K.face(rot, [-30, -6, 4, 4], 2, 24), d = K.face(rot, [26, -6, 4, 4], 2, 24);   // column seams (telescoping)
                    K.rect('metalDk', c[0], c[1] + 9, c[2], 1); K.rect('metalDk', d[0], d[1] + 9, d[2], 1);
                    if (!rot) { K.rect('#263238', 18, -2, 6, 3); K.rect('#76ff03', 19, -1, 2, 1); }        // height keypad under the front edge
                },
                onTop: function (rot, t, lift) {
                    var ph = K.turn([-27, -13, 6, 9], rot);                                            // phone, face up
                    K.rect('#212121', ph[0], ph[1] - lift, ph[2], ph[3]); K.rect('#37474f', ph[0] + 1, ph[1] - lift + 1, ph[2] - 2, ph[3] - 2);
                    var nt = K.turn([-26, 1, 7, 7], rot);                                              // sticky notes
                    K.rect('#fff176', nt[0], nt[1] - lift, nt[2], nt[3]); K.rect('#fbc02d', nt[0], nt[1] - lift + nt[3] - 1, nt[2], 1);
                },
                monitor: { arm: true, bezel: '#222b30' }
            });
        }
    });
    // ---- Standing desks (deskart). A standing body's forearms end 26 px over the feet (the same chibi as a sitter),
    // so at rotation 0 the hands land on the top at plan y = feet + 26 - top z: the top overhangs the feet (they stand
    // under its front edge, the legs / cabinet set back) and the keyboard sits there. Side-on the hands reach 10 px
    // ahead of the feet; behind a 180 desk the front-view hands hang 3 px over the feet (the legs hidden there).

    // ---- Treadmill desk: a walking pad under a sit-stand top, the screen on an arm at eye height ----
    V.push({
        type: 'desk', id: 'treadmill', label: 'Treadmill Desk',
        info: 'Work while you walk: a walking pad under a standing desk, the screen on an arm at eye height, a step counter and a water bottle. No chair.',
        seat: 'stand', colors: ['black-green', 'white', 'grey-orange', 'black', 'wood', 'white-blue'],
        screens: [{ plan: [-16, -12, 32, 2], z: 42, h: 20, foot: [-2, -18, 4, 3] }], screenTop: 28,
        manifest: {
            footprint: [[-32, -30, 64, 30]], footBack: 12,               // the lifting frame; the top overhangs it by 14
            projection: lowProj([
                { name: 'top', plan: [-32, -18, 64, 32], z: 24, h: 4 }, { name: 'legs', plan: [-32, -18, 64, 18], z: 0, h: 24, open: true },
                { name: 'cols', plan: [-30, -14, 60, 4], z: 0, h: 24 },               // the lifting columns: the top rests on them (no footprint growth)
                { name: 'bottle', plan: [25, -14, 4, 4], z: 28, h: 11, upright: true },
                { name: 'pad', plan: [-14, -6, 28, 36], z: 1, h: 2, flat: true },      // the walking pad: floor, not a depth part
                { name: 'keyboard', plan: [-14, 3, 28, 7], z: 28, h: 0, flat: true }], false),
            parts: [{ name: 'body', proj: ['top', 'legs', 'cols', 'bottle', 'keyboard', 'monitor'], base: -1 }],
            surface: Object.assign({ rect: [-32, -46, 64, 32] }, topSpots(28, {
                item: [-24, -9], food: [24, -1], keyboard: [0, 6], mouse: [19, 7], papers: [-24, 8],
                at: { 90: { item: [8, -52], papers: [-4, -50] }, 270: { item: [-8, 0], food: [-1, -48], papers: [6, 2] } } })),
            // feet under the top's overhang (the hands reach the keys); the walk ends in front of the top, then a step in
            seats: [{ id: 'stand', kind: 'desk', spot: [0, 0], x: 0, y: 4, facing: 'up', legs: 'stand', floor: [0, 18],
                at: { 90: { x: -14, y: 0, legs: 'stand', floor: [-16, 0] }, 180: { x: 0, y: -30, legs: 'stand', front: ['monitor'] },
                      270: { x: 14, y: 0, legs: 'stand', floor: [16, 0] } } }]
        },
        draw: function (K, rot, C, on) {
            var pad = function (rot) {                        // the walking pad: deck, belt with tread lines, lit rails, a read-out
                var p = K.turn([-14, -6, 28, 36], rot);
                K.box(p[0], p[1], p[2], p[3], 1, 2, '#3a3f45', { front: '#2a2e33' });
                var wide = p[2] > p[3], b = [p[0] + 3, p[1] - 1, p[2] - 6, p[3] - 4];     // the belt on the deck's top face
                K.rect('#1b1d20', b[0], b[1], b[2], b[3]);
                if (wide) for (var x = b[0] + 1; x < b[0] + b[2]; x += 3) K.rect('#2c3035', x, b[1], 1, b[3]);
                else for (var yy = b[1] + 1; yy < b[1] + b[3]; yy += 3) K.rect('#2c3035', b[0], yy, b[2], 1);
                if (wide) { K.rect('accent', b[0], b[1] - 1, b[2], 1); K.rect('accent', b[0], b[1] + b[3], b[2], 1); }
                else { K.rect('accent', b[0] - 1, b[1], 1, b[3]); K.rect('accent', b[0] + b[2], b[1], 1, b[3]); }
            };
            K.desk(rot, on, {
                floor: [
                    [[-32, -16, 7, 16], 0, 2, 'metalDk'], [[25, -16, 7, 16], 0, 2, 'metalDk'],                // T feet
                    [[-30, -14, 4, 4], 2, 22, 'metal', 'metalDk'], [[26, -14, 4, 4], 2, 22, 'metal', 'metalDk'],  // lifting columns
                    [[-24, -13, 48, 2], 20, 3, 'metalDk']                                                      // crossbar
                ],
                top: [[-32, -18, 64, 32], 24, 4, 'top', 'face'], grain: 0,
                keys: [-14, 3, 28, 7], mouse: [17, 4, 4, 6],
                under: function (rot) {
                    pad(rot);
                    var c = K.face(rot, [-30, -14, 4, 4], 2, 22), d = K.face(rot, [26, -14, 4, 4], 2, 22);   // telescoping seams
                    K.rect('metalDk', c[0], c[1] + 8, c[2], 1); K.rect('metalDk', d[0], d[1] + 8, d[2], 1);
                },
                onTop: function (rot, t, lift) {
                    var sc = flat(K, rot, [-30, 2, 9, 6], lift, '#263238');                     // the pad's step counter
                    K.rect('#76ff03', sc[0] + 1, sc[1] + 1, Math.max(1, sc[2] - 3), 1); K.rect('#76ff03', sc[0] + 1, sc[1] + 3, 2, 1);
                    var bt = ubox(K, rot, [25, -14, 4, 4], lift, 9, '#29b6f6', '#0288d1');      // water bottle and its cap
                    K.rect('#eceff1', bt[0], bt[1] - 2, bt[2], 2); K.rect('rgba(255,255,255,0.5)', bt[0] + 1, bt[1] + 1, 1, bt[3] - 2);
                },
                monitor: { arm: true, bezel: '#1e272c' }
            });
        }
    });

    // ---- Counter desk: a bar-height counter on a cabinet base with a brass foot rail, no stool ----
    V.push({
        type: 'desk', id: 'counter', label: 'Counter Desk',
        info: 'A bar-height counter: a thick top over a cabinet base with shelves behind, a brass foot rail, a screen and a laptop. Stood at, no stool.',
        seat: 'stand', colors: ['walnut-brass', 'white', 'black-gold', 'wood', 'grey', 'black'],
        screens: [
            { plan: [-26, -12, 32, 2], z: 42, h: 20, foot: [-14, -15, 8, 5] },
            { plan: [9, -9, 19, 2], z: 31, h: 14, foot: [9, -7, 19, 7] }              // the laptop (its deck = the foot)
        ], screenTop: 30,
        manifest: {
            footprint: [[-32, -30, 64, 28]], footBack: 12,               // the cabinet; the top overhangs it by 22 (knee room)
            projection: lowProj([
                { name: 'top', plan: [-34, -18, 68, 38], z: 25, h: 5 },
                { name: 'cabinet', plan: [-32, -18, 64, 16], z: 0, h: 25 },
                { name: 'rail', plan: [-30, -1, 60, 2], z: 0, h: 6, open: true },        // the foot rail on its brackets (not floor)
                { name: 'plant', plan: [-33, -16, 8, 6], z: 30, h: 12, upright: true },
                { name: 'keyboard', plan: [-14, 10, 28, 7], z: 30, h: 0, flat: true }], false),
            parts: [{ name: 'body', rect: 'proj', base: -1 }],
            surface: Object.assign({ rect: [-34, -48, 68, 38] }, topSpots(30, {
                item: [-26, 2], food: [23, 13], keyboard: [0, 13], mouse: [19, 14], papers: [-25, 14],
                at: { 90: { item: [-2, -54], food: [2, -44], papers: [-11, -3] }, 180: { item: [27, -30], food: [-26, -18], papers: [8, -30] },
                      270: { food: [5, -54], papers: [2, -22] } } })),
            seats: [{ id: 'stand', kind: 'desk', spot: [0, 0], x: 0, y: 10, facing: 'up', legs: 'stand', floor: [0, 14],
                at: { 90: { x: -23, y: 0, legs: 'stand', floor: [-12, 0] }, 180: { x: 0, y: -41, legs: 'stand', front: ['monitor'] },
                      270: { x: 23, y: 0, legs: 'stand', floor: [12, 0] } } }]
        },
        draw: function (K, rot, C, on) {
            K.desk(rot, on, {
                floor: [
                    [[-32, -18, 64, 16], 0, 25, 'body', 'face'],                                              // cabinet
                    [[-30, -1, 60, 2], 3, 3, 'accent']                                                         // foot rail (brass, gold, chrome: the accent)
                ],
                top: [[-34, -18, 68, 38], 25, 5, 'top', 'faceDk'], grain: 10,
                keys: [-14, 10, 28, 7], mouse: [17, 11, 4, 6],
                under: function (rot) {
                    var f = K.face(rot, [-32, -18, 64, 16], 0, 25);
                    K.rect('#1c1f22', f[0] + 1, f[1] + f[3] - 3, f[2] - 2, 3);                   // kick plate
                    if (!rot) {                                                                // two doors with long pulls
                        K.rect('seam', 0, f[1] + 2, 1, f[3] - 6); K.rect('pull', -4, f[1] + 6, 1, 10); K.rect('pull', 3, f[1] + 6, 1, 10);
                        K.rect('seam', -30, f[1] + 2, 1, f[3] - 6); K.rect('seam', 29, f[1] + 2, 1, f[3] - 6);
                    } else if (rot === 180) {                                                  // the back: open shelves of books
                        for (var s = 0; s < 2; s++) {
                            var sy = f[1] + 2 + s * 11;
                            K.rect('faceDk', f[0] + 2, sy, f[2] - 4, 9);
                            for (var x = f[0] + 3, k = s * 3; x < f[0] + f[2] - 4; x += 3, k++) if (k % 5 !== 4) K.rect(BOOKS[k % BOOKS.length], x, sy + 1 + (k % 3 === 1 ? 1 : 0), 2, 8 - (k % 3 === 1 ? 1 : 0));
                            K.rect('accent', f[0] + 2, sy + 9, f[2] - 4, 1);                       // the shelf's brass lip
                        }
                    } else K.inset(f, 'seam');
                    [[-26, -1, 2, 2], [24, -1, 2, 2]].forEach(function (p) { var b = K.face(rot, p, 0, 4); K.rect(K.tone('accent', 0.75), b[0], b[1], b[2], b[3]); });  // rail brackets
                },
                onTop: function (rot, t, lift) {
                    plant(K, rot, [-32, -16, 6, 6], lift, 5, 7, '#9e9e9e', '#558b2f');             // a herb pot (concrete)
                    var co = flat(K, rot, [-30, -2, 7, 7], lift, '#6d4c41'); K.rect('#8d6e63', co[0] + 1, co[1] + 1, co[2] - 2, co[3] - 2);   // a cork coaster
                },
                monitor: { bezel: '#1e272c', stand: '#b0bec5' }
            });
        }
    });
})();
