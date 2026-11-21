// People, pets and chairs as stacks (v0.13). Replaces the placeholder figure of
// stack-people.js: S.peopleItems pushes every agent, pet and Office life extra
// as stacked voxel figures, plus a chair at every seat (desks, the boss desk,
// the meeting table). See stack/README.md for the kit.
//
// A person is four meshes pushed with one id (one outline round the whole
// figure): legs, torso, arms and head, all built in body space (x right,
// y forward = +y at turn 0, z up, origin on the floor between the feet; 1 voxel
// = 1 world px, the classic 48 px figure). The parts are cached by look + pose
// + frame only, so a walk cycle, typing or a blink swaps a small mesh and never
// rebakes per frame.
//
// The look comes from the classic art itself: the head's hair, headwear,
// costume hoods and Office life decorations are the visual hull of the classic
// front, back and side art (a voxel is kept when the side view and the front
// (or back) view both cover it), painted from whichever view faces it; the face
// is the classic front face painted onto the head; the torso is painted from the
// classic front / back / side top art (tops, neckwear, costume bodies, badge).
// Arms, legs, props, pets and the poses are hand built.
(function () {
    'use strict';
    var S = window.VOStack = window.VOStack || {};
    var C = S.color, MAT = S.MAT, tone = C.tone, mix = C.mix;
    var G = window;          // where game.js lives (the gallery points this at an office iframe)
    var DEG = Math.PI / 180;
    var CH = S.chars = S.chars || {};
    CH.useGlobals = function (g) { G = g || window; };

    // ---------- small helpers ----------
    function hexOk(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); }
    function safeHex(c, d) {
        if (hexOk(c)) return c;
        if (typeof c === 'string' && /^#[0-9a-f]{3}$/i.test(c)) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
        return d;
    }
    function gf(name) { var f = G[name]; return typeof f === 'function' ? f : null; }
    function wrapA(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
    function easeA(cur, to, k) { var d = wrapA(to - cur); return Math.abs(d) < 0.003 ? to : wrapA(cur + d * k); }
    function faceTurn(fx, fy) { return Math.atan2(-fx, fy); }            // the turn that makes local +y point along (fx, fy)
    var VIEW_TURN = { down: 0, up: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 };
    var VIEW_VEC = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
    function rot2(x, y, t) { var c = Math.cos(t), s = Math.sin(t); return [x * c - y * s, x * s + y * c]; }
    function hash(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); }

    // ---------- capturing the classic art ----------
    // draw(g) paints in body pixels (origin = the feet, y up negative), the way
    // Agent.draw does; the result reads (x, row) -> [r, g, b] or null.
    var CAP = { W: 120, H: 136, X: 60, Y: 96 };
    var capC = null, capG = null;
    function capture(draw) {
        if (!capC) {
            capC = document.createElement('canvas'); capC.width = CAP.W; capC.height = CAP.H;
            capG = capC.getContext('2d', { willReadFrequently: true });
        }
        var g = capG;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1; g.shadowColor = 'transparent'; g.filter = 'none';
        g.clearRect(0, 0, CAP.W, CAP.H);
        g.setTransform(1, 0, 0, 1, CAP.X, CAP.Y);
        g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineWidth = 1;
        var ok = true;
        try { draw(g); } catch (e) { ok = false; if (!capture.warned) { capture.warned = true; console.warn('[stack] people art', e); } }
        g.setTransform(1, 0, 0, 1, 0, 0);
        var d = g.getImageData(0, 0, CAP.W, CAP.H).data, any = false;
        for (var i = 3; i < d.length; i += 4) if (d[i] >= 128) { any = true; break; }
        if (!ok && !any) return null;
        return {
            any: any,
            at: function (x, row) {
                var px = x + CAP.X, py = row + CAP.Y;
                if (px < 0 || py < 0 || px >= CAP.W || py >= CAP.H) return null;
                var o = (py * CAP.W + px) * 4;
                return d[o + 3] >= 128 ? [d[o], d[o + 1], d[o + 2]] : null;
            }
        };
    }
    // Functions of game.js that draw on the global ctx.
    function withCtx(g, f) { var s = G.ctx; G.ctx = g; try { return f(); } finally { G.ctx = s; } }

    // ---------- the visual hull of three views ----------
    // box [x0, x1, y0, y1, z0, z1] (z = 4 - row). A voxel is in when the side
    // view covers (y, row) and the front view (y >= ymid) or the back view (seen
    // from behind, so mirrored) covers (x, row). Each slice's corners are
    // rounded, parts thinner than 2 px are thickened, and every voxel takes its
    // colour from the view that faces it.
    function viewHull(m, views, box, opts) {
        opts = opts || {};
        var F = views.front, B = views.back || views.front, Sd = views.side;
        if (!F || !Sd) return 0;
        var x0 = box[0], x1 = box[1], y0 = box[2], y1 = box[3], z0 = box[4], z1 = box[5];
        var W = x1 - x0, D = y1 - y0, H = z1 - z0, ymid = opts.ymid == null ? 1 : opts.ymid;
        var occ = new Uint8Array(W * D * H);
        var I = function (x, y, z) { return (x - x0) + W * ((y - y0) + D * (z - z0)); };
        var inB = function (x, y, z) { return x >= x0 && x < x1 && y >= y0 && y < y1 && z >= z0 && z < z1; };
        var has = function (x, y, z) { return inB(x, y, z) && occ[I(x, y, z)] === 1; };
        var x, y, z, n = 0;
        for (z = z0; z < z1; z++) {
            var row = 4 - z;
            for (y = y0; y < y1; y++) {
                if (!Sd.at(y, row)) continue;
                for (x = x0; x < x1; x++) {
                    var v = y >= ymid ? F.at(x, row) : B.at(-x - 1, row);
                    if (!v) continue;
                    if (opts.skip && opts.skip(x, y, z)) continue;
                    occ[I(x, y, z)] = 1; n++;
                }
            }
        }
        if (!n) return 0;
        // round each slice's corners (radius from its size)
        if (opts.round !== false) {
            for (z = z0; z < z1; z++) {
                var xa = 1e9, xb = -1e9, ya = 1e9, yb = -1e9;
                for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) if (occ[I(x, y, z)]) { if (x < xa) xa = x; if (x > xb) xb = x; if (y < ya) ya = y; if (y > yb) yb = y; }
                if (xb < xa) continue;
                var r = Math.min(opts.maxR || 6, Math.floor(Math.min(xb - xa + 1, yb - ya + 1) / 4));
                if (r < 2) continue;
                for (y = ya; y <= yb; y++) for (x = xa; x <= xb; x++) {
                    var i = I(x, y, z);
                    if (!occ[i]) continue;
                    var px = x + 0.5, py = y + 0.5;
                    var cx = Math.max(xa + r, Math.min(xb + 1 - r, px)), cy = Math.max(ya + r, Math.min(yb + 1 - r, py));
                    if ((px - cx) * (px - cx) + (py - cy) * (py - cy) > r * r + 0.6) occ[i] = 0;
                }
            }
        }
        // thicken 1 px parts (they blink as the stack turns)
        var add = [];
        for (z = z0; z < z1; z++) for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) {
            if (!occ[I(x, y, z)]) continue;
            if (!has(x - 1, y, z) && !has(x + 1, y, z) && inB(x + 1, y, z)) add.push(x + 1, y, z, x, y);
            if (!has(x, y - 1, z) && !has(x, y + 1, z) && inB(x, y + 1, z)) add.push(x, y + 1, z, x, y);
        }
        var src = new Map();
        for (var k = 0; k < add.length; k += 5) { var j = I(add[k], add[k + 1], add[k + 2]); if (!occ[j]) { occ[j] = 2; src.set(j, [add[k + 3], add[k + 4]]); } }
        // colour by the view that faces each voxel
        var col = function (x, y, z) {
            var row = 4 - z, f = y >= ymid ? F.at(x, row) : B.at(-x - 1, row), s = Sd.at(y, row);
            var exF = !has(x, y + 1, z), exB = !has(x, y - 1, z), exS = !has(x - 1, y, z) || !has(x + 1, y, z);
            if (exF && y >= ymid && f) return f;
            if (exB && y < ymid && f) return f;
            if (exS && s) return s;
            return f || s || F.at(x, row) || B.at(-x - 1, row);
        };
        var mat = opts.mat == null ? MAT.SOLID : opts.mat;
        for (z = z0; z < z1; z++) for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) {
            var ii = I(x, y, z), o = occ[ii];
            if (!o) continue;
            var c = null;
            if (o === 2) { var sp = src.get(ii); c = col(sp[0], sp[1], z); }
            else c = col(x, y, z);
            if (!c) continue;
            if (opts.tint) c = opts.tint(c, x, y, z);
            m.set(x, y, z, c, opts.matOf ? opts.matOf(c) : mat);
        }
        return n;
    }

    // Paint a view onto the surface of what is already in m: front (from +y),
    // back (from -y, mirrored), sides (from -x and +x). Only cells the art covers.
    function paintFront(m, cap, x0, x1, z0, z1, proud, only) {
        if (!cap) return;
        for (var z = z0; z < z1; z++) for (var x = x0; x < x1; x++) {
            var c = cap.at(x, 4 - z);
            if (!c) continue;
            if (only && !only(x, z, c)) continue;
            var y = m.oy + m.d - 1;
            while (y >= m.oy && !m.has(x, y, z)) y--;
            if (y < m.oy) continue;
            if (proud) m.set(x, y + 1, z, c);
            else m.set(x, y, z, c, m.get(x, y, z) >>> 24);
        }
    }
    function paintBack(m, cap, x0, x1, z0, z1) {
        if (!cap) return;
        for (var z = z0; z < z1; z++) for (var x = x0; x < x1; x++) {
            var c = cap.at(-x - 1, 4 - z);
            if (!c) continue;
            var y = m.oy;
            while (y < m.oy + m.d && !m.has(x, y, z)) y++;
            if (y >= m.oy + m.d) continue;
            m.set(x, y, z, c, m.get(x, y, z) >>> 24);
        }
    }
    // side art: sx forward -> y = map(sx); painted on both sides
    function paintSides(m, cap, y0, y1, z0, z1, mapY, proud) {
        if (!cap) return;
        for (var z = z0; z < z1; z++) for (var y = y0; y < y1; y++) {
            var c = cap.at(mapY ? mapY(y) : y, 4 - z);
            if (!c) continue;
            for (var side = -1; side <= 1; side += 2) {
                var x = side < 0 ? m.ox : m.ox + m.w - 1;
                while (x >= m.ox && x < m.ox + m.w && !m.has(x, y, z)) x -= side;
                if (x < m.ox || x >= m.ox + m.w) continue;
                if (proud) m.set(x + side, y, z, c);
                else m.set(x, y, z, c, m.get(x, y, z) >>> 24);
            }
        }
    }

    // ---------- the look ----------
    function lookOf(a) {
        var app = null;
        try { app = typeof a.getAppearance === 'function' ? a.getAppearance() : a.appearance; } catch (e) { app = null; }
        return app || {};
    }
    function fem(a) { return a && a.gender === 'F'; }
    function topColors(app, color) {
        var f = gf('_topColors');
        if (f) { try { return f(app, color); } catch (e) { /* plain */ } }
        var c = safeHex(color, '#607d8b');
        return { torso: c, shade: C.hex(tone(c, 0.88)), sleeve: C.hex(tone(c, 0.8)), fore: C.hex(tone(c, 0.7)), hand: null };
    }
    function costumeOf(app) { var f = gf('_lookCostume'); return f ? f(app) : (app && app.costume && app.costume !== 'none' ? app.costume : null); }
    function headSig(a, app) {
        return [app.skinTone, app.hairStyle, app.hairColor, app.hairHighlight, app.eyebrowStyle, app.eyeColor, app.lashes, app.lashStyle, app.lipColor,
            app.facialHair, app.facialHairColor, app.headwear, app.headwearColor, app.glasses, app.glassesColor, app.costume, a.gender].join('|');
    }
    function torsoSig(a, app) {
        return [safeHex(a.color, '#607d8b'), app.shirtStyle, app.neckwear, app.neckwearColor, app.costume, a.gender, a.emoji || '', app.skinTone].join('|');
    }
    // Office life decorations drawn on the body (intern lanyard, courier cap,
    // party hat, headphones): which are on, for the cache key.
    function decoSig(a) {
        if (typeof a._lifeDecorate !== 'function') return '';
        var s = 'd';
        if (a._lifeDecorLayers) s += Object.keys(a._lifeDecorLayers).sort().join(',');
        if (a._lifeIntern) s += '|I';
        if (a._lifeCourier) s += '|C' + ((a._lifeCourier.chan && a._lifeCourier.chan.tint) || '');
        return s;
    }
    // Capture a decoration in a view (it reads the body's view and facing).
    function decoCap(a, view) {
        if (typeof a._lifeDecorate !== 'function') return null;
        var sv = a._drawView, sf = a.faceDir, shy = a._drawHeadDy, shx = a._drawHeadDx, sho = a._drawHeadOff;
        a._drawView = view; a.faceDir = 1; a._drawHeadDy = 0; a._drawHeadDx = 0; a._drawHeadOff = null;
        try {
            return capture(function (g) { withCtx(g, function () { a._lifeDecorate(g, a, false); }); });
        } finally { a._drawView = sv; a.faceDir = sf; a._drawHeadDy = shy; a._drawHeadDx = shx; a._drawHeadOff = sho; }
    }

    // ---------- the head ----------
    // Skin box x [-12, 12), y [-10, 11), z [25, 43) (the classic head: 24 wide,
    // 18 tall, 21 deep in profile), rounded; the face is the classic front face.
    var HX = 12, HY0 = -10, HY1 = 11, HZ0 = 25, HZ1 = 43;
    function inHead(x, y, z) {
        var inset = z >= HZ1 - 1 ? 2 : z >= HZ1 - 2 ? 1 : z <= HZ0 ? 1 : 0;
        var rx = HX - inset, ry = (HY1 - HY0) / 2 - inset, cy = (HY0 + HY1) / 2;
        var u = (x + 0.5) / rx, v = (y + 0.5 - cy) / ry;
        return u * u * u * u + v * v * v * v <= 1.0;
    }
    var COVER_HATS = { hardhat: 1, cap: 1, beanie: 1, santa: 1, witch: 1, sunhat: 1 };
    function buildHead(a, app, expr, closed, mouth) {
        var m = S.model(-22, -21, 22, 22, 64, 10);
        var skin = safeHex(app.skinTone, '#ffcc80'), isF = fem(a), cos = costumeOf(app);
        var skinDk = tone(skin, 0.86);
        // skull + jaw
        m.box(-HX, HY0, HZ0, 2 * HX, HY1 - HY0, HZ1 - HZ0, function (x, y, z) { return inHead(x, y, z) ? skin : null; });
        // ears
        m.box(-HX - 1, -3, 30, 1, 4, 4, skinDk); m.box(HX, -3, 30, 1, 4, 4, skinDk);
        m.box(-HX - 1, -2, 31, 1, 2, 2, tone(skin, 0.78)); m.box(HX, -2, 31, 1, 2, 2, tone(skin, 0.78));
        // neck
        m.cyl(0, 0, 21, 4.5, 4, 5, skinDk);
        // the classic face, painted on the front
        var ff = gf('_drawFaceFront');
        if (ff) {
            var face = capture(function (g) { ff(g, app, isF, 0, closed, expr, mouth); });
            paintFront(m, face, -HX, HX, HZ0, HZ1);
        }
        // nose bump
        m.box(0, HY1 - 1, 30, 2, 1, 2, tone(skin, 0.9));
        m.box(0, HY1, 30, 2, 1, 1, tone(skin, 0.86));
        // facial hair round the jaw (profile art on both sides)
        var fh = gf('_drawFacialHair');
        if (fh && app.facialHair) {
            var side = capture(function (g) { fh(g, app, 'side', function (x, y, w, h) { g.fillRect(x, y, w, h); }); });
            paintSides(m, side, -2, HY1, HZ0, 34);
            if (app.facialHair === 'beard') {
                // a beard has volume: one layer proud under the chin
                var bc = safeHex(app.facialHairColor, null) || C.hex(tone(skin, 0.55));
                m.box(-10, 3, 24, 20, 8, 2, bc, MAT.SOFT);
            }
        }
        var hairTop = HZ1;
        // costume hood (lobster, chicken, ghost, santa, astronaut, dino)
        if (cos) {
            var views = costumeViews(cos);
            if (views) viewHull(m, views, [-22, 22, -21, 22, 12, 64], { ymid: 1, mat: MAT.SOFT, maxR: 6 });
        } else {
            // hair
            var style = app.hairStyle || 'short', hat = app.headwear || null;
            if (style !== 'bald') {
                var hv = hairViews(app);
                if (hv) {
                    var cut = hat && G.HAIR_HAT_CUT ? G.HAIR_HAT_CUT[hat] : undefined;
                    var cutZ = cut !== undefined ? 4 - cut : 99;
                    viewHull(m, hv, [-22, 22, -21, 22, 12, 64], {
                        ymid: 1, mat: MAT.SOFT, maxR: 6,
                        skip: function (x, y, z) { return z > cutZ && (COVER_HATS[hat] || z > cutZ); }
                    });
                }
            } else {
                // bald: a lit patch on the crown
                paintTop(m, -6, 4, -4, 2, tone(skin, 1.12));
            }
            // headwear
            if (hat) {
                var wv = hatViews(app);
                if (wv) viewHull(m, wv, [-22, 22, -21, 22, 20, 64], { ymid: 1, maxR: 5, matOf: function (c) { return hat === 'crown' || hat === 'tiara' || hat === 'goggles' ? MAT.SHINY : MAT.SOLID; } });
            }
            // glasses: the classic frames one voxel proud of the face, arms back to the ears
            if (app.glasses && gf('_drawGlasses')) {
                var gc = safeHex(app.glassesColor, '#333333');
                var gl = capture(function (g) { G._drawGlasses(g, app.glasses, gc, 0, 'down'); });
                paintFront(m, gl, -HX, HX, 28, 40, true);
                for (var gs = -1; gs <= 1; gs += 2) m.box(gs < 0 ? -HX - 1 : HX, -2, 35, 1, 10, 1, gc);
            }
        }
        // Office life decorations on the head (party hat, headphones, courier cap)
        if (typeof a._lifeDecorate === 'function') {
            var df = decoCap(a, 'down'), db = decoCap(a, 'up'), ds = decoCap(a, 'right');
            if (df && df.any && ds) viewHull(m, { front: df, back: db || df, side: ds }, [-22, 22, -21, 22, 20, 64], {
                ymid: 1, maxR: 4, skip: function (x, y, z) { return z < 27; }
            });
        }
        return m;
    }
    function paintTop(m, x0, x1, y0, y1, c) {
        for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) {
            var z = m.oz + m.h - 1;
            while (z >= m.oz && !m.has(x, y, z)) z--;
            if (z >= m.oz) m.set(x, y, z, c, m.get(x, y, z) >>> 24);
        }
    }
    // the hair art of a look in the three views
    function hairViews(app) {
        var f = gf('_drawHairArt');
        if (!f) return null;
        var style = app.hairStyle || 'short', hc = safeHex(app.hairColor, '#333333'), hl = app.hairHighlight || null, skin = safeHex(app.skinTone, '#ffcc80');
        var savedPose = G._hairPose;
        G._hairPose = { sway: 0, hat: null, skin: skin };
        try {
            return {
                front: capture(function (g) { f(g, style, 'front', 1, hc, hl); }),
                back: capture(function (g) { f(g, style, 'back', 1, hc, hl); }),
                side: capture(function (g) { f(g, style, 'side', 1, hc, hl); })
            };
        } finally { G._hairPose = savedPose; }
    }
    function hatViews(app) {
        var f = gf('_drawHeadwear'), cr = gf('_headCrownY');
        if (!f) return null;
        var hat = app.headwear, c = safeHex(app.headwearColor, null) || '#888888';
        var crown = function (v) { try { return cr ? cr(app, v) : undefined; } catch (e) { return undefined; } };
        return {
            front: capture(function (g) { f(g, hat, c, false, 'down', crown('down')); }),
            back: capture(function (g) { f(g, hat, c, false, 'up', crown('up')); }),
            side: capture(function (g) { f(g, hat, c, false, 'right', crown('right')); })
        };
    }
    function costumeViews(cos) {
        var head = gf('_drawCostumeHead'), dfront = gf('_drawCostumeDirect'), dback = gf('_drawCostumeBack'), dside = gf('_drawCostumeSide');
        var view = function (kv, plain) {
            return capture(function (g) { if (!(head && head(g, cos, kv)) && plain) plain(g, cos); });
        };
        var v = { front: view('front', dfront), back: view('back', dback), side: view('side', dside) };
        return v.front && v.front.any && v.side && v.side.any ? v : null;
    }

    // ---------- the torso ----------
    // x [-10, 10) (female: shoulders [-9, 9), waist [-8, 8)), y [-6, 6), z [12, 27);
    // painted from the classic top art.
    function buildTorso(a, app) {
        var m = S.model(-14, -10, 14, 10, 30, 8);
        var isF = fem(a), tc = topColors(app, a.color), cos = costumeOf(app);
        var labcoat = !cos && app.shirtStyle === 'labcoat';
        m.box(-10, -6, 12, 20, 12, 15, function (x, y, z) {
            var hw = isF ? (z >= 21 ? 9 : 8) : 10;
            if (x < -hw || x >= hw) return null;
            // rounded shoulders and a softer top edge
            if (z === 26 && (x === -hw || x === hw - 1 || y === -6 || y === 5)) return null;
            if (z === 25 && (x === -hw || x === hw - 1) && (y === -6 || y === 5)) return null;
            if (z <= 13 && (y === -6 || y === 5) && (x === -hw || x === hw - 1)) return null;
            return tc.torso;
        }, MAT.SOFT);
        // a lab coat hangs to the knees
        if (labcoat) m.box(-10, -6, 8, 20, 12, 5, function (x, y) { return (x === -1 || x === 0) && y === 5 ? '#cfd8dc' : '#eceff1'; }, MAT.SOFT);
        var tdet = gf('_drawTopDetails');
        var fill = function (g) {
            g.fillStyle = tc.torso;
            if (isF) { g.fillRect(-9, -22, 18, 6); g.fillRect(-8, -16, 16, 9); } else g.fillRect(-10, -22, 20, 15);
            if (labcoat) g.fillRect(-10, -8, 20, 4);
        };
        var front = capture(function (g) {
            fill(g);
            if (tdet) withCtx(g, function () { tdet(app, tc, 'down', isF, null); });
            if (!app.costume) {
                var bc = gf('_badgeAccent') ? G._badgeAccent(a.emoji) : '#42a5f5';
                g.fillStyle = '#eceff1'; g.fillRect(3, -17, 5, 5);
                g.fillStyle = bc; g.fillRect(3, -17, 5, 2);
                g.fillStyle = '#90a4ae'; g.fillRect(4, -14, 3, 1);
            }
            if (a._lifeIntern && typeof a._lifeDecorate === 'function') { try { a._lifeDecorate(g, a, false); } catch (e) { /* none */ } }
        });
        var back = capture(function (g) { fill(g); if (tdet) withCtx(g, function () { tdet(app, tc, 'up', isF, null); }); });
        var tside = gf('_drawTorsoSide');
        var side = capture(function (g) {
            withCtx(g, function () {
                if (tside) tside(tc, 1, isF); else { g.fillStyle = tc.torso; g.fillRect(-8, -22, 17, 15); }
                if (tdet) tdet(app, tc, 'right', isF, null);
            });
        });
        // side art spans sx -8..9 over the 12 px depth
        var mapY = function (y) { return Math.round((y + 0.5) * 1.4 - 0.5); };
        paintSides(m, side, -6, 6, 8, 27, mapY);
        paintBack(m, back, -10, 10, 8, 27);
        paintFront(m, front, -10, 10, 8, 27);
        // the top of the shoulders reads the top row of the art
        for (var y = -6; y < 6; y++) for (var x = -10; x < 10; x++) {
            var z = 26; while (z > 20 && !m.has(x, y, z)) z--;
            if (z <= 20) continue;
            var c = y >= 0 ? front && front.at(x, -21) : back && back.at(-x - 1, -21);
            if (c) m.set(x, y, z, c, MAT.SOFT);
        }
        return m;
    }

    // ---------- legs ----------
    // standing: hips x [-9, 9) z [9, 15), legs 7 wide (female 6) z [2, 10), shoes
    // z [0, 3) with the toes 2 px forward; walking: legs swing from the hips;
    // seated (sz = seat height): thighs forward on the seat, shins down.
    function legColors(a, app) {
        var tc = topColors(app, a.color);
        var pants = tc.pants || safeHex(app.pantsColor, '#1a1a2e'), shoes = tc.shoes || safeHex(app.shoeColor, '#3b3b46');
        return { pants: pants, shoes: shoes };
    }
    function buildLegs(lc, isF, pose, k, sz) {
        var m = S.model(-12, -10, 12, 26, 24, 0);
        var P = lc.pants, Pd = tone(P, 0.86), Sh = lc.shoes, Sl = tone(Sh, 1.25), Sd = tone(Sh, 0.8);
        var lw = isF ? 6 : 7, hw = isF ? 8 : 9;
        var legX = [1, -1 - lw];     // left (+x), right (-x)
        function shoe(x, y, z) {
            m.rbox(x - 1, y - 3, z, lw + 2, 9, 3, 1, Sh);
            m.paint(x - 1, y + 4, z + 1, lw + 2, 2, 2, Sl);          // toe cap
            m.paint(x - 1, y - 3, z, lw + 2, 9, 1, Sd);             // sole
        }
        if (pose === 'sit' || pose === 'sitDeep') {
            var t0 = sz, deep = pose === 'sitDeep' ? 5 : 0;   // seat top; a couch's deep cushion: longer thighs
            m.rbox(-hw, -5, t0, 2 * hw, 8, 5, 1, P, MAT.SOFT);                  // hips on the seat
            for (var s = 0; s < 2; s++) {
                var x = legX[s];
                m.rbox(x, -3, t0, lw, 15 + deep, 5, 1, function (xx, yy, zz) { return zz === t0 + 4 ? tone(P, 1.06) : P; }, MAT.SOFT);  // thigh
                m.box(x, 7 + deep, 3, lw, 5, t0 - 2, function (xx, yy) { return yy === 7 + deep ? Pd : P; }, MAT.SOFT);                // shin
                shoe(x, 10 + deep, 0);
            }
            return m;
        }
        if (pose === 'lie') {
            // stretched out (a nap on the couch end): legs forward along the seat
            m.rbox(-hw, -5, sz, 2 * hw, 8, 5, 1, P, MAT.SOFT);
            for (var q = 0; q < 2; q++) { m.rbox(legX[q], -3, sz, lw, 22, 5, 1, P, MAT.SOFT); m.rbox(legX[q] - 1, 18, sz, lw + 2, 3, 7, 1, Sh); }
            return m;
        }
        // standing / walking: stride per leg (+ = forward), the back foot lifted
        var strides = [0, 0];
        if (pose === 'walk') { var st = [0, 4, 0, -4][k & 3]; strides = [st, -st]; }
        var lift = pose === 'walk' ? [(k & 3) === 2 ? 1 : 0, (k & 3) === 0 ? 1 : 0] : [0, 0];
        m.rbox(-hw, -4, 9, 2 * hw, 8, 6, 1, function (xx, yy, zz) { return (xx === -1 || xx === 0) && yy === 3 && zz < 12 ? Pd : P; }, MAT.SOFT);
        for (var i = 0; i < 2; i++) {
            var lx = legX[i], sd = strides[i], up = lift[i] + (sd < 0 ? 1 : 0);
            for (var z = 2 + up; z < 11; z++) {
                var off = Math.round(sd * (11 - z) / 9);
                m.box(lx, -3 + off, z, lw, 7, 1, function (xx, yy) { return yy === -3 + off ? Pd : (xx === lx + lw - 1 && i === 0) || (xx === lx && i === 1) ? Pd : P; }, MAT.SOFT);
            }
            shoe(lx, Math.round(sd * 9 / 9) + 1, up);
        }
        return m;
    }

    // ---------- arms ----------
    // Shoulders at (+-sx, 0, 24); a pose gives the elbow and the hand of the left
    // arm (body +x, the classic front view's image right) and of the right arm as
    // offsets from the shoulder (x outward, y forward, z up). A prop rides in a hand.
    var ARM = {
        hang:      { L: [[0, 0, -6], [0, 0, -11]] },
        swing:     null,     // built per frame
        lap:       { L: [[0, 2, -7], [-3, 9, -9]] },
        type:      { L: [[0, 3, -7], [-4, 12, -6]], R: [[0, 3, -7], [-3, 13, -6]] },
        typeHigh:  { L: [[0, 4, -3], [-4, 12, 7]], R: [[0, 4, -3], [-3, 13, 7]] },
        wave:      { L: [[3, 1, 4], [4, 2, 12]] },
        waveBig:   { L: [[3, 1, 6], [5, 2, 16]] },
        stretch:   { L: [[1, 0, 9], [-6, 0, 21]] },
        stretch1:  { L: [[4, 0, -2], [3, 2, 6]] },
        stretch2:  { L: [[2, 0, 6], [2, 0, 14]] },
        drink:     { L: [[0, 5, -7], [-8, 9, 4]] },
        drinkLow:  { L: [[0, 4, -7], [-3, 10, -5]] },
        phone:     { L: [[0, 4, -6], [-7, 9, -1]], R: [[0, 4, -6], [-7, 9, -2]] },
        book:      { L: [[0, 4, -6], [-6, 9, -2]] },
        behind:    { L: [[0, -2, -6], [-8, -7, -9]] },
        headBehind:{ L: [[3, -2, 7], [-4, -6, 11]] },
        remote:    { L: [[0, 4, -6], [-1, 12, -3]] },
        reach:     { L: [[1, 5, -3], [0, 13, -2]] },
        talk:      { L: [[0, 3, -6], [0, 10, -3]] },
        talk2:     { L: [[0, 3, -6], [1, 10, 0]] },
        pet:       { L: [[0, 5, -8], [-2, 11, -16]] },
        chase:     { L: [[0, 5, -3], [0, 13, -2]], R: [[0, 5, -4], [0, 12, -4]] },
        dartAim:   { L: [[2, 0, 3], [0, 2, 9]] },
        dartThrow: { L: [[0, 6, 2], [0, 14, 4]] },
        pong:      { L: [[3, 4, -4], [6, 9, -3]] },
        pong2:     { L: [[3, 5, -2], [3, 12, 0]] },
        carry:     { L: [[0, 3, -7], [-2, 9, -7]] },
        hold:      { L: [[0, 3, -7], [-5, 9, -6]] },
        sleepFold: { L: [[0, 1, -7], [-9, 7, -10]], R: [[0, 1, -8], [-9, 6, -9]] },
        cheer:     { L: [[2, 0, 6], [4, 0, 14]] },
        fist:      { L: [[2, 1, 5], [2, 2, 13]] },
        highfive:  { L: [[2, 4, 4], [2, 8, 12]] },
        give:      { L: [[0, 5, -5], [-2, 13, -4]] },
        scratch:   { L: [[3, 2, 3], [-4, 1, 13]] },
        sign:      { L: [[1, 4, 2], [-4, 8, 10]] },
        chin:      { L: [[0, 5, -6], [-8, 8, 2]] },
        armrest:   { L: [[1, -1, -6], [1, 4, -7]] },
        pen:       { L: [[0, 3, -7], [-4, 11, -6]] }
    };
    // the arm on each side for a pose name: 'name' (both), 'name/other' (left/right)
    function armPose(name, frame) {
        var parts = String(name).split('/'), l = parts[0], r = parts[1] || null;
        var pl = ARM[l] || ARM.hang, pr = r ? (ARM[r] || ARM.hang) : pl;
        var L = pl.L, R = r ? pr.L : (pl.R || pl.L);
        if (l === 'swing') { var a = [0, 3, 0, -3][frame & 3]; L = [[0, a * 0.5, -6], [0, a, -11]]; R = [[0, -a * 0.5, -6], [0, -a, -11]]; }
        if (r === 'swing') { var b = [0, 3, 0, -3][frame & 3]; R = [[0, -b * 0.5, -6], [0, -b, -11]]; }
        if ((l === 'wave' || l === 'waveBig') && frame) L = [L[0], [L[1][0] + frame, L[1][1], L[1][2]]];
        return { L: L, R: R };
    }
    function buildArms(ac, isF, pose, frame, props) {
        var m = S.model(-22, -15, 22, 22, 52, 2);
        var sx = isF ? 10 : 12, rr = isF ? 1.5 : 2, hs = isF ? 3 : 4;
        var P = armPose(pose, frame), sides = [[1, P.L], [-1, P.R]];
        var taps = (pose === 'type' || pose === 'typeHigh') ? [frame === 1 ? 1 : 0, frame === 2 ? 1 : 0] : [0, 0];
        var hands = [];
        for (var i = 0; i < 2; i++) {
            var sg = sides[i][0], J = sides[i][1];
            var sh = [sg * sx, 0, 24];
            var el = [sg * (sx + J[0][0]), J[0][1], 24 + J[0][2]];
            var hd = [sg * (sx + J[1][0]), J[1][1], 24 + J[1][2] + taps[i]];
            m.line(sh, el, rr, ac.sleeve, MAT.SOFT);
            // forearm stops short of the hand
            var dx = hd[0] - el[0], dy = hd[1] - el[1], dz = hd[2] - el[2], L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            var stop = Math.max(0, L - 1.5) / L;
            m.line(el, [el[0] + dx * stop, el[1] + dy * stop, el[2] + dz * stop], rr, ac.fore, MAT.SOFT);
            // cuff
            m.line([el[0] + dx * stop * 0.86, el[1] + dy * stop * 0.86, el[2] + dz * stop * 0.86], [el[0] + dx * stop, el[1] + dy * stop, el[2] + dz * stop], rr, tone(ac.fore, 0.86), MAT.SOFT);
            var hx = Math.round(hd[0] - hs / 2), hy = Math.round(hd[1] - hs / 2), hz = Math.round(hd[2] - 1.5);
            m.rbox(hx, hy, hz, hs, hs, 3, 1, ac.hand);
            hands.push({ x: hd[0], y: hd[1], z: hd[2], side: sg });
        }
        // the shoulder caps round over the arm tops
        m.rbox(sx - 2, -2, 22, isF ? 3 : 4, 4, 4, 1, ac.sleeve, MAT.SOFT);
        m.rbox(-sx - (isF ? 1 : 2), -2, 22, isF ? 3 : 4, 4, 4, 1, ac.sleeve, MAT.SOFT);
        // a darker seam where an arm meets the torso (same fabric, one outline round the figure)
        var inL = isF ? 9 : 10, inR = -inL - 1, seam = C.pack(C.rgb(tone(ac.sleeve, 0.78)), MAT.SOFT), sl = C.pack(C.rgb(ac.sleeve), MAT.SOFT), fo = C.pack(C.rgb(ac.fore), MAT.SOFT);
        m.each(function (x, y, z, v) { return (x === inL || x === inR) && z >= 12 && z <= 25 && Math.abs(y) <= 3 && (v === sl || v === fo) ? seam : null; });
        if (props) props.forEach(function (p) { if (p) putProp(m, p, hands); });
        return m;
    }

    // ---------- props ----------
    // p: { name, hand: 0 (left) | 1 (right) | 'both' }
    function putProp(m, p, hands) {
        var h = p.hand === 'both' ? { x: (hands[0].x + hands[1].x) / 2, y: (hands[0].y + hands[1].y) / 2, z: (hands[0].z + hands[1].z) / 2, side: 1 } : hands[p.hand || 0];
        var x = Math.round(h.x), y = Math.round(h.y), z = Math.round(h.z), s = h.side;
        switch (p.name) {
            case 'coffee': case 'mug':
                m.cyl(x + 0.5, y + 2.5, z - 2, 2.5, 2.5, 6, '#f5f5f5');
                m.cyl(x + 0.5, y + 2.5, z + 3, 1.6, 1.6, 1, '#6d4c41');
                m.box(s > 0 ? x + 3 : x - 3, y + 2, z, 2, 2, 3, '#e0e0e0'); m.carve(s > 0 ? x + 3 : x - 3, y + 2, z + 1, 1, 2, 1);
                break;
            case 'water':
                m.cyl(x + 0.5, y + 2.5, z - 2, 2.2, 2.2, 6, '#d8eefc');
                m.cyl(x + 0.5, y + 2.5, z - 2, 1.6, 1.6, 4, '#64b5f6');
                break;
            case 'snack': m.box(x - 2, y + 1, z - 2, 4, 3, 6, '#ffb300'); m.paint(x - 2, y + 3, z, 4, 1, 2, '#e53935'); break;
            case 'food': case 'sandwich': case 'pizza': case 'popcorn':
                m.box(x - 3, y + 1, z - 1, 6, 4, 3, '#e8c27a'); m.paint(x - 3, y + 1, z, 6, 4, 1, '#7cb342'); break;
            case 'phone':
                m.box(x - 1, y + 1, z - 1, 3, 2, 6, '#263238');
                m.box(x - 1, y + 1, z, 3, 1, 4, '#4fc3f7', MAT.EMIT);
                break;
            case 'book':
                m.box(x - 5, y + 1, z - 2, 10, 2, 7, '#1565c0');
                m.box(x - 4, y, z - 1, 8, 1, 5, '#f5f1e6');
                m.box(x - 1, y, z - 1, 2, 1, 5, '#d7cfbd');
                break;
            case 'remote': m.box(x - 1, y + 1, z - 1, 2, 5, 2, '#263238'); m.box(x - 1, y + 5, z, 2, 1, 1, '#ef5350', MAT.EMIT); break;
            case 'dart': m.box(x - 1, y - 1, z + 1, 2, 2, 6, '#eceff1', MAT.SHINY); m.box(x - 1, y - 1, z + 6, 2, 2, 2, '#e53935'); break;
            case 'paddleR': case 'paddleB':
                m.box(x - 1, y, z - 4, 2, 2, 4, '#8d6e63');
                m.cyl(x, y + 1, z - 10, 3.5, 1, 7, p.name === 'paddleR' ? '#f44336' : '#2196f3');
                break;
            case 'clipboard':
                m.box(x - 3, y + 1, z - 2, 7, 1, 9, '#795548');
                m.box(x - 2, y + 2, z - 1, 5, 1, 6, '#fafafa');
                m.box(x - 1, y + 2, z + 5, 3, 1, 2, '#9e9e9e', MAT.SHINY);
                break;
            case 'tablet':
                m.box(x - 3, y + 1, z - 2, 7, 1, 10, '#263238');
                m.box(x - 2, y + 2, z - 1, 5, 1, 8, '#4fc3f7', MAT.EMIT);
                break;
            case 'wrench':
                m.box(x - 1, y, z - 1, 2, 2, 10, '#a7b4bb', MAT.SHINY);
                m.box(x - 3, y, z + 8, 6, 2, 3, '#a7b4bb', MAT.SHINY); m.carve(x - 1, y, z + 9, 2, 2, 2);
                break;
            case 'hammer':
                m.box(x - 1, y, z - 1, 2, 2, 10, '#a1887f');
                m.box(x - 4, y - 1, z + 8, 9, 4, 3, '#78909c', MAT.SHINY);
                break;
            case 'pen': m.box(x - 1, y, z - 1, 2, 2, 7, '#1e66c8'); m.box(x - 1, y, z - 2, 2, 2, 1, '#263238'); break;
            case 'testTube':
                m.box(x - 1, y, z - 2, 3, 3, 9, '#e1f5fe');
                m.box(x - 1, y, z - 2, 3, 3, 5, '#5ccf6a', MAT.EMIT);
                break;
            case 'sign':
                m.box(x - 1, y + 1, z, 2, 2, 8, '#8d6e63');
                m.box(x - 9, y + 1, z + 7, 18, 2, 11, '#fafafa');
                m.paint(x - 9, y + 2, z + 7, 18, 1, 11, function (xx, yy, zz) { return zz === z + 7 || zz === z + 17 || xx === x - 9 || xx === x + 8 ? '#ffb300' : (zz === z + 12 && xx > x - 7 && xx < x + 6) ? '#455a64' : '#fafafa'; });
                break;
            case 'folder': m.box(x - 4, y + 1, z - 2, 8, 2, 7, '#f6c453'); m.paint(x - 4, y + 2, z + 4, 4, 1, 1, '#e0a92e'); break;
            case 'envelope': m.box(x - 4, y + 1, z - 1, 8, 1, 6, '#fafafa'); m.paint(x - 4, y + 1, z + 2, 8, 1, 1, '#cfd8dc'); break;
            case 'box': case 'package': m.box(x - 4, y + 1, z - 2, 8, 6, 6, '#c8a165'); m.paint(x - 4, y + 1, z + 3, 8, 6, 1, '#b08850'); break;
            case 'cakeSlice': case 'cake':
                m.box(x - 3, y + 1, z - 2, 6, 5, 1, '#eceff1');
                m.box(x - 2, y + 2, z - 1, 4, 3, 3, '#f8bbd0'); m.paint(x - 2, y + 2, z, 4, 3, 1, '#fff3e0'); m.box(x - 1, y + 3, z + 2, 2, 1, 1, '#e53935');
                break;
            case 'donut': m.cyl(x, y + 3, z - 1, 3, 3, 2, '#d7a86e'); m.cyl(x, y + 3, z, 3, 3, 1, '#f48fb1'); m.carve(x - 1, y + 2, z - 1, 2, 2, 2); break;
            case 'donutBox': m.box(x - 5, y + 1, z - 2, 10, 7, 3, '#f8bbd0'); m.paint(x - 5, y + 1, z, 10, 7, 1, '#fce4ec'); break;
            case 'newspaper': m.box(x - 4, y + 1, z - 2, 8, 1, 7, '#eeeeee'); m.paint(x - 3, y + 1, z + 3, 6, 1, 1, '#424242'); m.paint(x - 3, y + 1, z, 6, 1, 2, '#9e9e9e'); break;
            case 'placard': putProp(m, { name: 'sign', hand: 0 }, [h, h]); break;
            case 'balloon': m.line([x, y + 1, z], [x, y + 2, z + 14], 1, '#eceff1'); m.ellipsoid(x, y + 2, z + 18, 3.5, 3.5, 4.5, '#e53935', MAT.SHINY); break;
            case 'flag': m.box(x - 1, y, z - 2, 2, 2, 14, '#8d6e63'); m.box(x + 1, y, z + 6, 8, 2, 6, '#43a047'); break;
            case 'trophy':
                m.box(x - 2, y + 1, z - 2, 4, 3, 2, '#5d4037');
                m.cyl(x, y + 2.5, z, 2.6, 2.6, 5, '#ffd54f', MAT.SHINY);
                break;
            default:
                if (p.name) { m.rbox(x - 3, y + 1, z - 2, 6, 4, 6, 1, p.color || '#90a4ae'); }
        }
    }

    CH._capture = capture; CH._withCtx = withCtx;
    S.charsKit = { capture: capture, viewHull: viewHull, buildHead: buildHead, buildTorso: buildTorso, buildLegs: buildLegs, buildArms: buildArms };
    CH._parts = { buildHead: buildHead, buildTorso: buildTorso, buildLegs: buildLegs, buildArms: buildArms, legColors: legColors, topColors: topColors,
        lookOf: lookOf, headSig: headSig, torsoSig: torsoSig, decoSig: decoSig, safeHex: safeHex, fem: fem, costumeOf: costumeOf, ARM: ARM };
    CH._util = { wrapA: wrapA, easeA: easeA, faceTurn: faceTurn, VIEW_TURN: VIEW_TURN, VIEW_VEC: VIEW_VEC, rot2: rot2, hash: hash, gf: gf, G: function () { return G; } };
})();

