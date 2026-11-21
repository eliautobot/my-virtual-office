// Sprite-stack scene (v0.13): the office drawn as one stacked-pixel diorama.
// game.js keeps every behaviour (simulation, seats, menus, editor); this file
// turns its state into stacks each frame, owns the diorama camera (turn and
// pitch) and maps the screen back to the office for clicks and drags.
//
// The camera has two looks: the diorama (turned, pitched: squash < 1) and the
// plan (yaw 0, squash 1, spacing 1), which is exactly the classic office camera:
// the editor always uses the plan, so its grid, handles and drags are unchanged.
(function () {
    'use strict';
    var S = window.VOStack = window.VOStack || {};
    var DEG = Math.PI / 180;

    var DIORAMA = { squash: 0.70, spacing: 1.0 };
    var st = S.state = {
        tried: false, renderer: null, error: null,
        yaw: -30 * DEG, yawTo: -30 * DEG,          // diorama turn (radians), animated toward yawTo
        cur: { yaw: 0, squash: 1, spacing: 1 },     // the camera this frame
        plan: false,                                // the user chose the flat plan look
        k: 1, fboScale: 1, frac: [0, 0], fw: 0, fh: 0, ox: 0, oy: 0,
        meshes: Object.create(null),                // model key -> atlas mesh
        ids: [], idOf: new Map(),
        layoutSig: '', lastSync: 0, frame: 0
    };

    // ---------- on / off ----------
    // The Graphics setting (stack-loader.js, window.VOGraphics) decides; without
    // the loader the diorama is on unless the address says ?classic=1.
    function wanted() {
        if (window.VOGraphics && typeof window.VOGraphics.resolved === 'function') return window.VOGraphics.resolved() === '3d';
        try { if (/[?&]classic=1\b/.test(location.search)) return false; } catch (e) { /* no location */ }
        return true;
    }
    function init() {
        if (st.tried) return;
        st.tried = true;
        try {
            var v = JSON.parse(localStorage.getItem('vo-stack-view') || 'null');
            if (v && isFinite(v.yaw)) { st.yaw = st.yawTo = v.yaw; }
            if (v && v.plan) st.plan = true;
        } catch (e) { /* defaults */ }
        if (wanted()) start();
        mark();
    }
    function start() {
        if (st.renderer) return true;
        if (st.error) return false;
        try { st.renderer = new S.Renderer(); }
        catch (e) {
            st.error = String(e && e.message || e); st.renderer = null;
            console.warn('[stack] falling back to the classic look:', st.error);
            if (window.VOGraphics && window.VOGraphics.markFailed) window.VOGraphics.markFailed();
        }
        st.active = !!st.renderer;
        return st.active;
    }
    function mark() { document.documentElement.classList.toggle('vo-stack', !!(st.renderer && st.active)); }
    S.on = function () {
        if (!st.tried) init();
        return !!(st.renderer && st.active);
    };
    // Switch the diorama on or off while the office runs (the Graphics setting).
    // The renderer is kept when it goes off, so turning it back on is instant.
    S.activate = function (on) {
        if (!st.tried) init();
        var was = !!(st.renderer && st.active);
        if (on) { if (!st.renderer) start(); st.active = !!st.renderer; }
        else st.active = false;
        var now = !!(st.renderer && st.active);
        mark();
        if (was !== now) {
            // the fit scale, the classic still layer, the camera and the map buttons follow the look
            try { if (typeof _baseScaleMemo !== 'undefined') _baseScaleMemo.w = -1; } catch (e) { /* older game.js */ }
            try { if (typeof _staticLayerForce !== 'undefined') _staticLayerForce = true; } catch (e) { /* older game.js */ }
            try { if (typeof clampCamera === 'function') clampCamera(); } catch (e) { /* keep going */ }
            try { if (typeof _emitCameraChange === 'function') _emitCameraChange(); } catch (e) { /* keep going */ }
            try { if (typeof _markSceneDirty === 'function') _markSceneDirty(); } catch (e) { /* keep going */ }
        }
        syncButtons();
        return now;
    };
    S.setClassic = function (on) {
        if (window.VOGraphics) window.VOGraphics.set(on ? '2d' : '3d');
        else S.activate(!on);
    };

    // ---------- the camera ----------
    function inEdit() { return typeof editMode !== 'undefined' && !!editMode; }
    function targetCam() {
        if (inEdit() || st.plan) return { yaw: 0, squash: 1, spacing: 1 };
        return { yaw: st.yawTo, squash: DIORAMA.squash, spacing: DIORAMA.spacing };
    }
    function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
    // Ease the camera toward its target; true while it moves.
    S.step = function (dtMs) {
        var t = targetCam(), c = st.cur, k = Math.min(1, (dtMs || 16) / 140);
        var dy = wrapAngle(t.yaw - c.yaw), moving = false;
        if (Math.abs(dy) > 0.0015) { c.yaw = wrapAngle(c.yaw + dy * k); moving = true; } else c.yaw = t.yaw;
        if (Math.abs(t.squash - c.squash) > 0.002) { c.squash += (t.squash - c.squash) * k; moving = true; } else c.squash = t.squash;
        if (Math.abs(t.spacing - c.spacing) > 0.002) { c.spacing += (t.spacing - c.spacing) * k; moving = true; } else c.spacing = t.spacing;
        if (moving && typeof _baseScaleMemo !== 'undefined') _baseScaleMemo.w = -1;   // the fit scale follows the turn
        if ((moving || st.moving) && typeof clampCamera === 'function') { try { clampCamera(); } catch (e) { /* keep turning */ } }
        if (moving && typeof _markSceneDirty === 'function') _markSceneDirty();
        st.moving = moving;
        return moving;
    };
    S.cam = function () { return st.cur; };
    S.isFlat = function () { var c = st.cur; return Math.abs(c.yaw) < 1e-4 && Math.abs(c.squash - 1) < 1e-4 && Math.abs(c.spacing - 1) < 1e-4; };
    S.rotate = function (steps) {
        if (inEdit()) return;
        st.plan = false;
        var q = 45 * DEG, base = Math.round(st.yawTo / q) * q;
        st.yawTo = wrapAngle(base + steps * q);
        if (Math.abs(st.yawTo) < 1e-6) st.yawTo = 0;
        save();
        if (typeof _markSceneDirty === 'function') _markSceneDirty();
    };
    S.setYaw = function (rad) { st.yawTo = wrapAngle(rad); st.plan = false; save(); };
    S.togglePlan = function () { st.plan = !st.plan; if (!st.plan && Math.abs(st.yawTo) < 1e-6) st.yawTo = -30 * DEG; save(); if (typeof _markSceneDirty === 'function') _markSceneDirty(); };
    S.resetView = function () { st.plan = false; st.yawTo = -30 * DEG; save(); };
    function save() { try { localStorage.setItem('vo-stack-view', JSON.stringify({ yaw: st.yawTo, plan: st.plan })); } catch (e) { /* ignore */ } syncButtons(); }

    // ---------- the map controls: turn left / right, straight view ----------
    var btnSig = '';
    function syncButtons() {
        if (typeof document === 'undefined') return;
        var on = !!(st.renderer && st.active), edit = inEdit(), sig = on + '|' + edit + '|' + st.plan;
        if (sig === btnSig) return;
        btnSig = sig;
        document.querySelectorAll('[data-vo-stack-ctl]').forEach(function (b) {
            b.hidden = !on;
            b.disabled = edit;
            if (b.dataset.voMap === 'straight-view') {
                b.setAttribute('aria-pressed', st.plan ? 'true' : 'false');
                b.setAttribute('aria-label', st.plan ? 'Turned 3D view' : 'Straight top-down view');
                b.title = (st.plan ? 'Turned 3D view' : 'Straight top-down view') + ' (V)';
            }
        });
    }
    S.syncButtons = syncButtons;
    if (typeof document !== 'undefined') {
        document.addEventListener('click', function (e) {
            var b = e.target && e.target.closest && e.target.closest('[data-vo-stack-ctl]');
            if (!b || !S.on() || inEdit()) return;
            var a = b.dataset.voMap;
            if (a === 'turn-left') S.rotate(-1);
            else if (a === 'turn-right') S.rotate(1);
            else if (a === 'straight-view') S.togglePlan();
        });
    }

    function wallH() { return (officeConfig && officeConfig.walls && officeConfig.walls.height) || 90; }
    // The back wall's room face in 3D: on the tile line the classic floor starts
    // at (its first floor row is the one whose bottom passes the wall band: 80 for
    // a 90 px wall), so the first row is a whole tile and a piece snapped into it
    // stands against the wall. The wall is that tall, so in the straight view it
    // covers 0..face like the classic band (whose last 10 px paint over that row).
    function wallFace() { var h = wallH(); return h >= 40 ? Math.floor(h / 40) * 40 : h; }
    S.wallFace = wallFace;
    var SLAB = 14;   // the diorama base under the floor
    // Projected size of the office (world px at scale 1): the floor box from the
    // slab under it to the top of the back wall. dx/dy: where that box's centre
    // sits from the projected office centre (the fit centres the box, not the floor).
    S.extent = function () {
        var c = st.cur, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        var top = wallFace(), pts = [[0, top - 10], [W, top - 10], [0, H], [W, H]];
        for (var i = 0; i < 4; i++) {
            var dx = pts[i][0] - W / 2, dy = pts[i][1] - H / 2, vx = dx * cs - dy * sn, vy = dx * sn + dy * cs;
            for (var j = 0; j < 2; j++) {
                var z = j ? top : -SLAB;
                var px = vx, py = vy * c.squash - z * c.spacing;
                if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
            }
        }
        return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    };
    // World offset that puts the projected box centre at the view centre.
    S.fitShift = function () {
        if (S.isFlat()) return { x: 0, y: 0 };
        var e = S.extent(), c = st.cur, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        var vx = e.cx, vy = e.cy / c.squash;   // a floor offset: z 0
        return { x: vx * cs + vy * sn, y: -vx * sn + vy * cs };
    };
    function scaleNow() { return getBaseScale() * camera.zoom; }
    function centre() { return { x: W / 2 + camera.x, y: H / 2 + camera.y }; }
    // World (x, y, z) -> canvas CSS px.
    S.project = function (x, y, z) {
        var c = st.cur, s = scaleNow(), C = centre(), cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        var dx = x - C.x, dy = y - C.y, vx = dx * cs - dy * sn, vy = dx * sn + dy * cs;
        return { x: displayW / 2 + vx * s, y: displayH / 2 + (vy * c.squash - (z || 0) * c.spacing) * s };
    };
    // Canvas CSS px -> the floor point under it (z = 0, or the plane at height z).
    S.unproject = function (px, py, z) {
        var c = st.cur, s = scaleNow(), C = centre(), cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        var vx = (px - displayW / 2) / s, vy = ((py - displayH / 2) / s + (z || 0) * c.spacing) / c.squash;
        return { x: C.x + vx * cs + vy * sn, y: C.y - vx * sn + vy * cs };
    };
    // Screen vectors at scale 1 <-> floor vectors (linear; no centre).
    S.screen1ToWorld = function (sx, sy) {
        var c = st.cur, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw), vy = sy / c.squash;
        return { x: sx * cs + vy * sn, y: -sx * sn + vy * cs };
    };
    S.worldToScreen1 = function (wx, wy) {
        var c = st.cur, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        return { x: wx * cs - wy * sn, y: (wx * sn + wy * cs) * c.squash };
    };
    // A drag of (dx, dy) CSS px -> the world move under it (on the floor).
    S.screenDelta = function (dx, dy) {
        var c = st.cur, s = scaleNow(), cs = Math.cos(c.yaw), sn = Math.sin(c.yaw), vx = dx / s, vy = dy / (s * c.squash);
        return { x: vx * cs + vy * sn, y: -vx * sn + vy * cs };
    };

    // ---------- a context that draws nothing ----------
    // Agents' legacy draw() keeps its side effects (seat easing, hit boxes, tag
    // offsets) while the stack draws the person: it runs against this.
    var nullGrad = { addColorStop: function () {} };
    var NULLCTX = S.nullCtx = new Proxy({
        canvas: { width: 1, height: 1 },
        getTransform: function () { return new DOMMatrix(); },
        measureText: function () { return { width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 }; },
        createLinearGradient: function () { return nullGrad; }, createRadialGradient: function () { return nullGrad; },
        createPattern: function () { return null; },
        getImageData: function (x, y, w, h) { return { data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)), width: w, height: h }; },
        isPointInPath: function () { return false; }, getLineDash: function () { return []; }
    }, {
        get: function (t, k) { if (k in t) return t[k]; return function () {}; },
        set: function (t, k, v) { if (typeof v !== 'function') t[k] = v; return true; }
    });
    S.withCtx = function (g, fn) {
        var saved = window.ctx;
        window.ctx = g;
        try { return fn(); } finally { window.ctx = saved; }
    };

    // ---------- meshes ----------
    function meshFor(key, build, pool) {
        var m = st.meshes[key];
        // in use this frame: a full pose space never drops it before it is drawn
        if (m && m.alive) { st.renderer.atlas.touch(m, st.renderer.stamp); return m; }
        var model = null;
        try { model = build(); } catch (e) { console.warn('[stack] model failed', key, e); }
        m = model ? st.renderer.upload(model, pool || 'static', key) : null;
        st.meshes[key] = m || { alive: false, failed: true };
        return m;
    }
    S.mesh = meshFor;

    // ---------- the office state -> stacks ----------
    var ID = { furniture: 1, wall: 20000, slab: 30000, agent: 100000, pet: 150000, extra: 160000, chair: 200000 };
    function idFor(kind, idx, ref) {
        var id = ID[kind] + idx;
        st.ids[id] = { kind: kind, ref: ref };
        return id;
    }

    // The model def of a piece: its variant's own ('desk~gamer'), else its type's.
    function defOf(item) {
        var mk = typeof _mk === 'function' ? _mk(item) : item.type;
        return (mk && S.defs[mk]) || S.defs[item.type] || null;
    }
    S.defOf = defOf;
    function itemKey(item) {
        var d = defOf(item);
        var base = item.type + '|' + (item.variant || '') + '|' + (item.color || '') + '|' + (item.couchColor || '') + '|' + (item.labelColor || '') + '|' + (item.text || '') + '|' + (item.fontSize || '');
        if (d && d.key) { try { base += '|' + d.key(item, S.ctxFor(item)); } catch (e) { /* plain key */ } }
        return base;
    }
    // What an asset builder may ask about a piece.
    S.ctxFor = function (item) {
        var rx = null;
        try { rx = typeof _rxOf === 'function' && typeof _rxTable !== 'undefined' && _rxTable.size ? _rxOf(item) : null; } catch (e) { rx = null; }
        var colors = null;
        try { colors = typeof _itemColor === 'function' && (item.type === 'desk' || item.type === 'bossDesk') ? _itemColor(item).t : null; } catch (e) { colors = null; }
        return { rx: rx, wallH: wallH(), colors: colors, manifest: (typeof FURNITURE_MANIFEST !== 'undefined' && FURNITURE_MANIFEST[typeof _mk === 'function' ? _mk(item) : item.type]) || null };
    };

    // How a piece stands in the world: anchor, height base, turn.
    function placement(item) {
        var m = defOf(item), rot = (item.rotation || 0) * DEG;
        var mount = m && m.mount ? m.mount : (typeof FURNITURE_MANIFEST !== 'undefined' && FURNITURE_MANIFEST[item.type] || {}).mount;
        if (item.type === 'textLabel' || item.type === 'branchSign') {
            if (item.y < wallH() - 4) return wallPlace(item);
            return { x: item.x, y: item.y, z: 0, turn: 0 };
        }
        if (mount === 'wall') return wallPlace(item);
        if (mount === 'surface') {
            var under = null;
            try { under = typeof _surfaceUnder === 'function' ? _surfaceUnder(item, officeConfig.furniture) : null; } catch (e) { under = null; }
            var top = under ? (S.surfaceTop(under) || 25) : 0, un = under ? wallNudge(under) : 0;
            // the art's base line on the counter top is where it stands; the floor point is that line + the lift
            // (moved with its counter when the counter is moved off the back wall)
            var b = (FURNITURE_BOUNDS[item.type] || { h: 20, oy: 0 }), base = item.y + b.h * (1 - (b.oy || 0));
            return { x: item.x, y: base + top + un, z: top, turn: rot, surface: true, baseDy: base - item.y, nudge: un };
        }
        var nudge = wallNudge(item);
        return { x: item.x, y: item.y + nudge, z: 0, turn: rot, nudge: nudge };
    }
    // A wall piece on the back wall's face: the classic art row r is at height
    // face - (item.y + r), so the straight view shows it where the classic does; a
    // piece whose art reaches below the face's foot is lifted to stand on the floor.
    function wallPlace(item) {
        var f = wallFace(), lift = 0;
        try { if (typeof _getItemWorldRect === 'function') { var r = _getItemWorldRect(item); lift = Math.max(0, r.y + r.h - f); } } catch (e) { lift = 0; }
        return { x: item.x, y: f, z: f - item.y + lift, turn: 0, wall: true };
    }
    // How far a floor piece is moved south so it stands in the room, not inside a wall
    // (0 for most): see boardNudge and backWallNudge. Seats and sitters move with it.
    function wallNudge(item) {
        if (!item || item.type === 'wall' || item.type === 'door' || item.type === 'textLabel' || item.type === 'branchSign') return 0;
        var ver = (typeof _staticContentVersion !== 'undefined' ? _staticContentVersion : 0) + '|' + item.x + ',' + item.y + ',' + (item.rotation || 0) + ',' + wallFace(), m = nudgeMemo.get(item);
        if (m && m.ver === ver) return m.dy;
        var dy = 0;
        try { var bd = boardNudge(item); dy = bd || backWallNudge(item); } catch (e) { dy = 0; }
        nudgeMemo.set(item, { ver: ver, dy: dy });
        return dy;
    }
    S.nudgeOf = wallNudge;
    // A floor piece set against the back wall: the classic paints it over the wall
    // band, so its 3D parts may reach behind the wall's face (the straight couch, a
    // cabinet, a shelf) or stop a few px short of it. In 3D its back stands on the
    // face: moved forward out of the wall, or back against it.
    function backWallNudge(item) {
        var d = defOf(item), man = (typeof FURNITURE_MANIFEST !== 'undefined' && FURNITURE_MANIFEST[typeof _mk === 'function' ? _mk(item) : item.type]) || null;
        var mount = d && d.mount ? d.mount : man && man.mount;
        if (!man || mount === 'wall' || mount === 'surface') return 0;
        var parts = man.projection && man.projection.parts, rot = item.rotation || 0, y0 = Infinity;
        for (var i = 0; parts && i < parts.length; i++) {
            var p = parts[i];
            if (!p.plan) continue;
            var r = rot && typeof _projTurn === 'function' ? _projTurn(typeof _planAt === 'function' ? _planAt(p, rot) : p.plan, rot) : p.plan;
            y0 = Math.min(y0, item.y + r[1]);
        }
        if (!isFinite(y0)) return 0;
        var behind = wallFace() - y0;
        // into the wall: out to its face; a few px off it (the classic lets a piece's
        // back sit anywhere in the wall band): back against it, no sliver of floor
        if (behind > 0) return Math.ceil(behind);
        if (behind > -7) return behind;
        return 0;
    }
    // A free-standing board (whiteboard) set against a partition or the back wall:
    // the classic draws it over the wall, so in 3D it stands just in front of it
    // (its upright 'board' part moved to the wall's south face, when the board is
    // inside the wall or up to 10 px behind it). Memoised per piece and layout.
    var nudgeMemo = new WeakMap();
    function boardNudge(item) {
        if (item.rotation) return 0;
        var man = (typeof FURNITURE_MANIFEST !== 'undefined' && FURNITURE_MANIFEST[typeof _mk === 'function' ? _mk(item) : item.type]) || null;
        var parts = man && man.projection && man.projection.parts, board = null;
        for (var i = 0; parts && i < parts.length; i++) if (parts[i].name === 'board' && parts[i].upright) board = parts[i];
        if (!board) return 0;
        var bx0 = item.x + board.plan[0], bx1 = bx0 + board.plan[2], by0 = item.y + board.plan[1], by1 = by0 + board.plan[3], dy = 0;
        var faces = [wallFace()];   // south faces of the walls in reach
        try {
            if (typeof _wallSegs === 'function' && typeof _wallSegRect === 'function') {
                _wallSegs(officeConfig.walls && officeConfig.walls.interior).forEach(function (g) {
                    var r = _wallSegRect(g);
                    if (r.w > r.h && bx1 > r.x + 2 && bx0 < r.x + r.w - 2) faces.push(r.y + r.h);
                });
            }
        } catch (e) { /* the back wall only */ }
        faces.forEach(function (f) {
            // the board inside the wall or just behind it (within 10 px of its north face)
            if (by1 > f - 16 && by0 < f) dy = Math.max(dy, f + 1 - by0);
        });
        return dy;
    }
    S.surfaceTop = function (item) {
        var d = defOf(item);
        if (d && d.surfaceZ) return d.surfaceZ;
        return item.type === 'kitchenCounter' ? 25 : item.type === 'breakArea' ? 25 : 25;
    };

    var lastKeyOf = new WeakMap();
    function furnitureMesh(item) {
        var key = 'f|' + itemKey(item), d0 = defOf(item), pool = d0 && d0.pool;
        if (pool === 'dynamic') {
            // a look that changes on its own (the clock's hands): the old mesh is let go
            var was = lastKeyOf.get(item);
            if (was && was !== key && st.meshes[was]) delete st.meshes[was];
            lastKeyOf.set(item, key);
        }
        return meshFor(key, function () {
            var d = defOf(item);
            if (d) return d.build(item, S.ctxFor(item));
            return S.legacyModel ? S.legacyModel(item) : null;
        }, pool);
    }

    // Screens on a piece: 0 off, 1 code, 2 resting, 3 tv
    function screenState(item) {
        try {
            if (item.type === 'tv') {
                var on = _rxStateOf(item) > 0 || agents.some(function (a) { return a.idleAction === 'watch_tv' && Math.abs(a.x - item.x) < 70 && Math.abs(a.y - (item.y + 50)) < 70; });
                return on ? 3 : 0;
            }
            if (typeof _isDeskType === 'function' && _isDeskType(item.type)) {
                var ag = typeof _deskScreenAgent === 'function' ? _deskScreenAgent(item) : null;
                if (!ag) return 0;
                var mk = typeof _monitorKind === 'function' ? _monitorKind(ag) : null;
                if (mk && mk.kind === 'offline') return 0;
                return ag.state === 'working' ? 1 : 2;
            }
        } catch (e) { /* fall through */ }
        return 0;
    }

    // ---------- walls ----------
    function wallModels() { return S.walls ? S.walls : null; }

    // ---------- floor ----------
    var floorCanvas = null;
    function floorUpdate() {
        var sig = W + 'x' + H + '|' + JSON.stringify(officeConfig.floor || {}) + '|' + wallFace();
        if (sig === st.floorSig) return;
        st.floorSig = sig;
        if (!floorCanvas) floorCanvas = document.createElement('canvas');
        floorCanvas.width = Math.max(1, W); floorCanvas.height = Math.max(1, H);
        var g = floorCanvas.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        S.withCtx(g, function () {
            if (S.drawFloor) S.drawFloor(g, officeConfig.floor || {});
            else _drawOfficeFloor(officeConfig.floor || {});
        });
        st.renderer.setFloor(floorCanvas, sig);
    }

    // ---------- lighting ----------
    S.lightEnv = function (now) {
        var amb = (typeof getAmbientLight === 'function' ? getAmbientLight() : null) || { dark: 0, tint: '0,0,0' };
        var night = typeof _nightLevel === 'function' ? _nightLevel() : 0;
        var tint = String(amb.tint || '0,0,0').split(',').map(Number), dark = amb.dark || 0;
        // the warm veil of dawn / sunset, the blue of night
        var ambient = [1 - dark * 0.6 + tint[0] / 255 * dark, 1 - dark * 0.6 + tint[1] / 255 * dark, 1 - dark * 0.6 + tint[2] / 255 * dark];
        if (night > 0) ambient = [1 - night * 0.62, 1 - night * 0.56, 1 - night * 0.36];
        var sky = (typeof _tod !== 'undefined' && _tod) || { sky: '#2196f3', top: '#bbdefb', stars: false };
        var raining = false;
        try { raining = typeof _weatherState !== 'undefined' && _weatherState && /rain|storm|drizzle/i.test(_weatherState.condition || _weatherState.kind || ''); } catch (e) { raining = false; }
        var c0 = S.color.rgb(sky.sky || '#2196f3'), c1 = S.color.rgb(sky.top || sky.upper || '#bbdefb');
        var env = {
            sunDir: norm([-0.45, 0.55, 0.70]),
            lit: [1.06, 1.03, 0.97], mid: [0.86, 0.87, 0.93], shd: [0.64, 0.68, 0.84],
            ambient: ambient, night: night, time: now / 1000,
            sky0: [c1[0] / 255, c1[1] / 255, c1[2] / 255, raining ? 1 : 0], sky1: [c0[0] / 255, c0[1] / 255, c0[2] / 255, sky.stars ? 1 : 0],
            outline: [0.09, 0.08, 0.16],
            shadow: [0.55, -0.42], shadowCol: [0.03, 0.03, 0.08, 0.24 * (1 - night * 0.6)],
            floorMul: 1, lights: []
        };
        if (night > 0.02) env.lights = nightLights(night);
        return env;
    };
    function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
    function nightLights(night) {
        var out = [];
        try {
            if (typeof _nightRefreshState === 'function') _nightRefreshState();
            var src = _nightSources(), wh = wallFace();
            src.lights.forEach(function (l) {
                var x = l.fx != null ? l.fx : l.x + l.w / 2, y = l.fy != null ? l.fy : l.y + l.h, z = 30, k = (l.k || 0.8), r = (l.reach || 80) * 1.1;
                if (l.kind === 'screen') {
                    var on = _nightActiveDesks[l.desk.id || (l.desk.x + ',' + l.desk.y)];
                    if (!on) return;
                    k *= on === 2 ? 0.9 : 0.45; z = 34; y = l.fy != null ? l.fy : y;
                } else if (l.kind === 'tv') {
                    var idx = src.tvs.indexOf(l);
                    if (!_nightTvOn[idx]) return;
                    z = 26;
                } else if (l.kind === 'lamp') { z = 40; k *= 1.2; r *= 1.1; }
                else if (l.kind === 'pane') { y = wh + 6; z = wh - (l.y + l.h / 2); k *= 0.7; }
                else if (l.kind === 'vending') { z = 30; }
                out.push({ x: x, y: y, z: z, r: r, c: [l.rgb[0] / 255, l.rgb[1] / 255, l.rgb[2] / 255], k: k * night * 0.85 });
            });
        } catch (e) { /* no lights */ }
        // keep the strongest near the view centre
        var C = centre();
        out.sort(function (a, b) { return (b.k * 1000 - Math.hypot(b.x - C.x, b.y - C.y)) - (a.k * 1000 - Math.hypot(a.x - C.x, a.y - C.y)); });
        return out.slice(0, 16);
    }

    // ---------- people ----------
    // Each person's legacy draw runs against the null context (all its state
    // keeps moving); the stack person is drawn from that state.
    function runLegacyDraw(e) {
        var wasOff = e._offlinePass;
        try {
            e._offlinePass = true;
            S.withCtx(NULLCTX, function () { e.draw(); });
        } catch (err) { /* a person's draw must never stop the frame */ }
        finally { e._offlinePass = wasOff; }
    }

    // ---------- the frame ----------
    var _lastNow = 0;
    S.renderWorld = function (g, now) {
        var R = st.renderer;
        st.frame++;
        var dt = _lastNow ? Math.min(100, now - _lastNow) : 16;
        _lastNow = now;
        S.step(dt);
        if (st.frame % 15 === 1) syncButtons();
        st.ids = [];
        floorUpdate();
        if (S.houseKeeping) S.houseKeeping(now);

        // fbo: about one pixel per world px, scaled up by a whole k
        var s = scaleNow(), dpr = DPR || 1, sd = s * dpr;
        var k = Math.max(1, Math.round(sd));
        if (sd < 1) k = 1;
        var fboScale = sd / k;
        var fw = Math.ceil(canvas.width / k) + 2, fh = Math.ceil(canvas.height / k) + 2;
        var cam = st.cur, C = centre(), cs = Math.cos(cam.yaw), sn = Math.sin(cam.yaw);
        // the world origin on a whole fbo pixel (plan view lines up with the art grid); the
        // leftover fraction moves the blit instead, so panning stays smooth
        var oxRaw = (displayW * dpr / 2) / k + 1, oyRaw = (displayH * dpr / 2) / k + 1;
        var o0x = (-C.x * cs + C.y * sn) * fboScale + oxRaw, o0y = ((-C.x * sn - C.y * cs) * cam.squash) * fboScale + oyRaw;
        var fx = o0x - Math.floor(o0x), fy = o0y - Math.floor(o0y);
        st.k = k; st.fboScale = fboScale; st.fw = fw; st.fh = fh; st.ox = oxRaw - fx; st.oy = oyRaw - fy; st.frac = [fx, fy];
        var camU = { cx: C.x, cy: C.y, yaw: cam.yaw, squash: cam.squash, spacing: cam.spacing, scale: fboScale, fw: fw, fh: fh, ox: st.ox, oy: st.oy };

        R.begin();
        var env = S.lightEnv(now);
        // shadow casters first (the shadow pass draws the first N instances)
        var list = S.collect(now, env);
        var casters = 0;
        for (var i = 0; i < list.length; i++) { if (list[i].shadow !== false) { R.push(list[i]); } }
        casters = R.count;
        for (i = 0; i < list.length; i++) { if (list[i].shadow === false) R.push(list[i]); }
        if (S.decals) S.decals(R, now);
        var wh = wallFace();
        var img = R.render(camU, env, { x: 0, y: wh, w: W, h: H - wh, tx: 0, ty: wh / H, tw: 1, th: (H - wh) / H }, casters);

        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.imageSmoothingEnabled = false;
        // fbo pixel X lands on device pixel (X - 1 + frac) * k
        g.drawImage(img, (fx - 1) * k, (fy - 1) * k, fw * k, fh * k);
        g.restore();
    };

    // Everything to draw this frame, as renderer items.
    S.collect = function (now, env) {
        var out = [], t = now / 1000, i;
        var view = typeof _cullView === 'function' ? null : null;   // (whole office: the GPU culls)
        void view;
        // furniture
        var furn = officeConfig.furniture || [];
        for (i = 0; i < furn.length; i++) {
            var item = furn[i];
            if (item.type === 'wall' || item.type === 'door') continue;
            if (S.skipItem && S.skipItem(item)) continue;
            var mesh = furnitureMesh(item);
            if (!mesh || !mesh.alive) continue;
            var p = placement(item);
            var spec = { mesh: mesh, x: p.x, y: p.y, z: p.z, turn: p.turn, id: idFor('furniture', i, item), screen: screenState(item) };
            var d = defOf(item);
            if (d && d.animate) { try { d.animate(spec, item, t, S.ctxFor(item)); } catch (e) { /* still */ } }
            if (p.wall || (d && d.flat)) spec.shadow = false;
            if (inEdit() && typeof selectedItemId !== 'undefined' && (selectedItemId === item.id || (typeof _multiSelected !== 'undefined' && _multiSelected.indexOf && _multiSelected.indexOf(item.id) >= 0))) { spec.tint = [255, 214, 0]; spec.tintAmt = 0.18; }
            if (inEdit() && typeof _envSkip !== 'undefined' && typeof isDragging !== 'undefined' && isDragging && selectedItemId === item.id) spec.alpha = 0.75;
            out.push(spec);
            if (S.extraFor) S.extraFor(item, i, spec, out, t);
        }
        // walls + slab
        if (S.wallItems) S.wallItems(out, idFor);
        // people + pets
        if (S.peopleItems) S.peopleItems(out, idFor, now, runLegacyDraw);
        return out;
    };

    // ---------- picking ----------
    // The thing under a canvas CSS point: { kind, ref } or null (read from the
    // last frame's id buffer; one read per pixel per frame).
    var pickMemo = { key: '', val: null };
    S.pickAt = function (cssX, cssY) {
        if (!S.on() || !st.fw) return null;
        var dpr = DPR || 1, k = st.k;
        var fx = Math.floor(cssX * dpr / k + 1 - st.frac[0]), fy = Math.floor(cssY * dpr / k + 1 - st.frac[1]);
        var key = fx + ',' + fy + ',' + st.frame;
        if (pickMemo.key === key) return pickMemo.val;
        var id = st.renderer.pick(fx, fy);
        pickMemo.key = key; pickMemo.val = id ? (st.ids[id] || null) : null;
        return pickMemo.val;
    };
    // The nearest pick around a point (touch: a finger-sized ring) that `ok` accepts.
    S.pickNear = function (cssX, cssY, radius, ok) {
        var h = S.pickAt(cssX, cssY);
        if (h && (!ok || ok(h))) return h;
        if (!radius) return null;
        for (var r = 6; r <= radius; r += 6) {
            for (var a = 0; a < 8; a++) {
                var an = a * Math.PI / 4;
                h = S.pickAt(cssX + Math.cos(an) * r, cssY + Math.sin(an) * r);
                if (h && (!ok || ok(h))) return h;
            }
        }
        return null;
    };

    // ---------- the classic plane -> the turned diorama ----------
    // Overlays (tags, chips, bubbles, menus, Office life signs) are placed for
    // the classic camera, where a spot `o` px above a person is the point
    // (x, y - o). These map such spots onto the stacked figures.
    S.turned = function () { return S.on() && !S.isFlat(); };
    S.placementOf = placement;
    S.localToWorld = function (ax, ay, turn, lx, ly) {
        var c = Math.cos(turn || 0), s = Math.sin(turn || 0);
        return { x: ax + lx * c - ly * s, y: ay + lx * s + ly * c };
    };
    // Front-to-back depth of a floor point in the current view (bigger = nearer).
    S.viewY = function (x, y) {
        var c = st.cur, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw), C = centre();
        return (x - C.x) * sn + (y - C.y) * cs;
    };
    function personOf(e) {
        var p = null;
        try { p = S.personAt ? S.personAt(e) : null; } catch (err) { p = null; }
        return p || { x: e.x, y: e.y, z: 0, top: 48 };
    }
    // Canvas px of the classic spot `o` px above an entity's anchor, on its
    // stacked figure (o 40 = the classic head top, -8 = the feet), plus a
    // screen nudge (dx, dy) in world px.
    S.entityAt = function (e, o, dx, dy) {
        var p = personOf(e), top = p.top || 48;
        var h = o <= 40 ? Math.max(0, (o + 8) / 48 * top) : top + (o - 40);
        var q = S.project(p.x, p.y, (p.z || 0) + h), s = scaleNow();
        return { x: q.x + (dx || 0) * s, y: q.y + (dy || 0) * s };
    };
    // Canvas rect of an entity's figure (feet to head top, halfW world px each side).
    S.screenBox = function (e, halfW) {
        var p = personOf(e), s = scaleNow(), f = S.project(p.x, p.y, p.z || 0), hd = S.project(p.x, p.y, (p.z || 0) + (p.top || 48));
        halfW = (halfW || 15) * s;
        return { x: f.x - halfW, y: hd.y, w: halfW * 2, h: Math.max(4, f.y - hd.y) };
    };
    // A classic-plane point (x, y) -> canvas px: on the back wall above the
    // floor line, over the nearest person when it sits above one, else the floor.
    S.classicToCanvas = function (x, y) {
        var wh = wallFace();
        if (y < wh - 2) return S.project(x, wh, wh - y);
        var best = null, bd = Infinity;
        var lists = [typeof agents !== 'undefined' ? agents : [], typeof officePets !== 'undefined' ? officePets : [], typeof _lifeExtras !== 'undefined' ? _lifeExtras : []];
        for (var l = 0; l < lists.length; l++) {
            for (var i = 0; i < lists[l].length; i++) {
                var e = lists[l][i];
                if (!e || !isFinite(e.x) || !isFinite(e.y)) continue;
                var dx = Math.abs(x - e.x), o = e.y - y;
                if (dx > 40 || o < -16 || o > 140) continue;
                var d = dx + Math.abs(o - 40) * 0.25;
                if (d < bd) { bd = d; best = e; }
            }
        }
        if (best) { var r = S.entityAt(best, best.y - y, x - best.x, 0); r.__entity = true; return r; }
        return S.project(x, y, 0);
    };
    // Does the canvas point (px, py) see the box (local plan [x, y, w, d],
    // heights z0..z0+h) of a piece at (ax, ay, az) turned by `turn`? The ray
    // under the point is walked down through the box's heights.
    S.hitBox = function (px, py, ax, ay, az, turn, plan, z0, h, pad) {
        var c = Math.cos(turn || 0), s = Math.sin(turn || 0);
        pad = pad || 0;
        for (var z = z0; z <= z0 + h + 1e-6; z += 0.5) {
            var w = S.unproject(px, py, (az || 0) + z), dx = w.x - ax, dy = w.y - ay;
            var lx = dx * c + dy * s, ly = -dx * s + dy * c;
            if (lx >= plan[0] - pad && lx <= plan[0] + plan[2] + pad && ly >= plan[1] - pad && ly <= plan[1] + plan[3] + pad) return true;
        }
        return false;
    };
    function monitorPlan(item) {
        var man = S.ctxFor(item).manifest, mp = man && man.monitorPlan;
        return mp && mp.plans && mp.plans.length ? mp : null;
    }
    // A desk's monitors: canvas px of the top centre and the middle of their union.
    S.deskMonitorAnchor = function (item) {
        var mp = monitorPlan(item);
        if (!mp) return null;
        var p = placement(item), x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        mp.plans.forEach(function (r) { x0 = Math.min(x0, r[0]); x1 = Math.max(x1, r[0] + r[2]); y0 = Math.min(y0, r[1]); y1 = Math.max(y1, r[1] + r[3]); });
        var w = S.localToWorld(p.x, p.y, p.turn, (x0 + x1) / 2, (y0 + y1) / 2);
        return { top: S.project(w.x, w.y, mp.z + mp.h), mid: S.project(w.x, w.y, mp.z + mp.h / 2) };
    };
    // Is the canvas point on one of a desk's monitors (and nothing in front of it)?
    S.deskMonitorHit = function (item, px, py, pad) {
        var mp = monitorPlan(item);
        if (!mp) return false;
        var front = S.pickAt(px, py);
        if (front && front.ref !== item) return false;
        var p = placement(item);
        for (var i = 0; i < mp.plans.length; i++) {
            var r = mp.plans[i], prof = Math.max(0, (mp.prof || 0) - r[3]) / 2;
            if (S.hitBox(px, py, p.x, p.y, 0, p.turn, [r[0], r[1] - prof, r[2], r[3] + prof * 2], mp.z, mp.h, pad || 0)) return true;
        }
        return false;
    };
})();
