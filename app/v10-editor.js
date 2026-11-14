// Office editor UI (v0.10): the DOM around the canvas editor in game.js.
//
// - Catalog thumbnails drawn by the game's own drawFurnitureItem (OE-12) and
//   search keywords + an empty state (OE-13).
// - The status bar: what is being placed, its size, why it can not go there,
//   Turn / Stop. On phones it is the "peek bar" while the sheet folds away (OE-04,
//   OE-07, OE-09).
// - Edit bar extras: Select area (OE-27), Snap whole / half / free (OE-11), the
//   shortcut card (OE-17).
// - Paint tab: floor presets, areas, whole floor, eraser; wall presets and a
//   paint bucket (OE-10, contract C2).
// - View insets (contract C1): tells the camera which part of the screen the
//   panel, sheet and bars cover.
// game.js owns the editing rules; this file only calls its globals.
(function () {
    'use strict';

    var VOEditor = window.VOEditor = window.VOEditor || {};
    var TILE_PX = 40;

    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }
    function icon(name) {
        if (typeof window._edIcon === 'function') return window._edIcon(name);
        return el('span');
    }
    function isPhone() { return window.innerWidth <= 900; }
    function editing() { return typeof window.editMode !== 'undefined' && !!window.editMode; }
    function label(type) { return typeof window._furnitureLabel === 'function' ? window._furnitureLabel(type) : type; }

    // ------------------------------------------------------------------
    // Search keywords (OE-13): what people type for each item.
    // ------------------------------------------------------------------
    var KEYWORDS = {
        desk: 'table workstation computer pc work', bossDesk: 'executive manager ceo director big desk',
        trashCan: 'bin garbage waste rubbish basket', filingCabinet: 'drawers files storage cabinet',
        whiteboard: 'board marker chalkboard', receptionDesk: 'front desk reception lobby welcome counter',
        noticeBoard: 'cork board bulletin pinboard notices wall', couch: 'sofa settee lounge seat l-shaped',
        engLounge: 'sofa bench couch seat straight', coffeeTable: 'low table lounge', tv: 'television screen monitor',
        bookshelf: 'books shelf library bookcase', plant: 'pot flower green small', tallPlant: 'tree palm green big',
        endTable: 'side table nightstand plant', kitchenCounter: 'kitchen cabinet worktop counter',
        coffeeMaker: 'espresso machine coffee kettle', vendingMachine: 'snacks drinks soda machine',
        waterCooler: 'water dispenser drink', microwave: 'oven kitchen', toaster: 'bread kitchen',
        pingPongTable: 'table tennis game fun', dartBoard: 'darts game fun', meetingTable: 'conference boardroom table meeting',
        window: 'glass view wall', interactiveWindow: 'weather sun sky window wall', clock: 'time wall clock',
        floorLamp: 'light lamp', textLabel: 'text sign label name words', wall: 'partition divider room wall',
        petBed: 'pet bed basket cushion dog cat animal sleep', petBowl: 'pet bowl dish food water dog cat animal',
        door: 'opening doorway entrance gap door'
    };
    VOEditor.keywords = function (type) { return KEYWORDS[type] || ''; };
    VOEditor.matches = function (type, query) {
        query = String(query || '').trim().toLowerCase();
        if (!query) return true;
        var hay = (label(type) + ' ' + type + ' ' + (KEYWORDS[type] || '')).toLowerCase();
        return query.split(/\s+/).every(function (word) { return hay.indexOf(word) >= 0; });
    };

    // ------------------------------------------------------------------
    // Thumbnails (OE-12): the item drawn by the game into a small canvas.
    // v0.13 (editorperf): a preview is drawn once per (type or variant key,
    // colour/turn props, size, dpr) into a canvas kept in a Map and copied into
    // each tile's own canvas (no PNG encode, no <img> decode). A tile asks for
    // its preview only when it comes into view (IntersectionObserver: a closed
    // variants list draws nothing until it opens) and the queue draws a few per
    // idle slice (at most 6, about 4 ms), with a timer fallback for a browser
    // that never goes idle. The tile keeps its size, so nothing reflows.
    // ------------------------------------------------------------------
    var thumbCache = new Map();
    var WALL_STYLE = { color: '#5d6271', accentColor: '#5d6271', trimColor: '#d2d4da', trim2Color: '#989ca8' };

    function thumbDpr() { return Math.min(2, window.devicePixelRatio || 1); }
    function thumbKey(type, cssSize, props) { return type + '@' + cssSize + '@' + thumbDpr() + (props ? '@' + JSON.stringify(props) : ''); }
    // The drawn preview of a type (a variant key 'desk~analyst' draws that variant; props such as
    // a colour or a turn are copied onto the item), cached.
    function thumbCanvas(type, cssSize, props) {
        var dpr = thumbDpr();
        var key = thumbKey(type, cssSize, props);
        var hit = thumbCache.get(key);
        if (hit) return hit;
        var c = document.createElement('canvas');
        c.width = c.height = Math.round(cssSize * dpr);
        var tctx = c.getContext('2d');
        tctx.imageSmoothingEnabled = false;
        var saved = window.ctx;
        try {
            window.ctx = tctx;
            if (type === 'wall' || type === 'door') {
                var s = c.width / (TILE_PX * 2.4);
                tctx.setTransform(s, 0, 0, s, c.width * 0.08, c.height * 0.5 - TILE_PX * s);
                if (type === 'wall') {
                    window._drawSingleWall(Object.assign({ x1: 0, y1: 1, x2: 2, y2: 1 }, WALL_STYLE), -1);
                } else {
                    window._drawSingleWall(Object.assign({ x1: 0, y1: 1, x2: 0.7, y2: 1 }, WALL_STYLE), -1);
                    window._drawSingleWall(Object.assign({ x1: 1.5, y1: 1, x2: 2.2, y2: 1 }, WALL_STYLE), -1);
                    tctx.fillStyle = 'rgba(0, 200, 120, .55)';
                    tctx.fillRect(0.75 * TILE_PX, TILE_PX - 7, 0.7 * TILE_PX, 14);
                }
            } else {
                // v0.13: a variant key ('desk~analyst') draws that variant
                var item = typeof window._itemFromKey === 'function' ? window._itemFromKey(type, { id: '__thumb', x: 0, y: 0 }) : { id: '__thumb', type: type, x: 0, y: 0 };
                if (props) Object.assign(item, props);
                if (type === 'textLabel') { item.text = 'Aa'; item.labelColor = '#ffffff'; item.fontSize = 14; }
                var r = window._getItemWorldRect(item);
                var pad = 3 * dpr;
                var scale = Math.min((c.width - pad * 2) / r.w, (c.height - pad * 2) / r.h);
                if (scale >= 1) scale = Math.floor(scale); // whole pixels when it fits
                tctx.setTransform(scale, 0, 0, scale, Math.round((c.width - r.w * scale) / 2 - r.x * scale), Math.round((c.height - r.h * scale) / 2 - r.y * scale));
                if (type === 'textLabel') {
                    tctx.fillStyle = 'rgba(30, 34, 44, .9)';
                    tctx.fillRect(r.x, r.y, r.w, r.h);
                }
                window.drawFurnitureItem(item, { staticOnly: true });
            }
        } catch (e) {
            // An item that can not be drawn off-screen keeps its text label only.
        } finally {
            window.ctx = saved;
            tctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        thumbCache.set(key, c);
        return c;
    }
    VOEditor.thumbCanvas = thumbCanvas;
    // A data URL of a preview (kept for callers that want an image; the menus use canvases).
    VOEditor.thumb = function (type, cssSize, props) { return thumbCanvas(type, cssSize, props).toDataURL('image/png'); };
    VOEditor.thumbCacheSize = function () { return thumbCache.size; };

    // A tile's canvas: the cached preview copied in (device pixels, shown at the CSS size).
    function tileCanvas(cssSize) {
        var c = el('canvas', 'catalog-thumb');
        var px = Math.round(cssSize * thumbDpr());
        c.width = c.height = px;
        c.style.width = c.style.height = cssSize + 'px';
        c.setAttribute('aria-hidden', 'true');
        return c;
    }
    function paintTile(c, type, cssSize, props) {
        var src = thumbCanvas(type, cssSize, props);
        if (c.width !== src.width || c.height !== src.height) { c.width = src.width; c.height = src.height; }
        var g = c.getContext('2d');
        if (g) { g.clearRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0); }
        delete c.dataset.pending;
    }

    // The queue: jobs of tiles in (or near) view, drawn a few per slice.
    var queue = [], slicePending = false, SLICE_MAX = 6, SLICE_MS = 4;
    function schedule() {
        if (slicePending || !queue.length) return;
        slicePending = true;
        var done = false, timer = 0;
        var run = function (deadline) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            slicePending = false;
            slice(deadline);
        };
        // requestIdleCallback when the page has idle time; a timer when it has not fired in 200 ms
        if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 200 });
        timer = setTimeout(function () { run(null); }, typeof window.requestIdleCallback === 'function' ? 220 : 16);
    }
    function slice(deadline) {
        var t0 = performance.now();
        var idle = deadline && !deadline.didTimeout ? Math.max(0, deadline.timeRemaining() - 1) : 0;
        var budget = Math.max(SLICE_MS, Math.min(idle, 12));
        var n = 0;
        while (queue.length && n < SLICE_MAX && (n === 0 || performance.now() - t0 < budget)) {
            var job = queue.shift();
            job.queued = false;
            if (!job.visible || !job.canvas.isConnected) continue;   // out of view again: asked for when it comes back
            job.run();
            n++;
        }
        if (queue.length) schedule();
    }
    function enqueue(job) {
        if (job.queued || job.drawn) return;
        job.queued = true;
        queue.push(job);
        schedule();
    }
    // One observer for every tile (the catalog panel, the variants lists, the Variants dropdown).
    var observer = null;
    var jobs = typeof WeakMap === 'function' ? new WeakMap() : null;
    function watch(target, job) {
        if (!observer && typeof window.IntersectionObserver === 'function' && jobs) {
            observer = new IntersectionObserver(function (entries) {
                entries.forEach(function (e) {
                    var j = jobs.get(e.target);
                    if (!j) return;
                    j.visible = e.isIntersecting;
                    if (j.visible) enqueue(j);
                });
            }, { rootMargin: '160px 0px' });
        }
        if (!observer) { job.visible = true; enqueue(job); return; }   // no observer: draw them all, a few per slice
        jobs.set(target, job);
        observer.observe(target);
        // tiles of a closed menu that were never shown: stop watching them after a while
        job.at = Date.now();
        watched.push(target);
        if (watched.length > 120) {
            var now = Date.now();
            watched = watched.filter(function (t) {
                var j = jobs.get(t);
                if (!j || j.drawn) return false;
                if (!t.isConnected && now - j.at > 5000) { unwatch(t); return false; }
                return true;
            });
        }
    }
    var watched = [];
    function unwatch(target) { if (observer) { observer.unobserve(target); jobs.delete(target); } }

    // A preview tile: drawn at once when cached, else when it comes into view.
    function thumbImg(type, size, props) {
        var c = tileCanvas(size);
        if (thumbCache.has(thumbKey(type, size, props))) { paintTile(c, type, size, props); return c; }
        c.dataset.pending = '1';
        var job = { canvas: c, visible: false, queued: false, drawn: false };
        job.run = function () { job.drawn = true; unwatch(c); paintTile(c, type, size, props); };
        watch(c, job);
        return c;
    }
    VOEditor.thumbImg = thumbImg;

    // Swap the emoji icons for previews as they come into view; the emoji stays
    // until its preview is drawn.
    function fillThumbnails(root) {
        var holders = root.querySelectorAll('.catalog-item .catalog-icon:not([data-thumb]), .catalog-quick-item .catalog-icon:not([data-thumb])');
        Array.prototype.forEach.call(holders, function (holder) {
            var item = holder.closest('[data-type]');
            var type = item && item.dataset.type;
            if (!type) return;
            holder.dataset.thumb = 'pending';
            var job = { canvas: holder, visible: false, queued: false, drawn: false };
            job.run = function () {
                job.drawn = true;
                unwatch(holder);
                var c = tileCanvas(44);
                paintTile(c, type, 44);
                holder.dataset.thumb = '1';
                holder.textContent = '';
                holder.appendChild(c);
            };
            watch(holder, job);
        });
    }
    VOEditor.fillThumbnails = fillThumbnails;

    // ------------------------------------------------------------------
    // Status bar / phone peek bar (OE-04, OE-07, OE-09)
    // ------------------------------------------------------------------
    var bar = null, barKey = '', flash = null;

    function ensureBar() {
        if (bar) return bar;
        bar = el('div', 'vo-editor-status');
        bar.id = 'vo-editor-status';
        bar.setAttribute('role', 'status');
        bar.setAttribute('aria-live', 'polite');
        bar.hidden = true;
        bar.innerHTML = '<span class="vo-es-thumb" aria-hidden="true"></span>' +
            '<span class="vo-es-text"><b class="vo-es-title"></b><span class="vo-es-why"></span></span>' +
            '<span class="vo-es-actions"></span>';
        document.body.appendChild(bar);
        return bar;
    }

    function actionButton(text, iconName, onClick, cls) {
        var b = el('button', 'vo-btn vo-btn--sm' + (cls ? ' ' + cls : ''));
        b.type = 'button';
        if (iconName) b.appendChild(icon(iconName));
        b.appendChild(document.createTextNode(text));
        b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
        return b;
    }

    function sizeInTiles(type) {
        if (typeof window._getItemWorldRect !== 'function') return '';
        var r = window._getItemWorldRect({ type: type, x: 0, y: 0, rotation: window._placingRotation || 0 });
        return Math.max(1, Math.round(r.w / TILE_PX)) + ' × ' + Math.max(1, Math.round(r.h / TILE_PX)) + ' tiles';
    }

    // What the bar says right now: { key, type, title, why, bad, actions }.
    function statusModel() {
        if (!editing()) return null;
        var touch = typeof window._isTouchEditor === 'function' && window._isTouchEditor();
        var click = touch ? 'Tap' : 'Click';
        var now = Date.now();
        var f = flash && flash.until > now ? flash.text : '';
        var placing = window.placingType;
        var OL = window.OfficeLayouts;
        if (OL && OL.isPlacing && OL.isPlacing()) {
            var st = OL.getPlacementState ? OL.getPlacementState() : null;
            var lname = OL.placingName ? OL.placingName() : 'layout';
            var lbad = !!f || !!(st && !st.valid);
            // I4: when it does not fit here, say where it does (dashed outlines) or offer more room.
            var fits = st && !st.valid ? (st.fits || 0) : 0;
            var lwhy = f || (st ? (st.valid ? click + ' to place it here.' : st.reason + (fits ? ' It fits where the dashed outlines are.' : ' No clear spot is big enough: expand the office to fit it.')) : click + ' the floor where it goes.');
            return { key: 'layout|' + lname + '|' + (st ? st.code : '') + '|' + (fits > 0) + '|' + f, title: 'Placing “' + lname + '”', why: lwhy, bad: lbad,
                actions: st && !st.valid ? (fits ? ['fit', 'expand', 'stop'] : ['expand', 'stop']) : ['stop'] };
        }
        if (window._floorPaint && window._floorPaint.active) {
            var fp = window._floorPaint;
            var preset = fp.preset || {};
            var name = preset.erase ? 'Eraser' : (preset.label || 'Floor');
            return { key: 'floor|' + name + '|' + !!fp.start + '|' + f, title: 'Paint floor: ' + name,
                why: f || (fp.start ? click + ' the opposite corner.' : (touch ? 'Drag over the floor, or tap two corners.' : 'Drag over the floor, or click two corners.')),
                bad: !!f, actions: ['done'] };
        }
        if (window._wallPaint && window._wallPaint.active) {
            return { key: 'wallpaint|' + f, title: 'Paint walls', why: f || click + ' any wall, or the top wall.', bad: !!f, actions: ['done'] };
        }
        if (window._marqueeMode) {
            return { key: 'marquee|' + f, title: 'Select area', why: f || 'Drag a box over the items to select.', bad: !!f, actions: ['stop'] };
        }
        if (placing === 'wall') {
            var phase = window.wallPlacingPhase;
            return { key: 'wall|' + phase + '|' + f, type: 'wall', title: 'Wall',
                why: f || (phase ? click + ' where the wall ends. Keep going for the next one.' : click + ' the grid corner where the wall starts.'),
                bad: !!f, actions: ['stop'] };
        }
        if (placing === 'door') {
            return { key: 'door|' + f, type: 'door', title: 'Door', why: f || click + ' on a wall to open it there.', bad: !!f, actions: ['stop'] };
        }
        if (placing) {
            var why = f || window._placementReason || '';
            var rot = window._placingRotation || 0;
            var rotatable = typeof window._isRotatableType === 'function' && window._isRotatableType(placing);
            return { key: 'place|' + placing + '|' + rot + '|' + why, type: placing, title: label(placing) + ' · ' + sizeInTiles(placing),
                why: why || (touch ? 'Tap the floor to place it.' : 'Click to place. Alt = free, R turns it.'),
                bad: !!why, actions: rotatable ? ['turn', 'stop'] : ['stop'] };
        }
        if (f && flash.undo) return { key: 'flash|undo|' + flash.id, title: f, why: '', bad: false, actions: ['undo'] };
        if (f) return { key: 'flash|' + f, title: '', why: f, bad: true, actions: [] };
        return null;
    }

    function renderBar() {
        var m = statusModel();
        var key = m ? m.key : '';
        if (key === barKey) return;
        barKey = key;
        ensureBar();
        document.body.classList.toggle('vo-editor-peek', !!m && m.key.indexOf('flash|') !== 0);
        if (!m) { bar.hidden = true; updateInsets(); return; }
        bar.hidden = false;
        bar.classList.toggle('is-bad', !!m.bad);
        var thumb = bar.querySelector('.vo-es-thumb');
        thumb.textContent = '';
        if (m.type) { var tc = tileCanvas(32); paintTile(tc, m.type, 32); thumb.appendChild(tc); }
        thumb.hidden = !m.type;
        bar.querySelector('.vo-es-title').textContent = m.title;
        bar.querySelector('.vo-es-why').textContent = m.why;
        var actions = bar.querySelector('.vo-es-actions');
        actions.textContent = '';
        m.actions.forEach(function (a) {
            if (a === 'turn') actions.appendChild(actionButton('Turn', 'ed-rotate', function () { window.rotatePlacingGhost(); }));
            if (a === 'undo') actions.appendChild(actionButton('Undo', 'undo', function () { flash = null; window.undoEdit(); renderBar(); }));
            // Sticking out of the office: growing it is the main answer; blocked inside: the free spot.
            var growFirst = m.key.indexOf('|outside|') > 0 || m.actions.indexOf('fit') < 0;
            if (a === 'fit') actions.appendChild(actionButton('Place at a free spot', 'target', function () { window.OfficeLayouts.placeAtFreeSpot(); renderBar(); }, growFirst ? '' : 'ui-primary-action'));
            if (a === 'expand') actions.appendChild(actionButton('Expand office to fit', 'ed-expand', function () { window.OfficeLayouts.expandToFit(); renderBar(); }, growFirst ? 'ui-primary-action' : ''));
            if (a === 'stop') actions.appendChild(actionButton(m.key.indexOf('place|') === 0 ? 'Done placing' : 'Stop', 'close', stopTool));
            if (a === 'done') actions.appendChild(actionButton('Done', 'check', stopTool, 'ui-primary-action'));
        });
        updateInsets();
    }

    function stopTool() {
        if (window.OfficeLayouts && window.OfficeLayouts.isPlacing && window.OfficeLayouts.isPlacing()) window.OfficeLayouts.cancelPlacement();
        if (window._floorPaint && window._floorPaint.active) window.setFloorPaintMode(false);
        if (window._wallPaint && window._wallPaint.active) window.setWallPaintMode(false);
        if (window._marqueeMode) window.setMarqueeMode(false);
        if (window.placingType) window._cancelPlacement();
        syncPaintButtons();
        renderBar();
    }
    VOEditor.stopTool = stopTool;

    window.addEventListener('vo:editor-flash', function (e) {
        var undo = !!(e.detail && e.detail.undo);
        var ms = undo ? 5000 : 1800;
        flash = { text: (e.detail && e.detail.text) || '', undo: undo, until: Date.now() + ms, id: Date.now() };
        renderBar();
        setTimeout(renderBar, ms + 50);
    });
    window.addEventListener('vo:editor-state', function () { renderBar(); syncPaintButtons(); syncEditBar(); });

    // Called by game.js once per frame while editing (cheap: re-renders only on change).
    VOEditor.onFrame = function () { renderBar(); };

    // ------------------------------------------------------------------
    // Edit bar extras: Select area, Snap, shortcuts (OE-11, OE-17, OE-27)
    // ------------------------------------------------------------------
    var SNAP_ORDER = ['tile', 'half', 'free'];
    var SNAP_SHORT = { tile: 'Tile', half: 'Half', free: 'Free' };
    var SNAP_LABEL = { tile: 'whole tile', half: 'half tile', free: 'free' };

    function mountEditBar() {
        var tb = document.querySelector('.ui-edit-toolbar');
        if (!tb || tb.querySelector('.vo-ed-extra')) return;
        var fit = tb.querySelector('[data-vo-map="fit"]');
        var wrap = el('span', 'vo-ed-extra');
        var sel = el('button', 'vo-btn vo-ed-select');
        sel.type = 'button';
        sel.id = 'btn-select-area';
        sel.title = 'Select area: drag a box over items (or double-click empty floor)';
        sel.setAttribute('aria-pressed', 'false');
        sel.appendChild(icon('ed-select'));
        sel.appendChild(el('span', 'vo-btn-label', 'Select area'));
        sel.addEventListener('click', function () { window.setMarqueeMode(!window._marqueeMode); });
        var snap = el('div', 'vo-ed-snap');
        snap.setAttribute('role', 'radiogroup');
        snap.setAttribute('aria-label', 'Snap to grid');
        snap.appendChild(icon('ed-magnet'));
        SNAP_ORDER.forEach(function (mode) {
            var b = el('button', 'vo-ed-snap-opt', SNAP_SHORT[mode]);
            b.type = 'button';
            b.dataset.snap = mode;
            b.setAttribute('role', 'radio');
            b.title = 'Snap: ' + SNAP_LABEL[mode] + (mode === 'free' ? ' (or hold Alt)' : '');
            b.addEventListener('click', function () {
                // On a phone the whole control is one button that cycles.
                var next = isPhone() ? SNAP_ORDER[(SNAP_ORDER.indexOf(window.editSnapMode) + 1) % 3] : mode;
                window.setEditSnapMode(next);
                syncEditBar();
            });
            snap.appendChild(b);
        });
        var help = el('button', 'vo-btn vo-btn--icon vo-ed-help');
        help.type = 'button';
        help.title = 'Keyboard shortcuts (?)';
        help.setAttribute('aria-label', 'Keyboard shortcuts');
        help.appendChild(icon('help'));
        help.addEventListener('click', function () { VOEditor.toggleShortcuts(); });
        wrap.appendChild(sel);
        wrap.appendChild(snap);
        wrap.appendChild(help);
        tb.insertBefore(wrap, fit || null);
        syncEditBar();
    }

    function syncEditBar() {
        var sel = document.getElementById('btn-select-area');
        if (sel) {
            sel.classList.toggle('is-active', !!window._marqueeMode);
            sel.setAttribute('aria-pressed', window._marqueeMode ? 'true' : 'false');
        }
        document.querySelectorAll('.vo-ed-snap-opt').forEach(function (b) {
            var on = b.dataset.snap === window.editSnapMode;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }
    window.addEventListener('vo:editor-snap', syncEditBar);

    // ------------------------------------------------------------------
    // Shortcut card (OE-17)
    // ------------------------------------------------------------------
    var card = null;
    var SHORTCUTS = [
        ['Click an item, then the floor', 'Place it (Alt = free, R = turn)'],
        ['Drag an item', 'Move it'],
        ['Arrow keys', 'Nudge (Shift = a whole tile)'],
        ['R', 'Turn the selected item'],
        ['Ctrl + D', 'Duplicate'],
        ['Ctrl + C / Ctrl + V', 'Copy / paste (at the pointer)'],
        ['Ctrl + A', 'Select everything'],
        ['Ctrl + click', 'Add to the selection'],
        ['Double-click empty floor', 'Select area'],
        ['Delete', 'Delete the selection'],
        ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / redo'],
        ['Esc', 'Step back (never closes the editor)'],
        ['E', 'Open or close the editor'],
        ['?', 'This card']
    ];
    VOEditor.toggleShortcuts = function (force) {
        var show = typeof force === 'boolean' ? force : !(card && !card.hidden);
        if (!card) {
            var mod = typeof window._editModKey === 'function' ? window._editModKey() : 'Ctrl';
            card = el('div', 'vo-editor-keys vo-window');
            card.id = 'vo-editor-keys';
            card.setAttribute('role', 'dialog');
            card.setAttribute('aria-label', 'Office editor shortcuts');
            var head = el('div', 'vo-ek-head');
            head.appendChild(el('h2', 'vo-ek-title', 'Shortcuts'));
            var close = el('button', 'vo-btn vo-btn--icon vo-btn--ghost');
            close.type = 'button';
            close.setAttribute('aria-label', 'Close shortcuts');
            close.appendChild(icon('close'));
            close.addEventListener('click', function () { VOEditor.toggleShortcuts(false); });
            head.appendChild(close);
            card.appendChild(head);
            var list = el('dl', 'vo-ek-list');
            SHORTCUTS.forEach(function (row) {
                var dt = el('dt');
                row[0].replace(/Ctrl/g, mod).split(' / ').forEach(function (combo, i) {
                    if (i) dt.appendChild(document.createTextNode(' / '));
                    combo.split(' + ').forEach(function (k, j) {
                        if (j) dt.appendChild(document.createTextNode('+'));
                        dt.appendChild(el(k.length <= 6 ? 'kbd' : 'span', '', k));
                    });
                });
                list.appendChild(dt);
                list.appendChild(el('dd', '', row[1]));
            });
            card.appendChild(list);
            card.hidden = true;
            document.body.appendChild(card);
        }
        card.hidden = !show;
        return show;
    };

    // Esc closes the editor's own cards first (game.js asks before stepping back).
    VOEditor.closeOverlays = function () {
        if (card && !card.hidden) { card.hidden = true; return true; }
        return false;
    };

    // ------------------------------------------------------------------
    // Paint tab: floor + walls (OE-10, contract C2)
    // ------------------------------------------------------------------
    var FALLBACK_FLOORS = [
        { id: 'checker', label: 'Checker', color1: '#c8c3b8', color2: '#bdb7ab' },
        { id: 'wood', label: 'Wood', color1: '#a27b55', color2: '#946f4b' },
        { id: 'carpet', label: 'Carpet', color1: '#6b7682', color2: '#626c78' },
        { id: 'tile', label: 'Tile', color1: '#dcd8cf', color2: '#d0ccc2' },
        { id: 'concrete', label: 'Concrete', color1: '#9c9b96', color2: '#93928d' },
        { id: 'plain', label: 'Plain', color1: '#c9c2b3', color2: '#c9c2b3' }
    ];
    var WALL_PRESETS = [
        { label: 'Slate', color: '#5d6271', trimColor: '#d2d4da', trim2Color: '#989ca8' },
        { label: 'Warm grey', color: '#8a8378', trimColor: '#e6dcc8', trim2Color: '#b5ab9a' },
        { label: 'Sage', color: '#7d8f7a', trimColor: '#e6e1d3', trim2Color: '#a9b5a3' },
        { label: 'Clay', color: '#a46f5a', trimColor: '#ead8c4', trim2Color: '#c49a85' },
        { label: 'Cream', color: '#d9cfbb', trimColor: '#8a7a62', trim2Color: '#b8ab92' },
        { label: 'Navy', color: '#3f4a5c', trimColor: '#c9ced8', trim2Color: '#7a8496' },
        { label: 'Walnut', color: '#7a5a40', trimColor: '#d8c3a5', trim2Color: '#a6876a' },
        { label: 'Charcoal', color: '#3a3d44', trimColor: '#9aa0aa', trim2Color: '#646a74' }
    ];
    function floorPresets() {
        var art = window.VOOfficeArt && Array.isArray(window.VOOfficeArt.floorStyles) ? window.VOOfficeArt.floorStyles : null;
        return (art && art.length ? art : FALLBACK_FLOORS).filter(function (p) { return p && p.id && p.color1; });
    }

    // A small swatch of a floor style: tiles in its two colours plus a hint of
    // its texture (planks, grout, speckle).
    function floorSwatch(preset, w, h) {
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var g = c.getContext('2d');
        var t = 12;
        for (var y = 0; y < h; y += t) {
            for (var x = 0; x < w; x += t) {
                g.fillStyle = ((x + y) / t) % 2 ? (preset.color2 || preset.color1) : preset.color1;
                g.fillRect(x, y, t, t);
            }
        }
        g.fillStyle = 'rgba(0,0,0,.14)';
        var style = preset.id;
        if (style === 'wood') { for (var py = 4; py < h; py += 6) g.fillRect(0, py, w, 1); }
        else if (style === 'tile') { for (var gx = 0; gx < w; gx += t) g.fillRect(gx, 0, 1, h); for (var gy = 0; gy < h; gy += t) g.fillRect(0, gy, w, 1); }
        else if (style === 'carpet' || style === 'concrete') { for (var i = 0; i < w * h / 18; i++) g.fillRect((i * 37) % w, (i * 53) % h, 1, 1); }
        return c;
    }

    var paintPane = null;
    function mountPaintPane(panel) {
        paintPane = panel.querySelector('#office-editor-paint-pane');
        if (!paintPane || paintPane.dataset.built) return;
        paintPane.dataset.built = '1';
        var floor = el('section', 'vo-paint-section');
        floor.appendChild(el('h3', 'vo-paint-title', 'Floor'));
        floor.appendChild(el('p', 'vo-pane-intro', 'Pick a floor, then drag over the office to paint an area, or paint the whole floor.'));
        var grid = el('div', 'vo-paint-grid');
        floorPresets().forEach(function (p) { grid.appendChild(floorPresetButton(p)); });
        floor.appendChild(grid);
        var custom = el('div', 'vo-paint-custom');
        custom.innerHTML = '<label class="vo-field"><span>Tile A</span><input type="color" id="vo-floor-c1" class="vo-color-input"></label>' +
            '<label class="vo-field"><span>Tile B</span><input type="color" id="vo-floor-c2" class="vo-color-input"></label>';
        floor.appendChild(custom);
        var actions = el('div', 'vo-paint-actions');
        var areaBtn = actionButton('Paint an area', 'ed-roller', function () {
            var on = !(window._floorPaint && window._floorPaint.active && !window._floorPaint.preset.erase);
            window.setFloorPaintMode(on, currentFloorPreset());
            syncPaintButtons();
        });
        areaBtn.id = 'vo-floor-area-btn';
        var wholeBtn = actionButton('Whole floor', 'grid', function () {
            window.paintWholeFloor(currentFloorPreset());
            syncFloorInputs();
        });
        var eraseBtn = actionButton('Eraser', 'ed-eraser', function () {
            var on = !(window._floorPaint && window._floorPaint.active && window._floorPaint.preset && window._floorPaint.preset.erase);
            window.setFloorPaintMode(on, { erase: true, label: 'Eraser' });
            syncPaintButtons();
        });
        eraseBtn.id = 'vo-floor-erase-btn';
        eraseBtn.title = 'Remove painted areas (the base floor shows again)';
        actions.appendChild(areaBtn);
        actions.appendChild(wholeBtn);
        actions.appendChild(eraseBtn);
        floor.appendChild(actions);
        paintPane.appendChild(floor);

        var walls = el('section', 'vo-paint-section');
        walls.appendChild(el('h3', 'vo-paint-title', 'Walls'));
        walls.appendChild(el('p', 'vo-pane-intro', 'Pick colours, turn on the paint roller, then click any wall or the top wall.'));
        var wgrid = el('div', 'vo-paint-grid vo-paint-grid--walls');
        WALL_PRESETS.forEach(function (p) { wgrid.appendChild(wallPresetButton(p)); });
        walls.appendChild(wgrid);
        var wcustom = el('div', 'vo-paint-custom');
        wcustom.innerHTML = '<label class="vo-field"><span>Wall</span><input type="color" id="vo-wall-c1" class="vo-color-input"></label>' +
            '<label class="vo-field"><span>Trim</span><input type="color" id="vo-wall-c2" class="vo-color-input"></label>';
        walls.appendChild(wcustom);
        var wactions = el('div', 'vo-paint-actions');
        var rollBtn = actionButton('Paint walls', 'ed-roller', function () {
            window.setWallPaintMode(!(window._wallPaint && window._wallPaint.active), currentWallColors());
            syncPaintButtons();
        });
        rollBtn.id = 'vo-wall-paint-btn';
        wactions.appendChild(rollBtn);
        walls.appendChild(wactions);
        paintPane.appendChild(walls);

        ['vo-floor-c1', 'vo-floor-c2'].forEach(function (id) {
            paintPane.querySelector('#' + id).addEventListener('input', function () {
                selectedFloor = null;
                markSelected(grid, null);
                if (window._floorPaint && window._floorPaint.active && !window._floorPaint.preset.erase) window._floorPaint.preset = currentFloorPreset();
            });
        });
        ['vo-wall-c1', 'vo-wall-c2'].forEach(function (id) {
            paintPane.querySelector('#' + id).addEventListener('input', function () {
                selectedWall = null;
                markSelected(wgrid, null);
                if (window._wallPaint && window._wallPaint.active) window._wallPaint.colors = currentWallColors();
            });
        });
        selectedWall = WALL_PRESETS[0];
        syncFloorInputs();
        syncWallInputs();
        syncPaintButtons();
    }

    var selectedFloor = null, selectedWall = null;
    function markSelected(grid, btn) {
        grid.querySelectorAll('.vo-paint-swatch').forEach(function (b) {
            b.classList.toggle('is-selected', b === btn);
            b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
    }
    function floorPresetButton(p) {
        var b = el('button', 'vo-paint-swatch');
        b.type = 'button';
        b.title = p.label;
        b.setAttribute('aria-pressed', 'false');
        b.appendChild(floorSwatch(p, 48, 30));
        b.appendChild(el('span', '', p.label));
        b.addEventListener('click', function () {
            selectedFloor = p;
            markSelected(b.parentNode, b);
            paintPane.querySelector('#vo-floor-c1').value = p.color1;
            paintPane.querySelector('#vo-floor-c2').value = p.color2 || p.color1;
            // Choosing a floor starts painting areas with it right away.
            window.setFloorPaintMode(true, currentFloorPreset());
            syncPaintButtons();
        });
        return b;
    }
    function wallPresetButton(p) {
        var b = el('button', 'vo-paint-swatch vo-paint-swatch--wall');
        b.type = 'button';
        b.title = p.label;
        b.setAttribute('aria-pressed', 'false');
        var sw = el('span', 'vo-wall-chip');
        sw.style.background = 'linear-gradient(180deg, ' + p.color + ' 0 72%, ' + p.trimColor + ' 72% 84%, ' + p.trim2Color + ' 84%)';
        b.appendChild(sw);
        b.appendChild(el('span', '', p.label));
        b.addEventListener('click', function () {
            selectedWall = p;
            markSelected(b.parentNode, b);
            paintPane.querySelector('#vo-wall-c1').value = p.color;
            paintPane.querySelector('#vo-wall-c2').value = p.trimColor;
            window.setWallPaintMode(true, currentWallColors());
            syncPaintButtons();
        });
        return b;
    }
    function currentFloorPreset() {
        var c1 = paintPane.querySelector('#vo-floor-c1').value, c2 = paintPane.querySelector('#vo-floor-c2').value;
        var base = selectedFloor || { id: (window.officeConfig.floor && window.officeConfig.floor.style) || 'checker', label: 'Custom' };
        return { id: base.id, label: selectedFloor ? base.label : 'Custom', color1: c1, color2: c2 };
    }
    function currentWallColors() {
        var c1 = paintPane.querySelector('#vo-wall-c1').value, c2 = paintPane.querySelector('#vo-wall-c2').value;
        return { color: c1, trimColor: c2, trim2Color: selectedWall && selectedWall.color === c1 ? selectedWall.trim2Color : c2 };
    }
    function syncFloorInputs() {
        if (!paintPane) return;
        var f = (window.officeConfig && window.officeConfig.floor) || {};
        paintPane.querySelector('#vo-floor-c1').value = /^#[0-9a-f]{6}$/i.test(f.color1 || '') ? f.color1 : '#c8c3b8';
        paintPane.querySelector('#vo-floor-c2').value = /^#[0-9a-f]{6}$/i.test(f.color2 || '') ? f.color2 : '#bdb7ab';
    }
    function syncWallInputs() {
        if (!paintPane) return;
        var p = selectedWall || WALL_PRESETS[0];
        paintPane.querySelector('#vo-wall-c1').value = p.color;
        paintPane.querySelector('#vo-wall-c2').value = p.trimColor;
    }
    function syncPaintButtons() {
        if (!paintPane) return;
        var fp = window._floorPaint || {}, wp = window._wallPaint || {};
        var area = paintPane.querySelector('#vo-floor-area-btn'), erase = paintPane.querySelector('#vo-floor-erase-btn'), roll = paintPane.querySelector('#vo-wall-paint-btn');
        var areaOn = !!(fp.active && !(fp.preset && fp.preset.erase)), eraseOn = !!(fp.active && fp.preset && fp.preset.erase);
        [[area, areaOn], [erase, eraseOn], [roll, !!wp.active]].forEach(function (pair) {
            if (!pair[0]) return;
            pair[0].classList.toggle('is-active', pair[1]);
            pair[0].setAttribute('aria-pressed', pair[1] ? 'true' : 'false');
        });
    }

    // ------------------------------------------------------------------
    // View insets (contract C1): the free part of the screen for the office.
    // ------------------------------------------------------------------
    var lastInsets = '', deferInsets = false, insetsRaf = 0;
    function updateInsetsSoon() {
        if (insetsRaf) return;
        // after the caller's own class changes (ui-modern's toggle wrapper) but in the same task: the
        // style pass runs once, in the click, not again on top of the first edit frame
        insetsRaf = 1;
        var run = function () { insetsRaf = 0; updateInsets(); };
        if (typeof window.queueMicrotask === 'function') window.queueMicrotask(run); else Promise.resolve().then(run);
    }
    function updateInsets() {
        if (deferInsets) { updateInsetsSoon(); return; }
        var api = window.VOOffice && window.VOOffice.setViewInsets;
        if (typeof api !== 'function') return;
        var insets = { left: 0, right: 0, top: 0, bottom: 0 };
        var cv = document.getElementById('officeCanvas');
        if (editing() && cv) {
            // Insets are canvas CSS px: measured from the canvas box, not the window.
            var cr = cv.getBoundingClientRect();
            var panel = document.getElementById('furniture-catalog');
            var tb = document.querySelector('.ui-edit-toolbar');
            var tbr = tb && getComputedStyle(tb).display !== 'none' ? tb.getBoundingClientRect() : null;
            if (tbr && !tbr.height) tbr = null;
            if (isPhone()) {
                var coverTop = tbr ? tbr.top : cr.bottom;
                // v0.13 mobileui: the sheet stays open while placing or painting (the office is in view
                // above it); only a full-height sheet folds into the peek bar then.
                var folded = document.body.classList.contains('vo-editor-peek') && document.body.classList.contains('vo-edsheet-full');
                if (folded && bar && !bar.hidden) coverTop = Math.min(coverTop, bar.getBoundingClientRect().top);
                else if (panel && panel.classList.contains('visible')) coverTop = Math.min(coverTop, panel.getBoundingClientRect().top);
                insets.bottom = Math.max(0, Math.round(cr.bottom - coverTop));
            } else {
                if (panel && panel.classList.contains('visible')) insets.left = Math.max(0, Math.round(panel.getBoundingClientRect().right - cr.left));
                if (tbr) insets.bottom = Math.max(0, Math.round(cr.bottom - tbr.top + 8));
            }
            // R-07: the top edge's handle and its +/- reach ~12 px above the office; the editing pill
            // (on phones it sits in the top bar instead) keeps its own band.
            insets.top = 14;
            var pill = document.getElementById('vo-office-save-status');
            var pr = pill && !pill.hidden ? pill.getBoundingClientRect() : null;
            if (pr && pr.height && pr.bottom > cr.top && pr.top < cr.top + 80) insets.top = Math.round(pr.bottom - cr.top + 14);
            // R-06: the map control column (bottom right, with the chat window buttons on it or
            // beside it) beside the free area.
            var mc = document.querySelector('.vo-mapctl');
            var mr = mc && getComputedStyle(mc).display !== 'none' ? mc.getBoundingClientRect() : null;
            if (mr && mr.width && mr.left < cr.right && mr.top < cr.bottom - insets.bottom && mr.bottom > cr.top + insets.top) {
                var rail = document.querySelector('#chat-window-rail:not(.is-strip):not([hidden])');
                var rr = rail ? rail.getBoundingClientRect() : null;
                var colLeft = rr && rr.width && rr.left < mr.left ? rr.left : mr.left;
                insets.right = Math.max(0, Math.round(cr.right - colLeft + 8));
            }
        }
        var key = JSON.stringify(insets);
        if (key === lastInsets) return;
        lastInsets = key;
        try { api(insets); } catch (e) {}
    }
    VOEditor.updateInsets = updateInsets;
    window.addEventListener('resize', function () { if (editing() || lastInsets) setTimeout(updateInsets, 60); });

    // ------------------------------------------------------------------
    // Drag an item from the catalog onto the floor (mouse): the ghost follows
    // the pointer over the office and the drop places it (same rule as a click).
    // A plain click on the card still just picks the item.
    // ------------------------------------------------------------------
    var catDrag = null;
    function wireCatalogDrag(panel) {
        if (panel.dataset.voDrag) return;
        panel.dataset.voDrag = '1';
        panel.addEventListener('pointerdown', function (e) {
            if (e.pointerType !== 'mouse' || e.button !== 0) return;
            var card = e.target.closest('.catalog-item, .catalog-quick-item');
            if (!card || e.target.closest('.catalog-fav') || !card.dataset.type) return;
            catDrag = { type: card.dataset.type, x: e.clientX, y: e.clientY, active: false };
        });
        panel.addEventListener('dragstart', function (e) { if (e.target.closest('.catalog-item, .catalog-quick-item')) e.preventDefault(); });
        window.addEventListener('pointermove', function (e) {
            if (!catDrag || catDrag.active) return;
            if (Math.abs(e.clientX - catDrag.x) + Math.abs(e.clientY - catDrag.y) > 8) {
                catDrag.active = true;
                window._selectCatalogItem(catDrag.type);
                document.body.classList.add('vo-editor-dragging-item');
            }
        });
        window.addEventListener('pointerup', function (e) {
            var d = catDrag;
            catDrag = null;
            document.body.classList.remove('vo-editor-dragging-item');
            if (!d || !d.active || !editing()) return;
            if (document.elementFromPoint(e.clientX, e.clientY) !== document.getElementById('officeCanvas')) return; // dropped elsewhere: keep placing
            var w = window.screenToWorld(e.clientX, e.clientY);
            window.handleEditClick(w.x, w.y, e.clientX, e.clientY, e);
        });
    }

    // ------------------------------------------------------------------
    // Compact layout (phones, tablets): the catalog is a bottom sheet with the dashboard sheet's
    // handle (v0.13 mobileui). Drag the handle (or the catalog header) to resize it; it snaps to
    // peek / half / full like the dashboard, a tap or the arrow keys on the handle step it, and the
    // size is remembered. The office stays framed in the canvas above it (view insets, below).
    // ------------------------------------------------------------------
    var EDSHEET_KEY = 'vo-edit-sheet', EDSHEET_ORDER = ['peek', 'half', 'full'], edSheet = '';
    function readEdSheet() {
        try { var v = localStorage.getItem(EDSHEET_KEY); return EDSHEET_ORDER.indexOf(v) >= 0 ? v : 'half'; } catch (e) { return 'half'; }
    }
    function setEdSheet(state, save) {
        if (save) { try { localStorage.setItem(EDSHEET_KEY, state); } catch (e) {} }
        if (state === edSheet) return;
        edSheet = state;
        EDSHEET_ORDER.forEach(function (s) { document.body.classList.toggle('vo-edsheet-' + s, s === state); });
        var grab = document.querySelector('[data-vo-edsheet-grab]');
        if (grab) {
            grab.setAttribute('aria-expanded', state === 'peek' ? 'false' : 'true');
            grab.setAttribute('aria-label', state === 'full' ? 'Shrink the catalog' : 'Expand the catalog');
        }
    }
    function edSheetPeek() { return parseFloat(getComputedStyle(document.body).getPropertyValue('--vo-edsheet-peek')) || 64; }
    function edSheetFull() {
        var tb = document.querySelector('.ui-edit-toolbar'), top = document.querySelector('.vo-topbar');
        var bottom = tb && tb.offsetHeight ? tb.getBoundingClientRect().top : window.innerHeight;
        return bottom - (top && top.offsetHeight ? top.getBoundingClientRect().bottom : 0);
    }
    function mountEditSheet(panel) {
        if (panel.querySelector('[data-vo-edsheet-grab]')) return;
        var grab = document.createElement('button');
        grab.type = 'button';
        grab.className = 'vo-sheet-grab vo-edsheet-grab';
        grab.setAttribute('data-vo-edsheet-grab', '');
        grab.innerHTML = '<span aria-hidden="true"></span>';
        panel.insertBefore(grab, panel.firstChild);
        setEdSheet(readEdSheet(), false);
        grab.addEventListener('click', function () {
            if (grab.dataset.dragged === '1') { grab.dataset.dragged = ''; return; }
            setEdSheet(edSheet === 'peek' ? 'half' : edSheet === 'half' ? 'full' : 'peek', true);
        });
        if (!window.VOSheets) return;
        window.VOSheets.attachDrag({
            sheet: panel,
            handles: [grab, panel.querySelector('.catalog-header')],
            skip: function (event) { return !editing() || !!event.target.closest('button:not([data-vo-edsheet-grab]), a, input, select'); },
            min: edSheetPeek,
            max: edSheetFull,
            // the drag sets the panel's own height (no page-wide restyle per move)
            setHeight: function (h) { panel.style.height = h === null ? '' : h + 'px'; },
            end: function (h) {
                var snaps = { peek: edSheetPeek(), half: Math.min(window.innerHeight * 0.52, 480), full: edSheetFull() }, best = 'half';
                Object.keys(snaps).forEach(function (k) { if (Math.abs(snaps[k] - h) < Math.abs(snaps[best] - h)) best = k; });
                setEdSheet(best, true);
            },
            step: function (dir) { setEdSheet(EDSHEET_ORDER[Math.max(0, Math.min(2, EDSHEET_ORDER.indexOf(edSheet) + dir))], true); }
        });
    }

    // ------------------------------------------------------------------
    // Panel mount (called by game.js after it built the catalog panel)
    // ------------------------------------------------------------------
    VOEditor.mountPanel = function (panel) {
        if (!panel) return;
        mountPaintPane(panel);
        mountEditBar();
        fillThumbnails(panel);
        wireCatalogDrag(panel);
        mountEditSheet(panel);
        ensureBar();
        if (window.ResizeObserver && !panel.dataset.voInsetWatch) {
            panel.dataset.voInsetWatch = '1';
            // A sheet that is being dragged or settles into a snap resizes every frame: the camera
            // refits once it stops (one trailing measure), not on every frame of the move.
            var roTimer = 0;
            new ResizeObserver(function () {
                if (!isPhone()) { updateInsets(); return; }
                clearTimeout(roTimer);
                roTimer = setTimeout(function () { if (!panel.classList.contains('is-dragging')) updateInsets(); }, 90);
            }).observe(panel);
        }
    };

    // v0.13 mobileui: on phones and tablets the editor frames the whole office in the canvas above the
    // sheet (the agent close-up of the phone's default view is for watching, not for placing), and the
    // insets keep it framed as the sheet is resized. Leaving the editor gives the default view back
    // unless the camera was moved meanwhile.
    var fittedForEdit = '';
    function frameOfficeForEdit(on) {
        var office = window.VOOffice;
        if (!office || typeof office.getCamera !== 'function' || typeof office.fitView !== 'function') return;
        var mode = (office.getCamera() || {}).mode;
        if (on && isPhone() && mode !== 'fit') { fittedForEdit = mode || 'auto'; office.fitView(); }
        else if (!on && fittedForEdit) {
            var was = fittedForEdit;
            fittedForEdit = '';
            if (mode === 'fit' && was === 'auto' && typeof office.resetView === 'function') office.resetView();
        }
    }

    // Entering / leaving edit mode: insets, bar, tips.
    VOEditor.onEditMode = function (on) {
        frameOfficeForEdit(on);
        if (on) {
            mountEditBar();
            syncEditBar();
            syncFloorInputs();
            if (typeof window._renderEditorTips === 'function') window._renderEditorTips();
        } else {
            if (card) card.hidden = true;
            document.body.classList.remove('vo-editor-peek');
        }
        barKey = '?';
        // Measured once the toggle has returned, not inside it: a read here forces a style and
        // layout pass of the new panel that the page's own class changes (after this returns) undo,
        // so the first edit frame redid it: a long task on a phone (v0.13 editorperf).
        deferInsets = true;
        try { renderBar(); } finally { deferInsets = false; }
        updateInsetsSoon();
        // The panel slides in: measure once it has settled.
        setTimeout(updateInsets, 260);
    };
})();
