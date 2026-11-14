// Agent Studio 2.0 (v0.10): a character maker on top of the office renderer.
//
// - window.VOOffice.renderAgentPreview(canvas, appearance, opts) (contract C4)
//   draws an agent with the SAME Agent.draw / drawFurnitureItem code the office
//   uses, at an integer device-pixel scale, on a floor tile, optionally at a desk.
// - window.VOStudio builds the studio editor inside #acp-editor. game.js keeps
//   the state, history and save (_agentPanelEditState, _acpAutoSave, _acpUndo,
//   _acpRedo, _acpSave); this file only edits the state and draws.
(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }
    function clone(o) { return JSON.parse(JSON.stringify(o == null ? null : o)); }
    function lower(c) { return String(c || '').toLowerCase(); }
    function g(name) { return window[name]; }
    function call(name) {
        var fn = window[name];
        if (typeof fn !== 'function') return undefined;
        return fn.apply(window, Array.prototype.slice.call(arguments, 1));
    }
    function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage may be off */ } }
    function load(key, fallback) {
        try { var v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    }
    function reducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }
    function isPhone() { return !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches); }

    // Human labels for option ids (CE-22): "testTube" -> "Test tube".
    var LABELS = {
        none: 'None', hardhat: 'Hard hat', testTube: 'Test tube', sunglasses: 'Shades', headset: 'Headset',
        bossDesk: 'Boss desk', checklist: 'Checklist', ponytail: 'Ponytail', mohawk: 'Mohawk'
    };
    function label(id) {
        if (id == null) return 'None';
        if (LABELS[id]) return LABELS[id];
        var s = String(id).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // ------------------------------------------------------------------
    // Pixel icons (10x10, same style as the index.html sprite)
    // ------------------------------------------------------------------
    var ICON_ROWS = {
        dice: ['.########.', '#........#', '#.#....#.#', '#........#', '#...##...#', '#...##...#', '#........#', '#.#....#.#', '#........#', '.########.'],
        redo: ['......#...', '......##..', '#########.', '#.....##..', '#.....#...', '#.........', '#.........', '#######...', '..........', '..........'],
        reset: ['..#####...', '.#.....#.#', '#.......##', '#.....####', '#.........', '#........#', '#........#', '.#......#.', '..######..', '..........'],
        unlock: ['.....####.', '....#....#', '....#.....', '.########.', '.########.', '.###..###.', '.###..###.', '.########.', '.########.', '..........'],
        hair: ['..######..', '.########.', '##########', '###....###', '##......##', '##......##', '#........#', '#........#', '#........#', '..........'],
        face: ['..######..', '.#......#.', '#........#', '#..#..#..#', '#........#', '#.#....#.#', '#..####..#', '.#......#.', '..######..', '..........'],
        shirt: ['...#..#...', '.###..###.', '##########', '##########', '#.######.#', '..######..', '..######..', '..######..', '..######..', '..........'],
        hat: ['..........', '..........', '...####...', '..######..', '..######..', '..######..', '##########', '##########', '..........', '..........'],
        mug: ['..........', '.######...', '.########.', '.######..#', '.######..#', '.########.', '.######...', '..####....', '#########.', '..........'],
        play: ['..#.......', '..##......', '..###.....', '..####....', '..#####...', '..####....', '..###.....', '..##......', '..#.......', '..........'],
        pause: ['..........', '.###..###.', '.###..###.', '.###..###.', '.###..###.', '.###..###.', '.###..###.', '.###..###.', '..........', '..........']
    };
    function rowsToPath(rows) {
        var d = '';
        rows.forEach(function (row, y) {
            var x = 0;
            while (x < row.length) {
                if (row.charAt(x) !== '#') { x++; continue; }
                var start = x;
                while (x < row.length && row.charAt(x) === '#') x++;
                d += 'M' + start + ' ' + y + 'h' + (x - start) + 'v1h-' + (x - start) + 'z';
            }
        });
        return d;
    }
    function ensureIcons() {
        if (document.getElementById('vo-studio-icons')) return;
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('id', 'vo-studio-icons');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('class', 'st-icon-sprite');
        Object.keys(ICON_ROWS).forEach(function (name) {
            var sym = document.createElementNS(ns, 'symbol');
            sym.setAttribute('id', 'i-st-' + name);
            sym.setAttribute('viewBox', '0 0 10 10');
            var p = document.createElementNS(ns, 'path');
            p.setAttribute('d', rowsToPath(ICON_ROWS[name]));
            sym.appendChild(p);
            svg.appendChild(sym);
        });
        (document.body || document.documentElement).appendChild(svg);
    }
    function icon(name) {
        ensureIcons();
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'vo-icon');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        var use = document.createElementNS(ns, 'use');
        use.setAttribute('href', '#i-' + name);
        svg.appendChild(use);
        return svg;
    }
    function button(cls, text, iconName, title) {
        var b = el('button', 'vo-btn ' + (cls || ''));
        b.type = 'button';
        if (iconName) b.appendChild(icon(iconName));
        if (text) b.appendChild(el('span', 'st-btn-label', text));
        if (title) { b.title = title; if (!text) b.setAttribute('aria-label', title); }
        return b;
    }

    // ------------------------------------------------------------------
    // Option catalogues
    // ------------------------------------------------------------------
    // 12 skin tones from very light to very deep (CE-08), plus a fun row.
    var SKIN = ['#fde7d6', '#fddcb5', '#f5d0b0', '#ffcc80', '#e8b88a', '#d4a574', '#c68642', '#a0663a', '#8d5524', '#6b3e26', '#4a2c1a', '#2e1b12'];
    var SKIN_FUN = ['#8bc34a', '#4fc3f7', '#b39ddb', '#90a4ae', '#f48fb1', '#ffd54f'];
    // Hair styles come from the one table in game.js (v0.12), in Studio order.
    var HAIR_STYLES = HAIR_STYLE_TABLE.map(function (h) { return h.id; });
    var HAIR = ['#1a1a1a', '#333333', '#3e2723', '#5d4037', '#8d6e63', '#dcc282', '#ffd700', '#bf360c', '#616161', '#e0e0e0'];
    var HAIR_FUN = ['#ff5252', '#ff80ab', '#b388ff', '#40c4ff', '#69f0ae'];
    var BROWS = ['thin', 'thick', 'angular', 'arched'];
    var EYES = ['#212121', '#3e2723', '#5d4037', '#1565c0', '#4fc3f7', '#2e7d32', '#00897b', '#6a1b9a', '#37474f', '#9e9e9e'];
    var LIPS = ['#c4626a', '#d47a82', '#a1424a', '#8e3b46', '#b0624e', '#e57373', '#6a1b9a'];
    var FACIAL = ['none', 'stubble', 'beard', 'goatee', 'mustache'];
    // Lash styles (0.12.0) come from game.js's LASH_STYLES, the one list drawing also reads.
    var LASH_TABLE = typeof LASH_STYLES !== 'undefined' ? LASH_STYLES : [{ id: 'none', label: 'No lashes' }, { id: 'natural', label: 'Lashes' }];
    var LASHES = LASH_TABLE.map(function (l) { return l.id; });
    var SHIRTS = ['#e53935', '#fb8c00', '#fdd835', '#7cb342', '#43a047', '#00897b', '#00acc1', '#1e88e5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41', '#546e7a', '#37474f', '#f5f5f5', '#607d8b'];
    var PANTS = ['#1a1a2e', '#263238', '#37474f', '#3e2723', '#5d4037', '#1565c0', '#283593', '#455a64', '#8d6e63', '#bdbdbd', '#2e7d32'];
    var SHOES = ['#212121', '#4e342e', '#795548', '#eceff1', '#c62828', '#1565c0'];
    // v0.12: tops, neckwear and costumes come from game.js's BODY_LOOKS, the one list drawing also reads.
    var BODY = typeof BODY_LOOKS !== 'undefined' ? BODY_LOOKS : null;
    var ids = function (list) { return list.map(function (o) { return o.id; }); };
    var COSTUMES = BODY ? ids(BODY.costumes) : ['none', 'lobster', 'chicken'];
    var TOPS = BODY ? ids(BODY.tops) : ['tee'];
    var NECKWEAR = BODY ? ids(BODY.neckwear) : ['none'];
    var NECK_COLORS = BODY ? BODY.neckwearColors.slice() : [];
    // Names per list: an id can be in two lists (santa is a hat and a costume), so every list keeps its own names
    // instead of sharing LABELS, where the first one in won.
    var namesOf = function (list) {
        var m = {};
        (list || []).forEach(function (o) { if (o && o.label) m[o.id] = o.label; });
        return function (id) { return m[id] || label(id); };
    };
    var topName = namesOf(BODY && BODY.tops), neckName = namesOf(BODY && BODY.neckwear), costumeName = namesOf(BODY && BODY.costumes);
    // Headwear ids and names come from the one table in game.js (HEADWEAR_STYLES, v0.12).
    var hatName = namesOf(window.HEADWEAR_STYLES);
    var HEADWEAR = ['none'].concat((window.HEADWEAR_STYLES || []).map(function (h) { return h.id; }));
    var HAT_COLORS = ['#888888', '#fdd835', '#ffd700', '#fb8c00', '#e53935', '#1e88e5', '#43a047', '#8e24aa', '#212121', '#eceff1'];
    var GLASSES = ['none', 'round', 'square', 'sunglasses'];
    var LENS = ['#333333', '#212121', '#5d4037', '#1e88e5', '#e53935', '#ffd700', '#8e24aa', '#eceff1'];
    var HELD = ['none', 'tablet', 'wrench', 'coffee', 'clipboard', 'pen', 'hammer', 'testTube', 'book'];
    var DESK_ITEMS = ['none', 'anvil', 'trophy', 'calendar', 'envelope', 'money', 'ruler', 'marker', 'chart', 'plans', 'checklist', 'microscope', 'shield', 'phone', 'files'];
    var EMOJIS = ['🤖', '🧠', '💻', '🛠️', '🔧', '📊', '📈', '📝', '📚', '🎨', '🎯', '🚀', '⚡', '🔍', '🧪', '🔬',
        '🛡️', '📞', '💬', '📦', '🗂️', '📅', '💡', '⭐', '🔥', '🌱', '🐙', '🦊', '🐱', '🐶', '🦉', '🐝',
        '🦄', '🐢', '🦞', '🐔', '☕', '🎧', '🎵', '🏆', '💼', '🧾', '🧮', '✉️', '🌍', '🔐', '🧭', '🪄'];
    var DEFAULT_PANTS = '#1a1a2e';
    var DEFAULT_LIP = '#c4626a';

    // Outfit sets (CE-10, "Start from"): they set the outfit, never skin, body or face.
    var PRESETS = [
        { id: 'classic', label: 'Office classic', color: '#1e88e5', look: { shirtStyle: 'tee', neckwear: null, pantsColor: '#1a1a2e', headwear: null, glasses: null, heldItem: 'coffee', deskItem: 'calendar', costume: null } },
        { id: 'engineer', label: 'Engineer', color: '#fb8c00', look: { shirtStyle: 'vest', neckwear: null, pantsColor: '#1565c0', headwear: 'hardhat', headwearColor: '#fdd835', glasses: null, heldItem: 'wrench', deskItem: 'plans', costume: null } },
        { id: 'scientist', label: 'Scientist', color: '#4fc3f7', look: { shirtStyle: 'labcoat', neckwear: null, pantsColor: '#455a64', headwear: 'goggles', headwearColor: '#4fc3f7', glasses: null, heldItem: 'testTube', deskItem: 'microscope', costume: null } },
        { id: 'boss', label: 'Boss', color: '#37474f', look: { shirtStyle: 'suit', neckwear: 'tie', neckwearColor: '#c62828', pantsColor: '#263238', headwear: 'crown', headwearColor: '#ffd700', glasses: 'square', glassesColor: '#212121', heldItem: 'clipboard', deskItem: 'trophy', costume: null } },
        { id: 'support', label: 'Support', color: '#00897b', look: { shirtStyle: 'tee', neckwear: null, pantsColor: '#37474f', headwear: 'headset', headwearColor: '#333333', glasses: null, heldItem: 'tablet', deskItem: 'phone', costume: null } },
        { id: 'creative', label: 'Creative', color: '#8e24aa', look: { shirtStyle: 'hoodie', neckwear: null, pantsColor: '#1a1a2e', headwear: 'beanie', headwearColor: '#e53935', glasses: 'round', glassesColor: '#333333', heldItem: 'pen', deskItem: 'marker', costume: null } },
        { id: 'nightowl', label: 'Night owl', color: '#263238', look: { shirtStyle: 'hoodie', neckwear: null, pantsColor: '#263238', headwear: null, glasses: 'sunglasses', glassesColor: '#212121', heldItem: 'coffee', deskItem: 'checklist', costume: null } },
        { id: 'bookworm', label: 'Bookworm', color: '#6d4c41', look: { shirtStyle: 'sweater', neckwear: null, pantsColor: '#3e2723', headwear: null, glasses: 'round', glassesColor: '#5d4037', heldItem: 'book', deskItem: 'files', costume: null } },
        { id: 'analyst', label: 'Analyst', color: '#3949ab', look: { shirtStyle: 'tee', neckwear: 'tie', neckwearColor: '#212121', pantsColor: '#1a1a2e', headwear: null, glasses: 'square', glassesColor: '#333333', heldItem: 'tablet', deskItem: 'chart', costume: null } },
        { id: 'builder', label: 'Builder', color: '#fdd835', look: { shirtStyle: 'tee', neckwear: null, pantsColor: '#1565c0', headwear: 'cap', headwearColor: '#e53935', glasses: null, heldItem: 'hammer', deskItem: 'anvil', costume: null } },
        // Seasonal sets (v0.12). Headwear santa / witch / sunhat come with the face work; an id this build
        // does not know draws nothing.
        { id: 'winter', label: 'Winter', color: '#1565c0', look: { shirtStyle: 'sweater', neckwear: 'scarf', neckwearColor: '#c62828', pantsColor: '#37474f', headwear: 'beanie', headwearColor: '#eceff1', glasses: null, heldItem: 'coffee', deskItem: 'calendar', costume: null } },
        { id: 'summer', label: 'Summer', color: '#00acc1', look: { shirtStyle: 'tee', neckwear: null, pantsColor: '#bdbdbd', headwear: 'sunhat', headwearColor: '#fdd835', glasses: 'sunglasses', glassesColor: '#212121', heldItem: null, deskItem: 'chart', costume: null } },
        { id: 'halloween', label: 'Halloween', color: '#fb8c00', look: { shirtStyle: 'hoodie', neckwear: null, pantsColor: '#212121', headwear: 'witch', headwearColor: '#4a148c', glasses: null, heldItem: 'book', deskItem: 'checklist', costume: null } },
        { id: 'holiday', label: 'Holiday', color: '#2e7d32', look: { shirtStyle: 'sweater', neckwear: 'scarf', neckwearColor: '#eceff1', pantsColor: '#c62828', headwear: 'santa', headwearColor: '#d32f2f', glasses: null, heldItem: 'coffee', deskItem: 'envelope', costume: null } },
        { id: 'lobster', label: 'Lobster', color: null, look: { costume: 'lobster', heldItem: null, deskItem: 'money' } },
        { id: 'chicken', label: 'Chicken', color: null, look: { costume: 'chicken', heldItem: null, deskItem: 'envelope' } }
    ];

    // Randomize locks: which parts a dice roll may change.
    var LOCK_GROUPS = [
        { id: 'body', label: 'Body and skin' },
        { id: 'hair', label: 'Hair' },
        { id: 'face', label: 'Face' },
        { id: 'outfit', label: 'Outfit' },
        { id: 'hats', label: 'Hats and glasses' },
        { id: 'items', label: 'Items' }
    ];

    // ------------------------------------------------------------------
    // Look helpers (contract C3 defaults)
    // ------------------------------------------------------------------
    function effLashes(es) {
        var a = es.appearance || {};
        return typeof a.lashes === 'boolean' ? a.lashes : es.gender === 'F';
    }
    function effLip(es) {
        var a = es.appearance || {};
        return a.lipColor !== undefined ? a.lipColor : (es.gender === 'F' ? DEFAULT_LIP : null);
    }
    // Body is shape only: pin the gender-derived defaults before the body changes,
    // so switching Body A/B never adds or removes lashes or lip colour.
    function pinFaceDefaults(es) {
        var a = es.appearance;
        if (typeof a.lashes !== 'boolean') a.lashes = es.gender === 'F';
        if (a.lipColor === undefined) a.lipColor = es.gender === 'F' ? DEFAULT_LIP : null;
    }

    // ------------------------------------------------------------------
    // Male / Female looks (0.12.0): game.js LOOK_GENDER says which items each gender is offered
    // ------------------------------------------------------------------
    function genderOf(s) { return s && s.gender === 'F' ? 'F' : 'M'; }
    function allowFn(key) { return function (id, g) { return allowed(key, id === 'none' ? null : id, g); }; }
    function allowed(key, id, g) { return typeof lookAllowed !== 'function' || lookAllowed(key, id, g); }
    // The shown lash style: 'none' or a LASH_STYLES id (unset lashes follow the body, as drawing does).
    function lashId(s) {
        var a = (s && s.appearance) || {};
        if (!effLashes(s)) return 'none';
        return a.lashStyle && a.lashStyle !== 'none' && LASHES.indexOf(a.lashStyle) > 0 ? a.lashStyle : 'natural';
    }
    // Write a lash style the way drawing reads it: lashes on/off plus lashStyle (natural = no style).
    function setLash(a, id) {
        a.lashes = id !== 'none';
        a.lashStyle = id === 'none' || id === 'natural' ? null : id;
    }
    // Each gender's own defaults for the face items it is the only one to have.
    var GENDER_FACE = { M: { lash: 'none', lip: null }, F: { lash: 'natural', lip: DEFAULT_LIP } };
    // Switch a look state to gender g: choices both genders share stay; an item the new gender is
    // not offered, and an item the old gender had no choice about (a Male's "No lashes" and no lip
    // colour, a Female's no facial hair), become the new gender's default (its id-seeded look).
    function switchGender(s, g) {
        g = g === 'F' ? 'F' : 'M';
        var old = genderOf(s);
        if (g === old && s.gender === g) return;
        var a = s.appearance || (s.appearance = {});
        var def = defaultLook(s.id || 'new-agent', g) || {};
        var lash = lashId(s), lip = effLip(s);
        setLash(a, lash === GENDER_FACE[old].lash || !allowed('lashes', lash, g) ? GENDER_FACE[g].lash : lash);
        a.lipColor = lip === GENDER_FACE[old].lip || !allowed('lipColor', lip, g) ? GENDER_FACE[g].lip : lip;
        if (!allowed('facialHair', a.facialHair, g) || (old === 'F' && !a.facialHair)) { a.facialHair = def.facialHair || null; if (!a.facialHair) a.facialHairColor = null; }
        var fix = { hairStyle: HAIR_STYLES, eyebrowStyle: BROWS, shirtStyle: TOPS, neckwear: NECKWEAR, headwear: HEADWEAR, glasses: GLASSES, costume: COSTUMES };
        Object.keys(fix).forEach(function (k) {
            if (a[k] == null || allowed(k, a[k], g)) return;
            var d = def[k] != null && allowed(k, def[k], g) ? def[k] : null;
            if (k === 'hairStyle' && !d) d = fix[k].filter(function (id) { return allowed(k, id, g); })[0];
            if (k === 'eyebrowStyle' && !d) d = g === 'F' ? 'thin' : 'thick';
            if (k === 'shirtStyle' && !d) d = 'tee';
            a[k] = d;
            if (!d && k === 'neckwear') a.neckwearColor = null;
            if (!d && k === 'headwear') a.headwearColor = null;
        });
        s.gender = g;
    }
    // Male / Female toggle: a two-radio group (st-seg). get() -> 'M' | 'F'; set(g).
    function genderSeg(get, set) {
        var seg = el('div', 'st-seg st-gender');
        seg.setAttribute('role', 'radiogroup');
        seg.setAttribute('aria-label', 'Male or female');
        var btns = [['M', 'Male'], ['F', 'Female']].map(function (o) {
            var b = el('button', 'st-seg-btn', o[1]);
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.dataset.value = o[0];
            b.addEventListener('click', function () { if (get() !== o[0]) set(o[0]); });
            seg.appendChild(b);
            return b;
        });
        rovingKeys(seg, '.st-seg-btn');
        seg._sync = function () {
            var g = get();
            btns.forEach(function (b) { var on = b.dataset.value === g; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.classList.toggle('is-selected', on); });
            setRoving(btns, g === 'F' ? 1 : 0);
        };
        seg._sync();
        return seg;
    }
    function genderField() {
        var wrap = field('Male or female', { hint: 'Each list offers this gender\'s items and the shared ones.', cls: 'st-field--gender' });
        var seg = genderSeg(function () { return genderOf(es()); }, function (g) { edit('seg:gender', function (s) { switchGender(s, g); }); });
        wrap.appendChild(seg);
        S.syncers.push(seg._sync);
        return wrap;
    }

    // ------------------------------------------------------------------
    // C4: renderAgentPreview
    // ------------------------------------------------------------------
    var VIEWS = {
        stand: { x: -30, y: -58, w: 60, h: 70 },
        desk: { x: -39, y: -52, w: 80, h: 80 },
        head: { x: -18, y: -50, w: 36, h: 32 },
        body: { x: -20, y: -52, w: 40, h: 60 },
        deskItem: { x: -37, y: -27, w: 24, h: 22 }, // around DESK_SEAT.desk[0].item (game.js, back-left corner)
        card: { x: -16, y: -48, w: 32, h: 32 }
    };
    var PREVIEW_ID = '__vo_studio_preview__';
    var _renderWarned = false;

    function facingList() {
        var art = window.VOOfficeArt;
        if (art && Array.isArray(art.agentFacings) && art.agentFacings.length) return art.agentFacings;
        // Agents with front, side and back views (they pick one in _walkView).
        if (typeof Agent !== 'undefined' && typeof Agent.prototype._walkView === 'function') return ['down', 'left', 'right', 'up'];
        return ['left', 'right'];
    }
    // The view for thumbnails and the default stage: the front when there is one.
    function frontFacing() {
        var list = facingList();
        return list.indexOf('down') >= 0 ? 'down' : 'right';
    }

    function drawFloor(c, scale, ox, oy, bw, bh) {
        var cfg = g('officeConfig') || {};
        var floor = cfg.floor || {};
        var c1 = floor.color1 || '#c0c0c0', c2 = floor.color2 || '#b0b0b0';
        var tile = 40 * scale;
        var x0 = ox - Math.ceil(ox / tile) * tile, y0 = oy - Math.ceil(oy / tile) * tile;
        for (var y = y0, j = 0; y < bh; y += tile, j++) {
            for (var x = x0, i = 0; x < bw; x += tile, i++) {
                var gx = Math.round((x - ox) / tile), gy = Math.round((y - oy) / tile);
                c.fillStyle = ((gx + gy) & 1) ? c2 : c1;
                c.fillRect(x, y, tile, tile);
            }
        }
    }

    function makePreviewAgent(look, opts) {
        if (typeof Agent === 'undefined') return null;
        var pose = opts.pose || 'stand';
        var facing = opts.facing || frontFacing();
        var seated = pose === 'sit' || pose === 'type' || pose === 'idle';
        var a = Object.create(Agent.prototype);
        var tick = Math.floor((opts.time || 0) * 60 / 1000);
        Object.assign(a, {
            id: PREVIEW_ID, name: opts.name || '', emoji: opts.emoji || '', role: '',
            color: opts.color || look.color || '#607d8b', gender: opts.gender || look.gender || 'M',
            appearance: look, x: 0, y: 0, targetX: 0, targetY: 0, speed: 1.2, tick: tick,
            desk: { x: 0, y: 0 }, isSitting: seated, state: pose === 'type' ? 'working' : 'idle', task: '',
            // _forceView: the front/side/back view art-sprites draws for previews (A5).
            faceDir: facing === 'left' ? -1 : 1, facing: facing, _forceView: facing, idleAction: null, notify: false,
            carryItem: pose === 'idle' ? 'coffee' : null, available: true, _studioPreview: true
        });
        if (opts.expression) a._previewExpression = opts.expression; // v0.12 faces (game.js _agentExpression)
        // v0.12 moves: a signature move at progress sigP (0..1), or its still pose (sigStill)
        var sm = opts.sigMove && typeof _sigMoveSpec === 'function' ? _sigMoveSpec(opts.sigMove) : null;
        if (sm) a._sigMove = { id: sm.id, at: performance.now() - Math.max(0, Math.min(0.999, opts.sigP || 0)) * sm.ms, ms: sm.ms, still: !!opts.sigStill, until: Infinity, preview: true };
        // The office name tag is not part of a look preview. While Agent.draw still
        // paints it, mark the preview like an Office life extra (they skip it); once
        // the tag has its own pass (_agentTagPill) the preview stays a normal agent,
        // because extras do not take a seat at a desk.
        if (typeof _agentTagPill !== 'function') a._lifeExtra = true;
        if (pose === 'walk') {
            if (facing === 'left') a.targetX = -400;
            else if (facing === 'up') a.targetY = -400;
            else if (facing === 'down') a.targetY = 400;
            else a.targetX = 400;
        }
        return a;
    }

    // canvas: any <canvas>; its CSS box (or opts.width/height) sets the size.
    // appearance: the agent's appearance object (may carry color/gender).
    // opts: pose, facing, scale (integer CSS px per art px; default = largest that fits),
    //       withDesk, deskItem, time (ms), color, gender, name, emoji, view (art rect or
    //       'stand'|'desk'|'head'|'body'|'deskItem'|'card'), floor (default true),
    //       noAgent, dpr.
    function renderAgentPreview(canvas, appearance, opts) {
        opts = opts || {};
        if (!canvas || !canvas.getContext) return null;
        var look = clone(appearance || {}) || {};
        if (opts.deskItem !== undefined) look.deskItem = opts.deskItem;
        var pose = opts.pose || 'stand';
        var seated = pose === 'sit' || pose === 'type' || pose === 'idle';
        var withDesk = opts.withDesk != null ? !!opts.withDesk : seated;
        var dpr = opts.dpr || Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        var cssW = opts.width || canvas.clientWidth || canvas.width || 64;
        var cssH = opts.height || canvas.clientHeight || canvas.height || 64;
        var bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
        var view = typeof opts.view === 'string' ? VIEWS[opts.view] : opts.view;
        if (!view) view = withDesk ? VIEWS.desk : VIEWS.stand;
        // opts.nameTag: the office name tag pill under the figure (Q-07), in a band added below the view.
        // The band is only added when the figure keeps its scale; otherwise the tag sits in the margin under the view.
        var TAG_BAND = 8;
        var nameTag = !!(opts.nameTag && opts.name && typeof _tagPillBitmap === 'function');
        if (nameTag && !opts.scale) {
            var fitFor = function (h) { return Math.max(1, Math.floor(Math.min(bw / view.w, bh / h) + 0.1)); };
            if (fitFor(view.h + TAG_BAND) >= fitFor(view.h)) view = { x: view.x, y: view.y, w: view.w, h: view.h + TAG_BAND, band: true };
        }
        // Views carry a few pixels of margin, so a 0.1 shortfall may crop into it.
        var fit = Math.max(1, Math.floor(Math.min(bw / view.w, bh / view.h) + 0.1));
        var scale = opts.scale ? Math.max(1, Math.round(opts.scale * dpr)) : fit;
        var ox = Math.round(bw / 2 - (view.x + view.w / 2) * scale);
        var oy = Math.round(bh / 2 - (view.y + view.h / 2) * scale);
        var c = canvas.getContext('2d');
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, bw, bh);
        c.imageSmoothingEnabled = false;
        if (opts.floor !== false) drawFloor(c, scale, ox, oy, bw, bh);
        var agent = makePreviewAgent(look, opts);
        if (!agent) return null;
        var seat = (window.VOOfficeArt && window.VOOfficeArt.seatOffset) || { x: 0, y: 0 };
        // `ctx` is game.js's global drawing context that Agent.draw and the
        // furniture code paint on; point it at the preview for this call only.
        var savedCtx = ctx;
        c.save();
        c.translate(ox, oy);
        c.scale(scale, scale);
        ctx = c;
        try {
            if (ctx !== c) throw new Error('the office drawing context could not be swapped');
            if (withDesk && typeof drawFurnitureItem === 'function') {
                // _previewDesk: the desk this preview agent sits at (it is not in the office).
                agent._previewDesk = { id: PREVIEW_ID + 'desk', type: 'desk', x: 0, y: 0 };
                // The seat lookup searches the office furniture; this desk is not there.
                agent._myDeskItem = function () { return this._previewDesk || null; };
                drawFurnitureItem(agent._previewDesk, { staticOnly: true });
                c.save();
                agent._drawDeskCharItem(c);
                c.restore();
            }
            if (!opts.noAgent) {
                if (withDesk) { agent.x = seat.x || 0; agent.y = seat.y || 0; agent.targetX += agent.x; agent.targetY += agent.y; }
                agent.draw();
            }
        } catch (e) {
            if (!_renderWarned) { _renderWarned = true; console.warn('Agent preview could not draw:', e); }
        } finally {
            ctx = savedCtx;
            c.restore();
        }
        if (nameTag) {
            // Same pill as the office (_tagPillBitmap), font px in whole device px that fit the band.
            try {
                var bandTop = view.band ? oy + (view.y + view.h - TAG_BAND) * scale : oy + (view.y + view.h) * scale;
                var room = view.band ? TAG_BAND * scale : bh - bandTop - 2;
                var fp = Math.max(1, Math.min(Math.floor(room / 13), Math.round(scale / 2)));
                var pill = _tagPillBitmap(agent, fp, 96 * fp);
                c.drawImage(pill.bmp, Math.round(bw / 2 - pill.w / 2), Math.round(bandTop + Math.max(0, (room - pill.h) / 2)));
            } catch (e) { /* the look preview still stands without its tag */ }
        }
        return { scale: scale / dpr, deviceScale: scale, width: bw, height: bh };
    }

    function exposeApi() {
        window.VOOffice = window.VOOffice || {};
        window.VOOffice.renderAgentPreview = renderAgentPreview;
    }
    exposeApi();

    // ------------------------------------------------------------------
    // Studio state
    // ------------------------------------------------------------------
    var S = {
        agent: null, es: null, col: null,
        cat: 'looks', pose: load('vo-studio-pose', 'stand'), facing: null, zoom: load('vo-studio-zoom', 0),
        playing: true, syncers: [], raf: 0, refreshRaf: 0, t0: 0, lastFrame: 0,
        ideasSeed: Math.floor(Math.random() * 1e9), locks: load('vo-studio-locks', {}),
        stage: null, stageCanvas: null, phone: null
    };
    if (['stand', 'walk', 'type', 'idle', 'sit'].indexOf(S.pose) < 0) S.pose = 'stand';

    function es() { return S.es || g('_agentPanelEditState'); }
    function currentFacing() {
        var list = facingList();
        if (S.facing && list.indexOf(S.facing) >= 0) return S.facing;
        return list.indexOf('down') >= 0 ? 'down' : (list.indexOf('right') >= 0 ? 'right' : list[0]);
    }
    function lookOf(state, override) {
        var a = clone(state.appearance || {});
        if (override) Object.keys(override).forEach(function (k) { a[k] = override[k]; });
        return a;
    }

    // Edit the state, record history (coalesced by key) and redraw.
    function edit(key, fn) {
        var s = es();
        if (!s) return;
        fn(s, s.appearance);
        call('_acpAutoSave', key);
        refresh();
    }

    // ------------------------------------------------------------------
    // Refresh / stage loop
    // ------------------------------------------------------------------
    function refresh() {
        if (S.refreshRaf) return;
        S.refreshRaf = requestAnimationFrame(function () { S.refreshRaf = 0; refreshNow(); });
    }
    function refreshNow() {
        if (!S.col || !S.col.isConnected) return;
        if (S.playing) startLoop();
        S.syncers.forEach(function (fn) { try { fn(); } catch (e) { console.warn(e); } });
        drawStage(performance.now());
        syncHistory();
        syncUnsaved();
    }

    function drawStage(now) {
        var s = es();
        var cv = S.stageCanvas;
        if (!s || !cv || !cv.isConnected) return;
        var seated = S.pose !== 'stand' && S.pose !== 'walk';
        var view = seated ? VIEWS.desk : VIEWS.stand;
        var animated = S.playing && !reducedMotion();
        var t = animated ? (now - S.t0) : (S.pose === 'walk' ? 130 : 0);
        var r = renderAgentPreview(cv, s.appearance, {
            // Fit = the largest whole device-pixel scale; 4x-6x = CSS px per art px.
            pose: S.pose, facing: currentFacing(), scale: S.zoom || undefined, view: view,
            time: t, color: s.color, gender: s.gender, name: s.name, emoji: s.emoji, nameTag: true, expression: S.expression,
            sigMove: sigStage(now), sigP: S.sig ? (now - S.sig.at) / S.sig.ms : 0, sigStill: reducedMotion()
        });
        if (r && S.stage) S.stage.dataset.scale = String(r.scale);
    }
    function loop(now) {
        S.raf = 0;
        var panel = document.getElementById('agent-creator-panel');
        var live = panel && panel.classList.contains('visible') && S.stageCanvas && S.stageCanvas.isConnected && !document.hidden;
        if (!live || !S.playing || reducedMotion()) return;
        if (now - S.lastFrame >= 33) { S.lastFrame = now; drawStage(now); }
        S.raf = requestAnimationFrame(loop);
    }
    function startLoop() {
        if (!S.t0) S.t0 = performance.now();
        if (!S.raf) S.raf = requestAnimationFrame(loop);
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) startLoop(); });

    function syncHistory() {
        var id = g('_agentPanelSelectedId');
        var undo = document.getElementById('acp-undo-btn'), redo = document.getElementById('acp-redo-btn');
        if (undo && typeof window._acpUndoStackFor === 'function') undo.disabled = !id || !window._acpUndoStackFor(id).length;
        if (redo && typeof window._acpRedoStackFor === 'function') redo.disabled = !id || !window._acpRedoStackFor(id).length;
    }
    function syncUnsaved() {
        var note = S.col && S.col.querySelector('.st-unsaved');
        if (note) note.hidden = !window._acpUnsaved;
    }
    function syncSaving(on) {
        var btn = document.getElementById('acp-save-btn');
        if (!btn) return;
        var lbl = btn.querySelector('.st-btn-label');
        if (lbl) lbl.textContent = on ? 'Saving...' : 'Save';
        btn.disabled = !!on;
        btn.setAttribute('aria-busy', on ? 'true' : 'false');
        syncUnsaved();
    }

    // ------------------------------------------------------------------
    // Controls: radiogroups of tiles, swatches and segments (CE-06, CE-20)
    // ------------------------------------------------------------------
    // Arrow keys move and select inside a radiogroup (roving tabindex). With
    // focusOnly the arrows only move (lists of actions such as outfit sets).
    function rovingKeys(group, itemSel, focusOnly) {
        group.addEventListener('keydown', function (e) {
            var items = Array.prototype.filter.call(group.querySelectorAll(itemSel), function (n) { return !n.hidden && n.offsetParent !== null; });
            var i = items.indexOf(document.activeElement);
            if (i < 0) return;
            var cols = 1;
            for (var k = 1; k < items.length && items[k].offsetTop === items[0].offsetTop; k++) cols = k + 1;
            var next = -1;
            if (e.key === 'ArrowRight') next = Math.min(items.length - 1, i + 1);
            else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1);
            else if (e.key === 'ArrowDown') next = Math.min(items.length - 1, i + cols);
            else if (e.key === 'ArrowUp') next = Math.max(0, i - cols);
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = items.length - 1;
            else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); items[i].click(); return; }
            if (next < 0 || next === i) return;
            e.preventDefault();
            if (focusOnly) setRoving(items, next);
            items[next].focus();
            if (!focusOnly) items[next].click();
        });
    }
    function setRoving(items, selectedIdx) {
        items.forEach(function (n, i) { n.tabIndex = i === (selectedIdx >= 0 ? selectedIdx : 0) ? 0 : -1; });
    }

    function field(title, opts) {
        opts = opts || {};
        var wrap = el('section', 'st-field' + (opts.cls ? ' ' + opts.cls : ''));
        var head = el('div', 'st-field-head');
        var h = el('h3', 'st-field-title', title);
        h.id = 'st-f-' + Math.random().toString(36).slice(2, 8);
        head.appendChild(h);
        if (opts.hint) head.appendChild(el('span', 'st-field-hint', opts.hint));
        wrap.appendChild(head);
        wrap._titleId = h.id;
        return wrap;
    }

    // spec: {key, title, options, value(), pick(id), view, look(id) -> appearance,
    //        state(id) -> {color, gender}, disabled() -> hint|null, when() -> bool, hint, tileCls}
    function tileGroup(spec) {
        var wrap = field(spec.title, { hint: spec.hint, cls: 'st-field--tiles' });
        var grid = el('div', 'st-tiles' + (spec.tileCls ? ' ' + spec.tileCls : ''));
        grid.setAttribute('role', 'radiogroup');
        grid.setAttribute('aria-labelledby', wrap._titleId);
        grid.dataset.group = spec.key;
        var note = el('p', 'st-disabled-note');
        note.hidden = true;
        var lastGroup = null, lastHead = null, heads = [];
        // spec.allow(id, gender) (0.12.0): the tile shows for that gender; the current value always shows
        var gnote = el('p', 'st-gender-note');
        gnote.hidden = true;
        var tiles = spec.options.map(function (id) {
            // spec.groupOf(id) -> {id, label}: a heading row starts each group (v0.12 hair)
            var grp = spec.groupOf ? spec.groupOf(id) : null;
            if (grp && grp.id !== lastGroup) { lastGroup = grp.id; lastHead = el('p', 'st-tile-group', grp.label); heads.push(lastHead); grid.appendChild(lastHead); }
            var t = el('button', 'st-tile');
            t.type = 'button';
            t.setAttribute('role', 'radio');
            t.dataset.value = id == null ? 'none' : String(id);
            var cv = el('canvas', 'st-tile-canvas');
            cv.setAttribute('aria-hidden', 'true');
            t.appendChild(cv);
            t.appendChild(el('span', 'st-tile-label', spec.label ? spec.label(id) : label(id)));
            t._head = lastHead;
            if (spec.allow) { t._cur = el('span', 'st-tile-cur', 'Current'); t._cur.hidden = true; t.appendChild(t._cur); }
            t.addEventListener('click', function () {
                if (t.getAttribute('aria-disabled') === 'true') { note.hidden = false; return; }
                if (String(spec.value()) === t.dataset.value) return;
                spec.pick(id);
            });
            t._drawKey = '';
            grid.appendChild(t);
            return t;
        });
        rovingKeys(grid, '.st-tile');
        wrap.appendChild(grid);
        wrap.appendChild(gnote);
        wrap.appendChild(note);
        if (spec.after) wrap.appendChild(spec.after);
        S.syncers.push(function () {
            if (spec.when) wrap.hidden = !spec.when();
            if (wrap.hidden) return;
            var cur = String(spec.value());
            var disabledHint = spec.disabled ? spec.disabled() : null;
            note.textContent = disabledHint || '';
            if (!disabledHint) note.hidden = true;
            var sel = -1;
            var s = es();
            var gd = genderOf(s), nAllowed = 0;
            tiles.forEach(function (t, i) {
                var on = t.dataset.value === cur;
                if (on) sel = i;
                if (spec.allow) {
                    var ok = spec.allow(spec.options[i], gd);
                    if (ok) nAllowed++;
                    t.hidden = !ok && !on;
                    t.classList.toggle('is-outside', !ok && on);
                    t._cur.hidden = ok || !on;
                    if (!ok && on) t.title = 'Kept from the saved look (not in the ' + (gd === 'F' ? 'Female' : 'Male') + ' list)'; else t.removeAttribute('title');
                }
                t.setAttribute('aria-checked', on ? 'true' : 'false');
                t.classList.toggle('is-selected', on);
                if (disabledHint) t.setAttribute('aria-disabled', 'true'); else t.removeAttribute('aria-disabled');
                var id = spec.options[i];
                var look = spec.look ? spec.look(id) : lookOf(s);
                var st = spec.state ? spec.state(id) : {};
                var key = JSON.stringify([look, st, s.color, s.gender]);
                if (key !== t._drawKey && !t.hidden) {
                    t._drawKey = key;
                    var cv = t.firstChild;
                    renderAgentPreview(cv, look, Object.assign({
                        view: spec.view || 'head', pose: spec.pose || 'stand', facing: frontFacing(),
                        color: s.color, gender: s.gender, floor: false, noAgent: !!spec.noAgent,
                        withDesk: !!spec.withDesk, time: 0
                    }, st));
                }
            });
            grid.setAttribute('aria-disabled', disabledHint ? 'true' : 'false');
            heads.forEach(function (h) { h.hidden = !tiles.some(function (t) { return t._head === h && !t.hidden; }); });
            var gtext = spec.allow && spec.genderNote && nAllowed <= 1 ? spec.genderNote(gd) : '';
            gnote.textContent = gtext || '';
            gnote.hidden = !gtext;
            var vis = tiles.filter(function (t) { return !t.hidden; });
            tiles.forEach(function (t) { if (t.hidden) t.tabIndex = -1; });
            setRoving(vis, sel >= 0 ? vis.indexOf(tiles[sel]) : -1);
        });
        return wrap;
    }

    // spec: {key, title, colors, fun, none: label|null, value(), pick(hex|null), when(), recent: bool, hint}
    function swatchGroup(spec) {
        var wrap = field(spec.title, { hint: spec.hint, cls: 'st-field--swatches' });
        var row = el('div', 'st-swatches');
        row.setAttribute('role', 'radiogroup');
        row.setAttribute('aria-labelledby', wrap._titleId);
        row.dataset.group = spec.key;
        var items = [];
        function addSwatch(hex, cls, text) {
            var b = el('button', 'st-sw' + (cls ? ' ' + cls : ''));
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.dataset.value = hex == null ? '' : lower(hex);
            if (hex) b.style.setProperty('--sw', hex);
            b.setAttribute('aria-label', hex ? hex : (text || 'None'));
            b.title = hex ? hex : (text || 'None');
            if (text) b.appendChild(el('span', 'st-sw-text', text));
            b.addEventListener('click', function () { spec.pick(hex == null ? null : hex); });
            row.appendChild(b);
            items.push(b);
            return b;
        }
        if (spec.none) addSwatch(null, 'st-sw--none', spec.none);
        spec.colors.forEach(function (c) { addSwatch(c); });
        if (spec.fun && spec.fun.length) {
            row.appendChild(el('span', 'st-sw-sep', 'Fun'));
            spec.fun.forEach(function (c) { addSwatch(c, 'st-sw--fun'); });
        }
        var recentKey = 'vo-studio-recent:' + spec.key;
        var recentWrap = el('span', 'st-sw-recent');
        row.appendChild(recentWrap);
        var custom = el('label', 'st-sw st-sw--custom');
        custom.title = 'Pick any colour';
        var input = el('input');
        input.type = 'color';
        input.setAttribute('aria-label', spec.title + ': pick any colour');
        custom.appendChild(input);
        custom.appendChild(el('span', 'st-sw-plus', '+'));
        input.addEventListener('input', function () { spec.pick(input.value); });
        input.addEventListener('change', function () {
            if (!spec.recent) return;
            var list = load(recentKey, []).filter(function (c) { return lower(c) !== lower(input.value); });
            list.unshift(input.value);
            store(recentKey, JSON.stringify(list.slice(0, 6)));
            renderRecent();
        });
        row.appendChild(custom);
        function renderRecent() {
            if (!spec.recent) return;
            items = items.filter(function (b) { return !b.classList.contains('st-sw--recent'); });
            recentWrap.innerHTML = '';
            var known = spec.colors.concat(spec.fun || []).map(lower);
            var list = load(recentKey, []).filter(function (c) { return known.indexOf(lower(c)) < 0; });
            if (!list.length) return;
            recentWrap.appendChild(el('span', 'st-sw-sep', 'Recent'));
            list.forEach(function (c) {
                var b = addSwatch(c, 'st-sw--recent');
                recentWrap.appendChild(b);
            });
        }
        renderRecent();
        rovingKeys(row, '.st-sw[role="radio"]');
        wrap.appendChild(row);
        var gnote = el('p', 'st-gender-note');
        gnote.hidden = true;
        wrap.appendChild(gnote);
        S.syncers.push(function () {
            if (spec.when) wrap.hidden = !spec.when();
            if (wrap.hidden) return;
            var cur = spec.value();
            var curL = cur == null ? '' : lower(cur);
            var sel = -1;
            items.forEach(function (b, i) {
                var on = b.dataset.value === curL;
                if (on) sel = i;
                b.setAttribute('aria-checked', on ? 'true' : 'false');
                b.classList.toggle('is-selected', on);
            });
            var isCustom = sel < 0 && !!cur;
            custom.classList.toggle('is-selected', isCustom);
            if (cur && /^#[0-9a-f]{6}$/i.test(cur)) { input.value = cur; custom.style.setProperty('--sw', cur); }
            var vis = items;
            if (spec.allow) {                                        // 0.12.0: colours for one gender (lip colour)
                var gd = genderOf(es()), colours = spec.allow('#000000', gd);
                items.forEach(function (b) { b.hidden = !colours && !!b.dataset.value && b.getAttribute('aria-checked') !== 'true'; });
                custom.hidden = !colours && !isCustom;
                Array.prototype.forEach.call(row.querySelectorAll('.st-sw-sep'), function (x) { x.hidden = !colours; });
                gnote.textContent = !colours && spec.genderNote ? spec.genderNote(gd) : '';
                gnote.hidden = !gnote.textContent;
                vis = items.filter(function (b) { return !b.hidden; });
            }
            setRoving(vis, vis.indexOf(items[sel]));
        });
        return wrap;
    }

    // spec: {key, title, options:[{id,label,icon}], value(), pick(id), cls}
    function segmented(spec) {
        var row = el('div', 'st-seg' + (spec.cls ? ' ' + spec.cls : ''));
        row.setAttribute('role', 'radiogroup');
        row.setAttribute('aria-label', spec.title);
        var btns = spec.options.map(function (o) {
            var b = el('button', 'st-seg-btn');
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.dataset.value = o.id;
            if (o.icon) b.appendChild(icon(o.icon));
            b.appendChild(el('span', '', o.label));
            if (o.title) b.title = o.title;
            b.addEventListener('click', function () { spec.pick(o.id); });
            row.appendChild(b);
            return b;
        });
        rovingKeys(row, '.st-seg-btn');
        function sync() {
            var cur = String(spec.value());
            var sel = -1;
            btns.forEach(function (b, i) {
                var on = b.dataset.value === cur;
                if (on) sel = i;
                b.setAttribute('aria-checked', on ? 'true' : 'false');
                b.classList.toggle('is-selected', on);
            });
            setRoving(btns, sel);
        }
        S.syncers.push(sync);
        sync();
        return row;
    }

    // ------------------------------------------------------------------
    // Randomize, presets, reset, copy
    // ------------------------------------------------------------------
    function rng(seed) {
        var t = seed >>> 0;
        return function () {
            t += 0x6D2B79F5;
            var r = Math.imul(t ^ (t >>> 15), 1 | t);
            r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        };
    }
    function pick(list, r) { return list[Math.floor(r() * list.length) % list.length]; }

    // Fill `state` ({gender, color, appearance}) with a random look, keeping locked groups.
    function randomLook(state, r, locks) {
        locks = locks || {};
        var a = state.appearance;
        // A locked face keeps its lashes and lips when the body changes.
        if (locks.face) pinFaceDefaults(state);
        // 0.12.0: the gender stays (the Male / Female toggle sets it); every pick is one that gender is offered
        if (!locks.body) a.skinTone = r() < 0.05 ? pick(SKIN_FUN, r) : pick(SKIN, r);
        var b = state.gender === 'F', gd = b ? 'F' : 'M';
        var own = function (key, list) { return list.filter(function (id) { return allowed(key, id, gd); }); };
        if (!locks.hair) {
            a.hairStyle = !b && r() < 0.06 ? 'bald' : pick(own('hairStyle', HAIR_STYLES.filter(function (id) { return id !== 'bald'; })), r);
            a.hairColor = r() < 0.15 ? pick(HAIR_FUN, r) : pick(HAIR, r);
            a.hairHighlight = r() < 0.15 ? pick(HAIR_FUN.concat(HAIR), r) : null;
        }
        if (!locks.face) {
            a.eyebrowStyle = pick(own('eyebrowStyle', BROWS), r);
            a.eyeColor = pick(EYES, r);
            setLash(a, b && r() < 0.85 ? pick(LASHES.slice(1), r) : 'none');
            a.lipColor = b && r() < 0.6 ? pick(LIPS, r) : null;
            a.facialHair = !b && r() < 0.35 ? pick(FACIAL.slice(1), r) : null;
            a.facialHairColor = a.facialHair && r() < 0.5 ? a.hairColor : null;
        }
        if (!locks.outfit) {
            state.color = pick(SHIRTS, r);
            a.pantsColor = pick(PANTS, r);
            a.shoeColor = r() < 0.5 ? null : pick(SHOES, r);
            a.costume = r() < 0.04 ? pick(own('costume', COSTUMES.slice(1)), r) : null;
            a.shirtStyle = r() < 0.4 ? 'tee' : pick(own('shirtStyle', TOPS.slice(1)), r);
            a.neckwear = NECK_COLORS.length && r() < 0.2 ? pick(own('neckwear', NECKWEAR.slice(1)), r) : null;
            a.neckwearColor = a.neckwear ? pick(NECK_COLORS, r) : null;
        }
        if (!locks.hats) {
            a.headwear = r() < 0.35 ? pick(own('headwear', HEADWEAR.slice(1)), r) : null;
            a.headwearColor = a.headwear ? pick(HAT_COLORS, r) : null;
            a.glasses = r() < 0.3 ? pick(own('glasses', GLASSES.slice(1)), r) : null;
            a.glassesColor = a.glasses ? pick(LENS, r) : null;
        }
        if (!locks.items) {
            a.heldItem = r() < 0.35 ? pick(HELD.slice(1), r) : null;
            a.deskItem = r() < 0.9 ? pick(DESK_ITEMS.slice(1), r) : null;
        }
        return state;
    }
    function lookState(s) { return { gender: s.gender, color: s.color, appearance: clone(s.appearance) }; }
    function applyLookState(src) {
        edit(null, function (s) {
            if (src.gender !== s.gender) pinFaceDefaults(s);
            s.gender = src.gender || s.gender;
            if (src.color) s.color = src.color;
            var keepDesk = s.appearance && s.appearance.deskItem;
            s.appearance = clone(src.appearance);
            if (s.appearance.deskItem === undefined) s.appearance.deskItem = keepDesk;
        });
    }
    function randomize() {
        var s = es();
        if (!s) return;
        var next = randomLook(lookState(s), Math.random, S.locks);
        applyLookState(next);
    }
    function applyPreset(p) {
        edit(null, function (s, a) {
            if (p.color) s.color = p.color;
            Object.keys(p.look).forEach(function (k) { a[k] = p.look[k]; });
        });
    }
    function presetState(p) {
        var s = lookState(es());
        if (p.color) s.color = p.color;
        Object.keys(p.look).forEach(function (k) { s.appearance[k] = p.look[k]; });
        return s;
    }
    // The look an agent gets from its id when nothing was saved.
    function defaultLook(agentId, gender) {
        var cfg = g('officeConfig');
        if (!cfg || typeof getDefaultAppearance !== 'function') return null;
        var saved = cfg.agents;
        cfg.agents = [];
        try { return clone(getDefaultAppearance(agentId, gender)); } finally { cfg.agents = saved; }
    }
    function resetLook() {
        var s = es();
        if (!s) return;
        var def = defaultLook(s.id, s.gender);
        if (!def) return;
        edit(null, function (st) { st.appearance = def; });
    }
    function copyLookFrom(agentId) {
        var src = (g('agents') || []).find(function (a) { return a.id === agentId; });
        if (!src) return;
        var look = clone(src.getAppearance ? src.getAppearance() : src.appearance);
        applyLookState({ gender: src.gender, color: src.color, appearance: look });
    }

    // ------------------------------------------------------------------
    // Desks (CE-13): reuses the office's one-desk-per-agent rule via game.js
    // ------------------------------------------------------------------
    // Every desk and boss desk of the layout (all their variants: standing desks, the v13 desk types), in layout order
    // (top to bottom, left to right). owner: the name its assignedTo names (an id or statusKey of any provider's agent
    // reads as that agent's name); sitter: the agent sitting there now without owning it (the office's automatic desk,
    // game.js _autoAssignDesks; interns and other Office Life extras do not count). A desk is free with neither.
    function deskSitter(item) {
        return (g('agents') || []).find(function (a) {
            return a && !a._lifeExtra && a.desk && ((a.desk.id != null && a.desk.id === item.id) || (a.desk.x === item.x && a.desk.y === item.y));
        }) || null;
    }
    function deskList() {
        var cfg = g('officeConfig') || {};
        var desks = (cfg.furniture || []).filter(function (f) { return f.type === 'desk' || f.type === 'bossDesk'; });
        desks = desks.slice().sort(function (p, q) { return (p.y - q.y) || (p.x - q.x); });
        var n = 0, b = 0, bosses = desks.filter(function (d) { return d.type === 'bossDesk'; }).length;
        return desks.map(function (d) {
            var boss = d.type === 'bossDesk';
            var owner = d.assignedTo ? (typeof _deskOwnerName === 'function' ? _deskOwnerName(d.assignedTo) : d.assignedTo) : null;
            var sitter = owner ? null : deskSitter(d);
            return { id: d.id, item: d, boss: boss, label: boss ? (bosses > 1 ? 'Boss desk ' + (++b) : 'Boss desk') : 'Desk ' + (++n), owner: owner,
                sitter: sitter ? { id: sitter.id, name: sitter.name || sitter.id } : null };
        });
    }
    /** The free desks (no owner, nobody sitting there) in the order the office hands them out: desks, then boss desks. */
    function freeDesks(list) {
        list = (list || deskList()).filter(function (d) { return !d.owner && !d.sitter; });
        return list.filter(function (d) { return !d.boss; }).concat(list.filter(function (d) { return d.boss; }));
    }
    // I12: no desk picked = the office's automatic desk; name the one the agent sits at.
    function autoDeskText(st, list) {
        var a = st && (g('agents') || []).find(function (x) { return x.id === st.id; });
        var at = a && a.desk;
        var d = at && list.find(function (q) { return (at.id != null && q.id === at.id) || (q.item.x === at.x && q.item.y === at.y); });
        return d && !d.owner ? 'Automatic desk (' + d.label + ')' : 'Automatic desk';
    }
    function deskSelect(state, onPick) {
        var sel = el('select', 'st-select');
        sel.setAttribute('aria-label', 'Desk');
        function fill() {
            sel.innerHTML = '';
            var list = deskList();
            var none = el('option', '', autoDeskText(state(), list));
            none.value = '';
            sel.appendChild(none);
            list.forEach(function (d) {
                var st = state() || {}, mine = d.id === st.deskId;
                // (an agent's own automatic desk stays "free": nobody else has it)
                var by = d.owner || (d.sitter && d.sitter.id !== st.id ? d.sitter.name : null);
                var o = el('option', '', d.label + (mine ? '' : (by ? ' (taken by ' + by + ')' : ' (free)')));
                o.value = d.id;
                sel.appendChild(o);
            });
            sel.value = state().deskId || '';
        }
        fill();
        sel.addEventListener('focus', fill);
        sel.addEventListener('change', function () { onPick(sel.value || null); });
        return { el: sel, sync: function () { if (document.activeElement !== sel) fill(); } };
    }

    // "Show on map": hide the studio for a moment, centre a spot and ring it.
    // pos() is read every frame, so a walking agent stays ringed.
    function peekAt(pos, tipText, returnSel) {
        var body = document.body;
        if (body.classList.contains('vo-studio-peek')) return;
        var p0 = pos();
        body.classList.add('vo-studio-peek');
        try {
            if (typeof _cameraUserMoved === 'function') _cameraUserMoved();
            var zoom = (typeof camera !== 'undefined' && camera.zoom) || 1;
            if (typeof getBaseScale === 'function' && typeof getMaxZoom === 'function') {
                zoom = Math.max(zoom, Math.min(getMaxZoom(), Math.max(1, 1.1 / getBaseScale())));
            }
            if (typeof _applyCameraView === 'function') _applyCameraView({ x: p0.x - W / 2, y: p0.y - 20 - H / 2, zoom: zoom }, true, 420);
        } catch (e) { /* camera helpers missing: the ring still shows */ }
        var ring = el('div', 'st-desk-ring');
        ring.setAttribute('aria-hidden', 'true');
        var back = button('vo-btn--primary st-peek-back', 'Back to Agent Studio', 'agents');
        var tip = el('div', 'st-peek-tip', tipText);
        tip.setAttribute('role', 'status');
        body.appendChild(ring);
        body.appendChild(tip);
        body.appendChild(back);
        var until = performance.now() + 60000;
        function place() {
            if (!ring.isConnected) return;
            if (typeof _worldToScreen === 'function') {
                var w = pos();
                var p = _worldToScreen(w.x, w.y);
                var q = _worldToScreen(w.x + 40, w.y);
                var r = Math.max(28, Math.abs(q.x - p.x) * 1.2);
                ring.style.left = Math.round(p.x - r) + 'px';
                ring.style.top = Math.round(p.y - r * 0.8) + 'px';
                ring.style.width = Math.round(r * 2) + 'px';
                ring.style.height = Math.round(r * 1.6) + 'px';
            }
            if (performance.now() < until) requestAnimationFrame(place);
        }
        place();
        function done() {
            body.classList.remove('vo-studio-peek');
            ring.remove(); back.remove(); tip.remove();
            document.removeEventListener('keydown', onKey, true);
            var b = S.col && S.col.querySelector(returnSel);
            if (b) b.focus();
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
            // The studio is hidden: keep Tab on the way back instead of inside it.
            else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); back.focus(); }
        }
        back.addEventListener('click', done);
        document.addEventListener('keydown', onKey, true);
        setTimeout(function () { back.focus(); }, 30);
    }
    function showDeskOnMap() {
        var s = es();
        var desk = s && deskList().find(function (d) { return d.id === s.deskId; });
        if (!desk) return;
        peekAt(function () { return { x: desk.item.x, y: desk.item.y }; }, desk.label + ' is ringed on the map.', '.st-desk-show');
    }
    function showAgentOnMap() {
        var s = es();
        var agent = s && (g('agents') || []).find(function (a) { return a.id === s.id; });
        if (!agent) return;
        peekAt(function () { return { x: agent.x, y: agent.y - 24 }; }, (agent.name || 'The agent') + ' is ringed on the map.', '.st-find');
    }

    // ------------------------------------------------------------------
    // Emoji picker (CE-19)
    // ------------------------------------------------------------------
    function emojiPicker(anchor, current, onPick) {
        var old = document.querySelector('.st-emoji-pop');
        if (old) { old.remove(); return; }
        var pop = el('div', 'st-emoji-pop');
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', 'Choose an emoji');
        var grid = el('div', 'st-emoji-grid');
        grid.setAttribute('role', 'radiogroup');
        grid.setAttribute('aria-label', 'Emoji');
        var btns = EMOJIS.map(function (em) {
            var b = el('button', 'st-emoji', em);
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', em === current ? 'true' : 'false');
            b.addEventListener('click', function () { onPick(em); close(); });
            grid.appendChild(b);
            return b;
        });
        setRoving(btns, EMOJIS.indexOf(current));
        // Arrow keys move focus only here; Enter picks.
        grid.addEventListener('keydown', function (e) {
            var i = btns.indexOf(document.activeElement);
            if (i < 0) return;
            var cols = 8, next = -1;
            if (e.key === 'ArrowRight') next = Math.min(btns.length - 1, i + 1);
            else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1);
            else if (e.key === 'ArrowDown') next = Math.min(btns.length - 1, i + cols);
            else if (e.key === 'ArrowUp') next = Math.max(0, i - cols);
            if (next < 0) return;
            e.preventDefault();
            setRoving(btns, next);
            btns[next].focus();
        });
        pop.appendChild(grid);
        var own = el('label', 'st-emoji-own');
        own.appendChild(el('span', '', 'Or type one'));
        var inp = el('input');
        inp.type = 'text';
        inp.maxLength = 8;
        inp.value = EMOJIS.indexOf(current) < 0 ? (current || '') : '';
        inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); onPick(inp.value.trim()); close(); }
        });
        own.appendChild(inp);
        pop.appendChild(own);
        var host = anchor.closest('.agent-panel, .modal-content') || document.body;
        host.appendChild(pop);
        var ar = anchor.getBoundingClientRect(), hr = host.getBoundingClientRect();
        var left = Math.max(8, Math.min(ar.left - hr.left, hr.width - pop.offsetWidth - 8));
        var top = ar.bottom - hr.top + 6;
        if (top + pop.offsetHeight > hr.height - 8) top = Math.max(8, ar.top - hr.top - pop.offsetHeight - 6);
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
        function close() {
            pop.remove();
            document.removeEventListener('mousedown', outside, true);
            document.removeEventListener('keydown', onKey, true);
            anchor.focus();
        }
        function outside(e) { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); }
        function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', onKey, true);
        var first = btns[Math.max(0, EMOJIS.indexOf(current))];
        setTimeout(function () { first.focus(); }, 0);
    }

    // ------------------------------------------------------------------
    // Panels per category (CE-18)
    // ------------------------------------------------------------------
    var CATS = [
        { id: 'looks', label: 'Looks', icon: 'sparkle' },
        { id: 'body', label: 'Body', icon: 'agents' },
        { id: 'hair', label: 'Hair', icon: 'st-hair' },
        { id: 'face', label: 'Face', icon: 'st-face' },
        { id: 'outfit', label: 'Outfit', icon: 'st-shirt' },
        { id: 'hats', label: 'Hats and glasses', icon: 'st-hat' },
        { id: 'items', label: 'Items and desk', icon: 'st-mug' },
        { id: 'moves', label: 'Moves', icon: 'trophy' },
        { id: 'voice', label: 'Voice', icon: 'mic' },
        { id: 'details', label: 'Details', icon: 'edit', phoneOnly: true },
        { id: 'advanced', label: 'Advanced', icon: 'gear' }
    ];

    function A() { return es().appearance; }
    function setA(key, coalesce) {
        return function (v) { edit(coalesce, function (s, a) { a[key] = v === 'none' ? null : v; }); };
    }
    function valA(key) { return function () { var v = A()[key]; return v == null ? 'none' : v; }; }

    function panelLooks(p) {
        var presetWrap = field('Start from a look', { hint: 'Outfit sets keep the face, hair and skin.' });
        var grid = el('div', 'st-tiles st-tiles--body');
        grid.setAttribute('role', 'list');
        var presetTiles = PRESETS.map(function (pr) {
            var t = el('button', 'st-tile');
            t.type = 'button';
            t.setAttribute('role', 'listitem');
            t.dataset.preset = pr.id;
            var cv = el('canvas', 'st-tile-canvas');
            cv.setAttribute('aria-hidden', 'true');
            t.appendChild(cv);
            t.appendChild(el('span', 'st-tile-label', pr.label));
            t.addEventListener('click', function () { applyPreset(pr); });
            grid.appendChild(t);
            return t;
        });
        rovingKeys(grid, '.st-tile', true);
        setRoving(presetTiles, 0);
        presetWrap.appendChild(grid);
        p.appendChild(presetWrap);

        var ideasWrap = field('Ideas for this agent', { hint: 'Six random looks. Locked parts stay.' });
        var ideaGrid = el('div', 'st-tiles st-tiles--body');
        ideaGrid.setAttribute('role', 'list');
        var ideaTiles = [];
        for (var i = 0; i < 6; i++) {
            (function (idx) {
                var t = el('button', 'st-tile');
                t.type = 'button';
                t.setAttribute('role', 'listitem');
                t.dataset.idea = String(idx);
                var cv = el('canvas', 'st-tile-canvas');
                cv.setAttribute('aria-hidden', 'true');
                t.appendChild(cv);
                t.appendChild(el('span', 'st-tile-label', 'Idea ' + (idx + 1)));
                t.addEventListener('click', function () { if (t._state) applyLookState(clone(t._state)); });
                ideaGrid.appendChild(t);
                ideaTiles.push(t);
            })(i);
        }
        rovingKeys(ideaGrid, '.st-tile', true);
        setRoving(ideaTiles, 0);
        ideasWrap.appendChild(ideaGrid);
        var more = button('st-more', 'More ideas', 'st-dice');
        more.addEventListener('click', function () { S.ideasSeed = Math.floor(Math.random() * 1e9); refresh(); });
        ideasWrap.appendChild(more);
        p.appendChild(ideasWrap);

        var copyWrap = field('Copy look from');
        var copySel = el('select', 'st-select');
        copySel.setAttribute('aria-label', 'Copy look from another agent');
        copyWrap.appendChild(copySel);
        var copyBtn = button('', 'Copy look', 'copy');
        copyBtn.addEventListener('click', function () { if (copySel.value) copyLookFrom(copySel.value); });
        var copyRow = el('div', 'st-row');
        copyRow.appendChild(copySel);
        copyRow.appendChild(copyBtn);
        copyWrap.appendChild(copyRow);
        p.appendChild(copyWrap);
        (g('agents') || []).forEach(function (a) {
            if (a.id === es().id) return;
            var o = el('option', '', (a.emoji ? a.emoji + ' ' : '') + a.name);
            o.value = a.id;
            copySel.appendChild(o);
        });
        copyBtn.disabled = !copySel.options.length;

        S.syncers.push(function () {
            var s = es();
            presetTiles.forEach(function (t, i) {
                var st = presetState(PRESETS[i]);
                var key = JSON.stringify(st);
                if (key === t._drawKey) return;
                t._drawKey = key;
                renderAgentPreview(t.firstChild, st.appearance, { view: 'body', color: st.color || s.color, gender: st.gender, floor: false });
            });
            var r = rng(S.ideasSeed);
            ideaTiles.forEach(function (t) {
                var st = randomLook(lookState(s), r, S.locks);
                t._state = st;
                var key = JSON.stringify(st);
                if (key === t._drawKey) return;
                t._drawKey = key;
                renderAgentPreview(t.firstChild, st.appearance, { view: 'body', color: st.color, gender: st.gender, floor: false });
            });
        });
    }

    // The Male / Female toggle (0.12.0) heads every look tab (showCat), so Body is skin tone.
    function panelBody(p) {
        p.appendChild(swatchGroup({
            key: 'skinTone', title: 'Skin tone', colors: SKIN, fun: SKIN_FUN,
            value: function () { return A().skinTone; },
            pick: function (v) { edit('swatch:skinTone', function (s, a) { a.skinTone = v; }); }
        }));
    }

    function panelHair(p) {
        p.appendChild(tileGroup({
            key: 'hairStyle', allow: allowFn('hairStyle'), title: 'Hair style', options: HAIR_STYLES, tileCls: 'st-tiles--hair', value: function () { return A().hairStyle || 'short'; },
            label: function (id) { return _HAIR_BY_ID[id].label; },
            groupOf: function (id) { var g = _HAIR_BY_ID[id].group; return HAIR_GROUPS.filter(function (x) { return x.id === g; })[0]; },
            look: function (id) { return lookOf(es(), { hairStyle: id, headwear: null, costume: null }); },
            pick: setA('hairStyle', 'tile:hairStyle')
        }));
        p.appendChild(swatchGroup({
            key: 'hairColor', title: 'Hair colour', colors: HAIR, fun: HAIR_FUN, recent: true,
            value: function () { return A().hairColor; },
            pick: function (v) { edit('swatch:hairColor', function (s, a) { a.hairColor = v; }); }
        }));
        p.appendChild(swatchGroup({
            key: 'hairHighlight', title: 'Highlight', colors: HAIR, fun: HAIR_FUN, none: 'None',
            when: function () { return A().hairStyle !== 'bald'; },
            value: function () { return A().hairHighlight || null; },
            pick: function (v) { edit('swatch:hairHighlight', function (s, a) { a.hairHighlight = v; }); }
        }));
    }

    function panelFace(p) {
        // v0.12 faces: preview each expression on the stage. The office picks the face from real state; nothing is saved.
        if ((window.AGENT_EXPRESSIONS || []).length) p.appendChild(tileGroup({
            key: 'expression', title: 'Expression (preview)', options: window.AGENT_EXPRESSIONS,
            hint: 'The office picks the face from what the agent is doing. Not saved.',
            label: function (id) { return FACE_NAMES[id] || label(id); },
            value: function () { return S.expression || 'neutral'; },
            look: function () { return lookOf(es(), { headwear: null, costume: null, glasses: null }); },
            state: function (id) { return { expression: id }; },
            pick: function (id) { S.expression = id; refresh(); }
        }));
        p.appendChild(tileGroup({
            key: 'eyebrowStyle', allow: allowFn('eyebrowStyle'), title: 'Eyebrows', options: BROWS,
            value: function () { return A().eyebrowStyle || (es().gender === 'F' ? 'thin' : 'thick'); },
            look: function (id) { return lookOf(es(), { eyebrowStyle: id, headwear: null, costume: null, glasses: null }); },
            pick: setA('eyebrowStyle', 'tile:eyebrowStyle')
        }));
        p.appendChild(swatchGroup({
            key: 'eyeColor', title: 'Eye colour', colors: EYES,
            value: function () { return A().eyeColor || '#212121'; },
            pick: function (v) { edit('swatch:eyeColor', function (s, a) { a.eyeColor = v; }); }
        }));
        p.appendChild(tileGroup({
            key: 'lashes', title: 'Lashes', options: LASHES, label: namesOf(LASH_TABLE),
            allow: allowFn('lashes'), genderNote: function (g) { return g === 'M' ? 'Lash styles are in the Female set.' : ''; },
            value: function () { return lashId(es()); },
            look: function (id) {
                return lookOf(es(), { lashes: id !== 'none', lashStyle: id === 'none' || id === 'natural' ? null : id, lipColor: effLip(es()), headwear: null, costume: null, glasses: null });
            },
            pick: function (id) { edit('tile:lashes', function (s, a) { setLash(a, id); }); }
        }));
        p.appendChild(swatchGroup({
            key: 'lipColor', title: 'Lip colour', colors: LIPS, none: 'None',
            allow: function (hex, g) { return allowed('lipColor', hex, g); },
            genderNote: function (g) { return g === 'M' ? 'Lip colours are in the Female set.' : ''; },
            value: function () { return effLip(es()); },
            pick: function (v) { edit('swatch:lipColor', function (s, a) { a.lipColor = v; }); }
        }));
        p.appendChild(tileGroup({
            key: 'facialHair', title: 'Facial hair', options: FACIAL, value: valA('facialHair'),
            allow: allowFn('facialHair'), genderNote: function (g) { return g === 'F' ? 'Facial hair is in the Male set.' : ''; },
            look: function (id) { return lookOf(es(), { facialHair: id === 'none' ? null : id, headwear: null, costume: null, glasses: null }); },
            pick: setA('facialHair', 'tile:facialHair')
        }));
        p.appendChild(swatchGroup({
            key: 'facialHairColor', title: 'Facial hair colour', colors: HAIR, none: 'Default',
            hint: 'Default is a shade of the skin.',
            when: function () { return !!A().facialHair; },
            value: function () { return A().facialHairColor || null; },
            pick: function (v) { edit('swatch:facialHairColor', function (s, a) { a.facialHairColor = v; }); }
        }));
    }

    function panelOutfit(p) {
        p.appendChild(swatchGroup({
            key: 'shirt', title: 'Shirt', colors: SHIRTS, recent: true, hint: 'Also the colour of the name tag.',
            value: function () { return es().color; },
            pick: function (v) { edit('swatch:shirt', function (s) { s.color = v; }); }
        }));
        p.appendChild(swatchGroup({
            key: 'pantsColor', title: 'Trousers', colors: PANTS, recent: true,
            value: function () { return A().pantsColor || DEFAULT_PANTS; },
            pick: function (v) { edit('swatch:pantsColor', function (s, a) { a.pantsColor = v; }); }
        }));
        p.appendChild(swatchGroup({
            key: 'shoeColor', title: 'Shoes', colors: SHOES, none: 'Default',
            value: function () { return A().shoeColor || null; },
            pick: function (v) { edit('swatch:shoeColor', function (s, a) { a.shoeColor = v; }); }
        }));
        // v0.12: tops and neckwear, drawn by the office's own code (a costume covers them).
        var hidden = function () { return A().costume ? 'Hidden by the ' + costumeName(A().costume).toLowerCase() + ' costume.' : null; };
        p.appendChild(tileGroup({
            key: 'shirtStyle', allow: allowFn('shirtStyle'), title: 'Top', view: 'body', tileCls: 'st-tiles--body', options: TOPS, label: topName,
            hint: 'The shirt colour above is the colour of the top.', disabled: hidden,
            value: function () { return typeof _lookTop === 'function' ? _lookTop(A()) : (A().shirtStyle || 'tee'); },
            look: function (id) { return lookOf(es(), { shirtStyle: id, costume: null }); },
            pick: setA('shirtStyle', 'tile:shirtStyle')
        }));
        p.appendChild(tileGroup({
            key: 'neckwear', allow: allowFn('neckwear'), title: 'Neckwear', view: 'body', tileCls: 'st-tiles--body', options: NECKWEAR, label: neckName, disabled: hidden,
            value: valA('neckwear'),
            look: function (id) { return lookOf(es(), { neckwear: id === 'none' ? null : id, costume: null }); },
            pick: setA('neckwear', 'tile:neckwear')
        }));
        p.appendChild(swatchGroup({
            key: 'neckwearColor', title: 'Neckwear colour', colors: NECK_COLORS, recent: true,
            when: function () { return !!A().neckwear && !A().costume; },
            value: function () { var n = A().neckwear, o = BODY && BODY.neckwear.find(function (x) { return x.id === n; }); return A().neckwearColor || (o && o.color) || null; },
            pick: function (v) { edit('swatch:neckwearColor', function (s, a) { a.neckwearColor = v; }); }
        }));
        p.appendChild(tileGroup({
            key: 'costume', allow: allowFn('costume'), title: 'Costume', view: 'body', tileCls: 'st-tiles--body', options: COSTUMES, label: costumeName,
            hint: 'A costume hides the hat, the top and the neckwear while it is on.',
            value: valA('costume'),
            look: function (id) { return lookOf(es(), { costume: id === 'none' ? null : id }); },
            pick: function (id) {
                edit('tile:costume', function (s, a) { a.costume = id === 'none' ? null : id; });
                if (typeof _costumeCache !== 'undefined') _costumeCache = {};
            }
        }));
    }

    function panelHats(p) {
        var takeOff = button('st-inline', 'Take off the costume', null);
        takeOff.addEventListener('click', function () { edit(null, function (s, a) { a.costume = null; }); });
        p.appendChild(tileGroup({
            key: 'headwear', allow: allowFn('headwear'), title: 'Headwear', options: HEADWEAR, label: hatName, value: valA('headwear'),
            look: function (id) { return lookOf(es(), { headwear: id === 'none' ? null : id, costume: null, glasses: null }); },
            disabled: function () { return A().costume ? 'Hidden by the ' + costumeName(A().costume).toLowerCase() + ' costume.' : null; },
            after: takeOff,
            pick: setA('headwear', 'tile:headwear')
        }));
        S.syncers.push(function () { takeOff.hidden = !A().costume; });
        p.appendChild(swatchGroup({
            key: 'headwearColor', title: 'Hat colour', colors: HAT_COLORS, recent: true,
            when: function () { return !!A().headwear && !A().costume; },
            value: function () { return A().headwearColor || '#888888'; },
            pick: function (v) { edit('swatch:headwearColor', function (s, a) { a.headwearColor = v; }); }
        }));
        p.appendChild(tileGroup({
            key: 'glasses', allow: allowFn('glasses'), title: 'Glasses', options: GLASSES, value: valA('glasses'),
            look: function (id) { return lookOf(es(), { glasses: id === 'none' ? null : id, costume: null }); },
            pick: setA('glasses', 'tile:glasses')
        }));
        p.appendChild(swatchGroup({
            key: 'glassesColor', title: 'Frame colour', colors: LENS, recent: true,
            when: function () { return !!A().glasses; },
            value: function () { return A().glassesColor || '#333333'; },
            pick: function (v) { edit('swatch:glassesColor', function (s, a) { a.glassesColor = v; }); }
        }));
    }

    function panelItems(p) {
        p.appendChild(tileGroup({
            key: 'heldItem', title: 'Held item', view: 'body', tileCls: 'st-tiles--body', options: HELD, value: valA('heldItem'),
            look: function (id) { return lookOf(es(), { heldItem: id === 'none' ? null : id }); },
            pick: function (id) {
                if (S.pose !== 'stand' && S.pose !== 'walk') setPose('stand');
                setA('heldItem', 'tile:heldItem')(id);
            }
        }));
        p.appendChild(tileGroup({
            key: 'deskItem', title: 'Desk item', hint: 'Sits on the agent\'s desk.', view: 'deskItem', withDesk: true, noAgent: true,
            options: DESK_ITEMS, value: valA('deskItem'),
            look: function (id) { return lookOf(es(), { deskItem: id === 'none' ? null : id }); },
            state: function () { return { pose: 'type' }; },
            pick: function (id) {
                // Show it: the desk item is on the desk, so sit the stage down.
                if (S.pose === 'stand' || S.pose === 'walk') setPose('type');
                setA('deskItem', 'tile:deskItem')(id);
            }
        }));
    }

    // Identity: a strip above the stage on desktop, the Details category on a phone.
    function identityBlock() {
        var s = es();
        var agent = S.agent;
        var box = el('div', 'st-identity');
        function text(name, value, max, placeholder) {
            var l = el('label', 'st-input st-input--' + name);
            l.appendChild(el('span', 'st-input-label', placeholder));
            var inp = el('input');
            inp.type = 'text';
            inp.maxLength = max;
            inp.value = value || '';
            inp.autocomplete = 'off';
            inp.addEventListener('input', function () {
                edit('text:' + name, function (st) { st[name] = inp.value; });
                updateCaption();
            });
            inp.addEventListener('change', function () { call('_acpRefreshList'); });
            l.appendChild(inp);
            return l;
        }
        var row1 = el('div', 'st-id-row');
        row1.appendChild(text('name', s.name, 80, 'Name'));
        row1.appendChild(text('role', s.role, 160, 'Role'));
        box.appendChild(row1);
        var row2 = el('div', 'st-id-row');
        var emo = el('div', 'st-input st-input--emoji');
        emo.appendChild(el('span', 'st-input-label', 'Emoji'));
        var emoBtn = el('button', 'vo-btn st-emoji-btn', s.emoji || '🙂');
        emoBtn.type = 'button';
        emoBtn.setAttribute('aria-haspopup', 'dialog');
        emoBtn.setAttribute('aria-label', 'Emoji: ' + (s.emoji || 'none') + '. Choose another');
        emoBtn.addEventListener('click', function () {
            emojiPicker(emoBtn, es().emoji, function (em) {
                edit('emoji', function (st) { st.emoji = em; });
                emoBtn.textContent = em;
                emoBtn.setAttribute('aria-label', 'Emoji: ' + em + '. Choose another');
                call('_acpRefreshList');
            });
        });
        emo.appendChild(emoBtn);
        row2.appendChild(emo);
        var br = el('label', 'st-input st-input--branch');
        br.appendChild(el('span', 'st-input-label', 'Branch'));
        var bsel = el('select', 'st-select');
        (typeof getBranchList === 'function' ? getBranchList() : []).forEach(function (b) {
            // Names only: an option cannot hold a pixel icon, and an emoji there reads as one (N8).
            var o = el('option', '', b.name);
            o.value = b.id;
            bsel.appendChild(o);
        });
        bsel.value = s.branch || 'UNASSIGNED';
        bsel.addEventListener('change', function () { edit('branch', function (st) { st.branch = bsel.value; }); call('_acpRefreshList'); });
        br.appendChild(bsel);
        row2.appendChild(br);
        var dk = el('div', 'st-input st-input--desk');
        dk.appendChild(el('span', 'st-input-label', 'Desk'));
        var deskRow = el('div', 'st-row');
        var ds = deskSelect(es, function (id) { edit('desk', function (st) { st.deskId = id; }); });
        deskRow.appendChild(ds.el);
        var show = button('vo-btn--icon st-desk-show', '', 'target', 'Show the desk on the map');
        show.addEventListener('click', showDeskOnMap);
        deskRow.appendChild(show);
        dk.appendChild(deskRow);
        row2.appendChild(dk);
        box.appendChild(row2);
        if (agent && agent.available === false) {
            box.appendChild(el('p', 'st-offline', 'Offline: the native agent was not found in the latest scan.'));
        }
        S.syncers.push(function () { ds.sync(); show.disabled = !es().deskId; });
        return box;
    }

    function panelAdvanced(p) {
        var agent = S.agent || {};
        var provider = typeof _providerKindDisplay === 'function'
            ? _providerKindDisplay(agent.providerKind || 'openclaw', agent) : (agent.providerKind || 'OpenClaw');
        var link = field('Linked ' + provider + ' agent');
        var sel = el('select', 'st-select');
        sel.setAttribute('aria-describedby', 'st-link-warn');
        var none = el('option', '', 'Not linked');
        none.value = '';
        sel.appendChild(none);
        var loading = el('option', '', 'Loading agents...');
        loading.value = '_loading';
        loading.disabled = true;
        sel.appendChild(loading);
        var current = es().statusKey || '';
        if (current) {
            var cur = el('option', '', current);
            cur.value = current;
            sel.appendChild(cur);
        }
        sel.value = current;
        link.appendChild(sel);
        var warn = el('p', 'st-warn', 'Changing this links the character to another ' + provider +
            ' agent: chat, status and work then come from that agent. Most people never need to change it.');
        warn.id = 'st-link-warn';
        link.appendChild(warn);
        p.appendChild(link);
        fetch('/agents-list').then(function (r) { return r.json(); }).then(function (data) {
            loading.remove();
            var taken = {};
            (g('agents') || []).forEach(function (a) { if (a.statusKey && a.id !== agent.id) taken[a.statusKey] = a.name; });
            (data.agents || []).forEach(function (oc) {
                var known = Array.prototype.find.call(sel.options, function (x) { return x.value === oc.key; });
                if (known) known.remove();
                var o = el('option', '', (oc.emoji ? oc.emoji + ' ' : '') + oc.name + ' (' + oc.agentId + ')' + (taken[oc.key] ? ', linked to ' + taken[oc.key] : ''));
                o.value = oc.key;
                sel.appendChild(o);
            });
            sel.value = es().statusKey || '';
        }).catch(function () { loading.textContent = 'Could not load the list'; });
        sel.addEventListener('change', function () {
            if (sel.value === '_loading') return;
            edit('statusKey', function (s) { s.statusKey = sel.value; });
            if (S.agent) S.agent.statusKey = sel.value;
        });

        var info = field('About this agent');
        var dl = el('dl', 'st-dl');
        [['Virtual Office ID', agent.id || '-'], ['Provider', provider], ['Runtime key', agent.statusKey || 'Not linked']].forEach(function (r) {
            dl.appendChild(el('dt', '', r[0]));
            dl.appendChild(el('dd', '', r[1]));
        });
        info.appendChild(dl);
        p.appendChild(info);

        // (the server never deletes a provider's main agent: its profile is "main" whatever its office id is,
        //  e.g. prov-2-main behind the provider layer, codex-main, claude-code-main)
        var profile = String(agent.providerAgentId || agent.profile || agent.id || '');
        if (agent.id && agent.id !== 'main' && profile !== 'main') {
            var del = field(agent.available === false ? 'Forget this offline agent' : 'Delete this agent');
            var delBtn = button('vo-btn--danger st-delete', agent.available === false ? 'Forget offline agent' : 'Delete agent', 'close');
            delBtn.addEventListener('click', function () { call('_acpDeleteAgent', agent.id); });
            del.appendChild(delBtn);
            p.appendChild(del);
        }
    }

    function panelDetails(p) { p.appendChild(identityBlock()); }

    // Voice (uV-voice): the agent's own voice for read aloud and voice mode in the chat window — a voice service and one
    // of its voices, or its owner's default (Settings > Voice), its speed, the browser's voice. My Virtual World's
    // "Its voice", drawn by the provider layer (window.voPL.mountAgentVoice) and saved with the agent at once.
    function panelVoice(p) {
        var agent = S.agent || {};
        var wrap = field('Its voice', { hint: 'How it sounds when it reads its answers aloud and in voice mode. The services and the default voice are in Settings > Voice.' });
        var host = el('div', 'st-voice');
        wrap.appendChild(host);
        p.appendChild(wrap);
        var id = agent.statusKey || agent.id || '';
        var draw = function () {
            if (!window.voPL || typeof window.voPL.mountAgentVoice !== 'function') return false;
            window.voPL.mountAgentVoice(host, id, agent.name || '').catch(function (e) { host.textContent = 'The voice could not load: ' + (e && e.message ? e.message : e); });
            return true;
        };
        if (!id) { host.appendChild(el('p', 'st-hint', 'Save the agent first: then choose its voice here.')); return; }
        if (draw()) return;
        host.appendChild(el('p', 'st-hint', 'Voices need the office\'s chat window service, which is not running on this server.'));
        window.addEventListener('vo:pl-ready', function () { if (host.isConnected) { host.textContent = ''; draw(); } }, { once: true });
    }

    // Look tabs that start with the Male / Female toggle (0.12.0).
    var GENDER_CATS = ['looks', 'body', 'hair', 'face', 'outfit', 'hats'];
    var PANELS = { looks: panelLooks, body: panelBody, hair: panelHair, face: panelFace, outfit: panelOutfit,
        hats: panelHats, items: panelItems, moves: panelMoves, voice: panelVoice, details: panelDetails, advanced: panelAdvanced };

    // ------------------------------------------------------------------
    // Build
    // ------------------------------------------------------------------
    function setPose(id) {
        S.pose = id;
        store('vo-studio-pose', JSON.stringify(id));
        refresh();
    }
    function updateCaption() {
        var cap = S.col && S.col.querySelector('.st-caption');
        if (!cap) return;
        var s = es();
        cap.querySelector('.st-caption-name').textContent = s.name || 'Unnamed';
        cap.querySelector('.st-caption-role').textContent = s.role || '';
    }

    // v0.12 moves: the agent's signature move (game.js SIGNATURE_MOVES, the one list). 'auto' = picked from the
    // agent's id, as the office does; the stage's Play move button and a picked tile play it (also with Office life off).
    var SIG = typeof SIGNATURE_MOVES !== 'undefined' ? SIGNATURE_MOVES : [];
    function sigOf(id) { for (var i = 0; i < SIG.length; i++) if (SIG[i].id === id) return SIG[i]; return null; }
    function sigResolved(id) {
        if (sigOf(id)) return id;
        var key = S.agent ? S.agent.id : '';
        return typeof _sigMoveOf === 'function' ? _sigMoveOf({ id: key }) : (SIG[0] ? SIG[0].id : '');
    }
    function sigValue() { var v = A() && A().signatureMove; return sigOf(v) ? v : 'auto'; }
    function sigStage(now) {
        if (!S.sig) return null;
        if (now - S.sig.at >= S.sig.ms) { S.sig = null; return null; }
        return S.sig.id;
    }
    function playSig() {
        var m = sigOf(sigResolved(sigValue()));
        if (!m) return;
        S.sig = { id: m.id, at: performance.now(), ms: m.ms };
        var tick = function (now) {
            if (!S.sig || !S.stageCanvas || !S.stageCanvas.isConnected) { drawStage(performance.now()); return; }
            if (!(S.playing && !reducedMotion())) drawStage(now); // the stage loop draws it otherwise
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
    function sigButton() {
        var b = button('vo-btn--ghost st-sigplay', 'Play move', 'trophy', 'Play the signature move');
        b.addEventListener('click', playSig);
        return b;
    }
    function panelMoves(p) {
        p.appendChild(tileGroup({
            key: 'signatureMove', title: 'Signature move', view: 'body', tileCls: 'st-tiles--body',
            hint: 'Played in the office on a real win: a task or a project finished, or back on track (Office life celebrations).',
            options: ['auto'].concat(SIG.map(function (m) { return m.id; })), value: sigValue,
            label: function (id) { var m = sigOf(sigResolved(id)); return id === 'auto' ? 'Auto' + (m ? ': ' + m.label : '') : (m ? m.label : id); },
            state: function (id) { return { sigMove: sigResolved(id), sigStill: true }; },
            pick: function (id) {
                if (S.pose === 'walk') setPose('stand');
                setA('signatureMove', 'tile:signatureMove')(id);
                playSig();
            }
        }));
    }
    function playButton() {
        var b = button('vo-btn--icon st-play', '', S.playing ? 'st-pause' : 'st-play', S.playing ? 'Pause the animation' : 'Play the animation');
        b.setAttribute('aria-pressed', S.playing ? 'false' : 'true');
        b.addEventListener('click', function () {
            S.playing = !S.playing;
            b.replaceWith(playButton());
            if (S.playing) startLoop();
            refresh();
        });
        return b;
    }

    // v0.12 faces: names of the expressions the office draws from real state (game.js AGENT_EXPRESSIONS).
    var FACE_NAMES = { neutral: 'Neutral', focused: 'Focused', stuck: 'Stuck', happy: 'Happy', sleepy: 'Sleepy', surprised: 'Surprised', waiting: 'Waiting' };

    function buildStage() {
        S.expression = 'neutral';
        var col = el('div', 'st-stage-col');
        var stage = el('div', 'st-stage');
        var cv = el('canvas', 'st-stage-canvas');
        cv.setAttribute('role', 'img');
        cv.setAttribute('aria-label', 'Live preview of the agent');
        stage.appendChild(cv);
        stage.appendChild(playButton());
        stage.appendChild(sigButton());
        col.appendChild(stage);
        S.stage = stage;
        S.stageCanvas = cv;

        var cap = el('div', 'st-caption');
        cap.appendChild(el('span', 'st-caption-name'));
        cap.appendChild(el('span', 'st-caption-role'));
        var find = button('vo-btn--ghost st-find', 'Find in office', 'target', 'Show this agent in the office');
        find.addEventListener('click', showAgentOnMap);
        cap.appendChild(find);
        col.appendChild(cap);

        col.appendChild(segmented({
            key: 'pose', title: 'Pose', cls: 'st-poses',
            options: [{ id: 'stand', label: 'Stand' }, { id: 'walk', label: 'Walk' }, { id: 'type', label: 'Sit and type' }, { id: 'idle', label: 'Idle' }],
            value: function () { return S.pose === 'sit' ? 'type' : S.pose; },
            pick: setPose
        }));
        var row = el('div', 'st-stage-row');
        var facings = facingList();
        var names = { down: 'Front', left: 'Left', right: 'Right', up: 'Back' };
        if (facings.length > 1) {
            row.appendChild(segmented({
                key: 'facing', title: 'Facing', cls: 'st-facing',
                options: ['left', 'down', 'right', 'up'].filter(function (f) { return facings.indexOf(f) >= 0; })
                    .map(function (f) { return { id: f, label: names[f] }; }),
                value: currentFacing,
                pick: function (f) { S.facing = f; refresh(); }
            }));
        }
        row.appendChild(segmented({
            key: 'zoom', title: 'Zoom', cls: 'st-zoom',
            options: [{ id: '0', label: 'Fit' }, { id: '4', label: '4x' }, { id: '5', label: '5x' }, { id: '6', label: '6x' }],
            value: function () { return String(S.zoom || 0); },
            pick: function (z) { S.zoom = Number(z) || 0; store('vo-studio-zoom', JSON.stringify(S.zoom)); refresh(); }
        }));
        col.appendChild(row);

        var tools = el('div', 'st-tools');
        var dice = button('st-dice', 'Randomize', 'st-dice', 'Randomize the look (keeps locked parts)');
        dice.addEventListener('click', randomize);
        tools.appendChild(dice);
        var lockBtn = button('vo-btn--icon st-locks-btn', '', 'lock', 'Choose what Randomize keeps');
        lockBtn.setAttribute('aria-haspopup', 'true');
        lockBtn.setAttribute('aria-expanded', 'false');
        lockBtn.addEventListener('click', function () { toggleLocks(lockBtn); });
        tools.appendChild(lockBtn);
        var undo = button('vo-btn--icon', '', 'undo', 'Undo (Ctrl+Z)');
        undo.id = 'acp-undo-btn';
        undo.addEventListener('click', function () { call('_acpUndo'); });
        var redo = button('vo-btn--icon', '', 'st-redo', 'Redo (Ctrl+Shift+Z)');
        redo.id = 'acp-redo-btn';
        redo.addEventListener('click', function () { call('_acpRedo'); });
        var reset = button('st-reset', 'Reset look', 'st-reset', 'Back to this agent\'s default look');
        reset.addEventListener('click', resetLook);
        tools.appendChild(undo);
        tools.appendChild(redo);
        tools.appendChild(reset);
        col.appendChild(tools);
        return col;
    }

    function toggleLocks(anchor) {
        var old = document.querySelector('.st-locks-pop');
        if (old) { old.remove(); anchor.setAttribute('aria-expanded', 'false'); return; }
        var pop = el('div', 'st-locks-pop');
        pop.setAttribute('role', 'group');
        pop.setAttribute('aria-label', 'Randomize keeps');
        pop.appendChild(el('p', 'st-locks-title', 'Randomize keeps'));
        LOCK_GROUPS.forEach(function (lg) {
            var l = el('label', 'st-check');
            var c = el('input');
            c.type = 'checkbox';
            c.checked = !!S.locks[lg.id];
            c.addEventListener('change', function () {
                S.locks[lg.id] = c.checked;
                store('vo-studio-locks', JSON.stringify(S.locks));
                syncLockBadge();
                refresh();
            });
            l.appendChild(c);
            l.appendChild(el('span', '', lg.label));
            pop.appendChild(l);
        });
        var host = anchor.closest('.agent-panel') || document.body;
        host.appendChild(pop);
        var ar = anchor.getBoundingClientRect(), hr = host.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(ar.left - hr.left, hr.width - pop.offsetWidth - 8)) + 'px';
        var top = ar.bottom - hr.top + 6;
        if (top + pop.offsetHeight > hr.height - 8) top = Math.max(8, ar.top - hr.top - pop.offsetHeight - 6);
        pop.style.top = top + 'px';
        anchor.setAttribute('aria-expanded', 'true');
        function close() {
            pop.remove();
            anchor.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', outside, true);
            document.removeEventListener('keydown', onKey, true);
        }
        function outside(e) { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); }
        function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); anchor.focus(); } }
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', onKey, true);
        var first = pop.querySelector('input');
        if (first) first.focus();
    }
    function syncLockBadge() {
        var b = S.col && S.col.querySelector('.st-locks-btn');
        if (!b) return;
        var n = LOCK_GROUPS.filter(function (lg) { return S.locks[lg.id]; }).length;
        b.classList.toggle('is-on', n > 0);
        b.dataset.count = n ? String(n) : '';
        b.title = n ? 'Randomize keeps ' + n + ' part' + (n === 1 ? '' : 's') : 'Choose what Randomize keeps';
    }

    function showCat(id) {
        var cats = CATS.filter(function (c) { return !c.phoneOnly || S.phone; });
        if (!cats.some(function (c) { return c.id === id; })) id = 'looks';
        S.cat = id;
        var tabs = S.col.querySelectorAll('.st-cat');
        Array.prototype.forEach.call(tabs, function (t) {
            var on = t.dataset.cat === id;
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
            t.classList.toggle('is-active', on);
            if (on && S.phone && t.scrollIntoView) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
        var adv = S.col.querySelector('.st-adv-link');
        if (adv) adv.setAttribute('aria-pressed', id === 'advanced' ? 'true' : 'false');
        var panel = S.col.querySelector('.st-panel');
        // Syncers of the old panel go; stage and identity syncers stay.
        S.syncers = S.syncers.filter(function (fn) { return !fn._panel; });
        var before = S.syncers.length;
        panel.innerHTML = '';
        if (document.getElementById('st-cat-' + id)) { panel.removeAttribute('aria-label'); panel.setAttribute('aria-labelledby', 'st-cat-' + id); }
        else { panel.removeAttribute('aria-labelledby'); panel.setAttribute('aria-label', (CATS.find(function (c) { return c.id === id; }) || {}).label || id); }
        panel.scrollTop = 0;
        if (GENDER_CATS.indexOf(id) >= 0) panel.appendChild(genderField());
        PANELS[id](panel);
        for (var i = before; i < S.syncers.length; i++) S.syncers[i]._panel = true;
        if (S.foldObserver) Array.prototype.forEach.call(panel.children, function (ch) { S.foldObserver.observe(ch); });
        syncFold();
        setTimeout(syncFold, 120);
        refreshNow();
    }

    function buildCats() {
        var bar = el('div', 'st-cats');
        bar.setAttribute('role', 'tablist');
        bar.setAttribute('aria-label', 'Look categories');
        CATS.forEach(function (c) {
            if (c.phoneOnly && !S.phone) return;
            if (c.id === 'advanced' && !S.phone) return; // desktop: footer link
            var t = el('button', 'st-cat');
            t.type = 'button';
            t.id = 'st-cat-' + c.id;
            t.dataset.cat = c.id;
            t.setAttribute('role', 'tab');
            t.setAttribute('aria-controls', 'st-panel');
            t.appendChild(icon(c.icon));
            t.appendChild(el('span', 'st-cat-label', c.label));
            t.addEventListener('click', function () { showCat(c.id); });
            bar.appendChild(t);
        });
        bar.addEventListener('keydown', function (e) {
            var tabs = Array.prototype.slice.call(bar.querySelectorAll('.st-cat'));
            var i = tabs.indexOf(document.activeElement);
            if (i < 0) return;
            var next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length :
                e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
            if (next < 0) return;
            e.preventDefault();
            tabs[next].focus();
            tabs[next].click();
        });
        return bar;
    }

    function buildFooter() {
        var bar = el('div', 'st-footer');
        if (!S.phone) {
            var adv = button('vo-btn--ghost st-adv-link', 'Advanced', 'gear', 'Runtime link, ids and delete');
            adv.setAttribute('aria-pressed', 'false');
            adv.addEventListener('click', function () { showCat(S.cat === 'advanced' ? 'looks' : 'advanced'); });
            bar.appendChild(adv);
        }
        var note = el('span', 'st-unsaved', 'Unsaved changes');
        note.setAttribute('role', 'status');
        note.hidden = !window._acpUnsaved;
        bar.appendChild(note);
        var discard = button('vo-btn--ghost', 'Discard', null);
        discard.id = 'acp-discard-btn';
        bar.appendChild(discard);
        var save = button('vo-btn--primary', 'Save', 'save');
        save.id = 'acp-save-btn';
        save.addEventListener('click', function () { call('_acpSave'); });
        bar.appendChild(save);
        return bar;
    }

    function build(col, agent, state) {
        ensureIcons();
        S.col = col;
        S.agent = agent;
        S.es = state;
        S.syncers = [];
        S.phone = isPhone();
        var old = document.querySelector('.st-emoji-pop, .st-locks-pop');
        if (old) old.remove();
        col.innerHTML = '';
        col.className = 'studio-v10' + (S.phone ? ' is-phone' : '');
        var stageCol = buildStage();
        if (!S.phone) stageCol.insertBefore(identityBlock(), stageCol.firstChild);
        col.appendChild(stageCol);
        var side = el('div', 'st-side');
        side.appendChild(buildCats());
        var panel = el('div', 'st-panel');
        panel.id = 'st-panel';
        panel.setAttribute('role', 'tabpanel');
        panel.tabIndex = -1;
        side.appendChild(panel);
        col.appendChild(side);
        // R-09: fade at the fold while more of the list is below.
        panel.addEventListener('scroll', syncFold, { passive: true });
        if (window.ResizeObserver) {
            if (S.foldObserver) S.foldObserver.disconnect();
            S.foldObserver = new ResizeObserver(syncFold);
            S.foldObserver.observe(panel);
        }
        col.appendChild(buildFooter());
        updateCaption();
        syncLockBadge();
        showCat(S.cat || 'looks');
        startLoop();
    }

    function syncFold() {
        var panel = S.col && S.col.querySelector('.st-panel');
        if (!panel || !panel.parentNode) return;
        panel.parentNode.classList.toggle('vo-has-more', panel.scrollHeight - panel.scrollTop - panel.clientHeight > 8);
    }

    function rebuild() {
        var col = document.getElementById('acp-editor');
        if (!col || !S.agent || !col.classList.contains('studio-v10')) return;
        var panel = col.querySelector('.st-panel');
        var top = panel ? panel.scrollTop : 0;
        build(col, S.agent, g('_agentPanelEditState'));
        var p2 = col.querySelector('.st-panel');
        if (p2) p2.scrollTop = top;
    }
    if (window.matchMedia) {
        var mq = window.matchMedia('(max-width: 900px)');
        var onMq = function () { if (S.phone !== mq.matches) rebuild(); };
        if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
    }

    // ------------------------------------------------------------------
    // Agent list sprites
    // ------------------------------------------------------------------
    function decorateList() {
        var list = document.getElementById('acp-agent-list');
        var panel = document.getElementById('agent-creator-panel');
        // Roster refreshes also rebuild the hidden list; draw sprites only when shown
        // (opening the studio refreshes the list again).
        if (!list || !panel || !panel.classList.contains('visible')) return;
        // The list refreshes whenever the studio opens: wake the stage loop too.
        if (S.playing && S.stageCanvas && S.stageCanvas.isConnected) startLoop();
        Array.prototype.forEach.call(list.querySelectorAll('.agent-card'), function (card) {
            var agent = (g('agents') || []).find(function (a) { return a.id === card.dataset.agentId; });
            if (!agent) return;
            var cv = card.querySelector('.st-card-sprite');
            if (!cv) {
                cv = el('canvas', 'st-card-sprite');
                cv.setAttribute('aria-hidden', 'true');
                card.insertBefore(cv, card.firstChild);
                card.classList.add('has-sprite');
            }
            renderAgentPreview(cv, agent.getAppearance ? agent.getAppearance() : agent.appearance,
                { view: 'card', color: agent.color, gender: agent.gender, floor: false, width: 36, height: 36 });
        });
    }

    // ------------------------------------------------------------------
    // New agent flow: look + desk steps (CE-10)
    // ------------------------------------------------------------------
    // state: {id, gender, color, appearance, deskId}; returns {sync()}.
    function mountLookStep(host, state) {
        host.innerHTML = '';
        var wrap = el('div', 'st-newlook');
        var stage = el('canvas', 'st-newlook-stage');
        stage.setAttribute('role', 'img');
        stage.setAttribute('aria-label', 'Preview of the new agent');
        var left = el('div', 'st-newlook-left');
        left.appendChild(stage);
        var bodySeg = genderSeg(function () { return genderOf(state); }, function (g) { switchGender(state, g); draw(); });
        left.appendChild(bodySeg);
        var dice = button('st-dice', 'Randomize', 'st-dice');
        dice.addEventListener('click', function () { randomLook(state, Math.random, {}); seed = Math.floor(Math.random() * 1e9); draw(); });
        left.appendChild(dice);
        wrap.appendChild(left);
        var right = el('div', 'st-newlook-right');
        right.appendChild(el('h3', 'st-field-title', 'Ideas'));
        var ideas = el('div', 'st-tiles st-tiles--body st-tiles--compact');
        var seed = Math.floor(Math.random() * 1e9);
        var ideaTiles = [];
        // Five ideas and ten sets fill whole rows of the five-column grid.
        for (var i = 0; i < 5; i++) {
            var t = el('button', 'st-tile');
            t.type = 'button';
            t.appendChild(el('canvas', 'st-tile-canvas'));
            t.appendChild(el('span', 'st-tile-label', 'Idea ' + (i + 1)));
            (function (tile) {
                tile.addEventListener('click', function () {
                    var st = tile._state;
                    state.gender = st.gender; state.color = st.color; state.appearance = clone(st.appearance);
                    draw(true);
                });
            })(t);
            ideas.appendChild(t);
            ideaTiles.push(t);
        }
        right.appendChild(ideas);
        right.appendChild(el('h3', 'st-field-title', 'Outfit sets'));
        var sets = el('div', 'st-tiles st-tiles--body st-tiles--compact');
        var setTiles = PRESETS.filter(function (pr) { return !pr.look.costume; }).map(function (pr) { // every set but the costume ones
            var t = el('button', 'st-tile');
            t.type = 'button';
            t.appendChild(el('canvas', 'st-tile-canvas'));
            t.appendChild(el('span', 'st-tile-label', pr.label));
            t.addEventListener('click', function () {
                if (pr.color) state.color = pr.color;
                Object.keys(pr.look).forEach(function (k) { state.appearance[k] = pr.look[k]; });
                draw(true);
            });
            sets.appendChild(t);
            return { t: t, pr: pr };
        });
        right.appendChild(sets);
        wrap.appendChild(right);
        host.appendChild(wrap);
        function draw(keepIdeas) {
            renderAgentPreview(stage, state.appearance, { pose: 'stand', color: state.color, gender: state.gender, view: 'stand' });
            bodySeg._sync();
            if (!keepIdeas) {
                var r = rng(seed);
                ideaTiles.forEach(function (t) {
                    var st = randomLook({ gender: state.gender, color: state.color, appearance: clone(state.appearance) }, r, {});
                    t._state = st;
                    renderAgentPreview(t.firstChild, st.appearance, { view: 'body', color: st.color, gender: st.gender, floor: false });
                });
            }
            setTiles.forEach(function (x) {
                var a = clone(state.appearance);
                Object.keys(x.pr.look).forEach(function (k) { a[k] = x.pr.look[k]; });
                renderAgentPreview(x.t.firstChild, a, { view: 'body', color: x.pr.color || state.color, gender: state.gender, floor: false });
            });
        }
        requestAnimationFrame(function () { draw(); });
        return { sync: draw };
    }

    function mountDeskStep(host, state) {
        host.innerHTML = '';
        var list = el('div', 'st-desk-list');
        list.setAttribute('role', 'radiogroup');
        list.setAttribute('aria-label', 'Desk for the new agent');
        var opts = [{ id: null, label: 'Automatic desk', note: 'Takes a free desk. Pick one later in Agent Studio.' }];
        // Only desks nobody owns or sits at (a desk an agent got automatically is that agent's too), desks first
        var all = deskList();
        freeDesks(all).forEach(function (d) { opts.push({ id: d.id, label: d.label, note: d.boss ? 'Free boss desk' : 'Free' }); });
        var taken = all.length - (opts.length - 1);
        var btns = opts.map(function (o) {
            var b = el('button', 'st-desk-opt');
            b.type = 'button';
            b.setAttribute('role', 'radio');
            b.appendChild(el('span', 'st-desk-opt-name', o.label));
            b.appendChild(el('span', 'st-desk-opt-note', o.note));
            b.addEventListener('click', function () { state.deskId = o.id; sync(); });
            list.appendChild(b);
            return { o: o, b: b };
        });
        rovingKeys(list, '.st-desk-opt');
        host.appendChild(list);
        host.appendChild(el('p', 'st-field-hint', opts.length > 1
            ? (opts.length - 1) + ' free desk' + (opts.length === 2 ? '' : 's') + (taken ? ', ' + taken + ' taken.' : '.')
            : 'Every desk is taken. Add one in the office editor, or pick a desk later.'));
        function sync() {
            var sel = -1;
            btns.forEach(function (x, i) {
                var on = x.o.id === (state.deskId || null);
                if (on) sel = i;
                x.b.setAttribute('aria-checked', on ? 'true' : 'false');
                x.b.classList.toggle('is-selected', on);
            });
            setRoving(btns.map(function (x) { return x.b; }), sel);
        }
        if (state.deskId === undefined) state.deskId = opts[1] ? opts[1].id : null;
        sync();
        return { sync: sync };
    }

    // A fresh random look for an agent that does not exist yet.
    function newAgentLook() {
        var g = Math.random() < 0.5 ? 'M' : 'F';
        var st = { gender: g, color: SHIRTS[0], appearance: defaultLook('new-agent', g) || {} };
        return randomLook(st, Math.random, {});
    }

    // ------------------------------------------------------------------
    // Agent details window: identity summary (CE-21)
    // ------------------------------------------------------------------
    function drawSprites(root) {
        Array.prototype.forEach.call((root || document).querySelectorAll('canvas[data-studio-sprite]'), function (cv) {
            var key = cv.dataset.studioSprite;
            var agent = (g('agents') || []).find(function (a) { return a.id === key; }) ||
                (g('agents') || []).find(function (a) { return a.statusKey === key; });
            if (!agent) return;
            // Optional per canvas: data-studio-view (a VIEWS name), data-studio-size (CSS px), data-studio-floor="0".
            var size = Number(cv.dataset.studioSize) || 72;
            renderAgentPreview(cv, agent.getAppearance ? agent.getAppearance() : agent.appearance,
                { view: VIEWS[cv.dataset.studioView] ? cv.dataset.studioView : 'body', color: agent.color, gender: agent.gender,
                  floor: cv.dataset.studioFloor !== '0', width: size, height: size });
        });
    }
    function openFor(agentId) {
        var panel = document.getElementById('agent-creator-panel');
        if (!panel || !panel.classList.contains('visible')) call('toggleAgentPanel');
        panel = document.getElementById('agent-creator-panel');
        if (!panel || !panel.classList.contains('visible')) return false;
        var match = (g('agents') || []).find(function (a) { return a.id === agentId; }) ||
            (g('agents') || []).find(function (a) { return a.statusKey === agentId; });
        if (match) agentId = match.id;
        if (g('_agentPanelSelectedId') === agentId) return true;
        var card = panel.querySelector('.agent-card[data-agent-id="' + String(agentId).replace(/"/g, '') + '"]');
        if (card) card.click(); else call('_acpSelectAgent', agentId);
        return true;
    }
    document.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-studio-open]');
        if (!b) return;
        e.preventDefault();
        openFor(b.getAttribute('data-studio-open'));
    });
    function wrapWorkspaceRender() {
        if (typeof window._renderAgentWorkspace !== 'function' || window._renderAgentWorkspace._studioWrapped) return;
        var orig = window._renderAgentWorkspace;
        var wrapped = function () {
            var r = orig.apply(this, arguments);
            try { drawSprites(document); } catch (e) { /* a missing sprite is fine */ }
            return r;
        };
        wrapped._studioWrapped = true;
        window._renderAgentWorkspace = wrapped;
    }
    wrapWorkspaceRender();

    window.VOStudio = {
        build: build,
        rebuild: rebuild,
        refresh: refresh,
        refreshNow: refreshNow,
        syncHistory: syncHistory,
        syncSaving: syncSaving,
        decorateList: decorateList,
        showCategory: function (id) { if (S.col) showCat(id); },
        setPose: setPose,
        randomize: randomize,
        resetLook: resetLook,
        copyLookFrom: copyLookFrom,
        applyPreset: function (id) { var p = PRESETS.find(function (x) { return x.id === id; }); if (p) applyPreset(p); },
        showDeskOnMap: showDeskOnMap,
        showAgentOnMap: showAgentOnMap,
        deskList: deskList,
        freeDesks: freeDesks,
        mountLookStep: mountLookStep,
        mountDeskStep: mountDeskStep,
        newAgentLook: newAgentLook,
        drawSprites: drawSprites,
        openFor: openFor,
        effLashes: effLashes,
        effLip: effLip,
        lashId: lashId,
        switchGender: switchGender,
        catalog: { looks: { hairStyle: HAIR_STYLES, eyebrowStyle: BROWS, lashes: LASHES, facialHair: FACIAL, shirtStyle: TOPS, neckwear: NECKWEAR,
            costume: COSTUMES, headwear: HEADWEAR, glasses: GLASSES }, skin: SKIN, skinFun: SKIN_FUN, hair: HAIR, hairStyles: HAIR_STYLES, shirts: SHIRTS, pants: PANTS, presets: PRESETS, emojis: EMOJIS, headwear: HEADWEAR, deskItems: DESK_ITEMS, held: HELD },
        label: label,
        state: S
    };
})();