// ======================================================================
// Pets: small stacked animals, every species of PET_SPECIES, in the poses the
// classic plays (stand / walk cycle / sit / sleep / groom / look / petted /
// eating / the species trick). Local space: facing +y, origin = the body's
// middle on the floor.
// ======================================================================
(function () {
    'use strict';
    var S = window.VOStack, CH = S.chars, U = CH._util, C = S.color, MAT = S.MAT, tone = C.tone;
    var DEF_PAL = {
        cat: { H: '#615774', B: '#473d55', S: '#352c42', D: '#272031', W: '#b9b2c8', w: '#908aa0', Y: '#f4c64a', K: '#140e19', P: '#e0909f', p: '#94607e' },
        pug: { H: '#f2d9a6', B: '#ddb87c', S: '#c19b60', D: '#9d7b4a', W: '#f7e8c8', w: '#e6cfa0', M: '#3d322c', m: '#5d4c42', K: '#140d0b', G: '#ffffff', N: '#1d1513', P: '#e8788a' },
        lobster: { H: '#ff8e6c', B: '#e4482e', S: '#b5301f', D: '#8a2316', W: '#ffc3a6', w: '#f59474', A: '#c63c27', E: '#a92c1b', K: '#1a0e0f', G: '#ffffff' },
        corgi: { H: '#f6b872', B: '#e08a3c', S: '#b8642a', D: '#8a4a22', W: '#fbf3e6', w: '#e0d2bf', K: '#1a1210', G: '#ffffff', N: '#2a1a14', P: '#e8788a', p: '#a8505e' },
        bunny: { H: '#d2ac83', B: '#a87d55', S: '#82603f', D: '#5f452d', W: '#f6eee2', w: '#d8c8b2', K: '#1a1210', G: '#ffffff', P: '#ec8a9c', p: '#e2a2ac' },
        fox: { H: '#ffa45e', B: '#e8702a', S: '#b9501c', D: '#8a3a16', W: '#fff4e6', w: '#e2cfbb', M: '#3c2822', K: '#1a0e0a', G: '#ffffff', N: '#1a0e0a', P: '#e8788a' },
        duck: { H: '#fff27a', B: '#f6d23a', S: '#d6a51e', D: '#a87a14', W: '#fff8d0', w: '#ead07a', O: '#f08a24', o: '#c0661a', K: '#1a1210', G: '#ffffff' },
        turtle: { H: '#9ad470', B: '#5aa83c', S: '#3e7d2a', D: '#2b5a1e', W: '#d6cf7c', w: '#a9a25a', C: '#e2cf86', K: '#141a10', G: '#ffffff' }
    };
    function palOf(sp) {
        var g = U.G(), p = g.PET_PALETTES && g.PET_PALETTES[sp];
        return Object.assign({}, DEF_PAL[sp] || DEF_PAL.cat, p || {});
    }
    // A capsule-ish body along y: rows y0..y1, width w, height h, bottom z per row (zb(y)).
    function body(m, y0, y1, w, h, zb, col) {
        var hw = w / 2;
        for (var y = y0; y < y1; y++) {
            var t = (y + 0.5 - y0) / (y1 - y0), end = Math.min(t, 1 - t), shrink = end < 0.12 ? 1 : 0;
            var z0 = Math.round(zb(y)), hh = h - shrink, ww = hw - shrink;
            for (var z = z0; z < z0 + hh; z++) for (var x = -Math.ceil(ww); x < Math.ceil(ww); x++) {
                var u = (x + 0.5) / ww, v = (z + 0.5 - z0 - hh / 2) / (hh / 2);
                if (u * u + v * v * 0.7 > 1.15) continue;
                m.set(x, y, z, col(x, y, z, z - z0, hh), MAT.SOFT);
            }
        }
    }
    function shadeCol(P, belly) {
        return function (x, y, z, k, hh) {
            if (k >= hh - 1) return P.H;
            if (k === 0) return belly ? P.W : P.S;
            if (belly && k === 1 && Math.abs(x + 0.5) < 2.5) return P.w || P.W;
            return P.B;
        };
    }
    function eyes(m, P, cx, y, z, gap, state, col) {
        // state: open | closed | happy; two 2x2 eyes on the face plane y
        for (var s = -1; s <= 1; s += 2) {
            var x = s < 0 ? cx - gap - 2 : cx + gap;
            if (state === 'closed') m.box(x, y, z, 2, 1, 1, P.K);
            else if (state === 'happy') { m.box(x, y, z + 1, 2, 1, 1, P.K); m.set(s < 0 ? x : x + 1, y, z, P.K); }
            else {
                m.box(x, y, z, 2, 1, 2, col || P.K);
                if (col) m.set(s < 0 ? x + 1 : x, y, z, P.K), m.set(s < 0 ? x + 1 : x, y, z + 1, P.K);
                m.set(s < 0 ? x : x + 1, y, z + 1, P.G || '#ffffff');
            }
        }
    }
    // ---------- four legged: cat, pug, corgi, fox, bunny ----------
    var QUAD = {
        cat:   { L: 20, W: 10, H: 8, leg: 6, lw: 3, hw: 12, hd: 9, hh: 10, ear: 'point', tail: 'long', eyeCol: 'Y', muzzle: 'W', nose: 'P' },
        pug:   { L: 18, W: 12, H: 9, leg: 5, lw: 4, hw: 14, hd: 10, hh: 11, ear: 'fold', tail: 'curl', mask: 'M', nose: 'N' },
        corgi: { L: 24, W: 12, H: 8, leg: 4, lw: 4, hw: 12, hd: 9, hh: 10, ear: 'big', tail: 'stub', blaze: true, nose: 'N', paws: 'W', belly: true },
        fox:   { L: 22, W: 10, H: 8, leg: 6, lw: 3, hw: 10, hd: 8, hh: 9, ear: 'tall', tail: 'bushy', muzzle: 'W', nose: 'N', snout: 3, paws: 'M' },
        bunny: { L: 16, W: 12, H: 11, leg: 2, lw: 4, hw: 10, hd: 9, hh: 9, ear: 'long', tail: 'puff', nose: 'P', belly: true }
    };
    function quad(m, sp, P, pose, f) {
        var Q = QUAD[sp], L = Q.L, Wd = Q.W, H = Q.H, leg = Q.leg, lw = Q.lw;
        var y0 = -Math.floor(L / 2), y1 = y0 + L;
        var sitting = pose === 'sit' || pose === 'pet' || pose === 'groom' || pose === 'eatSit';
        var lying = pose === 'sleep' || pose === 'sploot' || pose === 'roll';
        var crouch = pose === 'crouch', leap = pose === 'leap';
        var eyeState = pose === 'sleep' || f.blink ? 'closed' : pose === 'pet' || pose === 'roll' ? 'happy' : 'open';
        // body
        var zb;
        if (sitting) zb = function (y) { return Math.max(0, leg - 1 - Math.round((y1 - y) * 0.45)) + (y > 0 ? 1 : 0); };
        else if (lying) zb = function () { return 0; };
        else if (crouch) zb = function (y) { return Math.max(1, leg - 3 + Math.round((y0 - y) * -0.15)); };
        else if (leap) zb = function (y) { return leg + Math.round(y * 0.12); };
        else zb = function () { return leg + (f.bob || 0); };
        if (pose === 'roll') {
            // on its back: belly up, paws in the air
            body(m, y0 + 1, y1, Wd + 1, H - 1, function () { return 0; }, function (x, y, z, k, hh) { return k >= hh - 2 ? P.W : k === 0 ? P.S : P.B; });
            for (var r = 0; r < 4; r++) m.box(r < 2 ? -Wd / 2 + 1 : Wd / 2 - 3, r % 2 ? y1 - 5 : y0 + 3, H - 1, 2, 2, 3, Q.paws ? P[Q.paws] : P.B);
        } else {
            var bl = sitting ? Math.round(L * 0.75) : lying ? L - 2 : L;
            var by0 = sitting ? y1 - bl : y0 + (lying ? 1 : 0);
            body(m, by0, y1, Wd, sitting ? H + 2 : lying ? H - 1 : H, zb, shadeCol(P, !!Q.belly));
            if (Q.blaze) m.paint(-2, y1 - 2, 0, 4, 3, 30, P.W);                     // white chest
        }
        // legs
        var paw = Q.paws ? P[Q.paws] : P.S;
        var xL = -Math.floor(Wd / 2) + 1, xR = Math.ceil(Wd / 2) - 1 - lw, legsAt = function (x0, yL, zt, dy) {
            m.box(x0, yL + (dy || 0), 0, lw, lw, zt, function (x, y, z) { return z < 1 ? paw : z < 2 && Q.paws ? paw : P.B; });
        };
        var st = f.stride || 0, hl = Math.floor(Wd / 2);
        if (!lying && !leap && pose !== 'roll') {
            if (sitting) {
                legsAt(xL, y1 - lw - 1, leg + 3, 0); legsAt(xR, y1 - lw - 1, leg + 3, 0);
                // haunches on the floor
                m.rbox(-hl - 1, y0 + 2, 0, 4, 7, 5, 1, P.B, MAT.SOFT); m.rbox(hl - 3, y0 + 2, 0, 4, 7, 5, 1, P.B, MAT.SOFT);
                m.box(-hl - 1, y0 + 7, 0, 3, 3, 1, paw); m.box(hl - 2, y0 + 7, 0, 3, 3, 1, paw);
            } else {
                var zt = crouch ? leg - 1 : leg + 1;
                legsAt(xL, y1 - lw - 1, zt, st); legsAt(xR, y1 - lw - 1, zt, -st);
                legsAt(xL, y0 + 1, zt, -st); legsAt(xR, y0 + 1, zt, st);
            }
        } else if (leap) {
            m.box(xL, y1 - 1, leg - 2, lw, 4, 2, paw); m.box(xR, y1 - 1, leg - 2, lw, 4, 2, paw);
            m.box(xL, y0 - 3, leg - 1, lw, 4, 2, paw); m.box(xR, y0 - 3, leg - 1, lw, 4, 2, paw);
        }
        if (pose === 'groom') m.box(xL, y1 - 1, leg + 4 + (f.paw ? 2 : 0), lw, lw, 3, paw);   // a paw up to the mouth
        // head
        var hw = Q.hw, hd = Q.hd, hh = Q.hh;
        var hy = y1 - 2, hz = sitting ? zb(y1 - 1) + H - 1 : lying ? 0 : crouch ? leg + 1 : leap ? leg + 2 : leg + H - 3 + (f.bob || 0);
        if (pose === 'eat') { hy = y1 + 1; hz = 1; }
        if (pose === 'roll') { hy = y1 - 1; hz = 0; }
        var hx = (f.look || 0) - hw / 2;
        if (sp === 'bunny' && !lying) hz += 1;
        m.rbox(hx, hy, hz, hw, hd, hh, 2, function (x, y, z) { return z >= hz + hh - 1 ? P.H : z === hz ? P.S : P.B; }, MAT.SOFT);
        var fy = hy + hd - 1, cx = hx + hw / 2;
        // muzzle / mask / snout
        if (Q.muzzle) m.rbox(cx - 3, fy, hz, 6, 2, 3, 1, P[Q.muzzle], MAT.SOFT);
        if (Q.mask) { m.rbox(cx - 3, fy, hz, 6, 2, 4, 1, P.M, MAT.SOFT); m.paint(cx - 4, fy, hz + 3, 8, 1, 2, P.m || P.M); }
        if (Q.snout) { m.rbox(cx - 2, fy + 1, hz, 4, Q.snout + 1, 3, 1, P.B, MAT.SOFT); m.paint(cx - 2, fy + 1, hz, 4, Q.snout + 1, 1, P.W); }
        if (Q.blaze) { m.rbox(cx - 2, fy, hz, 4, 2, 3, 1, P.W, MAT.SOFT); m.paint(cx - 1, fy, hz + 3, 2, 1, hh - 3, P.W); }
        var noseY = fy + (Q.snout ? Q.snout + 1 : Q.muzzle || Q.mask || Q.blaze ? 1 : 0);
        m.box(cx - 1, noseY, hz + 2, 2, 1, 1, P[Q.nose] || P.K);
        // eyes
        var ez = hz + Math.round(hh * 0.5);
        eyes(m, P, cx, fy, ez, Q.mask ? 1 : 1, eyeState, Q.eyeCol ? P[Q.eyeCol] : null);
        // ears
        var et = hz + hh;
        for (var s = -1; s <= 1; s += 2) {
            var ex = s < 0 ? hx : hx + hw - (Q.ear === 'long' ? 3 : 3);
            if (Q.ear === 'point' || Q.ear === 'tall') {
                var eh = Q.ear === 'tall' ? 4 : 3;
                for (var k = 0; k < eh; k++) m.box(ex + (s < 0 ? 0 : (k > 1 ? 1 : 0)), hy + 2, et + k, Math.max(2, 3 - (k > 1 ? 1 : 0)), 2, 1, k === eh - 1 && Q.ear === 'tall' ? P.M || P.D : P.B);
                m.box(ex + (s < 0 ? 1 : 0), hy + 3, et, 1, 1, 1, P.P || P.B);
            } else if (Q.ear === 'big') {
                m.box(ex, hy + 3, et, 3, 2, 3, P.B); m.box(ex + (s < 0 ? 1 : 0), hy + 4, et, 2, 1, 2, P.p || P.P);
                m.box(ex + (s < 0 ? 0 : 1), hy + 3, et + 3, 2, 2, 1, P.B);
            } else if (Q.ear === 'fold') {
                m.box(s < 0 ? hx - 1 : hx + hw - 2, hy + 2, et - 3, 3, 3, 3, P.M);
            } else if (Q.ear === 'long') {
                var lie = lying || pose === 'look';
                if (lie) m.box(ex, hy - 6, et - 1, 3, 7, 2, P.B);
                else { m.box(ex, hy + 2, et, 3, 2, 9, P.B); m.box(ex + (s < 0 ? 1 : 0), hy + 3, et + 1, 1, 1, 7, P.P); m.box(ex, hy + 2, et + 8, 3, 2, 1, P.H); }
            }
        }
        // tail
        var tz = sitting ? 1 : lying ? 1 : leg + H - 3, ty = y0;
        if (Q.tail === 'long') {
            if (sitting || lying) { m.box(-Wd / 2 - 2, y0, 0, 2, L - 4, 2, P.B); m.box(-Wd / 2 - 2, y1 - 5, 0, 2, 2, 2, P.H); }
            else { m.line([0, ty, tz + 1], [0, ty - 5, tz + 3], 1, P.B); m.line([0, ty - 5, tz + 3], [0, ty - 7, tz + 7 + (f.tail || 0)], 1, P.B); m.box(-1, ty - 7, tz + 7 + (f.tail || 0), 2, 2, 2, P.H); m.box(-1, ty - 6, tz + 9 + (f.tail || 0), 2, 2, 1, P.D); }
        } else if (Q.tail === 'bushy') {
            if (sitting || lying) { m.rbox(-Wd / 2 - 4, y0 - 1, 0, 4, L - 3, 4, 2, P.B, MAT.SOFT); m.paint(-Wd / 2 - 4, y1 - 6, 0, 4, 3, 4, P.W); }
            else { m.rbox(-2, ty - 9, tz - 3, 5, 10, 5, 2, P.B, MAT.SOFT); m.paint(-2, ty - 9, tz - 3, 5, 3, 5, P.W); }
        } else if (Q.tail === 'curl') {
            if (!lying) { m.box(-1, ty - 1, tz + 2, 3, 2, 3, P.H); m.box(-1, ty, tz + 4, 3, 3, 2, P.H); }
        } else if (Q.tail === 'stub') {
            if (!lying) m.rbox(-1, ty - 2, tz, 3, 3, 3, 1, P.H, MAT.SOFT);
        } else if (Q.tail === 'puff') {
            m.rbox(-2, ty - 2, sitting ? 2 : tz, 5, 4, 4, 2, P.W, MAT.SOFT);
        }
    }
    // ---------- lobster ----------
    function lobster(m, P, pose, f) {
        var sleep = pose === 'sleep', up = pose === 'snap', bob = f.bob || 0, open = !!f.open;
        // carapace + tail segments + fan
        m.rbox(-4, -2, 2, 8, 8, 5, 2, function (x, y, z) { return z >= 6 ? P.H : z <= 2 ? P.S : P.B; }, MAT.SHINY);
        var segs = [[7, 4], [6, 4], [5, 3], [4, 3]];
        for (var i = 0; i < segs.length; i++) {
            var w = segs[i][0], y = -4 - i * 2;
            m.rbox(-Math.ceil(w / 2), y, 2, w, 2, segs[i][1], 1, i % 2 ? P.S : P.B, MAT.SHINY);
            m.paint(-Math.ceil(w / 2), y, 2 + segs[i][1] - 1, w, 1, 1, P.H);
        }
        m.box(-4, -13, 1, 8, 2, 2, P.A || P.S); m.box(-3, -14, 1, 2, 1, 2, P.E || P.D); m.box(1, -14, 1, 2, 1, 2, P.E || P.D);
        // little legs
        for (var k = 0; k < 3; k++) for (var s = -1; s <= 1; s += 2) {
            var lx = s < 0 ? -6 : 4, ly = 3 - k * 2 + ((f.step || 0) === k ? 1 : 0);
            m.box(lx, ly, 0, 2, 2, 3, P.S);
        }
        // claws on arms
        for (s = -1; s <= 1; s += 2) {
            var ax = s * 5, cz = sleep ? 1 : up ? 9 + bob : 4 + bob, cy = up ? 7 : 10;
            m.line([s * 3, 5, 4], [ax + s, cy - 3, cz], 1, P.A || P.B, MAT.SHINY);
            var x0 = s < 0 ? ax - 4 : ax - 1;
            m.rbox(x0, cy - 2, cz - 1, 5, 4, 4, 1, P.B, MAT.SHINY);                    // the palm
            var gap = open && !sleep ? 1 : 0;
            m.rbox(x0, cy + 2, cz + 1 + gap, 5, 4, 2, 1, P.H, MAT.SHINY);             // upper pincer
            m.rbox(x0 + (s < 0 ? 0 : 1), cy + 2, cz - 1, 4, 3, 2, 1, P.S, MAT.SHINY);   // lower pincer
        }
        // eyes on stalks, antennae
        var ez = sleep ? 7 : 8;
        for (s = -1; s <= 1; s += 2) {
            m.box(s < 0 ? -3 : 1, 4, 6, 2, 2, ez - 6, P.S);
            if (sleep || f.blink) m.box(s < 0 ? -3 : 1, 5, ez, 2, 1, 1, P.K);
            else { m.box(s < 0 ? -3 : 1, 4, ez, 2, 2, 2, P.K); m.set(s < 0 ? -3 : 2, 5, ez + 1, P.G); }
            m.line([s * 1.5, 6, 6], [s * 4, 14, sleep ? 5 : 12], 1, P.D);
        }
    }
    // ---------- duck ----------
    function duck(m, P, pose, f) {
        var sit = pose === 'sit' || pose === 'sleep' || pose === 'pet', z0 = sit ? 0 : 4, sway = f.sway || 0;
        m.ellipsoid(sway, -1, z0 + 4.5, 5.5, 7.5, 4.5, function (x, y, z) { return z <= z0 + 1 ? P.W : z >= z0 + 7 ? P.H : P.B; }, MAT.SOFT);
        m.rbox(sway - 2, -9, z0 + 5, 4, 3, 4, 1, P.B, MAT.SOFT);                       // tail tip
        m.box(sway - 1, -10, z0 + 7, 2, 2, 2, P.H);
        // wings
        if (pose === 'flap') {
            var wz = f.open ? z0 + 9 : z0 + 6;
            m.rbox(sway - 13, -4, wz, 7, 7, 2, 1, P.S, MAT.SOFT); m.rbox(sway + 6, -4, wz, 7, 7, 2, 1, P.S, MAT.SOFT);
        } else { m.paint(sway - 6, -6, z0 + 3, 1, 9, 4, P.S); m.paint(sway + 5, -6, z0 + 3, 1, 9, 4, P.S); }
        // legs + webbed feet
        if (!sit) for (var s = -1; s <= 1; s += 2) {
            var fy = (f.stride || 0) * s;
            m.box(s < 0 ? -3 : 1, fy, 1, 2, 2, z0, P.O);
            m.box(s < 0 ? -4 : 0, fy, 0, 4, 4, 1, P.O);
        }
        // head
        var hy = pose === 'sleep' ? -2 : 5, hz = pose === 'sleep' ? z0 + 8 : z0 + 9;
        m.ellipsoid(sway, hy, hz + 4, 4, 4, 4, function (x, y, z) { return z >= hz + 6 ? P.H : P.B; }, MAT.SOFT);
        if (pose !== 'sleep') {
            m.rbox(sway - 2, hy + 3, hz + 2, 4, 4, 2, 1, P.O); m.box(sway - 2, hy + 4, hz + 2, 4, 3, 1, P.o);
            eyes(m, P, sway, hy + 3, hz + 4, 2, f.blink ? 'closed' : pose === 'pet' ? 'happy' : 'open');
        } else { m.rbox(sway - 2, hy - 4, hz + 2, 4, 3, 2, 1, P.O); }
    }
    // ---------- turtle ----------
    function turtle(m, P, pose, f) {
        var hide = pose === 'hide' || pose === 'sleep';
        // legs
        if (!hide || pose === 'sleep') for (var i = 0; i < 4; i++) {
            var lx = i % 2 ? 4 : -7, ly = i < 2 ? 3 : -6, st = ((f.step || 0) + i) % 2 ? 1 : 0;
            m.rbox(lx, ly + (pose === 'walk' ? st : 0), 0, 3, 3, 3, 1, P.B, MAT.SOFT);
        }
        // shell: plates, rim
        m.ellipsoid(0, -1, 3, 7.5, 8.5, 6.5, function (x, y, z) {
            if (z <= 3) return z === 3 ? P.C : P.w;
            var px = Math.floor((x + 20) / 4), py = Math.floor((y + 20 + (px % 2) * 2) / 4);
            var edge = (x + 20) % 4 === 0 || (y + 20 + (px % 2) * 2) % 4 === 0;
            return edge ? P.D : (px + py) % 2 ? P.S : tone(P.S, 1.12);
        });
        m.carve(-9, -11, 0, 18, 22, 2);
        m.box(-6, -8, 2, 12, 14, 1, P.W);
        // head + tail
        if (!hide) {
            var hz = pose === 'eat' ? 1 : 3 + (f.bob || 0);
            m.rbox(-2, 6, hz, 5, 7, 4, 2, function (x, y, z) { return z >= hz + 3 ? P.H : P.B; }, MAT.SOFT);
            eyes(m, P, 0.5, 12, hz + 2, 1, f.blink ? 'closed' : pose === 'pet' ? 'happy' : 'open');
            m.box(-1, -10, 2, 2, 2, 2, P.B);
        } else if (pose === 'sleep') {
            m.rbox(-2, 6, 1, 5, 4, 3, 1, P.B, MAT.SOFT);
            m.box(-2, 9, 2, 2, 1, 1, P.K); m.box(1, 9, 2, 2, 1, 1, P.K);
        }
    }
    // The model of a species in a pose. pose: stand | walk | sit | sleep | groom | look | pet | eat | trick
    function petModel(sp, pose, frame, blink) {
        var P = palOf(sp), m = S.model(-20, -28, 20, 28, 40, 0), f = { blink: blink };
        if (sp === 'lobster') {
            var lp = pose === 'sleep' ? 'sleep' : pose === 'trick' ? 'snap' : 'stand';
            if (pose === 'walk') { f.step = frame % 3; f.bob = frame % 2; }
            if (pose === 'trick') f.open = frame % 2 === 0;
            if (pose === 'groom') { lp = 'snap'; f.open = frame % 2 === 1; }
            lobster(m, P, lp, f);
        } else if (sp === 'duck') {
            var dp = pose;
            if (pose === 'walk') { f.sway = [0, 1, 0, -1][frame & 3]; f.stride = [0, 2, 0, -2][frame & 3]; dp = 'stand'; }
            if (pose === 'trick') { dp = 'flap'; f.open = frame % 2 === 0; }
            if (pose === 'groom' || pose === 'look' || pose === 'eat') dp = 'stand';
            duck(m, P, dp, f);
        } else if (sp === 'turtle') {
            var tp = pose === 'trick' ? 'hide' : pose === 'walk' ? 'walk' : pose === 'sleep' ? 'sleep' : pose === 'eat' ? 'eat' : pose === 'pet' ? 'pet' : 'stand';
            f.step = frame; f.bob = pose === 'walk' ? frame % 2 : 0;
            turtle(m, P, tp, f);
        } else {
            var Q = QUAD[sp] ? sp : 'cat', qp = pose;
            if (pose === 'walk') { f.stride = [0, 2, 0, -2][frame & 3]; f.bob = frame % 2 ? 0 : 0; f.tail = frame % 2; }
            if (pose === 'groom') f.paw = frame % 2;
            if (pose === 'look') { qp = 'stand'; f.look = frame % 2 ? -2 : 2; }
            if (pose === 'trick') {
                if (Q === 'pug') qp = 'roll';
                else if (Q === 'corgi') qp = 'sploot';
                else qp = frame ? 'leap' : 'crouch';
            }
            if (pose === 'eat') qp = 'eat';
            quad(m, Q, P, qp, f);
        }
        return m;
    }
    CH.petModel = petModel;
    CH.PET_SPECIES_FALLBACK = Object.keys(DEF_PAL);
})();

