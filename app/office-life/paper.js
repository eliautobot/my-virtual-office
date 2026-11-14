// Office life: End-of-day newspaper and replay (feature 10, design .work/life/design.md 3.10).
// The server prints "The Daily Office" (paper.ready); this module shows a rolled
// newspaper on the front desk, one toast per browser per day, the newspaper
// window (front page, archive of past days, preview of today) and the replay:
// a DOM bar with a time slider that puts every agent where the journal says it
// was. Replay holds agents through the director (priority 200, never moving a
// script of real work) and never writes anything. Every field is set with
// textContent (no HTML from data). Zero inference.
(function (root) {
    'use strict';
    var life = root.VOLife;
    if (!life || typeof life.feature !== 'function') return;

    life.addText({
        paperRead: 'Read the Daily Office', paperEdition: 'Edition', paperToday: 'Today', paperPreviewNote: 'Today so far, not printed yet',
        paperPrinted: 'Printed {time} office time', paperPreviewAt: 'Preview at {time} office time', paperLoading: 'Printing…',
        paperNone: 'No newspaper was made that day.', paperNothing: 'Nothing to print yet today.', paperError: 'The newspaper could not be loaded.',
        paperOff: 'The Daily Office is turned off in Settings, Office life.',
        paperMvp: 'MVP of the day', paperNoMvp: 'No MVP today: nobody finished anything yet.', paperAround: 'Around the office',
        paperNumbers: 'By the numbers', paperStandup: '{title} at {time} with {n} {agents}', paperChampion: '{game} champion: {name}',
        paperCalledOff: 'The {game} tournament was called off', paperVol: 'Vol. {year} · No. {n}',
        statTasks: '{n} {w}', statRuns: '{n} {w}', statVisitors: '{n} {w}', statHandoffs: '{n} {w}',
        replayPlay: 'Play', replayPause: 'Pause', replayExit: 'Exit replay', replaySpeed: 'Replay speed', replaySlider: 'Replay time',
        replayLoading: 'Loading the day…', replayEmpty: 'Nothing was recorded that day.', replayError: 'The day could not be loaded.',
        replayTask: 'Task done', replayStandup: 'Stand-up', replayChampion: 'Champion: {name}', replayNeed: 'Needs you'
    });

    var KINDS = ['state', 'needs.open', 'needs.close', 'handoff', 'visitor', 'cron.fire', 'task.done', 'project.done', 'xp',
        'standup.start', 'standup.end', 'tournament.start', 'tournament.match', 'tournament.end'];
    var PAGE_MAX = 10;              // 10 x 2000 journal rows at most per replayed day
    var LONG_IDLE_MS = 15 * 60000;
    var POP_MS = 2600, POP_MAX = 8;
    var GAME = { pong: 'Ping pong', darts: 'Darts' };
    var CHANNELS = { sms: 'SMS', email: 'Email', webhook: 'Webhook', telegram: 'Telegram', discord: 'Discord', slack: 'Slack',
        whatsapp: 'WhatsApp', signal: 'Signal', matrix: 'Matrix', imessage: 'iMessage', teams: 'Teams', web: 'Web' };
    var TOAST_KEY = 'vo-life-paper-toast';

    var S = { ready: false, day: '', propAt: null, win: null, view: null, req: 0, days: [] };
    var R = null; // replay state while on

    function H() { return life.host(); }
    function SP() { return life.sprites(); }
    function t(k, v) { return life.t(k, v); }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function hhmm(ms) { var p = life.officeParts(ms); return pad(p.hour) + ':' + pad(p.minute); }
    function toMs(v) { v = Number(v); if (!v) return 0; return v < 1e12 ? v * 1000 : v; }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = String(text);
        return e;
    }
    function getJSON(url) {
        return fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) { var e = new Error((data && data.message) || ('HTTP ' + res.status)); e.status = res.status; throw e; }
                return data;
            });
        });
    }
    function toast(msg, kind) {
        if (root.VOUI && typeof root.VOUI.toast === 'function') root.VOUI.toast(msg, { kind: kind || 'info' });
    }
    function validDay(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); }
    function dayDate(day) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; }
    function dayLabel(day, long) {
        var d = dayDate(day);
        if (!d) return String(day || '');
        try {
            return new Intl.DateTimeFormat(undefined, long ? { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
                : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
        } catch (e) { return day; }
    }
    // Office-day bounds in epoch ms (office time zone, DST-safe for whole days).
    function offsetAt(ms) { var p = life.officeParts(ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000; }
    function dayStart(day) {
        var d = dayDate(day);
        if (!d) return 0;
        var g = d.getTime();
        return g - offsetAt(g - offsetAt(g));
    }
    function nextDay(day) { var d = dayDate(day); return d ? new Date(d.getTime() + 86400000).toISOString().slice(0, 10) : ''; }
    function nameOf(key, fallback) {
        var a = H() && H().agent(key);
        return life.clip((a && a.name) || fallback || key || '', 24);
    }
    // The agent's pixel sprite (N8: no emoji avatars): the Agent Studio draws every
    // canvas[data-studio-sprite] (it loads on demand; its loader draws the ones on the page).
    function spriteOf(key) {
        var a = H() && H().agent(key);
        if (!a) return null;
        var cv = el('canvas', 'vo-paper-sprite');
        cv.setAttribute('aria-hidden', 'true');
        cv.dataset.studioSprite = String(key);
        cv.dataset.studioView = 'card';
        cv.dataset.studioSize = '24';
        cv.dataset.studioFloor = '0';
        return cv;
    }
    function drawSprites(sheet) {
        if (!sheet.querySelector('canvas[data-studio-sprite]')) return;
        if (root.VOStudio && typeof root.VOStudio.drawSprites === 'function') root.VOStudio.drawSprites(sheet);
        else if (typeof root._voLazyLoad === 'function') root._voLazyLoad('studio');
    }

    // =====================================================================
    // Newspaper window
    // =====================================================================
    function buildWindow() {
        if (S.win && S.win.isConnected) return S.win;
        var w = el('section', 'vo-window vo-paper');
        w.setAttribute('role', 'dialog');
        w.setAttribute('aria-modal', 'true');
        w.setAttribute('aria-label', t('paperTitle'));
        w.setAttribute('data-vo-life', 'paper');
        w.hidden = true;
        var head = el('div', 'vo-window-head vo-paper-head');
        var pick = el('label', 'vo-paper-pick');
        pick.appendChild(el('span', 'vo-paper-pick-label', t('paperEdition')));
        var sel = el('select', 'vo-input vo-paper-day');
        pick.appendChild(sel);
        head.appendChild(pick);
        var close = el('button', 'vo-btn vo-btn--icon vo-btn--ghost vo-paper-close');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close');
        close.setAttribute('data-vo-close', '');
        if (root.VOUI && root.VOUI.icon) close.appendChild(root.VOUI.icon('close'));
        else close.textContent = '×';
        head.appendChild(close);
        w.appendChild(head);
        var body = el('div', 'vo-window-body vo-paper-body');
        var sheet = el('article', 'vo-paper-sheet');
        sheet.setAttribute('aria-live', 'polite');
        sheet.setAttribute('aria-busy', 'false');
        body.appendChild(sheet);
        w.appendChild(body);
        var foot = el('div', 'vo-window-foot vo-paper-foot');
        var rep = el('button', 'vo-btn vo-btn--primary vo-paper-replay', t('replayDay'));
        rep.type = 'button';
        foot.appendChild(rep);
        w.appendChild(foot);
        close.addEventListener('click', closeWindow);
        sel.addEventListener('change', function () { showDay(sel.value); });
        rep.addEventListener('click', function () { var d = S.view && S.view.day; closeWindow(); startReplay(d); });
        w.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !(root.VOUI && root.VOUI.openWindow)) { e.preventDefault(); closeWindow(); }
        });
        document.body.appendChild(w);
        S.win = w;
        return w;
    }
    function isOpen() { return !!(S.win && !S.win.hidden); }
    function openWindow(day) {
        if (life.status() !== 'ready' || !life.isOn('newspaper')) { toast(t('paperOff'), 'info'); return false; }
        var w = buildWindow();
        if (root.VOUI && typeof root.VOUI.openWindow === 'function') {
            root.VOUI.openWindow(w, { onClose: closeWindow, initialFocus: '.vo-paper-day' });
        } else {
            w.hidden = false;
            var f = w.querySelector('.vo-paper-day');
            if (f) f.focus();
        }
        document.documentElement.classList.add('vo-paper-open');
        var target = validDay(day) ? day : (life.day() || '');
        loadDays(target);
        showDay(target);
        return true;
    }
    function closeWindow() {
        if (!S.win || S.win.hidden) return;
        S.req++;
        if (root.VOUI && typeof root.VOUI.closeWindow === 'function') root.VOUI.closeWindow(S.win);
        S.win.hidden = true;
        document.documentElement.classList.remove('vo-paper-open');
    }
    function loadDays(selected) {
        getJSON('/api/office-life/days').then(function (d) {
            var today = (d && d.today) || life.day();
            var days = ((d && d.days) || []).filter(function (r) { return r && validDay(r.day) && (r.paper || r.day === today); });
            if (!days.some(function (r) { return r.day === today; }) && validDay(today)) days.unshift({ day: today, paper: S.ready });
            S.days = days;
            fillPicker(selected, today);
        }).catch(function () { S.days = [{ day: life.day(), paper: S.ready }]; fillPicker(selected, life.day()); });
    }
    function fillPicker(selected, today) {
        var sel = S.win && S.win.querySelector('.vo-paper-day');
        if (!sel) return;
        var cur = (S.view && S.view.day) || selected;
        sel.textContent = '';
        S.days.forEach(function (r) {
            var label = r.day === today ? t('paperToday') + ' · ' + dayLabel(r.day) + (r.paper ? '' : ' · ' + t('previewSoFar')) : dayLabel(r.day);
            var o = el('option', '', label);
            o.value = r.day;
            if (r.day === cur) o.selected = true;
            sel.appendChild(o);
        });
        if (cur && !S.days.some(function (r) { return r.day === cur; })) {
            var extra = el('option', '', dayLabel(cur));
            extra.value = cur; extra.selected = true;
            sel.appendChild(extra);
        }
    }
    function showDay(day) {
        if (!S.win) return;
        var sheet = S.win.querySelector('.vo-paper-sheet');
        var my = ++S.req;
        var today = life.day();
        var preview = day === today && !S.ready;
        sheet.setAttribute('aria-busy', 'true');
        sheet.textContent = '';
        sheet.appendChild(el('p', 'vo-paper-msg', t('paperLoading')));
        S.view = { day: day, paper: null };
        var url = '/api/office-life/paper?day=' + encodeURIComponent(day) + (preview ? '&preview=1' : '');
        getJSON(url).then(function (d) {
            if (my !== S.req) return;
            S.view = { day: day, paper: d.paper, preview: !!d.preview };
            render(sheet, d.paper || {}, !!d.preview);
            drawSprites(sheet);
        }).catch(function (e) {
            if (my !== S.req) return;
            sheet.textContent = '';
            var msg = e && e.status === 404 ? (preview ? t('paperNothing') : t('paperNone')) : t('paperError');
            sheet.appendChild(el('p', 'vo-paper-msg', msg));
        }).then(function () { if (my === S.req) sheet.setAttribute('aria-busy', 'false'); });
        var rep = S.win.querySelector('.vo-paper-replay');
        if (rep) rep.disabled = !validDay(day);
    }
    function dayOfYear(day) { var d = dayDate(day); return d ? Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1 : 0; }
    function statLine(st) {
        var bits = [];
        if (!st || typeof st !== 'object') return '';
        if (+st.tasks > 0) bits.push(t('statTasks', { n: +st.tasks, w: life.plural(+st.tasks, 'task') }));
        if (+st.runs > 0) bits.push(t('statRuns', { n: +st.runs, w: life.plural(+st.runs, 'run') }));
        if (+st.visitors > 0) bits.push(t('statVisitors', { n: +st.visitors, w: life.plural(+st.visitors, 'message') }));
        if (+st.handoffs > 0) bits.push(t('statHandoffs', { n: +st.handoffs, w: life.plural(+st.handoffs, 'handoff') }));
        return bits.join(' · ');
    }
    function str(v, n) { return life.clip(v == null ? '' : String(v), n || 160); }
    // The front page. Every value goes through textContent.
    function render(sheet, p, preview) {
        sheet.textContent = '';
        var day = validDay(p.day) ? p.day : (S.view && S.view.day) || '';
        var mast = el('header', 'vo-paper-mast');
        var ear = el('div', 'vo-paper-ears');
        var y = dayDate(day);
        ear.appendChild(el('span', '', y ? t('paperVol', { year: y.getUTCFullYear(), n: dayOfYear(day) }) : ''));
        ear.appendChild(el('span', '', preview ? t('previewSoFar') : ''));
        mast.appendChild(ear);
        var h = el('h2', 'vo-paper-title', str(p.masthead || t('paperTitle'), 40));
        h.id = 'voPaperMast';
        h.setAttribute('tabindex', '-1');
        mast.appendChild(h);
        var dl = el('div', 'vo-paper-dateline');
        dl.appendChild(el('span', '', dayLabel(day, true)));
        var gen = toMs(p.generatedAt);
        if (gen) dl.appendChild(el('span', '', preview ? t('paperPreviewAt', { time: hhmm(gen) }) : t('paperPrinted', { time: hhmm(gen) })));
        if (p.tz) dl.appendChild(el('span', 'vo-paper-tz', str(p.tz, 40)));
        mast.appendChild(dl);
        sheet.appendChild(mast);
        if (preview) sheet.appendChild(el('p', 'vo-paper-note', t('paperPreviewNote')));

        var lead = el('section', 'vo-paper-lead');
        lead.appendChild(el('h3', 'vo-paper-headline', str(p.headline, 120)));
        if (p.subhead) lead.appendChild(el('p', 'vo-paper-subhead', str(p.subhead, 200)));
        var notes = [];
        if (p.standup && typeof p.standup === 'object' && p.standup.at) {
            var n = Math.max(0, Number(p.standup.participants) || 0);
            var sat = toMs(p.standup.at);
            notes.push(t('paperStandup', { title: life.standupTitle ? life.standupTitle(sat) : life.t('standupTitle'), time: hhmm(sat), n: n, agents: life.plural(n, 'agent') }));
        }
        if (p.tournament && typeof p.tournament === 'object') {
            var g = GAME[p.tournament.game] || 'Break-time';
            if (p.tournament.status === 'called_off') notes.push(t('paperCalledOff', { game: g.toLowerCase() }));
            else if (p.tournament.champion) notes.push(t('paperChampion', { game: g, name: nameOf(p.tournament.champion, p.tournament.championName) }));
        }
        if (notes.length) {
            var ul = el('ul', 'vo-paper-notes');
            notes.forEach(function (s) { ul.appendChild(el('li', '', s)); });
            lead.appendChild(ul);
        }
        sheet.appendChild(lead);

        var grid = el('div', 'vo-paper-grid');
        var mvpBox = el('aside', 'vo-paper-mvp');
        mvpBox.setAttribute('aria-label', t('paperMvp'));
        mvpBox.appendChild(el('h4', 'vo-paper-kicker', t('paperMvp')));
        if (p.mvp && typeof p.mvp === 'object' && p.mvp.agent) {
            var who = el('p', 'vo-paper-mvp-name');
            var em = spriteOf(p.mvp.agent);
            if (em) who.appendChild(em);
            who.appendChild(el('span', '', nameOf(p.mvp.agent, p.mvp.name)));
            mvpBox.appendChild(who);
            if (p.mvp.reason) mvpBox.appendChild(el('p', 'vo-paper-mvp-why', str(p.mvp.reason, 160)));
        } else {
            mvpBox.appendChild(el('p', 'vo-paper-mvp-why', t('paperNoMvp')));
        }
        grid.appendChild(mvpBox);
        var stats = Array.isArray(p.stats) ? p.stats.slice(0, 12) : [];
        if (stats.length) {
            var box = el('aside', 'vo-paper-stats');
            box.appendChild(el('h4', 'vo-paper-kicker', t('paperNumbers')));
            var dl2 = el('dl', '');
            stats.forEach(function (s) {
                if (!s || typeof s !== 'object') return;
                dl2.appendChild(el('dt', '', str(s.label, 40)));
                dl2.appendChild(el('dd', '', str(s.value, 60)));
            });
            box.appendChild(dl2);
            grid.appendChild(box);
        }
        sheet.appendChild(grid);

        var cols = Array.isArray(p.columns) ? p.columns.slice(0, 24) : [];
        if (cols.length) {
            var sec = el('section', 'vo-paper-around');
            sec.appendChild(el('h4', 'vo-paper-kicker', t('paperAround')));
            var list = el('div', 'vo-paper-cols');
            cols.forEach(function (c) {
                if (!c || typeof c !== 'object') return;
                var col = el('article', 'vo-paper-col');
                var hd = el('h5', 'vo-paper-col-name');
                var e2 = spriteOf(c.agent);
                if (e2) hd.appendChild(e2);
                hd.appendChild(el('span', '', nameOf(c.agent, c.name)));
                col.appendChild(hd);
                col.appendChild(el('p', 'vo-paper-col-line', str(c.line, 200)));
                var sl = statLine(c.stats);
                if (sl) col.appendChild(el('p', 'vo-paper-col-stats', sl));
                list.appendChild(col);
            });
            sec.appendChild(list);
            sheet.appendChild(sec);
        }
    }

    // =====================================================================
    // Front-desk newspaper prop + toast
    // =====================================================================
    function propSpot() {
        var h = H();
        var f = h && h.spots && h.spots().front;
        if (!f) return null;
        if (f.item) return { x: f.item.x - 30, y: f.item.y - 9 };
        return { x: f.x + 30, y: f.y - 6 };
    }
    // The office's phone layout (its one-window width): the toast band sits over the lower office there, so the paper
    // on the front desk is the only sign (the toast waits for a wider screen).
    function phoneLayout() {
        try { return !!(root.matchMedia && root.matchMedia('(max-width: 900px)').matches); } catch (e) { return false; }
    }
    // "The Daily Office is out": once per edition (its day), only for a paper with news (the server says so: an agent
    // who did anything that day, an MVP, a stand-up, a tournament or an office stat; never the quiet paper of an office
    // with no agents or a day nobody worked), and never over a phone's office.
    function maybeToast(day, news) {
        if (!news || !validDay(day) || phoneLayout()) return;
        try { if ((root.localStorage.getItem(TOAST_KEY) || '') === day) return; root.localStorage.setItem(TOAST_KEY, day); } catch (e) {}
        toast(t('paperOut'), 'info');
    }
    function setReady(on, day) {
        var was = S.ready;
        S.ready = !!on;
        S.day = day || life.day();
        if (was !== S.ready) { S.propAt = null; var h = H(); if (h && h.invalidateStatic) h.invalidateStatic(); }
    }
    function propCanvasRect() {
        var h = H(), p = S.ready && (S.propAt || propSpot());
        if (!h || !p) return null;
        var c = h.worldToCanvas(p.x, p.y), sc = h.scale ? h.scale() : 1;
        var w = Math.max(10, 14 * sc), hh = Math.max(8, 10 * sc);
        return { x: c.x - w / 2, y: c.y - hh / 2, w: w, h: hh };
    }

    // =====================================================================
    // Replay
    // =====================================================================
    function bar() {
        if (R && R.bar && R.bar.isConnected) return R.bar;
        var layer = life.layer();
        if (!layer) return null;
        var b = el('div', 'vo-life-replay');
        b.setAttribute('role', 'region');
        b.setAttribute('aria-label', t('replayDay'));
        b.setAttribute('data-vo-canvas-obstacle', '');
        var play = el('button', 'vo-life-rbtn vo-life-rplay');
        play.type = 'button';
        play.setAttribute('aria-label', t('replayPlay'));
        var glyph = el('span', 'vo-life-rglyph');
        glyph.innerHTML = root.VOIcon ? root.VOIcon.html('play') : '▶';
        play.appendChild(glyph);
        var slider = el('input', 'vo-life-rslider');
        slider.type = 'range'; slider.min = '0'; slider.max = '1439'; slider.step = '1'; slider.value = '0';
        slider.setAttribute('aria-label', t('replaySlider'));
        var time = el('output', 'vo-life-rtime', '00:00');
        var speed = el('div', 'vo-life-rspeed');
        speed.setAttribute('role', 'group');
        speed.setAttribute('aria-label', t('replaySpeed'));
        [60, 300].forEach(function (x) {
            var s = el('button', 'vo-life-rbtn vo-life-rsp', x + '×');
            s.type = 'button';
            s.setAttribute('data-speed', String(x));
            s.setAttribute('aria-pressed', x === 60 ? 'true' : 'false');
            speed.appendChild(s);
        });
        var exit = el('button', 'vo-life-rbtn vo-life-rexit');
        exit.type = 'button';
        exit.setAttribute('aria-label', t('replayExit'));
        exit.appendChild(el('span', 'vo-life-rglyph', '✕'));
        exit.appendChild(el('span', 'vo-life-rexit-text', t('replayExit')));
        var status = el('span', 'vo-life-rstatus');
        status.setAttribute('role', 'status');
        b.appendChild(play); b.appendChild(slider); b.appendChild(time); b.appendChild(speed); b.appendChild(exit); b.appendChild(status);
        var clock = el('div', 'vo-life-rclock');
        clock.setAttribute('aria-hidden', 'true');
        play.addEventListener('click', function () { setPlaying(!(R && R.playing)); });
        slider.addEventListener('input', function () { if (R) { R.playing = false; syncPlay(); seek(R.start + Number(slider.value) * 60000, false); } });
        speed.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest('[data-speed]') : null;
            if (!btn || !R) return;
            R.speed = Number(btn.getAttribute('data-speed')) || 60;
            Array.prototype.forEach.call(speed.querySelectorAll('[data-speed]'), function (x) { x.setAttribute('aria-pressed', x === btn ? 'true' : 'false'); });
        });
        exit.addEventListener('click', function () { stopReplay('exit'); });
        b.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.preventDefault(); stopReplay('exit'); }
            else if ((e.key === ' ' || e.key === 'k') && e.target === slider) { e.preventDefault(); setPlaying(!(R && R.playing)); }
        });
        layer.appendChild(clock);
        layer.appendChild(b);
        if (R) { R.bar = b; R.clock = clock; }
        return b;
    }
    function q(sel) { return R && R.bar ? R.bar.querySelector(sel) : null; }
    function syncPlay() {
        var p = q('.vo-life-rplay');
        if (!p) return;
        p.setAttribute('aria-label', R.playing ? t('replayPause') : t('replayPlay'));
        p.setAttribute('aria-pressed', R.playing ? 'true' : 'false');
        p.firstChild.innerHTML = root.VOIcon ? root.VOIcon.html(R.playing ? 'pause' : 'play') : (R.playing ? '❚❚' : '▶');
    }
    function setPlaying(on) {
        if (!R || !R.loaded) return;
        if (on && R.t >= R.end) seek(R.start, false);
        R.playing = !!on;
        R.lastTick = 0;
        syncPlay();
        var h = H();
        if (h && h.markDirty) h.markDirty();
    }
    function setStatus(text) { var s = q('.vo-life-rstatus'); if (s) s.textContent = text || ''; }

    // Journal rows -> per-agent timelines (state changes, needs).
    function index(rows) {
        var st = {}, needs = {}, events = [];
        rows.forEach(function (r) {
            if (!r || !r.type) return;
            var at = toMs(r.at), key = r.agent ? String(r.agent) : '';
            if (!at) return;
            if (r.type === 'state' && key && r.to) (st[key] || (st[key] = [])).push({ at: at, to: String(r.to) });
            else if (r.type === 'needs.open' && key) {
                (needs[key] || (needs[key] = [])).push({ open: at, close: 0, need: String(r.need || 'input'), ref: String(r.ref || r.need || '') });
            } else if (r.type === 'needs.close' && key) {
                var list = needs[key] || [], ref = String(r.ref || '');
                for (var i = 0; i < list.length; i++) {
                    var n = list[i];
                    if (!n.close && n.open <= at && (n.ref === ref || (!ref) || n.need === ref)) { n.close = at; break; }
                }
            } else if (r.type !== 'state') events.push(Object.assign({}, r, { _at: at }));
        });
        Object.keys(st).forEach(function (k) { st[k].sort(function (a, b) { return a.at - b.at; }); });
        events.sort(function (a, b) { return a._at - b._at; });
        return { states: st, needs: needs, events: events };
    }
    // What one agent was doing at time `at`.
    function stateAt(key, at) {
        var list = R.idx.states[key];
        var out = { state: '', since: 0, need: '' };
        if (list) {
            var lo = 0, hi = list.length - 1, best = -1;
            while (lo <= hi) { var mid = (lo + hi) >> 1; if (list[mid].at <= at) { best = mid; lo = mid + 1; } else hi = mid - 1; }
            if (best >= 0) {
                out.state = list[best].to;
                var s = best;
                while (s > 0 && list[s - 1].to === out.state) s--;
                out.since = list[s].at;
            }
        }
        (R.idx.needs[key] || []).forEach(function (n) {
            if (n.open <= at && (!n.close || n.close > at)) out.need = out.need === 'approval' ? out.need : n.need;
        });
        return out;
    }
    function targetFor(a, key, s, order) {
        var h = H(), sp = R.spots;
        if (s.need) {
            var slot = (R.front || [])[order.front++];
            if (slot) return { x: slot.x, y: slot.y, sit: false, pose: 'sign', glyph: s.need === 'approval' ? '!' : '?', id: 'need' + order.front };
        }
        if (s.state === 'meeting' && sp.meetingSlots && sp.meetingSlots[order.meeting]) {
            var m = sp.meetingSlots[order.meeting++];
            return { x: m.x, y: m.y, sit: true, id: 'meet' + order.meeting };
        }
        if (s.state === 'idle' && s.since && R.t - s.since > LONG_IDLE_MS && sp.loungeSeats && sp.loungeSeats[order.lounge]) {
            var l = sp.loungeSeats[order.lounge++];
            return { x: l.x, y: l.y, sit: true, id: 'lounge' + order.lounge };
        }
        var d = R.saved[key] && R.saved[key].desk;
        if (d) return { x: d.x, y: d.y, sit: true, id: 'desk', dim: !s.state ? 0.4 : s.state === 'offline' ? 0.6 : null, zzz: s.state === 'offline' };
        return { x: R.saved[key].x, y: R.saved[key].y, sit: R.saved[key].sit, id: 'here', dim: !s.state ? 0.4 : s.state === 'offline' ? 0.6 : null, zzz: s.state === 'offline' };
    }
    function apply() {
        if (!R || !R.loaded) return;
        var h = H(), order = { front: 0, meeting: 0, lounge: 0 };
        R.keys.forEach(function (key) {
            var d = life.director(), a = h.agent(key);
            if (!a || !d || !d.current(key) || d.current(key).kind !== 'replay') return;
            var s = stateAt(key, R.t);
            var tg = targetFor(a, key, s, order);
            var sig = tg.id + '|' + tg.x + ',' + tg.y + '|' + (tg.pose || '') + (tg.glyph || '') + '|' + (tg.dim || '') + '|' + (tg.zzz ? 1 : 0);
            R.shown[key] = { state: s.state || 'unknown', need: s.need, zzz: !!tg.zzz };
            if (R.placed[key] === sig) return;
            R.placed[key] = sig;
            h.place(key, tg.x, tg.y, { sit: tg.sit });
            h.pose(key, tg.pose || null, tg.pose ? { glyph: tg.glyph, still: true } : null);
            a._lifeAlpha = tg.dim != null ? tg.dim : R.saved[key].alpha;
        });
        var label = t('replaying', { time: hhmm(R.t) });
        if (R.clock) R.clock.textContent = label;
        var out = q('.vo-life-rtime');
        if (out) out.textContent = hhmm(R.t);
        var sl = q('.vo-life-rslider');
        if (sl && document.activeElement !== sl) sl.value = String(Math.round((R.t - R.start) / 60000));
        if (sl) { sl.setAttribute('aria-valuetext', label); var mx = String(Math.max(1, Math.round((R.end - R.start) / 60000))); if (sl.max !== mx) sl.max = mx; }
        if (h.markDirty) h.markDirty();
    }
    function seek(at, playing) {
        if (!R) return;
        var prev = R.t;
        R.t = Math.max(R.start, Math.min(R.end, at));
        if (playing) firePops(prev, R.t);
        else { R.pops = []; R.evIdx = firstEventAfter(R.t); }
        apply();
    }
    function firstEventAfter(at) {
        var ev = R.idx.events, lo = 0, hi = ev.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (ev[mid]._at <= at) lo = mid + 1; else hi = mid; }
        return lo;
    }
    function chan(c) {
        c = String(c || '').toLowerCase();
        return CHANNELS[c] || (c ? c.charAt(0).toUpperCase() + c.slice(1, 24) : '');
    }
    function popFor(ev) {
        switch (ev.type) {
            case 'handoff': return ev.to ? { text: t('handoffTo', { name: nameOf(ev.to) }), icon: 'folder', kind: 'info', plane: ev.to } : null;
            case 'visitor': return { text: t('messageFrom', { channel: chan(ev.channel) || '?' }), icon: 'envelope', kind: 'info' };
            case 'cron.fire': return { text: ev.name ? t('scheduledJob', { label: life.clip(ev.name, 28) }) : t('scheduledJobPlain'), icon: 'alarmClock', kind: 'neutral' };
            case 'task.done': return { text: ev.title ? life.clip(ev.title, 32) : t('replayTask'), icon: 'clipboard', kind: 'success' };
            case 'project.done': return { text: t('projectDone'), icon: 'trophy', kind: 'success', office: !ev.agent };
            case 'xp': return Number(ev.points) > 0 ? { text: t('xp', { n: Number(ev.points) }), icon: 'star', kind: 'success' } : null;
            case 'standup.start': return ev.status === 'skipped' ? null : { text: t('replayStandup'), icon: 'clipboard', kind: 'neutral', office: true };
            case 'tournament.end': return ev.champion ? { text: t('replayChampion', { name: nameOf(ev.champion) }), icon: 'trophy', kind: 'success', agent: ev.champion } : null;
            default: return null;
        }
    }
    function firePops(from, to) {
        var ev = R.idx.events;
        var i = R.evIdx;
        while (i < ev.length && ev[i]._at <= to) {
            if (ev[i]._at > from) {
                var p = popFor(ev[i]);
                var key = (p && p.agent) || ev[i].agent;
                if (p && (key || p.office)) {
                    R.pops.push({ key: key || '', text: p.text, icon: p.icon, kind: p.kind, born: Date.now() });
                    if (R.pops.length > POP_MAX) R.pops.shift();
                    if (p.plane && key && !life.atDesk() && R.speed <= 60) { var h = H(); if (h.plane) h.plane(key, p.plane, 'folder'); }
                }
            }
            i++;
        }
        R.evIdx = i;
    }
    function loadRows(day) {
        var rows = [], pages = 0;
        function page(after) {
            var url = '/api/office-life/journal?day=' + encodeURIComponent(day) + '&kinds=' + encodeURIComponent(KINDS.join(',')) + '&limit=2000' + (after ? '&after=' + after : '');
            return getJSON(url).then(function (d) {
                (d.rows || []).forEach(function (r) { rows.push(r); });
                pages++;
                if (d.next && pages < PAGE_MAX && (d.rows || []).length) return page(d.next);
                return rows;
            });
        }
        return page(0);
    }
    function startReplay(day) {
        var h = H(), d = life.director();
        if (!h || !d || life.status() !== 'ready' || !life.isOn('newspaper')) { toast(t('paperOff'), 'info'); return false; }
        day = validDay(day) ? day : life.day();
        if (R) stopReplay('restart');
        var today = life.day();
        var start = dayStart(day);
        var end = day === today ? Math.max(start + 60000, life.serverNow()) : dayStart(nextDay(day));
        R = { day: day, start: start, end: end, t: start, speed: 60, playing: false, loaded: false, keys: [], saved: {}, placed: {}, shown: {},
            pops: [], evIdx: 0, idx: { states: {}, needs: {}, events: [] }, spots: {}, front: [], lastTick: 0, bar: null, clock: null, token: {} };
        var my = R.token;
        document.documentElement.classList.add('vo-life-replaying');
        bar();
        var sl = q('.vo-life-rslider');
        if (sl) { sl.max = String(Math.max(1, Math.round((end - start) / 60000))); sl.value = '0'; sl.disabled = true; }
        q('.vo-life-rplay').disabled = true;
        setStatus(t('replayLoading'));
        if (R.clock) R.clock.textContent = t('replaying', { time: hhmm(start) });
        var focusEl = q('.vo-life-rexit');
        if (focusEl) { try { focusEl.focus({ preventScroll: true }); } catch (e) {} }
        loadRows(day).then(function (rows) {
            if (!R || R.token !== my) return;
            R.idx = index(rows);
            enter();
            R.loaded = true;
            if (sl) sl.disabled = false;
            q('.vo-life-rplay').disabled = false;
            var any = Object.keys(R.idx.states).length || R.idx.events.length;
            setStatus(any ? '' : t('replayEmpty'));
            // Start at the first recorded moment of the day.
            var first = R.end;
            Object.keys(R.idx.states).forEach(function (k) { if (R.idx.states[k][0].at < first) first = R.idx.states[k][0].at; });
            seek(first < R.end ? first : R.start, false);
        }).catch(function () {
            if (!R || R.token !== my) return;
            setStatus(t('replayError'));
        });
        return true;
    }
    // Hold every office agent with the replay script (priority 200; scripts of
    // real work that it pauses re-queue themselves and come back at the end).
    function enter() {
        var h = H(), d = life.director();
        R.spots = h.spots() || {};
        var agents = (h.agents() || []).filter(function (a) { return a && !a._lifeExtra; });
        R.front = R.spots.frontQueue ? R.spots.frontQueue(Math.min(6, agents.length)).filter(Boolean) : [];
        agents.forEach(function (a) {
            var key = a.statusKey || a.id;
            if (!key) return;
            R.saved[key] = { x: a.x, y: a.y, sit: !!a.isSitting, face: a.faceDir, alpha: a._lifeAlpha, desk: a.desk ? { x: a.desk.x, y: a.desk.y } : null,
                meeting: a.meetingId || null };
            var res = d.request(key, {
                kind: 'replay', feature: 'paper', priority: 200, moves: false, label: t('holdReplay'), maxMs: 24 * 3600 * 1000,
                end: function (ctl, reason) {
                    var x = h.agent(key);
                    if (x && R && R.saved[key]) x._lifeAlpha = R.saved[key].alpha;
                    if (R && reason !== 'replay-end' && reason !== 'restart') { delete R.placed[key]; R.keys = R.keys.filter(function (k) { return k !== key; }); }
                }
            });
            if (res === 'started') R.keys.push(key);
        });
    }
    function stopReplay(reason) {
        if (!R) return;
        var cur = R, h = H(), d = life.director();
        R = null;
        cur.token = null;
        cur.keys.forEach(function (key) {
            if (d && d.current(key) && d.current(key).kind === 'replay') d.cancel(key, reason === 'restart' ? 'restart' : 'replay-end', { feature: 'paper' });
            var a = h && h.agent(key), sv = cur.saved[key];
            if (!a || !sv) return;
            a._lifeAlpha = sv.alpha;
            // The meeting system owns a seated agent: put it back where it was.
            if (a.meetingId && a.meetingId === sv.meeting && h.place) { h.place(key, sv.x, sv.y, { sit: sv.sit }); if (sv.face != null) a.faceDir = sv.face; }
        });
        if (cur.bar) cur.bar.remove();
        if (cur.clock) cur.clock.remove();
        document.documentElement.classList.remove('vo-life-replaying');
        if (h && h.markDirty) h.markDirty();
    }
    function tick(now) {
        if (!R || !R.loaded) return;
        if (!R.playing) { R.lastTick = 0; return; }
        if (!R.lastTick) { R.lastTick = now; return; }
        var dt = Math.min(1000, Math.max(0, now - R.lastTick));
        R.lastTick = now;
        if (R.day === life.day()) R.end = Math.max(R.end, life.serverNow());
        var next = R.t + dt * R.speed;
        if (next >= R.end) { next = R.end; R.playing = false; syncPlay(); }
        if (Math.floor(next / 1000) !== Math.floor(R.t / 1000)) seek(next, true);
        else R.t = next;
    }
    function drawZzz(ctx) {
        if (!R) return;
        var h = H();
        Object.keys(R.shown).forEach(function (key) {
            if (!R.shown[key].zzz) return;
            var a = h.agent(key);
            if (!a) return;
            ctx.fillStyle = '#e3f2fd';
            var x = Math.round(a.x + 10), y = Math.round(a.y - 50);
            [[0, 0, 5], [2, 4, 3]].forEach(function (z) {
                var s = z[2], zx = x + z[0] * 3, zy = y - z[1] * 2;
                ctx.fillRect(zx, zy, s, 1); ctx.fillRect(zx, zy + s - 1, s, 1);
                for (var i = 1; i < s - 1; i++) ctx.fillRect(zx + s - 1 - i, zy + i, 1, 1);
            });
        });
    }
    function drawPops(ctx) {
        if (!R || !R.pops.length) return;
        var h = H(), sp = SP(), now = Date.now(), still = life.atDesk();
        R.pops = R.pops.filter(function (p) { return now - p.born < POP_MS; });
        var stack = {};
        R.pops.forEach(function (p) {
            var a = p.key && h.agent(p.key), c;
            if (a) c = h.worldToCanvas(a.x, a.y - 72);
            else { var v = h.view(); c = { x: v.w / 2, y: 64 }; }
            var age = (now - p.born) / POP_MS;
            var n = stack[p.key] = (stack[p.key] || 0) + 1;
            var lift = still ? 0 : Math.round(age * 14);
            var m = h.ctlMetrics ? h.ctlMetrics() : { h: 22 };
            sp.label(ctx, p.text, c.x, c.y - lift - (n - 1) * (m.h + 3), { kind: p.kind, icon: p.icon, alpha: age > 0.75 ? (1 - age) * 4 : 1, maxW: 200 });
        });
    }

    // =====================================================================
    // Feature
    // =====================================================================
    life.feature('paper', {
        setting: 'newspaper',
        order: 70,
        init: function () {
            document.addEventListener('click', function (e) {
                var b = e.target && e.target.closest ? e.target.closest('[data-vo-life-paper]') : null;
                if (!b) return;
                e.preventDefault();
                if (b.getAttribute('data-vo-life-paper') === 'replay') startReplay();
                else openWindow();
            });
            root.addEventListener('vo:life-open-paper', function (e) {
                var d = e && e.detail;
                if (d && d.replay) startReplay(d.day); else openWindow(d && d.day);
            });
        },
        onState: function (snap) {
            var p = snap && snap.paper;
            setReady(!!(p && p.ready && (!snap.day || p.day === snap.day)), snap && snap.day);
            if (S.ready && life.isOn('newspaper')) maybeToast(S.day, !!(p && p.news));
        },
        onEvent: function (ev) {
            if (ev.type !== 'paper.ready') return;
            var today = life.day();
            if (!ev.day || ev.day === today) {
                setReady(true, today);
                maybeToast(today, !!ev.news);
                if (isOpen() && S.view && S.view.day === today) { loadDays(today); showDay(today); }
            }
        },
        onDay: function () {
            setReady(false, life.day());
            if (isOpen()) loadDays(S.view && S.view.day);
        },
        onSettings: function () {
            if (!life.isOn('newspaper')) { stopReplay('off'); closeWindow(); }
        },
        onRoster: function () { if (R) stopReplay('roster'); },
        update: function (now) { tick(now || Date.now()); },
        drawStatic: function (ctx) {
            var sp = SP(), p = S.ready && propSpot();
            S.propAt = p || null; // clicks and hover use this (no layout walk per mouse move)
            if (sp && p) sp.draw(ctx, 'newspaper', p.x, p.y);
        },
        drawWorld: function (ctx) { if (R && R.loaded) drawZzz(ctx); },
        drawScreen: function (ctx) { if (R && R.loaded) drawPops(ctx); },
        click: function (x, y, touch) {
            var sp = SP(), r = propCanvasRect();
            if (!sp || !r || R) return false;
            if (sp.hitRect(r, x, y, touch)) { openWindow(); return true; }
            return false;
        },
        hover: function (x, y) {
            var sp = SP(), r = propCanvasRect();
            return !!(sp && r && !R && sp.hitRect(r, x, y, false));
        },
        isBusy: function () { return !!(R && (R.playing || R.pops.length)); },
        reset: function (reason) {
            if (reason === 'disabled' || reason === 'unavailable') { stopReplay(reason); closeWindow(); setReady(false); }
        },
        onVisibility: function (vis) { if (!vis && R) { R.playing = false; syncPlay(); } }
    });

    // Opened by the More menu item and the Settings buttons (any element with data-vo-life-paper works too).
    root.VOLifePaper = {
        open: openWindow,
        close: closeWindow,
        isOpen: isOpen,
        replay: startReplay,
        exitReplay: function () { stopReplay('exit'); },
        replaying: function () { return !!R; },
        _debug: function () {
            return { ready: S.ready, day: S.day, view: S.view && { day: S.view.day, preview: S.view.preview },
                replay: R && { day: R.day, t: R.t, start: R.start, end: R.end, playing: R.playing, speed: R.speed, loaded: R.loaded, keys: R.keys.slice(),
                    shown: JSON.parse(JSON.stringify(R.shown)), pops: R.pops.length } };
        },
        _seek: function (at) { seek(at, false); },
        _step: function (ms) { if (R) { var prev = R.t; R.t = Math.min(R.end, R.t + ms); firePops(prev, R.t); apply(); } }
    };
})(window);
