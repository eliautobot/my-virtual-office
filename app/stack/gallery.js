// Stack gallery: any registered model at several turns, without the office.
// /stack/gallery.html?type=desk&turns=0,45,90,180&yaw=-30&scale=3
//   item fields: any other query key goes on the item (variant, color, couchColor, rotation...)
//   rx=<state>&held=1&t=0.5   a click reaction state for the builder
//   night=1                   night light;  plan=1  the classic straight camera
//   all=1                     every registered type in a grid (turn 0 and 45)
// People mode (characters, pets, chairs; the office's own art is read from an
// office page in a hidden frame):
// /stack/gallery.html?people=1&set=agents|hair|hats|costumes|tops|faces|poses|pets|chairs&turns=0,45,90,180
//   pets: &pose=stand,walk:1,sit,sleep,trick:0,trick:1,groom:1,look,pet,eat
(function () {
    'use strict';
    var S = window.VOStack;
    var q = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (kv) { if (!kv) return; var p = kv.split('='); q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); });
    var DEG = Math.PI / 180;
    var scale = +(q.scale || 3), plan = q.plan === '1';
    // the camera stays square to the rows; each object is turned by its angle plus the view yaw (a turntable)
    var viewYaw = plan ? 0 : (q.yaw != null ? +q.yaw : -30) * DEG;
    var cam = plan ? { yaw: 0, squash: 1, spacing: 1 } : { yaw: 0, squash: +(q.squash || 0.7), spacing: 1 };
    var out = document.getElementById('out'), info = document.getElementById('info');
    var R = new S.Renderer();

    function itemFor(type) {
        var it = { id: 'g-' + type, type: type, x: 0, y: 0 };
        Object.keys(q).forEach(function (k) {
            if (/^(type|turns|yaw|squash|scale|night|plan|all|rx|held|t|gap|wallH|people|set|pose|cols)$/.test(k)) return;
            it[k] = isFinite(+q[k]) && q[k] !== '' ? +q[k] : q[k];
        });
        return it;
    }
    function ctxFor(item) {
        var rx = q.rx != null ? { n: +q.rx, state: +q.rx, t: q.t != null ? +q.t : -1, held: q.held === '1' } : null;
        return { rx: rx, wallH: +(q.wallH || 90), manifest: null, gallery: true };
    }

    // entries: [{ label, parts: [{ model, ox, oy, oz }], animate?, item? }]
    function start(entries, turns, gap, cols, gapY) {
        var specs = [];
        gapY = gapY || gap;
        cols = cols || turns.length;
        entries.forEach(function (en, ti) {
            var meshes = [];
            en.parts.forEach(function (p) {
                var mesh = p.model ? R.upload(p.model, 'static', en.label) : null;
                if (mesh) meshes.push({ mesh: mesh, p: p });
            });
            if (!meshes.length) { info.textContent += ' [' + en.label + ' empty]'; return; }
            info.textContent += ' ' + en.label;
            turns.forEach(function (deg, k) {
                var n = ti * turns.length + k, col = n % cols, row = Math.floor(n / cols), turn = deg * DEG + viewYaw;
                var c = Math.cos(turn), s = Math.sin(turn);
                meshes.forEach(function (mm) {
                    var ox = mm.p.ox || 0, oy = mm.p.oy || 0;
                    var spec = { mesh: mm.mesh, x: col * gap + ox * c - oy * s, y: row * gapY + ox * s + oy * c, z: mm.p.oz || 0, turn: turn, id: n + 1, screen: +(q.screen || 1) };
                    if (en.animate) { try { en.animate(spec, en.item, performance.now() / 1000, ctxFor(en.item)); } catch (e) { /* still */ } }
                    specs.push(spec);
                });
            });
        });
        var nFig = entries.length * turns.length;
        var rows = Math.ceil(nFig / cols);
        var worldW = cols * gap, worldH = rows * gapY;
        var floor = document.createElement('canvas');
        floor.width = worldW; floor.height = worldH;
        var g = floor.getContext('2d');
        for (var y = 0; y < worldH; y += 20) for (var x = 0; x < worldW; x += 20) { g.fillStyle = ((x + y) / 20) % 2 ? '#c7c9cf' : '#bcbec5'; g.fillRect(x, y, 20, 20); }
        R.setFloor(floor, 'g');

        function frame() {
            var night = q.night === '1' ? 1 : 0;
            var env = {
                sunDir: (function (v) { var l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; })([-0.45, 0.55, 0.70]),
                lit: [1.06, 1.03, 0.97], mid: [0.86, 0.87, 0.93], shd: [0.64, 0.68, 0.84],
                ambient: night ? [0.38, 0.44, 0.64] : [1, 1, 1], night: night, time: performance.now() / 1000,
                sky0: [0.73, 0.87, 0.98, 0], sky1: [0.13, 0.59, 0.95, night ? 1 : 0], outline: [0.09, 0.08, 0.16],
                shadow: [0.55, -0.42], shadowCol: [0.03, 0.03, 0.08, 0.24], floorMul: 1,
                lights: night ? [{ x: worldW / 2, y: worldH / 2 + 40, z: 40, r: 260, c: [1, 0.88, 0.7], k: 0.8 }] : []
            };
            var cx = worldW / 2 - gap / 2, cy = worldH / 2 - gapY / 2;
            var top = +(q.top || (q.people === '1' ? 70 : 0));
            var fw = Math.ceil(Math.max(320, worldW + 40)), fh = Math.ceil(Math.max(200, worldH * cam.squash + 120 + top));
            R.begin();
            specs.forEach(function (s) { R.push(s); });
            var casters = R.count;
            var img = R.render({ cx: cx, cy: cy, yaw: cam.yaw, squash: cam.squash, spacing: cam.spacing, scale: 1, fw: fw, fh: fh, ox: Math.floor(fw / 2), oy: Math.floor(fh / 2) + 20 + Math.floor(top / 2) },
                env, { x: -gap / 2, y: -gapY / 2, w: worldW, h: worldH, tx: 0, ty: 0, tw: 1, th: 1 }, casters);
            out.width = fw * scale; out.height = fh * scale;
            var o = out.getContext('2d');
            o.imageSmoothingEnabled = false;
            o.fillStyle = '#20242e'; o.fillRect(0, 0, out.width, out.height);
            o.drawImage(img, 0, 0, fw * scale, fh * scale);
        }
        frame();
        if (q.live === '1') setInterval(frame, 100);
        window.__galleryReady = true;
    }

    if (q.people === '1') {
        // the office in a hidden frame (classic look): its art and roster drive the figures
        var fr = document.createElement('iframe');
        fr.style.cssText = 'position:absolute;left:-3000px;top:0;width:1200px;height:800px;border:0;';
        fr.src = '/?classic=1&gallery=1';
        document.body.appendChild(fr);
        var t0 = Date.now();
        (function wait() {
            var w = null;
            try { w = fr.contentWindow; } catch (e) { w = null; }
            var ready = w && w.FURNITURE_MANIFEST && typeof w._drawHairArt === 'function' && w.agents && (w.agents.length || Date.now() - t0 > 6000);
            if (!ready) { if (Date.now() - t0 < 20000) setTimeout(wait, 200); else info.textContent += ' [office frame did not load]'; return; }
            setTimeout(function () {
                S.chars.useGlobals(w);
                var entries = [];
                try { entries = S.chars.galleryEntries(q, w); } catch (e) { console.error(e); info.textContent += ' [people failed: ' + e.message + ']'; }
                var turns = (q.turns || '0,45,90,135,180,270').split(',').map(Number);
                start(entries, turns, +(q.gap || 70), q.cols ? +q.cols : null, +(q.gapY || 110));
            }, Date.now() - t0 > 6000 ? 0 : 1500);
        })();
        return;
    }

    var types = q.all === '1' ? Object.keys(S.defs).sort() : [q.type || 'desk'];
    var turns = (q.turns || (q.all === '1' ? '0,45' : '0,45,90,180,270')).split(',').map(Number);
    var entries = [];
    types.forEach(function (type) {
        var d = S.defs[type];
        if (!d) { info.textContent += ' [no model: ' + type + ']'; return; }
        var item = itemFor(type), model;
        try { model = d.build(item, ctxFor(item)); } catch (e) { info.textContent += ' [' + type + ' failed: ' + e.message + ']'; console.error(e); return; }
        info.textContent += ' ' + type + ' ' + model.w + 'x' + model.d + 'x' + model.h;
        entries.push({ label: '', parts: [{ model: model, ox: 0, oy: 0, oz: 0 }], animate: d.animate || null, item: item });
    });
    start(entries, turns, +(q.gap || 150), q.all === '1' ? turns.length * 4 : turns.length);
})();
