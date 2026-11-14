// Office life (v0.9): client bootstrap.
//
// Loads GET /api/office-life/state, then follows the server's one event
// stream (GET /api/office-life/stream, SSE read with fetch so a 429 or a 404
// can be told apart), hands each OfficeEvent to the feature modules and owns
// the director. Zero model inference: everything shown is built from events
// the server derived from real provider signals, with the labels in LIFE_TEXT.
//
// game.js calls (all guarded): onStatus, update, drawWorld, drawDesk, drawScreen,
// drawStatic, isBusy, click, hover, handoffsLive, claims, suppressApprovalChip,
// onRoster. Features register with VOLife.feature(name, def); see FEATURE_HOOKS.
(function (root) {
    'use strict';
    if (root.VOLife) return;
    var host = root.VOLifeHost || null;

    // ---- text: every client label in one table (ready for translation) ----
    var LIFE_TEXT = {
        needsOk: 'Needs your OK', needsQuestion: 'Has a question', needsYou: 'Needs you',
        needsEdgeOk: '{name} needs your OK', needsEdgeQuestion: '{name} has a question', needsEdgeInput: '{name} needs you',
        needsMore: '+{n} more', needsAnnounce: '{name} needs you',
        helperFor: 'Helper for {name}', internTag: 'INTERN', helpersMore: '+{n}', helpersOne: '1 helper', helpersMany: '{n} helpers', helpersShown: '{n} helpers · {shown} shown', handoffTo: 'Work for {name}',
        messageFrom: 'Message from {channel}', scheduledJob: 'Scheduled job: {label}', scheduledJobPlain: 'Scheduled job',
        xp: '+{n} XP', projectDone: 'Project done!', backOnTrack: 'Back on track', phew: 'phew',
        standupTitle: 'Morning stand-up', standupAfternoon: 'Afternoon stand-up', standupEvening: 'Evening stand-up',
        standupNight: 'Night stand-up', standupLate: 'Stand-up notes are in Meetings', remote: 'remote',
        tournamentTitle: 'Break-time tournament', cheerTip: 'Cheering is just for fun', walkover: 'won by walkover',
        champion: 'Champion', calledOff: 'Called off', final: 'Final', semi: 'Semi-final', bye: 'bye',
        paperTitle: 'The Daily Office', paperOut: 'The Daily Office is out', previewSoFar: 'Preview so far',
        replayDay: 'Replay the day', replaying: 'Replaying {time}',
        birthday: 'Happy {n}{suffix} office birthday, {name}!', fridayTreat: 'Friday treat',
        holdFront: 'waiting at the front desk', holdStandup: 'at the stand-up', holdHandoff: 'handing off work',
        holdTournament: 'in the tournament', holdHighfive: 'high-five', holdCake: 'getting cake', holdReplay: 'replay',
        holdDesk: 'at the desk'
    };
    function t(key, vars) {
        var s = Object.prototype.hasOwnProperty.call(LIFE_TEXT, key) ? LIFE_TEXT[key] : '';
        if (!vars) return s;
        return s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? '' : String(vars[k]); });
    }
    function clip(s, n) {
        s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        n = n || 32;
        return s.length > n ? s.slice(0, Math.max(1, n - 1)).trimEnd() + '…' : s;
    }
    /** A stand-up's name by the office-time hour it starts at (ms; the clock the paper and Meetings use): morning 5-11,
     *  afternoon 12-16, evening 17-21, night (a stand-up at 18:26 is not a "Morning stand-up"). */
    function standupTitle(ms) {
        ms = Number(ms) || Date.now();
        var h = api && api.officeParts ? Number(api.officeParts(ms).hour) : new Date(ms).getHours();
        if (h >= 5 && h < 12) return t('standupTitle');
        if (h < 5 || h >= 22) return t('standupNight');
        return t(h < 17 ? 'standupAfternoon' : 'standupEvening');
    }
    function plural(n, one, many) { return Number(n) === 1 ? one : (many || one + 's'); }
    function ordinal(n) {
        n = Math.abs(Math.floor(Number(n) || 0));
        var v = n % 100;
        if (v >= 11 && v <= 13) return 'th';
        return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
    }

    // ---- settings (mirror of office_life/settings.py defaults) ----
    var DEFAULTS = {
        enabled: true, calm: false, timeZone: '',
        features: { needsYou: true, interns: true, handoffs: true, visitors: true, alarmClock: true, moods: true,
            celebrations: true, standup: true, seasons: true, tournaments: true, newspaper: true, reactions: true },
        standup: { time: '09:30', days: [1, 2, 3, 4, 5] },
        newspaper: { time: '18:00' },
        seasons: { decor: true, fridayTreat: true, rain: true, birthdays: true,
            holidays: { newYear: true, valentines: true, earthDay: true, halloween: true, yearEndLights: true }, custom: [] },
        tournaments: { frequency: 'daily' },
        interns: { maxShown: 24 },
        journal: { retentionDays: 14 }
    };
    function merge(base, over) {
        if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
        var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
        Object.keys(over).forEach(function (k) {
            var v = over[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
            else if (v !== undefined) out[k] = v;
        });
        return out;
    }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    // Events that carry state: still applied when they arrive late (> 30 s).
    var STATEFUL = { 'needs.open': 1, 'needs.close': 1, 'interns.set': 1, 'mood': 1, 'cron.done': 1, 'project.done': 1,
        'standup.start': 1, 'standup.end': 1, 'tournament.start': 1, 'tournament.match': 1, 'tournament.end': 1,
        'paper.ready': 1, 'settings': 1, 'day': 1 };
    var STALE_MS = 30000;
    var HIDDEN_CLOSE_MS = 60000;
    var RETRY_UNAVAILABLE_MS = 5 * 60000;
    var POLL_429_MS = 15000;
    var RETRY_429_MS = 2000;       // first retry after a 429, doubling ...
    var RETRY_429_MAX_MS = 20000;  // ... up to 20 s: a freed slot is used within seconds
    var SILENCE_MS = 45000; // heartbeat is 15 s

    var S = {
        status: 'boot',      // boot | loading | ready | off (server has no Office life)
        live: false,
        seq: null,
        day: '', tz: '',
        settings: clone(DEFAULTS),
        snapshot: null,
        skew: 0,             // browser clock minus server clock (ms)
        mode: 'stream',      // stream | poll (after 429)
        lastByteAt: 0,
        backoff: 0,
        tries429: 0
    };
    var stream = null;
    var timers = {};
    var features = [];
    var director = null;
    var layer = null;
    var lastWatchAt = 0;
    var rmQuery = null;

    function now() { return Date.now(); }
    var ownPageId = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    function pageId() { return (typeof window !== 'undefined' && window.VOSave && window.VOSave.pageId) || ownPageId; }
    function serverNow() { return now() - S.skew; }
    function toMs(v) { v = Number(v); if (!v) return 0; return v < 1e12 ? v * 1000 : v; }
    function emit(name, detail) {
        try { root.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) {}
    }
    function clearTimer(name) { if (timers[name]) { clearTimeout(timers[name]); timers[name] = null; } }
    function later(name, ms, fn) { clearTimer(name); timers[name] = setTimeout(function () { timers[name] = null; fn(); }, ms); }
    function visible() { return !(typeof document !== 'undefined' && document.hidden); }

    function reducedMotion() {
        if (host && host.reducedMotion) return !!host.reducedMotion();
        try {
            if (!rmQuery && root.matchMedia) rmQuery = root.matchMedia('(prefers-reduced-motion: reduce)');
            return !!(rmQuery && rmQuery.matches);
        } catch (e) { return false; }
    }
    function enabled() { return S.status === 'ready' && S.settings.enabled !== false; }
    function isOn(name) {
        if (!enabled()) return false;
        if (!name) return true;
        var f = S.settings.features || {};
        return f[name] !== false;
    }
    // Calm mode or reduced motion: at-desk variants, no walking scripts, no particles.
    function atDesk() { return !!S.settings.calm || reducedMotion(); }

    // ---- feature registry ----
    // def: {setting: 'needsYou' | ['visitors', 'alarmClock'], order,
    //       claims: ['stretch'] (while the feature is on) or {sendPlanes: 'handoffs'} (while that setting is on),
    //       init(api), onState(snapshot), onEvent(ev), onSettings(settings), onDay(day), update(now),
    //       drawWorld(ctx), drawDesk(ctx, deskOwners), drawScreen(ctx), drawStatic(ctx, mode), click(x, y, touch), hover(x, y),
    //       isBusy(), suppressChip(key), onRoster(), reset(reason), onVisibility(visible)}
    var FEATURE_HOOKS = ['init', 'onState', 'onEvent', 'onSettings', 'onDay', 'update', 'drawWorld', 'drawDesk', 'drawScreen',
        'drawStatic', 'click', 'hover', 'isBusy', 'suppressChip', 'onRoster', 'reset', 'onVisibility'];
    function featureActive(f) {
        if (f._broken || !enabled()) return false;
        var s = f.setting;
        if (!s) return true;
        if (Array.isArray(s)) return s.some(function (n) { return isOn(n); });
        return isOn(s);
    }
    function safe(f, hook, a, b, c) {
        var fn = f[hook];
        if (typeof fn !== 'function') return undefined;
        try { return fn.call(f, a, b, c); } catch (e) {
            f._errors = (f._errors || 0) + 1;
            if (f._errors === 1 && root.console) root.console.warn('Office life: ' + f.name + '.' + hook + ' failed', e);
            if (f._errors >= 5) { f._broken = true; if (root.console) root.console.warn('Office life: ' + f.name + ' turned off after repeated errors'); }
            return undefined;
        }
    }
    function feature(name, def) {
        def = def || {};
        def.name = String(name);
        var old = features.findIndex(function (f) { return f.name === def.name; });
        if (old >= 0) features.splice(old, 1);
        features.push(def);
        features.sort(function (a, b) { return (a.order || 50) - (b.order || 50); });
        safe(def, 'init', api);
        if (S.status === 'ready') {
            safe(def, 'onSettings', clone(S.settings));
            if (S.snapshot) safe(def, 'onState', S.snapshot);
        }
        return def;
    }
    function each(hook, a, b, c) {
        for (var i = 0; i < features.length; i++) if (featureActive(features[i])) safe(features[i], hook, a, b, c);
    }
    function any(hook, a, b, c) {
        for (var i = 0; i < features.length; i++) if (featureActive(features[i]) && safe(features[i], hook, a, b, c)) return true;
        return false;
    }

    // ---- office time zone ----
    // The resolved zone comes with /state (tz), the `day` frame and the `settings`
    // frame (tz, else settings.timeZone); a zone saved here applies at once. It is set
    // before applySettings so features re-derive seasons, holidays and the Friday
    // treat in onSettings without a reload. officeParts keeps one formatter per zone.
    var zoneFormats = {};
    function setTz(tz) {
        tz = tz ? String(tz) : '';
        if (!tz || tz === S.tz) return false;
        S.tz = tz;
        return true;
    }
    function zoneFormat(tz) {
        if (!Object.prototype.hasOwnProperty.call(zoneFormats, tz)) {
            try {
                zoneFormats[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric',
                    hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' });
            } catch (e) { zoneFormats[tz] = null; } // unknown zone: browser local time
        }
        return zoneFormats[tz];
    }

    // ---- settings ----
    function applySettings(next, opts) {
        var before = S.settings;
        S.settings = merge(clone(DEFAULTS), next || {});
        var wasOn = before.enabled !== false, isNowOn = S.settings.enabled !== false;
        document.documentElement.classList.toggle('vo-life-off', !isNowOn || S.status !== 'ready');
        document.documentElement.classList.toggle('vo-life-calm', !!S.settings.calm);
        if (!wasOn && isNowOn && S.status === 'ready' && opts && opts.source !== 'state') {
            later('reload', 50, load); // switched back on: start from a fresh snapshot
        }
        if (director && (wasOn && !isNowOn)) {
            director.releaseAll('disabled');
            features.forEach(function (f) { safe(f, 'reset', 'disabled'); });
        } else if (director && before.calm !== S.settings.calm && S.settings.calm) {
            // Calm on: walking scripts end, features redraw their at-desk variant.
            features.forEach(function (f) { safe(f, 'reset', 'calm'); });
        }
        // Features switched off end their scripts.
        if (director) {
            features.forEach(function (f) {
                if (!featureActive(f)) director.cancelFeature(f.name, 'off');
            });
        }
        features.forEach(function (f) { if (!f._broken) safe(f, 'onSettings', clone(S.settings)); });
        if (host && host.invalidateStatic) host.invalidateStatic();
        if (host && host.markDirty) host.markDirty();
        emit('vo:life-settings', { settings: clone(S.settings), source: (opts && opts.source) || 'server' });
    }

    // ---- state + stream ----
    function setStatus(st) {
        S.status = st;
        document.documentElement.classList.toggle('vo-life-off', st !== 'ready' || S.settings.enabled === false);
    }
    function setLive(on) {
        if (S.live === !!on) return;
        S.live = !!on;
        emit('vo:life-live', { live: S.live });
    }
    function readSkew(res) {
        try {
            var d = res.headers.get('Date');
            if (d) { var ms = Date.parse(d); if (ms) S.skew = now() - ms; }
        } catch (e) {}
    }
    function getJSON(url) {
        return fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (res) {
            readSkew(res);
            if (!res.ok) { var err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
            return res.json();
        });
    }
    function load() {
        clearTimer('load');
        if (!visible()) { S.loadDue = true; return; }
        if (S.status !== 'ready') setStatus('loading');
        getJSON('/api/office-life/state').then(function (data) {
            if (!data || data.ok !== true) throw new Error('unavailable');
            applyState(data);
            if (S.mode === 'stream') openStream();
            else later('poll', POLL_429_MS, pollState);
        }).catch(function () {
            // This server has no Office life (or it failed): nothing shows; look again later.
            closeStream();
            setLive(false);
            if (director) director.releaseAll('unavailable');
            features.forEach(function (f) { safe(f, 'reset', 'unavailable'); });
            setStatus('off');
            later('load', RETRY_UNAVAILABLE_MS, load);
        });
    }
    function applyState(data) {
        var first = S.status !== 'ready';
        setStatus('ready');
        if (data.seq != null) S.seq = data.seq;
        if (data.day) S.day = String(data.day);
        setTz(data.tz);
        S.snapshot = data;
        applySettings(data.settings || {}, { source: 'state' });
        if (!first && director) director.onRoster(); // a resync restarts scripts from the snapshot
        each('onState', data);
        emit('vo:life-state', { first: first });
    }
    function pollState() {
        if (!visible() || S.mode !== 'poll') return;
        getJSON('/api/office-life/state').then(function (data) {
            if (data && data.ok === true) applyState(data);
        }).catch(function () {}).then(function () {
            if (S.mode === 'poll') later('poll', POLL_429_MS, pollState);
        });
    }
    function tooManyStreams(retryAfter) {
        // 2.5: no free stream slot right now. Read /state meanwhile and try the stream again in
        // 2, 4, 8, 16, then every 20 s (or the server's Retry-After), never parked on slow polling.
        S.mode = 'poll';
        setLive(false);
        S.tries429 += 1;
        var wait = Math.min(RETRY_429_MAX_MS, RETRY_429_MS * Math.pow(2, Math.min(S.tries429 - 1, 4)));
        if (retryAfter > 0) wait = Math.max(wait, Math.min(RETRY_429_MAX_MS, retryAfter * 1000));
        wait += Math.floor(Math.random() * 400);
        if (!timers.poll) later('poll', POLL_429_MS, pollState);
        later('retry429', wait, function () { S.mode = 'stream'; clearTimer('poll'); if (visible()) openStream(); });
    }
    function closeStream() {
        if (!stream) return;
        var s = stream;
        stream = null;
        try { s.ctrl.abort(); } catch (e) {}
        setLive(false);
    }
    function reconnect() {
        if (stream || S.status !== 'ready' || S.mode !== 'stream' || !visible()) return;
        S.backoff = Math.min(30000, S.backoff ? S.backoff * 2 : 3000);
        later('reconnect', S.backoff, openStream);
    }
    function openStream() {
        if (stream || S.status !== 'ready' || S.mode !== 'stream' || !visible()) return;
        if (typeof fetch !== 'function' || typeof TextDecoder === 'undefined') return;
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var me = { ctrl: ctrl || { abort: function () {} } };
        stream = me;
        S.lastByteAt = now();
        var url = '/api/office-life/stream' + (S.seq != null ? '?since=' + encodeURIComponent(S.seq) : '');
        fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'text/event-stream', 'X-VO-Client': pageId() }, signal: ctrl ? ctrl.signal : undefined })
            .then(function (res) {
                if (stream !== me) return;
                if (res.status === 429) { stream = null; tooManyStreams(Number(res.headers.get('Retry-After')) || 0); return; }
                var type = (res.headers.get('Content-Type') || '').toLowerCase();
                if (!res.ok || !res.body || type.indexOf('text/event-stream') < 0) {
                    stream = null;
                    setLive(false);
                    if (res.status === 404 || res.status === 501) { load(); return; } // routes gone: re-check
                    reconnect();
                    return;
                }
                setLive(true);
                S.backoff = 0;
                S.tries429 = 0;
                var reader = res.body.getReader();
                var dec = new TextDecoder();
                var buf = '';
                function pump() {
                    return reader.read().then(function (r) {
                        if (stream !== me) { try { reader.cancel(); } catch (e) {} return; }
                        if (r.done) { stream = null; setLive(false); reconnect(); return; }
                        S.lastByteAt = now();
                        buf += dec.decode(r.value, { stream: true }).replace(/\r\n?/g, '\n');
                        var idx;
                        while ((idx = buf.indexOf('\n\n')) >= 0) {
                            var block = buf.slice(0, idx);
                            buf = buf.slice(idx + 2);
                            onBlock(block);
                            if (stream !== me) return;
                        }
                        if (buf.length > 1048576) buf = '';
                        return pump();
                    });
                }
                return pump();
            })
            .catch(function () {
                if (stream !== me) return;
                stream = null;
                setLive(false);
                reconnect();
            });
    }
    function onBlock(block) {
        var data = [], id = null;
        block.split('\n').forEach(function (line) {
            if (!line || line.charAt(0) === ':') return; // comment / heartbeat
            var c = line.indexOf(':');
            var field = c < 0 ? line : line.slice(0, c);
            var value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
            if (field === 'data') data.push(value);
            else if (field === 'id') id = value;
        });
        if (!data.length) return;
        var frame;
        try { frame = JSON.parse(data.join('\n')); } catch (e) { return; }
        if (!frame || typeof frame !== 'object') return;
        if (frame.type === 'resync') { resync(); return; }
        if (id != null && id !== '') S.seq = isNaN(Number(id)) ? id : Number(id);
        else if (frame.seq != null) S.seq = frame.seq;
        if (frame.event && typeof frame.event === 'object') dispatch(frame.event, frame);
    }
    function resync() {
        // The stream fell too far behind (or the server restarted): start over from /state.
        closeStream();
        S.seq = null;
        load();
    }
    function dispatch(ev, frame) {
        var type = String(ev.type || '');
        if (!type) return;
        if (type === 'settings') {
            var next = ev.settings && typeof ev.settings === 'object' ? ev.settings : ev;
            setTz(ev.tz || next.timeZone);
            applySettings(next, { source: 'stream' });
            return;
        }
        if (type === 'day') {
            if (ev.day) S.day = String(ev.day);
            setTz(ev.tz);
            each('onDay', S.day);
            if (host && host.invalidateStatic) host.invalidateStatic();
            return;
        }
        if (!enabled()) return;
        var at = toMs(ev.at) || toMs(frame && frame.ts) || serverNow();
        var age = serverNow() - at;
        if (age > STALE_MS && !STATEFUL[type]) return; // transient visuals are never replayed late
        var e = Object.assign({}, ev, { type: type, _age: age, _stale: age > STALE_MS });
        each('onEvent', e);
        emit('vo:life-event', e);
    }

    // ---- visibility ----
    function onVisibility() {
        if (!visible()) {
            later('hidden', HIDDEN_CLOSE_MS, closeStream);
        } else {
            clearTimer('hidden');
            if (S.status === 'off' || S.loadDue) { S.loadDue = false; load(); }
            else if (S.status === 'ready') {
                if (S.mode === 'poll') pollState();
                else if (!stream) { S.backoff = 0; openStream(); }
            }
        }
        each('onVisibility', visible());
    }

    // ---- DOM layer over the canvas (edge badges, caption bar, replay bar) ----
    function ensureLayer() {
        if (layer && layer.isConnected) return layer;
        var wrap = document.querySelector('.game-wrapper');
        if (!wrap) return null;
        layer = document.createElement('div');
        layer.className = 'vo-life-layer';
        layer.id = 'voLifeLayer';
        wrap.appendChild(layer);
        return layer;
    }

    // ---- hooks game.js calls ----
    var api = {
        version: 1,
        text: LIFE_TEXT,
        t: t, clip: clip, plural: plural, ordinal: ordinal, standupTitle: standupTitle,
        addText: function (obj) { Object.keys(obj || {}).forEach(function (k) { if (!(k in LIFE_TEXT)) LIFE_TEXT[k] = String(obj[k]); }); },
        host: function () { return host; },
        director: function () { return director; },
        sprites: function () { return root.VOLifeSprites || null; },
        feature: feature,
        features: function () { return features.map(function (f) { return f.name; }); },
        settings: function () { return clone(S.settings); },
        defaults: function () { return clone(DEFAULTS); },
        // Settings saved by the Office life settings form: apply here at once
        // (the stream's `settings` event brings them to the other tabs).
        applySettings: function (s) { setTz(s && s.timeZone); applySettings(s, { source: 'local' }); },
        enabled: enabled,
        isOn: isOn,
        atDesk: atDesk,
        calm: function () { return !!S.settings.calm; },
        reducedMotion: reducedMotion,
        noParticles: function () { return atDesk(); },
        live: function () { return S.live; },
        status: function () { return S.status; },
        day: function () { return S.day; },
        timeZone: function () { return S.tz || S.settings.timeZone || ''; },
        snapshot: function () { return S.snapshot; },
        serverNow: serverNow,
        // Office-local parts of a time (ms, default now) in the office time zone.
        officeParts: function (ms) {
            var d = new Date(ms == null ? serverNow() : ms);
            var fmt = zoneFormat(S.tz || S.settings.timeZone || '');
            try {
                if (!fmt) throw new Error('no zone format');
                var parts = fmt.formatToParts(d);
                var o = {};
                parts.forEach(function (p) { o[p.type] = p.value; });
                var wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[o.weekday] || 1;
                return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour % 24, minute: +o.minute, weekday: wd };
            } catch (e) {
                return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), weekday: d.getDay() || 7 };
            }
        },
        // Same-origin JSON POST (vo-auth.js handles 401 / passcode).
        post: function (path, body) {
            return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body || {}) }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) {
                    if (!res.ok) { var err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status)); err.status = res.status; err.data = data; throw err; }
                    return data;
                });
            });
        },
        layer: ensureLayer,
        refresh: load,

        // -- called by game.js --
        onStatus: function (agent, entry) {
            if (!director || !agent) return false;
            return director.onStatus(agent.statusKey || agent.id, entry);
        },
        update: function () {
            if (S.status !== 'ready') return;
            var t0 = now();
            if (director) director.update();
            if (enabled()) each('update', t0);
            if (stream && S.live && t0 - lastWatchAt > 1000) {
                lastWatchAt = t0;
                if (t0 - S.lastByteAt > SILENCE_MS) { closeStream(); S.backoff = 0; reconnect(); } // silent link: reopen
            }
        },
        drawWorld: function (ctx) { if (enabled()) each('drawWorld', ctx); },
        // Desk props for these desk owners (game.js calls it right after the desks).
        drawDesk: function (ctx, owners) {
            if (!enabled()) return;
            for (var i = 0; i < features.length; i++) if (features[i].drawDesk && featureActive(features[i])) safe(features[i], 'drawDesk', ctx, owners);
        },
        drawScreen: function (ctx) { if (enabled()) each('drawScreen', ctx); },
        drawStatic: function (ctx, mode) { if (enabled()) each('drawStatic', ctx, mode); },
        isBusy: function () { return enabled() && ((director && director.isBusy()) || any('isBusy')); },
        click: function (x, y, touch) {
            if (!enabled()) return false;
            for (var i = 0; i < features.length; i++) {
                var f = features[i];
                if (featureActive(f) && safe(f, 'click', x, y, touch)) return true;
            }
            return false;
        },
        hover: function (x, y) { return enabled() && any('hover', x, y); },
        // A feature that replaces an office behavior claims it while the stream
        // is live (e.g. 'sendPlanes' for handoffs, 'stretch' for moods).
        claims: function (name) {
            if (!enabled() || !S.live) return false;
            // def.claims: ['stretch'] (while the feature is on) or {sendPlanes: 'handoffs'} (while that setting is on).
            for (var i = 0; i < features.length; i++) {
                var f = features[i], c = f.claims;
                if (!c || !featureActive(f)) continue;
                if (Array.isArray(c) ? c.indexOf(name) >= 0 : (Object.prototype.hasOwnProperty.call(c, name) && isOn(c[name]))) return true;
            }
            return false;
        },
        handoffsLive: function () { return api.claims('sendPlanes'); },
        suppressApprovalChip: function (key) { return enabled() && any('suppressChip', key); },
        onRoster: function () {
            if (director) director.onRoster();
            each('onRoster');
        },
        _debug: function () {
            return { status: S.status, live: S.live, mode: S.mode, tries429: S.tries429, seq: S.seq, day: S.day, tz: S.tz, skew: S.skew,
                features: features.map(function (f) { return { name: f.name, active: featureActive(f), broken: !!f._broken }; }),
                running: director ? director.runningKeys() : [] };
        },
        // Tests only: feed one event as if it came from the stream.
        _inject: function (ev) { dispatch(ev, { ts: serverNow() }); }
    };
    root.VOLife = api;

    function boot() {
        host = root.VOLifeHost || null;
        if (!host || !root.VOLifeDirector) return; // the office page is not there (other pages)
        director = root.VOLifeDirector.create(host, {
            now: now,
            hidden: function () { return !visible(); },
            atDesk: atDesk
        });
        document.addEventListener('visibilitychange', onVisibility);
        // Back online after a lost connection: read the state again and reopen the stream now.
        root.addEventListener('vo:online', function () {
            clearTimer('reconnect');
            S.backoff = 0;
            if (S.status === 'ready' && stream) return;
            if (S.status === 'ready' && S.mode === 'stream') { getJSON('/api/office-life/state').then(function (data) {
                if (data && data.ok === true) applyState(data);
            }).catch(function () {}).then(openStream); return; }
            if (S.status !== 'ready' || S.mode !== 'poll') { load(); return; }
            pollState();
        });
        try {
            if (!rmQuery && root.matchMedia) rmQuery = root.matchMedia('(prefers-reduced-motion: reduce)');
            if (rmQuery && rmQuery.addEventListener) rmQuery.addEventListener('change', function () {
                if (reducedMotion()) features.forEach(function (f) { safe(f, 'reset', 'calm'); });
                if (host.invalidateStatic) host.invalidateStatic();
            });
        } catch (e) {}
        ensureLayer();
        load();
    }
    document.documentElement.classList.add('vo-life-off');
    // After every classic script (the feature modules) has registered.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else setTimeout(boot, 0);
})(window);
