// Virtual Office PROBE (v0.10.1, dev only; review 2026-11-07: "a test character you can control the movement of, so
// that you can move it across, get close to objects/furniture/walls and then assess and correct based on how things
// look"). game.js loads this file only with ?debug=probe or localStorage 'vo.debug.probe' = '1'.
// One test person on the real Agent class (same drawing, seats, planner, collision and world rules), kept out of
// `agents` (no roster, chat, status or life director): game.js steps, draws and checks it with the people.
// Keyboard (not while typing): arrows / WASD walk, Q / E turn, Space sit at the nearest free seat / stand up,
// G ghost mode (ignore the world rules: any spot, no step-outs, not in the invariant), C cycle the carried item,
// 1-9 poses (0 = plain standing), H hide / show the HUD.
// Walking obeys every rule (it shows what agents can do): feet never in a footprint (WALK_PAD) nor on a wall line,
// a clearance band is crossed (at most CLR.runMax px, never deeper once over it) but never stood in: let go inside
// one and the probe steps out like any agent.
// window.VOProbe: spawn(x, y), moveTo(x, y), step(dx, dy), place(x, y, {view, ghost}), face(view), sit(index |
// 'near' | seat), stand(), carry(item), pose(name), ghost(on), state(), frame(rect), seats(), remove(), agent().
(function() {
    'use strict';
    if (typeof Agent === 'undefined' || typeof _probePeople === 'undefined' || window.VOProbe) return;
    var VIEWS = ['down', 'left', 'up', 'right'];
    var CARRY = [null, 'coffee', 'water', 'snack', 'food'];
    var POSES = ['stand', 'work', 'stretch', 'read', 'window', 'held', 'phone', 'sip', 'type', 'snooze'];
    var probe = null, hud = null, hudOn = true, keys = {};

    class ProbeAgent extends Agent {
        update() {
            this.idleTimer = 1e9; this.deskIdleTimer = 1e9; this.idleReturnTimer = 0;
            if ((this._probePose === 'phone' || this._probePose === 'sip') && !this._dIdle && this.isSitting) this._dIdle = { kind: this._probePose, t0: this.tick };
            var k = keyDir();
            if (this._ghost) {
                this.tick++;
                if (k.x || k.y) return void this._walkStep(k.x, k.y, true);
                if (this._kbWas) { this._kbWas = false; this._halt(); }
                var dx = this.targetX - this.x, dy = this.targetY - this.y, d = Math.hypot(dx, dy);  // a ghost walk: straight
                if (d > this.speed) { this.x += dx / d * this.speed; this.y += dy / d * this.speed; } else { this.x = this.targetX; this.y = this.targetY; }
                return;
            }
            if (k.x || k.y) { this.tick++; return void this._walkStep(k.x, k.y, false); }
            if (this._kbWas) { this._kbWas = false; this._halt(); }
            super.update();
        }
        onArrive() {
            super.onArrive();
            var s = this._probeSeat;
            if (s && Math.abs(this.x - s.x) <= 1 && Math.abs(this.y - s.y) <= 1) this.isSitting = !!_worldSeatAt(this.x, this.y);
        }
        _halt() {
            this.targetX = this._prevTargetX = this.x; this.targetY = this._prevTargetY = this.y;
            this._path = null; this._seatGoal = null;
        }
        // Why feet may not step to (nx, ny) walking (null = they may): the W2 hard rules + the clearance walk rule.
        _stepWhy(nx, ny) {
            var wallH = (officeConfig.walls && officeConfig.walls.height) || 0;
            if (!(nx >= 10 && nx <= W - 10 && ny >= wallH + 6 && ny <= H - 6)) return 'office edge';
            var r = _feetIn(nx, ny, -WALK_PAD);
            if (r && !_feetIn(this.x, this.y)) return 'footprint: ' + r.item.type;
            if (!_isPointClearOfInteriorWalls(nx, ny, 5)) return 'wall';
            var d1 = _clrDepth(nx, ny);
            if (d1 > 0 && d1 >= _clrDepth(this.x, this.y) && (this._kbRun || 0) + this.speed > CLR.runMax) {
                var b = _clrAt(nx, ny);
                return 'band run > ' + CLR.runMax + ': ' + (b ? b.kind : 'band');
            }
            return null;
        }
        _walkStep(ux, uy, ghost) {
            if (this.isSitting && !ghost) { _worldStandUp(this); this._leaveSeat(); this._halt(); return 'stood up'; }
            if (ghost) this.isSitting = false;
            var n = Math.hypot(ux, uy) || 1, sp = this.speed;
            ux /= n; uy /= n;
            var tries = [[ux, uy]];
            if (ux && uy) tries.push([ux, 0], [0, uy]);
            var why = null;
            for (var i = 0; i < tries.length; i++) {
                var nx = this.x + tries[i][0] * sp, ny = this.y + tries[i][1] * sp;
                why = ghost ? null : this._stepWhy(nx, ny);
                if (why) continue;
                this.x = nx; this.y = ny;
                this._kbRun = _clrDepth(nx, ny) > 0 ? (this._kbRun || 0) + sp : 0;
                break;
            }
            this._kbBlocked = why;
            this.targetX = this._prevTargetX = this.x + ux * 12; this.targetY = this._prevTargetY = this.y + uy * 12;
            this._path = null; this._seatGoal = null; this._kbWas = true;
            return why;
        }
        _leaveSeat() {
            this._probeSeat = null; this.isSitting = false;
            this.desk = this._homeDesk;
        }
    }

    function keyDir() {
        var x = 0, y = 0;
        if (keys.l) x -= 1; if (keys.r) x += 1; if (keys.u) y -= 1; if (keys.d) y += 1;
        return { x: x, y: y };
    }
    function need() { if (!probe) spawn(); return probe; }
    function seatOut(s, i) {
        return s ? { index: i, kind: s.kind, type: s.item ? s.item.type : '', id: s.item ? s.item.id : null, x: s.x, y: s.y, fx: s.fx, fy: s.fy } : null;
    }
    function seatList() { return _worldSeats(); }
    function bandOut(b) { return b ? { kind: b.kind, type: b.owner && b.owner.type ? b.owner.type : '' } : null; }

    function spawn(x, y) {
        if (probe) { _probePeople.splice(_probePeople.indexOf(probe), 1); probe = null; }
        var p = new ProbeAgent({ id: '__probe', statusKey: '__probe', name: 'Probe', emoji: '🧪', role: 'Probe', color: '#00bcd4', available: true });
        p.speed = 2; p.state = 'idle'; p._homeDesk = p.desk;
        if (x != null && y != null) {
            var q = _worldFloorOk(x, y) && !_clrAt(x, y) ? { x: x, y: y } : (_worldNearestFree(x, y, 400) || { x: x, y: y });
            p.x = q.x; p.y = q.y;
        }
        p.isSitting = false; p._halt();
        _probePeople.push(p);
        probe = p;
        if (typeof _sceneDirty !== 'undefined') _sceneDirty = true;
        ensureHud();
        return state();
    }
    function moveTo(x, y) {
        var p = need();
        if (p.isSitting) p._leaveSeat();
        p._probeSeat = null;
        p.targetX = x; p.targetY = y;
        return { x: p.targetX, y: p.targetY };
    }
    // Walk (dx, dy) now in speed-long steps under the walking rules (as held keys would): where it got and why it stopped.
    function step(dx, dy) {
        var p = need(), L = Math.hypot(dx, dy), n = Math.ceil(L / p.speed), why = null;
        var gx = p.x + dx, gy = p.y + dy;
        for (var i = 0; i < n && !why; i++) {
            var rx = gx - p.x, ry = gy - p.y, rl = Math.hypot(rx, ry);
            if (rl < 0.01) break;
            if (rl < p.speed) {
                var keep = p.speed; p.speed = rl; why = p._walkStep(rx, ry, !!p._ghost); p.speed = keep;
            } else why = p._walkStep(rx, ry, !!p._ghost);
            if (why === 'stood up') why = null;
        }
        p._halt(); p._kbWas = false;
        return { x: p.x, y: p.y, blocked: why };
    }
    function place(x, y, opts) {
        var p = need(), o = opts || {};
        if (o.ghost != null) p._ghost = !!o.ghost;
        p._leaveSeat();
        p.x = x; p.y = y; p._halt(); p._kbRun = 0;
        p._pvx = p._pvy = null; p._walkFace = null;
        if (o.view !== undefined) p._forceView = o.view || null;
        if (o.walk) { p.targetX = p._prevTargetX = x + (o.view === 'left' ? -12 : o.view === 'right' ? 12 : 0); p.targetY = p._prevTargetY = y + (o.view === 'up' ? -12 : o.view === 'down' ? 12 : 0); }
        return state();
    }
    function face(view) { var p = need(); p._forceView = VIEWS.indexOf(view) >= 0 ? view : null; return p._forceView; }
    function turn(k) {
        var p = need(), cur = p._forceView || 'down', i = VIEWS.indexOf(cur);
        p._forceView = VIEWS[(i + k + 4) % 4];
    }
    // Sit: a seat index (VOProbe.seats()), a seat object, or 'near' (the nearest free one). Walks there (planner), a
    // ghost sits at once. Returns the seat or null.
    function sit(which) {
        var p = need(), list = seatList(), s = null;
        if (typeof which === 'number') s = list[which] || null;
        else if (which && typeof which === 'object') s = list.find(function(t) { return t.x === which.x && t.y === which.y; }) || null;
        else {
            var bd = Infinity;
            list.forEach(function(t) {
                if (_worldSeatTaken(t, p)) return;
                var d = Math.hypot(t.fx - p.x, t.fy - p.y);
                if (d < bd && d <= 160) { bd = d; s = t; }
            });
        }
        if (!s) return null;
        p._probeSeat = s;
        p.desk = _isDeskType(s.kind) ? { x: s.x, y: s.y, id: s.item ? s.item.id : undefined } : p._homeDesk;
        if (p._ghost) {
            p.x = s.x; p.y = s.y; p._halt(); p.isSitting = true; p._seatT = 1; p._seatFrom = null;
        } else { p.isSitting = false; p.targetX = s.x; p.targetY = s.y; }
        return seatOut(s, list.indexOf(s));
    }
    function stand() {
        var p = need();
        if (!p.isSitting && !p._probeSeat) return false;
        if (p.isSitting && !p._ghost) _worldStandUp(p);
        p._leaveSeat(); p._halt();
        return true;
    }
    function carry(item) {
        var p = need();
        p.carryItem = item || null;
        p.snackType = item === 'snack' ? 'chips' : null;
        p.foodType = item === 'food' ? 'sandwich' : null;
        return p.carryItem;
    }
    function pose(name) {
        var p = need(), look = p.appearance || {};
        p.idleAction = null; p._lifePose = null; p._dIdle = null; p.task = ''; p.state = 'idle';
        look.heldItem = null; if (p._appearance) p._appearance.heldItem = null;
        name = POSES.indexOf(name) >= 0 ? name : 'stand';
        p._probePose = name;
        if (name === 'work') { p.state = 'working'; p.task = 'Probe'; }
        else if (name === 'stretch') p.idleAction = 'stretch';
        else if (name === 'read') p.idleAction = 'read_book';
        else if (name === 'window') p.idleAction = 'look_window';
        else if (name === 'held') { look.heldItem = 'clipboard'; if (p._appearance) p._appearance.heldItem = 'clipboard'; }
        else if (name === 'type' || name === 'snooze') p._lifePose = name;
        return name;
    }
    function ghost(on) { var p = need(); p._ghost = on == null ? !p._ghost : !!on; if (p._ghost) p._kbRun = 0; return p._ghost; }
    function viewOf(p) {
        if (p._forceView) return p._forceView;
        var moving = Math.abs(p.targetX - p.x) > p.speed || Math.abs(p.targetY - p.y) > p.speed;
        var s = p._seatPose(moving);
        if (s && s.view) return s.view;
        if (!moving) return p.idleAction === 'look_window' ? 'up' : 'down';
        var dx = p.targetX - p.x, dy = p.targetY - p.y;
        if (p._path && p._path.length) { dx = p._path[0].x - p.x; dy = p._path[0].y - p.y; }
        return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
    // Where the probe is and what the world rules say about the spot.
    function state() {
        var p = probe;
        if (!p) return null;
        var moving = !!(p._path && p._path.length) || p.x !== p.targetX || p.y !== p.targetY;
        var view = viewOf(p), side = view === 'left' || view === 'right';
        var seat = _worldSeatAt(p.x, p.y, 4), fp = _feetIn(p.x, p.y), vol = null;
        try { vol = _volIntrudes(p, p.isSitting && seat && seat.hx != null ? seat : null); } catch (e) { vol = null; }
        var sh = p.isSitting ? null : _clrSideHit(p.x, p.y, side ? CLR.bodySide : CLR.bodyW);
        var flags = [];
        if (fp && !(p.isSitting && seat && seat.item === fp.item)) flags.push('inside ' + fp.item.type);
        var band = p.isSitting || fp ? null : _clrAt(p.x, p.y, CLR.tol);
        if (band) flags.push((moving ? 'crossing ' : 'at rest in ') + band.kind + (band.owner && band.owner.type ? ' ' + band.owner.type : ''));
        if (sh) flags.push('beside ' + sh.item.type + (sh.box.part ? '/' + sh.box.part : ''));
        if (vol) flags.push('volume meets ' + vol.part);
        return {
            x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, view: view, ghost: !!p._ghost, moving: moving,
            sitting: !!p.isSitting, seat: p.isSitting && seat ? seatOut(seat, seatList().indexOf(seat)) : null,
            carry: p.carryItem || null, pose: p._probePose || 'stand', blocked: p._kbBlocked || null,
            band: bandOut(band), side: sh ? { type: sh.item.type, id: sh.item.id, part: sh.box.part || '' } : null,
            inFootprint: fp ? fp.item.type : null, volume: vol ? vol.part : null, flags: flags, ok: !flags.length
        };
    }
    // Point the camera at a world rect (default: the probe +-70 px) filling the canvas; returns it in canvas px.
    function frame(rect) {
        var p = probe, r = rect || (p ? { x: p.x - 70, y: p.y - 90, w: 140, h: 120 } : { x: 0, y: 0, w: W, h: H });
        var base = getBaseScale();
        camera.zoom = Math.max(0.2, Math.min(displayW / (r.w * base), displayH / (r.h * base)));
        camera.x = r.x + r.w / 2 - W / 2; camera.y = r.y + r.h / 2 - H / 2;
        if (typeof _invalidateStaticLayer === 'function') _invalidateStaticLayer();
        var a = _worldToCanvas(r.x, r.y), b = _worldToCanvas(r.x + r.w, r.y + r.h);
        return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, zoom: camera.zoom };
    }
    function remove() {
        if (!probe) return false;
        _probePeople.splice(_probePeople.indexOf(probe), 1); probe = null;
        if (hud) hud.style.display = 'none';
        return true;
    }

    // HUD: position, view, seat and the rule flags at the probe's spot.
    function ensureHud() {
        if (hud || typeof document === 'undefined' || !document.body) return;
        hud = document.createElement('div');
        hud.id = 'voProbeHud';
        hud.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;pointer-events:none;font:11px/1.35 ui-monospace,monospace;' +
            'color:#b9f6ca;background:rgba(10,14,20,.82);border:1px solid #2e7d32;border-radius:6px;padding:6px 8px;max-width:340px;white-space:pre-wrap';
        document.body.appendChild(hud);
        setInterval(drawHud, 200);
    }
    function drawHud() {
        if (!hud) return;
        var s = state();
        hud.style.display = hudOn && s ? '' : 'none';
        if (!s || !hudOn) return;
        var t = 'PROBE ' + s.x.toFixed(0) + ',' + s.y.toFixed(0) + '  ' + s.view + (s.ghost ? '  GHOST' : '') + (s.sitting ? '  seated ' + (s.seat ? s.seat.type : '') : '') +
            (s.carry ? '  carry ' + s.carry : '') + (s.pose !== 'stand' ? '  ' + s.pose : '') + '\n' +
            (s.flags.length ? s.flags.join('\n') : 'clear') + (s.blocked ? '\nblocked: ' + s.blocked : '') +
            '\narrows/WASD walk  Q/E turn  Space sit  G ghost  C carry  0-9 pose  H hud';
        hud.style.borderColor = s.ok ? '#2e7d32' : '#c62828';
        if (hud.textContent !== t) hud.textContent = t;
    }

    var MOVE = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd', a: 'l', d: 'r', w: 'u', s: 'd' };
    function typing(e) { return typeof _isTypingTarget === 'function' && (_isTypingTarget(document.activeElement) || _isTypingTarget(e.target)); }
    window.addEventListener('keydown', function(e) {
        if (!probe || e.ctrlKey || e.metaKey || e.altKey || typing(e) || (typeof editMode !== 'undefined' && editMode)) return;
        var k = e.key.length === 1 ? e.key.toLowerCase() : e.key, m = MOVE[k], done = true;
        if (m) keys[m] = true;
        else if (k === 'q') turn(-1);
        else if (k === 'e') turn(1);
        else if (k === ' ') { if (probe.isSitting || probe._probeSeat) stand(); else sit('near'); }
        else if (k === 'g') ghost();
        else if (k === 'c') carry(CARRY[(CARRY.indexOf(probe.carryItem || null) + 1) % CARRY.length]);
        else if (k === 'h') { hudOn = !hudOn; drawHud(); }
        else if (/^[0-9]$/.test(k)) pose(POSES[Number(k)]);
        else done = false;
        if (done) { e.preventDefault(); e.stopImmediatePropagation(); if (typeof _sceneDirty !== 'undefined') _sceneDirty = true; }
    }, true);
    window.addEventListener('keyup', function(e) {
        var k = e.key.length === 1 ? e.key.toLowerCase() : e.key, m = MOVE[k];
        if (m) keys[m] = false;
    }, true);
    window.addEventListener('blur', function() { keys = {}; });

    window.VOProbe = {
        spawn: spawn, moveTo: moveTo, step: step, place: place, face: face, sit: sit, stand: stand, carry: carry,
        pose: pose, ghost: ghost, state: state, frame: frame, remove: remove,
        seats: function() { return seatList().map(seatOut); },
        agent: function() { return probe; }, poses: POSES.slice(), carries: CARRY.slice(1)
    };
    // Spawn once the office has its layout and people (a test may set window.__voProbeNoSpawn and spawn itself).
    var tries = 0;
    (function wait() {
        if (window.__voProbeNoSpawn || probe) return;
        if ((typeof agents !== 'undefined' && agents.length && officeConfig && officeConfig.furniture) || ++tries > 60) { spawn(); return; }
        setTimeout(wait, 300);
    })();
})();
