// Sprite-stack overlay (v0.13): the classic world-space extras (desk items,
// paper planes, rock-paper-scissors, social icons, darts, pong, Office life
// props and decor) drawn over the turned diorama.
//
// Their drawing code is the classic one, written for the straight camera: a
// spot `h` px above a floor point (x, y) is drawn at (x, y - h). The overlay
// runs it against a context that re-anchors every primitive: the primitive's
// own anchor point is found in 3D (the back wall above the floor line, a
// person under it, the face of a piece of furniture it sits on, else the
// floor) and projected, and the primitive is drawn there, upright and at the
// view's scale (a billboard), so small sprites keep their pixel art.
(function () {
    'use strict';
    var S = window.VOStack = window.VOStack || {};

    function mul(m, n) {
        return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    }
    function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
    function scaleNow() { return getBaseScale() * camera.zoom; }

    // ---------- classic plane -> 3D, on furniture ----------
    // The pieces' 3D parts as the classic camera draws them (manifest
    // projection: plan [x, y, w, d], z, h, turned like the piece); a point on a
    // part's top face or front face is lifted back onto that face.
    var partCache = { sig: '', list: [] };
    function partsNow() {
        var furn = (typeof officeConfig !== 'undefined' && officeConfig.furniture) || [];
        // the layout version (bumped by the once-a-second layout check), or a cheap
        // signature while editing (pieces move between checks)
        var sig = furn.length + '|' + (typeof _staticContentVersion !== 'undefined' ? _staticContentVersion : '');
        if (typeof editMode !== 'undefined' && editMode) sig += '|' + furn.map(function (f) { return f.x + ',' + f.y + ',' + (f.rotation || 0); }).join(';');
        if (sig === partCache.sig) return partCache.list;
        var list = [];
        for (var i = 0; i < furn.length; i++) {
            var item = furn[i];
            if (item.type === 'wall' || item.type === 'door') continue;
            var key = typeof _mk === 'function' ? _mk(item) : item.type;
            var man = (typeof FURNITURE_MANIFEST !== 'undefined' && (FURNITURE_MANIFEST[key] || FURNITURE_MANIFEST[item.type])) || null;
            var parts = man && man.projection && man.projection.parts;
            if (!parts || !parts.length || man.mount === 'wall') continue;
            var pl = S.placementOf ? S.placementOf(item) : { z: 0 };
            var base = pl.surface ? pl.z || 0 : 0, ny = pl.nudge || 0;
            for (var k = 0; k < parts.length; k++) {
                var p = parts[k];
                if (!p.plan) continue;
                var r = item.rotation && typeof _projTurn === 'function' ? _projTurn(typeof _planAt === 'function' ? _planAt(p, item.rotation) : p.plan, item.rotation) : p.plan;
                var z0 = (p.z || 0) + base, top = z0 + (p.h || 0);
                list.push({ x0: item.x + r[0], x1: item.x + r[0] + r[2], y0: item.y + r[1], y1: item.y + r[1] + r[3], z0: z0, top: top, ny: ny });
            }
        }
        partCache = { sig: sig, list: list };
        return list;
    }
    S.furniturePoint = furniturePoint;
    function furniturePoint(x, y) {
        var list = partsNow(), best = null;
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            if (x < p.x0 - 1 || x > p.x1 + 1) continue;
            var cand = null;
            // matched on the classic art (drawn where the piece is saved), placed where the piece stands (+ny)
            if (y >= p.y0 - p.top - 1 && y <= p.y1 - p.top) cand = { x: x, y: y + p.top + p.ny, z: p.top, front: p.y1, face: 1 };
            else if (y > p.y1 - p.top && y <= p.y1 - p.z0) cand = { x: x, y: p.y1 + p.ny, z: p.y1 - y, front: p.y1, face: 0 };
            if (!cand) continue;
            if (!best || cand.front > best.front || (cand.front === best.front && cand.face > best.face)) best = cand;
        }
        return best;
    }

    function wallH() { return S.wallFace ? S.wallFace() : ((officeConfig && officeConfig.walls && officeConfig.walls.height) || 90); }
    // A classic-plane point -> canvas px: the wall, then a person under it
    // (signs over heads, things in hands), then furniture, then the floor.
    S.overlayPoint = function (x, y) {
        if (y >= wallH() - 2) {
            var q = S.classicToCanvas(x, y);
            if (q.__entity) return q;
            var f = furniturePoint(x, y);
            if (f) return S.project(f.x, f.y, f.z);
            return q;
        }
        return S.classicToCanvas(x, y);
    };
    // The same with furniture before people (things on desks, next to their sitters).
    S.surfacePoint = function (x, y) {
        if (y >= wallH() - 2) {
            var f = furniturePoint(x, y);
            if (f) return S.project(f.x, f.y, f.z);
        }
        return S.classicToCanvas(x, y);
    };
    // The classic once-a-second layout check (desk owners, collision grid) runs
    // in the stack frame too.
    S.houseKeeping = function (now) { if (typeof _staticHousekeeping === 'function') _staticHousekeeping(now); };

    // ---------- the re-anchoring context ----------
    S.billboardCtx = function (g, map) {
        var dpr = DPR || 1, M = [1, 0, 0, 1, 0, 0], stack = [], raw = null;
        map = map || S.overlayPoint;
        function place(x, y) {
            if (raw) { g.setTransform(raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]); return; }
            var P = apply(M, x, y), Q = map(P[0], P[1]), s = scaleNow();
            var A = mul([s, 0, 0, s, Q.x - s * P[0], Q.y - s * P[1]], M);
            g.setTransform(dpr * A[0], dpr * A[1], dpr * A[2], dpr * A[3], dpr * A[4], dpr * A[5]);
        }
        function xf(n) { if (raw) raw = mul(raw, n); else M = mul(M, n); }
        var o = {
            __billboard: true,
            save: function () { stack.push([M.slice(), raw ? raw.slice() : null]); g.save(); },
            restore: function () { var s = stack.pop(); if (s) { M = s[0]; raw = s[1]; } g.restore(); },
            translate: function (x, y) { xf([1, 0, 0, 1, x, y]); },
            scale: function (x, y) { xf([x, 0, 0, y == null ? x : y, 0, 0]); },
            rotate: function (a) { var c = Math.cos(a), s = Math.sin(a); xf([c, s, -s, c, 0, 0]); },
            transform: function (a, b, c, d, e, f) { xf([a, b, c, d, e, f]); },
            setTransform: function (a, b, c, d, e, f) {
                if (a && typeof a === 'object') raw = [a.a, a.b, a.c, a.d, a.e, a.f];
                else raw = [a, b, c, d, e, f];
            },
            resetTransform: function () { raw = [1, 0, 0, 1, 0, 0]; },
            getTransform: function () {
                if (raw) return new DOMMatrix(raw);
                var s = scaleNow() * dpr;
                return new DOMMatrix([s * M[0], s * M[1], s * M[2], s * M[3], 0, 0]);
            },
            clearRect: function () { /* never erase the diorama */ },
            putImageData: function () { /* device-pixel copies of the classic camera: skipped */ },
            fillRect: function (x, y, w, h) { place(x + w / 2, y + h / 2); g.fillRect(x, y, w, h); },
            strokeRect: function (x, y, w, h) { place(x + w / 2, y + h / 2); g.strokeRect(x, y, w, h); },
            fillText: function (t, x, y, mw) { place(x, y); if (mw == null) g.fillText(t, x, y); else g.fillText(t, x, y, mw); },
            strokeText: function (t, x, y, mw) { place(x, y); if (mw == null) g.strokeText(t, x, y); else g.strokeText(t, x, y, mw); },
            drawImage: function (img) {
                var a = Array.prototype.slice.call(arguments, 1);
                if (a.length >= 8) place(a[4] + a[6] / 2, a[5] + a[7] / 2);
                else if (a.length >= 4) place(a[0] + a[2] / 2, a[1] + a[3] / 2);
                else place(a[0] + (img && img.width || 0) / 2, a[1] + (img && img.height || 0) / 2);
                g.drawImage.apply(g, arguments);
            },
            moveTo: function (x, y) { place(x, y); g.moveTo(x, y); },
            lineTo: function (x, y) { place(x, y); g.lineTo(x, y); },
            arc: function (x, y, r, a0, a1, ccw) { place(x, y); g.arc(x, y, r, a0, a1, ccw); },
            ellipse: function (x, y, rx, ry, rot, a0, a1, ccw) { place(x, y); g.ellipse(x, y, rx, ry, rot, a0, a1, ccw); },
            rect: function (x, y, w, h) { place(x + w / 2, y + h / 2); g.rect(x, y, w, h); },
            roundRect: function (x, y, w, h, r) { place(x + w / 2, y + h / 2); g.roundRect(x, y, w, h, r); },
            quadraticCurveTo: function (cx, cy, x, y) { place(x, y); g.quadraticCurveTo(cx, cy, x, y); },
            bezierCurveTo: function (a, b, c, d, x, y) { place(x, y); g.bezierCurveTo(a, b, c, d, x, y); },
            arcTo: function (x1, y1, x2, y2, r) { place(x1, y1); g.arcTo(x1, y1, x2, y2, r); }
        };
        return new Proxy(o, {
            get: function (t, k) {
                if (k in t) return t[k];
                var v = g[k];
                return typeof v === 'function' ? v.bind(g) : v;
            },
            set: function (t, k, v) { g[k] = v; return true; }
        });
    };

    function safe(fn) { try { fn(); } catch (e) { if (!safe.warned) { safe.warned = true; console.warn('[stack] overlay', e); } } }

    // ---------- the frame's extras ----------
    // Things on desks: the owners' own desk items are 3D (stack-chars.js), so only
    // the Office life desk props are drawn here (and the desk item of an agent
    // whose desk spot has no desk piece, as the classic does).
    function deskThings() {
        var furn = officeConfig.furniture || [], owners = [];
        for (var i = 0; i < furn.length; i++) {
            if (typeof _isDeskItem === 'function' && _isDeskItem(furn[i])) owners = owners.concat(_deskOwners(furn[i]));
        }
        if (owners.length && window.VOLife && typeof window.VOLife.drawDesk === 'function') window.VOLife.drawDesk(ctx, owners);
        // (the whole office: the turned view has no classic cull rectangle)
        if (typeof _drawOrphanDeskProps === 'function') _drawOrphanDeskProps({ x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity });
    }
    function extras(c) {
        var editing = typeof editMode !== 'undefined' && editMode;
        // Office life decor (seasons, the cake, the newspaper, the bracket sheet)
        if (!editing && window.VOLife && typeof window.VOLife.drawStatic === 'function') safe(function () { window.VOLife.drawStatic(c, 'all'); });
        // things in the air and the minigames
        safe(drawAirplanes); safe(drawRPS); safe(drawSocialInteractions); safe(drawGatherings); safe(drawDartGames); safe(drawPongGames);
        if (window.VOLife && typeof window.VOLife.drawWorld === 'function') safe(function () { window.VOLife.drawWorld(c); });
    }
    S.drawWorldExtras = function (g, now) {
        g.save();
        if (S.isFlat()) {
            // the plan camera is the classic one: the classic drawing as it is
            applyCameraTransform();
            g.beginPath(); g.rect(0, 0, W, H); g.clip();
            S.withCtx(g, function () { safe(deskThings); extras(g); });
        } else {
            var D = S.billboardCtx(g, S.surfacePoint), P = S.billboardCtx(g, S.overlayPoint);
            S.withCtx(D, function () { safe(deskThings); });
            S.withCtx(P, function () { extras(P); });
        }
        g.restore();
    };

    // ---------- floor decals: the gathering circles ----------
    var decalCanvas = null, decalSig = '';
    S.decals = function (R) {
        var list = typeof groupGatherings !== 'undefined' ? groupGatherings : [], sig = '';
        for (var i = 0; i < list.length; i++) {
            var gg = list[i];
            if (gg.phase === 'socializing') sig += Math.round(gg.spot.x) + ',' + Math.round(gg.spot.y) + ',' + gg.members.length + ';';
        }
        sig += '|' + W + 'x' + H;
        if (sig === decalSig) return;
        decalSig = sig;
        if (sig.charAt(0) === '|') { R.setDecals(null); return; }
        if (!decalCanvas) decalCanvas = document.createElement('canvas');
        decalCanvas.width = Math.max(1, W); decalCanvas.height = Math.max(1, H);
        var c = decalCanvas.getContext('2d');
        c.clearRect(0, 0, W, H);
        for (i = 0; i < list.length; i++) {
            gg = list[i];
            if (gg.phase !== 'socializing') continue;
            c.globalAlpha = 0.16;
            c.fillStyle = '#ffd700';
            c.beginPath();
            c.arc(gg.spot.x, gg.spot.y, 30 + gg.members.length * 5, 0, Math.PI * 2);
            c.fill();
        }
        R.setDecals(decalCanvas);
    };
})();
