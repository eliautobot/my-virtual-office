// Graphics setting: the office drawn as the 3D sprite-stack diorama or the
// classic 2D look. Always loaded (small); the 3D files load only when 3D is used.
//
//   Settings > General > Display > Graphics: Auto | 3D | Classic 2D
//   saved per browser in localStorage 'vo-display-prefs'.graphics ('auto' | '3d' | '2d')
//   Auto: 3D when the browser has WebGL 2 on a graphics card (not a software
//   renderer), else 2D. The address may force a look for one visit: ?classic=1 / ?stack=1.
//
// window.VOGraphics: pref(), set(pref), resolved(), capability(), apply(), status(), loaded()
// game.js reads window.VOStack.on() (stack-scene.js), which follows VOGraphics.resolved().
(function () {
    'use strict';
    var VERSION = '0.13.1';
    var FILES = [
        'stack/stack-core.js', 'stack/stack-gl.js', 'stack/stack-scene.js', 'stack/stack-overlay.js',
        'stack/stack-legacy.js', 'stack/stack-walls.js', 'stack/stack-people.js',
        'stack/models/models-desks.js', 'stack/models/models-lounge.js', 'stack/models/models-kitchen.js',
        'stack/models/models-misc.js', 'stack/models/models-variants.js', 'stack/stack-chars.js'
    ];
    var PREFS = 'vo-display-prefs';

    function readPrefs() {
        try { return JSON.parse(localStorage.getItem(PREFS) || '{}') || {}; } catch (e) { return {}; }
    }
    function pref() {
        var p = readPrefs().graphics;
        if (p === '3d' || p === '2d' || p === 'auto') return p;
        try { if (localStorage.getItem('vo-stack-classic') === '1') return '2d'; } catch (e) { /* storage off */ }
        return 'auto';
    }
    function forced() {
        try {
            if (/[?&]classic=1\b/.test(location.search)) return '2d';
            if (/[?&]stack=1\b/.test(location.search)) return '3d';
        } catch (e) { /* no location */ }
        return null;
    }

    // What this browser can do (checked once): WebGL 2, and whether it runs on a
    // graphics card or in software (SwiftShader, llvmpipe, Microsoft Basic Render).
    var cap = null;
    function capability() {
        if (cap) return cap;
        cap = { webgl2: false, software: false, renderer: '' };
        try {
            var c = document.createElement('canvas'), gl = c.getContext('webgl2');
            if (gl) {
                cap.webgl2 = true;
                var dbg = gl.getExtension('WEBGL_debug_renderer_info');
                var name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
                cap.renderer = name;
                cap.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
                var lose = gl.getExtension('WEBGL_lose_context');
                if (lose) lose.loseContext();
            }
        } catch (e) { cap.webgl2 = false; }
        return cap;
    }
    // The look in use: '3d' or '2d'.
    var failed = false;   // the 3D renderer could not start here: 2D until reload
    function resolved() {
        if (failed) return '2d';
        var f = forced();
        if (f === '2d') return '2d';
        var c = capability();
        if (!c.webgl2) return '2d';
        if (f === '3d') return '3d';
        var p = pref();
        if (p === '2d') return '2d';
        if (p === '3d') return '3d';
        return c.software ? '2d' : '3d';
    }

    // ---------- loading the 3D files (once, in order) ----------
    var state = 'idle', waiting = [];
    function loaded() { return state === 'done'; }
    function load(cb) {
        if (cb) waiting.push(cb);
        if (state === 'done') { flush(); return; }
        if (state === 'loading') return;
        state = 'loading';
        var left = FILES.length;
        FILES.forEach(function (src) {
            var s = document.createElement('script');
            s.src = src + '?v=' + VERSION;
            s.async = false;   // dynamic scripts with async off run in insertion order
            s.onload = function () { if (--left === 0) { state = 'done'; flush(); } };
            s.onerror = function () { state = 'error'; failed = true; console.warn('[graphics] the 3D files did not load: ' + src); flush(); };
            (document.head || document.documentElement).appendChild(s);
        });
    }
    function flush() { var w = waiting; waiting = []; w.forEach(function (f) { try { f(); } catch (e) { console.warn('[graphics]', e); } }); }

    // ---------- switching ----------
    function emit() {
        try { window.dispatchEvent(new CustomEvent('vo:graphics-change', { detail: status() })); } catch (e) { /* old browser */ }
    }
    function apply() {
        if (resolved() === '3d') {
            load(function () {
                var ok = window.VOStack && typeof window.VOStack.activate === 'function' && window.VOStack.activate(true);
                if (!ok && window.VOStack && window.VOStack.state && window.VOStack.state.error) failed = true;
                emit();
            });
        } else {
            if (window.VOStack && typeof window.VOStack.activate === 'function') window.VOStack.activate(false);
            emit();
        }
    }
    function set(p) {
        p = p === '3d' || p === '2d' ? p : 'auto';
        var prefs = readPrefs();
        prefs.graphics = p;
        try { localStorage.setItem(PREFS, JSON.stringify(prefs)); localStorage.removeItem('vo-stack-classic'); } catch (e) { /* storage off */ }
        apply();
    }
    function status() {
        var c = capability();
        return { pref: pref(), forced: forced(), resolved: resolved(), webgl2: c.webgl2, software: c.software,
            active: !!(window.VOStack && window.VOStack.on && loaded() && window.VOStack.on()), failed: failed };
    }
    // A sentence for the Settings hint.
    function describe() {
        var s = status();
        if (s.failed) return '3D could not start in this browser, so the classic 2D look is used.';
        if (s.forced) return 'This visit uses ' + (s.forced === '3d' ? '3D' : 'classic 2D') + ' (set in the address).';
        if (!s.webgl2) return '3D needs WebGL 2, which this browser does not offer, so the classic 2D look is used.';
        if (s.pref === 'auto') return s.software ? 'Auto is using classic 2D: this browser draws without a graphics card.' : 'Auto is using 3D on this device.';
        return s.pref === '3d' ? (s.software ? '3D is on. This browser draws without a graphics card, so it may be slow.' : '3D is on.') : 'Classic 2D is on.';
    }
    function markFailed() { failed = true; emit(); }

    window.VOGraphics = { pref: pref, set: set, resolved: resolved, capability: capability, apply: apply,
        status: status, describe: describe, loaded: loaded, markFailed: markFailed, files: FILES.slice() };

    // At start: the 3D files load now when 3D will be used (the classic look draws until they are in).
    if (resolved() === '3d') load();
})();
