// Office life sprites (v0.9): small pixel props drawn once into offscreen
// canvases and cached by name + variant + device scale, so they stay crisp at
// every zoom and cost one drawImage per frame. Plus the screen-space label
// helper every feature uses (same fixed size as the activity chips).
//
// VOLifeSprites.draw(ctx, name, x, y, opts) -> bool   centred at (x, y), current transform
// VOLifeSprites.size(name, opts) -> {w, h}            in sprite (world) pixels
// VOLifeSprites.label(ctx, text, x, y, opts) -> rect  screen space (canvas CSS px)
// VOLifeSprites.register(name, {w, h, paint(g, opts), variant(opts)})
(function (root) {
    'use strict';

    var defs = {};
    var cache = {};
    var cacheSize = 0;
    var CACHE_MAX = 240;

    // Rows of palette letters ('.' = transparent), one letter = one pixel.
    function bitmap(g, rows, pal, ox, oy) {
        ox = ox || 0; oy = oy || 0;
        for (var y = 0; y < rows.length; y++) {
            var row = rows[y];
            for (var x = 0; x < row.length; x++) {
                var c = pal[row.charAt(x)];
                if (!c) continue;
                // Merge runs of the same colour into one rect.
                var run = 1;
                while (x + run < row.length && row.charAt(x + run) === row.charAt(x)) run++;
                g.fillStyle = c;
                g.fillRect(ox + x, oy + y, run, 1);
                x += run - 1;
            }
        }
    }
    function rect(g, c, x, y, w, h) { g.fillStyle = c; g.fillRect(x, y, w, h); }

    var GLYPHS = {
        '!': ['KK', 'KK', 'KK', '..', 'KK'],
        '?': ['KKK', '..K', '.KK', '...', '.K.'],
        'check': ['....K', '...KK', 'K.KK.', 'KKK..', '.K...'],
        '...': ['K.K.K'],
        '+': ['.K.', 'KKK', '.K.']
    };

    function register(name, def) { defs[name] = def; }

    // --- the props ---
    register('placard', {
        w: 16, h: 10,
        variant: function (o) { return (o && o.glyph) || '!'; },
        paint: function (g, o) {
            var glyph = (o && o.glyph) || '!';
            var face = glyph === 'check' ? '#66bb6a' : '#ffc107';
            rect(g, '#3e2723', 0, 0, 16, 10);
            rect(g, face, 1, 1, 14, 8);
            rect(g, 'rgba(255,255,255,0.35)', 1, 1, 14, 1);
            var rows = GLYPHS[glyph] || GLYPHS['!'];
            var gw = rows[0].length, gh = rows.length;
            bitmap(g, rows, { K: '#3e2723' }, Math.floor((16 - gw) / 2), Math.floor((10 - gh) / 2));
        }
    });
    register('folder', {
        w: 12, h: 9,
        paint: function (g) {
            bitmap(g, [
                '.TTT........',
                'TTTTTTTTTTTT',
                'TFFFFFFFFFFT',
                'TFWWWWWWWWFT',
                'TFFFFFFFFFFT',
                'TFFFFFFFFFFT',
                'TFFFFFFFFFFT',
                'TFFFFFFFFFFT',
                'TTTTTTTTTTTT'
            ], { T: '#a1793a', F: '#f2c94c', W: '#fafafa' });
        }
    });
    register('envelope', {
        w: 12, h: 8,
        variant: function (o) { return (o && o.tint) || '#90a4ae'; },
        paint: function (g, o) {
            var tint = (o && o.tint) || '#90a4ae';
            bitmap(g, [
                'DDDDDDDDDDDD',
                'DWVWWWWWWVWD',
                'DWWVWWWWVWWD',
                'DWWWVWWVWWWD',
                'DWWWWVVWWWWD',
                'DWWWWWWWWWWD',
                'DWWWWWWWWWWD',
                'DDDDDDDDDDDD'
            ], { D: '#546e7a', W: '#fafafa', V: '#b0bec5' });
            rect(g, tint, 1, 5, 10, 2); // channel band
        }
    });
    register('alarmClock', {
        w: 11, h: 11,
        paint: function (g) {
            bitmap(g, [
                '.BB.....BB.',
                'BBRRRRRRRBB',
                '.RWWWWWWWR.',
                'RWWWWKWWWWR',
                'RWWWWKWWWWR',
                'RWWWWKKKWWR',
                'RWWWWWWWWWR',
                'RWWWWWWWWWR',
                '.RWWWWWWWR.',
                '..RRRRRRR..',
                '.K.......K.'
            ], { B: '#ffca28', R: '#e53935', W: '#fafafa', K: '#37474f' });
        }
    });
    register('headphones', {
        w: 16, h: 9,
        paint: function (g) {
            bitmap(g, [
                '....KKKKKKKK....',
                '..KK........KK..',
                '.K............K.',
                'K..............K',
                'K..............K',
                'CC............CC',
                'CC............CC',
                'CC............CC',
                '.C............C.'
            ], { K: '#263238', C: '#ef5350' });
        }
    });
    register('cloud', {
        w: 12, h: 7,
        paint: function (g) {
            // v0.10: a rounder, puffier top and a lighter base (was a saucer)
            bitmap(g, [
                '...HLL.LL...',
                '.LHLLLLLLLL.',
                'LHLLLLLLLLLL',
                'LLLLLLLLLLLS',
                '.GGGGGGGGGS.',
                '..GGGGGGGG..',
                '...B..B..B..'
            ], { H: '#ffffff', L: '#e3e9ec', S: '#c5ced3', G: '#b0bec5', B: '#78909c' });
        }
    });
    register('cake', {
        w: 16, h: 13,
        paint: function (g) {
            bitmap(g, [
                '.......Y........',
                '.......O........',
                '.......C........',
                '.......C........',
                '..WWWWWWWWWWWW..',
                '.WPWWPWWPWWPWWW.',
                '.PPPPPPPPPPPPPP.',
                '.SSSSSSSSSSSSSS.',
                '.WWWWWWWWWWWWWW.',
                '.PPPPPPPPPPPPPP.',
                '.SSSSSSSSSSSSSS.',
                'DDDDDDDDDDDDDDDD',
                '.DDDDDDDDDDDDDD.'
            ], { Y: '#ffeb3b', O: '#ff9800', C: '#4fc3f7', W: '#fff8e1', P: '#f48fb1', S: '#8d6e63', D: '#b0bec5' });
        }
    });
    register('donut', {
        w: 7, h: 6,
        paint: function (g) {
            bitmap(g, ['.PPPPP.', 'PPYPPRP', 'PP...PP', 'PP...PP', 'BBPBPBB', '.BBBBB.'],
                { P: '#f06292', Y: '#fff176', R: '#4fc3f7', B: '#d7a35b' });
        }
    });
    register('donutBox', {
        w: 20, h: 10,
        paint: function (g) {
            rect(g, '#f8bbd0', 0, 3, 20, 7);
            rect(g, '#ec407a', 0, 3, 20, 1);
            rect(g, '#ad1457', 0, 9, 20, 1);
            var cols = ['#f06292', '#8d6e63', '#fff176'];
            for (var i = 0; i < 3; i++) {
                bitmap(g, ['.DDD.', 'DD.DD', '.DDD.'], { D: cols[i] }, 2 + i * 6, 0);
            }
        }
    });
    register('umbrellaStand', {
        // v0.10: 1.5x bigger, J-hook handles, folded canopies with a tie, a
        // stand with a lit rim and a small drip puddle.
        w: 18, h: 25,
        variant: function (o) { return String(Math.max(1, Math.min(6, (o && o.count) || 3))); },
        paint: function (g, o) {
            var n = Math.max(1, Math.min(6, (o && o.count) || 3));
            var cols = ['#c0504d', '#4f81bd', '#d8b54a', '#5f9e6e', '#8e6aa8', '#d9874a'];
            rect(g, 'rgba(144,202,249,0.55)', 1, 23, 16, 1); rect(g, 'rgba(144,202,249,0.55)', 3, 24, 12, 1);
            for (var i = 0; i < n; i++) {
                var x = 3 + (i * 3) % 11, top = 1 + (i % 2) * 2;
                rect(g, '#3e2723', x, top, 3, 1); rect(g, '#3e2723', x + 2, top + 1, 1, 2);   // J hook
                rect(g, '#5d4037', x, top + 1, 1, 4);                                         // shaft
                rect(g, cols[i], x - 1, top + 5, 3, 8);                                       // folded canopy
                rect(g, 'rgba(255,255,255,0.25)', x - 1, top + 5, 1, 8);
                rect(g, 'rgba(0,0,0,0.25)', x - 1, top + 9, 3, 1);                            // tie
            }
            rect(g, '#546e7a', 3, 12, 12, 10);
            rect(g, '#78909c', 2, 11, 14, 2);
            rect(g, '#90a4ae', 3, 13, 2, 8);
            rect(g, '#455a64', 13, 13, 2, 9);
            rect(g, '#37474f', 3, 21, 12, 1);
            rect(g, 'rgba(144,202,249,0.8)', 14, 22, 2, 1);
        }
    });
    register('partyHat', {
        w: 8, h: 10,
        paint: function (g) {
            bitmap(g, ['...YY...', '...MM...', '..MMB...', '..MBBM..', '..BBMM..', '.MMMBB..', '.BBMMMM.', '.MMBBMM.', 'MMMMMBBM', 'BBBBBBBB'],
                { Y: '#ffeb3b', M: '#ab47bc', B: '#4fc3f7' });
        }
    });
    register('trophy', {
        w: 10, h: 12,
        paint: function (g) {
            bitmap(g, [
                'GGGGGGGGGG',
                'GYYYYYYYYG',
                '.GYYYYYYG.',
                'G.GYYYYG.G',
                'G..GYYG..G',
                '.G.GYYG.G.',
                '...GYYG...',
                '....GG....',
                '....GG....',
                '...GGGG...',
                '..BBBBBB..',
                '..BBBBBB..'
            ], { G: '#f9a825', Y: '#ffe082', B: '#6d4c41' });
        }
    });
    register('pin', {
        w: 3, h: 3,
        variant: function (o) { return (o && o.tint) || '#e53935'; },
        paint: function (g, o) { bitmap(g, ['.R.', 'RWR', '.R.'], { R: (o && o.tint) || '#e53935', W: '#ffcdd2' }); }
    });
    register('newspaper', {
        w: 14, h: 10,
        paint: function (g) {
            bitmap(g, [
                'GGGGGGGGGGGGGG',
                'GWWWWWWWWWWWWG',
                'GWKKKKKKKKKKWG',
                'GWWWWWWWWWWWWG',
                'GWKKK.WLLLLLWG',
                'GWKKK.WWWWWWWG',
                'GWKKK.WLLLLLWG',
                'GWWWWWWWWWWWWG',
                'GWLLLLL.LLLLWG',
                'GGGGGGGGGGGGGG'
            ], { G: '#9e9e9e', W: '#fafafa', K: '#424242', L: '#bdbdbd' });
        }
    });
    register('clipboard', {
        w: 9, h: 11,
        paint: function (g) {
            bitmap(g, ['...SSS...', 'BBBSSSBBB', 'BWWWWWWWB', 'BWKKKKKWB', 'BWWWWWWWB', 'BWKKKKWWB', 'BWWWWWWWB', 'BWKKKKKWB', 'BWWWWWWWB', 'BWWWWWWWB', 'BBBBBBBBB'],
                { S: '#90a4ae', B: '#8d6e63', W: '#fafafa', K: '#90a4ae' });
        }
    });
    register('heart', {
        w: 7, h: 6,
        paint: function (g) { bitmap(g, ['.RR.RR.', 'RRRRRRR', 'RRRRRRR', '.RRRRR.', '..RRR..', '...R...'], { R: '#ef5350' }); }
    });
    register('star', {
        w: 7, h: 7,
        paint: function (g) { bitmap(g, ['...Y...', '..YYY..', 'YYYYYYY', '.YYYYY.', '..YYY..', '.YY.YY.', 'Y.....Y'], { Y: '#ffd54f' }); }
    });
    register('sparkle', {
        w: 7, h: 7,
        paint: function (g) { bitmap(g, ['...W...', '...Y...', '.Y.Y.Y.', 'WYYWYYW', '.Y.Y.Y.', '...Y...', '...W...'], { W: '#ffffff', Y: '#ffe082' }); }
    });
    register('balloon', {
        w: 7, h: 12,
        variant: function (o) { return (o && o.tint) || '#ef5350'; },
        paint: function (g, o) {
            bitmap(g, ['.BBBBB.', 'BWBBBBB', 'BWBBBBB', 'BBBBBBB', 'BBBBBBB', '.BBBBB.', '..BBB..', '...K...', '...K...', '..K....', '..K....', '...K...'],
                { B: (o && o.tint) || '#ef5350', W: 'rgba(255,255,255,0.6)', K: '#9e9e9e' });
        }
    });
    register('flag', {
        w: 8, h: 10,
        paint: function (g) { bitmap(g, ['KRRRRRR.', 'KRRRRRRR', 'KRRRRRR.', 'KRRRR...', 'K.......', 'K.......', 'K.......', 'K.......', 'K.......', 'K.......'], { K: '#6d4c41', R: '#42a5f5' }); }
    });
    register('phone', {
        w: 6, h: 9,
        paint: function (g) { bitmap(g, ['KKKKKK', 'KSSSSK', 'KSSSSK', 'KSSSSK', 'KSSSSK', 'KSSSSK', 'KSSSSK', 'KKWWKK', 'KKKKKK'], { K: '#263238', S: '#4fc3f7', W: '#90a4ae' }); }
    });
    register('confetti', {
        w: 2, h: 2,
        variant: function (o) { return (o && o.tint) || '#ffd54f'; },
        paint: function (g, o) { rect(g, (o && o.tint) || '#ffd54f', 0, 0, 2, 2); }
    });
    register('dots', {
        w: 9, h: 5,
        paint: function (g) { bitmap(g, ['.WWWWWWW.', 'WWWWWWWWW', 'WKWWKWWKW', 'WWWWWWWWW', '.WWWWWWW.'], { W: '#eceff1', K: '#455a64' }); }
    });

    // --- cache + draw ---
    function deviceScale(ctx) {
        try {
            if (ctx && typeof ctx.getTransform === 'function') {
                var m = ctx.getTransform();
                return Math.sqrt(m.a * m.a + m.b * m.b) || 1;
            }
        } catch (e) {}
        return 1;
    }
    function makeCanvas(w, h) {
        if (typeof document === 'undefined' || !document.createElement) return null;
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c.getContext ? c : null;
    }
    function get(name, scale, opts) {
        var def = defs[name];
        if (!def) return null;
        var s = Math.max(1, Math.min(8, Math.ceil(scale - 0.01)));
        var variant = def.variant ? def.variant(opts) : '';
        var key = name + '|' + variant + '|' + s;
        if (cache[key]) return cache[key];
        var c = makeCanvas(def.w * s, def.h * s);
        if (!c) return null;
        var g = c.getContext('2d');
        if (!g) return null;
        g.scale(s, s);
        def.paint(g, opts || {});
        if (cacheSize >= CACHE_MAX) { cache = {}; cacheSize = 0; }
        cache[key] = c;
        cacheSize++;
        return c;
    }

    function draw(ctx, name, x, y, opts) {
        var def = defs[name];
        if (!def || !ctx) return false;
        var c = get(name, deviceScale(ctx) * ((opts && opts.scale) || 1), opts);
        if (!c) return false;
        var sc = (opts && opts.scale) || 1;
        var w = def.w * sc, h = def.h * sc;
        var a = opts && opts.alpha != null ? opts.alpha : 1;
        var prevAlpha = ctx.globalAlpha;
        if (a < 1) ctx.globalAlpha = prevAlpha * Math.max(0, a);
        ctx.drawImage(c, Math.round(x - w / 2), Math.round(y - h / 2), w, h);
        if (a < 1) ctx.globalAlpha = prevAlpha;
        return true;
    }

    // --- screen-space label (fixed size like the chips; fixed colours, the same in every UI theme) ---
    var KINDS = {
        warning: function () { return { bg: '#fbbf24', fg: '#1b1300', border: '#3e2723' }; },
        info: function () { return { bg: '#60a5fa', fg: '#06121f', border: '#0d2440' }; },
        success: function () { return { bg: '#4ade80', fg: '#04210f', border: '#0b3d1e' }; },
        neutral: function () { return { bg: 'rgba(14,19,31,0.92)', fg: '#ffffff', border: 'rgba(255,255,255,0.28)' }; }
    };
    function metrics() {
        var host = root.VOLifeHost;
        return (host && host.ctlMetrics && host.ctlMetrics()) || { h: 22, gap: 3, font: '600 11px Inter, system-ui, sans-serif' };
    }
    // Draw a pill label. (x, y) is the anchor: bottom centre by default.
    // opts: {kind, icon (sprite name), iconOpts, count, anchor: 'bottom'|'top'|'center',
    //        maxW, avoid (keep out of chrome, default true), alpha}
    // v0.10: drawn with the office's one chip family (window.VOChip: pixel
    // pill, 2 px shadow, pixel font) when the host provides it.
    function label(ctx, text, x, y, opts) {
        opts = opts || {};
        var chip = root.VOChip;
        if (!chip || !chip.draw) return legacyLabel(ctx, text, x, y, opts);
        var m = metrics();
        var h = m.h;
        var colors = (KINDS[opts.kind] || KINDS.neutral)();
        var iconW = opts.icon && defs[opts.icon] ? Math.round(h * 0.6) : 0;
        var lead = iconW ? iconW + 4 : 0;
        var countStr = opts.count > 1 ? String(opts.count > 99 ? '99+' : opts.count) : '';
        var copts = { lead: lead, badge: countStr };
        var str = chip.fit(String(text == null ? '' : text), h, opts.maxW || 220, copts);
        var w = Math.ceil(chip.width(str, h, null, 1, copts));
        var r = { x: Math.round(opts.align === 'right' ? x - w : x - w / 2), y: Math.round(opts.anchor === 'top' ? y : opts.anchor === 'center' ? y - h / 2 : y - h), w: w, h: h };
        var host = root.VOLifeHost;
        if (opts.avoid !== false && host && host.keepOutOfChrome) r = host.keepOutOfChrome(r, null, 4);
        r = clampToView(r);
        ctx.save();
        if (opts.alpha != null && opts.alpha < 1) ctx.globalAlpha *= Math.max(0, opts.alpha);
        chip.draw(r, colors, str, copts);
        if (iconW) {
            var def = defs[opts.icon];
            var sc = iconW / Math.max(def.w, def.h);
            draw(ctx, opts.icon, r.x + Math.round(h * 0.32) + iconW / 2, r.y + h / 2, Object.assign({}, opts.iconOpts || {}, { scale: sc }));
        }
        ctx.restore();
        return r;
    }
    // UI-23: a label never pokes past the canvas edge (replay, phones).
    function clampToView(r) {
        var host = root.VOLifeHost, v = host && host.view ? host.view() : null;
        if (!v || !(v.w > 0) || !(v.h > 0)) return r;
        return { x: Math.max(2, Math.min(v.w - r.w - 2, r.x)), y: Math.max(2, Math.min(v.h - r.h - 2, r.y)), w: r.w, h: r.h };
    }
    function legacyLabel(ctx, text, x, y, opts) {
        var m = metrics();
        var h = m.h, pad = Math.round(h * 0.32);
        var colors = (KINDS[opts.kind] || KINDS.neutral)();
        ctx.save();
        ctx.font = m.font;
        var str = String(text == null ? '' : text);
        var maxW = opts.maxW || 220;
        var iconW = opts.icon && defs[opts.icon] ? Math.round(h * 0.6) : 0;
        var countStr = opts.count > 1 ? String(opts.count > 99 ? '99+' : opts.count) : '';
        var countW = countStr ? ctx.measureText(countStr).width + 8 : 0;
        var tw = ctx.measureText(str).width;
        var room = maxW - pad * 2 - (iconW ? iconW + 4 : 0) - (countW ? countW + 4 : 0);
        if (tw > room && str.length > 1) {
            while (str.length > 1 && ctx.measureText(str + '…').width > room) str = str.slice(0, -1);
            str += '…';
            tw = ctx.measureText(str).width;
        }
        var w = Math.round(pad * 2 + tw + (iconW ? iconW + 4 : 0) + (countW ? countW + 4 : 0));
        var r = { x: Math.round(opts.align === 'right' ? x - w : x - w / 2), y: Math.round(opts.anchor === 'top' ? y : opts.anchor === 'center' ? y - h / 2 : y - h), w: w, h: h };
        var host = root.VOLifeHost;
        if (opts.avoid !== false && host && host.keepOutOfChrome) r = host.keepOutOfChrome(r, null, 4);
        if (opts.alpha != null && opts.alpha < 1) ctx.globalAlpha *= Math.max(0, opts.alpha);
        // Pixel pill: square body with notched corners and a 1 px border.
        ctx.fillStyle = colors.border;
        ctx.fillRect(r.x + 1, r.y, r.w - 2, r.h);
        ctx.fillRect(r.x, r.y + 1, r.w, r.h - 2);
        ctx.fillStyle = colors.bg;
        ctx.fillRect(r.x + 2, r.y + 1, r.w - 4, r.h - 2);
        ctx.fillRect(r.x + 1, r.y + 2, r.w - 2, r.h - 4);
        var cx = r.x + pad;
        if (iconW) {
            var def = defs[opts.icon];
            var sc = iconW / Math.max(def.w, def.h);
            draw(ctx, opts.icon, cx + iconW / 2, r.y + h / 2, Object.assign({}, opts.iconOpts || {}, { scale: sc }));
            cx += iconW + 4;
        }
        ctx.fillStyle = colors.fg;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(str, cx, r.y + h / 2 + 0.5);
        cx += tw + 4;
        if (countW) {
            ctx.fillStyle = colors.border;
            ctx.fillRect(cx, r.y + 4, countW, h - 8);
            ctx.fillStyle = colors.bg;
            ctx.textAlign = 'center';
            ctx.fillText(countStr, cx + countW / 2, r.y + h / 2 + 0.5);
        }
        ctx.restore();
        return r;
    }
    // Hit test helper: the rect grown to the 32 px (mouse) / 44 px (touch) minimum.
    function hitRect(r, px, py, touch) {
        if (!r) return false;
        var min = touch ? 44 : 32;
        var gx = Math.max(0, (min - r.w) / 2), gy = Math.max(0, (min - r.h) / 2);
        return px >= r.x - gx && px <= r.x + r.w + gx && py >= r.y - gy && py <= r.y + r.h + gy;
    }

    var api = {
        register: register,
        draw: draw,
        get: get,
        has: function (name) { return !!defs[name]; },
        names: function () { return Object.keys(defs); },
        size: function (name, opts) { var d = defs[name]; var sc = (opts && opts.scale) || 1; return d ? { w: d.w * sc, h: d.h * sc } : null; },
        label: label,
        clampToView: clampToView,
        hitRect: hitRect,
        clear: function () { cache = {}; cacheSize = 0; },
        cacheSize: function () { return cacheSize; },
        bitmap: bitmap
    };
    root.VOLifeSprites = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
