// In-page probe for tests/tools/drawcheck/drawcheck.mjs (classic script, evaluated in the office page).
// Builds agents like the Studio preview (v10-studio.js makePreviewAgent) and draws them with the real
// Agent.draw onto a private canvas, with frozen clocks and a seeded Math.random, at whole and at
// fractional transforms (the office draws at any camera zoom and at sub-pixel agent positions).
(function () {
    var CANVAS = 200, ORIGIN_X = 100, ORIGIN_Y = 130;
    var cv = document.createElement('canvas'); cv.width = CANVAS; cv.height = CANVAS;
    var g = cv.getContext('2d', { willReadFrequently: true });
    var T0 = 100000, D0 = 1767225600000;
    function seeded(s) { return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
    function frozen(fn) {
        var pn = performance.now, dn = Date.now, mr = Math.random;
        performance.now = function () { return T0; }; Date.now = function () { return D0; }; Math.random = seeded(12345);
        try { return fn(); } finally { performance.now = pn; Date.now = dn; Math.random = mr; }
    }
    function mk(look, o) {
        var a = Object.create(Agent.prototype), facing = o.facing || 'down', pose = o.pose || 'stand';
        var seated = pose === 'sit' || pose === 'type' || pose === 'idle';
        Object.assign(a, { id: '__drawcheck__', name: '', emoji: '', role: '', color: o.color || '#1e88e5', gender: o.gender || 'M',
            appearance: look, x: 0, y: 0, targetX: 0, targetY: 0, speed: 1.2, tick: o.tick || 0, desk: { x: 0, y: 0 },
            isSitting: seated, state: o.state || (pose === 'type' ? 'working' : 'idle'), task: '', faceDir: facing === 'left' ? -1 : 1,
            facing: facing, _forceView: facing, idleAction: null, notify: false, carryItem: pose === 'idle' ? 'coffee' : null,
            available: true, _studioPreview: o.preview !== false, _lifeExtra: true });
        if (o.expression) a._previewExpression = o.expression;
        if (pose === 'walk') {
            if (facing === 'left') a.targetX = -400; else if (facing === 'up') a.targetY = -400;
            else if (facing === 'down') a.targetY = 400; else a.targetX = 400;
        }
        if (o.sigMove && typeof _sigMoveSpec === 'function') {
            var sm = _sigMoveSpec(o.sigMove);
            if (sm) a._sigMove = { id: sm.id, at: T0 - Math.max(0, Math.min(0.999, o.sigP || 0)) * sm.ms, ms: sm.ms, still: !!o.sigStill, until: Infinity, preview: true };
        }
        if (o.wave) a._react = { at: T0 - o.wave.ms, kind: o.wave.kind || 'wave', wk: o.wave.wk, still: !!o.wave.still };
        if (o.extra) Object.assign(a, o.extra);
        return a;
    }
    // FNV-1a over the RGBA words
    function hash() {
        var d = new Uint32Array(g.getImageData(0, 0, CANVAS, CANVAS).data.buffer), h = 2166136261, n = 0;
        for (var i = 0; i < d.length; i++) { var v = d[i]; if (v) n++; h = Math.imul(h ^ v, 16777619) >>> 0; h = Math.imul(h ^ (i & 0xff), 16777619) >>> 0; }
        return h.toString(16) + ':' + n;
    }
    // tf: [scale, dx, dy]
    function render(look, o, tf) {
        return frozen(function () {
            var a = mk(look, o), saved = ctx;
            g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, CANVAS, CANVAS); g.globalAlpha = 1; g.imageSmoothingEnabled = false;
            g.save(); g.translate(ORIGIN_X + tf[1], ORIGIN_Y + tf[2]); g.scale(tf[0], tf[0]);
            ctx = g;
            var err = null;
            try { a.draw(); } catch (e) { err = String(e && e.message || e); } finally { ctx = saved; g.restore(); }
            return err ? 'ERR:' + err : hash();
        });
    }
    // Direct calls of the head helpers (every argument the agent can pass), same transforms.
    function direct(name, args, tf, pose) {
        return frozen(function () {
            g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, CANVAS, CANVAS); g.globalAlpha = 1;
            g.save(); g.translate(ORIGIN_X + tf[1], ORIGIN_Y + tf[2]); g.scale(tf[0], tf[0]);
            var err = null, savedPose = window._hairPose;
            try {
                if (pose !== undefined) window._hairPose = pose;
                var fn = window[name];
                if (typeof fn !== 'function') throw new Error('no ' + name);
                if (name === '_drawHeadSide' || name === '_drawFaceFront' || name === '_drawHeadBack' || name === '_drawHairArt') fn.apply(null, [g].concat(args));
                else fn.apply(null, [g].concat(args));
            } catch (e) { err = String(e && e.message || e); } finally { window._hairPose = savedPose; g.restore(); }
            return err ? 'ERR:' + err : hash();
        });
    }
    // Count canvas calls and time draws (bench mode), on a canvas like the office's (no read-back hint).
    var benchCanvas = null;
    function bench(cases, reps) {
        var agentsList = cases.map(function (c) { return mk(c.look, c.o); });
        var saved = ctx, t0, t1, g = benchCanvas || (benchCanvas = document.createElement('canvas'));
        g.width = 400; g.height = 300; g = g.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0); g.translate(ORIGIN_X + 0.37, ORIGIN_Y + 0.61); g.scale(1.37, 1.37);
        ctx = g;
        try {
            for (var w = 0; w < 3; w++) for (var i = 0; i < agentsList.length; i++) { agentsList[i].tick = w; g.save(); agentsList[i].draw(); g.restore(); }
            t0 = performance.now();
            for (var r = 0; r < reps; r++) for (var j = 0; j < agentsList.length; j++) { agentsList[j].tick = r; g.save(); agentsList[j].draw(); g.restore(); }
            t1 = performance.now();
        } finally { ctx = saved; g.setTransform(1, 0, 0, 1, 0, 0); }
        return (t1 - t0) * 1000 / (reps * agentsList.length); // us per agent draw
    }
    function countCalls(cases) {
        var P = CanvasRenderingContext2D.prototype, names = ['fillRect', 'fill', 'drawImage', 'save', 'restore', 'beginPath'], n = {}, keep = {};
        names.forEach(function (k) { n[k] = 0; keep[k] = P[k]; P[k] = function () { n[k]++; return keep[k].apply(this, arguments); }; });
        var fsSet = 0, desc = Object.getOwnPropertyDescriptor(P, 'fillStyle');
        Object.defineProperty(P, 'fillStyle', { configurable: true, get: desc.get, set: function (v) { fsSet++; desc.set.call(this, v); } });
        var ga = 0;
        try { cases.forEach(function (c) { render(c.look, c.o, [1, 0, 0]); }); }
        finally { names.forEach(function (k) { P[k] = keep[k]; }); Object.defineProperty(P, 'fillStyle', desc); }
        n.fillStyleSet = fsSet;
        Object.keys(n).forEach(function (k) { n[k] = +(n[k] / cases.length).toFixed(1); });
        return n;
    }
    window.__drawcheck = { render: render, direct: direct, bench: bench, countCalls: countCalls,
        tables: function () {
            var ids = function (l) { return (l || []).map(function (x) { return x.id; }); };
            return { hair: ids(window.HAIR_STYLE_TABLE), hats: ids(window.HEADWEAR_STYLES), expr: (window.AGENT_EXPRESSIONS || []).slice(),
                tops: ids(window.BODY_LOOKS && BODY_LOOKS.tops), neck: ids(window.BODY_LOOKS && BODY_LOOKS.neckwear),
                costumes: ids(window.BODY_LOOKS && BODY_LOOKS.costumes), moves: ids(window.SIGNATURE_MOVES),
                brows: Object.keys(window.FACE_BROWS || {}), waveMs: window.WAVE_MS || null, waveBig: window.WAVE_BIG_MS || null };
        } };
})();
