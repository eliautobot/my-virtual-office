// Sprite-stack core (v0.13 3D graphics): voxel models, the modelling kit the
// asset files use, and baking a model into its slice strip (the sprite-stacking
// method: an object is a pile of flat top-down slices, ground first, each lifted
// 1 world px; see stack/README.md).
//
// Units: 1 voxel = 1 world px (TILE = 40). Model space is the furniture's own
// local space: x right, y south (toward the camera at yaw 0), z up, origin at
// the item's anchor (item.x, item.y), exactly as FURNITURE_MANIFEST plans are.
//
// Colour + material live in one packed Uint32 per voxel: r | g << 8 | b << 16 |
// mat << 24 (0 = empty). Materials (the shader reads them from the alpha byte):
//   255 SOLID   lit with the three-tone toon light
//   250 EMIT    glows (lamps, LEDs): not darkened at night
//   245 SCREEN  a display: per-instance screen state (off / code / tv) in the shader
//   240 GLASS   window glass: shows the sky colour of the hour + weather
//   235 SHINY   lit, plus a specular band (metal, gloss)
//   230 SOFT    lit with softer bands (fabric, leaves, hair)
(function () {
    'use strict';
    var S = window.VOStack = window.VOStack || {};

    var MAT = S.MAT = { SOLID: 255, EMIT: 250, SCREEN: 245, GLASS: 240, SHINY: 235, SOFT: 230 };

    // ---------- colours ----------
    var _hexCache = Object.create(null);
    function rgbOf(c) {
        if (Array.isArray(c)) return c;
        if (typeof c === 'number') return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255];
        var hit = _hexCache[c];
        if (hit) return hit;
        var s = String(c).trim(), r = 128, g = 128, b = 128, m;
        if (s[0] === '#') {
            var h = s.slice(1);
            if (h.length === 3 || h.length === 4) { r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16); }
            else { r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); }
        } else if ((m = /^rgba?\(([^)]+)\)/i.exec(s))) {
            var p = m[1].split(',').map(function (v) { return parseFloat(v); });
            r = p[0]; g = p[1]; b = p[2];
        }
        return (_hexCache[c] = [r | 0, g | 0, b | 0]);
    }
    function pack(rgb, mat) {
        return ((rgb[0] & 255) | ((rgb[1] & 255) << 8) | ((rgb[2] & 255) << 16) | (((mat == null ? 255 : mat) & 255) << 24)) >>> 0;
    }
    function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
    // Lighter (k > 1) or darker (k < 1), hue-shifted the pixel-art way: darker
    // goes cooler, lighter goes warmer.
    function tone(c, k) {
        var a = rgbOf(c);
        if (k >= 1) {
            var t = k - 1;
            return [clamp255(a[0] * k + 18 * t), clamp255(a[1] * k + 10 * t), clamp255(a[2] * k - 6 * t)];
        }
        var d = 1 - k;
        return [clamp255(a[0] * k - 6 * d), clamp255(a[1] * k + 2 * d), clamp255(a[2] * k + 22 * d)];
    }
    function mix(c1, c2, t) {
        var a = rgbOf(c1), b = rgbOf(c2);
        return [clamp255(a[0] + (b[0] - a[0]) * t), clamp255(a[1] + (b[1] - a[1]) * t), clamp255(a[2] + (b[2] - a[2]) * t)];
    }
    function toHex(c) {
        var a = rgbOf(c);
        return '#' + a.map(function (v) { return ('0' + clamp255(v).toString(16)).slice(-2); }).join('');
    }
    // Deterministic hash noise in [0, 1) for textures (wood grain, carpet, leaves).
    function hash3(x, y, z) {
        var h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
    }
    S.color = { rgb: rgbOf, pack: pack, tone: tone, mix: mix, hex: toHex, hash: hash3 };

    // Texture helpers: a colour argument may be a function (x, y, z) -> colour.
    S.tex = {
        // Wood: planks along x with grain streaks.
        wood: function (base, opts) {
            opts = opts || {};
            var c0 = rgbOf(base), dark = tone(c0, 0.86), light = tone(c0, 1.08), axis = opts.axis || 'x', plank = opts.plank || 0;
            return function (x, y, z) {
                var u = axis === 'x' ? y : x, v = axis === 'x' ? x : y;
                var n = hash3(u, Math.floor(v / 9), z * 0 + 7);
                if (plank && ((u % plank) + plank) % plank === 0) return dark;
                return n < 0.18 ? dark : n > 0.86 ? light : c0;
            };
        },
        // Speckle: fine random variation (fabric, carpet, stone).
        speckle: function (base, amount) {
            var c0 = rgbOf(base), a = amount == null ? 0.06 : amount, lo = tone(c0, 1 - a), hi = tone(c0, 1 + a);
            return function (x, y, z) { var n = hash3(x, y, z); return n < 0.22 ? lo : n > 0.84 ? hi : c0; };
        },
        // Two-colour checker in 1 px or n px cells.
        checker: function (c1, c2, n) {
            var a = rgbOf(c1), b = rgbOf(c2); n = n || 1;
            return function (x, y, z) { return ((Math.floor(x / n) + Math.floor(y / n) + Math.floor(z / n)) & 1) ? b : a; };
        },
        // Horizontal bands up the z axis: [[z0, colour], [z1, colour], ...].
        bands: function (list) {
            return function (x, y, z) { var c = list[0][1]; for (var i = 0; i < list.length; i++) if (z >= list[i][0]) c = list[i][1]; return c; };
        }
    };

    // ---------- the model ----------
    // A dense box of voxels: x in [ox, ox + w), y in [oy, oy + d), z in [oz, oz + h).
    function Model(ox, oy, w, d, h, oz) {
        this.ox = ox | 0; this.oy = oy | 0; this.oz = oz | 0;
        this.w = Math.max(1, w | 0); this.d = Math.max(1, d | 0); this.h = Math.max(1, h | 0);
        this.v = new Uint32Array(this.w * this.d * this.h);
        this.mat = MAT.SOLID;   // material the next calls use
    }
    S.Model = Model;
    // A model whose box covers [x0, x1) x [y0, y1) x [z0, z1) in local px.
    S.model = function (x0, y0, x1, y1, z1, z0) {
        z0 = z0 || 0;
        return new Model(Math.floor(x0), Math.floor(y0), Math.ceil(x1) - Math.floor(x0), Math.ceil(y1) - Math.floor(y0), Math.ceil(z1) - Math.floor(z0), Math.floor(z0));
    };
    var P = Model.prototype;
    P.idx = function (x, y, z) {
        x -= this.ox; y -= this.oy; z -= this.oz;
        if (x < 0 || y < 0 || z < 0 || x >= this.w || y >= this.d || z >= this.h) return -1;
        return x + this.w * (y + this.d * z);
    };
    P.get = function (x, y, z) { var i = this.idx(x, y, z); return i < 0 ? 0 : this.v[i]; };
    P.has = function (x, y, z) { return this.get(x, y, z) !== 0; };
    P.material = function (m) { this.mat = m == null ? MAT.SOLID : m; return this; };
    // Resolve a colour argument at a voxel to a packed value (0 = leave empty).
    P._col = function (c, x, y, z, mat) {
        if (c == null || c === false) return 0;
        if (typeof c === 'function') c = c(x, y, z);
        if (c == null || c === false) return 0;
        if (typeof c === 'number' && c > 0xffffff) return c >>> 0;   // already packed
        return pack(rgbOf(c), mat == null ? this.mat : mat);
    };
    P.set = function (x, y, z, c, mat) {
        var i = this.idx(x, y, z);
        if (i >= 0) this.v[i] = this._col(c, x, y, z, mat);
        return this;
    };
    // Fill an axis-aligned box [x, x + w) x [y, y + d) x [z, z + h).
    P.box = function (x, y, z, w, d, h, c, mat) {
        var x0 = Math.round(x), y0 = Math.round(y), z0 = Math.round(z), x1 = Math.round(x + w), y1 = Math.round(y + d), z1 = Math.round(z + h);
        var fn = typeof c === 'function', pc = fn ? 0 : this._col(c, 0, 0, 0, mat);
        for (var zz = z0; zz < z1; zz++) for (var yy = y0; yy < y1; yy++) for (var xx = x0; xx < x1; xx++) {
            var i = this.idx(xx, yy, zz);
            if (i >= 0) this.v[i] = fn ? this._col(c, xx, yy, zz, mat) : pc;
        }
        return this;
    };
    // A box from a manifest-style plan: plan = [x, y, w, d], z, h.
    P.plan = function (plan, z, h, c, mat) { return this.box(plan[0], plan[1], z, plan[2], plan[3], h, c, mat); };
    // A box with its top edges rounded by r (cushions, rounded tops).
    P.rbox = function (x, y, z, w, d, h, r, c, mat) {
        r = r || 1;
        var self = this;
        return this.box(x, y, z, w, d, h, function (xx, yy, zz) {
            var dx = Math.max(0, Math.max(x + r - 0.5 - xx, xx - (x + w - r - 0.5)));
            var dy = Math.max(0, Math.max(y + r - 0.5 - yy, yy - (y + d - r - 0.5)));
            var dz = Math.max(0, zz - (z + h - r - 0.5));
            if (dx * dx + dy * dy + dz * dz > r * r + 0.25) return null;
            return typeof c === 'function' ? c(xx, yy, zz) : c;
        }, mat), self;
    };
    // Elliptic cylinder centred on (cx, cy) (use .5 centres for even widths).
    P.cyl = function (cx, cy, z, rx, ry, h, c, mat) {
        var x0 = Math.floor(cx - rx), x1 = Math.ceil(cx + rx), y0 = Math.floor(cy - ry), y1 = Math.ceil(cy + ry);
        for (var zz = Math.round(z); zz < Math.round(z + h); zz++) for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) {
            var dx = (xx + 0.5 - cx) / rx, dy = (yy + 0.5 - cy) / ry;
            if (dx * dx + dy * dy <= 1.0) this.set(xx, yy, zz, c, mat);
        }
        return this;
    };
    // Frustum: radius r0 at the bottom to r1 at the top (pots, lamp shades, cones).
    P.cone = function (cx, cy, z, r0, r1, h, c, mat, sy) {
        sy = sy || 1;
        for (var k = 0; k < Math.round(h); k++) {
            var r = r0 + (r1 - r0) * (h <= 1 ? 0 : k / (h - 1));
            if (r > 0.2) this.cyl(cx, cy, z + k, r, r * sy, 1, c, mat);
        }
        return this;
    };
    P.ellipsoid = function (cx, cy, cz, rx, ry, rz, c, mat) {
        for (var zz = Math.floor(cz - rz); zz <= Math.ceil(cz + rz); zz++) for (var yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++) for (var xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
            var dx = (xx + 0.5 - cx) / rx, dy = (yy + 0.5 - cy) / ry, dz = (zz + 0.5 - cz) / rz;
            if (dx * dx + dy * dy + dz * dz <= 1.0) this.set(xx, yy, zz, c, mat);
        }
        return this;
    };
    // A thick line (bones, rods, cables) from p to q with radius r (square section).
    P.line = function (p, q, r, c, mat) {
        var dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
        var n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) * 2));
        var rr = r || 0.5;
        for (var i = 0; i <= n; i++) {
            var t = i / n, x = p[0] + dx * t, y = p[1] + dy * t, z = p[2] + dz * t;
            for (var zz = Math.floor(z - rr + 0.5); zz <= Math.floor(z + rr - 0.5 + 0.999); zz++)
                for (var yy = Math.floor(y - rr + 0.5); yy <= Math.floor(y + rr - 0.5 + 0.999); yy++)
                    for (var xx = Math.floor(x - rr + 0.5); xx <= Math.floor(x + rr - 0.5 + 0.999); xx++) this.set(xx, yy, zz, c, mat);
        }
        return this;
    };
    P.carve = function (x, y, z, w, d, h) {
        for (var zz = Math.round(z); zz < Math.round(z + h); zz++) for (var yy = Math.round(y); yy < Math.round(y + d); yy++) for (var xx = Math.round(x); xx < Math.round(x + w); xx++) {
            var i = this.idx(xx, yy, zz);
            if (i >= 0) this.v[i] = 0;
        }
        return this;
    };
    // Repaint existing voxels in a box (decals: drawer seams, labels, stripes).
    P.paint = function (x, y, z, w, d, h, c, mat) {
        for (var zz = Math.round(z); zz < Math.round(z + h); zz++) for (var yy = Math.round(y); yy < Math.round(y + d); yy++) for (var xx = Math.round(x); xx < Math.round(x + w); xx++) {
            var i = this.idx(xx, yy, zz);
            if (i >= 0 && this.v[i]) this.v[i] = this._col(c, xx, yy, zz, mat);
        }
        return this;
    };
    // Repaint every voxel through fn(x, y, z, packed) -> colour | null (keep).
    P.each = function (fn) {
        for (var z = 0; z < this.h; z++) for (var y = 0; y < this.d; y++) for (var x = 0; x < this.w; x++) {
            var i = x + this.w * (y + this.d * z), v = this.v[i];
            if (!v) continue;
            var r = fn(x + this.ox, y + this.oy, z + this.oz, v);
            if (r != null) this.v[i] = r === 0 ? 0 : this._col(r, x + this.ox, y + this.oy, z + this.oz, v >>> 24);
        }
        return this;
    };
    // Copy another model into this one at an offset, optionally turned by 0/90/180/270.
    P.put = function (m, dx, dy, dz, rot) {
        rot = ((rot || 0) % 360 + 360) % 360;
        var c = Math.round(Math.cos(rot * Math.PI / 180)), s = Math.round(Math.sin(rot * Math.PI / 180));
        for (var z = 0; z < m.h; z++) for (var y = 0; y < m.d; y++) for (var x = 0; x < m.w; x++) {
            var v = m.v[x + m.w * (y + m.d * z)];
            if (!v) continue;
            var lx = x + m.ox + 0.5, ly = y + m.oy + 0.5;
            var rx = lx * c - ly * s, ry = lx * s + ly * c;
            var i = this.idx(Math.floor(rx + (dx || 0)), Math.floor(ry + (dy || 0)), z + m.oz + (dz || 0));
            if (i >= 0) this.v[i] = v;
        }
        return this;
    };
    // Pixel-font text extruded `depth` voxels, standing up on a face.
    // face: 'south' (readable from the front, letters in x/z at plane y), 'top' (lying, x/y at height z).
    P.text = function (str, x, y, z, face, c, opts) {
        opts = opts || {};
        var scale = opts.scale || 1, depth = opts.depth || 1, glyphs = S.font.glyphs(String(str).toUpperCase());
        var cx = x;
        for (var g = 0; g < glyphs.length; g++) {
            var gl = glyphs[g];
            for (var row = 0; row < 7; row++) for (var col = 0; col < gl.w; col++) {
                if (!gl.rows[row] || !(gl.rows[row] & (1 << (gl.w - 1 - col)))) continue;
                for (var sy = 0; sy < scale; sy++) for (var sx = 0; sx < scale; sx++) for (var k = 0; k < depth; k++) {
                    if (face === 'top') this.set(cx + col * scale + sx, y + row * scale + sy, z + k, c, opts.mat);
                    else this.set(cx + col * scale + sx, y + k, z + (6 - row) * scale + sy, c, opts.mat);
                }
            }
            cx += (gl.w + 1) * scale;
        }
        return this;
    };
    S.textWidth = function (str, scale) {
        var g = S.font.glyphs(String(str).toUpperCase()), w = 0;
        for (var i = 0; i < g.length; i++) w += (g[i].w + 1) * (scale || 1);
        return Math.max(0, w - (scale || 1));
    };

    // ---------- a 5x7 pixel font (A-Z, 0-9, a few signs) ----------
    var FONT = {
        A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
        E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
        I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
        M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
        Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
        U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
        Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
        '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [30, 1, 1, 14, 1, 1, 30],
        '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
        '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
        ' ': [0, 0, 0, 0, 0, 0, 0], '-': [0, 0, 0, 31, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], '!': [4, 4, 4, 4, 4, 0, 4],
        '?': [14, 17, 1, 2, 4, 0, 4], ':': [0, 12, 12, 0, 12, 12, 0], '&': [12, 18, 20, 8, 21, 18, 13], '/': [1, 1, 2, 4, 8, 16, 16],
        "'": [4, 4, 8, 0, 0, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0], '#': [10, 10, 31, 10, 31, 10, 10], '_': [0, 0, 0, 0, 0, 0, 31]
    };
    S.font = {
        glyphs: function (s) {
            var out = [];
            for (var i = 0; i < s.length; i++) {
                var r = FONT[s[i]] || FONT['?'];
                out.push({ w: s[i] === ' ' ? 3 : (s[i] === '.' || s[i] === ':' || s[i] === '!' || s[i] === "'") ? 3 : 5,
                           rows: s[i] === ' ' ? [0, 0, 0, 0, 0, 0, 0] : (s[i] === '.' || s[i] === ':' || s[i] === '!' || s[i] === "'") ? r.map(function (v) { return v >> 1 & 7; }) : r });
            }
            return out;
        }
    };

    // ---------- baking: a model -> its slice strip ----------
    // Normals come from the gradient of the occupancy box-blurred over 5x5x5, so
    // voxels up to 2 px inside a face carry that face's normal (side faces of a
    // stack are made of slice edges, which show voxels just inside the surface).
    // AO samples the blurred occupancy a step out along the normal.
    function blur1(src, out, w, d, h, axis) {
        var R = 2, sx = 1, sy = w, sz = w * d, n = axis === 0 ? w : axis === 1 ? d : h, st = axis === 0 ? sx : axis === 1 ? sy : sz;
        var A = axis === 0 ? d : w, B = axis === 2 ? d : h, sa = axis === 0 ? sy : sx, sb = axis === 2 ? sy : sz;
        for (var b = 0; b < B; b++) for (var a = 0; a < A; a++) {
            var base = a * sa + b * sb, acc = 0, k;
            for (k = -R; k <= R; k++) if (k >= 0 && k < n) acc += src[base + k * st];
            for (var i = 0; i < n; i++) {
                out[base + i * st] = acc;
                var add = i + R + 1, sub = i - R;
                if (add < n) acc += src[base + add * st];
                if (sub >= 0) acc -= src[base + sub * st];
            }
        }
    }
    P.bake = function () {
        var w = this.w, d = this.d, h = this.h, n = w * d * h, v = this.v;
        // trim empty z at both ends
        var zmin = h, zmax = -1, xmin = w, xmax = -1, ymin = d, ymax = -1;
        for (var z = 0; z < h; z++) for (var y = 0; y < d; y++) for (var x = 0; x < w; x++) {
            if (!v[x + w * (y + d * z)]) continue;
            if (z < zmin) zmin = z; if (z > zmax) zmax = z;
            if (x < xmin) xmin = x; if (x > xmax) xmax = x;
            if (y < ymin) ymin = y; if (y > ymax) ymax = y;
        }
        if (zmax < 0) return { empty: true, slices: 0 };
        var occ = new Float32Array(n), t1 = new Float32Array(n), t2 = new Float32Array(n);
        for (var i = 0; i < n; i++) occ[i] = v[i] ? 1 : 0;
        blur1(occ, t1, w, d, h, 0); blur1(t1, t2, w, d, h, 1); blur1(t2, t1, w, d, h, 2);   // t1 = 5x5x5 sums (0..125)
        var bw = xmax - xmin + 1, bd = ymax - ymin + 1, bh = zmax - zmin + 1;
        var color = new Uint8Array(bw * bd * bh * 4), aux = new Uint8Array(bw * bd * bh * 4);
        var at = function (x, y, z) {
            if (x < 0 || y < 0 || z < 0 || x >= w || y >= d || z >= h) return 0;
            return t1[x + w * (y + d * z)];
        };
        var surf = 0;
        for (z = zmin; z <= zmax; z++) for (y = ymin; y <= ymax; y++) for (x = xmin; x <= xmax; x++) {
            var vi = x + w * (y + d * z), val = v[vi];
            if (!val) continue;
            var o = ((x - xmin) + bw * ((y - ymin) + bd * (z - zmin))) * 4;
            color[o] = val & 255; color[o + 1] = (val >>> 8) & 255; color[o + 2] = (val >>> 16) & 255; color[o + 3] = (val >>> 24) & 255;
            var gx = at(x - 1, y, z) - at(x + 1, y, z), gy = at(x, y - 1, z) - at(x, y + 1, z), gz = at(x, y, z - 1) - at(x, y, z + 1);
            // the open sky above the top slice and the floor below z 0 read as empty / solid
            if (z + this.oz <= 1 && gz < 0) gz *= 0.25;
            var m = Math.sqrt(gx * gx + gy * gy + gz * gz);
            var nx = 0, ny = 0, nz = 1;
            if (m > 0.5) { nx = gx / m; ny = gy / m; nz = gz / m; }
            // AO: how full the space is 1.5 px out along the normal (125 = solid)
            var px = Math.round(x + nx * 1.6), py = Math.round(y + ny * 1.6), pz = Math.round(z + nz * 1.6);
            var full = at(px, py, pz) / 125;
            var ao = 1 - Math.max(0, full - 0.18) * 0.62;
            if (z + this.oz <= 1) ao *= 0.9;     // contact with the floor
            aux[o] = Math.round(nx * 127 + 128); aux[o + 1] = Math.round(ny * 127 + 128); aux[o + 2] = Math.round(nz * 127 + 128);
            aux[o + 3] = Math.round(Math.max(0.3, Math.min(1, ao)) * 255);
            surf++;
        }
        // Inside voxels next to a side face take that face's look (colour, normal,
        // AO): a turned slice samples a texel or two inside its edge, which would
        // otherwise show the dark interior as vertical stripes on every side face.
        var solid = function (x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < w && y < d && z < h && !!v[x + w * (y + d * z)]; };
        var side = function (x, y, z) { return !solid(x - 1, y, z) || !solid(x + 1, y, z) || !solid(x, y - 1, z) || !solid(x, y + 1, z); };
        var RING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
            [2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2], [2, 2], [2, -2], [-2, 2], [-2, -2]];
        // A display, glass or light face is never copied inward (it would show
        // through the back of a monitor): plain materials first, those only when
        // nothing else is near.
        var srcC = color.slice(), srcA = aux.slice();
        var special = function (o) { var a = srcC[o + 3]; return a === MAT.SCREEN || a === MAT.GLASS || a === MAT.EMIT; };
        for (z = zmin; z <= zmax; z++) for (y = ymin; y <= ymax; y++) for (x = xmin; x <= xmax; x++) {
            if (!v[x + w * (y + d * z)] || side(x, y, z) || !solid(x, y, z + 1)) continue;
            var to = ((x - xmin) + bw * ((y - ymin) + bd * (z - zmin))) * 4, pick = -1;
            for (var pass = 0; pass < 2 && pick < 0; pass++) {
                for (var r = 0; r < RING.length; r++) {
                    var xx = x + RING[r][0], yy = y + RING[r][1];
                    if (!solid(xx, yy, z) || !side(xx, yy, z)) continue;
                    var fr = ((xx - xmin) + bw * ((yy - ymin) + bd * (z - zmin))) * 4;
                    if (pass === 0 && special(fr)) continue;
                    pick = fr; break;
                }
            }
            if (pick < 0 || (special(pick) && !special(to))) continue;
            for (var c4 = 0; c4 < 4; c4++) { color[to + c4] = srcC[pick + c4]; aux[to + c4] = srcA[pick + c4]; }
        }
        return {
            empty: false, w: bw, d: bd, slices: bh,
            ox: this.ox + xmin, oy: this.oy + ymin, oz: this.oz + zmin,   // local position of texel (0, 0) of slice 0
            color: color, aux: aux, voxels: surf
        };
    };

    // ---------- model registry ----------
    // Asset files register builders: S.def(type, fn(item, opts) -> Model, keyFn?)
    // keyFn(item, opts) returns the cache key (colour slots, variant, states).
    S.defs = Object.create(null);
    // S.def(type, build, key?, opts?) or S.def(type, { build, key, flat, surfaceZ, animate, mount })
    S.def = function (type, build, key, opts) {
        var d = typeof build === 'function' ? Object.assign({ build: build, key: key || null }, opts || {}) : Object.assign({ key: null }, build);
        S.defs[type] = d;
    };
    S.has = function (type) { return !!S.defs[type]; };
})();
