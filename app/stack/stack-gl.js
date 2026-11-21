// Sprite-stack renderer (WebGL2). Every slice of every stack is one instanced
// quad: rotated by the object's turn, placed on the floor plane, squashed for
// the camera pitch and lifted by its height. A depth buffer sorts whole scenes
// per pixel (no painter's order to get wrong when the camera turns), a post pass
// draws one outline round each finished stack, and the frame is rendered at
// about one pixel per world px, then scaled up with nearest filtering.
//
// Camera: view = R(yaw) * (world - centre); screen = (view.x, view.y * squash -
// z * spacing) * scale. The classic office camera is yaw 0, squash 1, spacing 1.
// Depth (bigger = nearer) = view.y * spacing + z * squash.
(function () {
    'use strict';
    var S = window.VOStack = window.VOStack || {};

    var LAYER = 1024;          // atlas layer size (texels)
    var FLOATS = 16;           // per slice instance

    var VS_SLICE = '#version 300 es\n' +
        'precision highp float;\n' +
        'layout(location=0) in vec2 a_corner;\n' +
        'layout(location=1) in vec4 a_pos;\n' +     // world x, y, slice z, turn (rad)
        'layout(location=2) in vec4 a_uv;\n' +      // atlas texel origin u, v; slice w, d
        'layout(location=3) in vec4 a_lo;\n' +      // local origin x, y; layer; screen state
        'layout(location=4) in vec4 a_obj;\n' +     // object id, alpha, tint (rgb24), tint amount + 2 * desaturate
        'uniform vec4 u_cam;\n' +                    // centre x, y, cos yaw, sin yaw
        'uniform vec4 u_proj;\n' +                   // squash, spacing, scale (fbo px per world px), shadow mode
        'uniform vec4 u_view;\n' +                   // fbo w, h, offset x, y (fbo px of the centre)
        'uniform vec2 u_sun;\n' +                    // shadow offset per unit of height (world px)
        'out vec3 v_uv;\n' +
        'out vec3 v_world;\n' +
        'flat out vec4 v_obj;\n' +
        'flat out vec4 v_misc;\n' +                  // cos turn, sin turn, screen state, z
        'flat out vec4 v_rect;\n' +                  // this slice's texels in the atlas: x, y, w, d
        'void main() {\n' +
        '  vec2 local = a_lo.xy + a_corner * a_uv.zw;\n' +
        '  float c = cos(a_pos.w), s = sin(a_pos.w);\n' +
        '  vec2 w = a_pos.xy + vec2(local.x * c - local.y * s, local.x * s + local.y * c);\n' +
        '  float z = a_pos.z;\n' +
        '  if (u_proj.w > 0.5) { w += u_sun * z; z = 0.0; }\n' +
        '  vec2 d = w - u_cam.xy;\n' +
        '  vec2 v = vec2(d.x * u_cam.z - d.y * u_cam.w, d.x * u_cam.w + d.y * u_cam.z);\n' +
        // the object's anchor lands on a whole fbo pixel and each slice lifts a whole pixel (no shimmer)
        '  vec2 ad = a_pos.xy - u_cam.xy;\n' +
        '  vec2 av = vec2(ad.x * u_cam.z - ad.y * u_cam.w, ad.x * u_cam.w + ad.y * u_cam.z);\n' +
        '  vec2 ap = vec2(av.x, av.y * u_proj.x) * u_proj.z + u_view.zw;\n' +
        '  vec2 snap = floor(ap + 0.5) - ap;\n' +
        '  float lift = floor(z * u_proj.y * u_proj.z + 0.5);\n' +
        '  vec2 sp = vec2(v.x, v.y * u_proj.x) * u_proj.z + u_view.zw + snap - vec2(0.0, lift);\n' +
        '  float depth = v.y * u_proj.y + z * u_proj.x;\n' +
        '  gl_Position = vec4(sp.x / u_view.x * 2.0 - 1.0, 1.0 - sp.y / u_view.y * 2.0, clamp(-depth / 8192.0, -1.0, 1.0), 1.0);\n' +
        '  v_uv = vec3(a_uv.xy + a_corner * a_uv.zw, a_lo.z);\n' +
        '  v_rect = a_uv;\n' +
        '  v_world = vec3(w, a_pos.z);\n' +
        '  v_obj = a_obj;\n' +
        '  v_misc = vec4(c, s, a_lo.w, a_pos.z);\n' +
        '}\n';

    var FS_SLICE = '#version 300 es\n' +
        'precision highp float;\n' +
        'precision highp sampler2DArray;\n' +
        'uniform sampler2DArray u_color;\n' +
        'uniform sampler2DArray u_aux;\n' +
        'uniform vec3 u_sunDir;\n' +                 // toward the sun, world space (x right, y south, z up)
        'uniform vec3 u_lit;\n' +                    // band multipliers (hue shifted)
        'uniform vec3 u_mid;\n' +
        'uniform vec3 u_shd;\n' +
        'uniform vec3 u_ambient;\n' +                // whole-scene light (night is dark blue)
        'uniform vec4 u_sky0;\n' +                   // window glass: low sky colour, a = rain
        'uniform vec4 u_sky1;\n' +                   // high sky colour, a = stars
        'uniform float u_time;\n' +
        'uniform float u_night;\n' +                 // 0 day .. 1 night (emissive glow)
        'uniform int u_nLights;\n' +
        'uniform vec4 u_lights[16];\n' +             // x, y, z, radius
        'uniform vec4 u_lightCol[16];\n' +           // rgb, strength
        'uniform int u_shadowPass;\n' +
        'uniform vec4 u_shadowCol;\n' +
        'in vec3 v_uv;\n' +
        'in vec3 v_world;\n' +
        'flat in vec4 v_obj;\n' +
        'flat in vec4 v_misc;\n' +
        'flat in vec4 v_rect;\n' +
        'layout(location=0) out vec4 o_color;\n' +
        'layout(location=1) out vec4 o_id;\n' +
        'float bayer4(vec2 p) {\n' +
        '  int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));\n' +
        '  int i = x + y * 4;\n' +
        '  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);\n' +
        '  return (float(m[i]) + 0.5) / 16.0;\n' +
        '}\n' +
        'float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }\n' +
        'void main() {\n' +
        '  ivec2 r0 = ivec2(v_rect.xy + 0.5), r1 = r0 + ivec2(v_rect.zw + 0.5) - 1;\n' +
        '  ivec3 t = ivec3(clamp(ivec2(floor(v_uv.xy)), r0, r1), int(v_uv.z + 0.5));\n' +
        '  vec4 col = texelFetch(u_color, t, 0);\n' +
        '  if (col.a < 0.01) discard;\n' +
        '  if (v_obj.y < 0.999 && bayer4(gl_FragCoord.xy) >= v_obj.y) discard;\n' +
        '  if (u_shadowPass == 1) { o_color = u_shadowCol; o_id = vec4(0.0); return; }\n' +
        '  int mat = int(col.a * 255.0 + 0.5);\n' +
        '  vec4 aux = texelFetch(u_aux, t, 0);\n' +
        '  vec3 nl = aux.xyz * 2.0 - 1.0;\n' +
        '  vec3 n = vec3(nl.x * v_misc.x - nl.y * v_misc.y, nl.x * v_misc.y + nl.y * v_misc.x, nl.z);\n' +
        '  float ao = aux.w;\n' +
        '  vec3 base = col.rgb;\n' +
        '  float tintAmt = fract(v_obj.w);\n' +
        '  float desat = floor(v_obj.w) * 0.5;\n' +
        '  float tr = floor(v_obj.z / 65536.0), tg = floor(mod(v_obj.z, 65536.0) / 256.0), tb = mod(v_obj.z, 256.0);\n' +
        '  vec3 rgb;\n' +
        '  bool glow = false;\n' +
        '  if (mat == 240) {\n' +                    // window glass: the sky of the hour
        '    float h = clamp(v_misc.w / 70.0, 0.0, 1.0);\n' +
        '    rgb = mix(u_sky0.rgb, u_sky1.rgb, h);\n' +
        '    if (u_sky1.a > 0.5 && h21(floor(v_world.xy * 0.5) + floor(v_misc.w)) > 0.985) rgb = vec3(0.9, 0.92, 1.0);\n' +
        '    if (u_sky0.a > 0.5) { float r = fract((v_world.x * 0.37 + v_misc.w * 0.9 + u_time * 9.0) / 7.0); if (r < 0.12) rgb = mix(rgb, vec3(0.75, 0.85, 1.0), 0.6); }\n' +
        '    rgb = mix(rgb, base, 0.18);\n' +
        '    glow = true;\n' +
        '  } else if (mat == 245) {\n' +             // a display
        '    float st = v_misc.z;\n' +
        '    vec2 sp = floor(v_world.xy - vec2(0.0, v_misc.w));\n' +
        '    if (st < 0.5) { rgb = base * 0.55 * u_ambient + vec3(0.02, 0.025, 0.04); }\n' +
        '    else if (st < 1.5) {\n' +             // code on screen: lines scroll
        '      float row = floor((v_misc.w + floor(u_time * 1.5)) * 1.0);\n' +
        '      float len = h21(vec2(row, floor(v_obj.x))) * 0.8 + 0.1;\n' +
        '      float colx = fract(abs(v_world.x + v_world.y) / 26.0);\n' +
        '      bool on = mod(row, 2.0) < 1.0 && colx < len;\n' +
        '      rgb = vec3(0.10, 0.16, 0.30);\n' +
        '      if (on) rgb = mix(vec3(0.45, 0.85, 1.0), vec3(0.6, 1.0, 0.6), step(0.6, h21(vec2(row, 3.0))));\n' +
        '      glow = true;\n' +
        '    } else if (st < 2.5) { rgb = vec3(0.16, 0.30, 0.55) + 0.05 * sin(u_time + v_world.x * 0.2); glow = true; }\n' +
        '    else { float k = 0.5 + 0.5 * sin(u_time * 0.7 + v_world.x * 0.15 + v_misc.w * 0.2); rgb = mix(vec3(0.95, 0.45, 0.25), vec3(0.25, 0.55, 0.95), k); glow = true; }\n' +
        '  } else if (mat == 250) {\n' +
        '    rgb = base * (1.0 + 0.35 * u_night); glow = true;\n' +
        '  } else {\n' +
        '    float ndl = dot(n, u_sunDir);\n' +
        '    vec3 band = ndl > 0.38 ? u_lit : (ndl > -0.12 ? u_mid : u_shd);\n' +
        '    if (mat == 230) band = ndl > 0.1 ? mix(u_lit, u_mid, 0.4) : mix(u_mid, u_shd, 0.6);\n' +
        '    rgb = base * band * mix(0.55, 1.0, ao);\n' +
        '    if (mat == 235) { float sp = pow(max(0.0, dot(normalize(n + vec3(0.0, 0.35, 0.0)), normalize(u_sunDir + vec3(0.0, 0.8, 0.6)))), 12.0); rgb += vec3(0.22) * step(0.5, sp); }\n' +
        '    vec3 lightSum = u_ambient;\n' +
        '    for (int i = 0; i < 16; i++) {\n' +
        '      if (i >= u_nLights) break;\n' +
        '      vec3 L = u_lights[i].xyz - v_world;\n' +
        '      float dist = length(L);\n' +
        '      float f = clamp(1.0 - dist / u_lights[i].w, 0.0, 1.0);\n' +
        '      if (f <= 0.0) continue;\n' +
        '      float nd = max(0.15, dot(n, L / max(dist, 0.001)));\n' +
        '      lightSum += u_lightCol[i].rgb * u_lightCol[i].a * f * f * nd;\n' +
        '    }\n' +
        '    rgb *= lightSum;\n' +
        '  }\n' +
        '  if (desat > 0.0) { float l = dot(rgb, vec3(0.3, 0.59, 0.11)); rgb = mix(rgb, vec3(l) * vec3(0.92, 0.95, 1.05), desat); }\n' +
        '  if (tintAmt > 0.0) rgb = mix(rgb, vec3(tr, tg, tb) / 255.0, tintAmt);\n' +
        '  o_color = vec4(rgb, 1.0);\n' +
        '  float id = v_obj.x;\n' +
        '  o_id = vec4(mod(id, 256.0) / 255.0, mod(floor(id / 256.0), 256.0) / 255.0, floor(id / 65536.0) / 255.0, glow ? 1.0 : 0.6);\n' +
        '}\n';

    // Floor: one textured quad of the office floor (+ decals), on z = 0.
    var VS_FLOOR = '#version 300 es\n' +
        'precision highp float;\n' +
        'layout(location=0) in vec2 a_corner;\n' +
        'uniform vec4 u_rect;\n' +                   // world x, y, w, h
        'uniform vec4 u_texRect;\n' +                // texture rect (0..1)
        'uniform float u_z;\n' +
        'uniform vec4 u_cam;\n' +
        'uniform vec4 u_proj;\n' +
        'uniform vec4 u_view;\n' +
        'out vec2 v_tc;\n' +
        'out vec2 v_world;\n' +
        'void main() {\n' +
        '  vec2 w = u_rect.xy + a_corner * u_rect.zw;\n' +
        '  vec2 d = w - u_cam.xy;\n' +
        '  vec2 v = vec2(d.x * u_cam.z - d.y * u_cam.w, d.x * u_cam.w + d.y * u_cam.z);\n' +
        '  vec2 sp = vec2(v.x, v.y * u_proj.x - u_z * u_proj.y) * u_proj.z + u_view.zw;\n' +
        '  float depth = v.y * u_proj.y + u_z * u_proj.x - 0.5;\n' +
        '  gl_Position = vec4(sp.x / u_view.x * 2.0 - 1.0, 1.0 - sp.y / u_view.y * 2.0, clamp(-depth / 8192.0, -1.0, 1.0), 1.0);\n' +
        '  v_tc = u_texRect.xy + a_corner * u_texRect.zw;\n' +
        '  v_world = w;\n' +
        '}\n';
    var FS_FLOOR = '#version 300 es\n' +
        'precision highp float;\n' +
        'uniform sampler2D u_tex;\n' +
        'uniform vec3 u_ambient;\n' +
        'uniform int u_nLights;\n' +
        'uniform vec4 u_lights[16];\n' +
        'uniform vec4 u_lightCol[16];\n' +
        'uniform float u_mul;\n' +
        'in vec2 v_tc;\n' +
        'in vec2 v_world;\n' +
        'layout(location=0) out vec4 o_color;\n' +
        'layout(location=1) out vec4 o_id;\n' +
        'void main() {\n' +
        '  vec4 c = texture(u_tex, v_tc);\n' +
        '  if (c.a < 0.01) discard;\n' +
        '  vec3 lightSum = u_ambient;\n' +
        '  for (int i = 0; i < 16; i++) {\n' +
        '    if (i >= u_nLights) break;\n' +
        '    vec3 L = u_lights[i].xyz - vec3(v_world, 0.0);\n' +
        '    float f = clamp(1.0 - length(L) / u_lights[i].w, 0.0, 1.0);\n' +
        '    lightSum += u_lightCol[i].rgb * u_lightCol[i].a * f * f * 0.9;\n' +
        '  }\n' +
        '  o_color = vec4(c.rgb * u_mul * lightSum, c.a);\n' +
        '  o_id = vec4(0.0, 0.0, 0.0, 0.2);\n' +
        '}\n';

    // Post: one outline round every finished stack (the background side of a
    // silhouette, or a farther stack's pixel next to a nearer one), glow halos.
    var VS_POST = '#version 300 es\n' +
        'layout(location=0) in vec2 a_corner;\n' +
        'out vec2 v_tc;\n' +
        'void main() { v_tc = a_corner; gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }\n';
    var FS_POST = '#version 300 es\n' +
        'precision highp float;\n' +
        'uniform sampler2D u_col;\n' +
        'uniform sampler2D u_id;\n' +
        'uniform sampler2D u_depth;\n' +
        'uniform vec2 u_px;\n' +
        'uniform vec3 u_outline;\n' +
        'uniform float u_night;\n' +
        'in vec2 v_tc;\n' +
        'out vec4 o;\n' +
        'float idOf(vec4 c) { return floor(c.r * 255.0 + 0.5) + floor(c.g * 255.0 + 0.5) * 256.0 + floor(c.b * 255.0 + 0.5) * 65536.0; }\n' +
        'void main() {\n' +
        '  vec4 c = texture(u_col, v_tc);\n' +
        '  vec4 ic = texture(u_id, v_tc);\n' +
        '  float id = idOf(ic);\n' +
        '  float dp = texture(u_depth, v_tc).r;\n' +
        '  bool obj = ic.a > 0.5;\n' +
        '  vec2 offs[4] = vec2[4](vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));\n' +
        '  float best = 2.0; vec3 bestCol = vec3(0.0); bool edge = false; float glow = 0.0; vec3 glowCol = vec3(0.0);\n' +
        '  for (int i = 0; i < 4; i++) {\n' +
        '    vec2 tc = v_tc + offs[i] * u_px;\n' +
        '    vec4 qi = texture(u_id, tc);\n' +
        '    if (qi.a < 0.5) continue;\n' +
        '    float qid = idOf(qi);\n' +
        '    float qd = texture(u_depth, tc).r;\n' +
        '    if (qi.a > 0.9 && !(ic.a > 0.9)) { glow += 1.0; glowCol += texture(u_col, tc).rgb; }\n' +
        '    if (qid == id && obj) continue;\n' +
        '    if (!obj || qd < dp - 0.00025) {\n' +
        '      if (qd < best) { best = qd; bestCol = texture(u_col, tc).rgb; edge = true; }\n' +
        '    }\n' +
        '  }\n' +
        '  if (edge) { c.rgb = mix(u_outline, bestCol * 0.32 + u_outline * 0.5, 0.45); c.a = 1.0; }\n' +
        '  else if (glow > 0.0 && u_night > 0.15) { c.rgb = c.a > 0.0 ? c.rgb + glowCol / glow * 0.35 * u_night : glowCol / glow; c.a = max(c.a, 0.55 * u_night); }\n' +
        '  o = c;\n' +
        '}\n';

    function compile(gl, type, src) {
        var sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('[stack] shader: ' + gl.getShaderInfoLog(sh));
        return sh;
    }
    function program(gl, vs, fs) {
        var p = gl.createProgram();
        gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('[stack] link: ' + gl.getProgramInfoLog(p));
        var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (var i = 0; i < n; i++) { var info = gl.getActiveUniform(p, i), name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
        return { p: p, u: u };
    }

    // ---------- the atlas: a texture array of LAYER x LAYER pages ----------
    // Two pools: 'static' (furniture, walls: reset when the layout is rebuilt)
    // and 'dynamic' (people, pets, animated pieces: least recently used blocks
    // go when the pool is full). Shelf packing within each page.
    function Atlas(gl) {
        this.gl = gl;
        this.layers = 0;
        this.cpuC = []; this.cpuA = [];
        this.pages = [];            // { pool, shelves: [{y, h, x}], used, stamp }
        this.texC = gl.createTexture(); this.texA = gl.createTexture();
        this.maxLayers = Math.min(64, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) || 64);
        this._grow(4);
        this.dirty = {};
        this.now = 0;               // the frame being drawn (set by the renderer's begin)
    }
    Atlas.prototype._grow = function (n) {
        var gl = this.gl, old = this.layers;
        n = Math.min(this.maxLayers, n);
        if (n <= old) return false;
        for (var i = old; i < n; i++) { this.cpuC.push(new Uint8Array(LAYER * LAYER * 4)); this.cpuA.push(new Uint8Array(LAYER * LAYER * 4)); }
        this.layers = n;
        [[this.texC, this.cpuC], [this.texA, this.cpuA]].forEach(function (pair) {
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, pair[0]);
            gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, LAYER, LAYER, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            for (var l = 0; l < old; l++) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, LAYER, LAYER, 1, gl.RGBA, gl.UNSIGNED_BYTE, pair[1][l]);
        });
        return true;
    };
    // The dynamic pool (people, poses, the clock) recycles its pages; see _evictDynamic.
    var POOL_PAGES = { 'static': 40, dynamic: 8 };
    Atlas.prototype._newPage = function (pool) {
        var used = this.pages.length, mine = 0;
        for (var p = 0; p < used; p++) if (this.pages[p].pool === pool) mine++;
        if (mine >= (POOL_PAGES[pool] || 8)) return -1;
        // a cleared page of another pool is not reused (pools keep their pages)
        if (used >= this.layers && !this._grow(this.layers * 2)) return -1;
        this.pages.push({ pool: pool, shelves: [], top: 0, stamp: 0, blocks: [] });
        return this.pages.length - 1;
    };
    Atlas.prototype._fit = function (page, bw, bh) {
        var P = this.pages[page];
        for (var i = 0; i < P.shelves.length; i++) {
            var sh = P.shelves[i];
            if (bh <= sh.h && sh.x + bw <= LAYER) { var r = { x: sh.x, y: sh.y }; sh.x += bw; return r; }
        }
        if (P.top + bh <= LAYER && bw <= LAYER) { P.shelves.push({ y: P.top, h: bh, x: bw }); var q = { x: 0, y: P.top }; P.top += bh; return q; }
        return null;
    };
    // Place a baked model (slices laid out in a grid) -> mesh handle, or null.
    Atlas.prototype.add = function (baked, pool, owner) {
        if (!baked || baked.empty) return null;
        var w = baked.w, d = baked.d, n = baked.slices;
        if (w > LAYER || d > LAYER) return null;
        var cols = Math.max(1, Math.min(n, Math.floor(LAYER / w)));
        var rows = Math.ceil(n / cols);
        var bw = cols * w, bh = rows * d;
        if (bh > LAYER) { cols = Math.ceil(n / Math.floor(LAYER / d)); rows = Math.ceil(n / cols); bw = cols * w; bh = rows * d; if (bw > LAYER) return null; }
        var spot = null, page = -1;
        for (var p = 0; p < this.pages.length && !spot; p++) {
            if (this.pages[p].pool !== pool) continue;
            spot = this._fit(p, bw, bh); if (spot) page = p;
        }
        if (!spot) {
            page = this._newPage(pool);
            if (page < 0 && pool === 'dynamic') page = this._evictDynamic();
            if (page < 0 && pool === 'dynamic') page = this._compactDynamic(bw, bh);
            if (page < 0) return null;
            spot = this._fit(page, bw, bh);
            if (!spot) return null;
        }
        var C = this.cpuC[page], A = this.cpuA[page], slices = [];
        for (var k = 0; k < n; k++) {
            var cx = spot.x + (k % cols) * w, cy = spot.y + Math.floor(k / cols) * d;
            for (var y = 0; y < d; y++) {
                var src = ((y + d * k) * w) * 4, dst = ((cy + y) * LAYER + cx) * 4;
                C.set(baked.color.subarray(src, src + w * 4), dst);
                A.set(baked.aux.subarray(src, src + w * 4), dst);
            }
            slices.push(cx, cy);
        }
        this.dirty[page] = true;
        var mesh = { layer: page, w: w, d: d, n: n, ox: baked.ox, oy: baked.oy, oz: baked.oz, uv: slices, owner: owner || null, alive: true,
            bx: spot.x, by: spot.y, bw: bw, bh: bh, cols: cols, stamp: this.now };
        this.pages[page].blocks.push(mesh);
        this.pages[page].stamp = Math.max(this.pages[page].stamp, this.now);
        return mesh;
    };
    // A mesh is "hot" when it was drawn in this frame or the last one (or made in
    // this frame): the frame being built may already hold it, so it is never dropped.
    Atlas.prototype._hot = function (m) { return m.stamp >= this.now - 1; };
    Atlas.prototype._evictDynamic = function () {
        // a dynamic page none of whose meshes is hot (the one used longest ago) is
        // cleared and reused; a page in use on screen is never cleared (that made
        // people vanish for a frame: the flicker of a full pool)
        var best = -1, stamp = Infinity;
        for (var p = 0; p < this.pages.length; p++) {
            var P = this.pages[p];
            if (P.pool === 'dynamic' && P.stamp < this.now - 1 && P.stamp < stamp) { stamp = P.stamp; best = p; }
        }
        if (best < 0) return -1;
        this.clearPage(best);
        return best;
    };
    // Every dynamic page holds something on screen: the page with the least hot
    // area keeps its hot meshes (their texels moved, the mesh objects kept, so
    // nothing blinks) and drops the rest; -1 when no page would free enough room.
    Atlas.prototype._compactDynamic = function (needW, needH) {
        var best = -1, bestHot = Infinity, self = this;
        for (var p = 0; p < this.pages.length; p++) {
            var P = this.pages[p];
            if (P.pool !== 'dynamic') continue;
            var hot = 0;
            P.blocks.forEach(function (m) { if (self._hot(m)) hot += m.bw * m.bh; });
            if (hot < bestHot) { bestHot = hot; best = p; }
        }
        if (best < 0 || bestHot + needW * needH > LAYER * LAYER * 0.7) return -1;
        var page = best, Pg = this.pages[page], C = this.cpuC[page], A = this.cpuA[page];
        var keep = [], drop = [];
        Pg.blocks.forEach(function (m) { (self._hot(m) ? keep : drop).push(m); });
        // copy the hot blocks out
        var saved = keep.map(function (m) {
            var c = new Uint8Array(m.bw * m.bh * 4), a = new Uint8Array(m.bw * m.bh * 4);
            for (var y = 0; y < m.bh; y++) {
                var src = ((m.by + y) * LAYER + m.bx) * 4;
                c.set(C.subarray(src, src + m.bw * 4), y * m.bw * 4);
                a.set(A.subarray(src, src + m.bw * 4), y * m.bw * 4);
            }
            return { m: m, c: c, a: a };
        });
        drop.forEach(function (m) { m.alive = false; });
        Pg.blocks = []; Pg.shelves = []; Pg.top = 0;
        C.fill(0); A.fill(0);
        // repack them, tallest first, at their new spots
        saved.sort(function (u, v) { return v.m.bh - u.m.bh; });
        saved.forEach(function (sv) {
            var m = sv.m, spot = self._fit(page, m.bw, m.bh);
            if (!spot) { m.alive = false; return; }
            for (var y = 0; y < m.bh; y++) {
                var dst = ((spot.y + y) * LAYER + spot.x) * 4;
                C.set(sv.c.subarray(y * m.bw * 4, (y + 1) * m.bw * 4), dst);
                A.set(sv.a.subarray(y * m.bw * 4, (y + 1) * m.bw * 4), dst);
            }
            for (var k = 0; k < m.n; k++) { m.uv[2 * k] = spot.x + (k % m.cols) * m.w; m.uv[2 * k + 1] = spot.y + Math.floor(k / m.cols) * m.d; }
            m.bx = spot.x; m.by = spot.y;
            Pg.blocks.push(m);
        });
        this.dirty[page] = true;
        return page;
    };
    Atlas.prototype.clearPage = function (p) {
        var P = this.pages[p];
        P.blocks.forEach(function (m) { m.alive = false; });
        P.blocks = []; P.shelves = []; P.top = 0;
        this.cpuC[p].fill(0); this.cpuA[p].fill(0);
        this.dirty[p] = true;
    };
    Atlas.prototype.resetPool = function (pool) {
        for (var p = 0; p < this.pages.length; p++) if (this.pages[p].pool === pool) this.clearPage(p);
    };
    Atlas.prototype.touch = function (mesh, stamp) { if (mesh) { this.pages[mesh.layer].stamp = stamp; mesh.stamp = stamp; } };
    Atlas.prototype.flush = function () {
        var gl = this.gl, self = this;
        Object.keys(this.dirty).forEach(function (k) {
            var l = +k;
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, self.texC);
            gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, LAYER, LAYER, 1, gl.RGBA, gl.UNSIGNED_BYTE, self.cpuC[l]);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, self.texA);
            gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, l, LAYER, LAYER, 1, gl.RGBA, gl.UNSIGNED_BYTE, self.cpuA[l]);
        });
        this.dirty = {};
    };

    // ---------- the renderer ----------
    function Renderer() {
        var canvas = this.canvas = document.createElement('canvas');
        canvas.width = 4; canvas.height = 4;
        var gl = this.gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
        if (!gl) throw new Error('[stack] no WebGL2');
        this.atlas = new Atlas(gl);
        this.pSlice = program(gl, VS_SLICE, FS_SLICE);
        this.pFloor = program(gl, VS_FLOOR, FS_FLOOR);
        this.pPost = program(gl, VS_POST, FS_POST);
        // unit quad
        this.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
        this.inst = gl.createBuffer();
        this.instData = new Float32Array(FLOATS * 4096);
        this.count = 0;
        this.vaoSlice = gl.createVertexArray();
        gl.bindVertexArray(this.vaoSlice);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
        for (var a = 0; a < 4; a++) {
            gl.enableVertexAttribArray(1 + a);
            gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, FLOATS * 4, a * 16);
            gl.vertexAttribDivisor(1 + a, 1);
        }
        this.vaoQuad = gl.createVertexArray();
        gl.bindVertexArray(this.vaoQuad);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this.fbo = null; this.fw = 0; this.fh = 0;
        this.floorTex = gl.createTexture(); this.floorKey = null;
        this.decalTex = gl.createTexture();
        this.stamp = 0;
    }
    S.Renderer = Renderer;
    var R = Renderer.prototype;

    R._ensureFbo = function (w, h) {
        var gl = this.gl;
        if (this.fbo && this.fw === w && this.fh === h) return;
        if (this.fbo) { gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.tCol); gl.deleteTexture(this.tId); gl.deleteTexture(this.tDepth); }
        this.fw = w; this.fh = h;
        this.canvas.width = w; this.canvas.height = h;
        var mk = function (internal, fmt, type, filter) {
            var t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, type, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        this.tCol = mk(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
        this.tId = mk(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
        this.tDepth = mk(gl.DEPTH24_STENCIL8, gl.DEPTH_STENCIL, gl.UNSIGNED_INT_24_8, gl.NEAREST);
        this.fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tCol, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.tId, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, this.tDepth, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };

    // Upload a 2D canvas (the floor art in world px) as the floor texture.
    R.setFloor = function (canvasOrNull, key) {
        if (key && key === this.floorKey) return;
        this.floorKey = key || null;
        if (!canvasOrNull) { this.hasFloor = false; return; }
        var gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.floorTex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasOrNull);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.hasFloor = true;
    };
    R.setDecals = function (canvasOrNull) {
        var gl = this.gl;
        if (!canvasOrNull) { this.hasDecals = false; return; }
        gl.bindTexture(gl.TEXTURE_2D, this.decalTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasOrNull);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.hasDecals = true;
    };

    // Build the frame's instance list. items: [{ mesh, x, y, z, turn, id, alpha,
    // tint, tintAmt, desat, screen, maxSlices, shadow, sway }]
    R.begin = function () { this.count = 0; this.shadowCount = 0; this.stamp++; this.atlas.now = this.stamp; };
    R.push = function (it) {
        var m = it.mesh;
        if (!m || !m.alive) return;
        this.atlas.touch(m, this.stamp);
        // maxZ: only the slices below this local height (cut-away walls)
        var n = m.n, lim = it.maxZ != null ? Math.max(0, Math.min(n, Math.floor(it.maxZ - m.oz))) : n;
        if (lim <= 0) return;
        var need = (this.count + lim) * FLOATS;
        if (need > this.instData.length) {
            var bigger = new Float32Array(Math.max(need, this.instData.length * 2));
            bigger.set(this.instData); this.instData = bigger;
        }
        var D = this.instData, o = this.count * FLOATS;
        var tint = it.tint ? ((it.tint[0] << 16) + (it.tint[1] << 8) + it.tint[2]) : 0;
        var tw = Math.min(0.999, it.tintAmt || 0) + Math.round((it.desat || 0) * 2);
        var alpha = it.alpha == null ? 1 : it.alpha;
        var sway = it.sway || null;   // fn(k, n) -> [dx, dy] per slice
        var cs = Math.cos(it.turn || 0), sn = Math.sin(it.turn || 0);
        for (var k = 0; k < lim; k++) {
            var px = it.x, py = it.y;
            if (sway) { var sw = sway(k, n); px += sw[0]; py += sw[1]; }
            D[o] = px; D[o + 1] = py; D[o + 2] = (it.z || 0) + m.oz + k; D[o + 3] = it.turn || 0;
            D[o + 4] = m.uv[k * 2]; D[o + 5] = m.uv[k * 2 + 1]; D[o + 6] = m.w; D[o + 7] = m.d;
            D[o + 8] = m.ox; D[o + 9] = m.oy; D[o + 10] = m.layer; D[o + 11] = it.screen || 0;
            D[o + 12] = it.id || 0; D[o + 13] = alpha; D[o + 14] = tint; D[o + 15] = tw;
            o += FLOATS;
        }
        if (it.shadow !== false) this.shadowCount += lim;
        this.count += lim;
        void cs; void sn;
    };

    // cam: { cx, cy, yaw, squash, spacing, scale (fbo px per world px), fw, fh, ox, oy (fbo px of the centre) }
    // env: lighting (see stack-scene.js lightEnv)
    R.render = function (cam, env, floorRect, shadowFrom) {
        var gl = this.gl;
        this._ensureFbo(cam.fw, cam.fh);
        this.atlas.flush();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.viewport(0, 0, cam.fw, cam.fh);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1);
        gl.clearStencil(0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
        var camU = [cam.cx, cam.cy, cy, sy], projU = [cam.squash, cam.spacing, cam.scale, 0], viewU = [cam.fw, cam.fh, cam.ox, cam.oy];
        var lights = env.lights || [], nL = Math.min(16, lights.length), LP = new Float32Array(64), LC = new Float32Array(64);
        for (var i = 0; i < nL; i++) { var L = lights[i]; LP.set([L.x, L.y, L.z, L.r], i * 4); LC.set([L.c[0], L.c[1], L.c[2], L.k], i * 4); }

        // 1. floor (+ decals), writes stencil 1 where the office floor is
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.ALWAYS, 1, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        if (this.hasFloor && floorRect) {
            var pf = this.pFloor;
            gl.useProgram(pf.p);
            gl.uniform4fv(pf.u.u_cam, camU); gl.uniform4fv(pf.u.u_proj, projU); gl.uniform4fv(pf.u.u_view, viewU);
            gl.uniform4f(pf.u.u_rect, floorRect.x, floorRect.y, floorRect.w, floorRect.h);
            gl.uniform4f(pf.u.u_texRect, floorRect.tx || 0, floorRect.ty || 0, floorRect.tw == null ? 1 : floorRect.tw, floorRect.th == null ? 1 : floorRect.th);
            gl.uniform1f(pf.u.u_z, 0);
            gl.uniform3fv(pf.u.u_ambient, env.ambient);
            gl.uniform1i(pf.u.u_nLights, nL); gl.uniform4fv(pf.u.u_lights, LP); gl.uniform4fv(pf.u.u_lightCol, LC);
            gl.uniform1f(pf.u.u_mul, env.floorMul || 1);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.floorTex); gl.uniform1i(pf.u.u_tex, 0);
            gl.bindVertexArray(this.vaoQuad);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            if (this.hasDecals) {
                gl.stencilFunc(gl.ALWAYS, 1, 0xff);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.uniform1f(pf.u.u_mul, 1);
                gl.bindTexture(gl.TEXTURE_2D, this.decalTex);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
        }
        // upload instances
        gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
        gl.bufferData(gl.ARRAY_BUFFER, this.instData.subarray(0, this.count * FLOATS), gl.DYNAMIC_DRAW);
        var ps = this.pSlice;
        gl.useProgram(ps.p);
        gl.uniform4fv(ps.u.u_cam, camU); gl.uniform4fv(ps.u.u_view, viewU);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas.texC); gl.uniform1i(ps.u.u_color, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlas.texA); gl.uniform1i(ps.u.u_aux, 1);
        gl.uniform3fv(ps.u.u_sunDir, env.sunDir);
        gl.uniform3fv(ps.u.u_lit, env.lit); gl.uniform3fv(ps.u.u_mid, env.mid); gl.uniform3fv(ps.u.u_shd, env.shd);
        gl.uniform3fv(ps.u.u_ambient, env.ambient);
        gl.uniform4fv(ps.u.u_sky0, env.sky0); gl.uniform4fv(ps.u.u_sky1, env.sky1);
        gl.uniform1f(ps.u.u_time, env.time); gl.uniform1f(ps.u.u_night, env.night);
        gl.uniform1i(ps.u.u_nLights, nL); gl.uniform4fv(ps.u.u_lights, LP); gl.uniform4fv(ps.u.u_lightCol, LC);
        gl.bindVertexArray(this.vaoSlice);

        // 2. shadows: every stack's slices pushed along the sun onto the floor,
        //    each floor pixel darkened once (stencil 1 -> 2)
        if (env.shadow && this.count && shadowFrom != null) {
            gl.uniform4f(ps.u.u_proj, cam.squash, cam.spacing, cam.scale, 1);
            gl.uniform2f(ps.u.u_sun, env.shadow[0], env.shadow[1]);
            gl.uniform1i(ps.u.u_shadowPass, 1);
            gl.uniform4fv(ps.u.u_shadowCol, env.shadowCol);
            gl.stencilFunc(gl.EQUAL, 1, 0xff);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Math.min(shadowFrom, this.count));
        }
        // 3. stacks, depth tested
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.uniform4f(ps.u.u_proj, cam.squash, cam.spacing, cam.scale, 0);
        gl.uniform1i(ps.u.u_shadowPass, 0);
        if (this.count) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
        gl.disable(gl.DEPTH_TEST);

        // 4. post: outlines + glow, to the canvas
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, cam.fw, cam.fh);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        var pp = this.pPost;
        gl.useProgram(pp.p);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tCol); gl.uniform1i(pp.u.u_col, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tId); gl.uniform1i(pp.u.u_id, 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tDepth); gl.uniform1i(pp.u.u_depth, 2);
        gl.uniform2f(pp.u.u_px, 1 / cam.fw, 1 / cam.fh);
        gl.uniform3fv(pp.u.u_outline, env.outline);
        gl.uniform1f(pp.u.u_night, env.night);
        gl.bindVertexArray(this.vaoQuad);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        return this.canvas;
    };

    // Object id under an fbo pixel (0 = none), read from the last frame's id buffer.
    R.pick = function (fx, fy) {
        var gl = this.gl;
        if (!this.fbo || fx < 0 || fy < 0 || fx >= this.fw || fy >= this.fh) return 0;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        var px = new Uint8Array(4);
        gl.readPixels(fx | 0, (this.fh - 1 - fy) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (px[3] < 128) return 0;
        return px[0] + px[1] * 256 + px[2] * 65536;
    };

    // Bake + place a model (cached by the caller).
    R.upload = function (model, pool, owner) {
        var b = model.bake ? model.bake() : model;
        return this.atlas.add(b, pool || 'static', owner);
    };
})();
