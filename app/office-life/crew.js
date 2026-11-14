// Office life: interns, handoffs, visitors and alarm clocks (features 2 and 3,
// design .work/life/design.md 3.2 and 3.3).
//
// - Interns: interns.set {count} -> one helper character per running helper.
//   Only an office-wide safety cap (Office life setting interns.maxShown,
//   default 24) limits them; past it every agent keeps a fair share and its
//   chip reads "30 helpers · 24 shown". They walk in from the front and sit at
//   the free desk nearest their agent (same room first), else stand in a ring
//   round its desk (walkable, apart, clear of seats and doorways), else a lounge
//   seat, else near the front; when the count drops they wave, walk out and
//   fade. Never agents: no menu, no chat, no roster. Hover: "Helper for Ada";
//   click: that agent's chat, Tasks panel.
// - Handoffs: a working sender throws a folder plane desk to desk; an idle one
//   walks the folder over (give / take). Replaces the guessed chat-poll planes
//   while the stream is live (claims sendPlanes).
// - Visitors: a courier with a channel-tinted envelope walks to the agent's
//   desk, knocks, drops the envelope and leaves; the envelope stays until the
//   chat is opened or 10 minutes pass. Only the channel is ever shown.
// - Alarm clocks: cron.fire rings a clock on the desk (an idle agent taps it);
//   it stays small until cron.done or 15 minutes.
// Calm mode / reduced motion: no walking (seat fade-ins, envelope only, static
// clock with a short badge). Zero inference: only server events are drawn.
(function (root) {
    'use strict';
    var life = root.VOLife;
    if (!life) return;

    var CHANNELS = {
        telegram: ['Telegram', '#29b6f6'], discord: ['Discord', '#7986cb'], slack: ['Slack', '#ab47bc'],
        whatsapp: ['WhatsApp', '#43a047'], signal: ['Signal', '#3a76f0'], sms: ['SMS', '#26a69a'], email: ['Email', '#e57373'],
        imessage: ['iMessage', '#66bb6a'], matrix: ['Matrix', '#90a4ae'], mattermost: ['Mattermost', '#5c6bc0'],
        msteams: ['Teams', '#7e57c2'], googlechat: ['Google Chat', '#00897b'], line: ['LINE', '#00c853'], feishu: ['Feishu', '#3f51b5'],
        wechat: ['WeChat', '#2e7d32'], irc: ['IRC', '#78909c'], twitch: ['Twitch', '#9575cd'], nostr: ['Nostr', '#8e24aa'],
        x: ['X', '#546e7a'], voice: ['Voice', '#ffa726'], webhook: ['Webhook', '#ff7043'], homeassistant: ['Home Assistant', '#039be5']
    };
    var texts = {};
    Object.keys(CHANNELS).forEach(function (id) { texts['channel_' + id] = CHANNELS[id][0]; });
    life.addText(texts);

    // Office-wide safety cap on intern characters (the Office life setting interns.maxShown; mirrors
    // office_life/settings.py). 24 keeps a phone (4x CPU throttle) office smooth: see .work/v13/build/interns.md.
    var MAX_SHOWN = 24, MAX_SHOWN_MIN = 1, MAX_SHOWN_MAX = 48;
    var RING_FIRST = 34, RING_STEP = 24, RINGS = 6; // standing ring radii round the agent's desk (px)
    var STAND_GAP = 24;  // px between two interns' spots (a body is ~16 px wide)
    var SEAT_CLEAR = 30; // px kept clear round every agent's seat and every free desk
    var INTERN_COLORS = ['#26a69a', '#5c6bc0', '#ef6c00', '#8d6e63', '#7cb342', '#ec407a', '#00838f', '#6d4c41'];
    var FADE_MS = 400;
    var WALK_MAX_MS = 45000;
    var WAVE_MS = 900;
    var ENVELOPE_MS = 10 * 60000, ENVELOPES_PER_DESK = 3;
    var KNOCK_MS = 600;
    var RING_MS = 2500, CLOCK_MS = 15 * 60000, CLOCK_BADGE_MS = 5000, TAP_AT = 900, TAP_MS = 1400;
    var PLANE_WAIT_MS = 10000;
    var GIVE_MS = 1000, TAKE_MS = 600;
    var FOLDER_MS = 4000;

    var internCount = {};  // parent key -> count from the server
    var internsKnown = {}; // parent key -> helpers already running at page load (seated, no walk-in)
    var internShare = {};  // parent key -> intern characters it may show (the fair share under the cap)
    var maxShown = MAX_SHOWN;
    var stateSeen = false;
    var interns = [];      // {id, parent, index, ch, seat, phase, walkStart, waveUntil, fade}
    var couriers = [];     // {ch, agent, channel, session, target, phase, walkStart, knockAt, fade}
    var envelopes = [];    // {agent, channel, session, at, until, fade}
    var clocks = {};       // agent key -> {ref, name, at, ringUntil, until, badgeUntil, tapped}
    var folders = [];      // reduced motion handoffs: {from, to, at, until}
    var planeQueue = [];   // {from, to, at}: waiting for a free plane (3 at once)
    var hoverHit = null;   // what the pointer is over (its screen label shows)
    var hoverAt = 0;
    var HOVER_MS = 6000;   // no pointer move for that long: the label goes
    var seq = 0;
    var lastPlaneTry = 0;

    function H() { return life.host(); }
    function D() { return life.director(); }
    function SP() { return life.sprites(); }
    function on(name) { return life.isOn(name); }
    function now() { return Date.now(); }
    function agentOf(key) { var h = H(); return h && h.agent ? h.agent(key) : null; }
    function nameOf(key) { var a = agentOf(key); return life.clip((a && a.name) || key, 24); }
    function statusOf(a) { return a ? String(a._statusState || a.state || 'idle') : 'idle'; }
    function hash(s) { s = String(s); var h = 0; for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); }
    function channelInfo(id) {
        id = String(id || '').toLowerCase();
        var c = CHANNELS[id];
        return { id: id, label: c ? life.t('channel_' + id) : life.clip(id.charAt(0).toUpperCase() + id.slice(1), 20), tint: c ? c[1] : '#90a4ae' };
    }
    function deskOf(a) {
        var d = a && (a.desk || a._autoDesk);
        if (d && isFinite(d.x) && isFinite(d.y)) return { x: d.x, y: d.y };
        return a ? { x: a.x, y: a.y } : null;
    }
    function spotKey(p) { return Math.round(p.x / 12) + ',' + Math.round(p.y / 12); }
    function dist2(p, q) { return (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y); }
    function startFade(o, from, to) { o.fade = { from: from, to: to, at: now() }; if (o.ch) o.ch._lifeAlpha = from; }
    // Advance a fade; true when it just finished.
    function stepFade(o, t) {
        if (!o.fade) return false;
        var k = Math.min(1, (t - o.fade.at) / FADE_MS);
        var v = o.fade.from + (o.fade.to - o.fade.from) * k;
        if (o.ch) o.ch._lifeAlpha = v;
        o.alpha = v;
        if (k >= 1) { o.fade = null; return true; }
        return false;
    }
    function walkDone(ch, startedAt, t) {
        var st = H().walkStatus(ch);
        return st !== 'walking' || t - startedAt > WALK_MAX_MS;
    }
    // A short non-moving pose on an agent sitting quietly at its desk.
    function deskPose(key, kind, pose, ms, item) {
        var a = agentOf(key), d = D();
        if (!a || !d || d.current(key) || !a.isSitting || a.idleAction || a.meetingId || a._gatheringId || statusOf(a) === 'offline') return false;
        return d.request(key, { kind: kind, feature: 'crew', priority: 25, moves: false, maxMs: ms + 1500, staleMs: 1000,
            start: function (ctl) { ctl.pose(pose); if (item) ctl.carry(item); },
            update: function (ctl) { if (ctl.elapsed() >= ms) ctl.done(kind); } }) === 'started';
    }
    // A floor spot beside an agent (or its desk), on the side `side`.
    function besideAgent(key, side) {
        var a = agentOf(key), h = H();
        if (!a || !h.nearestWalkable) return null;
        var base = a.isSitting ? deskOf(a) : { x: a.x, y: a.y };
        return h.nearestWalkable(base.x + side * 32, base.y + 10, 2) || h.nearestWalkable(base.x - side * 32, base.y + 10, 2);
    }

    // ================= interns =================
    function okPoint(p) { return p && isFinite(p.x) && isFinite(p.y); }
    function clearOf(p, list, gap) {
        for (var i = 0; i < list.length; i++) if (dist2(p, list[i]) < gap * gap) return false;
        return true;
    }
    // Same room: no interior wall between the agent's desk and p (a door is a gap in the wall).
    function sameRoom(h, base, p) { return !h.wallBetween || !h.wallBetween(base.x, base.y, p.x, p.y); }
    function nearestFirst(h, base, list) {
        return list.map(function (p) { return { p: p, far: sameRoom(h, base, p) ? 0 : 1, d: dist2(p, base) }; })
            .sort(function (a, b) { return a.far - b.far || a.d - b.d; }).map(function (o) { return o.p; });
    }
    // Every agent's seat: nobody stands on one (or in the way of sitting down).
    function agentSeats(h) {
        return (h.agents ? h.agents() : []).map(function (a) { return a && (a.desk || a._autoDesk); }).filter(okPoint);
    }
    // A standing spot in rings round `base`: the sides first, then the front, behind last. Walkable (the host
    // keeps doorways and narrow gaps out), STAND_GAP from every other intern, SEAT_CLEAR from every seat and
    // free desk, and (room) on the agent's side of the walls.
    function ringSpot(h, base, taken, seats, room) {
        if (!h.walkable || !okPoint(base)) return null;
        for (var k = 0; k < RINGS; k++) {
            var r = RING_FIRST + k * RING_STEP, n = Math.max(6, Math.floor(2 * Math.PI * r / STAND_GAP)), cand = [];
            for (var j = 0; j < n; j++) {
                var th = (j + (k % 2) * 0.5) * 2 * Math.PI / n, c = Math.cos(th), s = Math.sin(th);
                cand.push({ x: Math.round(base.x + r * c), y: Math.round(base.y + 6 + r * s), pref: 1 - Math.abs(c) + (s < -0.2 ? 1.5 : 0), j: j });
            }
            cand.sort(function (p, q) { return p.pref - q.pref || p.j - q.j; });
            for (var i = 0; i < cand.length; i++) {
                var p = cand[i];
                if (!h.walkable(p.x, p.y) || !clearOf(p, taken, STAND_GAP) || !clearOf(p, seats, SEAT_CLEAR)) continue;
                if (room && !sameRoom(h, base, p)) continue;
                return { x: p.x, y: p.y };
            }
        }
        return null;
    }
    // Where the next intern of `parent` goes: the free desk nearest its agent (same room first), else a
    // standing spot in a ring round the agent's desk, else a lounge seat, else a spot near the front.
    function pickSeat(parent, sp) {
        var h = H(), a = agentOf(parent);
        sp = sp || (h.spots ? h.spots() : {});
        var taken = interns.filter(function (it) { return it.seat && it.phase !== 'fading'; }).map(function (it) { return it.seat; });
        var used = {};
        taken.forEach(function (p) { used[spotKey(p)] = 1; });
        var base = deskOf(a) || sp.front;
        if (!okPoint(base)) return null;
        // freeDesks already leaves out desks near any agent's seat (host, ~40 px).
        var free = (sp.freeDesks || []).filter(okPoint);
        var desks = nearestFirst(h, base, free.filter(function (d) { return !used[spotKey(d)]; }));
        if (desks.length) return { x: desks[0].x, y: desks[0].y, sit: true, kind: 'desk' };
        var seats = agentSeats(h).concat(free);
        var p = a && (a.desk || a._autoDesk) ? ringSpot(h, base, taken, seats, true) : null;
        if (p) return { x: p.x, y: p.y, sit: false, kind: 'shadow' };
        var lounge = nearestFirst(h, base, (sp.loungeSeats || []).filter(function (s) { return okPoint(s) && !used[spotKey(s)]; }));
        if (lounge.length) return { x: lounge[0].x, y: lounge[0].y, sit: true, kind: 'lounge' };
        var f = okPoint(sp.front) ? ringSpot(h, sp.front, taken, seats, false) || { x: sp.front.x, y: sp.front.y } : null;
        return f ? { x: f.x, y: f.y, sit: false, kind: 'front' } : null;
    }

    function arrive(parent, index, sp) {
        var h = H();
        sp = sp || h.spots();
        var front = sp.front;
        var seat = pickSeat(parent, sp);
        if (!seat || !front) return false;
        var id = 'intern-' + (++seq);
        // Already running when the page loaded (state snapshot): at the desk at once (N4).
        var calm = life.atDesk() || index < (internsKnown[parent] || 0);
        var start = calm ? seat : front;
        var ch = h.makeCharacter({ id: id, seed: parent + ':' + index, x: start.x, y: start.y,
            color: INTERN_COLORS[hash(parent + ':' + index) % INTERN_COLORS.length], decorate: decorateIntern, alpha: 0 });
        var it = { id: id, parent: parent, index: index, ch: ch, seat: seat, phase: 'walking', walkStart: now() };
        ch._lifeIntern = it;
        h.addExtra(ch);
        startFade(it, 0, 1);
        interns.push(it);
        if (calm) settle(it);
        else { h.carry(ch, 'clipboard'); h.walkTo(ch, seat.x, seat.y); }
        return true;
    }
    // On the seat (also when the walk stopped short): sit and type, or stand by.
    function settle(it) {
        var h = H(), ch = it.ch;
        h.place(ch, it.seat.x, it.seat.y, { sit: !!it.seat.sit });
        h.carry(ch, null);
        if (it.seat.sit) { ch.state = 'working'; h.pose(ch, null); }
        else { ch.state = 'idle'; h.pose(ch, 'shadow'); }
        var a = agentOf(it.parent);
        if (a) h.face(ch, a.x >= ch.x ? 1 : -1);
        it.phase = 'seated';
    }
    function leave(it) {
        var h = H(), ch = it.ch;
        ch.state = 'idle';
        h.sit(ch, false);
        if (life.atDesk()) { fadeOut(it); return; }
        h.pose(ch, 'wave');
        it.phase = 'waving';
        it.waveUntil = now() + WAVE_MS;
    }
    function goOut(it) {
        var h = H(), f = h.spots().front;
        h.pose(it.ch, null);
        if (!f || life.atDesk()) { fadeOut(it); return; }
        h.walkTo(it.ch, f.x, f.y);
        it.phase = 'leaving';
        it.walkStart = now();
    }
    function fadeOut(it) {
        it.phase = 'fading';
        startFade(it, it.ch._lifeAlpha == null ? 1 : it.ch._lifeAlpha, 0);
    }
    function dropIntern(it) {
        var h = H(), d = D();
        if (h) h.removeExtra(it.ch);
        if (d) d.give('interns');
        var i = interns.indexOf(it);
        if (i >= 0) interns.splice(i, 1);
        if (hoverHit && hoverHit.it === it) hoverHit = null;
    }
    function present(parent) {
        return interns.filter(function (it) { return it.parent === parent && it.phase !== 'waving' && it.phase !== 'leaving' && it.phase !== 'fading'; });
    }
    // One character per running helper; past the office cap every agent keeps a fair share (one each first,
    // then a second each, ...), so a busy agent never hides another agent's helpers.
    function shares() {
        var keys = Object.keys(internCount).filter(function (k) { return internCount[k] > 0 && agentOf(k); });
        var out = {}, left = maxShown, level = 0, more = true;
        keys.forEach(function (k) { out[k] = 0; });
        while (left > 0 && more) {
            more = false; level++;
            for (var i = 0; i < keys.length && left > 0; i++) {
                if (internCount[keys[i]] >= level) { out[keys[i]]++; left--; more = true; }
            }
        }
        return out;
    }
    function syncInterns() {
        var h = H(), d = D();
        if (!h || !d || !on('interns')) return;
        if (d.setCap) d.setCap('interns', maxShown);
        internShare = shares();
        interns.slice().forEach(function (it) {
            if (it.phase === 'waving' || it.phase === 'leaving' || it.phase === 'fading') return;
            if (it.index >= (internShare[it.parent] || 0) || !agentOf(it.parent)) leave(it);
        });
        var sp = null;
        Object.keys(internShare).forEach(function (parent) {
            var want = internShare[parent], have = {};
            present(parent).forEach(function (it) { have[it.index] = 1; });
            for (var i = 0; i < want; i++) {
                if (have[i]) continue;
                if (!d.take('interns')) return; // the cap is full until a leaving intern is gone
                sp = sp || h.spots();
                if (!arrive(parent, i, sp)) { d.give('interns'); return; }
            }
        });
    }
    function setInterns(parent, count) {
        parent = String(parent || '');
        if (!parent) return;
        count = Math.max(0, Math.floor(Number(count) || 0));
        if (count) internCount[parent] = count; else delete internCount[parent];
        if ((internsKnown[parent] || 0) > count) internsKnown[parent] = count; // a later new helper walks in
        syncInterns();
    }
    function updateInterns(t) {
        var gone = false;
        interns.slice().forEach(function (it) {
            if (stepFade(it, t) && it.phase === 'fading') { dropIntern(it); gone = true; return; }
            if (it.phase === 'walking' && walkDone(it.ch, it.walkStart, t)) settle(it);
            else if (it.phase === 'waving' && t >= it.waveUntil) goOut(it);
            else if (it.phase === 'leaving' && walkDone(it.ch, it.walkStart, t)) fadeOut(it);
        });
        if (gone) syncInterns(); // its place under the cap goes to a helper still waiting for one
    }
    function removeInterns() {
        interns.slice().forEach(dropIntern);
    }
    // Lanyard and an ID badge on the chest (local character coordinates).
    function decorateIntern(ctx, ch) {
        ctx.fillStyle = '#1e88e5';
        ctx.fillRect(-5, -20, 1, 6); ctx.fillRect(4, -20, 1, 6);
        ctx.fillRect(-4, -14, 1, 2); ctx.fillRect(3, -14, 1, 2);
        ctx.fillStyle = '#263238'; ctx.fillRect(-4, -13, 8, 6);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(-3, -12, 6, 4);
        ctx.fillStyle = '#1e88e5'; ctx.fillRect(-3, -12, 6, 1);
        ctx.fillStyle = '#90a4ae'; ctx.fillRect(-2, -10, 4, 1);
    }

    // ================= handoffs =================
    function plane(from, to) {
        var h = H();
        if (!agentOf(from) || !agentOf(to)) return false;
        if (h.plane && h.plane(from, to, 'folder')) return true;
        if (planeQueue.length < 12) planeQueue.push({ from: from, to: to, at: now() });
        return false;
    }
    function flushPlanes(t) {
        if (!planeQueue.length || t - lastPlaneTry < 300) return;
        lastPlaneTry = t;
        planeQueue = planeQueue.filter(function (p) { return t - p.at <= PLANE_WAIT_MS; });
        var h = H();
        while (planeQueue.length && h.planesInFlight && h.planesInFlight() < 3) {
            var p = planeQueue.shift();
            if (agentOf(p.from) && agentOf(p.to)) h.plane(p.from, p.to, 'folder');
        }
    }
    function handoffWalk(from, to) {
        return { kind: 'handoff', feature: 'crew', moves: true, forWork: false, label: life.t('holdHandoff'), maxMs: WALK_MAX_MS + 5000,
            data: { given: false, giveUntil: 0 },
            start: function (ctl) {
                var a = ctl.agent(), b = agentOf(to);
                var tgt = b && besideAgent(to, a && b && a.x < b.x ? -1 : 1);
                if (!tgt) { ctl.done('nowhere'); return; }
                ctl.carry('folder');
                ctl.walk(tgt.x, tgt.y, function (res) {
                    if (!ctl.active()) return;
                    if (!res || !res.ok) { ctl.done('blocked'); return; }
                    var r = agentOf(to), me = ctl.agent();
                    if (r && me) ctl.face(r.x >= me.x ? 1 : -1);
                    ctl.pose('give');
                    ctl.data.given = true;
                    ctl.data.giveUntil = now() + GIVE_MS;
                    deskPose(to, 'take', 'take', GIVE_MS, 'folder');
                });
            },
            update: function (ctl) {
                if (ctl.data.giveUntil && now() >= ctl.data.giveUntil) { ctl.carry(null); ctl.done('handed'); }
            },
            end: function (ctl) {
                // Cut short (real work, a meeting, calm mode): the folder still flies.
                if (!ctl.data.given) plane(from, to);
            } };
    }
    function onHandoff(ev) {
        if (!on('handoffs')) return;
        var from = String(ev.agent || ''), to = String(ev.to || '');
        var a = agentOf(from), b = agentOf(to), d = D();
        if (!a || !b || a === b || !d) return;
        if (life.reducedMotion()) {
            folders.push({ from: from, to: to, at: now(), until: now() + FOLDER_MS });
            if (folders.length > 6) folders.shift();
            return;
        }
        var st = statusOf(a);
        var idle = st !== 'working' && st !== 'finishing' && st !== 'offline' && !a.meetingId && !life.atDesk() && !d.current(from);
        if (idle && d.request(from, handoffWalk(from, to)) === 'started') return;
        plane(from, to);
    }

    // ================= visitors =================
    function onVisitor(ev) {
        if (!on('visitors')) return;
        var key = String(ev.agent || ''), a = agentOf(key), d = D(), h = H();
        var ch = channelInfo(ev.channel);
        if (!a || !ch.id || !d) return;
        var session = ev.session ? String(ev.session) : '';
        var walkOk = !life.atDesk() && statusOf(a) !== 'offline' && !(h.editMode && h.editMode());
        if (walkOk && d.take('couriers')) {
            if (sendCourier(key, ch, session)) return;
            d.give('couriers');
        }
        dropEnvelope(key, ch, session);
    }
    function sendCourier(key, chan, session) {
        var h = H(), f = h.spots().front;
        var target = besideAgent(key, 1);
        if (!f || !target) return false;
        var ch = h.makeCharacter({ id: 'courier-' + (++seq), seed: 'courier:' + chan.id + ':' + seq, x: f.x, y: f.y,
            color: '#455a64', decorate: decorateCourier, alpha: 0 });
        var c = { ch: ch, agent: key, chan: chan, session: session, target: target, phase: 'in', walkStart: now() };
        ch._lifeCourier = c;
        h.addExtra(ch);
        startFade(c, 0, 1);
        h.walkTo(ch, target.x, target.y);
        couriers.push(c);
        return true;
    }
    function updateCouriers(t) {
        var h = H();
        couriers.slice().forEach(function (c) {
            if (stepFade(c, t) && c.phase === 'fading') { dropCourier(c); return; }
            if (c.phase === 'in' && walkDone(c.ch, c.walkStart, t)) {
                var a = agentOf(c.agent);
                if (a) h.face(c.ch, a.x >= c.ch.x ? 1 : -1);
                c.phase = 'knock';
                c.knockAt = t;
                c.baseY = c.ch.y;
            } else if (c.phase === 'knock') {
                // Two small hops at the desk.
                var k = t - c.knockAt, hop = (k < 150 || (k >= 300 && k < 450)) ? 2 : 0;
                if (k < KNOCK_MS) { if (c.hop !== hop) { c.hop = hop; h.place(c.ch, c.ch.x, c.baseY - hop); } return; }
                if (c.hop) { c.hop = 0; h.place(c.ch, c.ch.x, c.baseY); }
                dropEnvelope(c.agent, c.chan, c.session);
                deskPose(c.agent, 'take', 'take', TAKE_MS);
                var f = h.spots().front;
                c.phase = 'out';
                c.walkStart = t;
                if (f) h.walkTo(c.ch, f.x, f.y);
            } else if (c.phase === 'out' && walkDone(c.ch, c.walkStart, t)) {
                c.phase = 'fading';
                startFade(c, c.ch._lifeAlpha == null ? 1 : c.ch._lifeAlpha, 0);
            }
        });
    }
    function dropCourier(c) {
        var h = H(), d = D();
        if (h) h.removeExtra(c.ch);
        if (d) d.give('couriers');
        var i = couriers.indexOf(c);
        if (i >= 0) couriers.splice(i, 1);
        if (hoverHit && hoverHit.c === c) hoverHit = null;
    }
    function removeCouriers() { couriers.slice().forEach(dropCourier); }
    function dropEnvelope(key, chan, session) {
        var t = now();
        var mine = envelopes.filter(function (e) { return e.agent === key; });
        var same = mine.filter(function (e) { return e.chan.id === chan.id; })[0];
        if (same) { same.until = t + ENVELOPE_MS; same.count = (same.count || 1) + 1; if (session) same.session = session; return; }
        if (mine.length >= ENVELOPES_PER_DESK) envelopes.splice(envelopes.indexOf(mine[0]), 1);
        var e = { agent: key, chan: chan, session: session, at: t, until: t + ENVELOPE_MS, count: 1 };
        startFade(e, 0, 1);
        envelopes.push(e);
        var h = H();
        if (h && h.markDirty) h.markDirty();
    }
    function clearEnvelopes(key) {
        var before = envelopes.length;
        envelopes = envelopes.filter(function (e) { return e.agent !== key; });
        if (before !== envelopes.length && H()) H().markDirty();
    }
    // Cap, satchel strap and bag; a channel-tinted envelope while delivering.
    function decorateCourier(ctx, ch, moving) {
        var c = ch._lifeCourier, dir = ch.faceDir < 0 ? -1 : 1;
        ctx.fillStyle = '#37474f'; ctx.fillRect(-12, -44, 24, 6);
        ctx.fillStyle = (c && c.chan.tint) || '#90a4ae'; ctx.fillRect(-12, -40, 24, 2);
        ctx.fillStyle = '#263238'; ctx.fillRect(dir > 0 ? 8 : -18, -39, 10, 2);
        ctx.fillStyle = '#6d4c41';
        for (var i = 0; i < 6; i++) ctx.fillRect(-9 + i * 3, -20 + i * 2, 2, 2);
        ctx.fillStyle = '#8d6e63'; ctx.fillRect(7, -10, 9, 8);
        ctx.fillStyle = '#6d4c41'; ctx.fillRect(7, -10, 9, 3);
        if (c && (c.phase === 'in' || c.phase === 'knock')) {
            var sp = SP();
            if (sp) sp.draw(ctx, 'envelope', dir * 4, -14, { tint: c.chan.tint });
        }
    }

    // ================= alarm clocks =================
    function onCronFire(ev) {
        if (!on('alarmClock')) return;
        var key = String(ev.agent || '');
        if (!agentOf(key)) return;
        var t = now();
        clocks[key] = { ref: ev.ref ? String(ev.ref) : '', name: ev.name ? String(ev.name) : '', at: t, ringUntil: t + RING_MS,
            until: t + CLOCK_MS, badgeUntil: life.reducedMotion() ? t + CLOCK_BADGE_MS : 0, tapped: false };
        var h = H();
        if (h && h.markBusy) h.markBusy(RING_MS);
    }
    function onCronDone(ev) {
        var key = String(ev.agent || ''), c = clocks[key];
        if (!c) return;
        if (ev.ref && c.ref && String(ev.ref) !== c.ref) return;
        delete clocks[key];
        if (H()) H().markDirty();
    }
    function updateClocks(t) {
        Object.keys(clocks).forEach(function (key) {
            var c = clocks[key];
            if (t > c.until || !agentOf(key)) { delete clocks[key]; return; }
            if (!c.tapped && t - c.at >= TAP_AT && t < c.ringUntil) {
                c.tapped = true;
                if (!life.reducedMotion()) deskPose(key, 'snooze', 'snooze', TAP_MS);
            }
        });
    }

    // ================= drawing =================
    function clockSpot(a) { var d = deskOf(a); return { x: d.x + 27, y: d.y - 12 }; }
    function envelopeSpot(a, i) { var d = deskOf(a); return { x: d.x - 26 + i * 3, y: d.y + 2 - i * 3 }; }
    function folderSpot(a) { var d = deskOf(a); return { x: d.x - 22, y: d.y - 10 }; }

    // Props on a desk (envelopes, the alarm clock, a handoff folder) of the
    // given desk owners: drawn with the desk, under everyone (z-order R3).
    function drawDesk(ctx, owners) {
        var sp = SP(), h = H();
        if (!sp || !h || (h.editMode && h.editMode()) || !owners || !owners.length) return;
        var t = now(), still = life.atDesk();
        var ownerOf = function (key) { var a = agentOf(key); return a && owners.indexOf(a) >= 0 ? a : null; };
        if (on('visitors')) {
            var perDesk = {};
            envelopes.forEach(function (e) {
                var a = ownerOf(e.agent);
                if (!a) return;
                var i = perDesk[e.agent] = (perDesk[e.agent] || 0);
                perDesk[e.agent]++;
                var p = envelopeSpot(a, i);
                sp.draw(ctx, 'envelope', p.x, p.y, { tint: e.chan.tint, alpha: e.alpha == null ? 1 : e.alpha });
            });
        }
        if (on('alarmClock')) {
            Object.keys(clocks).forEach(function (key) {
                var a = ownerOf(key), c = clocks[key];
                if (!a) return;
                var p = clockSpot(a), ringing = t < c.ringUntil;
                var shake = ringing && !still ? (((t / 60) | 0) % 2 ? 1 : -1) : 0;
                sp.draw(ctx, 'alarmClock', p.x + shake, p.y, null);
                if (ringing && !still) {
                    ctx.fillStyle = '#ffd54f';
                    var b = ((t / 160) | 0) % 2;
                    ctx.fillRect(p.x - 9 - b, p.y - 6, 2, 1); ctx.fillRect(p.x - 10 - b, p.y - 3, 2, 1);
                    ctx.fillRect(p.x + 8 + b, p.y - 6, 2, 1); ctx.fillRect(p.x + 9 + b, p.y - 3, 2, 1);
                }
            });
        }
        if (on('handoffs')) {
            folders = folders.filter(function (f) { return t < f.until; });
            folders.forEach(function (f) {
                var a = ownerOf(f.to);
                if (!a) return;
                var p = folderSpot(a), left = f.until - t;
                sp.draw(ctx, 'folder', p.x, p.y, { alpha: Math.min(1, (t - f.at) / FADE_MS, left / FADE_MS) });
            });
        }
    }

    // Screen rect of a world box (x, y = centre, w, h in world px).
    function screenBox(h, x, y, w, hh) {
        var p = h.worldToCanvas(x - w / 2, y - hh / 2), q = h.worldToCanvas(x + w / 2, y + hh / 2);
        return { x: p.x, y: p.y, w: q.x - p.x, h: q.y - p.y };
    }
    function bodyBox(h, ch) { return screenBox(h, ch.x, ch.y - 22, 28, 52); }

    function hitTest(x, y, touch) {
        var h = H(), sp = SP();
        if (!h || !sp || !h.worldToCanvas || (h.editMode && h.editMode())) return null;
        var i;
        if (on('visitors')) {
            for (i = couriers.length - 1; i >= 0; i--) {
                if (couriers[i].phase !== 'fading' && sp.hitRect(bodyBox(h, couriers[i].ch), x, y, touch)) return { kind: 'courier', c: couriers[i], key: couriers[i].agent };
            }
        }
        if (on('interns')) {
            for (i = interns.length - 1; i >= 0; i--) {
                if (interns[i].phase !== 'fading' && sp.hitRect(bodyBox(h, interns[i].ch), x, y, touch)) return { kind: 'intern', it: interns[i], key: interns[i].parent };
            }
        }
        var perDesk = {};
        if (on('visitors')) {
            for (i = 0; i < envelopes.length; i++) {
                var e = envelopes[i], a = agentOf(e.agent);
                if (!a) continue;
                var n = perDesk[e.agent] = (perDesk[e.agent] || 0);
                perDesk[e.agent]++;
                var p = envelopeSpot(a, n);
                if (sp.hitRect(screenBox(h, p.x, p.y, 14, 10), x, y, touch)) return { kind: 'envelope', e: e, key: e.agent };
            }
        }
        if (on('alarmClock')) {
            for (var key in clocks) {
                var ca = agentOf(key);
                if (!ca) continue;
                var cp = clockSpot(ca);
                if (sp.hitRect(screenBox(h, cp.x, cp.y, 12, 12), x, y, touch)) return { kind: 'clock', key: key, clock: clocks[key] };
            }
        }
        if (on('handoffs')) {
            for (i = 0; i < folders.length; i++) {
                var fa = agentOf(folders[i].to);
                if (!fa) continue;
                var fp = folderSpot(fa);
                if (sp.hitRect(screenBox(h, fp.x, fp.y, 12, 10), x, y, touch)) return { kind: 'folder', key: folders[i].to };
            }
        }
        return null;
    }
    function stillThere(hit) {
        if (!hit) return false;
        if (hit.kind === 'intern') return interns.indexOf(hit.it) >= 0;
        if (hit.kind === 'courier') return couriers.indexOf(hit.c) >= 0;
        if (hit.kind === 'envelope') return envelopes.indexOf(hit.e) >= 0;
        if (hit.kind === 'clock') return clocks[hit.key] === hit.clock;
        if (hit.kind === 'folder') return folders.some(function (f) { return f.to === hit.key; });
        return false;
    }
    function hitLabel(hit) {
        if (hit.kind === 'intern') return life.t('helperFor', { name: nameOf(hit.it.parent) });
        if (hit.kind === 'courier') return life.t('messageFrom', { channel: hit.c.chan.label });
        if (hit.kind === 'envelope') return life.t('messageFrom', { channel: hit.e.chan.label });
        if (hit.kind === 'clock') return hit.clock.name ? life.t('scheduledJob', { label: life.clip(hit.clock.name, 32) }) : life.t('scheduledJobPlain');
        if (hit.kind === 'folder') return life.t('handoffTo', { name: nameOf(hit.key) });
        return '';
    }
    function hitAnchor(h, hit) {
        var ch = hit.kind === 'intern' ? hit.it.ch : hit.kind === 'courier' ? hit.c.ch : null;
        if (ch) return h.worldToCanvas(ch.x, ch.y - 50);
        var a = agentOf(hit.key);
        if (!a) return null;
        var p = hit.kind === 'clock' ? clockSpot(a) : hit.kind === 'folder' ? folderSpot(a) : envelopeSpot(a, 0);
        return h.worldToCanvas(p.x, p.y - 8);
    }

    function drawScreen(ctx) {
        var h = H(), sp = SP();
        if (!h || !sp || (h.editMode && h.editMode())) return;
        var t = now();
        var taken = []; // screen rects of the chips and tags drawn so far
        // "5 helpers" beside the name tag: how many helpers the agent has running (the server's count of its running
        // subagent / background sessions). Each has its own intern; past the office cap: "30 helpers · 24 shown".
        if (on('interns')) {
            Object.keys(internCount).forEach(function (parent) {
                var a = agentOf(parent), n = internCount[parent] || 0, shown = internShare[parent];
                if (!a || n <= 0 || !a._ctl || !a._ctl.tag) return;
                var tag = a._ctl.tag;
                var text = shown != null && shown < n ? life.t('helpersShown', { n: n, shown: shown })
                    : n === 1 ? life.t('helpersOne') : life.t('helpersMany', { n: n });
                var r = sp.label(ctx, text, tag.x - 4, tag.y + tag.h / 2,
                    { kind: 'neutral', anchor: 'center', align: 'right' });
                if (r) taken.push(r);
            });
        }
        // N4: every helper wears a small INTERN name tag (readable at normal zoom). With many interns round one
        // desk a tag that would cover another tag, a helper chip or an agent's name tag is left out.
        if (on('interns') && h.extraTag && interns.length) {
            (h.agents ? h.agents() : []).forEach(function (a) {
                var c = a && a._ctl;
                if (!c) return;
                [c.tag, c.chip].forEach(function (r) { if (r && isFinite(r.x) && isFinite(r.w)) taken.push(r); });
            });
            interns.forEach(function (it) {
                var r = h.extraTag(it.ch, life.t('internTag'), '#455a64', { avoid: taken });
                if (r) taken.push(r);
            });
        }
        // Reduced motion: a short alarm badge instead of the ringing.
        if (on('alarmClock')) {
            Object.keys(clocks).forEach(function (key) {
                var c = clocks[key], a = agentOf(key);
                if (!a || !c.badgeUntil || t > c.badgeUntil) return;
                var p = clockSpot(a), q = h.worldToCanvas(p.x, p.y - 8);
                sp.label(ctx, '', q.x, q.y, { kind: 'warning', icon: 'alarmClock' });
            });
        }
        if (hoverHit && t - hoverAt < HOVER_MS && stillThere(hoverHit)) {
            var at = hitAnchor(h, hoverHit);
            if (at) sp.label(ctx, hitLabel(hoverHit), at.x, at.y, { kind: 'neutral' });
        }
    }

    function click(x, y, touch) {
        var hit = hitTest(x, y, touch), h = H();
        if (!hit || !h || !h.openChat) return false;
        if (hit.kind === 'intern') { h.openChat(hit.key, { panel: 'tasks' }); return true; }
        if (hit.kind === 'courier' || hit.kind === 'envelope') {
            var session = hit.kind === 'courier' ? hit.c.session : hit.e.session;
            clearEnvelopes(hit.key);
            h.openChat(hit.key, session ? { sessionKey: session } : {});
            return true;
        }
        return false; // clocks and desk folders only show their label
    }

    function busy() {
        var t = now();
        if (interns.some(function (it) { return it.fade; }) || couriers.length || envelopes.some(function (e) { return e.fade; })) return true;
        for (var k in clocks) if (t < clocks[k].ringUntil) return true;
        return folders.length > 0;
    }

    // ================= state =================
    function track(ev) {
        if (!ev || !ev.type) return;
        switch (ev.type) {
            case 'interns.set': setInterns(ev.agent, ev.count); break;
            case 'handoff': onHandoff(ev); break;
            case 'visitor': onVisitor(ev); break;
            case 'cron.fire': onCronFire(ev); break;
            case 'cron.done': onCronDone(ev); break;
        }
    }
    function syncState(snap) {
        var map = (snap && snap.open && snap.open.interns && typeof snap.open.interns === 'object') ? snap.open.interns : {};
        Object.keys(internCount).forEach(function (k) { if (!map[k]) delete internCount[k]; });
        Object.keys(map).forEach(function (k) { var n = Math.floor(Number(map[k]) || 0); if (n > 0) internCount[k] = n; });
        // The first snapshot after the page loads: those helpers were already working.
        if (!stateSeen) { stateSeen = true; Object.keys(internCount).forEach(function (k) { internsKnown[k] = internCount[k]; }); }
        syncInterns();
    }
    function anyOn() { return on('interns') || on('handoffs') || on('visitors') || on('alarmClock'); }
    // Office life setting interns.maxShown: the office-wide safety cap on intern characters.
    function readMaxShown(s) {
        var v = Math.floor(Number(s && s.interns && s.interns.maxShown));
        maxShown = isFinite(v) && v >= MAX_SHOWN_MIN ? Math.min(MAX_SHOWN_MAX, v) : MAX_SHOWN;
    }
    if (life.settings) readMaxShown(life.settings());
    function cancelScripts(kind, reason) {
        var d = D();
        if (!d) return;
        d.runningKeys().forEach(function (k) {
            var cur = d.current(k);
            if (cur && cur.feature === 'crew' && (!kind || cur.kind === kind)) d.cancel(k, reason, { feature: 'crew' });
        });
    }
    function applyParts() {
        if (!on('interns')) removeInterns(); else syncInterns();
        if (!on('visitors')) { removeCouriers(); envelopes = []; }
        if (!on('alarmClock')) clocks = {};
        if (!on('handoffs')) { planeQueue = []; folders = []; cancelScripts('handoff', 'off'); }
    }
    function resetAll() {
        removeInterns();
        removeCouriers();
        envelopes = []; clocks = {}; folders = []; planeQueue = []; hoverHit = null;
    }

    // Interns are tracked (data only) while the whole feature is off, so
    // switching it on shows the helpers that are really running.
    if (root.addEventListener) {
        root.addEventListener('vo:life-event', function (e) {
            if (!anyOn() && life.enabled() && e.detail && e.detail.type === 'interns.set') {
                var n = Math.max(0, Math.floor(Number(e.detail.count) || 0)), k = String(e.detail.agent || '');
                if (n) internCount[k] = n; else delete internCount[k];
            }
        });
        root.addEventListener('vo:life-state', function () { if (!anyOn() && life.enabled()) syncState(life.snapshot()); });
        // The agent's chat was opened: its envelopes are read.
        root.addEventListener('vo:chat-opened-agent', function (e) {
            var id = e && e.detail && e.detail.agentId, a = id && agentOf(id);
            if (a) clearEnvelopes(a.statusKey || id);
            else if (id) clearEnvelopes(String(id));
        });
    }

    // root.VOLifeCrew: the registered feature (tests and debugging read its _ helpers).
    root.VOLifeCrew = life.feature('crew', {
        setting: ['interns', 'handoffs', 'visitors', 'alarmClock'],
        order: 20,
        // Real handoffs replace the guessed chat-poll planes while the stream is live.
        claims: { sendPlanes: 'handoffs' },
        onState: syncState,
        onEvent: track,
        onSettings: function (s) { readMaxShown(s); if (anyOn()) applyParts(); else { resetAll(); cancelScripts('', 'off'); } },
        update: function (t) {
            updateInterns(t);
            updateCouriers(t);
            updateClocks(t);
            flushPlanes(t);
            for (var i = envelopes.length - 1; i >= 0; i--) {
                stepFade(envelopes[i], t);
                if (t > envelopes[i].until) envelopes.splice(i, 1);
            }
        },
        drawDesk: drawDesk,
        drawScreen: drawScreen,
        click: click,
        hover: function (x, y) { hoverHit = hitTest(x, y, false); hoverAt = now(); return !!hoverHit; },
        isBusy: busy,
        onRoster: function () { syncInterns(); },
        reset: function (reason) {
            if (reason === 'calm') {
                // No walking: helpers on their way sit down now, couriers leave their envelope.
                interns.forEach(function (it) { if (it.phase === 'walking') settle(it); else if (it.phase === 'waving' || it.phase === 'leaving') fadeOut(it); });
                couriers.slice().forEach(function (c) { if (c.phase !== 'out' && c.phase !== 'fading') dropEnvelope(c.agent, c.chan, c.session); dropCourier(c); });
                cancelScripts('handoff', 'calm');
                return;
            }
            resetAll();
        },
        // Tests / debugging.
        _debug: function () {
            return { internCount: Object.assign({}, internCount), internShare: Object.assign({}, internShare), maxShown: maxShown,
                interns: interns.map(function (it) { return { parent: it.parent, index: it.index, phase: it.phase, seat: it.seat && it.seat.kind, x: Math.round(it.ch.x), y: Math.round(it.ch.y),
                    sx: it.seat && it.seat.x, sy: it.seat && it.seat.y }; }),
                couriers: couriers.map(function (c) { return { agent: c.agent, channel: c.chan.id, phase: c.phase }; }),
                envelopes: envelopes.map(function (e) { return { agent: e.agent, channel: e.chan.id, count: e.count }; }),
                clocks: Object.keys(clocks).map(function (k) { return { agent: k, name: clocks[k].name, ringing: now() < clocks[k].ringUntil }; }),
                folders: folders.length, planeQueue: planeQueue.length };
        }
    });
})(typeof window !== 'undefined' ? window : globalThis);
