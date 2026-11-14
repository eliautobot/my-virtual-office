// Office life: Celebrations (feature 5).
// Owner: L6 life-moods-party (design .work/life/design.md 3.5).
//
// Provider-neutral triggers from the server (zero inference):
//   task.done {title, points}   xp {points, total, reason task|manual}
//   project.done {title, agents}   mood clear {backOnTrack: true}
// What the office shows:
//   "+N XP" pixel text rising 30 world px over 1.2 s (screen-space font, fixed
//   size) and a confetti burst (<= 40 bits, one shared pool of 160) at the agent;
//   a task.done and its xp award within 2 s are one pop (the xp figure wins).
//   High-five: the nearest idle, free agent within 160 world px walks over, both
//   raise a hand with a spark, then go back (none near -> skipped).
//   Project done: a "Project done!" pennant over its agents for 4 s and a cake
//   on the kitchen counter until office-local midnight; an idle agent's next
//   food break (host food-trip hook) fetches a slice, once a day each.
//   Back on track (an ok run after being stuck): fist pump + sparkle.
// Rate limit: one celebration per agent per 20 s (later points merge into the
// pop on screen, or show as a quiet pop without confetti).
// Calm mode / reduced motion: the XP text fades in place, no confetti, no
// high-five or cake walks; the cake still appears (static).
(function () {
    'use strict';
    var life = window.VOLife;
    if (!life) return;

    var POP_MS = 1600, RISE_MS = 1200, RISE_WORLD = 30, MERGE_MS = 2000, RATE_MS = 20000;
    var BURST = 40, POOL = 160, PENNANT_MS = 4000, BACK_MS = 2200, FIVE_MS = 1400, FIVE_RANGE = 160;
    var CONFETTI = ['#ef5350', '#ffd54f', '#4fc3f7', '#81c784', '#ba68c8', '#ff8a65'];
    var TAKE_MS = 900, EAT_MS = 4000;

    var pops = [];     // {key, src, points, born, until, pair, quiet}
    var parts = [];    // confetti (world px)
    var sparks = [];   // {key?, x?, y?, born, until}
    var labels = [];   // {key|null, text, kind, icon, born, until}
    var last = {};     // key -> last full celebration (rate limit)
    var sig = {};      // key -> when the agent's signature move started for a celebration (v0.12 moves)
    var poses = {};    // key -> {name, until} on agents nobody holds
    var cake = { on: false, day: '', seen: '' };
    var ate = {};      // key -> day the agent had its slice
    var trip = null, choiceHooked = false; // trip: key of the agent fetching cake
    var five = null;
    var lastStep = 0, lastSlow = 0;
    var placed = [];

    function host() { return life.host(); }
    function director() { return life.director(); }
    function now() { return Date.now(); }
    function agentOf(key) { var h = host(); return h && h.agent ? h.agent(key) : null; }
    function keyOf(a) { return a && (a.statusKey || a.id); }
    function offline(a) { return !a || a.state === 'offline' || a._statusState === 'offline'; }
    function rand(a, b) { return a + Math.random() * (b - a); }
    function dirty() { var h = host(); if (h && h.markDirty) h.markDirty(); }

    function registerSprites() {
        var S = life.sprites();
        if (!S || S.has('cakeSlice')) return;
        S.register('cakeSlice', { w: 8, h: 8, paint: function (g) {
            S.bitmap(g, ['.WP.....', 'WWWWP...', 'PPPPPPP.', 'SSSSSSSS', 'WWWWWWWW', 'PPPPPPPP', 'SSSSSSSS', '.DDDDDD.'],
                { W: '#fff8e1', P: '#f48fb1', S: '#8d6e63', D: '#b0bec5' });
        } });
    }

    // ---- office day (for the cake) ----
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function dayOf(ms) { var p = life.officeParts(ms); return p.year + '-' + pad2(p.month) + '-' + pad2(p.day); }
    function today() { return dayOf(life.serverNow()); }
    function setCake(on, day) {
        var was = cake.on;
        cake.on = !!on;
        cake.day = on ? (day || today()) : '';
        if (was !== cake.on) { var h = host(); if (h && h.invalidateStatic) h.invalidateStatic(); }
    }
    function loadAte() {
        try {
            var s = JSON.parse(localStorage.getItem('vo-life-cake') || 'null');
            if (s && s.day === today() && Array.isArray(s.keys)) s.keys.forEach(function (k) { ate[k] = s.day; });
        } catch (e) {}
    }
    function saveAte(day) {
        try {
            localStorage.setItem('vo-life-cake', JSON.stringify({ day: day, keys: Object.keys(ate).filter(function (k) { return ate[k] === day; }) }));
        } catch (e) {}
    }

    // ---- poses on agents nobody holds ----
    function setPose(key, name, ms) {
        var a = agentOf(key), h = host();
        if (!a || !h || a._lifeHold || offline(a)) return false;
        var ambient = a._lifePoseData && a._lifePoseData.ambient; // a mood's pose (head scratch) gives way
        if (a._lifePose && !ambient && !(poses[key] && poses[key].name === a._lifePose)) return false; // someone else's
        h.pose(key, name, { still: life.reducedMotion() });
        poses[key] = { name: name, until: now() + ms };
        return true;
    }
    function clearPose(key, name) {
        var p = poses[key];
        if (!p || (name && p.name !== name)) return;
        var a = agentOf(key), h = host();
        if (a && h && a._lifePose === p.name && !a._lifeHold) h.pose(key, null);
        delete poses[key];
    }

    // ---- confetti pool (director cap 'confetti', 160 shared) ----
    function burst(x, y, n) {
        if (life.noParticles()) return 0;
        var d = director();
        var room = POOL - parts.length;
        if (d) room = Math.min(room, (d.caps.confetti != null ? d.caps.confetti : POOL) - d.used('confetti'));
        n = Math.min(n, room);
        if (n <= 0) return 0;
        if (d && !d.take('confetti', n)) return 0;
        var t = now();
        for (var i = 0; i < n; i++) {
            parts.push({ x: x + rand(-6, 6), y: y + rand(-4, 4), vx: rand(-75, 75), vy: rand(-200, -90),
                c: CONFETTI[i % CONFETTI.length], w: i % 3 ? 2 : 3, born: t, life: rand(1000, 1600), spin: rand(0, 6) });
        }
        dirty();
        return n;
    }
    function dropParts() {
        var d = director();
        if (d && parts.length) d.give('confetti', parts.length);
        parts = [];
    }

    // ---- who may join a high-five / fetch cake ----
    function available(o) {
        if (!o || o._lifeExtra || !o._ctl || offline(o)) return false;
        if (String(o._statusState || o.state || 'idle') !== 'idle' || o.state !== 'idle') return false;
        var d = director();
        if (o._lifeHold || (d && d.isHeld(keyOf(o)))) return false;
        if (o.meetingId || o._gatheringId) return false;
        var act = String(o.idleAction || '');
        return !(act === 'pong' || act === 'darts' || /game|rps/i.test(act));
    }

    // ---- celebrations ----
    // One per agent per 20 s; returns false when rate limited.
    function celebrate(key, opts) {
        var a = agentOf(key);
        if (!a || a._lifeExtra) return false;
        var t = now();
        if (last[key] && t - last[key] < RATE_MS) return false;
        last[key] = t;
        if (!offline(a)) {
            // v0.12 moves: the agent's signature move, in place of a generic cheer (the host checks the switches)
            var h = host();
            if (h && typeof h.signature === 'function' && life.isOn('celebrations') && h.signature(key)) sig[key] = t;
            if (opts.confetti) burst(a.x, a.y - 44, BURST);
            if (opts.highfive) highFive(key);
        }
        return true;
    }

    function onPoints(key, points, src, ev) {
        var a = agentOf(key);
        if (!a || a._lifeExtra) return;
        points = Math.max(0, Math.round(Number(points) || 0));
        if (src === 'xp' && !points) return;
        var t = now();
        var pairable = src === 'task' || String(ev.reason || 'task') === 'task';
        var p = null;
        for (var i = pops.length - 1; i >= 0; i--) if (pops[i].key === key) { p = pops[i]; break; }
        if (p && p.pair && pairable && p.src !== src && t - p.born < MERGE_MS) {
            // A task.done and its xp award: one pop, the award figure wins.
            p.points = src === 'xp' ? points : Math.max(p.points, points);
            p.pair = false;
            dirty();
            return;
        }
        if (p && points && t < p.until - 300) { p.points += points; p.pair = false; dirty(); return; } // merge into the pop on screen
        var full = celebrate(key, { confetti: true, highfive: true });
        pops.push({ key: key, src: src, points: points, born: t, until: t + POP_MS, pair: pairable, quiet: !full });
        dirty();
    }

    function backOnTrack(key) {
        var a = agentOf(key);
        if (!a || offline(a) || !celebrate(key, { confetti: false, highfive: false })) return;
        var t = now();
        labels.push({ key: key, text: life.t('backOnTrack'), kind: 'success', icon: 'sparkle', born: t, until: t + BACK_MS });
        if (sig[key] !== last[key]) setPose(key, 'fistpump', BACK_MS - 200); // no signature move played: the old fist pump
        sparks.push({ key: key, born: t, until: t + 1600 });
        dirty();
    }

    function projectDone(ev) {
        var at = Number(ev.at) || 0;
        var day = at ? dayOf(at < 1e12 ? at * 1000 : at) : today();
        if (day === today()) { setCake(true, day); cake.seen = day; }
        if (ev._stale) return; // late: the cake stays, the party is over
        var t = now();
        var keys = (Array.isArray(ev.agents) ? ev.agents : []).filter(function (k, i, arr) { return agentOf(k) && arr.indexOf(k) === i; });
        keys.forEach(function (k) {
            celebrate(k, { confetti: true, highfive: false });
            labels.push({ key: k, text: life.t('projectDone'), kind: 'success', icon: 'flag', born: t, until: t + PENNANT_MS });
        });
        if (!keys.length && host().spots().kitchen) {
            labels.push({ key: null, text: life.t('projectDone'), kind: 'success', icon: 'flag', born: t, until: t + PENNANT_MS });
        }
        dirty();
    }

    // ---- high-five ----
    function highFive(key) {
        if (life.atDesk() || five) return;
        var h = host(), d = director();
        var c = agentOf(key);
        if (!h || !d || !c || offline(c) || !c._ctl) return;
        var best = null, bestD = FIVE_RANGE + 0.01;
        h.agents().forEach(function (o) {
            if (o === c || !available(o)) return;
            var dist = Math.hypot(o.x - c.x, o.y - c.y);
            if (dist < bestD) { best = o; bestD = dist; }
        });
        if (!best) return;
        var side = best.x < c.x ? -1 : 1;
        var spot = h.nearestWalkable(c.x + side * 30, c.y + 4, 3);
        if (!spot || Math.hypot(spot.x - c.x, spot.y - c.y) > 64) return;
        var pk = keyOf(best), st = { phase: 'walk', at: 0 };
        five = { from: key, to: pk, at: now() };
        var res = d.request(pk, {
            kind: 'highfive', feature: 'celebrate', moves: true, staleMs: 15000, maxMs: 25000, label: life.t('holdHighfive'),
            start: function (ctl) {
                ctl.walk(spot.x, spot.y, function (r) {
                    if (!ctl.active()) return;
                    var cc = agentOf(key), me = ctl.agent();
                    if (!r.ok || !cc || !me || offline(cc)) { ctl.done(r.ok ? 'gone' : 'unreachable'); return; }
                    var dir = cc.x >= me.x ? 1 : -1;
                    ctl.face(dir);
                    ctl.pose('highfive', { still: life.reducedMotion() });
                    if (setPose(key, 'highfive', FIVE_MS)) h.face(key, -dir);
                    var t = now();
                    sparks.push({ x: (me.x + cc.x) / 2, y: Math.min(me.y, cc.y) - 42, born: t, until: t + 900 });
                    st.phase = 'five'; st.at = t;
                    ctl.busy(FIVE_MS);
                });
            },
            update: function (ctl, t) { if (st.phase === 'five' && t - st.at >= FIVE_MS) ctl.done('done'); },
            end: function () { five = null; clearPose(key, 'highfive'); },
            dropped: function () { five = null; }
        });
        if (res === 'refused') five = null;
    }

    // ---- cake trips (once per agent per day, one at a time) ----
    // An idle agent's next food break goes to the cake (host food-trip hook:
    // walk to the counter, take a slice, eat it at the desk). Normal idle life,
    // so real work simply ends the trip; calm / reduced motion: no trips.
    function cakeTripOpts(o) {
        var h = host(), key = keyOf(o), day = cake.day;
        var k = h && h.spots().kitchen;
        if (!k || !cake.on || trip || life.atDesk() || !life.isOn('celebrations')) return null;
        if (!available(o) || ate[key] === day) return null;
        return {
            x: k.standX, y: k.standY, faceX: k.x, item: 'cakeSlice', takeMs: TAKE_MS, eatMs: EAT_MS,
            label: life.t('holdCake'),
            onTake: function () { ate[key] = day; saveAte(day); },
            onDone: function () { if (trip === key) trip = null; }
        };
    }
    function chooseCake(o) {
        var opts = cakeTripOpts(o);
        if (opts) trip = keyOf(o); // the host starts it at once; refused -> cleared below
        return opts;
    }
    function cakeTrip(forKey) {
        var h = host();
        if (!h || typeof h.foodTrip !== 'function') return false;
        var cands = h.agents().filter(function (o) { return (!forKey || keyOf(o) === forKey) && cakeTripOpts(o); });
        if (!cands.length) return false;
        var o = cands[Math.floor(Math.random() * cands.length)], key = keyOf(o);
        if (!h.foodTrip(key, cakeTripOpts(o))) return false;
        trip = key;
        return true;
    }
    function hookFoodChoice() {
        var h = host();
        if (choiceHooked || !h || typeof h.foodChoice !== 'function') return;
        choiceHooked = true;
        h.foodChoice('cake', chooseCake);
    }
    // A trip the host refused (or that never started) frees the slot.
    function checkTrip() {
        var h = host();
        if (trip && h && typeof h.foodTripOf === 'function' && !h.foodTripOf(trip)) trip = null;
    }

    // ---- screen placement ----
    function overlap(a, b, gap) {
        gap = gap || 0;
        return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
    }
    function obstacles(self) {
        var out = [];
        host().agents().forEach(function (o) {
            var c = o._ctl;
            if (!c) return;
            if (o !== self) { out.push(c.tag); out.push(c.launcher); }
            if (c.chip) out.push(c.chip);
            if (c.bubbleShown && c.bubble) out.push(c.bubble);
            if (o._lifeMoodRect) out.push(o._lifeMoodRect);
        });
        return out.concat(placed);
    }
    function free(r, list, chrome, view) {
        if (r.x < 2 || r.y < 2 || r.x + r.w > view.w - 2 || r.y + r.h > view.h - 2) return false;
        for (var i = 0; i < list.length; i++) if (list[i] && overlap(r, list[i], 1)) return false;
        for (var j = 0; j < chrome.length; j++) if (overlap(r, chrome[j], 2)) return false;
        return true;
    }
    // Above the agent's own controls; slides sideways or steps up when a
    // neighbour's controls are there (least lift wins), never over map controls.
    function placeAbove(a, w, h, chrome, view) {
        var hst = host(), m = hst.ctlMetrics();
        var c = a && a._ctl, cx, top;
        if (c) {
            cx = c.launcher.x + c.launcher.w / 2;
            top = c.launcher.y;
            if (c.chip) top = Math.min(top, c.chip.y);
            if (c.bubbleShown && c.bubble) top = Math.min(top, c.bubble.y);
            if (a._lifeMoodRect) top = Math.min(top, a._lifeMoodRect.y);
        } else return null;
        var list = obstacles(a), first = null;
        var shifts = [0, 0.55, -0.55, 1.1, -1.1];
        for (var lift = 0; lift < 3; lift++) {
            for (var k = 0; k < shifts.length; k++) {
                var r = { x: Math.round(cx - w / 2 + shifts[k] * w), y: Math.round(top - m.gap - h - lift * (h + m.gap)), w: w, h: h };
                if (!first) first = r;
                if (free(r, list, chrome, view)) return r;
            }
        }
        return hst.keepOutOfChrome(first, chrome, 4);
    }
    function fade(t, born, until, inMs, outMs) {
        if (t < born + inMs) return Math.max(0, (t - born) / inMs);
        if (t > until - outMs) return Math.max(0, (until - t) / outMs);
        return 1;
    }

    function drawLabels(ctx, t, chrome, view) {
        var S = life.sprites(), hst = host(), m = hst.ctlMetrics();
        if (!S) return;
        labels.forEach(function (L) {
            ctx.save();
            ctx.font = m.font;
            var tw = Math.ceil(ctx.measureText(L.text).width);
            ctx.restore();
            var padX = Math.round(m.h * 0.32), iconW = Math.round(m.h * 0.6);
            var w = padX * 2 + tw + iconW + 4, h = m.h;
            var r;
            if (L.key) {
                var a = agentOf(L.key);
                if (!a || !a._ctl) return;
                r = placeAbove(a, w, h, chrome, view);
            } else {
                var k = hst.spots().kitchen;
                if (!k) return;
                var p = hst.worldToCanvas(k.x, k.y - 14);
                r = hst.keepOutOfChrome({ x: Math.round(p.x - w / 2), y: Math.round(p.y - h), w: w, h: h }, chrome, 4);
            }
            if (!r) return;
            var drawn = S.label(ctx, L.text, r.x + r.w / 2, r.y, { kind: L.kind, icon: L.icon, anchor: 'top', alpha: fade(t, L.born, L.until, 150, 400) });
            placed.push(drawn || r);
            L.rect = drawn || r;
        });
    }

    function drawPops(ctx, t, chrome, view) {
        var S = life.sprites(), hst = host(), m = hst.ctlMetrics();
        var size = m.h === 24 ? 14 : 13;
        var calmText = life.noParticles();
        pops.forEach(function (p) {
            var a = agentOf(p.key);
            if (!a || !a._ctl) { p.rect = null; return; }
            var text = p.points > 0 ? life.t('xp', { n: p.points }) : life.t('taskDone');
            ctx.save();
            // Pixel font like every label in the world (Q-05); other scripts fall back to the UI font.
            var PF = window.VOPixelFont, pixel = !!(PF && PF.has(text));
            ctx.font = '600 ' + size + 'px Inter, system-ui, sans-serif';
            var tw = pixel ? PF.measure(text) : Math.ceil(ctx.measureText(text).width);
            var w = 14 + 3 + tw, h = 18;
            var r = placeAbove(a, w, h, chrome, view);
            if (!r) { ctx.restore(); return; }
            var age = t - p.born;
            var rise = calmText ? 0 : Math.round(RISE_WORLD * hst.scale() * (1 - Math.pow(1 - Math.min(1, age / RISE_MS), 2)));
            var y = r.y - rise;
            ctx.globalAlpha *= fade(t, p.born, p.until, calmText ? 250 : 120, calmText ? 600 : 400);
            if (S) S.draw(ctx, p.points > 0 ? 'star' : 'sparkle', r.x + 7, y + h / 2, { scale: 2 });
            var gold = p.quiet ? '#ffe082' : '#ffd54f';
            if (pixel) {
                var tx = Math.round(r.x + 17), ty = Math.round(y + h / 2 - 3.5);
                [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]].forEach(function (o) { PF.draw(ctx, text, tx + o[0], ty + o[1], 1, 'rgba(14,19,31,0.92)'); });
                PF.draw(ctx, text, tx, ty, 1, gold);
            } else {
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.lineJoin = 'round';
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(14,19,31,0.92)';
                ctx.strokeText(text, r.x + 17, y + h / 2 + 0.5);
                ctx.fillStyle = gold;
                ctx.fillText(text, r.x + 17, y + h / 2 + 0.5);
            }
            ctx.restore();
            p.rect = { x: r.x, y: y, w: w, h: h };
            placed.push(r);
        });
    }

    var def = life.feature('celebrate', {
        setting: 'celebrations',
        order: 40,
        init: function () {
            life.addText({ taskDone: 'Task done' });
            registerSprites();
            loadAte();
            hookFoodChoice();
        },
        onState: function (snap) {
            var td = (snap && snap.today) || {};
            var day = (snap && snap.day) || today();
            // The server's word, plus a cake this tab saw arrive today.
            setCake(!!td.cake || cake.seen === day, day);
        },
        onDay: function (day) {
            if (cake.on && cake.day !== day) setCake(false);
            ate = {};
        },
        onSettings: function () {
            if (!life.isOn('celebrations')) { dropParts(); pops = []; labels = []; sparks = []; Object.keys(poses).forEach(function (k) { clearPose(k); }); }
        },
        onEvent: function (ev) {
            var key = ev.agent;
            switch (ev.type) {
                case 'task.done': if (key) onPoints(key, ev.points, 'task', ev); break;
                case 'xp': if (key) onPoints(key, ev.points, 'xp', ev); break;
                case 'project.done': projectDone(ev); break;
                case 'mood':
                    if (key && ev.backOnTrack && String(ev.mood || 'clear') === 'clear' && !ev._stale) backOnTrack(key);
                    break;
            }
        },
        update: function (t) {
            var dt = Math.min(0.05, Math.max(0, (t - (lastStep || t)) / 1000));
            lastStep = t;
            if (parts.length) {
                var d = director(), gone = 0;
                for (var i = parts.length - 1; i >= 0; i--) {
                    var p = parts[i];
                    if (t - p.born > p.life) { parts.splice(i, 1); gone++; continue; }
                    p.vy += 320 * dt;
                    p.vx *= (1 - 1.6 * dt);
                    p.x += p.vx * dt + Math.sin(t / 140 + p.spin) * 0.25;
                    p.y += p.vy * dt;
                }
                if (gone && d) d.give('confetti', gone);
                if (!parts.length) dirty();
            }
            var n0 = pops.length + labels.length + sparks.length;
            pops = pops.filter(function (p) { return t < p.until; });
            labels = labels.filter(function (L) { return t < L.until; });
            sparks = sparks.filter(function (s) { return t < s.until; });
            if (pops.length + labels.length + sparks.length !== n0) dirty();
            Object.keys(poses).forEach(function (k) { if (t > poses[k].until) clearPose(k); });
            if (t - lastSlow > 1000) {
                lastSlow = t;
                if (cake.on && cake.day && today() !== cake.day) setCake(false); // office-local midnight
                if (five && t - five.at > 30000) {
                    var dd = director(), cur = dd && dd.current(five.to);
                    if (!cur || cur.feature !== 'celebrate') five = null;
                }
                hookFoodChoice();
                checkTrip();
            }
        },
        isBusy: function () { return !!(pops.length || parts.length || sparks.length || labels.length); },
        drawWorld: function (ctx) {
            if (parts.length) {
                var t = now();
                ctx.save();
                for (var i = 0; i < parts.length; i++) {
                    var p = parts[i];
                    var age = (t - p.born) / p.life;
                    ctx.globalAlpha = age > 0.7 ? Math.max(0, (1 - age) / 0.3) : 1;
                    ctx.fillStyle = p.c;
                    var flip = ((t / 90 + p.spin) | 0) & 1;
                    ctx.fillRect(Math.round(p.x), Math.round(p.y), flip ? p.w : 1, 2);
                }
                ctx.restore();
            }
            if (sparks.length) {
                var S = life.sprites(), tt = now(), calm = life.noParticles();
                if (!S) return;
                sparks.forEach(function (s) {
                    var x = s.x, y = s.y;
                    if (s.key) {
                        var a = agentOf(s.key);
                        if (!a) return;
                        x = a.x + 14; y = a.y - 52;
                    }
                    var tw = calm ? 1 : (0.55 + 0.45 * Math.abs(Math.sin((tt - s.born) / 130)));
                    S.draw(ctx, 'sparkle', x, y, { alpha: tw * fade(tt, s.born, s.until, 80, 300) });
                });
            }
        },
        drawScreen: function (ctx) {
            var hst = host();
            placed = [];
            if (!hst || hst.editMode() || !(pops.length || labels.length)) return;
            var t = now(), chrome = hst.chrome() || [], view = hst.view();
            drawLabels(ctx, t, chrome, view);
            drawPops(ctx, t, chrome, view);
        },
        drawStatic: function (ctx) {
            if (!cake.on) return;
            var k = host().spots().kitchen, S = life.sprites();
            if (!k || !S) return;
            S.draw(ctx, 'cake', k.x, k.y - 6);
        },
        onRoster: function () { poses = {}; five = null; trip = null; },
        reset: function (reason) {
            dropParts();
            sparks = [];
            var d = director();
            if (d && reason === 'calm') d.cancelFeature('celebrate', 'calm');
            if (reason === 'disabled') { pops = []; labels = []; Object.keys(poses).forEach(function (k) { clearPose(k); }); }
        },
        _debug: function () {
            return { pops: pops.map(function (p) { return { key: p.key, points: p.points, src: p.src, quiet: p.quiet, rect: p.rect || null }; }),
                parts: parts.length, sparks: sparks.length, labels: labels.map(function (L) { return { key: L.key, text: L.text, rect: L.rect || null }; }),
                cake: Object.assign({}, cake), ate: Object.assign({}, ate), trip: trip, five: five && { from: five.from, to: five.to },
                poses: JSON.parse(JSON.stringify(poses)), last: Object.assign({}, last) };
        }
    });
    window.VOLifeCelebrate = {
        _debug: function () { return def._debug(); },
        // When the agent last had a real win (task, project, back on track); 0 = none or celebrations off (game.js faces).
        wonAt: function (a) { var k = keyOf(a); return k && life.isOn('celebrations') ? (last[k] || 0) : 0; },
        // tests: start a cake trip now (optionally for one agent) instead of waiting for the next gap
        _cakeTrip: function (key) { return cakeTrip(key || null); }
    };
})();
