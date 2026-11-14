// Office life: Moods (feature 4).
// Owner: L6 life-moods-party (design .work/life/design.md 3.4).
//
// Body language from real state only (zero inference). The server decides the
// mood so every tab agrees: `mood` events (focused, stuck, relieved, clear) and
// /state open.moods. "waiting" comes from the open needs (needs.open/close);
// asleep is the office's own offline Zzz (nothing to do here).
//   focused  -> headphones on the head + lean-in typing (host 'type' pose, at the
//               desk while working) + a small headphones icon by the name tag
//   stuck    -> hand on the head every ~12 s for 2 s + a small storm-cloud icon
//   relieved -> a stretch at the desk (replaces the office's random stretch,
//               hence claims: ['stretch']) and a "phew" puff
//   waiting  -> a small "..." icon while the agent needs the user
// Everything stays at the desk (never walks), so it also runs in Calm mode;
// reduced motion keeps the poses still and the puff does not rise.
//
// Mood icons are screen space at a fixed size (like the chips), left of the
// name tag, and are skipped for a frame when that spot would cover any other
// agent's tag, ••• button, chip or 💬 button, another life label or the map
// controls. Rects drawn this frame: agent._lifeMoodRect (tests, other features).
(function () {
    'use strict';
    var life = window.VOLife;
    if (!life) return;

    var STUCK_EVERY_MS = 12000, STUCK_FOR_MS = 2000;
    var RELIEVED_MS = 8000, STRETCH_MS = 3000, PUFF_MS = 2600;
    var TICK_MS = 150;
    // The pose each mood puts on a free agent (stuck cycles, focused holds while typing).
    var MOOD_POSE = { stuck: 'headscratch', focused: 'type' };
    var COLORS = { focused: '#b388ff', stuck: '#b0bec5', waiting: '#fbbf24', relieved: '#81c784' };
    var ICONS = { focused: 'moodFocused', stuck: 'moodStuck', waiting: 'moodWaiting' };

    var moods = {};    // key -> {mood, since}
    var needs = {};    // key -> {ref: true}
    var relief = {};   // key -> {at, until, puffAt}
    var poses = {};    // key -> pose name this feature put on a free (unheld) agent
    var lastTick = 0;
    var placed = [];   // screen rects drawn this frame (icons + puffs)
    var drewLast = false;

    function host() { return life.host(); }
    function sprites() { return life.sprites(); }
    function now() { return Date.now(); }
    function agentOf(key) { var h = host(); return h && h.agent ? h.agent(key) : null; }
    function keyOf(a) { return a && (a.statusKey || a.id); }
    function offline(a) { return !a || a.state === 'offline' || a._statusState === 'offline'; }
    function still() { return life.reducedMotion(); }

    // ---- pixel icons (7x7, drawn x2 so they stay crisp at every zoom) ----
    function registerIcons() {
        var S = sprites();
        if (!S || S.has('moodFocused')) return;
        S.register('moodFocused', { w: 7, h: 7, paint: function (g) {
            S.bitmap(g, ['.KKKKK.', 'K.....K', 'K.....K', 'PP...PP', 'PP...PP', 'PP...PP', '.......'], { K: '#eceff1', P: COLORS.focused });
        } });
        S.register('moodStuck', { w: 7, h: 7, paint: function (g) {
            S.bitmap(g, ['..LLL..', '.LLLLL.', 'LLLLLLL', '.GGGGG.', '...Y...', '..Y....', '...Y...'], { L: '#eceff1', G: '#90a4ae', Y: '#ffd54f' });
        } });
        // Waiting for you: an hourglass (three dots read as the ••• menu).
        S.register('moodWaiting', { w: 7, h: 7, paint: function (g) {
            S.bitmap(g, ['YYYYYYY', '.W...W.', '..WSW..', '...S...', '..W.W..', '.WSSSW.', 'YYYYYYY'], { Y: COLORS.waiting, W: '#eceff1', S: '#ffe082' });
        } });
    }

    // ---- per-agent overlays drawn inside Agent.draw (agent-local space) ----
    // One shared, re-entrant decorator per character so several Office life
    // features (moods, party hats...) can draw on the same body:
    // VOLifeDecor.add(agent, name, fn(ctx, agent, moving)) / remove(agent, name).
    var Decor = window.VOLifeDecor || (window.VOLifeDecor = (function () {
        function dispatch(ctx, ch, moving) {
            if (ch._lifeDecorBusy) return;
            ch._lifeDecorBusy = true;
            try {
                var layers = ch._lifeDecorLayers || {};
                for (var k in layers) {
                    if (typeof layers[k] === 'function') { try { layers[k](ctx, ch, moving); } catch (e) {} }
                }
            } finally { ch._lifeDecorBusy = false; }
        }
        return {
            dispatch: dispatch,
            add: function (ch, name, fn) {
                if (!ch) return;
                var layers = ch._lifeDecorLayers || (ch._lifeDecorLayers = {});
                // Someone set a plain decorator: keep it as one layer (replaced, never nested).
                if (ch._lifeDecorate && ch._lifeDecorate !== dispatch) layers['~own'] = ch._lifeDecorate;
                layers[name] = fn;
                ch._lifeDecorate = dispatch;
            },
            remove: function (ch, name) {
                if (!ch || !ch._lifeDecorLayers) return;
                delete ch._lifeDecorLayers[name];
            },
            has: function (ch, name) { return !!(ch && ch._lifeDecorate === dispatch && ch._lifeDecorLayers && ch._lifeDecorLayers[name]); }
        };
    })());

    // Headphones over the hair, cups on the ears (head is x -12..12, y -38..-20).
    // They follow the view the body was just drawn in (agent._drawView): front
    // and back show both cups, a profile shows the band edge-on over the crown
    // and one cup on the ear (the side head's ear is x -3..0, y -31..-27 facing
    // right, mirrored facing left).
    // v0.12: the band rests on the highest thing on the head in that view (the hair's top from _hairTopY, or the
    // top of a cap, beanie, headband, goggles or tiara measured from the hat's own art), and moves with the head
    // (agent._drawHeadDy / _drawHeadDx: dozing, bent over a phone, the work animations and signature moves). Not drawn with a full costume or a headwear whose table entry
    // says phones: false (hard hat, crown, Santa hat, witch hat, sun hat, headset). Rule: docs/OFFICE-LIFE.md.
    function headphonesTop(ch, view) {
        var g = window, app = typeof ch.getAppearance === 'function' ? ch.getAppearance() : (ch.appearance || {});
        if (!app) app = {};
        if (app.costume) return null;
        var side = view === 'left' || view === 'right';
        var top = typeof g._hairTopY === 'function' ? g._hairTopY(app.hairStyle, side ? 'side' : view === 'up' ? 'back' : 'front') : -46;
        var hw = app.headwear, row = null;
        (g.HEADWEAR_STYLES || []).forEach(function (h) { if (h.id === hw) row = h; });
        if (row) {
            if (row.phones === false) return null;
            var cut = g.HAIR_HAT_CUT ? g.HAIR_HAT_CUT[hw] : undefined;  // hair under a covering hat stops at this line
            if (cut !== undefined && top < cut) top = cut;
            var crown = typeof g._headCrownY === 'function' ? g._headCrownY(app, view) : null;  // small hats rest on it
            var ht = typeof g._headwearTopY === 'function' ? g._headwearTopY(hw, view, crown) : null;
            if (ht != null && ht < top) top = ht;
        }
        return top;
    }
    function drawHeadphones(ctx, ch) {
        var m = moods[keyOf(ch)];
        if (!m || m.mood !== 'focused' || offline(ch) || !life.isOn('moods')) return;
        headphonesArt(ctx, ch);
    }
    // The art alone (also VOLifeMoods.headphones: the tests and the sheets draw it through Agent.draw).
    function headphonesArt(ctx, ch) {
        var view = ch._drawView || 'down';
        var top = headphonesTop(ch, view);
        if (top == null) return;
        var dx = ch._drawHeadDx || 0;  // the head's sideways shift at work (v0.12 moves: papers, talking, a signature move)
        if (dx) ctx.translate(dx, 0);
        try { headphonesShape(ctx, ch, view, top); } finally { if (dx) ctx.translate(-dx, 0); }
    }
    function headphonesShape(ctx, ch, view, top) {
        var y0 = Math.min(top - 2, -38) + (ch._drawHeadDy || 0), cupY = -35 + (ch._drawHeadDy || 0);
        if (view === 'left' || view === 'right') {
            var dir = view === 'left' ? -1 : 1;
            var f = function (x, y, w, h) { ctx.fillRect(dir > 0 ? x : -x - w, y, w, h); };
            ctx.fillStyle = '#263238';
            f(-5, y0, 5, 2);
            if (cupY - y0 - 2 > 0) f(-4, y0 + 2, 3, cupY - y0 - 2);
            ctx.fillStyle = '#7e57c2';
            f(-6, cupY, 7, 9);
            ctx.fillStyle = '#b39ddb';
            f(-5, cupY + 1, 1, 7);
            return;
        }
        var post = cupY + 1 - (y0 + 4);  // the posts run from the band's shoulders down to the cups
        ctx.fillStyle = '#263238';
        ctx.fillRect(-9, y0, 18, 2);
        ctx.fillRect(-12, y0 + 2, 3, 2);
        ctx.fillRect(9, y0 + 2, 3, 2);
        if (post > 0) { ctx.fillRect(-14, y0 + 4, 2, post); ctx.fillRect(12, y0 + 4, 2, post); }
        ctx.fillStyle = '#7e57c2';
        ctx.fillRect(-16, cupY, 5, 9);
        ctx.fillRect(11, cupY, 5, 9);
        ctx.fillStyle = '#b39ddb';
        ctx.fillRect(-15, cupY + 1, 1, 7);
        ctx.fillRect(15, cupY + 1, 1, 7);
    }

    // ---- poses on agents that no other script holds ----
    function free(a) {
        if (!a || a._lifeExtra || offline(a)) return false;
        var d = life.director();
        if (a._lifeHold || (d && d.isHeld(keyOf(a)))) return false;
        return true;
    }
    function setPose(key, name) {
        var a = agentOf(key), h = host();
        if (!a || !h) return;
        if (name) {
            if (!free(a)) return;
            if (a._lifePose && a._lifePose !== poses[key]) return; // someone else's pose
            if (a._lifePose === name) { poses[key] = name; return; }
            h.pose(key, name, { still: still(), ambient: true }); // ambient: a celebration may take over for a moment
            poses[key] = name;
        } else if (poses[key]) {
            if (a._lifePose === poses[key] && !a._lifeHold) h.pose(key, null);
            delete poses[key];
        }
    }
    // The pose we put on `key` still matches its mood.
    function moodPoseOk(key) { return !!(moods[key] && poses[key] && MOOD_POSE[moods[key].mood] === poses[key]); }
    function clearPoses() { Object.keys(poses).forEach(function (k) { setPose(k, null); }); }

    // ---- relieved: stretch at the desk + "phew" ----
    function nearDesk(a) {
        if (a.isSitting) return true;
        var d = a.desk;
        return !!(d && Math.abs(a.x - d.x) < 40 && Math.abs(a.y - d.y) < 50);
    }
    function inGame(a) {
        var act = String(a.idleAction || '');
        return !!(a._gatheringId || a.meetingId || act === 'pong' || act === 'darts' || /game|rps/i.test(act));
    }
    function startRelief(key, ev) {
        var t = now();
        var a = agentOf(key);
        if (!a || offline(a)) return;
        var age = Math.max(0, Number(ev._age) || 0);
        if (age > RELIEVED_MS) return; // the moment has passed: no late stretch
        var stretch = free(a) && nearDesk(a) && !inGame(a);
        relief[key] = { at: t, until: t + RELIEVED_MS - age, puffAt: t + (stretch ? 900 : 0) };
        if (!stretch) return;
        var d = life.director();
        if (!d) return;
        setPose(key, null);
        d.request(key, {
            kind: 'mood', feature: 'moods', priority: 15, moves: false, maxMs: STRETCH_MS + 1000, staleMs: 1500,
            start: function (ctl) { ctl.pose('stretch', { still: true }); },
            update: function (ctl) { if (ctl.elapsed() >= STRETCH_MS) ctl.done('done'); }
        });
    }

    // ---- mood state ----
    function setMood(key, mood) {
        if (!key) return;
        var prev = moods[key];
        if (!mood || mood === 'clear' || mood === 'relieved') {
            delete moods[key];
        } else if (!prev || prev.mood !== mood) {
            moods[key] = { mood: mood, since: now() };
        }
        if (!moodPoseOk(key)) setPose(key, null);
        syncDecor(key);
    }
    function syncDecor(key) {
        var a = agentOf(key);
        if (!a) return;
        var want = !!(moods[key] && moods[key].mood === 'focused');
        if (want && !Decor.has(a, 'moods')) Decor.add(a, 'moods', drawHeadphones);
        else if (!want) Decor.remove(a, 'moods');
    }
    function syncAllDecor() {
        var h = host();
        if (!h) return;
        h.agents().forEach(function (a) { syncDecor(keyOf(a)); });
    }
    function moodFor(key, a) {
        if (offline(a)) return '';
        var n = needs[key];
        if (n && Object.keys(n).length) return 'waiting';
        var m = moods[key];
        return m ? m.mood : '';
    }

    function clearAll() {
        clearPoses();
        var h = host();
        if (h) h.agents().forEach(function (a) { Decor.remove(a, 'moods'); a._lifeMoodRect = null; });
        relief = {};
    }

    // ---- screen placement ----
    function overlap(a, b, gap) {
        gap = gap || 0;
        return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
    }
    // Every control rect drawn this frame that a mood mark must not cover.
    function obstacles(self) {
        var out = [];
        var h = host();
        h.agents().forEach(function (o) {
            var c = o._ctl;
            if (!c) return;
            var mine = o === self;
            if (!mine) { out.push(c.tag); out.push(c.launcher); }
            if (c.chip) out.push(c.chip);
            if (c.bubbleShown && c.bubble) out.push(c.bubble);
        });
        return out.concat(placed);
    }
    function blocked(r, self, chrome) {
        var list = obstacles(self);
        for (var i = 0; i < list.length; i++) if (list[i] && overlap(r, list[i], 1)) return true;
        for (var j = 0; j < chrome.length; j++) if (overlap(r, chrome[j], 2)) return true;
        var v = host().view();
        return r.x < 2 || r.y < 2 || r.x + r.w > v.w - 2 || r.y + r.h > v.h - 2;
    }
    // One size with the other controls (A22: readable at any zoom).
    function badgeSize() { return host().ctlMetrics().h; }

    function drawBadge(ctx, r, mood) {
        var S = sprites();
        var chip = window.VOChip;
        if (chip && chip.draw) {
            // The office's chip family: dark pill, mood-coloured edge, 2 px shadow,
            // the 7x7 icon at 2x on whole pixels.
            chip.draw(r, { bg: 'rgba(14,19,31,0.94)', fg: '#ffffff', border: COLORS[mood] || '#90a4ae' }, '', {});
            if (S) S.draw(ctx, ICONS[mood], Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2), { scale: 2 });
            return;
        }
        ctx.save();
        ctx.fillStyle = COLORS[mood] || '#90a4ae';
        ctx.fillRect(r.x + 1, r.y, r.w - 2, r.h);
        ctx.fillRect(r.x, r.y + 1, r.w, r.h - 2);
        ctx.fillStyle = 'rgba(14,19,31,0.94)';
        ctx.fillRect(r.x + 2, r.y + 1, r.w - 4, r.h - 2);
        ctx.fillRect(r.x + 1, r.y + 2, r.w - 2, r.h - 4);
        if (S) S.draw(ctx, ICONS[mood], r.x + r.w / 2, r.y + r.h / 2, { scale: 2 });
        ctx.restore();
    }

    function puffRect(ctx, tag, m, t, rel) {
        var chip = window.VOChip, h = m.h - 4, w;
        if (chip && chip.width) w = Math.ceil(chip.width(life.t('phew'), h));
        else {
            ctx.save();
            ctx.font = m.font;
            w = Math.ceil(ctx.measureText(life.t('phew')).width) + 14;
            ctx.restore();
        }
        var p = Math.min(1, (t - rel.puffAt) / PUFF_MS);
        var rise = still() ? 0 : Math.round(p * 6);
        return { x: Math.round(tag.x - m.gap - w), y: Math.round(tag.y + tag.h / 2 - h / 2 - rise), w: w, h: h, p: p };
    }
    function drawPuff(ctx, r, m) {
        var a = r.p < 0.15 ? r.p / 0.15 : r.p > 0.6 ? Math.max(0, (1 - r.p) / 0.4) : 1;
        if (a <= 0) return;
        ctx.save();
        ctx.globalAlpha *= a;
        var chip = window.VOChip;
        if (chip && chip.draw) {
            chip.draw(r, { bg: '#ffffff', fg: '#37474f', border: '#90a4ae' }, life.t('phew'), { align: 'center' });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(r.x + r.w, r.y + r.h - 6, 2, 2);
            ctx.fillRect(r.x + r.w + 2, r.y + r.h - 4, 1, 1);
            ctx.restore();
            return;
        }
        // Pixel puff: rounded white body, a two-step tail toward the head.
        ctx.fillStyle = '#90a4ae';
        ctx.fillRect(r.x + 2, r.y, r.w - 4, r.h);
        ctx.fillRect(r.x, r.y + 2, r.w, r.h - 4);
        ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(r.x + 2, r.y + 1, r.w - 4, r.h - 2);
        ctx.fillRect(r.x + 1, r.y + 2, r.w - 2, r.h - 4);
        ctx.fillRect(r.x + r.w, r.y + r.h - 6, 2, 2);
        ctx.fillRect(r.x + r.w + 2, r.y + r.h - 4, 1, 1);
        ctx.fillStyle = '#37474f';
        ctx.font = m.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(life.t('phew'), r.x + r.w / 2, r.y + r.h / 2 + 0.5);
        ctx.restore();
    }

    var def = life.feature('moods', {
        setting: 'moods',
        order: 30,
        // The relieved stretch replaces the office's random after-run stretch.
        claims: ['stretch'],
        init: function () {
            life.addText({ moodFocused: 'Focused', moodStuck: 'Stuck', moodWaiting: 'Waiting for you' });
            registerIcons();
        },
        onState: function (snap) {
            var open = (snap && snap.open) || {};
            moods = {};
            Object.keys(open.moods || {}).forEach(function (k) {
                var m = String(open.moods[k] || '');
                if (m === 'focused' || m === 'stuck') moods[k] = { mood: m, since: now() };
            });
            needs = {};
            (open.needs || []).forEach(function (ev) {
                if (!ev || !ev.agent) return;
                (needs[ev.agent] || (needs[ev.agent] = {}))[String(ev.ref || '_')] = true;
            });
            Object.keys(poses).forEach(function (k) { if (!moodPoseOk(k)) setPose(k, null); });
            syncAllDecor();
        },
        onSettings: function () {
            if (!life.isOn('moods')) clearAll();
            else syncAllDecor();
        },
        onEvent: function (ev) {
            var key = ev.agent;
            if (!key) return;
            if (ev.type === 'mood') {
                var mood = String(ev.mood || 'clear');
                setMood(key, mood);
                if (mood === 'relieved') startRelief(key, ev);
                else if (relief[key] && mood !== 'clear') delete relief[key];
            } else if (ev.type === 'needs.open') {
                (needs[key] || (needs[key] = {}))[String(ev.ref || '_')] = true;
            } else if (ev.type === 'needs.close') {
                if (needs[key]) {
                    delete needs[key][String(ev.ref || '_')];
                    if (!Object.keys(needs[key]).length) delete needs[key];
                }
            }
        },
        onRoster: function () {
            // New Agent objects: the poses we set are gone with the old ones.
            poses = {};
            syncAllDecor();
        },
        update: function (t) {
            if (t - lastTick < TICK_MS) return;
            lastTick = t;
            var h = host();
            if (!h) return;
            Object.keys(relief).forEach(function (k) { if (t > relief[k].until) delete relief[k]; });
            Object.keys(moods).forEach(function (k) {
                var m = moods[k], name = MOOD_POSE[m.mood];
                var a = name && h.agent(k);
                if (!a) return;
                var want;
                if (m.mood === 'stuck') {
                    // Hand on the head for 2 s when it gets stuck, then every ~12 s.
                    var phase = (t - m.since) % STUCK_EVERY_MS;
                    want = phase < STUCK_FOR_MS && !offline(a) && free(a);
                } else {
                    // Focused: lean in over the keys while seated and working (a
                    // celebration may take over the ambient pose; it comes back after).
                    want = a.isSitting && a.state === 'working' && !offline(a) && free(a);
                }
                // A taken-over scratch waits for its next cycle; the lean comes straight back.
                var lost = m.mood === 'focused' && a._lifePose !== name;
                if (want && (poses[k] !== name || lost)) setPose(k, name);
                else if (!want && poses[k] === name) setPose(k, null);
            });
            Object.keys(poses).forEach(function (k) { if (!moodPoseOk(k)) setPose(k, null); });
        },
        isBusy: function () {
            var t = now();
            for (var k in relief) if (t >= relief[k].puffAt && t < relief[k].puffAt + PUFF_MS) return true;
            return false;
        },
        drawScreen: function (ctx) {
            var h = host();
            if (!h || h.editMode()) return;
            placed = [];
            // Nothing to show: no per-frame work (rects cleared once).
            var any = Object.keys(moods).length || Object.keys(needs).length || Object.keys(relief).length;
            if (!any) {
                if (drewLast) { h.agents().forEach(function (a) { a._lifeMoodRect = null; }); drewLast = false; }
                return;
            }
            drewLast = true;
            var m = h.ctlMetrics(), t = now();
            var chrome = h.chrome() || [];
            var list = h.agents().slice().sort(function (p, q) { return q.y - p.y; }); // front agents first
            var s = badgeSize();
            for (var i = 0; i < list.length; i++) {
                var a = list[i], key = keyOf(a), c = a._ctl;
                a._lifeMoodRect = null;
                if (!c || !c.tag) continue;
                var rel = relief[key];
                if (rel && t >= rel.puffAt && t < rel.puffAt + PUFF_MS && !offline(a)) {
                    var pr = puffRect(ctx, c.tag, m, t, rel);
                    if (!blocked(pr, a, chrome)) {
                        drawPuff(ctx, pr, m);
                        placed.push(pr);
                        a._lifeMoodRect = { x: pr.x, y: pr.y, w: pr.w, h: pr.h, mood: 'relieved' };
                    }
                    continue;
                }
                var mood = moodFor(key, a);
                if (!mood || !ICONS[mood]) continue;
                var r = { x: Math.round(c.tag.x - m.gap - s), y: Math.round(c.tag.y + c.tag.h / 2 - s / 2), w: s, h: s };
                if (blocked(r, a, chrome)) continue; // skipped this frame: never cover a neighbour
                drawBadge(ctx, r, mood);
                placed.push(r);
                a._lifeMoodRect = { x: r.x, y: r.y, w: r.w, h: r.h, mood: mood };
            }
        },
        reset: function (reason) {
            relief = {};
            if (reason === 'disabled') clearAll();
        },
        // tests / debugging
        _debug: function () { return { moods: JSON.parse(JSON.stringify(moods)), needs: JSON.parse(JSON.stringify(needs)), poses: Object.assign({}, poses), relief: Object.keys(relief) }; }
    });
    window.VOLifeMoods = { _debug: function () { return def._debug(); }, headphones: headphonesArt,
        // The face game.js draws (_agentExpression): 'waiting' | 'stuck' | 'focused' | 'relieved' | '' (moods off: '').
        face: function (a) {
            var k = keyOf(a);
            if (!k || !life.isOn('moods')) return '';
            return moodFor(k, a) || (relief[k] && now() < relief[k].until ? 'relieved' : '');
        } };
})();
