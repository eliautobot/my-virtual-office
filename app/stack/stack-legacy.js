// Fallback stacks for any piece without a hand-built model (new types, the
// desk variants): the four-view method run on the office's own art. The hull
// comes from the piece's 3D parts in FURNITURE_MANIFEST (plan, z, h); each view
// the classic art has (front 0, side 90, back 180, side 270) is painted onto the
// voxels it sees, then the colours spread to the faces no view showed. Pieces
// without parts get a lathe (round) or a card hull from the art's silhouette.
(function () {
    'use strict';
    var S = window.VOStack = window.VOStack || {};
    var C = S.color;

    var CAP = 420, CX = 210, CY = 300;   // capture canvas and where the piece's origin sits in it
    var capCanvas = null, capCtx = null;
    function noop() {}
    // Functions that draw desk chairs into the desk art: off while we capture
    // (the stack draws chairs as their own pieces).
    var CHAIR_FNS = ['_drawChairRear', '_drawSeatChair', '_drawSideChair', '_drawMeetingChairs', '_drawTuckedChair'];

    function capture(item, rot) {
        if (!capCanvas) { capCanvas = document.createElement('canvas'); capCanvas.width = CAP; capCanvas.height = CAP; capCtx = capCanvas.getContext('2d', { willReadFrequently: true }); }
        var g = capCtx;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, CAP, CAP);
        var clone = Object.assign({}, item, { x: CX, y: CY, rotation: rot });
        var saved = {};
        CHAIR_FNS.forEach(function (n) { if (typeof window[n] === 'function') { saved[n] = window[n]; window[n] = noop; } });
        var prevShadow = typeof _floorShadowOff !== 'undefined' ? _floorShadowOff : 0;
        try {
            if (typeof _floorShadowOff !== 'undefined') window._floorShadowOff = prevShadow + 1;
            S.withCtx(g, function () {
                var prevScreen = window._deskScreenOff;
                try {
                    if (clone.type === 'desk' || clone.type === 'bossDesk') { window._deskScreenOff = false; _drawDeskPiece(clone); }
                    else _drawFurnitureArt(clone, true);
                } finally { window._deskScreenOff = prevScreen; }
            });
        } catch (e) {
            console.warn('[stack] capture failed', item.type, e);
        } finally {
            if (typeof _floorShadowOff !== 'undefined') window._floorShadowOff = prevShadow;
            Object.keys(saved).forEach(function (n) { window[n] = saved[n]; });
        }
        var img = g.getImageData(0, 0, CAP, CAP);
        return { data: img.data, at: function (lx, ly) {          // RGBA at local (lx, ly) or null
            var px = Math.floor(lx) + CX, py = Math.floor(ly) + CY;
            if (px < 0 || py < 0 || px >= CAP || py >= CAP) return null;
            var o = (py * CAP + px) * 4;
            return img.data[o + 3] > 40 ? [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]] : null;
        }, bbox: bbox(img.data) };
    }
    function bbox(d) {
        var x0 = CAP, y0 = CAP, x1 = -1, y1 = -1;
        for (var y = 0; y < CAP; y++) for (var x = 0; x < CAP; x++) if (d[(y * CAP + x) * 4 + 3] > 40) {
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return x1 < 0 ? null : { x0: x0 - CX, y0: y0 - CY, x1: x1 - CX, y1: y1 - CY };
    }

    // Paint the voxels a view sees (rot: the turn the art was drawn at).
    function paintView(model, cap, rot, painted, screens) {
        if (!cap.bbox) return;
        var c = Math.round(Math.cos(rot * Math.PI / 180)), s = Math.round(Math.sin(rot * Math.PI / 180));
        var zTop = model.oz + model.h - 1;
        var b = cap.bbox;
        for (var sy = b.y0; sy <= b.y1; sy++) for (var sx = b.x0; sx <= b.x1; sx++) {
            var px = cap.at(sx, sy);
            if (!px) continue;
            // the ray: world-local (sx, sy + t) at height t, nearest first (largest t)
            for (var t = zTop; t >= model.oz; t--) {
                var wx = sx + 0.5, wy = sy + t + 0.5;
                // un-turn into model space: inverse of _rotXY
                var lx = wx * c + wy * s, ly = -wx * s + wy * c;
                var x = Math.floor(lx), y = Math.floor(ly);
                var i = model.idx(x, y, t);
                if (i < 0 || !model.v[i]) continue;
                if (!painted[i]) {
                    var mat = screens && screens(sx, sy, rot) ? S.MAT.SCREEN : (model.v[i] >>> 24);
                    model.v[i] = C.pack([px[0], px[1], px[2]], mat);
                    painted[i] = 1;
                }
                break;
            }
        }
    }
    // Colours of painted voxels spread to unpainted ones (the faces no view saw).
    function spread(model, painted) {
        var w = model.w, d = model.d, h = model.h, n = w * d * h, q = [], i;
        for (i = 0; i < n; i++) if (painted[i] && model.v[i]) q.push(i);
        if (!q.length) return;
        var head = 0;
        while (head < q.length) {
            var cur = q[head++], x = cur % w, y = ((cur / w) | 0) % d, z = (cur / (w * d)) | 0;
            var nb = [x > 0 ? cur - 1 : -1, x < w - 1 ? cur + 1 : -1, y > 0 ? cur - w : -1, y < d - 1 ? cur + w : -1, z > 0 ? cur - w * d : -1, z < h - 1 ? cur + w * d : -1];
            for (var k = 0; k < 6; k++) {
                var j = nb[k];
                if (j < 0 || painted[j] || !model.v[j]) continue;
                var v = model.v[cur], mat = (model.v[j] >>> 24) === S.MAT.SCREEN ? S.MAT.SOLID : (v >>> 24) === S.MAT.SCREEN ? S.MAT.SOLID : (v >>> 24);
                // sides and backs a touch darker than the face they came from
                var rgb = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];
                model.v[j] = C.pack(k >= 4 ? rgb : C.tone(rgb, 0.97), mat);
                painted[j] = 1;
                q.push(j);
            }
        }
    }

    // The piece's hull from its manifest parts (unturned plans).
    function hullFromParts(parts, m) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = 1;
        parts.forEach(function (p) {
            var r = p.plan; x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]);
            z1 = Math.max(z1, (p.z || 0) + (p.h || 1) + (p.cap ? 0 : 0));
        });
        var model = S.model(x0 - 1, y0 - 1, x1 + 1, y1 + 1, z1 + 2, 0);
        var grey = '#9e9e9e';
        parts.forEach(function (p) {
            var r = p.plan, z = p.z || 0, h = Math.max(1, p.h || 1);
            if (p.flat) { model.box(r[0], r[1], z, r[2], r[3], Math.max(1, h || 1), grey); return; }
            if (p.open) {
                // legs at the corners of the plan (a cabinet: walls round a knee hole)
                var L = 3;
                [[r[0], r[1]], [r[0] + r[2] - L, r[1]], [r[0], r[1] + r[3] - L], [r[0] + r[2] - L, r[1] + r[3] - L]].forEach(function (q) { model.box(q[0], q[1], z, L, L, h, grey); });
                return;
            }
            model.box(r[0], r[1], z, r[2], Math.max(1, r[3]), h, grey);
        });
        return model;
    }
    // A round hull turned from the art's silhouette rows (plants, bins, lamps).
    function hullLathe(cap, depthMax) {
        var b = cap.bbox, rows = [];
        for (var sy = b.y0; sy <= b.y1; sy++) {
            var a = Infinity, z = -Infinity;
            for (var sx = b.x0; sx <= b.x1; sx++) if (cap.at(sx, sy)) { if (sx < a) a = sx; z = sx; }
            rows.push(a <= z ? [a, z] : null);
        }
        var height = b.y1 - b.y0 + 1, width = b.x1 - b.x0 + 1;
        var rMax = Math.min(depthMax || 99, width / 2);
        var model = S.model(b.x0 - 1, -rMax - 2, b.x1 + 2, rMax + 2, height + 1, 0);
        for (var k = 0; k < rows.length; k++) {
            var row = rows[k];
            if (!row) continue;
            var z0 = b.y1 - (b.y0 + k);            // the art's bottom row is the floor
            var cx = (row[0] + row[1] + 1) / 2, rx = (row[1] - row[0] + 1) / 2, ry = Math.min(rx, rMax);
            model.cyl(cx, 0, z0, Math.max(0.6, rx), Math.max(0.6, ry), 1, '#9e9e9e');
        }
        return { model: model, base: b.y1 };
    }

    // Wall-mounted pieces: a 2-3 voxel deep relief of the art (local z = -art y).
    function wallRelief(cap, depth) {
        var b = cap.bbox;
        var model = S.model(b.x0, 0, b.x1 + 1, depth, -b.y0 + 1, -b.y1);
        for (var sy = b.y0; sy <= b.y1; sy++) for (var sx = b.x0; sx <= b.x1; sx++) {
            var px = cap.at(sx, sy);
            if (!px) continue;
            for (var k = 0; k < depth; k++) model.set(sx, k, -sy, k === depth - 1 ? [px[0], px[1], px[2]] : C.tone([px[0], px[1], px[2]], 0.8));
        }
        return model;
    }

    S.legacyModel = function (item) {
        var key = typeof _mk === 'function' ? _mk(item) : item.type;
        var m = (typeof FURNITURE_MANIFEST !== 'undefined' && (FURNITURE_MANIFEST[key] || FURNITURE_MANIFEST[item.type])) || {};
        var P = m.projection || {};
        var mount = m.mount;
        var cap0 = capture(item, 0);
        if (!cap0.bbox) return null;
        if (mount === 'wall' || item.type === 'textLabel' || item.type === 'branchSign') {
            if (item.type === 'textLabel' || item.type === 'branchSign') {
                var wh = (officeConfig.walls && officeConfig.walls.height) || 90;
                if (item.y >= wh - 4) {
                    // a floor label: the art laid flat, one voxel thick
                    var bb = cap0.bbox, fm = S.model(bb.x0, bb.y0, bb.x1 + 1, bb.y1 + 1, 1, 0);
                    for (var yy = bb.y0; yy <= bb.y1; yy++) for (var xx = bb.x0; xx <= bb.x1; xx++) { var q = cap0.at(xx, yy); if (q) fm.set(xx, yy, 0, [q[0], q[1], q[2]]); }
                    return fm;
                }
            }
            return wallRelief(cap0, 2);
        }
        var parts = (P.parts || []).filter(function (p) { return !p.seat; });
        var model, painted;
        if (parts.length) {
            model = hullFromParts(parts, m);
        } else {
            var big = (cap0.bbox.x1 - cap0.bbox.x0) > 90;
            if (big) {
                // a legacy composite (lounge, break area): a low relief card standing on its base line
                model = S.model(cap0.bbox.x0, cap0.bbox.y1 - 10, cap0.bbox.x1 + 1, cap0.bbox.y1 + 1, cap0.bbox.y1 - cap0.bbox.y0 + 2, 0);
                for (var y2 = cap0.bbox.y0; y2 <= cap0.bbox.y1; y2++) for (var x2 = cap0.bbox.x0; x2 <= cap0.bbox.x1; x2++) {
                    if (!cap0.at(x2, y2)) continue;
                    model.box(x2, cap0.bbox.y1 - 6, cap0.bbox.y1 - y2, 1, 6, 1, '#9e9e9e');
                }
            } else {
                var lt = hullLathe(cap0, 12);
                model = lt.model;
                // the lathe stands at the art's base line: shift so its centre is there
                var shifted = S.model(model.ox, model.oy + lt.base, model.ox + model.w, model.oy + lt.base + model.d, model.h, 0);
                shifted.put(model, 0, lt.base, 0, 0);
                model = shifted;
            }
        }
        painted = new Uint8Array(model.v.length);
        var mons = (m.monitors || []);
        var screens = mons.length ? function (sx, sy, rot) {
            if (rot) return false;
            for (var i = 0; i < mons.length; i++) { var r = mons[i]; if (sx >= r.x && sx < r.x + r.w && sy >= r.y && sy < r.y + r.h) return true; }
            return false;
        } : null;
        paintView(model, cap0, 0, painted, screens);
        if (m.rotatable && P.views) {
            [90, 270, 180].forEach(function (r) {
                if (!P.views[r]) return;
                var cap = capture(item, r);
                paintView(model, cap, r, painted, null);
            });
        }
        spread(model, painted);
        // never-painted voxels (hidden inside): plain grey stays, which no view shows
        return model;
    };
})();