// ======================================================================
// The scene: agents, Office life extras and pets each frame, the chairs at
// every seat, and where each figure is drawn (S.personAt / S.personTop).
// ======================================================================
(function () {
    'use strict';
    var S = window.VOStack, CH = S.chars, P = CH._parts, U = CH._util, C = S.color, MAT = S.MAT, tone = C.tone;
    var G = U.G, PI = Math.PI;

    function mesh(key, build) { return S.mesh ? S.mesh(key, build, 'dynamic') : null; }
    function smesh(key, build) { return S.mesh ? S.mesh(key, build, 'static') : null; }
    // the turn that shows a flat sign (Zs, a heart) square to the camera
    function camTurn() { var c = S.cam ? S.cam() : null; return c ? -(c.yaw || 0) : 0; }

    // ---------- where things were drawn ----------
    var drawn = new Map();
    S.personAt = function (e) { var p = e ? drawn.get(e) : null; return p ? { x: p.x, y: p.y, z: p.z, turn: p.turn, top: p.top } : null; };
    S.personTop = function (e) { var p = e ? drawn.get(e) : null; return p && isFinite(p.top) ? p.top : 48; };

    // ---------- seats ----------
    // Desk seat: the chair's floor point (the classic's, kept clear of the desk
    // top's near edge so the sitter is never inside the desk), facing, chair type.
    var deskMemo = new WeakMap();
    function deskSeat(item) {
        var g = G(), rot = item.rotation || 0, mk = typeof g._mk === 'function' ? g._mk(item) : item.type;
        var nud = S.nudgeOf ? S.nudgeOf(item) : 0;   // a desk moved off the back wall: its seat moves too
        var sig = item.x + ',' + item.y + ',' + rot + ',' + mk + ',' + nud;
        var c = deskMemo.get(item);
        if (c && c.sig === sig) return c;
        c = null;
        try {
            var man = (g.FURNITURE_MANIFEST || {})[mk] || (g.FURNITURE_MANIFEST || {})[item.type] || {};
            var se = (man.seats || [])[0] || {}, s = typeof g._deskSeatSpot === 'function' ? g._deskSeatSpot(item) : null;
            if (s && s.floor) {
                var stand = !!se.stand, view = s.view || 'down', fv = U.VIEW_VEC[view];
                var x = item.x + s.floor[0], y = item.y + s.floor[1];
                var top = null;
                ((man.projection && man.projection.parts) || []).forEach(function (p) { if (p.name === 'top' && !top) top = p; });
                if (top && typeof g._projTurn === 'function') {
                    var r = g._projTurn(top.plan, rot), need = stand ? 8 : 9, d;
                    var ex0 = item.x + r[0], ey0 = item.y + r[1], ex1 = ex0 + r[2], ey1 = ey0 + r[3];
                    if (view === 'up') d = y - ey1; else if (view === 'down') d = ey0 - y; else if (view === 'left') d = x - ex1; else d = ex0 - x;
                    if (d < need) { x -= fv[0] * (need - d); y -= fv[1] * (need - d); }
                }
                var boss = item.type === 'bossDesk';
                c = { sig: sig, x: x, y: y + nud, view: view, turn: U.VIEW_TURN[view], stand: stand, chair: stand ? null : boss ? 'chair:boss' : 'chair:desk', sz: boss ? 15 : 14, item: item };
            }
        } catch (e) { c = null; }
        if (c) deskMemo.set(item, c);
        return c;
    }
    // Meeting chairs: one per seat of the table (the classic's seats, the chairs
    // tucked to the table's real plan), keyed by the stop point of the seat.
    var meetMemo = { key: '', chairs: [] };
    function meetingChairs() {
        var g = G();
        if (typeof g._meetingSeatsNow !== 'function') return [];
        var seats = g._meetingSeatsNow(), t = g._meetMemo && g._meetMemo.table;
        if (!t || !seats || !seats.length) { meetMemo.key = ''; meetMemo.chairs = []; return meetMemo.chairs; }
        var key = t.x + ',' + t.y + ',' + (t.rotation || 0) + ',' + seats.length;
        if (key === meetMemo.key) return meetMemo.chairs;
        var M = g.FURNITURE_MANIFEST.meetingTable, rot = t.rotation || 0;
        var pl = g._projTurn(M.projection.parts[0].plan, rot);
        var X0 = t.x + pl[0], Y0 = t.y + pl[1], Wp = pl[2], Dp = pl[3], wide = Wp >= Dp, out = [];
        seats.forEach(function (s, i) {
            if (!s.kind) return;
            var c = { key: 'm' + i, sx: s.x, sy: s.y, x: 0, y: 0, view: 'down' };
            if (s.kind === 'top') { c.x = s.hx; c.y = Y0 - 9; c.view = 'down'; }
            else if (s.kind === 'near') { c.x = s.hx; c.y = Y0 + Dp + 9; c.view = 'up'; }
            else {
                var cy = wide ? Y0 + Dp / 2 : Math.max(Y0 + 8, Math.min(Y0 + Dp - 8, s.hy + 14));
                if (s.kind === 'left') { c.x = X0 - 9; c.y = cy; c.view = 'right'; }
                else { c.x = X0 + Wp + 9; c.y = cy; c.view = 'left'; }
            }
            c.turn = U.VIEW_TURN[c.view];
            out.push(c);
        });
        meetMemo.key = key; meetMemo.chairs = out;
        return out;
    }
    function meetingChairAt(x, y) {
        var list = meetingChairs();
        for (var i = 0; i < list.length; i++) if (Math.abs(list[i].sx - x) <= 3 && Math.abs(list[i].sy - y) <= 3) return list[i];
        return null;
    }
    // The furniture a standing person uses (a stand spot within 3 px): face its middle.
    function spotTarget(a, st) {
        var key = Math.round(a.x) + ',' + Math.round(a.y);
        if (st.spotKey === key) return st.spotAt;
        st.spotKey = key; st.spotAt = null;
        var g = G(), list = (g.officeConfig && g.officeConfig.furniture) || [];
        if (typeof g._itemStandWorld !== 'function') return null;
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (it.type === 'wall' || it.type === 'door') continue;
            var sp;
            try { sp = g._itemStandWorld(it); } catch (e) { sp = []; }
            for (var k = 0; k < sp.length; k++) {
                if (Math.abs(sp[k].x - a.x) <= 3 && Math.abs(sp[k].y - a.y) <= 3) {
                    var cx = it.x, cy = it.y;
                    try { var fp = g._itemFootprints(it); if (fp && fp.length) { cx = fp[0].x + fp[0].w / 2; cy = fp[0].y + fp[0].h / 2; } } catch (e) { /* anchor */ }
                    if (Math.hypot(cx - a.x, cy - a.y) > 2) st.spotAt = { x: cx, y: cy };
                    return st.spotAt;
                }
            }
        }
        return null;
    }
    function findAgent(id) {
        var g = G(), list = (g.agents || []).concat(g._lifeExtras || []);
        for (var i = 0; i < list.length; i++) if (list[i] && (list[i].id === id || list[i].statusKey === id)) return list[i];
        return null;
    }

    // ---------- the pose of a person this frame ----------
    var LIFE_ARMS = { sign: 'hang/sign', give: 'give', take: 'give', highfive: 'highfive', cheer: 'cheer', fistpump: 'fist/hang', headscratch: 'scratch/hang',
        stretch: 'stretch', watch: 'behind', shadow: 'behind', wave: 'wave', clipboard: 'hold', eat: 'drink' };
    function poseOf(a, moving, now, st) {
        var g = G(), R = { x: a.x, y: a.y + 3, sit: false, sz: 14, deep: false, view: null, turn: null, legs: 'stand', lk: 0,
            arms: 'hang', af: 0, props: [], up: [0, 0, 0], head: [0, 0, 0], chair: null, zs: false, faceCam: false };
        var seat = moving ? null : (a._lastSeat || null);
        var offline = a.state === 'offline', snooze = a._lifePose === 'snooze';
        if (seat) {
            var kind = seat.kind;
            if (kind === 'desk' || kind === 'bossDesk') {
                var info = null;
                try { info = a.seatInfo ? a.seatInfo() : null; } catch (e) { info = null; }
                var ds = info && info.item ? deskSeat(info.item) : null;
                if (ds) {
                    R.x = ds.x; R.y = ds.y; R.view = seat.view || ds.view; R.desk = ds;
                    if (seat.stand || ds.stand) R.standDesk = true;
                    else { R.sit = true; R.sz = ds.sz; R.chair = 'd:' + (ds.item.id || (ds.item.x + ',' + ds.item.y)); }
                } else R.sit = true;
            } else if (kind === 'meeting') {
                var mc = meetingChairAt(a.x, a.y);
                if (mc) { R.x = mc.x; R.y = mc.y; R.view = mc.view; R.sit = true; R.chair = mc.key; }
                else { R.sit = true; R.view = seat.view; }
            } else {
                var v = seat.view || 'down', fv = U.VIEW_VEC[v] || [0, 1], cn = 0;
                // a couch moved off the back wall (stack-scene wallNudge): its sitters move with it
                try { var ci = a.seatInfo ? a.seatInfo() : null; cn = ci && ci.item && S.nudgeOf ? S.nudgeOf(ci.item) : 0; } catch (e) { cn = 0; }
                R.x = a.x + (seat.dx || 0) - fv[0] * 15; R.y = a.y + (seat.dy || 0) + 14 - fv[1] * 15 + cn;
                R.view = v; R.sit = true; R.deep = true;
            }
        } else if (a.isSitting && !moving) R.sit = true;
        if (R.view) R.turn = U.VIEW_TURN[R.view];
        R.legs = R.sit ? (R.deep ? 'sitDeep' : 'sit') : moving ? 'walk' : 'stand';
        // walk cycle (the classic's sin(tick * 0.2) phase in quarters)
        if (moving) {
            var ph = ((a.tick || 0) * 0.2) % (2 * PI);
            R.lk = Math.floor((ph + PI / 4) / (PI / 2)) & 3;
            R.arms = 'swing'; R.af = R.lk;
            R.up = [0, 0, (R.lk & 1) ? 0 : 1];
        }
        // ----- arms, props, head -----
        var rw = null;
        try { rw = typeof g._waveNow === 'function' ? g._waveNow(a, moving) : null; } catch (e) { rw = null; }
        var item = a._lifeCarry || null, lp = a._lifePose || null;
        var typing = typeof g._typingNow === 'function' ? g._typingNow(a) : (a.state === 'working' && a.isSitting);
        var atDesk = R.sit || R.standDesk, dif = atDesk ? a._dif : null, wk = atDesk ? a._wkLast : null;
        var sleepy = (offline || snooze) && !moving;
        if (rw && (rw.kind === 'wave' || rw.kind === 'walk' || rw.kind === 'turn')) {
            var env = rw.still ? 1 : Math.min(1, rw.p / 0.12, (1 - rw.p) / 0.12);
            var sw = rw.still ? 0 : Math.round(Math.sin(rw.p * PI * (rw.big ? 8 : 6)) * (rw.big ? 3 : 2));
            R.arms = (env < 0.5 ? 'fist' : rw.big ? 'waveBig' : 'wave') + '/' + (R.sit ? 'lap' : moving ? 'hang' : 'hang');
            R.af = env < 0.5 ? 0 : sw;
            if (!moving && !R.sit) R.faceCam = true;
        } else if (rw && rw.kind === 'stir') {
            R.head = [0, 0, 1];
        } else if (sleepy && R.sit) {
            var dir = (U.hash(a.id || a.name) & 1) ? 1 : -1;
            R.arms = R.view === 'up' ? 'hang' : 'sleepFold';
            R.head = [dir * 2, 1, -2]; R.up = [dir, 0, -1];
            R.zs = true;
        } else if (lp && LIFE_ARMS[lp] && !moving) {
            R.arms = LIFE_ARMS[lp];
            if (lp === 'type') R.arms = 'type';
            if (lp === 'sign') R.props.push({ name: 'sign', hand: 1 });
            if ((lp === 'give' || lp === 'take' || lp === 'clipboard') && (item || lp === 'clipboard')) R.props.push({ name: item || 'clipboard', hand: lp === 'clipboard' ? 'both' : 0 });
            if (lp === 'eat' && item) R.props.push({ name: item, hand: 0 });
            if (lp === 'wave') { R.arms = 'wave/hang'; R.af = Math.round(Math.sin((a.tick || 0) * 0.25) * 2); R.faceCam = !R.sit; }
            if (lp === 'stretch') R.head = [0, -1, 1];
        } else if (lp === 'snooze') {
            R.zs = !moving;
        } else if (item) {
            R.arms = moving ? 'carry/swing' : 'hold'; R.af = R.lk;
            R.props.push({ name: item, hand: moving ? 0 : 'both' });
        } else if (atDesk && dif) {
            var arms = dif.arms;
            if (arms === 'up') R.arms = dif.s === 1 ? 'stretch1' : dif.s === 2 ? 'stretch2' : 'stretch';
            else if (arms === 'head') R.arms = 'headBehind';
            else if (arms === 'hold') R.arms = 'armrest';
            else if (arms === 'lap') R.arms = R.standDesk ? 'hang' : 'lap';
            else if (arms === 'sip') { R.arms = dif.s >= 3 ? 'drink/' + (R.standDesk ? 'hang' : 'lap') : dif.s >= 1 ? 'drinkLow/' + (R.standDesk ? 'hang' : 'lap') : R.standDesk ? 'hang' : 'lap'; R.props.push({ name: 'mug', hand: 0 }); }
            else if (arms === 'phone') { R.arms = 'phone'; R.props.push({ name: 'phone', hand: 0 }); R.head = [0, 1, -1]; }
            else if (arms === 'pen') { R.arms = 'pen/type'; R.af = dif.s ? 1 : 0; R.props.push({ name: 'pen', hand: 0 }); }
            else R.arms = R.standDesk ? 'typeHigh' : 'type';
            if (dif.up) R.up = [0, -1, 0];
        } else if (R.sit && a.carryItem && !a.idleAction && (a.tick % 540) < 120) {
            // the sip: reach, lift, drink, put back (the classic's 540 tick cycle)
            var sc = a.tick % 540;
            R.arms = (sc >= 45 && sc < 100 ? 'drink' : 'drinkLow') + '/lap';
            R.props.push({ name: a.carryItem === 'snack' || a.carryItem === 'food' ? a.carryItem : a.carryItem === 'water' ? 'water' : 'mug', hand: 0 });
        } else if (atDesk && (R.desk || a.state === 'working')) {
            if (a.state === 'working' && R.desk && (R.view === R.desk.view)) {
                var anim = a._workNow, fast = lp === 'type', tick = a.tick || 0;
                if (anim === 'ponder') { R.arms = 'headBehind'; R.up = [0, -1, 0]; R.head = [0, 0, 1]; }
                else if (anim === 'scan') { R.arms = 'chin/type'; R.head = [wk ? wk.hx : 0, 0, 0]; }
                else if (anim === 'talk') { R.arms = 'talk2/type'; R.af = 0; }
                else {
                    R.arms = R.standDesk ? 'typeHigh' : 'type';
                    R.af = typing ? 1 + (Math.floor(tick / (fast || anim === 'burst' ? 5 : 9)) % 2) : 0;
                    if (anim === 'papers' && wk && wk.look) R.head = [0, 1, -1];
                    if (anim === 'burst' || anim === 'scroll' || fast) R.up = [0, 1, 0];
                }
            } else R.arms = R.standDesk ? (R.desk && R.view === R.desk.view ? 'typeHigh' : 'hang') : R.desk && R.view === R.desk.view ? 'type' : 'lap';
        } else if (R.sit) {
            R.arms = a.idleAction === 'couch' ? 'headBehind' : a.idleAction === 'watch_tv' ? 'remote/lap' : a.idleAction === 'read_book' ? 'book' : 'lap';
            if (a.idleAction === 'watch_tv') R.props.push({ name: 'remote', hand: 0 });
            if (a.idleAction === 'read_book') { R.props.push({ name: 'book', hand: 'both' }); R.head = [0, 1, -1]; }
        } else if (!moving) {
            var act = a.idleAction;
            if (act === 'pong') {
                var pg = (g.pongGames || []).find(function (q) { return q.p1.id === a.id || q.p2.id === a.id; });
                var p1 = pg && pg.p1.id === a.id, swing = pg ? (p1 ? pg.p1Swing : pg.p2Swing) || 0 : 0;
                R.arms = (swing > 0.3 ? 'pong2' : 'pong') + '/hang'; R.props.push({ name: p1 ? 'paddleR' : 'paddleB', hand: 0 });
            } else if (act === 'stretch') R.arms = 'stretch';
            else if (act === 'read_book') { R.arms = 'book'; R.props.push({ name: 'book', hand: 'both' }); R.head = [0, 1, -1]; }
            else if (act === 'look_window') { R.arms = 'behind'; R.view = 'up'; }
            else if (act === 'watch_tv') { R.arms = 'remote/hang'; R.props.push({ name: 'remote', hand: 0 }); }
            else if (act === 'couch' || act === 'lounge') R.arms = 'headBehind';
            else if (act === 'break_browse') R.arms = 'chin/hang';
            else if (act === 'get_snack' || act === 'make_coffee' || act === 'get_water' || act === 'make_food') {
                R.arms = 'reach/hang';
                if (act === 'get_water' && a.interactTimer > 40) R.props.push({ name: 'water', hand: 0 });
                if (act === 'make_coffee' && a.interactTimer > 60) R.props.push({ name: 'mug', hand: 0 });
            } else if (act === 'darts') {
                var thr = (a.tick % 120) < 14;
                R.arms = (thr ? 'dartThrow' : 'dartAim') + '/hang'; if (!thr) R.props.push({ name: 'dart', hand: 0 });
            } else if (act === 'visit' || act === 'gathering') { R.arms = (Math.floor((a.tick || 0) / 20) % 2 ? 'talk2' : 'talk') + '/hang'; }
            else if (act === 'petting') R.arms = 'pet/hang';
            else {
                var held = (P.lookOf(a) || {}).heldItem;
                if (held) { R.arms = 'hold/hang'; R.props.push({ name: held, hand: 0 }); }
            }
            if (!R.props.length && a.carryItem) R.props.push({ name: a.carryItem === 'water' ? 'water' : a.carryItem === 'coffee' ? 'mug' : a.carryItem, hand: 0 }), R.arms = 'carry/hang';
        } else {
            if (a.idleAction === 'chasing_pet') R.arms = 'chase';
            else if (a.carryItem) { R.arms = 'carry/swing'; R.props.push({ name: a.carryItem === 'water' ? 'water' : a.carryItem === 'coffee' ? 'mug' : a.carryItem, hand: 0 }); }
        }
        if ((offline || snooze) && !moving && !R.sit) R.zs = true;
        // breathing: standing still, the upper body bobs a pixel
        if (!moving && !R.sit && !R.standDesk) R.up[2] += Math.round(Math.sin((a.tick || 0) * 0.05));
        // the face
        var expr = 'neutral';
        try { expr = typeof g._agentExpression === 'function' ? g._agentExpression(a) : 'neutral'; } catch (e) { expr = 'neutral'; }
        R.expr = expr;
        R.closed = (a.blinkTimer > 0) || sleepy;
        R.mouth = a.talkTimer > 0 ? (Math.floor((a.tick || 0) / 3) % 2 === 0 ? 'talk' : 'talkShut') : null;
        return R;
    }
    // Which way a standing person faces (smoothly turned toward it).
    function standTurn(a, R, st, moving, now) {
        var g = G();
        if (moving) {
            var dx = a.x - st.px, dy = a.y - st.py;
            if (dx * dx + dy * dy > 0.04) { st.walkTurn = U.faceTurn(dx, dy); st.stopAt = now; }
            else if (Math.abs(a.targetX - a.x) + Math.abs(a.targetY - a.y) > 1 && st.walkTurn == null) st.walkTurn = U.faceTurn(a.targetX - a.x, a.targetY - a.y);
            return st.walkTurn != null ? st.walkTurn : 0;
        }
        if (R.faceCam) { var cam = S.cam ? S.cam() : { yaw: 0 }; return -(cam.yaw || 0); }
        if (R.view) return U.VIEW_TURN[R.view];
        var act = a.idleAction;
        var other = null;
        if (act === 'petting' || act === 'chasing_pet') { var pets = g.officePets || []; other = pets[0] || null; }
        if (!other && a.socialTarget) other = findAgent(a.socialTarget);
        if (!other && a.visitTarget) other = findAgent(a.visitTarget);
        if (other && isFinite(other.x)) return U.faceTurn(other.x - a.x, other.y - a.y);
        if (act === 'pong') return U.faceTurn(a.faceDir < 0 ? -1 : 1, 0);
        var t = act ? spotTarget(a, st) : null;
        if (t) return U.faceTurn(t.x - a.x, t.y - a.y);
        // just stopped: keep the walk's facing a moment, then the classic's front view (looking toward faceDir)
        if (st.walkTurn != null && now - (st.stopAt || 0) < 1400) return st.walkTurn;
        return U.faceTurn((a.faceDir < 0 ? -1 : 1) * 0.55, 1);
    }

    // ---------- the meshes of a person ----------
    function personMeshes(a, R) {
        var app = P.lookOf(a), isF = P.fem(a);
        var hs = P.headSig(a, app), ds = P.decoSig(a);
        var head = mesh('ph|' + hs + '|' + ds + '|' + R.expr + '|' + (R.closed ? 1 : 0) + '|' + (R.mouth || ''), function () { return P.buildHead(a, app, R.expr, R.closed, R.mouth); });
        var torso = mesh('pt|' + P.torsoSig(a, app) + '|' + (a._lifeIntern ? 'I' : ''), function () { return P.buildTorso(a, app); });
        var tc = P.topColors(app, a.color), skin = P.safeHex(app.skinTone, '#ffcc80');
        var ac = { sleeve: tc.sleeve, fore: tc.sleeve, hand: tc.hand || skin };
        var pk = R.props.map(function (p) { return p.name + ':' + p.hand; }).join(',');
        var arms = mesh('pa|' + ac.sleeve + '|' + ac.hand + '|' + (isF ? 'F' : 'M') + '|' + R.arms + '|' + R.af + '|' + pk, function () { return P.buildArms(ac, isF, R.arms, R.af, R.props); });
        var lc = P.legColors(a, app);
        var legs = mesh('pl|' + lc.pants + '|' + lc.shoes + '|' + (isF ? 'F' : 'M') + '|' + R.legs + '|' + R.lk + '|' + R.sz, function () {
            return P.buildLegs(lc, isF, R.legs === 'sitDeep' ? 'sitDeep' : R.legs, R.lk, R.sz);
        });
        // a part that could not be made this frame (the pose space full) keeps the
        // person's last good one, so nobody blinks out
        var last = a._stkParts || (a._stkParts = {}), parts = { head: head, torso: torso, arms: arms, legs: legs };
        Object.keys(parts).forEach(function (k) {
            if (parts[k] && parts[k].alive) last[k] = parts[k];
            else if (last[k] && last[k].alive) {
                parts[k] = last[k];
                try { S.state.renderer.atlas.touch(last[k], S.state.renderer.stamp); } catch (e) { /* no renderer */ }
            }
        });
        return parts;
    }
    // Zs drifting up from a sleeper (voxel letters), and a mug on the desk.
    function zMesh(big) {
        return mesh('pz|' + (big ? 1 : 0), function () {
            var m = S.model(-6, -2, 8, 3, 14, 0), s = big ? 2 : 1;
            m.text('Z', 0, 0, 0, 'south', '#eceff1', { scale: s, depth: 2 });
            return m;
        });
    }
    function mugMesh(kind) {
        return mesh('pm|' + kind, function () {
            var m = S.model(-5, -5, 5, 5, 10, 0);
            if (kind === 'water') { m.cyl(0, 0, 0, 2.4, 2.4, 6, '#d8eefc'); m.cyl(0, 0, 0, 1.7, 1.7, 4, '#64b5f6'); }
            else if (kind === 'snack') { m.box(-2, -2, 0, 4, 3, 6, '#ffb300'); m.paint(-2, 0, 2, 4, 1, 2, '#e53935'); }
            else if (kind === 'food') { m.box(-3, -2, 0, 6, 5, 3, '#e8c27a'); m.paint(-3, -2, 1, 6, 5, 1, '#7cb342'); }
            else { m.cyl(0, 0, 0, 2.6, 2.6, 6, '#f5f5f5'); m.cyl(0, 0, 5, 1.7, 1.7, 1, '#6d4c41'); m.box(2, -1, 1, 2, 2, 3, '#e0e0e0'); m.carve(3, -1, 2, 1, 2, 1); }
            return m;
        });
    }

    // The agent's desk item (appearance.deskItem: trophy, calendar, chart...): the
    // classic art on a small standing card at the desk's item spot.
    function deskItemMesh(a, app) {
        var id = app && app.deskItem;
        if (!id || typeof a._drawDeskCharItem !== 'function') return null;
        return mesh('pdi|' + id, function () {
            var g = G(), base = g.DESK_SEAT && g.DESK_SEAT.desk && g.DESK_SEAT.desk[0] && g.DESK_SEAT.desk[0].item || [0, 0];
            var fake = { getAppearance: function () { return app; }, _myDeskItem: function () { return null; }, deskType: null };
            var art = CH._capture(function (cg) { CH._withCtx(cg, function () { a._drawDeskCharItem.call(fake, cg); }); });
            if (!art || !art.any) return null;
            var m = S.model(-12, -2, 20, 3, 24, 0), any = false, low = -99, row, x;
            for (row = -6; row <= 14; row++) for (x = -6; x <= 18; x++) if (art.at(base[0] + x, base[1] + row)) low = Math.max(low, row);
            for (row = -6; row <= 14; row++) for (x = -6; x <= 18; x++) {
                var c = art.at(base[0] + x, base[1] + row);
                if (!c) continue;
                m.box(x - 6, 0, low - row, 1, 2, 1, c); any = true;
            }
            return any ? m : null;
        });
    }

    // ---------- one person ----------
    function pushPerson(a, out, id, now, dt, sitters, kind) {
        var st = a._stk || (a._stk = { px: a.x, py: a.y, turn: null, walkTurn: null, stopAt: 0 });
        var moving = Math.abs(a.targetX - a.x) > a.speed || Math.abs(a.targetY - a.y) > a.speed;
        var R = poseOf(a, moving, now, st);
        var want = R.turn != null ? R.turn : standTurn(a, R, st, moving, now);
        if (R.turn != null && R.chair == null && !R.standDesk && !R.sit) want = R.turn;
        if (R.view === 'up' && !R.sit && !R.standDesk) want = U.VIEW_TURN.up;
        if (st.turn == null) st.turn = want;
        st.turn = U.easeA(st.turn, want, Math.min(1, dt / (moving ? 70 : 110)));
        st.px = a.x; st.py = a.y;
        var M = personMeshes(a, R);
        var t = st.turn, alpha = a._lifeAlpha != null ? Math.max(0, Math.min(1, a._lifeAlpha)) : 1;
        if (alpha <= 0.02) { drawn.delete(a); return; }
        var desat = a.state === 'offline' ? 1 : 0;
        var U0 = R.sit ? R.sz - 10 : 0, dyU = R.sit ? -1 : 0;
        if (R.deep) dyU = -1;
        var base = function (mesh, ox, oy, oz) {
            if (!mesh || !mesh.alive) return;
            var o = U.rot2(ox, oy, t);
            var sp = { mesh: mesh, x: R.x + o[0], y: R.y + o[1], z: oz, turn: t, id: id };
            if (alpha < 1) sp.alpha = alpha;
            if (desat) sp.desat = desat;
            out.push(sp);
        };
        base(M.legs, 0, 0, 0);
        var ux = R.up[0], uy = dyU + R.up[1], uz = U0 + R.up[2];
        base(M.torso, ux, uy, uz);
        base(M.arms, ux, uy, uz);
        base(M.head, ux + R.head[0], uy + R.head[1], uz + R.head[2]);
        var top = (M.head && M.head.alive ? M.head.oz + M.head.n : 48) + uz + R.head[2];
        drawn.set(a, { x: R.x, y: R.y, z: 0, turn: t, top: top, sit: R.sit });
        if (R.chair) sitters.set(R.chair, t);
        // the drink on the desk (the classic's food spot), while it is not in the hand
        if (R.sit && R.desk && a.carryItem && !a.idleAction && !moving && (a.tick % 540) >= 120) {
            var dk = R.desk.item, g = G(), mk = typeof g._mk === 'function' ? g._mk(dk) : dk.type, rot = dk.rotation || 0;
            var man = (g.FURNITURE_MANIFEST || {})[mk], sf = man && man.surface, spot = sf && (rot && sf.spotsAt && sf.spotsAt[rot] ? sf.spotsAt[rot].food : sf.spots && sf.spots.food);
            if (spot) {
                var topZ = 21;
                var mm = mugMesh(a.carryItem === 'water' ? 'water' : a.carryItem === 'snack' ? 'snack' : a.carryItem === 'food' ? 'food' : 'coffee');
                if (mm && mm.alive) out.push({ mesh: mm, x: dk.x + spot[0], y: dk.y + spot[1] + topZ, z: topZ, turn: 0, id: id });
            }
        }
        // the desk item on the agent's own desk (wherever the agent is)
        if (kind !== 'extra' && typeof a._myDeskItem === 'function') {
            var di = null;
            try { di = a._myDeskItem(); } catch (e) { di = null; }
            if (di) {
                var g2 = G(), mk2 = typeof g2._mk === 'function' ? g2._mk(di) : di.type, rot2 = di.rotation || 0;
                var man2 = (g2.FURNITURE_MANIFEST || {})[mk2], sf2 = man2 && man2.surface;
                var sp2 = sf2 && (rot2 && sf2.spotsAt && sf2.spotsAt[rot2] ? sf2.spotsAt[rot2].item : sf2.spots && sf2.spots.item);
                var dm = sp2 ? deskItemMesh(a, P.lookOf(a)) : null;
                if (dm && dm.alive) {
                    var tz = man2.seats && man2.seats[0] && man2.seats[0].stand ? 30 : 21;
                    out.push({ mesh: dm, x: di.x + sp2[0], y: di.y + sp2[1] + tz, z: tz, turn: rot2 * Math.PI / 180, id: id });
                }
            }
        }
        // Zs
        if (R.zs) {
            var ph = ((a.tick || 0) % 180) / 180, hx = U.rot2(10, 0, t);
            for (var k = 0; k < 2; k++) {
                var q = (ph + k * 0.5) % 1, zm = zMesh(q > 0.45);
                if (zm && zm.alive) out.push({ mesh: zm, x: R.x + hx[0], y: R.y + hx[1], z: top - 4 + q * 14, turn: camTurn(), id: id, alpha: Math.max(0.05, Math.min(1, q * 5) * (1 - q)), shadow: false });
            }
        }
    }

    // ---------- pets ----------
    function petPose(p) {
        var ap = null;
        try { ap = typeof p._artPose === 'function' ? p._artPose() : null; } catch (e) { ap = null; }
        var name = ap ? ap[0] : 'sit', fr = ap ? ap[1] : 0, moving = !!p.isMoving;
        var R = { pose: 'stand', frame: 0, blink: !!p._blinking, spin: false };
        if (p.state === 'trick') {
            if (p._trick === 'spin') { R.pose = 'walk'; R.frame = Math.floor((p.tick || 0) / 5) % 4; R.spin = true; }
            else if (p._trick === 'hop') { R.pose = 'sit'; }
            else { R.pose = 'trick'; R.frame = fr; }
        } else if (p.state === 'sleeping') { R.pose = 'sleep'; R.frame = fr; R.blink = true; }
        else if (p.state === 'grooming') { R.pose = 'groom'; R.frame = fr; }
        else if (p.state === 'eating') { R.pose = name === 'pet' || name === 'walkU' ? 'eat' : 'sit'; }
        else if (p.state === 'being_pet') { R.pose = 'pet'; }
        else if (p.state === 'looking_around') { R.pose = 'look'; R.frame = p.faceDir < 0 ? 1 : 0; }
        else if (p.state === 'sitting') { R.pose = 'sit'; R.blink = name === 'sit' && fr === 2 ? true : R.blink; }
        else if (moving) { R.pose = 'walk'; R.frame = fr & 3; }
        else R.pose = 'stand';
        return R;
    }
    function pushPet(p, out, id, now, dt) {
        var st = p._stk || (p._stk = { px: p.x, py: p.y, turn: null, walkTurn: 0 });
        var sp = p.species || 'cat';
        var g = G();
        if (!(g.PET_ART && g.PET_ART[sp]) && CH.PET_SPECIES_FALLBACK.indexOf(sp) < 0) sp = 'lobster';
        var R = petPose(p);
        var dx = p.x - st.px, dy = p.y - st.py;
        if (dx * dx + dy * dy > 0.02) st.walkTurn = U.faceTurn(dx, dy);
        var want = st.walkTurn;
        if (!p.isMoving) {
            var tgt = p.state === 'being_pet' ? p.interactingAgent : p.state === 'eating' && p._useSpot ? p._useSpot.item : null;
            if (tgt && isFinite(tgt.x)) want = U.faceTurn(tgt.x - p.x, tgt.y - p.y);
            else if (p.state === 'sitting' || p.state === 'trick') want = U.faceTurn((p.faceDir < 0 ? -1 : 1) * 0.6, 1);
            else if (p.state === 'looking_around') want = U.faceTurn((p.faceDir < 0 ? -1 : 1), 0.35);
        }
        if (R.spin) want = (st.turn || 0) + 0.9;
        if (st.turn == null) st.turn = want;
        st.turn = R.spin ? U.wrapA(st.turn + dt * 0.012) : U.easeA(st.turn, want, Math.min(1, dt / 120));
        st.px = p.x; st.py = p.y;
        var key = 'pp|' + sp + '|' + R.pose + '|' + R.frame + '|' + (R.blink ? 1 : 0);
        var m = mesh(key, function () { return CH.petModel(sp, R.pose, R.frame, R.blink); });
        var lift = 0;
        try { lift = typeof p._trickLift === 'function' ? p._trickLift() : 0; } catch (e) { lift = 0; }
        var fy = p.y + ((g.PET_FOOT || 9) - 2);
        if (m && m.alive) out.push({ mesh: m, x: p.x, y: fy, z: lift, turn: st.turn, id: id });
        var top = (m && m.alive ? m.oz + m.n : 16) + lift;
        drawn.set(p, { x: p.x, y: fy, z: lift, turn: st.turn, top: top });
        if (p.state === 'sleeping') {
            var ph = (p.sleepZ || 0) % 1, hx = U.rot2(6, 4, st.turn);
            for (var k = 0; k < 2; k++) {
                var q = (ph + k * 0.5) % 1, zm = zMesh(q > 0.45);
                if (zm && zm.alive) out.push({ mesh: zm, x: p.x + hx[0], y: fy + hx[1], z: top - 2 + q * 12, turn: camTurn(), id: id, alpha: Math.max(0.05, Math.min(1, q * 6) * (1 - q)), shadow: false });
            }
        } else if (p.state === 'being_pet') {
            var hm = mesh('pheart', function () {
                var mm = S.model(-4, -1, 4, 2, 8, 0);
                [[-3, 4, 2, 2], [1, 4, 2, 2], [-3, 2, 6, 2], [-2, 1, 4, 1], [-1, 0, 2, 1]].forEach(function (r) { mm.box(r[0], 0, r[1], r[2], 2, r[3], '#e91e63', MAT.EMIT); });
                mm.box(-2, 0, 5, 1, 2, 1, '#f8bbd0', MAT.EMIT);
                return mm;
            });
            if (hm && hm.alive) out.push({ mesh: hm, x: p.x, y: fy, z: top + 3 + Math.round(Math.sin((p.tick || 0) * 0.2) * 2), turn: camTurn(), id: id, shadow: false });
        }
    }

    // ---------- chairs ----------
    var chairTurn = new Map();
    function pushChairs(out, idFor, sitters, dt) {
        var g = G(), list = (g.officeConfig && g.officeConfig.furniture) || [], n = 0;
        var editing = false;
        try { editing = !!editMode; } catch (e) { editing = !!g.editMode; }
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (it.type !== 'desk' && it.type !== 'bossDesk') continue;
            var ds = deskSeat(it);
            if (!ds || !ds.chair || !S.defs[ds.chair]) continue;
            var key = 'd:' + (it.id || (it.x + ',' + it.y));
            n = pushChair(out, idFor, ds.chair, key, ds.x, ds.y, ds.turn, sitters, dt, it, n, editing);
        }
        if (S.defs['chair:meeting']) {
            var t = g._meetMemo && g._meetMemo.table;
            meetingChairs().forEach(function (c) { n = pushChair(out, idFor, 'chair:meeting', c.key, c.x, c.y, c.turn, sitters, dt, t, n, editing); });
        }
    }
    function pushChair(out, idFor, type, key, x, y, rest, sitters, dt, item, n, editing) {
        var want = sitters.has(key) ? sitters.get(key) : rest, cur = chairTurn.get(key);
        cur = cur == null || editing ? want : (sitters.has(key) ? want : U.easeA(cur, want, Math.min(1, dt / 260)));
        chairTurn.set(key, cur);
        var m = smesh(type, function () { return S.defs[type].build({ type: type }, {}); });
        if (!m || !m.alive) return n;
        var sp = { mesh: m, x: x, y: y, z: 0, turn: cur, id: idFor('chair', n, item) };
        if (editing && item) {
            // the chair goes with its desk in the editor: tinted with it, see-through while it is dragged
            var sel = null, multi = null, drag = false;
            try { sel = selectedItemId; } catch (e) { sel = null; }
            try { multi = _multiSelected; } catch (e) { multi = null; }
            try { drag = !!isDragging; } catch (e) { drag = false; }
            var picked = item.id != null && (sel === item.id || (multi && multi.indexOf && multi.indexOf(item.id) >= 0));
            if (picked) { sp.tint = [255, 214, 0]; sp.tintAmt = 0.18; }
            if (picked && drag) sp.alpha = 0.75;
        }
        out.push(sp);
        return n + 1;
    }

    // ---------- the frame ----------
    var lastNow = 0;
    S.peopleItems = function (out, idFor, now, runLegacy) {
        var g = G();
        var dt = lastNow ? Math.max(1, Math.min(100, now - lastNow)) : 16;
        lastNow = now;
        drawn = new Map();
        var sitters = new Map(), i;
        var ag = g.agents || [];
        for (i = 0; i < ag.length; i++) {
            var a = ag[i];
            if (!a || !isFinite(a.x) || !isFinite(a.y)) continue;
            if (runLegacy && typeof a.draw === 'function') runLegacy(a);
            try { pushPerson(a, out, idFor('agent', i, a), now, dt, sitters, 'agent'); } catch (e) { warnOnce('agent', e); }
        }
        var pets = typeof g.officePets !== 'undefined' ? g.officePets || [] : [];
        for (i = 0; i < pets.length; i++) {
            var p = pets[i];
            if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
            if (runLegacy && typeof p.draw === 'function') runLegacy(p);
            try { pushPet(p, out, idFor('pet', i, p), now, dt); } catch (e) { warnOnce('pet', e); }
        }
        var ex = typeof g._lifeExtras !== 'undefined' ? g._lifeExtras || [] : [];
        for (i = 0; i < ex.length; i++) {
            var x = ex[i];
            if (!x || !isFinite(x.x) || !isFinite(x.y)) continue;
            if (runLegacy && typeof x.draw === 'function') runLegacy(x);
            if (typeof x.getAppearance !== 'function') continue;
            try { pushPerson(x, out, idFor('extra', i, x), now, dt, sitters, 'extra'); } catch (e) { warnOnce('extra', e); }
        }
        try { pushChairs(out, idFor, sitters, dt); } catch (e) { warnOnce('chairs', e); }
    };
    var warned = {};
    function warnOnce(k, e) { if (warned[k]) return; warned[k] = true; console.warn('[stack] ' + k + ' figure failed', e); }

    CH.poseOf = poseOf;
    CH.deskSeat = deskSeat;
    CH.meetingChairs = meetingChairs;
})();

