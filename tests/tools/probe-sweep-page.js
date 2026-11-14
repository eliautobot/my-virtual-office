// PROBE SWEEP, the in-page half (tests/tools/probe-sweep.mjs injects it; v0.10.1, review 11-07). Needs ?debug=probe.
// A case = a layout (one piece type x rotation alone, a wall kind, or a live layout window). Samples: the edge of
// the rule-allowed standing region (the closest a person may stand, every side, gaps included), the probe walked by
// the planner past / round / through, every seat, every use spot, held / carried items. Each sample is rendered
// through the real frame (simulation stopped) and scored from the pixels: the probe alone (its body mask), the
// frame without it (what is visible), each piece alone (its art) and the walls (frame without them):
//   side            body and a piece's art overlap while the feet are beside that part (neither in front nor behind)
//   hidden-front    a part drawn over a person standing in front of it (wrong layering vs the 3D boxes)
//   over-behind     a person drawn over a part they stand behind (wrong layering)
//   face            art over the head (a piece / a wall / a chair in front of the face)
//   art-out         art drawn outside every part box of its piece (the model does not know it; a note: x 0.1)
//   wall-behind     body over / under a wall's face or top while behind it (feet on the wall top, ghost legs)
//   wall-trim       shoes on a wall's face or the back wall's trim
//   wall-side       body overlapping a vertical wall's strip beside it
//   inside          standing feet inside a footprint
//   seat-hidden     seated: the upper body less than 85 % in view
// Severity = world px^2 of offending pixels (face: % of the head x 0.6). Nothing is written anywhere.
(function() {
    'use strict';
    var PS = window.__ps = {};
    var Tn = performance.now() + 1e7;
    var oc = document.createElement('canvas'), octx = oc.getContext('2d', { willReadFrequently: true });
    var main = canvas.getContext('2d', { willReadFrequently: true });
    var C = null;  // the current case
    window._runSimulation = function() { return 0; };
    _timeOverride = 12;
    window.__voWorldCheck = null;

    function render() { _sceneDirty = true; _renderFrame(Tn += 50); }
    function probe() { return VOProbe.agent(); }
    function away() { var a = probe(); a.isSitting = false; a.x = a.targetX = a._prevTargetX = -2000; a.y = a.targetY = a._prevTargetY = -2000; a._path = null; }
    function setLayout(furniture, interior) {
        officeConfig.furniture = furniture.map(function(o) { return Object.assign({}, o); });
        officeConfig.walls.interior = (interior || []).map(function(o) { return Object.assign({}, o); });
        getInteractionSpots(); buildCollisionGrid();
        if (typeof _invalidateStaticLayer === 'function') _invalidateStaticLayer();
    }
    function alone(fn) {
        if (oc.width !== canvas.width || oc.height !== canvas.height) { oc.width = canvas.width; oc.height = canvas.height; }
        var saved = ctx;
        ctx = octx;
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, oc.width, oc.height);
            ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.save(); applyCameraTransform();
            fn();
            ctx.restore();
        } finally { ctx = saved; ctx.setTransform(DPR, 0, 0, DPR, 0, 0); }
    }
    function full(c2d) { return c2d.getImageData(0, 0, canvas.width, canvas.height).data; }
    function wallsOf(interior) {
        return (interior || []).map(function(wl) {
            var X1 = Math.min(wl.x1, wl.x2) * TILE, X2 = Math.max(wl.x1, wl.x2) * TILE, Y1 = Math.min(wl.y1, wl.y2) * TILE, Y2 = Math.max(wl.y1, wl.y2) * TILE;
            return X1 === X2 ? { v: true, x: X1, y1: Y1, y2: Y2 } : { v: false, y: Y1, x1: X1, x2: X2 };
        });
    }

    // spec: {name, furniture, interior, win: {x, y, w, h} world rect, walks: n (planner walks), only: [ids] (pieces
    // whose art is scored; default all)}
    PS.setup = function(spec) {
        VOProbe.ghost(true); away();
        setLayout(spec.furniture, spec.interior);
        VOProbe.frame(spec.win);
        render(); render();
        var o = _cameraOrigin(), k = o.s * (DPR || 1);
        var B = full(main), wm = null;
        if ((spec.interior || []).length) {
            setLayout(spec.furniture, []); render();
            var B0 = full(main);
            wm = new Uint8Array(canvas.width * canvas.height);
            for (var i = 0, n = wm.length; i < n; i++) {
                var j = i * 4;
                if (Math.abs(B[j] - B0[j]) + Math.abs(B[j + 1] - B0[j + 1]) + Math.abs(B[j + 2] - B0[j + 2]) > 60) wm[i] = 1;
            }
            setLayout(spec.furniture, spec.interior); render(); render();
            B = full(main);
        }
        // each floor piece alone (its art: alpha >= 200, no drop shadow), kept as a bounding-box alpha patch
        var arts = [];
        officeConfig.furniture.forEach(function(it) {
            if (WALL_ITEM_TYPES[it.type] || (spec.only && spec.only.indexOf(it.id) < 0)) return;
            // the static art and the live art, each drawn once (two draws of translucent glass would stack its alpha)
            alone(function() { drawFurnitureItem(it, { staticOnly: true }); });
            var d = full(octx);
            alone(function() { drawFurnitureItem(it); });
            var d2 = full(octx);
            for (var di = 3; di < d.length; di += 4) if (d2[di] > d[di]) d[di] = d2[di];
            var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, Wc = canvas.width;
            for (var p = 3, q = 0; p < d.length; p += 4, q++) if (d[p] >= 200) { var px = q % Wc, py = (q - px) / Wc; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
            if (x1 < 0) return;
            var w = x1 - x0 + 1, h = y1 - y0 + 1, m = new Uint8Array(w * h);
            for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) if (d[((y0 + yy) * Wc + x0 + xx) * 4 + 3] >= 200) m[yy * w + xx] = 1;
            var fps = _itemFootprints(it), fy0 = 1e9, fy1 = -1e9;
            fps.forEach(function(r) { fy0 = Math.min(fy0, r.y); fy1 = Math.max(fy1, r.y + r.h); });
            arts.push({ it: it, x0: x0, y0: y0, w: w, h: h, m: m, boxes: _clrArtBoxes(it), fy0: fy0, fy1: fy1, flat: !_clrArtBoxes(it).length && !fps.length });
        });
        C = { spec: spec, o: o, k: k, B: B, wm: wm, arts: arts, walls: wallsOf(spec.interior), wallH: (officeConfig.walls && officeConfig.walls.height) || 0 };
        return { arts: arts.length, k: Math.round(k * 100) / 100, wall: !!wm };
    };

    // a standing person may rest at (x, y): free floor, no band; a meeting chair's stop point is a seat (drawn seated)
    function allowed(x, y) {
        if (!_worldFloorOk(x, y) || _clrAt(x, y, CLR.tol)) return false;
        var sp = _clrSpotNear(x, y);
        return !(sp && sp.held && Math.abs(sp.x - x) <= 1 && Math.abs(sp.y - y) <= 1);
    }
    function nearArt(x, y, pad) {
        // the body rect (feet +-26, 66 up) near any art patch or wall (screen space via world coords)
        var o = C.o, k = C.k, cx0 = (o.x + (x - 26 - pad) * o.s) * DPR, cx1 = (o.x + (x + 26 + pad) * o.s) * DPR, cy0 = (o.y + (y - 66 - pad) * o.s) * DPR, cy1 = (o.y + (y + 8 + pad) * o.s) * DPR;
        for (var i = 0; i < C.arts.length; i++) { var a = C.arts[i]; if (a.x0 < cx1 && a.x0 + a.w > cx0 && a.y0 < cy1 && a.y0 + a.h > cy0) return true; }
        for (var j = 0; j < C.walls.length; j++) {
            var wl = C.walls[j];
            if (wl.v ? (Math.abs(x - wl.x) < 26 + pad + 4 && y > wl.y1 - 50 - pad && y < wl.y2 + 70 + pad) : (x > wl.x1 - 30 - pad && x < wl.x2 + 30 + pad && y > wl.y - 60 - pad && y < wl.y + 75 + pad)) return true;
        }
        return y < C.wallH + 30 + pad;  // the back wall
    }
    // Samples of the case: rest (edge of the allowed region, use spots), walks (planner), seats.
    PS.samples = function(opt) {
        opt = opt || {};
        var win = C.spec.win, out = [], step = 2, sp = opt.spacing || 6, seen = {};
        var keep = function(s, cell) { var key = Math.round(s.x / cell) + ',' + Math.round(s.y / cell) + ',' + s.view + ',' + (s.walk ? 1 : 0); if (seen[key]) return false; seen[key] = 1; out.push(s); return true; };
        // 1 rest: allowed points with a disallowed neighbour (2 px lattice) inside the window
        var x0 = Math.ceil(win.x / 2) * 2 + 8, x1 = win.x + win.w - 8, y0 = Math.ceil(win.y / 2) * 2 + 8, y1 = win.y + win.h - 8, n = 0;
        var ok = {}, A = function(x, y) { var key = x + ',' + y; if (ok[key] === undefined) ok[key] = (x < x0 || x > x1 || y < y0 || y > y1) ? 1 : (allowed(x, y) ? 1 : 0); return ok[key]; };
        for (var y = y0; y <= y1; y += step) for (var x = x0; x <= x1; x += step) {
            if (!A(x, y) || (A(x - step, y) && A(x + step, y) && A(x, y - step) && A(x, y + step))) continue;
            if (!nearArt(x, y, 4)) continue;
            n++;
            var view = n % 7 === 3 ? 'left' : n % 7 === 5 ? 'right' : 'down';
            keep({ x: x, y: y, view: view, kind: 'rest', pose: n % 4 === 1 ? 'held' : null }, sp);
        }
        // 2 use spots (stand spots of the case's pieces, seat floor points): facing the piece and the room
        _clrIndex().spots.forEach(function(s) {
            if (s.x < win.x || s.x > win.x + win.w || s.y < win.y || s.y > win.y + win.h) return;
            if (s.held || _clrAt(s.x, s.y, CLR.tol)) return;  // a spot the layout made unusable: goals snap clear of it
            keep({ x: s.x, y: s.y, view: 'down', kind: 'spot' }, 1); keep({ x: s.x, y: s.y, view: 'up', kind: 'spot' }, 1);
        });
        // 3 seats (ghost sit): desk seats at work and idle
        VOProbe.seats().forEach(function(s, i) {
            if (s.x < win.x || s.x > win.x + win.w || s.y < win.y || s.y > win.y + win.h) return;
            out.push({ x: s.x, y: s.y, seat: i, kind: 'seat', view: null, pose: 'stand' });
            if (/desk/i.test(s.kind)) out.push({ x: s.x, y: s.y, seat: i, kind: 'seat', view: null, pose: 'work' });
        });
        // 4 planner walks: between points round the window (opposite + quarter), the probe obeying the rules
        var nw = opt.walks == null ? 16 : opt.walks, cx = win.x + win.w / 2, cy = win.y + win.h / 2, R = Math.min(win.w, win.h) / 2 - 14, ring = [];
        for (var i = 0; i < 8; i++) {
            var q = _worldNearestFree(cx + Math.cos(i * Math.PI / 4) * R, cy + Math.sin(i * Math.PI / 4) * R, 60);
            if (q && !_clrAt(q.x, q.y)) ring.push(q);
        }
        var pairs = [];
        for (var a = 0; a < ring.length; a++) { pairs.push([a, (a + 4) % ring.length]); pairs.push([a, (a + 2) % ring.length]); }
        (opt.extraWalks || []).forEach(function(w) { pairs.push([{ x: w[0], y: w[1] }, { x: w[2], y: w[3] }]); });
        var P = probe(), wn = 0;
        VOProbe.ghost(false);
        pairs.slice(0, nw + (opt.extraWalks || []).length).forEach(function(pr) {
            var s0 = typeof pr[0] === 'number' ? ring[pr[0]] : pr[0], s1 = typeof pr[1] === 'number' ? ring[pr[1]] : pr[1];
            if (!s0 || !s1 || s0 === s1) return;
            VOProbe.place(s0.x, s0.y, { view: null }); VOProbe.moveTo(s1.x, s1.y);
            var lx = P.x, ly = P.y, carry = (wn++ % 3 === 2) ? 'coffee' : null;
            for (var t = 0; t < 900; t++) {
                _simulationStep();
                if (P.x === P.targetX && P.y === P.targetY && !(P._path && P._path.length)) break;
                var dx = P.x - lx, dy = P.y - ly, d = Math.hypot(dx, dy);
                if (d < 1.5) continue;
                var view = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
                lx = P.x; ly = P.y;
                if (nearArt(P.x, P.y, 2)) keep({ x: Math.round(P.x * 2) / 2, y: Math.round(P.y * 2) / 2, view: view, walk: true, kind: 'walk', carry: carry }, sp);
            }
        });
        VOProbe.ghost(true); away();
        return out;
    };

    function pose(s) {
        var P = probe();
        VOProbe.ghost(true); VOProbe.stand(); VOProbe.carry(s.carry || null); VOProbe.pose(s.pose || 'stand');
        if (s.seat != null) { VOProbe.place(s.x, s.y, { view: null }); VOProbe.sit(s.seat); VOProbe.pose(s.pose || 'stand'); P.tick = 0; P._seatT = 1; P._seatFrom = null; }
        else { VOProbe.place(s.x, s.y, { view: s.view, walk: !!s.walk }); P.tick = s.walk ? 8 : 0; }
        P._focusPulseUntil = 0;
        // Eyes open in every sample: the blink is random (Agent.update) and the planner walks (PS.samples) leave it
        // wherever the page's random sequence put it; that sequence starts at a different point in every page (real
        // frames before the scorer loads), so a blink frozen mid-way made one face score differ between two pages.
        P.blinkTimer = 0;
    }
    // The probe drawn alone exactly as the frame draws it: the frame puts people on whole world pixels
    // (_drawDepthEntity, A4); drawn at its raw x, y a sample at a half pixel is off by half a world pixel and the
    // edges of its features (an open eye over a white fridge) read as hidden.
    function drawProbe(P) { if (typeof _drawDepthEntity === 'function') _drawDepthEntity(P); else P.draw(); }
    // Score one sample from the pixels (see the header). Returns {score, tags: {tag|type/part: area}, face, vis}.
    PS.score = function(s) {
        pose(s); render();
        var P = probe(), o = C.o, k = C.k, dpr = DPR || 1, Wc = canvas.width, Hc = canvas.height;
        alone(function() { drawProbe(P); });
        var cx0 = Math.max(0, Math.floor((o.x + (s.x - 32) * o.s) * dpr)), cy0 = Math.max(0, Math.floor((o.y + (s.y - 70) * o.s) * dpr));
        var cw = Math.min(Wc - cx0, Math.ceil(64 * k)), ch = Math.min(Hc - cy0, Math.ceil(80 * k));
        if (cw <= 0 || ch <= 0) return null;
        var A = main.getImageData(cx0, cy0, cw, ch).data, Pd = octx.getImageData(cx0, cy0, cw, ch).data, B = C.B, wm = C.wm;
        var top = 1e9, bot = -1e9, nP = 0, cut = false;
        for (var r = 0; r < ch; r++) for (var c = 0; c < cw; c++) if (Pd[(r * cw + c) * 4 + 3] >= 160) { var wy0 = ((cy0 + r) / dpr - o.y) / o.s; if (wy0 < top) top = wy0; if (wy0 > bot) bot = wy0; nP++;
            if (cx0 + c === 0 || cx0 + c === Wc - 1 || cy0 + r === 0 || cy0 + r === Hc - 1) cut = true; }
        if (!nP) return { score: 0, tags: {}, empty: true };
        // offending pixels per tag; counted after an erosion by ~1 world px (seams on a box edge are not defects)
        var tags = {}, pix = {}, cur = 0, add = function(key) { (pix[key] || (pix[key] = new Set())).add(cur); };
        // seated: in a seat, or standing within 3 px of a meeting chair's stop point (drawn seated there)
        var px2 = 1 / (k * k), headN = 0, headHid = 0, upN = 0, upVis = 0, seated = s.seat != null || (!s.walk && !!_meetingSeatAt(s.x, s.y));
        var upperY = top + (bot - top) * 0.45, feetY = s.y, x = s.x;
        for (var r2 = 0; r2 < ch; r2++) {
            var gy = cy0 + r2, wy = ((gy + 0.5) / dpr - o.y) / o.s, head = wy <= top + 13, shoe = wy >= feetY - 6;
            for (var c2 = 0; c2 < cw; c2++) {
                var i4 = (r2 * cw + c2) * 4;
                if (Pd[i4 + 3] < 160) continue;
                cur = r2 * cw + c2;
                var gx = cx0 + c2, g4 = (gy * Wc + gx) * 4, wx = ((gx + 0.5) / dpr - o.x) / o.s;
                // visible: the frame shows the probe's own colour there, or differs from the frame without it
                var vis = Math.abs(A[i4] - Pd[i4]) + Math.abs(A[i4 + 1] - Pd[i4 + 1]) + Math.abs(A[i4 + 2] - Pd[i4 + 2]) < 12 ||
                    Math.abs(A[i4] - B[g4]) + Math.abs(A[i4 + 1] - B[g4 + 1]) + Math.abs(A[i4 + 2] - B[g4 + 2]) > 36;
                if (head) { headN++; }
                if (wy <= upperY) { upN++; if (vis) upVis++; }
                var covered = false;
                for (var ai = 0; ai < C.arts.length; ai++) {
                    var a = C.arts[ai], lx = gx - a.x0, ly = gy - a.y0;
                    if (lx < 0 || ly < 0 || lx >= a.w || ly >= a.h || !a.m[ly * a.w + lx]) continue;
                    var part = null;
                    // the part drawn at this pixel: of the boxes whose drawn rect holds it, the southernmost (frontmost)
                    for (var bi = 0; bi < a.boxes.length; bi++) { var b = a.boxes[bi]; if (wx >= b.x && wx <= b.x + b.w && wy >= b.y - b.z - b.h && wy <= b.y + b.d - b.z && (!part || b.y + b.d > part.y + part.d)) part = b; }
                    var by0 = part ? part.y : a.fy0, by1 = part ? part.y + part.d : a.fy1, nm = a.it.type + '/' + (part ? (part.part || 'box') : 'art');
                    var rel = feetY >= by1 ? 'front' : (feetY + VOL.fore <= by0 - 2 ? 'behind' : 'beside');
                    if (!vis) covered = true;
                    if (seated) continue;  // seated: the face and the upper body in view (below)
                    if (!part && a.boxes.length) add('art-out|' + nm);
                    if (PS.trace && (rel !== 'front' || !vis) && (rel !== 'behind' || vis)) PS.trace.push([Math.round(wx * 2) / 2, Math.round(wy * 2) / 2, rel[0], vis ? 1 : 0, a.boxes.indexOf(part)]);
                    if (rel === 'beside') add('side|' + nm);
                    else if (rel === 'front' && !vis) add('hidden-front|' + nm);
                    else if (rel === 'behind' && vis) add('over-behind|' + nm);
                }
                if (wm && wm[gy * Wc + gx]) {
                    for (var wi = 0; wi < C.walls.length; wi++) {
                        var wl = C.walls[wi];
                        if (wl.v) {
                            if (!(wx >= wl.x - 6 && wx <= wl.x + 6 && wy >= wl.y1 - 45 && wy <= wl.y2 + 4)) continue;
                            if (feetY < wl.y2) { add('wall-side|v'); if (!vis) covered = true; if (PS.trace) PS.trace.push([Math.round(wx * 2) / 2, Math.round(wy * 2) / 2, 'w', vis ? 1 : 0, -1]); }
                            else if (!vis) { add('hidden-front|wall'); covered = true; }
                        } else {
                            if (!(wx >= wl.x1 - 4 && wx <= wl.x2 + 4 && wy >= wl.y - 45 && wy <= wl.y + 5)) continue;
                            if (feetY < wl.y) { add('wall-behind|h'); if (!vis) covered = true; }
                            else if (shoe) add('wall-trim|h');
                            else if (!vis) { add('hidden-front|wall'); covered = true; }
                        }
                        break;
                    }
                }
                if (!seated && shoe && wy < C.wallH + 1 && vis) add('wall-trim|top');
                if (head && covered) headHid++;
            }
        }
        var er = Math.max(1, Math.round(k * 0.9));
        Object.keys(pix).forEach(function(key) {
            var set = pix[key], n = 0;
            set.forEach(function(i) { if (set.has(i - er) && set.has(i + er) && set.has(i - er * cw) && set.has(i + er * cw)) n++; });
            if (n) tags[key] = n * px2;
        });
        var face = headN ? headHid / headN : 0, score = 0;
        // a person cut by the canvas edge has no measurable face: the ratio would be over the on-canvas sliver only
        if (face > 0.15 && !cut) tags['face|' + (seated ? 'seated' : 'standing')] = Math.round(face * 100);
        if (seated && upN && upVis / upN < 0.85) tags['seat-hidden|' + (s.seat != null ? (_worldSeats()[s.seat] || { kind: '?' }).kind : 'meeting stop')] = Math.round((0.85 - upVis / upN) * 100);
        var fin = !seated && _feetIn(x, feetY);
        if (fin && !(s.kind === 'spot' && _worldSeats().some(function(t) { return t.item === fin.item && Math.abs(t.fx - x) <= 1 && Math.abs(t.fy - feetY) <= 1; }))) tags['inside|' + fin.item.type] = 50;
        Object.keys(tags).forEach(function(key) {
            if (tags[key] < 3 && !/^face|^seat|^inside/.test(key)) { delete tags[key]; return; }
            tags[key] = Math.round(tags[key] * 10) / 10;
            score += /^face/.test(key) ? tags[key] * 0.6 : /^art-out/.test(key) ? tags[key] * 0.1 : tags[key];
        });
        return { score: Math.round(score * 10) / 10, tags: tags, face: Math.round(face * 100), cut: cut };  // cut: the person touches the canvas edge
    };
    // A picture of a sample: the frame round it at `zoom`, as a PNG data URL (w x h canvas px).
    PS.shot = function(s, w, h, zoom) {
        pose(s);
        camera.zoom = zoom; camera.x = s.x - W / 2; camera.y = s.y - 28 - H / 2;
        if (typeof _invalidateStaticLayer === 'function') _invalidateStaticLayer();
        render(); render();
        var o = _cameraOrigin(), dpr = DPR || 1, cx = Math.round((o.x + s.x * o.s) * dpr - w / 2), cy = Math.round((o.y + (s.y - 28) * o.s) * dpr - h / 2);
        var img = main.getImageData(Math.max(0, cx), Math.max(0, cy), w, h), c2 = document.createElement('canvas');
        c2.width = w; c2.height = h; c2.getContext('2d').putImageData(img, 0, 0);
        VOProbe.frame(C.spec.win); render();
        C.o = _cameraOrigin();
        return c2.toDataURL('image/png');
    };
    // The plan + drawn extent of a furniture list (footprints and art boxes' screen rects).
    function extents(list) {
        var e = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
        list.forEach(function(it) {
            _itemFootprints(it).forEach(function(r) { e.x0 = Math.min(e.x0, r.x); e.x1 = Math.max(e.x1, r.x + r.w); e.y0 = Math.min(e.y0, r.y); e.y1 = Math.max(e.y1, r.y + r.h); });
            _clrArtBoxes(it).forEach(function(b) { e.x0 = Math.min(e.x0, b.x); e.x1 = Math.max(e.x1, b.x + b.w); e.y0 = Math.min(e.y0, b.y - b.z - b.h); e.y1 = Math.max(e.y1, b.y + b.d); });
        });
        return e;
    }
    // Gallery: every floor furniture type x rotation alone (a counter appliance on a counter); gap = two of a type
    // side by side, a body + both margins + `gap` apart, walked through north-south.
    PS.galleryCases = function(filter, gaps) {
        // (the v0.9 composites 'lounge' / 'breakArea' become catalog pieces on load: _migrateLegacyFurniture)
        var types = Object.keys(FURNITURE_MANIFEST).filter(function(t) { return t !== '_unknown' && t !== 'lounge' && t !== 'breakArea' && FURNITURE_MANIFEST[t].mount !== 'wall' && (!filter || filter.indexOf(t) >= 0); });
        var out = [];
        types.forEach(function(type) {
            var M = FURNITURE_MANIFEST[type];
            (gaps ? [0] : (M.rotatable ? [0, 90, 180, 270] : [0])).forEach(function(rot) {
                var it = { id: 'p', type: type, x: 560, y: 430, rotation: rot }, list = [it];
                if (M.mount === 'surface') { var counter = { id: 'k', type: 'kitchenCounter', x: 520, y: 430 }; it.x = 530; it.y = counter.y - M.bounds.h + 2; list = [counter, it]; }
                setLayout(list, []);
                var e = extents(officeConfig.furniture), walks = [];
                if (gaps) {
                    if (M.mount === 'surface' || !_itemFootprints(officeConfig.furniture[0]).length) return;
                    var g = 2 * (CLR.bodyW + CLR.fp) + gaps, w0 = e.x1 - e.x0, sh = Math.round(W / 2 - (e.x0 + w0 + g / 2));
                    it.x += sh; var it2 = Object.assign({}, it, { id: 'p2', x: it.x + w0 + g });
                    list = [it, it2]; setLayout(list, []); e = extents(officeConfig.furniture);
                    var gx = it.x + (e.x0 - it.x) + w0 + g / 2;
                    walks.push([gx, e.y0 - 70, gx, e.y1 + 50], [gx, e.y1 + 50, gx, e.y0 - 70]);
                }
                out.push({ name: (gaps ? 'gap' + gaps + ' ' : '') + type + '/' + rot, furniture: list, interior: [], extraWalks: walks,
                    win: { x: Math.round(e.x0 - 90), y: Math.round(e.y0 - 100), w: Math.round(e.x1 - e.x0 + 180), h: Math.round(e.y1 - e.y0 + 190) } });
            });
        });
        return out;
    };
    // Live windows: the whole layout, tiled; walks along both sides of every wall in the window + the ring.
    PS.liveCases = function(tw, th) {
        var list = officeConfig.furniture.slice(), interior = (officeConfig.walls.interior || []).slice(), out = [], walls = wallsOf(interior);
        for (var y = 0; y < H; y += th - 60) for (var x = 0; x < W; x += tw - 60) {
            var win = { x: x, y: y, w: Math.min(tw, W - x), h: Math.min(th, H - y) }, walks = [];
            if (win.w < 120 || win.h < 120) continue;
            walls.forEach(function(wl) {
                var inWin = wl.v ? (wl.x > win.x && wl.x < win.x + win.w && wl.y2 > win.y && wl.y1 < win.y + win.h) : (wl.y > win.y && wl.y < win.y + win.h && wl.x2 > win.x && wl.x1 < win.x + win.w);
                if (!inWin) return;
                [-30, 30, -60, 60].forEach(function(off) {
                    if (wl.v) walks.push([wl.x + off, Math.max(win.y + 10, wl.y1 - 20), wl.x + off, Math.min(win.y + win.h - 10, wl.y2 + 20)]);
                    else walks.push([Math.max(win.x + 10, wl.x1 - 20), wl.y + off, Math.min(win.x + win.w - 10, wl.x2 + 20), wl.y + off]);
                });
            });
            out.push({ name: 'live ' + x + ',' + y, furniture: list, interior: interior, win: win, extraWalks: walks.map(function(w) {
                var a = _worldNearestFree(w[0], w[1], 40), b = _worldNearestFree(w[2], w[3], 40);
                return a && b && !_clrAt(a.x, a.y) && !_clrAt(b.x, b.y) ? [a.x, a.y, b.x, b.y] : null;  // from / to clear floor
            }).filter(Boolean) });
        }
        return out;
    };
    PS.layout = function() { return { furniture: officeConfig.furniture.slice(), interior: (officeConfig.walls.interior || []).slice(), W: W, H: H }; };
    // A contact sheet: tiles [{url, label, bad}] in `cols` columns of w x h, labels under each; JPEG data URL.
    PS.sheet = async function(tiles, cols, w, h, title) {
        var lh = 30, th = title ? 34 : 0, rows = Math.ceil(tiles.length / cols), c = document.createElement('canvas');
        c.width = cols * w; c.height = th + rows * (h + lh);
        var g = c.getContext('2d');
        g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
        if (title) { g.fillStyle = '#fff'; g.font = 'bold 18px sans-serif'; g.fillText(title, 10, 24); }
        for (var i = 0; i < tiles.length; i++) {
            var t = tiles[i], img = new Image();
            await new Promise(function(res) { img.onload = res; img.onerror = res; img.src = t.url; });
            var x = (i % cols) * w, y = th + Math.floor(i / cols) * (h + lh);
            g.drawImage(img, x, y, w, h);
            g.strokeStyle = t.bad ? '#e53935' : '#43a047'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, w - 2, h + lh - 2);
            g.fillStyle = '#eee'; g.font = '11px monospace';
            String(t.label || '').split('\n').slice(0, 2).forEach(function(line, j) { g.fillText(line.slice(0, Math.floor(w / 6.6)), x + 4, y + h + 12 + j * 13); });
        }
        return c.toDataURL('image/jpeg', 0.86);
    };
    PS.ready = true;
})();
