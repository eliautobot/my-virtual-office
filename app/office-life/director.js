// Office life director (v0.9): who controls each agent's body right now.
//
// One scripted behavior per agent. A feature asks with request(key, behavior)
// and gets 'started', 'queued' or 'refused'. Higher priority preempts (needs
// re-queues itself when `requeue` is set, the others drop); lower or equal
// waits in a short per-agent queue (max 3, dropped after staleMs). Real work
// wins: a behavior that walks the agent away (`moves`) and is not part of the
// work (`forWork`) is refused or cancelled while the agent works, sits in a
// real meeting, is offline or the tab is hidden. Calm mode and reduced motion
// make every walk resolve at once as skipped, so features run their at-desk
// variant. Pure logic over the host API (window.VOLifeHost or a fake one in
// tests): no canvas, no DOM, no timers of its own.
(function (root) {
    'use strict';

    var PRIORITY = { replay: 200, needs: 100, standup: 80, handoff: 60, tournament: 50, highfive: 40, cake: 20, birthday: 20 };
    var DEFAULT_MAX_MS = { needs: 6 * 3600 * 1000, standup: 120000, tournament: 90000, handoff: 45000, replay: 24 * 3600 * 1000 };
    // interns: one character per running helper; crew.js sets the office cap from the setting interns.maxShown.
    var DEFAULT_CAPS = { walking: 4, interns: 24, couriers: 2, planes: 3, confetti: 160 };
    var QUEUE_MAX = 3;
    var WALK_STALL_MS = 8000;
    var WALK_MAX_MS = 45000;

    function create(host, opts) {
        opts = opts || {};
        var now = opts.now || function () { return Date.now(); };
        var hidden = opts.hidden || function () { return typeof document !== 'undefined' && !!document.hidden; };
        var atDesk = opts.atDesk || function () { return false; };
        var caps = Object.assign({}, DEFAULT_CAPS, opts.caps || {});
        var running = {};   // key -> slot
        var queues = {};    // key -> [entry]
        var tokens = {};    // cap kind -> count in use
        var seq = 0;
        var lastPromote = 0;
        var log = opts.log || null;

        function note(kind, slot, extra) {
            if (log) log.push(Object.assign({ kind: kind, key: slot && slot.key, id: slot && slot.id, feature: slot && slot.feature }, extra || {}));
        }
        function agentOf(key) { return host.agent ? host.agent(key) : null; }
        function statusOf(a) { return a ? String(a._statusState || a.state || 'idle') : 'idle'; }
        function isWorking(a) { var s = statusOf(a); return s === 'working' || s === 'finishing'; }
        function inMeeting(a) { return !!(a && (a.meetingId || a.state === 'meeting' || a.state === 'visiting')); }
        function isOffline(a) { return statusOf(a) === 'offline'; }

        // Why a behavior may not run on this agent now ('' = it may).
        function blocker(key, b) {
            var a = agentOf(key);
            if (!a) return 'no-agent';
            if (!b.moves) return '';
            if (isOffline(a)) return 'offline';
            if (b.forWork) return hidden() ? 'hidden' : '';
            if (isWorking(a)) return 'working';
            if (inMeeting(a)) return 'meeting';
            if (hidden()) return 'hidden';
            return '';
        }

        function normalize(b) {
            var kind = String(b.kind || b.feature || 'life');
            var priority = b.priority != null ? Number(b.priority) : (PRIORITY[kind] || 10);
            return Object.assign({}, b, {
                kind: kind,
                feature: String(b.feature || kind),
                priority: priority,
                moves: !!b.moves,
                forWork: !!b.forWork,
                maxMs: b.maxMs != null ? Number(b.maxMs) : (DEFAULT_MAX_MS[kind] || 30000),
                staleMs: b.staleMs != null ? Number(b.staleMs) : 20000
            });
        }

        function makeCtl(slot) {
            var ctl = {
                key: slot.key,
                slot: slot,
                data: slot.data,
                agent: function () { return agentOf(slot.key); },
                elapsed: function () { return now() - slot.startedAt; },
                active: function () { return running[slot.key] === slot; },
                // Walk to (x, y). cb({ok, reason, placed}) when there (or not).
                // Calm / reduced motion: no walking, cb({ok:false, reason:'calm'}) at once.
                walk: function (x, y, cb) {
                    if (!ctl.active()) return false;
                    if (atDesk()) { if (cb) cb({ ok: false, reason: 'calm' }); return false; }
                    slot.walk = { x: x, y: y, cb: cb || null, startedAt: now(), pending: true };
                    tryStartWalk(slot);
                    return true;
                },
                walking: function () { return !!slot.walk; },
                pose: function (name, data) { return host.pose(slot.key, name || null, data || null); },
                carry: function (item) { return host.carry(slot.key, item || null); },
                face: function (dir) { return host.face(slot.key, dir); },
                place: function (x, y, o) { return host.place ? host.place(slot.key, x, y, o) : false; },
                busy: function (ms) { if (host.markBusy) host.markBusy(ms || 1000); },
                done: function (reason) { if (ctl.active()) end(slot, reason || 'done', true); },
                setLabel: function (label) { slot.label = String(label || ''); var a = agentOf(slot.key); if (a && a._lifeHold) a._lifeHold.label = slot.label; }
            };
            return ctl;
        }

        function walkingCount() {
            var n = 0;
            for (var k in running) if (running[k].walk && !running[k].walk.pending) n++;
            return n;
        }
        function tryStartWalk(slot) {
            var w = slot.walk;
            if (!w || !w.pending) return;
            if (walkingCount() >= caps.walking) return; // waits for a free walking slot
            w.pending = false;
            w.startedAt = now();
            host.walkTo(slot.key, w.x, w.y);
            note('walk', slot, { x: w.x, y: w.y });
        }
        function finishWalk(slot, res) {
            var w = slot.walk;
            slot.walk = null;
            if (w && w.cb) {
                try { w.cb(res); } catch (e) { if (root.console) root.console.warn('office life walk', e); }
            }
        }
        function checkWalk(slot, t) {
            var w = slot.walk;
            if (!w) return;
            if (w.pending) { tryStartWalk(slot); return; }
            var st = host.walkStatus ? host.walkStatus(slot.key) : (host.arrived(slot.key) ? 'arrived' : 'walking');
            if (st === 'arrived') { finishWalk(slot, { ok: true }); return; }
            var tooLong = t - w.startedAt > WALK_MAX_MS;
            if (st === 'stalled' || st === 'blocked' || st === 'idle' || tooLong) {
                // Arrival watchdog: skip the walk; stand on the target only when it is floor.
                if (host.walkable && host.walkable(w.x, w.y) && host.place) {
                    host.place(slot.key, w.x, w.y);
                    finishWalk(slot, { ok: true, placed: true, reason: tooLong ? 'timeout' : st });
                } else {
                    finishWalk(slot, { ok: false, reason: tooLong ? 'timeout' : st });
                }
            }
        }

        function start(key, b) {
            var slot = {
                id: b.id || ('b' + (++seq)), key: key, kind: b.kind, feature: b.feature, priority: b.priority,
                forWork: b.forWork, moves: b.moves, maxMs: b.maxMs, staleMs: b.staleMs, label: b.label || '',
                startedAt: now(), behavior: b, data: b.data || {}, walk: null
            };
            running[key] = slot;
            if (b.hold !== false) host.hold(key, b.kind, { label: slot.label });
            slot.ctl = makeCtl(slot);
            note('start', slot);
            if (typeof b.start === 'function') {
                try { b.start(slot.ctl); } catch (e) { if (root.console) root.console.warn('office life start', e); end(slot, 'error', true); }
            }
            return slot;
        }

        // End a running behavior. release=true hands the agent back to normal
        // life (unless another queued behavior takes over right away).
        function end(slot, reason, release) {
            if (running[slot.key] !== slot) return;
            delete running[slot.key];
            slot.walk = null;
            note('end', slot, { reason: reason });
            var b = slot.behavior;
            if (typeof b.end === 'function') {
                try { b.end(slot.ctl, reason); } catch (e) { if (root.console) root.console.warn('office life end', e); }
            }
            if ((reason === 'preempted' || reason === 'roster') && b.requeue) {
                var q = queues[slot.key] || (queues[slot.key] = []);
                q.unshift({ b: b, queuedAt: now(), requeued: true });
                if (q.length > QUEUE_MAX) q.length = QUEUE_MAX;
            }
            host.pose(slot.key, null);
            host.carry(slot.key, null);
            if (release && !promote(slot.key)) host.release(slot.key);
        }

        // Start the best queued behavior for this agent if allowed now.
        function promote(key) {
            if (running[key]) return false;
            var q = queues[key];
            if (!q || !q.length) return false;
            var t = now();
            for (var i = q.length - 1; i >= 0; i--) {
                var e = q[i];
                var stale = !(e.b.forWork && e.b.moves) && t - e.queuedAt > e.b.staleMs;
                if (stale) { q.splice(i, 1); note('stale', { key: key, feature: e.b.feature }); if (typeof e.b.dropped === 'function') { try { e.b.dropped('stale'); } catch (x) {} } }
            }
            q.sort(function (a, b) { return b.b.priority - a.b.priority || a.queuedAt - b.queuedAt; });
            for (var j = 0; j < q.length; j++) {
                if (blocker(key, q[j].b)) continue;
                var next = q.splice(j, 1)[0];
                if (!q.length) delete queues[key];
                start(key, next.b);
                return true;
            }
            if (!q.length) delete queues[key];
            return false;
        }

        var api = {
            PRIORITY: PRIORITY,
            caps: caps,
            // 'started' | 'queued' | 'refused'
            request: function (key, behavior) {
                if (!key || !behavior) return 'refused';
                var b = normalize(behavior);
                var why = blocker(key, b);
                if (why === 'no-agent') return 'refused';
                var cur = running[key];
                if (why) {
                    // A work script (needs) waits for the tab / agent; play scripts are refused.
                    if (!(b.forWork && (why === 'hidden'))) { note('refused', { key: key, feature: b.feature }, { why: why }); return 'refused'; }
                } else if (!cur) {
                    start(key, b);
                    return 'started';
                } else if (b.priority > cur.priority) {
                    end(cur, 'preempted', false);
                    start(key, b);
                    return 'started';
                }
                var q = queues[key] || (queues[key] = []);
                if (q.length >= QUEUE_MAX) {
                    // Full: a more important behavior pushes out the least important one.
                    q.sort(function (x, y) { return y.b.priority - x.b.priority; });
                    if (q[q.length - 1].b.priority >= b.priority) { note('refused', { key: key, feature: b.feature }, { why: 'queue-full' }); return 'refused'; }
                    q.pop();
                }
                q.push({ b: b, queuedAt: now() });
                note('queued', { key: key, feature: b.feature });
                return 'queued';
            },
            // Cancel what runs on this agent (and optionally its queue for a feature).
            cancel: function (key, reason, opts2) {
                var cur = running[key];
                if (opts2 && opts2.feature && queues[key]) {
                    queues[key] = queues[key].filter(function (e) { return e.b.feature !== opts2.feature; });
                    if (!queues[key].length) delete queues[key];
                }
                if (!cur) return false;
                if (opts2 && opts2.feature && cur.feature !== opts2.feature) return false;
                end(cur, reason || 'cancelled', true);
                return true;
            },
            // Cancel every behavior (running and queued) of one feature.
            cancelFeature: function (feature, reason) {
                Object.keys(queues).forEach(function (k) {
                    queues[k] = queues[k].filter(function (e) { return e.b.feature !== feature; });
                    if (!queues[k].length) delete queues[k];
                });
                Object.keys(running).forEach(function (k) { if (running[k].feature === feature) end(running[k], reason || 'cancelled', true); });
            },
            current: function (key) { return running[key] || null; },
            queued: function (key) { return (queues[key] || []).map(function (e) { return e.b; }); },
            runningKeys: function () { return Object.keys(running); },
            isHeld: function (key) { return !!running[key]; },
            // Called by game.js pollStatus for a held agent. true = keep it here.
            onStatus: function (key, entry) {
                var slot = running[key];
                var st = String((entry && entry.state) || 'idle');
                var a = agentOf(key);
                if (!slot) {
                    // Held through the host without a script here: real work still wins.
                    if (st === 'working' || st === 'finishing' || st === 'offline' || inMeeting(a)) { host.release(key); return false; }
                    return true;
                }
                if (slot.moves && st === 'offline') { end(slot, 'offline', true); return false; }
                if (slot.moves && !slot.forWork && (st === 'working' || st === 'finishing' || inMeeting(a))) {
                    end(slot, 'work', true);
                    return false;
                }
                return true;
            },
            // Once per simulation step: timeouts, walks, behavior updates, queue.
            update: function () {
                var t = now();
                for (var k in running) {
                    var slot = running[k];
                    if (t - slot.startedAt > slot.maxMs) { end(slot, 'timeout', true); continue; }
                    if (slot.moves && !slot.forWork) {
                        var a = agentOf(k);
                        if (!a) { end(slot, 'gone', false); continue; }
                        if (inMeeting(a) && slot.kind !== 'standup') { end(slot, 'meeting', true); continue; }
                    }
                    checkWalk(slot, t);
                    if (running[k] !== slot) continue;
                    var b = slot.behavior;
                    if (typeof b.update === 'function') {
                        try { b.update(slot.ctl, t); } catch (e) { if (root.console) root.console.warn('office life update', e); end(slot, 'error', true); }
                    }
                }
                if (t - lastPromote >= 250) {
                    lastPromote = t;
                    for (var qk in queues) promote(qk);
                }
            },
            // New Agent objects (roster reload): positions are gone, scripts restart.
            onRoster: function () {
                Object.keys(running).forEach(function (k) { end(running[k], 'roster', false); });
                Object.keys(queues).forEach(function (k) { if (!agentOf(k)) delete queues[k]; });
                lastPromote = 0;
            },
            releaseAll: function (reason) {
                queues = {};
                Object.keys(running).forEach(function (k) { end(running[k], reason || 'reset', true); });
                tokens = {};
            },
            isBusy: function () {
                for (var k in running) if (running[k].walk) return true;
                return false;
            },
            // Shared caps (interns, couriers, planes, confetti): take/give tokens.
            take: function (kind, n) {
                n = n || 1;
                var cap = caps[kind];
                var used = tokens[kind] || 0;
                if (cap != null && used + n > cap) return false;
                tokens[kind] = used + n;
                return true;
            },
            give: function (kind, n) { tokens[kind] = Math.max(0, (tokens[kind] || 0) - (n || 1)); },
            // A feature's cap from its setting (tokens already taken stay until given back).
            setCap: function (kind, n) { n = Math.floor(Number(n)); if (isFinite(n) && n >= 0) caps[kind] = n; },
            used: function (kind) { return tokens[kind] || 0; },
            walkingCount: walkingCount
        };
        return api;
    }

    var mod = { create: create, PRIORITY: PRIORITY, DEFAULT_CAPS: DEFAULT_CAPS };
    root.VOLifeDirector = mod;
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})(typeof window !== 'undefined' ? window : globalThis);
