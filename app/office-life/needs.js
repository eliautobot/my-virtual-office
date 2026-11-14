// Office life: Needs-you (feature 1, design .work/life/design.md 3.1).
//
// An agent blocked on an approval, a question or input walks to the front of
// the office (the Front Desk spot, else the floor nearest the bottom centre;
// up to 5 queue slots, the rest sign at their desks) and holds up a placard.
// A screen sign above its name tag says "Needs your OK" / "Has a question" /
// "Needs you" (+ count) in place of the activity chip. Clicking the sign, the
// placard or the agent opens its chat on that session with the card in view.
// Needs of agents outside the view get DOM edge badges (keyboard reachable),
// the mini-map gets an amber marker, and each new need is announced once.
// Zero inference: only needs.open / needs.close events from the server.
(function (root) {
    'use strict';
    var life = root.VOLife;
    if (!life) return;

    var RANK = { approval: 3, question: 2, input: 1 };
    var SIGN_TEXT = { approval: 'needsOk', question: 'needsQuestion', input: 'needsYou' };
    var EDGE_TEXT = { approval: 'needsEdgeOk', question: 'needsEdgeQuestion', input: 'needsEdgeInput' };
    var GLYPH = { approval: '!', question: '?', input: '?' };
    var FRONT_SLOTS = 5;
    var FLIP_MS = 1200;
    var WIGGLE_EVERY = 20000, WIGGLE_MS = 1200;
    var EXPIRE_GRACE = 30000;
    var RECONCILE_MS = 1000;
    var MAX_EDGE = 3;
    var MARKER_COLOR = '#ffb300';
    var ARROWS = { left: '←', right: '→', top: '↑', bottom: '↓' };

    life.addText({ needsAnswered: 'Thanks!', needsOpenChat: 'Open the chat' });

    var open = {};       // agent key -> {ref: need record}
    var signs = {};      // agent key -> running sign script state
    var rects = {};      // agent key -> screen rect of its sign this frame
    var order = [];      // keys in drawing order (the last drawn is on top)
    var announced = {};  // 'agent|ref' -> 1 (bounded)
    var marked = {};     // agent key -> mini-map marker set
    var lastReconcile = 0;
    var edge = { box: null, sr: null, sig: '', items: [], offsetAt: 0, dx: 0, dy: 0 };

    function H() { return life.host(); }
    function D() { return life.director(); }
    function SP() { return life.sprites(); }
    function on() { return life.isOn('needsYou'); }
    function now() { return Date.now(); }
    function toMs(v) { v = Number(v); if (!v) return 0; return v < 1e12 ? v * 1000 : v; }
    function agentOf(key) { var h = H(); return h && h.agent ? h.agent(key) : null; }
    function nameOf(key) { var a = agentOf(key); return life.clip((a && a.name) || key, 24); }
    function recs(key) { var m = open[key]; return m ? Object.keys(m).map(function (r) { return m[r]; }) : []; }

    // The strongest open need of an agent (approval > question > input, oldest first).
    function strongest(key) {
        var best = null;
        recs(key).forEach(function (r) {
            if (!best || RANK[r.need] > RANK[best.need] || (RANK[r.need] === RANK[best.need] && r.at < best.at)) best = r;
        });
        return best;
    }
    function countOf(key) {
        var list = recs(key);
        return list.reduce(function (n, r) { return Math.max(n, r.count || 0); }, list.length);
    }

    // ---- open / close ----
    function addNeed(ev) {
        var key = String(ev.agent || '');
        if (!key) return;
        var ref = String(ev.ref || ev.need || 'need');
        var map = open[key] || (open[key] = {});
        var fresh = !map[ref];
        map[ref] = {
            ref: ref, need: RANK[ev.need] ? ev.need : 'input',
            session: ev.session ? String(ev.session) : '', cardId: ev.cardId ? String(ev.cardId) : '',
            expiresAt: toMs(ev.expiresAt), at: toMs(ev.at) || now(), count: Number(ev.count) || 0
        };
        var s = signs[key];
        if (s && s.closing) { s.closing = false; s.flipUntil = 0; } // a new need while the check shows keeps the sign up
        if (!on()) return;
        marker(key, true);
        if (fresh) announce(key, ref);
        ensure(key);
        refreshPose(key);
    }

    function closeNeed(key, ref, outcome) {
        var map = open[key];
        if (!map) return;
        if (!ref && Object.keys(map).length === 1) ref = Object.keys(map)[0];
        if (!map[ref]) return;
        delete map[ref];
        if (Object.keys(map).length) { refreshPose(key); return; }
        delete open[key];
        marker(key, false);
        var d = D();
        if (!d) return;
        var cur = d.current(key);
        if (cur && cur.feature === 'needs') {
            var s = signs[key];
            if (outcome === 'answered' && s && s.posed) {
                // The placard flips to a check for a moment, then the agent goes back.
                s.closing = true;
                s.flipUntil = now() + FLIP_MS;
                cur.ctl.pose('sign', { glyph: 'check', still: true });
            } else {
                cur.ctl.done(outcome || 'closed');
            }
        } else {
            d.cancel(key, 'closed', { feature: 'needs' }); // drops a queued sign script
        }
    }

    // ---- the script that holds the agent ----
    function ensure(key) {
        var d = D();
        if (!d || !open[key] || !on()) return;
        var cur = d.current(key);
        if (cur && cur.feature === 'needs') return;
        if (d.queued(key).some(function (b) { return b.feature === 'needs'; })) return;
        d.request(key, {
            kind: 'needs', feature: 'needs', moves: true, forWork: true, requeue: true, label: life.t('holdFront'),
            start: startSign, update: updateSign, end: endSign
        });
    }

    function takeSlot(key) {
        var h = H();
        if (!h || !h.spots) return null;
        var sp = h.spots();
        var q = sp && typeof sp.frontQueue === 'function' ? sp.frontQueue(FRONT_SLOTS) : [];
        var used = {};
        Object.keys(signs).forEach(function (k) { if (k !== key && signs[k].slot >= 0) used[signs[k].slot] = 1; });
        for (var i = 0; i < q.length; i++) if (q[i] && !used[i]) return { x: q[i].x, y: q[i].y, index: i };
        return null;
    }

    function poseData(key, s) {
        var best = strongest(key);
        return { glyph: GLYPH[(best && best.need) || 'input'], wiggle: !!s.wiggleUntil, still: life.atDesk() };
    }
    function raise(ctl, s) {
        s.posed = true;
        ctl.pose('sign', poseData(ctl.key, s));
    }
    function refreshPose(key) {
        var s = signs[key];
        if (s && s.posed && !s.closing && s.ctl.active()) s.ctl.pose('sign', poseData(key, s));
    }
    // Calm mode, reduced motion, a real meeting or no free front space: the
    // agent stands where it is (beside its chair) with the sign.
    function signHere(ctl, s) {
        s.mode = 'here';
        s.slot = -1;
        var a = ctl.agent(), h = H();
        if (a && !a.meetingId && a.isSitting && h && h.sit) h.sit(ctl.key, false);
        raise(ctl, s);
    }

    function startSign(ctl) {
        var key = ctl.key;
        var s = signs[key] = { ctl: ctl, slot: -1, mode: 'walk', posed: false, closing: false, flipUntil: 0,
            wiggleAt: now() + WIGGLE_EVERY, wiggleUntil: 0 };
        var a = ctl.agent();
        var slot = !life.atDesk() && !(a && a.meetingId) ? takeSlot(key) : null;
        if (!slot) { signHere(ctl, s); return; }
        s.slot = slot.index;
        ctl.walk(slot.x, slot.y, function (res) {
            if (!ctl.active()) return;
            if (res && res.ok) { s.mode = 'front'; raise(ctl, s); } else signHere(ctl, s);
        });
    }

    function updateSign(ctl, t) {
        var key = ctl.key, s = signs[key];
        if (!s) return;
        if (s.closing) { if (now() >= s.flipUntil) ctl.done('answered'); return; }
        if (!open[key]) { ctl.done('closed'); return; }
        if (!s.posed || life.atDesk()) return;
        var n = now();
        if (!s.wiggleUntil && n >= s.wiggleAt) { s.wiggleUntil = n + WIGGLE_MS; refreshPose(key); }
        else if (s.wiggleUntil && n >= s.wiggleUntil) { s.wiggleUntil = 0; s.wiggleAt = n + WIGGLE_EVERY; refreshPose(key); }
    }

    function endSign(ctl, reason) {
        var key = ctl.key;
        if (signs[key] && signs[key].ctl === ctl) delete signs[key];
        if (reason === 'timeout' && open[key]) {
            // Six hours with no close from the server: let it go here too.
            delete open[key];
            marker(key, false);
        }
    }

    // Once a second: (re)start sign scripts (roster reloads, offline -> online,
    // hidden tab) and close needs whose expiry passed.
    function reconcile() {
        var t = life.serverNow ? life.serverNow() : now();
        Object.keys(open).forEach(function (key) {
            var list = recs(key);
            if (list.length && list.every(function (r) { return r.expiresAt && t > r.expiresAt + EXPIRE_GRACE; })) {
                list.forEach(function (r) { closeNeed(key, r.ref, 'expired'); });
                return;
            }
            if (!marked[key]) marker(key, true);
            ensure(key);
        });
        if (Object.keys(announced).length > 500) announced = {};
    }

    // ---- chat ----
    function openFor(key) {
        var h = H(), best = strongest(key), opts = {};
        if (best) {
            if (best.session) opts.sessionKey = best.session;
            var id = best.cardId || best.ref;
            if (best.need === 'approval' && id) opts.focus = { approvalId: id };
            else if (best.need === 'question' && id) opts.focus = { questionId: id };
        }
        if (h && h.openChat) h.openChat(key, opts);
        return true;
    }

    // ---- mini-map + screen reader ----
    function marker(key, set) {
        var h = H();
        if (set) { marked[key] = true; if (h && h.mapMarker) h.mapMarker(key, { color: MARKER_COLOR }); }
        else if (marked[key]) { delete marked[key]; if (h && h.mapMarker) h.mapMarker(key, null); }
    }
    function announce(key, ref) {
        var id = key + '|' + ref;
        if (announced[id]) return;
        announced[id] = 1;
        var sr = liveRegion();
        if (!sr) return;
        sr.textContent = '';
        var text = life.t('needsAnnounce', { name: nameOf(key) });
        setTimeout(function () { sr.textContent = text; }, 60);
    }
    function liveRegion() {
        if (typeof document === 'undefined') return null;
        if (edge.sr && edge.sr.isConnected) return edge.sr;
        var layer = life.layer && life.layer();
        if (!layer) return null;
        var sr = document.createElement('div');
        sr.className = 'vo-life-sr';
        sr.setAttribute('aria-live', 'polite');
        sr.setAttribute('data-vo-life', 'needs-live');
        layer.appendChild(sr);
        edge.sr = sr;
        return sr;
    }

    // ---- screen signs ----
    // Bottom-centre anchor above the agent's tag cluster (ctl.launcher: the name tag since v0.13).
    function anchorFor(a, h, m) {
        var c = a._ctl;
        if (c && c.launcher) return { x: c.launcher.x + c.launcher.w / 2, y: c.launcher.y - m.gap };
        if (!h.worldToCanvas) return null;
        var p = h.worldToCanvas(a.x + (a._tagDx || 0), a.y - 68 + (a._tagDy || 0));
        return { x: p.x, y: p.y - m.gap * 2 - m.h };
    }

    // Width of a sign pill (same rules as VOLifeSprites.label) for the layout.
    function signWidth(ctx, text, count, m) {
        var pad = Math.round(m.h * 0.32), iconW = Math.round(m.h * 0.6) + 4;
        var chip = (typeof window !== 'undefined') && window.VOChip;
        if (chip && chip.width) {
            var copts = { lead: iconW, badge: count > 1 ? String(count > 99 ? '99+' : count) : '' };
            return Math.ceil(chip.width(chip.fit(text, m.h, 220, copts), m.h, null, 1, copts));
        }
        var tw = text.length * 6.5, cw = count > 1 ? 18 : 0;
        if (ctx && typeof ctx.measureText === 'function') {
            ctx.save();
            ctx.font = m.font || '600 11px Inter, system-ui, sans-serif';
            tw = ctx.measureText(text).width;
            if (count > 1) cw = ctx.measureText(String(count > 99 ? '99+' : count)).width + 12;
            ctx.restore();
        }
        return Math.round(pad * 2 + iconW + Math.min(tw, 220) + cw);
    }
    function overlaps(p, q) { return p.x < q.x + q.w + 2 && q.x < p.x + p.w + 2 && p.y < q.y + q.h + 2 && q.y < p.y + p.h + 2; }

    function drawSigns(ctx) {
        var h = H(), sp = SP();
        rects = {};
        order = [];
        if (!h || !sp || (h.editMode && h.editMode())) { updateEdges([], null); return; }
        var view = h.view(), m = h.ctlMetrics ? h.ctlMetrics() : { h: 22, gap: 3 };
        var off = [], items = [];
        var keys = Object.keys(open);
        Object.keys(signs).forEach(function (k) { if (signs[k].closing && keys.indexOf(k) < 0) keys.push(k); });
        keys.forEach(function (key) {
            var a = agentOf(key);
            if (!a) return;
            var p = anchorFor(a, h, m);
            if (!p) return;
            var best = strongest(key);
            if (p.x < 0 || p.x > view.w || p.y < 0 || p.y > view.h) {
                if (best) off.push({ key: key, x: p.x, y: p.y, need: best.need, at: best.at });
                return;
            }
            var s = signs[key];
            if (s && s.closing) {
                items.push({ key: key, p: p, text: life.t('needsAnswered'), opts: { kind: 'success', icon: 'placard', iconOpts: { glyph: 'check' } } });
            } else if (best) {
                items.push({ key: key, p: p, text: life.t(SIGN_TEXT[best.need]),
                    opts: { kind: 'warning', icon: 'placard', iconOpts: { glyph: GLYPH[best.need] }, count: countOf(key) } });
            }
        });
        layoutSigns(items, ctx, m);
        // Lifted signs get a short stem down to their agent; stems first, pills over them.
        items.forEach(function (it) {
            if (it.r.y + m.h >= it.p.y - 1 || typeof ctx.fillRect !== 'function') return;
            var was = ctx.fillStyle;
            ctx.fillStyle = 'rgba(14,19,31,0.7)';
            ctx.fillRect(Math.round(it.ax) - 1, Math.round(it.r.y + m.h), 2, Math.round(it.p.y - it.r.y - m.h));
            ctx.fillStyle = was;
        });
        items.forEach(function (it) {
            rects[it.key] = sp.label(ctx, it.text, it.r.x + it.r.w / 2, it.r.y + m.h, it.opts);
            order.push(it.key);
        });
        updateEdges(off, view);
    }
    // N3: signs of agents side by side sit side by side in one row, each still over
    // its own agent (the pill covers the agent's x); only when there is no room does
    // a sign step up a row (up to 3), with a stem to its agent.
    function layoutSigns(items, ctx, m) {
        var GAP = 4, EDGE = 6;
        items.forEach(function (it) {
            it.w = signWidth(ctx, it.text, it.opts.count || 0, m);
            it.ax = it.p.x;
            it.r = { x: it.p.x - it.w / 2, y: it.p.y - m.h, w: it.w, h: m.h };
        });
        // Rows: anchors at about the same height.
        var rows = [];
        items.slice().sort(function (p, q) { return q.p.y - p.p.y; }).forEach(function (it) {
            var row = rows.find(function (r) { return Math.abs(r[0].p.y - it.p.y) < m.h; });
            if (row) row.push(it); else rows.push([it]);
        });
        rows.forEach(function (row) {
            row.sort(function (p, q) { return p.ax - q.ax; });
            var xs = [], push = 0, i;
            for (i = 0; i < row.length; i++) {
                xs[i] = i ? Math.max(row[i].r.x, xs[i - 1] + row[i - 1].w + GAP) : row[i].r.x;
                push += xs[i] - row[i].r.x;
            }
            var shift = push / row.length;
            for (i = 0; i < row.length; i++) {
                var x = xs[i] - shift;
                if (x + EDGE <= row[i].ax && row[i].ax <= x + row[i].w - EDGE) row[i].r.x = x;
            }
        });
        // Anything still covering a placed sign steps up a row.
        var placed = [];
        items.sort(function (p, q) { return q.p.y - p.p.y || p.p.x - q.p.x; });
        items.forEach(function (it) {
            var r = it.r;
            for (var lift = 0; lift < 3 && placed.some(function (o) { return overlaps(o, r); }); lift++) r.y -= m.h + m.gap;
            placed.push(r);
        });
    }

    // ---- edge badges (DOM, keyboard reachable) ----
    function sideOf(o, view) {
        var dl = -o.x, dr = o.x - view.w, dt = -o.y, db = o.y - view.h;
        var max = Math.max(dl, dr, dt, db);
        return max === dl ? 'left' : max === dr ? 'right' : max === dt ? 'top' : 'bottom';
    }
    function clearEdges() {
        if (edge.box && edge.box.parentNode) edge.box.parentNode.removeChild(edge.box);
        edge.box = null; edge.sig = ''; edge.items = [];
    }
    function makeBadge(text, title, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'vo-life-pill vo-life-edge';
        b.textContent = text;
        b.title = title || text;
        b.setAttribute('aria-label', title || text);
        b.style.position = 'absolute';
        b.style.left = '0';
        b.style.top = '0';
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClick(); });
        return b;
    }
    function goTo(key) {
        var h = H();
        if (h && h.focusAgent) { try { h.focusAgent(key); } catch (e) {} }
        openFor(key);
    }
    function updateEdges(off, view) {
        if (typeof document === 'undefined') return;
        if (!off.length) { if (edge.box) clearEdges(); return; }
        off.sort(function (p, q) { return RANK[q.need] - RANK[p.need] || p.at - q.at; });
        var shown = off.slice(0, MAX_EDGE), rest = off.slice(MAX_EDGE);
        shown.forEach(function (o) { o.side = sideOf(o, view); });
        var sig = shown.map(function (o) { return o.key + ':' + o.side + ':' + o.need; }).join('|') + '|' + rest.length;
        if (sig !== edge.sig || !edge.box || !edge.box.isConnected) {
            var layer = life.layer && life.layer();
            if (!layer) return;
            clearEdges();
            var box = document.createElement('div');
            box.className = 'vo-life-edges';
            box.setAttribute('data-vo-life', 'needs-edges');
            box.setAttribute('role', 'group');
            box.setAttribute('aria-label', life.t('needsYou'));
            box.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
            edge.items = shown.map(function (o) {
                var text = life.t(EDGE_TEXT[o.need], { name: nameOf(o.key) });
                var b = makeBadge(ARROWS[o.side] + ' ' + text, text + ' - ' + life.t('needsOpenChat'), function () { goTo(o.key); });
                b.dataset.agent = o.key;
                b.style.pointerEvents = 'auto';
                box.appendChild(b);
                return { el: b, key: o.key, w: 0, h: 0, x: -1, y: -1 };
            });
            if (rest.length) {
                var first = rest[0].key;
                var more = makeBadge(life.t('needsMore', { n: rest.length }), '', function () { goTo(first); });
                more.style.pointerEvents = 'auto';
                more.dataset.more = String(rest.length);
                box.appendChild(more);
                edge.items.push({ el: more, key: '', more: true, w: 0, h: 0, x: -1, y: -1 });
            }
            layer.appendChild(box);
            edge.box = box;
            edge.sig = sig;
            edge.items.forEach(function (it) { it.w = it.el.offsetWidth || 160; it.h = it.el.offsetHeight || 32; });
            edge.offsetAt = 0;
        }
        placeEdges(shown, view);
    }
    function placeEdges(shown, view) {
        var h = H(), t = now();
        if (t - edge.offsetAt > 500) {
            // The layer covers .game-wrapper; the canvas may be offset inside it.
            edge.offsetAt = t;
            var canvas = edge.box.parentNode && edge.box.parentNode.parentNode && edge.box.parentNode.parentNode.querySelector('canvas');
            var lr = edge.box.parentNode.getBoundingClientRect(), cr = canvas ? canvas.getBoundingClientRect() : lr;
            edge.dx = cr.left - lr.left; edge.dy = cr.top - lr.top;
        }
        var M = 8, placed = [];
        edge.items.forEach(function (it, i) {
            var o = it.more ? shown[shown.length - 1] : shown[i];
            if (!o) return;
            var x = Math.max(M, Math.min(view.w - M - it.w, o.x - it.w / 2));
            var y = Math.max(M, Math.min(view.h - M - it.h, o.y - it.h / 2));
            var r = { x: x, y: y, w: it.w, h: it.h };
            if (h && h.keepOutOfChrome) r = h.keepOutOfChrome(r, null, 6) || r;
            // Badges on the same edge stack instead of covering each other.
            for (var guard = 0; guard < 6 && placed.some(function (p) { return r.x < p.x + p.w + 4 && p.x < r.x + r.w + 4 && r.y < p.y + p.h + 4 && p.y < r.y + r.h + 4; }); guard++) {
                if (o.side === 'left' || o.side === 'right') r.y = r.y + it.h + 6 > view.h - M - it.h ? r.y - it.h - 6 : r.y + it.h + 6;
                else r.x = r.x + it.w + 6 > view.w - M - it.w ? r.x - it.w - 6 : r.x + it.w + 6;
            }
            placed.push(r);
            var px = Math.round(r.x + edge.dx), py = Math.round(r.y + edge.dy);
            if (px !== it.x || py !== it.y) {
                it.x = px; it.y = py;
                it.el.style.transform = 'translate(' + px + 'px,' + py + 'px)';
            }
        });
    }

    // ---- hit tests ----
    function bodyRect(a, h) {
        var p = h.worldToCanvas(a.x - 14, a.y - 60), q = h.worldToCanvas(a.x + 18, a.y + 4);
        return { x: p.x, y: p.y, w: q.x - p.x, h: q.y - p.y };
    }
    function hitKey(x, y, touch) {
        var sp = SP(), h = H();
        if (!sp || !h) return '';
        for (var i = order.length - 1; i >= 0; i--) if (rects[order[i]] && sp.hitRect(rects[order[i]], x, y, touch)) return order[i];
        if (!h.worldToCanvas) return '';
        for (var k in open) {
            var a = agentOf(k);
            if (a && sp.hitRect(bodyRect(a, h), x, y, false)) return k;
        }
        return '';
    }

    function clearAll(keepData) {
        var d = D();
        if (d) d.cancelFeature('needs', 'off');
        Object.keys(marked).forEach(function (k) { marker(k, false); });
        signs = {}; rects = {}; order = [];
        clearEdges();
        if (!keepData) open = {};
    }

    function syncState(snap) {
        var list = (snap && snap.open && Array.isArray(snap.open.needs)) ? snap.open.needs : [];
        var keep = {};
        list.forEach(function (ev) { keep[String(ev.agent) + '\u0000' + String(ev.ref || ev.need || 'need')] = 1; });
        Object.keys(open).forEach(function (k) {
            Object.keys(open[k] || {}).forEach(function (r) { if (!keep[k + '\u0000' + r]) closeNeed(k, r, 'gone'); });
        });
        list.forEach(addNeed);
    }
    function track(ev) {
        if (!ev || !ev.type) return;
        if (ev.type === 'needs.open') addNeed(ev);
        else if (ev.type === 'needs.close') closeNeed(String(ev.agent || ''), String(ev.ref || ''), ev.outcome);
    }

    // While the feature is off the open needs are still tracked (data only),
    // so switching it back on shows exactly what is open.
    if (root.addEventListener) {
        root.addEventListener('vo:life-event', function (e) { if (!on() && life.enabled()) track(e.detail); });
        root.addEventListener('vo:life-state', function () { if (!on() && life.enabled()) syncState(life.snapshot()); });
    }

    // root.VOLifeNeeds: the registered feature (tests and debugging read its _ helpers).
    root.VOLifeNeeds = life.feature('needs', {
        setting: 'needsYou',
        order: 10,
        onState: syncState,
        onEvent: track,
        onSettings: function () {
            if (!on()) clearAll(true);
            else Object.keys(open).forEach(function (k) { marker(k, true); ensure(k); });
        },
        update: function (t) {
            if (t - lastReconcile < RECONCILE_MS) return;
            lastReconcile = t;
            reconcile();
        },
        drawScreen: drawSigns,
        click: function (x, y, touch) {
            var key = hitKey(x, y, touch);
            return key ? openFor(key) : false;
        },
        hover: function (x, y) { return !!hitKey(x, y, false); },
        suppressChip: function (key) { return !!open[key] || !!(signs[key] && signs[key].closing); },
        onRoster: function () { lastReconcile = 0; },
        reset: function (reason) {
            if (reason === 'calm') {
                // Walking scripts end; the next reconcile signs at the desk.
                var d = D();
                if (d) d.cancelFeature('needs', 'calm');
                signs = {};
                lastReconcile = 0;
                return;
            }
            clearAll(false);
        },
        // Tests / debugging.
        _open: function () { return JSON.parse(JSON.stringify(open)); },
        _signs: function () { var o = {}; Object.keys(signs).forEach(function (k) { o[k] = { slot: signs[k].slot, mode: signs[k].mode, posed: signs[k].posed, closing: signs[k].closing }; }); return o; },
        _rects: function () { return rects; }
    });
})(typeof window !== 'undefined' ? window : globalThis);