// ======================================================================
// The people gallery (gallery.html?people=1&set=...): figures in sample looks
// and poses, built with the office's own art (G = an office iframe).
// ======================================================================
(function () {
    'use strict';
    var S = window.VOStack, CH = S.chars, P = CH._parts, U = CH._util;
    function fake(app, color, gender, extra) {
        return Object.assign({ id: 'g' + Math.random(), gender: gender || 'M', color: color || '#1976d2', emoji: '', appearance: app, getAppearance: function () { return app; } }, extra || {});
    }
    var BASE = { skinTone: '#f5d0b0', hairStyle: 'short', hairColor: '#5d4037', eyebrowStyle: 'thick', eyeColor: '#212121' };
    function look(o) { return Object.assign({}, BASE, o || {}); }
    // One figure as parts: R = pose (see poseOf in the scene section).
    function figure(a, R) {
        R = Object.assign({ legs: 'stand', lk: 0, sz: 14, arms: 'hang', af: 0, props: [], up: [0, 0, 0], head: [0, 0, 0], expr: 'neutral', closed: false, mouth: null, sit: false }, R || {});
        var app = P.lookOf(a), isF = P.fem(a), tc = P.topColors(app, a.color), skin = P.safeHex(app.skinTone, '#ffcc80');
        var U0 = R.sit ? R.sz - 10 : 0, dy = R.sit ? -1 : 0, up = R.up;
        var ac = { sleeve: tc.sleeve, fore: tc.sleeve, hand: tc.hand || skin };
        return [
            { model: P.buildLegs(P.legColors(a, app), isF, R.legs, R.lk, R.sz), ox: 0, oy: 0, oz: 0 },
            { model: P.buildTorso(a, app), ox: up[0], oy: dy + up[1], oz: U0 + up[2] },
            { model: P.buildArms(ac, isF, R.arms, R.af, R.props), ox: up[0], oy: dy + up[1], oz: U0 + up[2] },
            { model: P.buildHead(a, app, R.expr, R.closed, R.mouth), ox: up[0] + R.head[0], oy: dy + up[1] + R.head[1], oz: U0 + up[2] + R.head[2] }
        ];
    }
    function chairPart(type) { var d = S.defs[type]; return d ? { model: d.build({ type: type }, {}), ox: 0, oy: 0, oz: 0 } : null; }
    CH.galleryEntries = function (q, win) {
        var G = U.G(), set = q.set || 'agents', out = [];
        var add = function (label, parts) { out.push({ label: label, parts: parts.filter(Boolean) }); };
        if (set === 'agents') {
            (G.agents || []).concat(G._lifeExtras || []).forEach(function (a) { add(a.name || a.id, figure(a, {})); });
        } else if (set === 'hair') {
            (G.HAIR_STYLE_TABLE || []).forEach(function (h, i) { add(h.id, figure(fake(look({ hairStyle: h.id, hairColor: ['#5d4037', '#1a1a1a', '#dcc282', '#bf360c', '#616161'][i % 5] }), '#1976d2', i % 2 ? 'F' : 'M'), {})); });
        } else if (set === 'hats') {
            (G.HEADWEAR_STYLES || []).forEach(function (h, i) { add(h.id, figure(fake(look({ headwear: h.id, headwearColor: ['#ffb300', '#1e88e5', '#ffd54f', '#e0e0e0', '#e53935', '#455a64'][i % 6], hairStyle: i % 2 ? 'long' : 'short' }), '#43a047'), {})); });
        } else if (set === 'costumes') {
            ((G.BODY_LOOKS && G.BODY_LOOKS.costumes) || []).forEach(function (c) { add(c.id, figure(fake(look({ costume: c.id === 'none' ? null : c.id }), '#8e24aa'), {})); });
        } else if (set === 'tops') {
            ((G.BODY_LOOKS && G.BODY_LOOKS.tops) || []).forEach(function (t, i) {
                var nw = ((G.BODY_LOOKS && G.BODY_LOOKS.neckwear) || [])[i % 5];
                add(t.id, figure(fake(look({ shirtStyle: t.id, neckwear: nw && nw.id, pantsColor: '#37474f', shoeColor: '#5d4037' }), ['#c62828', '#1565c0', '#2e7d32', '#6a1b9a', '#ef6c00', '#00838f', '#ad1457'][i % 7], t.id === 'blouse' ? 'F' : 'M'), {}));
            });
        } else if (set === 'faces') {
            ['neutral', 'focused', 'stuck', 'happy', 'sleepy', 'surprised', 'waiting'].forEach(function (e, i) {
                add(e, figure(fake(look({ glasses: [null, 'round', 'square', 'sunglasses'][i % 4], facialHair: [null, 'stubble', 'beard', 'goatee', 'mustache'][i % 5], hairStyle: ['short', 'bob', 'afro', 'bun', 'mohawk', 'curly', 'pixie'][i] }), '#546e7a', i % 2 ? 'F' : 'M'), { expr: e }));
            });
        } else if (set === 'poses') {
            var who = (q.who && (G.agents || []).find(function (x) { return x.name === q.who || x.id === q.who; })) || (G.agents || [])[0] || fake(look({ hairStyle: 'spiky' }), '#ffd700');
            var poses = [
                ['stand', {}], ['walk0', { legs: 'walk', lk: 0, arms: 'swing', af: 0, up: [0, 0, 1] }], ['walk1', { legs: 'walk', lk: 1, arms: 'swing', af: 1 }],
                ['walk2', { legs: 'walk', lk: 2, arms: 'swing', af: 2, up: [0, 0, 1] }], ['walk3', { legs: 'walk', lk: 3, arms: 'swing', af: 3 }],
                ['sit', { sit: true, legs: 'sit', arms: 'lap' }], ['type', { sit: true, legs: 'sit', arms: 'type', af: 1 }],
                ['wave', { arms: 'wave/hang', af: 2 }], ['drink', { sit: true, legs: 'sit', arms: 'drink/lap', props: [{ name: 'mug', hand: 0 }] }],
                ['phone', { arms: 'phone', props: [{ name: 'phone', hand: 0 }], head: [0, 1, -1] }], ['stretch', { arms: 'stretch' }],
                ['sleep', { sit: true, legs: 'sit', arms: 'sleepFold', closed: true, expr: 'sleepy', head: [2, 1, -2], up: [1, 0, -1] }],
                ['book', { arms: 'book', props: [{ name: 'book', hand: 'both' }] }], ['reach', { arms: 'reach/hang' }], ['sign', { arms: 'hang/sign', props: [{ name: 'sign', hand: 1 }] }],
                ['couch', { sit: true, legs: 'sitDeep', arms: 'headBehind' }], ['carry', { legs: 'walk', lk: 1, arms: 'carry/swing', af: 1, props: [{ name: 'mug', hand: 0 }] }]
            ];
            if (q.allArms === '1') poses = Object.keys(P.ARM).filter(function (k) { return P.ARM[k]; }).map(function (k) { return [k, { arms: k + (P.ARM[k].R ? '' : '/hang'), af: 0 }]; });
            if (q.only) { var keep = q.only.split(','); poses = poses.filter(function (p) { return keep.indexOf(p[0]) >= 0; }); }
            poses.forEach(function (p) {
                if (q.expr) p[1] = Object.assign({ expr: q.expr }, p[1]);
                var parts = figure(who, p[1]);
                if (p[1].sit && p[0] !== 'couch') parts.unshift(chairPart('chair:desk'));
                add(p[0], parts);
            });
        } else if (set === 'pets') {
            var sps = (G.PET_SPECIES || []).map(function (s) { return s.id; });
            if (!sps.length) sps = CH.PET_SPECIES_FALLBACK;
            var pp = (q.pose || 'stand').split(',');
            sps.forEach(function (sp) {
                pp.forEach(function (pz) {
                    var bits = pz.split(':');
                    add(sp + ' ' + pz, [{ model: CH.petModel(sp, bits[0], +(bits[1] || 0), false), ox: 0, oy: 0, oz: 0 }]);
                });
            });
        } else if (set === 'chairs') {
            ['chair:desk', 'chair:boss', 'chair:meeting'].forEach(function (t) {
                add(t, [chairPart(t)]);
                var who2 = (G.agents || [])[0] || fake(look(), '#1976d2');
                add(t + ' sat', [chairPart(t)].concat(figure(who2, { sit: true, legs: 'sit', arms: 'type', af: 1, sz: t === 'chair:boss' ? 15 : 14 })));
            });
        }
        return out;
    };
})();
