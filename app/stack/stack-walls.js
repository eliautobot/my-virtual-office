// Walls, the back wall and the diorama base as stacks.
// Back wall: stands on the tile line the floor starts at (S.wallFace(): 80 for
// the classic 90 px wall band), 10 px thick going north and that tall: in the
// plan view its face covers y 0..face, and the first floor row is a whole tile. Interior walls: 36 px partitions on the tile grid.
// A wall the camera looks at from behind is cut down to a low curb, so the
// room stays in view at every turn.
(function () {
    'use strict';
    var S = window.VOStack = window.VOStack || {};
    var C = S.color, T = 40;
    var BACK_T = 10, PART_H = 36, SLAB = 14;
    S.partitionH = PART_H;   // a drawn wall's height (signs on it: stack-scene.js partitionPlace)

    function dispColor(c, fb) {
        try { return typeof _wallDisplayColor === 'function' ? _wallDisplayColor(c || fb) : (c || fb); } catch (e) { return c || fb; }
    }

    // One 40 px piece of the back wall.
    function backWallModel(w, h, main, accent, trim) {
        var m = S.model(0, -BACK_T, w, 0, h, 0);
        var paint = S.tex.speckle(main, 0.035), wains = S.tex.speckle(accent, 0.04);
        m.box(0, -BACK_T, 0, w, BACK_T, h, function (x, y, z) {
            if (z < 4) return C.tone(trim, 0.9);                  // baseboard
            if (z < 20) return (x % 20 === 0 || x % 20 === 19) && y > -3 ? C.tone(accent, 0.86) : wains(x, y, z);   // wainscot panels
            if (z < 22) return C.tone(trim, 1.12);                // chair rail
            if (z >= h - 3) return C.tone(main, 0.82);            // crown
            return paint(x, y, z);
        });
        // the chair rail and crown stand a pixel proud of the face
        m.box(0, 0, 20, w, 1, 2, C.tone(trim, 1.15));
        m.box(0, 0, 0, w, 1, 4, C.tone(trim, 0.85));
        // the top of the wall: a dark cap
        m.paint(0, -BACK_T, h - 1, w, BACK_T, 1, C.tone(main, 0.55));
        return m;
    }
    // One tile of a partition (horizontal: along x; vertical: along y).
    function partitionModel(vertical, main, trim, trim2) {
        var th = vertical ? 10 : 6, h = PART_H;
        var m = vertical ? S.model(-th / 2, 0, th / 2, T, h, 0) : S.model(0, -th / 2, T, th / 2, h, 0);
        var body = S.tex.speckle(main, 0.03);
        var fill = function (x, y, z) {
            if (z < 4) return trim2;
            if (z >= 4 && z < 8) return trim;
            if (z >= h - 2) return C.tone(main, 1.12);
            return body(x, y, z);
        };
        if (vertical) m.box(-th / 2, 0, 0, th, T, h, fill); else m.box(0, -th / 2, 0, T, th, h, fill);
        // a soft cap and a glass-top look on long partitions
        if (vertical) m.paint(-th / 2, 0, h - 1, th, T, 1, C.tone(main, 1.2));
        else m.paint(0, -th / 2, h - 1, T, th, 1, C.tone(main, 1.2));
        return m;
    }
    // Where a partition meets the back wall: a post up the wall's face in the partition's colours.
    function pillarModel(h, main, trim, trim2) {
        var m = S.model(-6, 0, 6, 3, h, 0), body = S.tex.speckle(main, 0.03);
        m.box(-6, 0, 0, 12, 3, h, function (x, y, z) {
            if (z < 4) return trim2;
            if (z < 8) return trim;
            if (z >= h - 3) return C.tone(main, 0.8);
            return x === -6 || x === 5 ? C.tone(main, 0.86) : body(x, y, z);
        });
        return m;
    }
    // The base under the floor: a strip of the slab edge, n px long.
    function slabModel(len, vertical) {
        var m = vertical ? S.model(-4, 0, 0, len, 0, -SLAB) : S.model(0, 0, len, 4, 0, -SLAB);
        var side = S.tex.bands([[-SLAB, '#2c3240'], [-SLAB + 3, '#3a4152'], [-4, '#4a5266'], [-1, '#69728a']]);
        if (vertical) m.box(-4, 0, -SLAB, 4, len, SLAB, side); else m.box(0, 0, -SLAB, len, 4, SLAB, side);
        return m;
    }

    function topWallCfg() {
        try { return getTopWallConfig(); } catch (e) { return { color: '#37474f', accentColor: '#263238', trimColor: '#ffffff' }; }
    }

    // The camera direction on the floor (toward the camera), world axes.
    function camToward() {
        var c = S.cam(), cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        // view.y axis in world: R(-yaw) * (0, 1) = (sin, cos)
        return { x: sn, y: cs };
    }

    S.wallItems = function (out, idFor) {
        var wh = S.wallFace ? S.wallFace() : ((officeConfig.walls && officeConfig.walls.height) || 90);
        var tw = topWallCfg(), main = dispColor(tw.color, '#37474f'), accent = dispColor(tw.accentColor, '#263238'), trim = dispColor(tw.trimColor, '#ffffff');
        var cam = camToward();
        var flat = S.isFlat();
        // back wall: its room face points south (+y); seen from behind -> cut down
        var backCut = !flat && cam.y < -0.15 ? 22 : null;
        for (var x = 0, n = 0; x < W; x += T, n++) {
            var w = Math.min(T, W - x);
            var mesh = S.mesh('wall|back|' + w + '|' + wh + '|' + main + accent + trim, (function (w2) { return function () { return backWallModel(w2, wh, main, accent, trim); }; })(w));
            out.push({ mesh: mesh, x: x, y: wh, z: 0, turn: 0, id: idFor('wall', n, { back: true }), maxZ: backCut });
        }
        // partitions
        var interior = (officeConfig.walls && officeConfig.walls.interior) || [];
        var sel = typeof selectedWallIdx !== 'undefined' && typeof editMode !== 'undefined' && editMode ? selectedWallIdx : null;
        var k = 0;
        for (var i = 0; i < interior.length; i++) {
            var wl = interior[i];
            var c1 = dispColor(wl.color, '#546e7a'), c2 = dispColor(wl.trimColor, '#ffffff'), c3 = dispColor(wl.trim2Color, '#37474f');
            var vert = wl.x1 === wl.x2;
            var key = 'wall|part|' + (vert ? 'v' : 'h') + '|' + c1 + c2 + c3;
            var pm = S.mesh(key, (function (v, a, b, c) { return function () { return partitionModel(v, a, b, c); }; })(vert, c1, c2, c3));
            var a0 = vert ? Math.min(wl.y1, wl.y2) : Math.min(wl.x1, wl.x2), a1 = vert ? Math.max(wl.y1, wl.y2) : Math.max(wl.x1, wl.x2);
            // the part of a wall inside / behind the back wall is a pillar on its face (as the classic draws it)
            if (!vert && wl.y1 * T <= wh) continue;
            if (vert && a0 * T < wh) {
                var pk = 'wall|pillar|' + wh + '|' + c1 + c2 + c3;
                var pil = S.mesh(pk, (function (a, b, c) { return function () { return pillarModel(wh, a, b, c); }; })(c1, c2, c3));
                var ps = { mesh: pil, x: wl.x1 * T, y: wh, z: 0, turn: 0, id: idFor('wall', 1000 + (k++), { wall: wl, idx: i }), shadow: false };
                if (sel === i) { ps.tint = [255, 214, 0]; ps.tintAmt = 0.45; }
                out.push(ps);
            }
            for (var t = a0; t < a1; t++) {
                if (vert && (t + 1) * T <= wh) continue;
                var spec = { mesh: pm, x: vert ? wl.x1 * T : t * T, y: vert ? t * T : wl.y1 * T, z: 0, turn: 0, id: idFor('wall', 1000 + (k++), { wall: wl, idx: i }) };
                if (sel === i) { spec.tint = [255, 214, 0]; spec.tintAmt = 0.45; }
                out.push(spec);
            }
        }
        // the slab: the front and the two sides of the floor, under it
        if (!flat) {
            var sl = S.mesh('slab|h', function () { return slabModel(T, false); }), sv = S.mesh('slab|v', function () { return slabModel(T, true); });
            var j = 0;
            for (x = 0; x < W; x += T) {
                out.push({ mesh: sl, x: x, y: H, z: 0, turn: 0, id: idFor('slab', j++, null), shadow: false });
                out.push({ mesh: sl, x: x, y: wh - BACK_T - 4, z: 0, turn: 0, id: idFor('slab', j++, null), shadow: false });
            }
            for (var y = wh - BACK_T - 4; y < H; y += T) {
                var len = Math.min(T, H - y);
                out.push({ mesh: sv, x: 0, y: y, z: 0, turn: 0, id: idFor('slab', j++, null), shadow: false, maxZ: 0 });
                out.push({ mesh: sv, x: W + 4, y: y, z: 0, turn: 0, id: idFor('slab', j++, null), shadow: false });
                void len;
            }
        }
    };
})();
