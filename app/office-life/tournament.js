// Office life: Break-time tournaments (feature 9, design .work/life/design.md 3.9).
// The server decides everything (tournament.py): who plays, the bracket, every
// match's winner and score, walkovers when real work pulls a player away, and
// the champion. This module stages it: the bracket players walk over and
// watch from beside the table, the two players of the current match step to
// their sides and play a decided game (host.startPong / startDarts with the
// server's winner and score), the winner pumps a fist and everybody watches
// until the end. The notice board carries a pinned bracket sheet (static
// layer) and a readable pill (live match or today's champion); hover shows
// the bracket card, click/tap opens the bracket window. Clicking a player in
// the current match cheers (server-counted, hearts in every tab).
// Real work always wins: the director ends a player's script the moment it
// starts working, game.js aborts the game, the server sends the walkover.
// Calm / reduced motion: nobody walks or plays; the board still shows it all.
(function (root) {
    'use strict';
    var life = root.VOLife;
    if (!life) return;

    life.addText({
        tourPong: 'Ping pong', tourDarts: 'Darts', tourVs: '{a} v {b}', tourNow: 'playing now', tourNext: 'next',
        tourLivePill: '{round}: {a} v {b}', tourChampionPill: 'Champion: {name}', tourDonePill: '{title}: {status}',
        tourChampionToast: '{name} won the break-time tournament', tourScore: '{name} won {score}',
        tourWalkover: '{name} {walkover}', tourCheerCount: '{n}'
    });

    var LATE_PLAY_MS = 8000;       // less than this left of a match: show the result only
    var CLOSE_GRACE_MS = 15000;    // the final may finish its game after tournament.end
    var POST_POSE_MS = 2400;
    var HEART_MS = 1400, HEARTS_MAX = 24;
    var CHEER_GAP_MS = 1000;       // the server allows one a second per client
    var TIP_MS = 2200;
    var CALLED_OFF_SHOW_MS = 15 * 60000;

    var T = null;         // the tournament on the board
    var champ = null;     // today's champion from /state when the bracket is gone
    var people = {};      // bracket player key -> {ctl, role, ...}
    var hearts = [];
    var rects = { pill: null, card: null, players: {} };
    var hoverAt = null;   // {kind:'board'|'player', key}
    var tipUntil = 0, tipKey = '';
    var lastCheerAt = 0;
    var win = null;       // bracket window element

    function H() { return life.host(); }
    function D() { return life.director(); }
    function SP() { return life.sprites(); }
    function now() { return Date.now(); }
    function sNow() { return life.serverNow ? life.serverNow() : Date.now(); }
    function toMs(v) { v = Number(v); if (!v) return 0; return v < 1e12 ? v * 1000 : v; }
    function agentOf(key) { var h = H(); return h && h.agent ? h.agent(key) : null; }
    function nameOf(key) { var a = agentOf(key); return life.clip((a && a.name) || key || '?', 20); }
    function emojiOf(key) { var a = agentOf(key); var e = a && a.emoji ? String(a.emoji) : ''; return e.length <= 8 ? e : ''; }
    function tag3(key) {
        var n = String((agentOf(key) || {}).name || key || '?').trim();
        var latin = n.replace(/[^A-Za-z0-9]/g, '');
        return (latin.length >= 2 ? latin : n).slice(0, 3).toUpperCase();
    }
    function tagOf(key) { var e = emojiOf(key); return (e ? e + ' ' : '') + tag3(key); }
    // Full first name (UI-10): the card and window have room; 3-letter codes only where space is short.
    function firstName(key) { var n = String((agentOf(key) || {}).name || key || '?').trim(); return life.clip(n.split(/\s+/)[0] || n, 12); }
    function playerOf(key) { var e = emojiOf(key); return (e ? e + ' ' : '') + firstName(key); }
    var PILL_CHARS = 30, PILL_CHARS_COMPACT = 22;
    function busy(ms) { var h = H(); if (h && h.markBusy) h.markBusy(ms || 600); }
    function invalidate() { var h = H(); if (h && h.invalidateStatic) h.invalidateStatic(); busy(400); }
    function compact() { var h = H(); return !!(h && h.compact && h.compact()); }
    function spots() { var h = H(); return (h && h.spots && h.spots()) || {}; }
    function board() { return spots().noticeBoard || null; }

    // ---- bracket model ----
    function maxRound() { return T ? T.matches.reduce(function (m, x) { return Math.max(m, x.round || 1); }, 1) : 1; }
    function roundLabel(m) { return (m.round || 1) >= maxRound() ? life.t('final') : life.t('semi'); }
    // p1/p2 of a bracket match: given, or the winners of earlier matches.
    function slotPlayers(m) {
        var ev = T.events[m.match];
        if (ev && !ev.walkover && ev.p1) return [ev.p1, ev.p2];
        if (!m.from) return [m.p1 || null, m.p2 || null];
        var filled = m.from.map(function (n) { var r = T.results[n]; return r ? r.winner : null; });
        return m.p1 ? [m.p1, filled[0]] : [filled[0], filled[1] || null];
    }
    function decided(ev) { return { winner: ev.winner, score: Array.isArray(ev.score) ? ev.score.slice(0, 2) : null, walkover: false }; }
    function scoreText(m, r) {
        if (!r) return '';
        if (r.walkover) return life.t('tourWalkover', { name: firstName(r.winner), walkover: life.t('walkover') });
        var pl = slotPlayers(m), s = r.score;
        if (!s) return firstName(r.winner);
        var ws = r.winner === pl[1] ? s[1] + '-' + s[0] : s[0] + '-' + s[1];
        return life.t('tourScore', { name: firstName(r.winner), score: ws });
    }

    function startTour(ev) {
        var b = ev.bracket && typeof ev.bracket === 'object' ? ev.bracket : {};
        var matches = (Array.isArray(b.matches) ? b.matches : []).filter(function (m) { return m && m.match; })
            .map(function (m) { return { match: Number(m.match), round: Number(m.round) || 1, p1: m.p1 || null, p2: m.p2 || null, from: Array.isArray(m.from) ? m.from.map(Number) : null }; });
        T = { id: String(ev.id || ''), game: ev.game === 'darts' ? 'darts' : 'pong', players: (ev.players || []).slice(0, 4),
            byes: Array.isArray(b.byes) ? b.byes.slice(0, 2) : [], matches: matches, events: {}, results: {}, cheers: {},
            status: 'live', champion: null, live: null, endedAt: 0, closing: 0 };
        champ = null;
        people = {};
        invalidate();
    }

    // ---- people (one director script per bracket player for the whole tournament) ----
    function person(key) {
        return people[key] || (people[key] = { key: key, ctl: null, role: 'watch', walking: false, arrived: false, poseUntil: 0, gone: false });
    }
    function canStage() { return !!(T && T.status === 'live' && !life.atDesk() && D()); }
    function enlist(key) {
        if (!canStage() || !agentOf(key)) return;
        var P = person(key), d = D();
        if (P.ctl || P.gone) return;
        var c = d.current(key);
        if (c && c.feature === 'tournament') return;
        if (d.queued(key).some(function (b) { return b.feature === 'tournament'; })) return;
        var id = T.id;
        d.request(key, {
            kind: 'tournament', feature: 'tournament', moves: true, label: life.t('holdTournament'),
            maxMs: 10 * 60000, staleMs: 15000,
            start: function (ctl) {
                if (!T || T.id !== id || T.status !== 'live') { ctl.done('over'); return; }
                P.ctl = ctl;
                route(P);
            },
            update: function (ctl) { if (!T || T.id !== id || (T.status !== 'live' && !T.closing)) ctl.done('over'); },
            end: function (ctl, reason) {
                if (P.ctl !== ctl) return;
                P.ctl = null; P.walking = false; P.arrived = false;
                if (reason === 'work' || reason === 'meeting' || reason === 'offline' || reason === 'gone') P.gone = true;
            }
        });
    }
    function sideFor(key) {
        var L = T && T.live, sp = spots();
        if (!L) return null;
        var left = key === L.p1;
        if (T.game === 'pong' && sp.pongTable) return left ? sp.pongTable.left : sp.pongTable.right;
        if (T.game === 'darts' && sp.dartBoard) return { x: sp.dartBoard.x + (left ? -16 : 16), y: sp.dartBoard.y };
        return null;
    }
    function tableCentre() {
        var sp = spots();
        if (T && T.game === 'darts' && sp.dartBoard) return sp.dartBoard;
        return sp.pongTable || sp.dartBoard || null;
    }
    // Spectators stand in a row in front of the table, never on the playing sides.
    function spectatorSpot(key) {
        var c = tableCentre(), h = H();
        if (!c || !T) return null;
        var order = T.players.indexOf(key);
        if (order < 0) order = 0;
        var offs = [-66, 66, -30, 30];
        var x = c.x + offs[order % 4], y = c.y + (T.game === 'darts' ? 44 : 40) + (order >= 4 ? 22 : 0);
        var p = h && h.nearestWalkable ? h.nearestWalkable(x, y, 2) : { x: x, y: y };
        return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
    }
    function faceTo(P, pt) {
        if (!P.ctl || !pt) return;
        var a = P.ctl.agent();
        if (a) P.ctl.face(pt.x >= a.x ? 1 : -1);
    }
    function route(P) {
        var ctl = P.ctl;
        if (!ctl || !ctl.active()) return;
        var target = P.role === 'play' ? sideFor(P.key) : spectatorSpot(P.key);
        ctl.pose(null);
        if (!target) {
            P.arrived = true; P.walking = false;
            if (P.role === 'play') maybeStartGame();
            return;
        }
        P.arrived = false; P.walking = true;
        ctl.walk(target.x, target.y, function () {
            if (!ctl.active()) return;
            P.walking = false; P.arrived = true;
            if (P.role === 'watch') { faceTo(P, tableCentre()); ctl.pose('watch', { still: life.reducedMotion() }); }
            else if (P.role === 'play') maybeStartGame();
        });
    }
    function toWatch(key) {
        var P = people[key];
        if (!P) return;
        P.role = 'watch';
        if (P.ctl) route(P); else enlist(key);
    }

    // ---- the current match ----
    function liveFrom(ev) {
        var startsAt = toMs(ev.startsAt) || sNow();
        return { match: Number(ev.match), ev: ev, p1: ev.p1, p2: ev.p2, startsAt: startsAt,
            endAt: startsAt + (Number(ev.ms) || 40000), game: null, stopping: false };
    }
    function settle(n, res) {
        if (!T || !res || !res.winner) return;
        T.results[n] = res;
        invalidate();
        refreshWindow();
    }
    // Stop a decided game that is still on the table (walkover, next match,
    // tournament over): host.stopGame ends the game either player is in
    // (its onAbort hears 'stopped', ignored here through L.stopping).
    function stopGame(L) {
        if (!L || L.game !== 'on') return;
        L.stopping = true;
        L.game = 'stopped';
        var h = H();
        if (h && h.stopGame && !h.stopGame(L.p1)) h.stopGame(L.p2);
    }
    function playMatch(ev) {
        var n = Number(ev.match);
        var prev = T.live;
        if (prev && prev.match !== n) {
            stopGame(prev);
            if (!T.results[prev.match]) settle(prev.match, decided(prev.ev));
            T.live = null;
        }
        var L = T.live = liveFrom(ev);
        if (L.endAt - sNow() < LATE_PLAY_MS) { L.game = 'late'; return; }
        // Everybody in the bracket watches; the two players step up.
        T.players.forEach(function (k) {
            var P = person(k);
            if (k === L.p1 || k === L.p2) P.role = 'play';
            else if (P.role === 'play' || P.role === 'post') P.role = 'watch';
            if (P.ctl) route(P); else enlist(k);
        });
        busy(800);
    }
    function maybeStartGame() {
        var L = T && T.live, h = H();
        if (!L || L.game || !h) return;
        var a = people[L.p1], b = people[L.p2];
        if (!a || !b || !a.ctl || !b.ctl) return;
        var ready = (a.arrived && b.arrived) || sNow() > L.startsAt + 12000;
        if (!ready) return;
        var fn = T.game === 'darts' ? h.startDarts : h.startPong;
        if (typeof fn !== 'function') { L.game = 'none'; return; }
        var remaining = Math.max(12000, L.endAt - sNow());
        var ok = fn.call(h, L.p1, L.p2, { winner: L.ev.winner, score: L.ev.score, ms: remaining,
            onEnd: function () { gameEnded(L); },
            onAbort: function (reason, key) { gameAborted(L, reason, key); } });
        L.game = ok ? 'on' : 'none';
        if (ok) { a.ctl.pose(null); b.ctl.pose(null); busy(1000); }
    }
    function gameEnded(L) {
        if (!T || T.live !== L) return;
        L.game = 'done';
        settle(L.match, decided(L.ev));
        T.live = null;
        var t = now();
        [L.p1, L.p2].forEach(function (k) {
            var P = people[k];
            if (!P || !P.ctl) return;
            P.role = 'post';
            P.poseUntil = t + POST_POSE_MS;
            var won = k === L.ev.winner;
            P.ctl.pose(won ? 'fistpump' : 'headscratch', { still: life.reducedMotion() });
        });
        busy(POST_POSE_MS);
    }
    function gameAborted(L, reason, key) {
        if (!T || T.live !== L || L.stopping) return;
        L.game = 'aborted';
        // The loser walked off to real work: the match just ends with the decided result.
        if (reason === 'moved' && key && key !== L.ev.winner) { settle(L.match, decided(L.ev)); T.live = null; }
        // The decided winner left: the server sends a walkover (else the time runs out).
        [L.p1, L.p2].forEach(function (k) { if (k !== key) toWatch(k); });
    }

    // ---- events ----
    function onMatch(ev) {
        if (!T || ev.id !== T.id) return;
        var n = Number(ev.match);
        T.events[n] = ev;
        if (ev.walkover) {
            var L = T.live;
            if (L && L.match === n) { stopGame(L); T.live = null; [L.p1, L.p2].forEach(toWatch); }
            settle(n, { winner: ev.winner, walkover: true });
            return;
        }
        if (T.results[n]) return;
        playMatch(ev);
        invalidate();
        refreshWindow();
    }
    function endTour(ev) {
        if (!T || (ev.id && ev.id !== T.id)) {
            if (ev.champion && ev.status === 'done') { champ = { agent: ev.champion }; invalidate(); }
            return;
        }
        // The final may still be on the table here (it started late in this
        // tab): the result waits until its game ends, never spoiled early.
        var L = T.live;
        if (L && L.game === 'on' && !T.closing) { T.closing = now() + CLOSE_GRACE_MS; T.pendingEnd = ev; return; }
        applyEnd(ev);
    }
    function applyEnd(ev) {
        T.closing = 0;
        T.pendingEnd = null;
        closeTour();
        T.status = ev.status === 'called_off' ? 'called_off' : 'done';
        T.champion = ev.status === 'done' && ev.champion ? ev.champion : null;
        T.endedAt = now();
        if (T.champion) {
            T.matches.forEach(function (m) {
                var e = T.events[m.match];
                if (!T.results[m.match] && e && !e.walkover && e.winner === T.champion) T.results[m.match] = decided(e);
            });
        }
        invalidate();
        refreshWindow();
        // Titles and games are in the leaderboard now.
        setTimeout(function () { try { if (root.ProjMgr && root.ProjMgr.refreshLeaderboard) root.ProjMgr.refreshLeaderboard(); } catch (e) {} }, 1500);
        if (T.champion && !board() && root.VOUI && root.VOUI.toast) root.VOUI.toast(life.t('tourChampionToast', { name: nameOf(T.champion) }), { kind: 'success' });
    }
    function closeTour() {
        if (!T) return;
        T.closing = 0;
        var L = T.live;
        if (L) { stopGame(L); if (!T.results[L.match] && L.ev) settle(L.match, decided(L.ev)); T.live = null; }
        if (D()) D().cancelFeature('tournament', 'over');
        people = {};
        busy(600);
    }
    function onCheer(ev) {
        if (!T || ev.id !== T.id || !ev.agent) return;
        var k = Number(ev.match) + '|' + ev.agent;
        var prev = T.cheers[k] || 0, n = Number(ev.count) || 0;
        T.cheers[k] = Math.max(prev, n);
        // A count this tab already showed is not a new cheer: its own cheer from the POST reply
        // (stream down) arrives again from the stream, or as a replay after a reconnect.
        if (n && n <= prev) return;
        if (!life.reducedMotion() && !life.calm()) {
            hearts.push({ agent: ev.agent, born: now(), dx: (Math.random() * 2 - 1) * 8 });
            if (hearts.length > HEARTS_MAX) hearts.splice(0, hearts.length - HEARTS_MAX);
        }
        busy(HEART_MS);
    }
    function fromState(snap) {
        var open = snap && snap.open && snap.open.tournament;
        var today = snap && snap.today;
        if (open && open.start) {
            var st = open.start;
            if (!T || T.id !== st.id) startTour(st);
            (open.matches || []).forEach(function (ev) {
                var n = Number(ev.match);
                T.events[n] = ev;
                if (ev.walkover) { settle(n, { winner: ev.winner, walkover: true }); return; }
                var end = (toMs(ev.startsAt) || 0) + (Number(ev.ms) || 40000);
                if (sNow() > end) { if (!T.results[n]) settle(n, decided(ev)); }
                else if (!T.live || T.live.match !== n) playMatch(ev);
            });
            (open.cheers || []).forEach(function (c) { T.cheers[Number(c.match) + '|' + c.agent] = Number(c.count) || 0; });
            T.players.forEach(enlist); // first load, or a resync ended the scripts
        } else if (T && T.status === 'live') {
            // It ended while this tab was away.
            closeTour();
            T = null;
        }
        if (!T && today && today.champion) champ = { agent: String(today.champion) };
        invalidate();
    }

    // ---- update ----
    function update() {
        var t = now();
        if (hearts.length && t - hearts[0].born > HEART_MS) hearts = hearts.filter(function (h) { return t - h.born <= HEART_MS; });
        if (!T) return;
        if (T.closing) {
            if (!T.live || T.live.game !== 'on' || t > T.closing) applyEnd(T.pendingEnd);
            return;
        }
        if (T.status !== 'live') return;
        var L = T.live;
        if (L) {
            if (!L.game) maybeStartGame();
            if (L.game !== 'on' && sNow() > L.endAt + 1500) {
                if (!T.results[L.match]) settle(L.match, decided(L.ev));
                T.live = null;
                [L.p1, L.p2].forEach(function (k) { var P = people[k]; if (P && P.role === 'play') toWatch(k); });
            }
        }
        Object.keys(people).forEach(function (k) {
            var P = people[k];
            if (P.role === 'post' && t > P.poseUntil) toWatch(k);
        });
    }

    // ---- notice board: pinned sheet (static layer) ----
    function colorOf(key) { var a = agentOf(key); return (a && a.color) || '#90a4ae'; }
    function px(ctx, c, x, y, w, h) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
    function chip(ctx, key, x, y, lit) {
        px(ctx, '#4e342e', x - 1, y - 1, 5, 5);
        px(ctx, key ? colorOf(key) : '#cfd8dc', x, y, 3, 3);
        if (lit) px(ctx, '#ffd54f', x - 1, y - 2, 5, 1);
    }
    function drawSheet(ctx, nb, data) {
        var x = nb.x + 3, y = nb.y + 4, w = 22, h = Math.min(22, nb.h - 7);
        px(ctx, 'rgba(0,0,0,0.25)', x + 1, y + 1, w, h);
        px(ctx, '#fbf8ef', x, y, w, h);
        px(ctx, data.game === 'darts' ? '#c62828' : '#2e7d32', x, y, w, 2);
        px(ctx, '#e53935', x + w / 2 - 1, y - 1, 2, 2);
        var line = '#6d4c41';
        var res = data.results || {}, ms = data.matches || [];
        var top = y + 4, bot = y + h - 5, mid = (top + bot) / 2;
        function winnerOf(n) { return res[n] ? res[n].winner : null; }
        if (ms.length === 3 && data.size === 4) {
            var r1 = [top, top + 4], r2 = [bot - 4, bot];
            [[ms[0], r1], [ms[1], r2]].forEach(function (pair) {
                var m = pair[0], rows = pair[1], w0 = winnerOf(m.match);
                chip(ctx, m.p1, x + 2, rows[0], w0 && w0 === m.p1);
                chip(ctx, m.p2, x + 2, rows[1], w0 && w0 === m.p2);
                px(ctx, line, x + 6, rows[0] + 1, 3, 1); px(ctx, line, x + 6, rows[1] + 1, 3, 1);
                px(ctx, line, x + 9, rows[0] + 1, 1, rows[1] - rows[0] + 1);
                px(ctx, line, x + 9, (rows[0] + rows[1]) / 2 + 1, 2, 1);
                chip(ctx, w0, x + 11, (rows[0] + rows[1]) / 2, false);
            });
            px(ctx, line, x + 15, (top + top + 4) / 2 + 1, 1, (bot - 2) - (top + 2) + 1);
            px(ctx, line, x + 15, mid + 1, 2, 1);
            chip(ctx, winnerOf(ms[2].match), x + 17, mid, !!winnerOf(ms[2].match));
        } else if (ms.length === 2) {
            var m1 = ms[0], f = ms[1], bye = (data.byes || [])[0] || f.p1, w1 = winnerOf(m1.match);
            chip(ctx, bye, x + 6, top, false);
            chip(ctx, m1.p1, x + 2, bot - 4, w1 && w1 === m1.p1);
            chip(ctx, m1.p2, x + 2, bot, w1 && w1 === m1.p2);
            px(ctx, line, x + 6, bot - 3, 3, 1); px(ctx, line, x + 6, bot + 1, 3, 1);
            px(ctx, line, x + 9, bot - 3, 1, 5);
            px(ctx, line, x + 9, bot - 1, 2, 1);
            chip(ctx, w1, x + 11, bot - 2, false);
            px(ctx, line, x + 10, top + 1, 5, 1);
            px(ctx, line, x + 15, top + 1, 1, bot - top - 2);
            px(ctx, line, x + 15, mid + 1, 2, 1);
            chip(ctx, winnerOf(f.match), x + 17, mid, !!winnerOf(f.match));
        } else if (ms.length === 1) {
            var only = ms[0], w2 = winnerOf(only.match);
            chip(ctx, only.p1, x + 3, top + 2, w2 && w2 === only.p1);
            chip(ctx, only.p2, x + 3, bot - 2, w2 && w2 === only.p2);
            px(ctx, line, x + 7, top + 3, 4, 1); px(ctx, line, x + 7, bot - 1, 4, 1);
            px(ctx, line, x + 11, top + 3, 1, bot - top - 3);
            px(ctx, line, x + 11, mid + 1, 3, 1);
            chip(ctx, w2, x + 15, mid, !!w2);
        } else if (data.champion) {
            chip(ctx, data.champion, x + w / 2 - 1, mid, true);
        }
        if (data.status === 'called_off') { px(ctx, 'rgba(198,40,40,0.85)', x + 2, mid + 1, w - 4, 1); }
        var sp = SP();
        if (data.champion && sp) sp.draw(ctx, 'trophy', nb.x + Math.max(32, nb.w - 9), nb.y + nb.h / 2, { scale: 1 });
    }
    function drawStatic(ctx) {
        var nb = board();
        if (!nb || !ctx) return;
        if (T) {
            drawSheet(ctx, nb, { game: T.game, size: T.players.length, matches: T.matches, byes: T.byes, results: T.results,
                champion: T.status === 'done' ? T.champion : null, status: T.status });
        } else if (champ) {
            drawSheet(ctx, nb, { game: 'pong', matches: [], champion: champ.agent, status: 'done' });
        }
    }

    // ---- screen: board pill, bracket card, cheers ----
    function boardText() {
        if (T) {
            if (T.status === 'done' && T.champion) return { text: life.t('tourChampionPill', { name: nameOf(T.champion) }), kind: 'success' };
            if (T.status === 'called_off') {
                if (now() - T.endedAt > CALLED_OFF_SHOW_MS) return null;
                return { text: life.t('tourDonePill', { title: life.t('tournamentTitle'), status: life.t('calledOff') }), kind: 'neutral' };
            }
            var L = T.live, m = L && T.matches.filter(function (x) { return x.match === L.match; })[0];
            if (L && m) {
                var full = life.t('tourLivePill', { round: roundLabel(m), a: playerOf(L.p1), b: playerOf(L.p2) });
                if (full.length <= (compact() ? PILL_CHARS_COMPACT : PILL_CHARS)) return { text: full, kind: 'info' };
                return { text: life.t('tourLivePill', { round: roundLabel(m), a: tagOf(L.p1), b: tagOf(L.p2) }), kind: 'info' };
            }
            return { text: life.t('tournamentTitle'), kind: 'info' };
        }
        if (champ) return { text: life.t('tourChampionPill', { name: nameOf(champ.agent) }), kind: 'success' };
        return null;
    }
    // Bracket rows for the card and the window: [{label, text, state}]
    function bracketRows() {
        if (!T) return champ ? [{ label: life.t('champion'), text: nameOf(champ.agent), players: [champ.agent], state: 'won', won: true }] : [];
        var rows = [];
        T.byes.forEach(function (k) { rows.push({ label: life.t('bye'), text: playerOf(k), players: [k], state: '' }); });
        T.matches.forEach(function (m) {
            var pl = slotPlayers(m), r = T.results[m.match];
            var vs = life.t('tourVs', { a: pl[0] ? playerOf(pl[0]) : '?', b: pl[1] ? playerOf(pl[1]) : '?' });
            var state = r ? scoreText(m, r) : (T.live && T.live.match === m.match ? life.t('tourNow') : (T.status === 'live' ? life.t('tourNext') : ''));
            rows.push({ label: roundLabel(m), text: vs, players: [pl[0] || null, pl[1] || null], winner: r && r.winner, state: state, live: !r && T.live && T.live.match === m.match });
        });
        if (T.status === 'done' && T.champion) rows.push({ label: life.t('champion'), text: nameOf(T.champion), players: [T.champion], state: '', won: true });
        if (T.status === 'called_off') rows.push({ label: life.t('tournamentTitle'), text: life.t('calledOff'), state: '' });
        return rows;
    }
    function drawCard(ctx, x, y) {
        var h = H(), rows = bracketRows();
        if (!rows.length) return null;
        var m = (h && h.ctlMetrics && h.ctlMetrics()) || { h: 22 };
        var fs = m.h >= 24 ? 12 : 11, lh = fs + 6, pad = 8;
        ctx.save();
        // Pixel font on the canvas (Q-05): emoji avatars stay in the bracket window, not on the card;
        // text the font cannot draw falls back to the UI font.
        var PF = window.VOPixelFont, UI = 'px Inter, system-ui, sans-serif';
        var plain = function (t) { return String(t || '').replace(/(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/gu, '').replace(/ \u00b7 /g, ' - ').trim(); };
        var tw_ = function (t, bold) { t = plain(t); if (PF && PF.has(t)) return PF.measure(t); ctx.font = (bold ? '600 ' : '') + fs + UI; return ctx.measureText(t).width; };
        var txt = function (t, x0, y0, color, bold, right) {
            t = plain(t);
            var w0 = tw_(t, bold), xl = right ? x0 - w0 : x0;
            if (PF && PF.has(t)) { PF.draw(ctx, t, Math.round(xl), y0 + Math.round((fs - 7) / 2), 1, color); return; }
            ctx.font = (bold ? '600 ' : '') + fs + UI; ctx.fillStyle = color; ctx.fillText(t, xl, y0);
        };
        var title = life.t('tournamentTitle') + (T ? ' · ' + life.t(T.game === 'darts' ? 'tourDarts' : 'tourPong') : '');
        var lw = 0, tw = 0, sw = 0;
        rows.forEach(function (r) { lw = Math.max(lw, tw_(r.label, true)); tw = Math.max(tw, tw_(r.text)); sw = Math.max(sw, tw_(r.state || '')); });
        var w = Math.round(Math.min(340, Math.max(tw_(title, true) + 20, lw + tw + sw + 30) + pad * 2));
        var hh = pad * 2 + lh * (rows.length + 1) - 4;
        var r = { x: Math.round(x - w / 2), y: Math.round(y), w: w, h: hh };
        if (h && h.keepOutOfChrome) r = h.keepOutOfChrome(r, null, 4) || r;
        if (SP() && SP().clampToView) r = SP().clampToView(r); // UI-23
        px(ctx, 'rgba(0,0,0,0.35)', r.x + 1, r.y + 2, r.w - 2, r.h); // the chip family's 2 px shadow
        px(ctx, '#3e2723', r.x + 1, r.y, r.w - 2, r.h); px(ctx, '#3e2723', r.x, r.y + 1, r.w, r.h - 2);
        px(ctx, '#fffdf4', r.x + 2, r.y + 1, r.w - 4, r.h - 2); px(ctx, '#fffdf4', r.x + 1, r.y + 2, r.w - 2, r.h - 4);
        px(ctx, '#2e7d32', r.x + 2, r.y + 1, r.w - 4, 3);
        ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        var cy = r.y + pad;
        if (SP()) SP().draw(ctx, 'trophy', r.x + pad + 5, cy + fs / 2 + 1, { scale: 1 });
        txt(title, r.x + pad + 14, cy, '#1d1d1f', true);
        cy += lh;
        rows.forEach(function (row) {
            if (row.live) px(ctx, 'rgba(96,165,250,0.22)', r.x + 3, cy - 3, r.w - 6, lh - 1);
            txt(row.label, r.x + pad, cy, row.won ? '#8d6e00' : '#5d4037', true);
            txt(row.text, r.x + pad + lw + 10, cy, '#1d1d1f');
            if (row.state) txt(row.state, r.x + r.w - pad, cy, row.live ? '#0d47a1' : '#4e6b3a', false, true);
            cy += lh;
        });
        ctx.restore();
        return r;
    }
    function bodyRect(a, h) {
        if (!h.worldToCanvas) return null;
        var p = h.worldToCanvas(a.x - 11, a.y - 46), q = h.worldToCanvas(a.x + 11, a.y + 4);
        return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
    }
    function cheerOpen() { var L = T && T.status === 'live' && T.live; return L && L.game !== 'late' ? L : null; }
    function drawScreen(ctx) {
        var h = H(), sp = SP();
        rects = { pill: null, card: null, players: {} };
        if (!h || !sp || (h.editMode && h.editMode())) return;
        var view = h.view ? h.view() : { w: 1e9, h: 1e9 };
        var nb = board(), info = boardText();
        if (nb && info && h.worldToCanvas) {
            // Under the board, so the pinned sheet stays in view.
            var c = h.worldToCanvas(nb.x + nb.w / 2, nb.y + nb.h);
            if (c.x > -40 && c.x < view.w + 40 && c.y > -40 && c.y < view.h + 40) {
                rects.pill = sp.label(ctx, info.text, c.x, c.y + 4, { kind: info.kind, icon: 'trophy', anchor: 'top', maxW: compact() ? 200 : 240 });
                if (hoverAt && hoverAt.kind === 'board' && !compact()) rects.card = drawCard(ctx, c.x, rects.pill.y + rects.pill.h + 6);
            }
        }
        // Cheers: counts, rising hearts, the tip.
        var L = cheerOpen(), t = now();
        if (L) {
            [L.p1, L.p2].forEach(function (k) {
                var a = agentOf(k);
                if (!a) return;
                var r = bodyRect(a, h);
                if (!r) return;
                rects.players[k] = r;
                var n = T.cheers[L.match + '|' + k] || 0;
                var top = { x: r.x + r.w / 2, y: r.y - 6 };
                var hovered = hoverAt && hoverAt.kind === 'player' && hoverAt.key === k;
                if (hovered || (tipKey === k && t < tipUntil)) {
                    sp.label(ctx, life.t('cheerTip'), top.x, top.y - (n ? 26 : 0), { kind: 'neutral', icon: 'heart' });
                }
                if (n > 0) sp.label(ctx, life.t('tourCheerCount', { n: n }), top.x, top.y, { kind: 'neutral', icon: 'heart' });
            });
        }
        if (hearts.length) {
            hearts.forEach(function (ht) {
                var a = agentOf(ht.agent), r = a && bodyRect(a, h);
                if (!r) return;
                var k = Math.min(1, (t - ht.born) / HEART_MS);
                sp.draw(ctx, 'heart', r.x + r.w / 2 + ht.dx + Math.sin(k * 9) * 3, r.y - 30 - k * 34, { scale: 2, alpha: 1 - k * k });
            });
        }
    }

    // ---- input ----
    function cheer(key) {
        var L = cheerOpen();
        if (!L || (key !== L.p1 && key !== L.p2)) return;
        tipKey = key; tipUntil = now() + TIP_MS;
        busy(TIP_MS);
        if (now() - lastCheerAt < CHEER_GAP_MS) return;
        lastCheerAt = now();
        var body = { tournament: T.id, match: L.match, agent: key };
        var p = life.post ? life.post('/api/office-life/cheer', body) : null;
        if (p && p.then) p.then(function (res) {
            // No live stream (poll fallback): show this tab's own cheer.
            if (!life.live || !life.live()) onCheer({ id: body.tournament, match: body.match, agent: key, count: res && res.count });
        }).catch(function () {});
    }
    function hit(x, y, touch) {
        var sp = SP();
        if (!sp) return null;
        if (rects.card && sp.hitRect(rects.card, x, y, touch)) return { kind: 'board' };
        if (rects.pill && sp.hitRect(rects.pill, x, y, touch)) return { kind: 'board' };
        var keys = Object.keys(rects.players);
        for (var i = 0; i < keys.length; i++) if (sp.hitRect(rects.players[keys[i]], x, y, touch)) return { kind: 'player', key: keys[i] };
        return null;
    }

    // ---- bracket window (phone tap / click on the board) ----
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function fillWindow() {
        if (!win) return;
        var body = win.querySelector('.vo-window-body');
        if (!body) return;
        body.textContent = '';
        var rows = bracketRows();
        if (!rows.length) { body.innerHTML = root.VOIcon ? root.VOIcon.emptyHtml({ icon: 'trophy', title: life.t('tournamentTitle') }) : ''; return; }
        var list = el('ol', 'vo-life-bracket');
        rows.forEach(function (row) {
            var li = el('li', 'vo-life-bracket-row' + (row.live ? ' is-live' : '') + (row.won ? ' is-won' : ''));
            li.appendChild(el('span', 'vo-life-bracket-round', row.label));
            var who = el('span', 'vo-life-bracket-players');
            var keys = row.players && row.players.length ? row.players : null;
            if (!keys) who.textContent = row.text;
            else keys.forEach(function (k, i) {
                if (i) who.appendChild(el('span', 'vo-life-bracket-vs', 'v'));
                var p = el('span', 'vo-life-player' + (row.winner && row.winner === k ? ' is-winner' : ''));
                var e = k ? emojiOf(k) : '';
                p.appendChild(el('span', 'vo-life-player-av', e || '?'));
                p.appendChild(el('span', 'vo-life-player-name', k ? nameOf(k) : '?'));
                who.appendChild(p);
            });
            li.appendChild(who);
            li.appendChild(el('span', 'vo-life-bracket-state', row.state || ''));
            list.appendChild(li);
        });
        body.appendChild(list);
        if (cheerOpen()) body.appendChild(el('p', 'vo-life-bracket-tip', life.t('cheerTip')));
    }
    function refreshWindow() { if (win && win.isConnected) fillWindow(); }
    function closeWindow() {
        if (!win) return;
        var w = win;
        win = null;
        if (root.VOUI && root.VOUI.closeWindow) root.VOUI.closeWindow(w);
        w.remove();
    }
    function openWindow() {
        if (typeof document === 'undefined' || !(T || champ)) return;
        if (win && win.isConnected) { fillWindow(); return; }
        win = el('div', 'vo-dialog vo-window vo-window--sm');
        win.setAttribute('data-vo-life', 'tournament');
        win.setAttribute('role', 'dialog');
        win.setAttribute('aria-modal', 'true');
        var head = el('div', 'vo-window-head');
        var titles = el('div', 'vo-window-titles');
        var h2 = el('h2', 'vo-window-title', life.t('tournamentTitle') + (T ? ' · ' + life.t(T.game === 'darts' ? 'tourDarts' : 'tourPong') : ''));
        h2.id = 'voLifeBracketTitle';
        win.setAttribute('aria-labelledby', h2.id);
        titles.appendChild(h2);
        head.appendChild(titles);
        var close = el('button', 'vo-btn vo-btn--icon vo-btn--ghost');
        if (root.VOUI && root.VOUI.icon) close.appendChild(root.VOUI.icon('close')); else close.textContent = '×';
        close.type = 'button';
        close.setAttribute('aria-label', 'Close');
        close.setAttribute('data-vo-close', '');
        close.addEventListener('click', closeWindow);
        head.appendChild(close);
        win.appendChild(head);
        win.appendChild(el('div', 'vo-window-body'));
        fillWindow();
        document.body.appendChild(win);
        if (root.VOUI && root.VOUI.openWindow) root.VOUI.openWindow(win, { onClose: function () { if (win) { var w = win; win = null; w.remove(); } } });
    }

    life.feature('tournament', {
        setting: 'tournaments',
        order: 55,
        onState: fromState,
        onEvent: function (ev) {
            var type = ev.type;
            if (type === 'tournament.start') {
                if (T && T.id === ev.id) return;
                if (T && T.status === 'live') closeTour();
                startTour(ev);
                if (!ev._stale) T.players.forEach(function (k) { enlist(k); });
                refreshWindow();
            } else if (type === 'tournament.match') onMatch(ev);
            else if (type === 'tournament.cheer') onCheer(ev);
            else if (type === 'tournament.end') endTour(ev);
        },
        onSettings: function () {
            if (life.isOn('tournaments')) return;
            // Switched off: the board sheet, pill, hearts and window go away.
            if (T) closeTour();
            T = null; champ = null; hearts = [];
            closeWindow();
            invalidate();
        },
        onDay: function () { if (T && T.status === 'live') return; T = null; champ = null; closeWindow(); invalidate(); },
        update: update,
        drawStatic: drawStatic,
        drawScreen: drawScreen,
        isBusy: function () { return hearts.length > 0; },
        click: function (x, y, touch) {
            var h = hit(x, y, touch);
            if (!h) return false;
            if (h.kind === 'player') cheer(h.key);
            else openWindow();
            return true;
        },
        hover: function (x, y) {
            var h = hit(x, y, false);
            var sig = h ? h.kind + ':' + (h.key || '') : '';
            var was = hoverAt ? hoverAt.kind + ':' + (hoverAt.key || '') : '';
            hoverAt = h;
            if (sig !== was) busy(200);
            return !!h;
        },
        onRoster: function () {
            // New Agent objects: scripts were ended; the bracket players come back.
            if (!T || T.status !== 'live') return;
            Object.keys(people).forEach(function (k) { people[k].ctl = null; });
            if (T.live && T.live.game === 'on') T.live.game = 'aborted';
            T.players.forEach(function (k) { enlist(k); });
        },
        onVisibility: function (visible) { if (visible && T && T.status === 'live') T.players.forEach(function (k) { enlist(k); }); },
        reset: function (reason) {
            if (reason === 'calm') { if (T && T.live) stopGame(T.live); if (D()) D().cancelFeature('tournament', 'calm'); people = {}; return; }
            if (T) closeTour();
            T = null; champ = null; hearts = [];
            closeWindow();
            invalidate();
        }
    });

    root.VOLifeTournament = {
        _debug: function () {
            return {
                id: T && T.id, game: T && T.game, status: T && T.status, champion: (T && T.champion) || (champ && champ.agent) || null,
                live: T && T.live ? { match: T.live.match, p1: T.live.p1, p2: T.live.p2, game: T.live.game } : null,
                results: T ? JSON.parse(JSON.stringify(T.results)) : {}, cheers: T ? Object.assign({}, T.cheers) : {},
                people: Object.keys(people).map(function (k) { var P = people[k]; return { key: k, role: P.role, held: !!P.ctl, arrived: P.arrived, gone: P.gone }; }),
                hearts: hearts.length, pill: rects.pill, card: !!rects.card, players: Object.keys(rects.players), board: boardText(), rows: bracketRows(),
                window: !!(win && win.isConnected)
            };
        },
        openWindow: openWindow
    };
})(typeof window !== 'undefined' ? window : this);
