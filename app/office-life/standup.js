// Office life: Morning stand-up (feature 6, design .work/life/design.md 3.6).
// The server (scheduler) decides when a stand-up happens, who is in it and
// every line (templated from the journal): `standup.start {id, status:'open',
// lines:[{agent, line, remote}], summary, participants}` then `standup.end`.
// This module only stages it: agents who are free walk to the meeting table
// (else a semicircle at the front spot) and face it; speakers go in roster
// order, one speech card at a time above the speaker; remote participants
// (working, in a real meeting, or refused by the director) speak from their
// desks with a phone icon; a short summary card closes it. Phone: one caption
// bar under the top bar instead of cards (tap opens Meetings history). Calm /
// reduced motion: nobody walks, lines show above the desks. A tab that comes
// in too late gets a one-time note "Stand-up notes are in Meetings".
// Zero inference: every word on screen comes from the event or LIFE_TEXT.
(function (root) {
    'use strict';
    var life = root.VOLife;
    if (!life) return;

    life.addText({
        standupProgress: '{i} of {n}', standupOpenHistory: 'Open Meetings history',
        standupCaption: '{name}: {line}'
    });

    var GATHER_MS = 10000;        // walk-in before the first speaker
    var SPEAK_MS = 5000;          // design: 5 s each
    var SPEAK_MIN_MS = 2500;      // many speakers: shorter turns (budget below)
    var SPEAK_BUDGET_MS = 75000;  // the server ends the stand-up 90 s after start
    var SUMMARY_MS = 6000;
    var LIVE_MAX_AGE = 10 * 60000; // older than this: notes only (design)
    var LATE_NOTE_MS = 12000;
    var FADE_MS = 180;
    var CARD_MAX_W = 260, CARD_MIN_W = 132;

    var cur = null;               // the stand-up being staged
    var lateShown = {};           // ids that already showed the late note
    var cap = null;               // caption bar {wrap, btn, text, until, key}
    var lastSig = '';

    function H() { return life.host(); }
    function D() { return life.director(); }
    function SP() { return life.sprites(); }
    function sNow() { return life.serverNow ? life.serverNow() : Date.now(); }
    function toMs(v) { v = Number(v); if (!v) return 0; return v < 1e12 ? v * 1000 : v; }
    function agentOf(key) { var h = H(); return h && h.agent ? h.agent(key) : null; }
    function nameOf(key) { var a = agentOf(key); return life.clip((a && a.name) || key, 24); }
    function compact() { var h = H(); return !!(h && h.compact && h.compact()); }
    function busy(ms) { var h = H(); if (h && h.markBusy) h.markBusy(ms || 600); }
    function rosterIndex() {
        var h = H(), out = {};
        ((h && h.agents && h.agents()) || []).forEach(function (a, i) { out[a.statusKey || a.id] = i; });
        return out;
    }
    function isWorking(a) { var s = String((a && (a._statusState || a.state)) || ''); return s === 'working' || s === 'finishing'; }

    // ---- places: meeting table slots, else a semicircle at the front ----
    // Centre seats first, alternating the two rows, so a small stand-up
    // gathers in the middle of the table.
    var SEAT_ORDER = [2, 7, 1, 6, 3, 8, 0, 5, 4, 9];
    function places(n) {
        var h = H();
        var sp = (h && h.spots && h.spots()) || {};
        var realMeeting = ((h && h.agents && h.agents()) || []).some(function (a) { return a.meetingId; });
        var slots = !realMeeting && Array.isArray(sp.meetingSlots) ? sp.meetingSlots : [];
        var out = [];
        if (slots.length >= 2) {
            // v0.10.1 slots come best seat first (with a kind); older ones: SEAT_ORDER
            var order = slots.length === 10 && !('kind' in slots[0]) ? SEAT_ORDER : slots.map(function (s, i) { return i; });
            for (var i = 0; i < order.length && out.length < n; i++) if (slots[order[i]]) out.push({ x: slots[order[i]].x, y: slots[order[i]].y });
            var cx = 0, cy = 0, maxY = -1e9;
            slots.forEach(function (s) { cx += s.x; cy += s.y; maxY = Math.max(maxY, s.y); });
            cx /= slots.length;
            // The title: above the table when that is clear (titleSpot), else under it.
            var minY = 1e9, cyy = cy / slots.length;
            slots.forEach(function (s) { minY = Math.min(minY, s.y); });
            var box = ((h.artRects && h.artRects()) || []).filter(function (r) {
                return r.type === 'meetingTable' && cx >= r.x && cx <= r.x + r.w && cyy >= r.y && cyy <= r.y + r.h;
            })[0] || null;
            return { seats: out, centre: { x: cx, y: cyy }, title: { x: cx, y: maxY + 30 }, top: minY, box: box, where: 'table' };
        }
        var f = sp.front;
        if (!f) return { seats: [], centre: null, where: 'desks' };
        // Semicircle above the front spot, facing it.
        var count = Math.min(n, 9), r = 44 + count * 6;
        for (var k = 0; k < count; k++) {
            var ang = Math.PI * (count === 1 ? 0.5 : 0.12 + 0.76 * k / (count - 1));
            var x = f.x + Math.cos(ang) * r, y = f.y - Math.sin(ang) * r * 0.62;
            var p = h.nearestWalkable ? h.nearestWalkable(x, y, 2) : { x: x, y: y };
            if (p) out.push({ x: Math.round(p.x), y: Math.round(p.y) });
        }
        return { seats: out, centre: { x: f.x, y: f.y - r * 0.4 }, title: { x: f.x, y: f.y + 26 }, where: 'front' };
    }

    // ---- timeline (server clock, so every tab speaks in step) ----
    function timeline(n) {
        var speak = Math.max(SPEAK_MIN_MS, Math.min(SPEAK_MS, Math.floor(SPEAK_BUDGET_MS / Math.max(1, n))));
        return { speak: speak, total: GATHER_MS + n * speak + SUMMARY_MS };
    }
    function phaseAt(t) {
        if (!cur) return { phase: 'over' };
        var e = t - cur.at;
        if (e < GATHER_MS) return { phase: 'gather', idx: -1 };
        var i = Math.floor((e - GATHER_MS) / cur.speak);
        if (i < cur.lines.length) return { phase: 'speak', idx: i, since: (e - GATHER_MS) - i * cur.speak };
        if (e < cur.total) return { phase: 'summary', idx: cur.lines.length, since: e - GATHER_MS - cur.lines.length * cur.speak };
        return { phase: 'over' };
    }

    // ---- staging ----
    function begin(ev, fromState) {
        if (!ev || ev.status === 'skipped' || ev.status === 'done') return;
        var id = String(ev.id || '');
        if (cur && cur.id === id) { gather(); return; } // already staged (a resync ended the walks: gather again)
        if (cur) finish('replaced');
        var at = toMs(ev.at) || sNow();
        var idx = rosterIndex();
        var lines = (Array.isArray(ev.lines) ? ev.lines : []).filter(function (l) {
            return l && l.agent && l.line && idx[l.agent] != null;
        }).map(function (l) { return { agent: String(l.agent), line: String(l.line), remote: l.remote === true }; });
        lines.sort(function (a, b) { return idx[a.agent] - idx[b.agent]; });
        var tl = timeline(lines.length);
        var age = sNow() - at;
        if (!lines.length) return;
        if (age > LIVE_MAX_AGE || age > tl.total) { late(id); return; }
        cur = { id: id, at: at, lines: lines, speak: tl.speak, total: tl.total, summary: String(ev.summary || ''),
            people: {}, place: null, phase: '', idx: -2, ended: false, fromState: !!fromState };
        lines.forEach(function (l) { cur.people[l.agent] = { key: l.agent, mode: l.remote ? 'remote' : 'desk', seat: null, ctl: null, why: '' }; });
        gather();
        busy(800);
    }

    function gather() {
        if (!cur) return;
        var d = D();
        var free = cur.lines.filter(function (l) { var p = cur.people[l.agent]; return !l.remote && p.mode === 'desk' && !p.ctl; });
        if (!d || life.atDesk() || !free.length) return;
        var ph = phaseAt(sNow());
        if (ph.phase === 'summary' || ph.phase === 'over') return;
        if (!cur.place) cur.place = places(free.length + Object.keys(cur.people).filter(function (k) { return cur.people[k].seat; }).length);
        var taken = {};
        Object.keys(cur.people).forEach(function (k) { var s = cur.people[k].seat; if (s) taken[s.x + ',' + s.y] = 1; });
        var seats = cur.place.seats.filter(function (s) { return !taken[s.x + ',' + s.y]; });
        var left = cur.total - (sNow() - cur.at);
        free.forEach(function (l) {
            var p = cur.people[l.agent];
            var seat = seats.shift();
            if (!seat) return; // more people than places: this one speaks from its desk
            var id = cur.id;
            var res = d.request(l.agent, {
                kind: 'standup', feature: 'standup', moves: true, label: life.t('holdStandup'),
                maxMs: left + 15000, staleMs: 12000,
                start: function (ctl) {
                    if (!cur || cur.id !== id) { ctl.done('over'); return; }
                    p.ctl = ctl; p.seat = seat; p.back = 0;
                    toSeat(p, ctl);
                },
                update: function (ctl) {
                    if (!cur || cur.id !== id) { ctl.done('over'); return; }
                    // Something else moved the agent off its place at the table (B5): walk it
                    // back once or twice, then it joins by phone, so what is drawn matches the state.
                    var a = ctl.agent();
                    if (p.mode !== 'table' || !p.seat || !p.at || !a || ctl.walking()) return;
                    if (Math.abs(a.x - p.at.x) <= 12 && Math.abs(a.y - p.at.y) <= 12) return;
                    if (++p.back <= 2 && !a.isSitting) { var h = H(); if (h && h.hold) h.hold(l.agent, 'standup', { label: life.t('holdStandup') }); toSeat(p, ctl); }
                    else ctl.done('moved');
                },
                end: function (ctl, reason) {
                    if (p.ctl !== ctl) return;
                    p.ctl = null; p.seat = null;
                    // Pulled back to real work mid stand-up (or away from the table): the line comes from the desk, by phone.
                    if (cur && cur.id === id && p.mode !== 'done') p.mode = reason === 'work' || reason === 'meeting' || reason === 'moved' ? 'remote' : 'desk';
                },
                dropped: function () { p.why = 'stale'; }
            });
            if (res === 'refused') {
                p.mode = isWorking(agentOf(l.agent)) ? 'remote' : 'desk';
                p.why = typeof document !== 'undefined' && document.hidden ? 'hidden' : 'refused';
                seats.unshift(seat);
            } else if (res === 'queued') {
                p.why = 'queued';
            }
        });
    }
    function toSeat(p, ctl) {
        var seat = p.seat;
        p.mode = 'walking';
        ctl.walk(seat.x, seat.y, function (r) {
            if (!ctl.active()) return;
            if (r && r.ok) { var a = ctl.agent(); p.at = a ? { x: a.x, y: a.y } : { x: seat.x, y: seat.y }; p.mode = 'table'; faceTable(p); pose(p); }
            else { p.mode = 'desk'; p.seat = null; ctl.done('nowalk'); }
        });
    }
    function faceTable(p) {
        if (!p.ctl || !cur || !cur.place || !cur.place.centre) return;
        var a = p.ctl.agent();
        if (a) p.ctl.face(cur.place.centre.x >= a.x ? 1 : -1);
    }
    function pose(p) {
        if (!p.ctl || !p.ctl.active() || p.mode !== 'table') return;
        var speaking = cur && cur.phase === 'speak' && cur.lines[cur.idx] && cur.lines[cur.idx].agent === p.key;
        p.ctl.pose(speaking ? 'clipboard' : 'watch', { still: life.reducedMotion() });
    }

    function finish(reason) {
        var d = D();
        var was = cur;
        cur = null;
        if (was && d) {
            Object.keys(was.people).forEach(function (k) {
                was.people[k].mode = 'done';
                d.cancel(k, reason || 'over', { feature: 'standup' });
            });
        }
        if (cap && cap.key && cap.key.indexOf('late:') !== 0) hideCaption();
        busy(400);
    }

    function late(id) {
        if (!id || lateShown[id]) return;
        lateShown[id] = 1;
        showCaption('late:' + id, life.t('standupLate'), null, LATE_NOTE_MS);
    }

    function openHistory() {
        try {
            if (typeof root.openMeetingsDashboard === 'function') root.openMeetingsDashboard();
            if (typeof root.switchMtgTab === 'function') root.switchMtgTab('completed');
        } catch (e) {}
    }

    // ---- caption bar (phone, or the speaker is off screen; also the late note) ----
    function ensureCaption() {
        if (cap && cap.wrap.isConnected) return cap;
        var layer = life.layer && life.layer();
        if (!layer || typeof document === 'undefined') return null;
        var wrap = document.createElement('div');
        wrap.className = 'vo-life-standup-cap';
        wrap.setAttribute('data-vo-life', 'standup');
        wrap.setAttribute('role', 'status');
        wrap.setAttribute('aria-live', 'polite');
        wrap.style.cssText = 'position:absolute;left:8px;top:8px;max-width:min(520px,calc(100% - 16px));pointer-events:none;';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vo-life-pill vo-life-pill--neutral';
        btn.style.cssText = 'pointer-events:auto;white-space:normal;text-align:left;max-width:100%;display:flex;gap:8px;align-items:center;line-height:1.3;';
        btn.title = life.t('standupOpenHistory');
        var icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.style.cssText = 'flex:none;width:14px;height:16px;image-rendering:pixelated;';
        var text = document.createElement('span');
        text.style.cssText = 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
        btn.appendChild(icon);
        btn.appendChild(text);
        btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openHistory(); });
        wrap.appendChild(btn);
        wrap.hidden = true;
        layer.appendChild(wrap);
        cap = { wrap: wrap, btn: btn, icon: icon, text: text, key: '', until: 0 };
        return cap;
    }
    function iconURL(name) {
        var sp = SP();
        var c = sp && sp.get ? sp.get(name, 2) : null;
        try { return c && c.toDataURL ? c.toDataURL() : ''; } catch (e) { return ''; }
    }
    function showCaption(key, text, iconName, ms) {
        var c = ensureCaption();
        if (!c) return;
        c.until = ms ? Date.now() + ms : 0;
        if (c.key === key && !c.wrap.hidden) return;
        c.key = key;
        c.text.textContent = text;
        var url = iconURL(iconName || 'clipboard');
        c.icon.style.background = url ? 'url(' + url + ') center / contain no-repeat' : 'none';
        c.wrap.hidden = false;
        placeCaption();
    }
    function hideCaption() {
        if (!cap) return;
        cap.key = '';
        cap.until = 0;
        cap.wrap.hidden = true;
    }
    function placeCaption() {
        var h = H();
        if (!cap || cap.wrap.hidden || !h || !h.view) return;
        var v = h.view();
        var w = cap.wrap.offsetWidth || 240, hh = cap.wrap.offsetHeight || 34;
        var r = { x: Math.max(8, Math.round((v.w - w) / 2)), y: 8, w: w, h: hh };
        if (h.keepOutOfChrome) r = h.keepOutOfChrome(r, null, 6) || r;
        cap.wrap.style.left = Math.round(r.x) + 'px';
        cap.wrap.style.top = Math.round(r.y) + 'px';
    }

    // ---- screen drawing ----
    function anchorFor(a, h, m) {
        var c = a._ctl;
        if (c && c.launcher) return { x: c.launcher.x + c.launcher.w / 2, y: c.launcher.y - m.gap };
        if (!h.worldToCanvas) return null;
        var p = h.worldToCanvas(a.x + (a._tagDx || 0), a.y - 68 + (a._tagDy || 0));
        return { x: p.x, y: p.y - m.gap * 2 - m.h };
    }
    function wrapText(ctx, text, maxW, maxLines) {
        var words = String(text).split(/\s+/), lines = [], line = '';
        for (var i = 0; i < words.length; i++) {
            var next = line ? line + ' ' + words[i] : words[i];
            if (ctx.measureText(next).width <= maxW || !line) { line = next; continue; }
            lines.push(line);
            line = words[i];
            if (lines.length === maxLines) break;
        }
        if (lines.length < maxLines && line) lines.push(line);
        else if (line && lines.length === maxLines) {
            var last = lines[maxLines - 1];
            while (last.length > 1 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
            lines[maxLines - 1] = last + '…';
        }
        lines = lines.map(function (l) {
            if (ctx.measureText(l).width <= maxW) return l;
            while (l.length > 1 && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1);
            return l + '…';
        });
        return lines;
    }
    var PAPER = { bg: '#fffdf4', border: '#3e2723', text: '#1d1d1f', muted: '#6d6a63' };
    var PHONE = { bg: '#eef5ff', border: '#0d2440', text: '#0b1a2e', muted: '#4b6584' };
    // A pixel speech card: notched corners, 1 px border, a stepped tail to the
    // speaker. Returns the rect. (x, y) = the tail tip.
    function card(ctx, x, y, o) {
        var h = H(), m = (h && h.ctlMetrics && h.ctlMetrics()) || { h: 22, gap: 3, font: '600 11px Inter, system-ui, sans-serif' };
        var big = m.h >= 24, fs = big ? 12 : 11, lh = fs + 4, pad = 7;
        // Title and side note in the pixel font; the spoken lines are body text in the UI font (Q-05).
        var bold = '600 ' + fs + 'px Inter, system-ui, sans-serif', body = fs + 'px Inter, system-ui, sans-serif';
        var PF = window.VOPixelFont;
        var col = o.phone ? PHONE : PAPER;
        ctx.save();
        ctx.font = body;
        var lines = wrapText(ctx, o.text, CARD_MAX_W - pad * 2, 3);
        var bw = lines.reduce(function (w, l) { return Math.max(w, ctx.measureText(l).width); }, 0);
        ctx.font = bold;
        var iconW = o.icon ? 12 : (o.dot ? 9 : 0);
        var title = o.title || '';
        var tw = (PF && PF.has(title) ? PF.measure(title) : ctx.measureText(title).width) + iconW;
        ctx.font = body;
        var sidePixel = !!(o.side && PF && PF.has(o.side));
        var side = o.side ? (sidePixel ? PF.measure(o.side) : ctx.measureText(o.side).width) + 10 : 0;
        var w = Math.round(Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, bw + pad * 2, tw + side + pad * 2)));
        var hh = pad * 2 + lh * (lines.length + (title ? 1 : 0)) - 2;
        var tail = o.tail === false ? 0 : 6;
        var r = { x: Math.round(x - w / 2), y: Math.round(y - tail - hh), w: w, h: hh };
        if (h && h.keepOutOfChrome) r = h.keepOutOfChrome(r, null, 4) || r;
        if (SP() && SP().clampToView) r = SP().clampToView(r); // UI-23
        if (o.alpha != null && o.alpha < 1) ctx.globalAlpha *= Math.max(0, o.alpha);
        // shadow: the chip family's 2 px hard drop shadow
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(r.x + 1, r.y + 2, r.w - 2, r.h);
        ctx.fillStyle = col.border;
        ctx.fillRect(r.x + 1, r.y, r.w - 2, r.h);
        ctx.fillRect(r.x, r.y + 1, r.w, r.h - 2);
        ctx.fillStyle = col.bg;
        ctx.fillRect(r.x + 2, r.y + 1, r.w - 4, r.h - 2);
        ctx.fillRect(r.x + 1, r.y + 2, r.w - 2, r.h - 4);
        var tx = Math.round(x);
        if (tail && Math.abs(r.y + r.h + tail - y) < 2 && tx > r.x + 8 && tx < r.x + r.w - 8) {
            // stepped pixel tail
            for (var s = 0; s < tail; s++) {
                var half = tail - s;
                ctx.fillStyle = col.border;
                ctx.fillRect(tx - half - 1, r.y + r.h - 1 + s, half * 2 + 2, 1);
                ctx.fillStyle = col.bg;
                if (half > 1) ctx.fillRect(tx - half + 1, r.y + r.h - 1 + s, half * 2 - 2, 1);
            }
        }
        var cy = r.y + pad, cx = r.x + pad;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        if (title) {
            if (o.icon && SP()) SP().draw(ctx, o.icon, cx + 4, cy + fs / 2 + 1, { scale: 1 });
            else if (o.dot) { ctx.fillStyle = col.border; ctx.fillRect(cx, cy + 3, 7, 7); ctx.fillStyle = o.dot; ctx.fillRect(cx + 1, cy + 4, 5, 5); }
            ctx.font = bold;
            ctx.fillStyle = col.text;
            if (PF && PF.has(title)) PF.draw(ctx, title, cx + iconW, cy + Math.round((fs - 7) / 2), 1, col.text);
            else ctx.fillText(title, cx + iconW, cy);
            if (sidePixel) PF.draw(ctx, o.side, r.x + r.w - pad - PF.measure(o.side), cy + Math.round((fs - 7) / 2), 1, col.muted);
            else if (o.side) {
                ctx.font = body;
                ctx.fillStyle = col.muted;
                ctx.textAlign = 'right';
                ctx.fillText(o.side, r.x + r.w - pad, cy);
                ctx.textAlign = 'left';
            }
            cy += lh;
        }
        ctx.font = body;
        ctx.fillStyle = col.text;
        lines.forEach(function (l, i) { ctx.fillText(l, cx, cy + i * lh); });
        ctx.restore();
        return r;
    }

    // I9: the title's spot (screen, top centre): above the table over the far row's name tags,
    // else under it, right or left of it (each slid a little along the table); the first one
    // clear of every other piece's art (manifest bounds), the interior walls, the name tags
    // and the speech card, inside the view; else the one covering least. Rechecked each second.
    var titleMemo = null;
    function titleSpot(h, text, m, view, avoid) {
        var pl = cur.place, t = pl.title, below = h.worldToCanvas(t.x, t.y);
        if (pl.where !== 'table' || !pl.box || !h.artRects) return below;
        var o = h.worldToCanvas(0, 0), sc = h.scale ? h.scale() : 1;
        var key = [cur.id, text.length, Math.round(o.x), Math.round(o.y), sc, view.w, view.h, Math.floor(Date.now() / 1000),
            avoid ? [avoid.x, avoid.y, avoid.w].join(':') : ''].join(',');
        if (titleMemo && titleMemo.key === key) return titleMemo.at;
        var chip = root.VOChip, lead = Math.round(m.h * 0.6) + 4;
        var w = chip && chip.width ? Math.ceil(chip.width(chip.fit(text, m.h, 220, { lead: lead }), m.h, null, 1, { lead: lead })) : text.length * 7 + lead + 14;
        var b = pl.box, tl = h.worldToCanvas(b.x, b.y), br = h.worldToCanvas(b.x + b.w, b.y + b.h), mid = (tl.y + br.y) / 2 - m.h / 2;
        var head = h.worldToCanvas(t.x, pl.top - 54).y - 16 - m.gap - m.h - 6 - m.h;  // over the far row's tag + launcher
        var cands = [];
        [0, -0.25, 0.25, -0.5, 0.5].forEach(function (k) { cands.push({ x: below.x + k * w, y: head }); });
        [0, -0.25, 0.25, -0.5, 0.5].forEach(function (k) { cands.push({ x: below.x + k * w, y: below.y }); });
        [0, 8, 16, 24, 32, w / 2].forEach(function (d) { cands.push({ x: br.x + 8 + w / 2 - d, y: mid }); });
        [0, 8, 16, 24, 32, w / 2].forEach(function (d) { cands.push({ x: tl.x - 8 - w / 2 + d, y: mid }); });
        var obs = h.artRects().filter(function (r) { return r.id !== b.id; }).map(function (r) {
            var p = h.worldToCanvas(r.x, r.y), q = h.worldToCanvas(r.x + r.w, r.y + r.h);
            return { x: p.x, y: p.y, w: q.x - p.x, h: q.y - p.y, k: 1 };
        });
        ((h.agents && h.agents()) || []).forEach(function (a) {
            if (a._ctl) [a._ctl.tag, a._ctl.launcher].forEach(function (r) { if (r) obs.push({ x: r.x, y: r.y, w: r.w, h: r.h, k: 2 }); });
        });
        if (avoid) obs.push({ x: avoid.x, y: avoid.y, w: avoid.w, h: avoid.h, k: 4 });
        var best = null;
        cands.forEach(function (c) {
            var r = { x: c.x - w / 2, y: c.y, w: w, h: m.h };
            var cost = r.x < 2 || r.y < 2 || r.x + r.w > view.w - 2 || r.y + r.h > view.h - 2 ? 1e6 : 0;
            obs.forEach(function (a) {
                var ox = Math.min(r.x + r.w, a.x + a.w) - Math.max(r.x, a.x), oy = Math.min(r.y + r.h, a.y + a.h) - Math.max(r.y, a.y);
                if (ox > 0 && oy > 0) cost += ox * oy * a.k;
            });
            if (!best || cost < best.cost) best = { cost: cost, at: c };
        });
        titleMemo = { key: key, at: best.at };
        return best.at;
    }

    var rects = [], shown = null, titleRect = null;
    function drawScreen(ctx) {
        rects = [];
        shown = null;
        titleRect = null;
        var h = H();
        if (!cur || !h || (h.editMode && h.editMode())) return;
        var ph = phaseAt(sNow());
        var view = h.view ? h.view() : { w: 1e9, h: 1e9 };
        var m = (h.ctlMetrics && h.ctlMetrics()) || { h: 22, gap: 3 };
        var fade = life.reducedMotion() ? 1 : Math.min(1, (ph.since || 0) / FADE_MS);
        var small = compact();
        var progress = life.t('standupProgress', { i: Math.max(1, Math.min(cur.lines.length, ph.idx + 1)), n: cur.lines.length });
        var capText = '', capIcon = 'clipboard', capKey = '';
        if (ph.phase === 'speak') {
            var l = cur.lines[ph.idx], p = cur.people[l.agent], a = agentOf(l.agent);
            var phone = !p || p.mode === 'remote';
            var anchor = a ? anchorFor(a, h, m) : null;
            var onScreen = anchor && anchor.x > 0 && anchor.x < view.w && anchor.y > 0 && anchor.y < view.h;
            if (!small && onScreen) {
                rects.push(card(ctx, anchor.x, anchor.y, { title: nameOf(l.agent), text: l.line, phone: phone,
                    icon: phone ? 'phone' : null, dot: phone ? null : (a && a.color) || '#90a4ae',
                    side: phone ? life.t('remote') : progress, alpha: fade }));
                shown = { key: l.agent, phone: phone, rect: rects[rects.length - 1] };
            } else {
                capText = life.t('standupCaption', { name: nameOf(l.agent), line: l.line });
                capIcon = phone ? 'phone' : 'clipboard';
                capKey = cur.id + ':' + ph.idx;
            }
        } else if (ph.phase === 'summary' && cur.summary) {
            var cc = cur.place && cur.place.centre && h.worldToCanvas ? h.worldToCanvas(cur.place.centre.x, cur.place.centre.y) : null;
            if (!small && cc && cc.x > 0 && cc.x < view.w && cc.y > 0 && cc.y < view.h) {
                rects.push(card(ctx, cc.x, cc.y, { title: (life.standupTitle ? life.standupTitle(cur.at) : life.t('standupTitle')), icon: 'clipboard', text: cur.summary, tail: false, alpha: fade }));
            } else {
                capText = cur.summary;
                capKey = cur.id + ':summary';
            }
        } else if (ph.phase === 'gather' && small) {
            capText = (life.standupTitle ? life.standupTitle(cur.at) : life.t('standupTitle'));
            capKey = cur.id + ':gather';
        }
        // Title by the table while people gather and talk (desktop only), clear of the speech card.
        if (!small && cur.place && cur.place.title && h.worldToCanvas && (ph.phase === 'gather' || ph.phase === 'speak')) {
            var ttl = (life.standupTitle ? life.standupTitle(cur.at) : life.t('standupTitle')) + (ph.phase === 'speak' ? ' · ' + progress : '');
            var c = titleSpot(h, ttl, m, view, shown && shown.rect);
            if (c.x > 0 && c.x < view.w && c.y > 0 && c.y < view.h && SP()) {
                titleRect = SP().label(ctx, ttl, c.x, c.y, { kind: 'neutral', icon: 'clipboard', anchor: 'top' });
                rects.push(titleRect);
            }
        }
        if (capKey) showCaption(capKey, capText, capIcon, 0);
        else if (cap && cap.key && cap.key.indexOf('late:') !== 0) hideCaption();
    }

    function update() {
        if (cap && cap.until && Date.now() > cap.until) hideCaption();
        if (!cur) return;
        var ph = phaseAt(sNow());
        if (ph.phase === 'over') { finish('over'); return; }
        var sig = ph.phase + ':' + ph.idx;
        if (sig !== lastSig) {
            lastSig = sig;
            cur.phase = ph.phase;
            cur.idx = ph.idx;
            busy(FADE_MS + 400);
            Object.keys(cur.people).forEach(function (k) { pose(cur.people[k]); });
            if (ph.phase === 'summary') {
                // The talking is done: everybody back to normal life while the card shows.
                var d = D();
                Object.keys(cur.people).forEach(function (k) { if (cur.people[k].ctl && d) d.cancel(k, 'over', { feature: 'standup' }); });
            }
            placeCaption();
        }
    }

    life.feature('standup', {
        setting: 'standup',
        order: 50,
        onState: function (snap) {
            var open = snap && snap.open && snap.open.standup;
            if (open && open.status === 'open') begin(open, true);
            else if (cur && !open) finish('closed');
        },
        onEvent: function (ev) {
            if (ev.type === 'standup.start') {
                if (ev.status === 'open') begin(ev, false);
            } else if (ev.type === 'standup.end') {
                if (cur && (!ev.id || ev.id === cur.id)) {
                    cur.ended = true;
                    // The server's 90 s are up: never run on for more than the summary.
                    var ph = phaseAt(sNow());
                    if (ph.phase === 'gather') finish('ended');
                }
            }
        },
        update: update,
        drawScreen: drawScreen,
        click: function (x, y, touch) {
            var sp = SP();
            if (!sp || !cur) return false;
            for (var i = rects.length - 1; i >= 0; i--) if (sp.hitRect(rects[i], x, y, touch)) { openHistory(); return true; }
            return false;
        },
        hover: function (x, y) {
            var sp = SP();
            if (!sp || !cur) return false;
            return rects.some(function (r) { return sp.hitRect(r, x, y, false); });
        },
        onRoster: function () {
            // New Agent objects: the director ended the walks; gather again if there is time.
            if (!cur) return;
            Object.keys(cur.people).forEach(function (k) { var p = cur.people[k]; p.ctl = null; p.seat = null; if (p.mode !== 'remote') p.mode = 'desk'; });
            cur.place = null;
            gather();
        },
        onVisibility: function (visible) {
            if (visible && cur) { cur.place = null; gather(); }
        },
        onSettings: function () {
            // Switched off: nothing of it stays on screen (the life core already ended the walks).
            if (!life.isOn('standup')) { if (cur) finish('off'); hideCaption(); return; }
            if (cur && life.atDesk() && D()) D().cancelFeature('standup', 'calm');
        },
        reset: function (reason) {
            if (reason === 'calm') { if (D()) D().cancelFeature('standup', 'calm'); return; }
            finish(reason);
            hideCaption();
        }
    });

    root.VOLifeStandup = {
        _debug: function () {
            var ph = phaseAt(sNow());
            return { id: cur && cur.id, phase: ph.phase, idx: ph.idx, speak: cur && cur.speak, total: cur && cur.total,
                where: cur && cur.place && cur.place.where,
                people: cur ? Object.keys(cur.people).map(function (k) { var p = cur.people[k]; return { key: k, mode: p.mode, seat: p.seat, why: p.why }; }) : [],
                caption: cap && !cap.wrap.hidden ? { key: cap.key, text: cap.text.textContent } : null, cards: rects.length, card: shown, title: titleRect,
                lateShown: Object.keys(lateShown) };
        },
        openHistory: openHistory
    };
})(typeof window !== 'undefined' ? window : this);
