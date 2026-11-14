// Office life: the Settings section ("Office life" category, design 4).
// Owner: L9 life-settings. ui-modern.js calls VOLifeSettings.mount(#voLifeSettings)
// when the category opens. The form edits a draft of the saved settings, saves only
// the changed keys with POST /api/office-life/settings (gated like /setup/save:
// same-origin + passcode; a 401 auth_required goes to the login page through
// vo-auth.js) and hands the saved settings to VOLife.applySettings (calm flag,
// features, other tabs follow through the stream's `settings` event).
// Also here: the office time zone adopted once from the first browser that may
// save (no zone saved, the server on its UTC fallback), and the More menu
// "Daily Office" / "Replay the day" items that follow the newspaper switch.
(function (root) {
    'use strict';

    var STYLE_ID = 'vo-life-settings-style';
    var SAVE_URL = '/api/office-life/settings';
    var ZONE_REFUSED_KEY = 'vo-life-zone-refused';
    var CUSTOM_MAX = 12, CUSTOM_NAME_MAX = 24, RETENTION_MIN = 1, RETENTION_MAX = 60;
    var INTERNS_SHOWN_MIN = 1, INTERNS_SHOWN_MAX = 48; // office_life/settings.py

    var TEXT = {
        loading: 'Loading Office life settings...',
        unavailable: 'Office life is not available on this server.',
        readOnly: 'Only the office owner can change these settings (sign in with the office passcode).',
        lifeTitle: 'Office life',
        lifeIntro: 'Agents react to real work in the office. Everything comes from data the office already has: no AI calls, no extra cost.',
        enabled: 'Show office life', enabledHint: 'Turn it off to hide every part of it. The history is kept.',
        calm: 'Calm mode', calmHint: 'Signs and icons only: nobody walks around, no confetti, no tournaments.',
        featuresTitle: 'What happens in the office',
        standupTitle: 'Daily stand-up', standupTime: 'Time', standupDays: 'Days',
        standupNoDays: 'No days picked: the stand-up never runs on its own.',
        standupNow: 'Run stand-up now',
        paperTitle: 'Daily Office newspaper', paperTime: 'Printed at', paperNow: "Print today's paper now",
        paperHint: 'Open it any time from More > Daily Office.',
        seasonsTitle: 'Seasons and occasions', holidaysTitle: 'Holidays',
        customTitle: 'Your own occasions', customHint: 'Up to 12 yearly dates, like a launch day.',
        customAdd: 'Add an occasion', customName: 'Name', customMonth: 'Month', customDay: 'Day', customIcon: 'Icon',
        customRemove: 'Remove {name}', customEmpty: 'No occasions yet.',
        tournamentsTitle: 'Break-time tournaments', frequency: 'How often',
        timeTitle: 'Time and history', zone: 'Office time zone',
        zoneServer: 'Server default ({zone})', zoneServerUnknown: 'Server default',
        zoneNow: 'Office time now: {time} ({zone}).',
        zoneUses: 'The stand-up, the newspaper and the office day use this zone.',
        zoneDiffers: 'This browser is on {browser}. Times here use the office zone, {office}.',
        zoneUse: 'Use {zone}',
        retention: 'Keep the day-by-day history for', retentionUnit: 'days',
        internsMax: 'Most interns in the office', internsMaxUnit: 'One per running helper up to this; past it the helper count says how many are shown.',
        saved: 'All changes saved.', unsaved: 'Unsaved changes.', saving: 'Saving...',
        save: 'Save changes', discard: 'Discard',
        savedToast: 'Office life settings saved.',
        notSaved: 'Settings were not saved: {why}',
        needSignIn: 'Sign in with the office passcode to change Office life.',
        crossSite: 'Changes to the office must come from the office page itself.',
        noNetwork: 'Could not reach the office. Try again.',
        disabledOff: 'Office life is switched off (saved settings).',
        disabledFeature: 'Switched off in the saved settings.',
        disabledDirty: 'Save your changes first.',
        standupStarted: 'Stand-up started with {n}.', standupSkipped: 'No stand-up: no agent is around right now.',
        paperMade: "Today's Daily Office is printed. Open it from More > Daily Office.",
        zoneAdopted: 'Office time zone set to {zone} (this browser). Change it in Settings > Office life.',
        errTime: 'Use a time like 09:30 (24-hour).', errName: 'Give the occasion a name.',
        errDate: 'Pick a real date.', errRetention: 'Keep the history for 1 to 60 days.', errInternsMax: 'Show 1 to 48 interns at most.', errZone: 'Pick a time zone from the list.'
    };
    var FEATURES = [
        ['needsYou', 'Needs you', 'An agent waiting for your OK or an answer walks to the front desk and holds up a sign.'],
        ['interns', 'Interns', 'Helper agents started by your agents show up as interns while they run.'],
        ['handoffs', 'Handoffs', 'An agent that sends work to another agent walks it over with a folder.'],
        ['visitors', 'Visitors', 'Messages from outside channels (Telegram, SMS, email...) arrive with a courier.'],
        ['alarmClock', 'Alarm clocks', "A scheduled job rings an alarm clock on the agent's desk."],
        ['moods', 'Moods', 'Body language from real work: focused, stuck, relieved, asleep.'],
        ['celebrations', 'Celebrations', 'Finished tasks and projects, XP pops, high-fives and cake.'],
        ['standup', 'Daily stand-up', 'Agents gather at the meeting table and each says what it did.'],
        ['seasons', 'Seasons and occasions', 'Seasonal decor, holidays, a Friday treat, umbrellas on rainy days, birthdays.'],
        ['tournaments', 'Break-time tournaments', 'Idle agents play ping pong or darts brackets. Click a player to cheer.'],
        ['newspaper', 'Daily Office newspaper', 'A front page about the day at a set time, and a replay of the day.'],
        ['reactions', 'Click reactions', 'Click a lamp, the TV, the vending machine and other pieces to see them react. Only in this browser.']
    ];
    var SEASON_TOGGLES = [
        ['decor', 'Seasonal decor', "Follows the weather location's hemisphere; none near the equator or without a location."],
        ['fridayTreat', 'Friday treat', 'A box of donuts in the kitchen on Fridays.'],
        ['rain', 'Rainy days', 'Umbrellas by the door when it rains, boots when it snows.'],
        ['birthdays', 'Agent birthdays', 'A party hat on the day an agent was created, when its provider records it.']
    ];
    var HOLIDAYS = [
        ['newYear', 'New Year', 'Dec 31 and Jan 1'],
        ['valentines', "Valentine's Day", 'Feb 14'],
        ['earthDay', 'Earth Day', 'Apr 22'],
        ['halloween', 'Halloween', 'Oct 31'],
        ['yearEndLights', 'Year-end lights', 'Dec 15 to 31']
    ];
    var ICONS = [['star', 'Star'], ['cake', 'Cake'], ['heart', 'Heart'], ['balloon', 'Balloon'], ['flag', 'Flag']];
    var FREQUENCIES = [
        ['daily', 'Once a day (between 12:00 and 17:00)'],
        ['twice', 'Twice a day (11:00 to 13:00 and 15:00 to 17:00)'],
        ['off', 'Off']
    ];
    var DAYS = [[1, 'Mon', 'Monday'], [2, 'Tue', 'Tuesday'], [3, 'Wed', 'Wednesday'], [4, 'Thu', 'Thursday'],
        [5, 'Fri', 'Friday'], [6, 'Sat', 'Saturday'], [7, 'Sun', 'Sunday']];
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
        'November', 'December'];
    var MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];   // a leap year: 02-29 is a valid occasion

    var S = {
        host: null,          // mounted container
        base: null,          // saved settings (from VOLife or the last save)
        draft: null,         // what the form shows
        errors: {},          // field path -> message
        saving: false,
        busy: {},            // 'standup' | 'paper' -> true while the button's request runs
        canSave: null,       // null = unknown, from VOAuth.status().canManage
        serverZone: '',      // the server's zone while no zone is saved (TZ env or UTC)
        message: null,       // {text, kind} under the Save bar
        zones: null
    };
    var A = { tried: false, done: '', skipped: '' };   // time zone adoption

    // ---- helpers ----
    function t(key, vars) {
        return String(TEXT[key] || key).replace(/\{(\w+)\}/g, function (m, n) { return vars && vars[n] != null ? vars[n] : ''; });
    }
    function life() { return root.VOLife || null; }
    function ready() { var L = life(); return !!(L && L.status && L.status() === 'ready'); }
    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
    function defaults() {
        var L = life();
        return L && L.defaults ? L.defaults() : { enabled: true, calm: false, timeZone: '', features: {}, standup: { time: '09:30', days: [1, 2, 3, 4, 5] },
            newspaper: { time: '18:00' }, seasons: { holidays: {}, custom: [] }, tournaments: { frequency: 'daily' }, interns: { maxShown: 24 },
            journal: { retentionDays: 14 } };
    }
    function mergeDeep(base, over) {
        var out = clone(base) || {};
        Object.keys(over || {}).forEach(function (k) {
            out[k] = isObj(over[k]) && isObj(out[k]) ? mergeDeep(out[k], over[k]) : clone(over[k]);
        });
        return out;
    }
    // Only the changed keys (arrays as a whole): the server merges them onto what it has,
    // so a save never undoes a change another tab made to other settings.
    function diff(base, draft) {
        var out = {}, n = 0;
        Object.keys(draft || {}).forEach(function (k) {
            var a = base ? base[k] : undefined, b = draft[k];
            if (isObj(a) && isObj(b)) {
                var d = diff(a, b);
                if (d) { out[k] = d; n++; }
            } else if (!same(a, b)) { out[k] = clone(b); n++; }
        });
        return n ? out : null;
    }
    function get(obj, path) {
        return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
    }
    function set(obj, path, value) {
        var parts = path.split('.'), o = obj;
        for (var i = 0; i < parts.length - 1; i++) {
            if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
            o = o[parts[i]];
        }
        o[parts[parts.length - 1]] = value;
    }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function icon(name) {
        if (root.VOUI && root.VOUI.icon) return root.VOUI.icon(name);
        return el('span');
    }
    function toast(text, kind) {
        if (root.VOUI && root.VOUI.toast) root.VOUI.toast(text, { kind: kind || 'info' });
    }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function browserZone() {
        if (root.VOLifeSettings && root.VOLifeSettings._zoneOverride) return root.VOLifeSettings._zoneOverride;
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
    }
    function isUtc(zone) { return /^(Etc\/)?(UTC|UCT|GMT|GMT0|Universal|Zulu|Greenwich)$/i.test(String(zone || '')); }
    function zoneOk(zone) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch (e) { return false; }
    }
    function access() {
        if (!(root.VOAuth && root.VOAuth.status)) return Promise.resolve(null);
        return root.VOAuth.status().then(function (st) { return st || null; }, function () { return null; });
    }
    function post(url, body) {
        return root.fetch(url, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body || {})
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                return { status: res.status, data: data || {} };
            });
        });
    }
    function failure(r) {
        var d = (r && r.data) || {};
        if (r && r.status === 401) return t('needSignIn');
        if (r && r.status === 403 && d.error === 'cross_site_blocked') return d.message || t('crossSite');
        return d.message || t('notSaved', { why: 'HTTP ' + (r ? r.status : '?') });
    }

    // ---- the office time zone ----
    function savedSettings() {
        var L = life();
        return L && L.settings ? L.settings() : defaults();
    }
    function noteServerZone() {
        var L = life();
        if (L && L.timeZone && !(S.base && S.base.timeZone)) S.serverZone = L.timeZone() || S.serverZone;
    }
    function officeZone(settings) {
        var z = settings && settings.timeZone;
        return z || S.serverZone || 'UTC';
    }
    function nowIn(zone) {
        try {
            return new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
                .format(new Date());
        } catch (e) { return ''; }
    }
    function zoneList() {
        if (!S.zones) {
            S.zones = [];
            try { if (Intl.supportedValuesOf) S.zones = Intl.supportedValuesOf('timeZone').slice(); } catch (e) { S.zones = []; }
        }
        var added = false;
        ['UTC', browserZone(), S.base && S.base.timeZone, S.draft && S.draft.timeZone, S.serverZone].forEach(function (z) {
            if (z && S.zones.indexOf(z) < 0) { S.zones.push(z); added = true; }
        });
        if (added) S.zones.sort();
        return S.zones;
    }
    // Once per page: no zone saved and the server on its UTC fallback (a TZ env naming a
    // zone is the operator's choice) -> this browser's zone, saved through the normal
    // gated route, only when this browser may save. A UTC browser saves nothing.
    function maybeAdoptZone() {
        if (A.tried || !ready()) return;
        var L = life();
        var saved = L.settings();
        if (saved.enabled === false) { A.skipped = 'off'; return; }
        if (saved.timeZone) { A.tried = true; A.skipped = 'set'; return; }
        var server = L.timeZone ? L.timeZone() : '';
        if (server && !isUtc(server)) { A.tried = true; A.skipped = 'env'; return; }
        var zone = browserZone();
        if (!zone || isUtc(zone) || !zoneOk(zone)) { A.tried = true; A.skipped = 'utc'; return; }
        try { if (root.localStorage && root.localStorage.getItem(ZONE_REFUSED_KEY) === zone) { A.tried = true; A.skipped = 'refused'; return; } } catch (e) {}
        A.tried = true;
        access().then(function (st) {
            if (!st || !st.canManage) { A.skipped = 'no-permission'; return null; }
            if (life().settings().timeZone) { A.skipped = 'set'; return null; }
            return post(SAVE_URL, { timeZone: zone }).then(function (r) {
                if (r.status === 200 && r.data.ok) {
                    A.done = zone;
                    applySaved(r.data);
                    toast(t('zoneAdopted', { zone: zone }), 'info');
                } else {
                    A.skipped = 'refused';
                    if (r.status === 400) try { root.localStorage.setItem(ZONE_REFUSED_KEY, zone); } catch (e) {}
                }
            });
        }).catch(function () { A.skipped = 'network'; });
    }

    // ---- More menu: Daily Office + Replay the day ----
    function syncMenu() {
        var L = life();
        var on = !!(L && L.isOn && L.isOn('newspaper'));
        document.querySelectorAll('[data-vo-life-menu]').forEach(function (item) { item.hidden = !on; });
    }

    // ---- validation (mirrors office_life/settings.py) ----
    function validTime(v) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
        return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
    }
    function validate(d) {
        var errs = {};
        if (!validTime(get(d, 'standup.time'))) errs['standup.time'] = t('errTime');
        if (!validTime(get(d, 'newspaper.time'))) errs['newspaper.time'] = t('errTime');
        (get(d, 'seasons.custom') || []).forEach(function (row, i) {
            if (!String(row.name || '').trim()) errs['seasons.custom.' + i + '.name'] = t('errName');
            var m = /^(\d{2})-(\d{2})$/.exec(row.date || '');
            if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) < 1 || Number(m[2]) > MONTH_DAYS[Number(m[1]) - 1]) {
                errs['seasons.custom.' + i + '.date'] = t('errDate');
            }
        });
        var r = get(d, 'journal.retentionDays');
        if (typeof r !== 'number' || !isFinite(r) || r < RETENTION_MIN || r > RETENTION_MAX || Math.round(r) !== r) {
            errs['journal.retentionDays'] = t('errRetention');
        }
        var im = get(d, 'interns.maxShown'); // missing = the default
        if (im !== undefined && (typeof im !== 'number' || !isFinite(im) || im < INTERNS_SHOWN_MIN || im > INTERNS_SHOWN_MAX || Math.round(im) !== im)) {
            errs['interns.maxShown'] = t('errInternsMax');
        }
        if (d.timeZone && !zoneOk(d.timeZone)) errs.timeZone = t('errZone');
        return errs;
    }

    // ---- state ----
    function dirty() { return !!(S.base && S.draft && diff(S.base, S.draft)); }
    function load(settings) {
        S.base = mergeDeep(defaults(), settings || {});
        S.draft = clone(S.base);
        S.errors = {};
        noteServerZone();
    }
    // New saved settings (stream, another tab, our own save): keep the user's own edits on top.
    function rebase(settings) {
        var next = mergeDeep(defaults(), settings || {});
        if (S.base && same(next, S.base)) return false;
        var mine = S.base && S.draft ? diff(S.base, S.draft) : null;
        S.base = next;
        S.draft = mergeDeep(next, mine || {});
        noteServerZone();
        return true;
    }
    // A save answered. Edits not in it stay in the draft (v0.10.1 saves): with `sent`
    // (our own save) those made while it was on the way, else every unsaved edit.
    function applySaved(data, sent) {
        var L = life();
        var saved = data && data.settings;
        if (!saved) return;
        if (!saved.timeZone && data.tz) S.serverZone = String(data.tz);
        var mine = S.draft ? diff(sent || S.base || defaults(), S.draft) : null;
        S.base = mergeDeep(defaults(), saved);
        S.draft = mergeDeep(S.base, mine || {});
        S.errors = {};
        if (L && L.applySettings) L.applySettings(saved);   // calm flag, features, menu (vo:life-settings)
        render();
    }
    function edit(path, value) {
        set(S.draft, path, value);
        if (S.errors[path]) { delete S.errors[path]; }
        S.message = null;
        update();
    }

    // ---- save / discard / buttons ----
    function save() {
        if (S.saving || !S.draft) return Promise.resolve(false);
        if (!ready()) return Promise.resolve(false);
        S.errors = validate(S.draft);
        var first = Object.keys(S.errors)[0];
        if (first) {
            render();
            focusField(first);
            toast(S.errors[first], 'error');
            return Promise.resolve(false);
        }
        var payload = diff(S.base, S.draft);
        if (!payload) { update(); return Promise.resolve(true); }
        S.saving = true;
        S.message = { text: t('saving'), kind: 'info' };
        update();
        var sent = clone(S.draft);
        return post(SAVE_URL, payload).then(function (r) {
            S.saving = false;
            if (r.status === 200 && r.data && r.data.ok) {
                applySaved(r.data, sent);
                S.message = { text: t('saved'), kind: 'ok' };
                update();
                toast(t('savedToast'), 'success');
                return true;
            }
            var why = failure(r);
            (r.data && Array.isArray(r.data.errors) ? r.data.errors : []).forEach(function (e) {
                if (e && e.field) S.errors[e.field] = e.message || why;
            });
            S.message = { text: why, kind: 'error' };
            render();
            var bad = Object.keys(S.errors)[0];
            if (bad) focusField(bad);
            toast(why, 'error');
            return false;
        }, function () {
            S.saving = false;
            S.message = { text: t('noNetwork'), kind: 'error' };
            update();
            toast(t('noNetwork'), 'error');
            return false;
        });
    }
    function reset() {
        if (!S.base) return;
        S.draft = clone(S.base);
        S.errors = {};
        S.message = null;
        render();
    }
    function runNow(kind) {
        if (S.busy[kind]) return Promise.resolve(false);
        S.busy[kind] = true;
        update();
        var url = kind === 'standup' ? '/api/office-life/standup/now' : '/api/office-life/paper/now';
        return post(url, {}).then(function (r) {
            S.busy[kind] = false;
            update();
            if (r.status !== 200 || !r.data || !r.data.ok) { toast(failure(r), 'error'); return false; }
            if (kind === 'paper') toast(t('paperMade'), 'success');
            else if (r.data.started) {
                var n = Number(r.data.participants) || 0;
                toast(t('standupStarted', { n: n + (n === 1 ? ' agent' : ' agents') }), 'success');
            } else toast(t('standupSkipped'), 'info');
            return true;
        }, function () {
            S.busy[kind] = false;
            update();
            toast(t('noNetwork'), 'error');
            return false;
        });
    }
    // Why a "now" button cannot run (from the SAVED settings: the server acts on those).
    function nowBlocked(feature) {
        if (S.canSave === false) return t('readOnly');
        var saved = S.base || {};
        if (!ready() || saved.enabled === false) return t('disabledOff');
        if ((saved.features || {})[feature] === false) return t('disabledFeature');
        var mine = diff(saved, S.draft || saved) || {};
        if (mine.enabled === false || (mine.features || {})[feature] === false) return t('disabledDirty');
        return '';
    }

    // ---- rendering ----
    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
            '#main-menu-panel .mm-section[data-category="life"]{padding:0;border:0;background:none}',
            '#main-menu-panel[data-settings-category="life"]:not(.ui-settings-dirty) .settings-footer{display:none}',
            '.vo-ls{display:flex;flex-direction:column;gap:14px;color:var(--ui-text-1);font-family:var(--ui-font)}',
            '.vo-ls fieldset{display:flex;flex-direction:column;gap:14px;min-width:0;margin:0;padding:0;border:0}',
            '.vo-ls-card{padding:18px;border:1px solid var(--ui-border-soft);border-radius:var(--ui-radius-md);background:var(--vo-surface-2)}',
            '.vo-ls-card .mm-section-title{margin-bottom:6px}',
            '.vo-ls-card h4{margin:14px 0 4px;color:var(--ui-text-2);font-size:var(--vo-text-sm);font-weight:700}',
            '.vo-ls-hint{margin:0 0 6px;color:var(--ui-text-3);font-size:var(--vo-text-xs);line-height:1.55}',
            '.vo-ls-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));column-gap:20px}',
            '.vo-ls-toggle{display:flex;align-items:flex-start;gap:10px;padding:7px 0;cursor:pointer}',
            '.vo-ls-toggle input{flex:none;width:18px;height:18px;min-height:0!important;margin:1px 0 0;accent-color:var(--vo-accent);cursor:pointer}',
            '.vo-ls-toggle-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
            '.vo-ls-toggle b{color:var(--ui-text-1);font-size:var(--vo-text-md);font-weight:650;line-height:1.35}',
            '.vo-ls-toggle small{color:var(--ui-text-3);font-size:var(--vo-text-xs);line-height:1.5}',
            '.vo-ls-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 14px;margin-top:8px}',
            '.vo-ls-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
            '.vo-ls-field>span{color:var(--ui-text-2);font-size:var(--vo-text-sm);font-weight:650}',
            '.vo-ls .mm-input{margin:0}',
            '.vo-ls input[type="time"].mm-input{width:8.5em}',
            '.vo-ls-days{display:flex;flex-wrap:wrap;gap:6px}',
            '.vo-ls-day{min-width:48px;min-height:38px;padding:0 10px;border:1px solid var(--ui-border-strong);border-radius:var(--ui-radius-sm);background:var(--vo-surface-3);color:var(--ui-text-2);font:inherit;font-size:var(--vo-text-sm);font-weight:650;cursor:pointer}',
            '.vo-ls-day[aria-pressed="true"]{border-color:transparent;background:var(--vo-accent);color:var(--vo-accent-ink)}',
            '.vo-ls-day:focus-visible,.vo-ls-toggle input:focus-visible{outline:2px solid var(--vo-accent);outline-offset:2px}',
            '.vo-ls .mm-btn{margin:0}',
            '.vo-ls-custom{display:flex;flex-direction:column;gap:8px;margin-top:6px}',
            '.vo-ls-occ{display:grid;grid-template-columns:minmax(120px,1fr) minmax(110px,9em) 5.2em minmax(90px,7em) auto;gap:8px;align-items:start}',
            '.vo-ls-occ .vo-btn--icon{min-width:38px;min-height:38px}',
            '.vo-ls-note{margin:8px 0 0;color:var(--ui-text-3);font-size:var(--vo-text-xs);line-height:1.55}',
            '.vo-ls-warn{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:10px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--vo-warning) 45%,transparent);border-radius:var(--ui-radius-sm);background:var(--vo-warning-soft);color:var(--ui-text-1);font-size:var(--vo-text-sm);line-height:1.45}',
            '.vo-ls-warn span{flex:1 1 220px}',
            '.vo-ls-err{margin:2px 0 0;color:var(--vo-danger);font-size:var(--vo-text-xs);font-weight:650}',
            '.vo-ls [aria-invalid="true"]{border-color:var(--vo-danger)!important}',
            '.vo-ls-readonly{margin:0;padding:10px 12px;border-radius:var(--ui-radius-sm);background:var(--vo-surface-3);color:var(--ui-text-2);font-size:var(--vo-text-sm)}',
            '.vo-ls-dim{opacity:.62}',
            // The bar spans the scrolling body's padding (measured into --vo-ls-px / --vo-ls-pb by render()).
            '.vo-ls-bar{position:sticky;bottom:calc(-1 * var(--vo-ls-pb,24px));z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 calc(-1 * var(--vo-ls-px,24px)) calc(-1 * var(--vo-ls-pb,24px));padding:12px var(--vo-ls-px,24px) max(14px,var(--vo-ls-pb,24px) - 10px);border-top:1px solid var(--ui-border-soft);background:var(--vo-surface-1)}',
            '.vo-ls-status{flex:1 1 180px;min-width:0;color:var(--ui-text-3);font-size:var(--vo-text-sm)}',
            '.vo-ls-status.is-dirty{color:var(--ui-text-1);font-weight:650}',
            '.vo-ls-status.is-error{color:var(--vo-danger);font-weight:650}',
            '.vo-ls-status.is-ok{color:var(--vo-success)}',
            '@media (max-width:640px){',
            '.vo-ls-card{padding:14px}',
            '.vo-ls-grid{grid-template-columns:1fr}',
            '.vo-ls-toggle{padding:9px 0}.vo-ls-toggle input{width:20px;height:20px;margin-top:0}',
            '.vo-ls-day{min-width:44px;min-height:44px}',
            '.vo-ls-occ{grid-template-columns:1fr 1fr;padding-bottom:10px;border-bottom:1px solid var(--ui-border-soft)}',
            '.vo-ls-occ>:first-child{grid-column:1/-1}',
            '.vo-ls-bar{gap:6px 10px;padding-top:8px;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}',
            '.vo-ls-status{flex-basis:100%;font-size:var(--vo-text-xs)}',
            '.vo-ls-bar .mm-btn{flex:1 1 0;min-height:44px}',
            '}'
        ].join('\n');
        document.head.appendChild(style);
    }
    function errorFor(path, control) {
        var msg = S.errors[path];
        if (!msg) return null;
        var id = 'vo-ls-err-' + path.replace(/[^a-z0-9]+/gi, '-');
        var p = el('p', 'vo-ls-err', msg);
        p.id = id;
        if (control) {
            control.setAttribute('aria-invalid', 'true');
            control.setAttribute('aria-describedby', id);
        }
        return p;
    }
    function toggle(path, label, hint) {
        var row = el('label', 'vo-ls-toggle');
        var input = el('input');
        input.type = 'checkbox';
        input.checked = get(S.draft, path) !== false;
        input.dataset.field = path;
        input.addEventListener('change', function () { edit(path, input.checked); });
        row.appendChild(input);
        var text = el('span', 'vo-ls-toggle-text');
        text.appendChild(el('b', '', label));
        if (hint) text.appendChild(el('small', '', hint));
        row.appendChild(text);
        return row;
    }
    function field(label, control, path) {
        var wrap = el('label', 'vo-ls-field');
        wrap.appendChild(el('span', '', label));
        wrap.appendChild(control);
        var err = path && errorFor(path, control);
        if (err) wrap.appendChild(err);
        return wrap;
    }
    function timeInput(path) {
        var input = el('input', 'mm-input');
        input.type = 'time';
        input.step = 60;
        input.required = true;
        input.value = get(S.draft, path) || '';
        input.dataset.field = path;
        input.addEventListener('change', function () { edit(path, input.value); });
        return input;
    }
    function select(path, options, value) {
        var s = el('select', 'mm-input');
        s.dataset.field = path;
        options.forEach(function (o) {
            if (o.group) {
                var g = el('optgroup');
                g.label = o.group;
                o.items.forEach(function (it) { g.appendChild(option(it[0], it[1], value)); });
                s.appendChild(g);
            } else s.appendChild(option(o[0], o[1], value));
        });
        return s;
    }
    function option(value, label, current) {
        var o = el('option', '', label);
        o.value = value;
        if (String(value) === String(current)) o.selected = true;
        return o;
    }
    function card(title, hint, feature) {
        var c = el('section', 'vo-ls-card');
        c.dataset.lifeCard = feature || '';
        c.appendChild(el('h3', 'mm-section-title', title));
        if (hint) c.appendChild(el('p', 'vo-ls-hint', hint));
        return c;
    }
    function nowButton(kind, label, feature) {
        var b = el('button', 'mm-btn', label);
        b.type = 'button';
        b.dataset.lifeNow = kind;
        b.dataset.lifeFeature = feature;
        b.addEventListener('click', function () { runNow(kind); });
        return b;
    }

    function buildForm() {
        var d = S.draft;
        var form = el('form', 'vo-ls');
        form.noValidate = true;
        form.setAttribute('aria-label', 'Office life settings');
        form.addEventListener('submit', function (e) { e.preventDefault(); save(); });
        var fs = el('fieldset');
        fs.disabled = S.canSave === false;
        form.appendChild(fs);
        if (S.canSave === false) fs.appendChild(el('p', 'vo-ls-readonly', t('readOnly')));

        // Office life + Calm mode
        var c1 = card(t('lifeTitle'), t('lifeIntro'));
        c1.appendChild(toggle('enabled', t('enabled'), t('enabledHint')));
        c1.appendChild(toggle('calm', t('calm'), t('calmHint')));
        fs.appendChild(c1);
        var rest = fs;

        // Features
        var c2 = card(t('featuresTitle'), null, '*');
        var grid = el('div', 'vo-ls-grid');
        FEATURES.forEach(function (f) { grid.appendChild(toggle('features.' + f[0], f[1], f[2])); });
        c2.appendChild(grid);
        c2.appendChild(numberRow('interns.maxShown', INTERNS_SHOWN_MIN, INTERNS_SHOWN_MAX, t('internsMax'), t('internsMaxUnit')));
        rest.appendChild(c2);

        // Daily stand-up (named by its time of day when it runs)
        var c3 = card(t('standupTitle'), null, 'standup');
        var r3 = el('div', 'vo-ls-row');
        r3.appendChild(field(t('standupTime'), timeInput('standup.time'), 'standup.time'));
        var daysWrap = el('div', 'vo-ls-field');
        var daysLabel = el('span', '', t('standupDays'));
        daysLabel.id = 'vo-ls-days-label';
        daysWrap.appendChild(daysLabel);
        var days = el('div', 'vo-ls-days');
        days.setAttribute('role', 'group');
        days.setAttribute('aria-labelledby', 'vo-ls-days-label');
        var picked = (get(d, 'standup.days') || []).slice();
        DAYS.forEach(function (day) {
            var b = el('button', 'vo-ls-day', day[1]);
            b.type = 'button';
            b.dataset.day = day[0];
            b.setAttribute('aria-label', day[2]);
            b.setAttribute('aria-pressed', picked.indexOf(day[0]) >= 0 ? 'true' : 'false');
            b.addEventListener('click', function () {
                var cur = (get(S.draft, 'standup.days') || []).slice();
                var i = cur.indexOf(day[0]);
                if (i >= 0) cur.splice(i, 1); else cur.push(day[0]);
                cur.sort(function (a, b2) { return a - b2; });
                edit('standup.days', cur);
                render();
            });
            days.appendChild(b);
        });
        daysWrap.appendChild(days);
        r3.appendChild(daysWrap);
        c3.appendChild(r3);
        if (!picked.length) c3.appendChild(el('p', 'vo-ls-note', t('standupNoDays')));
        var r3b = el('div', 'vo-ls-row');
        r3b.appendChild(nowButton('standup', t('standupNow'), 'standup'));
        c3.appendChild(r3b);
        rest.appendChild(c3);

        // Daily Office
        var c4 = card(t('paperTitle'), t('paperHint'), 'newspaper');
        var r4 = el('div', 'vo-ls-row');
        r4.appendChild(field(t('paperTime'), timeInput('newspaper.time'), 'newspaper.time'));
        r4.appendChild(nowButton('paper', t('paperNow'), 'newspaper'));
        c4.appendChild(r4);
        rest.appendChild(c4);

        // Seasons and occasions
        var c5 = card(t('seasonsTitle'), null, 'seasons');
        var g5 = el('div', 'vo-ls-grid');
        SEASON_TOGGLES.forEach(function (s) { g5.appendChild(toggle('seasons.' + s[0], s[1], s[2])); });
        c5.appendChild(g5);
        c5.appendChild(el('h4', '', t('holidaysTitle')));
        var g6 = el('div', 'vo-ls-grid');
        HOLIDAYS.forEach(function (h) { g6.appendChild(toggle('seasons.holidays.' + h[0], h[1], h[2])); });
        c5.appendChild(g6);
        c5.appendChild(el('h4', '', t('customTitle')));
        c5.appendChild(el('p', 'vo-ls-hint', t('customHint')));
        c5.appendChild(buildCustom());
        rest.appendChild(c5);

        // Tournaments
        var c6 = card(t('tournamentsTitle'), null, 'tournaments');
        var freq = select('tournaments.frequency', FREQUENCIES, get(d, 'tournaments.frequency'));
        freq.addEventListener('change', function () { edit('tournaments.frequency', freq.value); });
        var r6 = el('div', 'vo-ls-row');
        r6.appendChild(field(t('frequency'), freq, 'tournaments.frequency'));
        c6.appendChild(r6);
        rest.appendChild(c6);

        // Time zone + history
        rest.appendChild(buildTime());

        form.appendChild(buildBar());
        return form;
    }

    function buildCustom() {
        var wrap = el('div', 'vo-ls-custom');
        var rows = get(S.draft, 'seasons.custom') || [];
        if (!rows.length) wrap.appendChild(el('p', 'vo-ls-note', t('customEmpty')));
        rows.forEach(function (row, i) {
            var base = 'seasons.custom.' + i;
            var line = el('div', 'vo-ls-occ');
            line.dataset.index = i;
            var name = el('input', 'mm-input');
            name.type = 'text';
            name.maxLength = CUSTOM_NAME_MAX;
            name.value = row.name || '';
            name.dataset.field = base + '.name';
            name.setAttribute('autocomplete', 'off');
            name.addEventListener('input', function () { setCustom(i, 'name', name.value, true); });
            line.appendChild(field(t('customName'), name, base + '.name'));
            var md = /^(\d{2})-(\d{2})$/.exec(row.date || '') || [null, '01', '01'];
            var month = select(base + '.date', MONTHS.map(function (m, k) { return [pad(k + 1), m]; }), md[1]);
            var dayCount = MONTH_DAYS[Number(md[1]) - 1] || 31;
            var dayOpts = [];
            for (var k = 1; k <= dayCount; k++) dayOpts.push([pad(k), String(k)]);
            var day = select(base + '.date', dayOpts, md[2]);
            day.dataset.field = base + '.day';
            month.addEventListener('change', function () {
                var dd = Math.min(Number(day.value) || 1, MONTH_DAYS[Number(month.value) - 1]);
                setCustom(i, 'date', month.value + '-' + pad(dd));
            });
            day.addEventListener('change', function () { setCustom(i, 'date', month.value + '-' + day.value); });
            line.appendChild(field(t('customMonth'), month, base + '.date'));
            line.appendChild(field(t('customDay'), day));
            var ic = select(base + '.icon', ICONS, row.icon || 'star');
            ic.addEventListener('change', function () { setCustom(i, 'icon', ic.value); });
            line.appendChild(field(t('customIcon'), ic, base + '.icon'));
            var remove = el('button', 'vo-btn vo-btn--icon vo-btn--ghost');
            remove.type = 'button';
            remove.dataset.removeOccasion = i;
            remove.setAttribute('aria-label', t('customRemove', { name: row.name || ('occasion ' + (i + 1)) }));
            remove.title = remove.getAttribute('aria-label');
            remove.appendChild(icon('close'));
            remove.addEventListener('click', function () {
                var cur = clone(get(S.draft, 'seasons.custom') || []);
                cur.splice(i, 1);
                dropCustomErrors();
                edit('seasons.custom', cur);
                render();
                var next = S.host && S.host.querySelector('[data-add-occasion]');
                if (next) next.focus();
            });
            var holder = el('div', 'vo-ls-field');
            holder.appendChild(el('span', '', ' '));
            holder.appendChild(remove);
            line.appendChild(holder);
            wrap.appendChild(line);
        });
        var add = el('button', 'mm-btn', t('customAdd'));
        add.type = 'button';
        add.dataset.addOccasion = '1';
        add.disabled = rows.length >= CUSTOM_MAX;
        add.addEventListener('click', function () {
            var cur = clone(get(S.draft, 'seasons.custom') || []);
            if (cur.length >= CUSTOM_MAX) return;
            var today = new Date();
            cur.push({ name: '', date: pad(today.getMonth() + 1) + '-' + pad(today.getDate()), icon: 'star' });
            edit('seasons.custom', cur);
            render();
            var names = S.host ? S.host.querySelectorAll('.vo-ls-occ input[type="text"]') : [];
            if (names.length) names[names.length - 1].focus();
        });
        var r = el('div', 'vo-ls-row');
        r.appendChild(add);
        wrap.appendChild(r);
        return wrap;
    }
    function setCustom(i, key, value, typing) {
        var cur = clone(get(S.draft, 'seasons.custom') || []);
        if (!cur[i]) return;
        cur[i][key] = value;
        delete S.errors['seasons.custom.' + i + '.' + key];
        set(S.draft, 'seasons.custom', cur);
        S.message = null;
        if (typing) update(); else render();
    }
    function dropCustomErrors() {
        Object.keys(S.errors).forEach(function (k) { if (k.indexOf('seasons.custom.') === 0) delete S.errors[k]; });
    }

    function buildTime() {
        var d = S.draft;
        var c = card(t('timeTitle'), null, '*');
        var zones = zoneList();
        var groups = {}, order = [];
        zones.forEach(function (z) {
            var g = z.indexOf('/') > 0 ? z.slice(0, z.indexOf('/')) : 'Other';
            if (!groups[g]) { groups[g] = []; order.push(g); }
            groups[g].push([z, z.replace(/_/g, ' ')]);
        });
        var serverLabel = !(S.base && S.base.timeZone) && S.serverZone
            ? t('zoneServer', { zone: S.serverZone }) : t('zoneServerUnknown');
        var opts = [['', serverLabel]].concat(order.map(function (g) { return { group: g, items: groups[g] }; }));
        var zoneSel = select('timeZone', opts, d.timeZone || '');
        zoneSel.addEventListener('change', function () { edit('timeZone', zoneSel.value); render(); });
        var r = el('div', 'vo-ls-row');
        r.appendChild(field(t('zone'), zoneSel, 'timeZone'));
        c.appendChild(r);
        var office = officeZone(d);
        var time = nowIn(office);
        var note = el('p', 'vo-ls-note', t('zoneUses') + (time ? ' ' + t('zoneNow', { time: time, zone: office }) : ''));
        note.dataset.lifeZoneNote = office;
        c.appendChild(note);
        var mine = browserZone();
        if (mine && mine !== office) {
            var warn = el('div', 'vo-ls-warn');
            warn.setAttribute('role', 'note');
            warn.dataset.lifeZoneWarn = mine;
            warn.appendChild(el('span', '', t('zoneDiffers', { browser: mine, office: office })));
            if (zoneOk(mine)) {
                var use = el('button', 'mm-btn', t('zoneUse', { zone: mine }));
                use.type = 'button';
                use.addEventListener('click', function () { edit('timeZone', mine); render(); focusField('timeZone'); });
                warn.appendChild(use);
            }
            c.appendChild(warn);
        }
        c.appendChild(numberRow('journal.retentionDays', RETENTION_MIN, RETENTION_MAX, t('retention'), t('retentionUnit')));
        return c;
    }

    // A whole-number setting: the input, its label and a short note after it.
    function numberRow(path, min, max, label, note) {
        var input = el('input', 'mm-input');
        input.type = 'number';
        input.min = min;
        input.max = max;
        input.step = 1;
        input.inputMode = 'numeric';
        input.style.width = '6em';
        input.value = get(S.draft, path);
        input.dataset.field = path;
        input.addEventListener('input', function () {
            var v = input.value === '' ? NaN : Number(input.value);
            set(S.draft, path, isFinite(v) ? v : input.value);
            delete S.errors[path];
            S.message = null;
            update();
        });
        var row = el('div', 'vo-ls-row');
        row.appendChild(field(label, input, path));
        var unit = el('span', 'vo-ls-note', note);
        unit.style.margin = '0 0 10px';
        row.appendChild(unit);
        return row;
    }

    function buildBar() {
        var bar = el('div', 'vo-ls-bar');
        var status = el('div', 'vo-ls-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        bar.appendChild(status);
        var discard = el('button', 'mm-btn', t('discard'));
        discard.type = 'button';
        discard.dataset.lifeDiscard = '1';
        discard.addEventListener('click', reset);
        bar.appendChild(discard);
        var saveBtn = el('button', 'mm-btn mm-btn-primary', t('save'));
        saveBtn.type = 'submit';
        saveBtn.dataset.lifeSave = '1';
        bar.appendChild(saveBtn);
        return bar;
    }

    // Light refresh: Save bar, "now" buttons, dims (no rebuild, so typing keeps focus).
    function update() {
        var host = S.host;
        if (!host || !host.querySelector('.vo-ls')) return;
        var isDirty = dirty();
        var status = host.querySelector('.vo-ls-status');
        var saveBtn = host.querySelector('[data-life-save]');
        var discard = host.querySelector('[data-life-discard]');
        var msg = S.message;
        if (status) {
            var text = S.saving ? t('saving') : msg && (msg.kind === 'error' || !isDirty) ? msg.text : isDirty ? t('unsaved') : t('saved');
            status.textContent = text;
            status.className = 'vo-ls-status' + (msg && msg.kind === 'error' && !S.saving ? ' is-error'
                : isDirty ? ' is-dirty' : msg && msg.kind === 'ok' ? ' is-ok' : '');
        }
        if (saveBtn) saveBtn.disabled = !isDirty || S.saving || !ready() || S.canSave === false;
        if (discard) discard.disabled = !isDirty || S.saving;
        host.querySelectorAll('[data-life-now]').forEach(function (b) {
            var why = nowBlocked(b.dataset.lifeFeature);
            b.disabled = !!why || !!S.busy[b.dataset.lifeNow];
            b.title = why;
        });
        // Parts that do nothing with the current switches look dimmed (still editable).
        var feats = (S.draft && S.draft.features) || {};
        var off = !!(S.draft && S.draft.enabled === false);
        host.querySelectorAll('[data-life-card]').forEach(function (c) {
            var f = c.dataset.lifeCard;
            c.classList.toggle('vo-ls-dim', !!f && (off || (f !== '*' && feats[f] === false)));
        });
        host.classList.toggle('vo-ls-is-dirty', isDirty);
        // One save model (v0.10 UI-12): the bar shows only while there is something to save or an error to read.
        host.classList.toggle('vo-ls-bar-on', isDirty || !!S.saving || !!(msg && msg.kind === 'error'));
        try { root.dispatchEvent(new CustomEvent('vo:life-settings-dirty', { detail: { dirty: isDirty } })); } catch (e) {}
    }
    function render() {
        var host = S.host;
        if (!host) return;
        ensureStyle();
        var active = document.activeElement;
        var focusKey = active && host.contains(active) ? (active.dataset.field || active.dataset.day && 'day:' + active.dataset.day) : null;
        host.textContent = '';
        if (!ready()) {
            var L = life();
            host.appendChild(el('p', 'mm-hint', L && L.status && L.status() === 'off' ? t('unavailable') : t('loading')));
            return;
        }
        var form = buildForm();
        var scroller = host.closest('.main-menu-body');
        if (scroller && root.getComputedStyle) {
            var cs = root.getComputedStyle(scroller);
            form.style.setProperty('--vo-ls-px', (parseFloat(cs.paddingRight) || 0) + 'px');
            form.style.setProperty('--vo-ls-pb', (parseFloat(cs.paddingBottom) || 0) + 'px');
        }
        host.appendChild(form);
        update();
        if (focusKey) {
            var again = focusKey.indexOf('day:') === 0
                ? host.querySelector('.vo-ls-day[data-day="' + focusKey.slice(4) + '"]')
                : host.querySelector('[data-field="' + focusKey.replace(/"/g, '') + '"]');
            if (again) again.focus();
        }
    }
    function focusField(path) {
        if (!S.host) return;
        var c = S.host.querySelector('[data-field="' + String(path).replace(/"/g, '') + '"]');
        if (c) { c.focus(); if (c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }); }
    }

    function mount(container) {
        if (!container) return null;
        var fresh = S.host !== container;
        S.host = container;
        container.classList.add('vo-life-settings');
        if (ready() && (fresh || !S.base || !dirty())) load(savedSettings());
        render();
        // Permission is asked each time the section opens (a passcode may have been set meanwhile).
        access().then(function (st) {
            var can = st ? !!st.canManage : null;
            if (can === S.canSave) return;
            S.canSave = can;
            render();
        });
        return container;
    }

    // ---- wiring ----
    root.addEventListener('vo:life-settings', function (e) {
        syncMenu();
        if (!S.host) return;
        var next = e && e.detail && e.detail.settings;
        if (!S.base) { load(next || savedSettings()); render(); return; }
        if (rebase(next || savedSettings())) render(); else update();
    });
    root.addEventListener('vo:life-state', function () {
        syncMenu();
        maybeAdoptZone();
    });
    root.addEventListener('vo:life-live', syncMenu);
    function boot() {
        syncMenu();
        if (ready()) maybeAdoptZone();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    root.VOLifeSettings = {
        mount: mount,
        dirty: dirty,
        reset: reset,
        save: save,
        runNow: runNow,
        browserZone: browserZone,
        text: TEXT,
        _diff: diff,
        _validate: validate,
        _debug: function () {
            return { base: clone(S.base), draft: clone(S.draft), dirty: dirty(), saving: S.saving, canSave: S.canSave,
                errors: clone(S.errors), serverZone: S.serverZone, officeZone: officeZone(S.draft || S.base || {}),
                browserZone: browserZone(), adopt: clone(A), mounted: !!S.host };
        }
    };
})(window);
