// Office life: Seasons and occasions (feature 8, design .work/life/design.md 3.8).
// Date-based decor drawn into the cached static layer (zero per-frame cost):
// seasons follow the weather location's hemisphere (no location or the tropics
// = no seasonal decor), generic holidays (each switchable), custom occasions,
// a Friday treat on the kitchen spot, umbrellas / a boot mat by the front from
// the weather feed, and office birthdays where the roster knows createdAt.
// The layer is rebuilt only when the decor signature changes (checked every
// few seconds), never per frame. Zero inference: dates, settings and feeds only.
(function (root) {
    'use strict';

    // ---- pure rules (also used by tests through window.VOLifeSeasons) ----
    var TROPIC = 23.44;
    var RAIN = { drizzle: 1, light_rain: 1, rain: 1, heavy_rain: 1, thunderstorm: 1, sleet: 1 };
    var SNOW = { light_snow: 1, snow: 1, snow_storm: 1 };
    var HOLIDAYS = {
        newYear: function (m, d) { return (m === 12 && d === 31) || (m === 1 && d === 1); },
        valentines: function (m, d) { return m === 2 && d === 14; },
        earthDay: function (m, d) { return m === 4 && d === 22; },
        halloween: function (m, d) { return m === 10 && d === 31; },
        yearEndLights: function (m, d) { return m === 12 && d >= 15 && d <= 31; }
    };
    var ICONS = { cake: 1, star: 1, heart: 1, balloon: 1, flag: 1 };
    var NORTH = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
    var FLIP = { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' };

    function leap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
    // Meteorological season for a month at a latitude; null = no seasonal decor.
    function season(month, lat) {
        if (lat === null || lat === undefined || lat === '' || typeof lat === 'boolean') return null;
        lat = Number(lat);
        if (!isFinite(lat) || Math.abs(lat) < TROPIC) return null;
        var s = NORTH[(Number(month) || 0) - 1];
        if (!s) return null;
        return lat > 0 ? s : FLIP[s];
    }
    function holidaysOn(p, cfg) {
        cfg = cfg || {};
        return Object.keys(HOLIDAYS).filter(function (id) { return cfg[id] !== false && HOLIDAYS[id](p.month, p.day); });
    }
    function clip(s, n) {
        s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, Math.max(1, n - 1)).trimEnd() + '…' : s;
    }
    // Custom occasions on this date. 02-29 falls on 02-28 in other years.
    function customOn(p, list) {
        var out = [];
        (Array.isArray(list) ? list : []).slice(0, 12).forEach(function (o) {
            if (!o || typeof o !== 'object') return;
            var m = /^(\d{2})-(\d{2})$/.exec(String(o.date || ''));
            var name = clip(o.name, 24);
            if (!m || !name) return;
            var mm = +m[1], dd = +m[2];
            if (mm === 2 && dd === 29 && !leap(p.year)) dd = 28;
            if (mm === p.month && dd === p.day) out.push({ name: name, icon: ICONS[o.icon] ? o.icon : 'star' });
        });
        return out;
    }
    function fridayTreat(p) { return p.weekday === 5 && p.hour >= 8 && p.hour < 17; }
    function weatherKind(cond) {
        cond = String(cond || '').toLowerCase();
        return RAIN[cond] ? 'rain' : SNOW[cond] ? 'snow' : '';
    }
    // Everything the static layer shows for one moment.
    // o: {parts, lat, condition, seasons (settings.seasons), present, birthdays: [{key, years}]}
    function plan(o) {
        var p = o.parts, s = o.seasons || {};
        var out = { season: null, holidays: [], custom: [], friday: false, weather: '', umbrellas: 0, birthdays: [] };
        if (!p) return out;
        if (s.decor !== false) out.season = season(p.month, o.lat);
        out.holidays = holidaysOn(p, s.holidays);
        out.custom = customOn(p, s.custom);
        out.friday = s.fridayTreat !== false && fridayTreat(p);
        if (s.rain !== false) {
            out.weather = weatherKind(o.condition);
            if (out.weather === 'rain') out.umbrellas = Math.max(0, Math.min(6, o.present || 0));
        }
        if (s.birthdays !== false) out.birthdays = (o.birthdays || []).slice(0, 24);
        return out;
    }
    var rules = { TROPIC: TROPIC, season: season, holidaysOn: holidaysOn, customOn: customOn, fridayTreat: fridayTreat,
        weatherKind: weatherKind, plan: plan, leap: leap };
    root.VOLifeSeasons = rules;
    if (typeof module !== 'undefined' && module.exports) module.exports = rules;

    var life = root.VOLife;
    if (!life || typeof life.feature !== 'function') return;

    life.addText({ decorTitleBirthday: 'Office birthday', decorMore: '+{n}', decorHalloween: 'Happy Halloween',
        decorNewYear: 'Happy New Year', decorValentines: 'Happy Valentine\'s Day', decorEarthDay: 'Happy Earth Day',
        decorYearEnd: 'Happy Holidays' });
    var CHECK_MS = 5000;
    var TINT = { cake: '#f48fb1', star: '#ffd54f', heart: '#ef5350', balloon: '#42a5f5', flag: '#66bb6a' };
    var HOLIDAY_BANNERS = [
        { id: 'halloween', text: 'decorHalloween', icon: 'decorPumpkin', tint: '#ef6c00' },
        { id: 'newYear', text: 'decorNewYear', icon: 'star', tint: '#ffd54f' },
        { id: 'valentines', text: 'decorValentines', icon: 'heart', tint: '#ec407a' },
        { id: 'earthDay', text: 'decorEarthDay', icon: 'decorSeedling', tint: '#66bb6a' },
        { id: 'yearEndLights', text: 'decorYearEnd', icon: 'star', tint: '#e53935' }
    ];
    // Seasonal props are drawn at 2x so they read at the fit view (A14).
    var BIG = { scale: 2 };
    var S = {
        cur: plan({}), sig: '', checkedAt: 0, birthdays: [], years: {}, hats: {}, banner: null, bannerRect: null,
        dayFetch: 0, statics: 0, board: null
    };

    function H() { return life.host(); }
    function SP() { return life.sprites(); }
    function keyOf(a) { return a && (a.statusKey || a.id); }

    // ---- extra pixel props (registered once in the shared sprite cache) ----
    var registered = false;
    function register() {
        var sp = SP();
        if (registered || !sp || !sp.register) return;
        registered = true;
        var B = sp.bitmap;
        sp.register('decorPumpkin', { w: 11, h: 9, paint: function (g) {
            B(g, ['.....G.....', '....GG.....', '.OOOOOOOOO.', 'OOoOOoOOoOO', 'OOoKOoOKoOO', 'OOoOOoOOoOO', 'OOoOKKKOoOO', '.OOOOOOOOO.', '..OOOOOOO..'],
                { G: '#558b2f', O: '#fb8c00', o: '#ef6c00', K: '#3e2723' });
        } });
        sp.register('decorCoatRack', { w: 12, h: 26, paint: function (g) {
            B(g, ['.....KK.....', '.K..KKKK..K.', '.KKKKKKKKKK.', '.RR..KK..BB.', 'RRRR.KK.BBBB', 'RRRR.KK.BBBB', 'RRRR.KK.BBBB', 'RRRR.KK.BBBB',
                'RRR..KK..BBB', '.....KK.....', '.....KK.....', '.....KK.....', '.....KK.....', '.....KK.....', '.....KK.....', '.....KK.....',
                '.....KK.....', '.....KK.....', '.....KK.....', '.....KK.....', '.....KK.....', '.....KK.....', '....KKKK....', '..KKKKKKKK..',
                '.KK......KK.', '............'], { K: '#5d4037', R: '#c62828', B: '#1565c0' });
        } });
        sp.register('decorFan', { w: 9, h: 11, paint: function (g) {
            B(g, ['..WWWWW..', '.WBWWWBW.', 'WWWBWBWWW', 'WWWWKWWWW', 'WWWBWBWWW', '.WBWWWBW.', '..WWWWW..', '....K....', '....K....', '..KKKKK..', '.KKKKKKK.'],
                { W: '#e3f2fd', B: '#90caf9', K: '#546e7a' });
        } });
        sp.register('decorSeedling', { w: 7, h: 9, paint: function (g) {
            B(g, ['.G...G.', 'GGG.GGG', '.GG.GG.', '...G...', '...G...', '.TTTTT.', '.TSSST.', '.TTTTT.', '..TTT..'],
                { G: '#66bb6a', T: '#a1887f', S: '#4e342e' });
        } });
        sp.register('decorBootMat', { w: 26, h: 10, paint: function (g) {
            B(g, ['MMMMMMMMMMMMMMMMMMMMMMMMMM', 'MmmmmmmmmmmmmmmmmmmmmmmmmM', 'Mm.KK..KK.......KK..KK..mM', 'Mm.KKK.KKK......KKK.KKK.mM', 'Mm.KKK.KKK......KKK.KKK.mM',
                'Mm.KKK.KKK......KKK.KKK.mM', 'Mm.WKK.WKK......WKK.WKK.mM', 'Mm.WWW.WWW......WWW.WWW.mM', 'MmmmmmmmmmmmmmmmmmmmmmmmmM', 'MMMMMMMMMMMMMMMMMMMMMMMMMM'],
                { M: '#455a64', m: '#546e7a', K: '#3e2723', W: '#eceff1' });
        } });
        sp.register('decorPuddle', { w: 16, h: 4, paint: function (g) {
            B(g, ['...LLLLLLLL.....', '.LLLWLLLLLLLLL..', 'LLLLLLLLLWLLLLLL', '..LLLLLLLLLLL...'], { L: 'rgba(129,212,250,0.55)', W: 'rgba(255,255,255,0.8)' });
        } });
    }

    // ---- inputs ----
    function presentCount() {
        var h = H(), n = 0;
        ((h && h.agents && h.agents()) || []).forEach(function (a) {
            if (a && !a._lifeExtra && String(a._statusState || a.state || '') !== 'offline') n++;
        });
        return n;
    }
    function compute() {
        var h = H(), w = (h && h.weather && h.weather()) || {};
        var st = life.settings();
        return plan({
            parts: life.officeParts(), lat: w.lat, condition: w.condition, seasons: st.seasons || {}, present: presentCount(),
            birthdays: S.birthdays.map(function (k) { return { key: k, years: S.years[k] || 0 }; })
        });
    }
    // Rebuild the static layer only when what it shows changed.
    function refresh(force) {
        var p = compute();
        var sig = JSON.stringify(p);
        S.checkedAt = Date.now();
        if (!force && sig === S.sig) return false;
        S.cur = p;
        S.sig = sig;
        syncHats();
        S.banner = bannerFor(p);
        var h = H();
        if (h && h.invalidateStatic) h.invalidateStatic();
        return true;
    }
    function readToday(snapshot) {
        var t = (snapshot && snapshot.today) || {};
        S.birthdays = Array.isArray(t.birthdays) ? t.birthdays.map(String).slice(0, 24) : [];
        S.years = t.birthdayYears && typeof t.birthdayYears === 'object' ? t.birthdayYears : {};
    }
    function fetchToday() {
        // A new office day: today's birthdays come from /state (one request per day).
        if (typeof fetch !== 'function') return;
        var at = S.dayFetch = Date.now();
        fetch('/api/office-life/state', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { if (d && d.ok === true && at === S.dayFetch) { readToday(d); refresh(true); } })
            .catch(function () {});
    }

    // ---- party hats (birthday agents; everyone on New Year) ----
    function decorApi() { return root.VOLifeDecor || null; }
    function hatTint(key) {
        var h = 0, s = String(key || '');
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return ['#e53935', '#8e24aa', '#1e88e5', '#43a047', '#fdd835', '#fb8c00'][Math.abs(h) % 6];
    }
    function drawHat(ctx, ch) {
        if (!life.isOn('seasons') || !S.hats[keyOf(ch)]) return;
        var c = hatTint(keyOf(ch));
        // Cone on the crown (head is x -12..12, y -38..-20), under the name tag (-68..-54).
        ctx.fillStyle = c;
        ctx.fillRect(-1, -52, 2, 2);
        ctx.fillRect(-2, -50, 4, 2);
        ctx.fillRect(-3, -48, 6, 2);
        ctx.fillRect(-4, -46, 8, 2);
        ctx.fillRect(-5, -44, 10, 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-2, -48, 1, 1); ctx.fillRect(1, -45, 1, 1); ctx.fillRect(-3, -44, 1, 1);
        ctx.fillStyle = '#ffeb3b';
        ctx.fillRect(-1, -54, 2, 2);
    }
    function syncHats() {
        var D = decorApi(), h = H();
        var want = {};
        if (life.isOn('seasons')) {
            var all = S.cur.holidays.indexOf('newYear') >= 0;
            ((h && h.agents && h.agents()) || []).forEach(function (a) {
                var k = keyOf(a);
                if (k && !a._lifeExtra && (all || S.cur.birthdays.some(function (b) { return b.key === k; }))) want[k] = a;
            });
        }
        ((h && h.agents && h.agents()) || []).forEach(function (a) {
            var k = keyOf(a);
            if (!k || a._lifeExtra) return;
            if (want[k]) {
                if (D) D.add(a, 'decorHat', drawHat);
                else if (!a._lifeDecorate) a._lifeDecorate = drawHat;
            } else if (D) D.remove(a, 'decorHat');
            else if (a._lifeDecorate === drawHat) a._lifeDecorate = null;
        });
        S.hats = {};
        Object.keys(want).forEach(function (k) { S.hats[k] = true; });
    }

    // ---- notice-board banner text (birthday first, then a custom occasion) ----
    function nameOf(key) {
        var a = H() && H().agent(key);
        return a && a.name ? clip(a.name, 24) : '';
    }
    function bannerFor(p) {
        var items = [];
        p.birthdays.forEach(function (b) {
            var n = nameOf(b.key);
            if (!n) return;
            var y = Math.max(1, Math.floor(Number(b.years) || 1));
            items.push({ text: life.t('birthday', { n: y, suffix: life.ordinal(y), name: n }), icon: 'cake', tint: TINT.cake });
        });
        p.custom.forEach(function (c) { items.push({ text: c.name, icon: c.icon === 'balloon' ? 'balloon' : c.icon, tint: TINT[c.icon] || TINT.star }); });
        // A wall banner per holiday (A14), after people's own days.
        HOLIDAY_BANNERS.forEach(function (b) {
            if ((p.holidays || []).indexOf(b.id) >= 0) items.push({ text: life.t(b.text), icon: b.icon, tint: b.tint, holiday: b.id });
        });
        if (!items.length) return null;
        return { text: items[0].text, icon: items[0].icon, tint: items[0].tint, more: items.length - 1 };
    }

    // ---- placement helpers (world space) ----
    function frontAnchor(h, spots) {
        var f = spots && spots.front;
        if (!f) return null;
        if (f.item) return { x: f.item.x, y: f.item.y + 10, half: 60, desk: true };
        return { x: f.x, y: f.y - 30, half: 64, desk: false };
    }
    // Floor slots beside the front (left/right, outward), snapped to free floor.
    function frontSlots(h, a) {
        var out = [];
        [-1, 1, -1, 1].forEach(function (side, i) {
            var x = a.x + side * (a.half + (i >= 2 ? 36 : 0)), y = a.y;
            var p = h.walkable && h.walkable(x, y) ? { x: x, y: y } : (h.nearestWalkable && h.nearestWalkable(x, y, 2));
            out.push(p || { x: x, y: y });
        });
        return out;
    }
    function deskItemFor(h, a) {
        var d = a && a.desk;
        if (!d) return null;
        var best = null, bd = 90 * 90;
        (h.furniture('desk') || []).concat(h.furniture('bossDesk') || []).forEach(function (f) {
            var dd = (f.x - d.x) * (f.x - d.x) + (f.y - d.y) * (f.y - d.y);
            if (dd < bd) { bd = dd; best = f; }
        });
        return best;
    }
    function itemsOf(h, types) {
        var out = [];
        types.forEach(function (t) { (h.furniture(t) || []).forEach(function (f) { out.push(f); }); });
        return out;
    }
    // Window glass rect as drawn (window 60x40; weather window 36x44 inside a 4 px sill).
    function windowRect(f) {
        return f.type === 'interactiveWindow' ? { x: f.x - 4, y: f.y - 4, w: 44, h: 52 } : { x: f.x, y: f.y, w: 60, h: 40 };
    }
    function boardRects(h, spots) {
        var out = [];
        if (spots.noticeBoard) out.push({ x: spots.noticeBoard.x, y: spots.noticeBoard.y, w: spots.noticeBoard.w, h: spots.noticeBoard.h });
        (h.furniture('whiteboard') || []).forEach(function (f) {
            if (spots.noticeBoard && spots.noticeBoard.item === f) return;
            out.push({ x: f.x, y: f.y, w: 28, h: 40 });
        });
        return out;
    }

    // ---- static drawing (world space, once per layer rebuild) ----
    function px(ctx, c, x, y, w, hh) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, hh); }
    function blossoms(ctx, f, tall) {
        var pts = tall ? [[2, -4], [9, -11], [14, -2], [0, 6], [16, 4], [6, 2]] : [[2, -1], [8, -6], [13, 0], [5, 5], [11, 6], [16, 3]];
        pts.forEach(function (q, i) { px(ctx, i % 2 ? '#f8bbd0' : '#fce4ec', f.x + q[0], f.y + q[1], 2, 2); px(ctx, '#f06292', f.x + q[0] + 1, f.y + q[1] + 1, 1, 1); });
    }
    function autumnLeaves(ctx, f, tall) {
        var pts = tall ? [[1, -2], [8, -10], [13, -13], [15, -3], [-1, 5]] : [[1, -2], [7, -6], [13, 1], [4, 4], [15, 4]];
        var cs = ['#ef6c00', '#fbc02d', '#c62828', '#ff8f00', '#e65100'];
        pts.forEach(function (q, i) { px(ctx, cs[i % cs.length], f.x + q[0], f.y + q[1], 3, 2); });
        px(ctx, '#ef6c00', f.x + (tall ? 22 : 18), f.y + (tall ? 46 : 22), 2, 1);
        px(ctx, '#c62828', f.x - 3, f.y + (tall ? 47 : 23), 2, 1);
    }
    function snowSill(ctx, r) {
        px(ctx, '#ffffff', r.x - 2, r.y + r.h - 1, r.w + 4, 3);
        for (var i = 0; i < r.w; i += 7) px(ctx, '#ffffff', r.x + i + 1, r.y + r.h - 3, 4, 2);
        px(ctx, '#e3f2fd', r.x - 2, r.y + r.h + 2, r.w + 4, 1);
        for (var j = 0; j < 4; j++) px(ctx, 'rgba(255,255,255,0.85)', r.x + 6 + j * (r.w / 4), r.y + 5 + (j % 2) * 9, 2, 2);
    }
    function sunGlint(ctx, r) {
        px(ctx, 'rgba(255,241,118,0.9)', r.x + r.w - 9, r.y + 4, 3, 3);
        px(ctx, 'rgba(255,249,196,0.85)', r.x + r.w - 12, r.y + 5, 2, 1);
        px(ctx, 'rgba(255,249,196,0.85)', r.x + r.w - 7, r.y + 9, 1, 2);
        px(ctx, 'rgba(255,255,255,0.35)', r.x + 4, r.y + r.h - 8, 10, 2);
    }
    // A swag along the top of a wall item: pennants (garland) or bulbs (lights).
    function swag(ctx, r, kind, glow) {
        var cs = kind === 'lights' ? ['#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#e040fb'] : ['#e53935', '#fdd835', '#1e88e5', '#43a047', '#8e24aa'];
        var x0 = r.x - 3, x1 = r.x + r.w + 3, n = Math.max(3, Math.round((x1 - x0) / 8));
        for (var i = 0; i <= n; i++) {
            var t = i / n, x = x0 + (x1 - x0) * t, sag = Math.round(Math.sin(t * Math.PI) * 4);
            px(ctx, '#37474f', x, r.y - 4 + sag, 2, 1);
            if (i > 0 && i < n) {
                var c = cs[i % cs.length];
                if (kind === 'lights') {
                    // Bigger bulbs (A14), each glowing at night.
                    px(ctx, '#263238', x, r.y - 4 + sag, 3, 1);
                    px(ctx, c, x, r.y - 3 + sag, 3, 4); px(ctx, 'rgba(255,255,255,0.75)', x, r.y - 3 + sag, 1, 1);
                    if (glow) glow.push({ x: x + 1.5, y: r.y - 1 + sag, r: 7, color: hexRgb(c), twinkle: true });
                }
                else { px(ctx, c, x - 1, r.y - 3 + sag, 4, 2); px(ctx, c, x, r.y - 1 + sag, 2, 2); }
            }
        }
    }
    function hexRgb(c) { var n = parseInt(String(c).slice(1), 16); return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255); }
    function ribbon(ctx, r, tint) {
        px(ctx, '#6d4c41', r.x - 4, r.y - 7, 2, 7);
        px(ctx, '#6d4c41', r.x + r.w + 2, r.y - 7, 2, 7);
        px(ctx, tint, r.x - 2, r.y - 7, r.w + 4, 5);
        px(ctx, 'rgba(255,255,255,0.45)', r.x - 2, r.y - 7, r.w + 4, 1);
        for (var x = r.x + 2; x < r.x + r.w - 1; x += 6) px(ctx, '#ffffff', x, r.y - 5, 2, 1);
    }

    function drawStatic(ctx, mode) {
        var h = H(), sp = SP();
        if (!h || !sp || (h.editMode && h.editMode())) return;
        register();
        var p = S.cur, spots = h.spots() || {};
        S.statics++;
        S.board = spots.noticeBoard ? { x: spots.noticeBoard.x, y: spots.noticeBoard.y, w: spots.noticeBoard.w, h: spots.noticeBoard.h } : null;
        var plants = itemsOf(h, ['plant', 'tallPlant']);
        var windows = itemsOf(h, ['window', 'interactiveWindow']).slice(0, 24);
        var anchor = frontAnchor(h, spots);
        var slots = anchor ? frontSlots(h, anchor) : [];
        var used = 0;
        function slot() { return slots[used++] || null; }
        var glow = [];

        // Seasons
        if (p.season === 'spring') plants.forEach(function (f) { blossoms(ctx, f, f.type === 'tallPlant'); });
        if (p.season === 'autumn') {
            plants.forEach(function (f) { autumnLeaves(ctx, f, f.type === 'tallPlant'); });
        }
        if (p.season === 'summer') windows.forEach(function (f, i) {
            var r = windowRect(f);
            sunGlint(ctx, r);
            if (i < 3) sp.draw(ctx, 'decorFan', r.x + r.w - 8, r.y + r.h - 8, BIG);
        });
        if (p.season === 'winter') {
            windows.forEach(function (f) { snowSill(ctx, windowRect(f)); });
            var rack = slot();
            if (rack) sp.draw(ctx, 'decorCoatRack', rack.x, rack.y - 26, BIG);
        }

        // Holidays
        var walls = windows.map(windowRect).concat(boardRects(h, spots));
        if (p.holidays.indexOf('yearEndLights') >= 0) walls.forEach(function (r) { swag(ctx, r, 'lights', glow); });
        if (p.holidays.indexOf('newYear') >= 0) walls.forEach(function (r) { swag(ctx, { x: r.x, y: r.y + 4, w: r.w, h: r.h }, 'garland'); });
        if (p.holidays.indexOf('valentines') >= 0) boardRects(h, spots).forEach(function (r) {
            sp.draw(ctx, 'heart', r.x + 6, r.y + r.h - 6);
            sp.draw(ctx, 'heart', r.x + r.w - 7, r.y + 7, { tint: '#f06292' });
            sp.draw(ctx, 'heart', r.x + r.w / 2, r.y + r.h / 2 + 2, { tint: '#ec407a' });
        });
        if (p.holidays.indexOf('earthDay') >= 0) (h.furniture('desk') || []).slice(0, 40).forEach(function (f) {
            sp.draw(ctx, 'decorSeedling', f.x - 27, f.y - 18, BIG);
        });
        if (p.holidays.indexOf('halloween') >= 0 && anchor) {
            var a1 = slot(), a2 = slot();
            // A cluster of 2x pumpkins either side of the front, candles glowing at night.
            [[a1, 8, 0], [a2, -12, 0], [a2, 13, 7]].forEach(function (q) {
                if (!q[0]) return;
                var x = q[0].x + q[1], y = q[0].y + q[2];
                sp.draw(ctx, 'decorPumpkin', x, y, BIG);
                glow.push({ x: x, y: y + 1, r: 16, color: '255,170,60', twinkle: true });
            });
        }

        // Custom occasions: balloons at the front.
        if (p.custom.length && anchor) {
            var b = slot();
            if (b) p.custom.slice(0, 3).forEach(function (c, i) {
                var tint = TINT[c.icon] || TINT.star;
                px(ctx, '#90a4ae', b.x - 8 + i * 9, b.y - 22, 1, 22);
                sp.draw(ctx, 'balloon', b.x - 8 + i * 9, b.y - 30 - (i % 2) * 6, { tint: tint, scale: 2 });
            });
        }

        // Birthdays: a cake on the desk.
        p.birthdays.forEach(function (bd) {
            var a = h.agent(bd.key);
            if (!a || a._lifeExtra) return;
            var item = deskItemFor(h, a);
            if (item) sp.draw(ctx, 'cake', item.x + 25, item.y - 12);
            else if (a.desk) sp.draw(ctx, 'cake', a.desk.x + 24, a.desk.y - 8);
        });
        // Banner over the notice board, or on the top wall when there is none
        // (text in screen space, see drawScreen).
        if (!S.board && S.banner) S.board = topWallBoard(h);
        if (S.banner && S.board) ribbon(ctx, S.board, S.banner.tint);

        // Friday treat on the kitchen spot.
        if (p.friday && spots.kitchen) sp.draw(ctx, 'donutBox', spots.kitchen.x, spots.kitchen.y);

        // Weather by the front: umbrellas in the rain, a boot mat in the snow.
        if (p.weather === 'rain' && p.umbrellas > 0 && anchor) {
            var u = slot();
            if (u) { sp.draw(ctx, 'decorPuddle', u.x + 8, u.y + 14, BIG); sp.draw(ctx, 'umbrellaStand', u.x, u.y - 8, { count: p.umbrellas, scale: 2 }); }
        }
        if (p.weather === 'snow' && spots.front) sp.draw(ctx, 'decorBootMat', spots.front.x, spots.front.y + 6, BIG);
        if (root.VOOfficeGlow) root.VOOfficeGlow.set('decor', glow);
    }
    // A strip of the top wall, centred, for the banner when no notice board exists.
    function topWallBoard(h) {
        var v = h.view ? h.view() : null, ww = (v && v.worldW) || 1000, wallH = (h.wallHeight && h.wallHeight()) || 90;
        return { x: Math.round(ww / 2 - 70), y: Math.round(wallH * 0.36), w: 140, h: 24 };
    }

    // ---- screen-space banner label above the notice board ----
    function drawScreen(ctx) {
        S.bannerRect = null;
        var h = H(), sp = SP();
        if (!S.banner || !h || !sp || (h.editMode && h.editMode())) return;
        // Board position cached by drawStatic (runs on every layout or decor change), not per frame.
        var nb = S.board;
        if (!nb) return;
        var c = h.worldToCanvas(nb.x + nb.w / 2, nb.y - 8), v = h.view ? h.view() : null;
        if (v && (c.x < -40 || c.y < -10 || c.x > v.w + 40 || c.y > v.h + 40)) return;
        var text = S.banner.text + (S.banner.more > 0 ? ' ' + life.t('decorMore', { n: S.banner.more }) : '');
        S.bannerRect = sp.label(ctx, text, c.x, c.y - 2, { kind: 'neutral', icon: S.banner.icon, iconOpts: { tint: S.banner.tint }, maxW: h.compact && h.compact() ? 200 : 260 });
    }

    life.feature('decor', {
        setting: 'seasons',
        order: 60,
        init: function () { register(); },
        onState: function (snapshot) { readToday(snapshot); refresh(true); },
        onSettings: function () { S.checkedAt = 0; refresh(false); syncHats(); },
        onDay: function () { refresh(true); fetchToday(); },
        onRoster: function () { syncHats(); S.banner = bannerFor(S.cur); var h = H(); if (h && h.invalidateStatic) h.invalidateStatic(); },
        update: function (t) { if ((t || Date.now()) - S.checkedAt >= CHECK_MS) refresh(false); },
        drawStatic: drawStatic,
        drawScreen: drawScreen,
        reset: function (reason) {
            if (reason === 'disabled' || reason === 'unavailable') {
                S.cur = plan({}); S.sig = ''; S.banner = null; syncHats(); if (root.VOOfficeGlow) root.VOOfficeGlow.clear('decor');
            }
        }
    });

    // Debug / tests: the current plan and how many static draws ran.
    rules._state = function () { return { plan: JSON.parse(JSON.stringify(S.cur)), hats: Object.keys(S.hats), banner: S.banner, statics: S.statics }; };
    rules._refresh = function () { return refresh(false); };
})(typeof window !== 'undefined' ? window : globalThis);
